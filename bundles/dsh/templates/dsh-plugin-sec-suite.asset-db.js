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
  db.exec('PRAGMA busy_timeout = 5000')       // P0-2：争锁等待 5s，取代立即抛 database is locked
  db.exec('PRAGMA synchronous = NORMAL')      // P0-2：WAL 下安全且更快
  db.exec('PRAGMA wal_autocheckpoint = 1000') // P0-2：约 4MB 自动 checkpoint，防 WAL 无限膨胀
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
  // ---- P11：工作区融合 + 定时任务 + run→session 映射（可空，幂等）----
  ensureCol('programs', 'workspace_id', 'workspace_id TEXT')     // DSH workspace UUID（1:1 软绑定）
  ensureCol('programs', 'workspace_path', 'workspace_path TEXT') // 镜像，免查 registry
  ensureCol('findings', 'session_id', 'session_id TEXT')         // 来源会话（跳链）
  ensureCol('tasks', 'schedule_kind', 'schedule_kind TEXT')      // NULL=普通 / once / interval
  ensureCol('tasks', 'run_at', 'run_at INTEGER')                 // once：到期时间戳
  ensureCol('tasks', 'every_seconds', 'every_seconds INTEGER')   // interval：间隔（≥300）
  ensureCol('tasks', 'next_run_at', 'next_run_at INTEGER')       // 调度循环扫描键
  ensureCol('tasks', 'last_run_at', 'last_run_at INTEGER')
  ensureCol('tasks', 'last_run_id', 'last_run_id TEXT')
  db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(schedule_kind, next_run_at)')
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
  impact = null, recommendation = null, session_id = null,
}) {
  const fingerprint = crypto.createHash('sha1').update(`${host}|${title}|${url}`).digest('hex')
  const d = getDb()
  const dup = d.prepare('SELECT id, status FROM findings WHERE fingerprint = ?').get(fingerprint)
  if (dup) {
    // 已存在的 finding 补上缺失的 session_id（不覆盖已有值）
    if (session_id) d.prepare('UPDATE findings SET session_id = COALESCE(session_id, ?) WHERE id = ?').run(session_id, dup.id)
    return { id: dup.id, dup: true, status: dup.status }
  }
  const r = d.prepare(`
    INSERT INTO findings (fingerprint, title, severity, host, url, evidence, source, program_id,
      vuln_type, cwe, endpoint_ref, preconditions, reproduction_steps, impact, recommendation, session_id, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?)
  `).run(fingerprint, title, severity, host, url, evidence, source, program_id,
    vuln_type, cwe, endpoint_ref, preconditions, reproduction_steps, impact, recommendation, session_id, now())
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
  const sql = `SELECT id, title, severity, host, url, evidence, source, status, program_id, session_id, created_at FROM findings WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
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
    facts: count('facts'),
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

// 工作区绑定（P11）：program ↔ DSH workspace 1:1 软绑定；workspace_id 传 null 解绑
export function bindProgramWorkspace(program_id, workspace_id, workspace_path) {
  const r = getDb().prepare('UPDATE programs SET workspace_id = ?, workspace_path = ?, updated_at = ? WHERE id = ?')
    .run(workspace_id || null, workspace_path || null, now(), program_id)
  return r.changes > 0
}

// scope.yml 删除程序 ≠ 删数据：programs 行归档保留归属关系
export function archiveProgram(id) {
  const r = getDb().prepare("UPDATE programs SET status = 'archived', updated_at = ? WHERE id = ?").run(now(), id)
  return r.changes > 0
}

// 会话 cwd → program（经工作区路径匹配），供 task_create 自动带出归属
export function programByWorkspacePath(cwd) {
  if (!cwd) return null
  const row = getDb().prepare(
    "SELECT id FROM programs WHERE workspace_path = ? AND status = 'active'"
  ).get(String(cwd))
  return row ? row.id : null
}

export function listPrograms() {
  return plain(getDb().prepare('SELECT id, platform, status, max_risk, workspace_id, workspace_path FROM programs ORDER BY id').all())
}

const TASK_STATUS = ['queued', 'running', 'blocked', 'done', 'failed', 'cancelled']
const MIN_INTERVAL_SECONDS = 300 // 对齐 dsh-schedule 下限

// schedule: { kind: 'once', at: <epoch ms> } | { kind: 'interval', every_seconds: <s>=300+ } | 缺省=普通任务
function normalizeSchedule(schedule) {
  if (!schedule) return { kind: null, run_at: null, every_seconds: null, next_run_at: null }
  const kind = String(schedule.kind || '')
  if (kind === 'once') {
    const at = Number(schedule.at)
    if (!Number.isFinite(at) || at <= now()) return { error: 'once 调度需要未来的 at 时间戳（毫秒）' }
    return { kind, run_at: at, every_seconds: null, next_run_at: at }
  }
  if (kind === 'interval') {
    const every = Number(schedule.every_seconds)
    if (!Number.isInteger(every) || every < MIN_INTERVAL_SECONDS) {
      return { error: `interval 调度需要 every_seconds ≥ ${MIN_INTERVAL_SECONDS} 的整数` }
    }
    return { kind, run_at: null, every_seconds: every, next_run_at: now() + every * 1000 }
  }
  return { error: `非法 schedule.kind: ${kind || '(空)'}（可选: once/interval）` }
}

export function taskCreate({ program_id, phase = '', objective, priority = 5, budget_tokens = null, parent_id = null, assignee = '', session_id = null, schedule = null }) {
  if (!program_id || !objective) return { ok: false, error: 'program_id 与 objective 必填' }
  const sched = normalizeSchedule(schedule)
  if (sched.error) return { ok: false, error: sched.error }
  const d = getDb()
  const r = d.prepare(`
    INSERT INTO tasks (program_id, parent_id, phase, objective, priority, assignee, budget_tokens,
      session_id, schedule_kind, run_at, every_seconds, next_run_at, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)
  `).run(program_id, parent_id, phase, objective, priority, assignee, budget_tokens,
    session_id, sched.kind, sched.run_at, sched.every_seconds, sched.next_run_at, now(), now())
  return { ok: true, id: Number(r.lastInsertRowid), schedule: sched.kind ? { kind: sched.kind, next_run_at: sched.next_run_at } : null }
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

// -------------------- P11：定时调度 --------------------

// 修改/暂停/恢复调度。schedule=null 表示清除调度（变普通任务）。
export function taskSchedule({ id, schedule }) {
  const d = getDb()
  const t = d.prepare('SELECT id, status FROM tasks WHERE id = ?').get(Number(id))
  if (!t) return { ok: false, error: `task 不存在: ${id}` }
  if (['done', 'failed', 'cancelled'].includes(t.status)) return { ok: false, error: `task #${id} 已终态（${t.status}），不能改调度` }
  const sched = normalizeSchedule(schedule)
  if (sched.error) return { ok: false, error: sched.error }
  d.prepare('UPDATE tasks SET schedule_kind = ?, run_at = ?, every_seconds = ?, next_run_at = ?, updated_at = ? WHERE id = ?')
    .run(sched.kind, sched.run_at, sched.every_seconds, sched.next_run_at, now(), Number(id))
  return { ok: true, id: Number(id), schedule: sched.kind ? { kind: sched.kind, next_run_at: sched.next_run_at } : null }
}

