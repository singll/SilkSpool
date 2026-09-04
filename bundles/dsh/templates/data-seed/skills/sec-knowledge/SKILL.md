---
name: sec-knowledge
description: 记忆治理纪律——写记忆前三问、开局检索、用完回执、用到即复验、规则先验层加载。所有执行型角色开工/收尾时使用。
---

# 记忆治理纪律（memcore）

记忆分三层，写入前必须回答"三问"并把答案写进 justification（≥10字，非占位）：

1. **它会过期吗？** → 会：黑板/事实（ephemeral ≤30天 或 durable 需复验）；不会且换目标仍有用：才配进经验卡
2. **换目标还有用吗？** → 只对特定目标有用：进 facts/finding，**禁止进经验卡**；可迁移方法论：才进 exp_store
3. **谁会读它？** → 执行任务要读：ephemeral/durable；只有复盘要看：timeline（带日期快照键）

## 类别速查

| 内容 | 去处 | mem_class |
|---|---|---|
| 环境故障/工具异常 | 黑板 `[env-issue]` 前缀 key | ephemeral（TTL 自评 1-30 天） |
| 存活清单/扫描台账/调度流水 | 黑板带日期键 | timeline（只追加，不改写） |
| 目标事实（指纹/配置/负结果） | fact_upsert | durable（30天复验）或 note 类 ephemeral |
| 可迁移方法论 | exp_store | candidate 起步，附 justification |
| 成功调用链 | pb_save | permanent，附 justification |

## 规则先验层（data/rules/）

命中技术栈（指纹/fp_add）后、上专项扫描前：查 `data/rules/<域>/<栈>.md` 是否存在（如 web/spring.md、web/nextjs.md、web/selfhosted-supabase.md、php/thinkphp.md），存在则读入作为该栈审计先验（入口点模式/特有攻击面/验证要点）。

**SRC 评级规则（rules/src/）**：recon 评分打标前读 `src/asset-scoring.md`；漏洞定级、写报告、提交判断前读 `src/severity-rating.md`——定级不膨胀、不确定往低报。这层是**人工蒸馏的静态先验**，与 memcore 经验卡（实战后验）互补：先验给方向，后验给打法。复盘时发现某栈规则缺失或有新心得 → 在复盘报告里提议新增/修订规则文件（人工评审后落盘，agent 不自写规则层）。

## 流程纪律

四条运行态纪律（开局检索/用完卡回执/cooling 复验/沉淀前查重）+ 红线（故障/状态/日期清单禁入 persona/objective）由 memcore 引擎**自动维护在工作区 AGENTS.md 受管区块**——以该区块为准（它还实时带高分卡与环境故障状态），此处不再重复全文，避免双源漂移。

## 规则先验层加载口径（与 sec-pipeline 技能互补）

- 开局扫描技术索引：`rules/src/technique-index.md`（打穿短表）「认什么」列对现场特征
- 命中技术栈后读对应 `rules/web|php/<栈>.md` 组件先验
- 评级/定级/报告前读 `rules/src/{asset-scoring,severity-rating}.md`；股权判据读 `rules/src/equity-gate.md`
