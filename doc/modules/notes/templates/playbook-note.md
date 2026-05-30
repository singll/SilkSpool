<%*
let noteTitle = tp.file.title;
if (noteTitle.startsWith("Untitled") || noteTitle.startsWith("未命名")) {
    noteTitle = await tp.system.prompt("请输入剧本笔记标题:");
    await tp.file.rename(noteTitle);
}

const today = tp.date.now("YYYY-MM-DD");
tR += `---
title: "${noteTitle}"
type: playbook
status: active
created: "${today}"
tags:
  - playbook
derived_from: []
review_cycle: quarterly
---

# ${noteTitle}`;
-%>

## 目标

这套流程要达成什么？在什么场景下触发？

## 前置条件

- 工具：
- 权限：
- 环境：

## 步骤

### 1.

### 2.

### 3.

## 验证点

如何确认每一步已正确执行：

- [ ]
- [ ]

## 注意事项与陷阱

-

## 相关笔记

- Lab：
- Evergreen：

## 变更记录

| 日期 | 变更内容 |
|------|----------|
| <% tp.date.now("YYYY-MM-DD") %> | 初始版本 |
