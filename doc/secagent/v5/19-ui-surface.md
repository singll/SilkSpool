# 19 · 看板 UI 原生面集成设计（表面分散 + 原子化隔离 + 深度绑定）

> 版本：v1.0 ｜ 状态：**定稿**（2026-09-18 用户评审通过）｜ 执行：**UI-0 前置硬闸 + P0 地基已完成（2026-09-18），P1 待起动工** ｜ 契约版本：1
> 上位文档：[`00-conventions.md`](00-conventions.md)（冲突以它为准）；本文是 [`16-dashboard.md`](16-dashboard.md) §一挂载模型的**修订设计**——16 的「壳 + 域视图注册表 + RPC 投影消费」数据层架构不变，本文把「一个 Modal 装十一个 tab」的呈现层拆散到 DSH 原生承载面。
> 证据基线：DSH **0.1.5-rc.2**（csai 生产当前版本）npm 包 `@deepseek-ai/dsh-client-ui-{layout,sidebar,sidebar-right,conversation,chat,settings,primitives,slots}` 的 `lib/types/**.d.ts` **逐字验证**（2026-09-18 拉取核对的类型声明，非推测）；生态调研见 §一。
> 领域语言以 [bundles/dsh/CONTEXT.md](../../../bundles/dsh/CONTEXT.md) 为准：看板 = 全局面的正式名称；行内只放摘要 + 跳链，详细内容一律在会话里看。

---

## 〇、要解决什么问题

1. **割裂**：现状看板 = `sidebar.footer.action` 一个按钮 → 弹出 ~1120px Modal → 十一个 tab 挤在一起。每次操作「开 Modal→找 tab→操作→关 Modal」，且 Modal 遮挡会话区，无法边看会话边操作。
2. **没有利用 DSH 自身的信息架构**：审批待办、定时任务、漏洞候选这些信号各有天然的官方归宿（浮层通知、右侧栏、设置页、会话内联动），现状全部塞在 Modal 里。
3. **故障耦合**：2,828 行单体 client（`dsh-plugin-sec-dashboard.client.js`）一个文件挂一个槽，任何视图运行时错误都在同一棵 React 树里爆炸。
4. **升级脆弱面集中**：对 DSH 的依赖点没有清单化管理，升级时无法回答「这次 DSH 改动碰没碰到我们」。

设计目标一句话：**让每个域的 UI 出现在 DSH 信息架构中它本来该在的位置，走与官方界面相同的路径；每个挂载点独立存活，一个挂掉不影响其他；DSH 升级时按清单定点复验，默认零改动。**

---

## 一、生态调研结论（2026-09-18，GitHub `dsh-plugin` topic 15252 仓库）

### 1.1 深度改 UI 的四条路线及结局

| 路线 | 代表 | 结局 |
|---|---|---|
| **官方承载面注册**（slots / 服务 / theme registry） | dsh-better-sidebar v0.19、各皮肤插件 | **唯一长寿路线**。better-sidebar 曾是 3.6k 星的自绘右侧面板，DSH 0.1.5 推出原生右侧栏后**主动删除全部自绘面板与自由窗口**，迁入 `ctx.sidebarRight*`——自绘承载面被官方能力收编是必然趋势 |
| 自绘浮层/面板（fixed 容器挂 body） | 旧版 better-sidebar、鲸鱼宠物类 | 短寿命：布局/快捷键/z-index 随宿主改版漂移，作者自己放弃了 |
| patch 宿主源码 | dshui-for-vscode（12 处源补丁 + verify-patches.mjs 漂移校验）、dsh-plugin-market（需 4 处核心 patch 等上游合入） | **反面教材**：每次升级重套补丁，维护成本最高。**本项目纪律：永不走此路** |
| 纯 CSS/令牌注入（皮肤类） | skin-claude、glassic-mist 等 | 与 silksong 主题同手法，稳定，无新知 |

### 1.2 升级适应性最佳实践（直接吸收）

