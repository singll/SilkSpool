// ==============================================================================
// @silksec/sec-backend-ledger-file — ledger 域 file 后端（repository-v1，唯一真相源）
//
// 契约：doc/secagent/v5/11-ledger.md §2.4
//
// 职责：data/pipeline/{program}/ 台账树（attempts-{program}.tsv 9 列 / card_usage-{date}.jsonl /
// radar-queue.jsonl / handoff-{date}.md / coverage-latest.md）。TSV/JSONL 追加走 O_APPEND 单次写，
// drain/handoff 覆盖走 tmp+rename 原子替换。文件本体即真相源——v4 格式逐字节冻结（§3.3）。
//
// 原语不含业务校验（校验在域命令网关不变量）；只做字节级读写。
// ==============================================================================

import * as fs from 'node:fs'
import * as path from 'node:path'

export const name = '@silksec/sec-backend-ledger-file'
export const version = '1.0.0'
export const repositoryV1 = 'repository-v1'

const ATTEMPTS_HEADER = ['ts', 'asset', 'card_id', 'card_ver', 'tool', 'result', 'reason', 'evidence_path', 'run_id']
const ASSETS_HEADER = ['domain', 'status', 'first_seen', 'last_seen', 'source', 'probe_date']
const ENDPOINTS_HEADER = ['url', 'method', 'params', 'auth_required', 'source', 'collected_at']
const EGRESS_HEADER = ['egress', 'target_domain', 'ts', 'signature', 'verdict']
const RESULT_ENUM = ['TESTED_CLEAN', 'CONFIRMED', 'FALSE_POSITIVE', 'NOT_APPLICABLE', 'BLOCKED', 'STALE']
const BANNED_REASON = new Set(['other', 'misc', ''])
const TS_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/

const SCHEMA_MATCH = [
  { prefix: 'attempts-', header: ATTEMPTS_HEADER, resultEnum: RESULT_ENUM },
  { prefix: 'assets-', header: ASSETS_HEADER },
  { prefix: 'endpoints-', header: ENDPOINTS_HEADER },
  { prefix: 'egress-health', header: EGRESS_HEADER },
]

function nowIso() {
  return new Date(Date.now() + 8 * 3600_000).toISOString().replace('Z', '+08:00').slice(0, 19)
}

function beijingDate(ts = Date.now()) {
  return new Date(ts + 8 * 3600_000).toISOString().slice(0, 10)
}

function epochToIso(ms) {
  return new Date(Number(ms) + 8 * 3600_000).toISOString().replace('Z', '+08:00').slice(0, 19)
}

