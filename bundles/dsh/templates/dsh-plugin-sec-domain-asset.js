// ==============================================================================
// @silksec/sec-domain-asset — SilkSecAgent asset 域插件（v5 Phase 2 首域）
//
// 契约：doc/secagent/v5/03-asset.md（域设计，权威）+ 01-bus.md（总线）+ 00-conventions.md（宪法）
//
// 对外（cordis）：name='sec-domain-asset'，apply() 把 manifest+handlers+backend 交给
// 总线 registry.register()（不 provide 任何业务方法——防绕过核心承诺）。
//
// 语义要点：
//  - 动词 asset_upsert / asset_upsert_bulk / asset_grade / asset_state /
//    fp_record / fp_record_bulk 拆自 v4 asset-db.js 的 upsertAsset / fpAdd；
//  - 评级列（score/level/accept/biz）只经 asset_grade、state 只经 asset_state——
//    结构性闸门：其余动词 schema additionalProperties:false 不含这些参数（INV-1）；
//  - level 永远非入参：由 score 派生（S≥75/A60-74/B40-59/C<40），域私有映射（INV-6）；
//  - 分级保留确认点：proposal 不自动落库（订阅 handler 只回灌 assets/fingerprints/state）；
//  - scope 校验（INV-3）：带 program_id 时 host 须命中该 program scope（scope.yml 自查，
//    scope 域查询上线前 fail-open 于"program 未找到"，program 找到则严格执行）；
//  - 订阅 exec.run.completed（httpx parser proposal 回灌，async 弱联动）。
//
// 零依赖：node:fs / node:path / node:crypto（sqlite 在总线）
// ==============================================================================

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

export const name = 'sec-domain-asset'
export const version = '1.0.0'

const DEFAULT_DATA_DIR = process.env.SEC_DATA_DIR || '/opt/silkspool/dsh/data'

const log = (msg) => { try { process.stderr.write(`[sec-domain-asset] ${msg}\n`) } catch { /* noop */ } }
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex')

const backendUrl = new URL('../sec-backend-asset-sqlite/index.js', import.meta.url)
const { createAssetSqliteBackend } = await import(backendUrl.href)

// ---------------------------------------------------------------------------
// manifest（03-asset §1.2/§1.4/§1.5 的机器形态）
// ---------------------------------------------------------------------------

const schema = (properties, required, extra = {}) => ({
  type: 'object', properties, required, additionalProperties: false, ...extra,
})
const str = (opts = {}) => ({ type: 'string', ...opts })
const en = (values, extra = {}) => ({ type: 'string', enum: values, ...extra })
const int = (opts = {}) => ({ type: 'integer', ...opts })
const bool = () => ({ type: 'boolean' })

const ASSET_TYPES = ['domain', 'ip', 'web', 'service', 'host']
const SIGNALS = ['content_changed', 'probe_alive_unchanged', 'probe_failed', 'revived']
const ACCEPT = ['full', 'intrusion-only', 'none']
const BIZ = ['核心', '一般', '未知']
const OWNER = ['confirmed', 'suspect', 'third_party']

