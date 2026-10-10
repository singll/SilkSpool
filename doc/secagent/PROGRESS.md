# SilkSecAgent 进度（当前）

> **本文件只保留「当前状态 + 最近进度结果 + 通用规则」**。一切历史——历次更新日志、已完成节点（附 commit）、已关账待办、批次守则/模板——都在 [archive/progress-history.md](archive/progress-history.md)（只读不改写）。
> **滚动规则**：新结果写入本文件；当新结果使上一版「最近结果」过时，把上一版整体移入历史归档，保持本文件只含当前。不再新建「最新进度/本次升级」等副本。
> 模块契约与版本在 `00-conventions.md`…`18-backup-and-maintenance.md` 内自维护；文档目录治理规则见 [README.md](README.md)。

## 一、当前状态

- **迁移已关账归档**：[旧迁移路线图](archive/migration-v4-to-v5.md)保留Phase 0–5历史与验收；常驻正式契约为00–18；18号现为备份、恢复与变更前维护，17号LLM工具面继续维护。
- **真实漏洞发现能力专项**：[27 号方案](27-business-quality-and-capacity-plan-2026-09-30.md)已按用户澄清重新审查，**累计业务及WP03输入计量修复已部署，默认150k只读闭环通过，暂不扩大**。仅以真实漏洞数量、技术质量和发现效率评价，撤销提交/accepted/赏金门槛；重点为真实请求、假设路由、可靠执行、候选丢失/误抑制、技术判定和知识实效。保留 12 个工作包、15 组技术验收；0.1.7 升级链已关账，移交缺陷继续纳入；本轮仅发布业务增量。
- **DSH 0.2.0 研究与升级计划**：[26 号方案](26-dsh-0.2.0-upgrade-plan-2026-09-30.md)已完成调研，**待实施**；建议从 0.1.7-rc.2 直接升 0.2.0-rc.2，U3 前须旧链 P8 关账——**已满足（P8 于 2026-09-30 关账）**。当前生产版本与旧升级链状态不因本计划改变。
- **Phase 状态**：**Phase 0–5 全部完成并关账**；迁移链已结束；发现能力整改由27号专项继续推进。
- **当前运行**：D09评审修复已发布，DSH0.1.7-rc.2；共享浏览器primary（9222）/socend（9224）已修复上批网页挂起，默认恢复headless-shell，PID2282367/2282571，active/NRestarts0。扣子正文、截图、CDP推流/输入与DevTools入口均通过，primary仍登录；入口 `/p/primary/`、`/p/socend/`。现已关闭xray隐式扫描并接回8899池；免费池网页稳定性未通过（见§二）。Campaign原暂停/预算未作变更。
- **旧升级关账基线**：DSH **0.1.7-rc.2**（2026-09-27 17:29:26Z U3 生产切换，P6b；**2026-09-30 P8 关账（用户指令提前）**——U4b 只读巡检全绿 + 新冻结点 `c85f3b9f…` + `preserve_after_resume ok=true`；关账后 MainPID **922156**、NRestarts=0、6 单元 active、15 域、accept2b **PASS=80 FAIL=0**、journal err=0；会话 1767（V4））。P7 巡检 1（09-29）+ P8 巡检 2（09-30）均全绿；旧基线 0.1.5-rc.2 履历见历史归档。
- **最近一次全面检查**：[archive/20-full-inspection-2026-09-19.md](archive/20-full-inspection-2026-09-19.md)（文档/代码/流程/运行态/UI；**四轮修复全部落地验收，结论已全部回填各模块，2026-09-22 归档**，见其 §十一）。
- **专项归档**：[archive/19-ui-unify.md](archive/19-ui-unify.md)（看板 UI 全局统一重构：**U1–U4 + 走查补丁已实施，csai 验收 PASS=72 FAIL=0**，结论已回填 16-dashboard/主题 §11.8·§11.9/CONTEXT；已归档只读）；[archive/23-llm-supply-throttle-2026-09-23.md](archive/23-llm-supply-throttle-2026-09-23.md)（LLM 供给联动调速 + 任务级选模型，已实施部署验收）；[archive/24-ops-audit-ui-flow-2026-09-23.md](archive/24-ops-audit-ui-flow-2026-09-23.md)（任务/知识/学习工作流可视化，已实施部署验收 accept PASS=80）。
- **已知遗留（非阻塞，待后续会话）**：sec-suite/asset-db/experience 内部少量 v4 读取函数（experience 仍被 dashboard-rpc/task 链路引用）；后续治理纳入27号对应工作包，不重开已关账迁移。
- **在办批次**：25 号方案 B1 大数据治理（42 号补丁）**已部署验收**；B2 部分完成（索引/聚合缓存/批量投影；FTS 缓期）；**B3 升级链 P1–P8 已全部完成并关账（CHAIN END，2026-09-30）**——生产 0.1.7-rc.2（U3 P6b 切换、finalize invariants failures=0、+72h 观察期 P7/P8 两次只读巡检全绿、U4b 新冻结点 + `preserve_after_resume ok=true`、用户指令提前关账；P6 首次失败已回滚+静音修复+预演后重试成功，窗口 2h56m25s、业务 RPO=0）。**遗留移交 27 号方案/观察期后治理**（僵尸泄漏两路径、设置保存写路径、failover 预流缺口、kbList、Campaign 3 预算、提交 SOP/SLA 等）见 [state open_issues](archive/upgrades/2026-09-26-dsh-0.1.7-rc.2-state.md)——详见[升级方案](archive/upgrades/2026-09-26-dsh-0.1.7-rc.2-plan.md) · [执行记录 §13–§19](archive/upgrades/2026-09-26-dsh-0.1.7-rc.2-record.md)。
- **27 号发现能力改造**：目标/请求/完整H2队列、可信读取、费用账本、worker认领隔离、回收事件和有界失败重试已部署；全域659/659、生产UI80/80、单任务收尾通过。范围与剩余缺口见 [27号§10.4–10.6](27-business-quality-and-capacity-plan-2026-09-30.md)。全方案未关账；采用闭环分批提交与发布验收后分批部署，业务增量提交`38deb2b`已上线；预算超限触发暂停放量，详见§二。
- **本轮合批上线（2026-10-09）**：change `20261009-nonbrowser-batch` 部署 WP02/WP01/WP05/WP07/WP10 修复（7 模块 15 落点，停写→启动 3.41s，全域 814/814）；Campaign 全 paused，不含浏览器/代理。详见 27 号 §15.132。
- **当前接续**：WP04/WP02已核实扣子单账号登录，25条请求观测含18种匿名与5种新登录接口（7条新增观测）；2组匿名访问边界可靠阴性。双账号暂缓；继续有效模板、读型POST/路径风险契约、HAR健康投影与单账号技术判定→知识归因。Campaign原额度/暂停未改，试点独立有界执行。
- **WP06/WP07待续**：旧原件剩18项转历史未知清单，无新原库/导出线索不再重复检索，不进入技术训练/收益计数；已找回材料保留，未知不判无洞。主线转新实验的可靠判定、版本/attempt归因与学习对照，见27号§15.119。
- **文档漂移排查**：B1–B5 全部闭环（2026-09-19）；详见历史归档。
- **领域语言**：[CONTEXT](../../bundles/dsh/CONTEXT.md)。
- **本批发布**：WP07平台来源隔离/统一漏洞卡版本（最终跨域692项通过）；WP10文献完整分页（know82项、RPC6项通过）；DNS同答案选址和TTL绑定（7+9项通过）。应用已完成冻结/隔离/生产RPC验收并恢复（PID1222799，kbList432项）；DNS工具已安装、31项远端测试/恢复通过，后续admission版33项远端测试/恢复及一次真实GET通过（HTTP200/code0、6个平台），见27号§15.30–15.33。
- **当前优先（2026-10-09）**：按用户明确授权加速，现有业务数据/代码可舍弃或重建；普通修复取消整树恢复和重复演练，测试按影响范围/合批执行。优先真实请求→有效实验→可信判定→知识效果；894ce9f学习去重与7e00291预算窗口已部署，本批业务响应质量及公开资源评测已完成生产对照。**WP01 D09（专项累计预算硬上限 + 预算审批人工化）已同版本快速发布并冒烟通过**，并完成原子域合规与备份/恢复核查（见§二、27号§15.127/§17/§18）。全案未关账。

