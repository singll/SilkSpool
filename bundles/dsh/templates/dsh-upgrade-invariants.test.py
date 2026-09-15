#!/usr/bin/env python3
"""用真实 SQLite 迁移验证业务不变量门禁，防止新增列例外掩盖旧表损坏。"""
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("invariants", Path(__file__).with_name("dsh-upgrade-invariants.py"))
invariants = importlib.util.module_from_spec(spec)
spec.loader.exec_module(invariants)


class InvariantTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="dsh-invariants-test-")
        self.addCleanup(directory.cleanup)
        self.database = Path(directory.name) / "asset.db"
        self.execute("""
            CREATE TABLE workers (run_id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'running');
            INSERT INTO workers VALUES ('original-run', 'done');
            CREATE TABLE bus_meta (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER);
            INSERT INTO bus_meta VALUES ('seen.task.version', '1', 1);
            INSERT INTO bus_meta VALUES ('other-key', 'retained', 1);
        """)
        self.before = self.capture()

    def execute(self, sql):
        with sqlite3.connect(self.database) as db:
            db.executescript(sql)

    def capture(self, baseline=None):
        return {"schema": invariants.SCHEMA, "source_manifest_sha256": "fixture", "files": {}, "databases": {
            "dsh/data/asset.db": invariants.database_snapshot(self.database,
                baseline["databases"]["dsh/data/asset.db"] if baseline else None)}}

    def comparison(self):
        return invariants.compare(self.before, self.capture(self.before))

    def test_nullable_child_session_column_preserves_all_business_rows(self):
        self.execute("ALTER TABLE workers ADD COLUMN worker_session_id TEXT;")
        result = self.comparison()
        self.assertTrue(result["ok"], result)
        self.assertIn("nullable-worker-session-id-column", result["expected_changes"])

    def test_worker_column_exception_does_not_hide_changed_existing_constraint(self):
        self.execute("""
            ALTER TABLE workers RENAME TO saved_workers;
            CREATE TABLE workers (run_id TEXT PRIMARY KEY, status TEXT DEFAULT 'running', worker_session_id TEXT);
            INSERT INTO workers(run_id, status) SELECT run_id, status FROM saved_workers;
            DROP TABLE saved_workers;
        """)
        self.assertFalse(self.comparison()["ok"])

    def test_worker_column_must_have_the_exact_approved_type(self):
        self.execute("ALTER TABLE workers ADD COLUMN worker_session_id INTEGER;")
        self.assertFalse(self.comparison()["ok"])

    def test_equal_counts_and_keys_cannot_hide_changed_status(self):
        self.execute("UPDATE workers SET status='failed';")
        self.assertFalse(self.comparison()["ok"])

    def test_new_column_may_not_invent_historical_attribution(self):
        self.execute("ALTER TABLE workers ADD COLUMN worker_session_id TEXT; UPDATE workers SET worker_session_id='invented';")
        self.assertFalse(self.comparison()["ok"])

    def test_startup_timestamp_exception_is_limited_to_domain_version_observation(self):
        self.execute("UPDATE bus_meta SET updated_at=2 WHERE key='seen.task.version';")
        self.assertTrue(self.comparison()["ok"])
        self.execute("UPDATE bus_meta SET updated_at=2 WHERE key='other-key';")
        self.assertFalse(self.comparison()["ok"])

    def test_wrong_source_manifest_cannot_be_compared(self):
        after = self.capture(self.before)
        after["source_manifest_sha256"] = "different-freeze-point"
        self.assertFalse(invariants.compare(self.before, after)["ok"])

    def test_evidence_removal_and_replacement_are_not_ignored(self):
        before = {**self.before, "files": {"dsh/data/results": {"evidence": {"kind": "file", "sha256": "original"}}}}
        for files in ({}, {"evidence": {"kind": "file", "sha256": "changed"}}):
            after = {**self.before, "files": {"dsh/data/results": files}}
            self.assertFalse(invariants.compare(before, after)["ok"])


class StartupInvariantTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="dsh-startup-invariants-")
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.data = self.root / "dsh/data"
        (self.data / "events").mkdir(parents=True)
        self.database = self.data / "asset.db"
        self.log = self.data / "events/bus.jsonl"
        self.manifest = self.root / "manifest.json"
        self.manifest.write_text(json.dumps({"config": {"roots": [{"name": "dsh"}],
            "sqlite": [{"root": "dsh", "path": "data/asset.db"}]}}))
        (self.data / "scope.yml").write_text('programs:\n  - name: test-src\n    platform: "platform-value"\n')
        with sqlite3.connect(self.database) as db:
            db.executescript('''
                CREATE TABLE programs(id TEXT PRIMARY KEY,platform TEXT,status TEXT,workspace_id TEXT,updated_at INTEGER);
                INSERT INTO programs VALUES ('test-src','"platform-value"','active','original-workspace',1);
                CREATE TABLE event_outbox(event_id TEXT PRIMARY KEY,domain TEXT,name TEXT,payload TEXT,
                  producer_ts INTEGER,status TEXT,retry_count INTEGER,next_retry_at INTEGER,last_error TEXT,created_at INTEGER);
                CREATE TABLE exp_cards(id INTEGER PRIMARY KEY,scenario TEXT,takeaway TEXT,chain TEXT);
                CREATE VIRTUAL TABLE exp_fts USING fts5(scenario,takeaway,chain,content='exp_cards',content_rowid='id');
                INSERT INTO exp_cards VALUES (1,'scenario','originalword','[]');
                INSERT INTO exp_fts(exp_fts) VALUES ('rebuild');
            ''')
        self.append_registration(1)
        self.before = self.capture()

    def append_registration(self, stamp, *, actor="system", log=True):
        event = {"id": "evt-" + str(stamp), "domain": "bus", "name": "bus.domain.registered", "ts": stamp,
            "actor": actor, "session_id": None, "cause": {"cmd": "bus.internal", "idempotency_key": None},
            "payload": {"domain": "bus", "version": 1, "backend": "sqlite-local", "commands": 2, "queries": 3}}
        with sqlite3.connect(self.database) as db:
            db.execute("INSERT INTO event_outbox VALUES (?,?,?,?,?,'delivered',0,NULL,NULL,?)",
                (event["id"], "bus", event["name"], json.dumps(event), stamp, stamp))
        if log:
            with self.log.open("a") as output:
                output.write(json.dumps(event) + "\n")

    def capture(self, baseline=None):
        return invariants.capture(self.root, self.manifest, baseline)

    def comparison(self):
        return invariants.compare(self.before, self.capture(self.before))

    def test_startup_registration_requires_unchanged_originals_and_matching_log(self):
        self.append_registration(2)
        self.assertTrue(self.comparison()["ok"], self.comparison())
        with sqlite3.connect(self.database) as db:
            db.execute("UPDATE event_outbox SET status='pending' WHERE event_id='evt-1'")
        self.assertFalse(self.comparison()["ok"])

    def test_registration_cannot_hide_wrong_actor_or_missing_log(self):
        self.append_registration(2, actor="model", log=False)
        self.assertFalse(self.comparison()["ok"])

    def test_log_requires_original_prefix_and_no_duplicate_events(self):
        self.append_registration(2)
        original = self.log.read_text()
        self.log.write_text(original.splitlines()[1] + "\n" + original.splitlines()[0] + "\n")
        self.assertFalse(self.comparison()["ok"])
        self.log.write_text(original + original.splitlines()[1] + "\n")
        self.assertFalse(self.comparison()["ok"])

    def test_program_mirror_may_only_remove_known_source_quotes_and_refresh_time(self):
        with sqlite3.connect(self.database) as db:
            db.execute("UPDATE programs SET platform='platform-value', updated_at=2")
        self.assertTrue(self.comparison()["ok"], self.comparison())
        with sqlite3.connect(self.database) as db:
            db.execute("UPDATE programs SET workspace_id='wrong-workspace'")
        self.assertFalse(self.comparison()["ok"])

    def test_mirror_cannot_add_quotes_or_change_canonical_platform(self):
        with sqlite3.connect(self.database) as db:
            db.execute("UPDATE programs SET platform='platform-value'")
        self.before = self.capture()
        with sqlite3.connect(self.database) as db:
            db.execute('UPDATE programs SET platform=?', ('"platform-value"',))
        self.assertFalse(self.comparison()["ok"])

    def test_fts_rebuild_preserves_content_and_restores_external_content_integrity(self):
        with sqlite3.connect(self.database) as db:
            # 原写入顺序的真实失配：主表先改，FTS 再取到的是新词，旧词留在索引。
            db.execute("UPDATE exp_cards SET takeaway='changedword' WHERE id=1")
            db.execute("UPDATE exp_fts SET takeaway='changedword' WHERE rowid=1")
        self.before = self.capture()
        self.assertFalse(self.comparison()["ok"], "索引与原文不一致时不得放行")
        repair = invariants.repair_indexes(self.database)
        self.assertEqual(repair["rebuilt"], ["exp_fts"])
        self.assertTrue(repair["business_rows_unchanged"])
        self.assertTrue(self.comparison()["ok"], self.comparison())
        with sqlite3.connect(self.database) as db:
            self.assertEqual(db.execute("SELECT rowid FROM exp_fts WHERE exp_fts MATCH 'originalword'").fetchall(), [])
            self.assertEqual(db.execute("SELECT rowid FROM exp_fts WHERE exp_fts MATCH 'changedword'").fetchall(), [(1,)])

    def test_physical_index_exception_cannot_hide_changed_rowid_or_content(self):
        with sqlite3.connect(self.database) as db:
            db.execute("UPDATE exp_cards SET id=2")
            db.execute("INSERT INTO exp_fts(exp_fts) VALUES ('rebuild')")
        self.assertFalse(self.comparison()["ok"])


if __name__ == "__main__":
    unittest.main()
