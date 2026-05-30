<%*
let noteTitle = tp.file.title;
if (noteTitle.startsWith("Untitled") || noteTitle.startsWith("未命名")) {
    noteTitle = await tp.system.prompt("请输入来源笔记标题:");
    await tp.file.rename(noteTitle);
}

const today = tp.date.now("YYYY-MM-DD");
tR += `---
title: "${noteTitle}"
type: source
status: to-distill
created: "${today}"
tags:
  - source
source: ""
author: ""
derived_from: []
distilled_to: []
---

# ${noteTitle}`;
-%>

## 一句话总结

## 来源信息
- 来源：
- 作者：
- 发布时间：
- 获取时间：<% tp.date.now("YYYY-MM-DD") %>

## 关键事实
-
-
-

## 关键技术点
-
-
-

## 我的理解与评注

## 待验证的点
-

## 可提炼为永久笔记的候选
-
