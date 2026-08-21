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
import * as http from 'node:http'
import * as path from 'node:path'
import * as assetDb from './asset-db.js'
import * as parsers from './parsers.js'

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

// 内网目标判定（代理池仅供出公网；内网目标注入公网代理必然失败）
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

// P6：scope.yml 程序 → programs 表运行态镜像（幂等，启动时调用）
function syncPrograms() {
  const scope = loadScope()
  const programs = Array.isArray(scope.programs) ? scope.programs : []
  for (const p of programs) {
    if (!p.name) continue
    assetDb.upsertProgram({
      id: p.name,
      platform: p.platform || '',
      max_risk: (p.rules && p.rules.max_risk) || null,
    })
  }
  return programs.map((p) => p.name)
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
  const programId = firstChk.program || null
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
  // 代理注入仅对公网目标生效；内网/环回目标直连（公网代理到不了内网）
  const allInternal = targets.length > 0 && targets.every((t) => isInternalHost(hostOf(t)))
  if (manifest.env_proxy && EGRESS_PROXY && !allInternal) {
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

  // ---- 自动入资产图谱（manifest store: asset-graph 且执行成功；parser 注册表路由；自动回填 program_id）----
  let ingested = null
  if (manifest.store === 'asset-graph' && result.code === 0 && stdoutText) {
    try {
      ingested = parsers.applyParsedResult(manifest, toolName, runId, stdoutText, programId)
    } catch { /* 入库失败不影响主流程 */ }
  }

  const lines = stdoutText.split('\n')
  const head = lines.slice(0, 20).join('\n')
  const out = {
    ok: result.code === 0,
    run_id: runId,
    exit_code: result.code ?? null,
    duration_ms: meta.duration_ms,
    total_lines: lines.length,
    summary: head,
    error: result.error || null,
  }
  // 无损 JSON 纪律：条件字段只在有值时才设置（undefined 键会破坏 round-trip 校验）
  if (ingested) out.ingested = ingested
  if (lines.length > 20) out.hint = `输出共 ${lines.length} 行，仅显示前 20 行；用 grep_result/page_result 按需取`
  return out
}

function resultFile(runId) {
  if (!/^r[a-z0-9]+$/.test(String(runId))) return null
  const f = path.join(RESULTS_DIR, runId, 'stdout.log')
  return fs.existsSync(f) ? f : null
}

function grepResult(args) {
  // 搜索范围：run 目录下全部文本产物（stdout.log + 工具 -o 落盘文件），不只是 stdout
  const dir = /^r[a-z0-9]+$/.test(String(args.run_id)) ? path.join(RESULTS_DIR, args.run_id) : null
  if (!dir || !fs.existsSync(dir)) return { ok: false, error: `run_id 不存在: ${args.run_id}` }
  let re
  try { re = new RegExp(String(args.pattern), 'i') } catch (e) { return { ok: false, error: `正则无效: ${e.message}` } }
  const max = Math.min(Number(args.max) || 50, 200)
  const matched = []
  const files = []
  const walk = (d) => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, f.name)
      if (f.isDirectory()) walk(p)
      else if (!/\.(png|jpg|jpeg|gif|zip|gz|zstd|bin)$/i.test(f.name)) files.push(p)
    }
  }
  walk(dir)
  for (const f of files) {
    let lines
    try { lines = fs.readFileSync(f, 'utf8').split('\n') } catch { continue }
    const rel = path.relative(dir, f)
    for (let i = 0; i < lines.length && matched.length < max; i++) {
      if (re.test(lines[i])) matched.push(`${rel}:${i + 1}: ${lines[i].slice(0, 500)}`)
    }
    if (matched.length >= max) break
  }
  return { ok: true, run_id: args.run_id, files_searched: files.length, matched: matched.length, lines: matched.join('\n') }
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
// burp-ingest：Burp Suite 导出 XML 导入（proxy history items / scanner issues）
// ==============================================================================

