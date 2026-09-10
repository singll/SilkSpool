// ==============================================================================
// @silksec/sec-domain-scope 契约测试（08-scope.md：授权/排除/规则/凭据 + scope_check 算法 +
// 不变量 + actor + 幂等 + 事件载荷）
// 运行：node --test test/contract-scope.test.js（插件组装目录内，type:module）
// 全部用例使用临时目录/临时库，绝不触碰 /opt/silkspool/dsh/data。
// ==============================================================================

import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createBus } from '../../sec-domain-bus/index.js'
import { buildScopeDomain, SCOPE_MANIFEST } from '../index.js'

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'sec-domain-scope-')) }

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

function makeEnv(seedScope) {
  const dir = tmpDir()
  const dataDir = path.join(dir, 'data')
  if (seedScope) {
    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(path.join(dataDir, 'scope.yml'), seedScope)
  }
  const bus = baseBus(dir, dataDir)
  const domain = buildScopeDomain({
    dataDir,
    dispatch: (d, v, a, c) => bus.dispatch(d, v, a, c),
    query: (d, n, a, c) => bus.query(d, n, a, c),
  })
  const reg = bus.registry.register(domain)
  assert.equal(reg.ok, true, `scope 域应注册成功：${reg.error?.message || ''}`)
  return { dir, dataDir, bus }
}

function readScope(dir) {
  return fs.readFileSync(path.join(dir, 'data', 'scope.yml'), 'utf8')
}
function readEvents(dir) {
  const f = path.join(dir, 'events', 'scope.jsonl')
  if (!fs.existsSync(f)) return []
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
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

// ---------------------------------------------------------------------------
// 1. scope_grant happy path
// ---------------------------------------------------------------------------

test('grant 新建项目 + 通配自动配对裸域 + scope.granted 事件', async () => {
  const { dir, bus } = makeEnv()
  const r = await bus.dispatch('scope', 'grant', {
    program_name: 'new-src', entries: ['*.newcorp.com'],
  }, { actor: 'dashboard', operator: 'singll' })
  assert.equal(r.ok, true)
  assert.equal(r.data.program_created, true)
  assert.ok(r.data.granted.includes('*.newcorp.com'))
  assert.ok(r.data.granted.includes('newcorp.com'), '通配自动配对裸域')
  assert.equal(r.event_ids.length, 1)
  const ev = readEvents(dir).find((e) => e.name === 'scope.granted')
  assert.ok(ev)
  assert.equal(ev.payload.program_id, 'new-src')
  assert.ok(ev.payload.subject)
  // 镜像同步
  const row = bus._internal.db().prepare("SELECT * FROM programs WHERE id='new-src'").get()
  assert.equal(row.status, 'active')
})

test('grant 已存在项目 + 吸收本项目排除 + skipped_existing', async () => {
  const { dir, bus } = makeEnv(SEED)
  const r = await bus.dispatch('scope', 'grant', {
    program_name: 'example-src', entries: ['pay.example.com', '*.example.com'],
  }, { actor: 'dashboard', operator: 'singll' })
  assert.equal(r.ok, true)
  assert.equal(r.data.program_created, false)
  assert.ok(r.data.skipped_existing.includes('*.example.com'))
  assert.ok(r.data.skipped_existing.includes('example.com'))
  assert.ok(r.data.granted.includes('pay.example.com'))
  assert.ok(r.data.removed_excludes.includes('pay.example.com'), '吸收本项目排除')
  const txt = readScope(dir)
  assert.ok(!txt.includes('pay.example.com') || txt.includes('exclude:') === false || !/exclude:\s*\n\s*- "pay\.example\.com"/.test(txt))
})

// ---------------------------------------------------------------------------
// 2. 不变量
// ---------------------------------------------------------------------------

test('不变量: 条目格式非法 → E_SCOPE_ENTRY_INVALID；项目名非法 → E_SCOPE_PROGRAM_NAME_INVALID', async () => {
  const { bus } = makeEnv()
  const r1 = await bus.dispatch('scope', 'grant', { program_name: 'a-src', entries: ['bad entry!'] }, { actor: 'dashboard' })
  assert.equal(r1.ok, false)
  assert.equal(r1.error.code, 'E_SCOPE_ENTRY_INVALID')
  const r2 = await bus.dispatch('scope', 'grant', { program_name: 'Bad Name', entries: ['x.com'] }, { actor: 'dashboard' })
  assert.equal(r2.ok, false)
  assert.equal(r2.error.code, 'E_SCOPE_PROGRAM_NAME_INVALID')
})

test('不变量: grant 命中其他项目排除 → E_SCOPE_MUTUAL_EXCLUSION', async () => {
  const { bus } = makeEnv(SEED)
  const r = await bus.dispatch('scope', 'grant', { program_name: 'other-src', entries: ['pay.example.com'] }, { actor: 'dashboard' })
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'E_SCOPE_MUTUAL_EXCLUSION')
})

