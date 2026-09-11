// ==============================================================================
// @silksec/sec-domain-task — SilkSecAgent task 域插件（v5 Phase 2.4：任务/调度/执行史/worker 注册表）
//
// 契约：doc/secagent/v5/05-task.md（域设计，权威）+ 01-bus.md + 00-conventions.md
//
// 对外（cordis）：name='sec-domain-task'，apply() 把 manifest+handlers+backend 交给
// 总线 registry.register()（不 provide 业务方法——防绕过核心承诺）。
//
// 语义要点：
//  - 收尾权唯一归 task_finish（actor=scheduler）与 task_complete（actor=approval，自执行任务）；
//  - interval 任务 latest-only 续期以标称锚点 run_at 为相位基准（绝不漂移）；
//  - worker 注册表经订阅 exec.worker.spawned/finished（强联动 sync）记账——本域不直接 spawn；
//  - 流程守卫（INV-T6）经 ledger 域查询 ledger_task_proof 执行，失败不拒事务、进 ok=0 + 红条；
//  - 调度器单例（文件锁 data/scheduler.lock，与 v4 调度器互斥——观察期 v4 持锁，本域休眠）。
// ==============================================================================

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

export const name = 'sec-domain-task'
export const version = '1.0.0'

const DEFAULT_DATA_DIR = process.env.SEC_DATA_DIR || '/opt/silkspool/dsh/data'

const log = (msg) => { try { process.stderr.write(`[sec-domain-task] ${msg}\n`) } catch { /* noop */ } }

const backendUrl = new URL('../sec-backend-task-sqlite/index.js', import.meta.url)
const { createTaskSqliteBackend } = await import(backendUrl.href)

const TASK_STATUS = ['queued', 'running', 'blocked', 'done', 'failed', 'cancelled']
const TERMINAL = new Set(['done', 'failed', 'cancelled'])
const MIN_INTERVAL_SECONDS = 300
const OUTCOME_ENUM = ['done', 'failed', 'busy', 'crash']
const SCHEDULER_TICK_MS = 60000
const SCHEDULER_TASK_TIMEOUT_SEC = 3600
const WORKER_DEDUPE_WINDOW_MS = 30 * 60 * 1000
const INTRUSIVE_WORDS = /(intrusive|主动利用|getshell|写入|破坏性)/i

// ---------------------------------------------------------------------------
// manifest（05-task §1.2/§1.4/§1.5 的机器形态）
// ---------------------------------------------------------------------------

const schema = (properties, required, extra = {}) => ({ type: 'object', properties, required, additionalProperties: false, ...extra })
const str = (opts = {}) => ({ type: 'string', ...opts })
const en = (values, extra = {}) => ({ type: 'string', enum: values, ...extra })
const int = (opts = {}) => ({ type: 'integer', ...opts })

const scheduleSchema = (allowNull = false) => ({
  type: allowNull ? ['object', 'null'] : 'object',
  properties: {
    kind: en(['once', 'interval']),
    at: int(),
    every_seconds: int(),
  },
  required: allowNull ? [] : ['kind'],
  additionalProperties: false,
})

