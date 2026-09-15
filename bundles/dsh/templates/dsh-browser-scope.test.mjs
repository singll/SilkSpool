import assert from 'node:assert/strict'
import test from 'node:test'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import * as http from 'node:http'
import * as net from 'node:net'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { createScopePolicy, createScopeProxy, targetUrl, targetOriginHash, upstreamUrl } from './dsh-browser-scope.js'

const templates = path.dirname(fileURLToPath(import.meta.url))
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'silksec-browser-scope-'))
  await fs.mkdir(path.join(dir, 'data'))
  for (const name of ['sec-domain-scope', 'sec-backend-scope-file', 'sec-backend-scope-sqlite']) {
    const target = path.join(dir, 'plugins', name)
    await fs.mkdir(target, { recursive: true })
    await fs.copyFile(path.join(templates, 'dsh-plugin-' + name + '.js'), path.join(target, 'index.js'))
  }
  await fs.writeFile(path.join(dir, 'package.json'), '{"type":"module"}')
  const scopeFile = path.join(dir, 'data/scope.yml')
  await fs.writeFile(scopeFile, 'version: 1\ndefaults:\n  allow_risk: [passive, active]\nprograms:\n  - name: fixture\n    scope:\n      - "127.0.0.1/32"\n')
  const policy = await createScopePolicy({ baseDir: dir })
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  return { policy, scopeFile }
}

async function listening(t, server) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise(resolve => server.close(resolve)))
  return server.address().port
}

async function request(proxy, target) {
  const url = new URL(proxy.server)
  return new Promise((resolve, reject) => {
    const req = http.get({ host: url.hostname, port: url.port, path: target, agent: false }, res => {
      let body = ''
      res.on('data', chunk => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }))
    })
    req.on('error', reject)
  })
}

async function tunnel(proxy, authority) {
  const url = new URL(proxy.server)
  return new Promise((resolve, reject) => {
    const req = http.request({ host: url.hostname, port: url.port, method: 'CONNECT', path: authority, agent: false })
    req.once('connect', (res, socket, head) => resolve({ res, socket, head }))
    req.once('error', reject)
    req.end()
  })
}

test('actual proxy checks canonical Scope for direct requests and every redirect', async t => {
  const { policy, scopeFile } = await fixture(t)
  let reached = 0
  const port = await listening(t, http.createServer((req, res) => {
    reached++
    if (req.url === '/redirect') res.writeHead(302, { location: `http://localhost:${port}/blocked` })
    res.end('allowed')
  }))
  const proxy = await createScopeProxy({ policy, upstream: '' })
  t.after(() => proxy.close())
  assert.equal((await request(proxy, `http://127.0.0.1:${port}/allowed`)).body, 'allowed')
  const redirect = await request(proxy, `http://127.0.0.1:${port}/redirect`)
  assert.equal(redirect.status, 302)
  assert.equal((await request(proxy, redirect.headers.location)).status, 403)
  assert.equal(reached, 2)
  await fs.writeFile(scopeFile, 'programs: []\n')
  assert.equal((await request(proxy, `http://127.0.0.1:${port}/revoked`)).status, 403)
  await fs.unlink(scopeFile)
  assert.equal((await request(proxy, `http://127.0.0.1:${port}/missing-scope`)).status, 403)
  assert.equal(reached, 2)
})

test('CONNECT is refused before dial and existing tunnels close after Scope revocation', async t => {
  const { policy, scopeFile } = await fixture(t)
  let reached = 0
  const port = await listening(t, net.createServer(socket => { reached++; socket.pipe(socket) }))
  const proxy = await createScopeProxy({ policy, upstream: '' })
  t.after(() => proxy.close())
  const denied = await tunnel(proxy, `localhost:${port}`)
  assert.equal(denied.res.statusCode, 403)
  denied.socket.destroy()
  assert.equal(reached, 0)
  const allowed = await tunnel(proxy, `127.0.0.1:${port}`)
  assert.equal(allowed.res.statusCode, 200)
  const incoming = once(allowed.socket, 'data')
  allowed.socket.write('tunnel bytes')
  assert.equal((await incoming)[0].toString(), 'tunnel bytes')
  assert.equal(reached, 1)
  const closed = once(allowed.socket, 'close')
  await fs.writeFile(scopeFile, 'programs: []\n')
  await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error('revoked tunnel stayed open')), 1500).unref())])
})

