#!/usr/bin/env python3
"""Read-only audit of worker request journals, budget reports and run ledgers.

This tool reports adapter usage and missing evidence. It never proves supplier
settlement, imports costs, releases reservations or executes captured requests.
"""
import argparse
import collections
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import sqlite3
import stat
import subprocess
import sys
import uuid

MAX_BYTES = 16 * 1024 * 1024
MAX_INTEGER = 2**53 - 1
NORMAL_FINISH = {"stop", "tool-calls", "max-tokens"}
TOKEN_FIELDS = ("inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens")
LABEL = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9_.:/@+-]{0,255}")


def integer(value):
    return type(value) is int and 0 <= value <= MAX_INTEGER


def usage(value):
    if not isinstance(value, dict) or not all(k in value for k in TOKEN_FIELDS[:2]):
        return None
    counts = {k: value.get(k, 0) for k in TOKEN_FIELDS}
    if not all(integer(v) for v in counts.values()) or sum(counts.values()) > MAX_INTEGER:
        return None
    return counts


def digest(content):
    return hashlib.sha256(content).hexdigest()


def stable_read(filename):
    def signature(s):
        return s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns
    fd = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as source:
        before = os.fstat(source.fileno())
        if not stat.S_ISREG(before.st_mode):
            raise ValueError("source_not_regular")
        if before.st_mode & 0o077:
            raise ValueError("source_permissions")
        content = source.read(MAX_BYTES + 1)
        after = os.fstat(source.fileno())
    if signature(before) != signature(after) or signature(after) != signature(filename.lstat()):
        raise ValueError("source_changed")
    if len(content) > MAX_BYTES:
        raise ValueError("source_too_large")
    return content


def check(condition, reason):
    if not condition:
        raise ValueError(reason)


