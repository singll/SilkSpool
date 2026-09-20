# 16 · 看板与 UI 原生面（RPC 投影消费 + DSH 原生承载 + 原子化隔离）

> 版本：v6.0（**合并**：原 16-dashboard v5.1 数据层设计 + 原 19-ui-surface v1.0 呈现层设计）｜ 状态：定稿
> 契约版本：1 ｜ 运行基线：DSH **0.1.5-rc.2**（csai 生产）
> 依赖：**订阅**：无（30s 轮询模型不变，事件推送为开放问题 §六）；**消费**：全部 14 域查询与命令（经 `/silksec-dashboard` 案例适配层与 `/silksec-domain` 投影）；**被订阅**：无
> 上位文档：[`00-conventions.md`](00-conventions.md)（冲突以它为准）；消费的域契约见 02–15 各文档。
> 机器可读挂点清单：[`bundles/dsh/doc/ui-surface-deps.yaml`](../../bundles/dsh/doc/ui-surface-deps.yaml)（DSH 升级复验的清单真相源）。
> 领域语言以 [`bundles/dsh/CONTEXT.md`](../../bundles/dsh/CONTEXT.md) 为准：看板（全局面）行内只放摘要 + 跳链，详细内容一律在会话里看。
>
> **合并说明**：原 `19-ui-surface.md`（看板 UI 原生面集成设计，P0–P7）已并入本文，其全部内容（DSH 官方承载面、生态调研、原子化隔离、升级适应性、主题 v4.2、执行计划）在下列章节落位；代码/脚本注释中原 `19-ui-surface §X` 一律改指本文对应章节。模块索引由 00–19 收敛为 **00–18**。

---

## 〇、定位与要解决的问题

看板（Dashboard）= 全局面的正式名称，是跨会话持久的平台状态 UI，按 **DSH 原生信息架构**分散承载，不再是一个「Modal 装十一 tab」的单体。

设计目标一句话：**让每个域的 UI 出现在 DSH 信息架构中它本来该在的位置，走与官方界面相同的路径；每个挂载点独立存活，一个挂掉不影响其他；DSH 升级时按清单定点复验，默认零改动。**

历史问题（均已解决，留作设计动因）：

1. **割裂**：旧看板 = `sidebar.footer.action` 一个按钮 → 弹出 ~1120px Modal → 十一个 tab 挤在一起，Modal 遮挡会话区，无法边看会话边操作。**已删**（2026-09-19）。
2. **没利用 DSH 信息架构**：审批待办、定时任务、漏洞候选各有天然归宿（浮层、右侧栏、设置页、会话内联动），旧版全塞 Modal。
3. **故障耦合**：2,828 行单体 client 一个文件挂一个槽，任何视图运行时错误在同一棵 React 树里爆炸。
4. **升级脆弱**：对 DSH 依赖点无清单化管理，升级时无法回答「这次改动碰没碰到我们」。

---

## 一、架构总览（数据层 × 呈现层）

看板在 **v5 总线原子化**基础上把呈现层也拆散，形成两层：

| 层 | 形态 | 真相源 |
|---|---|---|
| **数据层** | 域动词经总线 RpcProjector 投影为 `/silksec-domain` 的 `{domain}.{verb}` 端点；UI 侧另经 `/silksec-dashboard` 案例适配层读写（案例内部 fail-closed 走总线）| 各域文档 01–15；[01-bus](01-bus.md) §二 |
| **呈现层** | 6 个承载面包 + 7 个逐域视图包，共 13 个 client bundle，各自独立 cordis fiber；注册进 DSH 原生槽（主面板 / 右侧栏 / 设置页 / overlay / 会话槽）| 本文 §二/§三；`ui-surface-deps.yaml` |

**两条 RPC 通道（实测，务必区分）**：

| 通道 | 注册者 | 端点形态 | 消费方 | 纪律 |
|---|---|---|---|---|
| `/silksec-dashboard` | `dsh-plugin-sec-suite.js:995`（child fiber + `dashboardRpcRegistered` 幂等守卫，authority=loopback）| **56 个手写 case**（`dashboard-rpc.js`，v4 case 名保留为 UI 适配层）| 6 承载面包 + 7 域视图包（`connection.rpc.call('/silksec-dashboard', endpoint, payload)`）| 每个 case **fail-closed 走总线**（`busQuery`/`busDispatch`），无 v4 直写兜底；`assetDb` 仅剩 `taskChain` 宿主 helper（`stats` 于 19-ui-unify §4.4 改壳聚合查询） |
| `/silksec-domain` | `dsh-plugin-sec-domain-bus.js:1833`（RpcProjector，authority=loopback）| `{domain}.{verb}` **点分全名**（从域 manifest 自动投影命令 + 查询）| 脚本 / 模型 / 人 / 外部自动化 | operator 从连接上下文注入；业务端点统一 fail-closed |

> **与旧设计的差异（回填）**：原 16-dashboard 设计「UI 视图从第一天就调 `{domain}.{verb}`、`/silksec-dashboard` 的 case 代码删除」**未按此执行**。实际落地是：视图包继续调 `/silksec-dashboard` 的 v4 case 名，但 `dashboard-rpc.js` 把这些 case 整体改写为 **总线的瘦适配层**（UI-0，commit `e9dd1f1`；2026-09-18 的 63 处 `v4 兜底` 归零）。`{domain}.{verb}` 自动投影通道（`/silksec-domain`）服务非 UI 调用面。两通道并存、各司其职；`/silksec-dashboard` 端点是 **UI 专用适配层**，不是遗留待删代码。

### 1.1 服务标识与挂载

**核心架构转变：UI 也「一切皆插件」**——旧单体被拆成 **承载面包**（平台能力）+ **各域视图包**（业务视图）。

| 件 | 包名 | 形态 | 职责 |
|---|---|---|---|
| UI 内核 | `@silksec/ui-core` | 双面插件（宿主 no-op index + client bundle）| theme token 引用表、`SilksecErrorBoundary`、`useRpc`/`usePagedQuery` hooks、共享组件（Toolbar/Pager/EmptyState/DocModal/SkeletonRows…）、`secUiBus` 客户端微事件、**视图注册表 `viewRegistry`**（provide 为 `secDashboardViews`）、`markSurfaceHealth` 打卡 |
| 主面板 | `@silksec/ui-panel` | 双面插件 | `main` keyed 槽主面板 + `sidebar.panellist` 一级导航行 + `layout.selectPanel` 入口；消费 `viewRegistry` 按 order 装配 |
| 审批套件 | `@silksec/ui-approval` | 双面插件 | `shell.overlay` 待办胶囊 + 快捷处理浮卡 + 审批右侧栏 page tab |
| 任务套件 | `@silksec/ui-task` | 双面插件 | 任务右侧栏 page tab（四区块）+ 会话头「本会话任务」计数 |
| 授权设置 | `@silksec/ui-settings-scope` | 双面插件 | `settings.section`「授权范围」整节 |
| 会话绑定 | `@silksec/ui-session` | 双面插件 | `conversation.view` 安全产出 + 会话头计数钮 + `assistant-actions` 登记/沉淀 |
| 逐域视图 | `@silksec/sec-dashboard-view-{vuln,asset,endpoint,fact,know,report,audit}` | 双面插件（宿主 no-op + client）| 7 个独立 client bundle，单视图注册、单视图升级/回滚 |

