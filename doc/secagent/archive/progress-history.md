# SilkSecAgent 进度历史归档（历史留档 · 只读）

> 归档日期：2026-09-19。本文件保存 PROGRESS.md 迁移前的历次更新日志、已完成节点、已关账待办与批次守则（含文档漂移排查 B1–B5 及其自递归模板）。
> **只读不改写**：当前进度见 [PROGRESS.md](../PROGRESS.md)；升级/专项完整记录见 [upgrades/](upgrades/README.md)。
> 归档时点的运行快照不代表今天；历史数字与 commit 仅作回溯。

---

## 〇、更新日志（滚动，归档时点 2026-09-19）

> 只在此追加；最新在最上。详细方案/记录见 [archive/upgrades/](upgrades/)（历史留档，不改写）。

| 日期 | 变更 | 结果 |
|---|---|---|
| 2026-09-19 | **文档漂移排查 B5（`13-proxy`/`14-fgs`/`15-eval`，末批闭环）**：以 csai 运行态 + manifest/backend/契约测试逐域核验——**proxy** 三命令幂等键按 manifest 改 `none`+域内文件态（proposal sha1 / hostport / sticky_key），删「自然键」误述；空池改「不发 `E_PROXY_LIVE_EMPTY`、只回 `data.hint`」；`proxy_stats` 补 `writable`；`proxy_list` 分页默认 20→50、返回 `{rows,total_live,total,limit,offset}` 说明按总线信封；§1.7 六 RPC 端点标注看板**未接入**（dashboard-rpc 无 proxy case）；exec 注入前 `proxy_stats` 健康观测**未实现**、verify_replay 归 vuln 域（sec-pipeline 已删）；§2.4 repository 原语补全；§3.1 历史留档；§五 sticky「进程内缓存无持久化」勘误为持久 `sticky.json`。**fgs** F1 actor 补 `reactor`；F2–F6/F8 幂等改 `none`（状态机前置）、F7 auto、F9 natural；F1 参数补 `depends_on`、错误补 `E_FGS_PARENT_INVALID`；时序图 fgs 补记 `sync`→**async**；`prompt_hint` 标注**未接线**（调度器实际走 `sec-suite/host-compat.js` 硬编码 `buildScheduledPrompt`）；模型不可见补 `fgs_snapshot`；§1.6 别名段改历史留档；§1.7 `fgs.list`/`fgs.export` 标未接入、§1.8 导出改 `/silksec-domain`；§3.1/§3.2 历史留档。**eval** C1 幂等去「当日窗口」（manifest natural `finding_id+verdict`）、C2/C3 标 `none`+命令体指纹 10 分钟窗口；owns 补 `data/events/eval.jsonl`、模型禁入补 `eval_run_finish`；Q1 返回字段按实测、Q3 limit 20→50；§1.6 补 `eval_run_finish` 行；§1.7 仅 `eval.stats` 已接入、其余未接入；§2.1 eval-live 补 `source/label_source/visibility`、contract-cases 示例改真实 **9 用例**（删已废 `freeform-update`）；§3.1 历史留档、§3.3 种子 7→9 纠正；§五/§六测试数实测 29/29。**顺带修复**：fgs manifest `prompt_hint`/`fgs_complete` agent_note 中已删别名 `finding_add` 悬空引用→`vuln_register_signal`（模型面描述，不改行为）；`p-v5-1-migrate-eval.js` 过期种子注释（7 用例/freeform）纠正。**清理**：csai 四处过期重复测试副本（fgs/asset/bus/endpoint 的 `dsh-plugin-*.contract-*.test.js`，setup 只维护 `contract-*.test.js`，重复副本令 `node --test` 双计） | B5 闭环、**B1–B5 全部批次完成**；csai 服务 active、14 域 registered、`aliases=0`；契约测试 proxy 17/17、fgs 21/21、eval 29/29 全绿；`sec-v5-accept.sh` PASS=39 FAIL=0；`bundle dsh setup csai` 重部署（rsync 模板→`/opt/SilkSpool/bundles/dsh/` + 重启 silksecagent）后 fgs manifest 悬空引用归零；未改业务逻辑、未动运行态数据 |
| 2026-09-19 | **文档漂移排查 B4（`08-scope`/`09-approval`/`10-exec`/`11-ledger`/`12-report`）**：以 csai 运行态 + manifest/backend 逐域核验——scope 幂等键按 manifest 改 `none`/auto 字段指纹、`program_bind_workspace` 未接 workspaceRegistry、外部写入接管/`fs.watch`/pairWorkspaces 标注未实现、§1.7 伪 RPC 名纠偏（`scope.program_bind_workspace` 等）、`scope.rules.changed` 零订阅者、§3.1 历史留档；approval owns 补 `approval_effects`、decide effect 改为**命令内同步 dispatch**（非 dispatcher outbox）、状态机持久列仅三态（`approved_pending_effects`/`approved_effect_failed` 未落列）、kind 注册表=代码内 `APPROVAL_KINDS` 共 8 kind、`tool-intrusive` 收窄纠偏为 system/model、§1.3.4 回归分支不可达与 §3.1 deleted scheduler.js 标注；exec 订阅置空（scope.rules.changed 移订阅）、G4 仍本地读 scope.yml 过渡桥、know `pb_outcome` 回执未实现、`exec_task_chain` 迁出+别名移除、burp 幂等 `file`、spawn/worker 注册表去重、§3.1 历史留档；ledger task 域不订阅任何 ledger 事件（方案 A 未实施，唯一守卫=同步 `ledger_task_proof`）、radar-inbox 收割未实现、discipline_stats 补 `exec_runs_24h`、§3.1 历史留档；report 参数 `status`→`status_filter`（R3）、`report_index_rebuild` 未实现（改惰性 heal）、§3.1 历史留档；顺带清理 csai `plugins/sec-domain-scope/test/` 下与 `contract-scope.test.js` 内容重复的过期副本（setup 只维护前者，重复副本令 `node --test` 双计） | B4 闭环；csai 服务 active、15 域 registered、`aliases=0`；契约测试 scope 15/approval 19/exec 24/ledger 22/report 12 全绿；仅改文档 + 清过期测试副本，未动运行态数据 |
| 2026-09-19 | **文档漂移排查 B3（`02-vuln`/`03-asset`/`04-endpoint`/`05-task`/`06-fact`/`07-know`）**：以 csai 运行态 + manifest/后端逐域核验——vuln 补 `vuln_evidence_put`（实为 13 命令）、C2 actor 增 dashboard、C9/C11 去伪「+分钟」、§1.7 删不可达 RPC（verifyReplay/registerSignal）；asset 六命令幂等键改为 auto 字段指纹、`owner` 列与 `--proposal` 标注未实现、RPC `asset.detail→asset.get`；endpoint 幂等键/`E_ENDPOINT_QUEUE_EMPTY`/`urls 上限`/RPC 名纠偏（实际仅 endpoints/endpointHosts）、surface_scan 形状 `{url,keyword,source}`；task 17 命令/11 查询对齐（补 task_drift）、续期重试与状态机纠偏（`in_progress` 不存在）、§1.5 补 `know.release.revoked`；fact 工具 13→14（补 fact_overview）、C1 actor 增 reactor、RPC `fact.bb.read→fact.bb_read`、行数 873/761 刷新；know 表/列名回正（exp_cards / exp_cards_archive / kb_docs_archive / scenario·chain / pos_fb·neg_fb）、§1.7 去伪点分 RPC 名、L5/L6 用例 60→70→73；六域 §3.1 统一加「历史留档（v4→v5 迁移期）」横幅、§3.2 观察期段落改历史时态、测试数按实测（vuln 50+9 / asset 30 / endpoint 25 / task 38 / fact 23 / know 73） | B3 闭环；仅改文档未动运行态（05-task 因执行顺序已单独先行提交） |
| 2026-09-19 | **文档漂移排查 B2（`00-conventions` / `01-bus`）**：以 csai 运行态为准逐项核验——bus_status 实测 `aliases.count=0`（旧例 31/finding_update 系漂移）、`mount`/`bus.degraded` 字段缺失、audit_tail/events_tail 缺 `operator`/`offset`；`bus_replay` 的 `E_BUS_REPLAY_RANGE`、replay 锁 `E_CONFLICT`、`result_json` 64KB 截断、audit 重试队列均为未实现的设计预留，已显式标注；R3 补 `to` 治理豁免（fact/know_transition）、R4 改指实际 `bus.domain.rejected`/`E_BUS_DOMAIN_REJECTED`；audit「⑪不回滚」矛盾改为 fail-closed 回滚；actor 值域八→十、timeout 上限 3670000→7270000；`/silksec-dashboard` 52→56 case fail-closed UI 适配层；bus 契约数 52→51；业务域数 15→14；文档路径 `v5/{NN}`→`doc/secagent/{NN}`；§3.1 加「历史留档」横幅 | B2 闭环；BUS 51/51 全绿（csai 实跑） |
| 2026-09-19 | **兼容别名层彻底移除**：迁 dashboard-rpc finding 状态流转与 ui-session「登记候选漏洞」到语义动词（`vuln_confirm/reject/submit`、`vuln_register_candidate` actor 增 dashboard）；`bus.aliases.yaml` 空注册表；删 bus v4-dup-shape/dup_of 放宽；eval 契约删 `freeform-status-update` | 全 14 域契约测试全绿；accept 39/39、ui-headless 70/70；discipline-audit `aliases=0 / dangling=0 / deprecated=0` |
| 2026-09-19 | **旧版统一清理**（用户授权跳过并排观察）：删看板旧单体 `@silksec/sec-dashboard`（含 `-old`/Modal/footer）、v4 调度循环 `sec-suite.scheduler.js`、v4 重复工具（asset-graph 9 + sec-pipeline 3）、一次性脚本与旧构建产物、死码 `sec-suite.parsers.js` | 看板唯一形态 = ui-core/ui-panel + 6 承载面包 + 7 域视图包；14 域 registered；定时任务无扰动 |
| 2026-09-19 | **文档统一**：v5 模块文档扁平化到 `doc/secagent/`（00–18 各自滚动维护）；本文件成为**唯一**进度/更新文档（合并 upgrades 时间线）；旧 README/审查/会话模板/历次升级方案与记录全部移入 `archive/`；全仓库跨文档链接与代码契约注释路径同步 | 链接漂移归零；`doc/secagent/{archive,00–18,PROGRESS,README}` 单一结构 |
| 2026-09-19 | **看板/UI 文档合并 + 漂移修复（本会话）**：原 16-dashboard（数据层）+ 19-ui-surface（原生面）合并为单一 `16-dashboard.md` v6.0，模块号收敛 00–18；全仓库 `19-ui-surface` 引用改指 `16-dashboard`；按实测修正漂移（`/silksec-dashboard` 56 case 瘦适配层仍在、非「case 删除/自动投影」；`playbooks→know.exp_rank`；别名层已清空；D3 删旧已完成；旧单体已删无 Modal 回退）；17/18 别名层表述同步；新增「文档漂移排查」分批分配（见本文件 §〇·补）| 链接/口径漂移归零；后续域批量见 §〇·补 |
| 2026-09-18 | UI 原生面 P7 收尾（16-dashboard 回填 / 主题 v4.2 / accept UI 冒烟固化）；U4 观察期关账；自学习 L0–L6 验收 | accept 39/39、ui-headless 70/70；DSH 0.1.5-rc.2 完成 |
| 2026-09-16/17 | 自学习专项 L0–L6 全部上线（证据/学习记录、候选规程、独立评测、受控晋升、检索计分、完整运营体验）；定时任务链式调度与两轮稳定性修复 | 各域契约全绿；生产实测走通 |
| 2026-09-15 | DSH 0.1.2-rc.1 → **0.1.5-rc.2 U3 生产切换**（冻结→prepare→RENAME_EXCHANGE→门禁→恢复写者） | 生产 0.1.5-rc.2，44 表 0 非预期差异 |
| 2026-09-12 | v5 全域深度审查（15 业务域 + 总线/后端/安装器 + 18 份文档回填）；总线原子化审查修复 | 部署态契约 347/347 |
| 2026-09-07~11 | v5 Phase 1–5：总线/vuln 试点 → 14 域滚动搬迁 → 事件化收尾 → http-remote 试点 → prompt/挂载矩阵/评测收敛 | 逐节点 commit 见 §二 |
| 2026-09-04 | DSH 0.1.1-rc.2 → 0.1.2-rc.1 | 上线记录见 archive/upgrades |
| 2026-08-23 | DSH 0.1.0-rc.7 → 0.1.1-rc.2 | 上线记录见 archive/upgrades |

---

## 〇·补、文档漂移排查（B1–B5 · 已闭环 2026-09-19）

> **目的**：以「运行态/代码为真相源」逐域核验 `doc/secagent/00–18`，消除历史口径漂移（动词/查询/事件/actor/幂等/schema、已删除的旧实现、已移除的别名层、合并后的章节引用）。
> **规则**：一次会话 = 一个批次（≤3–6 个文档）；每批次收尾必须：① 更新本表状态；② 追加 §〇 更新日志一行；③ 在会话末尾输出「自递归提示词」（下一批次）；④ 提交并推送。
> **状态（2026-09-19）**：B1–B5 **全部 ✅ 闭环**，无 ⬜ 批次；自递归已终止（见本节末模板，禁止自动续批）。此后如需复查，显式新建批次后按同规则执行。
> **真相源优先级**：运行态证据（`spool`）> 代码/manifest > 契约测试 > 文档；文档内部冲突以 [00-conventions](../00-conventions.md) 为上位。

### 分批分配与状态

| 批次 | 文档 | 核验重点 | 状态 |
|---|---|---|---|
| **B1** | `16-dashboard`（合并原 19）、`17-llm-surface`、`18-migration`、`README`/本文件结构 | 看板/UI 文档合并；两 RPC 通道实测；56 case 口径；别名层已删；D3 删旧；旧单体删除 | ✅ **2026-09-19 完成（本会话）** |
| **B2** | `00-conventions`、`01-bus` | 宪法条款 vs 总线实现（R1–R9、幂等三级键、audit fail-closed、别名空表、端点命名）；宪法 §十一/§十五 与运行态对照 | ✅ **2026-09-19 完成（本会话）** |
| **B3** | `02-vuln`、`03-asset`、`04-endpoint`、`05-task`、`06-fact`、`07-know` | 各域 manifest commands/queries/events/actor 白名单/invariants 与文档 §1.2/§1.4/§1.5 逐项对照；L0–L6 新增动词回填；§3.1 引用的 v4 文件是否已删 | ✅ **2026-09-19 完成（本会话）**：六域命令/查询/actor/幂等/事件按 manifest 对齐（vuln 13+6、asset 6+6、endpoint 4+5、task 17+11、fact 10+7、know 32+23）；补 `vuln_evidence_put`、`task_drift`、`fact_overview`；修正伪 RPC 名与伪幂等键；未实现项显式标注；§3.1 统一加「历史留档」横幅；契约数实测 50+9/30/25/38/23/73 |
| **B4** | `08-scope`、`09-approval`、`10-exec`、`11-ledger`、`12-report` | 同上 + approval kind 注册表（7/8 kind）、effect outbox、report 索引 heal、ledger 纪律指标 | ✅ **2026-09-19 完成（本会话）**：五域命令/查询/事件/actor 按 manifest 与 csai 运行态对齐（scope 7+4、approval 4+3、exec 7+4、ledger 5+7、report 2+2；服务 active、15 域 registered、`aliases=0`；契约测试 scope 15/approval 19/exec 24/ledger 22/report 12 全绿）。**主要纠正**：① 幂等键统一改为 manifest `idempotent` 策略（scope 多为 `none`+命令层数据级幂等、approval/report/exec 部分为 auto 字段指纹，删「自然键」误述）；② approval 批准副作用改为 **decide 内同步 dispatch effect + 登记 `approval_effects`**（非 dispatcher outbox），状态机持久列仅 `pending/approved/rejected`（`approved_pending_effects`/`approved_effect_failed` 为未落列的设计预留），kind 注册表实为**代码内 `APPROVAL_KINDS` 共 8 kind**（非 manifest `kinds` 段），`tool-intrusive` request_actors = system/model；③ scope 不订阅 approval.approved（改 effect 视角）、`scope.rules.changed` 零订阅者、ledger radar 由 `approval.approved` 触发（非 scope.granted）；④ exec `subscribes` 为空（scope.rules.changed 订阅已删）、G4 仍用本地 `loadScope()` 读 scope.yml 过渡桥、know `pb_outcome` 回执未实现、`exec_task_chain` 已迁出且别名移除、burp 幂等 natural `file`；⑤ ledger task 域**不订阅**任何 ledger 事件（方案 A 未实施，唯一守卫=同步 `ledger_task_proof` B'）、radar-inbox 收割未实现、discipline_stats 补 `exec_runs_24h`/`data_source=unavailable`；⑥ report 参数 `status`→`status_filter`（R3）、`report_index_rebuild` 未实现（改惰性 heal）；⑦ 五域 §3.1 统一加「历史留档」横幅（`sec-suite.scheduler.js`/`sec-suite.parsers.js`/旧 `sec-dashboard.client.js` 已删标注）、§1.7 伪 RPC 名纠偏 |
| **B5** | `13-proxy`、`14-fgs`、`15-eval` | 同上 + proxy 落池算法、fgs 快照/语义动词族、eval 数据集/评测链 | ✅ **2026-09-19 完成（本会话，末批；B1–B5 全部闭环）**：三域命令/查询/事件/actor/幂等按 manifest 与 csai 运行态对齐（proxy 3+3、fgs 9+3、eval 5+4；服务 active、14 域 registered、`aliases=0`；契约测试 proxy 17/17、fgs 21/21、eval 29/29 全绿）。**主要纠正**：① proxy 三命令幂等策略=`none`+域内文件态幂等（proposal sha1/hostport/sticky_key），空池不抛 `E_PROXY_LIVE_EMPTY` 只回 hint，`proxy_stats` 增 `writable`，`proxy_list` 网关实际分页默认 50，看板 RPC 六端点均未接入，exec 注入前 `proxy_stats` 健康观测未实现，§五 sticky 持久化勘误；② fgs F1 actor 补 reactor、F2–F6/F8 幂等 `none`（状态机前置）而 F7 `auto`/F9 `natural`，F1 补 `depends_on`/`E_FGS_PARENT_INVALID`，失败补记 sync→async，`prompt_hint` 未接线（实际 host-compat 硬编码），模型不可见补 `fgs_snapshot`，§1.7/§1.8 未接入与端点纠正；③ eval C1 幂等去当日窗口（natural finding_id+verdict），C2/C3 manifest `none`+命令体 10 分钟指纹窗口，owns 补事件日志、模型禁入补 `eval_run_finish`，Q1 字段/Q3 分页按实测，§2.1 contract-cases 改真实 9 用例（删已废 freeform-update），§三项种子/测试数纠正；④ 三域 §3.1 历史留档；⑤ 修复 fgs manifest 悬空 `finding_add` 引用 + 迁移脚本过期注释；⑥ 清理 csai 四处过期重复测试副本（fgs/asset/bus/endpoint）。**部署验证**：`rsync` 模板→`/opt/SilkSpool/bundles/dsh/` 后 `bundle dsh setup csai` + 重启，服务 active、NRestarts=0、14 域注册无错、`sec-v5-accept.sh` PASS=39 FAIL=0 |

### 每域核验方法（B2–B5 通用）

1. **动 word面**：从 `bundles/dsh/templates/dsh-plugin-sec-domain-<域>.js` 提取 `VULN_MANIFEST`/`*_MANIFEST` 的 `commands`/`queries`/`events` 键与 actor 白名单、幂等策略、invariants，与文档 §1.2/§1.4/§1.5 表逐项 diff。
2. **运行态**：`spool exec csai "journalctl -u silksecagent --since '1 hour ago' | grep 域注册成功"`、`spool exec csai "cat /opt/silkspool/dsh/bus.aliases.yaml"`、必要时用 `sec-bus-cli.mjs`/`/silksec-domain` 查询核对。
3. **旧实现引用**：`grep` 文档内被删文件名（`sec-suite.scheduler.js`、`sec-dashboard.client.js`、`asset-graph.js` 已删函数、`sec-pipeline.js` 旧工具）——凡文档称「现行」而代码已删即漂移；历史映射表须显式标注「历史留档」。
4. **别名**：所有域 §3.2 应有「别名层已移除（2026-09-19）」横幅；正文其余处不得把别名写成现行机制。
5. **契约测试计数**：文档头部/状态行的测试数（如 know 73、task 38）与 `bundles/dsh/templates/*.contract-*.test.js` 实际用例数核对。
6. **章节引用**：合并后引用 `16-dashboard.md §x` 须真实存在；发现悬空锚点一并修。

### 自递归提示词模板（**已终止**：B1–B5 全部 ✅，2026-09-19 闭环）

> B5（末批）完成后本递归自然终止，不再输出「下一批」提示词。如需再查，请新建显式批次并分配文档范围，勿复用自动递归。

```text
【全部批次已完成 · 递归终止】
SilkSpool 仓库 /home/ubuntu/SilkSpool 的「doc/secagent 文档漂移排查」B1–B5 已全部 ✅ 闭环
（B5 = 13-proxy / 14-fgs / 15-eval，2026-09-19）。
- 状态真相源：doc/secagent/PROGRESS.md §〇·补「分批分配与状态」表（无 ⬜ 项）。
- 本轮收口：三域 manifest/文档对齐、悬空引用修复（fgs finding_add）、过期重复测试副本清理；
  契约测试 proxy 17/17、fgs 21/21、eval 29/29；csai 服务 active、14 域 registered、aliases=0。
- 后续如需复查：请显式新建批次（分配 00–18 文档范围），按 §〇·补「每域核验方法」执行；
  不要复用本模板自动递归，也不要跨批混做。
约束不变：远程一切操作走 spool；不改 spool 源码；不新建进度副本；不执行危险 Docker 操作。
```

---

## 一、总览（归档时点 2026-09-19）

- **迁移计划真相源**：[18-migration](migration-v4-to-v5.md)（Phase 0–5）
- **全局契约宪法**：[00-conventions](../00-conventions.md)
- **文档状态**：00-18 全量定稿（2026-09-06，commit `2e593e9`）
- **领域语言**：[CONTEXT](../../../bundles/dsh/CONTEXT.md)
- **当前 Phase**：**Phase 0–5 全部完成**。5.2 兼容别名删除于 2026-09-19 执行（迁调用方到语义动词后清空注册表，见 §〇）。**2026-09-19 旧版清理**（用户授权跳过并排观察）：删除看板旧单体 `@silksec/sec-dashboard`（`-old` 视图 + Modal 兜底 + footer 入口）、v4 调度循环模块 `sec-suite.scheduler.js`、v4 重复原生工具（asset-graph 九个旧工具 + sec-pipeline 三工具）、一次性消费脚本与旧构建产物；剩余旧面仅为 sec-suite/asset-db/experience 内部 v4 读取函数（见待办）。
- **UI 原生面升级（16-dashboard）**：2026-09-18 启动，前置硬闸 UI-0（dashboard-rpc 去 v4 兜底）、**P0 地基**（`@silksec/ui-core` 包骨架 / 11 视图原样登记 / `ui-surface-deps.yaml` 首版 / 跨 bundle require 验证）、**P1 主面板**（`@silksec/ui-panel`：main keyed 槽 + sidebar.panellist + selectPanel；11 视图升级为自足 wrapper；footer 改跳转、Modal 留降级）、**P2 审批套件**（`@silksec/ui-approval`：shell.overlay 待办胶囊 + 快捷处理浮卡 + 审批右侧栏 page tab；看板「审批」tab 保留观察）、**P3 任务套件**（`@silksec/ui-task`：任务右侧栏 page tab 四区块栏宽自适应 + 会话头「本会话任务」计数；看板「任务」tab 保留观察）、**P4 授权迁设置**（`@silksec/ui-settings-scope`：`settings.section`「授权范围」整节——program 列表/工作区徽章/scope.yml 条目管理/排除清单/凭据引用；看板「授权」tab 保留观察）**P5 会话内绑定**（`@silksec/ui-session`：`conversation.view`「安全产出」整页视图 + 会话头计数钮 + `assistant-actions`「登记候选漏洞 / 沉淀事实」；写操作经 `/silksec-domain` actor=dashboard）与 **P6 逐域视图拆分**（vuln/asset/endpoint/fact/know(+学习)/report/audit 七个浏览型域视图拆为独立 `@silksec/sec-dashboard-view-<domain>` 包，经 ui-core viewRegistry 注册、ui-panel 主面板装配；旧单体对应视图以 `-old` 后缀并排观察 7 天；`requires:['connection']` 缺席 tab 静默隐藏）已完成并部署 csai（见 §二、§三·九）；**P7 收尾（2026-09-18）完成文档/规范/accept 冒烟固化**——16-dashboard 状态回填、主题规范 v4.2 落盘、`sec-v5-accept.sh` UI 冒烟段（默认结构断言 + `--ui-headless` 运行时断言）固化；**旧单体 client 与 Modal 主形态已于 2026-09-19 删除**（用户授权跳过 7 天观察；`@silksec/sec-dashboard` 整包移除，`sec-dashboard-plugin-setup.sh` 仅组装 7 域视图包；回滚 = 单包 revert + profile 恢复依赖）。
- **5.2 兼容别名删除**：**已于 2026-09-19 完成**。未等待「7 天零使用」观察期（该观察期名存实亡——`finding_add`/`finding_update` 是当时看板写路径的承重结构）。执行方式为**先迁调用方再删别名**：dashboard-rpc finding 状态流转直达 `vuln_confirm/reject/submit`，ui-session「登记候选漏洞」直达 `vuln_register_candidate`（actor 增 dashboard）；`bus.aliases.yaml` 清空（`aliases: {}` / `dispatch_aliases: {}`，机制保留为通用能力）；`discipline-audit` 实测 `aliases=0`。
- **当前运行基线**：DSH **0.1.5-rc.2**（U3 生产切换完成 2026-09-15；**U4 于 2026-09-18 关账——用户授权提前，详见升级记录 §14.9**），关账后 MainPID 4025919、NRestarts=0、active/running、15 域注册；**DSH 0.1.2-rc.1 → 0.1.5-rc.2 升级已完成**。完整取证与实施结果见 [升级记录](upgrades/2026-09-12-dsh-0.1.5-rc.2-record.md) §14。
- **验收口径补充**：5.4 的 7/7 是网关 Mode A；当前 llm_probe 未实际调用模型（Mode B 需真实受测会话）。5.5 的历史零悬空引用只覆盖原扫描范围；2026-09-19 别名删除后全量复扫 `dangling_tool_refs=[]`、`deprecated_tool_refs=[]`。
- **升级与学习实施**：[DSH 0.1.5-rc.2 升级](upgrades/2026-09-12-dsh-0.1.5-rc.2-plan.md)U1–U3 已关账；生产切换完成（§14），U4 于 2026-09-18 关账（用户授权提前，§14.9），§14.5/§14.8 巡检全部健康；[自学习](upgrades/2026-09-12-self-learning-design.md) **L0–L6 全部实施上线（L0/L1 于 2026-09-16，L2–L6 于 2026-09-17，专项收官）**：L0=K1 kb 缺列修复 + K2 kb_revalidate 内容闭环 + K6 task 守卫异常显式失败/订阅 partial 可见 + K4 llm_probe 标签纠正 + K3 eval-run.js 迁 v5 总线；**L1=证据与执行学习记录**（§11.2）——exec_evidence_publish（system 专用，staging→清单+SHA-256 发布）+ vuln_evidence_attach（INV-10 已发布清单核验）+ learning_episodes 表/know_episode_record（reactor 专用，六类结果，双去重零重复记功）+ fgs_snapshot 收尾前固定进 task.finished；**L2=候选规程与来源版本**（§11.3）——knowledge_revisions 表（内容级 UNIQUE 去重、只插不改）+ know_revision_propose（model/script/dashboard；INV-K13 父链 / INV-K14 vulncard 最小结构闸 / INV-K15 来源可信闸）+ kb_revalidate(changed)→needs_revalidate 联动 + 首个 P1 授权类候选卡 VC-AUTHZ-001 r1（版本受控种子，候选≠发布）；契约 14 域 + 总线全套全绿（know 42/42、bus 52/52、vuln 59/59、task 30/30、exec 23/23、fgs 21/21、eval 19/19 等，本地全量 + csai setup 内硬门槛），owns×sandbox 交叉断言 70 项 PASS，生产冒烟通过（表已演进、候选卡在库、actor 闸实测拒绝、服务 active NRestarts=0）；**L3=独立评测**（§11.4）——llm_probe=true 真实受测 headless 会话（Mode B harness，工具轨迹/轮次/拒绝恢复落报告，refused/rejected=过、breach/wrong_code=败、error 单列）+ v5 fixture runner（VC-AUTHZ-001 三类 fixture 实体，127.0.0.1 受控状态断言产真值 INV-7，baseline/candidate 同案双跑）+ 分组/隐藏集（eval_datasets Q4，INV-6 model 对 hidden 只见元数据桩，INV-8 冻结 digest 校验）+ C5 eval_run_candidate（trial_id 幂等、预算最严值、eval.candidate.started）与 C25 know_revision_assess（reactor；begin/finish/abort，digest 锚定，eligible/rejected）经事件订阅链闭环——生产冒烟：trial-l3-prod-2 配对评测 eligible（tp=1/tn=1/infra 1/1），revision 状态链 candidate→evaluating→eligible 走通，actor 闸/幂等回放/eligible 不可再评实测，eval_stats 标签去重（46 行→35 唯一 finding）；契约 eval 19→27、know 42→50 全绿。L2–L5 部署均属 U4 观察期内基线变更（已记 handoff）。**L4=受控晋升和撤回**（§11.5）——写入口收口（exp_store/pb_save/vc_save/exp_update/exp_promote 移除 model，vc_activate 移除 script；看板 legacy 直写兜底与 sec-suite v4 knowledge-adopt 直写全部 fail-closed 关闭；alias 清点无指向）+ know_adopt 扩展（采用面只认 published revision，eligible 不可进使用面）+ C26 know_revision_publish（approval/human 专用；批准绑定内容哈希——内容变化即批准失效重批；发布=新增 know_releases 行不原地改旧版本；有限灰度 program/family 先于全局生效；effect 重试不重复发布——自然键+同批准既有 release 吸收）+ C27 know_release_revoke（灰度失败可恢复上一 published 版本）+ approval 域 kind8 knowledge-publish 与 approval_effects_retry 重试通道 + 发布投影（vc_list/vc_get 发布卡可见、Q19/Q20 投影）；契约 know 50→60、approval 16→19 全绿（14 域 + 总线全套本地全绿），生产冒烟通过。**L5=检索与计分**（§11.6）——Q21 know_retrieval_explain 分层检索只读投影（作用域→生命周期→适用谓词→来源等级，旧版本/跨 Program/失效负知识不进召回；family 灰度只与显式 family 上下文比对，适用性由卡面谓词裁决；计分随行不参与 rank）+ 曝光/采用/有效结果三计数分离（C28 know_exposure_record 30s 桶去重 / know_adopt+C28b 双通道落 know_adoptions / 有效结果从 learning_episodes 关联推导，模型自评单列不进已验证正例）+ know_scores 可重放重建投影（C31 know_scores_rebuild 不改历史行）+ C30 know_gap_record 覆盖补建登记（补建走 know_revision_propose 候选通道不直写）+ C29 know_feedback_ingest（system 专用，feedback id+revision 幂等，编辑/撤回重算）+ 原生反馈桥 @silksec/sec-feedback-bridge（web profile 专用，DSH rc.2 message-feedback session/event + feedback/committed → know_feedback_ingest，缺失显式 unsupported）；契约 know 60→70 全绿（本地 14 域全套 395/395 + setup 内双跑同绿），生产冒烟通过（VC-AUTHZ-001 r1 实测入召回 rank 320、actor 闸/幂等/重算实测、冒烟反馈 tombstone 撤销归零）。**L6=完整运营体验**（§11.7，专项收官）——学习面板「学习」tab（看板五问 learningOverview + 证据对照 learningTrace=Q23 全链追溯 + 撤回 learningRevokeRelease 只走 C27 fail-closed）+ 逐域视图（Q22 domains 三层聚合：漏洞族/surface/身份前置，小样本保守平滑）+ 调度器独立切换（task 域内建调度器全量重写 v4 等价——persona/FGS/续跑/预算帽/busy 回 queued/超时审批/会话反查/周期 reap/vault sync，契约钉死后同包原子切换，v4 startScheduler 停用保留回滚路径，无并行第二派单窗口；exec_spawn_worker +cwd/task_id）+ 四类节奏 goal（research/learn-daily/eval-batch/change-retest，know.release.revoked 自动生成复测任务）+ C32 vault 回流迁入受控动词 + 其余 P1 候选卡（VC-BIZFLOW/XSS/SSRF-001 已种入 candidate）。生产演示链实测走通：r2 提案→评测 eligible→审批 #22→发布 active→Q23 全链→C27 撤回→r1 自动恢复 active→change-retest 任务 #100021 自动生成；eval 孤儿扫描两起竞态（误标在飞 run/回收绕事件流卡死 revision）修复并契约固化（eval 28→29）；契约 know 73、task 38、exec 24、scope 15，15 套件全套全绿。**自学习专项 L0–L6 全部关账。**

