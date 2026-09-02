#!/usr/bin/env python3
# ==============================================================================
# P15 数据质量断言（data-quality.py）—— 每周复盘 #24 的必跑输入，ops 健康度的 CLI 面。
# 断言集：空值率 / 孤儿外键 / 噪声占比 / 双记忆存储漂移 / 台账空转 / task_runs 新鲜度 /
#         调度漂移 / 垃圾 playbook / _legacy 残留。退出码非 0 = 有 critical 失败。
# 用法：python3 data-quality.py [--db ...] [--json]
# ==============================================================================
import argparse
import json
import os
import sqlite3
import sys
import time

DB_DEFAULT = "/opt/silkspool/dsh/data/asset-graph.db"
PIPELINE_DEFAULT = "/opt/silkspool/dsh/data/pipeline"
SETTINGS_DEFAULT = "/opt/silkspool/dsh/data/settings.yaml"


def q(cur, sql, *args):
    return cur.execute(sql, args).fetchone()[0]


def check_settings(path):
    """P18 纪律：默认 LLM 路由必须经 Bellkeeper /api/llm/v1。"""
    try:
        import yaml
        with open(path, encoding="utf-8") as fh:
            cfg = yaml.safe_load(fh) or {}
    except Exception as e:
        return "critical", f"无法解析 settings.yaml: {e}"

    default = cfg.get("agent-default-model", {})
    provider = default.get("provider")
    model = default.get("model")
    if provider != "bellkeeper":
        return "critical", f"默认模型 provider 不是 bellkeeper: {provider}"
    if model != "pool-secagent":
        return "warn", f"默认模型不是 pool-secagent: {model}"

    providers = cfg.get("llm-pi-ai", {}).get("providers", {})
    bk = providers.get("bellkeeper")
    if not bk:
        return "critical", "llm-pi-ai.providers 中缺少 bellkeeper 路由"
    base_url = bk.get("baseURL", "")
    if "/api/llm/v1" not in base_url:
        return "critical", f"bellkeeper baseURL 不是 /api/llm/v1: {base_url}"
    return "ok", f"默认路由 bellkeeper/pool-secagent -> {base_url}"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=DB_DEFAULT)
    ap.add_argument("--pipeline-dir", default=PIPELINE_DEFAULT)
    ap.add_argument("--settings", default=SETTINGS_DEFAULT)
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    con = sqlite3.connect(args.db)
    cur = con.cursor()
    checks = []  # (name, level, detail)

    # P18 纪律：默认 LLM 路由必须经 Bellkeeper
    checks.append(("llm_default_route", *check_settings(args.settings)))

    total, ungraded = q(cur, "SELECT COUNT(*) FROM assets"), q(cur, "SELECT COUNT(*) FROM assets WHERE level IS NULL")
    pct = round(100 * ungraded / total, 1) if total else 0
    checks.append(("assets_ungraded", "critical" if pct > 50 else "warn" if pct > 20 else "ok", f"{ungraded}/{total} ({pct}%) 未分级"))

    empty_cat = q(cur, "SELECT COUNT(*) FROM facts WHERE category IS NULL OR category = ''")
    checks.append(("facts_empty_category", "warn" if empty_cat else "ok", f"{empty_cat} 条 facts 无 category"))

    noise, signal = q(cur, "SELECT COUNT(*) FROM findings WHERE noise=1"), q(cur, "SELECT COUNT(*) FROM findings WHERE noise=0")
    checks.append(("findings_noise_ratio", "ok", f"信号 {signal} / 噪声 {noise}（噪声已闸门隔离）"))

    null_vt = q(cur, "SELECT COUNT(*) FROM findings WHERE noise=0 AND severity IN ('high','medium','critical') AND (vuln_type IS NULL OR vuln_type='')")
    checks.append(("findings_missing_vuln_type", "warn" if null_vt else "ok", f"{null_vt} 条中高危缺 vuln_type（H-003 回填）"))

    legacy = q(cur, "SELECT COUNT(*) FROM assets WHERE program_id='_legacy'")
    checks.append(("assets_legacy", "info", f"{legacy} 条 _legacy（合法未关联，应只减不增）"))

    for t in ("assets", "endpoints", "findings"):
        orphan = q(cur, f"SELECT COUNT(*) FROM {t} WHERE program_id IS NOT NULL AND program_id NOT IN (SELECT id FROM programs)")
        checks.append((f"{t}_orphan_program", "warn" if orphan else "ok", f"{orphan} 条孤儿外键"))

    junk_pb = q(cur, "SELECT COUNT(*) FROM playbooks WHERE name LIKE 'tool:diag%'")
    checks.append(("playbooks_junk", "warn" if junk_pb else "ok", f"{junk_pb} 条调试垃圾 playbook"))

    bb_n, facts_n = q(cur, "SELECT COUNT(*) FROM blackboard"), q(cur, "SELECT COUNT(*) FROM facts")
    checks.append(("dual_memory_store", "info", f"blackboard {bb_n} 键（观察期，只减不增）/ facts {facts_n} 行"))

    # 调度漂移
    drift_rows = cur.execute(
        "SELECT id, program_id, CAST(next_run_at AS REAL)/NULLIF(CAST(last_run_at + every_seconds*1000 AS REAL),0) AS r"
        " FROM tasks WHERE schedule_kind='interval' AND status NOT IN ('done','failed','cancelled')"
    ).fetchall()
    drift = [(int(i), round(r, 2)) for i, _, r in drift_rows if r and r > 1.5]
    checks.append(("schedule_drift", "critical" if drift else "ok", f"{len(drift)} 个 interval 任务漂移: {drift}"))

    last_run = q(cur, "SELECT COALESCE(MAX(finished_at),0) FROM task_runs")
    stale_h = round((time.time() * 1000 - last_run) / 360000) / 10 if last_run else None
    checks.append(("task_runs_freshness", "critical" if (stale_h is not None and stale_h > 26) else "ok",
                   f"最近执行记录 {stale_h if stale_h is not None else '∞'}h 前"))

    # 台账空转（文件面）
    empty_ledgers = []
    if os.path.isdir(args.pipeline_dir):
        for p in sorted(os.listdir(args.pipeline_dir)):
            f = os.path.join(args.pipeline_dir, p, f"attempts-{p}.tsv")
            if os.path.isfile(f):
                with open(f, encoding="utf-8") as fh:
                    n = sum(1 for line in fh if line.strip()) - 1
                if n <= 0:
                    empty_ledgers.append(p)
    checks.append(("ledger_empty", "critical" if empty_ledgers else "ok", f"零行台账: {empty_ledgers or '无'}"))

    failed = [c for c in checks if c[1] == "critical"]
    if args.json:
        print(json.dumps({"healthy": not failed, "checks": [{"name": n, "level": lv, "detail": d} for n, lv, d in checks]}, ensure_ascii=False, indent=1))
    else:
        icon = {"ok": "✔", "warn": "⚠", "critical": "✘", "info": "·"}
        for n, lv, d in checks:
            print(f"{icon[lv]} [{lv:^8}] {n}: {d}")
        print(f"\n结论: {'健康' if not failed else f'{len(failed)} 项 critical'}")
    con.close()
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
