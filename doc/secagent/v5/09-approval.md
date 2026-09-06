# 09 · approval 域设计（统一审批中心 · kind 注册表 · 异步审批协议）

> 版本：v5.0 ｜ 状态：草案 ｜ 契约版本：1
> 依赖：**订阅：无**（approval 是联动源头，不订阅任何域——论证见 §1.5.4）；被订阅：`approval.approved`（scope 域 / task 域 / know 域 / fact 域 / exec 域，按 kind 过滤）、`approval.requested`·`approval.rejected`（看板通知、eval 域，弱联动）。
> 最高约定：[00-conventions.md](00-conventions.md)；本文与它冲突时以它为准。

---

## 一、对外暴露（External Surface）

### 1.1 服务标识与挂载

| 项 | 值 |
|---|---|
| 域名 | `approval` |
| cordis 服务名 | `secDomain.approval` |
| 插件包名 | `@silksec/sec-domain-approval` |
| 后端插件 | `@silksec/sec-backend-approval-sqlite` |
| owns（单写者） | `approval_requests` 表（沿用户库 `asset-graph.db`，不改名不迁库） |
| 事件 jsonl | `data/events/approval.jsonl` |

**域职责一句话**：持有全系统唯一的"人工放行"请求账本——agent 与自动接线点提请（kind 注册表校验判据）、人工经看板/CLI 裁决；**批准的唯一副作用是发布 `approval.approved` 事件**，各域订阅后执行自己的命令（v4.x `onApprove` 跨域直写四处的问题由此根除）。

**与 scope 域的边界**：approval 只管"请求与裁决"的状态机；授权/规则/预算的实际变更全部由 scope/task/know 域在自己的订阅处理器里执行。approval 域 commands **不 dispatch 任何其他域的命令**（结构性保证"批准前 fail-closed 不变"，见不变量 I5）。

**挂载矩阵**（profile × actor 白名单）：

| profile | 注册给模型的工具 | 仅看板/人工的动词 |
|---|---|---|
| web（宿主面） | `approval_request` / `approval_list` / `approval_withdraw` | `approval_decide`（actor: dashboard/human） |
| headless（worker） | 同上（worker 提请审批是常态——候选授权资产发现于 worker 会话） | 同上 |

### 1.2 命令（写动词）总表

| 命令 | 一句话语义 | actor 白名单 | 幂等键 | 发布事件 |
|---|---|---|---|---|
| `approval_request` | 提请审批（kind 注册表 validate 内聚；同 (kind,subject) pending 去重） | model / script / system / scheduler（**按 kind 收窄**，见各 kind `request_actors`） | 自然键 `{kind}:{subject}` | `approval.requested` |
| `approval_decide` | 人工裁决 pending → approved \| rejected（**副作用 = 只发事件**） | dashboard（operator 必填）/ human | 自然键 `{request_id}:{decision}` | `approval.approved` / `approval.rejected` |
| `approval_withdraw` | 原提请者撤回自己的 pending 请求（落 rejected 终态 + 撤回标记） | model（原提请者）/ human | 自然键 `{request_id}` | `approval.rejected`（`withdrawn: true`） |

### 1.3 命令逐个详述

#### 1.3.1 `approval_request`

统一审批提请。validate **内聚在域内**（kind 注册表的规则表驱动），调用方无法绕过判据结构化——v4.x `APPROVAL_KINDS[kind].validate` 的注册表模式保留并声明式化（§2.2.2）。

**参数 schema**（`additionalProperties: false`；kind 专属判据字段**平铺在顶层**，与 v4.x 工具面兼容——域内组装为 payload 列）：

| 参数 | 类型 | 必填 | 默认 | 校验规则 |
|---|---|---|---|---|
| `kind` | string | 是 | — | enum = 注册表全部 kind（§2.2.2；模型面投影只渲染 `request_actors` 含 model 的子集）；未知 → `E_SCHEMA` |
| `subject` | string | 是 | — | 1..500 字符；kind 专属规则见各 kind 表 |
| `program_name` | string | kind 依赖 | `''` | scope-* / exclude-exception / tool-intrusive / task-budget-extend 必填；knowledge-adopt 可空 |
| `evidence` | string | 是 | — | ≥10 字（通用下限）；kind 专属下限见各 kind 表 |
| `equity_basis` | string | kind 依赖 | — | enum `控股/全资`、`收购/财团`、`品牌/产品线`、`技术印证`、`其他`（scope 域类判据，口径 `data/rules/src/equity-gate.md`） |
| `independent_src` | string | kind 依赖 | — | enum `无`、`有`、`不确定` |
| `corroboration` | string | 否 | `''` | ≤500 字旁证 |
| `card_id` | integer | 否 | — | knowledge-adopt：exp_cards 卡 id（正整数） |
| `draft` | string | kind 依赖 | — | knowledge-adopt：蒸馏后可迁移模式，≥50 字 |
| `source_url` | string | kind 依赖 | — | knowledge-adopt：`^https?:\/\/\S{4,}$` |

`requested_by` **不是参数**：网关从调用面注入（model → session_id；scheduler → `scheduler:auto`；system → 接线点标识），调用方声明的同名字段一律忽略（宪法 §三.1）。

**pending 去重（不变量 I2）**：同 `(kind, subject)` 已有 pending 行 → `E_APPROVAL_PENDING_EXISTS`（message 带既有 request_id，hint 引导等待或补证）。这与幂等表互补：幂等表管"同命令重放"（7 天窗口），I2 管"跨会话/跨进程的重复提请"（窗口 = pending 存续期）。**已决策后再提同 (kind,subject) 是允许的**——决策可演化（驳回后补新证据重提是正常流）。

**返回信封**（成功）：

```json
{
  "ok": true, "domain": "approval", "cmd": "request",
  "data": {
    "request_id": 57, "kind": "scope-wildcard", "subject": "example.com",
    "status": "pending",
    "payload": { "equity_basis": "控股/全资", "independent_src": "无", "domain_level": "apex", "corroboration": null },
    "hint": "已提请人工审批（看板「审批」tab）。批准前目标仍被 fail-closed 拒绝，不要尝试打点。"
  },
  "event_ids": ["evt_01J..."], "idempotency_key": "approval:request:scope-wildcard:example.com", "replay": false
}
```

