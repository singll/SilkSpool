# 19 · v5 文档评审、运行态对照与修正方案

> 评审日期：2026-09-06
> 评审对象：`doc/secagent/v5/` 全部文档
> 对照对象：`doc/secagent/archive/` 运行态文档、`bundles/dsh/templates/` 版本受控模板、csai 线上 `silksecagent`
> 线上取证方式：全部远程检查通过 PATH 中的 `spool exec csai ...` 完成；本报告不修改 csai，不重启服务，不重建容器。
> 文档性质：评审基线与修正方案，不替代 00-18 原设计稿。v5 仍处于设计阶段，不能把“设计已写”当成“线上已实现”。

---

## 一、执行结论

### 1.1 总结判断

v5 的方向是正确的，且已经覆盖了 v4 的主要结构性病灶：

- 候选池从 `noise` 可见性副作用升级为有状态工作队列；
- 模型、看板、脚本、人工统一经过命令网关；
- 跨域写入改为事件联动；
- parser、grade-assets、scope、FGS、审批、memcore 等旁路被纳入域边界；
- 通过 actor、证据参数、幂等、审计、沙箱交叉校验建立负向保障。

但当前 v5 **还不能定稿，也不能直接开工**。主要原因不是域划分错误，而是以下四类缺口同时存在：

1. **运行态承接不完整**：csai 仍运行 v4 单体，线上没有 `sec-domain-bus`、`idempotency` 表、`data/events/`、领域插件目录；v5 许多示例和迁移前提尚未落地。
2. **跨文档契约未闭合**：查询名、RPC 名、命令名、事件强弱、actor、任务收尾语义存在冲突或悬空引用。
3. **平台与运维功能被“平台层不动”过度压缩**：DSH 版本升级、BrowserAuth、模型路由、dsh-bill、浏览器实际连接模型、备份/恢复/保留期、工具安装锁等对业务安全和可用性有直接影响，不能只写“不动”。
4. **失败恢复模型不足**：当前设计依赖多进程 SQLite、进程内事件订阅和 JSONL；但没有完成跨进程事件投递、outbox、订阅游标、死信、崩溃恢复和文件/数据库双写一致性的闭环。

### 1.2 评分

| 维度 | 评分 | 判断 |
|---|---:|---|
| 领域划分与职责边界 | 4.5/5 | 14 域大体按状态机和 owner 划分，vuln/asset/task/fact/know/exec 的边界有说服力 |
| v4 缺陷覆盖 | 4/5 | 候选池、parser 直写、grade-assets 直写、memcore 裸 SQL、审批跨域直写均有根治方向 |
| 功能完备度 | 3/5 | 业务域覆盖广，但平台运维、通知、成本、浏览器、升级和观测契约不完整 |
| 契约一致性 | 2.5/5 | 存在多个悬空查询、命名漂移、事件强弱冲突和参数/状态机冲突 |
| 事务与可靠性 | 2.5/5 | SQLite 单命令事务描述完整，但跨进程事件、文件双写、强联动崩溃窗口未闭合 |
| 安全性 | 3.5/5 | fail-closed、scope、沙箱和证据纪律强；凭据实现、HTTP 出口、BrowserAuth operator、OOB 状态感知仍有缺口 |
| 可迁移性 | 3/5 | 不改表名和兼容别名降低风险，但迁移切换/回滚/双写隔离还不够具体 |
| 可运维性 | 2.5/5 | 有 setup/backup/retention 方向，但没有把真实 systemd、DSH 升级和健康新鲜度纳入一等契约 |
| 设计成熟度 | 3.5/5 | 可作为目标架构草案；距离“实现者无需决策”的定稿标准仍有明显距离 |

**综合结论：3.3/5。** 建议保留总体方向，但先做契约收敛和迁移前置，不建议立即实现 14 域全量插件化。

---

## 二、取证基线

### 2.1 csai 当前事实

2026-09-06 线上通过 `spool exec csai` 取得以下事实：

