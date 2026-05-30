<%*
// 1. 弹出输入框并重命名
let noteTitle = tp.file.title;
if (noteTitle.startsWith("Untitled") || noteTitle.startsWith("未命名")) {
    noteTitle = await tp.system.prompt("请输入常青笔记标题:");
    await tp.file.rename(noteTitle);
}

// 2. 在同一个代码块内，直接将包含新标题的 YAML 属性区和 H1 标题输出，彻底避免变量未定义报错
tR += `---
title: "${noteTitle}"
type: evergreen
status: evergreen
created: "${tp.file.creation_date('YYYY-MM-DD')}"
tags:
  - evergreen
derived_from: []
review_cycle: quarterly
---

# ${noteTitle}`;
-%>

## 结论
<% tp.file.cursor(1) %>

## 为什么成立
<% tp.file.cursor(2) %>

## 适用范围
<% tp.file.cursor(3) %>

## 不适用或例外情况


## 常见误区


## 实战观察


## 可操作建议
- 

## 来源与延伸
- <% tp.system.clipboard() %>