**错误码**：

| code | 触发 | retryable | hint |
|---|---|---|---|
| `E_SCHEMA` | kind/enum/长度/URL 格式/未知参数 | false | message 含字段与期望 |
| `E_INVARIANT` | kind 专属交叉校验失败（已在 scope / apex 判定 / 排除清单命中 / 任务不存在等，message 指明哪条） | false | 各 kind 表的"validate 规则"列即 hint 文案来源 |
| `E_APPROVAL_KIND_ACTOR` | actor 不在该 kind 的 `request_actors` 内（如 model 直提 tool-intrusive） | false | 该 kind 只由 XX 接线点自动提请，不可人工代提 |
| `E_APPROVAL_PENDING_EXISTS` | 同 (kind,subject) pending 去重命中 | false | 同对象已有待审批请求 #N——勿重复提请，可等决策或补充证据后在新请求中体现 |

**幂等**：自然键 `approval:request:{kind}:{subject}`（7 天窗口；pending 期内同键同参 → 首次结果 + `replay: true`）。

**actor**：model（agent 提请）/ script / system（exec 守卫接线点）/ scheduler（超时接线点）——**再按 kind 收窄**（§2.2.2 各 kind `request_actors`）；dashboard / approval / webhook 不可提请。

**异步审批协议（v4.5 保留设计，全文）**：所有「运行时被硬拒绝但可人工放行」的决策点统一转化为——

```
同步拒绝不变（fail-closed 当场生效）
  → 自动落 approval_requests（kind 专属，payload 带完整重试上下文）
  → 返回 approval_hint 告知 agent 勿重试（sec-runtime-discipline 第 13 条）
  → 人工批准 → 订阅方写白名单/预算（经各自域命令）
  → 下个调度周期重试自然放行（不中断当前 run、不即时执行）
```

**两个接线决策点的事件化路径**（v4.x 在 runCli/scheduler 内直调 `assetDb.approvalAdd`；v5 改经命令 dispatch）：

| 决策点 | v4.x 位置 | v5 路径 |
|---|---|---|
| ① `tool-intrusive` | runCli 的 checkRisk `needsApproval` 分支 + S5 写动词守卫分支 | exec 域守卫链 → `dispatch('approval','request', {...}, {actor:'system'})`；payload 先经脱敏（params 截断打标，v4.x `sanitizeParamsForApproval` 语义，脱敏责任在**提请方**——approval 域只做"值均为短标量（≤60 字符或带截断标记）"的防绕过校验） |
| ② `task-budget-extend` | scheduler 超时分支（worker 跑满 3600s 被杀且尾部有产出迹象才提） | scheduler → `dispatch('approval','request', {...}, {actor:'scheduler'})`；幂等去重靠 I2 |

**副作用声明**：`rows_touched: approval_requests(+1)`、`events: approval.requested`。**零执行面副作用**——不碰 scope/exec/task 任何状态（不变量 I5）。

#### 1.3.2 `approval_decide`

人工裁决。**批准的副作用 = 只发布 `approval.approved` 事件**（驳回发 `approval.rejected`）——本命令自身不改任何其他域的数据。

**关于 `decision` 参数与"动词即状态机入口"的说明**：`decision: approve|reject` 是**封闭二值枚举的裁决语义参数**（两个目标终态的选择），不是自由态 `status` 注入——等价于 `approval_approve` / `approval_reject` 两个动词在看板单页交互上的合并投影；宪法 §四.1 禁的是"调用方任意传 status"的开放集合，此处集合封闭且网关校验。

**参数 schema**：

| 参数 | 类型 | 必填 | 默认 | 校验规则 |
|---|---|---|---|---|
| `id` | integer | 是 | — | 请求须存在 → `E_NOT_FOUND` |
| `decision` | string | 是 | — | enum `approve` / `reject` → 其他 `E_SCHEMA` |
| `note` | string | 否 | `''` | ≤2000 字；批准时自动拼接订阅方执行结果摘要（见返回） |
| `operator` | string | dashboard actor 必填 | — | auth-gate 用户名（网关从 RPC 连接注入，**调用方不可自报**）；human actor 时取 CLI `--operator`，缺省 `''` |

**返回信封**（成功，approve）：

```json
{
  "ok": true, "domain": "approval", "cmd": "decide",
  "data": {
    "request_id": 57, "kind": "scope-wildcard", "subject": "example.com",
    "status": "approved", "operator": "singll",
    "effect": "*.example.com + example.com 已加入项目 example-src 授权范围（全子域 fail-closed 即时生效）；种子任务 #812 已入队（5 分钟后派发）；radar 事件已入队"
  },
  "event_ids": ["evt_01J..."], "idempotency_key": "approval:decide:57:approve", "replay": false
}
```

`effect` 字段是**订阅方执行结果的回显汇编**（强联动订阅者返回的 note 拼接）——看板操作者据此确认闭环，不需要再查各域。

**错误码**：

| code | 触发 | retryable | hint |
|---|---|---|---|
| `E_NOT_FOUND` | 请求不存在 | false | 核对 request_id（approval_list 可查） |
| `E_STATE` | 请求已处于终态 | false | 请求 #N 已决策（approved/rejected），勿重复操作 |
| `E_BACKEND_UNAVAILABLE` / `E_CONFLICT` | 落库失败 / 并发裁决 | true | 稍后重试 |
| （透传）订阅方命令错误码 | 强联动订阅者失败 | 视订阅方 | message 形如 `批准联动失败: <订阅方错误>（请求保持 pending，可修复后重试或驳回）`——**decide 整体回滚，status 仍 pending** |

**幂等**：自然键 `approval:decide:{id}:{decision}`。并发的两个 decide → 一成一 `E_STATE`（或经 `E_CONFLICT` 串行化，契约测试断言）。

**actor**：dashboard（operator 必填）/ human。**model / system / scheduler / approval 一律不可裁决**——审批裁决是全系统模型禁入区的核心（宪法 §三）。

**RoE**：批准 scope-wildcard 前人工核对判据 chip（payload 的 equity_basis/independent_src/evidence）；`independent_src=有` 的整域请求 validate 已拦，看板仍应肉眼复核（双保险）。

**副作用声明**：`rows_touched: approval_requests(1 行 status/decided_at/note)`、`events: approval.approved 或 approval.rejected`、`caches: 无`。

