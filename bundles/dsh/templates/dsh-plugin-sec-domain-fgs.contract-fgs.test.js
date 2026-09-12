// ==============================================================================
// @silksec/sec-domain-fgs 契约测试（14-fgs.md：happy path / schema / 不变量 / 状态机 /
// actor / 幂等 / 依赖满足算法 / 事件载荷 / task.finished 补记订阅）
// 运行：node --test test/contract-fgs.test.js（插件组装目录内，type:module）
// 全部用例使用临时目录/临时库，绝不触碰 /opt/silkspool/dsh/data。
// ==============================================================================

import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createBus } from '../../sec-domain-bus/index.js'
import { buildFgsDomain, FGS_MANIFEST } from '../index.js'
import { buildTaskDomain } from '../../sec-domain-task/index.js'

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'sec-domain-fgs-')) }

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

// 最小 tasks 镜像（fgs 后端跨域只读 getTask 用）
function ensureTasksTable(bus) {
  bus._internal.db().exec(`CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT, program_id TEXT, status TEXT NOT NULL DEFAULT 'queued',
    parent_id INTEGER, phase TEXT, objective TEXT, priority INTEGER, schedule_kind TEXT,
    run_at INTEGER, every_seconds INTEGER, next_run_at INTEGER, started_at INTEGER, finished_at INTEGER,
    result TEXT, blocked_reason TEXT, session_id TEXT, last_run_at INTEGER, last_run_id TEXT)`)
}
function seedRunningTask(bus, programId = 'test-src') {
  const r = bus._internal.db().prepare(`INSERT INTO tasks (program_id, status, phase, objective, schedule_kind) VALUES (?, 'running', 'vuln', 'obj', NULL)`)
    .run(programId)
  return Number(r.lastInsertRowid)
}

function makeEnv() {
  const dir = tmpDir()
  const dataDir = path.join(dir, 'data')
  const bus = baseBus(dir, dataDir)
  ensureTasksTable(bus)
  const domain = buildFgsDomain({
    dataDir,
    dispatch: (d, v, a, c) => bus.dispatch(d, v, a, c),
    query: (d, n, a, c) => bus.query(d, n, a, c),
    getDb: () => bus._internal.db(),
  })
  const reg = bus.registry.register(domain)
  assert.equal(reg.ok, true, `fgs 域应注册成功：${reg.error?.message || ''}`)
  return { dir, dataDir, bus }
}

// fgs + task 双域（订阅 task.finished 端到端）
function makeEnvWithTask() {
  const dir = tmpDir()
  const dataDir = path.join(dir, 'data')
  const bus = baseBus(dir, dataDir)
  const fgs = buildFgsDomain({
    dataDir,
    dispatch: (d, v, a, c) => bus.dispatch(d, v, a, c),
    query: (d, n, a, c) => bus.query(d, n, a, c),
    getDb: () => bus._internal.db(),
  })
  const task = buildTaskDomain({
    dataDir,
    dispatch: (d, v, a, c) => bus.dispatch(d, v, a, c),
    query: (d, n, a, c) => bus.query(d, n, a, c),
  })
  assert.equal(bus.registry.register(fgs).ok, true, 'fgs 域应注册成功')
  assert.equal(bus.registry.register(task).ok, true, 'task 域应注册成功')
  return { dir, dataDir, bus }
}

function readEvents(dir) {
  const f = path.join(dir, 'events', 'fgs.jsonl')
  if (!fs.existsSync(f)) return []
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
}

// ---------------------------------------------------------------------------
// 1. happy path
// ---------------------------------------------------------------------------

test('happy path: fgs_add(running task) 落节点 + fgs.node.added + 状态起 open', async () => {
  const { dir, bus } = makeEnv()
  const taskId = seedRunningTask(bus)
  const r = await bus.dispatch('fgs', 'add', {
    task_id: taskId, type: 'step', content: { summary: '对 api.example.com 跑 nuclei N-day 模板集' }, score: 8,
  }, { actor: 'model', session_id: 'sess_1' })
  assert.equal(r.ok, true)
  assert.equal(r.data.type, 'step')
  assert.equal(r.data.status, 'open')
  assert.equal(r.data.task_id, taskId)
  assert.ok(r.event_ids.length === 1)
  assert.ok(readEvents(dir).find((e) => e.name === 'fgs.node.added' && e.payload.node_id === r.data.node_id && e.payload.type === 'step'))
})

