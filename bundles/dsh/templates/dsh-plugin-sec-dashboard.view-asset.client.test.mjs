// ==============================================================================
// @silksec/sec-dashboard-view-asset 单测（19-ui-surface P6 资产域视图拆分）
// 运行：node --test dsh-plugin-sec-dashboard.view-asset.client.test.mjs
//
// 目标（对齐 P6 验收）：
//   ① apply：connection 就绪时注册且仅注册一个 assets 视图（order 30 / domain asset /
//      component 函数 / requires ['connection'] / source），health 打卡 ok。
//   ② 卸载幂等：ctx.effect 的 disposer 移除注册；重复调用不抛、无残留。
//   ③ 能力降级：connection 缺席 → 不注册、不抛（tab 经 requires 静默隐藏）。
//   ④ 渲染等价：Toolbar 五维筛选（level/accept/state/type/program_id）来自
//      stats.assets_by_type + workspaces；assets/assetOverview 端点；主机行渲染；
//      assetDetail / assetFamily 子面板走预期端点。
//   ⑤ primitives 缺席：不直接 require primitives，Toolbar/EmptyState 走 ui-core 兜底不抛。
//   ⑥ 零颜色字面量：源码不含 #hex / rgb() / rgba()。
//
// 客户端 bundle 是 `window.__ModuleLoader__.load` CJS factory 形态，无法 ESM import，
// 故用 node:vm + 假 React / 假 ui-core 物化 factory，直接验证真实产物。
// ==============================================================================

import { test } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BUNDLE = path.join(HERE, 'dsh-plugin-sec-dashboard.view-asset.client.js')
const CODE = fs.readFileSync(BUNDLE, 'utf8')

// ── 假 React ────────────────────────────────────────────────────────────────
function createElement(type, props, ...children) {
  const p = props || {}
  if (children.length === 1 && p.children === undefined) p.children = children[0]
  else if (children.length > 1 && p.children === undefined) p.children = children
  return { $$el: true, type, props: p, children }
}
const React = {
  createElement,
  Fragment: 'Fragment',
  useRef: (v) => ({ current: v }),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: (fn) => { if (typeof fn === 'function') fn() },
}