#### 1.3.3 `approval_withdraw`

原提请者撤回自己的 pending 请求（发现提错对象/判据填错时自查自救，避免污染审批队列）。

**参数 schema**：

| 参数 | 类型 | 必填 | 校验规则 |
|---|---|---|---|
| `id` | integer | 是 | 请求须存在且 `status='pending'` → `E_NOT_FOUND` / `E_STATE` |
| `reason` | string | 否 | ≤500 字 |

**落库语义**：置 `status='rejected'`、`decided_at=now`、`note='[已撤回]' + reason`、`requested_by` 不变。**不引入新终态**——表 CHECK 约束 `status IN ('pending','approved','rejected')` 不动（SQLite 无法 ALTER CHECK，重建表的风险大于收益）；`withdrawn` 语义由 note 前缀 + 事件 payload 的 `withdrawn: true` 承载，`approval_stats` 按 note 前缀区分撤回与驳回（开放问题 O-2 记录表重建时引入独立终态的选项）。

**权限**：model actor 时网关校验 `requested_by === 当前 session_id`；不匹配 → `E_APPROVAL_WITHDRAW_FORBIDDEN`（hint：`只能撤回自己提请的请求——他人请求请等待人工裁决`）。human 可撤回任意（应急通道，审计高亮）。

**返回信封**：`data: { request_id, status: "rejected", withdrawn: true }`。

**幂等**：自然键 `approval:withdraw:{id}`。

**事件**：`approval.rejected`（payload `withdrawn: true`）——驳回类订阅方（若有统计）自然兼容。

### 1.4 查询（读投影）逐个详述

#### 1.4.1 `approval_list`

**参数**：`kind: string = ''`（精确）、`status: string = ''`（pending/approved/rejected，空=全部）、`limit = 50（上限 500）`、`offset = 0`。

**排序契约**：**pending 恒在最前**，组内 `created_at DESC`（v4.x 语义原样保留——审批 tab 第一屏永远是待办）。

**返回**：分页信封，行结构：

```json
{ "rows": [{
    "id": 57, "kind": "scope-wildcard", "subject": "example.com", "program_name": "example-src",
    "payload": { "equity_basis": "控股/全资", "independent_src": "无", "domain_level": "apex", "corroboration": null },
    "evidence": "ICP 备案主体为 XX 科技有限公司，与 SRC 规则页主体一致……",
    "status": "pending", "requested_by": "sess_a1b2", "created_at": 1789000000000,
    "decided_at": null, "note": null
  }], "total": 1, "limit": 50, "offset": 0 }
```

`payload` 列解析为 JSON 对象返回（存储为 TEXT JSON）。**看板审批 tab 的判据 chip 数据来源 = 本查询行内的 `payload` 字段**（equity_basis / independent_src / corroboration / tool / budget_timeout_sec 等 kind 专属判据键直接渲染 chip；payload 为空的行不渲染 chip）。

#### 1.4.2 `approval_stats`

**参数**：`since_days: integer = 30`。

**返回**（聚合查询，独立命名，宪法 §七.5）：

```json
{ "by_kind": [{ "kind": "scope-wildcard", "pending": 1, "approved": 3, "rejected": 1, "withdrawn": 0 }],
  "pending_total": 4, "pending_oldest_days": 2.3,
  "avg_decide_hours": 5.6, "by_decider": [{ "operator": "singll", "approved": 12, "rejected": 3 }] }
```

看板审批 tab 头部统计条 + 看板 ops 红条（pending >7 天告警）的数据源。

### 1.5 事件

#### 1.5.1 `approval.requested`

```json
{ "id": "evt_01J...", "domain": "approval", "name": "requested", "ts": 1789000000000,
  "actor": "model", "session_id": "sess_a1b2",
  "cause": { "cmd": "approval_request", "idempotency_key": "approval:request:scope-wildcard:example.com" },
  "payload": { "request_id": 57, "kind": "scope-wildcard", "subject": "example.com",
    "program_name": "example-src", "payload": { "equity_basis": "控股/全资", "independent_src": "无" },
    "requested_by": "sess_a1b2" } }
```

订阅方：看板通知（弱——审批 tab 徽标 + 红条）、eval 域（弱——提请行为回流）。

#### 1.5.2 `approval.approved` —— 全系统最重要的事件之一

批准 = 人工对某判据的背书 + 授权下游执行。payload 必须自包含（**kind + 判据 payload + subject + operator**），订阅方不需要回查就能决策：

```json
{ "id": "evt_01J...", "domain": "approval", "name": "approved", "ts": 1789000000000,
  "actor": "dashboard", "operator": "singll",
  "cause": { "cmd": "approval_decide", "idempotency_key": "approval:decide:57:approve" },
  "payload": {
    "request_id": 57, "kind": "scope-wildcard", "subject": "example.com",
    "program_name": "example-src",
    "payload": { "equity_basis": "控股/全资", "independent_src": "无", "domain_level": "apex", "corroboration": null },
    "evidence": "……", "operator": "singll", "note": null
  } }
```

#### 1.5.3 `approval.rejected`

payload 同 approved + `note`（驳回理由，看板必填引导）+ `withdrawn: boolean`（撤回时 true）。

#### 1.5.4 订阅：无——论证

approval 域 manifest `subscribes` 为空数组。理由：

1. **approval 是联动源头，不是联动消费者**：其状态机（pending → approved/rejected）完全由自身数据 + 人工裁决驱动，没有任何业务规则需要"对外部域的状态变化做出反应"。
2. **validate 所需的外部状态是即时校验输入，不是联动触发器**：`approval_request` 的 validate 需要读 scope.yml（"已在授权范围无须审批"）、programs（项目存在性）、know 域收割草稿状态（knowledge-adopt 的 card_id/scenario 对卡）——这些全部经**查询网关同步读**（`scope_list` / `scope_check` / know 域 `harvest_status`），而非订阅。宪法 §八.6 的订阅声明机制是为"状态变化驱动的联动"设计的；把校验输入做成订阅反而引入时序耦合（订阅回放期间提请会读到旧状态，而同步查询永远读到当下）。
3. **knowledge-adopt 的"例外"其实也是查询**：它需要 harvest 草稿状态（card_id 是否存在、scenario 是否已有同款卡）——这是提请时的一次性判定，用 know 域查询即满足；若未来出现"草稿状态变化要自动作废已提请求"的规则，才需要订阅（记入开放问题 O-4）。

