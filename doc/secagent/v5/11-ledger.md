# 11 · ledger 域设计（纪律台账 / 卡使用 / 覆盖 / 雷达队列 / 交接包）

> 版本：v5.0 ｜ 状态：定稿 ｜ 契约版本：`ledger/1`
> 依赖：订阅 `exec.run.completed`（对账统计，弱联动）、`approval.approved`（scope-approved 雷达入队，弱联动）；被订阅：`attempt.logged` / `card_usage.logged` / `handoff.written`（task 域——task_finish 三产物校验的计数缓存）、`radar.drained`（task/recon 派单侧）
> 上级契约：[`00-conventions.md`](00-conventions.md)（本文与其冲突时以宪法为准）
> 一句话职责：把 agent 的**纪律动作**（台账落行/卡使用/交接包/雷达处置）变成机器强制、写入即校验、可聚合取证的文件型台账——"执行了什么、覆盖到哪、纪律是否在线"的唯一真相源。

---

## 一、对外暴露（最优先）

### 1.1 服务标识与挂载

| 项 | 值 |
|---|---|
| 域名 | `ledger` |
| cordis 服务名 | `secDomain.ledger` |
| 插件包名 | `@silksec/sec-domain-ledger` |
| 后端插件包名 | `@silksec/sec-backend-ledger-file`（可选 `…-sqlite`，见 2.4） |
| 挂载 profile | `web` + `headless` 双面（worker 收尾要落台账；无 sidecar 依赖） |
| owns.files | `data/pipeline/{program}/attempts-{program}.tsv`、`card_usage-{date}.jsonl`、`radar-queue.jsonl`、`handoff-{date}.md`、`coverage-latest.md` |
| owns.tables | 无（可选 sqlite 索引视图为派生缓存，非真相源，见 2.4） |
| 后端 | `file`（默认且唯一真相源；TSV/JSONL/MD 形态保留——vault 同步与回放链路依赖） |

**owns 边界的三条论证**：

1. **card_usage 与 know 域的边界**：card_usage 归**本域**——动词 `ledger_log_card_usage`，文件 owns `data/pipeline/{program}/card_usage-{date}.jsonl`。理由：① v4 实测文件在 `pipelineDir(program)` 台账树（sec-pipeline.js L146）；② 三产物（attempts / card_usage / handoff）在同一纪律节奏写入（每动作/每日收尾）、被同一流程守卫校验（task_finish 三查）、走同一 vault 回放链路——拆到两个域会让流程守卫跨域取证、让 vault 导出跨域拼目录；③ 一棵目录树一个 owner。know 域是**纯消费方**：订阅 `card_usage.logged` 事件（弱联动）+ `ledger_usage_query` 跨域查询（registry 健康度 / 零使用卡清理 / 升版原料 deviation 聚合），不读本域文件。
2. **handoff 与 fgs/task 域的边界**：交接包是"纪律台账的第五件产物"（收尾强制、被流程守卫校验、vault 回放），不是任务执行史（task 域）也不是决策图（fgs 域）。v4 的 `appendFgsToHandoff` 直写 handoff 文件——v5 废止：FGS 决策链摘要由模型调 `fgs_export` 查询后并入 `ledger_handoff_write` 的"动作"段输入（fgs 域不写本域文件）。
3. **param-queue / assets-{program}.tsv / endpoints-{program}.tsv 不在本域**：参数队列归 endpoint 域（`endpoint_queue_surface`/`endpoint_consume_queue`，见 04-endpoint.md）；assets/endpoints TSV 是采集建议文件，归各自域经命令入库。本域只在校验查询（`ledger_pipeline_validate`）里核它们的**表头格式契约**（格式契约定义于 §2.1，文件本体 owner 在彼域）。

### 1.2 命令（写动词）总表

| 动词 | 一句话语义 | actor 白名单 | 幂等策略 | 事件 |
|---|---|---|---|---|
| `ledger_log_attempt` | 六态台账落行（写入即机器校验） | model, script, human | 自动指纹 | `attempt.logged` |
| `ledger_log_card_usage` | 卡片使用记录（实战偏差必填 deviation） | model, script | 自动指纹 | `card_usage.logged` |
| `ledger_radar_push` | 变化雷达事件入队（ct-watch / js-watch / scope-approved） | script, approval, model, system | 自动指纹 | `radar.pushed` |
| `ledger_radar_drain` | 读后清空雷达队列（破坏性读） | model, script | 天然幂等（再 drain 返回空） | `radar.drained` |
| `ledger_handoff_write` | 交接包五段全量写（快照/动作/明日队列/阻塞/数据指针） | model, script, human | 自动指纹（内容级） | `handoff.written` |
| `ledger_pipeline_validate` | —（**查询**，见 1.4.5；保留为复核而非写入） | — | — | — |

### 1.3 命令逐个详述

#### 1.3.1 `ledger_log_attempt`

**agent_note**：六态覆盖台账追加（写入即机器校验，违规则拒绝）。每个探测动作完成后必须立即调用一次，禁止攒批。N/A 与 BLOCKED 必填 reason（禁 other/misc）；TESTED_CLEAN 与 CONFIRMED 必填 evidence_path 且须真实存在（无证据不结论）。

**参数 schema**（`additionalProperties: false`）：

