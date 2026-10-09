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
// 反自动化指纹：headless-shell 默认 UA=HeadlessChrome、navigator.webdriver=true、
// plugins=0、window.chrome 缺失、WebGL=SwiftShader，会被字节风控判为自动化（passport
// error_code 7「系统繁忙」）。这里统一伪装成普通 Windows Chrome 桌面环境。
const HEADFUL = process.env.SEC_BROWSER_HEADFUL === '1'
const UA = process.env.SEC_BROWSER_UA ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.7922.34 Safari/537.36'
const MASK_SCRIPT = `(() => {
  try {
    const def = (o, p, v) => { try { Object.defineProperty(o, p, { get: () => v, configurable: true }) } catch {} };
    def(navigator, 'webdriver', undefined);
    def(navigator, 'platform', 'Win32');
    def(navigator, 'languages', ['zh-CN', 'zh', 'en']);
    def(navigator, 'plugins', [1, 2, 3, 4, 5]);
    def(navigator, 'mimeTypes', [1, 2]);
    if (!window.chrome) window.chrome = { runtime: {}, app: { isInstalled: false }, csi: () => {}, loadTimes: () => {} };
    const GPU_VENDOR = 'Google Inc. (Intel)';
    const GPU_RENDERER = 'ANGLE (Intel, Intel(R) UHD Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)';
    const patch = (Ctor) => { if (!Ctor) return; const gp = Ctor.prototype.getParameter;
      Ctor.prototype.getParameter = function (p) { if (p === 37445) return GPU_VENDOR; if (p === 37446) return GPU_RENDERER; return gp.call(this, p) }; };
    patch(window.WebGLRenderingContext); patch(window.WebGL2RenderingContext);
    if (navigator.userAgentData) def(navigator, 'userAgentData', { brands: [{ brand: 'Not/A)Brand', version: '24' }, { brand: 'Chromium', version: '151' }, { brand: 'Google Chrome', version: '151' }], mobile: false, platform: 'Windows' });
  } catch {}
})()`
let context
try {
  context = await chromium.launchPersistentContext(profile, {
    headless: !HEADFUL,
    userAgent: UA,
    locale: process.env.SEC_BROWSER_LOCALE || 'zh-CN',
    ignoreDefaultArgs: ['--enable-automation'],
    // 只由下面的 shutdown 关闭一次。Playwright 默认信号处理器和
    // context.close 并发会强杀 Chromium，使 cookie 尚未刷新到持久 profile。
    handleSIGTERM: false, handleSIGINT: false, handleSIGHUP: false,
    ...(process.env.SEC_BROWSER_BINARY ? { executablePath: process.env.SEC_BROWSER_BINARY } : {}),
    proxy: { server: proxy.server, bypass: proxy.bypass },
    args: [...GUARD_ARGS, '--no-sandbox', '--disable-dev-shm-usage', '--ignore-certificate-errors',
      '--disable-blink-features=AutomationControlled', '--lang=zh-CN',
      '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + port,
      '--remote-allow-origins=*', '--disable-gpu', '--no-first-run', '--no-default-browser-check'],
  })
  await context.addInitScript(MASK_SCRIPT)
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
