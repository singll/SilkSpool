import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("egress", Path(__file__).with_name("dsh-pilot-egress.py"))
egress = importlib.util.module_from_spec(spec)
spec.loader.exec_module(egress)


class ConfigurationTests(unittest.TestCase):
    def test_exact_public_targets_only(self):
        cfg = egress.build_config(["8.8.8.8", "1.1.1.1", "8.8.8.8"], 18899)
        self.assertEqual(len(cfg["rules"]), 3)
        self.assertEqual(cfg["rules"][-1], "MATCH,REJECT")
        self.assertFalse(cfg["sniffer"]["enable"])
        self.assertFalse(cfg["dns"]["enable"])
        self.assertEqual(cfg["bind-address"], "127.0.0.1")

    def test_rejects_unsafe_or_unbounded_configuration(self):
        for addresses in [[], ["127.0.0.1"], ["192.168.1.1"], ["224.0.0.1"],
                          ["example.org"], ["::1"], [f"8.8.8.{i}" for i in range(1, 10)]]:
            with self.subTest(addresses=addresses), self.assertRaises(ValueError):
                egress.build_config(addresses, 18899)
        for port in [True, 0, 80, 65536, "18899"]:
            with self.subTest(port=port), self.assertRaises(ValueError):
                egress.build_config(["8.8.8.8"], port)


if __name__ == "__main__":
    unittest.main()