## 二、最近进度结果

### 2026-10-10 · WP05 H3 生成器 + 根因聚合 + 旧分页饥饿（本地验收，未上线）

- **H3 生成器**（`6a569ce`）：新增 `task_h3_enqueue`——从 `endpoint` 请求观测的业务关系（主体/对象/动作）派生 H3；引用真实知识卡（显式 `card_ref` 或按动作/路径 `know.exp_search` 选卡），无匹配卡/无业务关系不伪造；稳定 `strategy_key` 幂等入队，经 `derive_intent`（C12）闭环。task 145/145。
- **根因聚合**（`cdcca8c`）：findings 增 `dup_of` 列，`vuln_reject` verdict=dup 落根因引用；新增查询 `vuln_root_causes` 按技术根因折叠（带上溯/环保护），返回 `independent_new`/`related`，同根因多 URL 折一个新增、证据全保留。vuln 92/92。
- **旧分页饥饿**（`0d3b544`）：`ledger_coverage_gaps` 原全局额度被前序维度耗尽致后序维度永久饥饿，改按维度独立计费（`SEC_LEDGER_MAX_GAPS_PER_DIM` 可覆盖）。ledger 33/33。
- 全域 **822/822**；三项均**未部署上线**。TTL/配额分离核心经复核已实现（§15.112/15.95），剩余旧积压无原因 ignored 的历史取证迁移（刻意保守）与真实探索收益。详见 27 号 §15.136。

