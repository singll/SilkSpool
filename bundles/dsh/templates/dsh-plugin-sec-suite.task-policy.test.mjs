import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nextScheduledRun, cycleStart, validateDependency, scheduledProgress } from './dsh-plugin-sec-suite.task-policy.js'
import { DatabaseSync } from 'node:sqlite'

const day = 86400000
const anchor = Date.UTC(2026, 8, 15, 19)
const task = { id: 1, run_at: anchor, every_seconds: 86400 }

test('超时最多续跑两次，成功/用尽预算后返回原日历相位', () => {
  const finished = anchor + 7200000
  assert.equal(nextScheduledRun(task, finished, false, 0, true), finished+60000)
  assert.equal(nextScheduledRun(task, finished, false, 1, true), finished+60000)
  assert.equal(nextScheduledRun(task, finished, false, 2, true), anchor+day)
  assert.equal(nextScheduledRun(task, finished, true, 1), anchor+day)
  assert.equal(nextScheduledRun(task, anchor-1000, true), anchor)
  assert.equal(cycleStart(task, anchor+day+1000), anchor+day)
})

test('普通失败退避，续跑不越过下个周期', () => {
  assert.equal(nextScheduledRun(task, anchor+1000, false, 0), anchor+301000)
  assert.equal(nextScheduledRun(task, anchor+1000, false, 1), anchor+601000)
  assert.equal(nextScheduledRun(task, anchor+day-1000, false, 0, true), anchor+day)
})

test('跨日重置尝试次数但保留未完成检查点，启动失败也保留 FGS', t => {
  const db = new DatabaseSync(':memory:')
  t.after(() => db.close())
  db.exec('CREATE TABLE task_runs(id INTEGER PRIMARY KEY,task_id INTEGER,run_id TEXT,ok INTEGER,finished_at INTEGER)')
  db.prepare('INSERT INTO task_runs(task_id,run_id,ok,finished_at) VALUES(1,?,?,?)').run('wprevious',0,anchor+1000)
  const previousDay = scheduledProgress(db, task, anchor+day+1000)
  assert.equal(previousDay.attempts, 0)
  assert.equal(previousDay.resume_run_id, 'wprevious')
  db.prepare('INSERT INTO task_runs(task_id,run_id,ok,finished_at) VALUES(1,?,?,?)').run('',0,anchor+day+1000)
  const crashed = scheduledProgress(db, task, anchor+day+2000)
  assert.equal(crashed.attempts, 1)
  assert.equal(crashed.resume, true)
  db.prepare('INSERT INTO task_runs(task_id,run_id,ok,finished_at) VALUES(1,?,?,?)').run('wfinished',1,anchor+day+3000)
  assert.equal(scheduledProgress(db, task, anchor+day+4000).resume, false)
})

test('依赖拒绝缺失、循环、跨项目和不相同的周期', () => {
  const parent = { id: 2, program_id: 'p', schedule_kind: 'interval', every_seconds: 86400, parent_id: null }
  const child = { ...parent, id: 1 }
  assert.equal(validateDependency(() => parent, child, 2), null)
  assert.match(validateDependency(() => null, child, 2), /不存在/)
  assert.match(validateDependency(() => ({ ...parent, parent_id: 1 }), child, 2), /循环/)
  assert.match(validateDependency(() => ({ ...parent, program_id: 'other' }), child, 2), /同一授权项目/)
  assert.match(validateDependency(() => ({ ...parent, every_seconds: 3600 }), child, 2), /相同周期/)
})
