# SilkSecAgent 进度（当前）

> **本文件只保留「当前状态 + 最近进度结果 + 通用规则」**。一切历史——历次更新日志、已完成节点（附 commit）、已关账待办、批次守则/模板——都在 [archive/progress-history.md](archive/progress-history.md)（只读不改写）。
> **滚动规则**：新结果写入本文件；当新结果使上一版「最近结果」过时，把上一版整体移入历史归档，保持本文件只含当前。不再新建「最新进度/本次升级」等副本。
> 模块契约与版本在 `00-conventions.md`…`18-migration.md` 内自维护；文档目录治理规则见 [README.md](README.md)。

## 一、当前状态

- **迁移计划真相源**：[18-migration](18-migration.md)（Phase 0–5）。
- **Phase 状态**：**Phase 0–5 全部完成并关账**；当前无进行中的迁移/整改批次。
- **运行基线**：DSH **0.1.5-rc.2**（U3 于 2026-09-15 生产切换、U4 于 2026-09-18 关账）；csai `silksecagent` active、NRestarts=0、14 域 registered、`aliases=0`；`sec-v5-accept.sh` **PASS=39 FAIL=0**。
- **专项归档**：[archive/19-ui-unify.md](archive/19-ui-unify.md)（看板 UI 全局统一重构：**U1–U4 + 走查补丁已实施，csai 验收 PASS=72 FAIL=0**，结论已回填 16-dashboard/主题 §11.8·§11.9/CONTEXT；已归档只读）。
- **已知遗留（非阻塞，待后续会话）**：sec-suite/asset-db/experience 内部少量 v4 读取函数（experience 仍被 dashboard-rpc/task 链路引用）；`18-migration` 的 DoD 仍须逐条核对。
- **文档漂移排查**：B1–B5 全部闭环（2026-09-19）；详见历史归档。
- **领域语言**：[CONTEXT](../../bundles/dsh/CONTEXT.md)。

## 二、最近进度结果

### 2026-09-19 · 19-ui-unify 看板 UI 全局统一（U1–U4 + 走查补丁，csai 验收通过，已归档）
- 依据 [archive/19-ui-unify.md](archive/19-ui-unify.md) 四相执行：U1 基样式表 → U2 面板 chrome+IA → U3 视图收敛 → U4 stats 聚合。
- 结果：csai `bundle dsh setup` + `restart silksecagent`（active、NRestarts=0）；`sec-v5-accept.sh --ui-headless` **PASS=72 FAIL=0**（含两条新门禁 + 13 面 headless health/RPC）；本地 UI 单测 **119 例全绿**。
- 变更：ui-core `ensureBaseStyles()` 基样式表（§2.2 十类，唯一 CSS 源）+ viewRegistry `group` 协议 minor + opIcon back/refresh/size + fmtNum + 表格统一单行省略等高；
  ui-panel 改名安全中心 / 五 KPI + 库存副条 / 「更多」二级导航（知识·学习·报告·审计 group=more）/ 去前置图标；
  视图内联 pill+cursor 收敛为 `.silksec-chip`；dashboard-rpc `stats` 改壳聚合、删 `assetDb.stats` 直查；
  `asset.overview` 增 `by_type`；`sec-v5-accept.sh` 新增 `ui-shared-css-unique`/`ui-class-defined` 门禁。
- 走查补丁（操作者反馈五条）：① 去侧栏/页头图标（同层级纯文字）；② 会话消息动作改 26×26 图标钮 + Tooltip；
  ③ 待审批/任务 KPI 无会话 seat 时经 secUiBus 弹 Modal（`openApprovalCenter`/`openTaskCenter` 去掉失效的主面板回退）；
  ④ 任务工作区筛选选项改 workspaces ∪ programs 全量（不随筛选塌缩）+ `.silksec-chip`；⑤ 全表 `td` 单行省略 + 固定列宽。
- 回填：主题文档 §5.1（去图标）/§11.8/§11.9、16-dashboard §四.8/§1.6/§1.7、CONTEXT「安全中心」、ui-surface-deps；
  结论回填后本文移入 [archive/19-ui-unify.md](archive/19-ui-unify.md)。

### 2026-09-19 · 文档治理规则 + PROGRESS 瘦身（本会话）
- [README.md](README.md) 增「文档治理规则」：**已完成的临时文档强制归档**、README 为正式文档唯一索引、临时文档收尾必须回填相关正式文档、系统更新即时回填、防漂移。
- PROGRESS.md 瘦身为「当前状态 + 最近结果 + 通用规则」；历史整体迁 [archive/progress-history.md](archive/progress-history.md)。
- 性质：纯文档整理，无线上改动。

### 2026-09-19 · 文档漂移排查 B5 闭环（B1–B5 全部完成）
- proxy / fgs / eval 三域按 manifest 与 csai 运行态对齐；修复 fgs `finding_add` 悬空引用与迁移脚本过期注释；清理 csai 四处过期重复测试副本。
- 契约 proxy 17/17、fgs 21/21、eval 29/29；`bundle dsh setup csai` 重部署 + 重启，`sec-v5-accept.sh` PASS=39 FAIL=0。

> 更早结果（B1–B4 文档漂移、兼容别名层移除、旧版统一清理、UI 原生面 P0–P7、DSH 0.1.5-rc.2 升级、自学习 L0–L6、Phase 1–4 全部节点）见 [archive/progress-history.md](archive/progress-history.md)。

## 三、维护规则（通用，必须遵守）

1. **本文件只含当前**：新增进度写本文件；旧「最近结果」在新结果落地时整体移入历史归档。
2. **历史只归档**：历次更新日志、已完成节点、已关账待办、批次守则移入 [archive/progress-history.md](archive/progress-history.md) 与 [archive/upgrades/](archive/upgrades/)，只读不改写。
3. **批次守则随批次走**：仅在某个批次/专项期间有效的守则、模板、核验方法与该批次记录放在一起；批次归档时一并迁出，本文件只留通用规则。
4. **单次会话 = 可回滚增量**：每个待办节点 = 一次会话，收尾须给出验收证据、commit 与回滚点。
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
