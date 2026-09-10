// ==============================================================================
// @silksec/sec-backend-task-sqlite — task 域 sqlite-local 后端（repository-v1，唯一合法后端）
//
// 契约：doc/secagent/v5/05-task.md §2.1/§2.4（数据模型 + 后端适配器）
//
// 职责：直接接管现表 tasks / task_runs / workers（asset-graph.db，WAL，不改名不迁库）；
// ensureCol 幂等列演进（schedule 六列 / 预算 / 模型覆盖）；idx_tasks_due 等索引。
// 不含业务校验（域命令负责校验）；事务边界由总线 CommandGateway 的 BEGIN IMMEDIATE 承担——
// 本后端所有写原语在网关事务内执行，认领原语 claimDueTasks 不做自己的 BEGIN（避免嵌套事务）。
//
// programs 表是 scope 域 owns（Phase 2.6），本后端只读（program 归属反查），不建不写。
// ==============================================================================

import { DatabaseSync } from 'node:sqlite'

export const name = '@silksec/sec-backend-task-sqlite'
export const version = '1.0.0'
export const repositoryV1 = 'repository-v1'

const TASKS_DDL = `
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  program_id TEXT NOT NULL,
  parent_id INTEGER,
  phase TEXT,
  objective TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  priority INTEGER NOT NULL DEFAULT 5,
  assignee TEXT,
  budget_tokens INTEGER,
  spent_tokens INTEGER DEFAULT 0,
  session_id TEXT,
  blocked_reason TEXT,
  result TEXT,
  created_at INTEGER, updated_at INTEGER, started_at INTEGER, finished_at INTEGER,
  schedule_kind TEXT,
  run_at INTEGER,
  every_seconds INTEGER,
  next_run_at INTEGER,
  last_run_at INTEGER,
  last_run_id TEXT,
  provider TEXT,
  model TEXT,
  reasoning_effort TEXT,
  budget_timeout_sec INTEGER
)`

const TASK_RUNS_DDL = `
CREATE TABLE IF NOT EXISTS task_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  run_id TEXT,
  ok INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  started_at INTEGER,
  finished_at INTEGER,
  duration_ms INTEGER,
  session_id TEXT
)`

const WORKERS_DDL = `
CREATE TABLE IF NOT EXISTS workers (
  run_id TEXT PRIMARY KEY,
  dedupe_key TEXT,
  task TEXT, cwd TEXT, pid INTEGER,
  status TEXT NOT NULL DEFAULT 'running',
  exit_code INTEGER,
  started_at INTEGER, finished_at INTEGER,
  timeout_sec INTEGER, session_id TEXT, run_dir TEXT
)`

const TASK_STATUS = ['queued', 'running', 'blocked', 'done', 'failed', 'cancelled']

