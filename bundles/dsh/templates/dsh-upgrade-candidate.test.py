#!/usr/bin/env python3
"""候选封存不得引用不存在的模板；版本参数化仍必须锁定受控版本。"""
import importlib.util
import os
from pathlib import Path
import unittest

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("candidate", HERE / "dsh-upgrade-candidate.py")
candidate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(candidate)


class CandidateTests(unittest.TestCase):
    def test_every_referenced_template_exists(self):
        missing = [name for name in candidate.TEMPLATES if not (HERE / name).is_file()]
        self.assertEqual(missing, [])

    def test_removed_v4_scheduler_is_not_referenced(self):
        source = (HERE / "dsh-upgrade-candidate.py").read_text()
        self.assertNotIn("scheduler", source)

    def test_supported_versions_include_source_and_target(self):
        self.assertEqual(set(candidate.SUPPORTED_VERSIONS), {"0.1.5-rc.2", "0.1.7-rc.2"})

    def test_target_plugin_pins_match_repo_lock(self):
        lock = {}
        for line in (HERE / "plugins.lock").read_text().splitlines():
            fields = line.split("|")
            if len(fields) >= 4:
                lock[fields[0]] = fields[1]
        self.assertEqual(set(candidate.PLUGIN_PINS), set(candidate.SUPPORTED_VERSIONS))
        for name, value in candidate.PLUGIN_PINS["0.1.7-rc.2"].items():
            self.assertEqual(lock[name], value, name)

    def test_scan_core_versions_keeps_target_version_locked(self):
        import json
        import tempfile
        with tempfile.TemporaryDirectory() as work:
            package = Path(work) / "node_modules/.pnpm/x/node_modules/@deepseek-ai/pkg/package.json"
            package.parent.mkdir(parents=True)
            package.write_text(json.dumps({"name": "@deepseek-ai/pkg", "version": "9.9.9"}))
            self.assertEqual(candidate.scan_core_versions(Path(work)), {"@deepseek-ai/pkg": "9.9.9"})
        source = (HERE / "dsh-upgrade-candidate.py").read_text()
        self.assertNotIn('name, version = package["name"], package["version"]', source)

    def test_root_only_snapshot_settings_source_is_copied(self):
        source = (HERE / "dsh-upgrade-candidate.py").read_text()
        self.assertIn(".settings-source.yaml", source)
        self.assertNotIn('"DSH_SETTINGS_SOURCE": str(settings_source)', source)

    def test_retarget_rewrites_only_version_defaults(self):
        text = ('DSH_TARGET_VERSION:-0.1.5-rc.2\nKNOWN="${DSH_KNOWN_VERSION:-0.1.5-rc.2}"\n'
                'DSH_VERSION="0.1.5-rc.2"\nDSH_SOURCE_VERSION:-0.1.2-rc.1\n')
        result = candidate.retarget(text, "0.1.7-rc.2")
        self.assertIn("DSH_TARGET_VERSION:-0.1.7-rc.2", result)
        self.assertIn("DSH_KNOWN_VERSION:-0.1.7-rc.2", result)
        self.assertIn('DSH_VERSION="0.1.7-rc.2"', result)
        self.assertIn("DSH_SOURCE_VERSION:-0.1.2-rc.1", result)
        sourced = candidate.retarget(text, "0.1.7-rc.2", "0.1.5-rc.2")
        self.assertIn("DSH_SOURCE_VERSION:-0.1.5-rc.2", sourced)
        self.assertIn("DSH_TARGET_VERSION:-0.1.7-rc.2", sourced)


if __name__ == "__main__":
    unittest.main()