function xmlTag(block, tag) {
  const m = block.match(new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${tag}>`))
  return m ? m[1].trim() : ''
}

function burpImport(args) {
  const file = String(args.file || '')
  if (!file || !fs.existsSync(file)) return { ok: false, error: `文件不存在: ${file}` }
  const text = fs.readFileSync(file, 'utf8')
  const importId = 'burp-' + Date.now().toString(36)
  const outDir = path.join(DATA_DIR, 'imports')
  fs.mkdirSync(outDir, { recursive: true })

  const isIssues = /<issues>/.test(text)
  const blocks = text.match(/<(item|issue)>[\s\S]*?<\/\1>/g) || []
  const outFile = path.join(outDir, `${importId}.jsonl`)
  const out = fs.createWriteStream(outFile)
  const hosts = new Set()
  let count = 0

  if (isIssues) {
    for (const b of blocks) {
      const name = xmlTag(b, 'name')
      const host = hostOf(xmlTag(b, 'host'))
      const rec = {
        type: 'issue', name, host,
        path: xmlTag(b, 'path'), severity: xmlTag(b, 'severity'),
        confidence: xmlTag(b, 'confidence'),
      }
      if (host) hosts.add(host)
      out.write(JSON.stringify(rec) + '\n'); count++
    }
  } else {
    for (const b of blocks) {
      const url = xmlTag(b, 'url')
      const host = hostOf(xmlTag(b, 'host') || url)
      const rec = {
        type: 'item', host, url,
        method: xmlTag(b, 'method'), status: xmlTag(b, 'status'),
        mimetype: xmlTag(b, 'mimetype'),
      }
      if (host) hosts.add(host)
      out.write(JSON.stringify(rec) + '\n'); count++
    }
  }
  out.end()
  audit({ ts: Date.now(), run_id: importId, tool: 'burp_import', decision: 'executed', detail: `${count} records from ${path.basename(file)}` })
  return {
    ok: true, import_id: importId, kind: isIssues ? 'scanner issues' : 'proxy history',
    records: count, hosts: [...hosts].slice(0, 20), output: outFile,
    hint: '完整数据已落盘 JSONL；接入 asset-graph（P3）后自动入图谱',
  }
}

// ==============================================================================
// authz_diff：越权对比 harness（双会话重放 + 响应 diff）
// 低权会话拿到与高权会话相当的数据 = 疑似越权
// ==============================================================================

async function authzDiff(args) {
  const url = String(args.url || '')
  if (!url) return { ok: false, error: 'url 不能为空' }
  // scope-guard 硬校验（与其他工具同一标准）
  const chk = checkTarget(url)
  audit({ ts: Date.now(), run_id: '-', tool: 'authz_diff', target: url, decision: chk.allow ? 'allow' : 'deny', reason: chk.reason })
  if (!chk.allow) return { ok: false, error: `scope-guard 拒绝: ${chk.reason}` }

  const method = String(args.method || 'GET').toUpperCase()
  const body = args.body ? String(args.body) : undefined
  const mk = (h) => {
    const base = { 'content-type': 'application/json', 'user-agent': 'SilkSecAgent-authz-diff' }
    if (!h) return base
    if (typeof h === 'object') return { ...base, ...h }
    // 字符串形式: "Cookie: a=1\nX-Role: low"
    for (const line of String(h).split('\n')) {
      const i = line.indexOf(':')
      if (i > 0) base[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim()
    }
    return base
  }
  const fire = async (headers) => {
    const started = Date.now()
    const res = await fetch(url, { method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(30000) })
    const text = await res.text()
    return { status: res.status, length: text.length, ms: Date.now() - started, body: text.slice(0, 2000) }
  }

  let low; let high
  try { low = await fire(mk(args.headers_low)) } catch (e) { return { ok: false, error: `低权请求失败: ${e.message}` } }
  try { high = await fire(mk(args.headers_high)) } catch (e) { return { ok: false, error: `高权请求失败: ${e.message}` } }

  const jsonKeys = (b) => {
    try { return Object.keys(JSON.parse(b)).sort() } catch { return null }
  }
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

  if (verdict === 'suspected') {
    assetDb.addFinding({
      title: `疑似越权(IDOR): ${method} ${url}`, severity: 'high',
      host: hostOf(url), url, source: 'authz_diff',
      evidence: `low=${low.status}/${low.length}B high=${high.status}/${high.length}B keysOverlap=${(keysOverlap * 100).toFixed(0)}%`,
    })
  }
  return {
    ok: true, verdict, why,
    low: { status: low.status, length: low.length, ms: low.ms },
    high: { status: high.status, length: high.length, ms: high.ms },
    low_body_head: low.body.slice(0, 300), high_body_head: high.body.slice(0, 300),
  }
}

// ==============================================================================
// xray webhook 接收器（流量总线 v1：xray 被动审计发现 → JSONL + findings 入库）
// ==============================================================================

const FLOWS_DIR = path.join(DATA_DIR, 'flows')
let webhookServer = null

function startXrayWebhook(ctx) {
  if (webhookServer) return
  fs.mkdirSync(FLOWS_DIR, { recursive: true })
  webhookServer = http.createServer((req, res) => {
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
    let body = ''
    req.on('data', (c) => { body += c; if (body.length > 1048576) req.destroy() })
    req.on('end', () => {
      try {
        const finding = JSON.parse(body)
        const file = path.join(FLOWS_DIR, `xray-${new Date().toISOString().slice(0, 10)}.jsonl`)
        fs.appendFileSync(file, body + '\n')
        // xray webhook 结构: {type:"web_vuln", data:{title, target, plugin...}}（v2 字段容忍性解析）
        const d = finding.data || finding
        const target = d.target || d.url || ''
        const title = d.title || d.plugin || finding.type || 'xray finding'
        assetDb.addFinding({
          title: `xray: ${title}`, severity: 'medium', host: hostOf(target), url: target,
          source: 'xray-webhook', evidence: `flow:${file}`,
        })
        res.writeHead(200); res.end('ok')
      } catch { res.writeHead(400); res.end('bad json') }
    })
  })
  webhookServer.on('error', (e) => {
    // 端口已被占用（如测试副本在跑）时降级为不起服务，不影响插件加载
    process.stderr.write(`[sec-suite] xray webhook 启动失败: ${e.message}\n`)
    webhookServer = null
  })
  webhookServer.listen(7788, '127.0.0.1')
  ctx?.on?.('dispose', () => webhookServer?.close())
}

// ==============================================================================
// spawn_worker：隔离执行的无头 worker（批任务不污染主会话上下文）
// 复用 DSH 内建 headless profile：子进程跑完只回尾部摘要，全文落盘
// ==============================================================================

const DSH_BIN = process.env.SEC_DSH_BIN
  || '/opt/silkspool/dsh/app/node_modules/@deepseek-ai/dsh/lib/bin.js'
const NODE_BIN = process.env.SEC_NODE_BIN || '/usr/local/node/bin/node'
const MAX_WORKERS = 4
let activeWorkers = 0

async function spawnWorker(args) {
  const task = String(args.task || '').trim()
  if (!task) return { ok: false, error: 'task 不能为空' }
  if (activeWorkers >= MAX_WORKERS) {
    return { ok: false, error: `worker 并发上限 ${MAX_WORKERS}，请稍后重试` }
  }
  const timeoutMs = Math.min(Number(args.timeout) || 900, 3600) * 1000
  const runId = 'w' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex')
  const runDir = path.join(RESULTS_DIR, runId)
  fs.mkdirSync(runDir, { recursive: true })

  const env = { ...process.env, DSH_HOME: DATA_DIR, PATH: '/usr/local/node/bin:' + (process.env.PATH || '') }
  audit({ ts: Date.now(), run_id: runId, tool: 'spawn_worker', decision: 'executed', detail: task.slice(0, 200) })

  activeWorkers++
  const started = Date.now()
  const result = await new Promise((resolve) => {
    const out = fs.createWriteStream(path.join(runDir, 'worker.log'))
    const child = spawn(NODE_BIN, [DSH_BIN, '--profile', 'headless', task], {
      env, cwd: runDir,
    })
    child.stdout.pipe(out)
    child.stderr.pipe(out)
    const killer = setTimeout(() => { child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 5000).unref() }, timeoutMs)
    child.on('error', (e) => { clearTimeout(killer); resolve({ code: null, error: String(e.message) }) })
    child.on('close', (code, signal) => { clearTimeout(killer); resolve({ code, signal }) })
  })
  activeWorkers--

  const meta = {
    run_id: runId, tool: 'spawn_worker', task, started_at: new Date(started).toISOString(),
    duration_ms: Date.now() - started, exit_code: result.code ?? null,
  }
  fs.writeFileSync(path.join(runDir, 'meta.json'), JSON.stringify(meta, null, 1) + '\n')

  let logText = ''
  try { logText = fs.readFileSync(path.join(runDir, 'worker.log'), 'utf8') } catch { /* 无输出 */ }
  const lines = logText.split('\n').filter(Boolean)
  return {
    ok: result.code === 0,
    run_id: runId,
    exit_code: result.code ?? null,
    duration_ms: meta.duration_ms,
    log_lines: lines.length,
    tail: lines.slice(-20).join('\n'),
    hint: `完整日志 ${lines.length} 行已落盘，用 grep_result/page_result 取 ${runId} 的细节`,
  }
}

// ==============================================================================
// plan_chain：能力原语凑链（BFS 前提-产出图搜索，manifest requires/produces）
// ==============================================================================

function planChain(args) {
  const have = Array.isArray(args.have) ? args.have.map(String) : []
  const want = String(args.want || '').trim()
  if (!want) return { ok: false, error: 'want 不能为空（如 findings / live_hosts / subdomains）' }

  const manifests = {}
  for (const name of listManifests()) {
    const m = loadManifest(name)
    if (m && Array.isArray(m.requires) && Array.isArray(m.produces)) manifests[name] = m
  }

  const available = new Set(have)
  const chain = []
  const used = new Set()
  let progress = true
  while (!available.has(want) && progress) {
    progress = false
    for (const [name, m] of Object.entries(manifests)) {
      if (used.has(name)) continue
      if (m.requires.every((r) => available.has(r))) {
        for (const p of m.produces) available.add(p)
        chain.push(name)
        used.add(name)
        progress = true
        break
      }
    }
  }
  if (!available.has(want)) {
    return { ok: false, have: [...have], available: [...available], error: `无法凑链到 ${want}（缺前置能力）` }
  }
  return { ok: true, have, want, chain, available: [...available] }
}

// ==============================================================================
// 注册
// ==============================================================================

function renderJSON(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 1) }]
}

export function apply(ctx, config) {
  // P6：启动时把 scope.yml 程序镜像到 programs 表（幂等）
  try { syncPrograms() } catch { /* 镜像失败不影响插件加载 */ }

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
    timeoutMs: 3670000,
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

  ctx.tools.register({
    name: 'burp_import',
    description: '导入 Burp Suite 导出文件（XML：proxy history 或 scanner issues），结构化落盘 data/imports/ 并回摘要。'
      + '人工在 Burp 里测试后导出 XML，用本工具回流系统沉淀资产与发现。',
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Burp 导出的 XML 文件路径（本机绝对路径）' },
      },
      required: ['file'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object' }, render: renderJSON },
    timeoutMs: 180000,
    execute: async (args) => burpImport(args || {}),
  })

  ctx.tools.register({
    name: 'spawn_worker',
    description: '派一个隔离的无头 worker 执行自包含任务（批量复扫、大日志蒸馏等），worker 上下文独立，'
      + '跑完只回尾部摘要，全文落盘 results/<run_id>/worker.log。批任务用它，不要在主会话直接跑大输出工具。',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: '自包含的任务描述（worker 看不到本会话上下文，目标/范围/产出要求要写全）' },
        timeout: { type: 'integer', description: '超时秒数，默认 900，上限 3600' },
      },
      required: ['task'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object' }, render: renderJSON },
    timeoutMs: 3670000,
    execute: async (args) => spawnWorker(args || {}),
  })

  ctx.tools.register({
    name: 'authz_diff',
    description: '越权对比测试：同一请求分别用低权/高权会话头发送，对比响应判定疑似越权。'
      + 'headers_low/headers_high 传 Cookie/Token 等鉴权头（对象或 "Key: Value\\n" 字符串）。目标经 scope-guard 校验。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        method: { type: 'string', description: '默认 GET' },
        body: { type: 'string' },
        headers_low: { type: ['object', 'string'], description: '低权会话头' },
        headers_high: { type: ['object', 'string'], description: '高权会话头' },
      },
      required: ['url'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object' }, render: renderJSON },
    timeoutMs: 90000,
    execute: async (args) => authzDiff(args || {}),
  })

  ctx.tools.register({
    name: 'plan_chain',
    description: '能力原语凑链：给定已拥有的能力（have）与想要的能力（want），'
      + '按 manifest 的 requires/produces 做 BFS 图搜索，返回有序工具链。'
      + '侦察阶段免手工记工具顺序。',
    parameters: {
      type: 'object',
      properties: {
        have: { type: 'array', items: { type: 'string' }, description: '已拥有的能力，如 ["company_name"]' },
        want: { type: 'string', description: '想要的能力，如 findings / live_hosts / subdomains' },
      },
      required: ['want'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object' }, render: renderJSON },
    execute: async (args) => planChain(args || {}),
  })

  // xray webhook 接收器随插件启动（流量总线 v1）；preset 内挂载时 sidecars:false 跳过
  if (!config || config.sidecars !== false) startXrayWebhook(ctx)
}
