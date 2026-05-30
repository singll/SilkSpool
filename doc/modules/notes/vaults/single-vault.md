# 单 Vault 目录设计

> 定位：一个真实 Vault，内部用 `00-Inbox`、`RAW/`、`WORKING/`、`KNOWLEDGE/`、`Daily/` 五个顶层分区承接输入、工作层整理与最终沉淀。

---

## 推荐真实路径

```text
D:\Notes\obsidian-note
```

这个目录就是你唯一需要在 Obsidian 中打开并通过 LiveSync 同步的 Vault。

---

## 完整目录树

```text
obsidian-note/
├── 00-Inbox/                    # 所有新笔记先落这里，不做细分
│
├── RAW/                         # 原料区（导入后的 Markdown 原料笔记）
│   ├── Articles/                # 文章摘录、报告、博客（领域靠标签区分）
│   ├── Advisories/              # 漏洞通告、厂商公告、CVE
│   ├── Lab-Notes/               # 实验原始记录、试错过程
│   ├── Programming-Drafts/      # 编程草稿、调试记录、代码片段
│   ├── AI-Drafts/               # AI 生成待确认内容
│   ├── Imports/                 # 历史笔记导入、旧资料迁移
│   └── Archive/                 # 低价值草稿、已迁移原始资料
│
├── WORKING/                     # 工作层（阶段总结、AI 整理稿、待沉淀内容）
│   ├── Summaries/               # AI 摘要、日报素材、阶段汇总
│   ├── Distill/                 # 待提炼的中间稿
│   ├── Reviews/                 # 周整理、主题整理的工作稿
│   └── Archive/                 # 已完成或失效的中间稿
│
├── KNOWLEDGE/                   # 沉淀区
│   ├── Evergreen/               # 永久笔记 + 各主题 MOC 文件
│   │   ├── Security/
│   │   ├── Programming/
│   │   └── AI/
│   ├── Labs/                    # 最终版漏洞复现记录
│   │   ├── Web/
│   │   ├── Windows-AD/
│   │   └── Cloud/
│   ├── Playbooks/               # SOP、IR、Hunting、Hardening
│   ├── Programming/             # 稳定编程知识（非草稿）
│   ├── Projects/                # 项目决策/复盘（不是项目文档）
│   ├── Attachments/             # 图片等附件
│   └── Templates/               # 模板文件（供 Obsidian 插件使用）
│
├── Daily/                       # 日记/周记/月记（顶层高频入口）
│   ├── Daily/
│   ├── Weekly/
│   └── Monthly/
│
└── .obsidian/
```

---

## 设计决策

### 为什么 `00-Inbox` 在顶层

Inbox 是最高频的入口。放在顶层比嵌套在 `RAW/` 内少一层导航摩擦，让新笔记进入零阻力。

### 为什么 `RAW/` 不用数字前缀子目录

原料区不需要强制分类顺序。领域区分（安全/编程/AI）靠 frontmatter `tags` 完成，目录只负责粗粒度区分内容类型（Articles / Lab-Notes 等）。减少子目录层级，降低归类摩擦。

### 为什么没有 `KNOWLEDGE/Sources`

来源笔记放 `RAW/Articles` 或 `RAW/Advisories` 即可。提炼后直接升级到 `KNOWLEDGE/Evergreen`，不需要中间层。

### 为什么没有 `KNOWLEDGE/MOCs` 目录

MOC（Map of Content）是**笔记文件**，不是目录。每个主题的 MOC 文件放在对应的 `KNOWLEDGE/Evergreen/Security/` 等目录内，例如：

```text
KNOWLEDGE/Evergreen/Security/Security-MOC.md
KNOWLEDGE/Evergreen/Programming/Programming-MOC.md
```

### 为什么 `Daily/` 在顶层

日记/周记是高频使用入口，不应深埋在 `KNOWLEDGE/` 内部。放顶层让侧边栏可以快速导航。

---

## 分区职责

### `00-Inbox/`

- 所有新笔记默认落点
- 不做任何细分
- 每周处理一次，分流到 `RAW/` 或 `KNOWLEDGE/`

### `RAW/`

- 导入后的 Markdown 原料笔记、来源摘录、试验原始过程
- 允许半成品、允许试错
- 核心目标：先收进来，再筛选
- **不要**放最终结论型笔记
- 它不等于 TrueNAS `POOL/data/knowledge/raw`；后者是文件资产区，前者是已经进入 Vault 的笔记区

### `WORKING/`

- AI 整理稿、阶段总结、待沉淀内容
- 承接从 `RAW/` 向 `KNOWLEDGE/` 提升之间的工作稿
- 允许同主题多轮整理与合并
- 成熟后可直接移动到 `KNOWLEDGE/`，或派生最终版笔记

### `KNOWLEDGE/`

- 已整理的永久笔记、最终版 Lab、Playbook
- 结构稳定、内容精简
- 属于 **Layer 3 / PKB** 的主沉淀区
- 需要检索增强时，可按需被 K07 / 检索系统消费

### `Daily/`

- 日记、周整理、月复盘
- 时间维度的笔记，不做横向提炼

---

## 检索增强回流建议

如果后续启用 K07 / 检索增强链路，建议只让以下目录进入消费范围：

```text
KNOWLEDGE/Evergreen/
KNOWLEDGE/Labs/
KNOWLEDGE/Playbooks/
KNOWLEDGE/Programming/
```

不建议进入回流的目录：

```text
00-Inbox/
RAW/
WORKING/
KNOWLEDGE/Templates/
KNOWLEDGE/Attachments/
KNOWLEDGE/Projects/
Daily/
```

---

## 不要放进 Vault 的内容

- `D:\SilkSpoolImport\raw`
- `D:\SilkSpoolImport\working`
- PCAP
- 内存转储
- 恶意样本
- 大日志
- 大型压缩包
- 虚拟机镜像
- 大型代码仓库
- 凭据和敏感明文资料

其中 `D:\SilkSpoolImport\*` 是本地导入缓冲区，只负责把 TrueNAS 文件资产受控带入当前设备，不属于 Vault 本体。

这些内容应放到 TrueNAS、Rclone、私有 Git 仓库或加密目录中。

---

## 旧模型到新模型的映射

| 旧 | 新 |
|---|---|
| `RAW/00-Inbox/` | `00-Inbox/`（顶层） |
| `RAW/10-Articles/Web-Security/` | `RAW/Articles/` + `tags: [web-security]` |
| `KNOWLEDGE/20-Sources/` | 删除，来源留 `RAW/`，提炼后直升 `KNOWLEDGE/Evergreen/` |
| `KNOWLEDGE/10-Daily/` | `Daily/`（顶层） |
| `KNOWLEDGE/30-Evergreen/` | `KNOWLEDGE/Evergreen/` |
| `KNOWLEDGE/40-Labs/` | `KNOWLEDGE/Labs/` |
| `KNOWLEDGE/50-Playbooks/` | `KNOWLEDGE/Playbooks/` |
| `KNOWLEDGE/60-Projects/` | `KNOWLEDGE/Projects/` |
| `KNOWLEDGE/70-Programming/` | `KNOWLEDGE/Programming/` |
| `KNOWLEDGE/80-MOCs/` | 删除，MOC 作为文件放各主题目录内 |
| `KNOWLEDGE/90-Templates/` | `KNOWLEDGE/Templates/` |
| `KNOWLEDGE/99-Attachments/` | `KNOWLEDGE/Attachments/` |
