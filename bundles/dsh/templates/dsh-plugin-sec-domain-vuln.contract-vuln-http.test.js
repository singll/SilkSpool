// ==============================================================================
// @silksec/sec-domain-vuln http-remote 后端契约测试（18-migration §六 4.3：三后端同套跑）
//
// 覆盖：混布模式（本地 sqlite overlay + outbox 同步远端）happy path / 同步回写 /
// 能力矩阵（纯模式候选池三动词 unsupported）/ E_BACKEND_UNAVAILABLE 降级 /
// 4xx → failed / 后端名报告 / 查询路由（信号面本地镜像）。
// 全部用例使用临时目录 + mock 远端 REST，绝不触碰 /opt/silkspool/dsh/data。
// 运行：node --test test/contract-vuln-http.test.js
// ==============================================================================

import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as http from 'node:http'
import { createBus } from '../../sec-domain-bus/index.js'
import { buildVulnDomain, VULN_MANIFEST } from '../index.js'

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sec-domain-vuln-http-'))
}

// mock 远端漏洞管理系统（通用 REST 形状，02-vuln §2.4）
// state.down=true 时直接断连（模拟网络故障）；state.rejectCreateWith=N 时 create 返回 N。
function startRemote() {
  const state = { rows: new Map(), nextId: 1, log: [], down: false, rejectCreateWith: 0 }
  const srv = http.createServer((req, res) => {
    if (state.down) { req.socket.destroy(); return }
    const u = new URL(req.url, 'http://x')
    const json = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) }
    const readBody = (cb) => { let b = ''; req.on('data', (c) => b += c); req.on('end', () => cb(b)) }

    if (req.method === 'POST' && u.pathname === '/api/v1/vulnerabilities') {
      if (state.rejectCreateWith) { readBody(() => json(state.rejectCreateWith, { error: 'rejected' })); return }
      readBody((body) => {
        const parsed = JSON.parse(body || '{}')
        const id = `remote-${state.nextId++}`
        state.rows.set(id, { id, ...parsed })
        state.log.push({ method: 'POST', path: u.pathname, body: parsed })
        json(201, { id })
      })
      return
    }
    const mm = u.pathname.match(/^\/api\/v1\/vulnerabilities\/([^/]+)$/)
    if (mm) {
      const id = decodeURIComponent(mm[1])
      if (req.method === 'PATCH') {
        readBody((body) => {
          const parsed = JSON.parse(body || '{}')
          const cur = state.rows.get(id) || { id }
          state.rows.set(id, { ...cur, ...parsed })
          state.log.push({ method: 'PATCH', id, body: parsed })
          json(200, { ok: true })
        })
        return
      }
      if (req.method === 'GET') {
        const row = state.rows.get(id)
        if (!row) return json(404, { error: 'not_found' })
        return json(200, row)
      }
    }
    if (req.method === 'GET' && u.pathname === '/api/v1/vulnerabilities') {
      return json(200, { rows: [...state.rows.values()], total: state.rows.size })
    }
    json(404, { error: 'not_found' })
  })
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, state, port: srv.address().port, base: `http://127.0.0.1:${srv.address().port}` })))
}

async function closeRemote(r) { await new Promise((res) => r.srv.close(res)) }

function makeHttpEnv(remote, opts = {}) {
  const dir = tmpDir()
  const dataDir = path.join(dir, 'data')
  fs.mkdirSync(dataDir, { recursive: true })
  fs.mkdirSync(path.join(dataDir, 'results', 'run_test_20260906_000000'), { recursive: true })
  fs.writeFileSync(path.join(dataDir, 'results', 'run_test_20260906_000000', 'meta.json'), '{}')
  const dbFile = path.join(dir, 'asset-graph.db')
  const bus = createBus({ dataDir, dbFile, aliasesFile: path.join(dir, 'bus.aliases.yaml'), auditFile: path.join(dir, 'audit.jsonl'), eventsDir: path.join(dir, 'events'), sidecars: false, startDispatcherTimer: false })
  const domain = buildVulnDomain({
    dataDir, dbFile, backend: 'http-remote',
    backendOptions: { baseUrl: remote ? remote.base : 'http://127.0.0.1:1', mode: opts.mode || 'hybrid', autoSync: false, backoffMs: opts.backoffMs || [1, 1, 1, 1, 1, 1] },
    dispatch: (d, v, a, c) => bus.dispatch(d, v, a, c),
  })
  const reg = bus.registry.register(domain)
  assert.equal(reg.ok, true, `vuln 域应注册成功：${reg.error?.message || ''}`)
  return { dir, dataDir, dbFile, bus, domain }
}

function seedSignal(bus, extra = {}) {
  return bus.dispatch('vuln', 'register_signal', {
    title: extra.title || 'http 后端测试信号：命令注入可执行系统命令',
    severity: 'high',
    host: 'h.example.com',
    url: 'https://h.example.com/admin',
    evidence: 'run_test_20260906_000000',
    reproduction_steps: '访问管理接口并以命令拼接参数重放',
    impact: '任意命令执行',
    ...extra,
  }, { actor: 'model', session_id: 'sess_1' })
}

