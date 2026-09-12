// ==============================================================================
// @silksec/sec-domain-task 契约测试（05-task.md：happy path / schema / 不变量 / 状态机 /
// actor / 幂等 / 续期锚点 / 查询口径 / 事件载荷 / 别名）
// 运行：node --test test/contract-task.test.js（插件组装目录内，type:module）
// 全部用例使用临时目录/临时库，绝不触碰 /opt/silkspool/dsh/data。
// ==============================================================================

import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createBus } from '../../sec-domain-bus/index.js'
import { buildTaskDomain } from '../index.js'

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'sec-domain-task-')) }

function makeEnv(opts = {}) {
  const dir = tmpDir()
  const dataDir = path.join(dir, 'data')
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(path.join(dataDir, 'scope.yml'), 'programs:\n  - name: "test-src"\n    scope:\n      - "*.example.com"\n')
  if (opts.aliases) fs.writeFileSync(path.join(dir, 'bus.aliases.yaml'), opts.aliases)
  const bus = createBus({
    dataDir,
    dbFile: path.join(dir, 'asset-graph.db'),
    aliasesFile: path.join(dir, 'bus.aliases.yaml'),
    auditFile: path.join(dir, 'audit.jsonl'),
    eventsDir: path.join(dir, 'events'),
    sidecars: false,
    startDispatcherTimer: false,
  })
  // programs 表（scope 域 owns，测试内建最小镜像供 program 反查）
  bus._internal.db().exec(`CREATE TABLE IF NOT EXISTS programs (id TEXT PRIMARY KEY, platform TEXT, status TEXT DEFAULT 'active', max_risk TEXT, workspace_id TEXT, workspace_path TEXT)`)
  bus._internal.db().prepare(`INSERT OR REPLACE INTO programs (id, platform, status, max_risk, workspace_path) VALUES (?, ?, ?, ?, ?)`)
    .run('test-src', 'src', 'active', 'active', '/ws/test-src')
  const domain = buildTaskDomain({ dataDir, dispatch: (d, v, a, c) => bus.dispatch(d, v, a, c), query: (d, n, a, c) => bus.query(d, n, a, c) })
  const reg = bus.registry.register(domain)
  assert.equal(reg.ok, true, `task 域应注册成功：${reg.error?.message || ''}`)
  return { dir, dataDir, bus }
}

function readAudit(dir) {
  const f = path.join(dir, 'audit.jsonl')
  if (!fs.existsSync(f)) return []
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
}
function readEvents(dir) {
  const f = path.join(dir, 'events', 'task.jsonl')
  if (!fs.existsSync(f)) return []
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
}

// ---------------------------------------------------------------------------
// 1. happy path
// ---------------------------------------------------------------------------

test('happy path: task_create(once) 落行 + task.created + audit', async () => {
  const { dir, bus } = makeEnv()
  const r = await bus.dispatch('task', 'create', {
    program_id: 'test-src', phase: 'recon', objective: '一次性侦察', priority: 4,
    schedule: { kind: 'once', at: Date.now() + 3600000 },
  }, { actor: 'model', session_id: 'sess_1' })
  assert.equal(r.ok, true)
  assert.equal(r.data.status, 'queued')
  assert.equal(r.data.schedule.kind, 'once')
  assert.equal(r.data.deduped, false)
  assert.ok(r.event_ids.length === 1)
  assert.ok(readEvents(dir).find((e) => e.name === 'task.created' && e.payload.task_id === r.data.task_id))
  assert.ok(readAudit(dir).find((a) => a.kind === 'command' && a.cmd === 'create' && a.result === 'ok'))
})

