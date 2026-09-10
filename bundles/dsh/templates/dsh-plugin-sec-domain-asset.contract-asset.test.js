// ==============================================================================
// @silksec/sec-domain-asset 契约测试（03-asset.md §2.2 矩阵：happy path / schema /
// 不变量 / 状态机 / actor / 幂等 / 并发 / 事件载荷 8 类 × 全动词 + 查询口径 + 核心回归）
// 运行：node --test test/contract-asset.test.js（插件组装目录内，type:module）
// 全部用例使用临时目录/临时库，绝不触碰 /opt/silkspool/dsh/data。
// ==============================================================================

import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createBus } from '../../sec-domain-bus/index.js'
import { buildAssetDomain, ASSET_MANIFEST } from '../index.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'sec-domain-asset-')) }

function makeEnv(opts = {}) {
  const dir = tmpDir()
  const dataDir = path.join(dir, 'data')
  fs.mkdirSync(dataDir, { recursive: true })
  fs.mkdirSync(path.join(dataDir, 'results', 'run_test_20260910_000000'), { recursive: true })
  fs.writeFileSync(path.join(dataDir, 'results', 'run_test_20260910_000000', 'meta.json'), '{}')
  // scope.yml（INV-3 前置）
  fs.writeFileSync(path.join(dataDir, 'scope.yml'), [
    'version: 1',
    'defaults:',
    '  egress_proxy: http://127.0.0.1:8899',
    'programs:',
    '  - name: "test-src"',
    '    scope:',
    '      - "*.example.com"',
    '      - "192.168.1.0/24"',
    '    exclude:',
    '      - "blocked.example.com"',
    '  - name: "other-src"',
    '    scope:',
    '      - "*.other.com"',
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
  const domain = buildAssetDomain({ dataDir, dispatch: (d, v, a, c) => bus.dispatch(d, v, a, c) })
  const reg = bus.registry.register(domain)
  assert.equal(reg.ok, true, `asset 域应注册成功：${reg.error?.message || ''}`)
  return { dir, dataDir, bus, domain }
}

function readAudit(dir) {
  const f = path.join(dir, 'audit.jsonl')
  if (!fs.existsSync(f)) return []
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
}

function readEvents(dir, domain = 'asset') {
  const f = path.join(dir, 'events', `${domain}.jsonl`)
  if (!fs.existsSync(f)) return []
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
}

function makeAliasEnv(dispatchAliases) {
  const dir = tmpDir()
  const dataDir = path.join(dir, 'data')
  fs.mkdirSync(dataDir, { recursive: true })
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
  const domain = buildAssetDomain({ dataDir, dispatch: (d, v, a, c) => bus.dispatch(d, v, a, c) })
  bus.registry.register(domain)
  return { dir, dataDir, bus }
}

// ---------------------------------------------------------------------------
// 1. happy path
// ---------------------------------------------------------------------------

test('happy path: asset_upsert 登记新资产（created=true）+ asset.registered + audit', async () => {
  const { dir, bus } = makeEnv()
  const r = await bus.dispatch('asset', 'upsert', { host: 'admin.example.com', type: 'web', source: 'httpx:run_x', program_id: 'test-src' }, { actor: 'model', session_id: 'sess_1' })
  assert.equal(r.ok, true)
  assert.equal(r.data.created, true)
  assert.equal(r.data.host, 'admin.example.com')
  assert.ok(r.event_ids.length === 1)
  assert.equal(r.replay, false)
  const row = bus._internal.db().prepare('SELECT * FROM assets WHERE host=?').get('admin.example.com')
  assert.equal(row.level, null)
  assert.equal(row.root, 'example.com')
  const audit = readAudit(dir)
  assert.ok(audit.find((a) => a.kind === 'command' && a.cmd === 'upsert' && a.result === 'ok'))
})

test('happy path: asset_upsert 触活既有资产（created=false，不发事件）', async () => {
  const { bus } = makeEnv()
  await bus.dispatch('asset', 'upsert', { host: 'admin.example.com' }, { actor: 'model' })
  const r2 = await bus.dispatch('asset', 'upsert', { host: 'admin.example.com', source: 'manual' }, { actor: 'model' })
  assert.equal(r2.ok, true)
  assert.equal(r2.data.created, false)
  assert.equal(r2.event_ids.length, 0)
})

test('happy path: asset_grade 单资产分级（score 派生 level，可重评）', async () => {
  const { bus } = makeEnv()
  await bus.dispatch('asset', 'upsert', { host: 'admin.example.com' }, { actor: 'model' })
  const g = await bus.dispatch('asset', 'grade', { host: 'admin.example.com', score: 78, rationale: 'admin 后台接口密集，攻击面大' }, { actor: 'model' })
  assert.equal(g.ok, true)
  assert.equal(g.data.level, 'S')
  const row = bus._internal.db().prepare('SELECT level, score, graded_at FROM assets WHERE host=?').get('admin.example.com')
  assert.equal(row.level, 'S')
  assert.equal(row.score, 78)
  assert.ok(row.graded_at != null)
  // INV-5 已分级重评需 regrade
  const again = await bus.dispatch('asset', 'grade', { host: 'admin.example.com', score: 50, rationale: '重评降级依据一二三四五' }, { actor: 'model' })
  assert.equal(again.ok, false)
  assert.equal(again.error.code, 'E_ASSET_ALREADY_GRADED')
  const reg = await bus.dispatch('asset', 'grade', { host: 'admin.example.com', score: 50, rationale: '重评降级依据一二三四五', regrade: true }, { actor: 'model' })
  assert.equal(reg.ok, true)
  assert.equal(reg.data.level, 'B')
})

test('happy path: asset_grade proposal 批量分级（P1-P9 全过）', async () => {
  const { dir, dataDir, bus } = makeEnv()
  for (const h of ['a.example.com', 'b.example.com', 'c.example.com']) {
    await bus.dispatch('asset', 'upsert', { host: h }, { actor: 'model' })
  }
  const proposal = {
    schema: 'silksec/asset-grade-proposal@1',
    generated_by: 'grade-assets.py',
    generated_at: 1789000000000,
    run_id: 'run_test_20260910_000000',
    scoring_rules: 'rules/src/asset-scoring.md',
    scope_file: 'data/scope.yml',
    summary: { candidates: 3, skipped_out_of_scope: 0, by_level: { S: 1, A: 1, B: 1 } },
    rows: [
      { host: 'a.example.com', type: 'host', score: 90, reasons: ['kw:admin +18'] },
      { host: 'b.example.com', type: 'host', score: 65, reasons: ['fp_n=2 +8'] },
      { host: 'c.example.com', type: 'host', score: 45, reasons: ['hi_n=1 +25'] },
    ],
  }
  const f = path.join(dataDir, 'results', 'run_test_20260910_000000', 'grade-proposal.json')
  fs.writeFileSync(f, JSON.stringify(proposal))
  const g = await bus.dispatch('asset', 'grade', { proposal_path: f }, { actor: 'script', session_id: 'sess_script' })
  assert.equal(g.ok, true)
  assert.equal(g.data.mode, 'proposal')
  assert.equal(g.data.graded, 3)
  assert.deepEqual(g.data.by_level, { S: 1, A: 1, B: 1 })
  assert.equal(g.event_ids.length, 3)
})

test('happy path: asset_state 流转（new→changed→stable→dead→revived）', async () => {
  const { bus } = makeEnv()
  await bus.dispatch('asset', 'upsert', { host: 'api.example.com' }, { actor: 'model' })
  const c = await bus.dispatch('asset', 'state', { host: 'api.example.com', signal: 'content_changed', evidence: 'run_x' }, { actor: 'model' })
  assert.equal(c.ok, true)
  assert.equal(c.data.from, null)
  assert.equal(c.data.to, 'changed')
  const s = await bus.dispatch('asset', 'state', { host: 'api.example.com', signal: 'probe_alive_unchanged', evidence: 'run_x' }, { actor: 'model' })
  assert.equal(s.data.to, 'stable')
  const d = await bus.dispatch('asset', 'state', { host: 'api.example.com', signal: 'probe_failed', evidence: 'run_x' }, { actor: 'model' })
  assert.equal(d.data.to, 'dead')
  const v = await bus.dispatch('asset', 'state', { host: 'api.example.com', signal: 'revived', evidence: 'run_x' }, { actor: 'model' })
  assert.equal(v.data.to, 'changed')
})

test('happy path: fp_record 登记指纹（版本变化发事件）', async () => {
  const { bus } = makeEnv()
  const r = await bus.dispatch('asset', 'fp_record', { host: 'oa.example.com', tech: 'ruoyi', version: '4.7.2', program_id: 'test-src' }, { actor: 'model' })
  assert.equal(r.ok, true)
  assert.equal(r.data.created, true)
  assert.ok(r.event_ids.length === 1)
  // 同版本重报：不发事件
  const r2 = await bus.dispatch('asset', 'fp_record', { host: 'oa.example.com', tech: 'ruoyi', version: '4.7.2' }, { actor: 'model' })
  assert.equal(r2.event_ids.length, 0)
  // 版本变化：发事件
  const r3 = await bus.dispatch('asset', 'fp_record', { host: 'oa.example.com', tech: 'ruoyi', version: '4.7.3' }, { actor: 'model' })
  assert.equal(r3.event_ids.length, 1)
  assert.equal(r3.data.version_from, '4.7.2')
})

test('happy path: asset_upsert_bulk / fp_record_bulk 批量（行级结果 + 事件数）', async () => {
  const { bus } = makeEnv()
  const b = await bus.dispatch('asset', 'upsert_bulk', {
    rows: [
      { host: 'a.example.com' },
      { host: 'b.example.com' },
      { host: 'c.example.com' },
    ],
    proposal_ref: 'run_x',
  }, { actor: 'script' })
  assert.equal(b.ok, true)
  assert.equal(b.data.created, 3)
  assert.equal(b.event_ids.length, 3)
  const fb = await bus.dispatch('asset', 'fp_record_bulk', {
    rows: [
      { host: 'a.example.com', tech: 'spring', version: '5.0' },
      { host: 'b.example.com', tech: 'weblogic', version: '12c' },
    ],
  }, { actor: 'script' })
  assert.equal(fb.ok, true)
  assert.equal(fb.data.created, 2)
})

// ---------------------------------------------------------------------------
// 2. schema 拒绝（评级字段只经 asset_grade / state 只经 asset_state，INV-1 结构性）
// ---------------------------------------------------------------------------

test('schema: asset_upsert 传评级字段被拒（E_SCHEMA）', async () => {
  const { bus } = makeEnv()
  const r = await bus.dispatch('asset', 'upsert', { host: 'x.example.com', level: 'S', score: 90 }, { actor: 'model' })
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'E_SCHEMA')
})

test('schema: asset_upsert 缺 host / type 越枚举被拒', async () => {
  const { bus } = makeEnv()
  const r1 = await bus.dispatch('asset', 'upsert', {}, { actor: 'model' })
  assert.equal(r1.ok, false)
  assert.equal(r1.error.code, 'E_SCHEMA')
  const r2 = await bus.dispatch('asset', 'upsert', { host: 'x.example.com', type: 'bogus' }, { actor: 'model' })
  assert.equal(r2.ok, false)
  assert.equal(r2.error.code, 'E_SCHEMA')
})

test('schema: asset_grade score 越界被拒', async () => {
  const { bus } = makeEnv()
  await bus.dispatch('asset', 'upsert', { host: 'x.example.com' }, { actor: 'model' })
  const r = await bus.dispatch('asset', 'grade', { host: 'x.example.com', score: 999, rationale: '一二三四五六七八九十' }, { actor: 'model' })
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'E_SCHEMA')
})

