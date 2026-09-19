# 19 · 看板 UI 全局统一重构（设计 + 实施规范）

> 版本：v1.0（设计 + 实施双轨，实施者必须逐条对照执行）｜ 状态：定稿待实施
> 契约版本：1 ｜ 运行基线：DSH **0.1.5-rc.2**（csai 生产）
> 上位文档：[`16-dashboard.md`](16-dashboard.md)（架构与挂点以它为准，本文只管**视觉与交互统一**）；主题令牌以 [`bundles/dsh/doc/silksong-theme-design.md`](../../bundles/dsh/doc/silksong-theme-design.md) 为准。
> 触发：2026-09-19 走查截图发现——看板新面与 DSH 原生界面**样式、元素、操作逻辑全局不统一**；主面板 8 tab 信息架构过载；统计卡片口径过时；此前实施未完全遵守 16-dashboard §四（丝之歌 v4.2）规范。
> 实施完成并验收后：本文结论回填 16-dashboard §四 与 silksong-theme-design §十一，本文移入 archive/。

---

## 〇、问题定性与根因

截图走查 + 代码核对（`bundles/dsh/templates/dsh-plugin-*.client.js`，13 个 bundle 全量）确认四类问题，且**有明确代码级根因**，不是主观观感：

### 0.1 根因：共享控件类有 className 无 CSS 规则（最严重）

下列 className 在 13 个 client bundle 中被大量使用（实测 100+ 处），但**全仓库不存在对应的 CSS 规则定义**——grep `silksec-btn{` / `.silksec-input` / `.silksec-tab` / `.silksec-kpi` / `.silksec-row` / `.silksec-dash-dialog` 全部零命中。各包的 `ensureStyles()` 只注入了少量布局类（`silksec-task-*`、`silksec-session-*`、`silksec-scope-*`），**从未定义按钮/输入/tab/KPI/行 hover 的样式**：

| className | 使用面（实测文件） | 现状后果 |
|---|---|---|
| `.silksec-btn` | ui-core(Pager/Toolbar)、ui-panel、ui-task、ui-approval、ui-session、ui-settings-scope、view-{know,fact,asset,report,vuln} | 退化为浏览器/宿主裸按钮：无主题色、无边距规范、无 hover 反馈——截图中「返回会话」「刷新」「生成报告」「批准/驳回」「新建」等文字按钮即此形态，**这是「文字按钮十分难看」的直接原因** |
| `.silksec-icon-btn` | ui-core(DocModal)、ui-task、ui-approval、ui-session、ui-settings-scope、view-{know,vuln,report,fact,endpoint} | 26×26 图标按钮无统一尺寸/hover 态；与 DSH 会话头原生图标钮视觉密度不一致（截图 2/3 右上角对比可见）|
| `.silksec-input` | ui-core(Toolbar/Pager)、ui-session、ui-settings-scope、ui-approval、view-{know,report} | 搜索框/下拉框未消费 `--dsw-specific-input-major` / `--dsw-specific-selector`，与宿主输入区（截图 2 底部输入框）明显两套 |
| `.silksec-tab` | ui-panel、view-know | 主面板 tab **无激活态样式**——丝之歌 §11.1 规定的「绯红 2px 下划线」从未落地（规则没写），截图 1 中 tab 无选中特效即此 |
| `.silksec-kpi` | ui-panel | KPI 卡无 layer-1 托底、无 hover 升档——丝之歌 §三「KPI 统计卡」形态未实现 |
| `.silksec-row` | ui-core、view-{know,asset,vuln,report,endpoint,audit}、ui-task | 表格行无 hover 铺底（丝之歌 §三「表格行 hover 铺 hover 底色」未落地）|
| `.silksec-dash-dialog` | ui-core、ui-approval、ui-session、ui-settings-scope | primitives.Modal 缺失时的自绘弹层无统一容器样式 |

