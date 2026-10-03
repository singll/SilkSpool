// Bounded passive capture of one already-open page. Never navigates or replays.
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const fail = code => { throw Object.assign(new Error(code), { code }) }
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const bytes = value => Buffer.byteLength(JSON.stringify(value))
const wait = (promise, ms) => {
  let timer
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('E_CAPTURE_READ_TIMEOUT'), { code: 'E_CAPTURE_READ_TIMEOUT' })), ms)
  })]).finally(() => clearTimeout(timer))
}

export function capturePage(page, { accepts, writeEntry, durationMs = 120000, maxEntries = 100,
  maxBytes = 16 * 1024 * 1024, maxEntryBytes = 768 * 1024, readTimeoutMs = 2000 } = {}) {
  if (![durationMs, maxEntries, maxBytes, maxEntryBytes, readTimeoutMs].every(Number.isSafeInteger)
      || durationMs < 1 || durationMs > 300000 || maxEntries < 1 || maxEntries > 500
      || maxBytes < 1024 || maxBytes > 32 * 1024 * 1024 || maxEntryBytes < 512 || maxEntryBytes > 768 * 1024
      || readTimeoutMs < 1 || readTimeoutMs > 5000 || typeof accepts !== 'function' || typeof writeEntry !== 'function') fail('E_CAPTURE_OPTIONS')
  const entries = [], active = new Map(), jobs = new Set()
  const report = { version: 1, selected: 0, captured: 0, skipped: 0, omitted: 0, bytes: 0,
    terminal: { finished: 0, failed: 0, inflight: 0 }, errors: {}, stop_reason: null,
    response_body: 'not_collected', business_health: 'unknown' }
  let stopped = false, stopping, fatal = false, limitTimer, pendingBytes = 0
  let resolveDone
  const done = new Promise(resolve => { resolveDone = resolve })
  const error = code => { report.errors[code] = (report.errors[code] || 0) + 1 }
  const omit = code => { report.omitted++; error(code) }
  const capacity = reason => {
    report.stop_reason ||= reason
    limitTimer ||= setTimeout(() => { void stop(reason) }, readTimeoutMs)
  }
  const reserve = (item, size) => {
    if (report.bytes + pendingBytes + size > maxBytes) {
      capacity('byte_limit'); fail('E_CAPTURE_BYTE_LIMIT')
    }
    pendingBytes += size
    item.reserved += size
  }
  const selected = request => {
    if (stopped || report.stop_reason) return
    try { if (!accepts(request.url())) { report.skipped++; return } }
    catch { error('E_CAPTURE_SCOPE'); void stop('scope_unavailable'); return }
    report.selected++
    const item = { request, started: Date.now(), finalizing: false, reserved: 0 }
    active.set(request, item)
    // Snapshot the request body now; postDataBuffer is local, not a replay.
    try {
      const body = request.postDataBuffer()
      if (body && body.length > maxEntryBytes) fail('E_CAPTURE_ENTRY_SIZE')
      if (body) {
        const text = body.toString('utf8')
        if (!Buffer.from(text).equals(body)) fail('E_CAPTURE_BINARY_BODY')
        item.body = text
      }
      item.url = request.url()
      item.method = request.method()
      const requestSize = bytes({ url: item.url, method: item.method, body: item.body })
      if (requestSize > maxEntryBytes) fail('E_CAPTURE_ENTRY_SIZE')
      reserve(item, requestSize)
      item.headers = wait(Promise.resolve().then(() => request.headersArray()), readTimeoutMs)
        .then(headers => {
          if (!Array.isArray(headers) || headers.length > 500 || bytes(headers) > maxEntryBytes
              || headers.some(h => typeof h.name !== 'string' || typeof h.value !== 'string')) fail('E_CAPTURE_HEADERS')
          reserve(item, bytes(headers))
          return { headers }
        }, () => ({ error: 'E_CAPTURE_REQUEST_HEADERS' }))
        .catch(e => ({ error: e.code || 'E_CAPTURE_HEADERS' }))
    } catch (e) {
      pendingBytes -= item.reserved
      active.delete(request); omit(e.code || 'E_CAPTURE_REQUEST')
    }
    // Limit ALL selected requests, including those whose capture failed.
    if (report.selected >= maxEntries) capacity('entry_limit')
  }
  const finalize = async (request, terminal) => {
    const item = active.get(request)
    if (!item || item.finalizing) return
    item.finalizing = true
    try {
      const h = await item.headers
      if (h.error) fail(h.error)
      const url = new URL(item.url)
      const requestRecord = { method: item.method, url: item.url, httpVersion: '',
        headers: h.headers, queryString: [...url.searchParams].map(([name, value]) => ({ name, value })),
        headersSize: -1, bodySize: item.body === undefined ? -1 : Buffer.byteLength(item.body) }
      if (item.body !== undefined) {
        const mimeType = h.headers.find(h => h.name.toLowerCase() === 'content-type')?.value
        if (!mimeType) fail('E_CAPTURE_CONTENT_TYPE')
        requestRecord.postData = { mimeType, text: item.body }
      } else if (h.headers.some(h => h.name.toLowerCase() === 'content-length' && Number(h.value) > 0)) {
        fail('E_CAPTURE_BODY_UNAVAILABLE')
      }
      let response = { status: 0, statusText: '', httpVersion: '', headers: [], cookies: [],
        content: { size: -1, mimeType: '' }, redirectURL: '', headersSize: -1, bodySize: -1 }
      if (terminal === 'finished') {
        const r = await wait(request.response(), readTimeoutMs)
        if (!r) fail('E_CAPTURE_RESPONSE_UNAVAILABLE')
        const headers = await wait(r.headersArray(), readTimeoutMs)
        if (headers.length > 500 || bytes(headers) > maxEntryBytes) fail('E_CAPTURE_ENTRY_SIZE')
        response = { ...response, status: r.status(), statusText: r.statusText(), headers,
          content: { size: -1, mimeType: headers.find(h => h.name.toLowerCase() === 'content-type')?.value || '' },
          redirectURL: headers.find(h => h.name.toLowerCase() === 'location')?.value || '' }
      }
      const entry = { startedDateTime: new Date(item.started).toISOString(), time: Date.now() - item.started,
        request: requestRecord, response, cache: {}, timings: { send: -1, wait: -1, receive: -1 },
        _silksec_capture: { version: 1, terminal, request_complete: true, response_body: 'not_collected' } }
      const size = bytes(entry)
      if (size > maxEntryBytes) fail('E_CAPTURE_ENTRY_SIZE')
      if (report.bytes + pendingBytes - item.reserved + size > maxBytes) { capacity('byte_limit'); fail('E_CAPTURE_BYTE_LIMIT') }
      // Synchronous durable sink: its failure stops subsequent capture.
      if (fatal) fail('E_CAPTURE_STORAGE')
      try { writeEntry(entry) }
      catch { fatal = true; error('E_CAPTURE_STORAGE'); void stop('storage_error'); fail('E_CAPTURE_STORAGE') }
      entries.push(entry)
      report.bytes += size
      report.captured++
      report.terminal[terminal]++
    } catch (e) { omit(e.code || 'E_CAPTURE_METADATA') }
    finally { pendingBytes -= item.reserved; active.delete(request) }
  }
  const queue = (request, terminal) => {
    const job = finalize(request, terminal)
    jobs.add(job); void job.finally(() => jobs.delete(job))
    return job
  }
  const finished = request => { void queue(request, 'finished') }
  const failed = request => { void queue(request, 'failed') }
  const closed = () => { void stop('page_closed') }
  const timer = setTimeout(() => { void stop('duration_limit') }, durationMs)
  function stop(reason = 'operator') {
    if (stopping) return stopping
    stopped = true
    report.stop_reason ||= reason
    clearTimeout(timer); clearTimeout(limitTimer)
    page.off('request', selected); page.off('requestfinished', finished); page.off('requestfailed', failed); page.off('close', closed)
    stopping = Promise.resolve().then(async () => {
      for (const item of active.values()) if (!item.finalizing) void queue(item.request, 'inflight')
      await Promise.allSettled([...jobs])
      report.ok = !fatal
      report.partial = report.omitted > 0 || report.terminal.failed > 0 || report.terminal.inflight > 0
        || ['scope_unavailable', 'guard_lost', 'disconnected', 'storage_error'].includes(report.stop_reason)
      const result = { entries, report }
      resolveDone(result)
      return result
    })
    return stopping
  }
  page.on('request', selected); page.on('requestfinished', finished); page.on('requestfailed', failed); page.on('close', closed)
  return { done, stop, report }
}

