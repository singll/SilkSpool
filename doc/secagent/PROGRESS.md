# SilkSecAgent 进度（当前）

> **本文件只保留「当前状态 + 最近进度结果 + 通用规则」**。一切历史——历次更新日志、已完成节点（附 commit）、已关账待办、批次守则/模板——都在 [archive/progress-history.md](archive/progress-history.md)（只读不改写）。
> **滚动规则**：新结果写入本文件；当新结果使上一版「最近结果」过时，把上一版整体移入历史归档，保持本文件只含当前。不再新建「最新进度/本次升级」等副本。
> 模块契约与版本在 `00-conventions.md`…`18-migration.md` 内自维护；文档目录治理规则见 [README.md](README.md)。

## 一、当前状态

- **迁移计划真相源**：[18-migration](18-migration.md)（Phase 0–5）。
- **Phase 状态**：**Phase 0–5 全部完成并关账**；当前无进行中的迁移/整改批次。
- **运行基线**：DSH **0.1.5-rc.2**（U3 于 2026-09-15 生产切换、U4 于 2026-09-18 关账）；csai `silksecagent` active、NRestarts=0、14 域 registered、`aliases=0`；`sec-v5-accept.sh` **PASS=80 FAIL=0**（2026-09-23 24 号方案验收后重跑）。
- **最近一次全面检查**：[archive/20-full-inspection-2026-09-19.md](archive/20-full-inspection-2026-09-19.md)（文档/代码/流程/运行态/UI；**四轮修复全部落地验收，结论已全部回填各模块，2026-09-22 归档**，见其 §十一）。
- **专项归档**：[archive/19-ui-unify.md](archive/19-ui-unify.md)（看板 UI 全局统一重构：**U1–U4 + 走查补丁已实施，csai 验收 PASS=72 FAIL=0**，结论已回填 16-dashboard/主题 §11.8·§11.9/CONTEXT；已归档只读）；[archive/23-llm-supply-throttle-2026-09-23.md](archive/23-llm-supply-throttle-2026-09-23.md)（LLM 供给联动调速 + 任务级选模型，已实施部署验收）；[archive/24-ops-audit-ui-flow-2026-09-23.md](archive/24-ops-audit-ui-flow-2026-09-23.md)（任务/知识/学习工作流可视化，已实施部署验收 accept PASS=80）。
- **已知遗留（非阻塞，待后续会话）**：sec-suite/asset-db/experience 内部少量 v4 读取函数（experience 仍被 dashboard-rpc/task 链路引用）；`18-migration` 的 DoD 仍须逐条核对。
- **文档漂移排查**：B1–B5 全部闭环（2026-09-19）；详见历史归档。
- **领域语言**：[CONTEXT](../../bundles/dsh/CONTEXT.md)。

## 二、最近进度结果

### 2026-09-25 · 36 号补丁：exec worker 并发提升 + 认领上限对齐（accept PASS=45）
- **动机**：用户问能否加并发/任务量把 lite（SenseNova flash-lite 专属积分）用完。瓶颈在 `MAX_WORKERS` 硬编码 4。
- **修复**：`SEC_EXEC_MAX_WORKERS`（默认 12，钳 1–32）、`SEC_SCHEDULER_CLAIM_LIMIT`（默认 12，钳 1–32）、`selectDueTasks` 上限 4→32、`task_claim` 契约 `event_limit` 4→32（否则 12 事件撞 `E_BUS_EVENT_TOO_LARGE` 静默空转）+ claim 失败诊断日志；生产 `.env` 双置 12。
- **实测**：12 worker 并发，单 tick 稳定认领 12 条；Bellkeeper 近 600 条 LLM 日志中 501 条 `sensenova-6.8-flash-lite` 200（≈83.5%）——lite 积分已在被消化。8C/16G 下 load ≈22、swap 1.1G，为**本机实际上限**，不再上提（瓶颈在执行侧 CPU/内存）。三池当前为 `priority-health`（与 §7.19 best-weight 有漂移，但对「烧 lite」目标更有利，本轮不改）。
- 文档回填 [05-task §7.20](05-task.md)。

### 2026-09-25 · 35 号补丁·二段：池策略 best-weight 加权分流（OpenCode Go 额度利用率修复）
- **诊断**：Go 消耗 0 不是额度小（本地桶 120rpm/20000rpd 远超峰值 23rpm；429 全是上游真实限流），而是 `priority-health` 渠道 priority 硬排序——sensenova=1 健康时永不落 Go（priority=3）。
- **修复**：三池切 `best-weight`，Go 成员提为最佳档 w8（DB API + YAML 双写对齐）；实测切换后 5 分钟 18 请求全落 Go（2M tokens），官方 rolling/周/月窗口余量 100%/66%/60%。
- 附带发现：flash-lite 定价表缺行（成本估算影响，待补）；56 个 running 僵尸任务在 75 分钟回收宽限内自然回收。
- 文档回填 [05-task §7.19](05-task.md)。

### 2026-09-25 · 35 号补丁：额度大提额 + 自动爬坡免人审 + 池治理修正（accept PASS=45）
- **诊断昨晚停摆**：真凶是专项预算闸（#1 烧完 10M 转 reviewing 等审批 #49 空转 9.5h），非 LLM 额度；OpenCode Go 零消耗是 priority-health 硬排序设计（sensenova priority=1 健康时永不落 Go）；glm-5.2「不可用」系 27 号过时结论（今日实测 137 次 200）**保留**。
- **提额**：campaign#1 200M / #2 100M / #3 50M；per-program 闸 budget_max_tokens 2B、max_tasks 5000（用户指示额度充足翻几倍无忧）。
- **自动爬坡免人审**：Supervisor 提请 budget-extend 后 system 自动批准（operator=auto-campaign-budget，`SEC_CAMPAIGN_BUDGET_AUTO_APPROVE=off` 可关），消除人审延迟空转窗口。
- **池治理**：34 号「YAML 移除 deepseek 官方」实未生效（SeedLLMProxyConfig 仅空库播种）——本轮走 DB API 真正移除（6/3/4 成员生效）；**规则：池序调整一律走 DB API，YAML 仅首启种子**。DSH `.env` POOL_MEMBERS 同步移除。
- 三专项全部恢复 active/L2。文档回填 [05-task §7.18](05-task.md)。

### 2026-09-24 · 34 号补丁（运维）：DeepSeek 官方 API 移出 secagent 三池
- 用户指示「当前托底的不是 deepseek 官方 API，先移出」：`pool-secagent`/`pool-secagent-lite`/`pool-secagent-heavy` 摘除 `deepseek-secagent` w1 成员（7→6 / 4→3 / 5→4），末位变为 OpenCode Go；渠道定义保留备加回；重启生效后实测 25 次请求全部走 SenseNova，官方命中 0。
- 配置不在 git（keeper 线上 bellkeeper.yaml，已备份 .bak-20260924）；文档回填 [05-task §7.17](05-task.md)。注意：此后无付费托底，SenseNova 全员熔断时直接落 OpenCode Go，耗尽时靠供给归零自动降级兜底。

### 2026-09-24 · 34 号补丁：任务功能权限断点补齐——预算闸在线配置 / 专项归档·改目标·新建 / 任务备注（ui-task 24/24、task/approval 契约通过，accept PASS=45）
- **断点梳理**（模型与 UI 此前都无法触发）：per-program 预算闸调整只读 env 需重启；专项归档/改 goal_spec 域命令未接 RPC；Dashboard 无法新建专项（种子任务场景，如 Campaign #3 建种子）——现已全部补齐。
- **预算闸在线化**：`task_settings` KV 表 + `budgetConfigOf`（DB 优先/env 兜底，source 标记）+ approval 新 kind `task-budget-config`（批准即落库生效，无需重启）+ UI 预算卡（提请走审批）。task_create 停派判定同步改用 DB 配置，错误消息带配置来源。
- **RPC 六端点**：`campaignArchive`/`campaignGoalRevise`/`campaignCreate`/`budgetConfig`/`budgetConfigRequest`/`taskUpdateNote`；UI 对应加「⏏归档」「+ 新建专项」、队列阻塞/恢复按钮。
- **踩坑**：approval effect 动词必须写短动词（`budget_config`）而非 manifest 全键（dispatch 拼前缀后 findCommandDef 失配）；测试 evidence 须 ≥10 字否则先撞 E_SCHEMA。
- 文档回填 [16-dashboard §34](16-dashboard.md)。

