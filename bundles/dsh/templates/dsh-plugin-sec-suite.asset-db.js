// ==============================================================================
// SilkSecAgent asset-graph 存储层（node:sqlite，零依赖，WAL）
// 表：assets / endpoints / findings / blackboard
// 被 sec-cli-adapter（自动入库）与 asset-graph 插件（模型工具）共用
// ==============================================================================

import { DatabaseSync } from 'node:sqlite'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as crypto from 'node:crypto'

const DATA_DIR = process.env.SEC_DATA_DIR || '/opt/silkspool/dsh/data'
const DB_FILE = path.join(DATA_DIR, 'asset-graph.db')

let db = null

export function getDb() {
  if (db) return db
  fs.mkdirSync(DATA_DIR, { recursive: true })
  db = new DatabaseSync(DB_FILE)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS assets (
      host TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'host',
      source TEXT,
      attrs TEXT,
      first_seen INTEGER NOT NULL,
      last_seen INTEGER NOT NULL,
      PRIMARY KEY (host, type)
    );
    CREATE TABLE IF NOT EXISTS endpoints (
      host TEXT NOT NULL,
      method TEXT NOT NULL DEFAULT 'GET',
      path TEXT NOT NULL,
      status TEXT,
      source TEXT,
      first_seen INTEGER NOT NULL,
      last_seen INTEGER NOT NULL,
      PRIMARY KEY (host, method, path)
    );
    CREATE TABLE IF NOT EXISTS findings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fingerprint TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      severity TEXT,
      host TEXT,
      url TEXT,
      evidence TEXT,
      source TEXT,
      status TEXT NOT NULL DEFAULT 'new',
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS blackboard (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_endpoints_host ON endpoints(host);
    CREATE INDEX IF NOT EXISTS idx_findings_host ON findings(host);
  `)
  // ---- P6 脊柱：programs / tasks 表（跨会话领域实体，自建持久层）----
  db.exec(`
    CREATE TABLE IF NOT EXISTS programs (
      id TEXT PRIMARY KEY,
      platform TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      max_risk TEXT,
      fixed_egress_ip INTEGER DEFAULT 0,
      created_at INTEGER, updated_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      program_id TEXT NOT NULL,
      parent_id INTEGER,
      phase TEXT,
      objective TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      priority INTEGER NOT NULL DEFAULT 5,
      assignee TEXT,
      budget_tokens INTEGER,
      spent_tokens INTEGER DEFAULT 0,
      session_id TEXT,
      blocked_reason TEXT,
      result TEXT,
      created_at INTEGER, updated_at INTEGER, started_at INTEGER, finished_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_queue ON tasks(program_id, status, priority);
  `)
  // ---- 平滑迁移：给存量表补 program_id / task_id（可空，幂等）----
  const ensureCol = (table, col, ddl) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all()
    if (!cols.some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`)
  }
  ensureCol('assets', 'program_id', 'program_id TEXT')
  ensureCol('endpoints', 'program_id', 'program_id TEXT')
  ensureCol('findings', 'program_id', 'program_id TEXT')
  ensureCol('findings', 'task_id', 'task_id INTEGER')
  // ---- P8：事实图谱 + 指纹 / 凭据 / 接口鉴权 / finding 报告模板 ----
  db.exec(`
    CREATE TABLE IF NOT EXISTS facts (
      program_id TEXT NOT NULL,
      fact_key TEXT NOT NULL,
      category TEXT,
      summary TEXT,
      body TEXT,
      confidence TEXT DEFAULT 'tentative',
      pinned INTEGER DEFAULT 0,
      related_finding_id INTEGER,
      source TEXT,
      updated_at INTEGER,
      PRIMARY KEY (program_id, fact_key)
    );
    CREATE TABLE IF NOT EXISTS fact_edges (
      program_id TEXT NOT NULL,
      src_key TEXT NOT NULL,
      dst_key TEXT NOT NULL,
      edge_type TEXT NOT NULL,
      confidence TEXT,
      PRIMARY KEY (program_id, src_key, dst_key, edge_type)
    );
    CREATE TABLE IF NOT EXISTS fingerprints (
      program_id TEXT, host TEXT, tech TEXT, version TEXT, source TEXT, last_seen INTEGER,
      PRIMARY KEY (host, tech)
    );
    CREATE TABLE IF NOT EXISTS credentials (
      id INTEGER PRIMARY KEY AUTOINCREMENT, program_id TEXT, host TEXT,
      cred_type TEXT, ref TEXT, role TEXT, note TEXT, created_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_facts_program ON facts(program_id);
    CREATE INDEX IF NOT EXISTS idx_edges_src ON fact_edges(program_id, src_key);
    CREATE INDEX IF NOT EXISTS idx_edges_dst ON fact_edges(program_id, dst_key);
    CREATE INDEX IF NOT EXISTS idx_fp_host ON fingerprints(host);
  `)
  ensureCol('endpoints', 'params', 'params TEXT')
  ensureCol('endpoints', 'auth_required', 'auth_required TEXT')
  ensureCol('endpoints', 'roles_seen', 'roles_seen TEXT')
  ensureCol('findings', 'vuln_type', 'vuln_type TEXT')
  ensureCol('findings', 'cwe', 'cwe TEXT')
  ensureCol('findings', 'endpoint_ref', 'endpoint_ref TEXT')
  ensureCol('findings', 'preconditions', 'preconditions TEXT')
  ensureCol('findings', 'reproduction_steps', 'reproduction_steps TEXT')
  ensureCol('findings', 'impact', 'impact TEXT')
  ensureCol('findings', 'recommendation', 'recommendation TEXT')
  ensureCol('findings', 'submitted_at', 'submitted_at INTEGER')
  ensureCol('findings', 'vendor_status', 'vendor_status TEXT')
  ensureCol('findings', 'bounty', 'bounty REAL')
  return db
}

