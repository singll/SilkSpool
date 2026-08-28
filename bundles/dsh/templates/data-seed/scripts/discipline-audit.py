#!/usr/bin/env python3
# ==============================================================================
# P15 文档-现实校验（discipline-audit.py）—— 评估报告 §14.9 的常态化机制。
# 每次迭代末必跑：纪律机制「上线」≠「生效」，本脚本用数据说话。
# 五指标 + 纪律脱节告警。退出码非 0 = 有纪律脱节。
# 用法：python3 discipline-audit.py [--data-dir /opt/silkspool/dsh/data] [--json]
# ==============================================================================
import argparse
import json
import os
import sqlite3
import sys
import time

DATA_DEFAULT = "/opt/silkspool/dsh/data"


def beijing_date(ts=None):
    return time.strftime("%Y-%m-%d", time.gmtime((ts or time.time()) + 8 * 3600))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", default=DATA_DEFAULT)
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()
    ddir = args.data_dir
    pdir = os.path.join(ddir, "pipeline")
    db_file = os.path.join(ddir, "asset-graph.db")

    today = beijing_date()
    days7 = [beijing_date(time.time() - i * 86400) for i in range(7)]
    metrics = {}

    # 1) 台账日增量（按项目）
    ledger = {}
    if os.path.isdir(pdir):
        for p in sorted(os.listdir(pdir)):
            f = os.path.join(pdir, p, f"attempts-{p}.tsv")
            if not os.path.isfile(f):
                continue
            with open(f, encoding="utf-8") as fh:
                lines = [l for l in fh if l.strip()]
            rows = lines[1:] if lines else []
            ledger[p] = {
                "total": len(rows),
                "today": sum(1 for l in rows if l.split("\t")[0][:10] == today),
            }
    metrics["ledger_today"] = ledger

    # 2) 卡片使用 7 天增量
    cu7 = 0
    if os.path.isdir(pdir):
        for p in os.listdir(pdir):
            pd = os.path.join(pdir, p)
            if not os.path.isdir(pd):
                continue
            for f in os.listdir(pd):
                if f.startswith("card_usage-") and f[11:21] in days7:
                    with open(os.path.join(pd, f), encoding="utf-8") as fh:
                        cu7 += sum(1 for l in fh if l.strip())
    metrics["card_usage_7d"] = cu7

    # 3) 交接包 7 天生成率
    ho7 = 0
    if os.path.isdir(pdir):
        progs = [p for p in os.listdir(pdir) if os.path.isdir(os.path.join(pdir, p))]
        for p in progs:
            for day in days7:
                if os.path.isfile(os.path.join(pdir, p, f"handoff-{day}.md")):
                    ho7 += 1
    metrics["handoff_7d"] = ho7

    # 4) IdeaCard 月增量
    ideas = 0
    ideas_dir = os.path.join(ddir, "vulncards", "ideas")
    if os.path.isdir(ideas_dir):
        ideas = len([f for f in os.listdir(ideas_dir) if f.endswith(".yaml") and not f.startswith("IC-000")])
    metrics["idea_cards"] = ideas

    # 5) 调度漂移 + task_runs 新鲜度
    con = sqlite3.connect(db_file)
    cur = con.cursor()
    drift = cur.execute(
        "SELECT id, program_id, CAST(next_run_at AS REAL)/NULLIF(CAST(last_run_at + every_seconds*1000 AS REAL),0)"
        " FROM tasks WHERE schedule_kind='interval' AND status NOT IN ('done','failed','cancelled')"
    ).fetchall()
    metrics["schedule_drift"] = [{"task": int(i), "program": p, "ratio": round(r, 2)} for i, p, r in drift if r and r > 1.5]
    last_run = cur.execute("SELECT COALESCE(MAX(finished_at),0) FROM task_runs").fetchone()[0]
    metrics["task_runs_last_age_hours"] = round((time.time() * 1000 - last_run) / 360000) / 10 if last_run else None
    con.close()

    alerts = []
    for p, v in metrics["ledger_today"].items():
        if v["total"] == 0:
            alerts.append(f"台账空转: {p}")
    if metrics["card_usage_7d"] == 0:
        alerts.append("card_usage 7 天 0 条")
    if metrics["handoff_7d"] == 0:
        alerts.append("handoff 7 天 0 份")
    if metrics["schedule_drift"]:
        alerts.append(f"调度漂移 {len(metrics['schedule_drift'])} 项")
    lr = metrics["task_runs_last_age_hours"]
    if lr is not None and lr > 26:
        alerts.append(f"task_runs 断链 {lr}h")

    result = {"generated_at": time.strftime("%Y-%m-%dT%H:%M:%S+08:00", time.gmtime(time.time() + 8 * 3600)), **metrics, "alerts": alerts, "healthy": not alerts}
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=1))
    else:
        print(f"== 文档-现实校验 {result['generated_at']} ==")
        print(f"台账: {json.dumps(metrics['ledger_today'], ensure_ascii=False)}")
        print(f"card_usage(7d)={cu7}  handoff(7d)={ho7}  IdeaCard={ideas}")
        print(f"调度漂移: {metrics['schedule_drift'] or '无'}  task_runs 新鲜度: {lr}h")
        print(f"结论: {'纪律在执行 ✔' if not alerts else '纪律脱节 ✘ — ' + '；'.join(alerts)}")
    return 1 if alerts else 0


if __name__ == "__main__":
    sys.exit(main())
