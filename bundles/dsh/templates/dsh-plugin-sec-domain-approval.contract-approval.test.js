// ==============================================================================
// @silksec/sec-domain-approval 契约测试（09-approval.md：kind 注册表 / pending 去重 /
// decide effect outbox / 状态机 / actor / 幂等 / 事件载荷 / task-complete 端到端）
// 运行：node --test test/contract-approval.test.js（插件组装目录内，type:module）
// 全部用例使用临时目录/临时库，绝不触碰 /opt/silkspool/dsh/data。
// ==============================================================================

import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createBus } from '../../sec-domain-bus/index.js'
import { buildApprovalDomain, APPROVAL_MANIFEST } from '../index.js'
import { buildScopeDomain } from '../../sec-domain-scope/index.js'
import { buildTaskDomain } from '../../sec-domain-task/index.js'

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'sec-domain-approval-')) }

function baseBus(dir, dataDir) {
  fs.mkdirSync(dataDir, { recursive: true })
  return createBus({
    dataDir,
    dbFile: path.join(dir, 'asset-graph.db'),
    aliasesFile: path.join(dir, 'bus.aliases.yaml'),
    auditFile: path.join(dir, 'audit.jsonl'),
    eventsDir: path.join(dir, 'events'),
    sidecars: false,
    startDispatcherTimer: false,
  })
}

const SEED = `version: 1
defaults:
  rate_limit_qps: 50
  allow_risk: [passive, active]
programs:
  - name: example-src
    scope:
      - "*.example.com"
      - "example.com"
    exclude:
      - "pay.example.com"
`

function makeEnv() {
  const dir = tmpDir()
  const dataDir = path.join(dir, 'data')
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(path.join(dataDir, 'scope.yml'), SEED)
  const bus = baseBus(dir, dataDir)
  const scope = buildScopeDomain({ dataDir, dispatch: (d, v, a, c) => bus.dispatch(d, v, a, c), query: (d, n, a, c) => bus.query(d, n, a, c) })
  const approval = buildApprovalDomain({ dataDir, dispatch: (d, v, a, c) => bus.dispatch(d, v, a, c), query: (d, n, a, c) => bus.query(d, n, a, c) })
  assert.equal(bus.registry.register(scope).ok, true, 'scope 域应注册成功')
  assert.equal(bus.registry.register(approval).ok, true, 'approval 域应注册成功')
  return { dir, dataDir, bus }
}

function makeEnvWithTask() {
  const env = makeEnv()
  const task = buildTaskDomain({ dataDir: env.dataDir, dispatch: (d, v, a, c) => env.bus.dispatch(d, v, a, c), query: (d, n, a, c) => env.bus.query(d, n, a, c) })
  assert.equal(env.bus.registry.register(task).ok, true, 'task 域应注册成功')
  return env
}

function readEvents(dir) {
  const f = path.join(dir, 'events', 'approval.jsonl')
  if (!fs.existsSync(f)) return []
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
}
function readScope(dir) { return fs.readFileSync(path.join(dir, 'data', 'scope.yml'), 'utf8') }

const WILDCARD_ARGS = {
  kind: 'scope-wildcard', subject: 'newcorp.com', program_name: 'example-src',
  equity_basis: '控股/全资', independent_src: '无',
  evidence: 'ICP 备案主体为 XX 科技有限公司，与 SRC 规则页主体一致，收购公告已公示。',
}

// ---------------------------------------------------------------------------
// 1. request happy path + pending 去重
// ---------------------------------------------------------------------------