| 类别 | 线上事实 | 对 v5 的意义 |
|---|---|---|
| DSH | `@deepseek-ai/dsh 0.1.2-rc.1`，Node 22，主进程监听 `127.0.0.1:3081` | v5 依赖的是具体 DSH 版本，不应只写“平台层不动” |
| 边缘 | Caddy `:3080`，同时改写 Host/Origin；`:9223` 有 basicauth 和 DevTools 反代 | 这是安全边界和 operator 面，应纳入部署契约 |
| 浏览器 | 共享 Chromium CDP `:9222` 独立常驻；dsh-browser fork 自己调用 `chromium.launch()` | v5 当前把两个浏览器路径混为一谈 |
| xray | `:7777` → webhook `:7788`，flows 每日 JSONL | exec/flow 域必须区分原始流量、统计流量和 finding proposal |
| proxy | mubeng `:8899`，live 107 条，pool 129 条；采集 timer active | proxy 运行态仍是脚本直写，尚未是 v5 proxy 域 |
| service | silksecagent、edge、xray、shared-browser、proxy-rotator、ct-watch active | systemd 资产不应被 v5 仅作为“不动清单”略过 |
| plugins | 线上只有 `sec-suite`、`sec-memcore`、`sec-pipeline`、dashboard、proxy、browser、theme、embeddings | 没有 `sec-domain-*` 领域插件，也没有 bus |
| profiles | web/headless 组合 sec-suite/memcore/pipeline/proxy/failover；browser/dashboard 仅 web | v5 “两面工具完全一致”需修正为领域工具与平台工具分层 |
| database | `asset-graph.db` 约 27MB，仍由 v4 单体接管；无 `idempotency`、`bus_meta`、`reports` 表 | v5 总线和 report 后端未部署 |
| events | `/opt/silkspool/dsh/data/events/` 不存在 | v5 事件日志是目标状态，不是当前事实 |
| findings | 68 行：`noise=0` 10 行，`noise=1` 58 行；候选真正 `status=new` 仅 2 行，56 行为历史终态遗留 | Phase 0 数据修复必须独立于域重构执行 |
| assets | 81,028 行；NULL level 1,837；state NULL 68,514 | asset 文档的数字可作为 09-06 基线，但必须注明采集时点 |
| endpoints | 114 行；pipeline TSV 仍远大于 DB | endpoint TSV 回填仍是迁移前置，不是已完成能力 |
| facts/FGS | facts 1,156；FGS 59 节点；`fgs/%` facts 已有 1 条 | 归档中“FGS 沉淀为 0”已过期，v5 文档应改成历史基线 |
| knowledge | `kb_docs` 358 行，正文文件存在于 `data/knowledge/`，不是 v5 设计的 `data/kb/` | 07-know 的路径/schema 需要按现状写迁移映射 |
| evidence | `evidence/` 没有文件；36 条 confirmed-like findings 仅有 inline evidence | v5 `vuln_confirm` 的 evidence 目录强约束会阻断存量迁移，必须定义回填/兼容策略 |
| tasks | 27 行；interval/once/queued/done 混合；task_runs 仍有历史成功和失败 | task 迁移不能只描述表接管，必须处理状态、孤儿、历史 run 和旧任务引用 |
| model bill | dsh-bill 有 5,461 条记录，出现 `opencode-go` 2,938、Bellkeeper 1,764、SenseNova 668、DeepSeek 91 | v5 默认路由设计不能掩盖历史直连成本/路由事实，应增加成本与路由审计 |
| OOB | `interactsh-server` 二进制和 prepared unit 存在，但无 active unit | v5 必须有“能力不可用”状态，而不是只在证据格式里预留 `oob:` |
| CT radar | ct-watch active，但日志大量 HTTP 429，当前 discipline/data-quality 仍可 healthy | 健康度必须包含数据源错误率和新鲜度，而非只看进程 active |
| AUTHORITY | `data/AUTHORITY.md` 存在，根目录 `/opt/silkspool/dsh/AUTHORITY.md` 不存在 | v5 必须指定唯一安装路径和 prompt 装载验证 |

### 2.2 关键源代码事实

当前模板仍明确是 v4 直写架构：

- `dsh-plugin-sec-suite.js:1206` 定义的 `runCli` 在 `1396` 行直接调用 `parsers.applyParsedResult`；
- `dsh-plugin-sec-suite.parsers.js:10` 直接 import `asset-db.js`，`applyParsedResult()` 在 159-170 行直接写 assets/endpoints/findings/fingerprints；
- `dsh-plugin-sec-suite.webhook.js:38` 直接 `assetDb.addFinding()`；
- `dsh-plugin-sec-suite.asset-db.js:274` 的 `upsertAsset` 仍允许 score/level/accept/biz/state 一起写入；
- `dsh-plugin-sec-suite.asset-db.js:293` 的 `upsertEndpoint` 仍允许 auth_required/roles_seen 一起写入；
- `data-seed/scripts/grade-assets.py:105-157` 直接 `sqlite3.connect()` 并 `UPDATE assets`；
- `dsh-plugin-sec-suite.js:1255`、`1304` 仍直接 `assetDb.approvalAdd()`；
- `dsh-plugin-sec-suite.asset-db.js:857` 的 `taskFinishScheduledRun` 仍直接写 task、task_runs、FGS、handoff；
- `dsh-plugin-sec-suite.asset-db.js:1033` 的 `appendFgsToHandoff` 仍直接写 pipeline handoff；
- `dsh-plugin-sec-memcore.js:80` 直接 import `asset-db.js`，并保留大量表级 SQL 治理逻辑；
- csai 线上 `data/tools.d/*.yaml` 仍有 31 个 manifest 使用 `store: asset-graph`；仓库模板的种子逻辑位于 `bundles/dsh/templates/seed-manifests.sh`，不能把线上生成后的数量倒推为源码文件数量；
- `dsh-plugin-sec-suite.asset-graph.js` 仍注册 `asset_add`、`finding_add`、`finding_update`、`blackboard_set`、`fgs_update` 等自由态旧工具。

这些不是 v5 设计错误，而是 v5 实施前必须逐项消除的迁移债。

---

## 三、v5 已覆盖功能对照

