#!/usr/bin/env node
// ==============================================================================
// SilkSecAgent program_id 回填迁移（P6/P11）：存量 assets/endpoints/findings 打上项目归属
// 一次性脚本：读 scope.yml → 对每条 host 反查命中 program → 回填 program_id；
// 未命中归 _legacy（P11 起 _legacy 行也会被重扫——新增授权项目后可把旧 _legacy 数据归位）
// 用法：SEC_DATA_DIR=/opt/silkspool/dsh/data node backfill-program.js [--dry-run]
// ==============================================================================
import * as db from './asset-db.js'
import * as fs from 'node:fs'
import * as path from 'node:path'

const DATA_DIR = process.env.SEC_DATA_DIR || '/opt/silkspool/dsh/data'
const SCOPE_FILE = process.env.SEC_SCOPE_FILE || path.join(DATA_DIR, 'scope.yml')
const DRY = process.argv.includes('--dry-run')

// ---- 极简 YAML 解析（仅取 programs[].name/scope/exclude，与插件同构子集）----
function parseScope(text) {
  const programs = []
  let cur = null
  let key = ''
  for (const raw of String(text).split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const mi = line.match(/^-\s+name:\s*(.+)$/)
    if (mi) { cur = { name: mi[1].trim(), scope: [], exclude: [] }; programs.push(cur); continue }
    const m2 = line.match(/^scope:\s*$/)
    const m3 = line.match(/^exclude:\s*$/)
    if (m2) { key = 'scope'; continue }
    if (m3) { key = 'exclude'; continue }
    const item = line.match(/^-\s*"([^"]+)"\s*$/) || line.match(/^-\s*([^\s#]+)\s*$/)
    if (item && cur && key) cur[key].push(item[1].trim())
  }
  return programs
}

function hostOf(raw) {
  let s = String(raw).trim()
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
  s = s.split('/')[0].split('?')[0].split('#')[0]
  if (s.includes(':') && /:\d+$/.test(s)) s = s.slice(0, s.lastIndexOf(':'))
  return s.toLowerCase()
}

function ipToInt(ip) {
  const p = ip.split('.')
  if (p.length !== 4) return null
  let n = 0
  for (const x of p) { const v = Number(x); if (!Number.isInteger(v) || v < 0 || v > 255) return null; n = n * 256 + v }
  return n
}

function matches(entry, host) {
  entry = String(entry).trim().toLowerCase()
  if (!entry) return false
  if (entry.includes('/') && !entry.includes('.')) return false
  if (entry.includes('/') && ipToInt(host) !== null) {
    const [base, bitsRaw] = entry.split('/')
    const bits = Number(bitsRaw); const b = ipToInt(base); const t = ipToInt(host)
    if (b === null || t === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false
    if (bits === 0) return true
    const mask = bits === 32 ? 0xffffffff : (0xffffffff << (32 - bits)) >>> 0
    return (b & mask) >>> 0 === (t & mask) >>> 0
  }
  if (entry.startsWith('*.')) { const suf = entry.slice(1); return host === entry.slice(2) || host.endsWith(suf) }
  return host === entry
}

function resolveProgram(programs, host) {
  for (const p of programs) {
    if (p.exclude.some((e) => matches(e, host))) continue
    if (p.scope.some((e) => matches(e, host))) return p.name
  }
  return null
}

const programs = parseScope(fs.readFileSync(SCOPE_FILE, 'utf8'))
if (programs.length === 0) { console.log('scope.yml 无 programs，跳过'); process.exit(0) }

const d = db.getDb()
const plain = (rows) => rows.map((r) => ({ ...r }))

const tables = [
  { t: 'assets', col: 'host', key: 'rowid' },
  { t: 'endpoints', col: 'host', key: 'rowid' },
  { t: 'findings', col: 'host', key: 'id' },
]
let changed = 0
let legacy = 0
for (const { t, col, key } of tables) {
  const rows = plain(d.prepare(`SELECT ${key}, ${col} FROM ${t} WHERE program_id IS NULL OR program_id = '_legacy'`).all())
  for (const r of rows) {
    const program = resolveProgram(programs, hostOf(r[col]))
    if (program) {
      if (!DRY) d.prepare(`UPDATE ${t} SET program_id = ? WHERE ${key} = ?`).run(program, r[key])
      changed++
    } else {
      if (!DRY) d.prepare(`UPDATE ${t} SET program_id = ? WHERE ${key} = ?`).run('_legacy', r[key])
      legacy++
    }
  }
}
console.log(`${DRY ? '[dry-run] ' : ''}回填完成：命中项目 ${changed} 条，_legacy ${legacy} 条（表: ${tables.map((x) => x.t).join('/')}）`)
