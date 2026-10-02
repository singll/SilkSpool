#!/usr/bin/env python3
"""Read-only WP03 cost evidence audit. Never imports costs or releases reservations."""
import argparse
import collections
import hashlib
import json
import os
from pathlib import Path
import shlex
import sqlite3
import subprocess
import sys
import time

MAX_BYTES = 128 * 1024 * 1024
MAX_INTEGER = 2**53 - 1
TOKEN_FIELDS = ("inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens")
NORMAL_FINISH = {"stop", "tool-calls", "max-tokens"}


def digest(value):
    return hashlib.sha256(value).hexdigest()


def integer(value):
    return type(value) is int and 0 <= value <= MAX_INTEGER


def tokens(usage):
    if not isinstance(usage, dict) or any(not integer(usage.get(k)) for k in TOKEN_FIELDS[:2]):
        return None
    values = [usage.get(k, 0) for k in TOKEN_FIELDS]
    if any(not integer(v) for v in values) or sum(values) > MAX_INTEGER:
        return None
    return sum(values)


def stable_read(filename):
    def signature(st):
        return st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns, st.st_ctime_ns
    with filename.open("rb") as source:
        before = signature(os.fstat(source.fileno()))
        content = source.read(MAX_BYTES + 1)
        after = signature(os.fstat(source.fileno()))
    if before != after or after != signature(filename.stat()):
        raise ValueError("source_changed")
    if len(content) > MAX_BYTES:
        raise ValueError("source_too_large")
    return content


def read_session(filename):
    content = stable_read(filename)
    if filename.suffix == ".zstd":
        # Read the captured bytes, not a second, potentially changed source file.
        import tempfile
        with tempfile.TemporaryFile() as captured:
            captured.write(content)
            captured.seek(0)
            with subprocess.Popen(["zstd", "-dc"], stdin=captured, stdout=subprocess.PIPE,
                                  stderr=subprocess.DEVNULL) as child:
                decoded = child.stdout.read(MAX_BYTES + 1)
                if len(decoded) > MAX_BYTES:
                    child.kill()
                    raise ValueError("session_too_large")
                if child.wait() != 0:
                    raise ValueError("session_decode_failed")
    else:
        decoded = content
    if not decoded.endswith(b"\n"):
        raise ValueError("session_incomplete")
    return decoded, digest(content)