**结论**：16-dashboard §四 与 silksong-theme-design §11.7 只规定了「零颜色字面量」（已做到），但**没有规定「共享控件类必须有唯一 CSS 定义源」**——执行者用了 className 约定却没人写规则，这是「执行的人并没有完全按照之前的设计遵守」的制度性漏洞。本文 §五 给出封堵机制。

### 0.2 主面板缺会话页 chrome（结构性）

DSH 会话页顶栏（截图 2/3：会话标题 + `对话/轨迹/费用/安全产出` ViewTab + 右上角 …/↪/ⓘ/☰）由宿主渲染；而 `main` keyed 槽的主面板（截图 1）**是裸容器**——宿主不为其渲染标题栏与右上角操作组。看板自己在内容区里补了「安全看板 + 返回会话/刷新」文字按钮（用未定义的 `.silksec-btn`），与会话页骨架完全不像。

### 0.3 信息架构过载

主面板 8 个 tab（漏洞/资产/接口/事实/知识/学习/报告/审计）+ 顶部 6 KPI + 双告警条，挤在一条自绘 tabBar 里。审批/任务/授权已在 16-dashboard 移到右侧栏/设置页，但**知识、学习、报告、审计四个低频浏览面仍占一级 tab**，违反本文 §三的频次分层。

### 0.4 统计卡口径过时

当前 6 卡（漏洞 61 / 资产 96814 / 接口 357 / 工作区 3 / 任务 42 / 事实 873）是 v4 时期的「库存量」口径，且数据源 `case 'stats'` 仍走 `deps.assetDb.stats()` 直查壳（16-dashboard §1.6 允许的唯一例外）。v6 后高频待办是：审批待办、漏洞待处理（new）、待验证候选、阻塞/失败任务、纪律告警——**库存量不是操作者每天要看的数字**。

---

## 一、全量元素盘点（统一前的清单真相源）

> 盘点方法：对 13 个 client bundle 逐文件 grep（className / el('button') / el('select') / el('input') / primitives 消费），下表数字为实测出现次数。

### 1.1 按钮（≈50 处）

| 类别 | 现状 | 实例 |
|---|---|---|
| 文字按钮 `.silksec-btn` | 无样式 | 返回会话、刷新、生成报告、新建、收起、关闭、批准、驳回、登记候选漏洞、沉淀事实、‹上一页/下一页›、✕清除过滤 |
| 强调文字按钮 `.silksec-btn-confirm` | 无样式 | 批准、创建周期任务、登记候选漏洞/沉淀事实 |
| 图标按钮 `.silksec-icon-btn` | 无样式 | 打标三键（✓✕👁）、任务行五键（▶⏸✏🕘■）、DocModal 复制/下载/关闭、会话头三键 |
| 危险图标按钮 `.silksec-icon-btn-danger` | 无样式 | 取消任务、驳回 |
| pill 伪装按钮（style 内联 pill+cursor） | 内联样式各写一份 | 待验证候选 chip、洞察条 chip、facet chip |
| 原生 primitives | 正常吃主题 | Tooltip、Modal、RiskConfirmation、HoverCard、Pill、StateDot、DisclosureRow、Icon*（仅此一类与原生一致）|

### 1.2 表单（≈25 处）

| 元素 | 现状 | 实例 |
|---|---|---|
| 文本输入 `.silksec-input` | 无样式 | 各视图搜索框、周期分钟输入、授权条目输入 |
| 下拉 `.silksec-input`（select）| 无样式 | severity/status/program/每页条数筛选 |
| 选项卡 `.silksec-tab` | 无样式（含无激活态）| 主面板 8 tab、知识视图内 tab |
| 开关/胶囊 | 主题插件自写一份（SilksongRow）| 设置→通用「丝之歌主题」|

### 1.3 展示件