### 3.1 结论矩阵

| 功能族 | archive/v4 功能 | v5 承接 | 当前线上 | 结论 |
|---|---|---|---|---|
| 资产登记、分级、状态、指纹 | assets/fingerprints、grade-assets、root 聚合 | 03-asset | v4 直写；Python 直连仍在 | **设计完整，实施未开始** |
| 接口面、参数队列、鉴权矩阵 | endpoints、TSV、param queue、surface queue | 04-endpoint | endpoints 表 114，TSV/queue 仍文件直写 | **设计较完整，迁移数据未闭合** |
| 漏洞候选/信号/确认/提交 | noise gate、finding_update、submission draft | 02-vuln + 12-report | 候选缺陷仍可复现；Phase 0 未实施 | **P0 必须先热修** |
| 任务/调度/worker | taskClaimDue、reap、latest-only、session 回填 | 05-task + 10-exec | v4 稳定性已修部分；无 bus worker 事件 | **功能完整方向，事件化风险高** |
| FGS | 5 工具、任务启动清图、done 沉淀、handoff | 14-fgs | 59 节点，1 条沉淀事实；仍是 v4 直写 | **目标覆盖，需修订历史基线与迁移顺序** |
| 事实/黑板/负知识 | facts、edges、blackboard、memcore 生命周期 | 06-fact | facts 1,156、blackboard 46；memcore 直写 | **设计完整，owner 迁移复杂** |
| 经验/文献/rules/vulncards/harvest | exp/kb/curated/rules/vulncards/vault | 07-know | 35 exp、358 kb、79 rules、vault 回流 | **设计覆盖广，但实际 schema/path 不同** |
| scope/credentials/program/workspace | scope.yml、program 镜像、凭据引用、审批 | 08-scope + 09-approval | scope 工作；credAdd 仅直插 | **授权设计强，凭据校验需补** |
| 执行、沙箱、QPS、parser | run_cli、bwrap、代理、worker、parser | 10-exec | v4 run_cli 全在跑 | **最适合先抽象，但 proposal 迁移需灰度** |
| 纪律台账/coverage/radar/handoff | sec-pipeline 8 工具和文件 | 11-ledger | 台账、card_usage、handoff 已运行 | **功能已运行，owner/事件化未实现** |
| 报告/提交稿 | report_build/submission_draft/列表 | 12-report | 文件报告存在，无索引表 | **报告设计需补存量索引与证据兼容** |
| proxy | pool/live/blocklist/sticky/mubeng/timer | 13-proxy | proxy 脚本直写，timer active | **设计覆盖，但 timer 链必须改为 proposal→命令** |
| dashboard | 53 RPC case、十视图目标 | 16-dashboard | v4 五视图单体 client、53 case | **目标架构清楚，实际拆分未开始** |
| LLM surface | 67 左右 v4 工具、7 preset、skills | 17-llm-surface | 旧工具面约 31 manifest+插件工具 | **负向保障设计好，但工具数量和 profile 矩阵未闭合** |
| eval | eval-live、eval-fp、range | 15-eval | eval 脚本/文件存在，未域化 | **功能有，治理/触发/索引未域化** |
| 备份/恢复/保留期 | VACUUM、14份、retention、restore | 18-migration 分散提及 | systemd active/文件实际运行 | **严重缺独立运维契约** |
| DSH/BrowserAuth/failover/bill | 平台组合和升级链 | README/18/17 零散提及 | 真实运行且有复杂升级约束 | **不能继续归为“平台不动”** |

### 3.2 v5 未覆盖或覆盖不足的功能

#### P0：必须补进定稿前的功能契约

1. **证据包生命周期**：v5 要求 `evidence/{finding_id}/`，但线上没有证据文件，现有 confirmed findings 只有 inline evidence。必须定义 `vuln_evidence_init/attach/finalize` 或明确由 exec/ledger 生成证据包；并定义存量 finding 的迁移策略。
2. **跨进程事件投递**：web/headless 双进程各自实例化 bus，文档只写进程内订阅。必须定义事件 outbox、跨进程消费、事件 offset、重复消费和死信，否则 `exec.run.completed`、`approval.approved`、`task.finished` 可能只在产生事件的进程可见。
3. **强联动事务真实语义**：`approval_decide` 描述为跨域独立事务先执行再更新 approval 行，不能实现真正的整体回滚；文档已经承认崩溃窗口。必须改为 outbox/saga/idempotent effect 状态，不能把“安全方向”当作事务闭环。
4. **文件与 SQLite 双写一致性**：scope.yml、report md+index、rules file+curated index、pipeline TSV、proxy 五文件、FGS handoff 都有文件/DB双写。需统一 file-first/index-later 或 outbox/reconcile 协议，并定义修复命令与健康指标。
5. **模型路由硬约束**：当前线上 dsh-bill 出现 opencode-go 2,938 条，v5 只写默认 Bellkeeper，不约束任务级 provider/model。必须把 Bellkeeper allowlist、应急直连、provider 审计和成本归因写入 05/10/17。
6. **健康度/新鲜度**：CT watch 大量 429，但 discipline/data-quality 仍 healthy。v5 应定义 source freshness、error rate、last successful poll、backlog age、subscriber lag；“systemd active”不能等于功能健康。
7. **平台认证与 operator 注入**：BrowserAuth、auth-gate、Caddy Host/Origin 双改写、operator 来源必须有可执行 smoke，不可留 Q4 假设。
8. **权限与沙箱边界**：现有 bwrap `$HOME` 可写、browser fork 用 `--no-sandbox`、profile 工具矩阵不一致。需把平台工具、领域工具、工作区可写路径分别定义。