### 2026-09-24 · 33 号补丁：专项治理按钮组——激活/暂停/恢复/审阅/升档全接线（ui-task 21/21，accept PASS=45）
- **根因**：专项 born=draft/L0 是刻意设计（自治需审批背书），但 `campaign_activate/pause/resume/review_pass` 四个域命令本就支持 dashboard actor 却**从未接到看板 RPC**——新建专项永远卡 draft/L0（线上 #3 实证），用户找不到任何治理入口。
- **修复**：RPC 补 `campaignActivate/Pause/Resume/ReviewPass` 四端点；`campaignAutonomyRequest` 支持 draft 提请（升档批准 = 草稿变正式运行通道）；专项卡片按状态出治理按钮组（draft→▶激活+⬆L1/L2、paused→▶恢复、active→⏸、reviewing→✔审阅）。
- 契约 ui-task +1（按状态渲染 + 点击走对应 RPC）；csai 部署 accept PASS=45 FAIL=0。文档回填 [16-dashboard §33](16-dashboard.md)。

### 2026-09-24 · 32 号方案：任务界面整理（方案 A 状态泳道重排 + 会话专项区块）（ui-task 20/20、ui-session 18/18，accept PASS=45）
- **任务中心五区块**：① 专项常驻最上 → ② **正在执行**（running+blocked 上移，不再淹没在 127 条存量 queued 里）→ ③ 队列（默认只显排队 + **来源筛选**：专项派生/其他 + 状态筛选）→ ④ 定时任务折叠（默认收起留徽标）→ ⑤ 历史近期/存量分界（>24h 的 391 条存量失败独立折叠）。零 RPC/DB 变更，纯客户端过滤。
- **会话「安全产出」**：专项区块置顶**全局常驻**（不按会话过滤；本会话有派生任务打「本会话相关」徽标）；任务行带来源专项 chip——派生子任务（worker 执行无 session_id）在会话中从此可见。
- **定时任务结论**：#19/#37/#100007/#100008 已 blocked 停用可取消（暂缓）；#16/#17 recon 每日**保留**（喂专项 Planner 的 ledger 缺口数据）；#24 周复盘**保留**。
- 文档回填 [16-dashboard §32](16-dashboard.md)。

### 2026-09-24 · 31 号补丁：额度提额 ×10 + 升档/延长审批通道修复 + UI 升档入口（accept PASS=45）
- **额度**：campaign#1/#2 `budget_tokens` 1M → **10M**（×10 管理员直改 + milestone 审计；分轮爬坡审批单次 ≤×2 不适用）。提额后 30 号补丁自动回升闭环生效：#1 自动升回 **L2**（autonomy_recovered）；#2 自动回 **active**（status_recovered，L1 升 L2 走审批——**request #45 已进 pending 待批准**）。
- **「看不到审批」根因（三重缺口，均修复）**：① reviewing 专项不跑预算段 → budget_exhausted 后自动爬坡提请通道堵死；② approval 的 budget-extend 校验 spent≥80%（台账口径）与窗口口径不一致会误拒 reviewing 延长 → reviewing 豁免；③ campaign-autonomy 校验+effect 限定 draft/paused → 运行中被自动降级的专项**升档提请被拒**且 UI 无入口（用户只能看降级看不到提请）。
- **修复**：superviseCampaign 预算段覆盖 active+reviewing；approval 放宽升档状态约束（已是 L2 才拒）+ effect 对 active/reviewing 只落 autonomy 不动 status（新事件 `task.campaign.autonomy.changed` 声明进契约）；看板新增 `campaignAutonomyRequest` RPC + 专项卡片「⬆L2」按钮（L1 且非 draft/archived 显示，提请后去审批面板批准）。
- **契约**：approval +3、task +1、ui-task +1；22 号旧断言按新语义更新。线上实测 #45 提请成功。文档回填 [05-task §7.16](05-task.md)。

### 2026-09-24 · 30 号补丁：分原因自动回升 + budget_low 降级留痕修复（task 82/82，accept PASS=45）
- **背景**：29 号方案上线后专项仍未恢复 L2。排查：三类降级（连败/供给归零/预算）均无自动回升通道，每次降级都需人工重批（23 号「降自动、升审批」设计的缺口）。
- **分原因自动回升（tick 步骤 2.8，autoRecover）**：供给型 `llm_restored` 起稳定 15min（`SEC_CAMPAIGN_RECOVER_STABLE_MS`）升回 L2；连败型降级满 1h（`SEC_CAMPAIGN_RECOVER_FAIL_WINDOW_MS`）且无新 rejected 升回 L2；budget_low 型用量回落 <80% 升回 L2；budget_exhausted 型（reviewing）回落 <80% 自动回 active（autonomy 保持 L1，升 L2 仍走审批）。全部写 `autonomy_recovered`/`status_recovered` checkpoint，幂等只回升一次。
- **振荡根因修复**：budget_low 预算闸原先降 autonomy 不写 autonomy_change → 回升后同 tick 又静默降回且无轨迹可回升（升→降→卡死振荡）。两处预算闸补 `autonomy_change(reason=budget_low)` 留痕；回升判据经实测死锁修正为 <80% 对称判据（闸判据会在 91–100% 水位永远升不回）。
- **reviewing 进 tick**：campaign_tick 改为 active + reviewing 都进 tick（预算型自动恢复通道；reviewing 派生段本就被门控）。
- **存量回填**：campaign#1 11:43 的 budget_low 降级人工补插 autonomy_change 回填轨迹。
- **验收**：task 契约 82/82（+4）、rules 41/41、accept PASS=45 FAIL=0；线上实测 #1 连败型自动回升生效（`autonomy_recovered` checkpoint）。文档回填 [05-task §7.15](05-task.md)。
- **遗留（机制正常，非缺陷）**：两专项窗口用量顶格（#1 911,990/1M、#2 1,040,735/1M）——需人工批准新一轮 budget-extend 或等 7 天滚动窗口回落，恢复全速。#1 自动提请受 12h 防抖抑制。

### 2026-09-24 · 29 号方案：LLM 供给链体检——动态重置时长 + 成员级恢复探针 + 真实额度观测 + 滚动额度窗口 + 池序调整（rules 41/41、task 78/78，accept PASS=45）
- **背景**：用户反馈「SenseNova 积分剩 33 万+、Go 月度窗剩 60%+ 却反复降速/停派」。体检确认多层叠加：Go 5h 滚动窗 429 被一刀切 24h 熔断且无成员级探针；dsh 看不见成员级熔断；降速预警用 Bellkeeper 保守 rpd 桶口径而非真实额度。
- **Bellkeeper（c52fc77/1ea0730/59b1aa3/c584618，已推送+keeper 重建部署）**：① 分类器解析 `"resets in N hours/minutes"` 动态熔断时长（月度维持 24h，无提示默认 5h）；② 成员级 quota 熔断探针（到期 10min 内 1-token 探回池），探针间隔 `probe_interval_minutes` 可配（默认/下限 10min，原 30min）；③ `quota_window_seconds` 滚动额度窗（SenseNova/Go 配 18000=5h，`SetQuotaWindow` Reload 平滑迁移计数）；④ 新增 `opencodego` balance provider（官方 `/v1/usage` 三窗口最紧剩余比例），`channels/status` 暴露 `quota_ratio_remaining`。
- **DSH**：`memberSupplyState` 消费 `member_breakdown_*`（单模型熔断不拖垮整渠道，detail 区分 `member_*`）；真实窗口余量（`quota_ratio_remaining`+`window_ratio` 标记）优先于本地桶做降速预警。
- **池序（DB API + YAML 种子）**：pool-secagent = SenseNova 免费优先（deepseek-flash w7→glm-5.2 w6→flash-lite w5→v4-flash w4）→ **Go v4.1-flash w3 → Go v4-flash w2 → deepseek 官方 v4-flash w1 付费托底**；heavy 补 deepseek-flash w5 + 官方托底 w1。
- **OpenCode Go key 轮换**：旧 key 失效（渠道历史 breakdown_class=auth_failed），新 key 已入 keeper .env + csai dsh .env，直调冒烟 200（kimi-k2.7-code 走 Go 渠道验证）。
- **验收**：Bellkeeper 单测全绿（errors 8 + balance 2 + llmgateway 滚动窗）；dsh rules 契约 41/41、task 78/78；csai 重启 NRestarts=0，accept PASS=45 FAIL=0；线上 checkpoint 连续 `llm_restored(factor=1.0)`；三池冒烟 200（deepseek-flash/flash-lite/glm-5.2 各命中）；Go `quota_ratio_remaining=0.6` 实时可见。文档回填 [05-task §7.14](05-task.md)。
- **遗留**：SenseNova 无公开余额 API（控制台人工看）；渠道级连败熔断仍渠道粒度（低频，复发再评估）。

