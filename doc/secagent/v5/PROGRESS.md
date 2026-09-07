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
| **1.1 总线骨架** | `@silksec/sec-domain-bus`：DomainRegistry（R1-R7 校验）/ CommandGateway（11 段管线）/ QueryGateway / EventOutbox+Dispatcher / ToolProjector / RpcProjector / 幂等三级键 / audit（fail-closed）/ 别名表 + 自举存储（idempotency/bus_meta/event_outbox/bus_subscription）+ sec-bus-cli | 本次提交 | ✅ 契约测试 33/33 全绿（本地 + csai setup 内双跑）；服务 active；总线域 registered；audit 可写；events jsonl 正常；调度循环无回归 |

## 三、待办节点（Phase 1，按顺序，每个节点 = 一次会话 = 一个可上线可回滚增量）

- [x] **1.1 `@silksec/sec-domain-bus` 骨架**：DomainRegistry / CommandGateway / QueryGateway / EventOutbox+Dispatcher / ToolProjector / RpcProjector / 幂等 / audit（fail-closed）/ 别名表 + 自举存储（idempotency/bus_meta/event_outbox/bus_subscription）。契约测试矩阵见 01-bus §2.8。**✅ 已完成**
- [ ] **1.2 `@silksec/sec-domain-vuln` + `sec-backend-vuln-sqlite`**：从 asset-db.js 平移拆语义动词（register_signal/register_candidate/confirm/reject/submit/note/claim/release/verify_replay/attach_fgs + vuln_list/get/candidates/stats 等）。契约测试见 02-vuln §2.2。
- [ ] **1.3 双投影接线 + 兼容别名**：ToolProjector 注册 `vuln_*` 工具；RpcProjector 注册 `vuln.*` RPC；dashboard-rpc 的 findingUpdate/findingGet/findings case 切 `vuln.*`；别名 finding_add/finding_query/finding_update/submission_draft → 新动词。
- [ ] **1.4 Phase 0 正式版 + 试点验收**：p-v5-0-fix-noise.js 正式入 bundle；试点验收（三路写同一候选 / audit 三 actor 可区分 / 幂等重放 replay:true / 连续 3 天 03:00/04:00 任务正常收尾）。

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
