# 架构总览

> SilkSpool 当前总口径：**Matrix = 控制平面，TrueNAS = 存储平面，Markdown / Obsidian = 知识真相源，自动化 / AI / 检索 = 可选增强层。**
> 知识系统优先采用**三层模型**与**MVP-first**思路建设：先让核心知识库独立可运转，再逐步叠加采集、AI、检索与自动化。

---

## 一句话架构

SilkSpool 不是“以 RAGFlow 为中心”的系统，而是一个以 **Matrix 交互**、**TrueNAS 存储**、**Markdown / Obsidian 沉淀** 为骨架的自托管知识与自动化系统；Bellkeeper、n8n、LLM、RAG 只是在这个骨架之外提供治理、加工、检索与联动能力。

---

## 当前推荐总模型

### 知识系统：三层模型

```text
Layer 1  Raw Capture   原始采集层
Layer 2  Working Layer AI / 工作层
Layer 3  PKB           最终个人知识库
```

- **Layer 1 — Raw Capture**：保存 RSS、网页、手动导入、截图、原文、附件、来源元数据等原始输入
- **Layer 2 — Working Layer**：承接 AI 标签、摘要、日报、草稿、待筛选与待提升内容，以及基于文件的检索 / 问答增强
- **Layer 3 — PKB**：只保留经过个人整理、长期有效、可快速复用的方案、经验与知识

### MVP-first 的推荐实现方式

推荐把 MVP-first 理解成“三个承载面协同”，而不是把所有内容硬塞进一个同步机制：

1. **笔记层（Note Surface）**：本地 Markdown / Obsidian 单 Vault，内部承接 `RAW/`、`WORKING/`、`KNOWLEDGE/`，并使用 LiveSync → CouchDB 做笔记同步。
2. **文件资产层（Asset Surface）**：以 TrueNAS `POOL/data/knowledge` 为长期文件基座，承接 `raw / working / pkb-assets`。
3. **本地导入层（Import Surface）**：在 Windows 上准备 `D:\SilkSpoolImport\` 这类本地缓冲区，由统一 PowerShell 脚本完成“同步 raw / working → 更新 Vault 对应目录”。
4. **检索增强层（Retrieval Surface）**：由 Bellkeeper 基于落地文件派生搜索与问答能力，默认服务 `raw + working`，而不是把外部内容先写入 RAGFlow。

推荐关系：

```text
TrueNAS
└── POOL/data/knowledge/
    ├── raw/          # 原始资料、导出物、截图、附件、网页保存、导入包
    ├── working/      # AI 输出、待整理草稿、阶段性汇总、日报素材
    └── pkb-assets/   # 已进入 PKB 但不适合直接放进 Vault 的附件/导出物

Windows 本地导入缓冲区
└── D:\SilkSpoolImport\
    ├── raw\
    └── working\

Windows / 多端本地
└── D:\Notes\obsidian-note
    ├── 00-Inbox/
    ├── RAW/
    ├── WORKING/
    ├── KNOWLEDGE/
    └── Daily/
```

关键原则：

- **TrueNAS `data/` 适合作为 MVP 的文件资产基座**，尤其适合 raw / working / 大附件 / 导出物 / 多端共享工作集。
- **PKB 主库不建议直接依赖 NAS 文件同步**；它更适合保持单 Vault + LiveSync。
- **外部工具不应直接写 LiveSync 使用的 CouchDB**；CouchDB 只是 Obsidian Vault 的私有同步后端，不是公共导入总线。
- **搜索 / 问答应优先从落地文件派生**；默认覆盖 `raw + working`，而不是把 RAGFlow 作为第一落点。
- 因此 MVP 不是“把 raw / working / pkb 整棵目录都用 SMB 同步”，而是：
  - `raw / working` 的文件资产以 TrueNAS 为中心；
  - Windows 本地导入缓冲区负责把文件资产受控带入当前设备；
  - `pkb` 的笔记主库以本地 Vault + LiveSync 为中心；
  - 三者通过统一 PowerShell 导入脚本、附件引用、导出物归档、人工整理流程联动。

### MVP-first 实施顺序

#### Phase 1：先建文件资产基座

在 TrueNAS 上先准备：

- `POOL/data/knowledge/raw`
- `POOL/data/knowledge/working`
- `POOL/data/knowledge/pkb-assets`

这样先把“原始输入、工作层中间产物、PKB 附件资产”分开，保证即使没有 AI / 自动化，文件层也先成立。

#### Phase 2：再建 PKB 主库与本地导入层

在 Windows 主力机创建本地 Vault：

- `D:\Notes\obsidian-note`

Vault 内继续保持：

- `00-Inbox/`
- `RAW/`
- `WORKING/`
- `KNOWLEDGE/`
- `Daily/`

同时准备 Windows 本地导入缓冲区：

- `D:\SilkSpoolImport\raw`
- `D:\SilkSpoolImport\working`

这里的目录关系不是简单镜像：

- Vault 内 `RAW/` 更偏**可整理、可提炼的 Markdown 原料笔记**；
- Vault 内 `WORKING/` 更偏**AI 整理稿、阶段总结、待沉淀内容**；
- TrueNAS `raw/` 更偏**原始文件资产与导入物**；
- TrueNAS `working/` 更偏**阶段性中间产物与外部输出**；
- 本地导入缓冲区只是把文件资产受控带入当前设备，不是长期知识主库。

#### Phase 3：补多端同步与一键导入

- PKB / Vault：使用 LiveSync → CouchDB。
- TrueNAS 文件资产：按设备类型选 SMB / SFTP / Rclone，同步到 `D:\SilkSpoolImport\raw|working`。
- 检索增强层：Bellkeeper 从 `raw|working` 文件派生搜索与问答能力，优先服务 Matrix 与 Web 入口。
- Windows 上提供统一 PowerShell 脚本 / 快捷方式：一键完成“同步 raw / working → 更新 Vault `RAW/WORKING` → 让 Obsidian 重扫”。
- Windows 便携工具与工作集：优先走 `data/sync`，不要混进知识主 Vault。

这里要特别强调：

- LiveSync 只同步 Vault 文件本体；
- CouchDB 是 LiveSync 的私有同步后端；
- 外部工具、自动化流程、RAG / Search 系统都不应直接写 CouchDB；
- 如需对外消费 Markdown 变更，应沿用 K07 这类 `_changes` 只读消费链路。

#### Phase 4：最后再叠加增强层

当以上三步稳定后，再接：

- RSS / 网页自动采集写入 `raw`
- AI 摘要 / 标签 / 日报写入 `working`
- 高价值内容人工提炼进 PKB
- 必要时再把部分 PKB / Working 内容接入检索增强

---

## 当前关系图

```text
外部输入：RSS / 手动 URL / 网页抓取 / 本地笔记 / 运维事件
  ↓
