# REVIEW · 总线合理性与模块原子化审查报告

> 审查日期：2026-09-11 ｜ 审查范围：`doc/secagent/v5/` 全部 20 份文档（00-18 + README）
> 审查基准：`00-conventions.md`（宪法）与 `01-bus.md`（总线）为上位规范，逐域交叉核对对外暴露面、依赖声明、事件订阅对账、命名/错误码/幂等/骨架合规性
> 方法：六路并行逐域审查 + P0 级发现人工原文复核（复核均确认属实）
> 性质：**2026-09-11 的历史审查基线**；当次只读，正文保留原结论与行号，不代表今天全部问题仍未修复。

2026-09-12 后续：5.7（`00173d0`）已处理 fp_query 冲突、FGS 事件语义、事件命名/订阅对账及 authz 伪域等；5.8（`3eb2da9`）把逐域深度审查写回 00–17 文末。具体实现、未修缺口和验收范围以 [PROGRESS](PROGRESS.md)、对应域最新审查及 [csai 预检记录](../upgrades/2026-09-12-dsh-0.1.5-rc.2-record.md) 交叉核对，不能把本表全部当作待办，也不能因 5.7 完成就认定全部关闭。升级和学习增量见 [统一升级目录](../upgrades/README.md)。

---

## 一、总体结论（TL;DR）

| 审查维度 | 结论 |
|---|---|
| **总线设计是否合理** | **合理，骨架可落地**。11 段管线、event_outbox 跨进程可靠投递、强/弱联动二元语义、R1-R7 注册校验、双投影零改名、幂等三级键——设计自洽且针对 v4.x 病灶（12 条写路径、52 case 手写分发、裸 SQL）逐一有解。但总线文档自身与模块文档存在 **6 处系统性接口矛盾**（见 §三.2），且实现期已补的 4 项能力未回写（漂移）。 |
| **模块原子化是否足够** | **14 域中 12 域达标或基本达标**。02/03/04/10/13 为样板级；05/06/08/09/11/12 基本达标（有已声明的例外或灰区）；**07-know 有破口**（查询写副作用 + owns 漏报 + actor 链断裂）；**14-fgs 不达标**（明文"绕过网关是设计内的"，直接顶撞宪法）；**15-eval 部分不达标**（异步执行器绕网关写）。必要的强依赖全部保留且形式合法（见 §四），未发现非法强依赖。 |
| **文档执行是否正确** | **设计意图层面正确，契约对账层面存在 10 组 P0 级断裂**。最严重的是：调度链派单必被拒（actor/timeout 双断）、两代审批执行模型并存于"定稿"文档、`exec.run.completed` payload 契约四方错位、reactor actor 白名单系统性断裂、"被订阅"声明大面积悬空。 |

**一句话**：架构方向与原子化划分是健康的，真正的问题不在"设计不合理"，而在**定稿文档之间、文档与已落地实现（PROGRESS）之间的契约对账未完成**——按现状进入联调会在 8-10 个点上必炸。

---

## 二、总线（01-bus）合理性评估

### 2.1 设计合理的部分（确认无需改动）

1. **写收敛成立**：`dispatch()` 唯一写入口 + service 实例仅由网关构造（不 provide 内脏），从物理上消灭 v4.x 的多写入口病灶。域插件不 provide 业务方法的规定正确。
2. **事件可靠性设计成立**：命令事务内写 outbox（与业务表原子）→ web 宿主面单 dispatcher 派发 → `bus_subscription` (event_id, subscriber) 唯一键幂等消费 → 指数退避 + dead_letter + `bus_replay` 回放。崩溃恢复语义完整。
3. **强/弱联动二元语义消除了"同步但不回滚"的中间态**（宪法 §八.3），SAVEPOINT 嵌套 + 深度闸 3 + 注册期订阅环检测，闭环。
4. **幂等三级键**（natural/explicit/auto）+ 网关统一实现（域不写幂等逻辑）+ replay 语义先于不变量（⑥在⑦前）——顺序论证成立。
5. **防绕过承诺**（R1-R7 拒载清单、owns 唯一性交叉、版本回退拒绝、禁用词 lint、R3 状态参数拒载）覆盖面完整。
6. **总线自举**（自己吃自己的 repository 狗粮）、幂等/审计永远留本地（http-remote 挂掉审计链不断）——取舍正确。
7. **进程模型与现实对齐**：web/headless 双面挂载 + 后台单例收敛（sidecars + 文件锁）+ headless 不起 dispatcher，与线上"web 宿主 + 多 headless worker 共用 SQLite"的事实一致。

### 2.2 总线自身的疑点与缺陷（需修 01-bus 或裁决）

