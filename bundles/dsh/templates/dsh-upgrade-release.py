#!/usr/bin/env python3
"""封存静态候选、从冻结点准备完整新旧树并按持久化日志交换目录。

切换不安装依赖、不删旧树、不放行写者。生产动作要求仍在 hold 的完整冻结点；
--restore-copy 仅在 prepare 时绑定已有恢复副本，后续动作只能操作该副本。
"""
import argparse
import ctypes
from datetime import datetime, timedelta
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


snapshot = module("snapshot", "dsh-upgrade-snapshot.py")
freeze = module("freeze", "dsh-upgrade-freeze.py")
# 源→目标对由环境变量传入（dsh-upgrade.sh 负责导出）；默认保持 0.1.5 链的历史组合。
SUPPORTED_PAIRS = {("0.1.2-rc.1", "0.1.5-rc.2"), ("0.1.5-rc.2", "0.1.7-rc.2")}
VERSION = os.environ.get("DSH_TARGET_VERSION", "0.1.5-rc.2")
OLD_VERSION = os.environ.get("DSH_OLD_VERSION", "0.1.2-rc.1")
ROLES = ("recon", "vuln-hunt", "biz-logic", "code-audit", "intranet", "review", "orchestrator")


def require_supported_pair():
    if (OLD_VERSION, VERSION) not in SUPPORTED_PAIRS:
        raise RuntimeError(f"不支持的升级组合 {OLD_VERSION} → {VERSION}；拒绝继续")
    return OLD_VERSION, VERSION


def require(value, message):
    if not value:
        raise RuntimeError(message)


def read_json(filename):
    return json.loads(Path(filename).read_text())


def identity(path):
    metadata = Path(path).lstat()
    return [metadata.st_dev, metadata.st_ino]


def exchange(left, right):
    """同文件系统 Linux 原子交换；失败时不以分步 rename 降级。"""
    left, right = Path(left), Path(right)
    require(left.is_dir() and right.is_dir() and not left.is_symlink() and not right.is_symlink(), "交换根必须为真实目录")
    require(left.stat().st_dev == right.stat().st_dev, "恢复树与当前树不在同一文件系统")
    libc = ctypes.CDLL(None, use_errno=True)
    call = libc.renameat2
    call.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    call.restype = ctypes.c_int
    if call(-100, os.fsencode(left), -100, os.fsencode(right), 2) != 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))
    for directory in {left.parent, right.parent}:
        fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)


def item_manifest(path):
    return snapshot.tree_manifest(path)


def static_paths(candidate):
    paths = ["app", "plugins", "plugins.lock", "data/profiles/web", "data/profiles/headless"]
    paths += ["data/.agent-presets/" + name for name in ROLES]
    paths += [p.name for p in sorted(candidate.iterdir()) if p.is_file() and p.suffix in {".sh", ".py", ".js", ".mjs"}]
    paths += ["scripts/pipeline/dsh-version-watch.sh", "data-seed/scripts/dsh-version-watch.sh"]
    require(all((candidate / p).exists() and not (candidate / p).is_symlink() for p in paths), "候选静态产物不完整或根路径含软链")
    return paths


