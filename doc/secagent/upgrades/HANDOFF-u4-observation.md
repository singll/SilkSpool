# SilkSecAgent v5 — DSH 0.1.5-rc.2 升级 U4 观察期关账 Handoff

你是 SilkSpool 的 DSH 升级工程助手。本文件是 U3 生产切换完成后为 U4 关账准备的可自续提示词。前序上下文见 [执行记录](2026-09-12-dsh-0.1.5-rc.2-record.md) §13–§14 及 [时间线](README.md)。

---

## 一、当前状态（2026-09-15T14:16Z）

- 生产：**0.1.5-rc.2**、MainPID 3848865、NRestarts=0、active/running、FreezerState=running。
- 冻结点（最后一次已知）：`dsh-snapshot-ready-8jhp928l`，manifest SHA `fdeea4b34fce80a2f2c742d6caa6bccb170449bc9b62f005d4b1ab1aaac5a0cd`。
- 发布目录：`/opt/silkspool/dsh-upgrades/20260913-rc2/dsh-release-2non9v70`。
- observation_until：**2026-09-18T14:16:35.602762+00:00**。
- 兼容别名观察期：**2026-09-19T15:23:24.420+08:00**。
- 两个工具缺陷已修复：`dsh-upgrade-maintenance.py`（`@scope` 路径）SHA `ec27579d…`，`dsh-upgrade-local-client.py`（`journalctl --grep`）SHA `4082bf5e…`。

---

## 二、U4 关账任务（≥72h 观察期满后执行）

**所有远程操作走 `spool exec csai`，禁止绕过；禁止 `docker compose down`（尤其 n8n）；证据驱动，未执行项写「未执行」不填「通过」。**

### 步骤 1：确认观察期满

```bash
spool exec csai "sudo python3 -c 'from datetime import datetime,timezone; import json; s=json.load(open(\"/opt/silkspool/dsh-upgrades/20260913-rc2/dsh-release-2non9v70/state.json\")); until=s[\"observation_until\"]; print(\"observation_until:\",until); print(\"expired:\", datetime.now(timezone.utc) >= datetime.fromisoformat(until))'"
```

若未满则等待，不提前关账。

### 步骤 2：生产健康快照

确认服务状态、MainPID、NRestarts、journal 日志无崩溃记录、调度循环正常、vault 回流无错。记录起始 MainPID（用于观察重启次数）。

### 步骤 3a：新冻结点捕获

U4 关账前需要对切流后的生产现状另取完整冻结点。先用 `dsh-upgrade-freeze.py capture` 创建新冻结状态，再传入 `preserve`。

```bash
# 先读 freeze-config-current.json（含当前生产路径与 sqlite 配置），capture 会停写者并快照
spool exec csai "sudo python3 /opt/silkspool/dsh-upgrades/20260913-rc2/recovery-tools/dsh-upgrade-freeze.py capture --config /opt/silkspool/dsh-upgrades/20260913-rc2/freeze-config-current.json --work-dir /opt/silkspool/dsh-upgrades/20260913-rc2 --hold 2>&1"
```

记录新 `state-dir` 路径（形如 `dsh-freeze-XXXXXXXX`），capture 会自动停写者并创建新恢复点。

### 步骤 3b：新增业务数据对账（`preserve`）

```bash
# 用步骤 3a 的 state-dir 替换 <NEW_FREEZE_DIR>
spool exec csai "sudo python3 /opt/silkspool/dsh-upgrades/20260913-rc2/recovery-tools/dsh-upgrade-release.py preserve --release-dir /opt/silkspool/dsh-upgrades/20260913-rc2/dsh-release-2non9v70 --freeze-state /opt/silkspool/dsh-upgrades/20260913-rc2/<NEW_FREEZE_DIR> 2>&1"
```

此命令会：
- 以原冻结点 `dsh-snapshot-ready-8jhp928l` vs 新冻结点做不变量比较（`same_freeze_point=False`）
- 列出切流后新增的 Session/业务文件
- 保全新树到发布目录，标记 `automatic_restore_allowed=False`
- 将 state 转为 `phase=reconciling`

报告 SHA-256 须记入 §14 续。

### 步骤 3c：恢复写者

```bash
# 对账完成后立即恢复
spool exec csai "sudo python3 /opt/silkspool/dsh-upgrades/20260913-rc2/recovery-tools/dsh-upgrade-freeze.py resume --state-dir /opt/silkspool/dsh-upgrades/20260913-rc2/<NEW_FREEZE_DIR> 2>&1"
```

确认 `systemctl is-active silksecagent.service` 返回 active，观察 NRestarts=0。

### 步骤 4：新冻结点验收

核对新冻结点的 manifest SHA、44 张表行/主键、事件文件字节前缀完整性。差异只允许：observation 时间、切流后新增数据（已在 preserve 中记录）。

