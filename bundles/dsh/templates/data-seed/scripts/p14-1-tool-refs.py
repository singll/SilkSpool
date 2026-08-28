#!/usr/bin/env python3
# P14.1：objective 中脚本调用改为 DSH 工具调用（sec-pipeline 插件已上线）
import sqlite3, time
DB = "/opt/silkspool/dsh/data/asset-graph.db"
REPL = [
    ("新增存活 web 100% 跑 l2-collect.sh（scripts/pipeline/）产出 endpoints-{prog}.tsv，再 surface-consume.py queue 建参数队列",
     "新增存活 web 100% 用 run_cli tool=l2-collect 产出 endpoints-{prog}.tsv，再 surface_queue 工具建参数队列"),
    ("pipeline_validate.py 校验台账", "pipeline_validate 工具校验台账"),
    ("coverage-report.py 生成覆盖视图", "coverage_report 工具生成覆盖视图"),
]
db = sqlite3.connect(DB, timeout=10)
db.execute("PRAGMA busy_timeout = 10000")
now = int(time.time() * 1000)
for tid in (16, 17, 18, 19):
    obj = db.execute("SELECT objective FROM tasks WHERE id=?", (tid,)).fetchone()[0]
    new = obj
    for old, rep in REPL:
        new = new.replace(old.replace("{prog}", "meituan-src" if tid in (17, 18) else "bytedance"),
                          rep.replace("{prog}", "meituan-src" if tid in (17, 18) else "bytedance"))
    if new != obj:
        db.execute("UPDATE tasks SET objective=?, updated_at=? WHERE id=?", (new, now, tid))
        print(f"#{tid} 已更新工具引用")
    else:
        print(f"#{tid} 无需变更")
db.commit(); db.close()