**挂载矩阵**：

| profile | 承载面包 | 域视图包 |
|---|---|---|
| web | 6 个全装 | 7 个全装（随 web profile 依赖；缺席则 tab 静默隐藏）|
| headless | 不装（worker 无 UI）| 不装（域插件宿主半面照常工作）|

**主面板 tab 清单（8 个注册项 / 7 个视图包）**——canonical id 即注册 id：

| order | id | 文案 | 域 | 来源包 |
|---|---|---|---|---|
| 20 | `findings` | 漏洞 | vuln | `sec-dashboard-view-vuln` |
| 30 | `assets` | 资产 | asset | `sec-dashboard-view-asset` |
| 40 | `endpoints` | 接口 | endpoint | `sec-dashboard-view-endpoint` |
| 50 | `facts` | 事实 | fact | `sec-dashboard-view-fact` |
| 70 | `knowledge` | 知识 | know | `sec-dashboard-view-know` |
| 75 | `learning` | 学习 | know | `sec-dashboard-view-know` |
| 80 | `reports` | 报告 | report | `sec-dashboard-view-report` |
| 110 | `audit` | 审计 | bus | `sec-dashboard-view-audit` |

**审批 / 任务 / 授权不在主面板**：审批 → 右侧栏 page tab + overlay 胶囊；任务 → 右侧栏 page tab + 会话头计数；授权 → 设置页整节。

### 1.2 视图注册表协议（`viewRegistry`）

内核 provide cordis 客户端服务 `secDashboardViews`（= `viewRegistry`）；域视图包在 `apply` 时注册：

```js
// @silksec/sec-dashboard-view-vuln/client.js（client 半面）
export default {
  name: 'sec-dashboard-view-vuln',
  inject: ['secDashboardViews', 'connection'],
  apply(ctx) {
    ctx.get('secDashboardViews').register({
      id: 'findings',          // = 域名/视图 id（跳链引用）
      label: '漏洞',            // tab 文案
      order: 20,               // 主面板顺序
      domain: 'vuln',
      component: DomainRoot,   // React 组件（自足 wrapper，自持 query/handler）
      requires: ['connection'],// 依赖服务缺席 → 不注册（tab 静默隐藏）
      source: 'dashboard-view-vuln',
    })
  },
}
```

渲染顺序 = `viewRegistry.list()` 按 `order` 排序；注册晚于首渲染的视图经 React state 触发重渲染（cordis client 插件加载顺序不保证，注册表必须是动态的）。`requires` 声明的服务不存在 → 该视图静默不注册——**域缺席降级而非看板崩溃**。

`ui-core` 同时提供 `unregister`、`get`、`has` 与订阅接口，`register` 返回 disposer（`ctx.effect` 包裹，卸载自动摘除，防 `already registered`）。

### 1.3 域 × 表面映射总表

原则：**浏览型视图要宽度 → 主面板；操作型/待办型视图要随手 → 右侧栏 + 浮层；配置型 → 设置页；内容相关动作 → 挂在内容上（会话内绑定）**。

| 域 | 主表面 | 辅助/绑定面 | 理由 |
|---|---|---|---|
| **审批** approval | 右侧栏 page tab（kind=`silksec-approval`，single）| `shell.overlay` 待办胶囊（计数 + 点击弹快捷批准列表）；会话内审批卡（spike，未落地）| 最高频待办；批准常需对照来源会话证据，并排价值最大；通知是被动信号，属浮层 |
| **任务** task | 右侧栏 page tab（kind=`silksec-task`，single）| 会话头 utilities「本会话任务」计数 | 边盯 worker 会话边 run_now/cancel 是真实工作流；四区块重排为栏宽自适应 |
| **漏洞** vuln | 主面板视图（候选工作队列需全宽）| `conversation.chat.assistant-actions`「登记候选漏洞」；行内跳链 | 宽表 + 批量操作 + 多维筛选 |
| **资产** asset | 主面板视图（列表/域名族双模式）| — | 宽表 + 聚合视图 |
| **接口** endpoint | 主面板视图（按主机分组）| — | 随资产 |
| **事实** fact | 主面板视图（facet 洞察）| `assistant-actions`「沉淀事实」| 浏览型；沉淀动作挂内容 |
| **知识/学习** know | 主面板视图（体检卡 + 全景图 + 学习五问）| — | 全景图要宽度 |
| **报告** report | 主面板视图（列表）+ Modal 查看器阅读 | — | 阅读型 |
| **授权** scope | 设置页 `settings.section`「授权范围」整节 | 审批批准的写回链路不变（后端）| 授权 = 配置，配置在设置 |
| **审计** bus | 主面板视图 | — | 低频宽表 |
| 全局 KPI/纪律告警 | 主面板页头顶条 + overlay 胶囊 | — | 现状语义保留 |

入口路径：侧边栏「安全中心」一级导航行（`sidebar.panellist`）= 官方与会话平级的位置（UI 文案一律「安全中心」；「看板」仅作内部代号）。

### 1.4 各表面详述

**主面板（`@silksec/ui-panel`）**：

```js
// 注册（时序纪律：slots.inject 声明生命周期 + ctx.effect 收口 disposer）
// 实测形态（panel.client.js）：exports.inject=['slots']，apply 内用 slots.inject(key, cb)，
// keyed 槽用 options.key；list 槽才用 options.id；key 必须与 panellist 的 id 一致。
var d1 = slots.inject('main', function () {
  return slots.register({ name: 'main', key: 'silksec-dashboard', order: 30 }, DashboardPanel)
})
var d2 = slots.inject('sidebar.panellist', function () {
  return slots.register({ name: 'sidebar.panellist', id: 'silksec-dashboard', order: 30, label: '安全中心' }, PanelIcon)
})
// 打开：ctx.layout.selectPanel('silksec-dashboard')；返回会话：selectPanel(null)
// beginNavigation() 信号防快速连点竞态（官方服务自带）
```

- **视图组件与挂载解耦**：`DashboardPanel` 内部消费 `viewRegistry`；每个域视图是无挂载感知的纯组件。同一组件可挂主面板也可挂右侧栏 tab——这是降级链的基础（§2.5）。
- 壳保留：页头/KPI 顶条、30s 轮询引擎（`useRpc`/`usePagedQuery`）、共享组件。**壳零自有写命令**。
- 主题：主面板 chrome 由宿主渲染（自动跟随 silksong）；页内页头规范见 §四。
- **降级**：`sidebar.panellist` 缺席 → 侧边栏行内 `selectPanel` 兜底；`layout`/`main` 槽缺席 → 不渲染主面板（旧 Modal 形态已随旧单体删除，2026-09-19，**无 Modal 回退**）。

**审批套件（`@silksec/ui-approval`，最高价值项）**：