def session_evidence(content, session_id, started_at, finished_at, cwd=None):
    """V4 events contain assistant usage and retries; titles lack final billing."""
    rows = [json.loads(line) for line in content.splitlines() if line.strip()]
    if not rows or not isinstance(rows[0], dict):
        raise ValueError("session_header_missing")
    header = rows[0]
    if header.get("type") != "session" or header.get("version") != 4 or header.get("id") != session_id:
        raise ValueError("session_header_mismatch")
    if not integer(started_at) or not integer(finished_at) or finished_at < started_at:
        raise ValueError("run_window_missing")
    if not integer(header.get("createdAt")) or not started_at <= header["createdAt"] <= finished_at:
        raise ValueError("session_outside_run")
    if cwd and header.get("cwd") != cwd:
        raise ValueError("session_cwd_mismatch")
    seen, calls, reasons = {}, [], collections.Counter()
    duplicate_events = 0
    previous_seq = -1
    for row in rows[1:]:
        if not isinstance(row, dict) or not integer(row.get("seq")):
            raise ValueError("event_sequence_invalid")
        seq = row["seq"]
        fingerprint = digest(json.dumps(row, sort_keys=True, separators=(",", ":")).encode())
        if seq in seen:
            if seen[seq] != fingerprint:
                raise ValueError("event_sequence_conflict")
            duplicate_events += 1
            continue
        if seq <= previous_seq:
            raise ValueError("event_sequence_unordered")
        previous_seq = seq
        seen[seq] = fingerprint
        kind = row.get("type")
        if kind not in {"assistant/message", "assistant/attempt", "session/title-llm-request"}:
            continue
        if not integer(row.get("time")) or not started_at <= row["time"] <= finished_at:
            raise ValueError("request_outside_run")
        if kind == "session/title-llm-request":
            reasons["title_without_final_usage"] += 1
            continue
        data = row.get("data")
        if not isinstance(data, dict) or not isinstance(data.get("stream", []), list):
            raise ValueError("request_shape_invalid")
        chunks = [part["chunk"] for part in data.get("stream", [])
                  if isinstance(part, dict) and isinstance(part.get("chunk"), dict)]
        finishes = [c.get("reason", {}).get("kind") for c in chunks
                    if c.get("type") == "finish" and isinstance(c.get("reason"), dict)]
        usages = [c.get("usage") for c in chunks if c.get("type") == "usage"]
        usage = data.get("usage", usages[-1] if usages else None)
        amount = tokens(usage)
        # A projected message and its stream usage describe one request.
        if usages and data.get("usage") is not None and tokens(usages[-1]) != amount:
            reasons["usage_projection_conflict"] += 1
            amount = None
        normal = len(finishes) == 1 and finishes[0] in NORMAL_FINISH
        if not normal:
            reasons["failed_or_incomplete_request"] += 1
        if amount is None:
            reasons["invalid_or_missing_usage"] += 1
        calls.append({"seq": seq, "time": row["time"], "tokens": amount,
                      "normal_finish": normal, "event_sha256": fingerprint})
    known = sum(c["tokens"] for c in calls if c["tokens"] is not None)
    if known > MAX_INTEGER:
        raise ValueError("session_tokens_overflow")
    return {"recorded_tokens_lower_bound": known,
            "normal_tokens_lower_bound": sum(c["tokens"] for c in calls
                                           if c["tokens"] is not None and c["normal_finish"]),
            "requests": len(calls), "duplicate_events": duplicate_events,
            "unresolved": dict(reasons), "requests_with_usage": sum(c["tokens"] is not None for c in calls),
            "request_evidence": calls, "final_cost_proven": False}


def bill_evidence(filename, now):
    content = stable_read(filename)
    sessions, seen = {}, set()
    invalid, duplicates, conflicts = collections.Counter(), 0, 0
    for line in content.splitlines(keepends=True):
        if not line.endswith(b"\n"):
            invalid["incomplete_line"] += 1
            continue
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except (ValueError, UnicodeError):
            invalid["invalid_json"] += 1
            continue
        amount = tokens(row) if isinstance(row, dict) else None
        if amount is None:
            invalid["invalid_usage"] += 1
            continue
        if not isinstance(row.get("sessionId"), str) or not row["sessionId"]:
            invalid["missing_session_id"] += 1
            continue
        if line in seen:
            duplicates += 1
            continue
        seen.add(line)
        sid = row["sessionId"]
        identity = ([sid, row["time"], row.get("seq"), row.get("provider", ""),
                     row.get("model", ""), row.get("purpose", "agent")]
                    if integer(row.get("time")) else line.decode().rstrip("\n"))
        key = digest(json.dumps(identity, ensure_ascii=False, separators=(",", ":")).encode())
        receipts = sessions.setdefault(sid, {})
        if key in receipts and receipts[key] != amount:
            conflicts += 1
        receipts[key] = max(amount, receipts.get(key, 0))
        if not integer(row.get("time")) or row["time"] > now:
            invalid["invalid_time"] += 1
    return sessions, {"sha256": digest(content), "bytes": len(content),
                      "invalid_records": sum(invalid.values()), "invalid_reasons": dict(invalid),
                      "exact_duplicates": duplicates,
                      "receipt_value_conflicts": conflicts}


def rollup_evidence(filename):
    content = stable_read(filename)
    row = json.loads(content)
    fields = ("calls", "uncachedInputTokens", "cacheReadTokens", "cacheWriteTokens", "outputTokens", "fileSkip")
    if not isinstance(row, dict) or any(not integer(row.get(k)) for k in fields):
        raise ValueError("rollup_shape_invalid")
    return {"sha256": digest(content), **{k: row[k] for k in fields},
            "has_session_attribution": False,
            "meaning": "Aggregate of evicted records; cannot allocate to a task/run or prove final cost."}


