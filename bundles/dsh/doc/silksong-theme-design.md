# 丝之歌主题（Silksong Theme）设计规范

> SilkSecAgent DSH WebUI 的全局设计规范。视觉叙事取自游戏《空洞骑士：丝之歌》。
> 本文档是所有 UI 工作的**唯一权威**：新模块、新组件、新视图一律照此组装，不得各自发明。
> 术语以 [../CONTEXT.md](../CONTEXT.md) 为准；平台总体计划见 `doc/secagent/dsh-secagent-plan-v6.md`。
>
> 版本：v4.1（2026-09-02）。v1 grill 定稿 → v2/v3 真机校准（文字/边框/背景提亮、表格定宽、KPI 可交互、打标图标化、刷新反馈、轮询只刷活跃视图）→ **v4 看板体验改造**：行内操作全面图标化（opIcon 扩展集，全部带 title 悬停）、任务视图折叠分区（工作区/执行历史默认折叠）+ 执行历史按任务过滤跳转（task_id chip）、报告查看统一 Modal 查看器 + 零依赖 markdown 渲染（React 元素树，不经 innerHTML）、显示不全修复（知识卡换行/审计详情点击展开/历史 note 全文）→ **v4.1 资产/接口/事实多维改造**：资产洞察条（评级/收录/状态 chip 可点即筛）+ 列表/域名族双模式（域名族=同注册域/同 /24 聚合，成员按需拉取防轮询膨胀）+ 单主机钻取（指纹/接口/漏洞/同族）、接口按主机分组手风琴（子维度不平铺）、事实 facet 洞察 + 搜索词高亮（丝线金）+ 关联过滤/关联最多排序。令牌全表与实现一一对应，已审计无漂移。

---

## 一、设计理念

### 1.1 两条红线（先于一切美学）

1. **实用优先**：这是一个安全作战平台，界面是工具不是展品。任何设计决策与可用性冲突时，可用性赢。
2. **不过度**：不堆动画、不堆特效、不堆装饰。点击响应贴近原生 WebUI 速度；「该有的反馈动效要有，但没有任何东西在表演」。

### 1.2 叙事四色（视觉语言的根）

从丝之歌提取四个色彩叙事，**全部颜色决策都必须能归因到其一**：

| 叙事 | 语义角色 | 意象来源 |
|---|---|---|
| **Pharloom 之夜** | 全部背景与边框 | 王国的幽暗——墨青底，不用纯黑（纯黑显得死） |
| **Hornet 绯红** | 唯一行动色（主按钮/激活态/主操作） | 主角的斗篷 |
| **丝线与铜铃之金** | 强调 / 警告 / 待确认 | 丝线、丝轴、铃铛 |
| **苔原之绿 + 石墙之青** | 成功/安全（绿）、中性信息（青） | Moss Grotto 与 Pharloom 石墙 |

**衍生铁律**：

- **全站只有绯红一个「行动色」**。金色只做强调/警告，永远不做主按钮。用户扫一眼即知「哪里能点、哪里在报警」。
- **绯红填充 = 行动；绯红文字/描边 = 危险**。同样的红，填充与否区分「要点它」与「要怕它」，互不混淆。
- **同一屏内「最强强调」的元素不超过一类**；强调服务于「下一步该干什么」，不服务于「什么好看」。

---

## 二、调色板与令牌映射

### 2.1 令牌全表（88 个，与 `dsh-plugin-theme-silksong.client.js` 的 TOKENS 一一对应，以此为准）

> 校准记录：v1 初值 → v2 文字/边框提亮 → v3 背景色阶整体抬高 + 文字/状态色再提亮 + 图片微调。

**背景层（Pharloom 之夜）**

| 令牌 | 色值 | 用途 |
|---|---|---|
| `--dsw-alias-bg-base` | `#161D22` | 最底层，墨青黑 |
| `--dsw-alias-bg-layer-1` | `#1D262C` | 卡片/面板 |
| `--dsw-alias-bg-layer-2` | `#253037` | 浮起层（hover 卡片、输入框） |
| `--dsw-alias-bg-layer-3` | `#2E3B43` | 最高浮层（Modal、菜单） |
| `--dsw-alias-bg-overlay` | `#253037` | overlay/popover |
| `--dsw-alias-bg-module-platform` | `#2E3B43` | 平台模块底 |
| `--dsw-alias-bg-multi-select` | `#2E3B43` | 多选底 |
| `--dsw-alias-bg-skeleton` | `rgba(242,238,228,0.08)` | 骨架屏（骨白的 8%） |
| `--dsw-alias-bg-mask-1` `rgba(8,12,14,0.6)`；`--dsw-alias-bg-mask-2` `rgba(8,12,14,0.2)`；`--dsw-alias-bg-mask-3` `rgba(8,12,14,0.6)` | 遮罩 |
| `--dsw-alias-bg-mask-drop` | `rgba(25,32,37,0.7)` | 下拉遮罩 |
| `--dsw-specific-sidebar-fill` | `#1A2126` | 侧边栏（介于 base 与 layer-1 之间） |

