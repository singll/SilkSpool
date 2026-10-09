import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location(
    "forward_config", Path(__file__).with_name("dsh-xray-forward-config.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ForwardConfigurationTests(unittest.TestCase):
    def source(self):
        return {"version": 4.0, "plugins": {
            "baseline": {"enabled": True, "detect_cors_header_config": True},
            "future-plugin": {"enabled": True}},
            "http": {"proxy": "", "proxy_rule": [{"proxy": "old"}], "fail_retries": 3},
            "mitm": {"upstream_proxy": "", "ca_cert": "./ca.crt",
                     "restriction": {"hostname_disallowed": ["*.gov.cn"]}}}

    def test_scanners_disabled_and_both_egress_paths_use_pool(self):
        original = self.source()
        result = module.build_config(original, "http://127.0.0.1:8899")
        self.assertTrue(original["plugins"]["baseline"]["enabled"])
        self.assertTrue(all(p["enabled"] is False for p in result["plugins"].values()))
        self.assertEqual(result["http"]["proxy"], "http://127.0.0.1:8899")
        self.assertEqual(result["mitm"]["upstream_proxy"], result["http"]["proxy"])
        self.assertEqual(result["http"]["proxy_rule"], [])
        self.assertEqual(result["http"]["fail_retries"], 0)
        self.assertTrue(result["http"]["passive_mode"])
        self.assertEqual(result["mitm"]["restriction"], original["mitm"]["restriction"])
        self.assertEqual(result["mitm"]["ca_cert"], "./ca.crt")

    def test_missing_or_changed_config_fails_instead_of_loading_scan_defaults(self):
        for source in [{}, {"version": 5}, {**self.source(), "plugins": {}},
                       {**self.source(), "plugins": {"new": None}}]:
            with self.subTest(source=source), self.assertRaises(ValueError):
                module.build_config(source, "http://127.0.0.1:8899")

    def test_direct_and_unmanaged_upstreams_rejected(self):
        for proxy in ["", "DIRECT", "http://outside.test:8080",
                      "http://127.0.0.1", "http://u:p@127.0.0.1:8899",
                      "socks5://127.0.0.1:8899", "http://127.0.0.1:8899/path"]:
            with self.subTest(proxy=proxy), self.assertRaises(ValueError):
                module.build_config(self.source(), proxy)


if __name__ == "__main__":
    unittest.main()
