#!/usr/bin/env node
// ==============================================================================
// SilkSecAgent v5 Phase 1 正式版数据迁移（02-vuln.md §3.3「Phase 1 正式版」）
// 职责（全部幂等，可反复重跑，setup 内执行）：
//   1. 复跑 Phase 0 修复：noise=1 且 status ∈ confirmed/submitted/accepted → noise=0
//      （2026-09-06 已执行过的环境应零变更）；
//   2. ensureCol 幂等补列：claimed_by/claimed_at/updated_at/remote_id/
//      remote_synced_at/sync_state（6 列）+ idx_findings_pool/idx_findings_claim（2 索引）；
//   3. updated_at 回填：UPDATE findings SET updated_at=created_at WHERE updated_at IS NULL；
//   4. 修复后断言三口径一致（signal / candidate.pending / terminal_in_pool，
//      默认相对对账；--expect s,p,t 可附加硬断言）。
// 审计：迁移动作本身以 v5 新格式落 data/audit.jsonl（kind:'migration'，01-bus §3.3），
//   变更>0 → result:'changed'；零变更 → result:'noop'；失败 → result:'failed'（fail-closed）。
// 用法：node p-v5-1-migrate-vuln.js [--dry-run] [--expect 41,2,25]
//   环境：SEC_DATA_DIR（默认 /opt/silkspool/dsh/data）
// ==============================================================================
import { DatabaseSync } from 'node:sqlite'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as crypto from 'node:crypto'

const DATA_DIR = process.env.SEC_DATA_DIR || '/opt/silkspool/dsh/data'
const DB_FILE = path.join(DATA_DIR, 'asset-graph.db')
const AUDIT_FILE = path.join(DATA_DIR, 'audit.jsonl')
const DRY = process.argv.includes('--dry-run')
const expectArg = process.argv.find((a) => a.startsWith('--expect='))
const EXPECT = expectArg ? expectArg.split('=')[1].split(',').map((n) => Number(n)) : null

const d = new DatabaseSync(DB_FILE)
d.exec('PRAGMA busy_timeout = 10000')

const cnt = (sql) => d.prepare(sql).get().n
const metric = () => ({
  signal: cnt('SELECT COUNT(*) AS n FROM findings WHERE noise = 0'),
  pending: cnt("SELECT COUNT(*) AS n FROM findings WHERE noise = 1 AND status = 'new'"),
  terminal: cnt("SELECT COUNT(*) AS n FROM findings WHERE noise = 1 AND status != 'new'"),
})

const before = metric()
const phase0 = d.prepare(
  "SELECT id, title, status, noise FROM findings WHERE noise = 1 AND status IN ('confirmed','submitted','accepted') ORDER BY id"
).all()

// ---- ensureCol 列定义（与 sec-backend-vuln-sqlite.js V5_COLS 一致） ----
const V5_COLS = [
  ['claimed_by', 'claimed_by TEXT'],
  ['claimed_at', 'claimed_at INTEGER'],
  ['updated_at', 'updated_at INTEGER'],
  ['remote_id', 'remote_id TEXT'],
  ['remote_synced_at', 'remote_synced_at INTEGER'],
  ['sync_state', 'sync_state TEXT'],
]

function ensureCol(col, ddl) {
  const cols = d.prepare('PRAGMA table_info(findings)').all()
  if (cols.some((c) => c.name === col)) return { added: false }
  try {
    d.exec(`ALTER TABLE findings ADD COLUMN ${ddl}`)
    return { added: true }
  } catch (e) {
    if (/duplicate column/i.test(String(e?.message))) return { added: false }
    throw e
  }
}

function auditAppend(rec) {
  fs.appendFileSync(AUDIT_FILE, JSON.stringify(rec) + '\n', 'utf8')
}

const started = Date.now()
const dryLog = (msg) => console.log(`[${DRY ? 'dry-run' : '执行'}] ${msg}`)

// ---- 1. Phase 0 修复复跑（幂等） ----
dryLog(`Phase 0 修复复跑：${phase0.length} 条待摘帽（应已为零）`)
for (const r of phase0) console.log(`  #${r.id} [${r.status}] ${String(r.title).slice(0, 60)}`)

// ---- 2. ensureCol 探测（dry-run 只读，不执行 ALTER） ----
function probeCols() {
  const cols = d.prepare('PRAGMA table_info(findings)').all().map((c) => c.name)
  const missing = V5_COLS.filter(([col]) => !cols.includes(col)).map(([col]) => col)
  const idx = d.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='findings'").all().map((r) => r.name)
  return { missing, missingIdx: ['idx_findings_pool', 'idx_findings_claim'].filter((i) => !idx.includes(i)) }
}
const probe = probeCols()
dryLog(`ensureCol：缺列 ${probe.missing.length ? probe.missing.join(',') : '无（已就位）'}；缺索引 ${probe.missingIdx.length ? probe.missingIdx.join(',') : '无（已就位）'}`)

