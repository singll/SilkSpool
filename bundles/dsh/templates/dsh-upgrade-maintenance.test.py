#!/usr/bin/env python3
"""覆盖 Cordis 整段 config 替换与 systemd 临时覆盖的中断清理边界。"""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock
import yaml

spec = importlib.util.spec_from_file_location("maintenance", Path(__file__).with_name("dsh-upgrade-maintenance.py"))
maintenance = importlib.util.module_from_spec(spec)
spec.loader.exec_module(maintenance)


class MaintenanceTests(unittest.TestCase):
    def test_full_config_preserves_existing_settings_while_muting_writers(self):
        rows = [{"id": name, "config": {"retained": {"number": 7, "enabled": True}, **values}}
                for name, values in maintenance.OVERRIDES.items()]
        source = yaml.safe_dump(rows)
        patch = maintenance.maintenance_patch(source, maintenance.release.VERSION)
        self.assertEqual(len(patch), len(rows))
        self.assertTrue(all(row["config"]["retained"] == {"number": 7, "enabled": True} for row in patch))
        self.assertEqual(yaml.safe_dump(rows), source)

    def test_missing_or_ambiguous_writer_controls_fail_closed(self):
        rows = [{"id": name} for name in maintenance.REQUIRED]
        for broken in (rows[1:], rows + rows[:1]):
            with self.assertRaises(RuntimeError):
                maintenance.maintenance_patch(yaml.safe_dump(broken), maintenance.release.OLD_VERSION)

    def test_special_values_are_preserved_without_executing_their_content(self):
        rows = [{"id": name} for name in maintenance.REQUIRED]
        source = yaml.safe_dump(rows) + "- id: model-failover\n  config:\n    special: !js/function function() {}\n"
        patch = maintenance.maintenance_patch(source, maintenance.release.OLD_VERSION)
        serialized = yaml.dump(patch, Dumper=maintenance.ConfigDumper)
        restored = yaml.load(serialized, Loader=maintenance.ConfigLoader)
        self.assertEqual(restored, patch)
        special = next(row for row in restored if row["id"] == "model-failover")["config"]["special"]
        self.assertEqual(special.node.tag, "!js/function")
        self.assertEqual(special.node.value, "function() {}")

    def fixture(self):
        work = tempfile.TemporaryDirectory(prefix="dsh-maintenance-tests-")
        self.addCleanup(work.cleanup)
        directory = Path(work.name)
        dropin = directory / "override.conf"
        dropin.write_text("verified temporary override")
        (directory / "maintenance-state.json").write_text(json.dumps({"dropin_sha256": maintenance.snapshot.sha256(dropin)}))
        patch = mock.patch.object(maintenance, "DROPIN", dropin)
        patch.start()
        self.addCleanup(patch.stop)
        return directory, dropin

    def test_changed_override_cannot_stop_a_service_or_be_deleted(self):
        directory, dropin = self.fixture()
        dropin.write_text("someone else's change")
        with mock.patch.object(maintenance.freeze, "systemctl") as ctl:
            with self.assertRaisesRegex(RuntimeError, "另行修改"):
                maintenance.cleanup(directory)
            ctl.assert_not_called()
        self.assertTrue(dropin.exists())

    def test_cleanup_after_unlink_interruption_still_reloads_original_unit(self):
        directory, dropin = self.fixture()
        dropin.unlink()
        with mock.patch.object(maintenance.freeze, "systemctl") as ctl:
            maintenance.cleanup(directory)
            self.assertEqual(ctl.call_args_list, [mock.call("stop", maintenance.UNIT), mock.call("daemon-reload")])
            ctl.reset_mock()
            maintenance.cleanup(directory)
            ctl.assert_not_called()


    def test_systemd_argument_whitelist_allows_scoped_package_paths(self):
        # 真实生产入口使用 @scope 包路径；systemd 不需要转义 @。
        accepted = ["/usr/local/node/bin/node",
                    "/opt/silkspool/dsh/app/node_modules/@deepseek-ai/dsh/lib/bin.js",
                    "web", "--patch", "/run/silksecagent-upgrade-ab12cd/maintenance.patch.yml",
                    "--host", "127.0.0.1", "--port", "3081"]
        for item in accepted:
            self.assertTrue(maintenance.SAFE_SYSTEMD_ARG.fullmatch(item), item)
        # 需要转义或注入风险的字符必须继续被拒绝。
        for rejected in ("/opt/bin; rm -rf /", '/opt/bin"q', "opt/bin'q", "/opt/bin\\x", "/opt/a b",
                         "/opt/bin$(id)", "/opt/bin`id`", "/opt/b#in", "/opt/bin\t"):
            self.assertIsNone(maintenance.SAFE_SYSTEMD_ARG.fullmatch(rejected), rejected)


if __name__ == "__main__":
    unittest.main()