### 2026-09-24 · 28 号补丁：模型 ID 更正 + headless 计费挂载 + 存量复核误判修复（本地契约 625/625，accept PASS=80）
- **sensenova V4.1 真实 ID 是 `deepseek-flash`**（用户提示后上游实测：`deepseek-v4.1-flash` 的「not available in current token plan」是名字错误而非套餐剔除；glm-5.2/glm-5.1 名字本就正确，仅 glm-5.1 真 404）——27 号「套餐剔除」结论更正。Bellkeeper 渠道 models=[flash-lite/v4-flash/deepseek-flash/glm-5.2]、pool-secagent 加 deepseek-flash w7、heavy 组加回 glm-5.2 w6、两渠道熔断 reset；三池冒烟 200 主力命中 deepseek-flash。DSH `SEC_CAMPAIGN_MODEL_MAIN` 同步 deepseek-flash。
- **「无 token 使用记录」根因 = headless profile 从未挂载 dsh-bill**（worker 全部跑 headless，web 有 headless 无）——非额度限制。修复：headless `pnpm add dsh-bill@0.13.1` + bundles 插到 failover 后。修复后记录实时落盘（17k 行持续增长），26 号归因链全通：campaign#1 窗口真实用量 42 万/500k 首次真触发 80% 自动爬坡（budget-extend #41 批准 → 1M）。
- **存量复核误判 rejected 连败降级**：Reviewer 把 review_finding 的合法 false_positive 分诊当打法失败（#100558-#100560 三连 → campaign#1 升 L2 后 25 分钟再降级）；修复 `campaignVerdict` 覆盖角色成功优先。契约 +1。
- **L2 恢复**：两专项经审批 #38/#39/#42 重升 autonomy=2（pause→request→approve 状态机全链）；自动降级机制保留（供给归零/连败/预算低仍 L2→L1，升档须审批）。
- 验收：本地契约 625/625；csai 部署重启 accept PASS=80 FAIL=0；线上实测 L2 自动派生恢复（review_finding 存量复核 + vulnclass 假设 + param 覆盖多 kind 并进，billing 实时记录）。

### 2026-09-23 · 27 号补丁：供给误降速 + heavy 撞死不可用模型修复（本地契约 585/585，accept PASS=80）
- **排查结论**：① 专项降级 L1 的直接原因是「连败速率≥2/h」——campaign#1/#2 各 2 条 rejected，其中路径性失败仅 1 条（#100496 资产枚举 worker 撞 `INVALID_REQUEST: reasoning_content must be passed back`），其余为目标面 N/A（无认证功能点/泛解析 CDN），机制按设计工作；② 「套餐没满却反复 throttle」是 DSH 误降速——`main_daily_low` 只看可用主力余量，主力熔断后 deepseek 435/500（13%<15%）被分母丢弃；③ 「v4.1-flash 零调用」是 Bellkeeper 坏路由——sensenova 渠道的 v4.1-flash/glm-5.2/glm-5.1 已退出当前 token 套餐（上游 403/404 实测）但渠道/池成员未摘除，渠道 12 连败熔断 + heavy 组首档撞死。
- **修复**（三层）：DSH `decideThrottle` 余量预警改全体主力跨渠道最差值；`selectCampaignModel` heavy 与 std 同主力链 + fallback 顺延（glm-5.2 退出默认链，.env `SEC_CAMPAIGN_MODEL_MAIN_FALLBACK=deepseek-v4.1-flash,deepseek-v4-flash`）；Bellkeeper 经 DB API 收窄 sensenova 渠道 models（[flash-lite, v4-flash]）+ 摘除 pool-secagent/-heavy 死成员（种子 YAML 同步）——渠道熔断解除 closed、三池冒烟 200、DSH 徽章 normal(factor=1.0)。
- **验收**：本地契约 585/585；csai rsync+setup+重启（NRestarts=0）accept PASS=80 FAIL=0；线上供给 checkpoint 连续 restored、无新 throttle。
- **遗留（人工项）**：两专项仍 autonomy=1（降级不自动回升，需人工 review 后走 campaign-autonomy 审批重升 L2）；sensenova 套餐若恢复 v4.1-flash/glm-5.2 需把渠道 models 与 heavy 组首档加回。文档回填 [05-task §7.12](05-task.md)。

### 2026-09-23 · 26 号补丁：dsh-bill 成本归因（spent_tokens 恒 0 修复）+ 存量复核入专项（本地契约 585/585，accept PASS=80）
- **成本归因**：task 域内置 dsh-bill `records.jsonl` 增量解析（字节偏移游标落盘 `dsh-bill-sum.json`，截断归零重扫、半行留待、map 截顶防膨胀）；`task_finish` 在 worker 未上报时按 `session_id` 归因实耗（in+out+cacheWrite，cacheRead 不计；无记录保持 NULL），`task_runs` 增 `spent_tokens` 列同口径。专项预算闸（`campaignUsage` 聚合 tasks.spent_tokens）自此按真实消耗——昨夜「已用 0/500000 却 budget_low 停派」的预估误报类消除（checkpoint #1/#2 实证）。
- **存量复核入专项（review_finding）**：`ledger_coverage_gaps` 新增 `review` 维（status=new 且超龄 48h 的 finding 逐条出列，`SEC_LEDGER_REVIEW_STALE_MS` 可调，priority 35，严重度加权 value，triage 后自然出列闭环）；`compileCampaignPlan` review 维 → kind=review_finding（finding id 进 host 槽、+3 提权、计入多样性保底、lite 档）；`task_derive_intent` objective 模板「[存量复核] finding #N」（confirm 需机器 oracle/proof capsule，证据不足 vuln_reject/false_positive 写 reason）；**scope 复查豁免**——finding id 非主机名，`intentSituation`/`campaignSituationOk` 跳过主机归属校验（program 级 INV-C1 授权/过期校验不豁免）；`vuln_list` actor 补 reactor；`isCoverageRole` 认 `[存量复核]`。
- **验收**：本地契约 585/585（task +2：bill 归因续扫/豁免派生；ledger +1：review 维出列；rules +1：草稿 host=finding id）；csai 部署（rsync + `bundle dsh setup` + 重启 NRestarts=0）+ accept **PASS=80 FAIL=0**。线上实测：专项 tick 正常，campaign#1（美团SRC）pending drafts 已出 2 条 review_finding（finding #672/#405，lite 档）——线上 589 条 status=new（其中 340 条超龄 48h）进入专项消化通道；当前两专项均 autonomy=1（连败降级，合法机制），草稿待人工一键放行或复核后重升 L2。
- 文档回填：[05-task §7.11](05-task.md)、[11-ledger §1.4.9](11-ledger.md)。

### 2026-09-23 · 25 号补丁：资产收集入专项（asset_enum）+ 任务弹框加宽（本地契约 581/581）
- **巡检发现**（昨晚至今运行态）：专项 tick 正常（60s，2 专项）；「宿主重启/超时回收」批量失败全部为夜间部署重启所致（systemd sudo restart 留痕，非崩溃）；供给哨兵实际触发 3 轮 throttle→restore + 1 次观测失败 fail-open；`budget_low` checkpoint 系预估口径（30k/草稿 × 批大小）触发的预警非真超支。
- **资产收集入专项**：`ledger_coverage_gaps` 新增 `asset` 维（按根域聚合，`enum_fresh` 记账超窗 `SEC_LEDGER_ASSET_STALE_MS` 默认 3 天重开缺口，mark=enum_stale，priority 45）；`compileCampaignPlan` 映射 kind=asset_enum（lite 档，enum_stale +2、前置提权 +3 保证进 top-cap）；`task_derive_intent` kind 枚举 + objective 模板（subfinder/dnsx/httpx → asset_upsert_bulk → enum_fresh 闭环记账）；`gatherPlanInputs` 分维拉取 +asset；`isCoverageRole` 认 `[资产缺口]`。闭环依赖：`asset_list` limit 上限 500（曾误传 5000 被 schema 拒，已修）。契约：ledger +1（asset 维出缺口/闭环）、task +1（tick 派 asset_enum lite 子任务）、rules +1（提权进 top-cap）。
- **任务弹框加宽**：`@silksec/ui-task` Modal 新增 `.silksec-task-dialog{width:min(1120px,94vw)}`（宿主默认 fit-content 过窄），弹框体 70vh→76vh；ui-task 单测 20/20。
- 验收：本地契约 581/581；csai `bundle dsh setup` + accept PASS=80 FAIL=0。

