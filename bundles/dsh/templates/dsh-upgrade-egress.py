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

SUPPORTED_VERSIONS = ("0.1.5-rc.2", "0.1.7-rc.2")
TARGET_VERSION = os.environ.get("DSH_TARGET_VERSION", "")
PRODUCTION_ROOT = Path("/opt/silkspool/dsh")


def effective_production_settings():
    """读取正在运行的生产服务的生效模型配置：0.1.5 在 settings.yaml；
    0.1.7 起 settings.yaml 仅一次性导入，真相源是 web profile patch 的模型行。"""
    version = json.loads((PRODUCTION_ROOT / "app/node_modules/@deepseek-ai/dsh/package.json").read_text())["version"]
    if version == "0.1.7-rc.2":
        patch = PRODUCTION_ROOT / "data/profiles/web/cordis.patch.yml"
        rows = yaml.load(patch.read_text(), Loader=yaml.BaseLoader) or []
        flat = {}
        def visit(entries):
            for entry in entries:
                if not isinstance(entry, dict):
                    continue
                if isinstance(entry.get("id"), str):
                    flat[entry["id"]] = entry
                if isinstance(entry.get("insert"), list):
                    visit(entry["insert"])
        visit(rows)
        if "llm-pi-ai" not in flat or "agent-default-model" not in flat:
            raise RuntimeError("0.1.7 生产 profile patch 缺少模型落点行，拒绝退回解析 settings.yaml")
        raw = patch.read_bytes()
        return {"agent-default-model": flat["agent-default-model"]["config"],
                "llm-pi-ai": flat["llm-pi-ai"]["config"]}, raw, "profile-patch"
    raw = (PRODUCTION_ROOT / "data/settings.yaml").read_bytes()
    return yaml.safe_load(raw), raw, "settings.yaml"


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
    version = json.loads((candidate / "app/node_modules/@deepseek-ai/dsh/package.json").read_text())["version"]
    if version not in SUPPORTED_VERSIONS:
        raise RuntimeError("出口验收仅支持明确的受控候选版本：" + version)
    if TARGET_VERSION and TARGET_VERSION != version:
        raise RuntimeError(f"候选版本 {version} 与 DSH_TARGET_VERSION={TARGET_VERSION} 不符")
    pid = subprocess.check_output(["systemctl", "show", "silksecagent.service", "-p", "MainPID", "--value"], text=True).strip()
    if not pid.isdigit() or int(pid) < 2:
        raise RuntimeError("生产服务不在运行，无法取得已授权路由配置")
    settings, raw, settings_source = effective_production_settings()
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
    _, current_raw, _ = effective_production_settings()
    if current_raw != raw:
        raise RuntimeError("出口验收期间生产模型配置发生变化，需重新核对")
    report["settings_sha256"] = hashlib.sha256(raw).hexdigest()
    report["settings_source"] = settings_source
    (directory / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"ok": report["ok"], "report": str(directory / "report.json"),
                      "checks": [{"name": row["name"], "ok": row["ok"]} for row in report["checks"]]}))
    return 0 if result.returncode == 0 and report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