export const ASSET_MANIFEST = {
  domain: 'asset',
  version: 1,
  service: 'secDomain.asset',
  description: '资产/指纹/分级/生命周期（挖什么、先挖谁——分级是准入决策的唯一事实源）',
  owns: {
    tables: ['assets', 'fingerprints'],
    files: ['data/events/asset.jsonl'],
  },
  commands: {
    asset_upsert: {
      actor: ['model', 'script', 'dashboard'],
      schema: schema({
        host: str({ minLength: 1 }),
        type: en(ASSET_TYPES, { default: 'host' }),
        source: str({ default: '' }),
        attrs: { type: 'object' },
        program_id: str(),
      }, ['host']),
      idempotent: 'auto',
      idempotent_fields: ['host', 'type', 'source', 'attrs', 'program_id'],
      events: ['asset.registered'],
      event_limit: 1,
      invariants: ['scopeCheck'],
      timeout_ms: 60000,
      agent_note: '登记或触活一个资产（域名/IP/存活 web 站点）。本工具只登记"资产存在"：host + type + 来源；评级（score/level/accept/biz）与生命周期（state）分别走 asset_grade / asset_state。带 program_id 时主机必须在项目授权范围内。重复登记安全（幂等，只刷 last_seen）。',
      deprecated: false,
    },
    asset_upsert_bulk: {
      actor: ['model', 'script'],
      schema: schema({
        rows: { type: 'array', items: schema({
          host: str({ minLength: 1 }),
          type: en(ASSET_TYPES, { default: 'host' }),
          source: str({ default: '' }),
          attrs: { type: 'object' },
          program_id: str(),
        }, ['host']) },
        proposal_ref: str(),
      }, ['rows']),
      idempotent: 'auto',
      idempotent_fields: ['rows', 'proposal_ref'],
      events: ['asset.registered'],
      event_limit: 500,
      invariants: ['bulkRowLimit'],
      timeout_ms: 60000,
      agent_note: '批量登记资产（≤500 行，httpx 探活结果回灌用）。行级结果数组返回，单行失败不影响其余。评级与状态仍分别走 asset_grade / asset_state。',
      deprecated: false,
    },
    asset_grade: {
      actor: ['model', 'script', 'dashboard'],
      schema: schema({
        proposal_path: str(),
        host: str(),
        type: en(ASSET_TYPES, { default: 'host' }),
        score: int({ minimum: 0, maximum: 100 }),
        accept: en(ACCEPT),
        biz: en(BIZ),
        rationale: str(),
        regrade: bool(),
        run_id: str(),
        owner: en(OWNER),
        owner_evidence: str(),
      }, []),
      idempotent: 'auto',
      idempotent_fields: ['proposal_path', 'host', 'type', 'score', 'accept', 'biz', 'rationale', 'regrade', 'run_id', 'owner', 'owner_evidence'],
      events: ['asset.graded'],
      event_limit: 2000,
      invariants: ['gradeMode', 'gradeSinglePreflight'],
      timeout_ms: 120000,
      agent_note: '资产分级落库（本域唯一写 score/level/accept/biz 的入口）。两种用法：① grade_assets 脚本产出 proposal 文件后传 proposal_path 批量落库（≤2000 行）；② 单资产传 host+score+rationale（vision_triage 分诊/人工调级）。level 由 score 自动派生（S≥75/A60-74/B40-59/C<40），不可直接指定。已分级资产重评需 regrade: true。',
      deprecated: false,
    },
    asset_state: {
      actor: ['model', 'script', 'dashboard'],
      schema: schema({
        host: str({ minLength: 1 }),
        type: en(ASSET_TYPES, { default: 'host' }),
        signal: en(SIGNALS),
        evidence: str({ minLength: 1 }),
        note: str(),
      }, ['host', 'signal', 'evidence']),
      idempotent: 'auto',
      idempotent_fields: ['host', 'type', 'signal', 'evidence'],
      events: ['asset.state.changed'],
      event_limit: 1,
      invariants: ['assetExists', 'stateTransition'],
      timeout_ms: 60000,
      agent_note: '资产生命周期流转（new/changed/stable/dead）。传观测信号（content_changed / probe_alive_unchanged / probe_failed / revived）+ 证据 run_id，不传目标状态——状态机由域校验。变化雷达（ledger_radar_drain）命中后应尽快登记 changed（新内容黄金窗口优先测）；探活失败登记 dead 自动出深挖队列。',
      deprecated: false,
    },
    fp_record: {
      actor: ['model', 'script', 'dashboard'],
      schema: schema({
        host: str({ minLength: 1 }),
        tech: str({ minLength: 1 }),
        version: str({ default: '' }),
        source: str({ default: '' }),
        program_id: str(),
      }, ['host', 'tech']),
      idempotent: 'auto',
      idempotent_fields: ['host', 'tech', 'version', 'source', 'program_id'],
      events: ['asset.fp.recorded'],
      event_limit: 1,
      invariants: ['scopeCheck'],
      timeout_ms: 60000,
      agent_note: '登记指纹（技术栈+版本，host+tech 去重）。指纹命中后用 exec_intel_hunt 检索 N-day 模板并可建候选任务。httpx 探活的 tech 数组会经 parser proposal 自动登记，无需手动。',
      deprecated: false,
    },
    fp_record_bulk: {
      actor: ['model', 'script'],
      schema: schema({
        rows: { type: 'array', items: schema({
          host: str({ minLength: 1 }),
          tech: str({ minLength: 1 }),
          version: str({ default: '' }),
          source: str({ default: '' }),
          program_id: str(),
        }, ['host', 'tech']) },
        proposal_ref: str(),
      }, ['rows']),
      idempotent: 'auto',
      idempotent_fields: ['rows', 'proposal_ref'],
      events: ['asset.fp.recorded'],
      event_limit: 500,
      invariants: ['bulkRowLimit'],
      timeout_ms: 60000,
      agent_note: '批量登记指纹（≤500 行）。',
      deprecated: false,
    },
  },
  queries: {
    asset_list: {
      actor: ['model', 'dashboard', 'human'],
      params: schema({
        host_like: str({ default: '' }),
        type: str({ default: '' }),
        program_id: str({ default: '' }),
        level: en([...['S', 'A', 'B', 'C', 'none'], ''], { default: '' }),
        level_in: str({ default: '' }),
        accept: str({ default: '' }),
        state: str({ default: '' }),
        sort: en(['last_seen', 'host', 'type', 'program_id', 'score', ''], { default: '' }),
        dir: en(['asc', 'desc', ''], { default: '' }),
        limit: int({ minimum: 1, maximum: 500 }),
        offset: int({ minimum: 0 }),
      }, []),
      predicates: ['program', 'level', 'state'],
      agent_note: '检索资产图谱：host_like 模糊、type/program_id/level/level_in/accept/state 过滤。level=\'none\' 筛未分级资产（分级前的待办清单）。',
    },
    asset_get: {
      actor: ['model', 'dashboard', 'human'],
      params: schema({
        host: str({ minLength: 1 }),
        type: en([...ASSET_TYPES, ''], { default: '' }),
      }, ['host']),
      predicates: [],
      agent_note: '单主机钻取：多类型资产行 + 指纹 + 接口计数 + 漏洞分级统计 + 同族主机。',
    },
    asset_family: {
      actor: ['model', 'dashboard', 'human'],
      params: schema({ root: str({ minLength: 1 }) }, ['root']),
      predicates: [],
      agent_note: '域名族/网段成员主机清单（root 从 asset_overview 族行取）。',
    },
    asset_overview: {
      actor: ['model', 'dashboard', 'human'],
      params: schema({}, []),
      predicates: [],
      agent_note: '资产总览：评级/状态/收录分布 + 域名族聚合（缓存 25s）。',
    },
    fp_query: {
      actor: ['model', 'dashboard', 'human'],
      params: schema({
        host: str({ default: '' }),
        tech: str({ default: '' }),
        program_id: str({ default: '' }),
        limit: int({ minimum: 1, maximum: 500 }),
        offset: int({ minimum: 0 }),
      }, []),
      predicates: ['program'],
      agent_note: '检索指纹（host 精确 / tech 模糊 / program 过滤）。命中技术栈后查 N-day。',
    },
    asset_deep_queue: {
      actor: ['model', 'dashboard', 'human', 'script'],
      params: schema({
        program_id: str({ default: '' }),
        limit: int({ minimum: 1, maximum: 500 }),
        offset: int({ minimum: 0 }),
      }, []),
      predicates: ['program'],
      agent_note: '深挖队列（固化查询）：level∈{S,A,B} + accept≠none + 非 dead，按 score 降序。主动扫描/派单取目标一律走本查询——未分级与 C 级资产取不到，这是资产准入纪律的物理形态。',
    },
  },
  events: {
    'asset.registered': { payload: { type: 'object' }, redact: [] },
    'asset.graded': { payload: { type: 'object' }, redact: [] },
    'asset.state.changed': { payload: { type: 'object' }, redact: [] },
    'asset.fp.recorded': { payload: { type: 'object' }, redact: [] },
  },
  subscribes: {
    'exec.run.completed': { handler: 'onRunProposal', mode: 'async', as: 'reactor' },
  },
  backend: 'repository-v1',
}