1. **版本线矩阵**（better-sidebar）：`peerDependencies` 钉 DSH 版本线（`^0.1.5-rc.1`）；rc.1→rc.2 的 delta 不触及自己依赖的面时**只推进验证徽章、零代码改动**——「升级尽量不动」的可复制范式。
2. **能力探测而非版本判断**：`features.includes('badge')`、服务存在性结构化探测，老版本下优雅降级。
3. **挂点清单 diff**（社区讨论 #5130）：「插件能加载 ≠ 行为正确」——有插件静态检查全绿但运行时静默不装载。方法：先声明插件实际依赖的上游挂点，升级时按 tag diff 这些挂点，命中才复验。→ 本文 §六落地为 `ui-surface-deps` 清单。
4. **注册时序陷阱**（better-sidebar 实测）：`sidebarRightTabs` 服务可能**晚于槽声明回调**到达，按槽触发注册会「静默什么都不注册且永不重试」。**纪律：一切注册用 `ctx.inject([...], cb)` 驱动、用 `ctx.effect()` 包裹**（卸载自动 disposer，防 `already registered`）。
5. **挂载冒烟门禁**：CI 钉版 + npm 打包→真实挂载→无头渲染（`test:mount`）。→ 落进 `sec-v5-accept.sh` 的 UI 冒烟段。
6. **additive 槽纪律**（我们自己的 rc.2 升级记录 §根因一）：dsh-bill 抢占 `conversation.chat.turnTail`（chain 首匹配即占用）遮住了官方文件卡片。**本项目只用 list/additive 槽；chain 槽一律不碰**。

---

## 二、DSH 0.1.5-rc.2 官方承载面清单（类型声明逐字验证）

### 2.1 全局（root scope）

| 面 | 接口 | 形态 | 用途定位 |
|---|---|---|---|
| **全局主面板** | `main` keyed 槽（root；保留键 `conversation`）+ `sidebar.panellist`（list，侧边栏导航行，owner props `{size, active}`）+ `ctx.layout.selectPanel(id)` / `beginNavigation()` | 与会话平级的整屏页面 | **官方已预留的「一级页面」通道**——本文核心承载面 |
| **框架浮层** | `shell.overlay`（list，root） | 「浮在所有列之上、在各列滚动容器之外」的 additive 层；类型注释明示 badge / status pill 属于这里 | 通知胶囊、全局指示 |
| 侧边栏底 | `sidebar.footer.action`（list，root） | 现状入口 | 保留为辅助入口 |
| 设置页 | `settings.section`（list，root：注册**整节**新设置区）、`settings.general.item`、`settings.plugins.tab` | 原生设置页 | 配置型功能的官方归宿 |
| 主题 | `ctx.theme.register` + theme presenter 投影到 `<body>` | 全局 | silksong 现状不变 |

### 2.2 会话（session scope）

| 面 | 接口 | 形态 |
|---|---|---|
| 会话视图 | `conversation.view`（list）：注册 `ViewTab{id,label}`，会话头出现平级视图页签（Chat/Trajectory 同款机制） | 会话内整页视图 |
| 会话头按钮 | `conversation.session.header.utilities`（list，右对齐）/ `.actions`（标题旁） | 图标按钮 |
| 消息动作 | `conversation.chat.assistant-actions`（list，owner `{messageId}`）：每条已定稿 assistant 消息的有序动作行 | **深度绑定锚点**：把操作挂到内容上 |
| 消息尾链 | `conversation.chat.turnTail`（**chain，首匹配即占用**） | ⛔ 不用（dsh-bill 事故教训） |
| 输入区 | `conversation.input.dock` / `.overlay`（list） | 本设计不用（防输入区噪音） |
| 聊天节点 | `conversation.chat.node`（keyed by ChatNodeKind） | 候选：审批请求工具调用的聊天内卡片（**待 spike 验证**，§九 #2） |