| 参数 | 类型 | 必填 | 默认 | 校验 |
|---|---|---|---|---|
| `program` | string | 是 | — | `^[a-z0-9][a-z0-9-]{0,62}$` |
| `asset` | string | 是 | — | 非空 |
| `card_id` | string | 是 | — | 漏洞卡 ID（VC-xxx）；非卡片动作用 `MC-xx` / `PC-xx` / `-` |
| `card_ver` | string\|number | 否 | — | 卡版本 |
| `tool` | string | 是 | — | 工具/动作名 |
| `result` | string | 是 | — | 枚举六态（见 2.2.1） |
| `reason` | string | 条件 | — | `result ∈ {NOT_APPLICABLE, BLOCKED}` 时必填；小写化后 ∉ `{other, misc, ''}` 且长度 ≥4（`E_LEDGER_REASON_INVALID`） |
| `evidence_path` | string | 条件 | — | `result ∈ {TESTED_CLEAN, CONFIRMED}` 时必填且**文件存在**（绝对路径，或相对 `data/` 解析后存在；`E_EVIDENCE_REQUIRED` / `E_LEDGER_EVIDENCE_MISSING`） |
| `run_id` | string | 否 | 自动生成 | 关联执行（取证链） |

**不变量（网关逐条执行；这是 v4.6 从事后脚本提前到写入时的核心迁移）**：

| # | 不变量 | 失败码 | 典型 hint |
|---|---|---|---|
| I1 | result ∈ 六态枚举 | `E_SCHEMA` | message 列枚举 |
| I2 | N/A、BLOCKED ⇒ reason 必填且非 other/misc/空 | `E_LEDGER_REASON_INVALID` | `NOT_APPLICABLE 须填 na_reason（为什么卡不适用）；BLOCKED 须填 blocker（缺什么前置）——"other/misc"不构成理由` |
| I3 | TESTED_CLEAN、CONFIRMED ⇒ evidence_path 必填且存在 | `E_EVIDENCE_REQUIRED` / `E_LEDGER_EVIDENCE_MISSING` | `无证据不结论。CLEAN 与 CONFIRMED 同级举证：evidence_path 指向本次探测的原始输出（如 results/<run_id>/ 或 evidence/ 目录）` |
| I4 | program 目录存在或可建 | `E_BACKEND_UNAVAILABLE` | — |

**写入**：TSV 追加 `data/pipeline/{program}/attempts-{program}.tsv`（表头 9 列见 2.1.1；ts 列北京时区 ISO `+08:00`，服务端生成，调用方不传）。原子性：单行 O_APPEND 追加。
**幂等**：自动指纹 `sha1(program,asset,card_id,card_ver,tool,result,reason,evidence_path,run_id)`——网络层重试保护；刻意重复记账被幂等表拦截（这正是纪律想要的：同动作同结果同证据的重复落行=记账错误）。
**返回 data**：`{file, row_ts, run_id}`。
**actor**：model（绝大多数）, script, human。**RoE**：每动作立即一行，禁攒批；CLEAN 同级举证；六态之外没有"做了但没结果"——做了就必须落行。

#### 1.3.2 `ledger_log_card_usage`

**agent_note**：卡片使用记录（card_usage-YYYY-MM-DD.jsonl）。outcome=deviated（实战与卡片规程有偏差）时 deviation 必填 ≥10 字——那是卡片升版的原料。

| 参数 | 类型 | 必填 | 默认 | 校验 |
|---|---|---|---|---|
| `program` | string | 是 | — | 同上 |
| `card_id` | string | 是 | — | 卡 ID |
| `card_version` | string\|number | 是 | — | 卡版本 |
| `asset` | string | 是 | — | 资产 |
| `outcome` | string | 是 | — | 枚举 `applied`（照卡执行）/ `deviated`（有偏差）/ `blocked`（被前置卡住）/ `na`（不适用） |
| `deviation` | string | 条件 | — | `outcome=deviated` 时必填 ≥10 字（`E_LEDGER_DEVIATION_REQUIRED`） |
| `suggest` | string | 否 | — | 卡片修改建议 |
| `result` | string | 否 | — | 自由摘要（向后兼容字段） |
| `run_id` | string | 否 | 自动 `cu…` | — |

不变量：I5 `outcome=deviated ⇒ deviation ≥10 字`——v4 的"实战偏差必填"是调用纪律，v5 从 hint 升级为 schema 级硬校验。
写入：JSONL 追加 `card_usage-{北京日期}.jsonl`。幂等：自动指纹。事件：`card_usage.logged`。
**actor**：model, script。

#### 1.3.3 `ledger_radar_push`

**agent_note**（script/approval 面描述）：变化雷达事件入队（CT 新子域 / JS 发版 / 版本情报 / 新授权域名）。recon 任务开局 drain 全清处置——变化优先于存量。

| 参数 | 类型 | 必填 | 校验 |
|---|---|---|---|
| `program` | string | 是 | 同上 |
| `type` | string | 是 | 枚举 `ct-new-subdomain` / `js-bundle-change` / `scope-approved` / `version-intel` |
| `payload` | object | 是 | type 专属必填键（见下表） |

| type | payload 必填键 |
|---|---|
| `ct-new-subdomain` | `domain`（新子域） |
| `js-bundle-change` | `host`, `bundle`（hash/路径） |
| `scope-approved` | `domain`, `source`（=approval） |
| `version-intel` | `component`, `from`, `to` |