function seedCandidate(bus, extra = {}) {
  return bus.dispatch('vuln', 'register_candidate', {
    title: extra.title || 'h.example.com 被动审计候选：xray',
    severity: 'medium',
    host: 'h.example.com',
    url: 'https://h.example.com/login',
    source: 'xray-webhook',
    ...extra,
  }, { actor: 'webhook', session_id: 'sess_webhook' })
}

// ---------------------------------------------------------------------------
// 1. 混布模式 happy path：信号面经 outbox 同步远端 + 候选池留本地 overlay
// ---------------------------------------------------------------------------

test('http-remote 混布：register_signal 落本地 + syncPending 推远端 + remote_id 回写', async () => {
  const remote = await startRemote()
  const { bus, domain } = makeHttpEnv(remote)
  const r = await seedSignal(bus)
  assert.equal(r.ok, true)
  const id = r.data.id
  let row = bus._internal.db().prepare('SELECT * FROM findings WHERE id=?').get(id)
  assert.equal(row.sync_state, 'pending', '命令主事务落本地后 sync_state=pending')
  assert.equal(row.remote_id, null)
  const sync = await domain.backend.syncPending()
  assert.equal(sync.synced, 1)
  row = bus._internal.db().prepare('SELECT * FROM findings WHERE id=?').get(id)
  assert.equal(row.sync_state, 'synced')
  assert.ok(row.remote_id, '应回写 remote_id')
  assert.ok(row.remote_synced_at)
  assert.equal(remote.state.rows.size, 1)
  const remoteRow = remote.state.rows.get(row.remote_id)
  assert.equal(remoteRow.title, row.title)
  assert.equal(remoteRow.host, 'h.example.com')
  await closeRemote(remote)
})

test('http-remote 混布：register_candidate 只落本地 overlay，不推远端', async () => {
  const remote = await startRemote()
  const { bus, domain } = makeHttpEnv(remote)
  const c = await seedCandidate(bus)
  assert.equal(c.ok, true)
  const row = bus._internal.db().prepare('SELECT * FROM findings WHERE id=?').get(c.data.id)
  assert.equal(row.noise, 1)
  const sync = await domain.backend.syncPending()
  assert.equal(sync.synced, 0, '候选行 noise=1 不应推远端')
  assert.equal(remote.state.rows.size, 0)
  await closeRemote(remote)
})

test('http-remote 混布：confirm 候选 → 信号面 → 推远端（create）；submit → PATCH 远端', async () => {
  const remote = await startRemote()
  const { bus, domain } = makeHttpEnv(remote)
  const c = await seedCandidate(bus)
  const id = c.data.id
  const cf = await bus.dispatch('vuln', 'confirm', { finding_id: id, evidence: 'run_test_20260906_000000' }, { actor: 'model' })
  assert.equal(cf.ok, true)
  assert.equal(cf.data.promoted_from_candidate, true)
  let sync = await domain.backend.syncPending()
  assert.equal(sync.synced, 1)
  const row = bus._internal.db().prepare('SELECT * FROM findings WHERE id=?').get(id)
  assert.ok(row.remote_id, 'confirm 后候选入信号面应推远端并回写 remote_id')
  const sub = await bus.dispatch('vuln', 'submit', { finding_id: id, platform: '测试SRC', vendor_status: 'submitted' }, { actor: 'model' })
  assert.equal(sub.ok, true)
  sync = await domain.backend.syncPending()
  assert.equal(sync.synced, 1)
  const patch = remote.state.log.find((l) => l.method === 'PATCH')
  assert.ok(patch, 'submit 应 PATCH 远端（已含 remote_id）')
  assert.equal(patch.id, row.remote_id)
  assert.equal(patch.body.status, 'submitted')
  assert.equal(remote.state.rows.size, 1, 'confirm+submit 只 create 一次 + PATCH 更新，不重复 create')
  await closeRemote(remote)
})

test('http-remote 混布：claim/release 候选留在本地（软锁），不推远端', async () => {
  const remote = await startRemote()
  const { bus, domain } = makeHttpEnv(remote)
  const c = await seedCandidate(bus)
  const id = c.data.id
  const cl = await bus.dispatch('vuln', 'claim', { finding_id: id }, { actor: 'model', session_id: 'sess_a' })
  assert.equal(cl.ok, true)
  await bus.dispatch('vuln', 'release', { finding_id: id }, { actor: 'model', session_id: 'sess_a' })
  const sync = await domain.backend.syncPending()
  assert.equal(sync.synced, 0)
  assert.equal(remote.state.rows.size, 0)
  await closeRemote(remote)
})

