# 06 · fact 域设计（事实图谱 / 黑板环境层 / 负知识）

> 版本：v5.0 ｜ 状态：草案 ｜ 契约版本：fact@1
> 依赖：总线（01-bus.md，命令/查询网关、事件、幂等、审计）；宪法（00-conventions.md）。
> 订阅：`task.finished`、`fgs.node.done`（FGS 沉淀）；`exec.run.failed`（负知识自动证伪）；`approval.approved`（exclude-exception 留档）。
> 被订阅：`fact.*` 全系事件——memcore（治理旁路）、know（[env-issue] → AGENTS.md 刷新）、dashboard（视图）。
> owns（单写者）：`facts` 表、`fact_edges` 表、`blackboard` 表、`facts_archive`/`blackboard_archive` 表、`data/events/fact.jsonl`。

---

## 一、对外暴露（External Surface）

### 1.1 服务标识与挂载

| 项 | 值 |
|---|---|
| 域名 | `fact` |
| cordis 服务名 | `secDomain.fact`（provide），总线与投影层 inject |
| 插件包名 | `@silksec/sec-domain-fact` |
| 后端插件包名 | `@silksec/sec-backend-fact-sqlite`（默认 sqlite-local）；http-remote 为 Phase 4+ 规划（见 2.4） |
| profile 挂载矩阵 | `web` 与 `headless` **都挂载**（worker 任务开局三步检索第一步即 fact_search；写入与读取两侧都不可缺席） |
| 模型工具面 | 见 1.6（13 个工具，与命令/查询名零改名） |
| 看板 RPC 面 | 见 1.7 |
| 后端配置键 | `sec_domain_fact_backend: sqlite-local`（运行态唯一合法值；http 切换需重启宿主面） |

### 1.2 命令（写动词）总表

| # | 动词 | 一句话语义 | actor 白名单 | 幂等键 | 发布事件 |
|---|---|---|---|---|---|
| C1 | `fact_upsert` | 写入/覆盖一条事实（自然键 (program_id, fact_key)，memcore 分类自声明） | model, dashboard, script, approval, system | 自动指纹 | fact.upserted |
| C2 | `fact_correct` | 人工纠正确认：覆盖显式字段并将 confidence 升为 confirmed | dashboard, human | 自然键 | fact.upserted |
| C3 | `fact_deprecate` | 证伪弃置：confidence → deprecated（终态） | model, dashboard, human | 自然键 | fact.deprecated |
| C4 | `fact_link` | 建立两条事实的关系边（7 种语义边型） | model, dashboard | 自动指纹 | fact.linked |
| C5 | `fact_record_validation` | 复验刷新：durable 续复验期 / ephemeral 顺延 TTL / cooling 自愈复活——memcore 的合法复验写通道 | model, dashboard, script, system | 自动指纹 | fact.validated |
| C6 | `fact_bb_publish` | 黑板环境层发布（[env-issue]/[timeline]/全局广播；快照前缀拒绝） | model, dashboard, script | 自动指纹 | fact.bb.published |
| C7 | `fact_transition` | 治理通道：生命周期降级流转（active→cooling、\*→archived），memcore/sweep 专用 | system, human | 自动指纹 | fact.cooled / fact.expired / fact.archived |
| C8 | `fact_record_signal` | 使用信号：uses+1、last_used_at（搜索副作用显式化后的补偿命令） | model, system | 自动指纹 | （无，manifest events: []） |
| C9 | `fact_reindex` | 图谱自动建边：按共享域名根 / C 段建 star 型关系边 | model, dashboard, script, system | 自然键 | （无，events: []） |

> 命名说明：v4 的 `blackboard_set` 在 v5 更名为 `fact_bb_publish`（宪法 §二 禁用词 `set`）；`blackboard_get` 更名为查询 `fact_bb_read`。旧名走别名（3.2）。

### 1.3 命令逐个详述

#### C1 · fact_upsert

**语义**：写入或覆盖一条事实。`(program_id, fact_key)` 是对象身份；同键再写 = 合法覆盖（刷新 updated_at 与生命周期列），**不是**幂等冲突。

**参数表**（additionalProperties: false）：

| 参数 | 类型 | 必填 | 默认 | 校验 |
|---|---|---|---|---|
| program_id | string | 是 | — | 非空；`__legacy__` 保留给黑板迁移行 |
| fact_key | string | 是 | — | 非空且含 `/`（格式 `category/slug`，如 `auth/cred-admin`、`fgs/12/88`、`bb/note:xxx`） |
| category | string | 否 | `''` | 建议枚举 auth/target/note/finding/chain/exploit/asset/scope/fgs（不强制） |
| summary | string | 否 | `''` | ≤300 字符（INV-F9a）；一行索引，会注入 prompt |
| body | string | 否 | `''` | ≤4000 字符（INV-F9b）；完整可复现上下文 |
| confidence | string | 否 | `tentative` | ∈ {confirmed, tentative, deprecated} |
| pinned | integer | 否 | 0 | ∈ {0,1}，置顶 |
| related_finding_id | integer | 否 | null | vuln 域 finding id（不校验存在性，弱引用） |
| source | string | 否 | `''` | 溯源标签（如 `auto:runcli-fail`、`fgs-persist`、`approval`） |
| mem_class | string | 否 | 按 category 推导 | ∈ {durable, ephemeral, timeline}（INV-F1）；缺省：`note`→ephemeral(14d)，其余→durable(30d) |
| ttl_days | number | 否 | note=14 / 其余=14 | ephemeral 专用，∈ [1/24, 30]（INV-F3） |
| revalidate_days | number | 否 | 30 | durable 专用，∈ [7, 90]（INV-F4） |
| justification | string | 否 | `auto:default 缺省分类` | 工作/情景层可缺省（R6 仅语义层硬性）；显式传入时禁占位符（单字符重复） |
| scope | string | 否 | `program:{program_id}` | — |

**返回 data**：`{ program_id, fact_key, mem_class, confidence, merged: true|false }`（merged=同键覆盖）。

**错误码**：

| code | 触发 | hint |
|---|---|---|
| E_SCHEMA | fact_key 不含 `/`、confidence 非法、类型错 | fact_key 格式 category/slug，如 auth/cred-admin |
| E_INVARIANT (INV-F1) | mem_class 非法 | facts 允许 durable/ephemeral/timeline；permanent 方法论归 know 域 exp_store |
| E_INVARIANT (INV-F3) | ttl_days 越界 | ephemeral TTL 须在 1 小时~30 天；note 类速记建议 14 天 |
| E_INVARIANT (INV-F4) | revalidate_days 越界 | durable 复验期须在 7~90 天，默认 30 天 |
| E_INVARIANT (INV-F9) | summary>300 或 body>4000 字符 | 压缩 summary 为一行索引，全文拆进 body；超大内容走 report 域 |