> `version-intel` 语义边界：指**目标组件指纹版本**（JS bundle / 响应头 / favicon 识别出的组件升版，驱动 N-day 派单）。它与 `scripts/pipeline/dsh-version-watch.sh`（监控**上游 DSH 平台自身版本**、产 pipeline/dsh-version-watch.log、不进雷达队列）语义不同源不同表——后者是运维观测通道，v5 保持独立不合并（18-migration §9.4）。

写入：JSONL 追加 `radar-queue.jsonl`（记录结构见 2.1.3）。事件：`radar.pushed`。幂等：自动指纹 `sha1(program,type,payload 核心键)`。
**接入方迁移**：v4 的 ct-watch-all.sh / js-watch.py **直接写文件**——v5 改调总线 CLI `sec ledger radar-push --program X --type ct-new-subdomain --payload '{"domain":"a.x.com"}'`（actor=script 由 CLI 环境注入）；观察期内域启动时收割 inbox 兼容（`radar-inbox.jsonl` 由脚本旧版写入、域启动 drain 入正式队列后清空，一个观察期后删 inbox 路径）。v4 index.js `enqueueScopeSeed` 的 radar 直写 → approval 域订阅 `approval.approved` 后**调本命令**（actor=approval，弱联动 best-effort，入队失败不影响批准结果——v4 双通道语义保留）。
**actor**：script, approval, model, system。

#### 1.3.4 `ledger_radar_drain`

**agent_note**：读取变化雷达队列并清空（drain 语义：读后即清，防重复处置）。recon 开局调用；只读不清用 `ledger_radar_status`。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `program` | string | 是 | — |

行为：读 `radar-queue.jsonl` 全部行 → 解析为事件数组（坏行降级为 `{raw: line}` 保留）→ **清空文件**（tmp 空文件 + rename，原子）→ 返回事件清单。返回 data：`{count, events[], drained: true}`。
幂等：天然——再 drain 返回空集（信封 replay 语义不适用，每次 drain 都是新读）。事件：`radar.drained {program, count}`（count=0 也发，供对账）。
**为什么是命令不是查询**：清空是文件状态变更（宪法 §七 查询纯读）；只读面拆给 `ledger_radar_status`。
**actor**：model, script。

#### 1.3.5 `ledger_handoff_write`

**agent_note**：写当日交接包（handoff-YYYY-MM-DD.md，五段全量覆盖写）。收尾强制产物：快照/动作/明日队列/阻塞/数据指针。FGS 决策链摘要先调 fgs_export 查询取回，并入动作段。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `program` | string | 是 | — |
| `snapshot` | string | 是 | 段一·快照：当前覆盖/资产/队列状态摘要 |
| `actions` | string | 是 | 段二·动作：本轮做了什么（含 FGS 摘要、关键 run_id） |
| `tomorrow_queue` | string | 是 | 段三·明日队列：下一轮优先处置项 |
| `blockers` | string | 是 | 段四·阻塞：当前阻塞项（无则显式"无"） |
| `data_refs` | string | 是 | 段五·数据指针：关键数据文件路径清单 |

不变量：五段全部必填且非空（`E_SCHEMA`；blockers 无内容须传 `"无"`——显式确认而非缺省）。写入：`handoff-{北京日期}.md` 全量覆盖（tmp+rename 原子；覆盖前旧版存 `.prev`，仅保留一代）。幂等：自动指纹 `sha1(program + 五段内容)`——同日同内容重写 = replay；同日内容演进 = 新指纹新写（覆盖 + .prev 备份），无 `E_IDEMPOTENT_CONFLICT` 误伤。事件：`handoff.written {program, date, file}`。
**actor**：model, script, human。

### 1.4 查询（读投影）逐个详述

#### 1.4.1 `ledger_attempts_list`

| 参数 | 类型 | 必填 | 默认 |
|---|---|---|---|
| `program` | string | 是 | — |
| `asset?` / `card_id?` / `result?`（六态之一）/ `run_id?` | string | 否 | — |
| `since?` / `until?` | string（北京 ISO） | 否 | — |
| `limit` / `offset` / `sort`（白名单：`ts`）+ `dir` | — | 否 | 50 / 0 / ts desc |

返回统一分页信封 `{rows, total, limit, offset}`（行数=total 同 where 构造器——契约测试必断言）。纯读。

#### 1.4.2 `ledger_coverage_report`

**agent_note**：attempts 台账聚合为覆盖矩阵视图（卡片 × 最新态计数 + BLOCKED 解锁收益表）。**报告数字唯一来源，禁手填**。

| 参数 | 类型 | 必填 | 默认 |
|---|---|---|---|
| `program` | string | 是 | — |
| `materialize` | boolean | 否 | true |

聚合口径（v4 算法原样）：按 `(asset, card_id)` 组合取 **ts 最新行**（北京 ISO 字典序比较），六态计数成卡片 × 状态矩阵；`BLOCKED` 行按 reason 聚合"解锁收益表"（每个 blocker 解锁多少单元格）。**PENDING 是隐含态**：矩阵中未出现的组合即未落行。
返回 data：`{combos, cards, matrix[{card, ver, clean, confirmed, fp, na, blocked, stale}], blocker_gain[{blocker, cells}]}`。
**缓存物化（非命令副作用）**：`materialize=true` 时结果写 `coverage-latest.md`（生成时间戳 + 台账行数 + 矩阵表，文件头注明"工具生成，禁止手填修改"）。**定性**：coverage-latest.md 是查询缓存（stale-while-revalidate：attempts TSV mtime 变化即失效重算），缓存写不是领域数据变更、不进审计——查询因此保持宪法 §七"纯读"语义（对齐 know 域 curated 索引先例）。`materialize=false` 供纯读场景（看板高频刷新）。

