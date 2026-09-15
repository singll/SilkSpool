#!/usr/bin/env python3
"""从完整旧恢复点与锁定 rc.2 app 创建新的静态候选，不写生产，不执行 setup。"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import yaml

VERSION = "0.1.5-rc.2"
TEMPLATES = ["dsh-plugin-sec-suite.js", "dsh-plugin-sec-suite.scheduler.js", "dsh-plugin-sec-suite.host-compat.js",
             "dsh-plugin-sec-suite.persona.py", "dsh-plugin-sec-suite.native-guard.js", "dsh-plugin-sec-suite.worker-runtime.js",
             "dsh-plugin-sec-suite.asset-db.js", "dsh-plugin-sec-suite.experience.js", "dsh-plugin-sec-backend-know-sqlite.js",
             "dsh-plugin-sec-domain-bus.js", "dsh-plugin-sec-domain-exec.js",
             "dsh-plugin-sec-domain-task.js", "dsh-plugin-sec-backend-task-sqlite.js", "dsh-runtime-compat.py",
             "seed-presets.sh", "sec-suite-plugin-setup.sh"]
TEMPLATES += ["setup.sh", "headless-failover-setup.sh", "settings-mirror-patch.sh", "sec-browser-plugin-setup.sh", "plugins.lock"]


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--snapshot", required=True)
    parser.add_argument("--app-dir", required=True)
    parser.add_argument("--templates", required=True)
    parser.add_argument("--work-dir", required=True)
    args = parser.parse_args()
    os.umask(0o077)
    snapshot = Path(args.snapshot).resolve(strict=True)
    manifest_file = snapshot / "manifest.json"
    if sha(manifest_file) != (snapshot / "manifest.sha256").read_text().strip():
        raise RuntimeError("恢复点清单哈希不符")
    manifest = json.loads(manifest_file.read_text())
    if not manifest.get("complete"):
        raise RuntimeError("恢复点未完成")
    source = snapshot / "trees/dsh"
    app = Path(args.app_dir).resolve(strict=True)
    installed = json.loads((app / "node_modules/@deepseek-ai/dsh/package.json").read_text())
    declared = json.loads((app / "package.json").read_text())["dependencies"]["@deepseek-ai/dsh"]
    if installed["version"] != VERSION or declared != VERSION:
        raise RuntimeError("候选 app 必须显式锁定 0.1.5-rc.2")
    owner = source.stat()
    release = Path(tempfile.mkdtemp(prefix="dsh-candidate-", dir=Path(args.work_dir).resolve(strict=True)))
    os.chown(release, owner.st_uid, owner.st_gid)
    report = {"target_version": VERSION, "source_snapshot": str(snapshot), "manifest_sha256": sha(manifest_file),
              "candidate": str(release), "canonical_base": manifest["roots"]["dsh"]["source"], "profiles": {}, "ready_for_cutover": False}

    def mkdir(path):
        if not path.exists():
            mkdir(path.parent)
            path.mkdir()
            os.chown(path, owner.st_uid, owner.st_gid)

    def write(path, content):
        mkdir(path.parent)
        path.write_text(content)
        os.chown(path, owner.st_uid, owner.st_gid)

    def copy(src, target):
        mkdir(target.parent)
        subprocess.run(["cp", "-a", "--reflink=auto", "--", str(src), str(target)], check=True, capture_output=True)

    def run(command, cwd, logname, extra_env=None):
        environment = {"PATH": "/usr/local/node/bin:/usr/local/bin:/usr/bin:/bin", "CI": "true",
                       "XDG_CACHE_HOME": str(release / ".cache"), **(extra_env or {})}
        with (release / logname).open("w") as log:
            result = subprocess.run(command, cwd=cwd, env=environment, user=owner.st_uid, group=owner.st_gid,
                                    extra_groups=[], stdout=log, stderr=log, timeout=600)
        if result.returncode:
            raise RuntimeError("候选准备失败，详见私有日志：" + logname)

    try:
        copy(app, release / "app")
        copy(source / "plugins", release / "plugins")
        copy(source / "plugins.lock", release / "plugins.lock")
        copy(source / "data/.agent-presets", release / "data/.agent-presets")
        versions = {}
        for file in (release / "app/node_modules/.pnpm").glob("*/node_modules/@deepseek-ai/*/package.json"):
            package = json.loads(file.read_text())
            name, version = package["name"], package["version"]
            if name in versions and versions[name] != version:
                raise RuntimeError("候选 app 含多份核心版本：" + name)
            versions[name] = version
        report["core_versions"] = versions
        for profile in ("web", "headless"):
            old = source / "data/profiles" / profile
            target = release / "data/profiles" / profile
            mkdir(target)
            for name in ("package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "cordis.yml", "cordis.patch.yml"):
                copy(old / name, target / name)
            package = json.loads((target / "package.json").read_text())
            for name, value in package.get("dependencies", {}).items():
                if value.startswith(("file:", "link:")):
                    if name == "dsh-model-failover":
                        package["dependencies"][name] = "0.1.4"
                        continue
                    prefix, filename = value.split(":", 1)
                    location = Path(filename)
                    canonical = Path(report["canonical_base"])
                    if not location.is_absolute() or not location.is_relative_to(canonical / "plugins"):
                        raise RuntimeError("候选包含未分类本地依赖：" + name)
                    destination = release / location.relative_to(canonical)
                    package["dependencies"][name] = prefix + ":" + os.path.relpath(destination, target)
            write(target / "package.json", json.dumps(package, ensure_ascii=False, indent=2) + "\n")
            workspace = yaml.safe_load((target / "pnpm-workspace.yaml").read_text())
            workspace["autoInstallPeers"] = False
            workspace["overrides"] = {**workspace.get("overrides", {}), **versions}
            write(target / "pnpm-workspace.yaml", yaml.safe_dump(workspace, sort_keys=True))
            command = ["pnpm", "install", "--prod", "--ignore-scripts", "--store-dir", str(release / ".pnpm-store")]
            run([*command, "--no-frozen-lockfile"], target, profile + "-install.log")
            digest = sha(target / "pnpm-lock.yaml")
            run([*command, "--frozen-lockfile", "--offline"], target, profile + "-frozen.log")
            if sha(target / "pnpm-lock.yaml") != digest:
                raise RuntimeError("冻结安装改写了锁文件")
            report["profiles"][profile] = {"lock_sha256": digest, "offline_frozen_install": True}
        templates = Path(args.templates).resolve(strict=True)
        names = set(TEMPLATES)
        for pattern in ("dsh-upgrade-*", "dsh-session-*", "dsh-runtime-compat.py", "dsh-browser-*", "dsh-shared-browser-host.mjs"):
            names.update(p.name for p in templates.glob(pattern) if p.is_file())
        for name in sorted(names):
            write(release / name, (templates / name).read_text().replace("{{BASE_DIR}}", report["canonical_base"]))
        watcher = (templates / "data-seed/scripts/dsh-version-watch.sh").read_text()
        write(release / "scripts/pipeline/dsh-version-watch.sh", watcher)
        write(release / "data-seed/scripts/dsh-version-watch.sh", watcher)
        for name, target in {"dsh-plugin-sec-suite.js": "index.js", "dsh-plugin-sec-suite.scheduler.js": "scheduler.js",
                             "dsh-plugin-sec-suite.host-compat.js": "host-compat.js", "dsh-plugin-sec-suite.native-guard.js": "native-guard.js",
                             "dsh-plugin-sec-suite.persona.py": "persona.py", "dsh-plugin-sec-suite.worker-runtime.js": "worker-runtime.js",
                             "dsh-plugin-sec-suite.asset-db.js": "asset-db.js", "dsh-plugin-sec-suite.experience.js": "experience.js"}.items():
            write(release / "plugins/sec-suite" / target, (release / name).read_text())
        write(release / "plugins/sec-domain-bus/index.js", (release / "dsh-plugin-sec-domain-bus.js").read_text())
        for plugin in ("sec-domain-exec", "sec-domain-task", "sec-backend-task-sqlite", "sec-backend-know-sqlite"):
            write(release / "plugins" / plugin / "index.js", (release / ("dsh-plugin-" + plugin + ".js")).read_text())
        run(["python3", str(release / "dsh-runtime-compat.py"), "--base-dir", str(release)], release, "runtime-compat.log")
        pkgfile = release / "plugins/sec-suite/package.json"
        package = json.loads(pkgfile.read_text())
        package["files"] = sorted(set(package["files"]) | {"host-compat.js", "native-guard.js", "worker-runtime.js", "persona.py"})
        write(pkgfile, json.dumps(package, indent=2) + "\n")
        run(["bash", str(release / "seed-presets.sh")], release, "presets.log",
            {"SEC_BASE_DIR": str(release), "SEC_DATA_DIR": str(release / "data"), "DSH_HOME": str(release / "data")})
        run(["python3", str(release / "dsh-browser-fork.py"), "--base-dir", str(release), "--templates", str(release), "--install"],
            release, "browser-build.log")
        run(["python3", str(release / "dsh-runtime-compat.py"), "--base-dir", str(release)], release, "runtime-compat.log")
        report["profiles"] = {name: {"lock_sha256": sha(release / "data/profiles" / name / "pnpm-lock.yaml"),
                                     "offline_frozen_install": True} for name in ("web", "headless")}
        report["app_lock_sha256"] = sha(release / "app/pnpm-lock.yaml")
        report["prepared"] = True
    except Exception as error:
        report["prepared"] = False
        report["error"] = {"type": type(error).__name__, "message": str(error)}
        raise
    finally:
        write(release / "candidate-report.json", json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"ok": True, "candidate": str(release), "ready_for_cutover": False}))


if __name__ == "__main__":
    main()
