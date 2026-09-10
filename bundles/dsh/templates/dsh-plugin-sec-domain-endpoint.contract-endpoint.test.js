// ==============================================================================
// @silksec/sec-domain-endpoint 契约测试（04-endpoint.md §2.2 矩阵：happy path / schema /
// 不变量 / 状态机 / actor / 幂等 / 并发 / 事件载荷 8 类 × 全动词 + 查询口径 + 队列语义）
// 运行：node --test test/contract-endpoint.test.js（插件组装目录内，type:module）
// 全部用例使用临时目录/临时库，绝不触碰 /opt/silkspool/dsh/data。
// ==============================================================================

import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createBus } from '../../sec-domain-bus/index.js'
import { buildEndpointDomain, ENDPOINT_MANIFEST } from '../index.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'sec-domain-endpoint-')) }

function makeEnv(opts = {}) {
  const dir = tmpDir()
  const dataDir = path.join(dir, 'data')
  fs.mkdirSync(dataDir, { recursive: true })
  fs.mkdirSync(path.join(dataDir, 'results', 'run_test_20260910_000000'), { recursive: true })
  fs.writeFileSync(path.join(dataDir, 'results', 'run_test_20260910_000000', 'meta.json'), '{}')
  fs.mkdirSync(path.join(dataDir, 'pipeline', 'test-src'), { recursive: true })
  fs.writeFileSync(path.join(dataDir, 'scope.yml'), [
    'version: 1',
    'programs:',
    '  - name: "test-src"',
    '    scope:',
    '      - "*.example.com"',
    '    exclude:',
    '      - "blocked.example.com"',
    '',
  ].join('\n'))
  const bus = createBus({
    dataDir,
    dbFile: path.join(dir, 'asset-graph.db'),
    aliasesFile: path.join(dir, 'bus.aliases.yaml'),
    auditFile: path.join(dir, 'audit.jsonl'),
    eventsDir: path.join(dir, 'events'),
    sidecars: false,
    startDispatcherTimer: false,
    ...opts,
  })
  const domain = buildEndpointDomain({ dataDir, dispatch: (d, v, a, c) => bus.dispatch(d, v, a, c) })
  const reg = bus.registry.register(domain)
  assert.equal(reg.ok, true, `endpoint 域应注册成功：${reg.error?.message || ''}`)
  return { dir, dataDir, bus, domain }
}

function readAudit(dir) {
  const f = path.join(dir, 'audit.jsonl')
  if (!fs.existsSync(f)) return []
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
}

function makeAliasEnv(dispatchAliases) {
  const dir = tmpDir()
  const dataDir = path.join(dir, 'data')
  fs.mkdirSync(dataDir, { recursive: true })
  fs.mkdirSync(path.join(dataDir, 'pipeline', 'test-src'), { recursive: true })
  fs.writeFileSync(path.join(dataDir, 'scope.yml'), 'programs:\n  - name: "test-src"\n    scope:\n      - "*.example.com"\n')
  let y = 'aliases:\n'
  y += 'dispatch_aliases:\n'
  for (const [k, v] of Object.entries(dispatchAliases)) y += `  ${k}:\n    router: ${v.router}\n    domain: ${v.domain}\n`
  fs.writeFileSync(path.join(dir, 'bus.aliases.yaml'), y)
  const bus = createBus({
    dataDir,
    dbFile: path.join(dir, 'asset-graph.db'),
    aliasesFile: path.join(dir, 'bus.aliases.yaml'),
    auditFile: path.join(dir, 'audit.jsonl'),
    eventsDir: path.join(dir, 'events'),
    sidecars: false,
    startDispatcherTimer: false,
  })
  const domain = buildEndpointDomain({ dataDir, dispatch: (d, v, a, c) => bus.dispatch(d, v, a, c) })
  bus.registry.register(domain)
  return { dir, dataDir, bus }
}

// ---------------------------------------------------------------------------
// 1. happy path
// ---------------------------------------------------------------------------

