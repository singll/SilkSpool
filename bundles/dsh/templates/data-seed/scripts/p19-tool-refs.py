#!/usr/bin/env python3
# ==============================================================================
# P19：Phase 5.1 prompt 体系全量改写 —— tasks 表 objective 工具引用 → v5 语义动词。
# 复用 p14-1-tool-refs.py 模式（SQL 批量改写 + dry-run 预览 + 幂等可重跑）。
# 真相源映射表 = 17-llm-surface.md §3.3 + bus.aliases.yaml（旧名 → 新动词）。
# 用法：
#   python3 p19-tool-refs.py                     # dry-run：只预览，不写
#   python3 p19-tool-refs.py --apply             # 落库（幂等，可重复跑）
#   python3 p19-tool-refs.py --task 16,17,18     # 只处理指定任务（可选）
# ==============================================================================
import argparse
import re
import sqlite3
import sys
import time

DB = "/opt/silkspool/dsh/data/asset-graph.db"


def _rewrite(text):
    # 负向环视边界：旧名不匹配已带域前缀的新动词（exec_run_cli 里的 run_cli、
    # ledger_coverage_report 里的 coverage_report、vuln_verify_replay 里的 verify_replay …），
    # 保证幂等（重复跑零变更）。
    for old, rep in REPL:
        pat = re.compile(r"(?<![a-z_])" + re.escape(old) + r"(?![a-z_])")
        text = pat.sub(rep, text)
    return text

# 旧工具名 → 新动词（边界感知替换，幂等；顺序无严格要求——负向环视防自匹配）
REPL = [
    ("task_update status=done", "（调度器 task_finish 自动落 done）"),
    ("task_update 本任务 done", "（调度器 task_finish 自动落 done）"),
    ("task_update done", "（调度器 task_finish 自动落 done）"),
    ("task_update(status=cancelled)", "task_cancel"),
    ("task_update(status=blocked)", "task_block"),
    ("proxy_pool_report_bad", "proxy_report_bad"),
    ("proxy_pool_stats", "proxy_stats"),
    ("proxy_pool_list", "proxy_list"),
    ("proxy_pool_gateway", "proxy_gateway"),
    ("proxy_pool_refresh", "proxy_refresh"),
    ("proxy_pool_get", "proxy_sticky_bind"),
    ("blackboard_set", "fact_bb_publish"),
    ("blackboard_get", "fact_bb_read"),
    ("card_usage_log", "ledger_log_card_usage"),
    ("pipeline_validate", "ledger_pipeline_validate"),
    ("coverage_report", "ledger_coverage_report"),
    ("submission_draft", "report_draft_submission"),
    ("verify_replay", "vuln_verify_replay"),
    ("finding_query", "vuln_list"),
    ("finding_add", "vuln_register_signal"),
    ("attempts_log", "ledger_log_attempt"),
    ("radar_read", "ledger_radar_drain"),
    ("surface_queue", "endpoint_queue_surface"),
    ("surface_scan", "endpoint_surface_scan"),
    ("endpoint_query", "endpoint_list"),
    ("endpoint_add", "endpoint_upsert"),
    ("asset_query", "asset_list"),
    ("asset_add", "asset_upsert"),
    ("asset_stats", "asset_overview"),
    ("fp_query", "asset_fp_query"),
    ("fp_add", "asset_fp_record"),
    ("worker_list", "task_worker_list"),
    ("worker_status", "task_worker_status"),
    ("scheduled_tasks", "task_scheduled"),
    ("grep_result", "exec_grep_result"),
    ("page_result", "exec_page_result"),
    ("spawn_worker", "exec_spawn_worker"),
    ("run_cli", "exec_run_cli"),
    ("intel_hunt", "exec_intel_hunt"),
    ("burp_import", "exec_burp_import"),
    ("plan_chain", "exec_plan_chain"),
]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="落库（默认 dry-run）")
    ap.add_argument("--task", default="", help="逗号分隔任务 id，缺省处理全部 interval 任务")
    ap.add_argument("--db", default=DB)
    args = ap.parse_args()

    con = sqlite3.connect(args.db, timeout=10)
    con.execute("PRAGMA busy_timeout = 10000")
    cur = con.cursor()

    if args.task:
        ids = [int(x) for x in args.task.split(",") if x.strip().isdigit()]
        rows = cur.execute(
            "SELECT id, objective FROM tasks WHERE id IN (%s)"
            % ",".join("?" * len(ids)), ids
        ).fetchall()
    else:
        rows = cur.execute(
            "SELECT id, objective FROM tasks "
            "WHERE objective IS NOT NULL AND objective != '' "
            "ORDER BY id"
        ).fetchall()

    now = int(time.time() * 1000)
    changed = 0
    for tid, obj in rows:
        new = _rewrite(obj)
        if new != obj:
            changed += 1
            print(f"#{tid} 已改写工具引用" if args.apply else f"#{tid} 将改写工具引用")
            if args.apply:
                cur.execute(
                    "UPDATE tasks SET objective=?, updated_at=? WHERE id=?",
                    (new, now, tid),
                )
        else:
            print(f"#{tid} 无需变更")

    if args.apply:
        con.commit()
        print(f"\n已落库：{changed} 个任务 objective 改写完成")
    else:
        print(f"\n[dry-run] 共 {changed} 个任务需改写；加 --apply 落库")

    con.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