def journal_report(content, session, budget, worker):
    """Validate one launch, preserving interrupted prefixes as incomplete evidence."""
    run_id = worker["run_id"]
    check(isinstance(session, dict) and isinstance(budget, dict), "control_report_invalid")
    check(re.fullmatch(r"w[a-z0-9]+", run_id or ""), "run_id_invalid")
    check(re.fullmatch(r"[a-f0-9]{48}", session.get("nonce", "")), "launch_nonce_invalid")
    check(session.get("run_id") == budget.get("run_id") == run_id
          and session["nonce"] == budget.get("nonce"), "launch_binding_mismatch")
    check(integer(worker.get("pid")) and worker["pid"] > 0
          and session.get("pid") == worker["pid"], "worker_pid_mismatch")
    check(session.get("cwd") == worker.get("cwd")
          and session.get("session_id") == worker.get("worker_session_id")
          and re.fullmatch(r"session-[a-z0-9-]+", session.get("session_id", "")),
          "worker_session_mismatch")
    start, end = worker.get("started_at"), worker.get("finished_at")
    check(integer(start) and integer(end) and start <= end, "worker_window_missing")
    check(integer(session.get("created_at")) and start <= session["created_at"] <= end,
          "session_outside_worker")
    check(all(integer(budget.get(k)) for k in ["charged", "reserved", "requests", "denied", "unknown", "limit"])
          and budget["limit"] > 0, "budget_counters_invalid")
    launch_hash = digest(session["nonce"].encode())
    lines = content.splitlines(keepends=True)
    truncated = bool(lines and not lines[-1].endswith(b"\n"))
    if truncated:
        lines.pop()
    requests = {}
    last_time = start
    for sequence, line in enumerate(lines, 1):
        try:
            row = json.loads(line)
        except (ValueError, UnicodeError):
            raise ValueError("journal_json_invalid") from None
        check(isinstance(row, dict) and type(row.get("schema_version")) is int
              and row["schema_version"] == 1, "journal_schema_invalid")
        check(type(row.get("event_sequence")) is int
              and row["event_sequence"] == sequence, "journal_sequence_invalid")
        check(row.get("run_id") == run_id and row.get("pid") == worker["pid"]
              and row.get("launch_sha256") == launch_hash, "journal_launch_mismatch")
        check(row.get("session_id") == session["session_id"], "journal_session_mismatch")
        check(integer(row.get("recorded_at")) and last_time <= row["recorded_at"] <= end,
              "journal_time_invalid")
        last_time = row["recorded_at"]
        check(row.get("final_cost_proven") is False, "unsupported_settlement_claim")
        request_id = row.get("request_id")
        try:
            check(str(uuid.UUID(request_id)) == request_id, "request_id_invalid")
        except (ValueError, TypeError, AttributeError):
            raise ValueError("request_id_invalid") from None
        check(integer(row.get("request_sequence")) and row["request_sequence"] > 0,
              "request_sequence_invalid")
        for k in ["provider", "model"]:
            check(row.get(k) is None or isinstance(row[k], str) and LABEL.fullmatch(row[k]),
                  "request_route_invalid")
        identity = tuple(row.get(k) for k in ["request_sequence", "provider", "model"])
        kind = row.get("event")
        if request_id not in requests:
            check(kind in {"admitted", "denied"}, "request_admission_missing")
            check(row["request_sequence"] == len(requests) + 1, "request_sequence_invalid")
            check(integer(row.get("reserved_tokens")), "request_reservation_invalid")
            if kind == "admitted":
                check(integer(row.get("estimated_input_tokens"))
                      and integer(row.get("max_output_tokens")) and row["max_output_tokens"] > 0
                      and row["reserved_tokens"] == row["estimated_input_tokens"] + row["max_output_tokens"],
                      "request_estimate_invalid")
            requests[request_id] = {"identity": identity, "admission": row,
                                    "usages": [], "finishes": [], "terminal": None}
            continue
        request = requests[request_id]
        check(request["identity"] == identity, "request_identity_changed")
        check(request["admission"]["event"] == "admitted" and request["terminal"] is None,
              "event_after_request_closed")
        if kind == "usage":
            request["usages"].append(usage(row.get("usage")))
        elif kind == "finish":
            response_id = row.get("provider_response_id")
            check(response_id is None or isinstance(response_id, str) and LABEL.fullmatch(response_id),
                  "provider_response_id_invalid")
            check((response_id is None and row.get("response_id_source") is None)
                  or (response_id is not None and row.get("response_id_source") == "pi-ai-replay-v2"),
                  "provider_response_source_invalid")
            request["finishes"].append(row)
        elif kind == "terminal":
            check(type(row.get("completed")) is bool and type(row.get("failed")) is bool,
                  "terminal_flags_invalid")
            check(row.get("termination") in {"stream_exhausted", "adapter_error", "stream_threw", "consumer_cancelled"},
                  "terminal_reason_invalid")
            check(type(row.get("finish_count")) is int
                  and row["finish_count"] == len(request["finishes"]), "terminal_finish_count_mismatch")
            latest_finish = request["finishes"][-1] if request["finishes"] else {}
            check(row.get("provider_response_id") == latest_finish.get("provider_response_id")
                  and row.get("finish_kind") == latest_finish.get("finish_kind"),
                  "terminal_finish_mismatch")
            latest_usage = request["usages"][-1] if request["usages"] else None
            check(usage(row.get("usage")) == latest_usage, "terminal_usage_mismatch")
            check(row.get("usage_state") == ("reported" if latest_usage is not None else "unknown"),
                  "terminal_usage_state_mismatch")
            request["terminal"] = row
        else:
            raise ValueError("request_event_invalid")

    summaries, response_ids = [], collections.Counter()
    charged = reserved = unknown = admitted = denied = observed_tokens = 0
    for request_id, request in requests.items():
        admission, terminal = request["admission"], request["terminal"]
        if admission["event"] == "denied":
            denied += 1
            summaries.append({"request_id": request_id, "state": "not_sent_by_budget_hook"})
            continue
        admitted += 1
        counts = request["usages"][-1] if request["usages"] else None
        amount = sum(counts.values()) if counts is not None else 0
        observed_tokens += amount
        if terminal and counts is not None:
            charged += amount
        # Preserve the runtime's accounting separately from stricter evidence
        # completeness; a usage event followed by EOF alone is not a normal finish.
        runtime_settled = bool(terminal and counts is not None and terminal["completed"] and not terminal["failed"])
        if not runtime_settled:
            reserved += admission["reserved_tokens"]
            unknown += bool(terminal)
        reasons = []
        if not terminal:
            reasons.append("terminal_missing")
        elif terminal["termination"] != "stream_exhausted" or not terminal["completed"] or terminal["failed"]:
            reasons.append("failed_or_interrupted_request")
        if len(request["finishes"]) != 1 or request["finishes"][0].get("finish_kind") not in NORMAL_FINISH:
            reasons.append("normal_finish_missing_or_multiple")
        if counts is None:
            reasons.append("usage_missing_or_invalid")
        response_id = terminal.get("provider_response_id") if terminal else None
        if not response_id:
            reasons.append("provider_response_id_missing")
        response_hash = digest(response_id.encode()) if response_id else None
        if response_id:
            # Providers can allocate IDs in distinct namespaces.
            response_ids[(admission["provider"], admission["model"], response_hash)] += 1
        summaries.append({
            "request_id": request_id, "provider": admission["provider"], "model": admission["model"],
            "state": "adapter_incomplete" if reasons else "adapter_complete",
            "runtime_budget_settled": runtime_settled, "observed_tokens_lower_bound": amount,
            "provider_response_id_sha256": response_hash, "evidence_gaps": reasons,
            "final_cost_proven": False, "unknown_release_allowed": False,
        })
    duplicate_ids = sum(count > 1 for count in response_ids.values())
    gaps = []
    if truncated:
        gaps.append("journal_trailing_partial_event")
    if not requests:
        gaps.append("journal_no_requests")
    if duplicate_ids:
        gaps.append("provider_response_id_reused")
    expected = {"charged": charged, "reserved": reserved, "unknown": unknown, "requests": admitted, "denied": denied}
    mismatches = [key for key, value in expected.items() if budget[key] != value]
    if mismatches:
        gaps.append("budget_projection_mismatch")
    if any(r["state"] == "adapter_incomplete" for r in summaries):
        gaps.append("request_evidence_incomplete")
    return {
        "journal_sha256": digest(content), "events": len(lines), "admitted": admitted, "denied": denied,
        "observed_tokens_lower_bound": observed_tokens, "terminal_charged_tokens": charged,
        "expected_budget_counters": expected, "budget_counter_mismatches": mismatches,
        "evidence_gaps": gaps, "adapter_evidence_complete": not gaps,
        "final_cost_proven": False, "unknown_release_allowed": False,
        "settlement_gaps": ["supplier_final_receipt_missing", "internal_http_attempt_coverage_unproven"],
        "requests": summaries,
    }


