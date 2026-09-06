# SilkSecAgent v5 · 领域插件化架构 · 总设计文档

> 版本：v5.0-draft-1 ｜ 起草：2026-09-06 ｜ 状态：**全量设计阶段（文档先行，代码重构在全部文档定稿后启动）**
> 性质：设计真相源。v4.x 全部文档已归档至 [`../archive/`](../archive/INDEX.md)（过期，仅供回溯）。
> 工程位置：csai `/opt/silkspool/dsh/`；版本受控源文件在 SilkSpool 仓库 `bundles/dsh/templates/`。
> **最高约定**：[`00-conventions.md`](00-conventions.md)（全局契约宪法——命名/actor/命令八铁律/信封/错误码/幂等/事件/审计/后端/测试/安全/版本化）。模块文档与它冲突时以它为准。

---

## 一、为什么重构（一段话版）

v4.x 的"模块"只是文件切分：findings 的闸门逻辑散落在 `addFinding`/`updateFinding` 函数体里，5 个写入口（工具面/看板 RPC/parser/webhook/审批钩子）各自调用，漏一个 if 就产生"31 条已确认漏洞仍挂候选徽章且被信号面隐藏"的僵尸数据（2026-09-06 实测取证，见归档 `silksecagent-v5-domain-plugin-architecture.md` §1.2 的 12 条写路径清单）。v5 把不变量从函数体搬进**域边界**：每个业务域是一个独立 cordis 插件，对外只暴露契约动词（经 CommandGateway 强制校验/事务/事件/审计），对内私有状态机与存储；后端（sqlite/http/file）可替换；模型与看板与脚本与人走**同一条路**。

## 二、六条设计公理

1. **一切领域皆插件**：每域一个 cordis 插件（`@silksec/sec-domain-*`），按 profile 组合挂载，对齐 DSH"一切皆插件"。
2. **一切写入皆命令**：数据只能经域命令动词变更；命令 = 状态机入口 + 事务 + 事件 + 审计，无第二写入口。
3. **一切读取皆查询**：读投影与写动词分离，查询纯读无副作用。
4. **一切联动皆事件**：跨域副作用只允许"发布事件 + 订阅方执行命令"，禁止跨域直调写函数。
5. **一切后端可替换**：域只依赖 repository 接口；sqlite-local / http-remote / file 同契约三适配器，能力矩阵声明，混布允许（本地 overlay + 远端主库）。
6. **一切入口双投影**：模型工具面与看板 RPC 面是同一组 handler 的自动投影（ToolProjector / RpcProjector），物理上消灭两套校验。

## 三、分层总图

```
┌─ DSH 平台层（不动）────────────────────────────────────────────┐
│  cordis 容器 / profiles(web|headless) / tools.register /        │
│  connection.rpc / spawn_worker / pi-ai 模型层 / dsh-bill         │
├────────────────────────────────────────────────────────────────┤
│  领域总线 @silksec/sec-domain-bus                                │
│  DomainRegistry · CommandGateway · QueryGateway · EventBus      │
│  ToolProjector · RpcProjector · 幂等表 · 统一 audit · 事件回放    │
│    ▲ provide('secDomain.{domain}') / inject（memcore 已验证的 DI 模式）
├────────────────────────────────────────────────────────────────┤
│  领域模块层（14 域，每域一文档）                                  │
│  vuln │ asset │ endpoint │ task │ fact │ know │ authz │ approval │
│  exec │ ledger │ report │ proxy │ fgs │ eval                    │
│    ▲ 每域只依赖自己的 repository 接口                             │
├────────────────────────────────────────────────────────────────┤
│  后端适配层（可替换，能力矩阵，三后端同契约测试）                   │
│  sqlite-local（默认）│ http-remote（外部系统）│ file（TSV/YAML）  │
└────────────────────────────────────────────────────────────────┘
  另两个投影面：看板（sec-dashboard 壳 + 域视图插件）· LLM 工具面（§五）
  治理旁路：sec-memcore（订阅事件 + 调 lifecycle 命令，fail-open，零裸 SQL）
```

## 四、文档地图（设计完成度索引）

> 编号即阅读顺序；**每份模块文档的对外暴露面（§一）永远在最前**。状态：`起草中` → `草案` → **`定稿`**（用户评审通过后冻结，才允许对应域代码动工）。

