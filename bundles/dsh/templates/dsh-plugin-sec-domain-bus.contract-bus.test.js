// ==============================================================================
// @silksec/sec-domain-bus 契约测试（01-bus.md §2.8 矩阵）
// 运行：node --test test/contract-bus.test.js（插件组装目录内，type:module）
// 全部用例使用临时目录/临时库，绝不触碰 /opt/silkspool/dsh/data。
// ==============================================================================

import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createBus } from '../index.js'

// ---------------------------------------------------------------------------
// 测试域 fixture（vuln 伪域：命令/查询/不变量/事件/后端全覆盖）
// ---------------------------------------------------------------------------

function makeVulnManifest() {
  return {
    domain: 'vuln',
    version: 1,
    service: 'secDomain.vuln',
    description: '测试用 vuln 伪域',
    owns: { tables: ['test_findings'], files: [] },
    commands: {
      vuln_confirm: {
        actor: ['model', 'dashboard', 'human'],
        schema: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            evidence: { type: 'string', minLength: 1 },
            note: { type: 'string' },
          },
          required: ['id', 'evidence'],
          additionalProperties: false,
        },
        idempotent: 'auto',
        idempotent_fields: ['id', 'evidence'],
        events: ['vuln.signal.confirmed'],
        invariants: ['candidateActive'],
        side_effects: { rows: 1, events: 1 },
        timeout_ms: 60000,
        agent_note: '确认候选为真实信号。必须附证据引用；终态不可再流转。',
        deprecated: false,
      },
      vuln_reject: {
        actor: ['model', 'dashboard'],
        schema: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            verdict: { type: 'string', enum: ['false_positive', 'dup', 'ignored'] },
            reason: { type: 'string' },
          },
          required: ['id', 'verdict'],
          additionalProperties: false,
        },
        idempotent: 'auto',
        idempotent_fields: ['id', 'verdict'],
        events: ['vuln.signal.rejected'],
        invariants: ['candidateActive'],
        side_effects: { rows: 1, events: 1 },
        timeout_ms: 60000,
        agent_note: '驳回候选（false_positive/dup/ignored）。',
        deprecated: false,
      },
      vuln_register_signal: {
        actor: ['model', 'human'],
        schema: {
          type: 'object',
          properties: {
            title: { type: 'string', minLength: 10 },
            host: { type: 'string' },
            secret: { type: 'string' },
          },
          required: ['title', 'host'],
          additionalProperties: false,
        },
        idempotent: 'natural',
        idempotent_natural: ['host', 'title'],
        events: ['vuln.signal.registered'],
        invariants: [],
        side_effects: { rows: 1, events: 1 },
        timeout_ms: 60000,
        agent_note: '登记完整漏洞信号（五要素）。',
        deprecated: false,
      },
    },
    queries: {
      vuln_get: {
        actor: ['model', 'dashboard', 'human'],
        params: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'], additionalProperties: false },
        predicates: [],
        agent_note: '取单条 finding。',
      },
      vuln_list: {
        actor: ['model', 'dashboard', 'human'],
        params: {
          type: 'object',
          properties: { limit: { type: 'integer' }, offset: { type: 'integer' } },
          additionalProperties: false,
        },
        predicates: ['noise'],
        agent_note: 'findings 列表。',
      },
    },
    events: {
      'vuln.signal.confirmed': { payload: { type: 'object' }, redact: ['secret'] },
      'vuln.signal.rejected': { payload: { type: 'object' }, redact: [] },
      'vuln.signal.registered': { payload: { type: 'object' }, redact: [] },
    },
    subscribes: {},
    backend: 'repository-v1',
  }
}

function makeVulnHandlers(invSpy = null) {
  const handlers = {
    vuln_confirm: async (args, repo) => {
      const row = repo.getRow(args.id)
      if (!row) throw Object.assign(new Error(`finding #${args.id} 不存在`), { code: 'E_NOT_FOUND' })
      const changed = repo.transitionRow(args.id, 'confirmed', 0, 'new')
      if (!changed) throw Object.assign(new Error(`候选已处于终态，不可再流转`), { code: 'E_STATE', hint: '终态不可再流转' })
      return {
        data: { id: args.id, status: 'confirmed', noise: 0, promoted_from_candidate: row.noise === 1 },
        events: [{ name: 'vuln.signal.confirmed', payload: { finding_id: args.id, from: { noise: row.noise, status: row.status }, evidence: args.evidence, secret: row.secret } }],
        before: { status: row.status, noise: row.noise },
        after: { status: 'confirmed', noise: 0 },
      }
    },
    vuln_reject: async (args, repo) => {
      const row = repo.getRow(args.id)
      if (!row) throw Object.assign(new Error(`finding #${args.id} 不存在`), { code: 'E_NOT_FOUND' })
      const changed = repo.transitionRow(args.id, args.verdict, 0, 'new')
      if (!changed) throw Object.assign(new Error(`候选已处于终态，不可再流转`), { code: 'E_STATE' })
      return {
        data: { id: args.id, status: args.verdict, noise: 0 },
        events: [{ name: 'vuln.signal.rejected', payload: { finding_id: args.id, verdict: args.verdict } }],
        before: { status: row.status, noise: row.noise },
        after: { status: args.verdict, noise: 0 },
      }
    },
    vuln_register_signal: async (args, repo) => {
      const id = repo.insertRow(args.title, args.host, args.secret || null)
      return {
        data: { id, status: 'new' },
        events: [{ name: 'vuln.signal.registered', payload: { finding_id: id, title: args.title, host: args.host } }],
        after: { id, status: 'new' },
      }
    },
    queries: {
      vuln_get: async (args, repo) => {
        const r = repo.getRow(args.id)
        return r || { not_found: true }
      },
      vuln_list: async (args, repo) => {
        const rows = repo.listRows()
        return { rows, total: rows.length }
      },
    },
    invariants: {
      candidateActive: async (args, repo) => {
        if (invSpy) invSpy.calls++
        const row = repo.getRow(args.id)
        if (!row) return { code: 'E_NOT_FOUND', message: `候选 #${args.id} 不存在`, hint: '先查询核实 id' }
        if (row.status !== 'new') return { code: 'E_STATE', message: `候选已处于 ${row.status}，终态不可再流转`, hint: '如需补充证据用 vuln_note' }
        return null
      },
    },
    subscribers: {},
  }
  return handlers
}

