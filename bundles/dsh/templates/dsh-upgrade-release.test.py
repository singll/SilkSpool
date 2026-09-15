#!/usr/bin/env python3
"""用真实 Linux 目录交换复现掉电边界、部分切换与整树回滚。"""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location("release", Path(__file__).with_name("dsh-upgrade-release.py"))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="dsh-release-tests-")
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.state = {"phase": "switching", "restore_copy": str(self.root / "current"), "roots": {}}
        manifests = {"next": {}, "rollback": {}}
        for name in ("dsh", "workspace"):
            for side, value in (("current", "original"), ("next", "rc.2"), ("rollback", "legacy-recovered")):
                target = self.root / side / name
                target.mkdir(parents=True)
                (target / "value").write_text(value)
                (target / "link").symlink_to("value")
                if side in manifests:
                    manifests[side][name] = release.item_manifest(target)
            self.state["roots"][name] = {side: str(self.root / side / name) for side in ("current", "next", "rollback")}
            self.state["roots"][name].update({label: release.identity(self.root / side / name)
                for label, side in (("before_id", "current"), ("next_id", "next"), ("rollback_id", "rollback"))})
        release.freeze.save(self.root / "prepared-manifests.json", manifests)
        self.state["prepared_manifests_sha256"] = release.snapshot.sha256(self.root / "prepared-manifests.json")
        release.freeze.save(self.root / "state.json", self.state)
        self.hold = mock.patch.object(release, "assert_held")
        self.hold.start()
        self.addCleanup(self.hold.stop)

    def values(self, side):
        return [(self.root / side / name / "value").read_text() for name in self.state["roots"]]

    def test_exchange_preserves_originals_symlinks_and_rollback(self):
        release.switch(self.root)
        self.assertEqual(self.values("current"), ["rc.2", "rc.2"])
        self.assertEqual(self.values("next"), ["original", "original"])
        self.assertTrue((self.root / "current/dsh/link").is_symlink())
        (self.root / "current/dsh/new-session-v3").write_text("new state retained")
        release.rollback(self.root)
        self.assertEqual(self.values("current"), ["legacy-recovered", "legacy-recovered"])
        self.assertEqual(self.values("rollback"), ["rc.2", "rc.2"])
        self.assertEqual((self.root / "rollback/dsh/new-session-v3").read_text(), "new state retained")
        release.rollback(self.root)

    def test_resume_after_exchange_before_journal_save(self):
        original = release.freeze.save
        def crash(filename, state):
            if state.get("roots", {}).get("dsh", {}).get("switched"):
                raise RuntimeError("simulated power loss")
            return original(filename, state)
        with mock.patch.object(release.freeze, "save", crash):
            with self.assertRaisesRegex(RuntimeError, "power loss"):
                release.switch(self.root)
        self.assertEqual(self.values("current"), ["rc.2", "original"])
        release.switch(self.root)
        self.assertEqual(self.values("current"), ["rc.2", "rc.2"])
        self.assertEqual(self.values("next"), ["original", "original"])

    def test_partial_switch_can_rollback_without_finishing_switch(self):
        row = self.state["roots"]["dsh"]
        release.exchange(row["current"], row["next"])
        release.rollback(self.root)
        self.assertEqual(self.values("current"), ["legacy-recovered", "legacy-recovered"])
        self.assertEqual(self.values("rollback"), ["rc.2", "original"])

    def test_partial_rollback_resumes_after_exchange_before_journal(self):
        release.switch(self.root)
        state = release.read_json(self.root / "state.json")
        state["phase"] = "rolling-back"
        release.freeze.save(self.root / "state.json", state)
        row = state["roots"]["dsh"]
        release.exchange(row["current"], row["rollback"])
        release.rollback(self.root)
        self.assertEqual(self.values("current"), ["legacy-recovered", "legacy-recovered"])

    def test_modified_rollback_refused_before_mutation(self):
        release.switch(self.root)
        (self.root / "rollback/workspace/value").write_text("tampered")
        with self.assertRaisesRegex(RuntimeError, "回滚树已改变"):
            release.rollback(self.root)
        self.assertEqual(self.values("current"), ["rc.2", "rc.2"])

    def test_modified_candidate_refused_before_exchange(self):
        (self.root / "next/dsh/value").write_text("tampered")
        with self.assertRaisesRegex(RuntimeError, "新树已改变"):
            release.switch(self.root)
        self.assertEqual(self.values("current"), ["original", "original"])

    def test_symlink_root_refused(self):
        link = self.root / "root-link"
        link.symlink_to(self.root / "current/dsh")
        with self.assertRaisesRegex(RuntimeError, "真实目录"):
            release.exchange(link, self.root / "next/dsh")
        self.assertEqual(self.values("current"), ["original", "original"])

    def test_production_requires_held_state(self):
        self.hold.stop()
        with self.assertRaisesRegex(RuntimeError, "持有中的"):
            release.assert_held({"restore_copy": None}, None)

    def test_observing_cannot_silently_discard_new_business_state(self):
        state = release.read_json(self.root / "state.json")
        state["phase"] = "observing"
        release.freeze.save(self.root / "state.json", state)
        with self.assertRaisesRegex(RuntimeError, "尚未恢复业务写者"):
            release.rollback(self.root)
        self.assertEqual(self.values("current"), ["original", "original"])

    def test_recovery_paths_are_relative_to_declared_session_root(self):
        report = self.root / "recovery.json"
        for relative in ("data/sessions", "sessions"):
            report.write_text(json.dumps({"source": "/canonical/dsh/" + relative}))
            self.assertEqual(release.recovery_subdir(report, "/canonical/dsh"), Path(relative))
        for source in ("/other/dsh/data/sessions", "/canonical/dsh/plugins", "data/sessions"):
            report.write_text(json.dumps({"source": source}))
            with self.assertRaises(RuntimeError):
                release.recovery_subdir(report, "/canonical/dsh")

    def prepare_finalization(self):
        release.switch(self.root)
        state = release.read_json(self.root / "state.json")
        state.update(restore_copy=None, freeze_state="held-fixture")
        release.freeze.save(self.root / "state.json", state)
        release.freeze.save(self.root / "maintenance-switched-report.json", {
            "ok": True, "started_at": "current-attempt", "checks": {"version": release.VERSION}})
        release.freeze.save(self.root / "maintenance-state.json", {"started_at": "current-attempt", "cleaned_at": "finished"})
        proof = self.root / "invariants.json"
        proof.write_text('{"ok":true}')
        return {"report": str(proof), "sha256": release.snapshot.sha256(proof)}

    def test_resume_failure_records_write_window_before_starting_any_writer(self):
        proof = self.prepare_finalization()
        with mock.patch.object(release, "pre_resume_invariants", return_value=proof), \
                mock.patch.object(release.freeze, "resume", side_effect=RuntimeError("interrupted resume")):
            with self.assertRaisesRegex(RuntimeError, "interrupted resume"):
                release.finalize(self.root)
        self.assertEqual(release.read_json(self.root / "state.json")["phase"], "resuming")
        with self.assertRaisesRegex(RuntimeError, "尚未恢复业务写者"):
            release.rollback(self.root)
        with mock.patch.object(release.freeze, "resume"):
            release.finalize(self.root)
        state = release.read_json(self.root / "state.json")
        self.assertEqual(state["phase"], "observing")
        self.assertEqual(release.datetime.fromisoformat(state["observation_until"]) - release.datetime.fromisoformat(state["observing_at"]), release.timedelta(hours=72))

    def test_failed_invariants_do_not_resume_or_change_release_phase(self):
        self.prepare_finalization()
        with mock.patch.object(release, "pre_resume_invariants", side_effect=RuntimeError("business changed")), \
                mock.patch.object(release.freeze, "resume") as resume:
            with self.assertRaisesRegex(RuntimeError, "business changed"):
                release.finalize(self.root)
            resume.assert_not_called()
        self.assertEqual(release.read_json(self.root / "state.json")["phase"], "switched")

    def test_previous_smoke_cannot_approve_a_new_incomplete_attempt(self):
        self.prepare_finalization()
        release.freeze.save(self.root / "maintenance-state.json", {"started_at": "next-attempt", "run_pending": True})
        with self.assertRaisesRegex(RuntimeError, "当前尝试"):
            release.finalize(self.root)

    def test_new_session_state_is_archived_before_reconciliation_without_automatic_restore(self):
        work = self.root / "snapshots"
        work.mkdir()
        config = {"roots": [{"name": name, "path": row["current"]} for name, row in self.state["roots"].items()]}
        old_snapshot = release.snapshot.capture(config, work, guard=lambda _: {})
        release.switch(self.root)
        state = release.read_json(self.root / "state.json")
        candidate = self.root / "candidate"
        candidate.mkdir()
        (candidate / "dsh-shared-browser-host.mjs").write_text("approved host")
        state.update(phase="observing", snapshot=str(old_snapshot), candidate=str(candidate))
        release.freeze.save(self.root / "state.json", state)
        relative = Path("data/sessions/fixture/session.v3.jsonl")
        new_session = self.root / "current/dsh" / relative
        new_session.parent.mkdir(parents=True)
        new_session.write_text("new post-resume state")
        frozen = self.root / "new-freeze"
        frozen.mkdir()
        release.freeze.save(frozen / "state.json", {"hold": True, "snapshot": str(old_snapshot)})
        with self.assertRaisesRegex(RuntimeError, "升级前冻结点"):
            release.preserve_after_resume(self.root, frozen)
        fresh = release.snapshot.capture(config, work, guard=lambda _: {})
        release.freeze.save(frozen / "state.json", {"hold": True, "snapshot": str(fresh),
            "manifest_sha256": release.snapshot.sha256(fresh / "manifest.json")})
        result = release.preserve_after_resume(self.root, frozen)
        self.assertTrue(result["new_state_preserved"])
        self.assertFalse(result["automatic_restore_allowed"])
        self.assertEqual(result["changed_session_files"], 1)
        self.assertEqual(new_session.read_bytes(), (fresh / "trees/dsh" / relative).read_bytes())
        with self.assertRaisesRegex(RuntimeError, "尚未恢复业务写者"):
            release.rollback(self.root)


if __name__ == "__main__":
    unittest.main()
