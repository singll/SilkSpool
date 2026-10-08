#!/usr/bin/env python3
"""重放 journal 的反序、多次启动及 PID 复用，不能选到历史 BrowserAuth 凭据。"""
import importlib.util
import json
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

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

    def test_current_invocation_query_starts_at_launch_instead_of_scanning_all_history(self):
        invocation = 'a' * 32
        identity = f'MainPID=22\nInvocationID={invocation}\nExecMainStartTimestamp=@1791459442\n'
        record = self.row(22, invocation, 1791459443000000, 'current-fixture')
        calls = []
        def run(argv, **kwargs):
            calls.append(argv)
            if argv[0] == 'systemctl':
                self.assertIn('--timestamp=unix', argv)
                self.assertIn('ExecMainStartTimestamp', argv)
                return subprocess.CompletedProcess(argv, 0, identity, '')
            self.assertIn('--since', argv, 'an invocation filter alone still scans historical journal files')
            self.assertEqual(argv[argv.index('--since') + 1], '@1791459441')
            self.assertIn('_SYSTEMD_INVOCATION_ID=' + invocation, argv)
            self.assertEqual(kwargs['timeout'], 15)
            return subprocess.CompletedProcess(argv, 0, json.dumps(record) + '\n', '')
        with patch.object(client.subprocess, 'run', side_effect=run):
            self.assertEqual(client.current_launch_url('silksecagent.service', 3081),
                             'http://127.0.0.1:3081/?token=current-fixture')
        self.assertEqual(len(calls), 3, 'identity must be rechecked after reading journal')

    def test_missing_launch_time_or_restart_never_uses_a_credential(self):
        invocation = 'a' * 32
        identity = f'MainPID=22\nInvocationID={invocation}\nExecMainStartTimestamp=@1791459442\n'
        missing = subprocess.CompletedProcess([], 0, identity.replace('@1791459442', ''), '')
        with patch.object(client.subprocess, 'run', return_value=missing):
            with self.assertRaises(RuntimeError):
                client.current_launch_url('silksecagent.service', 3081)
        rows = json.dumps(self.row(22, invocation, 1791459443000000, 'fixture'))
        results = [subprocess.CompletedProcess([], 0, identity, ''),
                   subprocess.CompletedProcess([], 0, rows, ''),
                   subprocess.CompletedProcess([], 0, identity.replace(invocation, 'b' * 32), '')]
        with patch.object(client.subprocess, 'run', side_effect=results):
            with self.assertRaisesRegex(RuntimeError, '重启'):
                client.current_launch_url('silksecagent.service', 3081)

    def test_journal_timeout_is_retryable_readiness_without_credential_fallback(self):
        identity = 'MainPID=22\nInvocationID=' + 'a' * 32 + '\nExecMainStartTimestamp=@1791459442\n'
        results = [subprocess.CompletedProcess([], 0, identity, ''),
                   subprocess.TimeoutExpired(['journalctl'], 15)]
        with patch.object(client.subprocess, 'run', side_effect=results):
            with self.assertRaisesRegex(RuntimeError, '日志读取超时'):
                client.current_launch_url('silksecagent.service', 3081)


if __name__ == "__main__":
    unittest.main()