export function createCaptureFiles(dataDir, runId) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(runId)) fail('E_CAPTURE_RUN_ID')
  const root = fs.realpathSync(dataDir)
  let dir = root
  for (const part of ['results', runId]) {
    dir = path.join(dir, part)
    try { fs.mkdirSync(dir, { mode: 0o700 }) } catch (e) { if (e.code !== 'EEXIST') throw e }
    const stat = fs.lstatSync(dir)
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('E_CAPTURE_PATH')
  }
  dir = path.join(dir, 'browser-capture')
  fs.mkdirSync(dir, { mode: 0o700 }) // A run cannot overwrite a prior capture.
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW
  let fd = fs.openSync(path.join(dir, 'entries.jsonl'), flags, 0o600)
  const syncDirectory = directory => {
    const d = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY)
    try { fs.fsyncSync(d) } finally { fs.closeSync(d) }
  }
  for (let d = dir; d !== root; d = path.dirname(d)) syncDirectory(d)
  syncDirectory(root)
  const writeAll = (descriptor, data) => {
    const buffer = Buffer.from(data)
    let offset = 0
    while (offset < buffer.length) {
      const n = fs.writeSync(descriptor, buffer, offset, buffer.length - offset)
      if (!n) fail('E_CAPTURE_STORAGE')
      offset += n
    }
    fs.fsyncSync(descriptor)
  }
  const exclusive = (name, content) => {
    const f = fs.openSync(path.join(dir, name), flags, 0o600)
    try { writeAll(f, content) } finally { fs.closeSync(f) }
    syncDirectory(dir)
  }
  return {
    dir,
    writeEntry(entry) { if (fd === null) fail('E_CAPTURE_CLOSED'); writeAll(fd, JSON.stringify(entry) + '\n') },
    finish({ entries, report }, context) {
      const content = JSON.stringify({ log: { version: '1.2', creator: { name: 'silksec-browser-capture', version: '1' },
        _silksec_capture: { ...context, ...report }, entries } }) + '\n'
      exclusive('capture.har', content)
      const receipt = { ...context, ...report, har_path: path.relative(root, path.join(dir, 'capture.har')),
        source_sha256: digest(content), journal_path: path.relative(root, path.join(dir, 'entries.jsonl')) }
      exclusive('receipt.json', JSON.stringify(receipt) + '\n')
      return receipt
    },
    close() { if (fd !== null) { fs.closeSync(fd); fd = null } },
  }
}

