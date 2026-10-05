#!/usr/bin/env python3
"""Synthetic request traces and temporary SQLite fixtures; no model/network calls."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
import uuid

spec = importlib.util.spec_from_file_location("request_audit", Path(__file__).with_name("dsh-request-cost-audit.py"))
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)

NONCE = "a" * 48
WORKER = {"run_id": "wtest", "task_id": 7, "pid": 123, "cwd": "/fixture",
          "worker_session_id": "session-test", "started_at": 100, "finished_at": 300,
          "status": "done", "claim_started_at": 99}
SESSION = {"run_id": "wtest", "pid": 123, "cwd": "/fixture", "session_id": "session-test",
           "created_at": 100, "nonce": NONCE}


def trace(reason="stop", failed=False, amount=12, response="response-test"):
    request_id = str(uuid.uuid4())
    common = {"schema_version": 1, "run_id": "wtest", "pid": 123, "session_id": "session-test",
              "launch_sha256": hashlib.sha256(NONCE.encode()).hexdigest(),
              "request_id": request_id, "request_sequence": 1, "provider": "fixture", "model": "fixture",
              "final_cost_proven": False}
    counts = {"inputTokens": amount, "outputTokens": 2, "cacheReadTokens": 30, "cacheWriteTokens": 3}
    events = [
        {"event": "admitted", "reserved_tokens": 150, "estimated_input_tokens": 100, "max_output_tokens": 50},
        {"event": "usage", "usage": counts},
        {"event": "finish", "finish_kind": reason, "provider_response_id": response,
         "response_id_source": "pi-ai-replay-v2" if response else None},
        {"event": "terminal", "finish_kind": reason, "finish_count": 1,
         "provider_response_id": response, "completed": True, "failed": failed,
         "termination": "adapter_error" if failed else "stream_exhausted",
         "usage": counts, "usage_state": "reported"},
    ]
    rows = [dict(common, **event, event_sequence=i, recorded_at=100 + i) for i, event in enumerate(events, 1)]
    return rows, {"run_id": "wtest", "nonce": NONCE, "limit": 1000, "charged": amount + 35,
                  "reserved": 150 if failed else 0, "unknown": 1 if failed else 0,
                  "requests": 1, "denied": 0}


def encode(rows):
    return b"".join(json.dumps(row).encode() + b"\n" for row in rows)


class JournalTests(unittest.TestCase):
    def report(self, rows, budget, suffix=b""):
        return audit.journal_report(encode(rows) + suffix, SESSION, budget, WORKER)

    def test_normal_cached_usage_matches_budget_but_cannot_release_unknown(self):
        rows, budget = trace()
        report = self.report(rows, budget)
        self.assertTrue(report["adapter_evidence_complete"])
        self.assertEqual(report["observed_tokens_lower_bound"], 47)
        self.assertFalse(report["final_cost_proven"])
        self.assertFalse(report["unknown_release_allowed"])
        text = json.dumps(report)
        self.assertNotIn(NONCE, text)
        self.assertNotIn("response-test", text)

    def test_planning_estimate_uses_usage_without_awaiting_supplier_receipt(self):
        rows, budget = trace()
        report = self.report(rows, budget)
        self.assertEqual(report["planning_estimated_tokens"], 47)
        self.assertEqual(report["planning_estimated_requests"], 0)
        self.assertFalse(report["supplier_receipt_required_for_planning"])
        self.assertFalse(report["final_cost_proven"])

    def test_failed_estimate_replaces_lower_bound_without_double_counting(self):
        rows, budget = trace(reason="error", failed=True)
        report = self.report(rows, budget)
        self.assertEqual(report["observed_tokens_lower_bound"], 47)
        self.assertEqual(report["planning_estimated_tokens"], 150)
        self.assertEqual(report["planning_estimated_requests"], 1)
        rows, budget = trace(reason="error", failed=True, amount=200)
        report = self.report(rows, budget)
        self.assertEqual(report["planning_estimated_tokens"], 235)
        self.assertFalse(report["unknown_release_allowed"])

    def test_failed_zero_usage_is_not_free_or_settled(self):
        rows, budget = trace(reason="error", failed=True, response=None)
        for row in rows:
            if "usage" in row:
                row["usage"] = {"inputTokens": 0, "outputTokens": 0}
        budget["charged"] = 0
        report = self.report(rows, budget)
        self.assertFalse(report["adapter_evidence_complete"])
        self.assertEqual(report["budget_counter_mismatches"], [])
        self.assertEqual(report["expected_budget_counters"]["reserved"], 150)
        self.assertFalse(report["requests"][0]["runtime_budget_settled"])

    def test_normal_zero_usage_remains_distinct_from_missing_usage(self):
        rows, budget = trace()
        for row in rows:
            if "usage" in row:
                row["usage"] = {"inputTokens": 0, "outputTokens": 0}
        budget["charged"] = 0
        report = self.report(rows, budget)
        self.assertTrue(report["adapter_evidence_complete"])
        self.assertEqual(report["observed_tokens_lower_bound"], 0)
        self.assertFalse(report["final_cost_proven"])

    def test_killed_and_partial_terminal_preserve_prefix(self):
        rows, budget = trace()
        budget.update(charged=0, reserved=150, unknown=0)
        report = self.report(rows[:2], budget, b'{"event":"terminal"')
        self.assertEqual(report["observed_tokens_lower_bound"], 47)
        self.assertEqual(report["terminal_charged_tokens"], 0)
        self.assertIn("journal_trailing_partial_event", report["evidence_gaps"])
        self.assertIn("terminal_missing", report["requests"][0]["evidence_gaps"])
        self.assertFalse(report["unknown_release_allowed"])

    def test_normal_usage_without_finish_is_evidence_gap_even_if_runtime_settled(self):
        rows, budget = trace()
        rows.pop(2)
        rows[-1].update(event_sequence=3, finish_kind=None, finish_count=0, provider_response_id=None)
        report = self.report(rows, budget)
        self.assertTrue(report["requests"][0]["runtime_budget_settled"])
        self.assertFalse(report["adapter_evidence_complete"])

    def test_cancelled_request_preserves_observed_lower_bound(self):
        rows, budget = trace()
        rows[-1].update(completed=False, termination="consumer_cancelled")
        budget.update(reserved=150, unknown=1)
        report = self.report(rows, budget)
        self.assertEqual(report["observed_tokens_lower_bound"], 47)
        self.assertIn("failed_or_interrupted_request", report["requests"][0]["evidence_gaps"])
        self.assertEqual(report["budget_counter_mismatches"], [])

    def test_duplicate_event_conflicting_identity_or_false_receipt_rejected(self):
        rows, budget = trace()
        for index, key, value, reason in [
            (1, "event_sequence", 1, "journal_sequence_invalid"),
            (1, "model", "other", "request_identity_changed"),
            (1, "session_id", "session-other", "journal_session_mismatch"),
            (1, "launch_sha256", "0" * 64, "journal_launch_mismatch"),
            (1, "recorded_at", 301, "journal_time_invalid"),
            (1, "final_cost_proven", True, "unsupported_settlement_claim"),
            (3, "finish_count", 2, "terminal_finish_count_mismatch"),
            (3, "usage", {"inputTokens": 1, "outputTokens": 0}, "terminal_usage_mismatch"),
        ]:
            changed = copy.deepcopy(rows)
            changed[index][key] = value
            with self.subTest(reason=reason), self.assertRaisesRegex(ValueError, reason):
                self.report(changed, budget)
        with self.assertRaisesRegex(ValueError, "journal_json_invalid"):
            audit.journal_report(b'{"secret":"DO_NOT_PRINT"\n', SESSION, budget, WORKER)

    def test_concurrent_requests_and_denial_count_once(self):
        first, budget = trace()
        second, other_budget = trace(response="response-other")
        for row in second:
            row["request_sequence"] = 2
        rows = [first[0], second[0], *first[1:], *second[1:]]
        denied = dict(first[0], request_id=str(uuid.uuid4()), request_sequence=3, event="denied")
        rows.append(denied)
        for index, row in enumerate(rows, 1):
            row.update(event_sequence=index, recorded_at=100 + index)
        budget.update(charged=budget["charged"] + other_budget["charged"], requests=2, denied=1)
        report = self.report(rows, budget)
        self.assertTrue(report["adapter_evidence_complete"])
        self.assertEqual(report["observed_tokens_lower_bound"], 94)
        self.assertEqual(report["denied"], 1)

    def test_response_id_reuse_and_budget_mismatch_are_visible(self):
        first, budget = trace()
        second, _ = trace()
        for row in second:
            row["request_sequence"] = 2
        rows = first + second
        for index, row in enumerate(rows, 1):
            row.update(event_sequence=index, recorded_at=100 + index)
        report = self.report(rows, budget)
        self.assertIn("provider_response_id_reused", report["evidence_gaps"])
        self.assertIn("budget_projection_mismatch", report["evidence_gaps"])

    def test_unsafe_usage_is_unresolved(self):
        rows, budget = trace()
        for row in rows:
            if "usage" in row:
                row.update(usage={"inputTokens": True, "outputTokens": 2})
        rows[-1]["usage_state"] = "unknown"
        budget.update(charged=0, reserved=150, unknown=1)
        report = self.report(rows, budget)
        self.assertFalse(report["adapter_evidence_complete"])
        self.assertEqual(report["observed_tokens_lower_bound"], 0)


class ReadOnlyAuditTests(unittest.TestCase):
    def fixture(self, root):
        database = root / "data.db"
        with sqlite3.connect(database) as db:
            db.execute("CREATE TABLE workers(run_id,task_id,pid,cwd,worker_session_id,started_at,finished_at,status,claim_started_at)")
            db.execute("INSERT INTO workers VALUES(?,?,?,?,?,?,?,?,?)", tuple(WORKER.values()))
            db.executescript("""
                CREATE TABLE task_run_costs(task_id,run_id,session_id,spent_tokens);
                INSERT INTO task_run_costs VALUES(7,'wtest','session-test',47);
                CREATE TABLE task_budget_reservations(task_id,run_id,claim_started_at,state);
                INSERT INTO task_budget_reservations VALUES(7,'wtest',99,'settled');
                CREATE TABLE campaigns(id,status,spent_tokens,budget_tokens);
                INSERT INTO campaigns VALUES(1,'paused',47,1000);
                CREATE TABLE task_runs(task_id,run_id,session_id);
                CREATE TABLE task_cost_watch(task_id,run_id,session_id);
            """)
        results = root / "results"
        run = results / "wtest"
        run.mkdir(parents=True)
        rows, budget = trace()
        for name, content in [("worker-requests.jsonl", encode(rows)),
                              ("worker-budget.json", json.dumps(budget).encode()),
                              ("worker-session.json", json.dumps(SESSION).encode())]:
            (run / name).write_bytes(content)
            (run / name).chmod(0o600)
        return database, results

    def test_end_to_end_preserves_inputs_and_compares_ledger_without_mutation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            database, results = self.fixture(root)
            before = {str(p): p.read_bytes() for p in root.rglob("*") if p.is_file()}
            report = audit.audit(database, results, 0, 100)
            self.assertEqual(report["rows"][0]["status"], "audited")
            self.assertEqual(report["rows"][0]["ledger_comparison"], "equal")
            self.assertEqual(report["rows"][0]["reservation_state"], "settled")
            self.assertEqual(before, {str(p): p.read_bytes() for p in root.rglob("*") if p.is_file()})
            self.assertNotIn(NONCE, json.dumps(report))
            self.assertFalse(report["unknown_release_allowed"])

    def test_missing_inflight_truncated_selection_and_ambiguous_ledger(self):
        with tempfile.TemporaryDirectory() as directory:
            database, results = self.fixture(Path(directory))
            with sqlite3.connect(database) as db:
                db.execute("INSERT INTO task_run_costs VALUES(8,'wtest','session-other',47)")
                db.execute("INSERT INTO workers VALUES('wsecond',8,124,'/fixture','session-other',150,NULL,'running',149)")
            report = audit.audit(database, results, 0, 1)
            self.assertTrue(report["selection_truncated"])
            self.assertEqual(report["workers_in_window"], 2)
            self.assertEqual(report["rows"][0]["ledger_comparison"], "missing_or_ambiguous_binding")
            (results / "wtest" / "worker-requests.jsonl").unlink()
            report = audit.audit(database, results, 0, 100)
            self.assertEqual([r["status"] for r in report["rows"]], ["unavailable", "in_flight"])

    def test_symlink_and_world_readable_control_file_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            database, results = self.fixture(Path(directory))
            target = results / "wtest" / "worker-budget.json"
            target.chmod(0o644)
            report = audit.audit(database, results, 0, 100)
            self.assertEqual(report["rows"][0]["reason"], "source_permissions")
            target.unlink()
            target.symlink_to(results / "wtest" / "worker-session.json")
            report = audit.audit(database, results, 0, 100)
            self.assertEqual(report["rows"][0]["status"], "unavailable")

    def test_session_ownership_conflict_outside_selected_window_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            database, results = self.fixture(Path(directory))
            with sqlite3.connect(database) as db:
                db.execute("INSERT INTO task_cost_watch VALUES(99,'wolder','session-test')")
            report = audit.audit(database, results, 100, 100)
            self.assertEqual(report["rows"][0]["reason"], "session_run_ownership_ambiguous")
            self.assertEqual(report["observed_tokens_lower_bound"], 0)

    def test_higher_ledger_is_retained_and_lower_ledger_is_flagged(self):
        with tempfile.TemporaryDirectory() as directory:
            database, results = self.fixture(Path(directory))
            for amount, expected in [(100, "higher_than_journal"), (10, "below_observed_usage")]:
                with sqlite3.connect(database) as db:
                    db.execute("UPDATE task_run_costs SET spent_tokens=?", (amount,))
                report = audit.audit(database, results, 0, 100)
                self.assertEqual(report["rows"][0]["ledger_comparison"], expected)
                with sqlite3.connect(database) as db:
                    self.assertEqual(db.execute("SELECT spent_tokens FROM task_run_costs").fetchone()[0], amount)


if __name__ == "__main__":
    unittest.main()