def audit(database, bill_file, sessions_root, rollup_file=None):
    now = int(time.time() * 1000)
    # One consistent database image; all joins and aggregates read the image.
    image = sqlite3.connect(":memory:")
    image.row_factory = sqlite3.Row
    source = sqlite3.connect(database.resolve().as_uri() + "?mode=ro", uri=True)
    try:
        source.backup(image)
    finally:
        source.close()
    def rows(sql):
        return [dict(row) for row in image.execute(sql)]
    try:
        watch = rows("SELECT * FROM task_cost_watch ORDER BY id")
        runs = rows("SELECT task_id,run_id,session_id,started_at,finished_at,spent_tokens FROM task_runs")
        costs = rows("SELECT task_id,run_id,session_id,spent_tokens FROM task_run_costs")
        items = rows("SELECT task_id,run_id,SUM(tokens) tokens,COUNT(*) n FROM task_bill_items GROUP BY task_id,run_id")
        workers = rows("SELECT run_id,task_id,worker_session_id,cwd FROM workers")
        campaigns = rows("SELECT id,status,budget_tokens,spent_tokens FROM campaigns ORDER BY id")
        tasks = rows("SELECT id,campaign_id FROM tasks")
        reservations = rows("SELECT state,COUNT(*) n,SUM(tokens) tokens FROM task_budget_reservations GROUP BY state")
    finally:
        image.close()
    key = lambda r: (r["task_id"], r["run_id"])
    run_index, owners = collections.defaultdict(list), collections.defaultdict(set)
    for row in runs:
        run_index[key(row)].append(row)
    for row in runs + watch + costs:
        if row.get("session_id"):
            owners[row["session_id"]].add(key(row))
    worker_index = {r["run_id"]: r for r in workers}
    for row in workers:
        if row["worker_session_id"] and row["task_id"] is not None:
            owners[row["worker_session_id"]].add(key(row))
    cost_index = {key(r): r["spent_tokens"] for r in costs}
    item_index = {key(r): r for r in items}
    task_campaign = {r["id"]: r["campaign_id"] for r in tasks}
    bill_sessions, bill_report = bill_evidence(bill_file, now)
    rollup_report = rollup_evidence(rollup_file) if rollup_file else None
    files = collections.defaultdict(list)
    # Only current V4 files; never add V3 or legacy mirrors to the same session.
    for filename in sessions_root.rglob("session.v4.jsonl.zstd"):
        files[filename.parent.name].append(filename)
    results = []
    for row in watch:
        pair, sid = key(row), row["session_id"]
        receipts = bill_sessions.get(sid)
        raw = sum(receipts.values()) if receipts is not None else None
        recorded, detail = cost_index.get(pair), item_index.get(pair)
        result = {**row, "campaign_id": task_campaign.get(row["task_id"]),
                  "raw_bill_tokens": raw, "ledger_tokens": recorded,
                  "bill_item_tokens": detail["tokens"] if detail else None,
                  "bill_item_count": detail["n"] if detail else 0}
        result["bill_status"] = ("missing" if raw is None else "not_settled" if recorded is None
                                 else "matched" if raw == recorded else "retained_above_current"
                                 if raw < recorded else "raw_above_ledger")
        if owners[sid] != {pair}:
            result["session_status"] = "ambiguous_run_ownership"
        elif len(run_index[pair]) != 1:
            result["session_status"] = "run_missing_or_duplicated"
        elif len(files[sid]) != 1:
            result["session_status"] = "session_missing_or_duplicated"
        else:
            run = run_index[pair][0]
            worker = worker_index.get(row["run_id"])
            try:
                if run["session_id"] != sid or worker and (
                        worker["task_id"] is not None and worker["task_id"] != row["task_id"]
                        or worker["worker_session_id"] and worker["worker_session_id"] != sid):
                    raise ValueError("run_session_mismatch")
                content, sha = read_session(files[sid][0])
                result["session"] = session_evidence(content, sid, run["started_at"], run["finished_at"],
                                                     worker["cwd"] if worker else None)
                result["session_sha256"] = sha
                result["session_status"] = "attributable_lower_bound"
            except (ValueError, OSError, TypeError) as exc:
                # Never serialize parse errors or source contents into the report.
                safe = str(exc) if type(exc) is ValueError and str(exc).replace("_", "").isalpha() else "session_unreadable"
                result["session_status"] = safe
        results.append(result)
    missing = [r for r in results if r["bill_status"] == "missing"]
    attributable = [r for r in missing if r["session_status"] == "attributable_lower_bound"]
    campaign_bounds = collections.Counter()
    missing_unresolved = collections.Counter()
    for row in attributable:
        campaign_bounds[str(row["campaign_id"]) if row["campaign_id"] is not None else "no_campaign"] += row["session"]["recorded_tokens_lower_bound"]
        missing_unresolved.update(row["session"]["unresolved"])
    snapshot = {"watch": watch, "runs": runs, "costs": costs, "items": items,
                "workers": workers, "tasks": tasks, "campaigns": campaigns, "reservations": reservations}
    return {"schema_version": 1, "sampled_at": now, "read_only": True,
            "database_projection_sha256": digest(json.dumps(snapshot, sort_keys=True).encode()),
            "scope": "persistent_cost_watch", "final_cost_proven": False,
            "bill_source": bill_report, "rollup_source": rollup_report,
            "campaigns": campaigns, "reservations": reservations,
            "summary": {"watch": len(results),
                        "bill_status": dict(collections.Counter(r["bill_status"] for r in results)),
                        "session_status": dict(collections.Counter(r["session_status"] for r in results)),
                        "missing_bill_attributable_sessions": len(attributable),
                        "missing_bill_recorded_tokens_lower_bound": sum(campaign_bounds.values()),
                        "missing_bill_lower_bound_by_campaign": dict(campaign_bounds),
                        "missing_bill_unresolved_requests": dict(missing_unresolved),
                        "all_task_runs": len(runs),
                        "task_runs_without_session": sum(not r["session_id"] for r in runs),
                        "task_runs_without_cost": sum(r["spent_tokens"] is None for r in runs)},
            "limitations": ["Session usage is a lower bound, not a supplier settlement receipt.",
                            "Lower bounds overlap existing costs and must not be added to the ledger.",
                            "Missing title usage, retries and unrecorded calls may add cost.",
                            "Runs outside cost_watch are counted but not reconstructed.",
                            "Raw bill comparison includes on-disk records, including any rollup fileSkip prefix.",
                            "Evicted rollup totals are not added to session evidence or task costs.",
                            "Database, bills and sessions are separate read-only sampling points."],
            "rows": results}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", type=Path, required=True)
    parser.add_argument("--bills", type=Path, required=True)
    parser.add_argument("--sessions", type=Path, required=True)
    parser.add_argument("--rollup", type=Path)
    parser.add_argument("--host", help="Run this read-only script in memory through PATH spool; uploads no file.")
    args = parser.parse_args()
    if args.host:
        remote = ["sudo", "python3", "-c", Path(__file__).read_text(),
                  "--database", str(args.database), "--bills", str(args.bills),
                  "--sessions", str(args.sessions)]
        if args.rollup:
            remote.extend(["--rollup", str(args.rollup)])
        return subprocess.run(["spool", "exec", args.host, shlex.join(remote)]).returncode
    try:
        report = audit(args.database, args.bills, args.sessions, args.rollup)
    except (OSError, ValueError, sqlite3.Error):
        print(json.dumps({"ok": False, "error": "audit_source_unavailable_or_invalid"}))
        return 1
    json.dump(report, sys.stdout, ensure_ascii=False, indent=2)
    print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
