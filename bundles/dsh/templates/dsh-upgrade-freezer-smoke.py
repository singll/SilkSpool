#!/usr/bin/env python3
"""用独立瞬态服务验收本机 systemd cgroup freeze/thaw/stop，不操作生产服务。"""
import argparse
import json
import os
from pathlib import Path
import pwd
import subprocess
import tempfile
import time
import uuid


def command(*args):
    result = subprocess.run(args, capture_output=True, text=True, timeout=20)
    if result.returncode:
        raise RuntimeError("瞬态 freezer 验收命令失败：" + args[0])
    return result.stdout.strip()


def eventually(predicate, message):
    deadline = time.monotonic() + 10
    while not predicate():
        if time.monotonic() >= deadline:
            raise RuntimeError(message)
        time.sleep(0.05)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--work-dir", required=True)
    parser.add_argument("--user", default="silkspool")
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise RuntimeError("瞬态服务验收需通过 spool exec sudo -n 运行")
    account = pwd.getpwnam(args.user)
    directory = Path(tempfile.mkdtemp(prefix="dsh-freezer-smoke-", dir=Path(args.work_dir).resolve(strict=True)))
    os.chown(directory, account.pw_uid, account.pw_gid)
    worker = directory / "heartbeat.py"
    heartbeat = directory / "heartbeat"
    worker.write_text("from pathlib import Path\nimport time\np=Path(__file__).with_name('heartbeat')\n"
                      "while True:\n p.write_text(str(time.monotonic_ns()))\n time.sleep(0.025)\n")
    worker.chmod(0o644)
    unit = "silksec-upgrade-freezer-fixture-" + uuid.uuid4().hex[:12] + ".service"
    report = {"unit": unit, "ok": False, "checks": []}
    try:
        command("systemd-run", "--quiet", "--collect", "--unit", unit, "--property=User=" + args.user,
                "--property=NoNewPrivileges=yes", "--property=PrivateTmp=yes", "--property=TimeoutStopSec=5",
                "/usr/bin/python3", str(worker))
        eventually(lambda: heartbeat.is_file() and heartbeat.stat().st_size > 0, "瞬态进程未开始写入")
        pid = int(command("systemctl", "show", unit, "-p", "MainPID", "--value"))
        if pid < 2:
            raise RuntimeError("瞬态进程 PID 无效")
        command("systemctl", "freeze", unit)
        eventually(lambda: command("systemctl", "show", unit, "-p", "FreezerState", "--value") == "frozen", "未确认 cgroup frozen")
        before = heartbeat.read_bytes()
        time.sleep(0.4)
        if heartbeat.read_bytes() != before:
            raise RuntimeError("cgroup frozen 后进程仍在写入")
        report["checks"].append("frozen-stops-writes")
        command("systemctl", "thaw", unit)
        eventually(lambda: heartbeat.read_bytes() != before, "thaw 后进程未恢复写入")
        report["checks"].append("thaw-resumes-writes")
        command("systemctl", "freeze", unit)
        eventually(lambda: command("systemctl", "show", unit, "-p", "FreezerState", "--value") == "frozen", "第二次冻结失败")
        command("systemctl", "stop", unit)
        eventually(lambda: not Path("/proc", str(pid)).exists(), "stop 未回收 frozen 进程")
        report["checks"].append("stop-thaws-and-reaps")
        report["ok"] = True
    except Exception as error:
        report["error"] = {"type": type(error).__name__, "message": str(error)}
    finally:
        subprocess.run(["systemctl", "stop", unit], capture_output=True, timeout=20)
        (directory / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({**report, "directory": str(directory)}))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
