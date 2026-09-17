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

  // L1（2026-09-16 学习专项 §3.1）：learning_episodes 执行学习记录（幂等建表）。
  // 去重双闸：UNIQUE(source_event_id, consumer_version)（事件回放零重复记功，保留期=表本身，不依赖总线 7 天幂等缓存）
  // + 部分唯一索引 biz_key（业务归因：program|来源事件名|exec_run|attempt|card_version）。
  db.exec(`CREATE TABLE IF NOT EXISTS learning_episodes (
    episode_id TEXT PRIMARY KEY,
    schema_version INTEGER NOT NULL DEFAULT 1,
    source_event_id TEXT NOT NULL,
    source_event_name TEXT NOT NULL,
    consumer_version TEXT NOT NULL,
    program_id TEXT, task_id INTEGER, exec_run_id TEXT, attempt_id TEXT, session_id TEXT,
    card_id TEXT, card_version TEXT, model_id TEXT,
    outcome TEXT NOT NULL, reason_code TEXT,
    evidence_refs TEXT, fgs_snapshot_hash TEXT, fgs_snapshot_summary TEXT, fgs_snapshot_path TEXT,
    request_count INTEGER, token_count INTEGER, duration_ms INTEGER,
    source_credibility TEXT, supersedes TEXT,
    context_json TEXT, biz_key TEXT,
    observed_at INTEGER, created_at INTEGER NOT NULL,
    UNIQUE(source_event_id, consumer_version)
  )`)
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_episode_biz ON learning_episodes(biz_key) WHERE biz_key IS NOT NULL`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_episode_program ON learning_episodes(program_id, created_at)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_episode_outcome ON learning_episodes(outcome)`)

  // L2（2026-09-17 学习专项 §3.1/§6.1）：knowledge_revisions 候选知识版本（幂等建表）。
  // 只插不改内容——UNIQUE(artifact_kind, artifact_id, content_digest) 内容级去重：
  // 同参重放不产生新 revision；内容变化必出新行（旧行原样保留，published 冻结的根基）。
  // 流程列（status/needs_revalidate/eval_report_ref）允许 UPDATE；内容列禁原地覆盖（域命令层守卫）。
  db.exec(`CREATE TABLE IF NOT EXISTS knowledge_revisions (
    revision_id TEXT PRIMARY KEY,
    schema_version INTEGER NOT NULL DEFAULT 1,
    artifact_kind TEXT NOT NULL,
    artifact_id TEXT NOT NULL,
    parent_revision_id TEXT,
    content_json TEXT NOT NULL,
    content_digest TEXT NOT NULL,
    source_kind TEXT NOT NULL,
    source_ref TEXT NOT NULL,
    source_snapshot TEXT,
    applies_predicates TEXT,
    status TEXT NOT NULL DEFAULT 'candidate',
    needs_revalidate INTEGER NOT NULL DEFAULT 0,
    eval_report_ref TEXT,
    change_note TEXT,
    created_by_actor TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE(artifact_kind, artifact_id, content_digest)
  )`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_revision_artifact ON knowledge_revisions(artifact_kind, artifact_id, created_at)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_revision_source ON knowledge_revisions(source_kind, source_ref)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_revision_status ON knowledge_revisions(status)`)

  // L4（2026-09-17 学习专项 §6.2/§6.3）：know_releases 发布账本（受控晋升/有限灰度/回退）。
  // 发布为新 release 行，不原地改旧版本；同 (artifact, scope) 任一时刻至多一条 active（部分唯一索引强约束）。
  // 回退 = 撤销当前 release（status→revoked）+ 恢复最近一条同 scope 的 revoked/superseded release 为 active。
  db.exec(`CREATE TABLE IF NOT EXISTS know_releases (
    release_id TEXT PRIMARY KEY,
    artifact_kind TEXT NOT NULL,
    artifact_id TEXT NOT NULL,
    revision_id TEXT NOT NULL,
    content_digest TEXT NOT NULL,
    scope_type TEXT NOT NULL,
    scope_id TEXT NOT NULL DEFAULT '',
    auth_ref TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    reason TEXT,
    created_by_actor TEXT,
    created_at INTEGER NOT NULL,
    revoked_at INTEGER,
    revoke_reason TEXT
  )`)
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_release_active ON know_releases(artifact_kind, artifact_id, scope_type, scope_id) WHERE status='active'`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_release_artifact ON know_releases(artifact_kind, artifact_id, created_at)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_release_revision ON know_releases(revision_id)`)

  // L5（2026-09-17 学习专项 §8.1/§3.1 检索与反馈投影）：曝光/采用/计分/缺口四表（幂等建表）。
  // 事实行只追加不改（编辑/撤回=新行或 tombstone）；计分投影可重建（know_scores 可从三族不可变事实重放重建）。
  // know_exposures：检索命中 → 实际展示的曝光回执（宿主补发；查询本身纯读）。
  db.exec(`CREATE TABLE IF NOT EXISTS know_exposures (
    exposure_id TEXT PRIMARY KEY,
    program_id TEXT, q TEXT, artifact_kind TEXT, artifact_id TEXT,
    artifact_version TEXT, rank INTEGER, selected INTEGER NOT NULL DEFAULT 1,
    reason TEXT, caller_actor TEXT, session_id TEXT, cost_json TEXT,
    bucket INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    UNIQUE(program_id, q, artifact_kind, artifact_id, artifact_version, session_id, bucket)
  )`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_exposure_artifact ON know_exposures(artifact_kind, artifact_id, created_at)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_exposure_session ON know_exposures(session_id, created_at)`)
  // 注：bucket=30s 时间桶——同会话同查询同卡同桶去重（刷新不累计曝光），跨桶=新曝光（真实再展示）
  // know_adoptions：采用事实（know_adopt 落账 + ledger.card_usage.logged 事件回流）——与曝光/有效结果分开计数。
  db.exec(`CREATE TABLE IF NOT EXISTS know_adoptions (
    adoption_id TEXT PRIMARY KEY,
    artifact_kind TEXT NOT NULL, artifact_id TEXT NOT NULL,
    revision_id TEXT, card_version TEXT,
    source_event_id TEXT, source_cmd TEXT, program_id TEXT,
    actor TEXT, outcome TEXT, note TEXT,
    created_at INTEGER NOT NULL
  )`)
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_adoption_event ON know_adoptions(source_event_id) WHERE source_event_id IS NOT NULL`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_adoption_artifact ON know_adoptions(artifact_kind, artifact_id, created_at)`)
  // know_feedback：原生反馈桥落账（DSH canonical Session 反馈 → 本地事实行；feedback id + revision 幂等；
  // 编辑=新 revision 行覆盖有效投影，撤回=tombstone 行撤销派生分数；模型自评不从此表进已验证正例）。
  db.exec(`CREATE TABLE IF NOT EXISTS know_feedback (
    feedback_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    session_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    rating TEXT, category TEXT, note TEXT,
    tombstone INTEGER NOT NULL DEFAULT 0,
    attribution_json TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (feedback_id, revision)
  )`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_feedback_session ON know_feedback(session_id, created_at)`)
  // know_scores：计分投影（效果与成本而非 uses 榜单；可整体/按 artifact 重放重建——重算不改历史行）。
  db.exec(`CREATE TABLE IF NOT EXISTS know_scores (
    artifact_kind TEXT NOT NULL, artifact_id TEXT NOT NULL,
    exposures INTEGER NOT NULL DEFAULT 0,
    adoptions INTEGER NOT NULL DEFAULT 0,
    verified_positives INTEGER NOT NULL DEFAULT 0,
    valid_cleans INTEGER NOT NULL DEFAULT 0,
    inconclusives INTEGER NOT NULL DEFAULT 0,
    inapplicables INTEGER NOT NULL DEFAULT 0,
    blocked INTEGER NOT NULL DEFAULT 0,
    infra_errors INTEGER NOT NULL DEFAULT 0,
    feedback_pos INTEGER NOT NULL DEFAULT 0,
    feedback_neg INTEGER NOT NULL DEFAULT 0,
    feedback_pending INTEGER NOT NULL DEFAULT 0,
    cost_requests INTEGER NOT NULL DEFAULT 0,
    cost_tokens INTEGER NOT NULL DEFAULT 0,
    cost_ms INTEGER NOT NULL DEFAULT 0,
    score REAL NOT NULL DEFAULT 0,
    sample_size INTEGER NOT NULL DEFAULT 0,
    build_tag TEXT,
    rebuilt_at INTEGER NOT NULL,
    PRIMARY KEY (artifact_kind, artifact_id)
  )`)
  // know_gaps：检索 miss/低覆盖登记（补建走 know_revision_propose 候选通道，不直写使用面）。
  db.exec(`CREATE TABLE IF NOT EXISTS know_gaps (
    gap_id TEXT PRIMARY KEY,
    program_id TEXT, q TEXT, surface TEXT,
    hits INTEGER NOT NULL DEFAULT 0,
    backfill_revision_id TEXT,
    caller_actor TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE(program_id, q, surface)
  )`)

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
    // L0（2026-09-16 学习专项）：kb 分类/失败计数/内容修订列（07-know §kb_docs 表已声明，此前缺列）
    ['category', 'TEXT'], ['fetch_failures', 'INTEGER DEFAULT 0'], ['last_fetch_error', 'TEXT'],
    ['body_revision', 'INTEGER DEFAULT 1'], ['content_hash', 'TEXT'],
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
      const previous = repo.getExpCard(id)
      if (!previous) return null
      const indexed = ['scenario', 'takeaway', 'chain'].some((key) => key in fields && fields[key] !== previous[key])
      db.exec('SAVEPOINT know_exp_update')
      try {
        // external-content FTS 必须用变更前的文本移除旧词；先改主表会读到新词而留下旧倒排项。
        if (indexed) db.prepare("INSERT INTO exp_fts(exp_fts,rowid,scenario,takeaway,chain) VALUES ('delete',?,?,?,?)")
          .run(Number(id), previous.scenario, previous.takeaway, previous.chain)
        db.prepare(`UPDATE exp_cards SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => fields[k]), Number(id))
        if (indexed) {
          const current = repo.getExpCard(id)
          repo.insertExpFts(id, current.scenario, current.takeaway, current.chain)
        }
        db.exec('RELEASE know_exp_update')
      } catch (error) {
        db.exec('ROLLBACK TO know_exp_update; RELEASE know_exp_update')
        throw error
      }
      return repo.getExpCard(id)
    },
    insertExpFts(id, scenario, takeaway, chain) {
      // 新卡：rowid 尚未在 exp_fts（external content），纯 INSERT
      db.prepare('INSERT INTO exp_fts (rowid, scenario, takeaway, chain) VALUES (?, ?, ?, ?)').run(Number(id), String(scenario), String(takeaway), String(chain || '[]'))
    },
    upsertExpFts(id, scenario, takeaway, chain) {
      // 兼容已有调用者，原文与索引由同一事务维护；已经同步的重复调用不会再改索引。
      return repo.updateExpCard(id, { scenario: String(scenario), takeaway: String(takeaway), chain: String(chain || '[]') })
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
      const kb = one("SELECT COUNT(*) n, SUM(CASE WHEN COALESCE(uses,0)=0 THEN 1 ELSE 0 END) zero_use, SUM(CASE WHEN status='cooling' THEN 1 ELSE 0 END) cooling, SUM(CASE WHEN status='curated' THEN 1 ELSE 0 END) curated, SUM(CASE WHEN tainted=1 THEN 1 ELSE 0 END) tainted, SUM(CASE WHEN status='active' AND revalidate_by IS NOT NULL AND revalidate_by < ? THEN 1 ELSE 0 END) overdue, SUM(CASE WHEN COALESCE(fetch_failures,0)>0 THEN 1 ELSE 0 END) fetch_failed FROM kb_docs", Date.now())
      const avg = one('SELECT AVG(score) a FROM exp_cards')
      return { exp: { total: ec.n || 0, zero_use_30d: ec.zero_use || 0, cooling: ec.cooling || 0, deprecated: ec.deprecated || 0, exportable: ec.exportable || 0, avg_score: Math.round((avg.a || 0) * 100) / 100 }, kb: { total: kb.n || 0, curated: kb.curated || 0, tainted: kb.tainted || 0, cooling: kb.cooling || 0, overdue_revalidate: kb.overdue || 0, zero_use: kb.zero_use || 0, fetch_failed: kb.fetch_failed || 0 } }
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
      db.prepare("INSERT INTO exp_fts(exp_fts,rowid,scenario,takeaway,chain) VALUES ('delete',?,?,?,?)")
        .run(Number(id), row.scenario, row.takeaway, row.chain)
      db.prepare('DELETE FROM exp_cards WHERE id = ?').run(Number(id))
      db.prepare('DELETE FROM exp_embeddings WHERE card_id = ?').run(Number(id))
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
      const r = db.prepare(`INSERT INTO kb_docs (title, file, source_url, tainted, imported_at, mem_class, status, status_at, scope, revalidate_by, justification, last_validated_at, category, content_hash)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(String(row.title), String(row.file), row.source_url ?? null, row.tainted ? 1 : 0, now,
          row.mem_class ?? 'durable', row.status ?? 'active', now, row.scope ?? 'global', row.revalidate_by ?? null, row.justification ?? '', row.last_validated_at ?? now,
          row.category ?? null, row.content_hash ?? null)
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
      const sql = `SELECT id, title, file, source_url, tainted, imported_at, status, status_at, uses, revalidate_by, last_validated_at, mem_class, category, fetch_failures, body_revision FROM kb_docs WHERE ${whereSql} ORDER BY (status = 'curated') DESC, uses DESC, imported_at DESC LIMIT ? OFFSET ?`
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

    // ---- L1 learning_episodes（同一 episode 不覆写；重复事件/业务归因命中唯一约束 → duplicate，不抛错）----
    insertEpisode(row) {
      try {
        db.prepare(`INSERT INTO learning_episodes (
          episode_id, schema_version, source_event_id, source_event_name, consumer_version,
          program_id, task_id, exec_run_id, attempt_id, session_id,
          card_id, card_version, model_id,
          outcome, reason_code,
          evidence_refs, fgs_snapshot_hash, fgs_snapshot_summary, fgs_snapshot_path,
          request_count, token_count, duration_ms,
          source_credibility, supersedes, context_json, biz_key,
          observed_at, created_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(
            row.episode_id, row.schema_version ?? 1, row.source_event_id, row.source_event_name, row.consumer_version,
            row.program_id ?? null, row.task_id ?? null, row.exec_run_id ?? null, row.attempt_id ?? null, row.session_id ?? null,
            row.card_id ?? null, row.card_version ?? null, row.model_id ?? null,
            row.outcome, row.reason_code ?? null,
            row.evidence_refs ?? null, row.fgs_snapshot_hash ?? null, row.fgs_snapshot_summary ?? null, row.fgs_snapshot_path ?? null,
            row.request_count ?? null, row.token_count ?? null, row.duration_ms ?? null,
            row.source_credibility ?? null, row.supersedes ?? null, row.context_json ?? null, row.biz_key ?? null,
            row.observed_at ?? null, row.created_at,
          )
        return { created: true, episode_id: row.episode_id }
      } catch (e) {
        if (!/UNIQUE/i.test(String(e?.message || ''))) throw e
        const dup = db.prepare('SELECT episode_id FROM learning_episodes WHERE source_event_id=? AND consumer_version=?').get(row.source_event_id, row.consumer_version)
        if (dup) return { created: false, duplicate: 'source', episode_id: dup.episode_id }
        const biz = row.biz_key ? db.prepare('SELECT episode_id FROM learning_episodes WHERE biz_key=?').get(row.biz_key) : null
        return { created: false, duplicate: 'biz', episode_id: biz ? biz.episode_id : null }
      }
    },
    getEpisode(episodeId) {
      const r = db.prepare('SELECT * FROM learning_episodes WHERE episode_id=?').get(String(episodeId))
      return r ? { ...r } : null
    },
    listEpisodes({ program_id = '', outcome = '', limit = 50, offset = 0 } = {}) {
      const where = []
      const vals = []
      if (program_id) { where.push('program_id = ?'); vals.push(String(program_id)) }
      if (outcome) { where.push('outcome = ?'); vals.push(String(outcome)) }
      const w = where.length ? `WHERE ${where.join(' AND ')}` : ''
      const total = db.prepare(`SELECT COUNT(*) AS c FROM learning_episodes ${w}`).get(...vals).c
      const rows = db.prepare(`SELECT * FROM learning_episodes ${w} ORDER BY created_at DESC, episode_id DESC LIMIT ? OFFSET ?`).all(...vals, limit, offset)
      return { rows, total }
    },
    // L6（设计 §10 证据对照）：按卡反查 episode（一次学习 → 实际结果的追溯链起点）
    listEpisodesByCard(cardId, limit = 50) {
      const rows = db.prepare('SELECT * FROM learning_episodes WHERE card_id = ? ORDER BY created_at DESC, episode_id DESC LIMIT ?').all(String(cardId), limit)
      return rows.map((r) => ({ ...r }))
    },

    // ---- L2 knowledge_revisions（内容只插不改；命中内容级唯一约束 → 复用原 revision，不抛错）----
    insertRevision(row) {
      try {
        db.prepare(`INSERT INTO knowledge_revisions (
          revision_id, schema_version, artifact_kind, artifact_id, parent_revision_id,
          content_json, content_digest, source_kind, source_ref, source_snapshot,
          applies_predicates, status, needs_revalidate, eval_report_ref,
          change_note, created_by_actor, created_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(
            row.revision_id, row.schema_version ?? 1, row.artifact_kind, row.artifact_id, row.parent_revision_id ?? null,
            row.content_json, row.content_digest, row.source_kind, row.source_ref, row.source_snapshot ?? null,
            row.applies_predicates ?? null, row.status ?? 'candidate', row.needs_revalidate ?? 0, row.eval_report_ref ?? null,
            row.change_note ?? null, row.created_by_actor ?? null, row.created_at,
          )
        return { created: true, revision_id: row.revision_id }
      } catch (e) {
        if (!/UNIQUE/i.test(String(e?.message || ''))) throw e
        const dup = db.prepare('SELECT revision_id FROM knowledge_revisions WHERE artifact_kind=? AND artifact_id=? AND content_digest=?')
          .get(row.artifact_kind, row.artifact_id, row.content_digest)
        return { created: false, duplicate: 'content', revision_id: dup ? dup.revision_id : null }
      }
    },
    getRevision(revisionId) {
      const r = db.prepare('SELECT * FROM knowledge_revisions WHERE revision_id=?').get(String(revisionId))
      return r ? { ...r } : null
    },
    getRevisionByArtifactDigest(kind, artifactId, digest) {
      const r = db.prepare('SELECT * FROM knowledge_revisions WHERE artifact_kind=? AND artifact_id=? AND content_digest=?').get(String(kind), String(artifactId), String(digest))
      return r ? { ...r } : null
    },
    listRevisions({ artifact_kind = '', artifact_id = '', status = '', needs_revalidate = null, limit = 50, offset = 0 } = {}) {
      const where = []
      const vals = []
      if (artifact_kind) { where.push('artifact_kind = ?'); vals.push(String(artifact_kind)) }
      if (artifact_id) { where.push('artifact_id = ?'); vals.push(String(artifact_id)) }
      if (status) { where.push('status = ?'); vals.push(String(status)) }
      if (needs_revalidate !== null && needs_revalidate !== undefined) { where.push('needs_revalidate = ?'); vals.push(needs_revalidate ? 1 : 0) }
      const w = where.length ? `WHERE ${where.join(' AND ')}` : ''
      const total = db.prepare(`SELECT COUNT(*) AS c FROM knowledge_revisions ${w}`).get(...vals).c
      const rows = db.prepare(`SELECT * FROM knowledge_revisions ${w} ORDER BY created_at DESC, revision_id DESC LIMIT ? OFFSET ?`).all(...vals, limit, offset)
      return { rows, total }
    },
    // 来源变更联动（kb_revalidate(changed)）：依赖该文献版本的 revision 标 needs_revalidate=1，原始引用保留
    markRevisionsNeedRevalidate(sourceKind, sourceRef) {
      return db.prepare('UPDATE knowledge_revisions SET needs_revalidate=1 WHERE source_kind=? AND source_ref=?')
        .run(String(sourceKind), String(sourceRef)).changes
    },
    // L3（C25 know_revision_assess）：流程列更新——只允许 status/eval_report_ref，内容列只插不改的根基不动
    updateRevisionFlow(revisionId, fields) {
      return db.prepare('UPDATE knowledge_revisions SET status=?, eval_report_ref=? WHERE revision_id=?')
        .run(String(fields.status), fields.eval_report_ref ?? null, String(revisionId)).changes
    },

    // ---- L4 know_releases（发布账本：发布为新行，回退为状态翻转，不原地改旧版本内容）----
    insertRelease(row) {
      db.prepare(`INSERT INTO know_releases (
          release_id, artifact_kind, artifact_id, revision_id, content_digest,
          scope_type, scope_id, auth_ref, status, reason, created_by_actor, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(row.release_id, row.artifact_kind, row.artifact_id, row.revision_id, row.content_digest,
          row.scope_type, row.scope_id ?? '', row.auth_ref ?? null, row.status ?? 'active',
          row.reason ?? null, row.created_by_actor ?? null, row.created_at)
      return { created: true, release_id: row.release_id }
    },
    getRelease(releaseId) {
      return db.prepare('SELECT * FROM know_releases WHERE release_id=?').get(String(releaseId)) || null
    },
    // 幂等兜底（总线幂等表过期后的晚到重放/同批准重放）：同批准+同对象+同内容命中即既有发布
    findReleaseByAuth(artifactKind, artifactId, scopeType, scopeId, revisionId, authRef) {
      return db.prepare(`SELECT * FROM know_releases
        WHERE artifact_kind=? AND artifact_id=? AND scope_type=? AND scope_id=? AND revision_id=? AND auth_ref IS ?
        ORDER BY created_at DESC LIMIT 1`)
        .get(String(artifactKind), String(artifactId), String(scopeType), String(scopeId ?? ''), String(revisionId), authRef == null ? null : String(authRef)) || null
    },
    activeRelease(artifactKind, artifactId, scopeType, scopeId) {
      return db.prepare(`SELECT * FROM know_releases
        WHERE artifact_kind=? AND artifact_id=? AND scope_type=? AND scope_id=? AND status='active'`)
        .get(String(artifactKind), String(artifactId), String(scopeType), String(scopeId ?? '')) || null
    },
    countActiveReleasesForRevision(revisionId) {
      return db.prepare(`SELECT COUNT(*) AS c FROM know_releases WHERE revision_id=? AND status='active'`).get(String(revisionId)).c
    },
    setReleaseStatus(releaseId, status, fields = {}) {
      return db.prepare('UPDATE know_releases SET status=?, revoked_at=?, revoke_reason=? WHERE release_id=?')
        .run(String(status), fields.revoked_at ?? null, fields.revoke_reason ?? null, String(releaseId)).changes
    },
    // 回退目标：同 (artifact, scope) 最近一条被取代/撤销的非 active release（排除当前这条）
    previousRelease(artifactKind, artifactId, scopeType, scopeId, excludeReleaseId) {
      return db.prepare(`SELECT * FROM know_releases
        WHERE artifact_kind=? AND artifact_id=? AND scope_type=? AND scope_id=? AND status != 'active' AND release_id != ?
        ORDER BY created_at DESC, release_id DESC LIMIT 1`)
        .get(String(artifactKind), String(artifactId), String(scopeType), String(scopeId ?? ''), String(excludeReleaseId)) || null
    },
    listReleases({ artifact_kind = '', artifact_id = '', scope_type = '', scope_id = null, status = '', limit = 50, offset = 0 } = {}) {
      const conds = []; const vals = []
      if (artifact_kind) { conds.push('artifact_kind=?'); vals.push(String(artifact_kind)) }
      if (artifact_id) { conds.push('artifact_id=?'); vals.push(String(artifact_id)) }
      if (scope_type) { conds.push('scope_type=?'); vals.push(String(scope_type)) }
      if (scope_id !== null && scope_id !== undefined) { conds.push('scope_id=?'); vals.push(String(scope_id)) }
      if (status) { conds.push('status=?'); vals.push(String(status)) }
      const w = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
      const total = db.prepare(`SELECT COUNT(*) AS c FROM know_releases ${w}`).get(...vals).c
      const rows = db.prepare(`SELECT * FROM know_releases ${w} ORDER BY created_at DESC, release_id DESC LIMIT ? OFFSET ?`).all(...vals, limit, offset)
      return { rows, total }
    },

    // ---- L5 know_exposures（曝光回执：检索命中→实际展示，30s 桶去重）----
    insertExposure(row) {
      try {
        db.prepare(`INSERT INTO know_exposures (
            exposure_id, program_id, q, artifact_kind, artifact_id, artifact_version,
            rank, selected, reason, caller_actor, session_id, cost_json, bucket, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(row.exposure_id, row.program_id ?? null, row.q ?? null, row.artifact_kind, row.artifact_id,
            row.artifact_version ?? null, row.rank ?? null, row.selected ? 1 : 0, row.reason ?? null,
            row.caller_actor ?? null, row.session_id ?? null, row.cost_json ?? null,
            row.bucket ?? 0, row.created_at)
        return { created: true }
      } catch (e) {
        if (/UNIQUE/i.test(String(e?.message))) return { created: false, duplicate: 'exposure' }
        throw e
      }
    },
    listExposures({ artifact_kind = '', artifact_id = '', program_id = '', limit = 50, offset = 0 } = {}) {
      const conds = []; const vals = []
      if (artifact_kind) { conds.push('artifact_kind=?'); vals.push(String(artifact_kind)) }
      if (artifact_id) { conds.push('artifact_id=?'); vals.push(String(artifact_id)) }
      if (program_id) { conds.push('program_id=?'); vals.push(String(program_id)) }
      const w = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
      const total = db.prepare(`SELECT COUNT(*) AS c FROM know_exposures ${w}`).get(...vals).c
      const rows = db.prepare(`SELECT * FROM know_exposures ${w} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...vals, limit, offset)
      return { rows, total }
    },
    exposureCount(artifactKind, artifactId) {
      return db.prepare('SELECT COUNT(*) AS c, SUM(selected) AS sel FROM know_exposures WHERE artifact_kind=? AND artifact_id=?')
        .get(String(artifactKind), String(artifactId))
    },
    latestExposureBySession(sessionId) {
      return db.prepare('SELECT * FROM know_exposures WHERE session_id=? ORDER BY created_at DESC LIMIT 1').get(String(sessionId)) || null
    },

    // ---- L5 know_adoptions（采用事实：know_adopt + ledger.card_usage.logged 回流）----
    insertAdoption(row) {
      try {
        db.prepare(`INSERT INTO know_adoptions (
            adoption_id, artifact_kind, artifact_id, revision_id, card_version,
            source_event_id, source_cmd, program_id, actor, outcome, note, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(row.adoption_id, row.artifact_kind, row.artifact_id, row.revision_id ?? null,
            row.card_version ?? null, row.source_event_id ?? null, row.source_cmd ?? null,
            row.program_id ?? null, row.actor ?? null, row.outcome ?? null, row.note ?? null, row.created_at)
        return { created: true }
      } catch (e) {
        if (/UNIQUE/i.test(String(e?.message))) return { created: false, duplicate: 'source' }
        throw e
      }
    },
    adoptionCount(artifactKind, artifactId) {
      return db.prepare('SELECT COUNT(*) AS c FROM know_adoptions WHERE artifact_kind=? AND artifact_id=?')
        .get(String(artifactKind), String(artifactId)).c
    },
    adoptionArtifacts() {
      return db.prepare('SELECT DISTINCT artifact_kind, artifact_id FROM know_adoptions').all()
    },
    // L6（设计 §10 证据对照）：按 artifact 列采用事实（追溯链「采用」环节）
    listAdoptions({ artifact_kind = '', artifact_id = '', limit = 50, offset = 0 } = {}) {
      const conds = []; const vals = []
      if (artifact_kind) { conds.push('artifact_kind=?'); vals.push(String(artifact_kind)) }
      if (artifact_id) { conds.push('artifact_id=?'); vals.push(String(artifact_id)) }
      const w = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
      const total = db.prepare(`SELECT COUNT(*) AS c FROM know_adoptions ${w}`).get(...vals).c
      const rows = db.prepare(`SELECT * FROM know_adoptions ${w} ORDER BY created_at DESC, adoption_id DESC LIMIT ? OFFSET ?`).all(...vals, limit, offset)
      return { rows: rows.map((r) => ({ ...r })), total }
    },

    // ---- L5 know_feedback（原生反馈桥事实行：id+revision 幂等；编辑=新 revision；撤回=tombstone）----
    insertFeedback(row) {
      try {
        db.prepare(`INSERT INTO know_feedback (
            feedback_id, revision, session_id, message_id, kind, rating, category, note,
            tombstone, attribution_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(row.feedback_id, row.revision, row.session_id, row.message_id, row.kind,
            row.rating ?? null, row.category ?? null, row.note ?? null,
            row.tombstone ? 1 : 0, row.attribution_json ?? null, row.created_at)
        return { created: true }
      } catch (e) {
        if (/UNIQUE/i.test(String(e?.message))) return { created: false, duplicate: 'id_revision' }
        throw e
      }
    },
    latestFeedback(feedbackId) {
      return db.prepare('SELECT * FROM know_feedback WHERE feedback_id=? ORDER BY revision DESC LIMIT 1').get(String(feedbackId)) || null
    },
    // 有效反馈集：取每个 feedback_id 的最新 revision（撤回=该 id 无有效反馈）
    effectiveFeedback() {
      return db.prepare(`SELECT f.* FROM know_feedback f
        JOIN (SELECT feedback_id, MAX(revision) AS rev FROM know_feedback GROUP BY feedback_id) m
          ON m.feedback_id=f.feedback_id AND m.rev=f.revision
        WHERE f.tombstone=0`).all()
    },
    feedbackCount() {
      return db.prepare('SELECT COUNT(*) AS c FROM know_feedback').get().c
    },
    // L6（设计 §10 证据对照）：按 artifact 列反馈事实行（追溯链「反馈/计分」环节）
    listFeedbackForArtifact(artifactKind, artifactId, limit = 50) {
      const rows = db.prepare(`SELECT * FROM know_feedback
        WHERE json_extract(attribution_json, '$.artifact_kind') = ?
          AND json_extract(attribution_json, '$.artifact_id') = ?
        ORDER BY created_at DESC, revision DESC LIMIT ?`).all(String(artifactKind), String(artifactId), limit)
      return rows.map((r) => ({ ...r }))
    },
    // 有效反馈覆盖的 artifact 键集合（全量重建 C31 的第三族事实来源——
    // 只有反馈、无曝光/采用/episode 的卡也必须被重建覆盖，撤回撤销才能回投影）
    feedbackArtifacts() {
      return db.prepare(`SELECT DISTINCT
          json_extract(attribution_json, '$.artifact_kind') AS artifact_kind,
          json_extract(attribution_json, '$.artifact_id') AS artifact_id
        FROM know_feedback WHERE attribution_json IS NOT NULL`).all()
        .filter((r) => r.artifact_kind && r.artifact_id)
    },

    // ---- L5 know_scores（计分投影：可重放重建；聚合三族不可变事实 + 有效反馈）----
    upsertScore(row) {
      db.prepare(`INSERT INTO know_scores (
          artifact_kind, artifact_id, exposures, adoptions, verified_positives, valid_cleans,
          inconclusives, inapplicables, blocked, infra_errors,
          feedback_pos, feedback_neg, feedback_pending,
          cost_requests, cost_tokens, cost_ms, score, sample_size, build_tag, rebuilt_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(artifact_kind, artifact_id) DO UPDATE SET
          exposures=excluded.exposures, adoptions=excluded.adoptions,
          verified_positives=excluded.verified_positives, valid_cleans=excluded.valid_cleans,
          inconclusives=excluded.inconclusives, inapplicables=excluded.inapplicables,
          blocked=excluded.blocked, infra_errors=excluded.infra_errors,
          feedback_pos=excluded.feedback_pos, feedback_neg=excluded.feedback_neg, feedback_pending=excluded.feedback_pending,
          cost_requests=excluded.cost_requests, cost_tokens=excluded.cost_tokens, cost_ms=excluded.cost_ms,
          score=excluded.score, sample_size=excluded.sample_size, build_tag=excluded.build_tag, rebuilt_at=excluded.rebuilt_at`)
        .run(row.artifact_kind, row.artifact_id, row.exposures ?? 0, row.adoptions ?? 0,
          row.verified_positives ?? 0, row.valid_cleans ?? 0, row.inconclusives ?? 0,
          row.inapplicables ?? 0, row.blocked ?? 0, row.infra_errors ?? 0,
          row.feedback_pos ?? 0, row.feedback_neg ?? 0, row.feedback_pending ?? 0,
          row.cost_requests ?? 0, row.cost_tokens ?? 0, row.cost_ms ?? 0,
          row.score ?? 0, row.sample_size ?? 0, row.build_tag ?? null, row.rebuilt_at)
    },
    deleteScore(artifactKind, artifactId) {
      return db.prepare('DELETE FROM know_scores WHERE artifact_kind=? AND artifact_id=?').run(String(artifactKind), String(artifactId)).changes
    },
    getScore(artifactKind, artifactId) {
      return db.prepare('SELECT * FROM know_scores WHERE artifact_kind=? AND artifact_id=?').get(String(artifactKind), String(artifactId)) || null
    },
    listScores({ artifact_kind = '', limit = 50, offset = 0 } = {}) {
      const w = artifact_kind ? 'WHERE artifact_kind=?' : ''
      const vals = artifact_kind ? [String(artifact_kind)] : []
      const total = db.prepare(`SELECT COUNT(*) AS c FROM know_scores ${w}`).get(...vals).c
      const rows = db.prepare(`SELECT * FROM know_scores ${w} ORDER BY score DESC LIMIT ? OFFSET ?`).all(...vals, limit, offset)
      return { rows, total }
    },
    episodeAggByCard() {
      // 有效结果按卡片聚合（card_id 缺记行单列——无法归因不计分；模型自评行另有来源级别标签，
      // 本聚合不含来源过滤，来源过滤在域命令层做）
      return db.prepare(`SELECT card_id, card_version, outcome, COUNT(*) AS n,
          COALESCE(SUM(request_count), 0) AS requests, COALESCE(SUM(token_count), 0) AS tokens,
          COALESCE(SUM(duration_ms), 0) AS ms
        FROM learning_episodes WHERE card_id IS NOT NULL AND card_id != ''
        GROUP BY card_id, card_version, outcome`).all()
    },
    exposureAggByArtifact() {
      return db.prepare(`SELECT artifact_kind, artifact_id, COUNT(*) AS n, SUM(selected) AS sel FROM know_exposures GROUP BY artifact_kind, artifact_id`).all()
    },

    // ---- L5 know_gaps（检索 miss/低覆盖登记）----
    upsertGap(row) {
      db.prepare(`INSERT INTO know_gaps (gap_id, program_id, q, surface, hits, backfill_revision_id, caller_actor, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(program_id, q, surface) DO UPDATE SET hits=excluded.hits, created_at=excluded.created_at`)
        .run(row.gap_id, row.program_id ?? null, row.q ?? null, row.surface ?? null,
          row.hits ?? 0, row.backfill_revision_id ?? null, row.caller_actor ?? null, row.created_at)
    },
    listGaps({ limit = 50, offset = 0 } = {}) {
      const total = db.prepare('SELECT COUNT(*) AS c FROM know_gaps').get().c
      const rows = db.prepare('SELECT * FROM know_gaps ORDER BY created_at DESC LIMIT ? OFFSET ?').all(limit, offset)
      return { rows, total }
    },
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
