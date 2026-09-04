#!/usr/bin/env bash
# ==============================================================================
# SilkSecAgent 核心 Skill 种子（幂等：补缺失 + 内容漂移即刷新）
# DSH 用户级技能目录：$DSH_HOME/skills/<name>/SKILL.md
# ==============================================================================
set -euo pipefail

DATA_DIR="${DSH_HOME:-{{BASE_DIR}}/data}"
SKILLS_DIR="$DATA_DIR/skills"

log() { echo "[seed-skills] $*"; }

seed() {
    local name="$1"
    local tmp existed=1
    tmp="$(mktemp)"
    cat > "$tmp"
    if [ -f "$SKILLS_DIR/$name/SKILL.md" ]; then
        existed=0
        if cmp -s "$tmp" "$SKILLS_DIR/$name/SKILL.md"; then
            rm -f "$tmp"
            log "$name 已是最新，跳过"
            return
        fi
    fi
    mkdir -p "$SKILLS_DIR/$name"
    mv "$tmp" "$SKILLS_DIR/$name/SKILL.md"
    [ "$existed" -eq 0 ] && log "$name 已刷新" || log "$name 已写入"
}

seed sec-verification <<'EOF'
---
name: sec-verification
description: 验证铁律——任何漏洞结论必须有可回溯证据+对抗性自检，否则视为幻觉打回。所有漏洞判定/报告场景强制使用。
---

# 验证铁律

1. **任何漏洞结论必须附证据引用**：run_id（run_cli 产出）/ flow_id（流量归档）/ burp_item（人工验证）三选一，外加一句话证据摘要。无证据的结论不得写入 finding，不得向用户报告。
2. **判定前必看原始输出**：用 grep_result/page_result 核对 run_id 的原始响应，确认状态码、响应特征与结论一致。扫描器报"存在"不等于存在。
3. **误报典型特征**（命中即降级为"待人工"）：仅匹配到关键词但无实际行为差异；目标返回的是错误页/通用 WAF 页；POC 回显出现在报错堆栈而非业务响应。
4. **带外漏洞**（SSRF/RCE 回连类）必须有 dnslog/回连记录佐证，禁止仅凭"请求发出去了"下结论。
5. finding_add 的 evidence 字段为空 = 违反本铁律，复盘时会被打回。

# 对抗性自检（高危结论强制，中低危建议）

6. **自扮攻击者找反证**：结论写入前问"什么情况下这个结论是错的？"——列出 ≥2 个反证假设并逐一用证据排除。常见反证面：响应差异来自 WAF/CDN/负载均衡基线而非漏洞？重放 3 次是否稳定复现？对照组（未授权/无参/其他路径）请求是否有同样特征？时间类判定（时延注入）是否排除了网络抖动？反证无法排除 → 降级 tentative 或标记"待人工"。

# 多路独立复验（高危且条件允许时必做）

7. **高危 finding 派 spawn_worker 独立复验**：用全新上下文把同一假设交给另一个 worker 验证（不同上下文=天然多视角，等效多路高温投票）。两路结论一致 → confirmed；分歧 → 降级 tentative，分歧点写进 finding 的 evidence 备注。批量资产不适用（成本），只用于高危/将写报告/将提交 SRC 的结论。
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

1. **「定时跑」= task_create 带 interval schedule**：用户意图含「定时/每隔 N/每天/每小时/定期复扫」时，必须调用
   `task_create(objective=..., schedule={kind:"interval",every_seconds:N})`（每天=86400；一次性才用 `{kind:"once",at:<未来毫秒时间戳>}`）。
   创建后任务出现在看板「任务 → 定时任务」卡片区，由调度循环自动执行。**禁止只在会话里口头答应而不建任务**。
2. **周期任务是一行固定实体，严禁每天重建**：interval 任务跑完自动续期（latest-only），系统对同 program+同 objective 的周期任务幂等去重。
   **禁止**用「跑完再建明天的 once 任务」模拟每日周期——这会让任务表堆积垃圾行。每次运行历史自动落入执行历史（看板可见）。
3. **归属自动带出**：不传 program_id 时系统按当前会话所在工作区自动绑定；工作区未绑定 Program 时先 program_list 确认再显式传。
4. **intrusive 级目标禁止 interval**：需要人工确认的操作只做一次性任务或当场执行，不挂周期。
5. **改调度用 task_schedule，补跑用 task_run_now**，取消用 task_update(status=cancelled)。
6. **定时任务里 spawn_worker 派单纪律**：父 worker 的执行预算是硬上限（默认 3600s 到点 SIGKILL），
   阻塞等子 worker = 烧自己的预算。批量扫描必须「小批量短超时」：单批 ≤3 个目标、timeout ≤600s；
   禁止 ≥1500s 的大单阻塞。跑不完的资产记黑板台账（coverage-ledger）留次日，定时任务逐日增量推进，不追求单日全覆盖。
7. 定时任务的执行由 spawn_worker 完成，执行会话自动归入对应工作区，结果写在任务 result + 执行历史里（看板可跳链查看）。
EOF

log "Skill 种子完成"

seed sec-knowledge <<'EOF'
---
name: sec-knowledge
description: 记忆治理纪律——写记忆前三问、开局检索、用完回执、用到即复验、规则先验层加载。所有执行型角色开工/收尾时使用。
---

# 记忆治理纪律（memcore）

记忆分三层，写入前必须回答"三问"并把答案写进 justification（≥10字，非占位）：

1. **它会过期吗？** → 会：黑板/事实（ephemeral ≤30天 或 durable 需复验）；不会且换目标仍有用：才配进经验卡
2. **换目标还有用吗？** → 只对特定目标有用：进 facts/finding，**禁止进经验卡**；可迁移方法论：才进 exp_store
3. **谁会读它？** → 执行任务要读：ephemeral/durable；只有复盘要看：timeline（带日期快照键）

## 类别速查

| 内容 | 去处 | mem_class |
|---|---|---|
| 环境故障/工具异常 | 黑板 `[env-issue]` 前缀 key | ephemeral（TTL 自评 1-30 天） |
| 存活清单/扫描台账/调度流水 | 黑板带日期键 | timeline（只追加，不改写） |
| 目标事实（指纹/配置/负结果） | fact_upsert | durable（30天复验）或 note 类 ephemeral |
| 可迁移方法论 | exp_store | candidate 起步，附 justification |
| 成功调用链 | pb_save | permanent，附 justification |

## 规则先验层（data/rules/）

命中技术栈（指纹/fp_add）后、上专项扫描前：查 `data/rules/<域>/<栈>.md` 是否存在（如 web/spring.md、web/nextjs.md、web/selfhosted-supabase.md、php/thinkphp.md），存在则读入作为该栈审计先验（入口点模式/特有攻击面/验证要点）。

**SRC 评级规则（rules/src/）**：recon 评分打标前读 `src/asset-scoring.md`；漏洞定级、写报告、提交判断前读 `src/severity-rating.md`——定级不膨胀、不确定往低报。这层是**人工蒸馏的静态先验**，与 memcore 经验卡（实战后验）互补：先验给方向，后验给打法。复盘时发现某栈规则缺失或有新心得 → 在复盘报告里提议新增/修订规则文件（人工评审后落盘，agent 不自写规则层）。

## 流程纪律

- **开局**：exp_search 按目标画像检索 → 命中 high 置信卡先读后干；blackboard_get 查 `[env-issue]` 前缀键（现行有效才参考）
- **用完卡**：必须 exp_feedback 回执（useful/adopted/wrong/outdated）——不回执的卡会被判零使用而沉没
- **cooling 标记**：检索结果带 _cooling 的事实用到即复验（exp_validate 或 fact_upsert 刷新），复验通过自动复活
- **沉淀前查重**：exp_search 同场景 → 命中则补证据/改 takeaway（exp_update），不另起炉灶
- **红线**：故障/状态/日期清单禁止写进 persona/objective；timeline 键禁止改写（换新键）
EOF

# ---------- 规则先验层（data/rules/，人工蒸馏静态规则，详见 sec-knowledge 技能） ----------
seed_rule() {
    local rel="$1"
    local tmp
    tmp="$(mktemp)"
    cat > "$tmp"
    if [ -f "$DATA_DIR/rules/$rel" ] && cmp -s "$tmp" "$DATA_DIR/rules/$rel"; then
        rm -f "$tmp"; log "rules/$rel 已是最新，跳过"; return
    fi
    mkdir -p "$DATA_DIR/rules/$(dirname "$rel")"
    mv "$tmp" "$DATA_DIR/rules/$rel"
    log "rules/$rel 已写入/刷新"
}

# ---- P13/P14 纪律技能（版本受控源 data-seed/skills/，本 heredoc 为部署通道）----
seed sec-runtime-discipline <<'SECSKILL_RT_EOF'
---
name: sec-runtime-discipline
description: 运行环境公共纪律——代理出口/授权边界/派单/interval 任务/失败留痕/大输出摘要/日期标签。所有定时任务与执行会话默认遵守（单一事实源，任务 objective 不再内联重复）。
---

# 运行环境公共纪律

