# 16 · 看板设计（sec-dashboard 壳插件 + 域视图插件化 + RPC 投影消费）

> 版本：v5.0 ｜ 状态：定稿 ｜ 契约版本：1
> 依赖：**订阅**：无（30s 轮询模型不变——事件推送是开放问题 §四）；**被订阅**：无；**消费**：全部 14 域的查询与命令，经 RpcProjector 的 `{domain}.{verb}` 端点 + 壳自有 5 个聚合端点。
> 上位文档：[`00-conventions.md`](00-conventions.md)（冲突以它为准）；消费的域契约见 02-15 各文档。
> v4 取证基线：client.js 2628 行（十视图 + 30s 轮询 + 侧边栏 Modal）；dashboard-rpc.js 625 行（**实测清点 53 个 case**——v4 文档口径"52 case"，差 1 为 evalStats 漏记）。

---

## 一、对外暴露（External Surface）

### 1.1 服务标识与挂载

**核心架构转变：UI 也"一切皆插件"**——v4 的 sec-dashboard 是一个 2628 行的单体客户端；v5 拆成**看板壳插件**（平台能力）+ **各域视图插件资源**（业务视图，与域插件同包部署）。

| 件 | 包名 | 形态 | 职责 |
|---|---|---|---|
| 看板壳 | `@silksec/sec-dashboard` | 双面插件（宿主半面 no-op loader entry + client 半面）| 侧边栏入口（`sidebar.footer.action` root scope）、全局 Modal 容器、**视图注册表（view registry）**、tab 骨架、30s 轮询引擎（useRpc/usePagedQuery hooks）、统一 dispatch 封装、顶部 KPI/横幅/红条、DocModal/Toolbar/EmptyState 等共享组件、theme token 消费 |
| 域视图 | 各域插件包内的 `dashboard-view.js` client 资源（`@silksec/sec-domain-vuln` 等）| 域插件的双面扩展（宿主半面原有 + client 资源新增）| 单个视图的渲染、筛选器、行内跳链、写操作按钮（全部调域动词 RPC）|

**挂载矩阵**：

| profile | 壳 | 域视图资源 |
|---|---|---|
| web | `@silksec/sec-dashboard` | 随已装载的域插件自动进入（package.json `exports["./dashboard-view"]`）|
| headless | 不装 | 不装（worker 无 UI；域插件宿主半面照常工作）|

**视图注册表协议**（壳 provide `secDashboardViews` client 服务，域视图 apply 时注册）：

```js
// @silksec/sec-domain-vuln/dashboard-view.js（client 半面）
export default {
  name: 'sec-domain-vuln-view',
  inject: ['secDashboardViews', 'connection'],
  apply(ctx) {
    ctx.get('secDashboardViews').register({
      id: 'vuln',            // = 域名（tab id，跨视图跳链引用）
      label: '漏洞',          // tab 文案
      order: 20,             // 十视图顺序：vuln20 asset30 endpoint40 fact50 task60 know70 report80 approval90 authz100 audit110
      badge: null,           // 可选函数→数字/文本（如审批待办）；vuln 视图可挂候选池计数
      component: VulnView,   // React 组件（props: { rpc, workspaces, navigate }）
      requires: ['secDomain.vuln'],   // 域缺席时 tab 隐藏（能力降级，不报错）
    })
  },
}
```

壳渲染顺序 = registry 按 order 排序；注册晚于首渲染的视图经 React state 触发重渲染（cordis client 插件加载顺序不保证，registry 必须是动态的）。`requires` 声明的 cordis 服务不存在（域未挂载）→ tab 静默隐藏——**域缺席降级而非看板崩溃**。

**RPC 通道**：沿用宿主 `connection.rpc`（loopback authority），端点名从 v4 裸 case 名（`'stats'`）改为 **`{domain}.{verb}` 点分全名**（`'vuln.list'`）——与 RpcProjector 命名同源（宪法 §二）。壳自有聚合端点用 `dashboard.*` 前缀。观察期内旧裸名由兼容层映射（§3.2）。

**theme-silksong 关系（不变）**：全局深色主题继续走 DSH theme registry（tokens 注册 + localStorage 持久化 + 首装默认启用），与本架构正交。约束升级为**视图插件纪律**：域视图一律消费 theme tokens（T.brand/T.label/T.warn…），**不得自带颜色字面量**；severity 五色经 theme/change 事件注入 style 的 v4 机制保留（registry 白名单外，壳统一管理，视图只消费）。

### 1.2 命令（写动词）总表