// ---------------------------------------------------------------------------
// 域名工具（主机归一 / scope 自查 / 分级映射 / 状态机）
// ---------------------------------------------------------------------------

function normalizeHost(h) {
  let s = String(h || '').trim().toLowerCase()
  const proto = s.indexOf('://')
  if (proto >= 0) s = s.slice(proto + 3)
  const at = s.lastIndexOf('@')
  if (at >= 0) s = s.slice(at + 1)
  const slash = s.indexOf('/')
  if (slash >= 0) s = s.slice(0, slash)
  if (s.startsWith('[')) {
    const close = s.indexOf(']')
    s = close >= 0 ? s.slice(1, close) : s.slice(1)
  } else {
    s = s.replace(/:\d+$/, '')
  }
  return s.replace(/\.$/, '')
}

function scoreToLevel(score) {
  const s = Number(score)
  if (s >= 75) return 'S'
  if (s >= 60) return 'A'
  if (s >= 40) return 'B'
  return 'C'
}

// scope.yml 自查（INV-3）：programs[].name/scope/exclude 解析 + 命中判定（模块级 mtime 缓存）
let _scopeCache = null // { mtimeMs, programs: [{name, scope:[], exclude:[]}] }
function loadScopePrograms(dataDir) {
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
    if (nameM) {
      cur = { name: nameM[1].trim(), scope: [], exclude: [] }
      programs.push(cur)
      key = ''
      continue
    }
    if (!cur) continue
    if (/^(scope|exclude):\s*$/.test(t)) { key = t.slice(0, t.length - 1); continue }
    const itemM = t.match(/^-\s*["']?([^"']+?)["']?\s*$/)
    if (itemM && (key === 'scope' || key === 'exclude')) { cur[key].push(itemM[1].trim()); continue }
    if (/^[a-z_]+:/.test(t)) key = ''
  }
  return programs
}

