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
import { fileURLToPath } from 'node:url'
import { createBus } from '../../sec-domain-bus/index.js'
import { buildVulnDomain, VULN_MANIFEST } from '../index.js'

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
  const domain = buildVulnDomain({ dataDir, dispatch: (d, v, a, c) => bus.dispatch(d, v, a, c) })
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
// 1. happy path（每动词一例：信封结构 / data 字段 / 事件 payload / audit 落盘）
// ---------------------------------------------------------------------------

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

test('happy path C3: confirm 候选 → 三联动原子升级（status+confidence+noise）+ 双事件 + audit', async () => {
  const { dir, bus } = makeEnv()
  const cand = await seedCandidate(bus)
  const id = cand.data.id
  const r = await bus.dispatch('vuln', 'confirm', { finding_id: id, evidence: 'run_test_20260906_000000', note: '三包对照齐全，重放 3 次稳定' }, { actor: 'model', session_id: 'sess_1' })
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
  const r = await bus.dispatch('vuln', 'reject', { finding_id: cand.data.id, verdict: 'false_positive', reason: '重放后响应为统一 404 页，判定为模板指纹误报', dup_of: null }, { actor: 'model' })
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
  await bus.dispatch('vuln', 'confirm', { finding_id: sig.data.id, evidence: 'run_test_20260906_000000' }, { actor: 'model' })
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
  const sig = await seedSignal(bus)
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

test('happy path C11: authz_diff 双权重放 suspected → 自动落 C2 候选（actor=script）', async () => {
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
    url,
    method: 'GET',
    headers_low: `X-Role: low`,
    headers_high: `X-Role: high`,
  }, { actor: 'model', session_id: 'sess_authz' })
  await closeServer(srv)
  assert.equal(r.ok, true)
  assert.equal(r.data.verdict, 'suspected')
  assert.ok(r.data.candidate_id, 'suspected 应自动落候选')
  const row = bus._internal.db().prepare('SELECT * FROM findings WHERE id=?').get(r.data.candidate_id)
  assert.equal(row.noise, 1)
  assert.equal(row.source, 'authz_diff')
  assert.equal(row.severity, 'high')
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
  assert.equal(c2.error.code, 'E_VULN_CLAIMED')
  const c3 = await bus.dispatch('vuln', 'reject', { finding_id: id, verdict: 'false_positive', reason: 'x'.repeat(10) }, { actor: 'model', session_id: 'sess_b' })
  assert.equal(c3.ok, false)
  assert.equal(c3.error.code, 'E_VULN_CLAIMED')
  // dashboard 豁免（人工终审可越）
  const c4 = await bus.dispatch('vuln', 'confirm', { finding_id: id, evidence: 'run_test_20260906_000000' }, { actor: 'dashboard', operator: 'operator_1' })
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
  await bus.dispatch('vuln', 'confirm', { finding_id: id, evidence: 'run_test_20260906_000000' }, { actor: 'model' })
  const c1 = await bus.dispatch('vuln', 'confirm', { finding_id: id, evidence: 'run_test_20260907_000000' }, { actor: 'model' })
  assert.equal(c1.ok, false)
  assert.equal(c1.error.code, 'E_STATE')
  await bus.dispatch('vuln', 'submit', { finding_id: id }, { actor: 'model' })
  await bus.dispatch('vuln', 'submit', { finding_id: id, vendor_status: 'accepted' }, { actor: 'model' })
  const c2 = await bus.dispatch('vuln', 'reject', { finding_id: id, verdict: 'false_positive', reason: 'x'.repeat(10) }, { actor: 'model' })
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
    await bus.dispatch('vuln', 'reject', { finding_id: sig.data.id, verdict, reason: 'x'.repeat(10), ...(verdict === 'dup' ? { dup_of: sig.data.id } : {}) }, { actor: 'model' })
    for (const cmd of ['confirm', 'reject', 'submit']) {
      const args = cmd === 'confirm' ? { finding_id: sig.data.id, evidence: 'run_test_20260906_000000' }
        : cmd === 'reject' ? { finding_id: sig.data.id, verdict: 'ignored', reason: 'y'.repeat(10) }
          : { finding_id: sig.data.id }
      const r = await bus.dispatch('vuln', cmd, args, { actor: 'model' })
      assert.equal(r.ok, false, `${cmd} on ${verdict} 应被拒`)
      assert.equal(r.error.code, 'E_STATE')
    }
  }
})

// ---------------------------------------------------------------------------
// 5. actor 拒绝（机器通道模型禁入；模型动词机器禁入）
// ---------------------------------------------------------------------------

