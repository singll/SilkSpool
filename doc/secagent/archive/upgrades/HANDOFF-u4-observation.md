# U4 关账完成 — 链条终止（2026-09-18）

**DSH 0.1.2-rc.1 → 0.1.5-rc.2 升级已完整关账，本观察期 handoff 不再续期、不再生成新提示词。** 本文件由 U4 观察期提示词转为终止页，保留供追溯。

## 关账事实

- **关账记录**：[执行记录 §14.9](2026-09-12-dsh-0.1.5-rc.2-record.md)（含流水、132 项对账归因、产物 SHA-256 汇总）。
- **生产**：DSH **0.1.5-rc.2**，关账后 MainPID **4025919**、NRestarts=**0**、active/running、15 域注册。
- **新冻结点**：`dsh-snapshot-ready-c2s753hj`，manifest SHA `d247b886ac8993d362a9bca8e16e874d6085c071294060300975a74fb66f0efa`；state-dir `dsh-freeze-8z_jvhkr`。
- **对账**：`post-resume-reconciliation.json` SHA `d5a79e163f277788fdaa272522ffb7475bfcc2f42de86ba0fcdac704ddd6e27f`；44→52 表（+8 张 L 系列新表，0 删除）、0 表业务行减少、11 条 facts 归档可溯、`bus.jsonl` 前缀字节保全、3 条历史死信已归因、当前冻结点 `kb_fts`/`exp_fts` integrity ok。
- **关账性质**：**用户授权提前关账**（观察期形式上截至 `2026-09-18T14:16:35Z`，剩余约 13h；本轮已无后续任务周期）。据实记录，不称自然期满。
- **U0–U4 全绿**；**L0–L6 已验收**（[自学习设计](2026-09-12-self-learning-design.md) §11.1–§11.7 + [记录 §14.8](2026-09-12-dsh-0.1.5-rc.2-record.md)）。

## 保留事项（未执行，不填「通过」）

- 37 个兼容别名：闸口 `2026-09-22T15:07:10.543+08:00` 未到，**不删除**。
- §14.1 推迟动作：`rsync -a bundles/dsh/ /opt/SilkSpool/bundles/dsh/` 与 `spool bundle dsh setup csai` 的运行时副本同步**未执行**（会重启服务，另行安排维护窗口）。
- 原 U3 冻结点 `dsh-snapshot-ready-8jhp928l` 保持原样（其 `exp_fts` 仍为切换前 malformed 原件，符合设计）。

## 后续运维建议

1. 观察生产 `journal` 与 `event_outbox` 是否出现新的 `pending`/`dead_letter`；如出现，按 §14.7 的「历史 vs 现存」归因方法处理。
2. 别名闸口到期后，按宪法 §十五三段式删除 37 个别名；注意 [PROGRESS §5.2 侧记](../../PROGRESS.md) 的契约用例 `freeform-status-update` 需同步改为直连语义动词，否则契约评测会报 `E_BUS_DOMAIN_UNKNOWN`。
3. 如需执行第 2 条推迟的 `rsync`/`bundle setup`，安排在维护窗口并记录重启基线。

> 自续规则：**不再适用。** 本链条（U4 观察期）已终止；后续工作按 [升级目录 README](README.md) 与 [v5 PROGRESS](../../PROGRESS.md) 进行。