1. **通知胶囊（`shell.overlay`，list/root）**：常驻胶囊「待审批 · N」（丝线金徽章，纪律告警叠绯红描边）。点击弹**快捷处理浮卡**（自绘 popover，`bg-layer-3`）：pending 逐条「批准 / 驳回」，底部「打开审批中心 →」调 `ctx.sidebarRight.openTab('silksec-approval')`。零会话时胶囊照常工作（root scope），快捷浮卡自足完成审批。
2. **审批中心 tab（右侧栏 page type）**：`ctx.sidebarRightTabs.register({ id, kind:'silksec-approval', priority:'extension', title: () => '审批', guide: [...] })`（**实测方法名是 `register`，非 `registerType`**）+ tab 体注册进 `sidebar.right.pane.tab`（keyed），动态计数另注册 `sidebar.right.pane.tab.title`（每次渲染重读）。完整列表/筛选/留痕，与会话并排；分栏/浮窗/全屏由 dockkit 原生提供。
3. **会话内审批卡（未落地）**：`conversation.chat.node` keyed 渲染器对「按工具名自定义工具调用呈现」的扩展性未验证；降级为 `assistant-actions` 的「去审批」跳链。**未验证前不进入关键路径**。

数据全部走 `approval.*` RPC 投影；批准副作用（scope 写回 / 种子任务）在宿主域内，UI 不感知。

**任务 tab（`@silksec/ui-task`，右侧栏 page type）**：

- kind=`silksec-task`；栏内自上而下：**定时任务卡片**（`IconAlarmClockOutline` + `next_run_at` 相对时间）→ **一次性队列**（状态 `StateDot`）→ **执行历史**（默认折叠 `DisclosureRow`）；工作区块在窄栏形态降级为顶部 program 筛选 `Pill` 组。
- 写操作：`task.run_now/cancel/block/resume/schedule` RPC；行内操作图标 + title 纪律不变。
- 栏宽自适应：表格在 <480px 切换为卡片行。

**授权 → 设置页（`@silksec/ui-settings-scope`）**：`settings.section` 注册「授权范围」整节：program 列表（工作区徽章）、scope.yml 条目管理、排除清单、凭据引用状态。写操作走 `scope.*` RPC。设置页骨架/滚动/键盘可达性全部宿主原生。

**会话内绑定（`@silksec/ui-session`，三处全部 additive）**：

1. `conversation.session.header.utilities`：「安全产出」图标钮，badge 显示本会话 findings+facts 计数。**打开路径**：官方 utilities 条目的 owner props 为空（`ConversationHeaderActionOwnerProps = { children?: never }`，运行时 `renderSlot(..., {})`），条目不继承 header 的 inject 面，故 `props.selectView` 恒不可用——点击经 `secUiBus 'open:security-view'` 请求常驻 `shell.overlay` Modal 宿主打开本会话安全产出（2026-09-19 修复：此前 emit 无订阅者，按钮点击无反应）。
2. `conversation.view` ViewTab `{ id:'silksec-security', label:'安全产出' }`：会话内整页视图，按 `session_id` 过滤本会话产出的漏洞/事实/任务/Run 跳链。
3. `conversation.chat.assistant-actions`（list，owner `{messageId}`）：每条定稿消息追加「登记候选漏洞」「沉淀事实」两个动作，点击弹 primitives `Modal` 小表单（预填消息摘要，`RiskConfirmation` 确认写操作），写 `vuln.*` / `fact.*` RPC。

**跳链回路**：看板行内 → 会话（`ctx.sessions.open`）全部保留；反向：会话内各绑定面 → 右侧栏 tab / 主面板（`openTab` / `selectPanel`）。双向闭环：「详情在会话里看、操作在趁手的面里做」。

### 1.5 命令（写动词）总表

**壳零自有写命令**——看板不是域，一切写操作经域动词（RPC 投影 / 案例适配层）。消费的命令全景（= 各视图全部写操作点）：

| 域动词（总线名）| 消费视图 | `/silksec-dashboard` 案例 |
|---|---|---|
| `vuln.confirm` / `vuln.reject` / `vuln.submit` / `vuln.note` / `vuln.claim`* | 漏洞 | `findingUpdate`（按 status 拆分；`new` 回退已删）|
| `fact.correct` / `fact.deprecate` | 事实 | `factCorrect` / `factDeprecate` |
| `task.create` / `task.run_now` / `task.cancel` / `task.block` / `task.resume` / `task.schedule` | 任务 | `taskCreate` / `taskRunNow` / `taskCancel` / `taskSetStatus`（拆分）/ `taskScheduleUpdate` |
| `know.exp_feedback` / `know.exp_promote` / `know.exp_deprecate` / `know.exp_update` / `know.exp.approve_export` / `know.exp.revoke_export`* | 知识 | `expFeedback` / `expPromote` / `expDeprecate` / `expUpdate` / `expExportable`（0↔1 翻转）|
| `know.release_revoke` | 学习 | `learningRevokeRelease`（面板不直写台账）|
| `report.build` | 漏洞（生成报告）/ 报告 | `reportBuild` |
| `approval.decide` | 审批 | `approvalDecide` |
| `scope.grant` / `scope.exclude` / `scope.rules.apply` / `scope.revoke` / `scope.program_bind_workspace` | 授权 | `scopeSaveProgram`（拆分）/ `scopeDeleteProgram` / `programBindWorkspace` |
| `vuln.register_candidate` | 会话内「登记候选漏洞」| （ui-session 直达总线）|
| `fact.upsert` | 会话内「沉淀事实」| （ui-session 直达总线）|

\* `vuln.claim`（候选认领）与 `know.exp.approve_export` / `know.exp.revoke_export`（导出许可翻转）为对应域文档（02/07）的动词；动词不存在时按钮不渲染（requires 语义同 tab 级降级）。

**`findingUpdate` 的 `status='new'` 回退操作已删除**——状态机私有无回退动词（候选误判的纠正路径是 `vuln.reject` 后重新登记，见 §六 开放问题 3）。

**调用纪律（视图组件必须遵守，代码评审断言）**：

1. 写操作一律包 `withBusy(fn)`（busy 锁 + 失败提示 + finally 统一 reload 受影响查询）；
2. 错误展示消费信封的 `error.code/message/hint` 三元组——**hint 必须展示给操作者**；
3. `replay: true` 的返回按成功渲染 + toast「幂等重放」提示；
4. **operator 身份不在 payload 里传**——auth-gate 用户身份由服务端从 RPC 连接上下文注入（`actor='dashboard'` + `operator=<auth-gate user>`），调用方声明的 operator 字段一律忽略（宪法 §三.1 不可伪造原则）；audit 的 `operator` 字段由此而来，与 model 的 `session_id` 在审计里天然可区分。

### 1.6 查询投影与壳聚合端点

**壳保留 8 个手写端点**（`dashboard-rpc.js` 内的壳自有 case，**只准调各域查询、禁止直查表**）：

