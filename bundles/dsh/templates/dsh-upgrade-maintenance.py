#!/usr/bin/env python3
"""在隔离副本或持有冻结点的生产切换窗口做最小启动验收，结束后保持写者停止。

复用正常 web 启动参数，只临时关闭调度/dispatcher/memcore 后台写者。
config 覆盖保留原字段；不修改 profile、模型设置或持久化业务配置。
"""
import argparse
import copy
import hashlib
import http.client
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import time
import yaml


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


release = module("release", "dsh-upgrade-release.py")
snapshot, freeze = release.snapshot, release.freeze
client_module = module("client", "dsh-upgrade-local-client.py")
NODE = "/usr/local/node/bin/node"
UNIT = "silksecagent.service"
DROPIN = Path("/run/systemd/system/silksecagent.service.d/91-dsh-upgrade-maintenance.conf")
# 无需在 systemd ExecStart 中转义的参数字符集；npm 作用域名（@scope）在此类路径中合法。
SAFE_SYSTEMD_ARG = re.compile(r"[A-Za-z0-9_./@:=+-]+\Z")
DOMAINS = {"bus", "scope", "approval", "asset", "endpoint", "vuln", "task", "fact", "know", "ledger", "report", "proxy", "fgs", "exec", "eval"}
OVERRIDES = {
    "sec-cli-adapter": {"sidecars": False},
    "sec-domain-bus": {"startDispatcherTimer": False},
    "sec-memcore": {"sweeper": False, "agentsMd": False, "vaultExport": False},
    "model-failover": {"enableProbe": False},
    "web-runtime": {"openBrowser": False},
    "plugin-package-inventory-deepseek": {"enabled": False},
    "session-telemetry-otel": {"mode": "DISABLED"},
    "session-log-deepseek": {"enabled": False},
}
REQUIRED = {"sec-cli-adapter", "sec-domain-bus", "sec-memcore", "web-runtime"}


class UnknownTag:
    """保留上游 tagged YAML 的语法树，Python 不解释或执行其内容。"""
    def __init__(self, node):
        self.node = node

    def __eq__(self, other):
        def value(node):
            if isinstance(node, yaml.ScalarNode):
                return node.tag, node.value
            if isinstance(node, yaml.SequenceNode):
                return node.tag, tuple(value(child) for child in node.value)
            return node.tag, tuple(sorted((value(key), value(child)) for key, child in node.value))
        return isinstance(other, UnknownTag) and value(self.node) == value(other.node)


class ConfigLoader(yaml.SafeLoader):
    pass


class ConfigDumper(yaml.SafeDumper):
    pass


ConfigLoader.add_constructor(None, lambda loader, node: UnknownTag(node))
ConfigDumper.add_representer(UnknownTag, lambda dumper, value: value.node)


def rows(value):
    if isinstance(value, list):
        for child in value:
            yield from rows(child)
    elif isinstance(value, dict):
        if "id" in value:
            yield value
        for child in value.values():
            if isinstance(child, (dict, list)):
                yield from rows(child)


def plain(value):
    if isinstance(value, dict):
        return all(isinstance(key, str) and plain(child) for key, child in value.items())
    if isinstance(value, list):
        return all(plain(child) for child in value)
    return value is None or type(value) in (str, bool, int, float) or isinstance(value, UnknownTag)


def maintenance_patch(composed, expected_version):
    document = yaml.load(composed, Loader=ConfigLoader)
    selected, result = {}, []
    for row in rows(document):
        if row["id"] not in OVERRIDES:
            continue
        release.require(row["id"] not in selected, "维护 row id 不唯一：" + row["id"])
        config = row.get("config") or {}
        release.require(isinstance(config, dict) and plain(config), "维护配置含不可保全的特殊值：" + row["id"])
        selected[row["id"]] = config
        result.append({"id": row["id"], "config": {**copy.deepcopy(config), **OVERRIDES[row["id"]]}})
    required = REQUIRED | ({"session-telemetry-otel", "session-log-deepseek", "plugin-package-inventory-deepseek"}
                           if expected_version == release.VERSION else set())
    release.require(required <= selected.keys(), "缺少已验证的后台写者/遥测配置入口：" + ",".join(sorted(required - selected.keys())))
    return result