test('happy path: endpoint_upsert rows 模式登记（host+path 拆解 + endpoint.registered）', async () => {
  const { bus } = makeEnv()
  const r = await bus.dispatch('endpoint', 'upsert', {
    rows: [{ url: 'https://api.example.com/v1/users?id=1', method: 'GET', source: 'l2-collect:run_x', program_id: 'test-src' }],
  }, { actor: 'model', session_id: 'sess_1' })
  assert.equal(r.ok, true)
  assert.equal(r.data.created, 1)
  assert.ok(r.event_ids.length === 1)
  const row = bus._internal.db().prepare('SELECT * FROM endpoints WHERE host=?').get('api.example.com')
  assert.equal(row.path, '/v1/users?id=1')
  assert.equal(row.auth_required, null)
})

test('happy path: endpoint_upsert 触活（不同 source 刷 last_seen，created=false 不发事件）', async () => {
  const { bus } = makeEnv()
  await bus.dispatch('endpoint', 'upsert', { rows: [{ host: 'api.example.com', path: '/x', method: 'GET', source: 'l2:run_1' }] }, { actor: 'model' })
  const r2 = await bus.dispatch('endpoint', 'upsert', { rows: [{ host: 'api.example.com', path: '/x', method: 'GET', source: 'l2:run_2' }] }, { actor: 'model' })
  assert.equal(r2.data.created, 0)
  assert.equal(r2.data.touched, 1)
  assert.equal(r2.event_ids.length, 0)
})

test('happy path: endpoint_upsert tsv_path 批量（静态资源跳过 + 表头校验）', async () => {
  const { dir, dataDir, bus } = makeEnv()
  const tsv = [
    'url\tmethod\tparams\tauth_required\tsource\tcollected_at',
    'https://a.example.com/api/login\tGET\tmode,modelId\tunknown\tl2-collect:run_x\t1756080000000',
    'https://a.example.com/static/app.js\tGET\t\tunknown\tl2-collect:run_x\t1756080000000',
    'https://a.example.com/img/logo.png\tGET\t\tunknown\tl2-collect:run_x\t1756080000000',
  ].join('\n')
  const f = path.join(dataDir, 'results', 'run_test_20260910_000000', 'endpoints-proposal.tsv')
  fs.writeFileSync(f, tsv)
  const r = await bus.dispatch('endpoint', 'upsert', { tsv_path: f, program_id: 'test-src' }, { actor: 'script' })
  assert.equal(r.ok, true)
  assert.equal(r.data.created, 1)
  assert.equal(r.data.skipped_static, 2)
  const row = bus._internal.db().prepare('SELECT params FROM endpoints WHERE host=?').get('a.example.com')
  assert.ok(row.params.includes('mode'))
})

test('happy path: endpoint_mark_auth 鉴权标注（roles 并集累积）', async () => {
  const { bus } = makeEnv()
  await bus.dispatch('endpoint', 'upsert', { rows: [{ host: 'api.example.com', path: '/users', method: 'GET' }] }, { actor: 'model' })
  const r = await bus.dispatch('endpoint', 'mark_auth', { host: 'api.example.com', path: '/users', auth_required: 'yes', roles_seen: ['admin'], evidence: 'run_test_20260910_000000' }, { actor: 'model' })
  assert.equal(r.ok, true)
  assert.equal(r.data.auth_required, 'yes')
  assert.deepEqual(r.data.roles_seen, ['admin'])
  const r2 = await bus.dispatch('endpoint', 'mark_auth', { host: 'api.example.com', path: '/users', roles_seen: ['user', 'admin'] }, { actor: 'model' })
  assert.deepEqual(r2.data.roles_seen, ['admin', 'user'])
  assert.deepEqual(r2.data.roles_added, ['user'])
})