#### P1：应在 Phase 1-2 补齐

1. dsh-bill 成本与 `budget_tokens/spent_tokens` 归因；
2. browser fork 与 shared-browser 的关系、是否共用登录态、是否 connectOverCDP；
3. OOB 能力状态：`available/unavailable/configured`，证据命令在 OOB 不可用时必须返回可解释错误；
4. `AUTHORITY.md` 的唯一安装源、prompt 注入、版本校验；
5. tools-manager/tools.list/插件 lock 的安装、hash、回滚和 manifest 可执行性检查；
6. 备份快照、恢复演练、retention 轮转、events/audit 的保留和恢复语义；
7. Matrix/Bellkeeper 通知：审批、needs_approval、出洞、健康告警的投递与失败重试；
8. report 存量索引、submissions 状态、证据包关联；
9. negative ledger 的结构化 `host × stack × vuln_class` 维度；
10. 任务真实结果、needs_review、worker log truth 与 task status 的一致性检查。

#### P2：可在后续演进

1. scan-burst 规则租约和 TTL 回滚；
2. 事件推送替代 dashboard 30s 轮询；
3. HTTP remote 资产/接口/漏洞后端的真实目标系统适配；
4. phase 动态工具子集与 token budget 优化；
5. worker 持续会话/send_message 人工断点；
6. event log 压缩、归档和跨主机复制。

---

## 四、文档内部矛盾与悬空契约

以下项目在实现前必须修正，优先级高于润色。

### 4.1 命名和投影不一致

| 问题 | 现状 | 修正 |
|---|---|---|
| scope rules | 08 定义 `scope_rules_apply`，16 使用 `scope.set_rules` | 统一外部 RPC 为 `scope.rules.apply`，命令为 `scope_rules_apply`；旧名只在 aliases |
| workspace binding | 08 定义 `program_bind_workspace`，16 使用 `scope.bind_workspace` | 统一 RPC 为 `program.bind_workspace`，命令维持 `program_bind_workspace` |
| blackboard query | 06 定义 `fact_bb_read`，16/旧映射出现 `fact.bb_get` | 统一查询名 `fact_bb_read`，RPC `fact.bb.read` |
| scheduled tasks | 05 定义 `task_scheduled`，16 使用 `task.scheduled_list` | 统一查询名 `task_scheduled`，RPC `task.scheduled` |
| export gate | 07 定义 `exp_approve_export/exp_revoke_export`，16 使用 `know.exp_gate_export` | 统一 RPC 拆成 `know.exp.approve_export` / `know.exp.revoke_export` |
| task chain | 05 定义 `task_chain`，10 定义 `exec_task_chain` | 选择 `task_chain` 为唯一写命令；exec 仅保留 `exec_plan_chain` 查询。旧 `exec_task_chain` alias 指向 task 命令 |
| report draft | 02 仍出现 `vuln_draft_submission` 兼容描述，12 归 report | 只保留 `report_draft_submission`，别名由总线维护，不在 vuln manifest 声明 |
| know health/coverage | 07 定义 `know_health`，16 使用 `know.stats`、`know.knowledge_coverage` | `know_health` 作为健康聚合；`know_coverage` 作为覆盖查询，名称写入 07 manifest |

### 4.2 事件和 actor 不一致

1. `exec.run.failed` 在 06-fact 中被订阅，但 10-exec 只定义 `exec.run.started/completed`，没有 failed 事件。修正：`exec.run.completed` 必须包含 `outcome/exit_code/error`，或正式增加 `exec.run.failed`，两者只能选一个。
2. `exec.worker.spawned/finished` 在 05/10 中一处写 strong/sync，一处事件表写 weak；必须统一：worker 注册是 strong，worker finish 是 strong 还是最终一致需单独决定。
3. 01-bus 宪法说 sync 订阅失败触发回滚；01-bus EventBus 2.2.5 又写 `subscriber_failed` 不回滚；03-asset 甚至写“本域无强联动”。必须把 `mode` 语义固定为：
   - `sync`：同一 SQLite 事务内 SAVEPOINT，可回滚；
   - `async`：事件已持久化，订阅者独立 dispatch，失败进 retry/dead-letter；
   - 不允许文档再使用“同步但不回滚”的含混表达。
