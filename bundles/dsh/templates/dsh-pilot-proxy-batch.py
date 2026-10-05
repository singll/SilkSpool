#!/usr/bin/env python3
"""Bounded local CONNECT batch with a fixed lease and durable audit.

The CLI rechecks installed scope policy and exact S-level Web membership before
each dial. It never reselects a route or resumes an existing batch directory.
Opaque tunnel bytes cannot prove upstream attempts, HTTP counts, or exit IP.
"""
import argparse
import hashlib
import hmac
import importlib.util
import ipaddress
import json
import math
import os
from pathlib import Path
import secrets
import socket
import stat
import subprocess
import time
from urllib.parse import urlsplit


def load(name):
    spec = importlib.util.spec_from_file_location(
        name, Path(__file__).with_name(name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


relay_core = load("dsh-pilot-connect")
leases = load("dsh-pilot-proxy-lease")


def write_all(fd, data):
    pending = memoryview(data)
    while pending:
        count = os.write(fd, pending)
        if count <= 0:
            raise OSError("audit write made no progress")
        pending = pending[count:]


def fsync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def write_private(path, value):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        write_all(fd, (json.dumps(value, sort_keys=True, allow_nan=False) + "\n").encode())
        os.fsync(fd)
    finally:
        os.close(fd)
    fsync_directory(Path(path).parent)


class Audit:
    """New file only; fsync each record, poison the writer on any failure."""
    def __init__(self, path):
        self.fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT |
                          os.O_EXCL | os.O_NOFOLLOW, 0o600)
        self.seq, self.previous, self.failed = 0, "0" * 64, False
        try:
            os.fsync(self.fd)
            fsync_directory(Path(path).parent)
        except Exception:
            self.close()
            raise

    def __call__(self, event):
        if self.failed:
            raise OSError("audit writer unavailable; no continuation")
        try:
            row = {**event, "seq": self.seq + 1, "recorded_at": time.time(),
                   "previous_sha256": self.previous}
            encoded = json.dumps(row, sort_keys=True, separators=(",", ":"),
                                 allow_nan=False).encode()
            digest = hashlib.sha256(encoded).hexdigest()
            write_all(self.fd, encoded + b"\n")
            os.fsync(self.fd)
            self.seq, self.previous = row["seq"], digest
        except Exception:
            self.failed = True
            raise

    def close(self):
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None


def run_batch(*, directory, lease, target, preflight, validate_route,
              max_connections=1, timeout=15, max_bytes=1048576, on_ready=None):
    """Testable runner. CLI supplies authoritative preflight/route callbacks.

    Callbacks are trusted integration code, never model supplied assertions.
    The Python API permits loopback fixtures; the CLI requires public IPv4:443.
    """
    # Until an HTTP-aware executor supplies target outcomes, another tunnel
    # cannot be admitted safely after an opaque 403/429 response.
    if type(max_connections) is not int or max_connections != 1:
        raise ValueError("pilot requires exactly one connection per batch")
    if (isinstance(timeout, bool) or not isinstance(timeout, (float, int))
            or not math.isfinite(timeout) or not 0 < timeout <= 30):
        raise ValueError("invalid timeout")
    if isinstance(max_bytes, bool) or not isinstance(max_bytes, int) or not 1 <= max_bytes <= 16777216:
        raise ValueError("invalid byte budget")
    ipaddress.IPv4Address(target[0])
    if isinstance(target[1], bool) or not isinstance(target[1], int) or not 1 <= target[1] <= 65535:
        raise ValueError("invalid target port")
    remaining = lease["expires_at"] - time.time()
    if not 0 < remaining <= 900:
        raise ValueError("lease expired or invalid")
    deadline = time.monotonic() + remaining
    route = lease["route"]
    upstream_url = urlsplit(route["proxy"])
    if (upstream_url.scheme != "http" or upstream_url.username or upstream_url.password
            or upstream_url.path or upstream_url.query or upstream_url.fragment):
        raise ValueError("invalid upstream route")
    upstream = (str(ipaddress.IPv4Address(upstream_url.hostname)), upstream_url.port)
    if upstream[1] is None:
        raise ValueError("numeric upstream port required")
    directory = Path(directory)
    directory.mkdir(mode=0o700)  # Existing or partially completed batch is never reused.
    fsync_directory(directory.parent)
    audit = Audit(directory / "audit.jsonl")
    listener = None
    token = secrets.token_hex(32)
    context = {k: lease[k] for k in ("program", "batch", "identity", "scope_sha256")}
    context.update(proxy_sha256=route["proxy_sha256"], target=target)
    consumed = 0

    def record(event):
        audit({**event, "context": context})

    def check():
        if time.monotonic() >= deadline or time.time() >= lease["expires_at"]:
            raise ValueError("batch lease expired")
        checked = preflight()
        if checked["scope_sha256"] != lease["scope_sha256"] or checked["target"] != list(target):
            raise ValueError("scope or target changed; no continuation")
        current = validate_route()
        if current["proxy"] != route["proxy"] or current["source_sha256"] != route["source_sha256"]:
            raise ValueError("bound route changed; no replacement")
        record({"event": "preflight_passed", "preflight": checked,
                "source_sha256": current["source_sha256"]})

    def authorize(request):
        values = [line.split(b":", 1)[1].strip()
                  for line in request.split(b"\r\n")[1:]
                  if line.lower().startswith(b"proxy-authorization:")]
        if len(values) != 1 or not hmac.compare_digest(values[0], b"Bearer " + token.encode()):
            raise ValueError("local proxy authentication failed")
        check()

    try:
        write_private(directory / "lease.json", lease)
        record({"event": "batch_started", "max_connections": max_connections,
                "timeout": timeout, "max_bytes_per_connection": max_bytes,
                "http_requests": "unknown", "exit_ip_proven": False})
        check()
        listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        listener.bind(("127.0.0.1", 0))
        listener.listen(1)
        address = listener.getsockname()
        # Only this private file exposes the token. Audit/stdout never contain it.
        connection = {"proxy": f"http://{address[0]}:{address[1]}",
                      "proxy_authorization": "Bearer " + token,
                      "expires_at": lease["expires_at"]}
        write_private(directory / "connection.json", connection)
        record({"event": "listener_ready", "address": address})
        if on_ready:
            on_ready(connection)
        while consumed < max_connections:
            wait = min(deadline - time.monotonic(), lease["expires_at"] - time.time())
            if wait <= 0:
                raise TimeoutError("batch deadline")
            listener.settimeout(wait)
            client, _ = listener.accept()
            consumed += 1
            try:
                record({"event": "client_accepted", "connection_number": consumed})
                # Bound the whole relay, including revalidation, by the lease.
                duration = min(timeout, deadline - time.monotonic(),
                               lease["expires_at"] - time.time())
                if duration <= 0:
                    raise TimeoutError("batch deadline")
                result = relay_core.relay(client, upstream=upstream, target=target,
                                          audit=record, timeout=duration,
                                          max_bytes=max_bytes, authorize=authorize)
            finally:
                client.close()
            if "error_kind" in result:
                record({"event": "batch_stopped", "reason": "connection_failed",
                        "connections_consumed": consumed})
                return {"ok": False, "connections_consumed": consumed,
                        "reason": "connection_failed", "result": result}
        record({"event": "batch_completed", "connections_consumed": consumed})
        return {"ok": True, "connections_consumed": consumed,
                "http_requests": "unknown", "upstream_internal_attempts": "unknown"}
    except Exception as exc:
        record({"event": "batch_failed", "error_kind": type(exc).__name__,
                "connections_consumed": consumed})
        raise
    finally:
        if listener is not None:
            listener.close()
        audit.close()


def read_lease(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid()
                or info.st_mode & 0o077 or info.st_size > 65536):
            raise ValueError("lease must be a private owned regular file <=64KiB")
        with os.fdopen(fd, "r") as source:
            fd = None
            return json.load(source)
    finally:
        if fd is not None:
            os.close(fd)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--lease", required=True)
    parser.add_argument("--directory", required=True)
    parser.add_argument("--hostname", required=True)
    parser.add_argument("--target-ip", required=True)
    parser.add_argument("--pool-dir", default="/opt/silkspool/dsh/proxy-pool")
    parser.add_argument("--base", default="/opt/silkspool/dsh")
    parser.add_argument("--node", default="/usr/local/node/bin/node")
    parser.add_argument("--max-connections", type=int, choices=[1], default=1)
    args = parser.parse_args()
    lease = read_lease(args.lease)
    if lease["identity"] != "anonymous":
        raise ValueError("pilot batch supports anonymous identity only")
    if lease["program"] not in ("bytedance", "meituan-src"):
        raise ValueError("pilot Program is outside the selected projects")
    target = (args.target_ip, 443)

    def preflight():
        completed = subprocess.run(
            [args.node, str(Path(__file__).with_name("dsh-pilot-preflight.mjs")),
             args.base, lease["program"], args.hostname, args.target_ip,
             lease["scope_sha256"]],
            check=True, capture_output=True, timeout=7)
        return json.loads(completed.stdout)

    def validate_route():
        return leases.validate_lease(
            lease, args.pool_dir, now=time.time(),
            **{key: lease[key] for key in ("program", "batch", "identity", "scope_sha256")})

    result = run_batch(directory=args.directory, lease=lease, target=target,
                       preflight=preflight, validate_route=validate_route,
                       max_connections=args.max_connections)
    print(json.dumps(result))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