// ---- 3. updated_at 回填（幂等：WHERE IS NULL；列缺失时待补列后执行） ----
const nullRows = probe.missing.includes('updated_at')
  ? null
  : cnt('SELECT COUNT(*) AS n FROM findings WHERE updated_at IS NULL')
dryLog(`updated_at 回填：${nullRows === null ? '列未就位（随补列执行）' : `${nullRows} 条待回填（updated_at=created_at）`}`)

// ---- 4. dry-run 收尾（零写入） ----
if (DRY) {
  console.log('\n预期效果（dry-run 未写入）：')
  console.log(`  Phase 0 摘帽 : ${phase0.length} 条 → noise=0`)
  console.log(`  新增列        : ${probe.missing.length ? probe.missing.join(', ') : '无'}`)
  console.log(`  新增索引      : ${probe.missingIdx.length ? probe.missingIdx.join(', ') : '无'}`)
  console.log(`  updated_at 回填: ${nullRows} 条`)
  console.log(`  三口径（当前）: signal=${before.signal} / pending=${before.pending} / terminal=${before.terminal}`)
  d.close()
  process.exit(0)
}

// ---- 5. 实际执行（全部幂等语句） ----
let changed = 0
for (const [col, ddl] of V5_COLS) {
  if (probe.missing.includes(col)) {
    const r = ensureCol(col, ddl)
    if (r.added) changed++
  }
}
for (const idx of probe.missingIdx) {
  d.exec(idx === 'idx_findings_pool'
    ? 'CREATE INDEX IF NOT EXISTS idx_findings_pool ON findings(noise, status)'
    : 'CREATE INDEX IF NOT EXISTS idx_findings_claim ON findings(claimed_at)')
  changed++
}
if (phase0.length > 0) {
  const r = d.prepare(
    "UPDATE findings SET noise = 0 WHERE noise = 1 AND status IN ('confirmed','submitted','accepted')"
  ).run()
  changed += r.changes
}
if (nullRows > 0 || nullRows === null) {
  const r = d.prepare('UPDATE findings SET updated_at = created_at WHERE updated_at IS NULL').run()
  changed += r.changes
}

// ---- 6. 断言三口径一致 ----
const after = metric()
const relOk = after.signal === before.signal + phase0.length
  && after.pending === before.pending
  && after.terminal === before.terminal - phase0.length
let expectOk = true
let expectDetail = ''
if (EXPECT) {
  const [es, ep, et] = EXPECT
  expectOk = after.signal === es && after.pending === ep && after.terminal === et
  expectDetail = `（期望 ${es}/${ep}/${et}）`
}
const ok = relOk && expectOk

console.log('\n口径对账：')
console.log(`  信号面 noise=0          : ${before.signal} → ${after.signal}`)
console.log(`  候选待消化 pending       : ${before.pending} → ${after.pending}`)
console.log(`  终态滞留 terminal_in_pool: ${before.terminal} → ${after.terminal}`)
console.log(`  相对对账 ${relOk ? '✅' : '❌'} ${expectDetail}${EXPECT ? ` 硬断言 ${expectOk ? '✅' : '❌'}` : ''}`)
console.log(`\n${ok ? '✅ 三口径一致，迁移完成' : '❌ 口径对账失败，请检查'}`)

// ---- 7. audit（v5 新格式；变更>0 → changed，零变更 → noop，失败 → failed） ----
try {
  auditAppend({
    ts: started, kind: 'migration', domain: 'vuln', cmd: 'migrate_vuln_phase1',
    actor: 'script', session_id: null, operator: null,
    idempotency_key: crypto.createHash('sha1').update(`v5:migration:vuln:phase1:${DB_FILE}`).digest('hex').slice(0, 32),
    replay: false, target: null,
    before: { ...before },
    after: { ...after },
    meta: { phase0_rows: phase0.length, cols_added: probe.missing, updated_at_backfilled: nullRows, changed },
    result: changed > 0 ? 'changed' : (ok ? 'noop' : 'failed'),
    error_code: ok ? null : 'E_MIGRATION_ASSERT',
    duration_ms: Date.now() - started, backend: 'sqlite-local',
  })
} catch (e) {
  console.error(`[p-v5-1] audit 写入失败: ${e?.message}`)
  d.close()
  process.exit(1)
}

d.close()
process.exit(ok ? 0 : 1)