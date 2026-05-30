<%*
let noteTitle = tp.file.title;
if (noteTitle.startsWith("Untitled") || noteTitle.startsWith("未命名")) {
    noteTitle = await tp.system.prompt("请输入实验室笔记标题:");
    await tp.file.rename(noteTitle);
}

const today = tp.date.now("YYYY-MM-DD");
tR += `---
title: "${noteTitle}"
type: lab
status: active
created: "${today}"
tags:
  - lab
lab_target: ""
lab_environment: ""
verification: ""
derived_from: []
---

# ${noteTitle}`;
-%>

## 目标

## 环境
- 目标系统：
- 版本：
- 环境类型：
- 搭建方式：

## 前置条件
-

## 复现步骤

### Step 1

### Step 2

## 关键命令

```bash
```

## 结果与截图

## 遇到的问题与解决

## 技术要点
-
-

## 参考资料
-