### 2026-09-23 · 24 号方案落地：任务/知识/学习工作流可视化 + 专项运行报告（accept PASS=80）
- **RPC 三透传**（`dashboard-rpc.js`，纯透传不改域语义）：`campaignProgress`→`task.campaign_progress`、`campaignPendingDrafts`→`task.campaign_pending_drafts`、`campaignDispatch`→`task.campaign_dispatch`（actor=dashboard，过预算/供给闸）。
- **任务视图重构（`@silksec/ui-task`）**：布局重排为 专项→定时→队列→历史→工作区；专项卡片点击语义反转=**展开运行报告抽屉**（三并发 `campaignGet`+`Progress`+`PendingDrafts`：推进投影/检查点时间线/待放行草稿一键放行/活跃子任务+验收账本；手动 tick 摘要不再丢弃——W7），过滤队列改独立 ⌗ 按钮；队列增状态 tab（全部/运行中/排队/阻塞 计数过滤）；历史增成功/失败过滤并提到工作区之前。
- **知识/学习状态条（`view-know`）**：知识 tab 顶部治理漏斗 `候选→生效→冷却→归档`（`memcore.tables` 聚合）；学习 tab 五问之上学习流水线 `观测→记分→发布→撤回`（`learningOverview`）——零新 RPC。
- **22 号遗留补齐**：L1 待放行队列一键 `campaign_dispatch` 放行 UI（原「未接」）。
- 验收：ui-task 单测 **19/19**、view-know **10/10**、dashboard-rpc **5/5**；csai `bundle dsh setup` + 重启 NRestarts=0；`sec-v5-accept.sh --ui-headless` **PASS=80 FAIL=0**（72→80：4 静态门禁 + 4 运行时读端点）。详见 [16-dashboard §2026-09-23](16-dashboard.md)、[05-task §7.10.5](05-task.md)；方案归档 [archive/24-ops-audit-ui-flow-2026-09-23.md](archive/24-ops-audit-ui-flow-2026-09-23.md)、[archive/23-llm-supply-throttle-2026-09-23.md](archive/23-llm-supply-throttle-2026-09-23.md)。

### 2026-09-23 · 23 号方案落地：LLM 供给联动调速 + 任务级选模型（本地契约 575/575）
- **供给哨兵 LlmSupplyWatch（task 域内）**：tick 顺带读 Bellkeeper `groups/status`（成员权重/健康）× `channels/status`（rpd 桶余量），规则层 `decideThrottle` 纯函数算 `supply_factor ∈ {0, 0.4, 1.0}`；`dispatchDrafts` 有效上限 = `ceil(derive_cap × factor)`（观测失败再 `min(cap,2)`），factor=0 时 tick 跳过派生、显式路径报 `E_CAMPAIGN_LLM_EXHAUSTED`（dashboard 放行）。供给归零 L2→L1（不回弹，防震荡）。
- **INV-C11/C12**：派生前供给闸 + 观测失败两阶段（先 fail-open 有界降速，连续 3 tick 转 fail-closed）；checkpoint 新增 `llm_throttled`/`llm_restored`/`llm_probe_failed`/`budget_extend_request`。
- **统一额度面（§3.6）**：`parseCampaignSupplyEnv` 集中解析 dsh `.env` 区块（成员表/权重门槛/降速比例/probe/derive_cap 8/预估 30k/默认预算 2M/模型策略）；无凭据时供给闸自动禁用（不触网）。
- **任务级选模型（§3.7）**：`classifyTaskClass`（lite/std/heavy）+ `selectCampaignModel`（lite→flash-lite / heavy→glm-5.2→Go v4.1 / std→主力）；派生草稿/子任务带 `task_class`（Path B 元数据），`selector=dsh` 时带 `model_hint`（Path A）。
- **预算自动爬坡（步骤 1.5）**：Supervisor 窗口用量达 80% 自动提请 `campaign-budget-extend`（+budget，12h checkpoint 防抖）。
- **看板**：专项卡片增供给三态徽章（正常绿/降速黄/停派红/观测异常黄）。
- 验收：本地全量契约 **575/575**（rules +12、task +8）、ui-task 单测 14/14；已部署 csai（`bundle dsh setup` + 重启 NRestarts=0 + `sec-v5-accept.sh --ui-headless` **PASS=72 FAIL=0**）；线上实测 `campaign_tick` 返回 `supply_factor=1`、正常派生，.env 统一额度面区块已落位。详见 [05-task §7.10](05-task.md)、[16-dashboard](16-dashboard.md)。
- **第二轮（步骤 0.5/2.5/4/5 收口，2026-09-23）**：Bellkeeper sensenova 加 `deepseek-v4.1-flash`（权重 7，池权重序列重排）并新建 `pool-secagent-lite`/`pool-secagent-heavy` 分档组（token `allowed_groups` 放行，DB API + YAML 种子）；dsh `SEC_CAMPAIGN_CLASS_GROUPS` 按 task_class 映射组名 + Path A 落 `provider/model`（worker model-patch）——线上实测 lite→flash-lite、heavy→glm-5.2、worker 收到 `{provider:bellkeeper,model:pool-secagent-heavy}`；kimi-code 评估结论暂不入池（编码专用 + 窗口不可预测）。详见 [05-task §7.10.5](05-task.md)、[23 §五.6](archive/23-llm-supply-throttle-2026-09-23.md)。

### 2026-09-23 · Campaign 运行期卡点修复（P0–P2）+ 运营复跑
- **P0-1 去重锁死**：Planner 现跳过已尝试策略并前进到新缺口（`strategy_dedupe` 增 `reopen_after`）——修复「首轮后空转 7h」。
- **P0-2 infra 误判**：宿主重启/超时回收的 failed 改判 `escalated`（不计 strategy 连败/不触发 fail-rate 降级）；#2 误降级后已重升 L2。
- **P1**：rework → 策略按 6h 冷却重开（`SEC_CAMPAIGN_REWORK_REOPEN_HOURS`）；rejected → 连败 +1；任务增 `strategy_key` 列。
- **P2**：覆盖缺口按维度分查 + Planner 维度多样性（保证覆盖类入选）；覆盖率开始推进（已派 crawl 任务）。
- 本地全量契约 **563/563**；csai 部署复跑：campaign#1 27 条（running/queued 持续）、campaign#2 15 条，均在派生-执行-验收闭环中。详见 [05-task §7.9](05-task.md)。

### 2026-09-22 · Campaign 运营迁移（美团/字节 SRC）+ 两处运行期缺陷修复
- **运营动作**：将 `meituan-src`/`bytedance` 的挖掘主线 interval 任务迁移到 Campaign——暂停（blocked，可恢复）vuln/vuln-deep 共 4 个（#19/#37/#100007/#100008），保留 recon #16/#17 与周复盘 #24；两个专项经 `campaign-autonomy` 审批（#25/#26、修正 cap 后 #27/#28）升 **L2 有界自动**（`derive_cap_per_tick=3` 以匹配 500k 预算），已自动派生并执行子任务。
- **运行期缺陷修复 1（ledger `safeQuery`）**：列表类跨域查询经总线在信封顶层返回 `rows`，`safeQuery` 只读 `r.data` → `coverage_metrics`/`coverage_gaps`/`login_blindspot` 对 asset/endpoint 数据全盲、缺口恒空（Campaign L2 Planner 无输入）。归一两种形态 + 补 `asset_list`/`endpoint_list`/`cred_query` 的 reactor 只读 actor；回归新增 1 例。
- **运行期缺陷修复 2（Campaign 子任务可执行性）**：调度器只认领 `schedule_kind IS NOT NULL` 的任务，`task_derive_intent` 对 campaign 子任务改以 `once` 入队，否则 L2 派生任务永不执行；21 号无主草稿仍保持 NULL。
- 本地全量契约 **558/558**；csai 部署重启后 accept 面照常；详见 [05-task §7.8](05-task.md)、[11-ledger](11-ledger.md)、[03/04/08](03-asset.md)。