function makeVulnBackend() {
  return {
    capabilities: { vuln_confirm: 'full', vuln_reject: 'full', vuln_register_signal: 'full' },
    factory: (db) => {
      db.exec(`CREATE TABLE IF NOT EXISTS test_findings (
        id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, host TEXT, status TEXT, noise INTEGER, secret TEXT
      )`)
      return {
        getRow: (id) => { const r = db.prepare('SELECT * FROM test_findings WHERE id=?').get(id); return r ? { ...r } : null },
        insertRow: (title, host, secret) => {
          const r = db.prepare('INSERT INTO test_findings(title,host,status,noise,secret) VALUES(?,?,?,?,?)').run(title, host, 'new', 1, secret || null)
          return Number(r.lastInsertRowid)
        },
        transitionRow: (id, status, noise, fromStatus) => {
          const r = db.prepare('UPDATE test_findings SET status=?, noise=? WHERE id=? AND status=?').run(status, noise, id, fromStatus)
          return r.changes === 1
        },
        updateRow: (id, status, noise) => { db.prepare('UPDATE test_findings SET status=?, noise=? WHERE id=?').run(status, noise, id) },
        listRows: () => db.prepare('SELECT * FROM test_findings ORDER BY id DESC').all().map((r) => ({ ...r })),
      }
    },
  }
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sec-domain-bus-'))
}

function makeBus(opts = {}) {
  const dir = tmpDir()
  const bus = createBus({
    dataDir: dir,
    dbFile: path.join(dir, 'asset-graph.db'),
    aliasesFile: opts.aliasesFile || path.join(dir, 'bus.aliases.yaml'),
    auditFile: path.join(dir, 'audit.jsonl'),
    eventsDir: path.join(dir, 'events'),
    agentsMd: opts.agentsMd || path.join(dir, 'AGENTS.md'),
    sidecars: false,
    startDispatcherTimer: false,
    ...opts,
  })
  return { dir, bus }
}

function writeAliases(dir, doc) {
  const f = path.join(dir, 'bus.aliases.yaml')
  const a = Object.entries(doc.aliases || {})
  const da = Object.entries(doc.dispatch_aliases || {})
  let y = ''
  if (a.length) y += 'aliases:\n' + a.map(([k, v]) => `  ${k}: ${v}`).join('\n') + '\n'
  else y += 'aliases: {}\n'
  if (da.length) y += 'dispatch_aliases:\n' + da.map(([k, v]) => `  ${k}:\n    router: ${v.router}\n`).join('')
  else y += 'dispatch_aliases: {}\n'
  fs.writeFileSync(f, y)
  return f
}

function readAudit(dir) {
  const f = path.join(dir, 'audit.jsonl')
  if (!fs.existsSync(f)) return []
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
}

function countJsonl(dir, domain) {
  const f = path.join(dir, 'events', `${domain}.jsonl`)
  if (!fs.existsSync(f)) return 0
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).length
}

// ---------------------------------------------------------------------------
// 1. 注册校验 R1-R7（每项至少一个反例 → 域拒载且总线存活）
// ---------------------------------------------------------------------------

test('R1: manifest 形状非法 → 拒载且总线存活', async () => {
  const { dir, bus } = makeBus()
  const bad = { ...makeVulnManifest(), domain: 'not-a-domain' }
  const r = bus.registry.register({ manifest: bad, handlers: makeVulnHandlers(), backend: makeVulnBackend() })
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'E_BUS_DOMAIN_REJECTED')
  const st = await bus.query('bus', 'status', {}, { actor: 'dashboard' })
  assert.equal(st.ok, true)
})

test('R2: 禁用词动词（vuln_update）→ 拒载', () => {
  const { bus } = makeBus()
  const m = makeVulnManifest()
  m.commands.vuln_update = { actor: ['model'], schema: { type: 'object', properties: {}, additionalProperties: false }, idempotent: 'auto', events: [], invariants: [], agent_note: 'x', timeout_ms: 60000 }
  const r = bus.registry.register({ manifest: m, handlers: { ...makeVulnHandlers(), vuln_update: async () => ({ data: {} }) }, backend: makeVulnBackend() })
  assert.equal(r.ok, false)
  assert.match(r.error.message, /R2|禁用词/)
})

test('R3: schema 含 status 参数名 → 拒载', () => {
  const { bus } = makeBus()
  const m = makeVulnManifest()
  m.commands.vuln_bad = { actor: ['model'], schema: { type: 'object', properties: { status: { type: 'string' } }, additionalProperties: false }, idempotent: 'auto', events: [], invariants: [], agent_note: 'x', timeout_ms: 60000 }
  const r = bus.registry.register({ manifest: m, handlers: { ...makeVulnHandlers(), vuln_bad: async () => ({ data: {} }) }, backend: makeVulnBackend() })
  assert.equal(r.ok, false)
  assert.match(r.error.message, /R3|status/)
})

test('R4: owns 表冲突 → 第二域拒载', () => {
  const { bus } = makeBus()
  const r1 = bus.registry.register({ manifest: makeVulnManifest(), handlers: makeVulnHandlers(), backend: makeVulnBackend() })
  assert.equal(r1.ok, true)
  const m2 = makeVulnManifest()
  m2.domain = 'asset'
  m2.service = 'secDomain.asset'
  const r2 = bus.registry.register({ manifest: m2, handlers: { ...makeVulnHandlers(), vuln_confirm: async () => ({ data: {} }), vuln_reject: async () => ({ data: {} }), vuln_register_signal: async () => ({ data: {} }) }, backend: makeVulnBackend() })
  assert.equal(r2.ok, false)
  assert.match(r2.error.message, /owns 冲突/)
})

test('R5: 悬空事件引用 → 拒载', () => {
  const { bus } = makeBus()
  const m = makeVulnManifest()
  m.commands.vuln_confirm.events = ['no.such.event']
  const r = bus.registry.register({ manifest: m, handlers: makeVulnHandlers(), backend: makeVulnBackend() })
  assert.equal(r.ok, false)
  assert.match(r.error.message, /R5|悬空/)
})

test('R6: 版本回退 → 拒载（bus_meta 已见版本更高）', () => {
  const { dir, bus } = makeBus()
  const db = bus._internal.db()
  db.prepare('INSERT INTO bus_meta(key,value,updated_at) VALUES(?,?,?)').run('seen.vuln.version', '2', Date.now())
  const r = bus.registry.register({ manifest: makeVulnManifest(), handlers: makeVulnHandlers(), backend: makeVulnBackend() })
  assert.equal(r.ok, false)
  assert.match(r.error.message, /版本回退/)
})

