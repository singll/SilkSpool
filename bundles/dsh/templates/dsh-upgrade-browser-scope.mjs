// 仅在无外网 namespace 中验证实际安装的 browser fork、Chromium 和 CDP。
import * as fs from 'node:fs/promises'
import * as http from 'node:http'
import * as https from 'node:https'
import * as net from 'node:net'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const out = '/tmp/dsh-rehearsal'
await fs.access(path.join(out, 'isolation.json'))
const base = process.env.SEC_BASE_DIR
const data = process.env.SEC_DATA_DIR
const binary = process.argv[2]
const plugin = path.join(base, 'data/profiles/web/node_modules/@silksec/dsh-browser')
const { BrowserManager } = await import(pathToFileURL(path.join(plugin, 'lib/browser-manager.js')).href)
const { createScopeProxy } = await import(pathToFileURL(path.join(plugin, 'lib/scope.js')).href)
const require = createRequire(path.join(base, 'data/profiles/web/package.json'))
const { chromium } = require('playwright-core')
const scopeFile = path.join(data, 'scope.yml')
const originalScope = await fs.readFile(scopeFile)
await fs.writeFile(scopeFile, 'version: 1\ndefaults:\n  allow_risk: [passive, active]\n  rate_limit_qps: 100\nprograms:\n  - name: browser-fixture\n    scope:\n      - "127.0.0.1/32"\n')
const report = { ok: false, checks: [] }
const servers = [], managers = [], processes = [], browsers = []
const gets = [], upgrades = [], forwarded = []
const exec = { agent: { session: { header: { cwd: out } } } }
const check = async (name, fn) => { const details = await fn(); report.checks.push({ check: name, ok: true, ...details }) }
const listen = async server => { servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const timeout = (promise, ms = 10000) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('fixture timeout')), ms).unref())])
const assert = (condition, message) => { if (!condition) throw new Error(message) }
const manager = config => { const value = new BrowserManager(config); managers.push(value); return value }
const blocked = async fn => { let error; try { await fn() } catch (value) { error = value }; assert(error?.message.includes('E_SCOPE_BROWSER'), 'expected Scope refusal') }
const goto = (m, url) => m.run('browser_navigate', { url }, exec, async () => { await (await m.page()).goto(url); return m.currentPage.title() })
// 独立于页面的请求，复现 Chromium 更新/登录流量被全局代理拒绝的情况。
const backgroundRefusal = async m => {
  const cdp = await m.browser.newBrowserCDPSession()
  let endpoint
  try {
    const { arguments: args } = await cdp.send('Browser.getBrowserCommandLine')
    endpoint = new URL(args.find(arg => arg.startsWith('--proxy-server=')).slice('--proxy-server='.length))
  } finally { await cdp.detach() }
  await new Promise((resolve, reject) => {
    const req = http.get({ hostname: endpoint.hostname, port: endpoint.port, path: 'http://background.invalid/check', agent: false }, res => {
      res.resume()
      res.on('end', () => res.statusCode === 403 ? resolve() : reject(new Error('background request escaped Scope')))
    })
    req.on('error', reject)
  })
}
let flow
try {
  let port
  const handler = (req, res) => {
    gets.push({ host: req.headers.host.split(':')[0], path: req.url })
    if (req.url === '/redirect') { res.writeHead(302, { location: `http://localhost:${port}/redirect-denied` }); res.end(); return }
    if (req.url === '/sw.js') {
      res.writeHead(200, { 'content-type': 'application/javascript' })
      res.end(`self.addEventListener('message',event=>{fetch('http://localhost:${port}/worker-denied',{mode:'no-cors'}).catch(()=>{}).then(()=>event.source.postMessage('settled'))})`)
      return
    }
    res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'u2_login=fixture; Max-Age=3600; Path=/' })
    res.end('<title>U2_SCOPE_ALLOWED</title><body>U2 browser fixture</body>')
  }
  const server = http.createServer(handler)
  server.on('upgrade', (req, socket) => {
    upgrades.push(req.headers.host)
    const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n')
    socket.write(Buffer.from([0x81, 2, 111, 107]))
    socket.on('data', () => socket.end())
    socket.on('error', () => {})
  })
  port = await listen(server)
  const url = `http://127.0.0.1:${port}`
  const outside = `http://localhost:${port}`
  const plain = manager({ executablePath: binary, headless: true, navigationTimeoutMs: 8000 })
  await check('actual-manager-direct-scope-refusal', async () => {
    await blocked(() => goto(plain, outside + '/direct-denied'))
    assert(gets.length === 0, 'out-of-scope server was reached')
  })
  await check('actual-chromium-allowed-navigation', async () => assert(await goto(plain, url + '/allowed') === 'U2_SCOPE_ALLOWED', 'allowed navigation failed'))
  await check('unrelated-background-refusal-does-not-fail-page-action', async () => {
    const title = await plain.run('browser_eval', {}, exec, async () => {
      await backgroundRefusal(plain)
      return plain.currentPage.title()
    })
    assert(title === 'U2_SCOPE_ALLOWED', 'background denial was attributed to the page')
  })
  await check('redirect-target-refused-before-network', async () => {
    await blocked(() => goto(plain, url + '/redirect'))
    assert(!gets.some(row => row.host === 'localhost'), 'redirect bypassed Scope')
  })
  await goto(plain, url + '/allowed')
  await check('page-eval-fetch-refused-before-network', async () => {
    await blocked(() => plain.run('browser_eval', {}, exec, () => plain.currentPage.evaluate(target => fetch(target, { mode: 'no-cors' }).catch(() => null), outside + '/fetch-denied')))
    assert(!gets.some(row => row.host === 'localhost'), 'fetch bypassed Scope')
  })
  await check('page-websocket-refused-before-network', async () => {
    await blocked(() => plain.run('browser_eval', {}, exec, () => plain.currentPage.evaluate(target => new Promise(resolve => {
      const socket = new WebSocket(target); socket.onerror = () => resolve('denied'); socket.onopen = () => { socket.close(); resolve('opened') }
    }), outside.replace('http:', 'ws:') + '/ws-denied')))
    assert(upgrades.length === 0, 'WebSocket bypassed Scope')
  })
  await check('service-worker-fetch-refused-before-network', async () => {
    await blocked(() => plain.run('browser_eval', {}, exec, () => plain.currentPage.evaluate(async () => {
      await navigator.serviceWorker.register('/sw.js')
      const registration = await navigator.serviceWorker.ready
      return new Promise(resolve => {
        navigator.serviceWorker.onmessage = () => resolve('settled')
        registration.active.postMessage('go')
      })
    })))
    assert(!gets.some(row => row.host === 'localhost'), 'service worker bypassed Scope')
  })
  await check('page-rate-limit-refusal-is-still-reported', async () => {
    const scope = await fs.readFile(scopeFile, 'utf8')
    try {
      await fs.writeFile(scopeFile, scope.replace('rate_limit_qps: 100', 'rate_limit_qps: 1'))
      await blocked(() => plain.run('browser_eval', {}, exec, () => plain.currentPage.evaluate(async () => {
        await Promise.all(Array.from({ length: 4 }, (_, i) => fetch('/rate-limited?i=' + i, { cache: 'no-store' }).catch(() => null)))
      })))
    } finally { await fs.writeFile(scopeFile, scope) }
  })
  await check('browser-screenshot-obeys-workspace-guard', async () => {
    const before = await fs.readFile(scopeFile)
    let refused = false
    try { await plain.run('browser_screenshot', { path: scopeFile }, exec, () => { throw new Error('must not execute') }) }
    catch (error) { refused = error.message.includes('E_SCOPE_FILE_WRITE') }
    assert(refused && (await fs.readFile(scopeFile)).equals(before), 'screenshot could overwrite Scope')
    await plain.run('browser_screenshot', { path: 'allowed.png' }, exec, () => plain.currentPage.screenshot({ path: path.join(out, 'allowed.png') }))
    assert((await fs.stat(path.join(out, 'allowed.png'))).size > 0, 'allowed screenshot missing')
  })
  await plain.close()

  flow = await createScopeProxy({ policy: { scopeFile: 'fixture-forwarder', check(target) { forwarded.push(target); return { qps: 1000 } } }, upstream: '' })
  const reservation = net.createServer()
  reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening')
  const cdpPort = reservation.address().port
  await new Promise(resolve => reservation.close(resolve))
  const host = async () => {
    const process = spawn('/usr/local/node/bin/node', [path.join(path.dirname(fileURLToPath(import.meta.url)), 'dsh-shared-browser-host.mjs')], {
      stdio: ['ignore', 'pipe', 'pipe'], env: { ...globalThis.process.env, SEC_BROWSER_BINARY: binary, CDP_PORT: String(cdpPort),
        SEC_BROWSER_PROFILE: path.join(out, 'shared-profile'), SEC_FLOW_PROXY: flow.server },
    })
    processes.push(process)
    let logs = ''
    process.stdout.on('data', chunk => { logs += chunk })
    process.stderr.on('data', chunk => { logs += chunk })
    for (let i = 0; i < 150 && !logs.includes('SHARED_BROWSER_READY'); i++) {
      if (process.exitCode !== null) break
      await sleep(100)
    }
    await fs.writeFile(path.join(out, 'shared-host-' + processes.length + '.log'), logs)
    assert(logs.includes('SHARED_BROWSER_READY'), 'shared host failed; inspect private log')
    return process
  }
  let hostProcess = await host()
  const shared = manager({ cdpUrl: `http://127.0.0.1:${cdpPort}`, headless: true })
  await check('guarded-cdp-attach-keeps-shared-login-and-flow-proxy', async () => {
    assert(await goto(shared, url + '/shared-login') === 'U2_SCOPE_ALLOWED', 'CDP navigation failed')
    assert((await shared.context.cookies()).some(cookie => cookie.name === 'u2_login' && cookie.value === 'fixture'), 'shared login missing')
    assert(forwarded.some(target => target.endsWith('/shared-login')), 'SEC_FLOW_PROXY was bypassed')
    await shared.close()
    assert(hostProcess.exitCode === null, 'manager closed human shared browser')
    assert(!shared.isOpen, 'manager retained a CDP connection after close')
    assert(await goto(shared, url + '/shared-reopen') === 'U2_SCOPE_ALLOWED', 'same manager could not reattach')
  })
  await check('guarded-cdp-reports-refused-page-request', async () => {
    await blocked(() => shared.run('browser_eval', {}, exec, () => shared.currentPage.evaluate(target => fetch(target, { mode: 'no-cors' }).catch(() => null), outside + '/shared-fetch-denied')))
    assert(!gets.some(row => row.host === 'localhost'), 'shared page fetch bypassed Scope')
  })
  await check('guarded-cdp-keeps-background-denial-separate-from-page', async () => {
    const title = await shared.run('browser_eval', {}, exec, async () => {
      await backgroundRefusal(shared)
      return shared.currentPage.title()
    })
    assert(title === 'U2_SCOPE_ALLOWED', 'CDP background denial was attributed to the page')
  })
  await check('shared-browser-restart-preserves-persistent-cookie', async () => {
    const closed = once(hostProcess, 'exit'); hostProcess.kill('SIGTERM'); await timeout(closed)
    hostProcess = await host()
    await shared.launch()
    assert((await shared.context.cookies()).some(cookie => cookie.name === 'u2_login' && cookie.value === 'fixture'), 'login was lost on shared browser restart')
  })
  await check('shared-browser-https-connect-still-uses-flow-proxy', async () => {
    const key = path.join(out, 'fixture-tls.key'), cert = path.join(out, 'fixture-tls.pem')
    execFileSync('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
      '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1', '-days', '1'], { stdio: 'ignore' })
    const tlsPort = await listen(https.createServer({ key: await fs.readFile(key), cert: await fs.readFile(cert) }, handler))
    const attached = manager({ cdpUrl: `http://127.0.0.1:${cdpPort}` })
    assert(await goto(attached, `https://127.0.0.1:${tlsPort}/tls-allowed`) === 'U2_SCOPE_ALLOWED', 'HTTPS over CONNECT failed')
    assert(forwarded.some(target => new URL(target).href === `https://127.0.0.1:${tlsPort}/`), 'HTTPS bypassed flow proxy')
  })
  await check('unguarded-cdp-browser-refused', async () => {
    const unsafe = await chromium.launch({ executablePath: binary, headless: true, args: ['--no-sandbox', '--remote-debugging-port=9338'] })
    browsers.push(unsafe)
    const attached = manager({ cdpUrl: 'http://127.0.0.1:9338' })
    await blocked(() => attached.launch())
  })
  assert(!gets.some(row => row.host === 'localhost'), 'an out-of-scope request escaped')
  report.request_counts = { allowed: gets.length, outside: gets.filter(row => row.host === 'localhost').length, flow: forwarded.length, websocket: upgrades.length }
  report.ok = true
} catch (error) {
  report.error = { type: error.name, message: error.message }
} finally {
  report.fixture_requests = { gets, upgrades, forwarded }
  for (const m of managers) await m.close().catch(() => {})
  for (const b of browsers) await b.close().catch(() => {})
  for (const p of processes) if (p.exitCode === null) { p.kill('SIGTERM'); await timeout(once(p, 'exit')).catch(() => p.kill('SIGKILL')) }
  if (flow) await flow.close()
  for (const server of servers) { server.closeAllConnections?.(); server.close() }
  await fs.writeFile(scopeFile, originalScope)
  await fs.writeFile(path.join(out, 'browser-scope-report.json'), JSON.stringify(report, null, 2) + '\n')
}
console.log(JSON.stringify(report))
process.exit(report.ok ? 0 : 1)
