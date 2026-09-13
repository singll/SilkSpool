// ==============================================================================
// SilkSecAgent 安全套件（dsh 原生插件；无额外 npm 依赖，角色 YAML 使用系统 PyYAML）
//
// 职责（对应方案 §5.1 / §九）：
//   scope-guard     授权白名单硬校验（data/scope.yml）+ 风险四级 + 全量审计
//                   —— fail-closed：无授权记录的目标一律拒绝，不依赖模型自觉
//   sec-cli-adapter authz_diff 越权对比 harness + 定时调度循环 + 看板 RPC 宿主
//                   （run_cli/grep_result/page_result 等 CLI 工具已迁 exec 域，
//                   经 bus 兼容别名 grep_result→exec_grep_result 等路由）
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
import * as assetDb from './asset-db.js'
import * as exp from './experience.js'
import { startXrayWebhook } from './webhook.js'
import { startScheduler } from './scheduler.js'
import { listSessionHeaders } from './host-compat.js'
import { initDashboardRpc, handleDashboardRpc } from './dashboard-rpc.js'

export const name = 'sec-cli-adapter'
export const inject = ['tools']

const DATA_DIR = process.env.SEC_DATA_DIR || '/opt/silkspool/dsh/data'
const SCOPE_FILE = process.env.SEC_SCOPE_FILE || path.join(DATA_DIR, 'scope.yml')
const TOOLS_DIR = path.join(DATA_DIR, 'tools.d')
const RESULTS_DIR = path.join(DATA_DIR, 'results')
const AUDIT_LOG = path.join(DATA_DIR, 'audit.jsonl')
const EGRESS_PROXY = process.env.SEC_EGRESS_PROXY || ''

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
let secDomainBusRef = null       // ctx.secDomainBus（v5 领域总线；看板 findings/findingGet/findingUpdate 三 case 切 vuln.* RPC）

