# SilkSecAgent 进度（当前）

> **本文件只保留「当前状态 + 最近进度结果 + 通用规则」**。一切历史——历次更新日志、已完成节点（附 commit）、已关账待办、批次守则/模板——都在 [archive/progress-history.md](archive/progress-history.md)（只读不改写）。
> **滚动规则**：新结果写入本文件；当新结果使上一版「最近结果」过时，把上一版整体移入历史归档，保持本文件只含当前。不再新建「最新进度/本次升级」等副本。
> 模块契约与版本在 `00-conventions.md`…`18-backup-and-maintenance.md` 内自维护；文档目录治理规则见 [README.md](README.md)。

## 一、当前状态

- **迁移已关账归档**：[旧迁移路线图](archive/migration-v4-to-v5.md)保留Phase 0–5历史与验收；常驻正式契约为00–18；18号现为备份、恢复与变更前维护，17号LLM工具面继续维护。
- **真实漏洞发现能力专项**：[27 号方案](27-business-quality-and-capacity-plan-2026-09-30.md)已按用户澄清重新审查，**首批累计增量已部署，小批运行完成，暂不扩大**。仅以真实漏洞数量、技术质量和发现效率评价，撤销提交/accepted/赏金门槛；重点为真实请求、假设路由、可靠执行、候选丢失/误抑制、技术判定和知识实效。保留 12 个工作包、15 组技术验收；0.1.7 升级链已关账，移交缺陷继续纳入；本轮仅发布业务增量。
- **DSH 0.2.0 研究与升级计划**：[26 号方案](26-dsh-0.2.0-upgrade-plan-2026-09-30.md)已完成调研，**待实施**；建议从 0.1.7-rc.2 直接升 0.2.0-rc.2，U3 前须旧链 P8 关账——**已满足（P8 于 2026-09-30 关账）**。当前生产版本与旧升级链状态不因本计划改变。
- **Phase 状态**：**Phase 0–5 全部完成并关账**；迁移链已结束；发现能力整改由27号专项继续推进。
- **当前运行**：2026-10-01 27号增量上线，DSH0.1.7-rc.2，PID=975839/NRestarts=0，6服务active、UI80/80；Campaign1/2/3暂停、并发1，WP03硬预算验证前不扩大。
- **旧升级关账基线**：DSH **0.1.7-rc.2**（2026-09-27 17:29:26Z U3 生产切换，P6b；**2026-09-30 P8 关账（用户指令提前）**——U4b 只读巡检全绿 + 新冻结点 `c85f3b9f…` + `preserve_after_resume ok=true`；关账后 MainPID **922156**、NRestarts=0、6 单元 active、15 域、accept2b **PASS=80 FAIL=0**、journal err=0；会话 1767（V4））。P7 巡检 1（09-29）+ P8 巡检 2（09-30）均全绿；旧基线 0.1.5-rc.2 履历见历史归档。
- **最近一次全面检查**：[archive/20-full-inspection-2026-09-19.md](archive/20-full-inspection-2026-09-19.md)（文档/代码/流程/运行态/UI；**四轮修复全部落地验收，结论已全部回填各模块，2026-09-22 归档**，见其 §十一）。
- **专项归档**：[archive/19-ui-unify.md](archive/19-ui-unify.md)（看板 UI 全局统一重构：**U1–U4 + 走查补丁已实施，csai 验收 PASS=72 FAIL=0**，结论已回填 16-dashboard/主题 §11.8·§11.9/CONTEXT；已归档只读）；[archive/23-llm-supply-throttle-2026-09-23.md](archive/23-llm-supply-throttle-2026-09-23.md)（LLM 供给联动调速 + 任务级选模型，已实施部署验收）；[archive/24-ops-audit-ui-flow-2026-09-23.md](archive/24-ops-audit-ui-flow-2026-09-23.md)（任务/知识/学习工作流可视化，已实施部署验收 accept PASS=80）。
- **已知遗留（非阻塞，待后续会话）**：sec-suite/asset-db/experience 内部少量 v4 读取函数（experience 仍被 dashboard-rpc/task 链路引用）；后续治理纳入27号对应工作包，不重开已关账迁移。
- **在办批次**：25 号方案 B1 大数据治理（42 号补丁）**已部署验收**；B2 部分完成（索引/聚合缓存/批量投影；FTS 缓期）；**B3 升级链 P1–P8 已全部完成并关账（CHAIN END，2026-09-30）**——生产 0.1.7-rc.2（U3 P6b 切换、finalize invariants failures=0、+72h 观察期 P7/P8 两次只读巡检全绿、U4b 新冻结点 + `preserve_after_resume ok=true`、用户指令提前关账；P6 首次失败已回滚+静音修复+预演后重试成功，窗口 2h56m25s、业务 RPO=0）。**遗留移交 27 号方案/观察期后治理**（僵尸泄漏两路径、设置保存写路径、failover 预流缺口、kbList、Campaign 3 预算、提交 SOP/SLA 等）见 [state open_issues](archive/upgrades/2026-09-26-dsh-0.1.7-rc.2-state.md)——详见[升级方案](archive/upgrades/2026-09-26-dsh-0.1.7-rc.2-plan.md) · [执行记录 §13–§19](archive/upgrades/2026-09-26-dsh-0.1.7-rc.2-record.md)。
- **27 号发现能力改造**：目标/请求/完整H2队列、可信读取、费用账本、worker认领隔离、回收事件和有界失败重试已部署；全域659/659、生产UI80/80、单任务收尾通过。范围与剩余缺口见 [27号§10.4–10.6](27-business-quality-and-capacity-plan-2026-09-30.md)。全方案未关账；采用闭环分批提交与发布验收后分批部署，业务增量提交`38deb2b`已上线；预算超限触发暂停放量，详见§二。
- **文档漂移排查**：B1–B5 全部闭环（2026-09-19）；详见历史归档。
- **领域语言**：[CONTEXT](../../bundles/dsh/CONTEXT.md)。

