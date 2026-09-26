#!/usr/bin/env python3
"""在 dsh-upgrade-sandbox 内验证真实双 profile、登录链、领域注册与 Session 列表。

只接受隔离启动器；使用独立测试身份，不输出密码、cookie 或 BrowserAuth token。
"""
import base64
import hashlib
import http.client
import http.server
import importlib.util
from http.cookies import SimpleCookie
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import threading
import urllib.parse
import uuid
import yaml

BASE = Path(os.environ["SEC_BASE_DIR"])
DATA = Path(os.environ["DSH_HOME"])
OUT = Path("/tmp/dsh-rehearsal")
NODE = "/usr/local/node/bin/node"
BIN = BASE / "app/node_modules/@deepseek-ai/dsh/lib/bin.js"
DOMAINS = {"bus", "scope", "approval", "asset", "endpoint", "vuln", "task", "fact", "know", "ledger", "report", "proxy", "fgs", "exec", "eval"}


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def flatten(value):
    if isinstance(value, list):
        for row in value:
            yield from flatten(row)
    elif isinstance(value, dict):
        if "id" in value:
            yield value
        for child in value.values():
            if isinstance(child, (dict, list)):
                yield from flatten(child)


def main():
    require((OUT / "isolation.json").is_file(), "只能在隔离启动器内运行")
    require(os.geteuid() != 0 and os.statvfs("/etc").f_flag & os.ST_RDONLY, "宿主文件系统必须只读且应用非 root")
    routes = Path("/proc/net/route").read_text().splitlines()[1:]
    require(not any(line.split()[1] == "00000000" for line in routes), "预演不允许默认出口")
    require("production credentials are not loaded" in (BASE / ".env").read_text(), "生产 .env 未隔离")
    report = {"version": json.loads((BASE / "app/node_modules/@deepseek-ai/dsh/package.json").read_text())["version"],
              "checks": [], "ok": False, "model_requests": 0, "original_settings": "--original-settings" in sys.argv}
    settings = {"llm-pi-ai": {"providers": {"upgrade-fixture": {"api": "openai-completions",
                 "baseURL": "http://127.0.0.1:3099/v1", "apiKeyEnv": "DSH_UPGRADE_FIXTURE_KEY",
                 "retryPolicy": {"mode": "normal", "maxRetries": 1, "backoff": {"initialDelayMs": 10, "maxDelayMs": 10, "jitterRatio": 0}},
                 "models": [{"id": name, "reasoningEfforts": False} for name in ("fixture", "fixture-failing")]}}},
                "agent-default-model": {"provider": "upgrade-fixture", "model": "fixture"}}
    if "--failover" in sys.argv:
        settings["agent-default-model"]["model"] = "fixture-failing"
    if "--original-model-fixture" in sys.argv:
        settings = yaml.safe_load((OUT / "original-settings.yaml").read_text())
        selected = settings["agent-default-model"]
        provider = settings["llm-pi-ai"]["providers"][selected["provider"]]
        provider["baseURL"] = "http://127.0.0.1:3099/v1"
        provider["apiKeyEnv"] = "DSH_UPGRADE_FIXTURE_KEY"
    if not report["original_settings"]:
        (DATA / "settings.yaml").write_text(yaml.safe_dump(settings))
    else:
        isolation = json.loads((OUT / "isolation.json").read_text())
        original = (OUT / "original-settings.yaml").read_bytes()
        require(hashlib.sha256(original).hexdigest() == isolation["original_settings_sha256"], "原模型配置副本哈希不符")
        (DATA / "settings.yaml").write_bytes(original)
    password = "isolated-upgrade-fixture-password"
    salt = bytes(range(16))
    key = hashlib.scrypt(password.encode(), salt=salt, n=65536, r=8, p=1, dklen=32, maxmem=128 * 1024 * 1024)
    encode = lambda raw: base64.urlsafe_b64encode(raw).decode().rstrip("=")
    users = OUT / "users.yaml"
    users.write_text(yaml.safe_dump({"version": 1, "users": {"upgrade-fixture": {"passwordHash": "scrypt$65536$8$1$" + encode(salt) + "$" + encode(key)}}}))
    users.chmod(0o600)
    web = None
    edge = None
    model = None
    model_server = None
    feedback_server = None
    feedback_exports = []
    feedback_test = "--feedback" in sys.argv
    feedback_control = "--feedback-export-control" in sys.argv
    try:
        require(not feedback_control or feedback_test, "反馈外传对照必须与 --feedback 一起运行")
        if any(flag in sys.argv for flag in ("--browser-bin", "--personas", "--workers", "--browser-tools", "--failover", "--maintenance-client", "--original-model-fixture", "--feedback")):
            require(not report["original_settings"], "模型/浏览器验收需使用 fixture 配置")
            spec = importlib.util.spec_from_file_location("fixture_model", Path(__file__).with_name("dsh-upgrade-worker-smoke.py"))
            model = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(model)
            model.PREVIEW_NAME = "u2-preview-" + uuid.uuid4().hex[:10] + ".md"
            model_server = http.server.ThreadingHTTPServer(("127.0.0.1", 3099), model.Model)
            threading.Thread(target=model_server.serve_forever, daemon=True).start()
        rows = {}
        for profile in ("web", "headless"):
            result = subprocess.run([NODE, str(BIN), "--profile", profile, "--dump-config"], cwd=BASE / "app", capture_output=True, text=True, timeout=60)
            (OUT / f"{profile}-config.yml").write_text(result.stdout)
            (OUT / f"{profile}-config.stderr").write_text(result.stderr)
            require(result.returncode == 0, f"{profile} 配置组合失败；详见私有配置日志")
            profile_rows = list(flatten(yaml.load(result.stdout, Loader=yaml.BaseLoader)))
            rows[profile] = {row["id"]: row for row in profile_rows}
            require(all("sec-domain-" + name in rows[profile] for name in DOMAINS), f"{profile} 缺少领域插件")
            report["checks"].append({"check": f"{profile}-composition", "ok": True, "rows": len(rows[profile])})
            if feedback_test:
                expected = {"session-telemetry-otel": {"mode": "DISABLED"},
                            "session-log-deepseek": {"enabled": "false"},
                            "plugin-package-inventory-deepseek": {"enabled": "false"}}
                for name, config in expected.items():
                    require(all(rows[profile].get(name, {}).get("config", {}).get(key) == value for key, value in config.items()),
                            f"{profile} 未显式关闭 {name}；不能由验收覆盖项代替部署配置")
                report["checks"].append({"check": profile + "-deployed-local-feedback-policy", "ok": True})
        overrides = {
            "sec-cli-adapter": {"sidecars": False},
            # 保留宿主门面与 RPC，禁止 dispatcher 执行恢复点内的待投递业务事件。
            "sec-domain-bus": {"startDispatcherTimer": False},
            "sec-memcore": {"sweeper": False, "agentsMd": False, "vaultExport": False},
            "model-failover": {"enabled": False},
            "dsh-auth-gate": {"mode": "password", "cookieSecure": False, "usersFile": str(users)},
            "web-runtime": {"openBrowser": False},
            "plugin-package-inventory-deepseek": {"enabled": False},
            "session-telemetry-otel": {"mode": "DISABLED"},
            "session-log-deepseek": {"enabled": False},
        }
        if report["original_settings"]:
            overrides.pop("model-failover")
        if "--failover" in sys.argv:
            overrides["model-failover"] = {"enabled": True, "modelCircuitThreshold": 1, "platformCircuitThreshold": 2,
                "enableProbe": False, "fallbacks": [{"provider": "upgrade-fixture", "model": "fixture"}]}
        if "--browser-tools" in sys.argv:
            overrides["browser"] = {"executablePath": sys.argv[sys.argv.index("--browser-tools") + 1], "headless": True}
        if "--browser-bin" in sys.argv:
            overrides["bill"] = {"priceOverrides": {"fixture": {"inputPerM": 1, "outputPerM": 4}}}
        if feedback_test:
            class FeedbackCollector(http.server.BaseHTTPRequestHandler):
                def log_message(self, *_):
                    pass

                def do_POST(self):
                    payload = self.rfile.read(int(self.headers.get("Content-Length", "0")))
                    feedback_exports.append({"path": self.path, "bytes": len(payload)})
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(b"{}")

            feedback_server = http.server.ThreadingHTTPServer(("127.0.0.1", 3098), FeedbackCollector)
            threading.Thread(target=feedback_server.serve_forever, daemon=True).start()
            for name in ("session-telemetry-otel", "session-log-deepseek", "plugin-package-inventory-deepseek"):
                overrides.pop(name)
            # Cordis patch 会替换整个 config；正常验收不覆盖此 row。
            # 对照组显式开启，只允许向本机 fixture 接收器发送。
            if feedback_control:
                overrides["session-telemetry-otel"] = {"mode": "FEEDBACK_ONLY",
                    "exporter": {"url": "http://127.0.0.1:3098/v1/logs"}, "processor": {"scheduledDelayMillis": 100}}
        patch = OUT / "isolation.patch.yml"
        applied = [{"id": name, "config": config} for name, config in overrides.items() if name in rows["web"]]
        # 覆盖必须真的落到受管行；web-runtime 是 REQUIRED 行，静默丢弃即验收失败。
        require("web-runtime" in {row["id"] for row in applied}, "隔离配置缺少受管 web-runtime 覆盖")
        patch.write_text(yaml.safe_dump(applied))
        composed = subprocess.run([NODE, str(BIN), "--profile", "web", "--patch", str(patch), "--dump-config"],
                                  cwd=BASE / "app", capture_output=True, text=True, timeout=60)
        (OUT / "isolation-config.yml").write_text(composed.stdout)
        (OUT / "isolation-config.stderr").write_text(composed.stderr)
        require(composed.returncode == 0, "隔离覆盖与 web 组合失败；详见私有配置日志")
        composed_rows = {row["id"]: row for row in flatten(yaml.load(composed.stdout, Loader=yaml.BaseLoader))}
        require(composed_rows.get("web-runtime", {}).get("config", {}).get("openBrowser") == "false",
                "隔离覆盖未生效：web-runtime.openBrowser 未落到目标行")
        report["checks"].append({"check": "isolation-web-runtime-openBrowser", "ok": True})
        if feedback_test:
            final_config = subprocess.run([NODE, str(BIN), "--profile", "web", "--patch", str(patch), "--dump-config"],
                                          cwd=BASE / "app", capture_output=True, text=True, timeout=60)
            require(final_config.returncode == 0, "反馈测试最终配置组合失败")
            final_rows = {row["id"]: row for row in flatten(yaml.load(final_config.stdout, Loader=yaml.BaseLoader))}
            final_mode = final_rows["session-telemetry-otel"].get("config", {}).get("mode")
            report["feedback_final_mode"] = final_mode
            require(final_mode == ("FEEDBACK_ONLY" if feedback_control else "DISABLED"), "测试配置覆盖了部署遥测策略")
        log_path = OUT / "web.log"
        with log_path.open("w") as log:
            web = subprocess.Popen([NODE, str(BIN), "--profile", "web", "--patch", str(patch), "--host", "127.0.0.1", "--port", "3081", "--no-open"],
                                   cwd=BASE / "app", env={**os.environ, "DSH_UPGRADE_FIXTURE_KEY": "fixture-only",
                                                        "DSH_TELEMETRY_OTLP_URL": "http://127.0.0.1:3098/v1/logs"}, stdout=log, stderr=log)
            launch = None
            for _ in range(60):
                if web.poll() is not None:
                    raise RuntimeError("Web 启动进程已退出；详见私有 web.log")
                match = re.search(r"http://127\.0\.0\.1:3081/\?token=[^\s)\x1b]+", log_path.read_text())
                if match:
                    launch = match[0]
                    break
                time.sleep(0.5)
            require(launch is not None, "Web 未完成加载；详见私有 web.log")
            cookies = {}

            def request(method, path, body=None, content_type=None, authenticated=True):
                connection = http.client.HTTPConnection("127.0.0.1", 3081, timeout=20)
                headers = {"Origin": "http://127.0.0.1:3081"}
                if cookies and authenticated:
                    headers["Cookie"] = "; ".join(k + "=" + v for k, v in cookies.items())
                if content_type:
                    headers["Content-Type"] = content_type
                connection.request(method, path, body=body, headers=headers)
                response = connection.getresponse()
                data = response.read()
                for key, value in response.getheaders():
                    if key.lower() == "set-cookie":
                        parsed = SimpleCookie(value)
                        cookies.update({name: cookie.value for name, cookie in parsed.items()})
                status = response.status
                connection.close()
                return status, data

            require(request("GET", "/auth/login")[0] == 200, "登录页面不可用")
            form = urllib.parse.urlencode({"username": "upgrade-fixture", "password": password})
            require(request("POST", "/auth/login", form, "application/x-www-form-urlencoded")[0] == 302 and cookies, "测试身份登录失败")
            launch_path = urllib.parse.urlsplit(launch)
            require(request("GET", launch_path.path + "?" + launch_path.query)[0] in (200, 302, 303), "BrowserAuth token 兑换失败")
            status, html = request("GET", "/")
            require(status == 200 and b"__DSH_BOOT__" in html, "完整登录后未获得 Web 应用")
            report["checks"].append({"check": "password-login-browser-cookie-app", "ok": True})

            def rpc(channel, method, payload):
                body = json.dumps({"type": "client-request", "rpcId": "upgrade-" + method, "method": method, "payload": payload})
                status, data = request("POST", channel + "/" + method, body, "application/json")
                if status != 200:
                    (OUT / "rpc-failure.txt").write_bytes(data)
                require(status == 200, f"RPC HTTP {status}：" + method)
                result = json.loads(data)["result"]
                require(result.get("ok"), "RPC 拒绝：" + method)
                return result["value"]

            for _ in range(40):
                state = rpc("/silksec-domain", "bus.status", {})
                require(state.get("ok"), "领域总线状态失败")
                report["domain_runtime"] = state["data"]["domains"]
                registered = {row["domain"] for row in state["data"]["domains"] if row["registered"] and row["backend_reachable"]}
                if DOMAINS <= registered:
                    break
                time.sleep(0.5)
            require(DOMAINS <= registered, "实际加载缺少可用领域")
            report["checks"].append({"check": "runtime-domains-and-backends", "ok": True, "domains": len(registered)})
            rpc("/silksec-dashboard", "stats", {})
            workspaces = rpc("/silksec-dashboard", "workspaces", {})
            require(workspaces.get("available") and workspaces.get("items"), "工作区列表不可用")
            total = 0
            for workspace in workspaces["items"]:
                sessions = rpc("/silksec-dashboard", "sessions", {"workspace_id": workspace["id"]})
                require(sessions.get("available") and isinstance(sessions.get("items"), list), "Session 列表不可用或形状错误")
                require(all(row.get("id") and row.get("created_at") for row in sessions["items"]), "Session 列表含空 ID/时间")
                total += len(sessions["items"])
            require(total > 0, "工作区内没有 Session")
            report["checks"].append({"check": "dashboard-stats-and-session-list", "ok": True, "sessions": total, "workspaces": len(workspaces["items"])})
            status, _ = request("POST", "/silksec-domain/bus.status", "{}", "application/json", authenticated=False)
            require(status in (401, 403), "未登录请求未被拒绝")
            report["checks"].append({"check": "unauthenticated-rpc-refused", "ok": True})
            if feedback_test:
                cwd = OUT / "local-feedback-fixture"
                cwd.mkdir()
                sid = rpc("/api", "session/create", {"args": {"request": {"cwd": str(cwd)}}})["sessionId"]

                def prompt_feedback_fixture():
                    start = len(model.REQUESTS)
                    rpc("/api", "session/prompt", {"args": {"request": {"sessionId": sid, "requestId": str(uuid.uuid4()),
                        "mode": "queue", "content": [{"type": "text", "text": "[u2:plain] Local feedback acceptance fixture."}]}}})
                    for _ in range(200):
                        primary = [r for r in model.REQUESTS[start:] if r.get("tools")]
                        listed = rpc("/api", "session/list", {"args": {"_request": {}}})["items"]
                        if primary and not next(row for row in listed if row["sessionId"] == sid)["running"]:
                            return primary
                        time.sleep(0.1)
                    raise RuntimeError("本地反馈 fixture 会话未结束")

                def feedback_trace():
                    result = subprocess.run([NODE, str(Path(__file__).with_name("dsh-upgrade-session-trace.mjs")), sid],
                                            capture_output=True, text=True, timeout=30)
                    (OUT / "feedback-trace.log").write_text(result.stdout + result.stderr)
                    require(result.returncode == 0, "本地反馈 Session 独立读回失败")
                    return json.loads((OUT / "session-trace.json").read_text())

                prompt_feedback_fixture()
                message_id = feedback_trace()["last_assistant_message_id"]
                require(message_id, "反馈 fixture 缺少已完成助手消息")

                def feedback(method, values):
                    result = rpc("/api", "messageFeedback/" + method, {"args": {"request": {"sessionId": sid, **values}}})
                    require(result.get("ok"), "本地反馈操作失败：" + method)
                    return result["value"]

                first_note, edit_note = "U2_LOCAL_FEEDBACK_CREATE_" + uuid.uuid4().hex, "U2_LOCAL_FEEDBACK_EDIT_" + uuid.uuid4().hex
                first = feedback("put", {"messageId": message_id, "rating": "positive", "note": first_note, "ifVersion": None})
                require(feedback("list", {})["items"] == [first], "新增反馈未读回")
                edited = feedback("put", {"messageId": message_id, "rating": "negative", "note": edit_note, "ifVersion": first["version"]})
                require(edited["version"] != first["version"] and feedback("list", {})["items"] == [edited], "反馈修改未读回")
                require(feedback("delete", {"messageId": message_id, "ifVersion": edited["version"]})["absent"], "反馈撤销未确认")
                require(feedback("list", {})["items"] == [], "撤销后反馈仍可见")
                history = feedback_trace()["feedback_events"]
                require([row["type"] for row in history] == ["feedback/message-put", "feedback/message-put", "feedback/message-delete"]
                        and all(row["session_id"] == sid and row["message_id"] == message_id for row in history), "canonical 反馈轨迹或归因不符")
                next_requests = json.dumps(prompt_feedback_fixture())
                require(first_note not in next_requests and edit_note not in next_requests and "dsh_session_log" not in next_requests
                        and "dsh_plugin_packages" not in next_requests, "本地反馈或额外上报字段进入模型请求")
                report["feedback"] = {"session_id": sid, "canonical_events": len(history), "create_edit_delete": True,
                                      "excluded_from_model_history": True, "export_control": feedback_control}
            if "--original-model-fixture" in sys.argv:
                cwd = OUT / "original-model-fixture"
                cwd.mkdir()
                sid = rpc("/api", "session/create", {"args": {"request": {"cwd": str(cwd)}}})["sessionId"]
                begin = len(model.REQUESTS)
                rpc("/api", "session/prompt", {"args": {"request": {"sessionId": sid, "requestId": str(uuid.uuid4()),
                    "mode": "queue", "content": [{"type": "text", "text": "[u2:reasoning-tool] Isolated original model capability fixture."}]}}})
                primary = []
                for _ in range(200):
                    primary = [r for r in model.REQUESTS[begin:] if r.get("tools")]
                    items = rpc("/api", "session/list", {"args": {"_request": {}}})["items"]
                    if len(primary) >= 2 and not next(row for row in items if row["sessionId"] == sid)["running"]:
                        break
                    time.sleep(0.1)
                report["original_model_fixture"] = {"provider": selected["provider"], "model": selected["model"],
                    "requested_effort": selected.get("reasoningEffort"), "request_count": len(primary),
                    "wire_efforts": [r.get("reasoning_effort") for r in primary]}
                require(len(primary) == 2 and all(r["model"] == selected["model"] for r in primary), "原模型配置的真实流式工具链失败")
                assistant = next(m for m in primary[-1]["messages"] if m.get("role") == "assistant" and m.get("tool_calls"))
                report["original_model_fixture"]["reasoning_replayed"] = assistant.get("reasoning_content") == "U2_TEST_REASONING"
                require(report["original_model_fixture"]["reasoning_replayed"], "原路由未重放工具调用前的 reasoning_content")
                require(all(r.get("reasoning_effort") == "high" for r in primary), "原有 max→high 模型映射未保持")
                report["checks"].append({"check": "original-model-max-effort-and-reasoning-tool-replay", "ok": True})
            if "--maintenance-client" in sys.argv:
                spec = importlib.util.spec_from_file_location("maintenance_client", Path(__file__).with_name("dsh-upgrade-local-client.py"))
                maintenance = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(maintenance)
                users_before = users.read_bytes()
                cwd = OUT / "maintenance-fixture"
                cwd.mkdir()
                sid = rpc("/api", "session/create", {"args": {"request": {"cwd": str(cwd)}}})["sessionId"]
                with maintenance.MaintenanceClient(DATA, OUT, users_file=users, launch_url=launch) as client:
                    client.assert_idle()
                    require(users.read_bytes() == users_before, "维护登录后没有立即还原用户文件")
                    begin = len(model.REQUESTS)
                    rpc("/api", "session/prompt", {"args": {"request": {"sessionId": sid,
                        "requestId": str(uuid.uuid4()), "mode": "queue", "content": [{"type": "text",
                        "text": "[u2:child-slow] Isolated maintenance drain fixture"}]}}})
                    for _ in range(100):
                        if any(r.get("tools") for r in model.REQUESTS[begin:]):
                            break
                        time.sleep(0.1)
                    refused = False
                    try:
                        client.assert_idle()
                    except RuntimeError as error:
                        refused = "原生 Session 仍有" in str(error)
                    require(refused, "维护客户端没有发现正在运行的原生 Session")
                    rpc("/api", "session/cancel", {"args": {"request": {"sessionId": sid}}})
                    for _ in range(100):
                        if client.native_summary()["running"] == 0:
                            break
                        time.sleep(0.1)
                    client.assert_idle()
                require(users.read_bytes() == users_before and not client.cookies, "维护登录未完整清理")
                report["checks"].append({"check": "maintenance-login-native-session-drain-and-cleanup", "ok": True})
            if "--failover" in sys.argv:
                cwd = OUT / "failover-session"
                cwd.mkdir()
                sid = rpc("/api", "session/create", {"args": {"request": {"cwd": str(cwd)}}})["sessionId"]
                begin = len(model.REQUESTS)
                # 某些重试策略在下一轮 request 才重新选路，两种合法时点都检查。
                for attempt in range(2):
                    rpc("/api", "session/prompt", {"args": {"request": {"sessionId": sid,
                        "requestId": str(uuid.uuid4()), "mode": "queue", "content": [{"type": "text",
                        "text": "[u2:failover] Isolated model failover fixture " + str(attempt)}]}}})
                    for _ in range(250):
                        primary = [r for r in model.REQUESTS[begin:] if r.get("tools")]
                        listed = rpc("/api", "session/list", {"args": {"_request": {}}})
                        running = next(row for row in listed["items"] if row["sessionId"] == sid)["running"]
                        if primary and not running:
                            break
                        time.sleep(0.1)
                    require(not running, "失败切换 fixture 未收尾")
                    if any(r.get("model") == "fixture" for r in primary):
                        break
                routes = [r["model"] for r in primary]
                require("fixture-failing" in routes and "fixture" in routes, "实际模型请求未发生失败切换")
                require(all(route == "fixture" for route in routes[routes.index("fixture"):]), "熔断后仍重返故障模型")
                traced = subprocess.run([NODE, str(Path(__file__).with_name("dsh-upgrade-session-trace.mjs")), sid],
                                        capture_output=True, text=True, timeout=30)
                (OUT / "session-trace.log").write_text(traced.stdout + traced.stderr)
                require(traced.returncode == 0, "失败切换 canonical Session 读回失败")
                trace = json.loads((OUT / "session-trace.json").read_text())
                require(any(row.get("model") == "fixture" for row in trace["assistant_routes"]) and trace["fixture_complete"],
                        "失败切换未按实际模型归因并保存最终回复")
                report["failover"] = {"session_id": sid, "request_models": routes,
                    "canonical_assistant_routes": trace["assistant_routes"], "fixture_complete": trace["fixture_complete"]}
                report["checks"].append({"check": "real-model-failure-fallback-and-canonical-attribution", "ok": True})
            if "--browser-tools" in sys.argv:
                cwd = OUT / "browser-tool-scope"
                cwd.mkdir()
                sid = rpc("/api", "session/create", {"args": {"request": {"cwd": str(cwd)}}})["sessionId"]
                begin, gets = len(model.REQUESTS), len(model.DIRECT_GETS)
                rpc("/api", "session/prompt", {"args": {"request": {"sessionId": sid, "requestId": str(uuid.uuid4()), "mode": "queue",
                    "content": [{"type": "text", "text": "[u2:browser-outside] Isolated browser Scope refusal fixture."}]}}})
                primary = []
                for _ in range(200):
                    primary = [r for r in model.REQUESTS[begin:] if r.get("tools")]
                    listed = rpc("/api", "session/list", {"args": {"_request": {}}})
                    if len(primary) >= 2 and not next(row for row in listed["items"] if row["sessionId"] == sid)["running"]:
                        break
                    time.sleep(0.1)
                responses = [m.get("content") for m in primary[-1].get("messages", []) if m.get("role") == "tool"] if primary else []
                report["browser_scope"] = {"direct_target_requests": len(model.DIRECT_GETS) - gets,
                    "scope_denied": "E_SCOPE_BROWSER" in json.dumps(responses), "tool_results": len(responses)}
                require(report["browser_scope"]["direct_target_requests"] == 0 and report["browser_scope"]["scope_denied"],
                        "浏览器原生工具绕过 Scope；详见隔离模型请求证据")
                report["checks"].append({"check": "browser-tool-scope-refused", "ok": True})
            if "--workers" in sys.argv:
                worker_args = {"task": "[u2:child] Reply U2_FIXTURE_OK. No external operations. " + uuid.uuid4().hex,
                               "timeout": 15, "provider": "upgrade-fixture", "model": "fixture"}
                worker = rpc("/silksec-domain", "exec.spawn_worker", worker_args)
                (OUT / "worker-command.json").write_text(json.dumps(worker, ensure_ascii=False, indent=2))
                report["worker"] = {"domain_ok": worker.get("ok"),
                                    **{k: worker.get("data", {}).get(k) for k in ("ok", "run_id", "exit_code", "session_id", "duration_ms")}}
                require(worker.get("ok") and worker.get("data", {}).get("ok") and worker.get("data", {}).get("exit_code") == 0, "真实 exec worker 未成功完成")
                require(worker.get("data", {}).get("session_id"), "真实 exec worker 缺少自身 Session 归属")
                report["checks"].append({"check": "exec-worker-completion-attribution", "ok": True})
                requests_before = len(model.REQUESTS)
                replay = rpc("/silksec-domain", "exec.spawn_worker", worker_args)
                require(replay.get("ok") and replay["data"].get("recovered") and replay["data"]["run_id"] == worker["data"]["run_id"]
                        and replay["data"].get("session_id") == worker["data"]["session_id"] and len(model.REQUESTS) == requests_before,
                        "worker 重试未恢复同一结果/会话或再次调用模型")
                report["checks"].append({"check": "exec-worker-replay-no-respawn", "ok": True})
                for case in ("child-fail", "child-slow"):
                    failed = rpc("/silksec-domain", "exec.spawn_worker", {**worker_args,
                        "task": f"[u2:{case}] Isolated failure fixture " + uuid.uuid4().hex, "timeout": 6})
                    require(failed.get("ok") and failed.get("data", {}).get("ok") is False, "worker 失败被误报成功：" + case)
                    value = failed["data"]
                    stored = rpc("/silksec-domain", "task.worker_status", {"run_id": value["run_id"]})
                    require(stored.get("ok") and stored["data"]["status"] == ("killed" if case == "child-slow" else "failed"), "worker 失败未收尾")
                    if case == "child-slow":
                        require(value.get("timed_out"), "worker 超时标记缺失")
                    require(value.get("session_id") and stored["data"].get("worker_session_id") == value["session_id"], "失败 worker 的子会话归属缺失")
                    report["checks"].append({"check": "exec-worker-" + case, "ok": True})
                cancel_cwd = OUT / "cancel-parent"
                cancel_cwd.mkdir()
                parent = rpc("/api", "session/create", {"args": {"request": {"cwd": str(cancel_cwd)}}})["sessionId"]
                rpc("/api", "session/prompt", {"args": {"request": {"sessionId": parent, "requestId": str(uuid.uuid4()), "mode": "queue",
                    "content": [{"type": "text", "text": "[u2:worker-cancel] Isolated cancellation fixture."}]}}})
                live = None
                for _ in range(120):
                    workers = rpc("/silksec-domain", "task.worker_list", {"status": "running"})
                    live = next((row for row in workers.get("rows", []) if row.get("session_id") == parent), None)
                    if live and any("[u2:child-slow] Isolated cancellation fixture" in json.dumps(r.get("messages", [])) for r in model.REQUESTS):
                        break
                    time.sleep(0.1)
                require(live is not None, "工具执行期间未登记 live worker")
                report["checks"].append({"check": "exec-worker-registered-before-completion", "ok": True})
                rpc("/api", "session/cancel", {"args": {"request": {"sessionId": parent}}})
                for _ in range(120):
                    stopped = rpc("/silksec-domain", "task.worker_status", {"run_id": live["run_id"]})["data"]
                    if stopped["status"] != "running":
                        break
                    time.sleep(0.1)
                require(stopped["status"] == "killed", "用户停止未传递到真实 worker")
                meta = json.loads((DATA / "results" / live["run_id"] / "meta.json").read_text())
                require(meta.get("cancelled") and not meta.get("timed_out"), "用户取消被错误标记成超时")
                requests_before = len(model.REQUESTS)
                time.sleep(0.5)
                listed = rpc("/api", "session/list", {"args": {"_request": {}}})
                require(not next(row for row in listed["items"] if row["sessionId"] == parent)["running"] and len(model.REQUESTS) == requests_before,
                        "用户停止后会话自行恢复")
                report["checks"].append({"check": "session-cancel-stops-worker-without-resume", "ok": True})
            if "--personas" in sys.argv:
                persona_report = []
                for preset in ("recon", "vuln-hunt", "biz-logic", "code-audit", "intranet", "review", "orchestrator"):
                    cwd = OUT / ("persona-" + preset)
                    cwd.mkdir(exist_ok=True)
                    marker = "[u2:persona-" + preset + "]"
                    created = rpc("/api", "session/create", {"args": {"request": {"cwd": str(cwd), "agentPreset": preset}}})
                    session_id = created["sessionId"]
                    begin = len(model.REQUESTS)
                    rpc("/api", "session/prompt", {"args": {"request": {"sessionId": session_id, "requestId": str(uuid.uuid4()), "mode": "queue",
                        "content": [{"type": "text", "text": marker + " Reply U2_FIXTURE_OK. No external operations."}]}}})
                    primary = []
                    for _ in range(100):
                        primary = [r for r in model.REQUESTS[begin:] if r.get("tools") and marker in json.dumps(r.get("messages", []))]
                        listed = rpc("/api", "session/list", {"args": {"_request": {}}})
                        row = next((r for r in listed["items"] if r["sessionId"] == session_id), None)
                        if primary and row and not row["running"] and not row["blank"]:
                            break
                        time.sleep(0.1)
                    require(len(primary) == 1 and row and not row["running"], "角色未完成实际请求：" + preset)
                    assembled = "\n".join(m["content"] if isinstance(m.get("content"), str) else json.dumps(m.get("content"), ensure_ascii=False)
                                          for m in primary[0]["messages"] if m.get("role") in ("system", "developer"))
                    parts = json.loads(subprocess.check_output(["python3", str(BASE / "plugins/sec-suite/persona.py"), "read",
                        str(DATA / ".agent-presets" / preset / "agent.cordis.yml")], text=True))
                    for part in (parts["prefix"], parts["suffix"]):
                        pattern = re.escape(part).replace(re.escape("{{model}}"), r".+?").replace(re.escape("{{cwd}}"), re.escape(str(cwd)))
                        require(not part or re.search(pattern, assembled, re.S), "最终 prompt 缺少角色/工作区文本：" + preset)
                    require("{{cwd}}" not in assembled and "{{model}}" not in assembled and "finding_add" not in assembled,
                            "最终 prompt 有未替换变量/废弃 finding_add：" + preset)
                    tools = {tool["function"]["name"] for tool in primary[0]["tools"]}
                    required = {"bus_status", "exec_run_cli", "exec_spawn_worker", "read", "write", "edit", "scope_check"}
                    require(required <= tools, "角色缺少实际工具：" + preset + " " + str(sorted(required - tools)))
                    require("scope" in assembled.lower() and ("授权" in assembled or "permission" in assembled.lower()), "角色缺少授权指导")
                    (OUT / ("persona-" + preset + "-prompt.txt")).write_text(assembled)
                    persona_report.append({"preset": preset, "session_id": session_id, "tool_count": len(tools),
                                           "prompt_sha256": hashlib.sha256(assembled.encode()).hexdigest(), "ok": True})
                report["personas"] = persona_report
                report["checks"].append({"check": "seven-personas-actual-model-assembly", "ok": True})
            if "--browser-bin" in sys.argv:
                browser_bin = sys.argv[sys.argv.index("--browser-bin") + 1]
                require(Path(browser_bin).is_file(), "未找到隔离浏览器")
                caddyfile = OUT / "Caddyfile"
                # 与部署 edge 相同的 DSH Host/Origin 转发规则；不加载其 CDP 凭据段。
                caddyfile.write_text('''{
    admin off
    auto_https off
}
http://:3080 {
    reverse_proxy 127.0.0.1:3081 {
        header_up Host 127.0.0.1:3081
        header_up Origin "http://127.0.0.1:3081"
    }
}
''')
                with (OUT / "edge.log").open("w") as edge_log:
                    edge = subprocess.Popen(["/usr/bin/caddy", "run", "--config", str(caddyfile), "--adapter", "caddyfile"],
                                            stdout=edge_log, stderr=edge_log,
                                            env={**os.environ, "XDG_DATA_HOME": str(OUT / "caddy-data"), "XDG_CONFIG_HOME": str(OUT / "caddy-config")})
                for _ in range(30):
                    try:
                        conn = http.client.HTTPConnection("127.0.0.1", 3080, timeout=1)
                        conn.request("GET", "/auth/login")
                        ready = conn.getresponse().status == 200
                        conn.close()
                        if ready:
                            break
                    except OSError:
                        pass
                    time.sleep(0.1)
                browser_config = OUT / "browser-private.json"
                browser_config.write_text(json.dumps({"url": "http://upgrade.test:3080", "launchUrl": launch.replace("127.0.0.1:3081", "upgrade.test:3080"),
                                                       "username": "upgrade-fixture", "password": password, "binary": browser_bin,
                                                       "previewName": model.PREVIEW_NAME}))
                result = subprocess.run([NODE, str(Path(__file__).with_name("dsh-upgrade-browser-smoke.mjs")), str(browser_config)],
                                        capture_output=True, text=True, timeout=180)
                (OUT / "browser.log").write_text(result.stdout + result.stderr)
                browser_report = json.loads((OUT / "browser-report.json").read_text())
                report["browser"] = browser_report
                require(result.returncode == 0 and browser_report.get("ok"), "浏览器实际操作未通过；详见 browser-report.json")
            report["ok"] = True
    except Exception as error:
        report["error"] = {"type": type(error).__name__, "message": str(error)}
    finally:
        if edge is not None and edge.poll() is None:
            edge.terminate()
            edge.wait(timeout=10)
        if web is not None and web.poll() is None:
            web.terminate()
            try:
                web.wait(timeout=15)
            except subprocess.TimeoutExpired:
                web.kill()
                web.wait()
        if model_server is not None:
            model_server.shutdown()
            model_server.server_close()
            report["model_requests"] = len(model.REQUESTS)
        if feedback_server is not None:
            feedback_server.shutdown()
            feedback_server.server_close()
            report.setdefault("feedback", {})["export_requests"] = len(feedback_exports)
            if report["ok"]:
                expected = len(feedback_exports) > 0 if feedback_control else len(feedback_exports) == 0
                if not expected:
                    report["ok"] = False
                    report["error"] = {"type": "FeedbackExportMismatch", "message": "反馈外传检测结果与部署策略/对照不符"}
                else:
                    report["checks"].append({"check": "feedback-local-canonical-no-export" if not feedback_control else "feedback-export-detector-positive-control", "ok": True})
        (OUT / "runtime-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(report, ensure_ascii=False))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
