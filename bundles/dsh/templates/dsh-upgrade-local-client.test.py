#!/usr/bin/env python3
"""重放 journal 的反序、多次启动及 PID 复用，不能选到历史 BrowserAuth 凭据。"""
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("client", Path(__file__).with_name("dsh-upgrade-local-client.py"))
client = importlib.util.module_from_spec(spec)
spec.loader.exec_module(client)


class JournalTests(unittest.TestCase):
    def row(self, pid, invocation, timestamp, token, port=3081):
        return {"_PID": str(pid), "_SYSTEMD_INVOCATION_ID": invocation, "__REALTIME_TIMESTAMP": str(timestamp),
                "MESSAGE": f"Open http://127.0.0.1:{port}/?token={token}\x1b[0m"}

    def test_newest_first_and_oldest_first_both_select_current_instance(self):
        rows = [self.row(22, "current", 20, "valid-fixture"), self.row(11, "old", 10, "expired-fixture")]
        for ordered in (rows, rows[::-1]):
            self.assertEqual(client.journal_launch_url(ordered, 22, "current", 3081), "http://127.0.0.1:3081/?token=valid-fixture")

    def test_reused_pid_and_other_ports_cannot_supply_credentials(self):
        rows = [self.row(22, "old", 30, "old-fixture"), self.row(22, "current", 31, "other-port-fixture", port=3082)]
        with self.assertRaisesRegex(RuntimeError, "当前服务启动实例"):
            client.journal_launch_url(rows, 22, "current", 3081)

    def test_timestamp_order_is_numeric_and_not_record_order(self):
        rows = [self.row(22, "current", 100, "new-fixture"), self.row(22, "current", 99, "old-fixture")]
        self.assertEqual(client.journal_launch_url(rows, 22, "current", 3081), "http://127.0.0.1:3081/?token=new-fixture")


if __name__ == "__main__":
    unittest.main()
