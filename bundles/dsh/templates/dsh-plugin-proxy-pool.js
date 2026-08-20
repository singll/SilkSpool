// ==============================================================================
// SilkSecAgent 代理池插件（dsh 原生插件，替代原 MCP 模式 mcp_proxy_pool.py）
//
// 架构（spool bundle csai/dsh 统一部署）：
//   csai-proxy-refresh.timer ──每30分钟──▶ proxy-scraper-checker（采集+验证）
//                                         └─▶ proxy_grade.py（分级 → pool.json / live.txt）
//   csai-proxy-rotator.service ──▶ mubeng 本地轮换网关 http://127.0.0.1:8899
//
// 本插件把代理池管理注册为 DSH 原生工具（ctx.tools），不再有 MCP 进程：
//   proxy_pool_stats / proxy_pool_get / proxy_pool_list
//   proxy_pool_report_bad / proxy_pool_refresh / proxy_pool_gateway
//
// 配置（环境变量，systemd EnvironmentFile 注入）：
//   SEC_PROXY_POOL_DIR  代理池数据目录（默认 /opt/silkspool/csai/proxy-pool）
//   SEC_EGRESS_PROXY    轮换网关地址（默认 http://127.0.0.1:8899）
// ==============================================================================

import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

export const name = 'silksec-proxy-pool'
export const inject = ['tools']

// 零依赖工具构建（等价 @deepseek-ai/dsh-tools 的 defineTool 产物，避免 link: 安装下 peer 依赖解析失败）
// parameters/output.schema 直接使用 JSON Schema
function tool(options) {
  return {
    name: options.name,
    description: options.description,
    parameters: options.parameters,
    output: { schema: options.outputSchema || { type: 'object' }, render: options.render },
    async execute(args) { return options.execute(args || {}) },
  }
}

const POOL_DIR = process.env.SEC_PROXY_POOL_DIR || '/opt/silkspool/csai/proxy-pool'
const GATEWAY = process.env.SEC_EGRESS_PROXY || 'http://127.0.0.1:8899'
const REFRESH_UNIT = 'csai-proxy-refresh.service'
const REFRESH_TIMER = 'csai-proxy-refresh.timer'
const ROTATOR_UNIT = 'csai-proxy-rotator.service'

const POOL_JSON = path.join(POOL_DIR, 'pool.json')
const LIVE_TXT = path.join(POOL_DIR, 'live.txt')
const BLOCKLIST = path.join(POOL_DIR, 'blocklist.txt')
const STATS_JSON = path.join(POOL_DIR, 'stats.json')
const STICKY_JSON = path.join(POOL_DIR, 'sticky.json')

// -------------------- 数据访问 --------------------

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}

function loadPool() { return readJSON(POOL_JSON, []) }

function loadLiveUrls() {
  try {
    return new Set(fs.readFileSync(LIVE_TXT, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean))
  } catch { return new Set() }
}

function proxyUrl(e) {
  const auth = e.username ? `${e.username}:${e.password || ''}@` : ''
  return `${e.protocol || 'http'}://${auth}${e.host}:${e.port}`
}

function meta(e) {
  const geo = e.geolocation || {}
  return {
    proxy: proxyUrl(e),
    protocol: e.protocol,
    grade: e.grade,
    latency_ms: Math.round((e.timeout || 0) * 1000),
    exit_ip: e.exit_ip,
    country: (geo.country || {}).iso_code,
    city: ((geo.city || {}).names || {}).en,
  }
}

