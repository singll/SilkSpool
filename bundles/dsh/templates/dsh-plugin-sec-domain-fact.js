// ==============================================================================
// @silksec/sec-domain-fact — SilkSecAgent fact 域插件（v5 Phase 2：事实图谱 + 黑板环境层 + 负知识）
//
// 契约：doc/secagent/v5/06-fact.md（域设计，权威）+ 01-bus.md（总线）+ 00-conventions.md（宪法）
//
// 对外（cordis）：name='sec-domain-fact'，apply() 把 manifest+handlers+backend 交给
// 总线 registry.register()（不 provide 任何业务方法——防绕过核心承诺）。
//
// 语义要点：
//  - 动词 fact_upsert/fact_correct/fact_deprecate/fact_link/fact_record_validation/
//    fact_bb_publish/fact_transition/fact_record_signal/fact_reindex/fact_purge_archive
//    拆自 v4 asset-db.js 的 factUpsert/factGet/factSearch/factLink/factGraph/factReindexEdges/bbSet/bbGet；
//  - 生命周期列（mem_class/expires_at/revalidate_by/status）由域命令计算，memcore validateWrite 分支归零；
//  - 治理通道 fact_transition 带 to 参数（宪法 §四.1 豁免：system+human、不向模型注册）；
//  - 快照前缀键前置拒绝（INV-F7，替代 v4 sweep 事后转写守卫）；timeline 只追加（INV-F6）；
//  - 订阅 task.finished / fgs.node.done / exec.run.failed / approval.approved（后续域上线后生效）。
//
// 零依赖：node:crypto（sqlite 在总线）
// ==============================================================================

import * as crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

export const name = 'sec-domain-fact'
export const version = '1.0.0'

const DEFAULT_DATA_DIR = process.env.SEC_DATA_DIR || '/opt/silkspool/dsh/data'
const DAY = 86400000

const log = (msg) => { try { process.stderr.write(`[sec-domain-fact] ${msg}\n`) } catch { /* noop */ } }

const backendUrl = new URL('../sec-backend-fact-sqlite/index.js', import.meta.url)
const { createFactSqliteBackend } = await import(backendUrl.href)

// ---------------------------------------------------------------------------
// manifest（06-fact §1.2/§1.4/§1.5 的机器形态）
// ---------------------------------------------------------------------------

const schema = (properties, required, extra = {}) => ({ type: 'object', properties, required, additionalProperties: false, ...extra })
const str = (opts = {}) => ({ type: 'string', ...opts })
const en = (values, extra = {}) => ({ type: 'string', enum: values, ...extra })
const int = (opts = {}) => ({ type: 'integer', ...opts })
const num = (opts = {}) => ({ type: 'number', ...opts })
const bool = () => ({ type: 'boolean' })

const CONFIDENCE = ['confirmed', 'tentative', 'deprecated']
const FACT_MEM_CLASS = ['durable', 'ephemeral', 'timeline']
const BB_MEM_CLASS = ['ephemeral', 'timeline']
const EDGE_TYPES = ['resolves_to', 'hosts', 'exposes', 'depends_on', 'leads_to', 'enables', 'exploits']
const SNAPSHOT_KEY_RE = /^(alive|scan|recon|review|note|todo|plan)[:_]/