test('happy path: interval 固定实体幂等去重（INV-T2 deduped:true）', async () => {
  const { bus } = makeEnv()
  const r1 = await bus.dispatch('task', 'create', { program_id: 'test-src', phase: 'recon', objective: '每日资产巡检', priority: 3, schedule: { kind: 'interval', every_seconds: 86400 } }, { actor: 'model' })
  assert.equal(r1.ok, true)
  assert.equal(r1.data.deduped, false)
  // 异参（priority 不同）同 program+objective 活跃 interval → 不新建，返回已有（deduped:true）
  const r2 = await bus.dispatch('task', 'create', { program_id: 'test-src', phase: 'recon', objective: '每日资产巡检', priority: 5, schedule: { kind: 'interval', every_seconds: 86400 } }, { actor: 'model' })
  assert.equal(r2.ok, true)
  assert.equal(r2.data.deduped, true)
  assert.equal(r2.data.task_id, r1.data.task_id)
  const n = bus._internal.db().prepare("SELECT COUNT(*) AS n FROM tasks WHERE program_id='test-src' AND objective='每日资产巡检'").get().n
  assert.equal(n, 1, 'interval 固定实体仅一行（防任务表增殖）')
})

test('happy path: program 按会话 cwd 自动反查', async () => {
  const { bus } = makeEnv()
  const r = await bus.dispatch('task', 'create', { phase: 'recon', objective: 'cwd 反查任务' }, { actor: 'model', cwd: '/ws/test-src' })
  assert.equal(r.ok, true)
  const row = bus._internal.db().prepare('SELECT program_id FROM tasks WHERE id=?').get(r.data.task_id)
  assert.equal(row.program_id, 'test-src')
})

// ---------------------------------------------------------------------------
// 2. schema / 不变量
// ---------------------------------------------------------------------------

test('schema: 缺 objective / 未知参数被拒', async () => {
  const { bus } = makeEnv()
  const r1 = await bus.dispatch('task', 'create', { program_id: 'test-src' }, { actor: 'model' })
  assert.equal(r1.ok, false)
  assert.equal(r1.error.code, 'E_SCHEMA')
  const r2 = await bus.dispatch('task', 'create', { program_id: 'test-src', objective: 'x', bogus: 1 }, { actor: 'model' })
  assert.equal(r2.ok, false)
  assert.equal(r2.error.code, 'E_SCHEMA')
})

test('invariant: once.at 过去 → E_TASK_SCHEDULE_PAST；interval <300 → E_TASK_INTERVAL_MIN', async () => {
  const { bus } = makeEnv()
  const r1 = await bus.dispatch('task', 'create', { program_id: 'test-src', objective: 'x', schedule: { kind: 'once', at: 1000 } }, { actor: 'model' })
  assert.equal(r1.ok, false)
  assert.equal(r1.error.code, 'E_TASK_SCHEDULE_PAST')
  const r2 = await bus.dispatch('task', 'create', { program_id: 'test-src', objective: 'x', schedule: { kind: 'interval', every_seconds: 60 } }, { actor: 'model' })
  assert.equal(r2.ok, false)
  assert.equal(r2.error.code, 'E_TASK_INTERVAL_MIN')
})

test('invariant: intrusive interval 被拒', async () => {
  const { bus } = makeEnv()
  const r = await bus.dispatch('task', 'create', { program_id: 'test-src', objective: '对目标主动利用 getshell', schedule: { kind: 'interval', every_seconds: 86400 } }, { actor: 'model' })
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'E_TASK_INTRUSIVE_INTERVAL')
})

test('invariant: program 缺失且无 cwd → E_TASK_PROGRAM_UNRESOLVED', async () => {
  const { bus } = makeEnv()
  const r = await bus.dispatch('task', 'create', { objective: '无归属' }, { actor: 'model' })
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'E_TASK_PROGRAM_UNRESOLVED')
})

// ---------------------------------------------------------------------------
// 3. 状态机（block/resume/cancel）
// ---------------------------------------------------------------------------

