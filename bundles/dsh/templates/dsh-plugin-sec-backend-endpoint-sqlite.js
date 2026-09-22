// ==============================================================================
// @silksec/sec-backend-endpoint-sqlite — endpoint 域 sqlite-local 后端（repository-v1）
//
// 契约：doc/secagent/04-endpoint.md §2.1/§2.4（后端适配器：表 + 队列文件双组件）
//
// 职责：
//   表（sqlite-local，asset-graph.db WAL 直接接管 endpoints 现表，不改名不迁库）
//     新增 idx_endpoints_program / idx_endpoints_auth 索引 + 全部表原语；
//   文件（恒挂 file 后端）param-queue.txt / param-seen.txt 的原子读写（tmp+rename）
//     + param-queue-meta.json（last_enqueued_at / last_consumed_at）。
// 不含业务校验（域命令负责校验）。
//
// 事务边界：表写原语在总线 CommandGateway 的 BEGIN IMMEDIATE 内执行；文件写靠
// tmp+rename 原子性（04-endpoint §2.3：文件操作不进 SQLite 事务）。
// ==============================================================================

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = '@silksec/sec-backend-endpoint-sqlite'
export const version = '1.0.0'
export const repositoryV1 = 'repository-v1'

const ENDPOINTS_DDL = `
CREATE TABLE IF NOT EXISTS endpoints (
  host TEXT NOT NULL,
  method TEXT NOT NULL DEFAULT 'GET',
  path TEXT NOT NULL,
  status TEXT,
  source TEXT,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  program_id TEXT,
  params TEXT,
  auth_required TEXT,
  roles_seen TEXT,
  PRIMARY KEY (host, method, path)
)`

const EP_LIST_COLS = 'host, method, path, status, source, program_id, params, auth_required, roles_seen, auth_state, should_auth, should_auth_source, last_seen'

// v5 新增列（ensureCol 幂等列演进，21 号方案 §5.1/§5.2）：
//   auth_state           — 登录态判定结果（public/login_required/role_required/unknown）
//   auth_state_evidence  — 判定证据 JSON（reasons/confidence/probe_at）
//   should_auth          — 业务语义「应该登录」（yes/no/unknown；人工裁定 > 自动建议）
//   should_auth_source   — 标注来源（auto/model/dashboard:operator）
//   should_auth_at       — 标注时刻
const V5_COLS = [
  ['auth_state', 'auth_state TEXT'],
  ['auth_state_evidence', 'auth_state_evidence TEXT'],
  ['should_auth', 'should_auth TEXT'],
  ['should_auth_source', 'should_auth_source TEXT'],
  ['should_auth_at', 'should_auth_at INTEGER'],
]

