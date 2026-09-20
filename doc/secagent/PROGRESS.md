# SilkSecAgent 进度（当前）

> **本文件只保留「当前状态 + 最近进度结果 + 通用规则」**。一切历史——历次更新日志、已完成节点（附 commit）、已关账待办、批次守则/模板——都在 [archive/progress-history.md](archive/progress-history.md)（只读不改写）。
> **滚动规则**：新结果写入本文件；当新结果使上一版「最近结果」过时，把上一版整体移入历史归档，保持本文件只含当前。不再新建「最新进度/本次升级」等副本。
> 模块契约与版本在 `00-conventions.md`…`18-migration.md` 内自维护；文档目录治理规则见 [README.md](README.md)。

## 一、当前状态

- **迁移计划真相源**：[18-migration](18-migration.md)（Phase 0–5）。
- **Phase 状态**：**Phase 0–5 全部完成并关账**；当前无进行中的迁移/整改批次。
- **运行基线**：DSH **0.1.5-rc.2**（U3 于 2026-09-15 生产切换、U4 于 2026-09-18 关账）；csai `silksecagent` active、NRestarts=0、14 域 registered、`aliases=0`；`sec-v5-accept.sh` **PASS=41 FAIL=0**（2026-09-19 全面检查修复后重跑）。
- **最近一次全面检查**：[20-full-inspection-2026-09-19.md](20-full-inspection-2026-09-19.md)（文档/代码/流程/运行态/UI）；第一批安全红线与 UI 高优先项已修复并部署（见其 §十一）。
- **专项归档**：[archive/19-ui-unify.md](archive/19-ui-unify.md)（看板 UI 全局统一重构：**U1–U4 + 走查补丁已实施，csai 验收 PASS=72 FAIL=0**，结论已回填 16-dashboard/主题 §11.8·§11.9/CONTEXT；已归档只读）。
- **已知遗留（非阻塞，待后续会话）**：sec-suite/asset-db/experience 内部少量 v4 读取函数（experience 仍被 dashboard-rpc/task 链路引用）；`18-migration` 的 DoD 仍须逐条核对。
- **文档漂移排查**：B1–B5 全部闭环（2026-09-19）；详见历史归档。
- **领域语言**：[CONTEXT](../../bundles/dsh/CONTEXT.md)。

## 二、最近进度结果

### 2026-09-19 · 第四轮修复：M1 幂等竞态 + 授权时效 + 批量提交 + external_id + 文档收尾（csai 已部署验收）
- 依据 [20-full-inspection-2026-09-19.md](20-full-inspection-2026-09-19.md) §十一.6 执行剩余全部建议项。
- M1：事务内幂等复检，并发同 key 返回 replay 而非 E_CONFLICT。
- 授权时效：scope.yml 增 `expires_at`/`reviewed_at`；过期 fail-closed（scope_check/exec/asset 三处一致）；`scope_expiring` 查询 + 看板过期/临期告警 + 设置页徽章。
- 批量提交：`task_submission_backlog` 为历史 confirmed 未提交幂等补建提交任务（线上补建 42 条，queued 不自动起 worker，待人工 task_run_now）。
- external_id：findings 增列 + 索引，跨源（cyberstrikeai/vuln-pipeline/外部）去重优先键。
- 文档：17-llm-surface 查询可见口径、15-eval C4 详述节、ui-surface-deps 陈旧条目清理。
- 验收：本地契约 **483 例** + UI 114 全绿；csai 部署后 `sec-v5-accept.sh` PASS=41 FAIL=0。
- 全部检查建议项已闭环；仅余需人工判定（重复发现合并）或设计变更（凭据环境变量化）的项，见报告 §11.7。

### 2026-09-19 · 第三轮修复：代码中危 + 供应链 + 数据卫生 + a11y（csai 已部署验收）
- 依据 [20-full-inspection-2026-09-19.md](20-full-inspection-2026-09-19.md) §十一.5 执行第三轮修复。
- 安全：沙箱不再整目录挂载 `$HOME`（M6，原暴露 `.ssh`/`fofa.conf`/浏览器登录态）；tools-manager 下载 sha256 校验（M8）。
- 代码：证据发布稳定窗整批化（M5）；approval 增 `effect_state` 独立列消除 `approved_effect_failed` 死逻辑（M9）。
- UI：审批/任务首帧骨架屏（B10）、面板降级提示（B11）、大队列单套 DOM（B12）、审计展开态稳定键（B13）、全表 a11y（aria-sort/role/aria-expanded/aria-pressed/aria-selected/aria-label）。
- 数据：新增 `data-hygiene.py`（program_id 唯一命中回填 / source 归一 / fgs 孤儿清理 / 重复发现报告，默认 dry-run）；候选去重返回 `dedup_reason`。
- 文档：09-approval（effect_state）、10-exec（沙箱隔离）回填。
- 验收：本地契约 466 例 + UI 114 全绿；csai 部署后 `sec-v5-accept.sh` PASS=41 FAIL=0。
- 未处理：存量 43 条 confirmed 批量提交任务、`data-hygiene --apply` 线上执行、授权时效字段、`external_id` 跨源去重、17/15/ui-surface-deps 回填、M1（幂等预检入事务）与 L 类卫生项。

