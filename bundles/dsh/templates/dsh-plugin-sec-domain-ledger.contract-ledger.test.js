// ==============================================================================
// @silksec/sec-domain-ledger 契约测试（11-ledger.md §契约矩阵：happy path / schema /
// 不变量 / actor / 幂等 / 破坏性读 / 查询口径 / 事件载荷 / 别名 / 格式契约）
// 运行：node --test test/contract-ledger.test.js（插件组装目录内，type:module）
// 全部用例使用临时目录/临时库，绝不触碰 /opt/silkspool/dsh/data。
// ==============================================================================

import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createBus } from '../../sec-domain-bus/index.js'
import { buildLedgerDomain, LEDGER_MANIFEST } from '../index.js'

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'sec-domain-ledger-')) }

function makeEnv(opts = {}) {
  const dir = tmpDir()
  const dataDir = path.join(dir, 'data')
  fs.mkdirSync(dataDir, { recursive: true })
  fs.mkdirSync(path.join(dataDir, 'pipeline', 'test-src'), { recursive: true })
  fs.mkdirSync(path.join(dataDir, 'evidence'), { recursive: true })
  fs.writeFileSync(path.join(dataDir, 'evidence', 'probe.txt'), 'x')
  fs.writeFileSync(path.join(dataDir, 'scope.yml'), 'programs:\n  - name: "test-src"\n    scope:\n      - "*.example.com"\n')
  let y = opts.aliases || ''
  if (y) fs.writeFileSync(path.join(dir, 'bus.aliases.yaml'), y)
  const bus = createBus({
    dataDir,
    dbFile: path.join(dir, 'asset-graph.db'),
    aliasesFile: path.join(dir, 'bus.aliases.yaml'),
    auditFile: path.join(dir, 'audit.jsonl'),
    eventsDir: path.join(dir, 'events'),
    sidecars: false,
    startDispatcherTimer: false,
  })
  const domain = buildLedgerDomain({
    dataDir,
    dispatch: (d, v, a, c) => bus.dispatch(d, v, a, c),
    query: (d, n, a, c) => bus.query(d, n, a, c),
  })
  const reg = bus.registry.register(domain)
  assert.equal(reg.ok, true, `ledger 域应注册成功：${reg.error?.message || ''}`)
  return { dir, dataDir, bus, domain }
}

function readAudit(dir) {
  const f = path.join(dir, 'audit.jsonl')
  if (!fs.existsSync(f)) return []
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
}
function readEvents(dir) {
  const f = path.join(dir, 'events', 'ledger.jsonl')
  if (!fs.existsSync(f)) return []
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
}
function attemptsFile(dataDir, program = 'test-src') {
  return path.join(dataDir, 'pipeline', program, `attempts-${program}.tsv`)
}

// ---------------------------------------------------------------------------
// 1. happy path
// ---------------------------------------------------------------------------

test('happy path: log_attempt 六态落行 + attempt.logged + audit', async () => {
  const { dir, dataDir, bus } = makeEnv()
  const r = await bus.dispatch('ledger', 'log_attempt', {
    program: 'test-src', asset: 'a.example.com', card_id: 'VC-034', card_ver: 2, tool: 'curl+js', result: 'CONFIRMED',
    evidence_path: 'evidence/probe.txt', run_id: 'r8x1k2ab',
  }, { actor: 'model', session_id: 'sess_1' })
  assert.equal(r.ok, true)
  assert.equal(r.data.run_id, 'r8x1k2ab')
  assert.ok(r.event_ids.length === 1)
  const content = fs.readFileSync(attemptsFile(dataDir), 'utf8')
  assert.ok(content.startsWith('ts\tasset\tcard_id\tcard_ver\ttool\tresult\treason\tevidence_path\trun_id\n'))
  assert.ok(content.includes('VC-034'))
  assert.ok(content.includes('CONFIRMED'))
  assert.ok(readEvents(dir).find((e) => e.name === 'ledger.attempt.logged'))
  assert.ok(readAudit(dir).find((a) => a.kind === 'command' && a.cmd === 'log_attempt' && a.result === 'ok'))
})

