// ==============================================================================
// @silksec/sec-dashboard-view-endpoint 单测（16-dashboard P6 接口域浏览视图）
// 运行：node --test dsh-plugin-sec-dashboard.view-endpoint.client.test.mjs
//
// 目标（对齐 P6 验收）：
//   ① apply 恰好注册一个 endpoints 条目（order 40 / domain endpoint / requires connection）
//      + surface 健康打卡 ok。
//   ② 卸载幂等：ctx.effect 返回的 disposer 生效，重复 apply / 重复 dispose 不残留。
//   ③ connection 缺席 → 静默不注册、不抛（tab 由 viewRegistry probe 隐藏）。
//   ④ 主机行渲染；展开明细经 endpoints {host, limit:100} 拉取；去资产视图跳链
//      navigate.select('assets', { q: host })；主查询走 endpointHosts。
//   ⑤ 缺失 ui-core / primitives / host 回退不抛。
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
const BUNDLE = path.join(HERE, 'dsh-plugin-sec-dashboard.view-endpoint.client.js')
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

// ── 假 ui-core（提供 bundle 使用的全部符号） ────────────────────────────────
function makeUiCore() {
  const health = {}
  const entries = Object.create(null)
  let listeners = []
  const pagedRows = {}
  const pagedCalls = []
  let sessionOpener = null
  function notify() { const l = listeners.slice(); l.forEach((fn) => fn(registry.list())) }
  const registry = {
    register(d) {
      entries[d.id] = {
        id: d.id, label: d.label || d.id, order: d.order === undefined ? 100 : d.order,
        domain: d.domain || null, source: d.source || null, requires: d.requires || [],
        component: d.component,
      }
      notify()
      return () => {
        const cur = entries[d.id]
        if (!cur) return false
        if (cur.component !== d.component) return false
        delete entries[d.id]; notify(); return true
      }
    },
    unregister(id) { if (!entries[id]) return false; delete entries[id]; notify(); return true },
    list() { return Object.keys(entries).map((k) => entries[k]).sort((a, b) => (a.order || 0) - (b.order || 0)) },
    get(id) { return entries[id] || null },
    has(id) { return !!entries[id] },
    subscribe(fn) { listeners.push(fn); return () => { listeners = listeners.filter((f) => f !== fn) } },
    refresh() { notify() },
    size() { return Object.keys(entries).length },
  }
  function usePagedQuery(endpoint, active, initialFilters, call) {
    pagedCalls.push({ endpoint, active, initialFilters, call })
    const rows = pagedRows[endpoint] || []
    return {
      q: '', setQ() {}, filters: initialFilters || {}, setFilter() {},
      page: 0, setPage() {}, size: 20, setSize() {},
      sort: '', dir: '', toggleSort() {},
      rows, total: rows.length, loading: false, error: null, filtered: false,
      reset() {}, reload() {}, refresh() {},
    }
  }
  const uiCore = {
    T: {
      label: 'label', label2: 'label2', label3: 'label3', warn: 'warn', error: 'error',
      success: 'success', business: 'business', border: 'border', border2: 'border2',
      border3: 'border3', base: 'base', layer1: 'layer1', layer2: 'layer2', layer3: 'layer3',
      hover: 'hover', brand: 'brand', skeleton: 'skeleton',
    },
    F: { xxxs: {}, xxs: {}, xxsStrong: {}, xs: {}, s: {}, sStrong: {}, baseStrong: {} },
    MONO: 'mono',
    styles: {
      pill: {}, th: {}, td: {}, tdMono: {}, tableStyle: {}, theadRow: {}, toolbar: {},
      errorLine: {}, stateLine: {}, card: {}, pageT: {}, pageSub: {}, root: {}, header: {}, pagerBar: {},
    },
    fmtTime: (x) => (x == null ? '—' : String(x)),
    fmtTs: (x) => (x == null ? '—' : String(x)),
    opIcon: () => null,
    spoolIcon: () => null,
    programCell: (pid) => React.createElement('span', null, pid || '—'),
    SkeletonRows: function SkeletonRows() { return React.createElement('div', null, 'skeleton') },
    EmptyState: function EmptyState() { return React.createElement('div', null, 'empty') },
    Toolbar: function Toolbar() { return null },
    Pager: function Pager() { return null },
    ViewBody: function ViewBody(props) {
      const q = props.query
      if (q.error) return React.createElement('div', null, '加载失败: ' + q.error)
      if (q.rows === null) return React.createElement('div', null, 'skeleton')
      if (!q.rows.length) return React.createElement('div', null, props.emptyText || 'empty')
      return props.children(q.rows)
    },
    SilksecErrorBoundary: function SilksecErrorBoundary(props) { return props.children },
    usePagedQuery,
    viewRegistry: registry,
    markSurfaceHealth(surface, status, detail) { health[surface] = { status, detail } },
    setSessionOpener(fn) { sessionOpener = typeof fn === 'function' ? fn : null },
    __health: health,
    __registry: registry,
    __pagedCalls: pagedCalls,
    __paged: (endpoint, rows) => { pagedRows[endpoint] = rows },
    __sessionOpener: () => sessionOpener,
  }
  return uiCore
}

