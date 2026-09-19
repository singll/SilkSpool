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
import { nextScheduledRun, validateDependency, MAX_WORKER_TIMEOUT_SEC } from '../sec-suite/task-policy.js'
// L6 调度器切换：persona/定时任务 prompt/会话反查与 v4 完全同源（复用 sec-suite 版本受控实现，防双份漂移）
import { listSessionHeaders, matchWorkerSession, createPersonaReader, buildScheduledPrompt } from '../sec-suite/host-compat.js'

export const name = 'sec-domain-task'
export const version = '1.0.0'

const DEFAULT_DATA_DIR = process.env.SEC_DATA_DIR || '/opt/silkspool/dsh/data'

const log = (msg) => { try { process.stderr.write(`[sec-domain-task] ${msg}\n`) } catch { /* noop */ } }

const backendUrl = new URL('../sec-backend-task-sqlite/index.js', import.meta.url)
const { createTaskSqliteBackend } = await import(backendUrl.href)

const TASK_STATUS = ['queued', 'running', 'blocked', 'done', 'failed', 'cancelled']
const TERMINAL = new Set(['done', 'failed', 'cancelled'])
// L6（学习专项 §10）：任务目标类型——学习/评测作为明确任务类型调度（四类节奏）。
// ''/research=授权研究（默认）；learn-daily=日常整理（补索引/复验到期来源/整偏，只产候选）；
// eval-batch=周期评测批（候选对照/误报复盘/晋升审阅）；change-retest=变更触发重测（撤回/失效驱动）。
const TASK_GOALS = ['research', 'learn-daily', 'eval-batch', 'change-retest']
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
    at: { type: ['integer', 'string'], description: 'once 执行时刻：epoch 毫秒/秒，或 ISO 8601 字符串；带时区按声明时区换算，不带时区一律按北京时间（+08:00）。interval 时可作相位锚点。' },
    every_seconds: int(),
    anchor: { type: ['string', 'integer'], description: 'interval 标称相位锚点：HH:mm（北京墙钟）或 epoch/ISO。缺省时步长为整日/整周者锚定北京 03:00，其余锚定创建时刻。' },
    tz: { type: 'string', description: '仅为不带时区的输入声明解释时区：±HH:MM / UTC / IANA 名（缺省 Asia/Shanghai）。' },
    after_task_id: { type: ['integer', 'null'], minimum: 1, description: '前置任务；周期任务须在本周期成功后放行。null 清除依赖。' },
    after_delay_seconds: int({ minimum: 0, maximum: 86400, description: '前置成功后的延迟秒数，缺省 0；仍受 60 秒调度 tick 影响。' }),
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
      actor: ['model', 'dashboard', 'script', 'approval', 'system', 'reactor'],
      schema: schema({
        program_id: str(),
        objective: str({ maxLength: 4000 }),
        phase: str({ default: '' }),
        goal: en([...TASK_GOALS, ''], { default: '', description: '任务目标类型（L6 §10）：research=授权研究（默认）；learn-daily=日常整理；eval-batch=周期评测批；change-retest=变更触发重测。' }),
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
      idempotent_fields: ['program_id', 'objective', 'phase', 'goal', 'priority', 'parent_id', 'budget_tokens', 'assignee', 'schedule', 'provider', 'model', 'reasoning_effort'],
      events: ['task.created'],
      event_limit: 1,
      invariants: ['scheduleValid', 'intrusiveInterval'],
      timeout_ms: 60000,
      agent_note: '创建任务；program_id 缺省按工作区解析，priority 0 最高。schedule：{kind:"once",at} 或 {kind:"interval",every_seconds:>=300,anchor}。at/anchor 接受 epoch、ISO、HH:mm；无时区按北京时间。回显 next_run_bj。parent_id 指定前置任务，周期任务等待前置本周期成功后接续。',
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
      agent_note: '设置/修改/清除任务的定时调度（schedule 传 null 清除变普通任务，时间校准规则同 task_create）。终态任务不可改。修改 every_seconds 后续期锚点仍为原 run_at（节律相位不重置）；可通过 schedule.anchor（HH:mm 或 ISO/epoch）显式重设相位。',
      deprecated: false,
    },
    task_run_now: {
      actor: ['model', 'dashboard'],
      schema: schema({ task_id: int() }, ['task_id']),
      idempotent: 'none',
      events: [],
      invariants: ['runNowQueued'],
      timeout_ms: 60000,
      agent_note: '立即触发一次任务（不动调度节律）：排入调度队列，下一 tick（≤60s）认领执行。返回体 nominal_next_run_bj 展示手动跑完后仍回到的标称北京时间格点，应告知用户；节律由 run_at 锚点保护，立即运行不会将其挪到当前时刻。',
      deprecated: false,
    },
    task_update_note: {
      actor: ['model', 'dashboard', 'scheduler', 'script', 'approval', 'system'],
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
        timed_out: { type: 'boolean' },
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
        task_id: int(),
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
      agent_note: 'worker 注册表登记（订阅 exec.worker.spawned 强联动执行；不向模型注册）。带 task_id 时把 tasks.active_run_id 绑定到该 run（僵尸回收的活 worker 跳过依据）。',
      deprecated: false,
    },
    task_worker_finish: {
      actor: ['reactor', 'scheduler'],
      schema: schema({ run_id: str({ minLength: 1 }), outcome: en(['done', 'failed', 'killed']), exit_code: int(), worker_session_id: str() }, ['run_id', 'outcome']),
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
        goal: en([...TASK_GOALS, ''], { default: '' }),
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
      actor: ['model', 'dashboard', 'human', 'system', 'reactor', 'scheduler'],
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
    // L6（学习专项 §10 变更触发节奏）：卡片撤回 → 生成有预算的重测需求任务（goal=change-retest）。
    // 已暂停任务不自行恢复；重测任务入队（queued 无调度，不自动起 worker）——由人/编排决定何时 task_run_now。
    'know.release.revoked': { handler: 'onReleaseRevoked', mode: 'async', as: 'reactor' },
  },
  backend: 'repository-v1',
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 时间转换与校准（00-conventions §十）
//  输入：epoch 毫秒/秒（≥1e12 视毫秒否则秒）、ISO 8601（Z / ±HH:MM 优先；不带时区
//       一律按北京时间或 schedule.tz 指定时区解释）、纯时刻 HH:mm/HH:mm:ss（取最近
//       北京墙钟格点）。
//  校准：解析失败返回明确错误+可读线索（北京时间），绝不静默猜测。
//  输出：统一回显北京时间 ISO（+08:00），创建/改调度后可直接核对落点。
// ---------------------------------------------------------------------------
const _BEIJING_OFFSET_MS = 8 * 3600_000
const _DAY_MS = 86_400_000
// 夜间批次默认相位（北京时间）：recon 03:00 / vuln 04:00 / 其余 05:00。未显式给 anchor 的新任务
// 落进对应窗口；同批需要错开的由调用方传 anchor。
const _NIGHT_SLOTS = { recon: [3, 0], vuln: [4, 0] }
const _NIGHT_SLOT_DEFAULT = [5, 0]
const _SCHEDULE_PAST_GRACE_MS = 60_000  // once 刚过期 60 秒内允许校准为立即执行

function _beijingIso(ts) {
  const n = Number(ts)
  return Number.isFinite(n) ? `${new Date(n + _BEIJING_OFFSET_MS).toISOString().slice(0, 16)}+08:00` : null
}

// 时区标识 → 相对 UTC 的毫秒偏移（识别失败返回 null）。
const _TZ_OFFSET_ALIASES = { beijing: _BEIJING_OFFSET_MS, '北京': _BEIJING_OFFSET_MS, '北京时间': _BEIJING_OFFSET_MS, '中国标准时间': _BEIJING_OFFSET_MS, cst: _BEIJING_OFFSET_MS, prc: _BEIJING_OFFSET_MS, utc: 0, gmt: 0, z: 0 }
function _timeZoneOffsetMs(tz, refTs) {
  const key = String(tz ?? '').trim()
  if (!key) return null
  const lower = key.toLowerCase()
  if (_TZ_OFFSET_ALIASES[lower] !== undefined) return _TZ_OFFSET_ALIASES[lower]
  const m = key.match(/^([+-])(\d{2}):?(\d{2})?$/)
  if (m) { const mins = Number(m[2]) * 60 + Number(m[3] || 0); return m[1] === '-' ? -mins * 60_000 : mins * 60_000 }
  try {
    const dtf = new Intl.DateTimeFormat('en-US', { timeZone: key, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    const p = {}; for (const x of dtf.formatToParts(new Date(refTs))) if (x.type !== 'literal') p[x.type] = x.value
    const wall = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second)
    return Math.round((wall - Math.floor(refTs / 1000) * 1000) / 60_000) * 60_000
  } catch { return null }
}

// ≤ nowTs 的最近一次"北京墙钟 = wallMs"时刻（或 > nowTs 的下一次，按 nearest）。
function _wallClockMs(wallMs, nowTs, nearest) {
  const bjMidnight = Math.floor((nowTs + _BEIJING_OFFSET_MS) / _DAY_MS) * _DAY_MS - _BEIJING_OFFSET_MS
  let t = bjMidnight + wallMs
  if (nearest === 'past') { if (t > nowTs) t -= _DAY_MS } else if (t <= nowTs) t += _DAY_MS
  return t
}

function _parseZoneToken(tok) {
  if (!tok) return undefined
  if (tok === 'Z' || tok === 'z') return 0
  const m = tok.match(/^([+-])(\d{2}):?(\d{2})$/); if (!m) return undefined
  const mins = Number(m[2]) * 60 + Number(m[3]); return m[1] === '-' ? -mins * 60_000 : mins * 60_000
}

function _parseScheduleTime(input, opts = {}) {
  const nowTs = Number.isFinite(opts.nowTs) ? opts.nowTs : Date.now()
  const nearest = opts.nearest === 'past' ? 'past' : 'future'
  const label = opts.label || '时间'
  if (input === null || input === undefined || input === '') return { error: `${label} 为空` }
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) return { error: `${label} 不是有限数值` }
    return { ms: Math.abs(input) >= 1e12 ? input : input * 1000 }
  }
  const raw = String(input).trim()
  // 纯数字字符串视为 epoch
  if (/^-?\d+$/.test(raw)) {
    const n = Number(raw)
    return { ms: Math.abs(n) >= 1e12 ? n : n * 1000 }
  }
  // 规范化中文标点（年/月/日/点/：）并拆尾部时区
  let s = raw.replace(/年/g, '-').replace(/月/g, '-').replace(/日/g, '').replace(/点/g, ':').replace(/分/g, '').replace(/：/g, ':').replace(/\s+/g, ' ').trim()
  // 纯时刻 HH:mm[:ss]
  const hm = s.match(/^([01]?\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/)
  if (hm) {
    const secs = Number(hm[1]) * 3600 + Number(hm[2]) * 60 + Number(hm[3] || 0)
    return { ms: _wallClockMs(secs * 1000, nowTs, nearest) }
  }
  // 日期[时间][时区]
  const dt = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:?\d{2})?$/)
  if (!dt) return { error: `无法解析 ${label}：${raw}（接受 epoch 毫秒/秒、ISO 8601、HH:mm 时刻）` }
  const [, ys, mos, ds, hs, mis, ss, mss, zone] = dt
  const y = +ys, mo = +mos, d = +ds, h = +(hs || 0), mi = +(mis || 0), sec = +(ss || 0), millis = Number((mss || '0').padEnd(3, '0'))
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || sec > 59) return { error: `${label} 字段越界：${raw}` }
  let offMs = _parseZoneToken(zone)
  if (offMs === undefined) {
    if (opts.tz) {
      offMs = _timeZoneOffsetMs(opts.tz, Date.UTC(y, mo - 1, d, h, mi, sec))
      if (offMs === null) return { error: `无法识别 tz：${opts.tz}（接受 ±HH:MM / UTC / IANA 时区名）` }
    } else {
      offMs = _BEIJING_OFFSET_MS   // 宪法 §十：不带时区 = 北京时间
    }
  }
  const epochMs = Date.UTC(y, mo - 1, d, h, mi, sec, millis) - offMs
  return { ms: epochMs }
}