**壳零自有写命令**——看板不是域，一切写操作经域动词的 RPC 投影（`{domain}.{verb}`）。壳消费的命令全景（= 十视图全部写操作点）：

| 域动词（RPC 名）| 消费视图 | 对应 v4 case |
|---|---|---|
| `vuln.confirm` / `vuln.reject` / `vuln.submit` / `vuln.note` / `vuln.claim`* | 漏洞（候选工作队列）| findingUpdate（按 status 拆分）|
| `fact.correct` / `fact.deprecate` | 事实 | factCorrect / factDeprecate |
| `task.create` / `task.run_now` / `task.cancel` / `task.block` / `task.resume` / `task.schedule` | 任务 | taskCreate / taskRunNow / taskCancel / taskSetStatus（拆分）/ taskScheduleUpdate |
| `know.exp_feedback` / `know.exp_promote` / `know.exp_deprecate` / `know.exp_update` / `know.exp.approve_export` / `know.exp.revoke_export`* | 知识 | expFeedback / expPromote / expDeprecate / expUpdate / expExportable |
| `report.build` | 漏洞（生成报告按钮）/ 报告 | reportBuild |
| `approval.decide` | 审批 | approvalDecide |
| `scope.grant` / `scope.rules.apply` / `scope.revoke` / `program.bind_workspace` | 授权 | scopeSaveProgram（拆分）/ scopeDeleteProgram / programBindWorkspace |

\* `vuln.claim`（候选认领）与 `know.exp.approve_export` / `know.exp.revoke_export`（导出许可翻转）为对应域文档（02/07）的动词定稿职责，本文档只声明消费意图；动词不存在时该按钮不渲染（requires 语义同 tab 级降级）。

**v4 `findingUpdate` 的 `status='new'` 回退操作在 v5 删除**——状态机私有无回退动词（v5 候选误判的纠正路径是 `vuln_reject` 后重新登记，不是打回 new；见 §四 开放问题 3）。

### 1.3 命令逐个详述（壳侧：dispatch 封装与 operator 注入）

壳侧唯一的"命令实现"是**统一 dispatch 封装**（各域动词的 schema/错误/幂等/actor/RoE 详述见对应域文档，此处只定义壳的调用纪律）：

```js
// 壳 shared/rpc.js —— 全部视图唯一写入口
function dispatch(verb, args) {           // verb = 'vuln.confirm'
  return connection.rpc.call(verb, args)  // 点分全名 = RpcProjector 端点
    .then(envelope => {
      if (envelope && envelope.ok === false) throw new RpcError(envelope.error)  // 统一错误信封解析
      return envelope
    })
}
```

**调用纪律（视图组件必须遵守，代码评审断言）**：

1. 写操作一律包 `withBusy(fn)`（v4 模式保留：busy 锁 + 失败 alert + finally 统一 reload 受影响查询）；
2. 错误展示消费信封的 `error.code/message/hint` 三元组——**hint 必须展示给操作者**（v4 approval_hint 模式的 UI 延续）；
3. `replay: true` 的返回按成功渲染 + toast"幂等重放"提示；
4. **operator 身份不在 payload 里传**——auth-gate 用户身份由 RpcProjector 从 RPC 连接上下文注入（`actor={type:'dashboard', operator: <auth-gate user>}`），调用方声明的 operator 字段一律忽略（宪法 §三.1 不可伪造原则）；audit 的 `operator` 字段由此而来，与 model 的 session_id 在审计里天然可区分。

### 1.4 查询（读投影）逐个详述（壳自有聚合端点）

壳保留 **5 个手写聚合端点**（`dashboard.*`，注册于总线 RPC 面），**只准调各域查询、禁止直查表**：

| 端点 | 数据接口（聚合来源查询）| 消费位置 |
|---|---|---|
| `dashboard.stats` | 并行调 `vuln.stats`、`asset.overview`（总览聚合）、`endpoint.list(limit=1)`（取 total）、`task.stats`、`fact.overview`、`scope.program_list`，合并为 KPI 大盘（findings/assets/endpoints/tasks/facts/工作区计数 + by_severity/by_status）| 顶部 StatsHeader（tab 跳链入口）|
| `dashboard.ops` | 调 `ledger.discipline_stats`（纪律五指标：台账日增量/卡使用 7d/交接包 7d/IdeaCard/调度漂移——11-ledger §1.4.4）、`know.health`（知识体检，07-know §1.4 Q14）、`task.stats` + `task.scheduled`（调度漂移 + task_runs 新鲜度）、`vuln.stats`（候选计数——**v5 口径修正：`noise=1 AND status='new'`，见宪法 §十一**）、`asset.overview`（ungraded 计数）→ 五指标 + alerts + healthy | 红条横幅 + ops 卡片 |
| `dashboard.memcore` | memcore 插件状态查询（治理旁路观测：loaded/策略摘要）| memcore 缺席横幅（fail-open 提示）|
| `dashboard.sessions` | DSH 平台会话清单（按 workspace 过滤）| 任务视图会话跳链（`ctx.sessions.open`）|
| `dashboard.workspaces` | DSH 平台工作区清单 + 幂等配对（pairWorkspaces 逻辑收编）| 工作区区块 + 各视图 program 筛选器选项 |