test('happy path: queue_surface 入队 + consume_queue 消化（seen 防重回）', async () => {
  const { dir, dataDir, bus } = makeEnv()
  const src = path.join(dataDir, 'results', 'run_test_20260910_000000', 'urls.txt')
  fs.writeFileSync(src, 'https://a.example.com/a?id=1\nhttps://a.example.com/b?x=2\nhttps://a.example.com/c\n')
  const r = await bus.dispatch('endpoint', 'queue_surface', { program: 'test-src', source: src }, { actor: 'model' })
  assert.equal(r.ok, true)
  assert.equal(r.data.new_urls, 2) // /c 无 query 不入队
  assert.equal(r.data.pool, 2)
  // 重放同文件：幂等返回首次结果（replay:true + 首次 new_urls）
  const r2 = await bus.dispatch('endpoint', 'queue_surface', { program: 'test-src', source: src }, { actor: 'model' })
  assert.equal(r2.replay, true)
  assert.equal(r2.data.new_urls, 2)
  // 消化
  const c = await bus.dispatch('endpoint', 'consume_queue', { program: 'test-src', mode: 'all', scanner: 'dalfox', run_id: 'run_test_20260910_000000' }, { actor: 'model' })
  assert.equal(c.ok, true)
  assert.equal(c.data.consumed, 2)
  assert.equal(c.data.remaining, 0)
  // seen 保留：换新文件但同 URL，不再入队（seen 防重回）
  const src2 = path.join(dataDir, 'results', 'run_test_20260910_000000', 'urls2.txt')
  fs.writeFileSync(src2, 'https://a.example.com/a?id=1\nhttps://a.example.com/b?x=2\n')
  const r3 = await bus.dispatch('endpoint', 'queue_surface', { program: 'test-src', source: src2 }, { actor: 'model' })
  assert.equal(r3.data.new_urls, 0)
})

// ---------------------------------------------------------------------------
// 2. schema 拒绝（INV-1 鉴权列只经 mark_auth）
// ---------------------------------------------------------------------------

test('schema: endpoint_upsert 传 auth_required 被拒（E_SCHEMA）', async () => {
  const { bus } = makeEnv()
  const r = await bus.dispatch('endpoint', 'upsert', { rows: [{ host: 'a.example.com', path: '/x', auth_required: 'yes' }] }, { actor: 'model' })
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'E_SCHEMA')
})

test('schema: endpoint_upsert method 越枚举 / rows tsv 同传被拒', async () => {
  const { bus } = makeEnv()
  const r = await bus.dispatch('endpoint', 'upsert', { rows: [{ host: 'a.example.com', path: '/x', method: 'BOGUS' }] }, { actor: 'model' })
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'E_SCHEMA')
  const r2 = await bus.dispatch('endpoint', 'upsert', { rows: [{ host: 'a.example.com', path: '/x' }], tsv_path: '/x/y.tsv' }, { actor: 'model' })
  assert.equal(r2.ok, false)
  assert.equal(r2.error.code, 'E_SCHEMA')
})

test('schema: endpoint_upsert rows 超 500 被拒（E_SCHEMA）', async () => {
  const { bus } = makeEnv()
  const rows = Array.from({ length: 501 }, (_, i) => ({ host: `h${i}.example.com`, path: '/x' }))
  const r = await bus.dispatch('endpoint', 'upsert', { rows }, { actor: 'script' })
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'E_SCHEMA')
})

// ---------------------------------------------------------------------------
// 3. 不变量反例
// ---------------------------------------------------------------------------

test('invariant INV-3: 域外 host 带 program_id 被拒，行级不回滚整批', async () => {
  const { bus } = makeEnv()
  const r = await bus.dispatch('endpoint', 'upsert', {
    rows: [
      { host: 'a.example.com', path: '/ok' },
      { host: 'evil.notinscope.com', path: '/bad', program_id: 'test-src' },
    ],
  }, { actor: 'script' })
  assert.equal(r.ok, true)
  assert.equal(r.data.created, 1) // 合法行仍入库
  const bad = r.data.results.find((x) => x.host === 'evil.notinscope.com')
  assert.ok(bad.ok === false)
})

test('invariant INV-5: mark_auth 未登记端点被拒（E_NOT_FOUND）', async () => {
  const { bus } = makeEnv()
  const r = await bus.dispatch('endpoint', 'mark_auth', { host: 'ghost.example.com', path: '/x', auth_required: 'yes', evidence: 'run_x' }, { actor: 'model' })
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'E_NOT_FOUND')
})