async function main() {
  const { values: a } = parseArgs({ options: { base: { type: 'string', default: '/opt/silkspool/dsh' },
    program: { type: 'string' }, origin: { type: 'string' }, 'run-id': { type: 'string' },
    seconds: { type: 'string', default: '120' }, limit: { type: 'string', default: '100' },
    'max-bytes': { type: 'string', default: String(16 * 1024 * 1024) },
    'cdp-port': { type: 'string', default: '9222' }, help: { type: 'boolean' } }, strict: true })
  if (a.help) {
    console.log('Usage: node dsh-browser-capture.mjs --program PROGRAM --origin https://host --run-id RUN [--seconds 120] [--limit 100] [--max-bytes 16777216]\nPassively records ONE already-open matching page; no navigation, replay, credential lookup, or import. Raw capture files are private. Stop with SIGINT/SIGTERM.')
    return
  }
  if (!a.program || !a.origin || !a['run-id']) fail('E_CAPTURE_ARGUMENTS')
  const origin = new URL(a.origin)
  if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== a.origin) fail('E_CAPTURE_ORIGIN')
  const port = Number(a['cdp-port']), seconds = Number(a.seconds), limit = Number(a.limit), maxBytes = Number(a['max-bytes'])
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !Number.isInteger(seconds) || seconds < 1 || seconds > 300
      || !Number.isInteger(limit) || limit < 1 || limit > 500 || !Number.isInteger(maxBytes) || maxBytes < 1024 || maxBytes > 32 * 1024 * 1024) fail('E_CAPTURE_OPTIONS')
  const base = fs.realpathSync(a.base), data = path.join(base, 'data')
  const require = createRequire(path.join(data, 'profiles/web/package.json'))
  const { chromium } = require('playwright-core')
  const { createScopePolicy, verifyGuardedBrowser } = await import(pathToFileURL(path.join(data, 'profiles/web/node_modules/@silksec/dsh-browser/lib/scope.js')))
  const { checkTargetScope } = await import(pathToFileURL(path.join(base, 'plugins/sec-domain-scope/index.js')))
  const { parseScopeYaml } = await import(pathToFileURL(path.join(base, 'plugins/sec-backend-scope-file/index.js')))
  const policy = await createScopePolicy({ baseDir: base, dataDir: data })
  const accepts = raw => {
    const u = new URL(raw)
    if (u.origin !== origin.origin) return false
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) fail('E_CAPTURE_SCOPE')
    const snapshot = parseScopeYaml(fs.readFileSync(policy.scopeFile, 'utf8'))
    const decision = checkTargetScope(raw, snapshot, a.program)
    if (!decision.allow) fail('E_CAPTURE_SCOPE')
    return true
  }
  accepts(origin.href)
  let browser, sink, capture, checkTimer, checking = false
  const interrupted = () => { void capture?.stop('operator') }
  try {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 10000 })
    await verifyGuardedBrowser(browser, policy)
    const pages = browser.contexts().flatMap(c => c.pages()).filter(p => {
      try { return new URL(p.url()).origin === origin.origin } catch { return false }
    })
    if (pages.length !== 1) fail('E_CAPTURE_SELECT_ONE_PAGE')
    sink = createCaptureFiles(data, a['run-id'])
    capture = capturePage(pages[0], { accepts, writeEntry: entry => sink.writeEntry(entry),
      durationMs: seconds * 1000, maxEntries: limit, maxBytes })
    const context = { program_id: a.program, run_id: a['run-id'], started_at: new Date().toISOString(),
      origin_sha256: digest(origin.origin), guard_verified: true }
    browser.on('disconnected', () => { void capture.stop('disconnected') })
    process.on('SIGINT', interrupted); process.on('SIGTERM', interrupted)
    checkTimer = setInterval(async () => {
      if (checking) return
      checking = true
      try {
        accepts(origin.href)
        await wait(verifyGuardedBrowser(browser, policy), 3000)
      } catch { void capture.stop('guard_lost') }
      finally { checking = false }
    }, 1000)
    console.log(JSON.stringify({ state: 'capturing', program_id: a.program, run_id: a['run-id'], seconds, limit, max_bytes: maxBytes }))
    const result = await capture.done
    clearInterval(checkTimer)
    const receipt = sink.finish(result, { ...context, finished_at: new Date().toISOString() })
    console.log(JSON.stringify(receipt))
    if (!receipt.ok || receipt.partial) process.exitCode = 1
  } finally {
    clearInterval(checkTimer)
    process.off('SIGINT', interrupted); process.off('SIGTERM', interrupted)
    await capture?.stop('shutdown')
    sink?.close()
    // For a connectOverCDP client, close disconnects this client, leaving the host browser running.
    await browser?.close()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(e => { console.error(JSON.stringify({ ok: false, code: /^E_CAPTURE_/.test(e.code || '') ? e.code : 'E_CAPTURE_FAILED' })); process.exitCode = 1 })
}