export const FACT_MANIFEST = {
  domain: 'fact',
  version: 1,
  service: 'secDomain.fact',
  description: '事实图谱/黑板环境层/负知识（跨会话沉淀的目标事实与生命周期治理，note 类负知识派单前拦截）',
  owns: {
    tables: ['facts', 'fact_edges', 'blackboard', 'facts_archive', 'blackboard_archive'],
    files: ['data/events/fact.jsonl'],
  },
  commands: {
    fact_upsert: {
      actor: ['model', 'dashboard', 'script', 'approval', 'system', 'reactor'],
      schema: schema({
        program_id: str({ minLength: 1 }),
        fact_key: str({ minLength: 1 }),
        category: str({ default: '' }),
        summary: str({ default: '', maxLength: 300 }),
        body: str({ default: '', maxLength: 4000 }),
        confidence: en(CONFIDENCE, { default: 'tentative' }),
        pinned: int({ minimum: 0, maximum: 1 }),
        related_finding_id: int(),
        source: str({ default: '' }),
        mem_class: str(),
        ttl_days: num(),
        revalidate_days: num(),
        justification: str(),
        scope: str(),
      }, ['program_id', 'fact_key']),
      idempotent: 'auto',
      idempotent_fields: ['program_id', 'fact_key', 'category', 'summary', 'body', 'confidence', 'pinned', 'related_finding_id', 'source', 'mem_class', 'ttl_days', 'revalidate_days', 'justification', 'scope'],
      events: ['fact.upserted'],
      event_limit: 1,
      invariants: ['factKeyFormat', 'factMemClassValid', 'factTtlRange', 'factRevalidateRange', 'factSummaryBodyLimits', 'justificationPlaceholder'],
      timeout_ms: 60000,
      agent_note: '写入/覆盖一条事实（跨会话共享，边渗透边记录）。fact_key 格式 category/slug（如 auth/cred-admin）。summary 一行索引会注入 prompt，body 按需 fact_get 拉取。note 类默认 ephemeral 14 天，其余默认 durable 30 天复验；可用 mem_class/ttl_days/revalidate_days/justification 自声明。',
      deprecated: false,
    },
    fact_correct: {
      actor: ['dashboard', 'human'],
      schema: schema({
        program_id: str({ minLength: 1 }),
        fact_key: str({ minLength: 1 }),
        category: str(),
        summary: str({ maxLength: 300 }),
        body: str({ maxLength: 4000 }),
        evidence: str({ minLength: 10 }),
      }, ['program_id', 'fact_key', 'evidence']),
      idempotent: 'natural',
      idempotent_natural: ['program_id', 'fact_key'],
      events: ['fact.upserted'],
      event_limit: 1,
      invariants: ['factExists', 'factNotConfirmed', 'evidenceRequired'],
      timeout_ms: 60000,
      agent_note: '人工纠正确认一条事实：覆盖显式字段并将置信升为 confirmed，必须附 ≥10 字纠正依据。',
      deprecated: false,
    },
    fact_deprecate: {
      actor: ['model', 'dashboard', 'human'],
      schema: schema({
        program_id: str({ minLength: 1 }),
        fact_key: str({ minLength: 1 }),
        reason: str({ minLength: 10 }),
      }, ['program_id', 'fact_key', 'reason']),
      idempotent: 'natural',
      idempotent_natural: ['program_id', 'fact_key'],
      events: ['fact.deprecated'],
      event_limit: 1,
      invariants: ['factExists', 'factNotDeprecated', 'evidenceRequired'],
      timeout_ms: 60000,
      agent_note: '证伪弃置一条事实（confidence→deprecated 终态）。前提被推翻、路径已确认走不通时使用；reason ≥10 字说明证伪依据。',
      deprecated: false,
    },
    fact_link: {
      actor: ['model', 'dashboard'],
      schema: schema({
        program_id: str({ minLength: 1 }),
        src_key: str({ minLength: 1 }),
        dst_key: str({ minLength: 1 }),
        edge_type: en(EDGE_TYPES),
        confidence: en(CONFIDENCE, { default: 'tentative' }),
      }, ['program_id', 'src_key', 'dst_key', 'edge_type']),
      idempotent: 'auto',
      idempotent_fields: ['program_id', 'src_key', 'dst_key', 'edge_type', 'confidence'],
      events: ['fact.linked'],
      event_limit: 1,
      invariants: ['factLinkEndpoints', 'factLinkNoSelfLoop'],
      timeout_ms: 60000,
      agent_note: '建立两条事实的关系边。edge_type: resolves_to/hosts/exposes/depends_on/leads_to/enables/exploits。确认的解析关系用 confirmed，推断用 tentative。',
      deprecated: false,
    },
    fact_record_validation: {
      actor: ['model', 'dashboard', 'script', 'system'],
      schema: schema({
        program_id: str({ minLength: 1 }),
        fact_key: str({ minLength: 1 }),
        evidence: str({ minLength: 1 }),
        note: str(),
      }, ['program_id', 'fact_key', 'evidence']),
      idempotent: 'auto',
      idempotent_fields: ['program_id', 'fact_key', 'evidence'],
      events: ['fact.validated'],
      event_limit: 1,
      invariants: ['factExists', 'factValidatable', 'evidenceRequired'],
      timeout_ms: 60000,
      agent_note: '标记一条事实经复验仍然有效（刷新复验期/顺延 TTL；cooling 事实复验通过自动复活 active）。检索命中且确认仍成立时回执调用；evidence 填 run_id 或复核结论。',
      deprecated: false,
    },
    fact_bb_publish: {
      actor: ['model', 'dashboard', 'script'],
      schema: schema({
        key: str({ minLength: 1 }),
        value: str({ minLength: 1, maxLength: 4000 }),
        mem_class: str(),
        ttl_days: num(),
        justification: str(),
        scope: str(),
      }, ['key', 'value']),
      idempotent: 'auto',
      idempotent_fields: ['key', 'value', 'mem_class', 'ttl_days'],
      events: ['fact.bb.published'],
      event_limit: 1,
      invariants: ['bbKeyNotSnapshot', 'bbTimelineRewrite', 'bbMemClassValid', 'bbTtlRange'],
      timeout_ms: 60000,
      agent_note: '发布黑板环境层条目（跨会话共享）：环境故障用 [env-issue] 前缀、时间轴流水用 [timeline] + 日期键（只追加）、全局广播用裸键。默认 ephemeral 7 天。目标状态快照/工作记录勿写黑板——用 fact_upsert（note 类）。',
      deprecated: false,
    },
    fact_transition: {
      actor: ['system', 'human'],
      schema: schema({
        object: en(['fact', 'bb']),
        program_id: str(),
        fact_key: str(),
        bb_key: str(),
        to: en(['cooling', 'archived']),
        reason: str({ minLength: 10 }),
      }, ['object', 'to', 'reason']),
      idempotent: 'auto',
      idempotent_fields: ['object', 'program_id', 'fact_key', 'bb_key', 'to', 'reason'],
      events: ['fact.cooled', 'fact.expired', 'fact.archived'],
      event_limit: 1,
      invariants: ['transitionObjectExists', 'transitionValid'],
      timeout_ms: 60000,
      agent_note: '生命周期治理通道（memcore/sweep 专用，模型不注册）：复验逾期→cooling、过期/超龄/cooling 超 30 天→archived。复活走 fact_record_validation。',
      deprecated: false,
    },
    fact_record_signal: {
      actor: ['model', 'system'],
      schema: schema({
        program_id: str({ minLength: 1 }),
        fact_key: str({ minLength: 1 }),
        signal: en(['used']),
        source: str({ default: '' }),
      }, ['program_id', 'fact_key', 'signal']),
      idempotent: 'auto',
      idempotent_fields: ['program_id', 'fact_key', 'signal', 'source'],
      events: [],
      invariants: ['factExists'],
      timeout_ms: 60000,
      agent_note: '回执"这条事实被实际用上了"（uses+1）。检索命中且采纳进决策时建议回执；计数驱动 know_health 零使用体检。',
      deprecated: false,
    },
    fact_reindex: {
      actor: ['model', 'dashboard', 'script', 'system'],
      schema: schema({ program_id: str({ minLength: 1 }) }, ['program_id']),
      idempotent: 'natural',
      idempotent_natural: ['program_id'],
      events: [],
      invariants: [],
      timeout_ms: 60000,
      agent_note: '事实图谱自动建边：扫描项目全部事实，按共享域名根 / C 段建 same-domain/same-subnet 关系边，让孤立事实成图。周期任务或新增一批事实后调用。',
      deprecated: false,
    },
    fact_purge_archive: {
      actor: ['system', 'human'],
      schema: schema({ before_ts: int() }, ['before_ts']),
      idempotent: 'auto',
      idempotent_fields: ['before_ts'],
      events: [],
      invariants: [],
      timeout_ms: 60000,
      agent_note: '归档表 90 天硬删（memcore sweep 经此命令替代 v4 裸 DELETE）。before_ts 为 epoch 毫秒阈值。',
      deprecated: false,
    },
  },
  queries: {
    fact_search: {
      actor: ['model', 'dashboard', 'human'],
      params: schema({
        program_id: str({ default: '' }),
        category: str({ default: '' }),
        q: str({ default: '' }),
        confidence: str({ default: '' }),
        has_edges: bool(),
        mem_class: str({ default: '' }),
        status: str({ default: '' }),
        exclude_notes: bool(),
        sort: en(['updated_at', 'edge_count', 'category'], { default: 'updated_at' }),
        reader: en(['task', 'review'], { default: 'task' }),
        limit: int({ minimum: 1, maximum: 500 }),
        offset: int({ minimum: 0 }),
      }, []),
      predicates: ['program', 'lifecycle'],
      agent_note: '检索事实（按 program/category/关键词，summary+key+body LIKE）。默认不返回 note 速记/timeline/已归档/已过期项；cooling 项带标记。',
    },
    fact_get: {
      actor: ['model', 'dashboard', 'human'],
      params: schema({
        program_id: str({ minLength: 1 }),
        fact_key: str({ minLength: 1 }),
        reader: en(['task', 'review'], { default: 'task' }),
      }, ['program_id', 'fact_key']),
      predicates: ['lifecycle'],
      agent_note: '读单条事实全文（含 body）。reader=task 时 archived/timeline 返回 E_NOT_FOUND，review 可查全量。',
    },
    fact_graph: {
      actor: ['model', 'dashboard', 'human'],
      params: schema({ program_id: str({ minLength: 1 }), fact_key: str({ minLength: 1 }) }, ['program_id', 'fact_key']),
      predicates: [],
      agent_note: '返回某条事实的关系子图（节点 + 出边 + 入边）。',
    },
    fact_overview: {
      actor: ['model', 'dashboard', 'human'],
      params: schema({}, []),
      predicates: [],
      agent_note: '事实分类计数总览（active 口径）+ 黑板活跃/env-issue + FGS 沉淀数。',
    },
    fact_stats: {
      actor: ['model', 'dashboard', 'human'],
      params: schema({}, []),
      predicates: [],
      agent_note: '事实图谱 facet 总览：分类/置信/生命周期分布 + 置顶 + 边规模。',
    },
    neg_check: {
      actor: ['model', 'dashboard', 'human'],
      params: schema({
        program_id: str({ minLength: 1 }),
        q: str({ default: '' }),
        limit: int({ minimum: 1, maximum: 500 }),
      }, ['program_id']),
      predicates: [],
      agent_note: '负知识账本：查 note/* 已证伪路径（验证失败/前提不满足）。派单/尝试前必查，命中即放弃。',
    },
    fact_bb_read: {
      actor: ['model', 'dashboard', 'human'],
      params: schema({
        key: str(),
        reader: en(['task', 'review'], { default: 'task' }),
      }, []),
      predicates: ['lifecycle'],
      agent_note: '读黑板环境层。带 key 读单条，不带列最近 100 条。默认不返回 timeline/已归档/已过期项；reader=review 全量。',
    },
  },
  events: {
    'fact.upserted': { payload: { type: 'object' }, redact: [] },
    'fact.deprecated': { payload: { type: 'object' }, redact: [] },
    'fact.validated': { payload: { type: 'object' }, redact: [] },
    'fact.expired': { payload: { type: 'object' }, redact: [] },
    'fact.cooled': { payload: { type: 'object' }, redact: [] },
    'fact.archived': { payload: { type: 'object' }, redact: [] },
    'fact.linked': { payload: { type: 'object' }, redact: [] },
    'fact.bb.published': { payload: { type: 'object' }, redact: [] },
  },
  subscribes: {
    'task.finished': { handler: 'onTaskFinished', mode: 'async', as: 'reactor' },
    'fgs.node.done': { handler: 'onFgsNodeDone', mode: 'async', as: 'reactor' },
    'exec.run.failed': { handler: 'onExecRunFailed', mode: 'async', as: 'reactor' },
    'approval.approved': { handler: 'onApprovalApproved', mode: 'async', as: 'reactor' },
  },
  backend: 'repository-v1',
}