### 2.3 原生右侧栏（session scope，dockkit 分栏/停靠/浮窗/全屏自带）

| 面 | 接口 |
|---|---|
| tab 类型注册 | `ctx.sidebarRightTabs.registerType({ id, kind, patterns?, priority, title, guide? })`——两阶段：类型进注册表，tab 体注册进 `sidebar.right.pane.tab` keyed 槽（key=类型 id） |
| 页面打开 | `ctx.sidebarRight.openTab(kind)`；资源寻址 `dsh-resource://` + `openResource` |
| 优先级带 | `extension > builtin > fallback`（VS Code 同款解析器）；卸载后 builtin 自动复位 |

**右侧栏的会话作用域注意**：tab 存在会话 store 里，只对「在屏会话」写入；原生布局**只在内存**（刷新回折叠默认）。因此右侧栏承载的是「加速器」，不是唯一入口（见 §四降级设计）。

### 2.4 primitives 可复用资产（主题天然统一）

`Modal`、`Toast`、`Pill`、`Tag`、`StateDot`、`HoverCard`、`Tooltip`、`Menu`、`RiskConfirmation`、`DisclosureRow`、`MarkdownText`、`JsonTree`，及官方图标组（`IconAlarmClockOutline` 定时、`IconQueueOutline` 队列、`IconGaugeOutline` 仪表、`IconWarningOutline` 警告、`IconChecklistOutline` 审批候选等）。**chrome（槽位框架、tab 条、设置页骨架）由宿主渲染 = 自动吃 silksong 令牌，零额外主题工作。**

---

## 三、域 × 表面映射总表（拆分方案核心）

原则：**浏览型视图要宽度 → 主面板；操作型/待办型视图要随手 → 右侧栏 + 浮层；配置型 → 设置页；内容相关动作 → 挂在内容上（会话内绑定）**。

| 现 tab | 域 | 主表面 | 辅助/绑定面 | 理由 |
|---|---|---|---|---|
| **审批** | approval | **右侧栏 page tab**（kind=`silksec-approval`，single） | **`shell.overlay` 待办胶囊**（计数 + 点击弹快捷批准列表）；会话内审批卡（spike） | 最高频待办；批准时常常要对照来源会话的证据，并排价值最大；通知是被动信号，属于浮层 |
| **任务** | task | **右侧栏 page tab**（kind=`silksec-task`，single）——定时任务卡片（`IconAlarmClockOutline`）+ 一次性队列（`IconQueueOutline`）+ 执行历史 | 会话头 utilities「本会话任务」计数 | 边盯 worker 会话边 run_now/cancel 是真实工作流；四区块重排为栏宽自适应 |
| **漏洞** | vuln | **主面板视图**（候选工作队列需全宽） | `conversation.chat.assistant-actions`「登记候选漏洞」（预填消息摘要）；行内跳链保留 | 宽表 + 批量操作 + 多维筛选 |
| **资产** | asset | 主面板视图（列表/域名族双模式） | — | 宽表 + 聚合视图 |
| **接口** | endpoint | 主面板视图（按主机分组） | — | 随资产 |
| **事实** | fact | 主面板视图（facet 洞察） | `assistant-actions`「沉淀事实」 | 浏览型；沉淀动作挂内容 |
| **知识/学习** | know | 主面板视图（体检卡 + 全景图） | — | 全景图要宽度 |
| **报告** | report | 主面板视图（列表）+ 保留 Modal 查看器阅读 | — | 阅读型 |
| **授权** | scope | **设置页 `settings.section`「授权范围」整节**（scope.yml 管理/排除清单/凭据引用） | 审批批准的写回链路不变（后端） | 授权 = 配置，配置在设置——与官方「模型在设置、插件在设置」同路径 |
| **审计** | bus | 主面板视图 | — | 低频宽表 |
| 全局 KPI/纪律告警 | 壳 | 主面板顶条 + overlay 胶囊红条语义并入 | — | 现状语义保留 |

