#!/usr/bin/env python3
"""隔离启动器必须把显式版本对透传给 guest，且不泄漏宿主其他环境变量。"""
import importlib.util
import os
from pathlib import Path
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location("sandbox", Path(__file__).with_name("dsh-upgrade-sandbox.py"))
sandbox = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sandbox)


class SandboxTests(unittest.TestCase):
    def test_version_pair_is_forwarded(self):
        with mock.patch.dict(os.environ, {"DSH_TARGET_VERSION": "0.1.7-rc.2",
                                          "DSH_OLD_VERSION": "0.1.5-rc.2",
                                          "DSH_UPGRADE_SECRET": "must-not-leak"}, clear=False):
            environment = sandbox.guest_environment(Path("/opt/silkspool/dsh"))
        self.assertEqual(environment["DSH_TARGET_VERSION"], "0.1.7-rc.2")
        self.assertEqual(environment["DSH_OLD_VERSION"], "0.1.5-rc.2")
        self.assertNotIn("DSH_UPGRADE_SECRET", environment)
        self.assertEqual(environment["DSH_HOME"], "/opt/silkspool/dsh/data")
        self.assertEqual(environment["SEC_BASE_DIR"], "/opt/silkspool/dsh")

    def test_absent_version_pair_stays_absent(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            environment = sandbox.guest_environment(Path("/opt/silkspool/dsh"))
        self.assertNotIn("DSH_TARGET_VERSION", environment)
        self.assertNotIn("DSH_OLD_VERSION", environment)


if __name__ == "__main__":
    unittest.main()
