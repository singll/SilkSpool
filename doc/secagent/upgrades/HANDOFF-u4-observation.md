# SilkSecAgent v5 — DSH 0.1.5-rc.2 升级 U4 观察期 Handoff（2026-09-18 刷新版）

你是 SilkSpool 的 DSH 升级工程助手。本文件是 U4 观察期第二次巡检后的可自续提示词。前序上下文见 [执行记录](2026-09-12-dsh-0.1.5-rc.2-record.md) §14、§14.5–§14.8 及 [时间线](README.md)。

---

## 一、当前状态（2026-09-18T01:02Z 第二次巡检后）

- 生产：**0.1.5-rc.2**、MainPID **4010742**、NRestarts=0、active/running（观察期内自学习 L1–L6 部署触发的全部重启均为预期动作，§14.8 实测确认）。
- Git 提交：`0c6d53c docs: DSH 0.1.5-rc.2 U4 观察期第二次巡检与自学习 L0-L6 验收记录`。
- 自学习专项 **L0–L6 全部验收通过（2026-09-18）**：r1 `rev_mu4vc96e82991e` published + release `rel_mu54qbjza6defb` active；r2 retired/revoked（撤回演示链终态正确）；三张 P1 卡（VC-BIZFLOW/XSS/SSRF-001）candidate；episode 投影正常。详见[自学习设计 §11.1–§11.7](2026-09-12-self-learning-design.md) 与[执行记录 §14.8](2026-09-12-dsh-0.1.5-rc.2-record.md)。
- §14.8 巡检（2026-09-18T01:02Z）：scheduler.lock pid=MainPID 唯一持锁、journal 无崩溃、vault 回流 errors=0、revision/release 投影正确；**state.json expired=false，观察期未满，关账未执行**。
- 定时任务链：bytedance `#16 recon → #19 广度 → #100008 深挖`；meituan `#17 recon → #37 广度 → #100007 深挖`。每日锚点 北京 03:00/03:10。
- 备份：`/opt/silkspool/dsh/backups/opt-20260916/`（asset-graph.db + 被替换插件 + 根模板 + tasks-before.tsv）、`opt-20260916-r2/`（第二轮被替换文件）、`opt-20260916/tools.d/`（tools.d 原文件）。
- 发布目录：`/opt/silkspool/dsh-upgrades/20260913-rc2/dsh-release-2non9v70`。
- `state.json`：`phase=observing`，`observation_until=2026-09-18T14:16:35.602762+00:00`（**下一次会话时很可能已过期——先执行 §二 步骤 1 判定**）。
- 冻结点：`dsh-snapshot-ready-8jhp928l`，manifest SHA `fdeea4b34fce80a2f2c742d6caa6bccb170449bc9b62f005d4b1ab1aaac5a0cd`。
- 兼容别名：37 个，`deprecated_use` 累计 180，最后一条 2026-09-15T07:07:10Z（切流前）；切流后增量 0；**新闸口 2026-09-22T15:07:10.543+08:00**，未到期不删除。
- §14.5 首次巡检（2026-09-15T14:57Z）与 §14.8 第二次巡检（2026-09-18T01:02Z）均全部健康。

---

## 二、U4 关账任务（observation_until 到期后执行）

**所有远程操作走 `spool exec csai`，禁止绕过；禁止 `docker compose down`（尤其 n8n）；证据驱动，未执行项写「未执行」不填「通过」。**

### 步骤 1：确认观察期满

```bash
spool exec csai "sudo python3 -c 'from datetime import datetime,timezone; import json; s=json.load(open(\"/opt/silkspool/dsh-upgrades/20260913-rc2/dsh-release-2non9v70/state.json\")); until=s[\"observation_until\"]; print(\"observation_until:\",until); print(\"expired:\", datetime.now(timezone.utc) >= datetime.fromisoformat(until))'"
```