// interval 标称锚点：≤ nowTs 的格点原点（续期以它为相位基准，不随手动触发/失败重试漂移）。
function _resolveIntervalAnchor(schedule, every, nowTs, prev) {
  const step = every * 1000
  const explicit = schedule.anchor !== undefined && schedule.anchor !== null && schedule.anchor !== ''
    ? schedule.anchor : (schedule.at !== undefined && schedule.at !== null && schedule.at !== '' ? schedule.at : null)
  if (explicit !== null) {
    const p = _parseScheduleTime(explicit, { tz: schedule.tz, nowTs, nearest: 'past', label: 'interval 锚点' })
    if (p.error) return p
    // 将绝对时刻回滚到最接近 now 的格点（step 对齐）
    return { ms: p.ms - Math.ceil((p.ms - nowTs) / step) * step }
  }
  // 改调度沿用原相位（05-task C2：修改 every_seconds 后续期锚点仍为原 run_at，节律不重置）
  const prevRunAt = prev && prev.schedule_kind === 'interval' ? Number(prev.run_at) : NaN
  if (Number.isFinite(prevRunAt) && prevRunAt > 0) return { ms: prevRunAt - Math.ceil((prevRunAt - nowTs) / step) * step }
  // 新建：落到设计好的夜间窗口（北京墙钟，按 phase 分槽），短周期再按步长回退到格点。
  // 日级任务由此恒定在凌晨——不会因为"创建时刻在下午"就把节律定在下午。
  const slot = _NIGHT_SLOTS[String(prev && prev.phase || '').toLowerCase()] || _NIGHT_SLOT_DEFAULT
  let a = _wallClockMs((slot[0] * 3600 + slot[1] * 60) * 1000, nowTs, 'past')
  if (step < _DAY_MS) a -= Math.floor((nowTs - a) / step) * step
  return { ms: a }
}

