# SilkSecAgent 文档

> 工程位置：csai `/opt/silkspool/dsh/`；版本受控源在仓库 `bundles/dsh/templates/`。
> **文档按「滚动更新」维护**：模块契约随代码在该模块文档内更新；进度与更新只在一个文件里滚动追加；历史一律归档。

## 入口

| 要做什么 | 从这里开始 |
|---|---|
| 看进度 / 最近改了什么 / 升级记录 | **[PROGRESS.md](PROGRESS.md)**（唯一进度与更新文档，最新在最上 §〇） |
| 了解架构与模块职责 | [00-conventions.md](00-conventions.md)（全局契约宪法）→ 对应模块 `00–19` |
| 查术语 | [领域语言](../../bundles/dsh/CONTEXT.md) |
| 追溯历史（旧架构/旧状态/历次升级方案与完整记录/会话模板） | [archive/](archive/) · [archive/upgrades/](archive/upgrades/) |

## 文档结构（唯一形态）

```
doc/secagent/
  00-conventions.md … 19-ui-surface.md   模块契约（每模块自维护，改动时同步 bump）
  PROGRESS.md                            唯一进度 + 更新日志（滚动）
  README.md                              本页（入口与结构）
  archive/                               历史（只读）：
    upgrades/                            历次升级方案/记录/自学习专项/交接
    v5-README.md, REVIEW-*, SESSION-PROMPT.md, INDEX.md, …
```

模块索引：00 契约宪法 · 01 总线 · 02 漏洞 · 03 资产 · 04 接口 · 05 任务 · 06 事实 · 07 知识 · 08 授权 · 09 审批 · 10 执行 · 11 台账 · 12 报告 · 13 代理 · 14 FGS · 15 评测 · 16 看板 · 17 LLM 工具面 · 18 迁移 · 19 UI 原生面。

## 维护规则

1. **单一进度文档**：不再新建「最新进度/本次升级/复盘」等副本；进度、上线状态、变更与升级记录统一追加到 [PROGRESS.md](PROGRESS.md) §〇 更新日志（滚动，最新在上）。
2. **模块自维护**：一个模块的契约/actor/事件/验收写在该模块文档内；代码改动时同步该文档，不另建文档。
3. **历史只归档**：旧版本、旧状态快照、已完成的升级方案与记录移入 [archive/](archive/)，只读不改写；导航链接随结构调整同步修正。
4. **真相源优先级**：术语以 `bundles/dsh/CONTEXT.md` 为准；全局契约冲突以 [00-conventions.md](00-conventions.md) 为上位；已部署状态须有运行态证据，历史数字不自动代表今天。