test('happy path: scheduler 种子 goal 节点（actor=scheduler）', async () => {
  const { bus } = makeEnv()
  const taskId = seedRunningTask(bus)
  const r = await bus.dispatch('fgs', 'add', { task_id: taskId, type: 'goal', content: { summary: '任务目标', detail: '全文' } }, { actor: 'scheduler' })
  assert.equal(r.ok, true)
  assert.equal(r.data.type, 'goal')
  const row = bus._internal.db().prepare('SELECT status FROM fgs_nodes WHERE id=?').get(r.data.node_id)
  assert.equal(row.status, 'open')
})

// ---------------------------------------------------------------------------
// 2. schema / 不变量
// ---------------------------------------------------------------------------

test('schema: type 非法 / content 非对象 / 未知参数（含 status）被拒', async () => {
  const { bus } = makeEnv()
  const taskId = seedRunningTask(bus)
  const r1 = await bus.dispatch('fgs', 'add', { task_id: taskId, type: 'bogus', content: {} }, { actor: 'model' })
  assert.equal(r1.ok, false)
  assert.equal(r1.error.code, 'E_SCHEMA')
  const r2 = await bus.dispatch('fgs', 'add', { task_id: taskId, type: 'step', content: 'not-object' }, { actor: 'model' })
  assert.equal(r2.ok, false)
  assert.equal(r2.error.code, 'E_SCHEMA')
  const r3 = await bus.dispatch('fgs', 'add', { task_id: taskId, type: 'step', content: {}, status: 'open' }, { actor: 'model' })
  assert.equal(r3.ok, false)
  assert.equal(r3.error.code, 'E_SCHEMA')
})

test('invariant: task 不存在 → E_NOT_FOUND；task 非 running → E_FGS_TASK_NOT_RUNNING', async () => {
  const { bus } = makeEnv()
  const r1 = await bus.dispatch('fgs', 'add', { task_id: 999999, type: 'step', content: {} }, { actor: 'model' })
  assert.equal(r1.ok, false)
  assert.equal(r1.error.code, 'E_NOT_FOUND')
  const queued = bus._internal.db().prepare(`INSERT INTO tasks (program_id, status) VALUES ('test-src', 'queued')`).run().lastInsertRowid
  const r2 = await bus.dispatch('fgs', 'add', { task_id: Number(queued), type: 'step', content: {} }, { actor: 'model' })
  assert.equal(r2.ok, false)
  assert.equal(r2.error.code, 'E_FGS_TASK_NOT_RUNNING')
})

test('invariant: depends_on / parent_id 引用不存在或跨任务 → E_FGS_DEP_INVALID / E_FGS_PARENT_INVALID', async () => {
  const { bus } = makeEnv()
  const t1 = seedRunningTask(bus)
  const t2 = bus._internal.db().prepare(`INSERT INTO tasks (program_id, status) VALUES ('test-src', 'running')`).run().lastInsertRowid
  const other = await bus.dispatch('fgs', 'add', { task_id: Number(t2), type: 'step', content: { summary: 's' } }, { actor: 'model' })
  const r1 = await bus.dispatch('fgs', 'add', { task_id: t1, type: 'step', content: {}, depends_on: [999999] }, { actor: 'model' })
  assert.equal(r1.ok, false)
  assert.equal(r1.error.code, 'E_FGS_DEP_INVALID')
  const r2 = await bus.dispatch('fgs', 'add', { task_id: t1, type: 'step', content: {}, depends_on: [other.data.node_id] }, { actor: 'model' })
  assert.equal(r2.ok, false)
  assert.equal(r2.error.code, 'E_FGS_DEP_INVALID')
  const r3 = await bus.dispatch('fgs', 'add', { task_id: t1, type: 'step', content: {}, parent_id: other.data.node_id }, { actor: 'model' })
  assert.equal(r3.ok, false)
  assert.equal(r3.error.code, 'E_FGS_PARENT_INVALID')
})

// ---------------------------------------------------------------------------
// 3. 状态机
// ---------------------------------------------------------------------------