// ── 假 ui-core（提供 bundle 用到的全部符号） ─────────────────────────────────
function makeUiCore(opts = {}) {
  const health = {}
  const toolbarCalls = []
  const queryCalls = []
  const rpcActions = []
  const rows = opts.rows || []
  const overview = opts.overview || { total: 0, family_count: 0, by_level: {}, by_state: {}, by_accept: {}, families: [] }
  let entries = Object.create(null)
  let listeners = []

  function notify() { listeners.slice().forEach((fn) => { try { fn(registry.list()) } catch (e) {} }) }
  const registry = {
    register(d) {
      entries[d.id] = {
        id: d.id, label: d.label || d.id, order: d.order === undefined ? 100 : d.order,
        badge: d.badge || null, component: d.component, requires: d.requires || [],
        domain: d.domain || null, source: d.source || null,
      }
      notify()
      return () => { delete entries[d.id]; notify() }
    },
    unregister(id) { if (!entries[id]) return false; delete entries[id]; notify(); return true },
    get(id) { return entries[id] || null },
    has(id) { return !!entries[id] },
    list() { return Object.keys(entries).map((k) => entries[k]).sort((a, b) => (a.order || 0) - (b.order || 0)) },
    subscribe(fn) { listeners.push(fn); return () => { listeners = listeners.filter((f) => f !== fn) } },
    refresh() { notify() },
    size() { return Object.keys(entries).length },
  }

  function usePagedQuery(endpoint, active, initialFilters, call) {
    queryCalls.push({ endpoint, active, initialFilters, call })
    const state = {
      q: '', filters: {}, page: 0, size: 20, sort: '', dir: '',
      setQ(v) { state.q = v },
      setFilter(k, v) { if (v) state.filters[k] = v; else delete state.filters[k] },
      setPage(p) { state.page = p }, setSize(n) { state.size = n },
      toggleSort(c) { state.sort = c; state.dir = 'desc' },
      rows: active ? rows : null, total: rows.length, loading: false, error: null,
      reset() {}, reload() {}, refresh() { return Promise.resolve() },
    }
    return state
  }

  function useRpc(action) {
    let a = null
    try { a = action() } catch (e) { a = null }
    rpcActions.push(a)
    return { loading: false, data: overview, error: null, reload() {} }
  }

  const T = {
    label: 'label', label2: 'label2', label3: 'label3', border: 'border', border2: 'border2', border3: 'border3',
    base: 'base', layer1: 'layer1', layer2: 'layer2', layer3: 'layer3', hover: 'hover', brand: 'brand',
    business: 'business', success: 'success', warn: 'warn', error: 'error', skeleton: 'skeleton',
  }
  const F = { xxxs: {}, xxs: {}, xxsStrong: {}, xs: {}, s: {}, sStrong: {}, baseStrong: {} }
  const styles = {
    root: {}, header: {}, pageT: {}, pageSub: {}, silkDivider: {}, tabBar: {}, body: {}, card: {},
    cardL: {}, cardV: {}, stateLine: {}, errorLine: {}, pill: {}, th: {}, td: {}, tdClosed: {},
    tdMono: {}, tableStyle: {}, theadRow: {}, toolbar: {}, pagerBar: {},
  }

  return {
    T, F, MONO: 'mono', styles,
    SEV_COLOR: { critical: 'sev-critical', high: 'sev-high', medium: 'sev-medium', low: 'sev-low', info: 'sev-info' },
    SEV_LABEL: { critical: '严重', high: '高危', medium: '中危', low: '低危', info: '信息' },
    STATUS_LABEL: { new: '新发现', confirmed: '已确认', false_positive: '误报', submitted: '已提交', accepted: '已接收', dup: '重复', ignored: '忽略' },
    STATUS_CLOSED: ['false_positive', 'dup', 'ignored'],
    CONF_LABEL: { confirmed: '确认', tentative: '待定', deprecated: '废弃' },
    TASK_STATUS_LABEL: { queued: '排队', running: '运行中', blocked: '阻塞', done: '完成', failed: '失败', cancelled: '取消' },
    MEM_CLASS_LABEL: { durable: '长期', ephemeral: '时效', timeline: '时间线' },
    fmtTime: (x) => (x == null ? '—' : String(x)),
    fmtBytes: (x) => (x == null ? '—' : String(x)),
    fmtEvery: () => '—', fmtRel: () => '', fmtDur: (x) => (x == null ? '—' : String(x)), fmtTs: (x) => (x == null ? '—' : String(x)),
    spoolIcon: () => null, opIcon: () => null, mdBlocks: () => null,
    EmptyState: function EmptyState(props) { return createElement('div', { 'data-empty': true }, props.text) },
    SkeletonRows: function SkeletonRows() { return createElement('div', { 'data-skeleton': true }) },
    Toolbar: function Toolbar(props) { toolbarCalls.push(props); return createElement('div', { 'data-toolbar': true }, props.placeholder) },
    Pager: function Pager() { return null },
    ViewBody: function ViewBody(props) {
      const q = props.query
      if (q.error) return createElement('div', null, '加载失败: ' + q.error)
      if (q.rows === null || q.rows === undefined) return createElement('div', { 'data-skeleton': true })
      if (!q.rows.length) return createElement('div', { 'data-empty': true }, props.emptyText)
      return props.children(q.rows)
    },
    DocModal: function DocModal() { return null },
    sevPill: (s) => createElement('span', null, s),
    statusPill: (s) => createElement('span', null, s),
    confPill: (s) => createElement('span', null, s),
    taskPill: (s) => createElement('span', null, s),
    programCell: (pid) => createElement('span', null, pid || '未关联'),
    insightChip: (key, value, label, count) => createElement('button', { key: key + '|' + value }, label + ' ' + count),
    sortableTh: (label, col, query) => createElement('th', { style: styles.th }, label),
    hlText: (t) => String(t == null ? '' : t),
    SessionLink: function SessionLink() { return null },
    setSessionOpener(fn) { health.__sessionOpener = typeof fn === 'function' },
    viewRegistry: registry,
    useRpc,
    usePagedQuery,
    SilksecErrorBoundary: function SilksecErrorBoundary(props) { return props.children },
    markSurfaceHealth(surface, status, detail) { health[surface] = { status, detail } },
    __health: health,
    __registry: registry,
    __toolbarCalls: toolbarCalls,
    __queryCalls: queryCalls,
    __rpcActions: rpcActions,
  }
}

// ── 假 ctx / connection ──────────────────────────────────────────────────────
function makeCtx(services) {
  const effects = []
  function scopeOf() { return Object.assign({}, services) }
  return {
    __effects: effects,
    get: (n) => services[n] || null,
    effect(fn) { const d = fn(); if (typeof d === 'function') effects.push(d); return d },
    inject(deps, cb) { if (deps.every((d) => services[d])) return cb(scopeOf()); return () => {} },
  }
}
function makeConnection(calls) {
  return { rpc: { call(route, endpoint, payload) { calls.push({ route, endpoint, payload }); return Promise.resolve({ ok: true, value: {} }) } } }
}