聚合端点的**不变量**：任一来源域查询失败 → 该指标返回 `null` + `degraded: [域名]`，**不整体失败**（跨域聚合的可用性纪律）；`dashboard.ops.alerts` 为空 ⇔ `healthy: true`。

其余全部读操作走各域查询的自动投影（`vuln.list`、`asset.list`…53 case 去向见 §1.7）。

### 1.5 事件

**壳不发布任何事件**（无 `dashboard.*` 域事件）。数据新鲜度靠 **30s 轮询**（POLL_MS=30000，v4 模式保留）：仅活跃 tab 的查询挂 timer，非活跃视图不取数（useRpc/usePagedQuery 的 active 参数纪律）。事件推送（SSE/轮询混合）是开放问题 §四.1。

### 1.6 模型工具面投影

**零工具注册**——看板是纯人机面。`dashboard.*` 聚合端点**不向模型注册**（模型直接用各域查询，如 `vuln_stats`/`task_stats`，无需壳的 UI 合并层）。这由 RpcProjector 的投影白名单实现：壳端点标记 `surface: dashboard-only`。

### 1.7 看板 RPC 投影（v4 53 case 逐个去向 + 十视图清单）

**v4 dashboard-rpc.js 53 个 case 的完整去向表**（自动投影 = RpcProjector 从域 manifest 生成，case 代码删除）：