test('不变量: revoke 不存在条目 → E_NOT_FOUND', async () => {
  const { bus } = makeEnv(SEED)
  const r = await bus.dispatch('scope', 'revoke', { program_name: 'example-src', entries: ['nope.example.com'] }, { actor: 'dashboard' })
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'E_NOT_FOUND')
})

test('不变量: exclude 命中其他项目授权 → E_SCOPE_MUTUAL_EXCLUSION', async () => {
  const { bus } = makeEnv(SEED + `  - name: other-src
    scope:
      - "*.other.com"
      - "other.com"
`)
  const r = await bus.dispatch('scope', 'exclude', { program_name: 'other-src', entries: ['sub.example.com'] }, { actor: 'dashboard' })
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'E_SCOPE_MUTUAL_EXCLUSION')
})

// ---------------------------------------------------------------------------
// 3. revoke / 归档
// ---------------------------------------------------------------------------

test('revoke 清空条目 → 整项目出 yml + programs 归档', async () => {
  const { dir, bus } = makeEnv(SEED)
  const r = await bus.dispatch('scope', 'revoke', { program_name: 'example-src', entries: ['*.example.com', 'example.com'] }, { actor: 'dashboard' })
  assert.equal(r.ok, true)
  assert.equal(r.data.program_removed, true)
  const txt = readScope(dir)
  assert.ok(!txt.includes('example-src'))
  const row = bus._internal.db().prepare("SELECT * FROM programs WHERE id='example-src'").get()
  assert.equal(row.status, 'archived')
})

// ---------------------------------------------------------------------------
// 4. rules_apply
// ---------------------------------------------------------------------------

test('rules_apply defaults 级 QPS + program 级侵入白名单 + scope.rules.changed', async () => {
  const { dir, bus } = makeEnv(SEED)
  const r1 = await bus.dispatch('scope', 'rules_apply', { target: 'defaults', rate_limit_qps: 120 }, { actor: 'dashboard' })
  assert.equal(r1.ok, true)
  assert.equal(r1.data.before.rate_limit_qps, 50)
  assert.equal(r1.data.after.rate_limit_qps, 120)
  const ev = readEvents(dir).find((e) => e.name === 'scope.rules.changed' && e.payload.level === 'defaults')
  assert.ok(ev)
  const r2 = await bus.dispatch('scope', 'rules_apply', { target: 'program', program_name: 'example-src', allow_intrusive_tools_add: ['sqlmap'] }, { actor: 'approval' })
  assert.equal(r2.ok, true)
  assert.ok(r2.data.after.allow_intrusive_tools.includes('sqlmap'))
  const txt = readScope(dir)
  assert.ok(txt.includes('rate_limit_qps: 120'))
  assert.ok(txt.includes('sqlmap'))
})

test('rules_apply 非法: defaults 级传 max_risk → E_SCOPE_RULES_INVALID', async () => {
  const { bus } = makeEnv()
  const r = await bus.dispatch('scope', 'rules_apply', { target: 'defaults', max_risk: 'intrusive' }, { actor: 'dashboard' })
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'E_SCOPE_RULES_INVALID')
})

// ---------------------------------------------------------------------------
// 5. actor 白名单
// ---------------------------------------------------------------------------

test('actor: model 不可 grant/revoke/rules_apply → E_ACTOR_FORBIDDEN', async () => {
  const { bus } = makeEnv()
  const r1 = await bus.dispatch('scope', 'grant', { program_name: 'x-src', entries: ['x.com'] }, { actor: 'model', session_id: 's1' })
  assert.equal(r1.ok, false)
  assert.equal(r1.error.code, 'E_ACTOR_FORBIDDEN')
  const r2 = await bus.dispatch('scope', 'revoke', { program_name: 'x-src', entries: ['x.com'] }, { actor: 'model', session_id: 's1' })
  assert.equal(r2.ok, false)
  assert.equal(r2.error.code, 'E_ACTOR_FORBIDDEN')
})

