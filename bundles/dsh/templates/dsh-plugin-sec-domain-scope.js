// ==============================================================================
// @silksec/sec-domain-scope — SilkSecAgent scope 域插件（v5 Phase 2.6：授权白名单 / 项目镜像 / 排除 / 规则 / 凭据引用）
//
// 契约：doc/secagent/v5/08-scope.md（域设计，权威）+ 01-bus.md（总线）+ 00-conventions.md（宪法）
//
// 对外（cordis）：name='sec-domain-scope'，apply() 把 manifest+handlers+backend 交给
// 总线 registry.register()（不 provide 任何业务方法——防绕过核心承诺）。
//
// 语义要点：
//  - scope.yml 是授权白名单唯一真相源（fail-closed）；programs 表是运行态镜像（自愈）；
//  - 通配条目自动配对裸域（*.x.com → +x.com）；grant 吸收本项目排除（互斥不变量 I2 维持动作）；
//  - 授权/排除/规则写动词 model 物理禁入（actor 白名单无 model）；
//  - 凭据引用（cred_add）零明文，host 必须在授权范围（不变量 I5）；
//  - 发布 scope.rules.changed（exec 域强联动订阅，替代 v4 mtime 轮询）。
//  - 不订阅任何域（授权批准效果由 approval 域写 approval_effects 行 + 幂等执行 scope_grant/rules_apply）。
// ==============================================================================

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

export const name = 'sec-domain-scope'
export const version = '1.0.0'

const DEFAULT_DATA_DIR = process.env.SEC_DATA_DIR || '/opt/silkspool/dsh/data'

const log = (msg) => { try { process.stderr.write(`[sec-domain-scope] ${msg}\n`) } catch { /* noop */ } }

const backendFileUrl = new URL('../sec-backend-scope-file/index.js', import.meta.url)
const backendSqliteUrl = new URL('../sec-backend-scope-sqlite/index.js', import.meta.url)
const { createScopeFileBackend } = await import(backendFileUrl.href)
const { createScopeSqliteBackend } = await import(backendSqliteUrl.href)

const PROGRAM_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/
const RISK_ENUM = ['passive', 'active', 'intrusive']
const ALLOW_RISK_ENUM = ['passive', 'active']
const REF_FORMAT_RE = /^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/

function sha1(str) { return crypto.createHash('sha1').update(String(str)).digest('hex') }

// ---------------------------------------------------------------------------
// 目标归一化与条目匹配（§1.4.1 规范定义——唯一实现放本域，scope_check 与守卫共用）
// ---------------------------------------------------------------------------

