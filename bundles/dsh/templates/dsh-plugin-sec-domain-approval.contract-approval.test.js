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
import { buildKnowDomain } from '../../sec-domain-know/index.js'

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

// ---------------------------------------------------------------------------
// 7. L4（自学习专项 §6.2/§6.3，2026-09-17）：knowledge-publish 端到端 + effect 重试
// ---------------------------------------------------------------------------

function makeEnvWithKnow() {
  const env = makeEnv()
  const know = buildKnowDomain({ dataDir: env.dataDir, dispatch: (d, v, a, c) => env.bus.dispatch(d, v, a, c), query: (d, n, a, c) => env.bus.query(d, n, a, c) })
  assert.equal(env.bus.registry.register(know).ok, true, 'know 域应注册成功')
  return env
}

const L4_VC_CONTENT = {
  id: 'VC-AUTHZ-APR', version: 1, parentVersion: null,
  title: 'API 对象授权约束检查（L4 端到端）', extends: 'vuln_authz_diff',
  appliesTo: { surface: 'api', prerequisites: ['owned_test_accounts'], invalidatedBy: ['role_change'] },
  hypothesis: '身份与对象归属之间应满足访问约束：低权身份对他人对象应被拒',
  minimalProbe: '经 vuln_authz_diff 双权凭证重放同一接口比对',
  positiveControl: '对象拥有者可执行预期操作并收到 200',
  negativeControl: '无权限测试身份对他人对象应被拒 401/403/404',
  evidenceRequired: ['request_context', 'identity_ref'],
  stopConditions: ['scope_changed', 'rate_limit'],
  fixtures: { vulnerable: 'fx-a', patched: 'fx-b', invalid_env: 'fx-c' },
  budget: { maxRequests: 6, maxSeconds: 120 },
  failureNotes: '正对照失败记 infra_error；凭证缺失记 blocked_auth',
  changeNote: 'L4 端到端首版候选说明',
}

// 经 know 域造一条 eligible revision（propose→assess begin/finish，digest 由响应返回）
async function eligibleRevision(env, evalRun) {
  const p = await env.bus.dispatch('know', 'revision_propose', {
    artifact_kind: 'vulncard', artifact_id: 'VC-AUTHZ-APR', content: L4_VC_CONTENT,
    source_kind: 'seed', source_ref: 'data-seed/know-revisions/vc-authz-apr.json', change_note: 'L4 端到端候选说明超过十字',
  }, { actor: 'script' })
  assert.equal(p.ok, true, p.error?.message)
  const { revision_id, content_digest } = p.data
  const b = await env.bus.dispatch('know', 'revision_assess', { revision_id, phase: 'begin', eval_run_id: evalRun, candidate_digest: content_digest }, { actor: 'reactor' })
  assert.equal(b.ok, true, b.error?.message)
  const f = await env.bus.dispatch('know', 'revision_assess', { revision_id, phase: 'finish', eval_run_id: evalRun, candidate_digest: content_digest, verdict: 'eligible', report_ref: 'eval-candidate-report.json' }, { actor: 'reactor' })
  assert.equal(f.ok, true, f.error?.message)
  return { revision_id, content_digest }
}