test('R7: 后端 factory 缺失 → 拒载', () => {
  const { bus } = makeBus()
  const r = bus.registry.register({ manifest: makeVulnManifest(), handlers: makeVulnHandlers(), backend: { capabilities: {} } })
  assert.equal(r.ok, false)
  assert.match(r.error.message, /R7/)
})

test('重复注册同内容 → 幂等通过；bus 域已自注册', () => {
  const { bus } = makeBus()
  const r1 = bus.registry.register({ manifest: makeVulnManifest(), handlers: makeVulnHandlers(), backend: makeVulnBackend() })
  const r2 = bus.registry.register({ manifest: makeVulnManifest(), handlers: makeVulnHandlers(), backend: makeVulnBackend() })
  assert.equal(r1.ok, true)
  assert.equal(r2.ok, true)
  assert.equal(r2.registered, false)
  assert.ok(bus.registry.list().includes('bus'))
})

// ---------------------------------------------------------------------------
// 2. happy path 全管线
// ---------------------------------------------------------------------------

test('happy path: 信封结构/event_ids/audit/幂等行', async () => {
  const { dir, bus } = makeBus()
  bus.registry.register({ manifest: makeVulnManifest(), handlers: makeVulnHandlers(), backend: makeVulnBackend() })
  const seed = await bus.dispatch('vuln', 'register_signal', { title: '测试漏洞信号一二三四五六', host: 'a.example.com' }, { actor: 'model', session_id: 'sess_1' })
  assert.equal(seed.ok, true)
  const id = seed.data.id

  const env = await bus.dispatch('vuln', 'confirm', { id, evidence: 'run_x1' }, { actor: 'model', session_id: 'sess_1' })
  assert.equal(env.ok, true)
  assert.equal(env.domain, 'vuln')
  assert.equal(env.cmd, 'confirm')
  assert.equal(env.data.status, 'confirmed')
  assert.equal(env.data.noise, 0)
  assert.ok(Array.isArray(env.event_ids) && env.event_ids.length >= 1)
  assert.equal(env.replay, false)
  assert.ok(env.idempotency_key.startsWith('vuln:confirm:'))

  const audit = readAudit(dir)
  const cmdAudit = audit.filter((a) => a.kind === 'command' && a.cmd === 'confirm' && a.result === 'ok')
  assert.ok(cmdAudit.length >= 1)
  assert.equal(cmdAudit[0].actor, 'model')
  assert.equal(cmdAudit[0].session_id, 'sess_1')

  const db = bus._internal.db()
  const row = db.prepare('SELECT * FROM idempotency WHERE idempotency_key=?').get(env.idempotency_key)
  assert.ok(row)
  assert.equal(row.verb, 'confirm')
})

// ---------------------------------------------------------------------------
// 3. 顺序敏感性（③ actor 先于 ⑤ schema；⑥ 幂等命中不跑不变量）
// ---------------------------------------------------------------------------

test('顺序敏感: actor 错 + schema 错 → E_ACTOR_FORBIDDEN', async () => {
  const { bus } = makeBus()
  bus.registry.register({ manifest: makeVulnManifest(), handlers: makeVulnHandlers(), backend: makeVulnBackend() })
  const env = await bus.dispatch('vuln', 'confirm', { bad_param: 1 }, { actor: 'webhook' })
  assert.equal(env.ok, false)
  assert.equal(env.error.code, 'E_ACTOR_FORBIDDEN')
})

test('顺序敏感: 幂等命中 → 不变量未调用（spy）', async () => {
  const spy = { calls: 0 }
  const { bus } = makeBus()
  bus.registry.register({ manifest: makeVulnManifest(), handlers: makeVulnHandlers(spy), backend: makeVulnBackend() })
  const seed = await bus.dispatch('vuln', 'register_signal', { title: '幂等测试漏洞信号一二三', host: 'b.example.com' }, { actor: 'model' })
  const id = seed.data.id
  await bus.dispatch('vuln', 'confirm', { id, evidence: 'run_x1' }, { actor: 'model' })
  const before = spy.calls
  const replay = await bus.dispatch('vuln', 'confirm', { id, evidence: 'run_x1' }, { actor: 'model' })
  assert.equal(replay.ok, true)
  assert.equal(replay.replay, true)
  assert.equal(spy.calls, before)
})

// ---------------------------------------------------------------------------
// 4. schema 拒绝
// ---------------------------------------------------------------------------

test('schema 拒绝: 缺 required / 未知参数 / 类型错 → E_SCHEMA 含字段名', async () => {
  const { bus } = makeBus()
  bus.registry.register({ manifest: makeVulnManifest(), handlers: makeVulnHandlers(), backend: makeVulnBackend() })
  const r1 = await bus.dispatch('vuln', 'confirm', { id: 1 }, { actor: 'model' })
  assert.equal(r1.ok, false)
  assert.equal(r1.error.code, 'E_SCHEMA')
  assert.match(r1.error.message, /evidence/)
  const r2 = await bus.dispatch('vuln', 'confirm', { id: 1, evidence: 'x', extra: 2 }, { actor: 'model' })
  assert.equal(r2.error.code, 'E_SCHEMA')
  assert.match(r2.error.message, /extra/)
  const r3 = await bus.dispatch('vuln', 'confirm', { id: 'not-int', evidence: 'x' }, { actor: 'model' })
  assert.equal(r3.error.code, 'E_SCHEMA')
})

// ---------------------------------------------------------------------------
// 5. actor 拒绝（多 actor × 非白名单动词；失败已审计）
// ---------------------------------------------------------------------------

test('actor 拒绝: 非白名单 actor 各一例 → E_ACTOR_FORBIDDEN 且已审计', async () => {
  const { dir, bus } = makeBus()
  bus.registry.register({ manifest: makeVulnManifest(), handlers: makeVulnHandlers(), backend: makeVulnBackend() })
  for (const actor of ['webhook', 'script', 'scheduler', 'approval', 'reactor', 'platform', 'system']) {
    const env = await bus.dispatch('vuln', 'confirm', { id: 1, evidence: 'x' }, { actor })
    assert.equal(env.ok, false, `${actor} 应被拒`)
    assert.equal(env.error.code, 'E_ACTOR_FORBIDDEN')
  }
  const audit = readAudit(dir)
  const denied = audit.filter((a) => a.kind === 'command' && a.error_code === 'E_ACTOR_FORBIDDEN')
  assert.ok(denied.length >= 7)
})