function _firstGridAfter(anchor, step, nowTs) {
  if (anchor > nowTs) return anchor
  return anchor + (Math.floor((nowTs - anchor) / step) + 1) * step
}

function normalizeSchedule(schedule, nowTs, prev) {
  if (!schedule) return { kind: null, run_at: null, every_seconds: null, next_run_at: null }
  const kind = String(schedule.kind || '')
  if (kind === 'once') {
    const parsed = _parseScheduleTime(schedule.at, { tz: schedule.tz, nowTs, nearest: 'future', label: 'once.at' })
    if (parsed.error) return { error: parsed.error, code: parsed.code || 'E_SCHEMA' }
    let at = parsed.ms
    if (at <= nowTs) {
      if (nowTs - at <= _SCHEDULE_PAST_GRACE_MS) at = nowTs + 1000
      else return { error: `once.at 需为未来时刻（解析=北京 ${_beijingIso(parsed.ms)}，现在=北京 ${_beijingIso(nowTs)}）`, code: 'E_TASK_SCHEDULE_PAST' }
    }
    return { kind, run_at: at, every_seconds: null, next_run_at: at, next_run_bj: _beijingIso(at) }
  }
  if (kind === 'interval') {
    const every = Number(schedule.every_seconds)
    if (!Number.isInteger(every) || every < MIN_INTERVAL_SECONDS) return { error: `interval 调度需要 every_seconds ≥ ${MIN_INTERVAL_SECONDS} 的整数`, code: 'E_TASK_INTERVAL_MIN' }
    const anchor = _resolveIntervalAnchor(schedule, every, nowTs, prev || {})
    if (anchor.error) return anchor
    const step = every * 1000
    const next = _firstGridAfter(anchor.ms, step, nowTs)
    return { kind, run_at: anchor.ms, every_seconds: every, next_run_at: next, next_run_bj: _beijingIso(next), anchor_bj: _beijingIso(anchor.ms) }
  }
  return { error: `非法 schedule.kind: ${kind || '(空)'}`, code: 'E_SCHEMA' }
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

  // L1（学习专项 §3.1）：宿主在收尾事件发布前固定 FGS 快照（fgs 域 fgs_snapshot 命令）。
  // 弱联动——快照不可用（fgs 域未注册/失败）时显式返回 null（缺快照标记），不阻断收尾。
  async function pinFgsSnapshot(taskId, runId) {
    if (!dispatchRef) return null
    try {
      const snap = await dispatchRef('fgs', 'snapshot', { task_id: Number(taskId), run_id: runId || null }, { actor: 'reactor' })
      if (snap && snap.ok && snap.data) {
        return { hash: snap.data.hash, path: snap.data.path, nodes: snap.data.nodes, summary: String(snap.data.summary || '').slice(0, 200) }
      }
      log(`FGS 快照失败 task#${taskId}: ${snap && snap.error && snap.error.code} ${snap && snap.error && snap.error.message}`)
    } catch (e) {
      log(`FGS 快照异常 task#${taskId}: ${e?.message}`)
    }
    return null
  }

  const invariants = {
    scheduleValid: async (args, repo, ctx) => {
      const nowTs = Date.now()
      const s = normalizeSchedule(args.schedule, nowTs, { phase: args.phase || '' })
      if (s.error) return { code: s.code || 'E_SCHEMA', message: s.error, hint: '时刻接受 epoch 毫秒/秒、ISO 8601（带时区按声明时区，不带时区按北京时间）、HH:mm；interval 需 every_seconds ≥300 整数，可用 anchor 指定北京墙钟相位', retryable: false }
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
      const sched = normalizeSchedule(args.schedule, nowTs, { phase: args.phase || '' })
      if (sched.error) throwErr(sched.code || 'E_SCHEMA', sched.error, '修正 schedule 后重试')
      const parentId = args.schedule?.after_task_id !== undefined ? args.schedule.after_task_id : args.parent_id ?? null
      const afterDelay = args.schedule?.after_delay_seconds ?? 0
      const dependencyError = validateDependency(id => repo.getTask(id), { program_id: programId, schedule_kind: sched.kind, every_seconds: sched.every_seconds }, parentId, afterDelay)
      if (dependencyError) throwErr('E_TASK_DEPENDENCY', dependencyError, '核对前置任务与周期，不能自引用或形成循环')
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
        parent_id: parentId,
        after_delay_seconds: afterDelay,
        phase: args.phase || '',
        goal: args.goal || '',
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
        schedule_kind: sched.kind, parent_id: parentId, priority: args.priority ?? 5, goal: args.goal || '', source: 'model',
      }
      return {
        data: { task_id: id, status: 'queued', schedule: sched.kind ? { kind: sched.kind, next_run_at: sched.next_run_at, next_run_bj: sched.next_run_bj ?? _beijingIso(sched.next_run_at) } : null, deduped: false },
        events: [{ name: 'task.created', payload }],
        after: { task_id: id },
      }
    },

    task_schedule: async (args, repo) => {
      const nowTs = Date.now()
      const t = repo.getTask(Number(args.task_id))
      if (!t) throwErr('E_NOT_FOUND', `task 不存在: ${args.task_id}`, '核对 task_list 里的 id')
      if (TERMINAL.has(t.status)) throwErr('E_STATE', `task #${args.task_id} 已终态（${t.status}），不能改调度`, '终态任务不能改调度；需要重跑请新建任务')
      const sched = normalizeSchedule(args.schedule, nowTs, t)
      if (sched.error) throwErr(sched.code || 'E_SCHEMA', sched.error, '修正 schedule 后重试')
      const parentId = args.schedule?.after_task_id !== undefined ? args.schedule.after_task_id : t.parent_id
      const afterDelay = args.schedule?.after_delay_seconds ?? t.after_delay_seconds ?? 0
      const dependencyError = validateDependency(id => repo.getTask(id), { ...t, schedule_kind: sched.kind, every_seconds: sched.every_seconds }, parentId, afterDelay)
      if (dependencyError) throwErr('E_TASK_DEPENDENCY', dependencyError, '核对前置任务与周期，不能自引用或形成循环')
      repo.transitionTask(Number(args.task_id), {
        schedule_kind: sched.kind, run_at: sched.run_at, every_seconds: sched.every_seconds, next_run_at: sched.next_run_at,
        parent_id: parentId, after_delay_seconds: afterDelay,
      })
      return { data: { task_id: Number(args.task_id), schedule: sched.kind ? { kind: sched.kind, next_run_at: sched.next_run_at, next_run_bj: sched.next_run_bj ?? _beijingIso(sched.next_run_at) } : null } }
    },

    task_run_now: async (args, repo) => {
      const nowTs = Date.now()
      const t = repo.getTask(Number(args.task_id))
      if (!t) throwErr('E_NOT_FOUND', `task 不存在: ${args.task_id}`, '核对 task_list 里的 id')
      if (t.status !== 'queued') throwErr('E_STATE', `task #${args.task_id} 当前 ${t.status}，仅 queued 可立即触发`, '仅 queued 可立即触发；running 用 task_worker_status 查进度')
      // 手动触发只覆写 next_run_at，绝不触碰 run_at（标称相位锚点）——这是"立即运行后节律错乱"的根因。
      // interval 行若锚点缺失（历史数据），先把当前标称格点固化进 run_at，续期才有不可覆写的基准。
      const patch = { schedule_kind: t.schedule_kind || 'once', next_run_at: nowTs }
      const nominal = (t.run_at && t.run_at > 0) ? Number(t.run_at) : Number(t.next_run_at) || 0
      if (t.schedule_kind === 'interval' && !(t.run_at > 0) && nominal > 0) patch.run_at = nominal
      repo.transitionTask(Number(args.task_id), patch)
      const anchor = patch.run_at ?? t.run_at
      const nextNominal = (t.schedule_kind === 'interval' && t.every_seconds && anchor > 0)
        ? _firstGridAfter(anchor, t.every_seconds * 1000, nowTs) : null
      return {
        data: {
          task_id: Number(args.task_id),
          hint: nextNominal
            ? `已排入调度队列（下一 tick 认领）；本次手动执行不改动节律，跑完仍回到 ${_beijingIso(nextNominal)}`
            : '已排入调度队列，下一 tick（≤60s）认领执行',
          nominal_next_run_at: nextNominal, nominal_next_run_bj: nextNominal ? _beijingIso(nextNominal) : null,
        },
      }
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
      const runId = args.run_id || t.active_run_id || ''
      const recorded = runId && repo.hasTaskRun(Number(args.task_id), runId)
      if (recorded || TERMINAL.has(t.status) || t.status === 'blocked' || (t.active_run_id && runId !== t.active_run_id)) {
        // 晚到回调不能改写取消/暂停/回收，也不能覆盖正在运行的另一轮。
        if (runId && !recorded) repo.insertTaskRun({ task_id: Number(args.task_id), run_id: runId, ok: args.outcome === 'done' && !args.timed_out, note: args.note || '', started_at: t.started_at, finished_at: nowTs, session_id: args.session_id ?? null })
        return { data: { task_id: Number(args.task_id), superseded: true } }
      }

      // 真实性判定（truth.rejected ⇒ 强制 failed）
      let ok = args.outcome === 'done' && !args.timed_out
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
            } else if (proof && proof.ok === false) {
              guard.missing.push(`task_proof 查询失败：${proof.error?.code || 'E_INTERNAL'} ${proof.error?.message || ''}`.slice(0, 120))
            }
          } catch (e) {
            // L0（学习专项）：守卫异常显式失败——不能把 ledger 异常当"无缺失"放行
            guard.missing.push(`task_proof 查询异常：${String(e?.message || e).slice(0, 120)}`)
          }
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

      // L1（学习专项 §3.1/§4 交付）：收尾事件发布前固定 FGS 快照——episode 必须引用
      // 不可变快照而非"当前图"（下一轮 fgs_clear 会重置图）。弱联动：快照失败显式记
      // fgs_snapshot=null（缺快照标记），不回滚任务收尾。
      const fgsSnapshot = await pinFgsSnapshot(Number(args.task_id), runId || null)

      const finished = nowTs
      let status
      let nextRunAt = null
      if (t.schedule_kind === 'interval' && t.every_seconds) {
        nextRunAt = nextScheduledRun(t, finished, ok, repo.scheduledProgress(t, t.started_at || finished).attempts, !!args.timed_out)
        status = 'queued'
      } else {
        status = ok ? 'done' : 'failed'
      }
      const tailNote = `${t.result || ''}\n[${new Date().toISOString().slice(0, 16)}] run ${runId || '-'}: ${ok ? 'done' : 'failed'}${note ? ' — ' + note : ''}`.trim()
      repo.transitionTask(Number(args.task_id), {
        status, result: tailNote.slice(-8000), last_run_at: finished, last_run_id: runId || null, next_run_at: nextRunAt,
        session_id: args.session_id ?? t.session_id,
        active_run_id: null,
        finished_at: (status === 'done' || status === 'failed') ? finished : t.finished_at,
      })
      repo.insertTaskRun({ task_id: Number(args.task_id), run_id: runId, ok, note, started_at: t.started_at, finished_at: finished, session_id: args.session_id ?? null })
      return {
        data: { task_id: Number(args.task_id), status, next_run_at: nextRunAt, run_recorded: true, guard: { checked: guard.checked, missing: guard.missing } },
        events: [{ name: 'task.finished', payload: { task_id: Number(args.task_id), program_id: t.program_id, run_id: runId, ok, outcome: args.outcome, schedule_kind: t.schedule_kind, next_run_at: nextRunAt, session_id: args.session_id ?? null, note: String(note || '').slice(0, 300), guard: { checked: guard.checked, missing: guard.missing }, truth, fgs_snapshot: fgsSnapshot, cause: 'run' } }],
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
        events: tasks.map((t) => ({ name: 'task.claimed', payload: { task_id: Number(t.id), program_id: t.program_id, phase: t.phase, goal: t.goal || '', priority: t.priority, claimed_at: Number(args.now), worker_slot: 1 } })),
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
      // L6：scheduler 派单绑定——tasks.active_run_id=run_id（task_reap 的活 worker 跳过依据，
      // 防回收后双重派单）。仅当任务确在 running（认领态）才绑，晚到事件不改写已收尾任务。
      if (args.task_id) {
        const t = repo.getTask(Number(args.task_id))
        if (t && t.status === 'running') repo.transitionTask(Number(args.task_id), { active_run_id: String(args.run_id) }, 'running')
      }
      return { data: { run_id: args.run_id, registered: true } }
    },

    task_worker_finish: async (args, repo) => {
      const r = repo.finishWorker(args.run_id, { status: args.outcome, exit_code: args.exit_code ?? null,
        ...(args.worker_session_id ? { worker_session_id: args.worker_session_id } : {}) }, true)
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
      if (t.schedule_kind === 'interval') {
        const result = `${t.result || ''}\n[${new Date().toISOString()}] 本轮摘要: ${args.summary || ''}`.trim().slice(-8000)
        repo.transitionTask(Number(args.task_id), { result })
        return { data: { task_id: Number(args.task_id), scheduled: true, hint: '本轮摘要已保存；定时任务由调度器自动收尾并续期，无需人工完结审批。' } }
      }
      // 提请 approval（approval 域；未就绪时降级为本地留痕 + 返回失败引导）
      let requestId = null
      if (dispatchRef) {
          const r = await dispatchRef('approval', 'request', {
            kind: 'task-complete', subject: `task:${args.task_id}`,
            evidence: String(args.summary || ''),
            payload: { task_id: Number(args.task_id), summary: args.summary, evidence: args.evidence || [], follow_up: args.follow_up || '' },
          }, { actor: 'model', session_id: ctx.session_id || null })
          if (r && r.ok) requestId = r.data?.request_id ?? r.data?.id ?? null
          else if (r?.error) throwErr(r.error.code, r.error.message, r.error.hint, r.error.retryable)
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
      if (t.schedule_kind === 'interval') {
        repo.transitionTask(Number(args.task_id), { result: tail })
        return { data: { task_id: Number(args.task_id), scheduled: true, status: t.status, next_run_at: t.next_run_at, acknowledged: true } }
      }
      // L1：审批落成收尾同样先固定 FGS 快照（弱联动，缺快照显式 null）
      const fgsSnapshot = await pinFgsSnapshot(Number(args.task_id), null)
      repo.transitionTask(Number(args.task_id), { status: 'done', result: tail, finished_at: nowTs }, t.status)
      return {
        data: { task_id: Number(args.task_id), status: 'done' },
        events: [{ name: 'task.finished', payload: { task_id: Number(args.task_id), program_id: t.program_id, run_id: '', ok: true, outcome: 'done', schedule_kind: t.schedule_kind, next_run_at: null, session_id: null, guard: { checked: false, missing: [] }, truth: { checked: false, rejected: false, reason: '' }, fgs_snapshot: fgsSnapshot, cause: 'approval' } }],
        after: { task_id: Number(args.task_id), status: 'done' },
      }
    },
  }

  const queries = {
    task_list: async (args, repo) => {
      const filters = { program_id: args.program_id, status: args.status, phase: args.phase, goal: args.goal, q: args.q, bucket: args.bucket, scheduled: args.scheduled }
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
      const nowTs = Date.now()
      const intervalRows = []
      let maxDriftMinutes = 0
      let anchorMissing = 0
      for (const t of rows) {
        if (t.schedule_kind !== 'interval' || !t.every_seconds || !t.next_run_at) continue
        const hasAnchor = Number.isFinite(t.run_at) && t.run_at > 0
        const nextBj = _beijingIso(t.next_run_at)
        const driftMin = Math.round(Math.abs(t.next_run_at - nowTs) / 60_000)
        if (driftMin < t.every_seconds / 60 && driftMin > maxDriftMinutes) maxDriftMinutes = driftMin
        if (!hasAnchor) anchorMissing++
        intervalRows.push({ id: t.id, program_id: t.program_id, phase: t.phase, anchor_ok: hasAnchor, next_run_at: t.next_run_at, next_run_bj: nextBj, drift_minutes: driftMin })
      }
      // 异常任务：锚点缺失（需迁移脚本校准）或 next_run_at 明显错位到白天
      const anchorMissingIds = intervalRows.filter((r) => !r.anchor_ok).map((r) => r.id)
      let taskRunsLastAgeHours = null
      try {
        const last = repo.listTaskRunsWhere({}, 1, 0)
        if (last && last.length && last[0].finished_at) taskRunsLastAgeHours = Math.round((nowTs - last[0].finished_at) / 3600000)
      } catch { /* ignore */ }
      return { scheduled_drift: maxDriftMinutes, anchor_missing: anchorMissing, anchor_missing_ids: anchorMissingIds, interval_tasks: intervalRows, task_runs_last_age_hours: taskRunsLastAgeHours }
    },
  }

  const subscribers = {
    // L6（设计 §10 变更触发节奏）：卡片撤回 → 生成有预算的重测需求（goal=change-retest）。
    // 入队不自动起 worker（无 schedule 不被调度循环认领）——由人/编排决定 task_run_now；
    // 已暂停（blocked）任务不因此自行恢复。去重：同 release 已有活动重测任务则跳过（事件重放零重复）。
    onReleaseRevoked: async (envelope) => {
      if (!dispatchRef) return { ok: true, data: { skipped: true } }
      const p = envelope?.payload || {}
      if (!p.release_id) return { ok: true, data: { skipped: true, reason: '载荷缺 release_id' } }
      const marker = `[change-retest ${p.release_id}]`
      try {
        const dup = await queryRef('task', 'list', { q: marker, bucket: 'active', limit: 10 }, { actor: 'reactor' })
        // 总线 rows 类查询平铺返回 {rows,total}（非 data 包装）
        if (dup && (dup.total || 0) > 0) return { ok: true, data: { skipped: true, reason: '已有活动重测任务', task_id: dup.rows[0]?.id } }
        // program 灰度按 Program 归属；family/global 撤回的重测需求入 '_global' 桶（跨项目事项，不伪造项目归属）
        const programId = p.scope_type === 'program' && p.scope_id ? String(p.scope_id) : '_global'
        const objective = `${marker} 已发布知识卡 ${p.artifact_kind}/${p.artifact_id}（revision ${p.revision_id}，范围 ${p.scope_type}/${p.scope_id || '全局'}）被撤回（原因：${String(p.reason || '未给出').slice(0, 120)}）。`
          + '请按预算复核：① 该卡此前参与结论的 finding/episode 是否需要复验或翻案；② 相关负知识是否因撤回失效；③ 结论写入 task_update_note。'
          + '本任务由撤回事件自动生成；证据对照与版本链见看板「学习」tab。'
        const r = await dispatchRef('task', 'create', {
          program_id: programId,
          goal: 'change-retest', objective, priority: 3, budget_tokens: 200000,
        }, { actor: 'reactor', cause: envelope })
        if (r && r.ok) return { ok: true, data: { skipped: false, task_id: r.data.task_id } }
        return { ok: false, error: { code: r?.error?.code || 'E_INTERNAL', message: r?.error?.message || 'change-retest 任务创建失败' } }
      } catch (e) {
        return { ok: false, error: { code: 'E_INTERNAL', message: String(e?.message || e) } }
      }
    },
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
      // 事件用 null 表示未知；命令 schema 的可选字段应省略，不能把 null
      // 当作 string/integer 传入（dashboard 发起的 worker 通常没有来源 Session）。
      const args = Object.fromEntries(Object.entries({
        run_id: p.run_id, dedupe_key: p.dedupe_key, task: p.task, cwd: p.cwd, task_id: p.task_id,
        pid: p.pid, timeout_sec: p.timeout_sec, session_id: p.origin_session_id || p.session_id, run_dir: p.run_dir,
      }).filter(([, value]) => value != null))
      return dispatchRef('task', 'worker_register', args, { actor: 'reactor' })
    },
    onWorkerFinished: async (envelope) => {
      if (!dispatchRef) return { ok: true, data: { skipped: true } }
      const p = envelope?.payload || {}
      if (!p.run_id) return { ok: true, data: { skipped: true } }
      const outcome = p.status === 'done' ? 'done' : (p.status === 'killed' ? 'killed' : 'failed')
      return dispatchRef('task', 'worker_finish', {
        run_id: p.run_id, outcome, ...(p.exit_code == null ? {} : { exit_code: p.exit_code }),
        ...(p.worker_session_id ? { worker_session_id: p.worker_session_id } : {}),
      }, { actor: 'reactor' })
    },
  }

  return { ...commands, queries, invariants, subscribers }
}