### 2026-09-22 · 专项 tab 移除（并入任务视图）+ 部署链路修复
- **部署缺失修复**：方案 A（7cafbf6）改动漏了红线流程的 `rsync bundles/dsh/ → /opt/SilkSpool/bundles/dsh/` 一步——`spool bundle` 读运行时副本，导致当天部署装的仍是 9-19 旧模板。已补 rsync + setup + 重启验收。
- **安全中心「专项」tab 移除**（用户决策：专项是任务的一种，不独占 tab）：删除 `dsh-plugin-sec-dashboard.view-campaign.client.js`/test.mjs，manifest / `sec-dashboard-plugin-setup.sh`（VIEW_DOMAINS 7 域）/ `sec-v5-accept.sh`（UI_PKG_IDS 13 面）/ `dsh-ui-surface-smoke.mjs` 同步清理；线上 `plugin --profile web remove @silksec/sec-dashboard-view-campaign` + 孤儿目录清理。campaign 相关 4 个 dashboard-rpc **保留**（ui-task 右侧栏专项区块复用）。
- 验收：组合树无 campaign loader entry；`sec-v5-accept.sh --ui-headless` **PASS=72 FAIL=0**（75→72 = 移除 3 项 campaign 视图检查）；ui-task 单测 14/14。

### 2026-09-22 · 23 号方案 v2 修订：OpenCode Go v4.1-flash 入池 + 统一额度面 + 额度调高
- **Bellkeeper 池调整（已上线）**：`opencode-go-secagent` 渠道加入 `deepseek-v4.1-flash`（1M ctx），pool-secagent 新增权重 2 成员（介于官方 deepseek 与 v4 兜底之间）；渠道状态/直调冒烟/pool-secagent 组冒烟全部通过。
- **关键发现**：Bellkeeper 渠道/池成员为 **DB 持久化**（`llm_channels`/`llm_model_groups`），YAML 仅首启空库种子——变更须走 `PUT /api/llm/config/{channels,groups}/:id`（自动 reload）；本次即走 DB API 路径，YAML 种子同步（Bellkeeper commit cb0572d）。此事实已回填 23 号方案 §2.1 备注。
- **23 号方案 v2 修订**（[23-llm-supply-throttle.md](archive/23-llm-supply-throttle-2026-09-23.md)）：补 SenseNova 双积分池实测口径（通用池/Flash-Lite 专属池各 60k/滚动 5h + 600k/滚动周，flash-lite 消费 1:1 返赠通用积分；滚动窗口非定点清零——不做窗口对齐猜测）；新增 §3.6 **统一额度面**——全部调速参数集中 dsh .env 单一区块（成员表/权重门槛/降速比例/derive_cap 5→8/新建专项默认预算 500k→2M）；存量专项预算调整尊重 budget_extend 既有铁律（spent≥80% 才准延长），配套设计 Supervisor budget_low 自动提请爬坡（步骤 1.5）。

### 2026-09-22 · 两个 SRC 专项上线（L0）+ 23 号方案设计：LLM 供给联动调速（仅设计）
- 经 sec-bus-cli 创建并激活：`#1 美团SRC 持续挖掘`（meituan-src）、`#2 字节SRC 持续挖掘`（bytedance）——均 L0 台账模式、500k tokens/7d 窗口、stop_conditions 三条，验证命令面与 INV-C1 授权校验在线上生效。
- 针对「专项常驻跑 × pool-secagent 成员套餐额度窗口（kimi-code ~5h/7d、deepseek-secagent 500rpd）」产出 [23-llm-supply-throttle.md](archive/23-llm-supply-throttle-2026-09-23.md)：LlmSupplyWatch 读 Bellkeeper 既有 `/api/llm/health`+`channels/status`（零改造），规则层 `decideThrottle` 三档供给因子（1.0/0.4/0）叠加成第三道派生闸；额度熔断 → L2 自动降 L1（不回弹，防震荡），恢复人工确认；探测失败先降速后停派（INV-C11/C12）；看板专项卡片加供给徽章。README 已登记为在办专项。

### 2026-09-22 · 22 号方案方案 A：专项并入任务视图（ui-task 五区块）
- 任务右侧栏 tab 顶部新增「专项」区块：Campaign 卡片（状态/自主级别/验收计数/预算/心跳 + 立即 tick，走既有 `campaigns`/`campaignTickNow` RPC）；点击卡片按 `campaign_id` 过滤一次性队列（`task_list` 增 `campaign_id` 过滤参数 + dashboard-rpc `tasks` 透传）；队列行带「专项 <名称>」归属 chip（点击即过滤、可一键清除）；campaigns 查询不可达时区块静默隐藏（降级链）。安全中心「专项」tab 保留（cross 全局视角）。
- 顺带修复 HEAD 既有 bug：`pillNode` 只读 `props.children`，调用方按第二参传 label 导致**真实渲染下徽章文字静默丢失**（定时卡片 phase/下次运行徽章空白）——假 React 测试环境掩盖了该缺陷，已改签名并补注释。
- 验收：UI 单测 14/14（新增专项区块 3 例），全量 client 套件 126/127（唯一失败仍为 HEAD 既有 dashboard-rpc stats 断言，git stash 复测确认无关）；task 域契约 60/60（csai 环境实跑）；csai 已部署重启（active、NRestarts=0），`sec-v5-accept.sh --ui-headless` PASS=75 FAIL=0。

### 2026-09-22 · 22 号方案关账归档（N1–N3 记入待办）
- 二次评审通过验收；N1（`allowed_phases`/phase 标签未贯通）、N2（submit 角色验收判据未实装）、N3（finding id 文本解析可拼接）记入 [05-task §7.7](05-task.md) 待办（Phase C），不阻塞。
- 按治理规则归档：`22-campaign-task.md` → [archive/22-campaign-task-2026-09-22.md](archive/22-campaign-task-2026-09-22.md)（内部相对链接已改 `../`，README 索引与各模块「设计真相源」引用同步改指 archive）。纯文档改动。

### 2026-09-22 · 22 号方案 Campaign 评审修复（B1–B7 / S1–S4，契约 557/557）
- **B1（高）**：`schedulerTick` 忙碌路径补 `campaignTick()`——此前仅空转 tick 执行，有任务认领时统筹闭环整体停摆（含 INV-C9 停止条件）。
- **B2（高）**：Reviewer 判据由「done 即 accepted」改为三源真实判据（oracle verdict / capsule 引用 / `vuln_get` finding 复核）+ 覆盖角色成功判定；hypothesis 无 verdict 无推进判 rework。证据 `capsule:`/`oracle:` 优先。
- **B3（高）**：`campaign_autonomy_apply`/`campaign_budget_extend` natural 幂等键纳入 `approval_id`（二度批准/二次延长不再被幂等窗吞）。
- **B4**：campaign 两 kind validate 对 task 域不可达由放行改 `E_INTERNAL` 阻塞（fail-closed）。
- **B5**：回填改为「异步订阅 + tick 补验双通道」（与实现一致）。
- **B6**：`task_block`/`task_cancel` actor 补 `reactor`；Supervisor/归档级联不再冒记 dashboard 人工动作。
- **B7**：删死代码；预估改 `SEC_CAMPAIGN_ESTIMATE_TOKENS_PER_DRAFT`；新增 checkpoint kind `learn_gap`；LearnLink surface 带 vuln_class；`campaign_tick` actor 收敛 scheduler。
- **S1**：设计统一「L1 免审批、L2 强制审批」（22 号文档 §7.1/§8.1 修订）。**S2**：`sanitizeDraft` 收敛草稿字段（优先级由 derive_intent 固定）。**S3**：证据来源接线（覆盖推进以角色判定，无格点差分）。**S4**：`last_tick_at` 升序准轮转。
- 回归：新增「忙碌 tick 也跑 campaign_tick」「二度批准/二次预算延长生效」「campaign kind 不可达 fail-closed」等契约；本地全量 **557/557**；详见 [05-task §7.8](05-task.md)。

