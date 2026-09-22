# 22 · 项目型常驻任务（Campaign）设计方案——任务模块增强重构与知识/学习联动

> 日期：2026-09-22
> 性质：**已关账归档**（设计文档；2026-09-22 实施、评审修复并部署验收，accept PASS=75；本文移入 archive 只读）。实施态回填见 05-task §七 / 07-know §十五 / 09-approval / 16-dashboard / 01-bus。
> 动机：定时任务（interval）对 SRC 挖掘太死板——固定节律、无目标感、无验收、无统筹；21 号方案已补齐「假设引擎/机器验证/Feedback Core」，但**缺一个常驻的统筹实体**把这些能力串成持续运转的项目。
> 依赖文档：[00-conventions](../00-conventions.md)（宪法）、[05-task](../05-task.md)（任务域现状，本文的改造对象）、[07-know](../07-know.md)（知识/学习）、[08-scope](../08-scope.md)（合规红线）、[09-approval](../09-approval.md)（人工放行）、[16-dashboard](../16-dashboard.md)（看板承载）、[21-benchmark-strikeagent-flash](21-benchmark-strikeagent-flash-2026-09-21.md)（发现体系重构，本文的上游）。
> 总原则（沿用 21 号方案）：**不新增域**；确定性规则层编译硬约束，LLM 只产草稿；fail-closed；原子化拆分（每个组件可独立契约测试）。
> 术语裁定：新实体命名 **Campaign（专项）**——「项目」一词在领域语言中已分别被 Workspace（用户可感）与 Program（授权主体）占用（CONTEXT.md 明确「不要另立项目 UI 概念」），故本实体不叫「项目任务」，中文称「专项」，英文/表名用 `campaign`。

---

## 一、一页结论

1. **病灶**：现有 Task 只有三种生命形态——普通一次性、once、interval。interval 是「到点就跑」的固定节律实体：它不知道**为什么跑**（无目标规格）、**跑得怎么样**（无验收环节）、**下一步该干什么**（无派生能力）。21 号方案的 Intent 派生器（`task_derive_intent`）让任务能「生」任务，但派生决策是事件触发的应激反应，**没有一个常驻实体对「一个 SRC 项目整体推进到什么程度、预算花得值不值、何时该换打法」负责**。
2. **方案一句话**：在 **task 域内**新增第一公民实体 **Campaign（专项）**——一个常驻的、绑定一个或多个 Program 的统筹任务对象，持有目标规格（goal spec）、策略与预算，通过**派生（derive）→ 下发（dispatch）→ 监督（supervise）→ 验收（review）**的闭环驱动原子子任务，子任务仍是现有 Task（同一张表、同一状态机、同一调度器）。
3. **形态决策**：**不新增第 15 个域，大重构落在 task 域内部**。Campaign 的全部能力拆为六个**原子组件**（Core/Planner/Dispatcher/Supervisor/Reviewer/LearnLink），组件间只经事件与查询通信，各自独立契约测试——与 21 号方案「Feedback Core 落 know 域内」同一判据：统筹天然消费全域事件、向全域回灌，独立成域只会再造孤岛。
4. **合规结构**：派生链上**没有任何一条绕过现有闸门的新通道**——子任务一律经 `task_create`/`task_derive_intent` 下发，局面编译（compileSituation）、scope fail-closed、per-program 预算闸原样生效；Campaign 叠加**自己的一层预算与自主级别闸**（双闸取严）。自主级别封顶 **L2（有界自动）**，任何升档、扩范围、超预算都走 approval。
5. **定时任务不删**：interval 保留给「基线节奏类」工作（资产巡检、授权时效巡检）；**SRC 挖掘主线迁移到 Campaign 驱动**。Campaign 禁止直接派生 interval 子任务（节奏权唯一归 Campaign tick，防双重调度漂移）。
6. **知识/学习联动**：Planner 消费 know 的经验卡命中矩阵与缺口（know_scores/know_gaps）；验收正例反哺蒸馏（沿用 Phase 4 通道）；episode/记分**新增 campaign_id 维度**（know 域只加可选列与过滤参数，不动管线——原子化）。

---

## 二、问题与动机（现状诊断）

### 2.1 定时任务为什么不适合 SRC 挖掘

| 能力 | interval 任务 | SRC 挖掘需要的 |
|---|---|---|
| 节奏 | 固定周期（≥300s），相位锚定 run_at，latest-only 续期 | **事件驱动**：新端点入库、覆盖缺口出现、连败触底、经验卡撤回……时机不可预知 |
| 目标 | objective 是一句话，跑完没有「达成判定」 | 目标规格化：覆盖矩阵推进多少、七类主粮测了几类、confirmed 产出几条 |
| 成果 | run 落 task_runs（ok/note），无人验收 | 每个子任务的产出要被对照目标**验收**，验收结论决定下一步 |
| 统筹 | 任务间只有 parent_id 前置链 | 一个常驻实体掌握全局：还有哪些假设没试、哪个打法连败、预算还剩多少 |
| 多项目 | 一任务一 program | 交叉挖掘：同一技术栈/同一打法的经验跨 program 复用（合规边界内） |

21 号方案 Phase 3 的 Intent 派生器解决了「单点派生」（事件 → 草稿任务），但派生是**无主的**：没有实体对派生出去的任务集合做收口、验收与再规划。Campaign 就是给这套派生机制**装上一个常驻的负责人**。

### 2.2 现状资产盘点（Campaign 复用什么、不重复造什么）

