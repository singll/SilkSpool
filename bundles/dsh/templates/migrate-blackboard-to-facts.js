#!/usr/bin/env node
// ==============================================================================
// SilkSecAgent 事实迁移（P11 §七）：遗留扁平 blackboard → 事实图谱 facts
// 幂等可重跑：PRIMARY KEY (program_id, fact_key) 冲突即更新 updated_at。
// 映射规则：
//   import:美团SRC:<cat>/<slug> → program_id=meituan-src, category=<cat>, fact_key=<cat>/<slug>
//   import:字节SRC:<cat>/<slug> → program_id=bytedance, 同上
//   alive:*/note:*             → program_id 由 scope 反查（查不到归 _unbound），category=note
//   value 全文 → body；summary = 首行截 120 字；confidence 一律 tentative（导入未验证）
// 用法：SEC_DATA_DIR=/opt/silkspool/dsh/data node migrate-blackboard-to-facts.js [--dry-run]
// ==============================================================================
import * as db from './asset-db.js'
import * as fs from 'node:fs'
import * as path from 'node:path'

const DATA_DIR = process.env.SEC_DATA_DIR || '/opt/silkspool/dsh/data'
const SCOPE_FILE = process.env.SEC_SCOPE_FILE || path.join(DATA_DIR, 'scope.yml')
const DRY = process.argv.includes('--dry-run')

const PROJECT_MAP = { '美团SRC': 'meituan-src', '字节SRC': 'bytedance' }
const KNOWN_CATEGORIES = ['auth', 'target', 'note', 'finding', 'chain', 'exploit', 'asset', 'infra', 'recon']

// ---- scope 反查（alive/note 类无项目前缀的 key 用）----
function parseScopePrograms(text) {
  const programs = []
  let cur = null; let key = ''
  for (const raw of String(text).split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const mi = line.match(/^-\s+name:\s*"?([^"]+)"?\s*$/)
    if (mi) { cur = { name: mi[1].trim(), scope: [] }; programs.push(cur); key = ''; continue }
    if (/^scope:\s*$/.test(line)) { key = 'scope'; continue }
    if (/^(exclude|rules|platform|finding_db)/.test(line)) { key = ''; continue }
    const item = line.match(/^-\s*"([^"]+)"\s*$/) || line.match(/^-\s*([^\s#]+)\s*$/)
    if (item && cur && key === 'scope') cur.scope.push(item[1].trim())
  }
  return programs
}

function resolveProgramByHost(programs, text) {
  // 从 key/value 文本里提域名，逐域命中 scope 后缀
  const hosts = String(text).match(/(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}/gi) || []
  for (const host of hosts) {
    const h = host.toLowerCase()
    for (const p of programs) {
      for (const e of p.scope) {
        const entry = String(e).toLowerCase()
        if (entry.startsWith('*.') && (h === entry.slice(2) || h.endsWith(entry.slice(1)))) return p.name
        else if (h === entry) return p.name
      }
    }
  }
  return null
}

const scopePrograms = fs.existsSync(SCOPE_FILE) ? parseScopePrograms(fs.readFileSync(SCOPE_FILE, 'utf8')) : []

const d = db.getDb()
const rows = d.prepare('SELECT key, value, updated_at FROM blackboard ORDER BY key').all()

let migrated = 0
let unbound = 0
const perProgram = {}

for (const r of rows) {
  const key = String(r.key)
  const value = String(r.value || '')
  let programId = null
  let category = 'note'
  let factKey = null

  const m = key.match(/^import:([^:]+):(.+)$/)
  if (m) {
    programId = PROJECT_MAP[m[1]] || null
    const rest = m[2]
    const slash = rest.indexOf('/')
    if (slash > 0) {
      const cat = rest.slice(0, slash)
      category = KNOWN_CATEGORIES.includes(cat) ? cat : 'note'
      factKey = `${category}/${rest.slice(slash + 1)}`
    } else {
      factKey = `note/${rest}`
    }
    if (!programId) {
      // 未登记的项目（如 scope 未配）：按内容反查，再不行归 _unbound
      programId = resolveProgramByHost(scopePrograms, key + ' ' + value) || '_unbound'
    }
  } else {
    const slash = key.indexOf(':')
    const slug = slash > 0 ? key.slice(slash + 1) : key
    factKey = `note/${slug.replace(/[^a-zA-Z0-9_.\-\u4e00-\u9fa5]+/g, '-').slice(0, 120)}`
    programId = resolveProgramByHost(scopePrograms, key + ' ' + value) || '_unbound'
  }

  if (programId === '_unbound') unbound++
  const firstLine = value.split('\n').find((l) => l.trim()) || ''
  const summary = firstLine.slice(0, 120)

  if (!DRY) {
    db.factUpsert({
      program_id: programId,
      fact_key: factKey,
      category,
      summary,
      body: value,
      confidence: 'tentative',
      pinned: 0,
      related_finding_id: null,
      source: 'import:cyberstrikeai',
    })
  }
  perProgram[programId] = (perProgram[programId] || 0) + 1
  migrated++
}

console.log(`${DRY ? '[dry-run] ' : ''}迁移完成：${migrated} 条 blackboard → facts（未关联 _unbound ${unbound} 条）`)
console.log('按 program 分布:', JSON.stringify(perProgram))
console.log(`facts 表当前总数: ${DRY ? '(dry-run 未写入)' : d.prepare('SELECT COUNT(*) AS n FROM facts').get().n}`)