### 2026-09-22 · 22 号方案 Campaign（专项）全量落地（本地契约 553/553 + UI 单测；待部署验收）
- **task 域内新增常驻统筹实体 Campaign**（不新增域）：`campaigns`/`campaign_decisions`/`campaign_checkpoints` 三表 + `tasks.campaign_id/campaign_role` 幂等加列；命令 C20–C27 + 内部（record_decision/checkpoint/tick/autonomy_apply/budget_extend）；查询 5 个（list/get/progress/pending_drafts/decisions）；事件 6 个；订阅 `task.finished`→Reviewer 强联动、`scope.revoked`/`scope.rules.changed`→Supervisor pause（fail-closed）；调度器单例在 claim 后顺带 `campaign_tick`（Supervisor→Reviewer→Planner→Dispatcher）。自主级别 L0/L1/L2 封顶，升档走 approval。
- **规则层** `compileCampaignPlan` 纯函数（确定性可重放，缺口优先级×连败降权×经验卡提权×有界 cap）。
- **合规结构性保证**：派生唯一通道复用 `task_derive_intent`/`task_create`（局面编译/scope/per-program 预算闸零绕过）+ Campaign 窗口预算闸双层取严；INV-C1–C10。
- **跨域**：approval 新增 `campaign-autonomy`/`campaign-budget-extend` 两 kind（`approval_request` actor 增 dashboard/human）；know `learning_episodes.campaign_id` 加列 + `know_episode_list` campaign 过滤。
- **看板**：安全中心新增「专项」tab（`@silksec/sec-dashboard-view-campaign`，order 60）+ RPC `campaigns/campaignGet/campaignDecisions/campaignTickNow`；UI_PKG 14 面。
- **总线修复**：嵌套事务分支补 `scope.inTxn`（三层嵌套 campaign_dispatch→derive_intent→create 自锁死修复）。
- 验收：本地契约 **553/553**（task 58 / rules / approval / know 等）、专项视图单测 8/8。**未部署**（待 `spool bundle dsh setup` + `sec-v5-accept.sh`）。
- 未实现（Phase C 待办）：know_scores 按 campaign 分组投影；Planner LLM 探索性草稿；L1 放行队列一键 dispatch UI。
- 注意：设计文档 C24 `campaign_goal_update` 因总线 R2 禁用词「update」实现为 `campaign_goal_revise`。

### 2026-09-22 · 22 号专项设计：项目型常驻任务（Campaign）——仅设计文档，未实施
- 针对「定时任务对 SRC 挖掘太死板」的痛点，产出 [archive/22-campaign-task-2026-09-22.md](archive/22-campaign-task-2026-09-22.md)：在 **task 域内**新增常驻统筹实体 Campaign（专项，绑定单/多 Program），以派生→下发→监督→验收闭环驱动现有 Task 子任务；不新增域，拆六个原子组件（Core/Planner/Dispatcher/Supervisor/Reviewer/LearnLink），派生唯一通道复用 `task_derive_intent`（局面编译/scope/预算闸零绕过），自主级别封顶 L2（approval 新增 `campaign-autonomy`/`campaign-budget-extend` 两个 kind）；知识/学习联动走 know 域既有机制的维度扩展（episode/记分加 campaign_id，缺口回灌复用 `know_gap_record`）；含数据模型、状态机、INV-C1–C10、命令/查询/事件、分 Phase A/B/C 实施与契约测试矩阵。README 索引已登记为在办专项。

### 2026-09-22 · 20 号全面检查报告归档（补回填收尾）
- 归档审查发现第四轮修复三处**代码已上线但文档漏回填**，本次补齐：08-scope v5.1（授权时效 `expires_at`/`reviewed_at` 全套——`scope_grant`/`scope_rules_apply` 参数、§1.4.1 算法步 4 过期 fail-closed、新查询 §1.4.5 `scope_expiring`、yml 字段、不变量 I9）；05-task C18 `task_submission_backlog`（命令总表 + 详述）；16-dashboard §1.4（主面板 30 天临期警示行 + 设置页授权时效徽章三态）。
- 21 号方案回填完整性逐项 grep 复核通过（`task_derive_intent`→05、`know_distill_verdict`→07、`vuln_capsule_replay`/`vuln_evidence_flags`→02、`eval_discovery_metrics`→15、`exec_flow_triage`/`exec_vision_triage`→10、覆盖账本/登录态判定→11/04，均与代码动词/actor/错误码一致）。
- 20 号报告补 §11.8 归档记录后移入 [archive/](archive/)；README 索引与本文引用同步改指 archive。纯文档改动，无线上操作。

### 2026-09-22 · 21 号方案 Phase 1/3/4 全量落地（契约本地全绿 + csai 已部署验收 PASS=72）
- **Phase 1（假设引擎 + 第二发现面）**：规则层补 `routeFlowsSignal`（flows 信号确定性打分）/`visionTriageRubric`/`decontextualize`/`distillEpisode`；exec 域 `exec_flow_triage` 查询 + `exec_vision_triage` 命令（判读特征→隐藏功能点线索→H1 草稿）；`exec_grep_result/page_result` 附不可信围栏纪律 + 注入特征标注（§1-5）；eval 契约种子 +2 注入用例；新规则种子 `techniques/miniapp-capture-sop.md`（§1-4，79→80）。
- **Phase 3（推进层）**：task 域 `task_derive_intent`（reactor 内部通道：H1/H2/H3 假设草稿，queued 绝不自动执行，H3 必须引用卡片过局面编译否则 E_TASK_H3_REJECTED）；`strategy_dedupe` 表（strategy_key 幂等去重 + 连败 3 次黑名单）；任务预算闸（§3-4：per-program 周期 token/任务数预算，超限 E_TASK_BUDGET_EXHAUSTED 停派，dashboard 人工放行）；订阅链 endpoint.registered→H2 派生、ledger.coverage.marked 缺口态→crawl/param_enrich 草稿、vuln.signal.rejected→连败回写。
- **Phase 4（Feedback Core）**：know 域蒸馏 reactor（§4-1：oracle capsule confirmed 合流 onVulnVerdict → `know_distill_verdict` → 去特化经验卡候选进 L2 治理链，artifact_id 聚合幂等，初始 low 置信）；记分双裁判（§4-2：`vuln.signal.submitted` vendor_status 事件化——accepted=终极正例 episode、驳回=负例；wins/fails 经 know_scores 重放）；缺口 reactor（§4-3：覆盖缺口态 → know_gaps）；vuln 域 `vuln_capsule_replay`（§4-4：exec 守卫链重放 + 证据比对 match→harden 产 worker 脚本草稿，注册 manifest 唯一通道=人工审批）+ `vuln_evidence_flags` 查询；eval 域 `eval_discovery_metrics`（§4-5 三指标：候选→verified 转化率 / verified 高危占比 / 新漏洞类型）。
- **部署修复**：bundle manifest 补 sec-rules-hypothesis 三件套与 miniapp SOP 种子（Phase 0/2 的 setup 推送缺口——首次部署即发现并已修）。
- 验收：本地契约 rules 27 / task 47 / vuln 61 / know 77 / exec 30 / eval 30 全绿；csai `spool bundle dsh setup` 全量契约门槛通过 + 重启 NRestarts=0 + 14 域注册；`sec-v5-accept.sh --ui-headless` **PASS=72 FAIL=0**。
- 文档回填：05-task（§六 Intent/预算闸/订阅）、07-know（§十三 Feedback Core）、10-exec（§八 第二发现面/注入防护）、02-vuln（§八 打法固化）、15-eval（§九 三指标）、16-dashboard（§九 覆盖/盲区/记分投影）；方案文档归档 [archive/21-benchmark-strikeagent-flash-2026-09-21.md](archive/21-benchmark-strikeagent-flash-2026-09-21.md)。
- 未完成的运营动作（非代码）：0-1 端点爆发/0-2 参数补全线上跑批（需选部署窗口执行，尊重 QPS/risk）；登录凭据登记（cred_add 人工动作）。

### 2026-09-22 · 21 号方案 Phase 0 第一批：规则层 + 登录态判定 + 业务语义 + 覆盖账本 + 硬降级 + 成本归因（本地契约 511/511）

