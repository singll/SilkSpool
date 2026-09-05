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
import * as dns from 'node:dns'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as path from 'node:path'
import * as assetDb from './asset-db.js'
import * as parsers from './parsers.js'
import * as exp from './experience.js'
import { startXrayWebhook } from './webhook.js'
import { startScheduler } from './scheduler.js'
import { initDashboardRpc, planChain, taskChain, handleDashboardRpc } from './dashboard-rpc.js'

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

// ==============================================================================
// 主动扫描全局限速执行点（v4.6 修复：scope.defaults.rate_limit_qps 此前只是声明值，
// 无任何代码读它——「限速 50 QPS 机器强制」实为不成立）。
// 语义：active+ 级工具的 run_cli 启动节流（进程级全局令牌桶，跨会话/worker 共享，
// 重启清零无妨）。单次 CLI 运行内部的请求速率由工具自身 flag 控制（tools.d 各自的
// rate/limit 参数），引擎保证的是「引擎级主动扫描启动速率」不超声明值；批量临时升速
// 走 T-16 scan-burst 审批设计（批准写 defaults.rate_limit_qps 即时生效——loadScope 按
// mtime 缓存，改文件自动重读）。
// ==============================================================================
const qpsBucket = { tokens: Infinity, cap: 50, last: 0 }
function acquireQpsToken() {
  const qps = Math.max(1, Number(loadScope().defaults?.rate_limit_qps) || 50)
  const now = Date.now()
  if (!qpsBucket.last) { qpsBucket.last = now; qpsBucket.cap = qps }
  // qps 变更时桶容量随之调整（scan-burst 批准后放大）
  if (qpsBucket.cap !== qps) qpsBucket.cap = qps
  qpsBucket.tokens = Math.min(qpsBucket.cap, qpsBucket.tokens + ((now - qpsBucket.last) / 1000) * qps)
  qpsBucket.last = now
  if (qpsBucket.tokens >= 1) { qpsBucket.tokens -= 1; return 0 }
  const waitMs = Math.ceil(((1 - qpsBucket.tokens) / qps) * 1000)
  qpsBucket.tokens = 0
  return waitMs
}
async function throttleQps(toolName) {
  let waited = 0
  for (;;) {
    const w = acquireQpsToken()
    if (w <= 0) break
    waited += w
    if (waited > 100) process.stderr.write(`[sec-suite] QPS 限速：${toolName} 等待 ${waited}ms（rate_limit_qps 节流）\n`)
    await new Promise((r) => setTimeout(r, w))
  }
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
  pairWorkspaces(programs)
  return programs.map((p) => p.name)
}

// ==============================================================================
// P11 工作区融合：program ↔ DSH workspace 1:1 软绑定
// 绑定优先级：scope.yml rules.workspace（标题或路径，显式声明）> 标题/路径精确匹配。
// registry 不可用时（headless profile 无 dsh-workspace）静默跳过。
// ==============================================================================

let workspaceRegistryRef = null  // ctx.workspaceRegistry（web profile 宿主面）
let sessionPersistenceRef = null // ctx.sessionPersistence（会话头部投影，sessions RPC 用）

// dashboard-rpc.js 依赖注入（与 startScheduler/startXrayWebhook 同一参数注入模式，避免循环依赖）。
// 函数声明提升保证此处引用安全；workspaceRegistryRef 经 getter 惰性读取（fiber 注入前为 null）。
initDashboardRpc({
  dataDir: DATA_DIR, audit, tailAudit, assetDb, exp,
  listManifests, loadManifest, resolveProgramId, sessionIdOf,
  pairWorkspaces, workspacesList, sessionsList,
  scopeList, scopeSaveProgram, scopeDeleteProgram,
  approvalDecideAction,
  getWorkspaceRegistry: () => workspaceRegistryRef,
})

function pairWorkspaces(scopePrograms) {
  if (!workspaceRegistryRef) return
  const programs = scopePrograms || (loadScope().programs || [])
  let workspaces
  try { workspaces = workspaceRegistryRef.list() } catch { return }
  for (const p of programs) {
    if (!p.name) continue
    const declared = p.rules && p.rules.workspace ? String(p.rules.workspace).trim() : ''
    let hit = null
    if (declared) hit = workspaces.find((w) => w.title === declared || w.path === declared) || null
    if (!hit) hit = workspaces.find((w) => w.title.toLowerCase() === String(p.name).toLowerCase()) || null
    if (hit) {
      try { assetDb.bindProgramWorkspace(p.name, String(hit.id), hit.path) } catch { /* 绑定失败不阻断 */ }
    }
  }
}

// ==============================================================================
// P11 scope 管理（看板授权界面）：解析 → 变更 → 规范化重写 scope.yml（原子 + 备份 + 审计）
// ==============================================================================

function yamlQuote(s) { return JSON.stringify(String(s)) }

function serializeScope(scope) {
  const d = scope.defaults || {}
  const lines = [
    '# ==============================================================================',
    '# SilkSecAgent 授权白名单（scope-guard 硬校验，不依赖模型自觉）',
    '# 由看板「授权」视图或手工编辑维护；每次界面写入自动备份 scope.yml.bak 并记 audit.jsonl',
    '# ==============================================================================',
    '',
    'version: 1',
    '',
    '# 全局默认策略',
    'defaults:',
  ]
  const egress = d.egress_proxy || 'http://127.0.0.1:8899'
  lines.push(`  egress_proxy: ${egress}   # 出口统一走 mubeng 轮换网关`)
  lines.push(`  rate_limit_qps: ${Number(d.rate_limit_qps) || 50}                     # 主动扫描全局限速`)
  const allowRisk = Array.isArray(d.allow_risk) && d.allow_risk.length ? d.allow_risk : ['passive', 'active']
  lines.push(`  allow_risk: [${allowRisk.join(', ')}]          # 默认可自动执行的风险级；intrusive 需人工确认；manual 禁用`)
  lines.push('', '# SRC 项目清单')
  const programs = Array.isArray(scope.programs) ? scope.programs : []
  if (!programs.length) lines.push('programs: []')
  else {
    lines.push('programs:')
    for (const p of programs) {
      lines.push(`  - name: ${yamlQuote(p.name)}`)
      if (p.platform) lines.push(`    platform: ${yamlQuote(p.platform)}`)
      lines.push('    scope:')
      for (const e of p.scope || []) lines.push(`      - ${yamlQuote(e)}`)
      if (Array.isArray(p.exclude) && p.exclude.length) {
        lines.push('    exclude:')
        for (const e of p.exclude) lines.push(`      - ${yamlQuote(e)}`)
      }
      const rules = p.rules || {}
      lines.push('    rules:')
      lines.push(`      max_risk: ${rules.max_risk || 'active'}`)
      lines.push(`      fixed_egress_ip: ${rules.fixed_egress_ip ? 'true' : 'false'}`)
      if (rules.workspace) lines.push(`      workspace: ${yamlQuote(rules.workspace)}   # 绑定的 DSH 工作区（标题或路径）`)
      if (Array.isArray(rules.allow_intrusive_tools) && rules.allow_intrusive_tools.length) {
        lines.push('      allow_intrusive_tools:')
        for (const t of rules.allow_intrusive_tools) lines.push(`        - ${yamlQuote(t)}`)
      }
      if (p.finding_db) lines.push(`    finding_db: ${yamlQuote(p.finding_db)}`)
      lines.push('')
    }
  }
  lines.push('# 黑板/凭据（由系统运行时写入，勿手工编辑）', 'runtime:', '  credentials_ref: env                  # 凭据统一走 credentials 包 / .env 引用', '')
  return lines.join('\n')
}

const PROGRAM_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/
const RISK_LEVELS = ['passive', 'active', 'intrusive']

// spec: { name, platform, scope[], exclude[], max_risk, fixed_egress_ip, workspace, finding_db, allow_intrusive_tools[] }
// 返回 { ok, error?, program }。fail-closed 语义不变：不在 scope.yml 的目标依然全拒绝。
function scopeSaveProgram(spec, isNew) {
  const name = String(spec.name || '').trim()
  if (!PROGRAM_NAME_RE.test(name)) return { ok: false, error: `非法项目名 ${name}（^[a-z0-9][a-z0-9-]{0,62}$）` }
  const scopeEntries = [...new Set((Array.isArray(spec.scope) ? spec.scope : []).map((s) => String(s).trim()).filter(Boolean))]
  if (!scopeEntries.length) return { ok: false, error: 'scope 至少一条授权条目（域名/IP/CIDR）' }
  const excludeEntries = [...new Set((Array.isArray(spec.exclude) ? spec.exclude : []).map((s) => String(s).trim()).filter(Boolean))]
  const maxRisk = String(spec.max_risk || 'active')
  if (!RISK_LEVELS.includes(maxRisk)) return { ok: false, error: `非法 max_risk ${maxRisk}（可选: ${RISK_LEVELS.join('/')}）` }
  const allowIntrusive = [...new Set((Array.isArray(spec.allow_intrusive_tools) ? spec.allow_intrusive_tools : []).map((s) => String(s).trim()).filter(Boolean))]

  const scope = loadScope()
  const programs = Array.isArray(scope.programs) ? scope.programs : []
  const idx = programs.findIndex((p) => p && p.name === name)
  if (isNew && idx >= 0) return { ok: false, error: `项目 ${name} 已存在` }
  const entry = {
    name,
    scope: scopeEntries,
    rules: {
      max_risk: maxRisk,
      fixed_egress_ip: !!spec.fixed_egress_ip,
      ...(spec.workspace ? { workspace: String(spec.workspace).trim() } : {}),
      ...(allowIntrusive.length ? { allow_intrusive_tools: allowIntrusive } : {}),
    },
  }
  if (spec.platform) entry.platform = String(spec.platform).trim()
  if (excludeEntries.length) entry.exclude = excludeEntries
  if (spec.finding_db) entry.finding_db = String(spec.finding_db).trim()
  if (idx >= 0) programs[idx] = entry
  else programs.push(entry)
  scope.programs = programs

  // 原子写 + 备份（首次创建时 scope.yml 可能不存在，跳过备份）
  if (fs.existsSync(SCOPE_FILE)) fs.copyFileSync(SCOPE_FILE, SCOPE_FILE + '.bak')
  const tmp = SCOPE_FILE + '.tmp'
  fs.writeFileSync(tmp, serializeScope(scope))
  fs.renameSync(tmp, SCOPE_FILE)
  audit({ ts: Date.now(), run_id: '-', tool: 'dashboard.scopeSaveProgram', decision: 'executed', detail: { name, entries: scopeEntries.length, max_risk: maxRisk, isNew: !!isNew } })
  syncPrograms()
  return { ok: true, name }
}

