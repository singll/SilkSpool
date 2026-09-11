#!/usr/bin/env node
// ==============================================================================
// sec-owns-sandbox-check.mjs — owns × sandbox 交叉断言（17-llm-surface §2.2 #2）
// 断言：各域 manifest owns.tables（→ asset-graph.db）与 owns.files（→ data/ 下路径）
// 逐一校验不在 bwrap --bind（可写）白名单之内——域 owned 数据对沙箱不可写。
//
// bwrap 可写 bind 白名单（exec 域 buildSandboxCommand）：
//   --bind $HOME $HOME      （唯一静态可写 bind）
//   --bind <runDir> <runDir>（动态、每次新 run 目录，非域 owned 数据路径）
// 故静态断言 = owns 物理路径 ∉ $HOME 子树（漂移守卫：若将来把 $HOME 或 data/ 加进
// 可写 bind，或 owns 声明了 $HOME 内路径，此检查即红）。
//
// 用法：node sec-owns-sandbox-check.mjs [--json]
// 环境：SEC_BASE_DIR（默认 ../..）、SEC_DATA_DIR（默认 $SEC_BASE_DIR/data）、SEC_SANDBOX_HOME（默认 /home/silkspool）
// 退出码：0 = 全部通过；1 = 存在违规（setup §E 据此中止）
// ==============================================================================

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const BASE_DIR = process.env.SEC_BASE_DIR || path.resolve(__dirname, '..', '..')
const DATA_DIR = process.env.SEC_DATA_DIR || path.join(BASE_DIR, 'data')
const DB_FILE = process.env.SEC_DB_FILE || path.join(DATA_DIR, 'asset-graph.db')
// 沙箱 bwrap 可写 bind 的 $HOME 以服务进程（User=silkspool）为准，而非本检查脚本的运行用户：
// exec 域 buildSandboxCommand 的 `--bind $HOME $HOME` 在 silksecagent 进程内求值 HOME=/home/silkspool。
// 检查脚本可能以 root/spool 用户跑，故默认钉住 silkspool 家目录，可经 SEC_SANDBOX_HOME 覆盖。
const HOME_DIR = process.env.SEC_SANDBOX_HOME || '/home/silkspool'

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

function isUnder(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
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
  const jsonOut = process.argv.includes('--json')
  const { createBus } = await import(path.join(BASE_DIR, 'plugins', 'sec-domain-bus', 'index.js'))
  const bus = createBus({ dataDir: DATA_DIR, profile: 'mount-check', sidecars: false, startDispatcherTimer: false })
  const registered = await loadDomains(bus)

  const checks = []
  let violations = 0
  for (const d of registered) {
    const m = bus.registry.get(d)?.manifest
    if (!m || !m.owns) continue
    for (const t of m.owns.tables || []) {
      const ok = !isUnder(DB_FILE, HOME_DIR)
      if (!ok) violations++
      checks.push({ domain: d, kind: 'table', name: t, path: DB_FILE, writable_root: HOME_DIR, ok })
    }
    for (const rel of m.owns.files || []) {
      const p = path.resolve(BASE_DIR, rel)
      const ok = !isUnder(p, HOME_DIR)
      if (!ok) violations++
      checks.push({ domain: d, kind: 'file', name: rel, path: p, writable_root: HOME_DIR, ok })
    }
  }
  bus._internal?.close?.()

  if (jsonOut) {
    process.stdout.write(JSON.stringify({ ok: violations === 0, writable_root: HOME_DIR, db_file: DB_FILE, domains_loaded: registered.length, checks, violations }, null, 2) + '\n')
  } else {
    for (const c of checks) {
      if (!c.ok) console.log(`[FAIL] domain=${c.domain} ${c.kind}=${c.name} → ${c.path} 落在可写 bind ${c.writable_root} 内`)
    }
    console.log(`=== owns×sandbox 交叉断言: ${violations === 0 ? 'PASS' : 'FAIL'}（${checks.length} 项，违规 ${violations}，域加载 ${registered.length}）===`)
  }
  process.exit(violations === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e?.message || e); process.exit(1) })
