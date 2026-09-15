// Browser fork 的强制出站边界。所有浏览器协议共用 scope 域的匹配语义。
// HTTP 重定向、fetch、WebSocket、worker 都受 Chromium 全局代理约束；
// SEC_FLOW_PROXY 是下一跳，故障时不回退直连。
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as http from 'node:http'
import * as https from 'node:https'
import * as net from 'node:net'
import * as crypto from 'node:crypto'
import { pathToFileURL, fileURLToPath } from 'node:url'

export const GUARD_ARGS = [
  // Playwright 1.62 不再默认添加；CDP 启动参数核验需要此开关。
  '--enable-automation',
  // Playwright 1.62 不再默认抑制 Chrome 的更新/登录/安全浏览后台请求。
  // 尽量减少后台流量；剩余请求仍由代理检查，不能用全局计数归因页面操作。
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-sync',
  '--disable-client-side-phishing-detection',
  '--disable-default-apps',
  '--metrics-recording-only',
  '--no-first-run',
  '--disable-quic',
  '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
  '--webrtc-ip-handling-policy=disable_non_proxied_udp',
]
const HEALTH_PATH = '/__silksec_browser_scope'
const GUARD_SHA = crypto.createHash('sha256').update(fs.readFileSync(fileURLToPath(import.meta.url))).digest('hex')

export function scopeError(reason) {
  return new Error('E_SCOPE_BROWSER: ' + reason + '；授权变更请使用 Scope 审批入口。')
}

export function targetUrl(raw) {
  if (typeof raw !== 'string' || /[\x00-\x20\x7f]/.test(raw)) throw scopeError('目标 URL 不合法')
  let url
  try { url = new URL(raw) } catch { throw scopeError('目标 URL 不合法') }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) || url.username || url.password) {
    throw scopeError('只允许无内嵌凭据的 HTTP(S)/WebSocket 目标')
  }
  return url
}

// CONNECT 只提供 origin；将 WebSocket 映射到相同的 HTTP(S) 出口。
// 审计只保留摘要，不收集页面路径、查询参数、凭据或请求内容。
export function targetOriginHash(raw) {
  const url = targetUrl(raw)
  if (url.protocol === 'ws:') url.protocol = 'http:'
  if (url.protocol === 'wss:') url.protocol = 'https:'
  return crypto.createHash('sha256').update(url.origin).digest('hex')
}

export async function createScopePolicy({ baseDir = process.env.SEC_BASE_DIR || '/opt/silkspool/dsh',
  dataDir = process.env.SEC_DATA_DIR || path.join(baseDir, 'data') } = {}) {
  const [{ checkTargetScope }, { parseScopeYaml }] = await Promise.all([
    import(pathToFileURL(path.join(baseDir, 'plugins/sec-domain-scope/index.js')).href),
    import(pathToFileURL(path.join(baseDir, 'plugins/sec-backend-scope-file/index.js')).href),
  ])
  const scopeFile = path.resolve(dataDir, 'scope.yml')
  return {
    scopeFile,
    check(raw) {
      const url = targetUrl(raw)
      let snapshot
      try { snapshot = parseScopeYaml(fs.readFileSync(scopeFile, 'utf8')) }
      catch { throw scopeError('无法读取授权文件，拒绝请求') }
      const decision = checkTargetScope(url.href, snapshot)
      if (!decision.allow) throw scopeError(decision.reason)
      // 浏览器脚本及交互具备 active 能力，不能把任意 JS 当 passive 工具。
      if (!snapshot.defaults.allow_risk.includes('active') || decision.program_cfg?.rules?.max_risk === 'passive') {
        throw scopeError('项目规则未允许 active 浏览器交互')
      }
      return { ...decision, qps: Math.max(1, Math.min(1000, Number(snapshot.defaults.rate_limit_qps) || 50)) }
    },
  }
}

export function upstreamUrl(raw) {
  if (!raw) return null
  let url
  try { url = new URL(raw) } catch { throw scopeError('SEC_FLOW_PROXY 不是有效 URL') }
  if (!['http:', 'https:'].includes(url.protocol) || url.pathname !== '/' || url.search || url.hash) {
    throw scopeError('SEC_FLOW_PROXY 必须是 HTTP(S) 代理地址')
  }
  return url
}

function proxyHeaders(upstream) {
  if (!upstream?.username && !upstream?.password) return {}
  const auth = decodeURIComponent(upstream.username) + ':' + decodeURIComponent(upstream.password)
  return { 'proxy-authorization': 'Basic ' + Buffer.from(auth).toString('base64') }
}

