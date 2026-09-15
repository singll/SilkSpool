#!/usr/bin/env python3
"""通过 spool 调用：保存写者状态，冻结并创建完整恢复点，默认自动恢复原服务。

--hold 仅供已通过预演的切换窗口；resume 可从持久化状态恢复原服务/cron。
不安装依赖、不切换版本、不覆盖应用或领域数据。
"""
import argparse
import base64
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import signal
import sqlite3
import subprocess
import tempfile
import time

spec = importlib.util.spec_from_file_location("snapshot", Path(__file__).with_name("dsh-upgrade-snapshot.py"))
snapshot = importlib.util.module_from_spec(spec)
spec.loader.exec_module(snapshot)
client_spec = importlib.util.spec_from_file_location("local_client", Path(__file__).with_name("dsh-upgrade-local-client.py"))
local_client = importlib.util.module_from_spec(client_spec)
client_spec.loader.exec_module(local_client)
MaintenanceClient = local_client.MaintenanceClient


def save(path, value):
    temporary = path.with_suffix(".tmp")
    with temporary.open("w") as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(path)
    directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def systemctl(*args):
    result = subprocess.run(["systemctl", *args], capture_output=True, text=True, timeout=120)
    if result.returncode:
        raise RuntimeError("systemctl 操作失败：" + " ".join(args[:2]))
    return result.stdout


def crontab(user):
    result = subprocess.run(["crontab", "-u", user, "-l"], capture_output=True, text=True, timeout=15)
    if result.returncode == 0:
        return result.stdout
    if result.returncode == 1 and "no crontab" in result.stderr:
        return None
    raise RuntimeError("无法读取 crontab：" + user)


def set_crontab(user, text):
    args = ["crontab", "-u", user, "-r" if text is None else "-"]
    result = subprocess.run(args, input=text, capture_output=True, text=True, timeout=15)
    if result.returncode and not (text is None and "no crontab" in result.stderr):
        raise RuntimeError("无法恢复 crontab：" + user)


def related_cron(line, roots):
    return bool(line.strip() and not line.lstrip().startswith("#") and
                ("dsh" in line or "silksec" in line or any(str(root) in line for root in roots)))


def assert_idle(config):
    database = Path(config["idle_database"]).resolve(strict=True)
    roots = [Path(row["path"]).resolve() for row in config["roots"]]
    if not any(snapshot.inside(database, root) for root in roots):
        raise ValueError("排空检查库必须在恢复根内")
    with sqlite3.connect(database.as_uri() + "?mode=ro", uri=True) as db:
        db.execute("PRAGMA query_only=ON")
        for table in ("workers", "tasks"):
            count = db.execute(f"SELECT count(*) FROM {table} WHERE status='running'").fetchone()[0]
            if count:
                raise RuntimeError(f"{table} 仍有 {count} 项在运行，等待排空后重试")


def activity_fingerprint(config):
    """原生 Session/执行产物在状态查询到 cgroup 冻结之间变化即拒绝停进程。"""
    data = Path(config["idle_database"]).parent
    roots = [data / "sessions", data.parent / "sessions", data / "results", data / "flows"]
    result = {}
    def visit(filename):
        stat = filename.lstat()
        result[str(filename)] = (stat.st_dev, stat.st_ino, stat.st_mode, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns)
        if filename.is_dir() and not filename.is_symlink():
            for child in filename.iterdir():
                visit(child)
    for root in roots:
        if root.exists():
            visit(root)
        else:
            result[str(root)] = None
    return result


def pause_scheduler(config, state_dir, state):
    # 复用旧版 scheduler.lock 的单例协议；root 只读新 inode 使已经通过
    # holds 检查的旧 tick 也不能把心跳覆盖回来。最终 cgroup 检查处理该 tick。
    data = Path(config["idle_database"]).parent
    module = data.parent / "plugins/sec-suite/scheduler.js"
    expected = config.get("scheduler_sha256")
    if not expected or snapshot.sha256(module) != expected:
        raise RuntimeError("调度器代码不符合已验收的冻结协议摘要")
    filename = data / "scheduler.lock"
    if filename.is_symlink():
        raise RuntimeError("调度锁不允许软链")
    metadata = filename.stat() if filename.exists() else None
    before = filename.read_bytes() if metadata else None
    paused = json.dumps({"pid": os.getpid(), "ts": int(time.time() * 1000), "upgrade_pause": str(state_dir)}).encode()
    state["scheduler_pause"] = {"path": str(filename), "before": base64.b64encode(before).decode() if before is not None else None,
        "paused_sha256": hashlib.sha256(paused).hexdigest(),
        "metadata": {"mode": metadata.st_mode & 0o7777, "uid": metadata.st_uid, "gid": metadata.st_gid,
                     "atime_ns": metadata.st_atime_ns, "mtime_ns": metadata.st_mtime_ns} if metadata else None}
    save(state_dir / "state.json", state)
    local_client.atomic_bytes(filename, paused, {"mode": 0o444, "uid": 0, "gid": 0,
                                                "atime_ns": time.time_ns(), "mtime_ns": time.time_ns()})