function ensureCol(db, table, col, ddl) {
  try {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all()
    if (!cols.some((c) => c.name === col)) {
      try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`) } catch (e) {
        if (!/duplicate column/i.test(String(e?.message))) throw e
      }
    }
  } catch (e) {
    process.stderr.write(`[sec-backend-endpoint-sqlite] ensureCol(${col}) 失败: ${e?.message}\n`)
  }
}

const EP_SORT = {
  last_seen: 'last_seen',
  host: 'host',
  status: 'status',
  path: 'path',
}

const _cache = new WeakMap()

function createRepo(db, dataDir) {
  db.exec(ENDPOINTS_DDL)
  for (const [col, ddl] of V5_COLS) ensureCol(db, 'endpoints', col, ddl)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_endpoints_host ON endpoints(host)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_endpoints_program ON endpoints(program_id)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_endpoints_auth ON endpoints(auth_required)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_endpoints_auth_state ON endpoints(auth_state)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_endpoints_should_auth ON endpoints(should_auth)`)

  const pipelineDir = (program) => {
    const d = path.join(dataDir, 'pipeline', program)
    fs.mkdirSync(d, { recursive: true })
    return d
  }

  // ---- 文件原语（tmp+rename 原子写）----
  const queuePath = (program) => path.join(pipelineDir(program), 'param-queue.txt')
  const seenPath = (program) => path.join(pipelineDir(program), 'param-seen.txt')
  const metaPath = (program) => path.join(pipelineDir(program), 'param-queue-meta.json')

  function readLines(file) {
    if (!fs.existsSync(file)) return []
    return fs.readFileSync(file, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean)
  }

  function writeLinesAtomic(file, lines) {
    const tmp = `${file}.tmp.${process.pid}.${Date.now()}`
    fs.writeFileSync(tmp, lines.length ? lines.join('\n') + '\n' : '')
    fs.renameSync(tmp, file)
  }

  function readMeta(program) {
    try { return JSON.parse(fs.readFileSync(metaPath(program), 'utf8')) } catch { return { last_enqueued_at: null, last_consumed_at: null } }
  }
  function writeMeta(program, meta) {
    const tmp = `${metaPath(program)}.tmp.${process.pid}.${Date.now()}`
    fs.writeFileSync(tmp, JSON.stringify(meta))
    fs.renameSync(tmp, metaPath(program))
  }

  const repo = {
    // ---- 表原语 ----
    getEndpoint(host, method, path) {
      const r = db.prepare('SELECT * FROM endpoints WHERE host = ? AND method = ? AND path = ?').get(String(host), String(method).toUpperCase(), String(path))
      return r ? { ...r } : null
    },

    insertEndpoint(row) {
      const now = Date.now()
      const r = db.prepare(`
        INSERT INTO endpoints (host, method, path, status, source, program_id, params, first_seen, last_seen)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (host, method, path) DO NOTHING
      `).run(
        String(row.host), String(row.method).toUpperCase(), String(row.path),
        row.status === null || row.status === undefined ? null : String(row.status),
        row.source === null || row.source === undefined ? null : String(row.source),
        row.program_id === null || row.program_id === undefined ? null : String(row.program_id),
        row.params === null || row.params === undefined ? null : JSON.stringify(row.params),
        now, now,
      )
      if (r.changes === 1) { invalidateHosts(); return { created: true, row: repo.getEndpoint(row.host, row.method, row.path) } }
      return { created: false, row: repo.getEndpoint(row.host, row.method, row.path) }
    },

    touchEndpoint(host, method, path, sets, ts) {
      db.prepare(`
        UPDATE endpoints SET last_seen = ?,
          status = CASE WHEN ? != '' THEN ? ELSE status END,
          params = CASE WHEN ? IS NOT NULL THEN ? ELSE params END,
          program_id = CASE WHEN ? IS NOT NULL THEN ? ELSE program_id END
        WHERE host = ? AND method = ? AND path = ?
      `).run(
        ts,
        String(sets.status || ''), String(sets.status || ''),
        sets.params !== null && sets.params !== undefined ? JSON.stringify(sets.params) : null, sets.params !== null && sets.params !== undefined ? JSON.stringify(sets.params) : null,
        sets.program_id ?? null, sets.program_id ?? null,
        String(host), String(method).toUpperCase(), String(path),
      )
      return { created: false, row: repo.getEndpoint(host, method, path) }
    },

    updateEndpointAuth(host, method, path, sets, ts) {
      const before = repo.getEndpoint(host, method, path)
      const keys = []
      const vals = []
      if (sets.auth_required !== undefined && sets.auth_required !== null) { keys.push('auth_required = ?'); vals.push(String(sets.auth_required)) }
      if (sets.roles_seen !== undefined) { keys.push('roles_seen = ?'); vals.push(JSON.stringify(sets.roles_seen)) }
      if (!keys.length) return { changed: false, before, after: before }
      keys.push('last_seen = ?'); vals.push(ts)
      const r = db.prepare(`UPDATE endpoints SET ${keys.join(', ')} WHERE host = ? AND method = ? AND path = ?`)
        .run(...vals, String(host), String(method).toUpperCase(), String(path))
      const after = r.changes ? repo.getEndpoint(host, method, path) : before
      return { changed: r.changes === 1, before, after }
    },

    // 21 号方案 §5.1：登录态判定落列（auth_state + 证据 JSON）
    updateEndpointAuthState(host, method, path, authState, evidence, ts) {
      const before = repo.getEndpoint(host, method, path)
      const r = db.prepare(`UPDATE endpoints SET auth_state = ?, auth_state_evidence = ?, last_seen = ? WHERE host = ? AND method = ? AND path = ?`)
        .run(String(authState), evidence === null || evidence === undefined ? null : JSON.stringify(evidence), ts, String(host), String(method).toUpperCase(), String(path))
      const after = r.changes ? repo.getEndpoint(host, method, path) : before
      return { changed: r.changes === 1, before, after }
    },

    // 21 号方案 §5.2：业务语义标注（人工裁定 source=dashboard 不被自动建议覆盖）
    updateEndpointSemantics(host, method, path, shouldAuth, source, ts) {
      const before = repo.getEndpoint(host, method, path)
      const src = String(source || '')
      const prevSrc = String(before?.should_auth_source || '')
      // 人工裁定 > 自动建议：已有 dashboard 裁定且本次为自动建议 → 不改值，只回读
      if (prevSrc.startsWith('dashboard') && !src.startsWith('dashboard')) {
        return { changed: false, skipped: 'human_override_kept', before, after: before }
      }
      const r = db.prepare(`UPDATE endpoints SET should_auth = ?, should_auth_source = ?, should_auth_at = ?, last_seen = ? WHERE host = ? AND method = ? AND path = ?`)
        .run(String(shouldAuth), src, ts, ts, String(host), String(method).toUpperCase(), String(path))
      const after = r.changes ? repo.getEndpoint(host, method, path) : before
      return { changed: r.changes === 1, before, after }
    },

    // 21 号方案 §4.4/§5：登录态分布聚合（登录盲区摘要的分母）
    authStateSummary(filters) {
      const conds = []
      const args = []
      if (filters.program_id) { conds.push('program_id = ?'); args.push(String(filters.program_id)) }
      if (filters.host) { conds.push('host = ?'); args.push(String(filters.host)) }
      const where = conds.length ? conds.join(' AND ') : '1=1'
      const rows = db.prepare(`SELECT host, auth_state, should_auth, should_auth_source FROM endpoints WHERE ${where}`).all(...args)
      const byState = { public: 0, login_required: 0, role_required: 0, unknown: 0, unmarked: 0 }
      const byShould = { yes: 0, no: 0, unknown: 0, unmarked: 0 }
      let humanRuled = 0
      let loginRequiredHosts = new Set()
      for (const r of rows) {
        const s = r.auth_state
        if (s === 'public' || s === 'login_required' || s === 'role_required' || s === 'unknown') byState[s]++
        else byState.unmarked++
        const sh = r.should_auth
        if (sh === 'yes' || sh === 'no' || sh === 'unknown') byShould[sh]++
        else byShould.unmarked++
        if (String(r.should_auth_source || '').startsWith('dashboard')) humanRuled++
        if (s === 'login_required' || s === 'role_required') loginRequiredHosts.add(r.host)
      }
      return {
        total: rows.length, by_state: byState, by_should_auth: byShould,
        human_ruled: humanRuled,
        login_required_hosts: [...loginRequiredHosts].sort(),
        marked_ratio: rows.length ? Number(((rows.length - byState.unmarked) / rows.length).toFixed(4)) : 0,
      }
    },

    listEndpointsWhere(filters, order, limit, offset) {
      const { where, args } = buildEpWhere(filters)
      const sql = `SELECT ${EP_LIST_COLS} FROM endpoints WHERE ${where} ORDER BY ${orderClause(EP_SORT, order.sort, order.dir, 'last_seen')} LIMIT ? OFFSET ?`
      return db.prepare(sql).all(...args, Math.min(Number(limit) || 50, 500), Math.max(0, Number(offset) || 0)).map((r) => ({ ...r }))
    },

    countEndpointsWhere(filters) {
      const { where, args } = buildEpWhere(filters)
      return db.prepare(`SELECT COUNT(*) AS n FROM endpoints WHERE ${where}`).get(...args).n
    },

    hostsAggregate(filters, limit, offset) {
      const conds = []
      const args = []
      if (filters.path_like) { conds.push('path LIKE ?'); args.push(`%${filters.path_like}%`) }
      if (filters.program_id) { conds.push('program_id = ?'); args.push(String(filters.program_id)) }
      const where = conds.length ? conds.join(' AND ') : '1=1'
      const rows = db.prepare(`
        SELECT host, program_id, COUNT(*) AS n, GROUP_CONCAT(DISTINCT method) AS methods, MAX(last_seen) AS last_seen
        FROM endpoints WHERE ${where} GROUP BY host ORDER BY last_seen DESC LIMIT ? OFFSET ?
      `).all(...args, Math.min(Number(limit) || 50, 500), Math.max(0, Number(offset) || 0)).map((r) => ({ ...r }))
      const total = db.prepare(`SELECT COUNT(DISTINCT host) AS n FROM endpoints WHERE ${where}`).get(...args).n
      return { rows, total }
    },

    matrixAggregate(filters, minRoles) {
      const conds = []
      const args = []
      if (filters.program_id) { conds.push('program_id = ?'); args.push(String(filters.program_id)) }
      if (filters.host) { conds.push('host = ?'); args.push(String(filters.host)) }
      const where = conds.length ? conds.join(' AND ') : '1=1'
      const rows = db.prepare(`SELECT host, auth_required, roles_seen FROM endpoints WHERE ${where}`).all(...args).map((r) => ({ ...r }))
      const byHost = new Map()
      for (const r of rows) {
        let acc = byHost.get(r.host)
        if (!acc) {
          acc = { host: r.host, total: 0, auth: { yes: 0, no: 0, unknown: 0 }, roles: new Set(), multi_role_endpoints: 0, no_auth_endpoints: 0 }
          byHost.set(r.host, acc)
        }
        acc.total++
        const a = r.auth_required
        if (a === 'yes' || a === 'no' || a === 'unknown') acc.auth[a]++
        let roles = []
        try { roles = JSON.parse(r.roles_seen || '[]') } catch { roles = [] }
        if (Array.isArray(roles)) for (const role of roles) acc.roles.add(role)
        if (roles.length >= 2) acc.multi_role_endpoints++
        if (a === 'no') acc.no_auth_endpoints++
      }
      const out = []
      for (const acc of byHost.values()) {
        if (minRoles > 0 && acc.roles.size < minRoles) continue
        const priority_hint = (acc.no_auth_endpoints > 0 || acc.multi_role_endpoints >= (minRoles || 2))
          ? `auth=no × ${acc.no_auth_endpoints} 且多角色端点 ${acc.multi_role_endpoints}——越权与未授权访问优先面`
          : ''
        out.push({
          host: acc.host, total: acc.total, auth: acc.auth,
          roles: [...acc.roles].sort(), multi_role_endpoints: acc.multi_role_endpoints,
          no_auth_endpoints: acc.no_auth_endpoints, priority_hint,
        })
      }
      out.sort((a, b) => (b.no_auth_endpoints + b.multi_role_endpoints) - (a.no_auth_endpoints + a.multi_role_endpoints))
      return out
    },

    // ---- 文件原语（队列）----
    readQueue(program) { return readLines(queuePath(program)) },
    readSeen(program) { return readLines(seenPath(program)) },

    appendQueueAtomic(program, urls) {
      const cur = readLines(queuePath(program))
      const merged = [...cur, ...urls]
      writeLinesAtomic(queuePath(program), merged)
      const meta = readMeta(program)
      meta.last_enqueued_at = Date.now()
      writeMeta(program, meta)
      return { queue_lines: merged.length }
    },

    appendSeenAtomic(program, urls) {
      const cur = readLines(seenPath(program))
      const merged = [...cur, ...urls]
      writeLinesAtomic(seenPath(program), merged)
      return { seen_lines: merged.length }
    },

    rewriteQueueAtomic(program, remainingUrls) {
      writeLinesAtomic(queuePath(program), remainingUrls)
      const meta = readMeta(program)
      meta.last_consumed_at = Date.now()
      writeMeta(program, meta)
      return { queue_lines: remainingUrls.length }
    },

    queueStat(program) {
      return {
        queue_lines: readLines(queuePath(program)).length,
        seen_lines: readLines(seenPath(program)).length,
        ...readMeta(program),
      }
    },

    queuePaths(program) {
      return { queue: queuePath(program), seen: seenPath(program) }
    },
  }

  return repo
}

function buildEpWhere(filters = {}) {
  const conds = []
  const args = []
  if (filters.host) { conds.push('host = ?'); args.push(String(filters.host)) }
  if (filters.path_like) { conds.push('path LIKE ?'); args.push(`%${filters.path_like}%`) }
  if (filters.method) { conds.push('method = ?'); args.push(String(filters.method).toUpperCase()) }
  if (filters.program_id) { conds.push('program_id = ?'); args.push(String(filters.program_id)) }
  if (filters.auth_required === 'none') { conds.push('auth_required IS NULL') }
  else if (filters.auth_required) { conds.push('auth_required = ?'); args.push(String(filters.auth_required)) }
  if (filters.auth_state === 'none') { conds.push('auth_state IS NULL') }
  else if (filters.auth_state) { conds.push('auth_state = ?'); args.push(String(filters.auth_state)) }
  if (filters.should_auth === 'none') { conds.push('should_auth IS NULL') }
  else if (filters.should_auth) { conds.push('should_auth = ?'); args.push(String(filters.should_auth)) }
  return { where: conds.length ? conds.join(' AND ') : '1=1', args }
}

function orderClause(map, sort, dir, dflt) {
  const col = map[sort] || dflt
  const dr = String(dir || '').toLowerCase() === 'asc' ? 'ASC' : 'DESC'
  return `${col} ${dr}`
}

// hosts 聚合无缓存（04-endpoint §2.5：迁移后 ~6,700 行全表聚合 <10ms，实时优先；缓存留待规模增长再开）
function invalidateHosts() { /* noop（预留） */ }

export function createEndpointBackend(opts = {}) {
  const dataDir = opts.dataDir || process.env.SEC_DATA_DIR || '/opt/silkspool/dsh/data'
  return {
    capabilities: {},
    factory(db) {
      let repo = _cache.get(db)
      if (!repo) {
        repo = createRepo(db, dataDir)
        _cache.set(db, repo)
      }
      return repo
    },
    _invalidateHosts: invalidateHosts,
  }
}