function hostInPatterns(host, patterns) {
  const h = normalizeHost(host)
  for (const p of patterns) {
    const bare = String(p).replace(/^\*\./, '')
    if (!bare) continue
    if (bare === h || h.endsWith('.' + bare)) return true
  }
  return false
}

// INV-3：program_id 非空时 host 必须命中该 program scope 且不在 exclude。
// program 未找到 / scope.yml 不可读 → fail-open（scope 域查询上线前过渡，记 log）。
function scopeCheckResult(programId, host, dataDir) {
  if (!programId) return { ok: true }
  const programs = loadScopePrograms(dataDir)
  const prog = programs.find((p) => p.name === programId)
  if (!prog) {
    log(`scope 自查：program ${programId} 未在 scope.yml 找到，fail-open（scope 域查询上线前过渡）`)
    return { ok: true }
  }
  if (hostInPatterns(host, prog.exclude || [])) {
    return { ok: false, code: 'E_INVARIANT', message: `资产 ${host} 命中项目 ${programId} 排除清单`, hint: '该域在项目排除清单内，需单独授权后才能登记（走 exclude-exception 审批）', retryable: false }
  }
  if (!hostInPatterns(host, prog.scope || [])) {
    return { ok: false, code: 'E_INVARIANT', message: `资产 ${host} 不在项目 ${programId} 授权范围内`, hint: '资产 {host} 不在项目 {program_id} 授权范围内——域外参考站请不带 program_id 登记（保持 level NULL，不进主动队列），或先经审批扩 scope', retryable: false }
  }
  return { ok: true }
}

// 状态机（03-asset §1.3.4 矩阵）：返回 { to, changed } 或 { error, hint }
function stateTransition(current, signal) {
  const cur = current || 'NULL'
  switch (signal) {
    case 'revived':
      if (cur === 'dead') return { to: 'changed', changed: true }
      return { error: 'E_STATE', hint: 'revived 只对 dead 资产有效；当前非 dead' }
    case 'content_changed':
      if (cur === 'dead') return { error: 'E_STATE', hint: 'dead 资产内容变化说明实际复活，先探活确认再以 signal=revived 登记' }
      return { to: 'changed', changed: true }
    case 'probe_alive_unchanged':
      if (cur === 'dead') return { error: 'E_STATE', hint: 'dead 资产需先以 signal=revived 复活' }
      if (cur === 'stable') return { to: 'stable', changed: false }
      return { to: 'stable', changed: true }
    case 'probe_failed':
      if (cur === 'dead') return { to: 'dead', changed: false }
      return { to: 'dead', changed: true }
    default:
      return { error: 'E_STATE', hint: '未知信号' }
  }
}

// ---------------------------------------------------------------------------
// handlers（每个命令一个实现；错误抛 {code, hint, retryable?} 由网关转信封）
// ---------------------------------------------------------------------------