function scopeDeleteProgram(name) {
  name = String(name || '').trim()
  const scope = loadScope()
  const programs = Array.isArray(scope.programs) ? scope.programs : []
  const idx = programs.findIndex((p) => p && p.name === name)
  if (idx < 0) return { ok: false, error: `项目 ${name} 不在 scope.yml` }
  programs.splice(idx, 1)
  scope.programs = programs
  // 原子写 + 备份（首次创建时 scope.yml 可能不存在，跳过备份）
  if (fs.existsSync(SCOPE_FILE)) fs.copyFileSync(SCOPE_FILE, SCOPE_FILE + '.bak')
  const tmp = SCOPE_FILE + '.tmp'
  fs.writeFileSync(tmp, serializeScope(scope))
  fs.renameSync(tmp, SCOPE_FILE)
  audit({ ts: Date.now(), run_id: '-', tool: 'dashboard.scopeDeleteProgram', decision: 'executed', detail: { name } })
  // 删除授权 ≠ 删数据：programs 行归档，资产/漏洞归属保留
  assetDb.archiveProgram(name)
  return { ok: true, name, hint: '已从 scope.yml 移除（fail-closed 立即生效），programs 表归档保留归属' }
}

function scopeList() {
  const scope = loadScope()
  const programs = (Array.isArray(scope.programs) ? scope.programs : []).map((p) => ({
    name: p.name,
    platform: p.platform || '',
    scope: Array.isArray(p.scope) ? p.scope : [],
    exclude: Array.isArray(p.exclude) ? p.exclude : [],
    max_risk: (p.rules && p.rules.max_risk) || 'active',
    fixed_egress_ip: !!(p.rules && p.rules.fixed_egress_ip),
    workspace: (p.rules && p.rules.workspace) || '',
    finding_db: p.finding_db || '',
  }))
  const dbPrograms = {}
  for (const p of assetDb.listPrograms()) dbPrograms[p.id] = p
  return {
    defaults: scope.defaults || {},
    programs: programs.map((p) => ({ ...p, db: dbPrograms[p.name] || null })),
    archived: assetDb.listPrograms().filter((p) => p.status === 'archived' && !programs.some((s) => s.name === p.id)),
  }
}

// ==============================================================================
// v4.3：统一审批中心（agent 提请 → 看板审批 tab 决策）
// kind 注册表：每种审批类型一个条目（label + validate 提请校验 + onApprove 批准副作用）。
// 新增审批类型只需在此注册，工具面/rpc/看板零改动。
// ==============================================================================

// P20' 股权闸判据枚举（口径见 data/rules/src/equity-gate.md：100% 控股算、参股/投资不算、
// 有自身 SRC 渠道的不并入——H-004 zhaopin.com 教训字段化）
const EQUITY_BASIS = ['控股/全资', '收购/财团', '品牌/产品线', '技术印证', '其他']
const INDEPENDENT_SRC = ['无', '有', '不确定']

// P19' 批准 → 种子入队：新授权域名当天启动首轮资产收集。双通道（once 种子任务 5 分钟后由
// scheduler 派发 + radar 事件供每日 recon 链 radar_read 兜底）。best-effort：入队失败不影响批准结果。
function enqueueScopeSeed(host, programName) {
  const notes = []
  try {
    const dir = path.join(DATA_DIR, 'pipeline', programName)
    fs.mkdirSync(dir, { recursive: true })
    fs.appendFileSync(path.join(dir, 'radar-queue.jsonl'),
      JSON.stringify({ ts: new Date().toISOString(), type: 'scope-approved', domain: host, source: 'approval' }) + '\n')
    notes.push('radar 事件已入队')
  } catch (e) { notes.push(`radar 入队失败: ${e.message}`) }
  try {
    const objective = `[审批入队] 新授权域名 ${host} 首轮资产面收集：radar_read 读入 scope-approved 事件 → subfinder 子域枚举 → dnsx 解析 → httpx 存活+指纹入图谱（store:asset-graph）。只做资产收集，禁止主动漏洞探测。完成后 attempts_log 落台账（asset=${host}，card_id=- 非卡片动作，N/A 须理由）。`
    const dup = assetDb.taskList({ programId: programName, q: host, bucket: 'active', limit: 10 })
      .filter((t) => (t.objective || '').includes('[审批入队]'))
    if (dup.length) notes.push('种子任务已存在（幂等跳过）')
    else {
      const r = assetDb.taskCreate({
        program_id: programName, phase: 'recon', objective, priority: 1,
        schedule: { kind: 'once', at: Date.now() + 5 * 60 * 1000 },
      })
      if (r.ok) notes.push(`种子任务 #${r.id} 已入队（5 分钟后派发）`)
      else notes.push(`种子任务入队失败: ${r.error}`)
    }
  } catch (e) { notes.push(`种子任务入队异常: ${e.message}`) }
  return notes
}

