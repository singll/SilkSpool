# 01 · 领域总线（bus 域：注册 / 命令网关 / 事件 / 双投影 / 幂等 / 审计）

> 版本：v5.0 ｜ 状态：定稿 ｜ 依赖契约版本：[`00-conventions.md`](00-conventions.md) v5.0（宪法，冲突以它为准）
> 契约版本：bus manifest schema **v1**（本文 §2.2.1）｜ 错误码自有段：`E_BUS_*`
> owns（单写者）：`idempotency` 表、`bus_meta` 表、`event_outbox` 表、`bus_subscription` 表、`data/audit.jsonl`、`data/events/*.jsonl`、`data/bus.aliases.yaml`（版本受控副本在 bundle 模板）
> 被依赖：全部 14 个领域模块 + [`16-dashboard.md`](16-dashboard.md)（RpcProjector）+ [`17-llm-surface.md`](17-llm-surface.md)（ToolProjector）+ sec-memcore（事件订阅客户端）
> 本文回答：**"一切写入皆命令 / 一切读取皆查询 / 一切联动皆事件"这三条公理由谁强制执行、怎么强制执行、失败了怎么办。**

---

## 一、对外暴露（External Surface）

### 1.1 服务标识与挂载

| 项 | 值 |
|---|---|
| 插件包名 | `@silksec/sec-domain-bus` |
| 插件 id | `sec-domain-bus` |
| cordis 服务名 | `secDomainBus`（`ctx.provide('secDomainBus', busApi)`） |
| patch.yml 挂载 | 见下（沿用 `dsh-plugin-sec-suite.patch.yml` 的 insert 结构） |
| 后端 | **自举**：总线自己的存储（幂等表 / bus_meta）用 `sqlite-local`（§2.4） |
| 进程模型 | **web / headless 双面挂载，每进程各自实例**。多进程 + SQLite WAL 的取舍已由总设计 §六定死：写收敛于网关（进程内单入口），跨进程原子性由 SQLite 事务承担，Phase 5 复评单写者守护进程 |

`dsh-plugin-sec-domain-bus.patch.yml`（bundle 模板）：

```yaml
# silksec-sec-domain-bus bundle layer
- insert:
    - id: sec-domain-bus
      name: '@silksec/sec-domain-bus'
```

profile `package.json` 增行（web 与 headless 完全一致——worker 要干活，宿主会话也要干活）：

```json
"@silksec/sec-domain-bus": "file:plugins/sec-domain-bus",
"@silksec/sec-domain-vuln": "file:plugins/sec-domain-vuln",   // 其余 13 域同模式，见各域文档 §1.1
```

**进程内拓扑**（每个进程一份，`globalThis` 不跨进程共享——v4.x 实测事实）：

```
cordis 容器
 └─ @silksec/sec-domain-bus           apply(): provide('secDomainBus')
     ├─ DomainRegistry               域 manifest 加载/校验/版本兼容/健康自检
     ├─ CommandGateway               写动词唯一咽喉（11 段管线，§2.2.2）
     ├─ QueryGateway                 读投影（纯读保证 + 分页信封 + 谓词参数化）
     ├─ EventBus                     发布/订阅 + jsonl 留痕 + 弱联动重放
     ├─ ToolProjector                → ctx.tools.register（模型面，见 17）
     └─ RpcProjector                 → connection.rpc '/silksec-domain'（看板面）
 └─ @silksec/sec-domain-vuln …       apply(): 向 registry 注册（不 provide 业务方法）
 └─ sec-memcore                      inject('secDomainBus') 订阅事件（§2.9）
```

**防绕过的核心承诺**：域插件 apply() 时不 `provide` 任何业务方法；它只把自己的 `manifest + commands/ + queries/ + backend factory` 交给 `registry.register()`。cordis 面上唯一可见的服务是 `secDomainBus`，其 API 为：

```js
{
  dispatch(domain, verb, args, ctx) -> Promise<envelope>,   // 唯一写入口
  query(domain, name, args, ctx)   -> Promise<page|row>,    // 唯一读入口
  events: { publish, subscribe(eventPattern, handler, {mode, as}) },
  status() -> bus_status payload,                            // §1.4
  registry: { list(), get(domain) },                         // 只读 manifest 视图
}
```

域的 service 实例（持有 repository 句柄的闭包）**只由 CommandGateway 在 dispatch 时构造**，不进任何 provide/inject 通道——memcore 的 DI 先例（`ctx.provide('secMemoryLifecycle')`）在这里推广为"提供的是门面，不是内脏"。

**后台单例任务收敛**（沿用 v4.x 两段先例）：幂等清理、事件轮转检查、AGENTS.md secbus 区块再生成只在 **web 宿主面**执行——判定 `config.sidecars !== false`（sec-suite.js:2113 的入口侧收敛模式，agent 面 preset 挂载行写 `config: { sidecars: false }`）+ 文件锁 `data/bus.lock`（PID+心跳 3 分钟，沿用 `data/scheduler.lock` 模式），双保险防多进程重复跑。

### 1.2 命令（写动词）总表

总线自身的命令只有 2 个（治理域命令属于各域；总线是管道，不是业务方）：

| 动词 | 一句话职责 | actor 白名单 | 幂等策略 |
|---|---|---|---|
| `bus_replay` | 按事件日志重放弱联动订阅者（灾备/调试） | human, system | 自动指纹 |
| `bus_prune` | 立即执行保留窗口清理（幂等表 LRU + 事件轮转检查） | human, system | 自动指纹 |

### 1.3 命令逐个详述

#### bus_replay

| 项 | 值 |
|---|---|
| schema | `{ since?: integer(epoch ms, 默认=24h 前), domains?: string[], subscriber?: string, dry_run?: boolean(默认 false), limit?: integer(默认 1000, 上限 10000), additionalProperties: false }` |
| 返回 data | `{ scanned: N, redispatched: M, skipped_sync: K, results: [{event_id, subscriber, ok, error_code?}] }` |
| 错误 | `E_SCHEMA`；`E_BUS_REPLAY_RANGE`（since 早于事件日志保留窗）；`E_CONFLICT`（replay 锁被占——同一进程已有 replay 在跑） |
| hint（E_BUS_REPLAY_RANGE） | "事件日志仅保留 90 天，since 不可早于 {最早事件 ts}；更早的弱联动需人工核对 data/events/ 后补命令" |
| 幂等 | 自动指纹 = sha1(domain, verb, since, subscriber, dry_run, limit)——同参数重放直接返回首次结果 |
| actor | human（CLI 应急通道）、system（定时兜底任务，每日 05:10 与 retention 同窗） |
| RoE | ① 只重放 `mode: async` 的订阅者——强联动已在命令事务内闭环，重放语义不存在；② 订阅者 handler 必须以幂等命令消化事件（网关幂等表兜底，重复消化返回 replay:true 无害）；③ dry_run 只输出将要重放的 (event, subscriber) 对，不执行 |
| side_effects | events: `bus.replay.completed`；rows: bus_meta 水位更新；caches: 无 |

实现要点：从 `data/events/{domain}.jsonl` 自 `since` 顺序读事件（兼扫 `event_outbox` 的 `dead_letter`/`pending` 行），对每个事件查 registry 中声明订阅它的 async 订阅者，逐个调用 handler（handler 内部经 `dispatch()`，天然过全管线）——**只重试 async 订阅，不重新执行强联动**。水位记 `bus_meta['replay.watermark']`；`bus_replay` 不依赖水位（显式 since），水位仅供 `bus_status` 展示"最近一次重放到哪"。

#### bus_prune

