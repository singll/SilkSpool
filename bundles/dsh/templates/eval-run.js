// ==============================================================================
// SilkSecAgent 靶场回归评测（P4 环3 评测基线）
// 通过真实 run_cli 管线（含 scope-guard）对每个靶标跑 nuclei，
// 核对预期模板是否命中，产出 发现率/误报/耗时 报告到 data/eval/
// 用法: SEC_DATA_DIR=/opt/silkspool/dsh/data node eval-run.js [case ...]
// ==============================================================================

import * as fs from 'node:fs'
import * as path from 'node:path'

const BASE = process.env.SEC_BASE_DIR || '/opt/silkspool/dsh'
const DATA_DIR = process.env.SEC_DATA_DIR || path.join(BASE, 'data')
const CASES_FILE = process.env.EVAL_CASES || path.join(BASE, 'eval-cases.list')

const plugin = await import(`file://${BASE}/plugins/sec-suite/index.js`)
const tools = []
plugin.apply({ tools: { register: (t) => tools.push(t) }, on: () => {} })
const run = tools.find((t) => t.name === 'run_cli')
const grep = tools.find((t) => t.name === 'grep_result')

const only = process.argv.slice(2)
const cases = fs.readFileSync(CASES_FILE, 'utf8').split('\n')
  .filter((l) => l.trim() && !l.startsWith('#'))
  .map((l) => l.split('|'))
  .filter(([name]) => only.length === 0 || only.includes(name))

const results = []
for (const [name, target, engine, keyword, expected] of cases) {
  const started = Date.now()
  process.stdout.write(`[eval] ${name} (${target}) ${engine} 期待 ${expected} ... `)
  const toolName = engine === 'afrog' ? 'afrog-keyword' : 'nuclei'
  const params = engine === 'afrog' ? { target: `http://${target}`, keyword } : { target, rate: '100' }
  const r = await run.execute({ tool: toolName, params })
  if (!r.ok && !r.run_id) {
    results.push({ name, target, engine, expected, found: false, error: r.error, duration_ms: Date.now() - started })
    console.log(`管线失败: ${r.error}`)
    continue
  }
  const g = await grep.execute({ run_id: r.run_id, pattern: expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), max: 5 })
  const found = g.ok && g.matched > 0
  results.push({
    name, target, engine, expected, found,
    run_id: r.run_id, exit_code: r.exit_code, total_lines: r.total_lines,
    duration_ms: Date.now() - started,
  })
  console.log(found ? `发现 ✓ (${Math.round((Date.now() - started) / 1000)}s)` : `未发现 ✗ (${Math.round((Date.now() - started) / 1000)}s)`)
}

const found = results.filter((r) => r.found).length
const report = {
  ts: new Date().toISOString(),
  total: results.length,
  found,
  miss: results.length - found,
  detection_rate: results.length ? Math.round((found / results.length) * 100) / 100 : 0,
  total_duration_ms: results.reduce((s, r) => s + r.duration_ms, 0),
  results,
}
const outDir = path.join(DATA_DIR, 'eval')
fs.mkdirSync(outDir, { recursive: true })
const outFile = path.join(outDir, `report-${Date.now()}.json`)
fs.writeFileSync(outFile, JSON.stringify(report, null, 1) + '\n')
console.log(`\n[eval] 发现率 ${found}/${results.length} (${report.detection_rate * 100}%)  总耗时 ${Math.round(report.total_duration_ms / 1000)}s`)
console.log(`[eval] 报告: ${outFile}`)
process.exit(0)