| 已有机制 | 位置 | Campaign 的关系 |
|---|---|---|
| 任务状态机 + 调度器单例 + claim/finish/reap | 05-task | **复用**，子任务原样走这条链，零改动 |
| `task_derive_intent` + strategy_dedupe + 连败黑名单 | 05-task §六 | **复用**，Dispatcher 唯一派生通道 |
| 局面编译 compileSituation（scope/黑名单/授权时效） | 规则层 | **复用**，派生前置硬门 |
| per-program 预算闸（E_TASK_BUDGET_EXHAUSTED） | 05-task §6.3 | **复用**，Campaign 预算闸叠加其上 |
| 覆盖账本 + 缺口队列 | 11-ledger | **消费**，Planner 的主要输入 |
| Feedback Core（蒸馏/记分/缺口 reactor） | 07-know §十三 | **消费+回灌**，LearnLink 双向联动 |
| 机器验证 oracle / proof capsule / 证据门 | 02-vuln | **消费**，Reviewer 验收判据的证据来源 |
| approval kind 注册表 | 09-approval | **扩展**，新增 campaign 类 kind（见 §十） |

---

## 三、设计原则

1. **原子化**：六个组件各自是「一组纯函数 + 一个订阅/轮询入口 + 自有表」的闭包；组件间无函数直调，只有事件与查询。任何组件可单独契约测试、单独关闭（manifest feature flag），关闭后系统退化为现状（Campaign 停摆但 Task 一切如常）。
2. **确定性与 LLM 分层**（沿用 21 号方案）：Planner 的**决策编译**是规则层纯函数（输入=账本/缺口/记分/连败，输出=派生计划）；LLM 只能产「计划草稿」，草稿过编译才能成为任务。LLM 永远不直接持有派生权。
3. **合规结构性保证**：不是「Campaign 自律不越界」，而是**越界的路径在结构上不存在**——派生唯一通道是现有 task 命令，局面编译/scope/预算闸在通道上，不在 Campaign 自觉里。
4. **证据铁律延伸**：验收（review verdict）是结论类动词，证据参数 required——「无证据不验收」。
5. **HITL 优先**：自主级别默认最低（L0）；升档是显式审批行为；任何不确定一律升级人工（escalate），不猜。
6. **减法红线**：不做多 agent 并发 swarm、不做自我繁殖、不接外部编排框架；单 tick 有界处理，超界回队列。

---

## 四、总体形态与定位

### 4.1 实体定位

```
Campaign（专项，常驻实体，task 域 owns）
  │ 1:N
  ▼
Task（子任务，现有实体，零改动）── schedule_kind ∈ {NULL, once}（Campaign 派生禁止 interval）
  │ 1:1 执行
  ▼
Run / worker（exec 域，零改动）
```

- Campaign **不是任务的上级状态机**——子任务状态机不变（queued/running/blocked/done/failed/cancelled），Campaign 不侵入；它只通过「派生新任务」与「验收已完成任务」两个动作施加影响。
- Campaign **不是调度器**——它没有自己的时钟循环，tick 由 task 域既有调度器单例循环顺带驱动（见 §6.4），派生出去的子任务仍由既有 claim 链认领执行。
- Campaign 与 Program：N:M（单一 SRC 深挖 = 绑 1 个 program；交叉挖掘 = 绑 ≥2 个）。**绑定的每个 program 必须已存在 scope 授权**；派生到哪个 program 就过哪个 program 的局面编译，跨 program 不存在任何「共享豁免」。
- Campaign 与 Workspace：Campaign 在 UI 上**不作为新概念出现**（CONTEXT 红线），呈现为工作区/Program 徽章下的「专项」视图（§十二）；跨 program 的交叉专项在看板「安全中心」平铺 tab 中承载。

### 4.2 与既有概念的关系矩阵

| 概念 | 关系 | 说明 |
|---|---|---|
| `schedule_kind=interval` | **互补不替代** | 基线节奏（巡检/治理）继续用 interval；挖掘推进归 Campaign。`task_create` 加不变量：`campaign_id 非空 ⇒ schedule_kind != 'interval'`（INV-C7） |
| `goal`（L6 目标类型） | **正交** | goal 是子任务的执行语义（research/learn-daily/eval-batch/change-retest）；Campaign 派生时按子任务性质填 goal（缺口消费→research、经验复验→eval-batch、卡片撤回→change-retest）。Campaign 自身**没有** goal 字段，目标在 goal_spec |
| `task_derive_intent` | **唯一派生通道** | 21 号方案的事件触发派生（endpoint.registered / coverage.marked）保留为「无主派生」；Campaign 派生走同一命令，只是 actor=campaign 且必带 campaign_id——dedupe/黑名单/预算闸行为完全一致 |
| `task_chain` | **子能力** | Campaign 的多步打法（爬→补参→验证）经 task_chain 展开为 once 链，链头带 campaign_id，链节经 parent_id 继承归属 |

---

## 五、数据模型（全部 task 域 owns，新表不跨域）

### 5.1 `campaigns` 表