**结果**：主面板从「十一 tab 大杂烩」瘦身为**浏览型数据中心**（漏洞/资产/接口/事实/知识/报告/审计 七视图）；审批、任务迁出到右侧栏；授权迁出到设置页；通知能力新增在浮层；会话内新增三处绑定。入口路径：侧边栏「看板」一级导航行（`sidebar.panellist`）= 官方与会话平级的位置。

---

## 四、各表面详细设计

### 4.1 全局主面板（看板本体）

```js
// 注册（时序纪律：inject 驱动 + effect 包裹，§一.2-4）
ctx.inject(['layout', 'slots'], function () {
  ctx.effect(() => {
    var d1 = slots.register({ name: 'main', id: 'silksec-dashboard', order: 30 }, DashboardPanel)
    var d2 = slots.register({ name: 'sidebar.panellist', id: 'silksec-dashboard', order: 30, label: '看板' }, PanelIcon)
    return function () { d1(); d2() }
  })
})
// 打开：ctx.layout.selectPanel('silksec-dashboard')；返回会话：selectPanel(null)
// beginNavigation() 信号防快速连点竞态（官方服务自带）
```

- **视图组件与挂载解耦**：`DashboardPanel` 内部仍走 16-dashboard 的 `secDashboardViews` 注册表；每个域视图是无挂载感知的纯组件。**同一组件可挂主面板也可挂右侧栏 tab**——这是降级链的基础（§六.3）。
- 壳保留：tab 骨架、30s 轮询引擎（`useRpc`/`usePagedQuery`）、KPI 顶条、共享组件。**壳零自有写命令**（不变）。
- `sidebar.footer.action` 入口保留，行为从「开 Modal」改为 `selectPanel`；`panellist` 缺席（旧 DSH）时回退为 Modal 形态（适配层分支，§六）。
- 主题：主面板 chrome 由宿主渲染（自动跟随 silksong）；页内页头规范见 §七。

### 4.2 审批套件（三件套，本设计最高价值项）

1. **通知胶囊（`shell.overlay`）**：右下角常驻胶囊「待审批 · N」（丝线金徽章，纪律告警时叠绯红描边——填充即行动的铁律不变）。点击弹出**快捷处理浮卡**（自绘 popover，`bg-layer-3`）：pending 列表逐条「批准 / 驳回」（图标 + title 悬停纪律），底部「打开审批中心 →」调 `ctx.sidebarRight.openTab('silksec-approval')`。零会话时胶囊照常工作（root scope），快捷浮卡自足完成审批，右侧栏只是深读入口。
2. **审批中心 tab（右侧栏 page type）**：`registerType({ id: 'silksec-approval-view', kind: 'silksec-approval', priority: 'extension', title: () => '审批', guide: [{ order: 60, title: () => '审批中心', icon }] })` + tab 体注册进 `sidebar.right.pane.tab`。完整列表/筛选/留痕，与会话并排。宽度拖拽、浮窗、全屏由 dockkit 原生提供（零代码）。
3. **会话内审批卡（spike，§九 #2）**：agent 用 `approval_request` 工具提请时，工具调用在聊天里渲染为可交互审批卡（类型/主体/判据/批准驳回按钮）。若 `conversation.chat.node` keyed 渲染器支持按工具名扩展则落地；不支持则降级为 `assistant-actions` 的「去审批」跳链。**未验证前不进入关键路径**。

数据全部走 `approval.*` RPC 投影；批准副作用（scope 写回/种子任务）在宿主域内，UI 不感知。

### 4.3 任务 tab（右侧栏 page type）

- kind=`silksec-task`；栏内布局自上而下：**定时任务卡片**（`IconAlarmClockOutline` + next_run_at 相对时间 `relativeTime`）→ **一次性队列**（状态 `StateDot`）→ **执行历史**（默认折叠 `DisclosureRow`）；工作区区快在窄栏形态降级为顶部 program 筛选 `Pill` 组。
- 写操作：`task.run_now/cancel/block/resume/schedule` RPC；行内操作图标 + title 纪律不变。
- 栏宽自适应：表格在 <480px 切换为卡片行（资产视图已有双模式先例，同一套响应式纪律）。