| # | v4 case | 读/写 | v5 去向（RPC 名）| 类型 |
|---|---|---|---|---|
| 1 | stats | 读 | `dashboard.stats` | 保留聚合（壳，§1.4）|
| 2 | ops | 读 | `dashboard.ops` | 保留聚合（壳）|
| 3 | workspaces | 读 | `dashboard.workspaces` | 平台面（壳）|
| 4 | programBindWorkspace | 写 | `program.bind_workspace` | 自动投影（域命令）|
| 5 | scopeList | 读 | `scope.list` | 自动投影（域查询）|
| 6 | scopeSaveProgram | 写 | 拆分：`scope.grant` + `scope.rules.apply`（按表单字段分派，08-scope.md 契约）| 拆分映射 |
| 7 | scopeDeleteProgram | 写 | `scope.revoke` | 自动投影 |
| 8 | approvalList | 读 | `approval.list` | 自动投影 |
| 9 | approvalDecide | 写 | `approval.decide` | 自动投影 |
| 10 | taskRunNow | 写 | `task.run_now` | 自动投影 |
| 11 | taskCancel | 写 | `task.cancel` | 自动投影 |
| 12 | reportBuild | 写 | `report.build`（content 读回移入壳 dispatch 封装）| 自动投影 |
| 13 | evalStats | 读 | `eval.stats` | 自动投影（eval 域查询）|
| 14 | audit | 读 | `bus.audit_tail`（总线查询，从 dashboard-rpc 收编——归档稿 §4.14 既定）| 自动投影（总线）|
| 15 | assets | 读 | `asset.list` | 自动投影 |
| 16 | assetOverview | 读 | `asset.overview` | 自动投影 |
| 17 | assetDetail | 读 | `asset.get` | 自动投影 |
| 18 | assetFamily | 读 | `asset.family` | 自动投影 |
| 19 | endpointHosts | 读 | `endpoint.hosts` | 自动投影 |
| 20 | factStats | 读 | `fact.stats`（facet 统计；06-fact.md 定稿名）| 自动投影 |
| 21 | endpoints | 读 | `endpoint.list` | 自动投影 |
| 22 | findings | 读 | `vuln.list` | 自动投影 |
| 23 | findingGet | 读 | `vuln.get` | 自动投影 |
| 24 | blackboard | 读 | `fact.bb.read` | 自动投影 |
| 25 | facts | 读 | `fact.search` | 自动投影 |
| 26 | factGraph | 读 | `fact.graph` | 自动投影 |
| 27 | programs | 读 | `scope.program_list` | 自动投影 |
| 28 | tasks | 读 | `task.list` | 自动投影 |
| 29 | scheduledTasks | 读 | `task.scheduled` | 自动投影 |
| 30 | taskRuns | 读 | `task.runs` | 自动投影 |
| 31 | taskScheduleUpdate | 写 | `task.schedule` | 自动投影 |
| 32 | taskSetStatus | 写 | 拆分：`task.block`（blocked）/ `task.resume`（queued）| 拆分映射 |
| 33 | taskCreate | 写 | `task.create` | 自动投影 |
| 34 | sessions | 读 | `dashboard.sessions` | 平台面（壳）|
| 35 | findingUpdate | 写 | 拆分：status=confirmed→`vuln.confirm`；false_positive/dup/ignored→`vuln.reject`；submitted→`vuln.submit`；note→`vuln.note`；accepted→`vuln.submit`（vendor_status=accepted + bounty）；**new 回退删除**（§1.2）| 拆分映射 |
| 36 | factCorrect | 写 | `fact.correct` | 自动投影 |
| 37 | factDeprecate | 写 | `fact.deprecate` | 自动投影 |
| 38 | memcore | 读 | `dashboard.memcore` | 保留聚合（壳，治理旁路观测）|
| 39 | expCards | 读 | `know.exp_list` | 自动投影 |
| 40 | expFeedback | 写 | `know.exp_feedback` | 自动投影 |
| 41 | expPromote | 写 | `know.exp_promote` | 自动投影 |
| 42 | expDeprecate | 写 | `know.exp_deprecate` | 自动投影 |
| 43 | expUpdate | 写 | `know.exp_update` | 自动投影 |
| 44 | expExportable | 写 | 拆分：`know.exp.approve_export` / `know.exp.revoke_export`（07-know.md 定稿名；exportable 0↔1 翻转，reason 必填）| 拆分映射 |
| 45 | playbooks | 读 | `know.exp_list {kind:'playbook'}`（旧字段形态兼容由视图层适配）| 自动投影（参数化收编）|
| 46 | kbList | 读 | `know.kb_list` | 自动投影 |
| 47 | kbRead | 读 | `know.kb_read` | 自动投影 |
| 48 | factOverview | 读 | `fact.overview` | 自动投影 |
| 49 | rulesList | 读 | `know.rule_list` | 自动投影 |
| 50 | rulesRead | 读 | `know.rule_read` | 自动投影 |
| 51 | knowledgeCoverage | 读 | `know.coverage`（缓存卡逻辑收进 know 域查询：7 天新鲜直读 data/knowledge-coverage.json，过期现场跑脚本重算——**生成是纯计算脚本产缓存文件 + 域查询读**，无写动词）| 域查询（含缓存）|
| 52 | reports | 读 | `report.list`（**文件名解析逻辑废弃**，索引直出——12-report.md §1.7）| 自动投影 |
| 53 | reportRead | 读 | `report.read` | 自动投影 |

**去向统计**：自动投影 41（含总线 1）+ 拆分映射 4 + 保留聚合/平台面 5（stats/ops/memcore/sessions/workspaces）+ 域查询收编 3（knowledgeCoverage 归 know、reports/reportRead 归 report 已计入自动投影口径的差异见注）。保留手写聚合的判定标准（宪法 §六.看板改造 2 条的落地）：**跨域只读聚合且无对应域查询可直投**才允许保留，且只准调查询。

**十视图 → v5 视图清单**（每视图：数据查询来源 / 写操作点 / v5 增强点）：