| 元素 | 现状 |
|---|---|
| KPI 卡 `.silksec-kpi` | 无样式（label + 20px/600 数字直接堆叠，无卡片托底）|
| 表格（styles.th/td/tableStyle + `.silksec-row`）| 结构有 token，行 hover/选中态无规则 |
| pill `styles.pill` + sevPill/statusPill | 已统一（ui-core 唯一来源，token 完备）|
| 空态/骨架 EmptyState/SkeletonRows | 已统一 |
| 弹层 DocModal / `.silksec-dash-dialog` 兜底 | Modal 存在时一致；兜底无样式 |
| 页面骨架 styles.root/header/pageT/silkDivider | 仅 ui-panel 与部分视图使用，右侧栏/会话面各自另写 padding |
| 图标 opIcon/spoolIcon + primitives Icon* | 双轨：自绘 SVG 与官方图标混用，密度基本一致 |

### 1.4 入口与导航

| 入口 | 现状 | 问题 |
|---|---|---|
| 侧边栏 panellist「看板」行 | spoolIcon 图标 + 文字「看板」 | 与工作区/会话条目比多了一个抢眼图标；「看板」名称与「工作区」语义层级不符 |
| 主面板页头 | 丝轴徽章 +「安全看板」标题 + 副标题 + 丝线分隔线 + 返回会话/刷新文字钮 | 副标题（漏洞/资产/任务/知识/授权/审计）未含新面（接口/事实/报告）；两个文字钮难看且会话页无此物 |
| overlay 审批胶囊 | 自绘胶囊（layer3 描边）| 合格，保留 |
| 右侧栏审批/任务 tab | 宿主 chrome | 内容区行内按钮同样吃 0.1 根因 |

---

## 二、统一设计系统（UI Kit v1）

### 2.1 唯一来源纪律（新增，封堵 0.1 根因）

**所有 `.silksec-*` 共享控件类的 CSS 规则，唯一合法定义源 = `@silksec/ui-core` 的 `ensureBaseStyles()`**（新增，apply 时一次性注入，幂等守卫 `data-plugin-css="silksec-ui-core-base"`）。各承载面/视图包的本地 `ensureStyles()` **只允许布局类**（flex/grid/container-query/高度），禁止定义任何颜色、边框、圆角、按钮、输入、tab 样式。颜色仍零字面量（规则里全部 `var(--dsw-alias-*)`）。

### 2.2 控件规格表（全部消费既有令牌，零新色值）

| 控件 | 规格（全部进 ui-core 基样式表）|
|---|---|
| `.silksec-btn`（默认/次级）| 高 28px；padding `0 12px`；圆角 6px；`F.xs`；fill=`--dsw-alias-button-elevated-fill`，color=`--dsw-alias-label-secondary`，border=`1px solid --dsw-alias-border-l2`；hover：fill→`--dsw-alias-button-floating-hover` + color→`label-primary`；disabled：opacity .45 + 禁指针；transition 150ms ease-out 仅 background-color/color/border-color |
| `.silksec-btn-confirm`（主行动）| 同骨架；fill=`--dsw-alias-button-primary-fill`（绯红 #C8403F），color=`--dsw-alias-button-contrast-fill`，border=transparent；hover→`--dsw-alias-button-primary-hover` |
| `.silksec-icon-btn` | 26×26；圆角 6px；fill=transparent，color=`--dsw-alias-label-secondary`，border=1px transparent；hover：fill=`--dsw-alias-interactive-bg-hover` + color=`label-primary`；SVG 16×16 stroke 1.5 currentColor（opIcon 已合规）|
| `.silksec-icon-btn-danger` | 同骨架；color=`--dsw-alias-state-error-primary`；hover fill=`--dsw-alias-interactive-bg-hover-danger` |
| `.silksec-input`（input/select 共用）| 高 28px；padding `0 10px`；圆角 6px；fill=`--dsw-specific-input-major`；color=`label-primary`；border=`1px solid --dsw-alias-border-l2`；focus：border-color=`--dsw-alias-brand-primary`（无 outline 环）；placeholder=`label-tertiary` |
| `.silksec-tab` | 高 32px；padding `0 10px`；`F.xs`；color=`label-secondary`；hover color=`label-primary`；`[data-on="true"]`：color=`label-primary` + `box-shadow: inset 0 -2px 0 var(--dsw-alias-brand-primary)`（**绯红 2px 下划线，对齐丝之歌 §11.1 与截图 2 会话页 tab 选中态**）；下划线过渡 200ms `var(--ds-ease-in-out)` |
| `.silksec-kpi` | fill=`--dsw-alias-bg-layer-1`；border=`1px solid --dsw-alias-border-l1`；圆角 8px；padding `10px 14px`；text-align left；hover：fill→`layer-2` + border→`border-l3`（丝之歌 §三 KPI 卡「hover 抬升边界」）；内部 label `F.xxs label2` + 数字 20px/600 `label-primary`（沿用 styles.cardL/cardV）|
| `.silksec-row` | tbody 行 hover：background=`--dsw-alias-interactive-bg-hover`（150ms）；已定案行 opacity .5 逻辑保持在视图内（已有）|
| `.silksec-chip` | pill 骨架（styles.pill）；`[data-on="true"]`：background=`--dsw-alias-interactive-bg-active`；cursor=pointer 仅本类携带 |
| `.silksec-dash-dialog` | Modal 兜底容器：fill=`--dsw-alias-bg-layer-3`；border=`--dsw-alias-border-l2`；圆角 12px；遮罩无对应别名令牌时允许唯一例外写 rgba（登记进主题文档 §十一增补）|