test('actor 拒绝: register_candidate × {model,dashboard,human} → E_ACTOR_FORBIDDEN', async () => {
  const { bus } = makeEnv()
  for (const actor of ['model', 'dashboard', 'human']) {
    const r = await bus.dispatch('vuln', 'register_candidate', { title: 'x.example.com 被动审计候选：xray', severity: 'medium', host: 'x.example.com', source: 'xray-webhook' }, { actor })
    assert.equal(r.ok, false, `${actor} 应被拒`)
    assert.equal(r.error.code, 'E_ACTOR_FORBIDDEN')
  }
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

test('幂等: confirm/note/reject/claim/submit 同 key 同参 → replay:true 同结果', async () => {
  const { bus } = makeEnv()
  const cand = await seedCandidate(bus)
  const id = cand.data.id
  const c1 = await bus.dispatch('vuln', 'confirm', { finding_id: id, evidence: 'run_test_20260906_000000' }, { actor: 'model' })
  const c2 = await bus.dispatch('vuln', 'confirm', { finding_id: id, evidence: 'run_test_20260906_000000' }, { actor: 'model' })
  assert.equal(c2.ok, true)
  assert.equal(c2.replay, true)
  assert.deepEqual(JSON.parse(JSON.stringify(c1.data)), JSON.parse(JSON.stringify(c2.data)))
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

test('幂等: 机器通道宽容 dup——同弱指纹异参不报错走 dup:true', async () => {
  const { bus } = makeEnv()
  const a1 = await seedCandidate(bus)
  const a2 = await bus.dispatch('vuln', 'register_candidate', { title: 'a.example.com 被动审计候选：xray', severity: 'high', host: 'a.example.com', url: 'https://a.example.com/login?variant=2', source: 'xray-webhook' }, { actor: 'webhook' })
  assert.equal(a2.ok, true)
  assert.equal(a2.data.dup, true)
  assert.equal(a1.data.id, a2.data.id, '同 host+title 弱指纹不另起行')
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
const env = await bus.dispatch('vuln', 'confirm', { finding_id: ${id}, evidence: ${JSON.stringify(evidence)} }, { actor: 'model' })
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
  const r = await bus.dispatch('vuln', 'confirm', { finding_id: id, evidence: 'run_test_20260906_000000 + 完整复现脚本与响应报文', note: '确认' }, { actor: 'model' })
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
  const r = await bus.dispatch('vuln', 'confirm', { finding_id: id, evidence: 'run_test_20260906_000000' }, { actor: 'model' })
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

test('别名: finding_add model 完整五要素 → register_signal；同指纹异参 → v4 dup 形状（真实域）', async () => {
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
  assert.equal(r2.ok, true, '同指纹异参 → v4 dup 形状不报错')
  assert.equal(r2.dup, true)
  assert.equal(r2.id, r1.data.id)
  assert.equal(r2.compat, 'v4-dup-shape')
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
  const withEv = await bus.dispatch('', 'finding_update', { finding_id: id, status: 'confirmed', evidence: 'run_test_20260906_000000' }, { actor: 'dashboard' })
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

test('别名: finding_update dup 缺 dup_of → 自动填充同 host 信号行；查不到 → 留空放行（兼容期）', async () => {
  const { dir, bus } = makeEnv({ aliasesDoc: V1_ALIASES })
  await seedSignal(bus, { title: '同目标既有信号：SQLi 注入', host: 'dupfill.example.com', vuln_type: 'SQLi', severity: 'high' })
  const cand = await seedCandidate(bus, { title: '同目标重复候选', host: 'dupfill.example.com', severity: 'medium' })
  const id = cand.data.id
  const r = await bus.dispatch('', 'finding_update', { finding_id: id, status: 'dup', reason: '重复登记：同 host 同类型已有信号行' }, { actor: 'dashboard' })
  assert.equal(r.ok, true)
  assert.equal(r.data.status, 'dup')
  const audit = readAudit(dir)
  const rec = audit.find((a) => a.kind === 'command' && a.cmd === 'reject' && a.result === 'ok' && a.via_alias === 'finding_update')
  assert.ok(rec, 'reject 经 alias 审计')
  const none = await seedCandidate(bus, { title: '无同目标信号的候选', host: 'orphan.example.com' })
  const r2 = await bus.dispatch('', 'finding_update', { finding_id: none.data.id, status: 'dup', reason: '查不到同目标信号，留空放行' }, { actor: 'dashboard' })
  assert.equal(r2.ok, true, '查不到 dup_of → 留空放行（观察期后必填）')
  assert.equal(r2.data.status, 'dup')
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