function makeHandlers(opts) {
  const dataDir = opts.dataDir || DEFAULT_DATA_DIR
  const dispatchRef = opts.dispatch

  function throwErr(code, message, hint, retryable = false) {
    throw Object.assign(new Error(message), { code, hint, retryable })
  }

  const invariants = {
    scopeCheck: async (args) => {
      const r = scopeCheckResult(args.program_id, args.host, dataDir)
      if (!r.ok) return { code: r.code, message: r.message, hint: r.hint, retryable: r.retryable }
      return null
    },
    bulkRowLimit: async (args) => {
      if (!Array.isArray(args.rows)) return { code: 'E_SCHEMA', message: 'rows 必须为数组', hint: null, retryable: false }
      if (args.rows.length === 0 || args.rows.length > 500) return { code: 'E_SCHEMA', message: `rows 行数 ${args.rows.length} 超上限（1..500）`, hint: '批量上限 500 行；更大批量请分片', retryable: false }
      return null
    },
    assetExists: async (args, repo) => {
      const row = repo.getAsset(args.host, args.type || 'host')
      if (!row) return { code: 'E_NOT_FOUND', message: `资产 ${args.host} 未登记`, hint: '先 asset_upsert 登记，再流转状态', retryable: false }
      return null
    },
    stateTransition: async (args, repo) => {
      const row = repo.getAsset(args.host, args.type || 'host')
      const cur = row ? row.state : null
      const t = stateTransition(cur, args.signal)
      if (t.error) return { code: t.error, message: `状态流转拒绝：${cur} + ${args.signal}`, hint: t.hint, retryable: false }
      return null
    },
    gradeMode: async (args) => {
      const hasProposal = !!args.proposal_path
      const hasSingle = !!(args.host || args.score !== undefined || args.rationale)
      if (hasProposal && hasSingle) return { code: 'E_SCHEMA', message: 'proposal 模式与单资产模式互斥', hint: 'proposal_path 与 host/score/rationale 只能二选一', retryable: false }
      if (!hasProposal && !args.host) return { code: 'E_SCHEMA', message: '缺少模式入参', hint: '传 proposal_path（批量）或 host+score+rationale（单资产）', retryable: false }
      if (!hasProposal) {
        if (args.score === undefined || args.score === null) return { code: 'E_SCHEMA', message: '单资产模式 score 必填', hint: 'score 为 0-100 整数', retryable: false }
        if (!String(args.rationale || '').trim() || String(args.rationale).trim().length < 10) return { code: 'E_EVIDENCE_REQUIRED', message: '单资产模式 rationale 必填（≥10 字）', hint: '分级是准入决策，必须可回溯：手工调级需 ≥10 字 rationale', retryable: false }
      }
      return null
    },
    gradeSinglePreflight: async (args, repo) => {
      if (args.proposal_path) return null // proposal 模式由 handler 逐行校验
      const row = repo.getAsset(args.host, args.type || 'host')
      if (!row) return { code: 'E_NOT_FOUND', message: `资产 ${args.host} 未登记`, hint: '先 asset_upsert 登记，再分级——未登记的资产没有 last_seen/指纹密度可算', retryable: false }
      if (row.level && !args.regrade) return { code: 'E_ASSET_ALREADY_GRADED', message: `资产 ${args.host} 已是 ${row.level} 级`, hint: `资产 {host} 已是 {level} 级；确认要重评请带 regrade: true（会覆盖 score/level 并审计 before/after）`, retryable: false }
      if (args.owner && !String(args.owner_evidence || '').trim()) return { code: 'E_EVIDENCE_REQUIRED', message: 'owner 标注必须附 owner_evidence', hint: '证据即参数：无证据不打 owner 标（ICP 备案/证书 Organization/whois 摘录/favicon 同源依据）', retryable: false }
      return null
    },
  }

  function toRowResult(row, err) {
    if (!err) return { host: row.host, type: row.type || 'host', created: row.created, ok: true }
    return { host: row.host, type: row.type || 'host', created: false, ok: false, error: err }
  }

  function upsertOne(repo, args, ctx) {
    const host = normalizeHost(args.host)
    const type = args.type || 'host'
    const existing = repo.getAsset(host, type)
    if (existing) {
      const r = repo.touchAsset(host, type, args.source || '', args.program_id ?? null, Date.now())
      return { data: { host, type, created: false }, event: null, before: { last_seen: existing.last_seen }, after: { last_seen: r.row?.last_seen ?? existing.last_seen } }
    }
    const r = repo.insertAsset({ host, type, source: args.source || '', attrs: args.attrs ?? null, program_id: args.program_id ?? null })
    return {
      data: { host, type, created: true, program_id: args.program_id ?? null, source: args.source || '' },
      event: { name: 'asset.registered', payload: { host, type, program_id: args.program_id ?? null, source: args.source || '', root: rootOf(host) } },
      before: null, after: { host, type },
    }
  }

  const commands = {
    asset_upsert: async (args, repo, ctx) => {
      const r = upsertOne(repo, args, ctx)
      return {
        data: r.data,
        events: r.event ? [r.event] : [],
        before: r.before, after: r.after,
      }
    },

    asset_upsert_bulk: async (args, repo, ctx) => {
      const results = []
      const events = []
      let created = 0
      let touched = 0
      for (const row of args.rows) {
        const host = normalizeHost(row.host)
        const sc = scopeCheckResult(row.program_id, host, dataDir)
        if (!sc.ok) {
          results.push({ host, type: row.type || 'host', created: false, ok: false, error: `${sc.code}: ${sc.message}` })
          continue
        }
        const existing = repo.getAsset(host, row.type || 'host')
        if (existing) {
          repo.touchAsset(host, row.type || 'host', row.source || '', row.program_id ?? null, Date.now())
          touched++
          results.push({ host, type: row.type || 'host', created: false, ok: true })
        } else {
          repo.insertAsset({ host, type: row.type || 'host', source: row.source || '', attrs: row.attrs ?? null, program_id: row.program_id ?? null })
          created++
          results.push({ host, type: row.type || 'host', created: true, ok: true })
          events.push({ name: 'asset.registered', payload: { host, type: row.type || 'host', program_id: row.program_id ?? null, source: row.source || '', root: rootOf(host) } })
        }
      }
      return {
        data: { created, touched, results, proposal_ref: args.proposal_ref ?? null },
        events,
        before: null, after: { created, touched },
      }
    },

    asset_grade: async (args, repo, ctx) => {
      const now = Date.now()
      if (args.proposal_path) {
        // proposal 模式（03-asset §1.3.3 P1-P9）
        const pp = String(args.proposal_path)
        const resolved = path.isAbsolute(pp) ? pp : path.join(dataDir, pp)
        let doc = null
        try { doc = JSON.parse(fs.readFileSync(resolved, 'utf8')) } catch (e) { throwErr('E_ASSET_PROPOSAL_INVALID', `proposal 文件不存在或 JSON 不可解析: ${pp}`, '先跑 grade_assets 纯计算脚本产 proposal', false) }
        if (doc.schema !== 'silksec/asset-grade-proposal@1') throwErr('E_ASSET_PROPOSAL_INVALID', 'proposal schema 字段不是 silksec/asset-grade-proposal@1', '期望 silksec/asset-grade-proposal@1 格式', false)
        const rows = Array.isArray(doc.rows) ? doc.rows : []
        if (rows.length < 1 || rows.length > 2000) throwErr('E_ASSET_PROPOSAL_INVALID', `proposal rows 行数 ${rows.length} 超限（1..2000）`, '脚本侧 --split 2000 分片产出多个 proposal', false)
        if (doc.summary && Number.isInteger(doc.summary.candidates) && doc.summary.candidates !== rows.length) throwErr('E_ASSET_PROPOSAL_INVALID', 'summary.candidates 与 rows.length 不一致', '防脚本与文件漂移：summary.candidates 必须等于 rows.length', false)
        // P6 证据：run_id 的 results 目录必须存在
        const runId = doc.run_id || ''
        if (!runId || !fs.existsSync(path.join(dataDir, 'results', runId))) throwErr('E_EVIDENCE_REQUIRED', `proposal run_id 无有效证据目录: ${runId}`, '分级是准入决策，proposal 需来自真实 run（results/<run_id>/ 须存在）', false)
        // P4/P5 行校验
        const seen = new Set()
        const rowErrors = []
        rows.forEach((row, i) => {
          if (!String(row.host || '').trim()) rowErrors.push(`第 ${i + 1} 行 host 为空`)
          if (!Number.isInteger(row.score) || row.score < 0 || row.score > 100) rowErrors.push(`第 ${i + 1} 行 score 非法`)
          if (!Array.isArray(row.reasons) || row.reasons.length < 1) rowErrors.push(`第 ${i + 1} 行 reasons 缺`)
          const k = `${String(row.host)}|${String(row.type || 'host')}`
          if (seen.has(k)) throwErr('E_ASSET_PROPOSAL_DUP_ROW', `proposal 行内 (host,type) 重复: ${row.host}`, '去重后重产 proposal', false)
          seen.add(k)
        })
        if (rowErrors.length) throwErr('E_ASSET_PROPOSAL_INVALID', rowErrors.slice(0, 5).join('; '), '附具体行号与期望格式', false)
        // 逐行落库（P8 行级跳过 / P9 已分级跳过）
        const results = []
        const events = []
        let graded = 0
        let skippedGraded = 0
        let failed = 0
        const byLevel = {}
        for (const row of rows) {
          const host = normalizeHost(row.host)
          const type = row.type || 'host'
          const existing = repo.getAsset(host, type)
          if (!existing) {
            failed++
            results.push({ host, type, ok: false, error: 'E_NOT_FOUND' })
            continue
          }
          if (existing.level && !args.regrade) {
            skippedGraded++
            results.push({ host, type, ok: true, skipped: 'graded' })
            continue
          }
          const level = scoreToLevel(row.score)
          const set = { score: row.score, level, graded_at: now }
          if (row.accept !== undefined && row.accept !== null) set.accept = row.accept
          if (row.biz !== undefined && row.biz !== null) set.biz = row.biz
          const r = repo.updateAssetGrading(host, type, set)
          graded++
          byLevel[level] = (byLevel[level] || 0) + 1
          results.push({ host, type, level, ok: true })
          events.push({
            name: 'asset.graded',
            payload: {
              host, type,
              from: { level: r.before?.level ?? null, score: r.before?.score ?? null, accept: r.before?.accept ?? null, biz: r.before?.biz ?? null },
              to: { level, score: row.score, accept: row.accept ?? null, biz: row.biz ?? null },
              mode: 'proposal', proposal_sha256: sha256(JSON.stringify(doc)), run_id: runId,
            },
          })
        }
        return {
          data: { mode: 'proposal', proposal_path: pp, graded, skipped_graded: skippedGraded, failed, by_level: byLevel, results },
          events,
          before: null, after: { graded, failed },
        }
      }
      // 单资产模式（gradeMode + gradeSinglePreflight 已前置校验 INV-4/5/6）
      const host = normalizeHost(args.host)
      const type = args.type || 'host'
      const before = repo.getAsset(host, type)
      const level = scoreToLevel(args.score)
      const set = { score: args.score, level, graded_at: now }
      if (args.accept !== undefined && args.accept !== null) set.accept = args.accept
      if (args.biz !== undefined && args.biz !== null) set.biz = args.biz
      if (args.owner !== undefined && args.owner !== null) set.owner = args.owner
      const r = repo.updateAssetGrading(host, type, set)
      return {
        data: { mode: 'single', host, type, level, score: args.score },
        events: [{
          name: 'asset.graded',
          payload: {
            host, type,
            from: { level: before?.level ?? null, score: before?.score ?? null, accept: before?.accept ?? null, biz: before?.biz ?? null },
            to: { level, score: args.score, accept: args.accept ?? null, biz: args.biz ?? null },
            mode: 'single', run_id: args.run_id ?? null, owner: args.owner ?? null,
          },
        }],
        before: before ? { level: before.level, score: before.score } : null,
        after: { level, score: args.score },
      }
    },

    asset_state: async (args, repo) => {
      const host = normalizeHost(args.host)
      const type = args.type || 'host'
      const before = repo.getAsset(host, type)
      const t = stateTransition(before?.state ?? null, args.signal)
      if (t.error) throwErr(t.error, `状态流转拒绝：${before?.state ?? 'NULL'} + ${args.signal}`, t.hint, false)
      const from = before?.state ?? null
      let to = from
      if (t.changed) {
        const r = repo.updateAssetState(host, type, t.to, Date.now())
        to = t.to
      }
      return {
        data: { host, type, from, to, changed: t.changed },
        events: t.changed ? [{ name: 'asset.state.changed', payload: { host, type, from, to, signal: args.signal, evidence: args.evidence } }] : [],
        before: { state: from }, after: { state: to },
      }
    },

    fp_record: async (args, repo) => {
      const host = normalizeHost(args.host)
      const r = repo.upsertFingerprint({ host, tech: String(args.tech).toLowerCase(), version: args.version || '', source: args.source || '', program_id: args.program_id ?? null })
      const changed = r.version_changed || r.created
      return {
        data: { host, tech: String(args.tech).toLowerCase(), version: r.after?.version ?? args.version, created: r.created, version_from: r.version_from },
        events: changed ? [{ name: 'asset.fp.recorded', payload: { host, tech: String(args.tech).toLowerCase(), version: r.after?.version ?? '', version_from: r.version_from, source: args.source || '', program_id: args.program_id ?? null } }] : [],
        before: r.before ? { version: r.before.version } : null,
        after: { version: r.after?.version ?? '' },
      }
    },

    fp_record_bulk: async (args, repo) => {
      const results = []
      const events = []
      let created = 0
      let updated = 0
      for (const row of args.rows) {
        const host = normalizeHost(row.host)
        const r = repo.upsertFingerprint({ host, tech: String(row.tech).toLowerCase(), version: row.version || '', source: row.source || '', program_id: row.program_id ?? null })
        const changed = r.version_changed || r.created
        if (r.created) created++; else updated++
        results.push({ host, tech: String(row.tech).toLowerCase(), created: r.created, ok: true })
        if (changed) events.push({ name: 'asset.fp.recorded', payload: { host, tech: String(row.tech).toLowerCase(), version: r.after?.version ?? '', version_from: r.version_from, source: row.source || '', program_id: row.program_id ?? null } })
      }
      return {
        data: { created, updated, results, proposal_ref: args.proposal_ref ?? null },
        events,
        before: null, after: { created, updated },
      }
    },
  }

  const queries = {
    asset_list: async (args, repo) => {
      const filters = { host_like: args.host_like || '', type: args.type || '', program_id: args.program_id || '', level: args.level || '', level_in: args.level_in || '', accept: args.accept || '', state: args.state || '' }
      const rows = repo.listAssetsWhere(filters, { sort: args.sort || 'last_seen', dir: args.dir || 'desc' }, args.limit, args.offset)
      const total = repo.countAssetsWhere(filters)
      return { rows, total }
    },
    asset_get: async (args, repo) => {
      const host = normalizeHost(args.host)
      const type = args.type || ''
      const rows = type
        ? (repo.getAsset(host, type) ? [repo.getAsset(host, type)] : [])
        : repo.getAssetsByHost(host)
      if (!rows.length) throwErr('E_NOT_FOUND', `资产不存在: ${host}`, '先 asset_list 核实 host', false)
      const extras = repo.assetDetailExtras(host)
      const root = rootOf(host)
      const siblings = repo.siblingsOfHost(host, root, 20)
      return {
        host, root,
        assets: rows.map((r) => ({ host: r.host, type: r.type, source: r.source, program_id: r.program_id, first_seen: r.first_seen, last_seen: r.last_seen, score: r.score, level: r.level, accept: r.accept, biz: r.biz, state: r.state })),
        endpoints: extras.endpoints,
        fingerprints: extras.fingerprints,
        endpoint_total: extras.endpoint_total,
        findings: extras.findings,
        siblings,
      }
    },
    asset_family: async (args, repo) => {
      const root = String(args.root || '')
      const hosts = repo.familyMembers(root, 200)
      return { root, hosts }
    },
    asset_overview: async (_args, repo) => {
      return repo.overviewAggregate()
    },
    fp_query: async (args, repo) => {
      const filters = { host: args.host || '', tech: args.tech || '', program_id: args.program_id || '' }
      const rows = repo.listFingerprintsWhere(filters, {}, args.limit, args.offset)
      const total = repo.countFingerprintsWhere(filters)
      return { rows, total }
    },
    asset_deep_queue: async (args, repo) => {
      return repo.deepQueue(args.program_id || '', args.limit, args.offset)
    },
  }

  const subscribers = {
    onRunProposal: async (envelope) => {
      const payload = envelope?.payload || {}
      const p = payload.parse_proposal
      if (!p || p.kind !== 'assets' || !dispatchRef) return { ok: true, data: { skipped: true } }
      const runId = String(payload.run_id || envelope?.cause?.run_id || '')
      let registered = 0
      let failed = 0
      try {
        if (Array.isArray(p.assets) && p.assets.length) {
          const r = await dispatchRef('asset', 'upsert_bulk', { rows: p.assets, proposal_ref: runId }, { actor: 'script', session_id: payload.session_id || null, run_id: runId })
          if (r.ok) registered += (r.data?.created || 0); else failed++
        }
        if (Array.isArray(p.fingerprints) && p.fingerprints.length) {
          const r = await dispatchRef('asset', 'fp_record_bulk', { rows: p.fingerprints, proposal_ref: runId }, { actor: 'script', session_id: payload.session_id || null, run_id: runId })
          if (r.ok) registered += (r.data?.created || 0); else failed++
        }
        for (const s of (Array.isArray(p.state_signals) ? p.state_signals : [])) {
          try {
            const r = await dispatchRef('asset', 'state', { host: s.host, type: s.type || 'host', signal: s.signal, evidence: runId }, { actor: 'script', session_id: payload.session_id || null, run_id: runId })
            if (r.ok) registered++; else failed++
          } catch { failed++ }
        }
      } catch { failed++ }
      return { ok: true, data: { registered, failed, partial: failed > 0 } }
    },
  }

  return { ...commands, queries, invariants, subscribers }
}