#### 1.4.3 `ledger_radar_status`

| 参数 | 必填 |
|---|---|
| `program` | 是 |

返回 `{count, by_type: {…}, oldest_ts, empty: bool}`。纯读不清空。

#### 1.4.4 `ledger_discipline_stats`（原 opsHealth 数据源）

**agent_note**：纪律五指标（台账日增量/卡使用 7d/交接包 7d/IdeaCard 数/调度漂移）+ 告警清单——纪律是否在线的一眼视图。

| 参数 | 类型 | 必填 |
|---|---|---|
| `program?` | string | 否（缺省=全部项目聚合） |

| 指标 | 口径 | 数据源 |
|---|---|---|
| 台账日增量 | 近 24h attempts 新增行数 | 本域文件 |
| 卡使用 7d | 近 7 天 card_usage 记录数 | 本域文件 |
| 交接包 7d | 近 7 天 handoff 文件数 | 本域文件 |
| IdeaCard 数 | vulncards/ideas/ 计数 | **know 域查询**（`dispatch('know', …)` 经 QueryGateway） |
| 调度漂移 + task_runs 新鲜度 | 漂移任务数 / 最近 run 距今 | **task 域查询**（同上） |
| **数据源新鲜度/错误率** | ct-watch / js-watch 最近一次成功拉取距今 + 近期 429/error 率——**"systemd active"≠功能健康**（ct-watch 长期 429 时本指标告警，不因进程 active 而 healthy） | 雷达源日志 + `ledger_radar_status` 的 oldest_ts |

跨域指标全部经 QueryGateway 委托查询（不 import、不直读他域文件）；know/task 域不可达时对应指标降级为 `unavailable` 并入告警清单（查询整体不失败）。60s 内存缓存（§2.5）。

#### 1.4.5 `ledger_pipeline_validate`（复核查询，保留）

**agent_note**：标准产物格式机器校验（收尾复核/存量体检；写入时校验已在 `ledger_log_*` 网关不变量生效，本查询降级为复核面）。

| 参数 | 必填 |
|---|---|
| `files`: string[]（绝对路径列表） | 是 |

校验规则（v4 validateFile 全量保留）：attempts-/assets-/endpoints-/egress-health- 四类 TSV 表头 + 行级校验（列数 / ts 格式 / result 枚举 / reason / evidence_path）、card_usage- JSONL 字段完备性。**注意**：文件本体 owner 各异（本域 attempts/card_usage、asset 域 assets-、endpoint 域 endpoints-），本查询只验**格式契约**（§2.1 定义），不写任何文件。返回 `{ok, errors[], checked}`。

#### 1.4.6 `ledger_task_proof`（task_finish 守卫的证明接口）

| 参数 | 类型 | 必填 |
|---|---|---|
| `program` | string | 是 |
| `since_ts` | integer（epoch ms） | 是（task 域传 now-24h） |

返回三产物证明：

```json
{ "attempts_delta_24h": 17, "card_usage_24h": 3, "handoff_today": true,
  "evidence": { "attempts_file": "…tsv", "handoff_file": "…md" } }
```

这是 §2.3.3 流程守卫联动的取数接口——**task 域 task_finish 的前置不变量经 QueryGateway 同步调本查询**，fail-closed（任一为空/零 → task 域拒落 done 并返回 missing 清单）。

#### 1.4.7 `ledger_usage_query`（know 域消费接口，卡片使用统计）

know 域（07-know.md C16 消费通道）经本查询获取卡片使用信号，**不读本域文件**。

| 参数 | 类型 | 必填 | 默认 |
|---|---|---|---|
| `card_id?` | string | 否 | —（空=全卡聚合） |
| `program?` | string | 否 | — |
| `since_days` | integer | 否 | 30 |
| `aggregate` | string | 否 | `counts`（枚举：`counts` 计数 / `deviations` 偏离明细） |

返回：`counts` → `{rows: [{card_id, uses, last_used_at, deviated}], total}`；`deviations` → `{rows: [{ts, card_id, deviation, suggest, run_id}], total}`（分页同宪法 §七）。纯读，跨域消费走 QueryGateway（know_health 零使用卡判据、registry 健康度、卡片升版原料分析）。模型侧亦可直接调用（低频运维用途）。

### 1.5 事件

#### 1.5.1 发布事件总表

| 事件 | payload 顶层字段 |
|---|---|
| `attempt.logged` | `program, asset, card_id, result, reason?, run_id` |
| `card_usage.logged` | `program, card_id, card_version, outcome, deviation?` |
| `radar.pushed` | `program, type, digest（payload 核心键 sha256 前 16）` |
| `radar.drained` | `program, count` |
| `handoff.written` | `program, date, file` |

全部按域追加 `data/events/ledger.jsonl`。payload 只含判据快照（宪法 §八.1）。

#### 1.5.2 订阅声明

