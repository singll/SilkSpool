// ==============================================================================
// @silksec/sec-domain-vuln — SilkSecAgent vuln 域插件（v5 Phase 1.2）
//
// 契约：doc/secagent/v5/02-vuln.md（域设计，权威）+ 01-bus.md（总线）+ 00-conventions.md（宪法）
//
// 对外（cordis）：name='sec-domain-vuln'，apply() 把 manifest+handlers+backend 交给
// 总线 registry.register()（不 provide 任何业务方法——防绕过核心承诺）。
//
// 语义要点：
//  - 命令 C1-C11（register_signal/register_candidate/confirm/reject/submit/note/
//    claim/release/verify_replay/attach_fgs/authz_diff）+ 查询 Q1-Q6，全部拆自
//    v4 asset-db.js 混合动词（updateFinding 200 行按语义拆分）；
//  - 五要素闸门/噪声闸门从 addFinding 体内 if 升级为网关不变量（INV-4）；
//  - confirm 三联动（status+confidence+noise）单 UPDATE 原子（INV-3，v4 僵君缺陷根治）；
//  - 候选池 KPI 口径 noise=1 AND status='new'（宪法 §十一）；模型通道严格、机器通道宽容；
//  - 订阅 exec.run.completed（parser proposal 机器直灌分流，Phase 2 后事件源上线）；
//  - 状态机私有：动词名即入口，调用方永远不传 status/to。
//
// 零依赖：node:fs / node:path / node:crypto / node:http / node:https（sqlite 在总线）
// ==============================================================================

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import * as http from 'node:http'
import * as https from 'node:https'
import { fileURLToPath } from 'node:url'

export const name = 'sec-domain-vuln'
export const version = '1.0.0'

const DEFAULT_DATA_DIR = process.env.SEC_DATA_DIR || '/opt/silkspool/dsh/data'
const CLAIM_TTL_DEFAULT_SEC = 3600
const REPLAY_TIMEOUT_MS = 20000
const EVIDENCE_TOKEN_RE = /run_|flow:|burp_item|evidence\/|oob:/
const LOW_INFO_TITLE_RE = /^[a-z0-9_-]+: ?\w+$/
const SEV_RANK = { critical: 4, high: 3, medium: 2, low: 1, info: 0 }
const FINDING_STATUS = ['new', 'confirmed', 'false_positive', 'submitted', 'accepted', 'dup', 'ignored']
const TERMINAL = ['accepted', 'false_positive', 'dup', 'ignored']

const log = (msg) => { try { process.stderr.write(`[sec-domain-vuln] ${msg}\n`) } catch { /* noop */ } }

const sha1 = (s) => crypto.createHash('sha1').update(String(s)).digest('hex')
const iso16 = () => new Date().toISOString().slice(0, 16)

const backendUrl = new URL('../sec-backend-vuln-sqlite/index.js', import.meta.url)
const { createVulnSqliteBackend } = await import(backendUrl.href)

// ---------------------------------------------------------------------------
// manifest（02-vuln §1.2/§1.4/§1.5 的机器形态；R1-R7 lint 全部经 validateManifestShape/Lint）
// ---------------------------------------------------------------------------

const schema = (properties, required, extra = {}) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
  ...extra,
})

const str = (opts = {}) => ({ type: 'string', ...opts })
const en = (values, extra = {}) => ({ type: 'string', enum: values, ...extra })
const num = (opts = {}) => ({ type: 'number', ...opts })
const int = (opts = {}) => ({ type: 'integer', ...opts })
const bool = () => ({ type: 'boolean' })

const SEVERITY = ['critical', 'high', 'medium', 'low', 'info']
const CONFIDENCE = ['tentative', 'confirmed', 'false_positive', 'dup']
const VERDICT = ['false_positive', 'dup', 'ignored']
const VENDOR_STATUS = ['submitted', 'pending', 'accepted', 'rejected', 'duplicate', 'not_rewarded', '']

