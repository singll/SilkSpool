# U3 生产切换 — Handoff Prompt (2026-09-15)

> ⚠️ **紧急：生产服务处于冻结状态**，自 2026-09-15T12:17:58Z 起已停止。
> 优先完成剩余四步，每步失败则立即执行"紧急恢复"。

---

## 给新会话的执行指令

你是 SilkSecAgent v5 DSH 升级工程助手。本会话接手 U3 生产切换的最后四步。

### 先读关键文档（顺序）

1. `doc/secagent/upgrades/2026-09-12-dsh-0.1.5-rc.2-record.md` §13.4（U2 完成证据）
2. `doc/secagent/upgrades/2026-09-12-dsh-0.1.5-rc.2-plan.md` §5.3（生产切换顺序）
3. 本文件（完整上下文）

### 当前精确状态

```
生产版本:       0.1.2-rc.1  (MainPID 3734437, NRestarts=0, 已停止/冻结)
冻结状态目录:   /opt/silkspool/dsh-upgrades/20260913-rc2/dsh-freeze-ksshetzv
快照 manifest:  /opt/silkspool/dsh-upgrades/20260913-rc2/dsh-snapshot-ready-8jhp928l
快照 manifest SHA-256: fdeea4b34fce80a2f2c742d6caa6bccb170449bc9b62f005d4b1ab1aaac5a0cd
冻结开始时间:   2026-09-15T12:17:58.143956+00:00
候选目录:       /opt/silkspool/dsh-upgrades/20260913-rc2/dsh-candidate-_k4tn_ua
候选封存 SHA:   97f0010a52fa0a5d77f4060bac4fca13f49c4036446b2d7af7ed2cf0349e0c4d
ready_for_cutover: true (U-A~I 全部通过，验收文件 SHA 3d9e4335b17246f525ad3af36dcfd1f09b1222de6bd2a83a9e428beec5f4aed8)
恢复配方:       /opt/silkspool/dsh-upgrades/20260913-rc2/session-recovery-64PWLv/report.json (4 个 Session)
工作目录:       /opt/silkspool/dsh-upgrades/20260913-rc2/
工具目录:       /opt/silkspool/dsh-upgrades/20260913-rc2/recovery-tools/
工具 SHA 已验证与本地 bundles/dsh/templates/ 一致（2026-09-15 11:29 本地会话确认）
bugfix 已应用:  recovery-tools/dsh-upgrade-release.py 第367-370行 (pre_resume_invariants None 路径修复)
```

### 已完成（不需要重做）

- U2 整套重验：切换→rc.2 启动→不变量→回滚→旧版启动→257/257 读回（§13.4）
- 全新冻结点：`dsh-snapshot-ready-8jhp928l`（含当前生产的263条 Session、4223条 outbox 等）
- 候选已封存为 `ready_for_cutover: true`
- 14 个 systemd 单元已停止，2 个 cron 用户已暂停，0 个 running worker

### 剩余四步（按顺序，每步超时则执行紧急恢复）

所有命令通过 `spool exec csai "sudo python3 ..."` 执行。

**P1: prepare** — 从冻结点构建 next/rollback 树、rc.2 覆盖、Session V3 迁移、索引修复、4 个恢复配方

```bash
spool exec csai 'sudo python3 /opt/silkspool/dsh-upgrades/20260913-rc2/recovery-tools/dsh-upgrade-release.py prepare \
  --snapshot /opt/silkspool/dsh-upgrades/20260913-rc2/dsh-snapshot-ready-8jhp928l \
  --candidate /opt/silkspool/dsh-upgrades/20260913-rc2/dsh-candidate-_k4tn_ua \
  --work-dir /opt/silkspool/dsh-upgrades/20260913-rc2 \
  --recovery-report /opt/silkspool/dsh-upgrades/20260913-rc2/session-recovery-64PWLv/report.json \
  2>&1'
```

