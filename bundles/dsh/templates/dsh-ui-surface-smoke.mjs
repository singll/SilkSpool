// ==============================================================================
// dsh-ui-surface-smoke.mjs — 看板 UI 原生面「真机无头」运行时冒烟（16-dashboard §2.6 ②③④）
//
// 由 dsh-ui-surface-smoke.py 以「临时维护账号同进程还原 users.yaml」的既有 headless
// 通道调用；本脚本自身只读业务数据（写抽样经浏览器路由 stub，绝不落库）。
//
// 输出协议（供 sec-v5-accept.sh 逐行消费）：
//   UI_CHECK|0/1|<name>|<detail>    每项断言
//   UI_SMOKE_OK|<count>             全部通过时的收尾行
// 退出码：0 = 全绿；1 = 有失败项。
// ==============================================================================
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'

const BASE = process.env.SEC_UI_BASE || 'http://127.0.0.1:3081'
const PROFILE = process.env.SEC_UI_PROFILE || '/opt/silkspool/dsh/data/profiles/web/package.json'
const cookiesPath = process.argv[2]
const chromeArg = process.argv[3]

// 面清单与 16-dashboard §1.4/§5.1、deps 清单一一对应（P7 收尾后旧 sec-dashboard 不再是必需面）。
const UI_PACKAGES = [
  { id: 'ui-core', surface: 'ui-core' },
  { id: 'ui-panel', surface: 'ui-panel' },
  { id: 'ui-approval', surface: 'ui-approval' },
  { id: 'ui-task', surface: 'ui-task' },
  { id: 'ui-settings-scope', surface: 'ui-settings-scope' },
  { id: 'ui-session', surface: 'ui-session' },
  { id: 'sec-dashboard-view-vuln', surface: 'sec-dashboard-view-vuln' },
  { id: 'sec-dashboard-view-asset', surface: 'sec-dashboard-view-asset' },
  { id: 'sec-dashboard-view-endpoint', surface: 'sec-dashboard-view-endpoint' },
  { id: 'sec-dashboard-view-fact', surface: 'sec-dashboard-view-fact' },
  { id: 'sec-dashboard-view-know', surface: 'sec-dashboard-view-know' },
  { id: 'sec-dashboard-view-report', surface: 'sec-dashboard-view-report' },
  { id: 'sec-dashboard-view-audit', surface: 'sec-dashboard-view-audit' },
]

function findChrome() {
  if (chromeArg && fs.existsSync(chromeArg)) return chromeArg
  const roots = [path.join(os.homedir(), '.cache/ms-playwright'), '/home/silkspool/.cache/ms-playwright']
  for (const root of roots) {
    if (!fs.existsSync(root)) continue
    const dirs = fs.readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort()
    for (const d of dirs.reverse()) {
      const bin = path.join(root, d, 'chrome-linux64/chrome')
      if (fs.existsSync(bin)) return bin
    }
  }
  throw new Error('未找到 chromium（ms-playwright）')
}