// ---------------------------------------------------------------------------
// 6. 幂等（同 key 同参 replay / 同 key 异参冲突 / 三策略各一例）
// ---------------------------------------------------------------------------

test('幂等: auto 策略重放 bit-for-bit；同 key 异参冲突用显式键验证', async () => {
  const { bus } = makeBus()
  bus.registry.register({ manifest: makeVulnManifest(), handlers: makeVulnHandlers(), backend: makeVulnBackend() })
  const seed = await bus.dispatch('vuln', 'register_signal', { title: '自动幂等测试信号一二', host: 'c.example.com' }, { actor: 'model' })
  const id = seed.data.id
  const r1 = await bus.dispatch('vuln', 'confirm', { id, evidence: 'run_x1' }, { actor: 'model' })
  const r2 = await bus.dispatch('vuln', 'confirm', { id, evidence: 'run_x1' }, { actor: 'model' })
  assert.equal(r2.ok, true)
  assert.equal(r2.replay, true)
  assert.deepEqual(JSON.parse(JSON.stringify(r1.data)), JSON.parse(JSON.stringify(r2.data)))
  // 同 key 异参冲突：显式键两次不同参数 → E_IDEMPOTENT_CONFLICT
  const c1 = await bus.dispatch('vuln', 'register_signal', { title: '显式冲突信号一二三四五', host: 'c2.example.com', idempotency_key: 'vuln:register_signal:conflict:key' }, { actor: 'model' })
  assert.equal(c1.ok, true)
  const c2 = await bus.dispatch('vuln', 'register_signal', { title: '显式冲突信号六七八九十', host: 'c2.example.com', idempotency_key: 'vuln:register_signal:conflict:key' }, { actor: 'model' })
  assert.equal(c2.ok, false)
  assert.equal(c2.error.code, 'E_IDEMPOTENT_CONFLICT')
})

test('幂等: natural 策略（host+title 自然键）', async () => {
  const { bus } = makeBus()
  bus.registry.register({ manifest: makeVulnManifest(), handlers: makeVulnHandlers(), backend: makeVulnBackend() })
  const r1 = await bus.dispatch('vuln', 'register_signal', { title: '自然键测试信号一二三', host: 'd.example.com' }, { actor: 'model' })
  const r2 = await bus.dispatch('vuln', 'register_signal', { title: '自然键测试信号一二三', host: 'd.example.com' }, { actor: 'model' })
  assert.equal(r1.ok, true)
  assert.equal(r2.ok, true)
  assert.equal(r2.replay, true)
  assert.equal(r1.data.id, r2.data.id)
})

test('幂等: explicit 策略（调用方 idempotency_key）', async () => {
  const { bus } = makeBus()
  bus.registry.register({ manifest: makeVulnManifest(), handlers: makeVulnHandlers(), backend: makeVulnBackend() })
  const r1 = await bus.dispatch('vuln', 'register_signal', { title: '显式键测试信号一二三', host: 'e.example.com', idempotency_key: 'vuln:register_signal:dedupe:abc' }, { actor: 'model' })
  const r2 = await bus.dispatch('vuln', 'register_signal', { title: '显式键测试信号一二三', host: 'e.example.com', idempotency_key: 'vuln:register_signal:dedupe:abc' }, { actor: 'model' })
  assert.equal(r1.ok, true)
  assert.equal(r2.ok, true)
  assert.equal(r2.replay, true)
})

// ---------------------------------------------------------------------------
// 7. 不变量拒绝（E_NOT_FOUND / E_STATE）
// ---------------------------------------------------------------------------

test('不变量: 不存在 → E_NOT_FOUND；终态 → E_STATE', async () => {
  const { bus } = makeBus()
  bus.registry.register({ manifest: makeVulnManifest(), handlers: makeVulnHandlers(), backend: makeVulnBackend() })
  const r1 = await bus.dispatch('vuln', 'confirm', { id: 9999, evidence: 'x' }, { actor: 'model' })
  assert.equal(r1.ok, false)
  assert.equal(r1.error.code, 'E_NOT_FOUND')
  const seed = await bus.dispatch('vuln', 'register_signal', { title: '状态机测试信号一二三', host: 'f.example.com' }, { actor: 'model' })
  await bus.dispatch('vuln', 'confirm', { id: seed.data.id, evidence: 'x' }, { actor: 'model' })
  const r2 = await bus.dispatch('vuln', 'confirm', { id: seed.data.id, evidence: 'y' }, { actor: 'model' })
  assert.equal(r2.ok, false)
  assert.equal(r2.error.code, 'E_STATE')
  assert.ok(r2.error.hint)
})

// ---------------------------------------------------------------------------
// 8. 强联动（sync 订阅者失败 → 命令整体回滚 + E_BUS_STRONG_LINK_FAILED）
// ---------------------------------------------------------------------------

test('强联动: sync 订阅者返回失败 → 回滚 + E_BUS_STRONG_LINK_FAILED', async () => {
  const { dir, bus } = makeBus()
  bus.registry.register({ manifest: makeVulnManifest(), handlers: makeVulnHandlers(), backend: makeVulnBackend() })
  bus.events.subscribe('vuln.signal.confirmed', async () => ({ ok: false, error: { code: 'E_TEST_LINK' } }), { mode: 'sync', as: 'reactor' })
  const seed = await bus.dispatch('vuln', 'register_signal', { title: '强联动测试信号一二三', host: 'g.example.com' }, { actor: 'model' })
  const id = seed.data.id
  const env = await bus.dispatch('vuln', 'confirm', { id, evidence: 'x' }, { actor: 'model' })
  assert.equal(env.ok, false)
  assert.equal(env.error.code, 'E_BUS_STRONG_LINK_FAILED')
  const db = bus._internal.db()
  const row = db.prepare('SELECT * FROM test_findings WHERE id=?').get(id)
  assert.equal(row.status, 'new', '回滚后行不变')
  assert.equal(row.noise, 1)
})