const now = () => Date.now()

// node:sqlite 返回 null-prototype 对象，DSH 工具输出要求无损 JSON——统一转普通对象
const plain = (rows) => rows.map((r) => ({ ...r }))

export function upsertAsset({ host, type = 'host', source = '', attrs = null, program_id = null }) {
  if (!host) return false
  getDb().prepare(`
    INSERT INTO assets (host, type, source, attrs, program_id, first_seen, last_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (host, type) DO UPDATE SET last_seen = excluded.last_seen,
      source = CASE WHEN excluded.source != '' THEN excluded.source ELSE assets.source END,
      program_id = CASE WHEN excluded.program_id IS NOT NULL THEN excluded.program_id ELSE assets.program_id END
  `).run(host, type, source, attrs ? JSON.stringify(attrs) : null, program_id, now(), now())
  return true
}

export function upsertEndpoint({ host, method = 'GET', path: p = '/', status = '', source = '', program_id = null, params = null, auth_required = null, roles_seen = null }) {
  if (!host || !p) return false
  getDb().prepare(`
    INSERT INTO endpoints (host, method, path, status, source, program_id, params, auth_required, roles_seen, first_seen, last_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (host, method, path) DO UPDATE SET last_seen = excluded.last_seen,
      status = CASE WHEN excluded.status != '' THEN excluded.status ELSE endpoints.status END,
      program_id = CASE WHEN excluded.program_id IS NOT NULL THEN excluded.program_id ELSE endpoints.program_id END,
      params = CASE WHEN excluded.params IS NOT NULL THEN excluded.params ELSE endpoints.params END,
      auth_required = CASE WHEN excluded.auth_required IS NOT NULL THEN excluded.auth_required ELSE endpoints.auth_required END,
      roles_seen = CASE WHEN excluded.roles_seen IS NOT NULL THEN excluded.roles_seen ELSE endpoints.roles_seen END
  `).run(host, method.toUpperCase(), p, String(status), source, program_id, params ? JSON.stringify(params) : null, auth_required, roles_seen ? JSON.stringify(roles_seen) : null, now(), now())
  return true
}

