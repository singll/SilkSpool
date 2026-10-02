import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'

const { executeWorkerProcess, verifyWorkerSession, workerGroupMembers, createWorkerBudget, createWorkerRequestJournal } = await import(pathToFileURL(
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

const drain = async stream => { for await (const _ of stream) {} }
const request = (text = 'hello') => ({ maxTokens: 100, messages: [{ role: 'user', content: [{ type: 'text', text }] }] })
test('WP03 first oversized context is rejected before provider invocation', async () => {
  const budget = createWorkerBudget(20000)
  let called = 0
  await assert.rejects(drain(budget.stream(request('上下文'.repeat(15000)), () => { called++; return [] })), /BUDGET_EXHAUSTED/)
  assert.equal(called, 0)
  assert.equal(budget.state.charged, 0)
})
test('WP03 overlapping requests reserve atomically; missing usage retains reservation', async () => {
  const budget = createWorkerBudget(4000)
  let release
  const wait = new Promise(r => { release = r })
  const running = drain(budget.stream(request(), async function* () { await wait }))
  await assert.rejects(drain(budget.stream(request(), () => [])), /BUDGET_EXHAUSTED/)
  release(); await running
  assert.equal(budget.state.unknown, 1)
  assert.ok(budget.state.reserved > 2000)
  await assert.rejects(drain(budget.stream(request(), () => [])), /BUDGET_EXHAUSTED/)
})
test('WP03 zero is known, usage delta settles, provider overrun prevents next request', async () => {
  const budget = createWorkerBudget(4000)
  const response = tokens => async function* () { yield { type: 'usage', usage: { inputTokens: tokens, outputTokens: 0 } } }
  await drain(budget.stream(request(), response(0)))
  assert.equal(budget.state.reserved, 0)
  assert.equal(budget.state.unknown, 0)
  await drain(budget.stream(request(), response(4500)))
  assert.equal(budget.state.charged, 4500) // estimates cannot guarantee provider input pricing.
  await assert.rejects(drain(budget.stream(request(), response(0))), /BUDGET_EXHAUSTED/)
})
test('WP03 unsupported modality and missing output cap cannot reach provider', async () => {
  const budget = createWorkerBudget(10000)
  await assert.rejects(drain(budget.stream({ messages: [], maxTokens: undefined }, () => [])), /OUTPUT_CAP/)
  await assert.rejects(drain(budget.stream({ ...request(), messages: [{ content: [{ type: 'image' }] }] }, () => [])), /MODALITY/)
})
test('WP03 adapter error zero usage and aborted partial usage retain unknown reservation', async () => {
  for (const kind of ['error', 'aborted']) {
    const budget = createWorkerBudget(4000)
    await drain(budget.stream(request(), async function* () {
      yield { type: 'usage', usage: { inputTokens: kind === 'error' ? 0 : 50, outputTokens: 0 } }
      yield { type: 'finish', reason: { kind, failure: { code: 'TRANSPORT' } } }
    }))
    assert.equal(budget.state.unknown, 1)
    assert.ok(budget.state.reserved > 2000)
    assert.equal(budget.state.charged, kind === 'error' ? 0 : 50)
    await assert.rejects(drain(budget.stream(request(), () => [])), /BUDGET_EXHAUSTED/)
  }
})
test('WP03 thrown stream after usage does not make partial billing final', async () => {
  const budget = createWorkerBudget(4000)
  await assert.rejects(drain(budget.stream(request(), async function* () {
    yield { type: 'usage', usage: { inputTokens: 50, outputTokens: 10 } }
    throw new Error('transport interrupted')
  })), /transport interrupted/)
  assert.equal(budget.state.unknown, 1)
  assert.equal(budget.state.charged, 60)
  assert.ok(budget.state.reserved > 2000)
})
test('WP03 consumer cancellation after usage retains the unfinished reservation', async () => {
  const budget = createWorkerBudget(4000)
  const stream = budget.stream(request(), async function* () {
    yield { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })
  await stream.next()
  await stream.return()
  assert.equal(budget.state.unknown, 1)
  assert.ok(budget.state.reserved > 2000)
})
test('WP03 failed registration never publishes model-start ACK', async t => {
  const f = fixture(t)
  const result = await executeWorkerProcess({ ...f, args: ['-e', 'setInterval(()=>{},1000)'],
    onSpawn: async () => { throw new Error('registration failed') }, graceMs: 25 })
  assert.match(result.error, /registration failed/)
  assert.equal(fs.existsSync(path.join(f.runDir, 'worker-ack.json')), false)
  assert.deepEqual(workerGroupMembers(result.pid), [])
})

test('WP03 default budget completes a two-step request with folded tool history', async () => {
  const budget = createWorkerBudget(150000)
  const tools = [{ name: 'fixture', description: 'x'.repeat(122000), parameters: { type: 'object' } }]
  const options = { ...request('x'.repeat(30000)), tools, toolHistory: { tools: structuredClone(tools), updates: [] }, maxTokens: 2048 }
  let calls = 0
  const next = async function* () { calls++; yield { type: 'usage', usage: { inputTokens: 43836, outputTokens: 60 } } }
  await drain(budget.stream(options, next))
  await drain(budget.stream({ ...options, messages: request('x'.repeat(47000)).messages }, next))
  assert.equal(calls, 2)
  assert.equal(budget.state.charged, 87792)
  assert.equal(budget.state.reserved, 0)
})

test('WP03 independent system prompt and historical tool additions remain budgeted', async () => {
  let calls = 0
  const next = () => { calls++; return [] }
  const system = createWorkerBudget(5000)
  await assert.rejects(drain(system.stream({ ...request(), system: 'x'.repeat(15000) }, next)), /BUDGET_EXHAUSTED/)
  const history = createWorkerBudget(5000)
  await assert.rejects(drain(history.stream({ ...request(), tools: [],
    toolHistory: { tools: [], updates: [{ messageId: 'update-1', additions: [
      { name: 'historical', description: 'x'.repeat(15000), parameters: {} },
    ] }] },
  }, next)), /BUDGET_EXHAUSTED/)
  assert.equal(calls, 0)
})

test('WP03 cached input is charged once and prevents an unbudgeted next request', async () => {
  const budget = createWorkerBudget(10000)
  await drain(budget.stream(request(), async function* () {
    yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 7800, cacheWriteTokens: 80, totalTokens: 8000 } }
  }))
  assert.equal(budget.state.charged, 8000)
  await assert.rejects(drain(budget.stream(request(), () => [])), /BUDGET_EXHAUSTED/)
})

test('WP03 invalid cached usage retains reservation, diagnostics contain counts only and are bounded', async () => {
  const budget = createWorkerBudget(100000)
  await drain(budget.stream(request('PRIVATE-CONTENT'), async function* () {
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: -1 } }
  }))
  assert.equal(budget.state.unknown, 1)
  assert.ok(budget.state.reserved > 0)
  for (let i = 0; i < 40; i++) await drain(budget.stream(request('PRIVATE-CONTENT'), async function* () {
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
  }))
  assert.equal(budget.state.recent_requests.length, 32)
  assert.equal(JSON.stringify(budget.state).includes('PRIVATE-CONTENT'), false)
  assert.equal(budget.state.recent_requests.at(-1).actual_input_tokens, 1)
})