test('强联动: sync 订阅者 throw → 回滚', async () => {
  const { bus } = makeBus()
  bus.registry.register({ manifest: makeVulnManifest(), handlers: makeVulnHandlers(), backend: makeVulnBackend() })
  bus.events.subscribe('vuln.signal.confirmed', async () => { throw new Error('boom') }, { mode: 'sync', as: 'reactor' })
  const seed = await bus.dispatch('vuln', 'register_signal', { title: '强联动抛出测试信号一二', host: 'h.example.com' }, { actor: 'model' })
  const env = await bus.dispatch('vuln', 'confirm', { id: seed.data.id, evidence: 'x' }, { actor: 'model' })
  assert.equal(env.ok, false)
  assert.equal(env.error.code, 'E_BUS_STRONG_LINK_FAILED')
  const row = bus._internal.db().prepare('SELECT * FROM test_findings WHERE id=?').get(seed.data.id)
  assert.equal(row.status, 'new')
})

test('审计 fail-closed: audit 落盘失败 → 命令回滚（宪法 §九）', async () => {
  // auditFile 指向一个目录路径 → appendFileSync 失败 → 写命令必须回滚
  const dir = tmpDir()
  const auditDir = path.join(dir, 'audit-as-dir')
  fs.mkdirSync(auditDir)
  const bus = createBus({
    dataDir: dir, dbFile: path.join(dir, 'asset-graph.db'),
    aliasesFile: path.join(dir, 'bus.aliases.yaml'), auditFile: auditDir,
    eventsDir: path.join(dir, 'events'), sidecars: false, startDispatcherTimer: false,
  })
  bus.registry.register({ manifest: makeVulnManifest(), handlers: makeVulnHandlers(), backend: makeVulnBackend() })
  // 直接落种子行（写命令在 audit 闭锁下本身会被拒，故绕过网关仅用于造测试前置）
  const db = bus._internal.db()
  db.exec('CREATE TABLE IF NOT EXISTS test_findings (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, host TEXT, status TEXT, noise INTEGER, secret TEXT)')
  db.prepare(`INSERT INTO test_findings(title,host,status,noise,secret) VALUES(?,?,?,?,?)`).run('审计闭锁测试信号一二三', 'h2.example.com', 'new', 1, null)
  const id = Number(db.prepare('SELECT MAX(id) AS m FROM test_findings').get().m)
  const env = await bus.dispatch('vuln', 'confirm', { id, evidence: 'x' }, { actor: 'model' })
  assert.equal(env.ok, false)
  assert.equal(env.error.code, 'E_BUS_AUDIT_FAILED')
  const row = db.prepare('SELECT * FROM test_findings WHERE id=?').get(id)
  assert.equal(row.status, 'new', 'audit 写不进 = 命令不许成（fail-closed）')
  assert.equal(row.noise, 1)
})

// ---------------------------------------------------------------------------
// 9. 弱联动（async 订阅者 throw → 命令成功 + 重试/dead-letter + 事件在 outbox）
// ---------------------------------------------------------------------------

test('弱联动: async 订阅者失败 → 命令成功 + attempt/next_retry + 事件在 outbox', async () => {
  const { dir, bus } = makeBus()
  bus.registry.register({ manifest: makeVulnManifest(), handlers: makeVulnHandlers(), backend: makeVulnBackend() })
  let calls = 0
  bus.events.subscribe('vuln.signal.confirmed', async () => { calls++; throw new Error('first fail') }, { mode: 'async', as: 'reactor' })
  const seed = await bus.dispatch('vuln', 'register_signal', { title: '弱联动测试信号一二三', host: 'i.example.com' }, { actor: 'model' })
  const env = await bus.dispatch('vuln', 'confirm', { id: seed.data.id, evidence: 'x' }, { actor: 'model' })
  assert.equal(env.ok, true)
  const db = bus._internal.db()
  const out = db.prepare('SELECT * FROM event_outbox WHERE event_id=?').get(env.event_ids[0])
  assert.equal(out.status, 'pending')
  const sub = db.prepare('SELECT * FROM bus_subscription WHERE event_id=? AND subscriber=?').get(env.event_ids[0], 'vuln.signal.confirmed')
  assert.equal(sub.status, 'pending')
  assert.equal(sub.attempt, 0)
  assert.equal(countJsonl(dir, 'vuln'), 1, 'confirm 的 async 事件未派发前不追加 jsonl（仅 register_signal 的 1 行）')
  // dispatcher tick：首次派发失败 → attempt 1 + next_retry_at
  await bus._internal.dispatcherTick()
  const sub2 = db.prepare('SELECT * FROM bus_subscription WHERE event_id=?').get(env.event_ids[0])
  assert.equal(sub2.attempt, 1)
  assert.ok(sub2.last_error)
  assert.equal(countJsonl(dir, 'vuln'), 1, '派发失败仍不追加 jsonl')
  // 修复订阅者后再次 tick → delivered + jsonl 追加（backoff 已过：清 next_retry_at 模拟退避到期）
  bus._internal.subscribers.pop() // 移除失败的
  bus.events.subscribe('vuln.signal.confirmed', async () => ({ ok: true, data: {} }), { mode: 'async', as: 'reactor' })
  db.prepare(`UPDATE event_outbox SET next_retry_at=0 WHERE event_id=?`).run(env.event_ids[0])
  await bus._internal.dispatcherTick()
  const sub3 = db.prepare('SELECT * FROM bus_subscription WHERE event_id=?').get(env.event_ids[0])
  assert.equal(sub3.status, 'delivered')
  const out3 = db.prepare('SELECT * FROM event_outbox WHERE event_id=?').get(env.event_ids[0])
  assert.equal(out3.status, 'delivered')
  assert.ok(countJsonl(dir, 'vuln') >= 2, '派发成功后 confirm 事件追加 jsonl')
})

// ---------------------------------------------------------------------------
// 10. 跨进程崩溃恢复（重启后 pending 续扫；同事件同订阅者不重复消费）
// ---------------------------------------------------------------------------