def validate_versions(candidate):
    package = read_json(candidate / "app/node_modules/@deepseek-ai/dsh/package.json")
    require(package["version"] == VERSION and read_json(candidate / "app/package.json")["dependencies"]["@deepseek-ai/dsh"] == VERSION,
            "候选 app 版本不是本次锁定的目标版本")
    setup_text = (candidate / "setup.sh").read_text()
    require(("DSH_TARGET_VERSION:-" + VERSION) in setup_text or ('DSH_VERSION="' + VERSION + '"') in setup_text, "setup pin 不符")
    watch_text = (candidate / "scripts/pipeline/dsh-version-watch.sh").read_text()
    require(("DSH_KNOWN_VERSION:-" + VERSION) in watch_text or ('KNOWN="' + VERSION + '"') in watch_text, "版本观察脚本 pin 不符")
    versions = {}
    for root in (candidate / "app", candidate / "data/profiles/web", candidate / "data/profiles/headless"):
        require((root / "pnpm-lock.yaml").is_file(), "安装树缺少依赖锁")
        # 同时覆盖 pnpm isolated 与 hoisted 布局；不能把不存在的 .pnpm 目录当作通过。
        packages = [p for p in (root / "node_modules").rglob("package.json") if p.parent.parent.name == "@deepseek-ai"]
        # 只装 failover 的 headless profile 由 app 提供核心；其中若自带核心才比较。
        require(root != candidate / "app" or packages, "app 缺少可核对的核心依赖")
        for filename in packages:
            package = read_json(filename)
            name, version = package["name"], package["version"]
            require(name not in versions or versions[name] == version, "app/profile 存在不一致的核心版本：" + name)
            versions[name] = version
    for profile in ("web", "headless"):
        for filename in (candidate / "data/.agent-presets").glob("*/package.json"):
            package = read_json(filename)
            require(not any(value == "latest" for value in package.get("dependencies", {}).values()), "用户预设有 latest 依赖")
        installed = candidate / "data/profiles" / profile / "node_modules/dsh-model-failover/package.json"
        require(read_json(installed)["version"] == "0.1.4", "failover 安装版本不符")
    browser = read_json(candidate / "browser-fork-report.json")
    tarball = candidate / "plugins" / Path(browser["tarball"]).name
    require(browser["offline_frozen_install"] and snapshot.sha256(tarball) == browser["sha256"], "浏览器冻结锁/产物不符")
    locked = [line.split("|") for line in (candidate / "plugins.lock").read_text().splitlines() if line.startswith("@silksec/dsh-browser|")]
    require(len(locked) == 1 and locked[0][1:3] == [browser["version"], "sha256-" + browser["sha256"]], "plugins.lock 浏览器版本/摘要不符")
    require(snapshot.sha256(candidate / "data/profiles/web/pnpm-lock.yaml") == browser["profile_lock_sha256"], "浏览器构建后 profile 锁改变")
    for name, digest in browser["files"].items():
        require(snapshot.sha256(candidate / "data/profiles/web/node_modules/@silksec/dsh-browser" / name) == digest,
                "浏览器实际安装与封装不符")
    return {"core_versions": versions, "browser_sha256": browser["sha256"],
            "locks": {rel: snapshot.sha256(candidate / rel / "pnpm-lock.yaml") for rel in ("app", "data/profiles/web", "data/profiles/headless")}}


def seal(candidate, acceptance=None):
    candidate = Path(candidate).resolve(strict=True)
    report = {"kind": "dsh-static-candidate", "schema": 1, "version": VERSION, "candidate": str(candidate),
              "sealed_at": snapshot.now(), "ready_for_cutover": False, **validate_versions(candidate)}
    report["artifacts"] = {name: item_manifest(candidate / name) for name in static_paths(candidate)}
    if acceptance:
        acceptance = Path(acceptance).resolve(strict=True)
        accepted = read_json(acceptance)
        require(accepted.get("version") == VERSION, "验收版本不符")
        require(set(accepted.get("gates", {})) == {"U-" + letter for letter in "ABCDEFGHI"}, "缺少 U-A～I 验收")
        for gate, result in accepted["gates"].items():
            require(result.get("ok") is True and result.get("evidence"), "验收未放行：" + gate)
            for item in result["evidence"]:
                require(snapshot.sha256(Path(item["path"])) == item["sha256"], "验收证据哈希不符")
        report.update(ready_for_cutover=True, acceptance=str(acceptance), acceptance_sha256=snapshot.sha256(acceptance))
    freeze.save(candidate / "candidate-seal.json", report)
    return {"candidate": str(candidate), "seal_sha256": snapshot.sha256(candidate / "candidate-seal.json"), "ready_for_cutover": report["ready_for_cutover"]}


def verify_seal(candidate, production=False):
    candidate = Path(candidate).resolve(strict=True)
    sealed = read_json(candidate / "candidate-seal.json")
    require(sealed.get("kind") == "dsh-static-candidate" and sealed.get("schema") == 1 and sealed.get("version") == VERSION, "候选封存格式不符")
    require(set(sealed["artifacts"]) == set(static_paths(candidate)), "候选文件集合改变")
    for relative, entries in sealed["artifacts"].items():
        require(item_manifest(candidate / relative) == entries, "候选在封存后改变：" + relative)
    if production:
        require(sealed.get("ready_for_cutover") is True, "候选只允许预演，尚未通过全部验收")
        require(snapshot.sha256(Path(sealed["acceptance"])) == sealed["acceptance_sha256"], "验收报告封存后改变")
    return sealed


