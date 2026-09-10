// ==============================================================================
// @silksec/sec-backend-scope-sqlite — scope 域 sqlite-local 后端（repository-v1）
//
// 契约：doc/secagent/v5/08-scope.md §2.1.2/§2.1.3/§2.4
//
// 职责：直接接管 programs / credentials 表（asset-graph.db，WAL，不改名不迁库）。
// programs 是 scope.yml 的运行态镜像（status active/archived）；credentials 是凭据引用
// （ref 非明文）。DDL/索引幂等，workspace_id/workspace_path 经 ensureCol 幂等列演进。
// 不含业务校验（域命令负责校验）。
// ==============================================================================

import { DatabaseSync } from 'node:sqlite'

export const name = '@silksec/sec-backend-scope-sqlite'
export const version = '1.0.0'
export const repositoryV1 = 'repository-v1'

const PROGRAMS_DDL = `
CREATE TABLE IF NOT EXISTS programs (
  id TEXT PRIMARY KEY,
  platform TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  max_risk TEXT,
  fixed_egress_ip INTEGER DEFAULT 0,
  created_at INTEGER, updated_at INTEGER
);
`
const CREDENTIALS_DDL = `
CREATE TABLE IF NOT EXISTS credentials (
  id INTEGER PRIMARY KEY AUTOINCREMENT, program_id TEXT, host TEXT,
  cred_type TEXT, ref TEXT, role TEXT, note TEXT, created_at INTEGER
);
`

function ensureCol(db, table, col, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all()
  if (!cols.some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`)
}

function plain(row) { return row ? { ...row } : null }
function plainAll(rows) { return rows.map((r) => ({ ...r })) }

function createRepo(db) {
  db.exec(PROGRAMS_DDL)
  db.exec(CREDENTIALS_DDL)
  ensureCol(db, 'programs', 'workspace_id', 'workspace_id TEXT')
  ensureCol(db, 'programs', 'workspace_path', 'workspace_path TEXT')
  db.exec('CREATE INDEX IF NOT EXISTS idx_credentials_prog ON credentials(program_id, host)')

  const repo = {
    now() { return Date.now() },

    // ---- programs 镜像 ----
    upsertProgram({ id, platform, max_risk, fixed_egress_ip }) {
      const ts = repo.now()
      const existing = plain(db.prepare('SELECT id FROM programs WHERE id = ?').get(String(id)))
      if (existing) {
        db.prepare(`UPDATE programs SET platform = ?, max_risk = ?, fixed_egress_ip = ?, updated_at = ? WHERE id = ?`)
          .run(platform ?? null, max_risk ?? null, fixed_egress_ip ? 1 : 0, ts, String(id))
        return { created: false }
      }
      db.prepare(`INSERT INTO programs (id, platform, status, max_risk, fixed_egress_ip, created_at, updated_at)
        VALUES (?, ?, 'active', ?, ?, ?, ?)`)
        .run(String(id), platform ?? null, max_risk ?? null, fixed_egress_ip ? 1 : 0, ts, ts)
      return { created: true }
    },
    archiveProgram(id) {
      return db.prepare(`UPDATE programs SET status = 'archived', updated_at = ? WHERE id = ? AND status = 'active'`)
        .run(repo.now(), String(id)).changes
    },
    getProgram(id) { return plain(db.prepare('SELECT * FROM programs WHERE id = ?').get(String(id))) },
    listPrograms() { return plainAll(db.prepare('SELECT * FROM programs ORDER BY id ASC').all()) },
    bindWorkspace(id, workspace_id, workspace_path) {
      db.prepare(`UPDATE programs SET workspace_id = ?, workspace_path = ?, updated_at = ? WHERE id = ?`)
        .run(workspace_id ?? null, workspace_path ?? null, repo.now(), String(id))
    },

    // ---- credentials ----
    insertCred({ program_id, host, cred_type, ref, role, note }) {
      const r = db.prepare(`INSERT INTO credentials (program_id, host, cred_type, ref, role, note, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(program_id ?? null, host ?? '', cred_type ?? '', ref, role ?? '', note ?? '', repo.now())
      return Number(r.lastInsertRowid)
    },
    findCredDuplicate({ program_id, host, cred_type, ref }) {
      return plain(db.prepare(`SELECT * FROM credentials WHERE program_id IS ? AND host = ? AND cred_type = ? AND ref = ? LIMIT 1`)
        .get(program_id ?? null, host ?? '', cred_type ?? '', ref))
    },
    listCredsWhere({ program_id, host, limit }) {
      const where = []
      const args = []
      if (program_id) { where.push('program_id = ?'); args.push(String(program_id)) }
      if (host) { where.push('host = ?'); args.push(String(host)) }
      const w = where.length ? `WHERE ${where.join(' AND ')}` : ''
      return plainAll(db.prepare(`SELECT * FROM credentials ${w} ORDER BY created_at DESC LIMIT ?`)
        .all(...args, Math.min(Number(limit) || 50, 500)))
    },
  }
  return repo
}

const _cache = new WeakMap()

export function createScopeSqliteBackend(_opts = {}) {
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
