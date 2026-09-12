// ==============================================================================
// @silksec/sec-domain-exec — SilkSecAgent exec 域插件（v5 Phase 2.4：工具执行/沙箱/限速/worker 派生/parser 提案）
//
// 契约：doc/secagent/v5/10-exec.md（域设计，权威）+ 01-bus.md + 00-conventions.md
//
// 语义要点：
//  - 一切 CLI/worker 执行的唯一入口：守卫链 G0-G9 fail-closed；
//  - 执行产物与领域数据之间只隔一层事件：exec.run.completed 携带 parse_proposal（parser 直写归零）；
//  - exec_run_cli 幂等 explicit_only（同参重扫是合法业务，不落自动指纹）；
//  - exec_spawn_worker 发布 exec.worker.spawned/finished（强联动）→ task 域记账；
//  - scope 校验在 scope 域（2.6）上线前暂读 scope.yml（fail-closed 语义不变，切流后换 scope_check）。
// ==============================================================================

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import * as dns from 'node:dns'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const name = 'sec-domain-exec'
export const version = '1.0.0'

const DEFAULT_DATA_DIR = process.env.SEC_DATA_DIR || '/opt/silkspool/dsh/data'

const log = (msg) => { try { process.stderr.write(`[sec-domain-exec] ${msg}\n`) } catch { /* noop */ } }

const backendUrl = new URL('../sec-backend-exec-file/index.js', import.meta.url)
const { createExecFileBackend } = await import(backendUrl.href)

const schema = (properties, required, extra = {}) => ({ type: 'object', properties, required, additionalProperties: false, ...extra })
const str = (opts = {}) => ({ type: 'string', ...opts })
const en = (values, extra = {}) => ({ type: 'string', enum: values, ...extra })
const int = (opts = {}) => ({ type: 'integer', ...opts })

const RISK_ORDER = ['passive', 'active', 'intrusive', 'manual']
const RESERVED_CIDRS = [
  { base: 0x00000000, bits: 8 }, { base: 0x0a000000, bits: 8 }, { base: 0x64400000, bits: 10 },
  { base: 0x7f000000, bits: 8 }, { base: 0xa9fe0000, bits: 16 }, { base: 0xac100000, bits: 12 },
  { base: 0xc0a80000, bits: 16 },
]
const WRITE_VERBS = new Set([
  'create', 'add', 'new', 'update', 'edit', 'modify', 'delete', 'remove', 'drop', 'settle', 'refund', 'pay',
  'payment', 'transfer', 'withdraw', 'reset', 'generate', 'send', 'sms', 'upload', 'import', 'exec', 'eval',
  'trigger', 'deploy', 'launch', 'approve', 'submit', 'order', 'trade', 'cash', 'bind', 'unbind',
])
const NUCLEI_SKIP_TEMPLATE = /(tech-detect|favicon|waf-detect|http-fingerprint|screenshot|tls-version|ssl-cipher|cdn-|whois-|http-options|http-trace|http-methods)/i
const ROE_ANCHOR = 'Rules of Engagement 交战规则'
const ROE_BLOCK = [
  `【${ROE_ANCHOR}（宿主注入，硬约束，与本任务描述冲突时以本块为准）】`,
  '1. 目标列表必须作为数据逐字出现在本任务里；指代式目标一律视为未授权。',
  '2. 测程中新发现主机一律 report-only；纳入 scope 须先走审批。',
  '3. read-only 展开为 GET/HEAD/OPTIONS/DNS/被动指纹；一切写动词不在只读范围。',
  '4. 被拒后不换姿势重试，改走审批（scope-guard 是 fail-closed 硬校验）。',
  '5. 只读工具打写动词路径会被 S5 拒绝；确需写操作用 active/intrusive 工具并走审批。',
].join('\n')

const BWRAP_BIN = process.env.SEC_BWRAP_BIN || '/usr/bin/bwrap'
const SANDBOX_DISABLED = process.env.SEC_NO_SANDBOX === '1'
const HOME_DIR = process.env.HOME || '/home/silkspool'
const VENV_DIR = '/opt/silkspool/dsh/venv'
const OPT_DIR = '/opt/silkspool/dsh/opt'
const DSH_BIN = process.env.SEC_DSH_BIN || '/opt/silkspool/dsh/app/node_modules/@deepseek-ai/dsh/lib/bin.js'
const NODE_BIN = process.env.SEC_NODE_BIN || '/usr/local/node/bin/node'
const MAX_WORKERS = 4