### 2026-10-09 · 非越权合批部署（已上线）

- 按 §15.128（不做越权/双账号）后推进其余工作包并**合批上线** change `20261009-nonbrowser-batch`（源基线 `f008376`，DSH 0.1.7-rc.2）：WP02 非越权 Oracle 加固（E07 公开邮箱排除 / E05 多轮时间盲注 / E06 OOB 健康+窗口）、WP01 无进展停止（按真实进展非 heartbeat）、WP05 H1 指纹接线 + C06 vulnclass 仅 verified/rejected 才关闭、WP07 hit_matrix 改读 `know_scores`、WP10 stats unknown=null、`asset.fp_query` actor 补 reactor。
- 快速发布 7 模块 15 文件（源模板 + 已安装插件；view-vuln client 双落点），停写→启动 **3.41 秒**；15 落点摘要一致、六服务 active/NRestarts0/journal err0、无 running task/worker。生效核验：`ledger.coverage_metrics.vulnclass.indeterminate_classes` 已返回、`know.hit_matrix` 可查。Campaign 全 paused（放量须人工批预算），未做发布后 NAS 恢复；不含浏览器/代理（另一会话）。
- 续推 **WP02 E08/E04**（`971977d`）：file 类不再借用 `unauthz_diff`（改未注册 `file_probe` 能力缺口）；SQLi 布尔差分补健康基线稳定性与非注入对照。rules 50/50、全域 816/816。change `20261009-rules-oracle` 快速发布（1 模块 2 落点），服务 active/NRestarts0，`bus.status` 冷 1.66s/stats 19ms；见 27 号 §15.133。
- 续推 **WP03 D04 全局请求预算**（`ab4c2d0`）：run_cli 按 scope 速率/并发注入工具 `{{rate}}`（并发×每工具 ≤ scope rate_limit_qps），httpx 清单补 `-rl`。exec 95/95、全域 817/817。change `20261009-exec-rate` 快速发布（停写→启动 2.62s）；`exec.manifest_list(httpx)` 现含 `rate`；服务 active/NRestarts0。见 27 号 §15.134。
- 续推 **WP05 E15 + C12**（`3d97479`/`e6200f4`）：E15 同 URL 不同请求上下文（endpoint_ref：method/身份/对象）保留为独立观察；C12 H3 卡片引用须解析为真实卡（know 可用时校验）。vuln 91/91、task 144/144、全域 819/819。change `20261009-e15-h3` 快速发布（3 模块 6 落点，停写→启动 2.87s）；服务 active/NRestarts0。见 27 号 §15.135。
- 仍待：WP02 属性重放、WP03 fencing/工具内部并发/429 退避/F06、WP05 知识驱动语义闭环真实业务输入/TTL 旧积压取证迁移、WP07 独立样本/真实收益、WP10 其余视图 unknown。WP05 的 H3 生成器/根因聚合/旧分页饥饿已完成待上线（见上）。详见 27 号 §15.128–136/§16。

