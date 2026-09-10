// ==============================================================================
// @silksec/sec-domain-approval — SilkSecAgent approval 域插件（v5 Phase 2.6：统一审批中心 / kind 注册表 / effect outbox）
//
// 契约：doc/secagent/v5/09-approval.md（域设计，权威）+ 01-bus.md（总线）+ 00-conventions.md（宪法）
//
// 对外（cordis）：name='sec-domain-approval'，apply() 把 manifest+handlers+backend 交给
// 总线 registry.register()（不 provide 任何业务方法）。
//
// 语义要点：
//  - 批准的唯一副作用 = 提交 decision + effect outbox + 发布 approval.approved（不直写任何他域数据）；
//  - effect 幂等执行：decide 事务内同步 dispatch 各域命令（scope_grant / scope_rules_apply /
//    task_budget_extend / task_complete / know_adopt），每条 effect 有唯一 effect_key + 订阅方幂等兜底；
//  - 状态机列仅 pending/approved/rejected（SQLite 无法 ALTER CHECK，09 §1.3.3）；effect 成败记 approval_effects；
//  - 提请不改变 fail-closed：approval 域 commands 不 dispatch 任何其他域命令（除 decide 的 effect 执行）。
// ==============================================================================

import * as crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

export const name = 'sec-domain-approval'
export const version = '1.0.0'

const DEFAULT_DATA_DIR = process.env.SEC_DATA_DIR || '/opt/silkspool/dsh/data'

const log = (msg) => { try { process.stderr.write(`[sec-domain-approval] ${msg}\n`) } catch { /* noop */ } }

const backendUrl = new URL('../sec-backend-approval-sqlite/index.js', import.meta.url)
const { createApprovalSqliteBackend } = await import(backendUrl.href)

function sha1(str) { return crypto.createHash('sha1').update(String(str)).digest('hex') }
function canonicalize(obj) {
  const norm = (v) => {
    if (v === null || typeof v !== 'object') return v
    if (Array.isArray(v)) return v.map(norm)
    const out = {}
    for (const k of Object.keys(v).sort()) out[k] = norm(v[k])
    return out
  }
  return JSON.stringify(norm(obj))
}

// ---------------------------------------------------------------------------
// 目标归一化（审批 validate 用；与 scope 域同语义）
// ---------------------------------------------------------------------------

function hostOf(raw) {
  let s = String(raw).trim()
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
  s = s.split('/')[0].split('?')[0].split('#')[0]
  if (s.startsWith('[')) { const end = s.indexOf(']'); if (end > 0) return s.slice(1, end).toLowerCase() }
  if (s.includes(':') && /:\d+$/.test(s)) s = s.slice(0, s.lastIndexOf(':'))
  return s.toLowerCase()
}
const CC_SLD = new Set(['com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au', 'co.jp', 'ne.jp', 'or.jp', 'co.in', 'net.in', 'org.in', 'com.br', 'com.mx', 'com.tw', 'com.hk', 'com.sg', 'co.nz', 'co.kr'])
function hostRoot(host) {
  const parts = String(host).toLowerCase().split('.')
  if (parts.length <= 2) return String(host).toLowerCase()
  const last2 = parts.slice(-2).join('.')
  if (CC_SLD.has(last2) && parts.length >= 3) return parts.slice(-3).join('.')
  return parts.slice(-2).join('.')
}

// ---------------------------------------------------------------------------
// kind 注册表（09 §2.2.2；v4 APPROVAL_KINDS 迁移，validate + effect 映射）
// ---------------------------------------------------------------------------