function respondDenied(response) {
  if (response instanceof http.ServerResponse) {
    if (!response.headersSent) response.writeHead(403, { 'content-type': 'text/plain', connection: 'close' })
    response.end('E_SCOPE_BROWSER: request refused by Scope policy')
  } else {
    response.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 15\r\n\r\nE_SCOPE_BROWSER')
  }
}

function connectHeaders(response) {
  let text = `HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n`
  for (let i = 0; i < response.rawHeaders.length; i += 2) {
    if (/^proxy-auth/i.test(response.rawHeaders[i])) continue
    text += response.rawHeaders[i] + ': ' + response.rawHeaders[i + 1] + '\r\n'
  }
  return text + '\r\n'
}

export async function createScopeProxy({ policy, upstream = process.env.SEC_FLOW_PROXY || '', maxConnections = 128 }) {
  const next = upstreamUrl(upstream)
  const upstreamTransport = next?.protocol === 'https:' ? https : http
  const sockets = new Set()
  const targets = new Map()
  let denied = 0
  const denials = []
  const status = () => ({ version: 2, scopeFile: policy.scopeFile, guardSha: GUARD_SHA, denied, denials: [...denials] })
  const recordDenied = raw => {
    let origin = null
    try { origin = targetOriginHash(raw) } catch {}
    denials.push({ sequence: ++denied, origin })
    if (denials.length > 256) denials.shift()
  }
  let closed = false
  let rateWindow = 0
  let rateUsed = 0
  const server = http.createServer()
  server.maxHeadersCount = 100
  server.headersTimeout = 10000
  server.requestTimeout = 30000
  server.on('connection', socket => {
    if (closed || sockets.size >= maxConnections) { socket.destroy(); return }
    sockets.add(socket)
    socket.on('error', () => {})
    socket.on('close', () => { sockets.delete(socket); targets.delete(socket) })
  })
  const check = raw => {
    const decision = policy.check(raw)
    const second = Math.floor(Date.now() / 1000)
    if (second !== rateWindow) { rateWindow = second; rateUsed = 0 }
    if (++rateUsed > decision.qps) throw scopeError('浏览器请求速率已达 Scope 上限')
    return targetUrl(raw)
  }
  const deny = (response, raw) => { recordDenied(raw); respondDenied(response) }
  const relay = (client, remote, target) => {
    targets.set(client, target)
    sockets.add(remote)
    client.on('close', () => remote.destroy())
    remote.on('close', () => { sockets.delete(remote); client.destroy() })
    remote.on('error', () => client.destroy())
    client.setTimeout(120000, () => client.destroy())
    remote.pipe(client)
    client.pipe(remote)
  }
  const forwardOptions = (req, url) => {
    const headers = { ...req.headers, host: url.host }
    delete headers['proxy-authorization']
    delete headers['proxy-connection']
    return next ? { hostname: next.hostname, port: next.port || (next.protocol === 'https:' ? 443 : 80),
      method: req.method, path: url.href.replace(/^ws:/, 'http:'), headers: { ...headers, ...proxyHeaders(next) }, agent: false }
      : { hostname: url.hostname.replace(/^\[|\]$/g, ''), port: url.port || 80,
        method: req.method, path: url.pathname + url.search, headers, agent: false }
  }
  const forwardHttp = (req, response, head) => {
    let url
    try {
      url = check(req.url)
      if (!['http:', 'ws:'].includes(url.protocol)) throw scopeError('TLS 请求必须使用 CONNECT')
    } catch { deny(response, req.url); return }
    const request = (next ? upstreamTransport : http).request(forwardOptions(req, url))
    request.on('error', () => {
      if (response instanceof http.ServerResponse && !response.headersSent) {
        response.writeHead(502, { connection: 'close' })
        response.end('Browser upstream proxy unavailable')
      } else response.destroy()
    })
    request.setTimeout(30000, () => request.destroy())
    req.on('aborted', () => request.destroy())
    if (head !== undefined) {
      request.on('upgrade', (res, remote, remoteHead) => {
        response.write(connectHeaders(res))
        if (remoteHead.length) response.write(remoteHead)
        if (head.length) remote.write(head)
        relay(response, remote, url.href)
      })
      request.on('response', () => { request.destroy(); response.destroy() })
      request.end()
    } else {
      targets.set(req.socket, url.href)
      response.on('close', () => request.destroy())
      request.on('response', res => {
        const headers = { ...res.headers }
        delete headers['proxy-authenticate']
        response.writeHead(res.statusCode, headers)
        res.pipe(response)
      })
      req.pipe(request)
    }
  }
  server.on('request', (req, response) => {
    // origin-form 私有健康查询供本机 CDP 附着验证；浏览器的代理请求必须 absolute-form。
    if (req.url === HEALTH_PATH && req.method === 'GET') {
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      response.end(JSON.stringify(status()))
      return
    }
    forwardHttp(req, response)
  })
  server.on('upgrade', (req, socket, head) => forwardHttp(req, socket, head))
  server.on('connect', (req, client, head) => {
    let url
    try {
      url = check('https://' + req.url)
      if (url.hostname + ':' + (url.port || '443') !== req.url || url.pathname !== '/' || url.search || url.hash) throw scopeError('CONNECT authority 不合法')
    } catch { deny(client, 'https://' + req.url); return }
    const connected = remote => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) remote.write(head)
      relay(client, remote, url.href)
    }
    if (next) {
      const request = upstreamTransport.request({ hostname: next.hostname, port: next.port || (next.protocol === 'https:' ? 443 : 80),
        method: 'CONNECT', path: req.url, headers: { host: req.url, ...proxyHeaders(next) }, agent: false })
      request.on('connect', (res, remote, remoteHead) => {
        if (res.statusCode !== 200) { remote.destroy(); client.destroy(); return }
        connected(remote)
        if (remoteHead.length) client.write(remoteHead)
      })
      request.on('error', () => client.destroy())
      request.setTimeout(15000, () => request.destroy())
      client.on('close', () => request.destroy())
      request.end()
    } else {
      const remote = net.connect(Number(url.port) || 443, url.hostname.replace(/^\[|\]$/g, ''))
      remote.on('error', () => client.destroy())
      remote.setTimeout(15000, () => remote.destroy())
      remote.once('connect', () => connected(remote))
      client.on('close', () => remote.destroy())
    }
  })
  // 撤销后关闭已有长连接，防止已建立的 CONNECT/WebSocket 无限沿用旧授权。
  const recheck = () => {
    for (const [socket, target] of targets) {
      try { policy.check(target) } catch { recordDenied(target); socket.destroy() }
    }
  }
  const timer = setInterval(recheck, 250)
  timer.unref()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return {
    server: 'http://127.0.0.1:' + server.address().port,
    bypass: '<-loopback>',
    get denied() { return denied },
    status,
    async close() {
      closed = true
      clearInterval(timer)
      for (const socket of sockets) socket.destroy()
      await new Promise(resolve => server.close(resolve))
    },
  }
}