// ---------------------------------------------------------------------------
// 生命周期计算（memcore validateWrite 分支的 v5 化，域内承接）
// ---------------------------------------------------------------------------

function computeFactLifecycle({ program_id, category, mem_class, ttl_days, revalidate_days, justification, scope }, now) {
  const cls = mem_class || (category === 'note' ? 'ephemeral' : 'durable')
  let expires_at = null
  let revalidate_by = null
  let last_validated_at = null
  if (cls === 'ephemeral') {
    const ttl = Number(ttl_days || 14)
    expires_at = now + Math.round(ttl * DAY)
  }
  if (cls === 'durable') {
    const rv = Number(revalidate_days || 30)
    revalidate_by = now + Math.round(rv * DAY)
    last_validated_at = now
  }
  return {
    mem_class: cls,
    status: 'active',
    status_at: now,
    scope: scope || `program:${program_id}`,
    expires_at,
    revalidate_by,
    justification: String(justification || '').trim() ? String(justification) : 'auto:default 缺省分类',
    last_validated_at,
  }
}

function computeBbLifecycle({ mem_class, ttl_days, justification, scope }, now) {
  const cls = mem_class || 'ephemeral'
  let expires_at = null
  if (cls === 'ephemeral') {
    const ttl = Number(ttl_days || 7)
    expires_at = now + Math.round(ttl * DAY)
  }
  return {
    mem_class: cls,
    status: 'active',
    status_at: now,
    scope: scope || 'global',
    expires_at,
    justification: String(justification || '').trim() ? String(justification) : 'auto:default 缺省分类',
  }
}

