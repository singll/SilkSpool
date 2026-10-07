// ==============================================================================
// @silksec/sec-backend-task-sqlite — task 域 sqlite-local 后端（repository-v1，唯一合法后端）
//
// 契约：doc/secagent/05-task.md §2.1/§2.4（数据模型 + 后端适配器）
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
  budget_timeout_sec INTEGER,
  task_class TEXT,
  model_hint TEXT
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

// 21 号方案 §3-1：Intent 派生器 strategy 去重/连败黑名单表（task 域 owns）
const STRATEGY_DDL = `
CREATE TABLE IF NOT EXISTS strategy_dedupe (
  strategy_key TEXT PRIMARY KEY,
  program_id TEXT,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  fails INTEGER NOT NULL DEFAULT 0,
  blacklisted INTEGER NOT NULL DEFAULT 0,
  last_task_id INTEGER,
  reopen_after INTEGER
)`

// 22 号方案 §5.1：Campaign（专项）台账（task 域 owns）
const CAMPAIGNS_DDL = `
CREATE TABLE IF NOT EXISTS campaigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'single',
  program_ids TEXT NOT NULL,
  goal_spec TEXT NOT NULL,
  autonomy INTEGER NOT NULL DEFAULT 0,
  policy TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  budget_tokens INTEGER,
  spent_tokens INTEGER NOT NULL DEFAULT 0,
  budget_window_days INTEGER NOT NULL DEFAULT 7,
  approval_id INTEGER,
  last_tick_at INTEGER,
  heartbeat_at INTEGER,
  created_by TEXT NOT NULL,
  created_at INTEGER, updated_at INTEGER, archived_at INTEGER
)`

// 22 号方案 §5.3：验收账本（证据铁律落点；UNIQUE(task_id) = 一任务一验收）
const CAMPAIGN_DECISIONS_DDL = `
CREATE TABLE IF NOT EXISTS campaign_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER NOT NULL,
  task_id INTEGER NOT NULL,
  verdict TEXT NOT NULL,
  evidence TEXT NOT NULL,
  goal_delta TEXT,
  decided_by TEXT NOT NULL,
  created_at INTEGER,
  UNIQUE(task_id)
)`

// 22 号方案 §5.4：里程碑/升级记录
const CAMPAIGN_CHECKPOINTS_DDL = `
CREATE TABLE IF NOT EXISTS campaign_checkpoints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  summary TEXT,
  payload TEXT,
  created_at INTEGER
)`

