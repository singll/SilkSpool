// ==============================================================================
// @silksec/sec-domain-eval 契约测试（15-eval.md：C1 happy/schema/actor(模型拒绝)/幂等重放/
// 事件载荷 + C2/C3 actor 拒/E_CONFLICT 并发/10 分钟幂等窗口 + Q1/Q2/Q3 查询口径 +
// 订阅 vuln.signal.confirmed/rejected 回流）
// 运行：node --test test/contract-eval.test.js（插件组装目录内，type:module）
// 全部用例使用临时目录/临时库，绝不触碰 /opt/silkspool/dsh/data。
// ==============================================================================

import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createBus } from '../../sec-domain-bus/index.js'
import { buildEvalDomain, EVAL_MANIFEST } from '../index.js'
import { buildVulnDomain } from '../../sec-domain-vuln/index.js'

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'sec-domain-eval-')) }

const FP_SEED = [
  { name: 'baseline-marker', rule: '基线', expected: 'REJECT', expected_reason: 'x', scenario: '发现：反射型 XSS。\n证据：HTTP 200 + 反射' },
  { name: 'idor-three-way', rule: 'IDOR', expected: 'ACCEPT', expected_reason: 'x', scenario: '发现：三包对照 IDOR。\n证据：200/200/404' },
].map((c) => JSON.stringify(c)).join('\n') + '\n'

const CONTRACT_SEED = [
  { name: 'confirm-no-evidence', kind: 'gateway', attempt: { tool: 'vuln_confirm', args: { finding_id: 1 } }, expected_code: 'E_SCHEMA', expected_hint_contains: 'evidence' },
  { name: 'model-direct-candidate', kind: 'gateway', attempt: { tool: 'vuln_register_candidate', args: { title: 'x', severity: 'info', host: 'a.com', source: 'agent' } }, expected_code: 'E_ACTOR_FORBIDDEN', expected_hint_contains: 'actor' },
].map((c) => JSON.stringify(c)).join('\n') + '\n'

function writeSeeds(evalDir) {
  fs.mkdirSync(evalDir, { recursive: true })
  fs.writeFileSync(path.join(evalDir, 'fp-cases.jsonl'), FP_SEED)
  fs.writeFileSync(path.join(evalDir, 'contract-cases.jsonl'), CONTRACT_SEED)
}

function readLive(evalDir) {
  const f = path.join(evalDir, 'eval-live.jsonl')
  if (!fs.existsSync(f)) return []
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
}

function makeEnv(opts = {}) {
  const dir = tmpDir()
  const dataDir = path.join(dir, 'data')
  const evalDir = path.join(dataDir, 'eval')
  fs.mkdirSync(dataDir, { recursive: true })
  writeSeeds(evalDir)
  const bus = createBus({
    dataDir,
    dbFile: path.join(dir, 'asset-graph.db'),
    aliasesFile: path.join(dir, 'bus.aliases.yaml'),
    auditFile: path.join(dir, 'audit.jsonl'),
    eventsDir: path.join(dir, 'events'),
    sidecars: false,
    startDispatcherTimer: false,
  })
  const scheduled = []
  const published = []
  const executor = opts.executor || {
    runFp: async () => ({ status: 'done', report_file: 'fp-report.json' }),
    runContract: async () => ({ status: 'done', report_file: 'contract-report.json' }),
  }
  const evalDomain = buildEvalDomain({
    dataDir, evalDir,
    dispatch: (d, v, a, c) => bus.dispatch(d, v, a, c),
    query: (d, n, a, c) => bus.query(d, n, a, c),
    publish: (env) => { published.push(env) },
    executor,
    schedule: opts.schedule || ((fn) => { scheduled.push(fn) }),
  })
  const reg = bus.registry.register(evalDomain)
  assert.equal(reg.ok, true, `eval 域应注册成功：${reg.error?.message || ''}`)
  return { dir, dataDir, evalDir, bus, evalDomain, scheduled, published }
}

