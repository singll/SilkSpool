// ==============================================================================
// @silksec/sec-domain-bus — SilkSecAgent 领域总线（v5）
//
// 契约：doc/secagent/v5/01-bus.md（总线）+ doc/secagent/v5/00-conventions.md（宪法）
//
// 对外（cordis）：name='sec-domain-bus'，inject=['tools']，apply() provide('secDomainBus')
// 域插件 apply() 不 provide 任何业务方法，只把 manifest+handlers+backend 交给
// registry.register()（经 facade.registry.register）。
//
// 零依赖：node:fs / node:path / node:crypto / node:async_hooks / node:sqlite
// ==============================================================================

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { DatabaseSync } from 'node:sqlite'

export const name = 'sec-domain-bus'
export const inject = ['tools']

const DATA_DIR = process.env.SEC_DATA_DIR || '/opt/silkspool/dsh/data'
const DB_FILE_DEFAULT = path.join(DATA_DIR, 'asset-graph.db')
const MANIFEST_SCHEMA_VERSION = 1
const EVENT_MAX_BYTES = 8192
const EVENT_MAX_PER_CMD = 1
const NESTING_DEPTH_MAX = 3
const AUDIT_RETRY_MS = [1000, 5000, 30000]
const BACKOFF_MS = [1000, 5000, 30000, 120000, 600000, 3600000, 21600000, 21600000]
const LOCK_STALE_MS = 180000
const PRUNE_COOLDOWN_MS = 6 * 3600000
const IDEM_RETENTION_MS = 7 * 86400000
const IDEM_MAX_ROWS = 10000

const DOMAIN_WHITELIST = new Set([
  'vuln', 'asset', 'endpoint', 'task', 'fact', 'know', 'scope', 'approval',
  'exec', 'ledger', 'report', 'proxy', 'fgs', 'eval', 'authz', 'bus',
])
const ACTOR_WHITELIST = new Set([
  'model', 'dashboard', 'script', 'webhook', 'scheduler', 'approval',
  'reactor', 'system', 'platform', 'human',
])
const BANNED_VERB_WORDS = ['update', 'set', 'save', 'modify']
const BANNED_PARAM_NAMES = ['status', 'to', 'state']
// know 域子仓前缀豁免（宪法 §二）：exp_update / vc_save / pb_save 是 v4 内化的语义动词名
// （exp_update=内容以新代旧的原子重写、vc_save/pb_save=状态机语义动词），非自由态 update/save；
// 由 07-know.md §1.1 命名裁定背书，禁用词子串检查对它们豁免。
const BANNED_WORD_EXEMPT_VERBS = new Set(['exp_update', 'vc_save', 'pb_save', 'update_note'])

const log = (msg) => { try { process.stderr.write(`[sec-domain-bus] ${msg}\n`) } catch { /* noop */ } }

// ---------------------------------------------------------------------------
// 极简 YAML 解析（bus.aliases.yaml / 域 manifest.yaml 用到的子集）
// ---------------------------------------------------------------------------

export function parseYaml(text) {
  const lines = []
  for (const raw of String(text).split('\n')) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue
    lines.push({ indent: raw.length - raw.trimStart().length, text: stripComment(raw.trim()) })
  }
  let pos = 0
  function stripComment(s) {
    let q = null
    for (let i = 0; i < s.length; i++) {
      const c = s[i]
      if (q) { if (c === q) q = null; continue }
      if (c === '"' || c === "'") { q = c; continue }
      if (c === '#' && (i === 0 || s[i - 1] === ' ')) return s.slice(0, i).trimEnd()
    }
    return s
  }
  function parseScalar(s) {
    s = s.trim()
    if (s === '') return ''
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1)
    if (s === 'true') return true
    if (s === 'false') return false
    if (s === 'null' || s === '~') return null
    if (s === '[]') return []
    if (s === '{}') return {}
    if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s)
    if (s.startsWith('[') && s.endsWith(']')) {
      const inner = s.slice(1, -1).trim()
      return inner ? splitInline(inner).map(parseScalar) : []
    }
    return s
  }
  function splitInline(s) {
    const out = []; let cur = ''; let q = null
    for (const c of s) {
      if (q) { cur += c; if (c === q) q = null; continue }
      if (c === '"' || c === "'") { q = c; cur += c; continue }
      if (c === ',') { out.push(cur.trim()); cur = ''; continue }
      cur += c
    }
    if (cur.trim()) out.push(cur.trim())
    return out
  }
  function parseBlock(indent) {
    if (pos >= lines.length || lines[pos].indent < indent) return null
    return lines[pos].text.startsWith('- ') || lines[pos].text === '-' ? parseList(indent) : parseMap(indent)
  }
  function parseMap(indent) {
    const obj = {}
    while (pos < lines.length && lines[pos].indent === indent && !lines[pos].text.startsWith('- ')) {
      const m = lines[pos].text.match(/^([^:]+):\s*(.*)$/)
      if (!m) throw new Error(`YAML 解析失败（第 ${pos + 1} 行）: ${lines[pos].text}`)
      pos++
      const key = m[1].trim()
      if (m[2] !== '') { obj[key] = parseScalar(m[2]); continue }
      if (pos < lines.length && lines[pos].indent > indent) obj[key] = parseBlock(lines[pos].indent)
      else obj[key] = null
    }
    return obj
  }
  function parseList(indent) {
    const arr = []
    while (pos < lines.length && lines[pos].indent === indent && (lines[pos].text.startsWith('- ') || lines[pos].text === '-')) {
      const rest = lines[pos].text === '-' ? '' : lines[pos].text.slice(2)
      if (rest === '') { pos++; arr.push(parseBlock(indent + 2)); continue }
      const m = rest.match(/^([^:]+):\s*(.*)$/)
      if (m && !rest.startsWith('"') && !rest.startsWith("'")) {
        pos++
        const item = {}
        if (m[2] !== '') item[m[1].trim()] = parseScalar(m[2])
        else if (pos < lines.length && lines[pos].indent > indent + 2) item[m[1].trim()] = parseBlock(lines[pos].indent)
        else item[m[1].trim()] = null
        while (pos < lines.length && lines[pos].indent === indent + 2 && !lines[pos].text.startsWith('- ')) {
          const m2 = lines[pos].text.match(/^([^:]+):\s*(.*)$/)
          if (!m2) throw new Error(`YAML 解析失败（第 ${pos + 1} 行）: ${lines[pos].text}`)
          pos++
          if (m2[2] !== '') item[m2[1].trim()] = parseScalar(m2[2])
          else if (pos < lines.length && lines[pos].indent > indent + 2) item[m2[1].trim()] = parseBlock(lines[pos].indent)
          else item[m2[1].trim()] = null
        }
        arr.push(item)
      } else {
        pos++
        arr.push(parseScalar(rest))
      }
    }
    return arr
  }
  if (lines.length === 0) return {}
  return parseBlock(lines[0].indent)
}

// ---------------------------------------------------------------------------
// 极简 JSON Schema 校验（type/required/properties/additionalProperties/enum/
// items/minimum/maximum/minLength/maxLength）
// ---------------------------------------------------------------------------

export function validateSchema(value, schema) {
  const errors = []
  const walk = (v, s, pathStr) => {
    if (!s || typeof s !== 'object') return
    if (s.type) {
      const types = Array.isArray(s.type) ? s.type : [s.type]
      if (!types.some((tt) => checkType(v, tt))) {
        errors.push({ field: pathStr || '(root)', message: `期望类型 ${types.join('/')}，实际 ${actualType(v)}` })
        return
      }
    }
    if (s.enum && !s.enum.includes(v)) errors.push({ field: pathStr || '(root)', message: `值必须在 [${s.enum.join(', ')}] 内` })
    if (typeof v === 'number' && Number.isFinite(v)) {
      if (s.minimum !== undefined && v < s.minimum) errors.push({ field: pathStr || '(root)', message: `最小值 ${s.minimum}` })
      if (s.maximum !== undefined && v > s.maximum) errors.push({ field: pathStr || '(root)', message: `最大值 ${s.maximum}` })
    }
    if (typeof v === 'string') {
      if (s.minLength !== undefined && v.length < s.minLength) errors.push({ field: pathStr || '(root)', message: `最少 ${s.minLength} 字符` })
      if (s.maxLength !== undefined && v.length > s.maxLength) errors.push({ field: pathStr || '(root)', message: `最多 ${s.maxLength} 字符` })
    }
    if (Array.isArray(v) && s.items) v.forEach((item, i) => walk(item, s.items, `${pathStr}[${i}]`))
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const props = s.properties || {}
      if (s.additionalProperties === false) {
        for (const k of Object.keys(v)) {
          if (!(k in props)) errors.push({ field: `${pathStr ? pathStr + '.' : ''}${k}`, message: '未知参数（additionalProperties=false）' })
        }
      }
      for (const [k, ps] of Object.entries(props)) {
        if (k in v) walk(v[k], ps, `${pathStr ? pathStr + '.' : ''}${k}`)
      }
    }
  }
  walk(value, schema, '')
  if (Array.isArray(schema.required)) {
    for (const r of schema.required) {
      if (value === undefined || value === null || !(r in value)) errors.push({ field: r, message: '必填缺失' })
    }
  }
  return { ok: errors.length === 0, errors }
}

function checkType(v, t) {
  switch (t) {
    case 'string': return typeof v === 'string'
    case 'integer': return Number.isInteger(v)
    case 'number': return typeof v === 'number' && Number.isFinite(v)
    case 'boolean': return typeof v === 'boolean'
    case 'array': return Array.isArray(v)
    case 'object': return v !== null && typeof v === 'object' && !Array.isArray(v)
    case 'null': return v === null
    default: return true
  }
}
function actualType(v) {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  return typeof v
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

function sha1(str) { return crypto.createHash('sha1').update(String(str)).digest('hex') }
function createId(prefix = 'evt') { return `${prefix}_${Date.now().toString(36)}${crypto.randomBytes(8).toString('hex')}` }
function canonicalStringify(obj) {
  const seen = new WeakSet()
  const norm = (v) => {
    if (v === null || typeof v !== 'object') return v
    if (seen.has(v)) return '[circular]'
    seen.add(v)
    if (Array.isArray(v)) return v.map(norm)
    const out = {}
    for (const k of Object.keys(v).sort()) out[k] = norm(v[k])
    return out
  }
  return JSON.stringify(norm(obj))
}
function deepClone(obj) { return obj === undefined ? undefined : JSON.parse(JSON.stringify(obj)) }
function plain(row) { return row ? { ...row } : row }
function plainAll(rows) { return Array.isArray(rows) ? rows.map((r) => ({ ...r })) : rows }
function isPlainObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v) }
function stripDomainPrefix(fullName, domain) {
  const p = `${domain}_`
  return fullName.startsWith(p) ? fullName.slice(p.length) : fullName
}
function fileExists(p) { try { return fs.existsSync(p) } catch { return false } }

function acquireLock(lockPath, pid) {
  const now = Date.now()
  try {
    if (fs.existsSync(lockPath)) {
      const raw = fs.readFileSync(lockPath, 'utf8').trim()
      let holder = null
      try { holder = JSON.parse(raw) } catch { holder = { pid: Number(raw) || 0, ts: 0 } }
      const fresh = now - (holder.ts || 0) < LOCK_STALE_MS
      if (fresh && holder.pid && holder.pid !== pid) {
        let alive = false
        try { process.kill(holder.pid, 0); alive = true } catch { alive = false }
        if (alive) return false
      }
    }
  } catch { /* 读锁失败视为可抢占 */ }
  try { fs.writeFileSync(lockPath, JSON.stringify({ pid, ts: now })); return true } catch { return false }
}
function releaseLock(lockPath, pid) {
  try {
    const raw = fs.readFileSync(lockPath, 'utf8').trim()
    const holder = JSON.parse(raw)
    if (holder.pid === pid) fs.unlinkSync(lockPath)
  } catch { /* noop */ }
}
function touchLock(lockPath, pid) {
  try { fs.writeFileSync(lockPath, JSON.stringify({ pid, ts: Date.now() })) } catch { /* noop */ }
}

// ---------------------------------------------------------------------------
// Manifest 结构校验（R1）与 lint（R2/R3/R5）
// ---------------------------------------------------------------------------

export function validateManifestShape(manifest) {
  const errs = []
  if (!manifest || typeof manifest !== 'object') return { ok: false, errors: ['manifest 不是对象'] }
  if (typeof manifest.domain !== 'string' || !DOMAIN_WHITELIST.has(manifest.domain)) {
    errs.push(`domain 非法：${String(manifest.domain)}（须在 [${[...DOMAIN_WHITELIST].join(', ')}] 内）`)
  }
  if (!Number.isInteger(manifest.version) || manifest.version < 1) errs.push('version 必须为 >=1 的整数')
  if (typeof manifest.service !== 'string' || manifest.service !== `secDomain.${manifest.domain}`) errs.push(`service 必须 = secDomain.${manifest.domain}`)
  if (typeof manifest.description !== 'string') errs.push('description 缺失')
  if (!isPlainObject(manifest.owns)) errs.push('owns 缺失')
  if (!Array.isArray(manifest.owns.tables)) errs.push('owns.tables 必须为数组')
  if (!Array.isArray(manifest.owns.files)) errs.push('owns.files 必须为数组')
  if (!isPlainObject(manifest.commands)) errs.push('commands 缺失')
  if (!isPlainObject(manifest.queries)) errs.push('queries 缺失')
  if (!isPlainObject(manifest.events)) errs.push('events 缺失')
  if (!isPlainObject(manifest.subscribes)) errs.push('subscribes 缺失')
  if (typeof manifest.backend !== 'string') errs.push('backend 缺失')
  return { ok: errs.length === 0, errors: errs }
}