| 项 | 值 |
|---|---|
| schema | `{ force?: boolean(默认 false；false 时若距离上次清理 <6h 则跳过并返回 skipped) }` |
| 返回 data | `{ idempotency_pruned: N, events_files_rotated: M, audit_bytes: B }` |
| 错误 | `E_BACKEND_UNAVAILABLE`（sqlite 忙超时，retryable）；`E_CONFLICT` |
| hint | 无需（运维命令） |
| 幂等 | 自动指纹 |
| actor | human, system |
| RoE | 幂等表 LRU：保留最近 7 天 **或** 10,000 条（先到先清）；事件 jsonl 单文件 >50MB 轮转为 `.1`（只保一代）；audit.jsonl 轮转沿用 retention.sh 既有策略（50MB），本命令只检查不重复轮转 |
| side_effects | rows: idempotency 删除；files: events 轮转 |

### 1.4 查询（读投影）逐个详述

| 查询 | 参数 | 返回 | actor | 说明 |
|---|---|---|---|---|
| `bus_status` | `{ domains?: string[] }` | 见下 | model, dashboard, human, script | 总线健康自检：各域注册状态/契约版本/后端/能力矩阵摘要 |
| `audit_tail` | `{ n?(默认 50, 上限 500), domain?, cmd?, actor?, session_id?, since?, until? }` | `{ rows: [...], total, limit, offset }` | dashboard, human | 统一审计尾读（过滤维度=宪法 §九） |
| `events_tail` | `{ domain?(必填，单域), n?(默认 50, 上限 500), name? }` | `{ rows: [...], total, limit, offset }` | dashboard, human, model | 事件日志尾读（model 可见：事件是模型可观察的世界状态） |

`bus_status` 返回结构（完整 schema）：

```json
{
  "process": { "profile": "web|headless", "pid": 1234, "uptime_ms": 86400000, "sidecar_singleton": true },
  "bus": {
    "manifest_schema_version": 1,
    "idempotency": { "rows": 4210, "oldest_created_at": 1788400000000, "pruned_last_24h": 33 },
    "audit": { "writable": true, "bytes": 22000000 },
    "events": { "files": 12, "total_lines": 88214 },
    "outbox": { "pending": 3, "dead_letter": 1, "max_lag_ms": 4120, "last_delivered_at": 1789000000000 },
    "aliases": { "count": 31, "deprecated": ["finding_update"] }
  },
  "domains": [
    {
      "domain": "vuln", "registered": true, "version": 1,
      "contract_compatible": true, "backend": "sqlite-local", "backend_reachable": true,
      "capabilities": { "full": 7, "partial": 0, "unsupported": 0 },
      "commands": 7, "queries": 5,
      "events_unsubscribed": ["vuln.candidate.claimed"],
      "last_dispatch": { "ts": 1789000000000, "ok": true }
    }
  ],
  "subscribers": [
    { "source": "memcore", "pattern": "vuln.*", "mode": "async", "as": "reactor", "last_error": null }
  ],
  "event_contract": {
    "rule": "{domain}.{object}[.{action}]",
    "dangling_subscriptions": []
  }
}
```

`events_unsubscribed`（2026-09-12 增补，宪法 §八.6 对账纪律的执行点）：该域声明发布但当前零订阅者的事件清单——文档"被订阅"清单只允许写对端已声明的订阅，运行时以本字段对账。零订阅不必然是缺陷（观测性事件合法），但出现在此的事件若在某域文档"被订阅"栏被声称有消费方，即为文档失真。

memcore / eval 等治理订阅者执行命令的 actor 身份由订阅声明的 `as` 字段决定（推荐 `reactor`；handler 内可显式覆盖，如 eval 回流以 `system` 落账、task 域 onScopeGranted 以 `approval` 建种子任务）；memcore 治理旁路（sweep 直调 lifecycle 动词）使用 `system`（宪法 §三 system 定义含治理旁路通道）。白名单为各自 manifest 显式列出的 lifecycle / 回流类动词。

### 1.5 事件

**总线自身发布**（事件信封结构=宪法 §八，此处不重复）：

| 事件名 | 触发 | payload |
|---|---|---|
| `bus.domain.registered` | 域注册成功 | `{ domain, version, backend, commands, queries }` |
| `bus.domain.rejected` | 域 manifest 校验/版本兼容失败 | `{ domain, reason, detail }` |
| `bus.replay.completed` | bus_replay 成功 | `{ since, scanned, redispatched }` |

**总线自身订阅**：无。总线是事件的搬运者，不是消费者；任何"总线顺便记点什么"的需求一律做成 audit 或 bus_status 字段，不做隐式订阅。

**域事件的留痕与回放**（EventOutbox/EventDispatcher 职责，宪法 §八.4）：

- 命令事务提交后，事件信封随 outbox 行已持久化；dispatcher 派发后按序追加 `data/events/{domain}.jsonl`（O_APPEND 单次 write；payload 序列化后 >8KB 拒发 `E_BUS_EVENT_TOO_LARGE`——宪法 §八.5 防风暴的执行点。`high_frequency` 为**保留字段当前未实现**：全事件统一 8KB 上限，高频事件的体积约束由"payload 只含 ID 与判据快照"自律，exec.run.completed 的 parse_proposal 内联行数受各订阅方消费契约约束）；
- 一个命令的事件数上限：默认 1；可经 manifest `event_limit` 显式上调（如 exec_spawn_worker=2）；`{...}_bulk` 动词上限=批量行数（行数上限进各域 schema，如 500/2000/5000）；
- async 联动失败：dispatcher 指数退避重试（`bus_subscription` 记录 attempt/next_retry_at），超过阈值 → `dead_letter`；audit 记 `kind: "subscriber_failed"`（字段：event_id / subscriber / as / error）；`bus_replay` 可重放 dead/pending 的 async 订阅；
- 强联动失败：见 §2.3。

### 1.6 模型工具面投影

总线对 model 可见的工具有两个：**`bus_status`**（查自己所在面的健康与各域动词计数——模型开场自检用）与 **`events_tail`**（事件是模型可观察的世界状态，如确认自己发布的 candidate.promoted 已生效）。`bus_replay` / `bus_prune` / `audit_tail` 不向模型注册（治理动作与全量审计不属于模型职权；audit 含其他会话的身份与快照，越权面控制）。

`bus_status` 工具描述（agent_note，全文）：

> 查询领域总线健康状态：各域是否注册、契约版本、后端、动词计数。开局或遇到 E_BACKEND_UNAVAILABLE 时可调用确认是哪个域的哪类问题。只读，无副作用。

工具投影的完整规则（profile × actor 白名单挂载矩阵、agent_note、超时透传）是 [`17-llm-surface.md`](17-llm-surface.md) 的主题，本文只定义投影器的**机械行为**（§2.2.6）。

### 1.7 看板 RPC 投影

| 项 | 值 |
|---|---|
| RPC 通道 | `connection.rpc.handle('/silksec-domain', handler, { authority: 'loopback' })`——沿用 `/silksec-dashboard` 通道的全部先例（sec-suite.js:2099-2112：child fiber 等服务就绪 + **module 级幂等守卫**防 connection re-provide 期重复注册） |
| endpoint 命名 | `{domain}.{verb}` 点分（宪法 §二），如 `vuln.confirm`、`bus.status`、`bus.replay` |
| handler 行为 | endpoint 拆成 (domain, verb) → `gateway.dispatch(domain, verb, payload, { actor: 'dashboard', operator })`；返回 `{ ok: true, value: envelope }` / `{ ok: false, error: { code, message, details } }`（与 v4.x dashboard RPC 信封形状一致，看板 client 改造成本最小） |
| operator 注入 | **不可伪造**：handler 从连接上下文读取 auth-gate 用户身份（payload 内的 `operator` 字段一律忽略并覆盖）。注入通道在 Phase 1 与 dsh-auth-gate 0.7.2 实测对齐；若 auth-gate 不暴露用户上下文服务，回退方案见开放问题 Q4 |
| 覆盖范围 | actor 白名单含 `dashboard` 的全部动词 + 全部查询；`bus.replay` / `bus.prune` 的 RPC 名为 `bus.replay` / `bus.prune`，operator 必须非空且记录进 audit |

