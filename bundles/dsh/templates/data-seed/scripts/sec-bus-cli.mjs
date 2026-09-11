#!/usr/bin/env node
// ==============================================================================
// sec-bus-cli.mjs — 领域总线人工应急通道（01-bus.md §1.8）
// 用法：
//   node sec-bus-cli.mjs dispatch <domain.verb> --args '{...}' --actor human [--operator X]
//   node sec-bus-cli.mjs query <domain.name> --args '{...}' --actor human
// 输出信封 JSON；audit 中 actor=human 高亮（宪法 §三）。
// 部署位置：scripts/pipeline/sec-bus-cli.mjs（版本受控进 bundle 模板）
//
// 域加载：CLI 是独立进程（不经 cordis apply），为让 domain 动词与 bus_replay 具备
// 真实订阅者，此处把 plugins/sec-domain-*/ 全部 14 域经 build*Domain() 组装并注册
// 进本地 bus 实例（dispatch/query 回环接线）。注册动作幂等（域内容一致即重复注册
// 无害），与宿主启动时 apply() 的注册路径同构。
// ==============================================================================

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const BASE_DIR = process.env.SEC_BASE_DIR || path.resolve(__dirname, '..', '..')
const DATA_DIR = process.env.SEC_DATA_DIR || path.join(BASE_DIR, 'data')

// 域插件清单：{ domain: build 函数名 }（build 函数 = plugins/sec-domain-<domain>/index.js 导出）
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
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--args') { out.args = JSON.parse(argv[++i] || '{}'); continue }
    if (a === '--actor') { out.actor = argv[++i]; continue }
    if (a === '--operator') { out.operator = argv[++i]; continue }
    if (a === '--profile') { out.profile = argv[++i]; continue }
    if (a === '--domains-only') { out.domainsOnly = true; continue }
    out._.push(a)
  }
  return out
}

async function loadDomains(bus) {
  const registered = []
  for (const [domain, builder] of Object.entries(DOMAIN_BUILDERS)) {
    try {
      const mod = await import(path.join(BASE_DIR, 'plugins', `sec-domain-${domain}`, 'index.js'))
      if (typeof mod[builder] !== 'function') { console.error(`域 ${domain} 缺少 ${builder} 导出`); continue }
      const built = mod[builder]({
        dataDir: DATA_DIR,
        dispatch: (d, v, a, c) => bus.dispatch(d, v, a, c),
        query: (d, v, a, c) => bus.query(d, v, a, c),
      })
      const reg = bus.registry.register(built)
      if (reg.ok) registered.push(domain)
      else console.error(`域 ${domain} 注册失败: ${reg.error?.code} ${reg.error?.message}`)
    } catch (e) {
      console.error(`域 ${domain} 加载失败: ${e?.message}`)
    }
  }
  return registered
}

async function main() {
  const argv = parseArgs(process.argv.slice(2))
  const [cmd, endpoint] = argv._
  if (!cmd || !endpoint) {
    console.error('用法: sec-bus-cli.mjs <dispatch|query> <domain.verb> [--args JSON] [--actor human] [--operator X]')
    process.exit(2)
  }
  const actor = argv.actor || 'human'
  const operator = argv.operator || null
  const args = argv.args || {}
  const dot = endpoint.indexOf('.')
  if (dot <= 0) {
    console.error(`端点格式非法: ${endpoint}`)
    process.exit(2)
  }
  const domain = endpoint.slice(0, dot)
  const verb = endpoint.slice(dot + 1)

  let bus
  try {
    const mod = await import(path.join(BASE_DIR, 'plugins', 'sec-domain-bus', 'index.js'))
    bus = mod.createBus({ dataDir: DATA_DIR, profile: argv.profile || 'cli' })
  } catch (e) {
    console.error(`总线加载失败: ${e?.message}`)
    process.exit(1)
  }

  // 注册全部域（使 domain 动词与 bus_replay 具备真实订阅者）
  const registered = await loadDomains(bus)
  if (process.env.SEC_BUS_DEBUG) console.error(`已注册域: ${registered.join(',')}`)

  let envelope
  try {
    if (cmd === 'dispatch') envelope = await bus.dispatch(domain, verb, args, { actor, operator })
    else if (cmd === 'query') envelope = await bus.query(domain, verb, args, { actor, operator })
    else {
      console.error(`未知命令: ${cmd}（仅 dispatch/query）`)
      process.exit(2)
    }
  } catch (e) {
    console.error(`执行异常: ${e?.message}`)
    process.exit(1)
  }
  process.stdout.write(JSON.stringify(envelope, null, 2) + '\n')
  bus._internal?.close?.()
  process.exit(envelope && envelope.ok === true ? 0 : 1)
}

main().catch((e) => { console.error(e?.message || e); process.exit(1) })