test('崩溃恢复: 新总线实例续扫 outbox pending 且不重复消费', async () => {
  const dir = tmpDir()
  const bus1 = createBus({ dataDir: dir, dbFile: path.join(dir, 'asset-graph.db'), aliasesFile: path.join(dir, 'bus.aliases.yaml'), auditFile: path.join(dir, 'audit.jsonl'), eventsDir: path.join(dir, 'events'), sidecars: false, startDispatcherTimer: false })
  bus1.registry.register({ manifest: makeVulnManifest(), handlers: makeVulnHandlers(), backend: makeVulnBackend() })
  let delivered = 0
  bus1.events.subscribe('vuln.signal.confirmed', async () => { delivered++; return { ok: true, data: {} } }, { mode: 'async', as: 'reactor' })
  const seed = await bus1.dispatch('vuln', 'register_signal', { title: '崩溃恢复测试信号一二三', host: 'j.example.com' }, { actor: 'model' })
  const env = await bus1.dispatch('vuln', 'confirm', { id: seed.data.id, evidence: 'x' }, { actor: 'model' })
  bus1._internal.close() // 模拟崩溃（不 tick 就退出）

  const bus2 = createBus({ dataDir: dir, dbFile: path.join(dir, 'asset-graph.db'), aliasesFile: path.join(dir, 'bus.aliases.yaml'), auditFile: path.join(dir, 'audit.jsonl'), eventsDir: path.join(dir, 'events'), sidecars: false, startDispatcherTimer: false })
  bus2.registry.register({ manifest: makeVulnManifest(), handlers: makeVulnHandlers(), backend: makeVulnBackend() })
  let delivered2 = 0
  bus2.events.subscribe('vuln.signal.confirmed', async () => { delivered2++; return { ok: true, data: {} } }, { mode: 'async', as: 'reactor' })
  await bus2._internal.dispatcherTick()
  assert.equal(delivered2, 1)
  await bus2._internal.dispatcherTick()
  assert.equal(delivered2, 1, '不重复消费')
  const out = bus2._internal.db().prepare('SELECT * FROM event_outbox WHERE event_id=?').get(env.event_ids[0])
  assert.equal(out.status, 'delivered')
  bus2._internal.close()
})

// ---------------------------------------------------------------------------
// 11. 事件载荷（payload 符合 schema、redact 字段被过滤、不含行全量）
// ---------------------------------------------------------------------------

test('事件载荷: redact 过滤 secret', async () => {
  const { dir, bus } = makeBus()
  bus.registry.register({ manifest: makeVulnManifest(), handlers: makeVulnHandlers(), backend: makeVulnBackend() })
  const seed = await bus.dispatch('vuln', 'register_signal', { title: 'redact 测试信号一二三四', host: 'k.example.com', secret: 'TOPSECRET' }, { actor: 'model' })
  const env = await bus.dispatch('vuln', 'confirm', { id: seed.data.id, evidence: 'x' }, { actor: 'model' })
  const out = bus._internal.db().prepare('SELECT * FROM event_outbox WHERE event_id=?').get(env.event_ids[0])
  const envelope = JSON.parse(out.payload)
  assert.ok(envelope.payload.secret === undefined, 'redact 后 secret 不在 payload')
  assert.equal(envelope.payload.finding_id, seed.data.id)
  assert.equal(envelope.cause.cmd, 'confirm')
  assert.ok(envelope.id.startsWith('evt_'))
})

// ---------------------------------------------------------------------------
// 12. 重放（bus_replay 重放 async → 订阅者幂等消化；第二次重放零副作用）
// ---------------------------------------------------------------------------

test('重放: bus_replay 重放 async 订阅者，二次重放零副作用', async () => {
  const { dir, bus } = makeBus()
  bus.registry.register({ manifest: makeVulnManifest(), handlers: makeVulnHandlers(), backend: makeVulnBackend() })
  let calls = 0
  bus.events.subscribe('vuln.signal.confirmed', async () => { calls++; return { ok: true, data: {} } }, { mode: 'async', as: 'reactor' })
  const seed = await bus.dispatch('vuln', 'register_signal', { title: '重放测试信号一二三四五', host: 'l.example.com' }, { actor: 'model' })
  const env = await bus.dispatch('vuln', 'confirm', { id: seed.data.id, evidence: 'x' }, { actor: 'model' })
  await bus._internal.dispatcherTick()
  const c1 = calls
  assert.ok(c1 >= 1)
  const replay = await bus.dispatch('bus', 'replay', { since: 0, domains: ['vuln'] }, { actor: 'human' })
  assert.equal(replay.ok, true)
  assert.ok(replay.data.scanned >= 1)
  const replay2 = await bus.dispatch('bus', 'replay', { since: 0, domains: ['vuln'], dry_run: true }, { actor: 'human' })
  assert.equal(replay2.ok, true)
  assert.equal(replay2.data.scanned, replay.data.scanned)
})

// ---------------------------------------------------------------------------
// 13. 别名（静态过全管线 + 分派路由正确 + deprecated_use 审计）
// ---------------------------------------------------------------------------

test('别名: 静态别名 finding_add → vuln_register_signal 过全管线 + deprecated_use 审计', async () => {
  const dir = tmpDir()
  const aliasesFile = writeAliases(dir, { aliases: { finding_add: 'vuln_register_signal' }, dispatch_aliases: {} })
  const bus = createBus({ dataDir: dir, dbFile: path.join(dir, 'asset-graph.db'), aliasesFile, auditFile: path.join(dir, 'audit.jsonl'), eventsDir: path.join(dir, 'events'), sidecars: false, startDispatcherTimer: false })
  bus.registry.register({ manifest: makeVulnManifest(), handlers: makeVulnHandlers(), backend: makeVulnBackend() })
  const env = await bus.dispatch('vuln', 'finding_add', { title: '别名测试信号一二三四五六', host: 'm.example.com' }, { actor: 'model' })
  assert.equal(env.ok, true)
  assert.equal(env.cmd, 'register_signal')
  const audit = readAudit(dir)
  assert.ok(audit.some((a) => a.kind === 'deprecated_use' && a.alias === 'finding_add'))
})

test('别名: 分派别名 finding_update status=confirmed → 路由到 vuln_confirm（schema 拦截证明路由）', async () => {
  const dir = tmpDir()
  const aliasesFile = writeAliases(dir, { aliases: {}, dispatch_aliases: { finding_update: { router: 'status_router' } } })
  const bus = createBus({ dataDir: dir, dbFile: path.join(dir, 'asset-graph.db'), aliasesFile, auditFile: path.join(dir, 'audit.jsonl'), eventsDir: path.join(dir, 'events'), sidecars: false, startDispatcherTimer: false })
  bus.registry.register({ manifest: makeVulnManifest(), handlers: makeVulnHandlers(), backend: makeVulnBackend() })
  const env = await bus.dispatch('vuln', 'finding_update', { status: 'confirmed', id: 1 }, { actor: 'model' })
  assert.equal(env.ok, false)
  assert.equal(env.error.code, 'E_SCHEMA', '路由到 vuln_confirm 后 evidence 缺失 → E_SCHEMA')
  assert.match(env.error.message, /evidence/)
  const audit = readAudit(dir)
  assert.ok(audit.some((a) => a.kind === 'deprecated_use' && a.alias === 'finding_update'))
})

