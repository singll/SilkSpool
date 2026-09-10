// ==============================================================================
// @silksec/sec-backend-report-sqlite — report 域 sqlite-local 后端（repository-v1，索引加速层）
//
// 契约：doc/secagent/v5/12-report.md §2.1/§2.4
//
// 职责：直接接管 reports 索引表（asset-graph.db 内新表，WAL，不改名不迁库）。
// 索引是「可随时丢弃重建的加速层」——frontmatter 才是权威元数据源（12-report §2.1）。
// 列表/筛选/分页走索引（O(log n)），索引损坏的后果是「慢」（触发重建）而非「错」。
// 不含业务校验（域命令/查询负责校验 + heal）。
// ==============================================================================

import { DatabaseSync } from 'node:sqlite'

export const name = '@silksec/sec-backend-report-sqlite'
export const version = '1.0.0'
export const repositoryV1 = 'repository-v1'

const REPORTS_DDL = `
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id TEXT UNIQUE NOT NULL,
  kind TEXT NOT NULL,
  file TEXT UNIQUE NOT NULL,
  program TEXT,
  title TEXT,
  generated_at INTEGER NOT NULL,
  date TEXT NOT NULL,
  filters TEXT,
  total INTEGER,
  by_severity TEXT,
  noise_filtered INTEGER,
  actor TEXT,
  session_id TEXT,
  content_sha TEXT
)
`

const SORT_COLS = {
  generated_at: 'generated_at',
  program: 'program',
  total: 'total',
}

function plain(row) { return row ? { ...row } : null }
function plainAll(rows) { return rows.map((r) => ({ ...r })) }

function createRepo(db) {
  db.exec(REPORTS_DDL)
  db.exec('CREATE INDEX IF NOT EXISTS idx_reports_generated ON reports(generated_at)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_reports_program ON reports(program, generated_at)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_reports_kind ON reports(kind)')

  const repo = {
    insertReportRow(row) {
      // INSERT OR REPLACE：regenerate（同日草稿覆盖重写）与 heal 回填都按 file 唯一键原地 upsert，
      // 避免 reports.file UNIQUE 冲突（12-report §1.3.2 regenerate 语义）。
      db.prepare(`
        INSERT OR REPLACE INTO reports (report_id, kind, file, program, title, generated_at, date,
          filters, total, by_severity, noise_filtered, actor, session_id, content_sha)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        row.report_id, row.kind, row.file, row.program ?? null, row.title ?? null,
        row.generated_at, row.date, row.filters ?? null, row.total ?? null,
        row.by_severity ?? null, row.noise_filtered ?? null, row.actor ?? null,
        row.session_id ?? null, row.content_sha ?? null,
      )
      return { report_id: row.report_id }
    },
    getReportRow(reportId) {
      return plain(db.prepare('SELECT * FROM reports WHERE report_id = ?').get(String(reportId)))
    },
    getReportRowByFile(file) {
      return plain(db.prepare('SELECT * FROM reports WHERE file = ?').get(String(file)))
    },
    deleteReportRow(reportId) {
      return db.prepare('DELETE FROM reports WHERE report_id = ?').run(String(reportId)).changes
    },
    listReportRows(where) {
      const conds = []
      const args = []
      if (where.program) { conds.push('(program = ? OR program IS NULL)'); args.push(String(where.program)) }
      if (where.kind) { conds.push('kind = ?'); args.push(String(where.kind)) }
      if (where.date_from) { conds.push('date >= ?'); args.push(String(where.date_from)) }
      if (where.date_to) { conds.push('date <= ?'); args.push(String(where.date_to)) }
      if (where.q) {
        conds.push('(file LIKE ? OR title LIKE ? OR program LIKE ?)')
        const like = `%${String(where.q).toLowerCase()}%`
        args.push(like, like, like)
      }
      const w = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
      const sort = SORT_COLS[where.sort] || 'generated_at'
      const dir = String(where.dir || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC'
      const total = db.prepare(`SELECT COUNT(*) AS n FROM reports ${w}`).get(...args).n
      const rows = plainAll(db.prepare(`SELECT * FROM reports ${w} ORDER BY ${sort} ${dir}`).all(...args))
      return { rows, total }
    },
    allReportRows() {
      return plainAll(db.prepare('SELECT * FROM reports ORDER BY generated_at DESC').all())
    },
  }
  return repo
}

const _cache = new WeakMap()

export function createReportSqliteBackend(_opts = {}) {
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
