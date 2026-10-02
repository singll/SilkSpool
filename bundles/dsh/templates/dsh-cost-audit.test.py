#!/usr/bin/env python3
"""Cost audit tests use synthetic sessions and temporary databases only."""
import hashlib
import importlib.util
import json
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("cost_audit", Path(__file__).with_name("dsh-cost-audit.py"))
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)


def event(seq, kind="assistant/message", usage=None, finish="stop"):
    stream = [{"chunk": {"type": "finish", "reason": {"kind": finish}}}]
    if usage is not None:
        stream.insert(0, {"chunk": {"type": "usage", "usage": usage}})
    return {"type": kind, "seq": seq, "time": 150 + seq,
            "data": {"usage": usage, "stream": stream,
                     "message": {"content": "PRIVATE_PROMPT_AND_CREDENTIAL"}}}


def session(*events, sid="session-test"):
    return b"".join((json.dumps(row) + "\n").encode() for row in [
        {"type": "session", "version": 4, "id": sid, "createdAt": 110, "cwd": "/workspace"},
        *events])


class SessionEvidenceTests(unittest.TestCase):
    def evidence(self, content):
        return audit.session_evidence(content, "session-test", 100, 200, "/workspace")

    def test_cached_usage_counts_once_and_preserves_failed_lower_bound(self):
        usage = {"inputTokens": 10, "outputTokens": 2, "cacheReadTokens": 30, "cacheWriteTokens": 3}
        result = self.evidence(session(event(1, usage=usage),
                                       event(2, "assistant/attempt", {"inputTokens": 1, "outputTokens": 0}, "error")))
        self.assertEqual(result["recorded_tokens_lower_bound"], 46)
        self.assertEqual(result["normal_tokens_lower_bound"], 45)
        self.assertEqual(result["unresolved"]["failed_or_incomplete_request"], 1)
        self.assertFalse(result["final_cost_proven"])
        self.assertNotIn("PRIVATE_", json.dumps(result))

    def test_replayed_events_are_not_double_charged(self):
        row = event(1, usage={"inputTokens": 10, "outputTokens": 2})
        result = self.evidence(session(row, row))
        self.assertEqual(result["recorded_tokens_lower_bound"], 12)
        self.assertEqual(result["duplicate_events"], 1)
        with self.assertRaisesRegex(ValueError, "event_sequence_conflict"):
            self.evidence(session(row, event(1, usage={"inputTokens": 11, "outputTokens": 2})))

    def test_zero_missing_usage_title_and_projection_conflict(self):
        mismatch = event(4, usage={"inputTokens": 1, "outputTokens": 1})
        mismatch["data"]["usage"]["inputTokens"] = 2
        mismatch["data"]["stream"][0]["chunk"]["usage"] = {"inputTokens": 1, "outputTokens": 1}
        result = self.evidence(session(event(1, usage={"inputTokens": 0, "outputTokens": 0}),
                                       event(2, "assistant/attempt", finish="error"),
                                       {"type": "session/title-llm-request", "seq": 3, "time": 153, "data": {}},
                                       mismatch))
        self.assertEqual(result["requests_with_usage"], 1)
        self.assertEqual(result["recorded_tokens_lower_bound"], 0)
        self.assertEqual(result["unresolved"]["invalid_or_missing_usage"], 2)
        self.assertEqual(result["unresolved"]["title_without_final_usage"], 1)
        self.assertEqual(result["unresolved"]["usage_projection_conflict"], 1)
        self.assertFalse(result["final_cost_proven"])

    def test_identity_window_cwd_and_sequence_are_required(self):
        content = session(event(1, usage={"inputTokens": 1, "outputTokens": 2}))
        for sid, start, finish, cwd, code in [
            ("another-session", 100, 200, "/workspace", "session_header_mismatch"),
            ("session-test", 120, 200, "/workspace", "session_outside_run"),
            ("session-test", 100, 120, "/workspace", "request_outside_run"),
            ("session-test", None, 200, "/workspace", "run_window_missing"),
            ("session-test", 100, 200, "/another", "session_cwd_mismatch"),
        ]:
            with self.subTest(code=code), self.assertRaisesRegex(ValueError, code):
                audit.session_evidence(content, sid, start, finish, cwd)
        with self.assertRaisesRegex(ValueError, "event_sequence_unordered"):
            self.evidence(session(event(2), event(1)))

    def test_malformed_and_unsafe_usage_cannot_be_counted(self):
        for usage in [{"inputTokens": True, "outputTokens": 1},
                      {"inputTokens": -1, "outputTokens": 2},
                      {"inputTokens": 1, "outputTokens": 2, "cacheReadTokens": None},
                      {"inputTokens": 2**53 - 1, "outputTokens": 1},
                      {"inputTokens": 1.5, "outputTokens": 2}]:
            with self.subTest(usage=usage):
                self.assertIsNone(audit.tokens(usage))
        with self.assertRaises(ValueError):
            self.evidence(b'{"PRIVATE_SECRET":')