#### 1.5.5 事件协作时序图（替代 v4.x onApprove 四处直写的完整 Choreography）

v4.x 批准副作用直写四处：`serializeScope` 写回（scopeSaveProgram）、`taskCreate` 种子任务、radar-queue 追加、fact 写入（exclude-exception）。v5 全部事件化：

```
模型(worker)      approval 域         scope 域            task 域         ledger 域       fact 域
   │                 │                   │                  │               │              │
   │ approval_request │                   │                  │               │              │
   │ (kind=scope-    │                   │                  │               │              │
   │  wildcard)      │                   │                  │               │              │
   │────────────────>| validate（读 scope 域查询）           │               │              │
   │<─request_id─────│ 落库 pending       │                  │               │              │
   │                 │─approval.requested（弱）─> 看板徽标   │               │              │
   │                 │                   │                  │               │              │
   [看板] approval_decide(id, approve, operator)             │               │              │
   │                 │                   │                  │               │              │
   │                 │─approval.approved（强,sync）─────────>|              │              │
   │                 │                   │ scope_grant       │               │              │
   │                 │                   │ (entries=[*.x.com,│              │              │
   │                 │                   │  x.com] 双条目)   │               │              │
   │                 │                   │─scope.granted（弱）─> task_create │              │
   │                 │                   │  （[审批入队]种子） │               │              │
   │                 │                   │─scope.granted（弱）──────────────>|              │
   │                 │                   │                   │               │ ledger_radar_push
   │                 │<─effect(note)─────│（强联动成功回执） │               │              │
   │                 │ 事务提交: pending→approved             │               │              │
   │                 │                   │                  │               │              │
   │                 │（kind=exclude-exception 时：fact 域订阅 approval.approved（弱）→ fact_upsert  │
   │                 │  durable scope/exception-{host}；scope 域 grant 吸收排除项）              │
   │                 │                   │                  │               │              │
   [强联动失败示例] scope_grant 报 E_NOT_FOUND（项目已被移出 yml）                            │
   │                 │<─联动失败─────────│                  │               │              │
   │                 │ decide 整体回滚：请求保持 pending，返回错误（人工修复后重试或驳回）      │
```

**异步审批协议的两个接线决策点（事件化路径）**：

```
worker 模型                 exec 域守卫链              approval 域            scope 域
   │ run_cli(sqlmap)           │                          │                    │
   │──────────────────────────>| checkRisk → intrusive 超allow_risk             │
   │                           │ 同步拒绝（fail-closed 当场生效，needs_approval） │
   │                           │─approval_request（actor=system）──────────────>│
   │                           │  payload={tool,risk,target,params(脱敏),program}│ 落库 pending
   │<─error + approval_hint────│                          │                    │
   │  （勿重试——纪律第13条）     │                          │                    │
   [人工批准 tool-intrusive]     │                          │                    │
   │                           │                          │─approval.approved（强）─> scope_rules_apply
   │                           │                          │                    │ (allow_intrusive_tools_add)
   │                           │                          │                    │─scope.rules.changed（强）─> exec 缓存刷新
   [下个调度周期] worker 重试 run_cli(sqlmap) → checkRisk 白名单放行 → 自然执行（无需感知审批存在）
```

task-budget-extend 同构：scheduler 超时分支 → `approval_request`（actor=scheduler，payload 含 task_id/run_id/tail 完整重试上下文）→ 人工批准 → task 域订阅 `approval.approved` → task 预算动词写 `tasks.budget_timeout_sec`（≤7200 封顶）→ 下周期 runWorker 取 `max(默认, 该值)`。

### 1.6 模型工具面投影（模型实际看到的工具名 + 描述全文）

`approval_decide` **不向模型注册**（actor 白名单无 model）。

| 工具名 | 描述全文（manifest agent_note 单一来源） |
|---|---|
| `approval_request` | 统一审批入口（fail-closed 之下的正规放行通道）：向人工提请审批。类型判定口径：①整个注册域归属该项目（主体核证级证据：ICP 备案主体/官网品牌一致/收购公告/SRC 规则页明示）→ kind=scope-wildcard，一次审批覆盖 *.example.com 全部子域；②仅单个子域有具体归属证据（CNAME 指向授权资产/内容同源比对）→ kind=scope-domain，subject 填完整子域，禁止拿裸 apex 走单域通道；③被排除资产的人工评估 → exclude-exception；④外部经验（writeup/案例）蒸馏采纳进经验库 → kind=knowledge-adopt（payload: card_id 可选/draft ≥50 字/source_url 必填）。资产收集发现疑似 scope 外资产时必须提请，禁止只写事实不提请求，也禁止把归属不确定的资产凑数提请。股权判据口径见 data/rules/src/equity-gate.md：100% 控股算、参股/投资不算、有自身 SRC 渠道的不并入。登记是被动观察行为：批准前目标依旧被 scope-guard fail-closed 拒绝，授权边界不变。 |
| `approval_list` | 查询审批请求（pending 恒在最前；可按 kind/status 筛选）。查看自己提请的请求状态、判据是否被驳回及原因。 |
| `approval_withdraw` | 撤回自己提请的 pending 审批（提错对象/判据填错时自查自救）。只能撤回 requested_by 为自己会话的请求。 |

### 1.7 看板 RPC 投影

| RPC 名 | 对应命令/查询 | 说明 |
|---|---|---|
| `approval.list` | approval_list | 审批 tab 主列表（替代 v4.x approvalList case）；**判据 chip = 行内 payload 字段直渲染** |
| `approval.decide` | approval_decide | 审批 tab 批准/驳回按钮（替代 v4.x approvalDecide case）；operator 从 auth-gate 注入 |
| `approval.stats` | approval_stats | tab 头统计条 + ops 红条（pending >7 天） |
| `approval.withdraw` | approval_withdraw | 审批行"撤回"（仅原提请会话可见） |

### 1.8 外部调用示例

**模型调用**（worker 会话）：

