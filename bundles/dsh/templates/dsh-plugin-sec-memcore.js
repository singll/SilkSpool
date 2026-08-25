// ==============================================================================
// @silksec/sec-memcore — 统一记忆治理引擎（Memory Substrate）
// 设计：doc/sec-memory-governance-design.md v2.1 / doc/sec-memcore-implementation.md v1.0
//
// 提供 cordis 服务 'secMemoryLifecycle'，五原语：
//   validateWrite / visibilityFilter / transition / recordSignal / sweep
// 职责：schema 自迁移（生命周期列 + 语义层评分列 + archive 表）、存量规则迁移、
//       每日清扫（降级/归档/硬删/自动晋升）、AGENTS.md 受管区块重写、objective lint。
//
// fail-open：本插件缺席时存储插件直透传（见 asset-db/experience 的 _bindLifecycle）；
// 本插件自身任何异常不得拖垮宿主——apply/sweep 全 try/catch。
// ==============================================================================

import * as fs from 'node:fs'
import * as path from 'node:path'

export const name = 'sec-memcore'
export const inject = []

const DATA_DIR = process.env.SEC_DATA_DIR || '/opt/silkspool/dsh/data'
const AGENTS_MD = path.join(DATA_DIR, 'AGENTS.md')
const SWEEP_LOG = path.join(DATA_DIR, 'memcore-sweep.log')
const DAY = 86400000

const log = (msg) => {
  const line = `[memcore ${new Date().toISOString()}] ${msg}`
  try { fs.appendFileSync(SWEEP_LOG, line + '\n') } catch { /* noop */ }
  process.stderr.write(line + '\n')
}

// -------------------- 策略注册表（集中可调，见实施文档 §3.3） --------------------
const POLICIES = {
  blackboard: {
    idCol: 'key', idType: 'text',
    classes: ['ephemeral', 'timeline'],
    defaultClass: 'ephemeral', defaultTtlDays: 7, ttlRangeDays: [1 / 24, 30],
    scoring: false, timelineArchiveDays: 30,
  },
  facts: {
    idCol: null, idType: 'composite', // program_id + fact_key
    classes: ['durable', 'ephemeral', 'timeline'],
    defaultClass: 'durable', defaultRevalidateDays: 30, revalidateRangeDays: [7, 90],
    defaultTtlDays: 14, ttlRangeDays: [1, 30], // note 类负知识：可见但会过期（neg_check 依赖其可见性）
    scoring: false, timelineArchiveDays: 30, coolingDays: 30,
  },
  exp_cards: {
    idCol: 'id', idType: 'int',
    classes: ['permanent'], entryStatus: 'candidate',
    scoring: true,
    autoPromote: { adopted: 2, maxNegFb: 0, ageDays: 7 },
    demote: { zeroUseDays: 30, negFb: 3 }, coolingDays: 30,
  },
  playbooks: {
    idCol: 'name', idType: 'text',
    classes: ['permanent'], entryStatus: 'active',
    scoring: 'runs',
    demote: { successRate: 0.3, minRuns: 5 }, coolingDays: 30,
  },
  kb_docs: {
    idCol: 'id', idType: 'int',
    classes: ['durable'], defaultRevalidateDays: 90, revalidateRangeDays: [7, 180],
    scoring: 'uses-only', coolingDays: 30,
  },
}
const ARCHIVE_PURGE_DAYS = 90
const JUSTIFICATION_MIN = 10
const SEMANTIC_TABLES = new Set(['exp_cards', 'playbooks', 'kb_docs'])

// -------------------- DB 接入（共享 sec-suite 的连接，失败则插件禁用） --------------------
let getDb = null
async function loadDb() {
  if (getDb) return getDb
  const mod = await import('../sec-suite/asset-db.js')
  getDb = mod.getDb
  return getDb
}