// ---------------------------------------------------------------------------
// 6. scope_check 算法
// ---------------------------------------------------------------------------

test('scope_check: 命中授权 / 命中排除 / fail-closed', async () => {
  const { bus } = makeEnv(SEED)
  const ok = await bus.query('scope', 'check', { target: 'https://api.example.com:8443/v1' }, { actor: 'model' })
  assert.equal(ok.ok, true)
  assert.equal(ok.data.allow, true)
  assert.equal(ok.data.program, 'example-src')
  assert.equal(ok.data.matched_kind, 'wildcard')
  const excluded = await bus.query('scope', 'check', { target: 'pay.example.com' }, { actor: 'model' })
  assert.equal(excluded.data.allow, false)
  assert.equal(excluded.data.excluded_by, 'pay.example.com')
  const denied = await bus.query('scope', 'check', { target: 'unknown-corp.com' }, { actor: 'model' })
  assert.equal(denied.data.allow, false)
  assert.ok(denied.data.reason.includes('fail-closed'))
})

// ---------------------------------------------------------------------------
// 7. cred_add
// ---------------------------------------------------------------------------

test('cred_add: host 在授权范围 + ref 存在 → 成功；host 越界 → E_SCOPE_CRED_HOST_OUT_OF_SCOPE', async () => {
  process.env.SEC_TEST_TOKEN = 'abc123'
  const { bus } = makeEnv(SEED)
  const ok = await bus.dispatch('scope', 'cred_add', { program_id: 'example-src', host: 'api.example.com', cred_type: 'token', ref: 'SEC_TEST_TOKEN' }, { actor: 'model', session_id: 's1' })
  assert.equal(ok.ok, true)
  assert.ok(ok.data.id)
  const out = await bus.dispatch('scope', 'cred_add', { host: 'evil.com', cred_type: 'token', ref: 'SEC_TEST_TOKEN' }, { actor: 'model', session_id: 's1' })
  assert.equal(out.ok, false)
  assert.equal(out.error.code, 'E_SCOPE_CRED_HOST_OUT_OF_SCOPE')
  const missing = await bus.dispatch('scope', 'cred_add', { host: 'api.example.com', ref: 'NO_SUCH_VAR_XYZ' }, { actor: 'model', session_id: 's1' })
  assert.equal(missing.ok, false)
  assert.equal(missing.error.code, 'E_SCOPE_CRED_REF_MISSING')
})

// ---------------------------------------------------------------------------
// 8. 幂等
// ---------------------------------------------------------------------------

test('幂等: grant 同参重放 → replay:true', async () => {
  const { bus } = makeEnv()
  const args = { program_name: 'idem-src', entries: ['idem.com'] }
  const r1 = await bus.dispatch('scope', 'grant', args, { actor: 'dashboard' })
  const r2 = await bus.dispatch('scope', 'grant', args, { actor: 'dashboard' })
  assert.equal(r1.ok, true)
  assert.equal(r2.ok, true)
  assert.equal(r2.replay, true)
})

// ---------------------------------------------------------------------------
// 9. 总线集成
// ---------------------------------------------------------------------------

test('总线集成: bus_status scope registered:true + 命令/查询计数', async () => {
  const { bus } = makeEnv()
  const st = await bus.query('bus', 'status', {}, { actor: 'dashboard' })
  const scope = st.data.domains.find((d) => d.domain === 'scope')
  assert.ok(scope)
  assert.equal(scope.registered, true)
  assert.equal(scope.commands, Object.keys(SCOPE_MANIFEST.commands).length)
  assert.equal(scope.queries, Object.keys(SCOPE_MANIFEST.queries).length)
})

test('scope_list: yml 与镜像同框返回', async () => {
  const { bus } = makeEnv(SEED)
  const r = await bus.query('scope', 'list', {}, { actor: 'dashboard' })
  assert.equal(r.ok, true)
  assert.equal(r.data.defaults.rate_limit_qps, 50)
  assert.equal(r.data.programs.length, 1)
  assert.equal(r.data.programs[0].name, 'example-src')
  assert.ok(Array.isArray(r.data.programs[0].scope))
  assert.ok(r.data.programs[0].db)
  assert.equal(r.data.programs[0].db.status, 'active')
})