test('state: block → resume → cancel + task.blocked/task.cancelled', async () => {
  const { dir, bus } = makeEnv()
  const c = await bus.dispatch('task', 'create', { program_id: 'test-src', objective: '状态机' }, { actor: 'model' })
  const id = c.data.task_id
  const b = await bus.dispatch('task', 'block', { task_id: id, blocked_reason: '等授权' }, { actor: 'model' })
  assert.equal(b.ok, true)
  assert.equal(b.data.status, 'blocked')
  assert.ok(readEvents(dir).find((e) => e.name === 'task.blocked' && e.payload.task_id === id))
  const res = await bus.dispatch('task', 'resume', { task_id: id }, { actor: 'model' })
  assert.equal(res.ok, true)
  assert.equal(res.data.status, 'queued')
  const cancel = await bus.dispatch('task', 'cancel', { task_id: id, note: '目标失效' }, { actor: 'model' })
  assert.equal(cancel.ok, true)
  assert.equal(cancel.data.status, 'cancelled')
  assert.ok(readEvents(dir).find((e) => e.name === 'task.cancelled'))
})

test('state: 终态不可再流转（cancel 终态任务 → E_STATE）', async () => {
  const { bus } = makeEnv()
  const c = await bus.dispatch('task', 'create', { program_id: 'test-src', objective: '终态' }, { actor: 'model' })
  await bus.dispatch('task', 'cancel', { task_id: c.data.task_id }, { actor: 'model' })
  const r = await bus.dispatch('task', 'block', { task_id: c.data.task_id, blocked_reason: 'x' }, { actor: 'model' })
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'E_STATE')
})

// ---------------------------------------------------------------------------
// 4. actor / finish
// ---------------------------------------------------------------------------

test('actor: task_finish 仅 scheduler（model → E_ACTOR_FORBIDDEN）', async () => {
  const { bus } = makeEnv()
  const c = await bus.dispatch('task', 'create', { program_id: 'test-src', objective: 'finish' }, { actor: 'model' })
  const r = await bus.dispatch('task', 'finish', { task_id: c.data.task_id, run_id: 'r1', outcome: 'done' }, { actor: 'model' })
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'E_ACTOR_FORBIDDEN')
})

test('finish: once 任务 done + task.finished + 执行史 + 自然键幂等 replay', async () => {
  const { dir, bus } = makeEnv()
  const c = await bus.dispatch('task', 'create', { program_id: 'test-src', objective: 'once', schedule: { kind: 'once', at: Date.now() + 3600000 } }, { actor: 'model' })
  const id = c.data.task_id
  const f1 = await bus.dispatch('task', 'finish', { task_id: id, run_id: 'r1', outcome: 'done', note: '完成' }, { actor: 'scheduler' })
  assert.equal(f1.ok, true)
  assert.equal(f1.data.status, 'done')
  assert.equal(f1.data.run_recorded, true)
  assert.ok(readEvents(dir).find((e) => e.name === 'task.finished' && e.payload.task_id === id && e.payload.ok === true))
  const row = bus._internal.db().prepare('SELECT status FROM tasks WHERE id=?').get(id)
  assert.equal(row.status, 'done')
  // 自然键幂等：同 task_id+run_id 同参重放
  const f2 = await bus.dispatch('task', 'finish', { task_id: id, run_id: 'r1', outcome: 'done', note: '完成' }, { actor: 'scheduler' })
  assert.equal(f2.replay, true)
})

test('finish: interval latest-only 续期以 run_at 为锚（不漂移）', async () => {
  const { bus } = makeEnv()
  const every = 86400
  const c = await bus.dispatch('task', 'create', { program_id: 'test-src', objective: 'interval 续期', schedule: { kind: 'interval', every_seconds: every } }, { actor: 'model' })
  const id = c.data.task_id
  const f = await bus.dispatch('task', 'finish', { task_id: id, run_id: 'r1', outcome: 'done' }, { actor: 'scheduler' })
  assert.equal(f.ok, true)
  assert.equal(f.data.status, 'queued')
  const row = bus._internal.db().prepare('SELECT * FROM tasks WHERE id=?').get(id)
  assert.equal(row.status, 'queued')
  assert.ok(row.next_run_at > Date.now(), '续期后 next_run_at 应在未来')
  // 标称锚点=创建时 next_run_at（run_at 为 null → 退回 next_run_at 初始值）
  assert.ok(row.next_run_at >= row.created_at + every * 1000 - 60000, '续期到下一格点')
})

