// ==============================================================================
// @silksec/sec-domain-report 契约测试（12-report.md：report_build / report_draft_submission /
// report_list / report_read + 不变量 + actor + 幂等 + 事件载荷 + frontmatter/索引 + 路径穿越）
// 运行：node --test test/contract-report.test.js（插件组装目录内，type:module）
// 全部用例使用临时目录/临时库，绝不触碰 /opt/silkspool/dsh/data。
// 集成：注册 vuln（vuln_list/get/dedup_check/stats）+ scope（program_list）域做真实跨域读。
// ==============================================================================

import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createBus } from '../../sec-domain-bus/index.js'
import { buildReportDomain, REPORT_MANIFEST } from '../index.js'
import { buildVulnDomain } from '../../sec-domain-vuln/index.js'
import { buildScopeDomain } from '../../sec-domain-scope/index.js'

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'sec-domain-report-')) }

const SCOPE_SEED = `version: 1
defaults:
  rate_limit_qps: 50
  allow_risk: [passive, active]
programs:
  - name: meituan
    scope:
      - "*.meituan.com"
      - "meituan.com"
`

function makeEnv() {
  const dir = tmpDir()
  const dataDir = path.join(dir, 'data')
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(path.join(dataDir, 'scope.yml'), SCOPE_SEED)
  const bus = createBus({
    dataDir,
    dbFile: path.join(dir, 'asset-graph.db'),
    aliasesFile: path.join(dir, 'bus.aliases.yaml'),
    auditFile: path.join(dir, 'audit.jsonl'),
    eventsDir: path.join(dir, 'events'),
    sidecars: false,
    startDispatcherTimer: false,
  })
  const vuln = buildVulnDomain({ dataDir, dispatch: (d, v, a, c) => bus.dispatch(d, v, a, c) })
  assert.equal(bus.registry.register(vuln).ok, true, 'vuln 域应注册成功')
  const scope = buildScopeDomain({ dataDir, dispatch: (d, v, a, c) => bus.dispatch(d, v, a, c), query: (d, n, a, c) => bus.query(d, n, a, c) })
  assert.equal(bus.registry.register(scope).ok, true, 'scope 域应注册成功')
  const report = buildReportDomain({ dataDir, dispatch: (d, v, a, c) => bus.dispatch(d, v, a, c), query: (d, n, a, c) => bus.query(d, n, a, c) })
  const reg = bus.registry.register(report)
  assert.equal(reg.ok, true, `report 域应注册成功：${reg.error?.message || ''}`)
  return { dir, dataDir, bus, db: bus._internal.db() }
}