```json
{ "tool": "approval_request", "args": {
    "kind": "scope-domain", "subject": "www.example.com", "program_name": "example-src",
    "equity_basis": "技术印证", "independent_src": "无",
    "corroboration": "CNAME 指向已授权资产 lb.example.com",
    "evidence": "www.example.com CNAME 解析到本项目已授权资产 lb.example.com，页面 footer 主体与 SRC 规则页一致（核证于 2026-09-06）" } }
→ { "ok": true, "data": { "request_id": 58, "status": "pending",
    "hint": "已提请人工审批（看板「审批」tab）。批准前目标仍被 scope-guard 拒绝，不要尝试打点。" } }
```

**代码调用**（exec 域守卫链自动接线，actor=system）：

```js
bus.dispatch('approval', 'request', {
  kind: 'tool-intrusive', subject: `sqlmap:${target}`, program_name: programId,
  payload: { tool: 'sqlmap', risk: 'intrusive', target, params: sanitizeParams(params), program: programId },
  evidence: `intrusive 工具 sqlmap（risk=intrusive）对 ${target} 的调用被 allow_risk 拒绝，请求人工放行`,
}, { actor: 'system', source: 'exec-guard:checkRisk' })
```

**人工 CLI 调用**（应急通道，审计高亮）：

```bash
sec domain approval call approval_decide --actor human --operator singll \
  --id 57 --decision approve --note '备案主体核对一致'
```

---

## 二、内部实现（Internal）

### 2.1 数据模型（owner：本域单写者）

`approval_requests` 表（DDL 沿用 v4.3，sqlite-local 后端接管，**不改列不迁库**）：

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `id` | INTEGER | PK AUTOINCREMENT | 请求号（全链路引用键：approval_hint / effect / 订阅方 cause.request_id） |
| `kind` | string | NOT NULL | 审批类型（注册表键；**连字符命名是数据值**，不受标识符 snake_case 规范约束，v4.x 值原样保留） |
| `subject` | string | NOT NULL | 审批对象（域名 / `tool:target` / `task:{id}` / 经验卡 scenario） |
| `program_name` | string | nullable | 建议归属项目 |
| `payload` | string (JSON TEXT) | nullable | **kind 专属判据结构化快照**（§2.2.2 各 kind payload schema；看板判据 chip 数据源） |
| `evidence` | string | NOT NULL | 归属证据/依据摘要（validate 长度下限） |
| `status` | string | NOT NULL DEFAULT 'pending' CHECK IN (pending, approved, rejected) | 状态机列 |
| `requested_by` | string | nullable | 提请者细粒度身份（session_id / `scheduler:auto` / `exec-guard:…`）——**网关注入** |
| `created_at` | INTEGER | | UTC epoch ms |
| `decided_at` | INTEGER | nullable | 裁决时刻 |
| `note` | string | nullable | 裁决 note + 订阅方 effect 汇编；撤回时 `[已撤回]` 前缀 |

索引（沿用）：`idx_approval_status(status, created_at DESC)`、`idx_approval_pending(kind, subject, status)`（I2 去重查询路径）。

### 2.2 状态机与不变量

#### 2.2.1 状态机

```
                 approval_request（validate 通过 + I2 去重）
  (不存在) ─────────────────────────────────────────> pending
                          │                              │
        approval_decide(approve)              approval_decide(reject)
        [强联动订阅者全部成功才提交]                      │ approval_withdraw（原提请者）
                          │                              │ （落 rejected + [已撤回] 标记）
                          ▼                              ▼
                      approved                      rejected
                      （终态）                       （终态）
```

**网关前置不变量清单**：

| # | 不变量 | 失败错误码 |
|---|---|---|
| I1 | kind ∈ 注册表（manifest 声明枚举；模型面投影按 request_actors 收窄渲染） | `E_SCHEMA` |
| I2 | 同 `(kind, subject)` 至多一条 pending | `E_APPROVAL_PENDING_EXISTS` |
| I3 | decide/withdraw 只允许 `pending → approved \| rejected`；终态不可再流转 | `E_STATE` |
| I4 | evidence ≥10 字（通用）+ kind 专属下限（§2.2.2）；请求判据字段经 kind validate 全量通过 | `E_SCHEMA` / `E_INVARIANT` |
| I5 | **批准前 fail-closed 不变（结构性）**：approval 域 commands 不 dispatch 任何其他域命令、不写 approval_requests 以外的任何表/文件——提请是纯登记，执行面状态零变化。守卫链的拒绝语义在批准前不可能被本域任何路径软化 | （结构保证；eval 契约合规用例覆盖：`模型试图经 approval_request 后立即重试被拒目标 → 仍被拒`） |
| I6 | kind 的 `request_actors` 收窄（tool-intrusive 仅 system、task-budget-extend 仅 scheduler） | `E_APPROVAL_KIND_ACTOR` |
| I7 | withdraw 权限：model actor 限原提请者（requested_by == session_id）；human 任意 | `E_APPROVAL_WITHDRAW_FORBIDDEN` |

#### 2.2.2 kind 注册表（声明式，manifest `kinds` 段）

v4.x `APPROVAL_KINDS`（sec-suite.js L494-813）从代码对象迁移为 manifest 声明：每 kind 一个条目，字段 = `label` / `request_actors` / `subject_rule` / `payload_schema` / `validate`（规则表）/ `on_approve`（**纯事件映射**——approve 后发什么事件、谁订阅执行什么命令）。**新增审批类型 = 注册表加条目，工具面/RPC/看板零改动**（v4.x 注册表的核心收益保留）。

**kind 1：`scope-wildcard`（整域授权·通配）** —— v4.5 整域通配口径

| 项 | 值 |
|---|---|
| label | 整域授权(通配) |
| request_actors | model |
| subject_rule | 裸 apex 注册域（`hostRoot(subject) === subject`，注册域近似算法：末两标签，.com.cn 等双后缀取三） |
| payload_schema | `{ equity_basis: enum[控股/全资, 收购/财团], independent_src: enum[无, 有, 不确定] 且 ≠有, domain_level: const 'apex', corroboration?: string }` |
| validate | ① hostOf 可解析；② subject 是 apex（子域 → `E_INVARIANT`，hint 引导走 scope-domain）；③ program 在 scope.yml（读 scope_list）；④ `*.subject` 或裸域已在项目 scope（→ 无须审批，`E_INVARIANT`）；⑤ equity_basis 仅 控股/全资 或 收购/财团（品牌/产品线/技术印证不足以开整域）；⑥ independent_src 必填且 ≠有（有自身 SRC 渠道不并入——H-004 教训）；⑦ evidence ≥30 字且须主体核证级（ICP 备案主体/收购公告/SRC 规则页明示） |
| 事件映射（approve） | `approval.approved` → **scope 域**（强）`scope_grant`（entries = `["*.x.com","x.com"]` **双条目**——对齐 v4.x 批准写回形态，根因：09-04 批准裸 apex 次日 recon 对 www 子域照样被拒的覆盖缺口）→ `scope.granted` → **task 域**（弱）种子任务 + **ledger 域**（弱）radar 追加 |
| 事件映射（reject） | 无执行订阅方（决策留痕） |

