# Obsidian / Markdown 知识主库

> 这里定义 SilkSpool 的**知识真相源**与个人整理工作界面。
> 当前口径不再把笔记系统理解为“RAGFlow 的上游”，而是理解为：**Markdown 文件为王，Obsidian 是主要前端之一，PKB 优先，自动化回流是可选增强。**
> Windows 侧文件编排入口已独立迁入 `SilkFiles` 项目；本目录只负责知识结构、规则与操作边界，不再承载当前脚本真相源。

---

## 角色定位

在新的知识模型下，笔记系统主要承担：

- **Layer 3 / PKB** 的长期沉淀
- 必要时承接部分 **Layer 2 / Working Layer** 草稿整理
- 作为用户进行写作、复盘、提炼、归档的核心界面

它**不是**：

- 整个知识系统唯一入口
- 自动采集层的唯一落点
- RAG 平台的从属数据区

---

## 新的总体原则

### 1. 文件为王

真正稳定的知识主库是：

- Markdown / 文本文件
- 附件目录
- 可迁移、可备份、可被多种工具读取的目录结构

Obsidian 是主要编辑器之一，但不是唯一前端，也不是知识真相源本身。

### 2. 三层知识模型里，笔记主库更偏 Layer 3

```text
Layer 1  Raw Capture   原始采集层
Layer 2  Working Layer AI / 工作层
Layer 3  PKB           最终个人知识库
```

Obsidian / Markdown 在这里最核心的职责是：

- 承接最终保留的 Evergreen Notes
- 沉淀方案、经验、踩坑、实验结论、主题页
- 为长期复用服务，而不是承接所有自动采集原文

### 3. MVP-first

即使没有 LiveSync、CouchDB、RAGFlow、n8n，知识主库也应独立成立：

- 能写
- 能看
- 能整理
- 能人工归档

同步、检索、自动回流都属于后加能力，不应反向定义主库结构。

---

## MVP-first 的具体落地

如果你要先实现一个**可独立运转**的知识系统，推荐采用下面的分工：

### 1. PKB 主库：本地单 Vault

本地维护一个真实 Vault：

```text
D:\Notes\obsidian-note
```

它负责：

- 最终知识沉淀（`KNOWLEDGE/`）
- 导入后的原料笔记（`RAW/`）
- AI 整理稿、阶段总结、待沉淀内容（`WORKING/`）
- 日常输入与周整理（`00-Inbox/`、`Daily/`）

同步方式：

- **LiveSync → CouchDB**

### 2. Raw / Working 文件资产：TrueNAS `data/knowledge`

这些内容更适合放到 TrueNAS：

- PDF、网页保存、截图、导出 Markdown、导入包
- AI 摘要导出物、日报素材、阶段性汇总
- 不适合直接进 Vault 的大附件与配套资料

推荐路径：

```text
POOL/data/knowledge/raw
POOL/data/knowledge/working
POOL/data/knowledge/pkb-assets
```

访问方式：

- SMB / SFTP / Rclone / FileBrowser

### 3. 最小人工流转

MVP 阶段先不要依赖“外部系统直接写 CouchDB”，而是先保证这条受控路径成立：

1. 原始资料进入 TrueNAS `raw`
2. AI 输出、阶段性整理结果进入 TrueNAS `working`
3. 在 Win11 打开 Obsidian 后，运行统一 PowerShell 脚本 / 快捷方式
4. 脚本先把 `raw / working` 同步到本地导入缓冲区 `D:\SilkSpoolImport\raw|working`
5. 脚本再把适合进入知识系统的内容更新到 Vault `RAW/` / `WORKING/`
6. 用户在同一个 Vault 中继续提炼到 `KNOWLEDGE/`
7. 大附件与导出物放回 `pkb-assets`

### 4. 打开 Obsidian 后一键导入

为降低 `Raw → Working → PKB` 的整理摩擦，推荐在 Windows 上增加一层本地导入缓冲区：

```text
D:\SilkSpoolImport\
├── raw\
└── working\
```

推荐主流程：

1. 打开 Obsidian，Vault 先通过 LiveSync 完成常规笔记同步
2. 运行一个统一 PowerShell 脚本 / 快捷方式
3. 脚本先把 TrueNAS `POOL/data/knowledge/raw|working` 同步到 `D:\SilkSpoolImport\raw|working`
4. 脚本再把适合进入知识系统的内容更新到 Vault `RAW/` / `WORKING/`
5. Obsidian 通过文件监听或重扫显示新内容
6. 用户继续在同一个 Vault 中整理、移动、改写或派生到 `KNOWLEDGE/`

脚本内部职责应固定为：

- **同步步骤**：TrueNAS → Windows 本地导入缓冲区
- **导入步骤**：本地导入缓冲区 → Vault `RAW/WORKING`
- **刷新步骤**：让 Obsidian 看见最新导入结果

当前 Windows 侧统一入口已经独立迁入 `SilkFiles` 项目：

- 执行入口：`SilkFiles/files.ps1`
- 规则说明：[`setup/windows-knowledge-sync.md`](setup/windows-knowledge-sync.md)

脚本默认遵循三条关键策略：