**文字层（骨白系，暖调，不用冷白——骨器/羊皮纸质感）**

| 令牌 | 色值 |
|---|---|
| `--dsw-alias-label-primary`、`--dsw-alias-label-primary-bluish` | `#F2EEE4` |
| `--dsw-alias-label-secondary`、`--dsw-alias-label-primary-dimmed` | `#C6BDAC` |
| `--dsw-alias-label-tertiary`、`--dsw-alias-label-caption` | `#9D9682` |
| `--dsw-alias-label-dimmed` | `#B0A896` |
| `--dsw-alias-label-primary-foreground` | `#161D22`（深底上的反白场景用底色） |
| `--dsw-alias-label-primary-inverted` | `#253037` |

**边框（暖灰青）**

| 令牌 | 色值 |
|---|---|
| `--dsw-alias-border-l1`、`--dsw-alias-border-l2-darkmode-thin` | `#3D474F` |
| `--dsw-alias-border-l2` | `#4A555F` |
| `--dsw-alias-border-l3` | `#5F6F7B` |
| `--dsw-alias-border-l4` | `#6E7E8A` |
| `--dsw-alias-border-inverted` `rgba(242,238,228,0.10)`；`--dsw-alias-border-inverted2` `rgba(242,238,228,0.12)` |

**Hornet 绯红（唯一行动色）**

| 令牌 | 色值 |
|---|---|
| `--dsw-alias-brand-primary`、`--dsw-alias-brand-primary-new-colorprimary-new-color` | `#C8403F` |
| `--dsw-alias-brand-text`、`--dsw-alias-brand-primary-invert`、`--dsw-alias-button-contrast-fill` | `#F2EEE4`（绯红上的骨白文字） |
| `--dsw-alias-button-primary-fill` | `#C8403F` |
| `--dsw-alias-button-primary-hover` | `#D65453`（绯红提亮一档） |
| `--dsw-alias-button-primary-dimmed` | `#2E3B43` |

**叙事四色 → 状态令牌**

| 令牌 | 色值 | 叙事 |
|---|---|---|
| `--dsw-alias-state-error-primary` `#DA5252`；`--dsw-alias-state-error-secondary` `#E55F5F` | 绯红警示变体（比 brand 亮，危急感） |
| `--dsw-alias-interactive-bg-hover-danger` | `rgba(210,72,72,0.12)` | 危险 hover 底 |
| `--dsw-alias-state-warn-primary`、`--dsw-alias-state-warn-label` | `#DDAE55` | **丝线金** |
| `--dsw-alias-state-warn-secondary` | `#E6C078` | |
| `--dsw-alias-state-warn-tertiary` | `#2A2416` | warn 底色（金的暗化） |
| `--dsw-alias-state-success-primary` `#8CAF7C`；`--dsw-alias-state-success-secondary` `#A3C193` | **苔绿** |
| `--dsw-alias-state-success-tertiary` | `#1B2418` | success 底色（绿的暗化） |
| `--dsw-alias-state-business-primary` | `#5FA39A` | **青碧**（中性信息） |
| `--dsw-alias-state-business-tertiary` | `#16211F` | info 底色（青的暗化） |
| `--dsw-alias-button-info-fill` `#4E8C84`；`--dsw-alias-button-info-hover` `#5FA39A` | info 按钮（青碧暗档） |

**交互与杂项**