| # | 问题 | 严重度 | 证据 |
|---|---|---|---|
| B-1 | **dispatcher 职责缺口**：09-approval 的 `approval_effects` 表由"总线 dispatcher 逐个执行"（09 L535），但 01-bus §2.2.5 的 dispatcher 只消费 `event_outbox` 的 async 订阅，**全文没有"读 approval_effects 并派发"的职责定义**；effect 行的状态写回、`approved_pending_effects→approved` 迁移无命令、无 repo 原语、无执行主体。这是唯一可能突破单写者律的结构缺口 | **P0** | 09 L394/L534-536/L548-553 × 01 §2.2.5 |
| B-2 | **`exec.worker.finished` 强联动无事务载体**：worker 退出发生在 spawn_worker 命令返回分钟级之后，10-exec 未声明承载该发布的命令/守护机制；sync 语义要求"与命令主体共用事务"——没有命令主体，sync 落空 | **P0** | 10-exec L146/L156/L237/L427 |
| B-3 | **sync 订阅跨进程失效**：`scope.rules.changed` → exec QPS 桶（sync）只在**发布者进程**事务内执行；headless 不起 dispatcher。QPS 桶是进程级单例 → worker 面永不更新，"即时生效"承诺对 worker 失效。被废止的 v4 mtime 轮询恰是每进程生效的 | **P1** | 10-exec L293/L438/L519 × 01 L427/L437 |
| B-4 | **实现期补丁未回写 manifest schema**：`explicit_only` 幂等（10-exec L56，不在 01 L321 三策略内，按 R1 应拒载）、`idempotent:'none'`（"天然幂等"，11-ledger L38/14-fgs L219）、`backend_transactional` 非事务域、R2 禁用词豁免（`task_update_note`）——PROGRESS L26-27 显示实现均已落地，01-bus schema 未同步 | **P1** | 10 L56/L620 × 01 L321/L349-351 × PROGRESS L26-27 |
| B-5 | **R3 未限定"顶层"参数**：字面上"命令 schema 含 status 参数名拒绝"会误杀 `endpoint_upsert` 行内的 HTTP status 字段（04 L64/L379）；实现已按顶层口径落地（PROGRESS L31），01 文本需补限定词 | P1 | 01 L351 × 04 L64 |
| B-6 | **事件风暴上限与批量声明脱节**：01 L163 括注"batch 动词 schema 已限 ≤500"，但 `asset_grade` proposal 上限 2,000 行逐行发事件（03 L193）、`endpoint_upsert` tsv 模式 ≤5,000 行逐新发事件（04 L55/L280）——单命令 2,000-5,000 条 outbox 行需总线侧确认或收编 | P1 | 01 L163 × 03 L193 × 04 L55 |
| B-7 | **批量事件声明通道缺失**：02-vuln L168 引用 manifest `event_limit: 2` 字段——01 manifest schema 无此字段；C1/C3 各发 2 事件在现行契约下无声明通道 | P1 | 02 L168 × 01 L317-343 |
| B-8 | **spawn_worker 幂等键三方不接洽**：01 L655 说"由 task 域文档声明为 explicit 幂等键"+ 01 L292 示例 `task:create:dedupe:...`；05-task 全文无此声明；10-exec L135 声明为自然键 `sha1(task)`。三方需统一为 exec 自然键口径并修订 01 §3.3/§2.1 | P1 | 01 L292/L655 × 10 L135 × 05 全文 |
| B-9 | **Q4 operator 注入未实测 vs 下游已断言既成事实**：01 Q4 自认 auth-gate 身份通道"未实测验证"且有回退方案；16-dashboard L92/L267 与 18-migration L135 直接当既成事实引用 | P2 | 01 L667 × 16 L92 × 18 L135 |
| B-10 | **别名注册表三方冲突**（详见 §五 P1-6）：`proxy_pool_get` 在 01 L628 指 `proxy_gateway`、13-proxy L430 指 `proxy_sticky_bind`；07-know 的 `exp_validate` 折叠别名未进 01 注册表；18 L38 引用的 `finding_query`/`submission_draft` 不在 01 表内 | P1 | 01 L613-639 × 13 L430 × 07 L776 × 18 L38 |

---

## 三、原子化评估清单（14 域 + 2 投影面）

判定口径：**写侧是否单写者（owns 内）、跨域副作用是否全部事件/命令化、是否存在绕开 CommandGateway 的写入口、查询是否纯读**。必要的跨域读（查询接口）与跨域命令调用（dispatch 全管线）不视为破坏原子化。