4. `approval_decide` 的“强联动整体回滚”与“订阅方独立事务已提交”互相冲突。最小修正：approval 不再执行跨域强联动命令；先提交 approval decision + effect outbox，再由订阅方执行，状态机增加 `approved_pending_effects/effect_failed`，授权类采用 idempotent effect + reconcile。若必须批准和授权同事务，则 scope/approval 必须共享同一连接和事务，不能使用独立域 repository。
5. `fact` 订阅 `fgs.node.done` 和 `task.finished` 的双通道需定义唯一事实状态：待沉淀清单不能只在内存，必须落持久化 outbox/ledger，否则宿主重启会丢。

### 4.3 数据模型和线上路径不一致

1. `kb_docs` 线上列为 `id/title/file/source_url/...`，v5 设计写 `doc_id/body_path/data/kb/`。必须明确 Phase 2 是兼容现表，还是迁移列/路径；建议保留现表列名，文档用 v5 逻辑名映射，避免无必要重命名。
2. 线上 `kb_docs` 正文在 `data/knowledge/`，v5 写 `data/kb/`。建议不迁正文，manifest 声明 `data/knowledge/` 为现状 backend root，未来新路径另起版本。
3. v5 `report` 需要 `reports` 索引表，线上没有；必须把 `backfill-report-index.js` 列入 Phase 2 的硬前置，并处理评审时清点出的现有 29 份报告。
4. v5 `evidence/{id}` 是确认门槛，线上 evidence 文件数为 0。必须在 Phase 0/1 前定义历史证据回填：inline evidence 只能转为 `legacy-inline`，不能伪造 request/response；`vuln_verify_replay` 对 legacy finding 应返回 `E_EVIDENCE_LEGACY_UNAVAILABLE`。
5. v5 `data/events/*.jsonl` 当前不存在。事件从切换时刻开始记录是合理的，但必须定义历史事件不可重放、迁移动作 audit 如何补偿，以及 event sequence/producer version。

### 4.4 看板聚合引用悬空查询

16-dashboard 的 `dashboard.stats/ops` 引用了 `asset.stats`、`ledger.daily_delta`、`ledger.card_usage_7d`、`ledger.handoff_7d`、`know.stats`、`task.drift_report`，这些在域文档中没有对应契约。修正方式二选一：

- 为每个引用补正式查询契约；或
- dashboard 只调用已定义的 `asset_overview`、`ledger_discipline_stats`、`know_health`、`task_stats/task_scheduled`，不再凭空组合内部查询名。

建议采用第二种，减少 API 数量。

---

## 五、设计性评估

### 5.1 设计优点

1. **把“不变量”从调用纪律提升到接口结构**：asset_upsert 不允许写 level、vuln_confirm 固定推进状态、机器候选入口不向模型注册，这是比 v4 if-chain 更强的设计。
2. **owner 粒度总体合理**：按状态机和单写者划分，而不是按文件名机械切分；FGS 不拥有 handoff、report 不拥有 findings，边界论证清晰。
3. **保留 v4 的有效工程资产**：不改数据库文件/表名、保留现有算法、以适配器包裹，而不是全量重写，降低了迁移风险。
4. **负向保障优先**：actor、schema `additionalProperties:false`、状态机私有、sandbox owns 交叉断言、model 不可见工具，方向优于单纯 prompt 规范。
5. **事件化目标正确但要降低承诺**：跨域最终一致是合适方向，但不能把进程内 EventBus 当成跨进程可靠消息系统。

### 5.2 设计风险

1. **抽象过早且规模偏大**：设计统计为 146 个动词/查询、14 域、三种后端、自动双投影、事件回放、强联动 SAVEPOINT 一次性设计，尚未有一个实际运行域证明全链路可行。建议 Phase 1 只实现 bus + vuln + audit/idempotency/outbox，不同时引入 http-remote。
2. **“一切写入皆命令”与现有平台外部写入冲突**：scope sync、systemd、timer、vault、proxy、rules seed、browser screenshots 都有外部写入。设计需要“受控外部写入接管协议”，而不是宣称不存在第二写入口。
3. **领域服务不可 provide 与跨域查询/订阅的实现存在张力**：文档一方面禁止域 service provide，另一方面示例大量 `ctx.inject('secDomain.vuln')`。应统一：只 provide `secDomainBus`，所有跨域调用只能 `bus.dispatch/query`；域内部 handler 才可拿 repository/service 闭包。
4. **把模型工具面预计扩到约 119 个工具会伤上下文和选择质量**：文档自己估算 69-73k token。正确方案不是先全量注册再观察，而是从第一阶段引入 profile/phase capability projection，至少给 worker 限制域集合，同时保留 dashboard/human 全量。
5. **后端可替换的价值被高估**：task、fgs、scope、approval、exec 明确不适合 remote/file；很多域的 http 能力只是设想，实际会形成大量 partial 规则。建议把“可替换”降级为 repository 可替换，先不承诺所有域三后端。
6. **审批 two-phase 不是事务**：必须明确 saga/outbox/reconcile，不能通过“授权扩大是安全方向”替代一致性设计。
7. **证据模型未成为一等域**：报告、finding、ledger、verify_replay 都依赖证据，但没有 evidence owner/状态/哈希/保留策略，导致 `vuln_confirm` 的真实存在校验无法执行。

---

## 六、修正后的目标架构

### 6.1 分层调整