**幂等**：自动指纹（网关对 `(program_id, fact_key, summary, body, confidence, mem_class, ttl/revalidate_days)` 取 sha1）。同参重放返回首次结果 + `replay:true`，**不产生第二次写**——v4 "FGS 冲突即刷新 last_validated_at" 的语义由 replay 通道承接；确需刷新时效用 C5 fact_record_validation。异参 = 新指纹 = 正常覆盖执行。

**事务边界**：BEGIN IMMEDIATE 内完成 facts 行 UPSERT（含生命周期列推导）；无跨表联动。

**agent_note（RoE）**：写入/覆盖一条事实（跨会话共享，边渗透边记录）。fact_key 格式 category/slug（如 auth/cred-admin、note/failed-xxx）。summary 一行索引会注入 prompt，body 按需 fact_get 拉取，禁止臆造。confidence: confirmed/tentative/deprecated。memcore 治理：note 类默认 ephemeral 14 天（负知识，neg_check 依赖其可见性），其余默认 durable 30 天复验；可用 mem_class/ttl_days/revalidate_days/justification 自声明。写记忆前三问：会过期吗 / 换目标有用吗 / 谁会读它——目标特定事实进本表，可迁移方法论进 know 域 exp_store（勿混）。

#### C2 · fact_correct

**语义**：人工纠正确认。只覆盖显式提供的字段，其余保留原值；confidence 固定升为 `confirmed`（tentative → confirmed 流转）。

**参数表**：

| 参数 | 类型 | 必填 | 默认 | 校验 |
|---|---|---|---|---|
| program_id | string | 是 | — | — |
| fact_key | string | 是 | — | — |
| category / summary / body | string | 否 | 保留原值 | 同 C1 的 INV-F9 |
| evidence | string | 是 | — | ≥10 字：纠正依据（run_id / 复核结论） |

**返回 data**：`{ program_id, fact_key, confidence: 'confirmed' }`。
**错误码**：E_NOT_FOUND（hint：先 fact_search 定位）；E_STATE（已 confirmed 再纠正——hint：补充信息用 fact_upsert，证伪用 fact_deprecate）；E_EVIDENCE_REQUIRED（hint：纠正必须附依据，如 run_id 或复核结论 ≥10 字）。
**幂等**：自然键 `fact:correct:{program_id}/{fact_key}`；同键异参 → E_IDEMPOTENT_CONFLICT。
**事务边界**：读原行 + UPSERT 单事务。
**agent_note（RoE）**：（看板/人工通道，模型不注册——模型侧确认走 fact_upsert confidence=confirmed）人工纠正确认一条事实：覆盖显式字段并将置信升为 confirmed，必须附 ≥10 字纠正依据。

#### C3 · fact_deprecate

**语义**：证伪弃置，confidence → `deprecated`（事实置信维度的终态；复活 = 用 fact_upsert 重新立论，新证据新写）。

**参数表**：program_id、fact_key（必填）；reason（string，必填，≥10 字：证伪依据）。

**返回 data**：`{ program_id, fact_key, confidence: 'deprecated' }`。
**错误码**：E_NOT_FOUND；E_STATE（已 deprecated）；E_EVIDENCE_REQUIRED（reason 缺/过短）。
**幂等**：自然键 `fact:deprecate:{program_id}/{fact_key}`。
**事务边界**：单行 UPDATE；同事务发 fact.deprecated。
**联动（弱）**：`related_finding_id` 非空时，vuln 域可订阅 fact.deprecated 做信号面降权（v4.5 FGS 联动的等价物，见 02-vuln.md）。
**agent_note（RoE）**：证伪弃置一条事实（confidence→deprecated 终态）。前提被推翻、路径已确认走不通时使用；reason ≥10 字说明证伪依据。证伪信息同时是负知识——若希望 neg_check 拦截后续派单，另存一条 note 类事实。

#### C4 · fact_link

**语义**：建立同 program 内两条事实的关系边；同 (src, dst, edge_type) 重发 = 覆盖 confidence（INSERT OR REPLACE 语义）。

**参数表**：

| 参数 | 类型 | 必填 | 默认 | 校验 |
|---|---|---|---|---|
| program_id | string | 是 | — | — |
| src_key / dst_key | string | 是 | — | 须已存在于同 program 的 facts（INV-F10，E_NOT_FOUND） |
| edge_type | string | 是 | — | ∈ {resolves_to, hosts, exposes, depends_on, leads_to, enables, exploits}（语义边型；same-domain/same-subnet 为 C9 派生边型，仅自动建边可写） |
| confidence | string | 否 | `tentative` | — |

**返回 data**：`{ program_id, src_key, dst_key, edge_type, confidence }`。
**错误码**：E_NOT_FOUND（src/dst 不存在——hint：先 fact_upsert 两端再建边）；E_SCHEMA（edge_type 非法/自环）。
**幂等**：自动指纹（src/dst/edge_type/confidence）。
**事务边界**：fact_edges 单行 REPLACE。
**agent_note（RoE）**：建立两条事实的关系边。edge_type: resolves_to/hosts/exposes/depends_on/leads_to/enables/exploits。边是攻击面聚类与关系遍历（fact_graph）的骨架；确认的解析关系用 confirmed，推断用 tentative。

#### C5 · fact_record_validation

**语义**：复验刷新——memcore 的合法复验写通道。效果：`last_validated_at=now`；durable → `revalidate_by = now + 原 revalidate_days`；ephemeral → `expires_at = now + 原 ttl_days`（顺延）；status=cooling → 自愈回 active。

**参数表**：program_id、fact_key（必填）；evidence（string，必填：复验依据，run_id 或 ≥10 字复核结论）；note（string，可选）。

**返回 data**：`{ program_id, fact_key, status: 'active', revalidate_by | expires_at }`。
**错误码**：E_NOT_FOUND；E_STATE（archived/timeline 不可复验——hint：归档行复活走数据修复脚本，见 3.3）；E_EVIDENCE_REQUIRED。
**幂等**：自动指纹（program_id, fact_key, evidence）——同一 run 的复验不重复计。
**事务边界**：单行 UPDATE + 状态自愈，单事务。
**agent_note（RoE）**：标记一条事实经复验仍然有效（刷新复验期/顺延 TTL；cooling 事实复验通过自动复活 active）。对检索命中且确认仍成立的事实回执调用；evidence 填 run_id 或复核结论。

#### C6 · fact_bb_publish

**语义**：黑板环境层发布。黑板是纯环境层（v4.6 口径）：`[env-issue]` 环境故障、`[timeline]` 时间轴流水、全局广播；**快照类前缀键一律拒绝**（不变量前置，替代 v4 sweep 事后转写守卫）。

**参数表**：

