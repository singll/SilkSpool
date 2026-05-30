# 模板使用说明

> 模板基于 [Templater](https://github.com/SilentVoid13/Templater) 插件实现，支持交互式输入、自动重命名、光标定位等高级功能。

---

## 快速开始

1. 安装 **Templater** 社区插件
2. 设置 → Templater → Template folder location：

```
KNOWLEDGE/Templates
```

3. 插入模板：`Ctrl/Cmd + P` → **Templater: Insert template**

---

## 模板与目录映射

| 模板文件 | 适用场景 | 建议落点 |
|----------|----------|----------|
| `daily-note.md` | 每日记录 | `Daily/Daily/` |
| `weekly-review.md` | 每周整理、RAW → PKB 收口 | `Daily/Weekly/` |
| `monthly-review.md` | 月度复盘与知识统计 | `Daily/Monthly/` |
| `evergreen-note.md` | 已理解、可复用的稳定知识 | `KNOWLEDGE/Evergreen/` |
| `lab-note.md` | 漏洞复现、实验记录 | `KNOWLEDGE/Labs/` |
| `programming-note.md` | 可复用的编程模式、稳定做法 | `KNOWLEDGE/Programming/` |
| `playbook-note.md` | IR/Hunting/Hardening 等可重复 SOP | `KNOWLEDGE/Playbooks/` |
| `project-note.md` | 项目决策、技术方案复盘 | `KNOWLEDGE/Projects/` |
| `source-note.md` | 文章摘录、漏洞通告、报告来源 | `RAW/Articles/` 或 `RAW/Advisories/` |
| `tool-card.md` | 安全/运维工具速查卡 | `KNOWLEDGE/Evergreen/` 或 `KNOWLEDGE/Programming/` |

---

## 文件夹触发器配置（推荐）

在 Templater 设置 → **Folder Templates** 中配置自动套用：

| 文件夹 | 自动模板 |
|--------|----------|
| `Daily/Daily/` | `daily-note.md` |
| `Daily/Weekly/` | `weekly-review.md` |
| `Daily/Monthly/` | `monthly-review.md` |

---

## Templater 语法速查

### 交互式模板（创建时弹出输入框）

以下模板在文件名为 `Untitled` 或 `未命名` 时会自动弹出输入框并重命名文件：

- `evergreen-note.md` — 常青笔记标题
- `lab-note.md` — 实验室笔记标题
- `playbook-note.md` — 剧本笔记标题
- `programming-note.md` — 编程笔记标题
- `project-note.md` — 项目笔记标题
- `source-note.md` — 来源笔记标题
- `tool-card.md` — 工具卡片标题

### 日期模板（自动生成）

- `daily-note.md` — 当前日期（YYYY-MM-DD）
- `weekly-review.md` — 当前周（YYYY-Www）
- `monthly-review.md` — 当前月（YYYY-MM 月复盘）

### 常用语法

| 语法 | 说明 |
|------|------|
| `<% tp.date.now("YYYY-MM-DD") %>` | 当前日期 |
| `<% tp.date.now("YYYY-MM-DD", -7) %>` | 7 天前 |
| `<% tp.date.now("ww") %>` | 当前周数 |
| `<% tp.file.title %>` | 当前文件名 |
| `<% tp.file.creation_date("YYYY-MM-DD") %>` | 文件创建日期 |
| `<% tp.file.cursor() %>` | 模板插入后光标停留位置 |
| `<% await tp.system.prompt("提示文字") %>` | 弹窗让用户输入 |
| `<% await tp.system.suggester(["A","B"], ["a","b"]) %>` | 弹窗让用户选择 |
| `<% tp.system.clipboard() %>` | 粘贴剪贴板内容 |
| `<%* ... %>` | 执行 JS 代码，不输出 |
| `<%* ... -%>` | 执行 JS 代码，不输出，且吃掉后面的换行 |

---

## 工作流

### 来源进入时
1. 在 `RAW/Articles/` 或 `RAW/Advisories/` 新建笔记
2. 套用 `source-note.md`（会弹窗收集来源和作者）
3. 填关键事实、你的理解
4. 每周整理时决定是否提炼

### 提炼时
1. 从 `RAW/` 挑选高价值笔记
2. 在 `KNOWLEDGE/` 对应目录新建笔记
3. 套用 `evergreen-note` / `lab-note` / `programming-note` / `playbook-note`
4. 在原笔记 `distilled_to` 填入新笔记链接
5. 在新笔记 `derived_from` 填入原笔记链接

### 每周收口时
1. 在 `Daily/Weekly/` 新建笔记（自动套用模板）
2. 记录本周输入、完成提炼、积压清单、下周优先级

### 每月复盘时
1. 在 `Daily/Monthly/` 新建笔记（自动套用模板）
2. 回顾本月周整理、统计知识沉淀、设定下月优先级

---

## 注意事项

- 模板目录 `KNOWLEDGE/Templates/` 参与 LiveSync 同步
- 模板文件不应进入检索增强消费范围
- 自动化流转依赖 frontmatter 中的 `type` 和 `status` 字段