| # | 文档 | 域职责（一句话） | owns（单写者） | 状态 |
|---|---|---|---|---|
| 00 | [conventions](00-conventions.md) | 全局契约宪法 | —（总线管 audit/events） | **草案** |
| 01 | [bus](01-bus.md) | 领域总线：注册/网关/事件/投影/幂等/审计 | idempotency 表、audit.jsonl、data/events/ | 草案 |
| 02 | [vuln](02-vuln.md) | 漏洞信号/候选队列/证据复核 | findings 表、data/evidence/ | 草案 |
| 03 | [asset](03-asset.md) | 资产/指纹/分级 | assets、fingerprints 表 | 草案 |
| 04 | [endpoint](04-endpoint.md) | 接口面/参数队列 | endpoints 表、param-queue | 草案 |
| 05 | [task](05-task.md) | 任务/调度/执行史/worker 注册表 | tasks、task_runs、workers 表 | 草案 |
| 06 | [fact](06-fact.md) | 事实/边/黑板环境层/负知识 | facts、fact_edges、blackboard 表 | 草案 |
| 07 | [know](07-know.md) | 知识六仓：经验/文献/先验/规程/收割/体检 | exp_*、kb_* 表、rules/、vulncards/ | 草案 |
| 08 | [scope](08-scope.md) | 授权/项目/排除/凭据引用/规则 | scope.yml、programs、credentials 表 | 草案 |
| 09 | [approval](09-approval.md) | 统一审批中心（kind 注册表） | approval_requests 表 | 草案 |
| 10 | [exec](10-exec.md) | 工具执行/沙箱/QPS/worker 派生/parser 提案 | tools.d/、results/、flows/ | 草案 |
| 11 | [ledger](11-ledger.md) | 纪律台账/卡使用/覆盖/雷达队列 | pipeline/{program}/ 台账文件 | 草案 |
| 12 | [report](12-report.md) | 报告生成/提交稿 | reports/ 全树（含 submissions/） | 草案 |
| 13 | [proxy](13-proxy.md) | 代理池 | pool.json/live/blocklist | 草案 |
| 14 | [fgs](14-fgs.md) | 任务内决策图 | fgs_nodes 表 | 草案 |
| 15 | [eval](15-eval.md) | 活评测集/假阳性消融 | data/eval/ | 草案 |
| 16 | [dashboard](16-dashboard.md) | 看板壳 + 域视图插件化 + RPC 投影消费 | client 资源 | 草案 |
| 17 | [llm-surface](17-llm-surface.md) | LLM 工具面/挂载矩阵/prompt 体系对接 | — | 草案 |
| 18 | [migration](18-migration.md) | 迁移路线 Phase 0-5/回滚/数据修复 | — | 草案 |

**依赖关系速览**（阅读时的心智图）：bus 是所有域的宿主；vuln/asset/endpoint/fact/know 相互只通过事件联动；authz 是 exec 的前置（守卫链）；approval 只发事件不直写任何域；ledger 订阅 exec 产物；task 调 exec 派生 worker；memcore 订阅全部域的 lifecycle 事件。

## 五、LLM 只见动词不见存储（总则，细节在 17）

- 工具面 = 契约自动投影（工具名=动词名，schema=命令 schema，描述=manifest `agent_note`）；
- model 不可用的动词（机器直灌通道/审批裁决/scope 写/调度收尾）**根本不向模型注册**（profile × actor 白名单挂载矩阵）；
- 状态机私有：模型没有 `update X SET status` 类自由动词；
- 脚本产 proposal 不落库：治理/采集脚本的 manifest 废止 `store` 直写，落库只有域命令一条路；
- run_cli 沙箱对域 owned 文件不可写（manifest owns × sandbox 白名单交叉断言）。

## 六、关键取舍（已定，模块文档不得推翻）

| 决策 | 选择 | 一句话理由 |
|---|---|---|
| 单写者进程 vs 多进程开库 | 保留多进程 + SQLite WAL，写收敛于网关（进程内单入口） | 单写者守护进程改动面过大；契约层单写者律已消灭全部 v4.x 病灶；Phase 5 复评 |
| 域粒度 | 14 域 | 一张状态机 + 一个 owner 为界；fingerprints 等读模型不单独成域 |
| 工具改名 | 域前缀新名 + 旧名别名一个观察期 | prompt/objective 里的工具引用需脚本化改写（p14-1 先例） |
| asset-db.js 1865 行 | 按域搬迁不重写 | v4.x 闸门/事务逻辑是对的，搬进域+套壳 |
| http-remote 时机 | Phase 4，vuln 域试点 | 先把契约做实，再接外部漏洞管理系统 |
| 表名/库文件 | 不改名不迁库（sqlite-local 后端直接接管现表） | 迁移风险最小化；列级演进走域内 ensureCol |

## 七、终审裁决记录（2026-09-06，跨文档冲突消解）

8 个起草 agent 产出 17 份模块文档后，终审对四处分歧做了裁决，相关文档已同步对齐：

| # | 分歧 | 裁决 | 依据 |
|---|---|---|---|
| 1 | `data/reports/submissions/` 归属（02-vuln 初稿 own 它 vs 12-report 方案 A） | **归 report 域**（owns `reports/` 全树含 submissions/）；`vuln_draft_submission` 从 vuln 契约删除，旧名 `submission_draft`/`vuln_draft_submission` 经总线别名指向 `report_draft_submission`；INV"草稿仅 confirmed/submitted"随迁为 report 域 INV-R6 | 一棵目录树一个 owner；vuln 域保持信号状态机纯度 |
| 2 | 卡片使用记录归属（07-know 初稿判 know vs 11-ledger 判 ledger） | **归 ledger 域**（`ledger_log_card_usage`，文件 `data/pipeline/{program}/card_usage-{date}.jsonl`）；know 域对齐为纯消费方（订阅 `card_usage.logged` + 新增跨域查询 `ledger_usage_query`） | v4 实测文件在 pipelineDir 台账树（sec-pipeline.js L146，know 稿初版路径有误）；attempts/card_usage/handoff 三产物同节奏同守卫 |
| 3 | verify_replay 归属（11-ledger 判 vuln，但 02-vuln 初稿无此命令） | **归 vuln 域 `vuln_verify_replay`（C9）**，补全命令规格；vuln 域新增 owns `data/evidence/{finding_id}/` | 操作对象与产物（evidence 包、verify-log）归 vuln；判定驱动 finding 置信——"记录 vs 判定"不同族 |
| 4 | 宪法 actor 集是否新增 `exec`（05-task §四.1 提议） | **维持开放问题，未修宪**；过渡期 system actor + cause 链（审计指向原始事件） | 与域名 `exec` 撞名有歧义风险；待用户定稿评审时显式裁决（候选方案：更名 `reactor`/`subscriber` 或维持 system+cause） |