### 1.8 外部调用示例

**模型调用**（工具面，模型看到的只是工具）：

```json
// 工具调用：vuln_confirm
{ "finding_id": 88, "evidence": "run_r8f2k1 双出口复现一致，反证假设 2 项已排除" }
// 信封返回：
{ "ok": true, "domain": "vuln", "cmd": "confirm",
  "data": { "id": 341, "status": "confirmed", "signal": true },
  "event_ids": ["evt_01J..."], "idempotency_key": "vuln:confirm:id:88", "replay": false }
```

**代码调用**（进程内插件，如 memcore、scheduler）：

```js
// 插件 apply() 内：inject(['secDomainBus'], (child) => {
const bus = child.secDomainBus
const env = await bus.dispatch('fact', 'record_validation', { fact_key: 'bb/note:x', evidence: '...' },
                                { actor: 'script', run_id: 'r8f2k1' })
if (!env.ok) log(`fact 复验失败: ${env.error.code} ${env.error.hint}`)
```

**脚本调用**（治理/采集脚本，经 run_cli 沙箱——**脚本自己不直接调总线**）：

```bash
# grade-assets.py 在沙箱内只产建议文件（runDir 可写）：
#   proposal: asset_grade_proposal.json  →  [{ "host": "a.example.com", "score": 72, "level": "A", ... }]
# 宿主侧 exec 域 run_cli 后处理读 proposal，以 actor=script 落库：
node -e '
  const p = JSON.parse(require("fs").readFileSync("results/r8f2k1/asset_grade_proposal.json"));
  for (const row of p) {
    const env = await bus.dispatch("asset", "grade", row, { actor: "script", run_id: "r8f2k1" });
    if (!env.ok) process.stderr.write(env.error.code + " " + env.error.hint + "\n");
  }'
```

**人工调用**（human 应急通道 CLI，部署于 `scripts/pipeline/sec-bus-cli.mjs`，版本受控进 bundle 模板）：

```bash
node /opt/silkspool/dsh/scripts/pipeline/sec-bus-cli.mjs dispatch vuln.confirm \
  --args '{"candidate_id":88,"evidence_run_id":"r8f2k1"}' --actor human
# 输出信封 JSON；audit 中 actor=human 高亮（宪法 §三）
```

---

## 二、内部实现（Internal）

### 2.1 数据模型

**全部物理存储在宿主 `data/` 下，库文件沿用 `asset-graph.db`（表名/库文件不改名不迁库——总设计 §六）**。总线 owns 的表：

```sql
-- 幂等表（网关统一实现，域不写幂等逻辑——宪法 §六.3）
CREATE TABLE IF NOT EXISTS idempotency (
  idempotency_key TEXT PRIMARY KEY,      -- {domain}:{verb}:{自然键|显式key|args_hash}
  domain         TEXT NOT NULL,
  verb           TEXT NOT NULL,
  args_hash      TEXT NOT NULL,          -- sha1(规范化 args JSON)——同 key 异参检测
  result_json    TEXT NOT NULL,          -- 首次信封全文（>64KB 截断 data，标 truncated:true）
  created_at     INTEGER NOT NULL        -- UTC epoch ms
);
CREATE INDEX IF NOT EXISTS idx_idempotency_created ON idempotency(created_at);

-- 总线元数据（水位/已见域版本/清理时间戳）
CREATE TABLE IF NOT EXISTS bus_meta (
  key        TEXT PRIMARY KEY,           -- 例: 'replay.watermark' / 'seen.vuln.version' / 'prune.last_at'
  value      TEXT NOT NULL,              -- JSON
  updated_at INTEGER NOT NULL
);

-- 事件 outbox（命令事务内与业务表同写；提交后由 web 宿主 dispatcher 按 pending 派发）
CREATE TABLE IF NOT EXISTS event_outbox (
  event_id    TEXT PRIMARY KEY,          -- evt_...
  domain      TEXT NOT NULL,
  name        TEXT NOT NULL,
  payload     TEXT NOT NULL,             -- 序列化事件信封（已 redact，≤8KB/高频 2KB）
  producer_ts INTEGER NOT NULL,          -- 源命令时间（producer version 进 payload）
  status      TEXT NOT NULL DEFAULT 'pending',  -- pending / delivered / dead_letter
  retry_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at INTEGER,                 -- 指数退避下次派发时间
  last_error  TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_outbox_status ON event_outbox(status, next_retry_at);

-- 订阅消费记录（(event_id, subscriber) 唯一，跨进程幂等消费 + 订阅 offset）
CREATE TABLE IF NOT EXISTS bus_subscription (
  event_id    TEXT NOT NULL,
  subscriber  TEXT NOT NULL,             -- 域名或程序化订阅者 id（bus_status.subscribers 同源）
  mode        TEXT NOT NULL,             -- sync / async
  status      TEXT NOT NULL DEFAULT 'delivered',  -- delivered / failed / dead_letter
  attempt     INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT,
  consumed_at INTEGER,
  PRIMARY KEY (event_id, subscriber)
);
```

**幂等键构造策略**（宪法 §六.1，manifest 每命令声明其一；2026-09-12 起三级扩为五级）：

| 策略 | 构造 | 例 |
|---|---|---|
| `natural` | `{domain}:{verb}:{manifest.idempotent_natural(fields) 计算值}` | `vuln:confirm:id:88`、`vuln:register_signal:fpr:a3f...`（fingerprint） |
| `explicit` | 调用方传 `idempotency_key`（schema 里是可选参数，网关剥离后不进域实现） | 调用方自带键的场景 |
| `explicit_only` | 仅调用方显式传 key 才落幂等表；不传则每次执行（exec_run_cli 类——同一命令行的重复执行是合法新意图） | `exec_run_cli` |
| `auto` | `{domain}:{verb}:{sha1(排序后 args 核心 fields)}`（核心字段由 `idempotent_fields` 声明） | `vuln:note:auto:c7d...` |
| `none` | 不落幂等表：域内天然幂等（读后清空、状态合并）或长时非事务命令 | `ledger_radar_drain`、`exec_spawn_worker`（其去重由 dedupe_key 自然键在命令内预检，见下） |

> `auto` 策略可选 `idempotent_ctx_fields`（如 `session_id`/`operator`）：把调用面身份折进键尾（`|session_id=...`），用于认领类动词（vuln claim/release）——不同会话认领同一对象键不碰撞，同会话重放仍命中 replay。身份来自网关 ctx（actor 注入同源），域实现不可伪造。

保留窗口：7 天或 10,000 条 LRU（`bus_prune` / 每日系统任务执行）。命中同 key 同 args_hash → 返回首次信封 + `replay: true`；同 key 异 args_hash → `E_IDEMPOTENT_CONFLICT`（hint："幂等键 {key} 已绑定不同参数；若是新意图请换 key，若是重放请原样重发参数"）。

**事件文件**：`data/events/{domain}.jsonl`，每行一个事件信封（宪法 §八.2）。轮转 50MB 保一代，保留 90 天（retention.sh 增段）。

