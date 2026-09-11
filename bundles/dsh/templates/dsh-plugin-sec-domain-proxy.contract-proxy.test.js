// ==============================================================================
// @silksec/sec-domain-proxy 契约测试（13-proxy.md §契约矩阵：落池 happy / replay / trigger_collect /
// 过滤（blocklist+transparent）/ actor / report_bad 自然键幂等 / sticky_bind 缓存复用 /
// 查询口径（total_live = live 总数）/ 事件载荷 / 别名）
// 运行：node --test test/contract-proxy.test.js（插件组装目录内，type:module）
// 全部用例使用临时目录，绝不触碰 /opt/silkspool/dsh/proxy-pool。
// systemctl 以注入 fake 隔离（is-active → 'active'，start → 'started'）。
// ==============================================================================

import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createBus } from '../../sec-domain-bus/index.js'
import { buildProxyDomain, PROXY_MANIFEST } from '../index.js'

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'sec-domain-proxy-')) }

const PROXY_ALIASES = `aliases:
  proxy_pool_stats: proxy_stats
  proxy_pool_list: proxy_list
  proxy_pool_gateway: proxy_gateway
  proxy_pool_report_bad: proxy_report_bad
dispatch_aliases:
  proxy_pool_refresh:
    router: proxy_refresh_router
    warn: "proxy_pool_refresh 已映射为 proxy_refresh(trigger_collect:true)——v5 落池为主语义，请改用语义动词"
  proxy_pool_get:
    router: proxy_get_router
    warn: "proxy_pool_get 已映射为 proxy_sticky_bind（sticky_key 必填）——单次取用走网关 8899，请改用语义动词"
`

function entry(host, port, protocol, grade, timeout, country = 'US') {
  return {
    protocol, host, port, timeout,
    exit_ip: host,
    geolocation: { country: { iso_code: country }, city: { names: { en: 'Ashburn' } } },
    grade,
  }
}

function makeEnv(opts = {}) {
  const dir = tmpDir()
  const poolDir = path.join(dir, 'proxy-pool')
  const dataDir = path.join(dir, 'data')
  fs.mkdirSync(path.join(poolDir, 'out'), { recursive: true })
  fs.mkdirSync(dataDir, { recursive: true })
  if (opts.aliases) fs.writeFileSync(path.join(dir, 'bus.aliases.yaml'), opts.aliases)
  const sys = { isActiveCalls: [], startCalls: [] }
  const bus = createBus({
    dataDir,
    dbFile: path.join(dir, 'asset-graph.db'),
    aliasesFile: path.join(dir, 'bus.aliases.yaml'),
    auditFile: path.join(dir, 'audit.jsonl'),
    eventsDir: path.join(dir, 'events'),
    sidecars: false,
    startDispatcherTimer: false,
  })
  const domain = buildProxyDomain({
    poolDir,
    gateway: 'http://127.0.0.1:8899',
    systemctlIsActive: (unit) => { sys.isActiveCalls.push(unit); return 'active' },
    systemctlStartNoBlock: (unit) => { sys.startCalls.push(unit); return 'started' },
  })
  const reg = bus.registry.register(domain)
  assert.equal(reg.ok, true, `proxy 域应注册成功：${reg.error?.message || ''}`)
  return { dir, poolDir, dataDir, bus, domain, sys }
}

function writeProposal(poolDir, entries) {
  fs.writeFileSync(path.join(poolDir, 'out', 'proposal.json'), JSON.stringify(entries, null, 1))
}

function writeBlocklist(poolDir, lines) {
  fs.writeFileSync(path.join(poolDir, 'blocklist.txt'), lines.join('\n') + '\n')
}

function readEvents(dir) {
  const f = path.join(dir, 'events', 'proxy.jsonl')
  if (!fs.existsSync(f)) return []
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
}