| 令牌 | 色值 |
|---|---|
| `--dsw-alias-interactive-bg-hover` | `rgba(242,238,228,0.09)` |
| `--dsw-alias-interactive-bg-active` | `rgba(242,238,228,0.13)` |
| `--dsw-alias-interactive-bg-hover-accent` | `rgba(200,64,63,0.16)` |
| `--dsw-alias-interactive-bg-hover-solid` | `#253037` |
| `--dsw-alias-button-elevated-fill`、`--dsw-alias-button-floating-fill` | `#253037` |
| `--dsw-alias-button-floating-hover`、`--dsw-alias-button-ghost-active-hover` | `#2E3B43` |
| `--dsw-alias-button-ghost-active-fill` | `#253037` |
| `--dsw-alias-button-ghost-active-border` | `#5F6F7B` |
| `--dsw-alias-button-tool-bar-fill` `rgba(95,111,123,0.5)`；`--dsw-alias-button-tool-bar-hover` `rgba(95,111,123,0.6)` |
| `--dsw-alias-button-tool-bar-fill-invisible` | `rgba(25,32,37,0.4)` |
| `--dsw-alias-toast-bg`、`--dsw-alias-tooltip-bg` | `#2E3B43` |
| `--dsw-alias-scrollbar-bg-l1`、`--dsw-alias-scrollbar-bg-l2` | `#4A555F` |
| `--dsw-alias-scrollbar-hover-l1`、`--dsw-alias-scrollbar-hover-l2` | `#5F6F7B` |
| `--dsw-alias-markdown-code-block`、`--dsw-alias-markdown-code-segment-unselected` `#1A2126`；`--dsw-alias-markdown-code-block-banner` `#1D262C`；`--dsw-alias-markdown-inline-code`、`--dsw-alias-markdown-placeholder`、`--dsw-alias-markdown-tag` `#253037`；`--dsw-alias-markdown-citation`、`--dsw-alias-markdown-code-segment-selected` `#2E3B43` | 全部映射到 layer 三档，不引入新色 |
| `--dsw-specific-menu`、`--dsw-specific-bubble-highlight` | `#2E3B43` |
| `--dsw-specific-sidebar-nav-item-hover`、`--dsw-specific-input-major`、`--dsw-specific-selector`、`--dsw-specific-tip`、`--dsw-specific-bubble` | `#253037` |
| `--dsw-specific-sidebar-nav-item-active` | `#2E3B43` |
| `--dsw-specific-sidebar-nav-item-active-accent` | `#C8403F` |
| `--dsw-specific-login-input` | `#1D262C` |

**看板私有语义色（`--silksec-sev-*`，severity 五色，与叙事四色同源）**

| 变量 | 色值 | 级别 |
|---|---|---|
| `--silksec-sev-critical` | `#E55F5F` | 严重（绯红提亮） |
| `--silksec-sev-high` | `#DA8248` | 高危（朱砂橙） |
| `--silksec-sev-medium` | `#DDAE55` | 中危（丝线金） |
| `--silksec-sev-low` | `#5FA39A` | 低危（青碧） |
| `--silksec-sev-info` | `#948E7E` | 信息（石灰） |

级别色逻辑：**越危险越往红走，越安全越往青绿走**。不引入外来色。

### 2.2 令牌工程纪律

- 主题经 DSH 原生 theme registry 注册（`ctx.theme.register({ id: 'silksong', colorScheme: 'dark', tokens })`），presenter 把 tokens 以 **inline CSS 变量写到 `<body>`**——覆盖一切吃 `--dsw-alias-*` 的原生组件，**这是整站一致的官方通道，不是 hack**。
- tokens 一律写**原始 hex/rgba 值**，不引用 `--dsw-static-*`（主题的权威在令牌层，不依赖静态色板的存在）。
- 上表为**全量清单**（88 个令牌），未列出的令牌保持宿主 dark 基底原样；新增覆盖必须先加进本文档再写代码。
- `--silksec-sev-*` 不在 registry 白名单内，由主题插件在 silksong 激活时经 `<style>` 插拔注入；消费方一律带 fallback：`var(--silksec-sev-critical, #E55F5F)`。
- 同一 `<style>` 插拔还承担一项附加规则：图片 `brightness(1.07) contrast(1.07)` 微调（墨青底上的可见度，切走主题即移除，无特效无动画）。

---

## 三、形态语言（形状规范）

| 元素 | 规范 |
|---|---|
| 圆角 | 三档：**6px**（按钮/输入框等控件）/ **8px**（卡片、表格容器）/ **12px**（Modal 大容器）；pill 徽章例外用胶囊（999px） |
| 边框 | **1px 细边框是分层的主要手段**（border-l1/l2 两档明暗），对应「丝线」意象：细、精准 |
| 阴影 | **禁用投影**。层级靠背景色阶 + 细边框表达；仅 Modal 保留宿主自带遮罩 |
| hover | 只改背景色（升一档），不改边框、不位移、不放大；表格行 hover 铺 hover 底色 |
| 表格 | `table-layout: fixed` + colgroup 定列宽（ID/操作列不错位）；表头 border-l3 强分界；单元格 13px、`8px 12px` 内距、垂直居中 |
| Modal | 看板弹窗 `min(1280px, 100vw-32px)` × `min(88vh, 1020px)` |
| KPI 统计卡 | 可交互：hover 抬升边界（bg 升档 + border-l3），点击跳转对应视图；数字 20px/600 |
| 行内操作按钮 | 位置紧张时**图标化**（26×26 图标按钮，stroke 图标 + `title` 悬停提示），不打断表格密度；如打标三键：✓确认 / ✕误报 / 忽略 |