| 域 | verdict | 关键依据 / 破口 |
|---|---|---|
| 02-vuln | ✅ **原子化充分**（写侧零越界） | 全部写动词只落 findings + data/evidence/；跨域全部事件化；灰区：INV-2 对 exec owns 的 results//flows/ 做文件存在性直读（02 L154），建议改经 exec 查询 |
| 03-asset | ✅ **充分（样板）** | 评级五列结构性闸门（schema additionalProperties:false）；唯一阴影：L631 "LEFT JOIN 预聚合子查询"与 L353/L648"跨域读经查询"口径矛盾，需改措辞 |
| 04-endpoint | ✅ **充分** | owns 边界与沙箱交叉断言最完整；同有对 results/ 的直读灰区 |
| 05-task | 🟡 **基本达标** | 跨域写全部事件/dispatch 化 ✅；破口：C15 对账直读 exec owns 的 run_dir/meta.json（L415/L638/L642，与同文档 L455 的合规矩形自矛盾）；L703 引用的"exec run 标注接口"在 10-exec 不存在（悬空） |
| 06-fact | 🟡 **基本达标** | 无跨域写、查询纯读 ✅；破口：reactor 不在任何 lifecycle 命令白名单（F-2，memcore 通路白名单层不闭合）；C10 有表无详述节（骨架缺项） |
| 07-know | 🟠 **有破口** | ① `know_coverage(refresh:true)` 查询产缓存文件 = 查询写副作用 + 缓存文件无 owner（违 §七.1）；② owns 漏报 `data/knowledge/`（R4 与沙箱交叉断言覆盖不到）；③ `know_adopt(target=rules)→rule_seed` 白名单交集仅 human，approval/dashboard 通路物理不通；④ `exp_update` 命中 R2 禁用词（注册即拒载）；⑤ onExecRunCompleted 明示 actor=reactor 但 pb_outcome 白名单无 reactor |
| 08-scope | 🟡 **基本达标** | exec 守卫链走查询接口（不重实现、不直读文件）✅；例外：§2.5 外部写入接管流程（yml diff→自动补镜像 + audit）是不经网关的写入口，已声明但需收敛到 platform actor 口径 + 双进程单例声明 |
| 09-approval | 🟡 **意图达标，机制未闭环** | "只发事件不直写任何域"在命令层成立（I5）；但 effect outbox 的执行/写回主体未定义（见 B-1）；CHECK 约束（含两个 effect 状态）与"表零迁移"三处不可兼得（L172 vs L386 vs L614） |
| 10-exec | ✅ **合规（设计层）** | parser 直写归零、沙箱 × owns 交叉断言三方咬合（10 §2.2.4 × 01 §2.7§E × 05 INV-T12，PROGRESS 实录 PASS）；后处理①②的事件化与直 dispatch 表述并存属文档残留（E-2/E-3），实现已是事件化 |
| 11-ledger | ✅ **达标（2 项自声明例外）** | 例外 1：pipeline_validate 直读 asset/endpoint TSV 表头（只验格式，可接受）；例外 2：coverage_report(materialize=true) 查询写文件（自挂开放问题，需宪法裁决） |
| 12-report | ✅ **达标（1 项例外）** | report_list 惰性 heal（读路径删孤儿索引行 + audit）= 查询写副作用，建议迁独立命令 |
| 13-proxy | ✅ **达标** | 采集 proposal→命令落池的 platform 边界最清晰；五文件唯一写者是域命令 |
| 14-fgs | ❌ **不达标** | 明文"域内 service 直接落 failed step 节点……**绕过网关 INV-F1 是设计内的**"（L413，另 L46/L242）——直写无 audit/无幂等/无事件，直接顶撞宪法 §四.5/§四.7；同文档已有合规路径（fgs_fail 白名单含 reactor + INV-F1 豁免），残留旧设计应删。另 L416"sync 订阅者失败不回滚"是宪法 §八.3 明文消灭的中间态 |
| 15-eval | 🟠 **部分不达标** | C2/C3 的域内异步执行器在命令返回后自行翻转状态 + 落盘报告 + 发事件——全部在任何命令事务之外（无 audit、无 outbox）；订阅 handler 用 actor=system（应为 reactor）且 C1 白名单不含 reactor |
| 16-dashboard | ✅ **合规** | 5 个聚合 case 全部"只准调查询" + INV-D6 断言；壳零自有写命令；operator 注入不可伪造 |
| 17-llm-surface | 🟡 **机制合规，数据漂移** | 投影算法与 fail-closed 六条与宪法 §三 同构 ✅；但 §1.2 计数表 12/15 行漂移、不可见清单 5 处硬冲突、§1.1 与 §1.6 自相矛盾（见 §五 P0-9） |

### 原子化亮点（值得固化的模式）