建议把 v5 由“14 域 + 平台不动”调整为四层：

```text
平台运行层
  DSH / web+headless / auth / BrowserAuth / edge / shared-browser / xray / proxy / systemd

可靠性基础层
  CommandGateway / QueryGateway / Idempotency / Audit / EventOutbox
  EventDispatcher / RetryQueue / DeadLetter / Reconcile / HealthFreshness

业务域层
  vuln / asset / endpoint / task / fact / know / scope / approval / exec
  ledger / report / proxy / fgs / eval

证据与文件适配层
  evidence / results / reports / pipeline / rules / vault / proxy files
```

关键变化：`EventOutbox`、`Evidence`、`HealthFreshness` 不再是实现细节，而是 v5 共同基础设施。

### 6.2 推荐的事件可靠性模型

不采用当前文档的“命令提交后直接 append JSONL + 进程内调用 handler”作为最终模型，改为：

1. 命令事务内写业务表、idempotency 行和 `event_outbox` 行；
2. 事务提交后，web 宿主 dispatcher 以 `event_outbox.status=pending` 扫描并派发；
3. 每个订阅者有 `(event_id, subscriber)` 唯一消费记录或订阅 offset；
4. 成功标记 `delivered`；失败指数退避，超过阈值进入 `dead_letter`；
5. `bus_replay` 只重试 dead/pending 的 async 订阅，不重新执行强联动；
6. headless 进程不启动 dispatcher，只调用 bus 写入 outbox；
7. `bus_status` 展示 outbox pending、dead-letter、最大 lag、最后成功消费时间。

这样才与当前线上“web + 多个 headless worker 进程共用 SQLite”的事实匹配。

### 6.3 推荐的审批模型

将 approval 分为两个概念：

- `approval_requests`：人工决定账本；
- `approval_effects`：批准后具体域效果的幂等执行账本。

批准流程：

1. approval 行从 pending → approved，事务内写 `approval_effects` pending；
2. dispatcher 执行 `scope_grant/task_budget_extend/know_adopt` 等效果；
3. 效果成功 → applied；失败 → retry/dead-letter；
4. approval 查询显示 `approved_effect_pending/failed`，而不是返回“effect 已完成”的伪装字符串；
5. 对授权类效果提供 reconcile 查询，确保 scope.yml、programs 镜像、approval effect 三者最终一致。

### 6.4 推荐的证据模型

增加共同 `evidence` 规范，至少定义：

```text
evidence/{finding_id}/
  manifest.json       # finding/run/actor/created_at/schema_version
  request.txt         # 可选
  response.txt        # 可选
  reproduce.md        # 可选
  falsification.md    # 可选
  verify-log.md       # append-only
  hashes.json         # sha256
```

规则：

- `vuln_confirm` 只要求证据引用真实存在，不强制所有 finding 都有 request/response；
- legacy inline evidence 只能标记 `legacy-inline`，不能伪造机械复核能力；
- report/ledger/verify_replay 只引用 manifest，不自行猜路径；
- retention 对 evidence 与 results 使用不同保留策略，confirmed/submitted 证据不得随 results 30 天清理。

---

## 七、分阶段修正方案

### Phase R0：文档契约冻结前修正，1-2 天

目标：不写业务代码，先让文档可实现。

1. 统一命令、查询、RPC、事件命名表；删除悬空引用。
2. 补 `manifest.schema v1` 正式 JSON Schema，而不是 YAML 片段。
3. 固定 actor 矩阵和 profile 矩阵，区分领域工具与平台工具。
4. 固定事件语义：sync/async、outbox、retry、dead-letter、跨进程 dispatcher。
5. 固定现状 schema 映射：`kb_docs`、reports、evidence、scope、tasks、findings。
6. 增加 DSH/运维基线附录：版本、setup、upgrade、BrowserAuth、systemd、backup、retention、plugins.lock、tools-manager。
7. 每份文档增加“现状快照日期”和“目标实现状态”，禁止把预测数值写成实测。

R0 通过门槛：

- `grep` 不再发现悬空查询/事件/命令；
- 每个事件有唯一 producer、payload schema、订阅者、模式、失败策略；
- 每个 owned file/table 有唯一 owner 和外部写入接管策略；
- 每个模型可见工具都能在 profile × actor 矩阵找到来源。

### Phase R1：v4 止血与证据基线，1-2 天

不等 v5 总线：

1. 修复 `updateFinding` 的 confirmed/submitted → `noise=0`；
2. KPI 改为 `noise=1 AND status='new'`；
3. 56 条历史终态候选做 dry-run/backup/幂等修复；
4. 建 legacy evidence manifest：36 条 confirmed-like finding 记录 `legacy-inline`；
5. 把 `data-quality` 增加：
   - task status 与最近 task_run 一致性；
   - CT/JS source last-success/429/error rate；
   - dsh-bill provider 路由偏差；
   - evidence 引用存在性；
   - report 文件与索引一致性；
6. 修复 `grade-assets.py` 直连 DB 的运行风险，至少在迁移前把其输出切到 proposal 模式或由 v5 asset_grade 接管。

