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
- **27 号发现能力改造**：目标/请求/完整H2队列与可信读取验证基础上，新增费用账本、worker认领隔离、回收事件和有界失败重试；全域659/659，生产未部署。范围与剩余缺口见 [27号§10.4–10.6](27-business-quality-and-capacity-plan-2026-09-30.md)。全方案未关账；采用闭环分批提交与发布验收后分批部署，当前增量已阶段提交并推送：`38deb2b`。
- **文档漂移排查**：B1–B5 全部闭环（2026-09-19）；详见历史归档。
- **领域语言**：[CONTEXT](../../bundles/dsh/CONTEXT.md)。

## 二、最近进度结果

### 2026-10-01 · 常驻NAS备份、维护入口与发布加速（维护已部署，27号业务增量未部署）

- 续接原会话：TrueNAS独立数据集配额256GiB，SFTP专用账号、加密去重restic；NFS因csai宿主禁止挂载已撤销。密钥在管理机keys目录托管，未入库。
- 首份成功备份覆盖5.42GB文件、39个SQLite库，85.48秒；NAS读回SQLite摘要/完整性验证6.86秒。失败的root证书读取不会记作成功；定时服务用受限资源root执行。常规备份各库分别一致，不能替代发布冻结点。
- 每6小时备份（留8份）、每周校验/恢复预演/prune、每日安全清理、每15分钟健康检查，6个timer均已启用；旧backup/retention timer已停用。旧本地图快照留2份，已清理1,855,012,864字节；results/flows/evidence/sessions不按目录年龄清除。
- 常规备份增加 `extra_roots`，覆盖现有三个外置项目工作区及其中SQLite；新统一入口 `silksec-ops.sh` 覆盖status/backup/drill/cleanup/restore-copy/preflight及原freeze/release命令。恢复到新目录并保留数据库权限；NAS超时输出健康失败；冻结自动暂停并恢复维护单元；测试临时目录随运行结束回收。
- 验证：维护7项、快照6项、root冻结10项、root发布恢复19项均通过；Go CLI及新增NAS RPC边界通过，构建/语法/diff通过。Go tools全包既有uptime测试失败已用HEAD覆盖对照复现，不计为本批通过。
- 当前旧发布目录 `20260913-rc2` 仍在NAS归档，完整读回校验已成功（快照`1725625f…`，逻辑97.77GB、新增4.82GB），正在删除前静态复核，最新 `20260926-017` 保留；删除尚未完成。全域659/659通过，57表的task/endpoint隔离迁移行数不变、完整性ok；预检含schema首次95.50秒、命中缓存3.58秒（约26.7倍；schema每次仍重验；较高负载轮次381.57→33.01秒）。
- 生产服务active、MainPID=922156、NRestarts=0；磁盘使用26.6%、可用约702GiB，NAS正常，6个维护timer有效。未重启主服务，未升级0.2.0、未发布27号业务增量。
- 契约与命令见[01-bus运维维护入口](01-bus.md#运维维护入口2026-10-01)。容量告警目前落systemd/journal，外部通知尚未接；证据持续增长仍需引用感知归档/扩容，不能宣称磁盘永不耗尽。

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

发布检查点（2026-10-01）：业务增量 `38deb2b` 已推送、未切换；用户随后要求优先固化维护流程。NAS在线备份及SQLite恢复预演已通过，维护定时器已上线；当前收尾发布预检与旧目录归档。27号正式部署仍需新冻结点和应用沙箱/小批运行验收，不使用旧升级STATE。