**kind 2：`scope-domain`（单子域授权）**

| 项 | 值 |
|---|---|
| label | 授权域名 |
| request_actors | model |
| subject_rule | 完整子域（hostRoot(subject) !== subject） |
| payload_schema | `{ equity_basis: enum[全部五值], independent_src: enum[无,有,不确定], domain_level: const 'subdomain', corroboration?: string }` |
| validate | ① hostOf 可解析；② program 在 scope.yml；③ 不在任何项目授权范围（读 scope_check——已授权无须审批）；④ 命中排除清单 → 引导改提 exclude-exception；⑤ subject 是裸 apex → **拒绝并引导改提 scope-wildcard**（防"逐子域提审批"口径缺口复现）；⑥ equity_basis/independent_src 必填；⑦ evidence ≥30 字且含具体归属证据（CNAME 指向授权资产/内容同源/主体核证——"疑似/字典枚举"不构成依据） |
| 事件映射（approve） | `approval.approved` → scope 域（强）`scope_grant`（entries=[subject]）→ `scope.granted` → task/ledger（弱，同 wildcard） |

**kind 3：`exclude-exception`（排除例外评估）** —— 被排除资产的人工评估正规入口

| 项 | 值 |
|---|---|
| label | 排除例外 |
| request_actors | model |
| subject_rule | 须命中目标项目 exclude 清单（entryMatches 语义） |
| payload_schema | `{ equity_basis: enum[全部五值] }` |
| validate | ① hostOf 可解析；② program_name 必填且在 scope.yml；③ subject 在该项目排除清单中（不在 → 引导走 scope-domain）；④ equity_basis 必填（解除排除须给出比 scope-domain 更强的归属证据） |
| 事件映射（approve） | `approval.approved` → **scope 域**（强）`scope_grant`（**授权吸收排除**：条目移出 exclude 并入 scope，08 §1.3.1 吸收语义）→ `scope.granted`；**fact 域**（弱）`fact_upsert`（durable，`fact_key = scope/exception-{host}`，summary"排除例外已批准"，留档失败不阻断——v4.x best-effort 语义保留） |
| 事件映射（reject） | 无（维持排除，决策留痕） |

**kind 4：`tool-intrusive`（侵入工具放行）** —— 异步审批接线点 ①

| 项 | 值 |
|---|---|
| label | 侵入工具放行 |
| request_actors | **system**（exec 域守卫 checkRisk needsApproval 路径 + S5 写动词守卫路径自动提请；**model 直提拒绝**——agent 无法替人工编 evidence） |
| subject_rule | `{tool}:{target}` |
| payload_schema | `{ tool: string, risk: string, target: string|null, params: object（脱敏：短标量原样、>60 字截断打标、复合值 `[list:N]`——脱敏在提请方，本域只校验值均为短标量）, program: string, guard?: string, verb?: string, url?: string }` |
| validate | ① payload.tool 非空；② program 在 scope.yml；③ params 值域校验（防绕过脱敏直灌长文本/凭据特征——命中 `Bearer `/长 base64 特征 → `E_INVARIANT`） |
| 事件映射（approve） | `approval.approved` → **scope 域**（强）`scope_rules_apply`（`allow_intrusive_tools_add: [tool]`）→ `scope.rules.changed` → **exec 域**（强）白名单缓存刷新 → 下个调度周期任务重试自然放行（S5 写动词守卫与风险闸同源放行） |
| 幂等 | on_approve 侧：tool 已在白名单 → scope_rules_apply 数据级幂等（before==after 成功返回） |

**kind 5：`task-budget-extend`（任务预算延长）** —— 异步审批接线点 ②

| 项 | 值 |
|---|---|
| label | 任务预算延长 |
| request_actors | **scheduler**（超时分支：worker 跑满 3600s 被杀**且尾部有产出迹象**才提——纯空跑不配延预算） |
| subject_rule | `task:{id}` |
| payload_schema | `{ task_id: integer, program: string, timed_out_at_sec: integer, budget_timeout_sec: integer = 7200, run_id: string|null, tail: string（尾部产出摘要，≤400 字） }` |
| validate | ① task_id 存在（读 task 域查询）；② budget_timeout_sec ≤7200（封顶，防 2 小时外失控 worker 占死调度槽） |
| 事件映射（approve） | `approval.approved` → **task 域**（强）任务预算动词（写 `tasks.budget_timeout_sec`，7200 封顶；05-task.md 定义，工作名 `task_budget_extend`）→ 下周期 runWorker 取 `max(默认, 该值)` |
| 事件映射（reject） | 无（维持默认预算） |

**kind 6：`knowledge-adopt`（知识采纳）** —— 外部经验蒸馏入库

| 项 | 值 |
|---|---|
| label | 知识采纳 |
| request_actors | model |
| subject_rule | 经验卡 scenario 一句话，≥8 字 |
| payload_schema | `{ card_id?: integer（exp_cards.id；draft 直落新卡时不传）, draft: string ≥50 字（蒸馏后可迁移模式——原文摘抄/链接描述不构成 draft）, source_url: string（http(s) 完整 URL，外部知识须可溯源） }` |
| validate | ① subject ≥8 字；② draft ≥50 字；③ source_url 合法；④ card_id 为正整数或空；⑤ evidence ≥30 字（为什么值得采纳：覆盖哪个知识缺口/哪个案例支撑/与现有卡的差异）；⑥ card_id/scenario 对卡状态读 know 域查询（harvest 草稿状态——**同步查询，非订阅**，§1.5.4 论证） |
| 事件映射（approve） | `approval.approved` → **know 域**（强）`know_adopt`（07-know：card_id 有 → 转正对应 candidate 卡；只有 draft → 落新卡 source=external confidence=low 并直接转正；FTS 索引同步。v4.x 的"降级出口"（经验库不可达 → 批准有效+人工转正 note）在 v5 收紧为强联动失败即 decide 回滚——本地 sqlite 后端下不可达属异常态，人工可修复后重试） |