test('状态机: start(open→running) → complete(running→done, persist_eligible)', async () => {
  const { bus } = makeEnv()
  const taskId = seedRunningTask(bus)
  const add = await bus.dispatch('fgs', 'add', { task_id: taskId, type: 'step', content: { summary: 'detect' } }, { actor: 'model' })
  const start = await bus.dispatch('fgs', 'start', { node_id: add.data.node_id }, { actor: 'model' })
  assert.equal(start.ok, true)
  assert.equal(start.data.status, 'running')
  const done = await bus.dispatch('fgs', 'complete', { node_id: add.data.node_id, content: { result: 'ok' }, score: 9 }, { actor: 'model' })
  assert.equal(done.ok, true)
  assert.equal(done.data.status, 'done')
  assert.equal(done.data.persist_eligible, false, 'step 非 fact → 不满足沉淀判据')
  const row = bus._internal.db().prepare('SELECT content, score FROM fgs_nodes WHERE id=?').get(add.data.node_id)
  assert.equal(JSON.parse(row.content).result, 'ok')
  assert.equal(row.score, 9)
})

test('状态机: fact 节点 complete 带证据 → persist_eligible=true + fgs.node.done content_head', async () => {
  const { dir, bus } = makeEnv()
  const taskId = seedRunningTask(bus)
  const add = await bus.dispatch('fgs', 'add', { task_id: taskId, type: 'fact', content: { summary: '结论' } }, { actor: 'model' })
  const done = await bus.dispatch('fgs', 'complete', { node_id: add.data.node_id, content: { detail: '证据详情', evidence: 'results/run_x/stdout.log' } }, { actor: 'model' })
  assert.equal(done.ok, true)
  assert.equal(done.data.persist_eligible, true)
  const ev = readEvents(dir).find((e) => e.name === 'fgs.node.done' && e.payload.node_id === add.data.node_id)
  assert.ok(ev)
  assert.equal(ev.payload.persist_eligible, true)
  assert.equal(ev.payload.content_head.summary, '结论')
})

test('状态机: fail(open→failed, reason 必填) / block(open→blocked) / deprecate(终态任务图可废弃)', async () => {
  const { bus } = makeEnv()
  const taskId = seedRunningTask(bus)
  const a = await bus.dispatch('fgs', 'add', { task_id: taskId, type: 'step', content: { summary: 's1' } }, { actor: 'model' })
  const b = await bus.dispatch('fgs', 'add', { task_id: taskId, type: 'step', content: { summary: 's2' } }, { actor: 'model' })
  const f = await bus.dispatch('fgs', 'fail', { node_id: a.data.node_id, reason: '工具报错' }, { actor: 'model' })
  assert.equal(f.ok, true)
  assert.equal(f.data.status, 'failed')
  const blk = await bus.dispatch('fgs', 'block', { node_id: b.data.node_id, reason: '等审批' }, { actor: 'model' })
  assert.equal(blk.ok, true)
  assert.equal(blk.data.status, 'blocked')
  const noReason = await bus.dispatch('fgs', 'fail', { node_id: a.data.node_id }, { actor: 'model' })
  assert.equal(noReason.ok, false)
  assert.equal(noReason.error.code, 'E_SCHEMA')
  // deprecate 终态任务图（任务转 done 后仍可废弃误报节点）
  bus._internal.db().prepare(`UPDATE tasks SET status='done' WHERE id=?`).run(taskId)
  const dep = await bus.dispatch('fgs', 'deprecate', { node_id: a.data.node_id, reason: '误报' }, { actor: 'dashboard' })
  assert.equal(dep.ok, true)
  assert.equal(dep.data.status, 'deprecated')
})

test('状态机非法流转: 终态再流转 → E_STATE', async () => {
  const { bus } = makeEnv()
  const taskId = seedRunningTask(bus)
  const add = await bus.dispatch('fgs', 'add', { task_id: taskId, type: 'step', content: { summary: 's' } }, { actor: 'model' })
  await bus.dispatch('fgs', 'start', { node_id: add.data.node_id }, { actor: 'model' })
  const r1 = await bus.dispatch('fgs', 'start', { node_id: add.data.node_id }, { actor: 'model' })
  assert.equal(r1.ok, false)
  assert.equal(r1.error.code, 'E_STATE')
  await bus.dispatch('fgs', 'complete', { node_id: add.data.node_id }, { actor: 'model' })
  const r2 = await bus.dispatch('fgs', 'fail', { node_id: add.data.node_id, reason: 'x' }, { actor: 'model' })
  assert.equal(r2.ok, false)
  assert.equal(r2.error.code, 'E_STATE')
  const r3 = await bus.dispatch('fgs', 'complete', { node_id: add.data.node_id }, { actor: 'model' })
  assert.equal(r3.ok, false)
  assert.equal(r3.error.code, 'E_STATE')
})

