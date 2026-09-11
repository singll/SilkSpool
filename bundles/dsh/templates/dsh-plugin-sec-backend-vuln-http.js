// ==============================================================================
// @silksec/sec-backend-vuln-http — vuln 域 http-remote 后端（repository-v1，Phase 4）
//
// 契约：doc/secagent/v5/02-vuln.md §2.4（后端适配器）+ 18-migration.md §六（http-remote 试点）
//
// 职责：对接外部漏洞管理系统（REST）。混布模式（默认，推荐）= 本地 sqlite overlay
// 承接候选池 + 信号面经 outbox 异步同步远端；纯模式 = 候选池三动词能力矩阵
// unsupported（远端无候选语义），信号面同 outbox 同步。同步边界在域内 commands 层
// 以 `repo.markSyncPending(id)` 表达，本后端负责真正把 pending 行推到远端并回写
// remote_id/remote_synced_at/sync_state。
//
// 降级语义（02-vuln §2.4 E_BACKEND_UNAVAILABLE）：
//  - 混布/纯模式命令主事务先落本地 overlay 成功（业务不因远端抖动中断），
//    同步异步化；网络失败指数退避重试（30s/2m/10m/1h/6h/24h ×8 封顶），
//    远端 4xx（数据被拒）→ sync_state='failed' 不再重试 + audit 记远端响应。
//
// 重要：本地 overlay 复用 @silksec/sec-backend-vuln-sqlite 的 repository（同一
// findings 表、同一 WAL 库、同一 ensureCol 幂等列演进）；同步器使用**独立**的
// DatabaseSync 连接（避免与总线事务交叠），busy_timeout 5s 串行化。
// ==============================================================================

import * as path from 'node:path'
import * as http from 'node:http'
import * as https from 'node:https'
import { DatabaseSync } from 'node:sqlite'
import { createVulnSqliteBackend } from '../sec-backend-vuln-sqlite/index.js'

export const name = '@silksec/sec-backend-vuln-http'
export const version = '1.0.0'
export const repositoryV1 = 'repository-v1'

const log = (msg) => { try { process.stderr.write(`[sec-backend-vuln-http] ${msg}\n`) } catch { /* noop */ } }

// 指数退避（30s/2m/10m/1h/6h/24h）+ 8 次封顶（18-migration §六 4.2 / 02-vuln §2.4）
const BACKOFF_MS = [30_000, 120_000, 600_000, 3_600_000, 21_600_000, 86_400_000]
const MAX_ATTEMPTS = 8
const DEFAULT_SYNC_INTERVAL_MS = 30_000
const HTTP_TIMEOUT_MS = 15_000

// 远端 REST 映射（02-vuln §2.4 REST 映射示例，具体系统适配在 backend 插件内收口）：
//   POST   {base}/api/v1/vulnerabilities             → 201 {id}（create）
//   PATCH  {base}/api/v1/vulnerabilities/{remote_id} → 200（update）
//   GET    {base}/api/v1/vulnerabilities?status=&severity=&page=  （纯模式查询，混布走本地镜像）
//   GET    {base}/api/v1/vulnerabilities/{remote_id}
function restPath(base, seg) {
  const b = String(base || '').replace(/\/+$/, '')
  return `${b}${seg}`
}

function httpRequest({ method, url, body, token, timeoutMs = HTTP_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    let u
    try { u = new URL(url) } catch (e) { return reject(Object.assign(new Error(`远端 base_url 非法: ${url}`), { code: 'E_BACKEND_CONFIG', retryable: false })) }
    const mod = u.protocol === 'https:' ? https : http
    const payload = body === undefined || body === null ? null : JSON.stringify(body)
    const headers = { 'content-type': 'application/json', accept: 'application/json' }
    if (payload !== null) headers['content-length'] = Buffer.byteLength(payload)
    if (token) headers.authorization = `Bearer ${token}`
    let req
    try {
      req = mod.request({
        host: u.hostname,
        port: u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method,
        headers,
        timeout: timeoutMs,
      }, (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let parsed = null
          try { parsed = text ? JSON.parse(text) : null } catch { parsed = null }
          resolve({ status: res.statusCode, body: parsed, raw: text, headers: res.headers })
        })
        res.on('error', reject)
      })
    } catch (e) { return reject(e) }
    req.on('timeout', () => req.destroy(Object.assign(new Error('远端超时'), { code: 'ETIMEDOUT' })))
    req.on('error', reject)
    if (payload !== null) req.write(payload)
    req.end()
  })
}