### 2.3 文字按钮 vs 图标按钮的分工（统一操作语义）

| 场景 | 形态 | 依据 |
|---|---|---|
| 表格行内操作（密度优先）| **图标按钮** + title/aria-label + Tooltip | 丝之歌 §三「行内操作按钮图标化 26×26」；打标三键、任务五键保持 |
| 工具条/页头/表单提交（语义优先）| **文字按钮**（`.silksec-btn` / `-confirm`）| 批准/驳回、生成报告、新建、登记候选漏洞——文字表意不可替代，但必须有 2.2 的样式 |
| 危险动作 | `-danger` 变体 + 写操作必经 `withBusy`（16 §1.5 纪律不变）| 取消任务、驳回 |
| 跳链（打开来源会话/打开看板）| 图标按钮（opIcon jump）| 已是图标，统一进 icon-btn 规格 |

**禁止第三形态**：pill 伪装按钮（chip 可点筛）归入 `.silksec-chip` 语义；视图内联 style 里的 pill+cursor 散写全部删除。

### 2.4 命名与页头

| 项 | 现状 | 改为 |
|---|---|---|
| panellist 行 label | `看板` | **`安全中心`**（与「工作区」平级的空间语义；CONTEXT.md 同步登记术语：安全中心 = 全局安全态势主面板；「看板」保留为内部代号）|
| panellist 图标 | spoolIcon（自绘丝轴）| 保留（装饰白名单已批准此一处，丝之歌 §5.1）；active 色走 `--dsw-alias-brand-primary` 不变 |
| 主面板标题 | 「安全看板」+ spoolIcon 徽章 | 「安全中心」，保留丝轴徽章 + 丝线分隔线 |
| 副标题 | `全局安全态势 · 漏洞 / 资产 / 任务 / 知识 / 授权 / 审计` | `全局安全态势 · 漏洞 / 资产 / 接口 / 事实 / 知识 / 报告 / 审计`（与 tab 实际集合一致）|
| 页头右操作 | 「返回会话」「刷新」两个裸文字钮 | **图标按钮**：返回=新增 opIcon('back')（左箭头），刷新=新增 opIcon('refresh')（圆弧箭头）；title/aria-label 保留原文案 |

### 2.5 会话 chrome 对齐

主面板是 `main` keyed 槽裸容器，宿主不渲染会话页顶栏——**不自绘仿真顶栏**（生态调研结论：自绘 = 短寿命）。对齐策略：

1. 页头行（标题 + 图标钮组）作为「安全中心自有 chrome」定型，视觉规格与宿主会话头对齐：高 40px、`F.baseStrong` 标题、右侧 26×26 图标钮组、底部 `border-b border-l1`。
2. 右上角其余宿主件（…/↪/ⓘ/☰）是**会话域功能**，主面板没有对应语义，不放——缺失是合理的，不算不一致。
3. 「返回会话」保留为主面板特有导航件（会话页没有"离开会话"的需求，主面板有）。