test('upstream flow proxy receives allowed HTTP and CONNECT; failure never falls back to direct', async t => {
  const { policy } = await fixture(t)
  let direct = 0
  const port = await listening(t, http.createServer((req, res) => { direct++; res.end('unexpected direct') }))
  const requests = []
  const upstream = http.createServer((req, res) => { requests.push(req.url); res.end('flow proxy') })
  upstream.on('connect', (req, socket) => {
    requests.push('CONNECT ' + req.url)
    socket.end('HTTP/1.1 200 Connection Established\r\n\r\nproxied tunnel')
  })
  const nextPort = await listening(t, upstream)
  const proxy = await createScopeProxy({ policy, upstream: `http://127.0.0.1:${nextPort}` })
  t.after(() => proxy.close())
  const url = `http://127.0.0.1:${port}/flow`
  assert.equal((await request(proxy, url)).body, 'flow proxy')
  const conn = await tunnel(proxy, `127.0.0.1:${port}`)
  assert.equal(conn.res.statusCode, 200)
  conn.socket.destroy()
  assert.deepEqual(requests, [url, `CONNECT 127.0.0.1:${port}`])
  assert.equal((await request(proxy, `http://localhost:${port}/blocked`)).status, 403)
  assert.equal(requests.length, 2)
  await new Promise(resolve => upstream.close(resolve))
  assert.equal((await request(proxy, url)).status, 502)
  assert.equal(direct, 0)
})

test('invalid protocols, credentials, and proxy URLs fail before browser launch', () => {
  for (const url of ['file:///etc/passwd', 'javascript:fetch(1)', 'data:text/html,x', 'http://user:pass@example.com', ' http://example.com']) {
    assert.throws(() => targetUrl(url), /E_SCOPE_BROWSER/)
  }
  for (const url of ['socks5://127.0.0.1:1080', 'garbage', 'http://127.0.0.1/path', 'https://127.0.0.1/?x=1']) {
    assert.throws(() => upstreamUrl(url), /E_SCOPE_BROWSER/)
  }
})

test('bounded refusal audit correlates HTTP/WebSocket/CONNECT without retaining URLs', async t => {
  const { policy } = await fixture(t)
  const proxy = await createScopeProxy({ policy, upstream: '' })
  t.after(() => proxy.close())
  assert.equal(targetOriginHash('wss://example.com/a?secret=private'), targetOriginHash('https://example.com:443/'))
  assert.equal(targetOriginHash('ws://example.com/a'), targetOriginHash('http://example.com/'))
  assert.notEqual(targetOriginHash('http://example.com/'), targetOriginHash('https://example.com/'))
  const initial = proxy.status()
  assert.equal(initial.denied, 0)
  for (let i = 0; i < 260; i++) assert.equal((await request(proxy, 'http://outside.invalid/a?private=' + i)).status, 403)
  const status = proxy.status()
  assert.equal(status.denied, 260)
  assert.equal(status.denials.length, 256)
  assert.equal(status.denials[0].sequence, 5)
  assert.equal(status.denials.at(-1).sequence, 260)
  assert(status.denials.every(row => row.origin === targetOriginHash('http://outside.invalid/')))
  assert(!JSON.stringify(status).includes('private'))
  assert(!JSON.stringify(status).includes('outside.invalid'))
  assert.equal(initial.denials.length, 0, 'earlier cursor snapshot must remain stable')
})