- 03-asset 的"结构性闸门"（评级列只能经 asset_grade，由 schema strict 保证）——优于 vuln 早期靠 invariant 的形态；
- 13-proxy 的 platform 边界（脚本产 proposal、命令落库、inbox 非 owns 只读）——宪法 §三 platform actor 的最佳实践；
- 07-know 的 card_usage 归属论证（写归 ledger、读经事件+查询）与"搜索即记 uses"拆分（exp_record_usage/kb_record_usage 对称）——宪法点名的标杆实现；
- 10-exec 的 parser 零 import 零 DB 连接 + proposal 文件 + 事件——物理隔离最彻底。

---

## 四、依赖清单

### 4.1 强依赖（同步调用/前置依赖——全部合理，建议保留）

| 调用方 | 依赖对象 | 形式 | 评估 |
|---|---|---|---|
| 全部 14 域 | bus | 注册 manifest + dispatch/query | 架构公理，必然 |
| exec | **scope** | G4 守卫链经查询网关同步查 `scope_check`；G5/G9 读 rules | ✅ 合理：授权前置是安全不变量，走查询接口不重实现（08 L291/L672 × 10 L66/L519 双侧一致） |
| exec | approval | G5/G9 拒绝点 dispatch `approval_request`（tool-intrusive） | ✅ 合理（注意 actor 接线点应为 system，见 P1-11） |
| task | **exec** | 调度器 `dispatch('exec','spawn_worker')` 派 worker | ✅ 合理的强依赖，但当前契约层双断（P0-1/P0-2） |
| task | scope | workspace_path 解析 + programs 存在性校验 | ✅ 合理（programs 读路径需补"经 scope 查询"口径） |
| task | approval | C16 submit_complete → approval_request；超时审批 | ✅ 合理 |
| task | fgs | dispatch fgs_clear/fgs_add（启动序列） | ✅ 合理 |
| task | ledger | INV-T6 三产物守卫查询 | ✅ 合理，但查询名与失败语义两文档矛盾（P1-2） |
| approval | scope/task/know | kind validate 的只读跨域查询 | ✅ 合理 |
| asset / endpoint | scope | INV-3 `scope_check` 只读 | ✅ 合理 |
| vuln | scope | C11 G0 scope-guard | ✅ 合理 |
| vuln / asset / endpoint | exec | 证据/proposal 存在性校验 | 🟡 形式是**文件直读** results//flows/（02 L154/04 L158），建议改经 exec 查询统一口径 |
| know | scope | scope.yml 域名集只读 + mtime 缓存 | 🟡 内容经查询 ✅，mtime 探测是跨域文件触碰，建议改为查询返回版本号 |
| report | vuln/scope | 只读查询聚合 | ✅ 合理 |
| ledger | know/task | discipline_stats 委托查询（不 import 不直读） | ✅ 合理 |
| eval | vuln | 回流 handler 先 vuln_get 查询再落 case | ✅ 合理 |
| memcore（非域） | bus | inject 门面 + 订阅 + dispatch lifecycle 命令 | ✅ 合理，但 reactor 白名单链断裂（P0-7） |
| dashboard | RpcProjector；llm-surface | ToolProjector | ✅ 投影消费面，必然 |

**结论：没有发现"为了省事而产生的非法强依赖"。所有强依赖都有明确的业务正确性理由（授权前置、worker 派生、审批闭环），且形式上是查询或全管线 dispatch，不是 import 直调或表直写。**

### 4.2 事件弱依赖（已核实双向一致 ✅）

| 事件 | 发布方 | 订阅方（mode） | 状态 |
|---|---|---|---|
| `exec.run.completed` | exec | vuln(async) / asset(async) / endpoint(async) / know(async) / ledger(async) | ⚠️ 订阅存在，但 payload 契约四方错位（P0-6） |
| `exec.run.failed` | exec | fact(async) | ✅ |
| `exec.worker.spawned` / `.finished` | exec | task(**sync**) | ⚠️ 方向/mode 一致，payload 不一致（P0-3） |
| `scope.rules.changed` | scope | exec(**sync**) | ⚠️ 订阅存在，跨进程失效（B-3） |
| `task.finished` | task | fgs(**sync**) / fact(async) | ✅ |
| `fgs.node.done` | fgs | fact(async) | ✅ |
| `approval.approved` | approval | fact(async, exclude-exception) / ledger(async, radar) | ✅（注：08/09 文档另有矛盾挂点，P1-3） |
| `fact.bb.published` / `fact.expired` / `fact.archived` | fact | know(async) | ✅ |
| `vuln.signal.confirmed` / `vuln.signal.rejected` | vuln | eval(async) | ✅ |
| `scope.granted` | scope | task(async，种子任务) | ⚠️ actor 链断（P1-10） |

### 4.3 声明悬空的依赖（"被订阅"失真——无对端声明）

