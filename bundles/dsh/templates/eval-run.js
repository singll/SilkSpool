// ==============================================================================
// SilkSecAgent 靶场回归评测（v5 总线版；学习专项 L0-K3 迁移）
// 通过 v5 总线网关对每个靶标跑 nuclei/afrog（exec_run_cli 含 scope-guard
// fail-closed 硬校验），再经 exec_grep_result 核对预期模板是否命中，
// 产出 发现率/误报/耗时 报告到 data/eval/eval-range-report.json（标准入口，
// eval backend listReports/Q1 聚合可见；写前旧报告归档 reports/）。
// 用法: SEC_DATA_DIR=/opt/silkspool/dsh/data node eval-run.js [case ...]
// 依赖宿主已安装插件：sec-domain-bus / sec-domain-exec（setup 后存在）。
// ==============================================================================

import * as fs from 'node:fs'
import * as path from 'node:path'

const BASE = process.env.SEC_BASE_DIR || '/opt/silkspool/dsh'
const DATA_DIR = process.env.SEC_DATA_DIR || path.join(BASE, 'data')
const CASES_FILE = process.env.EVAL_CASES || path.join(BASE, 'eval-cases.list')
const PLUGINS = process.env.SEC_PLUGINS_DIR || path.join(BASE, 'plugins')

const { createBus } = await import(`file://${PLUGINS}/sec-domain-bus/index.js`)
const { buildExecDomain } = await import(`file://${PLUGINS}/sec-domain-exec/index.js`)

const bus = createBus({
  dataDir: DATA_DIR,
  dbFile: path.join(DATA_DIR, 'asset-graph.db'),
  aliasesFile: path.join(BASE, 'bus.aliases.yaml'),
  auditFile: path.join(DATA_DIR, 'audit.jsonl'),
  eventsDir: path.join(DATA_DIR, 'events'),
  sidecars: false,
  startDispatcherTimer: false, // 宿主 dispatcher 进程持有投递锁；本脚本只产事件不消费
})
const domain = buildExecDomain({
  dataDir: DATA_DIR,
  dispatch: (d, v, a, c) => bus.dispatch(d, v, a, c),
  query: (d, n, a, c) => bus.query(d, n, a, c),
})
const reg = bus.registry.register(domain)
if (!reg.ok) { console.error(`[eval] exec 域注册失败: ${reg.error?.code} ${reg.error?.message}`); process.exit(2) }

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
  const r = await bus.dispatch('exec', 'run_cli', { tool: toolName, params }, { actor: 'script', identity: 'eval-run' })
  const runId = r.ok ? r.data?.run_id : null
  if (!runId) {
    results.push({ name, target, engine, expected, found: false, error: r.error ? `${r.error.code}: ${r.error.message}` : 'no run_id', duration_ms: Date.now() - started })
    console.log(`管线失败: ${r.error?.code || ''} ${r.error?.message || ''}`)
    continue
  }
  const g = await bus.query('exec', 'grep_result', { run_id: runId, pattern: expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), max: 5 }, { actor: 'script' })
  const found = !!(g.ok && g.data && g.data.matched > 0)
  results.push({
    name, target, engine, expected, found,
    run_id: runId, exit_code: r.data?.exit_code ?? null,
    duration_ms: Date.now() - started,
  })
  console.log(found ? `发现 ✓ (${Math.round((Date.now() - started) / 1000)}s)` : `未发现 ✗ (${Math.round((Date.now() - started) / 1000)}s)`)
}

const found = results.filter((r) => r.found).length
const report = {
  ts: new Date().toISOString(),
  eval: 'range',
  mode: 'v5-bus',
  total: results.length,
  found,
  miss: results.length - found,
  detection_rate: results.length ? Math.round((found / results.length) * 100) / 100 : 0,
  total_duration_ms: results.reduce((s, r) => s + r.duration_ms, 0),
  results,
}
const outDir = path.join(DATA_DIR, 'eval')
fs.mkdirSync(outDir, { recursive: true })
// 标准入口：eval-range-report.json（写前归档旧报告进 reports/，与 backend writeReport INV-3 对齐）
const target = path.join(outDir, 'eval-range-report.json')
try {
  const prev = JSON.parse(fs.readFileSync(target, 'utf8'))
  if (prev && prev.ts) {
    const stamp = String(prev.ts).replace(/[^0-9]/g, '')
    fs.mkdirSync(path.join(outDir, 'reports'), { recursive: true })
    const archived = path.join(outDir, 'reports', `range-report-${stamp}.json`)
    if (!fs.existsSync(archived)) fs.copyFileSync(target, archived)
  }
} catch { /* 无旧报告 */ }
const tmp = `${target}.tmp-${process.pid}`
fs.writeFileSync(tmp, JSON.stringify(report, null, 1) + '\n')
fs.renameSync(tmp, target)
console.log(`\n[eval] 发现率 ${found}/${results.length} (${report.detection_rate * 100}%)  总耗时 ${Math.round(report.total_duration_ms / 1000)}s`)
console.log(`[eval] 报告: ${target}`)
bus._internal.close()
process.exit(0)
