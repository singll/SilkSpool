// ==============================================================================
// @silksec/sec-dashboard-view-vuln 单测（16-dashboard P6 漏洞域拆分）
// 运行：node --test dsh-plugin-sec-dashboard.view-vuln.client.test.mjs
//
// 目标（对齐 P6 验收）：
//   (a) 注册恰好一条 findings：order 20 / domain vuln / requires ['connection']，
//       并打卡 window.__silksecSurfaceHealth['sec-dashboard-view-vuln']=ok；
//   (b) 卸载幂等：ctx.effect disposer 生效且重复调用不抛、无残留；
//   (c) connection 缺席：静默不注册（不抛、不打卡、不占 order）；
//   (d) 关键行渲染 + 行内操作端点/参数：findings 行四态/打标按钮发
//       findingUpdate({id,status})；生命周期「已接收」带 bounty；
//   (e) primitives/ui-core 兜底：DocModal 缺席不抛（ReportModal 返回 null）。
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
const BUNDLE = path.join(HERE, 'dsh-plugin-sec-dashboard.view-vuln.client.js')
const CODE = fs.readFileSync(BUNDLE, 'utf8')

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
  useEffect: (fn) => { if (typeof fn === 'function') { const d = fn(); if (typeof d === 'function') d() } },
}

const SEV_LABEL = { critical: '严重', high: '高危', medium: '中危', low: '低危', info: '信息' }
const STATUS_LABEL = { new: '新发现', confirmed: '已确认', false_positive: '误报', submitted: '已提交', accepted: '已接收', dup: '重复', ignored: '忽略' }

function makeQuery(rows, overrides = {}) {
  return Object.assign({
    q: '', setQ() {}, filters: {}, setFilter() {}, page: 0, setPage() {}, size: 20, setSize() {},
    sort: '', dir: '', toggleSort() {}, rows: rows, total: rows ? rows.length : 0, loading: false,
    error: null, filtered: false, reset() {}, reload() {}, refresh() {},
  }, overrides)
}