**统一 audit**：`data/audit.jsonl`，**v5 记录与 v4.x 记录同文件并存**（判别规则与迁移见 §3.3）。

**别名注册表**：`data/bus.aliases.yaml`（bundle 模板版本受控，结构见 §3.2）。

### 2.2 状态机与不变量

#### 2.2.1 DomainRegistry：manifest 加载与校验

域 manifest 的 JSON Schema（**总线用它校验 manifest 本身**——"schema 校验 schema"，manifest schema v1）：

```yaml
domain: string          # 小写单词单数（宪法 §二 域名表之外的值拒绝）
version: integer        # 契约版本，>=1
service: string         # 必须 = 'secDomain.{domain}'
description: string
owns: { tables: string[], files: string[] }
commands:
  {verb}:
    actor: string[]               # 非空；值域=宪法 §三 八 actor
    schema: object                # JSON Schema；必须 additionalProperties:false（lint 强制）
    idempotent: natural|explicit|auto|explicit_only|none  # natural 时必须给 idempotent_natural 表达式；
                                  # explicit_only=仅调用方显式传 key 才落幂等表（exec_run_cli 类）；
                                  # none=域内天然幂等/读后清空类（ledger_radar_drain 等），不落幂等表
    idempotent_fields: string[]   # auto 策略的核心字段清单（缺省=全参数）
    event_limit: integer          # 可选，默认 1；非批量命令需发多事件时显式声明（如 spawn_worker=2）；bulk 动词上限=行数
    backend_transactional: boolean # 可选，默认 true；false=非事务域（长时执行不占 BEGIN IMMEDIATE 写锁，如 exec 域；
                                  # 事件 outbox/审计在命令收尾段落库，不享受单事务原子性——能力矩阵须声明差异）
    events: string[]              # 引用本域 events 声明，悬空引用拒绝
    invariants: string[]          # 引用域内不变量函数名，悬空拒绝
    side_effects: { rows?, events?, files?, caches? }   # 建议项（宪法 §四，2026-09-12 起非强制）
    timeout_ms: integer           # 默认 60000，上限 3670000
    agent_note: string            # ≤240 字（查询 ≤120 字），缺失拒绝（含不向模型注册的动词——lint 不区分可见性）
    deprecated: boolean           # 默认 false
queries:
  {name}:
    actor: string[]               # 查询也要 actor 白名单（默认全 actor）
    params: object                # JSON Schema，additionalProperties:false
    predicates: [archived?, noise?, lifecycle?, program?]   # 声明可见域谓词参数化
    default_sort: { col, dir }
    agent_note: string            # ≤120 字
events:
  {name}: { payload: object(JSON Schema), redact: string[], high_frequency?: boolean }   # high_frequency 保留字段，当前未实现（统一 8KB 上限）
subscribes:
  '{source.event.name}':
    handler: string               # 域内处理器函数名
    mode: sync|async
    as: string                    # 订阅者执行命令时的 actor 身份（推荐 reactor；approval 事件的 effect 执行用专用 approval actor；handler 内可显式覆盖）
backend: repository-v1
```

**注册时校验清单（逐条、顺序执行，任一失败=域整体拒载）**：

| # | 校验 | 失败动作 |
|---|---|---|
| R1 | manifest 符合上述 schema（含 additionalProperties:false、agent_note 预算） | 拒载 + `bus.domain.rejected` 事件 |
| R2 | 禁用词检查：动词名含 `update/set/save/modify` 拒绝（宪法 §二）。**豁免登记**（2026-09-12）：`task_update_note`（语义=追加备注，非自由态改字段）；know 子仓原名（vc_save/pb_save 等）走宪法 §二子仓豁免不占此登记 | 拒载 |
| R3 | 参数名 lint：**命令** schema **顶层**参数名含 `status` / `to` / `state` 拒绝（状态机私有——写侧禁传目标状态；行级内嵌字段如 endpoint 行的 HTTP status 不在此列；查询 params 是可见域谓词按 status 过滤合法，豁免——17 §2.2 负向第 4 条同源） | 拒载 |
| R4 | owns 唯一性：tables/files 与已注册域交叉 | 拒载 + `E_BUS_DOMAIN_OWNS_CONFLICT` 进事件 detail（**重复注册冲突**：同 `domain` 二次 register 也在此拒——幂等重注册（同 version 同内容）返回已注册，静默通过） |
| R5 | 引用完整性：commands.events / invariants / subscribes.handler 悬空引用 | 拒载 |
| R6 | **域版本兼容检查**：`version` 必须 ≤ 总线支持的 manifest schema 大版本；且 ≥ bus_meta 记录的该域已见 version（**版本回退拒绝**——防"setup.sh 硬钉旧版本"式混版，DSH 0.1.2 升级教训的泛化） | 拒载 |
| R7 | 后端可用性：`sec_domain_{domain}_backend` 配置解析 + 能力矩阵加载 | 后端不可达 → 域标 `backend_reachable:false` 挂载（查询降级按后端能力），写命令 `E_BACKEND_UNAVAILABLE` |
| R8 | 事件命名契约：事件名必须以发布域为第一段，且至少 `{domain}.{object}` 两段；子对象可扩展第三段 | 拒载 |
| R9 | 跨域订阅对账：`bus_status.event_contract.dangling_subscriptions` 输出已注册域订阅但当前无发布方的事件 | `bus_status` 红条/治理告警（不阻断注册，因多域加载顺序不同） |

拒载后果：该域动词不进任何投影（模型看不见、RPC 查不到、dispatch 报 `E_BUS_DOMAIN_REJECTED`），`bus_status.domains[].registered:false` + 看板横幅。**不阻断其他域与总线自身启动**（fail-closed 只在域边界内）。

#### 2.2.2 CommandGateway：11 段管线（每段有失败错误码，顺序敏感）

```
dispatch(domain, verb, args, ctx)
 ①域与动词解析（含别名归一）        E_BUS_DOMAIN_UNKNOWN / E_BUS_VERB_UNKNOWN / E_BUS_ALIAS_DANGLING
 ②deprecated 标记                  （不失败：透传执行，audit 记 deprecated_use）
 ③actor 白名单                     E_ACTOR_FORBIDDEN
 ④后端能力矩阵                     E_CAPABILITY_UNSUPPORTED
 ⑤参数 schema 校验                 E_SCHEMA
 ⑥幂等预检                         E_IDEMPOTENT_CONFLICT / 命中→直接返回 replay 信封
 ⑦前置不变量                       E_INVARIANT / 语义子码 / E_NOT_FOUND / E_STATE / E_EVIDENCE_REQUIRED
 ⑧事务执行（BEGIN IMMEDIATE）       E_CONFLICT / 域自有错误码
 ⑨事件写 event_outbox（强联动同事务执行，async 登记消费计划） E_BUS_STRONG_LINK_FAILED（→ 整体回滚）
 ⑩幂等行落库（并入⑧同事务，见 §2.3） 
 ⑪审计落盘 + 信封返回               audit 写失败→主链路命令回滚（fail-closed，§2.5）
```

**顺序敏感性（为什么是这个序）**：

