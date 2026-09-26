#!/usr/bin/env python3
"""执行真实 setup 的边界测试；临时安装树及系统命令替身隔离包安装和服务重启。"""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


class InstallerTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="dsh-installer-test-")
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.base = self.root / "install"
        self.base.mkdir()
        self.package = self.base / "app/node_modules/@deepseek-ai/dsh/package.json"
        self.package.parent.mkdir(parents=True)
        (self.base / "data").mkdir()
        (self.base / "data/settings.yaml").write_text("fixture-model-route: retained\n")
        (self.base / "settings.yaml").write_text("fixture-model-route: must-not-replace\n")
        self.script = self.base / "setup.sh"
        self.script.write_text(Path(__file__).with_name("setup.sh").read_text().replace("{{BASE_DIR}}", str(self.base)))
        self.trace = self.root / "trace"
        self.commands = self.root / "commands"
        self.commands.mkdir()
        for name, body in {"dpkg": "exit 0", "pnpm": "echo fixture-pnpm", "id": "echo 0",
            "apt-get": 'echo unexpected-apt >> "$DSH_INSTALL_TEST_TRACE"; exit 97',
            "systemctl": 'echo "systemctl $*" >> "$DSH_INSTALL_TEST_TRACE"; exit 0'}.items():
            command = self.commands / name
            command.write_text("#!/bin/bash\n" + body + "\n")
            command.chmod(0o755)
        (self.base / "dsh-runtime-compat.py").write_text(
            'import os\nwith open(os.environ["DSH_INSTALL_TEST_TRACE"],"a") as out: out.write("compat\\n")\n')

    def run_setup(self, version, target=None):
        self.package.write_text(json.dumps({"version": version}))
        environment = {**os.environ, "PATH": str(self.commands) + ":/usr/local/bin:/usr/bin:/bin", "DSH_INSTALL_TEST_TRACE": str(self.trace)}
        if target:
            environment["DSH_TARGET_VERSION"] = target
        return subprocess.run(["bash", str(self.script)], env=environment, capture_output=True, text=True, timeout=30)

    def test_unknown_target_version_is_rejected_before_any_mutation(self):
        for target in ("0.1.6", "0.1.7-rc.3", "latest"):
            self.package.write_text(json.dumps({"version": target}))
            before = {str(p.relative_to(self.base)): hashlib.sha256(p.read_bytes()).hexdigest() for p in self.base.rglob("*") if p.is_file()}
            result = self.run_setup(target, target=target)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("未知目标版本", result.stderr)
            after = {str(p.relative_to(self.base)): hashlib.sha256(p.read_bytes()).hexdigest() for p in self.base.rglob("*") if p.is_file()}
            self.assertEqual(before, after)
            self.assertFalse(self.trace.exists())

    @unittest.skipUnless(Path("/usr/local/node/bin/node").is_file(), "需要目标机实际 Node 路径")
    def test_controlled_target_version_override_runs_existing_install(self):
        result = self.run_setup("0.1.7-rc.2", target="0.1.7-rc.2")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.base / "data/settings.yaml").read_text(), "fixture-model-route: retained\n")
        self.assertEqual(self.trace.read_text().splitlines(), ["compat", "systemctl is-active --quiet silksecagent", "systemctl restart silksecagent"])

    def test_cross_version_guard_runs_before_any_mutation(self):
        for version in ("0.1.2-rc.1", "0.1.5-rc.1", "0.1.6"):
            self.package.write_text(json.dumps({"version": version}))
            before = {str(p.relative_to(self.base)): hashlib.sha256(p.read_bytes()).hexdigest() for p in self.base.rglob("*") if p.is_file()}
            result = self.run_setup(version)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("完整冻结点", result.stderr)
            after = {str(p.relative_to(self.base)): hashlib.sha256(p.read_bytes()).hexdigest() for p in self.base.rglob("*") if p.is_file()}
            self.assertEqual(before, after)
            self.assertFalse(self.trace.exists())

    @unittest.skipUnless(Path("/usr/local/node/bin/node").is_file(), "需要目标机实际 Node 路径")
    def test_repeated_existing_install_preserves_model_settings_and_restarts_last(self):
        for _ in range(2):
            result = self.run_setup("0.1.5-rc.2")
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual((self.base / "data/settings.yaml").read_text(), "fixture-model-route: retained\n")
        self.assertEqual(self.trace.read_text().splitlines(), ["compat", "systemctl is-active --quiet silksecagent", "systemctl restart silksecagent"] * 2)

    @unittest.skipUnless(Path("/usr/local/node/bin/node").is_file(), "需要目标机实际 Node 路径")
    def test_critical_plugin_failure_prevents_service_restart(self):
        for name in ("sec-suite-plugin-setup.sh", "sec-domain-bus-plugin-setup.sh", "sec-browser-plugin-setup.sh", "headless-failover-setup.sh"):
            plugin = self.base / name
            plugin.write_text("#!/bin/bash\nexit 37\n")
            result = self.run_setup("0.1.5-rc.2")
            self.assertEqual(result.returncode, 37, name + result.stderr)
            self.assertFalse(self.trace.exists(), name)
            plugin.unlink()


if __name__ == "__main__":
    unittest.main()
