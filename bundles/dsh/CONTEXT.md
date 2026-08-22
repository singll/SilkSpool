# SilkSecAgent 领域语言 / Domain Language

> SilkSecAgent（DSH + pi）授权范围内漏洞发现平台的统一术语表。
> 当代码、文档或对话使用这些词时，含义以此为准。实施细节见 `doc/dsh-pi-secagent-plan-v5.md`。

## 核心实体

**Program（项目）**：
SRC/HW 授权项目，真相源是 `scope.yml` 的 `program.name`。资产/漏洞/事实/任务都挂在 program 之下。
_Avoid_: 项目之外勿用「目标」「客户」。

**Task（任务）**：
编排器派发的可治理工作单元，带队列/优先级/依赖/预算/人工断点。属于某个 Program，由某个 Run 或 worker 执行。
_Avoid_: 会话内易失的 goal/plan/todo 不是 Task。

**Run（执行）**：
一次工具执行（`run_cli` / `spawn_worker` / `authz_diff`），全量落盘 `results/<run_id>/`。属于会话，是「某条会话干了什么」，不是全局治理对象。
_Avoid_: 不要把 Run 当成第一公民实体进全局面。

**Finding（漏洞）**：
一条发现的漏洞/风险，带状态机 new→confirmed→false_positive/submitted→accepted/dup/ignored。
_Avoid_: 报告、issue。

**Asset / Endpoint（资产 / 接口）**：
侦察到的资产主机与接口。Endpoint 是 Asset 的子维度。

**Fact（事实）**：
跨会话沉淀的一条知识，格式 `category/slug`，带 summary（注入 prompt 的索引）+ body（按需拉取）+ confidence。落在事实图谱 `facts` + `fact_edges`。
_Avoid_: 黑板、note、key:value。

**Blackboard（黑板，遗留）**：
旧版扁平 `key:value` 存储，已被 Fact 取代，保留为兼容薄封装，只读，待迁移。

**Scope（授权范围）**：
`scope.yml` 白名单，fail-closed 硬校验，是平台的安全红线。

## UI 信息架构

**全局面（global surface）**：
跨会话持久的平台状态 UI（资产/漏洞/事实/任务等），不随某条对话变化。
_Avoid_: 别挂在会话标签页下。

**会话面（session surface）**：
跟某一条对话绑定的 UI（消息 / Trajectory / Run）。

**看板（Dashboard）**：
全局面的正式名称，侧边栏全局入口 → 独立模态面板，内含「漏洞 / 资产 / 事实 / 任务」四视图。
_Avoid_: 工作台、安全中心（同名不改）。

**丝之歌主题（Silksong Theme）**：
平台的全局 UI 主题（单套深色），视觉叙事取自游戏《空洞骑士：丝之歌》——Pharloom 的墨青夜色为底、Hornet 绯红为唯一行动色、丝线金为强调/警示、苔绿为安全/成功。作用于整站（会话面 + 全局面），不是某个面板的局部皮肤。
_Avoid_: 皮肤、配色方案（同义不改）；勿做看板专属局部主题造成内外割裂。