### 2026-09-19 · 产出闭环 + 数据治理 + 任务回收 + DLQ 加固（csai 已部署验收）
- 依据 [20-full-inspection-2026-09-19.md](20-full-inspection-2026-09-19.md) §十一.4 建议执行第二轮修复。
- 产出闭环：`vuln_submit` 增 `remote_id`；新查询 `vuln_submission_queue`（confirmed 未提交，带 age_days/overdue）；`vuln_stats.signal.confirmed_unsubmitted`；看板 KPI 增「待提交 SRC」六卡；task 域订阅 `vuln.signal.confirmed` 幂等入队 `[提交] finding #id` 任务（phase=review）。
- 数据治理：新命令 `vuln_expire_candidates` + 每 6h 候选 TTL 治理（`noise=1 & status=new` 超 14d → ignored，`SEC_CANDIDATE_TTL_DAYS` 可调）；`vuln_dedup_check` 强制 host/vuln_type 至少其一；retention.sh 增 WAL checkpoint(TRUNCATE) + 0 字节残留库清理。
- 任务/事件：`task_reap` 回收范围扩至一次性任务（原只回收定时任务，僵尸 running 永久滞留）；`exec.run.completed` 订阅者按重试性逐条判定，确定性失败登记后丢弃，不再让整事件重试进 DLQ。
- UI/文档：授权设置工作区下拉与徽章同源（B6）；回填 02-vuln/05-task/16-dashboard。
- 验收：本地契约 **466 例全绿** + UI 114/114；csai `bundle dsh setup` 部署，`sec-v5-accept.sh` **PASS=41 FAIL=0**；线上 outbox **0 dead_letter / 0 pending**（3 条历史死信 + 1 条毒消息全部转 delivered）。
- 未处理（需策略决策）：存量 43 条 confirmed 批量提交、外键历史回填、授权时效字段、tools integrity、UI B8/B10–B13 与 a11y、17-llm-surface/15-eval/ui-surface-deps 回填。

### 2026-09-19 · 全面检查后修复：scope-guard 三处 fail-open + asset owner 列 + UI 健壮性（csai 已部署验收）
- 依据 [20-full-inspection-2026-09-19.md](20-full-inspection-2026-09-19.md) 执行第一批安全红线与 UI 高优先项修复，全部经契约/UI 测试与线上验收。
- 安全：exec 风险闸改逐目标判定（H1，跨项目不再放行）；exec `checkTarget` 改全项目先 exclude 再 scope（H2，与 scope 域同源）；asset scope 自查 program 缺失改 fail-closed `E_INVARIANT`（H3）；补 `resolve6`（M2）、`_file`/Burp 文件边界（M3）、grep 正则 ReDoS 限流（M4）；`vuln_dedup_check` 强制 host/vuln_type 至少其一（M10）。
- 功能：assets 补 `owner` 列（H4，线上已建列）；info 噪声回填改一次性迁移（M7）。
- UI：asset 视图 ui-core 缺席不再崩 bundle（B1）；同视图 KPI 跳链生效（B2）；报告/知识渲染防御（B3/B4）；报告阅读器竞态守卫（B5）；消除直接组件调用（B7）；补 `.silksec-btn-danger`（B9）。
- 文档：回填 S1/S3/S4/M1/M2/M4/M5/M6；更正初查 S2 误报（Phase 4 http-remote 实已实现）。
- 验收：本地契约 exec 26 / asset 31 / vuln 51 / bus 51 / task 38 / approval 19 / fact 23 / know 73 / ledger 22 / endpoint 25 / scope 15 + UI 114 全绿；`bundle dsh setup csai` 部署，`sec-v5-accept.sh` **PASS=41 FAIL=0**，`silksecagent` active、NRestarts=0。
- 未处理（需策略决策）：提交闭环、候选池治理、任务租约、DLQ 加固、外键回填、授权时效、其余 UI/代码卫生项（见报告 §十一.4）。

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
