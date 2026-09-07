// ==============================================================================
// @silksec/sec-backend-vuln-sqlite — vuln 域 sqlite-local 后端（repository-v1）
//
// 契约：doc/secagent/v5/02-vuln.md §2.1/§2.4（后端适配器）
//
// 职责：直接接管现表 findings（asset-graph.db，WAL，不改名不迁库）；ensureCol 幂等
// 列演进（claimed_by/claimed_at/updated_at/remote_id/remote_synced_at/sync_state）；
// 新增候选队列索引；全部 repository 原语。不含业务校验（域命令负责校验）。
//
// 重要：事务边界由总线 CommandGateway 的 BEGIN IMMEDIATE 承担——本后端所有写原语
// 都在网关事务内执行（跨进程由 SQLite WAL + busy_timeout 串行化）。
// ==============================================================================

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = '@silksec/sec-backend-vuln-sqlite'
export const version = '1.0.0'
export const repositoryV1 = 'repository-v1'

const SEV_RANK = { critical: 4, high: 3, medium: 2, low: 1, info: 0 }

const FINDINGS_DDL = `
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
  created_at INTEGER NOT NULL,
  program_id TEXT,
  task_id INTEGER,
  session_id TEXT,
  vuln_type TEXT,
  cwe TEXT,
  endpoint_ref TEXT,
  preconditions TEXT,
  reproduction_steps TEXT,
  impact TEXT,
  recommendation TEXT,
  submitted_at INTEGER,
  vendor_status TEXT,
  bounty REAL,
  noise INTEGER NOT NULL DEFAULT 0,
  confidence TEXT NOT NULL DEFAULT 'tentative',
  fgs_node_id INTEGER,
  discovery_step TEXT,
  claimed_by TEXT,
  claimed_at INTEGER,
  updated_at INTEGER,
  remote_id TEXT,
  remote_synced_at INTEGER,
  sync_state TEXT
)`

const V5_COLS = [
  ['claimed_by', 'claimed_by TEXT'],
  ['claimed_at', 'claimed_at INTEGER'],
  ['updated_at', 'updated_at INTEGER'],
  ['remote_id', 'remote_id TEXT'],
  ['remote_synced_at', 'remote_synced_at INTEGER'],
  ['sync_state', 'sync_state TEXT'],
]

const LIST_COLS = `id, title, severity, host, url, source, status, program_id, session_id,
  vuln_type, bounty, vendor_status, noise, claimed_by, created_at, confidence, fgs_node_id, discovery_step`

const POOL_COLS = `${LIST_COLS}, claimed_at, updated_at`

const SORT_COLS = {
  created_at: 'created_at',
  id: 'id',
  status: 'status',
  severity: `CASE severity WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 WHEN 'low' THEN 1 ELSE 0 END`,
  claimed_at: 'claimed_at',
}

const _cache = new WeakMap()