// -------------------- schema 自迁移（幂等） --------------------
const LIFECYCLE_COLS = {
  blackboard: [['mem_class', 'TEXT'], ['status', "TEXT DEFAULT 'active'"], ['status_at', 'INTEGER'], ['scope', 'TEXT'], ['expires_at', 'INTEGER'], ['justification', 'TEXT']],
  facts: [['mem_class', 'TEXT'], ['status', "TEXT DEFAULT 'active'"], ['status_at', 'INTEGER'], ['scope', 'TEXT'], ['expires_at', 'INTEGER'], ['revalidate_by', 'INTEGER'], ['justification', 'TEXT'], ['last_validated_at', 'INTEGER']],
  exp_cards: [['mem_class', 'TEXT'], ['status', "TEXT DEFAULT 'candidate'"], ['status_at', 'INTEGER'], ['scope', 'TEXT'], ['justification', 'TEXT'], ['uses', 'INTEGER DEFAULT 0'], ['adopted', 'INTEGER DEFAULT 0'], ['pos_fb', 'INTEGER DEFAULT 0'], ['neg_fb', 'INTEGER DEFAULT 0'], ['score', 'REAL DEFAULT 0'], ['last_used_at', 'INTEGER']],
  playbooks: [['mem_class', 'TEXT'], ['status', "TEXT DEFAULT 'active'"], ['status_at', 'INTEGER'], ['scope', 'TEXT'], ['justification', 'TEXT']],
  kb_docs: [['mem_class', 'TEXT'], ['status', "TEXT DEFAULT 'active'"], ['status_at', 'INTEGER'], ['scope', 'TEXT'], ['revalidate_by', 'INTEGER'], ['justification', 'TEXT'], ['last_validated_at', 'INTEGER'], ['uses', 'INTEGER DEFAULT 0'], ['last_used_at', 'INTEGER']],
}