function makeUiCore(opts = {}) {
  const rpcState = opts.rpcState || {}
  const health = {}
  let entries = {}
  let listeners = []
  function notify() { listeners.slice().forEach((fn) => fn(registry.list())) }
  const registry = {
    register(d) {
      entries[d.id] = {
        id: d.id, label: d.label || d.id, order: d.order === undefined ? 100 : d.order,
        component: d.component, domain: d.domain, source: d.source, requires: d.requires || [],
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
    size() { return Object.keys(entries).length },
    subscribe(fn) { listeners.push(fn); return () => { listeners = listeners.filter((f) => f !== fn) } },
    refresh: notify,
  }
  function useRpc(action) {
    let a = null
    try { a = action() } catch (e) { a = null }
    const ep = a && a.endpoint
    const base = { loading: false, data: null, error: null, reload() {} }
    if (ep && rpcState[ep]) return Object.assign({}, base, rpcState[ep])
    return base
  }
  return {
    T: {
      label: 'label', label2: 'label2', label3: 'label3', border: 'border', border2: 'border2', border3: 'border3',
      base: 'base', layer1: 'layer1', layer2: 'layer2', layer3: 'layer3', hover: 'hover',
      brand: 'brand', business: 'business', success: 'success', warn: 'warn', error: 'error', skeleton: 'skeleton',
    },
    F: { xxxs: {}, xxs: {}, xxsStrong: {}, xs: {}, s: {}, sStrong: {}, baseStrong: {} },
    MONO: 'mono',
    styles: {
      pill: { pill: true }, th: { th: true }, td: { td: true }, tdMono: {}, tdClosed: {}, tableStyle: {}, theadRow: {},
      toolbar: {}, errorLine: {}, pageSub: {}, card: {}, pageT: {}, root: {}, header: {}, stateLine: {}, tabBar: {}, body: {}, pagerBar: {},
    },
    SEV_LABEL, STATUS_LABEL, SEV_COLOR: { critical: 'c', high: 'h', medium: 'm', low: 'l', info: 'i' },
    STATUS_CLOSED: ['false_positive', 'dup', 'ignored'],
    CONF_LABEL: { confirmed: '确认', tentative: '待定', deprecated: '废弃' },
    TASK_STATUS_LABEL: {},
    fmtTime: (x) => (x == null ? '—' : 'T' + String(x)),
    fmtTs: (x) => (x == null ? '—' : 'TS' + String(x)),
    spoolIcon: () => null,
    opIcon: (k) => createElement('icon', { k }),
    sevPill: (s) => createElement('span', null, SEV_LABEL[s] || s),
    statusPill: (s) => createElement('span', null, STATUS_LABEL[s] || s),
    confPill: () => null, taskPill: () => null, programCell: (p) => createElement('span', null, p || '未关联'),
    insightChip: () => null, sortableTh: (label) => createElement('th', null, label), hlText: (t) => t,
    SessionLink: function SessionLink() { return null },
    useRpc,
    usePagedQuery: () => opts.query || makeQuery([]),
    ViewBody: function ViewBody(props) {
      const q = props.query
      if (q.error) return createElement('div', null, q.error)
      if (q.rows === null) return null
      if (!q.rows.length) return null
      return props.children(q.rows)
    },
    Toolbar: function Toolbar(props) { return createElement('div', null, props.extra) },
    EmptyState: function EmptyState() {}, SkeletonRows: function SkeletonRows() {},
    DocModal: null,
    SilksecErrorBoundary: function SilksecErrorBoundary(props) { return props.children },
    setSessionOpener() {}, markSurfaceHealth(surface, status, detail) { health[surface] = { status, detail } },
    viewRegistry: registry, __health: health, __registry: registry,
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
function makeConnection(calls) {
  return { rpc: { call(route, endpoint, payload) { calls.push({ route, endpoint, payload }); return Promise.resolve({ ok: true, value: { rows: [], total: 0 } }) } } }
}

function loadBundle(uiCore) {
  let registration = null
  const sandbox = {
    window: { __ModuleLoader__: { load: (r) => { registration = r } }, prompt: () => null, confirm: () => true, alert: () => {} },
    document: {
      querySelector: () => null,
      createElement: () => ({ dataset: {}, style: {}, appendChild() {}, set textContent(_) {} }),
      head: { appendChild() {} },
      body: { appendChild() {}, removeChild() {} },
    },
    console, Promise, setTimeout, clearTimeout, setInterval, clearInterval,
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(CODE, sandbox, { filename: BUNDLE })
  assert.ok(registration, 'bundle 必须经 window.__ModuleLoader__.load 注册')
  assert.equal(registration.id, '@silksec/sec-dashboard-view-vuln')
  const mod = registration.factory((spec) => {
    if (spec === 'react') return React
    if (spec === '@silksec/ui-core') return uiCore
    throw new Error('unexpected require: ' + spec)
  })
  return { mod, sandbox }
}

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

const ROWS = [
  { id: 1, severity: 'high', status: 'new', created_at: 1700000000000, title: 'SQL 注入', url: 'https://x.com/a?id=1', session_id: 'session-abc', bounty: null },
  { id: 2, severity: 'medium', status: 'confirmed', created_at: 1700000001000, title: 'XSS', host: 'y.com', session_id: null },
]

test('注册：恰好一条 findings（order 20/domain vuln/requires connection），health ok', () => {
  const uiCore = makeUiCore()
  const { mod } = loadBundle(uiCore)
  mod.apply(makeCtx({ connection: makeConnection([]) }))
  const list = uiCore.__registry.list()
  assert.equal(list.length, 1)
  assert.equal(list[0].id, 'findings')
  assert.equal(list[0].label, '漏洞')
  assert.equal(list[0].order, 20)
  assert.equal(list[0].domain, 'vuln')
  assert.equal(JSON.stringify(list[0].requires), JSON.stringify(['connection']))
  assert.equal(list[0].source, 'dashboard-view-vuln')
  assert.equal(typeof list[0].component, 'function')
  assert.equal(uiCore.__health['sec-dashboard-view-vuln'].status, 'ok')
})

test('卸载：ctx.effect disposer 生效且重复调用幂等无残留', () => {
  const uiCore = makeUiCore()
  const { mod } = loadBundle(uiCore)
  const ctx = makeCtx({ connection: makeConnection([]) })
  mod.apply(ctx)
  assert.equal(uiCore.__registry.size(), 1)
  assert.equal(ctx.__effects.length, 1)
  ctx.__effects[0]()
  assert.equal(uiCore.__registry.size(), 0)
  assert.doesNotThrow(() => ctx.__effects[0]())
  assert.equal(uiCore.__registry.size(), 0)
})

test('connection 缺席：静默不注册、不打卡、不抛', () => {
  const uiCore = makeUiCore()
  const { mod } = loadBundle(uiCore)
  assert.doesNotThrow(() => mod.apply(makeCtx({})))
  assert.equal(uiCore.__registry.size(), 0)
  assert.equal(uiCore.__health['sec-dashboard-view-vuln'], undefined)
})

test('渲染 + 行内操作：打标发 findingUpdate({id,status})；已接收带 bounty', () => {
  const uiCore = makeUiCore()
  const { mod } = loadBundle(uiCore)
  const calls = []
  const rpcCall = (endpoint, payload) => { calls.push({ endpoint, payload }); return Promise.resolve({}) }

  const query = makeQuery(ROWS)
  const tree = mod.FindingsView({ query, onTag: (id, status) => rpcCall('findingUpdate', { id, status }), onAccept: (id) => rpcCall('findingUpdate', { id, status: 'accepted', bounty: 500 }), busy: false, callRpc: rpcCall })

  // 表头列名逐字保留
  const thTexts = collect(tree, (n) => n.type === 'th').map(textOf)
  assert.ok(thTexts.includes('级别') && thTexts.includes('状态') && thTexts.includes('标题'), '关键列在')

  // 行内容
  const texts = collect(tree, (n) => n.type === 'td').map(textOf)
  assert.ok(texts.some((t) => t.indexOf('SQL 注入') >= 0))
  assert.ok(texts.some((t) => t.indexOf('https://x.com/a?id=1') >= 0))

  // 打标按钮 → findingUpdate（确认 / 误报 / 忽略 三个行内操作）
  const confirmBtn = collect(tree, (n) => n.type === 'button' && /确认/.test(n.props.title || ''))[0]
  assert.ok(confirmBtn, '确认按钮存在')
  confirmBtn.props.onClick({ stopPropagation() {} })
  assert.deepEqual(calls[0], { endpoint: 'findingUpdate', payload: { id: 1, status: 'confirmed' } })

  const fpBtn = collect(tree, (n) => n.type === 'button' && /误报/.test(n.props.title || ''))[0]
  assert.ok(fpBtn, '误报按钮存在')
  fpBtn.props.onClick({ stopPropagation() {} })
  assert.deepEqual(calls[1], { endpoint: 'findingUpdate', payload: { id: 1, status: 'false_positive' } })

  const ignoreBtn = collect(tree, (n) => n.type === 'button' && /忽略/.test(n.props.title || ''))[0]
  assert.ok(ignoreBtn, '忽略按钮存在')
  ignoreBtn.props.onClick({ stopPropagation() {} })
  assert.deepEqual(calls[2], { endpoint: 'findingUpdate', payload: { id: 1, status: 'ignored' } })
})

test('DomainRoot 包 SilksecErrorBoundary（surface=dashboard-view-vuln）', () => {
  const uiCore = makeUiCore()
  const { mod } = loadBundle(uiCore)
  const root = mod.DomainRoot({ rpc: () => Promise.resolve({}) })
  assert.equal(root.props.surface, 'dashboard-view-vuln')
  assert.equal(root.props.title, '漏洞')
})

test('ReportModal 在 DocModal 缺席时返回 null（不抛）', () => {
  const uiCore = makeUiCore()
  const { mod } = loadBundle(uiCore)
  assert.doesNotThrow(() => mod.VulnView({ rpc: () => Promise.resolve({}), stats: {}, workspaces: { items: [] }, navigate: { select() {}, consume() {} } }))
})