| 事件 | 模式 | 处理器 | 语义 |
|---|---|---|---|
| `exec.run.completed` | async（弱） | `onRunCompleted` | **对账统计，不自动代写台账**：维护 per-program 每日 `exec_runs` 计数，与 attempts 日增量对账——执行了 N 次工具但台账只有 M 行（M ≪ N）→ discipline_stats 告警"台账漂移"。**不自动写台账的理由**：台账是 agent 的纪律动作本身（每动作的反身记录），机器代写会消解纪律并污染覆盖矩阵的"agent 判定"语义；机器只负责暴露漂移 |
| `approval.approved`（kind=scope-domain / scope-wildcard） | async（弱） | `onScopeApproved` | 调 `ledger_radar_push`（type=scope-approved，actor=approval）——v4 enqueueScopeSeed 直写 radar 文件的归零路径；best-effort，失败记 `subscriber_failed` 不影响批准 |

**task 域对本域三事件的订阅（对侧声明，此处仅备案）**：`attempt.logged` / `card_usage.logged` / `handoff.written` → task 域计数缓存（看板红条）。**守卫依据不是这个缓存**——两种方案的取舍论证见 §2.3.3。

### 1.6 模型工具面投影（工具名 + 描述全文）

| 工具名 | 描述（manifest `agent_note`） | 模型可见 |
|---|---|---|
| `ledger_log_attempt` | 六态覆盖台账追加（写入即机器校验，违规则拒绝）。每个探测动作完成后必须立即调用一次，禁止攒批。result 枚举 TESTED_CLEAN/CONFIRMED/FALSE_POSITIVE/NOT_APPLICABLE/BLOCKED/STALE；N/A 与 BLOCKED 必填 reason（禁 other/misc）；TESTED_CLEAN 与 CONFIRMED 必填 evidence_path 且须真实存在——无证据不结论。 | 是 |
| `ledger_log_card_usage` | 卡片使用记录（card_usage-YYYY-MM-DD.jsonl）。outcome=applied 照卡执行 / deviated 实战有偏差 / blocked / na；deviated 必填 deviation（≥10 字，卡片升版原料），有建议填 suggest——不回执的卡会被判零使用沉没。 | 是 |
| `ledger_radar_drain` | 读取变化雷达队列（CT 新子域/JS 发版/新授权域名事件）并清空。recon 开局调用；变化优先于存量，新子域黄金窗口优先处置。只看不清用 ledger_radar_status。 | 是 |
| `ledger_radar_push` | 雷达事件入队（一般由 ct-watch/js-watch/审批链自动写入；模型侧仅在发现应入队事件时使用）。 | 是 |
| `ledger_handoff_write` | 写当日交接包（五段：快照/动作/明日队列/阻塞/数据指针，全量覆盖写）。收尾强制产物；FGS 决策链摘要先调 fgs_export 并入动作段。 | 是 |
| `ledger_attempts_list` | 台账行查询（program/asset/card/result/时间窗过滤 + 分页）。 | 是 |
| `ledger_coverage_report` | attempts 聚合覆盖矩阵（卡片×最新态计数 + BLOCKED 解锁收益表）。报告数字唯一来源，禁手填——选格子消化以本查询为准。 | 是 |
| `ledger_radar_status` | 雷达队列状态（深度/类型分布/最老事件），纯读不清空。 | 是 |
| `ledger_discipline_stats` | 纪律五指标 + 告警清单（台账日增量/卡使用 7d/交接包 7d/IdeaCard/调度漂移）。 | 是 |
| `ledger_pipeline_validate` | 标准产物格式机器校验（收尾复核；写入时校验已在 ledger_log_* 生效）。 | 是 |
| `ledger_usage_query` | 卡片使用统计（know 域消费接口：零使用卡判据/registry 健康度/升版原料 deviation 聚合；counts/deviations 两模式）。 | 是 |
| `ledger_task_proof` | （内部接口，task 域 task_finish 用；不向模型注册）三产物存在性证明。 | 否 |

### 1.7 看板 RPC 投影

| RPC | 源 | 看板用途 |
|---|---|---|
| `ledger.attempts_list` | 查询 | 台账视图（项目/结果态筛选） |
| `ledger.coverage_report` | 查询（materialize=false） | 覆盖矩阵热力表 + BLOCKED 解锁收益卡 |
| `ledger.radar_status` / `ledger.radar_drain` | 查询 / 命令 | 雷达徽章计数 / 手工清空（operator 进审计） |
| `ledger.discipline_stats` | 查询 | **ops 健康度红条**（v4 opsHealth 的数据源切换至此；30s 轮询打 materialize=false 纯读） |
| `ledger.handoff_write` | 命令 | 交接包查看/补写（读走文件内容查询，写带 operator） |

### 1.8 外部调用示例

**模型调用**（vuln 任务收尾）：

```json
{ "tool": "ledger_log_attempt",
  "params": { "program": "bytedance", "asset": "a.example.com", "card_id": "VC-034",
              "card_ver": 2, "tool": "curl+js", "result": "CONFIRMED",
              "evidence_path": "evidence/341/", "run_id": "r8x1k2ab" } }
```

**代码调用**（task 域 task_finish 前置不变量）：

```js
const bus = ctx.inject('secDomainBus')
const proof = await bus.query('ledger', 'task_proof',
  { program: 'bytedance', since_ts: Date.now() - 24 * 3600_000 })
if (!proof.data.attempts_delta_24h || !proof.data.handoff_today)
  return fail('E_INVARIANT', { missing: [...], hint: '补三产物后重试 task_finish' })
```

**脚本调用**（ct-watch systemd 单元内的推送）：

```bash
sec ledger radar-push --program meituan-src \
  --type ct-new-subdomain --payload '{"domain":"new-api.meituan.com"}'
# 人工复核（CLI 等价面，actor=human 审计高亮）
sec ledger coverage-report --program bytedance
```

