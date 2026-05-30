# 每周整理 SOP

> 目标：每周用固定流程把 `00-Inbox` 和 `RAW/` 中的原料提炼到 `KNOWLEDGE/`，形成从 Raw / Working 到 PKB 的稳定收口。

---

## 核心原则

- `00-Inbox` 负责收，不在 Inbox 里做提炼
- `RAW/` 负责暂存原料，允许半成品
- `KNOWLEDGE/` 只放已理解、可复用的定稿内容
- 每周至少做一次收口，不让积压无限增长

---

## 整理节奏

推荐：每周固定一个时段（如周日 1 小时）执行以下步骤。

---

## Step 1：清理 Inbox

打开 `00-Inbox/`，逐条处理每篇笔记：

| 判断 | 操作 |
|------|------|
| 已无价值 | 直接删除 |
| 来源材料，后续需提炼 | 移动到 `RAW/Articles/` 或 `RAW/Advisories/`，套用 `source-note` 模板补充 frontmatter |
| 实验原始记录 | 移动到 `RAW/Lab-Notes/` |
| 编程草稿 | 移动到 `RAW/Programming-Drafts/` |
| AI 生成待确认 | 移动到 `RAW/AI-Drafts/` |
| 已整理，可直接沉淀 | 直接移动到 `KNOWLEDGE/` 对应目录 |

目标：Inbox 清空或只剩「本周新进入的未处理条目」。

---

## Step 2：从 RAW 提炼到 KNOWLEDGE

### 提炼为 Evergreen

如果一篇 `RAW/` 笔记满足以下至少 3 条，提炼为永久笔记：

- 你已经理解，不只是摘抄
- 内容未来还会复用
- 能脱离原文独立成立
- 有明确边界条件或适用场景
- 能指导行动、判断或分析

操作：
1. 在 `KNOWLEDGE/Evergreen/Security/`（或对应域）新建笔记
2. 套用 `evergreen-note.md` 模板
3. 写结论、适用范围、可操作建议
4. 在原笔记填 `distilled_to`，在新笔记填 `derived_from`

### 提炼为 Lab

如果一篇 `RAW/Lab-Notes/` 笔记已经复现成功，提炼为最终版：

1. 在 `KNOWLEDGE/Labs/` 对应子目录新建笔记
2. 套用 `lab-note.md` 模板
3. 精简试错过程，保留关键步骤和技术要点
4. 设置 `status: verified`

### 提炼为 Playbook

如果有一套可重复执行的操作步骤（IR、Hunting、Hardening）：

1. 在 `KNOWLEDGE/Playbooks/` 新建笔记
2. 结构：目标 → 前置条件 → 步骤 → 验证点
3. 回链相关来源、实验、Evergreen 笔记

---

## Step 3：建立链接关系

每次提炼后至少做：

1. **来源 → 结论**：来源笔记 `distilled_to` 链接到 Evergreen
2. **实验 → 方法**：Lab 笔记链接到相关 Playbook / Evergreen
3. **主题 → MOC**：高价值主题在对应目录的 MOC 文件中补充条目

MOC 文件位置示例：

```text
KNOWLEDGE/Evergreen/Security/Security-MOC.md
KNOWLEDGE/Evergreen/Programming/Programming-MOC.md
```

---

## Step 4：补齐 Frontmatter

提炼完成后检查关键字段：

- `type`
- `status`
- `created`
- `tags`
- `derived_from` / `distilled_to`（有提炼关系时必填）

---

## Step 5：归档与收口

1. 将已完全沉淀、无需活跃维护的原始资料移入 `RAW/Archive/`
2. 删除或归档低价值 AI 草稿
3. 在 `Daily/Weekly/` 新建周整理笔记，套用 `weekly-review.md`
4. 记录：本周输入、完成提炼、积压清单、下周优先级

---

## 质量门槛

进入 `KNOWLEDGE/` 的笔记至少满足：

- 你已经理解，不只是摘抄
- 内容未来还会复用
- 能脱离原文独立成立

不满足的继续留在 `RAW/`。

---

## 一句话原则

- `00-Inbox` 收，`RAW/` 暂存，`KNOWLEDGE/` 定稿
- 每周做一次提炼和收口
- MOC 是文件，不是目录
- 不让 AI 草稿直接进入最终知识区