| 声明方 | 声称的消费方 | 实际 | 证据 |
|---|---|---|---|
| 02-vuln | fgs / report / asset 订阅 vuln 事件 | **均不订阅**（fgs 仅订 task.finished；report 订阅=无；asset 仅订 exec.run.completed）；仅 eval 真实 | 02 L6/L321/L649-652 × 14 L4 / 12 L4 / 03 L481 |
| 03-asset | vuln 订 `fp.recorded`（intel_hunt）；ledger 订 `asset.graded` | **均悬空**（intel_hunt 是 exec 命令而非订阅者） | 03 L7/L415 × 02 L435-438 / 11 L4 |
| 04-endpoint | vuln 订 endpoint.* / queue.*；ledger 订 endpoint.registered | **全部悬空**；且 `endpoints-{program}.tsv` 归 ledger owns 的说法在 11-ledger L21 无载——**文件无主** | 04 L7/L303/L449 × 11 L21 |
| 09-approval | scope/task/know/exec/eval 订阅 approval.* | **均不订阅**（均已迁移 effect outbox）；真实订阅者 fact/ledger 反而没列全 | 09 L4 × 08 L572 / 07 L387 / 05 L485 / 10 L4 / 15 L149-154 |
| 05-task / 14-fgs | ledger 订 task.finished 追加 handoff | 11-ledger 文档未声明（实现已补 appendHandoff，文档未回填） | 05 L5/L477 / 14 L475 × 11 L258-259 × PROGRESS L28 |
| 10-exec | vuln 订 `exec.flow.appended`；endpoint/vuln 订 `exec.import.completed` | 02/04 订阅表均未声明 | 10 L4/L213/L238 × 02 L435 / 04 L343 |
| 06-fact | "vuln 域可订阅 fact.deprecated" | 02 全文无此订阅 | 06 L115 |
| 15-eval | report 消费 eval.report.built | report 订阅=无（弱悬空，措辞"可选"缓和） | 15 L6 × 12 L4 |

**建议（治本）**：宪法层面规定"被订阅"栏只允许写对端文档已声明的订阅；总线注册校验（R 系）增加**订阅声明对账**——启动时输出"声称被订阅但未声明"清单进 bus_status，从制度上消灭这一类失真。

---

## 五、问题清单（分级）

### P0 · 阻塞级（联调必炸 / 直接违宪，10 组）

