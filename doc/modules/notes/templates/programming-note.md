<%*
let noteTitle = tp.file.title;
if (noteTitle.startsWith("Untitled") || noteTitle.startsWith("未命名")) {
    noteTitle = await tp.system.prompt("请输入编程笔记标题:");
    await tp.file.rename(noteTitle);
}

const today = tp.date.now("YYYY-MM-DD");
tR += `---
title: "${noteTitle}"
type: programming
status: stable
created: "${today}"
tags:
  - programming
---

# ${noteTitle}`;
-%>

## 场景

什么情况下会用到这个？

## 做法

```code
```

## 关键点
-
-

## 坑点与注意事项
-

## 参考
-
