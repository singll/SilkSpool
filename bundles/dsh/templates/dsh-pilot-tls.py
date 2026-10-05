#!/usr/bin/env python3
"""One TLS-only probe through an explicit HTTP proxy; caller enforces Scope."""
import hashlib
import ipaddress
import math
import socket
import ssl
import time


def diagnose_tls(proxy_host, proxy_port, target_ip, hostname, *, timeout=15,
                 target_port=443, context=None):
    """No DNS, HTTP application data, retries, fallback, or configuration writes.

    Numeric addresses may be loopback for controlled fixtures. This helper is
    not an authorization boundary: the caller must check Scope and route policy.
    """
    for address in (proxy_host, target_ip):
        ipaddress.IPv4Address(address)
    for port in (proxy_port, target_port):
        if isinstance(port, bool) or not isinstance(port, int) or not 1 <= port <= 65535:
            raise ValueError("invalid port")
    if (not isinstance(hostname, str) or not hostname or len(hostname) > 253
            or any(c not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.-"
                   for c in hostname)):
        raise ValueError("invalid DNS hostname")
    if isinstance(timeout, bool) or not math.isfinite(timeout) or not 0 < timeout <= 30:
        raise ValueError("timeout must be within 30 seconds")
    ctx = context if context is not None else ssl.create_default_context()
    if not ctx.check_hostname or ctx.verify_mode != ssl.CERT_REQUIRED:
        raise ValueError("TLS verification is required")
    started = time.monotonic()
    deadline = started + timeout
    report = dict(phase="proxy_tcp", ok=False, tcp_attempts=0, connect_requests=0,
                  tls_attempts=0, application_requests=0, retries=0,
                  peer_certificate=None, proxy_internal_attempts="unknown")
    sock = None

    def remaining():
        value = deadline - time.monotonic()
        if value <= 0:
            raise TimeoutError("diagnostic deadline exceeded")
        return value

    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(remaining())
        report["tcp_attempts"] = 1
        sock.connect((proxy_host, proxy_port))
        report["phase"] = "proxy_connect"
        authority = f"{target_ip}:{target_port}"
        request = f"CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\n\r\n".encode()
        sock.settimeout(remaining())
        report["connect_requests"] = 1
        sock.sendall(request)
        header = bytearray()
        # Read only through the header terminator, never consume TLS bytes.
        while not header.endswith(b"\r\n\r\n"):
            if len(header) >= 16384:
                raise ValueError("CONNECT response headers exceed limit")
            sock.settimeout(remaining())
            byte = sock.recv(1)
            if not byte:
                raise EOFError("proxy closed before CONNECT response")
            header.extend(byte)
        report["connect_header_sha256"] = hashlib.sha256(header).hexdigest()
        status_line = bytes(header).split(b"\r\n", 1)[0].split()
        if (len(status_line) < 2 or status_line[0] not in (b"HTTP/1.0", b"HTTP/1.1")
                or len(status_line[1]) != 3 or not status_line[1].isdigit()):
            raise ValueError("invalid CONNECT response")
        report["connect_status"] = int(status_line[1])
        if not 200 <= report["connect_status"] < 300:
            report["error_kind"] = "proxy_rejected"
            return report
        report["phase"] = "tls_handshake"
        sock.settimeout(remaining())
        sock = ctx.wrap_socket(sock, server_hostname=hostname, do_handshake_on_connect=False)
        report["tls_attempts"] = 1
        sock.do_handshake()
        cert = sock.getpeercert()
        report["peer_certificate"] = {
            "sha256": hashlib.sha256(sock.getpeercert(binary_form=True)).hexdigest(),
            "subject": cert.get("subject"), "issuer": cert.get("issuer"),
            "subject_alt_name": cert.get("subjectAltName"),
            "not_before": cert.get("notBefore"), "not_after": cert.get("notAfter"),
        }
        report.update(ok=True, phase="complete", tls_version=sock.version())
    except ssl.SSLCertVerificationError as exc:
        report.update(error_kind="certificate_verification", verify_code=exc.verify_code,
                      verify_message=exc.verify_message)
    except (OSError, ValueError, EOFError) as exc:
        report.update(error_kind="timeout" if isinstance(exc, TimeoutError) else type(exc).__name__,
                      error=str(exc)[:512])
    finally:
        if sock is not None:
            sock.close()
        report["elapsed_ms"] = round((time.monotonic() - started) * 1000)
    return report
