# 24 · 专项 × LLM 供给运行状态核查 + 任务/知识/学习界面工作流可视化设计

> 日期：2026-09-23（**已实施并归档 2026-09-23**；结论回填 [16-dashboard](../16-dashboard.md)、[05-task §7.10.5](../05-task.md)）
> 上游：[22-campaign-task-2026-09-22.md](22-campaign-task-2026-09-22.md)（Campaign 本体）、[23-llm-supply-throttle-2026-09-23.md](23-llm-supply-throttle-2026-09-23.md)（LLM 供给调速）。
> 动机：专项任务与 LLM 供给调速已上线（本地契约 575/575、csai accept PASS=72），但（a）需要按最初设计逐项核查「运行状态是否符合设计」；（b）看板侧「任务/知识/学习」三个界面仍停留在「卡片罗列」形态，看不到运行状态、运行报告与工作流阶段，专项尤其「乱、看不出结果」。
> 性质：**运行核查报告 + UI/接线改造设计**。本方案不新增域、不改任何域命令/查询契约语义；只补 dashboard RPC 透传与客户端呈现。

---

## 一、一页结论

1. **设计符合度：22/23 号方案的域内核（状态机/三闸/供给哨兵/降级不回弹/checkpoint 留痕）实现正确**，契约测试钉死（575/575），线上 `campaign_tick` 返回 `supply_factor=1`、正常派生。
2. **但存在 1 个实现错误（供给观测异常恢复后徽章卡死在「观测异常」）**、**1 组未验收工作树改动（模型名归一 + Path A 接线）**、**3 处文档漂移**（详见 §二/§三）。
3. **界面层是最大的「不符合最初设计」**：22 号方案 §十二设计了专项详情（goal_spec·验收账本·活跃子任务·里程碑），落地时只保留了摘要卡片；「运行报告」（每次 tick 的结果摘要）已存在域内但从未送达看板；L1 待放行草稿没有 UI。知识/学习界面则完全没有「工作流阶段」视角。
4. **本方案动作**：域代码仅 1 处小修（恢复翻绿），其余全部在看板侧——补 3 个 RPC 透传 + 任务视图重构（运行中/排队/历史一目了然）+ 专项卡片可展开运行报告 + 知识/学习顶部加工作流状态条。

---

## 二、运行状态核查（专项 × LLM 供给，对照最初设计逐项）

### 2.1 符合设计的部分（核查通过）

| 设计项（出处） | 实现核查 | 结论 |
|---|---|---|
| 三闸取严：program 周期预算闸 ∧ campaign 窗口预算闸 ∧ 供给闸（23 §一.4，INV-C11） | `dispatchDrafts` 依次过三闸；`campaign_dispatch` 显式路径同闸（dashboard 放行不折算） | ✅ |
| 供给因子 {0, 0.4, 1.0} 纯函数决策 + checkpoint 留痕（23 §3.1/§3.4） | `decideThrottle` 纯函数；`llm_throttled`/`llm_restored`/`llm_probe_failed`/`budget_extend_request` 落 `campaign_checkpoints`；factor=0 首发 `task.campaign.escalated`（5min 防抖） | ✅ |
| 供给归零 L2→L1 且**不自动回弹**（23 §3.2 防震荡） | `recordSupplyTransition` 写 `autonomy_change` checkpoint，回弹不升 L2 | ✅ |
| 观测失败两阶段（INV-C12：先 fail-open 有界降速 derive_cap≤2，连续 3 tick 转 fail-closed） | `evaluateSupply` + `supplyProbeFailures` 计数实现 | ✅ |
| 统一额度面（23 §3.6，.env 单区块） | `parseCampaignSupplyEnv` 集中解析 15 键，无凭据自动禁用供给闸（不触网） | ✅ |
| 任务分档标注（23 §3.7，lite/std/heavy 随子任务落库） | `classifyTaskClass` 在 `compileCampaignPlan`/`sanitizeDraft`/`derive_intent` 三处自动分档，落 `tasks.task_class` | ✅ |
| 预算自动爬坡（步骤 1.5，80% 水位提请 approval） | Supervisor 产出 `budget_extend` 动作 → `approval_request(kind=campaign-budget-extend)`，12h checkpoint 防抖 + pending 去重 | ✅ |
| 调度器认领 Path A 载荷 | 调度器 `spawn_worker` 透传 `task.provider/model` → exec 域写 `model-patch.yml`（exec.js:893），机制本身存在 | ✅ |
| 去重前进/infra 判级/rework 重开（P0–P2 修复） | 已部署验收，「首轮后空转 7h」已修复 | ✅ |

