// ==============================================================================
// @silksec/sec-domain-vuln 契约测试（02-vuln.md §2.2 矩阵：happy path / schema /
// 不变量 / 状态机 / actor / 幂等 / 并发 / 事件载荷 8 类 × 全动词 + 查询口径 + 核心回归）
// 运行：node --test test/contract-vuln.test.js（插件组装目录内，type:module）
// 全部用例使用临时目录/临时库，绝不触碰 /opt/silkspool/dsh/data。
// ==============================================================================

import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as http from 'node:http'
import * as crypto from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { createBus } from '../../sec-domain-bus/index.js'
import { buildVulnDomain, VULN_MANIFEST, noiseCategoryDecision } from '../index.js'
import { buildExecDomain } from '../../sec-domain-exec/index.js'
import { createVulnSqliteBackend } from '../../sec-backend-vuln-sqlite/index.js'

// ---------------------------------------------------------------------------
// 测试装配（临时目录 + 临时库；vuln 域注册进独立总线实例）
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sec-domain-vuln-'))
}

function makeEnv(opts = {}) {
  const dir = tmpDir()
  const dataDir = path.join(dir, 'data')
  fs.mkdirSync(dataDir, { recursive: true })
  // 证据引用探测前置：run_test_* 的 results 目录须存在（INV-2 evidenceExists）
  fs.mkdirSync(path.join(dataDir, 'results', 'run_test_20260906_000000'), { recursive: true })
  fs.writeFileSync(path.join(dataDir, 'results', 'run_test_20260906_000000', 'meta.json'), '{}')
  fs.mkdirSync(path.join(dataDir, 'results', 'run_test_20260907_000000'), { recursive: true })
  fs.writeFileSync(path.join(dataDir, 'results', 'run_test_20260907_000000', 'meta.json'), '{}')
  if (opts.aliasesDoc) {
    opts = { ...opts, aliasesFile: writeAliases(path.join(dir, 'bus.aliases.yaml'), opts.aliasesDoc) }
  }
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
  const domain = buildVulnDomain({ dataDir, dispatch: (d, v, a, c) => bus.dispatch(d, v, a, c), query: (d,v,a,c) => bus.query(d,v,a,c) })
  fs.writeFileSync(path.join(dataDir, 'scope.yml'), 'defaults:\n  allow_risk: [passive, active, intrusive]\nprograms:\n  - name: test-src\n    scope:\n      - 127.0.0.1\n')
  bus.registry.register(buildExecDomain({ dataDir, egressProxy: '' }))
  const reg = bus.registry.register(domain)
  assert.equal(reg.ok, true, `vuln 域应注册成功：${reg.error?.message || ''}`)
  return { dir, dataDir, bus, domain }
}

function writeAliases(f, doc) {
  let y = 'aliases:\n' + Object.entries(doc.aliases || {}).map(([k, v]) => `  ${k}: ${v}`).join('\n') + '\n'
  y += 'dispatch_aliases:\n' + Object.entries(doc.dispatch_aliases || {}).map(([k, v]) => `  ${k}:\n    router: ${v.router}\n    domain: ${v.domain}\n`).join('')
  fs.writeFileSync(f, y)
  return f
}

function readAudit(dir) {
  const f = path.join(dir, 'audit.jsonl')
  if (!fs.existsSync(f)) return []
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
}

function readEvents(dir, domain = 'vuln') {
  const f = path.join(dir, 'events', `${domain}.jsonl`)
  if (!fs.existsSync(f)) return []
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
}

function startServer(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler)
    srv.listen(0, '127.0.0.1', () => resolve(srv))
  })
}

function serverPort(srv) { return srv.address().port }
async function closeServer(srv) { await new Promise((r) => srv.close(r)) }

test('authz_diff 接受 JSON 字符串 headers，改变 body 可重试且格式错误不当作网络重试', async t => {
  let requests = 0
  const srv = await startServer((req, res) => {
    requests++
    res.writeHead(req.headers['x-role'] === 'high' ? 200 : 403)
    res.end(req.headers['x-role'] === 'high' ? '{"ok":true}' : '{"denied":true}')
  })
  t.after(() => closeServer(srv))
  const { bus } = makeEnv()
  const args = { program_id: 'test-src', url: `http://127.0.0.1:${serverPort(srv)}/fixture`, method: 'POST',
    headers_low: '{"X-Role":"low"}', headers_high: '{"X-Role":"high"}', body: 'first' }
  const first = await bus.dispatch('vuln', 'authz_diff', args, { actor: 'model' })
  assert.equal(first.ok, true, first.error?.message)
  const second = await bus.dispatch('vuln', 'authz_diff', { ...args, body: 'second' }, { actor: 'model' })
  assert.equal(second.ok, true, second.error?.message)
  assert.equal(requests, 4)
  const bad = await bus.dispatch('vuln', 'authz_diff', { ...args, headers_low: '{broken' }, { actor: 'model' })
  assert.equal(bad.ok, false)
  assert.equal(bad.error.code, 'E_SCHEMA')
  assert.equal(bad.error.retryable, false)
  assert.equal(requests, 4)
})

function makeEvidence({ dataDir, id, target, body }) {
  const dir = path.join(dataDir, 'evidence', String(id))
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'request.txt'), [
    `GET ${target} HTTP/1.1`,
    `Host: 127.0.0.1:${new URL(target).port}`,
    '',
    body || '',
  ].join('\r\n'))
  return dir
}

// 完整五要素信号（happy path 公共种子）
async function seedSignal(bus, extra = {}) {
  return bus.dispatch('vuln', 'register_signal', {
    title: extra.title || '测试漏洞信号：命令注入可执行系统命令',
    severity: 'high',
    host: 'a.example.com',
    url: 'https://a.example.com/admin',
    evidence: 'run_test_20260906_000000',
    reproduction_steps: '访问管理接口并以命令拼接参数重放，观察回显',
    impact: '任意命令执行，服务器被完全控制',
    ...extra,
  }, { actor: 'model', session_id: 'sess_1' })
}

async function seedCandidate(bus, extra = {}) {
  return bus.dispatch('vuln', 'register_candidate', {
    title: extra.title || 'a.example.com 被动审计候选：xray',
    severity: 'medium',
    host: 'a.example.com',
    url: 'https://a.example.com/login',
    source: 'xray-webhook',
    ...extra,
  }, { actor: 'webhook', session_id: 'sess_webhook' })
}

// ---------------------------------------------------------------------------
// 21 号方案 §2-1/§2-2：proof capsule + oracle 证据门
// ---------------------------------------------------------------------------

const independentReview = { basis: '独立复核了请求、响应、正常与反例对照，确认所述安全属性被违反', reproduction_steps: '根据证据中的完整请求执行正常及反例对照，重复观察结果', impact: '证据已证明具体受保护对象遭到未经授权的访问' }
function reviewedConfirm(bus, args, ctx = {}) {
  return bus.dispatch('vuln', 'confirm', { ...args, review: independentReview }, { ...ctx, actor: 'dashboard', operator: ctx.operator || 'fixture-reviewer' })
}

const independentRejection = {
  basis: '独立复核目标、原始请求响应和反例，原观察不能支持所声称的安全属性违反',
  expected_behavior: '私有对象只应对已授权身份开放',
  observed_behavior: '未授权读取被拒绝且正常身份仍能读取',
  controls: '已确认有效身份与对象归属、正常对照成功，并重复执行相同请求验证反证',
}
function reviewedReject(bus, args, ctx = {}) {
  return bus.dispatch('vuln', 'reject', { ...args, evidence: args.evidence || 'run_test_20260906_000000',
    review: independentRejection }, { ...ctx, actor: 'dashboard', operator: ctx.operator || 'fixture-reviewer' })
}

test('27 E13: terminal reassessment is explicit, stale guarded, append-only and atomic', async t => {
  const { bus } = makeEnv()
  t.after(() => bus._internal.close())
  const candidate = await seedCandidate(bus, { program_id: 'test-src' })
  const id = candidate.data.id
  assert.equal((await reviewedReject(bus, { finding_id: id, verdict: 'false_positive', reason: '旧独立审校记录需要重新检查授权边界' })).ok, true)
  const db = bus._internal.db()
  const previous = { ...db.prepare('SELECT * FROM vuln_technical_verdicts WHERE finding_id=?').get(id) }
  const args = { finding_id: id, evidence: 'run_test_20260907_000000', corrects_verdict_id: previous.id,
    reassessment: { previous_status: 'false_positive', previous_verdict_id: previous.id,
      reason: '独立重新核对原请求与授权策略，发现原反证使用了错误身份' }, review: independentReview }
  assert.equal((await bus.dispatch('vuln', 'confirm', args, { actor: 'model', operator: 'pretend' })).error?.code, 'E_VULN_REVIEW_REQUIRED')
  assert.equal((await bus.dispatch('vuln', 'confirm', args, { actor: 'dashboard' })).error?.code, 'E_VULN_REVIEW_REQUIRED')
  assert.equal((await reviewedConfirm(bus, { ...args, reassessment: { ...args.reassessment, previous_verdict_id: null } })).error?.code, 'E_VULN_REVIEW_STALE')
  db.exec("CREATE TRIGGER deny_reassessment BEFORE INSERT ON vuln_technical_verdicts BEGIN SELECT RAISE(ABORT,'receipt blocked'); END")
  assert.equal((await reviewedConfirm(bus, args)).ok, false)
  assert.equal(db.prepare('SELECT status FROM findings WHERE id=?').get(id).status, 'false_positive')
  db.exec('DROP TRIGGER deny_reassessment')
  const confirmed = await reviewedConfirm(bus, args)
  assert.equal(confirmed.ok, true, confirmed.error?.message)
  assert.equal(confirmed.data.status, 'confirmed')
  assert.deepEqual({ ...db.prepare('SELECT * FROM vuln_technical_verdicts WHERE id=?').get(previous.id) }, previous)
  const detail = await bus.query('vuln', 'get', { id }, { actor: 'dashboard' })
  assert.equal(detail.data.technical_state.verdict, 'confirmed')
  assert.equal(detail.data.technical_state.latest_verdict_id, confirmed.data.technical_verdict_id)
  assert.equal((await reviewedConfirm(bus, args)).error?.code, 'E_VULN_REVIEW_STALE')
  assert.equal(db.prepare('SELECT COUNT(*) n FROM vuln_technical_verdicts WHERE finding_id=?').get(id).n, 2)
})

test('27 E13: technical review preserves accepted handling and separates unknown legacy labels', async t => {
  const { bus } = makeEnv()
  t.after(() => bus._internal.close())
  const candidate = await seedCandidate(bus, { program_id: 'test-src' })
  const id = candidate.data.id
  const db = bus._internal.db()
  db.prepare("UPDATE findings SET status='accepted', vendor_status='accepted', bounty=100, confidence='confirmed' WHERE id=?").run(id)
  let detail = await bus.query('vuln', 'get', { id }, { actor: 'dashboard' })
  assert.equal(detail.data.technical_state.verdict, 'unknown')
  const reassessment = { previous_status: 'accepted', previous_verdict_id: null,
    reason: '根据保存的原始网络报文进行独立审校，旧平台状态不提供技术真值' }
  const rejected = await reviewedReject(bus, { finding_id: id, verdict: 'false_positive',
    reason: '原始观察被当时的有效授权及正常对照反驳', reassessment })
  assert.equal(rejected.ok, true, rejected.error?.message)
  detail = await bus.query('vuln', 'get', { id }, { actor: 'dashboard' })
  assert.equal(detail.data.status, 'accepted')
  assert.equal(detail.data.vendor_status, 'accepted')
  assert.equal(detail.data.bounty, 100)
  assert.equal(detail.data.technical_state.verdict, 'false_positive')
  assert.equal(detail.data.confidence, 'false_positive')
  const malformed = await bus.dispatch('vuln', 'reject', { finding_id: id, verdict: 'ignored',
    reason: '处理退出不能冒充独立技术审校', review: independentRejection,
    reassessment: { ...reassessment, previous_verdict_id: rejected.data.technical_verdict_id } },
  { actor: 'dashboard', operator: 'reviewer' })
  assert.equal(malformed.error?.code, 'E_VULN_REVIEW_REQUIRED')
})

test('27 E13: reason-only rejection cannot close a candidate or create technical truth', async t => {
  const { bus } = makeEnv()
  t.after(() => bus._internal.close())
  const candidate = await seedCandidate(bus, { program_id: 'test-src' })
  const r = await bus.dispatch('vuln', 'reject', {
    finding_id: candidate.data.id, verdict: 'false_positive', reason: '目前缺少身份与原始响应，尚不能确认该漏洞',
  }, { actor: 'model' })
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'E_EVIDENCE_REQUIRED')
  const db = bus._internal.db()
  assert.equal(db.prepare('SELECT status FROM findings WHERE id=?').get(candidate.data.id).status, 'new')
  assert.equal(db.prepare('SELECT COUNT(*) n FROM vuln_technical_verdicts').get().n, 0)
  assert.equal(db.prepare("SELECT COUNT(*) n FROM event_outbox WHERE name='vuln.signal.rejected'").get().n, 0)
})

test('27 E13: independent counterevidence requires operator and persists an atomic receipt', async t => {
  const { bus } = makeEnv()
  t.after(() => bus._internal.close())
  const candidate = await seedCandidate(bus, { program_id: 'test-src' })
  const args = { finding_id: candidate.data.id, verdict: 'false_positive', reason: '原始观察已被完整身份对照和服务端拒绝响应反驳',
    evidence: 'run_test_20260906_000000', review: independentRejection }
  for (const ctx of [{ actor: 'model', operator: 'pretend' }, { actor: 'dashboard' }]) {
    const r = await bus.dispatch('vuln', 'reject', args, ctx)
    assert.equal(r.error?.code, 'E_VULN_REVIEW_REQUIRED')
  }
  const db = bus._internal.db()
  db.exec("CREATE TRIGGER deny_counterevidence BEFORE INSERT ON vuln_technical_verdicts BEGIN SELECT RAISE(ABORT,'receipt blocked'); END")
  assert.equal((await reviewedReject(bus, args)).ok, false)
  assert.equal(db.prepare('SELECT status FROM findings WHERE id=?').get(candidate.data.id).status, 'new')
  db.exec('DROP TRIGGER deny_counterevidence')
  const result = await reviewedReject(bus, args)
  assert.equal(result.ok, true, result.error?.message)
  const receipt = db.prepare('SELECT * FROM vuln_technical_verdicts WHERE finding_id=?').get(candidate.data.id)
  assert.equal(receipt.basis, 'independent_review')
  assert.equal(receipt.operator, 'fixture-reviewer')
  const event = JSON.parse(db.prepare('SELECT payload FROM event_outbox WHERE event_id=?').get(result.event_ids[0]).payload)
  assert.equal(event.payload.technical_verdict_id, receipt.id)
  assert.equal(event.payload.program_id, 'test-src')
  assert.equal(event.payload.evidence_ref, args.evidence)
  assert.equal(JSON.parse(receipt.evidence_json).review.controls, independentRejection.controls)
})

