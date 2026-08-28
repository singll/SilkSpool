#!/usr/bin/env python3
# P14：提示词层优化——4 个日任务 objective 精简重写（单一事实源=技能）+ #24 挂每周评审段
# 幂等：含 P14 标记则跳过。执行前自动备份 DB。
import sqlite3, shutil, time

DB = "/opt/silkspool/dsh/data/asset-graph.db"
MARK = "P14"
shutil.copy(DB, f"/opt/silkspool/dsh/data/backups/asset-graph.pre-p14-{time.strftime('%Y%m%d-%H%M%S')}.db")

RECON = """【{title}】program={prog}（每日 03:00 北京时间，为 04:00 vuln 任务喂新资产）。

纪律（单一事实源=技能，此处不重复）：执行 sec-runtime-discipline（出口/授权/派单/interval/失败留痕/日期标签）、sec-pipeline（六态台账/防幻觉/收尾六查）、sec-knowledge（记忆治理/rules 先验）全部条款。

流程：
1. 开局：读 scope.yml 当前授权主域（唯一权威）；消费 data/pipeline/{prog}/radar-queue.jsonl（CT 新子域/JS 发版，变化优先于存量）；blackboard_get + fact_search 取昨日状态与 [env-issue]。
2. 收集：run_cli subfinder 全量（被动源 certspotter 主力），gau/waybackurls 补 URL 线索；与资产库 diff（new/changed/removed，removed 只信权威 DNS）；结果落 data/pipeline/{prog}/assets-{prog}.tsv。
3. 探活指纹：new+changed 用 httpx/nuclei 探活+指纹（fp_add），存活分类按既有基线（403+9B=ACL/456=反爬/000 换出口复探）；asset_add 入库并按 data/rules/src/asset-scoring.md 打标（accept 前必读 policy/accept-list）。
4. 接口层：新增存活 web 100% 跑 l2-collect.sh（scripts/pipeline/）产出 endpoints-{prog}.tsv，再 surface-consume.py queue 建参数队列。
5. 新主域候选（只记录不触碰）：证书 SAN/ICP 备案/CNAME 外域等线索 → fact_upsert(category=target, tentative) + blackboard candidate:{prog}:newdomains；严禁对候选域主动探测。
6. 收尾：pipeline_validate.py 校验台账 → 报告 data/reports/{prog}/recon-{name}-YYYY-MM-DD.md（diff 三数+明细+run_id）→ blackboard recon:{prog}:YYYY-MM-DD 与 alive 清单 → 按 handoff 模板写 handoff → task_update done。

收尾 note 格式（执行历史可分辨）：【{short}·recon·MMdd】新增N/改动M/移除K + 报告路径 + run_id 列表。"""

VULN = """【{title}】program={prog}（每日 04:00 北京时间）。

纪律（单一事实源=技能，此处不重复）：执行 sec-runtime-discipline、sec-pipeline（六态台账/漏洞卡驱动/防幻觉/探索配额/收尾六查）、sec-verification（验证铁律/对抗性自检）、sec-knowledge 全部条款；定级读 data/rules/src/severity-rating.md（压级：不膨胀、不确定往低报、忽略级只留 fact）。

流程：
1. 开局：读 data/pipeline/{prog}/ 覆盖台账（attempts PENDING/STALE 按优先级=资产价值×卡片命中率×情报热度×变化因子取 Top N）；huntlist 前置条件判定 100%（超 TTL 决断）；kb_search ≥2 次；IdeaCard first_testable_when 检查。
2. 执行：漏洞卡驱动（data/vulncards/ 读卡 → detect → verify+falsification），工具矩阵按指纹分派（禁止只跑 nuclei；info 级隔离）；每个动作落 attempts-{prog}.tsv 一行；每用一卡落 card_usage 一条（deviation 必填）。
3. 复验：到期 finding 重放比对漂移（修复/消失即更新状态）。
4. 研究模式（覆盖完成后）：≥3 条新思路写 data/vulncards/ideas/IC-*.yaml（必写 verification_requires），探索产出不许直接进 findings。
5. 收尾六查 → pipeline_validate.py → coverage-report.py 生成覆盖视图 → report_build → handoff（阻塞按解锁收益排序）→ task_update done。

收尾 note 格式：【{short}·vuln·MMdd】覆盖X/Y/新发现N/复验M + 报告路径 + run_id 列表。"""

WEEKLY_ADD = """

【P14-每周卡片评审段（2026-08-28 起并入本任务，细则见 doc/secagent/README.md T-4）】
8. 词表评审：合并本周 attempts 台账新出现的 na_reason/blocker 值（近义合并，登记定义）；禁用值 other/misc 出现即纠正。
9. 卡片生命周期：data/vulncards/ 的 draft 卡使用 ≥3 次且规程稳定→转 active；usage≥20 且 hit=0→废止评审；卡片升版波及 >50 单元格→STALE 风暴检查（先抽样 20% 回归）。
10. IdeaCard 巡检：ideas/ 中 first_testable_when 条件已满足的→升级进 huntlist；超 30 天无进展的→评审 rejected 或补充方法。
11. 每月第一周加做：卡片 ROI 排行（hit/usage/fp 三率）→ 头部加权、尾部废止；预算自适应评审（连续零产出天数 → 探索配额调整建议）。
收尾 note 格式：【ops·review·MMdd】晋升N/弃置M/卡片评审K/复验J。"""

def build(template, prog):
    meta = {
        "meituan-src": {"title": "美团SRC·recon 每日资产梳理", "name": "美团SRC", "short": "美团"},
        "bytedance": {"title": "字节SRC·recon 每日资产梳理", "name": "字节SRC", "short": "字节"},
    }
    return template

plan = {
    16: (RECON, {"title": "字节SRC·recon 每日资产梳理", "prog": "bytedance", "name": "字节SRC", "short": "字节"}),
    17: (RECON, {"title": "美团SRC·recon 每日资产梳理", "prog": "meituan-src", "name": "美团SRC", "short": "美团"}),
    18: (VULN, {"title": "美团SRC·vuln 每日漏洞挖掘", "prog": "meituan-src", "name": "美团SRC", "short": "美团"}),
    19: (VULN, {"title": "字节SRC·vuln 每日漏洞挖掘", "prog": "bytedance", "name": "字节SRC", "short": "字节"}),
}

db = sqlite3.connect(DB, timeout=10)
db.execute("PRAGMA busy_timeout = 10000")
now = int(time.time() * 1000)
for tid, (tpl, m) in plan.items():
    row = db.execute("SELECT objective FROM tasks WHERE id=?", (tid,)).fetchone()
    if not row:
        print(f"#{tid} 不存在，跳过"); continue
    if MARK in row[0]:
        print(f"#{tid} 已含 P14，跳过"); continue
    new_obj = tpl.format(**m)
    db.execute("UPDATE tasks SET objective=?, updated_at=? WHERE id=?", (new_obj, now, tid))
    print(f"#{tid} ({m['prog']}) 重写完成（{len(row[0])} → {len(new_obj)} 字符）")

row = db.execute("SELECT objective FROM tasks WHERE id=24").fetchone()
if row and MARK not in row[0]:
    db.execute("UPDATE tasks SET objective=?, updated_at=? WHERE id=24", (row[0] + WEEKLY_ADD, now))
    print(f"#24 已追加每周卡片评审段（{len(row[0])} → {len(row[0])+len(WEEKLY_ADD)} 字符）")
elif row:
    print("#24 已含 P14，跳过")

db.commit(); db.close()
print("P14 完成")