### 2.2 不符合/实现错误/未完成清单（本方案处理对象）

| 编号 | 级别 | 问题 | 证据与出处 |
|---|---|---|---|
| W1 | P1 实现错误 | **供给观测异常恢复后，供给徽章永远卡在「观测异常」**：`recordSupplyTransition` 恢复分支条件是 `prev != null && prev < 1`，而 `llm_probe_failed` 使 `lastSupplyState` 返回 `null`，恢复后从不写 `llm_restored` → `supplyBadge` 以最近的 `llm_probe_failed` 为准，即便供给早已正常。修复：观测恢复时（上一状态为 probe_failed）补写 `llm_restored`（或等效 checkpoint）。 | sec-domain-task.js `recordSupplyTransition`/`lastSupplyState`/`supplyBadge` |
| W2 | P1 未验收改动 | **模型名错位修复 + Path A 接线在工作树未提交未验收**：23 号设计默认 `modelMain=ds-v4.1-flash`，而实际成员模型名是 `deepseek-v4.1-flash`——不改则 Path A/B 选模型永远落不到主力（只会走兜底链）。工作树已修（`selectCampaignModel` 归一 `ds-*→deepseek-*` + settings.yaml 注册 + `campaign_dispatch`/`derive_intent` 透传 provider+model），需跑契约验收并提交。 | git worktree diff；23 §3.7；05-task §7.10.5 |
| W3 | P2 文档漂移 | **05-task §7.10.5「Path A 调度器未接线」已过时**：工作树改动后 Path A 端到端打通（dispatch 带 provider/model → tasks 表 → 调度器 spawn_worker → model-patch.yml）。文档须在验收后回填。 | 05-task §7.10.5 vs worktree |
| W4 | P2 文档漂移 | **README 对 23 号的描述停在「未实施」**（「池成员调整已完成，域内调速组件未实施」），与 23 号文档头「已落地」+ PROGRESS 矛盾。 | doc/secagent/README.md |
| W5 | P2 未实施（Bellkeeper 侧） | Bellkeeper 步骤 0.5（sensenova `deepseek-v4.1-flash` 入池权重 7）与步骤 2.5（组策略按 task_class 路由）未做——dsh 侧 `task_class` 元数据已就位待消费。属跨仓工作，本方案只登记不实施。 | 23 §四；05-task §7.10.5 |
| W6 | P2 已知债 | `spent_tokens=0`：worker 不上报真实 token，预算闸按预估 30k/草稿记账，「花了多少」失真。属 worker 侧改造，本方案登记。 | 05-task §7.10.5 |
| W7 | P0 体验缺口 | **专项无「运行报告」面**：`campaign_tick_now`/`campaign_tick` 每次都返回 `{reviewed, derived, deduped, dropped, escalated, skipped[]}` 摘要，UI 直接丢弃——用户看不到「这一 tick 干了什么/为什么没派生」。`campaign_pending_drafts`/`campaign_progress` 两个查询域内已实现但**没有 RPC 透传**，看板拿不到。 | ui-task.client.js `onCampaignTickNow`；dashboard-rpc.js |
| W8 | P0 体验缺口 | **任务视图状态不可辨**：「一次性队列」把 running/queued/blocked 混排一张表，无状态计数、无过滤；执行历史默认折叠且无成功/失败过滤；「工作区」块插在队列与历史之间打断阅读。专项卡片点击=过滤队列，与「想看专项详情」的直觉相反。 | ui-task.client.js TaskCenter |
| W9 | P1 体验缺口 | **知识/学习无工作流视角**：知识 tab 的治理流水线（候选→评审→生效→归档）只有分散的表格与 chip，无漏斗/状态条；学习 tab 五问卡是结果陈述，看不到「观测→记分→蒸馏→发布→生效」流水线上各环节的量。 | view-know.client.js |
| W10 | P2 流程缺口 | accept 脚本无「专区块展开/待放行/队列状态 tab」检查项，UI 回归靠人眼。 | sec-v5-accept.sh |