| 列 | 类型 | 约束/默认 | 语义 |
|---|---|---|---|
| `id` | INTEGER | PK AUTOINCREMENT | 专项 id |
| `name` | TEXT | NOT NULL | 专项名（活跃唯一：status!='archived' 内不重复） |
| `mode` | TEXT | NOT NULL DEFAULT 'single' | single（单 SRC 深挖）/ cross（多 program 交叉） |
| `program_ids` | TEXT | NOT NULL（JSON array，≥1） | 绑定 program 集合；cross 模式 ≥2 |
| `goal_spec` | TEXT | NOT NULL（JSON） | 目标规格：`{objective, vuln_classes[], targets{coverage_pct?, confirmed_min?, login_coverage_pct?}, stop_conditions[], review_cadence_sec}`。stop_conditions 非空（铁律：任何专项必须有退出条件） |
| `autonomy` | INTEGER | NOT NULL DEFAULT 0 | 自主级别 0/1/2（§7.1）；L1/L2 必须带 approval_id |
| `policy` | TEXT | NOT NULL（JSON） | 策略约束：`{derive_cap_per_tick, max_active_tasks, task_priority_range, model_override{provider,model,reasoning_effort}, allowed_phases[]}` |
| `status` | TEXT | NOT NULL DEFAULT 'draft' | draft/active/paused/reviewing/archived（§6.1 状态机） |
| `budget_tokens` | INTEGER | nullable | 专项级 token 预算（NULL=不限，但 autonomy=2 时必填——INV-C4） |
| `spent_tokens` | INTEGER | NOT NULL DEFAULT 0 | 由子任务 task.finished 的 spent_tokens 汇聚（Reviewer 记账） |
| `budget_window_days` | INTEGER | NOT NULL DEFAULT 7 | 预算窗口（与 per-program 闸口径对齐） |
| `approval_id` | INTEGER | nullable | autonomy≥1 的创建/升档审批引用（审计链） |
| `last_tick_at` / `heartbeat_at` | INTEGER | nullable | 最近 tick / 最近有 accepted 验收时间（Supervisor 空转判定） |
| `created_by` | TEXT | NOT NULL | actor（model/dashboard/script/human） |
| `created_at` / `updated_at` / `archived_at` | INTEGER | | |

索引：`idx_campaigns_status(status, last_tick_at)`（tick 扫描键）。program 反查经 tasks.campaign_id（program_ids 是 JSON 数组不建索引）。

### 5.2 子任务归属（tasks 表幂等加列，不改名不迁库——同 goal 列先例）

| 列 | 类型 | 语义 |
|---|---|---|
| `campaign_id` | INTEGER nullable | 归属专项；NULL=普通任务（存量全部为 NULL，天然兼容） |
| `campaign_role` | TEXT nullable | seed（专项启动种子）/ derived（Planner 派生）/ verify（机器验证）/ submit（提交闭环）/ retest（重测）/ learn（学习整理） |

索引：`idx_tasks_campaign(campaign_id, status)`。不变量 INV-C2：`campaign_id` 写入后不可改（任务不改挂——防验收账本混乱）；INV-C7：campaign 子任务禁止 interval。

### 5.3 `campaign_decisions` 表（验收账本，证据铁律落点）

| 列 | 类型 | 语义 |
|---|---|---|
| `id` | INTEGER PK | |
| `campaign_id` | INTEGER NOT NULL | |
| `task_id` | INTEGER NOT NULL | 被验收的子任务 |
| `verdict` | TEXT NOT NULL | accepted（成果有效，推进目标）/ rework（方向对、执行差，派生修正任务）/ rejected（无效，连败回写）/ escalated（无法判定，升级人工） |
| `evidence` | TEXT NOT NULL | 验收证据（run_id / capsule_id / ledger 引用；**required，证据铁律**） |
| `goal_delta` | TEXT（JSON） | 本次验收对 goal_spec 的推进量快照（覆盖格点+、confirmed+…，供进度投影只聚合不重算） |
| `decided_by` | TEXT NOT NULL | reviewer（自动验收）/ human（人工裁定） |
| `created_at` | INTEGER | |

UNIQUE(task_id)——**一任务一验收**（幂等；重验需先作废原行，作废是单独命令留审计）。

### 5.4 `campaign_checkpoints` 表（里程碑/升级记录）

| 列 | 类型 | 语义 |
|---|---|---|
| `id` / `campaign_id` | | |
| `kind` | TEXT | milestone（目标阶段达成）/ escalation（升级人工）/ autonomy_change / budget_low / stop_condition（退出条件命中） |
| `summary` | TEXT | 摘要 ≤500 字 |
| `payload` | TEXT（JSON） | 结构化细节（如 escalation 的悬而未决问题清单） |
| `created_at` | INTEGER | |

### 5.5 幂等与去重

- Campaign 派生走 `task_derive_intent`，复用 `strategy_dedupe`；strategy_key 前加 campaign 维度 `c{campaign_id}|host|path|param|vuln_class`——**同一打法在不同专项下独立计数**（交叉专项与单挖专项互不占名额），连败黑名单仍按去 campaign 维度的裸 key 判定（连败是打法的属性，不是专项的属性）。
- `task_create`/`task_derive_intent` 的自动指纹含 campaign_id；重放语义不变。

---

## 六、状态机与不变量

### 6.1 Campaign 状态机

```
draft ──activate──▶ active ◀──resume── paused
                      │  ▲                 ▲
          stop_condition│  │review_pass     │人工暂停/预算升档待批
          命中/人工archive│  │                 │
                      ▼  │                 │
                   reviewing（定期/事件触发的人类审阅态，只读不派生）
                      │
                      ▼
                   archived（终态，只读；台账保留）
```

- `reviewing` 是**有节律的人类检查点**（goal_spec.review_cadence_sec 到期自动转入，或 escalation 触发转入）；reviewing 中不再新派生，在跑的子任务自然完结并照常验收；人工裁定后回 active 或 archived。
- autonomy=0 的专项在 active 下不自动派生，仅接受人工/会话内模型经 Dispatcher 显式派生。

### 6.2 不变量（INV-C 系列，规约层，进契约测试）