test('L4: knowledge-publish 端到端——提请 → decide approve → know_revision_publish 灰度发布 + 批准绑定哈希', async () => {
  const env = makeEnvWithKnow()
  const { bus } = env
  const { revision_id, content_digest } = await eligibleRevision(env, 'evalrun_apr_ok0001')
  const req = await bus.dispatch('approval', 'request', {
    kind: 'knowledge-publish', subject: `VC-AUTHZ-APR ${revision_id} 灰度发布（example-src）`,
    evidence: '独立评测报告 eval-candidate-report.json 判定 eligible，配对三类 fixture 全过，符合灰度放行门槛。',
    payload: { revision_id, content_digest, scope_type: 'program', scope_id: 'example-src', eval_report_ref: 'eval-candidate-report.json' },
  }, { actor: 'model', session_id: 'sess_pub1' })
  assert.equal(req.ok, true, req.error?.message)
  const decide = await bus.dispatch('approval', 'decide', { id: req.data.request_id, decision: 'approve' }, { actor: 'dashboard', operator: 'singll' })
  assert.equal(decide.ok, true)
  assert.equal(decide.data.status, 'approved')
  assert.equal(decide.data.effects.length, 1)
  assert.equal(decide.data.effects[0].status, 'applied')
  const db = bus._internal.db()
  const rel = db.prepare('SELECT * FROM know_releases WHERE revision_id=?').get(revision_id)
  assert.ok(rel, '发布账本落行')
  assert.equal(rel.status, 'active')
  assert.equal(rel.scope_type, 'program')
  assert.equal(rel.scope_id, 'example-src')
  assert.equal(rel.auth_ref, `approval:${req.data.request_id}`, '批准引用=请求 id')
  assert.equal(rel.content_digest, content_digest, '发布绑定内容哈希')
  const rg2 = await bus.query('know', 'revision_get', { revision_id }, { actor: 'dashboard' })
  assert.equal(rg2.data.status, 'published')
})

test('L4: 批准绑定哈希失效——批准后 digest 不符 → effect 失败（effect_state=failed）+ reconcile 可见', async () => {
  const env = makeEnvWithKnow()
  const { bus } = env
  const { revision_id, content_digest } = await eligibleRevision(env, 'evalrun_apr_stale1')
  const req = await bus.dispatch('approval', 'request', {
    kind: 'knowledge-publish', subject: `VC-AUTHZ-APR ${revision_id} 灰度发布（错哈希）`,
    evidence: '独立评测报告 eval-candidate-report.json 判定 eligible，本用例故意携带错误 digest 验证批准失效。',
    payload: { revision_id, content_digest: `sha256:${'0'.repeat(64)}`, scope_type: 'program', scope_id: 'example-src' },
  }, { actor: 'model', session_id: 'sess_pub2' })
  assert.equal(req.ok, true)
  const decide = await bus.dispatch('approval', 'decide', { id: req.data.request_id, decision: 'approve' }, { actor: 'dashboard' })
  assert.equal(decide.ok, true)
  assert.equal(decide.data.effect_state, 'failed', '批准对象=哈希——digest 不符即拒发布')
  assert.equal(decide.data.effects[0].status, 'failed')
  const rec = await bus.query('approval', 'reconcile', { request_id: req.data.request_id }, { actor: 'dashboard' })
  assert.equal(rec.ok, true)
  assert.equal(rec.data.drift.length, 1)
  const rels0 = await bus.query('know', 'release_list', {}, { actor: 'dashboard' })
  assert.equal(rels0.total, 0, '零发布')
  const rg = await bus.query('know', 'revision_get', { revision_id }, { actor: 'dashboard' })
  assert.equal(rg.data.status, 'eligible', 'revision 不被失败发布流转')
  void content_digest
})