// 立即触发一次（不动调度节律）：把 next_run_at 拨到现在，调度循环下个 tick 认领
export function taskRunNow(id) {
  const d = getDb()
  const t = d.prepare('SELECT id, status FROM tasks WHERE id = ?').get(Number(id))
  if (!t) return { ok: false, error: `task 不存在: ${id}` }
  if (t.status !== 'queued') return { ok: false, error: `task #${id} 当前 ${t.status}，仅 queued 可立即触发` }
  d.prepare('UPDATE tasks SET next_run_at = ?, updated_at = ? WHERE id = ?').run(now(), now(), Number(id))
  return { ok: true, id: Number(id), hint: '已排入调度队列，下一 tick（≤60s）认领执行' }
}

// 调度循环认领（原子抢占，防重启/双实例重复派单）：到期 scheduled 任务 → running
export function taskClaimDue(nowTs) {
  const d = getDb()
  d.exec('BEGIN IMMEDIATE')
  try {
    const due = plain(d.prepare(
      "SELECT id FROM tasks WHERE schedule_kind IS NOT NULL AND status = 'queued' AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY priority ASC, next_run_at ASC LIMIT 4"
    ).all(nowTs))
    const claimed = []
    const upd = d.prepare("UPDATE tasks SET status = 'running', started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ? AND status = 'queued'")
    for (const row of due) {
      const r = upd.run(nowTs, nowTs, row.id)
      if (r.changes === 1) claimed.push(row.id)
    }
    if (!claimed.length) { d.exec('COMMIT'); return [] }
    const marks = claimed.map(() => '?').join(',')
    const tasks = plain(d.prepare(`SELECT * FROM tasks WHERE id IN (${marks})`).all(...claimed))
    d.exec('COMMIT')
    return tasks
  } catch (e) {
    try { d.exec('ROLLBACK') } catch { /* 已回滚 */ }
    throw e
  }
}