- **Markdown 优先**：优先把 `.md`、`.txt`、OCR/转写后的文本导入 Vault
- **成功即清理**：成功导入后删除 `D:\SilkSpoolImport\raw|working` 中的缓存副本
- **外置资产生成索引页**：PDF、大附件等默认不复制进 Vault，而是在 Vault 中生成相对资产路径索引页

这样做的原因是：

- 用户只执行一次动作，不需要“先同步、再单独导入”
- 不必把整个 Vault 放在 SMB / Rclone 下承担冲突
- TrueNAS 继续负责文件资产，Vault 继续负责整理后的 Markdown 笔记
- LiveSync 只同步 Vault，不要求外部工具直接写 CouchDB

### 5. 为什么不把整个知识库都做成 NAS 文件同步

因为：

- PKB 笔记更适合 LiveSync 这种面向笔记的同步链路
- 原始资料与大附件更适合 TrueNAS 文件同步
- 导入缓冲区适合作为当前设备的受控中转层，而不是长期知识主库
- Windows 工具与环境应继续放在 `data/sync`，不要混入 Vault

所以更合理的实现是：

- **PKB / 笔记**：本地 Vault + LiveSync
- **Raw / Working / Assets**：TrueNAS `data/knowledge`
- **Raw / Working 进入 Vault**：统一 PowerShell 脚本
- **工具与环境**：TrueNAS `data/sync`

详细目录与实施顺序见 [../storage/README.md](../storage/README.md)。

---

## 当前推荐理解

### 推荐主链路

- **Raw / Working 文件资产**：长期放在 TrueNAS `POOL/data/knowledge/raw|working`
- **本地导入缓冲区**：在当前设备上承接同步后的 `raw|working` 文件资产
- **PKB / 同步笔记区**：在 Obsidian 单 Vault 中承接 `RAW/`、`WORKING/`、`KNOWLEDGE/`
- **高价值内容**：可选再提供给检索 / 问答系统消费

### 推荐默认语义

- Obsidian 主要是 **同步笔记区 / PKB 前端**
- 同一个 Vault 内同时承接 `RAW/`、`WORKING/`、`KNOWLEDGE/`
- TrueNAS `raw/working` 是**文件资产区**，不是 Vault 目录本身
- Windows 本地导入缓冲区是**受控导入层**，不是长期主库
- K07 这类“笔记回流知识引擎”的流程应理解为**只读消费器**，不是反向导入入口
- CouchDB 是 LiveSync 的私有同步后端，不是公共写入口

---

## 文件树

```text
doc/modules/notes/
├── README.md                              # 本文件
├── setup/
│   ├── windows-vault-bootstrap.md         # Windows 从零落地指南（基于 SilkFiles）
│   ├── windows-knowledge-sync.md          # SilkFiles knowledge 入口规则
│   └── livesync-checklist.md              # LiveSync 配置清单
├── vaults/
│   └── single-vault.md                    # 单 Vault 目录设计与职责说明
├── standards/
│   ├── frontmatter.md                     # Frontmatter 规范（5 个必填字段）
│   ├── naming.md                          # 命名规范
│   └── sync-and-ignore-rules.md           # 同步边界与回流规则
├── templates/
│   ├── README.md                          # 模板使用说明
│   ├── source-note.md
│   ├── evergreen-note.md
│   ├── lab-note.md
│   ├── programming-note.md
│   ├── playbook-note.md
│   ├── project-note.md
│   ├── tool-card.md
│   ├── daily-note.md
│   ├── weekly-review.md
│   └── monthly-review.md
└── workflows/
    └── weekly-distill-sop.md              # 每周整理 SOP
```

---

## 阅读顺序

1. [vaults/single-vault.md](vaults/single-vault.md) — 理解单 Vault 目录结构和分区职责
2. [setup/windows-vault-bootstrap.md](setup/windows-vault-bootstrap.md) — Windows 首次部署
3. [setup/windows-knowledge-sync.md](setup/windows-knowledge-sync.md) — Windows 导入脚本规则与命令动作
4. [setup/livesync-checklist.md](setup/livesync-checklist.md) — 配置 LiveSync 同步
5. [standards/frontmatter.md](standards/frontmatter.md) — 笔记元数据规范
6. [standards/naming.md](standards/naming.md) — 命名规范
7. [standards/sync-and-ignore-rules.md](standards/sync-and-ignore-rules.md) — 同步边界与回流规则
8. [templates/README.md](templates/README.md) — 模板使用说明
9. [workflows/weekly-distill-sop.md](workflows/weekly-distill-sop.md) — 每周整理流程

---

## 当前原则

- 只维护一个真实 Vault：`D:\Notes\obsidian-note`
- Vault 首先服务于**个人整理与长期沉淀**，而不是承接所有机器采集原文
- `00-Inbox` 可以继续作为人工写入入口，但不再把它等同于整个知识系统唯一入口
- LiveSync 只同步这一个 Vault，对应一个 CouchDB 数据库
- 是否把笔记再回流到检索系统，应视为可选增强，不应视为主库定义条件

---

## 与其他模块的边界

- [../knowledge/README.md](../knowledge/README.md) — AI 工作层、检索、问答、RAG / Search 支撑
- [../automation/README.md](../automation/README.md) — K07 等自动化流程如何与笔记系统联动
- [../storage/README.md](../storage/README.md) — TrueNAS 负责附件、资料与同步承载，但不定义笔记结构