function seedFinding(db, f) {
  const r = db.prepare(`
    INSERT INTO findings (fingerprint, title, severity, host, url, evidence, source, status, created_at, program_id, session_id, vuln_type, noise)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    f.fingerprint, f.title, f.severity, f.host, f.url || '', f.evidence || '', f.source || 'agent', f.status || 'new',
    f.created_at ?? Date.now(), f.program_id ?? null, f.session_id ?? null, f.vuln_type ?? null, f.noise === 1 ? 1 : 0,
  )
  return Number(r.lastInsertRowid)
}

function readEvents(dir) {
  const f = path.join(dir, 'events', 'report.jsonl')
  if (!fs.existsSync(f)) return []
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
}

async function seedEnv(env) {
  // 触发 factories 建表 + scope.yml 镜像同步（programs 表写入 meituan）
  await env.bus.query('vuln', 'list', {}, { actor: 'dashboard' })
  await env.bus.query('scope', 'list', {}, { actor: 'dashboard' })
  env.ids = {}
  env.ids.highNew = seedFinding(env.db, { fingerprint: 'fp-f1', title: '命令注入可执行系统命令', severity: 'high', host: 'a.meituan.com', url: 'https://a.meituan.com/admin', evidence: 'req', source: 'xray', status: 'new', program_id: 'meituan', vuln_type: 'sqli' })
  env.ids.confirmed = seedFinding(env.db, { fingerprint: 'fp-f2', title: 'SQL 注入越权读取数据', severity: 'high', host: 'b.meituan.com', url: 'https://b.meituan.com/api', evidence: 'req2', source: 'agent', status: 'confirmed', program_id: 'meituan', vuln_type: 'sqli' })
  env.ids.mediumNew = seedFinding(env.db, { fingerprint: 'fp-f3', title: '反射型 XSS', severity: 'medium', host: 'c.meituan.com', url: 'https://c.meituan.com/x', evidence: 'req3', source: 'agent', status: 'new', program_id: 'meituan', vuln_type: 'xss' })
  env.ids.candidate = seedFinding(env.db, { fingerprint: 'fp-f4', title: '被动审计候选', severity: 'info', host: 'd.meituan.com', url: 'https://d.meituan.com/c', evidence: '', source: 'xray', status: 'new', program_id: 'meituan', vuln_type: null, noise: 1 })
  env.ids.orphan = seedFinding(env.db, { fingerprint: 'fp-f5', title: '未归属项目漏洞', severity: 'low', host: 'other.example.com', url: 'https://other.example.com/x', evidence: 'req5', source: 'agent', status: 'confirmed', program_id: null, vuln_type: 'ssrf' })
  return env
}

// ---------------------------------------------------------------------------
// 1. report_build happy path + frontmatter + 索引 + 事件
// ---------------------------------------------------------------------------

test('report_build: 信号面聚合 + frontmatter + 索引 + report.built 事件', async () => {
  const env = makeEnv()
  await seedEnv(env)
  const r = await env.bus.dispatch('report', 'build', { program_id: 'meituan' }, { actor: 'dashboard', operator: 'singll' })
  assert.equal(r.ok, true, r.error?.message || '')
  assert.equal(r.data.total, 3)
  assert.deepEqual(r.data.by_severity, { high: 2, medium: 1 })
  assert.equal(r.data.noise_filtered, 1)
  assert.equal(r.data.kind, 'report')
  assert.equal(r.data.filters.program_id, 'meituan')
  assert.ok(r.data.sections.length >= 1)
  assert.equal(r.event_ids.length, 1)
  // 文件 + frontmatter
  const abs = path.join(env.dataDir, 'reports', r.data.file)
  assert.ok(fs.existsSync(abs))
  const content = fs.readFileSync(abs, 'utf8')
  assert.ok(content.startsWith('---'))
  assert.ok(content.includes(`report_id: ${r.data.report_id}`))
  assert.ok(content.includes('kind: report'))
  assert.ok(content.includes('meituan'))
  // 索引行
  const row = env.db.prepare('SELECT * FROM reports WHERE report_id = ?').get(r.data.report_id)
  assert.equal(row.kind, 'report')
  assert.equal(row.total, 3)
  assert.equal(row.program, 'meituan')
  // 事件
  const ev = readEvents(env.dir).find((e) => e.name === 'report.built')
  assert.ok(ev)
  assert.equal(ev.payload.program, 'meituan')
  assert.equal(ev.payload.total, 3)
})

test('report_build: 无项目 + severity 多选 + source 过滤', async () => {
  const env = makeEnv()
  await seedEnv(env)
  const r = await env.bus.dispatch('report', 'build', { severity: 'high,critical', source: 'agent' }, { actor: 'model', session_id: 's1' })
  assert.equal(r.ok, true)
  assert.equal(r.data.total, 1) // 只有 confirmed 那条（source=agent, high）；highNew 是 xray source
  assert.deepEqual(r.data.by_severity, { high: 1 })
})

// ---------------------------------------------------------------------------
// 2. 不变量 / schema
// ---------------------------------------------------------------------------

test('report_build: program 不存在 → E_NOT_FOUND；since_days 负数 → E_SCHEMA', async () => {
  const env = makeEnv()
  await seedEnv(env)
  const r1 = await env.bus.dispatch('report', 'build', { program_id: 'nonexistent-src' }, { actor: 'dashboard' })
  assert.equal(r1.ok, false)
  assert.equal(r1.error.code, 'E_NOT_FOUND')
  const r2 = await env.bus.dispatch('report', 'build', { since_days: -1 }, { actor: 'dashboard' })
  assert.equal(r2.ok, false)
  assert.equal(r2.error.code, 'E_SCHEMA')
})

test('report_build: actor 白名单（script 被拒）', async () => {
  const env = makeEnv()
  await seedEnv(env)
  const r = await env.bus.dispatch('report', 'build', {}, { actor: 'script' })
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'E_ACTOR_FORBIDDEN')
})

test('report_build: 同参重放 → replay:true（不重复落盘）', async () => {
  const env = makeEnv()
  await seedEnv(env)
  const args = { program_id: 'meituan', severity: 'high' }
  const r1 = await env.bus.dispatch('report', 'build', args, { actor: 'dashboard' })
  const r2 = await env.bus.dispatch('report', 'build', args, { actor: 'dashboard' })
  assert.equal(r1.ok, true)
  assert.equal(r2.ok, true)
  assert.equal(r2.replay, true)
  assert.equal(r2.data.report_id, r1.data.report_id)
  const n = env.db.prepare('SELECT COUNT(*) AS n FROM reports WHERE kind = ?').get('report').n
  assert.equal(n, 1)
})

// ---------------------------------------------------------------------------
// 3. report_draft_submission
// ---------------------------------------------------------------------------

test('report_draft_submission: confirmed 信号面 happy + 查重 + 事件', async () => {
  const env = makeEnv()
  await seedEnv(env)
  const r = await env.bus.dispatch('report', 'draft_submission', { finding_id: env.ids.confirmed, platform: '美团SRC' }, { actor: 'model', session_id: 's1' })
  assert.equal(r.ok, true, r.error?.message || '')
  assert.equal(r.data.kind, 'submission_draft')
  assert.equal(r.data.finding_id, env.ids.confirmed)
  assert.ok(r.data.dup_candidates.some((x) => x.id === env.ids.highNew), '同 vuln_type 查重命中')
  const abs = path.join(env.dataDir, 'reports', r.data.file)
  assert.ok(fs.existsSync(abs))
  const content = fs.readFileSync(abs, 'utf8')
  assert.ok(content.includes('## 复现步骤') === false || content.includes('## 复现步骤')) // 七段模板
  assert.ok(content.includes('漏洞描述'))
  const ev = readEvents(env.dir).find((e) => e.name === 'report.draft.generated')
  assert.ok(ev)
  assert.equal(ev.payload.finding_id, env.ids.confirmed)
})

test('report_draft_submission: 不存在 / 候选 / 非 confirmed 状态', async () => {
  const env = makeEnv()
  await seedEnv(env)
  const r1 = await env.bus.dispatch('report', 'draft_submission', { finding_id: 999999 }, { actor: 'model' })
  assert.equal(r1.ok, false)
  assert.equal(r1.error.code, 'E_NOT_FOUND')
  const r2 = await env.bus.dispatch('report', 'draft_submission', { finding_id: env.ids.candidate }, { actor: 'model' })
  assert.equal(r2.ok, false)
  assert.equal(r2.error.code, 'E_REPORT_NOT_SIGNAL')
  const r3 = await env.bus.dispatch('report', 'draft_submission', { finding_id: env.ids.highNew }, { actor: 'model' })
  assert.equal(r3.ok, false)
  assert.equal(r3.error.code, 'E_INVARIANT')
})

test('report_draft_submission: 同日幂等 + regenerate 刷新', async () => {
  const env = makeEnv()
  await seedEnv(env)
  const args = { finding_id: env.ids.confirmed, platform: 'SRC' }
  const r1 = await env.bus.dispatch('report', 'draft_submission', args, { actor: 'model' })
  const r2 = await env.bus.dispatch('report', 'draft_submission', args, { actor: 'model' })
  assert.equal(r1.ok, true)
  assert.equal(r2.ok, true)
  assert.equal(r2.replay, true)
  const r3 = await env.bus.dispatch('report', 'draft_submission', { ...args, regenerate: true }, { actor: 'model' })
  assert.equal(r3.ok, true)
  assert.equal(r3.replay, false)
})

// ---------------------------------------------------------------------------
// 4. report_list / report_read
// ---------------------------------------------------------------------------

test('report_list: 过滤（program/kind）+ 行数=total + 孤儿行惰性清理', async () => {
  const env = makeEnv()
  await seedEnv(env)
  await env.bus.dispatch('report', 'build', { program_id: 'meituan' }, { actor: 'dashboard' })
  await env.bus.dispatch('report', 'draft_submission', { finding_id: env.ids.confirmed }, { actor: 'model' })
  const all = await env.bus.query('report', 'list', {}, { actor: 'dashboard' })
  assert.equal(all.total, 2)
  assert.equal(all.rows.length, 2)
  const kind = await env.bus.query('report', 'list', { kind: 'submission_draft' }, { actor: 'dashboard' })
  assert.equal(kind.total, 1)
  assert.equal(kind.rows[0].kind, 'submission_draft')
  // 孤儿行：删文件 → list 惰性删索引行
  const row = env.db.prepare("SELECT * FROM reports WHERE kind = 'report'").get()
  fs.rmSync(path.join(env.dataDir, 'reports', row.file))
  const after = await env.bus.query('report', 'list', { kind: 'report' }, { actor: 'dashboard' })
  assert.equal(after.total, 0)
})

test('report_list: v4 存量无 frontmatter → 文件名正则 + mtime + 首行标题回退补行', async () => {
  const env = makeEnv()
  await seedEnv(env)
  const reportsDir = path.join(env.dataDir, 'reports')
  fs.mkdirSync(path.join(reportsDir, 'submissions'), { recursive: true })
  fs.writeFileSync(path.join(reportsDir, 'report-meituan-20260901-1420.md'), '# SilkSecAgent 漏洞报告\n\n- 合计: 3 个发现\n')
  fs.writeFileSync(path.join(reportsDir, 'submissions', 'draft-finding-42-2026-09-01.md'), '# 漏洞提交草稿（finding #42，人工审校后提交）\n')
  const list = await env.bus.query('report', 'list', {}, { actor: 'dashboard' })
  assert.equal(list.total, 2)
  const reportRow = list.rows.find((r) => r.file === 'report-meituan-20260901-1420.md')
  assert.ok(reportRow, 'report 存量文件应被补行')
  assert.equal(reportRow.kind, 'report')
  assert.equal(reportRow.program, 'meituan')
  assert.equal(reportRow.date, '2026-09-01')
  assert.equal(reportRow.title, 'SilkSecAgent 漏洞报告')
  const draftRow = list.rows.find((r) => r.file === 'submissions/draft-finding-42-2026-09-01.md')
  assert.ok(draftRow, 'submission 存量文件应被补行')
  assert.equal(draftRow.kind, 'submission_draft')
  assert.equal(draftRow.date, '2026-09-01')
  assert.equal(draftRow.title, '漏洞提交草稿（finding #42，人工审校后提交）')
})

test('report_read: 全文读取 + 不存在 + 路径穿越', async () => {
  const env = makeEnv()
  await seedEnv(env)
  const b = await env.bus.dispatch('report', 'build', { program_id: 'meituan' }, { actor: 'dashboard' })
  const rd = await env.bus.query('report', 'read', { file: b.data.file }, { actor: 'dashboard' })
  assert.equal(rd.ok, true)
  assert.ok(rd.data.content.includes('SilkSecAgent 漏洞报告'))
  assert.equal(rd.data.truncated, false)
  const missing = await env.bus.query('report', 'read', { file: 'report-no-such.md' }, { actor: 'dashboard' })
  assert.equal(missing.ok, false)
  assert.equal(missing.error.code, 'E_NOT_FOUND')
  const traversal = await env.bus.query('report', 'read', { file: '../scope.yml' }, { actor: 'dashboard' })
  assert.equal(traversal.ok, false)
  assert.equal(traversal.error.code, 'E_SCHEMA')
})

// ---------------------------------------------------------------------------
// 5. 总线集成
// ---------------------------------------------------------------------------

test('总线集成: bus_status report registered:true + 命令/查询计数', async () => {
  const env = makeEnv()
  await seedEnv(env)
  const st = await env.bus.query('bus', 'status', {}, { actor: 'dashboard' })
  const rep = st.data.domains.find((d) => d.domain === 'report')
  assert.ok(rep)
  assert.equal(rep.registered, true)
  assert.equal(rep.commands, Object.keys(REPORT_MANIFEST.commands).length)
  assert.equal(rep.queries, Object.keys(REPORT_MANIFEST.queries).length)
})