// 调度执行收尾：记录 last_run_*，interval 任务 latest-only 续期回 queued，once 任务进终态
export function taskFinishScheduledRun({ id, ok, run_id, note = '' }) {
  const d = getDb()
  const t = d.prepare('SELECT * FROM tasks WHERE id = ?').get(Number(id))
  if (!t) return { ok: false, error: `task 不存在: ${id}` }
  const finished = now()
  let nextRunAt = null
  let status = ok ? 'done' : 'failed'
  if (t.schedule_kind === 'interval' && t.every_seconds) {
    // latest-only：从原定锚点按整数倍推进到第一个未来点，错过的不补跑
    const anchor = t.next_run_at || finished
    const step = t.every_seconds * 1000
    nextRunAt = anchor + Math.max(1, Math.ceil((finished - anchor) / step)) * step
    status = 'queued'
  }
  const tail = `${t.result || ''}\n[${new Date().toISOString().slice(0, 16)}] run ${run_id}: ${ok ? 'done' : 'failed'}${note ? ' — ' + note : ''}`.trim()
  d.prepare(`UPDATE tasks SET status = ?, result = ?, last_run_at = ?, last_run_id = ?, next_run_at = ?,
    finished_at = CASE WHEN ? IN ('done','failed') THEN ? ELSE finished_at END, updated_at = ? WHERE id = ?`)
    .run(status, tail.slice(-8000), finished, run_id || null, nextRunAt, status, finished, now(), Number(id))
  return { ok: true, id: Number(id), status, next_run_at: nextRunAt }
}