### 4.4 授权 → 设置页

`settings.section` 注册「授权范围」整节：program 列表（工作区徽章）、scope.yml 条目管理、排除清单、凭据引用状态。写操作走 `scope.*` RPC 不变。**收益**：设置页骨架/滚动/键盘可达性全部宿主原生；主题零适配；与「模型配置在设置」的官方心智一致。原看板「授权」tab 观察一个周期后删除（§八 P4）。

### 4.5 会话内绑定（三处，全部 additive）

1. **`conversation.session.header.utilities`**：「安全产出」图标钮，badge 显示本会话 findings+facts 计数；点击切换 `conversation.view` 到安全视图。
2. **`conversation.view` ViewTab** `{ id: 'silksec-security', label: '安全产出' }`：会话内整页视图，按 `session_id` 过滤本会话产出的漏洞/事实/任务/Run 跳链。**这是「UI 与功能深度绑定」的直接体现**——看板数据按生产者会话回溯（run 落 `session_id` 的既有设计在此兑现）。
3. **`conversation.chat.assistant-actions`**：每条定稿消息追加「登记候选漏洞」「沉淀事实」两个动作（list 槽 additive，安全），点击弹 primitives `Modal` 小表单（预填消息摘要，`RiskConfirmation` 确认写操作），写 `vuln.*` / `fact.*` RPC。

### 4.6 跳链回路（不变 + 增强）

既有「看板行内 → 会话」跳链（`ctx.sessions.open`）全部保留；新增反向回路：会话内各绑定面 → 右侧栏 tab / 主面板（`openTab` / `selectPanel`）。双向闭环后，「详情在会话里看、操作在趁手的面里做」不再有断点。

---

## 五、原子化故障隔离架构

目标：**任何一个面的 bug（渲染崩溃/注册失败/RPC 异常/脏本地状态）不影响其他任何面，也不影响 DSH 宿主。**

### 5.1 包结构（每面一个 cordis fiber）

| 包 | 内容 | 依赖 |
|---|---|---|
| `@silksec/ui-core` | theme token 引用表、`SilksecErrorBoundary`、`useRpc` 等 hooks、共享组件（Toolbar/EmptyState/DocModal）、`secUiBus` 客户端微事件服务（跨面信号：胶囊点击→开审批 tab）、视图注册表 | 无（只 inject slots/connection） |
| `@silksec/ui-panel` | 主面板 + panellist 行 + footer 入口 | ui-core |
| `@silksec/ui-approval` | overlay 胶囊 + 快捷浮卡 + 审批右侧栏 tab (+spike 卡) | ui-core |
| `@silksec/ui-task` | 任务右侧栏 tab | ui-core |
| `@silksec/ui-settings-scope` | 设置页授权节 | ui-core |
| `@silksec/ui-session` | 会话头钮 + conversation.view + assistant-actions | ui-core |
| 各域 `dashboard-view.js` | 域视图组件（16-dashboard 既定架构） | ui-core + 域服务（`requires` 降级） |

每个包 = 宿主 no-op index + client 半面 + 独立 patch.yml 行（setup 脚本幂等组装模式照搬 sec-dashboard 现状）。**每个包自己的 `apply()` 崩溃只销毁自己的 fiber**（cordis 语义）；其他面照常。

### 5.2 五道隔离墙