def recovery_subdir(recovery_file, canonical_base):
    source = Path(read_json(recovery_file)["source"])
    require(source.is_absolute(), "恢复报告来源必须为绝对路径")
    try:
        relative = source.relative_to(canonical_base)
    except ValueError:
        raise RuntimeError("恢复报告不属于本次 DSH 恢复根") from None
    require(str(relative) in {"data/sessions", "sessions"}, "恢复报告来源不是已分类的 Session 根")
    return relative


def recover_legacy(session_root, recovery_file):
    recovery = read_json(recovery_file)
    require(recovery.get("ok") and recovery.get("target_version") == VERSION, "恢复分支报告未通过")
    applied = []
    for row in recovery["sessions"]:
        relative = Path(row["relative"])
        require(not relative.is_absolute() and ".." not in relative.parts, "非法恢复路径")
        target = session_root / relative
        require(not target.is_symlink() and snapshot.inside(target.resolve(), session_root.resolve()), "恢复日志路径越过 Session 根")
        branch = row["branches"]["continued"]
        require(row["ok"] and row["original_unchanged"] and row["raw_rows_preserved"] and row["strict_branches_validated"]
                and row["sequence_renumbered"] is False and row["kind"] == "interrupted-closers-overlap", "恢复证明不完整")
        require(snapshot.sha256(target) == row["source_sha256"] and snapshot.sha256(Path(row["archive"])) == row["source_sha256"], "恢复源已变化")
        require(snapshot.sha256(Path(branch["file"])) == branch["stored_sha256"] and branch["fresh_backend_read"], "旧代恢复分支未验证")
        meta = target.stat()
        freeze.local_client.atomic_bytes(target, Path(branch["file"]).read_bytes(), {"mode": meta.st_mode & 0o7777, "uid": meta.st_uid,
            "gid": meta.st_gid, "atime_ns": meta.st_atime_ns, "mtime_ns": meta.st_mtime_ns})
        applied.append({"relative": str(relative), "before": row["source_sha256"], "after": branch["stored_sha256"]})
    return applied


def overlay(candidate, target, sealed):
    for relative in sealed["artifacts"]:
        source, destination = candidate / relative, target / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        if destination.is_dir() and not destination.is_symlink():
            shutil.rmtree(destination)
        elif destination.exists() or destination.is_symlink():
            destination.unlink()
        snapshot.copy_tree(source, destination)


