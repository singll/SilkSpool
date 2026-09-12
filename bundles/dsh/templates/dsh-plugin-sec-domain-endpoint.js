// ==============================================================================
// @silksec/sec-domain-endpoint — SilkSecAgent endpoint 域插件（v5 Phase 2 首域）
//
// 契约：doc/secagent/v5/04-endpoint.md（域设计，权威）+ 01-bus.md（总线）+ 00-conventions.md（宪法）
//
// 对外（cordis）：name='sec-domain-endpoint'，apply() 把 manifest+handlers+backend 交给
// 总线 registry.register()（不 provide 任何业务方法）。
//
// 语义要点：
//  - 动词 endpoint_upsert（含 l2-collect TSV 批量入库）/ endpoint_queue_surface /
//    endpoint_consume_queue / endpoint_mark_auth 拆自 v4 asset-db.js upsertEndpoint +
//    sec-pipeline.js toolSurfaceQueue；
//  - 鉴权列（auth_required/roles_seen）只经 endpoint_mark_auth——结构性闸门（INV-1），
//    endpoint_upsert schema 不含（TSV 的 auth_required 列读入即弃）；
//  - 队列消费语义显式化：consume 把已喂 URL 出队，seen 保留防重回（INV-2）；
//  - 文件安全：param-queue/param-seen 域 owned，tmp+rename 原子写（沙箱不可写）；
//  - scope 校验（INV-3）与 asset 域同口径（scope.yml 自查，scope 域查询上线前过渡）；
//  - 订阅 exec.run.completed（l2-collect/katana proposal 回灌，async 弱联动）。
//
// 零依赖：node:fs / node:path / node:crypto（sqlite 在总线）
// ==============================================================================

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

export const name = 'sec-domain-endpoint'
export const version = '1.0.0'

const DEFAULT_DATA_DIR = process.env.SEC_DATA_DIR || '/opt/silkspool/dsh/data'

const log = (msg) => { try { process.stderr.write(`[sec-domain-endpoint] ${msg}\n`) } catch { /* noop */ } }
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex')

const backendUrl = new URL('../sec-backend-endpoint-sqlite/index.js', import.meta.url)
const { createEndpointBackend } = await import(backendUrl.href)

// ---------------------------------------------------------------------------
// manifest（04-endpoint §1.2/§1.4/§1.5 的机器形态）
// ---------------------------------------------------------------------------

const schema = (properties, required, extra = {}) => ({
  type: 'object', properties, required, additionalProperties: false, ...extra,
})
const str = (opts = {}) => ({ type: 'string', ...opts })
const en = (values, extra = {}) => ({ type: 'string', enum: values, ...extra })
const int = (opts = {}) => ({ type: 'integer', ...opts })

const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']
const AUTH = ['yes', 'no', 'unknown']
const SCANNERS = ['dalfox', 'sqlmap', 'arjun', 'other']

const EP_ROW_SCHEMA = schema({
  url: str(),
  host: str(),
  path: str(),
  method: en(METHODS, { default: 'GET' }),
  status: str({ default: '' }),
  params: { type: 'object' },
  source: str({ default: '' }),
  program_id: str(),
}, [])