test('L4: effect 重试不重复发布——首次 effect 失败（未评测）→ 评测 eligible 后 approval_effects_retry 补跑，重复重试零重复', async () => {
  const env = makeEnvWithKnow()
  const { bus } = env
  const db = bus._internal.db()
  // 先提案（candidate），再提请发布——decide 时 revision 未 eligible → effect 失败
  const p = await bus.dispatch('know', 'revision_propose', {
    artifact_kind: 'vulncard', artifact_id: 'VC-AUTHZ-APR', content: L4_VC_CONTENT,
    source_kind: 'seed', source_ref: 'data-seed/know-revisions/vc-authz-apr.json', change_note: 'L4 端到端候选说明超过十字',
  }, { actor: 'script' })
  assert.equal(p.ok, true)
  const { revision_id, content_digest } = p.data
  const req = await bus.dispatch('approval', 'request', {
    kind: 'knowledge-publish', subject: `VC-AUTHZ-APR ${revision_id} 灰度发布（先提后评）`,
    evidence: '独立评测报告 eval-candidate-report.json 判定 eligible，本用例验证 effect 失败重试路径。',
    payload: { revision_id, content_digest, scope_type: 'program', scope_id: 'example-src' },
  }, { actor: 'model', session_id: 'sess_pub3' })
  assert.equal(req.ok, true)
  const decide = await bus.dispatch('approval', 'decide', { id: req.data.request_id, decision: 'approve' }, { actor: 'dashboard' })
  assert.equal(decide.ok, true)
  assert.equal(decide.data.effect_state, 'failed', 'candidate 不可发布 → effect failed')
  // 补齐评测（candidate→evaluating→eligible）
  const b = await bus.dispatch('know', 'revision_assess', { revision_id, phase: 'begin', eval_run_id: 'evalrun_apr_retry1', candidate_digest: content_digest }, { actor: 'reactor' })
  assert.equal(b.ok, true)
  const f = await bus.dispatch('know', 'revision_assess', { revision_id, phase: 'finish', eval_run_id: 'evalrun_apr_retry1', candidate_digest: content_digest, verdict: 'eligible', report_ref: 'eval-candidate-report.json' }, { actor: 'reactor' })
  assert.equal(f.ok, true)
  // 人工对账后重试 effect——原样重放（接收方幂等）
  const retry = await bus.dispatch('approval', 'effects_retry', { request_id: req.data.request_id }, { actor: 'dashboard' })
  assert.equal(retry.ok, true, JSON.stringify(retry.error || retry.data))
  assert.equal(retry.data.retried, 1, JSON.stringify(retry.data))
  assert.equal(retry.data.results[0].status, 'applied')
  assert.equal(retry.data.decision_status, 'approved', '全部补跑成功 → 决策态回归 approved')
  const rels1 = await bus.query('know', 'release_list', {}, { actor: 'dashboard' })
  assert.equal(rels1.total, 1)
  // 重试重试（幂等表过期后的重发；已无 failed effect）= 零动作
  db.prepare('DELETE FROM idempotency').run()
  const retry2 = await bus.dispatch('approval', 'effects_retry', { request_id: req.data.request_id }, { actor: 'dashboard' })
  assert.equal(retry2.ok, true)
  assert.equal(retry2.data.retried, 0)
  // 直接重复 dispatch 同 payload（幂等表过期后的极端重放）：同批准既有 release 吸收，零重复
  db.prepare('DELETE FROM idempotency').run()
  const again = await bus.dispatch('know', 'revision_publish', {
    revision_id, content_digest, auth_ref: `approval:${req.data.request_id}`,
    scope_type: 'program', scope_id: 'example-src', reason: `knowledge-publish 批准 #${req.data.request_id}：重复重放`,
  }, { actor: 'approval' })
  assert.equal(again.ok, true)
  assert.equal(again.data.published, false)
  assert.equal(again.data.duplicate, 'auth')
  const rels2 = await bus.query('know', 'release_list', {}, { actor: 'dashboard' })
  assert.equal(rels2.total, 1, 'effect 重试不重复发布')
  const evts = db.prepare("SELECT COUNT(*) c FROM event_outbox WHERE payload LIKE '%know.revision.published%'").get().c
  assert.equal(evts, 1, '零重复发布事件')
})

// ---------------------------------------------------------------------------
// 22 号方案 §十：campaign-autonomy / campaign-budget-extend 两个新 kind
// ---------------------------------------------------------------------------

