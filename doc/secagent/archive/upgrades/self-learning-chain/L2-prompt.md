# 学习增强链式会话 · L2 提示词（2026-09-16 起）

> 用法：把下方「本次提示词」整段粘进新会话。每次完成一个 L 包后，会话末尾必须输出下一包的提示词（更新状态行 + 包名 + 阅读入口），递归直到 L6 完成。
> 真相源：[自学习专项设计](../2026-09-12-self-learning-design.md) · [v5 PROGRESS](../../../PROGRESS.md) · [会话模板](../../SESSION-PROMPT.md)
> 前序：[L1 提示词](L1-prompt.md)（已完成，实施记录见设计 §11.2）

## 本次提示词（复制以下全部内容）

```text
你是 SilkSecAgent 的协作 agent。本次任务：实施自学习专项 L2（候选规程与来源版本）。

先读（按序，不要跳读）：
1. doc/secagent/SESSION-PROMPT.md（执行纪律与操作红线）
2. doc/secagent/archive/upgrades/2026-09-12-self-learning-design.md（全文；重点 §4 从资料和实战偏差学成漏洞规程、§6.1 新 revision 状态机、§6.3 最小接口增量、§11 的 L2 行）
3. doc/secagent/archive/upgrades/2026-09-12-self-learning-design.md §11.1/§11.2（L0/L1 已实施记录——本次在前置已完成的前提下开工）
4. 受影响域契约：doc/secagent/07-know.md、11-ledger.md、10-exec.md、02-vuln.md、15-eval.md

当前基线（2026-09-16，勿重复验证除非证据过期）：
- 生产 DSH 0.1.5-rc.2 运行中（MainPID 以 HANDOFF-u4-observation.md §四 最新基线为准）；U4 观察期至 2026-09-18T14:16:35Z——若仍在观察期内部署，记入 U4 基线变更。
- L0 已上线：kb 缺列/复验闭环、守卫异常显式失败、订阅 partial 可见、llm_probe unsupported 标签、eval-run.js v5 总线版。
- L1 已上线：exec_evidence_publish（system 专用证据发布+清单 SHA-256）、vuln_evidence_attach（INV-10 已发布清单核验）、learning_episodes 表 + know_episode_record（reactor 专用，六类结果，(source_event_id, consumer_version)+biz_key 双去重）、fgs_snapshot 收尾前固定进 task.finished payload。契约 14 域全绿（bus 52/52、know 31/31、task 30/30、exec 23/23、vuln 50/50、fgs 21/21、eval 19/19）。

L2 交付（设计 §4 + §11 L2 行）：
1. know 域候选版本：knowledge_revisions 表（owner=know，幂等建表；revision_id/artifact_kind/artifact_id/parent_revision_id/内容哈希/来源 episode 或文献版本/适用谓词/状态，发布内容不可原地覆盖）+ know_revision_propose 命令（model/script/dashboard；父版本+结构化改动+来源+适用条件；事件 know.revision.proposed）。
2. 两条输入通道转候选：外部资料（kb 文献版本）与实战偏差（episode）→ 候选 revision，不覆盖正在使用的卡片；坏资料（taint/抓取失败/来源不可信）只进候选或不进，绝不触发执行。
3. 首个完整卡片切片：P1 授权类（扩展现有 vuln_authz_diff）一张有版本的候选卡，按 §4.2 最小结构齐全——applies_to 前置/失效条件、hypothesis、minimal_probe、正/负对照、evidence_required、stop_conditions、fixtures、budget、失败解释与变更说明。
4. 验收（§11 L2 行）：前置/对照/停止/证据/来源齐全；内容变化不覆盖已发布版本；坏资料不触发执行；契约测试全绿（know/vuln/eval 及受影响域全套）。

纪律：
- 实施前同步受影响域文档（07-know.md 增 revisions 表与 know_revision_propose 契约；02-vuln.md 卡片结构切片）与 manifest；设计文档不直接覆盖现行契约。
- 源码 /home/ubuntu/SilkSpool/bundles/dsh/templates/；部署：rsync -a bundles/dsh/ /opt/SilkSpool/bundles/dsh/ 后 spool bundle dsh setup csai；远程一律走 spool；禁止 docker compose down；数据库检查只读。
- 测试只依赖 setup.sh 中先组装的域（L1 教训：task→fgs 回引曾致 setup 中止）；一次只做一个包；L3–L6 不在本次范围（评测/晋升门禁不做，候选不等于发布）。

完成后：
1. 更新设计文档状态行 + 新增 §11.3 L2 实施记录、PROGRESS.md「升级与学习实施」行。
2. 一次中文 commit + push，最终回复报告 commit hash。
3. 输出下一会话提示词：L3（独立评测），格式同本提示词——状态行改为「L0–L2 已上线」，交付改为设计 §7 + §11 L3 行（真实模型行为层、v5 fixture runner、分组开发/隐藏集、baseline 配对报告、eval_run_candidate），验收为 L3 行（三类评测分别出报告；隐藏答案不可读；标签去重和来源可追溯；失败/中断不记成功）。
```

## 后续包提示词骨架（每次会话结束时生成下一段）

| 包 | 状态行更新 | 交付（设计对应节） | 验收（设计 §11） |
|---|---|---|---|
| L3 | L0–L2 已上线 | §7 真实模型行为层 + v5 fixture runner + 分组开发/隐藏集 + baseline 配对报告（eval_run_candidate） | 三类评测分别出报告；隐藏答案不可读；失败/中断不记成功 |
| L4 | L0–L3 已上线 | §6 收口旧写入口（exp_store/pb_save/vc_save/exp_update 只产候选）；扩展 knowledge-adopt（artifact_kind+revision+eval_report+scope）；know_revision_assess/publish + know_release_revoke | 模型不能直升；批准绑定哈希；effect 重试不重复发布；灰度失败可恢复 |
| L5 | L0–L4 已上线 | §8 分层检索、曝光/采用/结果拆分计数、覆盖补建、反馈撤回重算（know_feedback_ingest） | 旧版本/跨项目/失效负知识不误召回；计分可重算 |
| L6 | L0–L5 已上线 | §9/§10 学习面板（最近学到的/待复核/已启用/效果成本/已撤回）、逐域视图、调度器独立切换（先验证 task.claim/finish/reap 等价再停旧循环） | 人能追溯一次学习到结果并撤回；只有一个调度持锁者 |

完成 L6 后不再输出新提示词，改为输出关账清单（基线/候选报告、固定版本、Program 可见范围、发布/effect/回退记录、纠错撤回验证、未覆盖场景）。
