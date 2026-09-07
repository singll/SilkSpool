#!/usr/bin/env node
// ==============================================================================
// sec-bus-cli.mjs — 领域总线人工应急通道（01-bus.md §1.8）
// 用法：
//   node sec-bus-cli.mjs dispatch <domain.verb> --args '{...}' --actor human [--operator X]
//   node sec-bus-cli.mjs query <domain.name> --args '{...}' --actor human
// 输出信封 JSON；audit 中 actor=human 高亮（宪法 §三）。
// 部署位置：scripts/pipeline/sec-bus-cli.mjs（版本受控进 bundle 模板）
// ==============================================================================

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const BASE_DIR = process.env.SEC_BASE_DIR || path.resolve(__dirname, '..', '..')
const DATA_DIR = process.env.SEC_DATA_DIR || path.join(BASE_DIR, 'data')

function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--args') { out.args = JSON.parse(argv[++i] || '{}'); continue }
    if (a === '--actor') { out.actor = argv[++i]; continue }
    if (a === '--operator') { out.operator = argv[++i]; continue }
    if (a === '--profile') { out.profile = argv[++i]; continue }
    out._.push(a)
  }
  return out
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