| # | 问题 | 证据 |
|---|---|---|
| P0-1 | **调度链派单必被拒（actor 断）**：05-task L701 `dispatch('exec','spawn_worker', actor=scheduler)`，而 `exec_spawn_worker` 白名单 = `model, dashboard`（10-exec L33/L158）→ 每次派单 `E_ACTOR_FORBIDDEN` | 已人工复核 ✅ |
| P0-2 | **调度链超时段**：调度预算 `max(3600, min(budget, 7200))`（05 L396/L701；09 L318 同口径），spawn schema 上限 ≤3600（10-exec L130，该单元格自身还矛盾地说"调度链可到 7200"）→ 批准延时后必 `E_SCHEMA` | 05 × 10 L130 |
| P0-3 | **worker 事件 payload 双方契约不一致**：task 侧要 `{run_id, dedupe_key, pid, task, cwd, timeout_sec, session_id, run_dir}`（05 L59/L413），exec 侧发 `{run_id, dedupe_key, cwd, timeout_sec, pid, origin_session_id}`（10 L236）——缺 task/run_dir、session_id 改名；`exec.worker.finished` 无 `truth` 字段（05 L285/L706 与 14-fgs L266 都消费 truth），且 10-exec 全文无"拒执标记扫描"实现描述 | 05 × 10 |
| P0-4 | **两代审批执行模型并存于定稿文档**：旧"approval.approved 订阅 + 强联动回滚"残留于 08 头部 L4/L62/L107/L210/L435/L659/O-1 L687、05-task L50/L426、09 L318/L573；新"effect outbox"见 08 §2.3.3、09 §2.3、05 L485、07 L387、02 L438 + PROGRESS L29（实现已是新模型）。05-task L426 的"sync 订阅失败回滚 decide"与新模型根本对立 | 多文档交叉 |
| P0-5 | **14-fgs 域内直写 + "sync 不回滚"**：L413 明文"绕过网关 INV-F1 是设计内的"（无 audit/无幂等/无事件，违 §四.5/§四.7）；L416"同步订阅者异常…不回滚命令"是宪法 §八.3 明文消灭的中间态。同文档已有合规路径（fgs_fail 白名单含 reactor） | 已人工复核 ✅ |
| P0-6 | **`exec.run.completed` payload 契约四方错位**：exec 声明 `parse_proposal={parser, counts, proposal_file, digest}`、行本体在 proposal.json 文件（10 L252-267）；vuln 假设 `payload.parse_proposal.findings[]` 内联（02 L437）；asset 假设 `.assets/.fingerprints/.state_signals` + `kind` 分支（03 L483-494）；endpoint 假设 `kind==='endpoints'` + `tsv_path`（04 L345-350）。kind/state_signals/tsv_path 在 exec schema 均不存在。另 10 L286 消费契约写 `asset_upsert ×N`、03 实际用 `_bulk` | 10 × 02 × 03 × 04 |
| P0-7 | **reactor actor 白名单系统性断裂**：01 L146 定死治理订阅者身份 = reactor，但 fact C1/C5/C7、know C8(pb_outcome)/C21/C22、eval C1 的白名单均不含 reactor；memcore/eval 的 lifecycle 回写在白名单层必然 `E_ACTOR_FORBIDDEN`。同时 01 L205 示例用 script、06 L528 用 system、00 L97 限 system 于启动/迁移窗口——四个位置三种身份无一闭合。修法二选一：lifecycle 动词白名单补 reactor（并放宽治理豁免条件②），或修宪法 §三 | 01 × 06 × 07 × 15 × 00 |
| P0-8 | **xray 候选登记路径 02 与 10 互斥**：02 L444/L753 = exec 边缘接收器直派 `vuln_register_candidate`（无事件）；10 L213/L238 = 发 `exec.flow.appended` 由 vuln 订阅。02 订阅表无该事件、10 被订阅栏点了 vuln 的名。二选一必须定死，否则双写或漏写 | 02 × 10 |
| P0-9 | **17-llm-surface 数据层断裂**：① §1.1 L16"两面工具集完全一致" vs §1.6 L162/L173"headless 按 phase 裁剪"正面矛盾（18 L104 与实现站在 §1.6）；② §1.2 计数表 12/15 行与已定稿域文档不符（vuln 8/5→实 11/6；know 15/12→实 21/15；exec 命令查询数对调；合计 146→实 ≈185）；③ 不可见清单 5 处硬冲突（task schedule/block/resume/cancel 实含 model；scope cred_add 实含 model；fact record_validation 实含 model；eval 的 `case_add/case_resolve` 两动词名不存在；漏 exec_flow_append/fgs_clear）；④ 表内算术自爆（26 vs 29）；⑤ L107 `exec_verify_replay` 悬空（该动词在 vuln 域） | 17 × 02/05/06/07/08/14/15 |
| P0-10 | **RPC 命名三套口径、三段式不可路由**：01 机械规则 `{domain}.{verb}` 首点拆分；07-know §1.7 声明三段式 `know.exp.feedback`、06 `fact.bb.read`、08 `program.list`/`cred.query`（domain 段非注册域 → `E_BUS_DOMAIN_UNKNOWN`）；16 两种混用且与 07 声明名 9 处错位、与 03/05/08 各错 1 处。没有任何文档描述三段式如何被 RpcProjector 路由。需裁定：域 §1.7 回归两段式，或 01 §2.2.6 增补子仓段解析 | 01 L182-183 × 07 L415-435 × 08 L415-421 × 16 L63/L162-173 |

### P1 · 契约断裂级（必修，不阻塞首日联调）

