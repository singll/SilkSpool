// ==============================================================================
// @silksec/sec-backend-asset-sqlite — asset 域 sqlite-local 后端（repository-v1）
//
// 契约：doc/secagent/v5/03-asset.md §2.1/§2.4（后端适配器）
//
// 职责：直接接管现表 assets / fingerprints（asset-graph.db，WAL，不改名不迁库）；
// ensureCol 幂等列演进（changed_at / graded_at）；新增评级/状态索引；全部 repository 原语。
// 不含业务校验（域命令负责校验）；不含 scope 校验（域不变量经 scope.yml 自查）。
//
// 事务边界：总线 CommandGateway 的 BEGIN IMMEDIATE 承担——本后端所有写原语在网关事务内执行。
// ==============================================================================

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = '@silksec/sec-backend-asset-sqlite'
export const version = '1.0.0'
export const repositoryV1 = 'repository-v1'

const ASSETS_DDL = `
CREATE TABLE IF NOT EXISTS assets (
  host TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'host',
  source TEXT,
  attrs TEXT,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  program_id TEXT,
  score INTEGER,
  level TEXT,
  accept TEXT,
  biz TEXT,
  state TEXT,
  root TEXT,
  PRIMARY KEY (host, type)
)`

const FINGERPRINTS_DDL = `
CREATE TABLE IF NOT EXISTS fingerprints (
  program_id TEXT,
  host TEXT NOT NULL,
  tech TEXT NOT NULL,
  version TEXT,
  source TEXT,
  last_seen INTEGER NOT NULL,
  PRIMARY KEY (host, tech)
)`

// v5 新增列（ensureCol 幂等）：state 流转时刻 / 分级时刻
const V5_COLS = [
  ['changed_at', 'changed_at INTEGER'],
  ['graded_at', 'graded_at INTEGER'],
]

// 列表投影列（03-asset §1.4 asset_list 返回行字段）
const ASSET_LIST_COLS = 'host, type, source, program_id, last_seen, score, level, accept, biz, state'
const FP_LIST_COLS = 'program_id, host, tech, version, source, last_seen'

const ASSET_SORT = {
  last_seen: 'last_seen',
  host: 'host',
  type: 'type',
  program_id: 'program_id',
  score: 'score',
}

const _cache = new WeakMap()

// 总览聚合缓存（03-asset §2.5：25s TTL + 写命令失效）——模块级单例（单 DB）
let _ovCache = null