若未满则报告剩余时间，按 §6 路径 A 处理（不提前关账）。

### 步骤 2：生产健康快照

确认服务状态（MainPID、NRestarts=0）、`scheduler.lock` 持锁存活、journal 无崩溃、vault 回流 `errors=0`。记录 MainPID 作为基准。

### 步骤 3a：新冻结点捕获

```bash
spool exec csai "sudo python3 /opt/silkspool/dsh-upgrades/20260913-rc2/recovery-tools/dsh-upgrade-freeze.py capture --config /opt/silkspool/dsh-upgrades/20260913-rc2/freeze-config-current.json --work-dir /opt/silkspool/dsh-upgrades/20260913-rc2 --hold 2>&1"
```

记录新 `state-dir` 路径（形如 `dsh-freeze-XXXXXXXX`）。

### 步骤 3b：preserve（切流后新增业务数据对账）

```bash
spool exec csai "sudo python3 /opt/silkspool/dsh-upgrades/20260913-rc2/recovery-tools/dsh-upgrade-release.py preserve --release-dir /opt/silkspool/dsh-upgrades/20260913-rc2/dsh-release-2non9v70 --freeze-state /opt/silkspool/dsh-upgrades/20260913-rc2/<NEW_FREEZE_DIR> 2>&1"
```

将 `<NEW_FREEZE_DIR>` 替换为步骤 3a 得到的 state-dir。报告 preserve 产物 SHA-256。

### 步骤 3c：恢复写者

```bash
spool exec csai "sudo python3 /opt/silkspool/dsh-upgrades/20260913-rc2/recovery-tools/dsh-upgrade-freeze.py resume --state-dir /opt/silkspool/dsh-upgrades/20260913-rc2/<NEW_FREEZE_DIR> 2>&1"
```

确认 `systemctl is-active silksecagent.service` 返回 active，NRestarts=0。

### 步骤 4：对账核对

对比新冻结点 vs 原冻结点的不变量差异：44 张表行/主键、outbox 事件文件字节前缀、事件字节、证据哈希。差异只允许 observation 期间的时间变化与切流后新增数据。非预期变化须显式报告并补偿。报告写入 §14.6。

### 步骤 5（可选）：L0–L6

自学习增量按 [自学习设计](2026-09-12-self-learning-design.md) 执行，与平台关账独立进度，不混入平台验收。

### 步骤 6：文档更新

- 追加 §14.6 到 [执行记录](2026-09-12-dsh-0.1.5-rc.2-record.md)
- 更新 §7 U4 行「已完成」或「未通过，已记录原因」
- 更新 [时间线](README.md)
- 如 L0–L6 也完成，更新 [PROGRESS](../../v5/PROGRESS.md)

### 步骤 7：提交

```bash
git add doc/secagent/upgrades/2026-09-12-dsh-0.1.5-rc.2-record.md doc/secagent/upgrades/README.md doc/secagent/v5/PROGRESS.md
git commit -m 'docs: DSH 0.1.5-rc.2 U4 关账记录'
```

---

## 三、工作纪律

1. 所有远程操作走 `spool exec csai`；禁止直接 SSH/curl/Docker；**禁止 `docker compose down`**（尤其 n8n）。
2. 证据驱动：每步产出报告文件 + SHA-256；未验证项写「未执行」，不填「通过」。
3. 不混淆口径：副本验证 ≠ 生产观察；基础健康检查 ≠ 升级完成。
4. 回滚安全优先：Session V3 回滚须走完整冻结点恢复 + `RENAME_EXCHANGE` 回切，不能只改 `package.json`。
5. 切流后新增数据：先冻结并额外保存到独立目录，不自动丢弃，不承诺零 RPO。
6. 数据不变量门禁：44 表行/主键、outbox 事件文件字节前缀、证据哈希逐项核对，非预期变化显式报告并补偿。
7. 诚实记录：失败证据保留，不掩盖、不删减。
8. 禁止 `git add -f`；`doc/hosts/config.ini/keys` 等敏感文件不入库。
9. 37 个兼容别名在新闸口（2026-09-22T15:07:10.543+08:00）前不得删除。
10. 不改表名不迁库（`ensureCol` 幂等列演进）。

