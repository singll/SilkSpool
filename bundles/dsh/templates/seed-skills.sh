#!/usr/bin/env bash
# ==============================================================================
# SilkSecAgent 核心 Skill 种子（幂等：只补缺失）
# DSH 用户级技能目录：$DSH_HOME/skills/<name>/SKILL.md
# ==============================================================================
set -euo pipefail

DATA_DIR="${DSH_HOME:-{{BASE_DIR}}/data}"
SKILLS_DIR="$DATA_DIR/skills"

log() { echo "[seed-skills] $*"; }

seed() {
    local name="$1"
    if [ -f "$SKILLS_DIR/$name/SKILL.md" ]; then
        log "$name 已存在，跳过"
        return
    fi
    mkdir -p "$SKILLS_DIR/$name"
    cat > "$SKILLS_DIR/$name/SKILL.md"
    log "$name 已写入"
}

seed sec-verification <<'EOF'
---
name: sec-verification
description: 验证铁律——任何漏洞结论必须有可回溯证据，否则视为幻觉打回。所有漏洞判定/报告场景强制使用。
---

# 验证铁律

1. **任何漏洞结论必须附证据引用**：run_id（run_cli 产出）/ flow_id（流量归档）/ burp_item（人工验证）三选一，外加一句话证据摘要。无证据的结论不得写入 finding，不得向用户报告。
2. **判定前必看原始输出**：用 grep_result/page_result 核对 run_id 的原始响应，确认状态码、响应特征与结论一致。扫描器报"存在"不等于存在。
3. **误报典型特征**（命中即降级为"待人工"）：仅匹配到关键词但无实际行为差异；目标返回的是错误页/通用 WAF 页；POC 回显出现在报错堆栈而非业务响应。
4. **带外漏洞**（SSRF/RCE 回连类）必须有 dnslog/回连记录佐证，禁止仅凭"请求发出去了"下结论。
5. finding_add 的 evidence 字段为空 = 违反本铁律，复盘时会被打回。
EOF

seed sec-blackboard <<'EOF'
---
name: sec-blackboard
description: 黑板纪律——跨会话共享事实的读写规范。任务开局读黑板，过程中即时写凭据/存活/已试路径，避免重复劳动和状态丢失。
---

# 黑板纪律

1. **开局必读**：任务开始先 blackboard_get 读全盘 + asset_query 看目标已有资产，不重复已完成的工作。
2. **即时写**（发现即写，不等任务结束）：
   - 凭据/会话：`cred:<host>:<role>` = 凭据引用（**只写 .env 变量名或"见凭据库"，绝不写明文密码**）
   - 存活状态：`alive:<host>` = 端口/标题/时间
   - 已试路径：`tried:<host>:<path>` = 结果（避免重复 fuzz）
   - 中间结论：`note:<target>:<topic>` = 一句话结论
3. **WAF/风控发现立即写**：`waf:<host>` = 厂商/行为特征，后续任务据此调整策略。
4. 黑板是事实不是推测：只写验证过的状态，推测写进会话讨论。
EOF

seed sec-review <<'EOF'
---
name: sec-review
description: 复盘沉淀——任务结束时把 trajectory 蒸馏为经验卡的结构与质量要求。review 角色/任务收尾时使用。
---

# 复盘沉淀

任务结束（或阶段性收尾）时，输出经验卡草稿，结构：

```json
{
  "scenario": "目标画像一句话（CMS/框架/防护）",
  "attempts": [{"tool": "工具+关键参数", "result": "ok|fail", "why": "成败原因", "run_id": "..."}],
  "chain": ["实际打通的调用链"],
  "takeaway": "下次同类目标最值得先做的事（一句话）",
  "evidence": ["run_id/flow_id 列表"]
}
```

质量要求：
1. takeaway 必须可操作（"先做什么/不做什么"），禁止"加强测试"式空话；
2. 失败尝试和成功同等重要——WAF 拦截、误报原因必须记录 why；
3. 无证据的经验卡不入库；
4. 同一 scenario 已有经验卡时，做补充修正而非另起炉灶。
EOF

seed sec-task <<'EOF'
---
name: sec-task
description: 任务与调度纪律——用户提到「定时/每隔/每天/每小时/定期/复扫节奏」时必须创建带 schedule 的 Task，不得只在会话里口头答应；任务一律绑定当前工作区对应的 Program。
---

# 任务与调度纪律

1. **「定时跑」= task_create 带 schedule**：用户意图含「定时/每隔 N/每天/每小时/定期复扫」时，必须调用
   `task_create(objective=..., schedule={kind:"interval",every_seconds:N})`（一次性用 `{kind:"once",at:<未来毫秒时间戳>}`）。
   创建后任务立即出现在看板「任务」视图，由调度循环自动执行。**禁止只在会话里口头答应而不建任务**。
2. **归属自动带出**：不传 program_id 时系统按当前会话所在工作区自动绑定；工作区未绑定 Program 时先 program_list 确认再显式传。
3. **intrusive 级目标禁止 interval**：需要人工确认的操作只做一次性任务或当场执行，不挂周期。
4. **改调度用 task_schedule，补跑用 task_run_now**，取消用 task_update(status=cancelled)。
5. 定时任务的执行由 spawn_worker 完成，执行会话自动归入对应工作区，结果写在任务 result 里（看板可跳链查看）。
EOF

log "Skill 种子完成"