| 参数 | 类型 | 必填 | 默认 | 校验 |
|---|---|---|---|---|
| key | string | 是 | — | INV-F7：不匹配 `^(alive\|scan\|recon\|review\|note\|todo\|plan)[:_]`（快照/工作记录类→facts，走 C1）；建议 `[env-issue]`/`[timeline]` 前缀或裸键 |
| value | string | 是 | — | ≤4000 字符（INV-F9b） |
| mem_class | string | 否 | `ephemeral` | ∈ {ephemeral, timeline}（黑板无 durable） |
| ttl_days | number | 否 | 7 | ∈ [1/24, 30] |
| justification | string | 否 | `auto:default 缺省分类` | — |
| scope | string | 否 | `global` | — |

**返回 data**：`{ key, mem_class, expires_at | null }`。
**错误码**：

| code | 触发 | hint |
|---|---|---|
| E_INVARIANT (INV-F7) | 快照前缀键 | 快照/工作记录（alive:/scan:/recon:/review:/note:/todo:/plan:）属事实类——改用 fact_upsert（category=note，缺省 ephemeral 14d） |
| E_STATE (R7) | 改写既有 timeline 键 | timeline 键只追加不可改写，请换用带新日期的新 key |
| E_INVARIANT (INV-F1/F3) | mem_class 非法 / TTL 越界 | 黑板允许 ephemeral(默认 7d)/timeline(30d 归档)；durable 事实走 fact_upsert |

**幂等**：自动指纹（key, value, mem_class, ttl_days）。
**事务边界**：blackboard 单行 UPSERT；提交后发 fact.bb.published（[env-issue] 键触发 know 域 AGENTS.md 即时刷新，弱联动）。
**agent_note（RoE）**：发布黑板环境层条目（跨会话共享）：环境故障用 [env-issue] 前缀（即时注入 worker 开局上下文）、时间轴流水用 [timeline] + 日期键（只追加）、全局广播用裸键。默认 ephemeral 7 天到期自动归档。目标状态快照与工作记录**不要**写黑板——用 fact_upsert（note 类，14 天）。

#### C7 · fact_transition

**语义**：生命周期治理通道（memcore/sweep/迁移专用）。**只允许降级方向**：`active→cooling`（durable 复验逾期）、`active→archived`（ephemeral 过期 / timeline 超龄 / 数据修复）、`cooling→archived`（超 30 天）。复活/复验一律走 C5，本动词不做。

> 宪法 §四.1 要求"调用方永远不传 status/to 参数"；本动词带 `to` 参数是宪法**治理通道豁免**的实例（三条件边界：调度判定型 / 仅 system+human / 不向模型注册），理由：治理流转的判定来源是外部调度（sweep 周期判定）而非调用方意图，无法枚举为独立语义动词而不爆炸；且 actor 白名单不含 model、工具面不注册，"自由态写入口"风险物理不存在。

**参数表**：

| 参数 | 类型 | 必填 | 校验 |
|---|---|---|---|
| object | string | 是 | ∈ {fact, bb} |
| program_id + fact_key | string | object=fact 时必填 | — |
| bb_key | string | object=bb 时必填 | — |
| to | string | 是 | ∈ {cooling, archived} |
| reason | string | 是 | ≥10 字 |

**返回 data**：`{ object, id, from, to }`。
**错误码**：E_NOT_FOUND；E_STATE（非法流转：如 cooling→cooling、bb→cooling、终态再流转）；E_ACTOR_FORBIDDEN（model/dashboard 调用即拒——越权尝试本身进审计）。
**幂等**：自动指纹（object, id, to, reason）。
**事务边界**：to=archived 时单事务完成"复制进 `*_archive`（+archived_at/archive_reason）+ 主表删除"；to=cooling 为状态列 UPDATE。全程留统一 audit（宪法 §九，替代 v4 memcore_events 的域内私账——memcore_events 表转只读历史，见 3.3）。
**事件映射**：to=cooling → `fact.cooled`；to=archived 且 mem_class ∈ {ephemeral, timeline}（自然到期类）→ `fact.expired`；to=archived 其余 → `fact.archived`。
**agent_note（RoE）**：（治理通道，模型不注册）memcore sweep / 迁移脚本的生命周期降级流转：复验逾期→cooling、过期/超龄/cooling 超 30 天→archived。复活走 fact_record_validation。

#### C8 · fact_record_signal

**语义**：使用信号——`uses+1`、`last_used_at=now`。v4 中 facts 无信号通道；v5 为"搜索副作用显式化"（宪法 §七.1）补设：fact_search/neg_check 投影层在返回后补发本命令（audit 可见、失败不影响查询结果），模型也可显式回执。

**参数表**：program_id、fact_key（必填）；signal（string，必填，当前仅 `used`）；source（string，可选：触发查询串或 run_id，进指纹参与去重）。

**返回 data**：`{ program_id, fact_key, uses }`。
**错误码**：E_NOT_FOUND；E_SCHEMA。
**幂等**：自动指纹（program_id, fact_key, signal, source）——同一查询的重复补发不重复计数。
**事务边界**：计数列 UPDATE 单事务；无事件（manifest events: []）。
**agent_note（RoE）**：回执"这条事实被实际用上了"（uses+1）。检索命中且采纳进决策时建议回执；该计数驱动 know_health 的零使用体检与后续清理判据。

#### C9 · fact_reindex

**语义**：图谱自动建边（v4 P2-1）：扫描 program 全部 facts 的 fact_key+summary+body，按共享域名根 / C 段建 star 型关系边（组内 2~50 条才建，超大组跳过防噪声），幂等（边表 REPLACE）。

**参数表**：program_id（string，必填）。
**返回 data**：`{ program_id, facts, groups, edges }`。
**错误码**：E_SCHEMA（缺 program_id）；E_CAPABILITY_UNSUPPORTED（http-remote 后端，见 2.4）。
**幂等**：自然键 `fact:reindex:{program_id}`；重跑重建（结果幂等）。
**事务边界**：逐边 REPLACE（单事务批量，≤500 边/事务，超量分批）；无事件（audit 记行数）。
**agent_note（RoE）**：事实图谱自动建边：扫描项目全部事实，按共享域名根 / C 段建 same-domain/same-subnet 关系边，让孤立事实成图（支撑攻击面聚类与 fact_graph 遍历）。周期任务或新增一批事实后调用。

### 1.4 查询（读投影）逐个详述

> 全部纯读（宪法 §七.1）；列表查询统一分页信封 `{ rows, total, limit, offset }`；**rows 与 total 由同一个 where 构造器生成**（`factVisibleWhere()`，v4.3 countFacts/factSearch 口径病的契约化根除，契约测试必有"行数=total"断言）。

#### Q1 · fact_search（核心检索）