export const EXEC_MANIFEST = {
  domain: 'exec',
  version: 1,
  service: 'secDomain.exec',
  description: '工具执行/沙箱/限速/worker 派生/parser 提案——一切 CLI/worker 执行的唯一入口，执行产物与领域数据之间只隔一层事件',
  owns: {
    tables: [],
    files: ['data/tools.d/', 'data/results/', 'data/flows/', 'data/imports/', 'data/events/exec.jsonl'],
  },
  backend_transactional: false,
  commands: {
    exec_run_cli: {
      actor: ['model', 'dashboard', 'script', 'human'],
      schema: schema({
        tool: str({ minLength: 1 }),
        params: { type: 'object' },
        idempotency_key: str(),
      }, ['tool', 'params']),
      idempotent: 'explicit_only',
      events: ['exec.run.started', 'exec.run.failed', 'exec.run.completed'],
      event_limit: 5,
      invariants: [],
      timeout_ms: 3670000,
      agent_note: '运行已登记的安全 CLI 工具（manifest 驱动）。目标经 scope-guard 白名单硬校验（fail-closed），参数模板化渲染，输出全量落盘 results/<run_id>/，只回 ≤20 行摘要。细节用 exec_grep_result/exec_page_result 取。',
      deprecated: false,
    },
    exec_spawn_worker: {
      actor: ['model', 'dashboard', 'scheduler'],
      schema: schema({
        task: str({ minLength: 1 }),
        phase: str(),
        timeout: int({ minimum: 1, maximum: 7200 }),
        force: { type: 'boolean' },
        provider: str(),
        model: str(),
      }, ['task']),
      idempotent: 'none',
      events: ['exec.worker.spawned', 'exec.worker.finished'],
      event_limit: 2,
      invariants: [],
      timeout_ms: 3670000,
      agent_note: '派一个隔离的无头 worker 执行自包含任务（批量复扫、大日志蒸馏等），跑完只回尾部摘要，全文落盘 results/<run_id>/worker.log。幂等：宿主重启后原样重试确定性拿回真实结果；强制重跑传 force:true。',
      deprecated: false,
    },
    exec_burp_import: {
      actor: ['model', 'human'],
      schema: schema({ file: str({ minLength: 1 }) }, ['file']),
      idempotent: 'natural',
      idempotent_natural: ['file'],
      events: ['exec.import.completed'],
      event_limit: 1,
      invariants: ['burpFileExists'],
      timeout_ms: 180000,
      agent_note: '导入 Burp Suite 导出文件（XML：proxy history 或 scanner issues），结构化落盘 data/imports/ 并发 proposal 事件回流资产/接口/候选。',
      deprecated: false,
    },
    exec_report_bad_proxy: {
      actor: ['model', 'script', 'dashboard'],
      schema: schema({ proxy_url: str({ minLength: 1 }), evidence: str({ default: '' }), run_id: str({ default: '' }) }, ['proxy_url']),
      idempotent: 'natural',
      idempotent_natural: ['proxy_url'],
      events: [],
      invariants: [],
      timeout_ms: 60000,
      agent_note: '上报坏代理（加入 blocklist + 从 live 移除，mubeng 热加载生效）。跨域命令：经 proxy 域落池。',
      deprecated: false,
    },
    exec_intel_hunt: {
      actor: ['model', 'dashboard'],
      schema: schema({
        tech: str({ minLength: 1 }),
        version: str({ default: '' }),
        program_id: str(),
        host: str({ default: '' }),
        create_task: { type: 'boolean' },
      }, ['tech']),
      idempotent: 'auto',
      idempotent_fields: ['tech', 'version', 'program_id', 'host', 'create_task'],
      events: [],
      invariants: [],
      timeout_ms: 60000,
      agent_note: 'component-vuln-intel：指纹命中后查本地 nuclei 模板库找 tech 相关 N-day 模板/CVE，命中可自动产出 phase=vuln、priority=1 的 N-day 候选任务（tentative）。',
      deprecated: false,
    },
    exec_flow_append: {
      actor: ['webhook'],
      schema: schema({ source: en(['xray']), payload: { type: 'object' } }, ['source', 'payload']),
      idempotent: 'auto',
      idempotent_fields: ['source', 'payload'],
      events: ['exec.flow.appended'],
      event_limit: 1,
      invariants: [],
      timeout_ms: 60000,
      agent_note: '机器通道：xray webhook 原始 flow 落盘（不向模型注册）。',
      deprecated: false,
    },
  },
  queries: {
    exec_grep_result: {
      actor: ['model', 'dashboard', 'human'],
      params: schema({
        run_id: str({ minLength: 1 }),
        pattern: str({ minLength: 1 }),
        max: int({ minimum: 1, maximum: 200 }),
      }, ['run_id', 'pattern']),
      agent_note: '在指定 run_id 的完整输出中按正则检索（大小写不敏感），返回匹配行（含行号与文件路径）。',
    },
    exec_page_result: {
      actor: ['model', 'dashboard', 'human'],
      params: schema({
        run_id: str({ minLength: 1 }),
        offset: int({ minimum: 0 }),
        limit: int({ minimum: 1, maximum: 200 }),
      }, ['run_id']),
      agent_note: '按行区间分页读取指定 run_id 的完整输出（offset 0 基，limit 上限 200）。',
    },
    exec_plan_chain: {
      actor: ['model', 'dashboard', 'human'],
      params: schema({
        have: { type: 'array', items: { type: 'string' } },
        want: str({ minLength: 1 }),
      }, ['want']),
      agent_note: '能力原语凑链：给定 have 与 want，按 manifest requires/produces 做 BFS 图搜索，返回有序工具链。',
    },
    exec_manifest_list: {
      actor: ['model', 'dashboard', 'human'],
      params: schema({ stage: str(), risk: str(), domain: str() }, []),
      agent_note: '枚举已登记 CLI 工具 manifest（按 stage/risk/产物域过滤），含能力与沙箱声明。',
    },
  },
  events: {
    'exec.run.started': { payload: { type: 'object' }, redact: [] },
    'exec.run.failed': { payload: { type: 'object' }, redact: [] },
    'exec.run.completed': { payload: { type: 'object' }, redact: [] },
    'exec.worker.spawned': { payload: { type: 'object' }, redact: [] },
    'exec.worker.finished': { payload: { type: 'object' }, redact: [] },
    'exec.flow.appended': { payload: { type: 'object' }, redact: [] },
    'exec.import.completed': { payload: { type: 'object' }, redact: [] },
  },
  subscribes: {
    // QPS cap 在 acquireQpsToken 中每次对齐 loadScope 的 rate_limit_qps。
    // 不订阅 scope.rules.changed：sync 订阅无法跨 headless worker 进程生效，
    // 且当前 handler 本身就是 no-op，保留会制造虚假的事件依赖。
  },
  backend: 'repository-v1',
}

// ---------------------------------------------------------------------------
// scope 桥（scope 域 2.6 上线前暂读 scope.yml；fail-closed 语义不变）
// ---------------------------------------------------------------------------

function ipToInt(ip) {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  let n = 0
  for (const p of parts) { const v = Number(p); if (!Number.isInteger(v) || v < 0 || v > 255) return null; n = n * 256 + v }
  return n
}
function cidrContains(cidr, ip) {
  const [base, bitsRaw] = cidr.split('/')
  const bits = Number(bitsRaw); const b = ipToInt(base); const t = ipToInt(ip)
  if (b === null || t === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false
  if (bits === 0) return true
  const mask = bits === 32 ? 0xffffffff : (0xffffffff << (32 - bits)) >>> 0
  return (b & mask) >>> 0 === (t & mask) >>> 0
}
function hostOf(raw) {
  let s = String(raw).trim()
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
  s = s.split('/')[0].split('?')[0].split('#')[0]
  if (s.startsWith('[')) return s.slice(1, s.indexOf(']'))
  if (s.includes(':') && /:\d+$/.test(s)) s = s.slice(0, s.lastIndexOf(':'))
  return s.toLowerCase()
}
function isInternalHost(host) {
  if (!host) return false
  if (host === 'localhost' || host.endsWith('.singll.net') || host.endsWith('.internal') || host.endsWith('.lan')) return true
  const ip = ipToInt(host)
  if (ip === null) return false
  const a = (ip >>> 24) & 255; const b = (ip >>> 16) & 255
  return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254)
}
function entryMatches(entry, host) {
  entry = String(entry).trim().toLowerCase()
  if (!entry) return false
  if (entry.includes('/')) return ipToInt(host) !== null && cidrContains(entry, host)
  if (entry.startsWith('*.')) { const suffix = entry.slice(1); return host === entry.slice(2) || host.endsWith(suffix) }
  return host === entry
}
function ipInReserved(ipInt) {
  for (const c of RESERVED_CIDRS) {
    const mask = c.bits === 32 ? 0xffffffff : (0xffffffff << (32 - c.bits)) >>> 0
    if (((c.base & mask) >>> 0) === ((ipInt & mask) >>> 0)) return true
  }
  return false
}
function programAllowsIp(programCfg, ip) {
  const entries = Array.isArray(programCfg && programCfg.scope) ? programCfg.scope : []
  const ipi = ipToInt(ip)
  return entries.some((e) => {
    e = String(e).trim().toLowerCase()
    if (e.includes('/')) return ipi !== null && cidrContains(e, ip)
    return ipi !== null && ipToInt(e) === ipi
  })
}