**kind 7：`task-complete`（自执行任务完成确认）** —— 05-task C16/C17 三段式收尾的审批段

| 项 | 值 |
|---|---|
| label | 任务完成确认 |
| request_actors | model（C16 声明）/ scheduler（统一拦截任务兜底补提） |
| subject_rule | `task:{task_id}`（正整数 id；task 域同步查询校验存在、assignee=model、非终态——**同步查询，非订阅**，同 kind 6 模式） |
| payload_schema | `{ task_id: integer, summary: string ≥30 字（做了什么/结论）, evidence: string（产物指针：run_id / result note 引用）, follow_up?: string ≤500 字（希望人工顺带裁决的后续操作建议）, guard_snapshot?: object（三产物检查快照，拦截任务补提时携带） }` |
| validate | ① task 存在且 assignee=model 且非终态（否则 `E_INVARIANT`，hint："task-complete 只用于模型自执行任务；worker 型任务的收尾由调度器 task_finish 自动完成"）；② 无活动 worker（task_active_by_session）；③ summary ≥30 字；④ evidence 非空 |
| 事件映射（approve） | `approval.approved` → **task 域**（强）`task_complete`（C17：status→done + finished_at + result 追加"人工确认 {request_id} + summary"）。三产物守卫降为展示不拦截——守卫结果已在 payload 呈现，**人工裁决即守卫**（fail-open 合法形态：放行决策权在人，全程审计留痕） |
| 事件映射（reject） | 无执行订阅方（任务保持 in_progress + 驳回理由进审批留痕；用户看板 task_block/cancel 收尾或模型补证重新声明） |

### 2.3 事务与联动实现

**`approval_request` 事务**：BEGIN IMMEDIATE 内 INSERT 单行（I2 去重查询 + 插入同事务防并发穿透）；提交后发 `approval.requested`（无强联动订阅方）。

**`approval_decide` 事务（强联动两阶段，宪法 §八.3 的实现）**：

1. 读行校验（I3：pending）；
2. **先执行强联动订阅者**：网关按 manifest 订阅声明（filter.kind 命中）逐个 dispatch 订阅方命令（scope_grant / scope_rules_apply / task 预算动词 / know_adopt——各自有独立事务，全部成功才继续）；
3. 任一失败 → **decide 整体回滚**（本命令行变更未提交，请求保持 pending）+ 错误信封透传订阅方错误码；
4. 全部成功 → BEGIN IMMEDIATE UPDATE `status/decided_at/note`（note = 人工 note + 订阅方 effect 汇编）→ 提交 → 发布 `approval.approved`（弱联动订阅者——fact 留档、看板通知——异步执行，失败仅 audit `subscriber_failed`）。

> 步骤 2 与 4 之间订阅方命令已提交而 decide 未提交的窗口：若此刻进程崩溃，出现"scope 已授权但请求仍 pending"——**安全方向**（fail-closed 只会被放大授权，不会被软化；重复 decide 经订阅方数据级幂等收敛，不产生重复授权）。此窗口记入契约测试（崩溃注入用例）。

**`approval_withdraw` 事务**：单行 UPDATE，无强联动。

### 2.4 后端适配器

**repository 接口**（原语，无业务校验）：

```js
ApprovalRepo.insert({kind, subject, program_name, payload_json, evidence, requested_by}) -> {id}
ApprovalRepo.get(id) -> row | null
ApprovalRepo.findPending(kind, subject) -> row | null          // I2 去重路径（走 idx_approval_pending）
ApprovalRepo.decide({id, status, decided_at, note}) -> changes  // 仅 pending 行可更（WHERE status='pending'）
ApprovalRepo.listWhere({kind, status, limit, offset}) -> {rows, total}   // 排序契约：pending 前置 + created_at DESC；列表与 total 同 where 构造器
ApprovalRepo.statsWhere({since_ts}) -> aggregates
```

**能力矩阵**（`sec_domain_approval_backend: sqlite-local`，默认且当前唯一）：

| 命令/查询 | sqlite-local | http-remote | file |
|---|---|---|---|
| approval_request / decide / withdraw | full | **unsupported**（审批裁决链不出本机——与 scope 域同口径的安全基线） | unsupported（需要事务 + CHECK 约束 + 去重索引） |
| approval_list / approval_stats | full | unsupported | unsupported |

### 2.5 缓存与失效

无域内缓存（直查 sqlite，量小）；看板 pending 徽标走既有轮询节奏（25s TTL 聚合缓存归看板壳，不在本域）。

### 2.6 性能与容量

| 项 | 现状 / 预期 |
|---|---|
| approval_requests 行数 | v4.7 时点 <100 行；预期 <1,000 行/年（终态行永久保留——决策留痕是审计资产） |
| 热路径 | findPending（I2，索引命中 O(log n)）、listWhere pending 前置（idx_approval_status） |
| decide 延迟 | 强联动订阅者（scope_grant ~5ms 文件写）+ 本域事务 ~10ms 级 |
| 事件量 | 低频（<10/天） |

---

## 三、迁移与兼容

### 3.1 现状代码映射（行级，v4.7 时点源文件在 `bundles/dsh/templates/`）