| ID | 内容 | 失败语义 |
|---|---|---|
| INV-C1 | 绑定 program 必须全部存在于 scope programs 镜像且授权未过期（激活时校验 + 每次派生前经局面编译复查） | activate：`E_CAMPAIGN_PROGRAM_UNRESOLVED`；派生：局面编译原错误码 |
| INV-C2 | tasks.campaign_id 写入后不可变更 | `E_INVARIANT` |
| INV-C3 | 一任务一验收（campaign_decisions UNIQUE(task_id)） | `E_CAMPAIGN_REVIEWED`（带既有 decision id） |
| INV-C4 | autonomy=2 ⇒ budget_tokens 必填 且 stop_conditions 非空 且 approval_id 非空 | `E_CAMPAIGN_AUTONOMY_GATE` |
| INV-C5 | 派生唯一通道=task_create/task_derive_intent；Dispatcher 结构上没有第二条写 tasks 的路径（代码评审断言 + setup 冒烟静态扫描） | 结构性，无运行态错误码 |
| INV-C6 | 派生有界：单 tick ≤ policy.derive_cap_per_tick（默认 5）；活跃子任务（queued+running）≥ policy.max_active_tasks（默认 20）时本 tick 不派生 | tick 路径静默跳过 + 摘要计数（可观测，不报错）；显式 dispatch 路径报 `E_CAMPAIGN_DERIVE_CAP` |
| INV-C7 | campaign 子任务 schedule_kind ∈ {NULL, once}（interval 禁止） | `E_CAMPAIGN_INTERVAL_FORBIDDEN` |
| INV-C8 | 验收证据非空且引用可解析（run_id/capsule_id 前缀白名单） | `E_EVIDENCE_REQUIRED` |
| INV-C9 | stop_condition 命中 ⇒ 自动转 reviewing 并发 checkpoint；**不自动 archive**（终态是人审决定） | — |
| INV-C10 | 预算闸双层取严：per-program 周期闸（现有） ∧ campaign 窗口闸；任一命中停派 | 沿用 `E_TASK_BUDGET_EXHAUSTED` / `E_CAMPAIGN_BUDGET_LOW` |

### 6.3 子任务状态机

**零改动**。Campaign 不做任何子任务状态直写；暂停专项 ≠ 取消子任务（在跑的跑完，队列里的留 queued 待 resume 后由调度器正常认领——但若专项 archived，则其 queued 子任务由 Core 同步 dispatch `task_cancel`，cause 链带 campaign 归档事件 id）。

### 6.4 tick 循环（复用调度器单例，不新增持锁者）

task 域调度循环每 tick（≤60s）在 `task_claim` 之后追加 **campaign tick 段**（同一 `scheduler.lock` 持锁者，headless 不跑）：

1. 扫 `status='active'` 的 campaigns（idx_campaigns_status，`ORDER BY last_tick_at ASC`），单 tick 处理上限 10 个（其余下一 tick；跑完即刷新 last_tick_at 使其排到队尾，准轮转公平）；
2. 逐 campaign 顺序跑：Supervisor 巡检 → Reviewer 验收新完结子任务 → Planner 决策（若 autonomy≥1）→ Dispatcher 下发；
3. 每步有界（INV-C6），tick 摘要（派生数/验收数/跳过原因）写 `data/events/task.jsonl` 与看板投影；
4. tick 内任何组件异常**隔离到该 campaign**：记 checkpoint(kind=escalation) 并跳过，不中断其他 campaign，fail-closed 不吞错。

---

## 七、原子组件详设

### 7.1 自主级别（autonomy）定义

| 级别 | 语义 | 派生权 | 创建/升档要求 |
|---|---|---|---|
| L0 台账模式 | Campaign 只是统筹视图与验收账本 | 仅人工/会话内模型经 `campaign_dispatch` 显式派生 | 无审批 |
| L1 建议模式 | Planner 每 tick 产**派生草稿**（不落任务），人/模型在看板逐条放行 | 草稿 → 人工 `campaign_dispatch(draft_id)` 才落任务 | **免审批**（建单 born=draft，激活经 dashboard；L1 不自动下发，风险低——§8.1 口径统一修订） |
| L2 有界自动 | Planner 草稿过编译后**自动下发**（INV-C6 有界 + 双预算闸 + 局面编译） | 全自动，超界自动降级为 L1 行为 | approval kind=`campaign-autonomy`（subject=campaign 名） |

**封顶 L2，无 L3 设计**。L2 运行中触发任一条件自动降级为 L1（记 checkpoint）：连败黑名单新增、预算消耗速率超阈值（§7.4）、escalation 未决超过 24h。

### 7.2 Campaign Core（核心账本）

- **职责**：campaigns/checkpoints 表的唯一写者；状态机流转；tick 编排（调其他组件的顺序控制器）。
- **接口**：§八的命令动词（create/activate/pause/resume/archive/goal_update/review_pass）。
- **原子性**：Core 不 import 任何其他组件的实现，只经依赖注入的接口调用；契约测试用 stub 替换 Planner/Reviewer 验证状态机。

### 7.3 Planner（规划器）

- **输入（全经查询网关，无直读他域表）**：覆盖缺口队列（`ledger.coverage` 系）、登录盲区摘要、strategy_dedupe 连败表、know_scores 命中矩阵（哪张经验卡在此栈×漏洞类赢过）、know_gaps（检索缺口）、本 campaign 活跃/已完成子任务。
- **决策编译（规则层纯函数 `compileCampaignPlan`）**：优先级 = 高危漏洞类 × 高价值资产 × 新资产面（沿用 21 号方案缺口排序），再叠加三因子修正——连败惩罚（黑名单邻近 key 降权）、经验卡正向命中提权、预算剩余率提权。输出 = 派生草稿数组（每条含 strategy_key、phase、goal、objective 模板、引用的经验卡 id 列表）。
- **LLM 的位置**：autonomy≥1 且规则层输出为空（确定性能量耗尽）时，**可选**调用 LLM 产「探索性草稿」；草稿必须过 compileSituation + H3 判据（引用 ≥1 经验卡、声明 vuln_class、host 在 scope 内、无注入特征）才能进派生队列——与 `task_derive_intent` 的 H3 门禁完全同一套判据（复用，不复制）。LLM 调用走独立 once 任务（goal=research）经既有 worker 链异步产出，**不阻塞 tick**。
- **原子性**：纯函数 + 输入快照，契约测试用固定快照断言输出（确定性可重放）。

