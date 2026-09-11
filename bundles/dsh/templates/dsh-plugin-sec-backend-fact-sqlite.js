// ==============================================================================
// @silksec/sec-backend-fact-sqlite — fact 域 sqlite-local 后端（repository-v1）
//
// 契约：doc/secagent/v5/06-fact.md §2.1/§2.4（后端适配器 + 数据模型）
//
// 职责：直接接管现表 facts / fact_edges / blackboard（asset-graph.db，WAL，不改名不迁库）；
// ensureCol 幂等列演进（facts.uses / facts.last_used_at + lifecycle/expiry 索引）；
// facts_archive / blackboard_archive 归档表（C7 fact_transition 单事务复制+删除）。
// 不含业务校验（域命令负责校验）；生命周期列已由域命令算好，本后端只落库。
//
// 事务边界：总线 CommandGateway 的 BEGIN IMMEDIATE 承担——所有写原语在网关事务内执行。
// ==============================================================================

import { DatabaseSync } from 'node:sqlite'

export const name = '@silksec/sec-backend-fact-sqlite'
export const version = '1.0.0'
export const repositoryV1 = 'repository-v1'

const FACTS_DDL = `
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
  mem_class TEXT,
  status TEXT DEFAULT 'active',
  status_at INTEGER,
  scope TEXT,
  expires_at INTEGER,
  revalidate_by INTEGER,
  justification TEXT,
  last_validated_at INTEGER,
  PRIMARY KEY (program_id, fact_key)
)`

const EDGES_DDL = `
CREATE TABLE IF NOT EXISTS fact_edges (
  program_id TEXT NOT NULL,
  src_key TEXT NOT NULL,
  dst_key TEXT NOT NULL,
  edge_type TEXT NOT NULL,
  confidence TEXT,
  PRIMARY KEY (program_id, src_key, dst_key, edge_type)
)`

const BB_DDL = `
CREATE TABLE IF NOT EXISTS blackboard (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at INTEGER,
  mem_class TEXT,
  status TEXT DEFAULT 'active',
  status_at INTEGER,
  scope TEXT,
  expires_at INTEGER,
  justification TEXT
)`

// v5 新增列（ensureCol 幂等）：C8 使用信号计数
const FACTS_V5_COLS = [
  ['uses', 'uses INTEGER DEFAULT 0'],
  ['last_used_at', 'last_used_at INTEGER'],
]

// 列表投影列（06-fact §1.4 fact_search 返回索引行，不含 body）
const FACT_LIST_COLS = 'program_id, fact_key, category, summary, confidence, pinned, related_finding_id, source, updated_at, mem_class, status, status_at, scope, expires_at, revalidate_by, last_validated_at, uses, last_used_at'

const FACT_SORT = {
  updated_at: 'updated_at DESC',
  edge_count: 'edge_count DESC, updated_at DESC',
  category: 'category ASC, updated_at DESC',
}