**参数**：

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| program_id | string | 否 | `''`（全部） | program 归属谓词 |
| category | string | 否 | `''` | — |
| q | string | 否 | `''` | LIKE 三字段（summary/fact_key/body） |
| confidence | string | 否 | `''` | — |
| has_edges | bool | 否 | false | 仅看有图谱边的事实 |
| mem_class / status | string | 否 | `''` | 生命周期维度筛选（review 视图用） |
| exclude_notes | bool | 否 | **true** | **默认隐藏 note 类速记**（流水账治理；neg_check 显式查 note 不受影响） |
| sort | string | 否 | `updated_at` | 白名单：updated_at / edge_count / category（置顶 pinned 恒在最前） |
| limit / offset | int | 否 | 50 / 0 | limit 上限 500 |
| reader | string | 否 | `task` | `task`=执行角色；`review`=复盘角色全量可见（含 timeline/archived） |

**可见域谓词（reader=task，构造器默认值）**：排除 `status='archived'`、排除 `mem_class='timeline'`、排除已过期 ephemeral（`expires_at < now`）、exclude_notes 默认 true；cooling 行**打标可见**（`_cooling: true`，不隐藏——用到即复验）。

**投影层补偿动作**（不进查询事务，失败不影响结果）：① 返回行补发 `fact_record_signal(used)`；② 发现"已过期未归档"行补发 `fact_transition(to=archived, actor=system, reason='lazy: ephemeral 过期')`——v4 惰性即时归档的 v5 化（查询仍纯读，物理归档经命令，失败由 sweep 兜底）。

**返回**：`{ rows: [...不含 body 的索引行 + edge_count + _cooling], total, limit, offset }`。

#### Q2 · fact_get

参数：program_id、fact_key、reader（默认 task）。返回单条全文（含 body、生命周期列）。reader=task 时 archived/timeline → E_NOT_FOUND（hint：reader=review 可查全量）。

#### Q3 · fact_graph

参数：program_id、fact_key。返回 `{ node, out: [{dst_key, edge_type, confidence}], in: [{src_key, edge_type, confidence}] }`（单跳；多跳由调用方遍历）。

#### Q4 · fact_overview（聚合，知识 tab）

无参数。返回 `{ by_category: {cat: {total, durable, ephemeral}}, total, blackboard: {active, env_issues}, fgs_persisted }`（fgs_persisted = fact_key LIKE 'fgs/%' 计数——FGS 沉淀出口的健康度）。口径：status='active' 的 facts。

#### Q5 · fact_stats（聚合，facet 洞察条）

无参数（全局）。返回 `{ total, by_category[], by_confidence[], by_mem_class[], by_status[], pinned, edges, with_edges }`。

#### Q6 · neg_check（负知识账本，派单前拦截）

参数：program_id（必填）、q（目标/路径关键词）、limit（默认 20）。实现 = fact_search 的受控预设：category='note'、exclude_notes=false、reader=task（note 为 ephemeral 14d，过期前可见）。返回 `{ failed_paths: [...], total, warning }`；warning 文案：命中时"以下路径已证伪，避免重复尝试"，无命中"无已知证伪路径"。**使用纪律**：编排器/模型在派单尝试一条路径前调用；命中即放弃该路径。

#### Q7 · fact_bb_read

参数：key（可选——带 key 读单条，缺省列最近 100 条）、reader（默认 task，过滤 timeline/过期/归档）。返回黑板行或行数组。

### 1.5 事件

| 事件名 | 触发命令 | payload schema |
|---|---|---|
| `fact.upserted` | C1/C2 | `{ program_id, fact_key, mem_class, confidence, merged, from_confidence?, cause?: {cmd, actor} }` |
| `fact.deprecated` | C3 | `{ program_id, fact_key, from_confidence, reason 摘要 }` |
| `fact.validated` | C5 | `{ program_id, fact_key, revalidate_by \| expires_at, healed: bool }` |
| `fact.expired` | C7（to=archived 且自然到期类） | `{ object_kind: 'fact'\|'bb', program_id?, fact_key?/bb_key?, mem_class }` |
| `fact.cooled` | C7（to=cooling） | `{ object_kind, id, from: 'active', reason }` |
| `fact.archived` | C7（to=archived 其余） | `{ object_kind, id, from, reason }` |
| `fact.linked` | C4 | `{ program_id, src_key, dst_key, edge_type, confidence }` |
| `fact.bb.published` | C6 | `{ key, mem_class, expires_at, channel: 'env-issue'\|'timeline'\|'broadcast' }` |

payload 只含 ID 与判据快照，不含行全量（宪法 §八.1）；事件按域追加 `data/events/fact.jsonl`，支持 `sec bus replay`。

**订阅**（manifest subscribes）：

| 订阅事件 | 模式 | 处理器 | 动作 |
|---|---|---|---|
| `task.finished` | weak（async） | `onTaskFinished` | FGS 沉淀**补漏对账**：对刚结束任务重放 fgs 沉淀判定（幂等，见 2.3 时序） |
| `fgs.node.done` | weak | `onFgsNodeDone` | FGS fact 节点沉淀**主通道**：调 C1 fact_upsert（`fgs/{task_id}/{node_id}`，durable 30d，confidence=confirmed，source='fgs-persist'） |
| `exec.run.failed` | weak | `onExecRunFailed` | 负知识自动证伪：调 C1 fact_upsert（`note/fail-{tool}-{host}`，category=note，confidence=tentative，source='auto:runcli-fail'，body 带 run_id/tool/target/原因/耗时） |
| `approval.approved` | weak | `onApprovalApproved` | kind=exclude-exception 时调 C1 fact_upsert（`scope/exception-{host}`，category=scope，durable，confidence=confirmed，source='approval'）——例外决策的长期留档 |

### 1.6 模型工具面投影（工具名 + 描述全文）

挂载：web + headless 两 profile × actor=model。工具名与命令/查询名**完全一致**（投影零改名）。`fact_correct`（dashboard/human）、`fact_transition`（system/human）**不向模型注册**——模型根本没有这两个入口（负向保障第一层）。