test('request: scope-wildcard 落 pending + approval.requested + payload 组装', async () => {
  const { dir, bus } = makeEnv()
  const r = await bus.dispatch('approval', 'request', WILDCARD_ARGS, { actor: 'model', session_id: 'sess_1' })
  assert.equal(r.ok, true)
  assert.equal(r.data.status, 'pending')
  assert.ok(r.data.request_id)
  assert.equal(r.data.payload.domain_level, 'apex')
  assert.equal(r.data.payload.equity_basis, '控股/全资')
  const ev = readEvents(dir).find((e) => e.name === 'approval.requested')
  assert.ok(ev)
  assert.equal(ev.payload.requested_by, 'sess_1')
  // pending 去重（同 kind+subject 不同证据 → 幂等键不同 → 命中 I2）
  const dup = await bus.dispatch('approval', 'request', { ...WILDCARD_ARGS, evidence: WILDCARD_ARGS.evidence + '（补充证据）' }, { actor: 'model', session_id: 'sess_2' })
  assert.equal(dup.ok, false)
  assert.equal(dup.error.code, 'E_APPROVAL_PENDING_EXISTS')
})

test('request 幂等重放 → replay:true', async () => {
  const { bus } = makeEnv()
  const r1 = await bus.dispatch('approval', 'request', WILDCARD_ARGS, { actor: 'model', session_id: 'sess_1' })
  const r2 = await bus.dispatch('approval', 'request', WILDCARD_ARGS, { actor: 'model', session_id: 'sess_1' })
  assert.equal(r1.ok, true)
  assert.equal(r2.ok, true)
  assert.equal(r2.replay, true)
})

// ---------------------------------------------------------------------------
// 2. kind validate
// ---------------------------------------------------------------------------

test('validate: 裸 apex 走 scope-domain → E_INVARIANT（引导改提 wildcard）', async () => {
  const { bus } = makeEnv()
  const r = await bus.dispatch('approval', 'request', {
    kind: 'scope-domain', subject: 'example.com', program_name: 'example-src',
    equity_basis: '技术印证', independent_src: '无',
    evidence: 'CNAME 指向已授权资产，页面 footer 主体一致，核证于 2026-09-06。',
  }, { actor: 'model', session_id: 'sess_1' })
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'E_INVARIANT')
})

test('validate: scope-domain 已在授权范围 → E_INVARIANT（无须审批）', async () => {
  const { bus } = makeEnv()
  const r = await bus.dispatch('approval', 'request', {
    kind: 'scope-domain', subject: 'api.example.com', program_name: 'example-src',
    equity_basis: '技术印证', independent_src: '无',
    evidence: 'CNAME 指向已授权资产 lb.example.com，页面主体一致，核证于 2026-09-06。',
  }, { actor: 'model', session_id: 'sess_1' })
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'E_INVARIANT')
})

test('validate: scope-wildcard equity 不足 → E_INVARIANT', async () => {
  const { bus } = makeEnv()
  const r = await bus.dispatch('approval', 'request', {
    ...WILDCARD_ARGS, equity_basis: '技术印证',
  }, { actor: 'model', session_id: 'sess_1' })
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'E_INVARIANT')
})

test('validate: exclude-exception subject 不在排除清单 → E_INVARIANT', async () => {
  const { bus } = makeEnv()
  const r = await bus.dispatch('approval', 'request', {
    kind: 'exclude-exception', subject: 'notexcluded.example.com', program_name: 'example-src',
    equity_basis: '控股/全资', evidence: '主体核证一致，历史归属证据充分。',
  }, { actor: 'model', session_id: 'sess_1' })
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'E_INVARIANT')
})

test('validate: task-budget-extend 由 model 直提 → E_APPROVAL_KIND_ACTOR', async () => {
  const { bus } = makeEnvWithTask()
  const r = await bus.dispatch('approval', 'request', {
    kind: 'task-budget-extend', subject: 'task:1', evidence: 'worker 跑满 3600s 被杀且有产出迹象',
    payload: { task_id: 1, budget_timeout_sec: 7200 },
  }, { actor: 'model', session_id: 'sess_1' })
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'E_APPROVAL_KIND_ACTOR')
})

test('validate: knowledge-adopt draft 不足 50 字 → E_INVARIANT', async () => {
  const { bus } = makeEnv()
  const r = await bus.dispatch('approval', 'request', {
    kind: 'knowledge-adopt', subject: '某个经验模式', source_url: 'https://example.com/writeup',
    draft: '太短', evidence: '覆盖了一个知识缺口，有案例支撑，与现有卡存在差异。',
  }, { actor: 'model', session_id: 'sess_1' })
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'E_INVARIANT')
})