test('finish: superseded 路径（终态任务再 finish 只补史不改状态）', async () => {
  const { bus } = makeEnv()
  const c = await bus.dispatch('task', 'create', { program_id: 'test-src', objective: 'superseded' }, { actor: 'model' })
  await bus.dispatch('task', 'cancel', { task_id: c.data.task_id }, { actor: 'model' })
  const f = await bus.dispatch('task', 'finish', { task_id: c.data.task_id, run_id: 'r9', outcome: 'done' }, { actor: 'scheduler' })
  assert.equal(f.ok, true)
  assert.equal(f.data.superseded, true)
  const row = bus._internal.db().prepare('SELECT status FROM tasks WHERE id=?').get(c.data.task_id)
  assert.equal(row.status, 'cancelled')
})

// ---------------------------------------------------------------------------
// 5. claim / worker 注册表
// ---------------------------------------------------------------------------

test('claim: scheduler 原子认领到期任务 + task.claimed', async () => {
  const { dir, bus } = makeEnv()
  const c = await bus.dispatch('task', 'create', { program_id: 'test-src', objective: 'claim', schedule: { kind: 'once', at: Date.now() + 3600000 } }, { actor: 'model' })
  await bus.dispatch('task', 'run_now', { task_id: c.data.task_id }, { actor: 'model' })
  const r = await bus.dispatch('task', 'claim', { now: Date.now() }, { actor: 'scheduler' })
  assert.equal(r.ok, true)
  assert.equal(r.data.count, 1)
  assert.equal(r.data.claimed[0], c.data.task_id)
  assert.ok(readEvents(dir).find((e) => e.name === 'task.claimed'))
  const row = bus._internal.db().prepare('SELECT status FROM tasks WHERE id=?').get(c.data.task_id)
  assert.equal(row.status, 'running')
})

test('run_now: 失败回 queued 后可再次手动触发（不被幂等表吞写）', async () => {
  const { bus } = makeEnv()
  const c = await bus.dispatch('task', 'create', {
    program_id: 'test-src', objective: 'retry run now',
    schedule: { kind: 'interval', at: Date.now() + 3600000, every_seconds: 86400 },
  }, { actor: 'model' })
  const first = await bus.dispatch('task', 'run_now', { task_id: c.data.task_id }, { actor: 'model' })
  assert.equal(first.ok, true)
  await bus.dispatch('task', 'claim', { now: Date.now() }, { actor: 'scheduler' })
  await bus.dispatch('task', 'finish', { task_id: c.data.task_id, run_id: 'run_retry_1', outcome: 'failed', note: 'API 400' }, { actor: 'scheduler' })
  const row = bus._internal.db().prepare('SELECT status FROM tasks WHERE id=?').get(c.data.task_id)
  assert.equal(row.status, 'queued')
  const second = await bus.dispatch('task', 'run_now', { task_id: c.data.task_id }, { actor: 'model' })
  assert.equal(second.ok, true)
  assert.notEqual(second.replay, true)
})

test('worker 注册表: register/finish + task_worker_list/status 查询', async () => {
  const { bus } = makeEnv()
  const reg = await bus.dispatch('task', 'worker_register', { run_id: 'w1', dedupe_key: 'k1', task: 't', cwd: '/x', pid: 123, timeout_sec: 900 }, { actor: 'reactor' })
  assert.equal(reg.ok, true)
  const fin = await bus.dispatch('task', 'worker_finish', { run_id: 'w1', outcome: 'done', exit_code: 0 }, { actor: 'reactor' })
  assert.equal(fin.ok, true)
  const q = await bus.query('task', 'worker_list', {}, { actor: 'dashboard' })
  assert.equal(q.total, 1)
  assert.equal(q.rows[0].status, 'done')
  const st = await bus.query('task', 'worker_status', { run_id: 'w1' }, { actor: 'dashboard' })
  assert.equal(st.data.status, 'done')
})