test('22 campaign-autonomy: L1 升档审批 → effect campaign_autonomy_apply 落档激活', async () => {
  const { bus } = makeEnvWithTask()
  const c = await bus.dispatch('task', 'campaign_create', { name: 'camp-a', program_ids: ['example-src'], goal_spec: { stop_conditions: ['done'] } }, { actor: 'model' })
  const cid = c.data.campaign_id
  const r = await bus.dispatch('approval', 'request', { kind: 'campaign-autonomy', subject: 'camp-a', evidence: '升级 L1 建议模式（草稿人审放行）', payload: { autonomy: 1 } }, { actor: 'dashboard' })
  assert.equal(r.ok, true, r.error?.message)
  const rid = r.data.request_id
  const d = await bus.dispatch('approval', 'decide', { id: rid, decision: 'approve', operator: 'op1' }, { actor: 'dashboard' })
  assert.equal(d.ok, true, d.error?.message)
  assert.equal(d.data.effect_state, 'applied')
  const row = bus._internal.db().prepare('SELECT status, autonomy, approval_id FROM campaigns WHERE id=?').get(cid)
  assert.equal(row.status, 'active')
  assert.equal(row.autonomy, 1)
  assert.equal(row.approval_id, rid)
  // 31 号补丁：active/L1 再升档 L2 允许（自动降级后恢复通道；camp-a 有默认 budget 2M 过 INV-C4）
  const r2 = await bus.dispatch('approval', 'request', { kind: 'campaign-autonomy', subject: 'camp-a', evidence: '再次升档 L2 测试', payload: { autonomy: 2 } }, { actor: 'dashboard' })
  assert.equal(r2.ok, true, r2.error?.message)
  const d2 = await bus.dispatch('approval', 'decide', { id: r2.data.request_id, decision: 'approve', operator: 'op1' }, { actor: 'dashboard' })
  assert.equal(d2.ok, true, d2.error?.message)
  assert.equal(d2.data.effect_state, 'applied', 'active/L1 升 L2 批准须落档成功')
  assert.equal(bus._internal.db().prepare('SELECT autonomy FROM campaigns WHERE id=?').get(cid).autonomy, 2)
})

test('31 campaign-autonomy: active/L1（自动降级后）提请升 L2 → 批准落档不动 status；已是 L2 重复提请被拒', async () => {
  const { bus } = makeEnvWithTask()
  const c = await bus.dispatch('task', 'campaign_create', { name: 'camp-d31', program_ids: ['example-src'], budget_tokens: 100000, goal_spec: { stop_conditions: ['done'] } }, { actor: 'model' })
  const cid = c.data.campaign_id
  // 激活（L1）→ 模拟自动降级场景：active + autonomy=1
  const act = await bus.dispatch('approval', 'request', { kind: 'campaign-autonomy', subject: 'camp-d31', evidence: '激活 L1（建专项审批）', payload: { autonomy: 1 } }, { actor: 'dashboard' })
  await bus.dispatch('approval', 'decide', { id: act.data.request_id, decision: 'approve', operator: 'op' }, { actor: 'dashboard' })
  assert.equal(bus._internal.db().prepare('SELECT status, autonomy FROM campaigns WHERE id=?').get(cid).status, 'active')
  // 31：active/L1 提请升 L2 → 批准 → autonomy=2 且 status 保持 active
  const r = await bus.dispatch('approval', 'request', { kind: 'campaign-autonomy', subject: 'camp-d31', evidence: '连败自动降级后人工提请恢复 L2', payload: { autonomy: 2 } }, { actor: 'dashboard' })
  assert.equal(r.ok, true, r.error?.message)
  const d = await bus.dispatch('approval', 'decide', { id: r.data.request_id, decision: 'approve', operator: 'op1' }, { actor: 'dashboard' })
  assert.equal(d.ok, true, d.error?.message)
  assert.equal(d.data.effect_state, 'applied')
  const row = bus._internal.db().prepare('SELECT status, autonomy, approval_id FROM campaigns WHERE id=?').get(cid)
  assert.equal(row.autonomy, 2)
  assert.equal(row.status, 'active')
  assert.equal(row.approval_id, r.data.request_id)
  // 已是 L2 重复提请被拒
  const dup = await bus.dispatch('approval', 'request', { kind: 'campaign-autonomy', subject: 'camp-d31', evidence: '已是 L2 重复提请', payload: { autonomy: 2 } }, { actor: 'dashboard' })
  assert.equal(dup.ok, false)
  assert.equal(dup.error.code, 'E_INVARIANT')
})