// ---------------------------------------------------------------------------
// 调度器（域内部组件，仅 web profile；L6 接管：v5 唯一持锁者）
// 行为口径 = 05-task.md §2.3「调度器实现」表 + v4 scheduler.js 逐项移植（命令化）：
//   文件锁单例（180s 心跳超时可抢/exit 删锁）→ 60s tick → task_claim（≤4/tick）→
//   工作区 cwd 解析（scope 域 program_list）→ persona（host-compat PHASE_PRESET 同读）→
//   预算 max(3600, min(budget_timeout_sec,7200)) + goal 上限帽 → 非续跑 FGS 初始化 →
//   buildScheduledPrompt → dispatch exec.spawn_worker（cwd+task_id+force）→
//   busy 回 queued / timed_out→超时审批（纯空跑不提）/ 会话反查回填 → task_finish；
//   每 10 tick：reap+worker_reap+会话归组；每日 05 时后首个 tick 触发 know.kb_vault_sync。
// ---------------------------------------------------------------------------

function pidAlive(pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}

// worker.log 尾部噪声（headless 进程 stderr 杂讯）不进任务摘要/超时审批证据（与 v4 同表）
const WORKER_NOISE_RE = /ExperimentalWarning|trace-warnings|EADDRINUSE|xray webhook 启动失败|onnxruntime|pthread_setaffinity|\[memcore|secMemoryLifecycle|sweeper 未启动/

// 学习目标（§10 四类节奏）每 tick 至多认领 1 个（其余 finish(busy) 回 queued 下一 tick 再试）
const LEARNING_GOALS = new Set(['learn-daily', 'eval-batch', 'change-retest'])
// 学习/评测任务无显式预算延长时的上限帽（秒）——有批准过的 budget_timeout_sec 时沿用通用规则
const GOAL_TIMEOUT_CAPS = { 'learn-daily': 1800, 'eval-batch': 3600, 'change-retest': 3600 }

function _ok(result) { return !!(result && result.ok) }
function _errCode(result) { return result && result.error && result.error.code ? result.error.code : 'E_INTERNAL' }
function _errMsg(result) { return (result && result.error && result.error.message) || '' }

export function startTaskScheduler(opts) {
  const { dataDir, dispatch, query, getSessionPersistence, getWorkspaceRegistry } = opts
  const repo = opts.repo || null // backend 直传（scheduledProgress 续跑检测需要）；为 null 时按全新运行处理
  const tickMs = Number(opts.tickMs) > 0 ? Number(opts.tickMs) : SCHEDULER_TICK_MS // tickMs 仅测试注入（生产恒 60s）
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
  if (!acquire()) return { started: false, reason: 'scheduler.lock 被其他进程持有（活锁心跳未过期）' }
  process.once('exit', () => { try { if (holds()) fs.unlinkSync(lockPath) } catch { /* ignore */ } })

  // 启动即回收：本进程新启动意味着旧调度进程已终止，其派发的 running 任务均为孤儿 → 无条件回收
  try { dispatch('task', 'reap', { max_age: 0 }, { actor: 'scheduler' }).catch(() => {}) } catch { /* 启动回收失败不阻断 */ }
  try { dispatch('task', 'worker_reap', {}, { actor: 'scheduler' }).catch(() => {}) } catch { /* 启动对账失败不阻断 */ }

  const readPersona = createPersonaReader()

  // 工作区路径解析：v4 查 assetDb.listPrograms()；v5 走 scope 域 program_list（queryRef）——
  // 弱联动：查不到返回 null（沿用 v4 语义），spawn 回落 runDir 工作目录。
  let programCache = { at: 0, rows: [] }
  async function workspacePathOfProgram(programId) {
    if (!programId) return null
    if (Date.now() - programCache.at > 60000) {
      try {
        const r = await query('scope', 'program_list', {}, { actor: 'scheduler' })
        // 列表查询信封把 rows 放在顶层（bus.query 约定），非 r.data.rows；
        // 读错字段会导致 workspace_path 恒为 null → worker cwd 回落 runDir → 会话无法归组工作区。
        if (_ok(r)) {
          const rows = Array.isArray(r.rows) ? r.rows : ((r.data && Array.isArray(r.data.rows)) ? r.data.rows : [])
          programCache = { at: Date.now(), rows }
        }
      } catch (e) { log(`program_list 查询失败（沿用缓存）: ${e?.message}`) }
    }
    const hit = (programCache.rows || []).find((x) => x.id === programId)
    return (hit && hit.workspace_path) || null
  }

  // P15 会话反查回填：headless worker 的会话按 header.cwd=工作区 + 时间窗（±60s 在 matchWorkerSession 内）取，
  // 并发歧义/列表不完整时不造跳链（返回 null）。
  async function findWorkerSessionId(cwd, startedAt, reportedId = null) {
    try {
      const sp = getSessionPersistence ? getSessionPersistence() : null
      if (!sp || !cwd) return null
      const { headers, diagnostics } = await listSessionHeaders(sp)
      if (diagnostics.length) { log(`worker Session 列表不完整，拒绝反查: ${JSON.stringify(diagnostics)}`); return null }
      const result = matchWorkerSession(headers, { cwd, startedAt, finishedAt: Date.now(), reportedId })
      if (result.code) log(`worker Session 关联: ${JSON.stringify(result)}`)
      return result.id
    } catch (e) { log(`worker Session 反查失败: ${e?.message}`); return null }
  }

  // 工作区会话归组 reconcile：headless worker/CLI 会话按 header.cwd 匹配工作区 attachSession（幂等）
  async function reconcileWorkspaceSessions() {
    const wr = getWorkspaceRegistry ? getWorkspaceRegistry() : null
    const sp = getSessionPersistence ? getSessionPersistence() : null
    if (!wr || !sp) return
    let headers
    try {
      const result = await listSessionHeaders(sp)
      headers = result.headers
      if (result.diagnostics.length) log(`Session 列表存在无效记录: ${JSON.stringify(result.diagnostics)}`)
    } catch (e) { log(`Session 列表读取失败: ${e?.message}`); return }
    let workspaces
    try { workspaces = wr.list() } catch { return }
    const byPath = {}
    for (const w of workspaces) byPath[w.path] = w
    for (const h of headers) {
      const w = h && h.cwd ? byPath[String(h.cwd)] : null
      if (!w) continue
      try { await w.attachSession(h.id) } catch { /* 单个失败不影响其余 */ }
    }
  }

  async function schedulerTick() {
    let claimed = []
    try {
      const r = await dispatch('task', 'claim', { now: Date.now() }, { actor: 'scheduler' })
      claimed = (_ok(r) && r.data && r.data.claimed) || []
    } catch (e) { log(`调度认领失败: ${e?.message}`); return }
    if (!claimed.length) { await dailyVaultSync(); return }
    const tasks = []
    for (const taskId of claimed) {
      try {
        const g = await query('task', 'get', { task_id: taskId }, { actor: 'scheduler' })
        const row = _ok(g) && g.data ? g.data : null
        if (!row) throw new Error(`task_get ${_errCode(g)}: ${_errMsg(g)}`)
        tasks.push(row)
      } catch (e) {
        log(`调度取任务 #${taskId} 失败: ${e?.message}`)
        // 取数失败也要显式收尾（crash）——认领后静默跳过会把任务卡死在 running 直到回收宽限
        try { await dispatch('task', 'finish', { task_id: taskId, run_id: '', outcome: 'crash', note: `调度取任务失败: ${e?.message || ''}`.slice(0, 300) }, { actor: 'scheduler' }) } catch { /* ignore */ }
      }
    }
    // 学习目标节奏闸：每 tick 至多 1 个 learn-daily/eval-batch/change-retest，其余回 queued
    let learningTaken = 0
    await Promise.allSettled(tasks.map((task) => (async () => {
      const startedAt = Date.now()
      try {
        if (task.goal && LEARNING_GOALS.has(task.goal)) {
          learningTaken++
          if (learningTaken > 1) {
            log(`任务 #${task.id}（goal=${task.goal}）学习节奏闸：本 tick 已有学习任务，回 queued`)
            await dispatch('task', 'finish', { task_id: task.id, run_id: '', outcome: 'busy' }, { actor: 'scheduler' })
            return
          }
        }
        const cwd = await workspacePathOfProgram(task.program_id)
        let role = ''
        try { role = readPersona(dataDir, task.phase || '', cwd) } catch (e) {
          // E_PERSONA_READ：v4 拒绝无角色派单（异常进兜底 crash），v5 降级为空角色并显式留痕
          log(`任务 #${task.id} 人格读取失败（按无角色继续）: ${e?.message}`)
        }
        // 预算：max(默认上限 3600, min(批准延长, 7200))；学习目标无显式延长时按 goal 帽收紧
        let timeoutSec = Math.max(SCHEDULER_TASK_TIMEOUT_SEC, Math.min(Number(task.budget_timeout_sec) || 0, MAX_WORKER_TIMEOUT_SEC))
        const cap = GOAL_TIMEOUT_CAPS[task.goal]
        if (cap && !(Number(task.budget_timeout_sec) > 0)) timeoutSec = Math.min(timeoutSec, cap)
        // 续跑检测（v4 taskScheduledProgress 同源）：上一轮失败 → 保留 FGS 检查点续跑
        let progress = { attempts: 0, resume: false, resume_run_id: null }
        if (repo && typeof repo.scheduledProgress === 'function') {
          try { progress = repo.scheduledProgress(task, startedAt) } catch (e) { log(`任务 #${task.id} 续跑检测失败（按全新运行）: ${e?.message}`) }
        }
        // FGS 初始化：非续跑周期清旧图并写入顶层 goal（图生命周期与任务绑定，14-fgs 契约）
        if (!progress.resume) {
          try {
            await dispatch('fgs', 'clear', { task_id: task.id }, { actor: 'scheduler' })
            await dispatch('fgs', 'add', { task_id: task.id, type: 'goal', content: { summary: String(task.objective || '').slice(0, 200) || '定时任务目标', detail: String(task.objective || '') } }, { actor: 'scheduler' })
          } catch (e) { log(`任务 #${task.id} FGS 初始化失败: ${e?.message}`) }
        }
        const prompt = buildScheduledPrompt(task, role, { ...progress, timeoutSec, startedAt })
        // 派 worker：cwd=工作区（v4 等价——会话反查/工作区归组依赖 header.cwd 一致）；
        // force 跳过 dedupe 恢复窗（周期任务重跑是必然，dedupe 的 done 窗口恢复会把"已收尾再启动"的周期吞掉）
        const spawnArgs = { task: prompt, timeout: timeoutSec, force: true, provider: task.provider || undefined, model: task.model || undefined, phase: task.phase || '', task_id: task.id }
        if (cwd) spawnArgs.cwd = cwd
        let r
        try {
          r = await dispatch('exec', 'spawn_worker', spawnArgs, { actor: 'scheduler' })
        } catch (e) {
          // busy（并发上限）是瞬态：回 queued 下 tick 再认领（不落 run 史）；
          // 其余抛错（域未注册/宿主故障等）非瞬态——抛给外层兜底记 crash，可见可查
          if (e && e.code === 'E_EXEC_WORKER_BUSY') {
            log(`任务 #${task.id} worker 并发已满，回 queued`)
            await dispatch('task', 'finish', { task_id: task.id, run_id: '', outcome: 'busy' }, { actor: 'scheduler' }).catch(() => {})
            return
          }
          throw e
        }
        if (!_ok(r)) {
          const code = _errCode(r)
          if (code === 'E_EXEC_WORKER_BUSY') {
            await dispatch('task', 'finish', { task_id: task.id, run_id: '', outcome: 'busy' }, { actor: 'scheduler' })
            return
          }
          throw new Error(`spawn_worker ${code}: ${_errMsg(r)}`)
        }
        const w = r.data || {}
        // 幂等恢复路径命中在飞 worker：本 tick 让位（任务回 queued，在飞的那轮由宿主重启恢复路径负责）
        if (w.in_progress) {
          log(`任务 #${task.id} 同任务 worker 在飞（run ${w.run_id}），本 tick 让位`)
          await dispatch('task', 'finish', { task_id: task.id, run_id: '', outcome: 'busy' }, { actor: 'scheduler' })
          return
        }
        const tailLines = String(w.tail || '').split('\n').filter((l) => l.trim() && !WORKER_NOISE_RE.test(l))
        let note = ''
        let timedOut = false
        if (w.timed_out || (w.timed_out === undefined && !w.ok && w.exit_code === null && Number(w.duration_ms || 0) >= timeoutSec * 1000 - 15000)) {
          note = `worker 超时（${timeoutSec} 秒预算，本周期第 ${(progress.attempts || 0) + 1}/3 次）；FGS 与执行产物已保留供续跑`
          timedOut = true
        } else if (w.cancelled) {
          note = 'worker 被取消；执行产物已保留'
        } else {
          note = tailLines.slice(-3).join(' ').slice(0, 300)
        }
        // 超时自动提请 task-budget-extend（审批域同 (kind,subject) pending 查重天然幂等）。
        // 纯空跑不提（尾部去噪后无实质产出不配延预算）——按 05-task §2.3 口径。
        if (timedOut && timeoutSec < MAX_WORKER_TIMEOUT_SEC && tailLines.length) {
          try {
            const tailEvidence = tailLines.slice(-5).join(' ').slice(0, 400)
            const add = await dispatch('approval', 'request', {
              kind: 'task-budget-extend', subject: `task:${task.id}`, program_name: task.program_id,
              payload: { task_id: task.id, program: task.program_id, timed_out_at_sec: timeoutSec, budget_timeout_sec: MAX_WORKER_TIMEOUT_SEC, run_id: w.run_id || null, tail: tailEvidence },
              evidence: `任务 #${task.id}（${task.program_id}/${task.phase || '-'}）worker 跑满 ${timeoutSec}s 预算。批准后下周期预算上限 ${MAX_WORKER_TIMEOUT_SEC}s；尾部输出不能单独证明实际进度`,
            }, { actor: 'scheduler' })
            if (_ok(add)) log(`任务 #${task.id} 超时，已自动提请 task-budget-extend 审批`)
            else log(`任务 #${task.id} 超时审批提请未成功: ${_errCode(add)} ${_errMsg(add)}`)
          } catch (e) { log(`任务 #${task.id} 超时审批提请失败: ${e?.message}`) }
        }
        // 会话反查回填：exec meta.json 由 worker 侧写 session_id（宿主回执可能缺），这里按 cwd+时间窗补齐跳链
        const workerSessionId = w.session_id || await findWorkerSessionId(cwd, startedAt, null)
        const truth = w.truth && typeof w.truth === 'object' ? w.truth : { checked: false, rejected: false, reason: '' }
        const outcome = (w.ok && !timedOut && !w.cancelled) ? 'done' : 'failed'
        const fin = await dispatch('task', 'finish', {
          task_id: task.id, run_id: w.run_id || '', outcome, note,
          session_id: workerSessionId ?? null, truth, timed_out: timedOut,
        }, { actor: 'scheduler' })
        if (!_ok(fin)) log(`任务 #${task.id} task_finish 未成功: ${_errCode(fin)} ${_errMsg(fin)}`)
      } catch (e) {
        log(`调度任务 #${task.id} 执行异常: ${e?.stack || e?.message || String(e)}`)
        try { await dispatch('task', 'finish', { task_id: task.id, run_id: '', outcome: 'crash', note: `调度执行异常: ${e?.message || ''}`.slice(0, 300) }, { actor: 'scheduler' }) } catch { /* ignore */ }
      }
    })()))
    await dailyVaultSync()
  }

  // vault 回流（Bellkeeper 融合方向②）：每日 05 时（北京）后首个 tick 触发 know 域 kb 同步——
  // v4 走 experience.kbVaultSync 直调；v5 经 know 域命令 C32 know_kb_vault_sync（弱联动，失败不阻断调度）。
  let lastVaultSyncDay = ''
  async function dailyVaultSync() {
    const bj = new Date(Date.now() + _BEIJING_OFFSET_MS)
    const day = bj.toISOString().slice(0, 10)
    if (lastVaultSyncDay === day || bj.getUTCHours() < 5) return
    lastVaultSyncDay = day
    try {
      const r = await dispatch('know', 'kb_vault_sync', {}, { actor: 'scheduler' })
      log(`vault 回流: ${JSON.stringify(r && r.data ? r.data : r)}`)
    } catch (e) { log(`vault 回流异常: ${e?.message}`) }
  }

  let tick = 0
  globalThis.__silksecTaskScheduler = setInterval(async () => {
    if (!holds() && !acquire()) return
    try { fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, ts: Date.now() })) } catch { /* ignore */ }
    tick++
    if (tick % 10 === 0) {
      try { await dispatch('task', 'reap', { max_age: (SCHEDULER_TASK_TIMEOUT_SEC + 900) * 1000, pid_alive: true }, { actor: 'scheduler' }) } catch (e) { log(`周期回收失败: ${e?.message}`) }
      try { await dispatch('task', 'worker_reap', {}, { actor: 'scheduler' }) } catch (e) { log(`worker 对账失败: ${e?.message}`) }
      try { await reconcileWorkspaceSessions() } catch (e) { log(`工作区会话归组失败: ${e?.message}`) }
    }
    try { await schedulerTick() } catch (e) { log(`调度 tick 异常: ${e?.stack || e?.message}`) }
  }, tickMs)
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
  let persistenceRef = null      // 宿主会话头部投影（会话反查/归组；headless profile 无此服务）
  let workspaceRegistryRef = null // 工作区注册表（会话归组；headless profile 无此服务）
  try {
    ctx.inject(['sessionPersistence'], (child) => {
      persistenceRef = child.sessionPersistence
      return () => { persistenceRef = null }
    })
  } catch { /* 无 sessionPersistence（headless）*/ }
  try {
    ctx.inject(['workspaceRegistry'], (child) => {
      workspaceRegistryRef = child.workspaceRegistry
      return () => { workspaceRegistryRef = null }
    })
  } catch { /* 无 workspaceRegistry（headless）*/ }
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
        // L6（学习专项 §10 调度器独立切换）：v5 调度器接管为唯一持锁者——v4 sec-suite
        // scheduler.js 循环已在本切片停用（同包部署原子生效，无并行第二派单循环窗口）。
        // 仅 web 宿主面启动：调度循环与 claim/finish/reap 等价性经契约测试钉死后切换；
        // 文件锁 + 60s tick 与 v4 同口径，启动即回收旧进程孤儿任务。
        const isWeb = process.argv.includes('web')
        if (isWeb && config.sidecars !== false) {
          const started = startTaskScheduler({
            dataDir,
            dispatch: (d, v, a, c) => bus.dispatch(d, v, a, c),
            query: (d, n, a, c) => bus.query(d, n, a, c),
            repo: domain.backend,
            getSessionPersistence: () => persistenceRef,
            getWorkspaceRegistry: () => workspaceRegistryRef,
          })
          log(started.started
            ? `task 调度循环已启动（唯一持锁者，60s tick，pid=${process.pid}）`
            : `task 调度器未启动：${started.reason}`)
        } else {
          log('task 调度器未启动（非 web 宿主面或 sidecars 关闭）')
        }
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