// ---------------------------------------------------------------------------
// C1 eval_case_append
// ---------------------------------------------------------------------------

test('eval_case_append: happy path + eval.case.appended 事件 + 落盘', async () => {
  const env = makeEnv()
  const r = await env.bus.dispatch('eval', 'case_append', {
    finding_id: 341, verdict: 'confirmed', host: 'a.com', url: 'https://a.com', title: 'SQL 注入', vuln_type: 'sqli',
  }, { actor: 'system' })
  assert.equal(r.ok, true, r.error?.message || '')
  assert.equal(r.data.finding_id, 341)
  assert.equal(r.data.verdict, 'confirmed')
  assert.equal(r.data.source, 'live')
  assert.ok(r.data.line > 0)
  assert.equal(r.event_ids.length, 1)
  const live = readLive(env.evalDir)
  assert.equal(live.length, 1)
  assert.equal(live[0].finding_id, 341)
  assert.equal(live[0].vuln_type, 'sqli')
  assert.equal(live[0].source, 'live')
})

test('eval_case_append: schema 拒绝（缺 finding_id / 非法 verdict）', async () => {
  const env = makeEnv()
  const r1 = await env.bus.dispatch('eval', 'case_append', { verdict: 'confirmed' }, { actor: 'system' })
  assert.equal(r1.ok, false)
  assert.equal(r1.error.code, 'E_SCHEMA')
  const r2 = await env.bus.dispatch('eval', 'case_append', { finding_id: 1, verdict: 'bogus' }, { actor: 'system' })
  assert.equal(r2.ok, false)
  assert.equal(r2.error.code, 'E_SCHEMA')
})

test('eval_case_append: actor 拒绝（model/dashboard 禁入）', async () => {
  const env = makeEnv()
  const r1 = await env.bus.dispatch('eval', 'case_append', { finding_id: 1, verdict: 'confirmed' }, { actor: 'model' })
  assert.equal(r1.ok, false)
  assert.equal(r1.error.code, 'E_ACTOR_FORBIDDEN')
  const r2 = await env.bus.dispatch('eval', 'case_append', { finding_id: 1, verdict: 'confirmed' }, { actor: 'dashboard' })
  assert.equal(r2.ok, false)
  assert.equal(r2.error.code, 'E_ACTOR_FORBIDDEN')
  const r3 = await env.bus.dispatch('eval', 'case_append', { finding_id: 1, verdict: 'confirmed' }, { actor: 'script' })
  assert.equal(r3.ok, true)
})

test('eval_case_append: 幂等重放（同 finding_id+verdict → replay）+ 异参冲突', async () => {
  const env = makeEnv()
  const args = { finding_id: 7, verdict: 'false_positive', host: 'a.com', vuln_type: 'xss' }
  const r1 = await env.bus.dispatch('eval', 'case_append', args, { actor: 'system' })
  const r2 = await env.bus.dispatch('eval', 'case_append', args, { actor: 'system' })
  assert.equal(r1.ok, true)
  assert.equal(r2.ok, true)
  assert.equal(r2.replay, true)
  assert.equal(r2.data.line, r1.data.line)
  assert.equal(readLive(env.evalDir).length, 1)
  const r3 = await env.bus.dispatch('eval', 'case_append', { ...args, host: 'b.com' }, { actor: 'system' })
  assert.equal(r3.ok, false)
  assert.equal(r3.error.code, 'E_IDEMPOTENT_CONFLICT')
})

// ---------------------------------------------------------------------------
// C2 eval_run_fp / C3 eval_run_contract
// ---------------------------------------------------------------------------

