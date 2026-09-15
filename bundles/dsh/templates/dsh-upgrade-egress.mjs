// 仅由 egress.py 传入受限运行配置；凭据只经 stdin/内存，报告不保存内容。
import fs from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import net from 'node:net'
import assert from 'node:assert/strict'

let input = ''
for await (const chunk of process.stdin) input += chunk
const config = JSON.parse(input)
input = ''
const { base, out, settings, env, browserBin } = config
Object.assign(process.env, env, { SEC_BASE_DIR: base, SEC_DATA_DIR: path.join(out, 'data'), SEC_SHARED_BROWSER: '0' })
const require = createRequire(await fs.realpath(path.join(base, 'app/node_modules/@deepseek-ai/dsh/package.json')))
const proxy = await import(require.resolve('@deepseek-ai/dsh-http-proxy'))
const diagnostics = []
const restore = await proxy.installProxyFromEnvironment({ get: name => process.env[name] === undefined ? undefined : { value: process.env[name] } }, message => diagnostics.push(message))
assert.equal(diagnostics.length, 0, 'unsupported proxy environment')
const report = { ok: false, started_at: new Date().toISOString(), checks: [] }
const safeRoute = route => route.proxied ? { proxied: true, host: new URL(route.proxy).hostname, port: new URL(route.proxy).port } : { proxied: false }
const check = async (name, run) => {
  if (config.only && config.only !== name) return
  const start = Date.now()
  try { const value = await run(); report.checks.push({ name, ok: true, elapsed_ms: Date.now() - start, ...value }) }
  catch (error) { report.checks.push({ name, ok: false, code: error.code ?? error.name, message: String(error.message).replace(/Bearer\s+\S+/gi, 'Bearer [redacted]'),
    ...(error.transport ? { transport: error.transport } : {}) }) }
}
let context, browser, host
try {
  await check('actual-bellkeeper-pi-ai-stream', async () => {
    const selected = settings['agent-default-model']
    const definition = settings['llm-pi-ai'].providers[selected.provider]
    const key = env[definition.apiKeyEnv]
    assert(key, 'configured API key missing')
    const adapterModule = require.resolve('@deepseek-ai/dsh-llm-pi-ai')
    const PiAiPlugin = await import(adapterModule)
    const { Context } = await import(require.resolve('@deepseek-ai/cordis'))
    const { default: LlmRuntime, createUserMessage } = await import(require.resolve('@deepseek-ai/dsh-llm'))
    context = new Context()
    await context.plugin(LlmRuntime)
    await context.plugin(PiAiPlugin, { providers: { [selected.provider]: definition } })
    const requests = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input)
      assert.equal(url.origin, new URL(definition.baseURL).origin, 'model transport changed destination')
      requests.push({ route: safeRoute(proxy.proxyRouteFor(url)), path: url.pathname })
      return originalFetch(input, init)
    }
    let answer = '', usage, finish
    const start = Date.now()
    try {
      for await (const chunk of context.llm.stream({ provider: selected.provider, model: selected.model,
        reasoningEffort: selected.reasoningEffort, maxTokens: 128, signal: AbortSignal.timeout(60000),
        messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text',
          text: 'This is a bounded deployment connectivity check. Reply with exactly OK. Do not use tools.' }] })] })) {
        if (chunk.type === 'text-delta') answer += chunk.text
        if (chunk.type === 'usage') usage = chunk.usage
        if (chunk.type === 'finish') finish = chunk.reason
      }
    } finally { globalThis.fetch = originalFetch }
    assert(requests.length > 0 && answer.trim() === 'OK', 'model did not return the bounded check answer')
    return { provider: selected.provider, model: selected.model, requested_effort: selected.reasoningEffort,
      requests, usage, finish, max_tokens: 128, elapsed_ms: Date.now() - start,
      response_sha256: createHash('sha256').update(answer).digest('hex') }
  })
  const target = 'https://example.com/'
  await check('actual-fetch-current-environment', async () => {
    const response = await fetch(target, { signal: AbortSignal.timeout(25000), redirect: 'error' })
    const text = await response.text()
    assert(response.ok && text.includes('Example Domain'), 'fetch did not reach the benign target')
    return { status: response.status, route: safeRoute(proxy.proxyRouteFor(new URL(target))) }
  })
  await check('actual-cli-egress-proxy', async () => {
    assert(env.SEC_EGRESS_PROXY, 'CLI egress proxy missing')
    const inherited = { ...process.env, http_proxy: env.SEC_EGRESS_PROXY, https_proxy: env.SEC_EGRESS_PROXY,
      HTTP_PROXY: env.SEC_EGRESS_PROXY, HTTPS_PROXY: env.SEC_EGRESS_PROXY }
    const result = spawnSync('curl', ['--silent', '--show-error', '--max-time', '25', '--output', path.join(out, 'cli-body'),
      '--write-out', '%{http_code} %{remote_ip} %{remote_port} %{time_connect} %{time_starttransfer} %{time_total}', target], { env: inherited, encoding: 'utf8', timeout: 30000 })
    const [status, remote_ip, remote_port, connect, first_byte, total] = result.stdout.trim().split(' ')
    const transport = { exit_code: result.status, status: Number(status), remote_ip, remote_port,
      seconds: { connect: Number(connect), first_byte: Number(first_byte), total: Number(total) } }
    if (result.status !== 0) throw Object.assign(new Error('CLI egress request failed'), { transport })
    assert.equal(status, '200')
    assert((await fs.readFile(path.join(out, 'cli-body'), 'utf8')).includes('Example Domain'))
    assert.equal(remote_ip, new URL(env.SEC_EGRESS_PROXY).hostname)
    assert.equal(remote_port, new URL(env.SEC_EGRESS_PROXY).port)
    return transport
  })
  await check('actual-browser-scope-and-flow-proxy', async () => {
    assert(env.SEC_FLOW_PROXY, 'browser flow proxy missing')
    const data = path.join(out, 'data')
    await fs.mkdir(data, { recursive: true })
    await fs.writeFile(path.join(data, 'scope.yml'), 'version: 1\ndefaults:\n  allow_risk: [passive, active]\n  rate_limit_qps: 50\nprograms:\n  - name: upgrade-connectivity\n    scope:\n      - example.com\n')
    const plugin = path.join(base, 'data/profiles/web/node_modules/@silksec/dsh-browser')
    const { BrowserManager } = await import(pathToFileURL(path.join(plugin, 'lib/browser-manager.js')).href)
    const reservation = net.createServer()
    await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve))
    const port = reservation.address().port
    await new Promise(resolve => reservation.close(resolve))
    const hostSource = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dsh-shared-browser-host.mjs')
    host = spawn('/usr/local/node/bin/node', [hostSource], {
      env: { PATH: process.env.PATH, SEC_BASE_DIR: base, SEC_DATA_DIR: data, SEC_FLOW_PROXY: env.SEC_FLOW_PROXY,
        SEC_BROWSER_PROFILE: path.join(out, 'browser-profile'), SEC_BROWSER_BINARY: browserBin, CDP_PORT: String(port) },
      stdio: ['ignore', 'ignore', 'ignore'],
    })
    let ready = false
    for (let i = 0; i < 300; i++) {
      if (host.exitCode !== null) throw new Error('managed browser host exited')
      try { if ((await fetch('http://127.0.0.1:' + port + '/json/version')).ok) { ready = true; break } } catch {}
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert(ready, 'managed browser CDP did not become ready within 30 seconds')
    browser = new BrowserManager({ cdpUrl: 'http://127.0.0.1:' + port, navigationTimeoutMs: 45000 })
    let refused = false
    try { await browser.run('browser_open', { url: 'https://outside.invalid/' }, {}, async () => assert.fail('outside scope reached')) }
    catch (error) { refused = error.message.includes('E_SCOPE_BROWSER') }
    assert(refused, 'browser scope did not refuse outside target')
    await browser.launch()
    const observed = []
    browser.currentPage.on('requestfailed', request => observed.push({ origin: new URL(request.url()).origin, error: request.failure()?.errorText }))
    const title = await browser.run('browser_open', { url: target }, {}, async () => {
      const response = await (await browser.page()).goto(target, { waitUntil: 'domcontentloaded', timeout: 45000 })
      const body = await response.text()
      report.browser_response = { status: response.status(), bytes: Buffer.byteLength(body),
        sha256: createHash('sha256').update(body).digest('hex'),
        proxy_error_categories: [...new Set(body.match(/i\/o timeout|context deadline exceeded|connection refused|proxyconnect|no available proxies/gi) || [])] }
      return browser.currentPage.title()
    })
    assert.equal(title, 'Example Domain')
    return { title, mode: 'managed-shared-host', upstream: { host: new URL(env.SEC_FLOW_PROXY).hostname, port: new URL(env.SEC_FLOW_PROXY).port },
      outside_refused: refused, page_request_failures: observed, scope_file: path.join(data, 'scope.yml') }
  })
  report.ok = report.checks.every(row => row.ok)
} finally {
  await browser?.close()
  if (host && host.exitCode === null) {
    host.kill('SIGTERM')
    const timeout = setTimeout(() => host.kill('SIGKILL'), 10000)
    await new Promise(resolve => host.once('exit', resolve))
    clearTimeout(timeout)
  }
  await context?.fiber.dispose()
  await restore()
  report.finished_at = new Date().toISOString()
  await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
}
process.exitCode = report.ok ? 0 : 1
