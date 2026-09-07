# SilkSecAgent v5 迁移进度追踪

> 本文件是 v5 领域插件化重构的**唯一进度真相源**。每次会话开工先读它判断当前进度；每次会话收尾必须更新它并附 commit hash。它被开工提示词（SESSION-PROMPT.md）引用，是递归推进的锚点。

## 一、总览

- **迁移计划真相源**：`18-migration.md`（Phase 0-5）
- **全局契约宪法**：`00-conventions.md`
- **文档状态**：00-18 全量定稿（2026-09-06，commit `2e593e9`）
- **领域语言**：`bundles/dsh/CONTEXT.md`
- **当前 Phase**：**Phase 1 —— 总线 + vuln 试点域**

## 二、已完成节点（附 commit 追踪）

| 节点 | 内容 | commit | 上线验收 |
|---|---|---|---|
| Phase 0 | 候选池缺陷热修：updateFinding noise 联动 + KPI 口径 + line229 守卫 + 数据修复脚本 | `4ae57cb` | ✅ 信号面 10→41，候选待消化 2，服务 active |
| 文档定稿 | 00-18 全量定稿 + 4 项关键决策落地（audit fail-closed / phase 子集 / 维持 00-18 / bus 暴露口径） | `2e593e9` | ✅（纯文档，无线上改动） |
| **1.1 总线骨架** | `@silksec/sec-domain-bus`：DomainRegistry（R1-R7 校验）/ CommandGateway（11 段管线）/ QueryGateway / EventOutbox+Dispatcher / ToolProjector / RpcProjector / 幂等三级键 / audit（fail-closed）/ 别名表 + 自举存储（idempotency/bus_meta/event_outbox/bus_subscription）+ sec-bus-cli | `f6eef85` | ✅ 契约测试 33/33 全绿（本地 + csai setup 内双跑）；服务 active；总线域 registered；audit 可写；events jsonl 正常；调度循环无回归 |
| **1.2 vuln 域平移** | `@silksec/sec-domain-vuln` + `sec-backend-vuln-sqlite`：C1-C11 全动词（register_signal/register_candidate/confirm/reject/submit/note/claim/release/verify_replay/attach_fgs/authz_diff）+ Q1-Q6 查询，直接接管现 findings 表（ensureCol 幂等列演进 claimed_by/claimed_at/updated_at/remote_*），候选池状态机根治 + 订阅 exec.run.completed；总线补：R3 收窄至命令 schema（查询 status 过滤合法）、域错误码 retryable 透传、`idempotent_ctx_fields`（认领键含会话身份） | `7ed085c` | ✅ 契约测试 38/38 全绿（本地 + csai setup 内双跑）；服务 active；web 宿主面 vuln registered:true（bus.domain.registered 事件确认，11 命令/6 查询）；v4 口径无回归（signal=41/candidate.pending=2/terminal=25/total=68）；v5 只读查询真实库冒烟通过；列演进 6 列 + 2 索引幂等就位 |
| **1.3 双投影接线 + 兼容别名** | ToolProjector 注册 `vuln_*` 工具（域注册后再投影时序修复 + 名称去重）；RpcProjector `/silksec-domain` `vuln.*` 路由（rpcOperator 注入）；dashboard-rpc 三 case（findings/findingGet/findingUpdate）切 `vuln.*`（v4 直写兜底）；别名表填充：finding_add（按 actor 分派 + info 降级候选 + E_IDEMPOTENT_CONFLICT→v4 dup 形状）、finding_query（visibility 映射）、finding_update（status_router：confirm 缺 evidence 收紧 / accepted→submit / dup_of 自动填充 / 当前值+note→note）、submission_draft（待 report 域）；分派别名可带 domain/warn；不变量 ctx 透传（dupTargetValid 兼容期放宽）；bus.aliases.yaml + setup §D 校验改 ESM import | `b561e3f` | ✅ 契约测试 39/39（bus）+ 44/44（vuln）全绿（本地 + csai setup 内双跑）；服务 active；AGENTS.md secbus 区块自动含 vuln 动词（再投影生效）；aliases count=4；真实库冒烟：finding_query→vuln.list total=41、finding_update status=new→E_STATE、confirm 缺 evidence→E_EVIDENCE_REQUIRED+hint；口径无回归（signal=41/pending=2/terminal=25）；deprecated_use 审计在记；调度循环正常 |
| **1.4 Phase 0 正式版 + 试点验收** | `p-v5-1-migrate-vuln.js` 正式入 bundle（复跑 Phase 0 修复幂等 + ensureCol 6 列 2 索引 + updated_at 回填 + 三口径断言 + 迁移动作落 v5 audit kind:migration）；`p-v5-2-pilot-accept.js` 试点验收脚本（三路写同一候选 / audit actor 可区分 / 幂等重放，临时库隔离）；manifest 登记两脚本 | `48b97f3` | ✅ 契约测试 39/39（bus）+ 44/44（vuln）全绿（本地 + csai setup 内双跑）；服务 active；线上迁移 dry-run 零变更、首跑/复跑零变更幂等（--expect=41,2,25 硬断言过），audit 两条 migration noop 记录；试点验收本地 + csai 12/12 全绿（三路写同一候选最终一条信号行、candidates.total=stats.pending=看板徽章同源、webhook/script/model 三 actor 可区分、confirm 幂等重放 replay:true 同果）；真实库冒烟：vuln.stats signal=41/pending=2/terminal=25、vuln.candidates.total=2、finding_update status=new→E_STATE 收紧；aliases deprecated_use 在记（count=4）；调度任务 #16/#17（03:00 recon）+ #37/#19（04:00 vuln）9/5-9/7 连续三天 ok=1 正常收尾（handoff 产出），观测起点 2026-09-07 |