function ipToInt(ip) {
  const parts = String(ip).split('.')
  if (parts.length !== 4) return null
  let n = 0
  for (const p of parts) { const v = Number(p); if (!Number.isInteger(v) || v < 0 || v > 255) return null; n = n * 256 + v }
  return n
}
function cidrContains(cidr, ip) {
  const [base, bitsRaw] = String(cidr).split('/')
  const bits = Number(bitsRaw); const b = ipToInt(base); const t = ipToInt(ip)
  if (b === null || t === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false
  if (bits === 0) return true
  const mask = bits === 32 ? 0xffffffff : (0xffffffff << (32 - bits)) >>> 0
  return (b & mask) >>> 0 === (t & mask) >>> 0
}
export function hostOf(raw) {
  let s = String(raw).trim()
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
  s = s.split('/')[0].split('?')[0].split('#')[0]
  if (s.startsWith('[')) { const end = s.indexOf(']'); if (end > 0) return s.slice(1, end).toLowerCase() }
  if (s.includes(':') && /:\d+$/.test(s)) s = s.slice(0, s.lastIndexOf(':'))
  return s.toLowerCase()
}
function entryMatches(entry, host) {
  entry = String(entry).trim().toLowerCase()
  host = String(host).trim().toLowerCase()
  if (!entry || !host) return false
  if (entry.includes('/')) return ipToInt(host) !== null && cidrContains(entry, host)
  if (entry.startsWith('*.')) { const suffix = entry.slice(1); return host === entry.slice(2) || host.endsWith(suffix) }
  return host === entry
}
// I1：条目格式（字面域名 / IPv4·IPv6 字面量 / *.domain 后缀通配 / IPv4 CIDR）
export function validEntry(entry) {
  entry = String(entry).trim().toLowerCase()
  if (!entry) return false
  if (entry.includes('/')) {
    const m = entry.match(/^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/)
    if (!m) return false
    if (ipToInt(m[1]) === null) return false
    const bits = Number(m[2]); return bits >= 0 && bits <= 32
  }
  if (entry.startsWith('*.')) {
    return /^\*\.[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(entry)
  }
  if (entry.includes(':')) return /^[0-9a-f:]+$/i.test(entry) // IPv6 字面量
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(entry)) return ipToInt(entry) !== null // IPv4 字面量
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(entry) // 字面域名
}
// 两条目是否语义重叠（互斥不变量 I2 用；近似：域后缀关系 + CIDR 包含）
function entriesOverlap(a, b) {
  a = String(a).trim().toLowerCase(); b = String(b).trim().toLowerCase()
  if (!a || !b) return false
  if (a === b) return true
  const dom = (e) => e.startsWith('*.') ? e.slice(2) : (e.includes('/') || e.includes(':') || /^\d{1,3}(\.\d{1,3}){3}$/.test(e) ? null : e)
  const da = dom(a); const db = dom(b)
  if (da && db) return da === db || da.endsWith('.' + db) || db.endsWith('.' + da)
  const cidrA = a.includes('/') ? a : null; const cidrB = b.includes('/') ? b : null
  if (cidrA && cidrB) return cidrContains(cidrA, cidrB.split('/')[0]) || cidrContains(cidrB, cidrA.split('/')[0])
  if (cidrA) { const ipb = ipToInt(b); return ipb !== null && cidrContains(cidrA, b) }
  if (cidrB) { const ipa = ipToInt(a); return ipa !== null && cidrContains(cidrB, a) }
  return false
}

// 通配自动配对裸域（*.x.com → x.com），并排序去重规范化
function normalizeEntries(entries) {
  const out = new Set()
  for (const raw of entries || []) {
    const e = String(raw).trim().toLowerCase()
    if (!e) continue
    out.add(e)
    if (e.startsWith('*.')) out.add(e.slice(2))
  }
  return [...out].sort()
}

// checkTarget 完整算法（§1.4.1 顺序强制）
export function checkTargetScope(target, snapshot, programFilter) {
  const host = hostOf(target)
  if (!host) return { allow: false, reason: '无法解析目标', host }
  for (const p of snapshot.programs || []) {
    for (const e of p.exclude || []) {
      if (entryMatches(e, host)) return { allow: false, reason: `目标在项目 ${p.name} 的排除清单中`, program: p.name, excluded_by: e, host }
    }
  }
  for (const p of snapshot.programs || []) {
    if (programFilter && p.name !== programFilter) continue
    for (const e of p.scope || []) {
      if (entryMatches(e, host)) {
        const kind = e.startsWith('*.') ? 'wildcard' : (e.includes('/') ? 'cidr' : 'literal')
        return { allow: true, program: p.name, matched_entry: e, matched_kind: kind, reason: `命中项目 ${p.name} 授权范围`, program_cfg: p, host }
      }
    }
  }
  return { allow: false, reason: '目标不在任何授权项目范围内（scope.yml fail-closed）', host }
}

// ---------------------------------------------------------------------------
// manifest（08-scope §1.2/§1.3/§1.4/§1.5 的机器形态）
// ---------------------------------------------------------------------------

const schema = (properties, required, extra = {}) => ({ type: 'object', properties, required, additionalProperties: false, ...extra })
const str = (opts = {}) => ({ type: 'string', ...opts })
const en = (values, extra = {}) => ({ type: 'string', enum: values, ...extra })
const int = (opts = {}) => ({ type: 'integer', ...opts })
const bool = (opts = {}) => ({ type: 'boolean', ...opts })
const strArr = (opts = {}) => ({ type: 'array', items: { type: 'string' }, ...opts })

export const SCOPE_MANIFEST = {
  domain: 'scope',
  version: 1,
  service: 'secDomain.scope',
  description: '授权白名单（scope.yml fail-closed 真相源）/ 项目运行态镜像 / 排除清单 / 扫描规则（QPS·风险·侵入白名单）/ 凭据引用——目标授权判定的唯一规范实现',
  owns: {
    tables: ['programs', 'credentials'],
    files: ['data/scope.yml', 'data/scope.yml.bak', 'data/scope.yml.tmp', 'data/events/scope.jsonl'],
  },
  commands: {
    scope_grant: {
      actor: ['approval', 'dashboard', 'human', 'system'],
      schema: schema({
        program_name: str({ minLength: 1 }),
        entries: strArr({ minLength: 1, maxLength: 200 }),
        platform: str({ maxLength: 64 }),
        finding_db: str(),
        max_risk: en(RISK_ENUM),
        fixed_egress_ip: bool(),
        request_id: int(),
      }, ['program_name', 'entries']),
      idempotent: 'none',
      events: ['scope.granted'],
      event_limit: 1,
      invariants: ['grantEntryValid', 'grantMutualExclusion'],
      timeout_ms: 60000,
      agent_note: '向项目追加授权条目（新建项目亦可；model 不可用）。通配条目自动配对裸域；命中本项目排除清单自动吸收。批准链由 approval 域经 effect 执行。',
      deprecated: false,
    },
    scope_revoke: {
      actor: ['approval', 'dashboard', 'human', 'system'],
      schema: schema({
        program_name: str({ minLength: 1 }),
        entries: strArr({ minLength: 1, maxLength: 200 }),
      }, ['program_name', 'entries']),
      idempotent: 'none',
      events: ['scope.revoked'],
      event_limit: 1,
      invariants: ['revokeProgramExists', 'revokeEntriesExist'],
      timeout_ms: 60000,
      agent_note: '从项目移除授权条目（fail-closed 立即生效）；条目清空 → 整项目出 yml + programs 归档。model 不可用。',
      deprecated: false,
    },
    scope_exclude: {
      actor: ['approval', 'dashboard', 'human', 'system'],
      schema: schema({
        program_name: str({ minLength: 1 }),
        entries: strArr({ minLength: 1, maxLength: 200 }),
      }, ['program_name', 'entries']),
      idempotent: 'none',
      events: ['scope.excluded'],
      event_limit: 1,
      invariants: ['excludeProgramExists', 'excludeEntryValid', 'excludeMutualExclusion'],
      timeout_ms: 60000,
      agent_note: '向项目追加排除条目（从通配授权中挖掉敏感子域）。与任何其他项目授权重叠 → 拒绝（先 revoke 再排除）。model 不可用。',
      deprecated: false,
    },
    scope_rules_apply: {
      actor: ['approval', 'dashboard', 'human', 'system'],
      schema: schema({
        target: en(['defaults', 'program']),
        program_name: str(),
        rate_limit_qps: int({ minimum: 1, maximum: 1000 }),
        allow_risk: strArr(),
        max_risk: en(RISK_ENUM),
        fixed_egress_ip: bool(),
        allow_intrusive_tools_add: strArr(),
        allow_intrusive_tools_remove: strArr(),
      }, ['target']),
      idempotent: 'auto',
      idempotent_fields: ['target', 'program_name', 'rate_limit_qps', 'allow_risk', 'max_risk', 'fixed_egress_ip', 'allow_intrusive_tools_add', 'allow_intrusive_tools_remove'],
      events: ['scope.rules.changed'],
      event_limit: 1,
      invariants: ['rulesPatchValid'],
      timeout_ms: 60000,
      agent_note: '对全局 defaults 或项目 rules 应用规则补丁（QPS/风险级/侵入白名单增删，原子写）。发布 scope.rules.changed 即时刷新 exec 缓存（替代 mtime 轮询）。model 不可用。',
      deprecated: false,
    },
    program_bind_workspace: {
      actor: ['dashboard', 'human', 'system'],
      schema: schema({
        program_name: str({ minLength: 1 }),
        workspace: { type: ['string', 'null'] },
      }, ['program_name', 'workspace']),
      idempotent: 'none',
      events: ['scope.program.bound'],
      event_limit: 1,
      invariants: ['bindProgramExists'],
      timeout_ms: 60000,
      agent_note: '项目 ↔ DSH 工作区 1:1 软绑定 / 解绑（workspace=null）。绑定后 task 域按会话 cwd 自动归属项目。',
      deprecated: false,
    },
    program_archive: {
      actor: ['dashboard', 'human', 'system'],
      schema: schema({ program_name: str({ minLength: 1 }) }, ['program_name']),
      idempotent: 'none',
      events: [],
      event_limit: 1,
      invariants: ['archiveProgramValid'],
      timeout_ms: 60000,
      agent_note: '归档 programs 镜像行（数据归属保留）。前提：项目已不在 scope.yml（先 scope_revoke 移除授权）。',
      deprecated: false,
    },
    cred_add: {
      actor: ['model', 'script', 'human'],
      schema: schema({
        program_id: str(),
        host: str(),
        cred_type: str({ maxLength: 32 }),
        ref: str({ minLength: 1 }),
        role: str({ maxLength: 64 }),
        note: str({ maxLength: 500 }),
      }, ['ref']),
      idempotent: 'auto',
      idempotent_fields: ['program_id', 'host', 'cred_type', 'ref', 'role', 'note'],
      events: [],
      event_limit: 1,
      invariants: ['credRefValid', 'credHostInScope'],
      timeout_ms: 60000,
      agent_note: '登记凭据引用（绝不存明文）。ref 指向环境变量名/credentials key（须已存在）；host 必须在授权范围（凭据可用范围与授权范围一致）。',
      deprecated: false,
    },
  },
  queries: {
    scope_check: {
      actor: ['model', 'dashboard', 'human', 'system', 'approval', 'scheduler', 'reactor', 'script'],
      params: schema({ target: str({ minLength: 1 }), program: str() }, ['target']),
      agent_note: '授权预检（只读）：检查目标是否在授权范围内。传入 URL/host 均可（自动归一化）。对目标执行主动操作前先自查；未授权目标走 approval_request。',
    },
    scope_list: {
      actor: ['model', 'dashboard', 'human', 'system', 'approval'],
      params: schema({ include_archived: bool() }, []),
      agent_note: '列出授权全景：全局默认策略 + 各项目授权条目/排除清单/规则/工作区绑定（yml 与镜像同框）。',
    },
    program_list: {
      actor: ['model', 'dashboard', 'human', 'system', 'approval'],
      params: schema({
        status: str({ default: '' }),
        limit: int({ minimum: 1, maximum: 500 }),
        offset: int({ minimum: 0 }),
        sort: en(['id', 'status', 'updated_at'], { default: 'id' }),
      }, []),
      agent_note: '列出 programs 表（scope.yml 运行态镜像）。项目是资产/漏洞/任务的顶层作用域。',
    },
    cred_query: {
      actor: ['model', 'dashboard', 'human', 'system', 'approval'],
      params: schema({ program_id: str({ default: '' }), host: str({ default: '' }), limit: int({ minimum: 1, maximum: 500 }) }, []),
      agent_note: '检索凭据引用（只返回引用，不返回明文）。按项目/host 过滤。',
    },
  },
  events: {
    'scope.granted': { payload: { type: 'object' }, redact: [] },
    'scope.revoked': { payload: { type: 'object' }, redact: [] },
    'scope.rules.changed': { payload: { type: 'object' }, redact: [] },
    'scope.excluded': { payload: { type: 'object' }, redact: [] },
    'scope.program.bound': { payload: { type: 'object' }, redact: [] },
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

  function readSnapshot(repo) {
    try { return repo.read() } catch { return { version: 1, defaults: { rate_limit_qps: 50, allow_risk: ['passive', 'active'] }, programs: [], runtime: { credentials_ref: 'env' } } }
  }

  function findProgram(snapshot, name) {
    return (snapshot.programs || []).find((p) => p.name === name) || null
  }

  // 镜像同步（08 §2.3.1 步⑥）：yml 在档项目 upsert active；yml 出档项目 archive。幂等自愈。
  function syncPrograms(repo, snapshot) {
    const active = new Set((snapshot.programs || []).map((p) => p.name))
    const existing = repo.listPrograms()
    for (const p of snapshot.programs || []) {
      repo.upsertProgram({ id: p.name, platform: p.platform || '', max_risk: (p.rules && p.rules.max_risk) || 'active', fixed_egress_ip: !!(p.rules && p.rules.fixed_egress_ip) })
    }
    for (const e of existing) {
      if (!active.has(e.id) && e.status === 'active') repo.archiveProgram(e.id)
    }
  }

  const invariants = {
    grantEntryValid: async (args, repo) => {
      if (!PROGRAM_NAME_RE.test(String(args.program_name || ''))) {
        return { code: 'E_SCOPE_PROGRAM_NAME_INVALID', message: `项目名不合规范: ${args.program_name}`, hint: '项目名须匹配 ^[a-z0-9][a-z0-9-]{0,62}$', retryable: false }
      }
      for (let i = 0; i < args.entries.length; i++) {
        if (!validEntry(args.entries[i])) return { code: 'E_SCOPE_ENTRY_INVALID', message: `第 ${i + 1} 条条目格式不合法: ${args.entries[i]}`, hint: '条目只接受：字面域名 / IP 字面量 / *.domain 后缀通配 / IPv4 CIDR（a.b.c.d/0-32）', retryable: false }
      }
      return null
    },
    grantMutualExclusion: async (args, repo) => {
      const snapshot = readSnapshot(repo)
      const entries = normalizeEntries(args.entries)
      for (const p of snapshot.programs || []) {
        if (p.name === args.program_name) continue
        for (const ex of p.exclude || []) {
          for (const e of entries) {
            if (entriesOverlap(e, ex)) return { code: 'E_SCOPE_MUTUAL_EXCLUSION', message: `条目 ${e} 命中项目 ${p.name} 的排除清单`, hint: `该目标在项目 ${p.name} 排除清单中——先与 ${p.name} 协调或经 approval 提请 exclude-exception`, retryable: false }
          }
        }
      }
      return null
    },
    revokeProgramExists: async (args, repo) => {
      const snapshot = readSnapshot(repo)
      if (!findProgram(snapshot, args.program_name)) return { code: 'E_NOT_FOUND', message: `项目不在 yml: ${args.program_name}`, hint: '先用 scope_list 核对项目当前条目——yml 可能已被 spool sync 或人工修改', retryable: false }
      return null
    },
    revokeEntriesExist: async (args, repo) => {
      const snapshot = readSnapshot(repo)
      const p = findProgram(snapshot, args.program_name)
      if (!p) return null
      for (const e of args.entries) {
        if (!(p.scope || []).includes(String(e).trim().toLowerCase())) return { code: 'E_NOT_FOUND', message: `条目不存在于项目 scope: ${e}`, hint: '先用 scope_list 核对现状——revoke 须逐字存在（不做语义展开）', retryable: false }
      }
      return null
    },
    excludeProgramExists: async (args, repo) => {
      const snapshot = readSnapshot(repo)
      if (!findProgram(snapshot, args.program_name)) return { code: 'E_NOT_FOUND', message: `项目不在 yml: ${args.program_name}`, hint: '先用 scope_list 核对现状', retryable: false }
      return null
    },
    excludeEntryValid: async (args, repo) => {
      for (let i = 0; i < args.entries.length; i++) {
        if (!validEntry(args.entries[i])) return { code: 'E_SCOPE_ENTRY_INVALID', message: `第 ${i + 1} 条排除条目格式不合法: ${args.entries[i]}`, hint: '条目只接受：字面域名 / IP / *.domain / IPv4 CIDR', retryable: false }
      }
      return null
    },
    excludeMutualExclusion: async (args, repo) => {
      const snapshot = readSnapshot(repo)
      const entries = normalizeEntries(args.entries)
      for (const p of snapshot.programs || []) {
        if (p.name === args.program_name) continue
        for (const s of p.scope || []) {
          for (const e of entries) {
            if (entriesOverlap(e, s)) return { code: 'E_SCOPE_MUTUAL_EXCLUSION', message: `排除条目 ${e} 命中项目 ${p.name} 授权范围`, hint: `该目标已授权给项目 ${p.name}——先对 ${p.name} scope_revoke，或走 approval 提请 exclude-exception`, retryable: false }
          }
        }
      }
      return null
    },
    rulesPatchValid: async (args, repo) => {
      if (args.target === 'program' && !args.program_name) return { code: 'E_SCHEMA', message: 'target=program 必须传 program_name', hint: '项目级补丁须指明项目', retryable: false }
      if (args.target === 'defaults' && args.program_name) return { code: 'E_SCHEMA', message: 'target=defaults 不得传 program_name', hint: 'defaults 级补丁不针对项目', retryable: false }
      if (args.target === 'defaults') {
        if (args.max_risk !== undefined) return { code: 'E_SCOPE_RULES_INVALID', message: 'max_risk 仅 program 级', hint: 'max_risk/fixed_egress_ip/allow_intrusive_tools 是项目级字段', retryable: false }
        if (args.fixed_egress_ip !== undefined) return { code: 'E_SCOPE_RULES_INVALID', message: 'fixed_egress_ip 仅 program 级', hint: 'fixed_egress_ip 是项目级字段', retryable: false }
        if (args.allow_intrusive_tools_add || args.allow_intrusive_tools_remove) return { code: 'E_SCOPE_RULES_INVALID', message: 'allow_intrusive_tools 仅 program 级', hint: '侵入白名单是项目级字段', retryable: false }
        if (args.allow_risk) for (const r of args.allow_risk) if (!ALLOW_RISK_ENUM.includes(r)) return { code: 'E_SCOPE_RULES_INVALID', message: `allow_risk 含非法值 ${r}`, hint: 'allow_risk ⊆ {passive,active}；intrusive 走审批白名单', retryable: false }
      }
      if (args.target === 'program') {
        if (args.rate_limit_qps !== undefined) return { code: 'E_SCOPE_RULES_INVALID', message: 'rate_limit_qps 仅 defaults 级', hint: 'QPS 限速是全局字段', retryable: false }
        if (args.allow_risk !== undefined) return { code: 'E_SCOPE_RULES_INVALID', message: 'allow_risk 仅 defaults 级', hint: 'allow_risk 是全局字段', retryable: false }
      }
      const add = new Set(args.allow_intrusive_tools_add || [])
      const rm = new Set(args.allow_intrusive_tools_remove || [])
      for (const t of add) if (rm.has(t)) return { code: 'E_SCOPE_RULES_INVALID', message: `allow_intrusive_tools_add 与 remove 交集: ${t}`, hint: '同一工具不能同时增删', retryable: false }
      for (const t of [...add, ...rm]) if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(t)) return { code: 'E_SCOPE_RULES_INVALID', message: `工具名格式非法: ${t}`, hint: '工具名匹配 ^[a-z0-9][a-z0-9_-]{0,63}$', retryable: false }
      return null
    },
    bindProgramExists: async (args, repo) => {
      if (!repo.getProgram(args.program_name)) return { code: 'E_NOT_FOUND', message: `项目不在 programs 表: ${args.program_name}`, hint: '项目须在 programs 表（yml 或 archived 镜像）', retryable: false }
      return null
    },
    archiveProgramValid: async (args, repo) => {
      const snapshot = readSnapshot(repo)
      const row = repo.getProgram(args.program_name)
      if (!row) return { code: 'E_NOT_FOUND', message: `项目不在 programs 表: ${args.program_name}`, hint: '核对 program_list', retryable: false }
      if (findProgram(snapshot, args.program_name)) return { code: 'E_INVARIANT', message: `项目仍在 scope.yml 授权中: ${args.program_name}`, hint: '先 scope_revoke（条目清空自动归档），不要直接归档镜像', retryable: false }
      return null
    },
    credRefValid: async (args, repo) => {
      if (!REF_FORMAT_RE.test(String(args.ref || ''))) return { code: 'E_SCOPE_CRED_REF_FORMAT', message: `ref 不是引用形态: ${args.ref}`, hint: 'ref 必须是环境变量名/credentials key（如 EXAMPLE_API_TOKEN），明文密钥禁止入库', retryable: false }
      if (!(args.ref in process.env)) return { code: 'E_SCOPE_CRED_REF_MISSING', message: `ref 指向的环境变量不存在: ${args.ref}`, hint: '确认 .env 已配置且服务已重启加载', retryable: false }
      const note = String(args.note || '')
      if (/Bearer\s/i.test(note) || /[A-Za-z0-9+/]{40,}={0,2}/.test(note)) return { code: 'E_SCHEMA', message: 'note 疑似含明文凭据特征', hint: 'note 禁止明文密钥特征', retryable: false }
      return null
    },
    credHostInScope: async (args, repo) => {
      if (!args.host) return null
      const snapshot = readSnapshot(repo)
      const chk = checkTargetScope(args.host, snapshot)
      if (!chk.allow) return { code: 'E_SCOPE_CRED_HOST_OUT_OF_SCOPE', message: `host 不在授权范围: ${args.host}`, hint: '该 host 未授权（scope.yml fail-closed）——先经 approval 提请授权，凭据范围必须与授权范围一致', retryable: false }
      return null
    },
  }

  const commands = {
    scope_grant: async (args, repo) => {
      const snapshot = readSnapshot(repo)
      syncPrograms(repo, snapshot)
      const entries = normalizeEntries(args.entries)
      let program = findProgram(snapshot, args.program_name)
      const programCreated = !program
      if (!program) {
        program = { name: args.program_name, platform: args.platform || '', scope: [], exclude: [], rules: { max_risk: args.max_risk || 'active', fixed_egress_ip: !!args.fixed_egress_ip, workspace: '', allow_intrusive_tools: [] }, finding_db: args.finding_db || '' }
        snapshot.programs.push(program)
      } else if (args.max_risk !== undefined) {
        program.rules.max_risk = args.max_risk
      }
      const existingSet = new Set(program.scope || [])
      const granted = []
      const skipped = []
      for (const e of entries) if (!existingSet.has(e)) granted.push(e); else skipped.push(e)
      // 吸收本项目排除（互斥维持动作 I2）
      const removedExcludes = []
      const excludeSet = new Set(program.exclude || [])
      for (const e of granted) {
        for (const ex of program.exclude || []) {
          if (entriesOverlap(e, ex)) { excludeSet.delete(ex); removedExcludes.push(ex) }
        }
      }
      program.exclude = [...excludeSet].sort()
      for (const e of granted) if (!existingSet.has(e)) existingSet.add(e)
      program.scope = [...existingSet].sort()
      repo.writeAtomic(snapshot)
      syncPrograms(repo, snapshot)
      const subject = primaryHostOfEntries(granted.length ? granted : entries)
      return {
        data: {
          program_name: args.program_name, program_created: programCreated,
          granted, skipped_existing: skipped, removed_excludes: removedExcludes,
          scope_size: program.scope.length,
        },
        events: [{
          name: 'scope.granted',
          payload: {
            program_name: args.program_name, program_id: args.program_name, program_created: programCreated,
            subject, domain: subject, entries: granted, removed_excludes: removedExcludes,
            request_id: args.request_id ?? null,
          },
        }],
        before: { program_name: args.program_name, existed: !programCreated },
        after: { program_name: args.program_name, granted, removed_excludes: removedExcludes },
        target: { program_name: args.program_name },
      }
    },

    scope_revoke: async (args, repo) => {
      const snapshot = readSnapshot(repo)
      syncPrograms(repo, snapshot)
      const program = findProgram(snapshot, args.program_name)
      const revokeSet = new Set(args.entries.map((e) => String(e).trim().toLowerCase()))
      const remaining = (program.scope || []).filter((e) => !revokeSet.has(e))
      program.scope = remaining
      let programRemoved = false
      if (remaining.length === 0) {
        snapshot.programs = snapshot.programs.filter((p) => p.name !== args.program_name)
        programRemoved = true
      }
      repo.writeAtomic(snapshot)
      syncPrograms(repo, snapshot)
      return {
        data: { program_name: args.program_name, revoked: args.entries, program_removed: programRemoved, programs_archived: programRemoved },
        events: [{ name: 'scope.revoked', payload: { program_name: args.program_name, entries: args.entries, program_removed: programRemoved, programs_archived: programRemoved } }],
        after: { program_name: args.program_name, program_removed: programRemoved },
        target: { program_name: args.program_name },
      }
    },

    scope_exclude: async (args, repo) => {
      const snapshot = readSnapshot(repo)
      syncPrograms(repo, snapshot)
      const program = findProgram(snapshot, args.program_name)
      const entries = normalizeEntries(args.entries)
      const cur = new Set(program.exclude || [])
      const added = []
      for (const e of entries) if (!cur.has(e)) { cur.add(e); added.push(e) }
      program.exclude = [...cur].sort()
      repo.writeAtomic(snapshot)
      syncPrograms(repo, snapshot)
      return {
        data: { program_name: args.program_name, excluded: added, exclude_size: program.exclude.length },
        events: [{ name: 'scope.excluded', payload: { program_name: args.program_name, entries: added } }],
        after: { program_name: args.program_name, excluded: added },
        target: { program_name: args.program_name },
      }
    },

    scope_rules_apply: async (args, repo) => {
      const snapshot = readSnapshot(repo)
      syncPrograms(repo, snapshot)
      const level = args.target
      const before = {}
      const after = {}
      const patch = {}
      if (level === 'defaults') {
        if (args.rate_limit_qps !== undefined) { before.rate_limit_qps = snapshot.defaults.rate_limit_qps; snapshot.defaults.rate_limit_qps = args.rate_limit_qps; after.rate_limit_qps = args.rate_limit_qps; patch.rate_limit_qps = args.rate_limit_qps }
        if (args.allow_risk !== undefined) { before.allow_risk = snapshot.defaults.allow_risk; snapshot.defaults.allow_risk = args.allow_risk; after.allow_risk = args.allow_risk; patch.allow_risk = args.allow_risk }
      } else {
        const program = findProgram(snapshot, args.program_name)
        if (!program) throwErr('E_NOT_FOUND', `项目不在 yml: ${args.program_name}`, '先 scope_list 核对现状')
        if (args.max_risk !== undefined) { before.max_risk = program.rules.max_risk; program.rules.max_risk = args.max_risk; after.max_risk = args.max_risk; patch.max_risk = args.max_risk }
        if (args.fixed_egress_ip !== undefined) { before.fixed_egress_ip = program.rules.fixed_egress_ip; program.rules.fixed_egress_ip = args.fixed_egress_ip; after.fixed_egress_ip = args.fixed_egress_ip; patch.fixed_egress_ip = args.fixed_egress_ip }
        const tools = new Set(program.rules.allow_intrusive_tools || [])
        for (const t of args.allow_intrusive_tools_add || []) tools.add(t)
        for (const t of args.allow_intrusive_tools_remove || []) tools.delete(t)
        if (args.allow_intrusive_tools_add || args.allow_intrusive_tools_remove) {
          before.allow_intrusive_tools = program.rules.allow_intrusive_tools || []
          program.rules.allow_intrusive_tools = [...tools].sort()
          after.allow_intrusive_tools = program.rules.allow_intrusive_tools
          if (args.allow_intrusive_tools_add) patch.allow_intrusive_tools_add = args.allow_intrusive_tools_add
          if (args.allow_intrusive_tools_remove) patch.allow_intrusive_tools_remove = args.allow_intrusive_tools_remove
        }
      }
      repo.writeAtomic(snapshot)
      syncPrograms(repo, snapshot)
      return {
        data: { target: level, program_name: args.program_name || null, before, after },
        events: [{ name: 'scope.rules.changed', payload: { level, program_name: args.program_name || null, patch, before, after } }],
        after: { target: level, after },
        target: { target: level, program_name: args.program_name || null },
      }
    },

    program_bind_workspace: async (args, repo) => {
      syncPrograms(repo, readSnapshot(repo))
      let workspaceId = null
      let workspacePath = null
      if (args.workspace !== null && args.workspace !== undefined && args.workspace !== '') {
        // workspace 标题或路径；无 workspaceRegistry 时（headless/测试）以字符串原样存 path 兜底
        workspacePath = String(args.workspace)
        workspaceId = String(args.workspace)
      }
      repo.bindWorkspace(args.program_name, workspaceId, workspacePath)
      return {
        data: { program_name: args.program_name, workspace_id: workspaceId, workspace_path: workspacePath, unbound: workspaceId === null },
        events: [{ name: 'scope.program.bound', payload: { program_name: args.program_name, workspace_id: workspaceId, workspace_path: workspacePath, unbound: workspaceId === null } }],
        after: { program_name: args.program_name, workspace_id: workspaceId },
        target: { program_name: args.program_name },
      }
    },

    program_archive: async (args, repo) => {
      syncPrograms(repo, readSnapshot(repo))
      repo.archiveProgram(args.program_name)
      return { data: { program_name: args.program_name, status: 'archived' }, target: { program_name: args.program_name } }
    },

    cred_add: async (args, repo) => {
      const dup = repo.findCredDuplicate({ program_id: args.program_id || null, host: args.host || '', cred_type: args.cred_type || '', ref: args.ref })
      if (dup) throwErr('E_SCOPE_CRED_DUPLICATE', `该引用已登记（id=${dup.id}）`, '勿重复登记', false)
      const id = repo.insertCred({ program_id: args.program_id || null, host: args.host || '', cred_type: args.cred_type || '', ref: args.ref, role: args.role || '', note: args.note || '' })
      return {
        data: { id, program_id: args.program_id || null, host: args.host || '', ref: args.ref },
        after: { id },
        target: { ref: args.ref },
      }
    },
  }

  const queries = {
    scope_check: async (args, repo) => {
      const snapshot = readSnapshot(repo)
      const chk = checkTargetScope(args.target, snapshot, args.program || null)
      return chk
    },
    scope_list: async (args, repo) => {
      const snapshot = readSnapshot(repo)
      syncPrograms(repo, snapshot)
      const includeArchived = args.include_archived !== false
      const programs = snapshot.programs || []
      const dbRows = repo.listPrograms()
      const programsOut = programs.map((p) => {
        const row = dbRows.find((r) => r.id === p.name)
        return {
          name: p.name, platform: p.platform || '', scope: p.scope || [], exclude: p.exclude || [],
          max_risk: (p.rules && p.rules.max_risk) || 'active', fixed_egress_ip: !!(p.rules && p.rules.fixed_egress_ip),
          workspace: (p.rules && p.rules.workspace) || '', finding_db: p.finding_db || '',
          allow_intrusive_tools: (p.rules && p.rules.allow_intrusive_tools) || [],
          db: row ? { status: row.status, workspace_id: row.workspace_id || null, workspace_path: row.workspace_path || null } : null,
        }
      })
      const archived = includeArchived
        ? dbRows.filter((r) => r.status === 'archived' && !programs.some((p) => p.name === r.id)).map((r) => ({ id: r.id, status: r.status, platform: r.platform, max_risk: r.max_risk, workspace_id: r.workspace_id || null, workspace_path: r.workspace_path || null }))
        : []
      return { defaults: snapshot.defaults || { egress_proxy: '', rate_limit_qps: 50, allow_risk: ['passive', 'active'] }, programs: programsOut, archived }
    },
    program_list: async (args, repo) => {
      let rows = repo.listPrograms()
      if (args.status) rows = rows.filter((r) => r.status === args.status)
      const total = rows.length
      if (args.sort === 'status') rows.sort((a, b) => String(a.status).localeCompare(String(b.status)))
      else if (args.sort === 'updated_at') rows.sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0))
      else rows.sort((a, b) => String(a.id).localeCompare(String(b.id)))
      const offset = Number(args.offset) || 0
      const limit = Math.min(Number(args.limit) || 50, 500)
      return { rows: rows.slice(offset, offset + limit).map((r) => ({ id: r.id, platform: r.platform, status: r.status, max_risk: r.max_risk, workspace_id: r.workspace_id || null, workspace_path: r.workspace_path || null, created_at: r.created_at, updated_at: r.updated_at })), total }
    },
    cred_query: async (args, repo) => {
      const rows = repo.listCredsWhere({ program_id: args.program_id || '', host: args.host || '', limit: args.limit || 50 })
      return { rows, total: rows.length }
    },
  }

  return { ...commands, queries, invariants, subscribers: {} }
}

