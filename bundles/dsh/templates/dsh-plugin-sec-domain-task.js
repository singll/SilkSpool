// ==============================================================================
// @silksec/sec-domain-task — SilkSecAgent task 域插件（v5 Phase 2.4：任务/调度/执行史/worker 注册表）
//
// 契约：doc/secagent/05-task.md（域设计，权威）+ 01-bus.md + 00-conventions.md
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
import { h1Hypotheses, taintRoute, strategyKey, compileSituation, detectInjectionPatterns, compileCampaignPlan, classifyTaskClass, decideThrottle, selectCampaignModel } from '../sec-rules-hypothesis/index.js'
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
// 22 号方案 §5.2：Campaign 子任务角色（归因 + Reviewer 验收分派）
const CAMPAIGN_ROLES = ['seed', 'derived', 'verify', 'submit', 'retest', 'learn']
const CAMPAIGN_STATUS = ['draft', 'active', 'paused', 'reviewing', 'archived']
const CAMPAIGN_MODES = ['single', 'cross']
const CAMPAIGN_VERDICTS = ['accepted', 'rework', 'rejected', 'escalated']
const CAMPAIGN_MILESTONE_IDLE_MS = Number(process.env.SEC_CAMPAIGN_IDLE_HOURS || 48) * 3600000
const CAMPAIGN_TICK_LIMIT = Number(process.env.SEC_CAMPAIGN_TICK_LIMIT || 10)
// 22 号方案：单条派生草稿的预算预估（tokens，环境变量可调；用于 campaign 窗口预算闸）
// 23 号方案 §3.6：默认随统一额度面调为 30000（worker 未上报 token 前的保守估算）
const CAMPAIGN_ESTIMATE_TOKENS_PER_DRAFT = Number(process.env.SEC_CAMPAIGN_ESTIMATE_TOKENS_PER_DRAFT || 30000)
const CAMPAIGN_KINDS = ['hypothesis', 'crawl', 'param_enrich', 'asset_enum', 'review_finding']
// 22 号方案运行期：rework 后策略重开冷却（默认 6h；rejected 不回写重开）
const CAMPAIGN_REWORK_REOPEN_MS = Number(process.env.SEC_CAMPAIGN_REWORK_REOPEN_HOURS || 6) * 3600000
// 23 号方案 §3.6：每 tick 派生上限默认 8（v2 调高：5→8）
const CAMPAIGN_DERIVE_CAP_PER_TICK = Number(process.env.SEC_CAMPAIGN_DERIVE_CAP_PER_TICK || 8)
// 23 号方案 §3.6：新建专项默认窗口预算 2M/7d（autonomy<2；L2 仍须显式预算 INV-C4）
const CAMPAIGN_DEFAULT_BUDGET_TOKENS = Number(process.env.SEC_CAMPAIGN_DEFAULT_BUDGET_TOKENS || 2000000)
// 23 号方案 §3.7 Path A：worker 指定模型时的 provider（DSH settings.yaml 的网关 provider id）
const CAMPAIGN_MODEL_PROVIDER = String(process.env.SEC_CAMPAIGN_MODEL_PROVIDER || 'bellkeeper')

// ---------------------------------------------------------------------------
// 23 号方案 §3.6：专项 LLM 供给统一额度面（一处调额度）
// 全部从 env 读取的确定性解析（契约测试钉死）；非法值回落默认，永不抛错。
// ---------------------------------------------------------------------------
export function parseCampaignSupplyEnv(env = process.env) {
  const e = env || {}
  const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d }
  const ratio = (v, d) => { const n = Number(v); return Number.isFinite(n) && n >= 0 && n <= 1 ? n : d }
  const bool = (v, d) => (v == null || v === '') ? d : !/^(off|0|false|no)$/i.test(String(v))
  const list = (v, d) => String(v == null || v === '' ? d : v).split(',').map((s) => s.trim()).filter(Boolean)
  return {
    gate: bool(e.SEC_CAMPAIGN_SUPPLY_GATE, true),
    members: list(e.SEC_CAMPAIGN_POOL_MEMBERS, 'sensenova-secagent,deepseek-secagent,opencode-go-secagent'),
    mainWeight: num(e.SEC_CAMPAIGN_SUPPLY_MAIN_WEIGHT, 4),
    warnRatio: ratio(e.SEC_CAMPAIGN_SUPPLY_WARN_RATIO, 0.15),
    slowFactor: ratio(e.SEC_CAMPAIGN_SUPPLY_SLOW_FACTOR, 0.4),
    probeTimeoutMs: num(e.SEC_CAMPAIGN_SUPPLY_PROBE_TIMEOUT_MS, 3000),
    probeMax: num(e.SEC_CAMPAIGN_SUPPLY_PROBE_MAX, 3),
    deriveCapPerTick: num(e.SEC_CAMPAIGN_DERIVE_CAP_PER_TICK, 8),
    estimateTokensPerDraft: num(e.SEC_CAMPAIGN_ESTIMATE_TOKENS_PER_DRAFT, 30000),
    defaultBudgetTokens: num(e.SEC_CAMPAIGN_DEFAULT_BUDGET_TOKENS, 2000000),
    modelStrategy: /^weight$/i.test(String(e.SEC_CAMPAIGN_MODEL_STRATEGY || 'auto')) ? 'weight' : 'auto',
    modelMain: String(e.SEC_CAMPAIGN_MODEL_MAIN || 'deepseek-v4.1-flash'),
    modelFallbacks: list(e.SEC_CAMPAIGN_MODEL_MAIN_FALLBACK, 'glm-5.2,deepseek-v4-flash'),
    flashliteFirst: bool(e.SEC_CAMPAIGN_FLASHLITE_FIRST, true),
    modelSelector: /^dsh$/i.test(String(e.SEC_CAMPAIGN_MODEL_SELECTOR || 'bellkeeper')) ? 'dsh' : 'bellkeeper',
    // §3.7 Path B 配置化承接：task_class → Bellkeeper 模型组（空则不映射，用 member 级具体模型）
    classGroups: (() => {
      const out = {}
      for (const part of String(e.SEC_CAMPAIGN_CLASS_GROUPS || '').split(',')) {
        const [cls, grp] = part.split(':').map((s) => String(s || '').trim())
        if (['lite', 'std', 'heavy'].includes(cls) && grp) out[cls] = grp
      }
      return out
    })(),
    llmBaseUrl: String(e.SEC_CAMPAIGN_LLM_URL || '').replace(/\/+$/, ''),
    apiKey: e.BELLKEEPER_LLM_API_KEY || e.BELLKEEPER_API_KEY || e.SEC_EVAL_LLM_KEY || '',
  }
}