1. **渲染隔离**：每个面的根组件包 `SilksecErrorBoundary`（自绘 class 组件——React 错误边界只能 class）：崩溃 → 该面渲染 EmptyState + 错误摘要，错误经 `bus.audit_tail` 口径上报（actor=`dashboard`，加 `surface` 字段），**不冒泡到宿主树**。
2. **注册隔离**：每面独立 `ctx.inject` + `ctx.effect`；一个面的依赖服务缺席（如 `sidebarRightTabs` 被 DSH 移除）只导致**该面静默降级**，其余面不受影响。
3. **数据隔离**：面 → `{domain}.{verb}` RPC 直连，域间已有总线隔离；一个域 RPC 超时/报错只在该面内呈现错误态（现有 useRpc 错误态模式），不阻塞其他面的轮询——**轮询引擎也按面独立实例**（不再共享单体 30s 大轮询）。
4. **状态隔离**：localStorage 键按面命名空间（`silksec.ui.<surface>.*`），每个键独立 try/catch 解析，脏数据只重置该面偏好。
5. **构建隔离**：视图零颜色字面量（grep 断言）+ 每包独立 client bundle，单包语法错误不影响其他包的 bundle 加载（ModuleLoader 按包加载）。

### 5.3 跨面通信纪律

只允许两条路：(1) **经宿主 RPC 读写**（真相源）；(2) `secUiBus` 客户端信号（`open:approval` / `open:task:{id}` / `refresh:badges`），发布方与订阅方互不知道对方存在，缺席即无操作。**禁止**面与面直接 import 组件实例之外的状态引用。

---

## 六、DSH 升级适应性设计

### 6.1 `ui-surface-deps` 清单（核心机制）

在 `bundles/dsh/doc/` 落一份机器可读的 **`ui-surface-deps.yaml`**：每个面声明它实际消费的官方挂点（槽名/服务/方法/primitives 组件/图标），及首次验证的 DSH 版本。DSH 升级流程（freeze→prepare→switch）中增加一步：**按新旧 tag diff 清单内的挂点文件**（`dsh-client-ui-*/lib/types/**` + primitives 导出表），命中哪个面的清单就复验哪个面，**未命中的面直接放行**——这就是「升级尽量不动，甚至不动」的工程化落地（社区 #5130 方法论的清单化）。

### 6.2 版本线纪律（抄 better-sidebar）

- 每个 UI 包 `peerDependencies` 钉 `@deepseek-ai/cordis` 与 DSH 版本线；文档徽章式记录「已验证 DSH 版本」。
- rc 间升级：diff 未命中清单 → 只更新验证记录，零代码改动；命中 → 只动命中面的适配层。

### 6.3 降级链（适配层逐面定义）

| 面 | 首选 | 降级 1 | 降级 2 |
|---|---|---|---|
| 看板页面 | `main` + `panellist` + `selectPanel` | `panellist` 缺席 → footer.action + selectPanel | `layout` 缺席 → 现状 Modal 形态（保留一个观察期） |
| 审批/任务 | 右侧栏 page tab | `sidebarRightTabs` 缺席 → **同一视图组件挂进主面板临时 tab**（角标「降级」） | 主面板也缺席 → Modal |
| 通知 | `shell.overlay` 胶囊 | 缺席 → footer.action 按钮上挂计数徽章 | — |
| 授权 | `settings.section` | 缺席 → 主面板「授权」tab（即现状） | — |
| 会话绑定 | 各会话槽 | 缺席 → 不注册（会话面无全局影响） | — |

视图组件与挂载解耦（§四.1）使「同一组件换个挂点」成本 <50 行适配代码。

### 6.4 冒烟门禁

`sec-v5-accept.sh` 增「UI 冒烟」段：① `--dump-config` 组合树含各 UI 包 loader entry；② 每包 client bundle HTTP 200；③ 每面挂载成功后在 `window.__silksecSurfaceHealth` 打卡（面 id → ok/degraded），升级巡检脚本读取该表（经既有 headless 通道或人工 DevTools 一步）；④ 每面 1 读 1 写 RPC 往返抽样。

---

## 七、丝之歌主题统一（规范 v4.2 增补清单）

**零新色值**。新表面全部消费既有 `--dsw-alias-*`；chrome 借宿主的自动免费。落地时把以下增补写进 `bundles/dsh/doc/silksong-theme-design.md` v4.2：