---

## 二、已完成节点（附 commit 追踪）

| 节点 | 内容 | commit | 上线验收 |
|---|---|---|---|
| Phase 0 | 候选池缺陷热修：updateFinding noise 联动 + KPI 口径 + line229 守卫 + 数据修复脚本 | `4ae57cb` | ✅ 信号面 10→41，候选待消化 2，服务 active |
| 文档定稿 | 00-18 全量定稿 + 4 项关键决策落地（audit fail-closed / phase 子集 / 维持 00-18 / bus 暴露口径） | `2e593e9` | ✅（纯文档，无线上改动） |
| **1.1 总线骨架** | `@silksec/sec-domain-bus`：DomainRegistry（R1-R7 校验）/ CommandGateway（11 段管线）/ QueryGateway / EventOutbox+Dispatcher / ToolProjector / RpcProjector / 幂等三级键 / audit（fail-closed）/ 别名表 + 自举存储（idempotency/bus_meta/event_outbox/bus_subscription）+ sec-bus-cli | `f6eef85` | ✅ 契约测试 33/33 全绿（本地 + csai setup 内双跑）；服务 active；总线域 registered；audit 可写；events jsonl 正常；调度循环无回归 |
| **1.2 vuln 域平移** | `@silksec/sec-domain-vuln` + `sec-backend-vuln-sqlite`：C1-C11 全动词（register_signal/register_candidate/confirm/reject/submit/note/claim/release/verify_replay/attach_fgs/authz_diff）+ Q1-Q6 查询，直接接管现 findings 表（ensureCol 幂等列演进 claimed_by/claimed_at/updated_at/remote_*），候选池状态机根治 + 订阅 exec.run.completed；总线补：R3 收窄至命令 schema（查询 status 过滤合法）、域错误码 retryable 透传、`idempotent_ctx_fields`（认领键含会话身份） | `7ed085c` | ✅ 契约测试 38/38 全绿（本地 + csai setup 内双跑）；服务 active；web 宿主面 vuln registered:true（bus.domain.registered 事件确认，11 命令/6 查询）；v4 口径无回归（signal=41/candidate.pending=2/terminal=25/total=68）；v5 只读查询真实库冒烟通过；列演进 6 列 + 2 索引幂等就位 |
| **1.3 双投影接线 + 兼容别名** | ToolProjector 注册 `vuln_*` 工具（域注册后再投影时序修复 + 名称去重）；RpcProjector `/silksec-domain` `vuln.*` 路由（rpcOperator 注入）；dashboard-rpc 三 case（findings/findingGet/findingUpdate）切 `vuln.*`（v4 直写兜底）；别名表填充：finding_add（按 actor 分派 + info 降级候选 + E_IDEMPOTENT_CONFLICT→v4 dup 形状）、finding_query（visibility 映射）、finding_update（status_router：confirm 缺 evidence 收紧 / accepted→submit / dup_of 自动填充 / 当前值+note→note）、submission_draft（待 report 域）；分派别名可带 domain/warn；不变量 ctx 透传（dupTargetValid 兼容期放宽）；bus.aliases.yaml + setup §D 校验改 ESM import | `b561e3f` | ✅ 契约测试 39/39（bus）+ 44/44（vuln）全绿（本地 + csai setup 内双跑）；服务 active；AGENTS.md secbus 区块自动含 vuln 动词（再投影生效）；aliases count=4；真实库冒烟：finding_query→vuln.list total=41、finding_update status=new→E_STATE、confirm 缺 evidence→E_EVIDENCE_REQUIRED+hint；口径无回归（signal=41/pending=2/terminal=25）；deprecated_use 审计在记；调度循环正常 |
| **1.4 Phase 0 正式版 + 试点验收** | `p-v5-1-migrate-vuln.js` 正式入 bundle（复跑 Phase 0 修复幂等 + ensureCol 6 列 2 索引 + updated_at 回填 + 三口径断言 + 迁移动作落 v5 audit kind:migration）；`p-v5-2-pilot-accept.js` 试点验收脚本（三路写同一候选 / audit actor 可区分 / 幂等重放，临时库隔离）；manifest 登记两脚本 | `48b97f3` | ✅ 契约测试 39/39（bus）+ 44/44（vuln）全绿（本地 + csai setup 内双跑）；服务 active；线上迁移 dry-run 零变更、首跑/复跑零变更幂等（--expect=41,2,25 硬断言过），audit 两条 migration noop 记录；试点验收本地 + csai 12/12 全绿（三路写同一候选最终一条信号行、candidates.total=stats.pending=看板徽章同源、webhook/script/model 三 actor 可区分、confirm 幂等重放 replay:true 同果）；真实库冒烟：vuln.stats signal=41/pending=2/terminal=25、vuln.candidates.total=2、finding_update status=new→E_STATE 收紧；aliases deprecated_use 在记（count=4）；调度任务 #16/#17（03:00 recon）+ #37/#19（04:00 vuln）9/5-9/7 连续三天 ok=1 正常收尾（handoff 产出），观测起点 2026-09-07 |
| **1.5 观察期复核** | 复核 9/7-9/9 三天 03:00/04:00 四任务链路（#16/#17 recon + #37/#19 vuln）全部 ok=1 收尾 + 候选池/信号面双口径对照 → 关账 1.4，放行 Phase 2 规划 | `0ff6dd5` | ✅ 9/7-9/9 四任务全 ok=1（9/9 #17 一次 OpenCode Go 计费故障 03:10 失败→05:23 自动重试恢复，非 v5 回归）；handoff 产物齐全（meituan-src/bytedance 9/7-9/9）；双口径一致 signal=42/pending=9/terminal=27（自然漂移 41/2/25 → 42/9/27），vuln.stats 与 vuln.candidates.total=9 与看板徽章同源；服务 active；aliases deprecated_use 在记（5 条） |
| **2.1 asset + endpoint 域** | `@silksec/sec-domain-asset`+`sec-backend-asset-sqlite`（asset_upsert/upsert_bulk/grade/state/fp_record/fp_record_bulk + asset_list/get/family/overview/fp_query/deep_queue）+ `@silksec/sec-domain-endpoint`+`sec-backend-endpoint-sqlite`（endpoint_upsert/queue_surface/consume_queue/mark_auth + endpoint_list/hosts/matrix/queue_status/surface_scan）；结构性闸门（评级列只经 grade / state 只经 state / 鉴权列只经 mark_auth）；总线 R2/R3 修复 + 7 分派别名路由器；dashboard-rpc 六读 case 切总线（v4 兜底）；ensureCol changed_at/graded_at + 评级/状态/接口鉴权索引 | `8df0e50` | ✅ 契约测试 asset 30/30 + endpoint 24/24 全绿（本地 + csai setup 内双跑）；服务 active；asset/endpoint 域 registered（bus.domain.registered）；真实库冒烟 asset.overview total=96,684 / deep_queue=51,207 / endpoint hosts=85 / queue_status 三项目 913+1+35；vuln 44/44 + bus 39/39 无回归；别名 deprecated_use 在记；资产准入纪律查询化（deep_queue 固化 where） |
| **2.2 fact + know 域** | `@silksec/sec-domain-fact`+`sec-backend-fact-sqlite`（fact_upsert/correct/deprecate/link/record_validation/bb_publish/transition/record_signal/reindex/purge_archive 十命令 + search/get/graph/overview/stats/neg_check/bb_read 七查询；生命周期列域内计算，memcore validateWrite 分支归零；facts.uses/last_used_at ensureCol + lifecycle/expiry 索引；治理通道 fact_transition 带 to）+ `@silksec/sec-domain-know`+`sec-backend-know-sqlite`+`sec-backend-know-file`（exp/kb/rules/vulncards/harvest 五子仓 21 命令 + 15 查询；语义去重 embedding 降级走 scenario 精确；kb url 去重 + taintguard + ±15 天复验抖动 + curated 行；INV-K8/K12 授权域/先验库物理闸）；总线 know 子仓豁免动词白名单 + to 治理豁免 + exp_validate_router；bus.aliases.yaml 填 blackboard_set/get + exp_validate；切流移除 asset-graph.js/experience.js 与域重名工具注册（fact_*/exp_*/kb_*/pb_* 由域 ToolProjector 零改名接管）+ dashboard-rpc fact/know 全 case 切总线（v4 兜底） | `5f13c76` | ✅ 契约测试 bus 39/39 + fact 22/22 + know 19/19 全绿（本地 + csai setup 内双跑）；服务 active；fact/know 域 registered（bus.domain.registered）；真实库冒烟 fact.stats total=800 edges=761 / fact.search total=663 / know_health exp=35 kb=391 rules=79 vulncards=18 / know.exp_list total=35 / know.rule_list rows=79；vuln/asset/endpoint 无回归（AGENTS.md secbus 区块全域在列）；别名 deprecated_use 在记 |
| **2.3 ledger 域** | `@silksec/sec-domain-ledger`+`sec-backend-ledger-file`（log_attempt/log_card_usage/radar_push/radar_drain/handoff_write 五命令 + attempts_list/coverage_report/radar_status/discipline_stats/pipeline_validate/task_proof/usage_query 七查询；六态台账/卡使用/雷达/交接包写入即机器校验：I2 reason 禁 other/misc、I3 evidence_path 存在性（v4 只查非空）、I5 deviation≥10 字、radar payload 专属键）；总线补 idempotent='none'（radar_drain 读后清空=天然幂等，每次新读不落幂等表）+ card_usage_router/coverage_report_router；bus.aliases.yaml 填 attempts_log/pipeline_validate/radar_read（static 直通）+ card_usage_log/coverage_report（dispatch 路由）；切流移除 sec-pipeline.js 5 个 ledger 工具注册 + dashboard-rpc ops case 切 ledger.discipline_stats（v4 兜底）；订阅 exec.run.completed（对账）/approval.approved（scope-approved 雷达入队）弱联动备案 | `8b85e80` | ✅ 契约测试 bus 39/39 + ledger 22/22 全绿（本地 + csai setup 内双跑）；服务 active；ledger 域 registered（bus.domain.registered commands=5）；真实库冒烟 attempts_list total=382(meituan-src)/437(bytedance)/2(dsh-ops)、coverage_report bytedance combos=288 cards=20、discipline_stats 台账日增量 bytedance 29/meituan-src 21 + card_usage_7d=77 + handoff_7d=15（idea_cards/scheduled_drift 跨域降级 unavailable，待 know/task 域补）；别名 deprecated_use 在记；vuln/asset/endpoint/fact/know 无回归 |
| **2.4 task + exec 域** | `@silksec/sec-domain-task`+`sec-backend-task-sqlite`（create/schedule/run_now/update_note/block/resume/cancel/finish/chain/budget_extend/claim/reap/worker_register/worker_finish/worker_reap/submit_complete/complete 17 命令 + list/get/next/stats/runs/scheduled/worker_list/worker_status/worker_recent/active_by_session/drift 11 查询；直接接管 tasks/task_runs/workers 表，interval latest-only 续期以 run_at 为锚防漂移，收尾权唯一归 task_finish[scheduler]/task_complete[approval]）+ `@silksec/sec-domain-exec`+`sec-backend-exec-file`（run_cli/spawn_worker/burp_import/report_bad_proxy/intel_hunt/flow_append 6 命令 + grep_result/page_result/plan_chain/manifest_list 4 查询；守卫链 G0-G9 fail-closed，parser 直写归零 proposal.json + exec.run.completed 回灌 asset/endpoint/vuln，explicit_only 幂等）；总线补 explicit_only 幂等策略 + update_note 禁用词豁免 + backend_transactional 非事务域（长时执行不占写锁）+ task_status_router（模型手动标 done 通道关闭）+ cwd 透传 + 查询错误码透传；bus.aliases.yaml 填 exec 纯改名（run_cli/spawn_worker/grep_result/page_result/plan_chain/intel_hunt/burp_import → exec_*）+ task 改名（worker_list/worker_status/scheduled_tasks → task_*）+ task_update 分派别名；切流停用 v4 task/exec 工具注册（asset-graph.js 7 + sec-suite.js 10，函数体留待删旧路径）；订阅 exec.worker.spawned/finished（强联动）→ task 域记账 | `b654b73` | ✅ 契约测试 bus 39/39 + task 20/20 + exec 11/11 全绿（本地 + csai setup 内双跑）；服务 active；task/exec 域 registered（bus.domain.registered commands=17/6）；真实库冒烟 task.scheduled=7 行（16/17/19/24/37/100007/100008 全在）、task.list active 非定时=3、exec.manifest_list=31、task.drift task_runs_last_age_hours=3；观察期 task 调度器休眠（v4 调度器持 scheduler.lock，03:00/04:00 每日链路不变）；别名已推送运行时副本（99 行）；vuln/asset/endpoint/fact/know/ledger 无回归 |
| **2.5 fgs 域** | `@silksec/sec-domain-fgs`+`sec-backend-fgs-sqlite`（fgs_add/start/complete/fail/block/deprecate/annotate/clear 八命令 + fgs_list/next/export 三查询；直接接管 fgs_nodes 表；状态机拆语义动词族 + fgs_update→fgs_update_router 分派别名 + INV-F1 任务 running 闸 + depends_on/parent_id 同任务校验）；订阅 task.finished（sync reactor 补记失败节点）+ prompt_hint 版本受控；fact 域 onFgsNodeDone 主通道 + onTaskFinished 补漏对账（persistFgsFacts 直写归零，fact_upsert 加 reactor actor）；ledger 域 task.finished 订阅 → fgs_export 追加 handoff（appendFgsToHandoff 直写归零 + appendHandoff 原语）；切流停用 asset-graph.js fgs_* 工具注册 + scheduler.js prompt 改语义动词 + task.finished 载荷补 note | `c847220` | ✅ 契约测试 fgs 19/19 全绿（本地 + csai setup 内双跑，全量回归 bus 39/vuln 44/asset 30/endpoint 24/fact 22/know 19/ledger 22/task 20/exec 11 无回归）；服务 active；fgs 域 registered（bus.domain.registered）；真实库冒烟 fgs_nodes=81、scheduled tasks=7、fgs/% facts=14；别名已推送运行时副本（31 条）；观察期 task 调度器休眠（v4 调度器持 scheduler.lock，03:00/04:00 每日链路不变）；vuln/asset/endpoint/fact/know/ledger/task/exec 无回归 |
| **2.6 scope + approval 域** | `@silksec/sec-domain-scope`+`sec-backend-scope-file`+`sec-backend-scope-sqlite`（scope_grant/revoke/exclude/rules_apply + program_bind_workspace/archive + cred_add 七命令 + scope_check/list/program_list/cred_query 四查询；scope.yml fail-closed 真相源 + programs 镜像自愈 + 通配自动配对裸域 + grant 吸收本项目排除 + I1-I8 不变量 + scope.rules.changed 事件替代 QPS mtime 轮询）+ `@silksec/sec-domain-approval`+`sec-backend-approval-sqlite`（approval_request/decide/withdraw + approval_list/stats/reconcile；七 kind 注册表 scope-wildcard/scope-domain/exclude-exception/tool-intrusive/task-budget-extend/knowledge-adopt/task-complete + approval_effects effect outbox；decide 幂等执行 scope_grant/rules_apply/task_budget_extend/task_complete/know_adopt + 发布 approval.approved 事件，onApprove 跨四域直写归零）；切流停用 v4 approval_request/program_list/cred_add/cred_query 工具注册（域 ToolProjector 零改名接管） | `1a96cb8` | ✅ 契约测试 scope 15/15 + approval 16/16 全绿（本地 + csai setup 内双跑）；服务 active；scope/approval 域 registered（AGENTS.md secbus 区块在列）；真实库冒烟 scope_check(api.meituan.com)=allow wildcard、scope_check(unknown)=fail-closed、approval_list total=7（v4 审批数据保留）；scope.yml 三项目（vulhub/meituan-src/bytedance）完好、findings total=78、scheduled tasks=19、programs=5 无回归；别名无新增（scope/approval 动词本就域前缀风格零改名） |
| **2.7（第一批）看板 scope/approval 六 case 切总线** | dashboard-rpc 六 case 改走 `deps.getSecDomainBus()` query/dispatch：scopeList→`scope.list`、scopeSaveProgram→`scope.grant`(+`scope.exclude`+`program.bind_workspace` 按表单字段分派)、scopeDeleteProgram→`scope.revoke`（先 scope.list 取全条目再整项目 revoke 归档）、programBindWorkspace→`scope.program_bind_workspace`、approvalList→`approval.list`(+pending 计数)、approvalDecide→`approval.decide`；v4 直写兜底（仅总线缺席/E_BUS_DOMAIN_UNKNOWN/E_BUS_VERB_UNKNOWN 回退，域业务错误不静默降级）；sec-suite.js 总线注入注释更新 | `6f070bb` | ✅ 契约测试 12 套 281/281 全绿（bus 39/vuln 44/asset 30/endpoint 24/fact 22/know 19/ledger 22/task 20/exec 11/fgs 19/scope 15/approval 16，csai setup 内双跑）；服务 active；scope/approval 域 registered；数据无回归（findings=78/programs=5/approval=7/scope.yml 三项目完好）；看板 scope/approval 读写走总线（v4 兜底观察期） |
| **2.7（第二批）report 域本体** | `@silksec/sec-domain-report`+`sec-backend-report-sqlite`（reports 索引）+`sec-backend-report-file`（data/reports/ 产物）；命令 report_build/report_draft_submission + 查询 report_list/report_read；frontmatter 权威元数据 + 索引可重建加速层 + 惰性 heal（孤儿索引行删/缺失索引行经 frontmatter 回填）；跨域读 vuln_list/get/stats/dedup_check + scope_program_list 校验 program；切流停用 v4 report_build/submission_draft 工具注册（report 域 ToolProjector 零改名接管 report_build + submission_draft 别名直通 report_draft_submission）；**R3 冲突裁决：report_build 的 status 过滤参数更名 status_filter**（总线 R3 禁命令 schema 顶层 status/to/state，查询谓词才豁免——12-report §1.3.1 原 status 参数属过滤语义，仅改名规避状态机私有命名，语义不变） | `b001a2c` | ✅ 契约测试 13 套 292/292 全绿（bus 39/vuln 44/asset 30/endpoint 24/fact 22/know 19/ledger 22/task 20/exec 11/fgs 19/scope 15/approval 16/report 11，csai setup 内双跑）；服务 active；report 域 registered（AGENTS.md secbus 区块含 report_ build/draft_submission）；数据无回归（findings=78/programs=5 含 1 archived/approval=7/interval tasks=7）；看板 reports/reportRead/reportBuild case 仍走 v4（db.buildReport 直写兜底，dashboard 批次切 RPC） |
| **2.7（第三批）proxy 域本体** | `@silksec/sec-domain-proxy`+`sec-backend-proxy-file`（file 后端单实现，owns {POOL_DIR} 五文件 pool/live/blocklist/stats/sticky + proposal inbox 只读）；命令 proxy_refresh/report_bad/sticky_bind + 查询 proxy_stats/list/gateway；落池算法照抄 13-proxy §1.3.1（blocklist/transparent 过滤→延迟升序→live 截断→sticky 失效清理→三文件 tmp+rename 原子写）；幂等域内文件态表达（idempotent:'none'：refresh=proposal sha / report_bad=blocklist 去重 / sticky=cache 复用）；总线补 proxy_refresh_router/proxy_get_router 分派路由器；bus.aliases.yaml 填 6 别名（4 static + 2 dispatch）；proxy_grade.py 拆纯计算段（--proposal-only 出 out/proposal.json）+ silksec-proxy-refresh.service ExecStartPost 落池链（sudo -u silkspool 防 root-owned events jsonl）；切流停用 v4 dsh-plugin-proxy-pool.js 6 工具注册（函数体留待删旧路径）；顺带修 proxy-pool-infra-setup.sh mubeng 版本检查 pipefail 误判（阻塞 arrange_files 部署 proxy_grade.py） | `c3870c2` | ✅ 契约测试 proxy 17/17 全绿（本地 + csai setup 内双跑）；服务 active；proxy 域 registered（AGENTS.md secbus 区块 proxy_ refresh/report_bad/sticky_bind）；真实链冒烟：timer 链 scraper→grade --proposal-only→sec-proxy-land 落池 v5 stats.json（total=202/live=145/blocked_applied=2/proposal_sha），proxy_stats writable=true rotator=active refresh_timer=active，sticky_bind 绑定+复用同出口，别名 proxy_pool_stats→proxy_stats 生效（runtime 别名副本已推送 15 处 proxy）；数据无回归（findings=78/programs=5/approval=10/scheduled=10 自然漂移）；全量回归 14 套无回归 |
| **2.7（第四批）eval 域本体** | `@silksec/sec-domain-eval`+`sec-backend-eval-file`（file 单后端，owns data/eval/ 整目录：eval-live.jsonl 原地接管零迁移、fp-cases.jsonl/contract-cases.jsonl 种子、runs/、fp/contract/range 报告）；命令 eval_case_append/eval_run_fp/eval_run_contract（三写动词模型禁入 INV-1）+ 查询 eval_stats/eval_cases/eval_reports（eval_stats 同名直传无别名，60s TTL 缓存）；订阅 vuln.signal.confirmed/rejected（async 弱联动，失败不阻断 vuln 命令主体）→ eval_case_append 回流，替代 v4 updateFinding 直调 appendLiveEval；异步执行载体=域内进程内执行器（LLM 走 Bellkeeper pool-secagent，SEC_EVAL_LLM_KEY/BELLKEEPER_API_KEY 零明文）+ runs/ 孤儿扫描（宿主重启标 failed 不自动续跑）；vuln_get 查询白名单补 reactor/system（跨域读使能）；切流移除 asset-db.js updateFinding 直调 appendLiveEval（函数体留待删旧路径）+ asset-graph.js 停用 eval_stats 工具注册（同名查询 ToolProjector 零改名接管，无别名成本） | `84af75f` | ✅ 契约测试 eval 16/16 全绿（本地 + csai setup 内双跑，全量回归 bus 39/vuln 44/report 11 无回归）；服务 active；eval 域 registered（bus.domain.registered commands=3/queries=3，AGENTS.md secbus 区块 eval_ case_append/run_fp/run_contract）；真实链冒烟 eval_stats.live.total=34（与 v4 eval-live.jsonl 原地接管一致，by_type 9 类聚合 + fp_rate）、eval_cases.total=34、eval_reports(range)=4（v4 eval-run.js 产物）；迁移种子 p-v5-1-migrate-eval.js 幂等（fp-cases/contract-cases 6 用例/runs/ 初始化，原地接管断言 34→34 行）；数据无回归（findings=78/signal=42/pending=9/programs=5/approval=10/scheduled=10 自然漂移）；看板 evalStats case 仍走 v4（dashboard 批次切 RPC，其余看板 case 待后续会话） |
| **2.7（第五批）看板其余 case 切总线** | dashboard-rpc 十四 case 逐批改走 `deps.getSecDomainBus()` query/dispatch（v4 兜底观察期）：taskRunNow/taskCancel→`task.run_now`/`task.cancel`、reportBuild→`report.build`（content 读回壳侧）、evalStats→`eval.stats`（live 直传）、audit→`bus.audit_tail`（总线收编+旧 client 形状映射）、programs→`scope.program_list`、tasks→`task.list`（active 桶默认 exclude 定时）、scheduledTasks→`task.scheduled`、taskRuns→`task.runs`、taskScheduleUpdate→`task.schedule`、taskSetStatus→拆 `task.block`/`task.resume`、taskCreate→`task.create`、reports→`report.list`（索引直出+size/mtime 回填+programs 分组）、reportRead→`report.read`；顺带补 report 域 v4 存量 heal 兜底（12-report §2.5：frontmatter 缺失→文件名正则+mtime+首行标题回退补行，31 份 v4 存量报告入索引） | `2bffe05` | ✅ 契约测试 14 套全绿（report 12/12 含新增 v4 heal 用例，全量回归无 fail）；服务 active；真实库冒烟 task.scheduled=4（24/37/100007/100008 非终态）、task.list active 非定时=3、task.runs total=133、scope.program_list=5、report.list=31（v4 存量全入索引）、eval.stats.live.total=43 与 v4 口径一致；看板 52 case 的自动投影 41 + 拆分映射 4 全部收口（剩 stats/ops/memcore/sessions/workspaces 五壳聚合端点为壳插件 Phase D0/D1 职责） |
| **3.1 部署验收命令集** | `sec-v5-accept.sh` 只读幂等部署验收脚本（18-migration §五「部署验收命令集」契约化）：R0 基础健康（6 systemd 单元 active + data-quality.py --json + data/AUTHORITY.md + data/events/ + web/headless 双 profile --dump-config 含 sec-domain-bus 与全部 14 域）+ R4 owns 唯一性（14 域插件在 plugins/ 齐全，域被拒载则缺投影）；`--json` 出机器可读报告、退出码 0/1。manifest 登记入 bundle | `5b74ccd` | ✅ 线上 25/25 全 PASS（6 单元 active / data-quality exit 0 / AUTHORITY 存在 / events 目录存在 / 双 profile dump-config 15 插件全在 / 14 域插件齐全）；`--json` EXIT=0；服务 active；findings=78 无回归 |
| **3.2 事件可靠性回放演练** | 线上演练验证 dispatcher 崩溃恢复 + `bus_replay` 回放恢复；演练暴露并修复两处弱联动投递缺陷：① `bus_subscription` 订阅者键由 `pattern` 改为 `source::pattern`（修多域订阅同一事件模式互相覆盖——`exec.run.completed` ×5 / `approval.approved` ×2 / `task.finished` ×2 原先仅首个被投递）；② dispatcher 首 tick 加启动宽限期（默认 3s，防宿主重启时域未注册即扫 pending 把待投递事件误判无订阅者而丢投递）；`sec-bus-cli.mjs` 补齐 14 域加载（`dispatch`/`query`/`bus.replay` 具备真实订阅者，01-bus §1.8 human 应急通道落地）；契约测试 +2（多订阅者各自投递 / 启动宽限期），总线套 39→41 全绿 | `f64227b` | ✅ 演练两步全过：① stop silksecagent→注入合成 `exec.run.completed` pending→start 后 dispatcher 续扫恢复，5 订阅者（asset/endpoint/know/ledger/vuln）各自独立 `X::exec.run.completed` delivered + jsonl 留痕 1 行；② 删 5 条消费记录 + outbox 置 dead_letter → `bus_replay` 回放 redispatched 恢复 5 条订阅记录 delivered；服务 active；findings=79 无回归；15 域 registered、outbox pending/dead=0、degraded=null；interval 定时任务 16/17/19/24/37/100005 完好、scheduler.lock 持有无扰动 |
| **3.3 memcore 完全旁路化** | `dsh-plugin-sec-memcore.js` 重写为纯总线客户端：remove `loadDb`（asset-db getDb）+ 全部 5 域表裸 SQL（transition/selectRow/deleteRow/updateStatus/recordSignal/computeScore/sweep 循环/exportVault/verifyExpRefs/guardBlackboardSnapshots/migrateStock/backfillKbRevalidate/migrateBlackboardSnapshots），生命周期流转经 `fact_transition`/`know_transition`/`fact_purge_archive`/`know_purge_archive`，信号经 `fact_record_signal`/`exp_feedback`/`exp_record_usage`/`kb_record_usage`/`kb_revalidate`，AGENTS.md 区块读走 `exp_rank`/`fact_bb_read`，status 读走 `fact_stats`/`know_health`/`fact_overview`；secMemoryLifecycle 服务同步提供（v4 fallback 兼容）+ 注入 secDomainBus 后启 sweeper；顺带修 fact/know 后端 `ensureArchive` 幂等列同步（facts_archive 缺 uses/last_used_at、exp_cards_archive 缺 kind/runs/successes/exportable 等 archive 表列漂移）、fact/know/task 查询 actor 白名单补 system、exp_list/kb_list 投影补 status_at/mem_class/scope、fact listFactsWhere 上限 500→5000 | `db80500` | ✅ `grep -c 'prepare('` 线上 = 0（69 处裸 SQL 归零）；契约测试 bus 41/41 + fact 22/22 + know 19/19 全绿（本地 + csai setup 内双跑）；服务 active；首跑 sweep 完成 `{archived:12, cooling:0, purged:0, lintHits:0}`（12 条过期 ephemeral note/recon 归档，archive 表列漂移修复后不再抛错）；facts=797（809→797，12 归档）/findings=80/scheduled tasks 16/17/19/24/37/100007/100008 完好无扰动；vuln/asset/endpoint/fact/know/ledger/task/exec/fgs/scope/approval/report/proxy/eval 无回归 |
| **3.4 各域删旧路径** | Phase 2 各域「函数体留待删旧路径」的 v4 直写残留清理（观察期 1 个调度周期满逐个删除）：asset-graph.js 删 18 个 `false && reg()` 停用注册块（submission_draft/report_build/program_list/task_*/eval_stats/cred_*/fgs_*）+ execCwd 死函数；sec-suite.js 删 11 个 `false && register()` 停用块（run_cli/grep_result/page_result/burp_import/spawn_worker/worker_status/worker_list/plan_chain/task_chain/intel_hunt/approval_request）+ 孤儿函数 runCli/grepResult/pageResult/resultFile/xmlTag/burpImport/spawnWorker/workerStatus/intelHunt/approvalRequest 及独占 scope-guard/sandbox/QPS helper（checkRisk/verifyResolved/findWriteVerbHit/throttleQps/buildSandboxCommand 等）+ 移除 parsers/planChain/taskChain/dns/http 未用 import；proxy-pool.js 删 6 个 proxy_pool_* 停用注册块 + 死函数（toolStats/toolGet/toolList/toolReportBad/toolRefresh/toolGateway + 数据访问 helper），收为无操作壳；sec-pipeline.js 删 5 个 ledger 工具函数体（toolAttemptsLog/toolCardUsageLog/toolRadarRead/toolPipelineValidate/toolCoverageReport）+ validateFile/SCHEMA_MATCH/TS_RE/readTsv/tsvAppend/TSV_HEADERS/makeRunId/RESULT_ENUM/BANNED_REASON 死 helper；asset-db.js 删 appendLiveEval + 6 个死函数（submissionDraft/taskNext/taskStats/credAdd/credQuery/fgsNextStep）。保留：authz_diff 工具 + runWorker/pidAlive/调度器 + dashboard-rpc v4 兜底 + 审批中心 + evalStats（dashboard-rpc 兜底）+ experience.js 底层函数（kbVaultSync 等内部调用方仍走 v4 路径，保留） | `ff90051` | ✅ 5 文件 -1929 行（20+ 增/1929 删）；契约测试全绿（proxy 17/17 + eval 16/16 等 setup 内双跑）；服务 active；线上验收 `sec-v5-accept.sh` PASS=25 FAIL=0；findings=80 / scheduled tasks 7（16/17/19/24/37/100007/100008）无回归；authz_diff 存活、调度循环正常启动、vault 回流正常（skipped_existing=312）；silksecagent-edge 曾 inactive（11:58 UTC 干净退出，会话前既有，已重启恢复）；vuln/asset/endpoint/fact/know/ledger/task/exec/fgs/scope/approval/report/proxy/eval 无回归 |
| **4.1 http-remote 后端试点（vuln 域）** | `@silksec/sec-backend-vuln-http`：repository-http + 本地 sqlite overlay 混布（候选池留本地、信号面 outbox 异步同步远端）+ 能力矩阵（纯模式 register_candidate/claim/release 三动词 unsupported）+ 同步器（独立 DatabaseSync 连接、remote_id/remote_synced_at 回写、指数退避 30s/2m/10m/1h/6h/24h ×8 封顶、远端 4xx→sync_state=failed 不再重试、网络失败退回 pending、E_BACKEND_UNAVAILABLE 混布命令本地成功不阻断业务）；同步边界在域 commands 层 `repo.markSyncPending?.(id)`（register_signal/confirm/reject/submit/note 信号面写后标记，claim/release/verify_replay/attach_fgs/register_candidate 不同步）；`buildVulnDomain` 后端选择（`SEC_DOMAIN_VULN_BACKEND=sqlite-local\|http-remote` 一行切换）+ 总线 `registerDomain` 读取 `backend.name` 报告真实后端 + sqlite 后端补 name + `statsFindings` 真实 sync 统计；契约测试 `contract-vuln-http.test.js`（mock 远端 REST）混布 happy path / 同步回写 / 纯模式能力矩阵 / 降级退避重试 / 4xx failed / 查询路由本地镜像 | `5a85fe2` | ✅ 契约测试 53/53 全绿（vuln sqlite 44 + http 9，本地 + csai setup 内双跑，bus 41 无回归）；服务 active；线上切换演练：sqlite-local（默认）→ `.env` 加 `SEC_DOMAIN_VULN_BACKEND=http-remote` 重启 → journal/`bus.domain.registered` 报告 backend=http-remote + 同步器启动 → CLI 登记测试信号 → 同步器 30s 内推 mock 远端 + `remote_id=demo-remote-1` 回写 + `sync_state=synced` → `vuln.stats.sync` 反映 → 删测试行 → 还原 `.env` 重启 → backend=sqlite-local + findings=80 无回归；`sec-v5-accept.sh` PASS=25 FAIL=0；scheduled tasks=19 无扰动 |
| **5.1 prompt 体系全量改写** | persona 7 角色（seed-presets.sh）工具引用 → 新动词（run_cli→exec_run_cli / spawn_worker→exec_spawn_worker / finding_add→vuln_register_signal / endpoint_query→endpoint_list / proxy_pool_*→proxy_* / 写黑板→fact_bb_publish 等），PERSONA_VERSION 4→5；7 个 SKILL.md + rules/src/{technique-index,asset-scoring,severity-rating}.md + VC-016 工具引用收敛；`task_update status=done` 旧通道 → 调度器 task_finish 自动收尾语义；新建 `p19-tool-refs.py`（tasks objective SQL 改写，p14 模式，边界感知幂等可重跑，41 对映射）+ manifest 登记 | `ce3bb8a` | ✅ 线上 12 个任务 objective 改写完成（interval + 历史 once），p19 复跑零变更（幂等）；全 prompt 资产悬空旧工具引用 = 0（persona/skills/rules/objective 边界感知扫描）；persona 7 角色重建至 v5（含 exec_run_cli/exec_spawn_worker/fact_bb_publish）；`sec-v5-accept.sh` PASS=25 FAIL=0；服务 active；findings=80 无回归；scheduled tasks 4（24/37/100007/100008）无扰动 |
| **5.1 残余修复 + 5.2 观察期启动** | 修复 5.1 边界感知扫描漏掉的代码内硬编码旧工具名：`dsh-plugin-sec-domain-task.js` onScopeGranted / `dsh-plugin-sec-suite.js` enqueueScopeSeed 两处审批种子任务 objective（radar_read→ledger_radar_drain、attempts_log→ledger_log_attempt、store:asset-graph→asset_upsert/endpoint_upsert）+ asset 域 agent_note（radar_read）+ ops 提示（attempts_log），消除确定性 deprecated_use 来源；核实现场 deprecated_use 共 104 条、最近 2026-09-11T12:00 UTC（仍在活跃使用）→ **5.2 别名删除不满足「7 天零使用」前置，本次不删**，进入观察期（起点 2026-09-11，闸口 ≈ 2026-09-18） | `1ac5db6` | ✅ 契约测试全绿（setup 内 14 套无 fail）；服务 active；`sec-v5-accept.sh` PASS=25 FAIL=0；bus_status aliases=37（20 静态 + 17 分派）、15 域 registered；findings=80 无回归；别名清单/契约测试/ToolProjector 未动（观察期不删） |
| **5.2 观察期复核（一）** | 复核 2026-09-11 当日 `data/audit.jsonl` deprecated_use 计数：累计 104 条（起始 2026-09-07）、观察期（≥2026-09-11 00:00 UTC）内 8 条、最新 2026-09-11T12:00:54Z；by cmd：run_cli 62 / coverage_report 7 / page_result 6 / attempts_log 5 / grep_result 5 / proxy_pool_stats 4 / finding_update 3 / pipeline_validate 3 / finding_query 2 / radar_read 2 / spawn_worker 2 / blackboard_get 2 / proxy_pool_list 1，actor 含 model + dashboard → **不满足「连续 7 天零使用」前置（今日仅观察期第 1 天且当日即 8 条），本次不删**；别名清单（20 静态 + 17 分派 = 37，运行时副本与模板一致）/ 契约测试 / ToolProjector 未动；观察期顺延，新闸口以最后一条 deprecated_use 2026-09-11T12:00Z 为锚再计 7 天零使用 ≈ 2026-09-18 | `90c1d2b` | ✅ 服务 active（`systemctl is-active silksecagent`=active）；bus_status aliases=37（20 静态 + 17 分派）与 `bundles/dsh/templates/bus.aliases.yaml` 一致；findings 无回归；deprecated_use 观察继续（纯复核，无代码改动无部署） |
| **5.3 worker 挂载矩阵 + owns×sandbox 交叉断言** | ① 总线 ToolProjector 增 profile × phase 挂载矩阵（17-llm-surface §1.6 规则 6）：headless worker 按 `SEC_WORKER_PHASE` 只注册「跨 phase 基础设施（bus/task/exec/fact/know/ledger/fgs）+ 本 phase 核心域」动词，web 会话全量豁免，phase 空/未知 fail-open 全量；核心域映射以 §2.5 为基并按 5.1 改写后的 objective 实测回填（recon→asset/endpoint/proxy、vuln→vuln/asset/report、review→∅、biz-logic→endpoint、code-audit/intranet 补）。② `exec_spawn_worker` 增 phase 参数 + `runWorker`/scheduler 透传 `SEC_WORKER_PHASE` 到 worker env。③ `bus_status` 增 mount（phase/subset/mode）观测。④ 新增 `sec-owns-sandbox-check.mjs`（owns×sandbox 交叉断言）+ setup.sh §E 冒烟 fail-closed：各域 owns.tables/files 推导物理路径断言 ∉ bwrap 可写 bind（$HOME）白名单 | `7594f7d` | ✅ 契约测试 bus 45/45（含挂载矩阵 4 用例）全绿（本地 + csai setup 内双跑，14 域全量无回归）；服务 active；`sec-v5-accept.sh` PASS=25 FAIL=0；setup §E 交叉断言 PASS（67 项/14 域零违规）；实测 mount：vuln→[bus/task/exec/fact/know/ledger/fgs/vuln/asset/report]、recon→[+asset/endpoint/proxy]、review→[横切 7 域]、empty→full；findings=80、scheduled interval 4（24/37/100007/100008）无扰动 |
| **5.4 eval 契约合规用例上线** | ① `vuln_confirm` evidence 改可选 schema + 不变量重排（evidenceExists 先于 findingExists）：缺证据确定性返回 E_EVIDENCE_REQUIRED（引导性 hint「先取证」），不再因 finding 不存在误报 E_NOT_FOUND——EC-02「无证据确认」可确定性断言。② contract-cases 种子扩至 EC-01~05 + 附例（confirm-no-evidence/model-direct-candidate/freeform-status-update/approval-self-decide/scope-grant-forgery + info-severity-signal/note-on-missing-finding 共 7 用例，全确定性不依赖生产数据；expected_hint_contains 对齐网关实际行为），迁移脚本按内容哈希 reconcile 幂等传播（新增/修订用例自动覆盖旧副本）。③ `eval_run_contract` 执行器新增 `expected_hint_contains` 断言（错误码 + hint 双重判据——越权 100% 被拒 + hint 可引导）。④ 契约测试新增「真实执行器 + 真实 vuln/approval/scope 域」跑 EC-01~05（不 mock 网关）+ 逐用例错误码/hint 断言。⑤ 新增 `eval-contract-run.js` 真实管线 runner（eval-run.js 风格，Mode A 确定性，无 LLM 成本，可安全并发于运行中服务） | `cb46d86` | ✅ 契约测试 eval 18/18（含 2 个 EC-01~05 新用例）+ vuln 54/54 全绿（本地 + csai setup 内双跑）；服务 active；真实管线跑 `eval-contract-run.js` 全 14 域注册 + Mode A 7/7 pass（越权拒绝率 100%），`eval_stats.last_contract={pass:7,total:7,pass_rate:100}` 已回灌；`sec-v5-accept.sh` PASS=25 FAIL=0；findings=80（signal 44 + terminal_in_pool 36）无回归；contract-cases 由 2 用例 reconcile 至 7 用例、eval-live 43 行原地零迁移 |
| **5.5 discipline-audit.py 增「悬空工具引用」断言** | `discipline-audit.py` 增第 6 指标「悬空工具引用」（17-llm-surface §3.3 / 宪法 §十五.4 执行点）：解析域 manifest JS（`dsh-plugin-sec-domain-*.js` commands+queries 键）+ `data/bus.aliases.yaml`（aliases+dispatch_aliases）+ 独立工具（authz_diff/asset_graph/browser_*）构成当前挂载矩阵（190 动词 + 37 别名 + 14 独立 = 241）；扫描 persona（.agent-presets/*/agent.cordis.yml 的 text 块）/ skills/*/SKILL.md / rules/**/*.md / tasks objective 全部 prompt 资产，token 命中工具命名空间前缀且不在挂载矩阵 → 悬空引用（含已删除旧别名），告警 + 退出码非 0，进周复盘 #24；边界感知（persona 只扫 text 块、字段后缀/非工具 token 豁免防误报：vuln_type/proxy_pass|cache|host/exp_cards/approval_hint 等）、只读幂等可重跑。**顺带修复 5.1 遗留 bug**：p19 映射 `fp_add→asset_fp_record`（错）/`fp_query→asset_fp_query`（错，fp_query 本零改名）→ 改为 `fp_add→fp_record` + 删 fp_query 行；并修正 3 处已写坏的悬空引用（skills/sec-knowledge asset_fp_record→fp_record、tasks #4 asset_fp_record→fp_record、tasks #37 asset_fp_query→fp_query） | `4371ebc` | ✅ 线上全 prompt 资产悬空引用 = 0（`dangling_tool_refs:[]`，`tool_surface={verbs:190,aliases:37,valid_total:241}`，EXIT=0）；服务 active；findings=80 无回归；scheduled interval 4（24/37/100007/100008）无扰动；`sec-v5-accept.sh` PASS=25 FAIL=0；契约测试 setup 内 14 套全绿；DB 修正 2 任务幂等（asset_fp_* → 语义动词）；discipline-audit 其余 5 指标照常（card_usage_7d=70/handoff_7d=13/调度漂移 0） |
| **5.6 复评「单写者守护进程」** | 18-migration §七 bullet 6 复评（只读核查，无代码改动无部署）：判定 Phase 1-5（2026-09-07 上线至今）跨进程写冲突是否频发。数据源三路核查：① `grep -c E_CONFLICT audit.jsonl` = **0**，error_code 分布无任何 E_CONFLICT/E_BUS_CONFLICT（E_ACTOR_FORBIDDEN 50 / E_SCHEMA 19 / E_EVIDENCE_REQUIRED 14 / E_NOT_FOUND 8 / E_STATE 2 / E_LEDGER_EVIDENCE_MISSING 2 / E_BUS_STRONG_LINK_FAILED 2 / E_VULN_INFO_SEVERITY 1 / E_PROXY_NO_PROPOSAL 1 / E_EXEC_TEMPLATE_PARAM 1 / E_EXEC_SCOPE_DENIED 1）；② `grep -c 'SQLITE_BUSY|database is locked' audit.jsonl` = **0**（全 data/ 仅 2 处 `.pre-split` 备份源码字符串字面量，非运行时痕迹），bus 域 journal `events/bus.jsonl` 1800 行 0 冲突痕迹；③ `event_outbox` 2135 行全 `delivered`、`retry_count=0`、无 pending/dead_letter/failed（无并发写导致的投递劣化），`bus_meta` replay.watermark=0、15 域 seen version=1，`journal_mode=wal`。**结论：无 E_CONFLICT 频发 → 维持多进程 + SQLite WAL 终态，不启动单写者架构专项** | `5e94839` | ✅ 服务 active（`systemctl is-active silksecagent`=active）；`sec-v5-accept.sh` PASS=25 FAIL=0；findings=80 无回归；event_outbox 零死信零重试；WAL 终态确认（纯文档复评，无线上改动） |
| **5.7 总线/原子化审查修复** | ① 移除 v4 `asset-graph` 的 `fp_query` 注册，模型工具面由 v5 asset 域 QueryProjector 零改名接管，消除 ToolProjector 冲突与旧直连路径；② FGS `task.finished` 由“名义 sync + 实际 best-effort”改为 async 弱联动（outbox 重试/死信，不回滚任务事实）；③ 总线新增 R8 事件命名校验（发布域前缀 + 至少两段，允许子对象多段）与 R9 `bus_status.event_contract.dangling_subscriptions` 对账，契约测试覆盖；④ 移除 `authz` 叙述别名伪域，授权域唯一注册名固定 `scope`；⑤ exec 删除无效 `scope.rules.changed` sync 订阅（QPS cap 每次读取对齐，跨进程无生效假象）；⑥ 修复 `task_run_now` 自动幂等吞写——改为 `none`，失败回 queued 后允许人工重跑（认领层原子流转防重复）；⑦ 同步前一日未收口修复：eval 异步收尾统一 `eval_run_finish`、scope grant/revoke 取消吞写 auto 幂等、worker truth 走 spawn 返回值、task 守卫改 ledger 查询、事件子仓命名修正 | `00173d0` | ✅ 本地 bus 59 + 14 域契约测试全绿；csai setup 内 14 域 + owns×sandbox 67 项全绿；最终重启后 14 域 registered、`fp_query already registered` 消失、启动无 E_BUS/投影错误；`sec-v5-accept.sh` PASS=25 FAIL=0；部署态 9 个受影响域契约测试 204/204（bus 47 + asset 30 + endpoint 24 + eval 18 + exec 11 + fgs 19 + know 19 + scope 15 + task 21）；R9 dangling=[]；event_outbox/bus_subscription 全 delivered、pending=0/dead_letter=0；4 个活跃定时任务（24/37/100007/100008）重跑全部 done/exit 0 并回 queued，100007 首轮因外部模型 `reasoning_content` API 400 失败，修复幂等后第二轮 `wmty04fc004da` done/exit 0 |
| **5.8 全域深度审查与文档回填** | 逐域审查 15 个业务域 + 总线、17 个后端/横切插件、20 个安装器与 18 份 v5 文档；在 00-17 文档逐域补“2026-09-12 深度审查结论”，覆盖逻辑/功能/性能/静默错误/未实现/hook 兼容层/独立升级七维。修正文档漂移：ledger/asset/endpoint/scope 事件全名、FGS async 弱联动、eval 内部 `eval_run_finish`、task `task_drift`、approval 统计未实现、report scope 软校验、know FTS best-effort、dashboard 插件化未实施。结论：15 个域包边界均具备单域升级条件，但 bus 更新需全量回归，当前操作仍走全量 bundle setup；dashboard 与 v4 scheduler 是原子化主要债务 | `3eb2da9` | ✅ 静态审计 + manifest/文档对账完成（14 域 commands/queries/events/subscribes 全覆盖）；未修改业务代码；部署态契约测试 347/347（bus 47 + 14 业务域 300）；`git diff --check` 通过 |
| **UI-0 看板 UI 原生面升级前置硬闸：dashboard-rpc 去 v4 兜底** | 清除 `dsh-plugin-sec-suite.dashboard-rpc.js` 全部 `v4 兜底`：新增 `busOrThrow/busError/busQuery/busDispatch` 四个 fail-closed helper，把 50 个业务端点从「总线优先 + 总线缺席/域动词未知/查询异常即直调 assetDb」改为「业务读写唯一入口 = 领域总线」；`findingUpdate` 分派别名、`expFeedback/expPromote/expDeprecate/expUpdate/expExportable` 五处 L4 已 fail-closed 端点统一收口到 helper（域错误码/hint 透传不再被吞成「需要总线」）；删除随兜底失效的 `knowledge-coverage.py` 现场生成兜底（`COVERAGE_FRESH_MS/locateCoverageScript/runCoverageScript` + `child_process.spawn` import）；纯壳聚合端点 `stats/workspaces/sessions/memcore` 保留壳内实现。新增 4 例契约测试 `dsh-plugin-sec-suite.dashboard-rpc.test.mjs`（总线缺席 fail-closed / 域错误码+hint 透传 / 总线可用且零 assetDb 泄漏 / 壳端点不受门禁） | `e9dd1f1` | ✅ 本地单测 4/4 全绿；`node --check` 通过；`grep -c "v4 兜底"` 归零（仅注释留档）；assetDb 调用仅剩 `stats` 壳端点与 `taskChain` 宿主 helper；2026-09-18 P0 部署时一并 rollout（线上 `grep -c "v4 兜底"`=4，仅注释/错误串） |
| **P0 看板 UI 原生面地基：`@silksec/ui-core` + 11 视图原样登记** | 建 `@silksec/ui-core` 双面包（宿主 no-op index + `window.__ModuleLoader__.load` client bundle + patch.yml + setup 脚本，manifest/setup 编排先于 sec-dashboard）：token 引用表（复用旧 client 的 T/F，零颜色字面量仅 SEV_COLOR fallback）/ `SilksecErrorBoundary`（class；崩溃渲染 EmptyState + `bus.audit_tail` 口径记录带 surface + `window.__silksecSurfaceHealth` 打卡）/ `useRpc`·`usePagedQuery`（rpc 可注入）/ `secUiBus` 微事件 / 视图注册表（`secDashboardViews` 等价物，注册/卸载幂等 + 动态订阅）/ 共享组件（Toolbar·EmptyState·DocModal）；旧 `sec-dashboard` client 在 `dsh.client.inject` 声明 `@silksec/ui-core` 后跨 bundle require 并把 11 视图（findings/assets/endpoints/facts/tasks/knowledge/learning/reports/approvals/scope/audit）原样登记进注册表，旧 Modal 渲染路径零改动；`bundles/dsh/doc/ui-surface-deps.yaml` 首版（逐面槽/服务/primitives/图标 + verified DSH 0.1.5-rc.2）；验证 §九 #5 跨 bundle require 可行（dsh-client-modules boot 图 inject 语义） | `3ed10de` | ✅ 本地 `node --check` + `node --test` 6/6 全绿（ErrorBoundary 只炸单面 / 注册表幂等 / 跨 bundle 登记 11 视图）；csai 部署后组合树含 ui-core、sec-dashboard inject 含 `@silksec/ui-core`、client bundle 均 HTTP 200；线上 dashboard-rpc 冒烟 20 读全 ok + taskCreate→taskCancel 写往返 ok + 负向写返回域错误/提示（audit actor=dashboard，不再静默降级）；shared browser scope 禁 localhost → 真机 DevTools 渲染留人工一步 |
| **P2 看板 UI 原生面审批套件：`@silksec/ui-approval`** | 建 `@silksec/ui-approval` 双面包（宿主 no-op index + client bundle + patch.yml + setup，setup.sh 8.6.5 编排 ui-core → ui-panel → **ui-approval** → sec-dashboard）：①`shell.overlay`（list/root）右下角常驻「待审批 · N」胶囊（warn 语义；ops 纪律告警绯红描边；点击自绘快捷浮卡 bg-layer-3，pending 逐条批准/驳回 + 判据悬停，底部「打开审批中心 →」调 `ctx.sidebarRight.openTab('silksec-approval')`）；②审批右侧栏 page tab：`ctx.sidebarRightTabs.register({ id:'silksec-approval-view', kind:'silksec-approval', priority:'extension', title, guide })` 阶段一 + keyed `sidebar.right.pane.tab` / `.title`（key=类型 id）阶段二，完整列表/筛选/留痕；③降级链：sidebarRightTabs 缺席 → 同视图注册 ui-core 注册表（主面板「审批 ·降级」），layout/主面板也缺席 → primitives Modal，shell.overlay 缺席 → secUiBus `approval:pending` 广播（footer.action 由 sec-dashboard legacy 单条持有不重复注册）；④数据统一走 `/silksec-dashboard` approvalList/approvalDecide（actor=dashboard + operator），与主面板写路径等价。**实测修正**：官方 API 为 `SidebarRightTabRegistry.register(definition)`（非 `registerType`）；`title(address)` 为 open 时捕获初值，动态计数另注册 keyed title 体 | `5880674` | ✅ 本地 `node --check` + `node --test` 10/10（注册幂等/卸载 disposer/计数一致性/三降级分支/快捷批准驳回 RPC 参数/primitives 缺席兜底）；csai 部署后组合树含 `silksec-ui-approval`、combo bundle 200 且含 ui-approval/ui-core/ui-panel；**真机无头**（MaintenanceClient 临时审批账号→登录→同进程还原 users.yaml→playwright）：胶囊可见且 `待审批 · 0` == approvalList.pending、打开审批中心 openTab 开右侧栏、stub 列表后胶囊 `待审批 · 2`、快捷批准/驳回发 approvalDecide（reject 带备注，路由拦截不落库）、`__silksecSurfaceHealth.ui-approval=ok`、零 console/page error；`sec-v5-accept.sh` PASS=25 FAIL=0；生产审批零变更（17/4 保持） |
| **P3 看板 UI 原生面任务套件：`@silksec/ui-task`** | 建 `@silksec/ui-task` 双面包（宿主 no-op index + client bundle + patch.yml + setup，setup.sh 8.6.6 编排 ui-core → ui-panel → ui-approval → **ui-task** → sec-dashboard）：①任务右侧栏 page tab：`ctx.sidebarRightTabs.register({ id:'silksec-task-view', kind:'silksec-task', priority:'extension', title, guide })` 阶段一 + keyed `sidebar.right.pane.tab` / `.title`（key=类型 id）阶段二；栏内四区块自上而下——定时任务卡片（IconAlarmClockOutline + next_run_at 相对时间 fmtRel）/ 一次性队列（Pill + StateDot）/ 工作区快块（窄栏降级为顶部 program 筛选 Pill 组）/ 执行历史（默认折叠 DisclosureRow）；`container-type:inline-size` + `@container (max-width:480px)` 栏宽自适应，表格 <480px 换卡片行；②会话头「本会话任务」计数：`conversation.session.header.utilities`（list/session，运行时 props 含 sessionId）图标钮 + 本会话活跃任务数，点击 `ctx.sidebarRight.openTab('silksec-task')`；③降级链：sidebarRightTabs 缺席 → 同视图注册 ui-core 注册表（主面板「任务 ·降级」），layout/主面板也缺席 → primitives Modal，会话槽缺席 → 不注册；④写操作统一走 `/silksec-dashboard` taskRunNow/taskCancel/taskSetStatus/taskScheduleUpdate/taskCreate（task.run_now/cancel/block/resume/schedule/create，actor=dashboard + operator），与主面板写路径等价。看板「任务」tab（id='tasks'）行为零改动、保留观察 | `b557402` | ✅ 本地 `node --check` + `node --test` 11/11（注册幂等/卸载 disposer/tab 标题计数/会话头按 sessionId 过滤/会话槽缺席降级/两降级分支/六写操作端点参数/四区块探测/响应式双模式/primitives 缺席兜底）；csai 部署后组合树含 `silksec-ui-task`、client combo bundle 200 且含 ui-task/ui-core/ui-panel/ui-approval、boot 注入 conversation/layout/sidebar-right；**真机无头**（MaintenanceClient 临时账号→登录→同进程还原 users.yaml→playwright 打开已有会话只读）：`__silksecSurfaceHealth.ui-task=ok`、会话头「本会话任务 · N」钮可见、点击 openTab 打开右侧栏任务 tab、四区块全渲染（定时卡片 6 / 队列表格 6 行 / 工作区 / 执行历史）、栏宽 700px 显表格 / 340px 显卡片行、行内 run_now 发 taskRunNow（路由 stub 不落库）、零 console/page error；`sec-v5-accept.sh` PASS=25 FAIL=0；生产任务/审批数据零变更 |
| **P4 授权迁设置页：`@silksec/ui-settings-scope`** | 建 `@silksec/ui-settings-scope` 双面包（宿主 no-op index + client bundle + patch.yml + setup，setup.sh 8.6.7 编排 ui-core → ui-panel → ui-approval → ui-task → **ui-settings-scope** → sec-dashboard）：①`settings.section`（list/root）注册「授权范围」整节（id=silksec-scope，order=200，label 函数形态走宿主 `resolveSlotLabel`）——program 列表（工作区徽章 / max_risk / 条目数 / 排除数）、scope.yml 条目管理（新增/编辑 `scopeSaveProgram`、移除 `scopeDeleteProgram`，原子写 + fail-closed 语义不变）、排除清单（表单字段分派 `scope.exclude`，排除例外仍走审批中心）、工作区绑定（行内 select → `programBindWorkspace`）、凭据引用状态（`/silksec-domain` 的 `scope.cred_query` 只读，只显示 ref 永不明文，无写路径）；②写操作与主面板「授权」tab 同端点同 actor（scopeList/scopeSaveProgram/scopeDeleteProgram/programBindWorkspace；actor=dashboard+operator 由壳/RpcProjector 注入，audit 留痕一致），busy 锁 + 失败 alert + finally reload，行内图标 + title 悬停；③降级链：`settings.section` 缺席 → 同一视图注册 ui-core 注册表（主面板「授权 ·降级」临时 tab，order 102/domain=scope），主面板/layout 也缺席 → primitives Modal（再缺席自绘 fixed 覆盖层）；主面板 legacy「授权」tab 行为零改动、保留观察（P4 不删）；④设置行样式复用宿主（与 theme 插件 settings.general.item 同款），零颜色字面量；⑤deps：官方 `settings.section` kind=list scope=root + owner `SettingsSectionOwnerProps{close}` 逐字核对；只消费 primitives Tooltip/Modal（Pill/StateDot/DisclosureRow/RiskConfirmation/HoverCard 延后），icons 走 ui-core opIcon | `22c8c98` | ✅ 本地 `node --check` + `node --test` 12/12（注册/卸载幂等 + 整节挂 settings.section / 四端点参数 + 路由分派 / settings.section 缺席→ui-core 注册表降级不抛 / primitives 缺席兜底 / 整节渲染 program+排除+凭据）；csai 部署后组合树含 `silksec-ui-settings-scope`、client combo bundle 200 且含 ui-settings-scope、boot 注入 settings/ui-core；**真机无头**（MaintenanceClient 临时账号→登录→同进程还原 users.yaml→logout，playwright 注入 cookie + 路由 stub）：设置页「授权范围」整节渲染 3 项目（vulhub/meituan-src/bytedance，含工作区徽章/上限/条目数/排除清单/已归档/凭据引用）→ 行内绑定发 `programBindWorkspace`（payload program_id=vulhub/workspace_id=日常，路由 stub 不落库，生产 programs 表 vulhub.workspace_id 保持 null、scope.yml 3 项目不变）、`__silksecSurfaceHealth.ui-settings-scope=ok`、零 console/page error；`sec-v5-accept.sh` PASS=25 FAIL=0；生产 scope.yml/审批数据零变更 |
| **P5 会话内绑定：`@silksec/ui-session`** | 建 `@silksec/ui-session` 双面包（宿主 no-op index + client bundle + patch.yml + setup，setup.sh 8.6.8 编排 ui-core → ui-panel → ui-approval → ui-task → ui-settings-scope → **ui-session** → sec-dashboard）：①`conversation.view`（list/session）注册 ViewTab `{ id:'silksec-security', label:'安全产出' }`，会话头出现平级视图页签，视图内按生产者 `session_id` 过滤本会话产出的漏洞/事实/任务/Run，行内 `ctx.sessions.open` 跳链 + 反向回路（`layout.selectPanel` 开看板 / `sidebarRight.openTab` 开审批）；②`conversation.session.header.utilities`（list/session）「安全产出」计数钮（= 本会话 findings + facts），点击 `selectView('silksec-security')` 官方会话视图切换 API（缺席降级 `secUiBus emit('open:security-view')` 不抛）；③`conversation.chat.assistant-actions`（list/session，owner `{messageId}`，additive）每条定稿 assistant 消息追加「登记候选漏洞」「沉淀事实」两动作，点击弹 primitives Modal 小表单（预填消息摘要）+ RiskConfirmation 二次确认（勾选 acknowledge + 确认写入）；④**写操作端点决策（实测修正 ⑥）**：`vuln.register_candidate` actor 白名单为 webhook/script、`vuln.register_signal` 为 model/human，看板 actor=dashboard 对二者均不可用且禁止改域动词——「登记候选漏洞」走 compat 分派别名 `/silksec-domain` `vuln.finding_add`（severity=info → register_candidate 候选降级，dashboard actor_bypass，审计 deprecated_use+via_alias 可区分），「沉淀事实」走 `fact.upsert`（actor 白名单含 dashboard），均经 RpcProjector actor=dashboard + operator；会话归属：finding/task/run 落 session_id 列直接过滤，fact 表无 session_id 列 → 写入时把会话 id 编进 `source=dashboard:session:<id>` 并据此过滤；⑤降级链：任一会话槽缺席 → 不注册该面（会话面无全局影响，不抛，不改主面板 11 视图），三槽全缺席仅 markSurfaceHealth=degraded；隔离 ErrorBoundary 本面包、零颜色字面量 | `e029af0` | ✅ 本地 `node --check` + `node --test` 17/17（三处 additive 注册/卸载幂等 + ViewTab{id,label}；会话头按 sessionId 过滤计数；assistant-actions 每 messageId 两动作；会话槽缺席不注册、不抛、主面板零变化；写操作端点/参数 + `/silksec-domain` 路由；primitives 缺席兜底；两会话数据交叉断言不混入）；csai 部署后组合树含 `@silksec/ui-session`、client combo bundle 200 且含 ui-session、boot 注入 conversation/chat/ui-core、`__silksecSurfaceHealth.ui-session=ok`；**真机无头**（MaintenanceClient 临时账号→登录→同进程还原 users.yaml→logout，playwright 注入 cookie + 路由 stub）：打开已有会话见页签 `对话/轨迹/费用/安全产出`、会话头钮「本会话安全产出 1 项（漏洞 1 / 事实 0）」、安全视图渲染本会话漏洞/事实/任务/执行（只出本会话 row）、消息动作两钮渲染、点「登记候选漏洞」弹表单填 host 后经 RiskConfirmation 发出 `POST /silksec-domain/vuln.finding_add`（severity=info，路由 stub 不落库，生产 findings 无 smoke.p5.example 行）→ 10/10 PASS、零 console/page error；`sec-v5-accept.sh` PASS=25 FAIL=0。**耦合备案**：本动作依赖观察期别名 `finding_add`，5.2 删别名须与本面协调（改受控候选通道或同步改端点） |
| **P1 看板 UI 原生面主面板：`@silksec/ui-panel` + 11 视图自足 wrapper** | 建 `@silksec/ui-panel` 双面包（宿主 no-op index + client bundle + patch.yml + setup，manifest/setup 编排 ui-core → ui-panel → sec-dashboard）：通用渲染器 `DashboardPanel` 消费 ui-core `viewRegistry.list()`（按 order）挂 `main` keyed 槽 + `sidebar.panellist` 导航行（`PanelIcon`），经 `ctx.layout.selectPanel('silksec-dashboard')`/`selectPanel(null)` 打开/返回，`beginNavigation()` AbortSignal 防快速连点竞态；页头/KPI 用 ui-core styles/T，每视图包 `SilksecErrorBoundary`（单面隔离）。sec-dashboard 11 视图登记由裸视图组件升级为**自足 wrapper**（`PanelView` 按 id 分派，内部自持 query/handler，复用旧 props 契约；视图文件不拆、行为不变），统一 prop bag `{rpc,workspaces,stats,approvals,memcore,ops,navigate,pending,reloadShared}`；跨视图跳链经 `navigate.select(id,pending)` 传递 q/filters。footer `SidebarAction` 行为改为 `panelSlotAvailable() ? selectPanel : 开 Modal`（能力探测 `layout.selectPanel` + `slots.entriesOfSlot('main')`），Modal 保留降级分支（`localStorage silksec.ui.dashboard.mode='modal'` 可强制回滚）。**实测修正**：keyed 槽只认 `options.key`（list 才认 `options.id`），原设计片段用 `id` 会导致整插件加载失败，已修并回写 16-dashboard/§deps | `a384fef` | ✅ 本地 `node --check` + `node --test` 13/13 全绿（ui-panel 7 例：注册幂等/registry 顺序渲染/beginNavigation 连点竞态/降级链 + ui-core 6 例无回归）；csai 部署 + 重启后 `--dump-config` 组合树含 ui-panel、client combo bundle HTTP 200 且含 ui-panel/ui-core/sec-dashboard 标记、boot 注入 ui-panel/ sec-dashboard 均 inject `@silksec/ui-core`；`sec-v5-accept.sh` PASS=25 FAIL=0；**真机无头浏览器冒烟**（MaintenanceClient 临时账号 + playwright，临时账号已还原）——11 tab 按序渲染、tab 切换、返回会话、footer→selectPanel、Modal 降级（11 tab）、`__silksecSurfaceHealth.ui-panel=ok`，零 console/page error |
| **旧版清理（2026-09-19，用户授权）** | 跳过并排观察，直接以新形态为准：① 删除看板旧单体 `@silksec/sec-dashboard`（`dsh-plugin-sec-dashboard.{client,index}.js`+`.patch.yml`、`-old` 视图、Modal 主形态、`sidebar.footer.action`），web profile 移除依赖，`sec-dashboard-plugin-setup.sh` 改为仅组装 7 域视图包；② 删除 v4 调度循环模块 `dsh-plugin-sec-suite.scheduler.js`+测试及其 import/装配/manifest 引用（唯一派单入口是 task 域内建调度器）；③ `asset-graph.js` 删九个 v4 直连 DB 工具（asset_add/query、endpoint_add/query、finding_add/query/update、asset_stats、fp_add），仅留独立工具 `asset_graph`；`sec-pipeline.js` 删旧原生工具（verify_replay/surface_scan/surface_queue，已由 vuln_verify_replay/endpoint_surface_scan/endpoint_queue_surface 接管）收为无操作壳；④ 删一次性消费脚本（backfill-program / migrate-blackboard-to-facts / migrate-scheduled-tasks / migrate-schedule-anchor / p-v5-0 / p-v5-1-migrate-vuln / p-v5-2-pilot-accept / import-cyberstrikeai）及 manifest 条目；⑤ 清主机旧构建产物（6 个旧 dsh-browser tgz、`sec-suite-plugin-asset-db-new.js`）。 | 验收：`spool bundle dsh setup csai` 域契约测试全绿 + 14 域 registered；`sec-v5-accept.sh` **PASS=39 FAIL=0**、`--ui-headless` **PASS=70 FAIL=0**（13 UI 面全 ok、RPC 读写往返、零 console/page error）；discipline-audit/data-quality healthy、悬空引用 0；7 个 interval 定时任务完好 | 保留：总线兼容别名层（5.2 观察闸口）、sec-suite/asset-db/experience 内部 v4 读取函数（experience 仍被 dashboard-rpc/task 链路引用，随 5.2 一并复评） |

