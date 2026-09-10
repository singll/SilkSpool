// ==============================================================================
// @silksec/sec-backend-approval-sqlite — approval 域 sqlite-local 后端（repository-v1）
//
// 契约：doc/secagent/v5/09-approval.md §2.1/§2.4
//
// 职责：直接接管 approval_requests 表（asset-graph.db，不改列不迁库，CHECK 约束不动）；
// 新增 approval_effects 表（批准后域效果的幂等执行账本，owner=approval）。
// 状态机列仅 pending/approved/rejected（SQLite 无法 ALTER CHECK——09 §1.3.3）。
// 不含业务校验（域命令负责校验）。
// ==============================================================================

import { DatabaseSync } from 'node:sqlite'

export const name = '@silksec/sec-backend-approval-sqlite'
export const version = '1.0.0'
export const repositoryV1 = 'repository-v1'

const REQUESTS_DDL = `
CREATE TABLE IF NOT EXISTS approval_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  subject TEXT NOT NULL,
  program_name TEXT,
  payload TEXT,
  evidence TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
  requested_by TEXT,
  created_at INTEGER,
  decided_at INTEGER,
  note TEXT
);
CREATE INDEX IF NOT EXISTS idx_approval_status ON approval_requests(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_approval_pending ON approval_requests(kind, subject, status);
`
const EFFECTS_DDL = `
CREATE TABLE IF NOT EXISTS approval_effects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL,
  effect_key TEXT NOT NULL,
  domain TEXT NOT NULL,
  verb TEXT NOT NULL,
  payload TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  attempt INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  applied_at INTEGER,
  UNIQUE(request_id, effect_key)
);
CREATE INDEX IF NOT EXISTS idx_effects_request ON approval_effects(request_id);
CREATE INDEX IF NOT EXISTS idx_effects_status ON approval_effects(status);
`

function parseRequest(row) {
  if (!row) return null
  const r = { ...row }
  try { r.payload = r.payload ? JSON.parse(r.payload) : null } catch { r.payload = null }
  return r
}
function plain(row) { return row ? { ...row } : null }
function plainAll(rows) { return rows.map((r) => ({ ...r })) }

function createRepo(db) {
  db.exec(REQUESTS_DDL)
  db.exec(EFFECTS_DDL)

  const repo = {
    now() { return Date.now() },

    // ---- approval_requests ----
    insertRequest({ kind, subject, program_name, payload, evidence, requested_by }) {
      const r = db.prepare(`INSERT INTO approval_requests (kind, subject, program_name, payload, evidence, status, requested_by, created_at)
        VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`)
        .run(kind, subject, program_name ?? null, payload ? JSON.stringify(payload) : null, evidence, requested_by ?? null, repo.now())
      return Number(r.lastInsertRowid)
    },
    getRequest(id) { return parseRequest(plain(db.prepare('SELECT * FROM approval_requests WHERE id = ?').get(Number(id)))) },
    findPending(kind, subject) {
      return parseRequest(plain(db.prepare("SELECT * FROM approval_requests WHERE kind = ? AND subject = ? AND status = 'pending' LIMIT 1").get(String(kind), String(subject))))
    },
    decideRequest(id, { status, decided_at, note }) {
      return db.prepare(`UPDATE approval_requests SET status = ?, decided_at = ?, note = ? WHERE id = ? AND status = 'pending'`)
        .run(status, decided_at, note ?? null, Number(id)).changes
    },
    setNote(id, note) {
      return db.prepare('UPDATE approval_requests SET note = ? WHERE id = ?').run(note ?? null, Number(id)).changes
    },
    listRequestsWhere({ kind, status, limit, offset }) {
      const where = []
      const args = []
      if (kind) { where.push('kind = ?'); args.push(String(kind)) }
      if (status) { where.push('status = ?'); args.push(String(status)) }
      const w = where.length ? `WHERE ${where.join(' AND ')}` : ''
      // 排序契约：pending 恒在最前，组内 created_at DESC
      const rows = db.prepare(`SELECT * FROM approval_requests ${w} ORDER BY CASE WHEN status='pending' THEN 0 ELSE 1 END, created_at DESC LIMIT ? OFFSET ?`)
        .all(...args, Math.min(Number(limit) || 50, 500), Math.max(0, Number(offset) || 0))
      const total = db.prepare(`SELECT COUNT(*) AS n FROM approval_requests ${w}`).get(...args).n
      return { rows: plainAll(rows).map(parseRequest), total }
    },
    statsSince(sinceTs) {
      const rows = plainAll(db.prepare('SELECT * FROM approval_requests WHERE created_at >= ?').all(sinceTs)).map(parseRequest)
      const byKind = {}
      for (const r of rows) {
        const b = byKind[r.kind] || (byKind[r.kind] = { kind: r.kind, pending: 0, approved: 0, rejected: 0, withdrawn: 0 })
        if (r.status === 'pending') b.pending++
        else if (r.status === 'approved') b.approved++
        else if (r.status === 'rejected') {
          if (String(r.note || '').startsWith('[已撤回]')) b.withdrawn++
          else b.rejected++
        }
      }
      return { byKind: Object.values(byKind), rows }
    },

    // ---- approval_effects ----
    insertEffect({ request_id, effect_key, domain, verb, payload }) {
      db.prepare(`INSERT OR IGNORE INTO approval_effects (request_id, effect_key, domain, verb, payload, status)
        VALUES (?, ?, ?, ?, ?, 'pending')`)
        .run(Number(request_id), effect_key, domain, verb, payload ? JSON.stringify(payload) : null)
    },
    markEffect(effectKey, { status, last_error }) {
      return db.prepare(`UPDATE approval_effects SET status = ?, last_error = ?, applied_at = ? WHERE effect_key = ?`)
        .run(status, last_error ?? null, status === 'applied' ? repo.now() : null, effectKey).changes
    },
    listEffects(requestId) {
      return plainAll(db.prepare('SELECT * FROM approval_effects WHERE request_id = ? ORDER BY id ASC').all(Number(requestId)))
    },
    pendingEffects() {
      return plainAll(db.prepare("SELECT * FROM approval_effects WHERE status IN ('pending','failed') ORDER BY id ASC LIMIT 100").all())
    },
  }
  return repo
}

const _cache = new WeakMap()

export function createApprovalSqliteBackend(_opts = {}) {
  return {
    capabilities: {},
    factory(db) {
      let repo = _cache.get(db)
      if (!repo) {
        repo = createRepo(db)
        _cache.set(db, repo)
      }
      return repo
    },
  }
}
