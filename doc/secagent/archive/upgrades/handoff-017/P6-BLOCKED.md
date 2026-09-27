# ===== CHAIN BLOCKED (P6) =====

> 本文件是 P6 的终止记录（硬停止条件②：生产不变量出现 P5 白名单外差异）。**不存在 NEXT PROMPT (P7)**；U4 观察期未开始。恢复需用户按下方「恢复选项」决策后**重开 P6**（新冻结点/新候选/新 release）。

## 失败步

P6 · U3 生产切换 —— finalize 的 `pre_resume_invariants` 门禁失败（17 项白名单外差异），按预授权规则「白名单沿用 P5，允许项之外必须停下回滚」执行 rollback + freeze resume。

## 事实（时间/命令/退出码/关键输出）

- **窗口**：2026-09-27T10:26:44Z 冻结开始（写者 `frozen_at=10:27:37Z` 持有）→ **13:46:57Z** 回滚后恢复写者 = 3h19m20s；业务写者全程 0 写入，**RPO=0**。
- **通过项**：
  - 前置校验全绿（工具三点一致 `1e43d1be…`；发现并修复 spool 运行时副本 4 文件滞后 → `rsync -a bundles/dsh/ /opt/SilkSpool/bundles/dsh/`）。
  - `freeze capture --hold` exit=0（`dsh-snapshot-ready-_jl66rgf`，manifest `5984892f…`，1605 sessions/0 running，28m12s）。
  - `candidate` exit=0（`dsh-candidate-gc4nl2qh`，prepared=true，84s）；`seal` exit=0（`3928c930…`，ready_for_cutover=true，acceptance `5da2d74f…`）。
  - `prepare` exit=0（`dsh-release-r_7v_eur`，mode=production，**1607 会话 V3→V4 failed=0**，1h59m45s，report `fe67dad6…`）。
  - `switch` exit=0（`phase=switched`，四根 RENAME_EXCHANGE，20m04s；app 读回 **0.1.7-rc.2**，`switch-readback.txt` `dee70247…`）。
  - `maintenance smoke` exit=0（`ok=true`，version=0.1.7-rc.2、15 域、1605/0 running、身份清理；`maintenance.stdout` `222f36eb…`）。
- **失败**：`release.py finalize` exit=1（13:36:50Z）。`pre-resume-invariants.json`（`caa68faa…`）`ok=false`，failures=17：`bus.jsonl`/`know.jsonl`/`audit.jsonl` 变更；`bus_meta.rows_sha256`；`bus_subscription`/`campaign_checkpoints`/`event_outbox`/`idempotency` count+rows+keys；`campaigns.rows_sha256`。expected_changes 仅 4 项（settings 改名、programs 镜像、FTS×2）。
- **根因**：维护窗口（13:31:41–13:33:31Z）内 0.1.7 首启执行了冻结 ~3h 积压的 overdue 后台任务：审计行 `task/reap`、`worker_reap`、`task/claim`、`task/campaign_tick`（3 专项）、`know/kb_vault_sync`、`bus/prune`（idempotency_pruned=232、outbox_pruned=774、subscriptions_pruned≈108）；bus.jsonl +22、audit.jsonl +6。P5 隔离预演同窗口未触发（时序差异），白名单（8 项：settings 改名、`startup-audit-append:2`、`startup-mirror-observation:bus_meta/programs`、`startup-registration-log/outbox:165`、FTS 两项）不覆盖。**同款 bus 维护在 0.1.5 回滚后 journal 13:48–13:49Z 出现**（vault 回流 + 保留窗口清理同参数），证明为平台正常行为；业务表行哈希未变、无用户数据丢失。
- **恢复**：`rollback` exit=0（13:44:50Z，`phase=rolled-back`、`new_state_preserved=true`）；`freeze resume` exit=0（13:46:57Z）；生产读回 **0.1.5-rc.2**（MainPID 764747/NRestarts=0，关键文件 SHA 与冻结前逐字节一致：`c49b1157…`/`0d9ea2f7…`/`6b21fb7e…`/`5458832d…`）；`sec-v5-accept.sh --ui-headless` **PASS=80 FAIL=0**（13:51:14Z，`accept015b.stdout` `431fad0c…`；13:47:30Z 首跑 PASS=45 FAIL=1 为 web 未就绪时序无效，留证 `accept015.stdout` `e041947e…`）。
- **保全**：0.1.7 全量状态（含 1607 V4 会话与维护写入）在 csai `/opt/silkspool/dsh-upgrades/20260926-017/dsh-release-r_7v_eur/rollback/`；P6 全部证据在 `…/p6-evidence/`（SHA 表见 record §13.9）。

## 影响

生产**不受影响**：已回滚至 0.1.5-rc.2，全服务 active、accept 80/0、RPO=0（业务数据未丢；回滚丢弃的只是 0.1.7 维护窗口的系统簿记写入，已保全于 release/rollback）。U3 未完成、0.1.7 未上线、U4 观察期未开始。

## 恢复选项（择一后重开 P6）