test('WP03 durable request evidence survives the 32-request diagnostic window without bodies or secrets', async t => {
  const f = fixture(t)
  const nonce = 'secret-launch-nonce'
  const record = createWorkerRequestJournal(f.runDir, { run_id: f.runId, nonce, pid: process.pid })
  const budget = createWorkerBudget(200000, () => {}, record)
  for (let i = 0; i < 40; i++) await drain(budget.stream({
    ...request('PRIVATE-CONTENT'), provider: 'fixture', model: 'fixture-model', sessionId: 'session-fixture',
    headers: { Authorization: 'PRIVATE-KEY' }, responseId: 'caller-forged',
  }, async function* () {
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 20, secret: 'PRIVATE-USAGE' } }
    yield { type: 'finish', reason: { kind: 'stop' }, replayState: {
      response: { kind: 'pi-ai', version: 2, provider: 'fixture', model: 'fixture-model', responseId: `response-${i}` },
      blocks: [{ textSignature: 'PRIVATE-SIGNATURE' }],
    } }
  }))
  const filename = path.join(f.runDir, 'worker-requests.jsonl')
  const text = fs.readFileSync(filename, 'utf8')
  const events = text.trim().split('\n').map(JSON.parse)
  assert.equal(events.length, 160)
  assert.equal(new Set(events.map(row => row.request_id)).size, 40)
  assert.deepEqual(events.map(row => row.event_sequence), Array.from({ length: 160 }, (_, i) => i + 1))
  assert.ok(events.every(row => row.run_id === f.runId && row.session_id === 'session-fixture' && row.final_cost_proven === false))
  assert.equal(events.at(-1).provider_response_id, 'response-39')
  assert.equal(events.at(-1).usage.cacheReadTokens, 20)
  assert.equal(fs.statSync(filename).mode & 0o777, 0o600)
  assert.equal(/PRIVATE|caller-forged|secret-launch-nonce/.test(text), false)
  assert.equal(budget.state.recent_requests.length, 32)
  const duplicate = createWorkerRequestJournal(f.runDir, { run_id: f.runId, nonce, pid: process.pid })
  assert.throws(() => duplicate({ event: 'admitted' }), /EEXIST/)
  assert.equal(fs.readFileSync(filename, 'utf8'), text)
})