function primaryHostOfEntries(entries) {
  for (const e of entries) if (e.startsWith('*.')) return e.slice(2)
  return entries.find((e) => !e.includes('/') && !e.includes(':')) || entries[0] || ''
}

// ---------------------------------------------------------------------------
// 组装
// ---------------------------------------------------------------------------

export function buildScopeDomain(opts = {}) {
  const dataDir = opts.dataDir || DEFAULT_DATA_DIR
  const sqlite = createScopeSqliteBackend(opts.backendOptions || {})
  const file = createScopeFileBackend({ dataDir, scopeFile: opts.scopeFile })
  const backend = {
    capabilities: {},
    factory(db) {
      return { ...sqlite.factory(db), ...file.factory() }
    },
  }
  return {
    manifest: SCOPE_MANIFEST,
    handlers: makeHandlers({ ...opts, dataDir }),
    backend,
  }
}

export function apply(ctx, config = {}) {
  const dataDir = process.env.SEC_DATA_DIR || process.env.DSH_HOME || DEFAULT_DATA_DIR
  try {
    ctx.inject(['secDomainBus'], (child) => {
      const bus = child.secDomainBus
      const domain = buildScopeDomain({
        dataDir,
        dispatch: (d, v, a, c) => bus.dispatch(d, v, a, c),
        query: (d, n, a, c) => bus.query(d, n, a, c),
      })
      const res = bus.registry.register(domain)
      if (res.ok) log(`scope 域注册成功（registered=${res.registered}）`)
      else log(`scope 域注册被拒：${res.error?.code} ${res.error?.message}`)
      return () => {}
    })
  } catch (e) {
    log(`secDomainBus 注入失败：${e?.message}——scope 域未注册（总线必须先行挂载）`)
  }
  return null
}