| 工具名 | 描述全文（即 manifest agent_note） |
|---|---|
| fact_upsert | 见 C1 agent_note 全文 |
| fact_deprecate | 见 C3 |
| fact_link | 见 C4 |
| fact_record_validation | 见 C5 |
| fact_bb_publish | 见 C6 |
| fact_record_signal | 见 C8 |
| fact_reindex | 见 C9 |
| fact_search | 检索事实（按 program/category/关键词，summary+key+body LIKE）。返回索引行（不含 body）。memcore 治理下默认不返回 note 速记（neg_check 专门查）、timeline、已归档、已过期项；cooling 项带标记（用到即复验）。任务开局三步检索第一步：先查当前目标状态再动手。 |
| fact_get | 读单条事实全文（含 body）。摘要不够时按需拉取，禁止臆造。 |
| fact_graph | 返回某条事实的关系子图（节点 + 出边 + 入边）。资产关系/攻击链可遍历。 |
| fact_stats | 事实图谱 facet 总览：分类/置信/生命周期分布 + 置顶 + 边规模。 |
| neg_check | 负知识账本：查 note/* 已证伪路径（验证失败/前提不满足）。派单/尝试前必查，命中即放弃，免踩同一坑。 |
| fact_bb_read | 读黑板环境层。带 key 读单条，不带列最近 100 条。默认不返回 timeline/已归档/已过期项；reader=review 全量。环境故障查 [env-issue]。 |

（描述全文以 1.3/1.4 各动词 agent_note 为准，上表为登记清单——投影层机械搬运，无第二份文案。）

### 1.7 看板 RPC 投影

RPC 名 `{domain}.{verb}` 点分；同一 handler 双投影（物理消灭两套校验）。operator 身份随连接注入审计。

| RPC 名 | v4 来源 case | 投影到 |
|---|---|---|
| `fact.search` | facts | Q1（分页/筛选参数同构；看板显式传 exclude_notes） |
| `fact.stats` | factStats | Q5 |
| `fact.graph` | factGraph | Q3 |
| `fact.overview` | factOverview | Q4（知识 tab 事实区） |
| `fact.correct` | factCorrect | C2 |
| `fact.deprecate` | factDeprecate | C3 |
| `fact.reindex` | （新增） | C9 |
| `fact.bb.read` | blackboard | Q7 |

### 1.8 外部调用示例

**模型调用**（worker 任务内工具调用）：

```json
{ "tool": "fact_upsert", "args": {
    "program_id": "meituan-src",
    "fact_key": "auth/cred-admin-found",
    "category": "auth",
    "summary": "admin 后台弱口令可登录（api.example.com/admin）",
    "body": "run_id=run_x9f2 经 burp 验证 admin/admin123 可登录管理后台，会话 cookie 有效 2h……",
    "confidence": "confirmed",
    "source": "agent"
} }
```

**代码调用**（其他域/总线脚本 dispatch）：

```js
const bus = ctx.inject('secDomainBus')
const r = await bus.dispatch('fact', 'bb_publish', {
  key: '[env-issue] egress-blocked',
  value: 'egress 出口被 WAF 拦截 httpx（2026-09-06 起），探测任务先降速',
  mem_class: 'ephemeral', ttl_days: 3,
}, { actor: 'script', run_id })
// r = { ok: true, data: { key, mem_class: 'ephemeral', expires_at } }
```

**脚本调用**（治理脚本经 exec 域 run_cli → 总线 CLI；人工应急同通道加 --actor human）：

```bash
sec dispatch fact fact_upsert --actor script --args-file /tmp/fact.json
sec dispatch fact neg_check --actor script --args '{"program_id":"meituan-src","q":"upload"}'
sec dispatch fact fact_correct --actor human --args '{"program_id":"p","fact_key":"k","evidence":"人工复核确认"}'
```

---

## 二、内部实现（Internal）

### 2.1 数据模型

库：`asset-graph.db`（node:sqlite，WAL，busy_timeout 5s；表名不改——宪法 §六 取舍）。**本域 owns 下列全部行变更**。

#### facts 表（v4 DDL + memcore 生命周期列 + v5 新增 2 列）

| 列 | 类型 | 语义 | 写入者 |
|---|---|---|---|
| program_id | TEXT NOT NULL | 项目归属（PK 1/2）；`__legacy__`=v4.6 黑板快照迁移行 | C1/C2 |
| fact_key | TEXT NOT NULL | `category/slug`（PK 2/2） | C1/C2 |
| category | TEXT | 分类（note=负知识速记、fgs=FGS 沉淀、scope=授权留档……） | C1/C2 |
| summary | TEXT | ≤300 字符一行索引，注入 prompt | C1/C2 |
| body | TEXT | ≤4000 字符全文 | C1/C2 |
| confidence | TEXT DEFAULT 'tentative' | confirmed/tentative/deprecated | C1/C2/C3 |
| pinned | INTEGER DEFAULT 0 | 置顶（检索恒最前） | C1/C2 |
| related_finding_id | INTEGER | 弱引用 findings.id（跨域只读） | C1/C2 |
| source | TEXT | 溯源（fgs-persist / approval / auto:runcli-fail / agent…） | C1 |
| updated_at | INTEGER | UTC epoch ms | 全部写命令 |
| mem_class | TEXT | durable/ephemeral/timeline（INV-F1） | C1 |
| status | TEXT DEFAULT 'active' | active/cooling（archived 行已物理移入 archive 表） | C5/C7 |
| status_at | INTEGER | 状态迁移时刻 | C5/C7 |
| scope | TEXT | 默认 `program:{program_id}` | C1 |
| expires_at | INTEGER | ephemeral 到期时刻 | C1/C5 |
| revalidate_by | INTEGER | durable 复验到期时刻 | C1/C5 |
| justification | TEXT | 分类理由（缺省 auto:default） | C1 |
| last_validated_at | INTEGER | 最近复验时刻 | C1/C5 |
| **uses** | INTEGER DEFAULT 0 | **v5 新增**（ensureCol）：C8 计数 | C8 |
| **last_used_at** | INTEGER | **v5 新增**：最近使用 | C8 |

索引：PRIMARY KEY(program_id, fact_key)、`idx_facts_program(program_id)`（沿用）；v5 新增 `idx_facts_lifecycle(mem_class, status, revalidate_by)` 与 `idx_facts_expiry(mem_class, expires_at)`（sweep 扫描走索引）。

#### fact_edges 表

| 列 | 类型 | 语义 |
|---|---|---|
| program_id | TEXT NOT NULL | PK 1/4 |
| src_key / dst_key | TEXT NOT NULL | PK 2/4、3/4，须为同 program 存在的 fact_key（INV-F10） |
| edge_type | TEXT NOT NULL | PK 4/4；语义七型 + 派生二型（same-domain/same-subnet，仅 C9 写） |
| confidence | TEXT | 边置信（默认 tentative） |

索引：`idx_edges_src(program_id, src_key)`、`idx_edges_dst(program_id, dst_key)`（沿用）。

#### blackboard 表（v4.6 后纯环境层）

| 列 | 类型 | 语义 |
|---|---|---|
| key | TEXT PRIMARY KEY | `[env-issue]…` / `[timeline]…日期` / 裸键（全局广播）；快照前缀拒绝（INV-F7） |
| value | TEXT | ≤4000 字符 |
| updated_at | INTEGER | — |
| mem_class | TEXT | ephemeral（默认 7d）/ timeline（30d 归档）；**无 durable** |
| status | TEXT DEFAULT 'active' | active / archived |
| status_at / scope / expires_at / justification | — | 同 facts 语义（无 revalidate_by） |

#### 归档表与治理

- `facts_archive` / `blackboard_archive`：同构 + `archived_at`、`archive_reason`；C7 to=archived 单事务写入；**90 天硬删**（memcore sweep 经 C7 执行，见 2.3）。
- v4 的 `memcore_events` 表：转**只读历史**（v5 起统一 audit 为唯一落点）；不迁移不删除。

### 2.2 状态机与不变量

#### mem_class 体系（v4 完整继承，网关化）

| mem_class | 语义 | facts 允许 | blackboard 允许 | 缺省参数 | 生命周期 |
|---|---|---|---|---|---|
| permanent | 可迁移方法论 | **禁止**（R2 投影：枚举即不含） | 禁止 | — | （归 know 域） |
| durable | 目标事实，需复验 | 是（默认） | 否 | 复验 30d（区间 7~90d） | active →(逾期)→ cooling →(30d)→ archived；复验刷新 |
| ephemeral | 速记/负知识/环境条目 | 是（note 默认） | 是（默认） | facts note=14d、bb=7d；TTL 区间 1h~30d | active →(到期)→ archived |
| timeline | 只追加流水 | 是 | 是 | 30d 归档 | 只追加（R7）；超龄 archived |

#### 生命周期状态机（facts / blackboard 共用骨架）

```
                fact_upsert / fact_bb_publish
                        │ (entry: active)
                        ▼
 ┌───────── active ──────────┐
 │  durable 复验逾期          │──fact_transition──▶ cooling ──(30d, fact_transition)──▶ archived
 │  ephemeral 到期            │──fact_transition───────────────────────────▶ archived (fact.expired)
 │  timeline 超龄 30d         │──fact_transition───────────────────────────▶ archived (fact.expired)
 │  证伪                      │──fact_deprecate（confidence 维度，不改 status）
 └───────────────────────────┘
   cooling ──fact_record_validation（复验通过）──▶ active（自愈，fact.validated）
   archived = 终态（恢复走数据修复脚本，3.3）；archive 表 90 天硬删
```

- **惰性过期**：v4 在读取路径即时归档；v5 查询纯读 → 改为"谓词即时不可见 + 投影层补发 fact_transition 物理归档 + sweep 兜底"（语义等价：读者视角过期即消失）。
- **note 类 14d**：`category='note'` 缺省 ephemeral 14d——负知识要可见（neg_check 依赖其可见性），过期自然消亡。

#### confidence 状态机（facts 私有维度）

```
tentative ──fact_correct / fact_upsert(confidence=confirmed)──▶ confirmed
tentative/confirmed ──fact_deprecate──▶ deprecated（终态；复活=重新立论 fact_upsert）
```

#### 网关前置不变量清单（manifest invariants；域实现不重复校验）

| ID | 来源 | 内容 | 失败错误码 |
|---|---|---|---|
| INV-F1 | R1 | mem_class ∈ 枚举（facts: durable/ephemeral/timeline；bb: ephemeral/timeline） | E_INVARIANT |
| INV-F2 | R2 | facts/bb 禁 permanent（方法论走 know 域） | E_INVARIANT |
| INV-F3 | R3 | ephemeral TTL ∈ [1/24 天, 30 天] | E_INVARIANT |
| INV-F4 | R4 | durable 复验期 ∈ [7, 90] 天 | E_INVARIANT |
| INV-F5 | R6（工作/情景层细化） | justification 可缺省（记 auto:default）；显式传入时禁占位符（单字符重复） | E_INVARIANT |
| INV-F6 | R7 | timeline 只追加：改写既有 timeline 键拒绝 | E_STATE |
| INV-F7 | v4.6 sweep 守卫前置化 | bb key 不匹配快照前缀 `^(alive\|scan\|recon\|review\|note\|todo\|plan)[:_]` | E_INVARIANT |
| INV-F8 | R8 | **明确不适用**：facts 本就是目标事实，允许含目标标识符（R8 闸在 know 域 exp 卡生效） | — |
| INV-F9 | R9 防膨胀 | summary ≤300、body/value ≤4000 字符 | E_INVARIANT |
| INV-F10 | v5 新增 | fact_link 两端键存在于同 program；禁自环 | E_NOT_FOUND / E_SCHEMA |

### 2.3 事务与联动

#### 单命令事务内容

| 命令 | 事务内行变更 | 事务后（最终一致） |
|---|---|---|
| C1/C2 | facts UPSERT（生命周期列由不变量推导结果填充） | fact.upserted 事件 |
| C3 | facts.confidence UPDATE | fact.deprecated |
| C4 | fact_edges REPLACE | fact.linked |
| C5 | facts 时效列 UPDATE + cooling 自愈 | fact.validated |
| C6 | blackboard UPSERT | fact.bb.published（[env-issue] → know 域即时刷 AGENTS.md） |
| C7 | 状态 UPDATE 或 archive 复制+删除 | fact.cooled / fact.expired / fact.archived |
| C8 | uses/last_used_at UPDATE | —（仅 audit） |
| C9 | fact_edges 批量 REPLACE（≤500/事务分批） | —（仅 audit） |

#### FGS 沉淀时序（原 persistFgsFacts 直写归零）

```
scheduler ──task 派生──▶ worker（fgs_add/fgs_update 实时写 fgs_nodes，fgs 域）
   │ fgs 域：fact 节点 done 且 content 含证据（summary+detail 非空）
   ▼
EventBus ──fgs.node.done {task_id, node_id, summary, detail}──▶ fact 域（weak 订阅）
   │ onFgsNodeDone: fact_upsert(program_id, 'fgs/{task_id}/{node_id}',
   │   category='fgs', summary≤200, body≤2000, confidence='confirmed',
   │   source='fgs-persist', durable 30d)     ← 主通道：节点完成即沉淀
   ▼
worker 结束 ──task.finished──▶ fact 域 onTaskFinished：补漏对账
   （重放该任务 fgs.node.done 判定——订阅方曾失败的事件在此补齐；
     fact_upsert 幂等（replay/覆盖）保证对账零副作用）
```

best-effort 语义保留：任一环节失败不阻断任务收尾（弱联动，audit 记 subscriber_failed，事件可 `sec bus replay` 重放）。

#### memcore 关系重设计（69 处裸 SQL 归零）

v4 中 memcore 直写 facts/blackboard 的全部 SQL（validateWrite 分支、transition 的 selectRow/deleteRow/updateStatus、sweep 的 facts/blackboard 循环、guardBlackboardSnapshots、migrateStock/migrateBlackboardSnapshots，合计 memcore.js 内 69 处 prepare/exec 写调用的一部分，其余属 know 域见 07-know.md §2.3）在 v5 **全部归零**。memcore 变为纯订阅者：订阅 `fact.*` 事件 + 调域命令。

**memcore 治理动作 → fact 域命令完整映射表**：

| # | v4 memcore 动作（对 facts/blackboard） | v5 通道 |
|---|---|---|
| 1 | `validateWrite('facts'\|'blackboard')`（R1-R7 入口校验） | fact 域网关不变量 INV-F1~F7（前置，事务前执行） |
| 2 | `visibilityFilter(role, 'facts'\|'blackboard')`（读过滤 + 惰性归档） | Q1/Q7 可见域谓词构造器 + 投影层补发 fact_transition（2.3） |
| 3 | sweep：durable 逾期 → cooling | 订阅 `fact.validated`/周期扫描（经 Q5 stats）→ C7 fact_transition(to=cooling, actor=system) |
| 4 | sweep：cooling 超 30d → archived | C7 fact_transition(to=archived) |
| 5 | sweep：ephemeral 过期 → archived | C7 fact_transition(to=archived, reason=lazy/sweep 过期) → fact.expired |
| 6 | sweep：timeline 超龄 30d → archived | C7 fact_transition(to=archived) |
| 7 | sweep：archive 表 90d 硬删 | C7 fact_transition 语义内含硬删（archive 行 purge 由 memcore 周期脚本经系统通道执行，唯一保留的"裸写"是 DELETE，落为 repository 原语 `purgeArchives(before)`，网关命令 `fact_purge_archive`（system actor，Phase 2 补入 manifest，本表占位） |
| 8 | `recordSignal`（facts 无评分，实际仅 exp/kb 用） | C8 fact_record_signal（uses 计数，v5 新增） |
| 9 | `guardBlackboardSnapshots`（快照键事后转写 facts + 归档原键） | **删除**——INV-F7 前置拒绝（事后转写守卫归零） |
| 10 | `migrateStock`（存量 mem_class 回填） | 数据迁移脚本（18-migration.md，actor=system 启动窗口） |
| 11 | `migrateBlackboardSnapshots`（26+15 条 bb/ 前缀迁移） | 已在 v4.6 完成；v5 仅保留幂等校验（迁移脚本断言 `bb/%` 行存在即可） |
| 12 | `rewriteAgentsMd` 读 blackboard [env-issue] | know 域订阅 `fact.bb.published`（跨域读改事件驱动，见 07-know.md §2.3） |
| 13 | `knowledgeHealth` 的 facts/blackboard/fgs 计数 | know_health 查询经本域 Q4/Q5 投影（跨域只读） |
| 14 | `transition` 的 memcore_events 私账 | 统一 audit（宪法 §九）+ fact.cooled/expired/archived 事件 |
| 15 | `refreshAgentsMd`（[env-issue] 写入后即时刷新） | C6 事件 fact.bb.published → know 域订阅刷新（本域不再关心 AGENTS.md） |

memcore 旁路语义保持 fail-open（宪法 §十四.6）：memcore 缺席/订阅失败不影响 fact 域命令主链路（fail-closed）。

### 2.4 后端适配器

**repository 接口**（`backend/repository.js`，JSDoc；方法名=原语，无 SQL 语义、无业务校验）：

```js
/** @returns {FactRow|null} */
getFact(program_id, fact_key)
/** UPSERT 单行（生命周期列已由网关算好） */
upsertFact(row)
/** 状态列更新；@returns {number} 受影响行数 */
setFactStatus(program_id, fact_key, status, status_at)
/** 归档：复制进 facts_archive + 删主行，单事务 */
archiveFact(program_id, fact_key, reason, archived_at)
/** 归档表 90d 硬删；@returns {number} */
purgeFactArchives(before_ts)
replaceEdge(program_id, src_key, dst_key, edge_type, confidence)
listFactsWhere(whereSql, args, limit, offset)   // 可见域谓词由查询层构造
countFactsWhere(whereSql, args)
factAggregates()                                  // Q4/Q5 所需分组计数
getBb(key) / upsertBb(row) / listBbRecent(limit) / setBbStatus(key, status, at) / archiveBb(key, reason, at) / purgeBbArchives(before_ts)
```

**能力矩阵**：

| 命令/查询 | sqlite-local | http-remote（Phase 4+） | file |
|---|---|---|---|
| C1-C6、C8 | full | full（重试+超时+降级策略见 01-bus） | unsupported（E_CAPABILITY_UNSUPPORTED） |
| C7 fact_transition | full | partial：archive 复制+删除需远端事务语义，不支持时返回 partial 说明 | unsupported |
| C9 fact_reindex | full | unsupported（需全表扫描，只能本地跑） | unsupported |
| Q1-Q7 | full | partial：Q3 fact_graph 仅单跳（多跳遍历远端不做）；Q4/Q5 聚合由远端实现 | unsupported |

混布：fact 域无 file 形态，不混布。切换：`sec_domain_fact_backend` 配置一行；sqlite↔sqlite 热切，切 http 重启宿主面。

### 2.5 缓存与失效

| 缓存 | 位置 | 失效策略 |
|---|---|---|
| 幂等表 | 总线（LRU 7 天/万条） | 自动 |
| fact 检索 | **无应用层缓存**（LIKE 直查；1e4 行内 <10ms，见 2.6） | — |
| Q4/Q5 聚合 | 看板客户端 30s 节流（不进域） | — |
| 投影层补偿命令（Q1 的 signal/transition 补发） | 进程内待发队列 | 失败仅 audit 记录，不重试——sweep 兜底（过期行物理归档最迟延迟一个 sweep 周期 6h，可见性不受影响） |
| FTS/向量索引 | **本域无**（facts 用 LIKE；FTS/向量在 know 域） | — |

### 2.6 性能与容量

| 项 | 现状（2026-09-06） | 预期与上限 |
|---|---|---|
| facts 行数 | 1,143 | FGS 沉淀主通道接通后（v4 产出为 0，事件化后预计 +5~20/日）+ note 负知识自动证伪；durable 复验 30d 淘汰，稳态预估 3~5 千行 |
| fact_edges | 数百（以 fact_stats 实查为准） | C9 star 建边受"组 2~50"约束，边数 = O(facts)；idx_edges_src/dst 覆盖遍历 |
| blackboard active | ≤100（Q7 只列最近 100） | ephemeral 7d/timeline 30d 自然消亡 |
| archive 表 | 与主表同量级 | 90 天硬删封顶 |
| 检索延迟 | LIKE 三字段全表扫，1,143 行 <5ms | 1e4 行 <20ms；超过后引入 FTS5（列演进，不动表名） |
| 写并发 | WAL + busy_timeout 5s + 网关进程内单入口 | E_CONFLICT 重试语义（宪法保留码） |

---

## 三、迁移与兼容

### 3.1 现状代码映射（行级）

| v4 位置 | 内容 | v5 去向 |
|---|---|---|
| asset-db.js L140-172 | facts/fact_edges/blackboard DDL + 索引 | 域内 schema（沿用，+2 列 +2 索引，见 2.1） |
| asset-db.js L1249-1252 | `_bindLifecycle`/LC memcore 绑定 | **删除**（治理走网关不变量与事件） |
| asset-db.js L1254-1292 | factUpsert（含 memcore validateWrite 分支） | C1 commands/fact_upsert.js（validateWrite 分支删除，网关 INV-F1~F5 承接；无 memcore 的旧列分支删除） |
| asset-db.js L1294-1297 | factGet | Q2 |
| asset-db.js L1299-1313 | factSearch（role 过滤、FACT_SORT、edge_count 子查询） | Q1（排序白名单/edge_count 保留） |
| asset-db.js L1315-1344 | visibleFactsWhere + countFacts（口径对齐） | Q1 的 `factVisibleWhere()` 单一构造器（rows/total 同源，契约测试"行数=total"） |
| asset-db.js L1346-1361 | factWhere | Q1 筛选构造器（+program 谓词默认值声明） |
| asset-db.js L1366-1378 | factStats | Q5 |
| asset-db.js L1380-1387 | factLink | C4（+INV-F10 两端存在校验，v5 新增） |
| asset-db.js L1389-1395 | factGraph | Q3 |
| asset-db.js L1399-1427 | factReindexEdges（域名根/C 段 star 建边） | C9 |
| asset-db.js L1470-1499 | bbSet（timeline 改写拒绝 + [env-issue] 即时刷 AGENTS.md） | C6（R7 拒绝保留为 INV-F6；AGENTS.md 刷新改事件 fact.bb.published → know 域） |
| asset-db.js L1501-1515 | bbGet | Q7 |
| asset-graph.js L233-266 | 工具注册 blackboard_set/blackboard_get | C6/Q7 投影 + 别名（3.2） |
| asset-graph.js L459-575 | 工具注册 fact_upsert/fact_get/fact_search/fact_link/fact_graph/fact_reindex/neg_check | 1.6 工具面（描述更新为 v5 语义） |
| dashboard-rpc.js L275-317 | factStats/facts/factGraph case | RPC fact.stats/fact.search/fact.graph |
| dashboard-rpc.js L385-417 | factCorrect/factDeprecate case（读原行+UPSERT） | C2/C3 命令（逻辑进 commands/，RPC 只投影） |
| dashboard-rpc.js L498-512 | factOverview case | Q4（+fgs_persisted） |
| scheduler.js L100-129 | persistFgsFacts（直写） | **删除**——fgs.node.done/task.finished 订阅（2.3 时序） |
| sec-suite.js L1372-1388 | runCli 失败自动写 note 证伪（直调 factUpsert） | **删除**——exec.run.failed 事件订阅 onExecRunFailed |
| sec-suite.js L679-688 | approval exclude-exception 直写 scope/exception-{host} | **删除**——approval.approved 订阅 onApprovalApproved |
| memcore.js L35-67 | POLICIES.facts/blackboard | 域不变量 INV-F1~F7 + mem_class 体系表（2.2） |
| memcore.js L262-323 | validateWrite | 网关不变量（映射表 #1） |
| memcore.js L325-349 | visibilityFilter（惰性归档） | Q1 谓词 + 投影层补发（映射表 #2） |
| memcore.js L351-402 | transition/selectRow/deleteRow/updateStatus | C7 + repository 原语 |
| memcore.js L683-756 | sweep 的 facts/blackboard 分支 | memcore 订阅者调 C7（映射表 #3-#7） |
| memcore.js L176-224 | migrateBlackboardSnapshots/guardBlackboardSnapshots | 迁移脚本 + **INV-F7 前置拒绝**（守卫归零，映射表 #9/#11） |
| memcore.js L758-795 | rewriteAgentsMd 的 [env-issue] 读取 | know 域订阅 fact.bb.published（映射表 #12/#15） |

### 3.2 兼容别名与观察期

总线别名表（别名同样过网关全管线，不绕校验）；观察期一个调度周期（7 天，audit 零使用为验收），删除走宪法 §十五 三段式：

| v4 工具名 | v5 动词/查询 | 备注 |
|---|---|---|
| `blackboard_set` | `fact_bb_publish` | 文案引导新名 |
| `blackboard_get` | `fact_bb_read` | 同上 |
| `fact_upsert` / `fact_search` / `fact_get` / `fact_link` / `fact_graph` / `fact_reindex` / `neg_check` | 同名 | 零改名直通 |
| RPC `factCorrect`/`factDeprecate`/`factStats`/`facts`/`factGraph`/`blackboard`/`factOverview` | `fact.correct`/`fact.deprecate`/`fact.stats`/`fact.search`/`fact.graph`/`fact.bb.read`/`fact.overview` | 看板客户端同步改写 |

prompt 引用同步：persona/objective/skills/technique-index 中 `blackboard_set/blackboard_get` 引用由脚本化改写（复用 p14-1-tool-refs.py 模式），改写后 discipline-audit.py 增"悬空工具引用"断言（宪法 §十五.4）。

### 3.3 数据迁移脚本要点

1. **不改名不迁库**：facts/fact_edges/blackboard 原表原地接管；`ensureCol('facts','uses',…)`、`ensureCol('facts','last_used_at',…)` 幂等补列；补建 2.4 索引。
2. mem_class 回填：v4.7 已完成存量迁移（memcore_meta 旗标），v5 仅校验旗标存在 + `bb/%` 前缀行在位，**不重跑**。
3. archived 行状态校验：`status='archived'` 的主表行应为 0（v4 归档即删主表）；非 0 则迁移脚本搬入 archive 表（幂等）。
4. 事件日志 `data/events/fact.jsonl` 从迁移时刻起算，不回放历史；memcore_events 转只读历史保留。
5. 回滚：v5 域插件停用即回 v4 直调路径（表结构向后兼容——新增列有默认值），单域灰度可回退。

---

## 四、开放问题

1. **投影层补发归档的失败窗口**：过期行物理归档最迟延迟 6h（sweep 兜底）；若审计要求"过期即物理消失"，需评估 sweep 间隔下调或接受窗口。
2. **跨域事件 schema 对齐**：`exec.run.failed`、`approval.approved`、`task.finished`、`fgs.node.done` 的 payload schema 分别锚定 10-exec/09-approval/05-task/14-fgs 文档，本文按判据快照假定了字段（run_id/tool/target/cause 等），四份文档定稿时需交叉核对。
3. **fact_purge_archive**（映射表 #7 的 90 天硬删命令）本文以占位形式声明 system actor + repository 原语，正式动词表待 18-migration Phase 2 补入。
4. **派生边型**（same-domain/same-subnet）不在七种语义边型内，仅 C9 可写——是否在 schema 层把 edge_type 拆成 `semantic|derived` 两字段，待图规模上来后复评。
5. **timeline 黑板键形态**：`[timeline]` bracket 键与带日期快照键（已被 INV-F7 拒绝）历史并存；是否对 `[timeline]` 键也强制日期后缀，待存量盘点。
