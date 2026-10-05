#!/usr/bin/env python3
"""Single-client opaque CONNECT relay core. No listener, retries or direct path.

The caller provides an already accepted local socket, checked numeric endpoints,
and a durable audit sink. Scope, route lease and process isolation remain caller
responsibilities. Loopback endpoints are accepted for isolated fixtures.
"""
import ipaddress
import errno
import math
import select
import socket
import time
import uuid


def relay(client, *, upstream, target, audit, timeout=15, max_bytes=1048576,
          authorize=None, before_connect=None):
    for address, port in (upstream, target):
        ipaddress.IPv4Address(address)
        if isinstance(port, bool) or not isinstance(port, int) or not 1 <= port <= 65535:
            raise ValueError("invalid port")
    if (isinstance(timeout, bool) or not isinstance(timeout, (int, float))
            or not math.isfinite(timeout) or not 0 < timeout <= 30):
        raise ValueError("invalid deadline")
    if isinstance(max_bytes, bool) or not isinstance(max_bytes, int) or not 1 <= max_bytes <= 16777216:
        raise ValueError("invalid byte limit")
    authority = f"{target[0]}:{target[1]}"
    record = {"id": uuid.uuid4().hex, "phase": "client_connect",
              "upstream_tcp_attempts": 0, "upstream_connect_requests": 0,
              "client_to_upstream_bytes": 0, "upstream_to_client_bytes": 0,
              "upstream_internal_attempts": "unknown", "retries": 0}
    started = time.monotonic()
    deadline = started + timeout
    remote = None
    accepted = False

    def remaining():
        result = deadline - time.monotonic()
        if result <= 0:
            raise TimeoutError("relay deadline")
        return result

    def header(sock):
        result = bytearray()
        while not result.endswith(b"\r\n\r\n"):
            if len(result) >= 16384:
                raise ValueError("CONNECT header limit")
            sock.settimeout(remaining())
            byte = sock.recv(1)
            if not byte:
                raise EOFError("incomplete CONNECT header")
            result.extend(byte)
        return bytes(result)

    try:
        request = header(client)
        lines = request.split(b"\r\n")
        if lines[0] != f"CONNECT {authority} HTTP/1.1".encode():
            raise ValueError("target or method not allowed")
        # Only synthesize CONNECT upstream; never forward caller credentials.
        if any(line.lower().startswith((b"content-length:", b"transfer-encoding:"))
               for line in lines[1:] if line):
            raise ValueError("CONNECT body not allowed")
        # The batch runner checks local credentials, current scope and its
        # original route here, after the client header and before any dialing.
        if authorize is not None:
            authorize(request)
        record["phase"] = "upstream_tcp"
        audit({**record, "event": "attempt_intent", "upstream": upstream, "target": target})
        if before_connect is not None:
            before_connect()
        remote = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        remote.settimeout(remaining())
        record["upstream_tcp_attempts"] = 1
        remote.connect(upstream)
        record["phase"] = "upstream_connect"
        if before_connect is not None:
            before_connect()
        remote.settimeout(remaining())
        record["upstream_connect_requests"] = 1
        remote.sendall(f"CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\n\r\n".encode())
        response = header(remote)
        status = response.split(b"\r\n", 1)[0].split()
        if (len(status) < 2 or status[0] not in (b"HTTP/1.0", b"HTTP/1.1")
                or len(status[1]) != 3 or not status[1].isdigit()):
            raise ValueError("invalid upstream response")
        record["upstream_status"] = int(status[1])
        if not 200 <= record["upstream_status"] < 300:
            raise ValueError("upstream CONNECT rejected")
        record["phase"] = "tunnel"
        audit({**record, "event": "tunnel_ready"})
        client.settimeout(remaining())
        client.sendall(b"HTTP/1.1 200 Connection Established\r\n\r\n")
        accepted = True
        readers = [client, remote]
        while readers:
            ready, _, _ = select.select(readers, [], [], remaining())
            if not ready:
                raise TimeoutError("relay deadline")
            for source in ready:
                used = record["client_to_upstream_bytes"] + record["upstream_to_client_bytes"]
                source.settimeout(remaining())
                data = source.recv(min(65536, max_bytes - used + 1))
                destination = remote if source is client else client
                if not data:
                    readers.remove(source)
                    try:
                        destination.shutdown(socket.SHUT_WR)
                    except OSError as exc:
                        if exc.errno not in (errno.ENOTCONN, errno.EPIPE):
                            raise
                    continue
                if used + len(data) > max_bytes:
                    raise ValueError("tunnel byte limit")
                key = "client_to_upstream_bytes" if source is client else "upstream_to_client_bytes"
                # sendall hides partial writes on failure. Count each accepted
                # write so disconnects/timeouts cannot erase observed traffic.
                pending = memoryview(data)
                while pending:
                    destination.settimeout(remaining())
                    written = destination.send(pending)
                    if written == 0:
                        raise ConnectionError("tunnel write returned zero")
                    record[key] += written
                    pending = pending[written:]
        record["phase"] = "complete"
    except Exception as exc:
        record["error_kind"] = type(exc).__name__
        record["error"] = str(exc)[:256]
        if not accepted:
            try:
                client.settimeout(max(.001, min(1, deadline - time.monotonic())))
                client.sendall(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n")
            except OSError:
                pass
    finally:
        if remote is not None:
            remote.close()
        client.close()
        record["elapsed_ms"] = round((time.monotonic() - started) * 1000)
        # A failing final audit propagates: callers must not report success.
        audit({**record, "event": "finished"})
    return record
