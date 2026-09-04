---
name: sec-blackboard
description: 黑板纪律——跨会话共享事实的读写规范。任务开局读黑板，过程中即时写凭据/存活/已试路径，避免重复劳动和状态丢失。
---

# 黑板纪律

> **新事实优先 `fact_upsert`**（事实图谱，带生命周期/关联/置信度）。blackboard 是兼容通道，仅用于 `[env-issue]` 前缀键（环境故障速记）与 timeline 日期键（只追加流水）——其余 key 前缀（cred/alive/tried/note/waf）为新任务时改走 facts 分类写入。

1. **开局必读**：任务开始先 blackboard_get（`[env-issue]` 键）+ fact_search/asset_query 看目标已有资产与事实，不重复已完成的工作。
2. **即时写**（发现即写，不等任务结束）：
   - 凭据/会话：`cred:<host>:<role>` = 凭据引用（**只写 .env 变量名或"见凭据库"，绝不写明文密码**）
   - 存活状态：`alive:<host>` = 端口/标题/时间
   - 已试路径：`tried:<host>:<path>` = 结果（避免重复 fuzz）
   - 中间结论：`note:<target>:<topic>` = 一句话结论
3. **WAF/风控发现立即写**：`waf:<host>` = 厂商/行为特征，后续任务据此调整策略。
4. 黑板是事实不是推测：只写验证过的状态，推测写进会话讨论。