## 三、待办节点（Phase 1，按顺序，每个节点 = 一次会话 = 一个可上线可回滚增量）

- [x] **1.1 `@silksec/sec-domain-bus` 骨架**：DomainRegistry / CommandGateway / QueryGateway / EventOutbox+Dispatcher / ToolProjector / RpcProjector / 幂等 / audit（fail-closed）/ 别名表 + 自举存储（idempotency/bus_meta/event_outbox/bus_subscription）。契约测试矩阵见 01-bus §2.8。**✅ 已完成**
- [x] **1.2 `@silksec/sec-domain-vuln` + `sec-backend-vuln-sqlite`**：从 asset-db.js 平移拆语义动词（register_signal/register_candidate/confirm/reject/submit/note/claim/release/verify_replay/attach_fgs/authz_diff + vuln_list/get/candidates/stats 等）。契约测试见 02-vuln §2.2。**✅ 已完成（只平移不切流：v4 写路径原样，双写观察期到 1.3/1.4 收口）**
- [x] **1.3 双投影接线 + 兼容别名**：ToolProjector 注册 `vuln_*` 工具（域注册后再投影时序修复）；RpcProjector 注册 `vuln.*` RPC；dashboard-rpc 的 findingUpdate/findingGet/findings case 切 `vuln.*`（v4 直写兜底保留至观察期）；别名 finding_add/finding_query/finding_update/submission_draft → 新动词（bus.aliases.yaml 已填充，status_router 扩展 accepted/note 分派 + finding_add_router + query_visibility_router 内建）。**✅ 已完成**
- [ ] **1.4 Phase 0 正式版 + 试点验收**：p-v5-0-fix-noise.js 正式入 bundle；试点验收（三路写同一候选 / audit 三 actor 可区分 / 幂等重放 replay:true / 连续 3 天 03:00/04:00 任务正常收尾）。**✅ 已完成（2026-09-07；commit 见 §二 1.4 行；3 天链路观测起点=1.3 上线当日 2026-09-07，9/7 已收尾 ok=1，9/8、9/9 自然完成后由 1.5 复核关账）**
- [ ] **1.5 观察期复核（3 天后，1 次会话）**：2026-09-10 复核 9/7-9/9 连续 3 天 03:00/04:00 任务全部 ok=1 收尾（守卫过、handoff 出）+ 候选池计数与信号面一致 → 关账 1.4，放行 Phase 2。

## 四、Phase 2-5 概览（后续会话，勿提前开工）

- Phase 2：数据域滚动搬迁（asset+endpoint → fact+know → ledger → task+exec → fgs → scope+approval → report/proxy/eval/dashboard）
- Phase 3：跨域事件化收尾（outbox 验收 / bus replay 演练 / memcore 旁路化 / eval 订阅）
- Phase 4：http-remote 后端试点（vuln 域）
- Phase 5：LLM 面收敛 + 守卫加固 + 评测（删别名 / 挂载矩阵 / 单写者复评）

## 五、关键决策（已定，勿推翻）

多进程 + SQLite WAL（单写者守护进程 Phase 5 复评）｜ event_outbox + dispatcher 跨进程投递 ｜ sync（同事务 SAVEPOINT 可回滚）/ async（outbox 派发 + retry/dead-letter）｜ approval_effects 幂等 effect outbox ｜ audit fail-closed（主链路写命令）｜ LLM 工具面 phase 动态子集 ｜ 兼容别名贯穿（7 天观察期）｜ 不改表名不迁库（ensureCol 幂等列演进）｜ 14 域 + 总线

## 六、操作红线（每次会话必须遵守）

- 一切远程操作走 PATH 中的 `spool`（`spool exec csai "..."`），禁止绕过 spool 直接 SSH/curl 操作远程 Docker
- 禁止 `docker compose down`；绝对禁止对 n8n 执行 `docker compose down -v`/`--volumes`
- 禁止 `git add -f`；doc/hosts/config.ini/keys 相关敏感文件不入库
- 有状态服务（n8n/Memos/Bellkeeper 等）重建需用户批准；n8n 重启只能用 `docker stop sp-n8n && docker start sp-n8n`
- bundle 模板改动后：先 `rsync -a bundles/dsh/ /opt/SilkSpool/bundles/dsh/` 再 `spool bundle dsh setup csai`（spool 读的是 /opt/SilkSpool/bundles/ 运行时副本）