test('annotate: content 增量合并（不覆盖）+ score 调整，不动状态', async () => {
  const { bus } = makeEnv()
  const taskId = seedRunningTask(bus)
  const add = await bus.dispatch('fgs', 'add', { task_id: taskId, type: 'step', content: { summary: 's', keep: 1 } }, { actor: 'model' })
  const r = await bus.dispatch('fgs', 'annotate', { node_id: add.data.node_id, content: { newkey: 'v' }, score: 7 }, { actor: 'model' })
  assert.equal(r.ok, true)
  const row = bus._internal.db().prepare('SELECT content, score, status FROM fgs_nodes WHERE id=?').get(add.data.node_id)
  const c = JSON.parse(row.content)
  assert.equal(c.summary, 's')
  assert.equal(c.keep, 1)
  assert.equal(c.newkey, 'v')
  assert.equal(row.score, 7)
  assert.equal(row.status, 'open')
})

// ---------------------------------------------------------------------------
// 4. actor / 幂等
// ---------------------------------------------------------------------------

test('actor: fgs_clear 仅 scheduler；model 调 → E_ACTOR_FORBIDDEN', async () => {
  const { bus } = makeEnv()
  const taskId = seedRunningTask(bus)
  await bus.dispatch('fgs', 'add', { task_id: taskId, type: 'step', content: {} }, { actor: 'model' })
  const r1 = await bus.dispatch('fgs', 'clear', { task_id: taskId }, { actor: 'model' })
  assert.equal(r1.ok, false)
  assert.equal(r1.error.code, 'E_ACTOR_FORBIDDEN')
  const r2 = await bus.dispatch('fgs', 'clear', { task_id: taskId }, { actor: 'scheduler' })
  assert.equal(r2.ok, true)
  assert.equal(r2.data.removed, 1)
})

test('幂等: fgs_add 同参重放 → replay:true（不产生第二行）', async () => {
  const { bus } = makeEnv()
  const taskId = seedRunningTask(bus)
  const args = { task_id: taskId, type: 'fact', content: { summary: 'x', detail: 'y' } }
  const r1 = await bus.dispatch('fgs', 'add', args, { actor: 'model' })
  const r2 = await bus.dispatch('fgs', 'add', args, { actor: 'model' })
  assert.equal(r1.ok, true)
  assert.equal(r2.ok, true)
  assert.equal(r2.replay, true)
  assert.equal(r2.data.node_id, r1.data.node_id)
  const n = bus._internal.db().prepare('SELECT COUNT(*) AS n FROM fgs_nodes').get().n
  assert.equal(n, 1)
})

// ---------------------------------------------------------------------------
// 5. 查询
// ---------------------------------------------------------------------------

test('fgs_list: rows/total 同口径 + score 降序 + content 反序列化', async () => {
  const { bus } = makeEnv()
  const taskId = seedRunningTask(bus)
  await bus.dispatch('fgs', 'add', { task_id: taskId, type: 'step', content: { summary: 'a' }, score: 1 }, { actor: 'model' })
  await bus.dispatch('fgs', 'add', { task_id: taskId, type: 'fact', content: { summary: 'b' }, score: 9 }, { actor: 'model' })
  const r = await bus.query('fgs', 'list', { task_id: taskId }, { actor: 'model' })
  assert.equal(r.ok, true)
  assert.equal(r.rows.length, 2)
  assert.equal(r.total, 2)
  assert.equal(r.rows[0].content.summary, 'b', 'score 高者在前')
  const f = await bus.query('fgs', 'list', { task_id: taskId, type: 'fact' }, { actor: 'model' })
  assert.equal(f.total, 1)
  assert.equal(f.rows[0].type, 'fact')
})