// ---------------------------------------------------------------------------
// 3. 不变量反例（INV-3 scope / INV-4 未登记分级 / INV-6 level 非入参）
// ---------------------------------------------------------------------------

test('invariant INV-3: program_id 域外 host 被拒（E_INVARIANT），不带 program_id 放行', async () => {
  const { bus } = makeEnv()
  const r = await bus.dispatch('asset', 'upsert', { host: 'evil.notinscope.com', program_id: 'test-src' }, { actor: 'model' })
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'E_INVARIANT')
  const r2 = await bus.dispatch('asset', 'upsert', { host: 'evil.notinscope.com' }, { actor: 'model' })
  assert.equal(r2.ok, true)
})

test('invariant INV-3: exclude 清单内 host 被拒', async () => {
  const { bus } = makeEnv()
  const r = await bus.dispatch('asset', 'upsert', { host: 'blocked.example.com', program_id: 'test-src' }, { actor: 'model' })
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'E_INVARIANT')
})

test('invariant INV-4: 未登记资产分级被拒（E_NOT_FOUND）', async () => {
  const { bus } = makeEnv()
  const r = await bus.dispatch('asset', 'grade', { host: 'nope.example.com', score: 80, rationale: '一二三四五六七八九十' }, { actor: 'model' })
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'E_NOT_FOUND')
})