1. **出口**：一切出网走代理池网关 http://127.0.0.1:8899（scope.yml defaults.egress_proxy）。run_cli 已模板化代理；手工 curl 必须显式 http_proxy=https_proxy=http://127.0.0.1:8899；开局 proxy_pool_stats 确认 active，失效代理用 proxy_pool_report_bad 上报；禁止任何直连出网。
2. **授权**：scope.yml 是唯一权威（开工必读当前清单，严禁依赖提示词内联的历史清单/数量）；scope-guard fail-closed，边界外工具层直接拒绝，严禁绕过；max_risk=active，intrusive 一律一次性人工确认，禁挂周期。资产收集发现疑似 scope 外但归属证据明确的新资产（CNAME 指向授权资产/品牌印证/收购关系）→ 必须 `approval_request kind=scope-domain` 提请人工审批（subject=域名、program_name=归属项目、evidence≥10 字证据、equity_basis/independent_src/corroboration 按表单填写——判据口径见 rules/src/equity-gate.md 股权闸：默认不入池=参股/战略/财务投资/合资非100%/联营，independent_src=有→不并入本项目）；批准前目标依旧全拒绝，不要尝试打点；禁止只写事实不提请求，也禁止把归属不确定的资产凑数提请。scope-domain 批准后系统自动入队首轮资产收集种子任务（objective 带 `[审批入队]` 前缀，只做资产收集禁漏洞探测），无需手工派单。项目排除清单内的域名若掌握新归属证据 → `approval_request kind=exclude-exception` 提请排除例外评估（批准=移出排除+并入 scope+留 durable fact 记录判据）。
3. **派单**：spawn_worker 批量必须小批量短超时——单批 ≤3 目标、timeout ≤600s；禁止 ≥1500s 大单阻塞（父 worker 预算 3600s 硬上限，阻塞等子=烧自己预算）；跑不完记台账留次日，逐日增量推进。
4. **interval 任务**：一行固定实体，跑完自动续排（latest-only）；严禁 task_create 次日 once 模拟周期。
5. **失败留痕**：失败/被杀 run 先读 results/<run_id>/meta.json（exit_code/duration）再处置——数据多已落盘，可幂等重跑；onnxruntime 的 pthread_setaffinity 报错为良性噪声，不是失败信号。
6. **大输出**：一律 grep_result/page_result 摘要取，禁止在会话铺全文；nuclei 等大输出默认取命中行。
7. **日期标签**：日报/黑板键/台账文件名统一 YYYY-MM-DD；定时任务收尾 task_update 的 **note 必须以【{项目}·{角色}·MMdd】开头**（如【美团·vuln·0828】），保证看板执行历史左侧标题一眼可分辨哪天哪个任务。
8. **黑板**：环境故障查 [env-issue] 前缀键（现行有效才参考）；存活清单/台账不内联进 objective，以黑板/facts 实时记录为准。
9. **事实生命周期**：note 类=agent 工作速记（ephemeral，14 天滚动消亡）——失败记录/当日结论/临时观察写 note；**长期知识必须写 target/asset/finding 等分类**（durable，30 天复验，被引用即续期）；带明确时效的事实用 intent.ttl_days 显式声明。禁止把需要长期保留的知识写进 note（14 天后会被 sweeper 归档）。

SECSKILL_RT_EOF

seed sec-pipeline <<'SECSKILL_PP_EOF'
---
name: sec-pipeline
description: 挖掘流水线纪律——覆盖矩阵六态台账、漏洞卡驱动探测、防幻觉输出契约、探索配额、交接包规范。recon/vuln 等执行型任务全程强制使用（与 sec-verification 互补：那边管判定，这边管覆盖与留痕）。
---

# 挖掘流水线纪律（v2.1）

> 设计文档：`doc/secagent/README.md`（SilkSpool 仓库）。本技能是其执行层摘要。

## 1. 覆盖六态（每个 资产×卡片 组合有且仅有一个终态）

`PENDING` 未测 / `TESTED_CLEAN` 已测无命中 / `CONFIRMED` 已确认 / `FALSE_POSITIVE` 证伪 / `NOT_APPLICABLE` 无攻击面 / `BLOCKED` 条件不足 / `STALE` 结论过期。

- 每次探测动作落一行台账 `data/pipeline/{program}/attempts.tsv`：
  `ts  asset  card_id  card_ver  tool  result  na_reason/blocker  evidence_path  run_id`
- **NOT_APPLICABLE 必须填 na_reason**（no-param-surface/no-auth-feature/static-site/tech-mismatch/…），**BLOCKED 必须填 blocker**（no-credential/egress-unreachable/risk-exceeded/needs-reverse/…）。词表外新值允许，当日报告登记定义；禁止 other/misc。
- 完成一个目标立即写一行，禁止攒批。

## 2. 漏洞卡驱动（data/vulncards/）

- **开局先扫技术索引**：`rules/src/technique-index.md`（打穿短表）「认什么」列对现场特征——命中即按「打哪」出枪，「出什么算成」=判成标准、「假点」=证伪条件。索引≠清单：表上没有的手法照样挖；注入/SSRF/XSS/RCE 有差分面必须真打。
- 探测前读对应卡片：按 `applicable_when` 判适用、按 `detect.steps` 探测、按 `verify.must_pass + falsification` 确认。
- 每用一张卡落一条 `card_usage-{date}.jsonl`：`{card_id,card_version,asset,result,deviation,suggest}`。**实战与卡片有偏差必须记 deviation**——那是卡片升版的原料。
- 现有卡不覆盖的漏洞类：注册新卡（draft，骨架见 registry.md），即创即用，当日报告登记。

## 3. 防幻觉输出契约（硬标准）

1. **分母明确**：覆盖率数字必须给分母（文件+行数）；无分母的百分比视为幻觉。
2. **TESTED_CLEAN 也要证据**：命令/时间/响应特征摘要落盘，与 CONFIRMED 同级举证。
3. detect/verify 分离；CONFIRMED 必须过 verify 规程 + ≥2 次复现（换出口）。
4. 结论区禁止词：可能存在/疑似/应该是/理论上/大概率——推测只能进 IdeaCard（data/vulncards/ideas/）或 huntlist，且必须写 verification_requires。
5. **负例即价值**：0 产出日的报告同等重要；禁止为凑产出报噪音。
6. 报告统计数字以台账实际为准（coverage-report.py 生成），禁手填。
7. CONFIRMED 建证据包 `data/evidence/{finding_id}/`：request.txt/response.txt（含时间戳+出口IP）/reproduce.md（含影响场景具体化）/falsification.md/verify-log.md。
8. **finding_add 五要素齐才登记**：规范标题（`<组件/业务语境> <漏洞类型与后果>（关键特征）`，如 "Oceanus 404 调试页泄露内网节点 IP+appkey"，禁止工具原始输出当标题）+ 证据 + 复现步骤 + 影响 + 修复建议。完整性闸门（v4.2）：缺复现步骤/影响的登记自动归入"待验证候选"（noise=1，漏洞列表不可见）——这是登记未完成的信号，补全后重新 finding_add 即可升级，不是流程终点。

## 4. 每日任务结构 = 规定动作 + 自选动作

- **规定动作（必须完成）**：按 brief 执行——覆盖台账 PENDING/STALE 消化、复验到期项、huntlist 前置条件判定、全部留痕。
- **自选动作（必须产出，方向自由）**：≥20% 时间或 ≥3 条 IdeaCard。发散角度：组合/类比/倒置/协议下沉/数据追问/时间维度/生态侧写/白盒镜像。探索产出只进 IdeaCard/huntlist，**不许直接进 findings**（灵感与漏洞之间隔着验证规程）。
- IdeaCard 放 `data/vulncards/ideas/IC-xxx.yaml`，必须写 `verification_requires` 和 `first_testable_when`；开局检查条件是否已满足。

## 5. 工具矩阵（按指纹/形态分派，禁止只跑 nuclei）

- 有参数 → dalfox(XSS)/sqlmap --level 1 --risk 1(SQLi)/arjun(隐藏参数)
- CNAME 外部指向 → takeover 检测；指纹命中组件 → 对应 CVE 模板 + afrog
- 有 GraphQL → graphql-cop；登录框 → VC-015 登录接口安全（无需账号）
- nuclei 产出 info 级默认隔离：finding 候选只看 severity≥low；info 命中记台账不落 finding。

### 流水线工具（sec-pipeline 插件，原生工具优先于脚本）

**agent 一律调用 DSH 工具**（审计/run_id 归因/写入即校验），不再用 bash 直接调脚本：

| 工具 | 用途 |
|---|---|
| `attempts_log` | 六态台账追加（写入即校验，违规拒绝）——每个探测动作后立即调用 |
| `card_usage_log` | 卡片使用记录（deviation 必填） |
| `radar_read` | 变化雷达队列读取（recon 开局，drain） |
| `pipeline_validate` | 产物格式机器校验（收尾强制） |
| `coverage_report` | 覆盖矩阵视图（报告数字唯一来源） |
| `verify_replay` | CONFIRMED 机械复核（重放+hash+verify-log） |
| `surface_queue` | 参数 URL 队列（喂 dalfox/sqlmap） |
| `surface_scan` | 敏感信息回扫（VC-027，打码） |

系统层（非 agent 调用）：`l2-collect` 已注册为 run_cli 工具（recon 收集接口层用 `run_cli tool=l2-collect program=<prog> target=<host>`）；ct-watch/js-watch 为 systemd 守护，产出 radar-queue.jsonl。