### 7.4 Dispatcher（下发器）

- **唯一动作**：把 Planner 草稿/人工指令翻译为 `task_derive_intent` / `task_create` / `task_chain` 调用（actor=campaign，cause 链带 campaign_id + tick 序号）。
- **闸（顺序敏感）**：① INV-C6 有界检查 → ② campaign 预算闸（窗口内 spent + 预估 > budget → E_CAMPAIGN_BUDGET_LOW + checkpoint(budget_low) + L2→L1 降级）→ ③ 委托 task 命令（局面编译/per-program 闸在其内部，Dispatcher 不重复实现）。
- **预算消耗速率监控**：窗口内日均消耗 > budget/window_days × 1.5 ⇒ 提前降级（不等耗尽）。
- **原子性**：无自有表；纯翻译层，契约测试断言「给定草稿 → 恰好这组 dispatch 调用」。

### 7.5 Supervisor（监督器）

每 tick 对本 campaign 巡检五类信号，产出处置（自动动作或 escalation checkpoint）：

| 信号 | 判定 | 处置 |
|---|---|---|
| 卡死 | 业务卡死：连续 N 个 run ok=0 且 note 同类（运行态僵尸由既有 task_reap 管，这里管业务层） | task_block（blocked_reason 带诊断）+ escalation |
| 连败 | strategy_dedupe 本 campaign 维度新增连败 ≥2 条/tick | 该打法方向 Planner 降权写回 + L2→L1 降级 |
| 空转 | heartbeat_at 超 48h 无 accepted 验收且无新派生 | escalation（「专项空转：目标不可达 or 能量耗尽」） |
| 预算异常 | §7.4 速率阈值 | 降级 + checkpoint(budget_low) |
| 授权漂移 | 绑定 program 的 scope 被 revoke/过期（订阅 scope.revoked + 派生前局面编译复查） | 立即 pause（fail-closed）+ escalation |

- **原子性**：巡检规则每条是纯函数（输入快照 → 处置列表）；Supervisor 的写动作只经 Core/Dispatcher 接口。

### 7.6 Reviewer（验收器）

- **触发**：订阅 `task.finished`，过滤 `campaign_id 非空` 的子任务（强联动进 outbox 重试链；验收失败不吞——进 DLQ 可重放）。
- **验收判据（确定性优先，按 campaign_role 分派）**：
  - `derived/verify` 类：产出是否有 machine oracle 判定（vuln capsule confirmed/rejected）；有 verdict → accepted/rejected 自动裁定；无 verdict 但覆盖账本有格点推进 → accepted（覆盖也是成果）；两者皆无 → rework 或 escalated。
  - `submit` 类：`vuln_submit` 回写 remote_id → accepted；超期未提交 → escalation（沿用产出闭环）。
  - `learn/retest` 类：L6 节奏既有判据（候选是否进治理链）。
- **落账**：`campaign_decisions`（INV-C3/C8）+ goal_delta 聚合 → campaigns 进度投影 + `spent_tokens` 汇聚（从 task.finished payload 的 spent_tokens 加总，INV-T14 成本归因的消费方）。
- **联动**：verdict=rejected → 回写 strategy_dedupe 连败（复用 `vuln.signal.rejected` 同通道）；verdict=accepted 且含 capsule → 不动——蒸馏由 know 域既有 onVulnVerdict 消费 `vuln.signal.confirmed` 完成，**Reviewer 不重复触发蒸馏**（原子化：验收只判任务成果，知识沉淀走既有事件链）。

### 7.7 LearnLink（学习联动，详见 §十一）

双向：Planner ←（消费）know_scores / know_gaps；LearnLink →（回灌）把 campaign 维度的缺口登记进 know_gaps（surface=`campaign:{id}:{dim}`）。**不新增 know 域动词**，只扩现有参数与列（§十一.2）。

---

## 八、命令与查询（task 域新增动词）

### 8.1 命令总表

| # | 动词 | 一句话语义 | actor | 幂等键 | 发布事件 | 模型可见 |
|---|---|---|---|---|---|---|
| C20 | `campaign_create` | 登记专项（goal_spec/policy/绑定 programs），born=draft | model, dashboard, script | 自然键（name） | task.campaign.created | ✅ |
| C21 | `campaign_activate` | draft/paused → active（INV-C1/C4 全量校验；autonomy=2 需 approval_id；L1 免审批） | dashboard, human, approval（effect） | 自动指纹 | task.campaign.status.changed | ❌ |
| C22 | `campaign_pause` / `campaign_resume` | active ↔ paused（不动在跑子任务） | model, dashboard, human | 自动指纹 | task.campaign.status.changed | ✅ |
| C23 | `campaign_archive` | 非终态 → archived（终态）；同步 cancel 其 queued 子任务 | dashboard, human | 自动指纹 | task.campaign.status.changed | ❌ |
| C24 | `campaign_goal_update` | 更新 goal_spec/policy（active 中改目标 → 强制转 reviewing 待人工确认） | dashboard, human | 自动指纹 | task.campaign.goal.changed | ❌ |
| C25 | `campaign_dispatch` | 显式派生：人工/模型指定草稿（L0/L1 的唯一派生口；L2 也可人工补派） | model, dashboard, human | 自动指纹（草稿指纹） | task.campaign.task.derived ×N | ✅ |
| C26 | `campaign_review_pass` | reviewing → active（人工审阅通过；附决议摘要进 checkpoints） | dashboard, human | 自动指纹 | task.campaign.status.changed | ❌ |
| C27 | `campaign_tick_now` | 立即对单 campaign 跑一次 tick 段（调试/演示；不超 INV-C6 界） | dashboard, script | none（有界自愈） | — | ❌ |