test('fgs_next: 依赖满足算法（只认同任务 step 类 done 节点）', async () => {
  const { bus } = makeEnv()
  const taskId = seedRunningTask(bus)
  const s1 = await bus.dispatch('fgs', 'add', { task_id: taskId, type: 'step', content: { summary: 'detect' }, score: 5 }, { actor: 'model' })
  const s2 = await bus.dispatch('fgs', 'add', { task_id: taskId, type: 'step', content: { summary: 'verify' }, depends_on: [s1.data.node_id] }, { actor: 'model' })
  const r1 = await bus.query('fgs', 'next', { task_id: taskId }, { actor: 'model' })
  assert.equal(r1.data.steps.length, 1)
  assert.equal(r1.data.steps[0].id, s1.data.node_id)
  // fact 节点依赖不使 step ready（依赖判定只认 step 类 done）
  await bus.dispatch('fgs', 'complete', { node_id: s1.data.node_id }, { actor: 'model' })
  const r2 = await bus.query('fgs', 'next', { task_id: taskId }, { actor: 'model' })
  assert.equal(r2.data.steps.length, 1)
  assert.equal(r2.data.steps[0].id, s2.data.node_id)
})

test('fgs_export: markdown 含任务号/四类计数/分组 + json 全节点', async () => {
  const { bus } = makeEnv()
  const taskId = seedRunningTask(bus)
  await bus.dispatch('fgs', 'add', { task_id: taskId, type: 'goal', content: { summary: '目标' } }, { actor: 'scheduler' })
  const f = await bus.dispatch('fgs', 'add', { task_id: taskId, type: 'finding', content: { summary: '漏洞', host: 'a.com' }, score: 50 }, { actor: 'model' })
  await bus.dispatch('fgs', 'complete', { node_id: f.data.node_id }, { actor: 'model' })
  const md = await bus.query('fgs', 'export', { task_id: taskId, format: 'markdown' }, { actor: 'dashboard' })
  assert.equal(md.ok, true)
  assert.ok(md.data.markdown.includes('## FGS 决策链摘要（自动导出）'))
  assert.ok(md.data.markdown.includes(`- 任务: #${taskId}`))
  assert.ok(md.data.markdown.includes('（fact 0 / goal 1 / step 0 / finding 1）'))
  assert.ok(md.data.markdown.includes('### 发现 (Finding)'))
  assert.ok(md.data.markdown.includes('@a.com (score:50)'))
  const js = await bus.query('fgs', 'export', { task_id: taskId, format: 'json' }, { actor: 'dashboard' })
  assert.equal(js.data.nodes.length, 2)
})

// ---------------------------------------------------------------------------
// 6. 订阅 task.finished（sync，reactor 补记失败节点）
// ---------------------------------------------------------------------------

test('订阅: task.finished(ok=false) → 补记 failed step 节点', async () => {
  const { bus } = makeEnvWithTask()
  const cr = await bus.dispatch('task', 'create', { program_id: 'test-src', phase: 'vuln', objective: '任务', schedule: { kind: 'once', at: Date.now() + 3600000 } }, { actor: 'model' })
  const taskId = cr.data.task_id
  bus._internal.db().prepare(`UPDATE tasks SET status='running' WHERE id=?`).run(taskId)
  const r = await bus.dispatch('task', 'finish', { task_id: taskId, run_id: 'run_fail_1', outcome: 'failed', note: 'worker 超时' }, { actor: 'scheduler' })
  assert.equal(r.ok, true)
  await bus._internal.dispatcherTick()
  const row = bus._internal.db().prepare("SELECT * FROM fgs_nodes WHERE task_id=? AND type='step' AND status='failed'").get(taskId)
  assert.ok(row, '应补记失败 step 节点')
  assert.ok(JSON.parse(row.content).summary.includes('任务失败: worker 超时'))
})