// ---------------------------------------------------------------------------
// 6. 查询口径
// ---------------------------------------------------------------------------

test('query: task_list 过滤 + 分页信封（行数=total）', async () => {
  const { bus } = makeEnv()
  for (let i = 0; i < 3; i++) await bus.dispatch('task', 'create', { program_id: 'test-src', objective: `t${i}`, phase: 'recon' }, { actor: 'model' })
  const q = await bus.query('task', 'list', { program_id: 'test-src' }, { actor: 'dashboard' })
  assert.equal(q.total, 3)
  assert.equal(q.rows.length, 3)
  const q2 = await bus.query('task', 'list', { program_id: 'test-src', bucket: 'active' }, { actor: 'dashboard' })
  assert.equal(q2.total, 3)
})

test('query: task_stats / task_next / task_runs', async () => {
  const { bus } = makeEnv()
  const c = await bus.dispatch('task', 'create', { program_id: 'test-src', objective: 'next', priority: 1 }, { actor: 'model' })
  await bus.dispatch('task', 'finish', { task_id: c.data.task_id, run_id: 'r1', outcome: 'done' }, { actor: 'scheduler' })
  const stats = await bus.query('task', 'stats', { program_id: 'test-src' }, { actor: 'dashboard' })
  assert.equal(stats.data.total, 1)
  const next = await bus.query('task', 'next', { program_id: 'test-src' }, { actor: 'dashboard' })
  assert.equal(next.data, null)
  const runs = await bus.query('task', 'runs', { program_id: 'test-src' }, { actor: 'dashboard' })
  assert.equal(runs.total, 1)
})

// ---------------------------------------------------------------------------
// 7. 别名
// ---------------------------------------------------------------------------

test('alias: worker_list → task_worker_list（static 直通 + deprecated_use）', async () => {
  const { dir, bus } = makeEnv({ aliases: 'aliases:\n  worker_list: task_worker_list\n' })
  const r = await bus.query('', 'worker_list', {}, { actor: 'dashboard' })
  assert.equal(r.ok, true)
  assert.equal(r.query, 'worker_list')
  assert.ok(readAudit(dir).find((a) => a.kind === 'deprecated_use' && a.alias === 'worker_list'))
})

test('alias: task_update{status:blocked} → task_block（task_status_router）', async () => {
  const { bus } = makeEnv({ aliases: 'aliases: {}\ndispatch_aliases:\n  task_update:\n    router: task_status_router\n    domain: task\n' })
  const c = await bus.dispatch('task', 'create', { program_id: 'test-src', objective: 'alias block' }, { actor: 'model' })
  const r = await bus.dispatch('', 'task_update', { id: c.data.task_id, status: 'blocked', note: '等人工' }, { actor: 'model' })
  assert.equal(r.ok, true)
  assert.equal(r.cmd, 'block')
  const row = bus._internal.db().prepare('SELECT status, blocked_reason FROM tasks WHERE id=?').get(c.data.task_id)
  assert.equal(row.status, 'blocked')
  assert.equal(row.blocked_reason, '等人工')
})

test('alias: task_update{status:done} → E_ACTOR_FORBIDDEN（模型手动标 done 关闭）', async () => {
  const { bus } = makeEnv({ aliases: 'aliases: {}\ndispatch_aliases:\n  task_update:\n    router: task_status_router\n    domain: task\n' })
  const c = await bus.dispatch('task', 'create', { program_id: 'test-src', objective: 'alias done' }, { actor: 'model' })
  const r = await bus.dispatch('', 'task_update', { id: c.data.task_id, status: 'done' }, { actor: 'model' })
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'E_ACTOR_FORBIDDEN')
})