| # | 问题 |
|---|---|
| P1-1 | **know 库文件矛盾（事务公理风险）**：07 L474 用 `asset-db.db`；01 L238/06 L377 用 `asset-graph.db`。若属实则"命令事务含 outbox/幂等行"跨不了两个 SQLite 文件——破坏宪法 §四.2 的物理基础。必裁 |
| P1-2 | **task_finish 守卫语义矛盾**：11-ledger L225/L409 fail-closed（缺产物 → E_INVARIANT 不落 done）vs 05-task L295/L680"守卫失败不拒绝事务"；守卫查询名 `ledger_task_proof`（11 L211）vs `ledger_pipeline_guard`（05 L291/L680，不存在） |
| P1-3 | **radar 入队双挂点**：11-ledger L259 订 `approval.approved` vs 08 L363/09 L454 让 ledger 订 `scope.granted`（PROGRESS 实现 = approval.approved）。两订阅并存 = 双份入队 |
| P1-4 | **`exp_update` 命中 R2 禁用词**（v4 只是 RPC case，作为 v5 命令是新动词，不享子仓豁免）→ 注册即拒载；`task_update_note` 的豁免实现已补但宪法 §二与 01 R2 未回写 |
| P1-5 | **approval CHECK 约束 vs 零迁移不可兼得**：09 L172"不动 CHECK" vs L386 两个 effect 新状态 vs L614"表零迁移" |
| P1-6 | **别名表三方冲突**（详见 B-10）；另 `task_chain` 别名方向四方矛盾（10 L40/L202/L304/L597 × 05 L809 × PROGRESS L27） |
| P1-7 | **`approval_request` 幂等键堵正常流**：自然键 `{kind}:{subject}` + 7 天窗口，与 L64"驳回后补新证据重提是正常流"冲突（同参 → replay 旧单；异参 → E_IDEMPOTENT_CONFLICT） |
| P1-8 | **scope grant/revoke/bind 自然键幂等吞写**：grant→revoke→7 天内再 grant 命中 replay 不重授权（fail-open 方向危险）；bind 改绑必 E_IDEMPOTENT_CONFLICT。建议键折入目标态哈希 |
| P1-9 | **15-eval 异步执行器绕网关**（完成写无 audit/无 outbox）+ actor=system 错用 + 示例用被禁的 `inject('secDomain.vuln')` + RPC 名 camelCase |
| P1-10 | **`scope.granted`→task_create 的 actor 链断**：C1 白名单无 reactor，scope.granted 非 approval 事件不能用 approval actor |
| P1-11 | **exec G5 审批接线点 actor 未声明**：09 I6 规定 tool-intrusive 的 request_actors 仅 system，run_cli 透传 model 必被拒 |
| P1-12 | **vuln RPC 投影与白名单矛盾**：02 L481-482 新增 `vuln.registerSignal`/`vuln.verifyReplay` RPC（actor=dashboard），但 C1 白名单仅 model/human、C9 仅 model/script → 必 E_ACTOR_FORBIDDEN |
| P1-13 | **C17 task_complete 触发口径**：05 L50/L426"订阅 approval.approved 强联动 sync"与 §1.5 订阅表（未声明）及 09 L524（effect）矛盾，L426 为残留 |
| P1-14 | **12-report**：schema 含 `status` 参数（R3 拒载级，PROGRESS 已裁决改 `status_filter` 未回填）；引用不存在的 `scope_program_list`（实为 `program_list`）；`report_index_rebuild` 有详述未入命令总表；两条不变量同号 INV-R6 |
| P1-15 | **C16 task_submit_complete 证据参数未标 required**（违 §四.4）；C9 fact_reindex"自然键 + 重跑重建"与幂等语义互斥 |

### P2 · 文档质量级（成批修订）

| # | 问题 |
|---|---|
| P2-1 | **side_effects 大面积缺失**：02（11 个命令全缺）、06（10 个全缺）、07（21 个全缺）、10（6 个全缺）、05（仅 2/17）、08（缺 3）、15（缺）——宪法 §四补充规则与 01 manifest schema 均强制 |
| P2-2 | **agent_note 问题**：02 `vuln_register_signal` 316 字超 240 预算、`vuln_candidates` 144 字超 120；09 `approval_request` ≈430 字（R1 拒载级）；01 R1"缺失拒绝"未对模型不可见动词条件化（05 C8 明写"agent_note：无"） |
| P2-3 | **命名违规簇（既成事实需裁决）**：03 `fp_record`/`fp_record_bulk`/`fp_query` 无域前缀 + `fp.recorded` 事件两段式；04 `queue_status` 查询无前缀 + `queue.enqueued`/`queue.consumed` 事件两段式；08 `program.bound` 事件缺域段；07 引用 `card_usage.logged` 缺域前缀（应为 ledger.*）。二选一：宪法 §二补豁免条目，或走 §十五改名 |
| P2-4 | **错误码不规范**：02 `E_EVIDENCE_LEGACY_UNAVAILABLE`（非保留码无域前缀）；12/13 `E_INTERNAL`；07 `E_DUPLICATE`；07 能力矩阵用非注册值 "half"；02 把 scope-guard 拒绝映射为 E_ACTOR_FORBIDDEN（语义拉伸） |
| P2-5 | **计数/引用漂移**：17 §1.2 全表（见 P0-9）；16 "53 case 兼容层其余 47 个"应为 48；18 "approval 六 kind"实为七 kind；18 G-1/G-2/G-3/G-7 标号无出处；18 "R0/R4 契约化"的 R0 无定义；01/18 的"52 case"已被 16 L6 更正为 53；18 L173 引用 03 §1.3.2 应为 §1.3.3 |
| P2-6 | **示例参数漂移**：`vuln_confirm` 在 01 L193/17 L82/L188/L302 的示例用 `candidate_id`+`evidence_run_id`，02 L153-154 实为 `finding_id`+`evidence`——正是 17 §2.4 自定的"悬空 hint=缺陷"应捕获项 |
| P2-7 | **订阅 manifest 要素缺失**：06/07 订阅表缺 `as` 列（01 L341 强制）；05 L484 的 handler 是散文不是函数名；10 高频事件未声明 `high_frequency: true`（run.started/failed 同频未覆盖）；事件 manifest `redact` 清单多域未给 |
| P2-8 | **骨架/编辑性缺项**：06 C10 有表无详述；07 C22 占位动词入正式总表；07 头部 L4"订阅 approval.approved"与 L387"不订阅（勘误）"自相矛盾；07 工具计数 16/20/22 三个数字互斥；07 K-10/K-11 白名单与工具面互斥（exp_update、vc_activate/deprecate）；09 错误码表两行 E_STATE 重复；12 §1.8 示例 camelCase 参数必 E_SCHEMA；15 头部格式与模板出入；16 L216 示例端口 8443 无出处（实为 3081） |
| P2-9 | **杂项**：03 L631 LEFT JOIN 口径矛盾（A-5）；08 S-4 scope_check 信封两种形状；10 L196 读操作走 dispatch 应用 query；10 L13 引用"§3.1 第 12 行"错行；11 P5 查询误写 dispatch；11 P7 exec_runs 计数器存储未声明；05 T-16 task_drift 查询已上线未入文档；14 P5"无写 RPC"与 fgs_deprecate 白名单含 dashboard 矛盾；14 P3 fgs_add schema 缺 depends_on 参数（additionalProperties:false 下 INV-F2/示例必炸） |

