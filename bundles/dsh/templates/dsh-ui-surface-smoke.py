#!/usr/bin/env python3
# ==============================================================================
# dsh-ui-surface-smoke.py — 看板 UI 原生面「真机无头」运行时冒烟 harness
# （16-dashboard §2.6；与 P0–P6 逐阶段验收同一「既有 headless 通道」）
#
# 流程：临时维护账号经正式密码登录取得 cookie（同一进程内立即还原 users.yaml）
#       → 把 cookie 交给 playwright-core 子进程做无头渲染与 RPC 抽样
#       → 退出时正式 logout。
# 只读业务数据（写抽样经浏览器路由 stub 不落库）；成功/失败经子脚本 UI_CHECK 行回传。
#
# 用法：python3 dsh-ui-surface-smoke.py [--base DIR] [--url URL] [--unit UNIT] [--node NODE] [--mjs MJS]
# 退出码：0 = 全绿且 users.yaml 已还原、已登出；1 = 有失败项。
# ==============================================================================
import argparse
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path


def load_client(client_path):
    spec = importlib.util.spec_from_file_location("ui_smoke_client", client_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="/opt/silkspool/dsh")
    parser.add_argument("--url", default="http://127.0.0.1:3081")
    parser.add_argument("--unit", default="silksecagent.service")
    parser.add_argument("--node", default="/usr/local/node/bin/node")
    parser.add_argument("--mjs", default=None)
    parser.add_argument("--client", default=None)
    args = parser.parse_args()

    base = Path(args.base)
    client_path = Path(args.client) if args.client else base / "dsh-upgrade-local-client.py"
    mjs = Path(args.mjs) if args.mjs else base / "dsh-ui-surface-smoke.mjs"
    for required in (client_path, mjs):
        if not required.exists():
            print("UI_CHECK|1|ui-smoke-harness|缺少 %s" % required)
            return 1

    client_mod = load_client(client_path)
    work = Path(tempfile.mkdtemp(prefix="ui-surface-smoke-", dir="/tmp"))
    work.chmod(0o700)
    cookies_file = work / "cookies.json"
    rc = 1
    users_restored = False
    logged_out = False
    client = None
    try:
        with client_mod.MaintenanceClient(str(base / "data"), str(work), url=args.url, unit=args.unit) as client:
            cookies = [{"name": k, "value": v, "url": args.url} for k, v in client.cookies.items()]
            cookies_file.write_text(json.dumps(cookies))
            os.chmod(cookies_file, 0o600)
            env = dict(os.environ)
            env["SEC_UI_BASE"] = args.url
            proc = subprocess.run(
                [args.node, str(mjs), str(cookies_file)],
                capture_output=True, text=True, timeout=300, env=env,
            )
            sys.stdout.write(proc.stdout)
            if proc.returncode != 0 and proc.stderr:
                sys.stderr.write(proc.stderr[-8000:])
            rc = proc.returncode
            # users.yaml 在 __enter__ 收尾已还原；此处读取校验（在清理 state_dir 之前）。
            users_restored = client.users_file.read_bytes() == (client.state_dir / "users.before").read_bytes()
        # 退出 with 后 close() 已执行 logout。
        logged_out = not client.authenticated
    finally:
        try:
            cookies_file.unlink(missing_ok=True)
        except OSError:
            pass
        for leftover in work.iterdir():
            try:
                if leftover.is_dir():
                    for nested in leftover.iterdir():
                        nested.unlink(missing_ok=True)
                    leftover.rmdir()
                else:
                    leftover.unlink()
            except OSError:
                pass
        try:
            work.rmdir()
        except OSError:
            pass

    print("UI_HARNESS|rc=%d|users_restored=%s|logged_out=%s" % (rc, users_restored, logged_out))
    if not users_restored or not logged_out:
        return 1
    return rc


if __name__ == "__main__":
    sys.exit(main())