function seedPool(poolDir) {
  writeBlocklist(poolDir, ['5.5.5.5:8080  # dead 1234567890'])
  writeProposal(poolDir, [
    entry('1.1.1.1', 8080, 'http', 'elite', 0.5),
    entry('2.2.2.2', 8080, 'http', 'anonymous', 0.8),
    entry('3.3.3.3', 8080, 'http', 'transparent', 0.6),
    entry('4.4.4.4', 1080, 'socks5', 'socks', 1.0, 'DE'),
    entry('5.5.5.5', 8080, 'http', 'elite', 0.4),
  ])
}

// ---------------------------------------------------------------------------
// 1. proxy_refresh happy path + 过滤 + 事件
// ---------------------------------------------------------------------------

test('proxy_refresh: 落池 happy + blocklist/transparent 过滤 + pool.refreshed 事件', async () => {
  const { dir, poolDir, bus } = makeEnv()
  seedPool(poolDir)
  const r = await bus.dispatch('proxy', 'refresh', {}, { actor: 'script' })
  assert.equal(r.ok, true, r.error?.message || '')
  assert.equal(r.data.status, 'applied')
  assert.equal(r.data.pool_total, 3)
  assert.equal(r.data.live_count, 3)
  assert.equal(r.data.blocked_applied, 1)
  assert.equal(r.data.transparent_dropped, 1)
  assert.equal(r.event_ids.length, 1)
  // pool.json 无 transparent / blocklisted 条目
  const pool = JSON.parse(fs.readFileSync(path.join(poolDir, 'pool.json'), 'utf8'))
  assert.equal(pool.length, 3)
  assert.ok(pool.every((e) => e.grade !== 'transparent'))
  assert.ok(pool.every((e) => `${e.host}:${e.port}` !== '5.5.5.5:8080'))
  // live.txt 三行
  const live = fs.readFileSync(path.join(poolDir, 'live.txt'), 'utf8').trim().split('\n')
  assert.equal(live.length, 3)
  // stats.json
  const stats = JSON.parse(fs.readFileSync(path.join(poolDir, 'stats.json'), 'utf8'))
  assert.equal(stats.total, 3)
  assert.equal(stats.by_grade.elite, 1)
  assert.ok(stats.proposal_sha)
  assert.ok(readEvents(dir).find((e) => e.name === 'proxy.pool.refreshed'))
})

test('proxy_refresh: 同 proposal 重放 → status replay（不重写）', async () => {
  const { poolDir, bus } = makeEnv()
  seedPool(poolDir)
  const r1 = await bus.dispatch('proxy', 'refresh', {}, { actor: 'script' })
  assert.equal(r1.data.status, 'applied')
  const stats1 = fs.statSync(path.join(poolDir, 'stats.json')).mtimeMs
  const r2 = await bus.dispatch('proxy', 'refresh', {}, { actor: 'script' })
  assert.equal(r2.ok, true)
  assert.equal(r2.data.status, 'replay')
  assert.equal(r2.event_ids.length, 0)
  const stats2 = fs.statSync(path.join(poolDir, 'stats.json')).mtimeMs
  assert.equal(stats1, stats2)
})

test('proxy_refresh: force:true 跳过 sha 检查 → 重新落池', async () => {
  const { poolDir, bus } = makeEnv()
  seedPool(poolDir)
  await bus.dispatch('proxy', 'refresh', {}, { actor: 'script' })
  const r = await bus.dispatch('proxy', 'refresh', { force: true }, { actor: 'script' })
  assert.equal(r.ok, true)
  assert.equal(r.data.status, 'applied')
})

test('proxy_refresh: trigger_collect:true → collecting（触发 systemd，不落池）', async () => {
  const { poolDir, bus, sys } = makeEnv()
  const r = await bus.dispatch('proxy', 'refresh', { trigger_collect: true }, { actor: 'model' })
  assert.equal(r.ok, true)
  assert.equal(r.data.status, 'collecting')
  assert.ok(sys.startCalls.includes('silksec-proxy-refresh.service'))
  assert.equal(fs.existsSync(path.join(poolDir, 'pool.json')), false)
})