const clean = (s) => String(s).replace(/token=[^\s&"']+/g, 'token=<redacted>')
const checks = []
function check(name, ok, detail) {
  checks.push({ name, ok: !!ok, detail: detail === undefined ? null : String(detail).replace(/\s+/g, ' ').replace(/["\\]/g, "'") })
}

const require = createRequire(PROFILE)
const { chromium } = require('playwright-core')
const cookies = JSON.parse(fs.readFileSync(cookiesPath, 'utf8'))
const report = { pageErrors: [], consoleErrors: [], bundles: [] }
let browser, page

try {
  browser = await chromium.launch({ executablePath: findChrome(), headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } })
  await context.addCookies(cookies)
  page = await context.newPage()
  page.setDefaultTimeout(20000)
  page.on('pageerror', (e) => report.pageErrors.push(clean(e.message)))
  page.on('console', (m) => { if (m.type() === 'error') report.consoleErrors.push(clean(m.text())) })
  page.on('response', (res) => { const u = res.url(); if (u.includes('/plugins/')) report.bundles.push({ url: u, status: res.status() }) })

  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)
  for (const name of [/^(Continue|继续|继续使用)$/i]) {
    const b = page.getByRole('button', { name }).first()
    if (await b.count() && await b.isVisible().catch(() => false)) await b.click().catch(() => {})
  }
  await page.waitForFunction(() => !!window.__silksecSurfaceHealth, null, { timeout: 30000 })

  // ② 组合树资源：所有 /plugins/ 资源 200，且 combo bundle URL 含每个 UI 包 client 路径
  const bad = report.bundles.filter((b) => b.status !== 200)
  const combo = report.bundles.map((b) => b.url).join(' ')
  const missingBundles = UI_PACKAGES.filter((p) => combo.indexOf('silksec/' + p.id + '/client.js') < 0 && combo.indexOf('silksec%2F' + p.id + '%2Fclient.js') < 0)
  check('ui-bundle-all-200', bad.length === 0 && report.bundles.length > 0, bad.length === 0 ? (report.bundles.length + ' 个 /plugins/ 资源全 200') : JSON.stringify(bad.slice(0, 3)))
  check('ui-bundle-contains-packages', missingBundles.length === 0, missingBundles.length === 0 ? ('13 包均在 combo bundle') : ('缺: ' + missingBundles.map((p) => p.id).join(',')))

  // ③ window.__silksecSurfaceHealth：每个面存在且状态 ∈ {ok, degraded}
  const health = await page.evaluate(() => window.__silksecSurfaceHealth || {})
  for (const p of UI_PACKAGES) {
    const rec = health[p.surface]
    const status = rec && rec.status
    check('ui-health-' + p.surface, !!rec && (status === 'ok' || status === 'degraded'), rec ? status : 'missing')
  }

  // ④ 每面 1 读 1 写 RPC 往返抽样：读走真实端点（只读），写经浏览器路由 stub（不落库）
  const call = async (endpoint, payload) => {
    return page.evaluate(({ endpoint, payload }) => fetch('/silksec-dashboard/' + endpoint, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'ui-smoke-' + endpoint, method: endpoint, payload }),
    }).then((r) => r.json()).then((j) => (j && j.result) || j), { endpoint, payload })
  }
  // 每面的代表读端点（全部只读；与各面客户端实际消费的端点一致）
  const READ_ENDPOINTS = {
    'ui-core': ['stats', {}],
    'ui-panel': ['stats', {}],
    'ui-approval': ['approvalList', {}],
    'ui-task': ['scheduledTasks', {}],
    'ui-settings-scope': ['scopeList', {}],
    'ui-session': ['findings', {}],
    'sec-dashboard-view-vuln': ['findings', {}],
    'sec-dashboard-view-asset': ['assets', {}],
    'sec-dashboard-view-endpoint': ['endpoints', {}],
    'sec-dashboard-view-fact': ['facts', { limit: 20, sort: 'updated_at' }],
    'sec-dashboard-view-know': ['expCards', {}],
    'sec-dashboard-view-report': ['reports', {}],
    'sec-dashboard-view-audit': ['audit', {}],
  }
  for (const p of UI_PACKAGES) {
    const [ep, payload] = READ_ENDPOINTS[p.surface]
    const res = await call(ep, payload).catch((e) => ({ ok: false, error: { message: clean(e.message) } }))
    check('ui-rpc-read-' + p.surface, !!res && res.ok === true, ep + ' => ' + (res && res.ok ? 'ok' : JSON.stringify(res).slice(0, 160)))
  }

  // 写抽样经浏览器路由 stub（绝不落库）：覆盖一个代表性写端点
  await page.route('**/silksec-dashboard/taskRunNow', async (route) => {
    let rpcId = null
    try { rpcId = route.request().postDataJSON().rpcId } catch { /* ignore */ }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ type: 'server-response', rpcId, result: { ok: true, value: { ok: true, stubbed: true } } }) })
  })
  const writeProbe = await call('taskRunNow', { id: 'ui-smoke-stub' }).catch((e) => ({ ok: false, error: { message: clean(e.message) } }))
  check('ui-rpc-write-stubbed', !!writeProbe && writeProbe.ok === true && writeProbe.value && writeProbe.value.stubbed === true, JSON.stringify(writeProbe).slice(0, 200))

  check('ui-no-page-errors', report.pageErrors.length === 0, report.pageErrors.slice(0, 3).join(' | '))
  check('ui-no-console-errors', report.consoleErrors.length === 0, report.consoleErrors.slice(0, 3).join(' | '))
} catch (error) {
  check('ui-smoke-harness', false, clean(error && error.message ? error.message : error))
} finally {
  if (browser) await browser.close().catch(() => {})
}

for (const c of checks) console.log('UI_CHECK|' + (c.ok ? '0' : '1') + '|' + c.name + '|' + (c.detail === null ? '' : c.detail))
const failed = checks.filter((c) => !c.ok)
if (failed.length === 0) console.log('UI_SMOKE_OK|' + checks.length)
process.exitCode = failed.length === 0 ? 0 : 1