export function validateManifestLint(manifest) {
  const errs = []
  const commands = manifest.commands || {}
  const queries = manifest.queries || {}
  const events = manifest.events || {}
  const subscribes = manifest.subscribes || {}
  let defForParam = null

  for (const [full, def] of Object.entries(commands)) {
    const verb = stripDomainPrefix(full, manifest.domain)
    // 只校验动词本身（禁用词约束的是动词命名，非域前缀——asset 域名含 "set" 子串是合法域名，
    // 若连 full 一起查会把 asset_* 全误杀）；know 域子仓豁免动词跳过（见常量注）。
    const bannedHit = BANNED_WORD_EXEMPT_VERBS.has(verb) ? [] : BANNED_VERB_WORDS.filter((w) => verb.includes(w))
    if (bannedHit.length) errs.push(`R2 禁用词：动词 ${full} 含 ${bannedHit.join('/')}`)
    if (!isPlainObject(def)) { errs.push(`命令 ${full} 定义缺失`); continue }
    if (!Array.isArray(def.actor) || def.actor.length === 0) errs.push(`命令 ${full} actor 白名单为空`)
    for (const a of def.actor || []) if (!ACTOR_WHITELIST.has(a)) errs.push(`命令 ${full} actor ${a} 不在值域`)
    if (!def.schema || !isPlainObject(def.schema)) errs.push(`命令 ${full} schema 缺失`)
    else if (def.schema.additionalProperties !== false) errs.push(`命令 ${full} schema 必须 additionalProperties:false`)
    if (!['natural', 'explicit', 'auto', 'none', 'explicit_only'].includes(def.idempotent)) errs.push(`命令 ${full} idempotent 必须 natural|explicit|auto|none|explicit_only`)
    if (def.idempotent === 'natural' && !def.idempotent_natural) errs.push(`命令 ${full} 自然键必须声明 idempotent_natural`)
    if (!Array.isArray(def.events)) errs.push(`命令 ${full} events 必须为数组`)
    if (!Array.isArray(def.invariants)) errs.push(`命令 ${full} invariants 必须为数组`)
    if (typeof def.agent_note !== 'string' || def.agent_note.length === 0) errs.push(`命令 ${full} agent_note 缺失`)
    else if (def.agent_note.length > 240) errs.push(`命令 ${full} agent_note 超 240 字（${def.agent_note.length}）`)
    if (def.timeout_ms !== undefined && (!Number.isInteger(def.timeout_ms) || def.timeout_ms <= 0 || def.timeout_ms > 3670000)) errs.push(`命令 ${full} timeout_ms 超限`)
    for (const ev of def.events || []) if (!(ev in events)) errs.push(`R5 悬空事件引用：${full} → ${ev}`)
  }

  for (const [full, def] of Object.entries(queries)) {
    if (!isPlainObject(def)) { errs.push(`查询 ${full} 定义缺失`); continue }
    if (!Array.isArray(def.actor) || def.actor.length === 0) errs.push(`查询 ${full} actor 白名单为空`)
    for (const a of def.actor || []) if (!ACTOR_WHITELIST.has(a)) errs.push(`查询 ${full} actor ${a} 不在值域`)
    if (!def.params || !isPlainObject(def.params)) errs.push(`查询 ${full} params 缺失`)
    else if (def.params.additionalProperties !== false) errs.push(`查询 ${full} params 必须 additionalProperties:false`)
    if (typeof def.agent_note !== 'string' || def.agent_note.length === 0) errs.push(`查询 ${full} agent_note 缺失`)
    else if (def.agent_note.length > 120) errs.push(`查询 ${full} agent_note 超 120 字（${def.agent_note.length}）`)
  }

  const paramCheck = (schema, prefix) => {
    if (!schema || !isPlainObject(schema)) return
    for (const k of Object.keys(schema.properties || {})) {
      if (!BANNED_PARAM_NAMES.includes(k)) continue
      // R3 治理通道豁免（宪法 §四.1）：fact_transition/know_transition 带 to 参数是
      // 「调度判定型 + 仅 system/human + 不向模型注册」三条件豁免；status/state 不豁免。
      if (k === 'to' && defForParam && Array.isArray(defForParam.actor) && defForParam.actor.length > 0 && defForParam.actor.every((a) => a === 'system' || a === 'human')) continue
      errs.push(`R3 参数名 lint：${prefix}.${k} 禁用（状态机私有）`)
    }
  }
  // R3 参数名 lint：只约束命令 schema 的顶层参数（状态机私有——写侧禁 status/to/state）。
  // 嵌套数据字段（如 endpoint_upsert 行内的 HTTP status、TSV 的 status 列）是数据属性非状态机控制，豁免；
  // 查询 params 是可见域谓词（宪法 §十一.4：谓词是查询参数），按 status 等过滤合法，豁免。
  for (const [full, def] of Object.entries(commands)) {
    defForParam = def
    paramCheck(def?.schema, full)
  }
  defForParam = null

  for (const [nm, edef] of Object.entries(events)) {
    if (!isPlainObject(edef)) errs.push(`事件 ${nm} 定义缺失`)
    else if (!edef.payload || !isPlainObject(edef.payload)) errs.push(`事件 ${nm} payload schema 缺失`)
    else if (!Array.isArray(edef.redact)) errs.push(`事件 ${nm} redact 必须为数组`)
  }
  for (const [pattern, sub] of Object.entries(subscribes)) {
    if (!isPlainObject(sub)) errs.push(`订阅 ${pattern} 定义缺失`)
    else {
      if (typeof sub.handler !== 'string' || !sub.handler) errs.push(`订阅 ${pattern} handler 缺失`)
      if (!['sync', 'async'].includes(sub.mode)) errs.push(`订阅 ${pattern} mode 必须 sync|async`)
      if (typeof sub.as !== 'string') errs.push(`订阅 ${pattern} as 缺失`)
    }
  }
  return { ok: errs.length === 0, errors: errs }
}

// ---------------------------------------------------------------------------
// 别名（aliases 静态 + dispatch_aliases 分派型）
// ---------------------------------------------------------------------------

// 分派别名 router 契约：入参 (args, ctx)（ctx={actor, session_id, getFinding}），
// 返回 { verb, args, domain?, actor_bypass? } 或 { error: {code,message,hint,retryable} }。
// domain 缺省由 DOMAIN_OF_ROUTER 推导（别名表可用 domain: 显式覆盖）。
const DOMAIN_OF_ROUTER = {
  status_router: 'vuln',
  finding_add_router: 'vuln',
  query_visibility_router: 'vuln',
  task_status_router: 'task',
  asset_add_router: 'asset',
  asset_query_router: 'asset',
  asset_stats_router: 'asset',
  fp_add_router: 'asset',
  endpoint_add_router: 'endpoint',
  endpoint_query_router: 'endpoint',
  surface_queue_router: 'endpoint',
  exp_validate_router: 'know',
  card_usage_router: 'ledger',
  coverage_report_router: 'ledger',
}

const BUILTIN_ROUTERS = {
  // finding_update 旧自由态动词 → 按 status 语义分派（02-vuln §3.2）
  //   当前值+仅 note→note；confirmed→confirm（缺 evidence 收紧 E_EVIDENCE_REQUIRED）；
  //   fp/dup/ignored→reject（status→verdict）；submitted→submit；accepted→submit(vendor_status=accepted)；
  //   new 对非 new 行→E_STATE（回退）。
  async status_router(args, ctx) {
    const st = args.status
    const rest = { ...args }
    delete rest.status
    // v4 参数名归一：finding_update 旧工具用 id，语义动词用 finding_id
    if (rest.id !== undefined && rest.finding_id === undefined) {
      rest.finding_id = rest.id
      delete rest.id
    }
    let row = null
    if (ctx && typeof ctx.getFinding === 'function' && Number.isInteger(Number(rest.finding_id))) {
      try { row = await ctx.getFinding(rest.finding_id) } catch { row = null }
    }
    const onlyNote = !!(rest.note && rest.bounty === undefined && rest.vendor_status === undefined && rest.evidence === undefined)
    if (row && row.status === st) {
      if (onlyNote) return { verb: 'note', args: rest }
      if (st === 'new') {
        return { error: { code: 'E_STATE', message: 'finding_update status=new 无变更可做', hint: '仅补充证据用 vuln_note（带 note）；候选回退不合法', retryable: false } }
      }
    }
    if (st === 'new') {
      return { error: { code: 'E_STATE', message: 'finding_update status=new 是回退，不合法', hint: '候选回退请用语义动词；仅补充证据用 vuln_note', retryable: false } }
    }
    if (st === 'confirmed') {
      if (!String(rest.evidence || '').trim()) {
        return { error: { code: 'E_EVIDENCE_REQUIRED', message: 'finding_update→confirm 需要 evidence 参数', hint: 'confirm 是收紧后的语义动词：必须附真实存在的证据引用（run_id/evidence 路径/oob），无证据不结论', retryable: false } }
      }
      return { verb: 'confirm', args: rest }
    }
    if (st === 'false_positive' || st === 'dup' || st === 'ignored') {
      const rej = { ...rest, verdict: st }
      if (!String(rej.reason || '').trim() && String(rej.note || '').trim()) rej.reason = rej.note
      return { verb: 'reject', args: rej }
    }
    if (st === 'submitted') return { verb: 'submit', args: rest }
    if (st === 'accepted') return { verb: 'submit', args: { ...rest, vendor_status: 'accepted' } }
    return { error: { code: 'E_STATE', message: `finding_update 非法流转 status=${st}`, hint: '合法子集：confirmed（附 evidence）/false_positive/dup/ignored/submitted/accepted/当前值+note', retryable: false } }
  },
  // finding_add 旧工具名 → 按 actor 分派（02-vuln §3.2）
  //   model/human → register_signal（五要素硬校验）；webhook/script → register_candidate（机器宽容路径）；
  //   severity=info 一律降级候选（v4 行为保留，仅别名期）；缺 severity 按 v4 默认 info。
  finding_add_router(args, ctx) {
    const actor = (ctx && ctx.actor) || 'model'
    const out = { ...args }
    if (out.severity === undefined || out.severity === null || out.severity === '') out.severity = 'info'
    if (String(out.severity) === 'info') {
      // 模型/人类走候选降级需要 actor 旁路（C2 模型禁入——负向保障仅对直连与 alias 可见性生效，
      // 本旁路是 02-vuln §3.2 明文的别名期兼容，审计记 via_alias 可追踪）
      return { verb: 'register_candidate', args: out, actor_bypass: actor !== 'webhook' && actor !== 'script' }
    }
    if (actor === 'webhook' || actor === 'script') return { verb: 'register_candidate', args: out }
    return { verb: 'register_signal', args: out }
  },
  // finding_query 旧查询 → vuln_list（include_noise=true→all；noise='1'→candidate；其余直传）
  query_visibility_router(args) {
    const out = { ...args }
    const includeNoise = out.include_noise === true || out.include_noise === 'true'
    const noise = String(out.noise ?? '')
    if (includeNoise) out.visibility = 'all'
    else if (noise === '1') out.visibility = 'candidate'
    else if (out.visibility === undefined || out.visibility === '') out.visibility = 'signal'
    delete out.include_noise
    delete out.noise
    return { verb: 'list', args: out }
  },
  task_status_router(args) {
    const st = args.status
    const rest = { ...args }
    delete rest.status
    // v4 参数名归一：task_update 旧工具用 id，语义动词用 task_id
    if (rest.id !== undefined && rest.task_id === undefined) {
      rest.task_id = rest.id
      delete rest.id
    }
    if (st === undefined || st === null || st === '') {
      if (rest.note) return { verb: 'update_note', args: rest }
      return { error: { code: 'E_SCHEMA', message: 'task_update 需要 status 或 note', hint: '无状态变更用 task_update_note；状态变更用 task_block/resume/cancel', retryable: false } }
    }
    if (st === 'blocked') {
      const out = { ...rest }
      if (!out.blocked_reason && out.note) { out.blocked_reason = out.note; delete out.note }
      return { verb: 'block', args: out }
    }
    if (st === 'queued') return { verb: 'resume', args: rest }
    if (st === 'cancelled') return { verb: 'cancel', args: rest }
    if (st === 'done' || st === 'failed' || st === 'running') {
      return { error: { code: 'E_ACTOR_FORBIDDEN', message: `task_update status=${st} 已关闭：任务终态由调度器收尾`, hint: '任务终态由调度器收尾（task_finish）；会话内记录结果用 task_update_note，自执行任务用 task_submit_complete', retryable: false } }
    }
    return { error: { code: 'E_STATE', message: `task_update 非法流转 status=${st}`, hint: '合法子集：blocked/queued/cancelled/无 status+note', retryable: false } }
  },
  // asset_add 旧工具 → asset_upsert（03-asset §3.2）：评级字段 score/level/accept/biz/state
  // 被别名层丢弃（结构性闸门 INV-1 的别名期执行）；host/type/source 平移。
  asset_add_router(args) {
    const out = {}
    if (args.host !== undefined) out.host = args.host
    if (args.type !== undefined) out.type = args.type
    if (args.source !== undefined) out.source = args.source
    return { verb: 'upsert', args: out }
  },
  asset_query_router(args) { return { verb: 'list', args } },
  asset_stats_router() { return { verb: 'overview', args: {} } },
  fp_add_router(args) { return { verb: 'fp_record', args } },
  // endpoint_add 旧工具 → endpoint_upsert（04-endpoint §3.2）：auth_required/roles_seen 被丢弃，
  // 单行 host/method/path 包进 rows[0]（新动词无单行直传模式）。
  endpoint_add_router(args) {
    const row = {}
    if (args.host !== undefined) row.host = args.host
    if (args.path !== undefined) row.path = args.path
    if (args.method !== undefined) row.method = args.method
    if (args.status !== undefined) row.status = args.status
    if (args.source !== undefined) row.source = args.source
    if (args.params !== undefined) row.params = args.params
    return { verb: 'upsert', args: { rows: [row] } }
  },
  endpoint_query_router(args) { return { verb: 'list', args } },
  surface_queue_router(args) { return { verb: 'queue_surface', args } },
  // exp_validate 旧工具 → exp_feedback(verdict=validated)（07-know §3.2 折叠别名）
  exp_validate_router(args) { return { verb: 'exp_feedback', args: { id: args.id, verdict: 'validated', source: 'exp_validate' } } },
  // card_usage_log 旧工具 → ledger_log_card_usage（11-ledger §3.2）：v4 无 outcome 枚举，
  // 读取层按 deviation 存在推导 deviated，否则 applied（§2.1.2 兼容推导前移）。
  card_usage_router(args) {
    const out = { ...args }
    if (out.outcome === undefined || out.outcome === null || out.outcome === '') {
      out.outcome = (out.deviation ? 'deviated' : 'applied')
    }
    return { verb: 'log_card_usage', args: out }
  },
  // coverage_report 旧工具 → ledger_coverage_report（11-ledger §3.2）：v4 的 out 自定义路径被
  // 固定缓存 coverage-latest.md 取代（§1.4.2 定性为查询缓存），out 丢弃、materialize 保留缺省。
  coverage_report_router(args) {
    const out = { program: args.program }
    if (args.materialize !== undefined) out.materialize = args.materialize
    return { verb: 'coverage_report', args: out }
  },
}