test('proxy_refresh: proposal 缺失 → E_PROXY_NO_PROPOSAL；actor webhook → E_ACTOR_FORBIDDEN', async () => {
  const { bus } = makeEnv()
  const r1 = await bus.dispatch('proxy', 'refresh', {}, { actor: 'script' })
  assert.equal(r1.ok, false)
  assert.equal(r1.error.code, 'E_PROXY_NO_PROPOSAL')
  const r2 = await bus.dispatch('proxy', 'refresh', {}, { actor: 'webhook' })
  assert.equal(r2.ok, false)
  assert.equal(r2.error.code, 'E_ACTOR_FORBIDDEN')
})

// ---------------------------------------------------------------------------
// 2. proxy_report_bad
// ---------------------------------------------------------------------------

test('proxy_report_bad: 拉黑 + 从 live 移除 + bad.reported 事件', async () => {
  const { dir, poolDir, bus } = makeEnv()
  seedPool(poolDir)
  await bus.dispatch('proxy', 'refresh', {}, { actor: 'script' })
  const r = await bus.dispatch('proxy', 'report_bad', { proxy: 'http://1.1.1.1:8080', reason: 'timeout' }, { actor: 'model' })
  assert.equal(r.ok, true, r.error?.message || '')
  assert.equal(r.data.blocked, '1.1.1.1:8080')
  assert.equal(r.data.removed_from_live, true)
  assert.equal(r.data.live_remaining, 2)
  const block = fs.readFileSync(path.join(poolDir, 'blocklist.txt'), 'utf8')
  assert.ok(block.includes('1.1.1.1:8080'))
  const live = fs.readFileSync(path.join(poolDir, 'live.txt'), 'utf8')
  assert.ok(!live.includes('1.1.1.1:8080'))
  assert.ok(readEvents(dir).find((e) => e.name === 'proxy.bad.reported' && e.payload.proxy === '1.1.1.1:8080'))
})

test('proxy_report_bad: 无法解析 → E_PROXY_BAD_ADDRESS；webhook → E_ACTOR_FORBIDDEN', async () => {
  const { bus } = makeEnv()
  const r1 = await bus.dispatch('proxy', 'report_bad', { proxy: 'not-an-address' }, { actor: 'model' })
  assert.equal(r1.ok, false)
  assert.equal(r1.error.code, 'E_PROXY_BAD_ADDRESS')
  const r2 = await bus.dispatch('proxy', 'report_bad', { proxy: '1.2.3.4:8080' }, { actor: 'webhook' })
  assert.equal(r2.ok, false)
  assert.equal(r2.error.code, 'E_ACTOR_FORBIDDEN')
})

test('proxy_report_bad: 幂等——同 proxy 重复上报 removed_from_live:false（blocklist 不重复追加）', async () => {
  const { poolDir, bus } = makeEnv()
  seedPool(poolDir)
  await bus.dispatch('proxy', 'refresh', {}, { actor: 'script' })
  const args = { proxy: '1.1.1.1:8080', reason: 'timeout' }
  const r1 = await bus.dispatch('proxy', 'report_bad', args, { actor: 'model' })
  assert.equal(r1.ok, true)
  assert.equal(r1.data.removed_from_live, true)
  const r2 = await bus.dispatch('proxy', 'report_bad', args, { actor: 'model' })
  assert.equal(r2.ok, true)
  assert.equal(r2.data.removed_from_live, false)
  // blocklist 仅一条（不重复追加）
  const block = fs.readFileSync(path.join(poolDir, 'blocklist.txt'), 'utf8')
  assert.equal(block.split('\n').filter((l) => l.includes('1.1.1.1:8080')).length, 1)
})

// ---------------------------------------------------------------------------
// 3. proxy_sticky_bind
// ---------------------------------------------------------------------------

test('proxy_sticky_bind: 绑定 → 缓存复用（sticky:false → sticky:true）+ sticky.bound 事件', async () => {
  const { dir, poolDir, bus } = makeEnv()
  seedPool(poolDir)
  await bus.dispatch('proxy', 'refresh', {}, { actor: 'script' })
  const r1 = await bus.dispatch('proxy', 'sticky_bind', { sticky_key: 'meituan-login' }, { actor: 'model' })
  assert.equal(r1.ok, true, r1.error?.message || '')
  assert.equal(r1.data.sticky, false)
  assert.equal(r1.data.sticky_key, 'meituan-login')
  const r2 = await bus.dispatch('proxy', 'sticky_bind', { sticky_key: 'meituan-login' }, { actor: 'model' })
  assert.equal(r2.ok, true)
  assert.equal(r2.data.sticky, true)
  assert.equal(r2.data.proxy, r1.data.proxy)
  const ev = readEvents(dir).filter((e) => e.name === 'proxy.sticky.bound')
  assert.ok(ev.find((e) => e.payload.reused === false))
  assert.ok(ev.find((e) => e.payload.reused === true))
})