test('invariant: grade 两种模式同传被拒（E_SCHEMA）', async () => {
  const { bus } = makeEnv()
  const r = await bus.dispatch('asset', 'grade', { proposal_path: '/x/y.json', host: 'a.example.com', score: 80, rationale: '一二三四五六七八九十' }, { actor: 'model' })
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'E_SCHEMA')
})

// ---------------------------------------------------------------------------
// 4. 状态机反例（asset_state E_STATE）
// ---------------------------------------------------------------------------

test('state machine: dead + content_changed 被拒（E_STATE），dead + probe_alive_unchanged 被拒', async () => {
  const { bus } = makeEnv()
  await bus.dispatch('asset', 'upsert', { host: 'd.example.com' }, { actor: 'model' })
  await bus.dispatch('asset', 'state', { host: 'd.example.com', signal: 'probe_failed', evidence: 'run_x' }, { actor: 'model' })
  const r = await bus.dispatch('asset', 'state', { host: 'd.example.com', signal: 'content_changed', evidence: 'run_x' }, { actor: 'model' })
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'E_STATE')
  const r2 = await bus.dispatch('asset', 'state', { host: 'd.example.com', signal: 'probe_alive_unchanged', evidence: 'run_x' }, { actor: 'model' })
  assert.equal(r2.ok, false)
  assert.equal(r2.error.code, 'E_STATE')
})