function ensureCol(db, table, col, ddl) {
  try {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all()
    if (!cols.some((c) => c.name === col)) {
      try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`) } catch (e) {
        if (!/duplicate column/i.test(String(e?.message))) throw e
      }
    }
  } catch (e) {
    process.stderr.write(`[sec-backend-fact-sqlite] ensureCol(${col}) 失败: ${e?.message}\n`)
  }
}

function ensureArchive(db, table) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all()
  db.exec(`CREATE TABLE IF NOT EXISTS ${table}_archive (${cols.map((c) => `${c.name} ${c.type || 'TEXT'}`).join(', ')}, archived_at INTEGER, archive_reason TEXT)`)
  // 幂等补齐：archive 表若早于源表新列创建（如 facts 后加 uses/last_used_at），逐列 ensureCol 同步，否则归档 INSERT 报「no column」
  const archCols = db.prepare(`PRAGMA table_info(${table}_archive)`).all().map((c) => c.name)
  for (const c of cols) {
    if (!archCols.includes(c.name)) {
      try { db.exec(`ALTER TABLE ${table}_archive ADD COLUMN ${c.name} ${c.type || 'TEXT'}`) } catch (e) {
        if (!/duplicate column/i.test(String(e?.message))) throw e
      }
    }
  }
}

function createRepo(db) {
  db.exec(FACTS_DDL)
  db.exec(EDGES_DDL)
  db.exec(BB_DDL)
  for (const [col, ddl] of FACTS_V5_COLS) ensureCol(db, 'facts', col, ddl)
  ensureArchive(db, 'facts')
  ensureArchive(db, 'blackboard')
  db.exec('CREATE INDEX IF NOT EXISTS idx_facts_program ON facts(program_id)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_facts_lifecycle ON facts(mem_class, status, revalidate_by)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_facts_expiry ON facts(mem_class, expires_at)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_edges_src ON fact_edges(program_id, src_key)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_edges_dst ON fact_edges(program_id, dst_key)')

  const repo = {
    // ---- facts ----
    getFact(program_id, fact_key) {
      const r = db.prepare('SELECT * FROM facts WHERE program_id = ? AND fact_key = ?').get(String(program_id), String(fact_key))
      return r ? { ...r } : null
    },

    upsertFact(row) {
      const nowTs = row.updated_at ?? Date.now()
      const before = repo.getFact(row.program_id, row.fact_key)
      db.prepare(`
        INSERT INTO facts (program_id, fact_key, category, summary, body, confidence, pinned, related_finding_id, source, updated_at,
          mem_class, status, status_at, scope, expires_at, revalidate_by, justification, last_validated_at, uses, last_used_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (program_id, fact_key) DO UPDATE SET
          category = excluded.category, summary = excluded.summary, body = excluded.body,
          confidence = excluded.confidence, pinned = excluded.pinned,
          related_finding_id = excluded.related_finding_id, source = excluded.source, updated_at = excluded.updated_at,
          mem_class = excluded.mem_class, status = excluded.status, status_at = excluded.status_at, scope = excluded.scope,
          expires_at = excluded.expires_at, revalidate_by = excluded.revalidate_by,
          justification = excluded.justification, last_validated_at = excluded.last_validated_at
      `).run(
        String(row.program_id), String(row.fact_key),
        row.category === undefined || row.category === null ? null : String(row.category),
        row.summary === undefined || row.summary === null ? null : String(row.summary),
        row.body === undefined || row.body === null ? null : String(row.body),
        String(row.confidence || 'tentative'),
        row.pinned ? 1 : 0,
        row.related_finding_id ?? null,
        row.source === undefined || row.source === null ? null : String(row.source),
        nowTs,
        row.mem_class ?? null, row.status ?? 'active', row.status_at ?? nowTs,
        row.scope === undefined || row.scope === null ? null : String(row.scope),
        row.expires_at ?? null, row.revalidate_by ?? null,
        row.justification === undefined || row.justification === null ? null : String(row.justification),
        row.last_validated_at ?? null,
        row.uses ?? 0, row.last_used_at ?? null,
      )
      return { merged: !!before, before, after: repo.getFact(row.program_id, row.fact_key) }
    },

    setFactStatus(program_id, fact_key, status, status_at) {
      const before = repo.getFact(program_id, fact_key)
      const r = db.prepare('UPDATE facts SET status = ?, status_at = ? WHERE program_id = ? AND fact_key = ?')
        .run(String(status), status_at, String(program_id), String(fact_key))
      return { changed: r.changes === 1, before, after: repo.getFact(program_id, fact_key) }
    },

    setFactConfidence(program_id, fact_key, confidence, updated_at) {
      const before = repo.getFact(program_id, fact_key)
      const r = db.prepare('UPDATE facts SET confidence = ?, updated_at = ? WHERE program_id = ? AND fact_key = ?')
        .run(String(confidence), updated_at, String(program_id), String(fact_key))
      return { changed: r.changes === 1, before, after: repo.getFact(program_id, fact_key) }
    },

    // 复验刷新（C5）：last_validated_at + 时效列顺延 + cooling 自愈
    refreshFactValidation(program_id, fact_key, nowTs, newExpiresAt, newRevalidateBy) {
      const before = repo.getFact(program_id, fact_key)
      db.prepare(`UPDATE facts SET last_validated_at = ?, expires_at = ?, revalidate_by = ?, status = 'active', status_at = ?, updated_at = ? WHERE program_id = ? AND fact_key = ?`)
        .run(nowTs, newExpiresAt ?? before?.expires_at ?? null, newRevalidateBy ?? before?.revalidate_by ?? null, nowTs, nowTs, String(program_id), String(fact_key))
      return { changed: !!before, before, after: repo.getFact(program_id, fact_key) }
    },

    recordFactUse(program_id, fact_key, nowTs) {
      const r = db.prepare('UPDATE facts SET uses = COALESCE(uses, 0) + 1, last_used_at = ? WHERE program_id = ? AND fact_key = ?')
        .run(nowTs, String(program_id), String(fact_key))
      return repo.getFact(program_id, fact_key)
    },

    // 归档：复制进 facts_archive + 删主行（单事务）
    archiveFact(program_id, fact_key, reason, archived_at) {
      const row = repo.getFact(program_id, fact_key)
      if (!row) return { changed: false }
      const cols = Object.keys(row)
      db.prepare(`INSERT INTO facts_archive (${cols.join(', ')}, archived_at, archive_reason) VALUES (${cols.map(() => '?').join(', ')}, ?, ?)`)
        .run(...cols.map((c) => row[c]), archived_at, String(reason || ''))
      db.prepare('DELETE FROM facts WHERE program_id = ? AND fact_key = ?').run(String(program_id), String(fact_key))
      return { changed: true, row }
    },

    purgeFactArchives(before_ts) {
      return db.prepare('DELETE FROM facts_archive WHERE archived_at < ?').run(before_ts).changes
    },

    replaceEdge(program_id, src_key, dst_key, edge_type, confidence) {
      const r = db.prepare(`
        INSERT OR REPLACE INTO fact_edges (program_id, src_key, dst_key, edge_type, confidence)
        VALUES (?, ?, ?, ?, ?)
      `).run(String(program_id), String(src_key), String(dst_key), String(edge_type), String(confidence || 'tentative'))
      return { changed: r.changes === 1 }
    },

    listFactsWhere(whereSql, args, order, limit, offset) {
      const orderBy = FACT_SORT[order] || FACT_SORT.updated_at
      const sql = `SELECT ${FACT_LIST_COLS},
        (SELECT COUNT(*) FROM fact_edges e WHERE e.program_id = facts.program_id AND (e.src_key = facts.fact_key OR e.dst_key = facts.fact_key)) AS edge_count
        FROM facts WHERE ${whereSql} ORDER BY pinned DESC, ${orderBy} LIMIT ? OFFSET ?`
      return db.prepare(sql).all(...args, Math.min(Number(limit) || 50, 5000), Math.max(0, Number(offset) || 0)).map((r) => ({ ...r }))
    },

    countFactsWhere(whereSql, args) {
      return db.prepare(`SELECT COUNT(*) AS n FROM facts WHERE ${whereSql}`).get(...args).n
    },

    factAggregates() {
      const byCategory = db.prepare('SELECT category, COUNT(*) AS n FROM facts GROUP BY category ORDER BY n DESC').all().map((r) => ({ ...r }))
      const byConfidence = db.prepare('SELECT confidence, COUNT(*) AS n FROM facts GROUP BY confidence').all().map((r) => ({ ...r }))
      const byMemClass = db.prepare("SELECT COALESCE(mem_class, '未分类') mem_class, COUNT(*) AS n FROM facts GROUP BY COALESCE(mem_class, '未分类') ORDER BY n DESC").all().map((r) => ({ ...r }))
      const byStatus = db.prepare('SELECT status, COUNT(*) AS n FROM facts GROUP BY status').all().map((r) => ({ ...r }))
      const pinned = db.prepare('SELECT COUNT(*) AS n FROM facts WHERE pinned = 1').get().n
      const edges = db.prepare('SELECT COUNT(*) AS n FROM fact_edges').get().n
      const withEdges = db.prepare(`SELECT COUNT(*) AS n FROM facts f WHERE EXISTS (
        SELECT 1 FROM fact_edges e WHERE e.program_id = f.program_id AND (e.src_key = f.fact_key OR e.dst_key = f.fact_key))`).get().n
      return {
        total: db.prepare('SELECT COUNT(*) AS n FROM facts').get().n,
        by_category: byCategory, by_confidence: byConfidence, by_mem_class: byMemClass, by_status: byStatus,
        pinned, edges, with_edges: withEdges,
      }
    },

    factOverviewAggregate() {
      const cats = db.prepare("SELECT category, mem_class, COUNT(*) AS n FROM facts WHERE status = 'active' GROUP BY category, mem_class").all().map((r) => ({ ...r }))
      const byCategory = {}
      for (const r of cats) {
        byCategory[r.category || '(空)'] = byCategory[r.category || '(空)'] || { total: 0, durable: 0, ephemeral: 0 }
        byCategory[r.category || '(空)'].total += r.n
        if (r.mem_class === 'ephemeral') byCategory[r.category || '(空)'].ephemeral += r.n
        else byCategory[r.category || '(空)'].durable += r.n
      }
      const active = db.prepare("SELECT COUNT(*) AS n FROM facts WHERE status = 'active'").get().n
      const boardActive = db.prepare("SELECT COUNT(*) AS n FROM blackboard WHERE status = 'active'").get().n
      const envIssues = db.prepare("SELECT COUNT(*) AS n FROM blackboard WHERE status = 'active' AND key LIKE '[env-issue]%'").get().n
      let fgsPersisted = 0
      try { fgsPersisted = db.prepare("SELECT COUNT(*) AS n FROM facts WHERE fact_key LIKE 'fgs/%'").get().n } catch { fgsPersisted = 0 }
      return { byCategory, total: active, blackboard: { active: boardActive, env_issues: envIssues }, fgs_persisted: fgsPersisted }
    },

    listEdges(program_id, fact_key) {
      const out = db.prepare('SELECT dst_key, edge_type, confidence FROM fact_edges WHERE program_id = ? AND src_key = ?').all(String(program_id), String(fact_key)).map((r) => ({ ...r }))
      const inc = db.prepare('SELECT src_key, edge_type, confidence FROM fact_edges WHERE program_id = ? AND dst_key = ?').all(String(program_id), String(fact_key)).map((r) => ({ ...r }))
      return { out, in: inc }
    },

    listAllFactsForReindex(program_id) {
      return db.prepare('SELECT fact_key, summary, body FROM facts WHERE program_id = ?').all(String(program_id)).map((r) => ({ ...r }))
    },

    // ---- blackboard ----
    getBb(key) {
      const r = db.prepare('SELECT * FROM blackboard WHERE key = ?').get(String(key))
      return r ? { ...r } : null
    },

    upsertBb(row) {
      const nowTs = row.updated_at ?? Date.now()
      const before = repo.getBb(row.key)
      db.prepare(`INSERT INTO blackboard (key, value, updated_at, mem_class, status, status_at, scope, expires_at, justification)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at,
          mem_class = excluded.mem_class, status = excluded.status, status_at = excluded.status_at,
          scope = excluded.scope, expires_at = excluded.expires_at, justification = excluded.justification`)
        .run(String(row.key), String(row.value ?? ''), nowTs, row.mem_class ?? null, row.status ?? 'active', row.status_at ?? nowTs,
          row.scope === undefined || row.scope === null ? null : String(row.scope), row.expires_at ?? null,
          row.justification === undefined || row.justification === null ? null : String(row.justification))
      return { merged: !!before, before, after: repo.getBb(row.key) }
    },

    setBbStatus(key, status, at) {
      const r = db.prepare('UPDATE blackboard SET status = ?, status_at = ? WHERE key = ?').run(String(status), at, String(key))
      return { changed: r.changes === 1 }
    },

    listBbRecent(limit) {
      return db.prepare('SELECT * FROM blackboard ORDER BY updated_at DESC LIMIT ?').all(Math.min(Number(limit) || 100, 100)).map((r) => ({ ...r }))
    },

    archiveBb(key, reason, archived_at) {
      const row = repo.getBb(key)
      if (!row) return { changed: false }
      const cols = Object.keys(row)
      db.prepare(`INSERT INTO blackboard_archive (${cols.join(', ')}, archived_at, archive_reason) VALUES (${cols.map(() => '?').join(', ')}, ?, ?)`)
        .run(...cols.map((c) => row[c]), archived_at, String(reason || ''))
      db.prepare('DELETE FROM blackboard WHERE key = ?').run(String(key))
      return { changed: true, row }
    },

    purgeBbArchives(before_ts) {
      return db.prepare('DELETE FROM blackboard_archive WHERE archived_at < ?').run(before_ts).changes
    },
  }
  return repo
}

const _cache = new WeakMap()

export function createFactSqliteBackend(_opts = {}) {
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
