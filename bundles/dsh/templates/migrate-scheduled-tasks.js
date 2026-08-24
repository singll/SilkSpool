#!/usr/bin/env node
// ==============================================================================
// SilkSecAgent 定时任务迁移（P12，幂等，默认 dry-run，--apply 才落库）
// 背景：2026-08 之前 agent 用「每天重建 once 任务」模拟每日周期，任务表堆积重复行。
// 规则：queued 的 once 任务，若同 program_id+objective 已存在终态行（done/failed/cancelled），
// 判定为「周期任务被重复创建」→ 转为 interval（every=86400，锚定原 next_run_at）；
// 同 program+objective 有多个活跃 once 时保留最早一行，其余标 cancelled。
// 用法：SEC_DATA_DIR=/opt/silkspool/dsh/data node migrate-scheduled-tasks.js [--apply]
// ==============================================================================
import { DatabaseSync } from 'node:sqlite'
import * as path from 'node:path'

const DATA_DIR = process.env.SEC_DATA_DIR || '/opt/silkspool/dsh/data'
const APPLY = process.argv.includes('--apply')
const DAY = 86400

const db = new DatabaseSync(path.join(DATA_DIR, 'asset-graph.db'))
db.exec('PRAGMA busy_timeout = 5000')

const now = Date.now()
const queuedOnce = db.prepare(
  "SELECT * FROM tasks WHERE schedule_kind = 'once' AND status = 'queued' ORDER BY created_at ASC"
).all()

let converted = 0, cancelledDup = 0, skipped = 0
for (const t of queuedOnce) {
  // 同 program+objective 有终态行 → 历史上被重复创建过的周期任务
  const terminal = db.prepare(
    "SELECT COUNT(*) AS n FROM tasks WHERE program_id = ? AND objective = ? AND status IN ('done','failed','cancelled')"
  ).get(t.program_id, t.objective).n
  if (!terminal) { skipped++; continue }
  // 同 program+objective 已有活跃 interval → 本行直接取消（去重）
  const activeInterval = db.prepare(
    "SELECT id FROM tasks WHERE program_id = ? AND objective = ? AND schedule_kind = 'interval' AND status NOT IN ('done','failed','cancelled') LIMIT 1"
  ).get(t.program_id, t.objective)
  if (activeInterval) {
    console.log(`[cancel-dup] #${t.id} (${t.program_id}) 已有 interval #${activeInterval.id}，取消重复 once`)
    if (APPLY) db.prepare("UPDATE tasks SET status = 'cancelled', blocked_reason = 'P12 迁移：已有同目标 interval 任务', updated_at = ? WHERE id = ?").run(now, t.id)
    cancelledDup++
    continue
  }
  // 同 program+objective 还有更早的活跃 once → 本行取消（保留最早）
  const earlier = db.prepare(
    "SELECT id FROM tasks WHERE program_id = ? AND objective = ? AND schedule_kind = 'once' AND status = 'queued' AND id < ? LIMIT 1"
  ).get(t.program_id, t.objective, t.id)
  if (earlier) {
    console.log(`[cancel-dup] #${t.id} (${t.program_id}) 保留更早 once #${earlier.id}，取消本行`)
    if (APPLY) db.prepare("UPDATE tasks SET status = 'cancelled', blocked_reason = 'P12 迁移：重复 once 任务', updated_at = ? WHERE id = ?").run(now, t.id)
    cancelledDup++
    continue
  }
  const anchor = t.next_run_at && t.next_run_at > now ? t.next_run_at : now + DAY * 1000
  console.log(`[convert] #${t.id} (${t.program_id}) once → interval 86400s，锚定 ${new Date(anchor).toISOString()}`)
  if (APPLY) {
    db.prepare("UPDATE tasks SET schedule_kind = 'interval', every_seconds = ?, next_run_at = ?, updated_at = ? WHERE id = ?")
      .run(DAY, anchor, now, t.id)
  }
  converted++
}
console.log(`\n${APPLY ? '已应用' : 'dry-run'}：转换 ${converted}，取消重复 ${cancelledDup}，跳过（非周期） ${skipped}`)
