"""Real local TLS -> batch relay -> installed exec-domain integration."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import socket
import ssl
import subprocess
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

HERE = Path(__file__).parent
spec = importlib.util.spec_from_file_location("batch_http", HERE / "dsh-pilot-proxy-batch.py")
batch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(batch)


class HttpBatchTests(unittest.TestCase):
    def test_real_signed_http_result_and_rate_limit_stop(self):
        # Both responses cross the actual Node bus and curl/TLS transport.
        for status in (200, 429):
            with self.subTest(status=status), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                base = root / "app"
                plugins = base / "plugins"
                plugins.mkdir(parents=True)
                for source in HERE.glob("dsh-plugin-sec-*.js"):
                    name = source.name.removeprefix("dsh-plugin-")
                    if "." in name.removesuffix(".js"):
                        continue
                    target = plugins / name.removesuffix(".js")
                    target.mkdir()
                    shutil.copyfile(source, target / "index.js")
                for source in HERE.glob("dsh-plugin-sec-suite.*.js"):
                    name = source.name.removeprefix("dsh-plugin-sec-suite.")
                    if ".test." not in source.name:
                        shutil.copyfile(source, plugins / "sec-suite" / name)
                data = base / "data"
                data.mkdir()
                scope = "defaults:\n  allow_risk: [passive, active]\nprograms:\n  - name: test-src\n    scope:\n      - admitted.invalid\n"
                (data / "scope.yml").write_text(scope)
                digest = hashlib.sha256(scope.encode()).hexdigest()
                cert, key = root / "cert.pem", root / "key.pem"
                subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
                                "-keyout", str(key), "-out", str(cert), "-days", "1",
                                "-subj", "/CN=admitted.invalid", "-addext", "subjectAltName=DNS:admitted.invalid"],
                               check=True, capture_output=True)
                upstream = socket.socket()
                upstream.bind(("127.0.0.1", 0))
                upstream.listen(1)
                upstream.settimeout(18)
                requests, failures = [], []

                def serve():
                    try:
                        with upstream.accept()[0] as client:
                            client.settimeout(15)
                            head = bytearray()
                            while not head.endswith(b"\r\n\r\n"):
                                chunk = client.recv(1)
                                if not chunk:
                                    raise EOFError()
                                head.extend(chunk)
                            requests.append(bytes(head))
                            client.sendall(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                            context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
                            context.load_cert_chain(cert, key)
                            with context.wrap_socket(client, server_side=True) as tls:
                                request = bytearray()
                                while not request.endswith(b"\r\n\r\n"):
                                    request.extend(tls.recv(1))
                                requests.append(bytes(request))
                                body = b'{"code":0,"fixture":"business"}'
                                tls.sendall(f"HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {len(body)}\r\nConnection: close\r\n\r\n".encode() + body)
                    except Exception as exc:
                        failures.append(type(exc).__name__)
                    finally:
                        upstream.close()

                thread = threading.Thread(target=serve)
                thread.start()
                proxy = "http://127.0.0.1:" + str(upstream.getsockname()[1])
                route = {"proxy": proxy, "proxy_sha256": hashlib.sha256(proxy.encode()).hexdigest(),
                         "source_sha256": {"fixture": "a" * 64}}
                lease = {"expires_at": time.time() + 45, "program": "test-src",
                         "batch": "http-fixture", "identity": "anonymous",
                         "scope_sha256": digest, "route": route}
                now = int(time.time() * 1000)
                binding = {"hostname": "admitted.invalid", "program": "test-src",
                           "scope_sha256": digest, "target": ["93.184.216.34", 443],
                           "dns_snapshot": {"version": 1, "hostname": "admitted.invalid",
                                            "program": "test-src", "scope_sha256": digest,
                                            "resolved_at_ms": now, "expires_at_ms": now + 60000,
                                            "records": [{"address": "93.184.216.34", "ttl": 60}]}}
                with patch.dict(os.environ, {"CURL_CA_BUNDLE": str(cert)}):
                    report = batch.run_http_batch(
                        directory=root / "batch", lease=lease, target=("93.184.216.34", 443),
                        preflight=lambda: binding, validate_route=lambda: route,
                        base=base, url="https://admitted.invalid/read", node=shutil.which("node"))
                thread.join(20)
                self.assertFalse(thread.is_alive())
                self.assertEqual(failures, [])
                self.assertEqual(report["ok"], status == 200, report)
                self.assertEqual(report["http"]["state"], "observed" if status == 200 else "rate_limited")
                self.assertEqual(len(requests), 2, "one CONNECT and one HTTP request")
                self.assertNotIn(b"proxy-authorization", requests[1].lower())
                run = data / "results" / report["http"]["run_id"]
                signed = json.loads((run / "http-record.json").read_text())
                self.assertIn("signature", signed)
                self.assertTrue((run / "evidence-manifest.json").exists())
                self.assertNotIn("proxy_authorization", (root / "batch" / "http-result.json").read_text())
                (root / "batch" / "http-result.json").unlink()
                with self.assertRaises(FileExistsError):
                    batch.run_http_batch(
                        directory=root / "batch", lease=lease, target=("93.184.216.34", 443),
                        preflight=lambda: binding, validate_route=lambda: route,
                        base=base, url="https://admitted.invalid/read", node=shutil.which("node"))
                self.assertFalse((root / "batch" / "http-result.json").exists())


if __name__ == "__main__":
    unittest.main()
