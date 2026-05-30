<%*
let noteTitle = tp.file.title;
if (noteTitle.startsWith("Untitled") || noteTitle.startsWith("未命名")) {
    noteTitle = await tp.system.prompt("请输入工具卡片标题:");
    await tp.file.rename(noteTitle);
}

const today = tp.date.now("YYYY-MM-DD");
tR += `---
title: "${noteTitle}"
type: evergreen
status: stable
created: "${today}"
tags:
  - tool-card
---

# ${noteTitle}`;
-%>

## 一句话说明

## 安装

```bash
```

## 核心用法

### 最常用命令

```bash
```

### 进阶用法

```bash
```

## 典型场景

| 场景 | 命令/用法 |
|------|----------|
| | |

## 坑点

-

## 替代方案

| 工具 | 适用场景 | 差异 |
|------|----------|
| | | |

## 参考

-