def assert_scheduler_paused(state):
    pause = state["scheduler_pause"]
    filename = Path(pause["path"])
    metadata = filename.lstat()
    if filename.is_symlink() or metadata.st_uid != 0 or metadata.st_mode & 0o222 or snapshot.sha256(filename) != pause["paused_sha256"]:
        raise RuntimeError("调度暂停锁被修改，拒绝停进程")


def restore_scheduler(state_dir, state):
    pause = state.get("scheduler_pause")
    if not pause or pause.get("restored_at"):
        return
    filename = Path(pause["path"])
    before = None if pause["before"] is None else base64.b64decode(pause["before"])
    current = filename.read_bytes() if filename.exists() else None
    if current != before:
        assert_scheduler_paused(state)
        if before is None:
            filename.unlink()
        else:
            local_client.atomic_bytes(filename, before, pause["metadata"])
    pause["restored_at"] = snapshot.now()
    save(Path(state_dir) / "state.json", state)


def stop_idle_main(config, state_dir, state):
    unit = "silksecagent.service"
    if state["units"][unit]["ActiveState"] != "active":
        assert_idle(config)
        return
    data = Path(config["idle_database"]).parent
    with MaintenanceClient(data, state_dir, **config.get("native_client", {})) as client:
        deadline = time.monotonic() + config.get("drain_timeout_seconds", 300)
        while True:
            assert_scheduler_paused(state)
            try:
                assert_idle(config)
                client.assert_idle()
                break
            except RuntimeError:
                if time.monotonic() >= deadline:
                    raise RuntimeError("排空超时；保持当前版本，恢复原写者") from None
                time.sleep(0.5)
        before = activity_fingerprint(config)
        state["native_idle"] = client.assert_idle()
        # 在暂停服务前注销，冻结点不会带入有效的维护登录。
        client.close()
        state["freezing_units"] = [unit]
        save(state_dir / "state.json", state)
        systemctl("freeze", unit)
        deadline = time.monotonic() + 10
        while systemctl("show", unit, "-p", "FreezerState", "--value").strip() != "frozen":
            if time.monotonic() >= deadline:
                raise RuntimeError("systemd 未确认 cgroup 完全冻结")
            time.sleep(0.05)
        assert_scheduler_paused(state)
        assert_idle(config)
        if activity_fingerprint(config) != before:
            raise RuntimeError("冻结验证发现 Session/执行产物变化；拒绝终止可能在飞的执行")
        state["atomic_idle_verified_at"] = snapshot.now()
        save(state_dir / "state.json", state)
        # stop 会由 systemd 解冻并发送退出信号；入口已停，调度锁仍只读。
        systemctl("stop", unit)
        state["freezing_units"] = []
        save(state_dir / "state.json", state)


def resume(state_dir):
    state_file = Path(state_dir) / "state.json"
    state = json.loads(state_file.read_text())
    if state.get("resumed_at"):
        return state
    errors = []
    # 不允许在不可核实的暂停锁下恢复调度；先还原锁再唤醒被冻结的服务。
    restore_scheduler(state_dir, state)
    for unit in state.get("freezing_units", []):
        try:
            systemctl("thaw", unit)
        except Exception as error:
            errors.append(str(error))
    # 主服务及接收器在外部写者/定时器前恢复；不启动原本 inactive 的 oneshot。
    active = [unit for unit, value in state["units"].items() if value["ActiveState"] == "active"]
    ordered = sorted(active, key=lambda u: (u.endswith(".timer"), u != "silksecagent.service", u == "silksecagent-edge.service", u))
    for unit in ordered:
        if errors:
            break
        try:
            systemctl("start", unit)
            if systemctl("show", unit, "-p", "ActiveState", "--value").strip() != "active":
                raise RuntimeError("服务未恢复 active：" + unit)
        except Exception as error:
            errors.append(str(error))
    for user, values in state["crons"].items():
        if errors:
            break
        try:
            current = crontab(user)
            if current == values["before"]:
                continue
            if current != values["paused"]:
                raise RuntimeError("冻结期间 cron 被另行修改，拒绝覆盖：" + user)
            set_crontab(user, values["before"])
        except Exception as error:
            errors.append(str(error))
    state["resume_errors"] = errors
    if not errors:
        state["resumed_at"] = snapshot.now()
    save(state_file, state)
    if errors:
        raise RuntimeError("恢复写者失败：" + "; ".join(errors))
    return state