function writeFileAtomic(target, content) {
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const tmp = `${target}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  fs.writeFileSync(tmp, content)
  fs.renameSync(tmp, target)
}

function readTsv(file) {
  if (!fs.existsSync(file)) return { header: [], rows: [] }
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim())
  if (!lines.length) return { header: [], rows: [] }
  return { header: lines[0].split('\t'), rows: lines.slice(1).map((l) => l.split('\t')) }
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim())
    .map((l) => { try { return JSON.parse(l) } catch { return { raw: l } } })
}

function tsvAppend(file, header, row) {
  if (!fs.existsSync(file)) fs.writeFileSync(file, header.join('\t') + '\n')
  fs.appendFileSync(file, row.join('\t') + '\n')
}

// v4 validateFile 全量保留（11-ledger §1.4.5 复核查询的格式契约）
function validateFile(file) {
  const base = path.basename(file)
  const errors = []
  if (base.startsWith('card_usage-')) {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim())
    lines.forEach((l, i) => {
      try {
        const rec = JSON.parse(l)
        for (const k of ['card_id', 'card_version', 'asset', 'result']) {
          if (!(k in rec)) errors.push(`${file}:${i + 1}: 缺必填字段 ${k}`)
        }
      } catch { errors.push(`${file}:${i + 1}: JSON 解析失败`) }
    })
    return errors
  }
  const schema = SCHEMA_MATCH.find((s) => base.startsWith(s.prefix))
  if (!schema) return [`${file}: 无匹配 schema（文件名需以 attempts-/assets-/endpoints-/egress-health-/card_usage- 开头）`]
  const { header, rows } = readTsv(file)
  if (!header.length) return [`${file}: 空文件`]
  const core = schema.header
  if (core.some((c, i) => header[i] !== c)) {
    errors.push(`${file}: 核心列不符 期望前缀 ${core.join(',')} 实际 ${header.slice(0, core.length).join(',')}`)
    return errors
  }
  rows.forEach((row, i) => {
    const ln = i + 2
    if (row.length < core.length) { errors.push(`${file}:${ln}: 列数不足`); return }
    const rec = Object.fromEntries(core.map((k, j) => [k, row[j]]))
    if (rec.ts && !TS_RE.test(rec.ts)) errors.push(`${file}:${ln}: ts 格式异常`)
    if (schema.resultEnum) {
      if (!schema.resultEnum.includes(rec.result)) errors.push(`${file}:${ln}: result 非法 '${rec.result}'`)
      else if (['NOT_APPLICABLE', 'BLOCKED'].includes(rec.result) && BANNED_REASON.has((rec.reason || '').toLowerCase()))
        errors.push(`${file}:${ln}: ${rec.result} 缺 reason`)
      else if (['TESTED_CLEAN', 'CONFIRMED'].includes(rec.result) && !rec.evidence_path)
        errors.push(`${file}:${ln}: ${rec.result} 缺 evidence_path`)
    }
  })
  return errors
}

function createRepo(dataDir) {
  function pipelineRoot(program) {
    return path.join(dataDir, 'pipeline', String(program))
  }
  function ensurePipeline(program) {
    const d = pipelineRoot(program)
    fs.mkdirSync(d, { recursive: true })
    return d
  }
  function attemptsFile(program) {
    return path.join(ensurePipeline(program), `attempts-${program}.tsv`)
  }
  function listCardUsageFiles(program) {
    const dir = pipelineRoot(program)
    let entries = []
    try { entries = fs.readdirSync(dir) } catch { entries = [] }
    return entries.filter((f) => /^card_usage-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort()
  }
  function listExecRunFiles(program) {
    const dir = pipelineRoot(program)
    let entries = []
    try { entries = fs.readdirSync(dir) } catch { entries = [] }
    return entries.filter((f) => /^exec-runs-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort()
  }

  const repo = {
    // ---- attempts ----
    appendAttempt(program, row) {
      const file = attemptsFile(program)
      tsvAppend(file, ATTEMPTS_HEADER, row)
      return { file, row_ts: row[0], run_id: row[8] }
    },
    readAttempts(program) {
      return readTsv(attemptsFile(program))
    },

    // ---- card_usage ----
    appendCardUsage(program, record) {
      const dir = ensurePipeline(program)
      const date = String(record.ts || nowIso()).slice(0, 10)
      const file = path.join(dir, `card_usage-${date}.jsonl`)
      fs.appendFileSync(file, JSON.stringify(record) + '\n')
      return { file }
    },

    // ---- radar ----
    appendRadar(program, record) {
      const dir = ensurePipeline(program)
      const file = path.join(dir, 'radar-queue.jsonl')
      fs.appendFileSync(file, JSON.stringify(record) + '\n')
      return { file }
    },
    readRadar(program) {
      return readJsonl(path.join(pipelineRoot(program), 'radar-queue.jsonl'))
    },
    drainRadar(program) {
      const dir = ensurePipeline(program)
      const file = path.join(dir, 'radar-queue.jsonl')
      const records = readJsonl(file)
      writeFileAtomic(file, '')
      return records
    },

    // ---- handoff ----
    writeHandoff(program, date, content) {
      const dir = ensurePipeline(program)
      const file = path.join(dir, `handoff-${date}.md`)
      let prevSaved = false
      if (fs.existsSync(file)) {
        fs.writeFileSync(`${file}.prev`, fs.readFileSync(file, 'utf8'))
        prevSaved = true
      }
      writeFileAtomic(file, content)
      return { file, prevSaved }
    },
    hasHandoff(program, date) {
      return fs.existsSync(path.join(pipelineRoot(program), `handoff-${date}.md`))
    },
    // FGS 决策链摘要追加（11-ledger §2.3 归属裁决：handoff 归 ledger 域，appendFgsToHandoff 直写归零）
    appendHandoff(program, date, content) {
      const dir = ensurePipeline(program)
      const file = path.join(dir, `handoff-${date}.md`)
      fs.appendFileSync(file, content)
      return { file, appended: true }
    },

    // ---- stats ----
    statAttemptsDelta(program, sinceMs) {
      const { rows } = repo.readAttempts(program)
      const cutoff = epochToIso(sinceMs)
      let n = 0
      for (const r of rows) if ((r[0] || '') >= cutoff) n++
      return n
    },
    statCardUsageSince(program, sinceMs) {
      const cutoff = epochToIso(sinceMs)
      let n = 0
      for (const f of listCardUsageFiles(program)) {
        try {
          for (const rec of readJsonl(path.join(pipelineRoot(program), f))) {
            if (rec && typeof rec === 'object' && !('raw' in rec) && (rec.ts || '') >= cutoff) n++
          }
        } catch { /* ignore */ }
      }
      return n
    },
    countCardUsageDays(program, days) {
      const cutoff = beijingDate(Date.now() - (days - 1) * 86400000)
      let n = 0
      for (const f of listCardUsageFiles(program)) {
        const d = f.match(/^card_usage-(\d{4}-\d{2}-\d{2})\.jsonl$/)[1]
        if (d >= cutoff) {
          try { n += readJsonl(path.join(pipelineRoot(program), f)).length } catch { /* ignore */ }
        }
      }
      return n
    },
    countHandoffDays(program, days) {
      let n = 0
      for (let i = 0; i < days; i++) {
        const d = beijingDate(Date.now() - i * 86400000)
        if (repo.hasHandoff(program, d)) n++
      }
      return n
    },
    statExecRunsSince(program, sinceMs) {
      const cutoff = epochToIso(sinceMs)
      let n = 0
      for (const f of listExecRunFiles(program)) {
        try {
          for (const rec of readJsonl(path.join(pipelineRoot(program), f))) {
            if (rec && typeof rec === 'object' && !('raw' in rec) && (rec.ts || '') >= cutoff) n++
          }
        } catch { /* ignore */ }
      }
      return n
    },
    listPrograms() {
      const root = path.join(dataDir, 'pipeline')
      let entries = []
      try { entries = fs.readdirSync(root, { withFileTypes: true }) } catch { entries = [] }
      return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort()
    },
    listCardUsageFiles,

    // ---- 格式契约（pipeline_validate 复核） ----
    validateFile,

    // ---- 原语（coverage 聚合 / 缓存物化） ----
    pipelineRoot, ensurePipeline, readTsv, readJsonl, writeFileAtomic,
    nowIso, beijingDate,
  }
  return repo
}

export function createLedgerFileBackend(opts = {}) {
  const dataDir = opts.dataDir || (process.env.SEC_DATA_DIR || '/opt/silkspool/dsh/data')
  return {
    capabilities: {},
    factory() {
      return createRepo(dataDir)
    },
  }
}
