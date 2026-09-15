// 受管共享浏览器：保留原 CDP 端口/持久 profile/SEC_FLOW_PROXY，先建立 Scope 出口。
import { createRequire } from 'node:module'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'

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
let context
try {
  context = await chromium.launchPersistentContext(profile, {
    headless: true,
    // 只由下面的 shutdown 关闭一次。Playwright 默认信号处理器和
    // context.close 并发会强杀 Chromium，使 cookie 尚未刷新到持久 profile。
    handleSIGTERM: false, handleSIGINT: false, handleSIGHUP: false,
    ...(process.env.SEC_BROWSER_BINARY ? { executablePath: process.env.SEC_BROWSER_BINARY } : {}),
    proxy: { server: proxy.server, bypass: proxy.bypass },
    args: [...GUARD_ARGS, '--no-sandbox', '--disable-dev-shm-usage', '--ignore-certificate-errors',
      '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + port,
      '--remote-allow-origins=*', '--disable-gpu', '--no-first-run', '--no-default-browser-check'],
  })
  if (!context.pages().length) await context.newPage()
  // 启动保持当前页面/空白页，不再自动请求未授权的 example.com。
  console.log('SHARED_BROWSER_READY cdp=127.0.0.1:' + port + ' scope=enabled')
} catch (error) {
  await proxy.close()
  throw error
}
let closing = false
const shutdown = async () => {
  if (closing) return
  closing = true
  await context.close().catch(() => {})
  await proxy.close()
}
process.on('SIGTERM', () => { void shutdown() })
process.on('SIGINT', () => { void shutdown() })
process.on('SIGHUP', () => { void shutdown() })
context.on('close', () => { void shutdown() })