### 2026-09-22 · 21 号方案 Phase 2：机器验证 oracle + proof capsule + confirm 证据门（契约 517/517）
- exec 域：`exec_oracle_judge` 查询——oracle 五件套（unauthz_diff/idor_diff/info_disclosure_diff/sqli_diff/sqli_time/xss_echo/ssrf_oob）纯函数路由，输入对照特征输出 verdict，**模型无权宣布 verified**（§2-1）。
- vuln 域：`vuln_oracle_capsule` 动词——proof capsule（oracle verdict + 请求对 + 判定输入 + 环境指纹 + 重放命令）落盘 evidence/oracle-capsules/{id}.json（原子写，digest 自洽，§2-2）；`vuln_confirm` 增 oracleCapsuleGate 不变量：`capsule:{id}` 证据须 digest 自洽 + verdict=verified + host 与 finding 一致（E_VULN_ORACLE_NOT_VERIFIED / E_VULN_ORACLE_TARGET_MISMATCH）。
- 契约新增 6 例（capsule 三门 + oracle_judge 路由 + eval 例适配硬降级）；全部 517/517 全绿。
- 依据 [archive/21-benchmark-strikeagent-flash-2026-09-21.md](archive/21-benchmark-strikeagent-flash-2026-09-21.md) §八 Phase 0（0-3/0-4/0-5/0-6/0-7/0-8）执行；0-1/0-2（端点爆发/参数补全的线上跑批）为运营动作待部署后进行。
- 新规则层 `@silksec/sec-rules-hypothesis`（纯函数，零依赖）：登录态判定 classifyAuthState（§5.1）、业务语义建议 businessSemanticsSuggest（§5.2）、评级硬降级 enforceSeverityCap（§0-6）、污点路由 taintRoute + H1 保底 h1Hypotheses（§6.1）、oracle 五件套（§2-1）、注入防护 fenceUntrusted（§1-5）、局面编译 compileSituation（§3-2）；契约 23 例全绿；sec-rules-hypothesis-setup.sh 接入部署链。
- endpoint 域：endpoints 表 ensureCol 列演进（auth_state/auth_state_evidence/should_auth/should_auth_source/should_auth_at）；新动词 endpoint_classify_auth（0-3）+ endpoint_annotate_semantics（0-5，人工裁定 > 自动建议、model 显式标注必带 note）；endpoint.registered 订阅自动建议；endpoint_list 增 auth_state/should_auth 过滤；新查询 endpoint_auth_summary（登录态分布/标注率）。
- ledger 域：覆盖账本 MVP（0-4）——coverage-ledger.jsonl 四维格点记账（crawl/param/vulnclass/auth，ledger_coverage_mark）+ 派生查询 ledger_coverage_metrics（四指标）/ ledger_coverage_gaps（缺口队列，strategy_key 排序）/ ledger_login_blindspot（登录盲区摘要 + cred_add 行动项）；空转升圈（§3-3）ledger_rotation_tick/rotation_status（3 空轮一圈、3 圈允许 stall）；三个 reactor 订阅自动记账（endpoint.registered/auth_classified/vuln.signal.confirmed）。
- vuln 域：0-6 评级硬降级（signalComplete 不变量 E_VULN_SEVERITY_CAPPED：信息泄露/中间件暴露 ≤ low、XSS 类未证明执行 ≤ medium）；vuln.signal.confirmed 事件补 host/program_id（账本记账数据源）。
- task 域：0-8 成本归因（INV-T14 落地）——task_finish 收 spent_tokens 回填 tasks.spent_tokens、超 budget_tokens 记 [预算超支] 并入 task.finished payload。
- 本地测试基线：`sec-contract-test-local.sh`（仓库内契约组装器，等价部署态目录结构）——全部 15 插件契约 511/511 全绿（基线 472 + 新增 39）。
- 文档回填：04-endpoint（§5.1/§5.2 动词+列+查询）、11-ledger（覆盖账本/缺口队列/盲区/升圈）、05-task（INV-T14 落地+spent_tokens 参数）、02-vuln（E_VULN_SEVERITY_CAPPED）。
- 部署：2026-09-22 已随 Phase 1/3/4 一并部署 csai（setup 契约门槛通过，accept PASS=72）。

### 2026-09-19 · Bug 修复：会话头「安全产出」图标点击无反应（csai 已部署验收）
- 现象：右上角列表图标（本会话安全产出计数，checklist 图标）显示计数但点击无反应；右下角审批胶囊显示 0（0 待审批为正常）。
- 根因：`conversation.session.header.utilities` 条目的 owner props 为空（官方 `ConversationHeaderActionOwnerProps = { children?: never }`，运行时 `renderSlot(..., {})`），条目不继承 header 的 inject 面，`props.selectView` 恒为 undefined；降级分支 `secUiBus.emit('open:security-view')` **无任何订阅者** → 点击静默无效。
- 修复：新增常驻 `shell.overlay` Modal 宿主 `SecurityViewModalHost` 订阅 `open:security-view`，selectView 缺席时打开本会话安全产出 Modal；`openSecurityView` 返回值由 `'none'` 改 `'modal'`。
- 验收：本地 UI 单测 114/114；csai 部署后 `sec-v5-accept.sh` PASS=41 FAIL=0。

### 2026-09-19 · 第四轮修复：M1 幂等竞态 + 授权时效 + 批量提交 + external_id + 文档收尾（csai 已部署验收）
- 依据 [archive/20-full-inspection-2026-09-19.md](archive/20-full-inspection-2026-09-19.md) §十一.6 执行剩余全部建议项。
- M1：事务内幂等复检，并发同 key 返回 replay 而非 E_CONFLICT。
- 授权时效：scope.yml 增 `expires_at`/`reviewed_at`；过期 fail-closed（scope_check/exec/asset 三处一致）；`scope_expiring` 查询 + 看板过期/临期告警 + 设置页徽章。
- 批量提交：`task_submission_backlog` 为历史 confirmed 未提交幂等补建提交任务（线上补建 42 条，queued 不自动起 worker，待人工 task_run_now）。
- external_id：findings 增列 + 索引，跨源（cyberstrikeai/vuln-pipeline/外部）去重优先键。
- 文档：17-llm-surface 查询可见口径、15-eval C4 详述节、ui-surface-deps 陈旧条目清理。
- 验收：本地契约 **483 例** + UI 114 全绿；csai 部署后 `sec-v5-accept.sh` PASS=41 FAIL=0。
- 全部检查建议项已闭环；仅余需人工判定（重复发现合并）或设计变更（凭据环境变量化）的项，见报告 §11.7。

### 2026-09-19 · 第三轮修复：代码中危 + 供应链 + 数据卫生 + a11y（csai 已部署验收）
- 依据 [archive/20-full-inspection-2026-09-19.md](archive/20-full-inspection-2026-09-19.md) §十一.5 执行第三轮修复。
- 安全：沙箱不再整目录挂载 `$HOME`（M6，原暴露 `.ssh`/`fofa.conf`/浏览器登录态）；tools-manager 下载 sha256 校验（M8）。
- 代码：证据发布稳定窗整批化（M5）；approval 增 `effect_state` 独立列消除 `approved_effect_failed` 死逻辑（M9）。
- UI：审批/任务首帧骨架屏（B10）、面板降级提示（B11）、大队列单套 DOM（B12）、审计展开态稳定键（B13）、全表 a11y（aria-sort/role/aria-expanded/aria-pressed/aria-selected/aria-label）。
- 数据：新增 `data-hygiene.py`（program_id 唯一命中回填 / source 归一 / fgs 孤儿清理 / 重复发现报告，默认 dry-run）；候选去重返回 `dedup_reason`。
- 文档：09-approval（effect_state）、10-exec（沙箱隔离）回填。
- 验收：本地契约 466 例 + UI 114 全绿；csai 部署后 `sec-v5-accept.sh` PASS=41 FAIL=0。
- 未处理：存量 43 条 confirmed 批量提交任务、`data-hygiene --apply` 线上执行、授权时效字段、`external_id` 跨源去重、17/15/ui-surface-deps 回填、M1（幂等预检入事务）与 L 类卫生项。

### 2026-09-19 · 产出闭环 + 数据治理 + 任务回收 + DLQ 加固（csai 已部署验收）
- 依据 [archive/20-full-inspection-2026-09-19.md](archive/20-full-inspection-2026-09-19.md) §十一.4 建议执行第二轮修复。
- 产出闭环：`vuln_submit` 增 `remote_id`；新查询 `vuln_submission_queue`（confirmed 未提交，带 age_days/overdue）；`vuln_stats.signal.confirmed_unsubmitted`；看板 KPI 增「待提交 SRC」六卡；task 域订阅 `vuln.signal.confirmed` 幂等入队 `[提交] finding #id` 任务（phase=review）。
- 数据治理：新命令 `vuln_expire_candidates` + 每 6h 候选 TTL 治理（`noise=1 & status=new` 超 14d → ignored，`SEC_CANDIDATE_TTL_DAYS` 可调）；`vuln_dedup_check` 强制 host/vuln_type 至少其一；retention.sh 增 WAL checkpoint(TRUNCATE) + 0 字节残留库清理。
- 任务/事件：`task_reap` 回收范围扩至一次性任务（原只回收定时任务，僵尸 running 永久滞留）；`exec.run.completed` 订阅者按重试性逐条判定，确定性失败登记后丢弃，不再让整事件重试进 DLQ。
- UI/文档：授权设置工作区下拉与徽章同源（B6）；回填 02-vuln/05-task/16-dashboard。
- 验收：本地契约 **466 例全绿** + UI 114/114；csai `bundle dsh setup` 部署，`sec-v5-accept.sh` **PASS=41 FAIL=0**；线上 outbox **0 dead_letter / 0 pending**（3 条历史死信 + 1 条毒消息全部转 delivered）。
- 未处理（需策略决策）：存量 43 条 confirmed 批量提交、外键历史回填、授权时效字段、tools integrity、UI B8/B10–B13 与 a11y、17-llm-surface/15-eval/ui-surface-deps 回填。