### 漂移登记（实现已先行、文档未回写 —— 须以 PROGRESS 为准回填上位文档）

1. 总线：`explicit_only` 幂等、`idempotent:'none'`、`backend_transactional` 非事务域、R2 豁免 `update_note`、R3 限顶层（→ 回写 00/01）；
2. ledger：appendHandoff 原语 + task.finished 订阅（→ 回填 11 §1.5/§2.4）；
3. report：`status`→`status_filter`（→ 回填 12 §1.3.1）；
4. task：`task_drift` 查询、task.finished payload 补 note（→ 回填 05）；
5. dashboard 视图插件包名：实现为 `sec-domain-scope`，16 L192/L236 残留 `sec-domain-authz`；authz/scope 双名在 00 L63/L78、README L41 间未收敛（建议统一为 scope，authz 仅作别名脚注）。

---

## 六、修复优先级建议

**第一批（阻塞联调，建议先于 Phase 2 推进）**
1. 修调度链双断（P0-1/P0-2）：`exec_spawn_worker` 白名单补 scheduler、timeout 上限对齐 7200；
2. 对齐 worker 事件 payload（P0-3）+ 明确 truth 的产生（exec 拒执扫描入 10-exec）与落点（workers 表加列或 task_finish 参数）；
3. 统一审批执行模型为 effect outbox，清除 08 头部/05 L426/09 L573 的订阅模型残留；同时在 01-bus 补 dispatcher 对 approval_effects 的职责段（B-1）闭环单写者律；
4. 14-fgs 直写改走 `fgs_add`+`fgs_fail`（actor=reactor，INV-F1 豁免已存在），删除"sync 不回滚"表述（P0-5）；
5. 四方对齐 `exec.run.completed` 的 proposal 契约（P0-6），顺带定死 xray 路径（P0-8）；
6. reactor 白名单批修（P0-7）：lifecycle 动词白名单统一补 reactor，或修宪法 §三；
7. 17-llm-surface §1.2 表按域文档重算（建议改自动生成）、删 §1.1 L16 过期表述、修不可见清单与 eval 动词名（P0-9）；
8. RPC 命名裁定（P0-10）：建议域 §1.7 回归 `{domain}.{verb}` 两段式（16/07/06/08 对齐），或在 01 §2.2.6 增补子仓段解析规则。

**第二批（契约完整性）**：know 库文件裁决（P1-1）、守卫语义统一（P1-2）、radar 挂点二选一（P1-3）、别名表三方对齐（P1-6）、approval 幂等键与 CHECK 迁移方案（P1-5/P1-7）、scope 幂等键修正（P1-8）、eval 执行器命令化（P1-9）。

**第三批（文档回填与制度）**：漂移登记 5 项回写 00/01/05/11/12/16；命名违规簇裁决（P2-3）；side_effects/agent_note/订阅 as 补齐（P2-1/P2-2/P2-7）；建立"被订阅对账"启动校验（§4.3 治本建议）。

---

## 附：审查方法与可信度说明

- 六路并行审查覆盖 02-18 全部文档，每路以 00/01 为基准交叉核对对侧文档；
- P0 级关键发现（P0-1/P0-5 等）已由审查主线人工回查原文确认；
- 行号以 2026-09-11 工作区文件为准；PROGRESS.md（Sep 11 18:29）作为实现侧事实来源引用。
