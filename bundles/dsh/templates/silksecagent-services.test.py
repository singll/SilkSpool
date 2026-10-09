#!/usr/bin/env python3
"""Exercise the deployed unit dependencies with isolated systemd user services."""
import configparser
import os
from pathlib import Path
import subprocess
import time
import unittest
import uuid


class ServiceLifecycleTests(unittest.TestCase):
    def ctl(self, *args, check=True):
        return subprocess.run(
            ["systemctl", "--user", *args], check=check,
            capture_output=True, text=True, timeout=20,
        )

    def setUp(self):
        try:
            available = self.ctl("show-environment", check=False)
        except (FileNotFoundError, subprocess.TimeoutExpired):
            self.skipTest("requires a running systemd user manager")
        if available.returncode:
            self.skipTest("requires a running systemd user manager")
        self.prefix = "silksec-lifecycle-test-" + uuid.uuid4().hex
        self.main = self.prefix + ".service"
        self.edge = self.prefix + "-edge.service"
        runtime = Path(os.environ["XDG_RUNTIME_DIR"]) / "systemd/user"
        runtime.mkdir(parents=True, exist_ok=True)
        self.paths = []
        self.addCleanup(self.cleanup_units)
        for source, target in (
            ("silksecagent.service", self.main),
            ("silksecagent-edge.service", self.edge),
        ):
            original = configparser.ConfigParser(interpolation=None, strict=False)
            original.optionxform = str
            original.read(Path(__file__).with_name(source))
            unit = configparser.ConfigParser(interpolation=None)
            unit.optionxform = str
            unit["Unit"] = {
                key: value.replace("silksecagent-edge.service", self.edge)
                          .replace("silksecagent.service", self.main)
                for key, value in original["Unit"].items()
                if key != "Description"
            }
            # Exercise real systemd ordering/propagation, without starting the app
            # or opening production ports. The readiness point is synchronous.
            unit["Service"] = {"Type": "exec", "ExecStart": "/usr/bin/sleep infinity"}
            path = runtime / target
            self.paths.append(path)
            with path.open("w") as stream:
                unit.write(stream)
        self.ctl("daemon-reload")

    def cleanup_units(self):
        self.ctl("stop", self.edge, self.main, check=False)
        for path in self.paths:
            path.unlink(missing_ok=True)
        self.ctl("daemon-reload", check=False)
        self.ctl("reset-failed", self.edge, self.main, check=False)

    def assert_active(self, unit):
        deadline = time.monotonic() + 5
        while True:
            result = self.ctl("is-active", unit, check=False)
            if result.stdout.strip() == "active" or time.monotonic() >= deadline:
                break
            time.sleep(0.05)
        self.assertEqual(result.stdout.strip(), "active", unit + ": " + result.stdout)

    def test_web_entry_follows_backend_start_stop_start_and_restart(self):
        self.ctl("start", self.main)
        self.assert_active(self.main)
        self.assert_active(self.edge)
        self.ctl("stop", self.main)
        self.assertNotEqual(self.ctl("is-active", self.edge, check=False).returncode, 0)
        self.ctl("start", self.main)
        self.assert_active(self.edge)
        self.ctl("restart", self.main)
        self.assert_active(self.main)
        self.assert_active(self.edge)
        self.ctl("stop", self.edge)
        self.assert_active(self.main)
        self.ctl("restart", self.main)
        self.assert_active(self.edge)


if __name__ == "__main__":
    unittest.main()
