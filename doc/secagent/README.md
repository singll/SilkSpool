# SilkSecAgent 文档

> 工程位置：csai `/opt/silkspool/dsh/`；版本受控源在仓库 `bundles/dsh/templates/`。
> **文档按「滚动更新」维护**：模块契约随代码在该模块文档内更新；当前进度只在 [PROGRESS.md](PROGRESS.md)；历史一律归档。

## 入口

| 要做什么 | 从这里开始 |
|---|---|
| 看当前进度 / 最近结果 | **[PROGRESS.md](PROGRESS.md)**（只含当前状态 + 最近结果 + 通用规则） |
| 了解架构与模块职责 | [00-conventions.md](00-conventions.md)（全局契约宪法）→ 对应模块 `00–18` |
| 查术语 | [领域语言](../../bundles/dsh/CONTEXT.md) |
| 追溯历史（历次进度/更新日志/已完成节点、旧架构、历次升级方案与完整记录、会话模板） | [archive/](archive/) · [archive/progress-history.md](archive/progress-history.md) · [archive/upgrades/](archive/upgrades/) |
| 看最近一次全面检查（已闭环归档） | [archive/20-full-inspection-2026-09-19.md](archive/20-full-inspection-2026-09-19.md)（文档/代码/流程/运行态/漏洞产出/执行历史/UI；四轮修复全部落地，结论已回填 00/02/05/08/09/10/11/15/16/17） |
| 看上级猎面编排对标（已实施归档） | [archive/21-benchmark-strikeagent-flash-2026-09-21.md](archive/21-benchmark-strikeagent-flash-2026-09-21.md)（SRC 发现体系重构：覆盖账本/登录态判定/假设引擎/机器验证 oracle/Feedback Core；Phase 0–4 已实施验收，结论已回填 02/04/05/07/10/11/15/16） |
| 看项目型常驻任务设计（已实施归档） | [archive/22-campaign-task-2026-09-22.md](archive/22-campaign-task-2026-09-22.md)（Campaign 专项实体：派生/下发/监督/验收闭环 + 知识学习联动；task 域内重构，不新增域；已实施评审修复并部署验收 accept PASS=75，结论已回填 05/07/09/16/01/CONTEXT） |

## 文档结构（唯一形态）

```
doc/secagent/
  00-conventions.md … 18-migration.md   正式模块契约（常驻；每模块自维护，改动时同步 bump）
  PROGRESS.md                           当前进度（只含当前 + 最近结果 + 通用规则）
  README.md                             本页（入口 · 结构 · 治理规则）
  archive/                              历史（只读）：
    19-ui-unify.md                      看板 UI 全局统一重构（已实施验收，结论已回填 16/主题）
    20-full-inspection-2026-09-19.md    全面检查报告（四轮修复全部落地验收，结论已回填各模块）
    21-benchmark-strikeagent-flash-2026-09-21.md  SRC 漏洞发现体系重构（Phase 0–4 已实施验收，结论已回填各模块）
    22-campaign-task-2026-09-22.md       项目型常驻任务 Campaign 专项（已实施评审修复并部署验收，结论已回填 05/07/09/16/01/CONTEXT）
    progress-history.md                 历次进度/更新日志/已完成节点/批次守则
    upgrades/                           历次升级方案/记录/自学习专项/交接
    v5-README.md, REVIEW-*, SESSION-PROMPT.md, INDEX.md, …
```

模块索引：00 契约宪法 · 01 总线 · 02 漏洞 · 03 资产 · 04 接口 · 05 任务 · 06 事实 · 07 知识 · 08 授权 · 09 审批 · 10 执行 · 11 台账 · 12 报告 · 13 代理 · 14 FGS · 15 评测 · 16 看板与 UI 原生面 · 17 LLM 工具面 · 18 迁移。
（原 19-ui-surface 已并入 16；[archive/19-ui-unify.md](archive/19-ui-unify.md) 为已完成的 UI 视觉/交互统一专项，非常驻模块契约，只读。）

## 文档治理规则

### A. 目录整洁：正式文档 vs 临时文档

1. **根目录只放正式常驻文档**：`doc/secagent/` 根下只允许 `00–18` 正式模块契约、`PROGRESS.md`、`README.md`，以及**明确在办**的专项文档；已完成者一律移入 `archive/`（如 [archive/19-ui-unify.md](archive/19-ui-unify.md)）。
2. **README 是唯一权威索引**：只有登记在本 README「文档结构 / 模块索引」中的文档，才算**最新正式文档**；未登记者不得被当作现行真相源引用。
3. **临时文档完成后必须归档**：任何专项设计 / 审查 / 复盘 / 会话模板等临时文档，一旦完成（结论已回填、实施已验收、或被正式文档取代），**必须移入 `archive/`（只读）并从 README 正式索引移除或标注「已归档」**；根目录不得长期滞留已完成的临时文档。

### B. 同步与防漂移

4. **临时文档收尾必须同步**：临时 / 专项文档完成后，必须把其中**属于正式契约的结论**回填到对应正式模块文档（例：19-ui-unify → 16-dashboard + 主题规范），**再**归档；不得让结论只存活在临时文档里。
5. **系统更新即时回填**：每次代码改动 / 上线 / 升级，必须在**对应模块文档**内同步版本、契约、actor/事件/未实现项与验收证据；当前进度只在 [PROGRESS.md](PROGRESS.md) 记录「结果 + commit」。未实现的设计项须显式标注，不得写成现行机制。
6. **进度单一**：不再新建「最新进度 / 本次升级 / 复盘」副本；历次进度与更新日志统一在 [archive/progress-history.md](archive/progress-history.md)。
7. **历史只归档**：旧版本、旧状态快照、已完成的方案与记录移入 `archive/`，只读不改写；导航链接随结构调整同步修正。

### C. 真相源

8. **真相源优先级**：术语以 `bundles/dsh/CONTEXT.md` 为准；全局契约冲突以 [00-conventions.md](00-conventions.md) 为上位；已部署状态须有运行态证据（`spool`），历史数字不自动代表今天。