def capture(config, work, hold=False):
    work = Path(work).resolve(strict=True)
    roots = snapshot.validate_config(config, work)
    if "silksecagent.service" not in config.get("quiet_units", []):
        raise ValueError("必须冻结 silksecagent.service")
    assert_idle(config)
    state_dir = Path(tempfile.mkdtemp(prefix="dsh-freeze-", dir=work))
    host_state = state_dir / "host-state"
    host_state.mkdir()
    (host_state / "units").mkdir()
    state = {"started_at": snapshot.now(), "units": {}, "crons": {}, "hold": hold}
    for unit in config["quiet_units"]:
        if not re.fullmatch(r"[a-zA-Z0-9@_.-]+\.(service|timer)", unit):
            raise ValueError("非法 systemd 单元")
        values = dict(line.split("=", 1) for line in systemctl("show", unit, "-p", "LoadState", "-p", "ActiveState", "-p", "FragmentPath", "-p", "DropInPaths").splitlines())
        if values["LoadState"] != "loaded" or values["ActiveState"] not in {"active", "inactive", "failed"}:
            raise RuntimeError("单元不在稳定状态：" + unit)
        state["units"][unit] = values
        for filename in [values["FragmentPath"], *values["DropInPaths"].split()]:
            source = Path(filename)
            target = host_state / "units" / source.relative_to("/")
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
    for user in config.get("cron_users", []):
        if not re.fullmatch(r"[a-zA-Z0-9_-]+", user):
            raise ValueError("非法 cron 用户")
        before = crontab(user)
        paused = None if before is None else "".join("# dsh-upgrade-paused " + line if related_cron(line, roots) else line for line in before.splitlines(keepends=True))
        state["crons"][user] = {"before": before, "paused": paused}
    save(state_dir / "state.json", state)
    snapshot.write_json(host_state / "writers-before.json", state)
    effective = {**config, "roots": [*config["roots"], {"name": "host-state", "path": str(host_state), "mutable": False}]}
    snapshot.write_json(state_dir / "snapshot-config.json", effective)
    frozen = False
    try:
        pause_scheduler(config, state_dir, state)
        for user, values in state["crons"].items():
            if values["paused"] != values["before"]:
                set_crontab(user, values["paused"])
        timers = [unit for unit in config["quiet_units"] if unit.endswith(".timer")]
        if timers:
            systemctl("stop", *timers)
        if "silksecagent-edge.service" in state["units"]:
            systemctl("stop", "silksecagent-edge.service")
        others = [unit for unit in config["quiet_units"] if unit.endswith(".service") and unit != "silksecagent.service"]
        if others:
            systemctl("stop", *others)
        stop_idle_main(config, state_dir, state)
        assert_idle(config)
        restore_scheduler(state_dir, state)
        state["frozen_at"] = snapshot.now()
        save(state_dir / "state.json", state)
        ready = snapshot.capture(effective, work)
        if hold:
            snapshot.verify(ready)
        state["snapshot"] = str(ready)
        state["manifest_sha256"] = snapshot.sha256(ready / "manifest.json")
        state["captured_at"] = snapshot.now()
        save(state_dir / "state.json", state)
        frozen = hold
        return {"ok": True, "snapshot": str(ready), "state_dir": str(state_dir), "held": hold,
                "manifest_sha256": state["manifest_sha256"]}
    except BaseException as error:
        state["error"] = {"type": type(error).__name__, "message": str(error)}
        save(state_dir / "state.json", state)
        raise
    finally:
        if not frozen:
            resume(state_dir)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    actions = parser.add_subparsers(dest="action", required=True)
    freeze = actions.add_parser("capture")
    freeze.add_argument("--config", required=True)
    freeze.add_argument("--work-dir", required=True)
    freeze.add_argument("--hold", action="store_true")
    thaw = actions.add_parser("resume")
    thaw.add_argument("--state-dir", required=True)
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise RuntimeError("通过 spool exec 调用 sudo -n，以检查并冻结全部写者")
    os.umask(0o077)
    def interrupted(signum, frame):
        raise RuntimeError("冻结操作被信号中断：" + str(signum))
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGHUP, interrupted)
    with open("/run/lock/silksecagent-upgrade.lock", "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if args.action == "capture":
            result = capture(json.loads(Path(args.config).read_text()), args.work_dir, args.hold)
            if not args.hold:
                # capture 已校验源/副本；第二次独立全树核验放在恢复服务之后，缩短停机窗口。
                snapshot.verify(result["snapshot"])
        else:
            state = resume(args.state_dir)
            result = {"ok": True, "resumed_at": state["resumed_at"]}
        print(json.dumps(result))


if __name__ == "__main__":
    main()
