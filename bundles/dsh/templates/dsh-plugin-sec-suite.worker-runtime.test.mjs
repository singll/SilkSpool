import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'

const { executeWorkerProcess, verifyWorkerSession, workerGroupMembers } = await import(pathToFileURL(
  process.env.WORKER_RUNTIME_MODULE || path.join(import.meta.dirname, 'dsh-plugin-sec-suite.worker-runtime.js')))

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-runtime-test-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return { node: process.execPath, env: process.env, cwd: dir, runDir: dir, runId: 'wfixture', timeoutMs: 5000 }
}

test('两个输出流的末尾均落盘且 stdin 已关闭', async t => {
  const f = fixture(t)
  const result = await executeWorkerProcess({ ...f, args: ['-e',
    'process.stdin.resume(); process.stdin.on("end",()=>{process.stdout.write("A".repeat(200000)+"STDOUT_END");process.stderr.write("B".repeat(200000)+"STDERR_END")})'] })
  assert.equal(result.code, 0)
  const output = fs.readFileSync(path.join(f.runDir, 'worker.log'), 'utf8')
  assert.ok(output.includes('STDOUT_END') && output.includes('STDERR_END'))
  assert.equal(output.length, 400020)
})

for (const mode of ['cancel', 'timeout']) test(`${mode} 回收忽略 TERM 的子孙进程且只收尾一次`, async t => {
  const f = fixture(t)
  const controller = new AbortController()
  let starts = 0
  const result = await executeWorkerProcess({ ...f, timeoutMs: mode === 'timeout' ? 300 : 5000, graceMs: 50,
    signal: controller.signal,
    args: ['-e', 'const {spawn}=require("node:child_process"); spawn(process.execPath,["-e","process.on(\\"SIGTERM\\",()=>{});setInterval(()=>{},1000)"],{stdio:"inherit"});process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],
    onSpawn: () => { starts++; if (mode === 'cancel') setTimeout(() => controller.abort(), 300) },
  })
  assert.equal(starts, 1)
  assert.equal(result[mode === 'cancel' ? 'cancelled' : 'timed_out'], true)
  assert.notEqual(result.code, 0)
  assert.deepEqual(workerGroupMembers(result.pid), [])
})

test('启动失败仍关闭日志并返回失败状态', async t => {
  const f = fixture(t)
  const result = await executeWorkerProcess({ ...f, node: '/nonexistent/worker-fixture', args: [] })
  assert.notEqual(result.code, 0)
  assert.ok(result.error)
})

test('Session 报告必须同时匹配启动身份与官方 header', async t => {
  const f = fixture(t)
  const report = { run_id: f.runId, nonce: 'abc', pid: 99, cwd: f.cwd, session_id: 'session-fixture', created_at: 120 }
  const filename = path.join(f.runDir, 'worker-session.json')
  const headers = [{ header: { id: report.session_id, cwd: f.cwd, createdAt: 120 } }]
  const options = { ...f, nonce: report.nonce, pid: 99, startedAt: 100, finishedAt: 130, persistence: { list: async () => headers } }
  fs.writeFileSync(filename, JSON.stringify(report))
  assert.equal((await verifyWorkerSession(options)).id, report.session_id)
  for (const patch of [{ nonce: 'other' }, { pid: 100 }, { cwd: '/wrong' }, { session_id: 'session-origin' }, { created_at: 99 }]) {
    fs.writeFileSync(filename, JSON.stringify({ ...report, ...patch }))
    assert.equal((await verifyWorkerSession(options)).id, null)
  }
})