// ── 假 connection / ctx ─────────────────────────────────────────────────────
function makeConnection(rpcCalls) {
  return {
    rpc: {
      call(route, endpoint, payload) {
        rpcCalls.push({ route, endpoint, payload })
        return Promise.resolve({ ok: true, value: { rows: [], total: 0 } })
      },
    },
  }
}
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

// ── bundle 物化 ─────────────────────────────────────────────────────────────
function loadBundle(uiCore) {
  let registration = null
  const sandbox = {
    window: { __ModuleLoader__: { load: (r) => { registration = r } } },
    console, Promise, setTimeout, clearTimeout, setInterval, clearInterval,
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(CODE, sandbox, { filename: BUNDLE })
  assert.ok(registration, 'bundle 必须经 window.__ModuleLoader__.load 注册')
  assert.equal(registration.id, '@silksec/sec-dashboard-view-endpoint')
  const mod = registration.factory((spec) => {
    if (spec === 'react') return React
    if (spec === '@silksec/ui-core') { if (uiCore === null) throw new Error('no ui-core'); return uiCore }
    throw new Error('unexpected require: ' + spec)
  })
  return { mod, sandbox }
}

// ── 元素树遍历（函数组件就地物化，模拟 React 渲染） ──────────────────────────
function collect(node, pred, out = []) {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) { node.forEach((n) => collect(n, pred, out)); return out }
  if (node.$$el) {
    if (typeof node.type === 'function') {
      let rendered = null
      try { rendered = node.type(node.props) } catch (e) { rendered = null }
      if (rendered) { collect(rendered, pred, out); return out }
    }
    if (pred(node)) out.push(node)
    ;(node.children || []).forEach((c) => collect(c, pred, out))
  }
  return out
}
function textOf(node) {
  if (node == null) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (node.$$el) return (node.children || []).map(textOf).join('')
  return ''
}

const HOSTS = [{ host: 'a.example.com', n: 3, methods: 'GET,POST', program_id: 'p1', last_seen: 1700000000000 }]

// ── ① apply 注册 ─────────────────────────────────────────────────────────────
test('apply 注册：恰好一个 endpoints 条目 order 40/domain endpoint + 健康 ok', () => {
  const uiCore = makeUiCore()
  const { mod } = loadBundle(uiCore)
  const rpcCalls = []
  const ctx = makeCtx({ connection: makeConnection(rpcCalls), sessions: { open() {} } })

  mod.apply(ctx)
  const list = uiCore.__registry.list()
  assert.equal(list.length, 1, '恰好注册一个视图')
  const entry = list[0]
  assert.equal(entry.id, 'endpoints')
  assert.equal(entry.label, '接口')
  assert.equal(entry.order, 40)
  assert.equal(entry.domain, 'endpoint')
  assert.equal(entry.source, 'dashboard-view-endpoint')
  assert.equal(entry.requires.length, 1)
  assert.equal(entry.requires[0], 'connection')
  assert.equal(typeof entry.component, 'function')
  assert.equal(uiCore.__health['sec-dashboard-view-endpoint'].status, 'ok')
  assert.equal(typeof uiCore.__sessionOpener(), 'function', 'sessionOpener 从 ctx.get(sessions) 注入')
})