1. **首选 · 维护启动全静音**：在 `bundles/dsh/templates/dsh-upgrade-maintenance.py` 的 `OVERRIDES` 中临时关闭 `sec-domain-task`（启动回收/claim/campaign tick）、know vault 同步与 `bus.prune`（或引入 maintenance 专用开关）；先在隔离副本以「冻结 3h 后维护」场景复现验证（要求维护窗口 0 业务/系统追加），再重跑 P6：新 `--hold` 冻结点 → 用终版工具重建候选（`p4-app017` + `p5-tools`）→ U-A..I 验收 JSON + seal → prepare → switch → maintenance → finalize → 生产验收。
2. **备选 · 白名单扩权（需用户明确批准）**：扩展 `dsh-upgrade-invariants.py` 分类器，承认维护窗口 `actor=scheduler/system` 的 `claim/campaign_tick/kb_vault_sync/bus.prune` 追加与 prune 差异（前缀逐字节保留、追加行为完整 JSON、prune 仅触及 idempotency/outbox/subscription、业务表行哈希全等）；必须先在预演中以同等 overdue 条件验证通过。
3. **离线复核**：在 `dsh-release-r_7v_eur/rollback/` 副本上做行级 diff（bus_meta/bus_subscription/event_outbox/idempotency/campaign*），确认差异边界后再决策。
4. 重试约束：旧冻结点（`dsh-freeze-gie15crf`）已 resumed、旧 release 已 rolled-back，**不可直接续跑**；候选 `gc4nl2qh` 的 seal 绑定旧冻结点，重试必须重建。工具链不变（`p5-tools` 合并 SHA `1e43d1be…`）。

## 更新后的 STATE

```yaml
current_step: P6  # BLOCKED（finalize 不变量门禁失败 → 已按协议回滚；生产 0.1.5 全绿）
target_version: 0.1.7-rc.2
target_commit: 477b4f420553
current_prod_version: 0.1.5-rc.2   # 回滚后核验：MainPID 764747/NRestarts=0、accept PASS=80 FAIL=0
upgrade_dir: /opt/silkspool/dsh-upgrades/20260926-017
candidate_dir: /opt/silkspool/dsh-upgrades/20260926-017/dsh-candidate-gc4nl2qh   # seal 3928c930…、ready_for_cutover=true（重试需重建）
freeze_state: /opt/silkspool/dsh-upgrades/20260926-017/dsh-freeze-gie15crf      # manifest 5984892f…，已 resumed 13:46:57Z
release_dir: /opt/silkspool/dsh-upgrades/20260926-017/dsh-release-r_7v_eur        # phase=rolled-back；rollback/ 保留 0.1.7 全量状态
observation_until: ''
gates:
  u3_preflight: pass
  u3_freeze: pass
  u3_candidate_seal: pass
  u3_prepare: pass
  u3_switch: pass
  u3_maintenance: pass
  u3_pre_resume_invariants: fail
  u3_rollback_recovery: pass
  u3_prod_accept_after_rollback: pass
open_issues:
  - P6 BLOCKED（硬停止②）：见上「恢复选项」；需用户决策后重开 P6
last_commit: <本次提交>
```

## 恒定段（角色/授权/红线，供重开会话原样携带）

- **角色**：SilkSecAgent v5 DSH 升级执行 agent；「0.1.7 升级链」步骤 P1–P8（当前阻塞于 P6）。
- **授权（用户已一次性授予）**：仓库读写/本地测试/git commit+push；`spool exec/query/dispatch`；`rsync -a bundles/dsh/ /opt/SilkSpool/bundles/dsh/`；`spool bundle dsh setup csai`；`spool restart csai silksecagent`；`/opt/silkspool/dsh-upgrades/` 工作目录；冻结/切换/回滚工具；bus.prune 维护；观察期重启与巡检。U3 生产切换按预授权自动执行；**失败立即回滚**。
- **红线**：远程操作一律走 PATH 中 `spool`（禁直连 SSH/curl 操作远程 Docker）；禁 `docker compose down`（n8n 禁 `-v`）；禁 `git add -f`；不提交 keys/config.ini 等忽略文件；改 bundle 模板后先 rsync 运行时副本；Session 迁移必须先有完整冻结点 + 恢复预演。
- **硬停止（仅 4 类）**：① 门禁失败且无法在窗口内修复/回滚；② 生产不变量出现白名单外的非预期差异；③ 需要超出预期的停机且无法自动恢复；④ 用户喊停。
- **基线**：目标 DSH 0.1.7-rc.2（commit `477b4f420553`）；现役 0.1.5-rc.2（csai `/opt/silkspool/dsh`）；已定决策（schedule 不接入、bill 0.18.1+补丁、保留窗口 7 天或 2 万行、interval ≥300s、preset 仅 web patch、V0 fail-closed、settings migrate-once、主题/connection inject 保留、冻结窗口方案①、failover 通知改日志）。
- **真相源**：`doc/secagent/25-dsh-0.1.7-upgrade-and-scale-2026-09-26.md`（§一）+ record §12/§13；NEXT PROMPT 递归规则不变（每步一个自包含 prompt、写入 `handoff-017/P<n>.md`、P8 输出 CHAIN END、硬停止输出 CHAIN BLOCKED）。