| 视图（tab）| 域视图插件 | 数据查询来源 | 写操作点 | v5 增强点 |
|---|---|---|---|---|
| 漏洞 | `sec-domain-vuln/dashboard-view.js` | `vuln.list`（分页/筛选）、`vuln.stats`、`eval.stats`（假阳性率，跨域读）| `vuln.confirm/reject/submit/note/claim` | **候选池升级为工作队列视图**：`noise=1 AND status='new'` 口径独立成区（v4 是 chip 筛选）；行内快捷操作——认领（vuln.claim，显示 claimed_by/operator 与时间）、确认（弹证据要求提示——vuln_confirm 的 evidence required 错误 hint 引导）、驳回（verdict 下拉：false_positive/dup/ignored）；认领后行显示认领者徽章；信号/候选双区 KPI 分列 |
| 资产 | `sec-domain-asset/dashboard-view.js` | `asset.list`、`asset.overview`（域名族/评级分布）、`asset.get`（钻取）、`asset.family` | 无（资产写走 asset_grade 脚本链，看板只读——级别列展示 grade 结果）| 域名族视图与深挖队列（asset.deep_queue）入口；跨视图跳链保留（pickHost/jumpFindings）|
| 接口 | `sec-domain-endpoint/dashboard-view.js` | `endpoint.hosts`（按主机分组）、`endpoint.list`（单主机明细）| 无 | 参数队列状态展示（endpoint 域查询）；越权矩阵入口（endpoint.matrix，04 域定稿）|
| 事实 | `sec-domain-fact/dashboard-view.js` | `fact.search`（分页 + 生命周期 facet）、`fact.stats`、`fact.bb.read`（黑板区）、`fact.graph` | `fact.correct`、`fact.deprecate` | note 速记默认隐藏开关保留；生命周期 facet 对齐 memcore 状态（cooling/candidate 打标可见）|
| 任务 | `sec-domain-task/dashboard-view.js` | `task.list`、`task.scheduled`、`task.runs`、`dashboard.workspaces/sessions`（三分区：定时卡片/一次性队列/执行历史）| `task.create/run_now/cancel/block/resume/schedule` | 任务链（plan_chain/task_chain 能力图）展示入口（exec 域查询）；会话跳链（ctx.sessions.open）保留 |
| 知识 | `sec-domain-know/dashboard-view.js` | `know.exp_list`（含 kind=playbook）、`know.kb_list/kb_read`、`know.rule_list/rule_read`、`fact.overview`、`know.coverage`（缓存卡）、`dashboard.memcore` | `know.exp_feedback/promote/deprecate/update/approve_export/revoke_export` | 六类型知识全景图保留（一类一位一工具 + 开局三步检索顺序）；覆盖缺口交叉表刷新按钮（refresh 参数）|
| 报告 | `sec-domain-report/dashboard-view.js` | `report.list`（索引直出，**项目/关键字/日期筛选**）、`report.read`（Modal）| `report.build`（生成按钮）| 列表元数据从索引来（severity 分布/total 可展示）；submissions 草稿区（kind=submission_draft）|
| 审批 | `sec-domain-approval/dashboard-view.js` | `approval.list`（pending 前置 + 判据 chip + 历史）| `approval.decide` | 待审批数进 tab 徽章（保留）；判据 chip 渲染改消费 approval 域 payload schema |
| 授权 | `sec-domain-authz/dashboard-view.js` | `scope.list`、`scope.program_list`、`dashboard.workspaces` | `scope.grant/rules.apply/revoke`、`program.bind_workspace` | 顶部跳转条（待审批候选 → 审批 tab）保留；表单按 grant/rules_apply 字段拆分提交；scope.yml 同步提示（spool sync 回收纪律提示保留）|
| 审计 | **壳自带**（消费总线查询，不属业务域）| `bus.audit_tail`（domain/cmd/actor/operator/session/时间窗过滤）| 无 | **v5 审计增强展示**：actor 维度（model session vs dashboard operator）可过滤——写操作审计增强（operator 身份）的消费面；deprecated_use 标记高亮 |

### 1.8 外部调用示例

**模型调用**：**无**——看板零工具投影（§1.6）。模型侧等价能力走各域查询（例：候选队列 `vuln_candidates` 查询，与看板工作队列同口径）。

**代码调用**（域视图插件注册 + 视图内写操作）：

```js
// @silksec/sec-domain-approval/dashboard-view.js
ctx.get('secDashboardViews').register({ id: 'approval', label: '审批', order: 90, component: ApprovalView })
// ApprovalView 内（写操作，operator 经 RpcProjector 自动注入）：
function onDecide(id, decision, note) {
  withBusy(() => dispatch('approval.decide', { id, decision, note })
    .then(() => approvalQuery.reload()))
}
```

**脚本调用**（运维巡检，loopback authority）：

```bash
curl -s -H "Authorization: Bearer $DSH_LOOPBACK_TOKEN" \
  -d '{"limit":5}' \
  https://127.0.0.1:8443/rpc/dashboard.ops | jq '.alerts'
```

---

## 二、内部实现（Internal）

### 2.1 数据模型（组件资产 + 注册表 + 拆分方案）

**client.js 2628 行的拆分方案**（按域视图拆独立文件、与域插件同目录、部署通道 = setup 脚本归位）：