export const TASK_MANIFEST = {
  domain: 'task',
  version: 1,
  service: 'secDomain.task',
  description: '任务/调度/执行史/worker 注册表——编排器派发的工作单元与调度循环的单一真相源，收尾权唯一归调度器/审批',
  owns: {
    tables: ['tasks', 'task_runs', 'workers'],
    files: ['data/scheduler.lock', 'data/events/task.jsonl'],
  },
  commands: {
    task_create: {
      actor: ['model', 'dashboard', 'script', 'approval', 'system'],
      schema: schema({
        program_id: str(),
        objective: str({ maxLength: 4000 }),
        phase: str({ default: '' }),
        priority: int({ minimum: 0, maximum: 9 }),
        parent_id: int(),
        budget_tokens: int({ minimum: 0 }),
        assignee: str({ default: '' }),
        schedule: scheduleSchema(),
        provider: str(),
        model: str(),
        reasoning_effort: en(['low', 'medium', 'high']),
      }, ['objective']),
      idempotent: 'auto',
      idempotent_fields: ['program_id', 'objective', 'phase', 'priority', 'parent_id', 'budget_tokens', 'assignee', 'schedule', 'provider', 'model', 'reasoning_effort'],
      events: ['task.created'],
      event_limit: 1,
      invariants: ['scheduleValid', 'intrusiveInterval'],
      timeout_ms: 60000,
      agent_note: '创建任务（看板任务视图立即可见）。program_id 不传则按会话工作区自动带出；phase: recon/vuln/biz-logic/code-audit/intranet/review；priority 0 最高。定时任务传 schedule（{kind:"once",at} 或 {kind:"interval",every_seconds:>=300}）。',
      deprecated: false,
    },
    task_schedule: {
      actor: ['model', 'dashboard'],
      schema: schema({
        task_id: int(),
        schedule: scheduleSchema(true),
      }, ['task_id', 'schedule']),
      idempotent: 'auto',
      idempotent_fields: ['task_id', 'schedule'],
      events: [],
      invariants: ['scheduleValid', 'intrusiveInterval', 'terminalImmutable'],
      timeout_ms: 60000,
      agent_note: '设置/修改/清除任务的定时调度（schedule 传 null 清除变普通任务）。终态任务不可改。修改 every_seconds 后续期锚点仍为原 run_at（节律相位不重置）。',
      deprecated: false,
    },
    task_run_now: {
      actor: ['model', 'dashboard'],
      schema: schema({ task_id: int() }, ['task_id']),
      idempotent: 'auto',
      idempotent_fields: ['task_id'],
      events: [],
      invariants: ['runNowQueued'],
      timeout_ms: 60000,
      agent_note: '立即触发一次任务（不动调度节律）：排入调度队列，下一 tick（≤60s）认领执行。手动提前跑 interval 不会跳过原定运行。',
      deprecated: false,
    },
    task_update_note: {
      actor: ['model', 'dashboard', 'scheduler', 'script'],
      schema: schema({ task_id: int(), note: str({ minLength: 1, maxLength: 2000 }) }, ['task_id', 'note']),
      idempotent: 'auto',
      idempotent_fields: ['task_id', 'note'],
      events: [],
      invariants: [],
      timeout_ms: 60000,
      agent_note: '向任务 result 证据链追加一条带时间戳记录（不改状态）。用于执行中途记录结论/补录证据指针/说明阻塞背景。终态任务允许追加。',
      deprecated: false,
    },
    task_block: {
      actor: ['model', 'dashboard'],
      schema: schema({ task_id: int(), blocked_reason: str({ minLength: 1, maxLength: 500 }), note: str({ default: '' }) }, ['task_id', 'blocked_reason']),
      idempotent: 'auto',
      idempotent_fields: ['task_id', 'blocked_reason', 'note'],
      events: ['task.blocked'],
      event_limit: 1,
      invariants: [],
      timeout_ms: 60000,
      agent_note: '暂停一个任务（HITL 阻塞，调度器不再认领）。blocked_reason 必填（等授权/等审批/等人工确认…），恢复时据此判断。',
      deprecated: false,
    },
    task_resume: {
      actor: ['model', 'dashboard'],
      schema: schema({ task_id: int() }, ['task_id']),
      idempotent: 'auto',
      idempotent_fields: ['task_id'],
      events: [],
      invariants: [],
      timeout_ms: 60000,
      agent_note: '恢复被阻塞（blocked）的任务回队列。节律不变：阻塞期间错过的周期不补跑。',
      deprecated: false,
    },
    task_cancel: {
      actor: ['model', 'dashboard'],
      schema: schema({ task_id: int(), note: str({ default: '' }) }, ['task_id']),
      idempotent: 'auto',
      idempotent_fields: ['task_id', 'note'],
      events: ['task.cancelled'],
      event_limit: 1,
      invariants: [],
      timeout_ms: 60000,
      agent_note: '取消一个任务（任意非终态 → cancelled，不可逆）。在飞 worker 不强杀——其结果仅补进执行史。',
      deprecated: false,
    },
    task_finish: {
      actor: ['scheduler'],
      schema: schema({
        task_id: int(),
        run_id: str({ default: '' }),
        outcome: en(OUTCOME_ENUM),
        note: str({ default: '' }),
        session_id: str(),
        truth: { type: 'object' },
      }, ['task_id', 'outcome']),
      idempotent: 'natural',
      idempotent_natural: ['task_id', 'run_id'],
      events: ['task.finished'],
      event_limit: 1,
      invariants: ['finishEvidence'],
      timeout_ms: 60000,
      agent_note: '调度器专用收尾：真实性判定 + 流程守卫 + 落执行史 + interval 续期。',
      deprecated: false,
    },
    task_chain: {
      actor: ['model', 'dashboard'],
      schema: schema({
        program_id: str(),
        objective: str({ default: '' }),
        want: str({ default: 'findings' }),
        have: { type: 'array', items: { type: 'string' } },
        priority: int({ minimum: 0, maximum: 9 }),
        parent_id: int(),
      }, []),
      idempotent: 'auto',
      idempotent_fields: ['program_id', 'objective', 'want', 'have', 'priority', 'parent_id'],
      events: ['task.created'],
      event_limit: 100,
      invariants: ['chainProgram'],
      timeout_ms: 60000,
      agent_note: '一条 objective 自动展开为任务依赖链：复用能力图 exec_plan_chain 凑链+反向剪枝，落成 parent 串联的 once 调度任务。默认 have=["domains"]、want=findings。',
      deprecated: false,
    },
    task_budget_extend: {
      actor: ['approval'],
      schema: schema({ task_id: int(), budget_timeout_sec: int({ minimum: 1, maximum: 7200 }), approval_id: int() }, ['task_id', 'budget_timeout_sec', 'approval_id']),
      idempotent: 'natural',
      idempotent_natural: ['task_id'],
      events: [],
      invariants: [],
      timeout_ms: 60000,
      agent_note: 'task-budget-extend 审批批准后的落列动作（approval 域经 dispatcher 幂等执行；不向模型注册）。',
      deprecated: false,
    },
    task_claim: {
      actor: ['scheduler'],
      schema: schema({ now: int() }, ['now']),
      idempotent: 'none',
      events: ['task.claimed'],
      event_limit: 4,
      invariants: [],
      timeout_ms: 60000,
      agent_note: '调度认领：原子抢占 ≤4 条到期任务（内部，不向模型注册）。',
      deprecated: false,
    },
    task_reap: {
      actor: ['scheduler'],
      schema: schema({ max_age: int(), pid_alive: { type: 'boolean' } }, ['max_age']),
      idempotent: 'none',
      events: ['task.finished'],
      event_limit: 4,
      invariants: [],
      timeout_ms: 60000,
      agent_note: '僵尸回收：宽限=超时+15min，活 worker 跳过（内部，不向模型注册）。',
      deprecated: false,
    },
    task_worker_register: {
      actor: ['reactor', 'scheduler'],
      schema: schema({
        run_id: str({ minLength: 1 }),
        dedupe_key: str(),
        task: str(),
        cwd: str(),
        pid: int(),
        timeout_sec: int(),
        session_id: str(),
        run_dir: str(),
      }, ['run_id']),
      idempotent: 'natural',
      idempotent_natural: ['run_id'],
      events: [],
      invariants: [],
      timeout_ms: 60000,
      agent_note: 'worker 注册表登记（订阅 exec.worker.spawned 强联动执行；不向模型注册）。',
      deprecated: false,
    },
    task_worker_finish: {
      actor: ['reactor', 'scheduler'],
      schema: schema({ run_id: str({ minLength: 1 }), outcome: en(['done', 'failed', 'killed']), exit_code: int() }, ['run_id', 'outcome']),
      idempotent: 'natural',
      idempotent_natural: ['run_id'],
      events: [],
      invariants: [],
      timeout_ms: 60000,
      agent_note: 'worker 注册表收尾（订阅 exec.worker.finished 强联动执行；不向模型注册）。',
      deprecated: false,
    },
    task_worker_reap: {
      actor: ['scheduler'],
      schema: schema({}, []),
      idempotent: 'none',
      events: [],
      invariants: [],
      timeout_ms: 60000,
      agent_note: 'worker 注册表启动/周期对账（内部，不向模型注册）。',
      deprecated: false,
    },
    task_submit_complete: {
      actor: ['model'],
      schema: schema({
        task_id: int(),
        summary: str({ minLength: 30 }),
        evidence: { type: 'array', items: { type: 'string' } },
        follow_up: str({ maxLength: 500 }),
      }, ['task_id', 'summary']),
      idempotent: 'auto',
      idempotent_fields: ['task_id', 'summary', 'evidence', 'follow_up'],
      events: [],
      invariants: ['submitCompleteValid'],
      timeout_ms: 60000,
      agent_note: '自执行任务完成声明（不改状态）：summary ≥30 字 + evidence 产物指针，提请 task-complete 审批。声明后任务保持 in_progress 等人工确认，绝不自行标记完成。',
      deprecated: false,
    },
    task_complete: {
      actor: ['approval'],
      schema: schema({ task_id: int(), request_id: int(), summary: str() }, ['task_id', 'request_id']),
      idempotent: 'natural',
      idempotent_natural: ['task_id'],
      events: ['task.finished'],
      event_limit: 1,
      invariants: [],
      timeout_ms: 60000,
      agent_note: '审批落成收尾（approval.approved kind=task-complete 订阅执行，自执行任务唯一 done 入口；不向模型注册）。',
      deprecated: false,
    },
  },
  queries: {
    task_list: {
      actor: ['model', 'dashboard', 'human', 'system'],
      params: schema({
        program_id: str({ default: '' }),
        status: str({ default: '' }),
        phase: str({ default: '' }),
        q: str({ default: '' }),
        bucket: en(['active', 'history'], { default: '' }),
        scheduled: en(['only', 'exclude'], { default: '' }),
        limit: int({ minimum: 1, maximum: 500 }),
        offset: int({ minimum: 0 }),
        sort: en(['priority', 'created_at'], { default: 'priority' }),
        dir: en(['asc', 'desc'], { default: 'asc' }),
      }, []),
      agent_note: '列出任务（看板数据源）。按 program/status/phase/bucket(active|history)/scheduled(only|exclude) 过滤，priority 升序。',
    },
    task_get: {
      actor: ['model', 'dashboard', 'human', 'system', 'reactor'],
      params: schema({ task_id: int() }, ['task_id']),
      agent_note: '取单个任务全列（调度/预算/模型覆盖/最近 run/证据链尾部）。',
    },
    task_next: {
      actor: ['model', 'dashboard'],
      params: schema({ program_id: str({ minLength: 1 }) }, ['program_id']),
      agent_note: '编排器认领：指定 program 下最高优先级、无未完成父任务的 queued 任务。无则 null。',
    },
    task_stats: {
      actor: ['model', 'dashboard', 'human'],
      params: schema({ program_id: str({ minLength: 1 }) }, ['program_id']),
      agent_note: '任务进度总览：按 phase×status 计数 + 总数。',
    },
    task_runs: {
      actor: ['model', 'dashboard', 'human'],
      params: schema({
        task_id: int({ default: 0 }),
        program_id: str({ default: '' }),
        limit: int({ minimum: 1, maximum: 500 }),
        offset: int({ minimum: 0 }),
      }, []),
      agent_note: '任务执行历史（每任务保留 200 行）：run_id/ok/note/时长/会话，可按 task 或 program 过滤。',
    },
    task_scheduled: {
      actor: ['model', 'dashboard', 'human'],
      params: schema({}, []),
      agent_note: '固定定时任务清单（卡片数据源）：未终态+带调度，附运行统计。',
    },
    task_worker_list: {
      actor: ['model', 'dashboard', 'human'],
      params: schema({ status: en(['running', 'done', 'failed', 'killed'], { default: '' }), limit: int({ minimum: 1, maximum: 200 }) }, []),
      agent_note: '列出最近的 spawn_worker run（可按 status 过滤），总览在飞/历史 worker。',
    },
    task_worker_status: {
      actor: ['model', 'dashboard', 'human'],
      params: schema({ run_id: str({ minLength: 1 }) }, ['run_id']),
      agent_note: '查询某个 spawn_worker run 的结局（running/done/failed/killed）+ 恢复指引。尾部日志用 grep_result/page_result 取。',
    },
    task_worker_recent: {
      actor: ['system', 'scheduler', 'dashboard'],
      params: schema({ dedupe_key: str({ minLength: 1 }), window_ms: int({ minimum: 1000 }) }, ['dedupe_key']),
      agent_note: 'exec 域幂等预检专用（跨域只读）：窗口内该 dedupe_key 最近一条。',
    },
    task_active_by_session: {
      actor: ['system', 'scheduler', 'dashboard', 'reactor'],
      params: schema({ session_id: str({ minLength: 1 }), max_age_ms: int() }, ['session_id']),
      agent_note: '会话→运行中任务反查（内部）。',
    },
    task_drift: {
      actor: ['system', 'dashboard', 'human'],
      params: schema({}, []),
      agent_note: '调度漂移指标 + 执行史新鲜度（ledger 域纪律视图消费）。',
    },
  },
  events: {
    'task.created': { payload: { type: 'object' }, redact: [] },
    'task.claimed': { payload: { type: 'object' }, redact: [] },
    'task.finished': { payload: { type: 'object' }, redact: [] },
    'task.blocked': { payload: { type: 'object' }, redact: [] },
    'task.cancelled': { payload: { type: 'object' }, redact: [] },
  },
  subscribes: {
    'scope.granted': { handler: 'onScopeGranted', mode: 'async', as: 'reactor' },
    'exec.worker.spawned': { handler: 'onWorkerSpawned', mode: 'sync', as: 'reactor' },
    'exec.worker.finished': { handler: 'onWorkerFinished', mode: 'sync', as: 'reactor' },
  },
  backend: 'repository-v1',
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

function normalizeSchedule(schedule, nowTs) {
  if (!schedule) return { kind: null, run_at: null, every_seconds: null, next_run_at: null }
  const kind = String(schedule.kind || '')
  if (kind === 'once') {
    const at = Number(schedule.at)
    if (!Number.isFinite(at) || at <= nowTs) return { error: 'once 调度需要未来的 at 时间戳（毫秒）', code: 'E_TASK_SCHEDULE_PAST' }
    return { kind, run_at: at, every_seconds: null, next_run_at: at }
  }
  if (kind === 'interval') {
    const every = Number(schedule.every_seconds)
    if (!Number.isInteger(every) || every < MIN_INTERVAL_SECONDS) return { error: `interval 调度需要 every_seconds ≥ ${MIN_INTERVAL_SECONDS} 的整数`, code: 'E_TASK_INTERVAL_MIN' }
    return { kind, run_at: null, every_seconds: every, next_run_at: nowTs + every * 1000 }
  }
  return { error: `非法 schedule.kind: ${kind || '(空)'}`, code: 'E_SCHEMA' }
}

// interval latest-only 续期锚点算法（05-task §1.3.1 C8，含全部防漂移注释）
function nextRunAfterInterval(t, finished, ok) {
  const step = t.every_seconds * 1000
  const anchor = (t.run_at && t.run_at > 0) ? t.run_at : (t.next_run_at || finished)
  let next
  if (finished <= anchor) {
    next = anchor
  } else {
    next = anchor + Math.max(1, Math.ceil((finished - anchor) / step)) * step
    if (next <= finished) next += step
    if (!ok) next = Math.min(next, finished + 2 * 3600 * 1000)
  }
  return next
}

// ---------------------------------------------------------------------------
// handlers
// ---------------------------------------------------------------------------

function makeHandlers(opts) {
  const dispatchRef = opts.dispatch
  const queryRef = opts.query
  const dataDir = opts.dataDir || DEFAULT_DATA_DIR

  function throwErr(code, message, hint, retryable = false) {
    throw Object.assign(new Error(message), { code, hint, retryable })
  }

  function resolveProgram(args, ctx, repo) {
    if (args.program_id) return String(args.program_id)
    if (ctx && ctx.cwd && repo && typeof repo.programByWorkspacePath === 'function') {
      const id = repo.programByWorkspacePath(ctx.cwd)
      if (id) return String(id)
    }
    return ''
  }

  const invariants = {
    scheduleValid: async (args, repo, ctx) => {
      const nowTs = Date.now()
      const s = normalizeSchedule(args.schedule, nowTs)
      if (s.error) return { code: s.code || 'E_SCHEMA', message: s.error, hint: 'once 传未来毫秒时间戳；interval 传 every_seconds ≥300 整数', retryable: false }
      return null
    },
    intrusiveInterval: async (args, repo) => {
      const s = args.schedule
      if (s && String(s.kind) === 'interval' && INTRUSIVE_WORDS.test(String(args.objective || ''))) {
        return { code: 'E_TASK_INTRUSIVE_INTERVAL', message: 'intrusive 级目标禁止 interval', hint: '改用 once 单次执行，或拆出被动采集部分做周期任务', retryable: false }
      }
      return null
    },
    terminalImmutable: async (args, repo) => {
      const t = repo.getTask(Number(args.task_id))
      if (!t) return { code: 'E_NOT_FOUND', message: `task 不存在: ${args.task_id}`, hint: '核对 task_list 里的 id', retryable: false }
      if (TERMINAL.has(t.status)) return { code: 'E_STATE', message: `task #${args.task_id} 已终态（${t.status}），不能改调度`, hint: '终态任务不能改调度；需要重跑请新建任务', retryable: false }
      return null
    },
    runNowQueued: async (args, repo) => {
      const t = repo.getTask(Number(args.task_id))
      if (!t) return { code: 'E_NOT_FOUND', message: `task 不存在: ${args.task_id}`, hint: '核对 task_list 里的 id', retryable: false }
      if (t.status !== 'queued') return { code: 'E_STATE', message: `task #${args.task_id} 当前 ${t.status}，仅 queued 可立即触发`, hint: '仅 queued 可立即触发；running 用 task_worker_status 查进度', retryable: false }
      return null
    },
    finishEvidence: async (args, repo) => {
      if (args.outcome === 'done' || args.outcome === 'failed') {
        if (!args.run_id) return { code: 'E_EVIDENCE_REQUIRED', message: 'outcome=done/failed 必须携带 run_id', hint: '收尾必须携带真实 run_id（exec 域 results 引用）', retryable: false }
      }
      return null
    },
    chainProgram: async (args, repo, ctx) => {
      if (!resolveProgram(args, ctx, repo)) {
        return { code: 'E_TASK_PROGRAM_UNRESOLVED', message: 'program_id 缺失且会话不在已绑定工作区', hint: '传 program_id（见 program_list），或在绑定工作区的会话里调用', retryable: false }
      }
      return null
    },
    submitCompleteValid: async (args, repo, ctx) => {
      const t = repo.getTask(Number(args.task_id))
      if (!t) return { code: 'E_NOT_FOUND', message: `task 不存在: ${args.task_id}`, hint: '核对 task_list 里的 id', retryable: false }
      if (TERMINAL.has(t.status)) return { code: 'E_STATE', message: `task #${args.task_id} 已终态`, hint: '终态任务无需再声明完成', retryable: false }
      return null
    },
  }

  const commands = {
    task_create: async (args, repo, ctx) => {
      const nowTs = Date.now()
      const programId = resolveProgram(args, ctx, repo)
      if (!programId) throwErr('E_TASK_PROGRAM_UNRESOLVED', 'program_id 缺失且会话不在已绑定工作区', '传 program_id（见 program_list），或在绑定工作区的会话里调用')
      if (args.provider && !args.model) throwErr('E_SCHEMA', 'provider+model 须成对出现', '模型覆盖须 provider+model 成对', false)
      if (!args.provider && args.model) throwErr('E_SCHEMA', 'provider+model 须成对出现', '模型覆盖须 provider+model 成对', false)
      const sched = normalizeSchedule(args.schedule, nowTs)
      if (sched.error) throwErr(sched.code || 'E_SCHEMA', sched.error, '修正 schedule 后重试')
      // INV-T2：interval 固定实体幂等去重
      if (sched.kind === 'interval') {
        const dup = repo.findActiveInterval(programId, args.objective)
        if (dup) {
          return {
            data: { task_id: Number(dup.id), status: dup.status, deduped: true, schedule: { kind: 'interval', next_run_at: dup.next_run_at } },
            after: { task_id: Number(dup.id), deduped: true },
          }
        }
      }
      const id = repo.insertTask({
        program_id: programId,
        parent_id: args.parent_id ?? null,
        phase: args.phase || '',
        objective: args.objective,
        priority: args.priority ?? 5,
        budget_tokens: args.budget_tokens ?? null,
        assignee: args.assignee || '',
        session_id: ctx.session_id || null,
        schedule_kind: sched.kind,
        run_at: sched.run_at,
        every_seconds: sched.every_seconds,
        next_run_at: sched.next_run_at,
        provider: args.provider ?? null,
        model: args.model ?? null,
        reasoning_effort: args.reasoning_effort ?? null,
      })
      const payload = {
        task_id: id, program_id: programId, phase: args.phase || '', objective_head: String(args.objective || '').slice(0, 80),
        schedule_kind: sched.kind, parent_id: args.parent_id ?? null, priority: args.priority ?? 5, source: 'model',
      }
      return {
        data: { task_id: id, status: 'queued', schedule: sched.kind ? { kind: sched.kind, next_run_at: sched.next_run_at } : null, deduped: false },
        events: [{ name: 'task.created', payload }],
        after: { task_id: id },
      }
    },

    task_schedule: async (args, repo) => {
      const nowTs = Date.now()
      const t = repo.getTask(Number(args.task_id))
      if (!t) throwErr('E_NOT_FOUND', `task 不存在: ${args.task_id}`, '核对 task_list 里的 id')
      if (TERMINAL.has(t.status)) throwErr('E_STATE', `task #${args.task_id} 已终态（${t.status}），不能改调度`, '终态任务不能改调度；需要重跑请新建任务')
      const sched = normalizeSchedule(args.schedule, nowTs)
      if (sched.error) throwErr(sched.code || 'E_SCHEMA', sched.error, '修正 schedule 后重试')
      repo.transitionTask(Number(args.task_id), {
        schedule_kind: sched.kind, run_at: sched.run_at, every_seconds: sched.every_seconds, next_run_at: sched.next_run_at,
      })
      return { data: { task_id: Number(args.task_id), schedule: sched.kind ? { kind: sched.kind, next_run_at: sched.next_run_at } : null } }
    },

    task_run_now: async (args, repo) => {
      const nowTs = Date.now()
      const t = repo.getTask(Number(args.task_id))
      if (!t) throwErr('E_NOT_FOUND', `task 不存在: ${args.task_id}`, '核对 task_list 里的 id')
      if (t.status !== 'queued') throwErr('E_STATE', `task #${args.task_id} 当前 ${t.status}，仅 queued 可立即触发`, '仅 queued 可立即触发；running 用 task_worker_status 查进度')
      repo.transitionTask(Number(args.task_id), {
        schedule_kind: t.schedule_kind || 'once', next_run_at: nowTs,
      })
      return { data: { task_id: Number(args.task_id), hint: '已排入调度队列，下一 tick（≤60s）认领执行' } }
    },

    task_update_note: async (args, repo) => {
      const t = repo.getTask(Number(args.task_id))
      if (!t) throwErr('E_NOT_FOUND', `task 不存在: ${args.task_id}`, '核对 task_list 里的 id')
      const stamp = `[${new Date().toISOString().slice(0, 16)}] ${args.note}`
      const tail = `${t.result || ''}\n${stamp}`.trim().slice(-8000)
      repo.transitionTask(Number(args.task_id), { result: tail })
      return { data: { task_id: Number(args.task_id), result_tail: tail.slice(-200) } }
    },

    task_block: async (args, repo) => {
      const t = repo.getTask(Number(args.task_id))
      if (!t) throwErr('E_NOT_FOUND', `task 不存在: ${args.task_id}`, '核对 task_list 里的 id')
      if (TERMINAL.has(t.status)) throwErr('E_STATE', `task #${args.task_id} 已终态，不可阻塞`, '终态任务不可阻塞')
      if (t.status === 'blocked') throwErr('E_STATE', `task #${args.task_id} 已 blocked`, '已 blocked 用 task_resume 恢复')
      const r = repo.transitionTask(Number(args.task_id), { status: 'blocked', blocked_reason: args.blocked_reason }, t.status)
      if (r === 0) throwErr('E_STATE', '状态迁移失败', '重试或核对当前状态')
      if (args.note) {
        const tail = `${t.result || ''}\n[${new Date().toISOString().slice(0, 16)}] blocked: ${args.note}`.trim().slice(-8000)
        repo.transitionTask(Number(args.task_id), { result: tail })
      }
      return {
        data: { task_id: Number(args.task_id), status: 'blocked' },
        events: [{ name: 'task.blocked', payload: { task_id: Number(args.task_id), program_id: t.program_id, from_status: t.status, blocked_reason: args.blocked_reason } }],
        after: { task_id: Number(args.task_id), status: 'blocked' },
      }
    },

    task_resume: async (args, repo) => {
      const t = repo.getTask(Number(args.task_id))
      if (!t) throwErr('E_NOT_FOUND', `task 不存在: ${args.task_id}`, '核对 task_list 里的 id')
      if (t.status !== 'blocked') throwErr('E_STATE', `task #${args.task_id} 当前 ${t.status}，仅 blocked 可恢复`, '仅 blocked 状态可恢复；queued/running 无须恢复')
      const r = repo.transitionTask(Number(args.task_id), { status: 'queued', blocked_reason: null }, 'blocked')
      if (r === 0) throwErr('E_STATE', '状态迁移失败', '重试或核对当前状态')
      return { data: { task_id: Number(args.task_id), status: 'queued', next_run_at: t.next_run_at } }
    },

    task_cancel: async (args, repo) => {
      const t = repo.getTask(Number(args.task_id))
      if (!t) throwErr('E_NOT_FOUND', `task 不存在: ${args.task_id}`, '核对 task_list 里的 id')
      if (TERMINAL.has(t.status)) throwErr('E_STATE', `task #${args.task_id} 已终态`, '任务已终态；重跑请新建')
      const note = args.note || '看板手动取消'
      repo.transitionTask(Number(args.task_id), { status: 'cancelled', finished_at: Date.now() }, t.status)
      const tail = `${t.result || ''}\n[${new Date().toISOString().slice(0, 16)}] cancelled: ${note}`.trim().slice(-8000)
      repo.transitionTask(Number(args.task_id), { result: tail })
      return {
        data: { task_id: Number(args.task_id), status: 'cancelled' },
        events: [{ name: 'task.cancelled', payload: { task_id: Number(args.task_id), program_id: t.program_id, from_status: t.status, note } }],
        after: { task_id: Number(args.task_id), status: 'cancelled' },
      }
    },

    task_finish: async (args, repo, ctx) => {
      const nowTs = Date.now()
      const t = repo.getTask(Number(args.task_id))
      if (!t) throwErr('E_NOT_FOUND', `task 不存在: ${args.task_id}`, '核对 task_list 里的 id')
      if (t.status !== 'running' && t.status !== 'blocked') {
        // superseded：任务已被 cancel/reap 抢先终态，只补执行史不改状态
        if (TERMINAL.has(t.status)) {
          const runId = args.run_id || ''
          if (runId) repo.insertTaskRun({ task_id: Number(args.task_id), run_id: runId, ok: args.outcome === 'done', note: args.note || '', started_at: t.started_at, finished_at: nowTs, session_id: args.session_id ?? null })
          return { data: { task_id: Number(args.task_id), superseded: true } }
        }
      }

      // 真实性判定（truth.rejected ⇒ 强制 failed）
      let ok = args.outcome === 'done'
      const truth = args.truth && typeof args.truth === 'object' ? args.truth : { checked: false, rejected: false, reason: '' }
      let note = args.note || ''
      if (truth.rejected) {
        ok = false
        note = `[真实性校验失败] ${truth.reason}${note ? ' | ' + note : ''}`.slice(0, 500)
      }
      if (args.outcome === 'crash') { ok = false; if (!note) note = '调度执行异常' }

      // INV-T6 流程守卫（interval 且 pipeline 目录存在；失败不拒事务）
      const guard = { checked: false, missing: [] }
      if (t.schedule_kind === 'interval' && fs.existsSync(path.join(dataDir, 'pipeline', String(t.program_id)))) {
        guard.checked = true
        if (queryRef) {
          try {
            const proof = await queryRef('ledger', 'task_proof', { program: t.program_id, since_ts: nowTs - 86400000 }, { actor: 'scheduler' })
            if (proof && proof.ok && proof.data) {
              if (!proof.data.attempts_delta_24h) guard.missing.push('attempts 台账近 24h 零增量')
              if (!proof.data.card_usage_24h) guard.missing.push('card_usage 近 24h 零记录')
              if (!proof.data.handoff_today) guard.missing.push('handoff 交接包缺失')
            }
          } catch { /* ledger 未就绪，守卫降级为不检查 */ }
        }
      }
      if (guard.missing.length) {
        ok = false
        note = `[流程守卫缺失] ${guard.missing.join('；')}${note ? ' | ' + note : ''}`.slice(0, 500)
      }

      // busy：并发满，回 queued 不落史
      if (args.outcome === 'busy') {
        repo.transitionTask(Number(args.task_id), { status: 'queued' }, 'running')
        return { data: { task_id: Number(args.task_id), status: 'queued', run_recorded: false } }
      }

      const finished = nowTs
      let status
      let nextRunAt = null
      if (t.schedule_kind === 'interval' && t.every_seconds) {
        nextRunAt = nextRunAfterInterval(t, finished, ok)
        status = 'queued'
      } else {
        status = ok ? 'done' : 'failed'
      }
      const runId = args.run_id || ''
      const tailNote = `${t.result || ''}\n[${new Date().toISOString().slice(0, 16)}] run ${runId || '-'}: ${ok ? 'done' : 'failed'}${note ? ' — ' + note : ''}`.trim()
      repo.transitionTask(Number(args.task_id), {
        status, result: tailNote.slice(-8000), last_run_at: finished, last_run_id: runId || null, next_run_at: nextRunAt,
        session_id: args.session_id ?? t.session_id,
        finished_at: (status === 'done' || status === 'failed') ? finished : t.finished_at,
      })
      if (runId) {
        repo.insertTaskRun({ task_id: Number(args.task_id), run_id: runId, ok, note, started_at: t.started_at, finished_at: finished, session_id: args.session_id ?? null })
      }
      return {
        data: { task_id: Number(args.task_id), status, next_run_at: nextRunAt, run_recorded: !!runId, guard: { checked: guard.checked, missing: guard.missing } },
        events: [{ name: 'task.finished', payload: { task_id: Number(args.task_id), program_id: t.program_id, run_id: runId, ok, outcome: args.outcome, schedule_kind: t.schedule_kind, next_run_at: nextRunAt, session_id: args.session_id ?? null, note: String(note || '').slice(0, 300), guard: { checked: guard.checked, missing: guard.missing }, truth, cause: 'run' } }],
        after: { task_id: Number(args.task_id), status, ok },
      }
    },

    task_chain: async (args, repo, ctx) => {
      const programId = resolveProgram(args, ctx, repo)
      if (!programId) throwErr('E_TASK_PROGRAM_UNRESOLVED', 'program_id 缺失且会话不在已绑定工作区', '传 program_id（见 program_list），或在绑定工作区的会话里调用')
      const want = String(args.want || 'findings').trim()
      const have = Array.isArray(args.have) && args.have.length ? args.have.map(String) : ['domains']
      const priority = Number.isInteger(args.priority) ? args.priority : 3
      const objectiveCtx = String(args.objective || '').trim()

      // 跨域只读：exec_plan_chain BFS
      if (!queryRef) throwErr('E_INTERNAL', 'exec 域查询不可达', '确认 exec 域已注册')
      const plan = await queryRef('exec', 'plan_chain', { have, want }, { actor: 'dashboard' })
      if (!plan || !plan.ok) throwErr('E_TASK_CHAIN_UNREACHABLE', plan?.error?.message || 'BFS 凑不到 want', '调整 have/want 或检查 manifest 的 requires/produces')
      const chain = plan.data?.chain || plan.chain || []
      if (!chain.length) throwErr('E_TASK_CHAIN_EMPTY', '剪枝后链为空', 'want 无产出工具，换一个能力目标')

      // 幂等去重：同 program 未终结 [链:want]
      const marker = `[链:${want}]`
      const dup = repo.listTasksWhere({ program_id: programId, q: marker, bucket: 'active' }, 100, 0, 'priority').find(() => true)
      if (dup) return { data: { program_id: programId, want, chain, task_ids: [], deduped: true }, after: { deduped: true } }

      const base = Date.now()
      const N = chain.length
      const ids = []
      let parentId = Number.isInteger(args.parent_id) ? args.parent_id : null
      const stageToPhase = { recon: 'recon', vuln: 'vuln', audit: 'code-audit' }
      for (let i = 0; i < N; i++) {
        const tool = chain[i]
        const objective = `${marker} [${i + 1}/${N}] ${tool}${objectiveCtx ? `｜目标：${objectiveCtx}` : ''}`
        const phase = stageToPhase[tool] || ''
        const id = repo.insertTask({
          program_id: programId, parent_id: parentId, phase, objective, priority,
          session_id: ctx.session_id || null,
          schedule_kind: 'once', run_at: base + (i + 1) * 2000, next_run_at: base + (i + 1) * 2000,
        })
        ids.push(id)
        parentId = id
      }
      return {
        data: { program_id: programId, want, have, chain, task_ids: ids, deduped: false },
        events: ids.map((id) => ({ name: 'task.created', payload: { task_id: id, program_id: programId, phase: '', objective_head: marker.slice(0, 80), schedule_kind: 'once', parent_id: null, priority, source: 'chain' } })),
        after: { task_ids: ids },
      }
    },

    task_budget_extend: async (args, repo) => {
      const t = repo.getTask(Number(args.task_id))
      if (!t) throwErr('E_NOT_FOUND', `task 不存在: ${args.task_id}`, '核对 task_list 里的 id')
      repo.transitionTask(Number(args.task_id), { budget_timeout_sec: args.budget_timeout_sec })
      return { data: { task_id: Number(args.task_id), budget_timeout_sec: args.budget_timeout_sec } }
    },

    task_claim: async (args, repo) => {
      const tasks = repo.claimDueTasks(Number(args.now), 4)
      return {
        data: { claimed: tasks.map((t) => Number(t.id)), count: tasks.length },
        events: tasks.map((t) => ({ name: 'task.claimed', payload: { task_id: Number(t.id), program_id: t.program_id, phase: t.phase, priority: t.priority, claimed_at: Number(args.now), worker_slot: 1 } })),
        after: { count: tasks.length },
      }
    },

    task_reap: async (args, repo) => {
      const nowTs = Date.now()
      const pidAliveFn = args.pid_alive ? (pid) => { try { process.kill(pid, 0); return true } catch { return false } } : undefined
      const { reaped, skipped_alive } = repo.reapStale(Number(args.max_age), pidAliveFn, nowTs)
      return { data: { reaped, skipped_alive }, events: [] }
    },

    task_worker_register: async (args, repo) => {
      repo.upsertWorker(args)
      return { data: { run_id: args.run_id, registered: true } }
    },

    task_worker_finish: async (args, repo) => {
      const r = repo.finishWorker(args.run_id, { status: args.outcome, exit_code: args.exit_code ?? null }, true)
      return { data: { run_id: args.run_id, changed: r === 1 } }
    },

    task_worker_reap: async (args, repo) => {
      const readMeta = (runDir) => {
        try { return JSON.parse(fs.readFileSync(path.join(runDir, 'meta.json'), 'utf8')) } catch { return null }
      }
      const pidAliveFn = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
      const { reaped } = repo.reapWorkers(readMeta, pidAliveFn, Date.now())
      return { data: { reaped } }
    },

    task_submit_complete: async (args, repo, ctx) => {
      const t = repo.getTask(Number(args.task_id))
      if (!t) throwErr('E_NOT_FOUND', `task 不存在: ${args.task_id}`, '核对 task_list 里的 id')
      // 提请 approval（approval 域；未就绪时降级为本地留痕 + 返回失败引导）
      let requestId = null
      if (dispatchRef) {
        try {
          const r = await dispatchRef('approval', 'request', {
            kind: 'task-complete', subject: `task:${args.task_id}`,
            evidence: String(args.summary || ''),
            payload: { task_id: Number(args.task_id), summary: args.summary, evidence: args.evidence || [], follow_up: args.follow_up || '' },
          }, { actor: 'model', session_id: ctx.session_id || null })
          if (r && r.ok) requestId = r.data?.request_id ?? r.data?.id ?? null
        } catch { /* approval 域未就绪 */ }
      }
      if (!requestId) {
        throwErr('E_BUS_DOMAIN_UNKNOWN', 'approval 域未就绪，无法提请 task-complete 审批', '任务保持 in_progress；待审批中心上线后重试 task_submit_complete', true)
      }
      return { data: { task_id: Number(args.task_id), request_id: requestId, hint: '已提请人工确认（看板「审批」tab）。任务保持 in_progress，不要自行标记完成' } }
    },

    task_complete: async (args, repo) => {
      const nowTs = Date.now()
      const t = repo.getTask(Number(args.task_id))
      if (!t) throwErr('E_NOT_FOUND', `task 不存在: ${args.task_id}`, '核对 task_list 里的 id')
      if (TERMINAL.has(t.status)) return { data: { task_id: Number(args.task_id), superseded: true } }
      const tail = `${t.result || ''}\n[${new Date().toISOString().slice(0, 16)}] 人工确认 #${args.request_id}: ${args.summary || ''}`.trim().slice(-8000)
      repo.transitionTask(Number(args.task_id), { status: 'done', result: tail, finished_at: nowTs }, t.status)
      return {
        data: { task_id: Number(args.task_id), status: 'done' },
        events: [{ name: 'task.finished', payload: { task_id: Number(args.task_id), program_id: t.program_id, run_id: '', ok: true, outcome: 'done', schedule_kind: t.schedule_kind, next_run_at: null, session_id: null, guard: { checked: false, missing: [] }, truth: { checked: false, rejected: false, reason: '' }, cause: 'approval' } }],
        after: { task_id: Number(args.task_id), status: 'done' },
      }
    },
  }

  const queries = {
    task_list: async (args, repo) => {
      const filters = { program_id: args.program_id, status: args.status, phase: args.phase, q: args.q, bucket: args.bucket, scheduled: args.scheduled }
      const total = repo.countTasksWhere(filters)
      const rows = repo.listTasksWhere(filters, args.limit, args.offset, args.sort)
      return { rows, total }
    },
    task_get: async (args, repo) => {
      const t = repo.getTask(Number(args.task_id))
      if (!t) throwErr('E_NOT_FOUND', `task 不存在: ${args.task_id}`, '核对 task_list 里的 id')
      return t
    },
    task_next: async (args, repo) => {
      const t = repo.nextTaskForProgram(args.program_id)
      return t || null
    },
    task_stats: async (args, repo) => {
      return repo.taskStats(args.program_id)
    },
    task_runs: async (args, repo) => {
      const filters = { task_id: args.task_id || 0, program_id: args.program_id }
      const total = repo.countTaskRunsWhere(filters)
      const rows = repo.listTaskRunsWhere(filters, args.limit, args.offset)
      return { rows, total }
    },
    task_scheduled: async (args, repo) => {
      return { rows: repo.scheduledTasksAgg() }
    },
    task_worker_list: async (args, repo) => {
      const rows = repo.listWorkersWhere(args.status || '', args.limit)
      return { rows, total: rows.length }
    },
    task_worker_status: async (args, repo) => {
      const row = repo.getWorker(args.run_id)
      if (!row) throwErr('E_NOT_FOUND', `无 run ${args.run_id} 记录`, '核对 run_id')
      return row
    },
    task_worker_recent: async (args, repo) => {
      const row = repo.findWorkerRecentByKey(args.dedupe_key, args.window_ms || WORKER_DEDUPE_WINDOW_MS)
      return row || null
    },
    task_active_by_session: async (args, repo) => {
      const row = repo.activeTaskBySession(args.session_id, args.max_age_ms || 6 * 3600 * 1000)
      return row || null
    },
    task_drift: async (args, repo) => {
      const rows = repo.scheduledTasksAgg()
      let maxDriftMinutes = 0
      const nowTs = Date.now()
      for (const t of rows) {
        if (t.schedule_kind === 'interval' && t.every_seconds && t.next_run_at) {
          const drift = Math.abs(t.next_run_at - nowTs) / 60000
          if (drift > maxDriftMinutes && drift < t.every_seconds / 60) maxDriftMinutes = Math.round(drift)
        }
      }
      let taskRunsLastAgeHours = null
      try {
        const last = repo.listTaskRunsWhere({}, 1, 0)
        if (last && last.length && last[0].finished_at) taskRunsLastAgeHours = Math.round((nowTs - last[0].finished_at) / 3600000)
      } catch { /* ignore */ }
      return { scheduled_drift: maxDriftMinutes, task_runs_last_age_hours: taskRunsLastAgeHours }
    },
  }

  const subscribers = {
    onScopeGranted: async (envelope) => {
      if (!dispatchRef) return { ok: true, data: { skipped: true } }
      const p = envelope?.payload || {}
      const host = p.subject || p.domain || ''
      const programId = p.program_id || ''
      if (!host || !programId) return { ok: true, data: { skipped: true } }
      const objective = `[审批入队] 新授权域名 ${host} 首轮资产面收集：ledger_radar_drain 读入 scope-approved 事件 → subfinder 子域枚举 → dnsx 解析 → httpx 存活+指纹 asset_upsert/endpoint_upsert 入图谱。只做资产收集，禁止主动漏洞探测。`
      try {
        const r = await dispatchRef('task', 'create', {
          program_id: programId, phase: 'recon', objective, priority: 1,
          schedule: { kind: 'once', at: Date.now() + 5 * 60 * 1000 },
        }, { actor: 'approval' })
        return { ok: !!r.ok, data: { skipped: false } }
      } catch (e) {
        log(`scope.granted 种子任务入队失败（best-effort）: ${e?.message}`)
        return { ok: true, data: { skipped: false, error: String(e?.message) } }
      }
    },
    onWorkerSpawned: async (envelope) => {
      if (!dispatchRef) return { ok: true, data: { skipped: true } }
      const p = envelope?.payload || {}
      if (!p.run_id) return { ok: true, data: { skipped: true } }
      const r = await dispatchRef('task', 'worker_register', {
        run_id: p.run_id, dedupe_key: p.dedupe_key || null, task: p.task || '', cwd: p.cwd || null,
        pid: p.pid ?? null, timeout_sec: p.timeout_sec ?? null, session_id: p.origin_session_id || p.session_id || null, run_dir: p.run_dir || null,
      }, { actor: 'reactor' })
      return { ok: !!r.ok, data: { skipped: false } }
    },
    onWorkerFinished: async (envelope) => {
      if (!dispatchRef) return { ok: true, data: { skipped: true } }
      const p = envelope?.payload || {}
      if (!p.run_id) return { ok: true, data: { skipped: true } }
      const outcome = p.status === 'done' ? 'done' : (p.status === 'killed' ? 'killed' : 'failed')
      const r = await dispatchRef('task', 'worker_finish', { run_id: p.run_id, outcome, exit_code: p.exit_code ?? null }, { actor: 'reactor' })
      return { ok: !!r.ok, data: { skipped: false } }
    },
  }

  return { ...commands, queries, invariants, subscribers }
}

// ---------------------------------------------------------------------------
// 调度器（域内部组件，仅 web profile；文件锁与 v4 调度器互斥）
// ---------------------------------------------------------------------------

function pidAlive(pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}

export function startTaskScheduler({ dataDir, dispatch, query }) {
  if (globalThis.__silksecTaskScheduler) return { started: false, reason: '已启动' }
  const lockPath = path.join(dataDir, 'scheduler.lock')
  const acquire = () => {
    try {
      const cur = JSON.parse(fs.readFileSync(lockPath, 'utf8'))
      if (cur && cur.pid && cur.pid !== process.pid && pidAlive(cur.pid) && (Date.now() - (cur.ts || 0) < 180000)) return false
    } catch { /* 无锁文件 → 可抢 */ }
    try { fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, ts: Date.now() })); return true } catch { return false }
  }
  const holds = () => { try { return JSON.parse(fs.readFileSync(lockPath, 'utf8')).pid === process.pid } catch { return false } }
  if (!acquire()) return { started: false, reason: 'scheduler.lock 被 v4 调度器或其他进程持有（观察期本域休眠）' }

  try { dispatch('task', 'reap', { max_age: 0 }, { actor: 'scheduler' }).catch(() => {}) } catch { /* 启动回收失败不阻断 */ }
  try { dispatch('task', 'worker_reap', {}, { actor: 'scheduler' }).catch(() => {}) } catch { /* 启动对账失败不阻断 */ }

  let tick = 0
  globalThis.__silksecTaskScheduler = setInterval(async () => {
    if (!holds() && !acquire()) return
    try { fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, ts: Date.now() })) } catch { /* ignore */ }
    tick++
    if (tick % 10 === 0) {
      try { await dispatch('task', 'reap', { max_age: (SCHEDULER_TASK_TIMEOUT_SEC + 900) * 1000, pid_alive: true }, { actor: 'scheduler' }) } catch (e) { log(`周期回收失败: ${e?.message}`) }
      try { await dispatch('task', 'worker_reap', {}, { actor: 'scheduler' }) } catch (e) { log(`worker 对账失败: ${e?.message}`) }
    }
    let claimed = []
    try {
      const r = await dispatch('task', 'claim', { now: Date.now() }, { actor: 'scheduler' })
      claimed = (r && r.ok && r.data && r.data.claimed) || []
    } catch (e) { log(`调度认领失败: ${e?.message}`); return }
    await Promise.allSettled(claimed.map(async (taskId) => {
      try {
        const get = await query('task', 'get', { task_id: taskId }, { actor: 'scheduler' })
        const task = get && get.ok ? get.data : null
        if (!task) return
        const prompt = `[定时任务 #${task.id}${task.phase ? ' / ' + task.phase : ''}] ${task.objective}`
        const r = await dispatch('exec', 'spawn_worker', { task: prompt, timeout: Math.min(7200, Math.max(3600, Number(task.budget_timeout_sec) || 0)), provider: task.provider, model: task.model }, { actor: 'scheduler' })
        if (r && r.ok && r.data && r.data.busy) {
          await dispatch('task', 'finish', { task_id: taskId, run_id: '', outcome: 'busy' }, { actor: 'scheduler' })
          return
        }
        const ok = !!(r && r.ok && r.data && r.data.exit_code === 0)
        const note = r && r.data && r.data.tail ? String(r.data.tail).split('\n').filter(Boolean).slice(-3).join(' ').slice(0, 300) : ''
        const truth = r && r.data && r.data.truth ? r.data.truth : { checked: false, rejected: false, reason: '' }
        await dispatch('task', 'finish', { task_id: taskId, run_id: (r && r.data && r.data.run_id) || '', outcome: ok ? 'done' : 'failed', note, session_id: (r && r.data && r.data.session_id) || null, truth }, { actor: 'scheduler' })
      } catch (e) {
        log(`调度任务 #${taskId} 执行异常: ${e?.message}`)
        try { await dispatch('task', 'finish', { task_id: taskId, run_id: '', outcome: 'crash', note: String(e?.message || '').slice(0, 300) }, { actor: 'scheduler' }) } catch { /* ignore */ }
      }
    }))
  }, SCHEDULER_TICK_MS)
  globalThis.__silksecTaskScheduler.unref?.()
  return { started: true }
}