---

## 四、进度快照（给新会话的初始坐标）

- **Git 提交**：`0c6d53c docs: DSH 0.1.5-rc.2 U4 观察期第二次巡检与自学习 L0-L6 验收记录`（本文件提交见其下一笔）
- **§14.8 第二次巡检（2026-09-18T01:02Z）**：state.json `expired=false`（剩余约 13h14m）→ 路径 A；MainPID 4010742 不变、NRestarts=0、journal 无崩溃、scheduler.lock 唯一持锁、vault errors=0；know.revision_list / release_list / episode_list 只读复核全部符合预期。**自学习 L0–L6 验收通过（用户确认）**；U4 关账仅剩观察期满后的步骤 3a→3b→3c→4→6→7 未执行。
- **发布目录**：`/opt/silkspool/dsh-upgrades/20260913-rc2/dsh-release-2non9v70`，`state.json` `phase=observing`
- **observation_until**：`2026-09-18T14:16:35.602762+00:00`
- **冻结点**：`dsh-snapshot-ready-8jhp928l`，manifest SHA `fdeea4b34fce80a2f2c742d6caa6bccb170449bc9b62f005d4b1ab1aaac5a0cd`
- **生产版本**：`0.1.5-rc.2`、MainPID `3893882`、NRestarts `0`、active/running（2026-09-16 两次优化部署重启，旧基线 3848865/3883528 作废）
- **§14.6 优化部署**：2026-09-16 定时任务链式调度 + 工具稳定性优化上线（本地 384 合约全过、生产哈希一致、重启后 16 域注册成功、outbox 0 异常）
- **§14.7 巡检与第二轮修复**：2026-09-16 日志巡检（部署后 0 错误复发，历史报错均已归因）+ 第二轮修复上线（本地 387 合约全过、生产哈希一致、重启后 15 域注册成功、NRestarts=0）
- **§14.5 巡检**：首次巡检完成（2026-09-15T14:57Z），全部健康；别名闸口顺延至 2026-09-22T15:07:10+08:00
- **L1 基线变更（2026-09-16T16:23:39Z 重启生效）**：自学习专项 L1（证据与执行学习记录）在观察期内部署上线——`spool bundle dsh setup csai` 全量推送 + 各域契约测试硬门槛全绿 + owns×sandbox 交叉断言 69 项 PASS + 服务重启加载。变更面：exec/know/vuln/task/fgs 五域插件 + know sqlite 后端（新增 `learning_episodes` 表，幂等建表已在生产库演进）。部署后冒烟：服务 active NRestarts=0、journal 无异常、know_episode_list 真库查询 ok、三条新命令 actor 闸实测拒绝、vuln_evidence_attach 未发布证据实测拒（E_EVIDENCE_REQUIRED）。首次 setup 曾因 task 套件回引后组装 fgs 插件中止（已修为桩域并复跑通过；期间服务保持旧代码运行，无窗口期事故）。MainPID 已变更是预期内（重启加载），U4 关账对账时以本次为最新基线。详见[自学习设计 §11.2](2026-09-12-self-learning-design.md)。
- **L0/L1 已上线**（历史行，后续 L2–L6 见下）
- **L2 基线变更（2026-09-17T01:44Z 前后重启生效，MainPID 3911269→3931430）**：自学习专项 L2（候选规程与来源版本）在观察期内部署上线——`spool bundle dsh setup csai` 全量推送 + 各域契约测试硬门槛全绿（know 42/42 等 14 域 + 总线）+ owns×sandbox 交叉断言 70 项 PASS + 服务重启加载。变更面：know 域插件 + know sqlite 后端（新增 `knowledge_revisions` 表，幂等建表已在生产库演进）+ 版本受控候选卡种子（`data-seed/know-revisions/vc-authz-r1.json` → setup 内 sec-bus-cli 幂等提案）+ manifest 登记；其余 13 域插件代码未变。部署后冒烟：服务 active NRestarts=0、journal 无异常、knowledge_revisions 生产库只读核对（表+三索引+候选行 status=candidate）、know_revision_list 真库查询 ok、actor 闸生产实测拒（human → E_ACTOR_FORBIDDEN）、种子候选 digest 与本地确定性一致（sha256:63fa230a…）。首次 setup 曾因种子步动词名误用全前缀（`know.know_revision_propose`，总线只认去前缀名）中止于 know 段（已修为 `know.revision_propose` 并复跑通过；首跑时序为 post-push hook 先重启旧代码→setup 中止于种子步，进程内始终旧代码，无窗口期事故）。MainPID 变更系预期内重启，U4 关账对账时以本次为最新基线。详见[自学习设计 §11.3](2026-09-12-self-learning-design.md)。
- **L3 基线变更（2026-09-17T04:03–04:22Z 三次重启生效，MainPID 3931430→3946516）**：自学习专项 L3（独立评测）在观察期内部署上线——三次 `spool bundle dsh setup csai`（①插件+迁移种子：eval/know 域 + eval-file/know-sqlite 后端 + 6 个 fixture 与 2 个冻结数据集种子 + 契约用例种子 7→10；②`eval-candidate-run.js` runner 归位；③LLM key 链补 `BELLKEEPER_LLM_API_KEY`）——各域契约测试硬门槛全绿（know 50/50、eval 27/27，14 域 + 总线全套）+ owns×sandbox 交叉断言 70 项 PASS + 服务重启加载。变更面：eval/know 两域插件 + eval-file/know-sqlite 两后端 + manifest + 数据种子；其余 12 域插件代码未变。部署后冒烟：服务 active NRestarts=0、journal 无异常、actor 闸生产实测拒（model → E_ACTOR_FORBIDDEN）、trial-l3-prod-2 真实配对评测 eligible（tp=1/tn=1/infra 1/1）、know 订阅链 candidate→evaluating→eligible 走通（eval_report_ref 锚定）、幂等回放与 eligible 不可再评实测、INV-6 隐藏集可见域实测（model 只见元数据桩）、eval_stats 标签去重实测（46 行→35 唯一 finding）。两次已知行为记入设计 §11.4（host_restart 不产生 report.built，revision 停留 evaluating 可 abort/自愈；孤儿扫描与独立 runner 的启动竞态——trial-l3-prod-1 与一次 --llm-probe 冒烟因此中断重跑）。MainPID 变更系预期内重启，U4 关账对账时以本次为最新基线。详见[自学习设计 §11.4](2026-09-12-self-learning-design.md)。
- **L4 基线变更（2026-09-17 重启生效，MainPID 3946516→3952870）**：自学习专项 L4（受控晋升和撤回）在观察期内部署上线——`spool bundle dsh setup csai` 全量推送 + 契约测试硬门槛全绿（know 50→60、approval 16→19，本地 15 套件全套全绿）+ 服务重启加载。变更面：know/approval 两域插件 + know-sqlite 后端（新增 `know_releases` 发布账表，幂等建表已在生产库演进）+ approval-sqlite 后端（`setRequestStatus`）+ dashboard-rpc（五处 v4 直写兜底拆除改 fail-closed）+ sec-suite（v4 knowledge-adopt 直写改 fail-closed）+ seed-presets（persona 文本）+ know setup manifest 描述；其余 12 域插件代码未变。部署后冒烟：服务 active NRestarts=0、journal 无异常、know/approval/eval 注册成功、vault errors=0；actor 闸实测拒（model → know_revision_publish/exp_store 均 E_ACTOR_FORBIDDEN）；批准绑定哈希实测（错 digest → E_KNOW_REVISION_CHANGED）；有限灰度前置实测（无灰度直升 global → E_INVARIANT）；真实审批链端到端走通（request #21 knowledge-publish → approve → effect applied → release `rel_mu54qbjza6defb` active（family/authz）→ revision `rev_mu4vc96e82991e`（VC-AUTHZ-001 r1）published）；幂等实测（同键异参 E_IDEMPOTENT_CONFLICT，know_releases=1、published 事件=1）。VC-AUTHZ-001 r1 保持 published 不回滚（首个端到端里程碑留存产物）。MainPID 变更系预期内重启，U4 关账对账时以本次为最新基线。详见[自学习设计 §11.5](2026-09-12-self-learning-design.md)。
- **L5 基线变更（2026-09-17 重启生效，MainPID 3952870→3982156）**：自学习专项 L5（检索与计分）在观察期内部署上线——三次 `spool bundle dsh setup csai`（①L5 主体首装：pnpm store 冲突（ERR_PNPM_UNEXPECTED_STORE，profile node_modules 链接自 `/opt/silkspool/dsh/.pnpm-store`，pnpm v11 全局配置缺失）→ 持久化 `~/.config/pnpm/config.yaml` storeDir 修复；②反馈桥 inject 修复（loader 阶段裸取 ctx.messageFeedback 致 plugin tree 加载失败、服务 crashloop——改为 `ctx.inject(['messageFeedback','secDomainBus'])` 声明式探测，缺失即显式 unsupported 不 crash）；③family 作用域修正 + C31 全量重建补 feedbackArtifacts 键集）——契约测试硬门槛全绿（know 60→70，本地 14 域全套 395/395 + setup 内双跑同绿）+ owns×sandbox 交叉断言 PASS + 服务重启加载。变更面：know 域插件 + know-sqlite 后端（新增 `know_exposures`/`know_adoptions`/`know_feedback`/`know_scores`/`know_gaps` 五表，幂等建表已在生产库演进）+ 新增 `@silksec/sec-feedback-bridge`（web profile 专用）与 setup 8.591b 节 + ledger 域被订阅声明（`ledger.card_usage.logged → know`）；其余域插件代码未变。部署后冒烟：服务 active NRestarts=0、journal 无异常、know/eval 注册成功、反馈桥已挂载（状态文件 ok）；`know_retrieval_explain` 实测（VC-AUTHZ-001 r1 family/authz 灰度 + 卡面 surface=api 谓词入召回 rank 320，跨 Program/失效负知识排除路径实测）；`know_feedback_ingest` actor 闸实测拒（model → E_ACTOR_FORBIDDEN）；幂等实测（同 id+revision 重放 duplicate:'id_revision'）；C31 重放重建实测（rebuilt=1）；冒烟反馈已 tombstone 撤销、计分投影归零。VC-AUTHZ-001 r1 保持 published 不回滚。MainPID 变更系预期内重启，U4 关账对账时以本次为最新基线。详见[自学习设计 §11.6](2026-09-12-self-learning-design.md)。
- **L6 基线变更（2026-09-17 四次重启生效，MainPID 3982156→3995975→4001116→4005781→4010742）**：自学习专项 L6（完整运营体验，专项收官）在观察期内部署上线——四次 `spool bundle dsh setup csai`（①L6 主体：学习面板/证据对照/逐域视图 + 调度器独立切换 + goal 四类节奏 + C32 vault 同步；②eval 孤儿扫描新鲜度闸修复——sec-bus-cli 独立进程误标宿主在飞 run 为 host_restart，生产实测两次；③孤儿回收事件流修复——backend.orphanScan 直写绕过事件流致 candidate revision 永卡 evaluating（r2 生产实测卡死，手动 abort 恢复），改 reapOrphans 走 run_finish 受控动词 + apply() 延迟初扫 + 10min 周期扫描；④manifest 补登三张 P1 种子卡——首轮漏登致生产未种入）——契约测试硬门槛全绿（know 70→73、task 30→38、exec 23→24、eval 28→29、scope 15/15，本地 15 套件全套 + sec-suite 15/15）+ 服务重启加载。变更面：know/task/exec/eval/scope 五域插件 + eval-file 后端 + dashboard-rpc + dashboard client（「学习」tab）+ sec-suite（v4 startScheduler 停用，代码保留作回滚路径）+ P1 种子卡四张 + manifest；其余域插件代码未变。部署后冒烟：服务 active NRestarts=0、journal 无异常、全域注册成功；**调度唯一持锁者实测**（scheduler.lock pid=MainPID、journal 双侧日志「task 调度循环已启动（唯一持锁者）」+「v4 调度循环已停用」）；worker 全链实测（任务 #100020 run_now→claim→spawn→worker 执行→finish done，run wmu5q2yfx818e）；**撤回演示链实测**（VC-AUTHZ-001 r2 提案→评测 eligible→审批 #22→发布 active→Q23 全链→C27 撤回→r1 自动恢复 active→change-retest 任务 #100021 自动生成）；看板 RPC 三端点真实模块+生产数据实测（learningOverview 五问/learningTrace 全链/learningRevokeRelease 参数闸）；三张 P1 卡已种入 candidate。VC-AUTHZ-001 r1 终态保持 published+active。MainPID 变更系预期内重启，U4 关账对账时以本次为最新基线。详见[自学习设计 §11.7](2026-09-12-self-learning-design.md)。
- **L0–L6 已上线并验收通过（2026-09-18，§14.8 复核 + 用户确认）；U4 观察期至 2026-09-18T14:16:35Z，关账步骤未执行**

