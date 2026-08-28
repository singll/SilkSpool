#!/usr/bin/env python3
# 给 4 个 interval 任务 objective 追加 P13 流水线规范段（幂等：已含标记则跳过）
import sqlite3

DB = "/opt/silkspool/dsh/data/asset-graph.db"
MARK = "P13-流水线规范"

RECON_ADD = """

【P13-流水线规范（2026-08-27 起强制，细则见技能 sec-pipeline）】
A. 台账留痕：今日所有资产处置结果落 data/pipeline/{program}/assets-{program}.tsv（domain/status/first_seen/last_seen/source/probe_date 六核心列起）；探测类动作落 attempts-{program}.tsv（ts/asset/card_id/card_ver/tool/result/reason/evidence_path/run_id，完成一个立即一行，禁止攒批）。
B. 接口层（L2）：新增存活资产 100% 做接口层收集（katana/waybackurls/gau + JS 端点提取），产出 endpoints-{program}.tsv（url/method/params/auth_required/source/collected_at）。
C. 变化雷达优先：certstream/CT 新子域、JS bundle hash 变化、版本漂移 → 插优先队列立即处置，先于存量覆盖。
D. 防幻觉：覆盖率数字必须给分母（文件+行数）；"可能/疑似"禁止进结论区（只能进 IdeaCard）。
E. 收尾：python3 /opt/silkspool/dsh/scripts/pipeline/pipeline-validate.py 校验今日台账；按 data/templates/handoff-template.md 写 data/pipeline/{program}/handoff-YYYY-MM-DD.md。"""

VULN_ADD = """

【P13-流水线规范（2026-08-27 起强制，细则见技能 sec-pipeline）】
A. 漏洞卡驱动：探测前读 data/vulncards/ 对应卡片（applicable_when 判适用/prerequisites 判阻塞/detect 探测/verify+falsification 确认）；每用一卡落一条 card_usage-YYYY-MM-DD.jsonl（card_id/card_version/asset/result/deviation/suggest，有偏差必记 deviation）。
B. 六态台账：每个探测动作落 data/pipeline/{program}/attempts-{program}.tsv 一行，result ∈ TESTED_CLEAN/CONFIRMED/FALSE_POSITIVE/NOT_APPLICABLE/BLOCKED/STALE；NOT_APPLICABLE 必填 na_reason、BLOCKED 必填 blocker（禁止 other/misc）；TESTED_CLEAN 与 CONFIRMED 必填 evidence_path（无证据不结论）。
C. 工具矩阵（禁止只跑 nuclei）：有参数→dalfox/sqlmap(--level 1 --risk 1 限速)/arjun；CNAME 外部指向→takeover；GraphQL→graphql-cop；登录框→VC-015（无需账号）；401 网关→VC-029 路径变形。nuclei info 级隔离：finding 候选只看 severity≥low。
D. 研究模式产出物改格式：≥3 条新思路写入 data/vulncards/ideas/IC-*.yaml（模板 IC-000-template.yaml，必写 verification_requires 与 first_testable_when），不许只写进报告；探索产出不许直接进 findings。
E. CONFIRMED 建证据包 data/evidence/{finding_id}/（request.txt/response.txt 含时间戳+出口IP/reproduce.md/falsification.md），用 python3 /opt/silkspool/dsh/scripts/pipeline/verify-replay.py 机械复验追加 verify-log.md。
F. 收尾：pipeline-validate.py 校验台账 → coverage-report.py 生成覆盖视图 → 按 handoff-template.md 写 handoff（阻塞与求助按解锁收益排序）。"""

db = sqlite3.connect(DB, timeout=10)
db.execute("PRAGMA busy_timeout = 10000")
plan = {16: RECON_ADD, 17: RECON_ADD, 18: VULN_ADD, 19: VULN_ADD}
for tid, add in plan.items():
    row = db.execute("SELECT objective FROM tasks WHERE id=?", (tid,)).fetchone()
    if not row:
        print(f"#{tid} 不存在，跳过")
        continue
    obj = row[0]
    if MARK in obj:
        print(f"#{tid} 已含 P13 规范，跳过")
        continue
    prog = "meituan-src" if tid in (17, 18) else "bytedance"
    new_obj = obj + add.replace("{program}", prog)
    db.execute("UPDATE tasks SET objective=?, updated_at=? WHERE id=?",
               (new_obj, 1787879900000, tid))
    print(f"#{tid} ({prog}) 已追加 P13 规范（{len(obj)} → {len(new_obj)} 字符）")
db.commit()
db.close()
print("完成")
