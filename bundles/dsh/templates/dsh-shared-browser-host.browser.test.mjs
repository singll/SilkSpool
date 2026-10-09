// Real host integration: native browser APIs, Scope and persistent profile restart.
// PLAYWRIGHT_MODULE points at an installed playwright-core/index.mjs.
import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import * as http from 'node:http'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath, pathToFileURL } from 'node:url'

const templates = path.dirname(fileURLToPath(import.meta.url))
test('shared host defaults to headless and preserves rendering, Scope and profile across restart', { timeout: 90000 }, async t => {
  assert.ok(process.env.PLAYWRIGHT_MODULE, 'set PLAYWRIGHT_MODULE')
  const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE))
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'sec-native-browser-'))
  t.after(() => fs.rm(base, { recursive: true, force: true }))
  const modules = path.join(base, 'data/profiles/web/node_modules')
  await fs.mkdir(path.join(modules, '@silksec/dsh-browser/lib'), { recursive: true })
  await fs.writeFile(path.join(base, 'data/profiles/web/package.json'), '{"type":"module"}')
  await fs.symlink(path.dirname(process.env.PLAYWRIGHT_MODULE), path.join(modules, 'playwright-core'), 'dir')
  await fs.copyFile(path.join(templates, 'dsh-browser-scope.js'), path.join(modules, '@silksec/dsh-browser/lib/scope.js'))
  for (const name of ['sec-domain-scope', 'sec-backend-scope-file', 'sec-backend-scope-sqlite']) {
    await fs.mkdir(path.join(base, 'plugins', name), { recursive: true })
    await fs.copyFile(path.join(templates, `dsh-plugin-${name}.js`), path.join(base, 'plugins', name, 'index.js'))
  }
  await fs.writeFile(path.join(base, 'data/scope.yml'), 'version: 1\nprograms:\n  - name: fixture\n    scope:\n      - "127.0.0.1/32"\n')
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<title>Native browser fixture</title>')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise(resolve => server.close(resolve)))
  const origin = `http://127.0.0.1:${server.address().port}`
  const reservation = http.createServer().listen(0, '127.0.0.1')
  await once(reservation, 'listening')
  const port = reservation.address().port
  await new Promise(resolve => reservation.close(resolve))
  let child, browser
  t.after(async () => {
    await browser?.close().catch(() => {})
    if (child && child.exitCode === null) {
      const exit = once(child, 'exit')
      child.kill('SIGTERM')
      await exit
    }
  })
  const launch = async () => {
    const env = { ...process.env, SEC_BASE_DIR: base, SEC_FLOW_PROXY: '',
      SEC_BROWSER_PROFILE: path.join(base, 'profile'), CDP_PORT: String(port),
      SEC_BROWSER_LOCALE: 'zh-CN', SEC_BROWSER_TIMEZONE: 'Asia/Shanghai' }
    delete env.DISPLAY
    delete env.SEC_BROWSER_HEADFUL // Production default must not require a display.
    child = spawn(process.execPath, [path.join(templates, 'dsh-shared-browser-host.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = '', errors = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { errors += chunk })
    for (let i = 0; i < 300 && !output.includes('SHARED_BROWSER_READY'); i++) {
      assert.equal(child.exitCode, null, errors)
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.match(output, /mode=headless/, errors)
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
    return browser.contexts()[0]
  }
  const context = await launch(), page = context.pages()[0]
  const cdp = await browser.newBrowserCDPSession()
  const { arguments: args } = await cdp.send('Browser.getBrowserCommandLine')
  assert.ok(args.includes('--enable-automation'), 'guard introspection remains available')
  assert.ok(args.some(arg => arg.startsWith('--headless')))
  assert.ok(!args.includes('--disable-blink-features=AutomationControlled'))
  await page.goto(origin)
  const observed = await page.evaluate(async () => {
    const hints = await navigator.userAgentData.getHighEntropyValues(['platformVersion', 'fullVersionList'])
    const frame = document.createElement('iframe')
    document.body.append(frame)
    return {
      ua: navigator.userAgent, platform: navigator.platform, hints,
      plugins: navigator.plugins instanceof PluginArray,
      mimeTypes: navigator.mimeTypes instanceof MimeTypeArray,
      webdriver: navigator.webdriver,
      ownOverrides: ['webdriver', 'platform', 'plugins', 'mimeTypes', 'userAgentData'].filter(key => Object.hasOwn(navigator, key)),
      language: navigator.language, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      framePlatform: frame.contentWindow.navigator.platform,
      width: innerWidth, height: innerHeight,
    }
  })
  assert.match(observed.ua, /X11; Linux x86_64/)
  assert.doesNotMatch(observed.ua, /Windows/)
  assert.equal(observed.hints.platform, 'Linux')
  assert.equal(observed.platform, observed.framePlatform)
  assert.ok(observed.plugins && observed.mimeTypes)
  assert.equal(observed.webdriver, true)
  assert.deepEqual(observed.ownOverrides, [])
  assert.equal(observed.language, 'zh-CN')
  assert.equal(observed.timezone, 'Asia/Shanghai')
  assert.ok(observed.width > 1000 && observed.height > 700)
  await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 100; canvas.height = 100
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#ff0000'; ctx.fillRect(0, 0, 100, 100)
    document.body.append(canvas)
    const button = document.createElement('button')
    button.textContent = 'Open fixture'
    button.onclick = () => { document.title = 'Fixture opened' }
    document.body.append(button)
  })
  await page.getByRole('button', { name: 'Open fixture' }).click({ timeout: 5000 })
  assert.equal(await page.title(), 'Fixture opened')
  assert.ok((await page.screenshot({ timeout: 5000 })).length > 100)
  await context.addCookies([{ name: 'fixture', value: 'persistent', url: origin, expires: Math.floor(Date.now() / 1000) + 3600 }])
  await assert.rejects(page.goto('https://outside.invalid/', { timeout: 5000 }), /ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY/)
  await browser.close()
  browser = null
  const exited = once(child, 'exit')
  child.kill('SIGTERM')
  assert.equal((await exited)[0], 0)
  const restored = await launch()
  assert.equal((await restored.cookies(origin)).find(cookie => cookie.name === 'fixture')?.value, 'persistent')
  const restoredPage = restored.pages()[0]
  await restoredPage.goto(origin)
  assert.equal(await restoredPage.title(), 'Native browser fixture')
  assert.ok((await restoredPage.screenshot({ timeout: 5000 })).length > 100)
})
