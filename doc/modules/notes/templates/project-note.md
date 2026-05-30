<%*
let noteTitle = tp.file.title;
if (noteTitle.startsWith("Untitled") || noteTitle.startsWith("未命名")) {
    noteTitle = await tp.system.prompt("请输入项目笔记标题:");
    await tp.file.rename(noteTitle);
}

const today = tp.date.now("YYYY-MM-DD");
tR += `---
title: "${noteTitle}"
type: project
status: active
created: "${today}"
tags:
  - project
---

# ${noteTitle}`;
-%>

## 背景

为什么要做这件事？

## 目标

-

## 关键决策

| 决策 | 选项 | 选择 | 原因 |
|------|------|------|------|
| | | | |

## 实施要点

-

## 结果

-

## 复盘

### 做对了什么

-

### 可以改进什么

-

### 学到了什么

-

## 相关笔记

-
