// ==============================================================================
// @silksec/sec-domain-proxy — SilkSecAgent proxy 域插件（v5 Phase 2.7：免费代理池——采集提案落池 / 轮换网关消费 / 会话保持）
//
// 契约：doc/secagent/v5/13-proxy.md（域设计，权威）+ 01-bus.md（总线）+ 00-conventions.md（宪法）
//
// 对外（cordis）：name='sec-domain-proxy'，apply() 把 manifest+handlers+backend 交给
// 总线 registry.register()（不 provide 任何业务方法——防绕过核心承诺）。
//
// 语义要点：
//  - file 后端单实现，owns {POOL_DIR}/ 五文件（pool.json/live.txt/blocklist.txt/stats.json/sticky.json）；
//  - 落池主路径 proxy_refresh：读采集链 proposal（out/proposal.json，纯计算产物）→ blocklist/transparent
//    过滤 → 排序 → 三文件原子写；trigger_collect:true 只触发 systemd 采集单元（不落池）；
//  - mubeng 热加载靠原生 `-w` watch（13-proxy §2.3 论证），事件只作观测（当前零订阅者）；
//  - 幂等裁决（本域无行级状态机，file 是滚动全量重建队列，三命令一律 idempotent:'none'，
//    域内以文件态表达幂等/重放语义——与 11-ledger §1.3.4 radar_drain「每次都是新读」同构）：
//    proxy_refresh 幂等键 = proposal 内容 sha1（落 stats.json.proposal_sha，同 proposal → status:replay）；
//    proxy_report_bad 幂等键 = hostport（blocklist 无撤销动词，已拉黑 → removed_from_live:false 不重复追加）；
//    proxy_sticky_bind 幂等键 = sticky_key（sticky.json 缓存复用即天然幂等，rebind:true 强制换出口）；
//  - 被读：exec 域（env_proxy 8899 注入前 proxy_stats 健康观测）/ dashboard（网关健康展示）。
// ==============================================================================

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

export const name = 'sec-domain-proxy'
export const version = '1.0.0'

const DEFAULT_POOL_DIR = process.env.SEC_PROXY_POOL_DIR || '/opt/silkspool/dsh/proxy-pool'
const DEFAULT_GATEWAY = process.env.SEC_EGRESS_PROXY || 'http://127.0.0.1:8899'
const REFRESH_UNIT = 'silksec-proxy-refresh.service'
const REFRESH_TIMER = 'silksec-proxy-refresh.timer'
const ROTATOR_UNIT = 'silksec-proxy-rotator.service'
const LIVE_LIMIT = 400
const PROTOCOLS = ['http', 'https', 'socks4', 'socks5']
const GRADES = ['elite', 'anonymous', 'unknown', 'socks']

const log = (msg) => { try { process.stderr.write(`[sec-domain-proxy] ${msg}\n`) } catch { /* noop */ } }

const backendUrl = new URL('../sec-backend-proxy-file/index.js', import.meta.url)
const { createProxyFileBackend } = await import(backendUrl.href)

function sha1(str) { return crypto.createHash('sha1').update(String(str)).digest('hex') }

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

function parseHostport(raw) {
  return String(raw).split('://').pop().split('@').pop().replace(/\/+$/, '').trim()
}

// ---------------------------------------------------------------------------
// manifest（13-proxy §1.2/§1.3/§1.4/§1.5 的机器形态）
// ---------------------------------------------------------------------------

const schema = (properties, required, extra = {}) => ({ type: 'object', properties, required, additionalProperties: false, ...extra })
const str = (opts = {}) => ({ type: 'string', ...opts })
const en = (values, extra = {}) => ({ type: 'string', enum: values, ...extra })
const int = (opts = {}) => ({ type: 'integer', ...opts })
const bool = (opts = {}) => ({ type: 'boolean', ...opts })