test('27 E13/L05: correction targets the current intact positive receipt of this finding and needs independent review', async t => {
  const { bus } = makeEnv()
  t.after(() => bus._internal.close())
  const candidate = await seedCandidate(bus)
  const foreign = await seedCandidate(bus, { url: 'https://a.example.com/foreign' })
  for (const row of [candidate, foreign]) assert.equal((await reviewedConfirm(bus, {
    finding_id: row.data.id, evidence: 'run_test_20260906_000000',
  })).ok, true)
  const db = bus._internal.db()
  const receipt = db.prepare('SELECT * FROM vuln_technical_verdicts WHERE finding_id=?').get(candidate.data.id)
  const other = db.prepare('SELECT * FROM vuln_technical_verdicts WHERE finding_id=?').get(foreign.data.id)
  const input = { finding_id: candidate.data.id, verdict: 'false_positive', reason: '独立反证证明原授权策略假设在实验当时不成立' }
  for (const corrects_verdict_id of [other.id, 999999]) {
    assert.equal((await reviewedReject(bus, { ...input, corrects_verdict_id })).error?.code, 'E_VULN_CORRECTION_TARGET')
  }
  assert.equal((await bus.dispatch('vuln', 'reject', { ...input, corrects_verdict_id: receipt.id,
    evidence: 'run_test_20260906_000000' }, { actor: 'model' })).error?.code, 'E_VULN_REVIEW_REQUIRED')
  db.prepare("UPDATE vuln_technical_verdicts SET evidence_json='{}' WHERE id=?").run(receipt.id)
  assert.equal((await reviewedReject(bus, { ...input, corrects_verdict_id: receipt.id })).error?.code, 'E_VULN_CORRECTION_TARGET')
  db.prepare('UPDATE vuln_technical_verdicts SET evidence_json=? WHERE id=?').run(receipt.evidence_json, receipt.id)
  assert.equal((await reviewedReject(bus, { ...input, corrects_verdict_id: receipt.id })).ok, true)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM vuln_technical_verdicts WHERE finding_id=?').get(candidate.data.id).n, 2)
})

test('27 L22: technical receipt write failure rolls back confirmation and keeps its fixed origin', async () => {
  const { bus } = makeEnv()
  const candidate = await seedCandidate(bus, { program_id: 'test-src' })
  assert.equal(candidate.ok, true)
  const db = bus._internal.db()
  db.exec(`CREATE TRIGGER fail_technical_receipt BEFORE INSERT ON vuln_technical_verdicts
    BEGIN SELECT RAISE(ABORT, 'injected receipt failure'); END`)
  const args = { finding_id: candidate.data.id, evidence: 'run_test_20260906_000000' }
  const failed = await reviewedConfirm(bus, args)
  assert.equal(failed.ok, false)
  const row = db.prepare('SELECT status,noise,discovery_origin,candidate_entered_at FROM findings WHERE id=?').get(candidate.data.id)
  assert.equal(row.status, 'new')
  assert.equal(row.noise, 1)
  assert.equal(row.discovery_origin, 'candidate')
  assert.ok(row.candidate_entered_at > 0)
  db.exec('DROP TRIGGER fail_technical_receipt')
  assert.equal((await reviewedConfirm(bus, args)).ok, true)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vuln_technical_verdicts WHERE finding_id=?').get(candidate.data.id).n, 1)
  assert.equal((await reviewedConfirm(bus, args)).ok, false)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vuln_technical_verdicts WHERE finding_id=?').get(candidate.data.id).n, 1)
})

test('WP02 legacy evidence requires explicit independent review, and model cannot claim review', async () => {
  const { bus, dataDir } = makeEnv()
  const signal = await seedSignal(bus)
  const forgedConfidence = await seedSignal(bus, { title: '调用方试图绕过确认门禁自行声明技术置信', confidence: 'confirmed' })
  assert.equal(forgedConfidence.ok, false)
  assert.equal(forgedConfidence.error.code, 'E_SCHEMA')
  const args = { finding_id: signal.data.id, evidence: 'run_test_20260906_000000' }
  assert.equal((await bus.dispatch('vuln', 'confirm', args, { actor: 'model' })).error.code, 'E_VULN_REVIEW_REQUIRED')
  assert.equal((await bus.dispatch('vuln', 'confirm', { ...args, review: independentReview }, { actor: 'model', operator: 'pretend' })).error.code, 'E_VULN_REVIEW_REQUIRED')
  assert.equal((await bus.dispatch('vuln', 'confirm', { ...args, review: independentReview }, { actor: 'dashboard' })).error.code, 'E_VULN_REVIEW_REQUIRED')
  const legacy = { capsule_version: 1, verdict: 'verified', target: { host: 'a.example.com' }, replay: { tool: 'arbitrary-command' } }
  const digest = crypto.createHash('sha256').update(JSON.stringify(legacy)).digest('hex')
  const capsuleId = digest.slice(0, 16)
  fs.mkdirSync(path.join(dataDir, 'evidence', 'oracle-capsules'), { recursive: true })
  fs.writeFileSync(path.join(dataDir, 'evidence', 'oracle-capsules', capsuleId + '.json'), JSON.stringify({ ...legacy, digest, capsule_id: capsuleId }))
  assert.equal((await bus.dispatch('vuln', 'confirm', { ...args, evidence: `capsule:${capsuleId}` }, { actor: 'model' })).error.code, 'E_VULN_REVIEW_REQUIRED')
  const replay = await bus.dispatch('vuln', 'capsule_replay', { capsule_id: capsuleId, harden: true }, { actor: 'script' })
  assert.equal(replay.data.verdict, 'blocked')
  assert.equal(replay.data.hardened_draft, null)
  const accepted = await reviewedConfirm(bus, args)
  assert.equal(accepted.ok, true, accepted.error?.message)
  const row = bus._internal.db().prepare('SELECT * FROM findings WHERE id=?').get(signal.data.id)
  assert.match(row.evidence, /fixture-reviewer/)
  assert.equal(row.reproduction_steps, independentReview.reproduction_steps)
})

// ---------------------------------------------------------------------------
// 1. happy path（每动词一例：信封结构 / data 字段 / 事件 payload / audit 落盘）
// ---------------------------------------------------------------------------

test('invariant §0-6: severity×vuln_type 硬降级（信息泄露 ≤ low / XSS 未证明执行 ≤ medium）', async () => {
  const { bus } = makeEnv()
  const mk = (extra) => bus.dispatch('vuln', 'register_signal', {
    title: '测试漏洞信号：某接口存在安全问题', severity: 'high', host: 'a.example.com',
    url: 'https://a.example.com/x', evidence: 'run_test_20260906_000000',
    reproduction_steps: '访问接口观察响应', impact: '影响描述', ...extra,
  }, { actor: 'model' })
  const capped = await mk({ vuln_type: 'info_disclosure', url: 'https://a.example.com/a' })
  assert.equal(capped.ok, false)
  assert.equal(capped.error.code, 'E_VULN_SEVERITY_CAPPED')
  const xss = await mk({ vuln_type: 'xss', severity: 'critical', url: 'https://a.example.com/b' })
  assert.equal(xss.ok, false)
  assert.equal(xss.error.code, 'E_VULN_SEVERITY_CAPPED')
  const okLow = await mk({ vuln_type: 'info_disclosure', severity: 'low', url: 'https://a.example.com/c' })
  assert.equal(okLow.ok, true)
  const okNoCap = await mk({ vuln_type: 'sqli', severity: 'high', url: 'https://a.example.com/d' })
  assert.equal(okNoCap.ok, true)
  const noType = await mk({ url: 'https://a.example.com/e' })
  assert.equal(noType.ok, true)
})

test('happy path C1: register_signal 登记信号面行（noise=0）+ signal.registered', async () => {
  const { dir, bus } = makeEnv()
  const r = await seedSignal(bus)
  assert.equal(r.ok, true)
  assert.equal(r.domain, 'vuln')
  assert.equal(r.cmd, 'register_signal')
  assert.ok(Number.isInteger(r.data.id))
  assert.equal(r.data.noise, false)
  assert.equal(r.data.dup, false)
  assert.equal(r.data.status, 'new')
  assert.ok(Array.isArray(r.event_ids) && r.event_ids.length === 1)
  assert.equal(r.replay, false)
  const audit = readAudit(dir)
  const cmd = audit.find((a) => a.kind === 'command' && a.cmd === 'register_signal' && a.result === 'ok')
  assert.ok(cmd)
  assert.equal(cmd.actor, 'model')
  assert.equal(cmd.session_id, 'sess_1')
  assert.deepEqual(cmd.after.status, 'new')
  assert.equal(cmd.after.noise, 0)
})

test('happy path C2: register_candidate 机器直灌候选（noise=1）+ candidate.registered', async () => {
  const { bus } = makeEnv()
  const r = await seedCandidate(bus)
  assert.equal(r.ok, true)
  assert.equal(r.data.noise, true)
  assert.equal(r.data.status, 'new')
  assert.equal(r.data.dup, false)
  assert.ok(r.event_ids.length === 1)
  const ev = await bus._internal.db().prepare('SELECT payload FROM event_outbox WHERE event_id=?').get(r.event_ids[0])
  const env = JSON.parse(ev.payload)
  assert.equal(env.name, 'vuln.candidate.registered')
  assert.equal(env.payload.host, 'a.example.com')
  assert.equal(env.payload.source, 'xray-webhook')
})

test('27 candidate type is tentative metadata; duplicate input never rewrites an existing classification', async t => {
  const { bus } = makeEnv()
  t.after(() => bus._internal.close())
  const typed = await seedCandidate(bus, { vuln_type: 'idor', external_id: 'typed-candidate' })
  assert.equal(typed.ok, true, typed.error?.message)
  const get = () => bus._internal.db().prepare('SELECT * FROM findings WHERE id=?').get(typed.data.id)
  assert.equal(get().vuln_type, 'idor')
  assert.equal(get().confidence, 'tentative')
  const changed = await seedCandidate(bus, { vuln_type: 'sqli', external_id: 'typed-candidate', evidence: 'new observation only' })
  assert.equal(changed.ok, true, changed.error?.message)
  assert.equal(changed.data.id, typed.data.id)
  assert.equal(get().vuln_type, 'idor')
  assert.ok(get().evidence.includes('new observation only'))
  const legacy = await seedCandidate(bus, { url: 'https://a.example.com/untyped' })
  assert.equal(legacy.ok, true)
  assert.equal(bus._internal.db().prepare('SELECT vuln_type FROM findings WHERE id=?').get(legacy.data.id).vuln_type, null)
  const unsupported = await seedCandidate(bus, { url: 'https://a.example.com/custom', vuln_type: 'custom-detector' })
  assert.equal(unsupported.ok, true, unsupported.error?.message)
  assert.equal(bus._internal.db().prepare('SELECT COUNT(*) n FROM vuln_technical_verdicts').get().n, 0)
})

test('happy path C3: confirm 候选 → 三联动原子升级（status+confidence+noise）+ 双事件 + audit', async () => {
  const { dir, bus } = makeEnv()
  const cand = await seedCandidate(bus)
  const id = cand.data.id
  const r = await reviewedConfirm(bus, { finding_id: id, evidence: 'run_test_20260906_000000', note: '三包对照齐全，重放 3 次稳定' }, { actor: 'model', session_id: 'sess_1' })
  assert.equal(r.ok, true)
  assert.equal(r.data.status, 'confirmed')
  assert.equal(r.data.signal, true)
  assert.equal(r.data.promoted_from_candidate, true)
  assert.equal(r.event_ids.length, 2)
  const audit = readAudit(dir)
  const cmd = audit.find((a) => a.kind === 'command' && a.cmd === 'confirm' && a.result === 'ok')
  assert.ok(cmd)
  assert.deepEqual(cmd.before, { status: 'new', noise: 1, confidence: 'tentative' })
  assert.deepEqual(cmd.after, { status: 'confirmed', noise: 0, confidence: 'confirmed' })
  const row = bus._internal.db().prepare('SELECT status, noise, confidence, claimed_by FROM findings WHERE id=?').get(id)
  assert.equal(row.status, 'confirmed')
  assert.equal(row.noise, 0)
  assert.equal(row.confidence, 'confirmed')
  assert.equal(row.claimed_by, null)
})

test('happy path C4: reject 候选 → false_positive（noise 保持 1 但退出候选口径）', async () => {
  const { bus } = makeEnv()
  const cand = await seedCandidate(bus)
  const r = await reviewedReject(bus, { finding_id: cand.data.id, verdict: 'false_positive', reason: '完整正常与反例对照证明原模板观察不成立', dup_of: null })
  assert.equal(r.ok, true)
  assert.equal(r.data.status, 'false_positive')
  assert.equal(r.data.noise, true)
  assert.equal(r.event_ids.length, 1)
  const row = bus._internal.db().prepare('SELECT status, noise FROM findings WHERE id=?').get(cand.data.id)
  assert.equal(row.status, 'false_positive')
  assert.equal(row.noise, 1)
})

test('happy path C5: submit confirmed→submitted→accepted（vendor 回流两段合法流转）', async () => {
  const { bus } = makeEnv()
  const sig = await seedSignal(bus)
  await reviewedConfirm(bus, { finding_id: sig.data.id, evidence: 'run_test_20260906_000000' }, { actor: 'model' })
  const s1 = await bus.dispatch('vuln', 'submit', { finding_id: sig.data.id, platform: '测试SRC', submission_url: 'https://src.example/ticket/1' }, { actor: 'model' })
  assert.equal(s1.ok, true)
  assert.equal(s1.data.status, 'submitted')
  assert.equal(s1.data.from, 'confirmed')
  assert.equal(s1.event_ids.length, 1)
  const row1 = bus._internal.db().prepare('SELECT status, submitted_at FROM findings WHERE id=?').get(sig.data.id)
  assert.equal(row1.status, 'submitted')
  assert.ok(row1.submitted_at)
  const s2 = await bus.dispatch('vuln', 'submit', { finding_id: sig.data.id, vendor_status: 'accepted', bounty: 5000 }, { actor: 'model' })
  assert.equal(s2.ok, true)
  assert.equal(s2.data.status, 'accepted')
  const row2 = bus._internal.db().prepare('SELECT status, bounty FROM findings WHERE id=?').get(sig.data.id)
  assert.equal(row2.status, 'accepted')
  assert.equal(row2.bounty, 5000)
})