| v4.x 位置 | 函数/段 | v5 落点 |
|---|---|---|
| `dsh-plugin-sec-suite.js` L494-813 | `APPROVAL_KINDS` 注册表（6 kind 的 label/validate/onApprove） | manifest `kinds` 声明（§2.2.2）；**onApprove 全部拆除**改事件映射 |
| `dsh-plugin-sec-suite.js` L816-845 | `approvalRequest(args, exec)` | 命令 `approval_request`（判据字段平铺兼容 v4.x 工具面） |
| `dsh-plugin-sec-suite.js` L868-884 | `approvalDecideAction({id, decision, note})` | 命令 `approval_decide`（副作用从"执行 onApprove + 落库"改为"只发事件"） |
| `dsh-plugin-sec-suite.js` L853-865 | `sanitizeParamsForApproval` | **提请方（exec 域守卫）职责**；本域保留 params 值域防绕过校验 |
| `dsh-plugin-sec-suite.js` L468-492 | `enqueueScopeSeed`（种子任务 + radar 双通道，best-effort） | **拆除**：`scope.granted` → task 域（task_create 种子）+ ledger 域（ledger_radar_push）订阅 |
| `dsh-plugin-sec-suite.js` L537-559 / 609-633 | scope-domain / scope-wildcard onApprove 的 `scopeSaveProgram` 直写 | `approval.approved` → scope 域订阅 → `scope_grant`（双条目语义在订阅处理器） |
| `dsh-plugin-sec-suite.js` L658-687 | exclude-exception onApprove（移出排除 + factUpsert） | `approval.approved` → scope 域 `scope_grant`（吸收排除）+ fact 域订阅 `fact_upsert`（弱） |
| `dsh-plugin-sec-suite.js` L693-721 | tool-intrusive onApprove（写 allow_intrusive_tools） | `approval.approved` → scope 域 `scope_rules_apply` |
| `dsh-plugin-sec-suite.js` L724-737 | task-budget-extend onApprove（裸 SQL UPDATE tasks） | `approval.approved` → task 域预算动词（**裸 SQL 归零**） |
| `dsh-plugin-sec-suite.js` L745-812 | knowledge-adopt onApprove（exp_cards 直写 + FTS + 降级出口） | `approval.approved` → know 域 `know_adopt`（07-know；降级出口收紧为强联动，§2.2.2） |
| `dsh-plugin-sec-suite.js` L1244-1268 | runCli checkRisk needsApproval 自动提请 | exec 域守卫链 → `dispatch('approval','request')`（actor=system） |
| `dsh-plugin-sec-suite.js` L1290-1315 | S5 写动词守卫的 tool-intrusive 桥接 | 同上（guard: 'S5-write-verb' 进 payload） |
| `dsh-plugin-sec-suite.scheduler.js` L182-196 | scheduler 超时分支自动提请 | scheduler → `dispatch('approval','request')`（actor=scheduler） |
| `dsh-plugin-sec-suite.asset-db.js` L204-218 | approval_requests DDL + 索引 | sqlite 后端接管（表不动） |
| `dsh-plugin-sec-suite.asset-db.js` L1670-1725 | approvalAdd / approvalList / approvalGet / approvalDecide / approvalCount | ApprovalRepo 原语（approvalCount 并入 statsWhere） |
| `dsh-plugin-sec-suite.js` L2062-2095 | `approval_request` 工具注册（长描述） | ToolProjector 自动投影（描述全文 §1.6，原文保留） |
| `dsh-plugin-sec-suite.dashboard-rpc.js` L222-225 | approvalList / approvalDecide case | RpcProjector 自动投影（§1.7） |

### 3.2 兼容别名与观察期

| 旧名（v4.x） | 新名 | 通道 | 观察期 |
|---|---|---|---|
| 工具 `approval_request` | 同名（本就域前缀风格） | 模型 | 无需别名 |
| RPC `approvalList` | `approval.list` | 看板 | 1 个调度周期（7 天） |
| RPC `approvalDecide` | `approval.decide` | 看板 | 同上 |
| kind 值 `scope-domain` / `scope-wildcard` / `exclude-exception` / `tool-intrusive` / `task-budget-extend` / `knowledge-adopt` | 同值 | 数据 | 永久（数据值不受命名规范约束） |
| 工具参数平铺（equity_basis 等在顶层） | 同构（域内组装 payload） | 模型 | 无需别名——schema 逐字段兼容 |

### 3.3 数据迁移脚本要点

1. **表零迁移**：approval_requests 沿用现库现表；存量 pending/approved/rejected 行原样保留（已决策行是审计资产）。
2. **存量 payload 兼容**：v4.4 起判据已结构化（equity_basis 等 JSON），v5 读取无损；更早的 NULL payload 行渲染为无 chip。
3. **迁移窗口的请求处理**：Phase 3 切换期间，v4.x onApprove 与 v5 事件订阅**不并存**（同一请求只能被一条路径裁决）——切换顺序：先上 scope/task/know 域订阅 → 再切 decide 到新命令；切换时刻的存量 pending 请求在新链路裁决（判据字段齐全，无兼容缺口）。
4. 回滚：切回 v4.x 插件即恢复 onApprove 直写路径（表双向兼容）。

---

## 四、开放问题

| # | 问题 | 现状倾向 |
|---|---|---|
| O-1 | **scan-burst（T-16）新 kind 预留**：批量临时升速的审批——批准写 defaults.rate_limit_qps 临时值 + **TTL 到期自动回落**。现有 `scope_rules_apply` 是永久补丁模型，临时性需要"规则租约"（补丁 + 到期事件 + 回滚命令），与 08 §四 O-7 联动设计 | kind 注册表已预留扩展位（加条目零改动）；规则租约机制等 T-16 立项时在 scope 域设计 |
| O-2 | `withdrawn` 复用 rejected 终态（note 前缀 + 事件标记区分）——stats 区分靠 note LIKE，不够刚性 | 下次表重建窗口（新增列/约束集中变更时）引入独立 `withdrawn` 终态 + CHECK 重建 |
| O-3 | decide 强联动两阶段的崩溃窗口（订阅方已提交、decide 未提交）→ "已授权但 pending" | 安全方向（fail-closed 只紧不松）+ 数据级幂等收敛；是否值得引入 saga 补偿标记待崩溃注入测试结果 |
| O-4 | knowledge-adopt 是否需要订阅 know 域收割状态（如"草稿被删除时自动作废已提请求"） | 当前用查询满足；出现真实联动规则再升级为订阅 |
| O-5 | 审批 SLA：pending >7 天目前只有看板红条，是否要 approval.requested 的 Matrix 通知通道 | 倾向加（Bellkeeper 通知网关已有），Phase 5 与看板通知一并做 |
| O-6 | kind 注册表的运行时热扩展（插件式 kind 注册）vs manifest 静态声明 | 静态优先（宪法 §八.6 显式依赖精神）；热扩展等出现第三方 kind 需求 |
