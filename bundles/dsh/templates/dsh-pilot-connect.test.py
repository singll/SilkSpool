import importlib.util
from pathlib import Path
import socket
import threading
import unittest

spec = importlib.util.spec_from_file_location("connect", Path(__file__).with_name("dsh-pilot-connect.py"))
relay = importlib.util.module_from_spec(spec)
spec.loader.exec_module(relay)


class RelayTests(unittest.TestCase):
    def exercise(self, mode="ok", wrong=False, audit_failure=False, max_bytes=1024):
        listener = socket.socket()
        listener.bind(("127.0.0.1", 0))
        listener.listen()
        listener.settimeout(.5)
        upstream = listener.getsockname()
        observed = []
        events = []
        results = []

        def serve():
            try:
                with listener.accept()[0] as conn:
                    conn.settimeout(2)
                    head = bytearray()
                    while not head.endswith(b"\r\n\r\n"):
                        head.extend(conn.recv(1))
                    observed.append(bytes(head))
                    conn.sendall(b"HTTP/1.1 " + (b"502 Bad" if mode == "reject" else b"200 OK") + b"\r\n\r\n")
                    if mode != "reject":
                        data = conn.recv(1024)
                        if data:
                            conn.sendall(data)
                        conn.shutdown(socket.SHUT_WR)
                listener.settimeout(.1)
                try:
                    extra, _ = listener.accept()
                    extra.close()
                    observed.append(b"UNEXPECTED RETRY")
                except socket.timeout:
                    pass
            except socket.timeout:
                pass
            finally:
                listener.close()

        def audit(event):
            events.append(event)
            if audit_failure and event["event"] == "attempt_intent":
                raise OSError("audit unavailable")

        a, b = socket.socketpair()
        worker = threading.Thread(target=lambda: results.append(relay.relay(
            b, upstream=upstream, target=("127.0.0.1", 443), audit=audit,
            timeout=2, max_bytes=max_bytes)))
        server = threading.Thread(target=serve)
        server.start()
        worker.start()
        with a:
            a.settimeout(3)
            a.sendall(b"CONNECT 127.0.0.1:" + (b"444" if wrong else b"443") +
                      b" HTTP/1.1\r\nProxy-Authorization: do-not-forward\r\n\r\n")
            head = bytearray()
            while not head.endswith(b"\r\n\r\n"):
                head.extend(a.recv(1))
            if b"200" in head:
                a.sendall(b"opaque")
                a.shutdown(socket.SHUT_WR)
                received = bytearray()
                while True:
                    try:
                        data = a.recv(1024)
                    except ConnectionResetError:
                        if max_bytes >= 12:
                            raise
                        break
                    if not data:
                        break
                    received.extend(data)
                if max_bytes >= 12:
                    self.assertEqual(received, b"opaque")
            else:
                self.assertIn(b"502", head)
        worker.join(3)
        server.join(3)
        self.assertFalse(worker.is_alive())
        self.assertFalse(server.is_alive())
        self.assertNotIn(b"UNEXPECTED RETRY", observed)
        for request in observed:
            self.assertNotIn(b"Authorization", request)
        self.assertEqual(events[-1]["event"], "finished")
        return results[0], observed

    def test_opaque_roundtrip_and_half_close(self):
        result, calls = self.exercise()
        self.assertEqual(len(calls), 1)
        self.assertEqual(result["phase"], "complete")
        self.assertEqual(result["client_to_upstream_bytes"], 6)
        self.assertEqual(result["upstream_to_client_bytes"], 6)

    def test_502_attempts_once(self):
        result, calls = self.exercise(mode="reject")
        self.assertEqual(len(calls), 1)
        self.assertEqual(result["upstream_connect_requests"], 1)
        self.assertEqual(result["upstream_status"], 502)

    def test_wrong_target_never_dials(self):
        result, calls = self.exercise(wrong=True)
        self.assertEqual(calls, [])
        self.assertEqual(result["upstream_tcp_attempts"], 0)

    def test_failed_intent_audit_never_dials(self):
        result, calls = self.exercise(audit_failure=True)
        self.assertEqual(calls, [])
        self.assertEqual(result["upstream_tcp_attempts"], 0)

    def test_byte_limit_stops_forwarding(self):
        result, calls = self.exercise(max_bytes=3)
        self.assertEqual(len(calls), 1)
        self.assertEqual(result["client_to_upstream_bytes"], 0)
        self.assertIn("byte limit", result["error"])


if __name__ == "__main__":
    unittest.main()