def prepare_patch(base, out, expected_version):
    owner = base.stat()
    binary = base / "app/node_modules/@deepseek-ai/dsh/lib/bin.js"
    # 与受管 systemd 服务相同的 web 子命令；实际验证此入口跨版本兼容。
    command = [NODE, str(binary), "web", "--host", "127.0.0.1", "--port", "3081"]
    # --dump-config 不运行 Web 的参数提供器，因此不能携带 host/port 参数。
    compose_command = [NODE, str(binary), "web"]
    environment = {"PATH": "/usr/local/node/bin:/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8", "DSH_HOME": str(base / "data")}
    ids = {"user": owner.st_uid, "group": owner.st_gid, "extra_groups": []} if os.geteuid() == 0 else {}
    result = subprocess.run([*compose_command, "--dump-config"], cwd=base / "app", env=environment,
                            capture_output=True, text=True, timeout=60, **ids)
    (out / "compose.stderr.private.log").write_text(result.stderr)
    (out / "compose.private.yml").write_text(result.stdout)
    release.require(result.returncode == 0, "正常 web 启动参数不能组合配置")
    patch = maintenance_patch(result.stdout, expected_version)
    filename = out / "maintenance.patch.yml"
    filename.write_text(yaml.dump(patch, Dumper=ConfigDumper, allow_unicode=True, sort_keys=False))
    filename.chmod(0o400)
    if os.geteuid() == 0:
        os.chown(filename, owner.st_uid, owner.st_gid)
    verified = subprocess.run([*compose_command, "--patch", str(filename), "--dump-config"], cwd=base / "app", env=environment,
                              capture_output=True, text=True, timeout=60, **ids)
    release.require(verified.returncode == 0, "维护覆盖配置不能组合")
    final = {row["id"]: row for row in rows(yaml.load(verified.stdout, Loader=ConfigLoader))}
    for row in patch:
        release.require(final.get(row["id"], {}).get("config") == row["config"], "维护覆盖丢失原配置字段：" + row["id"])
    # launcher 参数必须在 host/port 等 Web 参数之前，否则会转交 Web parser。
    return [*compose_command, "--patch", str(filename), *command[3:]], {"patch_sha256": snapshot.sha256(filename), "muted_rows": [row["id"] for row in patch]}


def check_runtime(base, out, expected_version, launch_url=None):
    installed = release.read_json(base / "app/node_modules/@deepseek-ai/dsh/package.json")["version"]
    release.require(installed == expected_version, "最小验收运行版本不符")
    with client_module.MaintenanceClient(base / "data", out, launch_url=launch_url) as client:
        native = client.assert_idle()
        release.require(native["sessions"] > 0, "最小验收没有读到历史 Session")
        state = client.rpc("/silksec-domain", "bus.status")
        release.require(state.get("ok"), "领域总线状态失败")
        registered = {row["domain"] for row in state["data"]["domains"] if row["registered"] and row["backend_reachable"]}
        release.require(DOMAINS <= registered, "最小验收缺少已注册领域或后端")
        status, body = client.request("GET", "/")
        release.require(status == 200 and b"__DSH_BOOT__" in body, "认证后 Web 应用不可用")
        client.rpc("/silksec-dashboard", "stats")
        workspaces = client.rpc("/silksec-dashboard", "workspaces")
        release.require(workspaces.get("available") and workspaces.get("items"), "工作区列表不可用")
        count = 0
        for workspace in workspaces["items"]:
            sessions = client.rpc("/silksec-dashboard", "sessions", {"workspace_id": workspace["id"]})
            release.require(sessions.get("available") and all(row.get("id") and row.get("created_at") for row in sessions["items"]),
                            "Session 跳链列表不完整")
            count += len(sessions["items"])
        release.require(count > 0, "工作区 Session 列表为空")
        scope = client.rpc("/silksec-domain", "scope.check", {"target": "https://upgrade-outside.invalid/"})
        release.require(scope.get("ok") and scope["data"].get("allow") is False, "越界 Scope 只读查询未拒绝")
        auth_source = client.browser_auth_source
        users_restored = client.users_file.read_bytes() == (client.state_dir / "users.before").read_bytes()
    release.require(users_restored and not client.authenticated, "维护身份未完整清理")
    unauth = http.client.HTTPConnection("127.0.0.1", 3081, timeout=10)
    try:
        unauth.request("POST", "/silksec-domain/bus.status", "{}", {"Origin": "http://127.0.0.1:3081", "Content-Type": "application/json"})
        response = unauth.getresponse()
        response.read()
        release.require(response.status in (401, 403), "未认证 RPC 未拒绝")
    finally:
        unauth.close()
    return {"version": installed, "native": native, "domains": len(registered), "workspaces": len(workspaces["items"]),
            "listed_sessions": count, "web_application": True, "scope_refusal": True, "unauthenticated_refusal": True,
            "users_restored": True, "logged_out": True, "browser_auth_source": auth_source}