// ---------------------------------------------------------------------------
// 3. decide approve → scope_grant effect
// ---------------------------------------------------------------------------

test('decide approve scope-wildcard → scope_grant 双条目 effect + approval.approved', async () => {
  const { dir, bus } = makeEnv()
  const req = await bus.dispatch('approval', 'request', WILDCARD_ARGS, { actor: 'model', session_id: 'sess_1' })
  const r = await bus.dispatch('approval', 'decide', { id: req.data.request_id, decision: 'approve' }, { actor: 'dashboard', operator: 'singll' })
  assert.equal(r.ok, true)
  assert.equal(r.data.status, 'approved')
  assert.equal(r.data.effects.length, 1)
  assert.equal(r.data.effects[0].status, 'applied')
  const txt = readScope(dir)
  assert.ok(txt.includes('*.newcorp.com'))
  assert.ok(txt.includes('newcorp.com'))
  const ev = readEvents(dir).find((e) => e.name === 'approval.approved')
  assert.ok(ev)
  assert.equal(ev.payload.kind, 'scope-wildcard')
  assert.equal(ev.payload.subject, 'newcorp.com')
  // 决策后同请求再 decide（不同 decision → 幂等键不同 → E_STATE）
  const again = await bus.dispatch('approval', 'decide', { id: req.data.request_id, decision: 'reject' }, { actor: 'dashboard' })
  assert.equal(again.ok, false)
  assert.equal(again.error.code, 'E_STATE')
})

test('decide approve scope-domain → scope_grant 单条目', async () => {
  const { dir, bus } = makeEnv()
  const req = await bus.dispatch('approval', 'request', {
    kind: 'scope-domain', subject: 'sub.newcorp.com', program_name: 'example-src',
    equity_basis: '技术印证', independent_src: '无', corroboration: 'CNAME 指向已授权资产',
    evidence: 'sub.newcorp.com CNAME 解析到本项目已授权资产，页面 footer 主体一致（核证于 2026-09-06）。',
  }, { actor: 'model', session_id: 'sess_1' })
  const r = await bus.dispatch('approval', 'decide', { id: req.data.request_id, decision: 'approve' }, { actor: 'dashboard', operator: 'singll' })
  assert.equal(r.ok, true)
  assert.equal(r.data.status, 'approved')
  const txt = readScope(dir)
  assert.ok(txt.includes('sub.newcorp.com'))
})

test('decide reject → approval.rejected', async () => {
  const { dir, bus } = makeEnv()
  const req = await bus.dispatch('approval', 'request', WILDCARD_ARGS, { actor: 'model', session_id: 'sess_1' })
  const r = await bus.dispatch('approval', 'decide', { id: req.data.request_id, decision: 'reject', note: '判据不足' }, { actor: 'dashboard', operator: 'singll' })
  assert.equal(r.ok, true)
  assert.equal(r.data.status, 'rejected')
  const ev = readEvents(dir).find((e) => e.name === 'approval.rejected')
  assert.ok(ev)
  assert.equal(ev.payload.note, '判据不足')
})

// ---------------------------------------------------------------------------
// 4. withdraw
// ---------------------------------------------------------------------------

test('withdraw 自己提请的 pending → rejected + withdrawn:true；他人不可撤回', async () => {
  const { bus } = makeEnv()
  const req = await bus.dispatch('approval', 'request', WILDCARD_ARGS, { actor: 'model', session_id: 'sess_me' })
  const forbid = await bus.dispatch('approval', 'withdraw', { id: req.data.request_id }, { actor: 'model', session_id: 'sess_other' })
  assert.equal(forbid.ok, false)
  assert.equal(forbid.error.code, 'E_APPROVAL_WITHDRAW_FORBIDDEN')
  const ok = await bus.dispatch('approval', 'withdraw', { id: req.data.request_id, reason: '提错对象' }, { actor: 'model', session_id: 'sess_me' })
  assert.equal(ok.ok, true)
  assert.equal(ok.data.withdrawn, true)
})