---

## 三、界面改造设计

> 红线沿用 19-ui-unify/16-dashboard：零颜色字面量（全走 ui-core 令牌/`--dsw-alias-*`）、ErrorBoundary 逐面隔离、primitives 缺席走兜底、RPC 不可达静默降级。

### 3.0 数据通道补齐（`dsh-plugin-sec-suite.dashboard-rpc.js`，纯透传）

| 新 RPC | 透传 | 用途 | 降级 |
|---|---|---|---|
| `campaignProgress` | `task.campaign_progress` | 运行报告的「目标推进投影」块 | 缺席→该块隐藏 |
| `campaignPendingDrafts` | `task.campaign_pending_drafts` | L1 待放行草稿预览 + 一键放行 | 缺席→该块隐藏 |
| `campaignDispatch` | `task.campaign_dispatch`（actor=dashboard） | 放行草稿（过预算闸/供给闸，错误码原样上抛） | 失败 alert |

（`campaignGet` 已有，详情数据直接复用：checkpoints/decisions/active_tasks/window_usage/supply。）

### 3.1 任务视图（`@silksec/ui-task`）——按「状态与时间」重构

**布局重排**（自上而下）：

```
① 专项（Campaign 卡片，可展开运行报告）
② 定时任务卡片（不变）
③ 任务队列 = 原「一次性队列」+ 状态 tab
④ 执行历史（提到工作区之前；加成功/失败过滤）
⑤ 工作区（移到底部，默认折叠态不变）
```

**① 专项卡片升级**：
- 点击语义反转：点击卡片 = **展开/收起运行报告**（不再是直接过滤队列）；过滤队列改为卡片上的独立小按钮（⌗），避免误触。
- 卡片头行增加「最近 tick 相对时间」（`last_tick_at`），状态/自主/供给徽章不变。
- **运行报告抽屉**（展开时 `campaignGet`+`campaignProgress`+`campaignPendingDrafts` 三并发）四个子块：
  1. **报告头**：推进投影（验收总数/确认增量/每 program 分解 pill）+ 最近一次 tick 时间 + 手动 tick 后的**结果摘要**（reviewed/derived/deduped/dropped/skipped，W7 修复点——RPC 返回值不再丢弃）；
  2. **检查点时间线**（近 10 条）：kind 中文映射 + 语义色（escalation 红/autonomy_change·budget_*·llm_throttled·stop_condition 黄/llm_restored·milestone 绿/蓝）+ 相对时间——「为什么这小时没派生」直接可见；
  3. **待放行草稿**（autonomy≥1 才渲染）：每条 kind/task_class/host + 单条「放行」+「全部放行」（走 `campaignDispatch`，INV-C4/C11 闸门原样生效，报错弹错误码）；autonomy=0 显示「L0 台账级不产草稿」；
  4. **活跃子任务**（≤8 条：id/状态/目标 + 「在队列中查看」按钮 = 原来的过滤功能）+ **验收账本近 5 条**（verdict 语义色 + 任务号 + 证据摘要）。

**③ 任务队列状态 tab**：
- 请求仍拉 `bucket:active` 全量（≤200），客户端按 status 分组计数并渲染筛选 chip 行：`全部 n · 运行中 n · 排队 n · 阻塞 n`（运行中 chip 用 success 色，一眼可辨）；
- 选中 chip 客户端过滤（零额外 RPC）；专项过滤/工作区过滤与状态 tab 正交叠加；
- 表格列不变；「正在运行」的行状态 pill 已有，chip 计数解决「看不清」。

**④ 执行历史**：
- 从底部提到工作区之前；标题带总数（已有）；
- 增加 `全部/成功/失败` 过滤 chip（客户端过滤当前页 20 条）；
- 默认仍折叠，但「跳历史」入口（任务行 🕘）不变。

### 3.2 知识界面（`view-know` knowledge tab）——治理流水线状态条

在知识 tab 顶部（memcore 治理 chip 之上）新增**治理漏斗条**（全部取自已有 `memcore` RPC 的 `tables` 分布，零新 RPC）：

```
候选 n → 生效 n → 冷却 n → 归档 n
```