// Bellkeeper 管理面基址：显式 SEC_CAMPAIGN_LLM_URL 优先，否则从 eval LLM URL 推导，最后默认 keeper。
function defaultLlmBaseUrl(env = process.env) {
  const evalUrl = String(env.SEC_EVAL_LLM_URL || '')
  const m = evalUrl.match(/^(https?:\/\/[^/]+)/)
  return m ? m[1] : 'http://192.168.7.230:8090'
}
const CAMPAIGN_LEVELS = ['H1', 'H2', 'H3']
// 21 号方案 §3-4：per-program 周期预算闸（环境变量可调；dashboard/approval 人工放行）
const BUDGET_PERIOD_MS = Number(process.env.SEC_TASK_BUDGET_PERIOD_DAYS || 7) * 86400000
const BUDGET_MAX_TOKENS = Number(process.env.SEC_TASK_BUDGET_MAX_TOKENS || 2000000)
const BUDGET_MAX_TASKS = Number(process.env.SEC_TASK_BUDGET_MAX_TASKS || 500)
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
    tables: ['tasks', 'task_runs', 'workers', 'strategy_dedupe'],
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
        campaign_id: int({ minimum: 1, description: '归属专项（22 号方案 §5.2）；非空 ⇒ schedule_kind 不得为 interval（INV-C7），写入后不可改（INV-C2）' }),
        campaign_role: en(CAMPAIGN_ROLES, { description: '专项子任务角色：seed/derived/verify/submit/retest/learn' }),
        strategy_key: str({ description: '（内部）派生策略裸键 host|path|param|vuln_class——供 Reviewer rework 重开/连败回写归因' }),
        task_class: en(['lite', 'std', 'heavy'], { description: '（内部）23 号方案任务分档标注：lite 轻任务/ std 常规/ heavy 重任务；Path B 交 Bellkeeper 侧策略路由' }),
        model_hint: str({ description: '（内部）23 号方案 Path A：派生负载带模型提示（selector=dsh 时由 task 域自主选模型）' }),
      }, ['objective']),
      idempotent: 'auto',
      idempotent_fields: ['program_id', 'objective', 'phase', 'goal', 'priority', 'parent_id', 'budget_tokens', 'assignee', 'schedule', 'provider', 'model', 'reasoning_effort', 'campaign_id', 'campaign_role', 'strategy_key'],
      events: ['task.created'],
      event_limit: 1,
      invariants: ['scheduleValid', 'intrusiveInterval', 'campaignTaskValid'],
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
      actor: ['model', 'dashboard', 'reactor'],
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
      actor: ['model', 'dashboard', 'reactor'],
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
        spent_tokens: int({ minimum: 0 }),
      }, ['task_id', 'outcome']),
      idempotent: 'natural',
      idempotent_natural: ['task_id', 'run_id'],
      events: ['task.finished'],
      event_limit: 1,
      invariants: ['finishEvidence'],
      timeout_ms: 60000,
      agent_note: '调度器专用收尾：真实性判定 + 流程守卫 + 落执行史 + interval 续期 + 成本归因（spent_tokens 回填，超 budget_tokens 记 [预算超支]）。',
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
    task_submission_backlog: {
      actor: ['dashboard', 'system', 'human'],
      schema: schema({
        program_id: str({ default: '' }),
        limit: int({ minimum: 1, maximum: 200, default: 50 }),
      }, []),
      idempotent: 'none',
      events: [],
      event_limit: 1,
      invariants: [],
      timeout_ms: 120000,
      agent_note: '产出闭环补建：扫描 vuln.submission_queue（confirmed 未提交），为每条幂等入队 [提交] finding #id 任务（内部去重）。历史存量一次性使用；新确认由 vuln.signal.confirmed 自动入队。',
      deprecated: false,
    },
    task_derive_intent: {
      actor: ['reactor', 'scheduler', 'system', 'human'],
      schema: schema({
        program_id: str({ minLength: 1 }),
        kind: en(['hypothesis', 'crawl', 'param_enrich', 'asset_enum', 'review_finding']),
        host: str({ minLength: 1 }),
        path: str({ default: '' }),
        vuln_class: str({ default: '' }),
        param: str({ default: '' }),
        level: en(['H1', 'H2', 'H3'], { default: 'H2' }),
        rationale: str({ default: '' }),
        oracle: str({ default: '' }),
        h3: { type: 'object' },
        strategy_key: str({ default: '' }),
        campaign_id: int({ minimum: 1 }),
        campaign_role: en(CAMPAIGN_ROLES),
        // 23 号方案 §3.7：任务分档标注（Path B 纯元数据）+ Path A 模型提示
        task_class: en(['lite', 'std', 'heavy']),
        model_hint: str({ default: '' }),
        model_channel: str({ default: '' }),
        model_reason: str({ default: '' }),
        // Path A：worker 侧模型指定（provider+model 成对，落 tasks 表后由调度器传给 spawn_worker）
        provider: str({ default: '' }),
        model: str({ default: '' }),
      }, ['program_id', 'kind', 'host']),
      // 幂等由 handler 内 strategy_dedupe 表自治（返回 deduped:true / 黑名单丢弃）；
      // 不用 bus 层 natural 幂等——回放会吞掉 deduped 语义并绕过黑名单判定
      idempotent: 'none',
      events: ['task.intent.derived'],
      event_limit: 1,
      invariants: ['intentSituation'],
      timeout_ms: 60000,
      agent_note: '（内部通道，模型不可见）Intent 确定性派生器落任务草稿：H1 指纹保底/H2 污点路由/H3 语义假设（H3 必须引用卡片经局面编译，违规丢弃落审计）。strategy_key 幂等去重、连败 3 次黑名单；一律过预算闸，入队 queued 绝不自动执行。',
      deprecated: false,
    },
    // ---- 22 号方案 §八：Campaign（专项）命令 ----
    campaign_create: {
      actor: ['model', 'dashboard', 'script', 'human', 'system'],
      schema: schema({
        name: str({ minLength: 2, maxLength: 120 }),
        mode: en(CAMPAIGN_MODES, { default: 'single' }),
        program_ids: { type: 'array', items: { type: 'string' }, minItems: 1 },
        goal_spec: { type: 'object', description: '{objective, vuln_classes[], targets{...}, stop_conditions[](非空), review_cadence_sec}' },
        autonomy: int({ minimum: 0, maximum: 2, default: 0 }),
        policy: { type: 'object', description: '{derive_cap_per_tick, max_active_tasks, task_priority_range, model_override, allowed_phases}' },
        budget_tokens: int({ minimum: 0 }),
        budget_window_days: int({ minimum: 1, maximum: 90, default: 7 }),
        approval_id: int(),
      }, ['name', 'program_ids', 'goal_spec']),
      idempotent: 'auto',
      idempotent_fields: ['name', 'mode', 'program_ids', 'goal_spec', 'autonomy', 'policy', 'budget_tokens', 'budget_window_days', 'approval_id'],
      events: ['task.campaign.created'],
      event_limit: 1,
      invariants: ['campaignCreateValid'],
      timeout_ms: 60000,
      agent_note: '登记专项（22 号方案）：绑定 1 个（single）或多个（cross）已授权 program，持有目标规格 goal_spec（stop_conditions 非空）与策略 policy。born=draft，不派生；激活走 campaign_activate。autonomy=2 需 budget_tokens+stop_conditions+approval_id（INV-C4）。',
      deprecated: false,
    },
    campaign_activate: {
      actor: ['dashboard', 'human', 'approval'],
      schema: schema({ campaign_id: int() }, ['campaign_id']),
      idempotent: 'auto',
      idempotent_fields: ['campaign_id'],
      events: ['task.campaign.status.changed'],
      event_limit: 1,
      invariants: ['campaignStateTransition'],
      timeout_ms: 60000,
      agent_note: '（治理动作，模型不可直调）激活/恢复专项：draft|paused → active；全量校验绑定 program 授权（INV-C1）与 autonomy 门禁（INV-C4）。',
      deprecated: false,
    },
    campaign_pause: {
      actor: ['model', 'dashboard', 'human', 'reactor'],
      schema: schema({ campaign_id: int(), note: str({ default: '' }) }, ['campaign_id']),
      idempotent: 'auto',
      idempotent_fields: ['campaign_id', 'note'],
      events: ['task.campaign.status.changed'],
      event_limit: 1,
      invariants: ['campaignStateTransition'],
      timeout_ms: 60000,
      agent_note: '暂停专项（active → paused）：不动在跑子任务；队列中 queued 子任务留待 resume。授权漂移由 Supervisor 自动调用本命令（fail-closed）。',
      deprecated: false,
    },
    campaign_resume: {
      actor: ['model', 'dashboard', 'human'],
      schema: schema({ campaign_id: int() }, ['campaign_id']),
      idempotent: 'auto',
      idempotent_fields: ['campaign_id'],
      events: ['task.campaign.status.changed'],
      event_limit: 1,
      invariants: ['campaignStateTransition'],
      timeout_ms: 60000,
      agent_note: '恢复专项（paused → active）。',
      deprecated: false,
    },
    campaign_archive: {
      actor: ['dashboard', 'human'],
      schema: schema({ campaign_id: int(), note: str({ default: '' }) }, ['campaign_id']),
      idempotent: 'auto',
      idempotent_fields: ['campaign_id', 'note'],
      events: ['task.campaign.status.changed'],
      event_limit: 1,
      invariants: ['campaignStateTransition'],
      timeout_ms: 60000,
      agent_note: '（治理动作，模型不可直调）归档专项（非终态 → archived，只读，台账保留）；同步 cancel 其 queued 子任务，在跑子任务跑完。',
      deprecated: false,
    },
    campaign_goal_revise: {
      actor: ['dashboard', 'human'],
      schema: schema({ campaign_id: int(), goal_spec: { type: 'object' }, policy: { type: 'object' } }, ['campaign_id']),
      idempotent: 'auto',
      idempotent_fields: ['campaign_id', 'goal_spec', 'policy'],
      events: ['task.campaign.goal.changed', 'task.campaign.status.changed'],
      event_limit: 2,
      invariants: ['campaignGoalUpdateValid'],
      timeout_ms: 60000,
      agent_note: '（治理动作）更新目标规格/策略；active 中改目标强制转 reviewing 待人工确认（§6.1），stop_conditions 不得清空。',
      deprecated: false,
    },
    campaign_dispatch: {
      actor: ['model', 'dashboard', 'human', 'system'],
      schema: schema({
        campaign_id: int(),
        drafts: { type: 'array', items: { type: 'object' }, minItems: 1, description: '派生草稿：{kind,host,path,param,vuln_class,level,rationale,oracle,strategy_key,program_id,campaign_role,priority,phase,goal}' },
      }, ['campaign_id', 'drafts']),
      idempotent: 'none',
      events: ['task.campaign.task.derived'],
      event_limit: 50,
      invariants: ['campaignDispatchValid'],
      timeout_ms: 120000,
      agent_note: '显式派生（L0/L1 唯一派生口；L2 也可人工补派）：把已编译草稿经 task_derive_intent/task_create 下发为 queued 子任务（actor=campaign）。草稿必须是编译后的硬约束结果；越界/黑名单/预算由派生链原样拒绝。',
      deprecated: false,
    },
    campaign_review_pass: {
      actor: ['dashboard', 'human'],
      schema: schema({ campaign_id: int(), summary: str({ maxLength: 500 }) }, ['campaign_id', 'summary']),
      idempotent: 'auto',
      idempotent_fields: ['campaign_id', 'summary'],
      events: ['task.campaign.status.changed'],
      event_limit: 1,
      invariants: ['campaignStateTransition'],
      timeout_ms: 60000,
      agent_note: '（治理动作，模型不可直调）人工审阅通过：reviewing → active；决议摘要进 checkpoints。',
      deprecated: false,
    },
    campaign_tick_now: {
      actor: ['dashboard', 'script'],
      schema: schema({ campaign_id: int() }, ['campaign_id']),
      idempotent: 'none',
      events: ['task.campaign.reviewed', 'task.campaign.escalated', 'task.campaign.task.derived', 'task.campaign.status.changed'],
      event_limit: 100,
      invariants: [],
      timeout_ms: 120000,
      agent_note: '（不向模型注册）立即对单专项跑一次 tick 段（巡检→验收→规划→下发），不超 INV-C6 界。调试/演示用。',
      deprecated: false,
    },
    campaign_tick: {
      actor: ['scheduler'],
      schema: schema({ campaign_id: int(), limit: int({ minimum: 1, maximum: 50 }) }, []),
      idempotent: 'none',
      events: ['task.campaign.reviewed', 'task.campaign.escalated', 'task.campaign.task.derived', 'task.campaign.status.changed'],
      event_limit: 200,
      invariants: [],
      timeout_ms: 120000,
      agent_note: '（内部，不向模型注册）tick 段：扫 active 专项逐条跑 Supervisor→Reviewer→Planner→Dispatcher。',
      deprecated: false,
    },
    campaign_record_decision: {
      actor: ['reactor', 'human'],
      schema: schema({
        campaign_id: int(),
        task_id: int(),
        verdict: en(CAMPAIGN_VERDICTS),
        evidence: str({ minLength: 1 }),
        goal_delta: { type: 'object' },
        decided_by: en(['reviewer', 'human'], { default: 'reviewer' }),
      }, ['campaign_id', 'task_id', 'verdict', 'evidence']),
      idempotent: 'none',
      events: ['task.campaign.reviewed', 'task.campaign.escalated'],
      event_limit: 2,
      invariants: ['campaignReviewGate'],
      timeout_ms: 60000,
      agent_note: '（内部，不向模型注册）落验收账本（一任务一验收 INV-C3；证据非空且前缀合法 INV-C8）。',
      deprecated: false,
    },
    campaign_checkpoint: {
      actor: ['reactor', 'scheduler', 'system', 'dashboard'],
      schema: schema({
        campaign_id: int(),
        kind: en(['milestone', 'escalation', 'autonomy_change', 'budget_low', 'stop_condition', 'learn_gap']),
        summary: str({ maxLength: 500 }),
        payload: { type: 'object' },
      }, ['campaign_id', 'kind']),
      idempotent: 'none',
      events: ['task.campaign.escalated'],
      event_limit: 1,
      invariants: [],
      timeout_ms: 60000,
      agent_note: '（内部/看板）写里程碑/升级记录；kind=escalation 时发 task.campaign.escalated 供看板强提醒。',
      deprecated: false,
    },
    campaign_autonomy_apply: {
      actor: ['approval'],
      schema: schema({ name: str({ minLength: 2 }), autonomy: int({ minimum: 1, maximum: 2 }), approval_id: int() }, ['name', 'autonomy', 'approval_id']),
      idempotent: 'natural',
      idempotent_natural: ['name', 'autonomy', 'approval_id'],
      events: ['task.campaign.status.changed'],
      event_limit: 1,
      invariants: [],
      timeout_ms: 60000,
      agent_note: '（approval 专用）campaign-autonomy 批准 effect：落 autonomy/approval_id 并激活专项；不向模型注册。',
      deprecated: false,
    },
    campaign_budget_extend: {
      actor: ['approval'],
      schema: schema({ name: str({ minLength: 2 }), add_tokens: int({ minimum: 1 }), approval_id: int() }, ['name', 'add_tokens', 'approval_id']),
      idempotent: 'natural',
      idempotent_natural: ['name', 'add_tokens', 'approval_id'],
      events: [],
      event_limit: 1,
      invariants: [],
      timeout_ms: 60000,
      agent_note: '（approval 专用）campaign-budget-extend 批准 effect：budget_tokens 增量落账（审计可追）；不向模型注册。',
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
        campaign_id: int({ minimum: 1 }),
        limit: int({ minimum: 1, maximum: 500 }),
        offset: int({ minimum: 0 }),
        sort: en(['priority', 'created_at'], { default: 'priority' }),
        dir: en(['asc', 'desc'], { default: 'asc' }),
      }, []),
      agent_note: '列出任务（看板数据源）。按 program/status/phase/bucket(active|history)/scheduled(only|exclude)/campaign_id 过滤，priority 升序。',
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
      actor: ['model', 'dashboard', 'human', 'reactor', 'scheduler'],
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
    campaign_list: {
      actor: ['model', 'dashboard', 'human', 'system', 'approval'],
      params: schema({
        status: en([...CAMPAIGN_STATUS, '']),
        program_id: str({ default: '' }),
        limit: int({ minimum: 1, maximum: 200 }),
        offset: int({ minimum: 0 }),
      }, []),
      agent_note: '列出专项（看板数据源）：id/name/mode/status/autonomy/进度聚合/预算消耗/heartbeat。',
    },
    campaign_get: {
      actor: ['model', 'dashboard', 'human', 'system', 'reactor'],
      params: schema({ id: int({ minimum: 1 }) }, ['id']),
      agent_note: '专项全文：goal_spec、policy、program_ids、近 N 条 decisions、活跃子任务、checkpoints、预算。',
    },
    campaign_progress: {
      actor: ['model', 'dashboard', 'human'],
      params: schema({ id: int({ minimum: 1 }) }, ['id']),
      agent_note: '目标推进投影：goal_delta 聚合（accepted/rejected/rework/escalated 计数 + confirmed 增量）+ 每 program 分解（只聚合不重算）。',
    },
    campaign_pending_drafts: {
      actor: ['model', 'dashboard', 'human'],
      params: schema({ id: int({ minimum: 1 }), limit: int({ minimum: 1, maximum: 50 }) }, ['id']),
      agent_note: 'L1 待放行派生草稿：实时跑 compileCampaignPlan 编译结果（含 skip 原因），一键放行走 campaign_dispatch。',
    },
    campaign_decisions: {
      actor: ['model', 'dashboard', 'human', 'system'],
      params: schema({
        campaign_id: int({ minimum: 1 }),
        verdict: en([...CAMPAIGN_VERDICTS, '']),
        limit: int({ minimum: 1, maximum: 500 }),
        offset: int({ minimum: 0 }),
      }, ['campaign_id']),
      agent_note: '验收账本行（看板验收队列 + 复盘数据源）。',
    },
  },
  events: {
    'task.created': { payload: { type: 'object' }, redact: [] },
    'task.intent.derived': { payload: { type: 'object' }, redact: [] },
    'task.claimed': { payload: { type: 'object' }, redact: [] },
    'task.finished': { payload: { type: 'object' }, redact: [] },
    'task.blocked': { payload: { type: 'object' }, redact: [] },
    'task.cancelled': { payload: { type: 'object' }, redact: [] },
    // 22 号方案 §9.1：Campaign 事件
    'task.campaign.created': { payload: { type: 'object' }, redact: [] },
    'task.campaign.status.changed': { payload: { type: 'object' }, redact: [] },
    'task.campaign.goal.changed': { payload: { type: 'object' }, redact: [] },
    'task.campaign.task.derived': { payload: { type: 'object' }, redact: [] },
    'task.campaign.reviewed': { payload: { type: 'object' }, redact: [] },
    'task.campaign.escalated': { payload: { type: 'object' }, redact: [] },
  },
  subscribes: {
    'scope.granted': { handler: 'onScopeGranted', mode: 'async', as: 'reactor' },
    'exec.worker.spawned': { handler: 'onWorkerSpawned', mode: 'sync', as: 'reactor' },
    'exec.worker.finished': { handler: 'onWorkerFinished', mode: 'sync', as: 'reactor' },
    // L6（学习专项 §10 变更触发节奏）：卡片撤回 → 生成有预算的重测需求任务（goal=change-retest）。
    // 已暂停任务不自行恢复；重测任务入队（queued 无调度，不自动起 worker）——由人/编排决定何时 task_run_now。
    // 22 号方案 §9.2：同事件兼做 Campaign 侧「引用作废」（被撤回卡片曾进 H3 派生草稿 → checkpoint）。
    'know.release.revoked': { handler: 'onReleaseRevoked', mode: 'async', as: 'reactor' },
    // 产出闭环：漏洞确认后自动入队「提交」任务（同 finding 幂等去重，见 onVulnConfirmed）
    'vuln.signal.confirmed': { handler: 'onVulnConfirmed', mode: 'async', as: 'reactor' },
    // 21 号方案 §3-1：Intent 确定性派生器——新端点入库即推导 H2 假设任务草稿（事件驱动有界推进）
    'endpoint.registered': { handler: 'onEndpointHypothesis', mode: 'async', as: 'reactor' },
    // 21 号方案 §6.2/§6.4-B4：连败回写 strategy 黑名单（oracle rejected → fails+1；verified → 清零）
    'vuln.signal.rejected': { handler: 'onStrategyOutcome', mode: 'async', as: 'reactor' },
    // 21 号方案 §3-1：消费覆盖缺口队列——未爬/无参数格点自动派 crawl/param_enrich 任务草稿（预算闸）
    'ledger.coverage.marked': { handler: 'onCoverageMarked', mode: 'async', as: 'reactor' },
    // 22 号方案 §9.2：Reviewer 验收（强联动）——campaign_id 非空子任务收尾即验收
    'task.finished': { handler: 'onCampaignTaskFinished', mode: 'async', as: 'reactor' },
    // 22 号方案 §7.5：授权漂移 → 专项立即 pause（fail-closed）
    'scope.revoked': { handler: 'onScopeChanged', mode: 'async', as: 'reactor' },
    'scope.rules.changed': { handler: 'onScopeChanged', mode: 'async', as: 'reactor' },
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
  const backendRepoRef = opts.repoRef
  const dataDir = opts.dataDir || DEFAULT_DATA_DIR
  // 23 号方案：供给哨兵（LlmSupplyWatch）——配置/注入式 fetch/进程内缓存/连续失败计数
  const supplyEnv = opts.supplyEnv || parseCampaignSupplyEnv(process.env)
  const supplyFetch = opts.supplyFetch || ((url, init) => fetch(url, init))
  const supplyCache = { at: 0, snapshot: null }
  let supplyProbeFailures = 0

  // scope.yml 自查（与 endpoint 域同口径，模块级 mtime 缓存；Intent 局面编译复用）
  let _scopeCache = null
  function loadScopePrograms() {
    const f = path.join(dataDir, 'scope.yml')
    let mtimeMs = null
    try { mtimeMs = fs.statSync(f).mtimeMs } catch { mtimeMs = null }
    if (_scopeCache && _scopeCache.mtimeMs === mtimeMs) return _scopeCache.programs
    let programs = []
    try { programs = parseScopePrograms(fs.readFileSync(f, 'utf8')) } catch { programs = [] }
    _scopeCache = { mtimeMs, programs }
    return programs
  }
  function parseScopePrograms(text) {
    const programs = []
    let cur = null
    let key = ''
    for (const line of String(text).split('\n')) {
      const t = line.trim()
      if (/^#/.test(t) || !t) continue
      const nameM = t.match(/^-\s+name:\s*["']?([^"']+?)["']?\s*$/)
      if (nameM) { cur = { name: nameM[1].trim(), scope: [], exclude: [] }; programs.push(cur); key = ''; continue }
      if (!cur) continue
      if (/^(scope|exclude):\s*$/.test(t)) { key = t.slice(0, t.length - 1); continue }
      const itemM = t.match(/^-\s*["']?([^"']+?)["']?\s*$/)
      if (itemM && (key === 'scope' || key === 'exclude')) { cur[key].push(itemM[1].trim()); continue }
      if (/^[a-z_]+:/.test(t)) key = ''
    }
    return programs
  }
  function hostInPatterns(host, patterns) {
    const h = String(host || '').trim().toLowerCase()
    for (const p of patterns) {
      const bare = String(p).replace(/^\*\./, '')
      if (!bare) continue
      if (bare === h || h.endsWith('.' + bare)) return true
    }
    return false
  }
  function scopeCheckResult(programId, host) {
    if (!programId) return { ok: true }
    const prog = loadScopePrograms().find((p) => p.name === programId)
    if (!prog) { log(`scope 自查：program ${programId} 未找到，fail-open（scope 域查询上线前过渡）`); return { ok: true } }
    if (hostInPatterns(host, prog.exclude || [])) return { ok: false, code: 'E_INVARIANT', message: `${host} 命中项目 ${programId} 排除清单` }
    if (!hostInPatterns(host, prog.scope || [])) return { ok: false, code: 'E_INVARIANT', message: `${host} 不在项目 ${programId} 授权范围内` }
    return { ok: true }
  }

  function throwErr(code, message, hint, retryable = false) {
    throw Object.assign(new Error(message), { code, hint, retryable })
  }

  // 26 号补丁：dsh-bill 成本归因——records.jsonl 按字节偏移增量解析，
  // 累计 per-session tokens（in+out+cacheWrite；cacheRead 为缓存命中不计实耗）。
  // 游标落盘 data/dsh-bill-sum.json，重启零成本续扫；文件截断/重建自动归零重扫。
  const billSum = (() => {
    const billFile = path.join(dataDir, 'dsh-bill', 'records.jsonl')
    const cursorFile = path.join(dataDir, 'dsh-bill-sum.json')
    const state = { offset: 0, sessions: new Map(), dirty: false }
    try {
      const cur = JSON.parse(fs.readFileSync(cursorFile, 'utf8'))
      state.offset = Number(cur.offset) || 0
      for (const [k, v] of Object.entries(cur.sessions || {})) state.sessions.set(k, Number(v) || 0)
    } catch { /* 首次/损坏按全新 */ }
    let lastSave = 0
    function scan() {
      let st
      try { st = fs.statSync(billFile) } catch { return }
      if (state.offset > st.size) { state.offset = 0; state.sessions.clear() } // 截断/轮换 → 重扫
      if (state.offset === st.size) return
      let buf
      try {
        const fd = fs.openSync(billFile, 'r')
        buf = Buffer.alloc(st.size - state.offset)
        fs.readSync(fd, buf, 0, buf.length, state.offset)
        fs.closeSync(fd)
      } catch { return }
      let consumed = 0
      const text = buf.toString('utf8')
      let idx = 0
      while (true) {
        const nl = text.indexOf('\n', idx)
        if (nl < 0) break // 半行留给下次（写方按行追加）
        const line = text.slice(idx, nl)
        consumed = nl + 1
        idx = nl + 1
        if (!line.trim()) continue
        try {
          const r = JSON.parse(line)
          const sid = r && r.sessionId
          if (sid) {
            const tok = (Number(r.inputTokens) || 0) + (Number(r.outputTokens) || 0) + (Number(r.cacheWriteTokens) || 0)
            state.sessions.set(sid, (state.sessions.get(sid) || 0) + tok)
          }
        } catch { /* 坏行跳过 */ }
      }
      state.offset += consumed
      state.dirty = true
      // 会话 map 防膨胀：超 5000 条只留最大的 3000
      if (state.sessions.size > 5000) {
        const keep = [...state.sessions.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3000)
        state.sessions.clear()
        for (const [k, v] of keep) state.sessions.set(k, v)
      }
      if (state.dirty && Date.now() - lastSave > 5000) {
        lastSave = Date.now()
        state.dirty = false
        try {
          const tmp = `${cursorFile}.tmp-${process.pid}`
          fs.writeFileSync(tmp, JSON.stringify({ offset: state.offset, sessions: Object.fromEntries(state.sessions) }))
          fs.renameSync(tmp, cursorFile)
        } catch { /* 落盘失败下次重扫 */ }
      }
    }
    return {
      // 会话总实耗 tokens；无记录返回 null（调用方保持 spent_tokens 不回填）
      tokensForSession(sessionId) {
        if (!sessionId) return null
        try { scan() } catch { /* best-effort */ }
        const v = state.sessions.get(String(sessionId))
        return Number.isFinite(v) && v > 0 ? v : null
      },
    }
  })()

  // ------------------------------------------------------------------
  // 21 号方案 §3-1/§6：Intent 派生器辅助（H1/H2 生成、H3 局面编译、strategy 键）
  // ------------------------------------------------------------------

  // H3 语义假设局面编译（§3-2 硬约束纯函数校验，违规丢弃）：
  // 必须引用 ≥1 张经验卡、声明 vuln_class、目标 host 一致、无注入特征——LLM 只产假说。
  function compileH3(h3, host) {
    if (!h3 || typeof h3 !== 'object') return { ok: false, violations: ['h3_missing'] }
    const violations = []
    const cardRefs = Array.isArray(h3.card_refs) ? h3.card_refs.filter((c) => String(c || '').trim()) : []
    if (!cardRefs.length) violations.push('h3_no_card_refs')
    if (!String(h3.vuln_class || '').trim()) violations.push('h3_no_vuln_class')
    if (!String(h3.hypothesis || '').trim() || String(h3.hypothesis).length < 20) violations.push('h3_hypothesis_too_short')
    if (h3.host && String(h3.host) !== String(host)) violations.push('h3_host_mismatch')
    if (detectInjectionPatterns(`${h3.hypothesis || ''} ${h3.rationale || ''}`).length) violations.push('h3_injection_pattern')
    return { ok: violations.length === 0, violations }
  }

  // 假设任务 objective 草稿（污点路由注入 + oracle 判定指引——假设永不直接变 finding）
  function hypothesisObjective({ level, vulnClass, host, path: p, param, oracle, rationale, programId, extraLines = [] }) {
    const lines = [
      `[假设 ${level}] ${vulnClass} @ ${host}${p || ''}${param ? `（参数 ${param}）` : ''}`,
      `路由依据：${rationale}`,
      `验证纪律（不可跳过）：`,
      `1. 构造差分对照请求（攻击 vs 对照），响应特征（status/长度/正文特征/simhash/时延）落 results/<run_id>/；`,
      `2. 调 exec_oracle_judge（oracle=${oracle || '按类选择'}）做机器判定——模型无权宣布 verified；`,
      `3. verdict=verified → vuln_oracle_capsule 落 proof capsule → vuln_register_candidate/vuln_confirm 引用 capsule:{id}；rejected/inconclusive → vuln_reject 或补证据重判。`,
      `program=${programId}；禁止越出 scope；证据不足显式 inconclusive 不猜。`,
      ...extraLines,
    ]
    return lines.join('\n')
  }

  // 消费覆盖缺口/端点事件推导一条假设任务草稿（战略去重+黑名单+预算闸在 dispatch 链上）
  async function deriveHypothesis({ programId, host, path: p, endpointRow, repo, cause }) {
    const params = (() => {
      try {
        const raw = endpointRow?.params
        if (!raw || raw === 'null') return []
        const obj = typeof raw === 'string' ? JSON.parse(raw) : raw
        if (Array.isArray(obj)) return obj
        if (obj && typeof obj === 'object') return Object.keys(obj).map((k) => ({ name: k, value: '' }))
        return []
      } catch { return [] }
    })()
    const route = taintRoute({
      path: p || endpointRow?.path || '',
      auth_state: endpointRow?.auth_state || null,
      should_auth: endpointRow?.should_auth || null,
      params,
    })
    const out = []
    for (const h of route.slice(0, 3)) { // 单端点最多派生 3 条（有界推进）
      const key = strategyKey({ host, path: p || endpointRow?.path || '', param: h.param || '', vuln_class: h.vuln_class })
      out.push({
        program_id: programId, kind: 'hypothesis', host, path: p || endpointRow?.path || '',
        vuln_class: h.vuln_class, param: h.param || '', level: h.level,
        rationale: h.rationale, oracle: h.oracle, strategy_key: key,
      })
    }
    return out
  }

  function resolveProgram(args, ctx, repo) {
    if (args.program_id) return String(args.program_id)
    if (ctx && ctx.cwd && repo && typeof repo.programByWorkspacePath === 'function') {
      const id = repo.programByWorkspacePath(ctx.cwd)
      if (id) return String(id)
    }
    return ''
  }

  // ------------------------------------------------------------------
  // 22 号方案：Campaign（专项）辅助——快照解析/授权校验/checkpoint/验收判据
  // ------------------------------------------------------------------

  function parseJsonSafe(s, fallback) { try { const v = JSON.parse(s); return v == null ? fallback : v } catch { return fallback } }
  function parseCampaign(row) {
    if (!row) return null
    return {
      ...row,
      program_ids: Array.isArray(row.program_ids) ? row.program_ids.map(String) : parseJsonSafe(row.program_ids, []).map(String),
      goal_spec: (row.goal_spec && typeof row.goal_spec === 'object') ? row.goal_spec : parseJsonSafe(row.goal_spec, {}),
      policy: (row.policy && typeof row.policy === 'object') ? row.policy : parseJsonSafe(row.policy, {}),
    }
  }
  function beijingNowLabel() { return _beijingIso(Date.now()) }

  // scope 授权快照：优先 scope 域（含 expires_at），不可达回落 scope.yml 自查（fail-closed）
  async function scopeProgramMap() {
    const map = new Map()
    if (queryRef) {
      try {
        const r = await queryRef('scope', 'list', {}, { actor: 'reactor' })
        const programs = (r && r.data && Array.isArray(r.data.programs)) ? r.data.programs : ((r && Array.isArray(r.rows)) ? r.rows : [])
        for (const p of programs) map.set(String(p.name), { expired: !!p.expired })
        if (map.size) return map
      } catch { /* fall through */ }
    }
    for (const p of loadScopePrograms()) map.set(String(p.name), { expired: false })
    return map
  }
  async function checkCampaignPrograms(programIds) {
    const map = await scopeProgramMap()
    const missing = []
    for (const pid of programIds) {
      const hit = map.get(String(pid))
      if (!hit) missing.push({ program_id: String(pid), reason: 'unresolved' })
      else if (hit.expired) missing.push({ program_id: String(pid), reason: 'expired' })
    }
    return missing
  }

  // checkpoint 落账（audit 链）；kind=escalation 时发强提醒事件
  function writeCheckpoint(repo, campaignId, kind, summary, payload) {
    const id = repo.insertCheckpoint({ campaign_id: campaignId, kind, summary, payload })
    const events = []
    if (kind === 'escalation') events.push({ name: 'task.campaign.escalated', payload: { campaign_id: campaignId, kind, summary: String(summary || '').slice(0, 300), payload: payload || null, checkpoint_id: id } })
    return { id, events }
  }

  // ------------------------------------------------------------------
  // 23 号方案 §3.1：LlmSupplyWatch（供给哨兵）——只读 Bellkeeper 观测面，零改造
  // ------------------------------------------------------------------

  function unwrapData(json) {
    if (Array.isArray(json)) return json
    if (json && Array.isArray(json.data)) return json.data
    if (json && json.data && Array.isArray(json.data.data)) return json.data.data
    return []
  }

  // 采集：groups/status（成员权重+可用性）× channels/status（rpd 桶余量）合并为 members 快照。
  // 进程内 60s 缓存防抖动；观测失败累计连续失败计数（INV-C12 两阶段）。
  async function fetchSupplySnapshot({ force = false } = {}) {
    const now = Date.now()
    if (!force && supplyCache.snapshot && now - supplyCache.at < 60000) return supplyCache.snapshot
    const base = supplyEnv.llmBaseUrl || defaultLlmBaseUrl()
    const headers = { Accept: 'application/json' }
    if (supplyEnv.apiKey) headers.Authorization = `Bearer ${supplyEnv.apiKey}`
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), supplyEnv.probeTimeoutMs)
    try {
      const [gr, ch] = await Promise.all([
        supplyFetch(`${base}/api/llm/groups/status`, { headers, signal: ctrl.signal }),
        supplyFetch(`${base}/api/llm/channels/status`, { headers, signal: ctrl.signal }),
      ])
      const gjson = await gr.json()
      const cjson = await ch.json()
      const groups = unwrapData(gjson)
      const channels = unwrapData(cjson)
      const chByName = new Map(channels.map((c) => [String(c.name || ''), c]))
      const group = groups.find((g) => String(g.name || '') === 'pool-secagent')
      let members = []
      if (group && Array.isArray(group.members)) {
        members = group.members.map((m) => {
          const ch = chByName.get(String(m.channel || '')) || {}
          return {
            channel: String(m.channel || ''), model: String(m.model || ''), weight: Number(m.weight) || 0,
            available: m.available !== false, health: (ch.health || m.health || {}),
            daily_used: ch.daily_used, daily_limit: ch.daily_limit,
            available_tokens: ch.available_tokens, max_tokens: ch.max_tokens,
          }
        })
      } else {
        // 组不可见时的降级：仅按 channels/status + 统一额度面成员名（权重未知→按主力处理）
        for (const name of supplyEnv.members) {
          const ch = chByName.get(name)
          if (ch) members.push({ channel: name, model: '', weight: supplyEnv.mainWeight, available: true, health: ch.health || {}, daily_used: ch.daily_used, daily_limit: ch.daily_limit, available_tokens: ch.available_tokens, max_tokens: ch.max_tokens })
        }
      }
      // 统一额度面成员过滤（仅保留配置的渠道；空则不裁）
      if (supplyEnv.members.length) {
        const keep = new Set(supplyEnv.members)
        const filtered = members.filter((m) => keep.has(m.channel))
        if (filtered.length) members = filtered
      }
      supplyProbeFailures = 0
      const snapshot = { members, probe_failed: false, probe_failures: 0, at: now }
      supplyCache.snapshot = snapshot; supplyCache.at = now
      return snapshot
    } catch (e) {
      supplyProbeFailures++
      return { members: [], probe_failed: true, probe_failures: supplyProbeFailures, error: String(e?.message || e), at: now }
    } finally {
      clearTimeout(timer)
    }
  }

  // 供给评估：供给闸总开关 off / 无凭据（无法观测）→ 禁用（等效 factor=1.0，不触网）。
  async function evaluateSupply({ force = false } = {}) {
    if (!supplyEnv.gate) return { enabled: false, supply_factor: 1.0, bounded: false, detail: [{ reason: 'gate_off' }], probe_failed: false, model: null, members: [] }
    if (!supplyEnv.apiKey && !supplyEnv.llmBaseUrl) return { enabled: false, supply_factor: 1.0, bounded: false, detail: [{ reason: 'no_credentials' }], probe_failed: false, model: null, members: [] }
    const snap = await fetchSupplySnapshot({ force })
    const decision = decideThrottle(snap.members, {
      mainWeight: supplyEnv.mainWeight, warnRatio: supplyEnv.warnRatio, slowFactor: supplyEnv.slowFactor,
      probeFailures: snap.probe_failed ? supplyProbeFailures : 0, probeMax: supplyEnv.probeMax,
    })
    const model = selectCampaignModel({
      members: snap.members, strategy: supplyEnv.modelStrategy, mainModel: supplyEnv.modelMain,
      fallbacks: supplyEnv.modelFallbacks, flashliteFirst: supplyEnv.flashliteFirst,
    })
    return {
      enabled: true, supply_factor: decision.supply_factor, bounded: !!decision.bounded,
      detail: decision.detail || [], probe_failed: !!snap.probe_failed, model, members: snap.members,
    }
  }

  // 看板供给徽章（23 号方案 §3.4）：从最近供给 checkpoint 反推三态（正常绿/降速黄/停派红）
  function supplyBadge(repo, campaignId) {
    let rows = []
    try { rows = repo.listCheckpoints(campaignId, 50) } catch { return { state: 'unknown', factor: null } }
    for (const r of rows) {
      if (r.kind === 'llm_restored') return { state: 'normal', factor: 1.0, at: r.created_at, summary: r.summary || '' }
      if (r.kind === 'llm_throttled') {
        const p = parseJsonSafe(r.payload, {})
        const f = Number(p.supply_factor)
        return { state: f === 0 ? 'stop' : 'slow', factor: Number.isFinite(f) ? f : null, at: r.created_at, summary: r.summary || '', detail: p.detail || [], model_hint: p.model_hint || null }
      }
      if (r.kind === 'llm_probe_failed') return { state: 'probe_failed', factor: 1.0, at: r.created_at, summary: r.summary || '' }
    }
    return { state: 'unknown', factor: null }
  }

  // 最近一次供给状态（从 checkpoint 反推；null=无历史）。state ∈ up|throttled|probe_failed。
  function lastSupplyState(repo, campaignId) {
    let rows = []
    try { rows = repo.listCheckpoints(campaignId, 50) } catch { rows = [] }
    for (const r of rows) {
      if (r.kind === 'llm_restored') return { state: 'up', factor: 1 }
      if (r.kind === 'llm_throttled') { const p = parseJsonSafe(r.payload, {}); return { state: 'throttled', factor: Number(p.supply_factor) } }
      if (r.kind === 'llm_probe_failed') return { state: 'probe_failed', factor: null }
    }
    return null
  }

  // 供给变化留痕（幂等防抖：同状态不重复发；factor=0 首次发 task.campaign.escalated）
  function recordSupplyTransition(repo, c, supply) {
    const events = []
    if (!supply.enabled) return events
    const prev = lastSupplyState(repo, c.id)
    if (supply.probe_failed && supply.supply_factor === 1.0) {
      if (prev?.state !== 'probe_failed' || !hasRecentCheckpoint(repo, c.id, 'llm_probe_failed', 5 * 60000)) {
        const cp = writeCheckpoint(repo, c.id, 'llm_probe_failed', `供给观测失败（连续 ${supplyProbeFailures} 次），fail-open 但有界降速（derive_cap≤2）；连续 ${supplyEnv.probeMax} 次转停派`, { probe_failures: supplyProbeFailures })
        events.push(...cp.events)
      }
      return events
    }
    if (supply.supply_factor < 1) {
      if (prev?.state === 'throttled' && prev.factor === supply.supply_factor && hasRecentCheckpoint(repo, c.id, 'llm_throttled', 5 * 60000)) return events
      const cp = writeCheckpoint(repo, c.id, 'llm_throttled', supply.supply_factor === 0
        ? 'LLM 供给停派（成员全部熔断/额度耗尽）：L2→L1，在跑子任务不动'
        : `LLM 供给降速（factor=${supply.supply_factor}）：derive_cap 折算`, { supply_factor: supply.supply_factor, detail: supply.detail, model_hint: supply.model || null })
      events.push(...cp.events)
      if (supply.supply_factor === 0) {
        if (!prev || prev.factor !== 0) events.push({ name: 'task.campaign.escalated', payload: { campaign_id: c.id, kind: 'llm_throttled', summary: 'LLM 池额度熔断中，专项停派；Bellkeeper 探针恢复后自动回弹', payload: { supply_factor: 0, checkpoint_id: cp.id } } })
        if (Number(c.autonomy) >= 2) {
          repo.updateCampaign(c.id, { autonomy: 1 })
          const ac = writeCheckpoint(repo, c.id, 'autonomy_change', 'LLM 供给归零，L2 自动降级为 L1（恢复后不自动升回，需人工 review_pass）', { supply_factor: 0 })
          events.push(...ac.events)
        }
      }
      return events
    }
    // 恢复正常：从降速或观测异常均可回弹（修复「观测异常恢复后徽章卡死」）
    if (prev && prev.state !== 'up') {
      const cp = writeCheckpoint(repo, c.id, 'llm_restored', 'LLM 供给恢复（factor=1.0）', { supply_factor: 1 })
      events.push(...cp.events)
    }
    return events
  }

  // Reviewer 验收信号采集（22 号方案 §7.6：确定性优先）——机器 oracle 判定 / capsule 证据 /
  // finding 复核（vuln 域只读）三源。全部来自 task.result / run.note / vuln_get，不猜。
  async function gatherReviewSignals(task, run) {
    const sig = { verified: false, rejected: false, capsuleRef: null, findingRef: null }
    // 只扫「实际产出」（result/run note），不扫 objective 模板文本——模板含示例 verdict 字样会误判
    const text = `${task.result || ''} ${(run && run.note) || ''}`
    const cap = text.match(/capsule:([A-Za-z0-9_-]+)/i)
    if (cap) sig.capsuleRef = cap[1]
    const fid = text.match(/finding\s*#?\s*(\d+)/i)
    if (fid) sig.findingRef = Number(fid[1])
    if (/verdict\s*[:=]\s*(verified|confirmed|accepted)/i.test(text)) sig.verified = true
    if (/verdict\s*[:=]\s*(rejected|false_positive)/i.test(text)) sig.rejected = true
    // vuln 域复核：finding 引用 → 是否挂 proof capsule / 已判假阳（vuln_get actor 含 reactor）
    if (sig.findingRef && queryRef) {
      try {
        const g = await queryRef('vuln', 'get', { id: sig.findingRef }, { actor: 'reactor' })
        const f = (g && g.ok && g.data) ? g.data : null
        if (f) {
          const ev = String(f.evidence || '')
          const m = ev.match(/capsule:([A-Za-z0-9_-]+)/i)
          if (m) { sig.verified = true; if (!sig.capsuleRef) sig.capsuleRef = m[1] }
          if (f.status === 'false_positive' || f.status === 'ignored') sig.rejected = true
        }
      } catch { /* vuln 域不可达：退化为文本信号（不阻断验收） */ }
    }
    return sig
  }

  // Reviewer 验收判据（确定性优先，按 campaign_role 分派；证据铁律）：
  //  accept 条件 = 机器 oracle verified / capsule 证据 / finding 已 confirmed；覆盖驱动角色（crawl/param）
  //  成功即格点推进；三源皆无的 hypothesis 判 rework（方向对执行差），失败判 rejected（连败回写）。
  function isCoverageRole(task, role) {
    if (role !== 'derived') return false
    const obj = String(task.objective || '')
    // 25/26 号补丁：[资产缺口]（asset_enum 根域枚举）/ [存量复核]（review_finding 分诊）同为覆盖驱动角色——成功即格点推进
    return /\[覆盖缺口\]/.test(obj) || /\[资产缺口\]/.test(obj) || /\[存量复核\]/.test(obj) || /arjun|katana|gau|waybackurls/.test(obj)
  }
  // 基础设施失败（宿主重启/超时回收/调度异常/worker 未起）——不是打法失败，不计连败、不判 rejected
  function isInfraFailure(task, run) {
    if (!run || !run.run_id) return true
    const note = `${(run && run.note) || ''} ${task.result || ''}`
    return /宿主重启|超时回收|调度执行异常|调度取任务失败|spawn_worker|worker 超时|worker 并发|E_EXEC|E_BUS|crash|infra_error/i.test(note)
  }
  function campaignVerdict(task, run, sig = {}) {
    const role = String(task.campaign_role || 'derived')
    const ok = !!(run && run.ok)
    if (task.status === 'done' && ok) {
      if (role === 'submit' || role === 'learn' || role === 'retest') return 'accepted'
      if (sig.rejected) return 'rejected'
      if (sig.verified || sig.capsuleRef) return 'accepted'
      if (isCoverageRole(task, role)) return 'accepted' // crawl/param 成功 = 覆盖格点推进
      return 'rework'                                   // 无 verdict 亦无覆盖推进
    }
    if (task.status === 'done' && !run) return 'escalated'
    if (task.status === 'failed') {
      // infra 失败（宿主重启/回收/调度异常）→ escalated：不进 strategy 连败，也不触发 fail-rate 降级
      if (isInfraFailure(task, run)) return 'escalated'
      return role === 'verify' ? 'rework' : 'rejected'
    }
    return 'escalated'
  }
  const EVIDENCE_PREFIX_RE = /^(run|task|capsule|ledger|finding|oracle):/

  // 验收证据：capsule 优先（证据铁律最强），其次 oracle 判定，再次 run/task 引用
  function reviewEvidence(task, run, sig, verdict) {
    if (verdict === 'accepted' && sig.capsuleRef) return `capsule:${sig.capsuleRef}`
    if (verdict === 'accepted' && sig.verified) return 'oracle:judge'
    if (run && run.run_id) return `run:${run.run_id}`
    return `task:${task.id}`
  }

  function makeGoalDelta(task, verdict, run, sig = {}) {
    const delta = { accepted: verdict === 'accepted' ? 1 : 0, rejected: verdict === 'rejected' ? 1 : 0, rework: verdict === 'rework' ? 1 : 0, role: task.campaign_role || 'derived' }
    if (verdict === 'accepted' && (sig.capsuleRef || sig.verified)) delta.confirmed = 1
    // 26 号补丁：run 行无 spent_tokens 列时回退任务行（task_finish 已按 dsh-bill 归因回填）
    const runSpent = run && Number.isFinite(Number(run.spent_tokens)) ? Number(run.spent_tokens) : null
    const taskSpent = task && Number.isFinite(Number(task.spent_tokens)) ? Number(task.spent_tokens) : null
    if (runSpent !== null || taskSpent !== null) delta.spent_tokens = runSpent !== null ? runSpent : taskSpent
    return delta
  }

  // 验收后的策略侧效应：rework → 冷却后重开（Planner 可重试）；rejected → 连败 +1（≥3 黑名单）。
  // 仅在任务携带 strategy_key（campaign 派生）时生效；manual 验收无 key 跳过。
  function applyReviewOutcome(repo, task, verdict) {
    const bare = task && task.strategy_key ? String(task.strategy_key) : ''
    if (!bare) return
    // 去重表键带 campaign 维度前缀（derive_intent 以 c{id}|{bare} 落键）；任务上存的是裸键
    const key = task.campaign_id != null ? `c${task.campaign_id}|${bare}` : bare
    try {
      if (verdict === 'rework' && repo.reopenStrategy) repo.reopenStrategy(key, Date.now() + CAMPAIGN_REWORK_REOPEN_MS)
      else if (verdict === 'rejected' && repo.markStrategyOutcome) repo.markStrategyOutcome(key, false, task.id)
    } catch (e) { log(`验收策略回写失败 ${key}: ${e?.message}`) }
  }

  // L1/L2 规划输入采集（缺口/连败/经验卡命中/活跃与预算）——跨域只读，不可达即降级空快照
  async function gatherPlanInputs(campaign, repo) {
    const gaps = []
    if (queryRef) {
      const seenGap = new Set()
      for (const program of campaign.program_ids) {
        // 分维度拉取：ledger_coverage_gaps 按优先级截断，crawl（低优先级）会被 vulnclass 挤出 limit，
        // 导致 Planner 永远拿不到覆盖类缺口（覆盖率不动）。逐维查询 + 去重合并。
        // 25 号补丁：asset 维（根域枚举超窗）并入专项缺口消费
        for (const dim of ['crawl', 'param', 'vulnclass', 'asset', 'review']) {
          try {
            const r = await queryRef('ledger', 'coverage_gaps', { program, dim, limit: 200 }, { actor: 'reactor' })
            const rows = (r && r.data && Array.isArray(r.data.gaps)) ? r.data.gaps
              : ((r && r.data && Array.isArray(r.data.rows)) ? r.data.rows : ((r && Array.isArray(r.rows)) ? r.rows : []))
            for (const row of rows) {
              const pid = row.program || row.program_id || program
              const k = `${pid}|${row.dim}|${row.key}`
              if (seenGap.has(k)) continue
              seenGap.add(k)
              gaps.push({ ...row, program: pid })
            }
          } catch { /* 降级：该 program/dim 无缺口 */ }
        }
      }
    }
    const strategies = {}
    try {
      const rows = repo.listStrategies ? repo.listStrategies(campaign.program_ids) : []
      for (const s of rows) {
        // 去 campaign 维度前缀（derive_intent 以 c{id}|{bare} 落键），归一为裸键供 Planner 判定
        const bare = String(s.strategy_key || '').replace(/^c\d+\|/, '')
        if (!bare) continue
        const cur = strategies[bare] || { fails: 0, blacklisted: false, attempted: true, reopen_after: null }
        cur.fails = Math.max(cur.fails, Number(s.fails) || 0)
        cur.blacklisted = cur.blacklisted || !!s.blacklisted
        cur.attempted = true
        const ra = s.reopen_after == null ? null : Number(s.reopen_after)
        if (ra != null) cur.reopen_after = cur.reopen_after == null ? ra : Math.min(cur.reopen_after, ra)
        strategies[bare] = cur
      }
    } catch { /* ignore */ }
    const scores = {}
    const activeTaskCount = repo.activeCampaignTaskCount(campaign.id)
    let budgetRemainingRatio = 1
    if (campaign.budget_tokens != null && Number(campaign.budget_tokens) > 0) {
      const windowMs = (Number(campaign.budget_window_days) || 7) * 86400000
      const usage = repo.campaignUsage(campaign.id, Date.now() - windowMs)
      budgetRemainingRatio = Math.max(0, 1 - (usage.spent_tokens / Number(campaign.budget_tokens)))
    }
    return { gaps, strategies, scores, activeTaskCount, budgetRemainingRatio }
  }

  // 局面编译（program/host 授权复查），供 Dispatcher 下发前 fail-closed
  async function campaignSituationOk(programId, host, { skipHostScope = false } = {}) {
    const map = await scopeProgramMap()
    const hit = map.get(String(programId))
    if (!hit) return { ok: false, code: 'E_CAMPAIGN_PROGRAM_UNRESOLVED', message: `program ${programId} 未授权`, hint: '绑定 program 必须存在于 scope 镜像且未过期（INV-C1）' }
    if (hit.expired) return { ok: false, code: 'E_CAMPAIGN_PROGRAM_UNRESOLVED', message: `program ${programId} 授权已过期`, hint: '续期授权后重试（fail-closed）' }
    // 26 号补丁：review_finding 的 host 槽载 finding id 而非主机名，跳过主机归属校验——
    // finding 已登记在 program 内即授权证据；program 级授权/过期校验（上方）不豁免。
    if (skipHostScope) return { ok: true }
    const sc = scopeCheckResult(programId, host)
    if (!sc.ok) return { ok: false, code: sc.code, message: `派生越界：${sc.message}`, hint: '派生绝不越出 scope' }
    return { ok: true }
  }

  // campaign 窗口预算闸（显式路径）：不变量阶段执行——写入在事务外提交，命令被拒也保留审计。
  // tick 路径由 dispatchDrafts 内部处理（不抛错，写入随 tick 事务提交）。
  function campaignBudgetGate(repo, c, draftCount) {
    if (c.budget_tokens == null || !(Number(c.budget_tokens) > 0)) return { blocked: false }
    const windowMs = (Number(c.budget_window_days) || 7) * 86400000
    const usage = repo.campaignUsage(c.id, Date.now() - windowMs)
    const estimate = Number(draftCount || 0) * CAMPAIGN_ESTIMATE_TOKENS_PER_DRAFT
    if (Number(usage.spent_tokens) + estimate <= Number(c.budget_tokens)) return { blocked: false, usage }
    repo.insertCheckpoint({ campaign_id: c.id, kind: 'budget_low', summary: `专项预算触顶：窗口已用 ${usage.spent_tokens}/${c.budget_tokens} tokens（本单预估 ${estimate}），停派`, payload: usage })
    if (Number(c.autonomy) >= 2) repo.updateCampaign(c.id, { autonomy: 1 })
    return { blocked: true, code: 'E_CAMPAIGN_BUDGET_LOW', message: `专项 #${c.id} 窗口预算不足（已用 ${usage.spent_tokens}/${c.budget_tokens}）` }
  }

  function hasRecentCheckpoint(repo, campaignId, kind, withinMs) {
    const rows = repo.listCheckpoints(campaignId, 50)
    const cutoff = Date.now() - withinMs
    return rows.some((r) => r.kind === kind && Number(r.created_at || 0) >= cutoff)
  }

  // 验收落账（证据铁律 + spent_tokens 汇聚 + heartbeat 推进）；一任务一验收由 UNIQUE 兜底。
  // 纯 DB 落账——事件发布由 campaign_record_decision 命令（订阅路径）或 tick 汇总负责。
  function recordDecision(repo, { campaign_id, task_id, verdict, evidence, goal_delta, decided_by }) {
    const c = repo.getCampaign(campaign_id)
    const id = repo.insertCampaignDecision({ campaign_id, task_id, verdict, evidence, goal_delta, decided_by: decided_by || 'reviewer' })
    if (id == null) return { duplicate: true }
    const delta = (goal_delta && typeof goal_delta === 'object') ? goal_delta : parseJsonSafe(goal_delta, {})
    const patch = { heartbeat_at: Date.now() }
    if (Number(delta.spent_tokens) > 0) patch.spent_tokens = Number(c?.spent_tokens || 0) + Number(delta.spent_tokens)
    repo.updateCampaign(campaign_id, patch)
    return { id, delta, verdict, task_id: Number(task_id), campaign_id: Number(campaign_id), evidence, decided_by: decided_by || 'reviewer' }
  }
  function decisionEvents(rd) {
    const events = [{ name: 'task.campaign.reviewed', payload: { campaign_id: rd.campaign_id, task_id: rd.task_id, verdict: rd.verdict, evidence: rd.evidence, goal_delta: rd.delta, decided_by: rd.decided_by } }]
    if (rd.verdict === 'escalated') {
      const cid = rd.campaign_id
      events.push({ name: 'task.campaign.escalated', payload: { campaign_id: cid, kind: 'escalation', summary: `子任务 #${rd.task_id} 无法判定，升级人工`, payload: { task_id: rd.task_id, evidence: rd.evidence } } })
    }
    return events
  }

  // Supervisor 巡检（纯规则）：空转 / 业务卡死 / 连败速率 → 处置动作列表
  function superviseCampaign(c, repo) {
    const actions = []
    const now = Date.now()
    if (c.status === 'active' && c.heartbeat_at && now - Number(c.heartbeat_at) > CAMPAIGN_MILESTONE_IDLE_MS) {
      if (!hasRecentCheckpoint(repo, c.id, 'escalation', CAMPAIGN_MILESTONE_IDLE_MS)) actions.push({ kind: 'idle' })
    }
    const active = repo.listTasksWhere({ campaign_id: c.id, bucket: 'active' }, 100, 0, 'priority')
    for (const t of active) {
      const runs = repo.listTaskRunsWhere({ task_id: t.id }, 3, 0)
      if (runs.length >= 3 && runs.every((r) => !r.ok)) {
        const notes = new Set(runs.map((r) => String(r.note || '').slice(0, 40)))
        if (notes.size === 1) actions.push({ kind: 'stuck', task_id: t.id, note: runs[0].note })
      }
    }
    // 连败速率：近 1h rejected 验收 ≥2 → 降级 L2→L1
    const hourAgo = now - 3600000
    const decisions = repo.listCampaignDecisions(c.id, 'rejected', 50, 0)
    if (decisions.filter((d) => Number(d.created_at || 0) >= hourAgo).length >= 2 && Number(c.autonomy) >= 2) {
      actions.push({ kind: 'derive_fail_rate' })
    }
    // 停止条件（INV-C9）：预算耗尽 ⇒ 转 reviewing 待人审（不自动 archive）
    if (c.status === 'active' && c.budget_tokens != null && Number(c.budget_tokens) > 0) {
      const windowMs = (Number(c.budget_window_days) || 7) * 86400000
      const usage = repo.campaignUsage(c.id, Date.now() - windowMs)
      if (Number(usage.spent_tokens) >= Number(c.budget_tokens)) actions.push({ kind: 'stop_condition', reason: 'budget_exhausted' })
      // 23 号方案 §3.6 步骤 1.5：达 80% 水位自动提请 campaign-budget-extend（平滑爬坡，零人工介入；
      // 提请幂等由 12h checkpoint 防抖 + approval 同 (kind,subject) pending 去重双保险）
      else if (Number(usage.spent_tokens) >= Number(c.budget_tokens) * 0.8
        && !hasRecentCheckpoint(repo, c.id, 'budget_extend_request', 12 * 3600000)) {
        actions.push({ kind: 'budget_extend', add: Number(c.budget_tokens), spent: Number(usage.spent_tokens) })
      }
    }
    return actions
  }

  // 草稿字段白名单收敛（S2）：kind/level/role 限枚举、phase 限 allowed_phases、rationale 必填化。
  // 优先级不由调用方决定——derive_intent 按 level 固定（H1=4 其余 3），模型无法绕过 Planner 排序。
  function sanitizeDraft(d, c) {
    const policy = c.policy || {}
    const kind = CAMPAIGN_KINDS.includes(String(d.kind)) ? String(d.kind) : 'hypothesis'
    const level = CAMPAIGN_LEVELS.includes(String(d.level)) ? String(d.level) : 'H2'
    const role = CAMPAIGN_ROLES.includes(String(d.campaign_role)) ? String(d.campaign_role) : 'derived'
    const phases = Array.isArray(policy.allowed_phases) && policy.allowed_phases.length ? policy.allowed_phases.map(String) : ['vuln']
    const phase = phases.includes(String(d.phase)) ? String(d.phase) : phases[0]
    const taskClass = ['lite', 'std', 'heavy'].includes(String(d.task_class))
      ? String(d.task_class) : classifyTaskClass({ kind, vuln_class: d.vuln_class || '' })
    return {
      program_id: d.program_id, kind, host: d.host, path: d.path || '', param: d.param || '',
      vuln_class: d.vuln_class || '', level, rationale: String(d.rationale || '合规派生（Dispatcher 收敛）').slice(0, 400),
      oracle: d.oracle || '', strategy_key: d.strategy_key || '', campaign_role: role, phase, goal: 'research',
      task_class: taskClass,
    }
  }

  // Dispatcher 下发（唯一动作=翻译为 derive_intent/task_create；闸顺序：供给→有界→预算→委托链）
  // 供给闸（23 号方案 §3.1/INV-C11）：有效上限 = ceil(derive_cap × supply_factor) 取严；
  // factor=0 tick 路径静默跳过、显式路径报 E_CAMPAIGN_LLM_EXHAUSTED（人工 dashboard 放行见 invariant）。
  async function dispatchDrafts(c, drafts, repo, { explicit = false, supplyFactor = 1, supplyBounded = false, supplyMembers = [] } = {}) {
    const result = { derived: 0, deduped: 0, dropped: [], events: [] }
    if (!drafts.length) return result
    const policy = c.policy || {}
    let cap = Number(policy.derive_cap_per_tick) > 0 ? Math.floor(Number(policy.derive_cap_per_tick)) : CAMPAIGN_DERIVE_CAP_PER_TICK
    if (supplyFactor <= 0) {
      if (explicit) throwErr('E_CAMPAIGN_LLM_EXHAUSTED', `专项 #${c.id} 派生被供给闸拦截：LLM 池额度熔断中`, 'LLM 池额度熔断中，Bellkeeper 探针恢复后自动回弹；人工紧急派生可经 dashboard 放行', true)
      result.dropped.push({ reason: 'llm_exhausted' })
      return result
    }
    if (supplyBounded) cap = Math.min(cap, 2)
    if (supplyFactor < 1) {
      const scaled = Math.max(1, Math.ceil(cap * supplyFactor))
      if (scaled < cap) result.dropped.push({ reason: 'supply_factor', from: cap, to: scaled, supply_factor: supplyFactor })
      cap = scaled
    }
    const maxActive = Number(policy.max_active_tasks) > 0 ? Math.floor(Number(policy.max_active_tasks)) : 20
    const activeCount = repo.activeCampaignTaskCount(c.id)
    if (activeCount >= maxActive) {
      if (explicit) throwErr('E_CAMPAIGN_DERIVE_CAP', `专项 #${c.id} 活跃子任务已满（${activeCount}/${maxActive}）`, '等待在跑子任务完结后重试（INV-C6）', true)
      result.dropped.push({ reason: 'max_active_tasks', active: activeCount })
      return result
    }
    let allowed = drafts
    if (allowed.length > cap) {
      if (explicit) throwErr('E_CAMPAIGN_DERIVE_CAP', `单次派生超上限（${allowed.length}/${cap}）`, '拆分多次派发（INV-C6）', true)
      result.dropped.push({ reason: 'derive_cap', dropped: allowed.length - cap })
      allowed = allowed.slice(0, cap)
    }
    // campaign 窗口预算闸（per-program 闸在 task_create 链内叠加，双闸取严）
    if (c.budget_tokens != null && Number(c.budget_tokens) > 0) {
      const windowMs = (Number(c.budget_window_days) || 7) * 86400000
      const usage = repo.campaignUsage(c.id, Date.now() - windowMs)
      const estimate = allowed.length * CAMPAIGN_ESTIMATE_TOKENS_PER_DRAFT
      if (Number(usage.spent_tokens) + estimate > Number(c.budget_tokens)) {
        writeCheckpoint(repo, c.id, 'budget_low', `专项预算将触顶：窗口已用 ${usage.spent_tokens}/${c.budget_tokens} tokens，本 tick 停派`, { usage })
        if (Number(c.autonomy) >= 2) repo.updateCampaign(c.id, { autonomy: 1 })
        if (explicit) throwErr('E_CAMPAIGN_BUDGET_LOW', `专项 #${c.id} 窗口预算不足（已用 ${usage.spent_tokens}/${c.budget_tokens}）`, '等待窗口滚动或 campaign-budget-extend 审批后重试', false)
        result.dropped.push({ reason: 'budget_low' })
        return result
      }
    }
    if (!dispatchRef) throwErr('E_BACKEND_UNAVAILABLE', '总线 dispatch 不可达', '确认总线已挂载', true)
    for (const rawDraft of allowed) {
      const d = sanitizeDraft(rawDraft, c)
      const programId = String(d.program_id || c.program_ids[0] || '')
      const sit = await campaignSituationOk(programId, d.host, { skipHostScope: d.kind === 'review_finding' })
      if (!sit.ok) { result.dropped.push({ strategy_key: d.strategy_key || null, code: sit.code, message: sit.message }); continue }
      // 23 号方案 §3.7：任务分档标注（Path B 纯元数据）；selector=dsh 时附 model_hint（Path A）
      let hint = null
      if (supplyEnv.modelSelector === 'dsh' && Array.isArray(supplyMembers) && supplyMembers.length) {
        hint = selectCampaignModel({
          task_class: d.task_class, members: supplyMembers, strategy: supplyEnv.modelStrategy,
          mainModel: supplyEnv.modelMain, fallbacks: supplyEnv.modelFallbacks, flashliteFirst: supplyEnv.flashliteFirst,
        })
      }
      // Path A/B 落地：优先按 task_class 映射到 Bellkeeper 模型组（组内熔断顺延），否则用 member 级具体模型
      const pathModel = supplyEnv.classGroups[d.task_class] || (hint && hint.model) || ''
      const args = {
        program_id: programId, kind: d.kind, host: d.host, path: d.path, param: d.param,
        vuln_class: d.vuln_class, level: d.level, rationale: d.rationale,
        oracle: d.oracle, strategy_key: d.strategy_key,
        campaign_id: c.id, campaign_role: d.campaign_role, task_class: d.task_class,
        // worker 侧经 exec.spawn_worker 的 model-patch 指定模型（provider+model 成对）
        ...(pathModel ? { model_hint: pathModel, model_channel: hint ? hint.channel : '', model_reason: hint ? hint.reason : 'class_group', provider: CAMPAIGN_MODEL_PROVIDER, model: pathModel } : {}),
      }
      try {
        const r = await dispatchRef('task', 'derive_intent', args, { actor: 'reactor' })
        if (r && r.ok) {
          if (r.data?.deduped) result.deduped++
          else {
            result.derived++
            result.events.push({ name: 'task.campaign.task.derived', payload: { campaign_id: c.id, task_id: r.data.task_id, strategy_key: d.strategy_key || null, role: d.campaign_role || 'derived' } })
          }
        } else {
          result.dropped.push({ strategy_key: d.strategy_key || null, code: r?.error?.code || 'E_INTERNAL', message: String(r?.error?.message || '').slice(0, 160) })
        }
      } catch (e) {
        if (e && e.code === 'E_CAMPAIGN_DERIVE_CAP') throw e
        result.dropped.push({ strategy_key: d.strategy_key || null, code: e?.code || 'E_INTERNAL', message: String(e?.message || e).slice(0, 160) })
      }
    }
    return result
  }

  // 单专项 tick：巡检 → 验收 → 规划 → 下发（每步有界；异常隔离到本 campaign）
  async function runCampaignTick(campaignRaw, repo, { emit = true } = {}) {
    const c = parseCampaign(campaignRaw)
    const summary = { campaign_id: c.id, reviewed: 0, derived: 0, deduped: 0, dropped: 0, escalated: 0, paused: false, autonomous: false, skipped: [] }
    const events = []
    // 1) Supervisor
    try {
      const actions = superviseCampaign(c, repo)
      for (const a of actions) {
        if (a.kind === 'idle') {
          const cp = writeCheckpoint(repo, c.id, 'escalation', '专项空转：目标不可达或能量耗尽（>48h 无 accepted 验收且无新派生）', {})
          events.push(...cp.events); summary.escalated++
        } else if (a.kind === 'stuck') {
          try { await dispatchRef('task', 'block', { task_id: a.task_id, blocked_reason: `Supervisor：业务卡死（连续 3 轮 ok=0 同类：${String(a.note || '').slice(0, 80)}）` }, { actor: 'reactor' }) } catch (e) { log(`campaign#${c.id} 卡死处置失败: ${e?.message}`) }
          const cp = writeCheckpoint(repo, c.id, 'escalation', `子任务 #${a.task_id} 业务卡死，已 block 升级人工`, { task_id: a.task_id })
          events.push(...cp.events); summary.escalated++
        } else if (a.kind === 'derive_fail_rate') {
          repo.updateCampaign(c.id, { autonomy: 1 })
          const cp = writeCheckpoint(repo, c.id, 'autonomy_change', '连败速率超阈值，L2 自动降级为 L1', {})
          events.push(...cp.events)
        } else if (a.kind === 'stop_condition') {
          repo.updateCampaign(c.id, { status: 'reviewing' }, 'active')
          const cp = writeCheckpoint(repo, c.id, 'stop_condition', `停止条件命中（${a.reason}），转 reviewing 待人审（不自动 archive）`, { reason: a.reason })
          events.push(...cp.events); summary.escalated++
        } else if (a.kind === 'budget_extend') {
          // 23 号方案 §3.6：Supervisor 自动提请预算延长（request_actors 含 scheduler，tick 路径合规）
          try {
            if (!dispatchRef) throw new Error('总线 dispatch 不可达')
            const r = await dispatchRef('approval', 'request', {
              kind: 'campaign-budget-extend', subject: c.name,
              payload: { campaign_id: c.id, add_tokens: a.add },
              evidence: `专项 #${c.id}「${c.name}」窗口预算已用 ${a.spent}/${c.budget_tokens}（≥80%），自动提请延长 +${a.add} tokens（≤原预算×2），批准后平滑爬坡至下一档。`,
            }, { actor: 'scheduler' })
            if (r && r.ok) {
              const cp = writeCheckpoint(repo, c.id, 'budget_extend_request', `预算达 80% 水位，已自动提请 campaign-budget-extend（+${a.add} tokens）`, { add_tokens: a.add, spent: a.spent, request_id: r.data?.request_id ?? null })
              events.push(...cp.events)
            } else log(`专项 #${c.id} 预算延长提请未成功: ${r?.error?.code} ${r?.error?.message}`)
          } catch (e) { log(`专项 #${c.id} 预算延长提请失败: ${e?.message}`) }
        }
      }
    } catch (e) { summary.skipped.push({ step: 'supervisor', error: String(e?.message || e) }) }
    // 2) Reviewer（补验事件重放/重启遗漏）
    try {
      const pending = repo.unreviewedCampaignTasks(c.id, 20)
      for (const t of pending) {
        const runs = repo.listTaskRunsWhere({ task_id: t.id }, 1, 0)
        const run = runs[0] || null
        const sig = await gatherReviewSignals(t, run)
        const verdict = campaignVerdict(t, run, sig)
        const evidence = reviewEvidence(t, run, sig, verdict)
        const delta = makeGoalDelta(t, verdict, run, sig)
        const rd = recordDecision(repo, { campaign_id: c.id, task_id: t.id, verdict, evidence, goal_delta: delta, decided_by: 'reviewer' })
        if (!rd.duplicate) { summary.reviewed++; events.push(...decisionEvents(rd)); applyReviewOutcome(repo, t, verdict) }
      }
    } catch (e) { summary.skipped.push({ step: 'reviewer', error: String(e?.message || e) }) }
    // 2.5) LearnLink（§11.2-L4）：反复 rework ⇒ 经既有 know_gap_record 登记检索缺口（有界，7d 去重）
    try {
      const reworks = repo.listCampaignDecisions(c.id, 'rework', 50, 0).filter((d) => Date.now() - Number(d.created_at || 0) < 7 * 86400000)
      if (reworks.length >= 3 && !hasRecentCheckpoint(repo, c.id, 'learn_gap', 7 * 86400000) && dispatchRef) {
        // vuln_class 维度：从 rework 子任务 objective（[假设 Hn] <class> ...）取众数
        const clsCount = {}
        for (const d of reworks) {
          const m = String(d.objective || '').match(/\[假设\s*H\d\]\s*([a-z_]+)/i)
          if (m) clsCount[m[1].toLowerCase()] = (clsCount[m[1].toLowerCase()] || 0) + 1
        }
        const vulnClass = Object.keys(clsCount).sort((a, b) => clsCount[b] - clsCount[a] || a.localeCompare(b))[0] || 'rework'
        const surface = `campaign:${c.id}:${vulnClass}`
        await dispatchRef('know', 'gap_record', {
          q: `专项 #${c.id} ${String(c.goal_spec.objective || '').slice(0, 200)} 反复 rework（类 ${vulnClass}）`, program_id: c.program_ids[0] || '', surface, hits: reworks.length,
        }, { actor: 'reactor' })
        writeCheckpoint(repo, c.id, 'learn_gap', `反复 rework ${reworks.length} 次（类 ${vulnClass}），已登记 know 检索缺口（surface=${surface}）`, { reworks: reworks.length, vuln_class: vulnClass })
      }
    } catch (e) { summary.skipped.push({ step: 'learnlink', error: String(e?.message || e) }) }
    // 2.7) 供给哨兵（23 号方案 §3.1）：tick 顺带拉取 pool-secagent 供给，算 supply_factor
    let supply = { enabled: false, supply_factor: 1.0, bounded: false, detail: [], members: [] }
    try {
      supply = await evaluateSupply()
      summary.supply_factor = supply.supply_factor
      events.push(...recordSupplyTransition(repo, c, supply))
    } catch (e) { summary.skipped.push({ step: 'supply', error: String(e?.message || e) }) }
    // 3) Planner + Dispatcher（autonomy≥1 且 active）
    if (c.status === 'active' && Number(c.autonomy) >= 1) {
      try {
        if (supply.supply_factor <= 0) {
          // INV-C11：供给归零 ⇒ tick 路径静默跳过派生（checkpoint 已留痕），验收不烧额度照常
          summary.skipped.push({ step: 'planner', reason: 'llm_exhausted' })
        } else {
          const inputs = await gatherPlanInputs(c, repo)
          const plan = compileCampaignPlan({ campaign: c, ...inputs })
          summary.skipped.push(...plan.skipped.map((s) => ({ step: 'planner', ...s })))
          if (Number(c.autonomy) >= 2 && plan.drafts.length) {
            const res = await dispatchDrafts(c, plan.drafts, repo, {
              explicit: false, supplyFactor: supply.supply_factor, supplyBounded: supply.bounded, supplyMembers: supply.members,
            })
            summary.derived += res.derived; summary.deduped += res.deduped; summary.dropped += res.dropped.length
            summary.autonomous = true
            events.push(...res.events)
          }
        }
      } catch (e) { summary.skipped.push({ step: 'planner', error: String(e?.message || e) }) }
    }
    repo.updateCampaign(c.id, { last_tick_at: Date.now() })
    return { summary, events }
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
    // 21 号方案 §3-2：Intent 局面硬约束编译（scope/连败黑名单/H3 违规丢弃落审计）
    intentSituation: async (args, repo) => {
      // 26 号补丁：review_finding 的 host 槽载 finding id，不做主机归属校验——
      // finding 已登记在 program 内即授权证据（program 级授权由 campaignSituationOk 前置把关）。
      if (args.kind !== 'review_finding') {
        // scope fail-closed：host 必须 ∈ program scope（复用 scope.yml 自查，与 asset/endpoint 同口径）
        const sc = scopeCheckResult(args.program_id, args.host)
        if (!sc.ok) return { code: sc.code, message: `Intent 派生越界：${sc.message}`, hint: '派生器绝不越出 scope（§3-2 局面编译）', retryable: false }
      }
      // 连败黑名单：strategy_key 已拉黑 → 丢弃落审计（E_STATE 由调用方记录）
      const key = args.strategy_key || strategyKey({ host: args.host, path: args.path || '', param: args.param || '', vuln_class: args.vuln_class || '' })
      const st = repo.getStrategy ? repo.getStrategy(key) : null
      if (st && st.blacklisted) {
        return { code: 'E_TASK_STRATEGY_BLACKLISTED', message: `strategy ${key} 连败 ${st.fails} 次已拉黑`, hint: '连败 3 次的组合自动出局（§6.3 命中率校准）；换路由或人工解黑', retryable: false }
      }
      // H3 局面编译：语义假设必须引用卡片且过校验，违规丢弃
      if (args.level === 'H3') {
        const c = compileH3(args.h3, args.host)
        if (!c.ok) {
          return { code: 'E_TASK_H3_REJECTED', message: `H3 语义假设局面编译失败：${c.violations.join('/')}`, hint: 'H3 必须 card_refs≥1 + vuln_class + ≥20 字 hypothesis + host 一致 + 无注入特征（§3-2/§6.1）；连败自动退 H2/H1', retryable: false }
        }
      }
      return null
    },
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
    // 22 号方案 不变量：campaign 子任务归属合法（存在/未归档/program 在绑定内/禁 interval）
    campaignTaskValid: async (args, repo) => {
      if (args.campaign_id == null) return null
      const c = parseCampaign(repo.getCampaign(Number(args.campaign_id)))
      if (!c) return { code: 'E_CAMPAIGN_STATE', message: `专项不存在: ${args.campaign_id}`, hint: '核对 campaign_list 里的 id', retryable: false }
      if (c.status === 'archived') return { code: 'E_CAMPAIGN_STATE', message: `专项 #${c.id} 已归档，不可挂子任务`, hint: '归档专项只读；新建专项承接', retryable: false }
      if (args.program_id && !c.program_ids.includes(String(args.program_id))) {
        return { code: 'E_INVARIANT', message: `program ${args.program_id} 不在专项 #${c.id} 绑定范围（${c.program_ids.join(', ')}）`, hint: '只可派生到已绑定 program', retryable: false }
      }
      if (String(args.schedule?.kind || '') === 'interval') return { code: 'E_CAMPAIGN_INTERVAL_FORBIDDEN', message: 'campaign 子任务禁止 interval', hint: '节奏权唯一归 Campaign tick（INV-C7）', retryable: false }
      return null
    },
    // campaign_create 门禁：mode/program_ids/stop_conditions/autonomy L2（INV-C4）/name 唯一
    campaignCreateValid: async (args, repo) => {
      const mode = String(args.mode || 'single')
      const programIds = (Array.isArray(args.program_ids) ? args.program_ids : []).map(String).filter(Boolean)
      if (!programIds.length) return { code: 'E_SCHEMA', message: 'program_ids 至少 1 个', hint: '绑定已授权 program（scope_list 可查）', retryable: false }
      if (mode === 'cross' && programIds.length < 2) return { code: 'E_INVARIANT', message: 'cross 模式须绑定 ≥2 个 program', hint: '单一 SRC 深挖用 single', retryable: false }
      const gs = args.goal_spec && typeof args.goal_spec === 'object' ? args.goal_spec : {}
      const stop = Array.isArray(gs.stop_conditions) ? gs.stop_conditions.map((x) => String(x).trim()).filter(Boolean) : []
      if (!stop.length) return { code: 'E_INVARIANT', message: 'goal_spec.stop_conditions 非空（铁律：任何专项必须有退出条件）', hint: '给出量化/事件化退出条件，如「confirmed ≥ 3」或「预算耗尽」', retryable: false }
      const autonomy = Number(args.autonomy) || 0
      if (autonomy >= 2) {
        if (!(Number(args.budget_tokens) > 0)) return { code: 'E_CAMPAIGN_AUTONOMY_GATE', message: 'autonomy=2 必须带 budget_tokens（INV-C4）', hint: 'L2 有界自动须有专项级预算上限', retryable: false }
        if (!args.approval_id) return { code: 'E_CAMPAIGN_AUTONOMY_GATE', message: 'autonomy=2 必须带 approval_id（campaign-autonomy 审批）', hint: '先提 campaign-autonomy 审批并批准', retryable: false }
      }
      const dup = repo.findCampaignByName(String(args.name))
      if (dup) return { code: 'E_CONFLICT', message: `活跃专项名已存在: ${args.name}（#${dup.id}）`, hint: '专项名在未归档范围内唯一；改名或归档旧的', retryable: false }
      return null
    },
    // 状态机流转合法性由 handler 判定（invariant 拿不到动词）；此处校验目标存在，保证错误码一致
    campaignStateTransition: async (args, repo) => {
      const c = repo.getCampaign(Number(args.campaign_id))
      if (!c) return { code: 'E_CAMPAIGN_STATE', message: `专项不存在: ${args.campaign_id}`, hint: '核对 campaign_list 里的 id', retryable: false }
      return null
    },
    campaignGoalUpdateValid: async (args, repo) => {
      const c = repo.getCampaign(Number(args.campaign_id))
      if (!c) return { code: 'E_CAMPAIGN_STATE', message: `专项不存在: ${args.campaign_id}`, hint: '核对 campaign_list 里的 id', retryable: false }
      if (c.status === 'archived') return { code: 'E_CAMPAIGN_STATE', message: '归档专项只读', hint: '新建专项承接', retryable: false }
      if (args.goal_spec && typeof args.goal_spec === 'object') {
        const stop = Array.isArray(args.goal_spec.stop_conditions) ? args.goal_spec.stop_conditions.map((x) => String(x).trim()).filter(Boolean) : null
        if (stop && !stop.length) return { code: 'E_INVARIANT', message: 'goal_spec.stop_conditions 不得清空', hint: '退出条件是可更新但不可删除的铁律', retryable: false }
      }
      return null
    },
    campaignDispatchValid: async (args, repo) => {
      const c = parseCampaign(repo.getCampaign(Number(args.campaign_id)))
      if (!c) return { code: 'E_CAMPAIGN_STATE', message: `专项不存在: ${args.campaign_id}`, hint: '核对 campaign_list 里的 id', retryable: false }
      if (c.status === 'archived') return { code: 'E_CAMPAIGN_STATE', message: '归档专项不可派生', hint: '撤档专项不再下发（INV-C9 终态只读）', retryable: false }
      if (c.status === 'draft') return { code: 'E_CAMPAIGN_STATE', message: '草稿专项不可派生，先 campaign_activate', hint: 'draft → active 后方可派生', retryable: false }
      // 23 号方案 §3.1/INV-C11：供给闸在 handler（dispatchDrafts）执行——显式路径报
      // E_CAMPAIGN_LLM_EXHAUSTED（retryable:true），dashboard 人工紧急派生放行。此处不重复观测。
      const drafts = Array.isArray(args.drafts) ? args.drafts : []
      if (!drafts.length) return { code: 'E_SCHEMA', message: 'drafts 至少 1 条', hint: '传编译后的草稿数组', retryable: false }
      for (const d of drafts) {
        const pid = String(d.program_id || c.program_ids[0] || '')
        if (!pid || !c.program_ids.includes(pid)) return { code: 'E_INVARIANT', message: `草稿 program ${pid || '(空)'} 不在专项绑定范围`, hint: '只可派生到已绑定 program', retryable: false }
        if (!String(d.host || '').trim()) return { code: 'E_SCHEMA', message: '草稿缺 host', hint: '每条草稿须含 host', retryable: false }
      }
      // 双预算闸之 campaign 侧（显式路径）：不变量阶段写入 checkpoint/降级并拒绝
      const bg = campaignBudgetGate(repo, c, drafts.length)
      if (bg.blocked) return { code: bg.code, message: bg.message, hint: '等待窗口滚动或 campaign-budget-extend 审批后重试（INV-C10）', retryable: false }
      return null
    },
    // 验收证据铁律：非空 + 前缀白名单（INV-C8）；一任务一验收（INV-C3）
    campaignReviewGate: async (args, repo) => {
      const c = repo.getCampaign(Number(args.campaign_id))
      if (!c) return { code: 'E_CAMPAIGN_STATE', message: `专项不存在: ${args.campaign_id}`, hint: '核对 campaign_list 里的 id', retryable: false }
      if (!String(args.evidence || '').trim() || !EVIDENCE_PREFIX_RE.test(String(args.evidence).trim())) {
        return { code: 'E_EVIDENCE_REQUIRED', message: `验收证据非空且须为 run:/task:/capsule:/ledger:/finding:/oracle: 引用（收到「${String(args.evidence || '').slice(0, 60)}」）`, hint: '无证据不验收（证据铁律）', retryable: false }
      }
      const exists = repo.getDecisionByTask(Number(args.task_id))
      if (exists) return { code: 'E_CAMPAIGN_REVIEWED', message: `task #${args.task_id} 已验收（decision #${exists.id}，${exists.verdict}）`, hint: '一任务一验收（INV-C3）；重验须先作废原行', retryable: false }
      const t = repo.getTask(Number(args.task_id))
      if (!t) return { code: 'E_NOT_FOUND', message: `task 不存在: ${args.task_id}`, hint: '核对 task_list 里的 id', retryable: false }
      if (Number(t.campaign_id) !== Number(args.campaign_id)) return { code: 'E_INVARIANT', message: `task #${args.task_id} 不属专项 #${args.campaign_id}`, hint: '验收对象必须是本专项子任务', retryable: false }
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
      // INV-C7：campaign 子任务禁止 interval（节奏权唯一归 campaign tick，防双重调度漂移）
      if (args.campaign_id != null && sched.kind === 'interval') {
        throwErr('E_CAMPAIGN_INTERVAL_FORBIDDEN', 'campaign 子任务禁止 interval 调度', '挖掘推进归 Campaign tick；基线节奏类工作请建非 campaign 的 interval 任务')
      }
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
      // 21 号方案 §3-4：per-program 周期预算闸（超额停派；dashboard/approval 人工放行）
      if (ctx.actor !== 'dashboard' && ctx.actor !== 'approval' && repo.budgetUsage) {
        const usage = repo.budgetUsage(programId, nowTs - BUDGET_PERIOD_MS)
        if (usage.tasks_created >= BUDGET_MAX_TASKS) {
          throwErr('E_TASK_BUDGET_EXHAUSTED', `program ${programId} 周期任务预算耗尽：${usage.tasks_created}/${BUDGET_MAX_TASKS} 任务/${Math.round(BUDGET_PERIOD_MS / 86400000)}d`, '预算闸停派（§3-4）：人工评估后由 dashboard 建任务放行，或提升 SEC_TASK_BUDGET_MAX_TASKS 上限', false)
        }
        if (usage.spent_tokens >= BUDGET_MAX_TOKENS) {
          throwErr('E_TASK_BUDGET_EXHAUSTED', `program ${programId} 周期 token 预算耗尽：${usage.spent_tokens}/${BUDGET_MAX_TOKENS} tokens/${Math.round(BUDGET_PERIOD_MS / 86400000)}d`, '预算闸停派（§3-4）：人工评估后由 dashboard 建任务放行，或提升 SEC_TASK_BUDGET_MAX_TOKENS 上限', false)
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
        campaign_id: args.campaign_id ?? null,
        campaign_role: args.campaign_role ?? null,
        strategy_key: args.strategy_key ?? null,
        task_class: args.task_class ?? null,
        model_hint: args.model_hint ?? null,
      })
      const payload = {
        task_id: id, program_id: programId, phase: args.phase || '', objective_head: String(args.objective || '').slice(0, 80),
        schedule_kind: sched.kind, parent_id: parentId, priority: args.priority ?? 5, goal: args.goal || '', source: 'model',
        campaign_id: args.campaign_id ?? null, campaign_role: args.campaign_role ?? null,
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

      // 21 号方案 §0-8（INV-T14 落地）：成本归因——worker 上报 token 回填 spent_tokens；
      // 超 budget_tokens 记 [预算超支]（不影响 ok——超支是观测事实不是失败）。
      let spentTokens = Number.isInteger(args.spent_tokens) && args.spent_tokens >= 0 ? args.spent_tokens : null
      // 26 号补丁：worker 未上报时按 session_id 从 dsh-bill records.jsonl 归因（专项预算闸的真实口径）
      if (spentTokens === null) {
        const sid = args.session_id ?? t.session_id
        const billTok = billSum.tokensForSession(sid)
        if (billTok !== null) spentTokens = billTok
      }
      let budgetOverrun = false
      if (spentTokens !== null && t.budget_tokens !== null && t.budget_tokens !== undefined && spentTokens > Number(t.budget_tokens)) {
        budgetOverrun = true
        note = `[预算超支] spent=${spentTokens} > budget=${t.budget_tokens}${note ? ' | ' + note : ''}`.slice(0, 500)
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
      const finishSets = {
        status, result: tailNote.slice(-8000), last_run_at: finished, last_run_id: runId || null, next_run_at: nextRunAt,
        session_id: args.session_id ?? t.session_id,
        active_run_id: null,
        finished_at: (status === 'done' || status === 'failed') ? finished : t.finished_at,
      }
      if (spentTokens !== null) finishSets.spent_tokens = spentTokens
      repo.transitionTask(Number(args.task_id), finishSets)
      repo.insertTaskRun({ task_id: Number(args.task_id), run_id: runId, ok, note, started_at: t.started_at, finished_at: finished, session_id: args.session_id ?? null, spent_tokens: spentTokens })
      return {
        data: { task_id: Number(args.task_id), status, next_run_at: nextRunAt, run_recorded: true, spent_tokens: spentTokens, budget_overrun: budgetOverrun, guard: { checked: guard.checked, missing: guard.missing } },
        events: [{ name: 'task.finished', payload: { task_id: Number(args.task_id), program_id: t.program_id, run_id: runId, ok, outcome: args.outcome, schedule_kind: t.schedule_kind, next_run_at: nextRunAt, session_id: args.session_id ?? null, spent_tokens: spentTokens, budget_overrun: budgetOverrun, note: String(note || '').slice(0, 300), guard: { checked: guard.checked, missing: guard.missing }, truth, fgs_snapshot: fgsSnapshot, cause: 'run', campaign_id: t.campaign_id ?? null, campaign_role: t.campaign_role ?? null } }],
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

    // 21 号方案 §3-1：Intent 派生落任务草稿（strategy 去重 + 预算闸 + 绝不自动执行）
    task_derive_intent: async (args, repo, ctx) => {
      const bare = args.strategy_key || strategyKey({ host: args.host, path: args.path || '', param: args.param || '', vuln_class: args.vuln_class || '' })
      // 22 号方案 §5.5：专项维度去重键（连败黑名单仍按裸 key 判定——打法属性非专项属性）
      const key = args.campaign_id ? `c${args.campaign_id}|${bare}` : bare
      // strategy_key 幂等去重：已测组合不重发
      const existing = repo.getStrategy ? repo.getStrategy(key) : null
      if (existing && !existing.blacklisted) {
        return { data: { deduped: true, strategy_key: bare, task_id: existing.last_task_id ?? null }, events: [], after: { deduped: true } }
      }
      const extraLines = []
      if (args.level === 'H3' && args.h3) {
        extraLines.push(`H3 语义假设：${args.h3.hypothesis}`)
        extraLines.push(`引用卡片：${(args.h3.card_refs || []).join(', ')}（卡片置信度已吃 wins/fails 校准）`)
      }
      let objective
      if (args.kind === 'crawl') {
        objective = `[覆盖缺口] ${args.host} 未爬取——端点三件套（katana/gau/waybackurls）+ 登录态判定 endpoint_classify_auth；尊重 program QPS/risk；产物 endpoint_upsert 入库 + ledger_coverage_mark(dim=crawl) 记账。`
      } else if (args.kind === 'param_enrich') {
        objective = `[覆盖缺口] ${args.host}${args.path || ''} 无参数——arjun 参数补全 + flows/JS 提取带参 URL → endpoint_queue_surface 修复喂料队列 + ledger_coverage_mark(dim=param) 记账。`
      } else if (args.kind === 'asset_enum') {
        // 25 号补丁：资产收集入专项——根域枚举刷新闭环（枚举→探活→入库→enum_fresh 记账）
        objective = `[资产缺口] ${args.host} 根域枚举超窗——subfinder 子域枚举 + dnsx 解析去存 + httpx 探活分级（fofa_search 可作补充信源）；新存活主机 asset_upsert_bulk 入库（source=asset_enum，尊重 program QPS/risk，不越出 scope）；收尾 ledger_coverage_mark(dim=asset, key=${args.host}, mark=enum_fresh) 记账并写 handoff 摘要。`
      } else if (args.kind === 'review_finding') {
        // 26 号补丁：存量复核入专项——超龄未分诊 finding 逐条复核（复用验证铁律，一次性消化历史债务）
        objective = `[存量复核] finding #${args.host} 超龄未分诊——vuln_get 读取候选详情与既有证据；证据充分走复核校准（confirm 需机器 oracle 或 proof capsule，不可凭字段齐全确认）；复现可差分则补 exec_oracle_judge 验证；证据不足/误报则 vuln_reject 或标 false_positive 并写明 reason；全程不越出 scope，结论落 FGS + handoff 引用。`
      } else {
        objective = hypothesisObjective({ level: args.level || 'H2', vulnClass: args.vuln_class || 'info_disclosure', host: args.host, path: args.path || '', param: args.param || '', oracle: args.oracle, rationale: args.rationale || '覆盖缺口驱动', programId: args.program_id, extraLines })
      }
      // 预算闸与任务创建复用 task_create 全链（actor=reactor，预算闸对 reactor 生效）
      if (!dispatchRef) throwErr('E_BACKEND_UNAVAILABLE', '总线 dispatch 不可达', '确认总线已挂载', true)
      const r = await dispatchRef('task', 'create', {
        program_id: args.program_id, objective, priority: args.level === 'H1' ? 4 : 3, phase: 'vuln',
        budget_tokens: 150000,
        ...(args.campaign_id != null ? { campaign_id: args.campaign_id } : {}),
        ...(args.campaign_role ? { campaign_role: args.campaign_role } : {}),
        strategy_key: bare,
        // 23 号方案 §3.7：分档标注随子任务落库；Path A 时 model_hint 一并不发（Bellkeeper 按 hint 路由）
        task_class: args.task_class || classifyTaskClass({ kind: args.kind, vuln_class: args.vuln_class || '' }),
        ...(args.model_hint ? { model_hint: args.model_hint } : {}),
        // Path A：provider+model 成对透传，worker 经 model-patch 指定模型
        ...(args.provider && args.model ? { provider: String(args.provider), model: String(args.model) } : {}),
        // 22 号方案：Campaign 子任务以 once 调度入队，才被调度器认领执行（调度器只认领 schedule_kind 非空）。
        // 21 号「无主派生」草稿仍保持 NULL（queued 待人工/编排 run_now）；INV-C7 只禁 interval。
        ...(args.campaign_id != null ? { schedule: { kind: 'once', at: Date.now() + 3000 } } : {}),
      }, { actor: 'reactor', cause: ctx?.cause })
      if (!r || !r.ok) throwErr(r?.error?.code || 'E_INTERNAL', r?.error?.message || '派生任务创建失败', r?.error?.hint || '', false)
      const taskId = r.data.task_id
      if (repo.upsertStrategy) repo.upsertStrategy(key, { program_id: args.program_id, last_task_id: taskId })
      return {
        data: { deduped: false, strategy_key: bare, task_id: taskId, kind: args.kind, level: args.level || 'H2' },
        events: [{ name: 'task.intent.derived', payload: { strategy_key: bare, task_id: taskId, program_id: args.program_id, kind: args.kind, level: args.level || 'H2', vuln_class: args.vuln_class || null, host: args.host, path: args.path || '', param: args.param || '', campaign_id: args.campaign_id ?? null, campaign_role: args.campaign_role ?? null, cause: ctx?.cause ? 'event' : 'manual' } }],
        after: { task_id: taskId, strategy_key: bare },
      }
    },

    // ---- 22 号方案 §八：Campaign 命令 handlers ----

    campaign_create: async (args, repo, ctx) => {
      const mode = String(args.mode || 'single')
      const programIds = (Array.isArray(args.program_ids) ? args.program_ids : []).map(String)
      const goalSpec = args.goal_spec && typeof args.goal_spec === 'object' ? args.goal_spec : {}
      const autonomy = Number(args.autonomy) || 0
      const policy = Object.assign({
        derive_cap_per_tick: CAMPAIGN_DERIVE_CAP_PER_TICK, max_active_tasks: 20, task_priority_range: [1, 6], allowed_phases: ['vuln'],
      }, (args.policy && typeof args.policy === 'object') ? args.policy : {})
      // 23 号方案 §3.6：新建专项默认 2M/7d（L2 仍须显式预算 INV-C4，不在此兜底）
      const budgetTokens = args.budget_tokens != null ? args.budget_tokens : (autonomy < 2 ? CAMPAIGN_DEFAULT_BUDGET_TOKENS : null)
      const id = repo.insertCampaign({
        name: String(args.name), mode, program_ids: programIds, goal_spec: goalSpec,
        autonomy, policy, status: 'draft',
        budget_tokens: budgetTokens, budget_window_days: args.budget_window_days ?? 7,
        approval_id: args.approval_id ?? null, heartbeat_at: Date.now(),
        created_by: String(ctx?.actor || 'system'),
      })
      return {
        data: { campaign_id: id, name: String(args.name), mode, status: 'draft', autonomy: Number(args.autonomy) || 0, program_ids: programIds },
        events: [{ name: 'task.campaign.created', payload: { campaign_id: id, name: String(args.name), mode, program_ids: programIds, autonomy: Number(args.autonomy) || 0 } }],
        after: { campaign_id: id },
      }
    },

    campaign_activate: async (args, repo) => {
      const c = parseCampaign(repo.getCampaign(Number(args.campaign_id)))
      if (!c) throwErr('E_CAMPAIGN_STATE', `专项不存在: ${args.campaign_id}`, '核对 campaign_list 里的 id')
      if (!['draft', 'paused'].includes(c.status)) throwErr('E_CAMPAIGN_STATE', `专项 #${c.id} 当前 ${c.status}，仅 draft/paused 可激活`, '状态机：draft|paused → active')
      const missing = await checkCampaignPrograms(c.program_ids)
      if (missing.length) throwErr('E_CAMPAIGN_PROGRAM_UNRESOLVED', `绑定 program 未授权：${missing.map((m) => `${m.program_id}(${m.reason})`).join(', ')}`, '先在 scope 中登记并确保未过期（INV-C1）')
      if (Number(c.autonomy) >= 2 && (!(Number(c.budget_tokens) > 0) || !c.approval_id)) throwErr('E_CAMPAIGN_AUTONOMY_GATE', 'autonomy=2 缺 budget_tokens 或 approval_id（INV-C4）', '补齐后激活')
      const from = c.status
      repo.updateCampaign(c.id, { status: 'active' }, from)
      return {
        data: { campaign_id: c.id, status: 'active', from },
        events: [{ name: 'task.campaign.status.changed', payload: { campaign_id: c.id, from, to: 'active', cause: 'activate' } }],
      }
    },

    campaign_pause: async (args, repo) => {
      const c = parseCampaign(repo.getCampaign(Number(args.campaign_id)))
      if (!c) throwErr('E_CAMPAIGN_STATE', `专项不存在: ${args.campaign_id}`, '核对 campaign_list 里的 id')
      if (c.status !== 'active') throwErr('E_CAMPAIGN_STATE', `专项 #${c.id} 当前 ${c.status}，仅 active 可暂停`, '状态机：active → paused')
      repo.updateCampaign(c.id, { status: 'paused' }, 'active')
      const events = [{ name: 'task.campaign.status.changed', payload: { campaign_id: c.id, from: 'active', to: 'paused', cause: args.note || 'manual' } }]
      return { data: { campaign_id: c.id, status: 'paused' }, events }
    },

    campaign_resume: async (args, repo) => {
      const c = parseCampaign(repo.getCampaign(Number(args.campaign_id)))
      if (!c) throwErr('E_CAMPAIGN_STATE', `专项不存在: ${args.campaign_id}`, '核对 campaign_list 里的 id')
      if (c.status !== 'paused') throwErr('E_CAMPAIGN_STATE', `专项 #${c.id} 当前 ${c.status}，仅 paused 可恢复`, '状态机：paused → active')
      const missing = await checkCampaignPrograms(c.program_ids)
      if (missing.length) throwErr('E_CAMPAIGN_PROGRAM_UNRESOLVED', `绑定 program 未授权：${missing.map((m) => m.program_id).join(', ')}`, '授权漂移 fail-closed，恢复前先修复授权')
      repo.updateCampaign(c.id, { status: 'active' }, 'paused')
      return { data: { campaign_id: c.id, status: 'active' }, events: [{ name: 'task.campaign.status.changed', payload: { campaign_id: c.id, from: 'paused', to: 'active', cause: 'resume' } }] }
    },

    campaign_archive: async (args, repo) => {
      const c = parseCampaign(repo.getCampaign(Number(args.campaign_id)))
      if (!c) throwErr('E_CAMPAIGN_STATE', `专项不存在: ${args.campaign_id}`, '核对 campaign_list 里的 id')
      if (c.status === 'archived') return { data: { campaign_id: c.id, status: 'archived', idempotent: true } }
      repo.updateCampaign(c.id, { status: 'archived', archived_at: Date.now() }, c.status)
      // 同步 cancel 其 queued 子任务（在跑的跑完）
      let cancelled = 0
      const queued = repo.listTasksWhere({ campaign_id: c.id, status: 'queued' }, 200, 0, 'priority')
      for (const t of queued) {
        try { const r = await dispatchRef('task', 'cancel', { task_id: t.id, note: `专项 #${c.id} 归档` }, { actor: 'reactor' }); if (r && r.ok) cancelled++ } catch (e) { log(`归档专项 #${c.id} 取消 queued 子任务 #${t.id} 失败: ${e?.message}`) }
      }
      return {
        data: { campaign_id: c.id, status: 'archived', cancelled_queued: cancelled },
        events: [{ name: 'task.campaign.status.changed', payload: { campaign_id: c.id, from: c.status, to: 'archived', cause: args.note || 'archive' } }],
      }
    },

    campaign_goal_revise: async (args, repo) => {
      const c = parseCampaign(repo.getCampaign(Number(args.campaign_id)))
      if (!c) throwErr('E_CAMPAIGN_STATE', `专项不存在: ${args.campaign_id}`, '核对 campaign_list 里的 id')
      const patch = {}
      let goalChanged = false
      if (args.goal_spec && typeof args.goal_spec === 'object') {
        const merged = Object.assign({}, c.goal_spec, args.goal_spec)
        if (!Array.isArray(merged.stop_conditions) || !merged.stop_conditions.map((x) => String(x).trim()).filter(Boolean).length) throwErr('E_INVARIANT', 'goal_spec.stop_conditions 不得清空', '退出条件是铁律')
        patch.goal_spec = JSON.stringify(merged); goalChanged = true
      }
      if (args.policy && typeof args.policy === 'object') patch.policy = JSON.stringify(Object.assign({}, c.policy, args.policy))
      if (!Object.keys(patch).length) throwErr('E_SCHEMA', 'goal_spec/policy 至少提供一项', '传 changed 字段')
      const events = [{ name: 'task.campaign.goal.changed', payload: { campaign_id: c.id, diff: { goal_spec: goalChanged, policy: !!patch.policy } } }]
      // active 中改目标 → 强制转 reviewing 待人工确认（§6.1）
      if (goalChanged && c.status === 'active') { patch.status = 'reviewing'; events.push({ name: 'task.campaign.status.changed', payload: { campaign_id: c.id, from: 'active', to: 'reviewing', cause: 'goal_update' } }) }
      repo.updateCampaign(c.id, patch, c.status)
      return { data: { campaign_id: c.id, status: patch.status || c.status, goal_changed: goalChanged }, events }
    },

    campaign_dispatch: async (args, repo, ctx) => {
      const c = parseCampaign(repo.getCampaign(Number(args.campaign_id)))
      if (!c) throwErr('E_CAMPAIGN_STATE', `专项不存在: ${args.campaign_id}`, '核对 campaign_list 里的 id')
      // 供给因子用于有界折算；dashboard 人工放行时不折算（紧急派生通道，与预算闸同款）
      let supplyFactor = 1; let supplyBounded = false; let supplyMembers = []
      if (ctx?.actor !== 'dashboard') {
        try {
          const supply = await evaluateSupply()
          supplyFactor = supply.supply_factor; supplyBounded = supply.bounded; supplyMembers = supply.members
        } catch { /* fail-open：显式路径观测异常不折算 */ }
      }
      const res = await dispatchDrafts(c, Array.isArray(args.drafts) ? args.drafts : [], repo, { explicit: true, supplyFactor, supplyBounded, supplyMembers })
      return {
        data: { campaign_id: c.id, derived: res.derived, deduped: res.deduped, dropped: res.dropped },
        events: res.events,
      }
    },

    campaign_review_pass: async (args, repo) => {
      const c = parseCampaign(repo.getCampaign(Number(args.campaign_id)))
      if (!c) throwErr('E_CAMPAIGN_STATE', `专项不存在: ${args.campaign_id}`, '核对 campaign_list 里的 id')
      if (c.status !== 'reviewing') throwErr('E_CAMPAIGN_STATE', `专项 #${c.id} 当前 ${c.status}，仅 reviewing 可审阅通过`, '状态机：reviewing → active')
      repo.updateCampaign(c.id, { status: 'active' }, 'reviewing')
      const cp = writeCheckpoint(repo, c.id, 'milestone', `人工审阅通过：${String(args.summary || '').slice(0, 200)}`, { summary: args.summary })
      return { data: { campaign_id: c.id, status: 'active' }, events: [{ name: 'task.campaign.status.changed', payload: { campaign_id: c.id, from: 'reviewing', to: 'active', cause: 'review_pass' } }, ...cp.events] }
    },

    campaign_tick_now: async (args, repo) => {
      const c = repo.getCampaign(Number(args.campaign_id))
      if (!c) throwErr('E_CAMPAIGN_STATE', `专项不存在: ${args.campaign_id}`, '核对 campaign_list 里的 id')
      const { summary, events } = await runCampaignTick(c, repo)
      return { data: summary, events }
    },

    campaign_tick: async (args, repo) => {
      let rows
      if (args.campaign_id) {
        const c = repo.getCampaign(Number(args.campaign_id))
        if (!c) throwErr('E_CAMPAIGN_STATE', `专项不存在: ${args.campaign_id}`, '核对 campaign_list 里的 id')
        rows = [c]
      } else {
        rows = repo.listCampaignsWhere({ status: 'active' }, Number(args.limit) || CAMPAIGN_TICK_LIMIT, 0)
      }
      const summaries = []
      const events = []
      for (const row of rows) {
        try {
          const r = await runCampaignTick(row, repo)
          summaries.push(r.summary); events.push(...r.events)
        } catch (e) {
          // tick 内异常隔离到该 campaign：记 escalation 不中断其他（fail-closed 不吞错）
          log(`campaign#${row.id} tick 异常: ${e?.stack || e?.message || e}`)
          try { const cp = writeCheckpoint(repo, row.id, 'escalation', `tick 异常：${String(e?.message || e).slice(0, 300)}`, {}); events.push(...cp.events) } catch { /* ignore */ }
          summaries.push({ campaign_id: row.id, error: String(e?.message || e) })
        }
      }
      return { data: { processed: rows.length, summaries }, events }
    },

    campaign_record_decision: async (args, repo) => {
      const c = repo.getCampaign(Number(args.campaign_id))
      if (!c) throwErr('E_CAMPAIGN_STATE', `专项不存在: ${args.campaign_id}`, '核对 campaign_list 里的 id')
      const rd = recordDecision(repo, { campaign_id: c.id, task_id: args.task_id, verdict: args.verdict, evidence: args.evidence, goal_delta: args.goal_delta, decided_by: args.decided_by })
      if (rd.duplicate) throwErr('E_CAMPAIGN_REVIEWED', `task #${args.task_id} 已验收`, '一任务一验收（INV-C3）')
      return { data: { campaign_id: c.id, task_id: Number(args.task_id), verdict: args.verdict, decision_id: rd.id }, events: decisionEvents(rd) }
    },

    campaign_checkpoint: async (args, repo) => {
      const c = repo.getCampaign(Number(args.campaign_id))
      if (!c) throwErr('E_CAMPAIGN_STATE', `专项不存在: ${args.campaign_id}`, '核对 campaign_list 里的 id')
      const cp = writeCheckpoint(repo, c.id, args.kind, args.summary, args.payload)
      return { data: { campaign_id: c.id, checkpoint_id: cp.id, kind: args.kind }, events: cp.events }
    },

    // （approval 专用）campaign-autonomy 批准 effect：落档 + 激活
    campaign_autonomy_apply: async (args, repo) => {
      const c = parseCampaign(repo.findCampaignByName(String(args.name)))
      if (!c) throwErr('E_CAMPAIGN_STATE', `专项不存在: ${args.name}`, '核对 campaign_list')
      if (!['draft', 'paused'].includes(c.status)) throwErr('E_CAMPAIGN_STATE', `专项 #${c.id} 当前 ${c.status}，仅 draft/paused 可升档激活`, '状态机')
      if (Number(args.autonomy) >= 2 && (!(Number(c.budget_tokens) > 0) || !args.approval_id)) throwErr('E_CAMPAIGN_AUTONOMY_GATE', 'autonomy=2 缺 budget_tokens（INV-C4）', '先补齐预算')
      const from = c.status
      repo.updateCampaign(c.id, { autonomy: Number(args.autonomy), approval_id: args.approval_id, status: 'active' }, from)
      return {
        data: { campaign_id: c.id, status: 'active', autonomy: Number(args.autonomy), from },
        events: [{ name: 'task.campaign.status.changed', payload: { campaign_id: c.id, from, to: 'active', cause: 'autonomy_approval' } }],
      }
    },

    // （approval 专用）campaign-budget-extend 批准 effect：budget_tokens 增量落账
    campaign_budget_extend: async (args, repo) => {
      const c = repo.findCampaignByName(String(args.name))
      if (!c) throwErr('E_CAMPAIGN_STATE', `专项不存在: ${args.name}`, '核对 campaign_list')
      const next = Number(c.budget_tokens || 0) + Number(args.add_tokens)
      repo.updateCampaign(c.id, { budget_tokens: next })
      writeCheckpoint(repo, c.id, 'milestone', `campaign-budget-extend 批准 #${args.approval_id}：预算 +${args.add_tokens} → ${next}`, { approval_id: args.approval_id })
      return { data: { campaign_id: c.id, budget_tokens: next } }
    },

    task_submission_backlog: async (args) => {
      if (!dispatchRef || !queryRef) throwErr('E_BACKEND_UNAVAILABLE', '总线 query/dispatch 不可达', '确认 vuln 域已注册', true)
      const q = await queryRef('vuln', 'submission_queue', { limit: args.limit || 50 })
      const rows = (q && q.ok !== false && Array.isArray(q.rows)) ? q.rows : []
      let created = 0
      let skipped = 0
      for (const f of rows) {
        if (args.program_id && String(f.program_id || '') !== String(args.program_id)) continue
        const marker = `[提交] finding #${f.id}`
        try {
          const list = await queryRef('task', 'list', { q: marker, bucket: 'active', limit: 5 }, { actor: 'system' })
          const existing = (list && list.ok) ? ((list.data && Array.isArray(list.data.rows)) ? list.data.rows : (Array.isArray(list.rows) ? list.rows : [])) : []
          if (existing.some((t) => String(t.objective || '').includes(marker))) { skipped++; continue }
          const objective = `${marker} ${f.host || ''} 确认漏洞待提交 SRC：report_draft_submission 出草稿 → 人工审校 → 平台提交 → vuln_submit(platform/submission_url/remote_id/vendor_status) 回写运营列。`
          const r = await dispatchRef('task', 'create', { program_id: f.program_id || '_global', phase: 'review', goal: 'research', priority: 2, objective }, { actor: 'reactor' })
          if (r && r.ok) created++; else skipped++
        } catch (e) {
          log(`提交任务补建失败 finding #${f.id}: ${e?.message}`)
          skipped++
        }
      }
      return { data: { created, skipped, scanned: rows.length } }
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
        events: [{ name: 'task.finished', payload: { task_id: Number(args.task_id), program_id: t.program_id, run_id: '', ok: true, outcome: 'done', schedule_kind: t.schedule_kind, next_run_at: null, session_id: null, guard: { checked: false, missing: [] }, truth: { checked: false, rejected: false, reason: '' }, fgs_snapshot: fgsSnapshot, cause: 'approval', campaign_id: t.campaign_id ?? null, campaign_role: t.campaign_role ?? null } }],
        after: { task_id: Number(args.task_id), status: 'done' },
      }
    },
  }

  const queries = {
    task_list: async (args, repo) => {
      const filters = { program_id: args.program_id, status: args.status, phase: args.phase, goal: args.goal, q: args.q, bucket: args.bucket, scheduled: args.scheduled, campaign_id: args.campaign_id }
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
    // ---- 22 号方案 §八：Campaign 查询 ----
    campaign_list: async (args, repo) => {
      const filters = { status: args.status || '', program_id: args.program_id || '' }
      const total = repo.countCampaignsWhere(filters)
      const rows = repo.listCampaignsWhere(filters, args.limit || 50, args.offset || 0).map((row) => {
        const c = parseCampaign(row)
        const decisions = repo.listCampaignDecisions(c.id, '', 500, 0)
        const agg = { accepted: 0, rejected: 0, rework: 0, escalated: 0 }
        for (const d of decisions) if (agg[d.verdict] !== undefined) agg[d.verdict]++
        return {
          id: c.id, name: c.name, mode: c.mode, status: c.status, autonomy: c.autonomy,
          program_ids: c.program_ids, budget_tokens: c.budget_tokens, spent_tokens: c.spent_tokens,
          budget_window_days: c.budget_window_days, heartbeat_at: c.heartbeat_at, last_tick_at: c.last_tick_at,
          created_at: c.created_at, updated_at: c.updated_at, decision_totals: agg,
          objective: c.goal_spec.objective || '',
          supply: supplyBadge(repo, c.id),
        }
      })
      return { rows, total }
    },
    campaign_get: async (args, repo) => {
      const c = parseCampaign(repo.getCampaign(Number(args.id)))
      if (!c) throwErr('E_CAMPAIGN_STATE', `专项不存在: ${args.id}`, '核对 campaign_list 里的 id')
      const decisions = repo.listCampaignDecisions(c.id, '', 50, 0)
      const activeTasks = repo.listTasksWhere({ campaign_id: c.id, bucket: 'active' }, 100, 0, 'priority')
      const checkpoints = repo.listCheckpoints(c.id, 20)
      const usage = repo.campaignUsage(c.id, Date.now() - (Number(c.budget_window_days) || 7) * 86400000)
      return {
        id: c.id, name: c.name, mode: c.mode, status: c.status, autonomy: c.autonomy, approval_id: c.approval_id,
        program_ids: c.program_ids, goal_spec: c.goal_spec, policy: c.policy,
        budget_tokens: c.budget_tokens, spent_tokens: c.spent_tokens, budget_window_days: c.budget_window_days,
        window_usage: usage, last_tick_at: c.last_tick_at, heartbeat_at: c.heartbeat_at,
        created_by: c.created_by, created_at: c.created_at, updated_at: c.updated_at, archived_at: c.archived_at,
        decisions, active_tasks: activeTasks.map((t) => ({ id: t.id, objective: t.objective, status: t.status, campaign_role: t.campaign_role, priority: t.priority, program_id: t.program_id })),
        checkpoints,
        supply: supplyBadge(repo, c.id),
      }
    },
    campaign_progress: async (args, repo) => {
      const c = parseCampaign(repo.getCampaign(Number(args.id)))
      if (!c) throwErr('E_CAMPAIGN_STATE', `专项不存在: ${args.id}`, '核对 campaign_list 里的 id')
      const decisions = repo.listCampaignDecisions(c.id, '', 500, 0)
      const totals = { decisions: decisions.length, accepted: 0, rejected: 0, rework: 0, escalated: 0, confirmed_delta: 0, spent_tokens: 0 }
      const byProgram = {}
      for (const d of decisions) {
        if (totals[d.verdict] !== undefined) totals[d.verdict]++
        const delta = parseJsonSafe(d.goal_delta, {})
        totals.confirmed_delta += Number(delta.confirmed || delta.confirmed_delta || 0)
        totals.spent_tokens += Number(delta.spent_tokens || 0)
        const pid = d.program_id || '_unknown'
        byProgram[pid] = byProgram[pid] || { accepted: 0, rejected: 0, rework: 0, escalated: 0, confirmed_delta: 0 }
        if (byProgram[pid][d.verdict] !== undefined) byProgram[pid][d.verdict]++
        byProgram[pid].confirmed_delta += Number(delta.confirmed || delta.confirmed_delta || 0)
      }
      return { campaign_id: c.id, totals, by_program: byProgram, targets: c.goal_spec.targets || {}, stop_conditions: c.goal_spec.stop_conditions || [] }
    },
    campaign_pending_drafts: async (args, repo) => {
      const c = parseCampaign(repo.getCampaign(Number(args.id)))
      if (!c) throwErr('E_CAMPAIGN_STATE', `专项不存在: ${args.id}`, '核对 campaign_list 里的 id')
      if (Number(c.autonomy) < 1) return { campaign_id: c.id, autonomy: c.autonomy, drafts: [], skipped: [{ reason: 'autonomy_l0_no_drafts' }] }
      const inputs = await gatherPlanInputs(c, repo)
      const plan = compileCampaignPlan({ campaign: c, ...inputs })
      const limit = Number(args.limit) || 20
      return { campaign_id: c.id, autonomy: c.autonomy, drafts: plan.drafts.slice(0, limit), skipped: plan.skipped, active_task_count: inputs.activeTaskCount, budget_remaining_ratio: inputs.budgetRemainingRatio }
    },
    campaign_decisions: async (args, repo) => {
      const rows = repo.listCampaignDecisions(Number(args.campaign_id), args.verdict || '', args.limit || 50, args.offset || 0)
      const total = repo.countCampaignDecisions(Number(args.campaign_id), args.verdict || '')
      return { rows, total }
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
        // 22 号方案 §9.2/L6：Planner 现算无缓存，被撤回卡片在 H3 草稿中的引用自然失效；
        // 对命中撤回 scope 的活跃专项写 checkpoint 留痕（可观测，fail-open）。
        try {
          const repo = backendRepoRef ? backendRepoRef() : null
          if (repo) {
            for (const row of repo.listCampaignsWhere({ status: 'active' }, 200, 0)) {
              const c = parseCampaign(row)
              if (p.scope_type === 'program' && p.scope_id && !c.program_ids.includes(String(p.scope_id))) continue
              writeCheckpoint(repo, c.id, 'milestone', `知识卡撤回 ${p.artifact_kind || ''}/${p.artifact_id || ''}：H3 草稿引用作废（Planner 现算自然失效）`, { release_id: p.release_id || null })
            }
          }
        } catch { /* best-effort */ }
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
    // 产出闭环：confirmed finding → 幂等入队「[提交] finding #id」任务（phase=review）。
    // 同 finding 已有活跃提交任务则跳过；无 program_id 时归 _global 桶（与既有约定一致）。
    onVulnConfirmed: async (envelope) => {
      if (!dispatchRef) return { ok: true, data: { skipped: true } }
      const p = envelope?.payload || {}
      const fid = p.finding_id
      if (!fid) return { ok: true, data: { skipped: true } }
      const marker = `[提交] finding #${fid}`
      try {
        const list = await queryRef('task', 'list', { q: marker, bucket: 'active', limit: 20 }, { actor: 'system' })
        const rows = (list && list.ok) ? ((list.data && Array.isArray(list.data.rows)) ? list.data.rows : (Array.isArray(list.rows) ? list.rows : [])) : []
        if (rows.some((t) => String(t.objective || '').includes(marker))) {
          return { ok: true, data: { skipped: true, reason: 'submission task exists' } }
        }
        const host = p.host || p.subject || ''
        const objective = `${marker} ${host} 确认漏洞待提交 SRC：report_draft_submission 出草稿 → 人工审校 → 平台提交 → vuln_submit(platform/submission_url/remote_id/vendor_status) 回写运营列。`
        // 产出闭环任务不自动起 worker（提交需人工审校/平台操作）——queued 待 task_run_now
        const r = await dispatchRef('task', 'create', {
          program_id: p.program_id || '_global', phase: 'review', goal: 'research', priority: 2, objective,
        }, { actor: 'reactor' })
        return { ok: !!r?.ok, data: { skipped: false } }
      } catch (e) {
        log(`vuln.signal.confirmed 提交任务入队失败（best-effort）: ${e?.message}`)
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

    // 21 号方案 §3-1/§6.2：新端点入库 → 污点路由推导 H2 假设任务草稿（有界：单端点 ≤3 条）
    // 弱联动 best-effort：派生失败不阻断端点入库；派生丢弃（黑名单/预算/越界）落返回供审计。
    onEndpointHypothesis: async (envelope) => {
      if (!dispatchRef) return { ok: true, data: { skipped: true } }
      const p = envelope?.payload || {}
      const programId = String(p.program_id || '')
      const host = String(p.host || '')
      const epPath = String(p.path || '')
      if (!programId || !host || !epPath) return { ok: true, data: { skipped: true } }
      // 取端点行（参数/auth_state/should_auth 是路由输入）
      let row = null
      try {
        const q = await queryRef('endpoint', 'list', { host, path_like: epPath, limit: 5 }, { actor: 'reactor' })
        const rows = (q && (q.rows || q.data?.rows)) || []
        row = rows.find((r) => r.host === host && r.path === epPath) || null
      } catch { row = null }
      const drafts = await deriveHypothesis({ programId, host, path: epPath, endpointRow: row })
      const derived = []
      const dropped = []
      for (const d of drafts) {
        try {
          const r = await dispatchRef('task', 'derive_intent', d, { actor: 'reactor', cause: envelope })
          if (r && r.ok) derived.push({ strategy_key: r.data.strategy_key, task_id: r.data.task_id, deduped: !!r.data.deduped })
          else dropped.push({ strategy_key: d.strategy_key, code: r?.error?.code || 'E_INTERNAL', message: String(r?.error?.message || '').slice(0, 120) })
        } catch (e) {
          dropped.push({ strategy_key: d.strategy_key, code: e?.code || 'E_INTERNAL', message: String(e?.message || e).slice(0, 120) })
        }
      }
      return { ok: true, data: { skipped: false, derived, dropped } }
    },

    // 21 号方案 §3-1：覆盖缺口队列消费——未爬 host / 无参数端点自动派 crawl/param_enrich 草稿
    // （缺口态白名单；派生失败 best-effort 不阻断记账主链；去重/预算闸在 derive_intent 链上）
    onCoverageMarked: async (envelope) => {
      if (!dispatchRef) return { ok: true, data: { skipped: true } }
      const p = envelope?.payload || {}
      const programId = String(p.program || '')
      const dim = String(p.dim || '')
      const key = String(p.key || '')
      const mark = String(p.mark || '')
      if (!programId || !key) return { ok: true, data: { skipped: true } }
      let draft = null
      if (dim === 'crawl' && ['not_crawled', 'failed', 'uncrawled'].includes(mark)) {
        draft = { program_id: programId, kind: 'crawl', host: key.split('|')[0] }
      } else if (dim === 'param' && ['no_params', 'missing', 'unenriched'].includes(mark)) {
        const [host, ...rest] = key.split('|')
        draft = { program_id: programId, kind: 'param_enrich', host, path: rest.join('|') || '' }
      }
      if (!draft) return { ok: true, data: { skipped: true, reason: `${dim}=${mark} 非可派生缺口态` } }
      try {
        const r = await dispatchRef('task', 'derive_intent', draft, { actor: 'reactor', cause: envelope })
        return { ok: true, data: { skipped: false, derived: !!(r && r.ok && !r.data?.deduped), deduped: !!(r && r.ok && r.data?.deduped), code: r && !r.ok ? r.error?.code : null } }
      } catch (e) {
        log(`覆盖缺口派生失败（best-effort）: ${e?.message}`)
        return { ok: true, data: { skipped: false, error: String(e?.message) } }
      }
    },

    // 21 号方案 §6.3：verdict 回写命中矩阵——rejected 连败 +1（≥3 拉黑）；后续 verified 由 capsule 通道清零
    onStrategyOutcome: async (envelope) => {
      const p = envelope?.payload || {}
      const key = String(p.strategy_key || '')
      if (!key) return { ok: true, data: { skipped: true } }
      try {
        const repo = backendRepoRef ? backendRepoRef() : null
        if (!repo || !repo.markStrategyOutcome) return { ok: true, data: { skipped: false, error: 'no repo' } }
        repo.markStrategyOutcome(key, false, null)
        return { ok: true, data: { skipped: false } }
      } catch (e) {
        log(`strategy 连败回写失败（best-effort）: ${e?.message}`)
        return { ok: true, data: { skipped: false, error: String(e?.message) } }
      }
    },

    // 22 号方案 §7.6/§9.2：Reviewer——campaign 子任务收尾即验收（强联动，进 outbox 重试链）
    onCampaignTaskFinished: async (envelope) => {
      const p = envelope?.payload || {}
      if (!p.campaign_id || !p.task_id) return { ok: true, data: { skipped: true, reason: 'not a campaign task' } }
      if (!dispatchRef || !queryRef) return { ok: true, data: { skipped: true } }
      try {
        const g = await queryRef('task', 'get', { task_id: p.task_id }, { actor: 'reactor' })
        const t = (g && g.ok && g.data) ? g.data : null
        if (!t) return { ok: true, data: { skipped: true, reason: 'task not found' } }
        const runs = await queryRef('task', 'runs', { task_id: p.task_id, limit: 1 }, { actor: 'reactor' })
        const rows = runs ? (runs.rows || (runs.data && runs.data.rows) || []) : []
        const run = rows[0] || null
        const sig = await gatherReviewSignals(t, run)
        const verdict = campaignVerdict(t, run, sig)
        const evidence = reviewEvidence(t, run, sig, verdict)
        const goal_delta = makeGoalDelta(t, verdict, run, sig)
        if (p.spent_tokens != null) goal_delta.spent_tokens = Number(p.spent_tokens) || 0
        const r = await dispatchRef('task', 'campaign_record_decision', {
          campaign_id: Number(p.campaign_id), task_id: Number(t.id), verdict, evidence, goal_delta, decided_by: 'reviewer',
        }, { actor: 'reactor', cause: envelope })
        if (r && !r.ok && r.error && r.error.code === 'E_CAMPAIGN_REVIEWED') return { ok: true, data: { skipped: true, reason: 'already reviewed' } }
        if (r && !r.ok) return { ok: false, error: r.error }
        try { const repo = backendRepoRef ? backendRepoRef() : null; if (repo) applyReviewOutcome(repo, t, verdict) } catch { /* best-effort */ }
        return { ok: true, data: { skipped: false, verdict, decision_id: r?.data?.decision_id ?? null } }
      } catch (e) {
        return { ok: false, error: { code: e?.code || 'E_INTERNAL', message: String(e?.message || e) } }
      }
    },

    // 22 号方案 §7.5/§9.2：Supervisor 授权漂移——命中绑定 program 立即 pause（fail-closed）
    onScopeChanged: async (envelope) => {
      const p = envelope?.payload || {}
      const isRevoke = envelope?.name === 'scope.revoked'
      // rules.changed 仅当降级 max_risk（收紧授权）才算漂移；工具白名单等变更不触发暂停
      if (!isRevoke) {
        const patch = (p && p.patch) || {}
        if (patch.max_risk === undefined) return { ok: true, data: { skipped: true, reason: 'non-restrictive rules change' } }
      }
      const repo = backendRepoRef ? backendRepoRef() : null
      if (!repo || !dispatchRef) return { ok: true, data: { skipped: true } }
      const program = String(p.program_name || p.program || p.subject || '')
      const affected = []
      let campaigns = []
      try { campaigns = repo.listCampaignsWhere({ status: 'active' }, 200, 0).concat(repo.listCampaignsWhere({ status: 'reviewing' }, 200, 0)) } catch { campaigns = [] }
      for (const row of campaigns) {
        const c = parseCampaign(row)
        if (program && !c.program_ids.includes(program)) continue
        try {
          if (c.status === 'active') await dispatchRef('task', 'campaign_pause', { campaign_id: c.id, note: `授权漂移：${program || 'scope 变更'}` }, { actor: 'reactor', cause: envelope })
          await dispatchRef('task', 'campaign_checkpoint', { campaign_id: c.id, kind: 'escalation', summary: `授权漂移触发暂停：program ${program || '(scope 变更)'}（fail-closed）`, payload: { program, event: envelope?.name } }, { actor: 'reactor', cause: envelope })
          affected.push(c.id)
        } catch (e) { log(`scope 漂移暂停专项 #${c.id} 失败: ${e?.message}`) }
      }
      return { ok: true, data: { skipped: false, paused: affected } }
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
    if (!claimed.length) { await campaignTick(); await dailyVaultSync(); return }
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
    await campaignTick()
    await dailyVaultSync()
  }

  // 22 号方案 §6.4：campaign tick 段（同一调度器单例持锁者；claim 之后顺带驱动）。
  // 组件异常已隔离到各 campaign（campaign_tick handler 内），此处只兜底日志。
  async function campaignTick() {
    try {
      const r = await dispatch('task', 'campaign_tick', {}, { actor: 'scheduler' })
      if (_ok(r) && r.data) {
        const acted = (r.data.summaries || []).filter((s) => (s.reviewed || 0) + (s.derived || 0) + (s.escalated || 0) > 0)
        if (acted.length) log(`campaign tick：处理 ${r.data.processed} 专项，${acted.length} 个有动作`)
      } else if (!_ok(r)) {
        log(`campaign tick 未成功: ${_errCode(r)} ${_errMsg(r)}`)
      }
    } catch (e) { log(`campaign tick 异常: ${e?.message}`) }
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
  const baseBackend = createTaskSqliteBackend(opts.backendOptions || {})
  // repo 实例缓存：总线经 entry.backend.factory(db) 实例化 repo，此处包装以便订阅者（无 db）复用。
  const state = { repo: null }
  const backend = {
    capabilities: baseBackend.capabilities || {},
    factory(db) { const r = baseBackend.factory(db); state.repo = r; return r },
  }
  return {
    manifest: TASK_MANIFEST,
    handlers: makeHandlers({ ...opts, dataDir, repoRef: () => state.repo }),
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
