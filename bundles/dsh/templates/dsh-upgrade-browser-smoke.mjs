// 通过真实 Caddy edge、密码门禁和 BrowserAuth 驱动 Chromium。仅供隔离验收。
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'

const out = '/tmp/dsh-rehearsal'
await fs.access(path.join(out, 'isolation.json'))
const config = JSON.parse(await fs.readFile(process.argv[2], 'utf8'))
const base = process.env.SEC_BASE_DIR
const require = createRequire(path.join(base, 'data/profiles/web/package.json'))
const { chromium } = require('playwright-core')
const report = { ok: false, checks: [], page_errors: [], rpc_failures: [], websocket: [], request_failures: [], prompts: [], selections: [] }
let browser, page
const streamFrames = []
const clean = value => String(value).replace(/token=[^\s&"']+/g, 'token=<redacted>')
try {
  browser = await chromium.launch({ executablePath: config.binary, headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--host-resolver-rules=MAP upgrade.test 127.0.0.1'] })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  page = await context.newPage()
  report.isolated_browser_network = { online_before: await page.evaluate(() => navigator.onLine) }
  // 无默认路由的 namespace 会让 Chromium 报 offline；只模拟 fixture 链路在线，仍无外网路由。
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'onLine', { get: () => true })
    const NativeWebSocket = WebSocket
    globalThis.__u2Sockets = []
    globalThis.WebSocket = class extends NativeWebSocket {
      constructor(...args) { super(...args); globalThis.__u2Sockets.push(this) }
    }
  })
  report.isolated_browser_network.fixture_online = true
  page.setDefaultTimeout(15000)
  page.on('pageerror', error => report.page_errors.push(clean(error.message)))
  page.on('console', message => {
    if (message.type() === 'error') {
      (report.console_errors ??= []).push(clean(message.text()))
    }
  })
  page.on('websocket', socket => {
    const record = { path: new URL(socket.url()).pathname, received: 0, sent: 0, errors: [] }
    report.websocket.push(record)
    socket.on('framereceived', frame => {
      record.received++
      try {
        const data = JSON.parse(String(frame.payload))
        streamFrames.push({ direction: 'received', data })
        if (data.error) record.errors.push({ type: data.type, error: clean(JSON.stringify(data.error)) })
      } catch { /* 非 JSON 帧不记录正文 */ }
    })
    socket.on('framesent', frame => {
      record.sent++
      try { streamFrames.push({ direction: 'sent', data: JSON.parse(String(frame.payload)) }) } catch {}
    })
    socket.on('socketerror', error => record.errors.push(clean(error)))
  })
  page.on('requestfailed', request => report.request_failures.push({ path: new URL(request.url()).pathname, error: clean(request.failure()?.errorText) }))
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/session/prompt') {
      const payload = request.postDataJSON()
      report.prompts.push({ sessionId: payload?.payload?.args?.request?.sessionId })
    }
  })
  page.on('response', async response => {
    if (!response.url().includes('/silksec-dashboard/')) return
    try {
      const value = await response.json()
      if (response.status() !== 200 || !value.result?.ok) {
        report.rpc_failures.push({ path: new URL(response.url()).pathname, status: response.status(), error: value.result?.error?.code })
      }
    } catch { report.rpc_failures.push({ path: new URL(response.url()).pathname, status: response.status() }) }
  })
  await page.goto(config.url + '/auth/login')
  await page.locator('input[name="username"]').fill(config.username)
  await page.locator('input[name="password"]').fill(config.password)
  await Promise.all([page.waitForNavigation(), page.locator('button[type="submit"]').click()])
  await page.goto(config.launchUrl)
  await page.getByTitle('安全看板', { exact: true }).waitFor()
  await page.getByRole('button', { name: /^(Continue|继续)$/ }).click()
  report.checks.push({ check: 'edge-password-browserauth-app', ok: true })
  await page.waitForFunction(() => getComputedStyle(document.body).getPropertyValue('--dsw-alias-bg-base').trim().toLowerCase() === '#161d22')
  const background = await page.evaluate(() => getComputedStyle(document.body).getPropertyValue('--dsw-alias-bg-base').trim())
  if (background.toLowerCase() !== '#161d22') throw new Error('丝之歌主题未实际生效：' + background)
  report.checks.push({ check: 'silksong-theme', ok: true })
  await page.getByTitle('安全看板', { exact: true }).click()
  for (const title of ['漏洞', '资产', '接口', '事实', '任务', '知识', '报告', '审批', '授权', '审计']) {
    const tab = page.locator('button.silksec-tab').filter({ hasText: new RegExp('^' + title + '(?:$| ·)') })
    await tab.click()
    await page.waitForFunction(text => [...document.querySelectorAll('button.silksec-tab')]
      .some(button => button.textContent.startsWith(text) && button.dataset.on === 'true'), title)
    // 每个视图会异步取数；等待首轮稳定后检查实际错误和骨架。
    await page.waitForTimeout(400)
    const body = await page.locator('.silksec-dash-dialog').last().innerText()
    if (/RPC.*失败|加载失败|HTTP 40[0-9]|HTTP 50[0-9]/.test(body)) throw new Error('看板视图加载失败：' + title)
    report.checks.push({ check: 'dashboard-' + title, ok: true })
  }
  if (report.rpc_failures.length) throw new Error('看板 RPC 存在失败')
  if (report.page_errors.length) throw new Error('浏览器有运行异常')
  await page.screenshot({ path: path.join(out, 'dashboard.png'), fullPage: true })
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: /^(设置|Settings)$/ }).click()
  await page.getByRole('button', { name: /^(模型|Models)$/ }).click()
  await page.getByRole('button', { name: /^(编辑|Edit) upgrade-fixture$/ }).waitFor()
  report.checks.push({ check: 'settings-provider-directory', ok: true })
  await page.getByRole('button', { name: /^(通用设置|General)$/ }).click()
  const changed = page.waitForResponse(response => /^\/api\/settings\/(update|mutate)$/.test(new URL(response.url()).pathname))
  await page.getByRole('button', { name: /^(增大字号|Increase font size)$/ }).click()
  const saved = await (await changed).json()
  if (!saved.result?.ok) throw new Error('字号设置保存失败')
  await page.reload()
  await page.getByTitle('安全看板', { exact: true }).waitFor()
  await page.waitForFunction(() => getComputedStyle(document.body).getPropertyValue('--dsh-content-font-size').trim() === '15px')
  await page.waitForFunction(() => getComputedStyle(document.body).getPropertyValue('--dsw-alias-bg-base').trim().toLowerCase() === '#161d22')
  report.checks.push({ check: 'settings-save-reload', ok: true })
  await page.getByRole('button', { name: /^(设置|Settings)$/ }).click()
  await page.getByRole('button', { name: /^(通用设置|General)$/ }).click()
  const themeSaved = page.waitForResponse(response => /^\/api\/settings\/(update|mutate)$/.test(new URL(response.url()).pathname))
  await page.getByRole('button', { name: /^(Light|浅色)$/ }).click()
  if (!(await (await themeSaved).json()).result?.ok) throw new Error('内置主题保存失败')
  await page.waitForFunction(() => !document.body.hasAttribute('data-ds-dark-theme') && localStorage.getItem('silksec.theme.choice') === 'host')
  await page.reload()
  await page.getByTitle('安全看板', { exact: true }).waitFor()
  await page.waitForFunction(() => !document.body.hasAttribute('data-ds-dark-theme') && localStorage.getItem('silksec.theme.choice') === 'host')
  await page.getByRole('button', { name: /^(设置|Settings)$/ }).click()
  await page.getByRole('button', { name: /^(通用设置|General)$/ }).click()
  await page.getByRole('button', { name: '已关闭', exact: true }).click()
  await page.reload()
  await page.getByTitle('安全看板', { exact: true }).waitFor()
  await page.waitForFunction(() => getComputedStyle(document.body).getPropertyValue('--dsw-alias-bg-base').trim().toLowerCase() === '#161d22')
  report.checks.push({ check: 'explicit-theme-switch-and-reload', ok: true })
  const newSession = async () => {
    await page.locator('[role="treeitem"][aria-selected="true"]').first().waitFor()
    const previous = await page.evaluate(() => JSON.parse(localStorage.getItem('dsh.sessions.current') || '{}').sessionId)
    const reusable = await page.locator('[role="treeitem"][aria-selected="true"]').getByText(/^(New Session|New session|新会话)$/).count() > 0
    await page.getByText('日常', { exact: true }).first().hover()
    await page.getByRole('button', { name: /^(New session in 日常|在 日常 中新建会话)$/ }).click()
    // 原生控制器会复用已有空会话；等待选择完成，避免在异步建会话期间误发到上一条。
    await page.waitForFunction(({ id, reusable }) => {
      const selected = JSON.parse(localStorage.getItem('dsh.sessions.current') || '{}').sessionId
      return selected && (reusable || selected !== id)
    }, { id: previous, reusable })
    const selected = await page.evaluate(() => JSON.parse(localStorage.getItem('dsh.sessions.current') || '{}').sessionId)
    // 持久选择先于 React 会话绑定更新；空白 hero 也可能仍属于旧会话。
    // 必须等到新选择的真实 follow 快照，再允许输入。
    let followed = false
    for (let i = 0; i < 150; i++) {
      followed = streamFrames.some(frame => frame.direction === 'received'
        && frame.data.value?.type === 'snapshot' && frame.data.value.header?.id === selected)
      if (followed) break
      await page.waitForTimeout(100)
    }
    if (!followed) throw new Error('新选择的 Session 尚未完成真实流绑定')
    await page.locator('[role="treeitem"][aria-selected="true"]').getByText(/^(New Session|New session|新会话)$/).waitFor()
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    await page.getByText('Into the Unknown', { exact: true }).waitFor()
    report.selections.push({ previous, selected })
  }
  await newSession()
  const composer = page.locator('[data-composer-input][contenteditable="true"]')
  await composer.fill('[u2:stream-tool] Reply U2_FIXTURE_OK using the isolated tool fixture.')
  await page.getByRole('button', { name: /^(Send message|发送消息)$/ }).click()
  const answer = () => page.locator('[data-conversation-scroll]').getByText('U2_FIXTURE_OK', { exact: true })
  await answer().first().waitFor()
  if (!report.websocket.some(socket => socket.received > 2 && socket.sent > 2 && !socket.errors.length)) {
    throw new Error('会话未通过真实 WebSocket 流收取工具与回答')
  }
  report.checks.push({ check: 'websocket-streamed-tool-conversation', ok: true })
  report.selection_before_reload = await page.evaluate(() => localStorage.getItem('dsh.sessions.current'))
  await page.reload()
  await answer().first().waitFor()
  if (await page.evaluate(() => localStorage.getItem('dsh.sessions.current')) !== report.selection_before_reload) throw new Error('刷新后没有恢复原 Session')
  report.checks.push({ check: 'session-reload-history', ok: true })
  const socketsBefore = report.websocket.length
  await page.evaluate(() => { for (const socket of globalThis.__u2Sockets) socket.close(4001, 'isolated reconnect fixture') })
  for (let i = 0; i < 100 && !report.websocket.slice(socketsBefore).some(socket => socket.received > 2); i++) await page.waitForTimeout(100)
  if (!report.websocket.slice(socketsBefore).some(socket => socket.received > 2)) throw new Error('连接中断后没有重建会话订阅')
  await composer.fill('[u2:stream-tool] Continue this isolated Session after reconnect.')
  await page.getByRole('button', { name: /^(Send message|发送消息)$/ }).click()
  await answer().nth(1).waitFor()
  report.checks.push({ check: 'websocket-reconnect-and-continue-session', ok: true })
  await newSession()
  await composer.fill('[u2:deliver-file] Write and present the isolated preview fixture.')
  await page.getByRole('button', { name: /^(Send message|发送消息)$/ }).click()
  await answer().first().waitFor()
  const preview = () => page.getByRole('button', { name: new RegExp('^(Preview ' + config.previewName.replaceAll('.', '\\.') + ' in sidebar|在侧边栏预览 ' + config.previewName.replaceAll('.', '\\.') + ')$') })
  await preview().click()
  await page.getByText('U2_PREVIEW_CONTENT', { exact: true }).last().waitFor()
  await page.locator('[data-turn-tail="1"] [data-silksec-turn-cost="1"]').waitFor()
  report.checks.push({ check: 'delivered-file-card-and-preview', ok: true })
  report.checks.push({ check: 'billing-and-delivered-file-coexist', ok: true })
  await page.reload()
  await page.locator('[data-turn-tail="1"] [data-silksec-turn-cost="1"]').waitFor()
  await preview().click()
  await page.getByText('U2_PREVIEW_CONTENT', { exact: true }).last().waitFor()
  const sid = report.selections.at(-1).selected
  const costs = streamFrames.map(frame => frame.data.value).filter(value => value?.type === 'projection' && value.sessionId === sid && value.key === 'billTurns')
  const cost = costs.at(-1)?.value
  if (!cost || cost.calls !== 3 || cost.inputTokens !== 48 || cost.outputTokens !== 12 || Math.abs(cost.totalUsd - 0.000096) > 1e-9) {
    throw new Error('真实计费投影的调用数、token 或费用归因不符')
  }
  report.billing_fixture = { calls: cost.calls, inputTokens: cost.inputTokens, outputTokens: cost.outputTokens, usd: cost.totalUsd }
  report.checks.push({ check: 'billing-and-file-reload-attribution', ok: true })
  await page.screenshot({ path: path.join(out, 'file-preview.png'), fullPage: true })
  if (report.page_errors.length) throw new Error('浏览器有运行异常')
  report.ok = true
} catch (error) {
  report.error = { type: error.name, message: clean(error.message) }
  if (page) {
    report.selection_after_reload = await page.evaluate(() => localStorage.getItem('dsh.sessions.current')).catch(() => null)
    await fs.writeFile(path.join(out, 'browser-failure.html'), await page.content().catch(() => ''))
    await page.screenshot({ path: path.join(out, 'browser-failure.png'), fullPage: true }).catch(() => {})
  }
} finally {
  if (browser) await browser.close()
  await fs.writeFile(path.join(out, 'browser-stream-private.json'), JSON.stringify(streamFrames, null, 2) + '\n', { mode: 0o600 })
  await fs.writeFile(path.join(out, 'browser-report.json'), JSON.stringify(report, null, 2) + '\n')
}
console.log(JSON.stringify(report))
if (!report.ok) process.exitCode = 1