// ---------------------------------------------------------------------------
// 5. task-complete 端到端（task_submit_complete → approval_request → decide → task_complete）
// ---------------------------------------------------------------------------

test('task-complete 端到端: task_submit_complete 提请 → decide approve → task done', async () => {
  const { dir, bus } = makeEnvWithTask()
  const cr = await bus.dispatch('task', 'create', { program_id: 'example-src', phase: 'vuln', objective: '自执行任务', assignee: 'model', schedule: { kind: 'once', at: Date.now() + 3600000 } }, { actor: 'model', session_id: 'sess_1' })
  const taskId = cr.data.task_id
  const sub = await bus.dispatch('task', 'submit_complete', {
    task_id: taskId, summary: '完成了对 api.example.com 的漏洞探测并提交了三条发现，结论已归档。',
    evidence: ['results/run_x/stdout.log'], follow_up: '建议人工复核高危项',
  }, { actor: 'model', session_id: 'sess_1' })
  assert.equal(sub.ok, true)
  assert.ok(sub.data.request_id, 'task_submit_complete 应拿到 approval request_id')
  const req = sub.data.request_id
  const decide = await bus.dispatch('approval', 'decide', { id: req, decision: 'approve' }, { actor: 'dashboard', operator: 'singll' })
  assert.equal(decide.ok, true)
  assert.equal(decide.data.status, 'approved')
  const row = bus._internal.db().prepare('SELECT status FROM tasks WHERE id=?').get(taskId)
  assert.equal(row.status, 'done', 'task_complete 应把任务收尾为 done')
})

// ---------------------------------------------------------------------------
// 6. 查询 + 总线集成
// ---------------------------------------------------------------------------

test('approval_list: pending 恒在最前', async () => {
  const { bus } = makeEnv()
  await bus.dispatch('approval', 'request', WILDCARD_ARGS, { actor: 'model', session_id: 's1' })
  const req2 = await bus.dispatch('approval', 'request', {
    kind: 'exclude-exception', subject: 'pay.example.com', program_name: 'example-src',
    equity_basis: '控股/全资', evidence: '主体核证一致，历史归属证据充分，重新评估后应解除排除。',
  }, { actor: 'model', session_id: 's1' })
  await bus.dispatch('approval', 'decide', { id: req2.data.request_id, decision: 'reject' }, { actor: 'dashboard' })
  const list = await bus.query('approval', 'list', {}, { actor: 'dashboard' })
  assert.equal(list.ok, true)
  assert.equal(list.total, 2)
  assert.equal(list.rows[0].status, 'pending', 'pending 恒在最前')
})

test('总线集成: bus_status approval registered:true', async () => {
  const { bus } = makeEnv()
  const st = await bus.query('bus', 'status', {}, { actor: 'dashboard' })
  const ap = st.data.domains.find((d) => d.domain === 'approval')
  assert.ok(ap)
  assert.equal(ap.registered, true)
  assert.equal(ap.commands, Object.keys(APPROVAL_MANIFEST.commands).length)
  assert.equal(ap.queries, Object.keys(APPROVAL_MANIFEST.queries).length)
})

test('approval_reconcile: 列出 effects 与 drift', async () => {
  const { bus } = makeEnv()
  const req = await bus.dispatch('approval', 'request', WILDCARD_ARGS, { actor: 'model', session_id: 's1' })
  await bus.dispatch('approval', 'decide', { id: req.data.request_id, decision: 'approve' }, { actor: 'dashboard' })
  const rec = await bus.query('approval', 'reconcile', { request_id: req.data.request_id }, { actor: 'dashboard' })
  assert.equal(rec.ok, true)
  assert.equal(rec.data.decision_status, 'approved')
  assert.equal(rec.data.effects.length, 1)
  assert.equal(rec.data.effects[0].status, 'applied')
})