def sandbox_smoke(expected_version):
    out = Path("/tmp/dsh-rehearsal")
    release.require((out / "isolation.json").is_file() and os.geteuid() != 0, "sandbox smoke 只能在隔离启动器内运行")
    base = Path(os.environ["SEC_BASE_DIR"])
    report = {"ok": False, "started_at": snapshot.now(), "mode": "isolated-copy"}
    process = None
    try:
        command, policy = prepare_patch(base, out, expected_version)
        report["policy"] = policy
        logfile = out / "maintenance-web.log"
        with logfile.open("w") as log:
            process = subprocess.Popen(command, cwd=base / "app", stdout=log, stderr=log)
            deadline = time.monotonic() + 60
            while True:
                release.require(process.poll() is None, "维护 Web 启动进程退出；查看私有日志")
                matches = re.findall(r"http://127\.0\.0\.1:3081/\?token=[^\s)\x1b]+", logfile.read_text())
                if matches:
                    break
                release.require(time.monotonic() < deadline, "维护 Web 启动超时")
                time.sleep(0.25)
            report["checks"] = check_runtime(base, out, expected_version, launch_url=matches[-1])
            report["ok"] = True
    except Exception as error:
        report["error"] = {"type": type(error).__name__, "message": str(error)}
    finally:
        if process and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=30)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
                report.update(ok=False, forced_shutdown=True)
        report["finished_at"] = snapshot.now()
        snapshot.write_json(out / "maintenance-report.json", report)
    return report


def cleanup(release_dir):
    state_file = release_dir / "maintenance-state.json"
    state = release.read_json(state_file)
    if state.get("cleaned_at"):
        return state
    if DROPIN.exists():
        release.require(not DROPIN.is_symlink() and snapshot.sha256(DROPIN) == state["dropin_sha256"], "维护 drop-in 被另行修改，拒绝删除")
    freeze.systemctl("stop", UNIT)
    if DROPIN.exists():
        DROPIN.unlink()
    # 兼容删除 drop-in 后、daemon-reload 前中断的恢复。
    freeze.systemctl("daemon-reload")
    state["cleaned_at"] = snapshot.now()
    freeze.save(state_file, state)
    return state


def production_smoke(release_dir, freeze_state):
    release_dir = Path(release_dir).resolve(strict=True)
    state = release.read_json(release_dir / "state.json")
    release.require(not state["restore_copy"] and state["phase"] in {"switched", "rolled-back"}, "生产维护只允许已切换/回滚且未放行的版本")
    release.assert_held(state, freeze_state)
    release.require(not DROPIN.exists(), "已存在维护 drop-in，先使用 cleanup 校验并清理")
    base = Path(state["roots"]["dsh"]["current"])
    expected = release.VERSION if state["phase"] == "switched" else release.OLD_VERSION
    owner = base.stat()
    temporary = Path(tempfile.mkdtemp(prefix="silksecagent-upgrade-", dir="/run"))
    os.chown(temporary, owner.st_uid, owner.st_gid)
    report = {"ok": False, "started_at": snapshot.now(), "mode": "production-maintenance", "release": str(release_dir)}
    installed = False
    try:
        command, policy = prepare_patch(base, temporary, expected)
        original = freeze.systemctl("show", UNIT, "-p", "ExecStart", "--value")
        # 仅接受已预演的普通 web 服务入口，不丢弃未知启动选项。
        normal = " ".join(command[:3] + command[5:])
        release.require("argv[]=" + normal + " ;" in original, "生产启动参数与已预演入口不同")
        release.require(all(SAFE_SYSTEMD_ARG.fullmatch(item) for item in command), "维护命令含未支持的 systemd 转义")
        content = "[Service]\nExecStart=\nExecStart=" + " ".join(command) + "\nRestart=no\n"
        maintenance = {"started_at": report["started_at"], "temporary": str(temporary), "dropin": str(DROPIN),
                       "dropin_sha256": hashlib.sha256(content.encode()).hexdigest(), "version": expected, "policy": policy}
        freeze.save(release_dir / "maintenance-state.json", maintenance)
        DROPIN.parent.mkdir(parents=True, exist_ok=True)
        DROPIN.write_text(content)
        DROPIN.chmod(0o644)
        installed = True
        freeze.systemctl("daemon-reload")
        freeze.systemctl("start", UNIT)
        deadline = time.monotonic() + 60
        while True:
            try:
                client_module.current_launch_url(UNIT, 3081)
                break
            except RuntimeError:
                release.require(time.monotonic() < deadline, "生产维护启动超时")
                time.sleep(0.5)
        report["policy"] = policy
        report["checks"] = check_runtime(base, release_dir, expected)
        report["ok"] = True
    except Exception as error:
        report["error"] = {"type": type(error).__name__, "message": str(error)}
    finally:
        if installed:
            cleanup(release_dir)
        shutil.rmtree(temporary)
        report["finished_at"] = snapshot.now()
        filename = release_dir / ("maintenance-" + state["phase"] + "-report.json")
        freeze.save(filename, report)
    release.assert_held(state, freeze_state)
    return report


