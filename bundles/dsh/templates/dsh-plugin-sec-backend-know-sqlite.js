// ==============================================================================
// @silksec/sec-backend-know-sqlite — know 域 sqlite 子仓后端（exp/kb，repository-v1）
//
// 契约：doc/secagent/v5/07-know.md §2.1/§2.4（数据模型 + 后端适配器）
//
// 职责：直接接管现表 exp_cards / exp_embeddings / exp_feedback / kb_docs / kb_fts /
// kb_embeddings / kb_archive / exp_archive（asset-graph.db，WAL，不改名不迁库）；
// 保留现表列名（exp_store 逻辑名 = 现表 exp_cards；doc_id = id；body_path = file）。
// 不含业务校验（域命令负责）；embedding 比对/评分由域命令层完成，本后端只提供原语。
// ==============================================================================

import { DatabaseSync } from 'node:sqlite'

export const name = '@silksec/sec-backend-know-sqlite'
export const version = '1.0.0'
export const repositoryV1 = 'repository-v1'

function ensureCol(db, table, col, ddl) {
  try {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all()
    if (!cols.some((c) => c.name === col)) {
      try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`) } catch (e) {
        if (!/duplicate column/i.test(String(e?.message))) throw e
      }
    }
  } catch (e) {
    process.stderr.write(`[sec-backend-know-sqlite] ensureCol(${col}) 失败: ${e?.message}\n`)
  }
}

function ensureArchive(db, table) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all()
  db.exec(`CREATE TABLE IF NOT EXISTS ${table}_archive (${cols.map((c) => `${c.name} ${c.type || 'TEXT'}`).join(', ')}, archived_at INTEGER, archive_reason TEXT)`)
  // 幂等补齐：archive 表若早于源表新列创建（如 exp_cards 后加 kind/runs/successes/exportable），逐列 ensureCol 同步
  const archCols = db.prepare(`PRAGMA table_info(${table}_archive)`).all().map((c) => c.name)
  for (const c of cols) {
    if (!archCols.includes(c.name)) {
      try { db.exec(`ALTER TABLE ${table}_archive ADD COLUMN ${c.name} ${c.type || 'TEXT'}`) } catch (e) {
        if (!/duplicate column/i.test(String(e?.message))) throw e
      }
    }
  }
}

function hasTable(db, t) {
  return db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name=?").get(t) !== undefined
}

function createRepo(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS exp_cards (
    id INTEGER PRIMARY KEY AUTOINCREMENT, scenario TEXT NOT NULL, takeaway TEXT NOT NULL, chain TEXT,
    attempts TEXT, evidence TEXT, source TEXT NOT NULL DEFAULT '实战', confidence TEXT NOT NULL DEFAULT 'medium',
    created_at INTEGER NOT NULL, last_validated_at INTEGER NOT NULL, kind TEXT NOT NULL DEFAULT 'card'
  )`)
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS exp_fts USING fts5(scenario, takeaway, chain, content='exp_cards', content_rowid='id')`)
  db.exec(`CREATE TABLE IF NOT EXISTS kb_docs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, file TEXT NOT NULL, source_url TEXT,
    tainted INTEGER DEFAULT 0, imported_at INTEGER NOT NULL
  )`)
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS kb_fts USING fts5(title, body)`)
  db.exec(`CREATE TABLE IF NOT EXISTS exp_embeddings (card_id INTEGER PRIMARY KEY, vec TEXT NOT NULL)`)
  db.exec(`CREATE TABLE IF NOT EXISTS kb_embeddings (doc_id INTEGER PRIMARY KEY, vec TEXT NOT NULL)`)
  db.exec(`CREATE TABLE IF NOT EXISTS exp_feedback (id INTEGER PRIMARY KEY AUTOINCREMENT, card_id INTEGER, verdict TEXT, note TEXT, ts INTEGER, source TEXT)`)
  db.exec(`CREATE TABLE IF NOT EXISTS playbooks (name TEXT PRIMARY KEY, scenario TEXT, chain TEXT, runs INTEGER NOT NULL DEFAULT 0, successes INTEGER NOT NULL DEFAULT 0, avg_duration_ms INTEGER NOT NULL DEFAULT 0, last_run_at INTEGER)`)

  // 生命周期/评分/合并列（v4.6/v4.7 已加，幂等补齐）
  const expCols = ['mem_class', 'status', 'status_at', 'scope', 'justification', 'uses', 'adopted', 'pos_fb', 'neg_fb', 'score', 'last_used_at', 'exportable', 'runs', 'successes', 'tags', 'deviation']
  for (const [col, ddl] of [
    ['mem_class', 'TEXT'], ['status', "TEXT DEFAULT 'active'"], ['status_at', 'INTEGER'], ['scope', 'TEXT'],
    ['justification', 'TEXT'], ['uses', 'INTEGER DEFAULT 0'], ['adopted', 'INTEGER DEFAULT 0'], ['pos_fb', 'INTEGER DEFAULT 0'],
    ['neg_fb', 'INTEGER DEFAULT 0'], ['score', 'REAL DEFAULT 0'], ['last_used_at', 'INTEGER'], ['exportable', 'INTEGER DEFAULT 0'],
    ['runs', 'INTEGER DEFAULT 0'], ['successes', 'INTEGER DEFAULT 0'], ['tags', 'TEXT'], ['deviation', 'TEXT'],
  ]) ensureCol(db, 'exp_cards', col, `${col} ${ddl}`)
  for (const [col, ddl] of [
    ['mem_class', 'TEXT'], ['status', "TEXT DEFAULT 'active'"], ['status_at', 'INTEGER'], ['scope', 'TEXT'],
    ['revalidate_by', 'INTEGER'], ['justification', 'TEXT'], ['last_validated_at', 'INTEGER'],
    ['uses', 'INTEGER DEFAULT 0'], ['last_used_at', 'INTEGER'],
  ]) ensureCol(db, 'kb_docs', col, `${col} ${ddl}`)
  ensureArchive(db, 'exp_cards')
  ensureArchive(db, 'kb_docs')
  db.exec('CREATE INDEX IF NOT EXISTS idx_exp_status ON exp_cards(status, kind)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_exp_name ON exp_cards(scenario)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_kb_status ON kb_docs(status)')

  const repo = {
    // ---- exp ----
    getExpCard(id) {
      const r = db.prepare('SELECT * FROM exp_cards WHERE id = ?').get(Number(id))
      return r ? { ...r } : null
    },
    findExpByScenario(scenario) {
      const r = db.prepare('SELECT * FROM exp_cards WHERE scenario = ?').get(String(scenario))
      return r ? { ...r } : null
    },
    findExpPlaybookByName(name) {
      return db.prepare("SELECT * FROM exp_cards WHERE kind = 'playbook' AND scenario = ?").get(String(name))
        || db.prepare("SELECT * FROM exp_cards WHERE kind = 'playbook' AND scenario = ?").get(`[playbook] ${name}`)
    },
    insertExpCard(row) {
      const now = Date.now()
      const r = db.prepare(`INSERT INTO exp_cards (scenario, takeaway, chain, attempts, evidence, source, confidence, created_at, last_validated_at, kind, mem_class, status, status_at, scope, justification, tags)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          String(row.scenario), String(row.takeaway), row.chain ?? '[]', row.attempts ?? '[]', row.evidence ?? '[]',
          String(row.source || 'agent'), String(row.confidence || 'high'), now, now, row.kind || 'card',
          row.mem_class ?? 'permanent', row.status ?? 'active', now, row.scope ?? 'global', row.justification ?? '',
          row.tags === undefined ? null : JSON.stringify(row.tags),
        )
      const id = Number(r.lastInsertRowid)
      repo.insertExpFts(id, String(row.scenario), String(row.takeaway), row.chain ?? '[]')
      return { id, created: true }
    },
    updateExpCard(id, fields) {
      const keys = Object.keys(fields)
      if (!keys.length) return repo.getExpCard(id)
      db.prepare(`UPDATE exp_cards SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => fields[k]), Number(id))
      return repo.getExpCard(id)
    },
    insertExpFts(id, scenario, takeaway, chain) {
      // 新卡：rowid 尚未在 exp_fts（external content），纯 INSERT
      db.prepare('INSERT INTO exp_fts (rowid, scenario, takeaway, chain) VALUES (?, ?, ?, ?)').run(Number(id), String(scenario), String(takeaway), String(chain || '[]'))
    },
    upsertExpFts(id, scenario, takeaway, chain) {
      // 既有卡：exp_fts 是 external content（content='exp_cards'），DELETE 会删主表行——
      // 必须用 UPDATE 而非先删后插（kb_fts 才是 standalone 可先删后插）
      db.prepare('UPDATE exp_fts SET scenario = ?, takeaway = ?, chain = ? WHERE rowid = ?').run(String(scenario), String(takeaway), String(chain || '[]'), Number(id))
    },
    appendExpEvidence(id, evidenceArr, takeaway, confidence, source) {
      const cur = repo.getExpCard(id)
      if (!cur) return null
      const merged = [...new Set([...JSON.parse(cur.evidence || '[]'), ...(evidenceArr || [])])]
      const confRank = { high: 3, medium: 2, low: 1 }
      const srcRank = { 'human-verified': 3, '实战': 2, external: 1 }
      const newConf = (confRank[confidence] || 0) > (confRank[cur.confidence] || 0) ? confidence : cur.confidence
      const newSource = (srcRank[source] || 0) > (srcRank[cur.source] || 0) ? source : cur.source
      repo.updateExpCard(id, { evidence: JSON.stringify(merged), confidence: newConf, source: newSource, last_validated_at: Date.now(), takeaway: takeaway ?? cur.takeaway })
      if (takeaway !== undefined) repo.upsertExpFts(id, cur.scenario, takeaway, cur.chain)
      return { merged: merged.length }
    },
    insertExpFeedback(row) {
      db.prepare('INSERT INTO exp_feedback (card_id, verdict, note, ts, source) VALUES (?, ?, ?, ?, ?)')
        .run(Number(row.card_id), String(row.verdict), row.note ?? null, row.ts ?? Date.now(), row.source ?? null)
    },
    recomputeExpScore(id) {
      const r = repo.getExpCard(id)
      if (!r) return null
      const daysSinceValidated = r.last_validated_at ? (Date.now() - r.last_validated_at) / 86400000 : 30
      const score = Math.round(((r.adopted || 0) * 3 + (r.pos_fb || 0) * 2 + (r.uses || 0) * 0.5 - (r.neg_fb || 0) * 5 - Math.min(daysSinceValidated * 0.1, 5)) * 100) / 100
      db.prepare('UPDATE exp_cards SET score = ? WHERE id = ?').run(score, Number(id))
      return score
    },
    replaceExpEmbedding(id, vec) {
      db.prepare('INSERT OR REPLACE INTO exp_embeddings (card_id, vec) VALUES (?, ?)').run(Number(id), JSON.stringify(vec))
    },
    listExpWhere(whereSql, args, order, limit, offset) {
      const sql = `SELECT id, scenario, takeaway, source, confidence, last_validated_at, created_at, status, status_at, mem_class, scope, score, uses, adopted, pos_fb, neg_fb, kind, runs, successes, exportable, tags, deviation FROM exp_cards WHERE ${whereSql} ORDER BY ${order} LIMIT ? OFFSET ?`
      return db.prepare(sql).all(...args, Math.min(Number(limit) || 50, 500), Math.max(0, Number(offset) || 0)).map((r) => ({ ...r }))
    },
    countExpWhere(whereSql, args) {
      return db.prepare(`SELECT COUNT(*) AS n FROM exp_cards WHERE ${whereSql}`).get(...args).n
    },
    ftsSearchExp(query, limit) {
      const out = new Map()
      const terms = String(query).split(/\s+/).filter(Boolean)
      try {
        const rows = db.prepare('SELECT rowid FROM exp_fts WHERE exp_fts MATCH ? LIMIT ?').all(terms.map((t) => `"${t.replace(/"/g, '')}"`).join(' OR '), limit * 2)
        for (const r of rows) out.set(r.rowid, 2)
      } catch { /* MATCH 语法问题走 LIKE */ }
      const likeRows = db.prepare('SELECT rowid FROM exp_fts WHERE scenario LIKE ? OR takeaway LIKE ? OR chain LIKE ? LIMIT ?')
        .all(`%${String(query)}%`, `%${String(query)}%`, `%${String(query)}%`, limit * 2)
      for (const r of likeRows) out.set(r.rowid, (out.get(r.rowid) || 0) + 1)
      return out
    },
    allExpEmbeddings() {
      return db.prepare('SELECT card_id, vec FROM exp_embeddings').all().map((r) => ({ ...r }))
    },
    expAggregates() {
      const one = (sql, ...p) => { try { return db.prepare(sql).get(...p) || {} } catch { return {} } }
      const ec = one("SELECT COUNT(*) n, SUM(CASE WHEN COALESCE(uses,0)=0 THEN 1 ELSE 0 END) zero_use, SUM(CASE WHEN status='cooling' THEN 1 ELSE 0 END) cooling, SUM(CASE WHEN status='deprecated' THEN 1 ELSE 0 END) deprecated, SUM(CASE WHEN exportable=1 THEN 1 ELSE 0 END) exportable FROM exp_cards")
      const kb = one("SELECT COUNT(*) n, SUM(CASE WHEN COALESCE(uses,0)=0 THEN 1 ELSE 0 END) zero_use, SUM(CASE WHEN status='cooling' THEN 1 ELSE 0 END) cooling, SUM(CASE WHEN status='curated' THEN 1 ELSE 0 END) curated, SUM(CASE WHEN tainted=1 THEN 1 ELSE 0 END) tainted, SUM(CASE WHEN status='active' AND revalidate_by IS NOT NULL AND revalidate_by < ? THEN 1 ELSE 0 END) overdue FROM kb_docs", Date.now())
      const avg = one('SELECT AVG(score) a FROM exp_cards')
      return { exp: { total: ec.n || 0, zero_use_30d: ec.zero_use || 0, cooling: ec.cooling || 0, deprecated: ec.deprecated || 0, exportable: ec.exportable || 0, avg_score: Math.round((avg.a || 0) * 100) / 100 }, kb: { total: kb.n || 0, curated: kb.curated || 0, tainted: kb.tainted || 0, cooling: kb.cooling || 0, overdue_revalidate: kb.overdue || 0, zero_use: kb.zero_use || 0 } }
    },
    expRankTop(limit = 5) {
      return db.prepare("SELECT id, scenario, takeaway, score, adopted, status FROM exp_cards WHERE kind != 'playbook' AND mem_class = 'permanent' AND status = 'active' ORDER BY score DESC LIMIT ?").all(limit).map((r) => ({ ...r }))
    },
    pbRankTop() {
      const rows = db.prepare("SELECT id, scenario, takeaway, chain, runs, successes, last_validated_at FROM exp_cards WHERE kind = 'playbook'").all().map((p) => {
        const rate = p.runs ? p.successes / p.runs : 0
        const ageDays = p.last_validated_at ? (Date.now() - p.last_validated_at) / 86400000 : 999
        const decay = Math.max(0.3, 1 - ageDays * 0.02)
        return { id: p.id, name: p.scenario, chain: JSON.parse(p.chain || '[]'), runs: p.runs, successes: p.successes, success_rate: Math.round(rate * 100) / 100, score: Math.round(rate * decay * 100) / 100 }
      }).sort((x, y) => y.score - x.score)
      return rows
    },
    archiveExp(id, reason, at) {
      const row = repo.getExpCard(id)
      if (!row) return { changed: false }
      const cols = Object.keys(row)
      db.prepare(`INSERT INTO exp_cards_archive (${cols.join(', ')}, archived_at, archive_reason) VALUES (${cols.map(() => '?').join(', ')}, ?, ?)`)
        .run(...cols.map((c) => row[c]), at, String(reason || ''))
      db.prepare('DELETE FROM exp_cards WHERE id = ?').run(Number(id))
      try { db.prepare('DELETE FROM exp_fts WHERE rowid = ?').run(Number(id)); db.prepare('DELETE FROM exp_embeddings WHERE card_id = ?').run(Number(id)) } catch { /* noop */ }
      return { changed: true }
    },
    purgeExpArchives(before) { return db.prepare('DELETE FROM exp_cards_archive WHERE archived_at < ?').run(before).changes },

    // ---- kb ----
    getKbDoc(doc_id) {
      const r = db.prepare('SELECT * FROM kb_docs WHERE id = ?').get(Number(doc_id))
      return r ? { ...r } : null
    },
    findKbByUrl(url) {
      const r = db.prepare('SELECT * FROM kb_docs WHERE source_url = ?').get(String(url))
      return r ? { ...r } : null
    },
    insertKbDoc(row) {
      const now = Date.now()
      const r = db.prepare(`INSERT INTO kb_docs (title, file, source_url, tainted, imported_at, mem_class, status, status_at, scope, revalidate_by, justification, last_validated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(String(row.title), String(row.file), row.source_url ?? null, row.tainted ? 1 : 0, now,
          row.mem_class ?? 'durable', row.status ?? 'active', now, row.scope ?? 'global', row.revalidate_by ?? null, row.justification ?? '', row.last_validated_at ?? now)
      const id = Number(r.lastInsertRowid)
      repo.upsertKbFts(id, String(row.title), String(row.bodyExcerpt || ''))
      return { id, created: true }
    },
    updateKbDoc(doc_id, fields) {
      const keys = Object.keys(fields)
      if (!keys.length) return repo.getKbDoc(doc_id)
      db.prepare(`UPDATE kb_docs SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => fields[k]), Number(doc_id))
      return repo.getKbDoc(doc_id)
    },
    upsertKbFts(doc_id, title, bodyExcerpt) {
      db.prepare('DELETE FROM kb_fts WHERE rowid = ?').run(Number(doc_id))
      db.prepare('INSERT INTO kb_fts (rowid, title, body) VALUES (?, ?, ?)').run(Number(doc_id), String(title), String(bodyExcerpt).slice(0, 100000))
    },
    deleteKbFts(doc_id) { db.prepare('DELETE FROM kb_fts WHERE rowid = ?').run(Number(doc_id)) },
    replaceKbEmbedding(doc_id, vec) { db.prepare('INSERT OR REPLACE INTO kb_embeddings (doc_id, vec) VALUES (?, ?)').run(Number(doc_id), JSON.stringify(vec)) },
    listKbWhere(whereSql, args, limit, offset) {
      const sql = `SELECT id, title, file, source_url, tainted, imported_at, status, status_at, uses, revalidate_by, last_validated_at, mem_class FROM kb_docs WHERE ${whereSql} ORDER BY (status = 'curated') DESC, uses DESC, imported_at DESC LIMIT ? OFFSET ?`
      return db.prepare(sql).all(...args, Math.min(Number(limit) || 50, 500), Math.max(0, Number(offset) || 0)).map((r) => ({ ...r, curated: r.status === 'curated' ? 1 : 0 }))
    },
    countKbWhere(whereSql, args) { return db.prepare(`SELECT COUNT(*) AS n FROM kb_docs WHERE ${whereSql}`).get(...args).n },
    ftsSearchKb(query, limit) {
      const out = new Map()
      try {
        const rows = db.prepare('SELECT rowid FROM kb_fts WHERE kb_fts MATCH ? LIMIT ?').all(String(query).split(/\s+/).map((t) => `"${t.replace(/"/g, '')}"`).join(' OR '), limit * 2)
        for (const r of rows) out.set(r.rowid, 2)
      } catch { /* noop */ }
      const like = db.prepare('SELECT rowid FROM kb_fts WHERE title LIKE ? OR body LIKE ? LIMIT ?').all(`%${String(query)}%`, `%${String(query)}%`, limit * 2)
      for (const r of like) out.set(r.rowid, (out.get(r.rowid) || 0) + 1)
      return out
    },
    allKbEmbeddings() { return db.prepare('SELECT doc_id, vec FROM kb_embeddings').all().map((r) => ({ ...r })) },
    kbCounts() {
      const one = (sql) => { try { return db.prepare(sql).get() || {} } catch { return {} } }
      return {
        curated: one("SELECT COUNT(*) AS n FROM kb_docs WHERE status = 'curated' AND status != 'archived'").n || 0,
        external: one("SELECT COUNT(*) AS n FROM kb_docs WHERE status != 'curated' AND status != 'archived'").n || 0,
        tainted: one('SELECT COUNT(*) AS n FROM kb_docs WHERE tainted = 1').n || 0,
        zero_use: one("SELECT COUNT(*) AS n FROM kb_docs WHERE status != 'curated' AND (uses IS NULL OR uses = 0)").n || 0,
      }
    },
    archiveKb(doc_id, reason, at) {
      const row = repo.getKbDoc(doc_id)
      if (!row) return { changed: false }
      const cols = Object.keys(row)
      db.prepare(`INSERT INTO kb_docs_archive (${cols.join(', ')}, archived_at, archive_reason) VALUES (${cols.map(() => '?').join(', ')}, ?, ?)`)
        .run(...cols.map((c) => row[c]), at, String(reason || ''))
      db.prepare('DELETE FROM kb_docs WHERE id = ?').run(Number(doc_id))
      try { db.prepare('DELETE FROM kb_fts WHERE rowid = ?').run(Number(doc_id)); db.prepare('DELETE FROM kb_embeddings WHERE doc_id = ?').run(Number(doc_id)) } catch { /* noop */ }
      return { changed: true }
    },
    purgeKbArchives(before) { return db.prepare('DELETE FROM kb_docs_archive WHERE archived_at < ?').run(before).changes },
  }
  return repo
}

const _cache = new WeakMap()

export function createKnowSqliteBackend(_opts = {}) {
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
