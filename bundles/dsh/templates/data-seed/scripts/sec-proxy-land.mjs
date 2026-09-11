#!/usr/bin/env node
// ==============================================================================
// sec-proxy-land.mjs — proxy 域落池 CLI（13-proxy §2.3 timer 链 ExecStartPost 调用）
// 采集链（silksec-proxy-refresh.service）产出 out/proposal.json 后，本脚本加载 bus + proxy 域，
// 以 actor=script 触发 proxy_refresh（trigger_collect:false 主路径：过滤/分级/排序 → 落池五文件）。
// 部署位置：scripts/pipeline/sec-proxy-land.mjs（版本受控进 bundle 模板，sec-proxy-domain-plugin-setup.sh 归位）。
// ==============================================================================

import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const BASE_DIR = process.env.SEC_BASE_DIR || path.resolve(__dirname, '..', '..')
const DATA_DIR = process.env.SEC_DATA_DIR || path.join(BASE_DIR, 'data')
const POOL_DIR = process.env.SEC_PROXY_POOL_DIR || path.join(BASE_DIR, 'proxy-pool')

async function main() {
  let busMod, proxyMod
  try {
    busMod = await import(path.join(BASE_DIR, 'plugins', 'sec-domain-bus', 'index.js'))
    proxyMod = await import(path.join(BASE_DIR, 'plugins', 'sec-domain-proxy', 'index.js'))
  } catch (e) {
    console.error(`总线/proxy 域加载失败: ${e?.message}`)
    process.exit(1)
  }
  const bus = busMod.createBus({ dataDir: DATA_DIR, profile: 'cli' })
  const domain = proxyMod.buildProxyDomain({ poolDir: POOL_DIR })
  const reg = bus.registry.register(domain)
  if (!reg.ok) {
    console.error(`proxy 域注册失败: ${reg.error?.code} ${reg.error?.message}`)
    process.exit(1)
  }
  let envelope
  try {
    envelope = await bus.dispatch('proxy', 'refresh', {}, { actor: 'script' })
  } catch (e) {
    console.error(`proxy_refresh 执行异常: ${e?.message}`)
    process.exit(1)
  }
  process.stdout.write(JSON.stringify(envelope, null, 2) + '\n')
  bus._internal?.close?.()
  process.exit(envelope && envelope.ok === true ? 0 : 1)
}

main().catch((e) => { console.error(e?.message || e); process.exit(1) })
