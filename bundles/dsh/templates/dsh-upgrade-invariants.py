#!/usr/bin/env python3
"""核对冻结点的业务表、主键、状态/引用字段、证据与工作区文件，不输出内容或凭据。"""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import sqlite3
import tempfile
import yaml

spec = importlib.util.spec_from_file_location("snapshot", Path(__file__).with_name("dsh-upgrade-snapshot.py"))
snapshot = importlib.util.module_from_spec(spec)
spec.loader.exec_module(snapshot)
BUSINESS = ("data/results", "data/flows", "data/knowledge", "data/playbooks", "data/rules", "data/vulncards", "data/reports",
            "data/scope.yml", "data/settings.yaml", "data/events", "data/audit.jsonl")
SCHEMA = 3
DOMAINS = {"bus", "asset", "endpoint", "vuln", "task", "fact", "know", "scope", "approval", "exec", "ledger", "report", "proxy", "fgs", "eval"}
FTS_SCHEMAS = {
    "kb_fts": "CREATE VIRTUAL TABLE kb_fts USING fts5(title, body)",
    "exp_fts": "CREATE VIRTUAL TABLE exp_fts USING fts5(scenario, takeaway, chain, content='exp_cards', content_rowid='id')",
}


def digest(values):
    return hashlib.sha256(json.dumps(values, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def value(item):
    if isinstance(item, bytes):
        return {"blob_sha256": hashlib.sha256(item).hexdigest(), "bytes": len(item)}
    return item


def quote(name):
    return '"' + name.replace('"', '""') + '"'


def registration(event):
    """只识别真实总线生成的域注册；事件其他类型一律不能作为启动例外。"""
    if not isinstance(event, dict) or set(event) != {"id", "domain", "name", "ts", "actor", "session_id", "cause", "payload"}:
        return None
    payload = event["payload"]
    if event["domain"] != "bus" or event["name"] != "bus.domain.registered" or event["actor"] != "system" \
            or event["session_id"] is not None or event["cause"] != {"cmd": "bus.internal", "idempotency_key": None}:
        return None
    if not isinstance(event["id"], str) or not event["id"].startswith("evt") or type(event["ts"]) is not int or event["ts"] < 0:
        return None
    if not isinstance(payload, dict) or set(payload) != {"domain", "version", "backend", "commands", "queries"} \
            or payload["domain"] not in DOMAINS or payload["backend"] != "sqlite-local" \
            or any(type(payload[key]) is not int or payload[key] < 0 for key in ("version", "commands", "queries")):
        return None
    return {"id": event["id"], "domain": payload["domain"], "ts": event["ts"],
            "payload_sha256": digest(payload), "event_sha256": digest(event)}


def fts_snapshot(db):
    result = {}
    for table, expected in FTS_SCHEMAS.items():
        schema = db.execute("SELECT sql FROM sqlite_master WHERE name=? AND type='table'", (table,)).fetchone()
        if not schema:
            continue
        recognized = re.sub(r"\s+", "", schema[0]).lower() == re.sub(r"\s+", "", expected).lower()
        rows = db.execute("SELECT rowid,* FROM " + quote(table) + " ORDER BY rowid").fetchall() if recognized else []
        ok, error = False, None
        if recognized:
            db.execute("SAVEPOINT check_fts")
            try:
                # rank=1 同时核对 external-content 原表；PRAGMA integrity_check 不覆盖此关系。
                db.execute("INSERT INTO " + quote(table) + "(" + quote(table) + ",rank) VALUES ('integrity-check',1)")
                ok = True
            except sqlite3.DatabaseError as exc:
                error = str(exc)
            finally:
                db.execute("ROLLBACK TO check_fts")
                db.execute("RELEASE check_fts")
        result[table] = {"recognized_schema": recognized, "count": len(rows), "rowid_content_sha256": digest(rows),
                         "integrity_ok": ok, "integrity_error": error}
    return result


def database_snapshot(filename, baseline=None, scope_file=None):
    programs = {}
    if scope_file and Path(scope_file).is_file():
        scope = yaml.safe_load(Path(scope_file).read_text())
        programs = {row["name"]: row for row in scope.get("programs", [])}
    with tempfile.TemporaryDirectory(prefix="dsh-invariant-sqlite-") as work:
        image = Path(work) / "database.sqlite"
        integrity = snapshot.sqlite_image(filename, image)
        with sqlite3.connect(image.as_uri() + "?mode=ro&immutable=1", uri=True) as db:
            tables = [r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
            report = {"integrity_check": integrity["integrity_check"], "tables": {}, "outbox_rows": {}, "registration_catalog": {},
                      "startup_observations": {}, "scope_sha256": snapshot.sha256(Path(scope_file)) if programs else None}
            for table in tables:
                columns = db.execute("PRAGMA table_info(" + quote(table) + ")").fetchall()
                names = [c[1] for c in columns]
                primary = [c[1] for c in sorted(columns, key=lambda c: c[5]) if c[5]]
                expected = baseline.get("tables", {}).get(table, {}).get("columns", names) if baseline else names
                missing, added = sorted(set(expected) - set(names)), sorted(set(names) - set(expected))
                projected = [name for name in expected if name in names]
                rows, stable_rows, keys, extra_nonempty = [], [], [], 0
                for record in db.execute("SELECT * FROM " + quote(table)):
                    data = dict(zip(names, record))
                    rows.append(json.dumps([value(data[name]) for name in projected], ensure_ascii=False, separators=(",", ":")))
                    keys.append(json.dumps([value(data[name]) for name in primary], ensure_ascii=False, separators=(",", ":")))
                    extra_nonempty += any(data[name] is not None for name in added)
                    if table == "event_outbox":
                        try:
                            event = registration(json.loads(data["payload"]))
                        except (ValueError, TypeError):
                            event = None
                        if event and (data.get("event_id") != event["id"] or data.get("domain") != "bus"
                                or data.get("name") != "bus.domain.registered" or data.get("producer_ts") != event["ts"]
                                or data.get("status") != "delivered" or data.get("retry_count") != 0
                                or data.get("next_retry_at") is not None or data.get("last_error") is not None
                                or type(data.get("created_at")) is not int or data["created_at"] < event["ts"]):
                            event = None
                        report["outbox_rows"][data["event_id"]] = {"row_sha256": digest(data), "registration": event}
                        if event:
                            prior = report["registration_catalog"].get(event["domain"])
                            if prior is None or event["ts"] >= prior["ts"]:
                                report["registration_catalog"][event["domain"]] = event
                    stable = dict(data)
                    observation = None
                    if table == "bus_meta" and (data.get("key") == "replay.watermark"
                            or re.fullmatch(r"seen\.([a-z_-]+)\.version", str(data.get("key", "")))):
                        observation = {"updated_at": data.get("updated_at")}
                        stable["updated_at"] = "startup-observation-time"
                    if table == "programs" and data.get("status") == "active" and data.get("id") in programs:
                        canonical = programs[data["id"]].get("platform") or ""
                        platform = data.get("platform")
                        if isinstance(canonical, str) and platform in (canonical, json.dumps(canonical, ensure_ascii=False), "'" + canonical + "'"):
                            observation = {"updated_at": data.get("updated_at"), "platform_canonical": platform == canonical}
                            stable.update(platform=canonical, updated_at="startup-observation-time")
                    if observation:
                        report["startup_observations"].setdefault(table, {})[digest([data[name] for name in primary])] = observation
                    stable_rows.append(json.dumps([value(stable[name]) for name in projected], ensure_ascii=False, separators=(",", ":")))
                report["tables"][table] = {"columns": names, "primary_key": primary, "count": len(rows), "rows_sha256": digest(sorted(rows)),
                    "startup_rows_sha256": digest(sorted(stable_rows)), "keys_sha256": digest(sorted(keys)),
                    "missing_columns": missing, "added_columns": added, "added_nonempty_rows": extra_nonempty}
            objects = db.execute("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND NOT (type='table' AND name='workers') ORDER BY type,name").fetchall()
            report["schema_except_workers_sha256"] = digest(objects)
            workers = db.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='workers'").fetchone()
            report["workers_schema_sql"] = workers[0] if workers else None
        # 只在独立 SQLite backup 镜像中执行 FTS 的特殊检查命令。
        with sqlite3.connect(image) as db:
            report["fts"] = fts_snapshot(db)
        return report


def repair_indexes(filename):
    """发布准备阶段只对 next/rollback 副本调用；原冻结点与业务行均保留。"""
    before = database_snapshot(filename)
    rebuild = [name for name, data in before["fts"].items() if not data["integrity_ok"]]
    if any(not before["fts"][name]["recognized_schema"] for name in rebuild):
        raise RuntimeError("未知 FTS schema，拒绝自动重建")
    derived = {name + suffix for name in rebuild for suffix in ("_data", "_idx", "_docsize")}
    def business(db):
        tables = [row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name") if row[0] not in derived]
        return {name: digest(sorted(json.dumps([value(x) for x in row], ensure_ascii=False) for row in db.execute("SELECT * FROM " + quote(name))))
                for name in tables}
    with sqlite3.connect(filename) as db:
        db.execute("BEGIN IMMEDIATE")
        original = business(db)
        for name in rebuild:
            db.execute("INSERT INTO " + quote(name) + "(" + quote(name) + ") VALUES ('rebuild')")
        repaired = fts_snapshot(db)
        if any(not row["integrity_ok"] for row in repaired.values()) or original != business(db):
            raise RuntimeError("FTS 重建未通过原文/业务行核对，事务已回滚")
    after = database_snapshot(filename)
    return {"rebuilt": rebuild, "business_rows_unchanged": True, "before": before["fts"], "after": after["fts"],
            "before_sha256": digest(before), "after_sha256": digest(after)}


def approved_worker_schema(original):
    # 让 SQLite 自身计算这一条已批准 ALTER 的结果，避免字符串宽松匹配
    # 把既有列类型、NOT NULL、DEFAULT、CHECK 或外键的变化也放行。
    with sqlite3.connect(":memory:") as db:
        db.execute(original)
        db.execute("ALTER TABLE workers ADD COLUMN worker_session_id TEXT")
        return db.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='workers'").fetchone()[0]


def file_view(filename):
    entries = snapshot.tree_manifest(filename)
    return {key: {field: item[field] for field in ("kind", "sha256", "size", "target") if field in item}
            for key, item in entries.items() if item["kind"] != "directory"}


def event_log_view(filename, baseline=None):
    report = {"bytes": filename.stat().st_size, "sha256": snapshot.sha256(filename)}
    if baseline is None:
        return report
    prefix = hashlib.sha256()
    remaining = baseline["bytes"]
    with filename.open("rb") as stream:
        while remaining:
            chunk = stream.read(min(remaining, 1024 * 1024))
            if not chunk:
                break
            prefix.update(chunk)
            remaining -= len(chunk)
        suffix = stream.read(256 * 1024 + 1)
    events = []
    valid = remaining == 0 and len(suffix) <= 256 * 1024 and (not suffix or suffix.endswith(b"\n"))
    if valid:
        for line in suffix.splitlines():
            try:
                event = registration(json.loads(line))
            except (ValueError, UnicodeError):
                event = None
            if event is None:
                valid = False
                break
            events.append(event)
    report.update(prefix_sha256=prefix.hexdigest(), prefix_bytes=baseline["bytes"] - remaining,
                  suffix_valid=valid, appended=events)
    return report


def capture(root, source_manifest, baseline=None):
    root = Path(root).resolve(strict=True) if root is not None else None
    report = {"schema": SCHEMA, "captured_at": snapshot.now(), "source_manifest_sha256": snapshot.sha256(source_manifest), "files": {}, "databases": {},
              "event_log": None,
              "mode": "isolated-copy" if root else "live-held"}
    manifest = json.loads(Path(source_manifest).read_text())
    if root is None:
        snapshot.assert_quiescent(manifest["config"])
    locations = {entry["name"]: root / entry["name"] if root else Path(manifest["roots"][entry["name"]]["source"])
                 for entry in manifest["config"]["roots"]}
    for entry in manifest["config"]["roots"]:
        name = entry["name"]
        if not entry.get("mutable", True):
            continue
        directory = locations[name]
        if name == "dsh":
            log = directory / "data/events/bus.jsonl"
            if log.is_file():
                report["event_log"] = event_log_view(log, baseline.get("event_log") if baseline else None)
            paths = [directory / rel for rel in BUSINESS if (directory / rel).exists()]
            paths += [p for p in (directory / "data/storages").glob("*workspace*") if p.is_file()]
            for filename in paths:
                relative = name + "/" + str(filename.relative_to(directory))
                report["files"][relative] = file_view(filename)
        else:
            report["files"][name] = file_view(directory)
    for database in manifest["config"].get("sqlite", []):
        key = database["root"] + "/" + database["path"]
        report["databases"][key] = database_snapshot(locations[database["root"]] / database["path"], baseline["databases"].get(key) if baseline else None,
            locations["dsh"] / "data/scope.yml" if database["root"] == "dsh" else None)
    if root is None:
        snapshot.assert_quiescent(manifest["config"])
    return report


def added_registrations(before, after):
    old, new = before.get("outbox_rows", {}), after.get("outbox_rows", {})
    if any(new.get(key, {}).get("row_sha256") != row["row_sha256"] for key, row in old.items()):
        return None
    added = [row.get("registration") for key, row in new.items() if key not in old]
    if not added:
        return {}
    if any(row is None for row in added):
        return None
    catalog = before.get("registration_catalog", {})
    if len(added) != len(catalog) or {row["domain"] for row in added} != set(catalog):
        return None
    if any(row["payload_sha256"] != catalog[row["domain"]]["payload_sha256"] or row["ts"] <= catalog[row["domain"]]["ts"] for row in added):
        return None
    return {row["id"]: row for row in added}


def startup_table_equal(table, before, after):
    if table not in {"bus_meta", "programs"}:
        return False
    a, b = before["tables"][table], after.get("tables", {}).get(table, {})
    if a.get("startup_rows_sha256") != b.get("startup_rows_sha256"):
        return False
    if table == "programs" and (not before.get("scope_sha256") or before["scope_sha256"] != after.get("scope_sha256")):
        return False
    old = before.get("startup_observations", {}).get(table, {})
    new = after.get("startup_observations", {}).get(table, {})
    if not old or old.keys() != new.keys():
        return False
    for key, row in old.items():
        current = new[key]
        if type(row.get("updated_at")) is not int or type(current.get("updated_at")) is not int or current["updated_at"] < row["updated_at"]:
            return False
        if row.get("platform_canonical") and not current.get("platform_canonical"):
            return False
    return True


def compare(before, after, candidate=None, *, same_freeze_point=True):
    failures, expected = [], []
    if before.get("schema") != SCHEMA or after.get("schema") != SCHEMA:
        failures.append("unsupported invariant schema; capture a current baseline")
    if same_freeze_point and (not before.get("source_manifest_sha256") or before["source_manifest_sha256"] != after.get("source_manifest_sha256")):
        failures.append("source freeze manifest differs")
    if before["files"].keys() != after["files"].keys():
        failures.append("evidence/workspace root set changed")
    browser_sha = snapshot.sha256(Path(candidate) / "dsh-shared-browser-host.mjs") if candidate else None
    registrations = {}
    for name, database in before["databases"].items():
        added = added_registrations(database, after["databases"].get(name, {}))
        if added:
            registrations.update(added)
    log_before, log_after = before.get("event_log"), after.get("event_log")
    log_matches = bool(registrations and log_before and log_after and log_after.get("suffix_valid")
        and log_after.get("prefix_bytes") == log_before["bytes"] and log_after.get("prefix_sha256") == log_before["sha256"]
        and len(log_after.get("appended", [])) == len(registrations)
        and {row["id"]: row for row in log_after.get("appended", [])} == registrations)
    for root, files in before["files"].items():
        current = after["files"].get(root, {})
        if files.keys() != current.keys():
            failures.append(root + ": file set changed")
        for name, data in files.items():
            if current.get(name) == data:
                continue
            if browser_sha and name == "browser/shared-browser-host.mjs" and root.startswith("workspace-") \
                    and current.get(name, {}).get("sha256") == browser_sha:
                expected.append("managed-browser-host-update:" + root)
            elif root == "dsh/data/events" and name == "bus.jsonl" and log_matches:
                expected.append("startup-registration-log-append:" + str(len(registrations)))
            else:
                failures.append(root + "/" + name + ": content/reference changed")
    if before["databases"].keys() != after["databases"].keys():
        failures.append("database set changed")
    for name, database in before["databases"].items():
        current = after["databases"].get(name, {})
        if current.get("schema_except_workers_sha256") != database["schema_except_workers_sha256"]:
            failures.append(name + ": unexpected schema change")
        if database["tables"].keys() != current.get("tables", {}).keys():
            failures.append(name + ": table set changed")
        worker_schema = database.get("workers_schema_sql")
        if worker_schema and current.get("tables", {}).get("workers", {}).get("added_columns") == ["worker_session_id"]:
            worker_schema = approved_worker_schema(worker_schema)
        if current.get("workers_schema_sql") != worker_schema:
            failures.append(name + ": unexpected workers schema change")
        derived = set()
        for table, fts in database.get("fts", {}).items():
            other = current.get("fts", {}).get(table, {})
            if not other.get("recognized_schema") or not other.get("integrity_ok"):
                failures.append(name + ": " + table + ".content_integrity")
            elif other.get("rowid_content_sha256") == fts["rowid_content_sha256"]:
                derived.update(table + suffix for suffix in ("_data", "_idx", "_docsize"))
                if not fts["integrity_ok"]:
                    expected.append("repaired-existing-fts-index:" + table)
            else:
                failures.append(name + ": " + table + ".rowid_content")
        outbox_equal = added_registrations(database, current) is not None and (not registrations or log_matches)
        for table, values in database["tables"].items():
            actual = current.get("tables", {}).get(table, {})
            for field in ("primary_key", "count", "rows_sha256", "keys_sha256"):
                if actual.get(field) != values[field]:
                    if field != "primary_key" and table in derived:
                        expected.append("verified-fts-physical-index:" + table)
                    elif field != "primary_key" and table == "event_outbox" and outbox_equal:
                        expected.append("startup-registration-outbox:" + str(len(registrations)))
                    elif field == "rows_sha256" and startup_table_equal(table, database, current):
                        expected.append("startup-mirror-observation:" + table)
                    else:
                        failures.append(name + ": " + table + "." + field)
            if actual.get("missing_columns") or actual.get("added_nonempty_rows"):
                failures.append(name + ": invalid column migration in " + table)
            additions = actual.get("added_columns", [])
            if additions:
                if table == "workers" and additions == ["worker_session_id"]:
                    expected.append("nullable-worker-session-id-column")
                else:
                    failures.append(name + ": unexpected added columns in " + table)
    return {"ok": not failures, "failures": failures, "expected_changes": sorted(set(expected)),
            "comparison_scope": "same-freeze-point" if same_freeze_point else "cross-freeze-reconciliation",
            "source_manifests": {"before": before.get("source_manifest_sha256"), "after": after.get("source_manifest_sha256")},
            "tables": sum(len(db["tables"]) for db in before["databases"].values()),
            "files": sum(len(files) for files in before["files"].values()),
            "business_rows_and_keys_preserved": not failures}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--root")
    source.add_argument("--live", action="store_true", help="只读核对冻结且无写者的生产根")
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--baseline")
    parser.add_argument("--candidate")
    args = parser.parse_args()
    before = json.loads(Path(args.baseline).read_text()) if args.baseline else None
    after = capture(args.root, args.manifest, before)
    if before:
        result = {**compare(before, after, args.candidate), "captured_at": snapshot.now(), "baseline_sha256": snapshot.sha256(Path(args.baseline))}
        result["after"] = after
    else:
        result = after
    snapshot.write_json(Path(args.output), result)
    print(json.dumps({key: value for key, value in result.items() if key not in {"files", "databases", "after"}}))
    return 0 if result.get("ok", True) else 1


if __name__ == "__main__":
    raise SystemExit(main())
