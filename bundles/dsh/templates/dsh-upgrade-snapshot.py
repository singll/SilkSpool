#!/usr/bin/env python3
"""DSH 完整恢复点：冻结检查、全树保全、独立 SQLite 镜像、校验与恢复到新目录。

不停止服务、不安装依赖、不覆盖生产。capture 必须先由运维暂停配置中列出的写者。
恢复副本仍保留原绝对软链；启动前必须另行完成路径与网络隔离。
"""
import argparse
import base64
import errno
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import stat
import subprocess
import tempfile
from datetime import datetime, timezone


def now():
    return datetime.now(timezone.utc).isoformat()


def sha256(filename):
    h = hashlib.sha256()
    with open(filename, "rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def inside(candidate, root):
    return candidate == root or root in candidate.parents


def write_json(filename, value):
    with open(filename, "x", encoding="utf-8") as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())


def tree_manifest(root):
    """不跟随软链，验证字节、属主、权限、时间、xattrs 和树内硬链关系。"""
    root = Path(root)
    entries, links, content_cache = {}, {}, {}

    def visit(filename):
        before = filename.lstat()
        relative = str(filename.relative_to(root))
        item = {"mode": stat.S_IMODE(before.st_mode), "uid": before.st_uid,
                "gid": before.st_gid, "mtime_ns": before.st_mtime_ns}
        try:
            item["xattrs"] = {name: base64.b64encode(os.getxattr(filename, name, follow_symlinks=False)).decode()
                              for name in sorted(os.listxattr(filename, follow_symlinks=False))}
        except OSError as error:
            if error.errno not in (errno.ENOTSUP, errno.EOPNOTSUPP):
                raise
            item["xattrs"] = {}
        if stat.S_ISLNK(before.st_mode):
            item.update(kind="symlink", target=os.readlink(filename))
        elif stat.S_ISDIR(before.st_mode):
            item["kind"] = "directory"
            for child in sorted(filename.iterdir()):
                visit(child)
        elif stat.S_ISREG(before.st_mode):
            identity = (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns)
            if identity not in content_cache:
                content_cache[identity] = sha256(filename)
            item.update(kind="file", size=before.st_size, sha256=content_cache[identity])
            links.setdefault((before.st_dev, before.st_ino), []).append(relative)
        else:
            raise RuntimeError("恢复点不接受 socket/FIFO/设备文件，请先完成写者冻结")
        after = filename.lstat()
        if (before.st_dev, before.st_ino, before.st_mode, before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (
                after.st_dev, after.st_ino, after.st_mode, after.st_size, after.st_mtime_ns, after.st_ctime_ns):
            raise RuntimeError("读取清单时源文件发生变化")
        entries[relative] = item

    visit(root)
    for group in links.values():
        if len(group) > 1:
            for relative in group:
                entries[relative]["hardlink_group"] = min(group)
    return {key: entries[key] for key in sorted(entries)}


def validate_config(config, work, require_sources=True):
    if not config.get("roots"):
        raise ValueError("缺少恢复根目录清单")
    roots, names = [], set()
    for entry in config["roots"]:
        name = entry["name"]
        if not re.fullmatch(r"[a-zA-Z0-9_-]+", name) or name in names:
            raise ValueError("恢复根目录名称非法或重复")
        declared = Path(entry["path"])
        if not declared.is_absolute():
            raise ValueError("恢复根必须使用绝对路径")
        source = declared.resolve(strict=require_sources)
        if (require_sources and not source.is_dir()) or source == Path("/") or inside(work, source):
            raise ValueError("源必须是目录，输出必须位于所有恢复根之外")
        if any(inside(source, other) or inside(other, source) for other in roots):
            raise ValueError("恢复根不能重复或嵌套")
        roots.append(source)
        names.add(name)
    databases = set()
    for database in config.get("sqlite", []):
        relative = Path(database["path"])
        key = (database["root"], str(relative))
        if database["root"] not in names or relative.is_absolute() or ".." in relative.parts or not relative.parts or key in databases:
            raise ValueError("SQLite 路径必须位于声明的恢复根内")
        databases.add(key)
    return roots


def no_related_processes(roots, proc_root=Path("/proc")):
    """阻止仍可能写入的 DSH 进程；只返回 PID，不输出命令行或环境中的秘密。"""
    ignored = {os.getpid()}
    pid = os.getppid()
    while pid > 1:
        ignored.add(pid)
        try:
            status = (proc_root / str(pid) / "status").read_text()
            pid = int(re.search(r"^PPid:\s+(\d+)", status, re.M)[1])
        except (FileNotFoundError, ProcessLookupError):
            break
    related = []
    prefixes = [str(root) for root in roots]

    def match(value):
        return any(value == prefix or value.startswith(prefix + "/") for prefix in prefixes)

    for process in proc_root.iterdir():
        if not process.name.isdigit() or int(process.name) in ignored:
            continue
        try:
            found = any(match(os.readlink(process / field)) for field in ("cwd", "exe"))
            argv = (process / "cmdline").read_bytes().decode(errors="replace").split("\0")
            env = (process / "environ").read_bytes().decode(errors="replace").split("\0")
            found |= any(match(arg) for arg in argv)
            found |= any(match(item.split("=", 1)[1]) for item in env if item.split("=", 1)[0] in
                         {"DSH_HOME", "SEC_BASE_DIR", "SEC_DATA_DIR", "SEC_SCOPE_FILE", "SEC_PROXY_POOL_DIR"})
            for descriptor in (process / "fd").iterdir():
                target = os.readlink(descriptor).removesuffix(" (deleted)")
                if match(target):
                    info = (process / "fdinfo" / descriptor.name).read_text()
                    flags = int(re.search(r"^flags:\s+([0-7]+)", info, re.M)[1], 8)
                    found |= flags & os.O_ACCMODE != os.O_RDONLY
            if found:
                related.append(int(process.name))
        except (FileNotFoundError, ProcessLookupError):
            continue
    if related:
        raise RuntimeError("仍有相关进程，拒绝冻结点快照；PID=" + ",".join(map(str, sorted(related))))


def assert_quiescent(config):
    if os.geteuid() != 0:
        raise RuntimeError("capture 需要 root 检查所有写者；请通过 spool exec 调用 sudo -n")
    if not config.get("quiet_units") or "silksecagent.service" not in config["quiet_units"]:
        raise ValueError("必须明确列出完整写者单元，且包含 silksecagent.service")
    states = {}
    for unit in config["quiet_units"]:
        if not re.fullmatch(r"[a-zA-Z0-9@_.-]+\.(service|timer)", unit):
            raise ValueError("systemd 单元名非法")
        result = subprocess.run(["systemctl", "show", unit, "-p", "LoadState", "-p", "ActiveState", "-p", "MainPID"],
                                text=True, capture_output=True, check=True)
        state = dict(line.split("=", 1) for line in result.stdout.splitlines() if "=" in line)
        if state.get("LoadState") != "loaded" or state.get("ActiveState") not in {"inactive", "failed"} or int(state.get("MainPID", 0)):
            raise RuntimeError("写者单元尚未冻结：" + unit)
        states[unit] = state
    mutable = [Path(row["path"]).resolve() for row in config["roots"] if row.get("mutable", True)]
    crons = {}
    for user in config.get("cron_users", []):
        if not re.fullmatch(r"[a-zA-Z0-9_-]+", user):
            raise ValueError("cron 用户非法")
        result = subprocess.run(["crontab", "-u", user, "-l"], text=True, capture_output=True)
        if result.returncode not in (0, 1) or (result.returncode == 1 and "no crontab" not in result.stderr):
            raise RuntimeError("无法确认 cron 状态：" + user)
        for line in result.stdout.splitlines():
            if line.strip() and not line.lstrip().startswith("#") and ("dsh" in line or "silksec" in line
                    or any(str(root) in line for root in mutable)):
                raise RuntimeError("仍有相关 cron 未暂停：" + user)
        crons[user] = hashlib.sha256(result.stdout.encode()).hexdigest()
    no_related_processes(mutable)
    return {"checked_at": now(), "units": states, "cron_sha256": crons}


def copy_tree(source, target):
    subprocess.run(["cp", "-a", "--reflink=auto", "--", str(source), str(target)], check=True, capture_output=True)


def sqlite_image(source, target):
    if not source.is_file() or source.is_symlink():
        raise ValueError("SQLite 源必须是普通文件")
    with tempfile.TemporaryDirectory(prefix="dsh-sqlite-check-") as directory:
        copied = Path(directory) / "database.sqlite"
        shutil.copy2(source, copied)
        for suffix in ("-wal", "-shm", "-journal"):
            sidecar = Path(str(source) + suffix)
            if sidecar.exists():
                if not sidecar.is_file() or sidecar.is_symlink():
                    raise ValueError("SQLite sidecar 必须是普通文件")
                shutil.copy2(sidecar, Path(str(copied) + suffix))
        with sqlite3.connect(copied.as_uri() + "?mode=ro", uri=True) as src:
            with sqlite3.connect(target) as dst:
                src.backup(dst)
                dst.execute("PRAGMA journal_mode=DELETE")
                integrity = [row[0] for row in dst.execute("PRAGMA integrity_check")]
                if integrity != ["ok"]:
                    raise RuntimeError("SQLite 完整性检查失败")
                tables = [row[0] for row in dst.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
                counts = {table: dst.execute('SELECT count(*) FROM "' + table.replace('"', '""') + '"').fetchone()[0] for table in tables}
                schema = dst.execute("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").fetchall()
                user_version = dst.execute("PRAGMA user_version").fetchone()[0]
            dst.close()
        src.close()
    return {"sha256": sha256(target), "integrity_check": "ok", "table_counts": counts, "user_version": user_version,
            "schema_sha256": hashlib.sha256(json.dumps(schema).encode()).hexdigest()}


def capture(config, work, guard=assert_quiescent):
    work = Path(work).resolve(strict=True)
    sources = validate_config(config, work)
    before_guard = guard(config)
    pending = Path(tempfile.mkdtemp(prefix="dsh-snapshot-pending-", dir=work))
    (pending / "trees").mkdir()
    (pending / "sqlite").mkdir()
    manifest = {"manifest_schema": 1, "kind": "dsh-frozen-recovery-point", "started_at": now(),
                "config": config, "quiescence_before": before_guard, "roots": {}, "sqlite": [], "complete": False}
    try:
        for row, source in zip(config["roots"], sources):
            before = tree_manifest(source)
            target = pending / "trees" / row["name"]
            copy_tree(source, target)
            if tree_manifest(source) != before or tree_manifest(target) != before:
                raise RuntimeError("恢复点复制前后清单不一致：" + row["name"])
            manifest["roots"][row["name"]] = {"source": str(source), "entries": before}
        for i, database in enumerate(config.get("sqlite", [])):
            source = pending / "trees" / database["root"] / database["path"]
            if not inside(source.resolve(), (pending / "trees" / database["root"]).resolve()):
                raise ValueError("SQLite 路径逃逸恢复根")
            image = pending / "sqlite" / f"database-{i}.sqlite"
            manifest["sqlite"].append({**database, "image": str(image.relative_to(pending)), **sqlite_image(source, image)})
        manifest["quiescence_after"] = guard(config)
        for row, source in zip(config["roots"], sources):
            if tree_manifest(source) != manifest["roots"][row["name"]]["entries"]:
                raise RuntimeError("恢复点窗口中源发生变化：" + row["name"])
        manifest.update(complete=True, finished_at=now())
        write_json(pending / "manifest.json", manifest)
        (pending / "manifest.sha256").write_text(sha256(pending / "manifest.json") + "\n")
        ready = pending.with_name(pending.name.replace("-pending-", "-ready-", 1))
        pending.rename(ready)
        return ready
    except Exception as error:
        write_json(pending / "failure.json", {"failed_at": now(), "type": type(error).__name__, "message": str(error)})
        raise


def verify(snapshot):
    snapshot = Path(snapshot).resolve(strict=True)
    if sha256(snapshot / "manifest.json") != (snapshot / "manifest.sha256").read_text().strip():
        raise RuntimeError("恢复点 manifest 哈希不符")
    manifest = json.loads((snapshot / "manifest.json").read_text())
    if manifest.get("manifest_schema") != 1 or not manifest.get("complete") or manifest.get("kind") != "dsh-frozen-recovery-point":
        raise RuntimeError("不是完整的 DSH 冻结点")
    if set(manifest["roots"]) != {row["name"] for row in manifest["config"]["roots"]}:
        raise RuntimeError("恢复根清单不符")
    declared_databases = [(row["root"], row["path"]) for row in manifest["config"].get("sqlite", [])]
    actual_databases = [(row["root"], row["path"]) for row in manifest["sqlite"]]
    if actual_databases != declared_databases or len(set(actual_databases)) != len(actual_databases):
        raise RuntimeError("SQLite 镜像清单与声明不符")
    for name, root in manifest["roots"].items():
        if not re.fullmatch(r"[a-zA-Z0-9_-]+", name) or tree_manifest(snapshot / "trees" / name) != root["entries"]:
            raise RuntimeError("恢复点树校验失败：" + name)
    for i, database in enumerate(manifest["sqlite"]):
        image = snapshot / database["image"]
        if database["image"] != f"sqlite/database-{i}.sqlite" or image.is_symlink() or not inside(image.resolve(), snapshot / "sqlite") or sha256(image) != database["sha256"]:
            raise RuntimeError("SQLite 镜像校验失败")
        with sqlite3.connect(image.as_uri() + "?mode=ro&immutable=1", uri=True) as conn:
            if conn.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
                raise RuntimeError("SQLite 镜像完整性失败")
        conn.close()
    return manifest


def restore_copy(snapshot, work):
    snapshot = Path(snapshot).resolve(strict=True)
    work = Path(work).resolve(strict=True)
    manifest = verify(snapshot)
    # 灾难恢复时原主机/目录可能已不存在；只校验声明的路径边界，不依赖原件。
    validate_config(manifest["config"], work, require_sources=False)
    if inside(work, snapshot):
        raise ValueError("恢复输出不能位于恢复点内部")
    restored = Path(tempfile.mkdtemp(prefix="dsh-restore-copy-", dir=work))
    for name, root in manifest["roots"].items():
        target = restored / name
        copy_tree(snapshot / "trees" / name, target)
        if tree_manifest(target) != root["entries"]:
            raise RuntimeError("恢复副本验证失败：" + name)
    write_json(restored / "restore-report.json", {"finished_at": now(), "snapshot": str(snapshot),
               "manifest_sha256": sha256(snapshot / "manifest.json"), "roots": list(manifest["roots"]),
               "files_verified": True, "safe_to_start": False,
               "next": "绝对软链保持原样；先完成路径、凭据、调度与网络隔离，再启动预演服务"})
    return restored


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="action", required=True)
    create = sub.add_parser("capture")
    create.add_argument("--config", required=True)
    create.add_argument("--work-dir", required=True)
    check = sub.add_parser("verify")
    check.add_argument("--snapshot", required=True)
    restore = sub.add_parser("restore-copy")
    restore.add_argument("--snapshot", required=True)
    restore.add_argument("--work-dir", required=True)
    args = parser.parse_args()
    os.umask(0o077)
    if args.action == "capture":
        result = capture(json.loads(Path(args.config).read_text()), args.work_dir)
        print(json.dumps({"ok": True, "snapshot": str(result), "manifest_sha256": sha256(result / "manifest.json")}))
    elif args.action == "verify":
        manifest = verify(args.snapshot)
        print(json.dumps({"ok": True, "roots": len(manifest["roots"]), "sqlite": len(manifest["sqlite"])}))
    else:
        print(json.dumps({"ok": True, "restored": str(restore_copy(args.snapshot, args.work_dir)), "safe_to_start": False}))


if __name__ == "__main__":
    main()
