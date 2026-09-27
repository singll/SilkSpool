#!/usr/bin/env python3
"""data-quality 生效配置口径：0.1.7 profile patch 优先，旧 settings.yaml 兜底，两者都无则 critical。"""
import importlib.util
from pathlib import Path
import tempfile
import unittest
import yaml

spec = importlib.util.spec_from_file_location("data_quality", Path(__file__).parent / "data-seed/scripts/data-quality.py")
quality = importlib.util.module_from_spec(spec)
spec.loader.exec_module(quality)

SETTINGS = {
    "llm-pi-ai": {"providers": {"bellkeeper": {"baseURL": "http://192.168.7.230:8090/api/llm/v1"}}},
    "agent-default-model": {"provider": "bellkeeper", "model": "pool-secagent"},
}


class DataQualitySettingsTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="dsh-data-quality-")
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.settings = self.root / "settings.yaml"
        self.patch = self.root / "cordis.patch.yml"

    def test_profile_patch_is_preferred_over_legacy_file(self):
        self.settings.write_text(yaml.safe_dump({"llm-pi-ai": {"providers": {}}, "agent-default-model": {"provider": "raw", "model": "raw"}}))
        self.patch.write_text(yaml.safe_dump([{"id": "llm-pi-ai", "config": SETTINGS["llm-pi-ai"]},
                                              {"id": "agent-default-model", "config": SETTINGS["agent-default-model"]}]))
        level, detail = quality.check_settings(str(self.settings), str(self.patch))
        self.assertEqual(level, "ok")
        self.assertIn(str(self.patch), detail)

    def test_legacy_file_is_the_fallback_before_import(self):
        self.settings.write_text(yaml.safe_dump(SETTINGS))
        self.patch.write_text("# 无模型行\n")
        level, detail = quality.check_settings(str(self.settings), str(self.patch))
        self.assertEqual(level, "ok")
        self.assertIn(str(self.settings), detail)

    def test_missing_sources_are_critical(self):
        level, detail = quality.check_settings(str(self.settings), str(self.patch))
        self.assertEqual(level, "critical")

    def test_wrong_default_route_is_critical_from_patch(self):
        self.patch.write_text(yaml.safe_dump([{"id": "llm-pi-ai", "config": SETTINGS["llm-pi-ai"]},
                                              {"id": "agent-default-model", "config": {"provider": "deepseek", "model": "x"}}]))
        level, _ = quality.check_settings(str(self.settings), str(self.patch))
        self.assertEqual(level, "critical")


if __name__ == "__main__":
    unittest.main()