1. **主面板页头**：标题行 + KPI 顶条用 `--dsw-alias-bg-layer-1` 托底；当前视图指示 = 绯红 2px 下划线（Modal 内 tab 样式的平移，识别延续）。
2. **overlay 胶囊**：`--dsw-alias-bg-layer-3`（最高浮层）+ `--dsw-alias-border-l2` 描边 + 圆角胶囊；待审批计数 = 丝线金（warn 语义）；纪律告警 = 绯红**描边/文字**（禁填充）；图标用官方 `IconWarningOutline`/`IconChecklistOutline`。
3. **右侧栏 tab 内容区**：背景 `--dsw-alias-bg-base`（与宿主 tab 体一致）；卡片 `layer-1`；tab 条/分栏把/浮窗框全部宿主 chrome，不动。
4. **设置节**：完全使用宿主设置行样式（与 theme 插件的 `settings.general.item` 行同款），只提供文案与控件值。
5. **会话绑定件**：header 钮/消息动作沿用宿主按钮样式（`--dsw-alias-interactive-bg-hover` 反馈参数不变）；「登记/沉淀」弹表单用 primitives `Modal` + `RiskConfirmation`。
6. **右侧栏 guide 陷阱**：条目说明在 guide >4 条时整列不渲染（上游 `MAX_DESCRIBED_ENTRIES=4`）——关键信息只放 title，description 仅锦上添花（better-sidebar 实测）。
7. **纪律重申**：视图/表面文件禁止颜色字面量（hex/rgb/named），grep 断言进 CI；severity 五色继续走 `--silksec-sev-*`（theme/change 注入 + fallback）不变。

---

## 八、执行计划（每阶段独立提交、可回滚）

> **前置硬闸（P0 之前）**：`dashboard-rpc.js` 63 处 v4 兜底清除（5.8 审查确认的最大原子化缺口）。不完成，一切 UI 拆分都是在沙上盖楼。
> ✅ **已完成（2026-09-18，UI-0）**：`busOrThrow/busError/busQuery/busDispatch` fail-closed helper 收口 50 个业务端点，`v4 兜底` 归零；新增 `dsh-plugin-sec-suite.dashboard-rpc.test.mjs`（4/4）。详见 [PROGRESS](PROGRESS.md) §二 / §三·九。模板改动尚未部署，随 UI 包一起 rollout。

| 阶段 | 内容 | 验收 | 回滚 |
|---|---|---|---|
| **P0** 地基 ✅ 已完成（2026-09-18） | `ui-core` 包骨架（token 表/ErrorBoundary/hooks/secUiBus/视图注册表）；`ui-surface-deps.yaml` 首版；11 视图原样注册进注册表（文件不拆，行为不变） | 十一 tab 行为逐项比对现状；ErrorBoundary 注入故障演练（人为抛错只炸单面） | revert 包部署 |
| **P1** 主面板 | `ui-panel`：`main`+`panellist`+`selectPanel` 落地；footer 入口改跳转；Modal 形态保留为降级分支 | 双形态各跑一遍视图回归；`beginNavigation` 连点竞态测试 | 模式开关回 Modal |
| **P2** 审批套件 | overlay 胶囊 + 快捷浮卡 + 审批右侧栏 tab；看板「审批」tab 保留观察 | 待办计数与审批列表一致；批准/驳回快捷路径 audit 留痕与主面板路径等价；零会话下胶囊自足可用 | 单包 disable，tab 回主面板 |
| **P3** 任务 tab | 任务右侧栏 tab（四区块栏宽重排）；会话头「本会话任务」计数 | 栏宽 320–720px 响应式目检；写操作等价对照 | 同上 |
| **P4** 授权迁设置 | `settings.section`「授权范围」节；看板「授权」tab 观察一周后删 | 设置节与旧 tab 的 scope 读写逐项等价 | 单包 disable |
| **P5** 会话绑定 | conversation.view 安全产出 + header 钮 + assistant-actions 登记/沉淀 | 按 session_id 过滤正确性抽样；消息动作写操作经 RPC 全管线（actor=dashboard） | 单包 disable |
| **P6** 逐域视图拆分 | 16-dashboard 既定路线：vuln→asset→endpoint→fact→know(+学习)→report→audit 每域 `dashboard-view.js`，7 天并排观察 | 每域新旧并排等价 + audit 对照；域缺席 tab 静默隐藏 | revert 单域文件 |
| **P7** 收尾 | 删旧单体 client 与 Modal 主形态；16-dashboard 状态回填；主题规范 v4.2 落盘；accept 冒烟段固化 | 组合树无旧包；文档与实现一一对应 | — |

