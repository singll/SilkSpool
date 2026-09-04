# DSH v0.1.1-rc.2 → v0.1.2-rc.1 升级方案设计

> 版本：v1.1 · 2026-09-04 ｜ 性质：**已实施——B0'/B1'/B2' 完成，B3' 观察期进行中（2-3 天）**
> 实施结果：csai 线上已运行 0.1.2-rc.1（2026-09-04 升级成功，NRestarts=0 稳定）；V1-V10 验证全过（edge token 走方案 A 零改动、157 插件 id 组合树、sec-* 全在 web+headless 树、7 preset persona 完好、spawn_worker pong、web_fetch 实测直连公网）；F-6/F-7/F-8 适配全部落地（纪律 +10/+11 条、plugin-package-inventory enabled:false 双 profile、版本钉+version-watch dist-tags.latest）。升级过程五个坑（TTY→CI→lockfile→patch 升版→projcache v3→v5）全部根因修复并回写仓库模板。
> 前置文档：`dsh-0.1.2-upgrade-arch-plan.md`（v1.2，目标当时为 alpha.1/alpha.2；其 §三/§四/§五/§六 架构优化部分 B2-B5 已执行完毕，本文只处理**剩余的 B1：DSH 本体升级**，并按 rc.1 最终 release notes 重新逐条校准）
> 升级状态：`0.1.2-rc.1` 已上 npm **dist-tag latest**（2026-09-03 发布）；GitHub 同日出现 `0.1.3-alpha.1`（2026-09-04，含破坏性 Session API 变更 + 已知性能回退）→ **本文目标锁定 rc.1，0.1.3-alpha.1 只做前瞻避让不升级**（§五）。
> 事实源：本文所有「当前系统」结论均来自 2026-09-04 对 csai `/opt/silkspool/dsh/` 的只读实查（grep 插件依赖、读 settings.yaml/edge-Caddyfile/dsh-upgrade.sh/scheduler.js、查 asset-graph.db 表结构），非文档推断。

---

## 目录