test('state machine: 非 dead 资产 revived 被拒', async () => {
  const { bus } = makeEnv()
  await bus.dispatch('asset', 'upsert', { host: 'e.example.com' }, { actor: 'model' })
  const r = await bus.dispatch('asset', 'state', { host: 'e.example.com', signal: 'revived', evidence: 'run_x' }, { actor: 'model' })
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'E_STATE')
})

test('state machine: 未登记资产 state 流转被拒（E_NOT_FOUND）', async () => {
  const { bus } = makeEnv()
  const r = await bus.dispatch('asset', 'state', { host: 'ghost.example.com', signal: 'probe_failed', evidence: 'run_x' }, { actor: 'model' })
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'E_NOT_FOUND')
})

// ---------------------------------------------------------------------------
// 5. actor 拒绝
// ---------------------------------------------------------------------------

test('actor: webhook 调用 asset_upsert 被拒（E_ACTOR_FORBIDDEN）', async () => {
  const { bus } = makeEnv()
  const r = await bus.dispatch('asset', 'upsert', { host: 'a.example.com' }, { actor: 'webhook' })
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'E_ACTOR_FORBIDDEN')
})

test('actor: script 调 asset_grade 单资产模式放行，webhook 调 fp_record_bulk 被拒', async () => {
  const { bus } = makeEnv()
  const r = await bus.dispatch('asset', 'fp_record_bulk', { rows: [{ host: 'a.example.com', tech: 'spring' }] }, { actor: 'webhook' })
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'E_ACTOR_FORBIDDEN')
})

// ---------------------------------------------------------------------------
// 6. 幂等重放
// ---------------------------------------------------------------------------

test('idempotent: asset_upsert 同参重放 replay:true，异参触活 created:false（不冲突）', async () => {
  const { bus } = makeEnv()
  const r1 = await bus.dispatch('asset', 'upsert', { host: 'a.example.com', source: 'manual' }, { actor: 'model' })
  assert.equal(r1.replay, false)
  const r2 = await bus.dispatch('asset', 'upsert', { host: 'a.example.com', source: 'manual' }, { actor: 'model' })
  assert.equal(r2.replay, true)
  assert.equal(r2.data.created, true)
  // 异参（不同 source）= 触活，非冲突（重复登记安全）
  const r3 = await bus.dispatch('asset', 'upsert', { host: 'a.example.com', source: 'other' }, { actor: 'model' })
  assert.equal(r3.ok, true)
  assert.equal(r3.data.created, false)
})