注意：xray flows/*.jsonl 只有扫描统计计数、无请求内容（已核实）——参数面以 l2-collect 产出为准，勿再依赖 flows 文件。

## 6. 合规止损（机器强制，不靠自觉）

够证即停：证明存在即停止，不拖数据、不横向、不扩大；证据中真实用户数据脱敏落盘；绝不用拖库凭据、绝不登真实用户账号、只用自建测试数据；intrusive 一律人工；命中蜜罐特征即退。

## 7. 收尾强制清单（未完成 = 任务失败）

1. 本批所有目标 attempts.tsv 有终态行；2. CONFIRMED 有证据包；3. N/A、BLOCKED 有理由值；4. 当日 idea 已入库；5. handoff 生成且汇总数与台账一致。

## 8. 交接包（每日收尾，`data/pipeline/{program}/handoff-{date}.md`，模板见 data/templates/）

五段固定：状态快照 / 今日动作摘要 / 明日队列（huntlist 带 precondition+ttl）/ 阻塞与求助（按解锁收益排序）/ 数据指针（全部绝对路径）。

## 9. 流程守卫（P15，机器强制——纪律不再依赖自觉）

`task_update status=done` 时引擎硬校验三个纪律产物，缺一即拦截并返回缺失清单，补齐后重试：

1. `attempts-{program}.tsv` 近 24h 有增量行（六态皆可，含 N/A 与 BLOCKED——零探测日也要给存量目标落终态行）；
2. `card_usage-*.jsonl` 近 24h 有记录（当日未用卡则对规程复盘落一条 deviation）；
3. `handoff-{date}.md` 存在（北京日期）。

被拦截 ≠ 失败：按缺失清单用 `attempts_log` / `card_usage_log` 补产物，再 task_update。守卫拦截本身会被记录（ops 视图可见），长期零拦截+零台账才是异常。

## 10. 资产准入与每日 Slice（P15）

- **准入**：主动扫描（risk≥active 的 run_cli）只打已分级资产——`asset_query level_in=S,A,B` 取队列；未分级资产先 `grade_assets` 分级或 `vision_triage` 截图分诊（喂 dsh-browser/httpx 截图，返回 page_type/has_login/interesting）。
- **Slice 化**：每日任务的硬指标是消化覆盖矩阵的一个切片（如 top-10 BLOCKED/PENDING 格子 + radar 事件全清），**不是**"覆盖全部资产"——完成切片即达标，剩余预算进研究模式（产 IdeaCard）。跑不完登记次日队列，禁止为凑覆盖率跑低价值全量。
- **蒸馏中置**：每完成一个目标的验证链立即评估 exp_store/pb_save（三问：会过期吗/换目标有用吗/谁会读），不要攒到收尾——预算耗尽时收尾蒸馏永远轮不到。
- 报告只列信号：info 级模板指纹已被引擎闸门隔离（noise=1），`finding_query` 默认看不到，无需再自行过滤。

SECSKILL_PP_EOF

seed_rule php/thinkphp.md <<'EOF'
# ThinkPHP 审计先验

## 入口点模式
- 兼容模式路由：index.php?s=/module/controller/action（5.x 历史 RCE 面）
- 多应用模式（6.x）：app 目录遍历 + 路由注释

## 特有攻击面
- 5.0.x/5.1.x 远程代码执行（method/__construct 过滤器链，payload 已模板化进 nuclei/afrog）
- 6.x 反序列化链（League/Flysystem 链为主）
- debug 模式：trace 页泄露（绝对路径/SQL/配置）、app_debug=true 指纹
- 数据库日志文件直连下载（runtime/log/）

## 验证要点
- 指纹先用 nuclei shiro-detect 类模板确认框架与版本段，再选 payload 代际（5.0 与 5.1 payload 不通用）
- 报错页含 "ThinkPHP V5.x" 字样=版本指纹直接可读
EOF

seed_rule web/nextjs.md <<'EOF'
# Next.js / Node 全栈审计先验

## 入口点模式
- pages/api/* 或 app/api/*/route.ts（App Router）：默认无鉴权，鉴权全靠手工
- Server Actions（"use server"）：公开可 POST，$ACTION_ID 枚举可得——参数校验全靠自觉，是越权/注入高发面
- middleware.ts：只做"边缘"拦截，可被 x-middleware-subrequest 头绕过（CVE-2025-29927，多个版本）

## 特有攻击面
- /_next/data/<buildId>/<path>.json 直接拉 SSR props（可能含服务端数据泄露）
- next/image 的 url 参数 SSRF（未配 remotePatterns 白名单时）
- 环境变量：NEXT_PUBLIC_ 前缀进客户端 bundle（可 grep JS），但"服务端变量写进 NEXT_PUBLIC_"是常见翻车
- 静态分析 JS bundle 拿内部 API 端点/网关命名（我方卡 #3 已验证此法有效）
- JWT/session：iron-session/next-auth 默认配置弱点（弱 secret、算法混淆）

## 验证要点
- Server Action 响应 200 且含表单数据回显 ≠ 漏洞，必须验证副作用（数据变更/越权读取）
- middleware 绕过判定：对比带/不带 x-middleware-subrequest 头的响应差异
EOF

seed_rule web/selfhosted-supabase.md <<'EOF'
# 自托管 Supabase 审计先验（源自实战卡 #3，已验证有效）

## 识别与确认
- 五端点差分：/rest/v1/ /auth/v1/ /storage/v1/ /graphql/v1 /realtime/v1 全返 401/400 = 真实实例（非反代巧合）
- 前端 JS 内嵌 SUPABASE_URL + anon JWT（chatId/deployId 等参数联动可确认归属）

## 特有攻击面
- anon key 不是密码：RLS 未开启的表 anon 直读直写（PostgREST 默认允许）——逐表枚举 /rest/v1/<table>
- service_role key 泄露 = 全库上帝权限（搜 bundle 里的 service_role/sb_secret）
- JWT secret 每实例独立：别拿别处的 anon key 套（跨实例不通用）
- /auth/v1/signup 开放注册 → 拿合法用户 token 再测登录态接口
- Storage 桶匿名读写：/storage/v1/object/public/<bucket>/

## 验证要点
- 401 是"实例存活"证据不是漏洞；RLS 判定必须实际读到行数据
- 宿主平台（低代码/nocode 平台）与 Supabase 实例是两层：平台 key 映射实例需逐对确认
EOF

seed_rule web/spring.md <<'EOF'
# Spring / Spring Boot 审计先验（语言框架规则·末段漏洞判定另见具体漏洞卡）