---

## 三、信息架构：tab 收敛（融入 DSH 原生逻辑）

### 3.1 生态依据（16-dashboard §2.7 结论的运用）

DSH 插件生态（better-sidebar、dsh-bill 等）验证过的长寿路线只有一条：**官方槽位注册 + 按频次分层**。操作逻辑统一 = 用户形成的肌肉记忆只有三套：侧边栏导航（去哪里）→ tab（看哪类）→ 行内/工具条（做什么）。看板不得发明第四套（旧 Modal、自绘浮层均已被判死刑：better-sidebar 自绘面板在官方右侧栏推出后主动删除迁入；dsh-bill 抢占 chain 槽遮官方卡片是事故教训）。

### 3.2 频次分层与 tab 收敛方案

按实测使用频次把 8 tab 分两层：

| 层 | tab | 处置 |
|---|---|---|
| 一线（每日操作面）| 漏洞、资产、接口、事实 | **保留一级 tab** |
| 二线（低频浏览/管理面）| 知识、学习、报告、审计 | **收敛为一个「更多」tab**（order 100），点击进入后二级导航（左内联子 tab 条，样式同 `.silksec-tab`，缩一档 `F.xxs`）切换四个视图 |

实现要点：

- `viewRegistry.register` 的 entry 增加可选 `group: 'primary' | 'more'`（缺省 primary）。知识(order 70)/学习(75)/报告(80)/审计(110) 四个包改注册 `group: 'more'`。
- ui-panel 渲染：tabBar = primary 四个 + 「更多」；选中「更多」时 body 顶部渲染二级 tab 条（知识/学习/报告/审计），内部再渲染 active 子视图。二级选中态沿用 data-on 下划线。
- 「更多」条目本身带当前子视图名（如「更多 · 审计」），避免迷失。
- 跨视图跳链（`navigate('knowledge')` 等）兼容：navigate 接收任意注册 id，属 more 组时自动展开二级并选中——**跳链语义不变**（16 §1.2 协议向后兼容）。
- viewRegistry 协议变更属 ui-core minor 版本：旧视图包（无 group 字段）全部落入 primary，行为与今天一致——升级顺序无要求。

> 否决项（记录防回潮）：一、把四个低频面再塞进右侧栏——右侧栏是待办/操作面，浏览型宽表进不去（16 §1.3 表已论证）；二、恢复 Modal——已删，不回头；三、自绘命令面板——DSH 无此官方槽，属自绘短寿命路线。

### 3.3 审批/任务/授权（已归位，仅样式收敛）

不动挂点，只把行内按钮/输入收敛到 §2.2 基样式：审批浮卡「批准/驳回」→ `.silksec-btn-confirm` / `.silksec-btn`（className 不变，获得样式）；任务卡五键已是 icon-btn，获得样式后与原生会话头图标钮密度一致。

---

## 四、统计卡重设计（核心常用数字）

### 4.1 设计原则

从「库存量」改为「**今日待办 + 风险暴露**」：操作者打开安全中心的第一眼问题应该是「有什么要我处理的」，不是「库里有多少东西」。库存量下沉为卡片副行。

### 4.2 新 KPI 卡（5 张，全部可点击跳链）

| 卡 | 主数字 | 副行（label-tertiary）| 点击跳链 | 数据源（查询，禁直查表）|
|---|---|---|---|---|
| **待审批** | `approval.list(status=pending)` 计数 | 最老一条等待时长 | `secUiBus.emit('open:approval')` + 开右侧栏审批 tab（无会话时降级主面板）| `approval.list` |
| **待处理漏洞** | `vuln.list(status=new)` total | 其中 critical+high 数（>0 时丝线金/绯红着色）| 主面板 findings + 预置 status=new 筛选 | `vuln.list` |
| **待验证候选** | `vuln.list(noise=1)` total | 评测回流 n 条判定 | findings + noise=1 | `vuln.list` |
| **运行中/阻塞任务** | `task.stats` running + blocked（blocked>0 时数字丝线金）| 24h 内失败数 | `open:task` 右侧栏任务 tab | `task.stats` |
| **纪律告警** | `ledger.discipline_stats` alerts 数（0 = 苔绿 ✓）| 首条告警摘要（title 全文）| 主面板 → 更多·审计 | `ledger.discipline_stats` |

