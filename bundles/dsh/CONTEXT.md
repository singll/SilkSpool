# SilkSecAgent 领域语言 / Domain Language

> SilkSecAgent（DSH + pi）授权范围内漏洞发现平台的统一术语表。
> 当代码、文档或对话使用这些词时，含义以此为准。实施细节见 `doc/secagent/silksecagent-system-complete.md`（系统全景，以运行代码为真相源）。

## 核心实体

**Workspace（工作区）**：
DSH 自带的工作区（`ctx.workspaceRegistry`：目录 + 会话组 + 文件），是「项目」的**用户可感唯一概念**——开会话、存文件、沉淀上下文都在这里。与 Program 1:1 映射（`programs.workspace_id`）。
_Avoid_: 不要在工作区之外另立「项目」UI 概念。

**Program（授权项目）**：
SRC/HW 授权项目，真相源是 `scope.yml` 的 `program.name`，是 scope-guard 的授权主体与资产/漏洞/事实/任务的数据外键。UI 上降级为工作区的徽章属性，不单独呈现。新建工作区 ≠ 自动授权（fail-closed 不变）。
_Avoid_: 项目之外勿用「目标」「客户」。

**Task（任务）**：
编排器派发的可治理工作单元，带队列/优先级/依赖/预算/人工断点；**带调度字段（schedule_kind/run_at/every_seconds/next_run_at）的 Task 即定时任务**——同一张表、同一状态机。属于某个 Program，由某个 Run 或 worker 执行。
定时任务是一行**固定实体**（P12）：interval 任务跑完 latest-only 自动续期，同 program+objective 幂等去重，严禁「每天重建 once 任务」；每次运行落 `task_runs` 执行历史（每任务保留最近 200 行）。看板任务 tab 四区块：工作区（默认折叠）/ 定时任务卡片 / 一次性任务队列 / 执行历史（默认折叠）；任务卡与队列表的「🕘 历史」**跳转**到执行历史区并按 task_id 过滤（chip 可一键清除）。
_Avoid_: 会话内易失的 goal/plan/todo 不是 Task。

**Run（执行）**：
一次工具执行（`run_cli` / `spawn_worker` / `authz_diff`），全量落盘 `results/<run_id>/`，记 `session_id`（谁跑出来的可回溯）。属于会话，是「某条会话干了什么」，不是全局治理对象。
_Avoid_: 不要把 Run 当成第一公民实体进全局面。

**Finding（漏洞）**：
一条发现的漏洞/风险，带状态机 new→confirmed→false_positive/submitted→accepted/dup/ignored。
_Avoid_: 报告、issue。

**Asset / Endpoint（资产 / 接口）**：
侦察到的资产主机与接口。Endpoint 是 Asset 的子维度。

**Fact（事实）**：
跨会话沉淀的一条知识，格式 `category/slug`，带 summary（注入 prompt 的索引）+ body（按需拉取）+ confidence。落在事实图谱 `facts` + `fact_edges`。带生命周期维度 mem_class（durable 30 天复验 / ephemeral TTL 14 天 / timeline 30 天归档），note 类缺省 ephemeral=工作速记滚动消亡，长期知识写 target/asset/finding 等分类。列表/计数走同一可见域谓词（archived/timeline/过期 ephemeral 排除）。
_Avoid_: 黑板、note、key:value。

**Blackboard（黑板，环境层）**：
v4.6 后收敛为**纯环境层**存储：[env-issue] 环境问题、timeline 事件流、全局广播；**不再承载业务快照**——alive/scan/recon/review/note:/todo/plan 等快照前缀键会被 memcore sweep 守卫自动转写为 facts（fact_key=`bb/{键}`，ephemeral 14d）并归档原键，防旧习惯回潮。`blackboard_set/get` 是黑板的常规读写工具（写 blackboard 表，ephemeral/timeline 双类），业务事实一律走 fact_upsert。

**Scope（授权范围）**：
`scope.yml` 白名单，fail-closed 硬校验，是平台的安全红线。新授权域名的入口是审批中心（整域走 scope-wildcard kind（`*.x.com + x.com` 双条目）、单子域走 scope-domain kind，批准即原子写回 scope.yml 并自动入队首轮资产收集种子任务）；排除清单内域名的重新收口走 exclude-exception kind。

**报告（Report）**：
findings 的导出产物，`report-{program}-{YYYYMMDD-HHmm}.md` 语义化文件名，按项目分节，支持 severity 多选/source 筛选生成；列表按项目分组可筛。

## UI 信息架构

**全局面（global surface）**：
跨会话持久的平台状态 UI（资产/漏洞/事实/任务等），不随某条对话变化。
_Avoid_: 别挂在会话标签页下。