预期输出：`{"ok": true, "release": "/opt/silkspool/dsh-upgrades/20260913-rc2/dsh-release-XXXXXXXX", "mode": "production", "sessions": 263}`

**重要**：捕获 `release` 路径，后续所有步骤都要用。超时估计：约 15 分钟（263 条 Session 迁移比257 多 6 条）。

验证 prepare 成功后，检查迁移报告：
```bash
RELEASE_DIR=<上一步输出的 release 路径>
spool exec csai "sudo python3 -c \"import json;s=json.load(open('${RELEASE_DIR}/state.json'));print('phase=',s['phase'],'sessions=',s['migration']['sessions'],'error=',s.get('error'))\""
```

**P2: switch** — RENAME_EXCHANGE 生产目录↔next（四根：dsh + 3 workspace）

```bash
spool exec csai "sudo python3 /opt/silkspool/dsh-upgrades/20260913-rc2/recovery-tools/dsh-upgrade-release.py switch \
  --release-dir ${RELEASE_DIR} \
  --freeze-state /opt/silkspool/dsh-upgrades/20260913-rc2/dsh-freeze-ksshetzv 2>&1"
```

预期输出：`{"ok": true, "phase": "switched", "writers_held": true}`

切换成功后立即验证：
```bash
spool exec csai "cat /opt/silkspool/dsh/app/node_modules/@deepseek-ai/dsh/package.json | grep version"
# 必须显示 0.1.5-rc.2
```

**P3: smoke** — systemd 临时 drop-in 启动 rc.2、验收、清理 drop-in

```bash
spool exec csai "sudo python3 /opt/silkspool/dsh-upgrades/20260913-rc2/recovery-tools/dsh-upgrade-maintenance.py smoke \
  --release-dir ${RELEASE_DIR} \
  --freeze-state /opt/silkspool/dsh-upgrades/20260913-rc2/dsh-freeze-ksshetzv 2>&1"
```

预期检查项（全部 true）：version=0.1.5-rc.2, domains=15, workspaces=3, listed_sessions>=175, web_application, scope_refusal, unauthenticated_refusal, users_restored, logged_out

smoke 报告写入 `${RELEASE_DIR}/maintenance-switched-report.json`。

**P4: finalize** — 不变量预检（对生产当前状态 vs 冻结点）、恢复写者、登记观察期

```bash
spool exec csai "sudo python3 /opt/silkspool/dsh-upgrades/20260913-rc2/recovery-tools/dsh-upgrade-release.py finalize \
  --release-dir ${RELEASE_DIR} \
  --freeze-state /opt/silkspool/dsh-upgrades/20260913-rc2/dsh-freeze-ksshetzv 2>&1"
```

预期输出：`{"ok": true, "phase": "observing", "observation_until": "2026-09-18T12:52:xx+00:00"}`（72 小时后）

finalize 内部执行 `pre_resume_invariants`（已修复 None 路径 bug）→ 不变量失败则拒绝恢复写者。成功后调用 `freeze.resume()` 恢复14 个单元。

### 紧急恢复（任何步骤失败时立即执行）

```bash
spool exec csai "sudo python3 /opt/silkspool/dsh-upgrades/20260913-rc2/recovery-tools/dsh-upgrade-freeze.py resume \
  --state-dir /opt/silkspool/dsh-upgrades/20260913-rc2/dsh-freeze-ksshetzv 2>&1"
```

恢复后立即：
1. 确认 `systemctl is-active silksecagent.service` 为 active
2. 确认版本仍为 0.1.2-rc.1（`cat /opt/silkspool/dsh/app/.../package.json | grep version`）
3. 记录失败原因，不重新切换

### 每步成功后保存证据

将以下文件从 csai 复制到本地 `doc/secagent/upgrades/` 或通过 SHA 验证：

