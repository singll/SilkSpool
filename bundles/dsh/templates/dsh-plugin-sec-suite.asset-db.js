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

export function upsertEndpoint({ host, method = 'GET', path: p = '/', status = '', source = '', program_id = null }) {
  if (!host || !p) return false
  getDb().prepare(`
    INSERT INTO endpoints (host, method, path, status, source, program_id, first_seen, last_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (host, method, path) DO UPDATE SET last_seen = excluded.last_seen,
      status = CASE WHEN excluded.status != '' THEN excluded.status ELSE endpoints.status END,
      program_id = CASE WHEN excluded.program_id IS NOT NULL THEN excluded.program_id ELSE endpoints.program_id END
  `).run(host, method.toUpperCase(), p, String(status), source, program_id, now(), now())
  return true
}

export function addFinding({ title, severity = 'info', host = '', url = '', evidence = '', source = '', program_id = null }) {
  const fingerprint = crypto.createHash('sha1').update(`${host}|${title}|${url}`).digest('hex')
  const d = getDb()
  const dup = d.prepare('SELECT id, status FROM findings WHERE fingerprint = ?').get(fingerprint)
  if (dup) return { id: dup.id, dup: true, status: dup.status }
  const r = d.prepare(`
    INSERT INTO findings (fingerprint, title, severity, host, url, evidence, source, program_id, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'new', ?)
  `).run(fingerprint, title, severity, host, url, evidence, source, program_id, now())
  return { id: Number(r.lastInsertRowid), dup: false }
}

export function queryAssets({ hostLike = '', type = '', programId = '', limit = 50 }) {
  let sql = 'SELECT host, type, source, program_id, last_seen FROM assets WHERE 1=1'
  const args = []
  if (hostLike) { sql += ' AND host LIKE ?'; args.push(`%${hostLike}%`) }
  if (type) { sql += ' AND type = ?'; args.push(type) }
  if (programId) { sql += ' AND program_id = ?'; args.push(programId) }
  sql += ' ORDER BY last_seen DESC LIMIT ?'
  args.push(Math.min(limit, 200))
  return plain(getDb().prepare(sql).all(...args))
}

export function queryEndpoints({ host = '', pathLike = '', programId = '', limit = 50 }) {
  let sql = 'SELECT host, method, path, status, source, program_id, last_seen FROM endpoints WHERE 1=1'
  const args = []
  if (host) { sql += ' AND host = ?'; args.push(host) }
  if (pathLike) { sql += ' AND path LIKE ?'; args.push(`%${pathLike}%`) }
  if (programId) { sql += ' AND program_id = ?'; args.push(programId) }
  sql += ' ORDER BY last_seen DESC LIMIT ?'
  args.push(Math.min(limit, 200))
  return plain(getDb().prepare(sql).all(...args))
}

export function queryFindings({ host = '', severity = '', status = '', programId = '', limit = 50 }) {
  let sql = 'SELECT id, title, severity, host, url, evidence, source, status, program_id, created_at FROM findings WHERE 1=1'
  const args = []
  if (host) { sql += ' AND host = ?'; args.push(host) }
  if (severity) { sql += ' AND severity = ?'; args.push(severity) }
  if (status) { sql += ' AND status = ?'; args.push(status) }
  if (programId) { sql += ' AND program_id = ?'; args.push(programId) }
  sql += ' ORDER BY created_at DESC LIMIT ?'
  args.push(Math.min(limit, 200))
  return plain(getDb().prepare(sql).all(...args))
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

export function taskList({ programId = '', status = '', phase = '', limit = 50 }) {
  let sql = 'SELECT * FROM tasks WHERE 1=1'
  const args = []
  if (programId) { sql += ' AND program_id = ?'; args.push(programId) }
  if (status) { sql += ' AND status = ?'; args.push(status) }
  if (phase) { sql += ' AND phase = ?'; args.push(phase) }
  sql += ' ORDER BY priority ASC, created_at ASC LIMIT ?'
  args.push(Math.min(limit, 200))
  return plain(getDb().prepare(sql).all(...args))
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
  return { ok: true, id: Number(id), status }
}

export function buildReport({ hostLike = '', sinceDays = 0, status = '' }) {
  const d = getDb()
  const args = []
  let sql = 'SELECT * FROM findings WHERE 1=1'
  if (hostLike) { sql += ' AND host LIKE ?'; args.push(`%${hostLike}%`) }
  if (status) { sql += ' AND status = ?'; args.push(status) }
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