function ensureCols(d, table, cols) {
  const existing = d.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name)
  for (const [col, type] of cols) {
    if (!existing.includes(col)) d.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`)
  }
}

function ensureArchive(d, table) {
  const cols = d.prepare(`PRAGMA table_info(${table})`).all().map((c) => `${c.name} ${c.type || 'TEXT'}`)
  d.exec(`CREATE TABLE IF NOT EXISTS ${table}_archive (${cols.join(', ')}, archived_at INTEGER, archive_reason TEXT)`)
}

function migrateSchema(d) {
  d.exec(`CREATE TABLE IF NOT EXISTS memcore_meta (key TEXT PRIMARY KEY, value TEXT)`)
  d.exec(`CREATE TABLE IF NOT EXISTS memcore_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, tbl TEXT NOT NULL, item TEXT NOT NULL,
    from_status TEXT, to_status TEXT NOT NULL, reason TEXT, actor TEXT)`)
  for (const [table, cols] of Object.entries(LIFECYCLE_COLS)) {
    ensureCols(d, table, cols)
    ensureArchive(d, table)
  }
}

// -------------------- 存量规则迁移（一次性，meta 旗标守卫） --------------------
function migrateStock(d) {
  const done = d.prepare('SELECT value FROM memcore_meta WHERE key=?').get('stock_migrated_v1')
  if (done) return
  const now = Date.now()
  const e7 = now + 7 * DAY
  const r30 = now + 30 * DAY
  const r90 = now + 90 * DAY

  // blackboard：timeline（日期键/快照前缀）| 其余 ephemeral 7 天（含 httpx 归档 note，到期自然消亡）
  const bbRows = d.prepare('SELECT key FROM blackboard').all()
  const tlRe = /^(alive|scan|recon|review):|:\d{4}-\d{2}-\d{2}/
  const upBBtl = d.prepare("UPDATE blackboard SET mem_class='timeline', status='active', status_at=?, justification='stock-migrated: 时间轴流水' WHERE key=?")
  const upBBep = d.prepare("UPDATE blackboard SET mem_class='ephemeral', status='active', status_at=?, expires_at=?, justification='stock-migrated: 工作层暂存' WHERE key=?")
  let bbTl = 0; let bbEp = 0
  for (const r of bbRows) {
    if (tlRe.test(r.key)) { upBBtl.run(now, r.key); bbTl++ } else { upBBep.run(now, e7, r.key); bbEp++ }
  }

  // facts：note→ephemeral 14 天（负知识：执行任务可读，过期自然归档）；其余 durable 30 天复验
  const e14 = now + 14 * DAY
  const upFep = d.prepare("UPDATE facts SET mem_class='ephemeral', status='active', status_at=?, expires_at=?, justification='stock-migrated: note类负知识' WHERE category='note'")
  const upFdu = d.prepare("UPDATE facts SET mem_class='durable', status='active', status_at=?, revalidate_by=?, last_validated_at=updated_at, justification='stock-migrated: 目标事实' WHERE category IS NOT 'note' OR category IS NULL")
  const fep = upFep.run(now, e14).changes
  const fdu = upFdu.run(now, r30).changes

  // 语义层
  const ec = d.prepare("UPDATE exp_cards SET mem_class='permanent', status='candidate', status_at=?, justification='stock-migrated: 存量卡待评审/自动晋升'").run(now).changes
  const pb = d.prepare("UPDATE playbooks SET mem_class='permanent', status='active', status_at=?, justification='stock-migrated'").run(now).changes
  const kb = d.prepare("UPDATE kb_docs SET mem_class='durable', status='active', status_at=?, revalidate_by=?, last_validated_at=imported_at, justification='stock-migrated: 外部知识'").run(now, r90).changes

  d.prepare('INSERT OR REPLACE INTO memcore_meta (key, value) VALUES (?, ?)').run('stock_migrated_v1', String(now))
  log(`存量迁移完成：blackboard timeline=${bbTl} ephemeral=${bbEp}；facts ephemeral=${fep} durable=${fdu}；exp candidate=${ec}；playbooks=${pb}；kb=${kb}`)
}

// -------------------- 原语 1：validateWrite --------------------
// intent: { mem_class, ttl_days, revalidate_days, scope, justification, evidence }
// R6 细化：justification 硬要求仅语义层；工作/情景层缺省分类可省略（记 auto:default）
function validateWrite(table, intent = {}) {
  const p = POLICIES[table]
  if (!p) return { ok: false, error: `memcore: 未注册的表 ${table}` }
  const cls = intent.mem_class || p.defaultClass
  if (!p.classes.includes(cls)) return { ok: false, error: `R1: ${table} 不允许 mem_class=${cls}（允许: ${p.classes.join('/')}）` }
  let justification = String(intent.justification || '').trim()
  if (SEMANTIC_TABLES.has(table)) {
    if (justification.length < JUSTIFICATION_MIN || /^(.)\1+$/.test(justification)) {
      return { ok: false, error: `R6: 语义层写入必须附 justification（≥${JUSTIFICATION_MIN}字非占位）：说明会过期吗/换目标还有用吗/谁会读它` }
    }
  } else if (!justification) {
    justification = 'auto:default 缺省分类'
  }
  const now = Date.now()
  const v = { mem_class: cls, scope: String(intent.scope || 'global'), justification }
  if (cls === 'ephemeral') {
    const ttl = Number(intent.ttl_days || p.defaultTtlDays)
    const [lo, hi] = p.ttlRangeDays
    if (!(ttl >= lo && ttl <= hi)) return { ok: false, error: `R3: ephemeral TTL 须在 ${lo}-${hi} 天区间（收到 ${ttl}）` }
    v.expires_at = now + Math.round(ttl * DAY)
  }
  if (cls === 'durable') {
    const rv = Number(intent.revalidate_days || p.defaultRevalidateDays)
    const [lo, hi] = p.revalidateRangeDays || [7, 90]
    if (!(rv >= lo && rv <= hi)) return { ok: false, error: `R4: durable 复验期须在 ${lo}-${hi} 天区间（收到 ${rv}）` }
    v.revalidate_by = now + Math.round(rv * DAY)
    v.last_validated_at = now
  }
  // permanent 禁直写（R2）：语义层入口状态由策略决定（exp_cards→candidate）
  v.status = p.entryStatus || 'active'
  return { ok: true, value: v }
}

// -------------------- 原语 2：visibilityFilter --------------------
// role: 'task'（执行）| 'review'（复盘，全量）。惰性降级：读到过期项即时归档。
function visibilityFilter(role, table, rows, getDbFn) {
  if (role === 'review') return rows
  const now = Date.now()
  const out = []
  for (const row of rows) {
    if (row.status === 'archived') continue
    if (row.mem_class === 'timeline') continue
    if (row.mem_class === 'ephemeral' && row.expires_at && row.expires_at < now) {
      try { transition(table, rowKeyOf(table, row), 'archived', 'lazy: ephemeral 过期', getDbFn) } catch { /* noop */ }
      continue
    }
    if (row.status === 'cooling') row._cooling = true
    if (row.status === 'candidate') row._candidate = true
    out.push(row)
  }
  return out
}

function rowKeyOf(table, row) {
  const p = POLICIES[table]
  if (p.idType === 'composite') return { program_id: row.program_id, fact_key: row.fact_key }
  return row[p.idCol]
}

// -------------------- 原语 3：transition --------------------
function transition(table, id, to, reason, getDbFn, actor = 'engine') {
  const d = (getDbFn || getDb)()
  const p = POLICIES[table]
  const now = Date.now()
  let from = null
  const itemStr = p.idType === 'composite' ? `${id.program_id}/${id.fact_key}` : String(id)

  if (to === 'archived') {
    const row = selectRow(d, table, id)
    if (!row) return { ok: false, error: 'not found' }
    from = row.status
    const cols = Object.keys(row)
    d.prepare(`INSERT INTO ${table}_archive (${cols.join(', ')}, archived_at, archive_reason) VALUES (${cols.map(() => '?').join(', ')}, ?, ?)`)
      .run(...cols.map((c) => row[c]), now, String(reason || ''))
    deleteRow(d, table, id)
  } else {
    const row = selectRow(d, table, id)
    if (!row) return { ok: false, error: 'not found' }
    from = row.status
    updateStatus(d, table, id, to, now)
  }
  d.prepare('INSERT INTO memcore_events (ts, tbl, item, from_status, to_status, reason, actor) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(now, table, itemStr, from, to, String(reason || ''), actor)
  return { ok: true, from, to }
}

function selectRow(d, table, id) {
  const p = POLICIES[table]
  if (p.idType === 'composite') return d.prepare(`SELECT * FROM ${table} WHERE program_id=? AND fact_key=?`).get(id.program_id, id.fact_key)
  return d.prepare(`SELECT * FROM ${table} WHERE ${p.idCol}=?`).get(id)
}
function deleteRow(d, table, id) {
  const p = POLICIES[table]
  if (p.idType === 'composite') return d.prepare(`DELETE FROM ${table} WHERE program_id=? AND fact_key=?`).run(id.program_id, id.fact_key)
  return d.prepare(`DELETE FROM ${table} WHERE ${p.idCol}=?`).run(id)
}
function updateStatus(d, table, id, status, now) {
  const p = POLICIES[table]
  if (p.idType === 'composite') return d.prepare(`UPDATE ${table} SET status=?, status_at=? WHERE program_id=? AND fact_key=?`).run(status, now, id.program_id, id.fact_key)
  return d.prepare(`UPDATE ${table} SET status=?, status_at=? WHERE ${p.idCol}=?`).run(status, now, id)
}

// -------------------- 原语 4：recordSignal --------------------
// exp_cards: searched/adopted/useful/wrong/outdated/validated
// playbooks: ran/succeeded（计数在 experience.pbOutcome 完成，这里只做降级判定）
// kb_docs:   searched/validated
function computeScore(row) {
  const daysSinceValidated = row.last_validated_at ? (Date.now() - row.last_validated_at) / DAY : 30
  return Math.round(((row.adopted || 0) * 3 + (row.pos_fb || 0) * 2 + (row.uses || 0) * 0.5
    - (row.neg_fb || 0) * 5 - Math.min(daysSinceValidated * 0.1, 5)) * 100) / 100
}

function recordSignal(table, id, signal, meta = {}) {
  const d = getDb()
  const p = POLICIES[table]
  if (!p || !p.scoring) return { ok: false, error: `memcore: ${table} 不参与信号评分` }
  const now = Date.now()

  if (table === 'exp_cards') {
    const row = selectRow(d, table, id)
    if (!row) return { ok: false, error: 'not found' }
    const u = { uses: row.uses || 0, adopted: row.adopted || 0, pos_fb: row.pos_fb || 0, neg_fb: row.neg_fb || 0 }
    if (signal === 'searched') { u.uses++; d.prepare('UPDATE exp_cards SET uses=?, last_used_at=? WHERE id=?').run(u.uses, now, id) }
    else if (signal === 'adopted') { u.adopted++; d.prepare('UPDATE exp_cards SET adopted=?, last_used_at=? WHERE id=?').run(u.adopted, now, id) }
    else if (signal === 'useful') { u.pos_fb++; d.prepare('UPDATE exp_cards SET pos_fb=?, last_used_at=? WHERE id=?').run(u.pos_fb, now, id) }
    else if (signal === 'wrong' || signal === 'outdated') { u.neg_fb++; d.prepare('UPDATE exp_cards SET neg_fb=?, last_used_at=? WHERE id=?').run(u.neg_fb, now, id) }
    else if (signal === 'validated') {
      d.prepare('UPDATE exp_cards SET last_validated_at=? WHERE id=?').run(now, id)
      if (row.status === 'cooling') transition(table, id, 'active', '复验通过自愈', null, meta.actor || 'validate')
    } else return { ok: false, error: `未知信号 ${signal}` }
    const fresh = selectRow(d, table, id)
    const score = computeScore({ ...fresh, ...u })
    d.prepare('UPDATE exp_cards SET score=? WHERE id=?').run(score, id)
    // 自动降级（托底，不等复盘）
    if (fresh.status === 'active' && u.neg_fb >= p.demote.negFb) transition(table, id, 'cooling', `neg_fb≥${p.demote.negFb}`, null, 'engine:auto')
    return { ok: true, score, status: selectRow(d, table, id).status }
  }

  if (table === 'playbooks') {
    const row = selectRow(d, table, id)
    if (!row) return { ok: false, error: 'not found' }
    if (row.status === 'active' && row.runs >= p.demote.minRuns && row.successes / row.runs < p.demote.successRate) {
      transition(table, id, 'cooling', `success_rate<${p.demote.successRate} 且 runs≥${p.demote.minRuns}`, null, 'engine:auto')
    }
    return { ok: true }
  }

  if (table === 'kb_docs') {
    if (signal === 'searched') d.prepare('UPDATE kb_docs SET uses=uses+1, last_used_at=? WHERE id=?').run(now, id)
    else if (signal === 'validated') {
      d.prepare('UPDATE kb_docs SET last_validated_at=?, revalidate_by=? WHERE id=?').run(now, now + 90 * DAY, id)
      const row = selectRow(d, table, id)
      if (row && row.status === 'cooling') transition(table, id, 'active', '复验通过自愈', null, meta.actor || 'validate')
    }
    return { ok: true }
  }
  return { ok: false, error: 'unreachable' }
}

// -------------------- 原语 5：sweep --------------------
function sweep({ dryRun = false, agentsMd = true } = {}) {
  const d = getDb()
  const now = Date.now()
  const stats = { archived: 0, cooling: 0, promoted: 0, purged: 0, lintHits: 0 }
  const doT = (table, id, to, reason) => {
    if (dryRun) { log(`[dry-run] ${table} ${JSON.stringify(id)} → ${to} (${reason})`); return }
    transition(table, id, to, reason, null, 'engine:sweep')
  }

  // blackboard：ephemeral 过期归档；timeline 超龄归档
  for (const r of d.prepare("SELECT key, mem_class, expires_at, updated_at, status FROM blackboard WHERE status != 'archived'").all()) {
    if (r.mem_class === 'ephemeral' && r.expires_at && r.expires_at < now) { doT('blackboard', r.key, 'archived', 'ephemeral 过期'); stats.archived++ }
    else if (r.mem_class === 'timeline' && r.updated_at < now - POLICIES.blackboard.timelineArchiveDays * DAY) { doT('blackboard', r.key, 'archived', 'timeline 超30天'); stats.archived++ }
  }
  // facts：ephemeral 过期归档；durable 逾期未复验→cooling；cooling 超期→归档；timeline 超龄归档
  for (const r of d.prepare('SELECT program_id, fact_key, mem_class, status, status_at, expires_at, revalidate_by, updated_at FROM facts').all()) {
    const id = { program_id: r.program_id, fact_key: r.fact_key }
    if (r.mem_class === 'ephemeral' && r.expires_at && r.expires_at < now) { doT('facts', id, 'archived', 'ephemeral 过期'); stats.archived++ }
    else if (r.mem_class === 'timeline' && r.updated_at < now - POLICIES.facts.timelineArchiveDays * DAY) { doT('facts', id, 'archived', 'timeline 超30天'); stats.archived++ }
    else if (r.mem_class === 'durable' && r.status === 'active' && r.revalidate_by && r.revalidate_by < now) { doT('facts', id, 'cooling', '复验期已过'); stats.cooling++ }
    else if (r.status === 'cooling' && r.status_at && r.status_at < now - POLICIES.facts.coolingDays * DAY) { doT('facts', id, 'archived', 'cooling 超30天'); stats.archived++ }
  }
  // exp_cards：自动晋升 + 零使用降级 + cooling 超期归档
  for (const r of d.prepare('SELECT id, status, status_at, adopted, neg_fb, uses, created_at, last_used_at FROM exp_cards').all()) {
    const ap = POLICIES.exp_cards.autoPromote
    if (r.status === 'candidate' && (r.adopted || 0) >= ap.adopted && (r.neg_fb || 0) <= ap.maxNegFb && r.created_at < now - ap.ageDays * DAY) {
      doT('exp_cards', r.id, 'active', `自动晋升: adopted≥${ap.adopted} 零负反馈 存活≥${ap.ageDays}d`); stats.promoted++
    } else if (r.status === 'active' && (r.uses || 0) === 0 && r.created_at < now - POLICIES.exp_cards.demote.zeroUseDays * DAY) {
      doT('exp_cards', r.id, 'cooling', '零使用超30天'); stats.cooling++
    } else if (r.status === 'cooling' && r.status_at && r.status_at < now - POLICIES.exp_cards.coolingDays * DAY) {
      doT('exp_cards', r.id, 'archived', 'cooling 超30天'); stats.archived++
    }
  }
  // playbooks：低成功率降级；cooling 超期归档
  for (const r of d.prepare('SELECT name, status, status_at, runs, successes FROM playbooks').all()) {
    const dm = POLICIES.playbooks.demote
    if (r.status === 'active' && r.runs >= dm.minRuns && r.successes / r.runs < dm.successRate) { doT('playbooks', r.name, 'cooling', '低成功率'); stats.cooling++ }
    else if (r.status === 'cooling' && r.status_at && r.status_at < now - POLICIES.playbooks.coolingDays * DAY) { doT('playbooks', r.name, 'archived', 'cooling 超30天'); stats.archived++ }
  }
  // kb_docs：同 facts durable
  for (const r of d.prepare('SELECT id, status, status_at, revalidate_by FROM kb_docs').all()) {
    if (r.status === 'active' && r.revalidate_by && r.revalidate_by < now) { doT('kb_docs', r.id, 'cooling', '复验期已过'); stats.cooling++ }
    else if (r.status === 'cooling' && r.status_at && r.status_at < now - POLICIES.kb_docs.coolingDays * DAY) { doT('kb_docs', r.id, 'archived', 'cooling 超30天'); stats.archived++ }
  }
  // archive 超 90 天硬删
  for (const t of Object.keys(POLICIES)) {
    const n = dryRun ? 0 : d.prepare(`DELETE FROM ${t}_archive WHERE archived_at < ?`).run(now - ARCHIVE_PURGE_DAYS * DAY).changes
    stats.purged += n
  }
  // objective lint：interval 任务 objective 携带故障词/陈旧日期 → 告警（红线兜底）
  for (const t of d.prepare("SELECT id, objective FROM tasks WHERE schedule_kind IS NOT NULL AND status NOT IN ('cancelled')").all()) {
    const hits = []
    if (/卡死|blocked-env/.test(t.objective)) hits.push('故障文本')
    const m = t.objective.match(/20\d{2}-\d{2}-\d{2}/g)
    if (m && m.some((s) => Date.now() - new Date(s).getTime() > 3 * DAY)) hits.push(`陈旧日期(${m[0]})`)
    if (hits.length) {
      stats.lintHits++
      log(`objective-lint: task #${t.id} 命中 ${hits.join('、')}——persona/objective 禁止承载具体事实/故障/状态`)
    }
  }
  if (!dryRun && agentsMd) rewriteAgentsMd(d)
  log(`sweep 完成: ${JSON.stringify(stats)}${dryRun ? ' (dry-run)' : ''}`)
  return stats
}