export function loadAliases(aliasesFile) {
  let aliases = {}
  let dispatchAliases = {}
  let source = '空'
  if (fileExists(aliasesFile)) {
    try {
      const doc = parseYaml(fs.readFileSync(aliasesFile, 'utf8'))
      aliases = doc.aliases && isPlainObject(doc.aliases) ? doc.aliases : {}
      dispatchAliases = doc.dispatch_aliases && isPlainObject(doc.dispatch_aliases) ? doc.dispatch_aliases : {}
      source = aliasesFile
    } catch (e) {
      log(`别名表解析失败（${aliasesFile}）：${e?.message}——按空别名表运行`)
    }
  }
  return validateAliases({ aliases, dispatchAliases, source })
}

export function validateAliases(doc) {
  const errs = []
  const aliases = doc.aliases || {}
  const dispatchAliases = doc.dispatchAliases || doc.dispatch_aliases || {}
  for (const [nm, target] of Object.entries(aliases)) {
    if (typeof target !== 'string' || !/^[a-z]+_[a-z_]+$/.test(target)) errs.push(`别名 ${nm} → ${target} 目标格式非法`)
    if (nm === target) errs.push(`别名 ${nm} 自环`)
  }
  for (const [nm, def] of Object.entries(dispatchAliases)) {
    if (!isPlainObject(def)) { errs.push(`分派别名 ${nm} 定义缺失`); continue }
    if (typeof def.router !== 'string') errs.push(`分派别名 ${nm} router 缺失`)
    else if (!(def.router in BUILTIN_ROUTERS)) errs.push(`分派别名 ${nm} router ${def.router} 未知`)
    if (def.domain !== undefined && (typeof def.domain !== 'string' || !DOMAIN_WHITELIST.has(def.domain))) errs.push(`分派别名 ${nm} domain 非法: ${def.domain}`)
    if (def.warn !== undefined && typeof def.warn !== 'string') errs.push(`分派别名 ${nm} warn 必须为字符串`)
    if (nm === def.router) errs.push(`分派别名 ${nm} 自环`)
  }
  const cycle = (nm, seen) => {
    if (seen.has(nm)) return true
    seen.add(nm)
    const target = aliases[nm]
    if (!target || !(target in aliases)) return false
    return cycle(target, seen)
  }
  for (const nm of Object.keys(aliases)) if (cycle(nm, new Set())) errs.push(`别名环：${nm}`)
  return { ok: errs.length === 0, errors: errs, aliases, dispatchAliases, source: doc.source || '内存' }
}

// ---------------------------------------------------------------------------
// 幂等键构造（natural / explicit / auto）
// ---------------------------------------------------------------------------

function buildIdempotencyKey(domain, verb, cmdDef, args, explicitKey = null, ctx = {}) {
  // none：天然幂等/破坏性读命令（如 ledger.radar_drain 读后清空）——每次都是新读，不落幂等表
  //（11-ledger §1.3.4「信封 replay 语义不适用，每次 drain 都是新读」）。key=null 时网关跳过幂等预检与回填。
  if (cmdDef.idempotent === 'none') {
    return { key: null, argsForHash: omitKey(args) }
  }
  // explicit_only：执行类动词（run_cli）——同参重扫是合法业务，不落自动指纹；仅调用方显式传
  // idempotency_key 时走标准幂等（网络重试保护），否则每次独立执行（10-exec §1.3.1）。
  if (cmdDef.idempotent === 'explicit_only') {
    return explicitKey ? { key: String(explicitKey), argsForHash: omitKey(args) } : { key: null, argsForHash: omitKey(args) }
  }
  if (explicitKey) {
    return { key: String(explicitKey), argsForHash: omitKey(args) }
  }
  if (cmdDef.idempotent === 'natural') {
    const fields = cmdDef.idempotent_natural
    const vals = Array.isArray(fields) ? fields.map((f) => args[f]) : [fields]
    return { key: `${domain}:${verb}:${vals.map((v) => (v === undefined ? '' : String(v))).join('|')}`, argsForHash: omitKey(args) }
  }
  const core = {}
  const pick = cmdDef.idempotent_fields || []
  for (const k of Object.keys(args || {})) {
    if (k === 'idempotency_key') continue
    if (pick.length ? pick.includes(k) : true) core[k] = args[k]
  }
  let key = `${domain}:${verb}:${sha1(canonicalStringify(core))}`
  // 认领类动词（claim/release）的幂等键必须含调用面身份（session_id/operator）——
  // 否则不同会话认领同一对象会键碰撞互相 replay（02-vuln C7「finding_id+认领者」）
  for (const cf of cmdDef.idempotent_ctx_fields || []) {
    key += `|${cf}=${String(ctx[cf] ?? '')}`
  }
  return { key, argsForHash: omitKey(args) }
}
function omitKey(args) {
  const out = { ...(args || {}) }
  delete out.idempotency_key
  return out
}

// ---------------------------------------------------------------------------
// 总线自身 manifest（bus 是第一个客户）
// ---------------------------------------------------------------------------

const BUS_MANIFEST = {
  domain: 'bus',
  version: 1,
  service: 'secDomain.bus',
  description: '领域总线自身：健康自检/审计尾读/事件尾读/重放/清理（管道不是业务方）',
  owns: { tables: ['idempotency', 'bus_meta', 'event_outbox', 'bus_subscription'], files: ['data/audit.jsonl', 'data/events/', 'data/bus.aliases.yaml'] },
  commands: {
    bus_replay: {
      actor: ['human', 'system'],
      schema: { type: 'object', properties: {
        since: { type: 'integer', description: 'epoch ms，默认 24h 前' },
        domains: { type: 'array', items: { type: 'string' } },
        subscriber: { type: 'string' },
        dry_run: { type: 'boolean' },
        limit: { type: 'integer', maximum: 10000 },
      }, additionalProperties: false },
      idempotent: 'auto', idempotent_fields: ['since', 'subscriber', 'dry_run', 'limit', 'domains'],
      events: ['bus.replay.completed'], invariants: [],
      side_effects: { rows: true, events: true }, timeout_ms: 60000,
      agent_note: '按事件日志重放弱联动订阅者（灾备/调试）。只重放 mode:async 订阅者；dry_run 只输出将要重放的 (event, subscriber) 对。',
      deprecated: false,
    },
    bus_prune: {
      actor: ['human', 'system'],
      schema: { type: 'object', properties: { force: { type: 'boolean' } }, additionalProperties: false },
      idempotent: 'auto', idempotent_fields: ['force'],
      events: [], invariants: [],
      side_effects: { rows: true, files: true }, timeout_ms: 60000,
      agent_note: '立即执行保留窗口清理：幂等表 LRU（7 天/10000 条）+ 事件文件轮转检查。距上次清理 <6h 且未 force 则跳过。',
      deprecated: false,
    },
  },
  queries: {
    bus_status: {
      actor: ['model', 'dashboard', 'human', 'script'],
      params: { type: 'object', properties: { domains: { type: 'array', items: { type: 'string' } } }, additionalProperties: false },
      predicates: [],
      agent_note: '查询领域总线健康状态：各域是否注册、契约版本、后端、动词计数。只读，无副作用。',
    },
    audit_tail: {
      actor: ['dashboard', 'human'],
      params: { type: 'object', properties: {
        n: { type: 'integer', maximum: 500 }, domain: { type: 'string' }, cmd: { type: 'string' },
        actor: { type: 'string' }, session_id: { type: 'string' }, operator: { type: 'string' },
        since: { type: 'integer' }, until: { type: 'integer' }, offset: { type: 'integer', minimum: 0 },
      }, additionalProperties: false },
      predicates: [],
      agent_note: '统一审计尾读（过滤维度=宪法 §九），含 v4 legacy 行映射。',
    },
    events_tail: {
      actor: ['dashboard', 'human', 'model'],
      params: { type: 'object', properties: {
        domain: { type: 'string' }, n: { type: 'integer', maximum: 500 },
        name: { type: 'string' }, offset: { type: 'integer', minimum: 0 },
      }, required: ['domain'], additionalProperties: false },
      predicates: [],
      agent_note: '事件日志尾读（事件是模型可观察的世界状态）。',
    },
  },
  events: {
    'bus.domain.registered': { payload: { type: 'object' }, redact: [] },
    'bus.domain.rejected': { payload: { type: 'object' }, redact: [] },
    'bus.replay.completed': { payload: { type: 'object' }, redact: [] },
  },
  subscribes: {},
  backend: 'repository-v1',
}

// ---------------------------------------------------------------------------
// 核心：createBus（可注入工厂；测试可传临时目录/假时钟/假 ID）
// ---------------------------------------------------------------------------

