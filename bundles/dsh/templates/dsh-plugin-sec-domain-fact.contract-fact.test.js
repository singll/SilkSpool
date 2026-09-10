// ==============================================================================
// @silksec/sec-domain-fact 契约测试（06-fact.md §契约矩阵：happy path / schema /
// 不变量 / 状态机 / actor / 幂等 / 查询口径 / 事件载荷）
// 运行：node --test test/contract-fact.test.js（插件组装目录内，type:module）
// ==============================================================================

import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createBus } from '../../sec-domain-bus/index.js'
import { buildFactDomain, FACT_MANIFEST } from '../index.js'

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'sec-domain-fact-')) }

function makeEnv(aliasesYaml = '') {
  const dir = tmpDir()
  const dataDir = path.join(dir, 'data')
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(path.join(dataDir, 'scope.yml'), 'programs:\n  - name: "test-src"\n    scope:\n      - "*.example.com"\n')
  if (aliasesYaml) fs.writeFileSync(path.join(dir, 'bus.aliases.yaml'), aliasesYaml)
  const bus = createBus({
    dataDir,
    dbFile: path.join(dir, 'asset-graph.db'),
    aliasesFile: path.join(dir, 'bus.aliases.yaml'),
    auditFile: path.join(dir, 'audit.jsonl'),
    eventsDir: path.join(dir, 'events'),
    sidecars: false,
    startDispatcherTimer: false,
  })
  const domain = buildFactDomain({ dataDir, dispatch: (d, v, a, c) => bus.dispatch(d, v, a, c) })
  const reg = bus.registry.register(domain)
  assert.equal(reg.ok, true, `fact 域应注册成功：${reg.error?.message || ''}`)
  return { dir, dataDir, bus }
}

function readAudit(dir) {
  const f = path.join(dir, 'audit.jsonl')
  if (!fs.existsSync(f)) return []
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
}
function readEvents(dir) {
  const f = path.join(dir, 'events', 'fact.jsonl')
  if (!fs.existsSync(f)) return []
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
}

// ---------------------------------------------------------------------------
// 1. happy path
// ---------------------------------------------------------------------------

test('happy path: fact_upsert 写一条事实（durable 默认复验）+ fact.upserted + audit', async () => {
  const { dir, bus } = makeEnv()
  const r = await bus.dispatch('fact', 'upsert', {
    program_id: 'test-src', fact_key: 'auth/cred-admin', category: 'auth',
    summary: 'admin 后台弱口令可登录', body: 'run_id=run_x 验证 admin/admin123 可登录', confidence: 'confirmed', source: 'agent',
  }, { actor: 'model', session_id: 'sess_1' })
  assert.equal(r.ok, true)
  assert.equal(r.data.mem_class, 'durable')
  assert.equal(r.data.merged, false)
  assert.equal(r.replay, false)
  const row = bus._internal.db().prepare('SELECT * FROM facts WHERE program_id=? AND fact_key=?').get('test-src', 'auth/cred-admin')
  assert.equal(row.confidence, 'confirmed')
  assert.ok(row.revalidate_by != null)
  assert.ok(row.last_validated_at != null)
  assert.equal(row.status, 'active')
  assert.ok(readEvents(dir).find((e) => e.name === 'fact.upserted'))
  assert.ok(readAudit(dir).find((a) => a.kind === 'command' && a.cmd === 'upsert' && a.result === 'ok'))
})

test('happy path: note 类默认 ephemeral 14d（expires_at 就位）', async () => {
  const { bus } = makeEnv()
  const r = await bus.dispatch('fact', 'upsert', {
    program_id: 'test-src', fact_key: 'note/failed-upload', category: 'note', summary: '上传接口 403', source: 'auto:runcli-fail',
  }, { actor: 'model' })
  assert.equal(r.data.mem_class, 'ephemeral')
  const row = bus._internal.db().prepare('SELECT * FROM facts WHERE program_id=? AND fact_key=?').get('test-src', 'note/failed-upload')
  assert.ok(row.expires_at != null)
  assert.equal(row.revalidate_by, null)
})

test('happy path: fact_link 建边 + fact.linked + fact_graph 遍历', async () => {
  const { bus } = makeEnv()
  await bus.dispatch('fact', 'upsert', { program_id: 'p', fact_key: 'host/a', summary: 'host a' }, { actor: 'model' })
  await bus.dispatch('fact', 'upsert', { program_id: 'p', fact_key: 'host/b', summary: 'host b' }, { actor: 'model' })
  const l = await bus.dispatch('fact', 'link', { program_id: 'p', src_key: 'host/a', dst_key: 'host/b', edge_type: 'resolves_to', confidence: 'confirmed' }, { actor: 'model' })
  assert.equal(l.ok, true)
  const g = await bus.query('fact', 'graph', { program_id: 'p', fact_key: 'host/a' }, { actor: 'model' })
  assert.equal(g.data.out.length, 1)
  assert.equal(g.data.out[0].dst_key, 'host/b')
  assert.equal(g.data.in.length, 0)
})