actor 白名单说明：激活/归档/审阅通过是治理动作，模型不可直调（与 know 域 L4「模型不能自我晋升」同一判据）；模型只开放 create/pause/resume/dispatch。**L1 免审批、L2 强制审批**（`campaign-autonomy`，见 §7.1 修订）。`approval` actor 仅出现在 `campaign-autonomy` 批准的 effect 同步 dispatch（落 autonomy/approval_id 后 activate）。

### 8.2 查询总表

| 查询 | 参数 | 返回 |
|---|---|---|
| `campaign_list` | status / program_id / 分页 | 专项卡片行（id/name/mode/status/autonomy/进度聚合/预算消耗/heartbeat） |
| `campaign_get` | id | 全文：goal_spec、policy、program_ids、近 N 条 decisions、活跃子任务、checkpoints |
| `campaign_progress` | id | 目标推进投影：goal_delta 聚合（覆盖格点 x/y、confirmed n/目标、登录覆盖%）+ 每 program 分解 |
| `campaign_pending_drafts` | id | L1 待放行派生草稿列表（看板一键放行跳 campaign_dispatch） |
| `campaign_decisions` | campaign_id / verdict / 分页 | 验收账本行（看板验收队列 + 复盘数据源） |

### 8.3 错误码（新增）

| code | 触发 | retryable |
|---|---|---|
| `E_CAMPAIGN_PROGRAM_UNRESOLVED` | 绑定 program 不存在/未授权/已过期 | false |
| `E_CAMPAIGN_AUTONOMY_GATE` | INV-C4（L2 缺预算/退出条件/审批引用） | false |
| `E_CAMPAIGN_STATE` | 状态机非法流转（如 archived 上 dispatch） | false |
| `E_CAMPAIGN_BUDGET_LOW` | campaign 窗口预算闸 | false（人工放行/升档后重试） |
| `E_CAMPAIGN_REVIEWED` | 重复验收（INV-C3） | false |
| `E_CAMPAIGN_INTERVAL_FORBIDDEN` | INV-C7 | false |
| `E_CAMPAIGN_DERIVE_CAP` | 超 INV-C6 有界（显式 dispatch 路径；tick 路径静默跳过） | true（下一 tick） |

---

## 九、事件与订阅

### 9.1 发布事件（task 域）

| 事件 | 生产者 | payload 要点 | 消费者 |
|---|---|---|---|
| `task.campaign.created` | C20 | {campaign_id, name, mode, program_ids, autonomy} | 看板/memcore |
| `task.campaign.status.changed` | C21–C23/C26 | {campaign_id, from, to, cause} | 看板/memcore/know（episode 归因） |
| `task.campaign.goal.changed` | C24 | {campaign_id, diff 摘要} | 看板 |
| `task.campaign.task.derived` | Dispatcher（经 task 命令侧链补发） | {campaign_id, task_id, strategy_key, role} | 看板/eval（派生质量指标） |
| `task.campaign.reviewed` | Reviewer | {campaign_id, task_id, verdict, goal_delta} | 看板/eval/know（记分 campaign 维度） |
| `task.campaign.escalated` | Supervisor/Core | {campaign_id, kind, summary} | 看板通知（强提醒）/memcore |

### 9.2 订阅（task 域 reactor 新增，既有订阅不动）

| 事件 | handler | 语义 |
|---|---|---|
| `task.finished` | Reviewer.onTaskFinished | campaign_id 非空 → 验收（§7.6）；**与 know 域 L1 episode 订阅并存**（各记各的账） |
| `scope.revoked` / `scope.rules.changed` | Supervisor.onScopeChanged | 命中绑定 program → pause + escalation（fail-closed） |
| `ledger.coverage.marked` | Planner.invalidateCache | 缺口变化 → 下一 tick 重编译计划（只清缓存，不直接派生——派生权在 tick） |
| `know.release.revoked` | （既有 change-retest 入队保留）+ 新增 handler | 若撤回卡片被本 campaign 的 H3 派生引用过 → 相关 queued 草稿作废（checkpoint 记录） |

**订阅纪律**：Reviewer 验收是**强联动**（业务主链，失败进 DLQ）；Planner 缓存失效是治理旁路（失败不阻断）。

---

## 十、合规边界（与 08-scope / 09-approval 的接线）

1. **派生链零新通道**（INV-C5）：所有落到 targets 的动作都经现有 task→exec 链，scope_check/局面编译/沙箱凭据隔离原样生效。Campaign 自身**没有任何网络动作**，只是账本与决策。
2. **新增 approval kind（09-approval 注册表扩展，两类）**：

| kind | subject | request_actors | validate 判据 | approved effect |
|---|---|---|---|---|
| `campaign-autonomy` | campaign 名 | dashboard, system（L1/L2 创建与升档） | campaign 存在且 draft/paused；L2 需 budget_tokens+stop_conditions 非空 | 同步 dispatch `campaign_activate`（actor=approval，落 autonomy/approval_id） |
| `campaign-budget-extend` | campaign 名 | model, scheduler, system | 当前 spent ≥ budget×0.8；extend ≤ 原 budget×2 | 同步 dispatch 落 budget_tokens 增量（Core 内部动词，审计可追） |

3. **intrusive 红线**：Campaign 派生的子任务若涉及 intrusive 级目标，沿用既有 `tool-intrusive` 审批链——Campaign 不豁免、不加速。
4. **交叉挖掘的合规隔离**：cross 模式下，**经验卡（去特化战术骨架）可跨 program 消费**（这正是交叉挖掘的价值）；**事实/证据/凭据/覆盖账本绝不跨 program**（facts/endpoints/credentials 查询谓词全部带 program_id，LearnLink 不做跨 program 的事实聚合）。派生到 program A 的任务引用经验卡时，局面编译只校验 A 的 scope。
5. **授权时效**：INV-C1 派生前复查（局面编译已含授权时效 fail-closed）；授权临期（`scope_expiring`）在专项视图呈现。

