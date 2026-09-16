# 学习增强链式会话 · L1 提示词（2026-09-16 起）

> 状态：**已完成（2026-09-16，csai 生产）**——实施记录见[设计 §11.2](../2026-09-12-self-learning-design.md)；下一包用 [L2 提示词](L2-prompt.md)。
>
> 用法：把下方「本次提示词」整段粘进新会话。每次完成一个 L 包后，会话末尾必须输出下一包的提示词（更新状态行 + 包名 + 阅读入口），递归直到 L6 完成。
> 真相源：[自学习专项设计](../2026-09-12-self-learning-design.md) · [v5 PROGRESS](../../v5/PROGRESS.md) · [会话模板](../../v5/SESSION-PROMPT.md)

## 本次提示词（复制以下全部内容）

```text
你是 SilkSecAgent 的协作 agent。本次任务：实施自学习专项 L1（证据与执行学习记录）。

先读（按序，不要跳读）：
1. doc/secagent/v5/SESSION-PROMPT.md（执行纪律与操作红线）
2. doc/secagent/upgrades/2026-09-12-self-learning-design.md（全文；重点 §3 执行学习记录、§3.3 证据发布与保留、§11 的 L1 行）
3. doc/secagent/upgrades/2026-09-12-self-learning-design.md §11.1（L0 已实施记录——本次在前置已完成的前提下开工）
4. 受影响域契约：doc/secagent/v5/10-exec.md、07-know.md、11-ledger.md、14-fgs.md、02-vuln.md

当前基线（2026-09-16，勿重复验证除非证据过期）：
- 生产 DSH 0.1.5-rc.2 已切换，U4 观察期至 2026-09-18T14:16:35Z；若仍在观察期内部署，记入 U4 基线变更。
- L0 已上线：kb 缺列/复验闭环、守卫异常显式失败、订阅 partial 可见（ok:true+partial:true 进重试链）、llm_probe unsupported 标签、eval-run.js v5 总线版。契约 bus 52/52、know 26/26、task 29/29、eval 19/19。

L1 交付（设计 §3/§3.3 + §11 L1 行）：
1. exec 域证据发布：worker staging → 宿主校验 run 归属 → 复制到服务端 results/<run_id>/ 并生成 manifest+SHA-256（路径穿越/软链逃逸/类型/大小/写完校验，安全文件句柄），新增 exec_evidence_publish 命令（system actor）+ exec.evidence.published 事件。
2. vuln 域证据挂载：vuln_evidence_attach 命令（finding_id + 已发布 exec evidence_ref，网关核 Program/权限）+ vuln.evidence.attached 事件。
3. know 域学习记录：learning_episodes 表（ensureCol/建表幂等，owner=know）+ know_episode_record 命令（reactor actor，订阅 exec.run.completed / vuln 判定事件）；六类结果分类（confirmed/valid_clean/inapplicable/blocked_auth/infra_error/inconclusive）；宿主注入关联，不采信模型自填归属；同一 episode 不覆写，(source_event_id, consumer_version) 唯一去重，重复回放不重复记功。
4. FGS 快照：宿主在 task 收尾前取 fgs_export 快照固定进 episode 引用，不读"当前图"。
5. 验收：正常/超时/取消/无身份/重启/晚到事件均正确归因；越权文件被拒；重复回放零重复记功；契约测试全绿（bus/know/task/eval/exec/vuln 全套）。

纪律：
- 实施前同步受影响域文档（07-know.md 增 episode 表与新命令契约；10-exec.md 增证据发布；02-vuln.md 增证据挂载）与 manifest；设计文档不直接覆盖现行契约。
- 源码 /home/ubuntu/SilkSpool/bundles/dsh/templates/；部署：rsync -a bundles/dsh/ /opt/SilkSpool/bundles/dsh/ 后 spool bundle dsh setup csai；远程一律走 spool；禁止 docker compose down；数据库检查只读。
- 一次只做一个包；L2–L6 不在本次范围。

完成后：
1. 更新设计文档状态行与 §11.1 后续实施记录（新增 §11.2 L1 实施记录）、PROGRESS.md「升级与学习实施」行。
2. 一次中文 commit + push，最终回复报告 commit hash。
3. 输出下一会话提示词：L2（候选规程与来源版本），格式同本提示词——更新状态行（L0/L1 已上线）、阅读入口不变、交付改为设计 §4/§11 L2 行（外部资料及偏差转候选 revision；先交付 P1 中一种类型——建议授权类 authz_diff——的完整卡片切片；know_revision_propose/knowledge_revisions 表），验收改为 L2 行（前置/对照/停止/证据/来源齐全；内容变化不覆盖已发布版本；坏资料不触发执行）。
```

## 后续包提示词骨架（每次会话结束时生成下一段）

| 包 | 状态行更新 | 交付（设计对应节） | 验收（设计 §11） |
|---|---|---|---|
| L2 | L0/L1 已上线 | §4 资料→候选 revision；P1 一类完整卡片切片 | 前置/对照/停止/证据/来源齐全；内容变化不覆盖已发布版本 |
| L3 | L0–L2 已上线 | §7 真实模型行为层 + v5 fixture runner + 分组开发/隐藏集 + baseline 配对报告（eval_run_candidate） | 三类评测分别出报告；隐藏答案不可读；失败/中断不记成功 |
| L4 | L0–L3 已上线 | §6 收口旧写入口（exp_store/pb_save/vc_save/exp_update 只产候选）；扩展 knowledge-adopt（artifact_kind+revision+eval_report+scope）；know_revision_assess/publish + know_release_revoke | 模型不能直升；批准绑定哈希；effect 重试不重复发布；灰度失败可恢复 |
| L5 | L0–L4 已上线 | §8 分层检索、曝光/采用/结果拆分计数、覆盖补建、反馈撤回重算（know_feedback_ingest） | 旧版本/跨项目/失效负知识不误召回；计分可重算 |
| L6 | L0–L5 已上线 | §9/§10 学习面板（最近学到的/待复核/已启用/效果成本/已撤回）、逐域视图、调度器独立切换（先验证 task.claim/finish/reap 等价再停旧循环） | 人能追溯一次学习到结果并撤回；只有一个调度持锁者 |

完成 L6 后不再输出新提示词，改为输出关账清单（基线/候选报告、固定版本、Program 可见范围、发布/effect/回退记录、纠错撤回验证、未覆盖场景）。