test('invariant INV-6: auth_required unknown→确定值缺 evidence 被拒（E_EVIDENCE_REQUIRED）', async () => {
  const { bus } = makeEnv()
  await bus.dispatch('endpoint', 'upsert', { rows: [{ host: 'a.example.com', path: '/x' }] }, { actor: 'model' })
  const r = await bus.dispatch('endpoint', 'mark_auth', { host: 'a.example.com', path: '/x', auth_required: 'yes' }, { actor: 'model' })
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'E_EVIDENCE_REQUIRED')
})

test('invariant: TSV 表头不符被拒（E_ENDPOINT_TSV_INVALID）', async () => {
  const { dataDir, bus } = makeEnv()
  const f = path.join(dataDir, 'bad.tsv')
  fs.writeFileSync(f, 'a\tb\tc\n1\t2\t3\n')
  const r = await bus.dispatch('endpoint', 'upsert', { tsv_path: f }, { actor: 'script' })
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'E_ENDPOINT_TSV_INVALID')
})

test('invariant: consume_queue run_id 证据目录不存在被拒', async () => {
  const { bus } = makeEnv()
  const r = await bus.dispatch('endpoint', 'consume_queue', { program: 'test-src', scanner: 'dalfox', run_id: 'run_nonexistent' }, { actor: 'model' })
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'E_EVIDENCE_REQUIRED')
})

// ---------------------------------------------------------------------------
// 4. actor 拒绝
// ---------------------------------------------------------------------------

test('actor: webhook 调 endpoint_upsert 被拒，dashboard 调 consume_queue 被拒', async () => {
  const { bus } = makeEnv()
  const r = await bus.dispatch('endpoint', 'upsert', { rows: [{ host: 'a.example.com', path: '/x' }] }, { actor: 'webhook' })
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'E_ACTOR_FORBIDDEN')
  const r2 = await bus.dispatch('endpoint', 'consume_queue', { program: 'test-src', scanner: 'dalfox', run_id: 'run_x' }, { actor: 'dashboard' })
  assert.equal(r2.ok, false)
  assert.equal(r2.error.code, 'E_ACTOR_FORBIDDEN')
})

// ---------------------------------------------------------------------------
// 5. 幂等重放
// ---------------------------------------------------------------------------

test('idempotent: endpoint_upsert 同 rows 重放 replay:true', async () => {
  const { bus } = makeEnv()
  const rows = [{ host: 'a.example.com', path: '/x' }]
  const r1 = await bus.dispatch('endpoint', 'upsert', { rows }, { actor: 'model' })
  assert.equal(r1.replay, false)
  const r2 = await bus.dispatch('endpoint', 'upsert', { rows }, { actor: 'model' })
  assert.equal(r2.replay, true)
})

test('idempotent: consume_queue 同 (program,run_id) 重放 replay:true（mode=all 已清空）', async () => {
  const { dataDir, bus } = makeEnv()
  const src = path.join(dataDir, 'u.txt')
  fs.writeFileSync(src, 'https://a.example.com/a?id=1\n')
  await bus.dispatch('endpoint', 'queue_surface', { program: 'test-src', source: src }, { actor: 'model' })
  const c1 = await bus.dispatch('endpoint', 'consume_queue', { program: 'test-src', mode: 'all', scanner: 'dalfox', run_id: 'run_test_20260910_000000' }, { actor: 'model' })
  assert.equal(c1.data.consumed, 1)
  const c2 = await bus.dispatch('endpoint', 'consume_queue', { program: 'test-src', mode: 'all', scanner: 'dalfox', run_id: 'run_test_20260910_000000' }, { actor: 'model' })
  assert.equal(c2.replay, true)
  assert.equal(c2.data.consumed, 1)
})

// ---------------------------------------------------------------------------
// 6. 查询口径
// ---------------------------------------------------------------------------

