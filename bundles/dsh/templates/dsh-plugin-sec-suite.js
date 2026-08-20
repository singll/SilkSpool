// ==============================================================================
// SilkSecAgent 安全套件（dsh 原生插件，零依赖）
//
// 包含两个层面（对应方案 §5.1 / §九）：
//   scope-guard     授权白名单硬校验（data/scope.yml）+ 风险四级 + 全量审计
//                   —— fail-closed：无授权记录的目标一律拒绝，不依赖模型自觉
//   sec-cli-adapter CLI 工具适配：run_cli / grep_result / page_result
//                   —— manifest 驱动（data/tools.d/*.yaml），模板渲染、超时控制、
//                      代理注入、全量落盘 results/<run_id>/、≤20 行摘要回模型
//
// 环境变量：
//   SEC_DATA_DIR        数据目录（默认 /opt/silkspool/dsh/data）
//   SEC_SCOPE_FILE      授权白名单路径（默认 $SEC_DATA_DIR/scope.yml）
//   SEC_EGRESS_PROXY    出口代理（manifest env_proxy: true 时注入）
// ==============================================================================

import { spawn } from 'node:child_process'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

export const name = 'sec-cli-adapter'
export const inject = ['tools']

const DATA_DIR = process.env.SEC_DATA_DIR || '/opt/silkspool/dsh/data'
const SCOPE_FILE = process.env.SEC_SCOPE_FILE || path.join(DATA_DIR, 'scope.yml')
const TOOLS_DIR = path.join(DATA_DIR, 'tools.d')
const RESULTS_DIR = path.join(DATA_DIR, 'results')
const AUDIT_LOG = path.join(DATA_DIR, 'audit.jsonl')
const EGRESS_PROXY = process.env.SEC_EGRESS_PROXY || ''

const RISK_ORDER = ['passive', 'active', 'intrusive', 'manual']

// ==============================================================================
// 极简 YAML 解析（仅覆盖 tools.d/scope.yml 用到的子集：
// 嵌套 map、标量 list、map list、行内 [a,b]、引号字符串、数字/布尔、注释）
// ==============================================================================