export function addFinding({
  title, severity = 'info', host = '', url = '', evidence = '', source = '', program_id = null,
  vuln_type = null, cwe = null, endpoint_ref = null, preconditions = null, reproduction_steps = null,
  impact = null, recommendation = null,
}) {
  const fingerprint = crypto.createHash('sha1').update(`${host}|${title}|${url}`).digest('hex')
  const d = getDb()
  const dup = d.prepare('SELECT id, status FROM findings WHERE fingerprint = ?').get(fingerprint)
  if (dup) return { id: dup.id, dup: true, status: dup.status }
  const r = d.prepare(`
    INSERT INTO findings (fingerprint, title, severity, host, url, evidence, source, program_id,
      vuln_type, cwe, endpoint_ref, preconditions, reproduction_steps, impact, recommendation, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?)
  `).run(fingerprint, title, severity, host, url, evidence, source, program_id,
    vuln_type, cwe, endpoint_ref, preconditions, reproduction_steps, impact, recommendation, now())
  return { id: Number(r.lastInsertRowid), dup: false }
}

export function queryAssets({ hostLike = '', type = '', programId = '', limit = 50, offset = 0 }) {
  const { where, args } = assetWhere({ hostLike, type, programId })
  const sql = `SELECT host, type, source, program_id, last_seen FROM assets WHERE ${where} ORDER BY last_seen DESC LIMIT ? OFFSET ?`
  return plain(getDb().prepare(sql).all(...args, Math.min(limit, 200), Math.max(0, offset)))
}

export function countAssets(filters = {}) {
  const { where, args } = assetWhere(filters)
  return getDb().prepare(`SELECT COUNT(*) AS n FROM assets WHERE ${where}`).get(...args).n
}

function assetWhere({ hostLike = '', type = '', programId = '' }) {
  let where = '1=1'
  const args = []
  if (hostLike) { where += ' AND host LIKE ?'; args.push(`%${hostLike}%`) }
  if (type) { where += ' AND type = ?'; args.push(type) }
  if (programId) { where += ' AND program_id = ?'; args.push(programId) }
  return { where, args }
}

export function queryEndpoints({ host = '', pathLike = '', programId = '', limit = 50, offset = 0 }) {
  const { where, args } = endpointWhere({ host, pathLike, programId })
  const sql = `SELECT host, method, path, status, source, program_id, last_seen FROM endpoints WHERE ${where} ORDER BY last_seen DESC LIMIT ? OFFSET ?`
  return plain(getDb().prepare(sql).all(...args, Math.min(limit, 200), Math.max(0, offset)))
}

export function countEndpoints(filters = {}) {
  const { where, args } = endpointWhere(filters)
  return getDb().prepare(`SELECT COUNT(*) AS n FROM endpoints WHERE ${where}`).get(...args).n
}

function endpointWhere({ host = '', pathLike = '', programId = '' }) {
  let where = '1=1'
  const args = []
  if (host) { where += ' AND host = ?'; args.push(host) }
  if (pathLike) { where += ' AND path LIKE ?'; args.push(`%${pathLike}%`) }
  if (programId) { where += ' AND program_id = ?'; args.push(programId) }
  return { where, args }
}

