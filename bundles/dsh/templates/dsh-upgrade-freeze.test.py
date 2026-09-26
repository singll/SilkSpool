#!/usr/bin/env python3
"""冻结失败必须恢复原写者，且不能唤醒原先 inactive 的任务。"""
import importlib.util
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location("freeze", Path(__file__).with_name("dsh-upgrade-freeze.py"))
freeze = importlib.util.module_from_spec(spec)
spec.loader.exec_module(freeze)


class FreezeTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="freeze-test-")
        self.addCleanup(temp.cleanup)
        self.work = Path(temp.name)
        source = self.work / "dsh"
        source.mkdir()
        (source / "data/sessions").mkdir(parents=True)
        self.lock = source / "data/scheduler.lock"
        self.lock.write_text('{"pid":12345,"ts":1}')
        self.lock_before = self.lock.read_bytes()
        module = source / freeze.DEFAULT_SCHEDULER_MODULE
        module.parent.mkdir(parents=True)
        module.write_text("verified scheduler fixture")
        self.db = source / "data/domain.sqlite"
        with sqlite3.connect(self.db) as db:
            db.execute("CREATE TABLE workers (status TEXT)")
            db.execute("CREATE TABLE tasks (status TEXT)")
        self.config = {"roots": [{"name": "dsh", "path": str(source)}], "idle_database": str(self.db),
                       "quiet_units": ["silksecagent.service", "silksecagent-edge.service", "silksec-backup.timer", "silksec-backup.service"],
                       "cron_users": ["fixture"], "scheduler_sha256": hashlib.sha256(module.read_bytes()).hexdigest()}
        self.states = {u: "inactive" if u == "silksec-backup.service" else "active" for u in self.config["quiet_units"]}
        self.cron = "*/30 * * * * /opt/silkspool/dsh/build.sh\n0 0 * * * unrelated-job\n"
        self.original_cron = self.cron
        self.actions = []
        self.freezer = "running"
        self.on_freeze = lambda: None

    def systemctl(self, *args):
        if args[0] == "show":
            if "--value" in args:
                if "FreezerState" in args:
                    return self.freezer + "\n"
                return self.states[args[1]] + "\n"
            return f"LoadState=loaded\nActiveState={self.states[args[1]]}\nFragmentPath=/dev/null\nDropInPaths=\n"
        self.actions.append(args)
        if args[0] == "freeze":
            self.on_freeze()
            self.freezer = "frozen"
            return ""
        if args[0] == "thaw":
            self.freezer = "running"
            return ""
        if args[0] == "stop" and "silksecagent.service" in args and self.freezer == "running":
            self.on_freeze()
        for unit in args[1:]:
            self.states[unit] = "inactive" if args[0] == "stop" else "active"
        return ""

    def set_cron(self, user, text):
        self.cron = text

    def run_capture(self, failure):
        class IdleClient:
            def __enter__(self): return self
            def __exit__(self, *_): pass
            def assert_idle(self): return {"sessions": 2, "running": 0}
            def close(self): pass
        client = IdleClient()
        with mock.patch.object(freeze, "systemctl", self.systemctl), mock.patch.object(freeze, "crontab", lambda _: self.cron), \
                mock.patch.object(freeze, "set_crontab", self.set_cron), mock.patch.object(freeze.shutil, "copy2"), \
                mock.patch.object(freeze, "MaintenanceClient", return_value=client, create=True), \
                mock.patch.object(freeze.snapshot, "capture", side_effect=failure):
            return freeze.capture(self.config, self.work)

    def test_backup_failure_restores_original_services_and_cron(self):
        with self.assertRaisesRegex(RuntimeError, "disk full"):
            self.run_capture(RuntimeError("disk full"))
        self.assertEqual(self.cron, self.original_cron)
        self.assertEqual(self.states["silksecagent.service"], "active")
        self.assertEqual(self.states["silksecagent-edge.service"], "active")
        self.assertEqual(self.states["silksec-backup.timer"], "active")
        self.assertEqual(self.states["silksec-backup.service"], "inactive")
        self.assertTrue(list(self.work.glob("dsh-freeze-*/state.json")))
        self.assertEqual(self.lock.read_bytes(), self.lock_before)

    def test_active_worker_refuses_before_any_mutation(self):
        with sqlite3.connect(self.db) as db:
            db.execute("INSERT INTO workers VALUES ('running')")
        with self.assertRaisesRegex(RuntimeError, "仍有 1 项"):
            self.run_capture(RuntimeError("must not reach backup"))
        self.assertEqual(self.actions, [])
        self.assertEqual(self.cron, self.original_cron)

    def test_worker_started_after_idle_check_is_not_terminated(self):
        def new_worker():
            with sqlite3.connect(self.db) as db:
                db.execute("INSERT INTO workers VALUES ('running')")
        self.on_freeze = new_worker
        with self.assertRaisesRegex(RuntimeError, "workers 仍有 1 项"):
            self.run_capture(RuntimeError("must not reach backup"))
        self.assertFalse(any(action[0] == "stop" and "silksecagent.service" in action for action in self.actions))
        self.assertEqual(self.freezer, "running")
        self.assertEqual(self.lock.read_bytes(), self.lock_before)

    def test_native_session_changed_after_query_is_not_terminated(self):
        self.on_freeze = lambda: (self.db.parent / "sessions/new-session.jsonl").write_text("new accepted turn")
        with self.assertRaisesRegex(RuntimeError, "冻结验证发现 Session"):
            self.run_capture(RuntimeError("must not reach backup"))
        self.assertFalse(any(action[0] == "stop" and "silksecagent.service" in action for action in self.actions))
        self.assertEqual(self.freezer, "running")

    def test_unknown_scheduler_fails_before_pause(self):
        self.config["scheduler_sha256"] = "0" * 64
        with self.assertRaisesRegex(RuntimeError, "调度器代码"):
            self.run_capture(RuntimeError("must not reach backup"))
        self.assertEqual(self.lock.read_bytes(), self.lock_before)
        self.assertFalse(any(action[0] == "stop" for action in self.actions))

    def test_scheduler_module_path_is_configurable(self):
        alt = self.work / "dsh/plugins/alt-scheduler/index.js"
        alt.parent.mkdir(parents=True)
        alt.write_text("alternate scheduler fixture")
        self.config["scheduler_module"] = "plugins/alt-scheduler/index.js"
        self.config["scheduler_sha256"] = hashlib.sha256(alt.read_bytes()).hexdigest()
        self.assertEqual(freeze.scheduler_module(self.work / "dsh", self.config["scheduler_module"]), alt)
        self.assertEqual(freeze.scheduler_module(self.work / "dsh"), self.work / "dsh" / freeze.DEFAULT_SCHEDULER_MODULE)
        state_dir = self.work / "alt-pause"
        state_dir.mkdir()
        with mock.patch.object(freeze, "save"), mock.patch.object(freeze.local_client, "atomic_bytes"):
            freeze.pause_scheduler(self.config, state_dir, {})

    def test_illegal_scheduler_module_path_is_refused(self):
        for relative in ("/abs/scheduler.js", "../escape/scheduler.js"):
            with self.assertRaisesRegex(ValueError, "非法调度器模块路径"):
                freeze.scheduler_module(self.work / "dsh", relative)

    def test_failed_main_restart_keeps_external_writers_and_cron_paused(self):
        state_dir = self.work / "resume-failure"
        state_dir.mkdir()
        state = {"units": {unit: {"ActiveState": value} for unit, value in self.states.items()},
                 "crons": {"fixture": {"before": self.original_cron, "paused": "# paused\n"}}}
        freeze.save(state_dir / "state.json", state)
        self.cron = "# paused\n"
        def fail_main(*args):
            if args == ("start", "silksecagent.service"):
                self.actions.append(args)
                raise RuntimeError("main start failed")
            return self.systemctl(*args)
        with mock.patch.object(freeze, "systemctl", fail_main), mock.patch.object(freeze, "crontab", lambda _: self.cron), \
                mock.patch.object(freeze, "set_crontab", self.set_cron):
            with self.assertRaisesRegex(RuntimeError, "main start failed"):
                freeze.resume(state_dir)
        self.assertEqual(self.actions, [("start", "silksecagent.service")])
        self.assertEqual(self.cron, "# paused\n")
        self.assertNotIn("resumed_at", json.loads((state_dir / "state.json").read_text()))

    @unittest.skipUnless(os.geteuid() == 0, "root-only lock must be tested as the production freeze identity")
    def test_old_unprivileged_heartbeat_cannot_replace_pause(self):
        import subprocess
        self.work.chmod(0o755)
        state_dir = self.work / "pause"
        state_dir.mkdir()
        state = {}
        freeze.pause_scheduler(self.config, state_dir, state)
        result = subprocess.run(["python3", "-c", "import sys; open(sys.argv[1], 'w').write('old tick heartbeat')", str(self.lock)],
                                user=65534, group=65534, extra_groups=[], capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        freeze.assert_scheduler_paused(state)
        freeze.restore_scheduler(state_dir, state)
        self.assertEqual(self.lock.read_bytes(), self.lock_before)


if __name__ == "__main__":
    unittest.main()