function createRepo(db) {
  db.exec(ASSETS_DDL)
  db.exec(FINGERPRINTS_DDL)
  for (const [col, ddl] of V5_COLS) ensureCol(db, 'assets', col, ddl)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_assets_root ON assets(root)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_assets_program ON assets(program_id)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_assets_level_score ON assets(level, score DESC)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_assets_state ON assets(state)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_fp_host ON fingerprints(host)`)

  const repo = {
    invalidateOverview() { _ovCache = null },

    getAsset(host, type) {
      const r = db.prepare('SELECT * FROM assets WHERE host = ? AND type = ?').get(String(host), String(type || 'host'))
      return r ? { ...r } : null
    },

    insertAsset(row) {
      const now = Date.now()
      const r = db.prepare(`
        INSERT INTO assets (host, type, source, attrs, program_id, first_seen, last_seen, root)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (host, type) DO NOTHING
      `).run(
        String(row.host), String(row.type || 'host'),
        row.source === null || row.source === undefined ? null : String(row.source),
        row.attrs === null || row.attrs === undefined ? null : JSON.stringify(row.attrs),
        row.program_id === null || row.program_id === undefined ? null : String(row.program_id),
        now, now, hostRoot(String(row.host)),
      )
      if (r.changes === 1) { _ovCache = null; return { created: true, row: repo.getAsset(row.host, row.type) } }
      // 冲突未插入：视为已存在（调用方应先用 getAsset 判断 created/touched）
      return { created: false, row: repo.getAsset(row.host, row.type) }
    },

    // 触活：刷 last_seen，source/program_id 就地补空不覆盖（评级列本动词不可写）
    touchAsset(host, type, source, program_id, ts) {
      db.prepare(`
        UPDATE assets SET last_seen = ?,
          source = CASE WHEN ? != '' THEN ? ELSE source END,
          program_id = CASE WHEN ? IS NOT NULL THEN ? ELSE program_id END
        WHERE host = ? AND type = ?
      `).run(ts, String(source || ''), String(source || ''), program_id ?? null, program_id ?? null, String(host), String(type || 'host'))
      return { created: false, row: repo.getAsset(host, type) }
    },

    updateAssetGrading(host, type, sets) {
      const before = repo.getAsset(host, type)
      const keys = Object.keys(sets)
      if (!keys.length) return { changed: false, before, after: before }
      const r = db.prepare(`UPDATE assets SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE host = ? AND type = ?`)
        .run(...keys.map((k) => sets[k]), String(host), String(type || 'host'))
      const after = r.changes ? repo.getAsset(host, type) : before
      if (r.changes) _ovCache = null
      return { changed: r.changes === 1, before, after }
    },

    updateAssetState(host, type, state, ts) {
      const before = repo.getAsset(host, type)
      const r = db.prepare('UPDATE assets SET state = ?, changed_at = ?, last_seen = ? WHERE host = ? AND type = ?')
        .run(String(state), ts, ts, String(host), String(type || 'host'))
      const after = r.changes ? repo.getAsset(host, type) : before
      if (r.changes) _ovCache = null
      return { changed: r.changes === 1, before, after }
    },

    listAssetsWhere(filters, order, limit, offset) {
      const { where, args } = buildAssetWhere(filters)
      const sql = `SELECT ${ASSET_LIST_COLS} FROM assets WHERE ${where} ORDER BY ${orderClause(ASSET_SORT, order.sort, order.dir, 'last_seen')} LIMIT ? OFFSET ?`
      return db.prepare(sql).all(...args, Math.min(Number(limit) || 50, 500), Math.max(0, Number(offset) || 0)).map((r) => ({ ...r }))
    },

    countAssetsWhere(filters) {
      const { where, args } = buildAssetWhere(filters)
      return db.prepare(`SELECT COUNT(*) AS n FROM assets WHERE ${where}`).get(...args).n
    },

    // 深挖队列（03-asset §1.4 固化查询）：level IN (S,A,B) + accept≠none + 非 dead，按 score 降序
    deepQueue(program_id, limit, offset) {
      const conds = ["level IN ('S','A','B')", "(accept IS NULL OR accept != 'none')", "(state IS NULL OR state != 'dead')"]
      const args = []
      if (program_id) { conds.push('program_id = ?'); args.push(String(program_id)) }
      const where = conds.join(' AND ')
      const limitN = Math.min(Number(limit) || 50, 500)
      const offsetN = Math.max(0, Number(offset) || 0)
      const rows = db.prepare(`SELECT host, type, score, level, accept, biz, state, last_seen FROM assets WHERE ${where} ORDER BY score DESC, last_seen DESC LIMIT ? OFFSET ?`)
        .all(...args, limitN, offsetN).map((r) => ({ ...r }))
      const total = db.prepare(`SELECT COUNT(*) AS n FROM assets WHERE ${where}`).get(...args).n
      return { rows, total }
    },

    overviewAggregate() {
      if (_ovCache && Date.now() - _ovCache.at < 25000) return _ovCache.data
      const hasTable = (t) => db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name=?").get(t) !== undefined
      const hasEp = hasTable('endpoints')
      const hasFin = hasTable('findings')
      const epJoin = hasEp ? 'LEFT JOIN (SELECT host, COUNT(*) AS n FROM endpoints GROUP BY host) e ON e.host = a.host' : ''
      const finJoin = hasFin ? 'LEFT JOIN (SELECT host, COUNT(*) AS n FROM findings WHERE noise = 0 GROUP BY host) f ON f.host = a.host' : ''
      const epSel = hasEp ? 'COALESCE(SUM(e.n), 0) AS endpoint_count' : '0 AS endpoint_count'
      const finSel = hasFin ? 'COALESCE(SUM(f.n), 0) AS finding_count' : '0 AS finding_count'
      const families = db.prepare(`
        SELECT a.root AS root,
          COUNT(*) AS host_count,
          ${epSel},
          ${finSel},
          MAX(a.score) AS max_score,
          MAX(CASE a.level WHEN 'S' THEN 4 WHEN 'A' THEN 3 WHEN 'B' THEN 2 WHEN 'C' THEN 1 ELSE 0 END) AS lv_rank,
          MAX(a.last_seen) AS last_seen
        FROM assets a
        ${epJoin}
        ${finJoin}
        WHERE a.root IS NOT NULL
        GROUP BY a.root ORDER BY host_count DESC, last_seen DESC LIMIT 300
      `).all().map((r) => ({
        root: r.root,
        kind: String(r.root).includes('/24') ? 'subnet' : 'domain',
        host_count: r.host_count,
        endpoint_count: r.endpoint_count || 0,
        finding_count: r.finding_count || 0,
        max_score: r.max_score,
        top_level: ({ 4: 'S', 3: 'A', 2: 'B', 1: 'C' })[r.lv_rank] || '',
        last_seen: r.last_seen,
        program_id: '',
      }))
      const byLevel = {}
      db.prepare('SELECT level, COUNT(*) AS n FROM assets GROUP BY level').all().forEach((r) => { byLevel[r.level || ''] = r.n })
      const byState = {}
      db.prepare('SELECT state, COUNT(*) AS n FROM assets WHERE state IS NOT NULL GROUP BY state').all().forEach((r) => { byState[r.state] = r.n })
      const byAccept = {}
      db.prepare('SELECT accept, COUNT(*) AS n FROM assets WHERE accept IS NOT NULL GROUP BY accept').all().forEach((r) => { byAccept[r.accept] = r.n })
      const data = {
        total: db.prepare('SELECT COUNT(*) AS n FROM assets').get().n,
        family_count: db.prepare('SELECT COUNT(DISTINCT root) AS n FROM assets WHERE root IS NOT NULL').get().n,
        by_level: byLevel, by_state: byState, by_accept: byAccept,
        families,
      }
      _ovCache = { at: Date.now(), data }
      return data
    },

    familyMembers(root, limit) {
      return db.prepare('SELECT host, type, level, score, accept, state, last_seen FROM assets WHERE root = ? ORDER BY COALESCE(score, -1) DESC, last_seen DESC LIMIT ?')
        .all(String(root), Math.min(Number(limit) || 200, 200)).map((r) => ({ ...r }))
    },

    siblingsOfHost(host, root, limit) {
      return db.prepare('SELECT host, type, level, score, last_seen FROM assets WHERE root = ? AND host != ? ORDER BY COALESCE(score, -1) DESC, last_seen DESC LIMIT ?')
        .all(String(root), String(host), Math.min(Number(limit) || 20, 20)).map((r) => ({ ...r }))
    },

    getAssetsByHost(host) {
      return db.prepare('SELECT * FROM assets WHERE host = ? ORDER BY type').all(String(host)).map((r) => ({ ...r }))
    },

    // 跨域只读（asset_get 聚合）：接口计数/接口行 / 漏洞分级统计（endpoint/vuln 域 owns，本域只读）
    assetDetailExtras(host) {
      const hasTable = (t) => db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name=?").get(t) !== undefined
      let endpointTotal = 0
      let endpoints = []
      let findings = []
      if (hasTable('endpoints')) {
        endpointTotal = db.prepare('SELECT COUNT(*) AS n FROM endpoints WHERE host = ?').get(String(host)).n
        endpoints = db.prepare('SELECT method, path, status, last_seen FROM endpoints WHERE host = ? ORDER BY last_seen DESC LIMIT 60').all(String(host)).map((r) => ({ ...r }))
      }
      if (hasTable('findings')) findings = db.prepare('SELECT severity, COUNT(*) AS n FROM findings WHERE noise = 0 AND host = ? GROUP BY severity ORDER BY n DESC').all(String(host)).map((r) => ({ ...r }))
      const fingerprints = db.prepare('SELECT tech, version, source, last_seen FROM fingerprints WHERE host = ? ORDER BY last_seen DESC LIMIT 30').all(String(host)).map((r) => ({ ...r }))
      return { endpoint_total: endpointTotal, endpoints, findings, fingerprints }
    },

    getFingerprint(host, tech) {
      const r = db.prepare('SELECT * FROM fingerprints WHERE host = ? AND tech = ?').get(String(host), String(tech))
      return r ? { ...r } : null
    },

    upsertFingerprint(row) {
      const now = Date.now()
      const before = repo.getFingerprint(row.host, row.tech)
      const r = db.prepare(`
        INSERT INTO fingerprints (program_id, host, tech, version, source, last_seen)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (host, tech) DO UPDATE SET
          version = CASE WHEN excluded.version != '' THEN excluded.version ELSE fingerprints.version END,
          source = CASE WHEN excluded.source != '' THEN excluded.source ELSE fingerprints.source END,
          program_id = CASE WHEN excluded.program_id IS NOT NULL THEN excluded.program_id ELSE fingerprints.program_id END,
          last_seen = excluded.last_seen
      `).run(
        row.program_id ?? null, String(row.host), String(row.tech),
        String(row.version || ''), String(row.source || ''), now,
      )
      const after = repo.getFingerprint(row.host, row.tech)
      return {
        created: r.changes === 0 && !before ? false : !before,
        version_from: before ? before.version || '' : '',
        version_changed: !!(before && before.version && String(row.version || '') && before.version !== String(row.version)),
        before, after,
      }
    },

    listFingerprintsWhere(filters, order, limit, offset) {
      const { where, args } = buildFpWhere(filters)
      const sql = `SELECT ${FP_LIST_COLS} FROM fingerprints WHERE ${where} ORDER BY last_seen DESC LIMIT ? OFFSET ?`
      return db.prepare(sql).all(...args, Math.min(Number(limit) || 50, 500), Math.max(0, Number(offset) || 0)).map((r) => ({ ...r }))
    },

    countFingerprintsWhere(filters) {
      const { where, args } = buildFpWhere(filters)
      return db.prepare(`SELECT COUNT(*) AS n FROM fingerprints WHERE ${where}`).get(...args).n
    },

    ensureCol(col, ddl) {
      ensureCol(db, 'assets', col, ddl)
      return {}
    },
  }
  return repo
}

function ensureCol(db, table, col, ddl) {
  try {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all()
    if (!cols.some((c) => c.name === col)) {
      try {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`)
      } catch (e) {
        if (!/duplicate column/i.test(String(e?.message))) throw e
      }
    }
  } catch (e) {
    process.stderr.write(`[sec-backend-asset-sqlite] ensureCol(${col}) 失败: ${e?.message}\n`)
  }
}

