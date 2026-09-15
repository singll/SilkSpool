#!/usr/bin/env python3
"""在无外网隔离副本中以本地流式模型验证真实 headless；请求正文只留私有证据。"""
import http.server
import json
import os
from pathlib import Path
import subprocess
import threading
import time
import re
import yaml

BASE = Path(os.environ["SEC_BASE_DIR"])
DATA = Path(os.environ["DSH_HOME"])
OUT = Path("/tmp/dsh-rehearsal")
REQUESTS = []
DIRECT_GETS = []
PREVIEW_NAME = "u2-preview.md"


class Model(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_args):
        pass

    def do_GET(self):
        DIRECT_GETS.append(self.path)
        body = b"U2_OUTSIDE_SCOPE_REACHED"
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        REQUESTS.append(body)
        (OUT / f"model-request-{len(REQUESTS):03d}.json").write_text(json.dumps(body, ensure_ascii=False, indent=2))
        if self.headers.get("Authorization") != "Bearer fixture-only":
            self.send_error(401)
            return
        envelope = {"id": "chatcmpl-u2-fixture", "object": "chat.completion.chunk", "created": 1,
                    "model": body["model"]}
        case = next((m[1] for message in body.get("messages", [])
                     if (m := re.search(r"\[u2:([a-z-]+)\]", str(message.get("content", ""))))), "plain")
        if case == "child-slow":
            time.sleep(12)
        if case == "child-fail" or body.get("model") == "fixture-failing":
            data = json.dumps({"error": {"message": "isolated fixture failure", "type": "server_error"}}).encode()
            self.send_response(400 if case == "child-fail" else 503)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        calls = {
            "stream-tool": ("bus_status", {}),
            "reasoning-tool": ("bus_status", {}),
            "scope-deny": ("exec_run_cli", {"tool": "httpx", "params": {"target": "https://u2-outside.invalid"}}),
            "native-fetch": ("web_fetch", {"url": "http://127.0.0.1:3099/outside-scope"}),
            "native-bash": ("bash", {"command": "curl -fsS http://127.0.0.1:3099/outside-scope-bash", "description": "Isolated Scope denial fixture"}),
            "browser-outside": ("browser_open", {"url": "http://127.0.0.1:3099/outside-scope-browser"}),
            "worker-cancel": ("exec_spawn_worker", {"task": "[u2:child-slow] Isolated cancellation fixture " + str(time.time_ns()), "timeout": 30,
                "provider": "upgrade-fixture", "model": "fixture"}),
        }
        calls.update({
            "deliver-file": [("write", {"file_path": PREVIEW_NAME, "content": "# U2_PREVIEW_CONTENT\n\nIsolated file preview fixture.\n"}),
                             ("present", {"files": [{"path": PREVIEW_NAME, "description": "Isolated upgrade preview"}]})],
            "file-write": [("write", {"file_path": "artifact.txt", "content": "U2_LOCAL_WRITE"})],
            "file-edit": [("read", {"file_path": "existing.txt"}), ("edit", {"file_path": "existing.txt", "old_string": "BEFORE", "new_string": "AFTER"})],
            "file-outside": [("write", {"file_path": "../outside.txt", "content": "DENIED"})],
            "file-symlink": [("write", {"file_path": "linked/guard-sentinel.txt", "content": "DENIED"})],
            "file-control": [("write", {"file_path": "worker-session.json", "content": "DENIED"})],
            "run-artifact": [("write", {"file_path": "artifact.txt", "content": "U2_LOCAL_WRITE"})],
        })
        sequence = calls.get(case, [])
        if isinstance(sequence, tuple):
            sequence = [sequence]
        completed = sum(m.get("role") == "tool" for m in body.get("messages", []))
        invoke = body.get("tools") and completed < len(sequence)
        finish = "stop"
        if invoke:
            tool, args = sequence[completed]
            arguments = json.dumps(args)
            pieces = [json.dumps({**envelope, "choices": [{"index": 0, "delta": {"role": "assistant", "tool_calls": [{
                "index": 0, "id": "call_u2_fixture_" + str(completed), "type": "function", "function": {"name": tool, "arguments": arguments[:1]}}]}, "finish_reason": None}]})]
            pieces.append(json.dumps({**envelope, "choices": [{"index": 0, "delta": {"tool_calls": [{
                "index": 0, "function": {"arguments": arguments[1:]}}]}, "finish_reason": None}]}))
            finish = "tool_calls"
            if case == "reasoning-tool":
                pieces.insert(0, json.dumps({**envelope, "choices": [{"index": 0, "delta": {
                    "role": "assistant", "reasoning_content": "U2_TEST_REASONING"}, "finish_reason": None}]}))
        else:
            pieces = [json.dumps({**envelope, "choices": [{"index": 0, "delta": {"role": "assistant", "content": text}, "finish_reason": None}]})
                      for text in ("U2_", "FIXTURE_", "OK")]
        pieces.append(json.dumps({**envelope, "choices": [{"index": 0, "delta": {}, "finish_reason": finish}],
                                  "usage": {"prompt_tokens": 16, "completion_tokens": 4, "total_tokens": 20}}))
        data = "".join("data: " + piece + "\n\n" for piece in [*pieces, "[DONE]"]).encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        for chunk in (data[:71], data[71:193], data[193:]):
            self.wfile.write(chunk)
            self.wfile.flush()
            time.sleep(0.01)