export const PROXY_MANIFEST = {
  domain: 'proxy',
  version: 1,
  service: 'secDomain.proxy',
  description: '免费代理池：采集提案落池（过滤分级排序）+ 轮换网关消费观测 + 会话保持；mubeng 原生 watch 热加载，事件仅观测。',
  owns: {
    tables: [],
    files: [
      'proxy-pool/pool.json',
      'proxy-pool/live.txt',
      'proxy-pool/blocklist.txt',
      'proxy-pool/stats.json',
      'proxy-pool/sticky.json',
      'data/events/proxy.jsonl',
    ],
  },
  commands: {
    proxy_refresh: {
      actor: ['script', 'model', 'dashboard', 'human'],
      schema: schema({
        trigger_collect: bool(),
        proposal_path: str(),
        force: bool(),
      }, []),
      idempotent: 'none',
      events: ['proxy.pool.refreshed'],
      event_limit: 1,
      invariants: [],
      timeout_ms: 60000,
      agent_note: '落池代理池：读取采集 proposal（纯计算产物）过滤分级后更新 pool.json/live.txt，mubeng 网关自动热加载。trigger_collect=true 先后台触发采集（5-15 分钟，完成后 timer 链自动落池）。池子耗尽/队列过旧/大量代理失效时调用；30min timer 平时自动维护，通常无需手动。',
      deprecated: false,
    },
    proxy_report_bad: {
      actor: ['model', 'script', 'dashboard', 'human'],
      schema: schema({
        proxy: str({ minLength: 1, maxLength: 256 }),
        reason: str({ maxLength: 128 }),
      }, ['proxy']),
      idempotent: 'none',
      events: ['proxy.bad.reported'],
      event_limit: 1,
      invariants: [],
      timeout_ms: 60000,
      agent_note: '上报失效/被目标封禁的代理：加入 blocklist 并从轮换队列移除（mubeng 热加载自动生效，不可撤销）。proxy 形如 http://1.2.3.4:8080 或 1.2.3.4:8080；reason 建议 timeout/banned_403/captcha/dead。谨慎上报：一次 timeout 不等于失效，确认重试仍失败再报。',
      deprecated: false,
    },
    proxy_sticky_bind: {
      actor: ['model', 'script'],
      schema: schema({
        sticky_key: str({ minLength: 1, maxLength: 128 }),
        protocol: en(['', 'http', 'https', 'socks4', 'socks5']),
        max_latency_ms: int({ minimum: 0, maximum: 60000 }),
        country: str({ maxLength: 4 }),
        rebind: bool(),
      }, ['sticky_key']),
      idempotent: 'none',
      events: ['proxy.sticky.bound'],
      event_limit: 1,
      invariants: [],
      timeout_ms: 60000,
      agent_note: '会话保持：同 sticky_key 多次调用复用同一出口 IP（登录态/多步交互场景）。可按 protocol/max_latency_ms/country 过滤；出口失效自动重选（延迟最优前 5 随机取一）。返回代理 URL 及元数据，注入方式：http_proxy=<url> https_proxy=<url> <命令>。经免费代理的流量绝不携带真实凭证。',
      deprecated: false,
    },
  },
  queries: {
    proxy_stats: {
      actor: ['model', 'dashboard', 'script', 'human', 'system'],
      params: schema({}, []),
      agent_note: '查看代理池整体状态：总数、各协议/匿名度分布、可用队列规模、上次刷新时间、轮换网关（127.0.0.1:8899）运行状态。',
    },
    proxy_list: {
      actor: ['model', 'dashboard', 'script', 'human'],
      params: schema({
        protocol: en([...PROTOCOLS, '']),
        grade: en([...GRADES, '']),
        max_latency_ms: int({ minimum: 0, maximum: 60000 }),
        country: str({ maxLength: 4 }),
        limit: int({ minimum: 1, maximum: 100 }),
        offset: int({ minimum: 0 }),
      }, []),
      agent_note: '列出可用代理队列（按延迟升序）。可选 protocol/grade/max_latency_ms/country 过滤，limit 默认 20 最大 100。单个 socks 代理从这里取。',
    },
    proxy_gateway: {
      actor: ['model', 'dashboard', 'script', 'human'],
      params: schema({}, []),
      agent_note: '查看本地轮换网关用法速查。网关每请求自动更换出口 IP、失败自动轮换/剔除，是批量探测防封的首选方式；各工具的代理注入参数写法见返回。',
    },
  },
  events: {
    'proxy.pool.refreshed': { payload: { type: 'object' }, redact: [] },
    'proxy.bad.reported': { payload: { type: 'object' }, redact: [] },
    'proxy.sticky.bound': { payload: { type: 'object' }, redact: [] },
  },
  subscribes: {},
  backend: 'repository-v1',
}