test('proxy_sticky_bind: 空池 → E_PROXY_POOL_EMPTY；过滤无命中 → E_PROXY_NO_MATCH；dashboard → E_ACTOR_FORBIDDEN', async () => {
  const { poolDir, bus } = makeEnv()
  const r0 = await bus.dispatch('proxy', 'sticky_bind', { sticky_key: 'k' }, { actor: 'model' })
  assert.equal(r0.ok, false)
  assert.equal(r0.error.code, 'E_PROXY_POOL_EMPTY')
  seedPool(poolDir)
  await bus.dispatch('proxy', 'refresh', {}, { actor: 'script' })
  const r1 = await bus.dispatch('proxy', 'sticky_bind', { sticky_key: 'k', protocol: 'socks4' }, { actor: 'model' })
  assert.equal(r1.ok, false)
  assert.equal(r1.error.code, 'E_PROXY_NO_MATCH')
  const r2 = await bus.dispatch('proxy', 'sticky_bind', { sticky_key: 'k' }, { actor: 'dashboard' })
  assert.equal(r2.ok, false)
  assert.equal(r2.error.code, 'E_ACTOR_FORBIDDEN')
})

test('proxy_sticky_bind: 被拉黑代理触发 sticky 失效重选', async () => {
  const { poolDir, bus } = makeEnv()
  seedPool(poolDir)
  await bus.dispatch('proxy', 'refresh', {}, { actor: 'script' })
  // 绑定后逐一拉黑当前代理直到耗尽触发重选语义（此处只验证 report_bad 后 sticky 失效清理）
  const b = await bus.dispatch('proxy', 'sticky_bind', { sticky_key: 'sess' }, { actor: 'model' })
  assert.equal(b.ok, true)
  await bus.dispatch('proxy', 'report_bad', { proxy: b.data.proxy, reason: 'dead' }, { actor: 'model' })
  const b2 = await bus.dispatch('proxy', 'sticky_bind', { sticky_key: 'sess' }, { actor: 'model' })
  assert.equal(b2.ok, true)
  assert.equal(b2.data.sticky, false)
  assert.notEqual(b2.data.proxy, b.data.proxy)
})

// ---------------------------------------------------------------------------
// 4. 查询口径
// ---------------------------------------------------------------------------

test('query: proxy_stats 状态 + 网关健康 + writable', async () => {
  const { poolDir, bus, sys } = makeEnv()
  seedPool(poolDir)
  await bus.dispatch('proxy', 'refresh', {}, { actor: 'script' })
  const r = await bus.query('proxy', 'stats', {}, { actor: 'dashboard' })
  assert.equal(r.ok, true)
  assert.equal(r.data.total, 3)
  assert.equal(r.data.live_txt_size, 3)
  assert.equal(r.data.live_limit, 400)
  assert.equal(r.data.gateway, 'http://127.0.0.1:8899')
  assert.equal(r.data.rotator_status, 'active')
  assert.equal(r.data.refresh_timer, 'active')
  assert.equal(r.data.writable, true)
  assert.ok(sys.isActiveCalls.includes('silksec-proxy-rotator.service'))
  assert.ok(sys.isActiveCalls.includes('silksec-proxy-refresh.timer'))
})