test('query: endpoint_list auth=none 筛未标注 / endpoint_hosts 分组 / endpoint_matrix 聚合', async () => {
  const { bus } = makeEnv()
  await bus.dispatch('endpoint', 'upsert', { rows: [
    { host: 'a.example.com', path: '/x1' },
    { host: 'a.example.com', path: '/x2' },
    { host: 'b.example.com', path: '/y' },
  ] }, { actor: 'model' })
  await bus.dispatch('endpoint', 'mark_auth', { host: 'a.example.com', path: '/x1', auth_required: 'yes', roles_seen: ['admin', 'user'], evidence: 'run_test_20260910_000000' }, { actor: 'model' })
  await bus.dispatch('endpoint', 'mark_auth', { host: 'a.example.com', path: '/x2', auth_required: 'no', evidence: 'run_test_20260910_000000' }, { actor: 'model' })
  const none = await bus.query('endpoint', 'list', { auth_required: 'none' }, { actor: 'dashboard' })
  assert.equal(none.total, 1)
  assert.equal(none.rows[0].host, 'b.example.com')
  const hosts = await bus.query('endpoint', 'hosts', {}, { actor: 'dashboard' })
  assert.equal(hosts.total, 2)
  const m = await bus.query('endpoint', 'matrix', { min_roles: 2 }, { actor: 'dashboard' })
  const aRow = m.rows.find((r) => r.host === 'a.example.com')
  assert.equal(aRow.multi_role_endpoints, 1)
  assert.equal(aRow.no_auth_endpoints, 1)
  assert.ok(aRow.priority_hint)
})

test('query: queue_status 反映入队/消化（last_consumed_at 非 null）', async () => {
  const { dataDir, bus } = makeEnv()
  const src = path.join(dataDir, 'u.txt')
  fs.writeFileSync(src, 'https://a.example.com/a?id=1\n')
  await bus.dispatch('endpoint', 'queue_surface', { program: 'test-src', source: src }, { actor: 'model' })
  await bus.dispatch('endpoint', 'consume_queue', { program: 'test-src', mode: 'all', scanner: 'dalfox', run_id: 'run_test_20260910_000000' }, { actor: 'model' })
  const st = await bus.query('endpoint', 'queue_status', { program: 'test-src' }, { actor: 'dashboard' })
  assert.equal(st.data.programs[0].queue_lines, 0)
  assert.equal(st.data.programs[0].seen_lines, 1)
  assert.ok(st.data.programs[0].last_consumed_at != null)
})

test('query: queue_status 全项目汇总跳过 pipeline 下非目录条目', async () => {
  const { dataDir, bus } = makeEnv()
  // pipeline 目录下放一个文件（v4 现状有 dsh-version-watch.log），应被跳过不崩
  fs.writeFileSync(path.join(dataDir, 'pipeline', 'dsh-version-watch.log'), 'x\n')
  const src = path.join(dataDir, 'u.txt')
  fs.writeFileSync(src, 'https://a.example.com/a?id=1\n')
  await bus.dispatch('endpoint', 'queue_surface', { program: 'test-src', source: src }, { actor: 'model' })
  const all = await bus.query('endpoint', 'queue_status', {}, { actor: 'dashboard' })
  assert.equal(all.ok, true)
  const byt = all.data.programs.find((p) => p.program === 'test-src')
  assert.ok(byt)
  assert.equal(byt.queue_lines, 1)
})

test('query: endpoint_surface_scan 命中敏感参数', async () => {
  const { bus } = makeEnv()
  await bus.dispatch('endpoint', 'upsert', { rows: [{ host: 'a.example.com', path: '/api?token=abc', program_id: 'test-src' }] }, { actor: 'model' })
  const s = await bus.query('endpoint', 'surface_scan', { program: 'test-src' }, { actor: 'dashboard' })
  assert.ok(s.data.total >= 1)
})

// ---------------------------------------------------------------------------
// 7. 并发（双进程入队：seen ≥ 各自 fresh 并集）
// ---------------------------------------------------------------------------