const APPROVAL_KINDS = {
  'scope-domain': {
    label: '授权域名',
    // 提请校验：建议项目须存在；域名不得已在 scope（已授权无须审批）；排除清单走 exclude-exception。
    // P20' 股权判据结构化：equity_basis（归属判据类型）+ independent_src（目标有无自身 SRC 渠道）必填，
    // corroboration（旁证）选填——判据口径见 data/rules/src/equity-gate.md。
    validate({ subject, program_name, payload, evidence }) {
      const host = hostOf(subject)
      if (!host) return { ok: false, error: `无法解析域名: ${subject}` }
      const scope = loadScope()
      const programs = Array.isArray(scope.programs) ? scope.programs : []
      const prog = programs.find((p) => p && p.name === program_name)
      if (!prog) {
        return { ok: false, error: `项目 ${program_name} 不在 scope.yml（先确认归属项目名；scopeList 可查）`, programs: programs.map((p) => p.name) }
      }
      const chk = checkTarget(host)
      if (chk.allow) return { ok: false, error: `${host} 已在项目 ${chk.program} 授权范围内，无须审批` }
      if (chk.program && /排除清单/.test(chk.reason)) return { ok: false, error: `${host} 在项目 ${chk.program} 排除清单中——请改提 exclude-exception（排除例外评估）` }
      // 通配判定口径（v4.5）：subject 本身就是 apex 注册域 → 整域归属走 scope-wildcard，
      // 单域授权只收子域（apex 提 scope-domain 会复现 catpaw/wow.fun 裸域无通配的覆盖缺口）
      const root = String(assetDb.hostRoot(host) || '')
      if (root && host === root) {
        return { ok: false, error: `${host} 本身是注册域（apex）。确认整个域名归属该项目 → 提 kind=scope-wildcard（整域 *.${host} 通配授权）；仅对单个子域有证据时才提 scope-domain 且 subject 填完整子域` }
      }
      const eq = payload && typeof payload === 'object' ? payload : {}
      const basis = String(eq.equity_basis || '').trim()
      if (!EQUITY_BASIS.includes(basis)) {
        return { ok: false, error: `equity_basis 必填（股权/归属判据，可选: ${EQUITY_BASIS.join('/')}）；口径见 data/rules/src/equity-gate.md（100% 控股算，参股/投资不算）` }
      }
      const indep = String(eq.independent_src || '').trim()
      if (!INDEPENDENT_SRC.includes(indep)) {
        return { ok: false, error: `independent_src 必填（目标是否有自身 SRC 渠道，可选: ${INDEPENDENT_SRC.join('/')}）——有独立收洞渠道的不并入本项目（H-004 教训）` }
      }
      // 子域单域授权从严：evidence ≥30 字且须含具体归属证据（CNAME 指向授权资产/内容同源比对/
      // 主体一致性核证），防止「猜一个子域就提审批」
      if (String(evidence || '').trim().length < 30) {
        return { ok: false, error: `单子域授权 evidence 须 ≥30 字且含具体归属证据（如 CNAME 指向已授权资产/与授权域内容同源/主体核证），「疑似/字典枚举」不构成依据` }
      }
      return { ok: true, value: { host, program_name, payload: {
        equity_basis: basis, independent_src: indep, domain_level: 'subdomain',
        corroboration: String(eq.corroboration || '').trim() || null,
      } } }
    },
    // 批准副作用：host 追加进目标项目 scope（复用 scopeSaveProgram 原子写+备份+审计+syncPrograms）
    // + P19' 种子入队（once 任务 + radar 事件，当天启动首轮资产收集）
    onApprove({ subject, program_name }) {
      const host = hostOf(subject)
      const scope = loadScope()
      const prog = (Array.isArray(scope.programs) ? scope.programs : []).find((p) => p && p.name === program_name)
      if (!prog) return { ok: false, error: `项目 ${program_name} 不在 scope.yml（可能已被移除），请驳回后重新提请` }
      const entries = Array.isArray(prog.scope) ? prog.scope : []
      if (entries.includes(host)) return { ok: true, note: `${host} 已在 scope（幂等跳过）` }
      const r = scopeSaveProgram({
        name: program_name,
        platform: prog.platform || '',
        scope: [...entries, host],
        exclude: Array.isArray(prog.exclude) ? prog.exclude : [],
        max_risk: (prog.rules && prog.rules.max_risk) || 'active',
        fixed_egress_ip: !!(prog.rules && prog.rules.fixed_egress_ip),
        workspace: (prog.rules && prog.rules.workspace) || '',
        finding_db: prog.finding_db || '',
      }, false)
      if (!r.ok) return r
      const seed = enqueueScopeSeed(host, program_name)
      return { ok: true, note: `${host} 已加入项目 ${program_name} 授权范围（fail-closed 即时生效）；${seed.join('；')}` }
    },
  },
  // v4.5 整域授权（通配）：整个注册域归属某 SRC 时一次审批覆盖全部子域。
  // 由来：2026-09-04 批准的 catpaw.com/tabbit.com/wow.fun 只落裸 apex（无 *. 通配），次日 recon
  // 对 www.catpaw.com 探活即被 fail-closed 拒绝，被迫逐子域提审批——本 kind 根治该口径缺口。
  // 门槛比单域更严：equity_basis 限「控股/全资」「收购/财团」（品牌/技术印证不足以开整域）、
  // independent_src 必填且≠「有」、evidence ≥30 字（主体核证级：ICP 备案主体/官网新闻/收购公告）。
  'scope-wildcard': {
    label: '整域授权(通配)',
    validate({ subject, program_name, payload, evidence }) {
      const host = hostOf(subject)
      if (!host) return { ok: false, error: `无法解析域名: ${subject}` }
      const root = String(assetDb.hostRoot(host) || '')
      if (!root || host !== root) {
        return { ok: false, error: `scope-wildcard 的 subject 必须是注册域（apex），如 example.com；${host} 是子域——单子域授权请走 scope-domain（subject 填完整子域）` }
      }
      const scope = loadScope()
      const programs = Array.isArray(scope.programs) ? scope.programs : []
      const prog = programs.find((p) => p && p.name === program_name)
      if (!prog) {
        return { ok: false, error: `项目 ${program_name} 不在 scope.yml（先确认归属项目名；scopeList 可查）`, programs: programs.map((p) => p.name) }
      }
      // 整域已在授权范围：*.example.com 或裸 apex 任一在 scope 即视为已覆盖
      const entries = Array.isArray(prog.scope) ? prog.scope : []
      const wild = `*.${host}`
      if (entries.some((e) => e === wild || e === host)) {
        return { ok: false, error: `${wild} 或 ${host} 已在项目 ${program_name} 授权范围内，无须审批` }
      }
      const eq = payload && typeof payload === 'object' ? payload : {}
      const basis = String(eq.equity_basis || '').trim()
      if (!['控股/全资', '收购/财团'].includes(basis)) {
        return { ok: false, error: `整域授权 equity_basis 只接受 控股/全资 或 收购/财团（可选: ${EQUITY_BASIS.join('/')}）——品牌/产品线/技术印证不足以开 *.${host} 通配` }
      }
      const indep = String(eq.independent_src || '').trim()
      if (!INDEPENDENT_SRC.includes(indep)) {
        return { ok: false, error: `independent_src 必填（可选: ${INDEPENDENT_SRC.join('/')}）——有独立收洞渠道的不并入本项目（H-004 教训）` }
      }
      if (indep === '有') {
        return { ok: false, error: `目标有自身 SRC 渠道（independent_src=有）——不并入本项目（H-004 教训），请驳回思路` }
      }
      if (String(evidence || '').trim().length < 30) {
        return { ok: false, error: `整域授权 evidence 须 ≥30 字且为主体核证级证据（ICP 备案主体/官网品牌一致/收购公告/SRC 规则页明示范围），「看起来像」不构成整域依据` }
      }
      return { ok: true, value: { host, program_name, payload: {
        equity_basis: basis, independent_src: indep, domain_level: 'apex',
        corroboration: String(eq.corroboration || '').trim() || null,
      } } }
    },
    // 批准副作用：写回 ["*.example.com", "example.com"] 双条目（对齐 qiandai/mobike/keeta 现存形态）
    // + 种子任务（首轮全子域资产收集）
    onApprove({ subject, program_name }) {
      const host = hostOf(subject)
      const root = String(assetDb.hostRoot(host) || '')
      if (!root || host !== root) return { ok: false, error: `${host} 不是注册域（apex），请驳回后按子域走 scope-domain 重新提请` }
      const scope = loadScope()
      const prog = (Array.isArray(scope.programs) ? scope.programs : []).find((p) => p && p.name === program_name)
      if (!prog) return { ok: false, error: `项目 ${program_name} 不在 scope.yml（可能已被移除），请驳回后重新提请` }
      const entries = Array.isArray(prog.scope) ? prog.scope : []
      const wild = `*.${host}`
      if (entries.includes(wild)) return { ok: true, note: `${wild} 已在 scope（幂等跳过）` }
      const add = [wild, host].filter((e) => !entries.includes(e))
      const r = scopeSaveProgram({
        name: program_name,
        platform: prog.platform || '',
        scope: [...entries, ...add],
        exclude: Array.isArray(prog.exclude) ? prog.exclude : [],
        max_risk: (prog.rules && prog.rules.max_risk) || 'active',
        fixed_egress_ip: !!(prog.rules && prog.rules.fixed_egress_ip),
        workspace: (prog.rules && prog.rules.workspace) || '',
        finding_db: prog.finding_db || '',
      }, false)
      if (!r.ok) return r
      const seed = enqueueScopeSeed(host, program_name)
      return { ok: true, note: `${wild} + ${host} 已加入项目 ${program_name} 授权范围（全子域 fail-closed 即时生效）；${seed.join('；')}` }
    },
  },
  // P20' 排除清单例外评估——被排除资产的人工评估正规入口（此前「走人工评估」无登记无留痕）。
  // 批准 = 移出排除清单并加入授权范围 + durable 事实留档；驳回 = 维持排除（决策留痕）。
  'exclude-exception': {
    label: '排除例外',
    validate({ subject, program_name, payload }) {
      const host = hostOf(subject)
      if (!host) return { ok: false, error: `无法解析域名: ${subject}` }
      if (!program_name) return { ok: false, error: 'exclude-exception 必填 program_name（排除该域的项目名）' }
      const scope = loadScope()
      const programs = Array.isArray(scope.programs) ? scope.programs : []
      const prog = programs.find((p) => p && p.name === program_name)
      if (!prog) return { ok: false, error: `项目 ${program_name} 不在 scope.yml（scopeList 可查）`, programs: programs.map((p) => p.name) }
      const excludes = Array.isArray(prog.exclude) ? prog.exclude : []
      if (!excludes.some((e) => entryMatches(e, host))) {
        return { ok: false, error: `${host} 不在项目 ${program_name} 的排除清单中（排除例外只收被排除资产；普通候选走 scope-domain）` }
      }
      const eq = payload && typeof payload === 'object' ? payload : {}
      const basis = String(eq.equity_basis || '').trim()
      if (!EQUITY_BASIS.includes(basis)) {
        return { ok: false, error: `equity_basis 必填（例外评估判据，可选: ${EQUITY_BASIS.join('/')}）；解除排除须给出比 scope-domain 更强的归属证据` }
      }
      return { ok: true, value: { host, program_name, payload: { equity_basis: basis } } }
    },
    onApprove({ subject, program_name }) {
      const host = hostOf(subject)
      const scope = loadScope()
      const prog = (Array.isArray(scope.programs) ? scope.programs : []).find((p) => p && p.name === program_name)
      if (!prog) return { ok: false, error: `项目 ${program_name} 不在 scope.yml（可能已被移除），请驳回后重新提请` }
      const entries = Array.isArray(prog.scope) ? prog.scope : []
      const excludes = (Array.isArray(prog.exclude) ? prog.exclude : []).filter((e) => e !== host)
      if (entries.includes(host) && excludes.every((e) => e !== host)) return { ok: true, note: `${host} 已在 scope 且不在排除清单（幂等跳过）` }
      const r = scopeSaveProgram({
        name: program_name,
        platform: prog.platform || '',
        scope: entries.includes(host) ? entries : [...entries, host],
        exclude: excludes,
        max_risk: (prog.rules && prog.rules.max_risk) || 'active',
        fixed_egress_ip: !!(prog.rules && prog.rules.fixed_egress_ip),
        workspace: (prog.rules && prog.rules.workspace) || '',
        finding_db: prog.finding_db || '',
      }, false)
      if (!r.ok) return r
      // durable 事实留档：例外决策的项目级可见记录（audit.jsonl 之外的长期痕迹）
      try {
        assetDb.factUpsert({
          program_id: program_name, fact_key: `scope/exception-${host}`, category: 'scope',
          summary: `排除例外已批准：${host} 移出排除清单并入授权范围`,
          body: `排除清单例外经人工评估批准（审批中心 exclude-exception）。生效动作：移出 ${program_name} 排除清单 + 加入授权范围。评估判据与证据见 approval_requests 决策留痕。`,
          confidence: 'confirmed', source: 'approval',
        })
      } catch { /* 留档失败不阻断批准（audit.jsonl 已有全量留痕） */ }
      return { ok: true, note: `${host} 已移出项目 ${program_name} 排除清单并加入授权范围（fail-closed 即时生效；例外决策已留档 facts）` }
    },
  },
  // v4.5 异步审批：intrusive 工具放行。runCli 遇 allow_risk 拒绝（needsApproval 路径）自动落库，
  // 不经 approval_request 工具（agent 无法替人工编 evidence）。批准 = 写项目 allow_intrusive_tools
  // 白名单（scope.yml rules 新字段），下个调度周期任务重试时 checkRisk 自然放行；驳回 = 维持拒绝。
  // 审计全量保留（audit.jsonl deny→approve 链条完整）。
  'tool-intrusive': {
    label: '侵入工具放行',
    validate() { return { ok: false, error: 'tool-intrusive 由 runCli 拒绝点自动提请（payload 带工具/风险级/目标/参数），agent 不可直接提请' } },
    onApprove({ subject, program_name, payload }) {
      const tool = String(payload && payload.tool || '').trim()
      if (!tool || !program_name) return { ok: false, error: 'payload 缺 tool 或 program_name（历史请求格式不符，请驳回）' }
      const scope = loadScope()
      const prog = (Array.isArray(scope.programs) ? scope.programs : []).find((p) => p && p.name === program_name)
      if (!prog) return { ok: false, error: `项目 ${program_name} 不在 scope.yml（可能已被移除），请驳回` }
      const rules = prog.rules || {}
      const allow = Array.isArray(rules.allow_intrusive_tools) ? rules.allow_intrusive_tools : []
      if (allow.map((s) => String(s).toLowerCase()).includes(tool.toLowerCase())) {
        return { ok: true, note: `${tool} 已在项目 ${program_name} allow_intrusive_tools 白名单（幂等跳过）` }
      }
      const r = scopeSaveProgram({
        name: program_name,
        platform: prog.platform || '',
        scope: Array.isArray(prog.scope) ? prog.scope : [],
        exclude: Array.isArray(prog.exclude) ? prog.exclude : [],
        max_risk: rules.max_risk || 'active',
        fixed_egress_ip: !!rules.fixed_egress_ip,
        workspace: rules.workspace || '',
        finding_db: prog.finding_db || '',
        allow_intrusive_tools: [...allow, tool],
      }, false)
      if (!r.ok) return r
      return { ok: true, note: `${tool} 已加入项目 ${program_name} allow_intrusive_tools 白名单——intrusive 级对该项目放行（其余风险闸不变），下个调度周期任务重试即生效` }
    },
  },
  // v4.5 异步审批：任务预算延长。scheduler 超时分支自动提请（worker 跑满 3600s 上限被杀）。
  // 批准 = tasks.budget_timeout_sec 列写入（上限 7200 封顶），下个周期 runWorker 用 max(默认, 该值)。
  'task-budget-extend': {
    label: '任务预算延长',
    validate() { return { ok: false, error: 'task-budget-extend 由 scheduler 超时分支自动提请，agent 不可直接提请' } },
    onApprove({ subject, program_name, payload }) {
      const taskId = Number(payload && payload.task_id)
      const budget = Number(payload && payload.budget_timeout_sec) || 7200
      if (!taskId) return { ok: false, error: 'payload 缺 task_id（历史请求格式不符，请驳回）' }
      const t = assetDb.taskGet(taskId)
      if (!t) return { ok: false, error: `任务 #${taskId} 不存在（可能已删除），请驳回` }
      const capped = Math.min(budget, 7200)
      assetDb.getDb().prepare('UPDATE tasks SET budget_timeout_sec = ?, updated_at = ? WHERE id = ?').run(capped, Date.now(), taskId)
      return { ok: true, note: `任务 #${taskId} 预算上限已提升至 ${capped}s（下个调度周期生效，runWorker 按 max(默认, budget_timeout_sec) 取值）` }
    },
  },
}