export function queryFindings({ host = '', severity = '', status = '', programId = '', q = '', limit = 50, offset = 0 }) {
  const { where, args } = findingWhere({ host, severity, status, programId, q })
  const sql = `SELECT id, title, severity, host, url, evidence, source, status, program_id, created_at FROM findings WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
  return plain(getDb().prepare(sql).all(...args, Math.min(limit, 200), Math.max(0, offset)))
}

export function countFindings(filters = {}) {
  const { where, args } = findingWhere(filters)
  return getDb().prepare(`SELECT COUNT(*) AS n FROM findings WHERE ${where}`).get(...args).n
}

function findingWhere({ host = '', severity = '', status = '', programId = '', q = '' }) {
  let where = '1=1'
  const args = []
  if (host) { where += ' AND host = ?'; args.push(host) }
  if (severity) { where += ' AND severity = ?'; args.push(severity) }
  if (status) { where += ' AND status = ?'; args.push(status) }
  if (programId) { where += ' AND program_id = ?'; args.push(programId) }
  if (q) { where += ' AND (title LIKE ? OR host LIKE ? OR url LIKE ?)'; args.push(`%${q}%`, `%${q}%`, `%${q}%`) }
  return { where, args }
}

export function stats() {
  const d = getDb()
  const count = (t) => d.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n
  const byType = plain(d.prepare('SELECT type, COUNT(*) AS n FROM assets GROUP BY type ORDER BY n DESC').all())
  const bySev = plain(d.prepare('SELECT severity, COUNT(*) AS n FROM findings GROUP BY severity').all())
  return {
    assets: count('assets'), endpoints: count('endpoints'),
    findings: count('findings'), blackboard_keys: count('blackboard'),
    programs: count('programs'), tasks: count('tasks'),
    assets_by_type: byType, findings_by_severity: bySev,
  }
}

// -------------------- P6：programs 同步（scope.yml 镜像）+ tasks 生命周期 --------------------

export function upsertProgram({ id, platform = '', max_risk = null, status = 'active' }) {
  if (!id) return false
  getDb().prepare(`
    INSERT INTO programs (id, platform, status, max_risk, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET platform = excluded.platform, status = excluded.status,
      max_risk = excluded.max_risk, updated_at = excluded.updated_at
  `).run(id, platform, status, max_risk, now(), now())
  return true
}

export function listPrograms() {
  return plain(getDb().prepare('SELECT id, platform, status, max_risk FROM programs ORDER BY id').all())
}

const TASK_STATUS = ['queued', 'running', 'blocked', 'done', 'failed', 'cancelled']

export function taskCreate({ program_id, phase = '', objective, priority = 5, budget_tokens = null, parent_id = null, assignee = '' }) {
  if (!program_id || !objective) return { ok: false, error: 'program_id 与 objective 必填' }
  const d = getDb()
  const r = d.prepare(`
    INSERT INTO tasks (program_id, parent_id, phase, objective, priority, assignee, budget_tokens, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)
  `).run(program_id, parent_id, phase, objective, priority, assignee, budget_tokens, now(), now())
  return { ok: true, id: Number(r.lastInsertRowid) }
}

export function taskUpdate({ id, status, note = '', blocked_reason = '', result = '' }) {
  if (!TASK_STATUS.includes(status)) return { ok: false, error: `非法状态 ${status}（可选: ${TASK_STATUS.join('/')}）` }
  const d = getDb()
  const sets = ['status = ?', 'updated_at = ?']
  const args = [status, now()]
  if (blocked_reason) { sets.push('blocked_reason = ?'); args.push(blocked_reason) }
  if (result) { sets.push('result = ?'); args.push(result) }
  if (status === 'running') { sets.push('started_at = COALESCE(started_at, ?)'); args.push(now()) }
  if (status === 'done' || status === 'failed' || status === 'cancelled') { sets.push('finished_at = ?'); args.push(now()) }
  args.push(Number(id))
  const r = d.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...args)
  if (r.changes === 0) return { ok: false, error: `task 不存在: ${id}` }
  if (note) {
    const cur = d.prepare('SELECT result FROM tasks WHERE id = ?').get(Number(id))
    d.prepare('UPDATE tasks SET result = ? WHERE id = ?')
      .run(`${cur.result || ''}\n[${new Date().toISOString().slice(0, 16)}] ${status}: ${note}`.trim(), Number(id))
  }
  return { ok: true, id: Number(id), status }
}

export function taskList({ programId = '', status = '', phase = '', q = '', limit = 50, offset = 0 }) {
  const { where, args } = taskWhere({ programId, status, phase, q })
  const sql = `SELECT * FROM tasks WHERE ${where} ORDER BY priority ASC, created_at ASC LIMIT ? OFFSET ?`
  return plain(getDb().prepare(sql).all(...args, Math.min(limit, 200), Math.max(0, offset)))
}

export function countTasks(filters = {}) {
  const { where, args } = taskWhere(filters)
  return getDb().prepare(`SELECT COUNT(*) AS n FROM tasks WHERE ${where}`).get(...args).n
}

function taskWhere({ programId = '', status = '', phase = '', q = '' }) {
  let where = '1=1'
  const args = []
  if (programId) { where += ' AND program_id = ?'; args.push(programId) }
  if (status) { where += ' AND status = ?'; args.push(status) }
  if (phase) { where += ' AND phase = ?'; args.push(phase) }
  if (q) { where += ' AND objective LIKE ?'; args.push(`%${q}%`) }
  return { where, args }
}

export function taskNext(programId) {
  const d = getDb()
  const rows = plain(d.prepare(
    'SELECT * FROM tasks WHERE program_id = ? AND status = ? ORDER BY priority ASC, created_at ASC'
  ).all(programId, 'queued'))
  for (const t of rows) {
    if (t.parent_id) {
      const p = d.prepare('SELECT status FROM tasks WHERE id = ?').get(t.parent_id)
      if (!p || p.status !== 'done') continue
    }
    return t
  }
  return null
}

export function taskStats(programId) {
  const d = getDb()
  const rows = plain(d.prepare(
    'SELECT phase, status, COUNT(*) AS n FROM tasks WHERE program_id = ? GROUP BY phase, status'
  ).all(programId))
  const total = d.prepare('SELECT COUNT(*) AS n FROM tasks WHERE program_id = ?').get(programId).n
  return { program_id: programId, total, by_phase_status: rows }
}

// -------------------- P8：事实图谱（facts + fact_edges）--------------------

const FACT_CONFIDENCE = ['confirmed', 'tentative', 'deprecated']

export function factUpsert({ program_id, fact_key, category = '', summary = '', body = '', confidence = 'tentative', pinned = 0, related_finding_id = null, source = '' }) {
  if (!program_id || !fact_key) return { ok: false, error: 'program_id 与 fact_key 必填（fact_key 格式 category/slug）' }
  if (!FACT_CONFIDENCE.includes(confidence)) return { ok: false, error: `非法 confidence ${confidence}（可选: ${FACT_CONFIDENCE.join('/')}）` }
  getDb().prepare(`
    INSERT INTO facts (program_id, fact_key, category, summary, body, confidence, pinned, related_finding_id, source, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (program_id, fact_key) DO UPDATE SET
      category = excluded.category, summary = excluded.summary, body = excluded.body,
      confidence = excluded.confidence, pinned = excluded.pinned,
      related_finding_id = excluded.related_finding_id, source = excluded.source, updated_at = excluded.updated_at
  `).run(program_id, fact_key, category, summary, body, confidence, pinned ? 1 : 0, related_finding_id, source, now())
  return { ok: true, program_id, fact_key }
}

export function factGet(program_id, fact_key) {
  const row = getDb().prepare('SELECT * FROM facts WHERE program_id = ? AND fact_key = ?').get(program_id, fact_key)
  return row ? { ...row } : null
}

export function factSearch({ program_id = '', category = '', q = '', confidence = '', limit = 50, offset = 0 }) {
  const { where, args } = factWhere({ program_id, category, q, confidence })
  const sql = `SELECT program_id, fact_key, category, summary, confidence, pinned, related_finding_id, updated_at FROM facts WHERE ${where} ORDER BY pinned DESC, updated_at DESC LIMIT ? OFFSET ?`
  return plain(getDb().prepare(sql).all(...args, Math.min(limit, 200), Math.max(0, offset)))
}

export function countFacts(filters = {}) {
  const { where, args } = factWhere(filters)
  return getDb().prepare(`SELECT COUNT(*) AS n FROM facts WHERE ${where}`).get(...args).n
}

function factWhere({ program_id = '', category = '', q = '', confidence = '' }) {
  let where = '1=1'
  const args = []
  if (program_id) { where += ' AND program_id = ?'; args.push(program_id) }
  if (category) { where += ' AND category = ?'; args.push(category) }
  if (confidence) { where += ' AND confidence = ?'; args.push(confidence) }
  if (q) { where += ' AND (summary LIKE ? OR fact_key LIKE ? OR body LIKE ?)'; args.push(`%${q}%`, `%${q}%`, `%${q}%`) }
  return { where, args }
}

export function factLink({ program_id, src_key, dst_key, edge_type, confidence = 'tentative' }) {
  if (!program_id || !src_key || !dst_key || !edge_type) return { ok: false, error: 'program_id/src_key/dst_key/edge_type 必填' }
  getDb().prepare(`
    INSERT OR REPLACE INTO fact_edges (program_id, src_key, dst_key, edge_type, confidence)
    VALUES (?, ?, ?, ?, ?)
  `).run(program_id, src_key, dst_key, edge_type, confidence)
  return { ok: true }
}

export function factGraph(program_id, fact_key) {
  const d = getDb()
  const node = factGet(program_id, fact_key)
  const out = plain(d.prepare('SELECT dst_key, edge_type, confidence FROM fact_edges WHERE program_id = ? AND src_key = ?').all(program_id, fact_key))
  const inc = plain(d.prepare('SELECT src_key, edge_type, confidence FROM fact_edges WHERE program_id = ? AND dst_key = ?').all(program_id, fact_key))
  return { ok: true, node, out, in: inc }
}

// -------------------- P8：指纹 / 凭据 --------------------

export function fpAdd({ program_id = null, host, tech, version = '', source = '' }) {
  if (!host || !tech) return false
  getDb().prepare(`
    INSERT INTO fingerprints (program_id, host, tech, version, source, last_seen)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (host, tech) DO UPDATE SET version = CASE WHEN excluded.version != '' THEN excluded.version ELSE fingerprints.version END, last_seen = excluded.last_seen
  `).run(program_id, host, tech, version, source, now())
  return true
}

export function fpQuery({ host = '', tech = '', program_id = '', limit = 50 }) {
  let sql = 'SELECT program_id, host, tech, version, source, last_seen FROM fingerprints WHERE 1=1'
  const args = []
  if (host) { sql += ' AND host = ?'; args.push(host) }
  if (tech) { sql += ' AND tech LIKE ?'; args.push(`%${tech}%`) }
  if (program_id) { sql += ' AND program_id = ?'; args.push(program_id) }
  sql += ' ORDER BY last_seen DESC LIMIT ?'
  args.push(Math.min(limit, 200))
  return plain(getDb().prepare(sql).all(...args))
}

export function credAdd({ program_id = null, host = '', cred_type = '', ref = '', role = '', note = '' }) {
  const r = getDb().prepare(`
    INSERT INTO credentials (program_id, host, cred_type, ref, role, note, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(program_id, host, cred_type, ref, role, note, now())
  return { ok: true, id: Number(r.lastInsertRowid) }
}

export function credQuery({ program_id = '', host = '', limit = 50 }) {
  let sql = 'SELECT id, program_id, host, cred_type, ref, role, note, created_at FROM credentials WHERE 1=1'
  const args = []
  if (program_id) { sql += ' AND program_id = ?'; args.push(program_id) }
  if (host) { sql += ' AND host = ?'; args.push(host) }
  sql += ' ORDER BY created_at DESC LIMIT ?'
  args.push(Math.min(limit, 200))
  return plain(getDb().prepare(sql).all(...args))
}

export function bbSet(key, value) {
  getDb().prepare('INSERT INTO blackboard (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
    .run(String(key), String(value), now())
  return true
}

export function bbGet(key) {
  const d = getDb()
  if (key) {
    const row = d.prepare('SELECT key, value, updated_at FROM blackboard WHERE key = ?').get(String(key))
    return row ? { ...row } : null
  }
  return plain(d.prepare('SELECT key, value, updated_at FROM blackboard ORDER BY updated_at DESC LIMIT 100').all())
}

// -------------------- P5：finding 状态流转 + 报告 --------------------

const FINDING_STATUS = ['new', 'confirmed', 'false_positive', 'submitted', 'accepted', 'dup', 'ignored']

export function updateFinding({ id, status, note = '' }) {
  if (!FINDING_STATUS.includes(status)) return { ok: false, error: `非法状态 ${status}（可选: ${FINDING_STATUS.join('/')}）` }
  const d = getDb()
  const r = d.prepare('UPDATE findings SET status = ? WHERE id = ?').run(status, Number(id))
  if (r.changes === 0) return { ok: false, error: `finding 不存在: ${id}` }
  if (note) {
    const cur = d.prepare('SELECT evidence FROM findings WHERE id = ?').get(Number(id))
    d.prepare('UPDATE findings SET evidence = ? WHERE id = ?')
      .run(`${cur.evidence}\n[${new Date().toISOString().slice(0, 16)}] ${status}: ${note}`, Number(id))
  }
  // 活评测集（P9）：confirmed/false_positive 判定回流成评测用例，供误报率统计
  if (status === 'confirmed' || status === 'false_positive') {
    const f = d.prepare('SELECT title, host, url, vuln_type FROM findings WHERE id = ?').get(Number(id))
    if (f) appendLiveEval({ finding_id: Number(id), host: f.host || '', url: f.url || '', title: f.title, vuln_type: f.vuln_type || '', verdict: status })
  }
  return { ok: true, id: Number(id), status }
}

// 活评测集落盘：data/eval/eval-live.jsonl（每行一条实战判定，用于误报率/发现率复盘）
function appendLiveEval(rec) {
  try {
    const dir = path.join(DATA_DIR, 'eval')
    fs.mkdirSync(dir, { recursive: true })
    fs.appendFileSync(path.join(dir, 'eval-live.jsonl'), JSON.stringify({ ...rec, ts: Date.now() }) + '\n')
  } catch { /* 评测回流失败不阻断 */ }
}

export function buildReport({ hostLike = '', sinceDays = 0, status = '', programId = '' }) {
  const d = getDb()
  const args = []
  let sql = 'SELECT * FROM findings WHERE 1=1'
  if (hostLike) { sql += ' AND host LIKE ?'; args.push(`%${hostLike}%`) }
  if (status) { sql += ' AND status = ?'; args.push(status) }
  if (programId) { sql += ' AND program_id = ?'; args.push(programId) }
  if (sinceDays > 0) { sql += ' AND created_at >= ?'; args.push(Date.now() - sinceDays * 86400000) }
  sql += ' ORDER BY created_at DESC'
  const rows = plain(d.prepare(sql).all(...args))

  const bySev = {}
  for (const r of rows) bySev[r.severity || 'info'] = (bySev[r.severity || 'info'] || 0) + 1

  const md = [
    `# SilkSecAgent 漏洞报告`,
    ``,
    `- 生成时间: ${new Date().toISOString()}`,
    `- 范围: ${hostLike || '全部'}${sinceDays ? `（近 ${sinceDays} 天）` : ''}`,
    `- 合计: ${rows.length} 个发现（${Object.entries(bySev).map(([k, v]) => `${k}:${v}`).join(' / ') || '无'}）`,
    ``,
    `| # | 级别 | 状态 | 标题 | 目标 | 证据 |`,
    `|---|---|---|---|---|---|`,
    ...rows.map((r) => `| ${r.id} | ${r.severity} | ${r.status} | ${r.title.replace(/\|/g, '\\|')} | ${r.url || r.host} | ${String(r.evidence).split('\n')[0].slice(0, 80).replace(/\|/g, '\\|')} |`),
    ``,
  ].join('\n')

  const dir = path.join(DATA_DIR, 'reports')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `report-${Date.now()}.md`)
  fs.writeFileSync(file, md)
  return { file, total: rows.length, by_severity: bySev }
}

// -------------------- 文本自动抽取（run_cli 结果入库用） --------------------

const URL_RE = /https?:\/\/[^\s"'<>()\[\]{}|,;\\]+/gi
const HOST_RE = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?::\d{1,5})?$/i

export function ingestText(source, text) {
  let assets = 0; let endpoints = 0
  const seen = new Set()
  for (const line of String(text).split('\n')) {
    for (const m of line.match(URL_RE) || []) {
      try {
        const u = new URL(m)
        const key = `${u.host}${u.pathname}`
        if (seen.has(key)) continue
        seen.add(key)
        if (upsertAsset({ host: u.host, type: 'web', source })) assets++
        if (upsertEndpoint({ host: u.host, method: 'GET', path: u.pathname + u.search, source })) endpoints++
      } catch { /* 非法 URL 跳过 */ }
    }
    const bare = line.trim()
    if (HOST_RE.test(bare) && !seen.has(bare)) {
      seen.add(bare)
      if (upsertAsset({ host: bare, type: 'domain', source })) assets++
    }
  }
  return { assets, endpoints }
}