// 僵尸回收（P0-3）：宿主进程崩溃/超时导致 running 卡死的 scheduled 任务 → 回收。
// once 任务标 failed（终态），interval 任务退回 queued（下次续期）。默认超龄 1 小时（对齐 worker timeout 上限）。
export function taskReapStale(maxAgeMs = 3600000) {
  const d = getDb()
  const cutoff = now() - maxAgeMs
  const stale = plain(d.prepare(
    "SELECT id, schedule_kind FROM tasks WHERE status = 'running' AND schedule_kind IS NOT NULL AND started_at IS NOT NULL AND started_at < ?"
  ).all(cutoff))
  let reaped = 0
  for (const t of stale) {
    const status = t.schedule_kind === 'interval' ? 'queued' : 'failed'
    const r = d.prepare("UPDATE tasks SET status = ?, blocked_reason = '宿主重启/超时回收', updated_at = ? WHERE id = ? AND status = 'running'")
      .run(status, now(), t.id)
    if (r.changes === 1) reaped++
  }
  return { reaped }
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

// P2-1 事实图谱自动建边：扫描 program 的 facts，按共享域名根 / /24 网段建关系边（star 型控边数，
// 超大组跳过防噪声）。让孤立事实点集成图，支撑攻击面聚类与关系遍历。幂等（INSERT OR REPLACE）。
const _HOST_RE = /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}\b/gi
const _IP_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g
export function factReindexEdges(program_id) {
  if (!program_id) return { ok: false, error: 'program_id 必填' }
  const d = getDb()
  const facts = plain(d.prepare('SELECT fact_key, summary, body FROM facts WHERE program_id = ?').all(program_id))
  const tokenMap = {} // token(域名根 / /24 段) -> [fact_key]
  for (const f of facts) {
    const text = `${f.fact_key} ${f.summary || ''} ${f.body || ''}`
    const tokens = new Set()
    for (const m of text.match(_HOST_RE) || []) tokens.add(m.toLowerCase().split('.').slice(-2).join('.'))
    for (const m of text.match(_IP_RE) || []) tokens.add(m.split('.').slice(0, 3).join('.') + '.0/24')
    for (const t of tokens) (tokenMap[t] || (tokenMap[t] = [])).push(f.fact_key)
  }
  let edges = 0
  let groups = 0
  for (const [token, keys] of Object.entries(tokenMap)) {
    const uniq = [...new Set(keys)]
    if (uniq.length < 2 || uniq.length > 50) continue // 单点无边；超大组跳过（噪声）
    groups++
    const edgeType = token.includes('/') ? 'same-subnet' : 'same-domain'
    const center = uniq[0]
    for (let i = 1; i < uniq.length; i++) {
      factLink({ program_id, src_key: center, dst_key: uniq[i], edge_type: edgeType, confidence: 'tentative' })
      edges++
    }
  }
  return { ok: true, program_id, facts: facts.length, groups, edges }
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

// 活评测回流（P9 环3）：读 eval-live.jsonl 聚合各漏洞类型的确认/误报统计，供 eval_stats 工具与报告校准可信度
export function evalStats() {
  const file = path.join(DATA_DIR, 'eval', 'eval-live.jsonl')
  const byType = {}
  let total = 0
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue
      let r; try { r = JSON.parse(line) } catch { continue }
      total++
      const t = r.vuln_type || 'unknown'
      if (!byType[t]) byType[t] = { confirmed: 0, false_positive: 0 }
      if (r.verdict === 'confirmed') byType[t].confirmed++
      else if (r.verdict === 'false_positive') byType[t].false_positive++
    }
  } catch { /* 无评测文件 → 空统计 */ }
  for (const t of Object.keys(byType)) {
    const s = byType[t]; const n = s.confirmed + s.false_positive
    s.fp_rate = n ? Math.round((s.false_positive / n) * 100) / 100 : 0
  }
  return { total, by_type: byType }
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

export function ingestText(source, text, program_id = null) {
  let assets = 0; let endpoints = 0
  const seen = new Set()
  for (const line of String(text).split('\n')) {
    for (const m of line.match(URL_RE) || []) {
      try {
        const u = new URL(m)
        const key = `${u.host}${u.pathname}`
        if (seen.has(key)) continue
        seen.add(key)
        if (upsertAsset({ host: u.host, type: 'web', source, program_id })) assets++
        if (upsertEndpoint({ host: u.host, method: 'GET', path: u.pathname + u.search, source, program_id })) endpoints++
      } catch { /* 非法 URL 跳过 */ }
    }
    const bare = line.trim()
    if (HOST_RE.test(bare) && !seen.has(bare)) {
      seen.add(bare)
      if (upsertAsset({ host: bare, type: 'domain', source, program_id })) assets++
    }
  }
  return { assets, endpoints }
}
