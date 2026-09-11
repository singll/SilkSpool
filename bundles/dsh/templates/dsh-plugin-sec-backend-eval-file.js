// ==============================================================================
// @silksec/sec-backend-eval-file — eval 域 file 后端（repository-v1，唯一实现）
//
// 契约：doc/secagent/v5/15-eval.md §2.1/§2.4
//
// 职责：owns data/eval/ 整目录（eval-live.jsonl / fp-cases.jsonl / contract-cases.jsonl /
// fp-report.json / contract-report.json / eval-range-report.json / runs/ / reports/）。
// 评测是「给系统自身打分的独立小域」，与 vuln 物理隔离（不读 findings 表，只经总线 vuln_get）。
//
// 写 = tmp + rename 原子落盘（整文件）；追加 = O_APPEND 单行（eval-live.jsonl 单写者=域命令）。
// 读 = 直读文件（jsonl 流式、json 整读，≤ 数百 KB）。
// 原语不含业务校验（校验在域命令网关不变量 / 命令体）。
// ==============================================================================

import * as fs from 'node:fs'
import * as path from 'node:path'

export const name = '@silksec/sec-backend-eval-file'
export const version = '1.0.0'
export const repositoryV1 = 'repository-v1'

const DEFAULT_DATA_DIR = process.env.SEC_DATA_DIR || '/opt/silkspool/dsh/data'

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}

function writeFileAtomic(target, content) {
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const tmp = `${target}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  fs.writeFileSync(tmp, content)
  fs.renameSync(tmp, target)
}

function readJsonlLines(file) {
  let out = []
  try {
    out = fs.readFileSync(file, 'utf8').split('\n')
      .filter((l) => l.trim())
      .map((l) => { try { return JSON.parse(l) } catch { return null } })
      .filter((r) => r && typeof r === 'object')
  } catch { out = [] }
  return out
}

function createRepo(opts) {
  const evalDir = opts.evalDir

  const LIVE = path.join(evalDir, 'eval-live.jsonl')
  const FP_CASES = path.join(evalDir, 'fp-cases.jsonl')
  const CONTRACT_CASES = path.join(evalDir, 'contract-cases.jsonl')
  const FP_REPORT = path.join(evalDir, 'fp-report.json')
  const CONTRACT_REPORT = path.join(evalDir, 'contract-report.json')
  const RANGE_REPORT = path.join(evalDir, 'eval-range-report.json')
  const RUNS = path.join(evalDir, 'runs')
  const REPORTS_HIST = path.join(evalDir, 'reports')

  const REPORT_FILES = {
    fp: FP_REPORT,
    contract: CONTRACT_REPORT,
    range: RANGE_REPORT,
  }

  function beijingDate(ts = Date.now()) {
    return new Date(ts + 8 * 3600_000).toISOString().slice(0, 10)
  }

  function listRunFiles() {
    let files = []
    try { files = fs.readdirSync(RUNS).filter((f) => f.endsWith('.json')) } catch { files = [] }
    return files
  }

  const repo = {
    evalDir,

    beijingDate,

    // ---- eval-live.jsonl（追加只增不改，INV-2）----
    readLive() { return readJsonlLines(LIVE) },
    appendCase(rec) {
      fs.mkdirSync(evalDir, { recursive: true })
      const line = JSON.stringify(rec)
      fs.appendFileSync(LIVE, line + '\n')
      return { line: line.length }
    },

    // ---- 种子（fp/contract 只读；setup/迁移脚本写入）----
    readSeed(kind) {
      const file = kind === 'fp' ? FP_CASES : CONTRACT_CASES
      return readJsonlLines(file)
    },

    // ---- 报告（tmp+rename + 历史快照归档，INV-3）----
    readReportFile(kind) {
      return readJSON(REPORT_FILES[kind], null)
    },
    writeReport(kind, content) {
      const target = REPORT_FILES[kind]
      // INV-3：覆盖前把上一份归档进 reports/（名带 ts 快照）
      const prev = readJSON(target, null)
      if (prev && prev.ts) {
        fs.mkdirSync(REPORTS_HIST, { recursive: true })
        const stamp = String(prev.ts).replace(/[^0-9]/g, '')
        const archived = path.join(REPORTS_HIST, `${kind}-report-${stamp}.json`)
        if (!fs.existsSync(archived)) {
          try { fs.copyFileSync(target, archived) } catch { /* 归档失败不阻断 */ }
        }
      }
      writeFileAtomic(target, content)
      return { file: path.basename(target) }
    },
    listReports(kind) {
      const rows = []
      const main = REPORT_FILES[kind]
      const mainObj = readJSON(main, null)
      if (mainObj) rows.push({ kind, file: path.basename(main), ts: mainObj.ts || null })
      // 历史快照（reports/{kind}-report-{ts}.json）
      let hist = []
      try { hist = fs.readdirSync(REPORTS_HIST).filter((f) => f.startsWith(`${kind}-report-`) && f.endsWith('.json')) } catch { hist = [] }
      for (const f of hist) {
        const obj = readJSON(path.join(REPORTS_HIST, f), null)
        rows.push({ kind, file: `reports/${f}`, ts: obj && obj.ts ? obj.ts : null })
      }
      // v4 eval-run.js 产物（report-<epoch>.json）与 eval-range-report.json 同属 range
      if (kind === 'range') {
        let rangeFiles = []
        try { rangeFiles = fs.readdirSync(evalDir).filter((f) => /^report-\d+\.json$/.test(f)) } catch { rangeFiles = [] }
        for (const f of rangeFiles) {
          const obj = readJSON(path.join(evalDir, f), null)
          rows.push({ kind, file: f, ts: obj && obj.ts ? obj.ts : null })
        }
      }
      rows.sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')))
      return rows
    },

    // ---- runs/{run_id}.json（评测运行状态机）----
    createRun(runId, rec) {
      fs.mkdirSync(RUNS, { recursive: true })
      writeFileAtomic(path.join(RUNS, `${runId}.json`), JSON.stringify(rec, null, 1))
      return {}
    },
    finishRun(runId, rec) {
      const file = path.join(RUNS, `${runId}.json`)
      const prev = readJSON(file, {})
      writeFileAtomic(file, JSON.stringify({ ...prev, ...rec }, null, 1))
      return {}
    },
    listRuns() {
      const rows = []
      for (const f of listRunFiles()) {
        const rec = readJSON(path.join(RUNS, f), null)
        if (rec && typeof rec === 'object') rows.push(rec)
      }
      rows.sort((a, b) => Number(b.started_at || 0) - Number(a.started_at || 0))
      return rows
    },

    // ---- 孤儿扫描（宿主重启）：running → failed(error='host_restart')，不自动续跑 ----
    orphanScan() {
      let marked = 0
      for (const rec of repo.listRuns()) {
        if (rec.status === 'running') {
          repo.finishRun(rec.run_id, { status: 'failed', finished_at: Date.now(), error: 'host_restart' })
          marked++
        }
      }
      return { marked }
    },
  }
  return repo
}

export function createEvalFileBackend(opts = {}) {
  const dataDir = opts.dataDir || DEFAULT_DATA_DIR
  const evalDir = opts.evalDir || process.env.SEC_EVAL_DIR || path.join(dataDir, 'eval')
  return {
    capabilities: {},
    factory() { return createRepo({ evalDir }) },
    orphanScan() { return createRepo({ evalDir }).orphanScan() },
  }
}
