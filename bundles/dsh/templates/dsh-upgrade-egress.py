#!/usr/bin/env python3
"""通过已安装 rc.2 适配器做有界网络验收；只读生产路由，API key 仅传子进程 stdin。"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import urllib.parse
import yaml


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--candidate", required=True)
    parser.add_argument("--work-dir", required=True)
    parser.add_argument("--browser-bin", required=True)
    parser.add_argument("--only", choices=["actual-bellkeeper-pi-ai-stream", "actual-fetch-current-environment", "actual-cli-egress-proxy", "actual-browser-scope-and-flow-proxy"])
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise RuntimeError("只读运行环境需通过 spool exec sudo -n 运行")
    candidate = Path(args.candidate).resolve(strict=True)
    if json.loads((candidate / "app/node_modules/@deepseek-ai/dsh/package.json").read_text())["version"] != "0.1.5-rc.2":
        raise RuntimeError("验收仅支持明确的 rc.2 候选")
    pid = subprocess.check_output(["systemctl", "show", "silksecagent.service", "-p", "MainPID", "--value"], text=True).strip()
    if not pid.isdigit() or int(pid) < 2:
        raise RuntimeError("生产服务不在运行，无法取得已授权路由配置")
    production = Path("/opt/silkspool/dsh/data/settings.yaml")
    raw = production.read_bytes()
    settings = yaml.safe_load(raw)
    default = settings["agent-default-model"]
    provider = settings["llm-pi-ai"]["providers"][default["provider"]]
    environment = dict(item.decode().split("=", 1) for item in Path("/proc", pid, "environ").read_bytes().split(b"\0") if b"=" in item)
    key = provider["apiKeyEnv"]
    selected = {name: value for name, value in environment.items() if name in
                {key, "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy", "SEC_FLOW_PROXY", "SEC_EGRESS_PROXY"}}
    for name, value in selected.items():
        if "proxy" in name.lower() and name.lower() != "no_proxy" and value:
            url = urllib.parse.urlsplit(value)
            if url.scheme not in {"http", "https"} or not url.hostname:
                raise RuntimeError("存在未验证的代理协议：" + name)
        if name.lower() == "no_proxy" and "/" in value:
            raise RuntimeError("NO_PROXY 不接受 CIDR")
    if not selected.get(key):
        raise RuntimeError("运行环境缺少既有路由凭据引用")
    owner = candidate.stat()
    directory = Path(tempfile.mkdtemp(prefix="dsh-egress-", dir=Path(args.work_dir).resolve(strict=True)))
    os.chown(directory, owner.st_uid, owner.st_gid)
    config = {"base": str(candidate), "out": str(directory), "settings": {"agent-default-model": default,
              "llm-pi-ai": {"providers": {default["provider"]: provider}}}, "env": selected, "browserBin": args.browser_bin, "only": args.only}
    result = subprocess.run(["/usr/local/node/bin/node", str(Path(__file__).with_suffix(".mjs"))], input=json.dumps(config),
                            text=True, capture_output=True, timeout=180, user=owner.st_uid, group=owner.st_gid, extra_groups=[],
                            env={"PATH": "/usr/local/node/bin:/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8"}, cwd=directory)
    if not (directory / "report.json").is_file():
        # 堆栈只保存到 root 私有文件，输出不带传输库可能包含的敏感上下文。
        log = directory / "failure.private.log"
        log.write_text(result.stderr)
        log.chmod(0o600)
        raise RuntimeError("出口验收未完成，查看私有诊断：" + str(log))
    report = json.loads((directory / "report.json").read_text())
    if production.read_bytes() != raw:
        raise RuntimeError("出口验收期间生产模型配置发生变化，需重新核对")
    report["settings_sha256"] = hashlib.sha256(raw).hexdigest()
    (directory / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"ok": report["ok"], "report": str(directory / "report.json"),
                      "checks": [{"name": row["name"], "ok": row["ok"]} for row in report["checks"]]}))
    return 0 if result.returncode == 0 and report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