---

## 二、内部实现

### 2.1 数据模型（文件格式逐列）

#### 2.1.1 `attempts-{program}.tsv`（9 列，v4 原样冻结）

| 列 | 类型 | 写入方 | 说明 |
|---|---|---|---|
| `ts` | string | 服务端 | 北京时区 ISO（`YYYY-MM-DDTHH:mm+08:00`，字典序可比） |
| `asset` | string | 调用方 | 资产 host |
| `card_id` | string | 调用方 | 卡 ID / MC-xx / PC-xx / `-` |
| `card_ver` | string | 调用方 | 版本（可空） |
| `tool` | string | 调用方 | 工具/动作 |
| `result` | string | 调用方 | 六态枚举 |
| `reason` | string | 调用方 | N/A 的 na_reason / BLOCKED 的 blocker（其他态可空） |
| `evidence_path` | string | 调用方 | 证据路径（CLEAN/CONFIRMED 必填） |
| `run_id` | string | 服务端兜底 | 关联执行（调用方可显式传） |

表头行在文件不存在时随首行写入（v4 tsvAppend 语义）。

#### 2.1.2 `card_usage-{date}.jsonl`

```json
{ "card_id": "VC-034", "card_version": 2, "asset": "a.example.com",
  "outcome": "deviated", "result": "（自由摘要）",
  "deviation": "卡 detect 第 3 步的端点 404，实际在 /api/v2",
  "suggest": "detect.steps 增加端点探测回退",
  "ts": "2026-09-06T12:01+08:00", "run_id": "cu…" }
```

必填键：card_id/card_version/asset/outcome/ts（outcome 为 v5 新增枚举列；存量行无 outcome → 读取层按 `deviation 存在 ? deviated : applied` 推导，不回填）。

#### 2.1.3 `radar-queue.jsonl`

```json
{ "ts": "2026-09-06T08:00+08:00", "type": "ct-new-subdomain",
  "domain": "new-api.example.com", "source": "ct-watch" }
```

（`scope-approved` 来源 source=approval；`version-intel` 带 component/from/to。）

#### 2.1.4 `handoff-{date}.md`（五段固定结构模板）

```markdown
# 交接包 — {program} — {北京日期}
## 1. 快照（snapshot）
## 2. 动作（actions，含 FGS 摘要与关键 run_id）
## 3. 明日队列（tomorrow_queue）
## 4. 阻塞（blockers）
## 5. 数据指针（data_refs）
```

#### 2.1.5 格式契约（本域定义、跨域文件遵守）

`assets-{program}.tsv`：`domain/status/first_seen/last_seen/source/probe_date`；`endpoints-{program}.tsv`：`url/method/params/auth_required/source/collected_at`；`egress-health*`：`egress/target_domain/ts/signature/verdict`。（文件 owner 在 asset/endpoint 域，`ledger_pipeline_validate` 按此契约校验。）

### 2.2 状态机与不变量

#### 2.2.1 覆盖格子状态机（隐式，无 PENDING 落行）

```
PENDING（未落行，矩阵中不出现）
  ──ledger_log_attempt──▶ 六态之一（TESTED_CLEAN / CONFIRMED / FALSE_POSITIVE /
                            NOT_APPLICABLE / BLOCKED / STALE）
同一 (asset, card_id) 组合再次落行 = 态覆盖（覆盖矩阵取 ts 最新行；历史行保留，审计可回溯）
```

六态不可迁移、不可撤销——写错行只能再落一行覆盖（台账只追加，禁改写；这是回放链路的前提）。

#### 2.2.2 网关前置校验清单（全量）

I1-I5（§1.3.1/1.3.2）+ 五段非空（handoff）+ type/payload 专属必填键（radar_push）+ 文件存在性（evidence_path、drain/validate 的目标文件）。每条失败返回对应错误码 + hint（§1.3 已逐条给出）。

### 2.3 事务与联动

#### 2.3.1 写入原子性

- TSV/JSONL 追加：Node `appendFileSync`（O_APPEND）单次 write；单行 <4KB，POSIX 保证同文件并发 append 不交错（多 worker 并发落行安全，v4 已是此形态）。
- drain / handoff 覆盖：tmp 写 + `rename` 原子替换。
- 文件不存在时建目录 + 写表头 + 追加：建目录幂等（`mkdir -p`），崩溃窗口内最多丢表头（下次写入重建）。

#### 2.3.2 弱联动清单

approval.approved → radar_push（§1.5.2）；订阅者失败不回滚批准。本域自身命令无强联动（无跨域业务正确性依赖）。

#### 2.3.3 流程守卫（task_finish 前置不变量）与 ledger 的数据契约

**契约**：task 域 `task_finish`（actor=scheduler）标 done 前校验三产物——作用域限 `schedule_kind='interval'` 且 `data/pipeline/{program}/` 存在的任务（无管线目录不拦，v4 语义）；缺失 → `E_INVARIANT` + missing 清单，任务不落 done（blocked/failed/cancelled 不拦——失败与放弃必须能落库）。

**两种实现方案的取舍**：