1. [版本态势与目标裁决](#一版本态势与目标裁决)
2. [0.1.2-rc.1 变更逐条影响分析](#二012-rc1-变更逐条影响分析)
3. [当前依赖面核对结论（B0 复查，已执行）](#三当前依赖面核对结论b0-复查已执行)
4. [可利用特性 → 当前流程/工具接线方案](#四可利用特性--当前流程工具接线方案)
5. [0.1.3-alpha.1 前瞻（不升级，设计须避让）](#五013-alpha1-前瞻不升级设计须避让)
6. [升级实施方案（流程+扩展验证+回滚）](#六升级实施方案)
7. [实施批次与验收标准](#七实施批次与验收标准)
8. [风险登记与开放问题](#八风险登记与开放问题)
9. [待用户决策点](#九待用户决策点)

---

## 一、版本态势与目标裁决

| 版本 | 发布 | 性质 | 对我们的意义 |
|---|---|---|---|
| **0.1.1-rc.2**（现行） | 2026-08-21 | 部署中 | csai `app/node_modules` 实测确认；setup.sh DSH_VERSION 硬钉同版 |
| 0.1.2-alpha.2~5 | 08-30~09-02 | pre-release | alpha.5 修复了「**从 0.1.1-rc.2 升级**可能启动失败/会话标题丢失」——正是我们的升级路径，已折入 rc.1 |
| **0.1.2-rc.1**（目标） | 2026-09-03 | pre-release（rc） | 0.1.2 系列首个候选版，汇总 alpha.1→5 全部变更；**npm dist-tag latest**（`dsh-upgrade.sh` 不带 `--version` 时默认即装此版） |
| 0.1.3-alpha.1 | 2026-09-04 | pre-release（alpha） | 破坏性 Session persistence API（SessionHandle/session 锁）+ Session format v2 单向迁移 + **官方声明已知性能回退** → 不作为目标 |

**裁决**：目标 `0.1.2-rc.1`。理由：① rc 质量门槛高于 alpha 且包含我们升级路径的专项修复；② 0.1.3 的破坏面（§五）在 plugins 无适配前升级必坏 `sessionPersistence` 注入链（session_id 回填/看板跳链全失效）；③ 0.1.3 自带已知性能回退。**npm 无 beta/stable 通道，rc.1 就是当前最稳的可升级终点。**

> 上次升级（0.1.1-rc.2，2026-08-23 报告）验证过的「自验证+自动回滚」机制完整保留在 `dsh-upgrade.sh`（浅冒烟 HTTP + 深冒烟 `--dump-config` grep sec-cli-adapter + 数据快照 datasnap tgz + settings-mirror-patch 重放），本方案直接复用、只加验证项。

---

## 二、0.1.2-rc.1 变更逐条影响分析

> 来源：dsh-v0.1.2-rc.1 Release Notes（GitHub 完整版，含 alpha.1→5 汇总）。
> 标注口径：🔴 必须适配 ｜ 🟡 需验证/需裁决 ｜ 🟢 直接受益 ｜ ⚪ 无关。
> 「改动范围」列给出**若要适配/利用需要动的文件**（全部为方案，未实施）。

### 2.1 新增功能（17 条）

| # | 变更 | 级别 | 对当前系统的影响 | 可利用点 | 改动范围 |
|---|---|---|---|---|---|
| N1 | 会话流默认折叠过程内容 + System prompt | 🟢 | 50min vuln 链轨迹可读性大幅提升（此前过程噪声淹没结论） | 验收观察项 | 无 |
| N2 | 会话流正文宽度自适应/拖拽 | 🟢 | 看台账 TSV/代码块更舒服 | — | 无 |
| N3 | 回答末尾显示 token 用量和耗时（可展开明细） | 🟢 | **worker 成本可观测**：与 dsh-bill 交叉对账；T-4 卡片 ROI 排行可加 token 维度 | F-4 | 无（可选：复盘任务 prompt 提一句记录用量） |
| N4 | 回合导航（覆盖完整历史，预览未载入轮次） | 🟢 | 长任务回溯（08-20 战役式会话）效率 | — | 无 |
| N5 | 统一次级文字层级/字号调节/表格缩放 | 🟢 | 主题层小收益；theme-silksong 是 patch 式主题，字号调节与其 CSS 共存性需冒烟确认 | — | 验收项（若冲突改 theme client.js 一处） |
| N6 | 插件支持在模型设置页添加提供方登录配置 | ⚪ | 我们 provider 全部 apiKeyEnv 环境变量注入，不用交互式登录 | — | 无 |
| N7 | 界面第三方语言 + 权限分类本地化 | 🟢 | settings.yaml 已设 `locale.preference: zh`，汉化更全 | — | 无 |
| N8 | **子代理模型选择：Agent 授权范围内自主选择 + 调用方指定 provider/模型/推理力度/最大输出长度** | 🟡 | 调用方指定 = 我们 P18 已反向移植（tasks 表 provider/model + spawn_worker `--patch`），零改动。**新增风险在「自主选择」**：agent 可能在 providers 列表内选 `deepseek` 直连，绕过 Bellkeeper 网关的额度/熔断/粘性/审计（LLM 路由纪律被模型自己破坏） | F-7 | settings.yaml 注释 + 验证（确认「授权范围」= providers 列表；必要时探查是否有开关收敛为仅 bellkeeper）；sec-runtime-discipline 加一条「worker 禁自主切换 provider」 |
| N9 | Python SDK runtime Windows x64 | ⚪ | Linux 部署 | — | 无 |
| N10 | ACP 补齐标准会话控制/模型设置/MCP/权限 | ⚪ | 我们不用 ACP（旧计划 #17 已 grep 确认无 ACP 调用） | — | 无 |
| N11 | **DeepSeek 官方适配器默认随请求上报已启用插件包名+版本（可关）** | 🟡 | 主力路由是 bellkeeper（openai-completions 适配器）**不受影响**；但应急直连 `deepseek` provider 时会把 sec-suite/memcore 等插件名泄露给 DeepSeek 官方 | — | F-7：settings.yaml `deepseek` 段加关闭配置（具体键名升级后从模型页确认） |
| N12 | DeepSeek 适配器可选 Session 日志增量上传（默认关） | ⚪ | 默认关 = 红线内（会话日志绝不上传厂商）。**纪律：保持关闭**，验收确认 | — | 验收项 |
| N13 | 实验性 Inspector 工具 | ⚪ | 调试用途，实验性不接 | 未来：插件/会话内部排障 | 无（观察） |
| N14 | 实验性 Web Preview | ⚪ | 实验性不接 | 未来：browser 截图证据包在线预览 | 无（观察） |
| N15 | 界面显示连接状态 + 自动重试/立即重连 | 🟢 | LAN 用户经 edge :3080 长任务断连体验改善；**与 G-1（token 问题）绑定**——edge 若失效此项收益归零 | — | 无（验收项） |
| N16 | **会话标题区域查看活动的定时计划** | 🟢 | #16/#17/#19/#37 四条 interval 链的调度状态多了个原生可视入口（此前只有看板任务 tab） | F-4 | 无 |
| N17 | **父 Agent 与可持续子 Agent `send_message` 双向传递，取代单向 `report`** | 🟡 | 我们的 worker 是一次性 headless（跑完退出、日志落盘），**不用持续子代理，不受破坏**。需确认技能/objective 无 `report` 工具引用（B0' 清单已列 grep） | F-5：T-7 凭据到位后的「人工断点」原生机制——长链任务跑成持续 worker，人经 send_message 中途下指令（P5 人工断点的 DSH 原生落地），替代目前「超时杀进程」的粗暴交互 | 暂无（设计预留，见 §四 F-5） |

### 2.2 体验优化（21 条）

| # | 变更 | 级别 | 对当前系统的影响 | 改动范围 |
|---|---|---|---|---|
| E1 | 页面启动/会话初始化开销减少 | 🟢 | 看板（105KB client.js）加载受益 | 无 |
| E2 | 会话记录磁盘占用改善 | 🟢 | sessions/ 现 73M + storages 148K，长期收益 | 无 |
| E3 | `/` 与 `@` 菜单优化（图标/目录/搜索/鼠标导航） | 🟢 | 日常 | 无 |
| E4 | 草稿时主按钮切换「发送」、消息排队 | 🟢 | 日常 | 无 |
| E5 | 文件/会话引用相邻编辑保持有效 | 🟢 | 日常 | 无 |
| E6 | 切换会话保留未提交草稿 | 🟢 | 日常 | 无 |
| E7 | 流式代码块生成期间持续高亮 | 🟢 | 日常 | 无 |
| E8 | 提问历史问答卡片（标未提交状态） | 🟢 | 日常 | 无 |
| E9 | 图片立即显示、压缩上传后台化 | 🟢 | browser 插件截图→vision_triage 流程体验 | 无 |
| E10 | 上下文压缩计入图片占用 | 🟢 | 长任务带多截图时的上下文预算更准 | 无 |
| E11 | **轨迹视图支持用户/助手/工具结果中的图片** | 🟢 | **证据复核**：CONFIRMED finding 的截图证据在轨迹直接可见，人工复核不再切目录 | 验收项 |
| E12 | 本地文件系统模式下模型可定位上传图片、`read_image` 读无扩展名附件 | 🟢 | browser 截图落盘路径即工具可读（vision_triage 喂料更顺） | 无 |
| E13 | 图片压缩策略调整（更快/更小/超长截图更清晰） | 🟢 | 全页长截图分诊质量提升 | 无 |
| E14 | 会话日志截断尾部自动修复时输出警告并注明受影响会话 | 🟢 | 历史损坏会话（0.1.1 时代产物）可诊断 | 验收顺带 |
| E15 | 插件列表按会话/全局插件分组 + Agent Preset 切换查看 | 🟢 | 9 个插件 + 7 preset 的管理可视性 | 无 |
| E16 | 会话输入界面菜单/滚动条/diff 统计 | 🟢 | 日常 | 无 |
| E17 | macOS/Linux 加载会话减少文件系统检查 | 🟢 | 39 个 sessions 头部加载提速 | 无 |
| E18 | 长会话/密集实时消息处理效率 + 内存优化 | 🟢 | interval 任务会话（数万行轨迹）渲染 | 无 |
| E19 | `web_search` 失败时报告实际端点和错误明细 | 🟢 | agent 联网检索排障 | 无 |
| E20 | 首页 logo 动画 | ⚪ | — | 无 |
| E21 | 自定义模型发现复用 Profile 请求头；模型目录支持搜索筛选 | 🟡 | bellkeeper 是自定义 provider（baseURL+显式 models 列表）：若模型发现主动探测 `/models`，Bellkeeper LLM Proxy 的 OpenAI 兼容层需能应答（一般支持）；风险低 | 验收项（设置页模型目录不报错） |

### 2.3 问题修复（18 条）

| # | 变更 | 级别 | 对当前系统的影响 | 可利用点 | 改动范围 |
|---|---|---|---|---|---|
| F1 | macOS/Linux 持久 PowerShell 启动过早 | ⚪ | Linux Bash 环境 | — | 无 |
| F2 | **Linux 持久 Bash 管道内部读取提前返回空输出** | 🟢 | **直接命中最痛的场景**：批探脚本大量管道（`xargs`/`curl |`），此前静默空输出 → 存量数据里可能混有「000 误判/假死资产」 | F-2：升级后对**存量 000/死亡结论**发起一轮复验批次（负账本 30 天有效期 + 2 出口交叉验证规则本就有——此 bug 修复等于给历史负账本平反机会） | 复验动作挂 T-5（无需改代码，方案层面登记） |
| F3 | Bash 派生大量子进程时 macOS 宿主卡顿 | 🟢 | 对应我们 `xargs -P8` 场景的姊妹修复（Linux 侧） | — | 无 |
| F4 | Windows 目录选择器编码 | ⚪ | — | — | 无 |
| F5 | 持久 Bash/PowerShell 结果无法展开 | 🟢 | 批探结果折叠区可用性 | — | 无 |
| F6 | **Profile 配置的 Agent Preset 目录在启动时丢失** | 🟡 | 7 个角色预设（recon/vuln-hunt/review/orchestrator/code-audit/biz-logic/intranet）此前可能受此影响。**关键互动**：scheduler `personaOfPhase` 读 `.agent-presets/<preset>/agent.cordis.yml` 的 persona 段 + memcore `persona_version=2` 重建机制——若此前 preset 启动丢失是「persona 收敛不生效」的部分根因，修复后首次启动可能触发一轮 preset 重建（一次性抖动） | F-3：验收时确认 7 preset persona 一致 + persona_version 机制恢复正常 | 验收项（无代码改动） |
| F7 | 无法加载的 Agent Preset 提前标记并说明原因 | 🟢 | preset 诊断改善（配合 F6 验收） | — | 无 |
| F8 | Minimal preset 移除 /goal | ⚪ | 不用 Minimal | — | 无 |
| F9 | 文件编辑工具接受未用字段 null 占位 | ⚪ | agent 工具行为小修 | — | 无 |
| F10 | PTC Mode SDK 只能经 run_code 调用 | ⚪ | 未启用 PTC（旧计划 #14 维持） | — | 无 |
| F11 | 网关 WebSocket 心跳防空闲断连 | 🟢 | edge :3080 反代长连接稳定性 | — | 无 |
| F12 | 新建空会话挤掉 Workspace 折叠列表 | 🟢 | workspace 归组（programs 1:1 workspace）展示稳定 | — | 无 |
| F13 | 系统提示词 workflow 分区顺序修复 | 🟡 | 提示词基线变化（旧计划 #6）：Shell 指南前移 → 模型用 shell 倾向可能增强。sec-pipeline 硬校验兜底，观察 2-3 天轨迹 | — | 观察项 |
| F14 | npm peer dependency 精简 | 🟢 | `pnpm install --prod` 更快、解析成本降 | — | 无 |
| F15 | Node.js 24 启动/HMR 修复 | ⚪ | 我们 Node v22.23.2 | — | 无 |
| F16 | 关闭设置窗口焦点返回 | 🟢 | 日常 | — | 无 |
| F17 | 会话运行中追加/排队图片正确回显；持续子代理后续消息支持图片 | 🟢 | 截图追加工作流 | — | 无 |
| F18 | 命令菜单 Tab 补全 | 🟢 | 日常 | — | 无 |

### 2.4 其他变更（15 条，破坏性集中区）

| # | 变更 | 级别 | 对当前系统的影响 | 改动范围 |
|---|---|---|---|---|
| C1 | SAFETY 安全说明更新（未审计、沙箱/审批/权限不保证隔离） | ⚪ | 与既有认知一致：我们的隔离靠 asset-graph.db 只读挂载 + scope-guard fail-closed 自担。口径值得在 README 引用一句（可选） | 可选：README 一句话 |
| C2 | Shell 指南稳定前移于其他工具指南 | 🟡 | 同 F13，提示词基线变化观察 | 观察项 |
| C3 | **APIProxy 移除，统一 Remote 网关** | 🔴→**已排除** | 旧计划 #1 的唯一明确破坏项。**本次 grep 实查结论：全部自研插件/脚本 0 处 `apiProxy` 引用**；sec-browser 走 Playwright `connectOverCDP(127.0.0.1:9222)`（不经 DSH 传输层）；embeddings 走 file:// 直接 import；eval-run.js 直接 import 插件模块。**无适配需求** | 无（深冒烟兜底） |
| C4 | **会话视图工程大幅拆分（面向诉求分层导入模块）** | 🔴→**已缓解** | 旧计划 #19 担心 sec-dashboard/theme import 会话视图内部模块。实查：sec-dashboard client.js 仅 `require('react')` + `require('@deepseek-ai/dsh-client-ui-primitives')`；theme 同样仅 react。**不 import 内部模块 → 拆分不直接破坏**。但 `@deepseek-ai/dsh-client-ui-primitives` 包本身的 API 表面若变动，仍会坏 → 升级后第一优先验证看板十视图与主题加载 | 验收项（必要时改两个 client.js 的 primitives 用法） |
| C5 | **网络访问 Web 界面需链接中的一次性 token** | 🔴 | **本次升级最大单点风险**（旧计划 #18）。当前 edge Caddy :3080 用 `header_up Host 127.0.0.1:3081` + Origin 改写绕 loopback 栅栏（同 settings-mirror-patch 的 `connection.isLoopback` 判定思路）。若 token 校验是**服务端 hostname 判定** → Host 改写大概率继续绕过（方案 A，零改动）；若是 TCP 对端地址判定 → LAN 免密访问失效，需方案 B/C（§六/§九） | 待 B1' 实测裁决；B 备选 = token 提取注入 edge；C 备选 = 仅 SSH 隧道 + auth-gate |
| C6 | 应用统一通过 `dsh` Profile 启动（含 Python SDK/ACP） | 🟡 | spawn_worker 调 `node bin.js --profile headless <task>`，CLI 参数面可能统一化变动。rc.1 未声明 CLI 破坏，但 headless 是我们最重的依赖（每日 4 条 interval 链全走它） | 验收项：升级后手动 spawn_worker 一次（含 provider/model 覆盖路径） |
| C7 | pi-ai 模型支持更新 + vLLM 思考预算 | 🟡 | settings.yaml providers 均显式声明 models（pool-secagent 等 id），不依赖自动列表；vLLM 不适用 | 验收项（模型页正常） |
| C8 | **Headless 运行 stderr 流式进度，stdout 只出最终结果** | 🟢 | **直接命中「失败 run 日志过少」痛点**：worker.log 从「只有头几行」变为全程序流——readWorkerResult 的 tail 20 行、grep_result/page_result 查 run_id 的价值全部提升 | F-1（无代码改动，免费）；可选把 spawn_worker tail 从 20 调大（低优先） |
| C9 | Code Mode 更名 PTC mode（旧会话可读） | ⚪ | 命名变更 | 无 |
| C10 | **默认启用公网 WebFetch（内置 SSRF 防护，免逐次审批）** | 🟡 | agent 获得一个**绕过 run_cli/scope-guard 体系**的网络读取工具：①出口不经 mubeng（真实出口 IP 直连目标域！）②不受 scope.yml 白名单管控（SSRF 防护 ≠ 授权管控）③「被动浏览公网」合规上可接受，但出口统一纪律被绕 | F-6：**保留启用**（recon 阶段查文档/JS 说明收益大），但 sec-runtime-discipline 增一条「目标域交互一律 run_cli；web_fetch 仅限非目标域公开资料」；0.1.3 后可用 HTTP_PROXY 纳入统一出口（§五） | sec-runtime-discipline SKILL.md（仓库 templates/data-seed/skills/ + seed-skills 通道下发，2 处源） |
| C11 | **移除可选 SQLite Session 持久化后端** | ⚪→**已排除** | 实查：settings.yaml 无 SQLite session 配置，sessions/ 为文件型、storages/ 148K。未启用 → 无影响 | 无 |
| C12 | Python SDK/Headless/ACP/自定义 Profile 默认提供 `web_fetch` | 🟡 | 同 C10，且**覆盖 headless worker**：定时任务的 worker 也拿到 web_fetch——纪律条必须覆盖 worker 场景（F-6 同一条） | 同 F-6 |
| C13 | Web PTC Mode 默认不提供通用 workflow 工具 | ⚪ | 未用 PTC | 无 |
| C14 | **`Session.events` 被按需读取 API（`seq`/`eventAt()`/`snapshotEvents()`）取代** | 🟡→**已核对** | 实查：我们插件只用 `ctx.inject(['sessionPersistence'])` + `sp.list()` 头部投影（scheduler.findWorkerSessionId + index.js 工作区会话清单两处），**不用 Session.events**。风险收敛为「sessionPersistence 服务本身的 list() 签名是否变动」——rc.1 未声明该服务变动（大改在 0.1.3） | 验收项：升级后跑 task_run_now 确认 session_id 回填 + 看板跳链 |
| C15 | `SessionSeq`/`SessionLogOffset` 强类型区分 | ⚪ | SDK 类型层，我们插件不触碰 | 无 |

> 逐条汇总：**🔴 3 条（C3/C4/C5），其中 C3/C4 经实查已降级为「深冒烟覆盖」，真正悬而未决只有 C5 edge token；🟡 10 条全部落入扩展验证清单；🟢 40+ 条为免费收益；⚪ 15 条无关。**

---

## 三、当前依赖面核对结论（B0 复查，已执行）

> 旧计划 §1.2 的排查清单本次全部重跑（2026-09-04，只读），结果：

| 排查项 | 结论 |
|---|---|
| APIProxy/旧传输层引用 | **0 处**（自研 6 插件 + embeddings + eval-run + browser-upstream 全 grep）→ C3 排除 |
| sec-dashboard/theme 对会话视图内部模块依赖 | **无**（仅 react + dsh-client-ui-primitives）→ C4 降级为冒烟 |
| sessionPersistence 注入点 | 恰好 2 处：`plugins/sec-suite/index.js:638`（工作区会话清单）、`scheduler.js findWorkerSessionId`（session_id 回填）→ C14 验收锚点 |
| settings-mirror-patch 脆弱点 | 补丁对象 `dsh-client-ui-settings` client.js 的 `connection.isLoopback ? "host" : "memory"` 模式串——**会话视图拆分后该串可能消失/变形**，patch 脚本 grep 不中只 warn 不失败 → 域名访问设置页会静默退化 memory。**列入扩展验证 + 失配时重定位模式串**（与 C5 token 判定同源，一荣俱荣） |
| SQLite session 后端 | 未启用（无配置）→ C11 排除 |
| HTTP_PROXY 环境变量 | `.env` 只有 SEC_EGRESS_PROXY，无 HTTP_PROXY/HTTPS_PROXY → 0.1.2 无影响；0.1.3 前瞻安全（§五） |
| spawn_worker CLI 面 | `node bin.js --profile headless [--patch model-patch.yml] <task>` + `DSH_HOME` env + detached 进程组 + workers 注册表对账——C6 验收锚点 |
| 社区插件 pin（plugins.lock） | auth-gate 0.7.2 / model-failover 0.1.4 / dsh-browser（fork 0.1.0-silksec.1）/ dsh-bill 0.13.1 → 升级后逐个加载验证；rc.1 官方推荐 oh-my-dsh `dsh-plugin-upgrade-skill` 可用于辅助复核（非官方出品，仅参考） |
| Node/pnpm | Node v22.23.2（rc.1 的 Node 24 修复不影响）；dsh-upgrade.sh 已含 `npm_config_confirm_modules_purge=false`（0.1.2-rc.1 pnpm 无 TTY 问题已修） |
| 升级路径专项 | alpha.5 修复「从 0.1.1-rc.2 升级可能启动失败/会话标题丢失」——**正是我们的路径**，rc.1 已含该修复 |
| `report` 工具引用 | **待 B1' 升级前补 grep**（技能/objective/rules 中是否有引用被 N17 取代的 report 工具；预期无） |

---

## 四、可利用特性 → 当前流程/工具接线方案

> 逐条过完 71 条变更后，真正**可接线到当前流程/工具**的共 8 项（按收益排序）。F-x 编号供后续 README 里程碑引用。

| 编号 | 特性 | 接线方式 | 改动范围 | 批次 |
|---|---|---|---|---|
| **F-1** | headless stderr 流式进度（C8） | 零改动免费收益：失败 run 排障从「无日志」变「全程序流」。验收时观察一次失败 run 的 worker.log 行数 | 无 | B1' 验收 |
| **F-2** | 管道空输出修复（F2） | **存量负账本平反**：升级后发起一轮「000/死亡结论」复验批次——此前 F2 bug 期产生的假死资产/出口重新探活，命中则复活入队。挂 T-5（egress-health 交叉验证 + 负账本 30 天规则本就要求复验，本 bug 修复给了明确触发点） | 无代码；建议新增一个 once 任务「[管道bug平反] 存量000结论复验」（走看板任务链，非脚本） | B3' |
| **F-3** | preset 目录丢失修复（F6） | 验证 memcore persona_version=2 机制在 preset 稳定加载后是否自然恢复；7 preset persona 一致性检查（此前「persona 收敛永不生效」或部分根因在此） | 无代码；若触发一次性 preset 重建属预期行为 | B1' 验收 |
| **F-4** | 会话标题区定时计划（N16）+ token 用量/耗时（N3） | 零改动：interval 链调度状态原生可视；worker 成本与 dsh-bill 交叉对账（bill_stats 对比验收）。**可选后续**：T-4 周复盘把 token 用量纳入卡片 ROI 维度 | 无（可选：#24 复盘 objective 提一句） | B1'/B3' 验收 |
| **F-5** | send_message 双向传递（N17） | **设计预留，暂不实施**：T-7 凭据到位后，长链 vuln 任务（50min 字节链）可改持续 worker + send_message 实现「人工断点」（P5 公理的 DSH 原生落地），替代现在的超时杀进程。届时改 scheduler 的 runWorker 调用模式（从 spawn 等待改为持续会话 + 注入断点指令） | 暂无（T-7 依赖 H-002；届时涉及 scheduler.js + spawn_worker 工具签名） | 不排期（登记） |
| **F-6** | web_fetch 默认启用（C10/C12） | **保留 + 纪律收口**：sec-runtime-discipline 新增一条「目标域交互一律 run_cli（scope-guard 管控）；web_fetch 仅用于非目标域公开资料查询，禁止对 scope 内资产使用」——覆盖 web 会话与 headless worker 两态。同步两处源：仓库 `templates/data-seed/skills/sec-runtime-discipline/SKILL.md` + csai `data/skills/`（走 seed-skills.sh 通道） | SKILL.md 1 个文件（2 处部署位） | B2' |
| **F-7** | 子代理自主选模（N8）+ 插件名上报（N11） | ① 纪律收口（并入 F-6 同一条纪律：「worker 禁止自主切换 provider，一律默认路由」）；② settings.yaml `deepseek` 应急段加上报关闭配置（键名升级后确认） | SKILL.md + settings.yaml（模板 2 处：仓库 templates/settings.yaml + csai data/settings.yaml） | B2' |
| **F-8** | 版本钉同步（防混版） | **升级成功后必做**（历史教训：web-boot 混版）：① `setup.sh` DSH_VERSION 从 `0.1.1-rc.2` 改 `0.1.2-rc.1`（否则下次 setup 降级）；② `dsh-version-watch.sh` 的 KNOWN 同步改 rc.1，并把版本获取从 `npm view versions [-1]` 改 `dist-tags.latest`（[-1] 会拿到 alpha 误报） | setup.sh + dsh-version-watch.sh（仓库 templates + csai 两处） | B2' |

> 明确**不接**的：Inspector/Web Preview（实验性）、ACP/Python SDK（不用）、提供方登录配置（env 注入已覆盖）、vLLM 思考预算（不适用）。

---

## 五、0.1.3-alpha.1 前瞻（不升级，设计须避让）

> 逐条过完 0.1.3-alpha.1（2026-09-04 发布）。**裁决：不升级**（破坏面 + 官方声明已知性能回退），但以下条目直接影响我们后续设计，登记避让/机会：

| 条目 | 性质 | 对我们的意义 |
|---|---|---|
| **破坏性：Session persistence API 改为生命周期持有的 SessionHandle；`agentLoop.create()` 异步；session 锁（同一 session 至多一进程持有）** | 🔴 | 直接冲击我们 2 处 `ctx.inject(['sessionPersistence'])` 用法（findWorkerSessionId / 工作区会话清单）。**避让**：升级 0.1.3 前必须重写这两处为 SessionHandle API；现在不再为 sessionPersistence 新增第三处依赖 |
| Session format 升级 v2（generation 单向迁移） | 🟡 | 0.1.2-rc.1 不涉及；将来升 0.1.3 时 dsh-upgrade.sh 的 datasnap 快照（1b 段）是回滚兜底——机制已备好 |
| **所有出站请求遵循启动环境 HTTP_PROXY/HTTPS_PROXY/ALL_PROXY/NO_PROXY** | 🟢 重大机会 | **DSH 原生出口控制**：届时 `.env` 加 `HTTP_PROXY=http://127.0.0.1:8899` + `NO_PROXY=127.0.0.1,localhost,192.168.7.0/24`（Bellkeeper 192.168.7.230、CDP 9222、mubeng、xray 全走直连，其余出站统一 mubeng）→ web_fetch/web_search 的出口直连泄露问题（F-6 纪律的硬约束化）一次解决。**现在不加**（0.1.2 不遵循，加了无效且易误配） |
| Web 上传任意类型文件 + read_image 工具卡直接渲染 | 🟢 机会 | 证据链升级：人工上传 APK/JAR/样本给 agent 直接分析；vision_triage 截图在工具卡内联渲染 |
| Web 手动暂停立即终止当前模型轮次 | 🟢 | 「停止」按钮真正即时生效（此前模型继续跑）——人工断点体验 |
| DeepSeek 流式工具调用空名修复（防「无法重新打开的会话」） | 🟡 | 若 rc.1 上出现该症状（我们走 bellkeeper openai 兼容层，未知是否波及），升 0.1.3 是解法之一——观察项 |
| FS_NOT_OBSERVED 统一诊断 / send_message steer 语义 | ⚪/🟢 | 诊断改善；F-5 的语义升级版 |
| **官方声明已知性能回退（历史 session 加载变慢）** | 阻断 | 独立不升理由 |

---

## 六、升级实施方案

### 6.1 流程（复用已验证机制 + 本次新增验证）

```
0. B0'（升级前 30 分钟补查）：
   - grep 技能/objective/rules 中 report 工具引用（N17 取代项）
   - 确认 .env 无 HTTP_PROXY（防 0.1.3 行为误开启）
   - edge token 行为的两种预案备好（§九决策点 3）
   - spool backup csai / silksec-backup 全量
1. 窗口：Beijing 05:00 后（03:00/04:00 interval 链跑完、worker_list 空）
2. 冻结：确认 scheduler.lock 持有进程无在飞 worker；task_runs 无 running
3. 升级：bash dsh-upgrade.sh --version 0.1.2-rc.1
   （自动：datasnap 快照 → pnpm install → 重启 → 浅冒烟 3081 → 深冒烟 sec-cli-adapter → settings-mirror-patch 重放）
4. 扩展验证（§6.2，本次新增 11 项）
5. 观察期 24-48h：次日双链全绿 + 成本对比
6. B2' 收尾：F-6/F-7/F-8 三项适配
```

### 6.2 扩展验证清单（新增，逐项锚定影响表）

| # | 验证项 | 方法 | 通过标准 | 锚定 |
|---|---|---|---|---|
| V1 | **edge token 行为**（C5） | 本机 `curl -H "Host: 127.0.0.1:3081" http://127.0.0.1:3081` + LAN 经 192.168.7.107:3080 浏览器访问 | LAN 免密可用（auth-gate 登录门仍在）→ 方案 A 成立；否则启动 B/C 预案 | C5 |
| V2 | **settings-mirror-patch 重放** | 升级日志确认「已补丁 N>0」；域名访问设置页可保存 | patched≥1 且域名可读写设置；失配则定位新模式串重打补丁 | C4 |
| V3 | **看板十视图 + 主题** | 打开看板全 tab + 切丝之歌主题 | 全视图渲染无白屏；primitives 无 import 报错 | C4 |
| V4 | **session_id 回填/跳链**（C14） | 看板 task_run_now 触发一个 recon 小批 → 查 task_runs.session_id + 看板历史跳链 | session_id 非空、跳链可点 | C14 |
| V5 | **spawn_worker 全路径**（C6） | 手动 spawn_worker 一次（默认模型）+ 一次（provider/model 覆盖） | 两次均 done；model-patch.yml 生效；workers 注册表对账正常 | C6 |
| V6 | **7 preset 挂载**（F6） | 插件列表 preset 切换逐一验证 | 各 preset skills/commands 按预期挂载；persona 无丢失告警 | F6/F-3 |
| V7 | **社区插件 4 个** | auth-gate 登录 / failover 状态 / bill 统计 / browser 打开一页 | 全部加载无报错 | §三 |
| V8 | **web_fetch 行为边界**（C10） | 让 agent 用 web_fetch 抓一个非目标域文档；尝试目标域 | 非目标域可用；目标域按纪律拒绝（纪律生效前人工确认行为并记录） | C10 |
| V9 | **管道批探**（F2） | xargs -P8 管道探活 10 目标 | 无空输出误判 | F2 |
| V10 | **模型页/目录**（E21/C7） | 设置页打开模型目录、切 pool-secagent | 加载无报错、models 列表正确 | E21/C7 |
| V11 | **次日双链 + 成本** | 次日 03:00/04:00 自动链 | done + 台账落行 + handoff 生成；bill_stats 与会话内 token 用量（N3）同量级 | 全局 |

### 6.3 回滚

- 任一验证失败 → `dsh-upgrade.sh` 自动回滚（已验证机制；datasnap tgz 兜底存储格式不兼容场景）
- 观察期双链连败 2 次 → 手动回滚 + 复盘
- **edge token 失效不构成回滚理由**（Web 可用性受损但挖掘链不受影响）——按 §九决策点 3 单独处置

---

## 七、实施批次与验收标准

| 批次 | 内容 | 验收 | 依赖 |
|---|---|---|---|
| **B0' 升级前补查**（0.5h） | report grep / HTTP_PROXY 确认 / edge 预案 / 全量备份 | 排查记录留档 | — |
| **B1' 升级执行**（0.5d） | dsh-upgrade.sh --version 0.1.2-rc.1 + §6.2 V1-V10 | 全绿（V1 允许带条件通过——预案裁决放 B2'） | B0' |
| **B2' 适配收尾**（0.5d） | F-6 纪律条 / F-7 上报关闭+路由纪律 / F-8 版本钉（setup.sh + version-watch）/ V1 失配时的 edge 预案实施 | 纪律经 seed-skills 通道下发；setup.sh 与线上版本一致 | B1' |
| **B3' 观察期**（2-3d） | 次日双链 ×2 / Shell 倾向轨迹观察（C2/F13）/ F-2 存量 000 复验 once 任务首发 / bill 对比 | 双链 done、无提示词行为异常膨胀、复验批次有产物 | B2' |

> 工期合计 1.5-2 个执行日 + 观察期。**不涉及**旧计划的 B2-B5（提示词去重/插件化/拆分/vault——全部已完成）。

---

## 八、风险登记与开放问题

| 风险/问题 | 等级 | 处置 |
|---|---|---|
| edge 一次性 token 使 LAN 免密访问失效（C5） | 中 | V1 实测三选一：A Host 改写继续生效（零改动）/ B token 提取注入 edge / C SSH 隧道 + auth-gate 降级 |
| settings-mirror-patch 模式串失配（C4） | 中 | V2 检测；失配时在拆分后的新模块中重定位 `isLoopback` 判定串（与 C5 同源，一次处理） |
| web_fetch 出口直连泄露真实 IP（C10） | 中 | F-6 纪律收口（软约束）；0.1.3 HTTP_PROXY 支持 = 硬约束根治（登记） |
| 子代理自主选模绕过 Bellkeeper 路由（N8） | 低-中 | F-7 纪律 + 验证「授权范围」边界；若发现配置级开关则直接收敛 |
| sessionPersistence list() 签名变动（C14） | 低 | V4 锚点验证；两处使用点已定位，失配时改动面已知（scheduler.js + index.js 各 ~10 行） |
| rc.1 pre-release 遇上游 bug | 中 | 自动回滚 + alpha.5 已含本路径专项修复；连败 2 次放弃窗口滞留 rc.2 |
| 升级触发 preset 重建抖动（F6×memcore） | 低 | 预期行为（persona_version=2 自愈路径）；V6 确认终态一致即可 |
| DeepSeek 流式空名 bug 波及 bellkeeper 兼容层 | 低 | 观察项（症状=会话无法重开）；0.1.3 是解法之一 |
| **开放问题 1**：C5 token 判定是 hostname 还是 TCP 对端 | 待 V1 | 决定 edge 零改动 vs 预案 |
| **开放问题 2**：headless worker 的 web_fetch 是否受 settings 禁用控制 | 待 V8 | 若无配置开关，F-6 纪律是唯一约束手段 |
| **开放问题 3**：N8「授权范围自主选择」是否有全局开关 | 待 B1' 探查 | 有则配置收敛为仅 bellkeeper |

---

## 九、待用户决策点

1. **是否批准本次升级窗口**（建议 Beijing 05:00 后执行，总时长 1.5-2 个执行日）——目标版本 0.1.2-rc.1。
2. **web_fetch 保留还是禁用**（C10）：建议**保留 + F-6 纪律收口**（recon 收益大、合规可接受、出口泄露属可容忍的被动浏览面）；若坚持零泄露可探查禁用路径。
3. **edge 失效预案预授权**（C5）：V1 实测若 Host 改写失效，默认走 C（SSH 隧道 + auth-gate，最简）还是 B（token 自动提取注入 edge，体验最好但多一个自研组件）？
4. **0.1.3-alpha.1 保持观望**（建议是；升级前置条件 = §五 SessionHandle 两处重写 + 官方修复性能回退）。

---

*本文档为方案设计，批准后按 §七批次执行，每批完成后更新 README.md 里程碑日志与本文档状态头。*

---

## 十、实施结果（2026-09-04，B0'/B1'/B2' 完成）

### 10.1 B1' 升级过程——五个坑全根因修复

| # | 坑 | 根因与修复 | 回写 |
|---|---|---|---|
| 1 | `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` | pnpm 11.22.0 无 TTY 清 modules 目录交互确认中止；`npm_config_confirm_modules_purge=false` 无效，实测认 **CI 变量** → `export CI=true` | dsh-upgrade.sh 模板 |
| 2 | CI=true 下 `ERR_PNPM_OUTDATED_LOCKFILE` | CI 默认 frozen-lockfile，版本切换 lockfile 必然落后 → `--no-frozen-lockfile` | dsh-upgrade.sh 模板 |
| 3 | ERR_PNPM_UNUSED_PATCH | pnpm-workspace.yaml patch 声明钉 0.1.1-rc.2 → 对 0.1.2-rc.1 的 dsh-llm-deepseek 重打 reasoning_content patch（同款 sed 修复 + git 风格 header）+ workspace 声明升版 | 部署现场（每次升版必做） |
| 4 | `StorageError: session_projcache stored version 3 != expected 5` → crash-loop | 0.1.2 存储单元格式升级 → 备份后改 unit.version 3→5；做成 **projcache_fix 幂等钩子**入升级脚本 | dsh-upgrade.sh 模板 |
| 5 | pnpm 僵死 40+ 分钟（RetryOperation 死循环） | root 属主 node_modules（8-31 手工 patch 遗留）→ EACCES 后死循环 → `chown -R silkspool:silkspool` | 部署纪律（spawn_worker 红线已有） |

### 10.2 验证结论（V1-V10 + 实测补充）

- **V1 edge token**：~~方案 A 成立零改动~~ **误判**（当日复盘推翻，见 §10.6）——验证时看到的 302 → auth-gate 登录页只是外层 auth-gate 在工作，并未穿透到原生 BrowserAuth 层；登录后即 401 `dsh web authentication required`。Host 改写只满足 trusted-hosts 栅栏，**不豁免** token/cookie 认证。开放问题 1 结论修正：栅栏判定取 hostname，认证层无 hostname 豁免。
- **V2 settings-mirror-patch**：模式串已变（`connection.isLoopback` → `ctx.remote.$host.isLoopback`，client.js:1345），手工重放 `persistence = "host"` 成功；模板改双模式（新旧串都认）。
- **插件树/服务/preset/spawn_worker/webhook/web_fetch**：157 插件 id、sec-* 双 profile 全在、7 preset persona 完好、spawn_worker pong、xray finding 入库（冒烟数据已清理）、web_fetch 实测直连公网 200。
- **V8 web_fetch 禁用开关**：0.1.2 无独立禁用配置（web+headless 两态 `fetch: true` 默认），F-6 纪律是唯一约束手段——已下发。

### 10.3 F-6/F-7/F-8 落地明细

| 项 | 落地 |
|---|---|
| F-6 web_fetch 边界纪律 | sec-runtime-discipline **第 10 条**：目标域交互一律 run_cli；web_fetch 仅限非目标域公开资料，禁对 scope 资产使用（出口直连不经 mubeng） |
| F-7 模型路由纪律 | sec-runtime-discipline **第 11 条**：worker 禁自主切换 provider；覆盖只能由派单方经 spawn_worker `--patch` 显式指定 |
| F-7 插件名上报关闭 | **plugin-package-inventory-deepseek `enabled: false`**（web + headless 双 profile cordis.patch.yml，dump-config 验证生效）。键名经探查确认：该插件由 dsh-base bundle 挂载、config 走 zod `enabled` 默认 true。N12 session-log 上报确认默认关（zod default(false)），无需动作。开放问题 3 结论：N8 无全局开关，纪律是约束手段 |
| F-8 版本钉同步 | setup.sh DSH_VERSION → 0.1.2-rc.1；dsh-version-watch.sh KNOWN → 0.1.2-rc.1 + 版本获取改 **dist-tags.latest**（curl registry 直查，替代 `npm view versions[-1]` 的 alpha 误报）；线上脚本已同步部署+冒烟（`仍最新=0.1.2-rc.1`），radar-queue 清理 5 条陈旧 dsh-new-version 事件 |
| 模板部署 | 仓库 templates 已 rsync → /opt/SilkSpool/bundles/dsh/（运行时副本） |

### 10.4 B3' 观察期任务（进行中）

- 当日 19:00 UTC（Beijing 03:00）双链 #16/#17 自动触发 = 首个观察点（次晨验收 done 状态）
- Shell 倾向轨迹观察（C2/F13）、F-2 存量 000 复验 once 任务、bill 成本对比

### 10.5 遗留登记

- F-5 send_message 人工断点：不排期（T-7 凭据依赖 H-002）
- 0.1.3 升级前置：SessionHandle 两处重写（index.js:638 / scheduler.js findWorkerSessionId）+ 官方修性能回退
- 每次升版必做：重打 dsh-llm-deepseek reasoning_content patch（ERR_PNPM_UNUSED_PATCH）+ 确认 node_modules 属主 silkspool

### 10.6 升级日复盘：C5 原生 BrowserAuth 打穿（2026-09-04 当晚修复）

**现象**：升级当晚 Web UI 报 `dsh web authentication required; reopen the URL printed by dsh web.`——LAN 经 edge :3080 登录 auth-gate 后仍被拒。

**根因**（0.1.1-rc.2 → 0.1.2-rc.1 行为变化）：
- 0.1.2 在 `@deepseek-ai/dsh-client-connection`（entry id `connection`）新增原生 BrowserAuth 层：**进程级一次性 launch token**（WeakMap，每次重启随机）兑换 **HMAC 签名 cookie**（密钥持久存于 credentials，`cookieMaxAgeDays` 默认 30 天绝对过期、不续期）。0.1.1 无此层，旧会话全数失效。
- 该层位于 auth-gate **之内**：Host 改写只过 trusted-hosts 栅栏（loopback），authorizeIndex 一律要求 `?token=` 或有效 cookie，**无 loopback 豁免**。V1 验证时 302 到 auth-gate 登录页即停，误判为"Host 改写继续绕过"。
- 升级过程中 18:32 crash-loop（projcache v3→v5，§10.1 坑 4）后的首个成功启动才首次暴露该层；18:2x 之前的进程全是 0.1.1（URL 不带 token）。

**修复**（两层）：
1. **一次性兑换**：浏览器开一次带 token 的 URL 铸 cookie（cookie 签名密钥持久，**重启不失效**，token 只是首次入口）：
   `http://192.168.7.107:3080/?token=<journalctl -u silksecagent 里最新的 token>`
   取 token 一行命令：
   `spool exec csai "journalctl -u silksecagent --no-pager _PID=\$(systemctl show silksecagent -p MainPID --value) | grep -o 'token=.*'"`
   注意：auth-gate 会话若同时过期，先登录 auth-gate 再开 token URL（auth-gate 302 的 next 只回 pathname，**会丢 query**，登录后需重开一次带 token 的 URL）。
2. **cookie 有效期 30→365 天**（避免每月复发）：`hosts/csai/dsh/cordis.patch.yml` 新增 `connection` 覆盖——`cookieMaxAgeDays: 365`；**config 按 id 整行替换，`trustedHosts: !!js ctx.webRuntime.trustedHosts` 表达式必须原样保留**（web-app bundle 口径），已 `web --dump-config` 验证生效。

**未采用**：方案 B（token 提取注入 edge）——多一个自研组件且把 auth token 烧进 Caddyfile，收益仅省每年一次的 token 兑换；方案 C（SSH 隧道）——LAN 场景无必要。

**升级脚本登记**：dsh-upgrade.sh 坑表补第 6 坑——**0.1.2+ 升级完成后 Web UI 必现一次 token 兑换提示，属预期行为**，按上式取 URL 一次性兑换即可；cookie 有效期内后续重启无需再取。