test('eval_run_fp: actor 拒绝（model）+ happy（异步触发，run_id=running）', async () => {
  const env = makeEnv()
  const r0 = await env.bus.dispatch('eval', 'run_fp', {}, { actor: 'model' })
  assert.equal(r0.ok, false)
  assert.equal(r0.error.code, 'E_ACTOR_FORBIDDEN')
  const r = await env.bus.dispatch('eval', 'run_fp', {}, { actor: 'dashboard' })
  assert.equal(r.ok, true, r.error?.message || '')
  assert.equal(r.data.status, 'running')
  assert.ok(r.data.run_id.startsWith('evalrun_'))
  assert.equal(r.data.cases, 2)
  assert.deepEqual(r.data.conditions, ['off', 'on'])
  const runFile = path.join(env.evalDir, 'runs', `${r.data.run_id}.json`)
  assert.ok(fs.existsSync(runFile))
  const rec = JSON.parse(fs.readFileSync(runFile, 'utf8'))
  assert.equal(rec.status, 'running')
  assert.equal(rec.kind, 'fp')
})

test('eval_run_fp: 并发互斥（running 时 → E_CONFLICT，retryable）', async () => {
  const env = makeEnv()
  const r1 = await env.bus.dispatch('eval', 'run_fp', {}, { actor: 'dashboard' })
  assert.equal(r1.ok, true)
  const r2 = await env.bus.dispatch('eval', 'run_fp', {}, { actor: 'dashboard' })
  assert.equal(r2.ok, false)
  assert.equal(r2.error.code, 'E_CONFLICT')
  assert.equal(r2.error.retryable, true)
})

test('eval_run_fp: 10 分钟幂等窗口（done 后同指纹重触发 → replay）', async () => {
  const env = makeEnv()
  const r1 = await env.bus.dispatch('eval', 'run_fp', {}, { actor: 'dashboard' })
  assert.equal(r1.ok, true)
  // 手动触发被捕获的异步执行 → 完成 run
  assert.equal(env.scheduled.length, 1)
  await env.scheduled[0]()
  const rec = JSON.parse(fs.readFileSync(path.join(env.evalDir, 'runs', `${r1.data.run_id}.json`), 'utf8'))
  assert.equal(rec.status, 'done')
  // 同指纹（默认 cases=全部 + conditions=[off,on] + model=pool-secagent）10 分钟内重触发 → replay
  const r2 = await env.bus.dispatch('eval', 'run_fp', {}, { actor: 'dashboard' })
  assert.equal(r2.ok, true)
  assert.equal(r2.data.replay, true)
  assert.equal(r2.data.run_id, r1.data.run_id)
})

test('eval_run_fp: cases 名不存在 → E_SCHEMA（invariant 列合法名）', async () => {
  const env = makeEnv()
  const r = await env.bus.dispatch('eval', 'run_fp', { cases: ['no-such-case'] }, { actor: 'dashboard' })
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'E_SCHEMA')
  assert.ok(r.error.message.includes('baseline-marker'))
})

test('eval_run_contract: actor 拒绝 + happy + 并发互斥', async () => {
  const env = makeEnv()
  const r0 = await env.bus.dispatch('eval', 'run_contract', {}, { actor: 'model' })
  assert.equal(r0.ok, false)
  assert.equal(r0.error.code, 'E_ACTOR_FORBIDDEN')
  const r1 = await env.bus.dispatch('eval', 'run_contract', {}, { actor: 'dashboard' })
  assert.equal(r1.ok, true)
  assert.equal(r1.data.status, 'running')
  assert.equal(r1.data.cases, 2)
  const r2 = await env.bus.dispatch('eval', 'run_contract', {}, { actor: 'dashboard' })
  assert.equal(r2.ok, false)
  assert.equal(r2.error.code, 'E_CONFLICT')
})

// ---------------------------------------------------------------------------
// Q1/Q2/Q3 查询
// ---------------------------------------------------------------------------