export const VULN_MANIFEST = {
  domain: 'vuln',
  version: 1,
  service: 'secDomain.vuln',
  description: '漏洞信号 / 候选队列 / 证据链 / 提交与运营回流（v5 试点域，候选池状态机根治域）',
  owns: {
    tables: ['findings'],
    files: ['data/evidence/', 'data/events/vuln.jsonl'],
  },
  commands: {
    vuln_register_signal: {
      actor: ['model', 'human'],
      schema: schema({
        title: str({ minLength: 1 }),
        severity: en(SEVERITY),
        host: str(),
        url: str({ default: '' }),
        evidence: str(),
        reproduction_steps: str(),
        impact: str(),
        source: str({ default: 'agent' }),
        vuln_type: str(),
        cwe: str(),
        endpoint_ref: str(),
        preconditions: str(),
        recommendation: str(),
        confidence: en(CONFIDENCE, { default: 'tentative' }),
        fgs_node_id: int(),
        discovery_step: str(),
      }, ['title', 'severity', 'host', 'evidence', 'reproduction_steps', 'impact']),
      idempotent: 'natural',
      idempotent_natural: ['host', 'title', 'url'],
      events: ['vuln.signal.registered', 'vuln.candidate.promoted'],
      event_limit: 2,
      invariants: ['signalComplete'],
      timeout_ms: 60000,
      agent_note: '登记一个完整验证过的漏洞发现（唯一能新建信号面行的动词）。五要素强制：规范标题（≥10 字符，禁止工具原始输出当标题）、复现步骤、具体化影响、证据引用（run_id/flow_id/burp_item/evidence 路径/oob）、host。severity 禁 info。同 host+title+url 指纹自动去重；命中待验证候选会就地补全升级（upgraded:true）。纪律：登记前完成对抗性自检（≥2 反证假设逐一排除）+ 高危双出口复现。',
      deprecated: false,
    },
    vuln_register_candidate: {
      actor: ['webhook', 'script'],
      schema: schema({
        title: str({ minLength: 1 }),
        severity: en(SEVERITY),
        host: str(),
        url: str({ default: '' }),
        evidence: str({ default: '' }),
        source: str(),
        program_id: str(),
      }, ['title', 'severity', 'host', 'source']),
      idempotent: 'auto',
      idempotent_fields: ['title', 'host', 'url', 'source'],
      events: ['vuln.candidate.registered'],
      event_limit: 1,
      invariants: [],
      timeout_ms: 60000,
      agent_note: '机器直灌候选登记入口（webhook/parser/authz_diff，模型禁入）：缺复现/影响的登记天然落候选池待验证。',
      deprecated: false,
    },
    vuln_confirm: {
      actor: ['model', 'dashboard'],
      schema: schema({
        finding_id: int(),
        evidence: str({ minLength: 1 }),
        note: str({ default: '' }),
      }, ['finding_id', 'evidence']),
      idempotent: 'auto',
      idempotent_fields: ['finding_id', 'evidence'],
      events: ['vuln.signal.confirmed', 'vuln.candidate.promoted'],
      event_limit: 2,
      invariants: ['findingExists', 'evidenceExists'],
      timeout_ms: 60000,
      agent_note: '把待验证候选/信号确认为 confirmed（status+confidence+noise 原子三联动，候选同时出池进信号面）。evidence 必填且必须真实存在（run_id 的 results 目录 / evidence/{id}/ 证据包 / flow 文件 / oob 交互记录）。确认前自查：verify.must_pass 全过、falsification 逐项排除、verify_replay 机械复核通过。候选被他人认领时会被告知换下一条。',
      deprecated: false,
    },
    vuln_reject: {
      actor: ['model', 'dashboard'],
      schema: schema({
        finding_id: int(),
        verdict: en(VERDICT),
        reason: str({ minLength: 10 }),
        dup_of: { type: ['integer', 'null'] },
        note: str({ default: '' }),
      }, ['finding_id', 'verdict', 'reason']),
      idempotent: 'auto',
      idempotent_fields: ['finding_id', 'verdict', 'reason'],
      events: ['vuln.signal.rejected'],
      event_limit: 1,
      invariants: ['findingExists', 'dupTargetValid'],
      timeout_ms: 60000,
      agent_note: '判定 false_positive / dup / ignored。reason ≥10 字可追溯；dup 必须指回被重复的 finding（dup_of，可先用 vuln_dedup_check 查）。被拒候选自动出池；关联 FGS 节点自动 deprecated。误报判定会回流活评测集用于校准同类判定。',
      deprecated: false,
    },
    vuln_submit: {
      actor: ['model', 'dashboard'],
      schema: schema({
        finding_id: int(),
        platform: str({ default: '' }),
        bounty: { type: ['number', 'null'] },
        vendor_status: en(VENDOR_STATUS, { default: '' }),
        submission_url: str({ default: '' }),
        note: str({ default: '' }),
      }, ['finding_id']),
      idempotent: 'auto',
      idempotent_fields: ['finding_id', 'bounty', 'vendor_status', 'platform'],
      events: ['vuln.signal.submitted'],
      event_limit: 1,
      invariants: ['findingExists', 'submittable'],
      timeout_ms: 60000,
      agent_note: '确认后的运营流转：confirmed → submitted（平台提交后）；vendor 反馈（accepted/bounty/vendor_status）在 submitted 态再次调用回流运营列。提交前先 report_draft_submission（report 域）出草稿人工审校。',
      deprecated: false,
    },
    vuln_note: {
      actor: ['model', 'dashboard'],
      schema: schema({
        finding_id: int(),
        note: str({ minLength: 1 }),
        evidence_ref: str({ default: '' }),
      }, ['finding_id', 'note']),
      idempotent: 'auto',
      idempotent_fields: ['finding_id', 'note'],
      events: [],
      event_limit: 0,
      invariants: ['findingExists'],
      timeout_ms: 60000,
      agent_note: '向 finding 追加证据链条目（不改状态，任意状态可用）。用于补充观察、勘误说明、复验记录。带时间戳前缀追加。',
      deprecated: false,
    },
    vuln_claim: {
      actor: ['model', 'dashboard'],
      schema: schema({
        finding_id: int(),
      }, ['finding_id']),
      idempotent: 'auto',
      idempotent_fields: ['finding_id'],
      idempotent_ctx_fields: ['session_id', 'operator'],
      events: ['vuln.candidate.claimed'],
      event_limit: 1,
      invariants: ['findingExists', 'candidateTarget'],
      timeout_ms: 60000,
      agent_note: '认领一条待验证候选（防多 worker 重复验证）。软锁 TTL 3600s，超时自动可抢占。认领后尽快验证并 vuln_confirm / vuln_reject，不再处理时 vuln_release。',
      deprecated: false,
    },
    vuln_release: {
      actor: ['model', 'dashboard'],
      schema: schema({
        finding_id: int(),
      }, ['finding_id']),
      idempotent: 'auto',
      idempotent_fields: ['finding_id'],
      idempotent_ctx_fields: ['session_id', 'operator'],
      events: [],
      event_limit: 0,
      invariants: ['findingExists'],
      timeout_ms: 60000,
      agent_note: '释放自己认领的候选（改做其他事时必须释放，别让锁白占到超时）。',
      deprecated: false,
    },
    vuln_verify_replay: {
      actor: ['model', 'script'],
      schema: schema({
        finding_id: int(),
        proxy: str({ default: '' }),
        expect_hash: str({ default: '' }),
      }, ['finding_id']),
      idempotent: 'auto',
      idempotent_fields: ['finding_id', 'expect_hash'],
      events: [],
      event_limit: 0,
      invariants: ['findingExists'],
      timeout_ms: 120000,
      agent_note: '机械复核（LLM 不给自己当法官）。重放 evidence/{id}/request.txt，响应体 sha256 与 expect_hash 比对，结果追加 verify-log.md。CONFIRMED 纪律自查要求本复核通过。',
      deprecated: false,
    },
    vuln_attach_fgs: {
      actor: ['model', 'reactor'],
      schema: schema({
        finding_id: int(),
        fgs_node_id: int({ minimum: 1 }),
      }, ['finding_id', 'fgs_node_id']),
      idempotent: 'auto',
      idempotent_fields: ['finding_id', 'fgs_node_id'],
      events: [],
      event_limit: 0,
      invariants: ['findingExists', 'fgsAttachable'],
      timeout_ms: 60000,
      agent_note: '把 FGS finding 节点关联到 finding 行（任务内显式建图时用；调度会话内自动关联由 fgs 域事件完成，通常无需手动）。',
      deprecated: false,
    },
    vuln_authz_diff: {
      actor: ['model'],
      schema: schema({
        url: str({ minLength: 1 }),
        method: str({ default: 'GET' }),
        headers_low: { oneOf: [str(), { type: 'object' }] },
        headers_high: { oneOf: [str(), { type: 'object' }] },
        body: str(),
      }, ['url', 'headers_low', 'headers_high']),
      idempotent: 'auto',
      idempotent_fields: ['url', 'method', 'headers_low', 'headers_high'],
      events: [],
      event_limit: 0,
      invariants: [],
      timeout_ms: 120000,
      agent_note: '双权凭证重放对比（越权/IDOR 探测 harness）：同一 URL 以低权与高权凭证各请求一次，机器比对状态码与响应相似度给出 unlikely/review/suspected 三档判定。suspected（低权 200 且响应与高权高度相似）会自动登记为待验证候选——你要继续取证数据归属并走常规验证流。目标必须经授权白名单。',
      deprecated: false,
    },
  },
  queries: {
    vuln_list: {
      actor: ['model', 'dashboard', 'human'],
      params: schema({
        visibility: en(['signal', 'candidate', 'all'], { default: 'signal' }),
        host: str({ default: '' }),
        severity: en([...SEVERITY, ''], { default: '' }),
        status: en([...FINDING_STATUS, ''], { default: '' }),
        program_id: str({ default: '' }),
        q: str({ default: '' }),
        limit: int({ minimum: 1, maximum: 500 }),
        offset: int({ minimum: 0 }),
        sort: en(['created_at', 'id', 'status', 'severity', ''], { default: 'created_at' }),
        dir: en(['asc', 'desc', ''], { default: 'desc' }),
      }, []),
      predicates: ['visibility', 'severity', 'status'],
      agent_note: '检索漏洞发现。visibility=signal（默认，仅信号面）/ candidate（待验证候选队列）/ all。按 host/severity/status/program_id/q 过滤，分页+排序。',
    },
    vuln_get: {
      actor: ['model', 'dashboard', 'human', 'reactor', 'system'],
      params: schema({ id: int() }, ['id']),
      predicates: [],
      agent_note: '取单条 finding 全量详情（含 evidence 证据链全文）。',
    },
    vuln_candidates: {
      actor: ['model', 'dashboard', 'human'],
      params: schema({
        claim_state: en(['available', 'unclaimed', 'claimed', 'stale', 'all'], { default: 'available' }),
        severity_min: en([...SEVERITY, ''], { default: '' }),
        program_id: str({ default: '' }),
        host: str({ default: '' }),
        limit: int({ minimum: 1, maximum: 500 }),
        offset: int({ minimum: 0 }),
        sort: en(['severity', 'created_at', 'claimed_at', ''], { default: 'severity' }),
        dir: en(['asc', 'desc', ''], { default: 'desc' }),
      }, []),
      predicates: ['claim_state', 'severity_min'],
      agent_note: '待验证候选工作队列。claim_state=available（默认，未认领+认领超时）可筛 unclaimed/claimed/stale/all，带池摘要。',
    },
    vuln_stats: {
      actor: ['model', 'dashboard', 'human'],
      params: schema({}, []),
      predicates: [],
      agent_note: '漏洞计数总览：信号面（by severity/status）与候选面（pending/claimed）分开计数。候选口径=待消化（noise=1 且 status=new）。',
    },
    vuln_by_asset: {
      actor: ['model', 'dashboard', 'human'],
      params: schema({
        host: str(),
        include_candidates: bool(),
      }, ['host']),
      predicates: [],
      agent_note: '单资产漏洞视图（按 severity 分组计数，可选含候选）。',
    },
    vuln_dedup_check: {
      actor: ['model', 'dashboard', 'human'],
      params: schema({
        host: str({ default: '' }),
        vuln_type: str({ default: '' }),
        exclude_id: int(),
        limit: int({ minimum: 1, maximum: 50, default: 10 }),
      }, []),
      predicates: [],
      agent_note: '同目标/同类型历史查重（host 或 vuln_type 至少其一）。提交前必查，防平台判重。',
    },
  },
  events: {
    'vuln.candidate.registered': { payload: { type: 'object' }, redact: [] },
    'vuln.candidate.promoted': { payload: { type: 'object' }, redact: [] },
    'vuln.candidate.claimed': { payload: { type: 'object' }, redact: [] },
    'vuln.signal.registered': { payload: { type: 'object' }, redact: [] },
    'vuln.signal.confirmed': { payload: { type: 'object' }, redact: [] },
    'vuln.signal.rejected': { payload: { type: 'object' }, redact: [] },
    'vuln.signal.submitted': { payload: { type: 'object' }, redact: [] },
  },
  subscribes: {
    'exec.run.completed': { handler: 'onParserProposal', mode: 'async', as: 'reactor' },
  },
  backend: 'repository-v1',
}