test('concurrency: 双并发 queue_surface 入队，seen 含两者并集', async () => {
  const { dataDir, bus } = makeEnv()
  const src1 = path.join(dataDir, 'u1.txt')
  const src2 = path.join(dataDir, 'u2.txt')
  fs.writeFileSync(src1, 'https://a.example.com/a?id=1\n')
  fs.writeFileSync(src2, 'https://a.example.com/b?id=2\n')
  await Promise.all([
    bus.dispatch('endpoint', 'queue_surface', { program: 'test-src', source: src1 }, { actor: 'model' }),
    bus.dispatch('endpoint', 'queue_surface', { program: 'test-src', source: src2 }, { actor: 'model' }),
  ])
  const st = await bus.query('endpoint', 'queue_status', { program: 'test-src' }, { actor: 'dashboard' })
  assert.ok(st.data.programs[0].seen_lines >= 2)
})

// ---------------------------------------------------------------------------
// 8. 事件载荷
// ---------------------------------------------------------------------------

test('event payload: endpoint.registered / endpoint.auth_marked / queue.enqueued', async () => {
  const { dataDir, bus } = makeEnv()
  await bus.dispatch('endpoint', 'upsert', { rows: [{ url: 'https://api.example.com/v1', method: 'POST' }] }, { actor: 'model' })
  await bus.dispatch('endpoint', 'mark_auth', { host: 'api.example.com', path: '/v1', method: 'POST', auth_required: 'no', evidence: 'run_test_20260910_000000' }, { actor: 'model' })
  const src = path.join(dataDir, 'u.txt')
  fs.writeFileSync(src, 'https://a.example.com/q?a=1\n')
  await bus.dispatch('endpoint', 'queue_surface', { program: 'test-src', source: src }, { actor: 'model' })
  const outbox = bus._internal.db().prepare('SELECT * FROM event_outbox').all()
  const names = outbox.map((o) => JSON.parse(o.payload).name)
  assert.ok(names.includes('endpoint.registered'))
  assert.ok(names.includes('endpoint.auth_marked'))
  assert.ok(names.includes('queue.enqueued'))
})

// ---------------------------------------------------------------------------
// 9. 别名（04-endpoint §3.2：endpoint_add 丢弃鉴权字段 / endpoint_query·surface_queue 平移）
// ---------------------------------------------------------------------------

test('alias: endpoint_add → endpoint_upsert（auth 字段被丢弃 + 单行包 rows）', async () => {
  const { dir, bus } = makeAliasEnv({ endpoint_add: { router: 'endpoint_add_router', domain: 'endpoint' } })
  const r = await bus.dispatch('', 'endpoint_add', { host: 'a.example.com', path: '/x', auth_required: 'yes', roles_seen: ['admin'] }, { actor: 'model' })
  assert.equal(r.ok, true)
  assert.equal(r.domain, 'endpoint')
  assert.equal(r.cmd, 'upsert')
  const row = bus._internal.db().prepare('SELECT auth_required, roles_seen FROM endpoints WHERE host=?').get('a.example.com')
  assert.equal(row.auth_required, null) // 鉴权字段被丢弃
  const audit = readAudit(dir)
  assert.ok(audit.find((a) => a.kind === 'deprecated_use' && a.alias === 'endpoint_add'))
})

test('alias: endpoint_query → endpoint_list / surface_queue → endpoint_queue_surface', async () => {
  const { dataDir, bus } = makeAliasEnv({
    endpoint_query: { router: 'endpoint_query_router', domain: 'endpoint' },
    surface_queue: { router: 'surface_queue_router', domain: 'endpoint' },
  })
  await bus.dispatch('endpoint', 'upsert', { rows: [{ host: 'a.example.com', path: '/x' }] }, { actor: 'model' })
  const q = await bus.query('', 'endpoint_query', { host: 'a.example.com' }, { actor: 'model' })
  assert.equal(q.ok, true)
  assert.equal(q.total, 1)
  const src = path.join(dataDir, 'u.txt')
  fs.writeFileSync(src, 'https://a.example.com/a?id=1\n')
  const s = await bus.dispatch('', 'surface_queue', { program: 'test-src', source: src }, { actor: 'model' })
  assert.equal(s.ok, true)
  assert.equal(s.cmd, 'queue_surface')
  assert.equal(s.data.new_urls, 1)
})