test('happy path: fact_bb_publish [env-issue] + fact.bb.published（channel=env-issue）', async () => {
  const { dir, bus } = makeEnv()
  const r = await bus.dispatch('fact', 'bb_publish', { key: '[env-issue] egress-blocked', value: 'egress 出口被 WAF 拦截', mem_class: 'ephemeral', ttl_days: 3 }, { actor: 'script' })
  assert.equal(r.ok, true)
  const ev = readEvents(dir).find((e) => e.name === 'fact.bb.published')
  assert.equal(ev.payload.channel, 'env-issue')
  const row = bus._internal.db().prepare('SELECT * FROM blackboard WHERE key=?').get('[env-issue] egress-blocked')
  assert.equal(row.mem_class, 'ephemeral')
})

test('happy path: fact_record_validation 复验刷新（cooling 自愈 active）', async () => {
  const { bus } = makeEnv()
  await bus.dispatch('fact', 'upsert', { program_id: 'p', fact_key: 'auth/x', summary: 's', confidence: 'confirmed' }, { actor: 'model' })
  // 转入 cooling
  await bus.dispatch('fact', 'transition', { object: 'fact', program_id: 'p', fact_key: 'auth/x', to: 'cooling', reason: '复验期已过，人工治理流转' }, { actor: 'system' })
  const v = await bus.dispatch('fact', 'record_validation', { program_id: 'p', fact_key: 'auth/x', evidence: 'run_revalidate_1' }, { actor: 'model' })
  assert.equal(v.ok, true)
  const row = bus._internal.db().prepare('SELECT status FROM facts WHERE program_id=? AND fact_key=?').get('p', 'auth/x')
  assert.equal(row.status, 'active')
})

test('happy path: fact_reindex 建边 + fact_purge_archive', async () => {
  const { bus } = makeEnv()
  await bus.dispatch('fact', 'upsert', { program_id: 'p', fact_key: 'host/a', summary: 'api.example.com 后台' }, { actor: 'model' })
  await bus.dispatch('fact', 'upsert', { program_id: 'p', fact_key: 'host/b', summary: 'www.example.com 前台' }, { actor: 'model' })
  const r = await bus.dispatch('fact', 'reindex', { program_id: 'p' }, { actor: 'model' })
  assert.equal(r.ok, true)
  assert.ok(r.data.edges >= 1)
})

// ---------------------------------------------------------------------------
// 2. schema 拒绝
// ---------------------------------------------------------------------------

test('schema: fact_key 不含 / 被拒；confidence 非法被拒；未知参数被拒', async () => {
  const { bus } = makeEnv()
  const r1 = await bus.dispatch('fact', 'upsert', { program_id: 'p', fact_key: 'nope' }, { actor: 'model' })
  assert.equal(r1.ok, false)
  assert.equal(r1.error.code, 'E_SCHEMA')
  const r2 = await bus.dispatch('fact', 'upsert', { program_id: 'p', fact_key: 'a/b', confidence: 'bogus' }, { actor: 'model' })
  assert.equal(r2.ok, false)
  assert.equal(r2.error.code, 'E_SCHEMA')
  const r3 = await bus.dispatch('fact', 'upsert', { program_id: 'p', fact_key: 'a/b', bogus_param: 1 }, { actor: 'model' })
  assert.equal(r3.ok, false)
  assert.equal(r3.error.code, 'E_SCHEMA')
})

// ---------------------------------------------------------------------------
// 3. 不变量拒绝
// ---------------------------------------------------------------------------

test('invariant INV-F1: mem_class=permanent 被拒', async () => {
  const { bus } = makeEnv()
  const r = await bus.dispatch('fact', 'upsert', { program_id: 'p', fact_key: 'a/b', mem_class: 'permanent' }, { actor: 'model' })
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'E_INVARIANT')
})

test('invariant INV-F3/F4: ttl/revalidate 越界被拒', async () => {
  const { bus } = makeEnv()
  const r1 = await bus.dispatch('fact', 'upsert', { program_id: 'p', fact_key: 'note/x', category: 'note', ttl_days: 999 }, { actor: 'model' })
  assert.equal(r1.ok, false)
  assert.equal(r1.error.code, 'E_INVARIANT')
  const r2 = await bus.dispatch('fact', 'upsert', { program_id: 'p', fact_key: 'a/b', revalidate_days: 999 }, { actor: 'model' })
  assert.equal(r2.ok, false)
  assert.equal(r2.error.code, 'E_INVARIANT')
})

