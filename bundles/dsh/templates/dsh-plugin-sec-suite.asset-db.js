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

function beijingDate(ts = Date.now()) {
  return new Date(ts + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

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
  // ---- P12：定时任务执行历史（task 行不再因重复跑而增殖；每次运行落一行历史）----
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      run_id TEXT,
      ok INTEGER NOT NULL DEFAULT 0,
      note TEXT,
      started_at INTEGER,
      finished_at INTEGER,
      duration_ms INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_task_runs_task ON task_runs(task_id, id DESC);
    CREATE INDEX IF NOT EXISTS idx_task_runs_finished ON task_runs(finished_at DESC);
  `)
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
  // ---- worker 注册表：spawn_worker run 生命周期账本（重启幂等恢复用）----
  db.exec(`
    CREATE TABLE IF NOT EXISTS workers (
      run_id TEXT PRIMARY KEY,
      dedupe_key TEXT,
      task TEXT, cwd TEXT, pid INTEGER,
      status TEXT NOT NULL DEFAULT 'running',
      exit_code INTEGER,
      started_at INTEGER, finished_at INTEGER,
      timeout_sec INTEGER, session_id TEXT, run_dir TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_workers_key ON workers(dedupe_key, started_at);
  `)
  // P13 资产评级列（SABC 可挖掘性打分体系，幂等 ALTER）
  const assetCols = db.prepare('PRAGMA table_info(assets)').all().map((c) => c.name)
  for (const [col, ctype] of [['score', 'INTEGER'], ['level', 'TEXT'], ['accept', 'TEXT'], ['biz', 'TEXT'], ['state', 'TEXT']]) {
    if (!assetCols.includes(col)) db.exec(`ALTER TABLE assets ADD COLUMN ${col} ${ctype}`)
  }
  // ---- P15 噪声闸门：info 级模板指纹（ssl-issuer/wildcard-tls…）默认不进信号面 ----
  // noise=1 的行全查询/报告/KPI 默认排除（includeNoise 显式查看）；存量 info 一次性回填。
  ensureCol('findings', 'noise', "noise INTEGER NOT NULL DEFAULT 0")
  db.exec('CREATE INDEX IF NOT EXISTS idx_findings_noise ON findings(noise)')
  db.exec("UPDATE findings SET noise = 1 WHERE severity = 'info' AND noise = 0")
  // ---- P15：调度 run 的 worker 会话 id（看板跳链）----
  ensureCol('task_runs', 'session_id', 'session_id TEXT')
  // ---- P17：Cairn_Y 融合——FGS 图（Fact-Goal-Step Graph）作为任务状态外化记忆 ----
  db.exec(`
    CREATE TABLE IF NOT EXISTS fgs_nodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      run_id TEXT,
      type TEXT NOT NULL CHECK(type IN ('fact','goal','step','finding')),
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','running','done','failed','blocked','deprecated')),
      content TEXT NOT NULL DEFAULT '{}',
      score REAL DEFAULT 0,
      parent_id INTEGER REFERENCES fgs_nodes(id),
      depends_on TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_fgs_task ON fgs_nodes(task_id, type, status);
    CREATE INDEX IF NOT EXISTS idx_fgs_run ON fgs_nodes(run_id);
  `)
  // ---- P17：Finding 过程产物（confidence + 与 FGS 节点关联）----
  ensureCol('findings', 'confidence', "confidence TEXT NOT NULL DEFAULT 'tentative' CHECK(confidence IN ('tentative','confirmed','false_positive','dup'))")
  ensureCol('findings', 'fgs_node_id', 'fgs_node_id INTEGER')
  ensureCol('findings', 'discovery_step', 'discovery_step TEXT')
  return db
}

const now = () => Date.now()

// node:sqlite 返回 null-prototype 对象，DSH 工具输出要求无损 JSON——统一转普通对象
const plain = (rows) => rows.map((r) => ({ ...r }))

export function upsertAsset({ host, type = 'host', source = '', attrs = null, program_id = null, score = null, level = null, accept = null, biz = null, state = null }) {
  if (!host) return false
  // 评级字段（score/level/accept/biz/state，rules/src/asset-scoring.md 体系）：null=不动既有值
  getDb().prepare(`
    INSERT INTO assets (host, type, source, attrs, program_id, first_seen, last_seen, score, level, accept, biz, state)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (host, type) DO UPDATE SET last_seen = excluded.last_seen,
      source = CASE WHEN excluded.source != '' THEN excluded.source ELSE assets.source END,
      program_id = CASE WHEN excluded.program_id IS NOT NULL THEN excluded.program_id ELSE assets.program_id END,
      score = COALESCE(excluded.score, assets.score),
      level = COALESCE(excluded.level, assets.level),
      accept = COALESCE(excluded.accept, assets.accept),
      biz = COALESCE(excluded.biz, assets.biz),
      state = COALESCE(excluded.state, assets.state)
  `).run(host, type, source, attrs ? JSON.stringify(attrs) : null, program_id, now(), now(), score, level, accept, biz, state)
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
  confidence = null, fgs_node_id = null, discovery_step = null,
}) {
  // P15 噪声闸门：info 级 = 模板指纹/侦察副产物，不进 findings 信号面（noise=1）。
  // 噪声行指纹弱化为 host|title（同模板同目标只留一行，URL 变体不再增殖）。
  const noise = String(severity) === 'info' ? 1 : 0
  const fingerprint = crypto.createHash('sha1')
    .update(noise ? `${host}|${title}` : `${host}|${title}|${url}`).digest('hex')
  const d = getDb()
  const dup = d.prepare('SELECT id, status FROM findings WHERE fingerprint = ?').get(fingerprint)
  if (dup) {
    // 已存在的 finding 补上缺失的 session_id（不覆盖已有值）
    if (session_id) d.prepare('UPDATE findings SET session_id = COALESCE(session_id, ?) WHERE id = ?').run(session_id, dup.id)
    return { id: dup.id, dup: true, status: dup.status, noise: !!noise }
  }
  const r = d.prepare(`
    INSERT INTO findings (fingerprint, title, severity, host, url, evidence, source, program_id,
      vuln_type, cwe, endpoint_ref, preconditions, reproduction_steps, impact, recommendation, session_id, noise, status, created_at,
      confidence, fgs_node_id, discovery_step)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?,
      COALESCE(?, 'tentative'), ?, ?)
  `).run(fingerprint, title, severity, host, url, evidence, source, program_id,
    vuln_type, cwe, endpoint_ref, preconditions, reproduction_steps, impact, recommendation, session_id, noise, now(),
    confidence, fgs_node_id, discovery_step)
  return { id: Number(r.lastInsertRowid), dup: false, noise: !!noise }
}

// 排序白名单（防注入）：仅这些列可作 ORDER BY，未知值回落默认列
const ASSET_SORT = { last_seen: 'last_seen', host: 'host', type: 'type', program_id: 'program_id', score: 'score' }
function orderClause(map, sort, dir, dflt) {
  const col = map[sort] || dflt
  const dr = String(dir || '').toLowerCase() === 'asc' ? 'ASC' : 'DESC'
  return `${col} ${dr}`
}

export function queryAssets({ hostLike = '', type = '', programId = '', level = '', levelIn = '', accept = '', limit = 50, offset = 0, sort = '', dir = '' }) {
  const { where, args } = assetWhere({ hostLike, type, programId, level, levelIn, accept })
  const sql = `SELECT host, type, source, program_id, last_seen, score, level, accept, biz, state FROM assets WHERE ${where} ORDER BY ${orderClause(ASSET_SORT, sort, dir, 'last_seen')} LIMIT ? OFFSET ?`
  return plain(getDb().prepare(sql).all(...args, Math.min(limit, 200), Math.max(0, offset)))
}

export function countAssets(filters = {}) {
  const { where, args } = assetWhere(filters)
  return getDb().prepare(`SELECT COUNT(*) AS n FROM assets WHERE ${where}`).get(...args).n
}

function assetWhere({ hostLike = '', type = '', programId = '', level = '', levelIn = '', accept = '' }) {
  let where = '1=1'
  const args = []
  if (hostLike) { where += ' AND host LIKE ?'; args.push(`%${hostLike}%`) }
  if (type) { where += ' AND type = ?'; args.push(type) }
  if (programId) { where += ' AND program_id = ?'; args.push(programId) }
  if (level) { where += ' AND level = ?'; args.push(level) }
  // P15 资产准入：多级过滤（如 "S,A,B"）——主动扫描队列应排除未分级与 C 级（level_in=S,A,B）
  if (levelIn) {
    const lv = String(levelIn).split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
    if (lv.length) { where += ` AND level IN (${lv.map(() => '?').join(',')})`; args.push(...lv) }
  }
  if (accept) { where += ' AND accept = ?'; args.push(accept) }
  return { where, args }
}

const ENDPOINT_SORT = { last_seen: 'last_seen', host: 'host', status: 'status', path: 'path' }
export function queryEndpoints({ host = '', pathLike = '', programId = '', limit = 50, offset = 0, sort = '', dir = '' }) {
  const { where, args } = endpointWhere({ host, pathLike, programId })
  const sql = `SELECT host, method, path, status, source, program_id, last_seen FROM endpoints WHERE ${where} ORDER BY ${orderClause(ENDPOINT_SORT, sort, dir, 'last_seen')} LIMIT ? OFFSET ?`
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

// severity 语义排序（critical>high>medium>low>info），非按字母
const FINDING_SORT = {
  created_at: 'created_at', id: 'id', status: 'status',
  severity: "(CASE severity WHEN 'critical' THEN 5 WHEN 'high' THEN 4 WHEN 'medium' THEN 3 WHEN 'low' THEN 2 ELSE 1 END)",
}
export function queryFindings({ host = '', severity = '', status = '', programId = '', q = '', limit = 50, offset = 0, sort = '', dir = '', includeNoise = false }) {
  const { where, args } = findingWhere({ host, severity, status, programId, q, includeNoise })
  // 列表不带 evidence（大字段，详情面板按需 findingGet 拉取）；带 vuln_type/bounty/vendor_status 供行内徽章
  const sql = `SELECT id, title, severity, host, url, source, status, program_id, session_id, vuln_type, bounty, vendor_status, noise, created_at, confidence, fgs_node_id, discovery_step FROM findings WHERE ${where} ORDER BY ${orderClause(FINDING_SORT, sort, dir, 'created_at')} LIMIT ? OFFSET ?`
  return plain(getDb().prepare(sql).all(...args, Math.min(limit, 200), Math.max(0, offset)))
}

export function countFindings(filters = {}) {
  const { where, args } = findingWhere(filters)
  return getDb().prepare(`SELECT COUNT(*) AS n FROM findings WHERE ${where}`).get(...args).n
}

function findingWhere({ host = '', severity = '', status = '', programId = '', q = '', includeNoise = false }) {
  let where = '1=1'
  const args = []
  // P15 噪声闸门：默认排除 noise 行（includeNoise=true 才看全量）
  if (!includeNoise) where += ' AND noise = 0'
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
  // P15 噪声闸门：KPI 只统计信号（noise=0），噪声单独计数
  const bySev = plain(d.prepare("SELECT severity, COUNT(*) AS n FROM findings WHERE noise = 0 GROUP BY severity").all())
  const byStatus = plain(d.prepare("SELECT status, COUNT(*) AS n FROM findings WHERE noise = 0 GROUP BY status").all())
  return {
    assets: count('assets'), endpoints: count('endpoints'),
    findings: d.prepare('SELECT COUNT(*) AS n FROM findings WHERE noise = 0').get().n,
    findings_noise: d.prepare('SELECT COUNT(*) AS n FROM findings WHERE noise = 1').get().n,
    blackboard_keys: count('blackboard'),
    facts: count('facts'),
    programs: count('programs'), tasks: count('tasks'),
    assets_by_type: byType, findings_by_severity: bySev, findings_by_status: byStatus,
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
  // P12 幂等去重：interval 周期任务是「固定任务」实体——同 program 下同 objective 的活跃周期任务只保留一行，
  // 重复创建（链/会话复读）直接返回已有任务，不再让任务表增殖。
  if (sched.kind === 'interval') {
    const dup = d.prepare(
      "SELECT id FROM tasks WHERE program_id = ? AND objective = ? AND schedule_kind = 'interval' AND status NOT IN ('done','failed','cancelled') LIMIT 1"
    ).get(program_id, objective)
    if (dup) return { ok: true, id: Number(dup.id), deduped: true, schedule: { kind: 'interval' } }
  }
  const r = d.prepare(`
    INSERT INTO tasks (program_id, parent_id, phase, objective, priority, assignee, budget_tokens,
      session_id, schedule_kind, run_at, every_seconds, next_run_at, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)
  `).run(program_id, parent_id, phase, objective, priority, assignee, budget_tokens,
    session_id, sched.kind, sched.run_at, sched.every_seconds, sched.next_run_at, now(), now())
  return { ok: true, id: Number(r.lastInsertRowid), schedule: sched.kind ? { kind: sched.kind, next_run_at: sched.next_run_at } : null }
}

// ---- P15 流程守卫：interval 日任务标 done 前硬校验纪律产物（台账增量/卡片使用/交接包）----
// 原则：纪律不能只靠提示词自觉——缺产物则任务不可 done，agent 拿到缺失清单后必须补齐再收尾。
// 作用域：schedule_kind='interval' 且 data/pipeline/{program}/ 存在的项目任务（dsh-ops 等无管线目录的任务不拦）。

function pipelineGuardStatus(programId) {
  const dir = path.join(DATA_DIR, 'pipeline', programId)
  if (!fs.existsSync(dir)) return null // 无管线目录 → 守卫不适用
  const today = beijingDate()
  const yesterday = beijingDate(Date.now() - 86400000)
  const missing = []
  // 1) 台账当日增量（ts 落今天/昨天 的数据行）
  let ledgerRows = 0
  const attemptsFile = path.join(dir, `attempts-${programId}.tsv`)
  try {
    const lines = fs.readFileSync(attemptsFile, 'utf8').split('\n').filter((l) => l.trim())
    ledgerRows = lines.slice(1).filter((l) => { const d = (l.split('\t')[0] || '').slice(0, 10); return d === today || d === yesterday }).length
  } catch { /* 无台账文件 */ }
  if (ledgerRows === 0) missing.push(`attempts 台账近 24h 零增量：用 attempts_log 逐目标落六态行（含 NOT_APPLICABLE/BLOCKED，理由必填）→ ${attemptsFile}`)
  // 2) 卡片使用记录（文件名日期 今天/昨天，或 mtime 24h 内）
  let cardUsage = false
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.startsWith('card_usage-')) continue
      const d = f.match(/card_usage-(\d{4}-\d{2}-\d{2})\.jsonl/)?.[1]
      const fresh = (d === today || d === yesterday) || (Date.now() - fs.statSync(path.join(dir, f)).mtimeMs < 86400000)
      if (fresh) { cardUsage = true; break }
    }
  } catch { /* ignore */ }
  if (!cardUsage) missing.push('card_usage 近 24h 零记录：用 card_usage_log 落本次用卡记录（含 deviation）')
  // 3) 交接包
  const hasHandoff = [today, yesterday].some((d) => fs.existsSync(path.join(dir, `handoff-${d}.md`)))
  if (!hasHandoff) missing.push(`handoff 交接包缺失：按五段固定结构写 ${dir}/handoff-${today}.md（状态快照/今日动作/明日队列/阻塞与求助/数据指针）`)
  return { ok: missing.length === 0, missing, ledger_rows_24h: ledgerRows }
}

export function taskUpdate({ id, status, note = '', blocked_reason = '', result = '' }) {
  if (!TASK_STATUS.includes(status)) return { ok: false, error: `非法状态 ${status}（可选: ${TASK_STATUS.join('/')}）` }
  const d = getDb()
  // 流程守卫：只在标 done 时拦截（blocked/failed/cancelled 不拦——失败与放弃必须能落库）
  if (status === 'done') {
    const t = d.prepare('SELECT program_id, schedule_kind FROM tasks WHERE id = ?').get(Number(id))
    if (t && t.schedule_kind === 'interval' && t.program_id) {
      const guard = pipelineGuardStatus(t.program_id)
      if (guard && !guard.ok) {
        return {
          ok: false,
          guard_blocked: true,
          missing: guard.missing,
          error: `流程守卫拦截（任务不可 done，纪律产物缺失）：\n- ${guard.missing.join('\n- ')}\n补齐后重新 task_update status=done。`,
        }
      }
    }
  }
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
      .run(`${cur.result || ''}\n[${new Date().toISOString().slice(0, 16)}] ${status}: ${note}`.trim().slice(-8000), Number(id))
  }
  return { ok: true, id: Number(id), status }
}

export function taskList({ programId = '', status = '', phase = '', q = '', bucket = '', scheduled = '', limit = 50, offset = 0 }) {
  const { where, args } = taskWhere({ programId, status, phase, q, bucket, scheduled })
  const sql = `SELECT * FROM tasks WHERE ${where} ORDER BY priority ASC, created_at ASC LIMIT ? OFFSET ?`
  return plain(getDb().prepare(sql).all(...args, Math.min(limit, 200), Math.max(0, offset)))
}

export function countTasks(filters = {}) {
  const { where, args } = taskWhere(filters)
  return getDb().prepare(`SELECT COUNT(*) AS n FROM tasks WHERE ${where}`).get(...args).n
}

function taskWhere({ programId = '', status = '', phase = '', q = '', bucket = '', scheduled = '' }) {
  let where = '1=1'
  const args = []
  if (programId) { where += ' AND program_id = ?'; args.push(programId) }
  if (status) { where += ' AND status = ?'; args.push(status) }
  if (phase) { where += ' AND phase = ?'; args.push(phase) }
  if (q) { where += ' AND objective LIKE ?'; args.push(`%${q}%`) }
  // active=正在执行(排队/运行/阻塞) / history=历史(完成/失败/取消)：定时任务自续排+重设会累积终态行，UI 据此分区
  if (bucket === 'active') { where += " AND status IN ('queued', 'running', 'blocked')" }
  else if (bucket === 'history') { where += " AND status IN ('done', 'failed', 'cancelled')" }
  // P12：定时任务由看板「定时任务」卡片区独立展示；active 列表默认排除定时行，避免与卡片重复
  if (scheduled === 'exclude') { where += ' AND schedule_kind IS NULL' }
  else if (scheduled === 'only') { where += ' AND schedule_kind IS NOT NULL' }
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

// 立即触发一次（不动调度节律）：把 next_run_at 拨到现在，调度循环下个 tick 认领。
// 对未设置 schedule_kind 的一次性任务，自动标为 'once'，否则调度循环永远不会认领它。
export function taskRunNow(id) {
  const d = getDb()
  const t = d.prepare('SELECT id, status, schedule_kind FROM tasks WHERE id = ?').get(Number(id))
  if (!t) return { ok: false, error: `task 不存在: ${id}` }
  if (t.status !== 'queued') return { ok: false, error: `task #${id} 当前 ${t.status}，仅 queued 可立即触发` }
  d.prepare('UPDATE tasks SET schedule_kind = COALESCE(schedule_kind, \'once\'), next_run_at = ?, updated_at = ? WHERE id = ?')
    .run(now(), now(), Number(id))
  return { ok: true, id: Number(id), hint: '已排入调度队列，下一 tick（≤60s）认领执行' }
}

// 调度循环认领（原子抢占，防重启/双实例重复派单）：到期 scheduled 任务 → running
export function taskClaimDue(nowTs) {
  const d = getDb()
  d.exec('BEGIN IMMEDIATE')
  try {
    const due = plain(d.prepare(
      `SELECT id FROM tasks t WHERE schedule_kind IS NOT NULL AND status = 'queued' AND next_run_at IS NOT NULL AND next_run_at <= ?
         AND (parent_id IS NULL OR EXISTS (SELECT 1 FROM tasks p WHERE p.id = t.parent_id AND p.status = 'done'))
       ORDER BY priority ASC, next_run_at ASC LIMIT 4`
    ).all(nowTs))
    const claimed = []
    // P15 修复（env-issue scheduler-reap-double-dispatch）：认领时间必须每次刷新。
    // 旧逻辑 COALESCE(started_at, now) 使 interval 任务跨日复用首次认领时间 → taskReapStale 按
    // started_at 判龄时把正在跑的任务误判为僵尸回收 → 双重派单 + 恢复行风暴。
    const upd = d.prepare("UPDATE tasks SET status = 'running', started_at = ?, updated_at = ? WHERE id = ? AND status = 'queued'")
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

// 调度执行收尾：记录 last_run_* + 落 task_runs 执行历史，interval 任务 latest-only 续期回 queued，once 任务进终态。
// P15：可选 session_id（调度器从 sessionPersistence 反查 worker 会话）→ task_runs.session_id + tasks.session_id 回填（看板跳链）。
// P17：增加结果真实性校验——worker.log 中出现模型拒执/API 错误等标记时，即使 worker 返回 exit 0 也标失败/待复核。
export function taskFinishScheduledRun({ id, ok, run_id, note = '', session_id = null }) {
  session_id = session_id ?? null
  const d = getDb()
  const t = d.prepare('SELECT * FROM tasks WHERE id = ?').get(Number(id))
  if (!t) return { ok: false, error: `task 不存在: ${id}` }

  // P17：真实性校验
  let truth = { checked: false, rejected: false, reason: '' }
  if (ok && run_id) {
    try {
      const logPath = path.join(DATA_DIR, 'results', String(run_id), 'worker.log')
      if (fs.existsSync(logPath)) {
        const tail = fs.readFileSync(logPath, 'utf8').slice(-4000)
        const rejectMarks = [
          "I won't produce", 'I will not produce', 'I cannot continue', 'refuse to continue',
          'unverifiable authorization', '授权不可验证', '拒绝执行', '停止执行',
          'INVALID_REQUEST', 'RATE_LIMIT', 'TIMEOUT', 'Provided value cannot be bound',
          'reasoning_content must be passed back'
        ]
        for (const mark of rejectMarks) {
          if (tail.includes(mark)) { truth.rejected = true; truth.reason = `worker.log 命中拒执/错误标记: ${mark}`; break }
        }
        truth.checked = true
      }
    } catch (e) {
      process.stderr.write(`[asset-db] taskFinishScheduledRun 真实性校验读日志失败(task=${id}): ${e?.message ?? e}\n`)
    }
  }
  if (truth.rejected) {
    ok = false
    note = `[真实性校验失败] ${truth.reason}${note ? ' | ' + note : ''}`.slice(0, 500)
    // P17：拒执/错误被真实记录进 FGS 图，便于复盘模型行为
    try {
      fgsAddNode({ task_id: Number(id), run_id: run_id || null, type: 'finding', status: 'failed',
        content: { summary: 'worker 拒执或 API 错误', reason: truth.reason, run_id }, score: 0 })
    } catch { /* 失败不阻断主流程 */ }
  }

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
  // P17：任务失败时记录失败节点（blocked），把错误/超时写入 FGS 图
  if (!ok && !truth.rejected) {
    try {
      fgsAddNode({ task_id: Number(id), run_id: run_id || null, type: 'step', status: 'failed',
        content: { summary: `任务失败: ${note || 'unknown'}`, run_id }, score: 0 })
    } catch { /* 失败不阻断主流程 */ }
  }
  const tailNote = `${t.result || ''}\n[${new Date().toISOString().slice(0, 16)}] run ${run_id}: ${ok ? 'done' : 'failed'}${note ? ' — ' + note : ''}`.trim()
  d.prepare(`UPDATE tasks SET status = ?, result = ?, last_run_at = ?, last_run_id = ?, next_run_at = ?,
    session_id = COALESCE(?, session_id),
    finished_at = CASE WHEN ? IN ('done','failed') THEN ? ELSE finished_at END, updated_at = ? WHERE id = ?`)
    .run(status, tailNote.slice(-8000), finished, run_id || null, nextRunAt, session_id, status, finished, now(), Number(id))
  try {
    taskRunRecord({ task_id: Number(id), run_id, ok, note, started_at: t.started_at || null, finished_at: finished, session_id })
  } catch (e) {
    // 执行历史落库失败不丢任务状态，但必须可见（此前静默丢行导致 task_runs 断链无人发觉）
    process.stderr.write(`[asset-db] task_runs 记录失败(task=${id}): ${e?.message ?? e}\n`)
  }
  // P17：收尾自动把 FGS 摘要追加到 handoff（不依赖模型自觉调用）
  try {
    const fgsHandoff = appendFgsToHandoff(Number(id), t.program_id)
    if (!fgsHandoff.ok) process.stderr.write(`[asset-db] FGS handoff 追加失败(task=${id}): ${fgsHandoff.error}\n`)
  } catch (e) {
    process.stderr.write(`[asset-db] FGS handoff 追加异常(task=${id}): ${e?.message ?? e}\n`)
  }
  return { ok: true, id: Number(id), status, next_run_at: nextRunAt }
}

// -------------------- FGS 图操作（P17 Cairn_Y 融合）--------------------
export function fgsAddNode({ task_id, run_id = null, type, status = 'open', content = {}, score = 0, parent_id = null, depends_on = null }) {
  const d = getDb()
  const ts = now()
  const contentJson = typeof content === 'string' ? content : JSON.stringify(content)
  const dependsJson = Array.isArray(depends_on) ? JSON.stringify(depends_on) : (depends_on || null)
  const r = d.prepare(`INSERT INTO fgs_nodes (task_id, run_id, type, status, content, score, parent_id, depends_on, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(Number(task_id), run_id || null, type, status, contentJson, score, parent_id || null, dependsJson, ts, ts)
  return { ok: true, id: Number(r.lastInsertRowid) }
}

export function fgsUpdateNode({ id, status = null, content = null, score = null }) {
  const d = getDb()
  const updates = []
  const args = []
  if (status !== null) { updates.push('status = ?'); args.push(status) }
  if (content !== null) {
    // P17：content 增量合并，不覆盖原有字段
    let merged = {}
    try {
      const cur = d.prepare('SELECT content FROM fgs_nodes WHERE id = ?').get(Number(id))
      merged = JSON.parse(cur?.content || '{}')
    } catch { merged = {} }
    let incoming = {}
    try {
      incoming = typeof content === 'string' ? JSON.parse(content) : content
      if (!incoming || typeof incoming !== 'object') incoming = {}
    } catch {
      return { ok: false, error: 'content 不是合法 JSON 对象' }
    }
    merged = { ...merged, ...incoming }
    updates.push('content = ?'); args.push(JSON.stringify(merged))
  }
  if (score !== null) { updates.push('score = ?'); args.push(score) }
  if (updates.length === 0) return { ok: false, error: '无更新字段' }
  updates.push('updated_at = ?'); args.push(now())
  args.push(Number(id))
  d.prepare(`UPDATE fgs_nodes SET ${updates.join(', ')} WHERE id = ?`).run(...args)
  return { ok: true, id: Number(id) }
}

export function fgsListNodes({ task_id, type = '', status = '', run_id = '', limit = 200, offset = 0 }) {
  let where = 'task_id = ?'
  const args = [Number(task_id)]
  if (type) { where += " AND type = ?"; args.push(type) }
  if (status) { where += " AND status = ?"; args.push(status) }
  if (run_id) { where += " AND run_id = ?"; args.push(run_id) }
  const rows = plain(getDb().prepare(
    `SELECT id, task_id, run_id, type, status, content, score, parent_id, depends_on, created_at, updated_at
     FROM fgs_nodes WHERE ${where} ORDER BY score DESC, updated_at DESC LIMIT ? OFFSET ?`
  ).all(...args, Math.min(limit, 500), Math.max(0, offset)))
  for (const r of rows) {
    try { r.content = JSON.parse(r.content) } catch { r.content = {} }
    try { r.depends_on = r.depends_on ? JSON.parse(r.depends_on) : null } catch { r.depends_on = null }
  }
  return rows
}

export function fgsNextStep(task_id) {
  const d = getDb()
  // 取状态为 open 且依赖已满足的 step；若依赖为空直接可执行
  const rows = plain(d.prepare(
    `SELECT id, content, score, depends_on FROM fgs_nodes
     WHERE task_id = ? AND type = 'step' AND status = 'open'
     ORDER BY score DESC, updated_at DESC LIMIT 50`
  ).all(Number(task_id)))
  const doneIds = new Set(
    plain(d.prepare("SELECT id FROM fgs_nodes WHERE task_id = ? AND type = 'step' AND status = 'done'")
      .all(Number(task_id))).map((r) => r.id)
  )
  const ready = []
  for (const r of rows) {
    let deps = []
    try { deps = r.depends_on ? JSON.parse(r.depends_on) : [] } catch { deps = [] }
    if (!Array.isArray(deps) || deps.length === 0 || deps.every((id) => doneIds.has(id))) {
      try { r.content = JSON.parse(r.content) } catch { r.content = {} }
      ready.push(r)
    }
  }
  return ready.slice(0, 10)
}

export function fgsClearTask(task_id) {
  getDb().prepare('DELETE FROM fgs_nodes WHERE task_id = ?').run(Number(task_id))
  return { ok: true }
}

// P17：任务收尾时把 FGS 图摘要自动追加到 handoff-{date}.md（北京日期）
export function appendFgsToHandoff(task_id, program_id) {
  if (!task_id || !program_id) return { ok: false, error: 'task_id 与 program_id 必填' }
  const dir = path.join(DATA_DIR, 'pipeline', String(program_id))
  const handoffPath = path.join(dir, `handoff-${beijingDate()}.md`)
  const nodes = fgsListNodes({ task_id: Number(task_id), type: '', status: '', run_id: '', limit: 500 })
  if (!nodes.length) return { ok: true, appended: false, reason: 'FGS 图为空' }
  const byType = { fact: [], goal: [], step: [], finding: [] }
  for (const n of nodes) (byType[n.type] || []).push(n)
  const lines = [
    '', '---', '',
    '## FGS 决策链摘要（自动导出）',
    '',
    `- 任务: #${task_id}`,
    `- 节点总数: ${nodes.length}（fact ${byType.fact.length} / goal ${byType.goal.length} / step ${byType.step.length} / finding ${byType.finding.length}）`,
    '',
    '### 目标 (Goal)',
    ...byType.goal.map((n) => `- [${n.status}] ${n.content?.summary || n.content?.detail || '-'}`),
    '',
    '### 关键事实 (Fact)',
    ...byType.fact.map((n) => `- [${n.status}] ${n.content?.summary || n.content?.detail || '-'}`),
    '',
    '### 执行步骤 (Step)',
    ...byType.step.map((n) => `- [${n.status}] ${n.content?.summary || n.content?.detail || '-'}`),
    '',
    '### 发现 (Finding)',
    ...byType.finding.map((n) => `- [${n.status}] ${n.content?.summary || '-'} @${n.content?.host || ''}${n.score ? ` (score:${n.score})` : ''}`),
    '',
  ]
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.appendFileSync(handoffPath, lines.join('\n') + '\n')
    return { ok: true, appended: true, handoff: handoffPath, nodes: nodes.length }
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e) }
  }
}