test('31 campaign-budget-extend: reviewing（budget_exhausted 停止）专项豁免 80% 水位校验', async () => {
  const { bus } = makeEnvWithTask()
  const c = await bus.dispatch('task', 'campaign_create', { name: 'camp-b31', program_ids: ['example-src'], budget_tokens: 1000, goal_spec: { stop_conditions: ['done'] } }, { actor: 'model' })
  const cid = c.data.campaign_id
  // 模拟 budget_exhausted 转 reviewing：spent 台账口径与窗口口径不一致时 80% 校验不得堵死延长通道
  bus._internal.db().prepare("UPDATE campaigns SET status='reviewing', spent_tokens=100 WHERE id=?").run(cid)
  const r = await bus.dispatch('approval', 'request', { kind: 'campaign-budget-extend', subject: 'camp-b31', evidence: '预算耗尽停止，申请延长恢复', payload: { add_tokens: 1000 } }, { actor: 'model' })
  assert.equal(r.ok, true, r.error?.message)
  const d = await bus.dispatch('approval', 'decide', { id: r.data.request_id, decision: 'approve', operator: 'op1' }, { actor: 'dashboard' })
  assert.equal(d.ok, true, d.error?.message)
  assert.equal(bus._internal.db().prepare('SELECT budget_tokens FROM campaigns WHERE id=?').get(cid).budget_tokens, 2000)
})

test('34 task-budget-config: 校验非法参数 + 批准 effect 落 task_settings（在线生效）', async () => {
  const { bus } = makeEnvWithTask()
  // 空参数被拒
  const empty = await bus.dispatch('approval', 'request', { kind: 'task-budget-config', subject: 'per-program 预算闸', evidence: '空参数测试：payload 无任一预算字段应被校验拒绝', payload: {} }, { actor: 'dashboard' })
  assert.equal(empty.ok, false)
  assert.equal(empty.error.code, 'E_INVARIANT')
  // 合法提请 → 批准 → effect 落库
  const r = await bus.dispatch('approval', 'request', { kind: 'task-budget-config', subject: 'per-program 预算闸', evidence: '任务上限 500 → 550（种子任务创建解锁）', payload: { max_tasks: 550 } }, { actor: 'dashboard' })
  assert.equal(r.ok, true, r.error?.message)
  const d = await bus.dispatch('approval', 'decide', { id: r.data.request_id, decision: 'approve', operator: 'op1' }, { actor: 'dashboard' })
  assert.equal(d.ok, true, d.error?.message)
  assert.equal(d.data.effect_state, 'applied')
  const q = await bus.query('task', 'budget_config', {}, { actor: 'dashboard' })
  assert.equal(q.data.max_tasks, 550, '批准后 max_tasks 落库生效')
  assert.equal(q.data.source, 'db')
})

test('22 campaign-budget-extend: spent≥80% 才可延长，effect 增量落账', async () => {
  const { bus } = makeEnvWithTask()
  const c = await bus.dispatch('task', 'campaign_create', { name: 'camp-b', program_ids: ['example-src'], budget_tokens: 1000, goal_spec: { stop_conditions: ['done'] } }, { actor: 'model' })
  const cid = c.data.campaign_id
  // 未达 80% → 拒绝
  const early = await bus.dispatch('approval', 'request', { kind: 'campaign-budget-extend', subject: 'camp-b', evidence: '预算延长申请测试（未达阈值）', payload: { add_tokens: 1000 } }, { actor: 'model' })
  assert.equal(early.ok, false)
  assert.equal(early.error.code, 'E_INVARIANT')
  bus._internal.db().prepare('UPDATE campaigns SET spent_tokens=850 WHERE id=?').run(cid)
  const r = await bus.dispatch('approval', 'request', { kind: 'campaign-budget-extend', subject: 'camp-b', evidence: '窗口预算将触顶，申请追加 1000 tokens', payload: { add_tokens: 1000 } }, { actor: 'model' })
  assert.equal(r.ok, true, r.error?.message)
  const d = await bus.dispatch('approval', 'decide', { id: r.data.request_id, decision: 'approve', operator: 'op1' }, { actor: 'dashboard' })
  assert.equal(d.ok, true, d.error?.message)
  const row = bus._internal.db().prepare('SELECT budget_tokens FROM campaigns WHERE id=?').get(cid)
  assert.equal(row.budget_tokens, 2000)
})

