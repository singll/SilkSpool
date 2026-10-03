import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import * as crypto from 'node:crypto'
import { capturePage, createCaptureFiles } from './dsh-browser-capture.mjs'
import { parseHar, harObservation } from './dsh-plugin-sec-domain-endpoint.har.js'

const request = (options = {}) => ({
  url: () => options.url || 'https://business.example/orders?tag=a&tag=b',
  method: () => options.method || 'POST',
  postDataBuffer: () => options.body ?? Buffer.from('{"order":{"id":"mine"},"password":"PRIVATE-PASSWORD"}'),
  headersArray: async () => options.headers || [{ name: 'Content-Type', value: 'application/json' }, { name: 'Cookie', value: 'PRIVATE-COOKIE' }],
  response: async () => ({ status: () => 200, statusText: () => 'OK',
    headersArray: async () => [{ name: 'Content-Type', value: 'application/json' }] }),
})
const accepts = url => new URL(url).origin === 'https://business.example'
const next = () => new Promise(resolve => setTimeout(resolve, 5))
function setup(t, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-capture-test-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const sink = createCaptureFiles(dir, 'run')
  t.after(() => sink.close())
  const page = new EventEmitter()
  const capture = capturePage(page, { accepts, writeEntry: e => sink.writeEntry(e), durationMs: 1000, ...opts })
  t.after(() => capture.stop())
  return { dir, page, capture, sink }
}

test('browser events -> durable HAR -> endpoint observation preserves POST/body/query and hides raw secrets', async t => {
  const { dir, page, capture, sink } = setup(t)
  const req = request()
  page.emit('request', req); page.emit('requestfinished', req)
  page.emit('request', request({ url: 'https://other.example/private' }))
  await next()
  const result = await capture.stop()
  assert.equal(result.report.captured, 1)
  assert.equal(result.report.skipped, 1)
  assert.equal(result.report.partial, false)
  const receipt = sink.finish(result, { program_id: 'business', run_id: 'run' })
  const file = path.join(dir, receipt.har_path), raw = fs.readFileSync(file)
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700)
  assert.equal(receipt.source_sha256, crypto.createHash('sha256').update(raw).digest('hex'))
  assert.equal(/PRIVATE/.test(JSON.stringify(receipt)), false)
  const har = parseHar(raw)
  const { observation } = harObservation(har.entries[0], { sourceSha256: har.sha256, index: 0, programId: 'business', runId: 'run' })
  assert.equal(observation.method, 'POST')
  assert.equal(observation.response_status, 200)
  assert.deepEqual(observation.parameters.filter(p => p.in === 'query').map(p => p.value), ['a', 'b'])
  assert.equal(observation.parameters.find(p => p.name === '/order/id').value, 'mine')
  assert.ok(observation.parameters.find(p => p.name === '/password').value_ref)
  assert.equal(/PRIVATE/.test(JSON.stringify(observation)), false)
  assert.equal(har.entries[0].response.content.text, undefined)
  assert.equal(result.report.business_health, 'unknown')
  assert.equal(fs.readFileSync(path.join(dir, receipt.journal_path), 'utf8').trim().split('\n').length, 1)
  assert.equal(page.listenerCount('request'), 0)
})

test('failed and unfinished requests survive as explicitly incomplete evidence, importer rejects them', async t => {
  const { page, capture } = setup(t)
  const a = request(), b = request()
  page.emit('request', a); page.emit('requestfailed', a); page.emit('request', b)
  const result = await capture.stop('operator')
  assert.equal(result.report.captured, 2)
  assert.equal(result.report.partial, true)
  assert.deepEqual(result.report.terminal, { finished: 0, failed: 1, inflight: 1 })
  for (const entry of result.entries) assert.throws(() => harObservation(entry, {
    sourceSha256: 'a'.repeat(64), index: 0, programId: 'business', runId: 'run',
  }), { code: 'E_HAR_CAPTURE_INCOMPLETE' })
})