// 主机归族（03-asset §3.1 从 asset-db.js hostRoot 原样平移）：域名取注册域近似、IP 取 /24
function hostRoot(host) {
  let h = String(host || '').toLowerCase().trim()
  const port = h.indexOf(':'); if (port > 0) h = h.slice(0, port)
  const c0 = h.charCodeAt(0)
  if (c0 >= 48 && c0 <= 57 && /^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return h.slice(0, h.lastIndexOf('.')) + '.0/24'
  const parts = h.replace(/^\*\./, '').split('.')
  if (parts.length < 2) return h
  const sld = parts[parts.length - 2]
  if (parts.length >= 3 && (sld === 'com' || sld === 'net' || sld === 'org' || sld === 'gov' || sld === 'edu' || sld === 'co' || sld === 'ac')) return parts.slice(-3).join('.')
  return parts.slice(-2).join('.')
}

function buildAssetWhere(filters = {}) {
  const conds = []
  const args = []
  if (filters.host_like) { conds.push('host LIKE ?'); args.push(`%${filters.host_like}%`) }
  if (filters.type) { conds.push('type = ?'); args.push(String(filters.type)) }
  if (filters.program_id) { conds.push('program_id = ?'); args.push(String(filters.program_id)) }
  if (filters.level === 'none') { conds.push('level IS NULL') }
  else if (filters.level) { conds.push('level = ?'); args.push(String(filters.level)) }
  if (filters.level_in) {
    const lv = String(filters.level_in).split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
    if (lv.length) { conds.push(`level IN (${lv.map(() => '?').join(',')})`); args.push(...lv) }
  }
  if (filters.accept) { conds.push('accept = ?'); args.push(String(filters.accept)) }
  if (filters.state) { conds.push('state = ?'); args.push(String(filters.state)) }
  return { where: conds.length ? conds.join(' AND ') : '1=1', args }
}

function buildFpWhere(filters = {}) {
  const conds = []
  const args = []
  if (filters.host) { conds.push('host = ?'); args.push(String(filters.host)) }
  if (filters.tech) { conds.push('tech LIKE ?'); args.push(`%${filters.tech}%`) }
  if (filters.program_id) { conds.push('program_id = ?'); args.push(String(filters.program_id)) }
  return { where: conds.length ? conds.join(' AND ') : '1=1', args }
}

function orderClause(map, sort, dir, dflt) {
  const col = map[sort] || dflt
  const dr = String(dir || '').toLowerCase() === 'asc' ? 'ASC' : 'DESC'
  return `${col} ${dr}`
}

export function createAssetSqliteBackend(_opts = {}) {
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