export const APPROVAL_KINDS = {
  'scope-wildcard': {
    label: '整域授权(通配)',
    request_actors: ['model'],
    validate: async (subject, args, payload, deps) => {
      const host = hostOf(subject)
      if (!host) return { code: 'E_INVARIANT', message: `subject 无法解析: ${subject}`, hint: 'subject 必须是可解析的域名' }
      if (hostRoot(host) !== host) return { code: 'E_INVARIANT', message: `${subject} 是子域，不是裸 apex`, hint: '整域授权 subject 必须是裸 apex 注册域；单个子域请改提 scope-domain' }
      const eq = args.equity_basis
      if (!['控股/全资', '收购/财团'].includes(eq)) return { code: 'E_INVARIANT', message: `equity_basis=${eq} 不足以开整域`, hint: '整域授权 equity_basis 仅限 控股/全资 或 收购/财团（品牌/产品线/技术印证不足）' }
      if (args.independent_src === '有') return { code: 'E_INVARIANT', message: 'independent_src=有 不并入', hint: '有自身 SRC 渠道的项目不并入（H-004）' }
      if (String(args.evidence || '').length < 30) return { code: 'E_INVARIANT', message: 'evidence 不足 30 字', hint: '整域授权须主体核证级证据（ICP 备案主体/收购公告/SRC 规则页明示），≥30 字' }
      if (deps.programExists(args.program_name)) {
        const chk = await deps.scopeCheck(host)
        if (chk && chk.allow) return { code: 'E_INVARIANT', message: `${subject} 已在授权范围（项目 ${chk.program}）`, hint: '无须审批——已授权' }
      }
      return null
    },
    effects: (requestId, subject, args, payload) => [
      { domain: 'scope', verb: 'grant', payload: { program_name: args.program_name, entries: [`*.${subject}`, subject], request_id: requestId } },
    ],
  },
  'scope-domain': {
    label: '授权域名',
    request_actors: ['model'],
    validate: async (subject, args, payload, deps) => {
      const host = hostOf(subject)
      if (!host) return { code: 'E_INVARIANT', message: `subject 无法解析: ${subject}`, hint: 'subject 必须是可解析的域名' }
      if (hostRoot(host) === host) return { code: 'E_INVARIANT', message: `${subject} 是裸 apex，走整域通道`, hint: '裸 apex 请改提 scope-wildcard（防逐子域提审批口径缺口）' }
      if (!args.equity_basis) return { code: 'E_INVARIANT', message: '缺 equity_basis', hint: '单域授权须带股权判据 equity_basis' }
      if (!args.independent_src) return { code: 'E_INVARIANT', message: '缺 independent_src', hint: '须声明 independent_src（无/有/不确定）' }
      if (String(args.evidence || '').length < 30) return { code: 'E_INVARIANT', message: 'evidence 不足 30 字', hint: '单域授权须 ≥30 字且含具体归属证据（CNAME/内容同源/主体核证）' }
      if (deps.programExists(args.program_name)) {
        const chk = await deps.scopeCheck(host)
        if (chk && chk.allow) return { code: 'E_INVARIANT', message: `${subject} 已在授权范围（项目 ${chk.program}）`, hint: '无须审批——已授权' }
        if (chk && chk.excluded_by) return { code: 'E_INVARIANT', message: `${subject} 命中排除清单`, hint: '该目标在项目排除清单中——请改提 exclude-exception' }
      }
      return null
    },
    effects: (requestId, subject, args, payload) => [
      { domain: 'scope', verb: 'grant', payload: { program_name: args.program_name, entries: [subject], request_id: requestId } },
    ],
  },
  'exclude-exception': {
    label: '排除例外',
    request_actors: ['model'],
    validate: async (subject, args, payload, deps) => {
      const host = hostOf(subject)
      if (!host) return { code: 'E_INVARIANT', message: `subject 无法解析: ${subject}`, hint: 'subject 必须是可解析的域名' }
      if (!args.program_name) return { code: 'E_INVARIANT', message: '缺 program_name', hint: '排除例外须指明项目' }
      if (!args.equity_basis) return { code: 'E_INVARIANT', message: '缺 equity_basis', hint: '解除排除须给出比 scope-domain 更强的归属证据' }
      const inExclude = deps.inExclude(args.program_name, host)
      if (!inExclude) return { code: 'E_INVARIANT', message: `${subject} 不在项目排除清单中`, hint: '该目标不在排除清单——请改提 scope-domain' }
      return null
    },
    effects: (requestId, subject, args, payload) => [
      { domain: 'scope', verb: 'grant', payload: { program_name: args.program_name, entries: [subject], request_id: requestId } },
    ],
  },
  'tool-intrusive': {
    label: '侵入工具放行',
    request_actors: ['system', 'model'],
    validate: async (subject, args, payload, deps) => {
      const tool = payload && payload.tool
      if (!tool || !String(tool).trim()) return { code: 'E_INVARIANT', message: 'payload.tool 缺失', hint: 'tool-intrusive 须携带 payload.tool' }
      const params = payload && payload.params
      if (params && typeof params === 'object') {
        for (const v of Object.values(params)) {
          const s = String(v)
          if (s.length > 200) return { code: 'E_INVARIANT', message: 'payload.params 含超长值（疑似未脱敏）', hint: 'params 须脱敏为短标量（≤60 字或带截断标记）' }
          if (/Bearer\s/i.test(s) || /[A-Za-z0-9+/]{40,}={0,2}/.test(s)) return { code: 'E_INVARIANT', message: 'payload.params 含凭据特征', hint: '脱敏责任在提请方（exec 守卫）' }
        }
      }
      return null
    },
    effects: (requestId, subject, args, payload) => {
      const program = payload.program || args.program_name
      return [{ domain: 'scope', verb: 'rules_apply', payload: { target: 'program', program_name: program, allow_intrusive_tools_add: [payload.tool] } }]
    },
  },
  'task-budget-extend': {
    label: '任务预算延长',
    request_actors: ['scheduler'],
    validate: async (subject, args, payload, deps) => {
      const taskId = Number(payload && payload.task_id)
      if (!Number.isInteger(taskId) || taskId <= 0) return { code: 'E_INVARIANT', message: 'payload.task_id 缺失', hint: 'task-budget-extend 须携带 payload.task_id' }
      const budget = Number((payload && payload.budget_timeout_sec) ?? 7200)
      if (!(budget >= 1 && budget <= 7200)) return { code: 'E_INVARIANT', message: `budget_timeout_sec=${budget} 越界`, hint: '预算延长封顶 7200s' }
      const t = await deps.taskGet(taskId)
      if (t === 'unavailable') return null
      if (!t) return { code: 'E_INVARIANT', message: `task 不存在: ${taskId}`, hint: '核对 task_list' }
      return null
    },
    effects: (requestId, subject, args, payload) => {
      const budget = Number((payload && payload.budget_timeout_sec) ?? 7200)
      return [{ domain: 'task', verb: 'budget_extend', payload: { task_id: Number(payload.task_id), budget_timeout_sec: budget, approval_id: requestId } }]
    },
  },
  'knowledge-adopt': {
    label: '知识采纳',
    request_actors: ['model'],
    validate: async (subject, args, payload, deps) => {
      if (String(subject).length < 8) return { code: 'E_INVARIANT', message: 'subject 不足 8 字', hint: '经验卡 scenario 一句话 ≥8 字' }
      const draft = args.draft || (payload && payload.draft) || ''
      const cardId = args.card_id ?? (payload && payload.card_id) ?? null
      if (cardId == null && String(draft).length < 50) return { code: 'E_INVARIANT', message: 'draft 不足 50 字', hint: '无 card_id 时 draft 须 ≥50 字（蒸馏后可迁移模式）' }
      const url = args.source_url || (payload && payload.source_url) || ''
      if (!/^https?:\/\/\S{4,}$/.test(String(url))) return { code: 'E_INVARIANT', message: 'source_url 非法', hint: '外部知识须可溯源（http(s) 完整 URL）' }
      if (String(args.evidence || '').length < 30) return { code: 'E_INVARIANT', message: 'evidence 不足 30 字', hint: '说明为什么值得采纳（覆盖哪个缺口/案例支撑/与现有卡差异）' }
      return null
    },
    effects: (requestId, subject, args, payload) => {
      const cardId = args.card_id ?? (payload && payload.card_id) ?? null
      const draft = args.draft || (payload && payload.draft) || ''
      const url = args.source_url || (payload && payload.source_url) || ''
      return [{ domain: 'know', verb: 'adopt', payload: { target: 'exp', payload: { id: cardId ?? null, draft, source_url: url }, evidence: args.evidence } }]
    },
  },
  'task-complete': {
    label: '任务完成确认',
    request_actors: ['model', 'scheduler'],
    validate: async (subject, args, payload, deps) => {
      const taskId = Number(payload && payload.task_id)
      if (!Number.isInteger(taskId) || taskId <= 0) return { code: 'E_INVARIANT', message: 'payload.task_id 缺失', hint: 'task-complete 须携带 payload.task_id' }
      const summary = String(payload && payload.summary || args.evidence || '')
      if (summary.length < 30) return { code: 'E_INVARIANT', message: 'summary 不足 30 字', hint: '说明做了什么/结论' }
      const t = await deps.taskGet(taskId)
      if (t === 'unavailable') return null
      if (!t) return { code: 'E_INVARIANT', message: `task 不存在: ${taskId}`, hint: '核对 task_list' }
      if (['done', 'failed', 'cancelled'].includes(t.status)) return { code: 'E_INVARIANT', message: `task #${taskId} 已终态（${t.status}）`, hint: '终态任务无需再声明完成' }
      return null
    },
    effects: (requestId, subject, args, payload) => {
      const summary = String(payload && payload.summary || args.evidence || '')
      return [{ domain: 'task', verb: 'complete', payload: { task_id: Number(payload.task_id), request_id: requestId, summary } }]
    },
  },
}