核心知识系统（Markdown / 文件 + 附件）
  ├─ Raw Capture
  ├─ Working Layer
  └─ PKB
  ↓
可选增强层
  ├─ Bellkeeper：治理 / 路由 / API 聚合
  ├─ n8n：编排 / 定时 / 机器人 / 通知
  ├─ LLM：摘要 / 标签 / 分类 / 辅助生成
  └─ RAG / Search：检索 / 问答 / 语义查询
  ↓
Matrix / Obsidian / FileBrowser / 其他前端

TrueNAS
  ├─ 知识附件 / 原始资料 / 项目资产 / 媒体 / 私有文件
  ├─ Windows 工作集与同步区
  └─ 作为长期存储平面，不定义知识结构本身
```

---

## 核心分层

### 1. Matrix = 控制平面

Matrix 是统一的通知、命令、人机交互和闭环入口。

- 告警、日报、工作流结果默认推送到 Matrix
- `!` / `！` 前缀命令是当前机器人交互标准
- 用户确认、日常检索、轻量操作优先在 Matrix 完成

详见 [../modules/matrix/README.md](../modules/matrix/README.md)。

### 2. TrueNAS = 存储平面

TrueNAS 是长期文件和数据分层的中心，不只是一个挂载点。

- 大文件、媒体、项目资料、私有文件、同步目录统一落到 TrueNAS
- 旧的 `main/*` 目录结构只作为迁移输入，不是未来布局约束
- 不同数据类型使用不同同步策略，不再追求“一个工具同步所有东西”

详见 [../modules/storage/README.md](../modules/storage/README.md)。

### 3. Markdown / Obsidian = 知识真相源

系统化知识写作与整理以 Markdown 为主，Obsidian 是主要编辑器之一。

- 真正稳定的核心是 **文件本体**，不是某个 AI 或 RAG 平台
- Obsidian 是重要前端，但不是唯一前端
- 更推荐把 Obsidian 理解为 PKB / Layer 3 的主要工作界面

详见 [../modules/notes/README.md](../modules/notes/README.md)。

### 4. Bellkeeper + n8n = 治理与编排层

两者分工明确，但都属于**增强层**，不是知识系统本体。

- **Bellkeeper**：知识入口治理、API 聚合、AI / RAG 辅助接口
- **n8n**：工作流编排、Matrix 机器人路由、定时任务与通知

详见 [../modules/automation/README.md](../modules/automation/README.md)。

### 5. RAG / Search + LLM = 检索与生成支撑层

RAG、向量检索、语义搜索和 LLM 提供辅助理解能力，但不承担主库职责。

- 服务 Matrix `!问` / `!搜`
- 支撑 RSS 摘要、知识问答、解析增强
- 不承担系统全局中心角色
- 后续可替换实现，不应与知识真相源绑定

详见 [../modules/knowledge/README.md](../modules/knowledge/README.md)。

---

## 模块边界

| 主题 | 权威文档 | 不再放在这里的内容 |
|------|----------|--------------------|
| Matrix 房间、指令、控制平面定位 | [../modules/matrix/README.md](../modules/matrix/README.md) | 不再散落在工作流总表和评估文档中 |
| TrueNAS 分层、工具同步、迁移原则 | [../modules/storage/README.md](../modules/storage/README.md) | 不再由 Windows 同步混合文档承载 |
| Vault 结构、LiveSync、笔记规范 | [../modules/notes/README.md](../modules/notes/README.md) | 不再与通用存储同步文档混写 |
| AI 工作层、检索、问答与知识增强 | [../modules/knowledge/README.md](../modules/knowledge/README.md) | 不再与系统总纲混用 |
| n8n 工作流、编号、Bellkeeper 对接 | [../modules/automation/README.md](../modules/automation/README.md) | 不再承担 Matrix / Notes / Storage 的完整说明 |
| RSS 源资产与导入入口 | [../modules/rss/README.md](../modules/rss/README.md) | 不再散落在工作流文档和脚本注释中 |

---

## 推荐阅读路径

1. [基础设施](infrastructure.md)
2. [Matrix 控制平面](../modules/matrix/README.md)
3. [存储与同步](../modules/storage/README.md)
4. [知识主库：Obsidian / Markdown](../modules/notes/README.md)
5. [知识工作层与检索增强](../modules/knowledge/README.md)
6. [自动化与编排](../modules/automation/README.md)