function renderTemplate(tpl, params, runDir, runId) {
  return String(tpl).replace(/\{\{\s*([a-zA-Z0-9_]+)(\|([^}]*))?\s*\}\}/g, (_m, key, _d, def) => {
    if (key === 'outdir') return runDir
    if (key === 'run_id') return runId
    const v = params[key]
    if (v === undefined || v === null || v === '') { if (def !== undefined) return def; throw new Error(`缺少必填参数: ${key}`) }
    return String(v)
  })
}
function shellSplit(s) {
  const out = []; let cur = ''; let q = null
  for (const c of s) {
    if (q) { if (c === q) q = null; else cur += c; continue }
    if (c === '"' || c === "'") { q = c; continue }
    if (/\s/.test(c)) { if (cur) { out.push(cur); cur = '' } continue }
    cur += c
  }
  if (cur) out.push(cur)
  return out
}
function extractTargets(manifest, params) {
  const tp = manifest.target_param
  if (!tp) return []
  const v = params[tp]
  if (v === undefined || v === null || v === '') return []
  if (tp.endsWith('_file')) {
    try { return fs.readFileSync(String(v), 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')) } catch { return [`__unreadable_file__:${v}`] }
  }
  return String(v).split(',').map((s) => s.trim()).filter(Boolean)
}
function findWriteVerbHit(renderedCmd) {
  const urls = String(renderedCmd).match(/https?:\/\/[^\s"'<>|`]+/gi) || []
  for (const u of urls) {
    const m = u.match(/^https?:\/\/[^/?#]+([^?#]*)/i)
    const pathSegs = m && m[1] ? m[1].split('/') : []
    for (const seg of pathSegs) {
      const clean = seg.toLowerCase().replace(/^[^a-z0-9]+/, '').replace(/(\.[a-z0-9]{1,5})?[^a-z0-9]*$/, '')
      if (!clean) continue
      for (const tok of clean.split(/[-_]/)) if (WRITE_VERBS.has(tok)) return { verb: tok, url: u }
    }
  }
  return null
}
function sanitizeParamsForApproval(params) {
  const out = {}
  for (const [k, v] of Object.entries(params || {})) {
    if (typeof v === 'string') out[k] = v.length > 60 ? v.slice(0, 60) + '…' : v
    else out[k] = Array.isArray(v) ? '[array]' : (v && typeof v === 'object' ? '[object]' : v)
  }
  return out
}

// ---------------------------------------------------------------------------
// parser 注册表（只读 stdout、只写 proposal.json，不落库）
// ---------------------------------------------------------------------------

function hostOfUrl(raw) { try { return new URL(String(raw)).host || '' } catch { return '' } }
function pathOfUrl(raw) { try { const u = new URL(String(raw)); return u.pathname + u.search } catch { return '' } }
function normSev(sev) { const s = String(sev || '').toLowerCase(); return ['critical', 'high', 'medium', 'low', 'info'].includes(s) ? s : 'info' }
function passesRuleLayer(kind, record) {
  if (kind !== 'nuclei') return true
  return !NUCLEI_SKIP_TEMPLATE.test(String(record.template_id || ''))
}
function parseJsonlHttpx(text, ctx) {
  const assets = []; const endpoints = []; const seen = new Set()
  for (const line of String(text).split('\n')) {
    const t = line.trim()
    if (!t || !t.startsWith('{')) continue
    let o; try { o = JSON.parse(t) } catch { continue }
    const host = o.host || o.input || hostOfUrl(o.url || '')
    if (!host) continue
    const url = o.url || ''
    const attrs = { port: o.port !== undefined ? String(o.port) : '', title: o.title || '', webserver: o.webserver || '', status: o.status_code !== undefined ? o.status_code : '', tech: Array.isArray(o.tech) ? o.tech : [] }
    if (!seen.has(host)) { assets.push({ host, type: 'web', source: ctx.source, attrs }); seen.add(host) }
    if (url) endpoints.push({ host, method: 'GET', path: pathOfUrl(url), status: String(o.status_code || ''), source: ctx.source })
  }
  return { assets, endpoints, findings: [], fingerprints: [] }
}
function parseJsonlNuclei(text, ctx) {
  const findings = []
  for (const line of String(text).split('\n')) {
    const t = line.trim()
    if (!t || !t.startsWith('{')) continue
    let o; try { o = JSON.parse(t) } catch { continue }
    const info = o.info || {}
    const matched = o['matched-at'] || ''
    const host = o.host || hostOfUrl(matched)
    if (!host) continue
    const rec = { title: info.name || o['template-id'] || 'nuclei finding', severity: normSev(info.severity), host, url: matched, template_id: o['template-id'] || '', evidence: `run_id:${ctx.runId} template:${o['template-id'] || ''}` }
    if (!passesRuleLayer('nuclei', rec)) continue
    findings.push({ title: rec.title, severity: rec.severity, host: rec.host, url: rec.url, evidence: rec.evidence })
  }
  return { assets: [], endpoints: [], findings, fingerprints: [] }
}
function parseCsvFfuf(text, ctx) {
  const endpoints = []; let host = ''
  for (const line of String(text).split('\n')) {
    const t = line.trim()
    if (!t) continue
    const m = t.match(/https?:\/\/[^\s,"]+/i)
    if (m) { const h = hostOfUrl(m[0]); if (h) { host = h; endpoints.push({ host: h, method: 'GET', path: pathOfUrl(m[0]), status: '', source: ctx.source }) } }
  }
  return { assets: host ? [{ host, type: 'web', source: ctx.source }] : [], endpoints, findings: [], fingerprints: [] }
}
const PARSERS = { jsonl_httpx: parseJsonlHttpx, jsonl_nuclei: parseJsonlNuclei, csv_ffuf: parseCsvFfuf }

function runParser(manifest, toolName, runId, text, programId) {
  const source = `${toolName}:${runId}`
  const ctx = { tool: toolName, runId, source, programId }
  const parserKey = String(manifest.parser || '')
  let fn = PARSERS[`${parserKey}_${toolName}`] || PARSERS[parserKey]
  let parsed = { assets: [], endpoints: [], findings: [], fingerprints: [] }
  let skipped = {}
  if (fn) {
    try { parsed = fn(String(text), ctx) || { assets: [], endpoints: [], findings: [], fingerprints: [] } } catch (e) { log(`${toolName} parser 异常: ${e?.message}`) }
  }
  // httpx tech → fingerprints（原 parsers.js 内嵌逻辑）
  const fingerprints = []
  for (const a of (parsed.assets || [])) {
    const techs = a && a.attrs && Array.isArray(a.attrs.tech) ? a.attrs.tech : []
    for (const tech of techs) if (tech) fingerprints.push({ host: a.host, tech: String(tech), source })
  }
  return { run_id: runId, tool: toolName, parser: parserKey || 'none', program_id: programId || null, session_id: null, assets: parsed.assets || [], fingerprints, endpoints: parsed.endpoints || [], findings: parsed.findings || [], skipped, counts: { assets: (parsed.assets || []).length, endpoints: (parsed.endpoints || []).length, findings: (parsed.findings || []).length, fingerprints: fingerprints.length } }
}

// ---------------------------------------------------------------------------
// handlers
// ---------------------------------------------------------------------------

function makeHandlers(opts) {
  const dispatchRef = opts.dispatch
  const queryRef = opts.query
  const dataDir = opts.dataDir || DEFAULT_DATA_DIR
  const scopeFile = opts.scopeFile || path.join(dataDir, 'scope.yml')
  const egressProxy = process.env.SEC_EGRESS_PROXY || 'http://127.0.0.1:8899'
  let activeWorkers = 0
  const qpsBucket = { tokens: Infinity, cap: 50, last: 0 }
  let currentTool = null

  function throwErr(code, message, hint, retryable = false) { throw Object.assign(new Error(message), { code, hint, retryable }) }
  function pidAlive(pid) { try { process.kill(pid, 0); return true } catch { return false } }

  function loadScope() {
    try { return parseScopeYaml(fs.readFileSync(scopeFile, 'utf8')) } catch { return { programs: [], defaults: {} } }
  }
  function parseScopeYaml(text) {
    // 极小解析：逐行扫描（scope.yml 结构稳定）
    const out = { programs: [], defaults: {} }
    let curProgram = null
    let curKey = ''
    let inScopeList = false; let inExcludeList = false; let inAllowIntrusive = false; let inRules = false
    let inDefaults = false
    for (const raw of String(text).split('\n')) {
      const line = raw.replace(/#.*$/, '')
      if (!line.trim()) continue
      const indent = line.length - line.trimStart().length
      const s = line.trim()
      let m
      if ((m = s.match(/^defaults:\s*$/))) { inDefaults = true; curProgram = null; continue }
      if (inDefaults) {
        if ((m = s.match(/^rate_limit_qps:\s*(\d+)/))) out.defaults.rate_limit_qps = Number(m[1])
        if ((m = s.match(/^allow_risk:\s*\[(.*)\]/))) out.defaults.allow_risk = m[1].split(',').map((x) => x.trim()).filter(Boolean)
        if (indent === 0 && !s.startsWith('defaults:')) inDefaults = false
      }
      if ((m = s.match(/^- name:\s*["']?([^"']+)["']?/))) { curProgram = { name: m[1], scope: [], exclude: [], rules: {} }; out.programs.push(curProgram); inRules = false; continue }
      if (curProgram) {
        if ((m = s.match(/^scope:\s*$/))) { inScopeList = true; inExcludeList = false; inAllowIntrusive = false; inRules = false; continue }
        if ((m = s.match(/^exclude:\s*$/))) { inExcludeList = true; inScopeList = false; inAllowIntrusive = false; inRules = false; continue }
        if ((m = s.match(/^rules:\s*$/))) { inRules = true; inScopeList = false; inExcludeList = false; inAllowIntrusive = false; continue }
        if ((m = s.match(/^allow_intrusive_tools:\s*$/))) { inAllowIntrusive = true; inRules = false; inScopeList = false; inExcludeList = false; continue }
        if ((m = s.match(/^- ["']?([^"']+)["']?$/))) {
          if (inScopeList) curProgram.scope.push(m[1])
          else if (inExcludeList) curProgram.exclude.push(m[1])
          else if (inAllowIntrusive) { curProgram.rules.allow_intrusive_tools = curProgram.rules.allow_intrusive_tools || []; curProgram.rules.allow_intrusive_tools.push(m[1]) }
          continue
        }
        if (inRules) {
          if ((m = s.match(/^max_risk:\s*(\w+)/))) curProgram.rules.max_risk = m[1]
          continue
        }
      }
    }
    return out
  }

  function checkTarget(rawTarget) {
    const host = hostOf(rawTarget)
    if (!host) return { allow: false, reason: `无法解析目标: ${rawTarget}` }
    const scope = loadScope()
    for (const p of scope.programs || []) {
      const excludes = Array.isArray(p.exclude) ? p.exclude : []
      if (excludes.some((e) => entryMatches(e, host))) return { allow: false, reason: `目标 ${host} 在项目 ${p.name} 的排除清单中`, program: p.name }
      const entries = Array.isArray(p.scope) ? p.scope : []
      if (entries.some((e) => entryMatches(e, host))) return { allow: true, reason: `命中项目 ${p.name} 授权范围`, program: p.name, programCfg: p }
    }
    return { allow: false, reason: `目标 ${host} 不在任何授权项目范围内（scope.yml fail-closed）` }
  }
  function checkRisk(manifestRisk, programCfg, toolName) {
    const scope = loadScope()
    const allowRisk = (scope.defaults && scope.defaults.allow_risk) || ['passive', 'active']
    const maxRisk = (programCfg && programCfg.rules && programCfg.rules.max_risk) || null
    if (manifestRisk === 'manual') return { allow: false, reason: 'risk=manual 工具默认禁用，需人工放行' }
    if (maxRisk && RISK_ORDER.indexOf(manifestRisk) > RISK_ORDER.indexOf(maxRisk)) return { allow: false, reason: `工具风险级 ${manifestRisk} 超过项目上限 ${maxRisk}` }
    const allowIntrusive = (programCfg && programCfg.rules && Array.isArray(programCfg.rules.allow_intrusive_tools) ? programCfg.rules.allow_intrusive_tools : []).map((s) => String(s).toLowerCase())
    if (allowIntrusive.length && manifestRisk === 'intrusive' && toolName && allowIntrusive.includes(String(toolName).toLowerCase())) return { allow: true }
    if (!allowRisk.includes(manifestRisk)) return { allow: false, reason: `工具风险级 ${manifestRisk} 需要人工确认（allow_risk: ${allowRisk.join('/')}）`, needsApproval: manifestRisk === 'intrusive' }
    return { allow: true }
  }
  async function verifyResolved(targets, manifest) {
    if (RISK_ORDER.indexOf(String(manifest.risk || 'passive')) < RISK_ORDER.indexOf('active')) return null
    for (const t of targets) {
      const host = hostOf(t)
      if (!host) continue
      const chk = checkTarget(host)
      const cfg = chk.programCfg || null
      const ipi = ipToInt(host)
      if (ipi !== null) { if (ipInReserved(ipi) && !programAllowsIp(cfg, host)) return `目标 ${host} 为内网/保留 IP 且不在项目 ${chk.program || '?'} 授权 CIDR 内`; continue }
      let ips = []
      try { ips = await dns.promises.resolve4(host) } catch { ips = [] }
      for (const ip of ips) { const ri = ipToInt(ip); if (ri !== null && ipInReserved(ri) && !programAllowsIp(cfg, ip)) return `目标 ${host} 解析到内网/保留 IP ${ip} 且不在项目 ${chk.program || '?'} 授权 CIDR 内` }
    }
    return null
  }
  function acquireQpsToken() {
    const qps = Math.max(1, Number(loadScope().defaults?.rate_limit_qps) || 50)
    const now = Date.now()
    if (!qpsBucket.last) { qpsBucket.last = now; qpsBucket.cap = qps }
    if (qpsBucket.cap !== qps) qpsBucket.cap = qps
    qpsBucket.tokens = Math.min(qpsBucket.cap, qpsBucket.tokens + ((now - qpsBucket.last) / 1000) * qps)
    qpsBucket.last = now
    if (qpsBucket.tokens >= 1) { qpsBucket.tokens -= 1; return 0 }
    const waitMs = Math.ceil(((1 - qpsBucket.tokens) / qps) * 1000)
    qpsBucket.tokens = 0
    return waitMs
  }
  async function throttleQps() {
    for (;;) { const w = acquireQpsToken(); if (w <= 0) break; await new Promise((r) => setTimeout(r, w)) }
  }
  function bwrapAvailable() { try { return fs.existsSync(BWRAP_BIN) } catch { return false } }
  function buildSandboxCommand(binary, argv, runDir) {
    if (SANDBOX_DISABLED || !bwrapAvailable()) return null
    const args = ['--unshare-all', '--share-net', '--die-with-parent', '--new-session', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--ro-bind', '/usr', '/usr', '--ro-bind', '/etc', '/etc', '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/sbin', '/sbin', '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64', '--bind', HOME_DIR, HOME_DIR]
    if (fs.existsSync(VENV_DIR)) args.push('--ro-bind', VENV_DIR, VENV_DIR)
    if (fs.existsSync(OPT_DIR)) args.push('--ro-bind', OPT_DIR, OPT_DIR)
    args.push('--bind', runDir, runDir)
    args.push('--', binary, ...argv)
    return { cmd: BWRAP_BIN, args }
  }
  async function fileApproval(dispatch, kind, subject, payload, evidence, actor, sessionId) {
    try { return await dispatch('approval', 'request', { kind, subject, evidence, payload }, { actor, session_id: sessionId }) } catch { return null }
  }

  const invariants = {
    burpFileExists: async (args) => {
      if (!fs.existsSync(String(args.file))) return { code: 'E_EXEC_FILE_NOT_FOUND', message: `文件不存在: ${args.file}`, hint: '本机绝对路径', retryable: false }
      return null
    },
  }

  const commands = {
    exec_run_cli: async (args, repo, ctx) => {
      const toolName = String(args.tool || '')
      const params = args.params || {}
      const manifest = repo.loadManifest(toolName)
      if (!manifest) throwErr('E_EXEC_MANIFEST_MISSING', `工具 ${toolName} 无 manifest（data/tools.d/${toolName}.yaml 不存在）`, `可用工具：${repo.listManifests().join(', ')}`)

      const { runId, runDir } = repo.createRunDir('r')
      currentTool = toolName
      const sessionId = ctx.session_id || null

      const guardAudit = []
      // G0-G9 守卫链（fail-closed，逐条）
      const targets = extractTargets(manifest, params)
      if (!manifest.target_param && RISK_ORDER.indexOf(String(manifest.risk || 'passive')) >= RISK_ORDER.indexOf('active')) {
        throwErr('E_EXEC_TARGETLESS_ACTIVE', `manifest 未声明 target_param 且 risk=${manifest.risk}≥active`, '补 manifest target_param 或降 risk；本地审计类工具 risk 应为 passive')
      }
      for (const [k, v] of Object.entries(params)) {
        if (typeof v !== 'string') continue
        if (/[\r\n]/.test(v)) throwErr('E_EXEC_PARAM_INJECTION', `参数 ${k} 含换行符`, '参数含换行，拒绝')
        if (k === manifest.target_param && /\s/.test(v)) throwErr('E_EXEC_PARAM_INJECTION', `target 参数含空白字符`, '多目标用英文逗号分隔，清单用 <target>_file 传文件')
      }
      let programId = null
      for (const t of targets) {
        const chk = checkTarget(t)
        guardAudit.push({ target: t, decision: chk.allow ? 'allow' : 'deny', reason: chk.reason })
        if (!chk.allow) throwErr('E_EXEC_SCOPE_DENIED', `scope-guard 拒绝: ${chk.reason}`, '目标不在任何授权项目（fail-closed）。候选资产走 approval_request 提请 scope-domain/scope-wildcard')
        if (programId === null && chk.program) programId = chk.program
      }
      const firstChk = targets.length ? checkTarget(targets[0]) : { programCfg: null }
      const riskChk = checkRisk(String(manifest.risk || 'passive'), firstChk.programCfg, toolName)
      if (!riskChk.allow) {
        let approvalHint = null
        if (riskChk.needsApproval && programId) {
          const add = await fileApproval(ctx.dispatch, 'tool-intrusive', `${toolName}:${targets[0] || '-'}`, { tool: toolName, risk: manifest.risk, target: targets[0] || null, params: sanitizeParamsForApproval(params), program: programId }, `intrusive 工具 ${toolName} 对 ${targets[0] || '目标'} 的调用被 allow_risk 拒绝`, 'model', sessionId)
          if (add && add.ok) approvalHint = `已自动提请 tool-intrusive 审批（批准后下个调度周期重试即放行）。本次维持拒绝，勿重试。`
        }
        throwErr(riskChk.needsApproval ? 'E_EXEC_RISK_NEEDS_APPROVAL' : 'E_EXEC_RISK_FORBIDDEN', `scope-guard 拒绝: ${riskChk.reason}`, approvalHint || '工具风险级超过授权，走审批或换工具', false)
      }
      const resolvedViolation = await verifyResolved(targets, manifest)
      if (resolvedViolation) throwErr('E_EXEC_RESERVED_IP', `scope-guard 解析后校验拒绝: ${resolvedViolation}`, '若确属授权资产，scope 条目须以 CIDR 形式显式授权')
      if (RISK_ORDER.indexOf(String(manifest.risk || 'passive')) >= RISK_ORDER.indexOf('active')) await throttleQps()

      let argv
      try { argv = shellSplit(renderTemplate(String(manifest.args_template || ''), params, runDir, runId)) } catch (e) { throwErr('E_EXEC_TEMPLATE_PARAM', `参数渲染失败: ${e.message}`, '检查必填参数') }
      if (String(manifest.risk || 'passive') === 'passive') {
        const allowList = (firstChk.programCfg && firstChk.programCfg.rules && Array.isArray(firstChk.programCfg.rules.allow_intrusive_tools) ? firstChk.programCfg.rules.allow_intrusive_tools : []).map((s) => String(s).toLowerCase())
        const hit = allowList.includes(toolName.toLowerCase()) ? null : findWriteVerbHit(argv.join(' '))
        if (hit) {
          let approvalHint = null
          if (programId) {
            const add = await fileApproval(ctx.dispatch, 'tool-intrusive', `${toolName}:${targets[0] || hostOf(hit.url) || '-'}`, { tool: toolName, risk: manifest.risk, target: targets[0] || null, params: sanitizeParamsForApproval(params), program: programId, guard: 'S5-write-verb', verb: hit.verb, url: hit.url }, `只读工具（risk=passive）${toolName} 命令含写动词路径 ${hit.url}（${hit.verb}）`, 'model', sessionId)
            if (add && add.ok) approvalHint = `已自动提请 tool-intrusive 审批（S5 与风险闸同源放行，重试即通过）。本次维持拒绝，勿重试。`
          }
          throwErr('E_EXEC_WRITE_VERB', `S5 写动词守卫拒绝: 只读工具命令 URL ${hit.url} 的路径含写动词 "${hit.verb}"`, approvalHint || '确属写操作改用 active/intrusive 工具并走审批', false)
        }
      }

      const binary = String(manifest.binary || toolName)
      const timeoutMs = Math.min(Number(manifest.timeout || 300), 3600) * 1000
      const env = { ...process.env }
      const allInternal = targets.length > 0 && targets.every((t) => isInternalHost(hostOf(t)))
      if (manifest.env_proxy && egressProxy && !allInternal) { env.http_proxy = egressProxy; env.https_proxy = egressProxy; env.HTTP_PROXY = egressProxy; env.HTTPS_PROXY = egressProxy }

      const started = Date.now()
      const sandbox = (manifest.target_param && manifest.sandbox !== false) ? buildSandboxCommand(binary, argv, runDir) : null
      const spawnCmd = sandbox ? sandbox.cmd : binary
      const spawnArgs = sandbox ? sandbox.args : argv
      const events = [{ name: 'exec.run.started', payload: { run_id: runId, tool: toolName, stage: manifest.stage || null, risk: manifest.risk || 'passive', targets: targets.slice(0, 10), program_id: programId } }]
      const result = await new Promise((resolve) => {
        let child
        try { child = spawn(spawnCmd, spawnArgs, { env, cwd: runDir, stdio: ['ignore', 'pipe', 'pipe'] }) } catch (e) { resolve({ error: `启动失败: ${e.message}`, code: null }); return }
        const out = fs.createWriteStream(path.join(runDir, 'stdout.log'))
        child.stdout.pipe(out)
        const errBuf = []
        child.stderr.on('data', (d) => { errBuf.push(d); if (Buffer.concat(errBuf).length > 65536) errBuf.splice(0, errBuf.length - 1) })
        const killer = setTimeout(() => { child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 5000).unref() }, timeoutMs)
        let settled = false
        let childDone = false
        let streamDone = false
        const finalize = (payload) => { if (settled) return; settled = true; clearTimeout(killer); resolve(payload) }
        out.on('finish', () => { streamDone = true; if (childDone) finalize({ code: childExitCode, signal: childSignal }) })
        let childExitCode = null
        let childSignal = null
        child.on('error', (e) => { childDone = true; finalize({ error: String(e.message), code: null }) })
        child.on('close', (code, signal) => { childExitCode = code; childSignal = signal; childDone = true; if (streamDone) finalize({ code, signal }) })
      })
      const meta = { run_id: runId, tool: toolName, argv: [binary, ...argv], params, started_at: new Date(started).toISOString(), duration_ms: Date.now() - started, exit_code: result.code ?? null, signal: result.signal || null, error: result.error || null, risk: manifest.risk || 'passive', stage: manifest.stage || null, sandboxed: !!sandbox, session_id: sessionId, program_id: programId }
      repo.writeCmd(runDir, (sandbox ? '[sandbox] ' : '') + [binary, ...argv].join(' ') + '\n')
      repo.writeMeta(runDir, meta)

      // 后处理 ① know pb_outcome（弱联动）
      try { await ctx.dispatch('know', 'pb_outcome', { name: `tool:${toolName}`, success: result.code === 0, duration_ms: meta.duration_ms }, { actor: 'script', session_id: sessionId }) } catch { /* 弱联动 */ }

      if (programId && result.code !== 0) {
        const why = result.error ? `启动失败: ${result.error}` : result.signal ? `超时/被杀 ${result.signal}` : `exit ${result.code}`
        events.push({ name: 'exec.run.failed', payload: { run_id: runId, tool: toolName, host: targets[0] || 'unknown', exit_code: result.code ?? null, error: result.error || null, program_id: programId, cause: why, duration_ms: meta.duration_ms } })
      }

      let stdoutText = ''
      try { stdoutText = repo.readFile(path.join(runDir, 'stdout.log')) || '' } catch { /* 无输出 */ }
      // parser proposal（store 语义废止：只写 proposal.json + 事件，不落库）
      const proposal = (manifest.parser && result.code === 0 && stdoutText) ? runParser(manifest, toolName, runId, stdoutText, programId) : null
      if (proposal) repo.writeProposal(runDir, proposal)
      if (proposal) {
        if (proposal.counts.assets > 0 || proposal.counts.fingerprints > 0) {
          events.push({ name: 'exec.run.completed', payload: { run_id: runId, tool: toolName, stage: manifest.stage || null, risk: manifest.risk || 'passive', exit_code: result.code ?? null, duration_ms: meta.duration_ms, sandboxed: !!sandbox, program_id: programId, parse_proposal: { kind: 'assets', assets: proposal.assets, fingerprints: proposal.fingerprints, state_signals: [], findings: proposal.findings, parser: proposal.parser } } })
        }
        if (proposal.counts.endpoints > 0) {
          events.push({ name: 'exec.run.completed', payload: { run_id: runId, tool: toolName, stage: manifest.stage || null, risk: manifest.risk || 'passive', exit_code: result.code ?? null, duration_ms: meta.duration_ms, sandboxed: !!sandbox, program_id: programId, parse_proposal: { kind: 'endpoints', tsv_path: null, endpoints: proposal.endpoints, findings: proposal.findings, parser: proposal.parser } } })
        }
        if (proposal.counts.findings > 0) {
          events.push({ name: 'exec.run.completed', payload: { run_id: runId, tool: toolName, stage: manifest.stage || null, risk: manifest.risk || 'passive', exit_code: result.code ?? null, duration_ms: meta.duration_ms, sandboxed: !!sandbox, program_id: programId, parse_proposal: { kind: 'findings', findings: proposal.findings, parser: proposal.parser } } })
        }
      }

      const lines = stdoutText.split('\n')
      const head = lines.slice(0, 20).join('\n')
      const data = {
        run_id: runId, exit_code: result.code ?? null, signal: result.signal || null, error: result.error || null,
        duration_ms: meta.duration_ms, total_lines: lines.length, summary: head, sandboxed: !!sandbox, program_id: programId,
        parse_counts: proposal ? proposal.counts : null,
      }
      if (lines.length > 20) data.hint = `输出共 ${lines.length} 行，仅显示前 20 行；用 exec_grep_result/exec_page_result 按需取`
      return { data, events, after: { run_id: runId, exit_code: result.code ?? null } }
    },

    exec_spawn_worker: async (args, repo, ctx) => {
      const task = String(args.task || '').trim()
      if (!task) throwErr('E_SCHEMA', 'task 不能为空', '目标/范围/产出要求必须写全')
      const dedupeKey = args.force === true ? null : crypto.createHash('sha1').update(task + '\0').digest('hex')
      // 幂等预检（task 域查询 task_worker_recent）
      if (dedupeKey && queryRef) {
        try {
          const prev = await queryRef('task', 'worker_recent', { dedupe_key: dedupeKey, window_ms: 30 * 60 * 1000 }, { actor: 'system' })
          const row = prev && prev.ok ? prev.data : null
          if (row) {
            if (row.status === 'running' && pidAlive(row.pid)) return { data: { ok: false, in_progress: true, run_id: row.run_id, status: 'running', hint: '同任务 worker 正在跑，用 task_worker_status 查进度；强制重跑传 force:true' } }
            if (row.status === 'done' || row.status === 'failed') {
              const recovered = readWorkerResult(repo, row)
              if (recovered) return { data: recovered, events: [] }
              return { data: { ok: row.status === 'done', run_id: row.run_id, exit_code: row.exit_code ?? null, recovered: true, status: row.status, tail: '' }, events: [] }
            }
          }
        } catch { /* 查询失败不阻断 */ }
      }
      if (activeWorkers >= MAX_WORKERS) throwErr('E_EXEC_WORKER_BUSY', `worker 并发上限 ${MAX_WORKERS}`, '稍后重试（busy 时调度器回 queued）', true)
      const timeoutMs = Math.min(Number(args.timeout) || 900, 7200) * 1000
      const { runId, runDir } = repo.createRunDir('w')
      const workCwd = runDir
      const fullTask = task.includes(ROE_ANCHOR) ? task : `${task}\n\n${ROE_BLOCK}`

      const dshArgs = [DSH_BIN, '--profile', 'headless']
      if (args.provider && args.model) {
        const patchPath = path.join(runDir, 'model-patch.yml')
        fs.writeFileSync(patchPath, `- id: agent-default-model\n  config:\n    provider: ${String(args.provider)}\n    model: ${String(args.model)}\n`)
        dshArgs.push('--patch', patchPath)
      }
      dshArgs.push(fullTask)
      const env = { ...process.env, DSH_HOME: dataDir, PATH: '/usr/local/node/bin:' + (process.env.PATH || '') }
      if (args.phase) env.SEC_WORKER_PHASE = String(args.phase)

      activeWorkers++
      const started = Date.now()
      const originSessionId = ctx.session_id || null
      let childPid = 0
      const result = await new Promise((resolve) => {
        let child
        try { child = spawn(NODE_BIN, dshArgs, { env, cwd: workCwd, detached: true }) } catch (e) { resolve({ code: null, error: String(e.message) }); return }
        childPid = child.pid || 0
        const out = fs.createWriteStream(path.join(runDir, 'worker.log'))
        child.stdout.pipe(out)
        child.stderr.pipe(out)
        const killGroup = (sig) => { try { process.kill(-child.pid, sig) } catch { /* 进程组已退 */ } }
        const killer = setTimeout(() => { killGroup('SIGTERM'); setTimeout(() => killGroup('SIGKILL'), 5000).unref() }, timeoutMs)
        let settled = false
        let childDone = false
        let streamDone = false
        let childExitCode = null
        let childSignal = null
        const finalize = (payload) => { if (settled) return; settled = true; clearTimeout(killer); resolve(payload) }
        out.on('finish', () => { streamDone = true; if (childDone) finalize({ code: childExitCode, signal: childSignal }) })
        child.on('error', (e) => { childDone = true; finalize({ code: null, error: String(e.message) }) })
        child.on('close', (code, signal) => { childExitCode = code; childSignal = signal; childDone = true; if (streamDone) finalize({ code, signal }) })
      })
      activeWorkers--
      const meta = { run_id: runId, tool: 'spawn_worker', task: fullTask, cwd: workCwd, started_at: new Date(started).toISOString(), duration_ms: Date.now() - started, exit_code: result.code ?? null, session_id: originSessionId }
      repo.writeMeta(runDir, meta)
      const finalStatus = result.code === 0 ? 'done' : (result.code == null && result.signal ? 'killed' : 'failed')
      let logText = ''
      try { logText = repo.readFile(path.join(runDir, 'worker.log')) || '' } catch { /* 无输出 */ }
      const lines = logText.split('\n').filter(Boolean)

      // 真实性校验（拒执标记扫描）
      const truth = { checked: true, rejected: false, reason: '' }
      const rejectMarks = ["I won't produce", 'I will not produce', 'I cannot continue', 'refuse to continue', 'unverifiable authorization', '授权不可验证', '拒绝执行', '停止执行', 'INVALID_REQUEST', 'reasoning_content must be passed back']
      const tailLog = logText.slice(-4000)
      for (const mark of rejectMarks) { if (tailLog.includes(mark)) { truth.rejected = true; truth.reason = `worker.log 命中拒执/错误标记: ${mark}`; break } }

      const events = [
        { name: 'exec.worker.spawned', payload: { run_id: runId, dedupe_key: dedupeKey, cwd: workCwd, run_dir: runDir, timeout_sec: Math.round(timeoutMs / 1000), pid: childPid, origin_session_id: originSessionId } },
        { name: 'exec.worker.finished', payload: { run_id: runId, status: finalStatus, exit_code: result.code ?? null, duration_ms: meta.duration_ms } },
      ]
      return {
        data: { ok: result.code === 0, run_id: runId, exit_code: result.code ?? null, duration_ms: meta.duration_ms, log_lines: lines.length, tail: lines.slice(-20).join('\n'), truth, session_id: originSessionId },
        events,
        after: { run_id: runId, status: finalStatus },
      }
    },

    exec_burp_import: async (args, repo) => {
      const file = String(args.file || '')
      if (!file || !fs.existsSync(file)) throwErr('E_EXEC_FILE_NOT_FOUND', `文件不存在: ${file}`, '本机绝对路径')
      const text = fs.readFileSync(file, 'utf8')
      const importId = 'burp-' + Date.now().toString(36)
      const isIssues = /<issues>/.test(text)
      const blocks = text.match(/<(item|issue)>[\s\S]*?<\/\1>/g) || []
      const hosts = new Set()
      let count = 0
      const xmlTag = (block, tag) => { const m = block.match(new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${tag}>`)); return m ? m[1].trim() : '' }
      for (const b of blocks) {
        let rec
        if (isIssues) { const host = hostOf(xmlTag(b, 'host')); rec = { type: 'issue', name: xmlTag(b, 'name'), host, path: xmlTag(b, 'path'), severity: xmlTag(b, 'severity'), confidence: xmlTag(b, 'confidence') }; if (host) hosts.add(host) }
        else { const url = xmlTag(b, 'url'); const host = hostOf(xmlTag(b, 'host') || url); rec = { type: 'item', host, url, method: xmlTag(b, 'method'), status: xmlTag(b, 'status'), mimetype: xmlTag(b, 'mimetype') }; if (host) hosts.add(host) }
        repo.appendImport(importId, JSON.stringify(rec))
        count++
      }
      return {
        data: { ok: true, import_id: importId, kind: isIssues ? 'scanner issues' : 'proxy history', records: count, hosts: [...hosts].slice(0, 20) },
        events: [{ name: 'exec.import.completed', payload: { import_id: importId, kind: isIssues ? 'issues' : 'items', records: count, hosts: [...hosts].slice(0, 20) } }],
        after: { import_id: importId, records: count },
      }
    },

    exec_report_bad_proxy: async (args, repo, ctx) => {
      if (!ctx.dispatch) throwErr('E_BACKEND_UNAVAILABLE', 'proxy 域不可达', '确认 proxy 域已注册', true)
      const r = await ctx.dispatch('proxy', 'report_bad', { proxy_url: args.proxy_url, evidence: args.evidence || '', run_id: args.run_id || '' }, { actor: ctx.actor })
      if (r && r.ok) return { data: r.data }
      throwErr('E_BACKEND_UNAVAILABLE', 'proxy 域不可达', r?.error?.hint || '确认 proxy 域已注册', true)
    },

    exec_intel_hunt: async (args, repo, ctx) => {
      const tech = String(args.tech || '').toLowerCase().trim()
      if (!tech) throwErr('E_SCHEMA', 'tech 必填', '如 weblogic / ruoyi / spring')
      const version = String(args.version || '').trim()
      const templatesRoot = path.join(HOME_DIR, 'nuclei-templates')
      if (!fs.existsSync(templatesRoot)) throwErr('E_EXEC_FILE_NOT_FOUND', `nuclei 模板库不存在: ${templatesRoot}`, '运行 intel-refresh 补充模板库')
      const matches = []
      const walk = (dir, depth) => {
        if (depth > 3 || matches.length >= 30) return
        let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
        for (const e of entries) {
          if (matches.length >= 30) return
          const p = path.join(dir, e.name)
          if (e.isDirectory()) { if (e.name.toLowerCase().includes(tech)) { try { matches.push(...fs.readdirSync(p).filter((f) => f.endsWith('.yaml')).map((f) => path.join(p, f)).slice(0, 30)) } catch { /* skip */ } } else walk(p, depth + 1) }
          else if (e.name.toLowerCase().includes(tech) && e.name.endsWith('.yaml')) matches.push(p)
        }
      }
      walk(templatesRoot, 0)
      const rel = matches.slice(0, 30).map((m) => path.relative(templatesRoot, m))
      if (!rel.length) return { data: { ok: true, tech, version, templates: [], task_id: null, hint: `模板库无 ${tech} 相关模板` } }
      const programId = args.program_id || ''
      const host = String(args.host || '').trim()
      const label = `[N-day ${tech}${version ? '@' + version : ''}]`
      let task = null
      if (programId && args.create_task !== false && ctx.dispatch) {
        try {
          const list = await ctx.dispatch('task', 'list', { program_id: programId, q: label, bucket: 'active', limit: 50 }, { actor: 'system' })
          const dup = (list && list.ok && Array.isArray(list.rows) ? list.rows : []).find((t) => ['queued', 'running', 'blocked'].includes(t.status))
          if (dup) task = { id: dup.id, deduped: true }
          else {
            const objective = `${label} 验证 ${tech}${version ? ' ' + version : ''} N-day 漏洞${host ? `（目标 ${host}）` : ''}：命中 ${rel.length} 个 nuclei 模板，逐一验证。结果强制 tentative——附 PoC/响应证据方可 confirmed。`
            const r = await ctx.dispatch('task', 'create', { program_id: programId, phase: 'vuln', objective, priority: 1 }, { actor: 'system', session_id: ctx.session_id || null })
            if (r && r.ok) task = { id: r.data.task_id, deduped: false }
          }
        } catch { /* 建任务失败不阻断检索 */ }
      }
      return { data: { ok: true, tech, version, templates: rel, task_id: task ? task.id : null, deduped: task ? task.deduped : false } }
    },

    exec_flow_append: async (args, repo) => {
      const payload = args.payload || {}
      const date = repo.beijingDate()
      const flowFile = repo.appendFlow(date, JSON.stringify(payload))
      const host = payload.host || (payload.target && hostOf(payload.target)) || ''
      return {
        data: { flow_file: flowFile, host, ok: true },
        events: [{ name: 'exec.flow.appended', payload: { flow_file: flowFile, host, title: payload.title || '' } }],
        after: { flow_file: flowFile },
      }
    },
  }

  const queries = {
    exec_grep_result: async (args, repo) => {
      const dir = repo.runDirOf(args.run_id)
      if (!dir) throwErr('E_NOT_FOUND', `run_id 不存在: ${args.run_id}`, '核对 run_id')
      let re
      try { re = new RegExp(String(args.pattern), 'i') } catch (e) { throwErr('E_SCHEMA', `正则无效: ${e.message}`, '修正正则') }
      const max = Math.min(Number(args.max) || 50, 200)
      const matched = []
      const files = repo.readRunDirTree(args.run_id)
      for (const f of files) {
        const text = repo.readFile(f)
        if (text === null) continue
        const lines = text.split('\n')
        const rel = path.relative(dir, f)
        for (let i = 0; i < lines.length && matched.length < max; i++) if (re.test(lines[i])) matched.push(`${rel}:${i + 1}: ${lines[i].slice(0, 500)}`)
        if (matched.length >= max) break
      }
      return { files_searched: files.length, matched: matched.length, lines: matched }
    },
    exec_page_result: async (args, repo) => {
      const dir = repo.runDirOf(args.run_id)
      if (!dir) throwErr('E_NOT_FOUND', `run_id 不存在: ${args.run_id}`, '核对 run_id')
      const f = path.join(dir, 'stdout.log')
      const text = repo.readFile(f)
      if (text === null) throwErr('E_NOT_FOUND', `run_id 无输出: ${args.run_id}`, '核对 run_id')
      const offset = Math.max(0, Number(args.offset) || 0)
      const limit = Math.min(Number(args.limit) || 50, 200)
      const lines = text.split('\n')
      return { total_lines: lines.length, offset, limit, lines: lines.slice(offset, offset + limit) }
    },
    exec_plan_chain: async (args, repo) => {
      const have = Array.isArray(args.have) ? args.have.map(String) : []
      const want = String(args.want || '').trim()
      if (!want) throwErr('E_SCHEMA', 'want 不能为空', '如 findings / live_hosts / subdomains')
      const manifests = {}
      for (const nm of repo.listManifests()) { const m = repo.loadManifest(nm); if (m && Array.isArray(m.requires) && Array.isArray(m.produces)) manifests[nm] = m }
      const available = new Set(have)
      const chain = []
      const used = new Set()
      let progress = true
      while (!available.has(want) && progress) {
        progress = false
        for (const [name, m] of Object.entries(manifests)) {
          if (used.has(name)) continue
          if (m.requires.every((r) => available.has(r))) { for (const p of m.produces) available.add(p); chain.push(name); used.add(name); progress = true; break }
        }
      }
      if (!available.has(want)) throwErr('E_EXEC_CHAIN_UNREACHABLE', `无法凑链到 ${want}（缺前置能力）`, `可用能力: ${[...available].join(', ')}`)
      return { have, want, chain, available: [...available] }
    },
    exec_manifest_list: async (args, repo) => {
      const rows = []
      for (const nm of repo.listManifests()) {
        const m = repo.loadManifest(nm)
        if (!m) continue
        if (args.stage && m.stage !== args.stage) continue
        if (args.risk && m.risk !== args.risk) continue
        if (args.domain && m.domain !== args.domain) continue
        rows.push({ name: nm, stage: m.stage || null, risk: m.risk || null, target_param: m.target_param || null, requires: m.requires || [], produces: m.produces || [], parser: m.parser || null, domain: m.domain || null, sandbox: m.sandbox !== false, deprecated_store: m.store || null })
      }
      return { rows, total: rows.length }
    },
  }

  const subscribers = {}

  return { ...commands, queries, invariants, subscribers }
}

function readWorkerResult(repo, row) {
  if (!row || !row.run_dir) return null
  let logText = ''
  try { logText = fs.readFileSync(path.join(row.run_dir, 'worker.log'), 'utf8') } catch { return null }
  const lines = logText.split('\n').filter(Boolean)
  return { ok: row.status === 'done', run_id: row.run_id, exit_code: row.exit_code ?? null, recovered: true, status: row.status, log_lines: lines.length, tail: lines.slice(-20).join('\n'), hint: '恢复自既有 run（未重跑）；强制重跑传 force:true' }
}

// ---------------------------------------------------------------------------
// 组装
// ---------------------------------------------------------------------------

export function buildExecDomain(opts = {}) {
  const dataDir = opts.dataDir || DEFAULT_DATA_DIR
  const backend = createExecFileBackend({ dataDir })
  return {
    manifest: EXEC_MANIFEST,
    handlers: makeHandlers({ ...opts, dataDir }),
    backend,
  }
}

export function apply(ctx, config = {}) {
  const dataDir = process.env.SEC_DATA_DIR || process.env.DSH_HOME || DEFAULT_DATA_DIR
  try {
    ctx.inject(['secDomainBus'], (child) => {
      const bus = child.secDomainBus
      const domain = buildExecDomain({
        dataDir,
        dispatch: (d, v, a, c) => bus.dispatch(d, v, a, c),
        query: (d, n, a, c) => bus.query(d, n, a, c),
      })
      const res = bus.registry.register(domain)
      if (res.ok) log(`exec 域注册成功（registered=${res.registered}）`)
      else log(`exec 域注册被拒：${res.error?.code} ${res.error?.message}`)
      return () => {}
    })
  } catch (e) {
    log(`secDomainBus 注入失败：${e?.message}——exec 域未注册（总线必须先行挂载）`)
  }
  return null
}
