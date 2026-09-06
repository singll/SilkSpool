> ⚠️ **历史归档文档（2026-09-06 起过期，仅供回溯查看）**
> 本文档描述的是 SilkSecAgent **v4.x 单体架构**的设计/状态/研究，已被 **v5 领域插件化架构**全面取代。
> 当前设计真相源：[`../v5/README.md`](../v5/README.md)（总设计）+ [`../v5/00-conventions.md`](../v5/00-conventions.md)（全局契约约定）。
> 本文件原文如下，未做任何内容修改。

---

# SilkSecAgent v5 领域插件化架构重构方案（"一切皆领域插件"）

> 版本：v5.0-draft ｜ 起草：2026-09-06 ｜ 性质：大重构设计方案（待评审后分阶段落地）
> 前置文档：[README.md](README.md)（v4.7 状态）｜ [silksecagent-system-complete.md](silksecagent-system-complete.md)（v1.3 系统全景）
> 本文回答一个问题：**如何把现在"函数袋 + 多入口直写"的单体，重构成 DSH"一切皆插件"风格的领域模块体系——每个功能原子化、内部化，对外只留统一契约入口，LLM 只见动词不见存储。**

---

## 目录

1. [实测调查结论（为什么必须重构）](#一实测调查结论)
2. [目标架构：领域总线 + 领域插件 + 可替换后端](#二目标架构)
3. [统一契约约定（外部模块调用唯一标准）](#三统一契约约定)
4. [逐模块重构计划（14 个领域模块）](#四逐模块重构计划)
5. [LLM 统一接口层（模型只见动词不见存储）](#五llm-统一接口层)
6. [看板/GUI 改造（双投影单一 handler）](#六看板gui-改造)
7. [迁移路线图（Phase 0-5）](#七迁移路线图)
8. [风险与回滚](#八风险与回滚)

---

## 一、实测调查结论

> 取证方式：`spool exec csai` 直查 `/opt/silkspool/dsh/plugins/`（运行代码）+ `data/asset-graph.db`（运行数据）。以下全部为 2026-09-06 实测，非文档推断。

### 1.1 触发本次重构的实证：候选池不消减缺陷

用户观察「让 agent 执行确认漏洞，待验证候选不减少」，实测坐实，且比观察到的更严重：

```sql
-- asset-graph.db findings 表实查
SELECT noise, status, COUNT(*) FROM findings GROUP BY noise, status;
-- noise=0（信号面）: confirmed 5 + dup 4 + false_positive 1        → 10 行
-- noise=1（候选池）: confirmed 31 + dup 7 + fp 5 + ignored 13 + new 2 → 58 行
```

三个连锁缺陷：

1. **确认动作不消减候选**：`updateFinding`（asset-db.js，`finding_update` 工具与看板 `findingUpdate` RPC 的共同落点）只改 `status/confidence/FGS 节点/评测回流`，**从头到尾不触碰 `noise` 列**。agent 确认一条候选后，该行变成 `status=confirmed AND noise=1` 的"僵尸"——从候选计数里不消失，也不进信号面。
2. **31 条已确认漏洞对用户不可见**：信号面查询（`findingWhere` 默认 `noise=0`）把这 31 条 `confirmed` 全部过滤掉了——**它们既不在漏洞列表，也留在候选徽章里**。唯一合法的"就地升级"路径是重新走一遍 `finding_add` 且弱指纹命中，agent 确认时根本不会这么做。
3. **候选池没有生命周期**：候选池只是 `noise=1` 的一个**可见性视图**，不是一个有状态机的工作队列。`findings_noise` KPI 统计 `COUNT(*) WHERE noise=1`（不看 status），所以候选徽章永远是 58、只增不减——这就是"执行完确认操作但候选没有任何削减"的直接原因。

### 1.2 根因定性：不是漏了一个 UPDATE，而是架构没有域边界

把全部写路径枚举出来（这是重构的输入清单）：

| # | 写入方 | 入口 | 直写对象 | 实测位置 | 问题 |
|---|--------|------|----------|----------|------|
| 1 | 模型工具面 | asset-graph.js 38 个工具 | asset-db.js 76 个导出函数直接调用 | `plugins/sec-suite/asset-graph.js` | 工具=函数指针袋，无契约、无事务边界、无事件 |
| 2 | 看板 RPC 面 | dashboard-rpc.js 52+ case | 同一批 asset-db/experience 函数 | `plugins/sec-suite/dashboard-rpc.js` | **第二套入口**：与工具面各写各的调用+校验（findingUpdate 透传 updateFinding，没有补候选消减，双面同病） |
| 3 | sec-suite 主文件 | run_cli 后处理/parser 入库 | `applyParsedResult` 直写 assets/endpoints/findings | `plugins/sec-suite/index.js` + parsers.js | 工具产物→领域数据无领域校验（噪声闸门在 addFinding 里，靠调用纪律） |
| 4 | 审批副作用 | APPROVAL_KINDS[].onApprove | 直调 serializeScope（写 scope.yml）+ taskCreate + radar 追加 + fact 写入 | index.js:539-764 | **跨域直写的典型**：审批域的批准动作亲手去改授权域/任务域/雷达文件/事实域 |
| 5 | 记忆治理引擎 | memcore sweep/transition | `import('../sec-suite/asset-db.js')` + **69 处裸 SQL** 直改 blackboard/facts/exp_cards/kb_docs | `plugins/sec-memcore/index.js:80` | 治理引擎绕过一切领域 API 直改领域表（依赖反转只做了一半：validateWrite 是钩子，transition 是裸写） |
| 6 | FGS 沉淀钩子 | 任务 done → persistFgsFacts | 直写 facts | asset-db.js | 跨域直写（任务域收尾 → 事实域落库） |
| 7 | xray webhook | webhook.js → addFinding | findings | webhook.js | 走了 addFinding（✅），但机器直灌与人工登记共用一个动词，语义混杂 |
| 8 | 治理脚本 | grade-assets.py | **Python sqlite3 直连** `UPDATE assets SET score/level` | scripts/pipeline/grade-assets.py:105,152 | 完全绕过 Node 进程内一切闸门（未分级准入、评分口径、审计全部失效） |
| 9 | 台账工具 | sec-pipeline 8 工具 | 直写 attempts-*.tsv / card_usage-*.jsonl / param-queue / radar-queue | plugins/sec-pipeline/index.js | 文件型领域数据（台账/雷达/参数队列）没有域 owner，工具=owner |
| 10 | 调度器 | scheduler.js → taskFinishScheduledRun 等 | tasks/task_runs/workers | scheduler.js | 任务域内部（可接受），但流程守卫混在 taskUpdate 里 |
| 11 | 人工/运维 | 手编 scope.yml / spool sync push / 手改 vulncards yaml / seed-skills.sh | scope.yml / vulncards / rules / AGENTS.md | 多处 | scope.yml 有三个写入方（serializeScope、spool sync、人工），无单一 owner，靠"协同纪律"文档约定 |
| 12 | worker 进程 | headless profile 每进程各开 SQLite | 同库多进程写（WAL 兜底） | profiles/headless | 模型所在进程**直接持有数据库句柄**——LLM 面与存储面物理同层 |

**定性**：现在系统里"模块"只是**文件切分**（asset-db.js / experience.js / dashboard-rpc.js），不是**架构边界**。`addFinding` 里的噪声闸门、`taskUpdate` 里的流程守卫、`exp_store` 里的语义去重，都是"函数里顺手的 if"，而不是"域不变量"。任何一个新入口（新工具、新 RPC case、新脚本、审批钩子）想正确地写 findings，必须**知道并复述**所有 if——漏一个就是本文 1.1 的僵尸候选。这正是要重构的东西：**把不变量从函数体搬进域边界，让绕不过去成为物理事实。**

### 1.3 已有的正确种子（重构不是推倒重来）

- **tools.d manifest（31 个）**：run_cli 的工具声明已高度插件化（risk/target_param/requires/produces/parser/store）——执行域其实已经做对了，v5 把这个模式推广到数据域。
- **memcore 依赖反转**：`ctx.provide('secMemoryLifecycle')` + 存储 side `ctx.inject` 可选注入 + fail-open——**cordis DI 做域服务注册的可行性已被本代码库验证**，v5 只是把这个模式从"治理旁路"推广为"全域架构"。
- **统一审批中心 APPROVAL_KINDS**：kind 注册表（validate + onApprove）已经是"动词注册表"的雏形，v5 把它泛化为 CommandGateway。
- **scope-guard 链**：run_cli 前置硬校验链是"命令网关管线"的雏形（校验→执行→审计→落盘），v5 把它复制到写动词上。
- **addFinding 的完整性闸门 / exp_store 的语义去重**：不变量逻辑现成，v5 只是给它一个强制经过的壳。

---

## 二、目标架构

### 2.1 设计公理（对齐 DSH"一切皆插件"）

DSH 的本质：cordis 容器 + 一切能力（UI/LLM/存储/工具）都是插件，profile 组合决定挂什么。pi agent 的本质：模型只通过工具面（capability surface）与世界交互，工具是契约的投影，不是存储的把手。

推出本方案六条公理：

1. **一切领域皆插件**：每个业务域（漏洞/资产/任务/事实/知识/授权/审批/执行/台账/报告/代理/FGS）打包为独立 cordis 插件，按 profile 组合挂载，有自己的 manifest、契约、测试、版本。
2. **一切写入皆命令**：数据只能通过域的 command 动词变更；动词 = 状态机入口 + 事务 + 事件。没有第二个写入口（脚本、看板、审批钩子、治理引擎、LLM 全部一样）。
3. **一切读取皆查询**：读投影（列表/统计/详情/导出）与写动词分离，查询绝不隐含副作用（`exp_search` 的 recordSignal 副作用收编为显式信号命令）。
4. **一切联动皆事件**：跨域副作用（批准→授权、确认→候选消减、done→事实沉淀、parser→资产登记）只允许"发布领域事件 + 订阅方各自执行命令"，禁止跨域直调写函数。
5. **一切后端可替换**：域模块只依赖自己声明的 repository 接口；`sqlite-local`（默认）/`http-remote`（外部系统对接）/`file`（TSV/YAML）是同契约的三个适配器。换漏洞管理后端 = 换一个 backend 插件，vuln/asset/task/knowledge 域代码零改动。
6. **一切入口双投影**：模型工具面和看板 RPC 面是同一组 command/query handler 的两个投影（自动生成），物理上杜绝"两套校验"。

### 2.2 分层总图

```
┌─ DSH 平台层（不动）────────────────────────────────────────────┐
│  cordis 容器 / profiles(web|headless) / tools.register /        │
│  connection.rpc / spawn_worker / pi-ai 模型层                    │
├────────────────────────────────────────────────────────────────┤
│  领域总线层（新插件 @silksec/sec-domain-bus）                     │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ DomainRegistry   域 manifest 注册/版本/依赖/健康自检        │  │
│  │ CommandGateway   写动词唯一咽喉：                          │  │
│  │                  schema 校验→前置不变量→后端事务→事件→audit │  │
│  │ QueryGateway     读投影：可见域/分页/缓存失效              │  │
│  │ EventBus         领域事件发布订阅（进程内同步 + jsonl 留痕） │  │
│  │ ToolProjector    从契约自动生成模型工具（含 RoE 描述）       │  │
│  │ RpcProjector     从契约自动生成看板 RPC case               │  │
│  └──────────────────────────────────────────────────────────┘  │
│    ▲ ctx.provide('secDomain.vuln') 等 / ▲ ctx.inject（memcore 已验证的 DI 模式）
├────────────────────────────────────────────────────────────────┤
│  领域模块层（每域一个独立插件，本方案 §四逐个计划）                │
│  ┌────────┬────────┬────────┬────────┬────────┬────────┐      │
│  │  vuln  │ asset  │  task  │  fact  │  know  │  scope │ ...  │
│  │(漏洞/候选│(资产/指纹│(任务/调度│(事实/黑板│(知识/卡 │(授权/项目│      │
│  │ /证据/提交)│/分级)  │ /worker)│ /负知识)│ /规则)  │ /排除)  │      │
│  └───┬────┴───┬────┴───┬────┴───┬────┴───┬────┴───┬────┘      │
│      │ 每域只依赖自己声明的 Repository 接口                      │
├──────▼──────────────────────────────────────────────────────┤
│  后端适配层（每域可替换，同契约 contract test）                   │
│  ┌──────────────────┬──────────────────┬──────────────────┐   │
│  │ sqlite-local(默认) │ http-remote(外部对接) │ file(TSV/YAML) │   │
│  └──────────────────┴──────────────────┴──────────────────┘   │
└────────────────────────────────────────────────────────────────┘
```

### 2.3 域插件解剖（对标 DSH 插件结构）

```
sec-domain-vuln/                  # 一个域 = 一个 cordis 插件
  index.js                        # apply(): provide('secDomain.vuln', service)
  manifest.yaml                   # 域声明（见 §三）
  commands/                       # 写动词（每个一个文件：schema+不变量+事务+事件）
    register-signal.js  register-candidate.js  confirm.js  reject.js  submit.js ...
  queries/                        # 读投影
    list.js  get.js  stats.js  candidates.js  coverage.js ...
  events/                         # 事件定义（payload schema）
  backend/
    repository.js                 # 接口（类型注释 + 契约测试套）
    sqlite.js                     # 默认实现（从现 asset-db.js 相应段迁入）
    http.js                       # 外部漏洞管理系统适配（Phase 4）
  test/                           # 契约测试（三个后端跑同一套）
```

- **挂载**：`sec-vuln-plugin-setup.sh`（沿用现 sec-*-plugin-setup.sh 模式）+ profile package.json 加行。web/headless 双面挂载（域服务双面各自实例化，SQLite WAL 跨进程，与现状一致——见 §2.5 取舍）。
- **memcore 的位置**：治理引擎改为订阅领域事件 + 调用各域预留的 lifecycle 命令（`fact.transition`、`exp.record_signal`），**不再 import 任何 storage 模块、不再有一条裸 SQL**。fail-open 语义保留：总线缺席时命令透传。

### 2.4 一条写命令的完整生命周期（以"确认漏洞"为例）

```
模型/看板/脚本/审批钩子（全部同一条路）
  └→ CommandGateway.dispatch('vuln', 'confirm', {candidate_id, evidence_run_id, note}, ctx)
       ① manifest 解析：域存在、动词存在、actor 权限（model/dashboard/script/approval）
       ② schema 校验：evidence_run_id 必填（无证据不确认——不变量进 schema）
       ③ 前置不变量：候选存在且 status=new；evidence 包在 results/<run_id>/ 真实存在
       ④ 后端事务（BEGIN IMMEDIATE）：
            UPDATE findings SET status='confirmed', confidence='confirmed', noise=0 WHERE id=?
       ⑤ 发布事件 vuln.candidate.promoted {finding_id, from:{noise:1,status:'new'}}
       ⑥ audit.jsonl 落盘：{domain,cmd,actor,session_id,idempotency_key,before,after}
       ⑦ 返回 envelope {ok:true, data:{id, signal:true}}
  订阅者各自执行：
       · vuln 域内：候选池计数缓存失效
       · ledger 域：可订阅生成 attempts 行提示
       · eval 域：订阅回流 eval-live.jsonl（原 appendLiveEval 直调改事件）
       · FGS 域：订阅同步节点状态（原 updateFinding 里直调 fgsUpdateNode 改事件）
```

对照现状：今天这条链分散在 `updateFinding` 一个 200 行函数里（含 FGS 直调、eval 直写、note 拼接），且漏了最关键的 noise。重构后**漏不掉**——noise 归零在④的事务里，事件在⑤必然发布，看板徽章从查询来必然正确。

### 2.5 关键取舍（想清楚再动手）

| 决策 | 选择 | 理由与代价 |
|---|---|---|
| 单写者进程 vs 多进程开库 | **保留多进程 + SQLite WAL，写收敛在 CommandGateway（进程内）** | 引入"单写者守护进程 + RPC 转发"改动面太大（worker 派生链、断网兜底、DSH 升级耦合），收益主要是理论纯度。跨进程原子性继续由 SQLite 事务承担；**契约层**的单写者律（唯一入口）已足以消灭 1.2 的全部问题。Phase 5 可评估升级 |
| 域拆分粒度 | 14 域（§四） | 按"一张状态机 + 一个 owner"切。拒绝更细（fingerprints 单独成域没必要——它是 asset 域的读模型） |
| 工具改名 | **新命名 `vuln_confirm` 式域前缀 + 旧名兼容层一个观察期** | objective/persona/skill 文本里引用了旧工具名（p14-1-tool-refs.py 有先例可复用）；兼容层直接映射到同一 handler，prompt 逐批改写后再删 |
| 现有 asset-db.js 1865 行 | **按域搬迁不重写** | addFinding 闸门/exp_store 去重/taskClaimDue 事务……逻辑都是对的，搬进域 + 套壳，不推倒 |
| http-remote 后端时机 | Phase 4，先做 vuln 域试点 | 用户场景：外部漏洞管理系统。但先把契约做实，否则远程后端会把脏写法放大成网络脏写 |

---

## 三、统一契约约定

> 这是"经过仔细思考的完整成熟约定"，所有域、所有调用方（模型/看板/脚本/审批/治理引擎/人）一律遵守。**约定本身先评审定稿，再动代码。**

### 3.1 域 manifest（每个域一份，版本受控进 bundle 模板）

```yaml
domain: vuln
version: 1                      # 契约版本；破坏性变更 bump major
service: 'secDomain.vuln'       # cordis provide 名
description: 漏洞信号/候选/证据/提交（对应原 findings 全部语义）
owns:                           # ★ 单写者律：声明的资源只有本域能写
  tables: [findings]
  files:   [reports/submissions/]
commands:                       # 写动词 = 状态机入口（§3.2 规范）
  register_signal:    {actor: [model, script, webhook], idempotent: fingerprint}
  register_candidate: {actor: [webhook, script]}          # 机器直灌唯一入口
  confirm:            {actor: [model, dashboard], requires_evidence: true}
  reject:             {actor: [model, dashboard]}          # 参数 verdict: false_positive|dup|ignored
  submit:             {actor: [model, dashboard]}
  note:               {actor: [model, dashboard]}
queries:
  list / get / stats / candidates / by_asset / coverage
events:                         # 只列 payload 顶层数，订阅方不得依赖内部行结构
  candidate.registered / candidate.promoted / signal.confirmed /
  signal.rejected / signal.submitted
subscribes:                     # 本域订阅的他人事件（联动声明，替代跨域直调）
  exec.run.completed: [on_parser_ingest]   # parser 产物经命令回灌
  approval.approved:  [on_scope_grant]
invariants:                     # 前置校验清单，网关逐条执行
  - confirm/reject 的对象必须处于候选或信号态（终态不可再流转）
  - confirm 必须携带真实存在的 evidence run_id
  - 候选进入任一终态后必须退出候选计数（noise 与 status 联动是事务内原子动作）
backend: repository-v1           # 后端接口版本
```

### 3.2 命令（写动词）规范——八条铁律

1. **动词命名 `{域}_{对象?}_{动作}`**：状态机显式化。`finding_update status=confirmed` 这种"自由态跃迁"废止——改为 `vuln_confirm`；想流转必须调用与流转语义同名的动词。**调用方不再指定任意目标状态，状态机是模块私有的**（这正是 1.1 缺陷的根治点：现在 status 与 noise 是两个独立列，谁都能改一个漏一个）。
2. **一个命令一个事务**：BEGIN IMMEDIATE 内完成全部行变更（含联动列，如 confirm 同时改 status+confidence+noise）；跨域效果不进本事务，靠事件最终一致。
3. **幂等必填**：每个命令接受 `idempotency_key`（默认 fingerprint/dedupe_key/复合自然键）；网关保留最近 N 条 key→result，重放返回首次结果。spawn_worker 重启重试、webhook 重复投递天然免疫。
4. **证据即参数**：声称"确认/验证/落账"类动词，`evidence`（run_id/flow_id/路径）是 schema required——**无证据不结论从纪律升级为类型错误**。
5. **前置不变量在网关**：invariants 是 manifest 声明式清单，网关统一执行；域实现里不重复写（也不许绕——网关是唯一构造 service 实例的地方）。
6. **事件必发**：命令成功必然发布对应领域事件（失败不发）；事件同步分发（进程内），订阅者异常被网关捕获记 audit 不回滚命令主体（治理类联动允许掉、业务类联动见 §3.4 分级）。
7. **审计唯一落点**：所有命令在 CommandGateway 落一条统一 audit（domain/cmd/actor/session/idempotency_key/before/after/duration），域内不再各写各的。
8. **actor 标注**：每个调用方必须声明身份（model/dashboard/script/webhook/approval/human），网关按 manifest 的 actor 白名单拒绝越权（如 register_candidate 不允许 actor=model——模型只能登记完整信号，机器直灌语义保留给 webhook/parser）。

### 3.3 查询（读投影）规范

- 查询**纯读**：`exp_search` 的 uses+1、过期惰性归档这类副作用收编为显式命令（`know_exp_record_usage`），由工具投影层在检索后作为独立命令补发（审计可见，失败不污染检索结果）。
- 可见域谓词（noise/ archived/ memcore status/ 程序归属）是查询的**声明式参数**，与计数同口径——`countX 与 queryX 必须走同一 where 构造器`（v4.3 修过的病不允许再犯，网关层加一致性断言测试）。
- 查询结果带 `total/limit/offset` 信封；大结果走游标参数（对齐 artifact db 习惯）。

### 3.4 事件规范

- 命名 `{domain}.{对象}.{动作过去式}`；payload 只含 ID 与判据快照，**不含行全量**（防订阅方依赖内部结构）。
- 联动分级：
  - **强联动**（必须同 tick 完成）：候选消减、授权生效——订阅者同步执行，失败则命令整体报错回滚；
  - **弱联动**（允许延迟/丢失可容忍）：eval 回流、vault 导出、雷达追加——异步 best-effort + audit 留痕（沿用 v4.5 审批入队双通道的成熟判断）。
- 事件同时追加 `data/events/domain-*.jsonl`（回放/审计/未来跨进程的物理基础）。

### 3.5 后端适配器规范

- 每域 `backend/repository.js` 定义接口（方法名=命令/查询所需原语，不含 SQL 语义）；sqlite/http/file 三实现跑**同一套契约测试**（含幂等/事务回滚/并发写冲突用例）。
- **能力矩阵声明**：后端在 manifest 声明支持度（full/partial/unsupported），不支持的命令网关直接拒绝并提示替代路径。例：外部漏洞管理系统不支持候选池语义 → `http` 后端声明 `register_candidate: unsupported`，本地 sqlite 保留为候选 overlay，确认后经 `confirm` 同步远端（用户场景"换外部漏洞管理系统也能跑"的落地机制，见 §4.1）。

---

## 四、逐模块重构计划

> 每个模块统一五段式：**现状（实测）→ 目标契约 → 内部统一 → 后端 → 迁移步骤**。顺序按"收益×独立性"排列，vuln 域第一个（试点 + 修本次缺陷）。

### 4.1 vuln 域（试点域：findings + 候选池 + 证据 + 提交）

**现状**：`findings` 表 15+ 列；写入口 5 个（finding_add 工具 / findingUpdate RPC / parser 入库 / xray webhook / authz_diff 自动登记），闸门逻辑全在 `addFinding`/`updateFinding` 两个函数体内；候选=noise 视图无状态机；confirm 不消减候选（1.1 实证）；submission_draft/report_build 内嵌在 asset-db.js。

**目标契约**：

| 类 | 动词 | 说明 |
|---|---|---|
| 命令 | `vuln_register_signal` | 原 finding_add（五要素完整性闸门内聚为不变量；弱指纹命中候选 → 自动 promote 并返回 upgraded） |
| 命令 | `vuln_register_candidate` | 机器直灌唯一入口（actor=webhook/script/parser 专用；模型禁用） |
| 命令 | `vuln_confirm` | **候选→信号原子升级**：status+confidence+noise 三联动 + evidence 必填 + 发 candidate.promoted |
| 命令 | `vuln_reject` | verdict=false_positive/dup/ignored；联动 FGS deprecated（事件）+ 候选出池 |
| 命令 | `vuln_submit` | submitted_at/bounty/vendor_status |
| 命令 | `vuln_note` | 证据链追加（原 update 的 note 段） |
| 命令 | `vuln_draft_submission` | 原 submission_draft |
| 查询 | `vuln_list / vuln_get / vuln_candidates / vuln_stats / vuln_by_asset` | candidates 查询带 `status=new` 默认过滤——**候选池首次成为一等公民工作队列**（可加 `claimed_by/claimed_at` 列做认领语义，Phase 1 可选） |
| 事件 | candidate.registered / candidate.promoted / signal.confirmed / signal.rejected / signal.submitted | |
| 不变量 | 终态不可再流转；confirm 必带 evidence；**候选达终态必出池**；noise 与 status 联动在同一事务 | |

**内部统一**：fingerprint 生成（强/弱）、噪声闸门、完整性闸门、eval 回流（改订阅 signal.confirmed）、FGS 同步（改订阅）全部从函数体搬进 commands/。`updateFinding` 保留为兼容入口（内部按 status 映射到新动词，标 deprecated）。

**后端**：sqlite-local（迁现表）；http-remote（Phase 4 试点：外部漏洞管理系统 REST 对接，能力矩阵声明 + 本地候选 overlay）。

**迁移步骤**：① 契约定稿+契约测试 → ② 抽 commands/queries（逻辑从 asset-db.js 平移）→ ③ 工具/RPC 双投影 + 旧名兼容层 → ④ 数据修复（56 条僵尸 noise 行按 status 归位：confirmed 31 条 noise→0、终态非 new 的 25 条出候选池）→ ⑤ 观察 1 周 → ⑥ 删兼容层 + prompt 改写。

### 4.2 asset 域（assets + fingerprints + 分级）

**现状**：upsertAsset/queryAssets/assetOverview 等在 asset-db.js；**grade-assets.py 用 Python sqlite3 直写 UPDATE assets（绕过全部闸门）**；分级准入（level NULL 禁入主动队列）只是查询纪律不是写入纪律。

**目标契约**：

| 类 | 内容 |
|---|---|
| 命令 | `asset_upsert`（登记，含来源）、`asset_grade`（分级：score/level/accept/biz/state，**收编 grade-assets.py 为纯计算脚本 → 产出建议清单 → 本命令落库**）、`asset_state`（new/changed/stable/dead 流转，变化雷达事件触发）、`fp_record`（指纹登记） |
| 查询 | `asset_list / asset_get / asset_family / asset_overview / fp_query / asset_deep_queue`（深挖队列=level_in+accept+sort 的固化查询） |
| 事件 | asset.registered / asset.graded / asset.state.changed / fp.recorded |
| 不变量 | level 只能经 asset_grade 写入（upsert 不带 level——现 schema 已如此，升级为网关断言）；state 流转单向图校验 |

**内部统一**：grade-assets.py 拆成"纯计算（stdout JSON 建议）+ 落库命令"两段，run_cli manifest 的 `store` 改为产出建议文件；vision_triage 同样模式。准入纪律（level_in=S,A,B）作为 `exec` 域派单查询的调用点保留。

**后端**：sqlite-local；http-remote 预留（外部 CMDB/资产系统）。

### 4.3 endpoint 域（接口面 + 参数队列）

**现状**：endpoints 表 + upsertEndpoint/queryEndpoints；param-queue.txt/surface_queue 工具在 sec-pipeline；l2-collect.sh 直写 endpoints-{program}.tsv。

**目标契约**：命令 `endpoint_upsert`（l2-collect 产出 TSV 后经此批量入库，替代直写）、`endpoint_queue_surface`（原 surface_queue，参数队列成为本域owned 文件）、`endpoint_consume_queue`（dalfox/sqlmap 取料后标记消化——队列消费语义显式化）；查询 `endpoint_list / endpoint_hosts / endpoint_matrix`（越权矩阵：auth_required/roles_seen 聚合）；事件 endpoint.registered / queue.enqueued / queue.consumed。不变量：队列消费幂等（seen 集合在域内）。

### 4.4 task 域（tasks + task_runs + workers + 调度）

**现状**：调度链已较成熟（claim 事务/reap/守卫混在 taskUpdate）；scheduler.js 独立文件但与 asset-db 互调；流程守卫（done 前三产物校验）内嵌 taskUpdate。

**目标契约**：命令 `task_create / task_schedule / task_run_now / task_update_note`、`task_block / task_resume / task_cancel`（blocked 恢复从"看板手动改状态"变显式动词）、`task_finish`（调度器专用 actor=scheduler：收尾+latest-only 续期+守卫校验，**流程守卫从 taskUpdate 里拆出成为 finish 的前置不变量**）；查询 `task_list / task_next / task_stats / task_runs / worker_list / worker_status`；事件 task.created / task.claimed / task.finished / task.blocked。spawn_worker 归 **exec 域**（它是执行动作），worker 注册表归 task 域（它是任务执行史）——以 dedupe_key 幂等语义为界。

**内部统一**：scheduler 循环保留独立（文件锁单例），但其对 tasks 表的全部触达改走命令。预算列（budget_timeout_sec/provider/model 任务级覆盖）作为 task_create 参数收编。

### 4.5 fact 域（facts + fact_edges + blackboard 环境层 + 负知识）

**现状**：factUpsert/factSearch/factStats/factLink；blackboard 已收窄为环境层（v4.6）；FGS 沉淀钩子直写 facts；memcore transition 裸写。

**目标契约**：命令 `fact_upsert / fact_correct / fact_deprecate / fact_link`、`bb_set / bb_get`（blackboard 限定 env-issue/timeline/广播——快照前缀拒绝为不变量，替代 sweep 事后转写守卫）、`fact_record_validation`（复验刷新，memcore 的合法写通道）；查询 `fact_search / fact_graph / fact_overview / neg_check`；事件 fact.upserted / fact.deprecated / fact.expired（惰性过期改显式命令）。**memcore 治理全部经 transition/record_signal 语义的域命令执行，69 处裸 SQL 归零。**

**内部统一**：可见域谓词（archived/过期/cooling）与计数同口径进查询构造器；FGS 沉淀改为订阅 `task.finished` 事件后调用 fact_upsert（原 persistFgsFacts 直写）。

### 4.6 know 域（exp_cards + kb_docs + rules + vulncards + 收割）

**现状**：experience.js 908 行承载经验卡/知识库/FTS/向量/curated 索引/playbook 兼容入口；rules 只读两件套在 dashboard-rpc；vulncards 是 data/vulncards/ 文件，card_usage_log 在 sec-pipeline；kb-harvest.py 产草稿骨架。

**目标契约**（知识六类型归一为**一个域、六个子仓**——v4.6 的类型学保留，物理 owner 统一）：

| 子仓 | 命令 | 查询 |
|---|---|---|
| 经验 exp | `exp_store / exp_feedback / exp_promote / exp_deprecate / exp_update / exp_record_usage`（搜索副作用显式化）/ `pb_save / pb_outcome`（playbook 兼容动词收编为 kind=playbook 分支） | `exp_search / exp_rank` |
| 文献 kb | `kb_import / kb_revalidate` | `kb_search / kb_list / kb_read` |
| 先验 rules | `rule_seed`（seed-skills.sh 通道的域化封装；agent 仍只读——**规则先验层写入权 actor=human/script**） | `rule_list / rule_read` |
| 规程 vulncards | `vc_save`（升版动词：deviation→draft→active 状态机内聚）/ `vc_log_usage`（原 card_usage_log） | `vc_get / vc_list / vc_coverage`（覆盖矩阵聚合） |
| 收割 harvest | `harvest_ingest`（kb-harvest 产出的草稿入 inbox）/ `know_adopt`（**人工蒸馏后入库，与 knowledge-adopt 审批联动**——审批批准事件触发） | `harvest_status` |
| 体检 health | — | `know_health`（原 knowledgeHealth） |

事件：exp.stored / exp.cooled / kb.imported / vc.versioned / know.adopted。不变量：evidence 空/justification<10 字/R8 泛化/R9 膨胀（全部从函数体升级为网关不变量清单）；防循环铁律（source_system 标记）。

**后端**：sqlite-local（exp/kb）+ file（rules/vulncards——保持 YAML/MD 文件形态，vault 同步链路不动）。

### 4.7 scope 域（scope.yml + programs + 排除 + 白名单）

**现状**：scope.yml 三个写入方（serializeScope / spool sync / 人工）；programs 表镜像；审批 onApprove 跨域直写。

**目标契约**：命令 `scope_grant / scope_revoke / scope_exclude / scope_set_rules`（rate_limit_qps/allow_intrusive_tools/max_risk 统一动词）、`program_bind_workspace / program_archive`；**serializeScope 原子写（tmp+rename+bak+audit）收编为域内实现细节**；查询 `scope_list / program_list / scope_check`（checkTarget 的只读预检版，供 UI/agent 自查）。事件 scope.granted / scope.revoked / rules.changed（**QPS 令牌桶订阅 rules.changed 即时生效——现 mtime 轮询改事件**）。不变量：任何写必须经命令；sync/人工路径标注 actor=human 且写后自动跑一致性校验（hosts 镜像 vs yml）。审批批准→订阅 approval.approved→调 scope_grant（替代 onApprove 直调）。

### 4.8 approval 域（approval_requests + kind 注册表）

**现状**：APPROVAL_KINDS 已是注册表雏形，但 onApprove 内嵌跨域直写（scope/task/radar/fact 四处）。

**目标契约**：命令 `approval_request`（提请，validate 内聚）、`approval_decide`（批准/驳回——**副作用 = 只发 `approval.approved {kind, payload}` 事件**，各域订阅执行，强联动失败则 decide 报错回滚）；kind 注册表保留并迁移为声明式（每个 kind 的 payload schema + 事件映射）；查询 `approval_list / approval_stats`。异步审批协议（tool-intrusive/task-budget-extend 的"同步拒绝+落库+下周期放行"）原样保留，仅落点改经命令。

### 4.9 exec 域（run_cli + tools.d + spawn_worker + 沙箱 + QPS + 代理注入 + parser）

**现状**：这域其实最接近目标形态（manifest 化/守卫链/审计/落盘齐全）；缺口是 parser 入库直写领域表、QPS 用 mtime 轮询、工具名与域无关联。

**目标契约**：命令 `exec_run_cli`（守卫链 S1-S5 全内聚为不变量清单）、`exec_spawn_worker`、`exec_report_bad_proxy`（跨域示例：经 proxy 域命令）；查询 `exec_grep_result / exec_page_result / plan_chain / task_chain`（能力图 BFS 是跨域读——依赖 task 域查询）；事件 `exec.run.completed {run_id, tool, parse_proposal}`——**parser 不再直写 assets/endpoints/findings，改为产出结构化 proposal，由 asset/endpoint/vuln 域订阅后各自经命令入库**（机器直灌与人工登记在各自域内分流，闸门不混用）。tools.d manifest 不动（已是插件形态），新增 `domain` 字段标注产物去向。

### 4.10 ledger 域（attempts 台账 + card_usage + coverage + radar 队列）

**现状**：sec-pipeline 8 工具直写文件（attempts-{program}.tsv / card_usage-{date}.jsonl / param-queue / radar-queue.jsonl）；pipeline_validate 是事后校验。

**目标契约**：命令 `ledger_log_attempt`（六态枚举+reason/evidence 必填校验内聚——**校验从事后脚本提前到写入时**）、`ledger_log_card_usage`、`ledger_radar_push / ledger_radar_drain`（雷达队列读写收域，ct-watch 脚本改调命令或写 inbox 文件由域收割）、`coverage_report` 归 know 域 vc_coverage 或本域查询（按"聚合只读"归查询）；不变量：六态枚举/N-A 与 BLOCKED 必填 reason 且禁 other/misc/evidence_path 存在性（网关级）。后端：file（TSV/JSONL 形态保留——vault/回放链路依赖）+ 可选 sqlite 索引视图。

### 4.11 report 域（报告 + 提交稿）

**现状**：buildReport 在 asset-db.js（1598-1663），报告列表从文件名解析元数据。

**目标契约**：命令 `report_build`（筛选参数全量 schema 化）；查询 `report_list / report_read`；事件 report.built。文件名/目录约定保留（vault 链路），但元数据（program/date/severity）改从 report 索引（frontmatter 或 sqlite）读取，不再从文件名倒推。

### 4.12 proxy 域（proxy-pool）

**现状**：已是独立插件 + 6 工具，形态最接近目标；采集链（timer→脚本→pool.json）绕过域。

**目标契约**：命令 `proxy_refresh / proxy_report_bad / proxy_sticky_bind`；查询 `proxy_stats / proxy_list / proxy_gateway`；事件 proxy.pool.refreshed（mubeng 热加载订阅）；不变量：blocklist 与 live 一致性。采集脚本产出建议文件 → `proxy_refresh` 命令落池（与 asset 分级同模式）。

### 4.13 fgs 域（任务内决策图）

**现状**：fgs_nodes + 5 工具；任务启动清图/done 沉淀钩子直写 facts。

**目标契约**：命令 `fgs_add / fgs_update`（状态机 open→running→done/failed/blocked/deprecated 内聚）；查询 `fgs_list / fgs_next / fgs_export`；事件 `fgs.node.done`（fact 沉淀由 fact 域订阅本事件 + task.finished 实现，persistFgsFacts 直写归零）；不变量：节点归属 task_id 与当前任务一致（跨任务写拒绝）。

### 4.14 audit / eval / 边角归位

- **audit**：不是独立域——是总线职责（§3.2 第 7 条），audit.jsonl owner=CommandGateway；查询面 `audit_tail` 从 dashboard-rpc 收编为总线查询。
- **eval**（eval-fp.js / eval-live.jsonl / eval_stats）：订阅 signal.confirmed/rejected 与 vuln_reject 事件回流，独立小插件或 vuln 域查询（建议独立，防域膨胀）。
- **credentials**（cred_add/cred_query）：并回 **scope 域**（凭据=授权语义的一部分：凭据可用范围必须与 scope 一致，同域才能校验这条不变量）。

### 4.15 迁移映射总表（旧入口 → 新契约）

| 旧入口（实测位置） | 新入口 | 兼容期 |
|---|---|---|
| finding_add / findingUpdate / parser 直写 / webhook / authz_diff | vuln_register_signal / vuln_register_candidate（+ exec 事件 proposal） | 旧名别名 1 观察期 |
| updateFinding(status=xxx) | vuln_confirm / vuln_reject / vuln_submit / vuln_note 按语义分派 | 同上 |
| grade-assets.py 直写 | 脚本纯计算 + asset_grade 命令 | 立即（无 prompt 依赖） |
| memcore 69 处裸 SQL | fact/exp/kb 域 lifecycle 命令 | memcore 内部映射层 |
| APPROVAL_KINDS.onApprove 直写 | approval.approved 事件 + 各域订阅 | kind 逐个迁 |
| sec-pipeline 8 工具直写文件 | ledger 域命令（写入即校验） | 工具名保留（本就是域前缀风格） |
| persistFgsFacts / appendFgsToHandoff 直写 | fgs.node.done 事件订阅 | 随 fact 域 |
| serializeScope 外部直调 | scope_grant/revoke（serializeScope 内化为域实现） | 审批链先迁，看板后迁 |
| dashboard-rpc 52 case 手写分发 | RpcProjector 自动投影 + 少量纯 UI 聚合 case | case 逐批切 |

---

## 五、LLM 统一接口层

> 目标（需求 #5）：模型使用系统时**只看得见统一契约动词，物理上进不去内部改数据**。参照 DSH（工具=插件投影）+ pi agent（capability surface）理念。

### 5.1 工具面 = 契约的自动投影（ToolProjector）

- ToolProjector 读域 manifest，为每个 command/query 自动 `ctx.tools.register`：name=动词名、schema=命令 schema、description=动词 RoE 摘要（manifest 里的 `agent_note` 字段，写给模型看的用法纪律，如 vuln_confirm 的"确认前必须完成对抗性自检+双出口复现"）。
- **消灭两套漂移**：今天工具 schema（asset-graph.js 手写 zod）与后端函数签名（asset-db.js）是两份要人工同步的东西（v4.6.1 的 report_build 参数传不进去就是这个病的轻症）；投影后 schema 单一来源。
- 工具按域分组的命名空间（`vuln_* / asset_* / task_* / fact_* / know_* / ledger_* / exec_*`），模型在 60+ 工具里按前缀定位——persona/technique-index 里的工具引用同步改写。

### 5.2 模型禁入区（负向保障，物理层）

1. **actor 白名单**：register_candidate 等机器通道动词对 actor=model 拒绝；模型只能登记完整信号或显式确认候选——"机器直灌不冒充漏洞"从闸门 if 升级为接口不存在。
2. **run_cli 沙箱已有**（bwrap 只读挂载 + 平台密钥不可见）：v5 补一条——**data/ 下所有域 owned 文件对沙箱本来就不可写**，域化后这条成为声明式保证（manifest owns + sandbox 白名单交叉校验，setup.sh 冒烟断言）。
3. **状态机私有**：模型无 `update X SET status=` 类自由动词（5.2.1 的必然结果）——想流转必须走语义动词，不变量在服务端。
4. **脚本类工具输出 proposal 不落库**：grade_assets/vision_triage/l2_collect 类 manifest 的 `store` 字段废止直写语义，产出建议文件；落库只有域命令一条路。
5. **worker 面挂载收敛**：headless profile 挂全部域（worker 要干活），但 memcore 治理、approval decide、scope grant 等 actor 白名单不含 model 的动词，工具投影层**根本不向 worker 注册**（挂载矩阵：profile × actor 白名单 → 实际工具集）。

### 5.3 模型侧引导（正向，提示词层）

- AGENTS.md 受管区块 + sec-runtime-discipline 增加"域动词速查表"（自动从 manifest 生成，与工具面同步——不再手维护工具清单文档）。
- 调度 prompt 注入改为"本 phase 可用动词 + RoE 摘要"（persona 与 contract 双保险，契约是硬的、提示词是软的——延续"提示词负责智慧，代码负责纪律"公理）。
- candidate 队列成为一等查询后，vuln 任务 objective 的"消化覆盖矩阵格子"可加"消化候选池 top-N"——工作队列与任务 Slice 对齐。

---

## 六、看板/GUI 改造

1. **RpcProjector**：dashboard-rpc.js 的 52+ case 大部分（读写直达 assetDb 的）改为自动投影——`{domain}.{verb}` RPC 名与工具名同源，`findingUpdate` case 消失，变成 `vuln.confirm/reject/submit`。
2. **保留的少量手写 case**：纯 UI 聚合（stats 大盘、知识全景图、ops 红条、knowledgeCoverage 缓存卡）——它们是跨域只读聚合，允许存在但只准调查询。
3. **写操作审计增强**：看板每次 decide/update 都带 actor=dashboard + 操作者标识（auth-gate 用户），与模型操作在 audit 里可区分。
4. **client.js（2628 行）拆分**：按域视图拆十视图为独立组件文件（vuln-view.js/asset-view.js/...），与域插件同目录部署——UI 也"一切皆插件"（sec-dashboard 变成 dashboard 壳 + 各域 view 插件资源）。
5. **候选池 UI**：候选 tab 升级为工作队列视图（认领/确认/驳回快捷操作，全部走 vuln 域动词）。

---

## 七、迁移路线图

> 原则：**每阶段独立可回滚；热修不等重构；重构期间每日链路（03:00/04:00 任务）不允许中断超过一个周期**。

### Phase 0 —— 热修（立即，0.5 天，不等 v5）

1. `updateFinding`：status 进入 confirmed/submitted 时同事务 `noise=0`；进入 false_positive/dup/ignored 时同事务保持候选出池语义（`noise` 维持但 candidates 查询/KPI 改按 `status='new'` 口径）。
2. 数据修复：31 条 confirmed+noise=1 → noise=0（进信号面）；KPI `findings_noise` 改为 `COUNT(*) WHERE noise=1 AND status='new'`。
3. 单测：确认→候选计数-1、信号计数+1；重复确认幂等。
> 这是止血不是根治（actor 仍混杂、updateFinding 仍是自由态动词），根治在 Phase 1。

### Phase 1 —— 总线 + vuln 试点域（~1 周）

1. `@silksec/sec-domain-bus` 插件：DomainRegistry / CommandGateway / QueryGateway / EventBus / ToolProjector / RpcProjector + 统一 audit + idempotency 表。
2. vuln 域抽取（§4.1 全量）+ 契约测试（幂等/事务/不变量/双后端）+ sqlite 后端。
3. 旧工具名兼容层（finding_add→vuln_register_signal 等 8 个别名）+ dashboard findingUpdate case 切新投影。
4. 数据修复脚本（Phase 0 的正式版，幂等可重跑）。
5. 验收：模拟 xray webhook 重放 / 人工确认 / parser 入库三路写同一候选，候选池计数三处一致；audit 三条记录 actor 可区分。

### Phase 2 —— 数据域逐个搬迁（asset → endpoint → fact → know，每域 2-4 天）

每域节奏：契约定稿 → commands/queries 平移 → 双投影 + 别名 → 契约测试 → 切流 → 删旧路径。**每域一次独立提交+部署+观察**，域间无依赖可并行。期间 grade-assets.py / memcore 裸 SQL / sec-pipeline 直写按 §4.15 映射表同步归位（谁所属域上线谁改造）。

### Phase 3 —— 跨域事件化（approval onApprove / parser proposal / FGS 沉淀 / QPS 事件）

强/弱联动分级落地（§3.4）；approval 六 kind 的 onApprove 逐个改事件订阅；`exec.run.completed` proposal 管道上线（parser 直写归零的里程碑）。

### Phase 4 —— http-remote 后端试点（vuln 域对接外部漏洞管理系统）

repository-http.js + 能力矩阵 + 本地候选 overlay + 同步策略（确认后推送远端、远端 ID 回写映射表）。**验收即用户场景本身**：把 vuln 后端切到外部系统，asset/task/know/ledger 全链路无感知继续工作。

### Phase 5 —— LLM 面收敛 + 守卫加固 + 评测

1. prompt 体系全量改写（persona/objective/technique-index 的工具引用 → 新动词表，复用 p14-1-tool-refs.py 模式）；删兼容别名。
2. worker 挂载矩阵（actor 白名单 × profile）实施；setup.sh 冒烟断言 owns×sandbox 交叉校验。
3. 评测：eval-fp.js 扩"契约合规"用例（模型试图自由态流转/无证据确认/机器通道直灌 → 必须被网关拒绝且错误信息可引导）。
4. 评估"单写者守护进程"是否值得做（§2.5 取表的复核点）。

---

## 八、风险与回滚

| 风险 | 缓解 |
|---|---|
| 重构期间每日链路中断 | 兼容别名贯穿 Phase 1-4；每域独立提交可单独 revert；调度任务 objective 里工具引用在别名期内新旧皆可 |
| 契约设计错误返工 | §3 约定先评审定稿；vuln 试点域先行验证契约表达力，再铺开 |
| memcore 改造引入治理断档 | memcore 映射层 fail-open 保留（治理缺席业务照跑——既有公理）；memcore_events 审计对照改造前后一致 |
| 双投影工具描述劣化影响模型行为 | 工具描述=manifest agent_note 单一来源；eval-fp 契约合规用例 + 首周人工抽查 worker.log 工具调用 |
| 数据修复误伤 | 修复脚本 dry-run 模式 + 备份（silksec-backup VACUUM INTO 快照先行）+ 幂等可重跑 |
| http-remote 后端可用性 | 能力矩阵 fail-closed（不支持的能力明确报错，不静默降级）；本地 sqlite 后端保底可切回（bundle 配置一行） |
| 工程量失控 | 14 域不是一次做完：Phase 2 按域滚动，每域 2-4 天；总线的抽象只在 vuln 试点上验证过才允许铺开（避免过度设计） |

---

## 附：与现状文档的关系

- 本文定稿后：README §三 挂 T-18（Phase 0 热修，P0）与 T-19（v5 分阶段推进）；system-complete.md 在 Phase 1 落地时升 v2.0 补"领域总线"章。
- 本文的实测取证数据（1.1/1.2）随 Phase 0 修复失效后，保留为缺陷档案（不删——它是"为什么要有域边界"的案例教训，可入 rules/cases 风格的内部判例）。