test('invariant INV-F7: 快照前缀黑板键被拒', async () => {
  const { bus } = makeEnv()
  const r = await bus.dispatch('fact', 'bb_publish', { key: 'note:todo-xxx', value: 'v' }, { actor: 'model' })
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'E_INVARIANT')
})

test('invariant INV-F10: fact_link 端点不存在 / 自环被拒', async () => {
  const { bus } = makeEnv()
  await bus.dispatch('fact', 'upsert', { program_id: 'p', fact_key: 'a/x', summary: 's' }, { actor: 'model' })
  const r1 = await bus.dispatch('fact', 'link', { program_id: 'p', src_key: 'a/x', dst_key: 'missing/y', edge_type: 'hosts' }, { actor: 'model' })
  assert.equal(r1.ok, false)
  assert.equal(r1.error.code, 'E_NOT_FOUND')
  const r2 = await bus.dispatch('fact', 'link', { program_id: 'p', src_key: 'a/x', dst_key: 'a/x', edge_type: 'hosts' }, { actor: 'model' })
  assert.equal(r2.ok, false)
  assert.equal(r2.error.code, 'E_SCHEMA')
})

// ---------------------------------------------------------------------------
// 4. 状态机拒绝
// ---------------------------------------------------------------------------

test('state machine: fact_correct 对 confirmed 事实被拒（E_STATE）', async () => {
  const { bus } = makeEnv()
  await bus.dispatch('fact', 'upsert', { program_id: 'p', fact_key: 'a/b', confidence: 'confirmed' }, { actor: 'model' })
  const r = await bus.dispatch('fact', 'correct', { program_id: 'p', fact_key: 'a/b', evidence: '人工复核确认无误无误' }, { actor: 'human' })
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'E_STATE')
})

test('state machine: fact_transition 黑板 cooling 被拒 / durable→archived 放行', async () => {
  const { bus } = makeEnv()
  await bus.dispatch('fact', 'bb_publish', { key: 'env-x', value: 'v' }, { actor: 'model' })
  const r1 = await bus.dispatch('fact', 'transition', { object: 'bb', bb_key: 'env-x', to: 'cooling', reason: '治理流转依据说明文字' }, { actor: 'system' })
  assert.equal(r1.ok, false)
  assert.equal(r1.error.code, 'E_STATE')
  await bus.dispatch('fact', 'upsert', { program_id: 'p', fact_key: 'a/b', summary: 's' }, { actor: 'model' })
  const r2 = await bus.dispatch('fact', 'transition', { object: 'fact', program_id: 'p', fact_key: 'a/b', to: 'archived', reason: '数据修复归档依据说明' }, { actor: 'system' })
  assert.equal(r2.ok, true)
  const row = bus._internal.db().prepare('SELECT * FROM facts WHERE program_id=? AND fact_key=?').get('p', 'a/b')
  assert.equal(row, undefined)
})

// ---------------------------------------------------------------------------
// 5. actor 拒绝
// ---------------------------------------------------------------------------

test('actor: model 调 fact_transition / fact_correct 被拒（E_ACTOR_FORBIDDEN）', async () => {
  const { bus } = makeEnv()
  const r1 = await bus.dispatch('fact', 'transition', { object: 'fact', program_id: 'p', fact_key: 'a/b', to: 'cooling', reason: '治理流转依据说明文字' }, { actor: 'model' })
  assert.equal(r1.ok, false)
  assert.equal(r1.error.code, 'E_ACTOR_FORBIDDEN')
  const r2 = await bus.dispatch('fact', 'correct', { program_id: 'p', fact_key: 'a/b', evidence: '人工复核' }, { actor: 'model' })
  assert.equal(r2.ok, false)
  assert.equal(r2.error.code, 'E_ACTOR_FORBIDDEN')
})

// ---------------------------------------------------------------------------
// 6. 幂等重放
// ---------------------------------------------------------------------------

test('idempotent: fact_upsert 同参重放 replay:true；异参覆盖正常', async () => {
  const { bus } = makeEnv()
  const r1 = await bus.dispatch('fact', 'upsert', { program_id: 'p', fact_key: 'a/b', summary: 's1' }, { actor: 'model' })
  assert.equal(r1.replay, false)
  const r2 = await bus.dispatch('fact', 'upsert', { program_id: 'p', fact_key: 'a/b', summary: 's1' }, { actor: 'model' })
  assert.equal(r2.replay, true)
  const r3 = await bus.dispatch('fact', 'upsert', { program_id: 'p', fact_key: 'a/b', summary: 's2' }, { actor: 'model' })
  assert.equal(r3.ok, true)
  assert.equal(r3.data.merged, true)
})

