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
  return db
}

const now = () => Date.now()

// node:sqlite 返回 null-prototype 对象，DSH 工具输出要求无损 JSON——统一转普通对象
const plain = (rows) => rows.map((r) => ({ ...r }))

export function upsertAsset({ host, type = 'host', source = '', attrs = null }) {
  if (!host) return false
  getDb().prepare(`
    INSERT INTO assets (host, type, source, attrs, first_seen, last_seen)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (host, type) DO UPDATE SET last_seen = excluded.last_seen,
      source = CASE WHEN excluded.source != '' THEN excluded.source ELSE assets.source END
  `).run(host, type, source, attrs ? JSON.stringify(attrs) : null, now(), now())
  return true
}

export function upsertEndpoint({ host, method = 'GET', path: p = '/', status = '', source = '' }) {
  if (!host || !p) return false
  getDb().prepare(`
    INSERT INTO endpoints (host, method, path, status, source, first_seen, last_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (host, method, path) DO UPDATE SET last_seen = excluded.last_seen,
      status = CASE WHEN excluded.status != '' THEN excluded.status ELSE endpoints.status END
  `).run(host, method.toUpperCase(), p, String(status), source, now(), now())
  return true
}

export function addFinding({ title, severity = 'info', host = '', url = '', evidence = '', source = '' }) {
  const fingerprint = crypto.createHash('sha1').update(`${host}|${title}|${url}`).digest('hex')
  const d = getDb()
  const dup = d.prepare('SELECT id, status FROM findings WHERE fingerprint = ?').get(fingerprint)
  if (dup) return { id: dup.id, dup: true, status: dup.status }
  const r = d.prepare(`
    INSERT INTO findings (fingerprint, title, severity, host, url, evidence, source, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'new', ?)
  `).run(fingerprint, title, severity, host, url, evidence, source, now())
  return { id: Number(r.lastInsertRowid), dup: false }
}

export function queryAssets({ hostLike = '', type = '', limit = 50 }) {
  let sql = 'SELECT host, type, source, last_seen FROM assets WHERE 1=1'
  const args = []
  if (hostLike) { sql += ' AND host LIKE ?'; args.push(`%${hostLike}%`) }
  if (type) { sql += ' AND type = ?'; args.push(type) }
  sql += ' ORDER BY last_seen DESC LIMIT ?'
  args.push(Math.min(limit, 200))
  return plain(getDb().prepare(sql).all(...args))
}

export function queryEndpoints({ host = '', pathLike = '', limit = 50 }) {
  let sql = 'SELECT host, method, path, status, source, last_seen FROM endpoints WHERE 1=1'
  const args = []
  if (host) { sql += ' AND host = ?'; args.push(host) }
  if (pathLike) { sql += ' AND path LIKE ?'; args.push(`%${pathLike}%`) }
  sql += ' ORDER BY last_seen DESC LIMIT ?'
  args.push(Math.min(limit, 200))
  return plain(getDb().prepare(sql).all(...args))
}

export function queryFindings({ host = '', severity = '', status = '', limit = 50 }) {
  let sql = 'SELECT id, title, severity, host, url, evidence, source, status, created_at FROM findings WHERE 1=1'
  const args = []
  if (host) { sql += ' AND host = ?'; args.push(host) }
  if (severity) { sql += ' AND severity = ?'; args.push(severity) }
  if (status) { sql += ' AND status = ?'; args.push(status) }
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
    assets_by_type: byType, findings_by_severity: bySev,
  }
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
