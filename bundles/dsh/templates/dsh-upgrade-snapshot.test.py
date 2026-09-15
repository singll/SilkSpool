#!/usr/bin/env python3
"""真实文件树/WAL 的恢复回归；不访问 systemd 或生产路径。"""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sqlite3
import tempfile
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location("snapshot", Path(__file__).with_name("dsh-upgrade-snapshot.py"))
snapshot = importlib.util.module_from_spec(spec)
spec.loader.exec_module(snapshot)


class RecoveryPointTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="snapshot-test-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.source = self.root / "production"
        self.source.mkdir()
        self.work = self.root / "backups"
        self.work.mkdir()
        self.config = {"roots": [{"name": "dsh", "path": str(self.source)}], "sqlite": []}

    def capture(self):
        return snapshot.capture(self.config, self.work, guard=lambda _: {"fixture": True})

    def test_preserves_wal_evidence_metadata_and_links(self):
        evidence = self.source / "evidence.bin"
        evidence.write_bytes(bytes(range(256)))
        evidence.chmod(0o640)
        os.utime(evidence, ns=(1000000000, 2000000000))
        os.link(evidence, self.source / "same-evidence.bin")
        (self.source / "evidence-link").symlink_to(str(evidence))
        database = self.source / "domain.sqlite"
        db = sqlite3.connect(database)
        self.addCleanup(db.close)
        db.execute("PRAGMA journal_mode=WAL")
        db.execute("PRAGMA wal_autocheckpoint=0")
        db.execute("CREATE TABLE evidence (id INTEGER PRIMARY KEY, body TEXT)")
        db.execute("INSERT INTO evidence VALUES (1, 'committed only in WAL')")
        db.commit()
        self.assertTrue(Path(str(database) + "-wal").is_file())
        self.config["sqlite"] = [{"root": "dsh", "path": "domain.sqlite"}]
        before = snapshot.tree_manifest(self.source)
        ready = self.capture()
        manifest = snapshot.verify(ready)
        self.assertEqual(snapshot.tree_manifest(self.source), before)
        self.assertEqual(manifest["sqlite"][0]["table_counts"], {"evidence": 1})
        restored = snapshot.restore_copy(ready, self.work)
        self.assertEqual(snapshot.tree_manifest(restored / "dsh"), before)
        self.assertEqual(os.stat(restored / "dsh/evidence.bin").st_ino,
                         os.stat(restored / "dsh/same-evidence.bin").st_ino)
        with sqlite3.connect(restored / "dsh/domain.sqlite") as reader:
            self.assertEqual(reader.execute("SELECT body FROM evidence").fetchone(),
                             ("committed only in WAL",))
        self.assertFalse(json.loads((restored / "restore-report.json").read_text())["safe_to_start"])

    def test_restore_when_original_host_tree_is_missing(self):
        (self.source / "package-lock").write_text("frozen dependencies")
        ready = self.capture()
        shutil.rmtree(self.source)
        restored = snapshot.restore_copy(ready, self.work)
        self.assertEqual((restored / "dsh/package-lock").read_text(), "frozen dependencies")

    def test_refuses_corrupt_evidence_and_does_not_publish_restore(self):
        (self.source / "evidence").write_text("proof")
        ready = self.capture()
        (ready / "trees/dsh/evidence").write_text("lost")
        with self.assertRaisesRegex(RuntimeError, "树校验失败"):
            snapshot.restore_copy(ready, self.work)
        self.assertEqual(list(self.work.glob("dsh-restore-copy-*")), [])

    def test_refuses_source_change_during_capture(self):
        evidence = self.source / "evidence"
        evidence.write_text("original")
        original_copy = snapshot.copy_tree

        def changing_copy(source, target):
            original_copy(source, target)
            evidence.write_text("concurrent writer")

        with mock.patch.object(snapshot, "copy_tree", changing_copy):
            with self.assertRaisesRegex(RuntimeError, "清单不一致"):
                self.capture()
        self.assertEqual(list(self.work.glob("dsh-snapshot-ready-*")), [])
        self.assertEqual(len(list(self.work.glob("dsh-snapshot-pending-*/failure.json"))), 1)

    def test_refuses_sqlite_manifest_omission(self):
        db = sqlite3.connect(self.source / "domain.sqlite")
        db.execute("CREATE TABLE tasks (id INTEGER)")
        db.commit()
        db.close()
        self.config["sqlite"] = [{"root": "dsh", "path": "domain.sqlite"}]
        ready = self.capture()
        manifest_file = ready / "manifest.json"
        manifest = json.loads(manifest_file.read_text())
        manifest["sqlite"] = []
        manifest_file.write_text(json.dumps(manifest))
        (ready / "manifest.sha256").write_text(snapshot.sha256(manifest_file) + "\n")
        with self.assertRaisesRegex(RuntimeError, "SQLite.*清单"):
            snapshot.verify(ready)


if __name__ == "__main__":
    unittest.main()