export async function verifyGuardedBrowser(browser, policy) {
  const cdp = await browser.newBrowserCDPSession()
  let args
  try { args = (await cdp.send('Browser.getBrowserCommandLine')).arguments }
  catch { throw scopeError('无法核验 CDP 浏览器启动参数，需重启受管共享宿主') }
  finally { await cdp.detach() }
  const option = name => args.filter(arg => arg.startsWith(name + '='))
  const proxy = option('--proxy-server')
  const bypass = option('--proxy-bypass-list')
  if (proxy.length !== 1 || bypass.length !== 1 || !bypass[0].slice('--proxy-bypass-list='.length).split(';').every(item => item === '<-loopback>')
    || !GUARD_ARGS.every(arg => args.includes(arg)) || args.includes('--no-proxy-server')) {
    throw scopeError('CDP 浏览器未启用完整 Scope 出口守卫，需重启受管共享宿主')
  }
  const url = new URL(proxy[0].slice('--proxy-server='.length))
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port) throw scopeError('CDP 的 Scope 代理不是受管本机地址')
  const health = await new Promise((resolve, reject) => {
    const req = http.get(new URL(HEALTH_PATH, url), res => {
      let text = ''
      res.on('data', chunk => { text += chunk; if (text.length > 65536) req.destroy(scopeError('Scope 代理健康响应过大')) })
      res.on('end', () => { try { resolve(JSON.parse(text)) } catch { reject(scopeError('Scope 代理健康检查失败')) } })
    })
    req.on('error', reject)
    req.setTimeout(2000, () => req.destroy(scopeError('Scope 代理健康检查超时')))
  })
  if (health.version !== 2 || health.scopeFile !== policy.scopeFile || health.guardSha !== GUARD_SHA
    || !Number.isSafeInteger(health.denied) || health.denied < 0 || !Array.isArray(health.denials)
    || health.denials.length !== Math.min(health.denied, 256) || health.denials.some((row, i) => row.sequence !== health.denied - health.denials.length + i + 1
      || (row.origin !== null && !/^[a-f0-9]{64}$/.test(row.origin)))) {
    throw scopeError('CDP 代理的代码或 Scope 归属不匹配')
  }
  return health
}