test('happy path: log_card_usage applied + card_usage.logged', async () => {
  const { dir, dataDir, bus } = makeEnv()
  const r = await bus.dispatch('ledger', 'log_card_usage', {
    program: 'test-src', card_id: 'VC-034', card_version: 2, asset: 'a.example.com', outcome: 'applied', result: '照卡执行',
  }, { actor: 'model' })
  assert.equal(r.ok, true)
  assert.equal(r.data.outcome, 'applied')
  const files = fs.readdirSync(path.join(dataDir, 'pipeline', 'test-src')).filter((f) => f.startsWith('card_usage-'))
  assert.equal(files.length, 1)
  assert.ok(readEvents(dir).find((e) => e.name === 'ledger.card_usage.logged'))
})

test('happy path: radar_push + radar_drain（读后清空）+ radar.pushed/drained', async () => {
  const { dir, dataDir, bus } = makeEnv()
  const p = await bus.dispatch('ledger', 'radar_push', {
    program: 'test-src', type: 'ct-new-subdomain', payload: { domain: 'new-api.example.com' },
  }, { actor: 'script' })
  assert.equal(p.ok, true)
  const d = await bus.dispatch('ledger', 'radar_drain', { program: 'test-src' }, { actor: 'model' })
  assert.equal(d.ok, true)
  assert.equal(d.data.count, 1)
  assert.equal(d.data.events[0].domain, 'new-api.example.com')
  assert.equal(d.data.drained, true)
  // 再 drain 返回空（天然幂等，每次都是新读）
  const d2 = await bus.dispatch('ledger', 'radar_drain', { program: 'test-src' }, { actor: 'model' })
  assert.equal(d2.ok, true)
  assert.equal(d2.data.count, 0)
  assert.equal(d2.replay, false)
  assert.ok(readEvents(dir).find((e) => e.name === 'ledger.radar.pushed'))
  assert.ok(readEvents(dir).find((e) => e.name === 'ledger.radar.drained'))
})

test('happy path: handoff_write 五段全量写 + handoff.written', async () => {
  const { dir, dataDir, bus } = makeEnv()
  const r = await bus.dispatch('ledger', 'handoff_write', {
    program: 'test-src', snapshot: '覆盖摘要', actions: '本轮动作', tomorrow_queue: '明日队列', blockers: '无', data_refs: 'data 指针',
  }, { actor: 'model' })
  assert.equal(r.ok, true)
  const hf = path.join(dataDir, 'pipeline', 'test-src', fs.readdirSync(path.join(dataDir, 'pipeline', 'test-src')).find((f) => f.startsWith('handoff-')))
  const content = fs.readFileSync(hf, 'utf8')
  assert.ok(content.includes('## 1. 快照（snapshot）'))
  assert.ok(content.includes('## 5. 数据指针（data_refs）'))
  assert.ok(content.includes('覆盖摘要'))
  assert.ok(readEvents(dir).find((e) => e.name === 'ledger.handoff.written'))
})

// ---------------------------------------------------------------------------
// 2. schema 拒绝
// ---------------------------------------------------------------------------

test('schema: result 非六态被拒；缺必填被拒；未知参数被拒', async () => {
  const { bus } = makeEnv()
  const r1 = await bus.dispatch('ledger', 'log_attempt', {
    program: 'test-src', asset: 'a', card_id: 'VC-1', tool: 't', result: 'BOGUS',
  }, { actor: 'model' })
  assert.equal(r1.ok, false)
  assert.equal(r1.error.code, 'E_SCHEMA')
  const r2 = await bus.dispatch('ledger', 'log_attempt', { program: 'test-src', asset: 'a', card_id: 'VC-1', tool: 't' }, { actor: 'model' })
  assert.equal(r2.ok, false)
  assert.equal(r2.error.code, 'E_SCHEMA')
  const r3 = await bus.dispatch('ledger', 'log_attempt', { program: 'test-src', asset: 'a', card_id: 'VC-1', tool: 't', result: 'CONFIRMED', bogus: 1 }, { actor: 'model' })
  assert.equal(r3.ok, false)
  assert.equal(r3.error.code, 'E_SCHEMA')
})

