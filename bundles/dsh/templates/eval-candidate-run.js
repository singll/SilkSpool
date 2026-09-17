#!/usr/bin/env node
// ==============================================================================
// SilkSecAgent 候选知识版本对照评测 runner（自学习专项 L3 · 设计 §7，契约 15-eval.md C5）
//
// 与 eval-contract-run.js 同风格：boot 真实总线 + 全部 14 域插件（真实网关，不 mock），
// 经 eval_run_candidate 命令触发候选×基线配对评测（冻结数据集 + fixture 受控真值），
// await 真实异步执行器（127.0.0.1 短命 fixture server + 状态断言），产出
// data/eval/eval-candidate-report.json；verdict eligible → know 侧订阅链置 eligible。
//
// 用法: SEC_BASE_DIR=/opt/silkspool/dsh node eval-candidate-run.js \
//         --trial <trial_id> --revision <revision_id> --dataset <dataset_id> [--actor script]
// 退出码 0=评测完成（eligible 或 rejected 均为有效结论）/1=触发失败或 run=failed。
// 注意：本进程即执行器宿主——进程退出中断的 run 会被孤儿扫描记 failed(host_restart)，
// 不记成功；know 侧停留 evaluating，可由 reactor abort 或下一次评测自愈。
// ==============================================================================

import * as fs from 'node:fs'
import * as path from 'node:path'

const BASE_DIR = process.env.SEC_BASE_DIR || '/opt/silkspool/dsh'
const DATA_DIR = process.env.SEC_DATA_DIR || path.join(BASE_DIR, 'data')

// 域插件清单（与 sec-bus-cli.mjs 一致：build 函数 = plugins/sec-domain-<domain>/index.js 导出）
const DOMAIN_BUILDERS = {
  vuln: 'buildVulnDomain',
  asset: 'buildAssetDomain',
  endpoint: 'buildEndpointDomain',
  fact: 'buildFactDomain',
  know: 'buildKnowDomain',
  ledger: 'buildLedgerDomain',
  task: 'buildTaskDomain',
  exec: 'buildExecDomain',
  fgs: 'buildFgsDomain',
  scope: 'buildScopeDomain',
  approval: 'buildApprovalDomain',
  report: 'buildReportDomain',
  proxy: 'buildProxyDomain',
  eval: 'buildEvalDomain',
}

function parseArgs(argv) {
  const out = { actor: 'script' }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--trial') { out.trial = argv[++i]; continue }
    if (a === '--revision') { out.revision = argv[++i]; continue }
    if (a === '--dataset') { out.dataset = argv[++i]; continue }
    if (a === '--actor') { out.actor = argv[++i]; continue }
    if (a === '--baseline') { out.baseline = argv[++i]; continue }
  }
  return out
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.trial || !args.revision || !args.dataset) {
    console.error('用法: eval-candidate-run.js --trial <trial_id> --revision <revision_id> --dataset <dataset_id> [--actor script] [--baseline ref]')
    process.exit(1)
  }
  const busMod = await import(path.join(BASE_DIR, 'plugins', 'sec-domain-bus', 'index.js'))
  const bus = busMod.createBus({ dataDir: DATA_DIR, profile: 'cli' })

  const scheduled = []
  const registered = []
  for (const [domain, builder] of Object.entries(DOMAIN_BUILDERS)) {
    try {
      const mod = await import(path.join(BASE_DIR, 'plugins', `sec-domain-${domain}`, 'index.js'))
      if (typeof mod[builder] !== 'function') { console.error(`域 ${domain} 缺少 ${builder} 导出`); continue }
      const opts = {
        dataDir: DATA_DIR,
        dispatch: (d, v, a, c) => bus.dispatch(d, v, a, c),
        query: (d, v, a, c) => bus.query(d, v, a, c),
      }
      // eval 域捕获 schedule 以便 await 真实异步执行器（fixture runner）
      if (domain === 'eval') opts.schedule = (fn) => { scheduled.push(fn) }
      const built = mod[builder](opts)
      const reg = bus.registry.register(built)
      if (reg.ok) registered.push(domain)
      else console.error(`域 ${domain} 注册失败: ${reg.error?.code} ${reg.error?.message}`)
    } catch (e) {
      console.error(`域 ${domain} 加载失败: ${e?.message}`)
    }
  }
  console.log(`[eval-candidate] 已注册域: ${registered.join(',')}`)

  const dispatchArgs = { trial_id: args.trial, candidate_revision_id: args.revision, dataset_id: args.dataset }
  if (args.baseline) dispatchArgs.baseline_ref = args.baseline
  const r = await bus.dispatch('eval', 'run_candidate', dispatchArgs, { actor: args.actor })
  if (!r.ok) {
    console.error(`[eval-candidate] 触发 eval_run_candidate 失败: ${r.error?.code} ${r.error?.message}${r.error?.hint ? `（${r.error.hint}）` : ''}`)
    bus._internal?.close?.()
    process.exit(1)
  }
  console.log(`[eval-candidate] run_id=${r.data.run_id} status=${r.data.status} cases=${r.data.cases} replay=${!!r.replay}`)

  // await 真实异步执行器（fixture runner：受控状态断言 + baseline/candidate 同案双跑）
  for (const fn of scheduled) await fn()

  const reportFile = path.join(DATA_DIR, 'eval', 'eval-candidate-report.json')
  if (!fs.existsSync(reportFile)) {
    const runFile = path.join(DATA_DIR, 'eval', 'runs', `${r.data.run_id}.json`)
    const rec = fs.existsSync(runFile) ? JSON.parse(fs.readFileSync(runFile, 'utf8')) : null
    console.error(`[eval-candidate] 未产出 eval-candidate-report.json（run status=${rec?.status || '?'} error=${rec?.error || '-'}）——失败/中断不记成功`)
    bus._internal?.close?.()
    process.exit(1)
  }
  const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'))
  console.log(JSON.stringify({ eval: report.eval, trial_id: report.trial_id, verdict: report.verdict, totals: report.totals, candidate: report.candidate, dataset: { id: report.dataset.id, visibility: report.dataset.visibility } }, null, 2))

  bus._internal?.close?.()
  process.exit(0)
}

main().catch((e) => { console.error(e?.message || e); process.exit(1) })
