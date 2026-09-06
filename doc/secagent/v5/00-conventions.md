# 00 · 全局统一契约约定（v5 宪法）

> 版本：v5.0 ｜ 状态：**设计定稿基准**（本文是所有领域模块文档与代码实现的最高约定；模块文档与本文冲突时，**以本文为准**；本文修订需同步评审所有受影响模块文档）
> 适用对象：全部 14 个领域模块 + 总线 + 看板 + LLM 工具面 + 脚本 + 人工操作路径。**没有任何调用方可以豁免本约定。**

---

## 目录

1. [文档结构约定（模块文档强制骨架）](#一文档结构约定)
2. [标识符与命名规范](#二标识符与命名规范)
3. [调用方模型（actor）](#三调用方模型actor)
4. [命令规范（写动词八条铁律）](#四命令规范)
5. [统一返回信封与错误码](#五统一返回信封与错误码)
6. [幂等规范](#六幂等规范)
7. [查询规范（读投影）](#七查询规范)
8. [事件规范](#八事件规范)
9. [审计规范](#九审计规范)
10. [时间与时区规范](#十时间与时区规范)
11. [可见域谓词规范](#十一可见域谓词规范)
12. [后端适配器与能力矩阵](#十二后端适配器与能力矩阵)
13. [契约测试矩阵（每个动词的最低测试义务）](#十三契约测试矩阵)
14. [安全基线](#十四安全基线)
15. [版本化与废弃流程](#十五版本化与废弃流程)

---

## 一、文档结构约定

每个领域模块一份独立文档，**章节顺序强制**——对外暴露永远在最前（用户要求：先看到"如何暴露给外部、外部怎么用"，再看内部实现）：

```markdown
# 0N · {domain} 域设计（{一句话职责}）
> 版本 / 状态 / 依赖（订阅谁、被谁订阅）/ 契约版本
## 一、对外暴露（External Surface）← 最优先
  1.1 服务标识与挂载（cordis 服务名、插件名、profile 挂载矩阵）
  1.2 命令（写动词）总表
  1.3 命令逐个详述（schema / 返回 / 错误 / 幂等 / actor / RoE）
  1.4 查询（读投影）逐个详述
  1.5 事件（发布 / 订阅）
  1.6 模型工具面投影（模型实际看到的工具名 + 描述全文）
  1.7 看板 RPC 投影
  1.8 外部调用示例（模型调用 / 代码调用 / 脚本调用各至少一例）
## 二、内部实现（Internal）
  2.1 数据模型（表 / 文件 / 列 / 索引 / owner 声明）
  2.2 状态机与不变量（完整流转图 + 网关前置校验清单）
  2.3 事务与联动实现（事务边界 / 强弱联动 / 失败语义）
  2.4 后端适配器（repository 接口签名 + 三后端实现要点 + 能力矩阵）
  2.5 缓存与失效策略
  2.6 性能与容量（当前数据量 / 索引 / 预期增长）
## 三、迁移与兼容
  3.1 现状代码映射（从 v4.x 哪个文件哪段搬迁）
  3.2 兼容别名与观察期
  3.3 数据迁移脚本要点
```

**粒度要求**：文档写到"实现者不需要再做设计决策"的程度——每个动词的每个参数有类型/必填/默认值/校验规则，每个不变量有失败错误码，每个事件有完整 payload schema。

## 二、标识符与命名规范

| 对象 | 规范 | 示例 |
|---|---|---|
| 域名 | 小写单词，单数，业务域名词 | `vuln` `asset` `task` `fact` `know` `scope` `approval` `exec` `ledger` `report` `proxy` `fgs` `eval` `authz`* |
| cordis 服务名 | `secDomain.{domain}` | `secDomain.vuln` |
| 插件包名 | `@silksec/sec-domain-{domain}` | `@silksec/sec-domain-vuln` |
| 后端插件包名 | `@silksec/sec-backend-{domain}-{backend}` | `@silksec/sec-backend-vuln-sqlite` |
| **命令（写动词）** | `{domain}_{子仓?}_{对象?}_{动作}`，snake_case，中段可省；**动作必须是状态机语义动词**（confirm/reject/register/promote…），禁自由态 update | `vuln_confirm` `asset_grade` `know_exp_promote` `exp_store`* |
| **查询** | `{domain}_{对象}_{读法}` | `vuln_candidates` `asset_deep_queue` |
| 工具名（模型面） | 与命令/查询名**完全一致**（投影零改名） | 工具 `vuln_confirm` = 命令 `vuln.confirm` |
| RPC 名（看板面） | `{domain}.{verb}` 点分（RPC 通道允许点号） | RPC `vuln.confirm` |
| 总线内命令寻址 | `{domain}.{verb}` | `dispatch('vuln', 'confirm', args, ctx)` |
| 事件名 | `{domain}.{对象}.{动作过去式}` | `vuln.candidate.promoted` |
| 事件 jsonl 文件 | `data/events/{domain}.jsonl` | |
| 幂等键前缀 | `{domain}:{verb}:{自然键}` | `vuln:confirm:fpr:<fingerprint>` |
| 表名 | 复数名词（沿用 v4.x，**不改名不迁库**） | `findings` `assets` |
| 模块文档文件 | `v5/{NN}-{domain}.md` | `v5/02-vuln.md` |

*authz（scope+credentials）为单一授权域，见 `08-scope.md`。

**子仓前缀豁免**：know 域六子仓动词保持 v4 原名（`exp_store` / `kb_import` / `vc_save` / `rule_seed`…），不加 `know_` 域前缀——子仓前缀（`exp_`/`kb_`/`vc_`/`pb_`）天然构成命名空间，且 12 个工具名在 prompt 体系高度内化，改名收益为零、行为漂移风险为实。`know_` 前缀只留给跨子仓动词（`know_adopt` / `know_health` / `know_transition`）。总线寻址 `dispatch('know', 'exp_store')` 域前缀由总线承担。其他域无子仓结构，不适用本豁免。

**禁用词**：任何新动词不得叫 `update` / `set` / `save` / `modify`（自由态写入口）。确需"改一个可选字段集合"的，必须先回答"这是不是一个状态机流转"——是则起语义名，否则拆成多个动词。

## 三、调用方模型（actor）

每个命令声明 actor 白名单；网关在 dispatch 前校验。**actor 是声明出来的，不是猜出来的**：

| actor | 含义 | 典型动词许可 |
|---|---|---|
| `model` | LLM 工具调用（worker 或宿主会话） | 绝大多数领域动词；禁机器直灌通道、禁审批裁决、禁 scope 写 |
| `dashboard` | 看板 RPC（携带 auth-gate 用户身份） | 裁决/流转/取消类；写操作审计带 `operator` 字段 |
| `script` | 经 exec 域 run_cli 跑的治理/采集脚本落库 | 各域的 proposal 落库类（`asset_grade` 等） |
| `webhook` | xray 等机器事件接收器 | 仅机器直灌通道（`vuln_register_candidate` 等） |
| `scheduler` | 调度循环 | `task_finish` 等 task 域内部动词 |
| `approval` | 审批批准事件的订阅执行 | `scope_grant` 等（由 approval.approved 事件携带） |
| `reactor` | **域事件订阅反应器**（approval 事件之外的跨域事件订阅处理器调用面，由总线从订阅回调注入，模型/看板不可见、不可伪造；审计 cause 链指向源事件及其原始 actor） | 事件联动回写类（`task_worker_register` / `vuln_attach_fgs` 等），各命令白名单显式列出 |
| `system` | 总线/域自身生命周期（迁移、初始化） | 全部；仅限启动/迁移窗口 |
| `human` | 人工经 CLI 直调（运维应急通道） | 只读查询 + 显式标注 `--actor human` 的写；审计高亮 |

规则：
1. actor 不可伪造：模型不能在参数里自称 dashboard——网关从**调用面**（tools.register 回调 / RPC 连接 / 脚本环境变量）注入 actor，调用方声明的 actor 字段一律忽略。
2. 工具投影层按 `profile × actor 白名单` 决定**是否向模型注册该工具**（model 不可用的动词，模型根本看不见——负向保障第一层）。
3. actor 之上可叠加细粒度身份：`dashboard` 带 operator 用户名，`model` 带 session_id，`script` 带 run_id——进审计。

## 四、命令规范

**写动词八条铁律**（每个命令详述页必须逐条对齐）：

1. **动词即状态机入口**：命令只做一件事——把对象从一个合法状态迁移到另一个（或登记新对象）。目标状态是动词名的一部分，**调用方永远不传 `status`/`to` 参数**。状态机图是模块私有资产，只通过动词集合对外可见。
   - **治理通道豁免（仅此一例）**：治理通道的周期判定型流转（`fact_transition`）允许 `to` 参数。边界三条件缺一不可：① 目标状态由外部调度计算得出（sweep 判定"逾期"），调用时才可知，无法预编进动词名；② actor 白名单仅 `system/human`；③ 不向模型注册工具——"自由态写入口"对模型物理不存在。其他域援引本豁免须逐条满足三条件并单独评审。
2. **一个命令一个事务**：后端在 BEGIN IMMEDIATE 内完成该命令的全部行变更（含联动列）。跨域效果不进本事务——发事件，最终一致。
3. **幂等必填**：见 §六。重放同一命令必须返回与首次相同的结果（信封带 `replay: true` 标记）。
4. **证据即参数**：语义上"确认/验证/落账/结论"类动词，证据参数（run_id / evidence_path / flow_id）是 schema required。缺证据 = `E_EVIDENCE_REQUIRED`，不是运行时警告。
5. **前置不变量在网关**：manifest 的 invariants 清单由 CommandGateway 在事务前逐条执行，失败返回对应错误码。域实现内部不重复校验（也不可能有绕过——service 实例只由网关构造）。
6. **事件必发**：命令事务提交成功后必然发布 manifest 声明的事件；事务失败不发。同步订阅者异常被网关捕获 → audit 记 `subscriber_failed`，不回滚命令（强联动除外，见 §八）。
7. **审计唯一落点**：每个命令一条统一 audit 记录（§九），域内禁止私自追加审计行。
8. **actor 白名单**：§三。

补充规则：
- **参数 schema 严格模式**：`additionalProperties: false`；未知参数 `E_SCHEMA`。参数一律显式类型（禁 `any`）。
- **副作用声明**：manifest 中每个命令必须标注 `side_effects: [rows_touched, events, files, caches]`——看板与文档据此渲染。
- **批量动词**：需要批量时显式提供（`{...}_bulk` 后缀），上限进 schema（如 ≤500 行），逐行校验、单事务、行级结果数组返回。
- **命令不得隐含查询副作用**：写命令返回的信封只含受影响对象的关键标识 + 状态快照，不返回大结果集。

## 五、统一返回信封与错误码

**成功信封**：

```json
{
  "ok": true,
  "domain": "vuln", "cmd": "confirm",
  "data": { "id": 341, "status": "confirmed", "signal": true },
  "event_ids": ["evt_01J..."],
  "idempotency_key": "vuln:confirm:fpr:a3f...",
  "replay": false
}
```

**失败信封**：

```json
{
  "ok": false,
  "domain": "vuln", "cmd": "confirm",
  "error": {
    "code": "E_STATE",
    "message": "finding #341 已处于终态 confirmed，不可再次流转",
    "hint": "如需补充证据用 vuln_note；如需提交用 vuln_submit",
    "retryable": false
  },
  "idempotency_key": "..."
}
```

- `hint` 是写给模型看的自我纠错指引（v4.x 的 approval_hint 模式推广）——**每个错误码在模块文档中必须给出典型 hint 文案**。
- **全局保留错误码**（网关产生，域不可复用）：

| code | 语义 | retryable |
|---|---|---|
| `E_SCHEMA` | 参数校验失败（message 含具体字段与期望） | false |
| `E_ACTOR_FORBIDDEN` | actor 不在白名单 | false |
| `E_NOT_FOUND` | 目标对象不存在 | false |
| `E_STATE` | 状态机不允许该流转 | false |
| `E_INVARIANT` | 前置不变量失败（message 指明哪条） | false |
| `E_IDEMPOTENT_CONFLICT` | 同 key 不同参数 | false |
| `E_CAPABILITY_UNSUPPORTED` | 当前后端不支持该命令（能力矩阵） | false |
| `E_BACKEND_UNAVAILABLE` | 后端不可达（http-remote 网络失败等） | true |
| `E_CONFLICT` | 并发写冲突（SQLITE_BUSY 超时等） | true |
| `E_EVIDENCE_REQUIRED` | 证据类参数缺失或引用不存在 | false |

- 域自定义错误码：`E_{DOMAIN}_{...}` 前缀（如 `E_VULN_FP_MISMATCH`），模块文档声明，不得与保留段冲突。

## 六、幂等规范

1. **键构造三级**（模块文档为每个命令指定其一）：
   - **自然键**：域内已有唯一约束（fingerprint / (program_id, fact_key) / dedupe_key）——网关以 `{domain}:{verb}:{自然键值}` 构造；
   - **显式键**：调用方传 `idempotency_key`（模型/脚本侧推荐）；
   - **自动指纹**：无自然键的命令（如 vuln_note），网关对 `(domain, verb, args 核心字段)` 取 sha1。
2. **保留窗口**：`idempotency` 表保留最近 7 天或 10,000 条（LRU 淘汰）；命中同 key 同参数 → 返回首次结果 + `replay: true`；同 key 不同参数 → `E_IDEMPOTENT_CONFLICT`。
3. **实现位置**：网关统一实现，域不写幂等逻辑（v4.x spawn_worker dedupe_key、webhook 指纹去重的经验泛化）。

## 七、查询规范

1. **纯读**：查询绝不产生行变更。原"搜索即记 uses"类副作用 → 拆为独立命令（如 `know_exp_record_usage`），由投影层在查询后补发（audit 可见、失败不影响查询结果）。
2. **统一分页信封**：`{ rows: [...], total: N, limit, offset }`；`limit` 默认 50、上限 500；`sort` 白名单列 + `dir=asc|desc`。
3. **可见域谓词与计数同口径**：每个列表查询与其对应 `total` 必须由同一个 where 构造器生成——这是 v4.3 修过的病（countFacts/factSearch、queryFindings 行数≠总数），**契约测试必须有"行数=total"断言**。
4. **可见域谓词是查询参数**（archived / noise / memcore status / program 归属），默认值在模块文档声明；谓词实现放查询层不放 SQL 散点。
5. **聚合查询**（stats/overview/coverage）独立命名，不与列表查询混用参数。

## 八、事件规范

1. **命名**：`{domain}.{对象}.{动作过去式}`；payload 只含**ID 与判据快照**（谁、从什么状态、到什么状态、关键引用），**不含行全量**——订阅方需要详情自己查询。
2. **事件信封**：

```json
{
  "id": "evt_01J...",
  "domain": "vuln", "name": "candidate.promoted",
  "ts": 1789000000000,
  "actor": "model", "session_id": "...",
  "cause": { "cmd": "vuln_confirm", "idempotency_key": "..." },
  "payload": { "finding_id": 341, "from": { "noise": 1, "status": "new" }, "evidence_run_id": "run_x" }
}
```

3. **联动分级**（manifest 中每个订阅声明强/弱）：
   - **强联动**（`mode: sync`）：订阅者失败 → 触发命令整体回滚报错。仅用于"业务正确性依赖"（候选消减、授权生效、审批闭环写回）；
   - **弱联动**（`mode: async`）：订阅者失败 → audit 记 `subscriber_failed` + 事件保留可重放。用于 eval 回流、vault 导出、雷达追加、统计刷新。
4. **留痕与回放**：全部事件按域追加 `data/events/{domain}.jsonl`；`sec bus replay --since <ts>` 支持按事件日志重放弱联动订阅者（灾备与调试）。
5. **禁止事件风暴**：一个命令的事件发布数量有上限（默认 1，批量命令 ≤ 批量行数）；高频信号类（如 exec.run.completed 每次工具调用）payload ≤ 2KB。
6. **订阅声明**：域在 manifest `subscribes` 里声明订阅 + 模式 + 处理器名——**未声明订阅的域收不到事件**（显式依赖，防止隐式耦合）。

## 九、审计规范

统一 audit 记录（CommandGateway 唯一写入点，`data/audit.jsonl` 沿用，schema 升级为 v5 结构）：

```json
{
  "ts": 1789000000000,
  "kind": "command",
  "domain": "vuln", "cmd": "confirm",
  "actor": "model", "session_id": "...", "operator": null,
  "idempotency_key": "...", "replay": false,
  "target": { "finding_id": 341 },
  "before": { "status": "new", "noise": 1 },
  "after": { "status": "confirmed", "noise": 0 },
  "result": "ok",
  "error_code": null,
  "duration_ms": 12,
  "backend": "sqlite-local"
}
```

- 读操作不审计（除 `human` actor 的直调），但**全部失败命令都审计**（含 E_SCHEMA/E_ACTOR_FORBIDDEN——越权尝试本身就是安全信号）。
- exec 域的 run_cli 守卫链审计（deny/allow）保持 v4.x 结构，作为 `kind: "guard"` 并存。
- `audit_tail` 查询（总线提供）支持 domain/cmd/actor/session/时间窗过滤。

## 十、时间与时区规范

- **存储**：UTC epoch 毫秒（INTEGER 列，沿用 v4.x）。
- **展示/文档**：北京时间 ISO（`YYYY-MM-DDTHH:mm+08:00`）。
- **台账/报告文件名**：北京日期（沿用 attempts-{program}.tsv、handoff-{date}.md 的日期口径）。
- **调度锚点**：北京时区（tasks next_run_at 语义不变）。
- 域文档中所有"过期/复验/保留窗口"默认按北京日切。

## 十一、可见域谓词规范

跨域统一概念，各域在查询中实现：

| 谓词 | 语义 | 默认 |
|---|---|---|
| `archived` | 已归档（memcore transition 目标） | 排除 |
| `noise` | 噪声/候选隔离维度 | 信号面默认排除，候选查询显式打开 |
| `lifecycle` | mem_class × status 组合（cooling/candidate 降权不隐藏） | cooling/candidate 打标可见 |
| `program` | 项目归属过滤 | 全部 |

**候选池语义修正（v5 全局定义）**：候选 = `noise=1 AND status='new'` 的**工作队列**，有认领/消减/终态出池语义（详见 02-vuln.md）；任何"候选计数"KPI 一律按此口径（v4.x `findings_noise` 只看 noise 列的病在契约层根除）。

## 十二、后端适配器与能力矩阵

1. **repository 接口**：每域 `backend/repository.js` 用 JSDoc 定义接口——方法名 = 命令/查询所需**原语**（`getFinding / insertFinding / transitionFinding / listFindingsWhere`），**不含 SQL 语义、不含业务校验**（校验在网关，业务逻辑在 commands/）。
2. **三个标准后端**：
   - `sqlite-local`（默认）：node:sqlite，WAL，busy_timeout 5s，跨进程；
   - `http-remote`：外部系统 REST 对接，必须实现重试（retryable 错误）+ 超时 + 降级策略（见各域文档"同步策略"节）；
   - `file`：TSV/YAML/JSONL 形态（ledger/rules/vulncards），写入原子（tmp+rename），读取方走域查询。
3. **能力矩阵**：后端 manifest 对每个命令声明 `full | partial(带说明) | unsupported`；`unsupported` 命令被网关以 `E_CAPABILITY_UNSUPPORTED` 拒绝（fail-closed，不静默降级）。**partial 必须写清差异**（如 http 后端不支持弱指纹合并 → register_signal 传 partial：重复指纹直接报 E_CONFLICT）。
4. **混布**：允许一域多后端分层（如 vuln：候选池 sqlite-local overlay + 已确认信号同步 http-remote 主库）——同步边界在域内 commands 层实现，调用方无感。
5. **切换**：bundle 配置一行（`sec_domain_vuln_backend: sqlite-local|http-remote`），运行时热切换仅允许 sqlite↔sqlite；切 http 需重启宿主面（连接池初始化）。

## 十三、契约测试矩阵

每个命令的**最低测试义务**（三后端跑同一套，`test/contract-{verb}.test.js`）：

| 用例类 | 断言 |
|---|---|
| happy path | 信封结构 / data 字段 / 事件已发布 / audit 已落 |
| schema 拒绝 | 缺 required、未知参数、类型错 → E_SCHEMA |
| 不变量拒绝 | 每条 invariant 至少一个反例 → E_INVARIANT（或语义化子码） |
| 状态机拒绝 | 非法流转（含终态再流转）→ E_STATE |
| actor 拒绝 | 每个非白名单 actor 至少一例 → E_ACTOR_FORBIDDEN |
| 幂等重放 | 同 key 重放 → 同结果 + replay:true；同 key 异参 → E_IDEMPOTENT_CONFLICT |
| 并发 | 两进程同时写（仅 sqlite）→ 一成一 E_CONFLICT 或串行化成功 |
| 事件载荷 | payload 符合 schema、不含行全量 |

每个查询：行数=total 断言、谓词默认值断言、分页边界。**测试不过的域不允许上线**（setup.sh 冒烟阶段跑契约测试）。

## 十四、安全基线

1. **证据铁律类型化**：确认/结论/落账类动词的证据参数 required（§四.4）——"无证据不结论"从纪律变为接口。
2. **机器直灌与模型登记分流**：`*_register_candidate` 类通道 actor 限 webhook/script/parser；模型只能走完整登记或显式确认——闸门从 if 变成不存在的接口。
3. **run_cli 沙箱交叉校验**：域 manifest `owns.files` 与沙箱可写白名单在 setup.sh 冒烟时交叉断言——**域 owned 文件对沙箱必须不可写**。
4. **凭据零明文**：credentials 只存引用（.env 600），域文档中任何示例不得出现明文 key。
5. **脱敏规则**：事件 payload 与 audit 的 before/after 快照经域声明的 `redact` 字段清单过滤（如 params 脱敏、cookie 剥离）；导出类命令过授权域脱敏硬门（scope.yml 域名命中拒绝——v4.x vault 导出桥规则保留）。
6. **fail-open 仅限治理旁路**：memcore 类治理订阅失败不阻断业务（既有公理）；**领域主链路一律 fail-closed**。
7. **审计不可绕过**：唯一写入口 = 唯一审计点；任何"跳过审计"的捷径都是缺陷。

## 十五、版本化与废弃流程

1. **契约版本**：域 manifest `version: N`；新增动词/可选参数 = 兼容（不 bump）；改语义/删参数/改事件 payload = bump major，总线在启动时对已注册域做版本兼容检查。
2. **动词废弃三段式**：`deprecated`（manifest 标记，工具描述加"已废弃，改用 X"，audit 记 deprecated_use）→ 观察期一个调度周期（7 天，audit 零使用为验收）→ 删除（契约测试同步删）。
3. **兼容别名**：v4.x → v5 旧工具名映射表由总线维护（`aliases: { finding_add: vuln_register_signal }`），别名同样过网关全管线（不绕校验）；别名删除走废弃三段式。
4. **prompt 引用同步**：动词改名/废弃时，persona/objective/skills/technique-index 中的工具引用由脚本化改写（复用 p14-1-tool-refs.py 模式），改写后 `discipline-audit.py` 增加"悬空工具引用"断言。