test('22 B3: 二度升档/二度预算延长不被幂等吞掉（natural 键含 approval_id）', async () => {
  const { bus } = makeEnvWithTask()
  // 二度升档：批准 → 暂停 → 再次批准仍须重新激活
  const c = await bus.dispatch('task', 'campaign_create', { name: 'camp-r2', program_ids: ['example-src'], goal_spec: { stop_conditions: ['done'] } }, { actor: 'model' })
  const cid = c.data.campaign_id
  const r1 = await bus.dispatch('approval', 'request', { kind: 'campaign-autonomy', subject: 'camp-r2', evidence: '首次升 L1 建议模式', payload: { autonomy: 1 } }, { actor: 'dashboard' })
  await bus.dispatch('approval', 'decide', { id: r1.data.request_id, decision: 'approve', operator: 'op' }, { actor: 'dashboard' })
  await bus.dispatch('task', 'campaign_pause', { campaign_id: cid, note: '人工暂停' }, { actor: 'model' })
  const r2 = await bus.dispatch('approval', 'request', { kind: 'campaign-autonomy', subject: 'camp-r2', evidence: '二次升 L1 重新激活', payload: { autonomy: 1 } }, { actor: 'dashboard' })
  const d2 = await bus.dispatch('approval', 'decide', { id: r2.data.request_id, decision: 'approve', operator: 'op' }, { actor: 'dashboard' })
  assert.equal(d2.ok, true, d2.error?.message)
  assert.equal(bus._internal.db().prepare('SELECT status FROM campaigns WHERE id=?').get(cid).status, 'active', '二次批准必须重新激活')

  // 二度预算延长：同额度第二次仍须生效
  const c2 = await bus.dispatch('task', 'campaign_create', { name: 'camp-b2', program_ids: ['example-src'], budget_tokens: 1000, goal_spec: { stop_conditions: ['done'] } }, { actor: 'model' })
  const cid2 = c2.data.campaign_id
  bus._internal.db().prepare('UPDATE campaigns SET spent_tokens=850 WHERE id=?').run(cid2)
  const e1 = await bus.dispatch('approval', 'request', { kind: 'campaign-budget-extend', subject: 'camp-b2', evidence: '首次预算延长申请 1000 tokens', payload: { add_tokens: 1000 } }, { actor: 'model' })
  await bus.dispatch('approval', 'decide', { id: e1.data.request_id, decision: 'approve', operator: 'op' }, { actor: 'dashboard' })
  assert.equal(bus._internal.db().prepare('SELECT budget_tokens FROM campaigns WHERE id=?').get(cid2).budget_tokens, 2000)
  bus._internal.db().prepare('UPDATE campaigns SET spent_tokens=1700 WHERE id=?').run(cid2)
  const e2 = await bus.dispatch('approval', 'request', { kind: 'campaign-budget-extend', subject: 'camp-b2', evidence: '二次预算延长申请 1000 tokens', payload: { add_tokens: 1000 } }, { actor: 'model' })
  const d3 = await bus.dispatch('approval', 'decide', { id: e2.data.request_id, decision: 'approve', operator: 'op' }, { actor: 'dashboard' })
  assert.equal(d3.ok, true, d3.error?.message)
  assert.equal(bus._internal.db().prepare('SELECT budget_tokens FROM campaigns WHERE id=?').get(cid2).budget_tokens, 3000, '二次延长必须生效')
})

test('22 B4: campaign kind 的 task 域不可达 → fail-closed（不放行）', async () => {
  const { bus } = makeEnv() // 不注册 task 域 → campaignGet 返回 unavailable
  const r = await bus.dispatch('approval', 'request', { kind: 'campaign-autonomy', subject: 'x', evidence: '不可达 fail-closed 测试', payload: { autonomy: 1 } }, { actor: 'dashboard' })
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'E_INTERNAL')
})