| case | 数据接口（聚合来源）| 消费位置 |
|---|---|---|
| `stats` | 壳聚合**各域查询**：`approval.stats` + `vuln.stats` + `task.list` + `ledger.discipline_stats` + `asset.overview`/`endpoint.list`/`fact.stats` → 六待办卡 + 库存副条（19-ui-unify §4.4；`assetDb.stats` 直查已删；2026-09-19 增「待提交 SRC」= `vuln.stats.signal.confirmed_unsubmitted`）| 顶部 KPI 六卡 + 库存副条 |
| `ops` | `ledger.discipline_stats` + `know.health` + `task.stats`/`task.scheduled` + `vuln.stats` + `asset.overview` → 五指标 + alerts + healthy | 红条横幅 + ops 卡片 |
| `memcore` | `deps.exp.memStatus()`（memcore 治理旁路观测：loaded/策略摘要）| memcore 缺席横幅（fail-open 提示）|
| `sessions` | DSH 平台会话清单（按 workspace 过滤）| 任务视图会话跳链（`ctx.sessions.open`）|
| `workspaces` | DSH 平台工作区清单 + 幂等配对 | 工作区区块 + 各视图 program 筛选器选项 |
| `learningOverview` / `learningTrace` | `know.learning_status` / `know.learning_trace`（Q22/Q23）+ episode 投影 + `eval.stats` | 学习 tab 五问口径 |
| `learningRevokeRelease` | 命令 `know.release_revoke` | 学习 tab 撤回（受控动词）|

聚合端点的**不变量**：任一来源域查询失败 → 该指标返回 `null` + `degraded: [域名]`，**不整体失败**（跨域聚合的可用性纪律）；`ops.alerts` 为空 ⇔ `healthy: true`。

其余读操作走各域查询（`vuln.list`、`asset.list`…），`/silksec-dashboard` 的 case 是薄适配层，`/silksec-domain` 的 `{domain}.{verb}` 是自动投影（§1.7）。

### 1.7 `/silksec-dashboard` 案例逐个去向（56 个，实测）

> 说明：本表是 `dashboard-rpc.js` 当前 **56 个手写 case** 的实测去向。原 16-dashboard 的「53 case」表统计于 v4 末期（少记 L6 的三个 learning 端点）；本表为 v6.0 重核口径。所有业务 case 均 fail-closed 到总线（无 v4 直写兜底）。

| # | case | 读/写 | 去向（总线命令/查询）| 类型 |
|---|---|---|---|---|
| 1 | `stats` | 读 | 壳聚合各域查询（approval.stats/vuln.stats/task.list/ledger.discipline_stats/asset.overview/endpoint.list/fact.stats）| 壳自有 |
| 2 | `ops` | 读 | 壳聚合（ledger/know/task/vuln/asset 查询）| 壳自有 |
| 3 | `workspaces` | 读 | DSH 平台工作区清单 | 平台面 |
| 4 | `sessions` | 读 | DSH 平台会话清单 | 平台面 |
| 5 | `memcore` | 读 | `exp.memStatus()` 治理观测 | 壳自有（fail-open）|
| 6 | `learningOverview` | 读 | `know.learning_status` + 跨域聚合 | 壳自有 |
| 7 | `learningTrace` | 读 | `know.learning_trace` | 壳自有 |
| 8 | `learningRevokeRelease` | 写 | `know.release_revoke` | 域命令 |
| 9 | `programBindWorkspace` | 写 | `scope.program_bind_workspace` | 域命令 |
| 10 | `scopeList` | 读 | `scope.list` | 域查询 |
| 11 | `scopeSaveProgram` | 写 | 拆分：`scope.grant` + `scope.exclude` + `scope.program_bind_workspace` | 拆分映射 |
| 12 | `scopeDeleteProgram` | 写 | `scope.list` → `scope.revoke` | 拆分映射 |
| 13 | `approvalList` | 读 | `approval.list`（+pending 计数）| 域查询 |
| 14 | `approvalDecide` | 写 | `approval.decide` | 域命令 |
| 15 | `taskRunNow` | 写 | `task.run_now` | 域命令 |
| 16 | `taskCancel` | 写 | `task.cancel` | 域命令 |
| 17 | `taskSetStatus` | 写 | 拆分：`task.block`（blocked）/ `task.resume`（queued）| 拆分映射 |
| 18 | `taskScheduleUpdate` | 写 | `task.schedule` | 域命令 |
| 19 | `taskCreate` | 写 | `task.create` | 域命令 |
| 20 | `tasks` | 读 | `task.list` | 域查询 |
| 21 | `scheduledTasks` | 读 | `task.scheduled` | 域查询 |
| 22 | `taskRuns` | 读 | `task.runs` | 域查询 |
| 23 | `reportBuild` | 写 | `report.build`（content 读回在壳侧）| 域命令 |
| 24 | `evalStats` | 读 | `eval.stats` | 域查询 |
| 25 | `audit` | 读 | `bus.audit_tail` | 域查询（总线）|
| 26 | `assets` | 读 | `asset.list` | 域查询 |
| 27 | `assetOverview` | 读 | `asset.overview` | 域查询 |
| 28 | `assetDetail` | 读 | `asset.get` | 域查询 |
| 29 | `assetFamily` | 读 | `asset.family` | 域查询 |
| 30 | `endpointHosts` | 读 | `endpoint.hosts` | 域查询 |
| 31 | `endpoints` | 读 | `endpoint.list` | 域查询 |
| 32 | `factStats` | 读 | `fact.stats` | 域查询 |
| 33 | `facts` | 读 | `fact.search` | 域查询 |
| 34 | `factGraph` | 读 | `fact.graph` | 域查询 |
| 35 | `factOverview` | 读 | `fact.overview` | 域查询 |
| 36 | `blackboard` | 读 | `fact.bb_read` | 域查询 |
| 37 | `factCorrect` | 写 | `fact.correct` | 域命令 |
| 38 | `factDeprecate` | 写 | `fact.deprecate` | 域命令 |
| 39 | `findings` | 读 | `vuln.list` | 域查询 |
| 40 | `findingGet` | 读 | `vuln.get` | 域查询 |
| 41 | `findingUpdate` | 写 | 拆分：`confirmed→vuln.confirm`；`false_positive/dup/ignored→vuln.reject`；`submitted/accepted→vuln.submit`；**`new` 拒绝**（E_STATE）| 拆分映射 |
| 42 | `programs` | 读 | `scope.program_list` | 域查询 |
| 43 | `expCards` | 读 | `know.exp_list` | 域查询 |
| 44 | `expFeedback` | 写 | `know.exp_feedback` | 域命令 |
| 45 | `expPromote` | 写 | `know.exp_promote` | 域命令 |
| 46 | `expDeprecate` | 写 | `know.exp_deprecate` | 域命令 |
| 47 | `expUpdate` | 写 | `know.exp_update` | 域命令 |
| 48 | `expExportable` | 写 | 拆分：`know.exp_approve_export` / `know.exp_revoke_export` | 拆分映射 |
| 49 | `playbooks` | 读 | `know.exp_rank`（**旧文档误记 `know.exp_list{kind:'playbook'}`**）| 域查询 |
| 50 | `kbList` | 读 | `know.kb_list` | 域查询 |
| 51 | `kbRead` | 读 | `know.kb_read` | 域查询 |
| 52 | `rulesList` | 读 | `know.rule_list` | 域查询 |
| 53 | `rulesRead` | 读 | `know.rule_read` | 域查询 |
| 54 | `knowledgeCoverage` | 读 | `know.coverage`（7 天缓存卡逻辑在域查询内）| 域查询 |
| 55 | `reports` | 读 | `report.list`（索引直出）| 域查询 |
| 56 | `reportRead` | 读 | `report.read` | 域查询 |