// ---------------------------------------------------------------------------
// handlers（命令/查询；本域无不变量 / 无订阅）
// ---------------------------------------------------------------------------

function makeHandlers(opts) {
  const gateway = opts.gateway || DEFAULT_GATEWAY

  function throwErr(code, message, hint, retryable = false) {
    throw Object.assign(new Error(message), { code, hint, retryable })
  }

  function cachedMatches(cached, protocol, maxLatency, country) {
    if (protocol && cached.protocol !== protocol) return false
    if (maxLatency && Number(cached.latency_ms || 0) > maxLatency) return false
    if (country && String(cached.country || '').toUpperCase() !== country) return false
    return true
  }

  const commands = {
    proxy_refresh: async (args, repo) => {
      // trigger_collect：只触发采集单元（异步），不落池
      if (args.trigger_collect) {
        repo.systemctlStartNoBlock(REFRESH_UNIT)
        return {
          data: { status: 'collecting', detail: '采集已后台运行（5-15 分钟），完成后由 timer 链自动落池；也可稍后 proxy_stats 查看' },
          events: [],
        }
      }

      const proposal = repo.readProposal(args.proposal_path)
      if (proposal === null || proposal.entries.length === 0) {
        throwErr('E_PROXY_NO_PROPOSAL', 'proposal 缺失/损坏/空', '先 trigger_collect:true 触发采集，或等 30min timer 自动链', false)
      }

      const prevStats = repo.readStats()
      if (!args.force && prevStats.proposal_sha === proposal.sha) {
        const live = repo.readLiveSet()
        return {
          data: {
            status: 'replay',
            pool_total: prevStats.total ?? repo.readPool().length,
            live_count: live.size,
            blocked_applied: prevStats.blocked_applied || 0,
            transparent_dropped: 0,
            sticky_invalidated: 0,
            refreshed_at: prevStats.refreshed_at || null,
            proposal_sha: proposal.sha,
          },
          events: [],
        }
      }

      if (!repo.poolWritable()) {
        throwErr('E_BACKEND_UNAVAILABLE', '代理池目录不可写', '以 silkspool 用户 chown 五文件或 sudo 修复后重试（silksec-proxy-refresh.service 以 root 跑，产出可能 root-owned）', true)
      }

      // 过滤（INV-P1 blocklist ∩ live = ∅ / INV-P4 pool 不含 transparent HTTP）
      const blockSet = repo.readBlocklistSet()
      let blockedApplied = 0
      let transparentDropped = 0
      const filtered = []
      for (const e of proposal.entries) {
        if (!e || typeof e !== 'object') continue
        const hostport = `${e.host}:${e.port}`
        if (blockSet.has(hostport)) { blockedApplied++; continue }
        const isHttp = e.protocol === 'http' || e.protocol === 'https'
        if (isHttp && e.grade === 'transparent') { transparentDropped++; continue }
        filtered.push(e)
      }
      filtered.sort((a, b) => (a.timeout || 999) - (b.timeout || 999))

      // live：elite/anonymous 的 http + 全部 socks，≤ LIVE_LIMIT（INV-P3）
      const liveEntries = filtered.filter((e) => e.grade === 'elite' || e.grade === 'anonymous' || e.grade === 'socks')
      const liveLimited = liveEntries.slice(0, LIVE_LIMIT)
      const liveLines = liveLimited.map(proxyUrl)

      const by_protocol = {}
      const by_grade = {}
      for (const e of filtered) {
        by_protocol[e.protocol] = (by_protocol[e.protocol] || 0) + 1
        by_grade[e.grade] = (by_grade[e.grade] || 0) + 1
      }
      const stats = {
        refreshed_at: Math.floor(Date.now() / 1000),
        total: filtered.length,
        by_protocol,
        by_grade,
        blocked_applied: blockedApplied,
        proposal_sha: proposal.sha,
      }

      // sticky 失效清理（INV-P5）+ 三文件原子写（INV-P6）
      const liveSet = new Set(liveLines)
      const stickyInvalidated = repo.cleanStickyNotInLive(liveSet)
      repo.writePoolAtomic(filtered, liveLines, stats)

      const data = {
        status: 'applied',
        pool_total: filtered.length,
        live_count: liveLines.length,
        blocked_applied: blockedApplied,
        transparent_dropped: transparentDropped,
        sticky_invalidated: stickyInvalidated,
        refreshed_at: stats.refreshed_at,
        proposal_sha: proposal.sha,
      }
      if (liveLines.length === 0) {
        data.hint = '池被过滤空，检查 blocklist 是否误报过多或采集源失效'
      }
      return {
        data,
        events: [{
          name: 'proxy.pool.refreshed',
          payload: { pool_total: filtered.length, live_count: liveLines.length, blocked_applied: blockedApplied, transparent_dropped: transparentDropped, proposal_sha: proposal.sha },
        }],
      }
    },

    proxy_report_bad: async (args, repo) => {
      const raw = String(args.proxy || '').trim()
      const hostport = parseHostport(raw)
      if (!hostport || !hostport.includes(':')) {
        throwErr('E_PROXY_BAD_ADDRESS', `无法解析代理地址: ${raw}`, '代理地址格式：http://1.2.3.4:8080 或 1.2.3.4:8080', false)
      }
      const reason = String(args.reason || '').slice(0, 128)

      const already = repo.readBlocklistSet().has(hostport)
      let removed = false
      let stickyInvalidated = 0
      if (!already) {
        repo.appendBlocklist(hostport, reason, Math.floor(Date.now() / 1000))
        removed = repo.removeFromLive(hostport)
        stickyInvalidated = repo.cleanStickyNotInLive(repo.readLiveSet())
      }
      const liveRemaining = repo.readLiveSet().size

      return {
        data: { blocked: hostport, removed_from_live: removed, live_remaining: liveRemaining, sticky_invalidated: stickyInvalidated },
        events: [{ name: 'proxy.bad.reported', payload: { proxy: hostport, reason, live_remaining: liveRemaining } }],
      }
    },

    proxy_sticky_bind: async (args, repo) => {
      const key = String(args.sticky_key || '').trim()
      const protocol = String(args.protocol || '')
      const maxLatency = Number(args.max_latency_ms) || 0
      const country = String(args.country || '').toUpperCase()
      const rebind = !!args.rebind

      const live = repo.readLiveSet()
      if (live.size === 0) throwErr('E_PROXY_POOL_EMPTY', '可用队列为空', '先 proxy_refresh（trigger_collect:true）', false)

      const sticky = repo.readSticky()
      const cached = sticky[key]

      if (!rebind && cached && cached.proxy && live.has(cached.proxy) && cachedMatches(cached, protocol, maxLatency, country)) {
        return {
          data: { ...cached, sticky: true, sticky_key: key },
          events: [{ name: 'proxy.sticky.bound', payload: { sticky_key: key, proxy: cached.proxy, reused: true } }],
        }
      }

      const candidates = []
      for (const e of repo.readPool()) {
        if (!live.has(proxyUrl(e))) continue
        if (protocol && e.protocol !== protocol) continue
        if (maxLatency && (e.timeout || 999) * 1000 > maxLatency) continue
        if (country) {
          const cc = (((e.geolocation || {}).country) || {}).iso_code || ''
          if (String(cc).toUpperCase() !== country) continue
        }
        candidates.push(e)
      }
      if (candidates.length === 0) throwErr('E_PROXY_NO_MATCH', '无符合过滤条件的代理', '放宽 max_latency_ms/country 或 proxy_list 查看可用面', false)

      const top = candidates.sort((a, b) => (a.timeout || 999) - (b.timeout || 999)).slice(0, 5)
      const chosen = meta(top[Math.floor(Math.random() * top.length)])
      sticky[key] = chosen
      repo.writeStickyAtomic(sticky)

      return {
        data: { ...chosen, sticky: false, sticky_key: key },
        events: [{ name: 'proxy.sticky.bound', payload: { sticky_key: key, proxy: chosen.proxy, reused: false } }],
      }
    },
  }

  const queries = {
    proxy_stats: async (_args, repo) => {
      const stats = repo.readStats()
      const refreshedAt = stats.refreshed_at
      const live = repo.readLiveSet()
      const sticky = repo.readSticky()
      return {
        refreshed_at: refreshedAt || null,
        age_minutes: refreshedAt ? Math.round(((Date.now() / 1000 - refreshedAt) / 60) * 10) / 10 : null,
        total: Number.isInteger(stats.total) ? stats.total : repo.readPool().length,
        by_protocol: stats.by_protocol || {},
        by_grade: stats.by_grade || {},
        blocked_applied: stats.blocked_applied || 0,
        live_txt_size: live.size,
        live_limit: LIVE_LIMIT,
        sticky_keys: Object.keys(sticky).length,
        gateway,
        rotator_status: repo.systemctlIsActive(ROTATOR_UNIT),
        refresh_timer: repo.systemctlIsActive(REFRESH_TIMER),
        writable: repo.poolWritable(),
      }
    },

    proxy_list: async (args, repo) => {
      const live = repo.readLiveSet()
      const protocol = String(args.protocol || '')
      const grade = String(args.grade || '')
      const maxLatency = Number(args.max_latency_ms) || 0
      const country = String(args.country || '').toUpperCase()
      const items = []
      for (const e of repo.readPool()) {
        if (!live.has(proxyUrl(e))) continue
        if (protocol && e.protocol !== protocol) continue
        if (grade && e.grade !== grade) continue
        if (maxLatency && (e.timeout || 999) * 1000 > maxLatency) continue
        if (country) {
          const cc = (((e.geolocation || {}).country) || {}).iso_code || ''
          if (String(cc).toUpperCase() !== country) continue
        }
        items.push(meta(e))
      }
      // 13-proxy §1.4.2：total_live 是 live 总数（非过滤后数）——过滤后计数以 rows.length 为准
      return { rows: items, total: live.size, meta: { total_live: live.size } }
    },

    proxy_gateway: async (_args, repo) => {
      return {
        gateway,
        rotator_status: repo.systemctlIsActive(ROTATOR_UNIT),
        usage: {
          'env前缀（通用）': `http_proxy=${gateway} https_proxy=${gateway} <命令>`,
          curl: `curl -x ${gateway} <url>`,
          sqlmap: `sqlmap -u <url> --proxy=${gateway}`,
          nuclei: `nuclei -u <url> -proxy ${gateway}`,
          'httpx/ffuf': `httpx -http-proxy ${gateway} / ffuf -x ${gateway}`,
          'nmap(仅HTTP代理探测)': '经网关取单代理后: nmap -sT --proxies <proxy_url> <target>',
        },
        notes: [
          '轮换网关仅代理 HTTP/HTTPS 流量；SOCKS 需求请用 proxy_list 取 socks5 代理自行注入',
          '经代理的流量绝不携带任何真实凭证/Cookie/Token（免费代理可被运营者嗅探）',
          'nmap 经代理只能用 -sT 全连接扫描，无 SYN/UDP',
          '会话保持场景（登录态）用 proxy_sticky_bind，不要走轮换网关',
        ],
      }
    },
  }

  return { ...commands, queries, invariants: {}, subscribers: {} }
}