// ── ② 卸载幂等 ───────────────────────────────────────────────────────────────
test('卸载幂等：disposer 生效且可重复调用；重复 apply 不重复注册', () => {
  const uiCore = makeUiCore()
  const { mod } = loadBundle(uiCore)
  const ctx = makeCtx({ connection: makeConnection([]) })

  mod.apply(ctx)
  mod.apply(ctx)
  assert.equal(uiCore.__registry.size(), 1, '重复 apply 以同 id 覆盖，不重复')
  assert.equal(ctx.__effects.length, 2)

  ctx.__effects.forEach((d) => { d(); d() })
  assert.equal(uiCore.__registry.size(), 0, 'disposer 后无残留注册')
})

// ── ③ connection 缺席 ────────────────────────────────────────────────────────
test('connection 缺席：静默不注册、不抛（tab 由 probe 隐藏）', () => {
  const uiCore = makeUiCore()
  const { mod } = loadBundle(uiCore)
  const ctx = makeCtx({ sessions: {} })
  assert.doesNotThrow(() => mod.apply(ctx))
  assert.equal(uiCore.__registry.size(), 0)
  assert.equal(uiCore.__health['sec-dashboard-view-endpoint'], undefined, '未注册不打健康卡')
})

// ── ④ 主机行渲染 + 展开拉取 + 跳链 ───────────────────────────────────────────
test('主机行渲染 + 展开端点拉取 {host,limit:100} + 跳资产视图 + 主查询 endpointHosts', () => {
  const uiCore = makeUiCore()
  uiCore.__paged('endpointHosts', HOSTS)
  const { mod } = loadBundle(uiCore)
  const rpcCalls = []
  const rpc = (endpoint, payload) => { rpcCalls.push({ endpoint, payload }); return Promise.resolve({ rows: [], total: 0 }) }
  const navCalls = []
  const nav = { select: (id, p) => navCalls.push({ id, p }) }

  const tree = mod.EndpointDomainView({
    rpc,
    workspaces: { items: [{ title: '项目一', program: { id: 'p1' } }, { title: '无授权', program: null }] },
    navigate: nav,
  })

  assert.ok(uiCore.__pagedCalls.some((c) => c.endpoint === 'endpointHosts' && c.active === true), '主查询走 endpointHosts')

  const rows = collect(tree, (n) => n.$$el && n.type === 'tr' && n.props && n.props.className === 'silksec-row')
  assert.equal(rows.length, 1, '应渲染一个主机行')
  assert.match(textOf(rows[0]), /a\.example\.com/, '行内渲染主机名')

  const navBtn = collect(tree, (n) => n.$$el && n.type === 'button' && n.props && n.props['aria-label'] === '去资产视图')
  assert.equal(navBtn.length, 1, '每行一个去资产视图按钮')
  navBtn[0].props.onClick()
  assert.equal(navCalls.length, 1, 'onPickHost 只跳转一次')
  assert.equal(navCalls[0].id, 'assets')
  assert.equal(navCalls[0].p.q, 'a.example.com', 'onPickHost → 资产视图搜索该主机')

  // 展开主机明细：EndpointListPanel 以 {host, limit:100} 拉 endpoints
  mod.EndpointListPanel({ host: 'a.example.com', callRpc: rpc })
  assert.ok(
    rpcCalls.some((c) => c.endpoint === 'endpoints' && c.payload.host === 'a.example.com' && c.payload.limit === 100),
    '展开明细必须调 endpoints {host, limit:100}',
  )
})

// ── ⑤ 缺失回退不抛 ───────────────────────────────────────────────────────────
test('缺失回退：无 ui-core / 无 workspaces / 无 rpc / 无 host 均不抛', () => {
  // ui-core 缺席：apply 静默返回
  const { mod: modNoCore } = loadBundle(null)
  assert.doesNotThrow(() => modNoCore.apply(makeCtx({ connection: makeConnection([]) })))

  const uiCore = makeUiCore()
  const { mod } = loadBundle(uiCore)
  assert.doesNotThrow(() => mod.EndpointRoot({}))
  assert.doesNotThrow(() => mod.EndpointDomainView({}))
  assert.doesNotThrow(() => mod.EndpointsView({ query: { rows: [], filters: {} } }))
  assert.doesNotThrow(() => mod.EndpointListPanel({}))
  assert.doesNotThrow(() => mod.EndpointListPanel({ host: undefined, callRpc: undefined }))
})