def prepare(snapshot_dir, candidate, work, recovery_file, restore_copy=None):
    snapshot_dir, candidate, work, recovery_file = (Path(p).resolve(strict=True) for p in (snapshot_dir, candidate, work, recovery_file))
    manifest = snapshot.verify(snapshot_dir)
    sealed = verify_seal(candidate, production=restore_copy is None)
    require(read_json(snapshot_dir / "trees/dsh/app/node_modules/@deepseek-ai/dsh/package.json")["version"] == OLD_VERSION, "恢复点旧版本不符")
    mutable = {row["name"]: manifest["roots"][row["name"]] for row in manifest["config"]["roots"] if row.get("mutable", True)}
    require("dsh" in mutable, "DSH 必须属于可恢复根")
    restored = None
    if restore_copy:
        restored = Path(restore_copy).resolve(strict=True)
        proof = read_json(restored / "restore-report.json")
        require(proof.get("files_verified") and proof["manifest_sha256"] == snapshot.sha256(snapshot_dir / "manifest.json"), "恢复副本来源不符")
        for name, row in mutable.items():
            require((restored / name).resolve() != Path(row["source"]).resolve(), "预演不允许指向生产目录")
    release = Path(tempfile.mkdtemp(prefix="dsh-release-", dir=work))
    release.chmod(0o700)
    state = {"kind": "dsh-release", "schema": 1, "phase": "preparing", "release": str(release), "version": VERSION,
             "snapshot": str(snapshot_dir), "manifest_sha256": snapshot.sha256(snapshot_dir / "manifest.json"),
             "candidate": str(candidate), "seal_sha256": snapshot.sha256(candidate / "candidate-seal.json"),
             "recovery_report": str(recovery_file), "recovery_sha256": snapshot.sha256(recovery_file),
             "restore_copy": str(restored) if restored else None, "roots": {}, "started_at": snapshot.now()}
    freeze.save(release / "state.json", state)
    try:
        for side in ("next", "rollback"):
            (release / side).mkdir()
            for name, row in mutable.items():
                snapshot.copy_tree(snapshot_dir / "trees" / name, release / side / name)
        overlay(candidate, release / "next/dsh", sealed)
        invariants = module("invariants", "dsh-upgrade-invariants.py")
        state["index_repairs"] = {}
        for side in ("next", "rollback"):
            repairs = {}
            for database in manifest["config"].get("sqlite", []):
                if database["root"] not in mutable:
                    continue
                key = database["root"] + "/" + database["path"]
                repairs[key] = invariants.repair_indexes(release / side / key)
            report = release / (side + "-index-repairs.json")
            freeze.save(report, repairs)
            state["index_repairs"][side] = {"report": str(report), "sha256": snapshot.sha256(report)}
        session_relative = recovery_subdir(recovery_file, manifest["roots"]["dsh"]["source"])
        state["legacy_recovery_root"] = str(session_relative)
        state["legacy_recoveries"] = recover_legacy(release / "rollback/dsh" / session_relative, recovery_file)
        base = release / "next/dsh"
        command = ["/usr/local/node/bin/node", str(Path(__file__).with_name("dsh-session-rehearsal.mjs")),
                   "--app-dir", str(base / "app"), "--work-dir", str(release),
                   "--recovery-report", str(recovery_file), "--recovery-source-root", str(base / session_relative)]
        source_relatives = [relative for relative in ("data/sessions", "sessions") if (base / relative).is_dir()]
        for relative in source_relatives:
            command.extend(["--source", str(base / relative)])
        with (release / "migration.log").open("w") as log:
            result = subprocess.run(command, stdout=log, stderr=log, timeout=1800)
        reports = list(release.glob("session-rehearsal-*/report.json"))
        require(result.returncode == 0 and len(reports) == 1, "正式迁移准备失败；查看私有 migration.log")
        migrated = read_json(reports[0])
        require(migrated.get("ok") and migrated["original_files_unchanged"] and migrated["failures"] == 0, "Session 全量迁移未通过")
        count = 0
        for source, relative in zip(migrated["sources"], source_relatives):
            destination = base / relative
            for published in Path(source["destination"]).rglob("session.v3.jsonl*"):
                target = destination / published.relative_to(source["destination"])
                require(not target.exists(), "旧恢复点已有 Session V3，拒绝覆盖")
                shutil.copy2(published, target)
                meta = target.parent.stat()
                os.chown(target, meta.st_uid, meta.st_gid)
                count += 1
        require(count == len(migrated["sessions"]), "Session V3 发布数量不符")
        state["migration"] = {"report": str(reports[0]), "sha256": snapshot.sha256(reports[0]), "sessions": count}
        hosts = [(name, release / "next" / name / "browser/shared-browser-host.mjs") for name in mutable
                 if name != "dsh" and (release / "next" / name / "browser/shared-browser-host.mjs").is_file()]
        require(len(hosts) == 1, "共享浏览器宿主位置未唯一分类")
        host_root, host_path = hosts[0]
        meta = host_path.stat()
        freeze.local_client.atomic_bytes(host_path, (candidate / "dsh-shared-browser-host.mjs").read_bytes(), {
            "mode": meta.st_mode & 0o7777, "uid": meta.st_uid, "gid": meta.st_gid, "atime_ns": meta.st_atime_ns, "mtime_ns": meta.st_mtime_ns})
        state["shared_browser_host"] = {"root": host_root, "relative": "browser/shared-browser-host.mjs"}
        for name, row in mutable.items():
            current = restored / name if restored else Path(row["source"])
            state["roots"][name] = {"current": str(current), "next": str(release / "next" / name), "rollback": str(release / "rollback" / name),
                "next_id": identity(release / "next" / name), "rollback_id": identity(release / "rollback" / name)}
        manifests = {side: {name: item_manifest(release / side / name) for name in mutable} for side in ("next", "rollback")}
        freeze.save(release / "prepared-manifests.json", manifests)
        state["prepared_manifests_sha256"] = snapshot.sha256(release / "prepared-manifests.json")
        state.update(phase="prepared", prepared_at=snapshot.now())
    except BaseException as error:
        state["error"] = {"type": type(error).__name__, "message": str(error)}
        raise
    finally:
        freeze.save(release / "state.json", state)
    return {"ok": True, "release": str(release), "mode": "isolated-copy" if restored else "production", "sessions": count}