test('happy path C6: note 追加证据链（不改状态，带时间戳前缀）', async () => {
  const { bus } = makeEnv()
  const sig = await seedSignal(bus)
  const r = await bus.dispatch('vuln', 'note', { finding_id: sig.data.id, note: '补充观测：管理接口存在默认口令风险' }, { actor: 'model' })
  assert.equal(r.ok, true)
  assert.equal(r.data.noted, true)
  assert.equal(r.event_ids.length, 0)
  const row = bus._internal.db().prepare('SELECT evidence FROM findings WHERE id=?').get(sig.data.id)
  assert.match(row.evidence, /note: 补充观测：管理接口存在默认口令风险/)
  assert.match(row.evidence, /\n\[20\d\d-/)
})

test('happy path C7/C8: claim 认领候选 + release 释放', async () => {
  const { bus } = makeEnv()
  const cand = await seedCandidate(bus)
  const id = cand.data.id
  const c1 = await bus.dispatch('vuln', 'claim', { finding_id: id }, { actor: 'model', session_id: 'sess_worker_a' })
  assert.equal(c1.ok, true)
  assert.equal(c1.data.claimed_by, 'sess_worker_a')
  assert.equal(c1.event_ids.length, 1)
  const row1 = bus._internal.db().prepare('SELECT claimed_by, claimed_at FROM findings WHERE id=?').get(id)
  assert.equal(row1.claimed_by, 'sess_worker_a')
  assert.ok(row1.claimed_at)
  const rel = await bus.dispatch('vuln', 'release', { finding_id: id }, { actor: 'model', session_id: 'sess_worker_a' })
  assert.equal(rel.ok, true)
  assert.equal(rel.data.released, true)
  const row2 = bus._internal.db().prepare('SELECT claimed_by FROM findings WHERE id=?').get(id)
  assert.equal(row2.claimed_by, null)
})

test('happy path C9: verify_replay 机械复核（request.txt 重放 + sha256 比对 + verify-log 追加）', async () => {
  const { dataDir, bus } = makeEnv()
  const sig = await seedSignal(bus, { host: '127.0.0.1', program_id: 'test-src' })
  const id = sig.data.id
  const body = JSON.stringify({ hello: 'world', n: 42 })
  const srv = await startServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(body) })
  const port = serverPort(srv)
  const target = `http://127.0.0.1:${port}/api/probe`
  makeEvidence({ dataDir, id, target, body })
  const expectHash = crypto.createHash('sha256').update(body, 'utf8').digest('hex')
  const r = await bus.dispatch('vuln', 'verify_replay', { finding_id: id, proxy: 'direct', expect_hash: expectHash }, { actor: 'model' })
  await closeServer(srv)
  assert.equal(r.ok, true)
  assert.equal(r.data.status, 200)
  assert.equal(r.data.verdict, 'PASS')
  assert.equal(r.data.sha256, expectHash)
  const log = fs.readFileSync(path.join(dataDir, 'evidence', String(id), 'verify-log.md'), 'utf8')
  assert.match(log, /direct \| 200 \| sha256:/)
  assert.match(log, /PASS \|/)
})

test('happy path C10: attach_fgs 关联 FGS 节点（后写胜）', async () => {
  const { bus } = makeEnv()
  const sig = await seedSignal(bus)
  const r1 = await bus.dispatch('vuln', 'attach_fgs', { finding_id: sig.data.id, fgs_node_id: 11 }, { actor: 'reactor' })
  assert.equal(r1.ok, true)
  assert.equal(r1.data.fgs_node_id, 11)
  const r2 = await bus.dispatch('vuln', 'attach_fgs', { finding_id: sig.data.id, fgs_node_id: 12 }, { actor: 'reactor' })
  assert.equal(r2.ok, true)
  const row = bus._internal.db().prepare('SELECT fgs_node_id FROM findings WHERE id=?').get(sig.data.id)
  assert.equal(row.fgs_node_id, 12)
})

test('happy path C11: authz_diff 双权重放仅保留观察，相似响应不自动登记候选', async () => {
  const { bus } = makeEnv()
  const data = JSON.stringify({ account_id: 1001, name: 'admin', phone: '13800000000' })
  const srv = await startServer((req, res) => {
    if (req.headers['x-role'] === 'high') { res.setHeader('content-type', 'application/json'); res.end(data) }
    else if (req.headers['x-role'] === 'low') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ account_id: 1001, name: 'admin', phone: '13800000000', role: 'user' })) }
    else { res.statusCode = 401; res.end('unauthorized') }
  })
  const port = serverPort(srv)
  const url = `http://127.0.0.1:${port}/api/user`
  const r = await bus.dispatch('vuln', 'authz_diff', {
    program_id: 'test-src', url,
    method: 'GET',
    headers_low: `X-Role: low`,
    headers_high: `X-Role: high`,
  }, { actor: 'model', session_id: 'sess_authz' })
  await closeServer(srv)
  assert.equal(r.ok, true)
  assert.equal(r.data.verdict, 'inconclusive')
  assert.equal(r.data.observation_only, true)
  assert.equal(r.data.candidate_id, undefined)
  assert.equal(bus._internal.db().prepare('SELECT COUNT(*) AS n FROM findings').get().n, 0)
})

test('happy path Q1-Q6: 查询全绿（分页信封 / 统计 / 候选队列 / 资产视图 / 查重）', async () => {
  const { bus } = makeEnv()
  const sig = await seedSignal(bus)
  const cand = await seedCandidate(bus)
  await bus.dispatch('vuln', 'claim', { finding_id: cand.data.id }, { actor: 'model', session_id: 'sess_a' })
  const q1 = await bus.query('vuln', 'list', { visibility: 'signal' }, { actor: 'model' })
  assert.equal(q1.ok, true)
  assert.equal(q1.total, 1)
  assert.equal(q1.rows.length, 1)
  const q2 = await bus.query('vuln', 'get', { id: sig.data.id }, { actor: 'model' })
  assert.equal(q2.ok, true)
  assert.equal(q2.data.id, sig.data.id)
  assert.ok(q2.data.evidence)
  const q3 = await bus.query('vuln', 'candidates', { claim_state: 'all' }, { actor: 'model' })
  assert.equal(q3.ok, true)
  assert.equal(q3.rows.length, 1)
  assert.equal(q3.rows[0].claimed_by, 'sess_a')
  assert.ok(q3.pool.pending === 0 && q3.pool.claimed === 1, `池摘要错误: ${JSON.stringify(q3.pool)}`)
  const q4 = await bus.query('vuln', 'stats', {}, { actor: 'model' })
  assert.equal(q4.ok, true)
  assert.equal(q4.data.signal.total, 1)
  assert.equal(q4.data.candidate.pending, 1, '候选池 KPI=noise=1 AND status=new（含已认领，认领是软锁不是出池）')
  assert.equal(q4.data.candidate.claimed, 1)
  const q5 = await bus.query('vuln', 'by_asset', { host: 'a.example.com' }, { actor: 'model' })
  assert.equal(q5.ok, true)
  assert.equal(q5.data.host, 'a.example.com')
  assert.equal(q5.data.total, 1)
  const q6 = await bus.query('vuln', 'dedup_check', { host: 'a.example.com' }, { actor: 'model' })
  assert.equal(q6.ok, true)
  assert.ok(q6.rows.length >= 1)
})

// ---------------------------------------------------------------------------
// 2. schema 拒绝（缺必填 / 未知参数 / 枚举越界 → E_SCHEMA 含字段名）
// ---------------------------------------------------------------------------

test('schema 拒绝: register_signal 缺必填/未知参数/severity 越枚举 → E_SCHEMA', async () => {
  const { bus } = makeEnv()
  const r1 = await bus.dispatch('vuln', 'register_signal', { title: '只有标题的登记', severity: 'high', host: 'a.example.com' }, { actor: 'model' })
  assert.equal(r1.ok, false)
  assert.equal(r1.error.code, 'E_SCHEMA')
  assert.match(r1.error.message, /evidence|reproduction_steps|impact/)
  const r2 = await bus.dispatch('vuln', 'register_signal', { title: '完整测试信号一二三四五', severity: 'high', host: 'a.example.com', evidence: 'run_x', reproduction_steps: 'a', impact: 'b', extra_field: 1 }, { actor: 'model' })
  assert.equal(r2.error.code, 'E_SCHEMA')
  assert.match(r2.error.message, /extra_field/)
  const r3 = await bus.dispatch('vuln', 'register_signal', { title: '完整测试信号一二三四五', severity: 'not-a-severity', host: 'a.example.com', evidence: 'run_x', reproduction_steps: 'a', impact: 'b' }, { actor: 'model' })
  assert.equal(r3.error.code, 'E_SCHEMA')
  assert.match(r3.error.message, /severity/)
})

test('schema 拒绝: reject verdict 非枚举 / note 空 / claim 缺 id → E_SCHEMA', async () => {
  const { bus } = makeEnv()
  const cand = await seedCandidate(bus)
  const r1 = await bus.dispatch('vuln', 'reject', { finding_id: cand.data.id, verdict: 'maybe', reason: 'x'.repeat(10) }, { actor: 'model' })
  assert.equal(r1.error.code, 'E_SCHEMA')
  const r2 = await bus.dispatch('vuln', 'note', { finding_id: cand.data.id, note: '   ' }, { actor: 'model' })
  assert.equal(r2.error.code, 'E_SCHEMA')
  const r3 = await bus.dispatch('vuln', 'claim', {}, { actor: 'model' })
  assert.equal(r3.error.code, 'E_SCHEMA')
})

// ---------------------------------------------------------------------------
// 3. 不变量拒绝（INV-1~INV-9 反例）
// ---------------------------------------------------------------------------

test('不变量 INV-1/INV-4: register_signal 五要素缺失 → E_VULN_INCOMPLETE；info → E_VULN_INFO_SEVERITY', async () => {
  const { bus } = makeEnv()
  const r1 = await bus.dispatch('vuln', 'register_signal', { title: '短标题', severity: 'high', host: 'a.example.com', evidence: 'run_x', reproduction_steps: 'a', impact: 'b' }, { actor: 'model' })
  assert.equal(r1.ok, false)
  assert.equal(r1.error.code, 'E_VULN_INCOMPLETE')
  const r2 = await bus.dispatch('vuln', 'register_signal', { title: 'xray: web_statistic', severity: 'high', host: 'a.example.com', evidence: 'run_x', reproduction_steps: 'a', impact: 'b' }, { actor: 'model' })
  assert.equal(r2.error.code, 'E_VULN_INCOMPLETE', '低信息标题形状应拒绝')
  const r3 = await bus.dispatch('vuln', 'register_signal', { title: '完整测试信号一二三四五', severity: 'info', host: 'a.example.com', evidence: 'run_x', reproduction_steps: 'a', impact: 'b' }, { actor: 'model' })
  assert.equal(r3.error.code, 'E_VULN_INFO_SEVERITY')
  const r4 = await bus.dispatch('vuln', 'register_signal', { title: '完整测试信号一二三四五', severity: 'high', host: 'a.example.com', evidence: '无证据引用的文本', reproduction_steps: 'a', impact: 'b' }, { actor: 'model' })
  assert.equal(r4.error.code, 'E_EVIDENCE_REQUIRED')
})

test('不变量 INV-2: confirm evidence 引用不存在 → E_EVIDENCE_REQUIRED', async () => {
  const { bus } = makeEnv()
  const cand = await seedCandidate(bus)
  const r = await bus.dispatch('vuln', 'confirm', { finding_id: cand.data.id, evidence: 'run_does_not_exist_123' }, { actor: 'model' })
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'E_EVIDENCE_REQUIRED')
})

test('证据引用不能通过 flow 路径或软链逃出平台数据目录', async () => {
  const { bus, dir, dataDir } = makeEnv()
  fs.writeFileSync(path.join(dir, 'outside.txt'), 'local-only fixture')
  fs.symlinkSync(path.join(dir, 'outside.txt'), path.join(dataDir, 'escape.txt'))
  const cand = await seedCandidate(bus)
  for (const evidence of ['flow:../outside.txt', 'flow:escape.txt']) {
    const r = await bus.dispatch('vuln', 'confirm', { finding_id: cand.data.id, evidence }, { actor: 'model' })
    assert.equal(r.error.code, 'E_EVIDENCE_REQUIRED')
  }
})

test('vuln_evidence_put 受管写入证据包，verify_replay 闭环可复核', async t => {
  const srv = await startServer((req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('poc-response-body') })
  t.after(() => closeServer(srv))
  const { bus, dataDir } = makeEnv()
  const cand = await seedCandidate(bus, { host: '127.0.0.1', program_id: 'test-src' })
  const id = cand.data.id
  const reqText = `GET http://127.0.0.1:${serverPort(srv)}/poc HTTP/1.1\r\nHost: 127.0.0.1:${serverPort(srv)}\r\n\r\n`
  const put = await bus.dispatch('vuln', 'evidence_put', { finding_id: id, request_text: reqText, note: '本地 POC' }, { actor: 'model' })
  assert.equal(put.ok, true, put.error?.message)
  assert.equal(put.data.method, 'GET')
  const bad = await bus.dispatch('vuln', 'evidence_put', { finding_id: id, request_text: 'garbage' }, { actor: 'model' })
  assert.equal(bad.error.code, 'E_SCHEMA')
  const noHost = await bus.dispatch('vuln', 'evidence_put', { finding_id: id, request_text: 'GET /poc HTTP/1.1\r\n\r\n' }, { actor: 'model' })
  assert.equal(noHost.error.code, 'E_SCHEMA')
  assert.equal(fs.readFileSync(path.join(dataDir, 'evidence', String(id), 'request.txt'), 'utf8'), reqText)
  const replay = await bus.dispatch('vuln', 'verify_replay', { finding_id: id }, { actor: 'model' })
  assert.equal(replay.ok, true, replay.error?.message)
  assert.equal(replay.data.sha256, crypto.createHash('sha256').update('poc-response-body', 'utf8').digest('hex'))
  assert.equal((await bus.dispatch('vuln', 'reject', { finding_id: id, verdict: 'ignored', reason: '本地 fixture 结束' }, { actor: 'model' })).ok, true)
  const terminal = await bus.dispatch('vuln', 'evidence_put', { finding_id: id, request_text: `GET http://127.0.0.1:${serverPort(srv)}/poc2 HTTP/1.1\r\nHost: 127.0.0.1:${serverPort(srv)}\r\n\r\n` }, { actor: 'model' })
  assert.equal(terminal.error.code, 'E_STATE')
})

test('不变量 INV-9: reject dup 缺 dup_of → E_VULN_DUP_TARGET_REQUIRED；dup_of 不存在 → E_NOT_FOUND', async () => {
  const { bus } = makeEnv()
  const cand = await seedCandidate(bus)
  const r1 = await bus.dispatch('vuln', 'reject', { finding_id: cand.data.id, verdict: 'dup', reason: '与既有条目完全重复，同一模板同一目标' }, { actor: 'model' })
  assert.equal(r1.ok, false)
  assert.equal(r1.error.code, 'E_VULN_DUP_TARGET_REQUIRED')
  const r2 = await bus.dispatch('vuln', 'reject', { finding_id: cand.data.id, verdict: 'dup', dup_of: 99999, reason: '与既有条目完全重复，同一模板同一目标' }, { actor: 'model' })
  assert.equal(r2.ok, false)
  assert.equal(r2.error.code, 'E_NOT_FOUND')
})

test('不变量 INV-2b: confirm 缺 evidence → E_EVIDENCE_REQUIRED（引导性 hint，确定性）', async () => {
  const { bus } = makeEnv()
  const r = await bus.dispatch('vuln', 'confirm', { finding_id: 1 }, { actor: 'model' })
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'E_EVIDENCE_REQUIRED')
  assert.ok(r.error.hint && r.error.hint.includes('证据'), 'hint 应引导附证据引用')
})