---

## 五、关键路径（先读这些）

- [执行记录 §14–§14.5](2026-09-12-dsh-0.1.5-rc.2-record.md)
- [升级方案](2026-09-12-dsh-0.1.5-rc.2-plan.md)
- [时间线](README.md)
- [v5 进度总表](../../v5/PROGRESS.md)
- [自学习设计](2026-09-12-self-learning-design.md)
- [领域语言](../../../bundles/dsh/CONTEXT.md)
- 工具：`/opt/silkspool/dsh-upgrades/20260913-rc2/recovery-tools/`（与本地 `bundles/dsh/templates/` SHA 一致）

---

## 六、自续规则

**本会话结束前，你必须判断升级是否真正完成，并二选一：**

### A. 若仍有未完成阶段（当前默认：U4 观察期未满）

1. 把本次会话的结论、新证据路径与 SHA-256、生产实测状态（版本 / MainPID / NRestarts / 健康）追加写入执行记录下一个 §小节，更新 §7 表与时间线。
2. `git add` 相关文件（禁止 `git add -f`）并提交，记录新 commit 哈希。
3. **重写 `HANDOFF-u4-observation.md`**：更新「四、进度快照」为最新哈希 / commit / observation 状态，更新「二、任务」为下一阶段的具体步骤。
4. 在会话最终回复里，把「给下一个新会话的提示词」整段贴出，其正文 = 本文件的「一~六」结构（已刷新版），并要求下一个会话同样在结束时执行本「六、自续规则」。链条自续，直到情况 B。

### B. 仅当以下条件全部满足时

- U0–U4 全部关账（§7 表全绿）
- L0–L6 按专项设计验收通过
- 用户明确确认

此时：执行记录写明「升级完成」，README 时间线标「已完成」，PROGRESS 同步。不再生成新提示词，改为一句总结 + 后续运维建议。链条终止。

**判定纪律**：观察期未满、任一 § 步骤缺证据、任何非预期不变量差异未归因、L0–L6 未验收——一律走 A，不得因为「服务在跑」就宣布升级完成。