def assert_held(state, freeze_state):
    if state["restore_copy"]:
        roots = [Path(row["current"]) for row in state["roots"].values()]
        snapshot.no_related_processes(roots)
        return
    require(freeze_state, "生产操作必须指定持有中的 freeze state")
    held = read_json(Path(freeze_state) / "state.json")
    require(held.get("hold") and not held.get("resumed_at") and held.get("manifest_sha256") == state["manifest_sha256"], "冻结点已放行或不是本次恢复点")
    snapshot.assert_quiescent(read_json(Path(state["snapshot"]) / "manifest.json")["config"])
    state["freeze_state"] = str(Path(freeze_state).resolve(strict=True))


def switch(release, freeze_state=None):
    release = Path(release).resolve(strict=True)
    state = read_json(release / "state.json")
    require(snapshot.sha256(release / "prepared-manifests.json") == state["prepared_manifests_sha256"], "准备树清单被修改")
    manifests = read_json(release / "prepared-manifests.json")
    require(state["phase"] in {"prepared", "switching", "switched"}, "当前阶段不允许切换")
    assert_held(state, freeze_state or state.get("freeze_state"))
    if state["phase"] == "switched":
        require(all(identity(row["current"]) == row["next_id"] for row in state["roots"].values()), "切换后的目录被另行替换")
        return {"ok": True, "phase": "switched"}
    if state["phase"] == "prepared":
        require(snapshot.sha256(Path(state["candidate"]) / "candidate-seal.json") == state["seal_sha256"], "候选封存记录改变")
        verify_seal(state["candidate"], production=not state["restore_copy"])
        manifest = snapshot.verify(state["snapshot"])
        for name, row in state["roots"].items():
            require(item_manifest(Path(row["current"])) == manifest["roots"][name]["entries"], "当前树与冻结点不一致：" + name)
            for side in ("next", "rollback"):
                require(item_manifest(Path(row[side])) == manifests[side][name], "准备产物改变：" + side + "/" + name)
            row["before_id"] = identity(row["current"])
        state["phase"] = "switching"
        freeze.save(release / "state.json", state)
    for name, row in state["roots"].items():
        current = identity(row["current"])
        if current == row["next_id"]:
            require(identity(row["next"]) == row["before_id"], "已交换的原件目录不符")
        else:
            require(current == row["before_id"] and identity(row["next"]) == row["next_id"], "交换目录身份不符，拒绝猜测")
            require(item_manifest(Path(row["next"])) == manifests["next"][name], "待交换的新树已改变：" + name)
            exchange(row["current"], row["next"])
        row["switched"] = True
        freeze.save(release / "state.json", state)
    state.update(phase="switched", switched_at=snapshot.now())
    freeze.save(release / "state.json", state)
    return {"ok": True, "phase": state["phase"], "writers_held": True}


def rollback(release, freeze_state=None):
    release = Path(release).resolve(strict=True)
    state = read_json(release / "state.json")
    require(snapshot.sha256(release / "prepared-manifests.json") == state["prepared_manifests_sha256"], "准备树清单被修改")
    manifests = read_json(release / "prepared-manifests.json")
    require(state["phase"] in {"switching", "switched", "rolling-back", "rolled-back"}, "自动回滚只允许尚未恢复业务写者的切换窗口")
    assert_held(state, freeze_state or state.get("freeze_state"))
    if state["phase"] == "rolled-back":
        require(all(identity(row["current"]) == row["rollback_id"] for row in state["roots"].values()), "回滚目录身份不符")
        return {"ok": True, "phase": state["phase"]}
    for name, row in state["roots"].items():
        if identity(row["current"]) == row["rollback_id"]:
            continue
        require(identity(row["rollback"]) == row["rollback_id"] and item_manifest(Path(row["rollback"])) == manifests["rollback"][name],
                "回滚树已改变：" + name)
        require(identity(row["current"]) in (row["before_id"], row["next_id"]), "无法识别当前树，拒绝回滚")
    state["phase"] = "rolling-back"
    freeze.save(release / "state.json", state)
    for name, row in state["roots"].items():
        if identity(row["current"]) != row["rollback_id"]:
            exchange(row["current"], row["rollback"])
        row["rolled_back"] = True
        freeze.save(release / "state.json", state)
    state.update(phase="rolled-back", rolled_back_at=snapshot.now())
    freeze.save(release / "state.json", state)
    return {"ok": True, "phase": state["phase"], "new_state_preserved": True, "writers_held": True}


