#!/usr/bin/env python3
"""升级维护的本机认证客户端。临时账号走正式密码登录，立即恢复用户文件。

随机密码/cookie 仅驻内存，不打印或写入报告；关闭时调用正式 logout。
保留私有用户文件备份，异常中断后可凭 pending-auth.json 校验并恢复。
"""
import base64
import argparse
import hashlib
import http.client
from http.cookies import SimpleCookie
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import tempfile
import urllib.parse
import yaml


def atomic_bytes(filename, data, metadata):
    with tempfile.NamedTemporaryFile(dir=filename.parent, delete=False) as stream:
        temporary = Path(stream.name)
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    try:
        temporary.chmod(metadata["mode"])
        if os.geteuid() == 0:
            os.chown(temporary, metadata["uid"], metadata["gid"])
        os.utime(temporary, ns=(metadata["atime_ns"], metadata["mtime_ns"]))
        temporary.replace(filename)
        directory = os.open(filename.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        temporary.unlink(missing_ok=True)


def restore_users(state_dir):
    state_dir = Path(state_dir)
    state = json.loads((state_dir / "pending-auth.json").read_text())
    filename = Path(state["users_file"])
    current = filename.read_bytes()
    original = (state_dir / "users.before").read_bytes()
    if current == original:
        return
    if hashlib.sha256(current).hexdigest() == state["installed_sha256"]:
        restored = original
    else:
        # 不覆盖维护期间操作员的其他账号改动。
        document = yaml.safe_load(current)
        record = document.get("users", {}).get(state["username"])
        if record is None:
            return
        if record != state["record"]:
            raise RuntimeError("临时维护账号被另行修改，拒绝覆盖；检查私有 pending-auth.json")
        del document["users"][state["username"]]
        restored = yaml.safe_dump(document, allow_unicode=True, sort_keys=False).encode()
    atomic_bytes(filename, restored, state["metadata"])


def journal_launch_url(records, pid, invocation, port):
    """journalctl 的 grep/tail 组合可能按新到旧返回；只信当前启动实例并按时间排序。"""
    choices = []
    pattern = r"http://127\.0\.0\.1:" + str(port) + r"/\?token=[^\s)\x1b]+"
    for record in records:
        if record.get("_PID") != str(pid) or record.get("_SYSTEMD_INVOCATION_ID") != invocation:
            continue
        for link in re.findall(pattern, record.get("MESSAGE", "")):
            choices.append((int(record["__REALTIME_TIMESTAMP"]), link))
    if not choices:
        raise RuntimeError("当前服务启动实例没有可核实的 BrowserAuth 启动凭据")
    return max(choices, key=lambda item: item[0])[1]


def current_launch_url(unit, port):
    if not re.fullmatch(r"[a-zA-Z0-9@_.-]+\.service", unit):
        raise ValueError("非法服务名")

    def identity():
        result = subprocess.run(["systemctl", "show", unit, "-p", "MainPID", "-p", "InvocationID"],
                                capture_output=True, text=True, check=True, timeout=15)
        values = dict(line.split("=", 1) for line in result.stdout.splitlines() if "=" in line)
        if int(values.get("MainPID", "0")) < 2 or not re.fullmatch(r"[a-f0-9]{32}", values.get("InvocationID", "")):
            raise RuntimeError("维护认证要求当前服务处于运行状态")
        return values

    before = identity()
    # 原日志及启动 token 仅在内存中筛选，不写输出或报告。
    # journalctl --grep 在无匹配时返回 1（正常轮询场景），不视为子进程失败。
    result = subprocess.run(["journalctl", "-u", unit, "_SYSTEMD_INVOCATION_ID=" + before["InvocationID"],
                             "--no-pager", "-o", "json", "--grep", r"http://127\.0\.0\.1:" + str(port) + r"/\?token=", "-n", "12"],
                            capture_output=True, text=True, check=False, timeout=15)
    if identity() != before:
        raise RuntimeError("读取维护凭据期间服务已重启，拒绝使用过期凭据")
    return journal_launch_url([json.loads(line) for line in result.stdout.splitlines() if line.startswith("{")],
                              before["MainPID"], before["InvocationID"], port)


class MaintenanceClient:
    def __init__(self, data_dir, work_dir, url="http://127.0.0.1:3081", users_file=None,
                 launch_url=None, unit="silksecagent.service"):
        self.data_dir = Path(data_dir).resolve(strict=True)
        self.users_file = Path(users_file or self.data_dir / "auth/users.yaml")
        if self.users_file.is_symlink():
            raise RuntimeError("维护用户文件不能是软链")
        self.users_file = self.users_file.resolve(strict=True)
        parsed = urllib.parse.urlsplit(url)
        if parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "::1"} or parsed.username or parsed.path:
            raise ValueError("维护客户端只允许本机 HTTP 根地址")
        self.url, self.parsed, self.launch_url, self.unit = url, parsed, launch_url, unit
        self.cookies = {}
        self.authenticated = False
        self.browser_auth_source = "existing-cookie"
        self.state_dir = Path(tempfile.mkdtemp(prefix="dsh-maintenance-auth-", dir=work_dir))
        self.state_dir.chmod(0o700)

    def request(self, method, path, data=None, content_type=None):
        headers = {"Origin": self.url}
        if self.cookies:
            headers["Cookie"] = "; ".join(k + "=" + v for k, v in self.cookies.items())
        if content_type:
            headers["Content-Type"] = content_type
        connection = http.client.HTTPConnection(self.parsed.hostname, self.parsed.port or 80, timeout=10)
        try:
            connection.request(method, path, body=data, headers=headers)
            response = connection.getresponse()
            body = response.read()
            for key, value in response.getheaders():
                if key.lower() == "set-cookie":
                    self.cookies.update({name: cookie.value for name, cookie in SimpleCookie(value).items()})
            return response.status, body
        finally:
            connection.close()

    def __enter__(self):
        original = self.users_file.read_bytes()
        metadata = self.users_file.stat()
        if metadata.st_mode & 0o077:
            raise RuntimeError("用户文件权限不安全，拒绝维护登录")
        document = yaml.safe_load(original)
        if document.get("version") != 1 or not isinstance(document.get("users"), dict):
            raise RuntimeError("未知用户文件格式")
        username, password = "upgrade-" + secrets.token_hex(12), secrets.token_urlsafe(32)
        salt = secrets.token_bytes(16)
        key = hashlib.scrypt(password.encode(), salt=salt, n=65536, r=8, p=1, dklen=32, maxmem=128 * 1024 * 1024)
        encode = lambda value: base64.urlsafe_b64encode(value).decode().rstrip("=")
        record = {"passwordHash": "scrypt$65536$8$1$" + encode(salt) + "$" + encode(key)}
        document["users"][username] = record
        installed = yaml.safe_dump(document, allow_unicode=True, sort_keys=False).encode()
        state = {"users_file": str(self.users_file), "username": username, "record": record,
                 "installed_sha256": hashlib.sha256(installed).hexdigest(),
                 "metadata": {"mode": metadata.st_mode & 0o7777, "uid": metadata.st_uid, "gid": metadata.st_gid,
                              "atime_ns": metadata.st_atime_ns, "mtime_ns": metadata.st_mtime_ns}}
        (self.state_dir / "users.before").write_bytes(original)
        (self.state_dir / "pending-auth.json").write_text(json.dumps(state))
        for filename in self.state_dir.iterdir():
            filename.chmod(0o600)
        try:
            atomic_bytes(self.users_file, installed, state["metadata"])
            form = urllib.parse.urlencode({"username": username, "password": password})
            status, _ = self.request("POST", "/auth/login", form, "application/x-www-form-urlencoded")
            if status != 302 or not self.cookies:
                raise RuntimeError("本机维护密码登录失败，HTTP " + str(status))
            self.authenticated = True
        finally:
            restore_users(self.state_dir)
        try:
            try:
                self.native_summary()
            except RuntimeError:
                launch = self.launch_url
                self.browser_auth_source = "explicit-launch-url" if launch else "journal"
                if not launch:
                    launch = current_launch_url(self.unit, self.parsed.port)
                parsed = urllib.parse.urlsplit(launch)
                if parsed.hostname not in {"127.0.0.1", "::1"} or parsed.port != self.parsed.port:
                    raise RuntimeError("BrowserAuth 链接不是受管本机端口")
                status, _ = self.request("GET", parsed.path + "?" + parsed.query)
                if status not in (200, 302, 303):
                    raise RuntimeError("本机 BrowserAuth 兑换失败")
                self.native_summary()
            return self
        except BaseException:
            self.close()
            raise

    def native_summary(self):
        body = {"type": "client-request", "rpcId": "upgrade-idle", "method": "session/list",
                "payload": {"args": {"_request": {}}}}
        status, raw = self.request("POST", "/api/session/list", json.dumps(body), "application/json")
        if status != 200:
            raise RuntimeError("原生 Session 状态查询失败，HTTP " + str(status))
        try:
            result = json.loads(raw)["result"]
            if not result.get("ok"):
                raise ValueError()
            items = result["value"]["items"]
            if not isinstance(items, list) or any(not isinstance(row.get("running"), bool) for row in items):
                raise ValueError()
        except (ValueError, KeyError, TypeError):
            raise RuntimeError("原生 Session 状态返回未知形状") from None
        return {"sessions": len(items), "running": sum(row["running"] for row in items)}

    def rpc(self, channel, method, payload=None):
        body = {"type": "client-request", "rpcId": "upgrade-" + method, "method": method, "payload": payload or {}}
        status, raw = self.request("POST", channel + "/" + method, json.dumps(body), "application/json")
        if status != 200:
            raise RuntimeError("维护 RPC HTTP " + str(status) + "：" + method)
        try:
            result = json.loads(raw)["result"]
            if result.get("ok") is not True:
                raise ValueError()
            return result["value"]
        except (KeyError, ValueError, TypeError):
            raise RuntimeError("维护 RPC 返回失败或未知形状：" + method) from None

    def assert_idle(self):
        result = self.native_summary()
        if result["running"]:
            raise RuntimeError("原生 Session 仍有 " + str(result["running"]) + " 项在运行")
        return result

    def close(self):
        if self.authenticated:
            status, _ = self.request("POST", "/auth/logout")
            if status not in (200, 204, 302, 303):
                raise RuntimeError("维护登录未成功注销，HTTP " + str(status))
            self.authenticated = False
            self.cookies.clear()

    def __exit__(self, *_):
        self.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", required=True)
    parser.add_argument("--work-dir", required=True)
    parser.add_argument("--url", default="http://127.0.0.1:3081")
    parser.add_argument("--unit", default="silksecagent.service")
    args = parser.parse_args()
    os.umask(0o077)
    with MaintenanceClient(args.data_dir, args.work_dir, url=args.url, unit=args.unit) as client:
        summary = client.native_summary()
        report = {"ok": True, "native": summary, "browser_auth_source": client.browser_auth_source,
                  "users_restored": client.users_file.read_bytes() == (client.state_dir / "users.before").read_bytes()}
    report["logged_out"] = not client.authenticated
    (client.state_dir / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({**report, "report": str(client.state_dir / "report.json")}))


if __name__ == "__main__":
    main()