| | 方案 A：事件计数 | 方案 B'：文件取证（v5 选择） |
|---|---|---|
| 机制 | task 域订阅 attempt.logged / card_usage.logged / handoff.written 三事件，维护 per-program per-day 计数器；task_finish 查计数器 | task_finish 调 ledger 域 `ledger_task_proof` 查询（同步，经 QueryGateway），由 ledger 直接取证文件（24h 增量行数 / 卡记录数 / handoff 当日存在） |
| 优点 | O(1) 查询；跨域解耦 | **锚定真相源**——文件是唯一真相，取证结果与产物永远一致；计数器是派生信号 |
| 缺点 | 计数器需持久化（重启丢失 → 回退全量扫，否则误拦）；事件丢失/乱序 → 假阴 → fail-closed **误伤任务收尾**（调度链卡死）；24h 滚动窗口在计数器上要带时间衰减，实现易错 | 每次收尾多一次跨域查询（毫秒级，每日 ≤ 数十次，可忽略） |
| 结论 | 仅作看板红条缓存 | **守卫依据**（正确性必须锚定真相源；派生信号丢失会造成 fail-closed 误伤，而文件取证不可能与产物漂移） |

task 域对三事件的订阅**保留**（弱联动），用于 discipline_stats 实时对账与看板红条预览——两方案并存、各司其职：**A 管快，B' 管对**。

### 2.4 后端适配器

repository 接口（file 实现；原语不含业务校验）：

```js
// backend/repository.js
appendAttempt(program, row[9]) → {file}
appendCardUsage(program, date, record) → {file}
appendRadar(program, record) / readRadar(program) → records / drainRadar(program)
writeHandoff(program, date, sections{5}) → {file, prevSaved}
readTsv(file) → {header, rows} / readJsonl(file) → records
statAttemptsDelta(program, sinceMs) → number / statCardUsage(program, sinceMs) → number
hasHandoff(program, date) → boolean
```

能力矩阵：

| 命令/查询 | file（默认） | sqlite-local（可选） |
|---|---|---|
| 全部命令 | **full** | full（写穿透：命令落文件后异步镜像进索引视图） |
| attempts_list / coverage_report / task_proof / discipline_stats | full（全量扫） | full（索引加速） |
| 其余查询 | full | full |

**可选 sqlite 索引视图的必要性论证**：attempts 单项目当前 ~数千行（每日链 2 程序 × 每日 50-200 行），coverage 聚合全量扫 + 字符串比较实测 <100ms——**当前规模下纯 file 足够，不建**。引入触发条件（写进容量监控）：单项目 attempts >50,000 行，或 coverage_report / discipline_stats P95 >500ms。届时 sqlite 视图是**派生缓存**（文件仍是唯一真相源，视图可随时重建），不是第二真相源——这是它与宪法 §十二"混布"的区别声明。

### 2.5 缓存与失效

| 缓存 | 失效 |
|---|---|
| `coverage-latest.md` | attempts TSV mtime 变化（下次查询重算重物化；文件头带生成时间戳可人工识别陈旧） |
| discipline_stats 内存聚合 | 60s TTL |
| radar_status | 无缓存（单文件 mtime + size 检查，恒新） |

### 2.6 性能与容量

| 指标 | 现状 | 增长预估 | 阈值动作 |
|---|---|---|---|
| attempts TSV | 数千行/项目 | +50-200 行/日/项目 | >50k 行启用 sqlite 视图（2.4） |
| card_usage JSONL | 数百行 | +10-30 行/日 | 无（小文件） |
| radar-queue | 常态 <20 行（drain 清空） | — | 无 |
| handoff | 每项目每日 1 文件 + .prev | 365×2 文件/年/项目 | vault 归档链路既有节奏 |
| coverage 聚合 | <100ms | 线性于行数 | P95>500ms 触发 2.4 |

---

## 三、迁移与兼容

### 3.1 现状代码映射（行级）

来源：`bundles/dsh/templates/dsh-plugin-sec-pipeline.js`（467 行）+ `dsh-plugin-sec-suite.js` + `scripts/pipeline/`。