## 二、最近进度结果

### 2026-10-01 · 27号累计业务增量部署与分阶段运行

- `2c40d3f`＋`38deb2b`累计9模块/32落点已部署，DSH固定0.1.7-rc.2。新冻结`777e3e6b…`覆盖6根，旧/新版恢复应用启动通过；新增3表、核心旧业务行不变。
- 验收：远端全域659/659、57表schema、隔离worker14项、生产UI80/80；6服务active，PID=975839/NRestarts=0，journal err=0。真实运维任务103394在50.795秒done，claim/worker/run/session匹配、独立账本一行、待恢复收尾0。
- **放量门槛未通过**：任务声明20,000 token，实际49,626（3条账单，首个输入43,869，非重复扣费）。当前预算仅事后观测，WP03执行前预留/上下文费用检查仍缺。Campaign1/2/3已通过正式命令暂停，预算不变；认领/worker并发12→1。下一批先补WP03硬预算/lease/ack与迟到账单，通过后单Program恢复再扩大。
- **效果边界**：生产verification-profiles为空，真实读取验证缺接口契约/双身份，正确返回能力缺口；本批未宣称新增真实漏洞、真实请求覆盖或全方案关账。
- 本批NAS门禁及部署后备份均通过；最终snapshot `df226da14b56c7d0e9b633845b29aced5384bb23f58a2541f192c68cf2b4044c`，40库33.21秒/恢复6.51秒。完整证据与D0–D3检查点见[27号§15.3](27-business-quality-and-capacity-plan-2026-09-30.md#153-业务增量分阶段发布2026-10-01阶段验收完成)。冻结到恢复窗口约47分58秒，含恢复/应用预演。
- 过程失败如实保留：首次冻结被本轮mode=ro查询改动副本SHM干扰，自动恢复后重做成功；新增路径/字段差异诊断，快照7/冻结10/发布19项远端root回归通过。旧版应用与全域测试并行时一次RPC超时，串行重跑通过。18号已补充禁止查询待校验SQLite树。

## 三、维护规则（通用，必须遵守）

1. **本文件只含当前**：新增进度写本文件；旧「最近结果」在新结果落地时整体移入历史归档。
2. **历史只归档**：历次更新日志、已完成节点、已关账待办、批次守则移入 [archive/progress-history.md](archive/progress-history.md) 与 [archive/upgrades/](archive/upgrades/)，只读不改写。
3. **批次守则随批次走**：仅在某个批次/专项期间有效的守则、模板、核验方法与该批次记录放在一起；批次归档时一并迁出，本文件只留通用规则。
4. **闭环分批交付**：完成可审查闭环并通过相关验证后提交推送；明确发布范围、版本、备份与恢复方案后小批部署，通过运行验收再扩大。阶段提交、部署验收、全方案关账分别记录，不等待整套方案结束才提交。
5. **真相源优先级**：运行态证据（`spool`）> 代码/manifest > 契约测试 > 文档；术语以 CONTEXT 为准，契约冲突以 [00-conventions](00-conventions.md) 为上位。
6. **文档同步**：代码/上线改动必须在对应模块文档内回填（版本/契约/未实现项/验收），不得只更新本进度文件；未实现的设计项须显式标注，不得当作现行机制。
7. **变更前先备份**：按[18号§2](18-backup-and-maintenance.md#2-每次变更前的固定流程)执行 `prepare-change --change 本次ID`，退出0并核对新快照及恢复回执后才允许首次生产写入（含模板上传）。失败/锁冲突停止；历史快照或timer成功不代替本次备份；跨库/版本切换仍须新冻结点。

## 四、关键决策（已定，勿推翻）

多进程 + SQLite WAL（单写者守护进程 Phase 5 复评已决：无 E_CONFLICT 频发，维持多进程+WAL 终态，不启动单写者架构专项）｜ event_outbox + dispatcher 跨进程投递 ｜ sync（同事务 SAVEPOINT 可回滚）/ async（outbox 派发 + retry/dead-letter）｜ approval_effects 幂等 effect outbox ｜ audit fail-closed（主链路写命令）｜ LLM 工具面 phase 动态子集 ｜ 兼容别名层已于 2026-09-19 清空（机制保留为通用改名能力）｜ 不改表名不迁库（ensureCol 幂等列演进）｜ 14 域 + 总线

## 五、操作红线（每次会话必须遵守）

- 一切远程操作走 PATH 中的 `spool`（`spool exec csai "..."`），禁止绕过 spool 直接 SSH/curl 操作远程 Docker
- 禁止 `docker compose down`；绝对禁止对 n8n 执行 `docker compose down -v`/`--volumes`
- 禁止 `git add -f`；doc/hosts/config.ini/keys 相关敏感文件不入库
- 有状态服务（n8n/Memos/Bellkeeper 等）重建需用户批准；n8n 重启只能用 `docker stop sp-n8n && docker start sp-n8n`
- 生产变更先执行18号prepare-change并核对本次成功回执；本地模板改好后，在远端上传前完成备份。
- bundle 模板改动后：先 `rsync -a bundles/dsh/ /opt/SilkSpool/bundles/dsh/` 再 `spool bundle dsh setup csai`（spool 读的是 /opt/SilkSpool/bundles/ 运行时副本）

发布检查点（2026-10-01）：27号D0–D3本批部署/小批运行完成，生产0.1.7-rc.2；下一批WP03执行前预算、lease/ack与迟到账单。三个Campaign暂停、并发1，放量须先通过预算门禁；仍不升级0.2.0、不改旧升级STATE。