**去向统计**：域命令 20（含 learningRevokeRelease）+ 域查询 31 + 拆分映射 5（scopeSaveProgram / scopeDeleteProgram / taskSetStatus / findingUpdate / expExportable）+ 壳/平台 7（stats/ops/workspaces/sessions/memcore/learningOverview/learningTrace）= 56（拆分映射中 `scopeDeleteProgram` 同时读 `scope.list`）。`playbooks` 的旧口径（`exp_list{kind:'playbook'}`）已在 L4 收敛为 `exp_rank`。

### 1.8 事件

**壳不发布任何事件**（无 `dashboard.*` 域事件）。数据新鲜度靠 **30s 轮询**（`POLL_MS=30000`）：仅活跃 tab 的查询挂 timer，非活跃视图不取数（useRpc/usePagedQuery 的 active 参数纪律）。事件推送（SSE/轮询混合）是开放问题 §六.1。

### 1.9 模型工具面投影

**零工具注册**——看板是纯人机面。壳聚合端点**不向模型注册**（模型直接用各域查询，如 `vuln_stats`/`task_stats`）。`/silksec-domain` 只投影域 manifest 里的命令与查询。

### 1.10 外部调用示例

**模型调用**：无——看板零工具投影。模型侧等价能力走各域查询。

**脚本调用**（运维巡检，loopback authority，`/silksec-domain`）：

```bash
curl -s -H "Authorization: Bearer $DSH_LOOPBACK_TOKEN" \
  -d '{"domain":"ledger","verb":"discipline_stats"}' \
  https://127.0.0.1:8443/rpc/silksec-domain | jq '.value'
```

---

## 二、DSH 官方承载面与升级适应

### 2.1 官方承载面清单（DSH 0.1.5-rc.2，类型声明逐字验证）

| 面 | 接口 | 形态 | 用途定位 |
|---|---|---|---|
| **全局主面板** | `main` keyed 槽（root；保留键 `conversation`）+ `sidebar.panellist`（list，owner props `{size,active}`）+ `ctx.layout.selectPanel(id)` / `beginNavigation()` | 与会话平级的整屏页面 | 官方预留的「一级页面」通道 |
| **框架浮层** | `shell.overlay`（list，root）| 「浮在所有列之上、在各列滚动容器之外」的 additive 层；badge / status pill 属于这里 | 通知胶囊、全局指示 |
| **侧边栏底** | `sidebar.footer.action`（list，root）| 辅助入口 | 不再使用（旧看板入口已删）|
| **设置页** | `settings.section`（list，root）、`settings.general.item`、`settings.plugins.tab` | 原生设置页 | 配置型功能的官方归宿 |
| **主题** | `ctx.theme.register` + theme presenter 投影到 `<body>` | 全局 | silksong 现状不变 |
| **会话视图** | `conversation.view`（list）：`ViewTab{id,label}` | 会话内整页视图 |
| **会话头按钮** | `conversation.session.header.utilities`（list，右对齐）/ `.actions` | 图标按钮 |
| **消息动作** | `conversation.chat.assistant-actions`（list，owner `{messageId}`）| 每条已定稿 assistant 消息的有序动作行 |
| **消息尾链** | `conversation.chat.turnTail`（**chain，首匹配即占用**）| ⛔ 不用 |
| **输入区** | `conversation.input.dock` / `.overlay`（list）| 不用（防输入区噪音）|
| **聊天节点** | `conversation.chat.node`（keyed by ChatNodeKind）| 候选：审批请求工具调用的聊天内卡片（待 spike）|
| **原生右侧栏** | `ctx.sidebarRightTabs.register({id,kind,patterns?,priority,title,guide?})`——两阶段：类型进注册表，tab 体注册进 `sidebar.right.pane.tab`（keyed）。**实测方法名是 `register`（`SidebarRightTabRegistry.register`），非 `registerType`**；`title(address)` 是 open 时捕获的 chip 初值，动态计数须另注册 `sidebar.right.pane.tab.title` keyed 体 | 分栏/停靠/浮窗/全屏自带 |
| **页面打开** | `ctx.sidebarRight.openTab(kind)` | — |
| **优先级带** | `extension > builtin > fallback`；卸载后 builtin 自动复位 | — |

**右侧栏的会话作用域**：tab 存在会话 store，只对「在屏会话」写入；原生布局只在内存（刷新回折叠默认）。因此右侧栏承载的是「加速器」，不是唯一入口（见 §2.5 降级链）。

### 2.2 primitives 可复用资产

`Modal`、`Toast`、`Pill`、`Tag`、`StateDot`、`HoverCard`、`Tooltip`、`Menu`、`RiskConfirmation`、`DisclosureRow`、`MarkdownText`、`JsonTree`，及官方图标组（`IconAlarmClockOutline` 定时、`IconQueueOutline` 队列、`IconGaugeOutline` 仪表、`IconWarningOutline` 警告、`IconChecklistOutline` 审批候选等）。**chrome（槽位框架、tab 条、设置页骨架）由宿主渲染 = 自动吃 silksong 令牌，零额外主题工作。**

### 2.3 `ui-surface-deps` 清单机制（核心）

[`bundles/dsh/doc/ui-surface-deps.yaml`](../../bundles/dsh/doc/ui-surface-deps.yaml) 是机器可读的官方挂点清单：每个面声明它实际消费的官方挂点（槽名/服务/方法/primitives 组件/图标）及首次验证的 DSH 版本。DSH 升级流程（freeze→prepare→switch）中增加一步：**按新旧 tag diff 清单内的挂点文件**（`dsh-client-ui-*/lib/types/**` + primitives 导出表），命中哪个面的清单就复验哪个面，**未命中的面直接放行**。

### 2.4 版本线纪律

- 每个 UI 包 `peerDependencies` 钉 `@deepseek-ai/cordis` 与 DSH 版本线；`ui-surface-deps.yaml` 徽章式记录「已验证 DSH 版本」。
- rc 间升级：diff 未命中清单 → 只更新验证记录，零代码改动；命中 → 只动命中面的适配层。

### 2.5 降级链（适配层逐面定义）

| 面 | 首选 | 降级 1 | 降级 2 |
|---|---|---|---|
| 看板页面 | `main` + `panellist` + `selectPanel` | `panellist` 缺席 → 侧边栏行内 `selectPanel` 兜底 | `layout`/`main` 缺席 → 不渲染主面板（**旧 Modal 已随旧单体删除，2026-09-19，无 Modal 回退**）|
| 审批/任务 | 右侧栏 page tab | `sidebarRightTabs` 缺席 → 同一视图组件挂进主面板临时 tab（角标「降级」）| 主面板也缺席 → 面不渲染 |
| 通知 | `shell.overlay` 胶囊 | 缺席 → footer 入口挂计数徽章（footer 已随旧单体删除，实际为面内降级）| — |
| 授权 | `settings.section` | 缺席 → 不渲染设置节 | — |
| 会话绑定 | 各会话槽 | 缺席 → 不注册（会话面无全局影响）| — |

视图组件与挂载解耦（§1.4）使「同一组件换个挂点」成本 <50 行适配代码。