---

## 十一、知识与学习联动重构（原子化）

### 11.1 原则

不在 know 域为 Campaign 新建子仓；联动全部通过**既有机制的维度扩展**实现——每个改动是「加一列 / 加一个可选参数 / 加一个订阅过滤」，可独立上线、独立回滚。

### 11.2 逐项联动

| # | 联动 | 改动点（原子） | 方向 |
|---|---|---|---|
| L1 | Planner 消费经验卡命中矩阵：`know_scores` 查询增可选过滤 `program_id`/`stack`（投影层过滤，不改计分管线） | know 域查询参数 +2 | know → Planner |
| L2 | episode 归因：`learning_episodes` 幂等加列 `campaign_id`（nullable）；know 域 L1 episode 订阅从 `task.finished` payload 透传（payload 增 campaign_id 字段，task 域侧改） | know 表 +1 列、task 事件 payload +1 字段 | task → know |
| L3 | 记分维度：`know_scores` 重放逻辑不变，查询投影增 `campaign_id` 分组档（per-campaign 的 wins/fails/cost 视图——回答「这个专项里哪张卡真有用」） | know 域查询投影 +1 档 | know → 看板/Planner |
| L4 | 缺口回灌：Supervisor 识别「本 campaign 反复 rework 同一 vuln_class」→ 经既有 `know_gap_record`（actor 白名单 +campaign；surface=`campaign:{id}:{vuln_class}`）登记检索缺口，进既有 L2 候选补建链 | know 域 actor 枚举 +1 | Campaign → know |
| L5 | 蒸馏不重复：验收 accepted 的 capsule 证据仍由 know 域 onVulnVerdict 消费 `vuln.signal.confirmed` 蒸馏；Reviewer 只负责验收落账，**不触发、不复制**蒸馏逻辑 | 零改动（纪律声明） | — |
| L6 | 撤回联动：`know.release.revoked` 既有 change-retest 入队保留；Campaign 侧增「引用作废」——Planner 缓存中引用被撤回卡片的草稿作废 | task 域订阅 +1 handler | know → Campaign |

### 11.3 学习节奏与 Campaign 的关系

L6 四类 goal（research/learn-daily/eval-batch/change-retest）的**调度节奏权**：存量 interval 型学习任务（如每日 learn-daily）**不迁移**——它们是基线节奏，不属于任何专项。Campaign 派生的 learn/eval 类子任务（如「复验本专项引用的经验卡」）goal 照常填、调度器限流帽（每 tick ≤1）照常生效——Campaign 不改变 goal 语义，只是多了一条产生这类任务的路径。

---

## 十二、看板与 UI（16-dashboard 扩展）

1. **安全中心新增「专项」tab**（平铺，符合 19-ui-unify 后的无二级导航结构）：专项卡片区（status 徽章/autonomy 徽章/进度环/预算条/heartbeat 时效徽章——复用授权时效徽章三态组件）+ 派生时间线 + 验收队列 + escalation 告警条。
2. **任务 tab**：任务行增 campaign 归属 chip（点击跳专项视图并按 campaign_id 过滤）；「定时任务卡片」区不变。
3. **单 program 工作区**：专项徽章挂在工作区（单 program 专项）；cross 专项只在安全中心平铺面出现（CONTEXT 红线：工作区外不另立项目概念——专项视图是**既有 Program/工作区概念的聚合投影**，不是新容器）。
4. **L1 放行队列**：`campaign_pending_drafts` 渲染为可勾选列表，一键 `campaign_dispatch`；每条草稿展示 strategy_key/引用经验卡/预估成本——**人看到的是编译后的硬约束结果，不是 LLM 原文**。
5. **降级链**：campaign 查询不可达 → 任务 tab 正常（campaign chip 隐藏），安全中心专项 tab 显示降级提示（沿用 B11 面板降级规范）。

---

## 十三、与定时任务的关系与迁移策略

1. **保留 interval**：资产巡检、授权时效巡检、候选 TTL 治理等「到点就该跑」的基线节奏，interval 是最简正确形态，不动。
2. **挖掘主线迁移**：现存的「每日漏洞挖掘」类 interval 任务（如有）→ 建议改为对应 program 的 Campaign（L1 起步），原 interval 任务在专项激活后 archive。迁移是**运营动作**（看板一键「转为专项」= campaign_create 预填 + 旧任务 archive），不做数据迁移。
3. **防双重调度**：INV-C7 已禁 campaign 子任务 interval；反向（interval 任务派生 campaign）不做——interval 任务无派生权（现有模型可见面不变）。

---

## 十四、契约测试矩阵（task 域新增用例规划，现状 47 例基线）

| 组 | 用例要点 | 数量 |
|---|---|---|
| 状态机 | 全流转合法/非法（含 reviewing 强制、archived 终态、activate 的 INV-C1/C4 门禁） | 8 |
| 派生闸 | INV-C5 通道唯一（静态断言）/ INV-C6 有界 / 双预算闸取严 / INV-C7 interval 禁止 | 6 |
| Planner | compileCampaignPlan 固定快照可重放：优先级排序、连败降权、经验卡提权、LLM 草稿过 H3 门禁 | 6 |
| 验收 | 四 verdict 分派、INV-C3 一任务一验收、INV-C8 证据门、goal_delta 聚合、spent_tokens 汇聚 | 7 |
| 监督 | 五类信号各一例（卡死/连败/空转/预算/授权漂移→pause） | 5 |
| 联动 | scope.revoked→pause、coverage.marked→缓存失效、release.revoked→草稿作废、tick 异常隔离 | 5 |
| 幂等 | create 自然键重放、dispatch 指纹重放、review_pass 重放 | 3 |

