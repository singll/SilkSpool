#!/usr/bin/env python3
"""把恢复副本绑定到原路径，以无出口/独立 PID/只读宿主文件系统运行验收命令。

所有可写业务目录来自 restore-copy；不重写绝对软链，不加载生产 .env。
命令输出保存在 --work-dir 下的私有 sandbox 目录，交互输出不含应用凭据。
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import pwd
import subprocess
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--restore-dir", required=True)
    parser.add_argument("--work-dir", required=True)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise RuntimeError("隔离挂载需要通过 spool exec 调用 sudo -n")
    os.umask(0o077)
    restored = Path(args.restore_dir).resolve(strict=True)
    report = json.loads((restored / "restore-report.json").read_text())
    manifest_path = Path(report["snapshot"]) / "manifest.json"
    if not report.get("files_verified") or hashlib.sha256(manifest_path.read_bytes()).hexdigest() != report["manifest_sha256"]:
        raise RuntimeError("恢复副本没有完整校验记录")
    manifest = json.loads(manifest_path.read_text())
    if "dsh" not in manifest["roots"] or not manifest.get("complete"):
        raise RuntimeError("缺少 DSH 完整恢复根")
    base = Path(manifest["roots"]["dsh"]["source"])
    identity = (restored / "dsh").stat()
    if identity.st_uid == 0:
        raise RuntimeError("预演不能以 root 运行 DSH")
    account = pwd.getpwuid(identity.st_uid)
    # bwrap 以服务账号进入 user namespace；只放开还原容器的遍历权限，不改树内元数据。
    os.chown(restored, identity.st_uid, identity.st_gid)
    run = Path(tempfile.mkdtemp(prefix="dsh-sandbox-", dir=Path(args.work_dir).resolve(strict=True)))
    run.chmod(0o700)
    os.chown(run, identity.st_uid, identity.st_gid)
    (run / "home").mkdir()
    os.chown(run / "home", identity.st_uid, identity.st_gid)
    (run / "empty.env").write_text("# isolated rehearsal: production credentials are not loaded\n")
    (run / "empty.env").chmod(0o444)
    original_settings = Path(report["snapshot"]) / "trees/dsh/data/settings.yaml"
    if original_settings.is_file():
        settings_copy = run / "original-settings.yaml"
        settings_copy.write_bytes(original_settings.read_bytes())
        settings_copy.chmod(0o600)
        os.chown(settings_copy, identity.st_uid, identity.st_gid)
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command:
        raise ValueError("必须指定隔离验收命令")
    bwrap = ["/usr/bin/bwrap", "--unshare-all", "--die-with-parent", "--new-session",
             "--ro-bind", "/", "/", "--tmpfs", "/run", "--tmpfs", "/tmp", "--tmpfs", "/root",
             "--proc", "/proc", "--dev", "/dev", "--bind", str(run / "home"), account.pw_dir,
             "--bind", str(run), "/tmp/dsh-rehearsal"]
    mappings = []
    for entry in manifest["config"]["roots"]:
        if entry["name"] == "host-state":
            continue
        copied = restored / entry["name"]
        source = Path(manifest["roots"][entry["name"]]["source"])
        if copied.is_symlink() or not copied.is_dir() or source == Path("/"):
            raise RuntimeError("非法隔离根")
        mode = "--bind" if entry.get("mutable", True) else "--ro-bind"
        bwrap.extend([mode, str(copied), str(source)])
        mappings.append({"source": str(source), "copy": str(copied), "writable": mode == "--bind"})
    bwrap.extend(["--ro-bind", str(run / "empty.env"), str(base / ".env"),
                  "--chdir", str(base / "app"), "--uid", str(identity.st_uid), "--gid", str(identity.st_gid),
                  "--cap-drop", "ALL", "--", *command])
    environment = {"PATH": "/usr/local/node/bin:/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8",
                   "DSH_HOME": str(base / "data"), "SEC_BASE_DIR": str(base), "SEC_DATA_DIR": str(base / "data"),
                   "SEC_SCOPE_FILE": str(base / "data/scope.yml"), "SEC_PROXY_POOL_DIR": str(base / "proxy-pool"),
                   "SEC_DSH_BIN": str(base / "app/node_modules/@deepseek-ai/dsh/lib/bin.js"),
                   "SEC_NODE_BIN": "/usr/local/node/bin/node", "CI": "true"}
    isolation = {"restore_dir": str(restored), "manifest_sha256": report["manifest_sha256"], "mappings": mappings,
                 "uid": identity.st_uid, "network": "private-loopback-only", "host_filesystem": "read-only",
                 "production_env": "masked", "command": command}
    if original_settings.is_file():
        isolation["original_settings_sha256"] = hashlib.sha256(original_settings.read_bytes()).hexdigest()
    (run / "isolation.json").write_text(json.dumps(isolation, ensure_ascii=False, indent=2) + "\n")
    (run / "isolation.json").chmod(0o444)
    def service_identity():
        os.setgroups([])
        os.setgid(identity.st_gid)
        os.setuid(identity.st_uid)
    with (run / "stdout.log").open("w") as stdout, (run / "stderr.log").open("w") as stderr:
        result = subprocess.run(bwrap, env=environment, stdout=stdout, stderr=stderr, preexec_fn=service_identity)
    print(json.dumps({"ok": result.returncode == 0, "exit_code": result.returncode, "run_dir": str(run)}))
    raise SystemExit(result.returncode)


if __name__ == "__main__":
    main()