### 2.6 冒烟门禁

`sec-v5-accept.sh` 增「R5 UI 冒烟」段：① 默认结构断言——13 个 UI 包（6 承载 + 7 视图）在 web profile 组合树内 + 12 个表面 bundle 零颜色字面量（ui-core 令牌源豁免）；② `--ui-headless` 真机无头运行时断言——组合 bundle HTTP 200 且含各包标记；③ 每面挂载后在 `window.__silksecSurfaceHealth` 打卡（面 id → ok/degraded），巡检脚本读取该表；④ 每面 1 读 1 写 stub RPC 往返 + 零 console/page error。实现脚本：`dsh-ui-surface-smoke.{py,mjs}`。

### 2.7 生态调研结论（保留）

深度改 UI 的四条路线及结局：官方承载面注册（slots/服务/theme registry）= **唯一长寿路线**（better-sidebar 3.6k 星自绘面板在 DSH 0.1.5 推原生右侧栏后主动删除迁入 `ctx.sidebarRight*`）；自绘浮层/面板 = 短寿命；patch 宿主源码 = **反面教材，本项目永不走此路**；纯 CSS/令牌注入 = 稳定无新知。升级最佳实践：版本线矩阵、能力探测而非版本判断、挂点清单 diff、`ctx.inject` 驱动注册 + `ctx.effect` 包裹（防时序陷阱与 `already registered`）、挂载冒烟门禁、**只用 additive 槽（chain 槽一律不碰，dsh-bill 抢占 `turnTail` 遮住官方卡片是事故教训）**。

---

## 三、内部实现

### 3.1 包结构与 fiber 隔离

| 包 | 内容 | 依赖 |
|---|---|---|
| `@silksec/ui-core` | token 引用表、`SilksecErrorBoundary`、hooks、共享组件、`secUiBus`、视图注册表 | 只 inject slots/connection |
| `@silksec/ui-panel` | 主面板 + panellist 行 | ui-core |
| `@silksec/ui-approval` | overlay 胶囊 + 快捷浮卡 + 审批右侧栏 tab | ui-core |
| `@silksec/ui-task` | 任务右侧栏 tab + 会话头计数 | ui-core |
| `@silksec/ui-settings-scope` | 设置页授权节 | ui-core |
| `@silksec/ui-session` | 会话头钮 + conversation.view + assistant-actions | ui-core |
| `@silksec/sec-dashboard-view-<domain>` ×7 | 逐域视图组件 | ui-core |

每个包 = 宿主 no-op index + client 半面 + 独立 patch.yml 行（setup 脚本幂等组装）。**每个包自己的 `apply()` 崩溃只销毁自己的 fiber**（cordis 语义）；其他面照常。

### 3.2 五道隔离墙

1. **渲染隔离**：每个面的根组件包 `SilksecErrorBoundary`（自绘 class 组件）：崩溃 → 该面渲染 EmptyState + 错误摘要，错误经 `bus.audit_tail` 口径上报（actor=`dashboard`，加 `surface` 字段），**不冒泡到宿主树**。
2. **注册隔离**：每面独立 `ctx.inject` + `ctx.effect`；一个面的依赖服务缺席只导致该面静默降级。
3. **数据隔离**：面 → RPC 直连，域间已有总线隔离；一个域 RPC 超时/报错只在该面内呈现错误态，不阻塞其他面的轮询——**轮询引擎按面独立实例**（不再共享单体 30s 大轮询）。
4. **状态隔离**：localStorage 键按面命名空间（`silksec.ui.<surface>.*`），每个键独立 try/catch 解析，脏数据只重置该面偏好。
5. **构建隔离**：视图零颜色字面量（grep 断言）+ 每包独立 client bundle，单包语法错误不影响其他包的 bundle 加载。

### 3.3 跨面通信纪律

只允许两条路：(1) **经宿主 RPC 读写**（真相源）；(2) `secUiBus` 客户端信号（`open:approval` / `open:task:{id}` / `refresh:badges`），发布方与订阅方互不知道对方存在，缺席即无操作。**禁止**面与面直接 import 组件实例之外的状态引用。

### 3.4 数据模型与组件资产

**旧单体拆分去向（历史映射）**：旧 `dsh-plugin-sec-dashboard.client.js`（2,628 行，十视图 + 30s 轮询 + Modal）已拆除；最终文件去向为：

| 旧函数/段 | v6 落点 |
|---|---|
| 样式/图标/hooks/Toolbar/DocModal/EmptyState/SkeletonRows/StatsHeader/useRpc/usePagedQuery/callRpc | `@silksec/ui-core`（client.js，`exports.*`）|
| DashboardShell + SidebarAction + tabs 装配 | `@silksec/ui-panel`（`main` + `panellist`，tabs 改读 `viewRegistry`）|
| FindingsView/AssetsView/EndpointsView/FactsView/TasksView/ScopeView/ApprovalsView/KnowledgeView/ReportsView/AuditView | 7 个 `@silksec/sec-dashboard-view-<domain>` 包（+ 任务/审批/授权由 `ui-task`/`ui-approval`/`ui-settings-scope` 承接）|

**状态归属**：视图组件的筛选/分页/Modal 态是组件私有 React state（tab 切换即销毁）；跨视图跳链经 `navigate(viewId, mutator)` 传递。

### 3.5 状态机与不变量（UI 纪律）

看板无业务状态机（业务状态机在各域）。**UI 不变量**（代码评审 + 契约测试断言）：

| # | 不变量 | 说明 |
|---|---|---|
| INV-D1 | **信息架构纪律**：行只放摘要 + 跳链，详情一律回会话看（`ctx.sessions.open`）| 看板是态势面不是工作台 |
| INV-D2 | 只经 RPC（loopback authority），**无直连 DB、无文件系统触达** | 客户端 bundle 物理上无此能力（浏览器侧），宿主半面 no-op |
| INV-D3 | 写操作全部走 §1.5 域动词表，无第二写入口 | UI 侧唯一写入口 = 各视图 wrapper 内的 RPC 调用；`dashboard-rpc` 是唯一服务端适配层 |
| INV-D4 | 仅活跃视图轮询（30s），非活跃 tab 零请求 | useRpc/usePagedQuery 的 active 参数纪律 |
| INV-D5 | 颜色一律 theme tokens；severity 五色经 theme/change 注入 | 视图插件不得写颜色字面量 |
| INV-D6 | 壳聚合端点只准调查询 | §1.6 八端点的实现审查断言 |
| INV-D7 | 域缺席降级不崩溃 | requires 缺服务 → tab 不注册；聚合端点单源失败 → 指标 null + degraded |

### 3.6 事务与联动（写操作链路 + operator 注入）

```
视图按钮 → withBusy → connection.rpc.call('/silksec-dashboard', 'approvalDecide', args)
  → 案例适配层 → busDispatch('approval','decide',…)
  → 总线 CommandGateway：actor 白名单校验、幂等、事务、事件、audit（operator 落审计）
  → 信封返回 → 视图按 error.hint/replay 渲染 → finally reload 受影响查询
```