---

## 三、待办节点（Phase 1，按顺序，每个节点 = 一次会话 = 一个可上线可回滚增量）

- [x] **1.1 `@silksec/sec-domain-bus` 骨架**：DomainRegistry / CommandGateway / QueryGateway / EventOutbox+Dispatcher / ToolProjector / RpcProjector / 幂等 / audit（fail-closed）/ 别名表 + 自举存储（idempotency/bus_meta/event_outbox/bus_subscription）。契约测试矩阵见 01-bus §2.8。**✅ 已完成**
- [x] **1.2 `@silksec/sec-domain-vuln` + `sec-backend-vuln-sqlite`**：从 asset-db.js 平移拆语义动词（register_signal/register_candidate/confirm/reject/submit/note/claim/release/verify_replay/attach_fgs/authz_diff + vuln_list/get/candidates/stats 等）。契约测试见 02-vuln §2.2。**✅ 已完成（只平移不切流：v4 写路径原样，双写观察期到 1.3/1.4 收口）**
- [x] **1.3 双投影接线 + 兼容别名**：ToolProjector 注册 `vuln_*` 工具（域注册后再投影时序修复）；RpcProjector 注册 `vuln.*` RPC；dashboard-rpc 的 findingUpdate/findingGet/findings case 切 `vuln.*`（v4 直写兜底保留至观察期）；别名 finding_add/finding_query/finding_update/submission_draft → 新动词（bus.aliases.yaml 已填充，status_router 扩展 accepted/note 分派 + finding_add_router + query_visibility_router 内建）。**✅ 已完成**
- [x] **1.4 Phase 0 正式版 + 试点验收**：p-v5-0-fix-noise.js 正式入 bundle；试点验收（三路写同一候选 / audit 三 actor 可区分 / 幂等重放 replay:true / 连续 3 天 03:00/04:00 任务正常收尾）。**✅ 已完成并关账（2026-09-07 上线；commit `48b97f3`；3 天链路观测经 1.5 复核通过后关账）**
- [x] **1.5 观察期复核（3 天后，1 次会话）**：2026-09-10 复核 9/7-9/9 连续 3 天 03:00/04:00 任务全部 ok=1 收尾（守卫过、handoff 出）+ 候选池计数与信号面一致 → 关账 1.4，放行 Phase 2。**✅ 已完成（9/7-9/9 四任务全 ok=1；双口径 signal=42/pending=9/terminal=27 与 candidates.total=9 看板徽章同源；已关账 1.4，放行 Phase 2 规划）**