test('idempotent: asset_state 同 host+signal+evidence 重放 replay:true', async () => {
  const { bus } = makeEnv()
  await bus.dispatch('asset', 'upsert', { host: 'a.example.com' }, { actor: 'model' })
  const r1 = await bus.dispatch('asset', 'state', { host: 'a.example.com', signal: 'probe_failed', evidence: 'run_x' }, { actor: 'model' })
  const r2 = await bus.dispatch('asset', 'state', { host: 'a.example.com', signal: 'probe_failed', evidence: 'run_x' }, { actor: 'model' })
  assert.equal(r2.replay, true)
})

// ---------------------------------------------------------------------------
// 7. 查询口径（行数 = total 断言）
// ---------------------------------------------------------------------------

test('query: asset_list / asset_overview / deep_queue 口径', async () => {
  const { bus } = makeEnv()
  await bus.dispatch('asset', 'upsert_bulk', { rows: [{ host: 'a.example.com' }, { host: 'b.example.com' }, { host: 'c.example.com' }] }, { actor: 'script' })
  await bus.dispatch('asset', 'grade', { host: 'a.example.com', score: 90, rationale: '一二三四五六七八九十' }, { actor: 'model' })
  await bus.dispatch('asset', 'grade', { host: 'b.example.com', score: 65, rationale: '一二三四五六七八九十' }, { actor: 'model' })
  // c 未分级
  const list = await bus.query('asset', 'list', { level: 'none' }, { actor: 'dashboard' })
  assert.equal(list.total, 1)
  assert.equal(list.rows[0].host, 'c.example.com')
  const dq = await bus.query('asset', 'deep_queue', {}, { actor: 'dashboard' })
  assert.equal(dq.total, 2) // S+A，c 未分级取不到
  const ov = await bus.query('asset', 'overview', {}, { actor: 'dashboard' })
  assert.equal(ov.data.total, 3)
  assert.equal(ov.data.by_level.S, 1)
  assert.equal(ov.data.by_level.A, 1)
})

test('query: asset_get 单主机钻取（多类型 + 指纹 + 跨域计数 + 同族）', async () => {
  const { bus } = makeEnv()
  await bus.dispatch('asset', 'upsert', { host: 'api.example.com', type: 'web' }, { actor: 'model' })
  await bus.dispatch('asset', 'upsert', { host: 'api.example.com', type: 'domain' }, { actor: 'model' })
  await bus.dispatch('asset', 'upsert', { host: 'www.example.com' }, { actor: 'model' })
  await bus.dispatch('asset', 'fp_record', { host: 'api.example.com', tech: 'nginx' }, { actor: 'model' })
  const g = await bus.query('asset', 'get', { host: 'api.example.com' }, { actor: 'dashboard' })
  assert.equal(g.data.assets.length, 2)
  assert.equal(g.data.fingerprints.length, 1)
  assert.equal(g.data.root, 'example.com')
  assert.equal(g.data.siblings.length, 1) // www.example.com
})

test('query: asset_family 族成员', async () => {
  const { bus } = makeEnv()
  await bus.dispatch('asset', 'upsert_bulk', { rows: [{ host: 'a.example.com' }, { host: 'b.example.com' }] }, { actor: 'script' })
  const f = await bus.query('asset', 'family', { root: 'example.com' }, { actor: 'dashboard' })
  assert.equal(f.data.hosts.length, 2)
})

test('query: fp_query 补 offset/total 分页信封', async () => {
  const { bus } = makeEnv()
  await bus.dispatch('asset', 'fp_record_bulk', { rows: [
    { host: 'a.example.com', tech: 'spring' }, { host: 'b.example.com', tech: 'weblogic' }, { host: 'c.example.com', tech: 'ruoyi' },
  ] }, { actor: 'script' })
  const q = await bus.query('asset', 'fp_query', { tech: 'w' }, { actor: 'dashboard' })
  assert.equal(q.total, 1)
  assert.equal(q.rows[0].tech, 'weblogic')
})