// agent 工具入口：通用校验（kind 注册/去重/evidence）+ kind.validate 专属校验（含 payload 股权判据）
function approvalRequest(args, exec) {
  const kind = String(args.kind || '').trim()
  const subject = String(args.subject || '').trim()
  const evidence = String(args.evidence || '').trim()
  const def = APPROVAL_KINDS[kind]
  if (!def) return { ok: false, error: `未知审批类型 ${kind}（可选: ${Object.keys(APPROVAL_KINDS).join('/')}）` }
  if (!subject) return { ok: false, error: 'subject 必填' }
  if (evidence.length < 10) return { ok: false, error: 'evidence 必填且 ≥10 字（归属证据/依据摘要）' }
  const payload = {
    equity_basis: String(args.equity_basis || '').trim(),
    independent_src: String(args.independent_src || '').trim(),
    corroboration: String(args.corroboration || '').trim(),
  }
  const v = def.validate({ subject, program_name: String(args.program_name || '').trim(), evidence, payload })
  if (!v.ok) return v
  const add = assetDb.approvalAdd({
    kind, subject: v.value?.host || subject, program_name: String(args.program_name || '').trim() || null,
    payload: v.value?.payload || null, evidence, requested_by: sessionIdOf ? safeSessionId(exec) : 'agent',
  })
  if (!add.ok) return add
  audit({ ts: Date.now(), run_id: '-', tool: 'approval_request', decision: 'executed', detail: { kind, subject, request_id: add.request_id, equity_basis: payload.equity_basis || undefined, independent_src: payload.independent_src || undefined } })
  return { ok: true, request_id: add.request_id, hint: '已提请人工审批（看板「审批」tab）。批准前目标仍被 scope-guard 拒绝，不要尝试打点。' }
}

function safeSessionId(exec) {
  try { const id = sessionIdOf(exec); return id ? String(id) : 'agent' } catch { return 'agent' }
}

// tool-intrusive 审批 payload 的参数脱敏：只保留短标量值（供人工判断该工具拿什么参数打哪），
// 长文本/疑似敏感值截断打码，防审批看板泄漏凭据类参数
function sanitizeParamsForApproval(params) {
  const out = {}
  for (const [k, v] of Object.entries(params || {})) {
    if (typeof v === 'string') {
      out[k] = v.length > 60 ? v.slice(0, 60) + '…' : v
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      out[k] = v
    } else {
      out[k] = `[${Array.isArray(v) ? 'list:' + v.length : typeof v}]`
    }
  }
  return out
}

// 看板决策入口（dashboard-rpc approvalDecide 调用）：批准先执行 kind.onApprove 副作用，成功才落 approved
function approvalDecideAction({ id, decision, note = '' }) {
  const row = assetDb.approvalGet(Number(id))
  if (!row) return { ok: false, error: `请求 #${id} 不存在` }
  if (row.status !== 'pending') return { ok: false, error: `请求 #${id} 已决策（${row.status}）` }
  if (decision === 'reject') {
    const r = assetDb.approvalDecide({ id: Number(id), decision, note })
    audit({ ts: Date.now(), run_id: '-', tool: 'dashboard.approvalDecide', decision: 'executed', detail: { id, result: 'rejected', note } })
    return r
  }
  const def = APPROVAL_KINDS[row.kind]
  if (!def) return { ok: false, error: `审批类型 ${row.kind} 无处理器（注册表缺项）` }
  const eff = def.onApprove({ subject: row.subject, program_name: row.program_name, payload: row.payload ? JSON.parse(row.payload) : null, note })
  if (!eff.ok) return { ok: false, error: `批准副作用失败: ${eff.error}（请求保持 pending，可修复后重试或驳回）` }
  const r = assetDb.approvalDecide({ id: Number(id), decision: 'approve', note: [note, eff.note].filter(Boolean).join('；') || null })
  audit({ ts: Date.now(), run_id: '-', tool: 'dashboard.approvalDecide', decision: 'executed', detail: { id, result: 'approved', kind: row.kind, subject: row.subject, effect: eff.note || '' } })
  return { ...r, effect: eff.note || '' }
}

// 看板工作区区块数据源：workspaceRegistry + 绑定 program + 资产/漏洞/会话计数
function workspacesList() {
  if (!workspaceRegistryRef) return { available: false, items: [] }
  let workspaces
  try { workspaces = workspaceRegistryRef.list() } catch (e) { return { available: false, items: [], error: String(e && e.message || e) } }
  const programs = assetDb.listPrograms()
  const byWorkspace = {}
  for (const p of programs) if (p.workspace_id) byWorkspace[p.workspace_id] = p
  const items = workspaces.map((w) => {
    const prog = byWorkspace[String(w.id)] || null
    let assets = 0; let findings = 0; let tasks = 0
    if (prog) {
      assets = assetDb.countAssets({ programId: prog.id })
      findings = assetDb.countFindings({ programId: prog.id })
      tasks = assetDb.countTasks({ programId: prog.id })
    }
    return {
      id: String(w.id), title: w.title, path: w.path,
      session_count: Array.isArray(w.sessionIds) ? w.sessionIds.length : 0,
      program: prog ? { id: prog.id, status: prog.status, max_risk: prog.max_risk } : null,
      assets, findings, tasks,
    }
  })
  return { available: true, items }
}

// 工作区的会话清单（跳链用）：registry sessionIds + sessionPersistence 头部投影
async function sessionsList(workspaceId) {
  if (!workspaceRegistryRef) return { available: false, items: [] }
  const ws = workspaceRegistryRef.get(workspaceId)
  if (!ws) return { available: true, items: [], error: `工作区不存在: ${workspaceId}` }
  const headers = {}
  if (sessionPersistenceRef) {
    try {
      for (const h of await sessionPersistenceRef.list()) headers[String(h.id)] = h
    } catch { /* 头部投影失败降级为纯 id 列表 */ }
  }
  const items = ws.sessionIds.map((id) => {
    const h = headers[String(id)] || null
    return { id: String(id), created_at: h && h.createdAt ? h.createdAt : null }
  })
  return { available: true, items, workspace: { id: String(ws.id), title: ws.title, path: ws.path } }
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
  // v4.5 异步放行白名单：项目 rules.allow_intrusive_tools 列出的工具对 intrusive 级放行
  //（task-intrusive 审批批准后写入，下个调度周期任务重试时自然通过）
  const allowIntrusive = programCfg && programCfg.rules && Array.isArray(programCfg.rules.allow_intrusive_tools)
    ? programCfg.rules.allow_intrusive_tools.map((s) => String(s).toLowerCase()) : []
  if (allowIntrusive.length && manifestRisk === 'intrusive' && toolNameOfRiskCheck) {
    if (allowIntrusive.includes(String(toolNameOfRiskCheck).toLowerCase())) return { allow: true }
  }
  if (!allowRisk.includes(manifestRisk)) {
    return { allow: false, reason: `工具风险级 ${manifestRisk} 需要人工确认（allow_risk: ${allowRisk.join('/') }）`, needsApproval: manifestRisk === 'intrusive' }
  }
  return { allow: true }
}
// checkRisk 与 toolName 的桥（checkRisk 签名历史遗留无 tool 名，intrusive 白名单按工具名匹配）
let toolNameOfRiskCheck = null