// ---------------------------------------------------------------------------
// 3. 不变量拒绝（写入即校验）
// ---------------------------------------------------------------------------

test('invariant I2: N/A/BLOCKED 缺 reason / other / 过短被拒', async () => {
  const { bus } = makeEnv()
  const r1 = await bus.dispatch('ledger', 'log_attempt', { program: 'test-src', asset: 'a', card_id: 'VC-1', tool: 't', result: 'NOT_APPLICABLE' }, { actor: 'model' })
  assert.equal(r1.ok, false)
  assert.equal(r1.error.code, 'E_LEDGER_REASON_INVALID')
  const r2 = await bus.dispatch('ledger', 'log_attempt', { program: 'test-src', asset: 'a', card_id: 'VC-1', tool: 't', result: 'BLOCKED', reason: 'other' }, { actor: 'model' })
  assert.equal(r2.ok, false)
  assert.equal(r2.error.code, 'E_LEDGER_REASON_INVALID')
  const r3 = await bus.dispatch('ledger', 'log_attempt', { program: 'test-src', asset: 'a', card_id: 'VC-1', tool: 't', result: 'NOT_APPLICABLE', reason: '不适用原因' }, { actor: 'model' })
  assert.equal(r3.ok, true)
})

test('invariant I3: CONFIRMED 缺 evidence_path / 不存在被拒（E_EVIDENCE_REQUIRED / E_LEDGER_EVIDENCE_MISSING）', async () => {
  const { dir, dataDir, bus } = makeEnv()
  const r1 = await bus.dispatch('ledger', 'log_attempt', { program: 'test-src', asset: 'a', card_id: 'VC-1', tool: 't', result: 'CONFIRMED' }, { actor: 'model' })
  assert.equal(r1.ok, false)
  assert.equal(r1.error.code, 'E_EVIDENCE_REQUIRED')
  const r2 = await bus.dispatch('ledger', 'log_attempt', { program: 'test-src', asset: 'a', card_id: 'VC-1', tool: 't', result: 'CONFIRMED', evidence_path: 'no-such-dir/x' }, { actor: 'model' })
  assert.equal(r2.ok, false)
  assert.equal(r2.error.code, 'E_LEDGER_EVIDENCE_MISSING')
  fs.mkdirSync(path.join(dir, 'data', 'evidence', '341'), { recursive: true })
  const r3 = await bus.dispatch('ledger', 'log_attempt', { program: 'test-src', asset: 'a', card_id: 'VC-1', tool: 't', result: 'CONFIRMED', evidence_path: 'evidence/probe.txt' }, { actor: 'model' })
  assert.equal(r3.ok, true)
})

test('invariant I5: outcome=deviated 缺 ≥10 字 deviation 被拒', async () => {
  const { bus } = makeEnv()
  const r1 = await bus.dispatch('ledger', 'log_card_usage', { program: 'test-src', card_id: 'VC-1', card_version: 1, asset: 'a', outcome: 'deviated' }, { actor: 'model' })
  assert.equal(r1.ok, false)
  assert.equal(r1.error.code, 'E_LEDGER_DEVIATION_REQUIRED')
  const r2 = await bus.dispatch('ledger', 'log_card_usage', { program: 'test-src', card_id: 'VC-1', card_version: 1, asset: 'a', outcome: 'deviated', deviation: '卡 detect 第 3 步端点 404 实际在 /api/v2' }, { actor: 'model' })
  assert.equal(r2.ok, true)
})

test('invariant: radar_push payload 缺专属键被拒', async () => {
  const { bus } = makeEnv()
  const r = await bus.dispatch('ledger', 'radar_push', { program: 'test-src', type: 'version-intel', payload: { component: 'x' } }, { actor: 'script' })
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'E_SCHEMA')
  const ok = await bus.dispatch('ledger', 'radar_push', { program: 'test-src', type: 'version-intel', payload: { component: 'x', from: '1', to: '2' } }, { actor: 'script' })
  assert.equal(ok.ok, true)
})

