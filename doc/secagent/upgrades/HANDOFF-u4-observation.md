# SilkSecAgent v5 — DSH 0.1.5-rc.2 升级 U4 观察期 Handoff（刷新版）

你是 SilkSpool 的 DSH 升级工程助手。本文件是 U4 观察期内首次巡检后的可自续提示词。前序上下文见 [执行记录](2026-09-12-dsh-0.1.5-rc.2-record.md) §14、§14.5 及 [时间线](README.md)。

---

## 一、当前状态（2026-09-15T15:00Z 巡检后）

- 生产：**0.1.5-rc.2**、MainPID 3848865、NRestarts=0、active/running、FreezerState=running。
- Git 提交：`ee31b18 docs: 补充 U4 handoff 进度快照与自续规则`（之后将追加 `docs: DSH 0.1.5-rc.2 U4 观察期首次巡检记录`）。
- 发布目录：`/opt/silkspool/dsh-upgrades/20260913-rc2/dsh-release-2non9v70`。
- `state.json`：`phase=observing`，`observation_until=2026-09-18T14:16:35.602762+00:00`。
- 冻结点：`dsh-snapshot-ready-8jhp928l`，manifest SHA `fdeea4b34fce80a2f2c742d6caa6bccb170449bc9b62f005d4b1ab1aaac5a0cd`。
- 兼容别名：37 个，`deprecated_use` 累计 180，最后一条 2026-09-15T07:07:10Z（切流前）；切流后增量 0；**新闸口 2026-09-22T15:07:10.543+08:00**，未到期不删除。
- §14.5 首次巡检（2026-09-15T14:57Z）：全部健康（MainPID 不变、NRestarts=0、journal 无崩溃、调度器持锁、vault errors=0、outbox 全 delivered、Session 0 新增、无切流后异常）。

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

- **Git 提交**：`ee31b18`（+ 即将追加的巡检提交）
- **发布目录**：`/opt/silkspool/dsh-upgrades/20260913-rc2/dsh-release-2non9v70`，`state.json` `phase=observing`
- **observation_until**：`2026-09-18T14:16:35.602762+00:00`
- **冻结点**：`dsh-snapshot-ready-8jhp928l`，manifest SHA `fdeea4b34fce80a2f2c742d6caa6bccb170449bc9b62f005d4b1ab1aaac5a0cd`
- **生产版本**：`0.1.5-rc.2`、MainPID `3848865`、NRestarts `0`、active/running
- **§14.5 巡检**：首次巡检完成（2026-09-15T14:57Z），全部健康；别名闸口顺延至 2026-09-22T15:07:10+08:00
- **L0–L6**：未执行

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