test('不变量 E_NOT_FOUND: confirm/note/claim 不存在的行 → E_NOT_FOUND', async () => {
  const { bus } = makeEnv()
  const r1 = await bus.dispatch('vuln', 'confirm', { finding_id: 99999, evidence: 'run_test_20260906_000000' }, { actor: 'model' })
  assert.equal(r1.ok, false)
  assert.equal(r1.error.code, 'E_NOT_FOUND')
  const r2 = await bus.dispatch('vuln', 'note', { finding_id: 99999, note: 'x' }, { actor: 'model' })
  assert.equal(r2.error.code, 'E_NOT_FOUND')
  const r3 = await bus.dispatch('vuln', 'claim', { finding_id: 99999 }, { actor: 'model' })
  assert.equal(r3.error.code, 'E_NOT_FOUND')
})

test('不变量 INV-7: 认领互斥——他人活跃认领时 model confirm/reject/claim 被拒 E_VULN_CLAIMED（retryable）', async () => {
  const { bus } = makeEnv()
  const cand = await seedCandidate(bus)
  const id = cand.data.id
  await bus.dispatch('vuln', 'claim', { finding_id: id }, { actor: 'model', session_id: 'sess_a' })
  const c1 = await bus.dispatch('vuln', 'claim', { finding_id: id }, { actor: 'model', session_id: 'sess_b' })
  assert.equal(c1.ok, false)
  assert.equal(c1.error.code, 'E_VULN_CLAIMED')
  assert.equal(c1.error.retryable, true)
  const c2 = await bus.dispatch('vuln', 'confirm', { finding_id: id, evidence: 'run_test_20260906_000000' }, { actor: 'model', session_id: 'sess_b' })
  assert.equal(c2.ok, false)
  assert.equal(c2.error.code, 'E_VULN_REVIEW_REQUIRED')
  const c3 = await bus.dispatch('vuln', 'reject', { finding_id: id, verdict: 'ignored', reason: 'x'.repeat(10) }, { actor: 'model', session_id: 'sess_b' })
  assert.equal(c3.ok, false)
  assert.equal(c3.error.code, 'E_VULN_CLAIMED')
  // dashboard 豁免（人工终审可越）
  const c4 = await reviewedConfirm(bus, { finding_id: id, evidence: 'run_test_20260906_000000' }, { actor: 'dashboard', operator: 'operator_1' })
  assert.equal(c4.ok, true)
})

test('不变量 INV-8: verify_replay 证据目录由 finding_id 派生（无 evidence_dir 参数，E_NOT_FOUND 路径）', async () => {
  const { bus } = makeEnv()
  const sig = await seedSignal(bus)
  const r = await bus.dispatch('vuln', 'verify_replay', { finding_id: sig.data.id, proxy: 'direct' }, { actor: 'model' })
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'E_NOT_FOUND')
  assert.match(r.error.message, /request\.txt 不存在/)
})

// ---------------------------------------------------------------------------
// 4. 状态机拒绝（终态不可再流转全集）
// ---------------------------------------------------------------------------

test('状态机拒绝: confirm 已 confirmed 行 / reject 已 accepted 行 / submit new 行', async () => {
  const { bus } = makeEnv()
  const sig = await seedSignal(bus)
  const id = sig.data.id
  await reviewedConfirm(bus, { finding_id: id, evidence: 'run_test_20260906_000000' }, { actor: 'model' })
  const c1 = await reviewedConfirm(bus, { finding_id: id, evidence: 'run_test_20260907_000000' }, { actor: 'model' })
  assert.equal(c1.ok, false)
  assert.equal(c1.error.code, 'E_STATE')
  await bus.dispatch('vuln', 'submit', { finding_id: id }, { actor: 'model' })
  await bus.dispatch('vuln', 'submit', { finding_id: id, vendor_status: 'accepted' }, { actor: 'model' })
  const c2 = await reviewedReject(bus, { finding_id: id, verdict: 'false_positive', reason: 'x'.repeat(10) })
  assert.equal(c2.ok, false)
  assert.equal(c2.error.code, 'E_STATE')
  const sig2 = await seedSignal(bus, { title: '另一个完整测试信号一二三四', host: 'b.example.com' })
  const c3 = await bus.dispatch('vuln', 'submit', { finding_id: sig2.data.id }, { actor: 'model' })
  assert.equal(c3.ok, false)
  assert.equal(c3.error.code, 'E_STATE')
})

test('状态机拒绝: 终态再流转全集（accepted/fp/dup/ignored × confirm/reject/submit）', async () => {
  const { bus } = makeEnv()
  for (const verdict of ['false_positive', 'dup', 'ignored']) {
    const sig = await seedSignal(bus, { title: `终态测试信号${verdict}一二三四五六`, host: `t-${verdict}.example.com` })
    const terminalArgs = { finding_id: sig.data.id, verdict, reason: 'x'.repeat(10), ...(verdict === 'dup' ? { dup_of: sig.data.id } : {}) }
    const terminal = verdict === 'false_positive' ? await reviewedReject(bus, terminalArgs)
      : await bus.dispatch('vuln', 'reject', terminalArgs, { actor: 'model' })
    assert.equal(terminal.ok, true, terminal.error?.message)
    for (const cmd of ['confirm', 'reject', 'submit']) {
      const args = cmd === 'confirm' ? { finding_id: sig.data.id, evidence: 'run_test_20260906_000000' }
        : cmd === 'reject' ? { finding_id: sig.data.id, verdict: 'ignored', reason: 'y'.repeat(10) }
          : { finding_id: sig.data.id }
      const r = await (cmd === 'confirm' ? reviewedConfirm(bus, args) : bus.dispatch('vuln', cmd, args, { actor: 'model' }))
      assert.equal(r.ok, false, `${cmd} on ${verdict} 应被拒`)
      assert.equal(r.error.code, 'E_STATE')
    }
  }
})

// ---------------------------------------------------------------------------
// 5. actor 拒绝（机器通道模型禁入；模型动词机器禁入）
// ---------------------------------------------------------------------------

test('actor: register_candidate × {model,human} 拒 / dashboard 放行（操作员候选登记）', async () => {
  const { bus } = makeEnv()
  for (const actor of ['model', 'human']) {
    const r = await bus.dispatch('vuln', 'register_candidate', { title: 'x.example.com 被动审计候选：xray', severity: 'medium', host: 'x.example.com', source: 'xray-webhook' }, { actor })
    assert.equal(r.ok, false, `${actor} 应被拒`)
    assert.equal(r.error.code, 'E_ACTOR_FORBIDDEN')
  }
  const d = await bus.dispatch('vuln', 'register_candidate', { title: 'dashboard 会话登记候选一二', severity: 'info', host: 'd.example.com', source: 'dashboard' }, { actor: 'dashboard' })
  assert.equal(d.ok, true, 'dashboard 操作员可达候选登记（会话「登记候选漏洞」）')
  assert.equal(d.cmd, 'register_candidate')
})

test('actor 拒绝: confirm × {webhook,script} / claim × webhook / authz_diff × dashboard → E_ACTOR_FORBIDDEN', async () => {
  const { bus } = makeEnv()
  const cand = await seedCandidate(bus)
  for (const actor of ['webhook', 'script']) {
    const r = await bus.dispatch('vuln', 'confirm', { finding_id: cand.data.id, evidence: 'run_x' }, { actor })
    assert.equal(r.error.code, 'E_ACTOR_FORBIDDEN')
  }
  const c1 = await bus.dispatch('vuln', 'claim', { finding_id: cand.data.id }, { actor: 'webhook' })
  assert.equal(c1.error.code, 'E_ACTOR_FORBIDDEN')
  const c2 = await bus.dispatch('vuln', 'authz_diff', { url: 'http://127.0.0.1:1/', headers_low: 'a:1', headers_high: 'a:1' }, { actor: 'dashboard' })
  assert.equal(c2.error.code, 'E_ACTOR_FORBIDDEN')
})

// ---------------------------------------------------------------------------
// 6. 幂等重放（同 key 同参 → replay:true 同结果；同 key 异参 → E_IDEMPOTENT_CONFLICT）
// ---------------------------------------------------------------------------

test('幂等: register_signal natural 键重放（同 host+title+url → replay）异参 → E_IDEMPOTENT_CONFLICT', async () => {
  const { bus } = makeEnv()
  const a1 = await bus.dispatch('vuln', 'register_signal', { title: '幂等测试信号一二三四五六七', severity: 'high', host: 'i.example.com', url: 'https://i.example.com/a', evidence: 'run_x', reproduction_steps: 'a', impact: 'b' }, { actor: 'model' })
  const a2 = await bus.dispatch('vuln', 'register_signal', { title: '幂等测试信号一二三四五六七', severity: 'high', host: 'i.example.com', url: 'https://i.example.com/a', evidence: 'run_x', reproduction_steps: 'a', impact: 'b' }, { actor: 'model' })
  assert.equal(a2.ok, true)
  assert.equal(a2.replay, true)
  assert.equal(a1.data.id, a2.data.id)
  const a3 = await bus.dispatch('vuln', 'register_signal', { title: '幂等测试信号一二三四五六七', severity: 'high', host: 'i.example.com', url: 'https://i.example.com/a', evidence: 'run_y', reproduction_steps: 'a', impact: 'b' }, { actor: 'model' })
  assert.equal(a3.ok, false)
  assert.equal(a3.error.code, 'E_IDEMPOTENT_CONFLICT')
})

test('confirm 重新验证不缓存；note/claim/submit 保持幂等重放', async () => {
  const { bus } = makeEnv()
  const cand = await seedCandidate(bus)
  const id = cand.data.id
  const c1 = await reviewedConfirm(bus, { finding_id: id, evidence: 'run_test_20260906_000000' }, { actor: 'model' })
  const c2 = await reviewedConfirm(bus, { finding_id: id, evidence: 'run_test_20260906_000000' }, { actor: 'model' })
  assert.equal(c1.ok, true)
  assert.equal(c2.ok, false)
  assert.equal(c2.error.code, 'E_STATE')
  const n1 = await bus.dispatch('vuln', 'note', { finding_id: id, note: '复验记录一致' }, { actor: 'model' })
  const n2 = await bus.dispatch('vuln', 'note', { finding_id: id, note: '复验记录一致' }, { actor: 'model' })
  assert.equal(n2.replay, true)
  const s1 = await bus.dispatch('vuln', 'submit', { finding_id: id, platform: '测试SRC' }, { actor: 'model' })
  const s2 = await bus.dispatch('vuln', 'submit', { finding_id: id, platform: '测试SRC' }, { actor: 'model' })
  assert.equal(s2.replay, true)
  // claim：认领者进幂等键（session 不同 → 键不同不重放；同 session 同参 → replay）
  const cand2 = await seedCandidate(bus, { title: 'b.example.com 被动审计候选：xray', host: 'b.example.com' })
  const k1 = await bus.dispatch('vuln', 'claim', { finding_id: cand2.data.id }, { actor: 'model', session_id: 'sess_a' })
  const k2 = await bus.dispatch('vuln', 'claim', { finding_id: cand2.data.id }, { actor: 'model', session_id: 'sess_a' })
  assert.equal(k2.ok, true)
  assert.equal(k2.replay, true)
})

test('幂等: 显式 idempotency_key 同 key 异参 → E_IDEMPOTENT_CONFLICT', async () => {
  const { bus } = makeEnv()
  const r1 = await bus.dispatch('vuln', 'register_candidate', { title: '显式键测试候选一二三', severity: 'medium', host: 'e.example.com', source: 'xray-webhook', idempotency_key: 'vuln:register_candidate:manual:001' }, { actor: 'webhook' })
  assert.equal(r1.ok, true)
  const r2 = await bus.dispatch('vuln', 'register_candidate', { title: '显式键测试候选四五六', severity: 'high', host: 'e.example.com', source: 'xray-webhook', idempotency_key: 'vuln:register_candidate:manual:001' }, { actor: 'webhook' })
  assert.equal(r2.ok, false)
  assert.equal(r2.error.code, 'E_IDEMPOTENT_CONFLICT')
})

test('27: 同 host/title 不同 URL 保留为独立候选观察', async () => {
  const { bus } = makeEnv()
  const a1 = await seedCandidate(bus)
  const a2 = await bus.dispatch('vuln', 'register_candidate', { title: 'a.example.com 被动审计候选：xray', severity: 'high', host: 'a.example.com', url: 'https://a.example.com/login?variant=2', source: 'xray-webhook' }, { actor: 'webhook' })
  assert.equal(a2.ok, true)
  assert.equal(a2.data.dup, false)
  assert.notEqual(a1.data.id, a2.data.id, '不同 URL 在验证前不得合并')
})

test('27 WP05 E15: 同 URL 不同 endpoint_ref（身份/对象/方法）保留为独立观察', async () => {
  const { bus } = makeEnv()
  const base = { title: 'a.example.com 被动审计候选：xray', severity: 'high', host: 'a.example.com', url: 'https://a.example.com/orders/1', source: 'xray-webhook' }
  const a1 = await bus.dispatch('vuln', 'register_candidate', { ...base, endpoint_ref: 'identity:A|method:GET' }, { actor: 'webhook' })
  const a2 = await bus.dispatch('vuln', 'register_candidate', { ...base, endpoint_ref: 'identity:B|method:GET' }, { actor: 'webhook' })
  assert.equal(a1.ok, true, a1.error?.message)
  assert.equal(a2.ok, true, a2.error?.message)
  assert.equal(a2.data.dup, false)
  assert.notEqual(a1.data.id, a2.data.id, '同 URL 不同身份/对象须为独立观察，不得折叠为 dup')
  // register_signal 同样按 endpoint_ref 区分
  const sig = { title: '完整测试信号一二三四五六七', severity: 'high', host: 's.example.com', url: 'https://s.example.com/x', reproduction_steps: 'a', impact: 'b' }
  const r1 = await bus.dispatch('vuln', 'register_signal', { ...sig, evidence: 'run_x', endpoint_ref: 'user:1' }, { actor: 'model' })
  const r2 = await bus.dispatch('vuln', 'register_signal', { ...sig, evidence: 'run_y', endpoint_ref: 'user:2' }, { actor: 'model' })
  assert.equal(r1.ok, true, r1.error?.message)
  assert.equal(r2.ok, true, r2.error?.message)
  assert.notEqual(r1.data.id, r2.data.id, '信号同 URL 不同身份须独立')
})

// ---------------------------------------------------------------------------
// 7. 并发（两进程同时 claim/confirm 同一候选 → 一成一败，最终状态一致）
// ---------------------------------------------------------------------------

