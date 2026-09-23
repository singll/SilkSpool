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