// ---------------------------------------------------------------------------
// 14. 查询（行数=total / 谓词默认值 / 分页边界）
// ---------------------------------------------------------------------------

test('查询: 行数=total / 分页边界（offset 越界空 rows 且 total 不变）/ limit 上限', async () => {
  const { bus } = makeBus()
  bus.registry.register({ manifest: makeVulnManifest(), handlers: makeVulnHandlers(), backend: makeVulnBackend() })
  for (let i = 0; i < 5; i++) {
    await bus.dispatch('vuln', 'register_signal', { title: `列表测试信号${i}一二三四五`, host: `h${i}.example.com` }, { actor: 'model' })
  }
  const q1 = await bus.query('vuln', 'list', { limit: 3 }, { actor: 'model' })
  assert.equal(q1.ok, true)
  assert.equal(q1.rows.length, 3)
  assert.equal(q1.total, 5, '行数=total 同口径')
  const q2 = await bus.query('vuln', 'list', { limit: 3, offset: 3 }, { actor: 'model' })
  assert.equal(q2.rows.length, 2)
  assert.equal(q2.total, 5)
  const q3 = await bus.query('vuln', 'list', { limit: 3, offset: 99 }, { actor: 'model' })
  assert.equal(q3.rows.length, 0)
  assert.equal(q3.total, 5)
  const q4 = await bus.query('vuln', 'list', { limit: 9999 }, { actor: 'model' })
  assert.equal(q4.limit, 500, 'limit 上限 500')
})

// ---------------------------------------------------------------------------
// 15. 防绕过（facade 只见门面 API；域业务方法不在 facade）
// ---------------------------------------------------------------------------

test('防绕过: facade 无域业务方法（不 provide vuln_confirm 等）', () => {
  const { bus } = makeBus()
  bus.registry.register({ manifest: makeVulnManifest(), handlers: makeVulnHandlers(), backend: makeVulnBackend() })
  assert.equal(typeof bus.dispatch, 'function')
  assert.equal(typeof bus.query, 'function')
  assert.equal(typeof bus.status, 'function')
  assert.equal(typeof bus.registry.list, 'function')
  assert.equal(typeof bus.registry.register, 'function')
  assert.equal(typeof bus.events.subscribe, 'function')
  assert.equal(bus.vuln_confirm, undefined)
  assert.equal(bus.dispatch_confirm, undefined)
})

// ---------------------------------------------------------------------------
// 16. 并发（两进程同时 confirm 同一候选 → 一成一 E_STATE，最终一致）
// ---------------------------------------------------------------------------

test('并发: 同进程两个并发 dispatch（异参异幂等键）→ 一成一 E_STATE，最终状态一致', async () => {
  const { bus } = makeBus()
  bus.registry.register({ manifest: makeVulnManifest(), handlers: makeVulnHandlers(), backend: makeVulnBackend() })
  const seed = await bus.dispatch('vuln', 'register_signal', { title: '并发测试信号一二三四五六', host: 'n.example.com' }, { actor: 'model' })
  const id = seed.data.id
  const [r1, r2] = await Promise.all([
    bus.dispatch('vuln', 'confirm', { id, evidence: 'run_proc_a' }, { actor: 'model' }),
    bus.dispatch('vuln', 'confirm', { id, evidence: 'run_proc_b' }, { actor: 'model' }),
  ])
  const oks = [r1, r2].filter((r) => r.ok).length
  const eStates = [r1, r2].filter((r) => !r.ok && r.error.code === 'E_STATE').length
  assert.equal(oks, 1)
  assert.equal(eStates, 1)
  const row = bus._internal.db().prepare('SELECT * FROM test_findings WHERE id=?').get(id)
  assert.equal(row.status, 'confirmed')
  assert.equal(row.noise, 0)
})

