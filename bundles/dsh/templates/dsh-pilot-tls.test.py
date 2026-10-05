import importlib.util
from pathlib import Path
import socket
import ssl
import subprocess
import tempfile
import threading
import unittest

spec = importlib.util.spec_from_file_location("pilot_tls", Path(__file__).with_name("dsh-pilot-tls.py"))
pilot = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pilot)


class DiagnosticTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.cert = str(Path(cls.tmp.name) / "cert.pem")
        cls.key = str(Path(cls.tmp.name) / "key.pem")
        subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
                        "-keyout", cls.key, "-out", cls.cert, "-days", "1",
                        "-subj", "/CN=entry.test", "-addext", "subjectAltName=DNS:entry.test"],
                       check=True, capture_output=True)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def probe(self, mode, hostname="entry.test", trusted=True):
        listener = socket.socket()
        listener.bind(("127.0.0.1", 0))
        listener.listen()
        port = listener.getsockname()[1]
        observed = {"connections": 0, "application_bytes": 0}

        def serve():
            try:
                with listener.accept()[0] as conn:
                    observed["connections"] += 1
                    conn.settimeout(2)
                    head = bytearray()
                    while not head.endswith(b"\r\n\r\n"):
                        head.extend(conn.recv(1))
                    observed["connect"] = bytes(head)
                    if mode == "stall":
                        conn.recv(1)  # EOF when diagnostic deadline closes the socket.
                        return
                    conn.sendall(b"HTTP/1.1 " + (b"407 Auth" if mode == "reject" else b"200 OK") + b"\r\n\r\n")
                    if mode == "reject":
                        return
                    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
                    ctx.load_cert_chain(self.cert, self.key)
                    with ctx.wrap_socket(conn, server_side=True) as tls:
                        observed["application_bytes"] = len(tls.recv(4096))
            except ssl.SSLError:
                pass  # Expected client rejection of the fixture certificate.
            finally:
                listener.close()

        thread = threading.Thread(target=serve)
        thread.start()
        ctx = ssl.create_default_context(cafile=self.cert) if trusted else None
        result = pilot.diagnose_tls("127.0.0.1", port, "127.0.0.1", hostname,
                                    timeout=.3 if mode == "stall" else 2, context=ctx)
        thread.join(3)
        self.assertFalse(thread.is_alive())
        self.assertEqual(observed["connections"], 1)
        self.assertEqual(observed["connect"], b"CONNECT 127.0.0.1:443 HTTP/1.1\r\nHost: 127.0.0.1:443\r\n\r\n")
        self.assertEqual(observed["application_bytes"], 0)
        self.assertEqual(result["application_requests"], 0)
        self.assertEqual(result["retries"], 0)
        return result

    def test_verified_tls_without_application_request(self):
        result = self.probe("tls")
        self.assertTrue(result["ok"])
        self.assertIsNotNone(result["peer_certificate"])

    def test_hostname_mismatch_is_not_accepted(self):
        result = self.probe("tls", hostname="wrong.test")
        self.assertEqual(result["error_kind"], "certificate_verification")
        self.assertIn("mismatch", result["verify_message"])

    def test_untrusted_chain_is_not_accepted(self):
        result = self.probe("tls", trusted=False)
        self.assertEqual(result["error_kind"], "certificate_verification")
        self.assertEqual(result["phase"], "tls_handshake")

    def test_connect_timeout_has_phase_and_no_tls(self):
        result = self.probe("stall")
        self.assertEqual(result["error_kind"], "timeout")
        self.assertEqual(result["phase"], "proxy_connect")
        self.assertEqual(result["tls_attempts"], 0)

    def test_proxy_rejection_never_starts_tls(self):
        result = self.probe("reject")
        self.assertEqual(result["connect_status"], 407)
        self.assertEqual(result["tls_attempts"], 0)

    def test_verification_cannot_be_disabled(self):
        ctx = ssl._create_unverified_context()
        with self.assertRaises(ValueError):
            pilot.diagnose_tls("127.0.0.1", 1, "127.0.0.1", "entry.test", context=ctx)


if __name__ == "__main__":
    unittest.main()