| # | v4 位置 | 内容 | v5 去向 |
|---|---|---|---|
| 1 | sec-pipeline.js:91-124 | toolAttemptsLog（校验内嵌 execute） | `commands/log-attempt.js`；校验升格网关 invariants I1-I3（新增 I3 的 evidence_path **存在性**检查——v4 只查非空） |
| 2 | sec-pipeline.js:126-155 | toolCardUsageLog | `commands/log-card-usage.js`；新增 outcome 枚举 + I5 |
| 3 | sec-pipeline.js:157-178 | toolRadarRead（读后清空） | 拆两半：`ledger_radar_drain`（命令）+ `ledger_radar_status`（查询） |
| 4 | sec-pipeline.js:180-225 | SCHEMA_MATCH / validateFile | `ledger_pipeline_validate` 查询（复核定位降级——写入时校验已前移） |
| 5 | sec-pipeline.js:227-245 | toolPipelineValidate | 同上 |
| 6 | sec-pipeline.js:247-295 | toolCoverageReport（聚合 + 写 md） | `ledger_coverage_report` 查询 + coverage-latest.md 缓存物化（§1.4.2 定性） |
| 7 | sec-pipeline.js:319-363 | toolVerifyReplay | **归 vuln 域**（`vuln_verify_replay`，02-vuln.md）。论证：操作对象是 `evidence/{finding_id}/`（vuln owns），判定结果（PASS/FAIL hash）回写 verify-log 并影响 finding 置信——是漏洞证据复核，不是纪律记录。台账域管"记录"，不管"证据判定" |
| 8 | sec-pipeline.js:404-443 | toolSurfaceQueue（param-queue/seen） | **归 endpoint 域**（`endpoint_queue_surface` / `endpoint_consume_queue`，04-endpoint.md）——参数队列是接口面资产 |
| 9 | sec-pipeline.js:365-402 | toolSurfaceScan（敏感回扫） | **归 endpoint 域**（`endpoint_surface_scan` 查询）——对接口面/参数数据的脱敏检查，与 surface_queue 同族 |
| 10 | sec-pipeline.js:37-68 | makeRunId / nowIso / pipelineDir / tsvAppend / readTsv | file backend 原语（§2.4） |
| 11 | sec-suite.js:468-492 | enqueueScopeSeed（radar 直写 + 种子任务） | radar 半段 → approval 域订阅者调 `ledger_radar_push`；种子任务半段 → task 域命令（05-task.md） |
| 12 | scripts/pipeline/ct-watch-all.sh / js-watch.py | 直写 radar-queue.jsonl | 改调 `sec ledger radar-push` CLI（actor=script）；inbox 兼容收割一个观察期 |
| 13 | asset-db.js taskUpdate 流程守卫段 | 三产物事后 SQL/文件查 | task 域 `task_finish` 不变量 + `ledger_task_proof`（B' 方案，§2.3.3） |
| 14 | asset-db.js opsHealth | 五指标 | `ledger_discipline_stats`（IdeaCard/漂移指标改经 know/task 域查询委托） |
| 15 | scripts/pipeline/discipline-audit.py | CLI 等价面 | 改调 `ledger_discipline_stats` 查询渲染（断言逻辑不变） |
| 16 | scripts/pipeline/coverage-report.py / pipeline-validate.py | 旧脚本版（退役观察期） | 随 v5 上线删除（已被域查询取代且无 prompt 依赖） |
| 17 | asset-graph.js appendFgsToHandoff 调用链 | FGS 摘要直写 handoff | 废止直写；模型经 `fgs_export` 查询取摘要并入 `ledger_handoff_write` actions 段（14-fgs.md 联动声明） |

**verify_replay 归属的边界论证（详）**：三个候选——vuln（证据复核）/ ledger（台账家族）/ eval（假阳性消融）。判 vuln：①操作对象与产物（evidence 包、verify-log）都是 vuln 域 owns；②复核结论驱动 finding 状态机（CONFIRMED 的置信来源）；③ledger 的文件家族（attempts/card_usage/radar/handoff/coverage）全部是"纪律动作的记录"，verify_replay 是"证据的机械判定"——记录 vs 判定不同族；④eval 只消费其结果（回流活评测集），不是 owner。

### 3.2 兼容别名与观察期

| 旧名（v4 工具） | 新名 |
|---|---|
| `attempts_log` | `ledger_log_attempt` |
| `card_usage_log` | `ledger_log_card_usage` |
| `radar_read` | `ledger_radar_drain`（drain=true 默认语义不变；drain=false 旧行为 → `ledger_radar_status`） |
| `pipeline_validate` | `ledger_pipeline_validate` |
| `coverage_report` | `ledger_coverage_report` |
| `surface_queue` | `endpoint_queue_surface`（**endpoint 域**，跨域别名） |
| `surface_scan` | `endpoint_surface_scan`（endpoint 域） |
| `verify_replay` | `vuln_verify_replay`（**vuln 域**，跨域别名） |

别名过网关全管线（不绕校验）；7 天观察期 audit 零使用后删除；prompt 工具引用脚本化改写（p14-1 模式）。

### 3.3 数据迁移脚本要点

1. **存量文件零迁移**：attempts TSV（9 列）/ radar-queue.jsonl / handoff-*.md / coverage-latest.md 原样接管（格式冻结）。
2. card_usage 存量行缺 `outcome` 键：读取层兼容推导（deviation 存在 → deviated，否则 applied），不回填不重写。
3. 首次 `ledger_coverage_report` 调用重算并覆盖 coverage-latest.md（旧文件头无"工具生成"标注也无妨）。
4. sqlite 索引视图（若启用）：`sec ledger rebuild-index --program X` 从 TSV 全量重建（幂等可重跑）。
5. 回滚：域插件 revert；文件层 v5 与 v4 写入格式逐字节兼容（列/键零变化），双向可退。

---

## 四、开放问题

| # | 问题 | 当前倾向 |
|---|---|---|
| 1 | `ledger_coverage_report` 的 coverage-latest.md 物化写在"查询纯读"边界上（定性为缓存写入） | 接受（对齐 know 域 curated 索引先例）；若评审认为越界，升格为命令 `ledger_coverage_materialize` + 纯读查询拆分 |
| 2 | ct-watch/js-watch 改走 `sec` CLI 后，systemd 单元依赖总线 CLI 可用性（总线未起时事件丢失） | inbox 文件兜底（脚本降级写 radar-inbox.jsonl，域启动收割）；或接受丢失（雷达是 best-effort 旁路，CT 日志可重放） |
| 3 | 台账"每动作立即落行"与模型攒批倾向的张力——discipline_stats 对账告警是唯一机器压力 | 保持：不自动代写（§1.5.2 论证），告警 + 周复盘人工施压；若漂移持续超标再评估"run 完成后自动落 PENDING 行、agent 补态"的折中（会引入 PENDING 落行，破坏 2.2.1 隐式态设计，慎动） |
| 4 | handoff 同日多次覆盖只保留一代 `.prev`，人工可能想看更早版本 | vault 链路有日级归档兜底；暂不加版本链 |
