#!/usr/bin/env node
// ==============================================================================
// SilkSecAgent 定时任务锚点校准迁移（2026-09-15，幂等，默认 dry-run，--apply 落库）
//
// 背景：normalizeSchedule 原来对 interval 任务设 run_at=null，续期退回 next_run_at（已被
//       taskRunNow 覆写为"现在"），导致每日定时任务从凌晨3点漂到白天（2026-09-02 事故）。
// 修复：
//   1) 为所有活跃 interval 任务补齐 run_at 标称锚点（保持已有有效锚点不动）。
//   2) 按相位锚点重新计算 next_run_at（latest-only，不回补错过的格点）。
//   3) 对日级任务（every_seconds ≥ 86400）：缺锚点者按任务意图分配凌晨错批槽位。
//
// 用法：SEC_DATA_DIR=/opt/silkspool/dsh/data node migrate-schedule-anchor.js [--apply]
// ==============================================================================

import { DatabaseSync } from 'node:sqlite'
import * as path from 'node:path'

const DATA_DIR = process.env.SEC_DATA_DIR || '/opt/silkspool/dsh/data'
const APPLY = process.argv.includes('--apply')
const DAY_MS = 86_400_000
const BJ_OFF = 8 * 3600_000
// 相位基准：2026-01-05 周一 北京 03:00（每日/每周任务的最佳默认）
const NIGHT_ANCHOR = Date.UTC(2026, 0, 5, 3, 0, 0) - BJ_OFF

function bjIso(ts) { return new Date(ts + BJ_OFF).toISOString().slice(0, 16) + '+08:00' }
function bjHour(ts) { return new Date(ts + BJ_OFF).getUTCHours() }

const db = new DatabaseSync(path.join(DATA_DIR, 'asset-graph.db'))
db.exec('PRAGMA busy_timeout = 5000')

const now = Date.now()

function firstGridAfter(anchor, step, nowTs) {
  if (anchor > nowTs) return anchor
  return anchor + (Math.floor((nowTs - anchor) / step) + 1) * step
}

// 北京墙钟 HH:mm → 最近已过去的今日/昨日该时刻
function wallPast(h, m, nowTs) {
  const bj = nowTs + BJ_OFF
  const midnight = Math.floor(bj / DAY_MS) * DAY_MS - BJ_OFF
  const target = midnight + h * 3600_000 + m * 60_000
  return target <= nowTs ? target : target - DAY_MS
}

// 任务意图 → 北京墙钟槽位（从 objective 文案里识别每 日/周 + 时间点，或按 phase 理性默认）
function inferSlot(t) {
  const obj = String(t.objective || '')
  // 识别 HH:mm / HH点
  const tm = obj.match(/(\d{1,2})[:：点](\d{2})?分?/)
  if (tm) return { h: Number(tm[1]), m: Number(tm[2] || 0) }
  // 按 phase 默认：recon → 03:00，vuln → 04:00，其他 → 05:00
  const phase = String(t.phase || '').toLowerCase()
  if (phase === 'recon') return { h: 3, m: 0 }
  if (phase === 'vuln') return { h: 4, m: 0 }
  return { h: 5, m: 0 }
}

const INTERVAL_MINUTES = 30  // 相同 phase 内的错批间隔（分钟）

const tasks = db.prepare(
  "SELECT id, program_id, phase, status, schedule_kind, run_at, every_seconds, next_run_at, objective FROM tasks WHERE schedule_kind = 'interval' AND status NOT IN ('done','failed','cancelled') ORDER BY program_id, phase, id"
).all()

console.log(`=== 定时任务锚点校准（${APPLY ? '已应用' : 'dry-run'}）===`)
console.log(`现在北京时间：${bjIso(now)}`)
console.log(`找到 ${tasks.length} 条活跃 interval 任务\n`)

// 先按 phase 分组，用于错批偏移
const byPhase = {}
for (const t of tasks) {
  const key = `${t.program_id}__${t.phase || 'none'}`
  if (!byPhase[key]) byPhase[key] = []
  byPhase[key].push(t)
}

let anchored = 0, reAnchored = 0, skipped = 0

for (const t of tasks) {
  const step = Number(t.every_seconds) * 1000
  const hasAnchor = Number(t.run_at) > 0
  const currentBj = t.next_run_at ? bjIso(t.next_run_at) : 'N/A'

  if (hasAnchor) {
    // 锚点已存在：只重新计算 next_run_at（对齐到格点，修复慢漂移）
    const anchor = Number(t.run_at)
    const next = firstGridAfter(anchor, step, now)
    if (next !== t.next_run_at) {
      const newBj = bjIso(next)
      console.log(`[#${t.id}] ${t.program_id}/${t.phase || '-'} anchor 已有(${bjIso(anchor)})  next ${currentBj} → ${newBj}（格点对齐）`)
      if (APPLY) db.prepare("UPDATE tasks SET next_run_at = ?, updated_at = ? WHERE id = ?").run(next, now, t.id)
      reAnchored++
    } else {
      console.log(`[#${t.id}] ${t.program_id}/${t.phase || '-'} anchor OK(${bjIso(anchor)})  next=${currentBj} 不变`)
    }
    continue
  }

  // 锚点缺失：分配新锚点
  if (step < DAY_MS) {
    // 短周期（< 1 天）：锚定当前 next_run_at（或 now），不额外美化
    const anchor = (t.next_run_at && t.next_run_at > 0) ? t.next_run_at : now
    const next = firstGridAfter(anchor, step, now)
    console.log(`[#${t.id}] ${t.program_id}/${t.phase || '-'} 短周期 ${step/60_000}min  anchor=${bjIso(anchor)}  next=${bjIso(next)}`)
    if (APPLY) db.prepare("UPDATE tasks SET run_at = ?, next_run_at = ?, updated_at = ? WHERE id = ?").run(anchor, next, now, t.id)
    anchored++
    continue
  }

  // 日级/周级：从 phase 分组中推算错批槽位
  const phaseKey = `${t.program_id}__${t.phase || 'none'}`
  const siblings = byPhase[phaseKey] || [t]
  const idx = siblings.indexOf(t)
  const slot = inferSlot(t)
  const slotMinutes = slot.h * 60 + slot.m + idx * INTERVAL_MINUTES
  const wallH = Math.floor(slotMinutes / 60) % 24
  const wallM = slotMinutes % 60
  const anchor = wallPast(wallH, wallM, now)
  const next = firstGridAfter(anchor, step, now)

  // 周级任务：以 anchor 的星期为基准相位（不刻意对齐周一；维持任务创建日的自然错开）
  console.log(`[#${t.id}] ${t.program_id}/${t.phase || '-'} 每${step/DAY_MS}天  ← 无锚点  分配 ${bjIso(anchor)}  next=${bjIso(next)}（错批 idx=${idx}）`)
  if (APPLY) db.prepare("UPDATE tasks SET run_at = ?, next_run_at = ?, updated_at = ? WHERE id = ?").run(anchor, next, now, t.id)
  anchored++
}

console.log(`\n结果：新建锚点 ${anchored}，重算 next ${reAnchored}，无需改动（${APPLY ? '已应用' : 'dry-run'}）`)
if (!APPLY) console.log('\n dry-run：加 --apply 参数落库。')