### Phase R2：bus + vuln 最小垂直切片，1 周

只实现以下范围：

- bus registry/gateway/query/idempotency/audit；
- SQLite outbox/dispatcher/retry/dead-letter；
- vuln register candidate/signal/confirm/reject/submit/note/candidates；
- evidence manifest 和 legacy 兼容；
- ToolProjector/RpcProjector 只投影 vuln；
- old tool alias 保留；
- 不实现 http-remote，不实现全部 14 域，不拆 dashboard 全客户端。

验收：

1. xray、parser、model、dashboard 四路写同一 finding；
2. web/headless 两进程事件消费可见；
3. subscriber kill/restart 后 outbox 可重试；
4. confirm 原子改变 status/confidence/noise；
5. legacy finding 的 evidence 行为可解释；
6. 连续 3 个调度周期无候选计数漂移。

### Phase R3：按依赖迁移数据域，2-4 周

建议顺序调整为：

1. asset + endpoint：先处理 proposal 和 TSV 回填；
2. fact + know：先处理 memcore dependency inversion、kb schema/path、vault；
3. ledger：再迁台账文件和流程守卫；
4. task + exec：事件化 worker、真实结果、session、budget；
5. fgs：依赖 task/event/fact 完成后迁；
6. scope + approval：最后迁审批 effects 和外部 scope 接管；
7. report/proxy/eval/dashboard：分别做文件索引、timer proposal、评测触发、UI 投影。

不建议原 18-migration 的 `asset → endpoint → fact → know → task → fgs → scope → approval → exec → ledger → report → proxy` 顺序，因为 task/exec 事件是多个域的基础，approval effects 也依赖 scope/task/know 的稳定命令。

### Phase R4：平台与运维闭环，贯穿 R2-R3

必须增加部署验收命令集：

```bash
spool exec csai "systemctl is-active silksecagent silksecagent-edge silksec-xray silksec-shared-browser silksec-proxy-rotator ct-watch"
spool exec csai "python3 /opt/silkspool/dsh/scripts/pipeline/data-quality.py --json"
spool exec csai "python3 /opt/silkspool/dsh/scripts/pipeline/discipline-audit.py --json"
spool exec csai "test -f /opt/silkspool/dsh/data/AUTHORITY.md"
spool exec csai "test -d /opt/silkspool/dsh/data/events"
spool exec csai "node /opt/silkspool/dsh/app/node_modules/@deepseek-ai/dsh/lib/bin.js --profile web --dump-config"
spool exec csai "node /opt/silkspool/dsh/app/node_modules/@deepseek-ai/dsh/lib/bin.js --profile headless --dump-config"
```

注意：线上 DSH CLI 路径是 `/opt/silkspool/dsh/app/node_modules/@deepseek-ai/dsh/lib/bin.js`，不是 v5 示例中的 `/opt/silkspool/dsh/bin.js`。文档示例必须改正。

### Phase R5：评测与收敛

1. eval contract 用例覆盖：自由态写、无证据确认、actor 伪造、审批自决、事件重复消费、崩溃恢复；
2. 对比 v4/v5 的 command/audit/event/task/finding 结果；
3. 连续 7 天运行态验收，不以 setup 成功作为完成标准；
4. 再决定是否删除 alias、是否引入 phase 动态工具子集、是否开启 http-remote。

---

## 八、文档修改清单

### 8.1 现有文件必须修改

| 文件 | 必改内容 |
|---|---|
| `00-conventions.md` | 增加 outbox/retry/dead-letter、evidence、external-write、platform actor；删除“所有查询/写入都可直接投影”的过强表述 |
| `01-bus.md` | 修正 sync/async 语义冲突；补跨进程 dispatcher、outbox、offset、崩溃恢复、operator 验收；统一 service 注入方式 |
| `02-vuln.md` | 增加 evidence 域/legacy evidence、exec failed 事件选择、candidate 数据修复和存量兼容 |
| `03-asset.md` | 明确 grade-assets proposal 迁移、owner 字段实际列迁移、parser proposal 断点和批量 partial 语义 |
| `04-endpoint.md` | 增加 surface_scan 正式契约、TSV/queue 并发一致性、consume 审计、实际回填验收 |
| `05-task.md` | 增加 dsh-bill budget、provider allowlist、状态一致性/needs_review、worker/event outbox 语义 |
| `06-fact.md` | 增加 exec failed 事件定义、fact purge 正式命令、FGS 待沉淀持久化、memcore 迁移双轨期 |
| `07-know.md` | 将线上 `kb_docs` schema/path 作为现状，补 vault-sync、AUTHORITY/knowledge path、purge/archive、索引重建 |
| `08-scope.md` | 补 cred hard validation、external write reconciliation、IPv6/CIDR 决策、rules lease 预留 |
| `09-approval.md` | 用 approval_effects/reconcile 替代伪两阶段回滚；补通知/SLA 和 crash recovery |
| `10-exec.md` | 修正 parser 实际直写迁移、browser 双路径、OOB 状态、tools-manager、HTTP proxy/web_fetch 边界 |
| `11-ledger.md` | 把 handoff/task proof 的真实失败语义统一；补 radar source freshness/429 监控 |
| `12-report.md` | 增加现有报告 backfill index、legacy evidence、submission 状态和保留期 |
| `13-proxy.md` | 说明 timer 当前直写、迁移后的 proposal 接线；增加 root-owned 文件权限/健康指标 |
| `14-fgs.md` | 更新历史基线（线上已 59 节点/1 条 persisted），修 sync 失败语义和沉淀持久化 |
| `15-eval.md` | 增加真实运行触发/保留/成本预算、contract cases 和事件回放验收 |
| `16-dashboard.md` | 删除悬空查询名；统一 RPC 名；补平台 auth/operator、健康新鲜度和视图降级 |
| `17-llm-surface.md` | 补 web/headless/platform 工具矩阵、路由硬约束、dsh-bill、BrowserAuth、工具 token 预算实际策略 |
| `18-migration.md` | 按 R0-R5 重排；补 DSH 升级、备份恢复、事件 outbox、实际 CLI 路径和 smoke；把 13 systemd 改为完整清单 |

