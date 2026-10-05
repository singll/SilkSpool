import hashlib
import importlib.util
import json
import os
from pathlib import Path
import socket
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from urllib.parse import urlsplit

spec = importlib.util.spec_from_file_location(
    "batch", Path(__file__).with_name("dsh-pilot-proxy-batch.py"))
batch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(batch)


class BatchTests(unittest.TestCase):
    def exercise(self, *, rejected=False, bad_auth=False, changed_scope=False,
                 changed_route=False, audit_failure=False, short_dns=False,
                 expire_during_intent=False):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary) / "run"
            upstream = socket.socket()
            upstream.bind(("127.0.0.1", 0))
            upstream.listen(2)
            upstream.settimeout(.05)
            batch_done = threading.Event()
            requests, failures, outcomes, connections = [], [], [], []
            url = "http://127.0.0.1:" + str(upstream.getsockname()[1])
            route = {"proxy": url, "proxy_sha256": hashlib.sha256(url.encode()).hexdigest(),
                     "source_sha256": {"pool.json": "a" * 64}}
            lease = {"expires_at": time.time() + 3, "program": "test",
                     "batch": "batch-test", "identity": "anonymous",
                     "scope_sha256": "1" * 64, "route": route}
            calls = {"preflight": 0, "route": 0}

            def preflight():
                calls["preflight"] += 1
                result = {"scope_sha256": ("2" * 64 if changed_scope and
                        calls["preflight"] > 1 else "1" * 64),
                        "target": ["127.0.0.1", 443]}
                if short_dns:
                    result["dns_snapshot"] = {"expires_at_ms": time.time() * 1000 + 200}
                return result

            def validate_route():
                calls["route"] += 1
                return {**route, "source_sha256": {"pool.json": "changed"}} \
                    if changed_route and calls["route"] > 1 else route

            def proxy():
                try:
                    # fsync is real in this test and may outlast a short wall
                    # timeout. Keep the fixture available until the batch ends.
                    while True:
                        try:
                            accepted = upstream.accept()[0]
                            break
                        except socket.timeout:
                            if batch_done.is_set():
                                return
                    with accepted as client:
                        client.settimeout(2)
                        head = bytearray()
                        while not head.endswith(b"\r\n\r\n"):
                            part = client.recv(1)
                            if not part:
                                raise EOFError("incomplete header")
                            head.extend(part)
                        requests.append(bytes(head))
                        if rejected:
                            client.sendall(b"HTTP/1.1 502 Bad Gateway\r\n\r\n")
                        else:
                            if short_dns:
                                time.sleep(.3)
                            client.sendall(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                            data = client.recv(100)
                            client.sendall(data)
                            client.shutdown(socket.SHUT_WR)
                    upstream.settimeout(.1)
                    try:
                        extra, _ = upstream.accept()
                        extra.close()
                        requests.append(b"unexpected retry")
                    except socket.timeout:
                        pass
                except socket.timeout:
                    pass
                except Exception as exc:
                    failures.append(exc)
                finally:
                    upstream.close()

            def client(connection):
                try:
                    parsed = urlsplit(connection["proxy"])
                    with socket.create_connection((parsed.hostname, parsed.port), timeout=2) as sock:
                        auth = "Bearer wrong" if bad_auth else connection["proxy_authorization"]
                        sock.sendall(("CONNECT 127.0.0.1:443 HTTP/1.1\r\n"
                                      "Proxy-Authorization: " + auth + "\r\n\r\n").encode())
                        head = bytearray()
                        while not head.endswith(b"\r\n\r\n"):
                            part = sock.recv(1)
                            if not part:
                                raise EOFError("closed before response")
                            head.extend(part)
                        if b"200" in head:
                            sock.sendall(b"opaque")
                            sock.shutdown(socket.SHUT_WR)
                            echoed = bytearray()
                            while True:
                                part = sock.recv(100)
                                if not part:
                                    break
                                echoed.extend(part)
                            self.assertEqual(echoed, b"opaque")
                        else:
                            self.assertIn(b"502", head)
                except Exception as exc:
                    failures.append(exc)

            def ready(connection):
                connections.append(connection)
                thread = threading.Thread(target=client, args=(connection,))
                clients.append(thread)
                thread.start()

            def run():
                try:
                    outcomes.append(batch.run_batch(
                        directory=directory, lease=lease, target=("127.0.0.1", 443),
                        preflight=preflight, validate_route=validate_route,
                        timeout=2, on_ready=ready))
                except Exception as exc:
                    outcomes.append(exc)
                finally:
                    batch_done.set()

            clients = []
            server = threading.Thread(target=proxy)
            original = batch.Audit.__call__

            def fail_intent(writer, event):
                if event["event"] == "attempt_intent":
                    if expire_during_intent:
                        original(writer, event)
                        time.sleep(.25)
                        return
                    writer.failed = True
                    raise OSError("disk unavailable")
                return original(writer, event)

            server.start()
            with patch.object(batch.Audit, "__call__", fail_intent if audit_failure or expire_during_intent else original):
                run()
            for thread in clients + [server]:
                thread.join(3)
                self.assertFalse(thread.is_alive())
            self.assertEqual(failures, [])
            self.assertEqual(len(outcomes), 1)
            self.assertNotIn(b"unexpected retry", requests)
            for request in requests:
                self.assertNotIn(b"Authorization", request)
            audit_bytes = (directory / "audit.jsonl").read_bytes()
            records = [json.loads(line) for line in audit_bytes.splitlines()]
            previous = "0" * 64
            for i, line in enumerate(audit_bytes.splitlines(), 1):
                record = json.loads(line)
                self.assertEqual(record["seq"], i)
                self.assertEqual(record["previous_sha256"], previous)
                previous = hashlib.sha256(line).hexdigest()
            self.assertTrue(connections, f"listener was never opened: {outcomes[0]}")
            self.assertNotIn(connections[0]["proxy_authorization"].encode(), audit_bytes)
            self.assertEqual(directory.stat().st_mode & 0o777, 0o700)
            for name in ("audit.jsonl", "lease.json", "connection.json"):
                self.assertEqual((directory / name).stat().st_mode & 0o777, 0o600)
            address = urlsplit(connections[0]["proxy"])
            with self.assertRaises(OSError):
                socket.create_connection((address.hostname, address.port), timeout=.1)
            with self.assertRaises(FileExistsError):
                batch.run_batch(directory=directory, lease=lease, target=("127.0.0.1", 443),
                                preflight=preflight, validate_route=validate_route)
            return outcomes[0], requests, records, calls

    def test_one_connection_private_durable_audit_and_closed_listener(self):
        result, requests, events, calls = self.exercise()
        self.assertTrue(result["ok"], result)
        self.assertEqual(len(requests), 1)
        self.assertEqual(calls, {"preflight": 2, "route": 2})
        self.assertEqual(events[-1]["event"], "batch_completed")
        terminal = next(row for row in events if row["event"] == "finished")
        self.assertEqual(terminal["client_to_upstream_bytes"], 6)
        self.assertEqual(terminal["upstream_to_client_bytes"], 6)
        self.assertEqual(result["http_requests"], "unknown")

    def test_upstream_rejection_stops_whole_batch_without_retry(self):
        result, requests, events, _ = self.exercise(rejected=True)
        self.assertFalse(result["ok"])
        self.assertEqual(len(requests), 1)
        self.assertEqual(events[-1]["event"], "batch_stopped")

    def test_dns_expiry_after_connect_admission_does_not_shorten_existing_tunnel(self):
        result, requests, events, _ = self.exercise(short_dns=True)
        self.assertTrue(result["ok"], result)
        self.assertEqual(len(requests), 1)
        self.assertEqual(events[-1]["event"], "batch_completed")

    def test_dns_expiry_during_durable_intent_never_dials(self):
        result, requests, events, _ = self.exercise(short_dns=True, expire_during_intent=True)
        self.assertFalse(result["ok"])
        self.assertEqual(requests, [])
        terminal = next(row for row in events if row["event"] == "finished")
        self.assertEqual(terminal["upstream_tcp_attempts"], 0)
        self.assertEqual(terminal["upstream_connect_requests"], 0)
        self.assertIn("DNS binding expired", terminal["error"])

    def test_bad_local_credentials_never_dial(self):
        result, requests, _, _ = self.exercise(bad_auth=True)
        self.assertFalse(result["ok"])
        self.assertEqual(requests, [])

    def test_scope_changes_after_listen_never_dial(self):
        result, requests, _, _ = self.exercise(changed_scope=True)
        self.assertFalse(result["ok"])
        self.assertEqual(requests, [])

    def test_route_changes_after_listen_never_dial(self):
        result, requests, _, _ = self.exercise(changed_route=True)
        self.assertFalse(result["ok"])
        self.assertEqual(requests, [])

    def test_intent_audit_failure_never_dial_and_no_success_record(self):
        result, requests, events, _ = self.exercise(audit_failure=True)
        self.assertIsInstance(result, OSError)
        self.assertEqual(requests, [])
        self.assertNotIn("batch_completed", [row["event"] for row in events])

    def test_audit_short_writes_and_poison_on_fsync_failure(self):
        with tempfile.TemporaryDirectory() as temporary:
            audit = batch.Audit(Path(temporary) / "audit.jsonl")
            real_write = os.write
            try:
                with patch.object(batch.os, "write", lambda fd, data: real_write(fd, data[:3])):
                    audit({"event": "first"})
                with patch.object(batch.os, "fsync", side_effect=OSError("disk failed")):
                    with self.assertRaises(OSError):
                        audit({"event": "second"})
                with self.assertRaises(OSError):
                    audit({"event": "third"})
            finally:
                audit.close()
            rows = [json.loads(line) for line in
                    (Path(temporary) / "audit.jsonl").read_bytes().splitlines()]
            self.assertEqual([row["event"] for row in rows], ["first", "second"])

    def test_private_lease_rejects_symlink_and_broad_permissions(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / "lease.json"
            batch.write_private(source, {"version": 1})
            self.assertEqual(batch.read_lease(source), {"version": 1})
            link = Path(temporary) / "link"
            link.symlink_to(source)
            with self.assertRaises(OSError):
                batch.read_lease(link)
            source.chmod(0o644)
            with self.assertRaises(ValueError):
                batch.read_lease(source)

    def test_opaque_batch_cannot_admit_a_second_connection(self):
        with tempfile.TemporaryDirectory() as temporary:
            with self.assertRaisesRegex(ValueError, "exactly one connection"):
                batch.run_batch(directory=Path(temporary) / "run", lease={},
                                target=("127.0.0.1", 443), preflight=lambda: {},
                                validate_route=lambda: {}, max_connections=2)
            self.assertEqual(list(Path(temporary).iterdir()), [])


if __name__ == "__main__":
    unittest.main()