// ---------------------------------------------------------------------------
// manifest（09 §1.2/§1.3/§1.4/§1.5 的机器形态）
// ---------------------------------------------------------------------------

const schema = (properties, required, extra = {}) => ({ type: 'object', properties, required, additionalProperties: false, ...extra })
const str = (opts = {}) => ({ type: 'string', ...opts })
const en = (values, extra = {}) => ({ type: 'string', enum: values, ...extra })
const int = (opts = {}) => ({ type: 'integer', ...opts })

const ALL_KINDS = Object.keys(APPROVAL_KINDS)

export const APPROVAL_MANIFEST = {
  domain: 'approval',
  version: 1,
  service: 'secDomain.approval',
  description: '统一审批中心：人工放行请求账本（kind 注册表校验判据 + pending 去重 + effect outbox）。批准唯一副作用 = 发布 approval.approved 事件',
  owns: {
    tables: ['approval_requests', 'approval_effects'],
    files: ['data/events/approval.jsonl'],
  },
  commands: {
    approval_request: {
      actor: ['model', 'script', 'system', 'scheduler'],
      schema: schema({
        kind: en(ALL_KINDS),
        subject: str({ minLength: 1, maxLength: 500 }),
        program_name: str(),
        evidence: str({ minLength: 1 }),
        payload: { type: 'object' },
        equity_basis: en(['控股/全资', '收购/财团', '品牌/产品线', '技术印证', '其他']),
        independent_src: en(['无', '有', '不确定']),
        corroboration: str({ maxLength: 500 }),
        card_id: int(),
        draft: str(),
        source_url: str(),
      }, ['kind', 'subject', 'evidence']),
      idempotent: 'auto',
      idempotent_fields: ['kind', 'subject', 'program_name', 'evidence', 'payload', 'equity_basis', 'independent_src', 'corroboration', 'card_id', 'draft', 'source_url'],
      events: ['approval.requested'],
      event_limit: 1,
      invariants: ['kindValidate'],
      timeout_ms: 60000,
      agent_note: '统一审批入口（fail-closed 之下的正规放行通道）：向人工提请审批。整域用 scope-wildcard、单子域用 scope-domain、被排除资产用 exclude-exception、外部经验蒸馏用 knowledge-adopt（card_id/draft≥50/source_url）。批准前目标仍被 scope-guard 拒绝。',
      deprecated: false,
    },
    approval_decide: {
      actor: ['dashboard', 'human'],
      schema: schema({
        id: int(),
        decision: en(['approve', 'reject']),
        note: str({ maxLength: 2000 }),
        operator: str(),
      }, ['id', 'decision']),
      idempotent: 'auto',
      idempotent_fields: ['id', 'decision', 'note'],
      events: ['approval.approved', 'approval.rejected'],
      event_limit: 1,
      invariants: ['decideValid'],
      timeout_ms: 60000,
      agent_note: '人工裁决 pending → approved/rejected（operator 从 auth-gate 注入）。批准副作用 = 提交 decision + effect outbox + 发 approval.approved（各域订阅执行）。model 不可用。',
      deprecated: false,
    },
    approval_withdraw: {
      actor: ['model', 'human'],
      schema: schema({
        id: int(),
        reason: str({ maxLength: 500 }),
      }, ['id']),
      idempotent: 'auto',
      idempotent_fields: ['id', 'reason'],
      events: ['approval.rejected'],
      event_limit: 1,
      invariants: ['withdrawValid'],
      timeout_ms: 60000,
      agent_note: '撤回自己提请的 pending 审批（提错对象/判据填错时自查自救）。只能撤回 requested_by 为自己会话的请求。',
      deprecated: false,
    },
  },
  queries: {
    approval_list: {
      actor: ['model', 'dashboard', 'human'],
      params: schema({
        kind: str({ default: '' }),
        status: str({ default: '' }),
        limit: int({ minimum: 1, maximum: 500 }),
        offset: int({ minimum: 0 }),
      }, []),
      agent_note: '查询审批请求（pending 恒在最前；可按 kind/status 筛选）。查看自己提请的请求状态、判据是否被驳回及原因。',
    },
    approval_stats: {
      actor: ['dashboard', 'human'],
      params: schema({ since_days: int({ minimum: 1, maximum: 365 }) }, []),
      agent_note: '审批统计（按 kind 聚合 + pending 总数/最老 + 裁决耗时 + 按裁决人）。看板审批 tab 头部统计条数据源。',
    },
    approval_reconcile: {
      actor: ['dashboard', 'human', 'script'],
      params: schema({ request_id: int() }, ['request_id']),
      agent_note: '对账查询：对照 approval_effects 账本与目标域现状，输出未 applied/漂移的 effect 清单。人工可据此补跑或重试。',
    },
  },
  events: {
    'approval.requested': { payload: { type: 'object' }, redact: [] },
    'approval.approved': { payload: { type: 'object' }, redact: [] },
    'approval.rejected': { payload: { type: 'object' }, redact: [] },
  },
  subscribes: {},
  backend: 'repository-v1',
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

  async function qTry(domain, name, args) {
    if (!queryRef) return { ok: false, unavailable: true }
    try { return await queryRef(domain, name, args, { actor: 'approval' }) } catch { return { ok: false, unavailable: true } }
  }

  // 跨域只读 deps（validate 用）：scope 读 scope_list/scope_check，task 读 task_get，know 读 harvest_status
  function buildDeps() {
    let scopeListCache = null
    async function scopeData() {
      if (scopeListCache) return scopeListCache
      const r = await qTry('scope', 'list', {})
      scopeListCache = (r && r.ok && r.data) ? r.data : { programs: [], defaults: {} }
      return scopeListCache
    }
    return {
      programExists: (name) => {
        const d = scopeListCache
        if (!d) return false
        return (d.programs || []).some((p) => p.name === name)
      },
      async scopeCheck(host) {
        const r = await qTry('scope', 'check', { target: host })
        return (r && r.ok) ? r.data : null
      },
      inExclude: (name, host) => {
        const d = scopeListCache
        if (!d) return false
        const p = (d.programs || []).find((x) => x.name === name)
        if (!p) return false
        return (p.exclude || []).some((e) => entryMatchesLite(e, host))
      },
      async taskGet(id) {
        const r = await qTry('task', 'get', { task_id: Number(id) })
        if (!r || !r.ok) return 'unavailable'
        return r.data || null
      },
      async prime() { await scopeData() },
    }
  }

  function entryMatchesLite(entry, host) {
    entry = String(entry).trim().toLowerCase(); host = String(host).trim().toLowerCase()
    if (!entry || !host) return false
    if (entry.includes('/')) return false
    if (entry.startsWith('*.')) { const suffix = entry.slice(1); return host === entry.slice(2) || host.endsWith(suffix) }
    return host === entry
  }

  function assemblePayload(kind, args) {
    if (args.payload && typeof args.payload === 'object' && Object.keys(args.payload).length) return { ...args.payload }
    switch (kind) {
      case 'scope-wildcard': return { equity_basis: args.equity_basis, independent_src: args.independent_src, domain_level: 'apex', corroboration: args.corroboration || null }
      case 'scope-domain': return { equity_basis: args.equity_basis, independent_src: args.independent_src, domain_level: 'subdomain', corroboration: args.corroboration || null }
      case 'exclude-exception': return { equity_basis: args.equity_basis }
      case 'knowledge-adopt': return { card_id: args.card_id ?? null, draft: args.draft || '', source_url: args.source_url || '' }
      default: return {}
    }
  }

  function deriveRequestedBy(kind, args, ctx) {
    const actor = ctx.actor || 'model'
    if (actor === 'scheduler') return 'scheduler:auto'
    if (actor === 'system') {
      const src = (args.payload && (args.payload.source || args.payload.guard)) || 'system'
      return `exec-guard:${src}`
    }
    return ctx.session_id || actor
  }

  const invariants = {
    kindValidate: async (args, repo, ctx) => {
      const kind = APPROVAL_KINDS[args.kind]
      if (!kind) return { code: 'E_SCHEMA', message: `kind 非法: ${args.kind}`, hint: `合法 kind: [${ALL_KINDS.join(', ')}]`, retryable: false }
      const actor = ctx.actor || 'model'
      if (!kind.request_actors.includes(actor)) {
        return { code: 'E_APPROVAL_KIND_ACTOR', message: `actor=${actor} 不可提 ${args.kind}`, hint: `该 kind 只由 [${kind.request_actors.join(', ')}] 接线点自动提请`, retryable: false }
      }
      const dup = repo.findPending(args.kind, args.subject)
      if (dup) return { code: 'E_APPROVAL_PENDING_EXISTS', message: `同对象已有待审批请求 #${dup.id}`, hint: '勿重复提请，可等决策或补充证据后在新请求中体现', retryable: false }
      if (String(args.evidence || '').length < 10) return { code: 'E_SCHEMA', message: 'evidence 不足 10 字', hint: 'evidence 是判据摘要，至少 10 字', retryable: false }
      const payload = assemblePayload(args.kind, args)
      const deps = buildDeps()
      await deps.prime()
      const v = await kind.validate(args.subject, args, payload, deps)
      if (v) return { ...v, retryable: false }
      return null
    },
    decideValid: async (args, repo, ctx) => {
      const row = repo.getRequest(args.id)
      if (!row) return { code: 'E_NOT_FOUND', message: `请求不存在: ${args.id}`, hint: '核对 request_id（approval_list 可查）', retryable: false }
      if (row.status !== 'pending') return { code: 'E_STATE', message: `请求 #${args.id} 已终态（${row.status}）`, hint: '勿重复决策', retryable: false }
      return null
    },
    withdrawValid: async (args, repo, ctx) => {
      const row = repo.getRequest(args.id)
      if (!row) return { code: 'E_NOT_FOUND', message: `请求不存在: ${args.id}`, hint: '核对 request_id', retryable: false }
      if (row.status !== 'pending') return { code: 'E_STATE', message: `请求 #${args.id} 已终态（${row.status}）`, hint: '非 pending 不可撤回', retryable: false }
      if ((ctx.actor || 'model') === 'model' && row.requested_by !== ctx.session_id) {
        return { code: 'E_APPROVAL_WITHDRAW_FORBIDDEN', message: '只能撤回自己提请的请求', hint: '他人请求请等待人工裁决', retryable: false }
      }
      return null
    },
  }

  async function executeEffects(repo, requestId, kind, subject, args, payload) {
    const defs = kind.effects(requestId, subject, args, payload)
    const results = []
    let anyFailed = false
    for (const ef of defs) {
      const effectKey = `${requestId}:${ef.domain}:${ef.verb}:${sha1(canonicalize(ef.payload)).slice(0, 16)}`
      repo.insertEffect({ request_id: requestId, effect_key: effectKey, domain: ef.domain, verb: ef.verb, payload: ef.payload })
      let r = null
      try {
        r = await dispatchRef(ef.domain, ef.verb, ef.payload, { actor: 'approval' })
      } catch (e) {
        r = { ok: false, error: { code: e?.code || 'E_INTERNAL', message: e?.message || String(e) } }
      }
      if (r && r.ok) {
        repo.markEffect(effectKey, { status: 'applied' })
        results.push({ effect_key: effectKey, domain: ef.domain, verb: ef.verb, status: 'applied' })
      } else {
        anyFailed = true
        const msg = r?.error?.message || 'unknown'
        repo.markEffect(effectKey, { status: 'failed', last_error: msg })
        results.push({ effect_key: effectKey, domain: ef.domain, verb: ef.verb, status: 'failed', error: msg })
      }
    }
    return { results, anyFailed }
  }

  function effectSummary(kind, subject, args, payload, results) {
    const applied = results.filter((r) => r.status === 'applied')
    const failed = results.filter((r) => r.status === 'failed')
    let s = ''
    if (kind && kind.label) {
      if (subject) s += `${kind.label} ${subject}`
      if (results.length) {
        const parts = applied.map((r) => r.verb)
        if (parts.length) s += `（已执行 ${parts.join(', ')}）`
        if (failed.length) s += `（失败 ${failed.length} 条，见审批对账）`
      }
    }
    return s || '已批准'
  }

  const commands = {
    approval_request: async (args, repo, ctx) => {
      const kind = APPROVAL_KINDS[args.kind]
      const payload = assemblePayload(args.kind, args)
      const requestedBy = deriveRequestedBy(args.kind, args, ctx)
      const id = repo.insertRequest({
        kind: args.kind, subject: args.subject, program_name: args.program_name || null,
        payload, evidence: args.evidence, requested_by: requestedBy,
      })
      return {
        data: {
          request_id: id, kind: args.kind, subject: args.subject, status: 'pending',
          payload, hint: '已提请人工审批（看板「审批」tab）。批准前目标仍被 fail-closed 拒绝，不要尝试打点。',
        },
        events: [{ name: 'approval.requested', payload: { request_id: id, kind: args.kind, subject: args.subject, program_name: args.program_name || null, payload, requested_by: requestedBy } }],
        after: { request_id: id, status: 'pending' },
        target: { kind: args.kind, subject: args.subject },
      }
    },

    approval_decide: async (args, repo, ctx) => {
      const row = repo.getRequest(args.id)
      const operator = args.operator || ctx.operator || ''
      const now = Date.now()
      const payload = row.payload || {}

      if (args.decision === 'reject') {
        repo.decideRequest(args.id, { status: 'rejected', decided_at: now, note: args.note || null })
        return {
          data: { request_id: args.id, kind: row.kind, subject: row.subject, status: 'rejected', operator },
          events: [{ name: 'approval.rejected', payload: { request_id: args.id, kind: row.kind, subject: row.subject, program_name: row.program_name || null, payload, evidence: row.evidence, operator, note: args.note || null, withdrawn: false } }],
          after: { request_id: args.id, status: 'rejected' },
          target: { request_id: args.id, decision: 'reject' },
        }
      }

      const kind = APPROVAL_KINDS[row.kind]
      repo.decideRequest(args.id, { status: 'approved', decided_at: now, note: args.note || null })
      const { results, anyFailed } = kind
        ? await executeEffects(repo, args.id, kind, row.subject, { program_name: row.program_name || '', evidence: row.evidence, equity_basis: null, independent_src: null, corroboration: null, card_id: null, draft: null, source_url: null, payload }, payload)
        : { results: [], anyFailed: false }
      const summary = effectSummary(kind, row.subject, args, payload, results)
      const finalNote = [args.note, summary].filter(Boolean).join(' | ')
      repo.setNote(args.id, finalNote)
      const status = anyFailed ? 'approved_effect_failed' : 'approved'
      return {
        data: {
          request_id: args.id, kind: row.kind, subject: row.subject, status, operator,
          effects: results, effect: summary,
        },
        events: [{
          name: 'approval.approved',
          payload: {
            request_id: args.id, kind: row.kind, subject: row.subject,
            program_name: row.program_name || null, program_id: row.program_name || null,
            payload, evidence: row.evidence, operator, note: args.note || null,
          },
        }],
        after: { request_id: args.id, status, effects: results.map((r) => r.status) },
        target: { request_id: args.id, decision: 'approve' },
      }
    },

    approval_withdraw: async (args, repo) => {
      const row = repo.getRequest(args.id)
      const now = Date.now()
      const note = '[已撤回]' + (args.reason ? ' ' + args.reason : '')
      repo.decideRequest(args.id, { status: 'rejected', decided_at: now, note })
      return {
        data: { request_id: args.id, status: 'rejected', withdrawn: true },
        events: [{ name: 'approval.rejected', payload: { request_id: args.id, kind: row.kind, subject: row.subject, program_name: row.program_name || null, payload: row.payload, evidence: row.evidence, operator: null, note, withdrawn: true } }],
        after: { request_id: args.id, status: 'rejected', withdrawn: true },
        target: { request_id: args.id },
      }
    },
  }

  const queries = {
    approval_list: async (args, repo) => {
      const { rows, total } = repo.listRequestsWhere({ kind: args.kind || '', status: args.status || '', limit: args.limit, offset: args.offset })
      return { rows: rows.map((r) => ({ id: r.id, kind: r.kind, subject: r.subject, program_name: r.program_name, payload: r.payload, evidence: r.evidence, status: r.status, requested_by: r.requested_by, created_at: r.created_at, decided_at: r.decided_at, note: r.note })), total }
    },
    approval_stats: async (args, repo) => {
      const sinceDays = Number(args.since_days ?? 30)
      const sinceTs = Date.now() - sinceDays * 86400000
      const { byKind, rows } = repo.statsSince(sinceTs)
      let pendingTotal = 0
      let pendingOldest = null
      const byDecider = {}
      for (const r of rows) {
        if (r.status === 'pending') { pendingTotal++; if (pendingOldest === null || r.created_at < pendingOldest) pendingOldest = r.created_at }
        else if (r.status === 'approved' || r.status === 'rejected') {
          const op = r.note || ''
          // by_decider 靠 note 无从可靠区分，聚合为空；此处保持结构（operator 在决定时已拼入 note）
        }
      }
      return {
        by_kind: byKind,
        pending_total: pendingTotal,
        pending_oldest_days: pendingOldest ? Math.round(((Date.now() - pendingOldest) / 86400000) * 10) / 10 : 0,
        avg_decide_hours: 0,
        by_decider: [],
      }
    },
    approval_reconcile: async (args, repo) => {
      const row = repo.getRequest(args.request_id)
      if (!row) throwErr('E_NOT_FOUND', `请求不存在: ${args.request_id}`, '核对 request_id', false)
      const effects = repo.listEffects(args.request_id).map((e) => ({ effect_key: e.effect_key, domain: e.domain, verb: e.verb, status: e.status, attempt: e.attempt, last_error: e.last_error }))
      const drift = effects.filter((e) => e.status !== 'applied')
      return { decision_status: row.status, effects, drift }
    },
  }

  return { ...commands, queries, invariants, subscribers: {} }
}