operator 注入的**安全边界**：auth-gate 用户身份在服务端从 RPC 连接元数据提取，客户端 payload 里的任何 operator 字段被忽略——模型不能冒充看板操作者，看板操作者不能冒充模型（actor 由调用面决定，宪法 §三.1）。

**联动失败语义**：域命令的信封若带 `subscriber_failed`（弱联动订阅者异常被网关捕获），壳 toast 提示「命令成功，联动延迟」——不回滚不重试（弱联动的最终一致由事件回放保证）。

### 3.7 后端适配器

**看板无后端**——不持有任何存储。它的「能力矩阵」是**域可用性矩阵**：每个视图的 `requires` + §2.6 冒烟断言构成降级面。域后端切换（sqlite↔http-remote）对看板零影响（RPC 契约不变——这正是双投影架构的收益）。

### 3.8 缓存与性能

| 层 | 机制 | 失效 |
|---|---|---|
| 活跃视图数据 | 30s 轮询（useRpc/usePagedQuery）| 轮询天然刷新；写操作 finally 强制 reload |
| 全局 KPI/红条 | `stats`/`ops` 随轮询 | 同上 |
| knowledgeCoverage 缓存卡 | know 域查询内 7 天缓存（`data/knowledge-coverage.json` mtime）| `refresh` 参数强制重算 |
| 视图筛选器状态 | 组件 React state（tab 切走即销毁）| — |

| 项 | 现状/预期 |
|---|---|
| 轮询负载 | 活跃 tab 2–6 个查询/30s（分页列表 + 1–2 聚合）——单用户 loopback，QPS < 0.5 |
| client bundle | 拆分后按包独立 bundle（构建隔离），按 profile 组合树懒加载 |
| 列表分页 | 服务端分页 limit ≤200；行数=total 断言在域契约测试 |
| 渲染 | 单挂载（Modal 全局单例）；大表 SkeletonRows 占位 |
| 并发操作员 | 多浏览器同时操作 → 域命令幂等键兜底（同 key 重放返回同结果 + replay 标记）|

---

## 四、丝之歌主题统一（规范 v4.2 增补清单）

**零新色值**。新表面全部消费既有 `--dsw-alias-*`；chrome 借宿主的自动免费。落地清单见 [`bundles/dsh/doc/silksong-theme-design.md`](../../bundles/dsh/doc/silksong-theme-design.md) §十一：

1. **主面板页头**：标题行 + KPI 顶条用 `--dsw-alias-bg-layer-1` 托底；当前视图指示 = 绯红 2px 下划线。
2. **overlay 胶囊**：`--dsw-alias-bg-layer-3`（最高浮层）+ `--dsw-alias-border-l2` 描边 + 圆角胶囊；待审批计数 = 丝线金（warn 语义）；纪律告警 = 绯红**描边/文字**（禁填充）。
3. **右侧栏 tab 内容区**：背景 `--dsw-alias-bg-base`；卡片 `layer-1`；tab 条/分栏把/浮窗框全部宿主 chrome，不动。
4. **设置节**：完全使用宿主设置行样式。
5. **会话绑定件**：沿用宿主按钮样式；「登记/沉淀」弹表单用 primitives `Modal` + `RiskConfirmation`。
6. **右侧栏 guide 陷阱**：条目说明在 guide >4 条时整列不渲染（上游 `MAX_DESCRIBED_ENTRIES=4`）——关键信息只放 title。
7. **纪律重申**：视图/表面文件禁止颜色字面量（hex/rgb/named），grep 断言进 CI；severity 五色继续走 `--silksec-sev-*`（theme/change 注入 + fallback）不变。
8. **全局统一（2026-09-19 回填 [archive/19-ui-unify.md](archive/19-ui-unify.md)，已归档）**：① 共享控件类（`silksec-btn/-confirm/icon-btn/-confirm/-danger/input/tab/kpi/row/chip/dash-dialog`）CSS 唯一定义源 = ui-core `ensureBaseStyles()`，承载面本地样式只留布局类；② 主面板改名**安全中心**，页头返回/刷新为 26×26 图标钮，tab 收敛为「漏洞/资产/接口/事实 + 更多（知识/学习/报告/审计二级导航）」（registry `group` 协议 minor 变更）；③ KPI 从库存量改为「今日待办 + 风险暴露」六卡（待审批/待处理漏洞/待验证候选/待提交 SRC/运行中·阻塞任务/纪律告警）+ 库存副条，全部可点击跳链（待提交 SRC 于 2026-09-19 产出闭环补齐）。规格与 CI 双重断言见主题文档 §11.8。走查补丁（2026-09-19）：去侧栏/页头图标、消息动作用图标钮、待审批/任务 KPI 无会话 seat 时弹 Modal、任务工作区筛选选项稳定不塌缩、全表单行省略等高（主题 §11.9）。

---

## 五、迁移与兼容

### 5.1 现状代码映射（行级）

| v4.x 位置 | 内容 | v6 去向 |
|---|---|---|
| `dsh-plugin-sec-dashboard.client.js` 全文 2,628 行 | 十视图单体 + Modal | 已删（`5fc887a`）→ 6 承载面包 + 7 域视图包 |
| `dsh-plugin-sec-dashboard.index.js` | 宿主 no-op loader entry | 已删 |
| `dsh-plugin-sec-suite.dashboard-rpc.js` `handleDashboardRpc` | 56 case 分发 | **保留为 UI 适配层**：全部 fail-closed 到总线（`busQuery`/`busDispatch`），`v4 兜底` 归零（`e9dd1f1`）|
| 同上 knowledgeCoverage 缓存/脚本定位/spawn | — | know 域 `know.coverage` 查询 |
| 同上 planChain/taskChain | 能力图 BFS | 宿主 helper（`/silksec-dashboard` case 内）|
| `sec-dashboard-plugin-setup.sh` | 单包组装 | 改为组装 7 个域视图包（`sec-dashboard-plugin-setup.sh` §4）|
| `dsh-plugin-theme-silksong.*` | 全局主题 | 零改动（theme registry 与壳/视图正交）|

### 5.2 兼容别名（已移除）

**2026-09-19（commit `cf77b79`）彻底移除兼容别名层**：调用方先迁语义动词，`bundles/dsh/templates/bus.aliases.yaml` 清空为 `aliases: {}` / `dispatch_aliases: {}`；`discipline-audit` 实测 `aliases=0`。具体：

- 看板 `findingUpdate` 状态流转 → 直达 `vuln.confirm/reject/submit`（无别名）；
- 会话「登记候选漏洞」→ 直达 `vuln.register_candidate`（actor 增 dashboard）；
- 全部 prompt 资产（persona/skills/rules/objective）在 5.1 已改写新动词。

别名机制（[01-bus.md](01-bus.md) §3.2）**仍作为通用能力保留**（未来跨域改名可在 `bus.aliases.yaml` 登记），当前 **0 条目**。旧工具名不再注册/投影/分派，调用返回 `E_BUS_VERB_UNKNOWN`。

> 注：`/silksec-dashboard` 的 v4 **case 名**（如 `findingUpdate`）不是总线兼容别名，是 UI 适配层端点名，保留不变。

### 5.3 分阶段切换（D0–D3 全部完成）