function remoteFields(row) {
  return {
    title: row.title ?? '',
    severity: row.severity ?? '',
    host: row.host ?? '',
    url: row.url ?? '',
    evidence: row.evidence ?? '',
    source: row.source ?? '',
    status: row.status ?? 'new',
    confidence: row.confidence ?? 'tentative',
    bounty: row.bounty ?? null,
    vendor_status: row.vendor_status ?? '',
    program_id: row.program_id ?? null,
  }
}

function ensureSyncCols(db) {
  try {
    const cols = db.prepare('PRAGMA table_info(findings)').all()
    const has = (c) => cols.some((x) => x.name === c)
    if (!has('remote_id')) db.exec('ALTER TABLE findings ADD COLUMN remote_id TEXT')
    if (!has('remote_synced_at')) db.exec('ALTER TABLE findings ADD COLUMN remote_synced_at INTEGER')
    if (!has('sync_state')) db.exec('ALTER TABLE findings ADD COLUMN sync_state TEXT')
  } catch (e) { /* 表不存在或列已存在（幂等） */ }
}

// ---------------------------------------------------------------------------
// 工厂
// ---------------------------------------------------------------------------

export function createVulnHttpBackend(opts = {}) {
  const baseUrl = opts.baseUrl || process.env.SEC_VULN_HTTP_BASE_URL || ''
  const token = opts.token || process.env.SEC_VULN_HTTP_TOKEN || ''
  const dataDir = opts.dataDir || process.env.SEC_DATA_DIR || '/opt/silkspool/dsh/data'
  const dbFile = opts.dbFile || path.join(dataDir, 'asset-graph.db')
  const mode = opts.mode === 'pure' ? 'pure' : 'hybrid' // 默认混布（推荐）
  const syncIntervalMs = opts.syncIntervalMs || DEFAULT_SYNC_INTERVAL_MS
  const autoSync = opts.autoSync !== false
  const backoffMs = Array.isArray(opts.backoffMs) && opts.backoffMs.length ? opts.backoffMs : BACKOFF_MS

  const sqliteFactory = createVulnSqliteBackend({})
  const _repoCache = new WeakMap() // db → repository-http（包 sqlite overlay）
  const attempts = new Map()      // finding_id → 尝试次数（进程内，重启归零，试点可接受）
  const nextRetryAt = new Map()   // finding_id → 下次可重试时间戳
  let syncDb = null               // 同步器独立连接
  let syncInFlight = false
  let timer = null

  const capabilities = {}
  for (const verb of ['register_signal', 'register_candidate', 'confirm', 'reject', 'submit', 'note', 'claim', 'release', 'verify_replay', 'attach_fgs', 'authz_diff']) {
    const full = `vuln_${verb}`
    if (mode === 'pure' && (verb === 'register_candidate' || verb === 'claim' || verb === 'release')) {
      capabilities[full] = 'unsupported'
    } else {
      capabilities[full] = 'full'
    }
  }

  function openSyncDb() {
    if (syncDb) return syncDb
    syncDb = new DatabaseSync(dbFile)
    syncDb.exec('PRAGMA journal_mode = WAL')
    syncDb.exec('PRAGMA busy_timeout = 5000')
    syncDb.exec('PRAGMA synchronous = NORMAL')
    ensureSyncCols(syncDb)
    return syncDb
  }

  // 单次同步扫掠：claim pending → 逐行推远端 → 回写。幂等可并发（syncing 标记防双写）。
  async function syncPending() {
    if (syncInFlight) return { in_flight: true }
    if (!baseUrl) return { error: 'no-base-url', skipped: true }
    syncInFlight = true
    const res = { pushed: 0, synced: 0, failed: 0, retry: 0 }
    try {
      const db = openSyncDb()
      const nowMs = Date.now()
      const pendings = db.prepare("SELECT * FROM findings WHERE sync_state = 'pending' AND noise = 0").all()
        .map((r) => ({ ...r }))
      const due = pendings.filter((r) => !(nextRetryAt.get(r.id) > nowMs))
      for (const r of due) {
        try { db.prepare("UPDATE findings SET sync_state = 'syncing' WHERE id = ?").run(r.id) } catch { /* noop */ }
      }
      const rows = db.prepare("SELECT * FROM findings WHERE sync_state = 'syncing' AND noise = 0").all().map((r) => ({ ...r }))
      for (const row of rows) {
        try {
          const fields = remoteFields(row)
          let remoteId = row.remote_id || null
          if (remoteId) {
            const r = await httpRequest({ method: 'PATCH', url: restPath(baseUrl, `/api/v1/vulnerabilities/${encodeURIComponent(remoteId)}`), body: fields, token })
            if (r.status < 200 || r.status >= 300) throw Object.assign(new Error(`远端更新被拒 ${r.status}: ${r.raw?.slice(0, 200) || ''}`), { status: r.status, retryable: false })
            db.prepare("UPDATE findings SET sync_state = 'synced', remote_synced_at = ? WHERE id = ?").run(nowMs, row.id)
            attempts.delete(row.id); nextRetryAt.delete(row.id)
            res.synced++
          } else {
            const r = await httpRequest({ method: 'POST', url: restPath(baseUrl, '/api/v1/vulnerabilities'), body: fields, token })
            if (r.status < 200 || r.status >= 300) throw Object.assign(new Error(`远端创建被拒 ${r.status}: ${r.raw?.slice(0, 200) || ''}`), { status: r.status, retryable: false })
            const id = String(r.body?.id ?? r.body?.remote_id ?? r.body?.data?.id ?? '')
            if (!id) throw Object.assign(new Error('远端未返回 id'), { retryable: false })
            db.prepare("UPDATE findings SET sync_state = 'synced', remote_id = ?, remote_synced_at = ? WHERE id = ?").run(id, nowMs, row.id)
            attempts.delete(row.id); nextRetryAt.delete(row.id)
            res.synced++
          }
        } catch (e) {
          const status = e?.status
          const is4xx = status >= 400 && status < 500
          const n = (attempts.get(row.id) || 0) + 1
          attempts.set(row.id, n)
          if (is4xx) {
            db.prepare("UPDATE findings SET sync_state = 'failed' WHERE id = ?").run(row.id)
            res.failed++
            log(`远端拒绝 finding #${row.id}（4xx ${status}）：${e?.message}，sync_state=failed 不再重试`)
          } else if (n >= MAX_ATTEMPTS) {
            db.prepare("UPDATE findings SET sync_state = 'failed' WHERE id = ?").run(row.id)
            res.failed++
            log(`finding #${row.id} 重试 ${n} 次封顶，sync_state=failed：${e?.message}`)
          } else {
            db.prepare("UPDATE findings SET sync_state = 'pending' WHERE id = ?").run(row.id)
            nextRetryAt.set(row.id, nowMs + backoffMs[Math.min(n - 1, backoffMs.length - 1)])
            res.retry++
            log(`finding #${row.id} 同步失败（第 ${n} 次），${backoffMs[Math.min(n - 1, backoffMs.length - 1)] / 1000}s 后重试：${e?.message}`)
          }
        }
      }
    } catch (e) {
      log(`同步扫掠异常：${e?.message}`)
      res.error = e?.message
    } finally {
      syncInFlight = false
    }
    return res
  }

  function startSyncer() {
    if (timer) return { started: false, note: '已启动' }
    if (!baseUrl) return { started: false, note: '未配置 baseUrl，同步器不启动（本地 overlay 照常服务）' }
    const run = () => { syncPending().catch((e) => log(`同步 tick 异常：${e?.message}`)) }
    timer = setInterval(run, syncIntervalMs)
    timer.unref?.()
    log(`http-remote 同步器启动（${mode} 模式，间隔 ${syncIntervalMs}ms）`)
    return { started: true }
  }

  function stopSyncer() {
    if (timer) { clearInterval(timer); timer = null }
    if (syncDb) { try { syncDb.close() } catch { /* noop */ } syncDb = null }
  }

  // repository-http：包一层 sqlite overlay（findings 全量本地镜像），追加 markSyncPending
  // 原语供域 commands 层表达同步边界（02-vuln §2.4：同步边界在 commands 层）。
  function factory(db) {
    let repo = _repoCache.get(db)
    if (!repo) {
      const local = sqliteFactory.factory(db)
      repo = {
        ...local,
        markSyncPending(id) {
          try { db.prepare("UPDATE findings SET sync_state = 'pending' WHERE id = ? AND noise = 0").run(Number(id)) } catch { /* noop */ }
          return {}
        },
      }
      _repoCache.set(db, repo)
    }
    return repo
  }

  return {
    name: 'http-remote',
    mode,
    capabilities,
    factory,
    syncPending,
    startSyncer,
    stopSyncer,
  }
}