function systemctl(...args) {
  try {
    return String(execFileSync('systemctl', args, { timeout: 15000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).trim()
  } catch (err) {
    return String(err.stdout || err.stderr || err.message || 'error').trim()
  }
}

function systemctlSudo(...args) {
  try {
    return String(execFileSync('sudo', ['-n', 'systemctl', ...args], { timeout: 15000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).trim()
  } catch (err) {
    return String(err.stdout || err.stderr || err.message || 'error').trim()
  }
}

// -------------------- 工具实现 --------------------

function toolStats() {
  const stats = readJSON(STATS_JSON, {})
  const refreshedAt = stats.refreshed_at
  return {
    ...stats,
    age_minutes: refreshedAt ? Math.round(((Date.now() / 1000 - refreshedAt) / 60) * 10) / 10 : null,
    live_txt_size: loadLiveUrls().size,
    gateway: GATEWAY,
    rotator_status: systemctl('is-active', ROTATOR_UNIT),
    refresh_timer: systemctl('is-active', REFRESH_TIMER),
  }
}

function toolGet(args) {
  const live = loadLiveUrls()
  if (live.size === 0) return { error: '可用队列为空，请先 proxy_pool_refresh', gateway: GATEWAY }

  const stickyKey = args.sticky_key || null
  if (stickyKey) {
    const sticky = readJSON(STICKY_JSON, {})
    const cached = sticky[stickyKey]
    if (cached && live.has(cached.proxy)) return { ...cached, sticky: true }
  }

  const candidates = []
  for (const e of loadPool()) {
    if (!live.has(proxyUrl(e))) continue
    if (args.protocol && e.protocol !== args.protocol) continue
    if (args.max_latency_ms && (e.timeout || 999) * 1000 > args.max_latency_ms) continue
    if (args.country) {
      const cc = ((((e.geolocation || {}).country) || {}).iso_code || '').toUpperCase()
      if (cc !== String(args.country).toUpperCase()) continue
    }
    candidates.push(e)
  }
  if (candidates.length === 0) return { error: '无符合过滤条件的代理', live_total: live.size }

  // 延迟最优的前 5 个里随机，兼顾速度与分散
  const top = candidates.sort((a, b) => (a.timeout || 999) - (b.timeout || 999)).slice(0, 5)
  const chosen = meta(top[Math.floor(Math.random() * top.length)])

  if (stickyKey) {
    const sticky = readJSON(STICKY_JSON, {})
    sticky[stickyKey] = chosen
    try { fs.writeFileSync(STICKY_JSON, JSON.stringify(sticky, null, 1)) } catch { /* 只读降级 */ }
  }
  return chosen
}

function toolList(args) {
  const live = loadLiveUrls()
  const limit = Math.max(1, Math.min(args.limit || 20, 100))
  const items = []
  for (const e of loadPool()) {
    if (!live.has(proxyUrl(e))) continue
    if (args.protocol && e.protocol !== args.protocol) continue
    if (args.grade && e.grade !== args.grade) continue
    items.push(meta(e))
    if (items.length >= limit) break
  }
  return { total_live: live.size, items }
}

function toolReportBad(args) {
  const raw = String(args.proxy || '').trim()
  const hostport = raw.split('://').pop().split('@').pop().replace(/\/+$/, '').trim()
  if (!hostport || !hostport.includes(':')) return { error: `无法解析代理地址: ${args.proxy}` }

  let existing = new Set()
  try { existing = new Set(fs.readFileSync(BLOCKLIST, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean)) } catch { /* 无文件 */ }
  if (!existing.has(hostport)) {
    const note = args.reason ? `${hostport}  # ${args.reason} ${Math.floor(Date.now() / 1000)}` : hostport
    fs.appendFileSync(BLOCKLIST, note + '\n')
  }

  let removed = false
  try {
    const lines = fs.readFileSync(LIVE_TXT, 'utf8').split('\n').filter((l) => l.trim())
    const kept = lines.filter((l) => !l.includes(hostport))
    removed = kept.length !== lines.length
    if (removed) {
      const tmp = LIVE_TXT + '.tmp'
      fs.writeFileSync(tmp, kept.join('\n') + (kept.length ? '\n' : ''))
      fs.renameSync(tmp, LIVE_TXT)
    }
  } catch { /* 无 live.txt */ }

  return { blocked: hostport, removed_from_live: removed, live_remaining: loadLiveUrls().size }
}

function toolRefresh() {
  if (systemctl('is-active', REFRESH_UNIT) === 'activating') return { status: 'already_running' }
  const out = systemctlSudo('start', '--no-block', REFRESH_UNIT)
  return { status: 'started', detail: out || 'refresh 已在后台运行，数分钟后 proxy_pool_stats 查看新队列' }
}

function toolGateway() {
  return {
    gateway: GATEWAY,
    rotator_status: systemctl('is-active', ROTATOR_UNIT),
    usage: {
      'env前缀（通用）': `http_proxy=${GATEWAY} https_proxy=${GATEWAY} <命令>`,
      curl: `curl -x ${GATEWAY} <url>`,
      sqlmap: `sqlmap -u <url> --proxy=${GATEWAY}`,
      nuclei: `nuclei -u <url> -proxy ${GATEWAY}`,
      'httpx/ffuf': `httpx -http-proxy ${GATEWAY} / ffuf -x ${GATEWAY}`,
      'nmap(仅HTTP代理探测)': '经网关取单代理后: nmap -sT --proxies <proxy_url> <target>',
    },
    notes: [
      '轮换网关仅代理 HTTP/HTTPS 流量；SOCKS 需求请用 proxy_pool_get 取 socks5 代理自行注入',
      '经代理的流量绝不携带任何真实凭证/Cookie/Token（免费代理可被运营者嗅探）',
      'nmap 经代理只能用 -sT 全连接扫描，无 SYN/UDP',
    ],
  }
}

// -------------------- 注册 --------------------

function renderJSON(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 1) }]
}

const PROTOCOLS = ['http', 'https', 'socks4', 'socks5']

export function apply(ctx) {
  ctx.tools.register(tool({
    name: 'proxy_pool_stats',
    description: '查看代理池整体状态：总数、各协议/匿名度分布、可用队列规模、上次刷新时间、轮换网关运行状态。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    render: renderJSON,
    execute: async () => toolStats(),
  }))

  ctx.tools.register(tool({
    name: 'proxy_pool_get',
    description: '从可用队列取一个代理。可按 protocol(http/https/socks4/socks5)、max_latency_ms、country(ISO 两位码如 US) 过滤；'
      + '传入 sticky_key 可在多次调用间复用同一出口（会话保持）。返回代理 URL 及元数据；注入方式：'
      + 'http_proxy=<url> https_proxy=<url> <命令>，或工具自带 --proxy 参数。',
    parameters: {
      type: 'object',
      properties: {
        protocol: { type: 'string', description: 'http/https/socks4/socks5', enum: PROTOCOLS },
        max_latency_ms: { type: 'integer', description: '最大延迟（毫秒）' },
        country: { type: 'string', description: 'ISO 两位国家码，如 US' },
        sticky_key: { type: 'string', description: '会话保持键，同键复用同一出口' },
      },
      additionalProperties: false,
    },
    render: renderJSON,
    execute: async (args) => toolGet(args),
  }))

  ctx.tools.register(tool({
    name: 'proxy_pool_list',
    description: '列出可用代理队列（按延迟升序）。可选 protocol / grade(elite|anonymous|socks) 过滤，limit 默认 20。',
    parameters: {
      type: 'object',
      properties: {
        protocol: { type: 'string', enum: PROTOCOLS },
        grade: { type: 'string', enum: ['elite', 'anonymous', 'unknown', 'socks'] },
        limit: { type: 'integer', description: '返回条数，默认 20，最大 100' },
      },
      additionalProperties: false,
    },
    render: renderJSON,
    execute: async (args) => toolList(args),
  }))

  ctx.tools.register(tool({
    name: 'proxy_pool_report_bad',
    description: '上报失效/被目标封禁的代理：加入 blocklist 并从轮换队列移除（mubeng 热加载自动生效）。'
      + 'proxy 形如 http://1.2.3.4:8080 或 1.2.3.4:8080；reason 可选，如 timeout / banned_403 / captcha。',
    parameters: {
      type: 'object',
      properties: {
        proxy: { type: 'string', description: '代理地址，如 http://1.2.3.4:8080' },
        reason: { type: 'string', description: '失效原因，如 timeout / banned_403 / captcha' },
      },
      required: ['proxy'],
      additionalProperties: false,
    },
    render: renderJSON,
    execute: async (args) => toolReportBad(args),
  }))

  ctx.tools.register(tool({
    name: 'proxy_pool_refresh',
    description: '触发一次代理池刷新（后台执行：重新采集免费代理→验证存活→匿名度分级→更新轮换队列，约需 5-15 分钟）。'
      + '当池子耗尽、队列过旧或大量代理失效时调用。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    render: renderJSON,
    execute: async () => toolRefresh(),
  }))

  ctx.tools.register(tool({
    name: 'proxy_pool_gateway',
    description: '查看本地轮换网关用法。网关每请求自动更换出口 IP、失败自动轮换/剔除，是批量探测防封的首选方式。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    render: renderJSON,
    execute: async () => toolGateway(),
  }))
}