- ①先归一别名：否则白名单/能力矩阵查不到目标动词；分派型别名（如 `finding_update` 按 status 参数分派）在这一步完成路由（§3.2）。
- ③在⑤前：越权者不应获得参数 schema 细节（信息最小化）；且 `E_ACTOR_FORBIDDEN` 是安全信号，越早审计越好（宪法 §九：全部失败命令都审计）。
- ④在⑤前：不支持的命令尽早拒绝，省 schema 校验开销；能力矩阵是 manifest 静态数据，无副作用。
- ⑥在⑦前：**重放必须直接返回首次结果**，不再跑不变量——时过境迁后不变量可能对重放命令失败，而重放语义要求 bit-for-bit 返回。
- ⑦在⑧前：不变量失败不应占用写锁（BEGIN IMMEDIATE 会串行化所有进程的写）。
- ⑨强联动在事务内执行、async 出事务由 dispatcher 派发：见 §2.3。
- ⑪审计在最后且不回滚：命令数据已持久化，回滚只会制造"执行了但没记录"的更坏状态。

**每段的失败信封都带 hint**（宪法 §五；典型文案在各域文档，总线自有码的 hint）：

| code | hint 模板 |
|---|---|
| `E_BUS_DOMAIN_UNKNOWN` | "未知域 {domain}；可用域见 bus_status" |
| `E_BUS_VERB_UNKNOWN` | "域 {domain} 无动词 {verb}；该域动词清单见 AGENTS.md 域动词速查表" |
| `E_BUS_ALIAS_DANGLING` | "别名 {alias} 指向的 {target} 不存在（域未注册或版本不兼容）；直接改用新动词" |
| `E_BUS_STRONG_LINK_FAILED` | "强联动订阅者 {subscriber} 失败（{原因}），命令已整体回滚；修复联动问题后原样重试（幂等保护在）" |
| `E_BUS_EVENT_TOO_LARGE` | 域开发者错误，不面向调用方 |

#### 2.2.3 不变量执行协议

manifest `invariants: [name1, name2]` 引用域模块导出的纯校验函数：

```js
// commands/confirm.js 导出：invariants.candidateActive = ({ args, repo }) => {
//   const f = repo.getFinding(args.candidate_id)
//   if (!f) return { code: 'E_NOT_FOUND', message: `候选 #${args.candidate_id} 不存在` }
//   if (f.status !== 'new') return { code: 'E_STATE', message: `候选已处于 ${f.status}，终态不可再流转`,
//                                    hint: '如需补充证据用 vuln_note；如需提交用 vuln_submit' }
//   return null   // null = 通过
// }
```

网关逐条执行（manifest 声明顺序），返回非 null 即停（后续不变量不再跑——首错上报）。**域实现内部不重复校验**（宪法 §四.5）：service 是网关在不变量全通过后才构造的，物理上没有"绕过网关先摸到 service"的路径。

#### 2.2.4 QueryGateway

| 保证 | 实现机制 |
|---|---|
| 纯读 | 查询 handler 只拿到 repository 的**只读方法子集**（`get*/list*Where/count*`——repository 接口按读写分两组导出，网关按查询/命令分别注入）；查询语句不进任何事务 |
| 分页信封 | 网关强制包裹 `{ rows, total, limit, offset }`；limit 默认 50 上限 500（超限 `E_SCHEMA`）；sort 白名单列 + `dir=asc\|desc`（白名单外列 `E_SCHEMA`） |
| 可见域谓词参数化 | manifest `predicates` 声明（archived/noise/lifecycle/program）→ 网关注入默认值 → repository 的**单一 where 构造器**消费；SQL 散点拼谓词是契约测试否决项 |
| 计数同口径 | `total` 必须由 rows 的同一 where 构造器 COUNT 出（v4.3 countFacts/factSearch 病的根治）；契约测试"行数=total"断言（§2.8） |
| 查询副作用 | 禁止。原"搜索即记 uses"类 → 拆独立命令，由 ToolProjector 查询后补发（17 §2.3） |

### 2.2.5 EventOutbox 与 EventDispatcher（跨进程可靠投递）

**两个进程角色**（与线上"web 宿主 + 多个 headless worker 共用 SQLite"的事实对齐）：

- **所有进程**：命令事务内把事件写 `event_outbox`（status=pending），不执行 async 订阅者；
- **仅 web 宿主面**（`sidecars !== false` + 文件锁 `data/dispatcher.lock`，同后台单例收敛）：启动 dispatcher 循环，扫描 `event_outbox.status='pending' AND next_retry_at<=now` 逐个派发给声明订阅的 async 订阅者。headless 进程**不启动 dispatcher**——只写 outbox 不消费（避免多进程重复派发）。

**派发协议**（每个事件 × 每个订阅者一条 `bus_subscription` 记录）：

```
publish(event):                                    # 命令事务内
  envelope = { id: ulid('evt_'), domain, name, ts, actor, session_id/operator, cause: {cmd, idempotency_key}, payload(redact 后) }
  INSERT event_outbox(envelope, status='pending')  # 与业务表、幂等行同事务
  for sub of subscribers.matching(event.name):
    if sub.mode === 'sync':                        # 强联动：同一事务 SAVEPOINT 内执行
      SAVEPOINT sp_n; sub.handler(envelope)        # handler 内 dispatch → 网关识别嵌套深度，不再 BEGIN，用 SAVEPOINT
      catch e → ROLLBACK TO sp_n; 整体 ROLLBACK + E_BUS_STRONG_LINK_FAILED
    else:                                          # async：仅登记消费计划，事务提交后 dispatcher 派发
      INSERT bus_subscription(event_id, subscriber, mode='async', status='pending')

dispatcher tick（web 宿主面，1s）:
  for row of event_outbox WHERE status='pending' AND next_retry_at <= now:
    for sub of subscribers.matching(row.name) WHERE sub.mode === 'async':
      if bus_subscription(row.event_id, sub.id).status === 'delivered': continue   # 幂等消费
      try sub.handler(row.envelope)
        → bus_subscription.status='delivered'；event_outbox.status='delivered'（全部订阅者 delivered 后）
      catch e:
        → attempt++, next_retry_at = now + backoff(attempt)   # 指数退避 1s/5s/30s/2m/10m/1h/6h…
        → attempt > 8 → bus_subscription.status='dead_letter'，event_outbox.status='dead_letter'
```

- **模式语义固定（宪法 §八.3，消除"同步但不回滚"的含混表达）**：`sync` = 订阅者与命令主体共用同一连接同一事务（SAVEPOINT 包裹），失败 → 命令整体回滚；`async` = 事件已随事务持久化进 outbox，订阅者在事务提交后由 dispatcher 独立派发，失败进 retry/dead-letter。**不存在"同步但不回滚"的中间态**。
- **崩溃恢复**：命令事务提交即事件已在 outbox；宿主重启后 dispatcher 从 `pending` 续扫——async 订阅者不丢、不重（`bus_subscription` 唯一键保证幂等）；sync 订阅者随命令事务原子提交/回滚，无独立恢复问题。
- **强联动嵌套闸**：嵌套 dispatch 走 SAVEPOINT 而非新 BEGIN（嵌套深度上限 3，超过 `E_BUS_STRONG_LINK_NESTING`——订阅环：A 命令强联动订阅 B 事件、B 又强联动订阅 A 事件的环在注册时用 subscribes 图检测拒载，运行时深度闸兜底）。
- **订阅声明注册**：域经 manifest `subscribes`；非域客户端（memcore）经 `bus.events.subscribe(pattern, handler, {mode, as})` 程序化注册——**未声明订阅的域收不到事件**（宪法 §八.6），程序化订阅同样登记进 `bus_status.subscribers`。
- **事件留痕**：dispatcher 对每个事件投递完成后把信封追加 `data/events/{domain}.jsonl`（O_APPEND 单 write）——jsonl 是**观测与 `bus_replay` 的源**，不是投递机制本身；投递可靠性由 outbox 保证，jsonl 只做可回放审计。
- **事件风暴闸**：单命令事件数上限（默认 1，bulk≤行数）在发布入口检查；payload 序列化超限（8KB / 高频 2KB）`E_BUS_EVENT_TOO_LARGE` 拒发（域开发期错误）。


### 2.2.6 ToolProjector / RpcProjector（机械行为）

ToolProjector（细节与挂载矩阵在 17）：

```
for domain of registry.registered():
  for (verb, def) of domain.manifest.commands:
    if 'model' ∉ def.actor: continue                  # 不注册=模型不可见（负向保障第一层）
    if def.deprecated and config.mount_deprecated === false: continue
    ctx.tools.register({
      name: verb,                                     # 工具名 = 动词名，零改名（宪法 §二）
      description: agent_note(def),                   # deprecated 时前缀 "[已废弃，改用 X] "
      parameters: def.schema,                         # JSON Schema 直投（R1 lint 已保证严格模式）
      output: { schema: envelopeSchema, render: renderJSON },
      timeoutMs: def.timeout_ms ?? 60000,             # 超时透传（exec_run_cli 类 3670000）
      execute: (args, exec) => gateway.dispatch(domain, verb, args,
                 { actor: 'model', session_id: sessionIdOf(exec), cwd: execCwd(exec) })  # actor 注入不可伪造
    })
  for (name, qdef) of domain.manifest.queries: 同上（gateway.query）