export const ENDPOINT_MANIFEST = {
  domain: 'endpoint',
  version: 1,
  service: 'secDomain.endpoint',
  description: '接口面/参数队列（打哪里、喂什么料——越权矩阵与参数喂料的唯一事实源）',
  owns: {
    tables: ['endpoints'],
    files: ['data/pipeline/*/param-queue.txt', 'data/pipeline/*/param-seen.txt', 'data/events/endpoint.jsonl'],
  },
  commands: {
    endpoint_upsert: {
      actor: ['model', 'script', 'dashboard'],
      schema: schema({
        rows: { type: 'array', items: EP_ROW_SCHEMA },
        tsv_path: str(),
        program_id: str(),
      }, []),
      idempotent: 'auto',
      idempotent_fields: ['rows', 'tsv_path', 'program_id'],
      events: ['endpoint.registered'],
      event_limit: 5000,
      invariants: ['upsertMode', 'batchLimit'],
      timeout_ms: 120000,
      agent_note: '登记接口端点（host+method+path 主键去重）。l2-collect 产出的 TSV 传 tsv_path 批量入库（≤5000 行）；小批量传 rows（≤500）。鉴权标注（auth_required/roles_seen）走 endpoint_mark_auth，本动词不收。静态资源 URL 自动跳过。',
      deprecated: false,
    },
    endpoint_queue_surface: {
      actor: ['model', 'script'],
      schema: schema({
        program: str({ minLength: 1 }),
        source: str({ minLength: 1 }),
      }, ['program', 'source']),
      idempotent: 'auto',
      idempotent_fields: ['program', 'source'],
      events: ['endpoint.queue.enqueued'],
      event_limit: 1,
      invariants: ['queueSourceExists'],
      timeout_ms: 60000,
      agent_note: '参数面入队：从 endpoints TSV 或任意文本提取带参数 URL，全局去重后入 param-queue（dalfox/sqlmap 喂料队列，按项目分文件）。重复 URL 被 seen 集合自动拦截（幂等）。喂完扫描器后用 endpoint_consume_queue 标记消化。',
      deprecated: false,
    },
    endpoint_consume_queue: {
      actor: ['model', 'script'],
      schema: schema({
        program: str({ minLength: 1 }),
        mode: en(['all', 'urls'], { default: 'all' }),
        urls: { type: 'array', items: str() },
        scanner: en(SCANNERS),
        run_id: str({ minLength: 1 }),
      }, ['program', 'scanner', 'run_id']),
      idempotent: 'natural',
      idempotent_natural: ['program', 'run_id'],
      events: ['endpoint.queue.consumed'],
      event_limit: 1,
      invariants: ['consumeEvidence'],
      timeout_ms: 60000,
      agent_note: '标记参数队列已消化：扫描器（dalfox/sqlmap/arjun）取料跑完后调用，把已喂 URL 从 param-queue 移除（seen 保留防重回）。必带 scanner 与 run_id 证据。',
      deprecated: false,
    },
    endpoint_mark_auth: {
      actor: ['model', 'script', 'dashboard'],
      schema: schema({
        host: str({ minLength: 1 }),
        method: str({ default: 'GET' }),
        path: str({ minLength: 1 }),
        auth_required: en(AUTH),
        roles_seen: { type: 'array', items: str() },
        evidence: str(),
        note: str(),
      }, ['host', 'path']),
      idempotent: 'auto',
      idempotent_fields: ['host', 'method', 'path', 'auth_required', 'roles_seen', 'evidence'],
      events: ['endpoint.auth_marked'],
      event_limit: 1,
      invariants: ['endpointExists', 'authEvidence'],
      timeout_ms: 60000,
      agent_note: '标注接口鉴权（auth_required: yes/no/unknown）与访问角色（roles_seen 并集累积）——越权矩阵的数据源。auth_required 从 unknown 变为确定值必须带证据（run_id/flow_id）。biz-logic 任务梳理接口图谱后应批量回填，多角色命中的接口是越权测试优先面（endpoint_matrix 查询）。',
      deprecated: false,
    },
  },
  queries: {
    endpoint_list: {
      actor: ['model', 'dashboard', 'human'],
      params: schema({
        host: str({ default: '' }),
        path_like: str({ default: '' }),
        method: str({ default: '' }),
        program_id: str({ default: '' }),
        auth_required: en([...AUTH, 'none', ''], { default: '' }),
        sort: en(['last_seen', 'host', 'status', 'path', ''], { default: '' }),
        dir: en(['asc', 'desc', ''], { default: '' }),
        limit: int({ minimum: 1, maximum: 500 }),
        offset: int({ minimum: 0 }),
      }, []),
      predicates: ['program', 'auth'],
      agent_note: '检索接口端点：host 精确 + path_like 模糊 + method/program/auth_required 过滤（auth=\'none\' 筛未标注）。',
    },
    endpoint_hosts: {
      actor: ['model', 'dashboard', 'human'],
      params: schema({
        path_like: str({ default: '' }),
        program_id: str({ default: '' }),
        limit: int({ minimum: 1, maximum: 500 }),
        offset: int({ minimum: 0 }),
      }, []),
      predicates: ['program'],
      agent_note: '接口按主机分组（路径搜索命中后聚合，看板主视图口径）。',
    },
    endpoint_matrix: {
      actor: ['model', 'dashboard', 'human'],
      params: schema({
        program_id: str({ default: '' }),
        host: str({ default: '' }),
        min_roles: int({ minimum: 0, default: 2 }),
      }, []),
      predicates: ['program'],
      agent_note: '越权矩阵聚合：每主机的鉴权分布（yes/no/unknown）+ 角色并集 + 多角色端点数。no_auth 与多角色并存的主机是越权/未授权访问优先面。',
    },
    queue_status: {
      actor: ['model', 'dashboard', 'human'],
      params: schema({ program: str({ default: '' }) }, []),
      predicates: [],
      agent_note: '参数队列现状：各项目 queue/seen 行数、最近入队/消化时间（last_consumed_at=null 即从未消化——纪律红灯）。',
    },
    endpoint_surface_scan: {
      actor: ['model', 'dashboard', 'human'],
      params: schema({
        program: str({ minLength: 1 }),
        q: str({ default: '' }),
      }, ['program']),
      predicates: [],
      agent_note: '敏感参数/路径回扫（v4 toolSurfaceScan 收编）：扫描 endpoints 表与 param-queue 命中敏感关键词的 URL/参数，脱敏检查用途，不回写。',
    },
  },
  events: {
    'endpoint.registered': { payload: { type: 'object' }, redact: [] },
    'endpoint.queue.enqueued': { payload: { type: 'object' }, redact: [] },
    'endpoint.queue.consumed': { payload: { type: 'object' }, redact: [] },
    'endpoint.auth_marked': { payload: { type: 'object' }, redact: [] },
  },
  subscribes: {
    'exec.run.completed': { handler: 'onRunProposal', mode: 'async', as: 'reactor' },
  },
  backend: 'repository-v1',
}