test('WP03 failed request and successful fallback have independent evidence and reservation', async () => {
  const events = []
  const budget = createWorkerBudget(10000, () => {}, row => events.push(row))
  await drain(budget.stream(request(), async function* () {
    yield { type: 'usage', usage: { inputTokens: 7, outputTokens: 0 } }
    yield { type: 'finish', reason: { kind: 'error', failure: { code: 'SERVER', message: 'PRIVATE-ERROR' } } }
  }))
  await drain(budget.stream(request(), async function* () {
    yield { type: 'usage', usage: { inputTokens: 30, outputTokens: 10 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }))
  const terminals = events.filter(row => row.event === 'terminal')
  assert.equal(terminals.length, 2)
  assert.notEqual(terminals[0].request_id, terminals[1].request_id)
  assert.equal(terminals[0].termination, 'adapter_error')
  assert.equal(terminals[0].provider_response_id, null)
  assert.equal(terminals[1].termination, 'stream_exhausted')
  assert.equal(budget.state.charged, 47)
  assert.equal(budget.state.unknown, 1)
  assert.ok(budget.state.reserved > 0)
  assert.equal(JSON.stringify(events).includes('PRIVATE-ERROR'), false)
})

test('WP03 cancellation and thrown stream retain already observed usage in the journal', async () => {
  for (const mode of ['cancel', 'throw']) {
    const events = []
    const budget = createWorkerBudget(10000, () => {}, row => events.push(row))
    const stream = budget.stream(request(), async function* () {
      yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 1 } }
      throw new Error('PRIVATE-ERROR')
    })
    if (mode === 'cancel') { await stream.next(); await stream.return() }
    else await assert.rejects(drain(stream), /PRIVATE-ERROR/)
    assert.equal(events.at(-1).termination, mode === 'cancel' ? 'consumer_cancelled' : 'stream_threw')
    assert.deepEqual(events[1].usage, { inputTokens: 3, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 })
    assert.equal(budget.state.unknown, 1)
  }
})