def main():
    if not (OUT / "isolation.json").is_file():
        raise RuntimeError("只能在隔离启动器中运行")
    settings = {"llm-pi-ai": {"providers": {"upgrade-fixture": {"api": "openai-completions",
                 "baseURL": "http://127.0.0.1:3099/v1", "apiKeyEnv": "DSH_UPGRADE_FIXTURE_KEY",
                 "models": [{"id": "fixture", "reasoningEfforts": False}]}}},
                "agent-default-model": {"provider": "upgrade-fixture", "model": "fixture"}}
    (DATA / "settings.yaml").write_text(yaml.safe_dump(settings))
    patch = OUT / "headless-isolation.patch.yml"
    patch.write_text(yaml.safe_dump([
        {"id": "model-failover", "config": {"enabled": False}},
        {"id": "sec-cli-adapter", "config": {"sidecars": False}},
        {"id": "sec-domain-bus", "config": {"startDispatcherTimer": False}},
        {"id": "sec-memcore", "config": {"sweeper": False, "agentsMd": False, "vaultExport": False}},
    ]))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 3099), Model)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    report = {"ok": False, "checks": []}
    try:
        for case in ("plain", "stream-tool", "scope-deny", "native-fetch", "native-bash", "file-write", "file-edit", "file-outside", "file-symlink", "file-control", "run-artifact"):
            command = ["/usr/local/node/bin/node", str(BASE / "app/node_modules/@deepseek-ai/dsh/lib/bin.js"),
                       "--profile", "headless", "--patch", str(patch), f"[u2:{case}] Isolated upgrade fixture. No external operations."]
            fixture_cwd = OUT / ("worker-" + case)
            if case in {"file-control", "run-artifact"}:
                fixture_cwd = DATA / "results" / ("wfixture" + str(time.time_ns()))
            fixture_cwd.mkdir()
            if case == "file-edit":
                (fixture_cwd / "existing.txt").write_text("BEFORE")
            if case == "file-symlink":
                (fixture_cwd / "linked").symlink_to(DATA, target_is_directory=True)
            start, gets_before = len(REQUESTS), len(DIRECT_GETS)
            result = subprocess.run(command, cwd=fixture_cwd, env={**os.environ, "DSH_UPGRADE_FIXTURE_KEY": "fixture-only"},
                                    stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=60)
            (OUT / (case + ".log")).write_text(result.stdout + result.stderr)
            primary = [r for r in REQUESTS[start:] if r.get("tools")]
            responses = [m.get("content") for m in (primary[-1].get("messages", []) if primary else []) if m.get("role") == "tool"]
            expected_calls = 0 if case == "plain" else 2 if case == "file-edit" else 1
            ok = result.returncode == 0 and "U2_FIXTURE_OK" in result.stdout and len(primary) == expected_calls + 1
            check = {"check": case, "ok": ok, "exit_code": result.returncode, "model_requests": len(REQUESTS) - start,
                     "agent_requests": len(primary), "tool_results": len(responses), "direct_target_requests": len(DIRECT_GETS) - gets_before}
            if case != "plain":
                check["ok"] = check["ok"] and len(responses) == expected_calls
            if case in {"scope-deny", "native-fetch", "native-bash"}:
                content = json.dumps(responses, ensure_ascii=False)
                check["scope_denied"] = bool(re.search("E_EXEC_SCOPE_DENIED|E_SCOPE_NATIVE_TOOL|scope-guard|Scope.*拒绝", content))
                check["ok"] = check["ok"] and check["scope_denied"] and check["direct_target_requests"] == 0
            if case in {"file-outside", "file-symlink", "file-control"}:
                check["scope_denied"] = "E_SCOPE_FILE_WRITE" in json.dumps(responses, ensure_ascii=False)
                check["ok"] = check["ok"] and check["scope_denied"]
            if case in {"file-write", "run-artifact"}:
                check["ok"] = check["ok"] and (fixture_cwd / "artifact.txt").read_text() == "U2_LOCAL_WRITE"
            if case == "file-edit":
                check["ok"] = check["ok"] and (fixture_cwd / "existing.txt").read_text() == "AFTER"
            report["checks"].append(check)
            if primary:
                report["registered_tool_count"] = len(primary[0].get("tools", []))
        report["ok"] = all(row["ok"] for row in report["checks"])
    except Exception as error:
        report["error"] = {"type": type(error).__name__, "message": str(error)}
    finally:
        server.shutdown()
        server.server_close()
        report["model_requests"] = len(REQUESTS)
        (OUT / "worker-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(report, ensure_ascii=False))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