test('limits include rejected captures; binary/oversized body never yields fake text or unbounded requests', async t => {
  const { page, capture } = setup(t, { maxEntries: 2, maxEntryBytes: 512, readTimeoutMs: 10 })
  page.emit('request', request({ body: Buffer.from([0xff, 0x00]) }))
  page.emit('request', request({ body: Buffer.alloc(513) }))
  page.emit('request', request())
  const { entries, report } = await capture.done
  assert.equal(entries.length, 0)
  assert.equal(report.selected, 2)
  assert.equal(report.omitted, 2)
  assert.equal(report.stop_reason, 'entry_limit')
  assert.equal(report.errors.E_CAPTURE_BINARY_BODY, 1)
  assert.equal(report.errors.E_CAPTURE_ENTRY_SIZE, 1)
})

test('byte cap bounds retained records and late events do not mutate a completed capture', async t => {
  const { page, capture } = setup(t, { maxBytes: 1024, readTimeoutMs: 10 })
  const a = request(), b = request()
  page.emit('request', a); page.emit('requestfinished', a)
  page.emit('request', b); page.emit('requestfinished', b)
  await next()
  const result = await capture.stop()
  assert.ok(result.report.bytes <= 1024)
  assert.ok(result.report.omitted >= 1)
  const before = JSON.stringify(result)
  page.emit('requestfinished', a)
  await next()
  assert.equal(JSON.stringify(result), before)
})

test('byte limit also reserves unfinished bodies, so many pending requests cannot exceed capture capacity', async t => {
  const { page, capture } = setup(t, { maxBytes: 1024, readTimeoutMs: 10 })
  for (let i = 0; i < 50; i++) page.emit('request', request({ body: Buffer.from('x'.repeat(700)) }))
  const { report } = await capture.done
  assert.equal(report.stop_reason, 'byte_limit')
  assert.equal(report.selected, 2)
  assert.ok(report.omitted >= 1)
  assert.ok(report.bytes <= 1024)
})

test('read failures, scope revocation and storage errors remain explicit and stop capture safely', async t => {
  const { page, capture } = setup(t, { readTimeoutMs: 10 })
  const req = request()
  req.headersArray = () => new Promise(() => {})
  page.emit('request', req); page.emit('requestfinished', req)
  const result = await capture.stop()
  assert.equal(result.report.captured, 0)
  assert.equal(result.report.errors.E_CAPTURE_REQUEST_HEADERS, 1)
  const other = setup(t, { accepts: () => { throw new Error('revoked') } })
  other.page.emit('request', request())
  assert.equal((await other.capture.done).report.stop_reason, 'scope_unavailable')
  const broken = setup(t, { writeEntry: () => { throw new Error('disk full') } })
  const r = request(); broken.page.emit('request', r); broken.page.emit('requestfinished', r)
  const disk = await broken.capture.done
  assert.equal(disk.report.ok, false)
  assert.equal(disk.entries.length, 0)
  assert.equal(disk.report.stop_reason, 'storage_error')
})

test('capture files reject traversal/symlinks/reuse and retain crash journal before HAR finalization', async t => {
  const { dir, sink } = setup(t)
  sink.writeEntry({ durable: true })
  assert.equal(fs.readFileSync(path.join(sink.dir, 'entries.jsonl'), 'utf8'), '{"durable":true}\n')
  assert.equal(fs.existsSync(path.join(sink.dir, 'capture.har')), false)
  assert.throws(() => createCaptureFiles(dir, '../escape'), { code: 'E_CAPTURE_RUN_ID' })
  assert.throws(() => createCaptureFiles(dir, 'run'), { code: 'EEXIST' })
  fs.symlinkSync(os.tmpdir(), path.join(dir, 'results/link'))
  assert.throws(() => createCaptureFiles(dir, 'link'), { code: 'E_CAPTURE_PATH' })
})

test('time/page closure finish with bounded drain and no lingering listeners', async t => {
  const { page, capture } = setup(t, { durationMs: 10 })
  assert.equal((await capture.done).report.stop_reason, 'duration_limit')
  assert.equal(page.listenerCount('request'), 0)
  const other = setup(t)
  other.page.emit('close')
  assert.equal((await other.capture.done).report.stop_reason, 'page_closed')
})