宿主原生组件的形状写死在组件里、令牌管不到——**保持原样**，靠颜色令牌融合；本规范约束的是所有自建组件。

---

## 四、动效规范（「丝滑但不过度」的量化线）

### 4.1 白名单（就这五类）

| 场景 | 参数 |
|---|---|
| hover 变色 / 点击激活态 | `150ms ease-out` |
| tab 下划线滑动 / 展开收起 | `200ms cubic-bezier(.4,0,.2,1)`（用宿主 `--ds-ease-in-out`） |
| Modal 打开/关闭 | 沿用宿主自带（不自建） |
| 新增数据行高亮渐隐 | `300ms` 背景色渐隐（唯一表意动效，可选） |

### 4.2 红线（禁止清单）

- ❌ 位移动画（slide-in、飞入）——重排重绘掉帧
- ❌ 无限循环动画（呼吸灯、流光、粒子、飘动背景）——持续占 GPU
- ❌ 弹性/回弹动画（spring/bounce，scale>2%）——与冷峻工具感冲突
- ❌ 任何超过 300ms 的过渡
- ❌ `transition: all`——只许显式列属性
- ❌ JS 驱动动画（requestAnimationFrame 做视觉）——只用 CSS transition

### 4.3 技术纪律

transition 只碰 `background-color / color / border-color / opacity`（不触发重排）；transform 仅限宿主 Modal 自带的一处。目标：任何机器上合成层完成、零布局抖动。

---

## 五、装饰元素与图标

### 5.1 装饰白名单（全站就这三处，其余一律不装饰）

| 位置 | 元素 |
|---|---|
| 侧边栏「看板」入口图标 | **丝轴 + 引出一段丝线**（SilkSpool/Silksong 双关），内联 SVG，16×16，1.5px stroke，currentColor |
| 看板标题区 | 标题旁小号丝轴徽章 + 标题下 1px 丝线分隔线（纯 CSS/SVG，无动画） |
| 各视图空状态 | 单色线稿小图标（丝轴/针），label-tertiary 色，不彩色、不插画化 |

### 5.2 禁止清单

❌ 背景纹样/水印 ❌ 位图素材（png/jpg/webp 一律不进包）❌ 角色立绘/剪影（版权+过度）❌ 任何会动的装饰。

### 5.3 图标工程纪律

一律内联 SVG：stroke 风格、`currentColor` 跟随令牌、viewBox 统一 16×16 或 24×24、stroke-width 1.5——与宿主 icons 视觉密度一致，并排不违和。

---

## 六、字体规范

- **不引入任何 webfont**（首开性能 + 中西文混排割裂，双重否决）。正文沿用宿主 `--dsw-font-*` 系统栈。
- **数据密集型内容走等宽字体**：主机名、IP、ID、时间戳、代码、evidence——用宿主 `--ds-font-family-code`（宿主已处理 Windows CJK 回退坑），内容需要字符对齐与 0/O、1/l 精确辨认。
- 字重仅两档：常规 + strong（600）。不引入更多字重。

---

## 七、强调优先级规范（突出重点）

手段按强度排序：**① 颜色（severity 红系 > 金 > 青绿）→ ② 字重 → ③ pill 描边 → ④ 透明度反向运用（降权=淡出）**。

| 元素 | 处置 |
|---|---|
| status=new 的漏洞 | 最强：行左 2px 绯红边条（待处理 > 已处理） |
| critical/high severity pill | 红/朱砂描边 + 同色文字 |
| 已定案漏洞（误报/忽略/重复） | 反向降权：整行 opacity 0.5 |
| 打标「确认」图标按钮 | hover 转绯红填充（主行动语义） |
| blocked/failed 任务 | 丝线金 / 警示红 pill |
| tentative 事实 | 丝线金 pill（「不确定的知识」需要被看到） |
| deprecated 事实 | 整卡 opacity 0.55 |
| KPI 统计卡数字 | 20px / 600 字重 + label-primary |
| 激活 tab | 绯红下划线 |
| 项目 max_risk | 中性 pill；仅 intrusive 时丝线金 |
| program_id / 来源 / 时间等参考列 | 不强调（label-tertiary） |
| 盲区指标（P8 预留） | 丝线金描边 pill「30d+」 |

---

## 八、看板交互规范（分页 / 搜索 / 筛选）

### 8.1 数据通道