test('并发: 跨进程两实例同时 claim 同一候选 → 一成一 E_VULN_CLAIMED', async () => {
  const dir = tmpDir()
  const dataDir = path.join(dir, 'data')
  fs.mkdirSync(dataDir, { recursive: true })
  const busPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../sec-domain-bus/index.js')
  const vulnPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../index.js')
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const execFileP = promisify(execFile)

  const seedBus = createBus({ dataDir, dbFile: path.join(dir, 'asset-graph.db'), aliasesFile: path.join(dir, 'bus.aliases.yaml'), auditFile: path.join(dir, 'audit.jsonl'), eventsDir: path.join(dir, 'events'), sidecars: false, startDispatcherTimer: false })
  seedBus.registry.register(buildVulnDomain({ dataDir, dispatch: (d, v, a, c) => seedBus.dispatch(d, v, a, c) }))
  const cand = await seedBus.dispatch('vuln', 'register_candidate', { title: '并发认领测试候选一二三', severity: 'high', host: 'cc.example.com', source: 'xray-webhook' }, { actor: 'webhook' })
  const id = cand.data.id
  seedBus._internal.close()

  const workerSrc = (session) => `
import { createBus } from ${JSON.stringify('file://' + busPath)}
import { buildVulnDomain } from ${JSON.stringify('file://' + vulnPath)}
const dir = ${JSON.stringify(dir)}
const dataDir = ${JSON.stringify(dataDir)}
const bus = createBus({ dataDir, dbFile: path.join(dir, 'asset-graph.db'), aliasesFile: path.join(dir, 'bus.aliases.yaml'), auditFile: path.join(dir, 'audit.jsonl'), eventsDir: path.join(dir, 'events'), sidecars: false, startDispatcherTimer: false })
bus.registry.register(buildVulnDomain({ dataDir, dispatch: (d, v, a, c) => bus.dispatch(d, v, a, c) }))
const env = await bus.dispatch('vuln', 'claim', { finding_id: ${id} }, { actor: 'model', session_id: ${JSON.stringify(session)} })
process.stdout.write(JSON.stringify({ ok: env.ok, code: env.error ? env.error.code : null, claimed_by: env.ok ? env.data.claimed_by : null }))
bus._internal.close()
`
  const results = await Promise.all([
    execFileP(process.execPath, ['--input-type=module', '-e', workerSrc('sess_a')], { timeout: 30000 }),
    execFileP(process.execPath, ['--input-type=module', '-e', workerSrc('sess_b')], { timeout: 30000 }),
  ])
  const parsed = results.map((r) => JSON.parse(r.stdout.trim()))
  const oks = parsed.filter((r) => r.ok)
  assert.equal(oks.length, 1, `应恰一进程认领成功: ${JSON.stringify(parsed)}`)
  assert.ok(parsed.some((r) => !r.ok && r.code === 'E_VULN_CLAIMED'), `另一进程应 E_VULN_CLAIMED: ${JSON.stringify(parsed)}`)
  const checkBus = createBus({ dataDir, dbFile: path.join(dir, 'asset-graph.db'), aliasesFile: path.join(dir, 'bus.aliases.yaml'), auditFile: path.join(dir, 'audit.jsonl'), eventsDir: path.join(dir, 'events'), sidecars: false, startDispatcherTimer: false })
  const row = checkBus._internal.db().prepare('SELECT claimed_by FROM findings WHERE id=?').get(id)
  assert.ok(row.claimed_by, '最终应有且仅有一个认领者')
  checkBus._internal.close()
})

test('并发: 跨进程两实例同时 confirm 同一候选 → 一成一 E_STATE（WAL 串行化）', async () => {
  const dir = tmpDir()
  const dataDir = path.join(dir, 'data')
  fs.mkdirSync(dataDir, { recursive: true })
  const busPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../sec-domain-bus/index.js')
  const vulnPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../index.js')
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const execFileP = promisify(execFile)
  const busOpts = { dataDir, dbFile: path.join(dir, 'asset-graph.db'), aliasesFile: path.join(dir, 'bus.aliases.yaml'), auditFile: path.join(dir, 'audit.jsonl'), eventsDir: path.join(dir, 'events'), sidecars: false, startDispatcherTimer: false }

  const seedBus = createBus(busOpts)
  seedBus.registry.register(buildVulnDomain({ dataDir, dispatch: (d, v, a, c) => seedBus.dispatch(d, v, a, c) }))
  // INV-2 证据前置：两进程各自的 evidence 引用必须真实存在
  for (const run of ['run_a', 'run_b']) {
    fs.mkdirSync(path.join(dataDir, 'results', run), { recursive: true })
    fs.writeFileSync(path.join(dataDir, 'results', run, 'meta.json'), '{}')
  }
  const sig = await seedBus.dispatch('vuln', 'register_signal', { title: '并发确认测试信号一二三四', severity: 'high', host: 'cd.example.com', url: 'https://cd.example.com/x', evidence: 'run_test_20260906_000000', reproduction_steps: 'a', impact: 'b' }, { actor: 'model' })
  const id = sig.data.id
  seedBus._internal.close()

  const workerSrc = (evidence) => `
import { createBus } from ${JSON.stringify('file://' + busPath)}
import { buildVulnDomain } from ${JSON.stringify('file://' + vulnPath)}
const path = await import('node:path')
const dataDir = ${JSON.stringify(dataDir)}
const dir = ${JSON.stringify(dir)}
const bus = createBus({ dataDir, dbFile: path.join(dir, 'asset-graph.db'), aliasesFile: path.join(dir, 'bus.aliases.yaml'), auditFile: path.join(dir, 'audit.jsonl'), eventsDir: path.join(dir, 'events'), sidecars: false, startDispatcherTimer: false })
bus.registry.register(buildVulnDomain({ dataDir, dispatch: (d, v, a, c) => bus.dispatch(d, v, a, c) }))
const env = await bus.dispatch('vuln', 'confirm', { finding_id: ${id}, evidence: ${JSON.stringify(evidence)}, review: ${JSON.stringify(independentReview)} }, { actor: 'dashboard', operator: 'fixture-reviewer' })
process.stdout.write(JSON.stringify({ ok: env.ok, code: env.error ? env.error.code : null }))
bus._internal.close()
`
  const results = await Promise.all([
    execFileP(process.execPath, ['--input-type=module', '-e', workerSrc('run_a')], { timeout: 30000 }),
    execFileP(process.execPath, ['--input-type=module', '-e', workerSrc('run_b')], { timeout: 30000 }),
  ])
  const parsed = results.map((r) => JSON.parse(r.stdout.trim()))
  assert.equal(parsed.filter((r) => r.ok).length, 1, `应恰一进程确认成功: ${JSON.stringify(parsed)}`)
  assert.ok(parsed.some((r) => !r.ok && r.code === 'E_STATE'), `另一进程应 E_STATE: ${JSON.stringify(parsed)}`)
  const checkBus = createBus(busOpts)
  const row = checkBus._internal.db().prepare('SELECT status, noise FROM findings WHERE id=?').get(id)
  assert.equal(row.status, 'confirmed')
  assert.equal(row.noise, 0)
  checkBus._internal.close()
})

// ---------------------------------------------------------------------------
// 8. 事件载荷（payload 符合 §1.5 schema / 不含证据全文 / ≤2KB / redact）
// ---------------------------------------------------------------------------

test('事件载荷: signal.confirmed payload 含 from/evidence_ref/fgs_node_id、不含 evidence 全文、≤2KB', async () => {
  const { dir, bus } = makeEnv()
  const sig = await seedSignal(bus)
  const id = sig.data.id
  await bus.dispatch('vuln', 'attach_fgs', { finding_id: id, fgs_node_id: 7 }, { actor: 'reactor' })
  const r = await reviewedConfirm(bus, { finding_id: id, evidence: 'run_test_20260906_000000 + 完整复现脚本与响应报文', note: '确认' }, { actor: 'model' })
  assert.equal(r.ok, true)
  const out = bus._internal.db().prepare('SELECT payload FROM event_outbox WHERE event_id=?').get(r.event_ids[0])
  const envelope = JSON.parse(out.payload)
  assert.equal(envelope.name, 'vuln.signal.confirmed')
  assert.equal(envelope.domain, 'vuln')
  assert.equal(envelope.cause.cmd, 'confirm')
  assert.deepEqual(envelope.payload.from, { status: 'new', noise: 0 })
  assert.equal(envelope.payload.evidence_ref, 'run_test_20260906_000000')
  assert.equal(envelope.payload.fgs_node_id, 7)
  assert.equal(envelope.payload.confidence, 'confirmed')
  assert.ok(!JSON.stringify(envelope.payload).includes('完整复现脚本'), 'payload 不含 evidence 全文')
  assert.ok(Buffer.byteLength(JSON.stringify(envelope.payload), 'utf8') <= 2048, `payload 应 ≤2KB: ${Buffer.byteLength(JSON.stringify(envelope.payload), 'utf8')}`)
})

test('事件载荷: 全部事件名=全名 domain.event、envelope 含 actor/session_id/cause', async () => {
  const { dir, bus } = makeEnv()
  await seedSignal(bus, { title: '事件载荷测试信号一二三四五', host: 'ev.example.com' })
  await bus._internal.dispatcherTick()
  const events = readEvents(dir)
  assert.ok(events.length >= 1)
  for (const ev of events) {
    assert.match(ev.name, /^vuln\./)
    assert.equal(ev.domain, 'vuln')
    assert.ok(ev.ts)
    assert.ok(ev.actor)
    assert.ok(ev.id.startsWith('evt_'))
  }
})

// ---------------------------------------------------------------------------
// 9. 查询口径（rows.length==total 同 where / visibility 默认 / claim_state 默认 /
//     stats.candidate.pending == candidates(all).total）
// ---------------------------------------------------------------------------

test('查询口径: vuln_list 三 visibility 默认值 + rows==total 同 where 构造器', async () => {
  const { bus } = makeEnv()
  const sig = await seedSignal(bus)
  await seedCandidate(bus)
  const qSignal = await bus.query('vuln', 'list', {}, { actor: 'model' })
  assert.equal(qSignal.ok, true)
  assert.equal(qSignal.rows.length, 1)
  assert.equal(qSignal.total, 1, '默认 visibility=signal 只含信号行')
  const qCandidate = await bus.query('vuln', 'list', { visibility: 'candidate' }, { actor: 'model' })
  assert.equal(qCandidate.rows.length, 1)
  assert.equal(qCandidate.total, 1)
  const qAll = await bus.query('vuln', 'list', { visibility: 'all' }, { actor: 'model' })
  assert.equal(qAll.total, 2)
  assert.equal(qAll.rows.length, 2)
  // 分页边界：offset 越界 → 空 rows 且 total 不变
  const qPage = await bus.query('vuln', 'list', { visibility: 'all', limit: 1, offset: 99 }, { actor: 'model' })
  assert.equal(qPage.rows.length, 0)
  assert.equal(qPage.total, 2)
})

test('查询口径: vuln_candidates claim_state 默认 available + pool 摘要同口径', async () => {
  const { bus } = makeEnv()
  const c1 = await seedCandidate(bus)
  const c2 = await seedCandidate(bus, { title: 'b2.example.com 被动审计候选：xray', host: 'b2.example.com' })
  await bus.dispatch('vuln', 'claim', { finding_id: c1.data.id }, { actor: 'model', session_id: 'sess_a' })
  const q = await bus.query('vuln', 'candidates', {}, { actor: 'model' })
  assert.equal(q.ok, true)
  assert.equal(q.rows.length, 1, '默认 available=未认领∪stale')
  assert.equal(q.pool.pending, 1)
  assert.equal(q.pool.claimed, 1)
  const qAll = await bus.query('vuln', 'candidates', { claim_state: 'all' }, { actor: 'model' })
  assert.equal(qAll.total, 2)
})

test('查询口径: vuln_stats.candidate.pending == vuln_candidates(all).total（KPI 唯一口径）', async () => {
  const { bus } = makeEnv()
  await seedCandidate(bus)
  await seedCandidate(bus, { title: 'b3.example.com 被动审计候选：xray', host: 'b3.example.com' })
  const stats = await bus.query('vuln', 'stats', {}, { actor: 'model' })
  const cands = await bus.query('vuln', 'candidates', { claim_state: 'all' }, { actor: 'model' })
  assert.equal(stats.data.candidate.pending, cands.total)
  assert.equal(stats.data.terminal_in_pool, 0)
  assert.deepEqual(stats.data.sync, { pending: 0, failed: 0, last_synced_at: null })
})

// ---------------------------------------------------------------------------
// 10. 核心回归（v4 缺陷档案：确认候选后候选不消减——2026-09-06 实证缺陷）
// ---------------------------------------------------------------------------

test('核心回归: confirm 候选后 candidate.pending −1 ∧ signal.total +1 ∧ 行进 vuln_list(signal)', async () => {
  const { bus } = makeEnv()
  await seedCandidate(bus)
  const before = await bus.query('vuln', 'stats', {}, { actor: 'model' })
  assert.equal(before.data.candidate.pending, 1)
  assert.equal(before.data.signal.total, 0)
  const cand = await bus.query('vuln', 'candidates', { claim_state: 'all' }, { actor: 'model' })
  const id = cand.rows[0].id
  const r = await reviewedConfirm(bus, { finding_id: id, evidence: 'run_test_20260906_000000' }, { actor: 'model' })
  assert.equal(r.ok, true)
  const after = await bus.query('vuln', 'stats', {}, { actor: 'model' })
  assert.equal(after.data.candidate.pending, 0, '确认后候选计数 −1（根治 2026-09-06 僵君缺陷）')
  assert.equal(after.data.signal.total, 1, '信号计数 +1')
  const sigList = await bus.query('vuln', 'list', { visibility: 'signal' }, { actor: 'model' })
  assert.equal(sigList.rows.length, 1)
  assert.equal(sigList.rows[0].id, id)
})

// ---------------------------------------------------------------------------
// 11. 订阅（exec.run.completed → onParserProposal → C2 机器直灌）
// ---------------------------------------------------------------------------

test('订阅: exec.run.completed proposal → register_candidate（actor=script, source=parser:tool）', async () => {
  const { bus } = makeEnv()
  const env = {
    id: 'evt_fake_1',
    domain: 'exec', name: 'exec.run.completed', ts: Date.now(),
    actor: 'system', session_id: null,
    cause: { cmd: 'run_cli', idempotency_key: null },
    payload: { run_id: 'run_rc_20260906_041532', tool: 'nuclei', parse_proposal: { findings: [{ title: '目标站被动审计候选：xray', severity: 'medium', host: 'sub.example.com', url: 'https://sub.example.com/x' }] } },
  }
  const busIdx = bus._internal
  const sub = busIdx.subscribers.find((s) => s.pattern === 'exec.run.completed')
  assert.ok(sub, 'exec.run.completed 订阅应在册')
  const res = await sub.handler(env)
  assert.equal(res.ok, true)
  assert.equal(res.data.registered, 1)
  const row = bus._internal.db().prepare("SELECT * FROM findings WHERE host='sub.example.com'").get()
  assert.ok(row)
  assert.equal(row.source, 'parser:nuclei')
  assert.equal(row.noise, 1)
})

// ---------------------------------------------------------------------------
// 12. 总线集成（bus_status 展示 vuln 域 registered:true；域 handler 挂载检查）
// ---------------------------------------------------------------------------

test('总线集成: bus_status vuln registered:true + capabilities 全 full + 订阅在册', async () => {
  const { bus } = makeEnv()
  const st = await bus.query('bus', 'status', {}, { actor: 'dashboard' })
  assert.equal(st.ok, true)
  const vuln = st.data.domains.find((d) => d.domain === 'vuln')
  assert.ok(vuln)
  assert.equal(vuln.registered, true)
  assert.equal(vuln.backend, 'sqlite-local')
  assert.equal(vuln.capabilities.full, Object.keys(VULN_MANIFEST.commands).length)
  assert.equal(vuln.capabilities.unsupported, 0)
  assert.equal(vuln.commands, Object.keys(VULN_MANIFEST.commands).length)
  assert.equal(vuln.queries, Object.keys(VULN_MANIFEST.queries).length)
  assert.ok(st.data.subscribers.some((s) => s.pattern === 'exec.run.completed' && s.source === 'vuln'))
})