// ---------------------------------------------------------------------------
// 域名工具（指纹/主机归一/证据引用校验，全部对齐 02-vuln §1.3/§2.1）
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
    if (close >= 0) s = close + 1 < s.length ? s.slice(1, close) : s.slice(1, close)
  } else {
    s = s.replace(/:\d+$/, '')
  }
  return s.replace(/\.$/, '')
}

function hostOf(urlStr) {
  try {
    const u = new URL(String(urlStr))
    return normalizeHost(u.host)
  } catch { return normalizeHost(String(urlStr).split('/')[0]) }
}

function fpWeak(host, title) { return sha1(`${normalizeHost(host)}|${String(title).trim()}`) }
function fpStrong(host, title, url) { return sha1(`${normalizeHost(host)}|${String(title).trim()}|${url || ''}`) }

function refPrefix(evidence) {
  const m = String(evidence || '').match(/^(run_[A-Za-z0-9_-]+|flow:[^\s]+|burp_item[: ][^\s]+|evidence\/\d+\/?|oob:[^\s]+)/)
  return m ? m[1] : null
}

function isoPrefix(now) { return `[${new Date(now).toISOString().slice(0, 16)}]` }

// evidence 引用真实存在性（INV-2，02-vuln §1.3 C3）——dataDir 下结果/证据/flows/oob 布局
function evidenceProbe(evidence, findingId, dataDir) {
  const e = String(evidence || '')
  const probes = []
  const token = refPrefix(e)
  if (!token) return { ok: false, reason: 'no_ref' }
  if (token.startsWith('run_')) {
    probes.push(path.join(dataDir, 'results', token, 'meta.json'))
    probes.push(path.join(dataDir, 'results', token, 'meta.yaml'))
  } else if (token.startsWith('flow:')) {
    const rel = token.slice('flow:'.length)
    probes.push(path.join(dataDir, rel.startsWith('/') ? rel.slice(1) : rel))
    probes.push(path.join(dataDir, 'flows', rel.replace(/^flows\//, '')))
  } else if (token.startsWith('evidence/')) {
    probes.push(path.join(dataDir, token))
    probes.push(path.join(dataDir, 'evidence', String(findingId)))
  } else if (token.startsWith('burp_item')) {
    probes.push(path.join(dataDir, 'evidence', String(findingId)))
  } else if (token.startsWith('oob:')) {
    probes.push(path.join(dataDir, 'oob', token.slice(4)))
  }
  return { ok: probes.some((p) => fs.existsSync(p)), probes, token }
}

// ---------------------------------------------------------------------------
// HTTP 重放（C9/C11 共用；direct / SEC_EGRESS_PROXY 默认出口，02-vuln §1.3 C9）
// ---------------------------------------------------------------------------

function parseRequestText(raw) {
  const [head, ...rest] = String(raw).split(/\r?\n\r?\n/)
  const lines = head.split(/\r?\n/)
  const m = lines[0].match(/^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|TRACE|CONNECT)\s+(\S+)/)
  if (!m) return { error: 'request.txt 首行无法解析（须为 METHOD target）' }
  const headers = {}
  for (const line of lines.slice(1)) {
    const i = line.indexOf(':')
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim()
  }
  return { method: m[1], target: m[2], headers, body: rest.join('\n\n') }
}

function replayHttp({ method, url, headers, body, timeoutMs = REPLAY_TIMEOUT_MS, redirectCount = 0 }) {
  return new Promise((resolve, reject) => {
    const hdrs = { ...headers }
    delete hdrs['content-length']
    delete hdrs['connection']
    delete hdrs['content-length']
    delete hdrs['accept-encoding']
    hdrs['accept-encoding'] = 'identity'
    if (body !== undefined && body !== null && !hdrs['content-type']) hdrs['content-type'] = 'text/plain'
    const mod = url.startsWith('https:') ? https : http
    let req
    try {
      const u = new URL(url)
      const pathq = u.pathname + u.search
      req = mod.request({
        host: u.hostname,
        port: u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80),
        path: pathq,
        method,
        headers: hdrs,
        timeout: timeoutMs,
      }, (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const status = res.statusCode
          const bodyBuf = Buffer.concat(chunks)
          if ([301, 302, 303, 307, 308].includes(status) && res.headers.location && redirectCount < 5) {
            let next = res.headers.location
            try { next = new URL(next, url).href } catch { /* keep raw */ }
            replayHttp({ method, url: next, headers, body, timeoutMs, redirectCount: redirectCount + 1 })
              .then(resolve).catch(reject)
            return
          }
          resolve({ status, body: bodyBuf.toString('utf8'), headers: res.headers })
        })
        res.on('error', reject)
      })
    } catch (e) { return reject(e) }
    req.on('timeout', () => req.destroy(Object.assign(new Error('replay timeout'), { code: 'ETIMEDOUT' })))
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

function resolveProxy(arg) {
  if (arg === 'direct') return null
  if (arg && arg !== '') return String(arg)
  const env = process.env.SEC_EGRESS_PROXY
  return env && env !== '' ? String(env) : null
}

// 经 http 正向代理重放（v4 httpReplay 同款：mubeng 网关 http 绝对 URI 转发）
function proxyReplayHttp({ method, url, proxy, headers, body, timeoutMs = REPLAY_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const hdrs = { ...headers }
    delete hdrs['content-length']
    delete hdrs['connection']
    hdrs['accept-encoding'] = 'identity'
    let req
    try {
      const pu = new URL(proxy)
      req = http.request({
        host: pu.hostname,
        port: pu.port ? Number(pu.port) : 80,
        path: url,
        method,
        headers: hdrs,
        timeout: timeoutMs,
      }, (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers }))
        res.on('error', reject)
      })
    } catch (e) { return reject(e) }
    req.on('timeout', () => req.destroy(Object.assign(new Error('proxy replay timeout'), { code: 'ETIMEDOUT' })))
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

// ---------------------------------------------------------------------------
// handlers（每个命令一个实现；错误抛 {code, hint, retryable?} 由网关转信封）
// ---------------------------------------------------------------------------

function claimerOf(ctx) {
  if (ctx.actor === 'dashboard') return ctx.operator || 'operator'
  return ctx.session_id || ctx.actor || 'model'
}

function makeHandlers(opts) {
  const dataDir = opts.dataDir || DEFAULT_DATA_DIR
  const ttlSec = opts.claim_ttl_sec || CLAIM_TTL_DEFAULT_SEC
  const dispatchRef = opts.dispatch

  function throwErr(code, message, hint, retryable = false) {
    throw Object.assign(new Error(message), { code, hint, retryable })
  }

  const invariants = {
    findingExists: async (args, repo) => {
      const row = repo.getFinding(args.finding_id)
      if (!row) return { code: 'E_NOT_FOUND', message: `finding #${args.finding_id} 不存在`, hint: '先 vuln_get / vuln_list 核实 id' }
      return null
    },
    signalComplete: async (args) => {
      const title = String(args.title || '').trim()
      const lowInfo = LOW_INFO_TITLE_RE.test(title)
      if (title.length < 10 || lowInfo || !String(args.reproduction_steps || '').trim() || !String(args.impact || '').trim()) {
        return { code: 'E_VULN_INCOMPLETE', message: '五要素缺失：标题 ≥10 字符（且非工具原始输出）、复现步骤、具体影响必填', hint: '信号登记要求五要素完整（规范标题≥10 字符、复现步骤、具体影响、证据引用、host）。机器产出或不完整观察请勿用本动词；完成对抗性自检与双出口复现后再登记', retryable: false }
      }
      if (args.severity === 'info') return { code: 'E_VULN_INFO_SEVERITY', message: 'severity=info 不进信号面', hint: 'info 级侦察副产物不进信号面。如确有安全价值，按 rules/src/severity-rating.md 重新定级（信息泄露默认低危）后以 low+具体影响登记', retryable: false }
      if (!EVIDENCE_TOKEN_RE.test(String(args.evidence || ''))) {
        return { code: 'E_EVIDENCE_REQUIRED', message: 'evidence 必须含证据引用', hint: '证据必须是 run_id/flow_id/burp_item/evidence 路径/oob 交互记录引用，无证据不结论（sec-verification 铁律）', retryable: false }
      }
      return null
    },
    evidenceExists: async (args) => {
      const probe = evidenceProbe(args.evidence, args.finding_id, dataDir)
      if (!probe.ok) {
        return { code: 'E_EVIDENCE_REQUIRED', message: `证据引用不存在：${probe.token || args.evidence}`, hint: '确认必须附真实存在的证据引用（run_id 的 results 目录 / evidence/{id}/ 证据包）。CONFIRMED 还须 verify_replay 机械复核通过', retryable: false }
      }
      return null
    },
    dupTargetValid: async (args, repo, ctx) => {
      if (args.verdict !== 'dup') return null
      if (!Number.isInteger(args.dup_of)) {
        // 兼容期（02-vuln §3.2 finding_update）：别名层已尽力自动填充同 host+同 vuln_type 候选行，
        // 查不到时留空放行（观察期后必填）；直连路径无 ctx.compat，严格要求
        if (ctx && ctx.compat && ctx.compat.dup_of_relaxed === true) return null
        return { code: 'E_VULN_DUP_TARGET_REQUIRED', message: 'verdict=dup 必须带 dup_of', hint: 'dup 判定必须指回被重复的 finding（dup_of）。可先用 vuln_dedup_check 检索同目标同类型历史', retryable: false }
      }
      const target = repo.getFinding(args.dup_of)
      if (!target) return { code: 'E_NOT_FOUND', message: `dup_of #${args.dup_of} 不存在`, hint: 'dup_of 必须指向已存在的 finding' }
      return null
    },
    candidateTarget: async (args, repo) => {
      const row = repo.getFinding(args.finding_id)
      if (row && !(row.noise === 1 && row.status === 'new')) {
        return { code: 'E_VULN_NOT_CANDIDATE', message: `finding #${args.finding_id} 非候选池行（noise=${row.noise} status=${row.status}）`, hint: '认领只作用于候选池行（noise=1 AND status=new）。信号面行的验证由任务编排保证，无需认领', retryable: false }
      }
      return null
    },
    submittable: async (args, repo) => {
      const row = repo.getFinding(args.finding_id)
      if (!row) return null
      if (!['confirmed', 'submitted'].includes(row.status)) {
        return { code: 'E_STATE', message: `finding #${args.finding_id} 状态 ${row.status} 不可提交`, hint: '提交前必须先 vuln_confirm；vendor 翻案（accepted→重复/驳回）用 dashboard 通道 vuln_submit 附 operator 审计', retryable: false }
      }
      return null
    },
    fgsAttachable: async (args, repo) => {
      const row = repo.getFinding(args.finding_id)
      if (!row) return null
      if (!['new', 'confirmed'].includes(row.status)) {
        return { code: 'E_STATE', message: `finding #${args.finding_id} 状态 ${row.status} 不可挂 FGS 节点`, hint: 'fgs_node_id 关联仅限 new/confirmed 行', retryable: false }
      }
      return null
    },
  }

  function claimGuard(row, ctx) {
    if (row.noise !== 1 || row.status !== 'new') return null
    if (ctx.actor === 'dashboard') return null
    if (row.claimed_by && row.claimed_by !== claimerOf(ctx) && row.claimed_at && Date.now() - row.claimed_at < ttlSec * 1000) {
      return { by: row.claimed_by, at: row.claimed_at }
    }
    return null
  }

  async function confirmClaimed(args, repo, ctx) {
    const row = repo.getFinding(args.finding_id)
    const guard = claimGuard(row, ctx)
    if (guard) {
      throwErr('E_VULN_CLAIMED', `候选 #${args.finding_id} 被会话 ${guard.by} 活跃认领（认领于 ${Math.round((Date.now() - guard.at) / 60000)} 分钟前，TTL ${ttlSec}s）`, '该候选正被其他会话验证，请挑 vuln_candidates 中下一条 available 候选', true)
    }
  }

  const commands = {
    // C1：登记完整信号（强指纹去重 / 弱指纹命中候选 promote 升级）
    vuln_register_signal: async (args, repo, ctx) => {
      const host = normalizeHost(args.host)
      const title = String(args.title).trim()
      const url = String(args.url || '')
      const weak = fpWeak(host, title)
      const strong = fpStrong(host, title, url)
      const now = Date.now()
      const dup = repo.getFindingByFingerprint(strong)
      if (dup) {
        if (ctx.session_id) repo.backfillSession(dup.id, ctx.session_id)
        return {
          data: { id: dup.id, dup: true, upgraded: false, noise: dup.noise === 1, status: dup.status },
          events: [],
          before: { status: dup.status, noise: dup.noise }, after: { status: dup.status, noise: dup.noise },
        }
      }
      const cand = repo.getFindingByFingerprint(weak)
      if (cand && cand.noise === 1 && cand.status === 'new') {
        const merged = repo.mergeCandidate(cand.id, {
          title, host, url, severity: args.severity, evidence: args.evidence, source: args.source || 'agent',
          vuln_type: args.vuln_type || null, cwe: args.cwe || null, endpoint_ref: args.endpoint_ref || null,
          preconditions: args.preconditions || null, reproduction_steps: args.reproduction_steps || null,
          impact: args.impact || null, recommendation: args.recommendation || null,
          confidence: args.confidence || 'tentative', fgs_node_id: args.fgs_node_id || null,
          discovery_step: args.discovery_step || null, session_id: ctx.session_id || null,
          updated_at: now,
        }, strong)
        if (merged.changed) {
          return {
            data: { id: cand.id, dup: false, upgraded: true, noise: false, status: merged.after?.status || 'new' },
            events: [
              { name: 'vuln.signal.registered', payload: { finding_id: cand.id, fingerprint: strong, severity: args.severity, host, session_id: ctx.session_id || null, fgs_node_id: args.fgs_node_id || null } },
              { name: 'vuln.candidate.promoted', payload: { finding_id: cand.id, from: { noise: 1, status: 'new' }, to: { noise: 0, status: 'new' }, cause_cmd: 'vuln_register_signal' } },
            ],
            before: { status: cand.status, noise: 1 }, after: { status: 'new', noise: 0 },
          }
        }
      }
      const row = repo.insertFinding({
        fingerprint: strong, title, severity: args.severity, host, url,
        evidence: args.evidence || '', source: args.source || 'agent',
        program_id: args.program_id || null, session_id: ctx.session_id || null,
        vuln_type: args.vuln_type || null, cwe: args.cwe || null, endpoint_ref: args.endpoint_ref || null,
        preconditions: args.preconditions || null, reproduction_steps: args.reproduction_steps || null,
        impact: args.impact || null, recommendation: args.recommendation || null,
        noise: 0, status: 'new', confidence: args.confidence || 'tentative',
        fgs_node_id: args.fgs_node_id || null, discovery_step: args.discovery_step || null,
        created_at: now, updated_at: now,
      })
      return {
        data: { id: row.id, dup: false, upgraded: false, noise: false, status: 'new' },
        events: [{ name: 'vuln.signal.registered', payload: { finding_id: row.id, fingerprint: strong, severity: args.severity, host, session_id: ctx.session_id || null, fgs_node_id: args.fgs_node_id || null } }],
        before: null, after: { id: row.id, status: 'new', noise: 0 },
      }
    },

    // C2：机器直灌候选（宽容 dup；弱指纹同 host+title 去重）
    vuln_register_candidate: async (args, repo, ctx) => {
      const host = normalizeHost(args.host)
      const title = String(args.title).trim()
      const url = String(args.url || '')
      const weak = fpWeak(host, title)
      const now = Date.now()
      const dup = repo.getFindingByFingerprint(weak)
      if (dup) {
        if (ctx.session_id && !dup.session_id) repo.backfillSession(dup.id, ctx.session_id)
        return {
          data: { id: dup.id, dup: true, noise: dup.noise === 1, status: dup.status },
          events: [],
          before: { status: dup.status, noise: dup.noise }, after: { status: dup.status, noise: dup.noise },
        }
      }
      const row = repo.insertFinding({
        fingerprint: weak, title, severity: args.severity || 'info', host, url,
        evidence: args.evidence || '', source: args.source || 'webhook',
        program_id: args.program_id || null, session_id: ctx.session_id || null,
        vuln_type: null, cwe: null, endpoint_ref: null, preconditions: null,
        reproduction_steps: null, impact: null, recommendation: null,
        noise: 1, status: 'new', confidence: 'tentative',
        fgs_node_id: null, discovery_step: null,
        created_at: now, updated_at: now,
      })
      return {
        data: { id: row.id, dup: false, noise: true, status: 'new' },
        events: [{
          name: 'vuln.candidate.registered',
          payload: { finding_id: row.id, fingerprint: weak, title_head: title.slice(0, 60), severity: args.severity || 'info', host, source: args.source || 'webhook', program_id: args.program_id || null },
        }],
        before: null, after: { id: row.id, status: 'new', noise: 1 },
      }
    },

    // C3：候选/信号 → confirmed（三联动原子升级；note 同事务追加）
    vuln_confirm: async (args, repo, ctx) => {
      await confirmClaimed(args, repo, ctx)
      const row = repo.getFinding(args.finding_id)
      const changed = repo.transitionFinding(args.finding_id, 'new', { status: 'confirmed', confidence: 'confirmed', noise: 0, claimed_by: null, claimed_at: null, updated_at: Date.now() })
      if (!changed.changed) throwErr('E_STATE', `finding #${args.finding_id} 状态非 new 或已终态`, 'finding 已处于终态/已确认，不可再次流转。补证据用 vuln_note；提交用 vuln_submit', false)
      if (args.note) repo.appendEvidence(args.finding_id, `${isoPrefix(Date.now())} confirm: ${args.note}`)
      const fromCandidate = row.noise === 1
      const events = [{ name: 'vuln.signal.confirmed', payload: { finding_id: args.finding_id, from: { status: 'new', noise: row.noise }, evidence_ref: refPrefix(args.evidence), confidence: 'confirmed', fgs_node_id: row.fgs_node_id || null, vuln_type: row.vuln_type || null } }]
      if (fromCandidate) events.push({ name: 'vuln.candidate.promoted', payload: { finding_id: args.finding_id, from: { noise: 1, status: 'new' }, to: { noise: 0, status: 'confirmed' }, cause_cmd: 'vuln_confirm' } })
      return {
        data: { id: args.finding_id, status: 'confirmed', signal: true, promoted_from_candidate: fromCandidate },
        events,
        before: { status: row.status, noise: row.noise, confidence: row.confidence }, after: { status: 'confirmed', noise: 0, confidence: 'confirmed' },
      }
    },

    // C4：false_positive / dup / ignored（noise 不动——候选出池靠口径）
    vuln_reject: async (args, repo, ctx) => {
      await confirmClaimed(args, repo, ctx)
      const row = repo.getFinding(args.finding_id)
      if (TERMINAL.includes(row.status) || row.status === 'accepted') {
        throwErr('E_STATE', `finding #${args.finding_id} 处于 ${row.status} 终态不可再流转`, '已终态不可再流转；如需翻案走人工通道（dashboard 侧 vuln_confirm 附 operator 审计）', false)
      }
      const set = { status: args.verdict, claimed_by: null, claimed_at: null, updated_at: Date.now() }
      if (args.verdict !== 'ignored') set.confidence = args.verdict
      const changed = repo.transitionFinding(args.finding_id, ['new', 'confirmed', 'submitted'], set)
      if (!changed.changed) throwErr('E_STATE', `finding #${args.finding_id} 状态 ${row.status} 不可 reject`, '已终态不可再流转', false)
      if (args.note) repo.appendEvidence(args.finding_id, `${isoPrefix(Date.now())} reject(${args.verdict}): ${args.note}`)
      return {
        data: { id: args.finding_id, status: args.verdict, noise: row.noise === 1, rejected: true },
        events: [{ name: 'vuln.signal.rejected', payload: { finding_id: args.finding_id, verdict: args.verdict, from: { status: row.status, noise: row.noise }, reason_head: String(args.reason || '').slice(0, 60), dup_of: args.dup_of || null, fgs_node_id: row.fgs_node_id || null } }],
        before: { status: row.status, noise: row.noise, confidence: row.confidence }, after: { status: args.verdict, noise: row.noise },
      }
    },

    // C5：confirmed → submitted / 运营列回流 / accepted（vendor 判 accepted 自环升级）
    vuln_submit: async (args, repo) => {
      const row = repo.getFinding(args.finding_id)
      const now = Date.now()
      const sets = {}
      if (args.bounty !== null && args.bounty !== undefined && args.bounty !== '') sets.bounty = Number(args.bounty)
      if (args.vendor_status) sets.vendor_status = String(args.vendor_status)
      let to = row.status
      if (row.status === 'confirmed') {
        sets.status = 'submitted'
        sets.submitted_at = now
        to = 'submitted'
      } else if (row.status === 'submitted' && args.vendor_status === 'accepted') {
        sets.status = 'accepted'
        to = 'accepted'
      }
      sets.updated_at = now
      const changed = repo.updateFields(args.finding_id, sets)
      if (!changed.changed) throwErr('E_STATE', `finding #${args.finding_id} 更新失败`, '提交前必须先 vuln_confirm', false)
      const metaNote = []
      if (args.platform) metaNote.push(`platform=${args.platform}`)
      if (args.submission_url) metaNote.push(`submission_url=${args.submission_url}`)
      if (args.note) metaNote.push(args.note)
      if (metaNote.length) repo.appendEvidence(args.finding_id, `${isoPrefix(now)} submit: ${metaNote.join(' ')}`)
      return {
        data: { id: args.finding_id, status: to, from: row.status, submitted_at: to === 'submitted' ? now : row.submitted_at || null },
        events: [{ name: 'vuln.signal.submitted', payload: { finding_id: args.finding_id, from: { status: row.status }, to: { status: to }, bounty: sets.bounty ?? null, vendor_status: args.vendor_status || '', platform: args.platform || '' } }],
        before: { status: row.status, noise: row.noise }, after: { status: to, noise: row.noise },
      }
    },

    // C6：证据链追加（任意状态，无事件）
    vuln_note: async (args, repo) => {
      const note = String(args.note || '').trim()
      if (!note) throwErr('E_SCHEMA', 'note 必须非空', '补充证据链内容后再调用', false)
      const ref = String(args.evidence_ref || '')
      if (ref && !EVIDENCE_TOKEN_RE.test(ref)) throwErr('E_EVIDENCE_REQUIRED', `evidence_ref 格式非法: ${ref}`, '证据引用须为 run_id/flow_id/burp_item/evidence 路径/oob 之一', false)
      const text = ref ? `note: ${note} （ref: ${ref}）` : `note: ${note}`
      repo.appendEvidence(args.finding_id, `${isoPrefix(Date.now())} ${text}`)
      const row = repo.getFinding(args.finding_id)
      return {
        data: { id: args.finding_id, status: row.status, noted: true },
        events: [],
        before: null, after: { status: row.status, noise: row.noise },
      }
    },

    // C7：认领候选（原子抢占 + TTL 软锁）
    vuln_claim: async (args, repo, ctx) => {
      const claimer = claimerOf(ctx)
      const now = Date.now()
      const res = repo.setClaim(args.finding_id, claimer, now, ttlSec)
      if (!res.ok) {
        const row = repo.getFinding(args.finding_id)
        if (!row || !(row.noise === 1 && row.status === 'new')) throwErr('E_VULN_NOT_CANDIDATE', `finding #${args.finding_id} 非候选池行`, '认领只作用于候选池行', false)
        if (row.claimed_by === claimer) {
          return { data: { id: args.finding_id, claimed_by: claimer, already: true }, events: [], before: { claimed_by: row.claimed_by }, after: { claimed_by: claimer } }
        }
        throwErr('E_VULN_CLAIMED', `候选 #${args.finding_id} 已被 ${row.claimed_by} 认领`, `候选 #${args.finding_id} 已被 ${row.claimed_by} 认领（TTL ${ttlSec}s）。用 vuln_candidates claim_state=available 取下一条`, true)
      }
      return {
        data: { id: args.finding_id, claimed_by: claimer, claimed_at: now, ttl_sec: ttlSec },
        events: [{ name: 'vuln.candidate.claimed', payload: { finding_id: args.finding_id, claimed_by: claimer, claimed_at: now, ttl_sec: ttlSec } }],
        before: { claimed_by: res.previous?.claimed_by ?? null }, after: { claimed_by: claimer },
      }
    },

    // C8：释放认领（宽松幂等；仅认领者本人可释放）
    vuln_release: async (args, repo, ctx) => {
      const claimer = claimerOf(ctx)
      const row = repo.getFinding(args.finding_id)
      if (!row || !row.claimed_by) {
        return { data: { id: args.finding_id, released: false, already: true }, events: [], before: { claimed_by: null }, after: { claimed_by: null } }
      }
      if (row.claimed_by !== claimer && ctx.actor !== 'dashboard') throwErr('E_VULN_CLAIMED', `候选 #${args.finding_id} 认领者是 ${row.claimed_by}，非当前调用方`, '仅认领者可释放（跨会话协作请等 TTL 超时自动可抢占）', true)
      const changed = repo.updateFields(args.finding_id, { claimed_by: null, claimed_at: null, updated_at: Date.now() })
      return {
        data: { id: args.finding_id, released: changed.changed, claimed_by: null },
        events: [],
        before: { claimed_by: row.claimed_by }, after: { claimed_by: null },
      }
    },

    // C9：CONFIRMED 机械复核（重放 request.txt + sha256 + verify-log 追加，不改行）
    vuln_verify_replay: async (args, repo) => {
      const row = repo.getFinding(args.finding_id)
      if (!row) throwErr('E_NOT_FOUND', `finding #${args.finding_id} 不存在`, '先 vuln_get 核实 id', false)
      const dir = path.join(dataDir, 'evidence', String(args.finding_id))
      const reqFile = path.join(dir, 'request.txt')
      const legacyFile = path.join(dir, 'manifest.json')
      if (!fs.existsSync(reqFile)) {
        let legacy = null
        try { legacy = JSON.parse(fs.readFileSync(legacyFile, 'utf8')) } catch { legacy = null }
        if (legacy && legacy.mode === 'legacy-inline') {
          throwErr('E_EVIDENCE_LEGACY_UNAVAILABLE', `finding #${args.finding_id} 为 legacy-inline 证据（无 request/response）`, '历史 finding 无机械复核能力。先取证产出新证据包（request.txt 落 evidence/{id}/）再复核', false)
        }
        throwErr('E_NOT_FOUND', `evidence/${args.finding_id}/request.txt 不存在`, '先在任务内产出证据包（request.txt 落 evidence/{id}/）再复核', false)
      }
      const parsed = parseRequestText(fs.readFileSync(reqFile, 'utf8'))
      if (parsed.error) throwErr('E_VULN_REPLAY_FAILED', parsed.error, '首行无法解析说明 request.txt 非标准 HTTP 报文，重新产出证据包', true)
      let url = parsed.target
      const hasScheme = /^https?:\/\//i.test(url)
      if (!hasScheme) {
        const hostHdr = parsed.headers['host'] || parsed.headers['Host']
        if (!hostHdr) throwErr('E_VULN_REPLAY_FAILED', 'request.txt 缺 Host 头', '重新产出证据包（须含 Host 头）', true)
        url = `https://${hostHdr}${url.startsWith('/') ? url : '/' + url}`
      }
      const proxy = resolveProxy(args.proxy)
      try {
        const resp = proxy
          ? await proxyReplayHttp({ method: parsed.method, url, proxy, headers: parsed.headers, body: parsed.body })
          : await replayHttp({ method: parsed.method, url, headers: parsed.headers, body: parsed.body })
        const hash = crypto.createHash('sha256').update(resp.body, 'utf8').digest('hex')
        let verdict = 'REPLAYED'
        if (args.expect_hash) verdict = hash === args.expect_hash ? 'PASS' : 'FAIL(hash 不一致)'
        fs.mkdirSync(dir, { recursive: true })
        fs.appendFileSync(path.join(dir, 'verify-log.md'), `| ${isoPrefix(Date.now())} | ${proxy || 'direct'} | ${resp.status} | sha256:${hash.slice(0, 16)}… | ${verdict} |\n`)
        return {
          data: { id: args.finding_id, status: resp.status, sha256: hash, verdict, proxy: proxy || 'direct' },
          events: [],
          target: `evidence/${args.finding_id}/request.txt`,
          before: null, after: null,
        }
      } catch (e) {
        throwErr('E_VULN_REPLAY_FAILED', `重放失败: ${e?.message}`, '网络波动可重试；持续失败请检查出口代理与目标可达性', true)
      }
    },

    // C10：FGS 节点关联回写（reactor 供 fgs 域订阅回写，覆盖式）
    vuln_attach_fgs: async (args, repo) => {
      const changed = repo.updateFields(args.finding_id, { fgs_node_id: args.fgs_node_id, updated_at: Date.now() })
      if (!changed.changed) throwErr('E_NOT_FOUND', `finding #${args.finding_id} 不存在`, null, false)
      return {
        data: { id: args.finding_id, fgs_node_id: args.fgs_node_id },
        events: [],
        before: null, after: { fgs_node_id: args.fgs_node_id },
      }
    },

    // C11：双权凭证重放对比（verdict 三档；suspected 域内以 actor=script 落 C2 候选）
    vuln_authz_diff: async (args, repo, ctx) => {
      const url = String(args.url || '')
      if (!url) throwErr('E_SCHEMA', 'url 不能为空', null, false)
      const method = String(args.method || 'GET').toUpperCase()
      const body = args.body ? String(args.body) : undefined
      const mk = (h) => {
        const base = { 'content-type': 'application/json', 'user-agent': 'SilkSecAgent-authz-diff' }
        if (!h) return base
        if (typeof h === 'object') return { ...base, ...h }
        for (const line of String(h).split('\n')) {
          const i = line.indexOf(':')
          if (i > 0) base[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim()
        }
        return base
      }
      const fire = async (headers) => {
        const started = Date.now()
        const res = await replayHttp({ method, url, headers, body, timeoutMs: 30000 })
        return { status: res.status, length: Buffer.byteLength(res.body, 'utf8'), ms: Date.now() - started, body: res.body.slice(0, 2000) }
      }
      let low; let high
      try { low = await fire(mk(args.headers_low)) } catch (e) { throwErr('E_VULN_REPLAY_FAILED', `低权请求失败: ${e?.message}`, '网络波动可重试', true) }
      try { high = await fire(mk(args.headers_high)) } catch (e) { throwErr('E_VULN_REPLAY_FAILED', `高权请求失败: ${e?.message}`, '网络波动可重试', true) }
      const jsonKeys = (b) => { try { return Object.keys(JSON.parse(b)).sort() } catch { return null } }
      const lowKeys = jsonKeys(low.body); const highKeys = jsonKeys(high.body)
      const keysOverlap = lowKeys && highKeys && lowKeys.length
        ? lowKeys.filter((k) => highKeys.includes(k)).length / Math.max(highKeys.length, 1) : 0
      const lenRatio = high.length ? low.length / high.length : 0
      let verdict = 'unlikely'
      let why = ''
      if (low.status === 401 || low.status === 403) { verdict = 'unlikely'; why = '低权请求被拒（401/403），鉴权正常' }
      else if (low.status !== high.status) { verdict = 'review'; why = `状态码不一致 low=${low.status} high=${high.status}，需人工看响应` }
      else if (low.status === 200 && (keysOverlap > 0.5 || (lenRatio > 0.5 && lenRatio < 2))) {
        verdict = 'suspected'
        why = `低权 200 且响应与高权高度相似（键重合 ${(keysOverlap * 100).toFixed(0)}%，长度比 ${lenRatio.toFixed(2)}）——疑似越权，人工核实数据归属`
      } else { why = `同状态但响应差异大（键重合 ${(keysOverlap * 100).toFixed(0)}%，长度比 ${lenRatio.toFixed(2)}）` }
      const data = {
        verdict, why,
        low: { status: low.status, length: low.length, ms: low.ms },
        high: { status: high.status, length: high.length, ms: high.ms },
        low_body_head: low.body.slice(0, 300), high_body_head: high.body.slice(0, 300),
      }
      if (verdict === 'suspected' && dispatchRef && typeof dispatchRef === 'function') {
        const r = await dispatchRef('vuln', 'register_candidate', {
          title: `疑似越权(IDOR): ${method} ${url}`,
          severity: 'high', host: hostOf(url), url,
          source: 'authz_diff',
          evidence: `low=${low.status}/${low.length}B high=${high.status}/${high.length}B keysOverlap=${(keysOverlap * 100).toFixed(0)}%`,
        }, { actor: 'script', identity: `authz_diff:${ctx.session_id || 'unknown'}`, session_id: ctx.session_id || null })
        if (r.ok && r.data?.id) data.candidate_id = r.data.id
      }
      return { data, events: [], target: url, before: null, after: null }
    },
  }

  const queries = {
    vuln_get: async (args, repo) => {
      const row = repo.getFinding(args.id)
      if (!row) throwErr('E_NOT_FOUND', `finding #${args.id} 不存在`, '先 vuln_list 核实 id', false)
      return row
    },
    vuln_list: async (args, repo) => {
      const rows = repo.listFindingsWhere({ visibility: args.visibility || 'signal', host: args.host || '', severity: args.severity || '', status: args.status || '', program_id: args.program_id || '', q: args.q || '' }, { sort: args.sort || 'created_at', dir: args.dir || 'desc' })
      return { rows, total: rows.length }
    },
    vuln_candidates: async (args, repo) => {
      const { rows, pool } = repo.listCandidatePool({ claim_state: args.claim_state || 'available', severity_min: args.severity_min || '', program_id: args.program_id || '', host: args.host || '' }, { sort: args.sort || 'severity', dir: args.dir || 'desc' })
      return { rows, total: rows.length, meta: { pool } }
    },
    vuln_stats: async (_args, repo) => {
      return repo.statsFindings()
    },
    vuln_by_asset: async (args, repo) => {
      const host = normalizeHost(args.host)
      const rows = repo.listFindingsWhere({ visibility: 'all', host }, { sort: 'severity', dir: 'desc' })
      const bySev = {}
      let candidatesTotal = 0
      for (const r of rows) {
        if (r.noise === 1 && r.status === 'new') { candidatesTotal++; if (!args.include_candidates) continue }
        const k = r.severity || 'info'
        bySev[k] = (bySev[k] || 0) + 1
      }
      return {
        host,
        total: Object.values(bySev).reduce((a, b) => a + b, 0),
        by_severity: Object.entries(bySev).map(([severity, n]) => ({ severity, n })),
        candidates_total: candidatesTotal,
      }
    },
    vuln_dedup_check: async (args, repo) => {
      const { rows, total } = repo.listDedup({ host: String(args.host || ''), vuln_type: String(args.vuln_type || ''), exclude_id: args.exclude_id || null }, args.limit || 10)
      return { rows, total, meta: { limit: args.limit || 10 } }
    },
  }

  const subscribers = {
    onParserProposal: async (envelope) => {
      const payload = envelope?.payload || {}
      const list = payload.parse_proposal?.findings
      if (!Array.isArray(list) || !dispatchRef) return { ok: true, data: { skipped: true } }
      let registered = 0
      let failed = 0
      for (const f of list) {
        const runId = String(payload.run_id || envelope?.cause?.run_id || '')
        const tool = String(payload.tool || 'nuclei')
        try {
          const r = await dispatchRef('vuln', 'register_candidate', {
            title: String(f.title || `${f.host || ''} 被动审计候选：${tool}`),
            severity: String(f.severity || 'info'),
            host: String(f.host || ''),
            url: String(f.url || ''),
            evidence: f.evidence || (runId ? `flow:flows/${runId}` : ''),
            source: `parser:${tool}`,
          }, { actor: 'script', identity: `parser:${tool}:${runId}`, session_id: payload.session_id || null })
          if (r.ok) registered++
          else failed++
        } catch { failed++ }
      }
      if (failed) return { ok: true, data: { registered, failed, partial: true } }
      return { ok: true, data: { registered } }
    },
  }

  return { ...commands, queries, invariants, subscribers }
}

// ---------------------------------------------------------------------------
// 组装（测试与 cordis 共用）：manifest + handlers + backend
// ---------------------------------------------------------------------------

export function buildVulnDomain(opts = {}) {
  const dataDir = opts.dataDir || DEFAULT_DATA_DIR
  const backend = createVulnSqliteBackend(opts.backendOptions || {})
  return {
    manifest: VULN_MANIFEST,
    handlers: makeHandlers({ ...opts, dataDir }),
    backend,
  }
}

export const vulnFingerprint = { fpWeak, fpStrong, normalizeHost, hostOf }
export const vulnUtils = {
  sha1, iso16, isoPrefix, refPrefix, EVIDENCE_TOKEN_RE, SEV_RANK, FINDING_STATUS, TERMINAL,
  parseRequestText, replayHttp, resolveProxy,
}

// ---------------------------------------------------------------------------
// cordis 插件入口：向总线 registry 注册（不 provide 任何业务方法）
// ---------------------------------------------------------------------------

export function apply(ctx, config = {}) {
  const dataDir = process.env.SEC_DATA_DIR || process.env.DSH_HOME || DEFAULT_DATA_DIR
  try {
    ctx.inject(['secDomainBus'], (child) => {
      const bus = child.secDomainBus
      const domain = buildVulnDomain({ dataDir, dispatch: (d, v, a, c) => bus.dispatch(d, v, a, c) })
      const res = bus.registry.register(domain)
      if (res.ok) {
        log(`vuln 域注册成功（registered=${res.registered}）`)
      } else {
        log(`vuln 域注册被拒：${res.error?.code} ${res.error?.message}`)
      }
      return () => { /* 域生命周期随宿主进程；不 provide 无需 dispose */ }
    })
  } catch (e) {
    log(`secDomainBus 注入失败：${e?.message}——vuln 域未注册（总线必须先行挂载）`)
  }
  return null
}
