import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'

async function fixture(t, runWorker) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduler-regression-'))
  const dataDir = path.join(dir, 'data')
  fs.mkdirSync(dataDir)
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}')
  for (const part of ['asset-db', 'scheduler', 'host-compat', 'task-policy']) {
    fs.copyFileSync(path.join(import.meta.dirname, `dsh-plugin-sec-suite.${part}.js`), path.join(dir, `${part}.js`))
  }
  const previous = process.env.SEC_DATA_DIR
  process.env.SEC_DATA_DIR = dataDir
  const assetDb = await import(pathToFileURL(path.join(dir, 'asset-db.js')))
  if (previous === undefined) delete process.env.SEC_DATA_DIR; else process.env.SEC_DATA_DIR = previous
  const { schedulerTick } = await import(pathToFileURL(path.join(dir, 'scheduler.js')))
  const db = assetDb.getDb()
  db.prepare("INSERT INTO programs(id,status,workspace_path) VALUES('fixture','active',?)").run(dir)
  const created = assetDb.taskCreate({ program_id: 'fixture', objective: '本地调度回归', schedule: { kind: 'interval', every_seconds: 86400, anchor: Date.now()-600000 } })
  assert.equal(created.ok, true)
  db.prepare('UPDATE tasks SET budget_timeout_sec=7200,next_run_at=? WHERE id=?').run(Date.now()-1, created.id)
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }) })
  const deps = { dataDir, assetDb, audit() {}, pidAlive: () => false,
    getWorkspaceRegistry: () => null, getSessionPersistence: () => null,
    exp: { kbVaultSync: async () => ({ ok: true }) },
    runWorker: args => runWorker(args, { db, assetDb, id: created.id, dataDir }),
  }
  return { db, id: created.id, assetDb, tick: () => schedulerTick(deps) }
}

test('exit 0 + timed_out 按真实 7200 秒预算失败；一分钟后续跑保留 FGS', async t => {
  let calls = 0
  const f = await fixture(t, (args, { assetDb, id, dataDir }) => {
    calls++
    assert.equal(args.timeoutSec, 7200)
    const runId = calls === 1 ? 'wfirst' : 'wsecond'
    assetDb.taskBindWorker(id, runId)
    fs.mkdirSync(path.join(dataDir, 'results', runId), { recursive: true })
    fs.writeFileSync(path.join(dataDir, 'results', runId, 'worker.log'), '本地 fixture 已保存')
    if (calls === 2) {
      assert.match(args.task, /续跑.*上轮 wfirst/)
      assert.ok(assetDb.fgsListNodes({ task_id: id }).some(n => n.content.summary === '已完成的检查点'))
    }
    return { ok: calls === 2, run_id: runId, exit_code: 0, duration_ms: calls === 1 ? 7200300 : 100,
      timed_out: calls === 1, tail: '本地 fixture 已保存' }
  })
  await f.tick()
  const first = f.db.prepare('SELECT * FROM task_runs WHERE task_id=? ORDER BY id DESC LIMIT 1').get(f.id)
  assert.equal(first.ok, 0)
  assert.match(first.note, /7200 秒预算/)
  const queued = f.db.prepare('SELECT * FROM tasks WHERE id=?').get(f.id)
  assert.equal(queued.status, 'queued')
  assert.ok(queued.next_run_at-first.finished_at <= 61000)
  assert.equal(queued.active_run_id, null)
  f.assetDb.fgsAddNode({ task_id: f.id, type: 'step', status: 'done', content: { summary: '已完成的检查点' } })
  f.db.prepare('UPDATE tasks SET next_run_at=? WHERE id=?').run(Date.now()-1, f.id)
  await f.tick()
  assert.equal(calls, 2)
  assert.equal(f.db.prepare('SELECT ok FROM task_runs ORDER BY id DESC LIMIT 1').get().ok, 1)
})

test('worker 晚到的完成回调不复活已取消的周期任务', async t => {
  const f = await fixture(t, (args, { db, id }) => {
    db.prepare("UPDATE tasks SET status='cancelled' WHERE id=?").run(id)
    return { ok: true, run_id: 'wcancelled', exit_code: 0, duration_ms: 10, tail: '已退出' }
  })
  await f.tick()
  assert.equal(f.db.prepare('SELECT status FROM tasks WHERE id=?').get(f.id).status, 'cancelled')
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM task_runs WHERE task_id=?').get(f.id).n, 1)
})