**零数据迁移**（看板无存储）。原三阶段（D0 壳、D1 投影通道、D2 逐域视图、D3 删旧）实际以 **UI-0 + P0–P7** 路线执行：

| 阶段 | 内容 | 状态 |
|---|---|---|
| UI-0 前置硬闸 | `dashboard-rpc.js` 63 处 `v4 兜底` 清除，业务端点统一 `busQuery/busDispatch` fail-closed | ✅ `e9dd1f1`（2026-09-18）|
| P0 地基 | `ui-core`（注册表/ErrorBoundary/hooks/secUiBus）+ `ui-surface-deps` 首版 | ✅ `3ed10de` |
| P1 主面板 | `ui-panel`（`main`+`panellist`+`selectPanel`）| ✅ `a384fef` |
| P2 审批套件 | overlay 胶囊 + 快捷浮卡 + 审批右侧栏 tab | ✅ `5880674` |
| P3 任务 tab | 任务右侧栏 tab + 会话头计数 | ✅ `b557402` |
| P4 授权设置 | `settings.section` 授权范围整节 | ✅ `22c8c98` |
| P5 会话绑定 | conversation.view + header 钮 + assistant-actions | ✅ `e029af0` |
| P6 逐域视图 | 7 个独立 `@silksec/sec-dashboard-view-<domain>` 包 | ✅ `6f4086c`（逐域 `f4e7f88`/`73acd34`/`64bb8a9`/`9273c53`/`d29dcad`）|
| P7 收尾 + D3 删旧 | 文档/主题/accept 冒烟固化；**旧单体 `@silksec/sec-dashboard` 整包删除（含 `-old` 视图、Modal 主形态、footer 入口）** | ✅ P7 `d6fe5ac`（2026-09-18）；删旧 `5fc887a`（2026-09-19，用户授权跳过 7 天并排观察）|

**删旧后的唯一形态**：看板 = `ui-core` + `ui-panel` + 5 承载面包 + 7 域视图包；任务/审批/授权由 DSH 原生右侧栏/设置页承载。`sec-v5-accept.sh` UI 冒烟按删旧口径（只要求 6 承载面包 + 7 域视图包）；`ui-surface-deps.yaml` 已记 `legacy_deletion: done`。**回滚 = 单包 revert + profile 恢复依赖**（不再有 Modal 兜底）。

并行观察期的判定信号（历史）：`bus.audit_tail` 按 `actor=dashboard` 过滤，对照新旧端点写操作比率/错误率。观察期已提前关账。

---

## 六、开放问题

1. **事件推送替代轮询**：30s 轮询对「审批待办红点 / ops 红条」类信号延迟大且有空转；DSH RPC 是请求-响应模型，SSE/WebSocket 推送需要平台层支持——复评（低成本替代：ops 轮询间隔自适应，红条出现后加密）。
2. **视图插件热插拔**：cordis client 组合树变更是否触发视图动态增删（当前假设：页面刷新后生效即可）。
3. **finding 状态回退的产品语义**：旧看板允许把误标状态打回 new；v6 状态机删除该操作——误判纠正路径（reject 后重新登记）是否顺手，必要时提请 vuln 域增加显式回退动词（如 `vuln_reopen`，须带 reason 证据）。
4. **多操作员并发认领**：候选工作队列认领（`vuln.claim`）在两浏览器同时点时的 UX（幂等重放提示是否足够；是否需要行锁乐观提示「已被 X 认领」）。
5. **审计视图的留存与导出**：`bus.audit_tail` 过滤能力之外，是否需要导出 CSV（经 report 域生成审计报告？域职责边界待议）。
6. **主面板 URL 直达**：`selectPanel` 是否随 URL hash 持久化（刷新回会话是可接受的官方默认）；如需直达链接，用自管 hash 属自绘层。
7. **会话内审批卡**：`conversation.chat.node` keyed 渲染器对「按工具名自定义工具调用呈现」的扩展性未验证；降级路径 `assistant-actions` 跳链已留。
8. **官方 Toast 服务**：primitives 导出 `Toast` 组件，是否存在跨插件 toast 服务（`ctx.toast`）未验证；新审批到达经 `secUiBus` `approval:pending` 广播（非关键路径）。
9. **零会话时右侧栏可达性**：已确认根 scope 胶囊照常工作、快捷浮卡自足；无在屏会话时 `openTab` 抛错由 `secUiBus` + 主面板降级承接。

---

## 七、实施状态回填与 commit 追踪

| 维度 | 结论（2026-09-19 复核）|
|---|---|
| 逻辑/功能 | 6 承载面包 + 7 域视图包 + 8 主面板 tab 全部部署 csai；`/silksec-dashboard` 56 case fail-closed 到总线。|
| 文档漂移 | **已消除**：原 16/19 的「设计 vs 实施」双轨叙述合并为单一事实文档；「53 case/自动投影/case 删除」等不实口径按实测 56 case 修正；「兼容别名观察期」「-old 并排观察」「Modal 兜底」「待删旧单体」等过时表述全部更新为删旧后口径。|
| hook/兼容层 | `dashboard-rpc.js` 的 63 处 `v4 兜底` 已清除（`e9dd1f1`）；`assetDb` 仅剩 `taskChain` 宿主 helper（`stats` 改壳聚合查询）；总线错误码/hint 经信封透传，不再静默降级。|
| 静默错误 | 兜底 catch 不记录总线失败原因的问题已消除：总线错误码/hint 经 `busError` 透传。|
| 独立升级 | 13 个独立 client bundle（构建隔离）+ 独立注册 fiber（运行隔离），可随域独立升级/回滚；旧单体已删，无 Modal 耦合。|

**commit 追踪**：UI-0 `e9dd1f1`；P0 `3ed10de`；P1 `a384fef`；P2 `5880674`；P3 `b557402`；P4 `22c8c98`；P5 `e029af0`；P6 `6f4086c`（逐域 `f4e7f88`/`73acd34`/`64bb8a9`/`9273c53`/`d29dcad`）；P7 `d6fe5ac`；删旧 `5fc887a`（2026-09-19）；别名清空 `cf77b79`（2026-09-19）。详细验收见 [进度历史归档](archive/progress-history.md)。

---

## 八、与相邻文档的关系

| 文档 | 关系 |
|---|---|
| [00-conventions.md](00-conventions.md) | 上位契约宪法；actor 不可伪造、点分端点命名、禁用词等以它为准 |
| [01-bus.md](01-bus.md) | `/silksec-domain` RpcProjector、命令网关、事件、幂等、别名机制（当前空表）的真相源 |
| 02–15 各域文档 | 看板消费的查询/命令/事件契约；UI 只做投影消费，不改域语义 |
| [17-llm-surface.md](17-llm-surface.md) | 模型工具面（与看板正交：看板零工具投影）|
| [18-migration.md](18-migration.md) | Phase 0–5 总线迁移；本文 §5.3 的 UI 拆分是总线之后的呈现层收尾 |
| [`ui-surface-deps.yaml`](../../bundles/dsh/doc/ui-surface-deps.yaml) | DSH 官方挂点机器可读清单（升级复验）|
| [`silksong-theme-design.md`](../../bundles/dsh/doc/silksong-theme-design.md) | 主题令牌全表与 v4.2 增补 |
