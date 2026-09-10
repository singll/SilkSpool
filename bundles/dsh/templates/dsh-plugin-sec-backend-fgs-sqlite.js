// ==============================================================================
// @silksec/sec-backend-fgs-sqlite — fgs 域 sqlite-local 后端（repository-v1，唯一合法后端）
//
// 契约：doc/secagent/v5/14-fgs.md §2.1/§2.4（数据模型 + 后端适配器）
//
// 职责：直接接管现表 fgs_nodes（asset-graph.db，WAL，不改名不迁库）；DDL/索引幂等；
// 状态机原子迁移（updateNodeFields 的 expectStatuses 前置）+ content 增量合并（mergeNodeContent 读-合-写同事务）；
// fgs_next 的依赖满足算法输入（nextStepCandidates + doneStepIds）。
// 不含业务校验（域命令负责校验）；事务边界由总线 CommandGateway 的 BEGIN IMMEDIATE 承担。
//
// tasks 表是 task 域 owns，本后端只读（INV-F1 任务 running 判定 + E_NOT_FOUND 存在性），不建不写。
// ==============================================================================

import { DatabaseSync } from 'node:sqlite'

export const name = '@silksec/sec-backend-fgs-sqlite'
export const version = '1.0.0'
export const repositoryV1 = 'repository-v1'

const FGS_DDL = `
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
`

const NODE_STATUS = ['open', 'running', 'done', 'failed', 'blocked', 'deprecated']

function parseNode(row) {
  if (!row) return null
  const r = { ...row }
  try { r.content = r.content ? JSON.parse(r.content) : {} } catch { r.content = {} }
  try { r.depends_on = r.depends_on ? JSON.parse(r.depends_on) : null } catch { r.depends_on = null }
  return r
}

function createRepo(db) {
  db.exec(FGS_DDL)

  const repo = {
    now() { return Date.now() },

    // ---- 跨域只读：tasks（task 域 owns）----
    getTask(taskId) {
      try { const r = db.prepare('SELECT id, program_id, status FROM tasks WHERE id = ?').get(Number(taskId)); return r ? { ...r } : null } catch { return null }
    },

    // ---- 节点写入 ----
    insertNode(row) {
      const ts = repo.now()
      const contentJson = typeof row.content === 'string' ? row.content : JSON.stringify(row.content || {})
      const dependsJson = Array.isArray(row.depends_on) ? JSON.stringify(row.depends_on) : (row.depends_on || null)
      const r = db.prepare(`INSERT INTO fgs_nodes (task_id, run_id, type, status, content, score, parent_id, depends_on, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(Number(row.task_id), row.run_id || null, row.type, row.status, contentJson, row.score ?? 0, row.parent_id || null, dependsJson, ts, ts)
      return Number(r.lastInsertRowid)
    },
    getNode(id) {
      return parseNode(db.prepare('SELECT * FROM fgs_nodes WHERE id = ?').get(Number(id)))
    },
    // 状态机原子迁移：仅当当前 status ∈ expectStatuses 才改；返回 changes（0=迁移失败/无此行）
    updateNodeFields(id, fields, expectStatuses) {
      const sets = []
      const args = []
      if ('status' in fields) { sets.push('status = ?'); args.push(fields.status) }
      if ('content' in fields) { sets.push('content = ?'); args.push(typeof fields.content === 'string' ? fields.content : JSON.stringify(fields.content || {})) }
      if ('score' in fields) { sets.push('score = ?'); args.push(fields.score) }
      if (!sets.length) return 0
      sets.push('updated_at = ?'); args.push(repo.now())
      let where = 'id = ?'
      if (Array.isArray(expectStatuses) && expectStatuses.length) {
        where += ` AND status IN (${expectStatuses.map(() => '?').join(',')})`
      }
      args.push(Number(id))
      if (Array.isArray(expectStatuses) && expectStatuses.length) args.push(...expectStatuses)
      const r = db.prepare(`UPDATE fgs_nodes SET ${sets.join(', ')} WHERE ${where}`).run(...args)
      return r.changes
    },
    // content 增量合并（读-合-写同事务，浅合并同键覆盖；不覆盖既有键 = 只加新键/改传参键）
    mergeNodeContent(id, incoming) {
      const cur = repo.getNode(id)
      if (!cur) return null
      let inc = {}
      try { inc = typeof incoming === 'string' ? JSON.parse(incoming) : (incoming || {}) } catch { inc = {} }
      if (!inc || typeof inc !== 'object' || Array.isArray(inc)) return null
      const merged = { ...(cur.content || {}), ...inc }
      const mergedKeys = Object.keys(inc)
      db.prepare('UPDATE fgs_nodes SET content = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(merged), repo.now(), Number(id))
      return mergedKeys
    },

    // ---- 节点读取 ----
    listNodesWhere(filters, limit, offset) {
      const { where, args } = fgsWhere(filters)
      const rows = db.prepare(
        `SELECT id, task_id, run_id, type, status, content, score, parent_id, depends_on, created_at, updated_at
         FROM fgs_nodes WHERE ${where} ORDER BY score DESC, updated_at DESC LIMIT ? OFFSET ?`
      ).all(...args, Math.min(Number(limit) || 200, 500), Math.max(0, Number(offset) || 0))
      return rows.map(parseNode)
    },
    countNodesWhere(filters) {
      const { where, args } = fgsWhere(filters)
      return db.prepare(`SELECT COUNT(*) AS n FROM fgs_nodes WHERE ${where}`).get(...args).n
    },
    nextStepCandidates(taskId, limit) {
      const rows = db.prepare(
        `SELECT id, content, score, depends_on FROM fgs_nodes
         WHERE task_id = ? AND type = 'step' AND status = 'open'
         ORDER BY score DESC, updated_at DESC LIMIT ?`
      ).all(Number(taskId), Math.min(Number(limit) || 50, 50))
      return rows.map(parseNode)
    },
    doneStepIds(taskId) {
      return new Set(db.prepare("SELECT id FROM fgs_nodes WHERE task_id = ? AND type = 'step' AND status = 'done'")
        .all(Number(taskId)).map((r) => r.id))
    },
    deleteNodesByTask(taskId) {
      return db.prepare('DELETE FROM fgs_nodes WHERE task_id = ?').run(Number(taskId)).changes
    },
  }
  return repo
}

function fgsWhere({ task_id = 0, type = '', status = '', run_id = '' }) {
  let where = 'task_id = ?'
  const args = [Number(task_id)]
  if (type) { where += ' AND type = ?'; args.push(String(type)) }
  if (status) { where += ' AND status = ?'; args.push(String(status)) }
  if (run_id) { where += ' AND run_id = ?'; args.push(String(run_id)) }
  return { where, args }
}

export { NODE_STATUS }

const _cache = new WeakMap()

export function createFgsSqliteBackend(_opts = {}) {
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
