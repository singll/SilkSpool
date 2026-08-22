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
import { pbOutcome } from './experience.js'

export const name = 'sec-cli-adapter'
export const inject = ['tools']

// 测试/脚本用导出（插件加载器忽略多余导出）：scope 序列化回环与调度逻辑的单测入口
export const _internal = { serializeScope, scopeSaveProgram, scopeDeleteProgram, scopeList, checkTarget, parseYaml, sessionIdOf }

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
      if (p.finding_db) lines.push(`    finding_db: ${yamlQuote(p.finding_db)}`)
      lines.push('')
    }
  }
  lines.push('# 黑板/凭据（由系统运行时写入，勿手工编辑）', 'runtime:', '  credentials_ref: env                  # 凭据统一走 credentials 包 / .env 引用', '')
  return lines.join('\n')
}

const PROGRAM_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/
const RISK_LEVELS = ['passive', 'active', 'intrusive']

// spec: { name, platform, scope[], exclude[], max_risk, fixed_egress_ip, workspace, finding_db }
// 返回 { ok, error?, program }。fail-closed 语义不变：不在 scope.yml 的目标依然全拒绝。
function scopeSaveProgram(spec, isNew) {
  const name = String(spec.name || '').trim()
  if (!PROGRAM_NAME_RE.test(name)) return { ok: false, error: `非法项目名 ${name}（^[a-z0-9][a-z0-9-]{0,62}$）` }
  const scopeEntries = [...new Set((Array.isArray(spec.scope) ? spec.scope : []).map((s) => String(s).trim()).filter(Boolean))]
  if (!scopeEntries.length) return { ok: false, error: 'scope 至少一条授权条目（域名/IP/CIDR）' }
  const excludeEntries = [...new Set((Array.isArray(spec.exclude) ? spec.exclude : []).map((s) => String(s).trim()).filter(Boolean))]
  const maxRisk = String(spec.max_risk || 'active')
  if (!RISK_LEVELS.includes(maxRisk)) return { ok: false, error: `非法 max_risk ${maxRisk}（可选: ${RISK_LEVELS.join('/')}）` }

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
    },
  }
  if (spec.platform) entry.platform = String(spec.platform).trim()
  if (excludeEntries.length) entry.exclude = excludeEntries
  if (spec.finding_db) entry.finding_db = String(spec.finding_db).trim()
  if (idx >= 0) programs[idx] = entry
  else programs.push(entry)
  scope.programs = programs

  // 原子写 + 备份
  fs.copyFileSync(SCOPE_FILE, SCOPE_FILE + '.bak')
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
  fs.copyFileSync(SCOPE_FILE, SCOPE_FILE + '.bak')
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
  if (!allowRisk.includes(manifestRisk)) {
    return { allow: false, reason: `工具风险级 ${manifestRisk} 需要人工确认（allow_risk: ${allowRisk.join('/') }）`, needsApproval: true }
  }
  return { allow: true }
}

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
  const riskChk = checkRisk(String(manifest.risk || 'passive'), firstChk.programCfg)
  if (!riskChk.allow) {
    audit({ ts: Date.now(), run_id: runId, tool: toolName, decision: 'deny', reason: riskChk.reason })
    return { ok: false, run_id: runId, error: `scope-guard 拒绝: ${riskChk.reason}`, needs_approval: !!riskChk.needsApproval }
  }

  // S1 解析后校验（active+）：DNS 解析 IP 落内网/保留段且未授权 → 拒绝
  if (targets.length > 0) {
    const resolvedViolation = await verifyResolved(targets, manifest)
    if (resolvedViolation) {
      audit({ ts: Date.now(), run_id: runId, tool: toolName, decision: 'deny', reason: resolvedViolation })
      return { ok: false, run_id: runId, error: `scope-guard 解析后校验拒绝: ${resolvedViolation}` }
    }
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
  // sandbox（S2）：有 target_param 的网络工具经 bwrap 白名单隔离；本地审计工具不沙箱
  const sandbox = manifest.target_param ? buildSandboxCommand(binary, argv, runDir) : null
  const spawnCmd = sandbox ? sandbox.cmd : binary
  const spawnArgs = sandbox ? sandbox.args : argv
  const result = await new Promise((resolve) => {
    let child
    try {
      child = spawn(spawnCmd, spawnArgs, { env, cwd: runDir })
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
  try { pbOutcome({ name: `tool:${toolName}`, success: result.code === 0, duration_ms: meta.duration_ms }) } catch { /* 统计失败不阻断 */ }
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
  // 进程生命周期级：不绑 fiber dispose（fiber 重配回收不该关掉 webhook）
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

// worker 核心（工具与调度循环共用）。cwd 默认 runDir；调度任务传工作区路径——
// headless 会话 header cwd = workspace path → workspaceRegistry 自动归组 → 看板可跳链
async function runWorker({ task, cwd = null, timeoutSec = 900, originSessionId = null, enforceLimit = true }) {
  if (enforceLimit && activeWorkers >= MAX_WORKERS) {
    return { ok: false, busy: true, error: `worker 并发上限 ${MAX_WORKERS}，请稍后重试` }
  }
  const timeoutMs = Math.min(Number(timeoutSec) || 900, 3600) * 1000
  const runId = 'w' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex')
  const runDir = path.join(RESULTS_DIR, runId)
  fs.mkdirSync(runDir, { recursive: true })
  const workCwd = (cwd && fs.existsSync(cwd)) ? cwd : runDir

  const env = { ...process.env, DSH_HOME: DATA_DIR, PATH: '/usr/local/node/bin:' + (process.env.PATH || '') }
  audit({ ts: Date.now(), run_id: runId, tool: 'spawn_worker', decision: 'executed', detail: task.slice(0, 200), session_id: originSessionId })

  activeWorkers++
  const started = Date.now()
  const result = await new Promise((resolve) => {
    const out = fs.createWriteStream(path.join(runDir, 'worker.log'))
    const child = spawn(NODE_BIN, [DSH_BIN, '--profile', 'headless', task], {
      env, cwd: workCwd,
    })
    child.stdout.pipe(out)
    child.stderr.pipe(out)
    const killer = setTimeout(() => { child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 5000).unref() }, timeoutMs)
    child.on('error', (e) => { clearTimeout(killer); resolve({ code: null, error: String(e.message) }) })
    child.on('close', (code, signal) => { clearTimeout(killer); resolve({ code, signal }) })
  })
  activeWorkers--

  const meta = {
    run_id: runId, tool: 'spawn_worker', task, cwd: workCwd, started_at: new Date(started).toISOString(),
    duration_ms: Date.now() - started, exit_code: result.code ?? null, session_id: originSessionId,
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

async function spawnWorker(args, exec) {
  const task = String(args.task || '').trim()
  if (!task) return { ok: false, error: 'task 不能为空' }
  return runWorker({ task, timeoutSec: args.timeout, originSessionId: sessionIdOf(exec) })
}

// ==============================================================================
// P11 定时任务调度循环（sec-suite host 面，仅 web profile 启动）
// 60s tick → SQLite 事务原子认领到期任务 → runWorker(cwd=工作区路径) → 收尾续期。
// 重启恢复：任务状态在 SQLite，过期的 interval 按 latest-only 补触发最近一次。
// ==============================================================================

const SCHEDULER_TICK_MS = 60000

function workspacePathOfProgram(programId) {
  const p = assetDb.listPrograms().find((x) => x.id === programId)
  return (p && p.workspace_path) || null
}

// 工作区会话归组 reconcile：headless worker / CLI 产生的会话按 header cwd 匹配工作区路径，
// attachSession 幂等（已归组则无写）。registry 对后期 cwd-only 会话不自动归组（上游语义），这里补齐。
async function reconcileWorkspaceSessions() {
  if (!workspaceRegistryRef || !sessionPersistenceRef) return
  let headers
  try { headers = await sessionPersistenceRef.list() } catch { return }
  let workspaces
  try { workspaces = workspaceRegistryRef.list() } catch { return }
  const byPath = {}
  for (const w of workspaces) byPath[w.path] = w
  for (const h of headers) {
    const w = h && h.cwd ? byPath[String(h.cwd)] : null
    if (!w) continue
    try { await w.attachSession(h.id) } catch { /* 单个失败不影响其余 */ }
  }
}

// worker.log 尾部噪声（headless 进程 stderr 杂讯）不进入任务摘要
const WORKER_NOISE_RE = /ExperimentalWarning|trace-warnings|EADDRINUSE|xray webhook 启动失败/

async function schedulerTick() {
  let due
  try { due = assetDb.taskClaimDue(Date.now()) } catch (e) {
    process.stderr.write(`[sec-suite] 调度认领失败: ${e?.message ?? String(e)}\n`)
    return
  }
  for (const task of due) {
    // 并发上限时延后再跑（next_run_at 不动，下个 tick 重试——但 status 已是 running，需回滚）
    if (activeWorkers >= MAX_WORKERS) {
      try { assetDb.taskUpdate({ id: task.id, status: 'queued', note: 'worker 并发已满，延后到下一 tick' }) } catch { /* ignore */ }
      continue
    }
    const prompt = `[定时任务 #${task.id}${task.phase ? ' / ' + task.phase : ''}] ${task.objective}`
    const cwd = workspacePathOfProgram(task.program_id)
    audit({ ts: Date.now(), run_id: '-', tool: 'scheduler', decision: 'executed', detail: { task_id: task.id, program_id: task.program_id } })
    try {
      const r = await runWorker({ task: prompt, cwd, timeoutSec: 1800, enforceLimit: false })
      const note = (r.tail || '').split('\n').filter((l) => l.trim() && !WORKER_NOISE_RE.test(l)).slice(-3).join(' ').slice(0, 300)
      assetDb.taskFinishScheduledRun({ id: task.id, ok: !!r.ok, run_id: r.run_id || '', note })
    } catch (e) {
      try { assetDb.taskFinishScheduledRun({ id: task.id, ok: false, run_id: '', note: `调度执行异常: ${e?.message ?? String(e)}`.slice(0, 300) }) } catch { /* ignore */ }
    }
  }
  // 顺带做工作区会话归组（轻量、幂等）
  try { await reconcileWorkspaceSessions() } catch { /* 归组失败不阻断调度 */ }
}

// 跨进程单例（P0-1）：插件被宿主面与每个 agent/worker 子进程分别加载，globalThis 不跨进程，
// 模块级/globalThis 单例都挡不住多进程各起调度循环（实测 10+ PID 各跑 tick + database is locked）。
// 用文件锁 data/scheduler.lock（持有者 PID + 心跳时间戳）保证全机只有一个进程真正认领任务。
const SCHEDULER_LOCK = path.join(DATA_DIR, 'scheduler.lock')
const SCHEDULER_LOCK_STALE_MS = 180000 // 3 分钟无心跳（容 3 个 tick 未刷新）视为死锁，可抢占

function pidAlive(pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}
// 抢锁：无锁文件 / 持有者已死 / 心跳超期 → 写入自己 PID。返回是否持有。
function acquireSchedulerLock() {
  try {
    const cur = JSON.parse(fs.readFileSync(SCHEDULER_LOCK, 'utf8'))
    if (cur && cur.pid && cur.pid !== process.pid && pidAlive(cur.pid) && (Date.now() - (cur.ts || 0) < SCHEDULER_LOCK_STALE_MS)) {
      return false // 活锁被他人持有
    }
  } catch { /* 无锁文件或损坏 → 可抢 */ }
  try { fs.writeFileSync(SCHEDULER_LOCK, JSON.stringify({ pid: process.pid, ts: Date.now() })); return true } catch { return false }
}
function holdsSchedulerLock() {
  try { return JSON.parse(fs.readFileSync(SCHEDULER_LOCK, 'utf8')).pid === process.pid } catch { return false }
}

function startScheduler() {
  if (globalThis.__silksecScheduler) return
  if (!acquireSchedulerLock()) return // 已有活的调度进程持锁，本进程不启动（收敛多进程内讧）
  // 启动即回收：新进程启动意味着旧进程已终止，其派发的所有 running scheduled 任务均为孤儿 → 无条件回收（maxAge=0）
  try { assetDb.taskReapStale(0) } catch { /* 启动僵尸回收，失败不阻断 */ }
  process.once('exit', () => { try { if (holdsSchedulerLock()) fs.unlinkSync(SCHEDULER_LOCK) } catch { /* ignore */ } })
  let tick = 0
  globalThis.__silksecScheduler = setInterval(() => {
    // 心跳续锁 + 持有校验：丢锁则尝试重夺，仍被他人活持则本 tick 跳过（不认领）
    if (!holdsSchedulerLock() && !acquireSchedulerLock()) return
    try { fs.writeFileSync(SCHEDULER_LOCK, JSON.stringify({ pid: process.pid, ts: Date.now() })) } catch { /* ignore */ }
    if ((++tick % 10) === 0) { try { assetDb.taskReapStale() } catch { /* ignore */ } } // 每 10 tick 周期回收
    schedulerTick().catch(() => {})
  }, SCHEDULER_TICK_MS)
  globalThis.__silksecScheduler.unref?.()
  process.stderr.write(`[sec-suite] 定时任务调度循环已启动（60s tick, pid=${process.pid}）\n`)
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

// P2-2：一条 objective 自动展开任务依赖链。
// 复用 planChain BFS 求可达工具链 → 反向剪枝到达成 want 的最小链（去掉贪心带入的旁支）→
// 落成 parent 串联的 once 调度任务：head 立即到期，子任务由 taskClaimDue 的「前置=done」gate 逐级放行 → 链式自动推进。
function taskChain(args, exec) {
  const programId = resolveProgramId(args.program_id, exec)
  if (!programId) return { ok: false, error: 'program_id 缺失且当前会话未在已绑定工作区（传 program_id，见 program_list）' }
  const want = String(args.want || 'findings').trim()
  const have = (Array.isArray(args.have) && args.have.length) ? args.have.map(String) : ['domains']
  const priority = Number.isInteger(args.priority) ? args.priority : 3
  const objectiveCtx = String(args.objective || '').trim()

  // 1) 复用 planChain BFS：验证可达 + 得到有序（含冗余旁支）工具链
  const plan = planChain({ have, want })
  if (!plan.ok) return { ok: false, error: plan.error, have, want, hint: '调整 have/want 或检查 manifest 的 requires/produces' }

  // 2) 反向剪枝：从 want 回溯，只保留 produces 命中「所需能力」的工具，逐级把其 requires 并入所需集
  const needed = new Set([want])
  const keep = []
  for (let i = plan.chain.length - 1; i >= 0; i--) {
    const m = loadManifest(plan.chain[i])
    if (!m) continue
    const produces = Array.isArray(m.produces) ? m.produces : []
    if (produces.some((p) => needed.has(p))) {
      keep.unshift(m)
      for (const r of (Array.isArray(m.requires) ? m.requires : [])) needed.add(r)
    }
  }
  if (!keep.length) return { ok: false, error: `剪枝后链为空（want=${want} 无产出工具）`, plan_chain: plan.chain }

  // 3) 幂等去重：同 program 下已有未终结的同 want 链则不重复展开
  const marker = `[链:${want}]`
  const dup = assetDb.taskList({ programId, q: marker, limit: 100 })
    .find((t) => ['queued', 'running', 'blocked'].includes(t.status))
  if (dup) return { ok: true, program_id: programId, want, deduped: true, chain: keep.map((m) => m.name), hint: `已存在未完成的 ${want} 任务链（起始 #${dup.id}），未重复展开` }

  // 4) 建 parent 串联的 once 调度任务（at 取小幅未来以过 normalizeSchedule 校验；实际次序由 parent gate 决定）
  const stageToPhase = { recon: 'recon', vuln: 'vuln', audit: 'code-audit' }
  const base = Date.now()
  const N = keep.length
  const ids = []
  let parentId = Number.isInteger(args.parent_id) ? args.parent_id : null
  for (let i = 0; i < N; i++) {
    const m = keep[i]
    const produces = (Array.isArray(m.produces) ? m.produces : []).join('+') || m.name
    const objective = `${marker} [${i + 1}/${N}] ${m.name}（产出 ${produces}）`
      + `${objectiveCtx ? `｜目标：${objectiveCtx}` : ''}`
      + `${m.stage === 'vuln' ? '。N-day/漏洞验证——结果 tentative，附证据才 confirmed' : ''}`
    const r = assetDb.taskCreate({
      program_id: programId,
      phase: stageToPhase[m.stage] || m.stage || '',
      objective,
      priority,
      parent_id: parentId,
      session_id: sessionIdOf(exec),
      schedule: { kind: 'once', at: base + (i + 1) * 2000 },
    })
    if (!r.ok) return { ok: false, error: `第 ${i + 1} 步建任务失败: ${r.error}`, created: ids }
    ids.push(r.id)
    parentId = r.id
  }
  audit({ ts: Date.now(), run_id: '-', tool: 'task_chain', decision: 'executed', detail: { program_id: programId, want, chain: keep.map((m) => m.name), task_ids: ids }, session_id: sessionIdOf(exec) })
  return { ok: true, program_id: programId, want, have, chain: keep.map((m) => m.name), task_ids: ids, note: `已展开 ${N} 级依赖链（once 调度，parent 串联）：前置未完成不派单，parent 完成后调度器自动放行下一级。` }
}

// ==============================================================================
// 看板 Remote（Host↔Client RPC 通道 /silksec-dashboard，authority=loopback）
// 只读查询 + 受控写（打标 findingUpdate / 事实纠正 factCorrect·factDeprecate /
// P11：授权管理 scopeSaveProgram·scopeDeleteProgram / 工作区绑定 programBindWorkspace / 任务立即跑 taskRunNow）。
// 底层直接复用 assetDb 现有函数——「一份校验、一条 audit.jsonl、一个真相源」。
// ==============================================================================

const FINDING_TAG_STATUS = ['confirmed', 'false_positive', 'ignored', 'new', 'submitted', 'accepted', 'dup']
let dashboardRpcRegistered = false

async function handleDashboardRpc(endpoint, payload) {
  const p = (payload && typeof payload === 'object') ? payload : {}
  switch (endpoint) {
    case 'stats':
      return assetDb.stats()
    // ---- P11：工作区 / 会话 / 授权管理 ----
    case 'workspaces':
      pairWorkspaces() // 顺手做幂等配对（registry 后到场景）
      return workspacesList()
    case 'programBindWorkspace': {
      const programId = String(p.program_id || '')
      if (!programId) throw new Error('programBindWorkspace 需要 program_id')
      const workspaceId = p.workspace_id ? String(p.workspace_id) : null
      let wsPath = null
      if (workspaceId && workspaceRegistryRef) {
        const ws = workspaceRegistryRef.get(workspaceId)
        if (!ws) throw new Error(`工作区不存在: ${workspaceId}`)
        wsPath = ws.path
      }
      if (!assetDb.bindProgramWorkspace(programId, workspaceId, wsPath)) throw new Error(`program 不存在: ${programId}`)
      audit({ ts: Date.now(), run_id: '-', tool: 'dashboard.programBindWorkspace', decision: 'executed', detail: { program_id: programId, workspace_id: workspaceId } })
      return { ok: true, program_id: programId, workspace_id: workspaceId }
    }
    case 'scopeList':
      pairWorkspaces()
      return scopeList()
    case 'scopeSaveProgram':
      return scopeSaveProgram(p, !!p.is_new)
    case 'scopeDeleteProgram':
      return scopeDeleteProgram(p.name)
    case 'taskRunNow': {
      const id = Number(p.id)
      if (!id) throw new Error('taskRunNow 需要 id')
      audit({ ts: Date.now(), run_id: '-', tool: 'dashboard.taskRunNow', decision: 'executed', detail: { id } })
      return assetDb.taskRunNow(id)
    }
    case 'taskCancel': {
      const id = Number(p.id)
      if (!id) throw new Error('taskCancel 需要 id')
      const r = assetDb.taskUpdate({ id, status: 'cancelled', note: String(p.note || '看板手动取消') })
      audit({ ts: Date.now(), run_id: '-', tool: 'dashboard.taskCancel', decision: 'executed', detail: { id } })
      return r
    }
    case 'reportBuild': {
      const r = assetDb.buildReport({
        hostLike: String(p.host_like || ''), programId: String(p.program_id || ''),
        status: String(p.status || ''), sinceDays: Number(p.since_days) || 0,
      })
      let content = ''
      try { content = fs.readFileSync(r.file, 'utf8') } catch { /* 读回失败仅少 content，不阻断 */ }
      audit({ ts: Date.now(), run_id: '-', tool: 'dashboard.reportBuild', decision: 'executed', detail: { file: r.file, total: r.total } })
      return { ...r, content }
    }
    case 'evalStats':
      return assetDb.evalStats()
    case 'audit':
      return { rows: tailAudit(Math.min(Number(p.limit) || 120, 300)) }
    case 'assets': {
      const filters = { hostLike: String(p.q || ''), type: String(p.type || ''), programId: String(p.program_id || '') }
      const limit = Math.min(Number(p.limit) || 20, 200)
      const offset = Math.max(0, Number(p.offset) || 0)
      return { rows: assetDb.queryAssets({ ...filters, limit, offset, sort: String(p.sort || ''), dir: String(p.dir || '') }), total: assetDb.countAssets(filters) }
    }
    case 'endpoints': {
      const filters = { host: String(p.host || ''), pathLike: String(p.q || ''), programId: String(p.program_id || '') }
      const limit = Math.min(Number(p.limit) || 20, 200)
      const offset = Math.max(0, Number(p.offset) || 0)
      return { rows: assetDb.queryEndpoints({ ...filters, limit, offset, sort: String(p.sort || ''), dir: String(p.dir || '') }), total: assetDb.countEndpoints(filters) }
    }
    case 'findings': {
      const filters = {
        severity: String(p.severity || ''), status: String(p.status || ''),
        programId: String(p.program_id || ''), q: String(p.q || ''),
      }
      const limit = Math.min(Number(p.limit) || 20, 200)
      const offset = Math.max(0, Number(p.offset) || 0)
      return { rows: assetDb.queryFindings({ ...filters, limit, offset, sort: String(p.sort || ''), dir: String(p.dir || '') }), total: assetDb.countFindings(filters) }
    }
    case 'findingGet': {
      const id = Number(p.id)
      if (!id) throw new Error('findingGet 需要 id')
      return assetDb.findingGet(id)
    }
    case 'blackboard':
      return assetDb.bbGet()
    case 'facts': {
      const filters = {
        program_id: String(p.program_id || ''), category: String(p.category || ''),
        q: String(p.q || ''), confidence: String(p.confidence || ''),
      }
      const limit = Math.min(Number(p.limit) || 20, 200)
      const offset = Math.max(0, Number(p.offset) || 0)
      return { rows: assetDb.factSearch({ ...filters, limit, offset }), total: assetDb.countFacts(filters) }
    }
    case 'factGraph': {
      const programId = String(p.program_id || '')
      const factKey = String(p.fact_key || '')
      if (!programId || !factKey) throw new Error('factGraph 需要 program_id 与 fact_key')
      return assetDb.factGraph(programId, factKey)
    }
    case 'programs':
      return assetDb.listPrograms()
    case 'tasks': {
      const filters = {
        programId: String(p.program_id || ''), status: String(p.status || ''),
        phase: String(p.phase || ''), q: String(p.q || ''),
      }
      const limit = Math.min(Number(p.limit) || 20, 200)
      const offset = Math.max(0, Number(p.offset) || 0)
      return { rows: assetDb.taskList({ ...filters, limit, offset }), total: assetDb.countTasks(filters) }
    }
    case 'sessions':
      return sessionsList(String(p.workspace_id || ''))
    case 'findingUpdate': {
      const id = Number(p.id)
      const status = String(p.status || '')
      if (!id || !FINDING_TAG_STATUS.includes(status)) {
        throw new Error(`findingUpdate 需要合法 id 与 status（${FINDING_TAG_STATUS.join('/')}）`)
      }
      const r = assetDb.updateFinding({ id, status, note: String(p.note || ''), bounty: p.bounty, vendor_status: String(p.vendor_status || '') })
      audit({ ts: Date.now(), run_id: '-', tool: 'dashboard.findingUpdate', decision: 'executed', detail: { id, status, bounty: p.bounty ?? null } })
      return r
    }
    case 'factCorrect': {
      const programId = String(p.program_id || '')
      const factKey = String(p.fact_key || '')
      if (!programId || !factKey) throw new Error('factCorrect 需要 program_id 与 fact_key')
      const cur = assetDb.factGet(programId, factKey)
      if (!cur) return { ok: false, error: `fact 不存在: ${programId}/${factKey}` }
      // 只覆盖显式提供的字段，其余保留原值；confidence 固定升为 confirmed
      const r = assetDb.factUpsert({
        program_id: programId, fact_key: factKey,
        category: p.category !== undefined && p.category !== null ? String(p.category) : cur.category,
        summary: p.summary !== undefined && p.summary !== null ? String(p.summary) : cur.summary,
        body: p.body !== undefined && p.body !== null ? String(p.body) : cur.body,
        confidence: 'confirmed',
        pinned: cur.pinned, related_finding_id: cur.related_finding_id, source: cur.source,
      })
      audit({ ts: Date.now(), run_id: '-', tool: 'dashboard.factCorrect', decision: 'executed', detail: { program_id: programId, fact_key: factKey } })
      return r
    }
    case 'factDeprecate': {
      const programId = String(p.program_id || '')
      const factKey = String(p.fact_key || '')
      if (!programId || !factKey) throw new Error('factDeprecate 需要 program_id 与 fact_key')
      const cur = assetDb.factGet(programId, factKey)
      if (!cur) return { ok: false, error: `fact 不存在: ${programId}/${factKey}` }
      const r = assetDb.factUpsert({
        program_id: programId, fact_key: factKey,
        category: cur.category, summary: cur.summary, body: cur.body,
        confidence: 'deprecated', pinned: cur.pinned,
        related_finding_id: cur.related_finding_id, source: cur.source,
      })
      audit({ ts: Date.now(), run_id: '-', tool: 'dashboard.factDeprecate', decision: 'executed', detail: { program_id: programId, fact_key: factKey } })
      return r
    }
    default:
      throw new Error(`未知看板端点: ${endpoint}`)
  }
}

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
    execute: async (args, exec) => spawnWorker(args || {}, exec),
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
        if (!config || config.sidecars !== false) startScheduler()
        // xray webhook 同样只在 web 宿主面启动（模块内单例幂等，不随 fiber dispose 回收）
        if (!config || config.sidecars !== false) startXrayWebhook()
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