def pre_resume_invariants(state, release_dir):
    invariants = module("invariants", "dsh-upgrade-invariants.py")
    manifest = Path(state["snapshot"]) / "manifest.json"
    require(snapshot.sha256(manifest) == state["manifest_sha256"], "恢复点清单改变")
    before = invariants.capture(Path(state["snapshot"]) / "trees", manifest)
    after_root = Path(state["restore_copy"]) if state["restore_copy"] else None
    after = invariants.capture(after_root, manifest, before)
    result = invariants.compare(before, after, state["candidate"] if state["phase"] == "switched" else None)
    result.update(captured_at=snapshot.now(), source_manifest_sha256=state["manifest_sha256"], after=after)
    filename = release_dir / "pre-resume-invariants.json"
    freeze.save(filename, result)
    require(result["ok"], "恢复写者前业务不变量失败；检查私有 pre-resume-invariants.json")
    return {"report": str(filename), "sha256": snapshot.sha256(filename)}


def finalize(release_dir, freeze_state=None):
    release_dir = Path(release_dir).resolve(strict=True)
    state_file = release_dir / "state.json"
    state = read_json(state_file)
    require(state["phase"] in {"switched", "rolled-back", "resuming", "observing", "restored"}, "当前阶段不能恢复业务写者")
    if state["phase"] in {"observing", "restored"}:
        return {"ok": True, "phase": state["phase"], "observation_until": state.get("observation_until")}
    if state["phase"] != "resuming":
        assert_held(state, freeze_state or state.get("freeze_state"))
        filename = release_dir / ("maintenance-" + state["phase"] + "-report.json")
        smoke = read_json(filename)
        expected = VERSION if state["phase"] == "switched" else OLD_VERSION
        require(smoke.get("ok") and smoke.get("checks", {}).get("version") == expected, "最小启动验收未通过")
        maintenance = read_json(release_dir / "maintenance-state.json")
        require(maintenance.get("cleaned_at") and maintenance.get("started_at") == smoke.get("started_at"), "维护服务尚未退出和清理或验收不是当前尝试")
        state["pre_resume_invariants"] = pre_resume_invariants(state, release_dir)
        state["minimum_smoke"] = {"report": str(filename), "sha256": snapshot.sha256(filename)}
        state.update(resuming_from=state["phase"], phase="resuming", writer_resume_started_at=snapshot.now())
        # 在第一个写者启动之前记录 resuming；中断后不能再按切流前窗口覆盖新业务。
        freeze.save(state_file, state)
    for proof in (state["pre_resume_invariants"], state["minimum_smoke"]):
        require(snapshot.sha256(Path(proof["report"])) == proof["sha256"], "恢复写者的验收证据改变")
    if not state["restore_copy"]:
        freeze.resume(state["freeze_state"])
    enabled = snapshot.now()
    if state["resuming_from"] == "switched":
        state.update(phase="observing", observing_at=enabled,
                     observation_until=(datetime.fromisoformat(enabled) + timedelta(hours=72)).isoformat())
    else:
        state.update(phase="restored", restored_at=enabled)
    freeze.save(state_file, state)
    return {"ok": True, "phase": state["phase"], "observation_until": state.get("observation_until")}