test('query: proxy_list 过滤 + total_live = live 总数（非过滤后）', async () => {
  const { poolDir, bus } = makeEnv()
  seedPool(poolDir)
  await bus.dispatch('proxy', 'refresh', {}, { actor: 'script' })
  const r = await bus.query('proxy', 'list', { protocol: 'http', grade: 'elite', limit: 10 }, { actor: 'dashboard' })
  assert.equal(r.ok, true)
  assert.equal(r.total_live, 3)
  assert.ok(r.rows.length <= 10)
  assert.ok(r.rows.every((x) => x.protocol === 'http' && x.grade === 'elite'))
  // 按延迟升序
  const lats = r.rows.map((x) => x.latency_ms)
  for (let i = 1; i < lats.length; i++) assert.ok(lats[i] >= lats[i - 1])
})

test('query: proxy_gateway 用法速查', async () => {
  const { bus } = makeEnv()
  const r = await bus.query('proxy', 'gateway', {}, { actor: 'model' })
  assert.equal(r.ok, true)
  assert.equal(r.data.gateway, 'http://127.0.0.1:8899')
  assert.ok(r.data.usage.curl.includes('8899'))
  assert.ok(r.data.notes.length >= 4)
})

// ---------------------------------------------------------------------------
// 5. 别名
// ---------------------------------------------------------------------------

test('alias: proxy_pool_stats/list/gateway/report_bad 静态直通 + deprecated_use 在记', async () => {
  const { dir, poolDir, bus } = makeEnv({ aliases: PROXY_ALIASES })
  seedPool(poolDir)
  await bus.dispatch('proxy', 'refresh', {}, { actor: 'script' })
  const stats = await bus.query('', 'proxy_pool_stats', {}, { actor: 'dashboard' })
  assert.equal(stats.ok, true)
  assert.equal(stats.query, 'stats')
  assert.equal(stats.data.total, 3)
  const list = await bus.query('', 'proxy_pool_list', { limit: 5 }, { actor: 'dashboard' })
  assert.equal(list.ok, true)
  assert.equal(list.query, 'list')
  const gw = await bus.query('', 'proxy_pool_gateway', {}, { actor: 'model' })
  assert.equal(gw.ok, true)
  assert.equal(gw.query, 'gateway')
  const rb = await bus.dispatch('', 'proxy_pool_report_bad', { proxy: '1.1.1.1:8080', reason: 'dead' }, { actor: 'model' })
  assert.equal(rb.ok, true)
  assert.equal(rb.cmd, 'report_bad')
  const audit = fs.readFileSync(path.join(dir, 'audit.jsonl'), 'utf8')
  assert.ok(audit.includes('deprecated_use'))
})

test('alias: proxy_pool_refresh → trigger_collect / proxy_pool_get → sticky_bind（无 key E_SCHEMA）', async () => {
  const { poolDir, bus } = makeEnv({ aliases: PROXY_ALIASES })
  seedPool(poolDir)
  const rf = await bus.dispatch('', 'proxy_pool_refresh', {}, { actor: 'model' })
  assert.equal(rf.ok, true)
  assert.equal(rf.cmd, 'refresh')
  assert.equal(rf.data.status, 'collecting')
  const getNoKey = await bus.dispatch('', 'proxy_pool_get', {}, { actor: 'model' })
  assert.equal(getNoKey.ok, false)
  assert.equal(getNoKey.error.code, 'E_SCHEMA')
  await bus.dispatch('proxy', 'refresh', {}, { actor: 'script' })
  const get = await bus.dispatch('', 'proxy_pool_get', { sticky_key: 'sess' }, { actor: 'model' })
  assert.equal(get.ok, true)
  assert.equal(get.cmd, 'sticky_bind')
  assert.equal(get.data.sticky_key, 'sess')
})

// ---------------------------------------------------------------------------
// 6. 总线集成
// ---------------------------------------------------------------------------

test('总线集成: bus_status proxy registered:true + 命令/查询计数', async () => {
  const { bus } = makeEnv()
  const st = await bus.query('bus', 'status', {}, { actor: 'dashboard' })
  const p = st.data.domains.find((d) => d.domain === 'proxy')
  assert.ok(p)
  assert.equal(p.registered, true)
  assert.equal(p.commands, Object.keys(PROXY_MANIFEST.commands).length)
  assert.equal(p.queries, Object.keys(PROXY_MANIFEST.queries).length)
})
