#!/usr/bin/env python3
"""Minimal TrueNAS WebSocket JSON-RPC client using only the Python standard library."""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import secrets
import socket
import ssl
import struct
import sys
import time
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlparse, urlunparse


class RPCError(RuntimeError):
    def __init__(self, message: str, code: int | None = None, data: Any = None):
        super().__init__(message)
        self.code = code
        self.data = data


@dataclass
class ConnectionConfig:
    url: str
    timeout: float
    insecure: bool


class WebSocketJSONRPCClient:
    def __init__(self, config: ConnectionConfig):
        self.config = config
        self.sock: socket.socket | ssl.SSLSocket | None = None
        self._next_id = 1

    def connect(self) -> None:
        parsed = urlparse(self.config.url)
        host = parsed.hostname
        if not host:
            raise RuntimeError(f"Invalid URL: {self.config.url}")

        port = parsed.port or (443 if parsed.scheme == "wss" else 80)
        path = parsed.path or "/api/current"
        if parsed.query:
            path = f"{path}?{parsed.query}"

        raw_sock = socket.create_connection((host, port), timeout=self.config.timeout)
        raw_sock.settimeout(self.config.timeout)

        if parsed.scheme == "wss":
            context = ssl.create_default_context()
            if self.config.insecure:
                context.check_hostname = False
                context.verify_mode = ssl.CERT_NONE
            sock = context.wrap_socket(raw_sock, server_hostname=host)
        else:
            sock = raw_sock

        ws_key = base64.b64encode(secrets.token_bytes(16)).decode("ascii")
        host_header = host if parsed.port is None else f"{host}:{parsed.port}"
        request = (
            f"GET {path} HTTP/1.1\r\n"
            f"Host: {host_header}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {ws_key}\r\n"
            "Sec-WebSocket-Version: 13\r\n"
            "User-Agent: SilkSpool-TrueNAS-RPC/1.0\r\n"
            "\r\n"
        )
        sock.sendall(request.encode("ascii"))

        response = self._read_http_headers(sock)
        status_line = response.split("\r\n", 1)[0]
        if " 101 " not in status_line:
            raise RuntimeError(f"WebSocket upgrade failed: {status_line}")

        headers = {}
        for line in response.split("\r\n")[1:]:
            if not line or ":" not in line:
                continue
            key, value = line.split(":", 1)
            headers[key.strip().lower()] = value.strip()

        expected_accept = base64.b64encode(
            hashlib.sha1((ws_key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode("ascii")).digest()
        ).decode("ascii")
        actual_accept = headers.get("sec-websocket-accept")
        if actual_accept != expected_accept:
            raise RuntimeError("WebSocket handshake validation failed")

        self.sock = sock

    def close(self) -> None:
        if self.sock is None:
            return
        try:
            self._send_frame(0x8, b"")
        except Exception:
            pass
        try:
            self.sock.close()
        finally:
            self.sock = None

    def call(self, method: str, params: list[Any] | None = None) -> Any:
        if self.sock is None:
            raise RuntimeError("Client is not connected")

        request_id = self._next_id
        self._next_id += 1
        payload = {
            "jsonrpc": "2.0",
            "id": request_id,
            "method": method,
            "params": params or [],
        }
        self._send_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))

        while True:
            message = self._recv_json_message()
            if message.get("id") != request_id:
                continue
            if "error" in message:
                error = message["error"] or {}
                raise RPCError(
                    error.get("message", f"RPC call failed: {method}"),
                    code=error.get("code"),
                    data=error.get("data"),
                )
            return message.get("result")

    def authenticate(self, username: str, api_key: str) -> Any:
        attempts = [
            [{"mechanism": "API_KEY_PLAIN", "username": username, "api_key": api_key}],
            ["API_KEY_PLAIN", username, api_key],
            [{"mechanism": "API_KEY_PLAIN", "params": {"username": username, "api_key": api_key}}],
        ]
        last_error: Exception | None = None

        for params in attempts:
            try:
                return self.call("auth.login_ex", params)
            except RPCError as exc:
                last_error = exc
                message = str(exc).lower()
                if any(token in message for token in ("invalid api key", "authentication", "permission denied")):
                    raise

        if last_error is not None:
            raise last_error
        raise RuntimeError("Authentication failed")

    def _read_http_headers(self, sock_obj: socket.socket | ssl.SSLSocket) -> str:
        data = bytearray()
        while b"\r\n\r\n" not in data:
            chunk = sock_obj.recv(4096)
            if not chunk:
                raise RuntimeError("Socket closed during handshake")
            data.extend(chunk)
        return data.decode("utf-8", errors="replace")

    def _send_text(self, text: str) -> None:
        self._send_frame(0x1, text.encode("utf-8"))

    def _send_frame(self, opcode: int, payload: bytes) -> None:
        if self.sock is None:
            raise RuntimeError("Socket is not connected")

        fin_opcode = 0x80 | (opcode & 0x0F)
        mask_bit = 0x80
        length = len(payload)
        header = bytearray([fin_opcode])

        if length < 126:
            header.append(mask_bit | length)
        elif length < 65536:
            header.append(mask_bit | 126)
            header.extend(struct.pack("!H", length))
        else:
            header.append(mask_bit | 127)
            header.extend(struct.pack("!Q", length))

        mask = secrets.token_bytes(4)
        header.extend(mask)
        masked = bytes(payload[i] ^ mask[i % 4] for i in range(length))
        self.sock.sendall(header + masked)

    def _recv_json_message(self) -> dict[str, Any]:
        text = self._recv_text_message()
        try:
            return json.loads(text)
        except json.JSONDecodeError as exc:
            raise RuntimeError(f"Server returned invalid JSON: {exc}") from exc

    def _recv_text_message(self) -> str:
        fragments: list[bytes] = []
        opcode_seen: int | None = None

        while True:
            opcode, payload, fin = self._recv_frame()

            if opcode == 0x9:  # ping
                self._send_frame(0xA, payload)
                continue
            if opcode == 0xA:  # pong
                continue
            if opcode == 0x8:  # close
                raise RuntimeError("Server closed the WebSocket connection")
            if opcode in (0x1, 0x0):
                if opcode != 0x0 and opcode_seen is None:
                    opcode_seen = opcode
                fragments.append(payload)
                if fin:
                    break
                continue
            raise RuntimeError(f"Unsupported WebSocket opcode: {opcode}")

        if opcode_seen != 0x1:
            raise RuntimeError("Expected text WebSocket frame")
        return b"".join(fragments).decode("utf-8")

    def _recv_frame(self) -> tuple[int, bytes, bool]:
        if self.sock is None:
            raise RuntimeError("Socket is not connected")

        first_two = self._recv_exact(2)
        first, second = first_two[0], first_two[1]
        fin = bool(first & 0x80)
        opcode = first & 0x0F
        masked = bool(second & 0x80)
        length = second & 0x7F

        if length == 126:
            length = struct.unpack("!H", self._recv_exact(2))[0]
        elif length == 127:
            length = struct.unpack("!Q", self._recv_exact(8))[0]

        mask = self._recv_exact(4) if masked else b""
        payload = self._recv_exact(length) if length else b""

        if masked:
            payload = bytes(payload[i] ^ mask[i % 4] for i in range(length))

        return opcode, payload, fin

    def _recv_exact(self, length: int) -> bytes:
        if self.sock is None:
            raise RuntimeError("Socket is not connected")

        chunks = bytearray()
        while len(chunks) < length:
            chunk = self.sock.recv(length - len(chunks))
            if not chunk:
                raise RuntimeError("Socket closed unexpectedly")
            chunks.extend(chunk)
        return bytes(chunks)


