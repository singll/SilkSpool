// ==============================================================================
// @silksec/sec-backend-exec-file — exec 域 file 后端（repository-v1，唯一后端）
//
// 契约：doc/secagent/v5/10-exec.md §2.1/§2.4（数据模型 + 后端适配器）
//
// 职责：tools.d/*.yaml manifest 读取、results/<run_id>/ 落盘、flows/ imports/ 追加、grep/page 文件原语。
// 零表零事务：单文件追加依赖 O_APPEND 原子性；runDir 多文件落盘按 run 隔离。不含业务校验。
// ==============================================================================

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as crypto from 'node:crypto'

export const name = '@silksec/sec-backend-exec-file'
export const version = '1.0.0'
export const repositoryV1 = 'repository-v1'

const BINARY_EXT_RE = /\.(png|jpg|jpeg|gif|zip|gz|zstd|bin)$/i

function parseYamlLite(text) {
  // 极简 YAML 子集解析（tools.d manifest 用到的标量/嵌套 map/数组）
  const lines = []
  for (const raw of String(text).split('\n')) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue
    lines.push({ indent: raw.length - raw.trimStart().length, text: raw.trim() })
  }
  let pos = 0
  function scalar(s) {
    s = s.trim()
    if (s === '') return ''
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1)
    if (s === 'true') return true
    if (s === 'false') return false
    if (s === 'null' || s === '~') return null
    if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s)
    if (s.startsWith('[') && s.endsWith(']')) {
      const inner = s.slice(1, -1).trim()
      if (!inner) return []
      return inner.split(',').map((x) => scalar(x.trim()))
    }
    return s
  }
  function parseBlock(indent) {
    if (pos >= lines.length || lines[pos].indent < indent) return null
    return lines[pos].text.startsWith('- ') ? parseList(indent) : parseMap(indent)
  }
  function parseMap(indent) {
    const obj = {}
    while (pos < lines.length && lines[pos].indent === indent && !lines[pos].text.startsWith('- ')) {
      const m = lines[pos].text.match(/^([^:]+):\s*(.*)$/)
      if (!m) { pos++; continue }
      pos++
      const key = m[1].trim()
      if (m[2] !== '') { obj[key] = scalar(m[2]); continue }
      if (pos < lines.length && lines[pos].indent > indent) obj[key] = parseBlock(lines[pos].indent)
      else obj[key] = null
    }
    return obj
  }
  function parseList(indent) {
    const arr = []
    while (pos < lines.length && lines[pos].indent === indent && lines[pos].text.startsWith('- ')) {
      pos++
      const rest = lines[pos - 1].text.slice(2)
      const m = rest.match(/^([^:]+):\s*(.*)$/)
      if (m && m[2] !== '') { const it = {}; it[m[1].trim()] = scalar(m[2]); arr.push(it) }
      else if (m && m[2] === '') { const it = {}; if (pos < lines.length && lines[pos].indent > indent + 2) it[m[1].trim()] = parseBlock(lines[pos].indent); arr.push(it) }
      else arr.push(scalar(rest))
    }
    return arr
  }
  if (lines.length === 0) return {}
  return parseBlock(lines[0].indent)
}

function beijingDate(ts = Date.now()) {
  return new Date(ts + 8 * 3600_000).toISOString().slice(0, 10)
}

function createRepo(dataDir) {
  const toolsDir = path.join(dataDir, 'tools.d')
  const resultsDir = path.join(dataDir, 'results')
  const flowsDir = path.join(dataDir, 'flows')
  const importsDir = path.join(dataDir, 'imports')

  function listManifests() {
    try { return fs.readdirSync(toolsDir).filter((f) => f.endsWith('.yaml')).map((f) => f.replace(/\.yaml$/, '')) } catch { return [] }
  }
  function loadManifest(name) {
    if (!/^[a-z0-9_-]+$/.test(String(name))) return null
    const file = path.join(toolsDir, `${name}.yaml`)
    if (!fs.existsSync(file)) return null
    try { const m = parseYamlLite(fs.readFileSync(file, 'utf8')); m._file = file; return m } catch { return null }
  }

  function createRunDir(prefix = 'r') {
    const runId = `${prefix}${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`
    const runDir = path.join(resultsDir, runId)
    fs.mkdirSync(runDir, { recursive: true })
    return { runId, runDir }
  }

  const repo = {
    listManifests,
    loadManifest,
    createRunDir,
    writeCmd(runDir, text) { fs.writeFileSync(path.join(runDir, 'cmd.txt'), String(text)); },
    appendStdout(runDir, chunk) { fs.appendFileSync(path.join(runDir, 'stdout.log'), chunk); },
    writeMeta(runDir, meta) { fs.writeFileSync(path.join(runDir, 'meta.json'), JSON.stringify(meta, null, 1) + '\n'); },
    writeProposal(runDir, proposal) { fs.writeFileSync(path.join(runDir, 'proposal.json'), JSON.stringify(proposal, null, 1) + '\n'); },
    writeWorkerLog(runDir, chunk) { fs.appendFileSync(path.join(runDir, 'worker.log'), chunk); },
    readRunDirTree(runId) {
      const dir = /^(r|w)[a-z0-9]+$/.test(String(runId)) ? path.join(resultsDir, String(runId)) : null
      if (!dir || !fs.existsSync(dir)) return []
      const files = []
      const walk = (d) => {
        let entries = []
        try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
        for (const e of entries) {
          const p = path.join(d, e.name)
          if (e.isDirectory()) walk(p)
          else if (!BINARY_EXT_RE.test(e.name)) files.push(p)
        }
      }
      walk(dir)
      return files
    },
    runDirOf(runId) {
      const dir = /^(r|w)[a-z0-9]+$/.test(String(runId)) ? path.join(resultsDir, String(runId)) : null
      return (dir && fs.existsSync(dir)) ? dir : null
    },
    appendFlow(date, line) {
      fs.mkdirSync(flowsDir, { recursive: true })
      fs.appendFileSync(path.join(flowsDir, `xray-${date}.jsonl`), String(line) + '\n')
      return path.join(flowsDir, `xray-${date}.jsonl`)
    },
    appendImport(id, line) {
      fs.mkdirSync(importsDir, { recursive: true })
      fs.appendFileSync(path.join(importsDir, `${id}.jsonl`), String(line) + '\n')
      return path.join(importsDir, `${id}.jsonl`)
    },
    readFile(absPath) {
      try { return fs.readFileSync(absPath, 'utf8') } catch { return null }
    },
    beijingDate,
  }
  return repo
}

const _cache = new Map()

export function createExecFileBackend(opts = {}) {
  const dataDir = opts.dataDir || (process.env.SEC_DATA_DIR || '/opt/silkspool/dsh/data')
  return {
    capabilities: {},
    factory() {
      let repo = _cache.get(dataDir)
      if (!repo) {
        repo = createRepo(dataDir)
        _cache.set(dataDir, repo)
      }
      return repo
    },
  }
}