function ensureCol(db, table, col, ddl) {
  try {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all()
    if (!cols.some((c) => c.name === col)) {
      try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`) } catch (e) {
        if (!/duplicate column/i.test(String(e?.message))) throw e
      }
    }
  } catch (e) {
    process.stderr.write(`[sec-backend-task-sqlite] ensureCol(${col}) 失败: ${e?.message}\n`)
  }
}

function createRepo(db) {
  db.exec(TASKS_DDL)
  db.exec(TASK_RUNS_DDL)
  db.exec(WORKERS_DDL)
  // 平滑迁移：存量库补列（幂等，v4 已建过则跳过）
  for (const [col, ddl] of [
    ['schedule_kind', 'schedule_kind TEXT'],
    ['run_at', 'run_at INTEGER'],
    ['every_seconds', 'every_seconds INTEGER'],
    ['next_run_at', 'next_run_at INTEGER'],
    ['last_run_at', 'last_run_at INTEGER'],
    ['last_run_id', 'last_run_id TEXT'],
    ['provider', 'provider TEXT'],
    ['model', 'model TEXT'],
    ['reasoning_effort', 'reasoning_effort TEXT'],
    ['budget_timeout_sec', 'budget_timeout_sec INTEGER'],
  ]) ensureCol(db, 'tasks', col, ddl)
  ensureCol(db, 'task_runs', 'session_id', 'session_id TEXT')
  db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_queue ON tasks(program_id, status, priority)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(schedule_kind, next_run_at)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_task_runs_task ON task_runs(task_id, id DESC)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_task_runs_finished ON task_runs(finished_at DESC)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_workers_key ON workers(dedupe_key, started_at)')

  const repo = {
    now() { return Date.now() },

    // ---- programs（scope 域 owns，只读反查）----
    getProgram(id) {
      try { const r = db.prepare('SELECT id, platform, status, max_risk, workspace_id, workspace_path FROM programs WHERE id = ?').get(String(id)); return r ? { ...r } : null } catch { return null }
    },
    programByWorkspacePath(cwd) {
      if (!cwd) return null
      try { const r = db.prepare("SELECT id FROM programs WHERE workspace_path = ? AND status = 'active'").get(String(cwd)); return r ? r.id : null } catch { return null }
    },

    // ---- tasks ----
    insertTask(row) {
      const r = db.prepare(`
        INSERT INTO tasks (program_id, parent_id, phase, objective, priority, assignee, budget_tokens,
          session_id, schedule_kind, run_at, every_seconds, next_run_at, status, created_at, updated_at,
          provider, model, reasoning_effort)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)
      `).run(
        String(row.program_id), row.parent_id ?? null, row.phase === undefined || row.phase === null ? null : String(row.phase),
        String(row.objective), row.priority ?? 5, row.assignee ? String(row.assignee) : '', row.budget_tokens ?? null,
        row.session_id ?? null, row.schedule_kind ?? null, row.run_at ?? null, row.every_seconds ?? null, row.next_run_at ?? null,
        repo.now(), repo.now(), row.provider ?? null, row.model ?? null, row.reasoning_effort ?? null,
      )
      return Number(r.lastInsertRowid)
    },
    getTask(id) {
      const r = db.prepare('SELECT * FROM tasks WHERE id = ?').get(Number(id))
      return r ? { ...r } : null
    },
    findActiveInterval(programId, objective) {
      const r = db.prepare(
        "SELECT * FROM tasks WHERE program_id = ? AND objective = ? AND schedule_kind = 'interval' AND status NOT IN ('done','failed','cancelled') LIMIT 1"
      ).get(String(programId), String(objective))
      return r ? { ...r } : null
    },
    transitionTask(id, patch, expectStatus) {
      const sets = []
      const args = []
      for (const [k, v] of Object.entries(patch)) { sets.push(`${k} = ?`); args.push(v) }
      sets.push('updated_at = ?'); args.push(repo.now())
      const where = expectStatus ? ' AND status = ?' : ''
      args.push(Number(id))
      if (expectStatus) args.push(expectStatus)
      const r = db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?${where}`).run(...args)
      return r.changes
    },
    listTasksWhere(filters, limit, offset, sort) {
      const { where, args } = taskWhere(filters)
      const orderBy = sort === 'created_at' ? 'created_at ASC' : 'priority ASC, created_at ASC'
      return db.prepare(`SELECT * FROM tasks WHERE ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`)
        .all(...args, Math.min(Number(limit) || 50, 500), Math.max(0, Number(offset) || 0)).map((r) => ({ ...r }))
    },
    countTasksWhere(filters) {
      const { where, args } = taskWhere(filters)
      return db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE ${where}`).get(...args).n
    },
    claimDueTasks(nowTs, limit) {
      const due = db.prepare(
        `SELECT id FROM tasks t WHERE schedule_kind IS NOT NULL AND status = 'queued' AND next_run_at IS NOT NULL AND next_run_at <= ?
           AND (parent_id IS NULL OR EXISTS (SELECT 1 FROM tasks p WHERE p.id = t.parent_id AND p.status = 'done'))
         ORDER BY priority ASC, next_run_at ASC LIMIT ?`
      ).all(nowTs, Math.min(Number(limit) || 4, 4)).map((r) => ({ ...r }))
      const upd = db.prepare("UPDATE tasks SET status = 'running', started_at = ?, updated_at = ? WHERE id = ? AND status = 'queued'")
      const claimed = []
      for (const row of due) {
        const r = upd.run(nowTs, nowTs, row.id)
        if (r.changes === 1) claimed.push(row.id)
      }
      if (!claimed.length) return []
      const marks = claimed.map(() => '?').join(',')
      return db.prepare(`SELECT * FROM tasks WHERE id IN (${marks})`).all(...claimed).map((r) => ({ ...r }))
    },
    nextTaskForProgram(programId) {
      const rows = db.prepare('SELECT * FROM tasks WHERE program_id = ? AND status = ? ORDER BY priority ASC, created_at ASC')
        .all(String(programId), 'queued').map((r) => ({ ...r }))
      for (const t of rows) {
        if (t.parent_id) {
          const p = db.prepare('SELECT status FROM tasks WHERE id = ?').get(t.parent_id)
          if (!p || p.status !== 'done') continue
        }
        return t
      }
      return null
    },
    scheduledTasksAgg() {
      return db.prepare(
        `SELECT t.*,
           (SELECT COUNT(*) FROM task_runs r WHERE r.task_id = t.id) AS run_count,
           (SELECT COUNT(*) FROM task_runs r WHERE r.task_id = t.id AND r.ok = 0) AS fail_count,
           (SELECT r.ok FROM task_runs r WHERE r.task_id = t.id ORDER BY r.id DESC LIMIT 1) AS last_ok,
           (SELECT r.note FROM task_runs r WHERE r.task_id = t.id ORDER BY r.id DESC LIMIT 1) AS last_note
         FROM tasks t
         WHERE t.schedule_kind IS NOT NULL AND t.status NOT IN ('done', 'failed', 'cancelled')
         ORDER BY t.next_run_at ASC`
      ).all().map((r) => ({ ...r }))
    },
    reapStale(maxAgeMs, pidAliveFn, nowTs) {
      const cutoff = nowTs - maxAgeMs
      const stale = db.prepare(
        "SELECT id, schedule_kind, started_at, last_run_id FROM tasks WHERE status = 'running' AND schedule_kind IS NOT NULL AND started_at IS NOT NULL AND started_at < ?"
      ).all(cutoff).map((r) => ({ ...r }))
      const alive = pidAliveFn || (() => false)
      let reaped = 0
      let skipped = 0
      for (const t of stale) {
        if (t.last_run_id) {
          const w = db.prepare('SELECT pid, status FROM workers WHERE run_id = ?').get(t.last_run_id)
          if (w && w.status === 'running' && alive(w.pid)) { skipped++; continue }
        }
        const status = t.schedule_kind === 'interval' ? 'queued' : 'failed'
        const r = db.prepare("UPDATE tasks SET status = ?, blocked_reason = '宿主重启/超时回收', updated_at = ? WHERE id = ? AND status = 'running'")
          .run(status, nowTs, t.id)
        if (r.changes === 1) {
          reaped++
          repo.insertTaskRun({ task_id: t.id, run_id: '', ok: false, note: '宿主重启/超时回收', started_at: t.started_at, finished_at: nowTs, session_id: null })
        }
      }
      return { reaped, skipped_alive: skipped }
    },

    // ---- task_runs ----
    insertTaskRun(row) {
      const started = row.started_at ?? null
      const finished = row.finished_at ?? null
      const duration = (started && finished) ? finished - started : null
      const r = db.prepare('INSERT INTO task_runs (task_id, run_id, ok, note, started_at, finished_at, duration_ms, session_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(Number(row.task_id), String(row.run_id || ''), row.ok ? 1 : 0, String(row.note || '').slice(0, 500), started, finished, duration, row.session_id ?? null)
      repo.pruneTaskRuns(Number(row.task_id), 200)
      return Number(r.lastInsertRowid)
    },
    pruneTaskRuns(taskId, keep) {
      return db.prepare('DELETE FROM task_runs WHERE task_id = ? AND id NOT IN (SELECT id FROM task_runs WHERE task_id = ? ORDER BY id DESC LIMIT ?)')
        .run(Number(taskId), Number(taskId), Number(keep)).changes
    },
    listTaskRunsWhere(filters, limit, offset) {
      let where = '1=1'
      const args = []
      if (filters.task_id) { where += ' AND r.task_id = ?'; args.push(Number(filters.task_id)) }
      if (filters.program_id) { where += ' AND t.program_id = ?'; args.push(String(filters.program_id)) }
      return db.prepare(
        `SELECT r.id, r.task_id, r.run_id, r.ok, r.note, r.started_at, r.finished_at, r.duration_ms, r.session_id,
                t.objective, t.program_id, t.phase
         FROM task_runs r JOIN tasks t ON t.id = r.task_id
         WHERE ${where} ORDER BY r.id DESC LIMIT ? OFFSET ?`
      ).all(...args, Math.min(Number(limit) || 50, 500), Math.max(0, Number(offset) || 0)).map((r) => ({ ...r }))
    },
    countTaskRunsWhere(filters) {
      let where = '1=1'
      const args = []
      if (filters.task_id) { where += ' AND r.task_id = ?'; args.push(Number(filters.task_id)) }
      if (filters.program_id) { where += ' AND t.program_id = ?'; args.push(String(filters.program_id)) }
      return db.prepare(`SELECT COUNT(*) AS n FROM task_runs r JOIN tasks t ON t.id = r.task_id WHERE ${where}`).get(...args).n
    },
    taskStats(programId) {
      const rows = db.prepare('SELECT phase, status, COUNT(*) AS n FROM tasks WHERE program_id = ? GROUP BY phase, status')
        .all(String(programId)).map((r) => ({ ...r }))
      const total = db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE program_id = ?').get(String(programId)).n
      return { program_id: programId, total, by_phase_status: rows }
    },
    activeTaskBySession(session_id, maxAgeMs) {
      if (!session_id) return null
      const cutoff = repo.now() - maxAgeMs
      const r = db.prepare(`
        SELECT t.id AS task_id, t.program_id, t.phase, t.objective, r.run_id, r.started_at
        FROM task_runs r JOIN tasks t ON t.id = r.task_id
        WHERE r.session_id = ? AND t.status = 'running' AND r.started_at >= ?
        ORDER BY r.id DESC LIMIT 1
      `).get(String(session_id), cutoff)
      return r ? { ...r } : null
    },

    // ---- workers ----
    upsertWorker(row) {
      db.prepare(`
        INSERT INTO workers (run_id, dedupe_key, task, cwd, pid, status, exit_code, started_at, finished_at, timeout_sec, session_id, run_dir)
        VALUES (?, ?, ?, ?, ?, 'running', NULL, ?, NULL, ?, ?, ?)
        ON CONFLICT (run_id) DO UPDATE SET pid = excluded.pid, status = 'running'
      `).run(String(row.run_id), row.dedupe_key ?? null, String(row.task || '').slice(0, 2000), row.cwd ?? null,
        row.pid ?? null, repo.now(), row.timeout_sec ?? null, row.session_id ?? null, row.run_dir ?? null)
      return { changed: true }
    },
    finishWorker(runId, patch, expectRunning) {
      const sets = []
      const args = []
      for (const [k, v] of Object.entries(patch)) { sets.push(`${k} = ?`); args.push(v) }
      sets.push('finished_at = ?'); args.push(repo.now())
      args.push(String(runId))
      const where = expectRunning ? " AND status = 'running'" : ''
      const r = db.prepare(`UPDATE workers SET ${sets.join(', ')} WHERE run_id = ?${where}`).run(...args)
      return r.changes
    },
    getWorker(runId) {
      const r = db.prepare('SELECT * FROM workers WHERE run_id = ?').get(String(runId))
      return r ? { ...r } : null
    },
    findWorkerRecentByKey(key, sinceMs) {
      if (!key) return null
      const cutoff = repo.now() - (Number(sinceMs) || 0)
      const r = db.prepare('SELECT * FROM workers WHERE dedupe_key = ? AND started_at >= ? ORDER BY started_at DESC LIMIT 1')
        .get(String(key), cutoff)
      return r ? { ...r } : null
    },
    listWorkersWhere(status, limit) {
      const lim = Math.min(Math.max(Number(limit) || 20, 1), 200)
      const rows = status
        ? db.prepare('SELECT * FROM workers WHERE status = ? ORDER BY started_at DESC LIMIT ?').all(String(status), lim)
        : db.prepare('SELECT * FROM workers ORDER BY started_at DESC LIMIT ?').all(lim)
      return rows.map((r) => ({ ...r }))
    },
    runningWorkers() {
      return db.prepare("SELECT run_id, pid, run_dir, started_at, timeout_sec FROM workers WHERE status = 'running'").all().map((r) => ({ ...r }))
    },
    reapWorkers(readMeta, pidAliveFn, nowTs) {
      const running = repo.runningWorkers()
      const alive = pidAliveFn || (() => false)
      let reaped = 0
      for (const w of running) {
        let status = null
        let exitCode = null
        try {
          const meta = readMeta ? readMeta(w.run_dir) : null
          if (meta && meta.exit_code !== undefined && meta.exit_code !== null) {
            exitCode = meta.exit_code
            status = meta.exit_code === 0 ? 'done' : 'failed'
          }
        } catch { /* 无 meta → pid 判定 */ }
        if (!status) {
          if (alive(w.pid)) {
            const limit = (w.started_at || 0) + ((w.timeout_sec || 900) + 60) * 1000
            if (w.started_at && nowTs > limit) {
              try { process.kill(-w.pid, 'SIGTERM') } catch { /* 进程组已退 */ }
              status = 'killed'
            } else {
              continue
            }
          } else {
            status = 'killed'
          }
        }
        const r = db.prepare("UPDATE workers SET status = ?, exit_code = ?, finished_at = ? WHERE run_id = ? AND status = 'running'")
          .run(status, exitCode, nowTs, w.run_id)
        if (r.changes === 1) reaped++
      }
      return { reaped }
    },
  }
  return repo
}

function taskWhere({ program_id = '', status = '', phase = '', q = '', bucket = '', scheduled = '' }) {
  let where = '1=1'
  const args = []
  if (program_id) { where += ' AND program_id = ?'; args.push(String(program_id)) }
  if (status) { where += ' AND status = ?'; args.push(String(status)) }
  if (phase) { where += ' AND phase = ?'; args.push(String(phase)) }
  if (q) { where += ' AND objective LIKE ?'; args.push(`%${q}%`) }
  if (bucket === 'active') where += " AND status IN ('queued', 'running', 'blocked')"
  else if (bucket === 'history') where += " AND status IN ('done', 'failed', 'cancelled')"
  if (scheduled === 'exclude') where += ' AND schedule_kind IS NULL'
  else if (scheduled === 'only') where += ' AND schedule_kind IS NOT NULL'
  return { where, args }
}

export { TASK_STATUS }

const _cache = new WeakMap()

export function createTaskSqliteBackend(_opts = {}) {
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