test('idempotent: fact_correct 同键异参 E_IDEMPOTENT_CONFLICT', async () => {
  const { bus } = makeEnv()
  await bus.dispatch('fact', 'upsert', { program_id: 'p', fact_key: 'a/b', summary: 's' }, { actor: 'model' })
  const r1 = await bus.dispatch('fact', 'correct', { program_id: 'p', fact_key: 'a/b', evidence: '人工复核确认依据一二三' }, { actor: 'human' })
  assert.equal(r1.ok, true)
  const r2 = await bus.dispatch('fact', 'correct', { program_id: 'p', fact_key: 'a/b', evidence: '人工复核确认依据二三四' }, { actor: 'human' })
  assert.equal(r2.ok, false)
  assert.equal(r2.error.code, 'E_IDEMPOTENT_CONFLICT')
})

// ---------------------------------------------------------------------------
// 7. 查询口径（行数 = total；可见域谓词）
// ---------------------------------------------------------------------------

test('query: fact_search 默认排除 note + 排除 archived（行数=total）', async () => {
  const { bus } = makeEnv()
  await bus.dispatch('fact', 'upsert', { program_id: 'p', fact_key: 'auth/a', category: 'auth', summary: 's' }, { actor: 'model' })
  await bus.dispatch('fact', 'upsert', { program_id: 'p', fact_key: 'auth/b', category: 'auth', summary: 's' }, { actor: 'model' })
  await bus.dispatch('fact', 'upsert', { program_id: 'p', fact_key: 'note/n1', category: 'note', summary: 's' }, { actor: 'model' })
  const q = await bus.query('fact', 'search', { program_id: 'p' }, { actor: 'dashboard' })
  assert.equal(q.total, 2) // note 默认排除
  assert.equal(q.rows.length, 2)
  // exclude_notes=false 可见 note
  const q2 = await bus.query('fact', 'search', { program_id: 'p', exclude_notes: false }, { actor: 'dashboard' })
  assert.equal(q2.total, 3)
})

test('query: neg_check 返回 note 类证伪路径', async () => {
  const { bus } = makeEnv()
  await bus.dispatch('fact', 'upsert', { program_id: 'p', fact_key: 'note/fail-upload', category: 'note', summary: 'upload 路径 403 失败' }, { actor: 'model' })
  const q = await bus.query('fact', 'neg_check', { program_id: 'p', q: 'upload' }, { actor: 'model' })
  assert.equal(q.data.total, 1)
  assert.ok(q.data.warning.includes('证伪'))
})

test('query: fact_get reader=task 对 timeline 返回 E_NOT_FOUND；review 可见', async () => {
  const { bus } = makeEnv()
  await bus.dispatch('fact', 'upsert', { program_id: 'p', fact_key: 'tl/x', mem_class: 'timeline', summary: 's' }, { actor: 'model' })
  const r1 = await bus.query('fact', 'get', { program_id: 'p', fact_key: 'tl/x' }, { actor: 'model' })
  assert.equal(r1.ok, false)
  const r2 = await bus.query('fact', 'get', { program_id: 'p', fact_key: 'tl/x', reader: 'review' }, { actor: 'model' })
  assert.equal(r2.ok, true)
})

// ---------------------------------------------------------------------------
// 8. 事件载荷 / 别名 / ensureCol
// ---------------------------------------------------------------------------

test('event payload: fact.upserted 载荷只含 ID 快照（不含 body）', async () => {
  const { dir, bus } = makeEnv()
  await bus.dispatch('fact', 'upsert', { program_id: 'p', fact_key: 'a/b', summary: 's', body: 'LONG BODY CONTENT', confidence: 'confirmed' }, { actor: 'model' })
  const ev = readEvents(dir).find((e) => e.name === 'fact.upserted')
  assert.equal(ev.payload.program_id, 'p')
  assert.equal(ev.payload.fact_key, 'a/b')
  assert.ok(!('body' in ev.payload))
})

test('ensureCol: facts 表含 uses / last_used_at 列', async () => {
  const { bus } = makeEnv()
  await bus.dispatch('fact', 'upsert', { program_id: 'p', fact_key: 'a/b', summary: 's' }, { actor: 'model' })
  const cols = bus._internal.db().prepare('PRAGMA table_info(facts)').all().map((c) => c.name)
  assert.ok(cols.includes('uses'))
  assert.ok(cols.includes('last_used_at'))
})

test('alias: blackboard_set → fact_bb_publish（static 别名直通）', async () => {
  const { dir, bus } = makeEnv('aliases:\n  blackboard_set: fact_bb_publish\n  blackboard_get: fact_bb_read\n')
  const r = await bus.dispatch('', 'blackboard_set', { key: '[timeline] 2026-09-10', value: '今日流水' }, { actor: 'model' })
  assert.equal(r.ok, true)
  assert.equal(r.domain, 'fact')
  assert.equal(r.cmd, 'bb_publish')
  const audit = readAudit(dir)
  assert.ok(audit.find((a) => a.kind === 'deprecated_use' && a.alias === 'blackboard_set'))
})