跨域影响面：know（+2 查询参数、+1 列、actor+1）约 4 例；approval（2 个新 kind 注册/validate/effect）约 4 例；dashboard（专项 tab 渲染 + 降级）UI 单测若干。setup 契约门槛与 `sec-v5-accept.sh` 同步扩充。

---

## 十五、分阶段实施（建议）

| Phase | 内容 | 验收 |
|---|---|---|
| **A · 台账与手动派生**（L0） | campaigns/checkpoints/decisions 三表 + Core 七命令五查询 + tasks 加列 + 看板专项 tab（只读+手动 dispatch） + Reviewer 自动验收落账 | 契约 +N 全绿；建一个真实 program 的 L0 专项跑一周，验收账本有人工价值 |
| **B · 规划与有界自动**（L1/L2） | Planner + Dispatcher + Supervisor + approval 两个新 kind + 预算双层闸 + pending_drafts 放行队列 | L1 跑一个 program 一周：草稿质量人工评估；达标后单 program 开 L2 观察 |
| **C · 交叉与学习深化** | cross 模式 + LearnLink 全量（know 维度扩展 L1–L4、L6） + campaign 维度记分投影 + eval 派生质量指标 | 双 program 交叉专项：经验卡跨 program 消费有正例、事实零跨域泄漏（查询谓词审计） |

每 Phase 独立部署、独立回滚（组件 feature flag：`SEC_CAMPAIGN_ENABLED` / `SEC_CAMPAIGN_PLANNER` / `SEC_CAMPAIGN_AUTONOMY_MAX`）；Phase A 上线即有价值（验收账本），B/C 出问题回滚不影响 A。

---

## 十六、风险与开放问题

1. **L2 的失控边界**：有界（INV-C6）+ 双闸 + 连败降级三重保险，但「自动派生的任务质量平庸、烧钱不出活」是 L2 的真实失败模式——缓解靠 Reviewer 验收账本驱动的预算速率降级（§7.4），以及 review_cadence 强制人审。**建议 L2 初期 budget 给极小值**（如 200k tokens/窗）。
2. **tick 时长**：单 tick 10 campaign ×（巡检+验收+编译）需 <60s；Planner 编译是纯函数无 LLM 调用（LLM 草稿只在能量耗尽时经独立 once 任务异步产，不阻塞 tick）——此设计是否足够待 Phase B 实证。
3. **goal_delta 的口径**：覆盖格点/confirmed 的「推进量」聚合依赖 ledger/vuln 域查询的稳定性；投影口径漂移风险用「goal_delta 落账时存快照、投影只聚合不重算」控制。
4. **交叉挖掘的经验污染**：去特化经验卡跨 program 消费的前提是蒸馏质量（B3 幻觉保底已挡无 oracle 证据的蒸馏）；Phase C 需加一条契约：cross 专项引用的经验卡必须 confidence≥medium。
5. **与既有「无主派生」的竞合**：endpoint.registered 等事件触发派生（21 号方案 Phase 3）与 Campaign 派生可能对同一 strategy_key 同时起草——strategy_dedupe 幂等兜底（先到者赢，后到者 deduped:true），设计上接受此竞态（幂等表就是干这个的）。
6. **开放问题**：① Campaign 与 program_bind_workspace 的关系——cross 专项是否需要「主工作区」概念承载会话上下文（倾向：不需要，专项视图即足够）；② L1 草稿的 LLM 生成走独立 once 任务（goal=research）以利用既有 worker 链（倾向：是）；③ `campaign_review_pass` 是否需要 effect 进 approval（倾向：否，人审动作本身在看板完成，approval 只管 autonomy/budget 两个升档点）。

---

> 本文经评审决策后，按治理规则回填：05-task（Campaign 全量契约）/ 07-know（§十一维度扩展）/ 09-approval（两个新 kind）/ 16-dashboard（专项 tab）/ 01-bus（事件注册表）/ CONTEXT.md（Campaign 术语条目），随后本文归档。

---

## 十七、2026-09-22 实施修订（评审后）

> 本文为设计真相源，实施后按治理规则回填 05/07/09/16/01/CONTEXT。以下为实施期相对本文的**有意修订**（评审确认）：

1. **C24 改名**：`campaign_goal_update` → `campaign_goal_revise`（总线 R2 禁用词「update」）。
2. **S1 L1 审批口径统一**：§7.1/§8.1 改为「L1 免审批、L2 强制审批」（与 INV-C4 一致），不再要求 L1 创建/升档走 `campaign-autonomy`。
3. **S4 tick 公平**：以 `last_tick_at` 升序实现准轮转（未做持久轮转指针）。
4. **B2 验收判据**：三源（oracle verdict / capsule 引用 / `vuln_get` finding 复核）+ 覆盖驱动角色成功判定；objective 模板文本不参与判定。
5. **B7**：checkpoint 增 kind `learn_gap`（LearnLink 去重用）；草稿预算预估环境变量 `SEC_CAMPAIGN_ESTIMATE_TOKENS_PER_DRAFT`。
6. **S2**：`campaign_dispatch` 草稿经 `sanitizeDraft` 收敛（枚举/phase/rationale）；优先级由 `task_derive_intent` 固定，不由调用方决定。
7. **B5**：Reviewer 为**异步订阅 + tick 补验双通道**（非 sync 强联动）。
8. **B1/B3/B4/B6**：忙碌 tick 也跑 campaign tick；effect 幂等键含 `approval_id`；campaign kind validate fail-closed；block/cancel actor 归 reactor。

完整修复清单见 [05-task §7.8](../05-task.md)。