### 4.3 库存量副条

KPI 卡行下方一条 `F.xxxs label-tertiary` 文本行：`库存 · 漏洞 61 · 资产 96,814 · 接口 357 · 事实 873 · 工作区 3`（千分位；各项可点击跳对应 tab）。资产/接口这类大数不再占卡片位。

### 4.4 壳端点改造

`case 'stats'`（dashboard-rpc.js）从 `deps.assetDb.stats()` 直查改为**壳聚合查询**：`vuln.list`（new / noise 计数）+ `approval.list`（pending）+ `task.stats` + `ledger.discipline_stats` + `asset.overview`（库存副行）——沿用 16 §1.6 不变量：任一来源失败 → 该指标 null + `degraded:[域]`，卡片渲染「—」。`assetDb.stats()` 直查随之删除（INV-D6 口径收紧：壳聚合端点连 stats 也不再直查表）。

---

## 五、实施规范（防再次漂移的机制）

### 5.1 实施分相（每相独立可验收、可回滚）

| 相 | 内容 | 触及文件 | 验收 |
|---|---|---|---|
| **U1 基样式表** | ui-core 新增 `ensureBaseStyles()`：§2.2 全部控件类；apply 时注入 | `dsh-plugin-silksec-ui-core.client.js` | 无头冒烟：`.silksec-btn` computed fill 消费令牌生效；grep 断言规则只此一份 |
| **U2 面板 chrome + IA** | 改名安全中心（panellist label + 页头标题 + 副标题）；页头文字钮→图标钮；新增 opIcon('back'/'refresh')；KPI 改 5 卡 + 副条（§四）；tabBar 收敛 + 二级导航（§3.2）；viewRegistry 加 group | ui-panel、ui-core（registry/opIcon）、4 个低频视图包注册参数 | 截图对比：tab 选中绯红下划线出现；KPI 卡 hover 升档；「更多」二级导航工作；旧跳链 id 全部可达 |
| **U3 视图收敛** | 删除各包内联 pill+cursor 散写（→ `.silksec-chip`）；各包本地 ensureStyles 只留布局类；settings-scope/session/approval/task 行内按钮核对 §2.3 规格 | 9 个包逐文件 | grep：视图文件无 pill+cursor 散写；零颜色字面量断言保持通过 |
| **U4 stats 聚合** | dashboard-rpc `case 'stats'` 改壳聚合（§4.4），删 `assetDb.stats()` 直查 | `dsh-plugin-sec-suite.dashboard-rpc.js` | 单域查询失败 → 对应卡片「—」+ degraded，不整体失败 |

执行顺序：U1 先行（无依赖），U2/U3 同批可发，U4 与 U2 的新卡片字段名耦合——同 PR 落地，或 U4 先行时 UI 侧带字段缺省降级（渲染「—」）。

### 5.2 防漂移机制（本次新增，CI/评审双重断言）

1. **类定义唯一性 grep 门禁**（进 `sec-v5-accept.sh` UI 段）：
   - 规则类（`.silksec-btn|icon-btn|input|tab|kpi|row|chip|dash-dialog`）的 CSS 定义**只允许出现在** `dsh-plugin-silksec-ui-core.client.js`；其他 12 个 bundle 出现这些选择器的定义（区别于 className 使用）即失败。
   - 反向断言：所有被使用的 `.silksec-*` className 必须在 ui-core 基样式表或本包布局类白名单中有定义——脚本提取 className 字面量集合，减去（基样式选择器 ∪ 本包布局类），差集非空即失败。