## 三·五、待办节点（Phase 2，按 18-migration §四 顺序，每个节点 = 一次会话 = 一个可上线可回滚增量）

- [x] **2.1 `@silksec/sec-domain-asset` + `@silksec/sec-domain-endpoint`**：从 asset-db.js/asset-graph.js/sec-pipeline.js 平移拆语义动词（asset：upsert/upsert_bulk/grade/state/fp_record/fp_record_bulk；endpoint：upsert/queue_surface/consume_queue/mark_auth）+ 双后端 + 契约测试 + 别名 + dashboard-rpc 六读 case 切总线。契约见 03-asset.md §2.2 / 04-endpoint.md §2.2。**✅ 已完成（2026-09-10 上线；commit `8df0e50`；观察期 1 个调度周期后删旧路径）**
- [x] **2.2 fact + know 域**：fact 域（fact_upsert/link/search/get/reindex + 生命周期 mem_class）+ know 域（kb_import/kb_list/kb_read/harvest）。memcore 映射层随 fact/know 分两批迁（06-fact.md 映射表）**✅ 已完成（2026-09-10 上线；commit `5f13c76`；观察期 1 个调度周期后删旧路径——memcore 69 处裸 SQL 归零随 Phase 3 收口）**
- [x] **2.3 ledger 域**：雷达/台账/attempts/card_usage（sec-pipeline 8 工具直写 → ledger 命令，写入即校验；11-ledger.md）**✅ 已完成（2026-09-10 上线；commit `8b85e80`；观察期 1 个调度周期后删旧路径）**
- [x] **2.4 task + exec 域**：任务/调度/执行事件（exec.run.completed 是多个域的基础，parser 直写 → proposal 回灌；05-task.md / 10-exec.md）**✅ 已完成（2026-09-10 上线；commit `b654b73`；观察期 1 个调度周期后删旧路径——task 调度器休眠待 v4 调度器退役后启用）**
- [x] **2.5 fgs 域**：FGS 图节点（persistFgsFacts/appendFgsToHandoff 直写 → 事件协作）**✅ 已完成（2026-09-10 上线；commit `c847220`；观察期 1 个调度周期后删旧路径）**
- [x] **2.6 scope + approval 域**：scope.yml 白名单 + 统一审批中心（APPROVAL_KINDS 六 kind + task-complete；QPS mtime 轮询 → scope.rules.changed 事件；onApprove 跨四域直写 → approval.approved 事件 + effect outbox）**✅ 已完成（2026-09-10 上线；commit `1a96cb8`；观察期 1 个调度周期后删旧路径）**
- [x] **2.7 report / proxy / eval / dashboard 域**：报告导出/代理池/评测/看板 52 case 逐批切 RpcProjector。**✅ 看板 scope/approval 六 case 已切总线（commit `6f070bb`）；report 域本体已完成（commit `b001a2c`）；proxy 域本体已完成（commit `c3870c2`）；eval 域本体已完成（commit `84af75f`）；看板其余十四 case（task/audit/programs/report/eval 等）已切总线（commit `2bffe05`）——自动投影 41 + 拆分映射 4 全部收口（剩 stats/ops/memcore/sessions/workspaces 五壳聚合端点为壳插件 Phase D0/D1 职责）**

## 三·六、待办节点（Phase 3，按 18-migration §五 顺序，每个节点 = 一次会话 = 一个可上线可回滚增量）

> Phase 3 = 跨域事件化收尾。§五 bullet 4（eval 域订阅）已在 eval 域本体收口（commit `84af75f`）；approval 六 kind effect outbox 已在 approval 域收口（commit `1a96cb8`）。余下四子节点：

- [x] **3.1 部署验收命令集（R0/R4 契约化）**：`sec-v5-accept.sh` 只读幂等验收脚本（6 systemd 单元 + data-quality + AUTHORITY.md + events/ 目录 + 双 profile dump-config 含 bus+14 域 + 14 域插件齐全），`--json` 出机器可读报告。**✅ 已完成（commit 见 §二）**
- [x] **3.2 事件可靠性回放演练**：dispatcher kill/restart 后 outbox `pending` 续扫恢复 + 删一个 async 订阅者消费记录 → `bus_replay` 回放恢复（01-bus §2.2.5/§2.3）。**✅ 已完成（commit `f64227b`；演练暴露并修复多订阅者键碰撞 + dispatcher 启动宽限期两处弱联动投递缺陷）**
- [x] **3.3 memcore 完全旁路化**：`grep -c 'prepare(' sec-memcore` 仅剩自身迁移表（当前 69 处裸 SQL，须归零经 fact/know lifecycle 命令）。**✅ 已完成（commit `db80500`；memcore 重写为纯总线客户端，`grep -c 'prepare('` = 0；69 处裸 SQL 归零经 fact/know lifecycle 命令；顺带修 fact/know 后端 ensureArchive 幂等列同步——线上 sweep 连续抛「table facts_archive has no column named uses」的 archive 表列漂移根因）**
- [x] **3.4 各域删旧路径**：Phase 2 各域「函数体留待删旧路径」的 v4 直写残留清理（asset-db/asset-graph/sec-suite/sec-pipeline/experience 停用段），观察期 1 个调度周期满后逐个删除。**✅ 已完成（commit `ff90051`；asset-graph/sec-suite/proxy-pool/sec-pipeline/asset-db 五文件 -1929 行；experience.js 底层函数保留——kbVaultSync 等内部调用方仍走 v4 路径）**

## 三·七、待办节点（Phase 4，按 18-migration §六 顺序）

> Phase 4 = http-remote 后端试点（vuln 域）：把 vuln 后端切到外部漏洞管理系统（REST），asset/task/know/ledger 全链路无感知继续工作。

- [x] **4.1 `@silksec/sec-backend-vuln-http`**：repository-http + 能力矩阵（纯模式候选池三动词 unsupported → 本地 sqlite overlay 混布承接候选池）+ 同步策略（确认后推送远端 / 远端 ID 回写映射 / E_BACKEND_UNAVAILABLE 重试与降级 fail-closed）+ 契约测试三后端同套跑（sqlite/http）+ 切换演练（bundle 配置一行切换 + 回切）。**✅ 已完成（2026-09-11 上线；commit `5a85fe2`）**

## 三·八、待办节点（Phase 5，按 18-migration §七 顺序，每个节点 = 一次会话 = 一个可上线可回滚增量）

- [x] **5.1 prompt 体系全量改写**：persona/objective/skills/technique-index 工具引用 → 新动词表（脚本化 p19-tool-refs.py，p14 模式）；AGENTS.md 受管区块 manifest 生成（Phase 1 已收口，本节点确认）。**✅ 已完成（2026-09-11 上线；commit `ce3bb8a`）**
- [x] **5.2 删兼容别名 ✅ 已完成（2026-09-19，用户授权不等观察期）**：未再走「7 天零使用」三段式——`finding_add`/`finding_update` 是当时看板写路径承重结构，观察期无意义。**先迁调用方再删**：dashboard-rpc finding 状态流转直达 `vuln_confirm/reject/submit`；ui-session「登记候选漏洞」直达 `vuln_register_candidate`（actor 增 dashboard）；`bus.aliases.yaml` 清空（机制保留为通用能力）；配套删除 bus `finding_add` v4-dup-shape 幂等转译与 `finding_update` dup_of 自动填充/放宽、vuln `dupTargetValid` 恢复严格、eval 契约用例 `freeform-status-update` 删除（`confirm-no-evidence` 已覆盖证据闸门，见 15-eval §2.1）。审计实测 `aliases=0 / dangling=0 / deprecated=0`
- [x] **5.3 worker 挂载矩阵实施**：profile × actor 白名单；setup.sh 冒烟断言 owns×sandbox 交叉校验（17-llm-surface §1.6/§2.2）。**✅ 已完成（2026-09-11 上线；commit `7594f7d`）**
- [x] **5.4 eval 契约合规用例上线**：模型越权 100% 被拒 + hint 可引导（15-eval.md EC-01~05）。**✅ 已完成（2026-09-11 上线；commit `cb46d86`；真实管线 Mode A 7/7 越权拒绝率 100%，`eval_stats.last_contract` 回灌；vuln_confirm 缺证据收紧为 E_EVIDENCE_REQUIRED 引导性 hint）**
- [x] **5.5 discipline-audit.py 增「悬空工具引用」断言**（17-llm-surface §3.3 执行点）。**✅ 已完成（2026-09-12 上线；commit `4371ebc`；全 prompt 资产悬空引用 = 0；顺带修复 5.1 遗留 p19 fp 动词错误映射 + 3 处悬空引用）**
- [x] **5.6 复评「单写者守护进程」**：Phase 1-5 期间无 E_CONFLICT 频发 → 维持多进程+WAL 终态。**✅ 已完成（2026-09-12 上线；commit 见 §二；E_CONFLICT=0、无 SQLITE_BUSY、event_outbox 2135 全 delivered 无死信 → 不启动单写者架构专项）**
- [x] **5.7 总线/原子化审查修复**：`fp_query` 冲突、FGS sync/async 语义、事件命名校验、悬空订阅对账、`authz` 伪域与无效 exec 订阅收口。**✅ 已完成（2026-09-12 上线；commit `00173d0`）**
- [x] **5.8 全域深度审查与文档回填**：14 业务域 + 总线/后端/横切插件逐项检查逻辑、功能、性能、静默错误、未实现分支、hook 兼容层与独立升级能力；全部结论写入对应 00-17 文档。**✅ 已完成（2026-09-12；commit `3eb2da9`）**

## 三·九、UI 原生面升级（16-dashboard，每阶段 = 一次会话 = 一个可上线可回滚增量）

> 设计真相源：[16-dashboard](../16-dashboard.md)。目标：把「一个 Modal 装十一 tab」拆到 DSH 原生承载面（主面板 / 右侧栏 / 设置页 / overlay / 会话绑定），原子化隔离到 fiber 级，DSH 升级按挂点清单定点复验。

- [x] **UI-0 前置硬闸：dashboard-rpc 去 v4 兜底**（16-dashboard §5.3「P0 之前」）：见 §二 对应行。**✅ 2026-09-18 完成（本地单测 4/4，模板未部署）**
- [x] **P0 地基**：`ui-core` 包骨架（token 表 / `SilksecErrorBoundary` / `useRpc` 等 hooks / `secUiBus` / 视图注册表）；`bundles/dsh/doc/ui-surface-deps.yaml` 首版；11 视图原样注册进注册表（文件不拆，行为不变）。验收：十一 tab 行为逐项比对现状；ErrorBoundary 注入故障演练（人为抛错只炸单面）。回滚：revert 包部署。**✅ 已完成（2026-09-18 本地单测 6/6 + csai 部署验收；commit 见 §二 对应行）。** 新增文件：`dsh-plugin-silksec-ui-core.{index,client}.js`、`.patch.yml`、`silksec-ui-core-plugin-setup.sh`、`.client.test.mjs`、`doc/ui-surface-deps.yaml`；旧 `sec-dashboard` client/setup 仅加跨包 require 与 inject（渲染路径零改动）。跨 bundle require 结论：可行（§九 #5 已关闭）。
- [x] **P1 主面板**：`ui-panel`——`main` keyed 槽 + `sidebar.panellist` + `ctx.layout.selectPanel`；footer 入口改跳转；Modal 形态保留为降级分支。验收：双形态各跑一遍视图回归；`beginNavigation` 连点竞态测试。回滚：模式开关回 Modal。**✅ 已完成（2026-09-18；commit `a384fef`）。** 新增文件：`dsh-plugin-silksec-ui-panel.{index,client}.js`、`.patch.yml`、`silksec-ui-panel-plugin-setup.sh`、`.client.test.mjs`；`sec-dashboard.client.js` 11 视图登记升级为自足 wrapper（PanelView + 统一 prop bag），旧 DashboardShell/Modal 零改动；setup/manifest/deps 登记；keyed 槽 `options.key` 实测修正。线上验收：组合树含 ui-panel、client bundle 200、真机无头浏览器 11 tab/footer/返回会话/Modal 降级全过、`sec-v5-accept` PASS=25 FAIL=0。开放问题 §九 #1（URL hash 直达）实测未做：selectPanel 为内存态、刷新回会话（官方默认）；§九 #4 零会话下主面板 root scope 照常可达。
- [x] **P2 审批套件**：`shell.overlay` 待办胶囊 + 快捷浮卡 + 审批右侧栏 tab；看板「审批」tab 保留观察。验收：待办计数一致；快捷路径 audit 留痕等价；零会话下胶囊自足。**✅ 已完成（2026-09-18；commit `5880674`）。** 新增文件：`dsh-plugin-silksec-ui-approval.{index,client}.js`、`.patch.yml`、`silksec-ui-approval-plugin-setup.sh`、`.client.test.mjs`；setup/manifest/deps 登记（`setup.sh` 8.6.5 在 ui-core/ui-panel 之后、sec-dashboard 之前）。**实测修正**：官方 API 是 `ctx.sidebarRightTabs.register(definition)`（设计稿 `registerType` 名称有误，已回填 deps）；`title(address)` 是 open 时捕获的 chip 初值，动态计数须另注册 keyed `sidebar.right.pane.tab.title` 体（§九 #6 修正）。线上验收：组合树含 silksec-ui-approval、client combo bundle 200 且含 ui-approval/ui-core/ui-panel、真机无头（MaintenanceClient 临时账号已还原 + playwright）胶囊可见计数与 approvalList.pending 一致（0→stub 2）、快捷浮卡批准/驳回均发 approvalDecide（reject 带备注，路由 stub 不落库）、点击「打开审批中心」openTab 开右侧栏 tab、`__silksecSurfaceHealth.ui-approval=ok`、零 console/page error；`sec-v5-accept.sh` PASS=25 FAIL=0；生产审批数据零变更（17 approved / 4 rejected 保持）。开放问题：§九 #2 会话内审批卡 spike 未做（留 P5）；§九 #3 未发现跨插件 toast 服务；§九 #4 零会话由胶囊 + 快捷浮卡自足承接。
- [x] **P3 任务 tab**：任务右侧栏 tab（四区块栏宽重排）；会话头「本会话任务」计数。验收：320–720px 响应式目检；写操作等价。**✅ 已完成（2026-09-18；commit `b557402`）。** 新增文件：`dsh-plugin-silksec-ui-task.{index,client}.js`、`.patch.yml`、`silksec-ui-task-plugin-setup.sh`、`.client.test.mjs`；setup/manifest/deps 登记（`setup.sh` 8.6.6 在 ui-approval 之后、sec-dashboard 之前）。**实测**：官方 API 沿用 `ctx.sidebarRightTabs.register(definition)`；会话头 utilities 运行时 props 携带 `sessionId`（官方 open-in-app 同槽先例）；primitives（Pill/StateDot/DisclosureRow/Tooltip + IconAlarmClockOutline/IconQueueOutline/IconClockOutline）在 rc.2 前端 primitives 模块均导出，按能力探测消费（缺席走 ui-core 兜底）。线上验收：组合树含 silksec-ui-task、combo bundle 200 且含 ui-task、真机无头（MaintenanceClient 临时账号已还原 + playwright）会话头计数钮 + openTab 开右侧栏 tab + 四区块渲染 + 700/340px 栏宽响应式 + taskRunNow 写 RPC（路由 stub 不落库）+ `__silksecSurfaceHealth.ui-task=ok` + 零 console/page error；`sec-v5-accept.sh` PASS=25 FAIL=0；生产任务/审批数据零变更；看板「任务」tab（id='tasks'）行为零改动、保留观察。
- [x] **P4 授权迁设置**：`settings.section`「授权范围」节；看板「授权」tab 观察一周后删。验收：scope 读写逐项等价。**✅ 已完成（2026-09-18；commit `22c8c98`）。** 新增文件：`dsh-plugin-silksec-ui-settings-scope.{index,client}.js`、`.patch.yml`、`silksec-ui-settings-scope-plugin-setup.sh`、`.client.test.mjs`（12 例）；setup.sh 8.6.7 在 ui-task 之后、sec-dashboard 之前。**实测/契约**：`@deepseek-ai/dsh-client-ui-settings` 的 `settings.section` kind=list scope=root、owner `{close}`、注册项 `id/order/label`（label 支持函数）逐字核对；ui-settings-general 内容列 `renderSlot('settings.section',{close},{only:active})`。**真机无头**：整节渲染 3 项目（含工作区徽章/上限/条目数/排除/已归档/凭据引用）、行内绑定 `programBindWorkspace` 经路由 stub 不落库（生产 programs 表 vulhub 保持未绑定、scope.yml 3 项目不变）、`__silksecSurfaceHealth.ui-settings-scope=ok`、client combo bundle 200 且含 ui-settings-scope、零 console/page error；`sec-v5-accept.sh` PASS=25 FAIL=0。降级链：settings.section 缺席 → 主面板「授权 ·降级」临时 tab；主面板/layout 也缺席 → primitives Modal。看板 legacy「授权」tab（id='scope'）行为零改动、保留观察——**P4 部署日 = 观察起点（2026-09-18）**，删除动作待观察期满（≥1 周）另行确认（属 P7/后续），P4 不删。
- [x] **P5 会话绑定**：`conversation.view` 安全产出 + header 钮 + `assistant-actions` 登记/沉淀。验收：按 session_id 过滤正确性抽样；消息动作写操作经 RPC 全管线（actor=dashboard）。**✅ 已完成（2026-09-18；commit `e029af0`）。** 新增文件：`dsh-plugin-silksec-ui-session.{index,client}.js`、`.patch.yml`、`silksec-ui-session-plugin-setup.sh`、`.client.test.mjs`（17 例）；setup.sh 8.6.8 在 ui-settings-scope 之后、sec-dashboard 之前。**实测/契约**：`conversation.view` kind=list scope=session owner=ConvViewOwnerProps + ViewTab{id,label}（options 投影，label 函数）、`ConversationSessionHeaderInjected.selectView`、`conversation.chat.assistant-actions` kind=list scope=session owner=`AssistantActionOwnerProps{messageId}` 逐字核对；ui-trajectory/ui-message-feedback 官方 register({name,id,order,label,inject}) 先例。**端点决策**：dashboard 对 register_candidate/register_signal 均非白名单且禁改域动词 → 「登记候选漏洞」走 compat 别名 `vuln.finding_add`（severity=info 候选降级，审计可区分）、「沉淀事实」走 `fact.upsert`；均 /silksec-domain + actor=dashboard。**真机无头**：页签 `对话/轨迹/费用/安全产出`、会话头计数钮、安全视图本会话过滤、assistant-actions 两动作、RiskConfirmation 后发 `POST /silksec-domain/vuln.finding_add`（路由 stub 不落库，生产零变更）、`__silksecSurfaceHealth.ui-session=ok`、零 console/page error；`sec-v5-accept.sh` PASS=25 FAIL=0。⚠️ 依赖观察期别名 `finding_add`，5.2 删别名须协调。
- [x] **P6 逐域视图拆分**：vuln→asset→endpoint→fact→know(+学习)→report→audit 每域 `dashboard-view.js`，7 天并排观察。验收：每域新旧并排等价 + audit 对照；域缺席 tab 静默隐藏。**✅ 已完成（2026-09-18；收口 commit `6f4086c`，逐域视图文件另见 `f4e7f88`/`73acd34`/`64bb8a9`/`9273c53`/`d29dcad`）。** 新增 7 个独立 client bundle（`dsh-plugin-sec-dashboard.view-<domain>.client.js`；`sec-dashboard-plugin-setup.sh` §4 逐域组装为 `@silksec/sec-dashboard-view-<domain>` 独立包装入 web profile → **构建隔离**）+ 7 个单测（44 例）；ui-core 增 P6 共享契约（`setServiceProbe` + registry `requires` 过滤、`SessionLink`/`setSessionOpener`、`sevPill/statusPill/confPill/taskPill/programCell/insightChip/sortableTh/hlText`）；旧单体七域改注册 `-old` 后缀（order=canonical+1、label「 ·旧」）并排观察，任务/审批/授权仍 canonical，Modal 路径零改动；逐域 `DomainRoot` 包 `SilksecErrorBoundary`（surface=`dashboard-view-<id>`）+ `requires:['connection']` 缺席 tab 静默隐藏；每域自持 query/handler，端点/参数与旧单体逐项一致。**本地**：`node --check` + `node --test` 全绿（7 视图 44 + ui-core 9 + ui-panel 7 + ui-approval 10 + ui-task 11 + ui-settings-scope 12 + ui-session 17 + dashboard-rpc 4，无回归）。**csai 部署**：`--dump-config` 组合树含 7 视图包；combo bundle 200 且含全部 7 包；真机无头（MaintenanceClient 临时账号同进程还原 users.yaml + playwright，退出 logged_out）——主面板 19 tab（8 新 canonical + 8 `-old` + 任务/审批/授权），逐域 tab 切换 active、7 个 `sec-dashboard-view-*` 面 + ui-panel health=ok、新旧端点集合等价（know 自持 `memcore` 为唯一白名单增量）、facts 域新旧**同口径**预存参数校验错误（非 P6 回归）、写操作 `findingUpdate({id,status:'confirmed'})` 经路由 stub 不落库、零 console/page error；`sec-v5-accept.sh` PASS=25 FAIL=0。P6 不改数据层（RpcProjector/域动词/audit）。回滚：revert 单域文件 + 从 profile 移除该视图包（旧 `-old`/Modal 行为不变）。
- [x] **P7 收尾（文档/规范/冒烟，2026-09-18）**：① 16-dashboard 状态回填——§2.1 拆分去向（**独立 `@silksec/sec-dashboard-view-<domain>` 包**而非域插件内 `dashboard-view.js`）与部署通道差异裁决理由、§3.3 D0/D1/D2 已实施 + D3 删旧顺延、§五「dashboard 不能独立升级」已落地、新增 §六 实施状态；② 主题规范 v4.2 落盘（`doc/silksong-theme-design.md` §十一 七条：主面板页头/overlay 胶囊/右侧栏内容区/设置节/会话绑定件/guide 陷阱/零颜色字面量断言）；③ `sec-v5-accept.sh` 增 **R5 UI 冒烟**段（13 个 UI 包结构断言 + 零颜色字面量 grep + `--ui-headless` 真机无头运行时 31 项：组合 bundle 200 且含各包 / 13 面 `window.__silksecSurfaceHealth`=ok/degraded / 每面 1 读 + 1 写 stub RPC 往返 / 零 console·page error）；新增模板 `dsh-ui-surface-smoke.{py,mjs}` 入 manifest；④ 文档同步（CONTEXT 看板段 / 16-dashboard 头部与 §八 / `ui-surface-deps.yaml` p7_review）。**删除动作顺延**：旧单体 client + Modal 主形态 + `-old` 视图 + 旧包 setup/manifest/deps 提及，须待 P6 并排观察满 7 天（**≥2026-09-25**）执行（未满不删；届时单文件/单包 revert 并回填删除 commit）。验收：默认 `sec-v5-accept.sh` **PASS=39 FAIL=0**；`--ui-headless` **PASS=70 FAIL=0**；真机无头 P6 smoke 复跑 **19 tab / 7 域 health=ok / 零 console·page error**（P7 无 UI client 代码改动）；csai `silksecagent` active、NRestarts=0；临时维护账号同进程还原 users.yaml 并 logout（`users_restored=True`/`logged_out=True`）。commit `d6fe5ac`（docs 回填见后续提交）。