test('订阅: task.finished truth.rejected → 补记 finding 类失败节点', async () => {
  const { bus } = makeEnvWithTask()
  const cr = await bus.dispatch('task', 'create', { program_id: 'test-src', phase: 'vuln', objective: '任务', schedule: { kind: 'once', at: Date.now() + 3600000 } }, { actor: 'model' })
  const taskId = cr.data.task_id
  bus._internal.db().prepare(`UPDATE tasks SET status='running' WHERE id=?`).run(taskId)
  const r = await bus.dispatch('task', 'finish', { task_id: taskId, run_id: 'run_fail_2', outcome: 'failed', note: 'x', truth: { rejected: true, reason: '拒执标记' } }, { actor: 'scheduler' })
  assert.equal(r.ok, true)
  await bus._internal.dispatcherTick()
  const row = bus._internal.db().prepare("SELECT * FROM fgs_nodes WHERE task_id=? AND type='finding' AND status='failed'").get(taskId)
  assert.ok(row, 'truth.rejected 应补记 finding 失败节点')
  assert.equal(JSON.parse(row.content).summary, 'worker 拒执或 API 错误')
})

// ---------------------------------------------------------------------------
// 7. 总线集成
// ---------------------------------------------------------------------------

test('别名: fgs_update 按 status 分派（running→start/done→complete/failed→fail/reason 推导）', async () => {
  const dir = tmpDir()
  const dataDir = path.join(dir, 'data')
  const bus = baseBus(dir, dataDir)
  fs.writeFileSync(path.join(dir, 'bus.aliases.yaml'), 'dispatch_aliases:\n  fgs_update:\n    router: fgs_update_router\n    domain: fgs\n    warn: "x"\n')
  // 重新加载别名（baseBus 已读取空别名文件，这里直接用新文件重建 bus）
  const bus2 = createBus({
    dataDir,
    dbFile: path.join(dir, 'asset-graph.db'),
    aliasesFile: path.join(dir, 'bus.aliases.yaml'),
    auditFile: path.join(dir, 'audit.jsonl'),
    eventsDir: path.join(dir, 'events'),
    sidecars: false,
    startDispatcherTimer: false,
  })
  ensureTasksTable(bus2)
  const domain = buildFgsDomain({
    dataDir,
    dispatch: (d, v, a, c) => bus2.dispatch(d, v, a, c),
    query: (d, n, a, c) => bus2.query(d, n, a, c),
    getDb: () => bus2._internal.db(),
  })
  assert.equal(bus2.registry.register(domain).ok, true)
  const taskId = seedRunningTask(bus2)
  const add = await bus2.dispatch('fgs', 'add', { task_id: taskId, type: 'step', content: { summary: 's' } }, { actor: 'model' })
  const start = await bus2.dispatch('', 'fgs_update', { id: add.data.node_id, status: 'running' }, { actor: 'model' })
  assert.equal(start.ok, true)
  assert.equal(start.data.status, 'running')
  const done = await bus2.dispatch('', 'fgs_update', { id: add.data.node_id, status: 'done', content: { result: 'r' } }, { actor: 'model' })
  assert.equal(done.ok, true)
  assert.equal(done.data.status, 'done')
  const add2 = await bus2.dispatch('fgs', 'add', { task_id: taskId, type: 'step', content: { summary: 's2' } }, { actor: 'model' })
  const failNoReason = await bus2.dispatch('', 'fgs_update', { id: add2.data.node_id, status: 'failed' }, { actor: 'model' })
  assert.equal(failNoReason.ok, false)
  assert.equal(failNoReason.error.code, 'E_SCHEMA')
  const failReason = await bus2.dispatch('', 'fgs_update', { id: add2.data.node_id, status: 'failed', content: { reason: 'timeout' } }, { actor: 'model' })
  assert.equal(failReason.ok, true)
  assert.equal(failReason.data.status, 'failed')
})

test('总线集成: bus_status fgs registered:true + 订阅在册 + 后端共享连接', async () => {
  const { bus } = makeEnv()
  const st = await bus.query('bus', 'status', {}, { actor: 'dashboard' })
  const fgs = st.data.domains.find((d) => d.domain === 'fgs')
  assert.ok(fgs)
  assert.equal(fgs.registered, true)
  assert.equal(fgs.backend, 'sqlite-local')
  assert.equal(fgs.commands, Object.keys(FGS_MANIFEST.commands).length)
  assert.equal(fgs.queries, Object.keys(FGS_MANIFEST.queries).length)
  assert.ok(st.data.subscribers.some((s) => s.pattern === 'task.finished' && s.source === 'fgs'))
})