test('WP03 evidence write failure denies the next provider invocation and cannot release unknown cost', async () => {
  for (const failEvent of ['admitted', 'usage', 'finish', 'terminal']) {
    let calls = 0
    const budget = createWorkerBudget(10000, () => {}, row => { if (row.event === failEvent) throw new Error('disk failure') })
    const response = async function* () {
      calls++
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
    await assert.rejects(drain(budget.stream(request(), response)), /E_WORKER_REQUEST_EVIDENCE_WRITE/)
    assert.equal(calls, failEvent === 'admitted' ? 0 : 1)
    if (calls) { assert.equal(budget.state.unknown, 1); assert.ok(budget.state.reserved > 0) }
    await assert.rejects(drain(budget.stream(request(), response)), /E_WORKER_REQUEST_EVIDENCE_WRITE/)
    assert.equal(calls, failEvent === 'admitted' ? 0 : 1)
  }
})

test('WP03 admission refusal records no provider call and invalid replay never supplies an ID', async () => {
  const denied = []
  await assert.rejects(drain(createWorkerBudget(1000, () => {}, row => denied.push(row)).stream(request(), () => {
    assert.fail('provider reached')
  })), /BUDGET_EXHAUSTED/)
  assert.deepEqual(denied.map(row => row.event), ['denied'])
  for (const response of [
    { kind: 'pi-ai', version: 2, provider: 'wrong', model: 'fixture', responseId: 'foreign-id' },
    { kind: 'pi-ai', version: 1, provider: 'fixture', model: 'fixture', responseId: 'old-id' },
    { kind: 'pi-ai', version: 2, provider: 'fixture', model: 'fixture', responseId: 'PRIVATE\nCONTENT' },
  ]) {
    const events = []
    await drain(createWorkerBudget(10000, () => {}, row => events.push(row)).stream({
      ...request(), provider: 'fixture', model: 'fixture',
    }, async function* () {
      yield { type: 'finish', reason: { kind: 'stop' }, replayState: { response } }
    }))
    assert.equal(events.at(-1).provider_response_id, null)
    assert.equal(events.at(-1).usage_state, 'unknown')
  }
})

test('WP03 SIGKILL retains the durable admitted and usage events without inventing a terminal', async t => {
  const f = fixture(t)
  const module = process.env.WORKER_RUNTIME_MODULE || path.join(import.meta.dirname, 'dsh-plugin-sec-suite.worker-runtime.js')
  const script = `
    import { createWorkerBudget, createWorkerRequestJournal } from ${JSON.stringify(pathToFileURL(module).href)};
    const record = createWorkerRequestJournal(${JSON.stringify(f.runDir)}, {run_id:'wfixture',nonce:'fixture',pid:process.pid});
    const budget = createWorkerBudget(10000, () => {}, record);
    for await (const chunk of budget.stream({maxTokens:100,messages:[]}, async function* () {
      yield {type:'usage',usage:{inputTokens:9,outputTokens:2}};
      process.kill(process.pid, 'SIGKILL');
    })) {}
  `
  const result = await executeWorkerProcess({ ...f, args: ['--input-type=module', '-e', script] })
  assert.notEqual(result.code, 0)
  const events = fs.readFileSync(path.join(f.runDir, 'worker-requests.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
  assert.deepEqual(events.map(row => row.event), ['admitted', 'usage'])
  assert.equal(events[1].usage.inputTokens, 9)
})

test('WP03 request journal is protected against native file writes and symlink destinations', async t => {
  const f = fixture(t)
  const dataDir = path.join(f.cwd, 'data')
  const runDir = path.join(dataDir, 'results', 'wfixture')
  fs.mkdirSync(runDir, { recursive: true })
  const guardFile = path.join(path.dirname(process.env.WORKER_RUNTIME_MODULE || import.meta.filename), 'native-guard.js')
  const { workspaceWriteRefusal } = await import(pathToFileURL(guardFile))
  assert.match(workspaceWriteRefusal({ cwd: runDir, filename: 'worker-requests.jsonl', baseDir: f.cwd, dataDir }), /E_SCOPE_FILE_WRITE/)
  assert.equal(workspaceWriteRefusal({ cwd: runDir, filename: 'artifact.txt', baseDir: f.cwd, dataDir }), undefined)
  const target = path.join(f.cwd, 'original')
  fs.writeFileSync(target, 'untouched')
  fs.symlinkSync(target, path.join(runDir, 'worker-requests.jsonl'))
  const record = createWorkerRequestJournal(runDir, { run_id: 'wfixture', nonce: 'fixture', pid: process.pid })
  assert.throws(() => record({ event: 'admitted' }))
  assert.equal(fs.readFileSync(target, 'utf8'), 'untouched')
})