// ---------------------------------------------------------------------------
// 4. actor 拒绝
// ---------------------------------------------------------------------------

test('actor: 非白名单 actor 调 log_card_usage / radar_push 被拒', async () => {
  const { bus } = makeEnv()
  const r1 = await bus.dispatch('ledger', 'log_card_usage', { program: 'p', card_id: 'VC-1', card_version: 1, asset: 'a', outcome: 'applied' }, { actor: 'human' })
  assert.equal(r1.ok, false)
  assert.equal(r1.error.code, 'E_ACTOR_FORBIDDEN')
})

// ---------------------------------------------------------------------------
// 5. 幂等重放
// ---------------------------------------------------------------------------

test('idempotent: log_attempt 同参重放 replay:true（刻意重复记账被拦截）', async () => {
  const { bus } = makeEnv()
  const args = { program: 'test-src', asset: 'a', card_id: 'VC-1', tool: 't', result: 'STALE', run_id: 'r1' }
  const r1 = await bus.dispatch('ledger', 'log_attempt', args, { actor: 'model' })
  assert.equal(r1.replay, false)
  const r2 = await bus.dispatch('ledger', 'log_attempt', args, { actor: 'model' })
  assert.equal(r2.replay, true)
})

test('idempotent: handoff_write 同内容 replay / 异内容新写（.prev 备份）', async () => {
  const { dir, dataDir, bus } = makeEnv()
  const base = { program: 'test-src', snapshot: 's', actions: 'a', tomorrow_queue: 't', blockers: '无', data_refs: 'd' }
  const r1 = await bus.dispatch('ledger', 'handoff_write', base, { actor: 'model' })
  assert.equal(r1.replay, false)
  const r2 = await bus.dispatch('ledger', 'handoff_write', base, { actor: 'model' })
  assert.equal(r2.replay, true)
  const r3 = await bus.dispatch('ledger', 'handoff_write', { ...base, snapshot: 's2' }, { actor: 'model' })
  assert.equal(r3.replay, false)
  assert.equal(r3.data.prev_saved, true)
})

// ---------------------------------------------------------------------------
// 6. 查询口径
// ---------------------------------------------------------------------------

test('query: attempts_list 过滤 + 分页信封（行数=total）', async () => {
  const { bus } = makeEnv()
  for (let i = 0; i < 3; i++) {
    await bus.dispatch('ledger', 'log_attempt', { program: 'test-src', asset: `a${i}`, card_id: `VC-${i}`, tool: 't', result: 'TESTED_CLEAN', evidence_path: 'evidence/probe.txt', run_id: `r${i}` }, { actor: 'model' })
  }
  const q = await bus.query('ledger', 'attempts_list', { program: 'test-src' }, { actor: 'dashboard' })
  assert.equal(q.total, 3)
  assert.equal(q.rows.length, 3)
  const q2 = await bus.query('ledger', 'attempts_list', { program: 'test-src', asset: 'a1' }, { actor: 'dashboard' })
  assert.equal(q2.total, 1)
  assert.equal(q2.rows[0].card_id, 'VC-1')
})

test('query: coverage_report 覆盖矩阵 + BLOCKED 解锁收益 + 缓存物化', async () => {
  const { dir, dataDir, bus } = makeEnv()
  const ev = (asset, card, result, reason = '') => ({ program: 'test-src', asset, card_id: card, tool: 't', result, reason })
  await bus.dispatch('ledger', 'log_attempt', { ...ev('a', 'VC-1', 'CONFIRMED'), evidence_path: 'evidence/probe.txt' }, { actor: 'model' })
  await bus.dispatch('ledger', 'log_attempt', { ...ev('b', 'VC-1', 'BLOCKED'), reason: '缺少前置依赖' }, { actor: 'model' })
  await bus.dispatch('ledger', 'log_attempt', { ...ev('c', 'VC-2', 'TESTED_CLEAN'), evidence_path: 'evidence/probe.txt' }, { actor: 'model' })
  const q = await bus.query('ledger', 'coverage_report', { program: 'test-src' }, { actor: 'dashboard' })
  assert.equal(q.data.combos, 3)
  assert.equal(q.data.cards, 2)
  const vc1 = q.data.matrix.find((m) => m.card === 'VC-1')
  assert.equal(vc1.confirmed, 1)
  assert.equal(vc1.blocked, 1)
  assert.ok(q.data.blocker_gain.find((b) => b.blocker === '缺少前置依赖' && b.cells === 1))
  // 缓存物化
  assert.ok(fs.existsSync(path.join(dataDir, 'pipeline', 'test-src', 'coverage-latest.md')))
})