// ---------------------------------------------------------------------------
// 8. 事件载荷 / 并发
// ---------------------------------------------------------------------------

test('event payload: asset.registered / asset.graded / fp.recorded 载荷字段', async () => {
  const { dir, bus } = makeEnv()
  await bus.dispatch('asset', 'upsert', { host: 'a.example.com', source: 'httpx:run_1', program_id: 'test-src' }, { actor: 'model' })
  const ev = readEvents(dir)
  const reg = ev.find((e) => e.name === 'asset.registered')
  assert.equal(reg.payload.host, 'a.example.com')
  assert.equal(reg.payload.root, 'example.com')
  assert.equal(reg.payload.source, 'httpx:run_1')
})

test('concurrency: 并发 asset_upsert 同 host 只产生一行', async () => {
  const { bus } = makeEnv()
  await Promise.all([
    bus.dispatch('asset', 'upsert', { host: 'race.example.com' }, { actor: 'model' }),
    bus.dispatch('asset', 'upsert', { host: 'race.example.com' }, { actor: 'model' }),
    bus.dispatch('asset', 'upsert', { host: 'race.example.com' }, { actor: 'model' }),
  ])
  const n = bus._internal.db().prepare('SELECT COUNT(*) AS n FROM assets WHERE host=?').get('race.example.com').n
  assert.equal(n, 1)
})

// ---------------------------------------------------------------------------
// 9. ensureCol 幂等列演进
// ---------------------------------------------------------------------------

test('ensureCol: assets 表含 changed_at / graded_at 列', async () => {
  const { bus } = makeEnv()
  await bus.dispatch('asset', 'upsert', { host: 'a.example.com' }, { actor: 'model' })
  const cols = bus._internal.db().prepare('PRAGMA table_info(assets)').all().map((c) => c.name)
  assert.ok(cols.includes('changed_at'))
  assert.ok(cols.includes('graded_at'))
  assert.ok(cols.includes('root'))
})

// ---------------------------------------------------------------------------
// 10. 别名（03-asset §3.2：asset_add 丢弃评级字段 / asset_query·asset_stats·fp_add 平移）
// ---------------------------------------------------------------------------

test('alias: asset_add → asset_upsert（评级字段被丢弃，audit 记 deprecated_use）', async () => {
  const { dir, bus } = makeAliasEnv({ asset_add: { router: 'asset_add_router', domain: 'asset' } })
  const r = await bus.dispatch('', 'asset_add', { host: 'a.example.com', level: 'S', score: 90 }, { actor: 'model' })
  assert.equal(r.ok, true)
  assert.equal(r.domain, 'asset')
  assert.equal(r.cmd, 'upsert')
  assert.equal(r.data.created, true)
  const row = bus._internal.db().prepare('SELECT level, score FROM assets WHERE host=?').get('a.example.com')
  assert.equal(row.level, null) // 评级字段被丢弃
  const audit = readAudit(dir)
  assert.ok(audit.find((a) => a.kind === 'deprecated_use' && a.alias === 'asset_add'))
})

test('alias: asset_query → asset_list / asset_stats → asset_overview / fp_add → fp_record', async () => {
  const { bus } = makeAliasEnv({
    asset_query: { router: 'asset_query_router', domain: 'asset' },
    asset_stats: { router: 'asset_stats_router', domain: 'asset' },
    fp_add: { router: 'fp_add_router', domain: 'asset' },
  })
  await bus.dispatch('asset', 'upsert', { host: 'a.example.com' }, { actor: 'model' })
  const q = await bus.query('', 'asset_query', { host_like: 'example' }, { actor: 'model' })
  assert.equal(q.ok, true)
  assert.equal(q.total, 1)
  const s = await bus.query('', 'asset_stats', {}, { actor: 'model' })
  assert.equal(s.data.total, 1)
  const f = await bus.dispatch('', 'fp_add', { host: 'a.example.com', tech: 'nginx' }, { actor: 'model' })
  assert.equal(f.ok, true)
  assert.equal(f.cmd, 'fp_record')
})