function loadBundle(uiCore, opts = {}) {
  let registration = null
  const sandbox = {
    window: {
      __ModuleLoader__: { load: (r) => { registration = r } },
      alert() {}, prompt() { return '' }, confirm() { return true },
    },
    document: { createElement: () => ({ dataset: {}, style: {}, appendChild() {}, click() {} }), body: { appendChild() {}, removeChild() {} } },
    console,
    Promise, setTimeout, clearTimeout, setInterval, clearInterval,
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(CODE, sandbox, { filename: BUNDLE })
  assert.ok(registration, 'bundle 必须经 window.__ModuleLoader__.load 注册')
  assert.equal(registration.id, '@silksec/sec-dashboard-view-asset')
  const mod = registration.factory((spec) => {
    if (spec === 'react') return React
    if (spec === '@silksec/ui-core') return uiCore
    if (spec === '@deepseek-ai/dsh-client-ui-primitives') {
      if (opts.allowPrimitives) return { Modal: (p) => createElement('modal-stub', p) }
      throw new Error('primitives unavailable')
    }
    throw new Error('unexpected require: ' + spec)
  })
  return { mod, sandbox }
}

// 深入渲染版 textOf：就地物化函数组件
function deepText(node) {
  if (node == null) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(deepText).join('')
  if (node.$$el) {
    if (typeof node.type === 'function') {
      let rendered = null
      try { rendered = node.type(node.props) } catch (e) { rendered = null }
      return deepText(rendered)
    }
    return (node.children || []).map(deepText).join('')
  }
  return ''
}

const ROWS = [
  { host: 'a.example.com', level: 'A', score: 88, type: 'web', source: 'recon', program_id: 'p1', last_seen: 1700000000000 },
]
const OVERVIEW = {
  total: 1, family_count: 1,
  by_level: { A: 1 }, by_state: { new: 1 }, by_accept: { full: 1 },
  families: [{ root: 'example.com', kind: 'domain', host_count: 1, endpoint_count: 3, finding_count: 1, top_level: 'A', max_score: 88, last_seen: 1700000000000 }],
}

// ── ① apply：注册唯一 assets 视图 + health ok ───────────────────────────────
test('apply: connection 就绪注册唯一 assets 视图（order 30/domain asset/component 函数）+ health ok', () => {
  const uiCore = makeUiCore()
  const { mod } = loadBundle(uiCore)
  const ctx = makeCtx({ connection: makeConnection([]) })
  assert.doesNotThrow(() => mod.apply(ctx))
  const list = uiCore.__registry.list()
  assert.equal(list.length, 1, '仅注册一个视图')
  const e = list[0]
  assert.equal(e.id, 'assets')
  assert.equal(e.label, '资产')
  assert.equal(e.order, 30)
  assert.equal(e.domain, 'asset')
  assert.equal(typeof e.component, 'function')
  assert.equal(e.requires.length, 1)
  assert.equal(e.requires[0], 'connection')
  assert.equal(e.source, 'dashboard-view-asset')
  assert.equal(uiCore.__health['sec-dashboard-view-asset'].status, 'ok')
  assert.ok(!uiCore.__health.__sessionOpener, 'sessions 缺席不注入 opener')
})

// ── ② 卸载幂等 ──────────────────────────────────────────────────────────────
test('unload: ctx.effect disposer 移除注册，重复调用幂等不抛', () => {
  const uiCore = makeUiCore()
  const { mod } = loadBundle(uiCore)
  const ctx = makeCtx({ connection: makeConnection([]) })
  mod.apply(ctx)
  assert.equal(uiCore.__registry.size(), 1)
  ctx.__effects.forEach((d) => d())
  assert.equal(uiCore.__registry.size(), 0)
  assert.equal(uiCore.__registry.get('assets'), null)
  assert.doesNotThrow(() => ctx.__effects.forEach((d) => d()))
})

// ── ③ connection 缺席（requires 静默隐藏） ──────────────────────────────────
test('connection 缺席: 不注册、不抛', () => {
  const uiCore = makeUiCore()
  const { mod } = loadBundle(uiCore)
  const ctx = makeCtx({})
  assert.doesNotThrow(() => mod.apply(ctx))
  assert.equal(uiCore.__registry.size(), 0, 'requires 缺席须静默隐藏')
  assert.equal(ctx.__effects.length, 0)
})

// ── ④ 渲染 + 端点 + 筛选 + pending 消费 ─────────────────────────────────────
test('渲染: 主机行 + Toolbar 五维筛选（type/program 来自 props）+ assets/assetOverview 端点', () => {
  const uiCore = makeUiCore({ rows: ROWS, overview: OVERVIEW })
  const { mod } = loadBundle(uiCore)
  const navCalls = []
  const nav = { select: (id, opt) => navCalls.push({ id, opt }), consume: (id) => navCalls.push({ consume: id }) }
  const tree = mod.AssetDomainView({
    rpc: () => Promise.resolve({ rows: [], total: 0 }),
    stats: { assets_by_type: [{ type: 'web', n: 3 }] },
    workspaces: { items: [{ title: '项目甲', program: { id: 'p1' } }] },
    pending: null,
    navigate: nav,
  })
  assert.match(deepText(tree), /a\.example\.com/, '资产行必须渲染主机名')

  assert.equal(uiCore.__queryCalls[0].endpoint, 'assets')
  assert.equal(uiCore.__queryCalls[0].active, true)
  assert.equal(uiCore.__rpcActions[0].endpoint, 'assetOverview')

  assert.equal(uiCore.__toolbarCalls.length, 1)
  const flt = uiCore.__toolbarCalls[0].filters
  assert.equal(Array.from(flt, (f) => f.key).join(','), 'level,accept,state,type,program_id')
  assert.equal(flt[3].options[0].v, 'web')
  assert.equal(flt[3].options[0].l, 'web (3)')
  assert.equal(flt[4].options[0].v, 'p1')
})

test('pending: 挂载一次性应用 q/filters 并 nav.consume(assets)', () => {
  const uiCore = makeUiCore({ rows: [], overview: OVERVIEW })
  const { mod } = loadBundle(uiCore)
  const navCalls = []
  mod.AssetDomainView({
    rpc: () => Promise.resolve({ rows: [], total: 0 }),
    pending: { q: 'example.com', filters: { level: 'A', state: 'new' } },
    navigate: { select: () => {}, consume: (id) => navCalls.push(id) },
  })
  const q = uiCore.__queryCalls[0]
  // fake usePagedQuery 返回的对象被 bundle 用于 setQ/setFilter；此处直接断言调用不抛即可，
  // 通过 nav.consume 验证消费发生。
  assert.ok(q, '必须先建立 assets 查询')
  assert.deepEqual(navCalls, ['assets'], 'pending 应用后须 consume assets')
})

test('子面板端点: AssetDetailPanel→assetDetail, FamilyHostsPanel→assetFamily', () => {
  const uiCore = makeUiCore()
  const { mod } = loadBundle(uiCore)
  const rec = []
  const callRpc = (endpoint, payload) => { rec.push({ endpoint, payload }); return Promise.resolve({}) }
  mod.AssetDetailPanel({ host: 'a.example.com', callRpc, onPickHost() {}, onFindings() {} })
  mod.FamilyHostsPanel({ root: 'example.com', hostCount: 1, callRpc, onPickHost() {} })
  assert.equal(rec[0].endpoint, 'assetDetail')
  assert.equal(rec[0].payload.host, 'a.example.com')
  assert.equal(rec[1].endpoint, 'assetFamily')
  assert.equal(rec[1].payload.root, 'example.com')
})

// ── ⑤ primitives 缺席：Toolbar/EmptyState 走 ui-core 兜底 ────────────────────
test('primitives 缺席: 不直接 require，Toolbar/EmptyState 兜底不抛', () => {
  const uiCore = makeUiCore({ rows: [], overview: OVERVIEW })
  const { mod } = loadBundle(uiCore, { allowPrimitives: false })
  const ctx = makeCtx({ connection: makeConnection([]) })
  assert.doesNotThrow(() => mod.apply(ctx))
  assert.doesNotThrow(() => mod.AssetDomainView({ rpc: () => Promise.resolve({ rows: [], total: 0 }), stats: {}, workspaces: null, pending: null, navigate: null }))
  assert.doesNotThrow(() => mod.AssetsView({ query: { q: '', filters: {}, rows: [], error: null }, overview: {}, rpc: () => Promise.resolve({}) }))
})

// ── ⑥ 零颜色字面量 ──────────────────────────────────────────────────────────
test('零颜色字面量: 源码不含 #hex / rgb() / rgba()', () => {
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(CODE), '不得含 #hex 颜色字面量')
  assert.ok(!/\brgba?\s*\(/.test(CODE), '不得含 rgb()/rgba() 颜色字面量')
})