## 入口点模式
- 控制器注解族：@RequestMapping/@GetMapping/@PostMapping + 类级路径前缀拼接；@RestControllerAdvice 不改路由
- 隐式入口：/actuator/*（env/heapdump/refresh/gateway/routes 是重灾区）、/error 页、Spring Cloud Gateway 路由表
- 路径匹配差异：antMatchers 与 mvcMatchers 对尾斜杠/分号路径/大小写处理不同——鉴权配置用 antMatchers 而控制器容忍变体 = 绕过高发点

## 特有攻击面
- SpEL 注入：@Value/@PreAuthorize 拼接用户输入、Spring4Shell（CVE-2022-22965，JDK9+ + WAR 部署 + 特定绑定）
- Jackson/Fastjson 反序列化：@RequestBody 多态类型（@type/enableDefaultTyping）
- Actuator：heapdump 直下（内存里常有密钥/会话）、env 脱敏绕过（/actuator/env 老版本）、gateway POST /actuator/gateway/routes 加恶意路由 = RCE
- JSP/Thymeleaf SSTI：模板名拼接用户输入
- 鉴权顺序：Filter 链 vs Interceptor vs @PreAuthorize 的执行顺序错位；permitAll 通配过宽

## 验证要点
- 403 是 WAF 还是 Spring Security？看响应头/错误体指纹，别误判
- actuator 存在 ≠ 可用：逐个端点试，看 management.endpoints.web.exposure.include 配置痕迹
EOF

seed_rule src/asset-scoring.md <<'EOF'
# SRC 资产可挖掘性评级（SABC 打分表）——源自 CyberStrikeAI 实战规则（资产测绘Agent）

> 用途：recon 测绘后给资产打"可挖掘性"分，vuln 任务按 level S→A→B、score 降序取队列。
> 原则：评分只排优先级，不构成授权——授权边界永远是 scope.yml；accept 政策名单只管"SRC 收不收"。

## 打分表（满分 100）

| 维度 | 权重 | 子项 |
|---|---|---|
| A 漏洞价值 | 40 | 数据敏感度 0-15 / 业务核心度 0-15 / 影响可放大性 0-10 |
| B 出洞概率 | 45 | 可交互 0-12 / 功能攻击面 0-12 / 组件脆弱性 0-12 / 历史冷门度 0-9 |
| C 时效加成 | 15 | 新鲜度 0-8 / 活动加成 0-7 |

## 分层

- **S ≥ 75**：优先挖穿（核心业务 + 高可交互 + 有攻击面）
- **A 60-74**：深挖队列主力
- **B 40-59**：常规覆盖
- **C < 40**：仅登记，不主动深挖

## 配套打标（与评分独立但联动）

- **owner 归属**：confirmed（ICP 备案/证书 Organization/whois 强证据）/ suspect（仅 favicon/同 C 段弱证据→挂起不交下游）/ 第三方 SaaS/CDN → 排除。投资公司/已剥离业务/合作方存疑一律 suspect
- **accept 收录政策**（查 facts category=policy 的 accept-list）：full（默认）/ intrusion-only（只报入侵类：通生产 SSRF/可逃逸 RCE/主站后台 getshell/进内网入口/可证核心 SQLi）/ none（暂停收录，可算分但不驱动挖掘）；拿不准从严 none 并注明待确认
- **biz 业务分级**：核心（交易/资金/核心 PII）/ 一般 / 未知
- **state 增量**：new / changed / stable / dead（与上轮对比）

## 深挖队列规则

`owner=confirmed 且 level∈{S,A,B} 且 accept≠none`，按 score 降序逐资产挖穿再走下一个；
accept:intrusion-only 照常挖但仅入侵类才 finding_add，非入侵类留 intel 不提交。
EOF

seed_rule src/severity-rating.md <<'EOF'
# SRC 对齐漏洞定级（压级约束）——源自 CyberStrikeAI 实战规则（深入挖掘Agent）

> 铁律：**定级不膨胀、不确定往低报、判忽略的不进提交队列**。
> 与 SRC 平台（美团/字节）审核口径看齐，让真正的高/中危能被认真对待。

## 定级表

| 级别 | 范围 |
|---|---|
| 严重/高危 | RCE、可证 SQLi、核心越权（资金/大量 PII）、账户接管、支付绕过、进内网 SSRF、主站 getshell |
| 中危 | 一般越权、存储 XSS、有影响的逻辑缺陷、需条件 SSRF、受限上传 |
| 低危 | 反射 XSS（需交互）、不含敏感数据的信息泄露、低影响 CSRF、CORS、点击劫持 |
| 忽略 | 纯版本 banner、无敏感 swagger、Self-XSS、无 PoC 理论、目录列表、扫描误报——不进提交但留副产物（fact/intel 记录） |

## 特别约束

- **信息泄露默认低危甚至忽略**；仅泄露凭证/大量 PII/源码/内部核心配置才上探
- 拿不准级别的往低报；证据不足 downgrade 到 tentative
- accept:intrusion-only 资产：仅入侵类（通生产 SSRF/可逃逸 RCE/主站 getshell/进内网入口/可证核心 SQLi）才 finding_add，其余留 intel

## 报告模板（CVSS4.0 一洞一报）

标题 / 危害（讲业务影响，不堆技术词）/ CVSS4.0 向量与评分 / 复现步骤 / 打码证据 / 影响范围 / 修复建议 / **是否值得提交**（结论 + 理由）
EOF

seed_rule src/equity-gate.md <<'EQUITY_GATE_EOF'
# 股权范围闸（scope 候选归属判据）——源自 srcskill dig-scope §3.2.0 实战口径

> 用途：挖到疑似目标集团的新域名，提请 `approval_request`（kind=scope-domain / exclude-exception）前先过本表。
> 铁律：**说不清归属链的不提请**——写成 fact 观察记录即可，占着审批队列没意义。

## 判据口径（equity_basis 字段取值 ↔ 归属链要求）

| equity_basis | 什么算归本集团 | 判据要求 |
|---|---|---|
| 控股/全资 | 集团自身，或 100% 控股的子/孙/曾孙/玄孙公司主体（尽量核 4 级） | 工商/财报/官网公示的股权链可查证 |
| 收购/财团 | 私有化财团由本集团牵头（领投）；或收购公告的主导方是本集团 | 公开新闻/公告有据，牵头≠参股 |
| 品牌/产品线 | SRC 范围页明确列入的品牌；集团官网官方跳转域；在用子品牌主域 | 范围页原文/官网跳转链可截图佐证 |
| 技术印证 | CNAME 指向本项目已授权资产；授权域下的内部部署域 | DNS 解析记录 + 归属旁证（证书/指纹）双证 |
| 其他 | 无强证据 | **默认不提请**；写成 fact 观察等更强证据 |

## 默认不入池（即使名字像、ICP 备案像）

参股（少数股权）、战略/财务投资、合资（非 100%）、联营、投资组合公司自有域。
**看入股权比例和主导权，不看品牌名相似度。** 投资关系≠安全责任归属。

## independent_src 独立 SRC 判定

| 取值 | 含义 | 动作 |
|---|---|---|
| 无 | 该公司无独立 SRC / 无独立安全收口 | 可并入本项目 |
| 有 | 有自己独立的 SRC 平台在收漏洞 | **不并入本项目**，即使股权上算——漏洞应交其自有 SRC |
| 不确定 | 查不到/存疑 | 标注存疑等人工确认，别抢跑提请 |

## 提请质量要求

- evidence ≥10 字，写清**归属链**（谁持股谁/谁收购谁/范围页原文），不是"看起来像"
- corroboration 填旁证（官网跳转/证书/公告链接/技术印证记录）
- 判例见下表；同判据新域名可类比，但范围页原文类证据必须重新取

## 判例表（人工蒸馏，随审批决策更新）

| 域名 | equity_basis | independent_src | 判定 | 依据 |
|---|---|---|---|---|
| catpaw.com | 品牌/产品线 | 无 | 批准并入 | 龙猫（catpaw）为美团外卖吉祥物产品线品牌 |
| tabbit.com | 品牌/产品线 | 无 | 批准并入 | 兔子（tabbit）为美团在用子品牌主域 |
| wow.fun | 品牌/产品线 | 无 | 批准并入 | 品牌产品线域，官方在用 |
| zhaopin.com | 收购/财团 | 不确定 | 搁置（H-004 教训） | 2021 私有化财团由红杉中国与美团牵头，但智联招聘或有自身 SRC 归属——independent_src 未确认前不并入 |

EQUITY_GATE_EOF

seed_rule src/technique-index.md <<'TECHNIQUE_INDEX_EOF'
# 打穿短表（技术索引）——源自 srcskill 知识库 87 行实战复盘表

> **本表 ≠ 本站清单。** 进站开局先扫「认什么」列，对得上现场特征再按「打哪」出枪；「出什么算成」= 判成标准（对应 finding 证据要求），「假点」= 证伪条件（对应 VC 卡 falsification/假点列）。
> 表上没有的手法照样挖（保底+自由打）；注入 / SSRF / XSS / RCE 有差分面必须真打、不得连日空窗——**不是**只测这四类，也不是每个 path 喷 `'`。
> 与 VC 卡关系：本表给「认现场特征」，VC 卡给「规程化探测步骤」；命中本表特征但无对应 VC 卡时，按流水线纪律手工出枪并考虑 IC 提案固化。打完开场几枪回流水线：JS 抽钥匙、回包 id 进清单、attempts_log 落台账。
> 手法族对应 findings.vuln_type 词汇表（越权/IDOR、认证绕过、凭证泄露、文件/存储链、SSRF、注入、XSS/RCE、穿越/LFI、业务逻辑、缓存投毒、Host头、原型污染、Agent执行、云IDE/RCE、CSRF/会话）。

| 手法族 | 认什么 | 打哪 | 出什么算成 | 假点 |
|---|---|---|---|---|
| CSRF/会话 | 二维码登录；回包有 token；登录页吃 `?token=` | 不登录拿 token；**要会话**的人打开带 token 的登录 URL（等于确认扫码）。 | 未登录端变成对方号 | token 过期；点开只出码不绑会话；必须真机扫、URL 确认无效 |
| 认证绕过 | 未登录首页/运营配置 JSON 的跳转 URL（skipPath / jumpUrl / schema）query 里带着能当会话用的 token | 不登录抄出来当 Token / Authorization 头打 me/info。对照：不带这串应登录过期。 | me 是别人的手机/角色，会话能当这个号用 | token 过期或只是占位串登不进去；配置只出运营文案没有票 |
| 文件/存储链 | 对象存储先申 STS；key 是文件 md5；或 assumerole 的 `filename`/`Action` 进 Policy | 凭证字段填 `*`/`空`/`/`，Policy 里 filename/Action 通配。**List/Delete 403 别停**，换匿名票再打。落地页写死匿名 JWT 改打存储 REST。 | 对方文档/图变成你传的；或能列出并删别人的 key；或拉到**他人**问卷/证件自拍 | `*` 只到废桶；覆盖 403；只盖自己的；策略服务端写死；CDN 不刷新看起来没盖；只能下自己刚传的；猜不到别人 key；rest 表 403 就当存储 REST 也不能写 |
| 文件/存储链 | 业务网关把对象存储代理成 `/api/storage/sign`（或同类 sign），query 吃 `key`；`key=/` 或 `key=.` 回 ListBucket XML | 不登录 GET `?key=/` 列表，再 GET 列表里业务前缀。 | 列出并读到他人未公开对象原文 | 只有 app-static 公开静态；`filename=` 400 当没口 |
| 文件/存储链 | 站点图/指南挂在对象存储桶上；`?policy` 或等价策略接口全 Allow | 无密钥 LIST，再 PUT 盖官方对象。 | 官方指南/协议/站上图变成你传的 | 只能列不能写；只能盖自己前缀；只能下本来就公开的静态文件 |
| 文件/存储链 | 对象存储带签 URL；SignedHeaders 一类没有 `host` | 域名换成同账号另一个桶，加 `?uploads` 做分片列举。 | 列出或读到**别的桶**里的对象 | 签名罩住 Host；换域 403；只有自己这个桶 |
| 文件/存储链 | 对象内容你能控，对象 Content-Type 被卡死；有临时钥或预签名 | 再签一枪，签进 `response-content-type=text/html`。 | 用签过的 URL 打开，浏览器当 HTML 跑（存储 XSS） | 签名拒这个参；下载仍是附件/原 CT；只能改自己不可达的对象 |
| 业务逻辑 | 商家后台能建促销/券再绑 SKU；绑接口里有 `productId` | 自己的券 ID 不动，把 `productId` 改成别人的货。 | C 端打开别人那件货，实付价按你这张券掉下来 | 绑定 200 但 C 端价不变；只能绑自己店的货；结账页改 `productId` 换便宜货（那是另一条） |
| XSS/RCE | 企业 Git + 桌面客户端；README/议题能写 HTML | 当存储 XSS 打进客户端；有桥再升 RCE。 | 客户端里执行了本机命令 | 只在浏览器弹；客户端不渲或沙箱死了（停在存储 XSS，别写成 RCE） |
| XSS/RCE | Electron / CEF 客户端注册了自定义协议；协议参数有 `url` / `urlType` / `open` / `openUrl` / `webview` | 协议里填自己的页（JSON `params` 或扁平 `openUrl?url=`）；页上先探 `process` / `require` / `window.require`，有就 `exec`，不要只认 Electron 10 的 `remote`。 | 本机弹出计算器 / 跑了指定无害命令 | 协议只开自家域；`require` 和 `remote` 都没有、预加载只露 `ipcRenderer` 却调不了命令；只弹「打开应用」但不加载外站；沙箱死了只在页面 alert |
| 越权/IDOR | 改/查详情的 id 是一长串密文；JS 有 `modulus`/`exponent` 或 JSEncrypt / `security.js`。或落地页写死公钥 + 演示 `userid`，列表 query 吃加密串 | 回包里找明文序号；用公钥自己加密相邻数字再换进去。演示号则加密页面写死的 `userid` 不登录打工单列表，再换邻号/对照 `userid=0`。 | 出别人的地址/手机/姓名；或列表出现他人工单/跟帖正文 | 会话绑死只回自己的；钥匙是验签用的、乱加密服务端拒；加密后仍是公开 FAQ |
| 越权/IDOR | 列表按 `appId`/`tenantId` 过滤；附件是带 `sign` 的下载 URL | 租户字段试 `0`/`-1`/空；附件 URL 只把租户改成自己的。 | 列表出现他租户工单/资质，附件真下到证照 | `0` 仍只回自己的；换租户下载 403；只有文件没有业务列表 |
| 越权/IDOR | 小程序云 / 云函数有 Docker Registry、`/v2/` | 自己号 login 后打开 `_catalog`，再 pull 对得上别人租户的镜像。 | 拉下来的镜像是别人租户的 | catalog 只回自己的；pull 403；只能拉公开库 |
| SSRF | 云开发网关；`*proxy*` 有 `targetUrl`/`url`；或云 SSRF 已打到元数据目录；开放代理**固定 POST**（直打 IMDS 405） | 不登录（匿名 token 也算不登录）。回环对照后再打元数据；405 转 GET、钥匙路径。ListBuckets 403 别停，再签日志类只读 API | 回显元数据，或临时钥匙能调云 API 问出主账号；或列出日志采集配置/主题 | 代理白名单且元数据也 403；匿名开了但代理对匿名关死；窄角色没证明能调云 API 却写成接管全账号 |
| SSRF | 公开 GOPROXY（`/go/`、模块 `/@v/list`）会按模块路径做 `?go-get=1` 再跟 VCS | 不登录。模块路径写成自己的域，`go-import` 用 **hg**（git 超时别停）。 | hg 报错/回显出元数据或临时钥匙，再问出云账号 | 不是 GOPROXY / 不会 go-get；元数据域名也被拦；hg 也不跟且出不了钥；钥调不通 |
| 认证绕过 | 未登录发签口给 IM/RTC/体验 userSig；identifier 跟请求走或票里没 userId；或同一后台其它口请登录、发签口只要自定义头+客户端 userId | 不登录拿签登 IM 拉他人会话/群。v2 403 改 v3。Demo 抄 JS 发签口+空密。 | 拉到**他人**会话/群成员/好友，或明文手机 | 只能登游客 `null`、空会话、只有自己建的空群；换别人 UserID 失败；`none_auth` 只新开空号；演示号没绑手机不算；前端 SECRETKEY 已空且发签口要验证码 |
| 认证绕过 | H5/落地页写死产品号或业务 id；发签口不登录给共享产品号 JWT（不是游客空号） | 不登录 POST 发签，带着票打 JS 没写出来的 list（只有 create/GET by id 也打）。 | list total 海量且带他人原图/证件照 | 票只能建空任务；list total=0 或只有自己刚传的 |
| 认证绕过 | 企业 IM / 业务 unlogin 发签口；回包 `nonceStr`/`nonce` 以 `MIIE` 或 `-----BEGIN` 开头 | 不登录。渠道/活码未登录漏 `corpId` 再打发签。把 nonce 当 PKCS8 私钥 load，不要当短随机串丢掉。 | 能 load 成 RSA 私钥 | nonce 只是短随机串；假 corpId 一直业务错 |
| 越权/IDOR | 招募/指定用户详情带 `specifyUsers` 或 openid；H5 写死 SHA256 请求签名；或邀请页地址已有 `?openid=` | 不登录抄 openid 打信箱/邀请码。 | 换 openid 信箱或邀请码/名单变，出现对方积分过期通知或打码手机昵称 | 列表人人一样只是全站广播；接口要真登录/签名；假 openid 没有邀请码；公开运营名单 |
| 文件/存储链 | 云录制分享；鉴权接口有下载/试看开关；或会议 JSON 网关根本没有 permission/auth | 不登录打 download **和** sign 两口；没有鉴权口别停，直接打多路下载；纪要/章节摘要口只填 record_id。**POST JSON 报录制 id 不能为空别停，改 GET query**。对象存储无 Referer 403 别停。国际网关分享 id 一起带。 | 鉴权写 false 仍拉到真媒体（容器头+体积）；或只要 record_id 出纪要全文/各章正文 | 鉴权真拦了、下不到文件；只有公开说明书；纪要只要标题没有正文 |
| 文件/存储链 | 分享详情 JSON 一边 `need_pwd`/`auth_level` 表示要提取码，一边 auth 对象把明文提取码放进 `pass_word`（或同类）。或落地 HTML / `syncData` 内联明文码 | 不登录抄码再打下文件。落地 HTML/`syncData` 里的明文 `pass_word` 也抄，不必先打 View CGI。 | 拿到提取码并下到密码分享正文，不是空密直接出文件列表 | `pass_word` 是哈希抄了登不进；空密 View 已经出文件（那是无提取码分享，不是这枪） |
| SSRF | 分享图 `generate`；replacements 有 `%MARKDOWN%` | 不登录 POST，markdown 写成 `![x](url)`。先对照公网图，再打 metadata。 | 生成图里嵌进你指定的图；或内网/元数据在图上出 500/正文 | 只出模板空图；markdown 当纯文本；必须登录 |
| 认证绕过 | 企业客服 H5 签发链；内联有拉小程序链 / 开放链一类 | 不登录 POST 回调参=外站。打开返回的落地链。 | 落地页正式名是官方客服号，解码出的 query 是你填的网址 | 只签发本站路径；落地页不带 query；必须登录 |
| 认证绕过 | 服务端代调身份供应商（小程序码/跳转码 / OAuth 换票 / 未登录业务口直接下发 `access_token`）；非法 pagepath 或 `redirect_uri` 外域时 message/报错 URL 拼进 `access_token=` 或 `client_secret=`；或 GET 领票口直接 200 出票 | 不登录。清单有领票口先 GET，200 出票不必等报错；没有再 path 填外站 / 换票口假码对照再改 `redirect_uri` 外域，从 message/报错 URL 抄。仍打账号信息口 / 签发跳转码。 | token 能问出官方号主体或签发官方跳转码；或完整 AppSecret 能拿授权码换成该应用 access_token | 报错只有 ErrCode 没有 token/secret；假码本域回调不带钥；token 调身份接口无效；secret 换不了票；领票口请登录或只出占位串 |
| 越权/IDOR | 发布页 conversation-data 的 artifactMap 有资料库 `nodeId`；主站文档空间要登录 | 不登录打发布域 pagechunk。 | 拉到他人文档全文（标题/角色卡/大纲，`role=editor`） | 只读到已发布 HTML 快照；pagechunk 对资料库也业务错码；正文已在对话快照里 |
| 越权/IDOR | 助手/Agent 前端有历史列表口；登录态只在可选头里 | 不登录调列表再打详情。 | 列表/详情出现**他人**任务原文（下载、订阅、对话卡片），不是公开广场 | 只出广场/`share_id`；换 guid 列表变空或只剩自己的 |
| — | 文件翻译/文档转换网关；list 和 load 不要登录 | 不登录 POST list，抄他人 `file_id` 再 load。对照空 session 应只出自己的或空 | load 出**他人**未公开译稿/文档正文 | 只出自己刚交的；list 是公开示例库；load 只要标题没有正文 |
| 越权/IDOR | 匿名 CSRF/临时 token 口；业务详情只验这个头不验登录；query id 和回包业务 id 可以不是同一个号 | 不登录拿 token 头打详情换数字 id，id 对不上别停。 | 未上架/测试训练脚本或内部会话正文 | 只有公开广场；token 过了仍空 |
| 越权/IDOR | 管理后台 SPA 请求拦截器把自定义头（`User-Id` / `employeeId` 一类）当登录身份；未登录名单口只出数字号没有手机 | 不登录。名单抄数字号，把头换成这个号打当前人信息口。名单没手机别停。 | 出他人姓名+11 位手机 | 头过了仍空；名单已经出手机（那是另一条） |
| 越权/IDOR | CRM / 企业 IM 客户详情口前端只写外部联系人 id；只带这个 id 回空壳 | 不登录 POST 同一详情口，body 加 `phone`（及展示开关）。换号必须换人。 | 出他人姓名/公司/内部 UDF，且查的就是这个完整号 | phone 一律空或只出同一条测试号 |
| Agent执行 | 云助手 whoami/身份口回未登录，对话口 `/chat`/`createTask` 仍接；工具列表有 bash/python。**没有 whoami 对照也打** | 不登录 POST 对话口，让模型用 bash 或 Python 跑 `id`。SSE 没有 `toolName` 别停。命令跑起来后跟 flag / 云钥 / 他主体正文。 | stdout 是 SRC 验证台 flag、云密钥、或他主体业务正文。沙箱 `uid=` 不算 | 模型只口头说执行了、数字对不上本机、沙箱文件名是提示里写过的；沙箱拒命令；必须登录；只 curl 到公网不算通内网 |
| 认证绕过 | 云厂商产品 Demo / 体验页 / 控制台代理 / 供应商后台；领 STS、联合身份、建任务只要业务 id 或空 body，不要 Cookie。领 STS 口缺参只报字段校验不是登录闸，不一定有演示号。或分享域前端 HMAC 过网关后，领 STS 口不要分享页 token | 不登录。有演示号抄客户编号；没有也打领钥口，缺参报校验别当登录闸。空 body 报缺 `AppId`/`Uin` 也别当没口，带能解析的数字 Uin 就发联邦 STS；bucket+file_name 仍打。领钥口可能在独立 demo CDN `/openapi/`。HMAC 过网关后对照其它口「token 不合法」，领 STS 口仍打。换 bucket 用 PUT/NoSuchBucket 探活桶。过签≠出数。 | 临时钥匙能问出 AccountId/角色名；同一身份下列表出现刚建的任务；或检索出口径出账单/实例/他主体业务字段；或活桶 PUT 200 | 钥匙调业务 API 全 Unauthorized；领钥口请登录/401；create 200 但列表没有。没有演示号/客户编号不是假点 |
| 越权/IDOR | BaaS 匿名 session；列表口不验管理员 | 不登录 `POST .../sessions/anonymous` 再 listRows。常见 BaaS 皮，没有这名仍打。对照无 Cookie 应 `total=0`。 | 匿名会话 `total` 涨，rows 里是**他人**手机/邮箱/报名正文 | 无会话也是全表（另一条：完全无鉴权）；匿名会话仍空或只自己刚填的；删别人 401 只说明写没开；公开运营名单 |
| 越权/IDOR | 云开发匿名登录；有低代码数据源函数 | 不登录匿名签到拿 JWT，打用户集合 / 低代码记录口。HTTP 网关禁用匿名别停。用户表行权限失败别停，改文档库 query `collection=users`。 | records 里是**他人**手机/邮箱/uin，不是自己刚匿名建的空号 | 行权限拒匿名且文档库 users 也空；数据源不存在；只出演示 todo/sales；旧 HS256 票丢函数口报 KID 无效当没洞 |
| 越权/IDOR、文件/存储链 | 前端写死 `appId`+`appKey`（或同类 Id/Key 头）；或无代码落地页写死 `role=anon` JWT | 不登录带写死钥打业务表。rest 403 别停，改打存储 REST：官方前缀 + `x-upsert:true`。+ STS 第 9 步 | 业务表 `count` 海量或出现**他人**稿/邮箱/电话；PUT 改别人 `objectId` 成功；或官方前缀对象能盖 | `_User` 和业务表都 403；只能读自己刚建的；只能 LIST 公开运营配置；rest 403 就当存储也不能写 |
| 越权/IDOR | 客服/支持台 umi 有知识列表+详情；或大厅 HTML 吃数字篇号；或公告 JSON 用 callname 代理知识库；或未登录 CMS 能列出非官网内部知识库；或 chatbot 未登录检索口正文在 behavior | 不登录打列表再打详情。json 没有就打 HTML；公告口换 callname；CMS 换非官网 siteId；loginMode is null 带头；chatbot dir 401 改检索口看 `behavior.value`。 | 列表 `pager.items` 上千或 count 海量，且 Info/HTML/详情/`behavior.value` 出**内部**话术/协查/短信/运营知识库正文，不是公开 FAQ | 只有公开帮助稿/错误码/对外协议/官网 Banner；Info 只要标题；工单口也放行（那是另一条）；只打了默认官网站点；dir 节点 401 就停；检索口只出标题 content；不带头当没口；content 缺 siteId 当没正文 |
| 越权/IDOR | 问卷/测验填表模型口；前端写死业务 id 或白名单；回包 schema 带标准答案或内部审核题干/样图 | 不登录打 getModel/schema，别停在表单标题。样图 preview 跟着打。 | 内部测验正文+标准答案，或证件/执照样图真下到 | 只有公开报名表标题；schema 没有 answer；只有自己刚填的答卷 |
| 越权/IDOR | 前端 JS 写死签名盐；写接口或检索/名单 query 只要 `timestamp`/`sign`/`nonce`，或头 `Authorization: OAuth apiSign=`，不要 Cookie。资讯 CMS 常见 `md5(盐+unix秒)`，盐是 source 拼两遍再加 biz | 不登录抄盐自己算。常见 MD5(timestamp+path+盐+nonce)；或 SHA1(盐+按 key 排序后的参数值拼接) 放进 `OAuth apiSign=`。对照：其它业务要登录，检索/名单/写接口仍 200。 | 平台状态真变（能改回）；或名单/详情出现他主体/证件号 | 只过网关签名、业务仍 401；盐只能过本接口、写/读另外要会话 |
| 越权/IDOR | 开放支付/进件网关 body 有 `appId`+`sign`；假签时活应用回 `MERCHANT_NOT_EXIST` 或 `SUCCESS`，死应用回 `SIGN_ERROR`/`APP_NOT_FOUND`；或演示收银台预下单口假签/node 代签也能进生产网关 | 不登录。假签枚举 `appId` 看回码差分，活的打商户查询换 `merchantId`；演示预下单本站查单 404 别停，打生产查单口。 | 出他人商户身份证/银行卡/手机；或生产查单新单且有他商户交易号 | 假签一律 `SIGN_ERROR`；`SUCCESS` 但证件卡号全空；文档示例 appId 已死；只回渠道号且生产查单不存在；只能给演示店挂 |
| 认证绕过 | 支付/开放网关要商户签；假签时 **GET / DELETE / OPTIONS / HEAD 都可能 302**，Location 或 msg 把服务端刚算的签明文带出来 | 不登录。假签打签约/下单口，**GET 也要看 Location**，再换 METHOD；从 Location/`calculateSign is:` 抄签填回 `sign_data` 打查询。 | 过签查出**他商户**未公开订单/账户正文 | 所有 METHOD 都只报验签失败、没有算出的签；抄回去仍 `ILLEGAL_SIGN` |
| 越权/IDOR | 短信/运营短链解析站；猜中的短码 302 到落地页，query 明文带 phone/name/金额 | 不登录。打 `/open` `/app` `/s/` `/www` 加短字典（aaaaa、1、1234）；首页欢迎页、302 官网或 Hello 壳别停。 | 跳转地址里是**别人**的手机/姓名 | 失效页；公开营销无 PII；短码要真短信才解析；首页 302 官网/Hello/Welcome 不是没洞 |
| 认证绕过 | 支付 UISDK/开通页；未登录配置或 RPC 口用可枚举 appId 回 signKey | 不登录换 appId。死应用 APP_NOT_FOUND，活的抄完整 signKey，再用真钥现签打支付进件/打款/预下单/创建虚拟门店/改结算卡。改卡口看支行号差分出 changeId，原值报未变更；SUCCESS 但 changeId=null 不算写上。对照假钥 SIGN_ERROR。 | 完整 AppSecret 且真钥过生产验签，或查出他商户身份证/卡/挂单，或建出虚拟门店 poiId，或改掉他商户结算卡/开户行（changeId 有值） | 回的是占位钥过不了验签；死活都 APP_NOT_FOUND 且无钥 |
| 认证绕过 | 文档 / Demo / 官方包 / 接入 HTML / npm 历史包写死完整 AppSecret（不是占位符）。wiki 打码、同一套 zip/Demo/HTML 仍明文别停 | 不登录抄出来打换票口或按文档现签生产口。wiki 打码别停，跟 zip/Demo/HTML/npm。 | 钥是活的：能换成该应用的用户票或 client 票，或查出该应用供给/他商户未公开订单/手机，或生产闸真签过、假签失败 | 文档是占位符；真假密钥同一句错；钥过期调不通；联调钥只能打测试环境、生产拒；wiki 打码就当 zip/Demo/HTML 示例也打码；只逆地理通、地点云/图层没表 |
| 文件/存储链 | 入驻/资质 SPA 打包 JS 的 mock/演示 formData 写死密文 `fileKey`；站点根 301 到新域 | 不登录。根 301 别当旧 host 下载口废。抄 JS 里的 fileKey 打旧 host 下载口。 | 私有桶执照/证件原图真下到 | 把 301 新域名当整站废；mock fileKey 当下占位且乱填也出同一张图 |
| 越权/IDOR | 入驻 H5 有招商电话页；同套其它 settle 口 302 未登录。JS 里按品类查 BD 的 RPC，industry/类目空时 body 空 | 不登录打网关 `/api`。类目字段空着，不要填死数字。 | 内部 BD 姓名+11 位手机+企业邮箱整表 | 类目填死数字出空数组就当没口；把页面公开热线当这枪 |
| 越权/IDOR | 入驻 H5/小程序打包 JS 把 OCR/企业信息口 token 写死；JSON 口只要 pin（或同类账号）+ 非空 token | 不登录。空 token 对照应空 data；写死那串能过，任意非空串也能过，再换可遍历 pin。 | 出 pin 对应真实手机 | 空 token 也出数（完全无鉴权，另一条）；token 过了仍只出自己刚入驻的 |
| 凭证泄露 | 开放平台文档中心；页面文档/分类口 401；入口 script 有文档页动态 `import()` 的技术文档 chunk | 不登录。文档 API 401 别停。跟首页 script → 文档页 import → 文档 chunk，抠样例报文里的身份证/手机。 | 过校验位的身份证 + 姓名/手机，对得上人 | 张三/110101 占位；校验位不对的编造号；空证件号模板；只有公开产品说明书没有样例报文 |
| 认证绕过 | 门户 CMS 前端写死 `accessKey`+`secretKey`；有站点 login 口发 JWT | 不登录抄钥打 login，头带站点 token 打内容/附件列表，跟测试/后台频道和附件 URL。 | 内部测试报告/未对公开展示频道的稿件正文 | 只有公开运营 Banner/客户端下载 |
| 凭证泄露 | 管理台前端 JS 写死 CI 的流水线 id + base64 `auth`，且有未登录 trigger 口 | 不登录抄 auth 列私仓。 | 列出他团队私有仓库名/HttpsUrl/ProjectId，或钥 scope 含读仓且开放接口认钥 | 钥过期；仓是公开的；只有 trigger 回产品下线、没有证明钥还能列出私仓 |
| 凭证泄露 | 开源文档/社区前端为拉 GitHub org、贡献者、star 把头，把 `ghp_` / `github_pat_` 打进打包 JS | 不登录从 JS 抄 PAT，打 `GET https://api.github.com/user`，再 `/user/repos?affiliation=owner` 看 permissions。对照无钥应 401。 | me 是真人 login/姓名，且对该号仓 `admin=true`（能当这个 GitHub 号用） | 钥已吊销；`/user` 401；只是 GitHub App 安装令牌读公开 org |
| 凭证泄露 | 落地页/viewer JS 有循环 XOR / hex 包着对象存储永久 SECRET_ID/SECRET_KEY | 不登录解开永久 AK/SK，签 STS 问身份、问账号。ListBuckets 403 别停。 | 问出 AccountId/Uin/AppId（长期钥，不是临时票） | 解开调云 API AuthFailure；exampleValue 解成 hello_world 占位 |
| 文件/存储链 | 管理台 webpack 明文 `accessKeyId`+`secretAccessKey`（S3 兼容永久钥）；或中间件登录页内联服务钥；`getUploadSign` 是前端 HMAC-SHA1，policy `starts-with $key` 为空 | 不登录抄钥自己算。List/PUT 403 别停，先问桶地域证活；页面桶名拼错试邻近。对照假 AK `InvalidAccessKeyId`。任意 key PUT/DELETE，官方已引用对象试覆盖。 | 完整永久云钥能签（真签 PUT 200 或问出地域）；能盖官方已有对象更稳 | InvalidAccessKeyId；只能传到固定前缀；getUploadSign 其实是 SSO 接口没有本地钥；钥过期 |
| 凭证泄露 | 公网 HTTP `/version` 出 `"Model":"master"`（分布式文件集群） | 不登录 `GET /user/list` 拿 AK/SK；对照假 ak 打用户钥信息口；再管理口看他用户业务卷。 | 完整 AccessKey+SecretKey 且真钥问出身份/他用户业务卷 | 只出版本没有钥；list 空；真假钥同一句；只有空测试卷 |
| 注入 | 企业流水/消费/名单列表有员工名、姓名、关键字筛；回包有 `total`/`totalNum`/`totalSize`；或后端是 ES | **只打一枪**，只看回包 **total** 就停。不连打、不翻页导出、本枪不用 sqlmap dump。 | total 从空/个位涨成海量，且第一条能看出**不是本企业本职**的流水（姓名/金额） | 模糊搜索碰巧命中 or；涨的全是本企业本职可读（不报）；ES 只吃 DSL 不吃这段 SQL；WAF 405 |
| 注入 | 邮件订阅嵌在 iframe 里；同目录 list 的 key 当鉴权、拼进 SQL | 不登录打 iframe 同目录 `list.php?key=`：`1' OR client_id=租户 LIMIT 1#`。订阅表单皮常见。 | 该租户订户姓名/邮箱/电话 | 没有 list.php；key 走常量比较/预编译 |
| 缓存投毒 | 登录后个人页、账单、`/api/me`、设置页（有没有 `X-Cache` 都行） | 原 path 后加 `.css`/`.js`/`;.css`/`%2f.css`，再未登录打同一 URL。 | 未登录拿到**别人**个人页/账单/会话页正文 | 只 HIT 了静态壳；`Cache-Control: no-store`；要受害人先点才缓存、你这边没拿到他人数据 |
| Host头 | 清单有重置 / 激活 / 邀请发信口；或未登录授权地址口用 Host 拼 OAuth `redirect_uri`（GetAuthorizationUrl 一类） | 重置/授权请求改 `Host`，拦了再只改 `X-Forwarded-Host`。；认证口纪律按 VC 卡 | 协作域收到带 token 的重置链，能换别人密；或官方身份页仍 200 且 `redirect_uri` 是外域（登完码落到外域） | 信里仍是原站；只反射 Host、邮件不跟；token 绑死本机会话点不开；身份页拒外域回调 |
| 认证绕过 | 未登录签发 SSO / 回跳；callback 只判断字符串里有没有官方 host，或不校验、任意外域也能签 | 不登录。callback 填外域（夹官方 host 和不夹都试）。 | SSO 成功且回跳仍是外域；或登完通行证出现在外域 query | callback 被改空；SSO 缺回调参数 |
| 认证绕过 | 电子合同/供应商门户登录页只填可枚举合作方数字 id；未登录 getUrl（或同类签发登录链）直接出 partnerId+generate+code | 不登录打签发口，把回包三项 POST 给 setCookies/换票口，再带会话打合同/支付列表。 | 进了别人供应商号（身份口登录成功，或能当这个号读未公开合同） | 签发口要已登录；code 必须从邮件点开；setCookies 不下会话；只出公开招商页 |
| 认证绕过 | 管理后台前端只跳 SSO，页面没有账密框；后端仍暴露账密登录 API | 不登录 POST 该登录 API 默认 `admin`/`123456`（不要磨 SSO 验证码），拿 accessToken 打 tenant/user page。 | 进了平台管理员号，且租户/用户列表出他人手机/姓名 | 登录口 404 或默认口已改；票只能进空租户没有联系人 |
| 认证绕过 | 运营台前端把供应商直连配置查询挂成未登录；body 只有可枚举合作方数字 id | 不登录 POST 查询口，换邻号。对照未配置 id 应回查空。 | 回包里是完整 clientId+clientSecret（能当这把直连钥用） | 接口已下线；clientSecret 空或占位；必须登录；只出公司名没有钥 |
| 认证绕过 | 联合登录签发口 body 只有 `provider`+云账号 `uin`（或同类 uid），不验 OAuth code/ticket | 不登录 POST 该口；再拿票打 me/用户信息。 | me 是**对方** UIN，能当这个号用 | 只出游客号；uin 必须已在本活动注册且 me 仍是自己；必须真 OAuth code |
| 认证绕过 | 活动页 login 吃互联 `openid+acctype+access_token`；假 token 在 qq/qc/pt 仍发票，wx/空票对照失败 | 不登录 POST login 假 token + 可枚举 openid；拿 JWT 打 getRoles/bindRole 一类角色口。 | 票里是对方 openid，角色列表出现他名下角色，或能绑上 | 只签发空号且角色列表全空、绑不上游戏角色；必须真互联票 |
| 越权/IDOR | 未登录隐私号/虚拟号（AXB）口；失败时把真实手机当下发；对象号可遍历 | 不登录换门店/对象号。网关空 Origin 或本站 Origin 回 cross-origin 403 **别停**，改业务域 Origin（订单/购物车/H5 域，不钉某一家 host）再打。 | 回包是他人 11 位真实手机（文案写获取隐私号失败也算） | 只出虚拟号/中间号；必须登录；换号号码不变；空 Origin 403 当没口 |
| 越权/IDOR | 物流/开放网关前端写死「无需鉴权」头 + 域名路由头（或同类过网关鉴权头） | 不登录带着这组头打可枚举 siteId / 空翻页名单/运单口。 | 出他人手机/住址/站点联系人 | 头过了业务仍请登录；只有公开轨迹没有 PII |
| 认证绕过 | 培训/学院 H5 网关把账号绑定/查询 RPC 放进未登录 client 前缀，body 吃 C 端 uid + 商家号 | 不登录 POST bind，uid 换成别人、商家号换成自编；再 querybind。 | 出对方手机，或绑定成功改绑 | 只回未登录/参数异常；uid 一律未绑手机且写不进 |
| 认证绕过 | 未登录改密/首次设密/重置最后一步；body 有旧密或验码字段 + 新密 + 身份 id | 不登录。旧密/验码置空或省略；对照填错验码应拦、不存在 id 应查空。同一密再打若报历史重复=已写入。 | 未登录 Success 且改掉别人的密（历史重复/错码对照能证明写库） | 只回 0 没写库；必须真旧密/真短信；Success 但登录另一套、密没跟过去 |
| 认证绕过 | IDaaS 忘记密码先签发非 reset 的 JWT（scope=`_` 一类）；密保题库有未绑到该号的 id 可写 | 不登录拿 sq 类 token；GET 已绑 id；`update_question` 写未占用 id；verify 换 reset scope；再 `set_password`。 | 密保答案写到别人号上（改绑），或用该令牌真改掉别人的密。过了改回；改不回停在回包 | sq token 直接改密报 scope is not expected；已绑 id 409；verify 错答；策略拒且密保没写上（半条，不进表） |
| 越权/IDOR | 公开列表只出上架/公开；详情、hidden、tab、短 slug、预览/导出用同一个业务 id，不校验这层闸。或列表有可见性查询参默认把隐藏滤掉。或列表要登录/空包、详情只要数字 id + 业务键。或对外详情把联系人/手机置空。或 `period=edit 或 publish`。或筛选项 null/缺字段报错、空数组当不过滤。或文档 CMS 写死公开 area/端/channel。或文档站公开 itemList 只出对外产品，item 用纯数字仍出对内/未对外知识库正文。或搜索口素材类型默认公开。或入驻/审核 query 只带业务 id 出空壳。或全量列表口不带可见性参行里就带着 unpublished 正文。或浏览页请登录、同站 search/文件列表/visit-log 仍出正文。或内容 SPA 按 host 正则选站点域 | 不登录。按 里的别停表打：可见性参、全量列表、browse 请登录跟 search、详情修了跟 visit-log、目录请登录跟文件列表+PreviewUrl、SPA 站点 TLD、证照图注册人行、telephone 打码看备注、公开 itemList 只有对外几本仍用数字 item 打详情/page、收集表详情 relative 挂答卷 sheet 跟答卷表。**预览口 `isDelete=1` / 已删除仍出整页 H5 别停** | 未上架/未公开业务正文；或他主体证件照/手机；或证照图注册人行印着身份证号 | 详情本来就是公开橱窗；加了可见性参仍只出公开稿；只有标题没有正文；列表 401 就当没洞；edit 和 publish 出同一份已上架正文；空数组和缺参出同一份上架稿；`materialType` 仍只出公开橱窗；只带业务 id 出空壳就当没洞、没再加审核状态；浏览页写请登录就当没洞；打错站点域当没口不是假点；预览只出已上架运营页 |
| 越权/IDOR | 业务 H5 把登录 RPC 写在需登录前缀；同网关另有未登录前缀（n/unlogin/guest） | 不登录。JS 里的登录前缀口请登录别停，把 path 改成未登录前缀，再换对象 id。 | 不登录出他人身份证/证件照/手机 | 未登录前缀仍请登录；只有公开配置；只有自己刚交的补件 |
| 越权/IDOR | 业务页 JS 调数字 RPC 网关（`/data/{数字}/forward` 一类），页面只写死一个 cmd | 不登录 POST 邻号，先空 `{"req":{}}` 看列表，再带 id 打邻写口。 | 内部发布/操作人正文，或字段被改 | 邻号仍是同一套公开接口；只出公开软件目录 |
| 越权/IDOR | 同产品业务前端的账号 CRUD 口回登录闸；另有独立身份子域，同一套账号 API 不要 Cookie | 不登录。前端 NoLogin 别停，改打身份子域 list（空包也出整表），再 generate / reset-pwd 只带 Id / delete。 | 名单里是手机/企业邮箱；能建号、不验旧密改密、按 Ids 删 | 只打了业务前端就当没洞；list 出数但 Mail/Phone 全空且写口也闸 |
| 越权/IDOR | 开放平台 / 分销合作入驻申请查询口；未登录；参是执照号、手机号或名字关键字。页面查询空时 JSON 格式参常还在出数 | 不登录打申请查询。执照号从 1 自增，或换手机号 / 申请单号 / 名字关键字。页面格子空别停，加 `f=json`（或同类 format 参）再打。名录页是登录壳时，同目录 `search`/`list` 再打一枪，不必关键字也可能整表出联系人。 | 出他人联系人手机 / 邮箱 / 身份证 / 执照图 | 只回公开合作名录没有联系人；页面和 JSON 都只有公开格子；只回自己刚交的单；执照号无效 |
| 越权/IDOR | 报名/入驻/发票抬头自动完成；页上下拉只出公司名；接口走工商 Match 或抬头 suggest（前端可能标 auth） | 不登录 POST。名称+国家码；suggest 字段可能是 `prefix`（填 `title` 报关键词空别停）。同产品还有专票/工商补全口，字段就是 `title`。前端标 auth 仍打。 | 回包出现负责人或开票手机/住址/银行账号，且对得上人 | 下拉和接口都只有公司名；必须登录；公开企业名录没有电话；前端标 auth 就当没洞 |
| — | 未登录字典补全口；分类参前端只示范区号/城市一类，后端能切到用户/员工表 | 不登录 POST，分类填 `user`（或 employee），filter 用号段或姓 | name 里是他人姓名+11 位手机 | 只出公开城市/公司字典；user 分类空或只有 MIS 没有手机 |
| 越权/IDOR | 注册 / 改资料 / 建用户的 JSON 比页面控件多；Swagger 或管理员建用户多出字段 | 多塞 `role`/`isAdmin`/`verified`/`tenantId`/`balance`。 | 自己号变成高权，或余额/认证状态真变（能改回） | 字段吃了权限没变；只能改展示名；公开运营开关 |
| 原型污染 | Node JSON/query 能污染 `__proto__` 或 `constructor.prototype`；后面有 `res.render` / EJS / Pug | 先确认污染通了，再打 `outputFunctionName` / Pug `block`。 | 模板渲染后命令跑起来（标记/`uid=`） | 只能改前端展示、没有模板/spawn gadget；污染一请求就没了、下一次 render 不跟 |
| 穿越/LFI | 站上已有 `/static` `/assets` `/img` `/files` 这类静态前缀；或 Caddy 模板吃用户输入 | `/static../` 读 web 外文件；Caddy 模板试 `{{readFile "path"}}`。 | 读到 `nginx.conf` / 应用配置 / 密钥文件 | 只 404；只能列静态目录里本来就有的文件；Caddy 模板不执行用户输入 |
| 穿越/LFI | Node 把仓库根交给 koa-static / express.static（能直接 GET 到 `package.json` 或 `routes/`） | 不登录打 `/config/online.yml` `/config/default.yml` `/config/production.yml`；有 `package.json` 就顺着 node-config 环境名扫。 | yml/json 里是**完整库账密或云密钥实值** | 静态根只出 public；yml 没有账密；`package.json` 200 但 config 404 |
| 穿越/LFI | 对象存储/静态桶上的旧 .NET 发布物；aspx 源码还能 GET，同目录 `web.config` 被 WAF 拦 | 不登录。`web.config` 456 别停，打同目录 `App.config`、`*.exe.config`、`bin/*.dll.config`。 | 完整账密或 DeveloperToken，不是 `ENTER_YOUR_PASSWORD` 占位 | aspx 200 但 config 404；只有源码没有钥；占位符口令 |
| 穿越/LFI | 公网 VS Code 系编辑器；`/login` 直接进（无登录墙） | 不登录打资源接口，path 吃绝对路径时先读进程 status 看 Uid，再读进程环境。页面里 `AuthType.None` 是常见皮，没有这个字仍打。抄到环境里的 SSH 私钥别停：解开 PEM，假钥对照连环境里的 Git 主机。 | 环境里是**他人**邮箱和完整 SSH 私钥，且真钥能问出 Git 用户名 | 只读到 README/安装脚本；path 要登录；真假钥同一句 Permission denied |
| 云IDE/RCE | 公网编程台有租户登录口 + Codex 系 RPC（`command/exec` / `fs` / `env`） | 当前站打裸默认口拿会话，再打 RPC。无 Cookie 也试 `meta/methods`。跟 env / 集群 SA / 模型 Key。**只打当前站**。 | root（`uid=0`）且 hostname 是持久计算面，并能问出集群钥或模型 Key | 通配符证书临时沙箱随时销毁；只登录没有 RPC；命令没跑起来 |
| 认证绕过 | 未登录业务口 JSON 报「缺少 xxx」；query/body 带了仍报缺少。或 Spring 400 点名 `Required String parameter`，缺的其实是 Cookie 名 | 把缺的字段放到 **HTTP 头**再打换票。头没吃别停，改打 Cookie。未登录写口同样试。 | 出别人的登录票/姓名；或写上他人门店/对象 | query 有该字段仍报缺少（头和 Cookie 都没吃）不算过；只出自己的票 |
| 认证绕过 | JSON 网关刷新票口；空包就发票，票里是 admin | 不登录 POST refresh `{}`，Bearer 打管理 me 和申请名单。 | me 是超级管理员 *，或名单出现他人手机 | 只出游客票；refresh 要旧 refresh token；me 仍是自己 |
| 认证绕过 | 小程序/H5 GET 登录口吃 `openId`（`loginByOpenId` 一类） | 不登录。缺参报缺、假值失败别停，空串再打。 | 进已有商家号且出手机 | 空串只出游客空号 |
| 文件/存储链 | 软件/制品下载详情把 query 里 `uin`（或同类身份字段）有无当登录闸，不验 skey/Cookie | 不登录 GET 详情，身份字段填非空假值（对照空值 DownloadURL 应是空串/跳登录）。拿回的带签 URL Range GET 真文件。 | 专有云安装包/内部部署文档真文件（ELF/docx 正文） | 空 uin 也出 URL（那是完全无鉴权，另一条）；带签地址 403；只有公开说明书 |
| 凭证泄露 | 企业软件中心人打开是登录页；另有领对象存储带签口不要 Cookie；或同站 `/download/`+软件文件名不要 Cookie；包里是桌面客户端连接配置（Host/账号/密文） | 不登录打领签口（登录墙 302 体里内联的也算）。**领签没有也别停**，首页/302 体里的软件文件名同站 `/download/` 直 GET。解 zip 里的连接配置。解密钥 | 内网库 Host+账号+明文密 | 包里只有公开客户端没有连接配置；密文解不开；只打了领签口就当没静态目录 |

TECHNIQUE_INDEX_EOF