// ---------------------------------------------------------------------------
// handlers（命令/查询/不变量/订阅）
// ---------------------------------------------------------------------------

function makeHandlers(opts) {
  const dispatchRef = opts.dispatch
  const queryRef = opts.query

  function throwErr(code, message, hint, retryable = false) {
    throw Object.assign(new Error(message), { code, hint, retryable })
  }

  const invariants = {
    factKeyFormat: async (args) => {
      if (!String(args.fact_key).includes('/')) return { code: 'E_SCHEMA', message: 'fact_key 格式非法', hint: 'fact_key 格式 category/slug，如 auth/cred-admin', retryable: false }
      return null
    },
    factMemClassValid: async (args) => {
      if (args.mem_class && !FACT_MEM_CLASS.includes(args.mem_class)) return { code: 'E_INVARIANT', message: `INV-F1: mem_class=${args.mem_class} 非法`, hint: 'facts 允许 durable/ephemeral/timeline；permanent 方法论归 know 域 exp_store', retryable: false }
      return null
    },
    factTtlRange: async (args) => {
      const cls = args.mem_class || (args.category === 'note' ? 'ephemeral' : 'durable')
      if (cls === 'ephemeral' && args.ttl_days !== undefined) {
        const t = Number(args.ttl_days)
        if (!(t >= 1 / 24 && t <= 30)) return { code: 'E_INVARIANT', message: `INV-F3: ttl_days=${args.ttl_days} 越界`, hint: 'ephemeral TTL 须在 1 小时~30 天；note 类速记建议 14 天', retryable: false }
      }
      return null
    },
    factRevalidateRange: async (args) => {
      const cls = args.mem_class || (args.category === 'note' ? 'ephemeral' : 'durable')
      if (cls === 'durable' && args.revalidate_days !== undefined) {
        const r = Number(args.revalidate_days)
        if (!(r >= 7 && r <= 90)) return { code: 'E_INVARIANT', message: `INV-F4: revalidate_days=${args.revalidate_days} 越界`, hint: 'durable 复验期须在 7~90 天，默认 30 天', retryable: false }
      }
      return null
    },
    factSummaryBodyLimits: async (args) => {
      if (String(args.summary || '').length > 300) return { code: 'E_INVARIANT', message: 'INV-F9: summary 超 300 字符', hint: '压缩 summary 为一行索引，全文拆进 body', retryable: false }
      if (String(args.body || '').length > 4000) return { code: 'E_INVARIANT', message: 'INV-F9: body 超 4000 字符', hint: '全文拆进 body；超大内容走 report 域', retryable: false }
      return null
    },
    justificationPlaceholder: async (args) => {
      const j = String(args.justification || '')
      if (j && /^(.)\1+$/.test(j)) return { code: 'E_INVARIANT', message: 'INV-F5: justification 占位符', hint: '分类理由不能是单字符重复占位', retryable: false }
      return null
    },
    factExists: async (args, repo) => {
      const row = repo.getFact(args.program_id, args.fact_key)
      if (!row) return { code: 'E_NOT_FOUND', message: `事实不存在: ${args.program_id}/${args.fact_key}`, hint: '先 fact_search 定位', retryable: false }
      return null
    },
    factNotConfirmed: async (args, repo) => {
      const row = repo.getFact(args.program_id, args.fact_key)
      if (row && row.confidence === 'confirmed') return { code: 'E_STATE', message: '事实已是 confirmed，无需再纠正', hint: '补充信息用 fact_upsert，证伪用 fact_deprecate', retryable: false }
      return null
    },
    factNotDeprecated: async (args, repo) => {
      const row = repo.getFact(args.program_id, args.fact_key)
      if (row && row.confidence === 'deprecated') return { code: 'E_STATE', message: '事实已是 deprecated（终态）', hint: '复活 = 用 fact_upsert 重新立论', retryable: false }
      return null
    },
    factValidatable: async (args, repo) => {
      const row = repo.getFact(args.program_id, args.fact_key)
      if (row && (row.status === 'archived' || row.mem_class === 'timeline')) return { code: 'E_STATE', message: '归档/timeline 行不可复验', hint: '归档行复活走数据修复脚本', retryable: false }
      return null
    },
    evidenceRequired: async (args) => {
      const ev = args.evidence !== undefined ? args.evidence : args.reason
      if (!String(ev || '').trim() || String(ev || '').trim().length < 10) return { code: 'E_EVIDENCE_REQUIRED', message: '证据/依据缺失或过短', hint: '必须附 ≥10 字依据（run_id 或复核结论）', retryable: false }
      return null
    },
    factLinkEndpoints: async (args, repo) => {
      if (!repo.getFact(args.program_id, args.src_key)) return { code: 'E_NOT_FOUND', message: `src_key 不存在: ${args.src_key}`, hint: '先 fact_upsert 两端再建边', retryable: false }
      if (!repo.getFact(args.program_id, args.dst_key)) return { code: 'E_NOT_FOUND', message: `dst_key 不存在: ${args.dst_key}`, hint: '先 fact_upsert 两端再建边', retryable: false }
      return null
    },
    factLinkNoSelfLoop: async (args) => {
      if (args.src_key === args.dst_key) return { code: 'E_SCHEMA', message: '自环边非法', hint: 'src_key 与 dst_key 不能相同', retryable: false }
      return null
    },
    bbKeyNotSnapshot: async (args) => {
      if (SNAPSHOT_KEY_RE.test(String(args.key))) return { code: 'E_INVARIANT', message: `INV-F7: 黑板键 ${args.key} 是快照前缀`, hint: '快照/工作记录（alive:/scan:/recon:/review:/note:/todo:/plan:）属事实类——改用 fact_upsert（category=note）', retryable: false }
      return null
    },
    bbTimelineRewrite: async (args, repo) => {
      const existing = repo.getBb(args.key)
      if (existing && existing.mem_class === 'timeline') return { code: 'E_STATE', message: 'R7: timeline 键只追加不可改写', hint: '换用带新日期的新 key', retryable: false }
      return null
    },
    bbMemClassValid: async (args) => {
      if (args.mem_class && !BB_MEM_CLASS.includes(args.mem_class)) return { code: 'E_INVARIANT', message: `INV-F1: mem_class=${args.mem_class} 非法`, hint: '黑板允许 ephemeral(默认 7d)/timeline(30d 归档)；durable 事实走 fact_upsert', retryable: false }
      return null
    },
    bbTtlRange: async (args) => {
      const cls = args.mem_class || 'ephemeral'
      if (cls === 'ephemeral' && args.ttl_days !== undefined) {
        const t = Number(args.ttl_days)
        if (!(t >= 1 / 24 && t <= 30)) return { code: 'E_INVARIANT', message: `INV-F3: ttl_days=${args.ttl_days} 越界`, hint: '黑板 ephemeral TTL 须在 1 小时~30 天', retryable: false }
      }
      return null
    },
    transitionObjectExists: async (args, repo) => {
      if (args.object === 'fact') {
        if (!args.program_id || !args.fact_key) return { code: 'E_SCHEMA', message: 'object=fact 需 program_id+fact_key', hint: null, retryable: false }
        if (!repo.getFact(args.program_id, args.fact_key)) return { code: 'E_NOT_FOUND', message: `事实不存在: ${args.program_id}/${args.fact_key}`, hint: null, retryable: false }
      } else {
        if (!args.bb_key) return { code: 'E_SCHEMA', message: 'object=bb 需 bb_key', hint: null, retryable: false }
        if (!repo.getBb(args.bb_key)) return { code: 'E_NOT_FOUND', message: `黑板键不存在: ${args.bb_key}`, hint: null, retryable: false }
      }
      return null
    },
    transitionValid: async (args, repo) => {
      if (args.object === 'bb' && args.to === 'cooling') return { code: 'E_STATE', message: '黑板无 cooling 态', hint: '黑板只允许 active→archived', retryable: false }
      if (args.object === 'fact') {
        const row = repo.getFact(args.program_id, args.fact_key)
        const from = row.status || 'active'
        if (args.to === 'cooling') {
          if (from !== 'active') return { code: 'E_STATE', message: `非法流转: ${from}→cooling`, hint: '只有 active 可转 cooling', retryable: false }
          if (row.mem_class !== 'durable') return { code: 'E_STATE', message: `非法流转: ${row.mem_class}→cooling`, hint: '只有 durable 事实复验逾期才转 cooling', retryable: false }
        } else if (args.to === 'archived') {
          if (!['active', 'cooling'].includes(from)) return { code: 'E_STATE', message: `非法流转: ${from}→archived`, hint: null, retryable: false }
        }
      } else if (args.object === 'bb' && args.to === 'archived') {
        const row = repo.getBb(args.bb_key)
        if ((row.status || 'active') !== 'active') return { code: 'E_STATE', message: `非法流转: ${row.status}→archived`, hint: null, retryable: false }
      }
      return null
    },
  }

  const commands = {
    fact_upsert: async (args, repo) => {
      const now = Date.now()
      const lc = computeFactLifecycle(args, now)
      const r = repo.upsertFact({
        program_id: args.program_id, fact_key: args.fact_key,
        category: args.category || '', summary: args.summary || '', body: args.body || '',
        confidence: args.confidence || 'tentative', pinned: args.pinned ? 1 : 0,
        related_finding_id: args.related_finding_id ?? null, source: args.source || '',
        updated_at: now,
        mem_class: lc.mem_class, status: lc.status, status_at: lc.status_at, scope: lc.scope,
        expires_at: lc.expires_at, revalidate_by: lc.revalidate_by,
        justification: lc.justification, last_validated_at: lc.last_validated_at,
      })
      return {
        data: { program_id: args.program_id, fact_key: args.fact_key, mem_class: lc.mem_class, confidence: args.confidence || 'tentative', merged: r.merged },
        events: [{ name: 'fact.upserted', payload: { program_id: args.program_id, fact_key: args.fact_key, mem_class: lc.mem_class, confidence: args.confidence || 'tentative', merged: r.merged } }],
        before: r.before ? { confidence: r.before.confidence, mem_class: r.before.mem_class } : null,
        after: { confidence: args.confidence || 'tentative', mem_class: lc.mem_class },
      }
    },

    fact_correct: async (args, repo) => {
      const cur = repo.getFact(args.program_id, args.fact_key)
      const now = Date.now()
      const next = {
        program_id: args.program_id, fact_key: args.fact_key,
        category: args.category !== undefined ? args.category : cur.category,
        summary: args.summary !== undefined ? args.summary : cur.summary,
        body: args.body !== undefined ? args.body : cur.body,
        confidence: 'confirmed', pinned: cur.pinned ? 1 : 0,
        related_finding_id: cur.related_finding_id, source: cur.source,
        updated_at: now,
        mem_class: cur.mem_class, status: 'active', status_at: now, scope: cur.scope,
        expires_at: cur.expires_at, revalidate_by: cur.revalidate_by,
        justification: cur.justification, last_validated_at: cur.last_validated_at,
      }
      repo.upsertFact(next)
      return {
        data: { program_id: args.program_id, fact_key: args.fact_key, confidence: 'confirmed' },
        events: [{ name: 'fact.upserted', payload: { program_id: args.program_id, fact_key: args.fact_key, mem_class: cur.mem_class, confidence: 'confirmed', merged: true, from_confidence: cur.confidence } }],
        before: { confidence: cur.confidence }, after: { confidence: 'confirmed' },
      }
    },

    fact_deprecate: async (args, repo) => {
      const cur = repo.getFact(args.program_id, args.fact_key)
      repo.setFactConfidence(args.program_id, args.fact_key, 'deprecated', Date.now())
      return {
        data: { program_id: args.program_id, fact_key: args.fact_key, confidence: 'deprecated' },
        events: [{ name: 'fact.deprecated', payload: { program_id: args.program_id, fact_key: args.fact_key, from_confidence: cur.confidence, reason: String(args.reason).slice(0, 120) } }],
        before: { confidence: cur.confidence }, after: { confidence: 'deprecated' },
      }
    },

    fact_link: async (args, repo) => {
      repo.replaceEdge(args.program_id, args.src_key, args.dst_key, args.edge_type, args.confidence || 'tentative')
      return {
        data: { program_id: args.program_id, src_key: args.src_key, dst_key: args.dst_key, edge_type: args.edge_type, confidence: args.confidence || 'tentative' },
        events: [{ name: 'fact.linked', payload: { program_id: args.program_id, src_key: args.src_key, dst_key: args.dst_key, edge_type: args.edge_type, confidence: args.confidence || 'tentative' } }],
        before: null, after: { edge_type: args.edge_type },
      }
    },

    fact_record_validation: async (args, repo) => {
      const cur = repo.getFact(args.program_id, args.fact_key)
      const now = Date.now()
      let newExpiresAt = null
      let newRevalidateBy = null
      if (cur.mem_class === 'ephemeral') {
        const window = (cur.expires_at && cur.status_at) ? (cur.expires_at - cur.status_at) : 14 * DAY
        newExpiresAt = now + Math.max(window, DAY / 24)
      } else if (cur.mem_class === 'durable') {
        const window = (cur.revalidate_by && cur.last_validated_at) ? (cur.revalidate_by - cur.last_validated_at) : 30 * DAY
        newRevalidateBy = now + Math.max(window, 7 * DAY)
      }
      const healed = cur.status === 'cooling'
      repo.refreshFactValidation(args.program_id, args.fact_key, now, newExpiresAt, newRevalidateBy)
      return {
        data: { program_id: args.program_id, fact_key: args.fact_key, status: 'active', revalidate_by: newRevalidateBy, expires_at: newExpiresAt },
        events: [{ name: 'fact.validated', payload: { program_id: args.program_id, fact_key: args.fact_key, revalidate_by: newRevalidateBy, expires_at: newExpiresAt, healed } }],
        before: { status: cur.status }, after: { status: 'active' },
      }
    },

    fact_bb_publish: async (args, repo) => {
      const now = Date.now()
      const lc = computeBbLifecycle(args, now)
      const r = repo.upsertBb({
        key: args.key, value: args.value, updated_at: now,
        mem_class: lc.mem_class, status: lc.status, status_at: lc.status_at, scope: lc.scope,
        expires_at: lc.expires_at, justification: lc.justification,
      })
      const channel = String(args.key).startsWith('[env-issue]') ? 'env-issue' : String(args.key).startsWith('[timeline]') ? 'timeline' : 'broadcast'
      return {
        data: { key: args.key, mem_class: lc.mem_class, expires_at: lc.expires_at },
        events: [{ name: 'fact.bb.published', payload: { key: args.key, mem_class: lc.mem_class, expires_at: lc.expires_at, channel } }],
        before: r.before ? { mem_class: r.before.mem_class } : null,
        after: { mem_class: lc.mem_class },
      }
    },

    fact_transition: async (args, repo) => {
      const now = Date.now()
      const isFact = args.object === 'fact'
      const row = isFact ? repo.getFact(args.program_id, args.fact_key) : repo.getBb(args.bb_key)
      const from = row.status || 'active'
      const id = isFact ? `${args.program_id}/${args.fact_key}` : args.bb_key
      let event = null
      if (args.to === 'cooling') {
        if (isFact) repo.setFactStatus(args.program_id, args.fact_key, 'cooling', now)
        event = { name: 'fact.cooled', payload: { object_kind: 'fact', id, from: 'active', reason: args.reason } }
      } else {
        if (isFact) {
          repo.archiveFact(args.program_id, args.fact_key, args.reason, now)
          const natural = row.mem_class === 'ephemeral' || row.mem_class === 'timeline'
          event = { name: natural ? 'fact.expired' : 'fact.archived', payload: { object_kind: 'fact', program_id: args.program_id, fact_key: args.fact_key, mem_class: row.mem_class, from, reason: args.reason } }
        } else {
          repo.archiveBb(args.bb_key, args.reason, now)
          const natural = row.mem_class === 'ephemeral' || row.mem_class === 'timeline'
          event = { name: natural ? 'fact.expired' : 'fact.archived', payload: { object_kind: 'bb', bb_key: args.bb_key, mem_class: row.mem_class, from, reason: args.reason } }
        }
      }
      return { data: { object: args.object, id, from, to: args.to }, events: [event], before: { status: from }, after: { status: args.to } }
    },

    fact_record_signal: async (args, repo) => {
      const row = repo.recordFactUse(args.program_id, args.fact_key, Date.now())
      return { data: { program_id: args.program_id, fact_key: args.fact_key, uses: row.uses }, events: [], before: null, after: { uses: row.uses } }
    },

    fact_reindex: async (args, repo) => {
      const facts = repo.listAllFactsForReindex(args.program_id)
      const hostRe = /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}\b/gi
      const ipRe = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g
      const tokenMap = {}
      for (const f of facts) {
        const text = `${f.fact_key} ${f.summary || ''} ${f.body || ''}`
        const tokens = new Set()
        for (const m of text.match(hostRe) || []) tokens.add(m.toLowerCase().split('.').slice(-2).join('.'))
        for (const m of text.match(ipRe) || []) tokens.add(m.split('.').slice(0, 3).join('.') + '.0/24')
        for (const t of tokens) (tokenMap[t] || (tokenMap[t] = [])).push(f.fact_key)
      }
      let edges = 0
      let groups = 0
      for (const [token, keys] of Object.entries(tokenMap)) {
        const uniq = [...new Set(keys)]
        if (uniq.length < 2 || uniq.length > 50) continue
        groups++
        const edgeType = token.includes('/') ? 'same-subnet' : 'same-domain'
        const center = uniq[0]
        for (let i = 1; i < uniq.length; i++) {
          repo.replaceEdge(args.program_id, center, uniq[i], edgeType, 'tentative')
          edges++
        }
      }
      return { data: { program_id: args.program_id, facts: facts.length, groups, edges }, events: [], before: null, after: { edges, groups } }
    },

    fact_purge_archive: async (args, repo) => {
      const before = args.before_ts
      const factPurged = repo.purgeFactArchives(before)
      const bbPurged = repo.purgeBbArchives(before)
      return { data: { purged: factPurged + bbPurged, fact_purged: factPurged, bb_purged: bbPurged }, events: [], before: null, after: { purged: factPurged + bbPurged } }
    },
  }

  // 可见域谓词（06-fact §1.4）：reader=task 排除 archived/timeline/过期 ephemeral + 默认排除 note
  function visibleWhere(reader, now) {
    if (reader === 'review') return { where: '1=1', args: [] }
    return { where: "status != 'archived' AND (mem_class IS NULL OR mem_class != 'timeline') AND (mem_class IS NULL OR mem_class != 'ephemeral' OR expires_at IS NULL OR expires_at >= ?)", args: [now] }
  }
  function filterWhere({ program_id, category, q, confidence, has_edges, mem_class, status, exclude_notes }) {
    const conds = []
    const args = []
    if (program_id) { conds.push('program_id = ?'); args.push(String(program_id)) }
    if (category) { conds.push('category = ?'); args.push(String(category)) }
    if (confidence) { conds.push('confidence = ?'); args.push(String(confidence)) }
    if (mem_class) { conds.push('mem_class = ?'); args.push(String(mem_class)) }
    if (status) { conds.push('status = ?'); args.push(String(status)) }
    if (exclude_notes) { conds.push("(category IS NULL OR category != 'note')") }
    if (q) { conds.push('(summary LIKE ? OR fact_key LIKE ? OR body LIKE ?)'); args.push(`%${q}%`, `%${q}%`, `%${q}%`) }
    if (has_edges) { conds.push('EXISTS (SELECT 1 FROM fact_edges e WHERE e.program_id = facts.program_id AND (e.src_key = facts.fact_key OR e.dst_key = facts.fact_key))') }
    return { where: conds.length ? conds.join(' AND ') : '1=1', args }
  }

  function combinedWhere(reader, filters, now) {
    const f = filterWhere(filters)
    const v = visibleWhere(reader, now)
    const parts = [f.where]
    const args = [...f.args]
    if (v.where !== '1=1') { parts.push(`(${v.where})`); args.push(...v.args) }
    return { where: parts.join(' AND '), args }
  }

  const queries = {
    fact_search: async (args, repo) => {
      const now = Date.now()
      const reader = args.reader || 'task'
      const excludeNotes = args.exclude_notes !== false
      const { where, args: wa } = combinedWhere(reader, { program_id: args.program_id || '', category: args.category || '', q: args.q || '', confidence: args.confidence || '', has_edges: !!args.has_edges, mem_class: args.mem_class || '', status: args.status || '', exclude_notes: excludeNotes }, now)
      const sort = args.sort || 'updated_at'
      const rows = repo.listFactsWhere(where, wa, sort, 500, 0).map((r) => ({ ...r, _cooling: r.status === 'cooling' ? true : undefined }))
      const total = repo.countFactsWhere(where, wa)
      return { rows, total }
    },
    fact_get: async (args, repo) => {
      const row = repo.getFact(args.program_id, args.fact_key)
      if (!row) throwErr('E_NOT_FOUND', `事实不存在: ${args.program_id}/${args.fact_key}`, '先 fact_search 定位', false)
      const reader = args.reader || 'task'
      if (reader === 'task' && (row.status === 'archived' || row.mem_class === 'timeline')) throwErr('E_NOT_FOUND', '事实已归档/timeline（task 视角不可见）', 'reader=review 可查全量', false)
      return { ...row }
    },
    fact_graph: async (args, repo) => {
      const node = repo.getFact(args.program_id, args.fact_key)
      const edges = repo.listEdges(args.program_id, args.fact_key)
      return { node, out: edges.out, in: edges.in }
    },
    fact_overview: async (_args, repo) => repo.factOverviewAggregate(),
    fact_stats: async (_args, repo) => repo.factAggregates(),
    neg_check: async (args, repo) => {
      const now = Date.now()
      const { where, args: wa } = combinedWhere('task', { program_id: args.program_id, category: 'note', q: args.q || '', exclude_notes: false }, now)
      const rows = repo.listFactsWhere(where, wa, 'updated_at', args.limit ?? 20, 0)
      return { failed_paths: rows, total: rows.length, warning: rows.length ? '以下路径已证伪，避免重复尝试' : '无已知证伪路径' }
    },
    fact_bb_read: async (args, repo) => {
      const reader = args.reader || 'task'
      if (args.key) {
        const row = repo.getBb(args.key)
        if (!row) throwErr('E_NOT_FOUND', `黑板键不存在: ${args.key}`, null, false)
        if (reader === 'task' && (row.status === 'archived' || row.mem_class === 'timeline' || (row.mem_class === 'ephemeral' && row.expires_at && row.expires_at < Date.now()))) throwErr('E_NOT_FOUND', '黑板条目已归档/timeline/过期', 'reader=review 可查全量', false)
        return { ...row }
      }
      let rows = repo.listBbRecent(100)
      if (reader === 'task') {
        const now = Date.now()
        rows = rows.filter((r) => r.status !== 'archived' && r.mem_class !== 'timeline' && !(r.mem_class === 'ephemeral' && r.expires_at && r.expires_at < now))
      }
      return rows
    },
  }

  // FGS 沉淀（06-fact §2.3，原 persistFgsFacts 直写归零）：查询 fgs 域 done fact 节点，
  // 对满足沉淀判据（summary + detail/evidence 非空）的节点逐条 fact_upsert（幂等）。
  async function persistFgsFactsForTask(taskId, programId) {
    if (!dispatchRef || !queryRef) return 0
    let list = null
    try { list = await queryRef('fgs', 'list', { task_id: taskId, type: 'fact', status: 'done', limit: 500 }, { actor: 'reactor' }) } catch { return 0 }
    const rows = list && list.ok && Array.isArray(list.rows) ? list.rows : []
    let n = 0
    for (const node of rows) {
      const c = node.content || {}
      const summary = String(c.summary || '').trim()
      const detail = String(c.detail || c.evidence || '').trim()
      if (!summary || !detail) continue
      try {
        const r = await dispatchRef('fact', 'upsert', {
          program_id: programId, fact_key: `fgs/${taskId}/${node.id}`,
          category: 'fgs', summary: summary.slice(0, 200), body: detail.slice(0, 2000),
          confidence: 'confirmed', source: 'fgs-persist',
          mem_class: 'durable', revalidate_days: 30,
          justification: `FGS 任务 #${taskId} 结论性事实沉淀（决策链留痕于 fgs_nodes，证据见 body）`,
        }, { actor: 'reactor' })
        if (r && r.ok) n++
      } catch { /* 单节点失败不影响其余 */ }
    }
    return n
  }

  const subscribers = {
    // 补漏对账（弱联动）：任务成功收尾时对该任务 FGS 图 done fact 节点重放沉淀判定。
    // 主通道（onFgsNodeDone）曾失败的节点在此补齐；fact_upsert 幂等保证对账零副作用。
    onTaskFinished: async (envelope) => {
      if (!dispatchRef || !queryRef) return { ok: true, data: { skipped: true } }
      const p = envelope?.payload || {}
      if (!p.ok || !p.task_id) return { ok: true, data: { skipped: true } }
      const programId = String(p.program_id || '')
      if (!programId) return { ok: true, data: { skipped: true } }
      const n = await persistFgsFactsForTask(p.task_id, programId)
      return { ok: true, data: { skipped: false, persisted: n } }
    },
    // 主通道：fgs.node.done（async）→ type=fact 且 persist_eligible 时节点完成即沉淀。
    // payload 只含 ID 与判据快照（14-fgs §1.5）；program_id 经 task 域 task_get 反查。
    onFgsNodeDone: async (envelope) => {
      if (!dispatchRef || !queryRef) return { ok: true, data: { skipped: true } }
      const p = envelope?.payload || {}
      if (p.type !== 'fact' || !p.persist_eligible || !p.task_id) return { ok: true, data: { skipped: true } }
      let programId = ''
      try {
        const t = await queryRef('task', 'get', { task_id: p.task_id }, { actor: 'reactor' })
        programId = t && t.ok && t.data ? String(t.data.program_id || '') : ''
      } catch { programId = '' }
      if (!programId) return { ok: true, data: { skipped: true } }
      const n = await persistFgsFactsForTask(p.task_id, programId)
      return { ok: true, data: { skipped: n === 0, persisted: n } }
    },
    onExecRunFailed: async (envelope) => {
      if (!dispatchRef) return { ok: true, data: { skipped: true } }
      const p = envelope?.payload || {}
      const tool = p.tool || 'cli'
      const host = p.host || p.target || 'unknown'
      const r = await dispatchRef('fact', 'upsert', {
        program_id: p.program_id || '__legacy__', fact_key: `note/fail-${tool}-${host}`,
        category: 'note', summary: `run_cli 失败：${tool} @ ${host}`, body: `run_id=${p.run_id || ''} tool=${tool} target=${host} cause=${p.cause || ''} duration_ms=${p.duration_ms || ''}`,
        confidence: 'tentative', source: 'auto:runcli-fail',
      }, { actor: 'reactor' })
      return { ok: !!r.ok, data: { skipped: false } }
    },
    onApprovalApproved: async (envelope) => {
      if (!dispatchRef) return { ok: true, data: { skipped: true } }
      const p = envelope?.payload || {}
      if (p.kind !== 'exclude-exception' || !p.subject) return { ok: true, data: { skipped: true } }
      const host = p.subject
      const r = await dispatchRef('fact', 'upsert', {
        program_id: p.program_id || '__legacy__', fact_key: `scope/exception-${host}`,
        category: 'scope', summary: `排除例外授权：${host}`, body: String(p.evidence || '').slice(0, 4000),
        confidence: 'confirmed', source: 'approval',
      }, { actor: 'approval' })
      return { ok: !!r.ok, data: { skipped: false } }
    },
  }

  return { ...commands, queries, invariants, subscribers }
}

// ---------------------------------------------------------------------------
// 组装（测试与 cordis 共用）
// ---------------------------------------------------------------------------

export function buildFactDomain(opts = {}) {
  const backend = createFactSqliteBackend(opts.backendOptions || {})
  return {
    manifest: FACT_MANIFEST,
    handlers: makeHandlers(opts),
    backend,
  }
}

export function apply(ctx, config = {}) {
  const dataDir = process.env.SEC_DATA_DIR || process.env.DSH_HOME || DEFAULT_DATA_DIR
  try {
    ctx.inject(['secDomainBus'], (child) => {
      const bus = child.secDomainBus
      const domain = buildFactDomain({ dataDir, dispatch: (d, v, a, c) => bus.dispatch(d, v, a, c), query: (d, n, a, c) => bus.query(d, n, a, c) })
      const res = bus.registry.register(domain)
      if (res.ok) log(`fact 域注册成功（registered=${res.registered}）`)
      else log(`fact 域注册被拒：${res.error?.code} ${res.error?.message}`)
      return () => {}
    })
  } catch (e) {
    log(`secDomainBus 注入失败：${e?.message}——fact 域未注册（总线必须先行挂载）`)
  }
  return null
}