**会话面（session surface）**：
跟某一条对话绑定的 UI（消息 / Trajectory / Run）。

**看板（Dashboard）**：
全局面的正式名称，侧边栏全局入口 → 独立模态面板，内含「漏洞 / 资产 / 接口 / 事实 / 任务 / 知识 / 报告 / 审批 / 授权 / 审计」视图（任务视图四区块：工作区折叠区、定时任务卡片区、一次性任务队列、执行历史折叠区，历史可按任务过滤跳转；授权视图管理 scope.yml；报告在 Modal 查看器中阅读）。资产视图双模式：**列表**（评级/收录/状态多维筛选 + 单主机钻取：指纹/接口/漏洞/同族）与**域名族**（同注册域 / 同 /24 网段聚合，呈现资产间联系；成员按需拉取）；接口视图按主机分组（接口是资产的子维度，不做平铺千行）；事实视图 facet 洞察（置信/分类/有关联/生命周期 chip）+ 搜索词高亮 + 关联最多排序 + 默认隐藏 note 工作速记（「工作速记」开关开启）；报告视图按项目分组 + 项目/关键字筛选；知识视图 v4.6 重设计：顶部知识体检卡（各存储点 count/零使用占比/到期预警）+ 六类型知识全景图（经验/事实/文献/规程/任务内/环境——一类一位一工具 + 开局三步检索顺序 fact→exp→kb）+ 经验卡区（playbooks 已并入 exp_cards，kind=playbook 徽标 + runs/successes 统计）+ 文献区（kbList curated/external 统一浏览 + kbRead 正文 Modal，rules 56 篇进 curated 索引）+ **静态先验 rules 分区**（rulesList 目录树 + rulesRead 只读查看 data/rules/ 56 篇：src 定级闸 / srcskill 方法论 / techniques 手法模块 / web·php 组件先验，写入口是 seed-skills.sh 版本受控通道，外部知识经 kb_import）；审批视图=统一审批中心（pending 在前、类型徽章、批准/驳回留痕，待审批数显示在 tab 徽章上）。看板行只放摘要 + 跳链（`ctx.sessions.open`），**详细内容一律在会话里看**。行内操作一律图标 + 悬停提示（title）。
_Avoid_: 工作台、安全中心（同名不改）。

**审批（Approval）**：
统一审批中心，`approval_requests` 表为唯一审批队列。审批类型经 `APPROVAL_KINDS` 注册表扩展（每种 kind 定义 label/validate/onApprove，批准先跑副作用成功才落 approved）。现有 5 kind：`scope-wildcard`=整域授权（subject=裸 apex，evidence≥30 字主体核证级，judgment 仅 控股/全资 或 收购/财团；批准写回 `*.x.com + x.com` 双条目 + 种子任务，看板呈现 domain_level=apex 徽章）；`scope-domain`=单子域授权（subject=完整子域，evidence≥30 字具体归属证据，提请须带股权判据 equity_basis/independent_src/corroboration，口径见 rules/src/equity-gate.md；批准副作用=scopeSaveProgram 原子写回 scope.yml + 自动入队首轮资产收集种子任务（`[审批入队]` 前缀，只做资产收集）+ radar-queue 追加 scope-approved 事件；domain_level=subdomain 徽章）；`exclude-exception`=排除例外评估（subject 须在项目排除清单内；批准=移出排除+并入 scope+durable fact 留判据）；`tool-intrusive`=侵入工具放行（**异步审批**：run_cli 遇 intrusive 被拒自动落库，批准写项目 rules.allow_intrusive_tools 白名单，agent 纪律禁重试）；`task-budget-extend`=任务预算延长（**异步审批**：worker 跑满 3600s 被杀时 scheduler 自动提请，批准写 tasks.budget_timeout_sec≤7200）。agent 侧用 `approval_request` 工具提请（同对象 pending 去重、判据存 payload 看板渲染、列表可 kind/status 筛选）；**提请不改变 fail-closed——批准前目标一律拒绝**。未来其他审批类型（如 scan-burst 升速）作为新 kind 挂进来即可，看板/工具/rpc 零改动。
_Avoid_: 为每类审批另建专用表/专用流程。

**丝之歌主题（Silksong Theme）**：
平台的全局 UI 主题（单套深色），视觉叙事取自游戏《空洞骑士：丝之歌》——Pharloom 的墨青夜色为底、Hornet 绯红为唯一行动色、丝线金为强调/警示、苔绿为安全/成功。作用于整站（会话面 + 全局面），不是某个面板的局部皮肤。
_Avoid_: 皮肤、配色方案（同义不改）；勿做看板专属局部主题造成内外割裂。