## 三、维护规则（通用，必须遵守）

1. **本文件只含当前**：新增进度写本文件；旧「最近结果」在新结果落地时整体移入历史归档。
2. **历史只归档**：历次更新日志、已完成节点、已关账待办、批次守则移入 [archive/progress-history.md](archive/progress-history.md) 与 [archive/upgrades/](archive/upgrades/)，只读不改写。
3. **批次守则随批次走**：仅在某个批次/专项期间有效的守则、模板、核验方法与该批次记录放在一起；批次归档时一并迁出，本文件只留通用规则。
4. **闭环合批交付**：完成可审查闭环并通过相关验证后提交推送；相关修复合批发布，按18号§2准备适用的回退/重建路径，运行验收后再扩大。阶段提交、部署验收、全方案关账分别记录，不等待整套方案结束才提交，不每个小修复单独重演灾备。
5. **真相源优先级**：运行态证据（`spool`）> 代码/manifest > 契约测试 > 文档；术语以 CONTEXT 为准，契约冲突以 [00-conventions](00-conventions.md) 为上位。
6. **文档同步**：代码/上线改动必须在对应模块文档内回填（版本/契约/未实现项/验收），不得只更新本进度文件；未实现的设计项须显式标注，不得当作现行机制。
7. **变更按风险验证**：按[18号§2](18-backup-and-maintenance.md#2-按变更风险执行2026-10-08用户授权)执行。普通修复复用可靠恢复基线或明确重建路径，不强制新NAS/整树恢复；必须保留数据的破坏性迁移等才做对应备份与演练。使用prepare时失败/75不得记成功，历史回执不得伪称新回执；会话续接不自动重启发布流程。

## 四、关键决策（已定，勿推翻）

多进程 + SQLite WAL（无依据不启动单写者架构专项）｜ event_outbox + dispatcher 跨进程投递 ｜ sync（同事务 SAVEPOINT 可回滚）/ async（outbox 派发 + retry/dead-letter）｜ approval_effects 幂等 effect outbox ｜ audit fail-closed（主链路写命令）｜ LLM 工具面 phase 动态子集 ｜ 兼容别名层已于 2026-09-19 清空 ｜ 当前ensureCol幂等列演进，用户已授权为质量和速度替换低效实现/重建业务数据，不以旧结构为硬限制 ｜ 14 域 + 总线

## 五、操作红线（每次会话必须遵守）

- 一切远程操作走 PATH 中的 `spool`（`spool exec csai "..."`），禁止绕过 spool 直接 SSH/curl 操作远程 Docker
- 禁止 `docker compose down`；绝对禁止对 n8n 执行 `docker compose down -v`/`--volumes`
- 禁止 `git add -f`；doc/hosts/config.ini/keys 相关敏感文件不入库
- 有状态服务（n8n/Memos/Bellkeeper 等）重建需用户批准；n8n 重启只能用 `docker stop sp-n8n && docker start sp-n8n`
- 生产变更按18号§2分级；远端上传前明确固定版本及适用恢复/重建路径，不把完整冻结/灾备预演当普通修复固定动作。
- bundle 模板改动后：先 `rsync -a bundles/dsh/ /opt/SilkSpool/bundles/dsh/` 再 `spool bundle dsh setup csai`（spool 读的是 /opt/SilkSpool/bundles/ 运行时副本）

发布检查点（2026-10-01）：27号D0–D3本批部署/小批运行完成，生产0.1.7-rc.2；WP03请求门禁与迟到账单已部署，默认只读预算闭环已通过，下一批费用边界及历史补账收尾。三个Campaign暂停、并发1，放量须先通过预算门禁；仍不升级0.2.0、不改旧升级STATE。

最新检查点（2026-10-09）：请求质量/eval v3/浏览器快捷入口已上线，单账号5种新接口/7条新观测已导入，两组本人—匿名—本人对照valid_clean；无新增漏洞/业务模型调用/goal。响应契约热加载完成；读型POST风险准入、HAR业务健康与阴性知识接线待续，双账号暂缓。复用已有验收，0.2.0不升级。