// ---------------------------------------------------------------------------
// 组装（测试与 cordis 共用）
// ---------------------------------------------------------------------------

export function buildProxyDomain(opts = {}) {
  const poolDir = opts.poolDir || DEFAULT_POOL_DIR
  const gateway = opts.gateway || DEFAULT_GATEWAY
  const backend = createProxyFileBackend({
    poolDir,
    systemctlIsActive: opts.systemctlIsActive,
    systemctlStartNoBlock: opts.systemctlStartNoBlock,
  })
  return {
    manifest: PROXY_MANIFEST,
    handlers: makeHandlers({ ...opts, poolDir, gateway }),
    backend,
  }
}

export function apply(ctx, config = {}) {
  const poolDir = process.env.SEC_PROXY_POOL_DIR || DEFAULT_POOL_DIR
  const gateway = process.env.SEC_EGRESS_PROXY || DEFAULT_GATEWAY
  try {
    ctx.inject(['secDomainBus'], (child) => {
      const bus = child.secDomainBus
      const domain = buildProxyDomain({ poolDir, gateway })
      const res = bus.registry.register(domain)
      if (res.ok) log(`proxy 域注册成功（registered=${res.registered}）`)
      else log(`proxy 域注册被拒：${res.error?.code} ${res.error?.message}`)
      return () => {}
    })
  } catch (e) {
    log(`secDomainBus 注入失败：${e?.message}——proxy 域未注册（总线必须先行挂载）`)
  }
  return null
}