test('eval_stats: live 聚合（total/by_type/fp_rate）+ 报告摘要为空', async () => {
  const env = makeEnv()
  await env.bus.dispatch('eval', 'case_append', { finding_id: 1, verdict: 'confirmed', vuln_type: 'sqli' }, { actor: 'system' })
  await env.bus.dispatch('eval', 'case_append', { finding_id: 2, verdict: 'confirmed', vuln_type: 'sqli' }, { actor: 'system' })
  await env.bus.dispatch('eval', 'case_append', { finding_id: 3, verdict: 'false_positive', vuln_type: 'sqli' }, { actor: 'system' })
  await env.bus.dispatch('eval', 'case_append', { finding_id: 4, verdict: 'confirmed', vuln_type: 'xss' }, { actor: 'system' })
  const r = await env.bus.query('eval', 'stats', {}, { actor: 'dashboard' })
  assert.equal(r.ok, true)
  assert.equal(r.data.live.total, 4)
  assert.equal(r.data.live.by_type.sqli.confirmed, 2)
  assert.equal(r.data.live.by_type.sqli.false_positive, 1)
  assert.equal(r.data.live.by_type.sqli.fp_rate, 0.33)
  assert.equal(r.data.live.by_type.xss.confirmed, 1)
  assert.equal(r.data.last_fp, null)
  assert.equal(r.data.last_contract, null)
})

test('eval_cases: verdict 过滤 + 行数=total + 默认全量', async () => {
  const env = makeEnv()
  await env.bus.dispatch('eval', 'case_append', { finding_id: 1, verdict: 'confirmed', vuln_type: 'sqli' }, { actor: 'system' })
  await env.bus.dispatch('eval', 'case_append', { finding_id: 2, verdict: 'false_positive', vuln_type: 'xss' }, { actor: 'system' })
  const all = await env.bus.query('eval', 'cases', {}, { actor: 'dashboard' })
  assert.equal(all.total, 2)
  assert.equal(all.rows.length, 2)
  const fp = await env.bus.query('eval', 'cases', { verdict: 'false_positive' }, { actor: 'dashboard' })
  assert.equal(fp.total, 1)
  assert.equal(fp.rows[0].verdict, 'false_positive')
  const byType = await env.bus.query('eval', 'cases', { vuln_type: 'sqli' }, { actor: 'dashboard' })
  assert.equal(byType.total, 1)
})

test('eval_reports: kind 过滤 + 报告写入后可见', async () => {
  const env = makeEnv()
  // 直接经 backend 写一份 fp 报告（模拟异步执行产物）
  const repo = env.evalDomain.backend.factory()
  repo.writeReport('fp', JSON.stringify({ ts: '2026-09-11T00:00:00.000Z', eval: 'fp-ablation', scores: { off: { accuracy: 50, fp_rate: 30 }, on: { accuracy: 80, fp_rate: 10 } }, gain: { accuracy_delta: 30 } }))
  const r = await env.bus.query('eval', 'reports', { kind: 'fp' }, { actor: 'dashboard' })
  assert.equal(r.total, 1)
  assert.equal(r.rows[0].kind, 'fp')
  assert.equal(r.rows[0].file, 'fp-report.json')
  const empty = await env.bus.query('eval', 'reports', { kind: 'contract' }, { actor: 'dashboard' })
  assert.equal(empty.total, 0)
})

// ---------------------------------------------------------------------------
// 订阅：vuln.signal.confirmed / rejected → eval.case.appended（弱联动回流）
// ---------------------------------------------------------------------------

test('订阅: vuln.signal.confirmed → eval.case.append（经 vuln_get 取详情）', async () => {
  const env = makeEnv()
  let appended = null
  const domain2 = buildEvalDomain({
    dataDir: env.dataDir, evalDir: env.evalDir,
    query: async (d, n, a) => {
      if (d === 'vuln' && n === 'get') return { ok: true, data: { id: a.id, host: 'a.com', url: 'https://a.com', title: 't', vuln_type: 'sqli' } }
      return { ok: false, error: { code: 'E_BUS_DOMAIN_UNKNOWN' } }
    },
    dispatch: async (d, v, a) => { appended = { d, v, a }; return { ok: true, data: { finding_id: a.finding_id } } },
  })
  const res = await domain2.handlers.subscribers.onSignalVerdict({ name: 'vuln.signal.confirmed', payload: { finding_id: 341 } })
  assert.equal(res.ok, true)
  assert.equal(appended.v, 'case_append')
  assert.equal(appended.a.verdict, 'confirmed')
  assert.equal(appended.a.finding_id, 341)
  assert.equal(appended.a.vuln_type, 'sqli')
})