### 8.2 建议新增文件

1. `20-platform-runtime.md`：DSH/profile/systemd/edge/browser/xray/proxy/OOB/model/failover/bill/backup/retention 的平台契约。
2. `21-evidence.md`：证据包格式、哈希、保留、legacy、verify/replay、脱敏。
3. `22-health-and-reconciliation.md`：各域 freshness、lag、dead-letter、file/index、scope mirror、task truth、CT 429 的统一健康模型。
4. `23-contract-registry.md`：命令/查询/RPC/事件/actor/owner 的机器可读总表，作为所有文档交叉引用的唯一索引。

如果不希望增加编号，可将 20-23 合并进 00/01/02/18，但不建议继续把平台和证据放在各域文档的“开放问题”里。

---

## 九、最终功能性判断

### 9.1 v5 是否包含所有功能？

**不包含。** 更准确的判断是：

- **业务章节覆盖度约 85%（评估值，非自动计算指标）**：资产、接口、漏洞、任务、事实、知识、授权、审批、执行、台账、报告、代理、FGS、评测、看板都有对应章节；
- **运行闭环覆盖度约 55%-65%（评估值，非自动计算指标）**：平台/运维、证据、跨进程事件、文件一致性、通知、成本、健康新鲜度没有闭合；
- **当前线上 v5 实施率接近 0%**：线上仍是 v4 单体，只有部分 v4 能力与 v5 设计语义相似，不代表 v5 已部署。

前两项是本次评审用于表达相对成熟度的估算，不是线上 KPI；R0 应将其替换为可重现的契约清单、验收用例和运行指标。

### 9.2 v5 是否具备功能性？

作为目标架构：**具备，但需要 R0 契约修正后才具备可实施性。**

作为当前系统方案：**不具备直接实施性**，因为：

- 事件总线跨进程语义未闭合；
- 证据、报告、知识、scope 等存量路径不兼容；
- 旧工具/manifest/parser 仍会绕过新边界；
- 文档命名和 RPC 组合无法直接生成一致代码；
- 强联动审批无法靠独立事务实现真正回滚。

### 9.3 v5 是否具备设计性？

**设计性强，但有过度设计和不完整可靠性设计并存的问题。**

最值得保留：

- domain owner；
- command/query/event 三分；
- actor 负向投影；
- candidate 状态机；
- proposal 代替脚本直写；
- v4 逻辑平移而非推倒重写。

必须收敛：

- 先实现一个可靠垂直切片，不要 14 域同时开工；
- 把 event outbox/evidence/health 作为共同基础设施；
- 把 DSH 平台和运维当作正式契约；
- 把“强一致”与“最终一致”分别写成可实现机制；
- 所有文档数字标明 snapshot date 和 source。

---

## 十、建议的评审决议

建议评审会通过以下决议，而不是直接批准 v5 全量定稿：

1. **批准总体方向**：领域插件化、命令网关、事件联动、双投影、候选状态机继续作为 v5 主方向。
2. **退回文档做 R0 修正**：先统一契约、命名、事件、证据、平台基线和健康模型。
3. **批准 R1 热修先行**：候选池、KPI、legacy evidence、data-quality/freshness，不等待 v5 总线。
4. **只批准 R2 vuln 垂直切片开工**：不批准一次性启动 14 域和 http-remote。
5. **将 20-platform-runtime、21-evidence、22-health、23-contract-registry 列为 v5 正式文档**。
6. **定稿标准从“文档写完”改为“契约可生成 + 线上连续 7 天验证”**。

最终目标不是得到一套更长的架构文档，而是让下面这条链真正可验证：

```text
授权 → 任务 → worker → 工具/浏览器 → 结果/证据
  → proposal → 领域命令 → 状态机 → 事件 outbox
  → 评测/台账/报告/知识 → 看板/通知/审计
```

其中任何一步失败，都应在命令信封、outbox、健康视图、审计或 dead-letter 中留下可定位事实，而不是只在 prompt 或归档文档里写“应当如此”。