function createRepo(db) {
  // ---- 表接管（现表不动；空库建全量 DDL）----
  db.exec(FINDINGS_DDL)
  for (const [col, ddl] of V5_COLS) ensureCol(db, col, ddl)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_findings_pool ON findings(noise, status)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_findings_claim ON findings(claimed_at)`)

  const stmts = {
    getFinding: db.prepare('SELECT * FROM findings WHERE id = ?'),
    getByFp: db.prepare('SELECT * FROM findings WHERE fingerprint = ?'),
    updateBackfillSession: db.prepare('UPDATE findings SET session_id = COALESCE(session_id, ?) WHERE id = ?'),
    appendEvidence: db.prepare('UPDATE findings SET evidence = COALESCE(evidence, ?) || ? WHERE id = ?'),
  }

  const repo = {
    getFinding(id) {
      const r = stmts.getFinding.get(Number(id))
      return r ? { ...r } : null
    },
    getFindingByFingerprint(fp) {
      const r = stmts.getByFp.get(String(fp))
      return r ? { ...r } : null
    },
    insertFinding(f) {
      const r = db.prepare(`
        INSERT INTO findings (fingerprint, title, severity, host, url, evidence, source, status, created_at,
          program_id, session_id, vuln_type, cwe, endpoint_ref, preconditions, reproduction_steps, impact,
          recommendation, noise, confidence, fgs_node_id, discovery_step, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        f.fingerprint, f.title, f.severity, f.host, f.url, f.evidence || '', f.source || '', f.status || 'new', f.created_at,
        f.program_id || null, f.session_id || null, f.vuln_type || null, f.cwe || null, f.endpoint_ref || null,
        f.preconditions || null, f.reproduction_steps || null, f.impact || null, f.recommendation || null,
        f.noise === 1 ? 1 : 0, f.confidence || 'tentative', f.fgs_node_id || null, f.discovery_step || null,
        f.updated_at || f.created_at,
      )
      return { id: Number(r.lastInsertRowid) }
    },
    transitionFinding(id, expectStatus, sets) {
      const before = repo.getFinding(id)
      const keys = Object.keys(sets)
      if (!keys.length) return { changed: false, before }
      const sql = `UPDATE findings SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ? AND status IN (${(Array.isArray(expectStatus) ? expectStatus : [expectStatus]).map(() => '?').join(',')})`
      const r = db.prepare(sql).run(...keys.map((k) => sets[k]), Number(id), ...(Array.isArray(expectStatus) ? expectStatus : [expectStatus]))
      const after = r.changes ? repo.getFinding(id) : before
      return { changed: r.changes === 1, before, after }
    },
    updateFields(id, sets) {
      const before = repo.getFinding(id)
      const keys = Object.keys(sets)
      if (!keys.length) return { changed: false, before }
      const r = db.prepare(`UPDATE findings SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
        .run(...keys.map((k) => sets[k]), Number(id))
      const after = r.changes ? repo.getFinding(id) : before
      return { changed: r.changes === 1, before, after }
    },
    mergeCandidate(id, fields, newFp) {
      const before = repo.getFinding(id)
      const set = []
      const args = []
      for (const k of ['title', 'severity', 'host', 'url', 'evidence', 'source', 'vuln_type', 'cwe', 'endpoint_ref',
        'preconditions', 'reproduction_steps', 'impact', 'recommendation', 'confidence', 'fgs_node_id', 'discovery_step', 'session_id', 'updated_at']) {
        if (fields[k] !== undefined) { set.push(`${k} = ?`); args.push(fields[k]) }
      }
      set.push('fingerprint = ?', 'noise = 0')
      args.push(newFp, Number(id))
      const r = db.prepare(`UPDATE findings SET ${set.join(', ')} WHERE id = ?`).run(...args)
      const after = r.changes ? repo.getFinding(id) : before
      return { changed: r.changes === 1, before, after }
    },
    appendEvidence(id, text) {
      const cur = stmts.getFinding.get(Number(id))
      const base = cur?.evidence ? `${cur.evidence}\n` : ''
      db.prepare('UPDATE findings SET evidence = ? WHERE id = ?').run(`${base}${String(text)}`, Number(id))
      return {}
    },
    backfillSession(id, sessionId) {
      if (!sessionId) return {}
      stmts.updateBackfillSession.run(String(sessionId), Number(id))
      return {}
    },
    setClaim(id, claimer, nowMs, ttlSec) {
      const before = repo.getFinding(id)
      const cutoff = nowMs - ttlSec * 1000
      const r = db.prepare(`
        UPDATE findings SET claimed_by = ?, claimed_at = ?, updated_at = ?
        WHERE id = ? AND noise = 1 AND status = 'new'
          AND (claimed_by IS NULL OR claimed_at IS NULL OR claimed_at < ?)
      `).run(String(claimer), nowMs, nowMs, Number(id), cutoff)
      return { ok: r.changes === 1, previous: before }
    },
    listFindingsWhere(pred, order) {
      const { where, args } = buildWhere(pred)
      const sql = `SELECT ${LIST_COLS} FROM findings WHERE ${where} ORDER BY ${orderClause(order)}`
      return db.prepare(sql).all(...args).map((r) => ({ ...r }))
    },
    listCandidatePool(pred, order) {
      const { where, args } = buildWhere({ ...pred, visibility: 'candidate' })
      const cutoff = Date.now() - 3600 * 1000
      const claimFilters = {
        unclaimed: ' AND claimed_by IS NULL',
        claimed: ' AND claimed_by IS NOT NULL AND claimed_at >= ' + cutoff,
        stale: ' AND claimed_by IS NOT NULL AND claimed_at < ' + cutoff,
        available: ' AND (claimed_by IS NULL OR claimed_at < ' + cutoff + ')',
        all: '',
      }
      const claimFilter = Object.prototype.hasOwnProperty.call(claimFilters, pred.claim_state)
        ? claimFilters[pred.claim_state]
        : claimFilters.available
      const sql = `SELECT ${POOL_COLS} FROM findings WHERE ${where}${claimFilter} ORDER BY ${orderClause(order)}`
      const rows = db.prepare(sql).all(...args).map((r) => ({ ...r }))
      const count = (extra) => db.prepare(`SELECT COUNT(*) AS n FROM findings WHERE ${where}${extra}`).get(...args).n
      const claimed = count(` AND claimed_by IS NOT NULL AND claimed_at >= ${cutoff}`)
      const stale = count(` AND claimed_by IS NOT NULL AND claimed_at < ${cutoff}`)
      const pending = count(` AND (claimed_by IS NULL OR claimed_at < ${cutoff})`)
      const bySevRows = db.prepare(`SELECT severity, COUNT(*) AS n FROM findings WHERE ${where} AND (claimed_by IS NULL OR claimed_at < ${cutoff}) GROUP BY severity`).all(...args)
      const bySeverity = {}
      for (const s of bySevRows) bySeverity[s.severity || 'info'] = s.n
      const pool = { pending, claimed, stale, by_severity: bySeverity }
      return { rows, pool }
    },
    listDedup({ host, vuln_type, exclude_id }, limit) {
      const args = []
      let where = "noise = 0"
      const conds = []
      if (host) { conds.push('host = ?'); args.push(String(host)) }
      if (vuln_type) { conds.push('vuln_type = ?'); args.push(String(vuln_type)) }
      if (conds.length) where += ` AND (${conds.join(' OR ')})`
      if (exclude_id) { where += ' AND id != ?'; args.push(Number(exclude_id)) }
      const rows = db.prepare(`SELECT id, title, severity, status, host, created_at FROM findings WHERE ${where} ORDER BY created_at DESC LIMIT ?`).all(...args, Math.min(Number(limit) || 10, 50)).map((r) => ({ ...r }))
      const total = db.prepare(`SELECT COUNT(*) AS n FROM findings WHERE ${where}`).get(...args).n
      return { rows, total }
    },
    statsFindings() {
      const one = (sql, ...a) => db.prepare(sql).get(...a)
      const signalTotal = one("SELECT COUNT(*) AS n FROM findings WHERE noise = 0").n
      const signalBySev = db.prepare("SELECT severity, COUNT(*) AS n FROM findings WHERE noise = 0 GROUP BY severity").all()
      const signalByStatus = db.prepare("SELECT status, COUNT(*) AS n FROM findings WHERE noise = 0 GROUP BY status").all()
      const candidatePending = one("SELECT COUNT(*) AS n FROM findings WHERE noise = 1 AND status = 'new'").n
      const candidateClaimed = one("SELECT COUNT(*) AS n FROM findings WHERE noise = 1 AND status = 'new' AND claimed_by IS NOT NULL").n
      const candBySev = db.prepare("SELECT severity, COUNT(*) AS n FROM findings WHERE noise = 1 AND status = 'new' GROUP BY severity").all()
      const oldest = one("SELECT MIN(created_at) AS m FROM findings WHERE noise = 1 AND status = 'new'").m
      const terminal = one("SELECT COUNT(*) AS n FROM findings WHERE noise = 1 AND status != 'new'").n
      return {
        signal: {
          total: signalTotal,
          by_severity: Object.fromEntries(signalBySev.map((r) => [r.severity || 'info', r.n])),
          by_status: Object.fromEntries(signalByStatus.map((r) => [r.status, r.n])),
        },
        candidate: {
          pending: candidatePending,
          claimed: candidateClaimed,
          by_severity: Object.fromEntries(candBySev.map((r) => [r.severity || 'info', r.n])),
          oldest_pending_at: oldest ?? null,
        },
        terminal_in_pool: terminal,
        sync: { pending: 0, failed: 0, last_synced_at: null },
      }
    },
    ensureCol(col, ddl) {
      ensureCol(db, col, ddl)
      return {}
    },
  }
  return repo
}

function ensureCol(db, col, ddl) {
  try {
    const cols = db.prepare('PRAGMA table_info(findings)').all()
    if (!cols.some((c) => c.name === col)) {
      try {
        db.exec(`ALTER TABLE findings ADD COLUMN ${ddl}`)
      } catch (e) {
        if (!/duplicate column/i.test(String(e?.message))) throw e
      }
    }
  } catch (e) {
    process.stderr.write(`[sec-backend-vuln-sqlite] ensureCol(${col}) 失败: ${e?.message}\n`)
  }
}

function buildWhere(pred = {}) {
  const conds = []
  const args = []
  if (pred.visibility === 'signal') conds.push('noise = 0')
  else if (pred.visibility === 'candidate') conds.push("noise = 1 AND status = 'new'")
  if (pred.host) { conds.push('host = ?'); args.push(String(pred.host)) }
  if (pred.severity) { conds.push('severity = ?'); args.push(String(pred.severity)) }
  if (pred.status) { conds.push('status = ?'); args.push(String(pred.status)) }
  if (pred.program_id) { conds.push('program_id = ?'); args.push(String(pred.program_id)) }
  if (pred.q) { conds.push('(title LIKE ? OR host LIKE ? OR url LIKE ?)'); args.push(`%${pred.q}%`, `%${pred.q}%`, `%${pred.q}%`) }
  if (pred.severity_min && SEV_RANK[pred.severity_min] !== undefined) {
    const rank = SEV_RANK[pred.severity_min]
    conds.push(`CASE severity WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 WHEN 'low' THEN 1 ELSE 0 END >= ${rank}`)
  }
  return { where: conds.length ? conds.join(' AND ') : '1=1', args }
}

function orderClause(order = {}) {
  const col = SORT_COLS[order.sort] || 'created_at'
  const dir = String(order.dir || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC'
  return `${col} ${dir}`
}

// ---------------------------------------------------------------------------
// 工厂（总线每次 dispatch 调用；按连接缓存——同一 DatabaseSync 共享仓库实例）
// ---------------------------------------------------------------------------

export function createVulnSqliteBackend(_opts = {}) {
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