function parseYaml(text) {
  const lines = []
  for (const raw of String(text).split('\n')) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue
    const indent = raw.length - raw.trimStart().length
    lines.push({ indent, text: stripComment(raw.trim()) })
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
      if (!inner) return []
      return splitInline(inner).map(parseScalar)
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
        // list item 是 map：首个 key 就地解析，其余 key 在 indent+2 层级
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

// ==============================================================================
// scope-guard：授权白名单硬校验（fail-closed）
// ==============================================================================

function ipToInt(ip) {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  let n = 0
  for (const p of parts) {
    const v = Number(p)
    if (!Number.isInteger(v) || v < 0 || v > 255) return null
    n = n * 256 + v
  }
  return n
}

function cidrContains(cidr, ip) {
  const [base, bitsRaw] = cidr.split('/')
  const bits = Number(bitsRaw)
  const b = ipToInt(base); const t = ipToInt(ip)
  if (b === null || t === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false
  if (bits === 0) return true
  const mask = bits === 32 ? 0xffffffff : (0xffffffff << (32 - bits)) >>> 0
  return (b & mask) >>> 0 === (t & mask) >>> 0
}

function hostOf(raw) {
  let s = String(raw).trim()
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '') // 去 scheme
  s = s.split('/')[0].split('?')[0].split('#')[0]
  if (s.startsWith('[')) return s.slice(1, s.indexOf(']')) // IPv6 字面量
  if (s.includes(':') && /:\d+$/.test(s)) s = s.slice(0, s.lastIndexOf(':')) // 去端口
  return s.toLowerCase()
}

function entryMatches(entry, host) {
  entry = String(entry).trim().toLowerCase()
  if (!entry) return false
  if (entry.includes('/')) return ipToInt(host) !== null && cidrContains(entry, host)
  if (entry.startsWith('*.')) {
    const suffix = entry.slice(1) // ".example.com"
    return host === entry.slice(2) || host.endsWith(suffix)
  }
  return host === entry
}

let scopeCache = { mtime: 0, data: null }

function loadScope() {
  let stat
  try { stat = fs.statSync(SCOPE_FILE) } catch { return { programs: [], defaults: {} } }
  if (scopeCache.data && scopeCache.mtime === stat.mtimeMs) return scopeCache.data
  const data = parseYaml(fs.readFileSync(SCOPE_FILE, 'utf8'))
  scopeCache = { mtime: stat.mtimeMs, data }
  return data
}

// 返回 { allow, reason, program }
function checkTarget(rawTarget) {
  const host = hostOf(rawTarget)
  if (!host) return { allow: false, reason: `无法解析目标: ${rawTarget}` }
  const scope = loadScope()
  const programs = Array.isArray(scope.programs) ? scope.programs : []
  for (const p of programs) {
    const excludes = Array.isArray(p.exclude) ? p.exclude : []
    if (excludes.some((e) => entryMatches(e, host))) {
      return { allow: false, reason: `目标 ${host} 在项目 ${p.name} 的排除清单中`, program: p.name }
    }
    const entries = Array.isArray(p.scope) ? p.scope : []
    if (entries.some((e) => entryMatches(e, host))) {
      return { allow: true, reason: `命中项目 ${p.name} 授权范围`, program: p.name, programCfg: p }
    }
  }
  return { allow: false, reason: `目标 ${host} 不在任何授权项目范围内（scope.yml fail-closed）` }
}

function checkRisk(manifestRisk, programCfg) {
  const scope = loadScope()
  const allowRisk = (scope.defaults && scope.defaults.allow_risk) || ['passive', 'active']
  const maxRisk = (programCfg && programCfg.rules && programCfg.rules.max_risk) || null
  const effective = maxRisk || null
  if (manifestRisk === 'manual') return { allow: false, reason: 'risk=manual 工具默认禁用，需人工放行' }
  if (effective && RISK_ORDER.indexOf(manifestRisk) > RISK_ORDER.indexOf(effective)) {
    return { allow: false, reason: `工具风险级 ${manifestRisk} 超过项目上限 ${effective}` }
  }
  if (!allowRisk.includes(manifestRisk)) {
    return { allow: false, reason: `工具风险级 ${manifestRisk} 需要人工确认（allow_risk: ${allowRisk.join('/') }）`, needsApproval: true }
  }
  return { allow: true }
}

// ==============================================================================
// sec-cli-adapter：manifest 加载 / 模板渲染 / 执行 / 落盘 / 摘要
// ==============================================================================

function loadManifest(toolName) {
  const file = path.join(TOOLS_DIR, `${toolName}.yaml`)
  if (!fs.existsSync(file)) return null
  const m = parseYaml(fs.readFileSync(file, 'utf8'))
  m._file = file
  return m
}

function listManifests() {
  try {
    return fs.readdirSync(TOOLS_DIR).filter((f) => f.endsWith('.yaml')).map((f) => f.replace(/\.yaml$/, ''))
  } catch { return [] }
}

function renderTemplate(tpl, params, runDir, runId) {
  return String(tpl).replace(/\{\{\s*([a-zA-Z0-9_]+)(\|([^}]*))?\s*\}\}/g, (_m, key, _d, def) => {
    if (key === 'outdir') return runDir
    if (key === 'run_id') return runId
    const v = params[key]
    if (v === undefined || v === null || v === '') {
      if (def !== undefined) return def
      throw new Error(`缺少必填参数: ${key}`)
    }
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
    // 目标清单文件：逐行校验
    try {
      return fs.readFileSync(String(v), 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    } catch { return [`__unreadable_file__:${v}`] }
  }
  return String(v).split(',').map((s) => s.trim()).filter(Boolean)
}

function audit(record) {
  try {
    fs.mkdirSync(path.dirname(AUDIT_LOG), { recursive: true })
    fs.appendFileSync(AUDIT_LOG, JSON.stringify(record) + '\n')
  } catch { /* 审计写入失败不阻断（执行前已记录 decision） */ }
}

async function runCli(args) {
  const toolName = String(args.tool || '')
  const params = args.params || {}
  const manifest = loadManifest(toolName)
  if (!manifest) {
    return { ok: false, error: `工具 ${toolName} 无 manifest（data/tools.d/${toolName}.yaml 不存在）`, available: listManifests() }
  }

  const runId = 'r' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex')
  const runDir = path.join(RESULTS_DIR, runId)
  fs.mkdirSync(runDir, { recursive: true })

  // ---- scope-guard：目标硬校验 ----
  const targets = extractTargets(manifest, params)
  for (const t of targets) {
    const chk = checkTarget(t)
    audit({ ts: Date.now(), run_id: runId, tool: toolName, target: t, decision: chk.allow ? 'allow' : 'deny', reason: chk.reason })
    if (!chk.allow) return { ok: false, run_id: runId, error: `scope-guard 拒绝: ${chk.reason}` }
  }
  const firstChk = targets.length ? checkTarget(targets[0]) : { programCfg: null }
  const riskChk = checkRisk(String(manifest.risk || 'passive'), firstChk.programCfg)
  if (!riskChk.allow) {
    audit({ ts: Date.now(), run_id: runId, tool: toolName, decision: 'deny', reason: riskChk.reason })
    return { ok: false, run_id: runId, error: `scope-guard 拒绝: ${riskChk.reason}`, needs_approval: !!riskChk.needsApproval }
  }

  // ---- 渲染 + 执行 ----
  let argv
  try {
    argv = shellSplit(renderTemplate(String(manifest.args_template || ''), params, runDir, runId))
  } catch (e) {
    return { ok: false, run_id: runId, error: `参数渲染失败: ${e.message}` }
  }
  const binary = String(manifest.binary || toolName)
  const timeoutMs = Math.min(Number(manifest.timeout || 300), 3600) * 1000
  const env = { ...process.env }
  if (manifest.env_proxy && EGRESS_PROXY) {
    env.http_proxy = EGRESS_PROXY; env.https_proxy = EGRESS_PROXY
    env.HTTP_PROXY = EGRESS_PROXY; env.HTTPS_PROXY = EGRESS_PROXY
  }

  const started = Date.now()
  const result = await new Promise((resolve) => {
    let child
    try {
      child = spawn(binary, argv, { env, cwd: runDir })
    } catch (e) {
      resolve({ error: `启动失败: ${e.message}`, code: null, stdout: '', stderr: '' })
      return
    }
    const out = fs.createWriteStream(path.join(runDir, 'stdout.log'))
    const errBuf = []
    child.stdout.pipe(out)
    child.stderr.on('data', (d) => { errBuf.push(d); if (Buffer.concat(errBuf).length > 65536) errBuf.splice(0, errBuf.length - 1) })
    const killer = setTimeout(() => { child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 5000).unref() }, timeoutMs)
    child.on('error', (e) => { clearTimeout(killer); resolve({ error: String(e.message), code: null }) })
    child.on('close', (code, signal) => { clearTimeout(killer); resolve({ code, signal }) })
  })

  fs.writeFileSync(path.join(runDir, 'cmd.txt'), [binary, ...argv].join(' ') + '\n')
  const meta = {
    run_id: runId, tool: toolName, argv: [binary, ...argv], params,
    started_at: new Date(started).toISOString(), duration_ms: Date.now() - started,
    exit_code: result.code ?? null, signal: result.signal || null, error: result.error || null,
    risk: manifest.risk || 'passive', stage: manifest.stage || null,
  }
  fs.writeFileSync(path.join(runDir, 'meta.json'), JSON.stringify(meta, null, 1) + '\n')
  audit({ ts: Date.now(), run_id: runId, tool: toolName, decision: 'executed', exit_code: meta.exit_code, duration_ms: meta.duration_ms })

  // ---- 摘要（≤20 行）----
  let stdoutText = ''
  try { stdoutText = fs.readFileSync(path.join(runDir, 'stdout.log'), 'utf8') } catch { /* 无输出 */ }
  const lines = stdoutText.split('\n')
  const head = lines.slice(0, 20).join('\n')
  return {
    ok: result.code === 0,
    run_id: runId,
    exit_code: result.code ?? null,
    duration_ms: meta.duration_ms,
    total_lines: lines.length,
    summary: head,
    error: result.error || null,
    hint: lines.length > 20 ? `输出共 ${lines.length} 行，仅显示前 20 行；用 grep_result/page_result 按需取细节` : undefined,
  }
}

function resultFile(runId) {
  if (!/^r[a-z0-9]+$/.test(String(runId))) return null
  const f = path.join(RESULTS_DIR, runId, 'stdout.log')
  return fs.existsSync(f) ? f : null
}

function grepResult(args) {
  const f = resultFile(args.run_id)
  if (!f) return { ok: false, error: `run_id 不存在或无输出: ${args.run_id}` }
  let re
  try { re = new RegExp(String(args.pattern), 'i') } catch (e) { return { ok: false, error: `正则无效: ${e.message}` } }
  const max = Math.min(Number(args.max) || 50, 200)
  const matched = []
  const lines = fs.readFileSync(f, 'utf8').split('\n')
  for (let i = 0; i < lines.length && matched.length < max; i++) {
    if (re.test(lines[i])) matched.push(`${i + 1}: ${lines[i]}`)
  }
  return { ok: true, run_id: args.run_id, matched: matched.length, lines: matched.join('\n') }
}

function pageResult(args) {
  const f = resultFile(args.run_id)
  if (!f) return { ok: false, error: `run_id 不存在或无输出: ${args.run_id}` }
  const offset = Math.max(0, Number(args.offset) || 0)
  const limit = Math.min(Number(args.limit) || 50, 200)
  const lines = fs.readFileSync(f, 'utf8').split('\n')
  return {
    ok: true, run_id: args.run_id, total_lines: lines.length, offset, limit,
    lines: lines.slice(offset, offset + limit).join('\n'),
  }
}

// ==============================================================================
// 注册
// ==============================================================================

function renderJSON(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 1) }]
}