// dashboard-rpc.js 依赖注入（与 startScheduler/startXrayWebhook 同一参数注入模式，避免循环依赖）。
// 函数声明提升保证此处引用安全；workspaceRegistryRef 经 getter 惰性读取（fiber 注入前为 null）。
initDashboardRpc({
  dataDir: DATA_DIR, audit, tailAudit, assetDb, exp,
  listManifests, loadManifest, resolveProgramId, sessionIdOf,
  pairWorkspaces, workspacesList, sessionsList,
  scopeList, scopeSaveProgram, scopeDeleteProgram,
  approvalDecideAction,
  getWorkspaceRegistry: () => workspaceRegistryRef,
  getSecDomainBus: () => secDomainBusRef,
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
// scheduler 派发 + radar 事件供每日 recon 链 ledger_radar_drain 兜底）。best-effort：入队失败不影响批准结果。
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
    const objective = `[审批入队] 新授权域名 ${host} 首轮资产面收集：ledger_radar_drain 读入 scope-approved 事件 → subfinder 子域枚举 → dnsx 解析 → httpx 存活+指纹 asset_upsert/endpoint_upsert 入图谱。只做资产收集，禁止主动漏洞探测。完成后 ledger_log_attempt 落台账（asset=${host}，card_id=- 非卡片动作，N/A 须理由）。`
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
  // v4.5 异步审批：intrusive 工具放行。exec 域 run_cli 遇 allow_risk 拒绝（needsApproval 路径）自动落库，
  // 不经 approval_request 工具（agent 无法替人工编 evidence）。批准 = 写项目 allow_intrusive_tools
  // 白名单（scope.yml rules 新字段），下个调度周期任务重试时风险闸自然放行；驳回 = 维持拒绝。
  // 审计全量保留（audit.jsonl deny→approve 链条完整）。
  'tool-intrusive': {
    label: '侵入工具放行',
    validate() { return { ok: false, error: 'tool-intrusive 由 exec 域 run_cli 拒绝点自动提请（payload 带工具/风险级/目标/参数），agent 不可直接提请' } },
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
  // P2-3 知识采纳：外部经验（writeup/BugHunter 案例蒸馏出的可迁移模式）经人工审批转正 exp_cards。
  // subject = 经验卡 scenario 一句话；payload = { card_id?, draft, source_url }。
  // card_id 有（或 scenario 已有同款卡）→ 转正对应 candidate 卡；只有 draft → 落新卡
  // （source=external, confidence=low——外部来源置信低起点，后续靠实战反馈信号演进）并直接转正。
  // status 语义（experience 插件 exp_cards + memcore 治理列）：candidate=入口待评审 → active=转正，
  // cooling=负反馈降级，archived=弃置；exp_cards 本表无 tainted 列（那是 kb_docs 的），不涉及。
  // 直写路径：本文件与 experience.js 共用同一 SQLite（asset-db getDb → asset-graph.db）。
  'knowledge-adopt': {
    label: '知识采纳',
    validate({ subject, payload, evidence }) {
      const scenario = String(subject || '').trim()
      if (scenario.length < 8) return { ok: false, error: `subject 必填（经验卡 scenario 一句话，≥8 字，当前 ${scenario.length} 字）` }
      const p = payload && typeof payload === 'object' ? payload : {}
      const draft = String(p.draft || '').trim()
      if (draft.length < 50) return { ok: false, error: `payload.draft 必填且 ≥50 字（蒸馏后的可迁移模式，当前 ${draft.length} 字）——原文摘抄/链接描述不构成 draft` }
      const sourceUrl = String(p.source_url || '').trim()
      if (!/^https?:\/\/\S{4,}$/.test(sourceUrl)) return { ok: false, error: 'payload.source_url 必填（外部来源完整 URL，http(s):// 开头）——外部知识须可溯源' }
      const cardId = (p.card_id === undefined || p.card_id === null || p.card_id === '') ? null : Number(p.card_id)
      if (cardId !== null && (!Number.isInteger(cardId) || cardId <= 0)) {
        return { ok: false, error: `payload.card_id 须为正整数（exp_cards.id），收到: ${p.card_id}` }
      }
      if (String(evidence || '').trim().length < 30) {
        return { ok: false, error: 'evidence 须 ≥30 字（为什么值得采纳：覆盖了哪个知识缺口/哪个案例支撑/与现有经验卡的差异）' }
      }
      return { ok: true, value: { payload: { card_id: cardId, draft, source_url: sourceUrl } } }
    },
    onApprove({ subject, program_name, payload, evidence }) {
      const scenario = String(subject || '').trim()
      const p = payload && typeof payload === 'object' ? payload : {}
      const draft = String(p.draft || '').trim()
      const sourceUrl = String(p.source_url || '').trim()
      const cardId = p.card_id ? Number(p.card_id) : null
      // 降级出口：exp_cards 未初始化（experience 插件惰性建表）或直写失败——批准本身有效，
      // 转正动作留给人，note 必须带全草稿摘要（看板可复制）。
      const degrade = (why) => ({ ok: true, note: `已批准——请按草稿在经验库手工转正（${why}）。草稿：${draft}${draft.length > 300 ? draft.slice(0, 300) + '…' : ''}；来源 ${sourceUrl || '未提供'}` })
      let d
      try {
        d = assetDb.getDb()
        if (!d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='exp_cards'").get()) return degrade('exp_cards 表尚未初始化')
      } catch (e) { return degrade(`经验库不可达: ${e?.message ?? e}`) }
      const now = Date.now()
      // 治理列（memcore 加载后才有）：无 status 列时卡默认即生效，无 candidate→active 语义
      const gov = d.prepare('PRAGMA table_info(exp_cards)').all().some((c) => String(c.name) === 'status')
      const reason = `知识采纳审批批准（来源 ${sourceUrl || '未提供'}${evidence ? '；依据: ' + String(evidence).slice(0, 120) : ''}）`
      // card_id 缺席时按 scenario 幂等对卡（exp_cards.scenario UNIQUE，裸 INSERT 会撞）
      const target = cardId
        ? d.prepare('SELECT id, scenario, status FROM exp_cards WHERE id = ?').get(cardId)
        : d.prepare('SELECT id, scenario, status FROM exp_cards WHERE scenario = ?').get(scenario)
      try {
        if (target) {
          if (!target.status || target.status !== 'active') {
            if (gov) {
              // 优先 experience 晋升通道（memcore_events 治理留痕）；未加载/失败回退直写治理列
              const promo = exp.expPromote ? exp.expPromote({ id: target.id, reason, actor: 'dashboard' }) : null
              if (!promo || !promo.ok) d.prepare("UPDATE exp_cards SET status='active', status_at=? WHERE id=?").run(now, target.id)
            }
          }
          if (draft) {
            d.prepare('UPDATE exp_cards SET takeaway=?, last_validated_at=? WHERE id=?').run(draft, now, target.id)
            try { d.prepare('UPDATE exp_fts SET takeaway=? WHERE rowid=?').run(draft, target.id) } catch { /* FTS 行残留不阻断转正 */ }
          }
          return { ok: true, note: `经验卡 #${target.id}（${target.scenario}）已转正 active${gov ? '' : '（memcore 未加载，仅更新 takeaway/时效）'}${draft ? '，takeaway 已按审批草稿覆盖' : ''}——检索面即时生效` }
        }
        // 无对卡：draft 落新卡并直接转正
        const r = gov
          ? d.prepare(`INSERT INTO exp_cards (scenario, takeaway, chain, attempts, evidence, source, confidence, created_at, last_validated_at, mem_class, status, status_at, justification) VALUES (?, ?, '[]', '[]', ?, 'external', 'low', ?, ?, 'permanent', 'active', ?, ?)`)
            .run(scenario, draft, JSON.stringify([`knowledge-adopt:${sourceUrl}`]), now, now, now, reason)
          : d.prepare(`INSERT INTO exp_cards (scenario, takeaway, chain, attempts, evidence, source, confidence, created_at, last_validated_at) VALUES (?, ?, '[]', '[]', ?, 'external', 'low', ?, ?)`)
            .run(scenario, draft, JSON.stringify([`knowledge-adopt:${sourceUrl}`]), now, now)
        const newId = Number(r.lastInsertRowid)
        try { d.prepare("INSERT INTO exp_fts (rowid, scenario, takeaway, chain) VALUES (?, ?, ?, '[]')").run(newId, scenario, draft) } catch { /* FTS 索引失败不阻断转正 */ }
        return { ok: true, note: `外部经验已按审批草稿落卡 #${newId} 并直接转正 active（source=external, confidence=low——后续靠实战反馈信号升置信）；scenario: ${scenario}` }
      } catch (e) { return degrade(`直写失败: ${e?.message ?? e}`) }
    },
  },
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
  const headers = Object.create(null)
  const diagnostics = []
  if (sessionPersistenceRef) {
    try {
      const result = await listSessionHeaders(sessionPersistenceRef)
      diagnostics.push(...result.diagnostics)
      for (const h of result.headers) headers[h.id] = h
    } catch (e) { diagnostics.push({ code: 'E_SESSION_LIST', message: e.message }) }
  } else {
    diagnostics.push({ code: 'E_SESSION_PERSISTENCE_UNAVAILABLE' })
  }
  const items = ws.sessionIds.map((id) => {
    const h = headers[String(id)] || null
    if (!h) diagnostics.push({ code: 'E_SESSION_HEADER_MISSING', id: String(id) })
    return { id: String(id), created_at: h?.createdAt ?? null, metadata_available: !!h }
  })
  return { available: true, items, partial: diagnostics.length > 0, diagnostics,
    workspace: { id: String(ws.id), title: ws.title, path: ws.path } }
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

// RoE（Rules of Engagement，交战规则）：每次 spawn 注入任务文本末尾的硬约束块。
// BugHunter 血泪条款：子代理 scope 不隐式继承。锚点子串用于幂等——task 已含（重试/链式
// 复用同一文本）则不重复堆叠，注入只追加不内嵌，保证确定性（dedupeKey 不受影响）。
const ROE_ANCHOR = 'Rules of Engagement 交战规则'
const ROE_BLOCK = [
  `【${ROE_ANCHOR}（宿主注入，硬约束，与本任务描述冲突时以本块为准）】`,
  '1. 目标列表必须作为数据逐字出现在本任务里；「目标资产」「上述范围」式指代无效——未逐字列出的目标一律视为未授权，不要尝试打点。',
  '2. 测程中新发现的主机（CT 日志/JS 文件/CNAME 爆出的）一律 report-only：只记录上报，禁止探测/扫描/打点；要纳入 scope 须先走 scope 审批。',
  '3. 「read-only/只读」展开为动词清单：GET、HEAD、OPTIONS、DNS 查询、被动指纹采集；POST/PUT/DELETE/PATCH 及一切写操作动词（create/update/generate/refund…）不在只读范围内。',
  '4. 越权接触的主机会被 scope-audit 标记（audit.jsonl deny 记录）——scope-guard 是 fail-closed 硬校验，不依赖你的自觉；被拒后不要换姿势重试，改走审批。',
  '5. 只读工具（passive 级）打写动词路径（如 /api/generate、/refund/batch/status）会被 scope-guard S5 写动词守卫拒绝；确需写操作须改用 active/intrusive 风险级的工具并走审批。',
].join('\n')

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
async function runWorker({ task, cwd = null, timeoutSec = 900, originSessionId = null, enforceLimit = true, dedupeKey = null, provider = null, model = null, reasoningEffort = null, phase = null }) {
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
  // RoE 契约注入：子代理 scope 不隐式继承——交战规则随任务文本逐字下发（含 S5 写动词守卫提示）。
  // worker 的 headless prompt 就是这段文本（无独立 AGENTS.md 读取环节），拼在 task 后即实际生效。
  // 幂等：task 已含 RoE 锚点不重复堆叠；注入是 task 的确定性函数 → dedupeKey/恢复语义不受影响。
  const fullTask = task.includes(ROE_ANCHOR) ? task : `${task}\n\n${ROE_BLOCK}`
  dshArgs.push(fullTask)

  const env = { ...process.env, DSH_HOME: DATA_DIR, PATH: '/usr/local/node/bin:' + (process.env.PATH || '') }
  if (phase) env.SEC_WORKER_PHASE = String(phase)
  audit({ ts: Date.now(), run_id: runId, tool: 'spawn_worker', decision: 'executed', detail: fullTask.slice(0, 200), session_id: originSessionId })

  activeWorkers++
  const started = Date.now()
  const result = await new Promise((resolve) => {
    const out = fs.createWriteStream(path.join(runDir, 'worker.log'))
    const child = spawn(NODE_BIN, dshArgs, {
      env, cwd: workCwd, detached: true,
    })
    // 注册表登记（带 pid）：供重启对账 + 重试幂等恢复。登记的是含 RoE 的实际 prompt（fullTask）。登记失败不阻断执行。
    try {
      assetDb.workerRegister({ run_id: runId, dedupe_key: dedupeKey, task: fullTask, cwd: workCwd, pid: child.pid,
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
    run_id: runId, tool: 'spawn_worker', task: fullTask, cwd: workCwd, started_at: new Date(started).toISOString(),
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
// 注册
// ==============================================================================

function renderJSON(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 1) }]
}

export function apply(ctx, config) {
  // P6：启动时把 scope.yml 程序镜像到 programs 表（幂等）
  try { syncPrograms() } catch { /* 镜像失败不影响插件加载 */ }

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
  // v5 领域总线（sec-domain-bus 插件 provide）：dashboard-rpc 各域 case 走总线 query/dispatch
  // （vuln/asset/endpoint/fact/know/ledger/scope/approval 等，16-dashboard §1.7）；总线缺席时回退 v4 直写（观察期兜底）
  try {
    ctx.inject(['secDomainBus'], (child) => {
      secDomainBusRef = child.secDomainBus
      child.effect(() => () => { secDomainBusRef = null }, 'sec-suite: domain bus')
    })
  } catch { /* 无 secDomainBus（总线未挂载，v4 直写兜底） */ }
}