---

## 九、开放问题

1. **主面板 URL 直达**：`selectPanel` 是否随 URL hash 持久化（刷新回会话是可接受的官方默认，better-sidebar 证实原生布局只存内存）；如需直达链接，用 `shell.overlay` 级别自管 hash 属自绘层，待 P1 实测后定。
2. **会话内审批卡**：`conversation.chat.node` keyed 渲染器对「按工具名自定义工具调用呈现」的扩展性未验证（`dsh-agent-tool-presentation` 包存在，机制待读）；P2 期间 spike，失败则降级 `assistant-actions` 跳链。
3. **官方 Toast 服务**：primitives 导出 `Toast` 组件，是否存在跨插件 toast 服务（`ctx.toast` 类）未验证；若有，新审批到达时补一条瞬态通知（胶囊之外的增强，非关键路径）。
4. **零会话时右侧栏可达性**：右侧栏 tab 会话作用域——无会话时审批/任务深读入口由胶囊快捷浮卡与主面板降级承接，是否需要「无会话也展开右栏」待真机确认宿主行为。
5. **`ui-core` 跨包 require**：**已验证可行（P0，2026-09-18）**。`dsh-client-modules@0.1.5-rc.2` 契约：`WebBootEntry.inject` 声明「消费方物化前必须到达 factory 的包行」，`arriveGraphRow` 逐包 arrive 后消费方同步 `require` 命中；`stripClientSuffix` 使 `require('@silksec/ui-core')` 与 `.../client` 归一。落地：ui-core 独立 client bundle，sec-dashboard 在 `dsh.client.inject` 声明 `@silksec/ui-core` 后直接 require（与 theme 插件 require primitives 同路径）。已登记 [`bundles/dsh/doc/ui-surface-deps.yaml`](../../../bundles/dsh/doc/ui-surface-deps.yaml)；不采用源码并入备选。
6. **任务/审批 tab 的 badge**：`sidebarRightTabs` 的 title thunk 每次渲染重读（类型声明明示）——计数放 title 里（「审批 ·3」）即可，无需宿主 badge API。

---

## 十、与 16-dashboard 的关系（修订点清单）

| 16-dashboard 原设计 | 本文修订 |
|---|---|
| 入口 `sidebar.footer.action` → 全局 Modal（~1120px） | 入口 `sidebar.panellist` → `main` keyed 主面板；Modal 降为降级形态 |
| 十一个 tab 同居一壳 | 拆散：审批/任务 → 右侧栏；授权 → 设置节；浏览型七视图留主面板；通知 → overlay；会话绑定三处新增 |
| 壳插件单包（client 资源） | 拆为 ui-core + 五面包 + 域视图包（§5.1），故障隔离到 fiber 级 |
| 视图注册表 `secDashboardViews` | **不变**（数据层架构、RPC 投影、`{domain}.{verb}` 端点名全部沿用） |
| 30s 单一大轮询 | 按面独立轮询实例（故障隔离墙 #3） |
| 主题纪律 | 不变 + v4.2 增补七条 |

数据层（RpcProjector / 域动词 / audit / 兼容层观察期）**零改动**——本文只动呈现层。