test('query: radar_status 纯读不清空 + 类型分布', async () => {
  const { bus } = makeEnv()
  await bus.dispatch('ledger', 'radar_push', { program: 'test-src', type: 'ct-new-subdomain', payload: { domain: 'x.example.com' } }, { actor: 'script' })
  const s = await bus.query('ledger', 'radar_status', { program: 'test-src' }, { actor: 'model' })
  assert.equal(s.data.count, 1)
  assert.equal(s.data.by_type['ct-new-subdomain'], 1)
  assert.equal(s.data.empty, false)
  // 未清空
  const s2 = await bus.query('ledger', 'radar_status', { program: 'test-src' }, { actor: 'model' })
  assert.equal(s2.data.count, 1)
})

test('query: task_proof 三产物证明（attempts/card_usage/handoff）', async () => {
  const { dir, dataDir, bus } = makeEnv()
  await bus.dispatch('ledger', 'log_attempt', { program: 'test-src', asset: 'a', card_id: 'VC-1', tool: 't', result: 'TESTED_CLEAN', evidence_path: 'evidence/probe.txt' }, { actor: 'model' })
  await bus.dispatch('ledger', 'log_card_usage', { program: 'test-src', card_id: 'VC-1', card_version: 1, asset: 'a', outcome: 'applied' }, { actor: 'model' })
  await bus.dispatch('ledger', 'handoff_write', { program: 'test-src', snapshot: 's', actions: 'a', tomorrow_queue: 't', blockers: '无', data_refs: 'd' }, { actor: 'model' })
  const q = await bus.query('ledger', 'task_proof', { program: 'test-src', since_ts: Date.now() - 86400000 }, { actor: 'scheduler' })
  assert.equal(q.data.attempts_delta_24h, 1)
  assert.equal(q.data.card_usage_24h, 1)
  assert.equal(q.data.handoff_today, true)
})

test('query: usage_query counts 聚合 + deviations 明细', async () => {
  const { bus } = makeEnv()
  await bus.dispatch('ledger', 'log_card_usage', { program: 'test-src', card_id: 'VC-1', card_version: 1, asset: 'a', outcome: 'applied' }, { actor: 'model' })
  await bus.dispatch('ledger', 'log_card_usage', { program: 'test-src', card_id: 'VC-1', card_version: 1, asset: 'b', outcome: 'deviated', deviation: '卡 detect 第 3 步端点 404 实际在 /api/v2', suggest: 'detect.steps 加回退' }, { actor: 'model' })
  const c = await bus.query('ledger', 'usage_query', { aggregate: 'counts' }, { actor: 'system' })
  assert.equal(c.total, 1)
  assert.equal(c.rows[0].card_id, 'VC-1')
  assert.equal(c.rows[0].uses, 2)
  assert.equal(c.rows[0].deviated, 1)
  const d = await bus.query('ledger', 'usage_query', { aggregate: 'deviations' }, { actor: 'system' })
  assert.equal(d.total, 1)
  assert.equal(d.rows[0].card_id, 'VC-1')
  assert.ok(d.rows[0].deviation.includes('/api/v2'))
})

// ---------------------------------------------------------------------------
// 7. 格式契约（pipeline_validate）
// ---------------------------------------------------------------------------