// 34 号补丁：域级运行时配置 KV（预算闸等在线可调；env 仅作初始值）
const DDL_SETTINGS = `
CREATE TABLE IF NOT EXISTS task_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER
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
  db.exec(`CREATE TABLE IF NOT EXISTS hypothesis_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT, strategy_key TEXT NOT NULL UNIQUE,
    program_id TEXT NOT NULL, draft TEXT NOT NULL, task_id INTEGER,
    created_at INTEGER NOT NULL, available_at INTEGER NOT NULL DEFAULT 0,
    last_error TEXT, attempts INTEGER NOT NULL DEFAULT 0
  )`)
  db.exec('CREATE INDEX IF NOT EXISTS idx_hypothesis_queue_due ON hypothesis_queue(task_id, available_at, id)')
  ensureCol(db, 'hypothesis_queue', 'retry_count', 'retry_count INTEGER NOT NULL DEFAULT 0')
  db.exec(TASKS_DDL)
  db.exec(TASK_RUNS_DDL)
  // Independent of the bounded task_runs history: retries and late invoices must not
  // disappear when execution history is pruned, or be applied twice after restart.
  db.exec(`CREATE TABLE IF NOT EXISTS task_run_costs (
    task_id INTEGER NOT NULL, run_id TEXT NOT NULL, spent_tokens INTEGER NOT NULL,
    session_id TEXT, source TEXT NOT NULL, consumed_at INTEGER, recorded_at INTEGER NOT NULL,
    PRIMARY KEY(task_id, run_id)
  )`)
  db.exec(`CREATE TABLE IF NOT EXISTS task_cost_evidence (
    task_id INTEGER NOT NULL, run_id TEXT NOT NULL, evidence_sha256 TEXT NOT NULL,
    session_id TEXT NOT NULL, session_sha256 TEXT NOT NULL, lower_bound_tokens INTEGER NOT NULL,
    previous_tokens INTEGER NOT NULL, delta_tokens INTEGER NOT NULL, recorded_at INTEGER NOT NULL,
    PRIMARY KEY(task_id,run_id,evidence_sha256)
  )`)
  db.exec(`CREATE TABLE IF NOT EXISTS task_bill_items (
    receipt_key TEXT PRIMARY KEY, task_id INTEGER NOT NULL, run_id TEXT NOT NULL,
    tokens INTEGER NOT NULL, consumed_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_task_bill_window ON task_bill_items(task_id,consumed_at);
  CREATE TABLE IF NOT EXISTS task_cost_watch (
    id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL, run_id TEXT NOT NULL,
    session_id TEXT NOT NULL, UNIQUE(task_id,run_id)
  );
  INSERT OR IGNORE INTO task_cost_watch(task_id,run_id,session_id)
    SELECT task_id,run_id,session_id FROM task_run_costs WHERE session_id IS NOT NULL;
  `)
  db.exec(WORKERS_DDL)
  db.exec(`CREATE TABLE IF NOT EXISTS task_budget_reservations (
    task_id INTEGER NOT NULL, claim_started_at INTEGER NOT NULL, tokens INTEGER NOT NULL,
    run_id TEXT, state TEXT NOT NULL DEFAULT 'reserved', created_at INTEGER NOT NULL,
    PRIMARY KEY(task_id,claim_started_at)
  )`)
  ensureCol(db, 'task_budget_reservations', 'expected_tokens', 'expected_tokens INTEGER')
  db.exec(STRATEGY_DDL)
  ensureCol(db, 'strategy_dedupe', 'reopen_after', 'reopen_after INTEGER')
  db.exec(CAMPAIGNS_DDL)
  db.exec(CAMPAIGN_DECISIONS_DDL)
  db.exec(CAMPAIGN_CHECKPOINTS_DDL)
  db.exec(DDL_SETTINGS)
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
    ['active_run_id', 'active_run_id TEXT'],
    ['intent_spec', 'intent_spec TEXT'],
    ['after_delay_seconds', 'after_delay_seconds INTEGER NOT NULL DEFAULT 0'],
    // L6（学习专项 §10）：任务目标类型（research 默认 / learn-daily / eval-batch / change-retest）
    ['goal', 'goal TEXT'],
    // 22 号方案 §5.2：子任务专项归属（幂等加列，存量 NULL 天然兼容；写入后不可改 INV-C2）
    ['campaign_id', 'campaign_id INTEGER'],
    ['campaign_role', 'campaign_role TEXT'],
    ['strategy_key', 'strategy_key TEXT'],
    // 23 号方案 §3.7：任务分档标注 + Path A 模型提示（幂等加列，存量 NULL 兼容）
    ['task_class', 'task_class TEXT'],
    ['model_hint', 'model_hint TEXT'],
  ]) ensureCol(db, 'tasks', col, ddl)
  ensureCol(db, 'task_runs', 'session_id', 'session_id TEXT')
  ensureCol(db, 'task_runs', 'spent_tokens', 'spent_tokens INTEGER')
  db.exec("INSERT OR IGNORE INTO task_cost_watch(task_id,run_id,session_id) SELECT task_id,run_id,session_id FROM task_runs WHERE session_id IS NOT NULL AND run_id<>'' AND spent_tokens IS NULL")
  // workers.session_id 保持历史来源会话语义；新列只保存经核实的子会话。
  ensureCol(db, 'workers', 'worker_session_id', 'worker_session_id TEXT')
  ensureCol(db, 'workers', 'task_id', 'task_id INTEGER')
  ensureCol(db, 'workers', 'claim_started_at', 'claim_started_at INTEGER')
  db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_queue ON tasks(program_id, status, priority)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_status_priority_created ON tasks(status, priority, created_at)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(schedule_kind, next_run_at)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_campaign ON tasks(campaign_id, status)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_campaigns_status ON campaigns(status, last_tick_at)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_campaign_decisions_campaign ON campaign_decisions(campaign_id, id DESC)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_campaign_checkpoints_campaign ON campaign_checkpoints(campaign_id, id DESC)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_task_runs_task ON task_runs(task_id, id DESC)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_task_runs_finished ON task_runs(finished_at DESC)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_workers_key ON workers(dedupe_key, started_at)')

  const repo = {
    enqueueHypotheses(drafts) {
      const insert = db.prepare('INSERT INTO hypothesis_queue(strategy_key,program_id,draft,created_at) VALUES(?,?,?,?) ON CONFLICT(strategy_key) DO NOTHING')
      let added = 0
      for (const d of drafts) added += insert.run(d.strategy_key, d.program_id, JSON.stringify(d), Date.now()).changes
      return added
    },
    pendingHypotheses(program, limit, now, excludedPrograms = []) {
      const excluded = excludedPrograms.length ? `AND program_id NOT IN (${excludedPrograms.map(() => '?').join(',')})` : ''
      return db.prepare(`SELECT * FROM hypothesis_queue WHERE task_id IS NULL AND available_at<=? ${program ? 'AND program_id=?' : ''} ${excluded} ORDER BY id LIMIT ?`)
        .all(now, ...(program ? [program] : []), ...excludedPrograms, limit).map(r => ({ ...r }))
    },
    acknowledgeHypothesis(id, taskId) {
      db.prepare('UPDATE hypothesis_queue SET task_id=?,last_error=NULL,attempts=attempts+1 WHERE id=? AND task_id IS NULL').run(taskId, id)
    },
    acknowledgeHypothesisKey(key, taskId) {
      db.prepare('UPDATE hypothesis_queue SET task_id=?,last_error=NULL WHERE strategy_key=? AND task_id IS NULL').run(taskId, key)
    },
    deferHypothesis(id, error, after) {
      db.prepare('UPDATE hypothesis_queue SET last_error=?,available_at=?,attempts=attempts+1 WHERE id=? AND task_id IS NULL').run(error, after, id)
    },
    getHypothesisByKey(key) {
      return db.prepare('SELECT * FROM hypothesis_queue WHERE strategy_key=?').get(key) || null
    },
    retryFailedHypothesis(taskId, after) {
      const q = db.prepare('SELECT id,retry_count FROM hypothesis_queue WHERE task_id=?').get(taskId)
      if (!q) return { reopened: false, limited: false }
      if (q.retry_count >= 2) {
        db.prepare("UPDATE hypothesis_queue SET last_error='execution_retry_limit_reached' WHERE id=? AND task_id=?").run(q.id, taskId)
        return { reopened: false, limited: true }
      }
      const r = db.prepare("UPDATE hypothesis_queue SET task_id=NULL,available_at=?,last_error='execution_failed',retry_count=retry_count+1 WHERE id=? AND task_id=?")
        .run(after, q.id, taskId)
      return { reopened: r.changes === 1, limited: false }
    },
    listHypotheses({ program_id = '', limit = 50, offset = 0 }) {
      const where = program_id ? 'WHERE program_id=?' : ''
      const args = program_id ? [program_id] : []
      const total = db.prepare(`SELECT COUNT(*) n FROM hypothesis_queue ${where}`).get(...args).n
      const rows = db.prepare(`SELECT id,strategy_key,program_id,task_id,created_at,available_at,last_error,attempts,retry_count FROM hypothesis_queue ${where} ORDER BY id LIMIT ? OFFSET ?`).all(...args, limit, offset).map(r => ({ ...r }))
      return { rows, total, meta: { paged: true } }
    },
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
          provider, model, reasoning_effort, after_delay_seconds, goal, campaign_id, campaign_role, strategy_key,
          task_class, model_hint, intent_spec)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        String(row.program_id), row.parent_id ?? null, row.phase === undefined || row.phase === null ? null : String(row.phase),
        String(row.objective), row.priority ?? 5, row.assignee ? String(row.assignee) : '', row.budget_tokens ?? null,
        row.session_id ?? null, row.schedule_kind ?? null, row.run_at ?? null, row.every_seconds ?? null, row.next_run_at ?? null,
        repo.now(), repo.now(), row.provider ?? null, row.model ?? null, row.reasoning_effort ?? null, row.after_delay_seconds ?? 0,
        row.goal ? String(row.goal) : null,
        row.campaign_id == null ? null : Number(row.campaign_id),
        row.campaign_role ? String(row.campaign_role) : null,
        row.strategy_key ? String(row.strategy_key) : null,
        row.task_class ? String(row.task_class) : null,
        row.model_hint ? String(row.model_hint) : null,
        row.intent_spec || null,
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
    listTasksWhere(filters, limit, offset, sort, dir) {
      const { where, args } = taskWhere(filters)
      const d = dir === 'desc' ? 'DESC' : 'ASC'
      const orderBy = sort === 'created_at' ? `created_at ${d}` : `priority ${d}, created_at ${d}`
      return db.prepare(`SELECT * FROM tasks WHERE ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`)
        .all(...args, Math.min(Number(limit) || 50, 500), Math.max(0, Number(offset) || 0)).map((r) => ({ ...r }))
    },
    countTasksWhere(filters) {
      const { where, args } = taskWhere(filters)
      return db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE ${where}`).get(...args).n
    },

    // 21 号方案 §3-4：per-program 周期预算用量（tasks.spent_tokens 周期和 + 创建数）
    budgetUsage(programId, sinceMs) {
      const since = Number(sinceMs) || 0
      const r = db.prepare(`SELECT COUNT(*) AS tasks_created, COALESCE(SUM(COALESCE(spent_tokens, 0)), 0) AS spent_tokens FROM tasks WHERE program_id = ? AND created_at >= ?`)
        .get(String(programId), since)
      return { tasks_created: Number(r?.tasks_created) || 0, spent_tokens: Number(r?.spent_tokens) || 0 }
    },

    // ---- campaigns（22 号方案 §5，task 域 owns） ----
    insertCampaign(row) {
      const r = db.prepare(`
        INSERT INTO campaigns (name, mode, program_ids, goal_spec, autonomy, policy, status,
          budget_tokens, spent_tokens, budget_window_days, approval_id, last_tick_at, heartbeat_at,
          created_by, created_at, updated_at, archived_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, NULL, ?, ?, ?, ?, NULL)
      `).run(
        String(row.name), String(row.mode || 'single'), JSON.stringify(row.program_ids || []),
        JSON.stringify(row.goal_spec || {}), Number(row.autonomy) || 0, JSON.stringify(row.policy || {}),
        String(row.status || 'draft'), row.budget_tokens == null ? null : Number(row.budget_tokens),
        Number(row.budget_window_days) || 7, row.approval_id == null ? null : Number(row.approval_id),
        row.heartbeat_at == null ? null : Number(row.heartbeat_at),
        String(row.created_by || 'system'), repo.now(), repo.now(),
      )
      return Number(r.lastInsertRowid)
    },
    getCampaign(id) {
      const r = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(Number(id))
      return r ? { ...r } : null
    },
    findCampaignByName(name) {
      const r = db.prepare("SELECT * FROM campaigns WHERE name = ? AND status != 'archived' ORDER BY id DESC LIMIT 1").get(String(name))
      return r ? { ...r } : null
    },
    updateCampaign(id, patch, expectStatus) {
      const sets = []
      const args = []
      for (const [k, v] of Object.entries(patch)) { sets.push(`${k} = ?`); args.push(v) }
      sets.push('updated_at = ?'); args.push(repo.now())
      const where = expectStatus ? ' AND status = ?' : ''
      args.push(Number(id))
      if (expectStatus) args.push(expectStatus)
      return db.prepare(`UPDATE campaigns SET ${sets.join(', ')} WHERE id = ?${where}`).run(...args).changes
    },
    listCampaignsWhere({ status = '', program_id = '' } = {}, limit, offset) {
      // 42 号补丁：program_id 过滤下沉 SQL（旧实现先 LIMIT 再 JS 过滤，第 2 页可能为空）。
      let where = '1=1'
      const args = []
      if (status) { where += ' AND status = ?'; args.push(String(status)) }
      if (program_id) { where += ' AND EXISTS (SELECT 1 FROM json_each(campaigns.program_ids) AS je WHERE je.value = ?)'; args.push(String(program_id)) }
      return db.prepare(`SELECT * FROM campaigns WHERE ${where} ORDER BY last_tick_at IS NOT NULL, last_tick_at ASC, id ASC LIMIT ? OFFSET ?`)
        .all(...args, Math.min(Number(limit) || 50, 500), Math.max(0, Number(offset) || 0)).map((r) => ({ ...r }))
    },
    countCampaignsWhere({ status = '', program_id = '' } = {}) {
      let where = '1=1'
      const args = []
      if (status) { where += ' AND status = ?'; args.push(String(status)) }
      if (program_id) { where += ' AND EXISTS (SELECT 1 FROM json_each(campaigns.program_ids) AS je WHERE je.value = ?)'; args.push(String(program_id)) }
      return db.prepare(`SELECT COUNT(*) AS n FROM campaigns WHERE ${where}`).get(...args).n
    },
    // 34 号补丁：域级运行时配置 KV（预算闸在线可调；env 仅作初始值）
    settingGet(key) {
      const r = db.prepare('SELECT value FROM task_settings WHERE key = ?').get(String(key))
      return r ? r.value : null
    },
    settingSet(key, value) {
      db.prepare('INSERT INTO task_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at')
        .run(String(key), String(value), repo.now())
    },
    // 窗口内专项用量：子任务 spent_tokens 和 + 创建数（双预算闸的 campaign 侧口径）
    campaignUsage(campaignId, sinceMs) {
      const since = Number(sinceMs) || 0
      const r = db.prepare(`SELECT COUNT(*) AS tasks_created, COALESCE(SUM(COALESCE(spent_tokens, 0)), 0) AS spent_tokens FROM tasks WHERE campaign_id = ? AND created_at >= ?`)
        .get(Number(campaignId), since)
      return { tasks_created: Number(r?.tasks_created) || 0, spent_tokens: Number(r?.spent_tokens) || 0 }
    },
    activeCampaignTaskCount(campaignId) {
      return Number(db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE campaign_id = ? AND status IN ('queued','running')").get(Number(campaignId)).n) || 0
    },
    // 已完结但未验收的专项子任务（Reviewer 补验通道：事件重放/重启后不丢账）
    unreviewedCampaignTasks(campaignId, limit) {
      return db.prepare(`
        SELECT t.* FROM tasks t
        LEFT JOIN campaign_decisions d ON d.task_id = t.id
        WHERE t.campaign_id = ? AND t.status IN ('done','failed') AND d.task_id IS NULL
        ORDER BY t.finished_at ASC, t.id ASC LIMIT ?
      `).all(Number(campaignId), Math.min(Number(limit) || 50, 200)).map((r) => ({ ...r }))
    },
    insertCampaignDecision(row) {
      try {
        const r = db.prepare(`INSERT INTO campaign_decisions (campaign_id, task_id, verdict, evidence, goal_delta, decided_by, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(Number(row.campaign_id), Number(row.task_id), String(row.verdict), String(row.evidence),
            row.goal_delta == null ? null : (typeof row.goal_delta === 'string' ? row.goal_delta : JSON.stringify(row.goal_delta)),
            String(row.decided_by || 'reviewer'), repo.now())
        return Number(r.lastInsertRowid)
      } catch (e) {
        if (/UNIQUE/i.test(String(e?.message))) return null
        throw e
      }
    },
    getDecisionByTask(taskId) {
      const r = db.prepare('SELECT * FROM campaign_decisions WHERE task_id = ?').get(Number(taskId))
      return r ? { ...r } : null
    },
    listCampaignDecisions(campaignId, verdict, limit, offset) {
      let where = 'd.campaign_id = ?'
      const args = [Number(campaignId)]
      if (verdict) { where += ' AND d.verdict = ?'; args.push(String(verdict)) }
      return db.prepare(`SELECT d.*, t.program_id AS program_id, t.campaign_role AS campaign_role, t.objective AS objective
        FROM campaign_decisions d LEFT JOIN tasks t ON t.id = d.task_id
        WHERE ${where} ORDER BY d.id DESC LIMIT ? OFFSET ?`)
        .all(...args, Math.min(Number(limit) || 50, 500), Math.max(0, Number(offset) || 0)).map((r) => ({ ...r }))
    },
    countCampaignDecisions(campaignId, verdict) {
      let where = 'campaign_id = ?'
      const args = [Number(campaignId)]
      if (verdict) { where += ' AND verdict = ?'; args.push(String(verdict)) }
      return Number(db.prepare(`SELECT COUNT(*) AS n FROM campaign_decisions WHERE ${where}`).get(...args).n) || 0
    },
    insertCheckpoint(row) {
      const r = db.prepare('INSERT INTO campaign_checkpoints (campaign_id, kind, summary, payload, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(Number(row.campaign_id), String(row.kind), row.summary == null ? null : String(row.summary).slice(0, 500),
          row.payload == null ? null : (typeof row.payload === 'string' ? row.payload : JSON.stringify(row.payload)), repo.now())
      return Number(r.lastInsertRowid)
    },
    listCheckpoints(campaignId, limit) {
      return db.prepare('SELECT * FROM campaign_checkpoints WHERE campaign_id = ? ORDER BY id DESC LIMIT ?')
        .all(Number(campaignId), Math.min(Number(limit) || 20, 200)).map((r) => ({ ...r }))
    },

    // 21 号方案 §3-1/§6.2：Intent 派生器 strategy 去重 + 连败黑名单
    // strategy_dedupe：strategy_key PK（host|path|param|class）；fails 连败计数；≥3 连败自动黑名单
    getStrategy(key) {
      try {
        const r = db.prepare('SELECT * FROM strategy_dedupe WHERE strategy_key = ?').get(String(key))
        return r ? { ...r } : null
      } catch { return null }
    },
    upsertStrategy(key, patch) {
      const now = repo.now()
      // 41 号补丁：INSERT 也要落 last_task_id（旧实现硬编码 NULL，去重回显 task_id 恒 null）
      db.prepare(`INSERT INTO strategy_dedupe (strategy_key, program_id, first_seen, last_seen, fails, blacklisted, last_task_id, reopen_after)
        VALUES (?, ?, ?, ?, 0, 0, ?, NULL)
        ON CONFLICT (strategy_key) DO UPDATE SET last_seen = ?, last_task_id = COALESCE(?, last_task_id), reopen_after = NULL`)
        .run(String(key), String(patch.program_id || ''), now, now, patch.last_task_id ?? null, now, patch.last_task_id ?? null)
    },
    markStrategyOutcome(key, ok, taskId) {
      const now = repo.now()
      if (ok) {
        db.prepare('UPDATE strategy_dedupe SET fails = 0, last_seen = ?, last_task_id = ? WHERE strategy_key = ?').run(now, taskId ?? null, String(key))
      } else {
        db.prepare('UPDATE strategy_dedupe SET fails = fails + 1, last_seen = ?, last_task_id = ? WHERE strategy_key = ?').run(now, taskId ?? null, String(key))
        db.prepare('UPDATE strategy_dedupe SET blacklisted = 1 WHERE strategy_key = ? AND fails >= 3').run(String(key))
      }
    },
    // 22 号方案：rework 后按冷却时间重开策略（Planner 可在 reopen_after 之后重试同一打法）
    reopenStrategy(key, reopenAfterMs) {
      if (!key) return 0
      return db.prepare('UPDATE strategy_dedupe SET reopen_after = ? WHERE strategy_key = ?').run(Number(reopenAfterMs) || 0, String(key)).changes
    },
    // 22 号方案 §7.3：Planner 连败/黑名单快照（program 维度过滤；含 campaign 前缀键的裸键回退）
    listStrategies(programIds) {
      try {
        if (Array.isArray(programIds) && programIds.length) {
          const marks = programIds.map(() => '?').join(',')
          return db.prepare(`SELECT * FROM strategy_dedupe WHERE program_id IN (${marks})`).all(...programIds.map(String)).map((r) => ({ ...r }))
        }
        return db.prepare('SELECT * FROM strategy_dedupe').all().map((r) => ({ ...r }))
      } catch { return [] }
    },
    claimDueTasks(nowTs, limit) {
      const due = selectDueTasks(db, nowTs, limit)
      // interval 行缺 run_at 时在认领时回填 next_run_at，防止 run_now 覆写 next_run_at 后续期锚点永久丢失
      const upd = db.prepare(
        "UPDATE tasks SET status = 'running', started_at = ?, updated_at = ?, run_at = CASE WHEN schedule_kind='interval' AND (run_at IS NULL OR run_at <= 0) THEN COALESCE(next_run_at, ?) ELSE run_at END WHERE id = ? AND status = 'queued'"
      )
      const claimed = []
      for (const row of due) {
        const r = upd.run(nowTs, nowTs, nowTs, row.id)
        if (r.changes === 1) claimed.push(row.id)
      }
      if (!claimed.length) return []
      const marks = claimed.map(() => '?').join(',')
      return db.prepare(`SELECT * FROM tasks WHERE id IN (${marks})`).all(...claimed).map((r) => ({ ...r }))
    },
    reserveTaskBudget(task, nowTs, programLimit) {
      const tokens = task.budget_tokens ?? 150000
      if (!Number.isSafeInteger(tokens) || tokens <= 0) return 'E_TASK_BUDGET_REQUIRED'
      const reserved = (column, value) => Number(db.prepare(`SELECT COALESCE(SUM(MAX(0,r.tokens-COALESCE(c.spent_tokens,0))),0) n
        FROM task_budget_reservations r JOIN tasks t ON t.id=r.task_id
        LEFT JOIN task_run_costs c ON c.task_id=r.task_id AND c.run_id=r.run_id
        WHERE t.${column}=? AND r.state IN ('reserved','unknown')`).get(value).n)
      // Legacy consumption has no reliable consumption timestamp. Keep it in the
      // admission total, rather than silently erasing it as a window rolls.
      const spent = (column, value, since) => Number(db.prepare(`SELECT
        COALESCE((SELECT SUM(spent_tokens) FROM tasks WHERE ${column}=?),0) -
        COALESCE((SELECT SUM(b.tokens) FROM task_bill_items b JOIN tasks t ON t.id=b.task_id
          WHERE t.${column}=? AND b.consumed_at<?),0) n`).get(value, value, since).n)
      const periodDays = Number(repo.settingGet('budget_period_days')) || 7
      if (spent('program_id', task.program_id, nowTs - periodDays * 86400000) + reserved('program_id', task.program_id) + tokens > programLimit) return 'E_TASK_BUDGET_EXHAUSTED'
      if (task.campaign_id != null) {
        const c = repo.getCampaign(task.campaign_id)
        if (!c || c.status !== 'active') return 'E_CAMPAIGN_STATE'
        if (c.budget_tokens == null || spent('campaign_id', c.id, nowTs - c.budget_window_days * 86400000) + reserved('campaign_id', c.id) + tokens > c.budget_tokens) return 'E_CAMPAIGN_BUDGET_LOW'
      }
      db.prepare('INSERT INTO task_budget_reservations(task_id,claim_started_at,tokens,created_at) VALUES(?,?,?,?)')
        .run(task.id, nowTs, tokens, nowTs)
      return null
    },
    getBudgetReservation(taskId, claim) {
      return db.prepare('SELECT * FROM task_budget_reservations WHERE task_id=? AND claim_started_at=?').get(taskId, claim) || null
    },
    finishBudgetReservation(taskId, claim, state) {
      db.prepare("UPDATE task_budget_reservations SET state=? WHERE task_id=? AND claim_started_at=? AND state IN ('reserved','unknown')")
        .run(state, taskId, claim)
    },
    closeBudgetReservation(taskId, claim, expected, billed) {
      const state = expected != null && billed != null && billed >= expected ? 'settled' : 'unknown'
      db.prepare(`UPDATE task_budget_reservations SET state=?,expected_tokens=?,tokens=COALESCE(?,tokens)
        WHERE task_id=? AND claim_started_at=? AND state IN ('reserved','unknown')`)
        .run(state, expected, expected, taskId, claim)
    },
    runningWorkerCount() {
      return Number(db.prepare("SELECT COUNT(*) n FROM workers WHERE status='running'").get().n)
    },
    bindBudgetReservation(taskId, claim, runId) {
      const r = repo.getBudgetReservation(taskId, claim)
      if (!r || r.state !== 'reserved' || r.run_id && r.run_id !== runId) return false
      db.prepare('UPDATE task_budget_reservations SET run_id=? WHERE task_id=? AND claim_started_at=?').run(runId, taskId, claim)
      return true
    },
    budgetSlotCount() {
      return Number(db.prepare("SELECT COUNT(*) n FROM task_budget_reservations WHERE state='reserved'").get().n)
    },
    costReconcileCandidates(afterId, limit) {
      return db.prepare(`SELECT r.task_id,r.run_id,r.session_id,r.id FROM task_cost_watch r
        LEFT JOIN task_run_costs c ON c.task_id=r.task_id AND c.run_id=r.run_id
        WHERE r.id>? AND (c.task_id IS NULL OR c.source IN ('session_bill','session_evidence'))
        ORDER BY r.id LIMIT ?`).all(afterId, limit).map(r => ({ ...r }))
    },
    importBillItems(taskId, runId, items) {
      const insert = db.prepare(`INSERT INTO task_bill_items(receipt_key,task_id,run_id,tokens,consumed_at) VALUES(?,?,?,?,?)
        ON CONFLICT(receipt_key) DO UPDATE SET tokens=MAX(task_bill_items.tokens,excluded.tokens)
        WHERE task_bill_items.task_id=excluded.task_id AND task_bill_items.run_id=excluded.run_id`)
      for (const item of items) insert.run(item.key, taskId, runId, item.tokens, item.time)
      return Number(db.prepare('SELECT COALESCE(SUM(tokens),0) n FROM task_bill_items WHERE task_id=? AND run_id=?').get(taskId, runId).n)
    },
    getCostWatch(taskId, runId) {
      return db.prepare('SELECT session_id FROM task_cost_watch WHERE task_id=? AND run_id=?').get(taskId, runId) || null
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
      // 42 号补丁（25 号方案 B1）：4 个关联子查询改为一次 LEFT JOIN 聚合 + LIMIT 500（旧实现每行 4 次子查询、无上限）。
      return db.prepare(
        `SELECT t.*,
           COALESCE(agg.run_count, 0) AS run_count,
           COALESCE(agg.fail_count, 0) AS fail_count,
           last.ok AS last_ok,
           last.note AS last_note
         FROM tasks t
         LEFT JOIN (
           SELECT task_id, COUNT(*) AS run_count, SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS fail_count
           FROM task_runs GROUP BY task_id
         ) agg ON agg.task_id = t.id
         LEFT JOIN task_runs last ON last.id = (
           SELECT r2.id FROM task_runs r2 WHERE r2.task_id = t.id ORDER BY r2.id DESC LIMIT 1
         )
         WHERE t.schedule_kind = 'interval' AND t.status NOT IN ('done', 'failed', 'cancelled')
         ORDER BY t.next_run_at ASC
         LIMIT 500`
      ).all().map((r) => ({ ...r }))
    },
    scheduledProgress(task, at) { return scheduledProgress(db, task, at) },
    reapStale(maxAgeMs, pidAliveFn, nowTs) {
      const cutoff = nowTs - maxAgeMs
      // 回收所有超预算且无活 worker 的 running 任务（含一次性任务：schedule_kind IS NULL）。
      // 旧实现仅回收定时任务，一次性 running 任务崩溃后无租约→永久僵尸（2026-09-19 修复）。
      const stale = db.prepare(
        "SELECT * FROM tasks WHERE status = 'running' AND started_at IS NOT NULL AND started_at < ?"
      ).all(cutoff).map((r) => ({ ...r }))
      const alive = pidAliveFn || (() => false)
      let reaped = 0
      let skipped = 0
      const runs = []
      for (const t of stale) {
        if (reaped >= 4) break // domain publishes one terminal fact per recovered run, event_limit=4
        if (withinTaskBudget(t, nowTs, maxAgeMs) || taskWorkerAlive(db, t, alive)) { skipped++; continue }
        const status = t.schedule_kind === 'interval' ? 'queued' : 'failed'
        const nextRunAt = status === 'queued' ? nextScheduledRun(t, nowTs, false, scheduledProgress(db, t, t.started_at).attempts) : null
        const runId = t.active_run_id || ''
        const r = db.prepare("UPDATE tasks SET status = ?, active_run_id = NULL, last_run_id = ?, last_run_at = ?, next_run_at = ?, blocked_reason = '宿主重启/超时回收', updated_at = ? WHERE id = ? AND status = 'running'")
          .run(status, runId || null, nowTs, nextRunAt, nowTs, t.id)
        if (r.changes === 1) {
          reaped++
          repo.insertTaskRun({ task_id: t.id, run_id: runId, ok: false, note: '宿主重启/超时回收', started_at: t.started_at, finished_at: nowTs, session_id: null })
          runs.push({ task: t, run_id: runId, status, next_run_at: nextRunAt })
        }
      }
      return { reaped, skipped_alive: skipped, runs }
    },

    // ---- task_runs ----
    getRunCost(taskId, runId) {
      return db.prepare('SELECT * FROM task_run_costs WHERE task_id=? AND run_id=?').get(Number(taskId), runId) || null
    },
    getCostEvidence(taskId, runId, sha) {
      return db.prepare('SELECT * FROM task_cost_evidence WHERE task_id=? AND run_id=? AND evidence_sha256=?')
        .get(taskId, runId, sha) || null
    },
    costEvidenceBaseline(taskId) {
      const ledger = Number(db.prepare('SELECT COALESCE(SUM(spent_tokens),0) n FROM task_run_costs WHERE task_id=?').get(taskId).n)
      const legacy = Number(db.prepare(`SELECT COUNT(*) n FROM task_runs r
        LEFT JOIN task_run_costs c ON c.task_id=r.task_id AND c.run_id=r.run_id
        WHERE r.task_id=? AND r.spent_tokens>0 AND c.task_id IS NULL`).get(taskId).n)
      return { ledger_tokens: ledger, legacy_positive_runs: legacy }
    },
    insertCostEvidence(row) {
      db.prepare(`INSERT INTO task_cost_evidence(task_id,run_id,evidence_sha256,session_id,session_sha256,
        lower_bound_tokens,previous_tokens,delta_tokens,recorded_at) VALUES(?,?,?,?,?,?,?,?,?)`)
        .run(row.task_id, row.run_id, row.evidence_sha256, row.session_id, row.session_sha256,
          row.lower_bound_tokens, row.previous_tokens, row.delta_tokens, row.recorded_at)
    },
    getTaskRun(taskId, runId) {
      return db.prepare('SELECT * FROM task_runs WHERE task_id=? AND run_id=? ORDER BY id DESC LIMIT 1').get(Number(taskId), runId) || null
    },
    sessionUsedByOtherRun(sessionId, taskId, runId) {
      if (!sessionId) return false
      return !!db.prepare('SELECT 1 FROM task_runs WHERE session_id=? AND NOT (task_id=? AND run_id=?) LIMIT 1').get(String(sessionId), Number(taskId), runId)
        || !!db.prepare('SELECT 1 FROM task_run_costs WHERE session_id=? AND NOT (task_id=? AND run_id=?) LIMIT 1').get(String(sessionId), Number(taskId), runId)
        || !!db.prepare('SELECT 1 FROM task_cost_watch WHERE session_id=? AND NOT (task_id=? AND run_id=?) LIMIT 1').get(String(sessionId), Number(taskId), runId)
        || !!db.prepare('SELECT 1 FROM workers WHERE worker_session_id=? AND task_id IS NOT NULL AND NOT (task_id=? AND run_id=?) LIMIT 1').get(String(sessionId), Number(taskId), runId)
    },
    settleRunCost({ task_id, run_id, spent_tokens, session_id, source, consumed_at, recorded_at, releaseReservation = true }) {
      const previous = repo.getRunCost(task_id, run_id)
      const delta = spent_tokens - (previous?.spent_tokens || 0)
      db.prepare(`INSERT INTO task_run_costs(task_id,run_id,spent_tokens,session_id,source,consumed_at,recorded_at)
        VALUES(?,?,?,?,?,?,?) ON CONFLICT(task_id,run_id) DO UPDATE SET
        spent_tokens=excluded.spent_tokens, session_id=COALESCE(task_run_costs.session_id,excluded.session_id),
        source=excluded.source, consumed_at=COALESCE(task_run_costs.consumed_at,excluded.consumed_at),recorded_at=excluded.recorded_at`)
        .run(task_id, run_id, spent_tokens, session_id ?? null, source, consumed_at ?? null, recorded_at)
      db.prepare('UPDATE task_runs SET spent_tokens=? WHERE task_id=? AND run_id=?').run(spent_tokens, task_id, run_id)
      if (delta) db.prepare('UPDATE tasks SET spent_tokens=COALESCE(spent_tokens,0)+? WHERE id=?').run(delta, task_id)
      if (releaseReservation) db.prepare(`UPDATE task_budget_reservations SET state='settled'
        WHERE task_id=? AND run_id=? AND state='unknown' AND expected_tokens IS NOT NULL AND expected_tokens<=?`)
        .run(task_id, run_id, spent_tokens)
      const task = repo.getTask(task_id)
      if (task?.campaign_id != null) db.prepare(`UPDATE campaigns SET spent_tokens=
        (SELECT COALESCE(SUM(spent_tokens),0) FROM tasks WHERE campaign_id=?) WHERE id=?`).run(task.campaign_id, task.campaign_id)
      return { delta, first: !previous }
    },
    listRunCosts({ task_id, limit = 50, offset = 0 }) {
      const where = task_id == null ? '' : ' WHERE task_id=?', args = task_id == null ? [] : [task_id]
      return { rows: db.prepare(`SELECT * FROM task_run_costs${where} ORDER BY recorded_at DESC,task_id,run_id LIMIT ? OFFSET ?`).all(...args, limit, offset).map(r => ({ ...r })),
        total: db.prepare(`SELECT COUNT(*) n FROM task_run_costs${where}`).get(...args).n, meta: { paged: true } }
    },
    hasTaskRun(taskId, runId) {
      return !!db.prepare('SELECT 1 FROM task_runs WHERE task_id=? AND run_id=?').get(Number(taskId), runId)
    },
    insertTaskRun(row) {
      const started = row.started_at ?? null
      const finished = row.finished_at ?? null
      const duration = (started && finished) ? finished - started : null
      const r = db.prepare('INSERT INTO task_runs (task_id, run_id, ok, note, started_at, finished_at, duration_ms, session_id, spent_tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(Number(row.task_id), String(row.run_id || ''), row.ok ? 1 : 0, String(row.note || '').slice(0, 500), started, finished, duration, row.session_id ?? null, row.spent_tokens ?? null)
      if (row.run_id && row.session_id) db.prepare('INSERT OR IGNORE INTO task_cost_watch(task_id,run_id,session_id) VALUES(?,?,?)')
        .run(row.task_id, row.run_id, row.session_id)
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
      db.prepare('UPDATE workers SET task_id=?,claim_started_at=? WHERE run_id=?').run(row.task_id ?? null, row.claim_started_at ?? null, String(row.run_id))
      return { changed: true }
    },
    bindClaimedWorker(taskId, claimStartedAt, runId) {
      return db.prepare("UPDATE tasks SET active_run_id=? WHERE id=? AND status='running' AND started_at=? AND (active_run_id IS NULL OR active_run_id=?)")
        .run(runId, taskId, claimStartedAt, runId).changes
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
            status = meta.timed_out || meta.cancelled || meta.signal ? 'killed' : meta.exit_code === 0 && !meta.error ? 'done' : 'failed'
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

function taskWhere({ program_id = '', status = '', phase = '', q = '', bucket = '', scheduled = '', goal = '', campaign_id = '' }) {
  let where = '1=1'
  const args = []
  if (program_id) { where += ' AND program_id = ?'; args.push(String(program_id)) }
  if (status) { where += ' AND status = ?'; args.push(String(status)) }
  if (phase) { where += ' AND phase = ?'; args.push(String(phase)) }
  if (goal) { where += ' AND goal = ?'; args.push(String(goal)) }
  if (campaign_id) { where += ' AND campaign_id = ?'; args.push(Number(campaign_id)) }
  if (q) { where += ' AND objective LIKE ?'; args.push(`%${q}%`) }
  if (bucket === 'active') where += " AND status IN ('queued', 'running', 'blocked')"
  else if (bucket === 'history') where += " AND status IN ('done', 'failed', 'cancelled')"
  // scheduled=exclude：非周期任务（普通 NULL + 一次性 once，属执行/队列语义）
  // scheduled=only：周期任务（interval，属「定时任务」卡片区）
  if (scheduled === 'exclude') where += " AND (schedule_kind IS NULL OR schedule_kind = 'once')"
  else if (scheduled === 'only') where += " AND schedule_kind = 'interval'"
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
import { selectDueTasks, scheduledProgress, nextScheduledRun, taskWorkerAlive, withinTaskBudget } from '../sec-suite/task-policy.js'