// ==============================================================================
// S1 解析后校验（审计）：active+ 目标执行前 DNS 解析，解析 IP 落内网/保留段且未授权 → 拒绝
// 防「授权域名 CNAME/解析到 scope 外、内网 IP 打内网」越界。passive 工具跳过（不主动连目标）。
// ==============================================================================

const RESERVED_CIDRS = [
  { base: 0x00000000, bits: 8 },      // 0.0.0.0/8
  { base: 0x0a000000, bits: 8 },      // 10.0.0.0/8
  { base: 0x64400000, bits: 10 },     // 100.64.0.0/10 (CGNAT)
  { base: 0x7f000000, bits: 8 },      // 127.0.0.0/8
  { base: 0xa9fe0000, bits: 16 },     // 169.254.0.0/16
  { base: 0xac100000, bits: 12 },     // 172.16.0.0/12
  { base: 0xc0a80000, bits: 16 },     // 192.168.0.0/16
]

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

// 返回违规原因字符串，或 null（通过）
async function verifyResolved(targets, manifest) {
  if (RISK_ORDER.indexOf(String(manifest.risk || 'passive')) < RISK_ORDER.indexOf('active')) return null
  for (const t of targets) {
    const host = hostOf(t)
    if (!host) continue
    const chk = checkTarget(host)
    const cfg = chk.programCfg || null
    const ipi = ipToInt(host)
    if (ipi !== null) {
      if (ipInReserved(ipi) && !programAllowsIp(cfg, host)) {
        return `目标 ${host} 为内网/保留 IP 且不在项目 ${chk.program || '?'} 授权 CIDR 内`
      }
      continue
    }
    // 域名 → 解析后校验（失败不阻断，被动工具/临时 DNS 故障容错）
    let ips = []
    try { ips = await dns.promises.resolve4(host) } catch { ips = [] }
    for (const ip of ips) {
      const ri = ipToInt(ip)
      if (ri !== null && ipInReserved(ri) && !programAllowsIp(cfg, ip)) {
        return `目标 ${host} 解析到内网/保留 IP ${ip} 且不在项目 ${chk.program || '?'} 授权 CIDR 内`
      }
    }
  }
  return null
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

// 审计尾读（看板审计视图）：只读文件尾部 ≤256KB（audit 50MB 轮转，尾读足够），解析最近 n 条，新→旧。
function tailAudit(n) {
  try {
    const stat = fs.statSync(AUDIT_LOG)
    const maxBytes = 256 * 1024
    const start = Math.max(0, stat.size - maxBytes)
    const fd = fs.openSync(AUDIT_LOG, 'r')
    const buf = Buffer.alloc(stat.size - start)
    fs.readSync(fd, buf, 0, buf.length, start)
    fs.closeSync(fd)
    const lines = buf.toString('utf8').split('\n').filter((l) => l.trim())
    const rows = []
    for (const line of lines.slice(-n)) { try { rows.push(JSON.parse(line)) } catch { /* 跳过半行 */ } }
    return rows.reverse()
  } catch { return [] }
}

// ==============================================================================
// sandbox（审计 S2）：run_cli 经 bwrap 白名单隔离执行
// 白名单只挂 /usr /etc /home /opt/silkspool/dsh/{venv,opt} + runDir(写) + /tmp /dev /proc。
// 效果：平台密钥（.env/settings.yaml/silkspool.yaml/keys）与系统写路径对工具不可见，
//       且除 runDir 外全部只读。SEC_NO_SANDBOX=1 或 bwrap 缺失时 graceful 降级为不沙箱。
// ==============================================================================

const BWRAP_BIN = process.env.SEC_BWRAP_BIN || '/usr/bin/bwrap'
const SANDBOX_DISABLED = process.env.SEC_NO_SANDBOX === '1'
const HOME_DIR = process.env.HOME || '/home/silkspool'
const VENV_DIR = '/opt/silkspool/dsh/venv'
const OPT_DIR = '/opt/silkspool/dsh/opt'

function bwrapAvailable() {
  try { return fs.existsSync(BWRAP_BIN) } catch { return false }
}

// 返回 { cmd, args } 或 null（不沙箱）。仅对有 target_param 的网络工具沙箱；
// 本地代码审计工具（semgrep/codeql/gitleaks 等无 target_param）需读任意源码路径，不沙箱。
function buildSandboxCommand(binary, argv, runDir) {
  if (SANDBOX_DISABLED || !bwrapAvailable()) return null
  const args = [
    '--unshare-all', '--share-net', '--die-with-parent', '--new-session',
    '--proc', '/proc',
    '--dev', '/dev',
    '--tmpfs', '/tmp',
    '--ro-bind', '/usr', '/usr',
    '--ro-bind', '/etc', '/etc',
    '--symlink', 'usr/bin', '/bin',
    '--symlink', 'usr/sbin', '/sbin',
    '--symlink', 'usr/lib', '/lib',
    '--symlink', 'usr/lib64', '/lib64',
    '--bind', HOME_DIR, HOME_DIR,
  ]
  if (fs.existsSync(VENV_DIR)) args.push('--ro-bind', VENV_DIR, VENV_DIR)
  if (fs.existsSync(OPT_DIR)) args.push('--ro-bind', OPT_DIR, OPT_DIR)
  args.push('--bind', runDir, runDir)
  args.push('--', binary, ...argv)
  return { cmd: BWRAP_BIN, args }
}

// 工具执行上下文（rc.7 ToolRunContext）：exec.agent.id === SessionId，run→session 映射的捕获点
function sessionIdOf(exec) {
  try {
    const id = exec && exec.agent && exec.agent.id
    return id ? String(id) : null
  } catch { return null }
}

// 会话 header cwd（对齐 asset-graph.execCwd），用于按工作区反查所属 program
function execCwd(exec) {
  try {
    const cwd = exec && exec.agent && exec.agent.session && exec.agent.session.header && exec.agent.session.header.cwd
    return cwd ? String(cwd) : null
  } catch { return null }
}

// 解析当前会话所属 program：显式 program_id 优先，否则按会话工作区 cwd 反查（缺则空串）
function resolveProgramId(explicit, exec) {
  const pid = String(explicit || '').trim()
  if (pid) return pid
  const cwd = execCwd(exec)
  return (cwd && assetDb.programByWorkspacePath(cwd)) || ''
}

async function runCli(args, exec) {
  const sessionId = sessionIdOf(exec)
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

  // S3 守卫（审计）：manifest 无 target_param 且 risk≥active → 拒绝（防 scope 校验空转绕过）
  if (!manifest.target_param && RISK_ORDER.indexOf(String(manifest.risk || 'passive')) >= RISK_ORDER.indexOf('active')) {
    audit({ ts: Date.now(), run_id: runId, tool: toolName, decision: 'deny', reason: '无 target_param 且 risk≥active' })
    return { ok: false, run_id: runId, error: `manifest 未声明 target_param 且 risk=${manifest.risk}≥active：无法做 scope 校验，拒绝执行（补 target_param 或降 risk）` }
  }
  // S4 守卫（审计）：参数注入防护——值禁换行；target 参数禁空白（防 argv 注入危险 flag）
  for (const [k, v] of Object.entries(params)) {
    if (typeof v !== 'string') continue
    if (/[\r\n]/.test(v)) {
      return { ok: false, run_id: runId, error: `参数 ${k} 含换行符，拒绝（防参数注入）` }
    }
    if (k === manifest.target_param && /\s/.test(v)) {
      return { ok: false, run_id: runId, error: `target 参数含空白字符，拒绝（防参数注入）` }
    }
  }

  for (const t of targets) {
    const chk = checkTarget(t)
    audit({ ts: Date.now(), run_id: runId, tool: toolName, target: t, decision: chk.allow ? 'allow' : 'deny', reason: chk.reason })
    if (!chk.allow) return { ok: false, run_id: runId, error: `scope-guard 拒绝: ${chk.reason}` }
  }
  const firstChk = targets.length ? checkTarget(targets[0]) : { programCfg: null }
  const programId = firstChk.program || null
  // v4.5 异步审批：intrusive 级被拒 → 自动落 tool-intrusive 审批（payload 带完整重试上下文），
  // 同步拒绝语义不变（fail-closed 当场生效），agent 不重试；批准写入项目 allow_intrusive_tools
  // 白名单后下个调度周期重试自然放行。
  toolNameOfRiskCheck = toolName
  const riskChk = checkRisk(String(manifest.risk || 'passive'), firstChk.programCfg)
  toolNameOfRiskCheck = null
  if (!riskChk.allow) {
    let approvalHint = null
    if (riskChk.needsApproval && programId) {
      try {
        const add = assetDb.approvalAdd({
          kind: 'tool-intrusive', subject: `${toolName}:${targets[0] || '-'}`, program_name: programId,
          payload: { tool: toolName, risk: manifest.risk, target: targets[0] || null, params: sanitizeParamsForApproval(params), program: programId },
          evidence: `intrusive 工具 ${toolName}（risk=${manifest.risk}）对 ${targets[0] || '目标'} 的调用被 allow_risk 拒绝，请求人工放行`,
          requested_by: sessionIdOf ? safeSessionId(exec) : 'agent',
        })
        if (add.ok || add.request_id) approvalHint = `已自动提请 tool-intrusive 审批 #${add.request_id || add.id}（批准后该工具加入项目 ${programId} allow_intrusive_tools 白名单，下个调度周期重试即放行）。本次调用维持拒绝，勿重试。`
      } catch { /* 审批落库失败不改变拒绝语义 */ }
    }
    audit({ ts: Date.now(), run_id: runId, tool: toolName, decision: 'deny', reason: riskChk.reason, approval_filed: !!approvalHint })
    return { ok: false, run_id: runId, error: `scope-guard 拒绝: ${riskChk.reason}`, needs_approval: !!riskChk.needsApproval, ...(approvalHint ? { approval_hint: approvalHint } : {}) }
  }

  // S1 解析后校验（active+）：DNS 解析 IP 落内网/保留段且未授权 → 拒绝
  if (targets.length > 0) {
    const resolvedViolation = await verifyResolved(targets, manifest)
    if (resolvedViolation) {
      audit({ ts: Date.now(), run_id: runId, tool: toolName, decision: 'deny', reason: resolvedViolation })
      return { ok: false, run_id: runId, error: `scope-guard 解析后校验拒绝: ${resolvedViolation}` }
    }
  }

  // ---- 主动扫描全局限速（v4.6 执行点）：active+ 工具启动节流，passive 不限 ----
  if (RISK_ORDER.indexOf(String(manifest.risk || 'passive')) >= RISK_ORDER.indexOf('active')) {
    await throttleQps(toolName)
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
  // sandbox（S2）：有 target_param 的网络工具经 bwrap 白名单隔离；本地审计工具不沙箱。
  // manifest 可显式 `sandbox: false` 逐工具豁免——留给极少数与 bwrap user-ns 真不兼容的工具的 escape hatch（默认仍沙箱）。
  const sandbox = (manifest.target_param && manifest.sandbox !== false) ? buildSandboxCommand(binary, argv, runDir) : null
  const spawnCmd = sandbox ? sandbox.cmd : binary
  const spawnArgs = sandbox ? sandbox.args : argv
  const result = await new Promise((resolve) => {
    let child
    try {
      // stdin 必须置 /dev/null（stdio[0]='ignore'）：默认 spawn 的 stdin 是常开管道，
      // ProjectDiscovery 系工具（httpx/nuclei/dnsx/naabu…）的 fileutil.HasStdin() 会把管道识别为
      // 「有 stdin 输入」→ 阻塞等待从 stdin 读目标直到 EOF；父进程从不写也不关 → 永久卡死（httpx v1.10 实测 300s 零输出）。
      // 关闭后 stdin=/dev/null（字符设备）→ HasStdin()=false → 工具改用 -u/-l 参数正常执行。stdout/stderr 仍为管道（下方要读）。
      child = spawn(spawnCmd, spawnArgs, { env, cwd: runDir, stdio: ['ignore', 'pipe', 'pipe'] })
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

  fs.writeFileSync(path.join(runDir, 'cmd.txt'), (sandbox ? '[sandbox] ' : '') + [binary, ...argv].join(' ') + '\n')
  const meta = {
    run_id: runId, tool: toolName, argv: [binary, ...argv], params,
    started_at: new Date(started).toISOString(), duration_ms: Date.now() - started,
    exit_code: result.code ?? null, signal: result.signal || null, error: result.error || null,
    risk: manifest.risk || 'passive', stage: manifest.stage || null,
    sandboxed: !!sandbox, session_id: sessionId,
  }
  fs.writeFileSync(path.join(runDir, 'meta.json'), JSON.stringify(meta, null, 1) + '\n')
  audit({ ts: Date.now(), run_id: runId, tool: toolName, decision: 'executed', exit_code: meta.exit_code, duration_ms: meta.duration_ms, sandboxed: meta.sandboxed })

  // P1-1 环1 自动沉淀：工具执行统计（成功率/耗时）→ playbook，驱动 pb_rank 进化（无需 agent 手动 pb_outcome）
  try { exp.pbOutcome({ name: `tool:${toolName}`, success: result.code === 0, duration_ms: meta.duration_ms }) } catch { /* 统计失败不阻断 */ }
  // P1-1 环1 负知识：执行失败/超时自动写 note 证伪，neg_check 派单前据此拦截重复尝试（免踩同一坑）
  if (programId && result.code !== 0) {
    const why = result.error ? `启动失败: ${result.error}` : result.signal ? `超时/被杀 ${result.signal}` : `exit ${result.code}`
    try {
      assetDb.factUpsert({
        program_id: programId,
        fact_key: `note/fail-${toolName}-${hostOf(targets[0] || 'na')}`.slice(0, 100),
        category: 'note',
        summary: `${toolName} 对 ${targets[0] || '?'} 执行失败（${why}）`,
        body: `run_id=${runId} tool=${toolName} target=${targets[0] || ''} ${why} duration=${meta.duration_ms}ms（自动证伪，neg_check 用于拦截重复尝试）`,
        confidence: 'tentative',
        source: 'auto:runcli-fail',
      })
    } catch { /* 证伪写入失败不阻断 */ }
  }

  // ---- 摘要（≤20 行）----
  let stdoutText = ''
  try { stdoutText = fs.readFileSync(path.join(runDir, 'stdout.log'), 'utf8') } catch { /* 无输出 */ }

  // ---- 自动入资产图谱（manifest store: asset-graph 且执行成功；parser 注册表路由；自动回填 program_id）----
  let ingested = null
  if (manifest.store === 'asset-graph' && result.code === 0 && stdoutText) {
    try {
      ingested = parsers.applyParsedResult(manifest, toolName, runId, stdoutText, programId, sessionId)
    } catch (e) {
      process.stderr.write(`[sec-suite] ${toolName} 自动入库异常: ${e?.message ?? String(e)}\n`)
    }
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

async function authzDiff(args, exec) {
  const sessionId = sessionIdOf(exec)
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
    // 启发式判定（非 LLM 验证流）：缺复现步骤/影响 → addFinding 完整性闸门自动归"待验证候选"（noise=1），
    // 由后续 vuln 轮/人工复核确认后补全升级，不直接进漏洞信号面。
    assetDb.addFinding({
      title: `疑似越权(IDOR): ${method} ${url}`, severity: 'high',
      host: hostOf(url), url, source: 'authz_diff', session_id: sessionId,
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
// spawn_worker：隔离执行的无头 worker（批任务不污染主会话上下文）
// 复用 DSH 内建 headless profile：子进程跑完只回尾部摘要，全文落盘
// ==============================================================================

const DSH_BIN = process.env.SEC_DSH_BIN
  || '/opt/silkspool/dsh/app/node_modules/@deepseek-ai/dsh/lib/bin.js'
const NODE_BIN = process.env.SEC_NODE_BIN || '/usr/local/node/bin/node'
const MAX_WORKERS = 4
let activeWorkers = 0
// 幂等恢复窗口：仅约束 done/failed 回读（从 finished_at 计）。重启后重试在数秒~分钟内落地，30min 绰绰有余。
const WORKER_DEDUPE_WINDOW_MS = 30 * 60 * 1000

// 从注册表行 + 落盘文件重建 worker 返回（幂等恢复用）。文件已清理则回 null → 调用方降级。
function readWorkerResult(row) {
  if (!row || !row.run_dir) return null
  let logText = ''
  try { logText = fs.readFileSync(path.join(row.run_dir, 'worker.log'), 'utf8') } catch { return null }
  const lines = logText.split('\n').filter(Boolean)
  return {
    ok: row.status === 'done',
    run_id: row.run_id,
    exit_code: row.exit_code ?? null,
    recovered: true,
    status: row.status,
    log_lines: lines.length,
    tail: lines.slice(-20).join('\n'),
    hint: `恢复自既有 run ${row.run_id}（未重跑）；完整日志用 grep_result/page_result 取；强制重跑传 force:true`,
  }
}

// worker 核心（工具与调度循环共用）。cwd 默认 runDir；调度任务传工作区路径——
// headless 会话 header cwd = workspace path → workspaceRegistry 自动归组 → 看板可跳链
async function runWorker({ task, cwd = null, timeoutSec = 900, originSessionId = null, enforceLimit = true, dedupeKey = null, provider = null, model = null, reasoningEffort = null }) {
  // 幂等恢复（仅交互路径传 dedupeKey）：重启→重试时确定性拿回结果，而非 "outcome unknown"。
  // 早返回全部在 activeWorkers++ 之前 → 不占也不错减并发 slot。
  if (dedupeKey) {
    const prev = assetDb.workerFindRecentByKey(dedupeKey, WORKER_DEDUPE_WINDOW_MS)
    if (prev) {
      if (prev.status === 'running') {
        if (pidAlive(prev.pid)) {
          return { ok: false, in_progress: true, run_id: prev.run_id, status: 'running',
            hint: `同任务 worker 正在跑（run_id=${prev.run_id}），用 worker_status 查进度；强制重跑传 force:true` }
        }
        try { assetDb.workerFinish(prev.run_id, { status: 'killed' }) } catch { /* ignore */ } // pid 死的僵尸 running → 归 killed，落到重跑
      } else if (prev.status === 'done' || prev.status === 'failed') {
        const recovered = readWorkerResult(prev)
        if (recovered) return recovered
        return { ok: prev.status === 'done', run_id: prev.run_id, exit_code: prev.exit_code ?? null,
          recovered: true, status: prev.status, tail: '', hint: '原始输出已清理，仅存 DB 终态' } // 文件清理降级
      }
      // killed → 落到下方 fresh spawn（无 durable 结果，重跑）
    }
  }

  if (enforceLimit && activeWorkers >= MAX_WORKERS) {
    return { ok: false, busy: true, error: `worker 并发上限 ${MAX_WORKERS}，请稍后重试` }
  }
  const timeoutMs = Math.min(Number(timeoutSec) || 900, 3600) * 1000
  const runId = 'w' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex')
  const runDir = path.join(RESULTS_DIR, runId)
  fs.mkdirSync(runDir, { recursive: true })
  const workCwd = (cwd && fs.existsSync(cwd)) ? cwd : runDir

  // P18：任务级模型覆盖。headless profile 默认读 agent-default-model；用 --patch 覆盖。
  const dshArgs = [DSH_BIN, '--profile', 'headless']
  if (provider && model) {
    const patchPath = path.join(runDir, 'model-patch.yml')
    const patchYaml = `- id: agent-default-model\n  config:\n    provider: ${String(provider)}\n    model: ${String(model)}\n`
    fs.writeFileSync(patchPath, patchYaml)
    dshArgs.push('--patch', patchPath)
  }
  dshArgs.push(task)

  const env = { ...process.env, DSH_HOME: DATA_DIR, PATH: '/usr/local/node/bin:' + (process.env.PATH || '') }
  audit({ ts: Date.now(), run_id: runId, tool: 'spawn_worker', decision: 'executed', detail: task.slice(0, 200), session_id: originSessionId })

  activeWorkers++
  const started = Date.now()
  const result = await new Promise((resolve) => {
    const out = fs.createWriteStream(path.join(runDir, 'worker.log'))
    const child = spawn(NODE_BIN, dshArgs, {
      env, cwd: workCwd, detached: true,
    })
    // 注册表登记（带 pid）：供重启对账 + 重试幂等恢复。登记失败不阻断执行。
    try {
      assetDb.workerRegister({ run_id: runId, dedupe_key: dedupeKey, task, cwd: workCwd, pid: child.pid,
        timeout_sec: Math.round(timeoutMs / 1000), session_id: originSessionId, run_dir: runDir })
    } catch { /* ignore */ }
    child.stdout.pipe(out)
    child.stderr.pipe(out)
    // 超时杀整个进程组（派生子 worker/CLI 子进程随父一起回收，防孤儿）
    const killGroup = (sig) => { try { process.kill(-child.pid, sig) } catch { /* 进程组已退 */ } }
    const killer = setTimeout(() => { killGroup('SIGTERM'); setTimeout(() => killGroup('SIGKILL'), 5000).unref() }, timeoutMs)
    child.on('error', (e) => { clearTimeout(killer); resolve({ code: null, error: String(e.message) }) })
    child.on('close', (code, signal) => { clearTimeout(killer); resolve({ code, signal }) })
  })
  activeWorkers--

  const meta = {
    run_id: runId, tool: 'spawn_worker', task, cwd: workCwd, started_at: new Date(started).toISOString(),
    duration_ms: Date.now() - started, exit_code: result.code ?? null, session_id: originSessionId,
  }
  fs.writeFileSync(path.join(runDir, 'meta.json'), JSON.stringify(meta, null, 1) + '\n')
  // 注册表收尾：exit0→done / 非0→failed / 被信号杀（超时）→killed
  const finalStatus = result.code === 0 ? 'done' : (result.code == null && result.signal ? 'killed' : 'failed')
  try { assetDb.workerFinish(runId, { status: finalStatus, exit_code: result.code ?? null }) } catch { /* ignore */ }

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

async function spawnWorker(args, exec) {
  const task = String(args.task || '').trim()
  if (!task) return { ok: false, error: 'task 不能为空' }
  // 幂等去重键 = sha1(task+cwd)；force:true 时不传 → 显式重跑。交互路径 cwd 恒为 null。
  const dedupeKey = args.force === true ? null
    : crypto.createHash('sha1').update(task + '\0').digest('hex')
  const provider = args.provider || null
  const model = args.model || null
  return runWorker({ task, timeoutSec: args.timeout, originSessionId: sessionIdOf(exec), dedupeKey, provider, model })
}

// worker run 状态查询（重启后 "interrupted/outcome unknown" 时确认真实结局；结果已落盘）
function workerStatus(args) {
  const runId = String(args.run_id || '').trim()
  if (!runId) return { ok: false, error: 'run_id 不能为空' }
  const row = assetDb.workerGet(runId)
  if (!row) return { ok: false, error: `无 run ${runId} 记录` }
  let tail = ''; let logLines = 0
  try {
    const logText = fs.readFileSync(path.join(row.run_dir || path.join(RESULTS_DIR, runId), 'worker.log'), 'utf8')
    const lines = logText.split('\n').filter(Boolean)
    logLines = lines.length
    tail = lines.slice(-20).join('\n')
  } catch { /* 日志已清理 */ }
  return {
    ok: true, run_id: runId, status: row.status, exit_code: row.exit_code ?? null,
    started_at: row.started_at, finished_at: row.finished_at, duration_ms: (row.finished_at && row.started_at) ? row.finished_at - row.started_at : null,
    log_lines: logLines, tail,
  }
}

// ==============================================================================
// P11 定时任务调度循环已拆分至 ./scheduler.js（startScheduler 注入依赖调用）。
// pidAlive 保留在主文件：runWorker 幂等恢复（上文）与 scheduler.js 锁心跳共用，经参数注入传入调度器。
// ==============================================================================

function pidAlive(pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}

// ==============================================================================
// plan_chain / task_chain / 看板 RPC 已拆分至 ./dashboard-rpc.js（initDashboardRpc 注入依赖调用）。
// FINDING_TAG_STATUS 仅被 handleDashboardRpc 使用，随迁；dashboardRpcRegistered 保留在下方供 apply 注册守卫。
// ==============================================================================

let dashboardRpcRegistered = false

// 看板 RPC 端点分发 handleDashboardRpc 已拆分至 ./dashboard-rpc.js（initDashboardRpc 注入依赖，注册点见 apply）。

// ==============================================================================
// intel_hunt：component-vuln-intel 触发器（P9）——指纹命中后查本地 nuclei 模板库找 N-day
// ==============================================================================

const NUCLEI_TEMPLATES = path.join(HOME_DIR, 'nuclei-templates')

function intelHunt(args, exec) {
  const tech = String(args.tech || '').toLowerCase().trim()
  if (!tech) return { ok: false, error: 'tech 必填（如 weblogic / ruoyi / spring）' }
  const version = String(args.version || '').trim()
  if (!fs.existsSync(NUCLEI_TEMPLATES)) return { ok: false, error: `nuclei 模板库不存在: ${NUCLEI_TEMPLATES}` }
  const matches = []
  const walk = (dir, depth) => {
    if (depth > 3 || matches.length >= 30) return
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (matches.length >= 30) return
      const p = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (e.name.toLowerCase().includes(tech)) {
          try { matches.push(...fs.readdirSync(p).filter((f) => f.endsWith('.yaml')).map((f) => path.join(p, f)).slice(0, 30)) } catch { /* skip */ }
        } else {
          walk(p, depth + 1)
        }
      } else if (e.name.toLowerCase().includes(tech) && e.name.endsWith('.yaml')) {
        matches.push(p)
      }
    }
  }
  walk(NUCLEI_TEMPLATES, 0)
  const rel = matches.slice(0, 30).map((m) => path.relative(NUCLEI_TEMPLATES, m))
  if (!rel.length) return { ok: true, tech, version, templates: [], task_id: null, hint: `模板库无 ${tech} 相关模板` }

  // P2-3：命中模板 → 自动产出 N-day 候选任务（普通 queued，非自动跑；tentative，验证附证据才 confirmed）
  const programId = resolveProgramId(args.program_id, exec)
  const host = String(args.host || '').trim()
  const label = `[N-day ${tech}${version ? '@' + version : ''}]`
  let task = null
  if (programId) {
    // 幂等去重：同 program 下已有未终结（queued/running/blocked）的同技术栈候选任务则不重复建
    const dup = assetDb.taskList({ programId, q: label, limit: 50 })
      .find((t) => ['queued', 'running', 'blocked'].includes(t.status))
    if (dup) {
      task = { id: dup.id, deduped: true }
    } else {
      const objective = `${label} 验证 ${tech}${version ? ' ' + version : ''} N-day 漏洞`
        + `${host ? `（目标 ${host}）` : ''}：命中 ${rel.length} 个 nuclei 模板，逐一验证。`
        + '结果强制 tentative——附 PoC/响应证据方可 confirmed，无证据保持 tentative 或证伪。'
      const r = assetDb.taskCreate({ program_id: programId, phase: 'vuln', objective, priority: 1, session_id: sessionIdOf(exec) })
      if (r.ok) {
        task = { id: r.id, deduped: false }
        audit({ ts: Date.now(), run_id: '-', tool: 'intel_hunt.autotask', decision: 'executed', detail: { program_id: programId, tech, version, task_id: r.id, templates: rel.length }, session_id: sessionIdOf(exec) })
      }
    }
  }
  const hint = task
    ? `命中 ${rel.length} 个模板 → 已${task.deduped ? '存在' : '产出'} N-day 候选任务 #${task.id}（phase=vuln, priority=1, tentative）。验证附证据才 confirmed。`
    : `命中 ${rel.length} 个 ${tech}${version ? '@' + version : ''} 相关模板；未绑定 program（传 program_id 或在工作区会话内调用）故未自动建任务。结果强制 tentative。`
  return { ok: true, tech, version, templates: rel, task_id: task ? task.id : null, deduped: task ? task.deduped : false, hint }
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
    execute: async (args, exec) => runCli(args || {}, exec),
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
      + '跑完只回尾部摘要，全文落盘 results/<run_id>/worker.log。批任务用它，不要在主会话直接跑大输出工具。'
      + '幂等：宿主重启后本调用报 "interrupted/outcome unknown" 时，原样重试即可确定性拿回真实结果'
      + '（已完成→回读、被杀→重跑）；要显式强制重跑同一任务传 force:true。',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: '自包含的任务描述（worker 看不到本会话上下文，目标/范围/产出要求要写全）' },
        timeout: { type: 'integer', description: '超时秒数，默认 900，上限 3600' },
        force: { type: 'boolean', description: '跳过幂等去重，强制重跑同一任务（默认 false）' },
        provider: { type: 'string', description: '可选：覆盖 LLM provider（如 deepseek / sensenova）' },
        model: { type: 'string', description: '可选：覆盖 LLM model（如 deepseek-v4-flash / glm-5.2）' },
      },
      required: ['task'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object' }, render: renderJSON },
    timeoutMs: 3670000,
    execute: async (args, exec) => spawnWorker(args || {}, exec),
  })

  ctx.tools.register({
    name: 'worker_status',
    description: '查询某个 spawn_worker 的 run 结局（running/done/failed/killed）+ 尾部日志。'
      + '重启后 spawn_worker 报 "interrupted/outcome unknown" 时，用它确认 worker 真实结果（已落盘）。',
    parameters: {
      type: 'object',
      properties: { run_id: { type: 'string' } },
      required: ['run_id'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object' }, render: renderJSON },
    execute: async (args) => workerStatus(args || {}),
  })

  ctx.tools.register({
    name: 'worker_list',
    description: '列出最近的 spawn_worker run（可按 status 过滤），总览在飞/历史 worker。',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'running / done / failed / killed，不传=全部' },
        limit: { type: 'integer', description: '默认 20，上限 200' },
      },
      required: [],
      additionalProperties: false,
    },
    output: { schema: { type: 'object' }, render: renderJSON },
    execute: async (args) => ({ ok: true, workers: assetDb.workerList(args || {}) }),
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
    execute: async (args, exec) => authzDiff(args || {}, exec),
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

  ctx.tools.register({
    name: 'task_chain',
    description: '一条 objective 自动展开为任务依赖链（P2-2）：复用 plan_chain BFS 按 manifest requires/produces 凑链，'
      + '反向剪枝到达成 want 的最小链，落成 parent 串联的 once 调度任务——前置未完成不派单，parent 完成后调度器自动放行下一级（链式自动推进）。'
      + '默认 have=["domains"]、want=findings（资产收集→存活→指纹→N-day）。链尾多为 active 扫描且会自动执行，仅对已授权 scope 使用。',
    parameters: {
      type: 'object',
      properties: {
        program_id: { type: 'string', description: '不传则按当前会话工作区自动绑定' },
        objective: { type: 'string', description: '整体目标描述（写入每级任务作上下文，可选）' },
        want: { type: 'string', description: '目标能力，默认 findings（见 plan_chain）' },
        have: { type: 'array', items: { type: 'string' }, description: '起始已有能力，默认 ["domains"]' },
        priority: { type: 'integer', description: '链上任务优先级，默认 3' },
        parent_id: { type: 'integer', description: '把链挂在某个已有任务之后（可选）' },
      },
      required: [],
      additionalProperties: false,
    },
    output: { schema: { type: 'object' }, render: renderJSON },
    execute: async (args, exec) => taskChain(args || {}, exec),
  })

  ctx.tools.register({
    name: 'intel_hunt',
    description: 'component-vuln-intel（P9/P2-3）：指纹命中后查本地 nuclei 模板库找 tech 相关的 N-day 模板/CVE。'
      + '命中即自动产出一条 phase=vuln、priority=1 的 N-day 候选任务（普通 queued，非自动跑；tentative，验证附证据才 confirmed）。'
      + '未绑定 program 时仅返回模板列表不建任务。',
    parameters: {
      type: 'object',
      properties: {
        tech: { type: 'string', description: '技术栈/组件，如 weblogic / ruoyi / spring' },
        version: { type: 'string', description: '版本号（可选）' },
        program_id: { type: 'string', description: '归属项目；不传则按当前会话工作区自动绑定' },
        host: { type: 'string', description: '命中该指纹的主机（写入候选任务目标，可选）' },
      },
      required: ['tech'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object' }, render: renderJSON },
    execute: async (args, exec) => intelHunt(args || {}, exec),
  })

  ctx.tools.register({
    name: 'approval_request',
    description: '统一审批入口（fail-closed 之下的正规放行通道）：向人工提请审批。'
      + '类型判定口径：①整个注册域归属该项目（主体核证级证据：ICP 备案主体/官网品牌一致/收购公告/SRC 规则页明示）→ kind=scope-wildcard，'
      + '一次审批覆盖 *.example.com 全部子域；②仅单个子域有具体归属证据（CNAME 指向授权资产/内容同源比对）→ kind=scope-domain，'
      + 'subject 填完整子域，禁止拿裸 apex 走单域通道；③被排除资产的人工评估 → exclude-exception。'
      + '资产收集发现疑似 scope 外资产时必须提请，禁止只写事实不提请求，也禁止把归属不确定的资产凑数提请。'
      + '股权判据口径见 data/rules/src/equity-gate.md：100% 控股算、参股/投资不算、有自身 SRC 渠道的不并入。'
      + '登记是被动观察行为：批准前目标依旧被 scope-guard fail-closed 拒绝，授权边界不变。',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['scope-domain', 'scope-wildcard', 'exclude-exception'], description: '审批类型：scope-wildcard=整域授权（subject 填注册域 apex，如 example.com）；scope-domain=单子域授权（subject 填完整子域）；exclude-exception=被排除资产的例外评估（解除排除）' },
        subject: { type: 'string', description: '审批对象（域名；scope-wildcard 传注册域 apex 如 catpaw.com，scope-domain 传完整子域如 www.catpaw.com）' },
        program_name: { type: 'string', description: '必填：建议归属的 scope.yml 项目名（exclude-exception 为排除该域的项目名）' },
        equity_basis: { type: 'string', enum: ['控股/全资', '收购/财团', '品牌/产品线', '技术印证', '其他'], description: '股权/归属判据类型（必填）。整域（scope-wildcard）只接受 控股/全资 或 收购/财团。「技术印证」=CNAME 指向授权资产/内部部署域等部署关系' },
        independent_src: { type: 'string', enum: ['无', '有', '不确定'], description: '目标是否有自身 SRC 收洞渠道（scope-domain/scope-wildcard 必填；有→不并入本项目）' },
        corroboration: { type: 'string', description: '旁证（选填，如 "meituan.com 下 126 个内部部署域印证"）' },
        evidence: { type: 'string', description: '归属证据/依据摘要。单子域 ≥30 字且须具体归属证据；整域 ≥30 字且须主体核证级证据（备案主体/收购公告/SRC 规则页）' },
      },
      required: ['kind', 'subject', 'evidence'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object' }, render: renderJSON },
    execute: async (args, exec) => approvalRequest(args || {}, exec),
  })

  // xray webhook 接收器只在 web 宿主面启动（connection 服务存在时；headless worker 不起，避免 EADDRINUSE 噪声）。
  // preset 内挂载（sidecars:false）跳过。

  // 看板 Remote：仅在 connection 服务存在时挂载（headless 无此服务，gracefully 跳过）。
  // 用 child fiber 等待服务初始化，避免 bare ctx.get 在 carrier 就绪前静默失效。
  // module 级幂等守卫：DSH 启动期 connection 服务会短暂重配（webServer 就绪后再 re-provide 一次），
  // 导致 child fiber 二次激活、重复注册同名 prefix 路由。守卫保证只注册一次，杜绝 duplicate 报错。
  try {
    ctx.inject(['connection'], (child) => {
      child.effect(() => {
        if (dashboardRpcRegistered) return
        dashboardRpcRegistered = true
        const dispose = child.connection.rpc.handle('/silksec-dashboard',
          async (endpoint, payload) => {
            try {
              return { ok: true, value: await handleDashboardRpc(String(endpoint || ''), payload) }
            } catch (error) {
              return { ok: false, error: { code: 'internal', message: error?.message ?? String(error), details: {} } }
            }
          },
          { authority: 'loopback' })
        // P11：调度循环只随宿主面 bundle 加载启动（preset 的 agent 面挂载 sidecars:false，跳过；
        // agent 可能跑在 worker 线程，globalThis 不共享，单例守卫不够，只能从入口侧收敛）
        if (!config || config.sidecars !== false) startScheduler({ dataDir: DATA_DIR, audit, assetDb, exp, runWorker, pidAlive, getWorkspaceRegistry: () => workspaceRegistryRef, getSessionPersistence: () => sessionPersistenceRef })
        // xray webhook 同样只在 web 宿主面启动（模块内单例幂等，不随 fiber dispose 回收）
        if (!config || config.sidecars !== false) startXrayWebhook({ dataDir: DATA_DIR, assetDb, hostOf })
        return () => { void dispose() }
      }, 'sec-suite: dashboard rpc')
    })
  } catch (e) {
    process.stderr.write(`[sec-suite] dashboard RPC 挂载失败: ${e?.message ?? String(e)}\n`)
  }

  // P11 工作区融合：workspaceRegistry（dsh-web-app 组合）+ sessionPersistence（会话头部投影）。
  // 两个服务在 headless profile 不存在时 inject 回调永不触发，自然降级。
  try {
    ctx.inject(['workspaceRegistry'], (child) => {
      workspaceRegistryRef = child.workspaceRegistry
      child.effect(() => {
        try { pairWorkspaces() } catch { /* 配对失败不阻断 */ }
        return () => { workspaceRegistryRef = null }
      }, 'sec-suite: workspace pairing')
    })
  } catch { /* 无 workspaceRegistry（headless）*/ }
  try {
    ctx.inject(['sessionPersistence'], (child) => {
      sessionPersistenceRef = child.sessionPersistence
      child.effect(() => () => { sessionPersistenceRef = null }, 'sec-suite: session persistence')
    })
  } catch { /* 无 sessionPersistence */ }
}