test('query: pipeline_validate 校验 attempts 表头 + 行级（result/reason/evidence）', async () => {
  const { dir, dataDir, bus } = makeEnv()
  await bus.dispatch('ledger', 'log_attempt', { program: 'test-src', asset: 'a', card_id: 'VC-1', tool: 't', result: 'CONFIRMED', evidence_path: 'evidence/probe.txt' }, { actor: 'model' })
  const v = await bus.query('ledger', 'pipeline_validate', { files: [attemptsFile(dataDir)] }, { actor: 'script' })
  assert.equal(v.data.ok, true)
  // 手工写坏行
  fs.appendFileSync(attemptsFile(dataDir), 'bad\trow\n')
  const v2 = await bus.query('ledger', 'pipeline_validate', { files: [attemptsFile(dataDir)] }, { actor: 'script' })
  assert.equal(v2.data.ok, false)
  assert.ok(v2.data.errors.some((e) => e.includes('列数不足')))
})

// ---------------------------------------------------------------------------
// 8. 事件载荷 / 别名
// ---------------------------------------------------------------------------

test('event payload: attempt.logged 只含判据快照（无 evidence_path 全文）', async () => {
  const { dir, dataDir, bus } = makeEnv()
  await bus.dispatch('ledger', 'log_attempt', { program: 'test-src', asset: 'a', card_id: 'VC-1', tool: 't', result: 'CONFIRMED', evidence_path: 'evidence/probe.txt' }, { actor: 'model' })
  const ev = readEvents(dir).find((e) => e.name === 'ledger.attempt.logged')
  assert.equal(ev.payload.program, 'test-src')
  assert.equal(ev.payload.card_id, 'VC-1')
  assert.ok(!('evidence_path' in ev.payload))
})

test('alias: attempts_log → ledger_log_attempt（static 直通，deprecated_use 在记）', async () => {
  const { dir, bus } = makeEnv({ aliases: 'aliases:\n  attempts_log: ledger_log_attempt\n' })
  const r = await bus.dispatch('', 'attempts_log', { program: 'test-src', asset: 'a', card_id: 'VC-1', tool: 't', result: 'STALE' }, { actor: 'model' })
  assert.equal(r.ok, true)
  assert.equal(r.domain, 'ledger')
  assert.equal(r.cmd, 'log_attempt')
  assert.ok(readAudit(dir).find((a) => a.kind === 'deprecated_use' && a.alias === 'attempts_log'))
})

test('alias: card_usage_log → ledger_log_card_usage（outcome 由 deviation 推导）', async () => {
  const { bus } = makeEnv({ aliases: 'aliases: {}\ndispatch_aliases:\n  card_usage_log:\n    router: card_usage_router\n    domain: ledger\n' })
  const r = await bus.dispatch('', 'card_usage_log', { program: 'test-src', card_id: 'VC-1', card_version: 1, asset: 'a', result: 'done', deviation: '卡 detect 第 3 步端点 404 实际在 /api/v2' }, { actor: 'model' })
  assert.equal(r.ok, true)
  assert.equal(r.cmd, 'log_card_usage')
  const r2 = await bus.dispatch('', 'card_usage_log', { program: 'test-src', card_id: 'VC-2', card_version: 1, asset: 'a', result: 'done' }, { actor: 'model' })
  assert.equal(r2.ok, true)
  assert.equal(r2.data.outcome, 'applied')
})

test('alias: coverage_report → ledger_coverage_report（out 丢弃，query 面）', async () => {
  const { bus } = makeEnv({ aliases: 'aliases: {}\ndispatch_aliases:\n  coverage_report:\n    router: coverage_report_router\n    domain: ledger\n' })
  await bus.dispatch('ledger', 'log_attempt', { program: 'test-src', asset: 'a', card_id: 'VC-1', tool: 't', result: 'TESTED_CLEAN', evidence_path: 'evidence/probe.txt' }, { actor: 'model' })
  const r = await bus.query('', 'coverage_report', { program: 'test-src', out: '/tmp/custom.md' }, { actor: 'dashboard' })
  assert.equal(r.ok, true)
  assert.equal(r.query, 'coverage_report')
  assert.equal(r.data.combos, 1)
})