class FullAuditTests(unittest.TestCase):
    def test_complete_read_only_audit_rejects_ambiguous_and_pruned_ownership(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            database, bills, sessions = root / "graph.db", root / "records.jsonl", root / "sessions"
            sessions.mkdir()
            db = sqlite3.connect(database)
            db.executescript("""
                CREATE TABLE task_cost_watch(id INTEGER,task_id INTEGER,run_id TEXT,session_id TEXT);
                CREATE TABLE task_runs(task_id INTEGER,run_id TEXT,session_id TEXT,started_at INTEGER,finished_at INTEGER,spent_tokens INTEGER);
                CREATE TABLE task_run_costs(task_id INTEGER,run_id TEXT,session_id TEXT,spent_tokens INTEGER);
                CREATE TABLE task_bill_items(task_id INTEGER,run_id TEXT,tokens INTEGER);
                CREATE TABLE workers(run_id TEXT,task_id INTEGER,worker_session_id TEXT,cwd TEXT);
                CREATE TABLE campaigns(id INTEGER,status TEXT,budget_tokens INTEGER,spent_tokens INTEGER);
                CREATE TABLE tasks(id INTEGER,campaign_id INTEGER);
                CREATE TABLE task_budget_reservations(state TEXT,tokens INTEGER);
                INSERT INTO campaigns VALUES(1,'paused',10000,12);
                INSERT INTO task_budget_reservations VALUES('unknown',100);
            """)
            for n in range(1, 8):
                sid = f"session-{n}" if n != 4 else "session-3"
                db.execute("INSERT INTO task_cost_watch VALUES(?,?,?,?)", (n, n, f"run-{n}", sid))
                db.execute("INSERT INTO tasks VALUES(?,1)", (n,))
                # A pruned run remains in watch; it must still cause ambiguous ownership.
                if n != 4:
                    db.execute("INSERT INTO task_runs VALUES(?,?,?,?,?,NULL)", (n, f"run-{n}", sid, 100, 200))
                if n not in {4, 6}:
                    p = sessions / f"cwd-{n}" / sid / "session.v4.jsonl.zstd"
                    p.parent.mkdir(parents=True)
                    encoded = subprocess.run(["zstd", "-cq"], input=session(
                        event(1, usage={"inputTokens": 10, "outputTokens": 2}), sid=sid),
                        capture_output=True, check=True).stdout
                    p.write_bytes(encoded)
            # Same session file in two directories cannot be guessed.
            duplicate = sessions / "duplicate" / "session-7" / "session.v4.jsonl.zstd"
            duplicate.parent.mkdir(parents=True)
            duplicate.write_bytes((sessions / "cwd-7/session-7/session.v4.jsonl.zstd").read_bytes())
            db.execute("INSERT INTO task_run_costs VALUES(2,'run-2','session-2',12)")
            db.execute("INSERT INTO task_bill_items VALUES(2,'run-2',12)")
            db.execute("INSERT INTO workers VALUES('run-5',99,'session-5','/workspace')")
            db.commit()
            db.close()
            row = {"sessionId": "session-2", "time": 151, "seq": 1, "provider": "fixture",
                   "inputTokens": 10, "outputTokens": 2}
            bills.write_text(json.dumps(row) + "\n")
            before = {p: hashlib.sha256(p.read_bytes()).hexdigest() for p in root.rglob("*") if p.is_file()}
            result = audit.audit(database, bills, sessions)
            after = {p: hashlib.sha256(p.read_bytes()).hexdigest() for p in root.rglob("*") if p.is_file()}
            self.assertEqual(before, after)
            self.assertEqual(result["summary"]["watch"], 7)
            self.assertEqual(result["summary"]["missing_bill_attributable_sessions"], 1)
            self.assertEqual(result["summary"]["missing_bill_recorded_tokens_lower_bound"], 12)
            self.assertEqual(result["rows"][1]["bill_status"], "matched")
            self.assertEqual(result["rows"][2]["session_status"], "ambiguous_run_ownership")
            self.assertEqual(result["rows"][3]["session_status"], "ambiguous_run_ownership")
            self.assertEqual(result["rows"][4]["session_status"], "ambiguous_run_ownership")
            self.assertEqual(result["rows"][5]["session_status"], "session_missing_or_duplicated")
            self.assertEqual(result["rows"][6]["session_status"], "session_missing_or_duplicated")
            self.assertEqual(result["reservations"], [{"state": "unknown", "n": 1, "tokens": 100}])
            self.assertNotIn("PRIVATE_", json.dumps(result))
            self.assertNotIn("title", json.dumps(result["rows"][0]["session"]["request_evidence"]))
            self.assertFalse(result["final_cost_proven"])

    def test_bills_replay_conflict_and_partial_record(self):
        with tempfile.TemporaryDirectory() as folder:
            filename = Path(folder) / "records.jsonl"
            row = {"sessionId": "session-test", "time": 150, "seq": 1,
                   "inputTokens": 10, "outputTokens": 2}
            line = json.dumps(row) + "\n"
            filename.write_text(line + line + json.dumps({**row, "inputTokens": 20}) + "\n" + '{"incomplete":')
            sessions, report = audit.bill_evidence(filename, 200)
            self.assertEqual(sum(sessions["session-test"].values()), 22)
            self.assertEqual(report["exact_duplicates"], 1)
            self.assertEqual(report["receipt_value_conflicts"], 1)
            self.assertEqual(report["invalid_records"], 1)
            self.assertEqual(report["invalid_reasons"], {"incomplete_line": 1})

    def test_evicted_rollup_is_evidence_without_run_attribution(self):
        with tempfile.TemporaryDirectory() as folder:
            filename = Path(folder) / "rollup.json"
            row = {"calls": 8, "uncachedInputTokens": 10, "cacheReadTokens": 30,
                   "cacheWriteTokens": 0, "outputTokens": 2, "fileSkip": 3,
                   "byPurpose": {"PRIVATE_LABEL": 42}}
            filename.write_text(json.dumps(row))
            result = audit.rollup_evidence(filename)
            self.assertFalse(result["has_session_attribution"])
            self.assertEqual(result["fileSkip"], 3)
            self.assertEqual(result["cacheReadTokens"], 30)
            self.assertNotIn("PRIVATE_", json.dumps(result))
            filename.write_text(json.dumps({**row, "calls": -1}))
            with self.assertRaisesRegex(ValueError, "rollup_shape_invalid"):
                audit.rollup_evidence(filename)

    def test_invalid_compression_and_partial_session_are_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            filename = Path(folder) / "session.v4.jsonl.zstd"
            filename.write_bytes(b"corrupt")
            with self.assertRaisesRegex(ValueError, "session_decode_failed"):
                audit.read_session(filename)
            filename.write_bytes(subprocess.run(["zstd", "-cq"], input=b'{"unfinished":',
                                                capture_output=True, check=True).stdout)
            with self.assertRaisesRegex(ValueError, "session_incomplete"):
                audit.read_session(filename)


if __name__ == "__main__":
    unittest.main()