**用户逐项裁决（2026-09-06 第二轮，6 项全部落章）**：

| # | 问题 | 裁决 | 落点 |
|---|---|---|---|
| 5 | fgs_update 单动词 vs 拆分 | **维持拆 6 语义动词**（start/complete/fail/block/deprecate/annotate + 兼容别名），不修宪 | 14-fgs §四.1 关闭 |
| 6 | fact_transition 的 `to` 豁免 | **批准豁免**，写入宪法 §四.1"已批准豁免"条款（三条件边界：调度判定型 / 仅 system+human / 不向模型注册） | 宪法 draft-2 + 06-fact C7 |
| 7 | know 子仓动词命名 | **免域前缀 + 宪法 §二 修订**为 `{domain}_{subrepo?}_{对象?}_{动作}` 可选中段（know 先例条款） | 宪法 draft-2 + 07-know §四.1 关闭 |
| 8 | 事件订阅方 actor 身份 | **新增第 9 类 `reactor`**（弃撞名原名 exec；approval 事件保留专用 approval actor） | 宪法 §三 + 05-task C13/C14、02-vuln C10、14-fgs F4、07-know pb_outcome、10-exec 全部对齐 |
| 9 | 自执行任务完结语义 | **用户方案：三段式**——声明完成（C16 `task_submit_complete`，model）→ 统一拦截兜底（scheduler 扫描防漏声明）→ 审批裁决（C17 `task_complete`，approval）；三产物守卫降为审批单 payload 展示，**人工裁决即守卫** | 05-task C16-C17 新增 + 09-approval kind 7 `task-complete` |
| 10 | assets owner 列 | **增列 + 分两步固化**：Phase 2 ensureCol + asset_grade 加 owner/owner_evidence 参数（证据即参数）；先记录按接触回填，confirmed+third_party 覆盖 ≥60% 深挖候选集后 deep_queue 固化 owner='confirmed' | 03-asset §四.1 关闭 + §1.3.3 参数表 + 结构性闸门五列 |

## 八、待用户裁决的开放问题（定稿评审清单）

~~宪法级 6 项~~ **已全部裁决（2026-09-06，见 §七表 5-10）**。剩余为各文档 §四的**实现期观察项**（无需现在拍板，按文档所列倾向推进、实证后复评）：02-vuln §四 2-6、03-asset §四 2-7、04-endpoint §四 1-6、05-task §四 3-6、06-fact §四 2-6、07-know §四 2-6、08-scope §四 O-1~O-6、09-approval §四 O-1~O-6、10-exec §四 1-5、11-ledger §四 2-5、12-report §四 1-5、13-proxy §四 1-5、14-fgs §四 2-6、15-eval §四 1-5、16-dashboard §四 1-6。

## 九、与归档文档的关系

- v4.x 运行态快照（进程清单/数据规模/待人工 H-001/H-002）：归档 `../archive/README.md`（2026-09-05 v4.7 时点）——v5 落地前的日常运维仍参考它；
- v4.x 系统解剖（写路径/表结构/工具清单）：归档 `../archive/silksecagent-system-complete.md`——各模块文档"现状代码映射"节的取证来源；
- DSH 升级手册/回滚手册：归档对应文件，升级操作时仍有效；
- 本目录文档是**唯一**设计真相源；归档文档与本文冲突，一律以本文为准。

## 附：修订记录

| 版本 | 日期 | 变更 |
|---|---|---|
| v5.0-draft-1 | 2026-09-06 | 总体重建：v4.x 文档全量归档；确立 00-18 共 19 份文档的设计体系与完成度索引 |
| v5.0-draft-2 | 2026-09-06 | 19 份文档全部起草完成（8 并行 agent）；终审裁决 4 项跨文档冲突（§七）；状态表全部置"草案"；汇总待用户裁决开放问题（§八） |
| v5.0-draft-3 | 2026-09-06 | 用户逐项裁决 6 项宪法级问题全部落章（§七表 5-10）：reactor actor 宪法化 / know 子仓命名豁免 / fact_transition to 豁免 / fgs 维持拆分 / 自执行任务三段式收尾（C16-C17 + kind 7）/ owner 列分两步固化；§八 仅余实现期观察项 |