test('总线集成: 后端共享总线连接（同一 DatabaseSync → 同一 WAL 库文件）', () => {
  const { bus, domain } = makeEnv()
  const repoA = domain.backend.factory(bus._internal.db())
  const repoB = domain.backend.factory(bus._internal.db())
  assert.equal(repoA, repoB, '同连接应缓存同一仓库实例')
})

// ---------------------------------------------------------------------------
// 13. 兼容别名端到端（1.3，02-vuln §3.2：真实域 + 真实库过全管线）
// ---------------------------------------------------------------------------

const V1_ALIASES = {
  aliases: { submission_draft: 'report_draft_submission' },
  dispatch_aliases: {
    finding_add: { router: 'finding_add_router', domain: 'vuln' },
    finding_query: { router: 'query_visibility_router', domain: 'vuln' },
    finding_update: { router: 'status_router', domain: 'vuln' },
  },
}

test('别名: finding_add model 完整五要素 → register_signal；同指纹异参 → E_IDEMPOTENT_CONFLICT（无 v4 dup 形状）', async () => {
  const { dir, bus } = makeEnv({ aliasesDoc: V1_ALIASES })
  const r1 = await bus.dispatch('', 'finding_add', {
    title: '别名登记完整信号：命令注入可执行系统命令', severity: 'high', host: 'alias1.example.com', url: 'https://alias1.example.com/admin',
    evidence: 'run_test_20260906_000000', reproduction_steps: '访问并重放命令拼接参数', impact: '任意命令执行',
  }, { actor: 'model', session_id: 'sess_alias' })
  assert.equal(r1.ok, true)
  assert.equal(r1.cmd, 'register_signal')
  assert.equal(r1.data.noise, false)
  const r2 = await bus.dispatch('', 'finding_add', {
    title: '别名登记完整信号：命令注入可执行系统命令', severity: 'medium', host: 'alias1.example.com', url: 'https://alias1.example.com/admin',
    evidence: 'run_test_20260906_000000', reproduction_steps: '另一套复现', impact: '任意命令执行',
  }, { actor: 'model', session_id: 'sess_alias' })
  assert.equal(r2.ok, false, '同幂等键异参执行严格冲突（兼容 v4 dup 形状已删除）')
  assert.equal(r2.error.code, 'E_IDEMPOTENT_CONFLICT')
  const audit = readAudit(dir)
  assert.ok(audit.some((a) => a.kind === 'deprecated_use' && a.alias === 'finding_add'))
})

test('别名: finding_add webhook → register_candidate；model+info → 降级候选（actor 旁路）', async () => {
  const { dir, bus } = makeEnv({ aliasesDoc: V1_ALIASES })
  const w = await bus.dispatch('', 'finding_add', { title: 'xray webhook 候选', severity: 'medium', host: 'alias2.example.com', source: 'xray-webhook' }, { actor: 'webhook', session_id: 'wh1' })
  assert.equal(w.ok, true)
  assert.equal(w.cmd, 'register_candidate')
  assert.equal(w.data.noise, true)
  const inf = await bus.dispatch('', 'finding_add', { title: 'info 侦察副产物候选', severity: 'info', host: 'alias3.example.com', source: 'agent' }, { actor: 'model', session_id: 'sess_i' })
  assert.equal(inf.ok, true, 'severity=info 保留 v4 行为降级候选')
  assert.equal(inf.cmd, 'register_candidate')
  assert.equal(inf.data.noise, true)
  const audit = readAudit(dir)
  assert.ok(audit.some((a) => a.kind === 'command' && a.cmd === 'register_candidate' && a.actor === 'model' && a.via_alias === 'finding_add'), 'info 降级写操作审计 actor 真实 + via_alias 追踪')
})

test('别名: finding_update confirmed 缺 evidence → E_EVIDENCE_REQUIRED；accepted → submit(vendor_status=accepted)', async () => {
  const { dir, bus } = makeEnv({ aliasesDoc: V1_ALIASES })
  const cand = await seedCandidate(bus, { title: 'finding_update 别名候选', host: 'fu1.example.com' })
  assert.equal(cand.ok, true)
  const id = cand.data.id
  const noEv = await bus.dispatch('', 'finding_update', { finding_id: id, status: 'confirmed' }, { actor: 'dashboard' })
  assert.equal(noEv.ok, false)
  assert.equal(noEv.error.code, 'E_EVIDENCE_REQUIRED', 'confirm 别名缺 evidence 收紧')
  assert.ok(noEv.error.hint)
  const withEv = await bus.dispatch('', 'finding_update', { finding_id: id, status: 'confirmed', evidence: 'run_test_20260906_000000', review: independentReview }, { actor: 'dashboard', operator: 'fixture-reviewer' })
  assert.equal(withEv.ok, true)
  assert.equal(withEv.data.status, 'confirmed')
  const sub = await bus.dispatch('', 'finding_update', { finding_id: id, status: 'submitted' }, { actor: 'dashboard' })
  assert.equal(sub.ok, true)
  assert.equal(sub.data.status, 'submitted')
  const acc = await bus.dispatch('', 'finding_update', { finding_id: id, status: 'accepted', bounty: 500 }, { actor: 'dashboard' })
  assert.equal(acc.ok, true)
  assert.equal(acc.cmd, 'submit')
  assert.equal(acc.data.status, 'accepted')
  const row = bus._internal.db().prepare('SELECT * FROM findings WHERE id=?').get(id)
  assert.equal(row.vendor_status, 'accepted')
  assert.equal(row.bounty, 500)
})

test('别名: finding_update dup 缺 dup_of → E_VULN_DUP_TARGET_REQUIRED（无自动填充/放宽）', async () => {
  const { bus } = makeEnv({ aliasesDoc: V1_ALIASES })
  await seedSignal(bus, { title: '同目标既有信号：SQLi 注入', host: 'dupfill.example.com', vuln_type: 'SQLi', severity: 'high' })
  const cand = await seedCandidate(bus, { title: '同目标重复候选', host: 'dupfill.example.com', severity: 'medium' })
  const r = await bus.dispatch('', 'finding_update', { finding_id: cand.data.id, status: 'dup', reason: '重复登记：同 host 同类型已有信号行' }, { actor: 'dashboard' })
  assert.equal(r.ok, false, 'v5 严格口径：dup 必须显式给 dup_of（兼容放宽已删除）')
  assert.equal(r.error.code, 'E_VULN_DUP_TARGET_REQUIRED')
})

test('别名: finding_query → vuln_list（noise=1→candidate / include_noise→all 真实过滤）', async () => {
  const { dir, bus } = makeEnv({ aliasesDoc: V1_ALIASES })
  await seedSignal(bus, { title: '别名查询信号：反射 XSS', host: 'fq1.example.com' })
  await seedCandidate(bus, { title: '别名查询候选', host: 'fq2.example.com' })
  const qSig = await bus.query('', 'finding_query', {}, { actor: 'model' })
  assert.equal(qSig.ok, true)
  assert.equal(qSig.query, 'list')
  assert.equal(qSig.total, 1, '默认只信号面')
  const qAll = await bus.query('', 'finding_query', { include_noise: true }, { actor: 'model' })
  assert.equal(qAll.total, 2, 'include_noise=true → visibility=all')
  const qCand = await bus.query('', 'finding_query', { noise: '1' }, { actor: 'model' })
  assert.equal(qCand.total, 1, "noise='1' → visibility=candidate")
  assert.equal(qCand.rows[0].noise, 1)
  const audit = readAudit(dir)
  assert.ok(audit.some((a) => a.kind === 'deprecated_use' && a.alias === 'finding_query'))
})

test('别名: submission_draft 目标域未注册 → ToolProjector 跳过 / dispatch E_BUS_DOMAIN_UNKNOWN（v4 工具仍在无断流）', async () => {
  const { dir, bus } = makeEnv({ aliasesDoc: V1_ALIASES })
  const r = await bus.dispatch('', 'submission_draft', { finding_id: 1 }, { actor: 'model' })
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'E_BUS_DOMAIN_UNKNOWN', 'report 域未注册（Phase 2），别名目标悬空报未知域')
  const st = await bus.query('bus', 'status', {}, { actor: 'dashboard' })
  assert.equal(st.data.bus.aliases.count, 4, 'bus_status 别名计数含静态+分派别名')
})

// ---------------------------------------------------------------------------
// L1（学习专项 §3.3）：vuln_evidence_attach——可信 exec 清单挂载证据
// ---------------------------------------------------------------------------

// 手工构造"exec_evidence_publish 产物"（清单字段序与 exec 域发布实现一致）
function publishFixture(dataDir, runId, files, programId = null) {
  const dir = path.join(dataDir, 'results', runId)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ run_id: runId, program_id: programId }))
  const entries = []
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content)
    entries.push({ path: rel, size: Buffer.byteLength(content), sha256: crypto.createHash('sha256').update(content).digest('hex') })
  }
  entries.sort((a, b) => a.path.localeCompare(b.path))
  const manifest = { schema_version: 1, run_id: runId, program_id: programId, published_at: Date.now(), note: null, files: entries }
  manifest.digest = crypto.createHash('sha256').update(JSON.stringify(manifest)).digest('hex')
  fs.writeFileSync(path.join(dir, 'evidence-manifest.json'), JSON.stringify(manifest, null, 1) + '\n')
  return manifest
}

test('L1 C12: evidence_attach happy path——复制进 evidence/<id>/<run>/ + 证据链 + 事件 + 幂等回放', async () => {
  const { dir, dataDir, bus } = makeEnv()
  const runId = 'rpubl1test00001'
  publishFixture(dataDir, runId, { 'poc.txt': 'PoC 请求与响应', 'shots/a.txt': '对照证据' }, 'test-src')
  const sig = await seedSignal(bus, { evidence: runId })
  assert.equal(sig.ok, true, sig.error?.message)
  const r = await bus.dispatch('vuln', 'evidence_attach', { finding_id: sig.data.id, evidence_ref: runId, note: 'L1 契约测试挂载' }, { actor: 'model' })
  assert.equal(r.ok, true, r.error?.message)
  assert.equal(r.data.files, 2)
  assert.equal(r.data.evidence_ref, runId)
  for (const rel of ['poc.txt', 'shots/a.txt']) {
    const dest = path.join(dataDir, 'evidence', String(sig.data.id), runId, rel)
    assert.ok(fs.existsSync(dest), `副本落盘: ${rel}`)
  }
  const row = bus._internal.db().prepare('SELECT evidence FROM findings WHERE id=?').get(sig.data.id)
  assert.match(row.evidence, /evidence attached: run_id:/)
  assert.ok(readEvents(dir).some((e) => e.name === 'vuln.evidence.attached' && e.payload.finding_id === sig.data.id))
  // 幂等回放
  const again = await bus.dispatch('vuln', 'evidence_attach', { finding_id: sig.data.id, evidence_ref: runId, note: 'L1 契约测试挂载' }, { actor: 'model' })
  assert.equal(again.ok, true)
  assert.equal(again.replay, true)
})

test('L1 C12: evidence_attach 拒绝未发布 run / 篡改文件 / 非法清单路径 / 跨 Program / webhook actor', async () => {
  const { dataDir, bus } = makeEnv()
  const sig = await seedSignal(bus)
  const fid = sig.data.id
  // 未发布（meta.json 有、清单无）
  const runId0 = 'runpubnotl1test00'
  fs.mkdirSync(path.join(dataDir, 'results', runId0), { recursive: true })
  fs.writeFileSync(path.join(dataDir, 'results', runId0, 'meta.json'), JSON.stringify({ run_id: runId0 }))
  const unpub = await bus.dispatch('vuln', 'evidence_attach', { finding_id: fid, evidence_ref: runId0 }, { actor: 'model' })
  assert.equal(unpub.ok, false)
  assert.equal(unpub.error.code, 'E_EVIDENCE_REQUIRED')
  // 篡改：发布后改动文件 → 哈希不符
  const runId = 'rtamper0l1test01'
  publishFixture(dataDir, runId, { 'poc.txt': '原始证据' })
  fs.writeFileSync(path.join(dataDir, 'results', runId, 'poc.txt'), '被篡改的内容')
  const tampered = await bus.dispatch('vuln', 'evidence_attach', { finding_id: fid, evidence_ref: runId }, { actor: 'model' })
  assert.equal(tampered.ok, false)
  assert.equal(tampered.error.code, 'E_VULN_EVIDENCE_TAMPERED')
  // 清单内非法路径（digest 合法但路径穿越）
  const runId2 = 'rpathl1test00002'
  const dir2 = path.join(dataDir, 'results', runId2)
  fs.mkdirSync(dir2, { recursive: true })
  fs.writeFileSync(path.join(dir2, 'meta.json'), JSON.stringify({ run_id: runId2 }))
  const bad = { schema_version: 1, run_id: runId2, program_id: null, published_at: Date.now(), note: null, files: [{ path: '../escape.txt', size: 1, sha256: 'x'.repeat(64) }] }
  bad.digest = crypto.createHash('sha256').update(JSON.stringify(bad)).digest('hex')
  fs.writeFileSync(path.join(dir2, 'evidence-manifest.json'), JSON.stringify(bad))
  const traversal = await bus.dispatch('vuln', 'evidence_attach', { finding_id: fid, evidence_ref: runId2 }, { actor: 'model' })
  assert.equal(traversal.ok, false)
  assert.equal(traversal.error.code, 'E_VULN_EVIDENCE_TAMPERED')
  // 跨 Program：finding.program_id=test-src，证据 run 属 other-prog
  bus._internal.db().prepare('UPDATE findings SET program_id=? WHERE id=?').run('test-src', fid)
  const runId3 = 'rcrossp0l1test003'
  publishFixture(dataDir, runId3, { 'poc.txt': '跨项目证据' }, 'other-prog')
  const cross = await bus.dispatch('vuln', 'evidence_attach', { finding_id: fid, evidence_ref: runId3 }, { actor: 'model' })
  assert.equal(cross.ok, false)
  assert.equal(cross.error.code, 'E_VULN_PROGRAM_MISMATCH')
  // actor 闸
  const denied = await bus.dispatch('vuln', 'evidence_attach', { finding_id: fid, evidence_ref: runId3 }, { actor: 'webhook' })
  assert.equal(denied.ok, false)
  assert.equal(denied.error.code, 'E_ACTOR_FORBIDDEN')
})

// ---- M10 回归：dedup_check host/vuln_type 至少其一（禁止空条件全表扫描）----
test('M10: dedup_check 既无 host 也无 vuln_type → E_SCHEMA', async () => {
  const { bus } = makeEnv()
  const r = await bus.query('vuln', 'dedup_check', {}, { actor: 'model' })
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'E_SCHEMA')
})

