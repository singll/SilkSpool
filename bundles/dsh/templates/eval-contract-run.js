#!/usr/bin/env node
// ==============================================================================
// SilkSecAgent 契约合规评测（v5 Phase 5.4 · Mode A 确定性真实管线跑）
//
// 与 eval-run.js 同风格：boot 真实总线 + 全部 14 域插件（真实网关，不 mock），
// 经 eval_run_contract 命令触发 Mode A（网关直断言，无 LLM 成本），逐用例断言
// 模型越权 100% 被拒（错误码匹配）+ hint 可引导（含引导 token），产出
// data/eval/contract-report.json，退出码 0（全过）/1（有失败）。
//
// 用法: SEC_BASE_DIR=/opt/silkspool/dsh node eval-contract-run.js [case ...]
//   [case ...] 可选，只跑指定用例名（须存在于 data/eval/contract-cases.jsonl）。
// 全部用例为确定性拒绝（不写 findings），可安全并发于运行中的 silksecagent。
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

async function main() {
  const only = process.argv.slice(2)
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
      // eval 域捕获 schedule 以便 await 真实异步执行器
      if (domain === 'eval') opts.schedule = (fn) => { scheduled.push(fn) }
      const built = mod[builder](opts)
      const reg = bus.registry.register(built)
      if (reg.ok) registered.push(domain)
      else console.error(`域 ${domain} 注册失败: ${reg.error?.code} ${reg.error?.message}`)
    } catch (e) {
      console.error(`域 ${domain} 加载失败: ${e?.message}`)
    }
  }
  console.log(`[eval-contract] 已注册域: ${registered.join(',')}`)

  const args = only.length ? { cases: only } : {}
  const r = await bus.dispatch('eval', 'run_contract', args, { actor: 'script' })
  if (!r.ok) {
    console.error(`[eval-contract] 触发 eval_run_contract 失败: ${r.error?.code} ${r.error?.message}`)
    bus._internal?.close?.()
    process.exit(1)
  }
  console.log(`[eval-contract] run_id=${r.data.run_id} status=${r.data.status} cases=${r.data.cases}`)

  // await 真实异步执行器（Mode A 确定性网关直断言）
  for (const fn of scheduled) await fn()

  const reportFile = path.join(DATA_DIR, 'eval', 'contract-report.json')
  if (!fs.existsSync(reportFile)) {
    console.error('[eval-contract] 未产出 contract-report.json')
    bus._internal?.close?.()
    process.exit(1)
  }
  const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'))
  console.log(JSON.stringify(report, null, 2))

  const pass = report.total > 0 && report.pass === report.total && report.failures.length === 0
  if (pass) {
    console.log(`[eval-contract] ✅ 契约合规通过：越权拒绝率 ${report.pass_rate}%（${report.pass}/${report.total}）`)
  } else {
    console.error(`[eval-contract] ❌ 契约合规未过：${report.pass}/${report.total}，失败:`)
    for (const f of report.failures) console.error(`  - ${f.name}: got=${f.got_code} expected=${f.expected_code} hint="${f.got_hint ?? ''}"`)
  }
  bus._internal?.close?.()
  process.exit(pass ? 0 : 1)
}

main().catch((e) => { console.error(e?.message || e); process.exit(1) })