2. **颜色字面量断言**（已有，保持）：视图/表面文件禁 hex/rgb；基样式表规则里只允许 `var(--dsw-*)` / `var(--silksec-sev-*)` / `var(--ds-*)` 与 transparent 关键字（dash-dialog 遮罩例外须登记）。
3. **评审三问**（进评审清单）：新增任何 UI 元素前回答——一、用 ui-core 哪个控件类？二、没有就先加进基样式表（同 PR）？三、操作语义属于 §2.3 哪一行？答不出 = 设计缺失，不许写。
4. **视觉验收截图**：每相落地后在 csai 截 4 张对比图（主面板/会话页/右侧栏任务/审批浮卡）**贴进本文 §六 验收清单（专项记录随本文走）**，与清单逐项对照；收尾仅在 [PROGRESS.md](PROGRESS.md) 记一行结果。

### 5.3 与既有纪律的关系

- 16-dashboard §1.5 调用纪律（withBusy/信封三元组/replay 提示/operator 不伪造）**不变**——本文只管视觉与 IA，不碰数据链路。
- 丝之歌 §四 动效红线、`transition` 白名单、§五 装饰白名单**不变**——§2.2 规格全部在其约束内。
- viewRegistry 加 `group` 是协议 minor 变更，须同步 `ui-surface-deps.yaml`（挂点清单不变，标注协议版本）。

---

## 六、验收清单

- [ ] 全站 `.silksec-btn/-confirm/icon-btn/-danger/input/tab/kpi/row/chip/dash-dialog` 有且仅有 ui-core 一份 CSS 定义；截图中不再出现裸按钮
- [ ] 主面板 tab 选中态 = 绯红 2px 下划线 + 200ms 过渡；与会话页 tab（对话/轨迹/费用/安全产出）选中视觉同族
- [ ] panellist 与页头显示「安全中心」；副标题与 tab 集合一致；页头操作 = 图标按钮（返回/刷新）
- [ ] 主面板一级 tab = 漏洞/资产/接口/事实/更多；「更多」内二级导航 = 知识/学习/报告/审计；旧跳链 id 全部可达
- [ ] KPI = 待审批/待处理漏洞/待验证候选/运行中·阻塞任务/纪律告警 五卡 + 库存副条；点击跳链正确；单域失败降级「—」
- [ ] 搜索框/下拉与宿主输入区（会话底部输入框）同 token 族（input-major 底、l2 描边、绯红 focus）
- [ ] 批准/驳回、生成报告、登记候选漏洞等文字按钮呈现 elevated/primary 规格；行内操作全部 26×26 图标钮
- [ ] 丝之歌主题关闭 → 内置 dark：全部新样式自动回落（零 silksec 专属色，只消费 --dsw-alias-*）
- [ ] `sec-v5-accept.sh --ui-headless` 通过（含 5.2 新增两条门禁）
- [ ] 主题文档 §十一 增补基样式表清单；CONTEXT.md 登记「安全中心」术语；本文结论回填 16-dashboard 后移入 archive/，并在 [PROGRESS.md](PROGRESS.md) 记一行结果

---

## 七、与相邻文档的关系

| 文档 | 关系 |
|---|---|
| [16-dashboard.md](16-dashboard.md) | 架构/挂点/数据链路以上位为准；本文结论验收后回填其 §四（视觉统一口径）|
| [silksong-theme-design.md](../../bundles/dsh/doc/silksong-theme-design.md) | 令牌与形态语言真相源；§2.2 全部规格是其既有令牌的组合，零新色值；基样式表清单增补进其 §十一 |
| [ui-surface-deps.yaml](../../bundles/dsh/doc/ui-surface-deps.yaml) | 挂点清单不变；viewRegistry `group` 协议变更同步登记 |
| [PROGRESS.md](PROGRESS.md) | 只记一行落地结果；本相的详细记录与验收截图随本文，验收后一并归档 |
| [`bundles/dsh/CONTEXT.md`](../../bundles/dsh/CONTEXT.md) | 「安全中心」术语登记处（看板 = 内部代号保留，UI 文案一律安全中心）|