def normalize_url(raw_url: str) -> str:
    parsed = urlparse(raw_url)
    if not parsed.scheme:
        raise RuntimeError("TRUENAS_API_URL must include a scheme, e.g. https://truenas.example.com/api/current")

    if parsed.scheme in {"http", "https"}:
        scheme = "wss" if parsed.scheme == "https" else "ws"
        path = parsed.path or "/api/current"
        if path == "/":
            path = "/api/current"
        parsed = parsed._replace(scheme=scheme, path=path)
    elif parsed.scheme in {"ws", "wss"}:
        path = parsed.path or "/api/current"
        if path == "/":
            path = "/api/current"
        parsed = parsed._replace(path=path)
    else:
        raise RuntimeError(f"Unsupported URL scheme: {parsed.scheme}")

    if parsed.scheme != "wss":
        raise RuntimeError("API key auth requires a TLS URL (https://... or wss://...)")

    return urlunparse(parsed)


def json_arg(value: str) -> Any:
    try:
        return json.loads(value)
    except json.JSONDecodeError as exc:
        raise argparse.ArgumentTypeError(f"Invalid JSON: {exc}") from exc


def wait_for_job(client: WebSocketJSONRPCClient, job_id: int, timeout: float) -> Any:
    last_error: Exception | None = None
    for params in ([job_id], [job_id, timeout]):
        try:
            return client.call("core.job_wait", params)
        except Exception as exc:
            last_error = exc

    deadline = time.time() + timeout
    while time.time() < deadline:
        jobs = None
        for params in ([], [[]]):
            try:
                jobs = client.call("core.get_jobs", params)
                break
            except Exception as exc:
                last_error = exc

        if isinstance(jobs, list):
            for job in jobs:
                if isinstance(job, dict) and job.get("id") == job_id:
                    state = str(job.get("state", "")).upper()
                    if state in {"SUCCESS", "FAILED", "ABORTED"}:
                        return job
        time.sleep(1)

    if last_error is not None:
        raise RuntimeError(f"Timed out waiting for job {job_id}: {last_error}")
    raise RuntimeError(f"Timed out waiting for job {job_id}")