- **服务端分页**：查询函数带 `offset` + 同条件 `COUNT(*)`，RPC 返回 `{ rows, total }`。
- 默认每页 **20 条**（可选 20/50/100）；排序固定**最新在前**（资产 last_seen / 漏洞 created_at / 任务 priority+created_at），不做表头自定义排序。

### 8.2 工具条（每个视图顶部，左搜索右筛选）

| 视图 | 搜索框（模糊） | 筛选下拉 |
|---|---|---|
| 漏洞 | 标题/host/url 三字段 OR | severity · status · program |
| 资产 | host | type · program |
| 事实 | fact_key + 摘要 + 正文 | category · confidence · program |
| 任务 | objective | status · phase · program |

### 8.3 交互细则

- 搜索**防抖 300ms**；改搜索/筛选页码归 1；翻页保持条件
- 工具条状态**按 tab 各自记忆**，关闭 Modal 重置
- 加载态：表格区骨架行（bg-skeleton，无动画），工具条不锁定（后发请求覆盖先发，丢弃过期响应）
- 空态双文案：「暂无数据」（库里没有）vs「无匹配结果」（被过滤掉），均配空态线稿图标
- 轮询 30s **只刷活跃视图**的当前查询（切 tab 即激活即取数）
- 「刷新」按钮：并行重取四视图，期间显示「刷新中…」并禁用防连点
- **任务历史跳转（v4）**：任务卡/队列表「🕘 历史」→ 执行历史区展开 + 按 task_id 过滤 + 滚入可视区；过滤条件以 chip 呈现在分区头，一键清除
- **折叠分区（v4）**：任务视图的工作区/执行历史为可折叠分区（▸/▾ 箭头 + 计数徽章），默认折叠，主内容（定时任务 + 队列）常开
- **报告查看（v4）**：报告 tab 点击行/👁 在 Modal 查看器打开（markdown 渲染 + 复制/下载），不在页底内嵌展示；生成报告（F3）复用同一查看器
- **资产多维（v4.1）**：洞察条 chip 可点即筛（选中升一档背景，再点清除）；列表/域名族双模式切换（右侧小按钮组）；域名族成员与单主机钻取均按需拉取（聚合总览保持轻量可轮询）；钻取面板分四区（指纹/接口/漏洞/同族），漏洞分级 chip 可跨视图跳链
- **接口分组（v4.1）**：接口是资产的子维度，按主机分组手风琴（主机行 + 方法 pill + 展开明细），路径搜索全局命中后仍按主机聚合
- **事实检索（v4.1）**：facet chip（置信/分类/有关联）+ 工具条「仅有关联」「关联最多」排序；搜索词高亮用丝线金加粗（hlText，React 元素树直构）

### 8.4 不做清单（防范围蔓延）

❌ 表头点击排序 ❌ 多选批量打标 ❌ 日期范围选择器 ❌ AND/OR 高级筛选构造器——留作扩展位，真高频再做。

---

## 九、工程形态

| 件 | 形态 |
|---|---|
| 主题插件 | 独立客户端插件 `@silksec/theme-silksong`（host 半面 no-op 供 Loader 扫描；client 半面注册主题 + 插拔 `--silksec-sev-*` + 设置行） |
| 与看板的关系 | **零耦合**：sec-dashboard 只认 `--dsw-alias-*` 与带 fallback 的 `--silksec-sev-*`；主题被禁用则看板自动回落原生配色 |
| 默认启用 | 首次加载自动 `setTheme('silksong')`；用户在内置「外观」行切走（light/dark/system）后**尊重其选择不再切回**；设置→通用里有「丝之歌主题」开关行可切回 |
| 持久化 | 宿主 user-settings 只收内置三态（light/dark/system），自定义主题选择由插件自己持久化（localStorage），加载时重放 |
| 部署 | templates/ 产物 + setup 脚本 + plugins.lock pin + 先扫后装（沿用现有插件治理） |

## 十、验收清单

- [ ] 设置→通用出现「丝之歌主题」开关；首装默认启用
- [ ] 整站（侧边栏/会话/markdown/设置页/Modal/toast/tooltip/滚动条）统一丝之歌配色，无原生蓝/原生灰残留区块
- [ ] 切回内置 light/dark 后刷新不自动切回；切回丝之歌后刷新保持
- [ ] 看板 severity 五色随主题切换跟随/回落
- [ ] 看板四视图均有工具条；分页 {rows,total} 正确；搜索防抖生效
- [ ] 全站无位移动画/循环动画/投影；transition 均 ≤300ms 且只碰合成层属性
- [ ] 数据列（host/ID/时间戳）等宽字体渲染
