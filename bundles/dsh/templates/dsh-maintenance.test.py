import importlib.util
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('maintenance',Path(__file__).with_name('dsh-maintenance.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

class MaintenanceTest(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name); self.base=self.root/'dsh';self.base.mkdir();(self.base/'data').mkdir()
        self.nas=self.root/'nas';self.nas.mkdir();self.key=self.root/'password';self.key.write_text('test-only-password');self.key.chmod(0o600)
        cfg={'base':str(self.base),'state':str(self.root/'state'),'repository':str(self.nas/'repo'),'mount':str(self.nas),
             'mount_source':'test:/backup','password_file':str(self.key),'min_free_bytes':1,'keep_last':2}
        self.manager=m.Maintenance(cfg)
        self.db=self.base/'data/asset-graph.db'
        self.c=sqlite3.connect(self.db);self.c.execute('PRAGMA journal_mode=WAL');self.c.execute('CREATE TABLE facts(value)');self.c.execute('INSERT INTO facts VALUES(1)');self.c.commit();self.addCleanup(self.c.close)

    def test_mount_loss_fails_before_local_repository_write(self):
        with self.assertRaises(Exception):self.manager.backup()
        self.assertFalse((self.nas/'repo').exists())

    def test_wal_and_unknown_extensions_are_backed_up(self):
        dbs=self.manager.database_images();self.assertEqual(len(dbs),1)
        with sqlite3.connect(dbs[0]['image']) as c:self.assertEqual(c.execute('SELECT value FROM facts').fetchone()[0],1)
        self.assertEqual(self.c.execute('SELECT value FROM facts').fetchone()[0],1)

    def test_cleanup_keeps_evidence_and_two_valid_backups(self):
        backups=self.base/'data/backups';backups.mkdir()
        for i in range(4):
            with sqlite3.connect(backups/f'asset-graph.{i}.db') as c:self.c.backup(c)
        evidence=self.base/'data/results/old-run';evidence.mkdir(parents=True);(evidence/'proof').write_text('keep')
        self.assertEqual(len(self.manager.cleanup()['files']),2)
        self.manager.cleanup(True)
        self.assertEqual(len(list(backups.glob('*.db'))),2);self.assertTrue((evidence/'proof').exists())

    def test_status_reports_unreachable_nas_without_traceback(self):
        with patch.object(self.manager,'restic',side_effect=subprocess.TimeoutExpired('restic',45)):
            result=self.manager.status()
        self.assertFalse(result['nas_ready'])
        self.assertTrue(result['backup_stale'])

    def test_cleanup_refuses_external_log_directory(self):
        external=self.root/'outside';external.mkdir()
        (external/'audit.jsonl').write_text('keep')
        (self.base/'data/events').symlink_to(external)
        with self.assertRaisesRegex(RuntimeError,'escapes'):
            self.manager.cleanup(True)
        self.assertEqual((external/'audit.jsonl').read_text(),'keep')

    def test_latest_release_and_held_freeze_cannot_be_retired(self):
        upgrade=self.base.parent/'dsh-upgrades';upgrade.mkdir()
        old=upgrade/'20260101-old';old.mkdir()
        latest=upgrade/'20260201-new';latest.mkdir()
        with self.assertRaisesRegex(RuntimeError,'latest release'):
            self.manager.archive_release(latest,True)
        hold=old/'dsh-freeze-test';hold.mkdir();(hold/'state.json').write_text('{"hold":true}')
        with self.assertRaisesRegex(RuntimeError,'held freeze'):
            self.manager.archive_release(old,True)
        self.assertTrue(old.exists());self.assertTrue(latest.exists())

    @unittest.skipUnless(shutil.which('restic'),'real restic binary required')
    def test_real_repository_dedup_restore_and_retention(self):
        workspace=self.root/'workspace';workspace.mkdir()
        (workspace/'proof.txt').write_text('workspace evidence')
        with sqlite3.connect(workspace/'notes.sqlite') as db:
            db.execute('CREATE TABLE notes(body)')
            db.execute("INSERT INTO notes VALUES ('keep')")
        runtime=workspace/'browser-runtime';runtime.mkdir()
        locked=sqlite3.connect(runtime/'cache.db')
        self.addCleanup(locked.close)
        locked.execute('CREATE TABLE cache(value)');locked.commit()
        locked.execute('BEGIN EXCLUSIVE')
        self.manager=m.Maintenance({**self.manager.cfg,'extra_roots':[str(workspace)],'exclude_paths':[str(runtime)]})
        with patch.object(self.manager,'mounted'):
            self.db.chmod(0o640)
            self.manager.restic(['init'])
            first=self.manager.backup();self.manager.drill()
            second=self.manager.backup();third=self.manager.backup()
            snapshots=json.loads(self.manager.restic(['snapshots','--json']))
            self.assertEqual(len(snapshots),2)
            self.assertLess(second['data_added'], first['data_added'])
            self.assertEqual(self.manager.drill(third['snapshot_id'])['databases'],2)
            self.assertFalse(list(self.manager.state.glob('drill-*')))
            target=self.root/'restored'
            restored=self.manager.restore_copy(third['snapshot_id'],target)
            self.assertFalse(restored['safe_to_start'])
            self.assertEqual((target/str(self.db).lstrip('/')).stat().st_mode & 0o777,0o640)
            self.assertEqual((target/str(workspace).lstrip('/')/'proof.txt').read_text(),'workspace evidence')
            self.assertFalse((target/str(runtime).lstrip('/')).exists())
            with sqlite3.connect(target/str(workspace).lstrip('/')/'notes.sqlite') as db:
                self.assertEqual(db.execute('SELECT body FROM notes').fetchone()[0],'keep')
            with sqlite3.connect(target/str(self.db).lstrip('/')) as c:
                self.assertEqual(c.execute('SELECT value FROM facts').fetchone()[0],1)
            with self.assertRaises(ValueError):self.manager.restore_copy(third['snapshot_id'],target)
            self.assertEqual(self.c.execute('SELECT value FROM facts').fetchone()[0],1)

if __name__=='__main__':unittest.main()
