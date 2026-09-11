// ==============================================================================
// @silksec/sec-backend-proxy-file — proxy 域 file 后端（repository-v1，唯一实现）
//
// 契约：doc/secagent/v5/13-proxy.md §2.1/§2.4
//
// 职责：owns {POOL_DIR}/ 五文件（pool.json / live.txt / blocklist.txt / stats.json / sticky.json）
// 作为唯一写者（mubeng `-w` 是 live.txt 的原生消费者 + `--remove-on-error` 会回写 live.txt——
// 13-proxy §2.3 论证：热加载靠 mubeng 原生 watch，不靠事件）。out/proxies.json 与
// out/proposal.json 是采集链的只读 inbox（本域不写）。
//
// 写 = tmp + rename 原子落盘（INV-P6，mubeng 总是读到完整文件）；读 = 直读文件（≤ 数百 KB）。
// systemctl is-active / sudo -n systemctl start 仅在此封装（15s 超时、失败降级字符串），不进 repository 接口。
// 原语不含业务校验（校验在域命令网关不变量 / 命令体）。
// ==============================================================================

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'

export const name = '@silksec/sec-backend-proxy-file'
export const version = '1.0.0'
export const repositoryV1 = 'repository-v1'

const DEFAULT_POOL_DIR = process.env.SEC_PROXY_POOL_DIR || '/opt/silkspool/dsh/proxy-pool'

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}

function writeFileAtomic(target, content) {
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const tmp = `${target}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  fs.writeFileSync(tmp, content)
  fs.renameSync(tmp, target)
}

function defaultSystemctl(...args) {
  try {
    return String(execFileSync('systemctl', args, { timeout: 15000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).trim()
  } catch (err) {
    return String(err.stdout || err.stderr || err.message || 'error').trim()
  }
}

function defaultSystemctlSudo(...args) {
  try {
    return String(execFileSync('sudo', ['-n', 'systemctl', ...args], { timeout: 15000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).trim()
  } catch (err) {
    return String(err.stdout || err.stderr || err.message || 'error').trim()
  }
}

function createRepo(opts) {
  const poolDir = opts.poolDir
  const sysIsActive = opts.systemctlIsActive || ((unit) => defaultSystemctl('is-active', unit))
  const sysStartNoBlock = opts.systemctlStartNoBlock || ((unit) => defaultSystemctlSudo('start', '--no-block', unit))

  const POOL_JSON = path.join(poolDir, 'pool.json')
  const LIVE_TXT = path.join(poolDir, 'live.txt')
  const BLOCKLIST = path.join(poolDir, 'blocklist.txt')
  const STATS_JSON = path.join(poolDir, 'stats.json')
  const STICKY_JSON = path.join(poolDir, 'sticky.json')

  function resolveProposal(proposalPath) {
    // inbox 解析（防穿越：必须在 poolDir 前缀内）
    const abs = path.resolve(poolDir, String(proposalPath || ''))
    const prefix = poolDir.endsWith(path.sep) ? poolDir : poolDir + path.sep
    if (abs !== poolDir && !abs.startsWith(prefix)) return null
    return abs
  }

  const repo = {
    poolDir,

    // ---- 只读 inbox（proposal：采集链 owns，本域只读）----
    readProposal(proposalPath) {
      const defaultPath = path.join('out', 'proposal.json')
      const abs = resolveProposal(proposalPath || defaultPath)
      if (!abs) return null
      let raw = null
      try { raw = fs.readFileSync(abs, 'utf8') } catch { return null }
      let entries = null
      try { entries = JSON.parse(raw) } catch { return null }
      if (!Array.isArray(entries)) return null
      const sha = crypto.createHash('sha1').update(raw).digest('hex')
      return { entries, sha, path: abs }
    },

    // ---- pool ----
    readPool() { return readJSON(POOL_JSON, []) },
    readLiveSet() {
      try {
        return new Set(fs.readFileSync(LIVE_TXT, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean))
      } catch { return new Set() }
    },

    // ---- blocklist ----
    readBlocklistSet() {
      try {
        return new Set(fs.readFileSync(BLOCKLIST, 'utf8').split('\n')
          .map((l) => l.trim()).filter(Boolean)
          .map((l) => l.split('#')[0].trim()))
      } catch { return new Set() }
    },
    appendBlocklist(hostport, reason, ts) {
      fs.mkdirSync(poolDir, { recursive: true })
      const note = reason ? `${hostport}  # ${reason} ${ts}` : `${hostport}  # ${ts}`
      fs.appendFileSync(BLOCKLIST, note + '\n')
    },
    removeFromLive(hostport) {
      try {
        const lines = fs.readFileSync(LIVE_TXT, 'utf8').split('\n').filter((l) => l.trim())
        const kept = lines.filter((l) => !l.includes(hostport))
        const removed = kept.length !== lines.length
        if (removed) writeFileAtomic(LIVE_TXT, kept.join('\n') + (kept.length ? '\n' : ''))
        return removed
      } catch { return false }
    },

    // ---- stats / sticky ----
    readStats() { return readJSON(STATS_JSON, {}) },
    readSticky() { return readJSON(STICKY_JSON, {}) },
    writeStickyAtomic(obj) {
      fs.mkdirSync(poolDir, { recursive: true })
      writeFileAtomic(STICKY_JSON, JSON.stringify(obj, null, 1))
    },

    // ---- 落池主路径：pool/live/stats 三文件同批原子写（refresh）----
    writePoolAtomic(poolEntries, liveLines, stats) {
      fs.mkdirSync(poolDir, { recursive: true })
      writeFileAtomic(POOL_JSON, JSON.stringify(poolEntries, null, 1))
      writeFileAtomic(LIVE_TXT, liveLines.join('\n') + (liveLines.length ? '\n' : ''))
      writeFileAtomic(STATS_JSON, JSON.stringify(stats, null, 1))
    },

    // ---- 五文件可写性健康指标（13-proxy §1.1：采集单元以 root 跑，产出可能 root-owned）----
    // 写机制是 tmp+rename（INV-P6），只要求 poolDir 可写可遍历（rename 权限在目录不在文件）；
    // 故以目录 W_OK|X_OK 为判据，而非对既有 root-owned 文件做文件级 W_OK（会误报不可写）。
    poolWritable() {
      try {
        fs.accessSync(poolDir, fs.constants.W_OK | fs.constants.X_OK)
        return true
      } catch { return false }
    },

    // ---- sticky 失效清理（INV-P5：绑定出口 ∈ live）----
    cleanStickyNotInLive(liveSet) {
      const sticky = readJSON(STICKY_JSON, {})
      let removed = 0
      for (const key of Object.keys(sticky)) {
        const c = sticky[key]
        if (!c || !c.proxy || !liveSet.has(c.proxy)) { delete sticky[key]; removed++ }
      }
      if (removed) repo.writeStickyAtomic(sticky)
      return removed
    },

    // ---- systemctl 封装（15s 超时、失败降级字符串；不进 repository 接口语义）----
    systemctlIsActive(unit) { return sysIsActive(unit) },
    systemctlStartNoBlock(unit) { return sysStartNoBlock(unit) },
  }
  return repo
}

export function createProxyFileBackend(opts = {}) {
  const poolDir = opts.poolDir || DEFAULT_POOL_DIR
  return {
    capabilities: {},
    factory() {
      return createRepo({ poolDir, systemctlIsActive: opts.systemctlIsActive, systemctlStartNoBlock: opts.systemctlStartNoBlock })
    },
  }
}