- `prepare` 输出 JSON → `dsh-reverify-u2u3/u3-prepare.json`
- `switch` 后的 state.json SHA
- `smoke` 的 `maintenance-switched-report.json` SHA
- `finalize` 的 `pre-resume-invariants.json` SHA
- `finalize` 输出含 `observation_until`

每步完成后记录：时间戳、命令、退出码、关键输出字段、证据文件路径+SHA-256。

### 记录更新

成功后，向 `doc/secagent/upgrades/2026-09-12-dsh-0.1.5-rc.2-record.md` 追加 **§14**：

```markdown
## 14. 2026-09-15 U3 生产切换

### 14.1 切换流水

| 时间 | 步骤 | 结果 | 证据 |
|---|---|---|---|
| 12:17:58Z | 冻结 capture --hold | 14 单元停止，快照 fdeea4b3... | dsh-freeze-ksshetzv |
| ...Z | prepare | 263 sessions 迁移，phase=prepared | ... |
| ...Z | switch | RENAME_EXCHANGE 四根，phase=switched | ... |
| ...Z | smoke | version=0.1.5-rc.2, 15域, ... | ... |
| ...Z | finalize | 不变量通过，phase=observing，观察至 ... | ... |

### 14.2 不变量与生产验证

（逐项列出差异与归因，对照 §13.2 已知启动副作用）

### 14.3 当前状态

生产：**0.1.5-rc.2**，MainPID <新PID>，观察期至 <observation_until>。

### 14.4 后续

- U4：观察期满前（至少 72 小时）完成 U4 关账；记录任务收尾、事件积压、会话加载延迟
- L0–L6：学习增量，另见专项设计
- 若观察期内发现回滚触发条件，按 §5.4 执行完整回滚（不能用冻结点直接覆盖新增业务数据）
```

同时更新 §7 流水表 U3 行、状态行和 upgrades/README.md 时间线。

### 操作红线（继承自旧会话，必须遵守）

1. 一切远程操作通过 `spool exec csai`，不直接 SSH
2. 不运行旧 `dsh-upgrade.sh`
3. 不用 `npm latest` 或 rc.1——版本已由候选封存锁定为 0.1.5-rc.2
4. 禁止 `docker compose down` / `docker compose down -v`（n8n 等）
5. 不 `git add -f`，不提交 config.ini/keys 等敏感文件
6. bundle 模板改动后：`rsync -a bundles/dsh/ /opt/SilkSpool/bundles/dsh/` 再 `spool bundle dsh setup csai`
7. 不删 37 个兼容别名（观察期至 2026-09-19T15:23:24.420+08:00）
8. 数据不变量门禁：任何非预期差异必须显式报告，不静默放过
9. 诚实记录失败，不掩盖、不填"通过"

### U3 完成后的下一步

U3 切换成功后，U4（≥72小时观察）开始计时。观察期结束前：
- 不运行 L0–L6（学习增量独立于升级）
- 如果切换后新增数据（新 Session、新 finding、新 outbox 事件），记录在案但不回滚
- 观察期到期时，取新冻结点（`--hold`），运行 `dsh-upgrade-release.py preserve`，生成对账报告，更新 §14.4

### 继续生成 Handoff Prompt 的规则

当本会话结束（无论完成还是中断）时，你必须生成一份新的 handoff prompt，格式与本文件相同，包含：

1. **最新精确状态**：所有已完成步骤的时间戳、输出、SHA
2. **剩余步骤**：明确列出哪些步骤还未执行
3. **失败原因**（如有）：具体错误信息、建议排查方向
4. **紧急恢复路径**（如果仍处于冻结状态）
5. **工具位置与版本**

将此 prompt 保存到 `doc/secagent/upgrades/HANDOFF-<phase>-<date>.md`，供下一个会话直接使用。

如果 U3+U4+L0 全部完成，prompt 应注明"任务已结束，不需要继续 handoff"。

---

*生成时间：2026-09-15T12:52Z，上一会话的 MainPID 3734437，record SHA fc7d8db4fb0a7511aa5b...*