// -------------------- AGENTS.md 受管区块 --------------------
const BLOCK_BEGIN = '<!-- memcore:begin -->'
const BLOCK_END = '<!-- memcore:end -->'
function rewriteAgentsMd(d) {
  const top = d.prepare("SELECT id, scenario, takeaway, score, adopted FROM exp_cards WHERE mem_class='permanent' AND status='active' ORDER BY score DESC LIMIT 5").all()
  const envIssues = d.prepare("SELECT key, value FROM blackboard WHERE key LIKE '[env-issue]%' AND status='active' AND (expires_at IS NULL OR expires_at > ?)").all(Date.now())
  const lines = [
    BLOCK_BEGIN,
    `## 记忆基架状态（memcore 引擎生成 ${new Date().toISOString().slice(0, 16)}，标记内勿手改）`,
    '',
    '### 高分经验卡（permanent·active Top5，exp_search 可查全量）',
    ...(top.length ? top.map((c) => `- #${c.id} ${c.scenario} → ${String(c.takeaway).slice(0, 80)}（score ${c.score}, adopted ${c.adopted}）`) : ['- （暂无——新卡经 candidate 评审/自动晋升后进入）']),
    '',
    '### 现行环境故障 [env-issue]',
    ...(envIssues.length ? envIssues.map((k) => `- ${k.key}: ${String(k.value).slice(0, 100)}`) : ['- （无）']),
    '',
    '### 记忆纪律（写记忆前三问，答案写进 justification）',
    '- 它会过期吗？→ 会：ephemeral(≤30d)/durable(需复验)；不会且换目标仍有用：才配进经验卡(candidate 起步)',
    '- 目标特定事实进 facts/finding，禁止进经验卡；故障/流水只进黑板 [env-issue]/timeline，禁止进 objective/persona',
    '- cooling 标记的事实/卡片用到即复验（exp_validate / 更新 fact 刷新 last_validated_at）',
    BLOCK_END,
  ]
  const block = lines.join('\n')
  let existing = ''
  try { existing = fs.readFileSync(AGENTS_MD, 'utf8') } catch { /* 不存在 */ }
  const bi = existing.indexOf(BLOCK_BEGIN); const ei = existing.indexOf(BLOCK_END)
  const next = (bi >= 0 && ei > bi)
    ? existing.slice(0, bi) + block + existing.slice(ei + BLOCK_END.length)
    : (existing ? existing.trimEnd() + '\n\n' : '') + block + '\n'
  fs.writeFileSync(AGENTS_MD, next)
}

