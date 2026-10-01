# SilkSecAgent 进度（当前）

> **本文件只保留「当前状态 + 最近进度结果 + 通用规则」**。一切历史——历次更新日志、已完成节点（附 commit）、已关账待办、批次守则/模板——都在 [archive/progress-history.md](archive/progress-history.md)（只读不改写）。
> **滚动规则**：新结果写入本文件；当新结果使上一版「最近结果」过时，把上一版整体移入历史归档，保持本文件只含当前。不再新建「最新进度/本次升级」等副本。
> 模块契约与版本在 `00-conventions.md`…`17-llm-surface.md` 内自维护；文档目录治理规则见 [README.md](README.md)。

## 一、当前状态

- **迁移已关账归档**：[18-migration](archive/18-migration.md)保留Phase 0–5历史与验收；常驻正式契约为00–17。17号LLM工具面继续维护。
- **真实漏洞发现能力专项**：[27 号方案](27-business-quality-and-capacity-plan-2026-09-30.md)已按用户澄清重新审查，**本地持续实施、未部署**。仅以真实漏洞数量、技术质量和发现效率评价，撤销提交/accepted/赏金门槛；重点为真实请求、假设路由、可靠执行、候选丢失/误抑制、技术判定和知识实效。保留 12 个工作包、15 组技术验收；0.1.7 已关账，移交缺陷继续纳入，未改变生产。
- **DSH 0.2.0 研究与升级计划**：[26 号方案](26-dsh-0.2.0-upgrade-plan-2026-09-30.md)已完成调研，**待实施**；建议从 0.1.7-rc.2 直接升 0.2.0-rc.2，U3 前须旧链 P8 关账——**已满足（P8 于 2026-09-30 关账）**。当前生产版本与旧升级链状态不因本计划改变。
- **Phase 状态**：**Phase 0–5 全部完成并关账**；迁移链已结束；发现能力整改由27号专项继续推进。
- **运行基线**：DSH **0.1.7-rc.2**（2026-09-27 17:29:26Z U3 生产切换，P6b；**2026-09-30 P8 关账（用户指令提前）**——U4b 只读巡检全绿 + 新冻结点 `c85f3b9f…` + `preserve_after_resume ok=true`；关账后 MainPID **922156**、NRestarts=0、6 单元 active、15 域、accept2b **PASS=80 FAIL=0**、journal err=0；会话 1767（V4））。P7 巡检 1（09-29）+ P8 巡检 2（09-30）均全绿；旧基线 0.1.5-rc.2 履历见历史归档。
- **最近一次全面检查**：[archive/20-full-inspection-2026-09-19.md](archive/20-full-inspection-2026-09-19.md)（文档/代码/流程/运行态/UI；**四轮修复全部落地验收，结论已全部回填各模块，2026-09-22 归档**，见其 §十一）。
- **专项归档**：[archive/19-ui-unify.md](archive/19-ui-unify.md)（看板 UI 全局统一重构：**U1–U4 + 走查补丁已实施，csai 验收 PASS=72 FAIL=0**，结论已回填 16-dashboard/主题 §11.8·§11.9/CONTEXT；已归档只读）；[archive/23-llm-supply-throttle-2026-09-23.md](archive/23-llm-supply-throttle-2026-09-23.md)（LLM 供给联动调速 + 任务级选模型，已实施部署验收）；[archive/24-ops-audit-ui-flow-2026-09-23.md](archive/24-ops-audit-ui-flow-2026-09-23.md)（任务/知识/学习工作流可视化，已实施部署验收 accept PASS=80）。
- **已知遗留（非阻塞，待后续会话）**：sec-suite/asset-db/experience 内部少量 v4 读取函数（experience 仍被 dashboard-rpc/task 链路引用）；后续治理纳入27号对应工作包，不重开已关账迁移。
- **在办批次**：25 号方案 B1 大数据治理（42 号补丁）**已部署验收**；B2 部分完成（索引/聚合缓存/批量投影；FTS 缓期）；**B3 升级链 P1–P8 已全部完成并关账（CHAIN END，2026-09-30）**——生产 0.1.7-rc.2（U3 P6b 切换、finalize invariants failures=0、+72h 观察期 P7/P8 两次只读巡检全绿、U4b 新冻结点 + `preserve_after_resume ok=true`、用户指令提前关账；P6 首次失败已回滚+静音修复+预演后重试成功，窗口 2h56m25s、业务 RPO=0）。**遗留移交 27 号方案/观察期后治理**（僵尸泄漏两路径、设置保存写路径、failover 预流缺口、kbList、Campaign 3 预算、提交 SOP/SLA 等）见 [state open_issues](archive/upgrades/2026-09-26-dsh-0.1.7-rc.2-state.md)——详见[升级方案](archive/upgrades/2026-09-26-dsh-0.1.7-rc.2-plan.md) · [执行记录 §13–§19](archive/upgrades/2026-09-26-dsh-0.1.7-rc.2-record.md)。
- **27 号发现能力改造**：目标/请求/完整H2队列与可信读取验证基础上，新增费用账本、worker认领隔离、回收事件和有界失败重试；全域659/659，生产未部署。范围与剩余缺口见 [27号§10.4–10.6](27-business-quality-and-capacity-plan-2026-09-30.md)。全方案未关账；采用闭环分批提交与发布验收后分批部署，当前增量待阶段审查提交。
- **文档漂移排查**：B1–B5 全部闭环（2026-09-19）；详见历史归档。
- **领域语言**：[CONTEXT](../../bundles/dsh/CONTEXT.md)。