def preserve_after_resume(release_dir, freeze_state):
    """切流后先保存新冻结点并列出对账范围；禁止自动覆盖新增 Session/裁决。"""
    release_dir = Path(release_dir).resolve(strict=True)
    state_file = release_dir / "state.json"
    state = read_json(state_file)
    require(state["phase"] in {"resuming", "observing", "reconciling"}, "只有已恢复写者的发布需要新增状态保全")
    require(freeze_state, "新增状态保全要求另一个持有中的完整冻结点")
    held = read_json(Path(freeze_state) / "state.json")
    require(held.get("hold") and not held.get("resumed_at"), "新增状态冻结点已经放行")
    current_snapshot = Path(held["snapshot"]).resolve(strict=True)
    require(current_snapshot != Path(state["snapshot"]).resolve(), "不能把升级前冻结点作为新增状态保全")
    require(snapshot.sha256(current_snapshot / "manifest.json") == held["manifest_sha256"], "新增状态冻结点摘要不符")
    manifest = snapshot.verify(current_snapshot)
    if state["restore_copy"]:
        snapshot.no_related_processes([Path(row["current"]) for row in state["roots"].values()])
    else:
        snapshot.assert_quiescent(manifest["config"])
    for name, row in state["roots"].items():
        require(Path(manifest["roots"][name]["source"]).resolve() == Path(row["current"]).resolve(), "新增冻结点来源不是当前发布根")
        require(item_manifest(Path(row["current"])) == manifest["roots"][name]["entries"], "新状态冻结后又变化：" + name)
    require(snapshot.sha256(release_dir / "prepared-manifests.json") == state["prepared_manifests_sha256"], "初始发布清单改变")
    initial = read_json(release_dir / "prepared-manifests.json")["next"]["dsh"]
    current = manifest["roots"]["dsh"]["entries"]
    changes = []
    for name in sorted(initial.keys() | current.keys()):
        if not name.startswith(("data/sessions/", "sessions/")):
            continue
        before, after = initial.get(name, {}), current.get(name, {})
        if before.get("sha256") != after.get("sha256"):
            changes.append({"relative": name, "before": before.get("sha256"), "after": after.get("sha256")})
    invariants = module("invariants", "dsh-upgrade-invariants.py")
    original_manifest = Path(state["snapshot"]) / "manifest.json"
    before = invariants.capture(Path(state["snapshot"]) / "trees", original_manifest)
    after = invariants.capture(current_snapshot / "trees", current_snapshot / "manifest.json", before)
    # 此处专门对比两个不同冻结点，保留双方来源；不能当作自动放行凭据。
    report = {"schema": 1, "captured_at": snapshot.now(), "new_state_preserved": True, "automatic_restore_allowed": False,
              "original_snapshot": state["snapshot"], "current_snapshot": str(current_snapshot),
              "current_manifest_sha256": held["manifest_sha256"], "session_changes": changes,
              "business_comparison": invariants.compare(before, after, state["candidate"], same_freeze_point=False),
              "reconciliation": "Session V3 隔离保留；领域库/证据按变化逐项验证保留或对账重放，外部操作不得盲目重放。"}
    filename = release_dir / "post-resume-reconciliation.json"
    freeze.save(filename, report)
    state.update(phase="reconciling", preserved_after_resume={"snapshot": str(current_snapshot),
        "manifest_sha256": held["manifest_sha256"], "freeze_state": str(Path(freeze_state).resolve()),
        "report": str(filename), "sha256": snapshot.sha256(filename)})
    freeze.save(state_file, state)
    return {"ok": True, "phase": "reconciling", "new_state_preserved": True,
            "automatic_restore_allowed": False, "changed_session_files": len(changes), "report": str(filename)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    actions = parser.add_subparsers(dest="action", required=True)
    seal_parser = actions.add_parser("seal")
    seal_parser.add_argument("--candidate", required=True)
    seal_parser.add_argument("--acceptance")
    prepare_parser = actions.add_parser("prepare")
    for name in ("snapshot", "candidate", "work-dir", "recovery-report"):
        prepare_parser.add_argument("--" + name, required=True)
    prepare_parser.add_argument("--restore-copy")
    for name in ("switch", "rollback", "finalize", "preserve"):
        operation = actions.add_parser(name)
        operation.add_argument("--release-dir", required=True)
        operation.add_argument("--freeze-state")
    args = parser.parse_args()
    require_supported_pair()
    require(os.geteuid() == 0, "通过 spool exec sudo -n 运行发布工具")
    os.umask(0o077)
    with open("/run/lock/silksecagent-upgrade.lock", "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if args.action == "seal":
            result = seal(args.candidate, args.acceptance)
        elif args.action == "prepare":
            result = prepare(args.snapshot, args.candidate, args.work_dir, args.recovery_report, args.restore_copy)
        else:
            operation = {"switch": switch, "rollback": rollback, "finalize": finalize, "preserve": preserve_after_resume}[args.action]
            result = operation(args.release_dir, args.freeze_state)
    print(json.dumps(result))


if __name__ == "__main__":
    main()