### 2026-09-19 · 全面检查后修复：scope-guard 三处 fail-open + asset owner 列 + UI 健壮性（csai 已部署验收）
- 依据 [archive/20-full-inspection-2026-09-19.md](archive/20-full-inspection-2026-09-19.md) 执行第一批安全红线与 UI 高优先项修复，全部经契约/UI 测试与线上验收。
- 安全：exec 风险闸改逐目标判定（H1，跨项目不再放行）；exec `checkTarget` 改全项目先 exclude 再 scope（H2，与 scope 域同源）；asset scope 自查 program 缺失改 fail-closed `E_INVARIANT`（H3）；补 `resolve6`（M2）、`_file`/Burp 文件边界（M3）、grep 正则 ReDoS 限流（M4）；`vuln_dedup_check` 强制 host/vuln_type 至少其一（M10）。
- 功能：assets 补 `owner` 列（H4，线上已建列）；info 噪声回填改一次性迁移（M7）。
- UI：asset 视图 ui-core 缺席不再崩 bundle（B1）；同视图 KPI 跳链生效（B2）；报告/知识渲染防御（B3/B4）；报告阅读器竞态守卫（B5）；消除直接组件调用（B7）；补 `.silksec-btn-danger`（B9）。
- 文档：回填 S1/S3/S4/M1/M2/M4/M5/M6；更正初查 S2 误报（Phase 4 http-remote 实已实现）。
- 验收：本地契约 exec 26 / asset 31 / vuln 51 / bus 51 / task 38 / approval 19 / fact 23 / know 73 / ledger 22 / endpoint 25 / scope 15 + UI 114 全绿；`bundle dsh setup csai` 部署，`sec-v5-accept.sh` **PASS=41 FAIL=0**，`silksecagent` active、NRestarts=0。
- 未处理（需策略决策）：提交闭环、候选池治理、任务租约、DLQ 加固、外键回填、授权时效、其余 UI/代码卫生项（见报告 §十一.4）。

### 2026-09-19 · 19-ui-unify 看板 UI 全局统一（U1–U4 + 走查补丁，csai 验收通过，已归档）
- 依据 [archive/19-ui-unify.md](archive/19-ui-unify.md) 四相执行：U1 基样式表 → U2 面板 chrome+IA → U3 视图收敛 → U4 stats 聚合。
- 结果：csai `bundle dsh setup` + `restart silksecagent`（active、NRestarts=0）；`sec-v5-accept.sh --ui-headless` **PASS=72 FAIL=0**（含两条新门禁 + 13 面 headless health/RPC）；本地 UI 单测 **119 例全绿**。
- 变更：ui-core `ensureBaseStyles()` 基样式表（§2.2 十类，唯一 CSS 源）+ viewRegistry `group` 协议 minor + opIcon back/refresh/size + fmtNum + 表格统一单行省略等高；
  ui-panel 改名安全中心 / 五 KPI + 库存副条 / 「更多」二级导航（知识·学习·报告·审计 group=more）/ 去前置图标；
  视图内联 pill+cursor 收敛为 `.silksec-chip`；dashboard-rpc `stats` 改壳聚合、删 `assetDb.stats` 直查；
  `asset.overview` 增 `by_type`；`sec-v5-accept.sh` 新增 `ui-shared-css-unique`/`ui-class-defined` 门禁。
- 走查补丁（操作者反馈五条）：① 去侧栏/页头图标（同层级纯文字）；② 会话消息动作改 26×26 图标钮 + Tooltip；
  ③ 待审批/任务 KPI 无会话 seat 时经 secUiBus 弹 Modal（`openApprovalCenter`/`openTaskCenter` 去掉失效的主面板回退）；
  ④ 任务工作区筛选选项改 workspaces ∪ programs 全量（不随筛选塌缩）+ `.silksec-chip`；⑤ 全表 `td` 单行省略 + 固定列宽。
- 回填：主题文档 §5.1（去图标）/§11.8/§11.9、16-dashboard §四.8/§1.6/§1.7、CONTEXT「安全中心」、ui-surface-deps；
  结论回填后本文移入 [archive/19-ui-unify.md](archive/19-ui-unify.md)。

### 2026-09-19 · 文档治理规则 + PROGRESS 瘦身（本会话）
- [README.md](README.md) 增「文档治理规则」：**已完成的临时文档强制归档**、README 为正式文档唯一索引、临时文档收尾必须回填相关正式文档、系统更新即时回填、防漂移。
- PROGRESS.md 瘦身为「当前状态 + 最近结果 + 通用规则」；历史整体迁 [archive/progress-history.md](archive/progress-history.md)。
- 性质：纯文档整理，无线上改动。

### 2026-09-19 · 文档漂移排查 B5 闭环（B1–B5 全部完成）
- proxy / fgs / eval 三域按 manifest 与 csai 运行态对齐；修复 fgs `finding_add` 悬空引用与迁移脚本过期注释；清理 csai 四处过期重复测试副本。
- 契约 proxy 17/17、fgs 21/21、eval 29/29；`bundle dsh setup csai` 重部署 + 重启，`sec-v5-accept.sh` PASS=39 FAIL=0。

> 更早结果（B1–B4 文档漂移、兼容别名层移除、旧版统一清理、UI 原生面 P0–P7、DSH 0.1.5-rc.2 升级、自学习 L0–L6、Phase 1–4 全部节点）见 [archive/progress-history.md](archive/progress-history.md)。

## 三、维护规则（通用，必须遵守）

1. **本文件只含当前**：新增进度写本文件；旧「最近结果」在新结果落地时整体移入历史归档。
2. **历史只归档**：历次更新日志、已完成节点、已关账待办、批次守则移入 [archive/progress-history.md](archive/progress-history.md) 与 [archive/upgrades/](archive/upgrades/)，只读不改写。
3. **批次守则随批次走**：仅在某个批次/专项期间有效的守则、模板、核验方法与该批次记录放在一起；批次归档时一并迁出，本文件只留通用规则。
4. **单次会话 = 可回滚增量**：每个待办节点 = 一次会话，收尾须给出验收证据、commit 与回滚点。
5. **真相源优先级**：运行态证据（`spool`）> 代码/manifest > 契约测试 > 文档；术语以 CONTEXT 为准，契约冲突以 [00-conventions](00-conventions.md) 为上位。
6. **文档同步**：代码/上线改动必须在对应模块文档内回填（版本/契约/未实现项/验收），不得只更新本进度文件；未实现的设计项须显式标注，不得当作现行机制。

## 四、关键决策（已定，勿推翻）

多进程 + SQLite WAL（单写者守护进程 Phase 5 复评已决：无 E_CONFLICT 频发，维持多进程+WAL 终态，不启动单写者架构专项）｜ event_outbox + dispatcher 跨进程投递 ｜ sync（同事务 SAVEPOINT 可回滚）/ async（outbox 派发 + retry/dead-letter）｜ approval_effects 幂等 effect outbox ｜ audit fail-closed（主链路写命令）｜ LLM 工具面 phase 动态子集 ｜ 兼容别名层已于 2026-09-19 清空（机制保留为通用改名能力）｜ 不改表名不迁库（ensureCol 幂等列演进）｜ 14 域 + 总线

## 五、操作红线（每次会话必须遵守）

- 一切远程操作走 PATH 中的 `spool`（`spool exec csai "..."`），禁止绕过 spool 直接 SSH/curl 操作远程 Docker
- 禁止 `docker compose down`；绝对禁止对 n8n 执行 `docker compose down -v`/`--volumes`
- 禁止 `git add -f`；doc/hosts/config.ini/keys 相关敏感文件不入库
- 有状态服务（n8n/Memos/Bellkeeper 等）重建需用户批准；n8n 重启只能用 `docker stop sp-n8n && docker start sp-n8n`
- bundle 模板改动后：先 `rsync -a bundles/dsh/ /opt/SilkSpool/bundles/dsh/` 再 `spool bundle dsh setup csai`（spool 读的是 /opt/SilkSpool/bundles/ 运行时副本）