## 二、最近进度结果

### 2026-10-01 · 27号续接：可信执行链、费用归因与失败重试（本地，未部署）

- 保留此前目标/请求/完整H2队列增量。WP02新增统一HTTP入口，逐跳检查指定Program、固定代理/解析地址、隔离凭据并限制时间/响应量。
- 首个owner-only JSON读取验证器实际执行10个身份/对象/正反/重复对照；本地漏洞可确认，修复有反证，公开/失效身份/代理故障保持未知。可信判定签封落盘，capsule只接受decision_id；另一个finding、变更请求/证据/契约不能借用。
- 旧run/旧capsule不能自动确认；人工独立审校需operator、依据、步骤和影响。关闭关键词复现；登记不能自填已确认置信。结果page/grep同时封住软/硬链接越界读宿主文件。
- WP03费用按task/run独立记账并累加，迟到补账/重复去重/事务回滚/运行史裁剪后去重已验证；NULL与零区分，共用session总账拒绝重复归因。worker注册原子匹配认领；回收每批最多4项并逐项发布一次结束事实。
- WP05入队假设失败后默认冷却1小时，最多自动重试2次；其他派单入口不能绕过冷却与上限，旧回调不解除新任务关联。保留每轮任务、运行史与上限原因。
- **验证：task/exec 157/157，全域659/659，fail=0**。使用临时bus/SQLite、本地HTTP和CONNECT代理；node语法及diff空白检查通过。正式契约05/10及27号§10.6已更新；日志 `/tmp/secagent-27-wp03-all-contracts.log`。未远程操作、部署或安装真实项目验证契约，真实检出/学习收益未知。
- 下一步：WP03全局lease/ack、迟到账单轮询、预算窗口/预留及费用投影重算；WP05 unknown/旧手工策略重开及旧分页；WP02还需真实接口适配、凭据刷新、属性重放及其它漏洞族。全方案未完成不再阻止阶段提交；当前基线2c40d3f，审查后记录阶段commit，再进入备份、恢复预演与小批部署。不可回退到弱确认来处理能力缺口。

### 2026-10-01 · 文档治理与发布节奏

- 18迁移路线图归档，00–17保留为常驻契约；历史引用同步修正。旧最近结果迁入进度历史，当前不再列迁移DoD待办。
- 用户已同意闭环分批提交、发布验收后分批部署；27号§15为当前发布检查点。当前累计增量659项测试通过，发布模板清单含关联域；阶段提交推送后继续备份与恢复预演、小批运行验收。PATH spool只读采样确认服务active、DSH=0.1.7-rc.2、无运行中task/worker（queued=6），尚未发布。

## 三、维护规则（通用，必须遵守）

1. **本文件只含当前**：新增进度写本文件；旧「最近结果」在新结果落地时整体移入历史归档。
2. **历史只归档**：历次更新日志、已完成节点、已关账待办、批次守则移入 [archive/progress-history.md](archive/progress-history.md) 与 [archive/upgrades/](archive/upgrades/)，只读不改写。
3. **批次守则随批次走**：仅在某个批次/专项期间有效的守则、模板、核验方法与该批次记录放在一起；批次归档时一并迁出，本文件只留通用规则。
4. **闭环分批交付**：完成可审查闭环并通过相关验证后提交推送；明确发布范围、版本、备份与恢复方案后小批部署，通过运行验收再扩大。阶段提交、部署验收、全方案关账分别记录，不等待整套方案结束才提交。
5. **真相源优先级**：运行态证据（`spool`）> 代码/manifest > 契约测试 > 文档；术语以 CONTEXT 为准，契约冲突以 [00-conventions](00-conventions.md) 为上位。
6. **文档同步**：代码/上线改动必须在对应模块文档内回填（版本/契约/未实现项/验收），不得只更新本进度文件；未实现的设计项须显式标注，不得当作现行机制。

## 四、关键决策（已定，勿推翻）

多进程 + SQLite WAL（单写者守护进程 Phase 5 复评已决：无 E_CONFLICT 频发，维持多进程+WAL 终态，不启动单写者架构专项）｜ event_outbox + dispatcher 跨进程投递 ｜ sync（同事务 SAVEPOINT 可回滚）/ async（outbox 派发 + retry/dead-letter）｜ approval_effects 幂等 effect outbox ｜ audit fail-closed（主链路写命令）｜ LLM 工具面 phase 动态子集 ｜ 兼容别名层已于 2026-09-19 清空（机制保留为通用改名能力）｜ 不改表名不迁库（ensureCol 幂等列演进）｜ 14 域 + 总线

## 五、操作红线（每次会话必须遵守）

- 一切远程操作走 PATH 中的 `spool`（`spool exec csai "..."`），禁止绕过 spool 直接 SSH/curl 操作远程 Docker
- 禁止 `docker compose down`；绝对禁止对 n8n 执行 `docker compose down -v`/`--volumes`
- 禁止 `git add -f`；doc/hosts/config.ini/keys 相关敏感文件不入库
- 有状态服务（n8n/Memos/Bellkeeper 等）重建需用户批准；n8n 重启只能用 `docker stop sp-n8n && docker start sp-n8n`
- bundle 模板改动后：先 `rsync -a bundles/dsh/ /opt/SilkSpool/bundles/dsh/` 再 `spool bundle dsh setup csai`（spool 读的是 /opt/SilkSpool/bundles/ 运行时副本）