| v4 函数（client.js 行号）| 行数约 | v5 文件 | 归属包 |
|---|---|---|---|
| 样式/图标/hooks/Toolbar/DocModal/EmptyState/SkeletonRows/StatsHeader/useRpc/usePagedQuery/callRpc（L100-560 散布）| ~450 | `shell/shared.js` + `shell/rpc.js` | `@silksec/sec-dashboard` |
| DashboardShell + SidebarAction + tabs 装配（L2210-2628）| ~420 | `shell/shell.js`（tab 装配改读 view registry）| 同上 |
| FindingsView + FindingsInsight（L560-795）| ~235 | `dashboard-view.js` | `@silksec/sec-domain-vuln` |
| AssetsView + AssetInsight + 域名族（L795-943）| ~150 | `dashboard-view.js` | `@silksec/sec-domain-asset` |
| EndpointsView（L943-1113）| ~170 | `dashboard-view.js` | `@silksec/sec-domain-endpoint` |
| FactsView + 黑板区（L1113-1356）| ~240 | `dashboard-view.js` | `@silksec/sec-domain-fact` |
| TasksView + TaskRunsView + 工作区区块（L1356-1524）| ~170 | `dashboard-view.js` | `@silksec/sec-domain-task` |
| ScopeView（L1524-1583）| ~60 | `dashboard-view.js` | `@silksec/sec-domain-authz` |
| ApprovalsView（L1583-1652）| ~70 | `dashboard-view.js` | `@silksec/sec-domain-approval` |
| AuditView（L1652-1810）| ~160 | `shell/audit-view.js`（壳自带，消费总线）| `@silksec/sec-dashboard` |
| KnowledgeView + KbSection + rules 区 + 全景图（L1810-2142）| ~330 | `dashboard-view.js` | `@silksec/sec-domain-know` |
| ReportsView（L2142-2210）| ~70 | `dashboard-view.js` | `@silksec/sec-domain-report` |

**部署通道**（延续 v4 sec-dashboard-plugin-setup.sh 模式）：每个域插件的 setup 脚本（`sec-domain-{domain}-plugin-setup.sh`）组装包时，把模板 `dsh-plugin-sec-domain-{domain}.dashboard-view.js` 复制为 `$PLUGIN_DIR/dashboard-view.js` 并在 package.json 声明 `"exports": {"./dashboard-view": "./dashboard-view.js"}`；DSH client 的 ModuleLoader 扫描到 client 资源即装载（与 v4 `exports["./client"]` 同机制，export 名不同）。壳的 setup 脚本组装三文件（shell/shared/rpc + index no-op）。**冒烟断言**（setup.sh 阶段）：`--profile web --dump-config` 组合树含壳 + 至少一个域视图；`requires` 声明的域服务全部在组合树内（缺席 = 该域视图 tab 隐藏，属合法降级，仅 warn）。

**状态归属**：视图组件的筛选/分页/Modal 态是组件私有 React state（tab 切换即销毁，v4 纪律保留）；跨视图跳链（pickHost/jumpFindings/jumpToHistory）经壳提供的 navigate 服务（`navigate(viewId, mutator)`）传递——v4 是闭包直调，v5 跨文件必须走壳服务。

### 2.2 状态机与不变量（UI 纪律）

看板无业务状态机（业务状态机在各域）。**UI 不变量**（代码评审 + 契约测试断言）：

| # | 不变量 | 说明 |
|---|---|---|
| INV-D1 | **信息架构纪律**：行只放摘要 + 跳链，详情一律回会话看（`ctx.sessions.open`）| v4 纪律整体保留——看板是态势面不是工作台 |
| INV-D2 | 只经 RPC（loopback authority），**无直连 DB、无文件系统触达** | 壳与视图禁止 import node:sqlite/fs——客户端 bundle 物理上无此能力（浏览器侧），宿主半面 no-op；这是结构性保证不是纪律约定 |
| INV-D3 | 写操作全部走 §1.2 域动词表，无第二写入口 | dispatch 封装是唯一写函数；grep 断言视图内无 `rpc.call(` 直调 |
| INV-D4 | 仅活跃视图轮询（30s），非活跃 tab 零请求 | useRpc/usePagedQuery 的 active 参数纪律 |
| INV-D5 | 颜色一律 theme tokens；severity 五色经 theme/change 注入 | 视图插件不得写颜色字面量 |
| INV-D6 | 聚合端点只准调查询 | §1.4 五端点的实现审查断言 |
| INV-D7 | 域缺席降级不崩溃 | requires 缺服务 → tab 隐藏；聚合端点单源失败 → 指标 null + degraded |

### 2.3 事务与联动（写操作链路 + operator 注入）

**写操作全链路**：

```
视图按钮 → withBusy → dispatch('vuln.confirm', args)
  → connection.rpc.call（loopback，携带 auth-gate 会话）
  → RpcProjector：从连接上下文取 auth-gate 用户 → ctx = {actor:'dashboard', operator:'singll'}
  → CommandGateway：actor 白名单校验（dashboard ∈ vuln_confirm 白名单）
  → 事务 + 事件 + audit（operator 字段落审计）
  → 信封返回 → 视图按 error.hint/replay 渲染 → finally reload 受影响查询
```