function rootOf(host) {
  const h = normalizeHost(host)
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return h.slice(0, h.lastIndexOf('.')) + '.0/24'
  const parts = h.split('.')
  if (parts.length < 2) return h
  const sld = parts[parts.length - 2]
  if (parts.length >= 3 && (sld === 'com' || sld === 'net' || sld === 'org' || sld === 'gov' || sld === 'edu' || sld === 'co' || sld === 'ac')) return parts.slice(-3).join('.')
  return parts.slice(-2).join('.')
}

// ---------------------------------------------------------------------------
// 组装（测试与 cordis 共用）：manifest + handlers + backend
// ---------------------------------------------------------------------------

export function buildAssetDomain(opts = {}) {
  const dataDir = opts.dataDir || DEFAULT_DATA_DIR
  const backend = createAssetSqliteBackend(opts.backendOptions || {})
  return {
    manifest: ASSET_MANIFEST,
    handlers: makeHandlers({ ...opts, dataDir }),
    backend,
  }
}

export const assetUtils = { normalizeHost, scoreToLevel, hostRoot: rootOf, stateTransition, scopeCheckResult, parseScopePrograms }

// ---------------------------------------------------------------------------
// cordis 插件入口：向总线 registry 注册（不 provide 任何业务方法）
// ---------------------------------------------------------------------------

export function apply(ctx, config = {}) {
  const dataDir = process.env.SEC_DATA_DIR || process.env.DSH_HOME || DEFAULT_DATA_DIR
  try {
    ctx.inject(['secDomainBus'], (child) => {
      const bus = child.secDomainBus
      const domain = buildAssetDomain({ dataDir, dispatch: (d, v, a, c) => bus.dispatch(d, v, a, c) })
      const res = bus.registry.register(domain)
      if (res.ok) log(`asset 域注册成功（registered=${res.registered}）`)
      else log(`asset 域注册被拒：${res.error?.code} ${res.error?.message}`)
      return () => { /* 不 provide 无需 dispose */ }
    })
  } catch (e) {
    log(`secDomainBus 注入失败：${e?.message}——asset 域未注册（总线必须先行挂载）`)
  }
  return null
}