def maybe_wait_for_job(client: WebSocketJSONRPCClient, result: Any, timeout: float) -> Any:
    if isinstance(result, int):
        return wait_for_job(client, result, timeout)
    if isinstance(result, dict) and isinstance(result.get("job_id"), int):
        return wait_for_job(client, result["job_id"], timeout)
    return result


def emit_json(payload: Any) -> None:
    json.dump(payload, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="TrueNAS WebSocket JSON-RPC helper")
    parser.add_argument("--url", required=True, help="TrueNAS API URL, e.g. https://truenas.example.com/api/current")
    parser.add_argument("--username", required=True, help="TrueNAS username that owns the API key")
    parser.add_argument("--api-key-env", default="TRUENAS_API_KEY", help="Environment variable containing the API key")
    parser.add_argument("--timeout", type=float, default=30.0, help="Socket timeout in seconds")
    parser.add_argument("--job-timeout", type=float, default=300.0, help="Job wait timeout in seconds")
    parser.add_argument("--insecure", action="store_true", help="Disable TLS certificate verification")

    subparsers = parser.add_subparsers(dest="command", required=True)

    call_parser = subparsers.add_parser("call", help="Call a JSON-RPC method")
    call_parser.add_argument("method", help="TrueNAS JSON-RPC method name")
    call_parser.add_argument("--args", default="[]", type=json_arg, help="JSON array of method arguments")
    call_parser.add_argument("--wait-job", action="store_true", help="Wait for job completion if the result is a job id")

    job_wait_parser = subparsers.add_parser("job-wait", help="Wait for a job id")
    job_wait_parser.add_argument("job_id", type=int, help="TrueNAS job id")

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    api_key = os.environ.get(args.api_key_env, "")
    if not api_key:
        print(f"ERROR: environment variable {args.api_key_env} is empty", file=sys.stderr)
        return 1

    try:
        url = normalize_url(args.url)
        client = WebSocketJSONRPCClient(ConnectionConfig(url=url, timeout=args.timeout, insecure=args.insecure))
        client.connect()
        try:
            client.authenticate(args.username, api_key)

            if args.command == "call":
                if not isinstance(args.args, list):
                    raise RuntimeError("--args must be a JSON array, e.g. '[1, {\"name\": \"tank\"}]'")
                result = client.call(args.method, args.args)
                if args.wait_job:
                    result = maybe_wait_for_job(client, result, args.job_timeout)
                emit_json(result)
                return 0

            if args.command == "job-wait":
                emit_json(wait_for_job(client, args.job_id, args.job_timeout))
                return 0

            raise RuntimeError(f"Unknown command: {args.command}")
        finally:
            client.close()
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