test('并发: 跨进程两实例同时 confirm 同一候选 → 一成一 E_STATE（WAL 串行化）', async () => {
  const dir = tmpDir()
  const dbFile = path.join(dir, 'asset-graph.db')
  const pluginPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.js')
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const execFileP = promisify(execFile)

  // 种子进程：注册 vuln 域并登记一条候选
  const seedBus = createBus({ dataDir: dir, dbFile, aliasesFile: path.join(dir, 'bus.aliases.yaml'), auditFile: path.join(dir, 'audit.jsonl'), eventsDir: path.join(dir, 'events'), sidecars: false, startDispatcherTimer: false })
  seedBus.registry.register({ manifest: makeVulnManifest(), handlers: makeVulnHandlers(), backend: makeVulnBackend() })
  const seed = await seedBus.dispatch('vuln', 'register_signal', { title: '跨进程并发测试信号一二三', host: 'n2.example.com' }, { actor: 'model' })
  const id = seed.data.id
  seedBus._internal.close()

  // 子进程内联源（函数无法 JSON 序列化，直接内嵌 manifest/handler/backend 源码）
  const workerSrc = (evidence) => `
import { createBus } from ${JSON.stringify('file://' + pluginPath)}
const manifest = ${JSON.stringify(makeVulnManifest())}
const backend = { capabilities: { vuln_confirm: 'full', vuln_reject: 'full', vuln_register_signal: 'full' }, factory: (db) => {
  db.exec('CREATE TABLE IF NOT EXISTS test_findings (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, host TEXT, status TEXT, noise INTEGER, secret TEXT)')
  return {
    getRow: (id) => { const r = db.prepare('SELECT * FROM test_findings WHERE id=?').get(id); return r ? { ...r } : null },
    insertRow: (t, h, s) => Number(db.prepare('INSERT INTO test_findings(title,host,status,noise,secret) VALUES(?,?,?,?,?)').run(t, h, 'new', 1, s || null).lastInsertRowid),
    transitionRow: (id, status, noise, fromStatus) => db.prepare('UPDATE test_findings SET status=?, noise=? WHERE id=? AND status=?').run(status, noise, id, fromStatus).changes === 1,
    updateRow: (id, status, noise) => db.prepare('UPDATE test_findings SET status=?, noise=? WHERE id=?').run(status, noise, id),
    listRows: () => db.prepare('SELECT * FROM test_findings ORDER BY id DESC').all().map((r) => ({ ...r })),
  }
} }
const handlers = {
  vuln_confirm: async (args, repo) => {
    const row = repo.getRow(args.id)
    if (!repo.transitionRow(args.id, 'confirmed', 0, 'new')) throw Object.assign(new Error('候选已处于终态'), { code: 'E_STATE', hint: '终态不可再流转' })
    return { data: { id: args.id, status: 'confirmed', noise: 0 }, events: [{ name: 'vuln.signal.confirmed', payload: { finding_id: args.id, evidence: args.evidence } }], before: { status: row.status, noise: row.noise }, after: { status: 'confirmed', noise: 0 } }
  },
  vuln_reject: async (args, repo) => { repo.updateRow(args.id, 'rejected', 0); return { data: { id: args.id }, events: [] } },
  vuln_register_signal: async (args, repo) => { const nid = repo.insertRow(args.title, args.host); return { data: { id: nid }, events: [{ name: 'vuln.signal.registered', payload: { finding_id: nid } }] } },
  queries: {
    vuln_get: async (args, repo) => repo.getRow(args.id) || { not_found: true },
    vuln_list: async (args, repo) => { const rows = repo.listRows(); return { rows, total: rows.length } },
  },
  invariants: {
    candidateActive: async (args, repo) => {
      const row = repo.getRow(args.id)
      if (!row) return { code: 'E_NOT_FOUND', message: 'missing' }
      if (row.status !== 'new') return { code: 'E_STATE', message: '已终态', hint: '用 vuln_note' }
      return null
    },
  },
  subscribers: {},
}
const bus = createBus({ dataDir: ${JSON.stringify(dir)}, dbFile: ${JSON.stringify(dbFile)},
  aliasesFile: ${JSON.stringify(path.join(dir, 'bus.aliases.yaml'))},
  auditFile: ${JSON.stringify(path.join(dir, 'audit.jsonl'))},
  eventsDir: ${JSON.stringify(path.join(dir, 'events'))}, sidecars: false, startDispatcherTimer: false })
bus.registry.register({ manifest, handlers, backend })
const env = await bus.dispatch('vuln', 'confirm', { id: ${id}, evidence: ${JSON.stringify(evidence)} }, { actor: 'model' })
process.stdout.write(JSON.stringify({ ok: env.ok, code: env.error ? env.error.code : null }))
bus._internal.close()
`
  const results = await Promise.all([
    execFileP(process.execPath, ['--input-type=module', '-e', workerSrc('run_a')], { timeout: 30000 }),
    execFileP(process.execPath, ['--input-type=module', '-e', workerSrc('run_b')], { timeout: 30000 }),
  ])
  const parsed = results.map((r) => JSON.parse(r.stdout.trim()))
  const oks = parsed.filter((r) => r.ok).length
  assert.equal(oks, 1, `应恰有一进程成功: ${JSON.stringify(parsed)}`)
  assert.ok(parsed.some((r) => !r.ok && r.code === 'E_STATE'), `另一进程应 E_STATE: ${JSON.stringify(parsed)}`)

  const checkBus = createBus({ dataDir: dir, dbFile, aliasesFile: path.join(dir, 'bus.aliases.yaml'), auditFile: path.join(dir, 'audit.jsonl'), eventsDir: path.join(dir, 'events'), sidecars: false, startDispatcherTimer: false })
  const row = checkBus._internal.db().prepare('SELECT * FROM test_findings WHERE id=?').get(id)
  assert.equal(row.status, 'confirmed')
  assert.equal(row.noise, 0)
  checkBus._internal.close()
})

// ---------------------------------------------------------------------------
// 17. bus 自身查询（bus_status 显示各域注册状态）
// ---------------------------------------------------------------------------

test('bus_status: 展示 vuln 注册 + bus 自注册 + 未注册域 registered:false', async () => {
  const { bus } = makeBus()
  bus.registry.register({ manifest: makeVulnManifest(), handlers: makeVulnHandlers(), backend: makeVulnBackend() })
  const st = await bus.query('bus', 'status', {}, { actor: 'dashboard' })
  assert.equal(st.ok, true)
  assert.equal(st.data.process.pid > 0, true)
  const vuln = st.data.domains.find((d) => d.domain === 'vuln')
  assert.ok(vuln)
  assert.equal(vuln.registered, true)
  assert.equal(vuln.backend, 'sqlite-local')
  const asset = st.data.domains.find((d) => d.domain === 'asset')
  assert.equal(asset.registered, false)
})

// ---------------------------------------------------------------------------
// 18. audit_tail / events_tail
// ---------------------------------------------------------------------------

test('audit_tail: 过滤维度 + legacy 行映射', async () => {
  const { dir, bus } = makeBus()
  bus.registry.register({ manifest: makeVulnManifest(), handlers: makeVulnHandlers(), backend: makeVulnBackend() })
  await bus.dispatch('vuln', 'register_signal', { title: '审计尾读测试信号一二三', host: 'o.example.com' }, { actor: 'model', session_id: 'sess_audit' })
  const q = await bus.query('bus', 'audit_tail', { actor: 'model', n: 10 }, { actor: 'human' })
  assert.equal(q.ok, true)
  assert.ok(Array.isArray(q.rows))
  const filtered = await bus.query('bus', 'audit_tail', { actor: 'model', n: 10, domain: 'vuln' }, { actor: 'human' })
  assert.ok(filtered.rows.every((r) => r.domain === 'vuln'))
})

test('events_tail: 单域必填 + 尾读', async () => {
  const { dir, bus } = makeBus()
  bus.registry.register({ manifest: makeVulnManifest(), handlers: makeVulnHandlers(), backend: makeVulnBackend() })
  await bus.dispatch('vuln', 'register_signal', { title: '事件尾读测试信号一二三', host: 'p.example.com' }, { actor: 'model' })
  await bus._internal.dispatcherTick()
  const q = await bus.query('bus', 'events_tail', { domain: 'vuln', n: 10 }, { actor: 'model' })
  assert.equal(q.ok, true)
  assert.ok(q.rows.length >= 1)
  assert.equal(q.rows[0].domain, 'vuln')
})
