#!/usr/bin/env python3
"""构建可复现的 Scope 浏览器 fork；--install 仅用于显式准备安装树，不重启服务。"""
import argparse
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import tarfile

VERSION = "0.1.0-silksec.2"
SOURCES = {"dsh-browser-fork.index.js": "lib/index.js",
           "dsh-browser-fork.browser-manager.js": "lib/browser-manager.js",
           "dsh-browser-scope.js": "lib/scope.js"}


def build(base, templates, install=False, offline=False):
    base = Path(base).resolve(strict=True)
    templates = Path(templates).resolve(strict=True)
    owner = base.stat()
    plugin = base / "plugins/sec-browser"
    package = {"name": "@silksec/dsh-browser", "version": VERSION, "type": "module",
               "description": "DSH shared browser with mandatory Scope egress and SEC_FLOW_PROXY forwarding",
               "main": "./lib/index.js", "exports": {".": "./lib/index.js", "./package.json": "./package.json"},
               "files": ["lib", "cordis.patch.yml"], "license": "MIT", "x_upstream_version": "0.1.0",
               "dsh": {"bundle": {"patch": "./cordis.patch.yml"}},
               "dependencies": {"@deepseek-ai/schemastery": "3.18.2", "playwright-core": "1.62.1"}}
    entries = {target: (templates / source).read_bytes() for source, target in SOURCES.items()}
    entries["package.json"] = (json.dumps(package, indent=2) + "\n").encode()
    entries["cordis.patch.yml"] = b"- insert:\n    - id: browser\n      name: '@silksec/dsh-browser'\n"
    payload = io.BytesIO()
    with gzip.GzipFile(fileobj=payload, mode="wb", filename="", mtime=0) as zipped:
        with tarfile.open(fileobj=zipped, mode="w", format=tarfile.PAX_FORMAT) as archive:
            for name, content in sorted(entries.items()):
                info = tarfile.TarInfo("package/" + name)
                info.size, info.mode, info.mtime = len(content), 0o644, 0
                archive.addfile(info, io.BytesIO(content))
    data = payload.getvalue()
    digest = hashlib.sha256(data).hexdigest()

    def write(filename, content):
        filename.parent.mkdir(parents=True, exist_ok=True)
        temporary = filename.with_name(filename.name + ".tmp")
        temporary.write_bytes(content)
        temporary.chmod(0o644)
        if os.geteuid() == 0:
            os.chown(temporary, owner.st_uid, owner.st_gid)
        temporary.replace(filename)

    for name, content in entries.items():
        write(plugin / name, content)
    tarball = base / "plugins" / ("silksec-dsh-browser-" + VERSION + "-" + digest[:12] + ".tgz")
    write(tarball, data)
    report = {"version": VERSION, "tarball": str(tarball), "sha256": digest,
              "files": {name: hashlib.sha256(content).hexdigest() for name, content in entries.items()},
              "offline_frozen_install": False}
    if install:
        profile = base / "data/profiles/web"
        package_file = profile / "package.json"
        doc = json.loads(package_file.read_text())
        doc.setdefault("dependencies", {})["@silksec/dsh-browser"] = "file:" + os.path.relpath(tarball, profile)
        doc["dependencies"].pop("dsh-browser", None)
        bundles = doc.setdefault("dsh", {}).setdefault("profile", {}).setdefault("bundles", [])
        bundles[:] = [name for name in bundles if name != "dsh-browser"]
        if "@silksec/dsh-browser" not in bundles:
            bundles.append("@silksec/dsh-browser")
        write(package_file, (json.dumps(doc, indent=2, ensure_ascii=False) + "\n").encode())
        command = ["pnpm", "install", "--prod", "--ignore-scripts", "--store-dir", str(base / ".pnpm-store")]
        environment = {**os.environ, "PATH": "/usr/local/node/bin:/usr/local/bin:/usr/bin:/bin", "CI": "true",
                       "XDG_CACHE_HOME": str(base / ".cache"), "XDG_CONFIG_HOME": str(base / ".config")}
        ids = {"user": owner.st_uid, "group": owner.st_gid, "extra_groups": []} if os.geteuid() == 0 else {}
        with (base / "browser-install.log").open("w") as log:
            subprocess.run([*command, "--no-frozen-lockfile", *(["--offline"] if offline else [])],
                           cwd=profile, env=environment, stdout=log, stderr=log, check=True, timeout=600, **ids)
            lock = hashlib.sha256((profile / "pnpm-lock.yaml").read_bytes()).hexdigest()
            subprocess.run([*command, "--frozen-lockfile", "--offline"], cwd=profile, env=environment,
                           stdout=log, stderr=log, check=True, timeout=600, **ids)
        if hashlib.sha256((profile / "pnpm-lock.yaml").read_bytes()).hexdigest() != lock:
            raise RuntimeError("浏览器冻结安装修改了依赖锁")
        installed = profile / "node_modules/@silksec/dsh-browser"
        if any((installed / name).read_bytes() != content for name, content in entries.items()):
            raise RuntimeError("浏览器实际安装字节与 tarball 不一致")
        report.update(offline_frozen_install=True, profile_lock_sha256=lock)
    write(base / "browser-fork-report.json", (json.dumps(report, indent=2) + "\n").encode())
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-dir", required=True)
    parser.add_argument("--templates")
    parser.add_argument("--install", action="store_true")
    parser.add_argument("--offline", action="store_true")
    args = parser.parse_args()
    result = build(args.base_dir, args.templates or args.base_dir, args.install, args.offline)
    print(json.dumps(result))