test('订阅: vuln.signal.rejected 仅 false_positive 回流（dup/ignored 跳过）', async () => {
  const env = makeEnv()
  let appended = null
  const domain2 = buildEvalDomain({
    dataDir: env.dataDir, evalDir: env.evalDir,
    query: async (d, n, a) => ({ ok: true, data: { id: a.id, host: 'a.com', vuln_type: 'sqli' } }),
    dispatch: async (d, v, a) => { appended = { d, v, a }; return { ok: true } },
  })
  const dup = await domain2.handlers.subscribers.onSignalVerdict({ name: 'vuln.signal.rejected', payload: { finding_id: 342, verdict: 'dup' } })
  assert.equal(dup.ok, true)
  assert.equal(dup.data.skipped, true)
  assert.equal(appended, null)
  const fp = await domain2.handlers.subscribers.onSignalVerdict({ name: 'vuln.signal.rejected', payload: { finding_id: 343, verdict: 'false_positive' } })
  assert.equal(fp.ok, true)
  assert.equal(appended.a.verdict, 'false_positive')
})

// ---------------------------------------------------------------------------
// 端到端：vuln_confirm → vuln.signal.confirmed → dispatcher → eval.case.append
// ---------------------------------------------------------------------------

test('端到端: vuln_confirm 事件经 dispatcher 回流成 eval-live 行', async () => {
  const env = makeEnv({ withVuln: true })
  const vuln = buildVulnDomain({ dataDir: env.dataDir, dispatch: (d, v, a, c) => env.bus.dispatch(d, v, a, c) })
  assert.equal(env.bus.registry.register(vuln).ok, true)
  // 触发 findings 表建表
  await env.bus.query('vuln', 'list', {}, { actor: 'dashboard' })
  // 证据引用目录
  fs.mkdirSync(path.join(env.dataDir, 'results', 'run_test_evt'), { recursive: true })
  fs.writeFileSync(path.join(env.dataDir, 'results', 'run_test_evt', 'meta.json'), '{}')
  // 种子 finding
  const db = env.bus._internal.db()
  const id = Number(db.prepare(`INSERT INTO findings (fingerprint, title, severity, host, url, evidence, source, status, created_at, noise, confidence)
    VALUES ('fp-evt-1', '测试候选标题足够长', 'high', 'a.com', 'https://a.com/x', '', 'agent', 'new', ?, 1, 'tentative')`).run(Date.now()).lastInsertRowid)
  const r = await env.bus.dispatch('vuln', 'confirm', { finding_id: id, evidence: 'run_test_evt' }, { actor: 'model' })
  assert.equal(r.ok, true, r.error?.message || '')
  // 处理 outbox（async 订阅）
  await env.bus._internal.dispatcherTick()
  const live = readLive(env.evalDir)
  assert.ok(live.some((l) => l.finding_id === id && l.verdict === 'confirmed'), '应回流一行 confirmed 判定')
})

test('总线集成: bus_status eval registered:true + 命令/查询计数 + 模型不可见三写动词', async () => {
  const env = makeEnv()
  const st = await env.bus.query('bus', 'status', {}, { actor: 'dashboard' })
  const ev = st.data.domains.find((d) => d.domain === 'eval')
  assert.ok(ev)
  assert.equal(ev.registered, true)
  assert.equal(ev.commands, Object.keys(EVAL_MANIFEST.commands).length)
  assert.equal(ev.queries, Object.keys(EVAL_MANIFEST.queries).length)
  // 模型不可见：三个写动词 actor 白名单不含 model
  for (const [cmd, def] of Object.entries(EVAL_MANIFEST.commands)) {
    assert.ok(!def.actor.includes('model'), `${cmd} 不应向 model 开放`)
  }
})
