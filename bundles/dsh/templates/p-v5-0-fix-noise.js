#!/usr/bin/env node
// ==============================================================================
// SilkSecAgent v5 Phase 0 数据修复：候选池噪声帽归位（幂等可重跑 + dry-run）
// 修复对象：v4 缺陷遗留的 31 条 confirmed+noise=1 僵尸候选（2026-09-06 实测）。
//   UPDATE findings SET noise=0 WHERE noise=1 AND status IN ('confirmed','submitted','accepted')
//   —— 31 条 confirmed 僵君归位信号面；
//   其余 25 条终态滞留（dup 7 + fp 5 + ignored 13）不动 noise，靠候选池口径
//   （noise=1 AND status='new'）自动出候选计数。
// 这是止血不是根治（actor 仍混杂、updateFinding 仍是自由态动词）——根治在 v5 vuln 域上线。
// 用法：node p-v5-0-fix-noise.js [--dry-run]
// ==============================================================================
import { DatabaseSync } from 'node:sqlite'
import * as path from 'node:path'

const DATA_DIR = process.env.SEC_DATA_DIR || '/opt/silkspool/dsh/data'
const DB_FILE = path.join(DATA_DIR, 'asset-graph.db')
const DRY = process.argv.includes('--dry-run')

const d = new DatabaseSync(DB_FILE)
d.exec('PRAGMA busy_timeout = 5000')

const cnt = (sql) => d.prepare(sql).get().n

const before = {
  signal: cnt('SELECT COUNT(*) AS n FROM findings WHERE noise = 0'),
  pending: cnt("SELECT COUNT(*) AS n FROM findings WHERE noise = 1 AND status = 'new'"),
  terminal: cnt("SELECT COUNT(*) AS n FROM findings WHERE noise = 1 AND status != 'new'"),
}

const rows = d.prepare(
  "SELECT id, title, status, noise FROM findings WHERE noise = 1 AND status IN ('confirmed','submitted','accepted') ORDER BY id"
).all()
console.log(`[${DRY ? 'dry-run' : '执行'}] 将摘噪声帽 ${rows.length} 条（noise=1 且 status ∈ confirmed/submitted/accepted）`)
for (const r of rows) console.log(`  #${r.id} [${r.status}] ${String(r.title).slice(0, 60)}`)

if (!DRY && rows.length > 0) {
  const res = d.prepare(
    "UPDATE findings SET noise = 0 WHERE noise = 1 AND status IN ('confirmed','submitted','accepted')"
  ).run()
  console.log(`已更新 ${res.changes} 行`)
}

if (DRY) {
  console.log('\n预期效果（dry-run 未写入）：')
  console.log(`  信号面 noise=0          : ${before.signal} → ${before.signal + rows.length}`)
  console.log(`  候选待消化 pending       : ${before.pending} → ${before.pending}`)
  console.log(`  终态滞留 terminal_in_pool: ${before.terminal} → ${before.terminal - rows.length}`)
  d.close()
  process.exit(0)
}

const after = {
  signal: cnt('SELECT COUNT(*) AS n FROM findings WHERE noise = 0'),
  pending: cnt("SELECT COUNT(*) AS n FROM findings WHERE noise = 1 AND status = 'new'"),
  terminal: cnt("SELECT COUNT(*) AS n FROM findings WHERE noise = 1 AND status != 'new'"),
}

console.log('\n口径对账（三口径一致）：')
console.log(`  信号面 noise=0          : ${before.signal} → ${after.signal}`)
console.log(`  候选待消化 pending       : ${before.pending} → ${after.pending}`)
console.log(`  终态滞留 terminal_in_pool: ${before.terminal} → ${after.terminal}`)

const ok = after.signal === before.signal + rows.length
  && after.pending === before.pending
  && after.terminal === before.terminal - rows.length
console.log(`\n${ok ? '✅ 三口径一致' : '❌ 口径对账失败，请检查'}`)

d.close()
process.exit(ok ? 0 : 1)