export function apply(ctx) {
  ctx.tools.register({
    name: 'run_cli',
    description: '运行已登记的安全 CLI 工具（manifest 驱动）。目标经 scope-guard 白名单硬校验，参数模板化渲染，'
      + '输出全量落盘 results/<run_id>/，只回 ≤20 行摘要。细节用 grep_result/page_result 按需取。',
    parameters: {
      type: 'object',
      properties: {
        tool: { type: 'string', description: '工具名（data/tools.d/<tool>.yaml）' },
        params: { type: 'object', description: '模板参数键值对，如 {"target": "example.com"}' },
      },
      required: ['tool', 'params'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object' }, render: renderJSON },
    execute: async (args) => runCli(args || {}),
  })

  ctx.tools.register({
    name: 'grep_result',
    description: '在指定 run_id 的完整输出中按正则检索（大小写不敏感），返回匹配行（含行号，最多 max 条）。',
    parameters: {
      type: 'object',
      properties: {
        run_id: { type: 'string' },
        pattern: { type: 'string', description: '正则表达式' },
        max: { type: 'integer', description: '最多返回条数，默认 50，上限 200' },
      },
      required: ['run_id', 'pattern'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object' }, render: renderJSON },
    execute: async (args) => grepResult(args || {}),
  })

  ctx.tools.register({
    name: 'page_result',
    description: '按行区间分页读取指定 run_id 的完整输出（offset 起始行，limit 行数，上限 200）。',
    parameters: {
      type: 'object',
      properties: {
        run_id: { type: 'string' },
        offset: { type: 'integer', description: '起始行（0 基），默认 0' },
        limit: { type: 'integer', description: '行数，默认 50，上限 200' },
      },
      required: ['run_id'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object' }, render: renderJSON },
    execute: async (args) => pageResult(args || {}),
  })
}