// ---------------------------------------------------------------------------
// 组装
// ---------------------------------------------------------------------------

export function buildTaskDomain(opts = {}) {
  const dataDir = opts.dataDir || DEFAULT_DATA_DIR
  const backend = createTaskSqliteBackend(opts.backendOptions || {})
  return {
    manifest: TASK_MANIFEST,
    handlers: makeHandlers({ ...opts, dataDir }),
    backend,
  }
}

export function apply(ctx, config = {}) {
  const dataDir = process.env.SEC_DATA_DIR || process.env.DSH_HOME || DEFAULT_DATA_DIR
  try {
    ctx.inject(['secDomainBus'], (child) => {
      const bus = child.secDomainBus
      const domain = buildTaskDomain({
        dataDir,
        dispatch: (d, v, a, c) => bus.dispatch(d, v, a, c),
        query: (d, n, a, c) => bus.query(d, n, a, c),
      })
      const res = bus.registry.register(domain)
      if (res.ok) {
        log(`task 域注册成功（registered=${res.registered}）`)
        // 观察期：调度器不启动——v4 调度器（sec-suite scheduler.js）仍持 data/scheduler.lock 运行，
        // 保证 03:00/04:00 每日链路不中断。删旧路径（移除 v4 调度器）时再启用本域调度器：
        //   if (config.sidecars !== false) startTaskScheduler({ dataDir, dispatch, query })
        log('task 调度器观察期休眠（v4 调度器持锁；删旧路径后启用）')
      } else {
        log(`task 域注册被拒：${res.error?.code} ${res.error?.message}`)
      }
      return () => {}
    })
  } catch (e) {
    log(`secDomainBus 注入失败：${e?.message}——task 域未注册（总线必须先行挂载）`)
  }
  return null
}