export function createBus(opts = {}) {
  const dataDir = opts.dataDir || DATA_DIR
  const dbFile = opts.dbFile || path.join(dataDir, 'asset-graph.db')
  const aliasesFile = opts.aliasesFile || path.join(dataDir, 'bus.aliases.yaml')
  const auditFile = opts.auditFile || path.join(dataDir, 'audit.jsonl')
  const eventsDir = opts.eventsDir || path.join(dataDir, 'events')
  const agentsMd = opts.agentsMd || path.join(dataDir, 'AGENTS.md')
  const profile = opts.profile || null
  const sidecars = opts.sidecars !== false
  const clock = opts.clock || (() => Date.now())
  const idFactory = opts.idFactory || ((p) => createId(p))
  const rpcOperator = opts.rpcOperator || null
  const mountDeprecated = opts.mountDeprecated !== false
  const dispatcherIntervalMs = opts.dispatcherIntervalMs || 1000
  const startDispatcherTimer = opts.startDispatcherTimer !== false

  const now = () => clock()

  // --- 自举存储 ---
  let db = null
  let degraded = null
  try {
    fs.mkdirSync(dataDir, { recursive: true })
    fs.mkdirSync(eventsDir, { recursive: true })
    db = new DatabaseSync(dbFile)
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA busy_timeout = 5000')
    db.exec('PRAGMA synchronous = NORMAL')
    db.exec('PRAGMA wal_autocheckpoint = 1000')
    db.exec(`
      CREATE TABLE IF NOT EXISTS idempotency (
        idempotency_key TEXT PRIMARY KEY, domain TEXT NOT NULL, verb TEXT NOT NULL,
        args_hash TEXT NOT NULL, result_json TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_idempotency_created ON idempotency(created_at);
      CREATE TABLE IF NOT EXISTS bus_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS event_outbox (
        event_id TEXT PRIMARY KEY, domain TEXT NOT NULL, name TEXT NOT NULL, payload TEXT NOT NULL,
        producer_ts INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', retry_count INTEGER NOT NULL DEFAULT 0,
        next_retry_at INTEGER, last_error TEXT, created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_outbox_status ON event_outbox(status, next_retry_at);
      CREATE TABLE IF NOT EXISTS bus_subscription (
        event_id TEXT NOT NULL, subscriber TEXT NOT NULL, mode TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'delivered', attempt INTEGER NOT NULL DEFAULT 0,
        last_error TEXT, consumed_at INTEGER, PRIMARY KEY (event_id, subscriber)
      );
    `)
  } catch (e) {
    degraded = `总线自举存储打开失败: ${e?.message}`
    log(degraded)
  }

  // --- 审计 sink（fail-closed：写命令在事务内调用，失败抛错回滚；fail-open 路径仅告警） ---
  function auditAppend(record) {
    if (degraded) throw new Error('audit sink unavailable: ' + degraded)
    fs.appendFileSync(auditFile, JSON.stringify(record) + '\n')
  }
  function auditBestEffort(record) {
    try { fs.appendFileSync(auditFile, JSON.stringify(record) + '\n') } catch (e) { log(`审计写入失败（fail-open 路径）：${e?.message}`) }
  }

  // --- Registry ---
  const domains = new Map()
  const ownsTables = new Set()
  const ownsFiles = new Set()
  const subscribers = []
  const pendingEventLog = new Map()
  // ToolProjector 时序修复：域注册成功后用缓存的 ctx 再投影（let 声明必须先于 registerDomain 执行）
  let toolsCtx = null
  const registeredToolNames = new Set()

  function metaGet(key) {
    if (!db) return null
    try { return plain(db.prepare('SELECT value FROM bus_meta WHERE key=?').get(key))?.value ?? null } catch { return null }
  }
  function metaSet(key, value) {
    if (!db) return
    try {
      db.prepare('INSERT INTO bus_meta(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at')
        .run(key, JSON.stringify(value), now())
    } catch (e) { log(`bus_meta 写入失败 ${key}: ${e?.message}`) }
  }
  function seenVersion(domain) {
    const v = metaGet(`seen.${domain}.version`)
    return v === null ? 0 : Number(JSON.parse(v))
  }
  function patternToRegex(pattern) {
    const esc = String(pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*')
    return new RegExp(`^${esc}$`)
  }
  // 订阅匹配：manifest events / handler 事件名 = 全名 {domain}.{name}（宪法 §八.1），
  // envelope.name 直接承载全名，订阅 pattern（vuln.*）按全名匹配
  function matchSubscribers(eventName) { return subscribers.filter((s) => s.regex.test(eventName)) }

  function publishSyncEvent(name, payload, actor, sessionId, domain) {
    if (!db) return
    const env = {
      id: idFactory('evt'), domain, name, ts: now(), actor, session_id: sessionId || null,
      cause: { cmd: 'bus.internal', idempotency_key: null }, payload,
    }
    try {
      db.prepare(`INSERT INTO event_outbox(event_id,domain,name,payload,producer_ts,status,retry_count,next_retry_at,last_error,created_at)
                  VALUES(?,?,?,?,?,'delivered',0,NULL,NULL,?)`)
        .run(env.id, env.domain, env.name, JSON.stringify(env), env.ts, now())
      appendEventLog(env)
    } catch (e) { log(`总线内部事件写入失败 ${name}: ${e?.message}`) }
  }

  function reject(manifest, detail) {
    const reason = 'manifest 校验/版本兼容失败'
    log(`域拒载 ${manifest?.domain}: ${detail}`)
    publishSyncEvent('bus.domain.rejected', { domain: manifest?.domain || '?', reason, detail }, 'system', null, 'bus')
    return { ok: false, error: { code: 'E_BUS_DOMAIN_REJECTED', message: `${reason}：${detail}`, retryable: false } }
  }

  function registerDomain({ manifest, handlers, backend }) {
    if (!db) return { ok: false, error: { code: 'E_BUS_BACKEND_UNAVAILABLE', message: degraded || '存储不可用', retryable: true } }
    const shape = validateManifestShape(manifest)
    if (!shape.ok) return reject(manifest, shape.errors.join('; '))
    const lint = validateManifestLint(manifest)
    if (!lint.ok) return reject(manifest, lint.errors.join('; '))
    const existing = domains.get(manifest.domain)
    if (existing) {
      const same = canonicalStringify(existing.manifest) === canonicalStringify(manifest)
      if (same) return { ok: true, registered: false, note: '重复注册（同内容），幂等通过' }
      return reject(manifest, `R4 重复注册冲突：域 ${manifest.domain} 已注册且内容不一致（或 owns 交叉）`)
    }
    for (const t of manifest.owns.tables || []) {
      if (ownsTables.has(t)) return reject(manifest, `R4 owns 冲突：表 ${t} 已被其他域声明`)
    }
    for (const f of manifest.owns.files || []) {
      if (ownsFiles.has(f)) return reject(manifest, `R4 owns 冲突：文件 ${f} 已被其他域声明`)
    }
    const seen = seenVersion(manifest.domain)
    if (manifest.version > MANIFEST_SCHEMA_VERSION) return reject(manifest, `R6 版本过高：${manifest.version} > ${MANIFEST_SCHEMA_VERSION}`)
    if (manifest.version < seen) return reject(manifest, `R6 版本回退拒绝：${manifest.version} < 已见 ${seen}（防 setup 硬钉旧版本混版）`)
    if (!handlers || typeof handlers !== 'object') return reject(manifest, 'R1 handlers 缺失')
    for (const [full, def] of Object.entries(manifest.commands)) {
      const h = handlers[full] || handlers[stripDomainPrefix(full, manifest.domain)]
      if (typeof h !== 'function') return reject(manifest, `R5 悬空引用：命令 ${full} 无 handler`)
      for (const inv of def.invariants || []) {
        if (!handlers.invariants || typeof handlers.invariants[inv] !== 'function') return reject(manifest, `R5 悬空引用：不变量 ${inv} 无实现`)
      }
    }
    for (const [pattern, sub] of Object.entries(manifest.subscribes || {})) {
      if (!handlers.subscribers || typeof handlers.subscribers[sub.handler] !== 'function') return reject(manifest, `R5 悬空引用：订阅 ${pattern} handler ${sub.handler} 无实现`)
    }
    if (!backend || typeof backend !== 'object' || typeof backend.factory !== 'function') return reject(manifest, 'R7 后端 factory 缺失（repository-v1）')
    for (const [full] of Object.entries(manifest.commands)) {
      const cap = backend.capabilities?.[full] || 'full'
      if (!['full', 'partial', 'unsupported'].includes(cap)) return reject(manifest, `R7 能力矩阵非法：${full}=${cap}`)
    }
    for (const t of manifest.owns.tables || []) ownsTables.add(t)
    for (const f of manifest.owns.files || []) ownsFiles.add(f)
    const entry = {
      manifest, handlers, backend,
      state: {
        registered: true, version: manifest.version, contract_compatible: true,
        backend: 'sqlite-local', backend_reachable: true, capabilities: {},
        commands: Object.keys(manifest.commands).length, queries: Object.keys(manifest.queries).length,
        last_dispatch: null,
      },
    }
    for (const [full, def] of Object.entries(manifest.commands)) entry.state.capabilities[full] = backend.capabilities?.[full] || 'full'
    domains.set(manifest.domain, entry)
    metaSet(`seen.${manifest.domain}.version`, manifest.version)
    metaSet('replay.watermark', 0)
    for (const [pattern, sub] of Object.entries(manifest.subscribes || {})) {
      subscribers.push({ pattern, regex: patternToRegex(pattern), handler: handlers.subscribers[sub.handler], mode: sub.mode, as: sub.as, source: manifest.domain })
    }
    publishSyncEvent('bus.domain.registered', { domain: manifest.domain, version: manifest.version, backend: 'sqlite-local', commands: entry.state.commands, queries: entry.state.queries }, 'system', null, 'bus')
    // 域注册成功后再投影工具面 + 刷新 AGENTS.md 速查（registerTools 早于域注册的时序修复；
    // bus 域自注册时 toolsCtx 尚为空，由 apply 显式投影兜底）
    try { if (toolsCtx) registerTools(toolsCtx) } catch (e) { log(`域 ${manifest.domain} 注册后工具再投影失败: ${e?.message}`) }
    try { refreshAgentsMd() } catch (e) { log(`域 ${manifest.domain} 注册后 AGENTS.md 刷新失败: ${e?.message}`) }
    return { ok: true, registered: true, entry }
  }

  // --- 事件发布（事务内由网关调用） ---
  function publishInTx(envelope) {
    if (!db) throw new Error('storage unavailable')
    const size = Buffer.byteLength(JSON.stringify(envelope), 'utf8')
    if (size > EVENT_MAX_BYTES) {
      const err = new Error(`事件超限 ${size}>${EVENT_MAX_BYTES}：${envelope.name}`)
      err.code = 'E_BUS_EVENT_TOO_LARGE'
      throw err
    }
    db.prepare(`INSERT INTO event_outbox(event_id,domain,name,payload,producer_ts,status,retry_count,next_retry_at,last_error,created_at)
                VALUES(?,?,?,?,?,'pending',0,NULL,NULL,?)`)
      .run(envelope.id, envelope.domain, envelope.name, JSON.stringify(envelope), envelope.ts, now())
    const matched = matchSubscribers(envelope.name)
    const syncSubs = []
    let anyAsync = false
    for (const sub of matched) {
      if (sub.mode === 'sync') syncSubs.push(sub)
      else {
        anyAsync = true
        db.prepare(`INSERT OR IGNORE INTO bus_subscription(event_id,subscriber,mode,status,attempt,last_error,consumed_at)
                    VALUES(?,?,?,'pending',0,NULL,NULL)`)
          .run(envelope.id, sub.pattern, 'async')
      }
    }
    if (!anyAsync) db.prepare(`UPDATE event_outbox SET status='delivered' WHERE event_id=?`).run(envelope.id)
    return { syncSubs, hasAsync: anyAsync }
  }

  function appendEventLog(envelope) {
    try {
      fs.mkdirSync(eventsDir, { recursive: true })
      fs.appendFileSync(path.join(eventsDir, `${envelope.domain}.jsonl`), JSON.stringify(envelope) + '\n')
    } catch (e) { log(`事件 jsonl 追加失败 ${envelope.id}: ${e?.message}`) }
  }

  function buildEnvelope({ domain, name, payload, actor, sessionId, operator, cmd, idemKey }) {
    const p = deepClone(payload || {})
    const edef = domains.get(domain)?.manifest.events?.[name] || BUS_MANIFEST.events[name] || null
    const redact = edef ? (edef.redact || []) : []
    for (const rp of redact) {
      const parts = String(rp).split('.')
      let cur = p
      for (let i = 0; i < parts.length - 1; i++) {
        if (cur && typeof cur === 'object') cur = cur[parts[i]]
        else { cur = undefined; break }
      }
      if (cur && typeof cur === 'object') delete cur[parts[parts.length - 1]]
    }
    return {
      id: idFactory('evt'), domain, name, ts: now(), actor, session_id: sessionId || null,
      operator: operator || null, cause: { cmd, idempotency_key: idemKey || null }, payload: p,
    }
  }

  // --- AsyncLocalStorage：嵌套 dispatch（强联动）共享事务 ---
  const als = new AsyncLocalStorage()
  function txnBegin() { db.exec('BEGIN IMMEDIATE') }
  function txnRollback() { try { db.exec('ROLLBACK') } catch { /* noop */ } }
  function txnCommit() { db.exec('COMMIT') }

  // 同进程写串行化互斥（跨进程由 SQLite WAL + busy_timeout 承担；同进程单连接必须排队，
  // 否则两个并发 dispatch 在同一连接上 BEGIN IMMEDIATE 会报 "cannot start a transaction
  // within a transaction"。嵌套 dispatch（sync 订阅者）在 ALS 内已判 isNested，不再取锁。）
  let writeLock = Promise.resolve()
  function withWriteLock(fn) {
    const next = writeLock.then(fn, fn)
    writeLock = next.catch(() => { /* 锁链不因单次失败断裂 */ })
    return next
  }

  function okEnvelope(domain, verb, data, eventIds, idemKey, replay, extra) {
    return { ok: true, domain, cmd: verb, data, event_ids: eventIds, idempotency_key: idemKey, replay, ...(extra || {}) }
  }
  function errEnvelope(domain, verb, code, message, hint, retryable, idemKey, extra) {
    return { ok: false, domain, cmd: verb, error: { code, message, hint: hint || null, retryable: !!retryable }, idempotency_key: idemKey || null, ...(extra || {}) }
  }

  function findCommandDef(entry, domain, verb) {
    const full = `${domain}_${verb}`
    if (entry.manifest.commands[full]) return entry.manifest.commands[full]
    for (const [k, v] of Object.entries(entry.manifest.commands)) {
      if (stripDomainPrefix(k, domain) === verb) return v
    }
    return null
  }
  function findQueryDef(entry, domain, name) {
    const full = `${domain}_${name}`
    if (entry.manifest.queries[full]) return entry.manifest.queries[full]
    for (const [k, v] of Object.entries(entry.manifest.queries)) {
      if (stripDomainPrefix(k, domain) === name) return v
    }
    return null
  }

  const aliasesDoc = loadAliases(aliasesFile)

  // --- CommandGateway：dispatch（11 段管线） ---
  async function dispatch(domainIn, verbIn, argsIn, ctxIn) {
    let ctx = ctxIn || {}  // 兼容别名可注入 compat 标志（actor_bypass / dup_of_relaxed）
    const actor = String(ctx.actor || 'model')
    const started = now()
    let aliasUsed = null
    let domain = domainIn
    let verb = verbIn
    let args = deepClone(argsIn || {}) || {}
    // 显式幂等键先剥离（宪法 §六.1：网关剥离后不进域实现，也不进 schema 校验）
    const explicitIdemKey = args && typeof args.idempotency_key === 'string' && args.idempotency_key ? String(args.idempotency_key) : null
    if (explicitIdemKey) delete args.idempotency_key
    const fullCandidate = `${domain}_${verb}`

    // ① 域/动词解析 + 别名归一（别名键可能是带域前缀的新形态，也可能是 v4 旧裸工具名）
    const aliasCandidates = [fullCandidate]
    if (verb !== fullCandidate) aliasCandidates.push(verb)
    for (const cand of aliasCandidates) {
      if (aliasesDoc.aliases[cand]) {
        const target = aliasesDoc.aliases[cand]
        domain = target.split('_')[0]
        verb = stripDomainPrefix(target, domain)
        aliasUsed = { alias: cand, target }
        break
      }
      if (aliasesDoc.dispatchAliases[cand]) {
        const ddef = aliasesDoc.dispatchAliases[cand]
        const routed = await BUILTIN_ROUTERS[ddef.router](args, {
          actor, session_id: ctx.session_id || null,
          getFinding: async (id) => {
            const rd = ddef.domain || DOMAIN_OF_ROUTER[ddef.router]
            const e = rd ? domains.get(rd) : null
            if (!e) return null
            try { return e.backend.factory(db).getFinding(Number(id)) } catch { return null }
          },
        })
        if (routed.error) {
          auditBestEffort({ ts: now(), kind: 'deprecated_use', domain: domainIn, cmd: verbIn, actor, session_id: ctx.session_id || null, operator: ctx.operator || null, target: null, alias: cand, warn: ddef.warn || null, result: 'blocked', duration_ms: now() - started })
          auditBestEffort({ ts: now(), kind: 'command', domain: domainIn, cmd: verbIn, actor, session_id: ctx.session_id || null, operator: ctx.operator || null, idempotency_key: null, replay: false, target: { alias: cand }, before: null, after: null, result: 'failed', error_code: routed.error.code, duration_ms: now() - started, backend: 'bus-alias', alias: cand })
          return errEnvelope(domainIn, verbIn, routed.error.code, routed.error.message, routed.error.hint, routed.error.retryable)
        }
        const routedDomain = ddef.domain || DOMAIN_OF_ROUTER[ddef.router] || null
        if (!routedDomain) {
          auditBestEffort({ ts: now(), kind: 'command', domain: domainIn, cmd: verbIn, actor, session_id: ctx.session_id || null, operator: ctx.operator || null, idempotency_key: null, replay: false, target: null, before: null, after: null, result: 'failed', error_code: 'E_BUS_ALIAS_DANGLING', duration_ms: now() - started, backend: 'bus-alias' })
          return errEnvelope(domainIn, verbIn, 'E_BUS_ALIAS_DANGLING', `分派别名 ${cand} 无法推导目标域`, '别名表补 domain 字段或检查 router 映射', false)
        }
        domain = routedDomain
        verb = routed.verb
        args = routed.args
        aliasUsed = { alias: cand, target: `${domain}_${verb}`, router: ddef.router, warn: ddef.warn }
        if (routed.actor_bypass) ctx = { ...ctx, compat: { ...(ctx.compat || {}), actor_bypass: { domain, verb, via: cand } } }
        break
      }
    }

    const entry = domains.get(domain)
    if (!entry) {
      auditBestEffort({ ts: now(), kind: 'command', domain: domainIn, cmd: verbIn, actor, session_id: ctx.session_id || null, operator: ctx.operator || null, idempotency_key: null, replay: false, target: null, before: null, after: null, result: 'failed', error_code: 'E_BUS_DOMAIN_UNKNOWN', duration_ms: now() - started, backend: 'bus' })
      return errEnvelope(domainIn, verbIn, 'E_BUS_DOMAIN_UNKNOWN', `未知域 ${domain}`, `可用域见 bus_status；${[...domains.keys()].join(', ')}`, false)
    }
    const cmdDef = findCommandDef(entry, domain, verb)
    if (!cmdDef) {
      auditBestEffort({ ts: now(), kind: 'command', domain: domainIn, cmd: verbIn, actor, session_id: ctx.session_id || null, operator: ctx.operator || null, idempotency_key: null, replay: false, target: null, before: null, after: null, result: 'failed', error_code: 'E_BUS_VERB_UNKNOWN', duration_ms: now() - started, backend: 'bus' })
      return errEnvelope(domainIn, verbIn, 'E_BUS_VERB_UNKNOWN', `域 ${domain} 无动词 ${verb}`, '该域动词清单见 AGENTS.md 域动词速查表', false)
    }
    const fullName = `${domain}_${verb}`

    // ①.5 兼容期差异（02-vuln §3.2 finding_update）：dup 缺 dup_of 时自动以同 host+同 vuln_type
    // 最高候选行填充；查不到留空（ctx.compat.dup_of_relaxed 供域不变量放宽——观察期后必填）
    if (aliasUsed && aliasUsed.alias === 'finding_update' && verb === 'reject' && args.verdict === 'dup' && !Number.isInteger(args.dup_of)) {
      try {
        const repo = entry.backend.factory(db)
        const row = repo.getFinding(args.finding_id)
        if (row && (String(row.host || '') || String(row.vuln_type || ''))) {
          const dd = repo.listDedup({ host: String(row.host || ''), vuln_type: String(row.vuln_type || ''), exclude_id: Number(args.finding_id) }, 1)
          if (Array.isArray(dd.rows) && dd.rows.length && Number.isInteger(Number(dd.rows[0].id))) args.dup_of = Number(dd.rows[0].id)
        }
      } catch (e) { log(`别名 dup_of 自动填充失败: ${e?.message}`) }
      ctx = { ...ctx, compat: { ...(ctx.compat || {}), dup_of_relaxed: true, via: aliasUsed.alias } }
    }

    // ② deprecated / 别名使用 → audit deprecated_use（不失败）
    if (aliasUsed) {
      auditBestEffort({ ts: now(), kind: 'deprecated_use', domain: domainIn, cmd: verbIn, actor, session_id: ctx.session_id || null, operator: ctx.operator || null, target: fullName, alias: aliasUsed.alias, warn: aliasUsed.warn || null, result: 'ok', duration_ms: 0 })
    }
    if (cmdDef.deprecated) {
      auditBestEffort({ ts: now(), kind: 'deprecated_use', domain, cmd: verb, actor, session_id: ctx.session_id || null, operator: ctx.operator || null, target: fullName, alias: null, result: 'ok', duration_ms: 0 })
    }

    // ③ actor 白名单（在 schema 前：越权者不应获得参数细节）
    // 兼容旁路仅对分派别名（finding_add severity=info 降级候选）生效，直连 C2 仍严格拒绝
    const actorBypass = ctx.compat && ctx.compat.actor_bypass && ctx.compat.actor_bypass.domain === domain && ctx.compat.actor_bypass.verb === verb
    if (!Array.isArray(cmdDef.actor) || (!cmdDef.actor.includes(actor) && !actorBypass)) {
      auditBestEffort({ ts: now(), kind: 'command', domain, cmd: verb, actor, session_id: ctx.session_id || null, operator: ctx.operator || null, idempotency_key: null, replay: false, target: null, before: null, after: null, result: 'failed', error_code: 'E_ACTOR_FORBIDDEN', duration_ms: now() - started, backend: 'bus' })
      return errEnvelope(domain, verb, 'E_ACTOR_FORBIDDEN', `actor=${actor} 不允许调用 ${fullName}`, `白名单: [${(cmdDef.actor || []).join(', ')}]`, false)
    }

    // ④ 后端能力矩阵
    const cap = entry.backend.capabilities?.[fullName] || 'full'
    if (cap === 'unsupported') {
      auditBestEffort({ ts: now(), kind: 'command', domain, cmd: verb, actor, session_id: ctx.session_id || null, operator: ctx.operator || null, idempotency_key: null, replay: false, target: null, before: null, after: null, result: 'failed', error_code: 'E_CAPABILITY_UNSUPPORTED', duration_ms: now() - started, backend: 'sqlite-local' })
      return errEnvelope(domain, verb, 'E_CAPABILITY_UNSUPPORTED', `后端不支持 ${fullName}`, '换用支持的动词或等待后端能力补齐', false)
    }

    // ⑤ 参数 schema 校验
    const v = validateSchema(args, cmdDef.schema)
    if (!v.ok) {
      auditBestEffort({ ts: now(), kind: 'command', domain, cmd: verb, actor, session_id: ctx.session_id || null, operator: ctx.operator || null, idempotency_key: null, replay: false, target: null, before: null, after: null, result: 'failed', error_code: 'E_SCHEMA', duration_ms: now() - started, backend: 'sqlite-local' })
      return errEnvelope(domain, verb, 'E_SCHEMA', `参数校验失败：${v.errors.map((e) => `${e.field}: ${e.message}`).join('; ')}`, '修正参数后重试', false)
    }

    // ⑥ 幂等预检（命中直接返回首次结果，不再跑不变量）
    const { key, argsForHash } = buildIdempotencyKey(domain, verb, cmdDef, args, explicitIdemKey, ctx)
    const argsHash = sha1(canonicalStringify(argsForHash))
    let hit = null
    if (key) { try { hit = plain(db.prepare('SELECT * FROM idempotency WHERE idempotency_key=?').get(key)) } catch { /* degraded */ } }
    if (hit) {
      if (hit.args_hash !== argsHash) {
        // 兼容期宽容（02-vuln §3.2 finding_add）：同指纹异参重放 → v4 形状 {ok:true, dup:true, id}，
        // 存量 prompt/脚本依赖 dup 语义；仅别名期，新路径严格执行 E_IDEMPOTENT_CONFLICT
        if (aliasUsed && aliasUsed.alias === 'finding_add') {
          try {
            const prior = JSON.parse(hit.result_json)
            const priorId = prior && prior.data && Number.isInteger(Number(prior.data.id)) ? Number(prior.data.id) : null
            if (priorId !== null) {
              auditBestEffort({ ts: now(), kind: 'deprecated_use', domain: domainIn, cmd: verbIn, actor, session_id: ctx.session_id || null, operator: ctx.operator || null, target: fullName, alias: 'finding_add', warn: aliasUsed.warn || null, result: 'ok', compat: 'v4-dup-shape', duration_ms: now() - started })
              return { ok: true, domain: domainIn, cmd: verbIn, data: { ...(prior.data || {}), id: priorId, dup: true }, dup: true, id: priorId, idempotency_key: key, replay: false, compat: 'v4-dup-shape', via_alias: 'finding_add' }
            }
          } catch { /* 转译失败按常规冲突处理 */ }
        }
        auditBestEffort({ ts: now(), kind: 'command', domain, cmd: verb, actor, session_id: ctx.session_id || null, operator: ctx.operator || null, idempotency_key: key, replay: false, target: null, before: null, after: null, result: 'failed', error_code: 'E_IDEMPOTENT_CONFLICT', duration_ms: now() - started, backend: 'sqlite-local' })
        return errEnvelope(domain, verb, 'E_IDEMPOTENT_CONFLICT', `幂等键 ${key} 已绑定不同参数`, '若是重放请原样重发参数；若是新意图请换 idempotency_key', false, key)
      }
      const prior = JSON.parse(hit.result_json)
      auditBestEffort({ ts: now(), kind: 'command', domain, cmd: verb, actor, session_id: ctx.session_id || null, operator: ctx.operator || null, idempotency_key: key, replay: true, target: null, before: null, after: null, result: 'ok', error_code: null, duration_ms: now() - started, backend: 'sqlite-local' })
      return { ...prior, replay: true }
    }

    // ⑦ 前置不变量（不变量失败不占写锁）；ctx 透传（兼容期放宽标志由域不变量按契约读取）
    const repo = entry.backend.factory(db)
    for (const invName of cmdDef.invariants || []) {
      const fn = entry.handlers.invariants?.[invName]
      if (!fn) continue
      let res = null
      try { res = await fn(args, repo, ctx) } catch (e) { res = { code: 'E_INVARIANT', message: `不变量 ${invName} 执行异常: ${e?.message}` } }
      if (res) {
        auditBestEffort({ ts: now(), kind: 'command', domain, cmd: verb, actor, session_id: ctx.session_id || null, operator: ctx.operator || null, idempotency_key: key, replay: false, target: null, before: null, after: null, result: 'failed', error_code: res.code || 'E_INVARIANT', duration_ms: now() - started, backend: 'sqlite-local' })
        return errEnvelope(domain, verb, res.code || 'E_INVARIANT', res.message || `不变量 ${invName} 失败`, res.hint || null, false, key)
      }
    }

    // ⑧-⑪ 事务执行：同进程写串行化（本地互斥）+ 嵌套 SAVEPOINT；提交后 jsonl 留痕
    const scope = { depth: 0, inTxn: false, eventIds: [] }
    const parentStore = als.getStore()
    const isNested = !!(parentStore && parentStore.inTxn)
    // 非事务域（exec：file 后端 + run_cli/spawn_worker 长时执行）——不经 BEGIN IMMEDIATE 与写锁，
    // 否则 45s~3600s 的执行会占死 SQLite 写锁阻塞调度器/全部域写入（10-exec §2.3.1「没有跨行事务需求」）。
    const nonTransactional = entry.manifest.backend_transactional === false
    const runTxn = () => als.run(scope, async () => {
      if (isNested) {
        if (scope.depth >= NESTING_DEPTH_MAX) {
          return errEnvelope(domain, verb, 'E_BUS_STRONG_LINK_NESTING', `强联动嵌套超深（>${NESTING_DEPTH_MAX}）`, '订阅环或嵌套过深，检查 subscribes 图', false, key)
        }
        scope.depth++
        const sp = `sp_${scope.depth}`
        db.exec(`SAVEPOINT ${sp}`)
        try {
          const res = await runCommandTxn(domain, verb, fullName, args, ctx, cmdDef, key, argsHash, entry, started)
          db.exec(`RELEASE ${sp}`)
          scope.eventIds.push(...res._eventIds)
          return res.envelope
        } catch (e) {
          try { db.exec(`ROLLBACK TO ${sp}`) } catch { /* noop */ }
          throw e
        } finally { scope.depth-- }
      } else if (nonTransactional) {
        // 非事务域：autocommit 直跑（inTxn=false → 嵌套 dispatch 判为顶层、各自独立事务）
        try {
          const res = await runCommandTxn(domain, verb, fullName, args, ctx, cmdDef, key, argsHash, entry, started)
          scope.eventIds.push(...res._eventIds)
          for (const eid of scope.eventIds) {
            const env = pendingEventLog.get(eid)
            if (env && env._noAsync) appendEventLog(env)
          }
          return res.envelope
        } catch (e) {
          const isStrong = e?.code === 'E_BUS_STRONG_LINK_FAILED'
          const domainErr = !isStrong && e?.code && String(e.code).startsWith('E_') ? String(e.code) : null
          const code = isStrong ? 'E_BUS_STRONG_LINK_FAILED' : (domainErr || 'E_CONFLICT')
          auditBestEffort({ ts: now(), kind: 'command', domain, cmd: verb, actor, session_id: ctx.session_id || null, operator: ctx.operator || null, idempotency_key: key, replay: false, target: null, before: null, after: null, result: 'failed', error_code: code, duration_ms: now() - started, backend: 'file' })
          if (isStrong) return errEnvelope(domain, verb, code, `强联动订阅者失败：${e?.message}`, '修复联动问题后原样重试（幂等保护在）', true, key)
          const retryable = code === 'E_CONFLICT' || e?.retryable === true
          return errEnvelope(domain, verb, code, e?.message || '命令执行失败', e?.hint || null, retryable, key)
        }
      } else {
        scope.inTxn = true
        txnBegin()
        try {
          const res = await runCommandTxn(domain, verb, fullName, args, ctx, cmdDef, key, argsHash, entry, started)
          scope.eventIds.push(...res._eventIds)
          txnCommit()
          for (const eid of scope.eventIds) {
            const env = pendingEventLog.get(eid)
            if (env && env._noAsync) appendEventLog(env)
          }
          return res.envelope
        } catch (e) {
          txnRollback()
          const isAudit = e?.code === 'E_BUS_AUDIT_FAILED'
          const isStrong = e?.code === 'E_BUS_STRONG_LINK_FAILED'
          const isSqliteBusy = /locked|busy|database is locked/i.test(String(e?.message || e))
          const domainErr = !isAudit && !isStrong && !isSqliteBusy && e?.code && String(e.code).startsWith('E_') ? String(e.code) : null
          const code = isAudit ? 'E_BUS_AUDIT_FAILED' : (isStrong ? 'E_BUS_STRONG_LINK_FAILED' : (domainErr || 'E_CONFLICT'))
          auditBestEffort({ ts: now(), kind: 'command', domain, cmd: verb, actor, session_id: ctx.session_id || null, operator: ctx.operator || null, idempotency_key: key, replay: false, target: null, before: null, after: null, result: 'failed', error_code: code, duration_ms: now() - started, backend: 'sqlite-local' })
          if (isStrong) return errEnvelope(domain, verb, code, `强联动订阅者失败：${e?.message}`, '修复联动问题后原样重试（幂等保护在）', true, key)
          const retryable = code === 'E_CONFLICT' || e?.retryable === true
          const hint = isAudit ? '审计通道不可写，命令已回滚' : (code === 'E_CONFLICT' ? '并发写冲突，退避重试（幂等表保证安全）' : (e?.hint || null))
          return errEnvelope(domain, verb, code, e?.message || '命令执行失败', hint, retryable, key)
        } finally { scope.inTxn = false }
      }
    })
    if (isNested) return runTxn()
    if (nonTransactional) return runTxn()  // 非事务域不经 withWriteLock（长时执行不占写锁）
    return withWriteLock(runTxn)

    async function runCommandTxn(domain, verb, fullName, args, ctx, cmdDef, key, argsHash, entry, started) {
      const handler = entry.handlers[fullName] || entry.handlers[verb]
      let handlerResult
      try {
        handlerResult = await handler(args, entry.backend.factory(db), { actor, session_id: ctx.session_id || null, operator: ctx.operator || null, cwd: ctx.cwd || null, dispatch, now })
      } catch (e) {
        const err = new Error(e?.message || '域命令执行失败')
        err.code = e?.code || 'E_INTERNAL'
        err.hint = e?.hint || null
        err.retryable = !!e?.retryable
        throw err
      }
      if (!handlerResult || typeof handlerResult !== 'object') throw new Error('域命令 handler 必须返回 {data, events?}')
      const data = handlerResult.data
      const events = Array.isArray(handlerResult.events) ? handlerResult.events : []
      const limit = cmdDef.event_limit || EVENT_MAX_PER_CMD
      if (events.length > limit) {
        const err = new Error(`事件风暴闸：单命令事件 ${events.length} > ${limit}`)
        err.code = 'E_BUS_EVENT_TOO_LARGE'
        throw err
      }
      const eventIdsLocal = []
      for (const ev of events) {
        if (!ev || typeof ev.name !== 'string') throw new Error('事件缺少 name')
        const envelope = buildEnvelope({ domain, name: ev.name, payload: ev.payload || {}, actor, sessionId: ctx.session_id, operator: ctx.operator, cmd: verb, idemKey: key })
        const { syncSubs, hasAsync } = publishInTx(envelope)
        eventIdsLocal.push(envelope.id)
        pendingEventLog.set(envelope.id, { ...envelope, _noAsync: !hasAsync })
        for (const sub of syncSubs) {
          let subEnv
          try { subEnv = await sub.handler(envelope) } catch (e) {
            const err = new Error(`订阅者 ${sub.pattern} 执行异常: ${e?.message}`)
            err.code = 'E_BUS_STRONG_LINK_FAILED'
            throw err
          }
          if (!subEnv || subEnv.ok !== true) {
            const err = new Error(`订阅者 ${sub.pattern} 失败: ${subEnv?.error?.code || 'unknown'} ${subEnv?.error?.message || ''}`)
            err.code = 'E_BUS_STRONG_LINK_FAILED'
            throw err
          }
        }
      }
      const envelope = okEnvelope(domain, verb, data, eventIdsLocal, key, false)
      if (key) {
        db.prepare(`INSERT INTO idempotency(idempotency_key,domain,verb,args_hash,result_json,created_at) VALUES(?,?,?,?,?,?)`)
          .run(key, domain, verb, argsHash, JSON.stringify(envelope), now())
      }
      try {
        auditAppend({
          ts: now(), kind: 'command', domain, cmd: verb, actor,
          session_id: ctx.session_id || null, operator: ctx.operator || null,
          idempotency_key: key, replay: false,
          target: handlerResult.target || null,
          before: handlerResult.before || null, after: handlerResult.after || data || null,
          result: 'ok', error_code: null, duration_ms: now() - started, backend: 'sqlite-local',
          ...(aliasUsed ? { via_alias: aliasUsed.alias, compat: ctx.compat ? Object.keys(ctx.compat).join(',') : null } : {}),
        })
      } catch (e) {
        const err = new Error(`审计落盘失败（fail-closed）: ${e?.message}`)
        err.code = 'E_BUS_AUDIT_FAILED'
        throw err
      }
      entry.state.last_dispatch = { ts: now(), ok: true }
      return { envelope, _eventIds: eventIdsLocal }
    }
  }

  // --- QueryGateway ---
  async function query(domainIn, nameIn, argsIn, ctxIn) {
    const ctx = ctxIn || {}
    const actor = String(ctx.actor || 'model')
    const started = now()
    let domain = domainIn
    let name = nameIn
    let args = argsIn || {}
    const fullCandidate = `${domain}_${name}`
    const aliasCandidates = [fullCandidate]
    if (name !== fullCandidate) aliasCandidates.push(name)
    let aliasUsed = null
    for (const cand of aliasCandidates) {
      if (aliasesDoc.aliases[cand]) {
        const target = aliasesDoc.aliases[cand]
        domain = target.split('_')[0]
        name = stripDomainPrefix(target, domain)
        aliasUsed = { alias: cand, target }
        break
      }
      if (aliasesDoc.dispatchAliases[cand]) {
        const ddef = aliasesDoc.dispatchAliases[cand]
        const routed = await BUILTIN_ROUTERS[ddef.router](args, { actor, session_id: ctx.session_id || null })
        if (routed.error) return errEnvelope(domainIn, nameIn, routed.error.code, routed.error.message, routed.error.hint, routed.error.retryable)
        const routedDomain = ddef.domain || DOMAIN_OF_ROUTER[ddef.router] || null
        if (!routedDomain) return errEnvelope(domainIn, nameIn, 'E_BUS_ALIAS_DANGLING', `分派别名 ${cand} 无法推导目标域`, '别名表补 domain 字段或检查 router 映射', false)
        domain = routedDomain
        name = routed.verb
        args = routed.args
        aliasUsed = { alias: cand, target: `${domain}_${name}`, router: ddef.router, warn: ddef.warn }
        break
      }
    }
    if (aliasUsed) {
      auditBestEffort({ ts: now(), kind: 'deprecated_use', domain: domainIn, cmd: nameIn, actor, session_id: ctx.session_id || null, operator: ctx.operator || null, target: `${domain}_${name}`, alias: aliasUsed.alias, warn: aliasUsed.warn || null, result: 'ok', duration_ms: 0 })
    }
    const entry = domains.get(domain)
    if (!entry) return errEnvelope(domain, name, 'E_BUS_DOMAIN_UNKNOWN', `未知域 ${domain}`, `可用域见 bus_status`, false)
    const qdef = findQueryDef(entry, domain, name)
    if (!qdef) return errEnvelope(domain, name, 'E_BUS_VERB_UNKNOWN', `域 ${domain} 无查询 ${name}`, '该域查询清单见 AGENTS.md', false)
    if (!Array.isArray(qdef.actor) || !qdef.actor.includes(actor)) {
      return errEnvelope(domain, name, 'E_ACTOR_FORBIDDEN', `actor=${actor} 不允许查询 ${domain}_${name}`, `白名单: [${(qdef.actor || []).join(', ')}]`, false)
    }
    const v = validateSchema(args || {}, qdef.params || {})
    if (!v.ok) return errEnvelope(domain, name, 'E_SCHEMA', `参数校验失败：${v.errors.map((e) => `${e.field}: ${e.message}`).join('; ')}`, '修正参数后重试', false)
    const qargs = { ...(args || {}) }
    let limit = Number.isInteger(qargs.limit) ? qargs.limit : 50
    if (limit > 500) limit = 500
    if (limit < 1) limit = 1
    const offset = Number.isInteger(qargs.offset) ? Math.max(0, qargs.offset) : 0
    const qhandler = entry.handlers.queries?.[name] || entry.handlers.queries?.[`${domain}_${name}`]
    if (!qhandler) return errEnvelope(domain, name, 'E_INTERNAL', `查询 ${domain}_${name} 无 handler`, null, false)
    let res
    try {
      res = await qhandler(qargs, entry.backend.factory(db), { actor, session_id: ctx.session_id || null, operator: ctx.operator || null })
    } catch (e) {
      const domainErr = e?.code && String(e.code).startsWith('E_') ? String(e.code) : null
      return errEnvelope(domain, name, domainErr || 'E_INTERNAL', e?.message || String(e), e?.hint || null, false)
    }
    if (res && Array.isArray(res.rows)) {
      const total = Number.isInteger(res.total) ? res.total : res.rows.length
      return { ok: true, domain, query: name, rows: res.rows.slice(offset, offset + limit), total, limit, offset, ...(res.meta || {}) }
    }
    return { ok: true, domain, query: name, data: res }
  }

  // --- EventBus 订阅 API（程序化订阅：memcore 等非域客户端） ---
  function subscribe(pattern, handler, opts = {}) {
    if (typeof handler !== 'function') throw new Error('subscribe handler 必须是函数')
    const sub = { pattern: String(pattern), regex: patternToRegex(String(pattern)), handler, mode: opts.mode === 'sync' ? 'sync' : 'async', as: opts.as || 'reactor', source: opts.source || 'programmatic' }
    subscribers.push(sub)
    return () => {
      const i = subscribers.indexOf(sub)
      if (i >= 0) subscribers.splice(i, 1)
    }
  }

  // --- Dispatcher（web 宿主面单例；测试可手动 tick） ---
  async function dispatcherTick() {
    if (!db) return { processed: 0 }
    let rows = []
    try {
      rows = plainAll(db.prepare(`SELECT * FROM event_outbox WHERE status='pending' AND (next_retry_at IS NULL OR next_retry_at <= ?) ORDER BY created_at ASC LIMIT 100`).all(now()))
    } catch { return { processed: 0 } }
    let processed = 0
    for (const row of rows) {
      let envelope = null
      try { envelope = JSON.parse(row.payload) } catch { envelope = null }
      if (!envelope) {
        db.prepare(`UPDATE event_outbox SET status='dead_letter', last_error='payload 解析失败' WHERE event_id=?`).run(row.event_id)
        continue
      }
      const matched = matchSubscribers(envelope.name).filter((s) => s.mode === 'async')
      if (!matched.length) {
        db.prepare(`UPDATE event_outbox SET status='delivered' WHERE event_id=?`).run(row.event_id)
        appendEventLog(envelope)
        processed++
        continue
      }
      let allDone = true
      for (const sub of matched) {
        const rec = plain(db.prepare(`SELECT * FROM bus_subscription WHERE event_id=? AND subscriber=?`).get(row.event_id, sub.pattern))
        if (rec && rec.status === 'delivered') continue
        try {
          const subEnv = await sub.handler(envelope)
          if (subEnv && subEnv.ok === true) {
            db.prepare(`INSERT OR REPLACE INTO bus_subscription(event_id,subscriber,mode,status,attempt,last_error,consumed_at) VALUES(?,?,?,?,?,?,?)`)
              .run(row.event_id, sub.pattern, 'async', 'delivered', rec?.attempt || 0, null, now())
          } else {
            throw new Error(`订阅者失败: ${subEnv?.error?.code || 'unknown'} ${subEnv?.error?.message || ''}`)
          }
        } catch (e) {
          allDone = false
          const attempt = (rec?.attempt || 0) + 1
          const backoff = BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)]
          const dead = attempt > BACKOFF_MS.length
          const status = dead ? 'dead_letter' : 'pending'
          db.prepare(`INSERT OR REPLACE INTO bus_subscription(event_id,subscriber,mode,status,attempt,last_error,consumed_at) VALUES(?,?,?,?,?,?,NULL)`)
            .run(row.event_id, sub.pattern, 'async', status, attempt, String(e?.message || e))
          auditBestEffort({ ts: now(), kind: 'subscriber_failed', event_id: row.event_id, subscriber: sub.pattern, as: sub.as, error: String(e?.message || e), attempt })
          if (dead) {
            db.prepare(`UPDATE event_outbox SET status='dead_letter', retry_count=?, last_error=? WHERE event_id=?`)
              .run(attempt, String(e?.message || e), row.event_id)
          } else {
            db.prepare(`UPDATE event_outbox SET retry_count=?, next_retry_at=?, last_error=? WHERE event_id=?`)
              .run(attempt, now() + backoff, String(e?.message || e), row.event_id)
          }
        }
      }
      if (allDone) {
        db.prepare(`UPDATE event_outbox SET status='delivered', last_error=NULL WHERE event_id=?`).run(row.event_id)
        appendEventLog(envelope)
        processed++
      }
    }
    return { processed }
  }

  // --- bus 域命令/查询 handler 实现（自举：bus 是第一个注册域） ---
  const busHandlers = {
    bus_replay: async (args, repo, ctx) => {
      const since = Number.isInteger(args.since) ? args.since : now() - 86400000
      const dryRun = args.dry_run === true
      const limit = Number.isInteger(args.limit) ? args.limit : 1000
      const domainsFilter = Array.isArray(args.domains) ? new Set(args.domains) : null
      const subFilter = args.subscriber ? String(args.subscriber) : null
      const scanned = []
      const results = []
      let redispatched = 0
      let skippedSync = 0
      // 源 1：事件 jsonl
      let files = []
      try { files = fs.readdirSync(eventsDir).filter((f) => f.endsWith('.jsonl')) } catch { files = [] }
      for (const f of files) {
        const d = f.replace(/\.jsonl$/, '')
        if (domainsFilter && !domainsFilter.has(d)) continue
        let lines = []
        try { lines = fs.readFileSync(path.join(eventsDir, f), 'utf8').split('\n').filter(Boolean) } catch { continue }
        for (const line of lines) {
          let env = null
          try { env = JSON.parse(line) } catch { continue }
          if (!env || env.ts < since) continue
          if (scanned.length >= limit) break
          scanned.push(env)
          const matched = matchSubscribers(env.name).filter((s) => s.mode === 'async' && (!subFilter || s.pattern === subFilter))
          for (const sub of matched) {
            if (dryRun) { results.push({ event_id: env.id, subscriber: sub.pattern, ok: null, dry_run: true }); continue }
            try {
              const subEnv = await sub.handler(env)
              const ok = !!(subEnv && subEnv.ok === true)
              results.push({ event_id: env.id, subscriber: sub.pattern, ok, error_code: ok ? null : subEnv?.error?.code || 'E_INTERNAL' })
              if (ok) redispatched++
            } catch (e) {
              results.push({ event_id: env.id, subscriber: sub.pattern, ok: false, error_code: 'E_INTERNAL', error: String(e?.message || e) })
            }
          }
        }
      }
      // 源 2：outbox pending/dead_letter
      let pending = []
      try {
        pending = plainAll(db.prepare(`SELECT * FROM event_outbox WHERE status IN ('pending','dead_letter') AND producer_ts >= ? LIMIT 500`).all(since))
      } catch { pending = [] }
      for (const row of pending) {
        let env = null
        try { env = JSON.parse(row.payload) } catch { continue }
        const matched = matchSubscribers(env.name).filter((s) => s.mode === 'async' && (!subFilter || s.pattern === subFilter))
        for (const sub of matched) {
          if (dryRun) { results.push({ event_id: env.id, subscriber: sub.pattern, ok: null, dry_run: true }); continue }
          try {
            const subEnv = await sub.handler(env)
            const ok = !!(subEnv && subEnv.ok === true)
            results.push({ event_id: env.id, subscriber: sub.pattern, ok, error_code: ok ? null : subEnv?.error?.code || 'E_INTERNAL' })
            if (ok) {
              redispatched++
              db.prepare(`INSERT OR REPLACE INTO bus_subscription(event_id,subscriber,mode,status,attempt,last_error,consumed_at) VALUES(?,?,?,?,?,?,?)`)
                .run(env.id, sub.pattern, 'async', 'delivered', 0, null, now())
            }
          } catch (e) {
            results.push({ event_id: env.id, subscriber: sub.pattern, ok: false, error_code: 'E_INTERNAL', error: String(e?.message || e) })
          }
        }
      }
      const maxTs = scanned.reduce((m, e) => Math.max(m, e.ts || 0), 0)
      if (maxTs) metaSet('replay.watermark', maxTs)
      return {
        data: { scanned: scanned.length, redispatched, skipped_sync: skippedSync, results },
        events: [{ name: 'bus.replay.completed', payload: { since, scanned: scanned.length, redispatched } }],
        target: { since, dry_run: dryRun },
      }
    },
    bus_prune: async (args) => {
      const force = args.force === true
      const lastAt = metaGet('prune.last_at')
      if (!force && lastAt !== null && now() - Number(JSON.parse(lastAt)) < PRUNE_COOLDOWN_MS) {
        return { data: { skipped: true, reason: '距上次清理 <6h（force 可跳过）', idempotency_pruned: 0, events_files_rotated: 0, audit_bytes: 0 } }
      }
      let pruned = 0
      try {
        const cutoff = now() - IDEM_RETENTION_MS
        const r1 = db.prepare(`DELETE FROM idempotency WHERE created_at < ?`).run(cutoff)
        pruned += r1.changes
        const r2 = db.prepare(`DELETE FROM idempotency WHERE idempotency_key IN (
          SELECT idempotency_key FROM idempotency ORDER BY created_at DESC LIMIT -1 OFFSET ?)`).run(IDEM_MAX_ROWS)
        pruned += r2.changes
      } catch (e) { log(`幂等清理失败: ${e?.message}`) }
      let rotated = 0
      try {
        for (const f of fs.readdirSync(eventsDir).filter((x) => x.endsWith('.jsonl'))) {
          const p = path.join(eventsDir, f)
          const st = fs.statSync(p)
          if (st.size > 50 * 1024 * 1024) {
            const old = p + '.1'
            if (fileExists(old)) fs.unlinkSync(old)
            fs.renameSync(p, old)
            rotated++
          }
        }
      } catch { /* noop */ }
      let auditBytes = 0
      try { auditBytes = fs.statSync(auditFile).size } catch { /* noop */ }
      metaSet('prune.last_at', now())
      return { data: { skipped: false, idempotency_pruned: pruned, events_files_rotated: rotated, audit_bytes: auditBytes } }
    },
    queries: {
      bus_status: async (args) => {
        const domainsFilter = Array.isArray(args.domains) ? new Set(args.domains) : null
        const idemStats = { rows: 0, oldest_created_at: null, pruned_last_24h: 0 }
        try {
          const c = plain(db.prepare(`SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM idempotency`).get())
          idemStats.rows = c?.n || 0
          idemStats.oldest_created_at = c?.oldest || null
        } catch { /* noop */ }
        let auditBytes = 0
        try { auditBytes = fs.statSync(auditFile).size } catch { /* noop */ }
        let eventFiles = 0
        let eventLines = 0
        try {
          for (const f of fs.readdirSync(eventsDir).filter((x) => x.endsWith('.jsonl'))) {
            eventFiles++
            eventLines += fs.readFileSync(path.join(eventsDir, f), 'utf8').split('\n').filter(Boolean).length
          }
        } catch { /* noop */ }
        let outbox = { pending: 0, dead_letter: 0, max_lag_ms: null, last_delivered_at: null }
        try {
          const rows = plainAll(db.prepare(`SELECT status, COUNT(*) AS n FROM event_outbox GROUP BY status`).all())
          for (const r of rows) {
            if (r.status === 'pending') outbox.pending = r.n
            if (r.status === 'dead_letter') outbox.dead_letter = r.n
          }
          const lag = plain(db.prepare(`SELECT MAX(producer_ts) AS maxp FROM event_outbox WHERE status='pending'`).get())
          if (lag?.maxp) outbox.max_lag_ms = now() - lag.maxp
          const last = plain(db.prepare(`SELECT MAX(consumed_at) AS lc FROM bus_subscription`).get())
          outbox.last_delivered_at = last?.lc || null
        } catch { /* noop */ }
        const domainsOut = []
        for (const [d, entry] of domains.entries()) {
          if (domainsFilter && !domainsFilter.has(d)) continue
          const caps = entry.state.capabilities || {}
          const full = Object.values(caps).filter((c) => c === 'full').length
          const partial = Object.values(caps).filter((c) => c === 'partial').length
          const unsupported = Object.values(caps).filter((c) => c === 'unsupported').length
          domainsOut.push({
            domain: d, registered: true, version: entry.state.version,
            contract_compatible: entry.state.contract_compatible, backend: entry.state.backend,
            backend_reachable: entry.state.backend_reachable,
            capabilities: { full, partial, unsupported },
            commands: entry.state.commands, queries: entry.state.queries,
            last_dispatch: entry.state.last_dispatch,
          })
        }
        for (const d of DOMAIN_WHITELIST) {
          if (domainsFilter && !domainsFilter.has(d)) continue
          if (domains.has(d)) continue
          if (d === 'bus') continue
          domainsOut.push({ domain: d, registered: false, version: 0, contract_compatible: false, backend: null, backend_reachable: false, capabilities: { full: 0, partial: 0, unsupported: 0 }, commands: 0, queries: 0, last_dispatch: null })
        }
        const aliasCount = Object.keys(aliasesDoc.aliases).length + Object.keys(aliasesDoc.dispatchAliases).length
        const deprecated = Object.entries(aliasesDoc.aliases).filter(([, t]) => t && t.startsWith('_')).map(([k]) => k)
        return {
          process: { profile: profile || 'unknown', pid: process.pid, uptime_ms: now() - (busStartedAt), sidecar_singleton: sidecars },
          bus: {
            manifest_schema_version: MANIFEST_SCHEMA_VERSION,
            idempotency: idemStats,
            audit: { writable: !degraded, bytes: auditBytes },
            events: { files: eventFiles, total_lines: eventLines },
            outbox,
            aliases: { count: aliasCount, deprecated, source: aliasesDoc.source },
            degraded: degraded || null,
          },
          domains: domainsOut,
          subscribers: subscribers.map((s) => ({ source: s.source, pattern: s.pattern, mode: s.mode, as: s.as, last_error: null })),
        }
      },
      audit_tail: async (args) => {
        const n = Number.isInteger(args.n) ? Math.min(args.n, 500) : 50
        const offset = Number.isInteger(args.offset) ? Math.max(0, args.offset) : 0
        let raw = ''
        try {
          const st = fs.statSync(auditFile)
          const size = st.size
          const buf = Buffer.alloc(Math.min(size, 256 * 1024))
          const fd = fs.openSync(auditFile, 'r')
          fs.readSync(fd, buf, 0, buf.length, Math.max(0, size - buf.length))
          fs.closeSync(fd)
          raw = buf.toString('utf8')
        } catch { raw = '' }
        let lines = raw.split('\n').filter(Boolean)
        if (lines[0] && !lines[0].startsWith('{')) lines = lines.slice(1)
        const parsed = []
        for (const line of lines) {
          try {
            const o = JSON.parse(line)
            if (o && o.kind) parsed.push(o)
            else if (o && (o.tool || o.decision)) {
              parsed.push({ ts: o.ts || 0, kind: 'legacy-v4', domain: '-', cmd: o.tool || null, actor: null, session_id: o.session_id || null, operator: null, idempotency_key: null, replay: false, target: null, before: null, after: null, result: o.decision || null, error_code: null, duration_ms: null, backend: 'legacy', legacy: true })
            }
          } catch { /* 半行跳过 */ }
        }
        const filtered = parsed.filter((r) => {
          if (args.domain && r.domain !== args.domain) return false
          if (args.cmd && r.cmd !== args.cmd) return false
          if (args.actor && r.actor !== args.actor) return false
          if (args.session_id && r.session_id !== args.session_id) return false
          if (args.operator && r.operator !== args.operator) return false
          if (Number.isInteger(args.since) && r.ts < args.since) return false
          if (Number.isInteger(args.until) && r.ts > args.until) return false
          return true
        })
        const total = filtered.length
        const rows = filtered.reverse().slice(offset, offset + n)
        return { rows, total, limit: n, offset }
      },
      events_tail: async (args) => {
        const d = String(args.domain || '')
        const n = Number.isInteger(args.n) ? Math.min(args.n, 500) : 50
        const offset = Number.isInteger(args.offset) ? Math.max(0, args.offset) : 0
        let rows = []
        try {
          const p = path.join(eventsDir, `${d}.jsonl`)
          if (fileExists(p)) {
            rows = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
          }
        } catch { rows = [] }
        const filtered = args.name ? rows.filter((r) => r.name === args.name) : rows
        const total = filtered.length
        return { rows: filtered.slice(offset, offset + n), total, limit: n, offset }
      },
    },
    invariants: {},
    subscribers: {},
  }

  // 注册 bus 自身
  const busStartedAt = now()
  registerDomain({ manifest: BUS_MANIFEST, handlers: busHandlers, backend: { factory: () => ({}), capabilities: {} } })

  // --- ToolProjector（ctx.tools.register；挂载矩阵：actor 白名单 + deprecated） ---
  // 时序：bus.apply 的 registerTools 早于各域注册（域经 inject 后注册）——域注册成功后必须
  // 再投影一次（toolsCtx 缓存 ctx；registeredToolNames 去重防重复注册）
  function setToolsCtx(ctx) { toolsCtx = ctx }
  function renderJSON(_args, value) {
    return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
  }
  function sessionIdOf(exec) {
    try { const id = exec && exec.agent && exec.agent.id; return id ? String(id) : null } catch { return null }
  }
  function execCwd(exec) {
    try { const c = exec && exec.agent && exec.agent.session && exec.agent.session.header && exec.agent.session.header.cwd; return c ? String(c) : null } catch { return null }
  }

  function registerTools(ctx) {
    if (!ctx || typeof ctx.tools?.register !== 'function') return { registered: 0 }
    let count = 0
    for (const [d, entry] of domains.entries()) {
      for (const [full, def] of Object.entries(entry.manifest.commands)) {
        if (!Array.isArray(def.actor) || !def.actor.includes('model')) continue
        if (def.deprecated && !mountDeprecated) continue
        const verb = stripDomainPrefix(full, d)
        const name = full
        if (registeredToolNames.has(name)) continue
        registeredToolNames.add(name)
        ctx.tools.register({
          name,
          description: def.agent_note || full,
          parameters: def.schema || {},
          output: { schema: { type: 'object' }, render: renderJSON },
          ...(Number.isInteger(def.timeout_ms) ? { timeoutMs: def.timeout_ms } : {}),
          execute: async (args, exec) => dispatch(d, verb, args || {}, { actor: 'model', session_id: sessionIdOf(exec), cwd: execCwd(exec) }),
        })
        count++
      }
      for (const [full, def] of Object.entries(entry.manifest.queries)) {
        if (!Array.isArray(def.actor) || !def.actor.includes('model')) continue
        const name = stripDomainPrefix(full, d)
        if (registeredToolNames.has(full)) continue
        registeredToolNames.add(full)
        ctx.tools.register({
          name: full,
          description: def.agent_note || full,
          parameters: def.params || {},
          output: { schema: { type: 'object' }, render: renderJSON },
          execute: async (args, exec) => query(d, name, args || {}, { actor: 'model', session_id: sessionIdOf(exec), cwd: execCwd(exec) }),
        })
        count++
      }
    }
    // 兼容别名（目标对 model 可见才注册；目标域未注册时跳过——如 submission_draft 待 report 域 Phase 2 上线）
    for (const [alias, target] of Object.entries(aliasesDoc.aliases)) {
      const d = target.split('_')[0]
      const entry = domains.get(d)
      if (!entry) continue
      const tdef = entry.manifest.commands[target] || entry.manifest.queries[target]
      if (!tdef || !Array.isArray(tdef.actor) || !tdef.actor.includes('model')) continue
      const isQuery = !!entry.manifest.queries[target]
      if (registeredToolNames.has(alias)) continue
      registeredToolNames.add(alias)
      ctx.tools.register({
        name: alias,
        description: `[兼容别名 → ${target}] ${tdef.agent_note || ''}`,
        parameters: isQuery ? (tdef.params || {}) : (tdef.schema || {}),
        output: { schema: { type: 'object' }, render: renderJSON },
        execute: async (args, exec) => isQuery
          ? query('', alias, args || {}, { actor: 'model', session_id: sessionIdOf(exec) })
          : dispatch('', alias, args || {}, { actor: 'model', session_id: sessionIdOf(exec) }),
      })
      count++
    }
    return { registered: count }
  }

  // --- RpcProjector（/silksec-domain，authority loopback；operator 从连接上下文注入） ---
  function registerRpc(connection) {
    if (!connection || typeof connection.rpc?.handle !== 'function') return () => {}
    const dispose = connection.rpc.handle('/silksec-domain', async (endpoint, payload) => {
      const ep = String(endpoint || '')
      const dot = ep.indexOf('.')
      if (dot <= 0) return { ok: false, error: { code: 'E_SCHEMA', message: `端点格式非法: ${ep}`, details: {} } }
      const domain = ep.slice(0, dot)
      const verb = ep.slice(dot + 1)
      const body = payload && typeof payload === 'object' ? { ...payload } : {}
      delete body.operator
      delete body.actor
      const operator = rpcOperator ? rpcOperator() : null
      try {
        const entry = domains.get(domain)
        const isCmd = entry && findCommandDef(entry, domain, verb)
        const isQuery = entry && findQueryDef(entry, domain, verb)
        let value
        if (isCmd) value = await dispatch(domain, verb, body, { actor: 'dashboard', operator })
        else if (isQuery) value = await query(domain, verb, body, { actor: 'dashboard', operator })
        else value = await dispatch(domain, verb, body, { actor: 'dashboard', operator })
        return { ok: true, value }
      } catch (error) {
        return { ok: false, error: { code: 'internal', message: error?.message ?? String(error), details: {} } }
      }
    }, { authority: 'loopback' })
    return () => { try { dispose() } catch { /* noop */ } }
  }

  // --- 后台单例（web 宿主面）：dispatcher tick + 心跳 + AGENTS.md secbus 区块 ---
  const isWeb = profile === 'web' || process.argv.includes('web')
  let timer = null
  let lockHeld = false
  const dispatcherLockPath = path.join(dataDir, 'dispatcher.lock')
  const busLockPath = path.join(dataDir, 'bus.lock')

  function startBackground() {
    if (!sidecars || !isWeb) return { started: false, reason: '非 web 宿主面或 sidecars=false' }
    if (!acquireLock(dispatcherLockPath, process.pid)) return { started: false, reason: 'dispatcher.lock 已被占用' }
    lockHeld = true
    const run = async () => {
      try {
        await dispatcherTick()
        if (fileExists(agentsMd)) refreshAgentsMd()
      } catch (e) { log(`dispatcher tick 异常: ${e?.message}`) }
      touchLock(dispatcherLockPath, process.pid)
    }
    run()
    timer = setInterval(run, dispatcherIntervalMs)
    timer.unref?.()
    return { started: true }
  }

  function stopBackground() {
    if (timer) { clearInterval(timer); timer = null }
    if (lockHeld) releaseLock(dispatcherLockPath, process.pid)
  }

  function refreshAgentsMd() {
    try {
      if (!fileExists(agentsMd)) return false
      let text = fs.readFileSync(agentsMd, 'utf8')
      const lines = []
      for (const [d, entry] of domains.entries()) {
        const verbs = Object.keys(entry.manifest.commands).map((k) => stripDomainPrefix(k, d)).join(' / ')
        const qs = Object.keys(entry.manifest.queries).map((k) => stripDomainPrefix(k, d)).join(' / ')
        lines.push(`| ${d}_ | ${verbs}${qs ? '（查询：' + qs + '）' : ''} |`)
      }
      const block = `<!-- secbus:begin -->\n## 域动词速查（自动生成，勿手改；权威清单以工具面为准）\n\n| 域前缀 | 动词 |\n|---|---|\n${lines.join('\n')}\n<!-- secbus:end -->`
      const re = /<!-- secbus:begin -->[\s\S]*?<!-- secbus:end -->/
      if (re.test(text)) text = text.replace(re, block)
      else text = text.replace(/\s*$/, '\n\n' + block)
      fs.writeFileSync(agentsMd, text)
      return true
    } catch (e) { log(`AGENTS.md secbus 区块重写失败: ${e?.message}`); return false }
  }

  // --- 组装 facade（对外门面：无任何域业务方法） ---
  const facade = {
    dispatch,
    query,
    events: { publish: publishInTx, subscribe, list: () => subscribers.map((s) => ({ pattern: s.pattern, mode: s.mode, as: s.as, source: s.source })) },
    status: () => ({ degraded, domains: [...domains.keys()], subscribers: subscribers.length }),
    registry: { list: () => [...domains.keys()], get: (d) => (domains.get(d) ? { manifest: domains.get(d).manifest, state: domains.get(d).state } : null), register: registerDomain },
  }
  facade._internal = {
    registerDomain, registerTools, setToolsCtx, registerRpc, startBackground, stopBackground,
    dispatcherTick, refreshAgentsMd, close: () => { stopBackground(); try { db?.close() } catch { /* noop */ } },
    db: () => db, domains, aliasesDoc, subscribers,
  }

  return facade
}