// 执行历史落库（每任务保留最近 200 行，防无限膨胀）
function taskRunRecord({ task_id, run_id = '', ok, note = '', started_at = null, finished_at = null, session_id = null }) {
  session_id = session_id ?? null
  const d = getDb()
  const duration = (started_at && finished_at) ? finished_at - started_at : null
  d.prepare('INSERT INTO task_runs (task_id, run_id, ok, note, started_at, finished_at, duration_ms, session_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(task_id, String(run_id || ''), ok ? 1 : 0, String(note || '').slice(0, 500), started_at, finished_at, duration, session_id)
  d.prepare('DELETE FROM task_runs WHERE task_id = ? AND id NOT IN (SELECT id FROM task_runs WHERE task_id = ? ORDER BY id DESC LIMIT 200)')
    .run(task_id, task_id)
}

// P17：按 session_id 反查当前正在执行的调度任务（工具调用归属）
export function activeTaskBySession(session_id, maxAgeMs = 6 * 3600 * 1000) {
  if (!session_id) return null
  const d = getDb()
  const cutoff = now() - maxAgeMs
  return d.prepare(`
    SELECT t.id AS task_id, t.program_id, t.phase, t.objective, r.run_id, r.started_at
    FROM task_runs r JOIN tasks t ON t.id = r.task_id
    WHERE r.session_id = ? AND t.status = 'running' AND r.started_at >= ?
    ORDER BY r.id DESC LIMIT 1
  `).get(session_id, cutoff) || null
}

// 执行历史查询（join tasks 带出 objective/program，看板「执行历史」区）
export function taskRunsList({ taskId = 0, programId = '', limit = 50, offset = 0 }) {
  let where = '1=1'
  const args = []
  if (taskId) { where += ' AND r.task_id = ?'; args.push(Number(taskId)) }
  if (programId) { where += ' AND t.program_id = ?'; args.push(programId) }
  return plain(getDb().prepare(
    `SELECT r.id, r.task_id, r.run_id, r.ok, r.note, r.started_at, r.finished_at, r.duration_ms, r.session_id,
            t.objective, t.program_id, t.phase
     FROM task_runs r JOIN tasks t ON t.id = r.task_id
     WHERE ${where} ORDER BY r.id DESC LIMIT ? OFFSET ?`
  ).all(...args, Math.min(limit, 200), Math.max(0, offset)))
}

export function countTaskRuns({ taskId = 0, programId = '' } = {}) {
  let where = '1=1'
  const args = []
  if (taskId) { where += ' AND r.task_id = ?'; args.push(Number(taskId)) }
  if (programId) { where += ' AND t.program_id = ?'; args.push(programId) }
  return getDb().prepare(`SELECT COUNT(*) AS n FROM task_runs r JOIN tasks t ON t.id = r.task_id WHERE ${where}`).get(...args).n
}

// 固定定时任务清单（看板「定时任务」卡片区）：未终态 + 带调度，聚合运行统计与最近一次结局
export function taskScheduledList() {
  return plain(getDb().prepare(
    `SELECT t.*,
       (SELECT COUNT(*) FROM task_runs r WHERE r.task_id = t.id) AS run_count,
       (SELECT COUNT(*) FROM task_runs r WHERE r.task_id = t.id AND r.ok = 0) AS fail_count,
       (SELECT r.ok FROM task_runs r WHERE r.task_id = t.id ORDER BY r.id DESC LIMIT 1) AS last_ok,
       (SELECT r.note FROM task_runs r WHERE r.task_id = t.id ORDER BY r.id DESC LIMIT 1) AS last_note
     FROM tasks t
     WHERE t.schedule_kind IS NOT NULL AND t.status NOT IN ('done', 'failed', 'cancelled')
     ORDER BY t.next_run_at ASC`
  ).all())
}

// 僵尸回收（P0-3）：宿主进程崩溃/超时导致 running 卡死的 scheduled 任务 → 回收。
// once 任务标 failed（终态），interval 任务退回 queued（下次续期）。默认超龄 1 小时（对齐 worker timeout 上限）。
export function taskReapStale(maxAgeMs = 3600000, pidAliveFn = null) {
  const alive = pidAliveFn || pidAlive
  const d = getDb()
  const cutoff = now() - maxAgeMs
  const stale = plain(d.prepare(
    "SELECT id, schedule_kind, started_at, last_run_id FROM tasks WHERE status = 'running' AND schedule_kind IS NOT NULL AND started_at IS NOT NULL AND started_at < ?"
  ).all(cutoff))
  let reaped = 0
  let skipped = 0
  for (const t of stale) {
    // P15 修复：last_run 对应的 worker 进程还活着 → 任务在真实执行，不是僵尸，跳过回收。
    // （旧逻辑只看 started_at 年龄，与 3600s 超时上限同量级，会把跑满预算的正常任务误杀+双重派单。）
    if (t.last_run_id) {
      const w = d.prepare('SELECT pid, status FROM workers WHERE run_id = ?').get(t.last_run_id)
      if (w && w.status === 'running' && alive(w.pid)) { skipped++; continue }
    }
    const status = t.schedule_kind === 'interval' ? 'queued' : 'failed'
    const r = d.prepare("UPDATE tasks SET status = ?, blocked_reason = '宿主重启/超时回收', updated_at = ? WHERE id = ? AND status = 'running'")
      .run(status, now(), t.id)
    if (r.changes === 1) {
      reaped++
      try { taskRunRecord({ task_id: t.id, run_id: '', ok: false, note: '宿主重启/超时回收', started_at: t.started_at, finished_at: now() }) }
      catch (e) { process.stderr.write(`[asset-db] task_runs 记录失败(task=${t.id}): ${e?.message ?? e}\n`) }
    }
  }
  return { reaped, skipped_alive: skipped }
}

// -------------------- worker 注册表（重启幂等恢复）--------------------
// spawn_worker 阻塞父会话最长 1h，重启落窗口会让在飞 worker 变 "outcome unknown"。
// 注册表让"重启→重试"确定性恢复真实结果（done/failed 回读）或干净重跑（killed）。
const pidAlive = (pid) => { if (!pid) return false; try { process.kill(pid, 0); return true } catch { return false } }

export function workerRegister({ run_id, dedupe_key = null, task = '', cwd = null, pid = null, timeout_sec = null, session_id = null, run_dir = null }) {
  if (!run_id) return { ok: false, error: 'run_id 必填' }
  getDb().prepare(`
    INSERT INTO workers (run_id, dedupe_key, task, cwd, pid, status, exit_code, started_at, finished_at, timeout_sec, session_id, run_dir)
    VALUES (?, ?, ?, ?, ?, 'running', NULL, ?, NULL, ?, ?, ?)
    ON CONFLICT (run_id) DO UPDATE SET pid = excluded.pid, status = 'running'
  `).run(run_id, dedupe_key, String(task).slice(0, 2000), cwd, pid, now(), timeout_sec, session_id, run_dir)
  return { ok: true, run_id }
}

export function workerFinish(run_id, { status = 'done', exit_code = null } = {}) {
  if (!run_id) return { ok: false }
  const r = getDb().prepare('UPDATE workers SET status = ?, exit_code = ?, finished_at = ? WHERE run_id = ?')
    .run(status, exit_code, now(), run_id)
  return { ok: r.changes === 1 }
}

// 去重/恢复查询：窗口内该 dedupe_key 最近一条（started_at 倒序）
export function workerFindRecentByKey(dedupe_key, sinceMs) {
  if (!dedupe_key) return null
  const cutoff = now() - (Number(sinceMs) || 0)
  const row = getDb().prepare(
    'SELECT * FROM workers WHERE dedupe_key = ? AND started_at >= ? ORDER BY started_at DESC LIMIT 1'
  ).get(dedupe_key, cutoff)
  return row ? { ...row } : null
}

export function workerGet(run_id) {
  const row = getDb().prepare('SELECT * FROM workers WHERE run_id = ?').get(run_id)
  return row ? { ...row } : null
}

export function workerList({ status = null, limit = 20 } = {}) {
  const lim = Math.min(Math.max(Number(limit) || 20, 1), 200)
  const rows = status
    ? getDb().prepare('SELECT * FROM workers WHERE status = ? ORDER BY started_at DESC LIMIT ?').all(String(status), lim)
    : getDb().prepare('SELECT * FROM workers ORDER BY started_at DESC LIMIT ?').all(lim)
  return plain(rows)
}

// 启动对账：每条 running 行——先读 run_dir/meta.json（有 exit_code=宿主被杀前已完成，close 没跑到）→ done/failed；
// 否则 pid 已死 → killed；否则保留 running（真活着，罕见）。先读 meta 再判 pid 是关键（防把已完成误判 killed）。
export function workerReapStale() {
  const d = getDb()
  const running = plain(d.prepare("SELECT run_id, pid, run_dir, started_at, timeout_sec FROM workers WHERE status = 'running'").all())
  let reaped = 0
  for (const w of running) {
    let status = null; let exitCode = null
    try {
      if (w.run_dir) {
        const meta = JSON.parse(fs.readFileSync(path.join(w.run_dir, 'meta.json'), 'utf8'))
        if (meta && meta.exit_code !== undefined && meta.exit_code !== null) {
          exitCode = meta.exit_code
          status = meta.exit_code === 0 ? 'done' : 'failed'
        }
      }
    } catch { /* 无 meta.json → 落到 pid 判定 */ }
    if (!status) {
      if (pidAlive(w.pid)) {
        // P12-1 孤儿超时执法：父 worker 被杀后其 killer 定时器随之消失，detached 孙 worker 会无限跑。
        // 超过 started_at + timeout_sec + 60s 宽限仍未退出 → 由本对账代行 SIGTERM→SIGKILL（进程组）
        const limit = (w.started_at || 0) + ((w.timeout_sec || 900) + 60) * 1000
        if (w.started_at && now() > limit) {
          try { process.kill(-w.pid, 'SIGTERM') } catch { /* 进程组已退 */ }
          setTimeout(() => { try { process.kill(-w.pid, 'SIGKILL') } catch { /* ignore */ } }, 5000).unref?.()
          status = 'killed'
        } else {
          continue // 真活着且未超时，保留 running
        }
      } else {
        status = 'killed'
      }
    }
    const r = d.prepare("UPDATE workers SET status = ?, exit_code = ?, finished_at = ? WHERE run_id = ? AND status = 'running'")
      .run(status, exitCode, now(), w.run_id)
    if (r.changes === 1) reaped++
  }
  return { reaped }
}

// -------------------- P8：事实图谱（facts + fact_edges）--------------------

const FACT_CONFIDENCE = ['confirmed', 'tentative', 'deprecated']

// -------------------- memcore 治理服务绑定（可选，缺席透传 fail-open） --------------------
let _lifecycle = null
export function _bindLifecycle(lc) { _lifecycle = lc }
const LC = () => _lifecycle

export function factUpsert({ program_id, fact_key, category = '', summary = '', body = '', confidence = 'tentative', pinned = 0, related_finding_id = null, source = '', intent = null }) {
  if (!program_id || !fact_key) return { ok: false, error: 'program_id 与 fact_key 必填（fact_key 格式 category/slug）' }
  if (!FACT_CONFIDENCE.includes(confidence)) return { ok: false, error: `非法 confidence ${confidence}（可选: ${FACT_CONFIDENCE.join('/')}）` }
  const lc = LC()
  const nowTs = now()
  if (lc) {
    // 缺省分类：note 类负知识 → ephemeral 14d；其余 → durable 30d 复验（见实施文档 §3.3）
    const vw = lc.validateWrite('facts', {
      mem_class: intent?.mem_class || (category === 'note' ? 'ephemeral' : 'durable'),
      ttl_days: intent?.ttl_days, revalidate_days: intent?.revalidate_days,
      justification: intent?.justification, scope: intent?.scope || `program:${program_id}`,
    })
    if (!vw.ok) return { ok: false, error: vw.error }
    const v = vw.value
    getDb().prepare(`
      INSERT INTO facts (program_id, fact_key, category, summary, body, confidence, pinned, related_finding_id, source, updated_at,
        mem_class, status, status_at, scope, expires_at, revalidate_by, justification, last_validated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)
      ON CONFLICT (program_id, fact_key) DO UPDATE SET
        category = excluded.category, summary = excluded.summary, body = excluded.body,
        confidence = excluded.confidence, pinned = excluded.pinned,
        related_finding_id = excluded.related_finding_id, source = excluded.source, updated_at = excluded.updated_at,
        mem_class = excluded.mem_class, status = 'active', status_at = excluded.status_at, scope = excluded.scope,
        expires_at = excluded.expires_at, revalidate_by = excluded.revalidate_by,
        justification = excluded.justification, last_validated_at = excluded.last_validated_at
    `).run(program_id, fact_key, category, summary, body, confidence, pinned ? 1 : 0, related_finding_id, source, nowTs,
      v.mem_class, nowTs, v.scope, v.expires_at ?? null, v.revalidate_by ?? null, v.justification, v.last_validated_at ?? null)
    return { ok: true, program_id, fact_key, mem_class: v.mem_class }
  }
  getDb().prepare(`
    INSERT INTO facts (program_id, fact_key, category, summary, body, confidence, pinned, related_finding_id, source, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (program_id, fact_key) DO UPDATE SET
      category = excluded.category, summary = excluded.summary, body = excluded.body,
      confidence = excluded.confidence, pinned = excluded.pinned,
      related_finding_id = excluded.related_finding_id, source = excluded.source, updated_at = excluded.updated_at
  `).run(program_id, fact_key, category, summary, body, confidence, pinned ? 1 : 0, related_finding_id, source, nowTs)
  return { ok: true, program_id, fact_key }
}

export function factGet(program_id, fact_key) {
  const row = getDb().prepare('SELECT * FROM facts WHERE program_id = ? AND fact_key = ?').get(program_id, fact_key)
  return row ? { ...row } : null
}

export function factSearch({ program_id = '', category = '', q = '', confidence = '', limit = 50, offset = 0, role = 'task' }) {
  const { where, args } = factWhere({ program_id, category, q, confidence })
  const lc = LC()
  // memcore 缺席时无治理列，回退旧列清单（fail-open）
  const memCols = lc ? ', mem_class, status, revalidate_by' : ''
  // edge_count：关联事实条数（走 idx_edges_src/dst，供看板「关联」按钮仅在有边时出现）
  const sql = `SELECT program_id, fact_key, category, summary, confidence, pinned, related_finding_id, updated_at${memCols},
    (SELECT COUNT(*) FROM fact_edges e WHERE e.program_id = facts.program_id AND (e.src_key = facts.fact_key OR e.dst_key = facts.fact_key)) AS edge_count
    FROM facts WHERE ${where} ORDER BY pinned DESC, updated_at DESC LIMIT ? OFFSET ?`
  const rows = plain(getDb().prepare(sql).all(...args, Math.min(limit, 200), Math.max(0, offset)))
  return lc ? lc.visibilityFilter(role, 'facts', rows) : rows
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

export function bbSet(key, value, intent = null) {
  const lc = LC()
  const nowTs = now()
  if (lc) {
    const existing = getDb().prepare('SELECT mem_class FROM blackboard WHERE key = ?').get(String(key))
    if (existing && existing.mem_class === 'timeline') {
      return { ok: false, error: 'R7: timeline 键只追加不可改写，请换用带新日期的新 key' }
    }
    const vw = lc.validateWrite('blackboard', {
      mem_class: intent?.mem_class, ttl_days: intent?.ttl_days,
      justification: intent?.justification, scope: intent?.scope,
    })
    if (!vw.ok) return { ok: false, error: vw.error }
    const v = vw.value
    getDb().prepare(`INSERT INTO blackboard (key, value, updated_at, mem_class, status, status_at, scope, expires_at, justification)
      VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?)
      ON CONFLICT (key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at,
        mem_class=excluded.mem_class, status='active', status_at=excluded.status_at,
        scope=excluded.scope, expires_at=excluded.expires_at, justification=excluded.justification`)
      .run(String(key), String(value), nowTs, v.mem_class, nowTs, v.scope, v.expires_at ?? null, v.justification)
    // [env-issue] 键关系全员安全：即时刷新 AGENTS.md 受管区块（不等 6h sweep 周期）
    if (String(key).startsWith('[env-issue]') && typeof lc.refreshAgentsMd === 'function') {
      try { lc.refreshAgentsMd() } catch { /* 刷新失败不阻断写入 */ }
    }
    return { ok: true, mem_class: v.mem_class, expires_at: v.expires_at ?? null }
  }
  getDb().prepare('INSERT INTO blackboard (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
    .run(String(key), String(value), nowTs)
  return { ok: true }
}

export function bbGet(key, role = 'task') {
  const d = getDb()
  const lc = LC()
  if (key) {
    const row = d.prepare('SELECT * FROM blackboard WHERE key = ?').get(String(key))
    if (!row) return null
    if (lc) {
      const kept = lc.visibilityFilter(role, 'blackboard', [{ ...row }])
      return kept.length ? kept[0] : null
    }
    return { key: row.key, value: row.value, updated_at: row.updated_at }
  }
  const rows = plain(d.prepare('SELECT * FROM blackboard ORDER BY updated_at DESC LIMIT 100').all())
  return lc ? lc.visibilityFilter(role, 'blackboard', rows) : rows
}

// -------------------- P5：finding 状态流转 + 报告 --------------------

const FINDING_STATUS = ['new', 'confirmed', 'false_positive', 'submitted', 'accepted', 'dup', 'ignored']

export function findingGet(id) {
  const row = getDb().prepare('SELECT * FROM findings WHERE id = ?').get(Number(id))
  return row ? { ...row } : null
}

export function updateFinding({ id, status, note = '', bounty = null, vendor_status = '' }) {
  if (!FINDING_STATUS.includes(status)) return { ok: false, error: `非法状态 ${status}（可选: ${FINDING_STATUS.join('/')}` }
  const d = getDb()
  const f0 = d.prepare('SELECT fgs_node_id FROM findings WHERE id = ?').get(Number(id))
  // 主更新：status + 可选 bounty/vendor_status/submitted_at（仅在显式提供时写，向后兼容）
  const sets = ['status = ?']
  const args = [status]
  if (bounty !== null && bounty !== undefined && bounty !== '') { sets.push('bounty = ?'); args.push(Number(bounty)) }
  if (vendor_status) { sets.push('vendor_status = ?'); args.push(String(vendor_status)) }
  if (status === 'submitted') { sets.push('submitted_at = COALESCE(submitted_at, ?)'); args.push(now()) }
  // P17：状态流转同步 FGS 节点与 confidence
  const statusToConfidence = { confirmed: 'confirmed', false_positive: 'false_positive', dup: 'dup' }
  const statusToFgs = { confirmed: 'done', submitted: 'done', false_positive: 'deprecated', dup: 'deprecated', ignored: 'deprecated' }
  if (statusToConfidence[status]) { sets.push('confidence = ?'); args.push(statusToConfidence[status]) }
  args.push(Number(id))
  const r = d.prepare(`UPDATE findings SET ${sets.join(', ')} WHERE id = ?`).run(...args)
  if (r.changes === 0) return { ok: false, error: `finding 不存在: ${id}` }
  // 同步 FGS 节点状态
  if (f0?.fgs_node_id && statusToFgs[status]) {
    try { fgsUpdateNode({ id: f0.fgs_node_id, status: statusToFgs[status], content: { note: note || `finding_update status=${status}` } }) } catch { /* 失败不阻断主流程 */ }
  }
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
  // P15 噪声闸门：报告只列信号（noise=0）；噪声只给一行计数
  sql += ' AND noise = 0'
  if (hostLike) { sql += ' AND host LIKE ?'; args.push(`%${hostLike}%`) }
  if (status) { sql += ' AND status = ?'; args.push(status) }
  if (programId) { sql += ' AND program_id = ?'; args.push(programId) }
  if (sinceDays > 0) { sql += ' AND created_at >= ?'; args.push(Date.now() - sinceDays * 86400000) }
  sql += ' ORDER BY created_at DESC'
  const rows = plain(d.prepare(sql).all(...args))
  const noiseCount = d.prepare('SELECT COUNT(*) AS n FROM findings WHERE noise = 1').get().n

  const bySev = {}
  for (const r of rows) bySev[r.severity || 'info'] = (bySev[r.severity || 'info'] || 0) + 1

  const md = [
    `# SilkSecAgent 漏洞报告`,
    ``,
    `- 生成时间: ${new Date().toISOString()}`,
    `- 范围: ${hostLike || '全部'}${sinceDays ? `（近 ${sinceDays} 天）` : ''}`,
    `- 合计: ${rows.length} 个发现（${Object.entries(bySev).map(([k, v]) => `${k}:${v}`).join(' / ') || '无'}）`,
    `- 噪声: ${noiseCount} 条 info 级模板指纹已闸门过滤（不计入合计，可用 finding_query include_noise 查看）`,
    ``,
    `| # | 级别 | 状态 | 类型 | 标题 | 目标 | 证据 |`,
    `|---|---|---|---|---|---|---|`,
    ...rows.map((r) => `| ${r.id} | ${r.severity} | ${r.status} | ${r.vuln_type || '—'} | ${r.title.replace(/\|/g, '\\|')} | ${r.url || r.host} | ${String(r.evidence).split('\n')[0].slice(0, 80).replace(/\|/g, '\\|')} |`),
    ``,
  ].join('\n')

  const dir = path.join(DATA_DIR, 'reports')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `report-${Date.now()}.md`)
  fs.writeFileSync(file, md)
  return { file, total: rows.length, by_severity: bySev, noise_filtered: noiseCount }
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

// -------------------- P15：纪律健康度（看板 ops 视图 + 每日自检数据源） --------------------
// 五指标：台账日增量 / 卡片使用周增量 / IdeaCard 月增量 / 交接包生成率 / 调度漂移+task_runs 新鲜度。
// 数据即现实校验：任何指标红灯 = 文档纪律与实际执行脱节。
export function opsHealth() {
  const d = getDb()
  const today = beijingDate()
  const yesterday = beijingDate(Date.now() - 86400000)
  const days = []
  for (let i = 0; i < 7; i++) days.push(beijingDate(Date.now() - i * 86400000))
  const programs = fs.readdirSync(path.join(DATA_DIR, 'pipeline'), { withFileTypes: true })
    .filter((e) => e.isDirectory()).map((e) => e.name)

  const ledger = {}
  for (const p of programs) {
    const f = path.join(DATA_DIR, 'pipeline', p, `attempts-${p}.tsv`)
    try {
      const lines = fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.trim())
      ledger[p] = { total: lines.length - 1, today: lines.slice(1).filter((l) => (l.split('\t')[0] || '').slice(0, 10) === today).length }
    } catch { ledger[p] = { total: 0, today: 0 } }
  }
  let cardUsage7d = 0
  for (const p of programs) {
    try {
      for (const f of fs.readdirSync(path.join(DATA_DIR, 'pipeline', p))) {
        const m = f.match(/^card_usage-(\d{4}-\d{2}-\d{2})\.jsonl$/)
        if (m && days.includes(m[1])) cardUsage7d += fs.readFileSync(path.join(DATA_DIR, 'pipeline', p, f), 'utf8').split('\n').filter((l) => l.trim()).length
      }
    } catch { /* ignore */ }
  }
  let handoff7d = 0
  for (const p of programs) {
    for (const day of days) {
      try { if (fs.existsSync(path.join(DATA_DIR, 'pipeline', p, `handoff-${day}.md`))) handoff7d++ } catch { /* ignore */ }
    }
  }
  let ideaCards = 0
  try {
    ideaCards = fs.readdirSync(path.join(DATA_DIR, 'vulncards', 'ideas'))
      .filter((f) => f.endsWith('.yaml') && !f.startsWith('IC-000')).length
  } catch { /* ignore */ }
  // 调度漂移：next_run_at 相对 last_run_at+every_seconds 的偏移比（>1.5 视为漂移）
  const drift = plain(d.prepare(
    `SELECT id, program_id, phase, last_run_at, next_run_at, every_seconds,
            CAST(next_run_at AS REAL) / NULLIF(CAST(last_run_at + every_seconds * 1000 AS REAL), 0) AS drift_ratio
     FROM tasks WHERE schedule_kind = 'interval' AND status NOT IN ('done','failed','cancelled')`
  ).all()).map((r) => ({ ...r, drifting: !!r.drift_ratio && r.drift_ratio > 1.5 }))
  const lastRun = d.prepare('SELECT MAX(finished_at) AS ts FROM task_runs').get().ts
  const taskRunsStaleH = lastRun ? Math.round((Date.now() - lastRun) / 360000) / 10 : null
  const alerts = []
  for (const [p, v] of Object.entries(ledger)) if (v.total === 0) alerts.push(`台账空转: ${p} attempts 0 行`)
  if (cardUsage7d === 0) alerts.push('卡片使用记录 7 天 0 条（card_usage_log 未被使用）')
  if (handoff7d === 0) alerts.push('交接包 7 天 0 份（handoff-{date}.md 未生成）')
  for (const t of drift) if (t.drifting) alerts.push(`调度漂移: task #${t.id} next_run 偏移 ${t.drift_ratio?.toFixed(2)}x`)
  if (taskRunsStaleH != null && taskRunsStaleH > 26) alerts.push(`task_runs 断链: 最近执行记录已是 ${taskRunsStaleH}h 前`)
  return {
    generated_at: new Date().toISOString(),
    ledger_today: ledger,
    card_usage_7d: cardUsage7d,
    handoff_7d: handoff7d,
    idea_cards: ideaCards,
    scheduled_drift: drift,
    task_runs_last_age_hours: taskRunsStaleH,
    findings_noise: d.prepare('SELECT COUNT(*) AS n FROM findings WHERE noise = 1').get().n,
    assets_ungraded: d.prepare('SELECT COUNT(*) AS n FROM assets WHERE level IS NULL').get().n,
    alerts,
    healthy: alerts.length === 0,
  }
}

// -------------------- P16：SRC 提交半自动化（草稿生成 + 查重检索） --------------------
// finding CONFIRMED → 平台提交草稿（复现步骤/影响/放大面/脱敏证据指针）+ 同目标同类型查重。
// 人只做最终审校与粘贴——挖到到提交之间不再断链。
export function submissionDraft(findingId, { platform = '' } = {}) {
  const d = getDb()
  const f = d.prepare('SELECT * FROM findings WHERE id = ?').get(Number(findingId))
  if (!f) return { ok: false, error: `finding 不存在: ${findingId}` }
  // 查重：同 host 或同 vuln_type 的历史提交/已确认项（提交前必看，防平台判重）
  const dups = plain(d.prepare(
    `SELECT id, title, severity, status, host FROM findings
     WHERE id != ? AND noise = 0 AND (host = ? OR (vuln_type IS NOT NULL AND vuln_type = ?))
     ORDER BY created_at DESC LIMIT 10`
  ).all(Number(findingId), f.host || '', f.vuln_type || ''))
  const sevName = { critical: '严重', high: '高危', medium: '中危', low: '低危', info: '信息' }[f.severity] || f.severity
  const md = [
    `# 漏洞提交草稿（finding #${f.id}，人工审校后提交）`,
    '',
    `- 平台: ${platform || '（按目标 SRC 平台填写）'}`,
    `- 漏洞类型: ${f.vuln_type || '（回填 vuln_type）'}${f.cwe ? ` / ${f.cwe}` : ''}`,
    `- 等级自评: ${sevName}`,
    `- 目标: ${f.url || f.host}`,
    '',
    '## 漏洞描述',
    f.title,
    f.impact ? `\n**影响**: ${f.impact}` : '',
    '',
    '## 复现步骤',
    f.reproduction_steps || '（补全：1. … 2. … 3. …，每步附请求/响应关键片段）',
    f.preconditions ? `\n**前置条件**: ${f.preconditions}` : '',
    '',
    '## 证据',
    '```',
    String(f.evidence || '').slice(0, 2000),
    '```',
    f.endpoint_ref ? `\n关联接口: ${f.endpoint_ref}` : '',
    '',
    '## 修复建议',
    f.recommendation || '（补全修复建议）',
    '',
    '## 提交前查重结果',
    dups.length ? dups.map((x) => `- #${x.id} [${x.severity}] ${x.title}（${x.host}，status=${x.status}）`).join('\n') : '- 无同目标/同类型历史记录',
    '',
    '---',
    `数据指针：finding #${f.id} · session ${f.session_id || '—'} · source ${f.source || '—'} · ${new Date().toISOString()}`,
  ].join('\n')
  const dir = path.join(DATA_DIR, 'reports', 'submissions')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `draft-finding-${f.id}-${beijingDate()}.md`)
  fs.writeFileSync(file, md)
  return { ok: true, file, finding_id: f.id, dup_candidates: dups, hint: '人工审校后提交；提交成功用 finding_update status=submitted 回流' }
}
