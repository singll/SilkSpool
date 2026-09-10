// ==============================================================================
// @silksec/sec-backend-scope-file — scope 域 file 后端（repository-v1，授权白名单真相源）
//
// 契约：doc/secagent/v5/08-scope.md §2.1.1/§2.4
//
// 职责：持有 data/scope.yml（授权白名单唯一真相源）。读 = 解析为规范化快照；
// 写 = 原子写（.tmp + rename + .bak 保留一代）。格式与 v4.x 完全一致，不迁移不改写。
//
// 原语不含业务校验（域命令负责校验 + 七步 _persistScope）；只做字节级读/原子写。
// ==============================================================================

import * as fs from 'node:fs'
import * as path from 'node:path'

export const name = '@silksec/sec-backend-scope-file'
export const version = '1.0.0'
export const repositoryV1 = 'repository-v1'

const DEFAULT_DATA_DIR = process.env.SEC_DATA_DIR || '/opt/silkspool/dsh/data'

// ---------------------------------------------------------------------------
// 极简 scope.yml 解析（结构稳定；覆盖 v4 格式：version/defaults/programs[]/runtime）
// ---------------------------------------------------------------------------

export function parseScopeYaml(text) {
  const snapshot = {
    version: 1,
    defaults: { egress_proxy: '', rate_limit_qps: 50, allow_risk: ['passive', 'active'] },
    programs: [],
    runtime: { credentials_ref: 'env' },
  }
  if (!text) return snapshot
  let cur = null
  let section = null // 'defaults' | null
  let listKind = null // 'scope' | 'exclude' | 'allow_intrusive_tools' | null
  for (const raw of String(text).split('\n')) {
    const line = raw.replace(/#.*$/, '')
    if (!line.trim()) continue
    const indent = line.length - line.trimStart().length
    const s = line.trim()
    let m
    if ((m = s.match(/^version:\s*(\d+)/))) { snapshot.version = Number(m[1]); continue }
    if ((m = s.match(/^defaults:\s*$/))) { section = 'defaults'; cur = null; listKind = null; continue }
    if ((m = s.match(/^runtime:\s*$/))) { section = 'runtime'; cur = null; listKind = null; continue }
    if ((m = s.match(/^programs:\s*$/))) { section = 'programs'; cur = null; listKind = null; continue }
    if (section === 'defaults') {
      if ((m = s.match(/^egress_proxy:\s*(.+)$/))) { snapshot.defaults.egress_proxy = m[1].trim(); continue }
      if ((m = s.match(/^rate_limit_qps:\s*(\d+)/))) { snapshot.defaults.rate_limit_qps = Number(m[1]); continue }
      if ((m = s.match(/^allow_risk:\s*\[(.*)\]/))) { snapshot.defaults.allow_risk = m[1].split(',').map((x) => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean); continue }
      if (indent === 0) { section = null }
    }
    if (section === 'runtime') {
      if ((m = s.match(/^credentials_ref:\s*(.+)$/))) { snapshot.runtime.credentials_ref = m[1].trim(); continue }
      if (indent === 0) { section = null }
    }
    if ((m = s.match(/^- name:\s*["']?([^"']+)["']?/))) {
      cur = { name: m[1], platform: '', scope: [], exclude: [], rules: { max_risk: 'active', fixed_egress_ip: false, workspace: '', allow_intrusive_tools: [] }, finding_db: '' }
      snapshot.programs.push(cur); listKind = null; continue
    }
    if (cur) {
      if ((m = s.match(/^platform:\s*(.+)$/))) { cur.platform = m[1].trim(); listKind = null; continue }
      if ((m = s.match(/^finding_db:\s*(.+)$/))) { cur.finding_db = m[1].trim(); listKind = null; continue }
      if ((m = s.match(/^scope:\s*$/))) { listKind = 'scope'; continue }
      if ((m = s.match(/^exclude:\s*$/))) { listKind = 'exclude'; continue }
      if ((m = s.match(/^rules:\s*$/))) { listKind = 'rules'; continue }
      if ((m = s.match(/^allow_intrusive_tools:\s*$/))) { listKind = 'allow_intrusive_tools'; continue }
      if ((m = s.match(/^max_risk:\s*(\w+)/))) { cur.rules.max_risk = m[1]; listKind = null; continue }
      if ((m = s.match(/^fixed_egress_ip:\s*(true|false)/))) { cur.rules.fixed_egress_ip = m[1] === 'true'; listKind = null; continue }
      if ((m = s.match(/^workspace:\s*(.*)$/))) { cur.rules.workspace = m[1].trim().replace(/^["']|["']$/g, ''); listKind = null; continue }
      if ((m = s.match(/^- ["']?([^"']+)["']?$/))) {
        if (listKind === 'scope') cur.scope.push(m[1])
        else if (listKind === 'exclude') cur.exclude.push(m[1])
        else if (listKind === 'allow_intrusive_tools') cur.rules.allow_intrusive_tools.push(m[1])
        continue
      }
    }
  }
  return snapshot
}

// ---------------------------------------------------------------------------
// 序列化（规范化输出，丢弃注释——08 §2.5 O-6 已记录；格式与 exec 解析器兼容）
// ---------------------------------------------------------------------------

export function serializeScopeYaml(snapshot) {
  const d = snapshot.defaults || {}
  const lines = []
  lines.push('version: ' + (snapshot.version || 1))
  lines.push('')
  lines.push('defaults:')
  lines.push('  egress_proxy: ' + (d.egress_proxy || ''))
  lines.push('  rate_limit_qps: ' + (Number(d.rate_limit_qps) || 50))
  lines.push('  allow_risk: [' + (Array.isArray(d.allow_risk) ? d.allow_risk.join(', ') : 'passive, active') + ']')
  lines.push('')
  if (!Array.isArray(snapshot.programs) || snapshot.programs.length === 0) {
    lines.push('programs: []')
  } else {
    lines.push('programs:')
  }
  for (const p of snapshot.programs || []) {
    lines.push('  - name: ' + p.name)
    if (p.platform) lines.push('    platform: ' + p.platform)
    lines.push('    scope:')
    for (const e of p.scope || []) lines.push('      - "' + e + '"')
    if (Array.isArray(p.exclude) && p.exclude.length) {
      lines.push('    exclude:')
      for (const e of p.exclude) lines.push('      - "' + e + '"')
    }
    const r = p.rules || {}
    const hasRules = (r.max_risk && r.max_risk !== 'active') || r.fixed_egress_ip || (r.workspace && String(r.workspace).length) || (Array.isArray(r.allow_intrusive_tools) && r.allow_intrusive_tools.length)
    if (hasRules) {
      lines.push('    rules:')
      if (r.max_risk && r.max_risk !== 'active') lines.push('      max_risk: ' + r.max_risk)
      if (r.fixed_egress_ip) lines.push('      fixed_egress_ip: true')
      if (r.workspace && String(r.workspace).length) lines.push('      workspace: "' + r.workspace + '"')
      if (Array.isArray(r.allow_intrusive_tools) && r.allow_intrusive_tools.length) {
        lines.push('      allow_intrusive_tools:')
        for (const t of r.allow_intrusive_tools) lines.push('        - ' + t)
      }
    }
    if (p.finding_db) lines.push('    finding_db: ' + p.finding_db)
  }
  lines.push('')
  lines.push('runtime:')
  lines.push('  credentials_ref: ' + ((snapshot.runtime && snapshot.runtime.credentials_ref) || 'env'))
  return lines.join('\n') + '\n'
}

function writeFileAtomic(target, content) {
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const tmp = `${target}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  fs.writeFileSync(tmp, content)
  fs.renameSync(tmp, target)
}

function createRepo(dataDir, scopeFile) {
  const file = scopeFile || path.join(dataDir, 'scope.yml')

  const repo = {
    scopeFile: file,
    read() {
      try {
        return parseScopeYaml(fs.readFileSync(file, 'utf8'))
      } catch {
        return parseScopeYaml('')
      }
    },
    // 原子写：先 .bak（文件存在时），再 .tmp + rename。返回 { bakWritten }
    writeAtomic(snapshot) {
      const content = serializeScopeYaml(snapshot)
      let bakWritten = false
      try {
        if (fs.existsSync(file)) {
          fs.copyFileSync(file, `${file}.bak`)
          bakWritten = true
        }
      } catch { /* .bak 失败不阻断主写（真相源仍可写） */ }
      writeFileAtomic(file, content)
      return { bakWritten }
    },
    mtimeMs() {
      try { return fs.statSync(file).mtimeMs } catch { return null }
    },
  }
  return repo
}

export function createScopeFileBackend(opts = {}) {
  const dataDir = opts.dataDir || DEFAULT_DATA_DIR
  return {
    capabilities: {},
    factory() {
      return createRepo(dataDir, opts.scopeFile)
    },
  }
}