def audit(database, results, since_ms, limit):
    check(not results.is_symlink(), "results_symlink")
    results = results.resolve(strict=True)
    with sqlite3.connect(database.resolve().as_uri() + "?mode=ro", uri=True) as db:
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA query_only=ON")
        db.execute("BEGIN")
        workers = [dict(r) for r in db.execute(
            "SELECT run_id,task_id,pid,cwd,worker_session_id,started_at,finished_at,status,claim_started_at "
            "FROM workers WHERE started_at>=? ORDER BY started_at,run_id LIMIT ?", (since_ms, limit + 1))]
        total = db.execute("SELECT COUNT(*) FROM workers WHERE started_at>=?", (since_ms,)).fetchone()[0]
        costs = [dict(r) for r in db.execute("SELECT task_id,run_id,session_id,spent_tokens FROM task_run_costs")]
        reservations = [dict(r) for r in db.execute(
            "SELECT task_id,run_id,claim_started_at,state FROM task_budget_reservations")]
        owners = collections.defaultdict(set)
        for r in db.execute(
            "SELECT task_id,run_id,worker_session_id session_id FROM workers WHERE worker_session_id IS NOT NULL "
            "UNION SELECT task_id,run_id,session_id FROM task_run_costs WHERE session_id IS NOT NULL "
            "UNION SELECT task_id,run_id,session_id FROM task_runs WHERE session_id IS NOT NULL "
            "UNION SELECT task_id,run_id,session_id FROM task_cost_watch WHERE session_id IS NOT NULL"
        ):
            owners[r["session_id"]].add((r["task_id"], r["run_id"]))
        campaigns = [dict(r) for r in db.execute(
            "SELECT id,status,spent_tokens,budget_tokens FROM campaigns ORDER BY id")]
        db.rollback()
    reports = []
    for worker in workers[:limit]:
        run_id = worker["run_id"]
        row = {"run_id": run_id, "task_id": worker["task_id"], "worker_status": worker["status"],
               "final_cost_proven": False,
               "unknown_release_allowed": False}
        if not re.fullmatch(r"w[a-z0-9]+", run_id or ""):
            row.update(status="unavailable", reason="run_id_invalid")
        elif worker["status"] == "running" or not integer(worker["finished_at"]):
            row.update(status="in_flight", reason="worker_not_finished")
        else:
            try:
                check(owners[worker["worker_session_id"]] == {(worker["task_id"], run_id)},
                      "session_run_ownership_ambiguous")
                root = results / run_id
                check(not root.is_symlink(), "run_directory_symlink")
                files = {name: stable_read(root / name) for name in [
                    "worker-requests.jsonl", "worker-budget.json", "worker-session.json"]}
                report = journal_report(files["worker-requests.jsonl"],
                                        json.loads(files["worker-session.json"]),
                                        json.loads(files["worker-budget.json"]), worker)
                # Detect changes across the three file reads as well.
                check(all(stable_read(root / name) == content for name, content in files.items()),
                      "source_set_changed")
                own_costs = [r for r in costs if r["run_id"] == run_id]
                own_reservations = [r for r in reservations if r["run_id"] == run_id]
                report["source_sha256"] = {name: digest(content) for name, content in files.items()}
                ledger = own_costs[0] if len(own_costs) == 1 else None
                bound = ledger and ledger["task_id"] == worker["task_id"] and ledger["session_id"] == worker["worker_session_id"]
                if not bound:
                    report["ledger_comparison"] = "missing_or_ambiguous_binding"
                elif not integer(ledger["spent_tokens"]):
                    report["ledger_comparison"] = "invalid_amount"
                else:
                    delta = ledger["spent_tokens"] - report["observed_tokens_lower_bound"]
                    report["ledger_tokens"] = ledger["spent_tokens"]
                    report["ledger_comparison"] = "equal" if delta == 0 else "higher_than_journal" if delta > 0 else "below_observed_usage"
                reservation = own_reservations[0] if len(own_reservations) == 1 else None
                matched = reservation and reservation["task_id"] == worker["task_id"] and reservation["claim_started_at"] == worker["claim_started_at"]
                report["reservation_state"] = reservation["state"] if matched else "missing_or_ambiguous_binding"
                row.update(status="audited", **report)
            except (OSError, ValueError, TypeError, KeyError, AttributeError) as error:
                # Never echo input bytes, control-file nonces or exception messages.
                reason = str(error) if type(error) is ValueError and re.fullmatch(r"[a-z_]+", str(error)) else "source_unavailable_or_invalid"
                row.update(status="unavailable", reason=reason)
        reports.append(row)
    return {
        "schema_version": 1, "read_only": True, "sampled_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "workers_since_ms": since_ms, "workers_in_window": total, "workers_examined": len(reports),
        "selection_truncated": total > limit,
        "status_counts": dict(collections.Counter(r["status"] for r in reports)),
        "adapter_complete_runs": sum(r.get("adapter_evidence_complete", False) for r in reports),
        "ledger_equal_runs": sum(r.get("ledger_comparison") == "equal" for r in reports),
        "observed_tokens_lower_bound": sum(r.get("observed_tokens_lower_bound", 0) for r in reports),
        "final_cost_proven": False, "unknown_release_allowed": False, "campaigns": campaigns, "rows": reports,
        "limitations": [
            "The database and files are separate read-only sampling points, not a frozen snapshot.",
            "Journals are local adapter observations, not signed supplier invoices.",
            "A response ID or matching usage does not prove internal retries or final supplier billing.",
            "Missing journals, failed and incomplete calls remain unresolved; they are not zero-cost calls.",
            "Ledger amounts above the observed lower bound are retained, never automatically reduced.",
            "Results cover the selected workers only, not independent interactive model calls.",
        ],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", type=Path, required=True)
    parser.add_argument("--results", type=Path, required=True)
    parser.add_argument("--since", required=True, help="Inclusive worker start time, ISO8601 with timezone.")
    parser.add_argument("--limit", type=int, default=100)
    parser.add_argument("--host", help="Read remotely via PATH spool; upload/install/write nothing.")
    args = parser.parse_args()
    try:
        since = datetime.datetime.fromisoformat(args.since.replace("Z", "+00:00"))
        check(since.tzinfo is not None and 1 <= args.limit <= 10000, "invalid_selection")
        since_ms = int(since.timestamp() * 1000)
        check(integer(since_ms), "invalid_selection")
    except ValueError:
        parser.error("Use a timezone-qualified --since and --limit between 1 and 10000.")
    if args.host:
        command = ["sudo", "python3", "-c", Path(__file__).read_text(), "--database", str(args.database),
                   "--results", str(args.results), "--since", args.since, "--limit", str(args.limit)]
        return subprocess.run(["spool", "exec", args.host, shlex.join(command)]).returncode
    try:
        result = audit(args.database, args.results, since_ms, args.limit)
    except (OSError, ValueError, sqlite3.Error):
        print(json.dumps({"ok": False, "error": "audit_source_unavailable_or_invalid"}))
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0  # Audit completion is not a release/settlement approval.


if __name__ == "__main__":
    raise SystemExit(main())