- 每段一个 pill，颜色按状态语义（candidate 黄/active 绿/cooling 灰/deprecated 灰）；数字来源 `mem.tables.exp_cards.*` 等现有键，缺键显示「—」；
- 漏斗条下方保留现有 memChips/知识体检/覆盖缺口卡不动。

### 3.3 学习界面（`view-know` learning tab）——学习流水线状态条

在五问卡之上新增**学习流水线条**（全部取自已有 `learningOverview` 数据结构，零新 RPC）：

```
观测 episodes n → 记分 artifacts n → 发布 releases n（生效 n）→ 撤回 n
```

- 数据源：`d.learned.episodes_recent`、`d.improvement.scores`、`d.effective_where.releases`（含 status 计数）；
- 每段 pill + 「→」连接；某段数据缺席显示「—」，不报错；
- 缺口与反馈桥块不动。

### 3.4 明确不做

- 不引入新 UI 框架/图表库；不加 WebSocket（仍 30s 轮询 + 手动 reload）；
- 不改域命令/查询 schema；不加新域；
- Bellkeeper 侧（W5）、worker token 上报（W6）不在本方案范围。

---

## 四、阶段拆解（Phase A→C，每步可独立验收回滚）

**Phase A · 域内小修 + 工作树收尾（0.5 天）**
1. W1 修复：`recordSupplyTransition` 观测恢复写 `llm_restored`（契约用例：probe_failed→恢复→`lastSupplyState`=1.0、badge=normal）；
2. W2 收尾：跑 `sec-rules-hypothesis` + `contract-task` 契约，通过后提交（feat(secagent): Path A 接线 + 模型名归一）；
3. W3/W4 回填：05-task §7.10.5 删 Path A 条目、README 23 号改「已落地」。
验收：本地全量契约 ≥575 全绿 + 新增用例绿。

**Phase B · UI 改造（本方案主体，1 天）**
4. dashboard-rpc 三透传 + ui-task 重构（§3.1）+ view-know 两状态条（§3.2/§3.3）；
5. 单测：ui-task 新增「状态 tab 计数/过滤」「专项展开拉三 RPC」「tick 摘要显示」「历史成功/失败过滤」用例；view-know 新增「两状态条渲染」用例；既有 14+8 用例保持绿。
验收：`node --test` 全绿。

**Phase C · 部署验收（0.5 天）**
6. `spool bundle dsh setup` + 重启（NRestarts=0）+ `sec-v5-accept.sh --ui-headless`（PASS 基数 72，新增 ≥4 项 UI 检查 → W10）；
7. 线上实测：点开一个真实专项 → 时间线含 `llm_restored`/`llm_throttled` 历史可读；手动 tick → 摘要显示；队列切「运行中」tab；
8. 回填：16-dashboard（任务/知识/学习三节）+ 05-task §7.10.5（W1 修复记录）+ PROGRESS；本方案归档。

---

## 五、风险与回滚

| 风险 | 缓解 |
|---|---|
| 专项展开三并发 RPC 放大看板负载 | 只在展开时拉取；抽屉内无轮询；失败各自降级不炸面 |
| 状态 tab 客户端过滤在 >200 活跃任务时截断 | 现有 limit=200 不变；超限时 chip 计数即截断计数（title 注明） |
| W1 修复改变 checkpoint 序列 | 复用既有 `llm_restored` kind，幂等防抖沿用 5min 窗口，契约钉死 |
| 老缓存页面加载旧 bundle | 部署走 `bundle dsh setup` 既有缓存buster 链路 |

## 六、验收口径（DoD）

- [x] W1 契约用例：probe_failed→恢复→badge 翻绿（commit 4a606b2）；
- [x] W2 提交后契约 575+ 全绿，Path A 用例（provider+model 成对落库）绿（commit 59da0cc）；
- [x] 看板任务视图：专项可展开看到检查点时间线 + 待放行草稿 + tick 摘要；队列有状态 tab；历史有成功/失败过滤；
- [x] 知识/学习顶部各有一条工作流状态条；
- [x] accept 新增检查项后 PASS 无 FAIL（72→80）；
- [x] 16-dashboard/05-task/README/PROGRESS 回填完毕，本文归档。