// ---------------------------------------------------------------------------
// 域名工具（主机归一 / URL 拆解 / scope 自查 / 静态资源过滤）
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

// pathOfUrl：pathname + search（04-endpoint §2.1 path 含 query 语义）
function pathOfUrl(urlStr) {
  try {
    const u = new URL(String(urlStr))
    return u.pathname + u.search
  } catch { return '/' }
}

const STATIC_RE = /\.(js|css|png|jpe?g|gif|svg|ico|woff2?|ttf|map|mp4|webp)([?#].*)?$/i

function isStaticUrl(urlStr) {
  try {
    const u = new URL(String(urlStr))
    return STATIC_RE.test(u.pathname)
  } catch { return false }
}

// scope.yml 自查（与 asset 域同口径，模块级 mtime 缓存）
let _scopeCache = null
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

function scopeCheckResult(programId, host, dataDir) {
  if (!programId) return { ok: true }
  const programs = loadScopePrograms(dataDir)
  const prog = programs.find((p) => p.name === programId)
  if (!prog) { log(`scope 自查：program ${programId} 未找到，fail-open（scope 域查询上线前过渡）`); return { ok: true } }
  if (hostInPatterns(host, prog.exclude || [])) return { ok: false, code: 'E_INVARIANT', message: `接口 ${host} 命中项目 ${programId} 排除清单`, hint: '该域在项目排除清单内，需单独授权', retryable: false }
  if (!hostInPatterns(host, prog.scope || [])) return { ok: false, code: 'E_INVARIANT', message: `接口 ${host} 不在项目 ${programId} 授权范围内`, hint: '域外参考请不带 program_id，或先经审批扩 scope', retryable: false }
  return { ok: true }
}

// ---------------------------------------------------------------------------
// handlers
// ---------------------------------------------------------------------------

function makeHandlers(opts) {
  const dataDir = opts.dataDir || DEFAULT_DATA_DIR
  const dispatchRef = opts.dispatch

  function throwErr(code, message, hint, retryable = false) {
    throw Object.assign(new Error(message), { code, hint, retryable })
  }

  const invariants = {
    upsertMode: async (args) => {
      const hasRows = Array.isArray(args.rows)
      const hasTsv = !!args.tsv_path
      if (hasRows && hasTsv) return { code: 'E_SCHEMA', message: 'rows 与 tsv_path 互斥', hint: '内联批量 rows 或文件 tsv_path 二选一', retryable: false }
      if (!hasRows && !hasTsv) return { code: 'E_SCHEMA', message: '缺少 rows 或 tsv_path', hint: '内联批量上限 500 行；更大批量走 tsv_path（上限 5,000）', retryable: false }
      return null
    },
    batchLimit: async (args) => {
      if (Array.isArray(args.rows) && (args.rows.length === 0 || args.rows.length > 500)) return { code: 'E_SCHEMA', message: `rows 行数 ${args.rows.length} 超上限（1..500）`, hint: '内联批量上限 500 行；更大批量走 tsv_path（上限 5,000）', retryable: false }
      return null
    },
    queueSourceExists: async (args) => {
      const resolved = path.isAbsolute(args.source) ? args.source : path.join(dataDir, args.source)
      if (!fs.existsSync(resolved)) return { code: 'E_NOT_FOUND', message: `source 文件不存在: ${args.source}`, hint: '先跑 l2-collect 产出 endpoints-proposal.tsv 或传入已有文本路径', retryable: false }
      return null
    },
    consumeEvidence: async (args) => {
      if (!String(args.run_id || '').trim()) return { code: 'E_EVIDENCE_REQUIRED', message: 'run_id 必填', hint: '证据即参数：扫描 run 的 run_id（results/<run_id>/ 须存在）', retryable: false }
      if (!fs.existsSync(path.join(dataDir, 'results', String(args.run_id)))) return { code: 'E_EVIDENCE_REQUIRED', message: `run_id 证据目录不存在: ${args.run_id}`, hint: '扫描 run 的 results/<run_id>/ 目录须真实存在', retryable: false }
      return null
    },
    endpointExists: async (args, repo) => {
      const row = repo.getEndpoint(args.host, args.method || 'GET', args.path)
      if (!row) return { code: 'E_NOT_FOUND', message: `接口 ${args.host} ${args.method || 'GET'} ${args.path} 未登记`, hint: '先 endpoint_upsert 登记，再标注鉴权', retryable: false }
      return null
    },
    authEvidence: async (args, repo) => {
      const auth = args.auth_required
      if (auth !== 'yes' && auth !== 'no') return null
      const row = repo.getEndpoint(args.host, args.method || 'GET', args.path)
      const cur = row ? row.auth_required : null
      if ((cur === null || cur === undefined || cur === 'unknown') && !String(args.evidence || '').trim()) {
        return { code: 'E_EVIDENCE_REQUIRED', message: 'auth_required 从 unknown 变为确定值必须带 evidence', hint: '证据即参数：鉴权判定是越权测试的准入结论（run_id/flow_id/burp_item）', retryable: false }
      }
      return null
    },
  }

  function upsertRow(repo, row, program_id, dataDir) {
    // 静态资源过滤 / URL 拆解 / 归一化
    const url = row.url ? String(row.url) : ''
    if (url) {
      if (isStaticUrl(url)) return { skipped: 'static' }
      let host
      let p
      try {
        const u = new URL(url)
        host = normalizeHost(u.host)
        p = u.pathname + u.search
      } catch {
        return { skipped: 'invalid' }
      }
      return doUpsert(repo, { host, path: p, method: row.method || 'GET', status: row.status || '', source: row.source || '', params: row.params ?? null, program_id: row.program_id ?? program_id }, dataDir)
    }
    if (row.host) {
      const host = normalizeHost(row.host)
      const p = String(row.path || '/')
      if (!p.startsWith('/')) return { skipped: 'invalid' }
      return doUpsert(repo, { host, path: p, method: row.method || 'GET', status: row.status || '', source: row.source || '', params: row.params ?? null, program_id: row.program_id ?? program_id }, dataDir)
    }
    return { skipped: 'invalid' }
  }

  function doUpsert(repo, row, dataDir) {
    const sc = scopeCheckResult(row.program_id, row.host, dataDir)
    if (!sc.ok) return { ok: false, error: `${sc.code}: ${sc.message}`, host: row.host, method: row.method, path: row.path, created: false }
    const existing = repo.getEndpoint(row.host, row.method, row.path)
    if (existing) {
      repo.touchEndpoint(row.host, row.method, row.path, { status: row.status, params: row.params, program_id: row.program_id }, Date.now())
      return { ok: true, created: false, host: row.host, method: row.method.toUpperCase(), path: row.path }
    }
    const r = repo.insertEndpoint(row)
    return {
      ok: true, created: r.created, host: row.host, method: row.method.toUpperCase(), path: row.path,
      event: r.created ? { name: 'endpoint.registered', payload: { host: row.host, method: row.method.toUpperCase(), path: row.path, program_id: row.program_id ?? null, source: row.source || '' } } : null,
    }
  }

  const commands = {
    endpoint_upsert: async (args, repo) => {
      const program_id = args.program_id ?? null
      const results = []
      const events = []
      let created = 0
      let touched = 0
      let skippedStatic = 0
      let skippedInvalid = 0

      if (args.tsv_path) {
        const resolved = path.isAbsolute(args.tsv_path) ? args.tsv_path : path.join(dataDir, args.tsv_path)
        let content = ''
        try { content = fs.readFileSync(resolved, 'utf8') } catch { throwErr('E_ENDPOINT_TSV_INVALID', `TSV 文件不存在: ${args.tsv_path}`, '期望表头 url\\tmethod\\tparams\\tauth_required\\tsource\\tcollected_at（l2-collect 产出格式）', false) }
        const lines = content.split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l.trim())
        if (!lines.length) throwErr('E_ENDPOINT_TSV_INVALID', 'TSV 为空', '期望表头 url\\tmethod\\tparams\\tauth_required\\tsource\\tcollected_at', false)
        const header = lines[0].split('\t')
        if (header[0] !== 'url' || header[1] !== 'method' || header[2] !== 'params' || header[3] !== 'auth_required' || header[4] !== 'source' || header[5] !== 'collected_at') {
          throwErr('E_ENDPOINT_TSV_INVALID', `TSV 表头不符: ${header.join(',')}`, '期望表头 url\\tmethod\\tparams\\tauth_required\\tsource\\tcollected_at', false)
        }
        const dataLines = lines.slice(1)
        if (dataLines.length > 5000) throwErr('E_ENDPOINT_BATCH_TOO_LARGE', `TSV 行数 ${dataLines.length} 超上限（≤5,000）`, '分批产出 proposal 或分片重调', false)
        for (const line of dataLines) {
          const cols = line.split('\t')
          const url = cols[0] || ''
          const method = cols[1] || 'GET'
          const paramsRaw = cols[2] || ''
          const source = cols[4] || ''
          // auth_required（cols[3]）读入即弃（登记不带鉴权语义，INV-1）
          let params = null
          if (paramsRaw) { try { params = { _raw: paramsRaw } } catch { params = null } }
          const row = { url, method, params, source }
          const r = upsertRow(repo, row, program_id, dataDir)
          if (r.skipped === 'static') { skippedStatic++; continue }
          if (r.skipped === 'invalid') { skippedInvalid++; continue }
          if (!r.ok) { results.push({ host: r.host, method: r.method, path: r.path, created: false, ok: false, error: r.error }); continue }
          if (r.created) { created++; if (r.event) events.push(r.event) } else touched++
          results.push({ host: r.host, method: r.method, path: r.path, created: r.created, ok: true })
        }
      } else {
        for (const row of args.rows) {
          const r = upsertRow(repo, row, program_id, dataDir)
          if (r.skipped === 'static') { skippedStatic++; continue }
          if (r.skipped === 'invalid') { skippedInvalid++; continue }
          if (!r.ok) { results.push({ host: r.host, method: r.method, path: r.path, created: false, ok: false, error: r.error }); continue }
          if (r.created) { created++; if (r.event) events.push(r.event) } else touched++
          results.push({ host: r.host, method: r.method, path: r.path, created: r.created, ok: true })
        }
      }
      const detail = results.slice(0, 100)
      return {
        data: { created, touched, skipped_static: skippedStatic, skipped_invalid: skippedInvalid, results: detail, total_results: results.length },
        events,
        before: null, after: { created, touched },
      }
    },

    endpoint_queue_surface: async (args, repo) => {
      const program = String(args.program)
      const sourcePath = path.isAbsolute(args.source) ? args.source : path.join(dataDir, args.source)
      if (!fs.existsSync(sourcePath)) throwErr('E_NOT_FOUND', `source 不存在: ${args.source}`, null, false)
      const seen = new Set(repo.readSeen(program))
      const urls = new Set()
      const content = fs.readFileSync(sourcePath, 'utf8')
      if (String(args.source).endsWith('.tsv')) {
        for (const line of content.split('\n').slice(1)) {
          const cols = line.split('\t')
          if (cols[0] && cols[0].startsWith('http') && cols[2]) urls.add(cols[0].trim())
        }
      } else {
        for (const m of content.matchAll(/https?:\/\/[^\s"'<>)]+/g)) {
          try { if (new URL(m[0]).search) urls.add(m[0]) } catch { /* skip */ }
        }
      }
      const fresh = [...urls].filter((u) => !seen.has(u)).sort()
      if (fresh.length) {
        repo.appendSeenAtomic(program, fresh)
        repo.appendQueueAtomic(program, fresh)
      }
      const stat = repo.queueStat(program)
      const paths = repo.queuePaths(program)
      return {
        data: { program, new_urls: fresh.length, pool: stat.seen_lines, queue: paths.queue, hint: `dalfox file ${paths.queue} / sqlmap -m ${paths.queue} --batch --level 1 --risk 1` },
        events: fresh.length ? [{ name: 'endpoint.queue.enqueued', payload: { program, new_urls: fresh.length, pool: stat.seen_lines, source: args.source } }] : [],
        before: null, after: { new_urls: fresh.length },
      }
    },

    endpoint_consume_queue: async (args, repo) => {
      const program = String(args.program)
      const queue = repo.readQueue(program)
      let consumed = 0
      let notInQueue = 0
      let remaining = []
      if (args.mode === 'urls' && Array.isArray(args.urls)) {
        const consumeSet = new Set(args.urls.map(String))
        for (const u of queue) {
          if (consumeSet.has(u)) { consumed++ } else { remaining.push(u) }
        }
        notInQueue = consumeSet.size - consumed
        repo.rewriteQueueAtomic(program, remaining)
      } else {
        // mode all
        if (queue.length === 0) {
          return { data: { program, consumed: 0, remaining: 0, scanner: args.scanner, run_id: args.run_id, empty: true }, events: [] }
        }
        consumed = queue.length
        repo.rewriteQueueAtomic(program, [])
        remaining = []
      }
      return {
        data: { program, consumed, remaining: remaining.length, not_in_queue: notInQueue, scanner: args.scanner, run_id: args.run_id },
        events: consumed ? [{ name: 'endpoint.queue.consumed', payload: { program, consumed, remaining: remaining.length, scanner: args.scanner, run_id: args.run_id } }] : [],
        before: { queue_lines: queue.length }, after: { queue_lines: remaining.length },
      }
    },

    endpoint_mark_auth: async (args, repo) => {
      const host = normalizeHost(args.host)
      const method = String(args.method || 'GET').toUpperCase()
      const p = String(args.path)
      const before = repo.getEndpoint(host, method, p)
      // roles_seen 并集合并
      let roles = []
      try { roles = JSON.parse(before?.roles_seen || '[]') } catch { roles = [] }
      if (!Array.isArray(roles)) roles = []
      const newRoles = Array.isArray(args.roles_seen) ? args.roles_seen.map(String) : []
      let rolesAdded = []
      for (const r of newRoles) { if (!roles.includes(r)) { roles.push(r); rolesAdded.push(r) } }
      const sets = {}
      if (args.auth_required !== undefined && args.auth_required !== null) sets.auth_required = args.auth_required
      if (newRoles.length || args.roles_seen !== undefined) sets.roles_seen = roles
      const r = repo.updateEndpointAuth(host, method, p, sets, Date.now())
      return {
        data: { host, method, path: p, auth_required: r.after?.auth_required ?? null, roles_seen: roles, roles_added: rolesAdded },
        events: [{
          name: 'endpoint.auth_marked',
          payload: {
            host, method, path: p,
            from: { auth_required: before?.auth_required ?? null, roles_seen: (() => { try { return JSON.parse(before?.roles_seen || '[]') } catch { return [] } })() },
            to: { auth_required: r.after?.auth_required ?? null, roles_seen: roles },
            evidence: args.evidence ?? null,
          },
        }],
        before: before ? { auth_required: before.auth_required, roles_seen: before.roles_seen } : null,
        after: { auth_required: r.after?.auth_required ?? null, roles_seen: roles },
      }
    },
  }

  const SENSITIVE_KEYWORDS = ['token', 'key', 'secret', 'password', 'passwd', 'pwd', 'access_key', 'cookie', 'authorization', 'apikey', 'api_key', 'jwt', 'session', 'auth']

  const queries = {
    endpoint_list: async (args, repo) => {
      const filters = { host: args.host || '', path_like: args.path_like || '', method: args.method || '', program_id: args.program_id || '', auth_required: args.auth_required || '' }
      const rows = repo.listEndpointsWhere(filters, { sort: args.sort || 'last_seen', dir: args.dir || 'desc' }, args.limit, args.offset)
      const total = repo.countEndpointsWhere(filters)
      return { rows, total }
    },
    endpoint_hosts: async (args, repo) => {
      return repo.hostsAggregate({ path_like: args.path_like || '', program_id: args.program_id || '' }, args.limit, args.offset)
    },
    endpoint_matrix: async (args, repo) => {
      const rows = repo.matrixAggregate({ program_id: args.program_id || '', host: args.host || '' }, args.min_roles ?? 2)
      return { rows, total: rows.length }
    },
    queue_status: async (args, repo) => {
      const program = args.program || ''
      if (program) {
        const stat = repo.queueStat(program)
        const paths = repo.queuePaths(program)
        return { programs: [{ program, queue_lines: stat.queue_lines, seen_lines: stat.seen_lines, queue_path: paths.queue, last_enqueued_at: stat.last_enqueued_at, last_consumed_at: stat.last_consumed_at }], total_queue_lines: stat.queue_lines }
      }
      // 全部项目汇总：扫描 pipeline 目录下的 param-queue.txt（跳过非目录条目）
      const pipeRoot = path.join(dataDir, 'pipeline')
      const programs = []
      let totalQueueLines = 0
      let dirs = []
      try {
        dirs = fs.readdirSync(pipeRoot).filter((d) => {
          try { return fs.statSync(path.join(pipeRoot, d)).isDirectory() } catch { return false }
        })
      } catch { dirs = [] }
      for (const d of dirs) {
        const stat = repo.queueStat(d)
        if (stat.queue_lines === 0 && stat.seen_lines === 0) continue
        const paths = repo.queuePaths(d)
        programs.push({ program: d, queue_lines: stat.queue_lines, seen_lines: stat.seen_lines, queue_path: paths.queue, last_enqueued_at: stat.last_enqueued_at, last_consumed_at: stat.last_consumed_at })
        totalQueueLines += stat.queue_lines
      }
      return { programs, total_queue_lines: totalQueueLines }
    },
    endpoint_surface_scan: async (args, repo) => {
      const program = String(args.program)
      const qs = args.q ? String(args.q).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean) : SENSITIVE_KEYWORDS
      const hits = []
      const seen = new Set()
      const check = (url, source) => {
        const low = url.toLowerCase()
        for (const kw of qs) {
          if (low.includes(kw)) {
            const k = `${url}|${kw}`
            if (!seen.has(k)) { seen.add(k); hits.push({ url, keyword: kw, source }) }
            break
          }
        }
      }
      // endpoints 表 path 扫描
      const rows = repo.listEndpointsWhere({ program_id: program, path_like: '' }, { sort: 'last_seen', dir: 'desc' }, 500, 0)
      for (const r of rows) {
        check(`${r.host}${r.path}`, 'endpoints')
        if (r.params) check(String(r.params), 'endpoints.params')
      }
      // param-queue 扫描
      for (const u of repo.readQueue(program)) check(u, 'param-queue')
      return { program, total: hits.length, hits }
    },
  }

  const subscribers = {
    onRunProposal: async (envelope) => {
      const payload = envelope?.payload || {}
      const p = payload.parse_proposal
      if (!p || p.kind !== 'endpoints' || !dispatchRef) return { ok: true, data: { skipped: true } }
      const runId = String(payload.run_id || envelope?.cause?.run_id || '')
      let registered = 0
      let failed = 0
      try {
        const r = await dispatchRef('endpoint', 'upsert', { tsv_path: p.tsv_path, program_id: payload.program_id || null }, { actor: 'script', session_id: payload.session_id || null, run_id: runId })
        if (r.ok) registered += (r.data?.created || 0); else failed++
      } catch { failed++ }
      return { ok: true, data: { registered, failed, partial: failed > 0 } }
    },
  }

  return { ...commands, queries, invariants, subscribers }
}

// ---------------------------------------------------------------------------
// 组装（测试与 cordis 共用）：manifest + handlers + backend
// ---------------------------------------------------------------------------

export function buildEndpointDomain(opts = {}) {
  const dataDir = opts.dataDir || DEFAULT_DATA_DIR
  const backend = createEndpointBackend({ dataDir })
  return {
    manifest: ENDPOINT_MANIFEST,
    handlers: makeHandlers({ ...opts, dataDir }),
    backend,
  }
}

export const endpointUtils = { normalizeHost, pathOfUrl, isStaticUrl, scopeCheckResult, parseScopePrograms }

// ---------------------------------------------------------------------------
// cordis 插件入口：向总线 registry 注册（不 provide 任何业务方法）
// ---------------------------------------------------------------------------

export function apply(ctx, config = {}) {
  const dataDir = process.env.SEC_DATA_DIR || process.env.DSH_HOME || DEFAULT_DATA_DIR
  try {
    ctx.inject(['secDomainBus'], (child) => {
      const bus = child.secDomainBus
      const domain = buildEndpointDomain({ dataDir, dispatch: (d, v, a, c) => bus.dispatch(d, v, a, c) })
      const res = bus.registry.register(domain)
      if (res.ok) log(`endpoint 域注册成功（registered=${res.registered}）`)
      else log(`endpoint 域注册被拒：${res.error?.code} ${res.error?.message}`)
      return () => { /* 不 provide 无需 dispose */ }
    })
  } catch (e) {
    log(`secDomainBus 注入失败：${e?.message}——endpoint 域未注册（总线必须先行挂载）`)
  }
  return null
}