// ---------------------------------------------------------------------------
// 组装
// ---------------------------------------------------------------------------

export function buildApprovalDomain(opts = {}) {
  const dataDir = opts.dataDir || DEFAULT_DATA_DIR
  const backend = createApprovalSqliteBackend(opts.backendOptions || {})
  return {
    manifest: APPROVAL_MANIFEST,
    handlers: makeHandlers({ ...opts, dataDir }),
    backend,
  }
}

export function apply(ctx, config = {}) {
  const dataDir = process.env.SEC_DATA_DIR || process.env.DSH_HOME || DEFAULT_DATA_DIR
  try {
    ctx.inject(['secDomainBus'], (child) => {
      const bus = child.secDomainBus
      const domain = buildApprovalDomain({
        dataDir,
        dispatch: (d, v, a, c) => bus.dispatch(d, v, a, c),
        query: (d, n, a, c) => bus.query(d, n, a, c),
      })
      const res = bus.registry.register(domain)
      if (res.ok) log(`approval 域注册成功（registered=${res.registered}）`)
      else log(`approval 域注册被拒：${res.error?.code} ${res.error?.message}`)
      return () => {}
    })
  } catch (e) {
    log(`secDomainBus 注入失败：${e?.message}——approval 域未注册（总线必须先行挂载）`)
  }
  return null
}