// ---- 产出闭环：submission_queue 列 confirmed 未提交；submit 回写 remote_id 后出队 ----
test('产出闭环: submission_queue 列 confirmed 未提交 → submit 回写 remote_id 后出队', async () => {
  const { bus } = makeEnv()
  const sig = await seedSignal(bus)
  await reviewedConfirm(bus, { finding_id: sig.data.id, evidence: 'run_test_20260906_000000' }, { actor: 'model' })
  const q1 = await bus.query('vuln', 'submission_queue', {}, { actor: 'model' })
  assert.equal(q1.ok, true)
  assert.equal(q1.total, 1)
  assert.equal(q1.rows[0].id, sig.data.id)
  assert.ok(typeof q1.rows[0].age_days === 'number')
  await bus.dispatch('vuln', 'submit', { finding_id: sig.data.id, platform: '测试SRC', submission_url: 'https://src.example/ticket/1', remote_id: 'SRC-123' }, { actor: 'model' })
  const row = bus._internal.db().prepare('SELECT remote_id FROM findings WHERE id=?').get(sig.data.id)
  assert.equal(row.remote_id, 'SRC-123')
  const q2 = await bus.query('vuln', 'submission_queue', {}, { actor: 'model' })
  assert.equal(q2.total, 0)
})

test('产出闭环: vuln_stats 暴露 confirmed_unsubmitted', async () => {
  const { bus } = makeEnv()
  const sig = await seedSignal(bus)
  await reviewedConfirm(bus, { finding_id: sig.data.id, evidence: 'run_test_20260906_000000' }, { actor: 'model' })
  const s = await bus.query('vuln', 'stats', {}, { actor: 'model' })
  assert.equal(s.ok, true)
  assert.equal(s.data.signal.confirmed_unsubmitted, 1)
})

// ---- 数据治理：候选池 TTL——超期未消化候选置 ignored 出池 ----
test('数据治理: expire_candidates 将超期候选出池', async () => {
  const { bus } = makeEnv()
  const cand = await seedCandidate(bus)
  assert.equal(cand.data.noise, true)
  bus._internal.db().prepare('UPDATE findings SET created_at = ?, updated_at = ? WHERE id = ?').run(Date.now() - 30 * 86400000, Date.now() - 30 * 86400000, cand.data.id)
  const r = await bus.dispatch('vuln', 'expire_candidates', { ttl_days: 14 }, { actor: 'system' })
  assert.equal(r.ok, true)
  assert.equal(r.data.expired, 1)
  const row = bus._internal.db().prepare('SELECT status FROM findings WHERE id=?').get(cand.data.id)
  assert.equal(row.status, 'ignored')
})

test('27 E17: automatic holds reopen at expiry or changed conditions, preserving technical and manual decisions', async t => {
  await withEnv({ SEC_VULN_SOURCE_DAILY_QUOTA: '1' }, async () => {
    const { bus } = makeEnv()
    t.after(() => bus._internal.close())
    await seedCandidate(bus, { host: 'first.example.com' })
    const args = { host: 'held.example.com', detector_version: 'v1', applicability_key: 'GET:anonymous' }
    const held = await seedCandidate(bus, args)
    assert.equal(held.data.suppressed, true)
    const db = bus._internal.db()
    const row = () => db.prepare('SELECT * FROM findings WHERE id=?').get(held.data.id)
    assert.equal(row().queue_hold_reason, 'source_quota')
    assert.ok(row().queue_hold_until > Date.now())
    assert.equal((await bus.query('vuln', 'get', { id: held.data.id }, { actor: 'dashboard' })).data.technical_state.verdict, 'unknown')
    const changed = await seedCandidate(bus, { ...args, detector_version: 'v2', evidence: 'new detector observation' })
    assert.equal(changed.data.id, held.data.id)
    assert.equal(changed.data.reopened, true)
    assert.equal(row().status, 'new')
    assert.ok(row().evidence.includes('"detector_version":"v1"'))
    assert.ok(row().evidence.includes('new detector observation'))
    const other = await seedCandidate(bus, { host: 'later.example.com' })
    db.prepare('UPDATE findings SET queue_hold_until=? WHERE id=?').run(Date.now() - 1, other.data.id)
    const manual = await seedCandidate(bus, { host: 'manual.example.com' })
    db.prepare("UPDATE findings SET queue_hold_reason=NULL,queue_hold_until=? WHERE id=?").run(Date.now() - 1, manual.data.id)
    const tick = await bus.dispatch('vuln', 'expire_candidates', {}, { actor: 'system' })
    assert.equal(tick.ok, true, tick.error?.message)
    assert.equal(tick.data.reopened, 1)
    assert.equal(db.prepare('SELECT status FROM findings WHERE id=?').get(other.data.id).status, 'new')
    assert.equal(db.prepare('SELECT status FROM findings WHERE id=?').get(manual.data.id).status, 'ignored')
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vuln_technical_verdicts').get().n, 0)
    assert.equal((await bus.dispatch('vuln', 'expire_candidates', {}, { actor: 'system' })).data.reopened, 0)
  })
})

// ---- 跨源去重：external_id 相同 → dup，不重复建行 ----
test('跨源去重: 相同 external_id 的候选登记为 dup', async () => {
  const { bus } = makeEnv()
  const a = await bus.dispatch('vuln', 'register_candidate', { title: 'a.example.com 外部导入候选', severity: 'medium', host: 'a.example.com', source: 'cyberstrikeai', external_id: 'EXT-1' }, { actor: 'script' })
  assert.equal(a.ok, true)
  assert.equal(a.data.dup, false)
  const b = await bus.dispatch('vuln', 'register_candidate', { title: 'a.example.com 同外部 id 不同标题', severity: 'high', host: 'a.example.com', source: 'vuln-pipeline', external_id: 'EXT-1' }, { actor: 'script' })
  assert.equal(b.ok, true)
  assert.equal(b.data.dup, true)
  assert.equal(b.data.id, a.data.id)
  assert.equal(b.data.dedup_reason, 'external_id')
})

// ---------------------------------------------------------------------------
// 43 号补丁（P0）：噪声类别学习与自动抑制 / 归因绑定 / 存量 sweep
// ---------------------------------------------------------------------------

function withEnv(pairs, fn) {
  const saved = {}
  for (const [k, v] of Object.entries(pairs)) { saved[k] = process.env[k]; process.env[k] = v }
  return Promise.resolve(fn()).finally(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })
}

test('27 E14: unversioned category totals cannot suppress a new observation', async () => {
  await withEnv({ SEC_VULN_NOISE_SUPPRESS_MIN: '3', SEC_VULN_NOISE_SUPPRESS_RATE: '0.6' }, async () => {
    const { bus, dir } = makeEnv()
    const ids = []
    for (let i = 0; i < 3; i++) {
      const r = await bus.dispatch('vuln', 'register_candidate', { title: 'Detect SSL Certificate Issuer', severity: 'info', host: `n${i}.example.com`, source: 'parser:nuclei' }, { actor: 'script' })
      assert.equal(r.ok, true)
      assert.notEqual(r.data.status, 'ignored', '阈值前正常入池')
      ids.push(r.data.id)
    }
    for (const id of ids) {
      const rej = await reviewedReject(bus, { finding_id: id, verdict: 'false_positive', reason: '完整独立对照反驳此条模板观察（43 号补丁夹具）' })
      assert.equal(rej.ok, true)
    }
    const next = await bus.dispatch('vuln', 'register_candidate', { title: 'Detect SSL Certificate Issuer', severity: 'info', host: 'n9.example.com', source: 'parser:nuclei' }, { actor: 'script' })
    assert.equal(next.ok, true)
    assert.equal(next.data.suppressed, false, '缺版本/条件不能跨大类抑制')
    assert.equal(next.data.suppress_reason, null)
    assert.equal(next.data.status, 'new')
    const got = await bus.query('vuln', 'get', { id: next.data.id }, { actor: 'model' })
    assert.equal(got.data.status, 'new')
    assert.ok(readEvents(dir).some((e) => e.name === 'vuln.candidate.registered'))
  })
})

test('27 E14: suppression separates Program/version/conditions and deduplicates evidence with a bounded history', async t => {
  await withEnv({ SEC_VULN_NOISE_SUPPRESS_MIN: '3', SEC_VULN_NOISE_SUPPRESS_RATE: '0.8' }, async () => {
    const { bus, dataDir } = makeEnv()
    t.after(() => bus._internal.close())
    const context = { program_id: 'test-src', detector_version: 'template-sha256-v1', applicability_key: 'GET:private-object:authenticated' }
    const ids = []
    for (let i = 0; i < 4; i++) {
      const cand = await seedCandidate(bus, { ...context, title: 'Versioned Template', source: 'parser:nuclei', host: `v${i}.example.com`, url: `https://v${i}.example.com/item` })
      assert.equal(cand.ok, true, cand.error?.message)
      ids.push(cand.data.id)
    }
    for (let i = 0; i < ids.length; i++) {
      const ref = `run_independent_${Math.min(i, 2)}`
      fs.mkdirSync(path.join(dataDir, 'results', ref), { recursive: true })
      fs.writeFileSync(path.join(dataDir, 'results', ref, 'meta.json'), JSON.stringify({ fixture: Math.min(i, 2) }))
      const rejected = await reviewedReject(bus, { finding_id: ids[i], verdict: 'false_positive', evidence: ref, reason: '独立正常和异常对照证明本次观察的技术主张不成立' })
      assert.equal(rejected.ok, true, rejected.error?.message)
    }
    const repo = createVulnSqliteBackend().factory(bus._internal.db())
    const decide = extra => noiseCategoryDecision(repo, 'parser:nuclei', 'Versioned Template', { ...context, ...extra })
    assert.equal(decide().sample, 3, 'same original reference counts once')
    assert.equal(decide().suppress, true)
    assert.equal(decide({ detector_version: 'template-sha256-v2' }).sample, 0)
    assert.equal(decide({ applicability_key: 'POST:private-object:authenticated' }).suppress, false)
    assert.equal(decide({ program_id: 'other-src' }).suppress, false)
    assert.equal(decide({ now: Date.now() + 31 * 86400000 }).suppress, false)
    const same = await seedCandidate(bus, { ...context, title: 'Versioned Template', source: 'parser:nuclei', host: 'next.example.com' })
    assert.equal(same.ok, true, same.error?.message)
    assert.equal(same.data.suppress_reason, 'category_noise')
    const changed = await seedCandidate(bus, { ...context, detector_version: 'v2', title: 'Versioned Template', source: 'parser:nuclei', host: 'changed.example.com' })
    assert.equal(changed.data.suppressed, false)
    assert.equal(bus._internal.db().prepare('SELECT detector_version FROM findings WHERE id=?').get(changed.data.id).detector_version, 'v2')
    let explorationHost
    for (let i = 0; i < 1000; i++) {
      const host = `explore${i}.example.com`
      const fp = crypto.createHash('sha1').update(JSON.stringify(['observation-v2', 'test-src', host, 'Versioned Template', 'https://a.example.com/login', ''])).digest('hex')
      if (parseInt(fp.slice(0, 8), 16) % 10 === 0) { explorationHost = host; break }
    }
    assert.ok(explorationHost)
    const explored = await seedCandidate(bus, { ...context, title: 'Versioned Template', source: 'parser:nuclei', host: explorationHost })
    assert.equal(explored.data.exploration, true)
    assert.equal(explored.data.status, 'new')
    const swept = await bus.dispatch('vuln', 'candidates_sweep', { min_total: 3 }, { actor: 'dashboard' })
    assert.equal(swept.ok, true, swept.error?.message)
    assert.equal(bus._internal.db().prepare('SELECT status FROM findings WHERE id=?').get(explored.data.id).status, 'new', 'sweep preserves exploration sample')
  })
})

test('43 P0: 来源日配额——超出即落 ignored（reason=source_quota）', async () => {
  await withEnv({ SEC_VULN_SOURCE_DAILY_QUOTA: '2' }, async () => {
    const { bus } = makeEnv()
    const a = await bus.dispatch('vuln', 'register_candidate', { title: '配额模板 A', severity: 'info', host: 'q1.example.com', source: 'webhook-quota' }, { actor: 'webhook' })
    const b = await bus.dispatch('vuln', 'register_candidate', { title: '配额模板 B', severity: 'info', host: 'q2.example.com', source: 'webhook-quota' }, { actor: 'webhook' })
    const c = await bus.dispatch('vuln', 'register_candidate', { title: '配额模板 C', severity: 'info', host: 'q3.example.com', source: 'webhook-quota' }, { actor: 'webhook' })
    assert.equal(a.data.status, 'new')
    assert.equal(b.data.status, 'new')
    assert.equal(c.data.suppressed, true)
    assert.equal(c.data.suppress_reason, 'source_quota')
  })
})

test('43 P0: 白名单豁免抑制', async () => {
  await withEnv({ SEC_VULN_NOISE_SUPPRESS_MIN: '1', SEC_VULN_NOISE_SUPPRESS_RATE: '0.5', SEC_VULN_NOISE_WHITELIST: 'parser:nuclei|Keep Me Template' }, async () => {
    const { bus } = makeEnv()
    const a = await bus.dispatch('vuln', 'register_candidate', { title: 'Keep Me Template', severity: 'info', host: 'w1.example.com', source: 'parser:nuclei' }, { actor: 'script' })
    assert.equal((await reviewedReject(bus, { finding_id: a.data.id, verdict: 'false_positive', reason: '白名单豁免夹具独立对照证明误报' })).ok, true)
    const b = await bus.dispatch('vuln', 'register_candidate', { title: 'Keep Me Template', severity: 'info', host: 'w2.example.com', source: 'parser:nuclei' }, { actor: 'script' })
    assert.equal(b.data.status, 'new', '白名单类别不被抑制')
  })
})

test('43 P0: 候选登记绑定 task_id，拒绝事件携带 task_id（归因→连败拉黑闭环）', async () => {
  const { bus, dir } = makeEnv()
  const cand = await bus.dispatch('vuln', 'register_candidate', { title: '归因候选：IDOR 越权测试目标', severity: 'high', host: 't.example.com', source: 'authz_diff', task_id: 4242 }, { actor: 'script' })
  assert.equal(cand.ok, true)
  const got = await bus.query('vuln', 'get', { id: cand.data.id }, { actor: 'model' })
  assert.equal(got.data.task_id, 4242, '候选行落 task_id')
  const rej = await reviewedReject(bus, { finding_id: cand.data.id, verdict: 'false_positive', reason: '差分证明服务端有归属校验（43 夹具）' })
  assert.equal(rej.ok, true)
  const rejected = readEvents(dir).find((e) => e.name === 'vuln.signal.rejected')
  assert.equal(rejected.payload.task_id, 4242, '拒绝事件携带 task_id')
  assert.equal(rejected.payload.source, 'authz_diff')
})

