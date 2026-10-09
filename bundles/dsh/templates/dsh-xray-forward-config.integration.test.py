"""Real xray regression, with only local servers and no production config changes.

XRAY_BINARY=/usr/local/bin/xray XRAY_WORKDIR=/opt/silkspool/dsh/xray python3 ...
"""
import http.client
import http.server
import importlib.util
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import threading
import time
import unittest

import yaml

spec = importlib.util.spec_from_file_location(
    "forward", Path(__file__).with_name("dsh-xray-forward-config.py"))
forward = importlib.util.module_from_spec(spec)
spec.loader.exec_module(forward)


@unittest.skipUnless(os.environ.get("XRAY_BINARY"), "set XRAY_BINARY and XRAY_WORKDIR")
class XrayForwardIntegration(unittest.TestCase):
    def test_no_derived_probes_and_no_direct_fallback(self):
        workdir = Path(os.environ["XRAY_WORKDIR"])
        upstream_requests, direct_requests = [], []

        def server(records):
            class Handler(http.server.BaseHTTPRequestHandler):
                def do_GET(self):
                    records.append(self.path)
                    self.send_response(200)
                    self.end_headers()
                    self.wfile.write(b"local fixture")

                def log_message(self, *_):
                    pass

            instance = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
            threading.Thread(target=instance.serve_forever, daemon=True).start()
            self.addCleanup(instance.server_close)
            self.addCleanup(instance.shutdown)
            return instance

        upstream, target = server(upstream_requests), server(direct_requests)
        config = forward.build_config(yaml.safe_load(
            (workdir / "config.yaml").read_text()),
            f"http://127.0.0.1:{upstream.server_port}")
        for key in ("ca_cert", "ca_key"):
            config["mitm"][key] = str((workdir / config["mitm"][key]).resolve())
        with socket.socket() as reservation:
            reservation.bind(("127.0.0.1", 0))
            port = reservation.getsockname()[1]
        with tempfile.TemporaryDirectory(prefix="sec-xray-test-") as temporary:
            root = Path(temporary)
            (root / "config.yaml").write_text(yaml.safe_dump(config))
            with (root / "log").open("w") as log:
                process = subprocess.Popen([
                    os.environ["XRAY_BINARY"], "--config", str(root / "config.yaml"),
                    "webscan", "--listen", f"127.0.0.1:{port}"],
                    cwd=workdir, stdout=log, stderr=log)
                try:
                    deadline = time.monotonic() + 30
                    while True:
                        self.assertIsNone(process.poll(), "xray exited before listening")
                        try:
                            with socket.create_connection(("127.0.0.1", port), .1):
                                break
                        except OSError:
                            self.assertLess(time.monotonic(), deadline, "xray startup timed out")
                            time.sleep(.1)

                    def get(url):
                        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
                        try:
                            connection.request("GET", url)
                            response = connection.getresponse()
                            response.read()
                            return response.status
                        finally:
                            connection.close()

                    url = f"http://127.0.0.1:{target.server_port}/page?x=1"
                    self.assertEqual(get(url), 200)
                    time.sleep(4)  # Old config emits an unsolicited /index.php probe.
                    self.assertEqual(upstream_requests, [url])
                    self.assertEqual(direct_requests, [])
                    upstream.shutdown()
                    upstream.server_close()
                    self.assertEqual(get(url), 502)
                    self.assertEqual(direct_requests, [], "failed upstream fell back to direct")
                finally:
                    process.terminate()
                    try:
                        process.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait()
            self.assertIn("no plugin enabled", (root / "log").read_text())


if __name__ == "__main__":
    unittest.main()
