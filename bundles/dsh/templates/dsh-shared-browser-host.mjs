// 受管共享浏览器：保留原 CDP 端口/持久 profile/SEC_FLOW_PROXY，先建立 Scope 出口。
import { createRequire } from 'node:module'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'

const base = process.env.SEC_BASE_DIR || '/opt/silkspool/dsh'
const require = createRequire(path.join(base, 'data/profiles/web/package.json'))
const { chromium } = require('playwright-core')
const { createScopePolicy, createScopeProxy, GUARD_ARGS } = await import(pathToFileURL(
  path.join(base, 'data/profiles/web/node_modules/@silksec/dsh-browser/lib/scope.js')).href)
const policy = await createScopePolicy({ baseDir: base })
const proxy = await createScopeProxy({ policy })
const profile = process.env.SEC_BROWSER_PROFILE || '/home/silkspool/日常/browser/.shared-browser-profile'
const port = Number(process.env.CDP_PORT || 9222)
fs.mkdirSync(profile, { recursive: true, mode: 0o700 })
// 使用完整 Chromium 的原生平台、UA/Client Hints、插件与图形 API。
// 无桌面服务器用独立 Xvfb（自动分配 display），各 profile 不争用显示号。
// 显式 SEC_BROWSER_HEADFUL=0 仅用于需要 headless 的隔离验收。
const HEADFUL = process.env.SEC_BROWSER_HEADFUL !== '0'
const locale = process.env.SEC_BROWSER_LOCALE || 'zh-CN'
let display, context, closing = false
async function shutdown() {
  if (closing) return
  closing = true
  await context?.close().catch(() => {})
  await proxy.close()
  display?.kill('SIGTERM')
}
async function displayEnv() {
  if (!HEADFUL || process.env.DISPLAY) return process.env
  display = spawn('Xvfb', ['-displayfd', '3', '-screen', '0', '1440x1000x24', '-nolisten', 'tcp'],
    { stdio: ['ignore', 'ignore', 'inherit', 'pipe'] })
  return new Promise((resolve, reject) => {
    let output = '', ready = false
    const timer = setTimeout(() => reject(new Error('Xvfb display startup timed out')), 10000)
    display.once('error', error => { clearTimeout(timer); reject(error) })
    display.once('exit', (code, signal) => {
      clearTimeout(timer)
      if (!ready) reject(new Error(`Xvfb exited before ready (${code ?? signal})`))
      else if (!closing) {
        process.exitCode = 1
        void shutdown()
      }
    })
    display.stdio[3].on('data', chunk => {
      output += chunk
      if (!output.includes('\n')) return
      clearTimeout(timer)
      if (!/^\d+\n$/.test(output)) return reject(new Error('Invalid Xvfb display number'))
      ready = true
      resolve({ ...process.env, DISPLAY: ':' + output.trim() })
    })
  })
}
try {
  context = await chromium.launchPersistentContext(profile, {
    headless: !HEADFUL,
    env: await displayEnv(),
    locale,
    timezoneId: process.env.SEC_BROWSER_TIMEZONE || 'Asia/Shanghai',
    viewport: null,
    // 只由下面的 shutdown 关闭一次。Playwright 默认信号处理器和
    // context.close 并发会强杀 Chromium，使 cookie 尚未刷新到持久 profile。
    handleSIGTERM: false, handleSIGINT: false, handleSIGHUP: false,
    ...(process.env.SEC_BROWSER_BINARY ? { executablePath: process.env.SEC_BROWSER_BINARY } : {}),
    proxy: { server: proxy.server, bypass: proxy.bypass },
    // 现役 xray 被动代理使用本地签发证书；证书信任迁移另行处理。
    args: [...GUARD_ARGS, '--no-sandbox', '--disable-dev-shm-usage', '--ignore-certificate-errors',
      '--lang=' + locale,
      '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + port,
      '--remote-allow-origins=*', '--window-size=1440,1000', '--restore-last-session', '--no-default-browser-check'],
  })
  if (!context.pages().length) await context.newPage()
  // 启动保持当前页面/空白页，不再自动请求未授权的 example.com。
  console.log('SHARED_BROWSER_READY cdp=127.0.0.1:' + port + ' scope=enabled mode=' + (HEADFUL ? 'headed' : 'headless'))
} catch (error) {
  display?.kill('SIGTERM')
  await proxy.close()
  throw error
}
process.on('SIGTERM', () => { void shutdown() })
process.on('SIGINT', () => { void shutdown() })
process.on('SIGHUP', () => { void shutdown() })
context.on('close', () => { void shutdown() })