test('27 E14: sweep preserves observations whose only suppression basis is a template title', async () => {
  await withEnv({ SEC_VULN_NOISE_SUPPRESS_MIN: '2' }, async () => {
    const { bus } = makeEnv()
    const d1 = await bus.dispatch('vuln', 'register_candidate', { title: 'HTTP Missing Security Headers', severity: 'info', host: 's1.example.com', source: 'parser:nuclei' }, { actor: 'script' })
    await bus.dispatch('vuln', 'register_candidate', { title: '疑似越权(IDOR): GET https://s2.example.com/u/1', severity: 'high', host: 's2.example.com', source: 'authz_diff' }, { actor: 'script' })
    const dry = await bus.dispatch('vuln', 'candidates_sweep', { dry_run: true, limit: 100 }, { actor: 'dashboard' })
    assert.equal(dry.ok, true)
    assert.equal(dry.data.by_reason.detection_template, 0)
    assert.equal(dry.data.ignored, 0)
    const before = await bus.query('vuln', 'candidates', { claim_state: 'all' }, { actor: 'model' })
    assert.equal(before.total, 2)
    const run = await bus.dispatch('vuln', 'candidates_sweep', { limit: 100 }, { actor: 'dashboard' })
    assert.equal(run.data.ignored, 0)
    const after = await bus.query('vuln', 'candidates', { claim_state: 'all' }, { actor: 'model' })
    assert.equal(after.total, 2)
    const got = await bus.query('vuln', 'get', { id: d1.data.id }, { actor: 'model' })
    assert.equal(got.data.status, 'new')
  })
})

test('27 E14: sweep source restriction applies before paging and never consumes another source budget', async () => {
  const { bus } = makeEnv()
  for (let i = 0; i < 3; i++) {
    const r = await seedCandidate(bus, { title: 'Other source observation', host: `other${i}.example.com`, source: 'authz_diff' })
    assert.equal(r.ok, true, r.error?.message)
  }
  const wanted = await seedCandidate(bus, { title: 'HTTP Missing Security Headers', host: 'wanted.example.com', source: 'parser:nuclei' })
  assert.equal(wanted.ok, true, wanted.error?.message)
  const sweep = await bus.dispatch('vuln', 'candidates_sweep', { source: 'parser:nuclei', dry_run: true, limit: 2 }, { actor: 'dashboard' })
  assert.equal(sweep.ok, true, sweep.error?.message)
  assert.equal(sweep.data.scanned, 1, 'only the selected source contributes to the scan limit')
  assert.equal(sweep.data.matched, 0, 'template name is not technical counterevidence')
})

test('43 P0: noise_stats 暴露类别拒绝率与抑制口径', async () => {
  const { bus } = makeEnv()
  await bus.dispatch('vuln', 'register_candidate', { title: 'Stats Template', severity: 'info', host: 'x1.example.com', source: 'parser:nuclei' }, { actor: 'script' })
  const c = await bus.dispatch('vuln', 'register_candidate', { title: 'Stats Template', severity: 'info', host: 'x2.example.com', source: 'parser:nuclei' }, { actor: 'script' })
  assert.equal((await reviewedReject(bus, { finding_id: c.data.id, verdict: 'false_positive', reason: '统计夹具误报判定（43 号）' })).ok, true)
  const r = await bus.dispatch('vuln', 'noise_stats', { min_total: 1 }, { actor: 'dashboard' })
  assert.equal(r.ok, true)
  const cat = r.data.categories.find((x) => x.category === 'Stats Template')
  assert.ok(cat, '应聚合出该类别')
  assert.equal(cat.total, 2)
  assert.equal(cat.false_positive, 1)
  assert.ok(r.data.policy.suppress_min >= 1)
})

test('27: 同 URL 的新观察追加证据，不同项目不合并（含幂等层）', async () => {
  const { bus } = makeEnv()
  const a = await seedCandidate(bus, { program_id: 'A', evidence: 'first observation' })
  const b = await seedCandidate(bus, { program_id: 'B', evidence: 'first observation' })
  assert.notEqual(a.data.id, b.data.id)
  const extra = await seedCandidate(bus, { program_id: 'A', evidence: 'second observation' })
  assert.equal(extra.data.id, a.data.id)
  assert.equal(extra.data.dup, true)
  const row = bus._internal.db().prepare('SELECT evidence FROM findings WHERE id=?').get(a.data.id)
  assert.ok(row.evidence.includes('first observation'))
  assert.ok(row.evidence.includes('second observation'))
})

test('27: 新旧候选均可精确升级；旧弱指纹不吞另一 URL', async () => {
  for (const legacy of [false, true]) {
    const { bus } = makeEnv()
    const title = '测试漏洞信号：跨对象读取受限记录'
    const a = await seedCandidate(bus, { title, program_id: 'p', url: 'https://a.example.com/a' })
    if (legacy) {
      const { createHash } = await import('node:crypto')
      bus._internal.db().prepare('UPDATE findings SET fingerprint=? WHERE id=?').run(createHash('sha1').update(`a.example.com|${title}`).digest('hex'), a.data.id)
    }
    const other = await seedCandidate(bus, { title, program_id: 'p', url: 'https://a.example.com/b' })
    assert.notEqual(other.data.id, a.data.id)
    const exact = await seedCandidate(bus, { title, program_id: 'p', url: 'https://a.example.com/a', evidence: 'additional evidence' })
    assert.equal(exact.data.id, a.data.id)
    const promoted = await seedSignal(bus, { title, program_id: 'p', url: 'https://a.example.com/a' })
    assert.equal(promoted.ok, true, promoted.error?.message)
    assert.equal(promoted.data.id, a.data.id)
    assert.equal(promoted.data.upgraded, true)
    assert.ok(bus._internal.db().prepare('SELECT evidence FROM findings WHERE id=?').get(a.data.id).evidence.includes('additional evidence'))
    const untouched = bus._internal.db().prepare('SELECT noise,status FROM findings WHERE id=?').get(other.data.id)
    assert.deepEqual({ ...untouched }, { noise: 1, status: 'new' })
    const repeated = await seedCandidate(bus, { title, program_id: 'p', url: 'https://a.example.com/a', evidence: 'after promotion' })
    assert.equal(repeated.data.id, a.data.id)
  }
})

test('27: 外部 ID 限项目去重，信号自然键也隔离项目', async () => {
  const { bus } = makeEnv()
  const a = await seedCandidate(bus, { program_id: 'A', external_id: 'same-import-id' })
  const b = await seedCandidate(bus, { program_id: 'B', external_id: 'same-import-id' })
  assert.notEqual(a.data.id, b.data.id)
  const otherUrl = await seedCandidate(bus, { program_id: 'B', external_id: 'same-import-id', url: 'https://a.example.com/other' })
  assert.notEqual(otherUrl.data.id, b.data.id, '外部 ID 也不得吞不同 URL')
  assert.equal((await seedCandidate(bus, { program_id: 'B', external_id: 'same-import-id', evidence: 'new evidence' })).data.id, b.data.id)
  const sa = await seedSignal(bus, { program_id: 'A' })
  const sb = await seedSignal(bus, { program_id: 'B' })
  assert.equal(sa.ok, true)
  assert.equal(sb.ok, true, sb.error?.message)
  assert.notEqual(sa.data.id, sb.data.id)
})

test('27: ignored/dup 不参与技术误报抑制，登记、统计、sweep 口径一致', async () => {
  await withEnv({ SEC_VULN_NOISE_SUPPRESS_MIN: '2', SEC_VULN_NOISE_SUPPRESS_RATE: '0.8' }, async () => {
    const { bus } = makeEnv()
    const title = 'IDOR object observation'
    for (let i = 0; i < 4; i++) {
      const r = await seedCandidate(bus, { title, host: `n${i}.example.com`, source: 'authz_diff' })
      bus._internal.db().prepare('UPDATE findings SET status=? WHERE id=?').run(i % 2 ? 'dup' : 'ignored', r.data.id)
    }
    const next = await seedCandidate(bus, { title, host: 'next.example.com', source: 'authz_diff' })
    assert.equal(next.data.suppressed, false)
    const stats = await bus.dispatch('vuln', 'noise_stats', { min_total: 1 }, { actor: 'dashboard' })
    const c = stats.data.categories.find(x => x.source === 'authz_diff')
    assert.equal(c.sample, 0)
    assert.equal(c.rejected, 0)
    assert.equal(c.reject_rate, 0)
    assert.equal(c.suppressed, false)
    const sweep = await bus.dispatch('vuln', 'candidates_sweep', { dry_run: true }, { actor: 'dashboard' })
    assert.equal(sweep.data.by_reason.category_noise, 0)
  })
})

test('27: 平台状态不创造技术正样本，已有技术确认变为 submitted/accepted/dup 不丢失真值', async () => {
  const { bus } = makeEnv()
  const ids = []
  for (const [i, status] of ['confirmed', 'submitted', 'accepted', 'dup', 'accepted'].entries()) {
    const r = await seedCandidate(bus, { title: 'Stats technical truth', host: `t${i}.example.com`, source: 'truth-fixture' })
    if (i < 4) assert.equal((await reviewedConfirm(bus, { finding_id: r.data.id, evidence: 'run_test_20260906_000000' })).ok, true)
    bus._internal.db().prepare('UPDATE findings SET status=? WHERE id=?').run(status, r.data.id)
    ids.push(r.data.id)
  }
  const dup = await bus.dispatch('vuln', 'reject', { finding_id: ids[0], verdict: 'dup', dup_of: ids[1], reason: '重复观察保留原有技术确认，不作为方法失败' }, { actor: 'model' })
  assert.equal(dup.ok, true, dup.error?.message)
  assert.equal(bus._internal.db().prepare('SELECT confidence FROM findings WHERE id=?').get(ids[0]).confidence, 'confirmed')
  const r = await seedCandidate(bus, { title: 'Stats technical truth', host: 'negative.example.com', source: 'truth-fixture' })
  assert.equal((await reviewedReject(bus, { finding_id: r.data.id, verdict: 'false_positive', reason: '本次实验有可靠反证，确认不是漏洞' })).ok, true)
  const stats = await bus.dispatch('vuln', 'noise_stats', { min_total: 1 }, { actor: 'dashboard' })
  const c = stats.data.categories.find(x => x.source === 'truth-fixture')
  assert.equal(c.total, 6)
  assert.equal(c.technical_confirmed, 4)
  assert.equal(c.sample, 5)
  assert.equal(c.reject_rate, 0.2)
})

test('27 E14: legacy status and reason-only receipts cannot suppress new candidates or inflate technical samples', async () => {
  await withEnv({ SEC_VULN_NOISE_SUPPRESS_MIN: '2', SEC_VULN_NOISE_SUPPRESS_RATE: '0.8' }, async () => {
    const { bus } = makeEnv()
    const db = bus._internal.db()
    for (let i = 0; i < 4; i++) {
      const candidate = await seedCandidate(bus, { title: 'Legacy authz observation', source: 'legacy-truth',
        host: `legacy-${i}.example.com` })
      db.prepare('UPDATE findings SET status=?,confidence=? WHERE id=?')
        .run(i === 3 ? 'accepted' : 'false_positive', i === 3 ? 'confirmed' : 'false_positive', candidate.data.id)
      if (i === 2) {
        const evidence = JSON.stringify({ reason: '旧模型认为未发现漏洞但没有独立技术对照' })
        db.prepare(`INSERT INTO vuln_technical_verdicts
          (finding_id,verdict,basis,evidence_json,evidence_digest,created_at) VALUES (?,'false_positive','rejection',?,?,?)`)
          .run(candidate.data.id, evidence, crypto.createHash('sha256').update(evidence).digest('hex'), Date.now())
      }
    }
    const next = await seedCandidate(bus, { title: 'Legacy authz observation', source: 'legacy-truth', host: 'next.example.com' })
    assert.equal(next.data.suppressed, false, 'old negative labels cannot suppress a new observation')
    const stats = await bus.dispatch('vuln', 'noise_stats', { min_total: 1 }, { actor: 'dashboard' })
    const category = stats.data.categories.find(row => row.source === 'legacy-truth')
    assert.equal(category.false_positive, 3, 'historical handling counts remain visible')
    assert.equal(category.technical_confirmed, 0)
    assert.equal(category.technical_false_positive, 0)
    assert.equal(category.sample, 0)
    const sweep = await bus.dispatch('vuln', 'candidates_sweep', { dry_run: true }, { actor: 'dashboard' })
    assert.equal(sweep.data.by_reason.category_noise, 0)
    bus._internal.close()
  })
})

test('27 E14: latest technical receipt replaces prior truth and damaged receipts never fall back to older positives', async () => {
  const { bus } = makeEnv()
  const candidate = await seedCandidate(bus, { title: 'Receipt integrity observation', source: 'receipt-truth' })
  const id = candidate.data.id
  assert.equal((await reviewedConfirm(bus, { finding_id: id, evidence: 'run_test_20260906_000000' })).ok, true)
  const stats = async () => {
    const result = await bus.dispatch('vuln', 'noise_stats', { min_total: 1 }, { actor: 'dashboard' })
    assert.equal(result.ok, true, result.error?.message)
    return result.data.categories.find(row => row.source === 'receipt-truth')
  }
  assert.equal((await stats()).technical_confirmed, 1)
  assert.equal((await reviewedReject(bus, { finding_id: id, verdict: 'false_positive', reason: '新的独立对照反驳先前的对象归属解释' })).ok, true)
  assert.equal((await stats()).technical_confirmed, 0)
  assert.equal((await stats()).technical_false_positive, 1)
  const db = bus._internal.db()
  const receipt = db.prepare('SELECT * FROM vuln_technical_verdicts ORDER BY id DESC LIMIT 1').get()
  db.prepare('UPDATE vuln_technical_verdicts SET evidence_json=? WHERE id=?').run('{}', receipt.id)
  assert.equal((await stats()).sample, 0, 'damaged current truth is unknown, not an old positive')
  db.prepare('UPDATE vuln_technical_verdicts SET evidence_json=? WHERE id=?').run(receipt.evidence_json, receipt.id)
  assert.equal((await stats()).technical_false_positive, 1)
  bus._internal.close()
})

test('27 E14: source cache observes local rollback and another connection repairing technical evidence', async () => {
  const { bus, dir } = makeEnv()
  const candidate = await seedCandidate(bus, { title: 'Cached truth observation', source: 'cache-truth' })
  assert.equal((await reviewedReject(bus, { finding_id: candidate.data.id, verdict: 'false_positive',
    reason: '原始观察经独立复核及完整有效对照确认为误报' })).ok, true)
  const db = bus._internal.db()
  const repo = createVulnSqliteBackend().factory(db)
  const stats = () => repo.sourceTitleStats('cache-truth', { ttlMs: 60000 })[0]
  assert.equal(stats().technical_false_positive, 1)
  const receipt = db.prepare('SELECT * FROM vuln_technical_verdicts').get()
  db.exec('BEGIN')
  db.prepare("UPDATE vuln_technical_verdicts SET evidence_json='{}' WHERE id=?").run(receipt.id)
  assert.equal(stats().technical_false_positive, 0)
  db.exec('ROLLBACK')
  assert.equal(stats().technical_false_positive, 1, 'rollback cannot leave an uncommitted cached verdict')
  const other = new DatabaseSync(path.join(dir, 'asset-graph.db'))
  try {
    other.prepare("UPDATE vuln_technical_verdicts SET evidence_json='{}' WHERE id=?").run(receipt.id)
    assert.equal(stats().technical_false_positive, 0, 'other connection invalidates the live cache')
    other.prepare('UPDATE vuln_technical_verdicts SET evidence_json=? WHERE id=?').run(receipt.evidence_json, receipt.id)
    assert.equal(stats().technical_false_positive, 1)
  } finally { other.close(); bus._internal.close() }
})
