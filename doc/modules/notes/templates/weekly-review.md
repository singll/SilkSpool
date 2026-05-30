<%*
const year = tp.date.now("YYYY");
const week = tp.date.now("ww");
const today = tp.date.now("YYYY-MM-DD");
tR += `---
title: "${year}-W${week} 周整理"
type: daily
status: active
created: "${today}"
tags:
  - weekly
---

# ${year}-W${week} 周整理`;
-%>

## 本周输入

本周进入 `00-Inbox` 或 `RAW/` 的主要内容：
-
-

## 本周提炼

本周从 `RAW/` 提炼到 `KNOWLEDGE/` 的笔记：
-
-

## 积压清单

还没处理的 `00-Inbox` 条目或待提炼来源：
-
-

## 下周优先级

-
-

## 本周检查清单

- [ ] 已清理 00-Inbox
- [ ] 已筛选来源（丢弃 / 待验证 / 待提炼）
- [ ] 已至少提炼 1 篇 Evergreen
- [ ] 已补齐关键 frontmatter
- [ ] 已建立来源与结论笔记的双向链接
- [ ] 已归档低价值草稿
- [ ] 已记录下周要继续提炼的主题