### 步骤 5：L0–L6（可选，独立进行）

自学习增量验证、漏洞探测增量、反馈接线与评测集对比。按 [自学习设计](2026-09-12-self-learning-design.md) 执行，不要与平台关账混为一谈。

### 步骤 6：文档更新

- 追加 §14.5 U4 关账记录：观察期健康快照、preserve 证据、新冻结点 SHA。
- 更新 §7 U4 状态为「已完成」或「未通过，已记录原因」。
- 更新 README 时间线。
- 如 L0–L6 也完成，更新 PROGRESS.md。

### 步骤 7：生成下一阶段 Handoff

**本文件末尾设计为自续**：U4 完成后，在此文件追加新的 §「U4 完成后下一个待办」，写清楚 L0–L6 的具体内容和证据需求，作为下一会话的提示词。格式照本节结构写，要求具备相同的证据驱动、诚实记录和工作纪律约束。

---

## 四、进度快照（给新会话的初始坐标）

- **Git 提交**：`3f61e12 feat: 完成 DSH 0.1.5-rc.2 生产切换，进入 U4 观察期`
- **发布目录**：`/opt/silkspool/dsh-upgrades/20260913-rc2/dsh-release-2non9v70`，`state.json` `phase=observing`
- **冻结点**：`dsh-snapshot-ready-8jhp928l`，manifest SHA `fdeea4b34fce80a2f2c742d6caa6bccb170449bc9b62f005d4b1ab1aaac5a0cd`
- **P3 smoke 证据**：`cf718b2a3ec2dd472df748a40c9d86ed5facd12acbd8f33883a145937b1f0a5a`
- **pre_resume_invariants 证据**：`0ddb25b0ad45783593f0b6364e6b8bffa2fa7062a8ea666405392041c0ddfc68`
- **maintenance-state 证据**：`be3931f80ed0af14d36d4f75d6147c5a89798583aa25ba70b6e154f989759ff4`
- **生产版本**：`0.1.5-rc.2`、MainPID `3848865`、NRestarts `0`、active/running
- **observation_until**：`2026-09-18T14:16:35.602762+00:00`
- **兼容别名观察期**：`2026-09-19T15:23:24.420+08:00`

## 五、工作纪律（照搬前序纪律，不改动）

1. 隔离预演优先；一切测试在副本做，除非整套重验通过并经用户明确批准否则不切生产。
2. 证据驱动：每步产出报告+SHA-256；未执行项写「未执行」。
3. 不混淆口径：副本测试 ≠ 生产观察；基础健康检查 ≠ 升级完成。
4. 回滚安全优先：Session V3 回滚须走完整冻结点恢复；切流后新增数据先冻结另存。
5. 数据不变量门禁：outbox/事件字节前缀/44表/证据哈希逐项核对。
6. 诚实记录失败：失败证据保留，不掩盖、不删减。
7. U4 到期才宣告关账；L 工作包独立进度独立账，不混入平台验收。

---

## 六、自续规则（本提示词的核心）

**本会话结束前必须判断升级是否真正完成，并二选一：**

### A. 若仍有未完成阶段（当前默认：U4 观察 + L0–L6）
1. 把本次会话的结论、新证据文件路径与 SHA-256、生产实测状态（版本/MainPID/NRestarts/健康）追加写入
   [执行记录](2026-09-12-dsh-0.1.5-rc.2-record.md) 的下一个 §小节，并更新 §7 表与 [时间线](README.md)。
2. `git add` 相关文件（禁止 `git add -f`，敏感文件不入库）并提交，记录新 commit 短哈希。
3. **重写本文件 `HANDOFF-u4-observation.md`**：更新「四、进度快照」为最新哈希/commit/observation 状态，
   更新「二、任务」为下一阶段的具体步骤（例如 U4 关账后转入 L0–L6，则把 L0–L6 的可执行步骤写进来）。
4. 在会话最终回复里，把「给下一个新会话的提示词」整段贴出，其正文 = 本文件的「一~六」结构（已刷新版），
   并要求下一个会话同样在结束时执行本「六、自续规则」。这样一路自续，直到情况 B。

### B. 仅当 U0–U4 全部关账 且 L0–L6 按专项设计验收通过 且 用户确认时
- 在执行记录写明「升级完成」，README 时间线标「已完成」，PROGRESS 同步。
- 不再生成新提示词，改为一句话总结 + 后续常规运维观察建议。
- 删除或归档本 handoff 文件（可选），链条终止。

**判定纪律**：观察期未满、任一 § 步骤缺证据、任何非预期不变量差异未归因、L0–L6 未单独验收——一律走 A，
不得因为「服务在跑」就宣布升级完成。诚实优先：没做的写「未执行」。