// -------------------- 状态查询（看板/诊断用） --------------------
function status() {
  const d = getDb()
  const out = { loaded: true, tables: {}, lastSweep: null }
  for (const t of Object.keys(POLICIES)) {
    out.tables[t] = {}
    for (const r of d.prepare(`SELECT COALESCE(status,'active') s, COUNT(*) n FROM ${t} GROUP BY s`).all()) out.tables[t][r.s] = r.n
    const arch = d.prepare(`SELECT COUNT(*) n FROM ${t}_archive`).get().n
    if (arch) out.tables[t].archived = arch
  }
  const last = d.prepare('SELECT MAX(ts) ts FROM memcore_events').get()
  out.lastEvent = last && last.ts ? new Date(last.ts).toISOString() : null
  return out
}

// -------------------- 插件入口 --------------------
export async function apply(ctx, config = {}) {
  try {
    await loadDb()
  } catch (e) {
    process.stderr.write(`[memcore] 无法接入 sec-suite 存储层，插件禁用: ${e?.message}\n`)
    return
  }
  const d = getDb()
  try {
    migrateSchema(d)
    migrateStock(d)
  } catch (e) {
    process.stderr.write(`[memcore] schema/存量迁移失败，插件禁用: ${e?.message}\n`)
    return
  }

  const api = {
    validateWrite: (table, intent) => validateWrite(table, intent),
    visibilityFilter: (role, table, rows) => visibilityFilter(role, table, rows),
    transition: (table, id, to, reason, actor) => transition(table, id, to, reason, null, actor),
    recordSignal: (table, id, signal, meta) => recordSignal(table, id, signal, meta),
    sweep: (opts) => sweep(opts),
    status: () => status(),
    policies: POLICIES,
  }
  ctx.provide('secMemoryLifecycle', api)
  log('secMemoryLifecycle 服务已提供')

  // sweeper：仅 web 宿主面跑（headless worker 进程不跑），默认每 6 小时 + 启动后 90s 首跑
  const isWeb = process.argv.includes('web')
  const sweeperOn = config.sweeper !== false && isWeb
  if (sweeperOn) {
    const intervalMs = Math.max(1, Number(config.intervalHours || 6)) * 3600000
    const timer = setInterval(() => { try { sweep({ agentsMd: config.agentsMd !== false }) } catch (e) { log(`sweep 异常: ${e?.message}`) } }, intervalMs)
    timer.unref?.()
    setTimeout(() => { try { sweep({ agentsMd: config.agentsMd !== false }) } catch (e) { log(`首跑 sweep 异常: ${e?.message}`) } }, 90000).unref?.()
    ctx.effect?.(() => () => clearInterval(timer))
    log(`sweeper 已启动（间隔 ${intervalMs / 3600000}h）`)
  } else {
    log(`sweeper 未启动（${isWeb ? '配置关闭' : '非 web 宿主面'}）`)
  }
}