operator 注入的**安全边界**：auth-gate 用户身份在 RpcProjector（服务端）从 RPC 连接元数据提取，客户端 payload 里的任何 operator 字段被忽略——模型不能冒充看板操作者，看板操作者不能冒充模型（actor 由调用面决定，宪法 §三.1）。审计里 `actor=dashboard + operator=singll` 与 `actor=model + session_id=...` 天然可区分、可分别过滤（审计视图 INV 消费面）。

**联动失败语义**：域命令的信封若带 `subscriber_failed`（弱联动订阅者异常被网关捕获），壳 toast 提示"命令成功，联动延迟"——不回滚不重试（弱联动的最终一致由事件回放保证）。

### 2.4 后端适配器

**看板无后端**——不持有任何存储（INV-D2）。它的"能力矩阵"是**域可用性矩阵**：每个视图的 requires 声明 + §2.1 冒烟断言构成降级面。域后端切换（sqlite↔http-remote）对看板零影响（RPC 契约不变——这正是双投影架构的收益：v4 的 53 case 直调 assetDb 函数，域后端换型要改 53 处；v5 壳只认端点名）。

### 2.5 缓存与失效

| 层 | 机制 | 失效 |
|---|---|---|
| 活跃视图数据 | 30s 轮询（useRpc/usePagedQuery）| 轮询天然刷新；写操作 finally 强制 reload |
| 全局 KPI/红条 | dashboard.stats/ops 随轮询 | 同上 |
| knowledgeCoverage 缓存卡 | know 域查询内 7 天缓存（data/knowledge-coverage.json mtime 判新鲜）| refresh 参数强制重算（v4 逻辑收编 know 域）|
| 视图筛选器状态 | 组件 React state（tab 切走即销毁）| — |

### 2.6 性能与容量

| 项 | 现状/预期 |
|---|---|
| 轮询负载 | 活跃 tab 2-6 个查询/30s（分页列表 + 1-2 聚合）——单用户 loopback，QPS < 0.5 |
| client bundle | 拆分后单文件 ≤450 行（最大 = shell/shared）；按 profile 组合树懒加载域视图资源 |
| 列表分页 | 服务端分页 limit ≤200（各域查询契约）；行数=total 断言在域契约测试 |
| 渲染 | 十视图单挂载（Modal 全局单例，v4 模式）；大表 SkeletonRows 占位 |
| 并发操作员 | 多浏览器同时操作 → 域命令幂等键兜底（同 key 重放返回同结果 + replay 标记，视图 toast 提示）|

---

## 三、迁移与兼容

### 3.1 现状代码映射（行级）

| v4.x 位置 | 内容 | v5 去向 |
|---|---|---|
| `dsh-plugin-sec-dashboard.client.js` 全文 2628 行 | 十视图单体 | §2.1 拆分表逐函数映射（12 个目标文件）|
| `dsh-plugin-sec-dashboard.index.js`（14 行）| 宿主 no-op loader entry | 壳插件宿主半面（不变）|
| `dsh-plugin-sec-suite.dashboard-rpc.js` L188-625 `handleDashboardRpc` | 53 case 分发 | **整体退役**：41 自动投影（RpcProjector）+ 4 拆分映射（视图层分派）+ 5 壳聚合端点 + 3 收编（audit→总线、knowledgeCoverage→know、reports 解析→report 索引）|
| 同上 L150-187 | knowledgeCoverage 缓存/脚本定位/spawn 逻辑 | know 域 `know_coverage` 查询实现 |
| 同上 L39-135 | planChain/taskChain（能力图 BFS）| exec 域查询（10-exec.md 契约），壳任务视图引用 |
| `sec-dashboard-plugin-setup.sh` | 单包组装 | 壳三文件组装 + 各域 setup 脚本视图资源归位（§2.1）|
| `dsh-plugin-theme-silksong.*` | 全局主题 | **零改动**（theme registry 机制与壳/视图正交）|

### 3.2 兼容别名与观察期（RPC 端点名）

观察期内 RpcProjector 挂**旧裸名兼容层**（v4 case 名 → v5 端点的映射表，过网关全管线不绕校验）：

