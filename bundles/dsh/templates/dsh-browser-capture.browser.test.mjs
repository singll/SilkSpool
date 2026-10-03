// Explicit integration gate: provide PLAYWRIGHT_MODULE and PLAYWRIGHT_BROWSERS_PATH.
import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import * as http from 'node:http'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createScopePolicy, createScopeProxy, GUARD_ARGS } from './dsh-browser-scope.js'
import { parseHar, harObservation } from './dsh-plugin-sec-domain-endpoint.har.js'

const templates = path.dirname(fileURLToPath(import.meta.url))
test('real guarded Chromium -> standalone capture -> HAR importer; detach leaves shared page alive', { timeout: 60000 }, async t => {
  assert.ok(process.env.PLAYWRIGHT_MODULE, 'set PLAYWRIGHT_MODULE to the installed playwright-core entry')
  const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE))
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'sec-browser-real-'))
  t.after(() => fs.rm(base, { recursive: true, force: true }))
  await fs.mkdir(path.join(base, 'data/profiles/web/node_modules/@silksec/dsh-browser/lib'), { recursive: true })
  await fs.writeFile(path.join(base, 'data/profiles/web/package.json'), '{"type":"module"}')
  await fs.symlink(path.dirname(process.env.PLAYWRIGHT_MODULE), path.join(base, 'data/profiles/web/node_modules/playwright-core'), 'dir')
  await fs.copyFile(path.join(templates, 'dsh-browser-scope.js'), path.join(base, 'data/profiles/web/node_modules/@silksec/dsh-browser/lib/scope.js'))
  for (const name of ['sec-domain-scope', 'sec-backend-scope-file', 'sec-backend-scope-sqlite']) {
    await fs.mkdir(path.join(base, 'plugins', name), { recursive: true })
    await fs.copyFile(path.join(templates, `dsh-plugin-${name}.js`), path.join(base, 'plugins', name, 'index.js'))
  }
  await fs.writeFile(path.join(base, 'data/scope.yml'), 'version: 1\ndefaults:\n  allow_risk: [passive, active]\n  rate_limit_qps: 100\nprograms:\n  - name: fixture\n    scope:\n      - "127.0.0.1/32"\n')
  const policy = await createScopePolicy({ baseDir: base })
  const proxy = await createScopeProxy({ policy, upstream: '' })
  t.after(() => proxy.close())
  const received = []
  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    received.push({ method: req.method, url: req.url, body: Buffer.concat(chunks).toString(), cookie: req.headers.cookie })
    res.writeHead(200, { 'content-type': req.url === '/' ? 'text/html' : 'application/json' })
    res.end(req.url === '/' ? '<title>Business fixture</title>' : '{"ok":true}')
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => new Promise(resolve => server.close(resolve)))
  const origin = `http://127.0.0.1:${server.address().port}`
  const portProbe = http.createServer()
  portProbe.listen(0, '127.0.0.1'); await once(portProbe, 'listening')
  const cdpPort = portProbe.address().port
  await new Promise(resolve => portProbe.close(resolve))
  const browserContext = await chromium.launchPersistentContext(path.join(base, 'profile'), {
    headless: true, proxy: { server: proxy.server, bypass: proxy.bypass },
    args: [...GUARD_ARGS, '--no-sandbox', '--remote-debugging-port=' + cdpPort],
  })
  t.after(() => browserContext.close())
  const page = browserContext.pages()[0]
  await page.goto(origin)
  await browserContext.addCookies([{ name: 'auth', value: 'PRIVATE-COOKIE', url: origin }])
  const launchCapture = (run, extra = []) => {
    const child = spawn(process.execPath, [path.join(templates, 'dsh-browser-capture.mjs'),
      '--base', base, '--program', 'fixture', '--origin', origin, '--run-id', run,
      '--cdp-port', String(cdpPort), '--seconds', '20', ...extra], { stdio: ['ignore', 'pipe', 'pipe'] })
    const output = [], errors = []
    const ready = new Promise((resolve, reject) => {
      let buffer = ''
      child.stdout.on('data', data => {
        buffer += data
        for (;;) {
          const end = buffer.indexOf('\n')
          if (end < 0) break
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
          try { const r = JSON.parse(line); output.push(r); if (r.state === 'capturing') resolve() }
          catch { reject(new Error('capture emitted non-JSON output')) }
        }
      })
      child.on('exit', () => reject(new Error('capture exited before ready: ' + errors.join(''))))
      child.on('error', reject)
    })
    child.stderr.on('data', d => errors.push(String(d)))
    const closed = once(child, 'exit')
    t.after(() => { if (child.exitCode === null) child.kill('SIGTERM') })
    return { child, ready, closed, output, errors }
  }
  const first = launchCapture('first', ['--limit', '3'])
  await first.ready
  const bodies = ['{"order":{"id":"自有对象"},"password":"PRIVATE-PASSWORD"}', 'id=11&id=22&csrf=PRIVATE-CSRF']
  await page.evaluate(async ({ bodies }) => {
    await fetch('/orders?tag=a&tag=b', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: bodies[0] })
    await fetch('/form', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: bodies[1] })
    await fetch('/read?id=11')
  }, { bodies })
  assert.equal((await first.closed)[0], 0, first.errors.join(''))
  const receipt = first.output.at(-1)
  assert.equal(receipt.captured, 3)
  assert.equal(receipt.stop_reason, 'entry_limit')
  assert.equal(receipt.partial, false)
  assert.equal(/PRIVATE/.test(JSON.stringify(first.output)), false)
  const raw = await fs.readFile(path.join(base, 'data', receipt.har_path)), har = parseHar(raw)
  assert.equal(har.sha256, receipt.source_sha256)
  assert.equal(har.entries[0].request.postData.text, bodies[0])
  assert.equal(har.entries[1].request.postData.text, bodies[1])
  for (const [index, entry] of har.entries.entries()) {
    const observation = harObservation(entry, { sourceSha256: har.sha256, index, programId: 'fixture', runId: 'first' }).observation
    assert.equal(/PRIVATE/.test(JSON.stringify(observation)), false)
  }
  assert.equal(await page.title(), 'Business fixture', 'CDP capture close must leave shared browser alive')
  assert.equal(received.filter(r => r.url === '/orders?tag=a&tag=b').length, 1, 'capture must not replay')
  assert.equal(received.find(r => r.url === '/orders?tag=a&tag=b').cookie, 'auth=PRIVATE-COOKIE')
  const duplicatePage = await browserContext.newPage()
  await duplicatePage.goto(origin)
  const ambiguous = launchCapture('ambiguous')
  await assert.rejects(ambiguous.ready, /E_CAPTURE_SELECT_ONE_PAGE/)
  assert.equal((await ambiguous.closed)[0], 1)
  await assert.rejects(fs.access(path.join(base, 'data/results/ambiguous')))
  await duplicatePage.close()
  const second = launchCapture('revoked')
  await second.ready
  await fs.writeFile(path.join(base, 'data/scope.yml'), 'programs: []\n')
  assert.equal((await second.closed)[0], 1)
  assert.equal(second.output.at(-1).stop_reason, 'guard_lost')
  assert.equal(second.output.at(-1).captured, 0)
  assert.equal(await page.title(), 'Business fixture')
  await fs.writeFile(path.join(base, 'data/scope.yml'), 'programs:\n  - name: fixture\n    scope:\n      - "127.0.0.1/32"\n')
  const unguarded = await chromium.launchPersistentContext(path.join(base, 'unguarded'), {
    headless: true, args: ['--no-sandbox', '--remote-debugging-port=' + (cdpPort + 1)],
  })
  t.after(() => unguarded.close())
  await unguarded.pages()[0].goto(origin)
  const refused = launchCapture('unguarded', ['--cdp-port', String(cdpPort + 1)])
  await assert.rejects(refused.ready, /E_CAPTURE_FAILED/)
  assert.equal((await refused.closed)[0], 1)
  await assert.rejects(fs.access(path.join(base, 'data/results/unguarded')))
})