---

## 四、Phase 2-5 概览（后续会话，勿提前开工）

- Phase 2：数据域滚动搬迁（asset+endpoint → fact+know → ledger → task+exec → fgs → scope+approval → report/proxy/eval/dashboard）✅ 已完成
- Phase 3：跨域事件化收尾（outbox 验收 / bus replay 演练 / memcore 旁路化 / eval 订阅）✅ 已完成（3.1 部署验收 + 3.2 事件可靠性回放 + 3.3 memcore 旁路化 + 3.4 删旧路径）
- Phase 4：http-remote 后端试点（vuln 域）✅ 已完成（repository-http + 混布 overlay + outbox 同步 + 能力矩阵 + 三后端同套跑 + 切换演练可回切）
- Phase 5：LLM 面收敛 + 守卫加固 + 评测 ✅ **已完成**（5.1、5.3–5.8 + 5.2 别名删除 2026-09-19）。历史验收范围与最新缺口见 §一，后续仍须逐条核对 18-migration 的 DoD。


## 2026-10-01 归档：此前PROGRESS最近结果

以下为迁出的原有记录，日期与当时结论保留。

### 2026-09-30 · 27 号首批实现：收尾恢复、观察保留与弱判据修复（本地，未部署）

- scheduler 收尾增加持久恢复记录与失败重试，省略空 session；按认领轮次隔离 busy/迟到结果，保留旧 run 执行史；不重写历史回收结果。
- 候选按项目查询并保留原归属；对象型参数保留值。候选/信号去重纳入 Program 与完整 URL，兼容旧指纹，追加观察与升级均保留证据；补齐 signal schema 的 program_id。
- 抑制统计不再用 ignored/dup 充当技术误报；平台状态不会单独创造技术正样本。回显/单次延迟/无 OOB 回调保留未知，SQL 差分不以长度相近证明基线相同；验证指令将证据不足与技术反证分开。
- **本地验证 257/257**：`sec-contract-test-local.sh task vuln hypothesis exec`，新增 15 个故障/兼容性回归。完成范围与剩余边界见 [27 号 §10.3](../27-business-quality-and-capacity-plan-2026-09-30.md#103-首批实现与验证2026-09-30)，契约同步 02/05/10。
- **生产未部署**；未运行目标探测、改预算或升级运行时。完整真实请求链、H2余项轮转、可信判定/capsule、覆盖与学习归因仍待实施，未将本地通过等同于发现能力提升。

### 2026-09-30 · 27 号方案重审：以真实漏洞发现能力评价（未实施）

- 按用户澄清，重写指标、根因排序、逐项建议、学习反馈、实施包和验收。真实漏洞成立即可计技术成果；平台重复/忽略/零赏金不否定独立发现；撤下提交 SOP 和外部核单依赖，区分内部根因去重与平台重复。
- 纠正前版推论：零提交不说明零漏洞；low/info标签和缺task_id不直接证明漏洞无效；noise=1占93.7%是候选分类，不是已验证误报率。生产数字继续使用前轮采样，并未本轮刷新。
- 本轮重新核查代码，新增 5 组合成检查：H2前三项截断、参数值丢失、未注册Oracle，以及dup/ignored各自可在零技术误报时触发类别抑制；另定位同host同标题异URL观察被合并、H1函数未接task调用。保留原有执行/验证/学习断点，按直接影响重新排序。
- 12 个工作包和 15 组验收改为技术链路：真实请求→具体假设→有效实验→技术漏洞→方法复用。增加外部状态变化不得改变技术计数/学习分的验收；不等待全套治理完成才开始小批发现。
- 仅代码重审、本地合成复现及文档修改；未改生产、运行扫描或提交报告。改造待实施，未知的真实漏洞数量/漏报损失仍由技术证据决定。

### 2026-09-30 · DSH 0.1.7 升级链 P8（终步）：U4b 巡检 2 + `preserve_after_resume` 对账 + 关账（**CHAIN END**）
- **只读巡检（+59.5h，05:04–05:08Z）**：6 单元 active、MainPID **889738**/NRestarts=0、app/插件/客户端 SHA 全对（task `5dccbc1c…`）；`settings.yaml.imported` 在、无 drop-in/孤儿；journal（切换以来）err=0、15 域、prune×5、vault errors=0、scheduler.lock 60s 步进、outbox 0 pending（9 历史死信不变）；会话 1641→**1767**、最新 8 会话 V4 读回 **8/8**、业务表 **DECREASES=[]**；accept **PASS=80 FAIL=0**、data-quality **rc=0**。
- **新冻结点与对账（核心交付）**：任务引擎繁忙 → silkspool 活哨兵接替 `scheduler.lock`（仅暂停新认领）排空 + 06:18 一次计划内恢复重启（启动即回收清零）；06:26:28–07:02:46（**36m18s**）完成 capture（26m21s）+ preserve（9m19s）→ 新冻结点 `dsh-snapshot-ready-m7n_2p4h`（manifest **`c85f3b9f…`**）；**`preserve_after_resume ok=true`**（phase=reconciling、new_state_preserved=true、automatic_restore_allowed=false、changed_session_files=384）：会话目录 193→212（缺失 0）、V3 1605 保全、V4 1797、业务表 57/57、**DECREASES=[]**、key_missing 3 项全部归因（facts_archive 12/12、FGS 旧任务图 7、blackboard_archive 1）、settings 迁移态正确、**RPO=0**。
- **关账**：用户指令提前执行（剩余约 10.4h，如实记录非自然期满）；恢复写者后 MainPID **922156**/NRestarts=0、调度器持锁、accept2b **PASS=80 FAIL=0**；release 最小登记（phase=reconciling）。证据 csai `…/p8-evidence/`（29 项 + `SHA256SUMS`）、工具 `p8-tools/` `e1c60b9f…`（p7-tools 快照差闭环）；详见 [record §19](../archive/upgrades/2026-09-26-dsh-0.1.7-rc.2-record.md)。
- **遗留（观察期后治理，移交 27 号方案）**：僵尸任务泄漏两路径（spawn busy 回 queued 静默失败 / task_finish session_id=null E_SCHEMA）、设置保存写路径人工复核、failover 预流缺口（上游）、kbList 缺陷、Campaign 3 预算 99.997%（待决策）、人工提交 SOP/SLA。

### 2026-09-30 · 前版 SRC 全流程审查（评价目标已由本轮纠正，改造未实施）

- 将 [27 号方案](../27-business-quality-and-capacity-plan-2026-09-30.md)扩展为资产到提交、执行稳定性、自主学习和知识使用的逐项审查；原版本偏重列表/容量/提交的优先级由本版调整，保留必要容量与升级衔接方案。
- 06:04 UTC 起只读生产基线：101,787 资产、8,664 端点中 POST 仅 1；44 条 confirmed 全无 task_id，28 条为旧系统导入；38 份草稿、15 个提交任务 done 对应本地 submitted/accepted=0。4,888 个学习 episode 全缺知识版本/模型/成本关联，669/675 个 exp_card 类采用 ID 无法解析到经验卡；不是 P8 关账后的冻结快照。
- 确定性缺口包括 Campaign 目标未强约束/候选 Program 丢失、普通回显等弱信号可判 verified、capsule 自报判定及关联不足、候选知识评测使用固定逻辑。已运行 6 个 Oracle 合成样例和 1 个 Planner 样例，复现缺口；不是修复验收。
- 方案列出 93 项问题与风险、12 个工作包、15 组验收、存量提交 SOP、C3 决策、知识真实评测/灰度和恢复条件。区分运行事实、代码缺口、待验证影响；同步纳入 P8 新移交的 busy/finish 两条僵尸任务路径。
- 本轮通过 PATH `spool exec csai` 只读核查生产与八个关键插件摘要；未启动目标探测、改预算/业务记录、重启服务、发送报告或改写原升级 STATE。P8 关账由原链完成；真实目标复现、外部核单及性能验证边界见 27 号 §14。

### 2026-09-30 · 非版本任务初版规划（后续已扩展，未实施）
- 新建 [27 号专项](../27-business-quality-and-capacity-plan-2026-09-30.md)，梳理 25 号容量方案及自学习/漏洞/预算已有设计的完整性，补齐提交 SOP、C3 决策树、知识质量抽样/对照实验、FTS 回填回退和虚拟化启动条件。
- 优先级：关账后先修 kbList 最小可用性、分诊提交积压、核对 C3 窗口成本并准备决策；知识 FTS 已存在，分页可见性应先于虚拟化，inconclusive 须按原因分层而非批量改判。前后批次与 0.2.0 seal/观察期衔接已明确。
- 25/26/README 入口已同步。**仅本地代码/文档核查；未远程操作、未追加预算、未发送漏洞报告、未改写原升级 STATE；历史统计须在关账后更新。**

### 2026-09-30 · DSH 0.2.0 rc.1/rc.2 研究与详细升级计划（未实施）
- 对照两版官方发布说明全部 **35 项**，核查精确 tag 源码及 npm 产物；11 个 tarball 的 integrity 校验一致，pi-ai 0.85.1→0.87.1 内置目录差集为删除 68 / 新增 209。
- 确认重点：Session 仍为 V4，现有跨代发布逻辑需改造；远程 settings 门控仍在；bill 0.18.2 原生补齐投影契约；failover 0.1.6 仍需处理 0.2.0 兼容声明与通知写入；官方 schedule 继续不接入，timed 问答建议本轮不开启。
- [26 号方案](../26-dsh-0.2.0-upgrade-plan-2026-09-30.md)包含逐模块影响、9 个改造包、U0–U4、26 项验收、完整备份/回滚/观察期和源链接。**本次仅研究与文档，没有远程巡检、运行时改造或生产升级；所有集成验收均待执行。**

### 2026-09-30 · 修复：OpenCode Go「再次未使用」——候选验证 rejected 计入连败 + 自动回升死锁
- **现象**：Go 套餐可用但系统不再使用；SenseNova 额度耗尽未切换。排查确认 **Bellkeeper 路由正常**（09-29 夜 Go 200 ×823、SenseNova 仅 429 兜底），真因是 **campaign 调度静默**：#1/#2 于 09-29T14:33Z 因「连败速率超阈值」自动降 L1，而 rejected 全部来自 **verify 候选验证的预期拒绝**；且 `autoRecover` 用「降级后是否出现过 rejected」判定，09-29T15:29Z 一条 rejected 令其**永久锁死 L1**（13h 未恢复）。
- **修复**：连败速率排除 verify 角色 rejected；回升判据改滚动窗口（`now - failWindowMs` 内无非 verify rejected）。任务契约 **94/94**（+3 回归）。
- **部署验证**：定点部署 `sec-domain-task`（`b75c604b…`→`5dccbc1c…`）+ 重启（MainPID 819672→**889738**）；04:00Z #1/#2 自动回升 L2，任务 running 0→6，`opencode-go-secagent` 200 恢复流动。证据 `…/fix-20260930/`。详见 [05-task §7.28](../05-task.md)。

### 2026-09-29 · OpenCode Go 主力恢复（池策略运维：修复「套餐可用但零消耗」）
- **现象**：用户报 OpenCode Go 套餐可用但请求不落 Go、额度零消耗。诊断：线上三池为 `priority-health`（Go 渠道 priority=3，SenseNova=1）——该策略按渠道 priority 硬排序，SenseNova 健康时永不落 Go（§7.18/§7.19 同一机制；09-25 20:43 曾回滚为 priority-health）。
- **修复（DB API 为准 + YAML 种子双写，无重启）**：`PUT /api/llm/config/groups/{10,11,12}` 三池改 `best-weight` + Go 成员 **w8**（std/heavy：Go v4.1-flash w8；lite：Go v4-flash w8），其余 SenseNova 成员按 w7/w6/w5/w4 顺延；`config/bellkeeper.yaml` 同步。
- **验证**：三池冒烟（std/heavy→`deepseek-v4.1-flash`、lite→`deepseek-v4-flash`）经 `/api/llm/logs` 全部命中 **`opencode-go-secagent` 200**；`go test config+llmgateway` 全绿；回滚点 `groups-before-20260929.json`（`b7b1b952…`）。详见 [05-task §7.27](../05-task.md)。

### 2026-09-29 · DSH 0.1.7 升级链 P7：U4a 巡检 1（只读观察期巡检，**全绿**）
- **前置/服务**：release `phase=observing`、`observation_until=2026-09-30T17:29:26Z`、manifest `52040fa6…`/seal `fbc2f3ab…` 不变；6 单元 active、silksecagent **MainPID 819672/NRestarts=0**（与 43 号补丁后基线一致）；app/插件/客户端 11 项 SHA 全对（task `b75c604b…`、settings 客户端 `1be776de…` 等）；`settings.yaml.imported` 在、无 `settings.yaml`/维护 drop-in/孤儿。
- **journal（切换以来）**：`-p err=0`、无异常自动重启（计划内 5 次）、15 域注册；保留窗口清理 3 次（21:00:48 / 09:48:23 / 21:00:31 UTC；idempotency 491/242/470、outbox 880/522/757）；vault 回流 `imported=3、errors=0`；E_SCHEMA/E_CONFLICT/deadlock=0。
- **调度/总线/Session**：scheduler.lock pid=819672、ts 60s 步进；dispatcher 持锁；outbox **0 pending**（9 条 09-25/26 历史死信）；会话 **1605→1641**；最新 8 会话 V4 读回 **8/8、failures=0**；业务表 vs 发布基线 **DECREASES=[]**。
- **验收**：`sec-v5-accept.sh --ui-headless` **PASS=80 FAIL=0**（09:46:33Z）；`data-quality.py --json` **rc=0**。
- **U4 复核**：浏览器实机（真实 edge）模型页提供商目录/通用设置页全绿（回归热修复）；保存写路径未实测（观察期不改配置）；failover 预流 5xx 缺口锚点复核（上游）；kbList 缺陷复现（非回归）；p7-tools 快照差 11 文件登记。
- **观察**：任务执行自 09-28 19:35Z 静默 ~14h（queued 5/blocked 4/running 0；高优候选清空 + recon 日片节奏 + C3 预算耗尽），campaign ticks 持锁正常，**非异常**。证据 csai `…/p7-evidence/u4a/`（`SHA256SUMS`）；详见 [record §18](../archive/upgrades/2026-09-26-dsh-0.1.7-rc.2-record.md)。**下一步 P8**：+72h 巡检 2 + `preserve_after_resume` 对账 + 关账。

### 2026-09-28 · 43 号补丁：发现/转化优先 + 噪声类别自学习抑制（线上生效）
- **噪声类别学习与自动抑制**（vuln 域）：同来源同类别拒绝率≥80%且样本≥20 → 新候选**登记口直接 ignored**（`vuln.candidate.suppressed` 留审计）；来源日配额（默认 200）；白名单/阈值可配；新命令 `vuln_noise_stats`（只读口径）与 `vuln_candidates_sweep`（存量确定性处置，支持 dry_run，检测型模板正则）。
- **三处学习断链修复**：登记落 `findings.task_id`；confirm/reject 事件带 `task_id`（`onStrategyOutcome` 按 task 反查策略——拒绝→连败→拉黑恢复生效）；`gatherPlanInputs.scores` 实查 `know.hit_matrix`（此前写死 `{}`；know 新增该查询）。
- **规划与验证流水线**：覆盖类封顶 1 条/tick（asset/review 降权）；候选验证 +2.5+severity（role=verify、priority 最高、oracle 路由）并新增 verify 目标模板；`authz_diff` 登记改走 v5 域命令。
- **param 缺口闭环**：幻影端点（4xx 非 401/403）不再补参；`params_enriched`/`no_params_confirmed` 30 天冷却；新增终态 mark；param_enrich 模板要求收尾记账。
- **线上核验（11:06–11:24Z）**：8 插件定点部署 + 重启（MainPID 819672）；accept **PASS=80 FAIL=0**；`sweep` 实跑 **ignored=342，候选池 535→193**，同类拒绝率→1.0/suppressed=true（新噪声登记口自动抑制）；campaign 2 草稿出现 **`verify_candidate`**（score 9.5/priority 1）且已派发 verify 任务 #103151–103153（derived=3/dropped=0）。测试：rules 42/42、vuln 67/67、task 91/91、ledger 31/31、endpoint 33/33。详见 [record §17](../archive/upgrades/2026-09-26-dsh-0.1.7-rc.2-record.md)。

### 2026-09-28 · DSH 0.1.7 观察期热修复（设置页远端可用 + 安全中心图标）与数据面只读排查
- **设置→模型报「加载提供商目录失败: settings are unavailable in this browser」**：0.1.7 客户端 `dsh-client-ui-settings` 按 `$host.isLoopback` 门控设置镜像——经 edge（非 loopback）访问时永不加载；0.1.5 链已在 `dsh-runtime-compat.patch_settings()` 打通远程设置，**0.1.7 适配遗漏**。修复：`patch_settings()` 版本化并接入 0.1.7 分支（摘要钉死 `2ac7f186…`→`1be776de…`，+2 回归测试 11/11）；生产定点应用 + 重启（MainPID 779535→811336）；经真实 edge 无头实检 `models_error_absent/provider_text_present/ok=true`，回归 accept PASS=80 FAIL=0。
- **安全中心侧边栏无图标**（插件/费用统计均有 glyph）：恢复 `PanelIcon → uiCore.spoolIcon`（19-ui-unify 的纯文字口径是旧 UI）；实检 `sidebar-icon-present=true`。工具三点合并 SHA `f77f30b6…`；证据 `…/p7-evidence/`（原件备份 + 实检 JSON/截图）。
- **只读排查（未改数据）**：漏洞 934 条中 92.8% 为 noise（nuclei info 为主）、非噪声 67/confirmed 44（最后 09-18）、**submitted/accepted=0**（9 份草稿未提交）；Campaign 3 预算 99.997% 耗尽，09-23..26 param-gap 循环（09-25 单日 2040 任务/2159 runs，2134 次「宿主重启/超时回收」失败）；episodes 4004 条 inconclusive（confirmed 7）；facts 3124 条 uses 102、kb 420 条 uses 281（写多读少）；队列近乎空（5 queued/4 blocked/0 running）。建议（未执行）：噪声采集端降级、param-gap 闭环语义修复、Campaign 3 预算处置、提交出口明确、知识复用复核。详见 record §16 · 证据 `p7-evidence/vuln-learning-knowledge-review.txt`。

### 2026-09-27 · DSH 0.1.7 升级链 P6b：U3 生产切换重试（**成功——生产 0.1.7-rc.2、invariants failures=0、accept PASS=80 FAIL=0、进入 +72h 观察期**）
- **修复**：`dsh-upgrade-maintenance.py` 增加 `sec-domain-task: {sidecars: false}` 并纳入 REQUIRED——维护启动不再启动任务调度器（启动回收/claim/campaign tick/每日 know vault 回流/bus.prune 全静默），新增回归测试（7/7）；工具三点合并 SHA `e59cd56c…`，维护补丁 `88e082c1…`。
- **决定性预演**：0.1.7 全状态副本在沙箱内以修复补丁启动、保持 **172s（≥2 个 60s tick）**：审计追加 **0**（对照 P6 实败 +6）、campaign/checkpoint/idempotency/bus_subscription/bus_meta/know **零变化**，唯一写入 22 条域注册（白名单）；`scheduler_disabled_log=true`（证据 `p6b-mute-rehearsal-report.json` `3ed1eede…`）。
- **生产切换（14:32:45–17:29:26Z，窗口 2h56m25s、业务 RPO=0）**：冻结点 `52040fa6…`（首抓撞 oneshot 瞬态、零影响重试）→ 候选 `fta9s5j5` + seal `fbc2f3ab…` → prepare 2h00m34s（**1607 会话 V3→V4 failed=0**）→ 四根切换（读回 0.1.7-rc.2）→ **静音维护**（15 域/1605）→ **finalize `pre_resume_invariants failures=[]`**（`2fd357fc…`）→ 写者恢复 → **accept PASS=80 FAIL=0**（`accept017c2` `431fad0c…`）；生产 MainPID 779535/NRestarts=0、调度器持锁、journal 无 err。
- **验收脚本 0.1.7 兼容修复**：`sec-v5-accept.sh` 的 `printf|grep -q` 在 `pipefail` 下 SIGPIPE 误判（0.1.7 树变大后必现）→ 内建 `[[ == *…* ]]`；部署态 `data-quality.py` 旧版（读已改名 settings.yaml）→ 更新仓库 0.1.7 版；定点部署 `73eca292…`/`c62f2acd…`（未跑整包 setup，避免 sync_rules 推回 settings.yaml 的二次导入风险，已登记）。
- **下一步**：P7 巡检 1（+24h 只读）→ P8 巡检 2（+72h）+ `preserve_after_resume` 对账 + 关账（CHAIN END）。

### 2026-09-27 · DSH 0.1.7 升级链 P6：U3 生产切换（**finalize 门禁未过 → 按协议回滚，CHAIN BLOCKED；生产 0.1.5 全绿**）
- **执行链（窗口 10:26:44Z–13:46:57Z，3h19m20s，业务 RPO=0）**：前置校验全绿（并 `rsync` 修复 spool 运行时副本 4 文件滞后）→ `--hold` 冻结点 `dsh-snapshot-ready-_jl66rgf`（manifest `5984892f…`，28m12s，1605 sessions/0 running）→ 终版候选 `gc4nl2qh` + U-A..I 验收 `5da2d74f…` + seal **`3928c930…`（ready_for_cutover=true）** → 生产 prepare **1h59m45s、1607 会话 V3→V4 failed=0**（report `fe67dad6…`）→ 四根 RENAME_EXCHANGE（app 读回 **0.1.7-rc.2**）→ 0.1.7 最小维护 ok（version=0.1.7-rc.2、15 域、1605/0 running、Web/Scope/未认证/身份清理全绿）→ **finalize `pre_resume_invariants` 失败（17 项白名单外差异，`caa68faa…`）** → rollback（`phase=rolled-back`、`new_state_preserved=true`）+ `freeze resume`（13:46:57Z）→ 0.1.5 读回（关键文件 SHA 与基线逐字节一致）+ **`sec-v5-accept.sh --ui-headless` PASS=80 FAIL=0**（13:51:14Z，`accept015b.stdout` `431fad0c…`）。
- **失败根因**：生产维护启动（~1m50s）中，~3h 冻结积压的 overdue 后台任务就绪即跑——审计行 `task/reap`、`worker_reap`、`claim`、`campaign_tick`、`know/kb_vault_sync`、`bus/prune`（idempotency_pruned=232、outbox_pruned=774、subscriptions_pruned≈108）；bus.jsonl +22、audit.jsonl +6，bus_subscription/campaign*/event_outbox/idempotency 计数与哈希变化。P5 隔离预演同窗口未触发（时序），白名单 8 项不覆盖；**按「允许项之外必须停下回滚」执行**（硬停止②）。业务表行哈希全部未变、无用户数据丢失；0.1.7 新状态（含 1607 V4 会话）完整保全于 `dsh-release-r_7v_eur/rollback/`。
- **恢复选项（择一后重开 P6；不可直接续跑本 release）**：① 首选——`dsh-upgrade-maintenance.py` 维护启动全静音 `sec-domain-task`/know vault/bus.prune，并在隔离副本以「冻结 3h 后维护」预演验证；② 备选（需批准）——扩展 invariants 分类器承认维护窗口 scheduler/bus 维护写入并要求同等预演；③ 离线行级 diff 复核（`release/rollback/`）。证据 csai `…/20260926-017/p6-evidence/`（record §13.9）；链状态见 [state.md](../archive/upgrades/2026-09-26-dsh-0.1.7-rc.2-state.md)。

### 2026-09-27 · DSH 0.1.7 升级链 P5：U2 隔离预演（**全门禁绿，放行 P6**）
- **隔离闭环全绿**：真冻结点（窗口 23.2 分钟、RPO=0、生产零影响）→ 正式候选封存 `af8e8ae2…` → prepare 全量 **1600 会话 V3→V4 failed=0**（6431s，≈4.0s/会话）→ 四根切换 → 0.1.7 最小维护 15 域全绿 → **invariants failures=0**（8 项白名单含 `settings-legacy-import-rename`）→ runtime 核心 18 检查、worker-smoke 11/11、personas 7、feedback 本地化+外传对照、browser-scope 15、契约 568/568、session-read **1646/1646** → 回滚 → 旧版 maintenance + 旧版读回 **1600/1600**。
- **failover（B 方案解决）**：0.1.5 插件在 0.1.7 下路由可用，真实不兼容为「切换通知在请求瀑布内 append 会话消息」与 turn 写路径互锁；`dsh-runtime-compat.py` 新增 `patch_model_failover()`（通知改日志、fail-closed、幂等）后实机全绿（`fixture-failing → fixture`、canonical 归因；runtime-compat 9/9）。
- **浏览器/billing 实机**：登录门/丝之歌主题/主面板 8 tab/WS 流式工具对话/刷新恢复/断线重连续聊/交付文件+预览/**billing（calls=3、in=48、out=12、$0.000096）**全绿；设置 UI 两项因 fixture 无账号态记跳过（U4 生产复核）。
- **已修 0.1.7 阻断缺陷**（14 文件，p5-tools 合并 SHA `1e43d1be…`）：task 调度器启动回收 + 多 profile 同步 SQLite busy-wait 的 **boot 死锁**（延迟 1s 回收；契约 91/91）；candidate 版本泄漏（pin 被写 4.0.4）；root-only 冻结点 settings 源 EACCES；sandbox 吞版本对；invariants 真实布局白名单（多实例重复注册/顶层 settings 改名/audit 追加）；runtime-smoke 覆盖合并/就绪等待/trace 重试；failover 通知补丁；browser-smoke 0.1.7 适配与韧性降级。
- **下一步 P6**：U3 生产切换（预授权；方案①窗口 2.5–3h）——见 [handoff-017/P6.md](../archive/upgrades/handoff-017/P6.md)；证据 csai `…/20260926-017/p5-evidence/`（record §12）。

### 2026-09-27 · DSH 0.1.7 升级链 P4：U1c settings + 第三方插件 + 部署链
- **settings→Profile**：0.1.7 起 `settings.yaml` 不再热加载；模型/provider/默认模型/retryPolicy 与 `agent-presets.default=vuln-hunt` 显式写 web+headless `cordis.patch.yml` 受管区块；migrate-once（已存在行不覆盖 UI 编辑，`.imported` 不回填）；`--validate-composition` 用 `--dump-config` 逐字段断言（web 268/headless 125 行组合，默认 preset 注册校验）；0.1.5 函数体逐字保留。
- **第三方插件**：auth-gate 0.7.2→0.15.0、bill 0.13.1→0.18.1、failover 0.1.4→0.1.5（`plugins.lock` npm integrity + candidate/release 三方受控集合）；billing 客户端补丁收敛为 `data-silksec-turn-cost` 标记（0.18.1 原生支持 turnTail list），投影补丁沿用（0.18.1 projection.js 与 0.13.1 字节相同）；session-trace 改 `inheritedEventCount`，真实生产 V3 会话读回 billing_cache 三项全绿。
- **部署链**：setup 先 `--validate-composition` 再重启（失败=部分激活 + 重试/回滚文案）；candidate 修相对 `link:` 解析、核心 overrides 重建、受控 pin；真 0.1.7 app + 生产 profile 只读快照全链到 `prepared`（offline-frozen 双 profile），rpc 契约 3/3。
- **测试**：本地 11 组 Python + node；csai root（p4-tools）11 组 Python 全绿 + node host-compat 9/9、browser-scope 5/5、session-recovery 2 pass/8 skip；0.1.5 路径回归幂等。证据 `p4-evidence/`（root-tests `b49bff09…`、candidate-checks `3de11e59…`、p4-tools-sha256 `e4c6e1a2…`）。生产零影响（MainPID 635167/NRestarts=0）。
- **下一步 P5**：真实冻结点 → 正式候选 → U2 沙箱全量预演（登录门/fallback/personas/browser/worker/全量 V4 迁移/最小维护/invariants=0/回滚读回），并显式决策冻结窗口方案。详见 [record §11](../archive/upgrades/2026-09-26-dsh-0.1.7-rc.2-record.md)。

### 2026-09-26 · 42 号补丁：大数据治理 B1（25 号方案 S0+S1 核心）
- **保留窗口落调度**：`bus_prune` 扩展——`idempotency` 与 `event_outbox`（仅 `delivered`）按「7 天或 2 万行取大」裁剪，`bus_subscription` 级联清理，返回新增 `outbox_pruned`/`subscriptions_pruned`；接入 task 调度器每日 05:00（北京）后首个 tick（`actor=system`，无 force，沿用 6h 冷却）——此前 `bus_prune` 从未被调度（实测 idempotency 5.9 万行超上限 5.9 倍、outbox delivered 13 万行零清理）。`bus_status` outbox 增 `delivered`/`oldest_delivered_at`。
- **审计游标翻页**：`audit_tail` 单窗 256KB→1MB，新增 `before_bytes` 排他上界与返回 `next_before`（null=到文件头）/`window_bytes`；看板审计视图新增「加载更早」（游标翻页 + 行键去重），`dashboard-rpc` audit 端点透传/回传游标。
- **ledger 500 截断修复（指标口径恢复）**：`coverage_metrics`/`coverage_gaps`/`login_blindspot` 改全量分页遍历——资产 `asset_host_page`（20 万行）/ 端点 `endpoint_lite_page`（5 万行）/ findings `vuln_list`（2 万行）/ 根域 `asset_roots_agg` / 参数率 `endpoint_param_stats`（SQL 聚合），输出 `truncated` 标记；修复「前 500 行采样」失真（meituan param 采样 24% vs 全量 35.7% 一类）。
- **SQL LIMIT 落位 + 总线二次切片缺陷修复**：vuln_list/vuln_candidates/report_list/fact_search/task/campaign 等列表分页落 SQL（缺省 50、封顶 500），处理器标记 `meta.paged` 后总线不再二次切片——修复「asset_list limit=3 offset=3 返回 0 行」（第 2 页恒空）实缺陷，契约新增第 2 页非空回归；`campaign_list` program 过滤下沉 SQL（`json_each`），`task_scheduled` 聚合改 LEFT JOIN + LIMIT 500。
- **exec 流式 + param append-only**：新增后端 `readFileWindow`/`readLinesCapped`，`exec_page_result`/`exec_grep_result` 不再整读文件，`readFlows` 无 date 时改最近文件优先；`param-queue.txt`/`param-seen.txt` 改 `O_APPEND` 分块写（≤3.5KB/次），`queue_status` 行数按 mtime+size 缓存。
- **索引与缓存**：新增 `assets(last_seen/score)`、`findings(created_at)`、`facts(category,updated_at)`、`endpoints(last_seen)` 索引；assetOverview TTL 25s→60s 且 `touchAsset` 触活也失效缓存。
- **backups 保留**：retention.sh 新增第 6 节——`data/backups/asset-graph.*.db` 保留最新 N 份（`SEC_BACKUP_KEEP` 默认 7）。
- **部署验收（2026-09-26 完成）**：`spool bundle dsh setup` + 重启（MainPID 635167、NRestarts=0）；`sec-v5-accept.sh --ui-headless` **PASS=80 FAIL=0**；线上实测：`bus_prune` force 首轮真实执行（idempotency_pruned=3378、outbox_pruned=15251、subscriptions_pruned=2501，二次 force replay=false）、`asset_list` offset=3 返回 3 行（第 2 页修复）、`audit_tail` 返回 `next_before`（1MB 窗）、ledger 四指标与 SQL 对照一致（bytedance web 738/738、param 596/5373、login_required 44/44）、retention 清理 7 份过期备份。
- **部署期发现并修复**：`bus_prune` 原 `idempotent: auto` 会让同参调用在幂等保留期内返回 replay 而不再清理（日调度将永久空转）→ 改 `idempotent: none`（清理天然幂等），bus 契约 +1 断言（二次 force 必须真实执行）。
- **验收**：本地契约全绿（bus54/asset32/endpoint33/vuln70/fact23/ledger31/task90/exec30/approval28/fgs21/scope18/report12/know78/eval30 + dashboard-rpc 5/5）。文档回填 [00-conventions](../00-conventions.md)/[01-bus](../01-bus.md)/[02-vuln](../02-vuln.md)/[03-asset](../03-asset.md)/[04-endpoint](../04-endpoint.md)/[05-task §7.26](../05-task.md)/[06-fact](../06-fact.md)/[10-exec](../10-exec.md)/[11-ledger](../11-ledger.md)/[12-report](../12-report.md)/[15-eval](../15-eval.md)/[16-dashboard](../16-dashboard.md)/[25 §4.5](../archive/upgrades/2026-09-26-dsh-0.1.7-upgrade-and-scale.md)。

### 2026-09-26 · 41 号补丁：恢复调度修复（策略去重尊重 reopen_after + 运行失败重开）
- **现象**：额度回血后 2h 零消耗、无进行中任务（显示已恢复 L2）。非供给闸——SenseNova 已健康。
- **根因**：`derive_intent` 去重只看 `!blacklisted`、忽略 `reopen_after`，重开机制失效；额度枯竭期 2140 次运行失败留下 2985 个 `attempted+reopen_after=NULL` 策略被 Planner 永久 skip。
- **修复**：去重改 `blacklisted || !retryable(reopen_after 已过)`；`task_finish` 运行失败重开策略（默认 1h 冷却）；`upsertStrategy` 落 `last_task_id`；存量迁移 2110 个失败策略 `reopen_after=0`。
- **效果**：调度恢复（running 0→5+，SRC priority 2 / 清理 priority 5，SenseNova 消耗回升）。文档回填 [05-task §7.25](../05-task.md)。

### 2026-09-26 · 40 号补丁：重试消减（消除「多次尝试同一件事」的 token 浪费）
- **定位**：近 24h 代理 12415 次 429（46% 请求）源于 DSH `retryPolicy.maxRetries=5` + `QUOTA` 可重试——额度耗尽后每请求重试 5 次空转；Bellkeeper 已把 quota-exhausted 判为不可重试，DSH 侧却仍重试。
- **修复**：`settings.yaml` retryPolicy `maxRetries` 5→2、`retryableCodes` 移除 QUOTA（RATE_LIMIT 保留退避）。瞬时 429 仍退避，额度耗尽即快速失败，配合 §7.23 供给闸停派。
- **口径**：目标「多少 token 完成多少任务量准确」，重试/重复即浪费；cached 前缀重传为 API 固有成本（31× 折扣）不视为浪费。文档回填 [05-task §7.24](../05-task.md)。

### 2026-09-26 · 39 号补丁：额度治理第二轮（供给闸停派 + 自动爬坡豁免）
- **复测**：38 号后首轮 5h 额度回血仍在 ~2h 内再耗尽；根因①调度器不感知供给，枯竭期 429 空转（1000+/h）；②`campaign-budget-extend` 自动爬坡（add=预算即翻倍）覆盖人工预算上限（清理#3 50M→100M）。
- **修复**：`task_claim` 前置 `evaluateSupply()`，`supply_factor===0` 停派（实测 6 分钟 0 请求）；`superviseCampaign` 读 `policy.auto_extend`（false 不自动爬坡），清理#3 置 `auto_extend:false`+预算 50M。降级/恢复（L2→L1→L2）全链正常。
- **遗留**：rpm 是请求速率、SenseNova 5h 是 token 计费（单请求 ~50K token），治本靠压缩单请求 prompt。文档回填 [05-task §7.23](../05-task.md)。

### 2026-09-26 · 38 号补丁：额度枯竭治理（分专项优先级/速率 + 派生优先区间生效）
- **背景**：SenseNova 5h 积分池 + OpenCode Go 周额度双双耗尽（24h raw prompt≈1.77B、峰值 271M/h、05–06 全 429）。排查：无全局速率闸、`task_priority_range` 是死配置（derive 恒用 H1?4:3）。
- **落地**：Bellkeeper 渠道速率（sensenova rpm 60/rpd 8000、go rpm 30/rpd 4000，已 reload）；清理专项 #3 budget 100M→50M + derive_cap 8→4 + priority [4,6]，SRC #1/#2 priority [1,3]；`task_derive_intent` 读 `task_priority_range` 决定派生优先级（SRC 先跑、清理后跑）。
- **额度构成**：代理 raw prompt 1.85B vs DSH input 70.6M（≈26×），差额为 cached 前缀重传（cacheRead 235M/24h，87% 命中、31× 折扣）。压缩单请求 prompt 体积（DSH-core 上下文压实）为下一杠杆。文档回填 [05-task §7.22](../05-task.md)。

### 2026-09-26 · 审批超限根因修复（decide 事件有界化 + S5 写动词多目标拆分）
- **根因**：`findWriteVerbHit` 的 URL 正则把逗号拼接的多目标清单当成单个 URL，命中写动词段后把数 KB 清单塞进 `tool-intrusive` 审批的 payload/evidence；`approval_decide`/`withdraw` 又把完整 payload 塞进 `approval.approved/rejected` 事件 → 信封超 8KB → approve/reject 均 `E_BUS_EVENT_TOO_LARGE`，遗留审批 #61 无法裁决。
- **修复**：① exec `findWriteVerbHit` URL 字符集排除逗号 + 命中 URL 截断 512 字（根源）；② approval decide/withdraw 事件载荷经 `boundedEventPayload`(200)/`boundedEvidence`(4000) 有界化（防御，effect 同步执行不依赖事件载荷）。
- **验收**：approval 契约 +1（超大 payload approve/reject 均成功）全绿；线上把误报审批 #61 驳回（httpx 被动爬取 `/order/list` 被误判写动词），`sec-v5-accept.sh` 后续复跑。文档回填 [09-approval](../09-approval.md)、[10-exec](../10-exec.md)。

### 2026-09-25 · 37 号补丁：任务执行视图口径修复（A→B→C-1→D）
- **根因**：`scheduled=exclude` 旧实现 `schedule_kind IS NULL`，把调度器执行的 `once` 任务（含 running）全部排除 →「正在执行」恒空、与 KPI 矛盾；`once` 又被 `task_scheduled` 误当周期任务。审计报告见 [05-task §7.21](../05-task.md)。
- **A** 定时语义收敛 interval-only（exclude=非周期 NULL+once / only=interval；`scheduledTasksAgg` 仅 interval，双后端同步）；**B** 新增 `executingTasks` 独立数据源 + UI 计数改用服务端 total；**C-1** `derive_intent` 一律 once 自动执行 + 存量 575 条死草稿迁移；**D** `task_list.dir` 端到端生效。
- **验收**：task 契约 +2、ui-task 单测 +1 全绿；csai 重启后实测 `executingTasks` running 24、`task_scheduled` 仅 interval 7；`sec-v5-accept.sh --ui-headless` **PASS=80 FAIL=0**。

### 2026-09-25 · 36 号补丁·UI 修复：安全中心页头「刷新」与宿主「登出」重叠
- **根因**：主面板页头右对齐操作组贴视口右缘，与 DSH 全局右上角 Sign out 同位（无头 DOM 实测 refresh 与 Sign out 同在 `x=1552`、y 相交）。
- **修复**：`silksec-ui-panel` 页头追加 `paddingRight: 44` 预留宿主控件位；操作组左移 44px，重叠消除（探测 `overlaps=[]`）。
- **验收**：ui-panel 单测 +1（9/9）；客户端 bundle 热更（无需重启），csai `sec-v5-accept.sh --ui-headless` **PASS=80 FAIL=0**。文档回填 [16-dashboard](../16-dashboard.md)。

### 2026-09-25 · 36 号补丁：exec worker 并发提升 + 认领上限对齐（accept PASS=45）
- **动机**：用户问能否加并发/任务量把 lite（SenseNova flash-lite 专属积分）用完。瓶颈在 `MAX_WORKERS` 硬编码 4。
- **修复**：`SEC_EXEC_MAX_WORKERS`（默认 12，钳 1–32）、`SEC_SCHEDULER_CLAIM_LIMIT`（默认 12，钳 1–32）、`selectDueTasks` 上限 4→32、`task_claim` 契约 `event_limit` 4→32（否则 12 事件撞 `E_BUS_EVENT_TOO_LARGE` 静默空转）+ claim 失败诊断日志；生产 `.env` 双置 12。
- **实测**：12 worker 并发，单 tick 稳定认领 12 条；Bellkeeper 近 600 条 LLM 日志中 501 条 `sensenova-6.8-flash-lite` 200（≈83.5%）——lite 积分已在被消化。8C/16G 下 load ≈22、swap 1.1G，为**本机实际上限**，不再上提（瓶颈在执行侧 CPU/内存）。三池当前为 `priority-health`（与 §7.19 best-weight 有漂移，但对「烧 lite」目标更有利，本轮不改）。
- 文档回填 [05-task §7.20](../05-task.md)。

### 2026-09-25 · 35 号补丁·二段：池策略 best-weight 加权分流（OpenCode Go 额度利用率修复）
- **诊断**：Go 消耗 0 不是额度小（本地桶 120rpm/20000rpd 远超峰值 23rpm；429 全是上游真实限流），而是 `priority-health` 渠道 priority 硬排序——sensenova=1 健康时永不落 Go（priority=3）。
- **修复**：三池切 `best-weight`，Go 成员提为最佳档 w8（DB API + YAML 双写对齐）；实测切换后 5 分钟 18 请求全落 Go（2M tokens），官方 rolling/周/月窗口余量 100%/66%/60%。
- 附带发现：flash-lite 定价表缺行（成本估算影响，待补）；56 个 running 僵尸任务在 75 分钟回收宽限内自然回收。
- 文档回填 [05-task §7.19](../05-task.md)。

### 2026-09-25 · 35 号补丁：额度大提额 + 自动爬坡免人审 + 池治理修正（accept PASS=45）
- **诊断昨晚停摆**：真凶是专项预算闸（#1 烧完 10M 转 reviewing 等审批 #49 空转 9.5h），非 LLM 额度；OpenCode Go 零消耗是 priority-health 硬排序设计（sensenova priority=1 健康时永不落 Go）；glm-5.2「不可用」系 27 号过时结论（今日实测 137 次 200）**保留**。
- **提额**：campaign#1 200M / #2 100M / #3 50M；per-program 闸 budget_max_tokens 2B、max_tasks 5000（用户指示额度充足翻几倍无忧）。
- **自动爬坡免人审**：Supervisor 提请 budget-extend 后 system 自动批准（operator=auto-campaign-budget，`SEC_CAMPAIGN_BUDGET_AUTO_APPROVE=off` 可关），消除人审延迟空转窗口。
- **池治理**：34 号「YAML 移除 deepseek 官方」实未生效（SeedLLMProxyConfig 仅空库播种）——本轮走 DB API 真正移除（6/3/4 成员生效）；**规则：池序调整一律走 DB API，YAML 仅首启种子**。DSH `.env` POOL_MEMBERS 同步移除。
- 三专项全部恢复 active/L2。文档回填 [05-task §7.18](../05-task.md)。

### 2026-09-24 · 34 号补丁（运维）：DeepSeek 官方 API 移出 secagent 三池
- 用户指示「当前托底的不是 deepseek 官方 API，先移出」：`pool-secagent`/`pool-secagent-lite`/`pool-secagent-heavy` 摘除 `deepseek-secagent` w1 成员（7→6 / 4→3 / 5→4），末位变为 OpenCode Go；渠道定义保留备加回；重启生效后实测 25 次请求全部走 SenseNova，官方命中 0。
- 配置不在 git（keeper 线上 bellkeeper.yaml，已备份 .bak-20260924）；文档回填 [05-task §7.17](../05-task.md)。注意：此后无付费托底，SenseNova 全员熔断时直接落 OpenCode Go，耗尽时靠供给归零自动降级兜底。

### 2026-09-24 · 34 号补丁：任务功能权限断点补齐——预算闸在线配置 / 专项归档·改目标·新建 / 任务备注（ui-task 24/24、task/approval 契约通过，accept PASS=45）
- **断点梳理**（模型与 UI 此前都无法触发）：per-program 预算闸调整只读 env 需重启；专项归档/改 goal_spec 域命令未接 RPC；Dashboard 无法新建专项（种子任务场景，如 Campaign #3 建种子）——现已全部补齐。
- **预算闸在线化**：`task_settings` KV 表 + `budgetConfigOf`（DB 优先/env 兜底，source 标记）+ approval 新 kind `task-budget-config`（批准即落库生效，无需重启）+ UI 预算卡（提请走审批）。task_create 停派判定同步改用 DB 配置，错误消息带配置来源。
- **RPC 六端点**：`campaignArchive`/`campaignGoalRevise`/`campaignCreate`/`budgetConfig`/`budgetConfigRequest`/`taskUpdateNote`；UI 对应加「⏏归档」「+ 新建专项」、队列阻塞/恢复按钮。
- **踩坑**：approval effect 动词必须写短动词（`budget_config`）而非 manifest 全键（dispatch 拼前缀后 findCommandDef 失配）；测试 evidence 须 ≥10 字否则先撞 E_SCHEMA。
- 文档回填 [16-dashboard §34](../16-dashboard.md)。

### 2026-09-24 · 33 号补丁：专项治理按钮组——激活/暂停/恢复/审阅/升档全接线（ui-task 21/21，accept PASS=45）
- **根因**：专项 born=draft/L0 是刻意设计（自治需审批背书），但 `campaign_activate/pause/resume/review_pass` 四个域命令本就支持 dashboard actor 却**从未接到看板 RPC**——新建专项永远卡 draft/L0（线上 #3 实证），用户找不到任何治理入口。
- **修复**：RPC 补 `campaignActivate/Pause/Resume/ReviewPass` 四端点；`campaignAutonomyRequest` 支持 draft 提请（升档批准 = 草稿变正式运行通道）；专项卡片按状态出治理按钮组（draft→▶激活+⬆L1/L2、paused→▶恢复、active→⏸、reviewing→✔审阅）。
- 契约 ui-task +1（按状态渲染 + 点击走对应 RPC）；csai 部署 accept PASS=45 FAIL=0。文档回填 [16-dashboard §33](../16-dashboard.md)。

### 2026-09-24 · 32 号方案：任务界面整理（方案 A 状态泳道重排 + 会话专项区块）（ui-task 20/20、ui-session 18/18，accept PASS=45）
- **任务中心五区块**：① 专项常驻最上 → ② **正在执行**（running+blocked 上移，不再淹没在 127 条存量 queued 里）→ ③ 队列（默认只显排队 + **来源筛选**：专项派生/其他 + 状态筛选）→ ④ 定时任务折叠（默认收起留徽标）→ ⑤ 历史近期/存量分界（>24h 的 391 条存量失败独立折叠）。零 RPC/DB 变更，纯客户端过滤。
- **会话「安全产出」**：专项区块置顶**全局常驻**（不按会话过滤；本会话有派生任务打「本会话相关」徽标）；任务行带来源专项 chip——派生子任务（worker 执行无 session_id）在会话中从此可见。
- **定时任务结论**：#19/#37/#100007/#100008 已 blocked 停用可取消（暂缓）；#16/#17 recon 每日**保留**（喂专项 Planner 的 ledger 缺口数据）；#24 周复盘**保留**。
- 文档回填 [16-dashboard §32](../16-dashboard.md)。

### 2026-09-24 · 31 号补丁：额度提额 ×10 + 升档/延长审批通道修复 + UI 升档入口（accept PASS=45）
- **额度**：campaign#1/#2 `budget_tokens` 1M → **10M**（×10 管理员直改 + milestone 审计；分轮爬坡审批单次 ≤×2 不适用）。提额后 30 号补丁自动回升闭环生效：#1 自动升回 **L2**（autonomy_recovered）；#2 自动回 **active**（status_recovered，L1 升 L2 走审批——**request #45 已进 pending 待批准**）。
- **「看不到审批」根因（三重缺口，均修复）**：① reviewing 专项不跑预算段 → budget_exhausted 后自动爬坡提请通道堵死；② approval 的 budget-extend 校验 spent≥80%（台账口径）与窗口口径不一致会误拒 reviewing 延长 → reviewing 豁免；③ campaign-autonomy 校验+effect 限定 draft/paused → 运行中被自动降级的专项**升档提请被拒**且 UI 无入口（用户只能看降级看不到提请）。
- **修复**：superviseCampaign 预算段覆盖 active+reviewing；approval 放宽升档状态约束（已是 L2 才拒）+ effect 对 active/reviewing 只落 autonomy 不动 status（新事件 `task.campaign.autonomy.changed` 声明进契约）；看板新增 `campaignAutonomyRequest` RPC + 专项卡片「⬆L2」按钮（L1 且非 draft/archived 显示，提请后去审批面板批准）。
- **契约**：approval +3、task +1、ui-task +1；22 号旧断言按新语义更新。线上实测 #45 提请成功。文档回填 [05-task §7.16](../05-task.md)。

### 2026-09-24 · 30 号补丁：分原因自动回升 + budget_low 降级留痕修复（task 82/82，accept PASS=45）
- **背景**：29 号方案上线后专项仍未恢复 L2。排查：三类降级（连败/供给归零/预算）均无自动回升通道，每次降级都需人工重批（23 号「降自动、升审批」设计的缺口）。
- **分原因自动回升（tick 步骤 2.8，autoRecover）**：供给型 `llm_restored` 起稳定 15min（`SEC_CAMPAIGN_RECOVER_STABLE_MS`）升回 L2；连败型降级满 1h（`SEC_CAMPAIGN_RECOVER_FAIL_WINDOW_MS`）且无新 rejected 升回 L2；budget_low 型用量回落 <80% 升回 L2；budget_exhausted 型（reviewing）回落 <80% 自动回 active（autonomy 保持 L1，升 L2 仍走审批）。全部写 `autonomy_recovered`/`status_recovered` checkpoint，幂等只回升一次。
- **振荡根因修复**：budget_low 预算闸原先降 autonomy 不写 autonomy_change → 回升后同 tick 又静默降回且无轨迹可回升（升→降→卡死振荡）。两处预算闸补 `autonomy_change(reason=budget_low)` 留痕；回升判据经实测死锁修正为 <80% 对称判据（闸判据会在 91–100% 水位永远升不回）。
- **reviewing 进 tick**：campaign_tick 改为 active + reviewing 都进 tick（预算型自动恢复通道；reviewing 派生段本就被门控）。
- **存量回填**：campaign#1 11:43 的 budget_low 降级人工补插 autonomy_change 回填轨迹。
- **验收**：task 契约 82/82（+4）、rules 41/41、accept PASS=45 FAIL=0；线上实测 #1 连败型自动回升生效（`autonomy_recovered` checkpoint）。文档回填 [05-task §7.15](../05-task.md)。
- **遗留（机制正常，非缺陷）**：两专项窗口用量顶格（#1 911,990/1M、#2 1,040,735/1M）——需人工批准新一轮 budget-extend 或等 7 天滚动窗口回落，恢复全速。#1 自动提请受 12h 防抖抑制。

### 2026-09-24 · 29 号方案：LLM 供给链体检——动态重置时长 + 成员级恢复探针 + 真实额度观测 + 滚动额度窗口 + 池序调整（rules 41/41、task 78/78，accept PASS=45）
- **背景**：用户反馈「SenseNova 积分剩 33 万+、Go 月度窗剩 60%+ 却反复降速/停派」。体检确认多层叠加：Go 5h 滚动窗 429 被一刀切 24h 熔断且无成员级探针；dsh 看不见成员级熔断；降速预警用 Bellkeeper 保守 rpd 桶口径而非真实额度。
- **Bellkeeper（c52fc77/1ea0730/59b1aa3/c584618，已推送+keeper 重建部署）**：① 分类器解析 `"resets in N hours/minutes"` 动态熔断时长（月度维持 24h，无提示默认 5h）；② 成员级 quota 熔断探针（到期 10min 内 1-token 探回池），探针间隔 `probe_interval_minutes` 可配（默认/下限 10min，原 30min）；③ `quota_window_seconds` 滚动额度窗（SenseNova/Go 配 18000=5h，`SetQuotaWindow` Reload 平滑迁移计数）；④ 新增 `opencodego` balance provider（官方 `/v1/usage` 三窗口最紧剩余比例），`channels/status` 暴露 `quota_ratio_remaining`。
- **DSH**：`memberSupplyState` 消费 `member_breakdown_*`（单模型熔断不拖垮整渠道，detail 区分 `member_*`）；真实窗口余量（`quota_ratio_remaining`+`window_ratio` 标记）优先于本地桶做降速预警。
- **池序（DB API + YAML 种子）**：pool-secagent = SenseNova 免费优先（deepseek-flash w7→glm-5.2 w6→flash-lite w5→v4-flash w4）→ **Go v4.1-flash w3 → Go v4-flash w2 → deepseek 官方 v4-flash w1 付费托底**；heavy 补 deepseek-flash w5 + 官方托底 w1。
- **OpenCode Go key 轮换**：旧 key 失效（渠道历史 breakdown_class=auth_failed），新 key 已入 keeper .env + csai dsh .env，直调冒烟 200（kimi-k2.7-code 走 Go 渠道验证）。
- **验收**：Bellkeeper 单测全绿（errors 8 + balance 2 + llmgateway 滚动窗）；dsh rules 契约 41/41、task 78/78；csai 重启 NRestarts=0，accept PASS=45 FAIL=0；线上 checkpoint 连续 `llm_restored(factor=1.0)`；三池冒烟 200（deepseek-flash/flash-lite/glm-5.2 各命中）；Go `quota_ratio_remaining=0.6` 实时可见。文档回填 [05-task §7.14](../05-task.md)。
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
- **遗留（人工项）**：两专项仍 autonomy=1（降级不自动回升，需人工 review 后走 campaign-autonomy 审批重升 L2）；sensenova 套餐若恢复 v4.1-flash/glm-5.2 需把渠道 models 与 heavy 组首档加回。文档回填 [05-task §7.12](../05-task.md)。

### 2026-09-23 · 26 号补丁：dsh-bill 成本归因（spent_tokens 恒 0 修复）+ 存量复核入专项（本地契约 585/585，accept PASS=80）
- **成本归因**：task 域内置 dsh-bill `records.jsonl` 增量解析（字节偏移游标落盘 `dsh-bill-sum.json`，截断归零重扫、半行留待、map 截顶防膨胀）；`task_finish` 在 worker 未上报时按 `session_id` 归因实耗（in+out+cacheWrite，cacheRead 不计；无记录保持 NULL），`task_runs` 增 `spent_tokens` 列同口径。专项预算闸（`campaignUsage` 聚合 tasks.spent_tokens）自此按真实消耗——昨夜「已用 0/500000 却 budget_low 停派」的预估误报类消除（checkpoint #1/#2 实证）。
- **存量复核入专项（review_finding）**：`ledger_coverage_gaps` 新增 `review` 维（status=new 且超龄 48h 的 finding 逐条出列，`SEC_LEDGER_REVIEW_STALE_MS` 可调，priority 35，严重度加权 value，triage 后自然出列闭环）；`compileCampaignPlan` review 维 → kind=review_finding（finding id 进 host 槽、+3 提权、计入多样性保底、lite 档）；`task_derive_intent` objective 模板「[存量复核] finding #N」（confirm 需机器 oracle/proof capsule，证据不足 vuln_reject/false_positive 写 reason）；**scope 复查豁免**——finding id 非主机名，`intentSituation`/`campaignSituationOk` 跳过主机归属校验（program 级 INV-C1 授权/过期校验不豁免）；`vuln_list` actor 补 reactor；`isCoverageRole` 认 `[存量复核]`。
- **验收**：本地契约 585/585（task +2：bill 归因续扫/豁免派生；ledger +1：review 维出列；rules +1：草稿 host=finding id）；csai 部署（rsync + `bundle dsh setup` + 重启 NRestarts=0）+ accept **PASS=80 FAIL=0**。线上实测：专项 tick 正常，campaign#1（美团SRC）pending drafts 已出 2 条 review_finding（finding #672/#405，lite 档）——线上 589 条 status=new（其中 340 条超龄 48h）进入专项消化通道；当前两专项均 autonomy=1（连败降级，合法机制），草稿待人工一键放行或复核后重升 L2。
- 文档回填：[05-task §7.11](../05-task.md)、[11-ledger §1.4.9](../11-ledger.md)。

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
- 验收：ui-task 单测 **19/19**、view-know **10/10**、dashboard-rpc **5/5**；csai `bundle dsh setup` + 重启 NRestarts=0；`sec-v5-accept.sh --ui-headless` **PASS=80 FAIL=0**（72→80：4 静态门禁 + 4 运行时读端点）。详见 [16-dashboard §2026-09-23](../16-dashboard.md)、[05-task §7.10.5](../05-task.md)；方案归档 [archive/24-ops-audit-ui-flow-2026-09-23.md](../archive/24-ops-audit-ui-flow-2026-09-23.md)、[archive/23-llm-supply-throttle-2026-09-23.md](../archive/23-llm-supply-throttle-2026-09-23.md)。

### 2026-09-23 · 23 号方案落地：LLM 供给联动调速 + 任务级选模型（本地契约 575/575）
- **供给哨兵 LlmSupplyWatch（task 域内）**：tick 顺带读 Bellkeeper `groups/status`（成员权重/健康）× `channels/status`（rpd 桶余量），规则层 `decideThrottle` 纯函数算 `supply_factor ∈ {0, 0.4, 1.0}`；`dispatchDrafts` 有效上限 = `ceil(derive_cap × factor)`（观测失败再 `min(cap,2)`），factor=0 时 tick 跳过派生、显式路径报 `E_CAMPAIGN_LLM_EXHAUSTED`（dashboard 放行）。供给归零 L2→L1（不回弹，防震荡）。
- **INV-C11/C12**：派生前供给闸 + 观测失败两阶段（先 fail-open 有界降速，连续 3 tick 转 fail-closed）；checkpoint 新增 `llm_throttled`/`llm_restored`/`llm_probe_failed`/`budget_extend_request`。
- **统一额度面（§3.6）**：`parseCampaignSupplyEnv` 集中解析 dsh `.env` 区块（成员表/权重门槛/降速比例/probe/derive_cap 8/预估 30k/默认预算 2M/模型策略）；无凭据时供给闸自动禁用（不触网）。
- **任务级选模型（§3.7）**：`classifyTaskClass`（lite/std/heavy）+ `selectCampaignModel`（lite→flash-lite / heavy→glm-5.2→Go v4.1 / std→主力）；派生草稿/子任务带 `task_class`（Path B 元数据），`selector=dsh` 时带 `model_hint`（Path A）。
- **预算自动爬坡（步骤 1.5）**：Supervisor 窗口用量达 80% 自动提请 `campaign-budget-extend`（+budget，12h checkpoint 防抖）。
- **看板**：专项卡片增供给三态徽章（正常绿/降速黄/停派红/观测异常黄）。
- 验收：本地全量契约 **575/575**（rules +12、task +8）、ui-task 单测 14/14；已部署 csai（`bundle dsh setup` + 重启 NRestarts=0 + `sec-v5-accept.sh --ui-headless` **PASS=72 FAIL=0**）；线上实测 `campaign_tick` 返回 `supply_factor=1`、正常派生，.env 统一额度面区块已落位。详见 [05-task §7.10](../05-task.md)、[16-dashboard](../16-dashboard.md)。
- **第二轮（步骤 0.5/2.5/4/5 收口，2026-09-23）**：Bellkeeper sensenova 加 `deepseek-v4.1-flash`（权重 7，池权重序列重排）并新建 `pool-secagent-lite`/`pool-secagent-heavy` 分档组（token `allowed_groups` 放行，DB API + YAML 种子）；dsh `SEC_CAMPAIGN_CLASS_GROUPS` 按 task_class 映射组名 + Path A 落 `provider/model`（worker model-patch）——线上实测 lite→flash-lite、heavy→glm-5.2、worker 收到 `{provider:bellkeeper,model:pool-secagent-heavy}`；kimi-code 评估结论暂不入池（编码专用 + 窗口不可预测）。详见 [05-task §7.10.5](../05-task.md)、[23 §五.6](../archive/23-llm-supply-throttle-2026-09-23.md)。

### 2026-09-23 · Campaign 运行期卡点修复（P0–P2）+ 运营复跑
- **P0-1 去重锁死**：Planner 现跳过已尝试策略并前进到新缺口（`strategy_dedupe` 增 `reopen_after`）——修复「首轮后空转 7h」。
- **P0-2 infra 误判**：宿主重启/超时回收的 failed 改判 `escalated`（不计 strategy 连败/不触发 fail-rate 降级）；#2 误降级后已重升 L2。
- **P1**：rework → 策略按 6h 冷却重开（`SEC_CAMPAIGN_REWORK_REOPEN_HOURS`）；rejected → 连败 +1；任务增 `strategy_key` 列。
- **P2**：覆盖缺口按维度分查 + Planner 维度多样性（保证覆盖类入选）；覆盖率开始推进（已派 crawl 任务）。
- 本地全量契约 **563/563**；csai 部署复跑：campaign#1 27 条（running/queued 持续）、campaign#2 15 条，均在派生-执行-验收闭环中。详见 [05-task §7.9](../05-task.md)。

### 2026-09-22 · Campaign 运营迁移（美团/字节 SRC）+ 两处运行期缺陷修复
- **运营动作**：将 `meituan-src`/`bytedance` 的挖掘主线 interval 任务迁移到 Campaign——暂停（blocked，可恢复）vuln/vuln-deep 共 4 个（#19/#37/#100007/#100008），保留 recon #16/#17 与周复盘 #24；两个专项经 `campaign-autonomy` 审批（#25/#26、修正 cap 后 #27/#28）升 **L2 有界自动**（`derive_cap_per_tick=3` 以匹配 500k 预算），已自动派生并执行子任务。
- **运行期缺陷修复 1（ledger `safeQuery`）**：列表类跨域查询经总线在信封顶层返回 `rows`，`safeQuery` 只读 `r.data` → `coverage_metrics`/`coverage_gaps`/`login_blindspot` 对 asset/endpoint 数据全盲、缺口恒空（Campaign L2 Planner 无输入）。归一两种形态 + 补 `asset_list`/`endpoint_list`/`cred_query` 的 reactor 只读 actor；回归新增 1 例。
- **运行期缺陷修复 2（Campaign 子任务可执行性）**：调度器只认领 `schedule_kind IS NOT NULL` 的任务，`task_derive_intent` 对 campaign 子任务改以 `once` 入队，否则 L2 派生任务永不执行；21 号无主草稿仍保持 NULL。
- 本地全量契约 **558/558**；csai 部署重启后 accept 面照常；详见 [05-task §7.8](../05-task.md)、[11-ledger](../11-ledger.md)、[03/04/08](../03-asset.md)。

### 2026-09-22 · 专项 tab 移除（并入任务视图）+ 部署链路修复
- **部署缺失修复**：方案 A（7cafbf6）改动漏了红线流程的 `rsync bundles/dsh/ → /opt/SilkSpool/bundles/dsh/` 一步——`spool bundle` 读运行时副本，导致当天部署装的仍是 9-19 旧模板。已补 rsync + setup + 重启验收。
- **安全中心「专项」tab 移除**（用户决策：专项是任务的一种，不独占 tab）：删除 `dsh-plugin-sec-dashboard.view-campaign.client.js`/test.mjs，manifest / `sec-dashboard-plugin-setup.sh`（VIEW_DOMAINS 7 域）/ `sec-v5-accept.sh`（UI_PKG_IDS 13 面）/ `dsh-ui-surface-smoke.mjs` 同步清理；线上 `plugin --profile web remove @silksec/sec-dashboard-view-campaign` + 孤儿目录清理。campaign 相关 4 个 dashboard-rpc **保留**（ui-task 右侧栏专项区块复用）。
- 验收：组合树无 campaign loader entry；`sec-v5-accept.sh --ui-headless` **PASS=72 FAIL=0**（75→72 = 移除 3 项 campaign 视图检查）；ui-task 单测 14/14。

### 2026-09-22 · 23 号方案 v2 修订：OpenCode Go v4.1-flash 入池 + 统一额度面 + 额度调高
- **Bellkeeper 池调整（已上线）**：`opencode-go-secagent` 渠道加入 `deepseek-v4.1-flash`（1M ctx），pool-secagent 新增权重 2 成员（介于官方 deepseek 与 v4 兜底之间）；渠道状态/直调冒烟/pool-secagent 组冒烟全部通过。
- **关键发现**：Bellkeeper 渠道/池成员为 **DB 持久化**（`llm_channels`/`llm_model_groups`），YAML 仅首启空库种子——变更须走 `PUT /api/llm/config/{channels,groups}/:id`（自动 reload）；本次即走 DB API 路径，YAML 种子同步（Bellkeeper commit cb0572d）。此事实已回填 23 号方案 §2.1 备注。
- **23 号方案 v2 修订**（[23-llm-supply-throttle.md](../archive/23-llm-supply-throttle-2026-09-23.md)）：补 SenseNova 双积分池实测口径（通用池/Flash-Lite 专属池各 60k/滚动 5h + 600k/滚动周，flash-lite 消费 1:1 返赠通用积分；滚动窗口非定点清零——不做窗口对齐猜测）；新增 §3.6 **统一额度面**——全部调速参数集中 dsh .env 单一区块（成员表/权重门槛/降速比例/derive_cap 5→8/新建专项默认预算 500k→2M）；存量专项预算调整尊重 budget_extend 既有铁律（spent≥80% 才准延长），配套设计 Supervisor budget_low 自动提请爬坡（步骤 1.5）。

### 2026-09-22 · 两个 SRC 专项上线（L0）+ 23 号方案设计：LLM 供给联动调速（仅设计）
- 经 sec-bus-cli 创建并激活：`#1 美团SRC 持续挖掘`（meituan-src）、`#2 字节SRC 持续挖掘`（bytedance）——均 L0 台账模式、500k tokens/7d 窗口、stop_conditions 三条，验证命令面与 INV-C1 授权校验在线上生效。
- 针对「专项常驻跑 × pool-secagent 成员套餐额度窗口（kimi-code ~5h/7d、deepseek-secagent 500rpd）」产出 [23-llm-supply-throttle.md](../archive/23-llm-supply-throttle-2026-09-23.md)：LlmSupplyWatch 读 Bellkeeper 既有 `/api/llm/health`+`channels/status`（零改造），规则层 `decideThrottle` 三档供给因子（1.0/0.4/0）叠加成第三道派生闸；额度熔断 → L2 自动降 L1（不回弹，防震荡），恢复人工确认；探测失败先降速后停派（INV-C11/C12）；看板专项卡片加供给徽章。README 已登记为在办专项。

### 2026-09-22 · 22 号方案方案 A：专项并入任务视图（ui-task 五区块）
- 任务右侧栏 tab 顶部新增「专项」区块：Campaign 卡片（状态/自主级别/验收计数/预算/心跳 + 立即 tick，走既有 `campaigns`/`campaignTickNow` RPC）；点击卡片按 `campaign_id` 过滤一次性队列（`task_list` 增 `campaign_id` 过滤参数 + dashboard-rpc `tasks` 透传）；队列行带「专项 <名称>」归属 chip（点击即过滤、可一键清除）；campaigns 查询不可达时区块静默隐藏（降级链）。安全中心「专项」tab 保留（cross 全局视角）。
- 顺带修复 HEAD 既有 bug：`pillNode` 只读 `props.children`，调用方按第二参传 label 导致**真实渲染下徽章文字静默丢失**（定时卡片 phase/下次运行徽章空白）——假 React 测试环境掩盖了该缺陷，已改签名并补注释。
- 验收：UI 单测 14/14（新增专项区块 3 例），全量 client 套件 126/127（唯一失败仍为 HEAD 既有 dashboard-rpc stats 断言，git stash 复测确认无关）；task 域契约 60/60（csai 环境实跑）；csai 已部署重启（active、NRestarts=0），`sec-v5-accept.sh --ui-headless` PASS=75 FAIL=0。

### 2026-09-22 · 22 号方案关账归档（N1–N3 记入待办）
- 二次评审通过验收；N1（`allowed_phases`/phase 标签未贯通）、N2（submit 角色验收判据未实装）、N3（finding id 文本解析可拼接）记入 [05-task §7.7](../05-task.md) 待办（Phase C），不阻塞。
- 按治理规则归档：`22-campaign-task.md` → [archive/22-campaign-task-2026-09-22.md](../archive/22-campaign-task-2026-09-22.md)（内部相对链接已改 `../`，README 索引与各模块「设计真相源」引用同步改指 archive）。纯文档改动。

### 2026-09-22 · 22 号方案 Campaign 评审修复（B1–B7 / S1–S4，契约 557/557）
- **B1（高）**：`schedulerTick` 忙碌路径补 `campaignTick()`——此前仅空转 tick 执行，有任务认领时统筹闭环整体停摆（含 INV-C9 停止条件）。
- **B2（高）**：Reviewer 判据由「done 即 accepted」改为三源真实判据（oracle verdict / capsule 引用 / `vuln_get` finding 复核）+ 覆盖角色成功判定；hypothesis 无 verdict 无推进判 rework。证据 `capsule:`/`oracle:` 优先。
- **B3（高）**：`campaign_autonomy_apply`/`campaign_budget_extend` natural 幂等键纳入 `approval_id`（二度批准/二次延长不再被幂等窗吞）。
- **B4**：campaign 两 kind validate 对 task 域不可达由放行改 `E_INTERNAL` 阻塞（fail-closed）。
- **B5**：回填改为「异步订阅 + tick 补验双通道」（与实现一致）。
- **B6**：`task_block`/`task_cancel` actor 补 `reactor`；Supervisor/归档级联不再冒记 dashboard 人工动作。
- **B7**：删死代码；预估改 `SEC_CAMPAIGN_ESTIMATE_TOKENS_PER_DRAFT`；新增 checkpoint kind `learn_gap`；LearnLink surface 带 vuln_class；`campaign_tick` actor 收敛 scheduler。
- **S1**：设计统一「L1 免审批、L2 强制审批」（22 号文档 §7.1/§8.1 修订）。**S2**：`sanitizeDraft` 收敛草稿字段（优先级由 derive_intent 固定）。**S3**：证据来源接线（覆盖推进以角色判定，无格点差分）。**S4**：`last_tick_at` 升序准轮转。
- 回归：新增「忙碌 tick 也跑 campaign_tick」「二度批准/二次预算延长生效」「campaign kind 不可达 fail-closed」等契约；本地全量 **557/557**；详见 [05-task §7.8](../05-task.md)。

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
- 针对「定时任务对 SRC 挖掘太死板」的痛点，产出 [archive/22-campaign-task-2026-09-22.md](../archive/22-campaign-task-2026-09-22.md)：在 **task 域内**新增常驻统筹实体 Campaign（专项，绑定单/多 Program），以派生→下发→监督→验收闭环驱动现有 Task 子任务；不新增域，拆六个原子组件（Core/Planner/Dispatcher/Supervisor/Reviewer/LearnLink），派生唯一通道复用 `task_derive_intent`（局面编译/scope/预算闸零绕过），自主级别封顶 L2（approval 新增 `campaign-autonomy`/`campaign-budget-extend` 两个 kind）；知识/学习联动走 know 域既有机制的维度扩展（episode/记分加 campaign_id，缺口回灌复用 `know_gap_record`）；含数据模型、状态机、INV-C1–C10、命令/查询/事件、分 Phase A/B/C 实施与契约测试矩阵。README 索引已登记为在办专项。

### 2026-09-22 · 20 号全面检查报告归档（补回填收尾）
- 归档审查发现第四轮修复三处**代码已上线但文档漏回填**，本次补齐：08-scope v5.1（授权时效 `expires_at`/`reviewed_at` 全套——`scope_grant`/`scope_rules_apply` 参数、§1.4.1 算法步 4 过期 fail-closed、新查询 §1.4.5 `scope_expiring`、yml 字段、不变量 I9）；05-task C18 `task_submission_backlog`（命令总表 + 详述）；16-dashboard §1.4（主面板 30 天临期警示行 + 设置页授权时效徽章三态）。
- 21 号方案回填完整性逐项 grep 复核通过（`task_derive_intent`→05、`know_distill_verdict`→07、`vuln_capsule_replay`/`vuln_evidence_flags`→02、`eval_discovery_metrics`→15、`exec_flow_triage`/`exec_vision_triage`→10、覆盖账本/登录态判定→11/04，均与代码动词/actor/错误码一致）。
- 20 号报告补 §11.8 归档记录后移入 [archive/](../archive)；README 索引与本文引用同步改指 archive。纯文档改动，无线上操作。

### 2026-09-22 · 21 号方案 Phase 1/3/4 全量落地（契约本地全绿 + csai 已部署验收 PASS=72）
- **Phase 1（假设引擎 + 第二发现面）**：规则层补 `routeFlowsSignal`（flows 信号确定性打分）/`visionTriageRubric`/`decontextualize`/`distillEpisode`；exec 域 `exec_flow_triage` 查询 + `exec_vision_triage` 命令（判读特征→隐藏功能点线索→H1 草稿）；`exec_grep_result/page_result` 附不可信围栏纪律 + 注入特征标注（§1-5）；eval 契约种子 +2 注入用例；新规则种子 `techniques/miniapp-capture-sop.md`（§1-4，79→80）。
- **Phase 3（推进层）**：task 域 `task_derive_intent`（reactor 内部通道：H1/H2/H3 假设草稿，queued 绝不自动执行，H3 必须引用卡片过局面编译否则 E_TASK_H3_REJECTED）；`strategy_dedupe` 表（strategy_key 幂等去重 + 连败 3 次黑名单）；任务预算闸（§3-4：per-program 周期 token/任务数预算，超限 E_TASK_BUDGET_EXHAUSTED 停派，dashboard 人工放行）；订阅链 endpoint.registered→H2 派生、ledger.coverage.marked 缺口态→crawl/param_enrich 草稿、vuln.signal.rejected→连败回写。
- **Phase 4（Feedback Core）**：know 域蒸馏 reactor（§4-1：oracle capsule confirmed 合流 onVulnVerdict → `know_distill_verdict` → 去特化经验卡候选进 L2 治理链，artifact_id 聚合幂等，初始 low 置信）；记分双裁判（§4-2：`vuln.signal.submitted` vendor_status 事件化——accepted=终极正例 episode、驳回=负例；wins/fails 经 know_scores 重放）；缺口 reactor（§4-3：覆盖缺口态 → know_gaps）；vuln 域 `vuln_capsule_replay`（§4-4：exec 守卫链重放 + 证据比对 match→harden 产 worker 脚本草稿，注册 manifest 唯一通道=人工审批）+ `vuln_evidence_flags` 查询；eval 域 `eval_discovery_metrics`（§4-5 三指标：候选→verified 转化率 / verified 高危占比 / 新漏洞类型）。
- **部署修复**：bundle manifest 补 sec-rules-hypothesis 三件套与 miniapp SOP 种子（Phase 0/2 的 setup 推送缺口——首次部署即发现并已修）。
- 验收：本地契约 rules 27 / task 47 / vuln 61 / know 77 / exec 30 / eval 30 全绿；csai `spool bundle dsh setup` 全量契约门槛通过 + 重启 NRestarts=0 + 14 域注册；`sec-v5-accept.sh --ui-headless` **PASS=72 FAIL=0**。
- 文档回填：05-task（§六 Intent/预算闸/订阅）、07-know（§十三 Feedback Core）、10-exec（§八 第二发现面/注入防护）、02-vuln（§八 打法固化）、15-eval（§九 三指标）、16-dashboard（§九 覆盖/盲区/记分投影）；方案文档归档 [archive/21-benchmark-strikeagent-flash-2026-09-21.md](../archive/21-benchmark-strikeagent-flash-2026-09-21.md)。
- 未完成的运营动作（非代码）：0-1 端点爆发/0-2 参数补全线上跑批（需选部署窗口执行，尊重 QPS/risk）；登录凭据登记（cred_add 人工动作）。

### 2026-09-22 · 21 号方案 Phase 0 第一批：规则层 + 登录态判定 + 业务语义 + 覆盖账本 + 硬降级 + 成本归因（本地契约 511/511）

### 2026-09-22 · 21 号方案 Phase 2：机器验证 oracle + proof capsule + confirm 证据门（契约 517/517）
- exec 域：`exec_oracle_judge` 查询——oracle 五件套（unauthz_diff/idor_diff/info_disclosure_diff/sqli_diff/sqli_time/xss_echo/ssrf_oob）纯函数路由，输入对照特征输出 verdict，**模型无权宣布 verified**（§2-1）。
- vuln 域：`vuln_oracle_capsule` 动词——proof capsule（oracle verdict + 请求对 + 判定输入 + 环境指纹 + 重放命令）落盘 evidence/oracle-capsules/{id}.json（原子写，digest 自洽，§2-2）；`vuln_confirm` 增 oracleCapsuleGate 不变量：`capsule:{id}` 证据须 digest 自洽 + verdict=verified + host 与 finding 一致（E_VULN_ORACLE_NOT_VERIFIED / E_VULN_ORACLE_TARGET_MISMATCH）。
- 契约新增 6 例（capsule 三门 + oracle_judge 路由 + eval 例适配硬降级）；全部 517/517 全绿。
- 依据 [archive/21-benchmark-strikeagent-flash-2026-09-21.md](../archive/21-benchmark-strikeagent-flash-2026-09-21.md) §八 Phase 0（0-3/0-4/0-5/0-6/0-7/0-8）执行；0-1/0-2（端点爆发/参数补全的线上跑批）为运营动作待部署后进行。
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
- 依据 [archive/20-full-inspection-2026-09-19.md](../archive/20-full-inspection-2026-09-19.md) §十一.6 执行剩余全部建议项。
- M1：事务内幂等复检，并发同 key 返回 replay 而非 E_CONFLICT。
- 授权时效：scope.yml 增 `expires_at`/`reviewed_at`；过期 fail-closed（scope_check/exec/asset 三处一致）；`scope_expiring` 查询 + 看板过期/临期告警 + 设置页徽章。
- 批量提交：`task_submission_backlog` 为历史 confirmed 未提交幂等补建提交任务（线上补建 42 条，queued 不自动起 worker，待人工 task_run_now）。
- external_id：findings 增列 + 索引，跨源（cyberstrikeai/vuln-pipeline/外部）去重优先键。
- 文档：17-llm-surface 查询可见口径、15-eval C4 详述节、ui-surface-deps 陈旧条目清理。
- 验收：本地契约 **483 例** + UI 114 全绿；csai 部署后 `sec-v5-accept.sh` PASS=41 FAIL=0。
- 全部检查建议项已闭环；仅余需人工判定（重复发现合并）或设计变更（凭据环境变量化）的项，见报告 §11.7。

### 2026-09-19 · 第三轮修复：代码中危 + 供应链 + 数据卫生 + a11y（csai 已部署验收）
- 依据 [archive/20-full-inspection-2026-09-19.md](../archive/20-full-inspection-2026-09-19.md) §十一.5 执行第三轮修复。
- 安全：沙箱不再整目录挂载 `$HOME`（M6，原暴露 `.ssh`/`fofa.conf`/浏览器登录态）；tools-manager 下载 sha256 校验（M8）。
- 代码：证据发布稳定窗整批化（M5）；approval 增 `effect_state` 独立列消除 `approved_effect_failed` 死逻辑（M9）。
- UI：审批/任务首帧骨架屏（B10）、面板降级提示（B11）、大队列单套 DOM（B12）、审计展开态稳定键（B13）、全表 a11y（aria-sort/role/aria-expanded/aria-pressed/aria-selected/aria-label）。
- 数据：新增 `data-hygiene.py`（program_id 唯一命中回填 / source 归一 / fgs 孤儿清理 / 重复发现报告，默认 dry-run）；候选去重返回 `dedup_reason`。
- 文档：09-approval（effect_state）、10-exec（沙箱隔离）回填。
- 验收：本地契约 466 例 + UI 114 全绿；csai 部署后 `sec-v5-accept.sh` PASS=41 FAIL=0。
- 未处理：存量 43 条 confirmed 批量提交任务、`data-hygiene --apply` 线上执行、授权时效字段、`external_id` 跨源去重、17/15/ui-surface-deps 回填、M1（幂等预检入事务）与 L 类卫生项。

### 2026-09-19 · 产出闭环 + 数据治理 + 任务回收 + DLQ 加固（csai 已部署验收）
- 依据 [archive/20-full-inspection-2026-09-19.md](../archive/20-full-inspection-2026-09-19.md) §十一.4 建议执行第二轮修复。
- 产出闭环：`vuln_submit` 增 `remote_id`；新查询 `vuln_submission_queue`（confirmed 未提交，带 age_days/overdue）；`vuln_stats.signal.confirmed_unsubmitted`；看板 KPI 增「待提交 SRC」六卡；task 域订阅 `vuln.signal.confirmed` 幂等入队 `[提交] finding #id` 任务（phase=review）。
- 数据治理：新命令 `vuln_expire_candidates` + 每 6h 候选 TTL 治理（`noise=1 & status=new` 超 14d → ignored，`SEC_CANDIDATE_TTL_DAYS` 可调）；`vuln_dedup_check` 强制 host/vuln_type 至少其一；retention.sh 增 WAL checkpoint(TRUNCATE) + 0 字节残留库清理。
- 任务/事件：`task_reap` 回收范围扩至一次性任务（原只回收定时任务，僵尸 running 永久滞留）；`exec.run.completed` 订阅者按重试性逐条判定，确定性失败登记后丢弃，不再让整事件重试进 DLQ。
- UI/文档：授权设置工作区下拉与徽章同源（B6）；回填 02-vuln/05-task/16-dashboard。
- 验收：本地契约 **466 例全绿** + UI 114/114；csai `bundle dsh setup` 部署，`sec-v5-accept.sh` **PASS=41 FAIL=0**；线上 outbox **0 dead_letter / 0 pending**（3 条历史死信 + 1 条毒消息全部转 delivered）。
- 未处理（需策略决策）：存量 43 条 confirmed 批量提交、外键历史回填、授权时效字段、tools integrity、UI B8/B10–B13 与 a11y、17-llm-surface/15-eval/ui-surface-deps 回填。

### 2026-09-19 · 全面检查后修复：scope-guard 三处 fail-open + asset owner 列 + UI 健壮性（csai 已部署验收）
- 依据 [archive/20-full-inspection-2026-09-19.md](../archive/20-full-inspection-2026-09-19.md) 执行第一批安全红线与 UI 高优先项修复，全部经契约/UI 测试与线上验收。
- 安全：exec 风险闸改逐目标判定（H1，跨项目不再放行）；exec `checkTarget` 改全项目先 exclude 再 scope（H2，与 scope 域同源）；asset scope 自查 program 缺失改 fail-closed `E_INVARIANT`（H3）；补 `resolve6`（M2）、`_file`/Burp 文件边界（M3）、grep 正则 ReDoS 限流（M4）；`vuln_dedup_check` 强制 host/vuln_type 至少其一（M10）。
- 功能：assets 补 `owner` 列（H4，线上已建列）；info 噪声回填改一次性迁移（M7）。
- UI：asset 视图 ui-core 缺席不再崩 bundle（B1）；同视图 KPI 跳链生效（B2）；报告/知识渲染防御（B3/B4）；报告阅读器竞态守卫（B5）；消除直接组件调用（B7）；补 `.silksec-btn-danger`（B9）。
- 文档：回填 S1/S3/S4/M1/M2/M4/M5/M6；更正初查 S2 误报（Phase 4 http-remote 实已实现）。
- 验收：本地契约 exec 26 / asset 31 / vuln 51 / bus 51 / task 38 / approval 19 / fact 23 / know 73 / ledger 22 / endpoint 25 / scope 15 + UI 114 全绿；`bundle dsh setup csai` 部署，`sec-v5-accept.sh` **PASS=41 FAIL=0**，`silksecagent` active、NRestarts=0。
- 未处理（需策略决策）：提交闭环、候选池治理、任务租约、DLQ 加固、外键回填、授权时效、其余 UI/代码卫生项（见报告 §十一.4）。

### 2026-09-19 · 19-ui-unify 看板 UI 全局统一（U1–U4 + 走查补丁，csai 验收通过，已归档）
- 依据 [archive/19-ui-unify.md](../archive/19-ui-unify.md) 四相执行：U1 基样式表 → U2 面板 chrome+IA → U3 视图收敛 → U4 stats 聚合。
- 结果：csai `bundle dsh setup` + `restart silksecagent`（active、NRestarts=0）；`sec-v5-accept.sh --ui-headless` **PASS=72 FAIL=0**（含两条新门禁 + 13 面 headless health/RPC）；本地 UI 单测 **119 例全绿**。
- 变更：ui-core `ensureBaseStyles()` 基样式表（§2.2 十类，唯一 CSS 源）+ viewRegistry `group` 协议 minor + opIcon back/refresh/size + fmtNum + 表格统一单行省略等高；
  ui-panel 改名安全中心 / 五 KPI + 库存副条 / 「更多」二级导航（知识·学习·报告·审计 group=more）/ 去前置图标；
  视图内联 pill+cursor 收敛为 `.silksec-chip`；dashboard-rpc `stats` 改壳聚合、删 `assetDb.stats` 直查；
  `asset.overview` 增 `by_type`；`sec-v5-accept.sh` 新增 `ui-shared-css-unique`/`ui-class-defined` 门禁。
- 走查补丁（操作者反馈五条）：① 去侧栏/页头图标（同层级纯文字）；② 会话消息动作改 26×26 图标钮 + Tooltip；
  ③ 待审批/任务 KPI 无会话 seat 时经 secUiBus 弹 Modal（`openApprovalCenter`/`openTaskCenter` 去掉失效的主面板回退）；
  ④ 任务工作区筛选选项改 workspaces ∪ programs 全量（不随筛选塌缩）+ `.silksec-chip`；⑤ 全表 `td` 单行省略 + 固定列宽。
- 回填：主题文档 §5.1（去图标）/§11.8/§11.9、16-dashboard §四.8/§1.6/§1.7、CONTEXT「安全中心」、ui-surface-deps；
  结论回填后本文移入 [archive/19-ui-unify.md](../archive/19-ui-unify.md)。

### 2026-09-19 · 文档治理规则 + PROGRESS 瘦身（本会话）
- [README.md](../README.md) 增「文档治理规则」：**已完成的临时文档强制归档**、README 为正式文档唯一索引、临时文档收尾必须回填相关正式文档、系统更新即时回填、防漂移。
- PROGRESS.md 瘦身为「当前状态 + 最近结果 + 通用规则」；历史整体迁 [archive/progress-history.md](../archive/progress-history.md)。
- 性质：纯文档整理，无线上改动。

### 2026-09-19 · 文档漂移排查 B5 闭环（B1–B5 全部完成）
- proxy / fgs / eval 三域按 manifest 与 csai 运行态对齐；修复 fgs `finding_add` 悬空引用与迁移脚本过期注释；清理 csai 四处过期重复测试副本。
- 契约 proxy 17/17、fgs 21/21、eval 29/29；`bundle dsh setup csai` 重部署 + 重启，`sec-v5-accept.sh` PASS=39 FAIL=0。

> 更早结果（B1–B4 文档漂移、兼容别名层移除、旧版统一清理、UI 原生面 P0–P7、DSH 0.1.5-rc.2 升级、自学习 L0–L6、Phase 1–4 全部节点）见 [archive/progress-history.md](../archive/progress-history.md)。

### 2026-10-01 · 27号续接：可信执行链、费用归因与失败重试（本地，未部署）

- 保留此前目标/请求/完整H2队列增量。WP02新增统一HTTP入口，逐跳检查指定Program、固定代理/解析地址、隔离凭据并限制时间/响应量。
- 首个owner-only JSON读取验证器实际执行10个身份/对象/正反/重复对照；本地漏洞可确认，修复有反证，公开/失效身份/代理故障保持未知。可信判定签封落盘，capsule只接受decision_id；另一个finding、变更请求/证据/契约不能借用。
- 旧run/旧capsule不能自动确认；人工独立审校需operator、依据、步骤和影响。关闭关键词复现；登记不能自填已确认置信。结果page/grep同时封住软/硬链接越界读宿主文件。
- WP03费用按task/run独立记账并累加，迟到补账/重复去重/事务回滚/运行史裁剪后去重已验证；NULL与零区分，共用session总账拒绝重复归因。worker注册原子匹配认领；回收每批最多4项并逐项发布一次结束事实。
- WP05入队假设失败后默认冷却1小时，最多自动重试2次；其他派单入口不能绕过冷却与上限，旧回调不解除新任务关联。保留每轮任务、运行史与上限原因。
- **验证：task/exec 157/157，全域659/659，fail=0**。使用临时bus/SQLite、本地HTTP和CONNECT代理；node语法及diff空白检查通过。正式契约05/10及27号§10.6已更新；日志 `/tmp/secagent-27-wp03-all-contracts.log`。未远程操作、部署或安装真实项目验证契约，真实检出/学习收益未知。
- 下一步：WP03全局lease/ack、迟到账单轮询、预算窗口/预留及费用投影重算；WP05 unknown/旧手工策略重开及旧分页；WP02还需真实接口适配、凭据刷新、属性重放及其它漏洞族。全方案未完成不再阻止阶段提交；阶段提交`38deb2b`已推送，下一发布门槛为备份、恢复预演与小批部署。不可回退到弱确认来处理能力缺口。

### 2026-10-01 · 文档治理与发布节奏

- 18迁移路线图归档，00–17保留为常驻契约；历史引用同步修正。旧最近结果迁入进度历史，当前不再列迁移DoD待办。
- 用户已同意闭环分批提交、发布验收后分批部署；27号§15为当前发布检查点。当前累计增量659项测试通过，发布模板清单含关联域；阶段提交推送后继续备份与恢复预演、小批运行验收。PATH spool只读采样确认服务active、DSH=0.1.7-rc.2、无运行中task/worker（queued=6），尚未发布。

### 2026-10-01 · 常驻NAS备份、维护入口与发布加速（维护已部署，27号业务增量未部署）

- 续接原会话：TrueNAS独立数据集配额256GiB，SFTP专用账号、加密去重restic；NFS因csai宿主禁止挂载已撤销。密钥在管理机keys目录托管，未入库。
- 首份成功备份覆盖5.42GB/39库85.48秒、恢复6.86秒；最终完整范围定时备份（含3工作区）5.65GB/40库306.41秒、新增121MB，快照`a7c87eab…`；NAS读回40库摘要/完整性验证19.56秒。失败的root证书读取不会记作成功；定时服务用受限资源root执行。常规备份各库分别一致，不能替代发布冻结点。
- 每6小时备份（留8份）、每周校验/恢复预演/prune、每日安全清理、每15分钟健康检查，6个timer均已启用；旧backup/retention timer已停用。旧本地图快照留2份，已清理1,855,012,864字节；results/flows/evidence/sessions不按目录年龄清除。
- 常规备份增加 `extra_roots`，覆盖现有三个外置项目工作区及其中SQLite；新统一入口 `silksec-ops.sh` 覆盖status/backup/drill/cleanup/restore-copy/preflight及原freeze/release命令。恢复到新目录并保留数据库权限；NAS超时输出健康失败；冻结自动暂停并恢复维护单元；测试临时目录随运行结束回收。
- 验证：维护7项、快照6项、root冻结10项、root发布恢复19项均通过；Go CLI及新增NAS RPC边界通过，构建/语法/diff通过。Go tools全包既有uptime测试失败已用HEAD覆盖对照复现，不计为本批通过。
- 旧发布目录 `20260913-rc2` 已归档、完整读回校验并删除（快照`1725625f…`，逻辑97.77GB、新增4.82GB，removed=true）；最新 `20260926-017` 保留。磁盘由27%降至17%，可用702→796GiB。全域659/659通过，57表的task/endpoint隔离迁移行数不变、完整性ok；预检含schema首次130.21秒、命中缓存3.56秒（约36.6倍；schema每次仍重验；前轮95.50→3.58秒）。
- 生产服务active、MainPID=922156、NRestarts=0；磁盘使用约17%、可用约796GiB，NAS正常，6个维护timer有效。未重启主服务，未升级0.2.0、未发布27号业务增量。
- 维护代码与文档阶段提交 `27b592d` 已推送 origin/main。
- 契约与命令见[18号备份与维护](../18-backup-and-maintenance.md)。容量告警目前落systemd/journal，外部通知尚未接；证据持续增长仍需引用感知归档/扩容，不能宣称磁盘永不耗尽。

常规备份运行边界补充（2026-10-01）：外置工作区内 Chromium `.shared-browser-profile` 的32KiB性能统计库被浏览器独占锁定，导致一次补跑120秒超时（失败未淘汰旧备份）。宿主配置以 `exclude_paths` 显式排除该可重建运行目录，源仍原位保留；浏览器登录态不在常规备份恢复范围，完整冻结点沿用原覆盖清单。真实仓库测试持有排除库的 EXCLUSIVE 锁，验证业务SQLite及项目文件仍可备份恢复、运行目录不进入快照。


### 2026-10-01 · 18号备份契约与每次变更前准备

- 新建常驻 [18-backup-and-maintenance.md](../18-backup-and-maintenance.md)，集中维护NAS机制、覆盖/排除、密钥托管、北京时间/UTC定时表、保留清理、恢复与发布预检；01号只保留指针。正式索引与领域语言更新为00–18。
- 原18号迁移路线图改名为 [archive/migration-v4-to-v5.md](migration-v4-to-v5.md)，保留历史正文及Phase验收，修正导航/当前引用；不重开迁移。
- 新增 `silksec-ops.sh prepare-change --change ID`：同一维护锁内完成新备份和该snapshot的SQLite恢复校验，成功才发布本次回执；备份/校验失败清掉旧回执，锁冲突75不得放行。
- CLAUDE、00全局契约、本文件及27号发布流程统一要求：生产更新/配置/迁移/重建/非例行清理前先备份，早于远端模板上传；本地编辑/只读巡检不触发，例行清理与应急恢复有独立规则。底层spool无全局自动拦截，执行者必须调用门禁；新冻结与应用验收仍保留。
- 本次部署前使用旧入口先执行备份/恢复：snapshot `0fd330c0…`，40库120.53秒/7.34秒通过，业务主进程PID=922156、NRestarts=0。新入口已部署验收：change `20261001-backup-contract-18`、snapshot `d5758fa6…`，40库备份32.38秒/恢复6.77秒，总计约41秒；主服务未重启，27号业务增量未部署。
- 验证：维护10/10通过（真实restic备份/恢复、失败无回执、CLI锁冲突75）；语法/diff检查通过，20处新旧文档链接有效，归档迁移正文保持不变。


## 2026-10-01 · 27号首批部署结果归档

### 2026-10-01 · 27号累计业务增量部署与分阶段运行

- `2c40d3f`＋`38deb2b`累计9模块/32落点已部署，DSH固定0.1.7-rc.2。新冻结`777e3e6b…`覆盖6根，旧/新版恢复应用启动通过；新增3表、核心旧业务行不变。
- 验收：远端全域659/659、57表schema、隔离worker14项、生产UI80/80；6服务active，PID=975839/NRestarts=0，journal err=0。真实运维任务103394在50.795秒done，claim/worker/run/session匹配、独立账本一行、待恢复收尾0。
- **放量门槛未通过**：任务声明20,000 token，实际49,626（3条账单，首个输入43,869，非重复扣费）。当前预算仅事后观测，WP03执行前预留/上下文费用检查仍缺。Campaign1/2/3已通过正式命令暂停，预算不变；认领/worker并发12→1。下一批先补WP03硬预算/lease/ack与迟到账单，通过后单Program恢复再扩大。
- **效果边界**：生产verification-profiles为空，真实读取验证缺接口契约/双身份，正确返回能力缺口；本批未宣称新增真实漏洞、真实请求覆盖或全方案关账。
- 本批NAS门禁及部署后备份均通过；最终snapshot `df226da14b56c7d0e9b633845b29aced5384bb23f58a2541f192c68cf2b4044c`，40库33.21秒/恢复6.51秒。完整证据与D0–D3检查点见[27号§15.3](27-business-quality-and-capacity-plan-2026-09-30.md#153-业务增量分阶段发布2026-10-01阶段验收完成)。冻结到恢复窗口约47分58秒，含恢复/应用预演。
- 过程失败如实保留：首次冻结被本轮mode=ro查询改动副本SHM干扰，自动恢复后重做成功；新增路径/字段差异诊断，快照7/冻结10/发布19项远端root回归通过。旧版应用与全域测试并行时一次RPC超时，串行重跑通过。18号已补充禁止查询待校验SQLite树。


### 2026-10-01 · WP03预算增量部署与三档只读试运行

- 执行前预算预留、worker启动ACK/注册槽位、模型请求预算门禁、持久迟到账单对账及Campaign费用投影已部署，DSH保持0.1.7-rc.2。新增3表；三表所有权声明已完成新冻结/恢复及隔离应用验证。
- 验收：远端全域662/662、60表schema、隔离真实worker15项、生产UI80/80。旧/新应用均可读取15域、1,846历史session、3工作区。
- 三档生产只读任务：103395/20k业务首请求拒绝、标题调用报告0；103396/150k消费44,986后下一请求被估算拒绝；103397/300k对照done、49,217token/3次请求。均完成账本/预留收尾；没有提高默认预算或Campaign额度。
- **继续暂停放量**：输入费用仍是估算，不能保证供应商计费绝对硬上限；默认150k尚不能完成只读闭环。下一批缩减工具/人格/历史上下文，校准实际输入成本，再验证默认预算后单Program恢复。C1/C2/C3继续暂停、并发1，预算不变；真实接口验证配置仍为空，未宣称新增漏洞。
- 冻结/恢复、失败重试、三档费用证据见[27号§15.4](27-business-quality-and-capacity-plan-2026-09-30.md#154-wp03预算增量部署2026-10-01默认预算放量门槛仍未通过)。首轮恢复点9c7457fe…，部署后NAS a82eff64…；最终声明恢复点145a4c2f…，生产PID989756/NRestarts0。


### 2026-10-01 · WP03输入计量校准上线与默认预算验收

- 工具历史定义去重、独立system计量和cacheRead费用补计已部署（`25ddb1f`＋`ddca92a`），DSH保持0.1.7-rc.2。未删工具能力或提高默认预算。
- 默认150k生产任务103399完成一次bus_status后回复WP03_OK，40.679秒done；含模型回退的有效费用91,527（其中缓存读取44,160），原始账单/worker/run汇总一致，预留settled。20k任务103398业务首请求被拒绝，后续标题请求报告0。
- 验收：全域662/662、63表无新增、旧/新版隔离应用通过、worker16项、生产UI80/80；PID999090/NRestarts0、六服务active、journal err=0，running任务/worker/在飞预留/pending-finish均0。
- **保持暂停放量**：默认只读闭环通过，供应商绝对硬计费边界及真实目标长任务未验证；逐账单watch370项仍在轮转，本批run汇总已核验但明细尚未轮到。C1/C2/C3费用采样100,433,117/115,849,355/50,427,824，C3已超50M；额度不变、Campaign全部paused、并发1。verification-profiles仍为空。
- 备份与恢复：完整冻结be110d0c…，停写约82分56秒（含预演与会话中断），北京时间21:46恢复；部署后NAS239b4800…，40库168.44秒/恢复10.50秒通过。验收脚本读错字段及端口未就绪的失败均保留，证据见[27号§15.5](27-business-quality-and-capacity-plan-2026-09-30.md#155-wp03输入计量与缓存费用校准2026-10-01已部署默认预算只读闭环通过)。


### 2026-10-02 · WP03失败usage费用边界修复上线

- `3fd0738`修复error/aborted/流异常/消费取消时误把usage零值或部分值视作最终费用；保留未知预留，已报告费用仍计入实耗下界。普通迟到账单不能自动释放无最终证明的未知预留。
- 验证：worker17/17、task121/121、全域663/663；新冻结六根恢复、63表、旧/新版隔离应用、真实worker17项和生产静默冒烟通过，UI80/80。默认150k任务103400仅一次bus_status后WP03_OK，3次请求92,945 token，账本一致、预留settled。
- 生产PID1009736/NRestarts0、六服务active、journal err=0，无running任务/worker/未知或在飞预留/pending-finish。北京时间01:03:06恢复，停写42分39秒；首次冻结RPC超时、刷新冲突、旧版应用超时及canary目标幂等命中均记录并保留失败报告。
- 部署后备份：NAS136ff53f…，40库207.10秒/恢复6.75秒通过；维护timer全部恢复，27项关键证据已封存。
- 继续暂停放量：C1/C2/C3采样111,486,173/140,099,322/75,639,747，C3超50M；额度不变、并发1。历史watch370项中326项无当前账单，不能宣称历史费用完整；供应商最终结算证明及unknown解锁协议仍缺，真实接口verification-profiles仍为空。详情见[27号§15.6](27-business-quality-and-capacity-plan-2026-09-30.md#156-wp03失败usage与历史账单核对2026-10-02已部署验收)。


### 2026-10-02 · WP03历史费用证据审计完成

- 新增独立只读`dsh-cost-audit.py`，经PATH spool在内存读取生产；9/9合成测试通过，三次生产核对投影一致，最终CLI验收通过。未上传/部署生产代码、未写库、未触发模型；服务PID1009736/NRestarts0、六服务active、当前journal err=0。
- watch377：34项原始账单同额、327缺当前账单、16项保留账本高于当前文件。缺账中315项通过run/session/cwd/时间校验，记录用量下界1,521,244,959 token；10项归属歧义、2项时间越界排除。下界与旧累计可能重叠，不能直接补扣或作为最终供应商费用。
- 确认dsh-bill默认只保留20,000条明细，rollup不保留session归属；记录也缺供应商请求ID及finish原因。315项还含53次标题无usage、79次失败/不完整请求、3次缺/非法usage；全部`final_cost_proven=false`。全体3,626个run中2,257缺session、2,571缺费用，未由本工具自动修复。
- Campaign1/2/3继续paused，账面111,486,173/146,935,913/90,571,011，额度不变、并发1；12项预留settled，当前running任务/worker/pending-finish均0。既有定时任务在上一批后新增6次执行，Campaign暂停不等于全部定时任务停止。
- 证据：管理机`out/secagent-audits/20261002-wp03-history/`；最终报告SHA256 903eefcf…，详见[27号§15.7](27-business-quality-and-capacity-plan-2026-09-30.md#157-wp03历史费用证据审计2026-10-02独立工具已完成生产只读验收)。下一步315项下界与旧累计去重核对、保原账的补账流程及未来请求最终结算标识；不重新重复缺账轮转检查，不解除unknown或恢复外部探索。WP03及全方案未关账。


### 2026-10-02 · WP03历史用量补账部署验收完成

- 新增system治理命令`task_record_cost_evidence`、追加证据表及冻结窗口执行器。315项审计证据核对后：247项满足无未归属旧累计并在生产补账，19项已有账本覆盖，49项任务16/17/24旧累计冲突保留。生产新增已知usage下界1,290,916,472 token，247项整批重放增量0；不是供应商最终费用，不解除unknown。
- 验证：task123/123、全域665/665、审计10/10；生产数据库独立副本整批补账/重放通过。新冻结六根恢复、63旧表schema及唯一新增表task_cost_evidence、旧/新版应用、worker17项/15次fixture请求、生产静默冒烟与UI80/80通过。补账前后60表/非费用字段投影相同，12项预算预留不变。
- 当前DSH0.1.7-rc.2，PID1056912/NRestarts0、六服务active、journal err=0，无running任务/worker/pending-finish。北京时间19:31:53恢复，停写约61分29秒；目录权限与旧版/worker RPC超时失败报告保留。
- C1/C2/C3账面176,585,747/573,019,056/91,204,791；C2/C3超额。预算200M/200M/50M不变，全部paused、并发1，未恢复外部探索。本批没有生产模型canary，执行链沿用实际隔离worker验收。
- 恢复保障：变更前NASd7122308…；冻结7bf493ae…；部署后NAS34bb4b0a…，40库211.34秒/同快照恢复6.56秒通过。六维护timer与proxy-refresh.timer恢复；46项发布证据封存，源码与5项生产安装清单一致。
- 下一步：49项旧累计冲突、10项会话歧义、2项时间越界和watch之外无session历史仍未知；未来请求标识/终止事实及供应商最终费用证明仍待补。WP04真实请求与WP02接口前置可独立推进。详情见[27号§15.8](27-business-quality-and-capacity-plan-2026-09-30.md#158-wp03历史用量补账2026-10-02已部署及生产补账验收完成)，本批闭环完成，WP03及全方案未关账。

### 2026-10-02 · WP03逐请求终止证据部署验收完成

- 新增受保护worker-requests.jsonl，逐请求保留准入、usage、当前供应商响应标识和终止事实，强杀保留已落事件；错误/取消未知不释放，写盘失败拒绝后续准入。全部事件final_cost_proven=false，不把responseId当最终费用证明。
- 本地worker24/24、exec40/40、全域665/665；新冻结六根恢复、当前64表无新增、新旧应用及worker19项/15次fixture请求、生产静默冒烟和UI80/80全部通过。fixture并发编号重复、RPC超时等失败报告均保留。
- 生产只读任务103401仅一次bus_status后WP03_OK；3请求12事件/3响应ID，92,741 token（缓存读取43,776），原始账单/worker/run汇总一致，unknown/denied/reserved均0。逐账单表尚待watch轮转，未声称全明细补齐。
- 北京时间21:07:20恢复，停写39分25秒；PID1065354/NRestarts0、六服务active、journal err=0，无运行任务/worker/待收尾，13预留settled；六维护timer及刷新timer active。
- 恢复保障：变更前NAS42ab0f22…、冻结69b4899d…、部署后NAS9dec3a22…（40库199.13秒/同快照恢复6.90秒）；58项关键证据封存，覆盖/排除范围不变。
- C1/C2/C3账面176,585,747/573,019,056/91,204,791、预算200M/200M/50M不变，全部paused、并发1。下一步补错误请求供应商标识、内部HTTP重试事实及可信最终结算来源；历史缺口和WP04/WP02前置仍在办。详情见[27号§15.9](27-business-quality-and-capacity-plan-2026-09-30.md#159-wp03逐请求终止证据2026-10-02已部署及生产验收完成)。


### 2026-10-02 · WP04 HAR被动导入部署验收完成

- 源码`21b4428`已提交推送并部署，DSH仍0.1.7-rc.2。新增HAR预览/分页导入、原始条目与正文证据、嵌套参数路由、显式身份对象绑定；重复导入幂等，失败不覆盖证据，HTTP200不判业务健康。
- 本地/远端全域671/671、六根恢复/64表预检、新旧应用、隔离endpoint/task165/165、worker19项、生产静默冒烟及UI80/80通过。旧版RPC超时、UI两次启动时序失败及首次冻结撞代理刷新均保留。
- 生产空HAR预览/摘要拒绝验证通过，未导入合成业务请求，request观测仍0。真实20–50份健康模板、账号/对象归集与逐族验证契约仍待办；WP04和全方案未关账。
- 北京时间22:49:00恢复，停写36分56秒；PID1073682/NRestarts0、六服务active、journal err0、七timer active；无running task/worker，13预留settled。
- 恢复保障：变更前NASa09b15f6…（40库35.29秒/恢复6.97秒）、冻结4691cef5…、部署后NASe01e75ca…（40库216.34秒/同快照恢复6.90秒）；55项证据封存，覆盖及排除范围不变。
- C1/C2/C3账面176,585,747/576,737,025/100,639,998，预算200M/200M/50M不变，均paused、并发1；费用最终证明/历史未知仍未闭环。接续真实请求采集与WP02前置，详见[27号§15.10](../27-business-quality-and-capacity-plan-2026-09-30.md#1510-wp04-har被动导入2026-10-02已部署验收)。

### 2026-10-03 · WP04浏览器被动采集部署验收完成

- 源码`e5452cc`已提交推送并部署，DSH仍0.1.7-rc.2。独立采集脚本附着受管CDP，锁定单页面/精确origin/Program；限时限量、每秒复核Scope、私有journal及HAR回执，不导航或重放。失败/未完成原件禁止导入可派发队列。
- 本地/远端全域672/672、六根恢复/64表预检、新旧应用、隔离endpoint/task166/166、真实Chromium＋采集核心9/9、worker19项、生产静默冒烟及UI首轮80/80通过。旧版两次RPC超时、worker一次超时和浏览器夹具环境冲突均保留；生产守卫与超时阈值未变。
- 北京时间11:09:30–12:03:48停写54分19秒，已恢复；PID1097006/NRestarts0、六服务及七timer active、journal err0。无running task/worker/pending-finish，19预留全部settled；业务表切换前后摘要一致。
- 恢复保障：变更前NAS5f14f119…（40库40.41秒/恢复7.08秒）、冻结aa07b266…、部署后NASb05227e6…（40库185.70秒/同快照恢复6.91秒）；96项证据封存，覆盖及排除范围不变。
- C1/C2/C3账面176,585,747/583,573,616/110,075,205，预算200M/200M/50M不变，均paused，worker及认领上限均1。未开始真实采集，请求观测仍0；待试点项目/业务入口、身份/自有对象，再接20–50份健康模板与WP02前置。费用最终证明/历史未知及全方案仍未关账，详见[27号§15.11](27-business-quality-and-capacity-plan-2026-09-30.md#1511-wp04浏览器被动请求采集2026-10-03已部署验收)。

### 2026-10-03 · WP02读取前置检查本地验证完成，待部署

- 接续上一会话的exec实现和测试：新增无需Finding的双身份读取前置入口，最多8次GET，不执行A读取B；逐项校验身份、私有对象与正负对照，前置失败立即停止。正式验证复用检查，失败只记inconclusive。
- 签封前置回执与漏洞判定分离，一小时失效；查询重验HTTP证据、请求版本、契约及授权，不重放请求。恢复测试通过重建总线的公开查询入口完成。
- 修复无Finding测试误查不存在findings表的夹具断言。全域688/688通过；随后仅补强恢复测试，最终exec56/56通过，生产代码字节未变；git diff --check通过。日志在 /tmp/secagent-wp02-preflight-all.log 与 /tmp/secagent-wp02-preflight-final-exec.log。
- 契约见10号§1.3.10，批次见27号§15.12。本批仅本地实现/验证，尚未部署，未运行真实目标请求。生产沿用§15.11基线，Campaign继续暂停。
- 后续发布须按18号完成本次prepare-change、冻结/恢复与隔离验收；真实试点仍缺已授权项目/入口、测试身份和自有对象，费用最终边界仍未闭环。


### 2026-10-03 · WP02读取前置检查部署验收完成

- 源码`6bd68c0`已推送并部署，DSH仍0.1.7-rc.2；无需Finding的读取前置入口最多8次GET，无A读取B；逐项失败即停，签封回执不能用于漏洞确认。正式验证复用前置检查，失败仅记inconclusive。
- 本地/远端全域688/688、最终本地exec56/56、六根恢复/64表、新旧应用、隔离exec/endpoint/vuln166/166、worker19项、生产静默冒烟、UI重跑80/80通过。首轮隔离目录穿越权限和UI连接拒绝均保留失败报告，修正目录/确认监听后原门禁通过。
- 北京时间19:12:54–19:49:46停写36分52秒，恢复无错误。PID1112833/NRestarts0、六服务/七timer active、journal err0；running task/worker/pending-finish均0，19预留settled，业务表摘要未变，worker/claim上限均1。
- 变更前NAS2b3570b2…（40库38.68秒/恢复6.62秒）、冻结9e229e51…、部署后NASbd1bd0da…（40库249.01秒/恢复6.48秒）；覆盖/排除不变，64项证据已封存并拉回验摘要。
- 三个Campaign暂停、费用及额度保持发布前值；未安装真实项目契约或发真实业务请求。下一步需明确试点项目/入口、测试身份与自有对象，采集20–50份健康模板；供应商最终费用证明与历史未知仍待办，WP02/WP04及全方案未关账，见[27号§15.12](27-business-quality-and-capacity-plan-2026-09-30.md#1512-wp02读取实验前置检查2026-10-03已部署验收)。


### 2026-10-04 · 试点范围确定，完成只读选点与存量复核队列

- 用户确定美团SRC、字节SRC授权范围内S级资产；后续不再重复询问项目选择，测试身份/自有对象仍待补。
- 生产只读核对：美团48条S级资产行/40个主机，字节419条/384个主机，均匹配现有scope；113条无Program的S级资产排除。根路径历史200分别18/22个唯一主机，尚不能视为健康请求。
- 复核集合采用status或confidence任一confirmed，共47条（44条status confirmed及3条new/confidence confirmed）；28条旧导入，均缺task_id。保存私有原件、逐项待复核清单及摘要，不修改技术结论。
- 证据位于out/secagent-audits/20261004-wp06-evidence-review/；本批只读，无生产写入、无目标请求、无代码发布。Campaign继续暂停；下一步核验所选业务入口、身份/对象与47条旧证据，见[27号§15.13](27-business-quality-and-capacity-plan-2026-09-30.md#1513-wp04试点范围确定与wp06复核清单2026-10-04只读准备)。


### 2026-10-04 · WP06旧证据追溯第一批完成

- 47条复核清单中20条有ID证据目录；补查具名目录与run引用后23条建立文件关联，24条尚未定位，不能判丢失。三个evidence根307文件，扩大索引54,650文件。
- 已读取37份复核说明、26份定向原件及3份找回材料；#438/#439、#945、#679/#682的旧格式引用已定位。原件、逐项映射、复核报告及47条队列保存于本地受限审计目录，14项SHA256封存。
- 15条记录补记技术判据缺口：CORS前置不足、公开客户端配置、OpenAPI与实际权限混淆、不同接口认证要求不足以证明越权等。未修改生产技术结论，不以缺证判误报，不以文件存在计真实漏洞。
- 全程只读，无目标请求或发布。下一步核验#6/#7/#22读取安全属性及#361/#366/#390信息泄露边界，继续旧源追溯；美团/字节授权内S级试点不变，Campaign继续暂停。见27号§15.14；WP06及全方案未关账。


### 2026-10-04 · WP06六条原始材料复核完成

- 只读核验#6/#7/#22/#361/#366/#390共51份文件，保存原件及逐项检查，18项SHA256封存。
- #6材料支持历史敏感记录可读，三份旧哈希匹配；计数响应406，不能支持12万总量，rider_users已有权限拒绝。#7/#22正文存在，仍缺原始发出请求与身份关联。
- #361/#366/#390材料支持历史内部调试信息暴露；#361代理鉴权失败重放与成功原件分开。#390同请求正文哈希一致，异请求差异仅随机路径。
- 47条队列更新，历史事实不计当前新增独立漏洞；无生产状态修改、目标请求或发布。下一步补#7/#22原始命令身份关联与剩余旧证据，见27号§15.15；Campaign继续暂停，全方案未关账。