| 旧裸名 | 新端点 | 备注 |
|---|---|---|
| `findings` / `findingGet` | `vuln.list` / `vuln.get` | 参数名兼容（severity/status/program_id/q/noise→谓词映射）|
| `findingUpdate` | 按语义分派（§1.7 #35）| status 参数驱动：confirmed→vuln.confirm 等；**new→报 E_STATE + hint 引导**（回退已删除）|
| `taskSetStatus` | `task.block` / `task.resume` | status 参数驱动 |
| `scopeSaveProgram` | `scope.grant` + `scope.rules.apply` | 表单字段分派（含 rules 字段时两笔命令顺序执行）|
| 其余 47 个 | 同名域化（`stats`→`dashboard.stats` 等）| 直通映射 |

兼容层使用量进 audit（deprecated_use 口径）；删除走废弃三段式（7 天零使用验收）。**client.js 拆分与端点名切换解耦**：新壳组件从第一天就调新端点名，兼容层只服务未迁移的旧组件/外部队列脚本。

### 3.3 数据迁移与分阶段切换（新旧看板并行观察期）

**零数据迁移**（看板无存储）。分阶段切换（每阶段独立可回滚，对齐总设计 Phase 2/3 节奏）：

| 阶段 | 内容 | 验收 | 回滚 |
|---|---|---|---|
| D0 | 壳插件上线（registry + dispatch + 旧端名兼容层），视图仍是旧单体代码打包进壳 | 十视图行为与 v4 逐项比对（筛选/分页/跳链/写操作各抽 3 例）| revert 壳部署，旧 sec-dashboard 原样 |
| D1 | RpcProjector 自动投影通道上线，`{domain}.{verb}` 端点可用 | 投影端点与兼容层旧端名返回逐字段一致（diff 测试）| 关投影通道，兼容层独扛 |
| D2 | 视图逐域插件化：**vuln 先行**（候选工作队列升级一并落地），随后 asset→endpoint→fact→task→know→report→approval→authz；每域一次独立提交 | 该域视图新旧并排（tab 加 `-old` 后缀临时双开）观察一个调度周期（7 天），audit 对照新旧端点写操作等价 | revert 单域视图文件 |
| D3 | 删兼容层旧端名 + 删旧单体视图残余 + prompt/文档同步 | 旧端名 audit 7 天零使用 | — |

并行观察期的判定信号：`bus.audit_tail` 按 `actor=dashboard` 过滤——新旧端点（旧裸名 vs 点分名）的写操作比率、错误率对照；新端点错误率高即延长观察。

---

## 四、开放问题

1. **事件推送替代轮询**：30s 轮询对"审批待办红点/ops 红条"类信号延迟大且有空转；DSH RPC 是请求-响应模型，SSE/WebSocket 推送需要平台层支持——Phase 5 复评（低成本替代：dashboard.ops 轮询间隔自适应，红条出现后加密）。
2. **视图插件热插拔**：cordis client 组合树变更是否触发视图动态增删（当前假设：页面刷新后生效即可）。
3. **finding 状态回退的产品语义**：v4 看板允许把误标状态打回 new；v5 状态机删除该操作——误判纠正路径（reject 后重新登记）对操作员是否顺手，观察期收集反馈，必要时提请 vuln 域增加显式回退动词（如 vuln_reopen，须带 reason 证据）。
4. **多操作员并发认领**：候选工作队列的认领（vuln.claim）在两浏览器同时点时的 UX（幂等重放提示是否足够；是否需要行锁乐观提示"已被 X 认领"）。
5. **审计视图的留存与导出**：audit_tail 过滤能力之外，是否需要导出 CSV（经 report 域生成审计报告？域职责边界待议）。
6. **eval 视图**：evalStats 当前嵌在漏洞视图的 FindingsInsight；eval 域定稿后是否独立 tab（活评测集面板）。

## 五、2026-09-12 深度审查结论

| 维度 | 结论 |
|---|---|
| 逻辑/功能 | 当前 v4 单体看板功能可用，能覆盖十视图与主要写操作。 |
| 文档漂移 | §2.1 的“壳 + 逐域 dashboard-view.js”是设计目标，未实施：仓库没有 domain `dashboard-view.js`，实际仍是 2,628 行单体 client。 |
| hook/兼容层 | `dashboard-rpc.js` 存在 63 处 `v4 兜底`，总线失败即直调 `assetDb`；这会绕过域审计/幂等/事件，是当前最大原子化缺口。 |
| 性能 | 30s 轮询分页查询可用；单体 client 对构建/维护成本影响大于运行时性能。 |
| 静默错误 | 兜底 catch 不记录总线失败原因，无法区分域故障、契约漂移与数据错误。 |
| 独立升级 | 当前 dashboard 不能随域独立升级；必须先落地壳/视图拆分并删除 v4 直调。 |