def rehearse(release_dir):
    release_dir = Path(release_dir).resolve(strict=True)
    state = release.read_json(release_dir / "state.json")
    release.require(state["restore_copy"] and state["phase"] in {"switched", "rolled-back"}, "rehearse 只允许绑定的恢复副本")
    release.assert_held(state, None)
    expected = release.VERSION if state["phase"] == "switched" else release.OLD_VERSION
    freeze.save(release_dir / "maintenance-state.json", {"mode": "isolated-copy", "run_pending": True, "started_at": snapshot.now()})
    command = ["python3", str(Path(__file__).with_name("dsh-upgrade-sandbox.py")), "--restore-dir", state["restore_copy"],
               "--work-dir", str(release_dir.parent), "--", "python3", str(Path(__file__)), "sandbox", "--expect-version", expected]
    result = subprocess.run(command, capture_output=True, text=True, timeout=240)
    run = json.loads(result.stdout)
    directory = Path(run["run_dir"]).resolve(strict=True)
    isolation = release.read_json(directory / "isolation.json")
    release.require(isolation["restore_dir"] == state["restore_copy"], "最小验收使用了其他恢复副本")
    report = release.read_json(directory / "maintenance-report.json")
    release.require(report["mode"] == "isolated-copy", "未知最小验收报告模式")
    report["sandbox_run"] = str(directory)
    report["isolation_sha256"] = snapshot.sha256(directory / "isolation.json")
    report["ok"] = report.get("ok") is True and result.returncode == 0
    freeze.save(release_dir / ("maintenance-" + state["phase"] + "-report.json"), report)
    freeze.save(release_dir / "maintenance-state.json", {"mode": "isolated-copy", "started_at": report["started_at"],
        "cleaned_at": report["finished_at"], "sandbox_run": str(directory), "run_pending": False})
    release.assert_held(state, None)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    actions = parser.add_subparsers(dest="action", required=True)
    sandbox = actions.add_parser("sandbox")
    sandbox.add_argument("--expect-version", choices=[release.OLD_VERSION, release.VERSION], required=True)
    production = actions.add_parser("smoke")
    production.add_argument("--release-dir", required=True)
    production.add_argument("--freeze-state", required=True)
    clean = actions.add_parser("cleanup")
    clean.add_argument("--release-dir", required=True)
    rehearsal = actions.add_parser("rehearse")
    rehearsal.add_argument("--release-dir", required=True)
    args = parser.parse_args()
    os.umask(0o077)
    if args.action == "sandbox":
        report = sandbox_smoke(args.expect_version)
    else:
        import fcntl
        release.require(os.geteuid() == 0, "生产维护通过 spool exec sudo -n 运行")
        with open("/run/lock/silksecagent-upgrade.lock", "w") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            if args.action == "cleanup":
                report = {"ok": True, "cleaned_at": cleanup(Path(args.release_dir).resolve(strict=True))["cleaned_at"]}
            elif args.action == "rehearse":
                report = rehearse(args.release_dir)
            else:
                report = production_smoke(args.release_dir, args.freeze_state)
    print(json.dumps(report, ensure_ascii=False))
    return 0 if report.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