test('http-remote 混布：查询路由本地镜像（vuln_list/vuln_stats.sync 反映同步状态）', async () => {
  const remote = await startRemote()
  const { bus, domain } = makeHttpEnv(remote)
  await seedSignal(bus)
  await seedCandidate(bus)
  const q1 = await bus.query('vuln', 'list', { visibility: 'signal' }, { actor: 'model' })
  assert.equal(q1.ok, true)
  assert.equal(q1.total, 1, '信号面从本地镜像读取')
  let stats = await bus.query('vuln', 'stats', {}, { actor: 'model' })
  assert.equal(stats.data.sync.pending, 1, '待同步信号行=1')
  await domain.backend.syncPending()
  stats = await bus.query('vuln', 'stats', {}, { actor: 'model' })
  assert.equal(stats.data.sync.pending, 0)
  assert.equal(stats.data.sync.failed, 0)
  assert.ok(stats.data.sync.last_synced_at)
  await closeRemote(remote)
})

// ---------------------------------------------------------------------------
// 2. 纯模式能力矩阵：候选池三动词 unsupported（E_CAPABILITY_UNSUPPORTED）
// ---------------------------------------------------------------------------

test('http-remote 纯模式：register_candidate/claim/release → E_CAPABILITY_UNSUPPORTED', async () => {
  const remote = await startRemote()
  const { bus } = makeHttpEnv(remote, { mode: 'pure' })
  const c = await bus.dispatch('vuln', 'register_candidate', { title: '纯模式候选', severity: 'medium', host: 'p.example.com', source: 'xray-webhook' }, { actor: 'webhook' })
  assert.equal(c.ok, false)
  assert.equal(c.error.code, 'E_CAPABILITY_UNSUPPORTED')
  assert.match(c.error.message, /register_candidate/)
  const s = await seedSignal(bus, { host: 'p.example.com' })
  assert.equal(s.ok, true, '纯模式信号面仍 full')
  const st = await bus.query('bus', 'status', {}, { actor: 'dashboard' })
  const vuln = st.data.domains.find((d) => d.domain === 'vuln')
  assert.equal(vuln.backend, 'http-remote')
  assert.equal(vuln.capabilities.unsupported, 3)
  assert.equal(vuln.capabilities.full, Object.keys(VULN_MANIFEST.commands).length - 3)
  await closeRemote(remote)
})

// ---------------------------------------------------------------------------
// 3. E_BACKEND_UNAVAILABLE 降级 + 4xx → failed（fail-closed，不静默）
// ---------------------------------------------------------------------------

test('http-remote 混布：远端不可达 → 命令本地成功（业务不中断）+ 退避重试 → 恢复后同步成功', async () => {
  const remote = await startRemote()
  const { bus, domain } = makeHttpEnv(remote)
  remote.state.down = true
  const s = await seedSignal(bus, { title: '降级测试信号：SQL 注入可读库', host: 'd.example.com' })
  assert.equal(s.ok, true, '远端不可达时命令仍本地成功（可用性优先，最终一致）')
  let sync = await domain.backend.syncPending()
  assert.equal(sync.synced, 0)
  assert.ok(sync.retry >= 1, '网络失败应退回 pending 重试')
  let row = bus._internal.db().prepare('SELECT sync_state FROM findings WHERE id=?').get(s.data.id)
  assert.equal(row.sync_state, 'pending', '网络失败退回 pending 等待重试')
  remote.state.down = false
  sync = await domain.backend.syncPending()
  assert.equal(sync.synced, 1, '远端恢复后同步成功')
  row = bus._internal.db().prepare('SELECT sync_state, remote_id FROM findings WHERE id=?').get(s.data.id)
  assert.equal(row.sync_state, 'synced')
  assert.ok(row.remote_id)
  await closeRemote(remote)
})

test('http-remote 混布：远端 4xx（数据被拒）→ sync_state=failed 不再重试', async () => {
  const remote = await startRemote()
  const { bus, domain } = makeHttpEnv(remote)
  await seedSignal(bus)
  remote.state.rejectCreateWith = 400
  const sync = await domain.backend.syncPending()
  assert.equal(sync.failed, 1)
  const row = bus._internal.db().prepare('SELECT sync_state FROM findings WHERE sync_state=?').get('failed')
  assert.ok(row, '4xx 应标记 failed')
  const stats = await bus.query('vuln', 'stats', {}, { actor: 'model' })
  assert.equal(stats.data.sync.failed, 1)
  await closeRemote(remote)
})

// ---------------------------------------------------------------------------
// 4. 后端名报告（bus.domain.registered / bus_status）
// ---------------------------------------------------------------------------

test('http-remote：bus_status 报告 backend=http-remote', async () => {
  const remote = await startRemote()
  const { bus } = makeHttpEnv(remote)
  const st = await bus.query('bus', 'status', {}, { actor: 'dashboard' })
  const vuln = st.data.domains.find((d) => d.domain === 'vuln')
  assert.equal(vuln.registered, true)
  assert.equal(vuln.backend, 'http-remote')
  await closeRemote(remote)
})
