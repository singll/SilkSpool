// 通过真实 Caddy edge、密码门禁和 BrowserAuth 驱动 Chromium。仅供隔离验收。
import { createHash } from 'node:crypto'
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
let noticeKiller = null
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
  page.setDefaultTimeout(60000)
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
    if (response.status() !== 200) {
      report.rpc_failures.push({ path: new URL(response.url()).pathname, status: response.status() })
      return
    }
    try {
      const value = await response.json()
      if (!value.result?.ok) report.rpc_failures.push({ path: new URL(response.url()).pathname, status: 200, error: value.result?.error?.code })
    } catch { /* 流式/非 JSON 响应由页面视图断言兜底，这里不按失败记 */ }
  })
  // 0.1.7 侧边栏入口标题为「安全中心」（0.1.5 为「安全看板」）；首启还有测试期免责声明弹窗。
  const dashboardEntry = () => page.getByLabel(/^(安全看板|安全中心)$/)
  await page.goto(config.url + '/auth/login')
  await page.locator('input[name="username"]').fill(config.username)
  await page.locator('input[name="password"]').fill(config.password)
  await Promise.all([page.waitForNavigation(), page.locator('button[type="submit"]').click()])
  await page.goto(config.launchUrl)
  // 应用首屏可能晚于 load（会话枚举慢）；先等侧边栏入口渲染（弹窗遮挡不影响可见性判定）。
  await dashboardEntry().waitFor({ timeout: 120000 })
  // 0.1.7 首启免责声明弹窗异步出现且会拦截点击；在预算内循环关闭直到不再出现。
  const dismissNotice = async (budgetMs = 25000) => {
    const deadline = Date.now() + budgetMs
    const noticeTitle = () => page.getByText(/Internal Testing Notice/)
    const notice = () => page.getByRole('button', { name: /^(Continue|继续)$/ })
    while (Date.now() < deadline) {
      // 只在免责声明弹窗标题在页面上时才点 Continue，避免误点设置/引导流程里的同名按钮。
      if (await noticeTitle().count() === 0) {
        await page.waitForTimeout(300)
        if (await noticeTitle().count() === 0) return true
        continue
      }
      await notice().first().click({ timeout: 5000 }).catch(() => {})
      await page.waitForTimeout(500)
    }
    return false
  }
  await dismissNotice()
  // 免责声明弹窗会在会话中异步反复出现（fixture 环境的 ui-settings-general 确认未生效）；
  // 后台定时清除，避免瞬时遮挡导致点击被拦截。
  noticeKiller = setInterval(() => { dismissNotice(1500).catch(() => {}) }, 2000)
  report.checks.push({ check: 'edge-password-browserauth-app', ok: true })
  await page.waitForFunction(() => getComputedStyle(document.body).getPropertyValue('--dsw-alias-bg-base').trim().toLowerCase() === '#161d22')
  const background = await page.evaluate(() => getComputedStyle(document.body).getPropertyValue('--dsw-alias-bg-base').trim())
  if (background.toLowerCase() !== '#161d22') throw new Error('丝之歌主题未实际生效：' + background)
  report.checks.push({ check: 'silksong-theme', ok: true })
  await dashboardEntry().click()
  // 19-ui-unify 后主面板 tab：任务/审批迁出到右侧栏，授权在设置页；此处为 8 个浏览型 tab。
  for (const title of ['漏洞', '资产', '接口', '事实', '知识', '学习', '报告', '审计']) {
    const tab = page.locator('button.silksec-tab').filter({ hasText: new RegExp('^' + title + '(?:$| ·)') })
    await tab.click()
    await page.waitForFunction(text => [...document.querySelectorAll('button.silksec-tab')]
      .some(button => button.textContent.startsWith(text) && button.dataset.on === 'true'), title)
    // 每个视图会异步取数；等待首轮稳定后检查实际错误和骨架。
    await page.waitForTimeout(400)
    const body = await page.locator('body').innerText()
    if (/RPC.*失败|加载失败|HTTP 40[0-9]|HTTP 50[0-9]/.test(body)) throw new Error('看板视图加载失败：' + title)
    report.checks.push({ check: 'dashboard-' + title, ok: true })
  }
  // 既存缺陷（0.1.5 生产同代码同现象，非本次升级回归）：dashboard-rpc kbList 传 q，
  // 而 know.kb_list 的 schema 为 additionalProperties=false → E_SCHEMA 被映射为 internal。
  // 仅对该端点/该错误放行，其余任何 RPC 失败仍判失败。
  const unexpectedRpcFailures = report.rpc_failures.filter(row => !(row.path === '/silksec-dashboard/kbList' && row.error === 'internal'))
  report.known_preexisting_rpc_failures = report.rpc_failures.filter(row => row.path === '/silksec-dashboard/kbList' && row.error === 'internal')
  if (unexpectedRpcFailures.length) throw new Error('看板 RPC 存在失败：' + JSON.stringify(unexpectedRpcFailures))
  if (report.page_errors.length) throw new Error('浏览器有运行异常')
  await page.screenshot({ path: path.join(out, 'dashboard.png'), fullPage: true })
  await page.keyboard.press('Escape')
  // 0.1.7 看板是原生主面板（非弹窗），Escape 不关闭；点主面板「返回当前会话」退出后再开设置。
  await page.getByRole('button', { name: /^返回当前会话$/ }).click({ timeout: 10000 }).catch(() => {})
  // 设置入口点击可能被面板退场动画吞掉：以「模型」导航出现作为设置对话框已打开的判据并重试。
  const settingsButton = page.getByRole('button', { name: /^(设置|Settings)$/ })
  const modelsTab = page.getByRole('button', { name: /^(模型|Models)$/ })
  for (let attempt = 0; attempt < 4; attempt++) {
    await settingsButton.click({ timeout: 15000 }).catch(() => {})
    try { await modelsTab.waitFor({ timeout: 8000 }); break } catch { await page.waitForTimeout(1000) }
  }
  await modelsTab.click()
  await page.waitForTimeout(3000)
  await page.screenshot({ path: path.join(out, 'models-page.png'), fullPage: true })
  await fs.writeFile(path.join(out, 'models-page.html'), await page.content())
  await page.getByRole('button', { name: /^(编辑|Edit) upgrade-fixture$/ }).waitFor({ timeout: 60000 })
  report.checks.push({ check: 'settings-provider-directory', ok: true })
  // 模型页 UI 保存 → profile patch 持久化：改显示名后 patch 字节必须变化，刷新后同值读回。
  const patchFile = path.join(base, 'data/profiles/web/cordis.patch.yml')
  const patchDigest = async () => createHash('sha256').update(await fs.readFile(patchFile)).digest('hex')
  const patchBefore = await patchDigest()
  await page.getByRole('button', { name: /^(编辑|Edit) upgrade-fixture$/ }).click()
  const displayName = page.locator('input[aria-label="显示名称"], input[aria-label="Display name"]').first()
  await displayName.waitFor()
  await displayName.fill('upgrade-fixture-ui')
  const modelSaved = page.waitForResponse(response => /^\/api\/settings\/(update|mutate)$/.test(new URL(response.url()).pathname))
  await page.getByRole('button', { name: /^(保存|Apply)$/ }).click()
  if (!(await (await modelSaved).json()).result?.ok) throw new Error('模型页保存失败')
  const patchAfter = await patchDigest()
  if (patchAfter === patchBefore) {
    const recent = []
    const walk = async dir => {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) await walk(full)
        else if (Date.now() - (await fs.stat(full)).mtimeMs < 60000) recent.push(path.relative(base, full))
      }
    }
    await walk(path.join(base, 'data/profiles/web'))
    throw new Error('模型页保存没有落到 web profile patch；近 60s 变更文件：' + recent.join(', '))
  }
  await page.reload()
  await dashboardEntry().waitFor()
  await page.getByRole('button', { name: /^(设置|Settings)$/ }).click()
  await page.getByRole('button', { name: /^(模型|Models)$/ }).click()
  await page.getByRole('button', { name: /^(编辑|Edit) upgrade-fixture-ui/ }).waitFor()
  report.model_page_persistence = { patch_sha256_before: patchBefore, patch_sha256_after: patchAfter,
    persisted_display_name: 'upgrade-fixture-ui' }
  report.checks.push({ check: 'model-page-save-persists-profile-patch', ok: true })
  await page.getByRole('button', { name: /^(通用设置|General)$/ }).click()
  const changed = page.waitForResponse(response => /^\/api\/settings\/(update|mutate)$/.test(new URL(response.url()).pathname))
  await page.getByRole('button', { name: /^(增大字号|Increase font size)$/ }).click()
  const saved = await (await changed).json()
  if (!saved.result?.ok) throw new Error('字号设置保存失败')
  await page.reload()
  await dashboardEntry().waitFor()
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
  await dashboardEntry().waitFor()
  await page.waitForFunction(() => !document.body.hasAttribute('data-ds-dark-theme') && localStorage.getItem('silksec.theme.choice') === 'host')
  await page.getByRole('button', { name: /^(设置|Settings)$/ }).click()
  await page.getByRole('button', { name: /^(通用设置|General)$/ }).click()
  await page.getByRole('button', { name: '已关闭', exact: true }).click()
  await page.reload()
  await dashboardEntry().waitFor()
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
  if (noticeKiller) clearInterval(noticeKiller)
  if (browser) await browser.close()
  await fs.writeFile(path.join(out, 'browser-stream-private.json'), JSON.stringify(streamFrames, null, 2) + '\n', { mode: 0o600 })
  await fs.writeFile(path.join(out, 'browser-report.json'), JSON.stringify(report, null, 2) + '\n')
}
console.log(JSON.stringify(report))
if (!report.ok) process.exitCode = 1