// ---------------------------------------------------------------------------
// cordis 插件入口
// ---------------------------------------------------------------------------

export function apply(ctx, config = {}) {
  const bus = createBus({
    profile: process.argv.includes('web') ? 'web' : 'headless',
    sidecars: config.sidecars !== false,
  })
  // host 面（sidecars !== false）provide 门面；agent 面（sidecars:false）不 provide——
  // 同一进程内 web profile 与 agent preset 会双挂载本插件，重复 provide 冲突；
  // agent 面只需要工具投影 + 经父容器 inject 链访问宿主门面。
  if (config.sidecars !== false) {
    try {
      ctx.provide('secDomainBus', bus)
    } catch (e) {
      log(`provide secDomainBus 失败: ${e?.message}`)
    }
  }
  // ToolProjector（工具面；agent 面 sidecars:false 时仍注册工具——投影是工具面不是后台）
  // setToolsCtx 先行：域插件在 bus.apply 之后注册，注册成功时 bus 用缓存 ctx 再投影
  try { bus._internal.setToolsCtx(ctx) } catch (e) { log(`setToolsCtx 失败: ${e?.message}`) }
  try { bus._internal.registerTools(ctx) } catch (e) { log(`ToolProjector 失败: ${e?.message}`) }
  // RpcProjector（仅 connection 服务存在时）
  try {
    ctx.inject(['connection'], (child) => {
      child.effect(() => {
        const dispose = bus._internal.registerRpc(child.connection)
        return () => { try { dispose() } catch { /* noop */ } }
      }, 'sec-domain-bus: rpc')
    })
  } catch { /* 无 connection（headless）*/ }
  // 后台单例（dispatcher + AGENTS.md 区块；仅 web 宿主面 + sidecars）
  const bg = bus._internal.startBackground()
  log(`apply 完成（profile=${config.sidecars !== false ? 'web-host' : 'agent'}，dispatcher=${bg.started ? 'started' : bg.reason}）`)
  return bus
}

// ---------------------------------------------------------------------------
// 健康自检导出（setup/CLI 用）
// ---------------------------------------------------------------------------
export const version = '1.0.0'
export const manifestSchemaVersion = MANIFEST_SCHEMA_VERSION
export const domainWhitelist = [...DOMAIN_WHITELIST]