for alias of aliases: if alias.target 对 model 可见: register 别名工具（§3.2）
```

RpcProjector：单一 handler 按 `'{domain}.{verb}'` 拆分路由到同一 dispatch/query（§1.7），**不存在逐 case 手写分发**——v4.x dashboard-rpc.js 52 case 的手写分发模式废止，仅 16-dashboard 保留少量纯 UI 聚合 case（只准调查询）。

### 2.3 事务与联动

**命令事务边界**（sqlite-local；http-remote 见 §2.4）：

```
 网关持有连接 C（busy_timeout 5000，WAL）：
   BEGIN IMMEDIATE                       ⑧
     域命令全部行变更（含联动列，如 vuln_confirm 的 status+confidence+noise 三联动）
     强联动订阅者执行（SAVEPOINT 包裹）     ⑨-sync
     写幂等行（key/args_hash/result_json） ⑩  ← 同事务：命令成功但幂等行丢失的竞态不存在
     写 event_outbox 行（status=pending）     ← 同事务：事件与业务变更原子落库
   COMMIT
   dispatcher 派发 async 订阅者（web 宿主面）⑨-async
   事件 jsonl 追加 + audit 追加            ⑪
```

- **失败语义**：⑧⑨-sync 任一失败 → ROLLBACK，事件不发、outbox 行不落、幂等行不落、audit 记 `result:"failed", error_code`；⑨-async 失败 → 命令已提交，dispatcher 指数退避重试，超阈值进 dead_letter（`bus_subscription.status`），`bus_replay` 可重放；⑪ audit 写失败 → **主链路命令回滚**（fail-closed，宪法 §九/§十四.7；查询与弱联动 audit 失败保持 fail-open）。
- **重试契约**：`E_CONFLICT`（SQLITE_BUSY 超时）retryable=true，调用方（模型/脚本）退避重试；网关自身不做隐式重试（幂等表保证重试安全）。
- **跨域效果永不进本事务**（宪法 §四.2）——只有事件（sync 强联动是共用同一事务的例外，模式语义见 §2.2.5）。

### 2.4 后端适配器（总线是自举的）

总线是自己的第一个客户：**bus 域的存储（idempotency / bus_meta）走自己的 sqlite-local 后端**，与被管域同一套 repository 协议——总线吃自己的狗粮，任何契约缺陷在总线自身先行暴露。

| 项 | 值 |
|---|---|
| repository 接口 | `getIdem(key) / insertIdem(row) / pruneIdem(olderThan, maxRows) / metaGet(key) / metaSet(key, value)` + 只读组 |
| 实现 | node:sqlite，`asset-graph.db` 内建表（§2.1 DDL），WAL，busy_timeout 5s |
| 域后端配置 | `sec_domain_{domain}_backend: sqlite-local|http-remote|file`（bundle 配置一行；热切换仅 sqlite↔sqlite，切 http 重启宿主面——宪法 §十二.5） |
| http-remote 下的幂等/审计 | **幂等表与 audit 永远留在本地 sqlite**（总线 owns，不随后端走）——远程后端挂掉时幂等与审计链不断；域命令在远程执行，⑧ 的"事务"由远程原子端点承担，⑨-async/⑩/⑪ 语义不变。弱于本地的事务边界（远程部分成功）由能力矩阵 partial 声明兜底（fail-closed，不静默降级） |
| 能力矩阵 | 后端 manifest 对每命令声明 full/partial(说明)/unsupported；④ 段执行检查 |

### 2.5 缓存与失效

| 缓存 | 内容 | 失效 |
|---|---|---|
| manifest 内存缓存 | 注册后的域 manifest 常驻（dispatch 热路径零 IO） | 不失效（变更=重启；域版本演进走 §十五三段式） |
| bus_status 健康缓存 | TTL 30s（`backend_reachable` 探测结果、idempotency 计数） | TTL 到期或任一 dispatch 失败即失效 |
| audit 写入 | appendFileSync 直写（v4.x audit() 同款）；写失败 → 内存队列重试 3 次（间隔 1s/5s/30s）→ 仍失败：stderr + `bus_status.bus.audit.writable:false` + 看板红条。**主链路写命令 fail-closed（audit 写失败 → 命令回滚）**；查询与弱联动订阅的 audit 失败保持 fail-open（仅告警）——宪法 §九/§十四.7 |
| 事件文件句柄 | 每域 fd 常驻 O_APPEND | 轮转时重开 |

### 2.6 性能与容量

| 指标 | 现状（v4.x 实测） | v5 预期 | 依据 |
|---|---|---|---|
| 单命令网关开销 | —（无网关） | <5ms（manifest 命中内存缓存 + 3 条 SQL） | ⑧-⑩ 全在单事务 |
| audit.jsonl | ~22MB（v4.x 2026-09） | 持平（v5 每命令 1 行 ≈ v4.x 每工具调用 1-3 行） | 50MB 轮转沿用 |
| events/*.jsonl | 无（新增） | 日增 ~2-5k 行（调度+模型日命令量 1-2k，bulk 命令放大） | 90 天保留 ≈ 单域 <25MB |
| idempotency | 无（spawn_worker dedupe_key 单点） | 上限 10,000 行常驻（LRU） | 单行 <1KB（result 截断 64KB 上限） |
| 并发写 | 多进程 WAL（v4.x 现状） | 不变；网关 BEGIN IMMEDIATE 串行化 | 总设计 §六已定 |
| 幂等表查询 | — | PRIMARY KEY 点查，<0.1ms | 热路径唯一额外读 |

### 2.7 启动顺序与冒烟（setup.sh 执行点）

`sec-domain-bus-plugin-setup.sh`（沿用 sec-suite-plugin-setup.sh 幂等模式）在 `spool bundle dsh setup csai` 链内的步骤与执行点：

```
§A  组装：模板 → plugins/sec-domain-bus/ + 生成 package.json（零外部依赖，只用 node 内置模块）
§B  profile 挂载：web 与 headless package.json 增行 + dsh plugin --profile web|headless add
§C  后端插件组装：@silksec/sec-backend-{domain}-sqlite（各域 setup 各自负责，总线只校验在场）
§D  别名表校验：node -e 校验 data/bus.aliases.yaml 全部目标存在且无环（失败=setup 中止）
§E  owns × sandbox 交叉断言：各域 manifest owns.files/tables 推导路径 ∉ bwrap 可写白名单（宪法 §十四.3）
§F  契约测试：node --test plugins/*/test/contract-*.test.js（sqlite-local 全跑；不过=中止，宪法 §十三）
§G  dump-config 冒烟：--dump-config 组合树校验 sec-domain-bus / 各域插件在树（沿用 dsh-upgrade 深冒烟）
§H  reconcile_service 重启（§G 之后——v4.6.1 顺序缺陷教训：重启必须排在组装后）
§I  启动后冒烟：RPC bus.status 或 sec-bus-cli.mjs query bus.status —— domains 全部 registered:true 才算过
§J  边缘基础设施探活（域外不动清单，10-exec §2.7）：① systemctl is-active silksecagent-edge
    silksec-shared-browser；② curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3080/ 期望 200/302
    （edge-Caddyfile :3080→3081 Host/Origin 改写通道，Web UI 唯一 LAN 入口）；③ :9223 basicauth
    入口探活（浏览器共驾入口，期望 401 未带凭证）；④ CDP :9222 /json/version 探活（常驻 Chromium）
    ——四项任一失败=警告不中止（平台层资产非总线 owns，告警进部署报告人工处置）
```

### 2.8 契约测试矩阵（总线自身的测试义务）

总线是网关，它的契约测试 = **所有域的管线共性义务由一套总线级测试统一背书**（各域只补域特有断言）：

| 用例类 | 断言 |
|---|---|
| happy path 全管线 | 信封结构 / event_ids 非空 / audit 落盘（kind=command，v5 schema）/ 幂等行存在 |
| 顺序敏感性 | actor 错 + schema 错同时存在 → 报 E_ACTOR_FORBIDDEN（③先于⑤）；幂等命中 → 不变量函数未被调用（spy 断言） |
| schema 拒绝 | 缺 required / 未知参数 / 类型错 → E_SCHEMA（message 含字段名） |
| actor 拒绝 | 八 actor × 非白名单动词各至少一例 → E_ACTOR_FORBIDDEN 且已审计 |
| 幂等 | 同 key 同参 → replay:true 且 bit-for-bit 同果；同 key 异参 → E_IDEMPOTENT_CONFLICT；natural/explicit/auto 三策略各一例 |
| 并发 | 两进程同时 dispatch 同一候选 confirm → 一成一 `E_STATE`（或一成一 E_CONFLICT），最终状态一致（仅 sqlite-local 跑） |
| 强联动 | sync 订阅者 throw → 命令行变更回滚（before/after 断言）+ E_BUS_STRONG_LINK_FAILED |
| 弱联动 | async 订阅者 throw → 命令成功 + `bus_subscription` 记录 attempt/next_retry_at + 事件在 outbox（jsonl 待 dispatcher 派发后追加）|
| 跨进程崩溃恢复 | dispatcher 进程 kill/restart 后，outbox `pending` 行被续扫派发；同事件同订阅者不重复消费（`bus_subscription` 唯一键）|
| 事件载荷 | payload 符合 manifest events schema、redact 字段被过滤、不含行全量 |
| 重放 | bus_replay 重放 weak/dead_letter → 订阅者幂等消化（第二次 replay 零副作用） |
| 别名 | 别名过全管线（同 E_ACTOR_FORBIDDEN / E_SCHEMA 路径）；分派型别名路由正确 |
| 注册校验 | R1-R8 各至少一个反例（禁用词动词 / status 参数名 / owns 冲突 / 版本回退 / 事件名）→ 域拒载且总线存活；R9 bus_status 输出悬空订阅对账 |
| 查询 | 行数=total / 谓词默认值 / 分页边界（offset 越界返回空 rows 且 total 不变） |
| 防绕过 | cordis inject('secDomainBus') 只见门面 API；域模块不 provide 业务方法（加载后扫描 provide 名单断言） |

### 2.9 与 memcore 的关系（治理旁路不开后门）

- **memcore 不是域**：它不注册 manifest、不 owns 任何表、不提供 `secDomain.*` 服务。
- **memcore 的两个合法触点**：① `inject('secDomainBus')` 后 `events.subscribe('{domain}.{...lifecycle...}', handler, { mode:'async' })` 订阅域事件；② handler 内 `dispatch(domain, verb, args, { actor: as })` 调域 lifecycle 命令（fact 域 record_validation、know 域 exp_* 等）。
- **总线不为治理开后门**：memcore 走的 dispatch 与模型/看板是同一条 11 段管线——actor 白名单不含它的动词它一样被拒；它没有任何裸 SQL 通道（v4.x 69 处裸 SQL 在 v5 物理消失，因为域表句柄只存在于网关构造的 service 闭包内，memcore inject 不到）。
- **fail-open 保留**（总设计公理）：memcore 缺席/异常 → 订阅不触发、lifecycle 不执行，业务照常；`bus_status.subscribers` 不列 memcore 时看板治理横幅亮起。

---

## 三、迁移与兼容

### 3.1 现状代码映射（v4.x → 总线各部件，文件行级）

| 总线部件 | 血缘来源（实测位置） | 搬迁方式 |
|---|---|---|
| CommandGateway 管线骨架 | `dsh-plugin-sec-suite.js:1206-1340` runCli 的 scope-guard 链（manifest 存在性→S3→S4→目标提取→checkTarget→checkRisk→S1→QPS，每步有 audit 落点、deny 即返回） | **模式平移**：守卫链的"逐 stage 校验+逐 stage 审计+首错返回"结构原样复制到 11 段管线；守卫内容留在 exec 域 |
| DomainRegistry 注册/校验 | `dsh-plugin-sec-suite.js:494` `APPROVAL_KINDS` 注册表（kind→{validate, onApprove}，未知 kind 拒绝并列出可用清单） | 泛化：kind 注册表 → 域 manifest 注册表；"未知并列可用清单" → E_BUS_* hint |
| provide/inject 依赖反转 | `dsh-plugin-sec-memcore.js:849-879`（apply→loadDb→migrate→provide('secMemoryLifecycle', api)）+ `asset-graph.js:39-54`（可选注入 + 缺席 fail-open 告警 + 黑板留言） | 推广为全域：provide 门面 + inject 可选 + 缺席告警三板斧 |
| 统一 audit 落点 | `dsh-plugin-sec-suite.js:1117-1122` `audit()`（appendFileSync，写失败不阻断）+ `:1125-1139` `tailAudit()`（256KB 尾读、跳半行、新→旧） | audit() → AuditSink（schema 升 v5）；tailAudit() → `audit_tail` 查询（逻辑原样，加过滤维度） |
| 幂等 | `dsh-plugin-sec-suite.js:1642+` spawn_worker dedupeKey（sha1(task)；重启重试→running 活= in_progress / done=回读真实结果 / killed=重跑） | dedupe_key 单点机制 → 幂等表三级键构造 + 保留窗口（"重启后原样重试即确定性拿回结果"的经验写进 replay 语义） |
| RpcProjector | `dsh-plugin-sec-suite.js:2099-2123`（child fiber 等 connection 就绪 + module 级 `dashboardRpcRegistered` 幂等守卫 + authority loopback + ok/error 信封） | 通道先例整体沿用：`/silksec-dashboard` → `/silksec-domain`；52 case 手写分发废止 |
| ToolProjector 注册单元 | `dsh-plugin-sec-suite.asset-graph.js:15-22` `reg(ctx, def)` helper（name/description/parameters/output/timeoutMs/execute 六件套） | reg() 的字段形状就是投影器的输出形状；38 个手写 def → manifest 自动生成 |
| 后台单例收敛 | `dsh-plugin-sec-memcore.js:881-893`（isWeb + config.sweeper!==false 双条件 + interval.unref）+ `scheduler.js` 文件锁 | 双条件 + `data/bus.lock` 文件锁，防多进程重复清理 |
| 事件留痕 | `flows/xray-*.jsonl` / `radar-queue.jsonl` 的 appendFile 模式 | 统一为 `data/events/{domain}.jsonl` + 事件信封 |
| 事件留痕（豁免） | `data/intel/intel.jsonl` | **维持原样不统一**：nuclei 模板库版本记录由 silksec-intel.timer 域外单写（systemd 计时器，无进程内事件可发），非域产物——10-exec §2.7 不动清单声明 |
| parser proposal 管道 | `dsh-plugin-sec-suite.parsers.js` applyParsedResult（store=asset-graph 直写） | 改为 exec.run.completed 事件 + proposal 文件 + 各域订阅经命令入库（直写归零） |
| webhook actor 注入点 | `dsh-plugin-sec-suite.webhook.js`（webhook 服务器只在宿主面起） | webhook 面调 dispatch 时 actor='webhook' 从服务端注入 |

### 3.2 兼容别名（旧工具名 → 新动词）

`data/bus.aliases.yaml`（bundle 模板版本受控，Phase 1-4 观察期贯穿，Phase 5 删）：

```yaml
# 静态别名：一对一映射（以下为代表性示例；**唯一真相源是 data/bus.aliases.yaml**，bundle 模板版本受控）
aliases:
  finding_add:        vuln_register_signal   # 实际为分派别名（按 actor/参数路由），见运行表
  finding_get:        vuln_get
  asset_add:          asset_upsert
  asset_query:        asset_list
  blackboard_set:     fact_bb_publish
  blackboard_get:     fact_bb_read
  attempts_log:       ledger_log_attempt
  card_usage_log:     ledger_log_card_usage  # 实际为分派别名（router 判定）
  radar_read:         ledger_radar_drain
  surface_queue:      endpoint_queue_surface
  coverage_report:    ledger_coverage        # 实际为分派别名
  pipeline_validate:  ledger_validate        # 实际指 ledger_pipeline_validate，见运行表
  proxy_pool_stats:   proxy_stats
  proxy_pool_get:     proxy_sticky_bind      # 语义归并别名（v4 无 key 单取 → v5 sticky_key 必填；单次取用走 proxy_gateway 网关），见 13-proxy §3.2
  submission_draft:   report_draft_submission
# 分派型别名：带状态参数的旧自由态动词，按参数路由
dispatch_aliases:
  finding_update:
    router: status_router          # 总线内置：args.status=confirmed→vuln_confirm(需补 evidence 映射)
                                   #   false_positive/dup/ignored→vuln_reject；submitted→vuln_submit；
                                   #   仅 note→vuln_note
    warn: "finding_update 是自由态旧动词，已按 status 分派；请改用语义动词"
  task_update:
    router: task_status_router     # blocked→task_block；note→task_update_note；done→守卫提示（model 不可直接 finish）
  finding_query:
    router: query_visibility_router  # include_noise/noise → visibility 映射
  exp_validate:
    router: exp_validate_router      # 折叠进 exp_feedback(verdict=validated)
```

> `task_chain` 无别名：v4 的 `exec_task_chain` 能力已迁移为 task 域 `task_chain`（05-task C9）+ exec 域只读查询 `exec_plan_chain`；v4 工具名 `task_chain` 与 v5 同名直通，不需要别名条目。

规则（宪法 §十五.3 的执行细则）：

1. **别名同样过网关全管线**——归一发生在管线 ①，后续 ③-⑪ 与新动词完全同路（不绕校验）；
2. 别名的 actor 可见性 = 目标动词的 actor 可见性（`vuln_register_candidate` 类 model 不可见的动词，其任何别名也不向模型注册）；
3. 别名使用 → audit 记 `deprecated_use`（alias 字段标来源）；观察期一个调度周期（7 天）audit 零使用 → 删除（废弃三段式）；
4. 别名表启动时校验：目标存在（`E_BUS_ALIAS_DANGLING` 中止 setup）、无环、无重复目标键冲突；
5. `proxy_pool_get → proxy_gateway` 这类**语义归并别名**（旧工具语义拆分到多个新动词）只允许在映射后语义无损时使用，否则必须走 dispatch_aliases 带路由函数。

### 3.3 数据迁移

| 项 | 策略 |
|---|---|
| audit.jsonl v4/v5 并存 | **同文件追加，不回改旧记录**。判别：v5 记录含 `kind` 字段（command/guard/subscriber_failed/query_human）且含 `idempotency_key`；v4 记录含 `tool`/`decision` 字段。`audit_tail` 双格式解析（v4 行映射为 `{kind:'legacy-v4', domain:'-', cmd: tool, result: decision}` 渲染），看板审计视图过渡期两色显示 |
| audit v4→v5 backfill | **不做全量转换**（旧记录语义不完整，强转制造假数据）；仅 18-migration 在 Phase 1 做**僵尸数据修复**（31 条 confirmed+noise=1 → noise=0 等）时，把修复动作本身作为 v5 命令落新格式审计。v4 记录随 50MB 轮转自然消退 |
| idempotency 表 | 空表启动，无需迁移；`exec_spawn_worker` 的去重语义由 **exec 域命令内预检**承担（`idempotent: 'none'` + dedupe_key=sha1(task) 查询 `task_worker_recent` 30 分钟窗：running→in_progress / done·failed→回读真实结果 / killed→重跑），历史 dedupe 不回填 |
| bus_meta | 启动时写入 `seen.{domain}.version` 初值（首次注册时记录）；`replay.watermark` 置 0 |
| events/*.jsonl | 空目录启动；存量 radar-queue.jsonl / flows/ 不迁（它们是 exec/proxy/ledger 域的 3.3 主题） |

---

## 四、开放问题（宪法未覆盖、实现期观察项）

| # | 问题 | 选项与建议 |
|---|---|---|
| Q2 | **事件 jsonl 跨进程原子性上限**。多进程 O_APPEND 并发写同文件，单次 write >4KB 后内核不再保证不交错。现设计用 8KB 上限 + payload 判据快照约束压风险，未做文件锁。 | 备选：事件写入加 per-domain flock（代价：热路径 +1 syscalls 与锁竞争）。建议先按现设计上线，用 events_tail 的行解析失败率做观测指标，超标再加锁 |
| Q3 | **强联动嵌套与环**。subscribes 图的强联动环已在注册时检测，但 sync 订阅者动态 dispatch（handler 里调另一域命令又触发 sync 订阅）只能靠深度闸 3 兜底。 | 需确认：深度 3 是否够（vuln→asset→scope 链已 3 层）；是否要在 audit 里显式记录嵌套链 |
| Q4 | **operator 身份注入通道**。v4.x dashboard RPC 不携带操作者身份（approvalDecide 审计无 operator 字段，实测取证）。v5 设计假定 auth-gate 0.7.2 可在 RPC 连接上下文暴露用户身份，未实测验证。 | 回退方案：看板登录后向 `/silksec-domain` 发一次性 operator 登记调用（token 换绑连接→operator），bus 维护连接↔operator 映射。Phase 1 第一周内定 |
| Q5 | **http-remote 后端的幂等语义边界**。远程端点部分成功（网络超时但远端已提交）时，本地幂等表未落行 → 重试会在远端二次执行。能力矩阵 partial 声明 + 远端幂等头（Idempotency-Key 透传）是方案，但依赖外部系统配合。 | Phase 4 vuln 试点时定；需用户确认目标外部漏洞管理系统是否支持幂等头 |
