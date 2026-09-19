// ==============================================================================
// @silksec/sec-dashboard-view-fact 单测（16-dashboard P6 事实域视图拆分）
// 运行：node --test dsh-plugin-sec-dashboard.view-fact.client.test.mjs
//
// 目标（对齐 P6 验收）：
//   ① 注册：viewRegistry 登记唯一 facts 条目 order=50 / domain=fact / source、
//      requires=['connection']，surface 健康打卡 sec-dashboard-view-fact=ok。
//   ② 卸载幂等：ctx.effect disposer 生效，重复调用不抛且无残留。
//   ③ 能力缺席静默：connection 缺失 → 不注册、不抛。
//   ④ 渲染 + 写等价：事实卡行渲染；行内纠正/废弃分别走 factCorrect /
//      factDeprecate，参数与旧 PanelView facts 分支一致（prompt 取消即中止）。
//   ⑤ 依赖缺席兜底：primitives 不可用时视图仍可渲染，不抛。
//
// 客户端 bundle 是 `window.__ModuleLoader__.load` CJS factory 形态，无法 ESM import，
// 故用 node:vm + 假 React / 假 ui-core / 假 primitives 物化 factory，直接验证真实产物。
// ==============================================================================

import { test } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BUNDLE = path.join(HERE, 'dsh-plugin-sec-dashboard.view-fact.client.js')
const CODE = fs.readFileSync(BUNDLE, 'utf8')

// ── 假 React（children 同时并入 props.children，模拟 React 组件读取 children 的语义） ─
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

// ── 假 primitives（可选增强；本视图不消费 primitives，缺席应无影响） ────────────
function makePrimitives() {
  return {
    Modal: function Modal(props) { return createElement('modal-stub', props, props.children) },
  }
}

const FACT = {
  program_id: 'meituan',
  fact_key: 'target/login',
  category: 'target',
  confidence: 'confirmed',
  summary: '登录接口位于 /login，接受 JSON',
  edge_count: 2,
}
const FACT_STATS = {
  by_confidence: [{ confidence: 'confirmed', n: 1 }],
  by_category: [{ category: 'target', n: 1 }, { category: 'note', n: 3 }],
  by_mem_class: [{ mem_class: 'durable', n: 1 }],
  with_edges: 1,
  edges: 4,
  total: 4,
  pinned: 0,
}
const WORKSPACES = { available: true, items: [{ id: 'ws1', title: '美团 SRC', program: { id: 'meituan' } }] }

// ── 假 ui-core（提供本视图消费的每一个符号） ─────────────────────────────────
function makeUiCore(opts = {}) {
  const rpcState = opts.rpcState || {}
  const health = {}
  const opener = { fn: null }
  let entries = {}
  let listeners = []
  function notify() { const l = listeners.slice(); l.forEach((fn) => fn(registry.list())) }
  const registry = {
    register(d) {
      entries[d.id] = {
        id: d.id, label: d.label || d.id, order: d.order === undefined ? 100 : d.order,
        component: d.component, domain: d.domain, source: d.source, requires: d.requires || [],
      }
      notify()
      return () => {
        if (!entries[d.id]) return false
        if (entries[d.id].component !== d.component) return false
        delete entries[d.id]; notify(); return true
      }
    },
    list() { return Object.keys(entries).map((k) => entries[k]).sort((a, b) => (a.order || 0) - (b.order || 0)) },
    subscribe(fn) { listeners.push(fn); return () => { listeners = listeners.filter((f) => f !== fn) } },
    size() { return Object.keys(entries).length },
  }
  function useRpc(action) {
    let a = null
    try { a = action() } catch (e) { a = null }
    const ep = a && a.endpoint
    const base = { loading: false, data: null, error: null, reload() {} }
    if (ep && rpcState[ep]) return Object.assign({}, base, rpcState[ep])
    return base
  }
  function usePagedQuery() {
    return {
      q: '', setQ() {}, filters: {}, setFilter() {},
      page: 0, setPage() {}, size: 20, setSize() {},
      sort: '', dir: '', toggleSort() {},
      rows: opts.factsRows === undefined ? [] : opts.factsRows,
      total: opts.factsTotal === undefined ? (opts.factsRows || []).length : opts.factsTotal,
      loading: false, error: null, filtered: false,
      reload() {}, reset() {}, refresh() {},
    }
  }
  const styles = { pill: {}, card: {}, pageT: {}, pageSub: {}, root: {}, header: {}, toolbar: {}, errorLine: {} }
  return {
    T: { brand: 'brand', label: 'label', label2: 'label2', label3: 'label3', warn: 'warn', error: 'error', success: 'success', business: 'business', border: 'border', border2: 'border2', border3: 'border3', base: 'base', layer1: 'layer1', layer2: 'layer2', layer3: 'layer3', hover: 'hover', skeleton: 'skeleton' },
    F: { xxxs: {}, xxs: {}, xxsStrong: {}, xs: {}, s: {}, sStrong: {}, baseStrong: {} },
    MONO: 'mono',
    styles,
    SEV_COLOR: { critical: 'critical', high: 'high', medium: 'medium', low: 'low', info: 'info' },
    SEV_LABEL: { critical: '严重', high: '高危', medium: '中危', low: '低危', info: '信息' },
    CONF_LABEL: { confirmed: '确认', tentative: '待定', deprecated: '废弃' },
    MEM_CLASS_LABEL: { durable: '长期', ephemeral: '时效', timeline: '时间线' },
    fmtTs: (x) => (x == null ? '—' : String(x)),
    markSurfaceHealth(surface, status, detail) { health[surface] = { status, detail } },
    setSessionOpener(fn) { opener.fn = fn },
    openSession(id) { if (opener.fn) opener.fn(id) },
    opIcon: () => null,
    spoolIcon: () => null,
    insightChip: function insightChip(key, value, label, count, color, query, title) {
      return createElement('button', { className: 'silksec-btn', 'data-chip': key + '|' + value, title }, label + ' ' + count)
    },
    hlText: function hlText(text, term) { return text == null ? '' : String(text) },
    confPill: function confPill(conf) { return createElement('span', { 'data-conf': conf }, conf) },
    sevPill: (s) => createElement('span', null, s),
    statusPill: (s) => createElement('span', null, s),
    programCell: (p) => createElement('span', null, p),
    sortableTh: (l) => createElement('th', null, l),
    Toolbar: function Toolbar(props) { return createElement('toolbar-stub', { query: props.query, filters: props.filters }, props.extra) },
    EmptyState: function EmptyState(props) { return createElement('empty-stub', props, props.text) },
    SkeletonRows: function SkeletonRows() { return null },
    ViewBody: function ViewBody(props) {
      if (!props.query.rows || !props.query.rows.length) return createElement('empty-stub', props, props.emptyText)
      return createElement('viewbody-stub', null, props.children(props.query.rows))
    },
    SilksecErrorBoundary: function SilksecErrorBoundary(props) { return props.children },
    viewRegistry: registry,
    useRpc,
    usePagedQuery,
    __health: health,
    __opener: opener,
    __registry: registry,
  }
}

function makeConnection(rpcCalls) {
  return { rpc: { call(route, endpoint, payload) { rpcCalls.push({ route, endpoint, payload }); return Promise.resolve({ ok: true, value: { rows: [], total: 0 } }) } } }
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

function loadBundle(uiCore, primitives) {
  let registration = null
  const sandbox = {
    window: {
      __ModuleLoader__: { load: (r) => { registration = r } },
      prompt: () => sandbox.__promptResult,
      alert: (msg) => { sandbox.__alerts.push(msg) },
    },
    document: { querySelector: () => null },
    console,
    Promise, setTimeout, clearTimeout, setInterval, clearInterval,
    __promptResult: '',
    __alerts: [],
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(CODE, sandbox, { filename: BUNDLE })
  assert.ok(registration, 'bundle 必须经 window.__ModuleLoader__.load 注册')
  assert.equal(registration.id, '@silksec/sec-dashboard-view-fact')
  const mod = registration.factory((spec) => {
    if (spec === 'react') return React
    if (spec === '@silksec/ui-core') return uiCore
    if (spec === '@deepseek-ai/dsh-client-ui-primitives') {
      if (primitives === null) throw new Error('no primitives')
      return primitives
    }
    throw new Error('unexpected require: ' + spec)
  })
  return { mod, sandbox }
}

// 递归收集元素树中满足谓词的节点（函数组件就地物化，模拟 React 渲染）
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
const flush = () => new Promise((r) => setTimeout(r, 0))

// ── ① 注册 + 健康打卡 ────────────────────────────────────────────────────────
test('注册：viewRegistry 登记唯一 facts 条目（order=50/domain=fact/source）+ health ok', () => {
  const uiCore = makeUiCore()
  const { mod } = loadBundle(uiCore, makePrimitives())
  const ctx = makeCtx({ connection: makeConnection([]), sessions: { open() {} } })
  mod.apply(ctx)

  const list = uiCore.__registry.list()
  assert.equal(list.length, 1, '只登记一个视图条目')
  const entry = list[0]
  assert.equal(entry.id, 'facts')
  assert.equal(entry.label, '事实')
  assert.equal(entry.order, 50)
  assert.equal(entry.domain, 'fact')
  assert.equal(entry.source, 'dashboard-view-fact')
  assert.equal(JSON.stringify(entry.requires), JSON.stringify(['connection']))
  assert.equal(typeof entry.component, 'function')
  assert.equal(uiCore.__health['sec-dashboard-view-fact'].status, 'ok')
  assert.equal(typeof uiCore.__opener.fn, 'function', '应从 ctx.get(sessions) 装配会话 opener')
})

// ── ② 卸载幂等 ───────────────────────────────────────────────────────────────
test('卸载：disposer 生效且幂等（重复调用不抛、无残留）', () => {
  const uiCore = makeUiCore()
  const { mod } = loadBundle(uiCore, makePrimitives())
  const ctx = makeCtx({ connection: makeConnection([]) })
  mod.apply(ctx)
  assert.equal(uiCore.__registry.size(), 1)
  assert.equal(ctx.__effects.length, 1)
  ctx.__effects.forEach((d) => d())
  assert.equal(uiCore.__registry.size(), 0)
  assert.doesNotThrow(() => ctx.__effects.forEach((d) => d()), '重复卸载不抛')
  assert.equal(uiCore.__registry.size(), 0, '无残留')
})

// ── ③ connection 缺席静默 ─────────────────────────────────────────────────────
test('能力缺席：无 connection → 不注册、不抛（tab 静默隐藏）', () => {
  const uiCore = makeUiCore()
  const { mod } = loadBundle(uiCore, makePrimitives())
  const ctx = makeCtx({})
  assert.doesNotThrow(() => mod.apply(ctx))
  assert.equal(uiCore.__registry.size(), 0)
  assert.equal(uiCore.__health['sec-dashboard-view-fact'], undefined, '缺席不打卡')
})

// ── ④ 事实卡渲染 + 行内写操作端点/参数等价 ───────────────────────────────────
test('事实卡：渲染行 + 纠正/废弃分别走 factCorrect/factDeprecate（参数一致）', async () => {
  const uiCore = makeUiCore({ factsRows: [FACT], rpcState: { factStats: { data: FACT_STATS }, blackboard: { data: { rows: [] } } } })
  const { mod, sandbox } = loadBundle(uiCore, makePrimitives())

  const calls = []
  const rpc = (endpoint, payload) => { calls.push({ endpoint, payload }); return Promise.resolve({ ok: true }) }

  const tree = mod.FactView({ rpc, workspaces: WORKSPACES, stats: {} })
  const text = deepText(tree)
  assert.match(text, /target\/login/, '事实 key 必须渲染')
  assert.match(text, /登录接口位于 \/login/, '摘要必须渲染')
  assert.match(text, /遗留黑板/, '旧黑板分区保留')

  const correctBtn = collect(tree, (n) => n.$$el && n.type === 'button' && n.props.title === '纠正事实摘要')[0]
  const deprecateBtn = collect(tree, (n) => n.$$el && n.type === 'button' && n.props.title === '废弃事实（降置信为 deprecated，可再纠正恢复）')[0]
  assert.ok(correctBtn, '必须有纠正事实按钮')
  assert.ok(deprecateBtn, '必须有废弃事实按钮')

  // 纠正：prompt 返回新摘要 → factCorrect
  sandbox.__promptResult = '修订后的摘要'
  correctBtn.props.onClick()
  await flush()
  const correct = calls.find((c) => c.endpoint === 'factCorrect')
  assert.ok(correct, 'onCorrect 必须发 factCorrect')
  assert.equal(JSON.stringify(correct.payload), JSON.stringify({ program_id: 'meituan', fact_key: 'target/login', summary: '修订后的摘要' }))

  // 废弃：factDeprecate
  deprecateBtn.props.onClick()
  await flush()
  const dep = calls.find((c) => c.endpoint === 'factDeprecate')
  assert.ok(dep, 'onDeprecate 必须发 factDeprecate')
  assert.equal(JSON.stringify(dep.payload), JSON.stringify({ program_id: 'meituan', fact_key: 'target/login' }))
})

test('事实卡：prompt 取消（返回 null）→ 不发 factCorrect', async () => {
  const uiCore = makeUiCore({ factsRows: [FACT], rpcState: { factStats: { data: FACT_STATS }, blackboard: { data: { rows: [] } } } })
  const { mod, sandbox } = loadBundle(uiCore, makePrimitives())
  const calls = []
  const rpc = (endpoint, payload) => { calls.push({ endpoint, payload }); return Promise.resolve({ ok: true }) }
  const tree = mod.FactView({ rpc, workspaces: WORKSPACES, stats: {} })
  const correctBtn = collect(tree, (n) => n.$$el && n.type === 'button' && n.props.title === '纠正事实摘要')[0]
  sandbox.__promptResult = null
  correctBtn.props.onClick()
  await flush()
  assert.equal(calls.length, 0, '取消 prompt 必须中止写操作')
})

// ── ⑤ primitives 缺席兜底 ────────────────────────────────────────────────────
test('primitives 缺席：视图仍可渲染，不抛', () => {
  const uiCore = makeUiCore({ factsRows: [FACT], rpcState: { factStats: { data: FACT_STATS }, blackboard: { data: { rows: [] } } } })
  const { mod } = loadBundle(uiCore, null)
  const ctx = makeCtx({ connection: makeConnection([]) })
  assert.doesNotThrow(() => mod.apply(ctx))
  assert.equal(uiCore.__registry.size(), 1)
  assert.doesNotThrow(() => mod.FactRoot({ rpc: () => Promise.resolve({}), workspaces: WORKSPACES, stats: {} }))
  assert.doesNotThrow(() => mod.FactsView({ query: makeUiCore({ factsRows: [FACT] }).usePagedQuery(), stats: FACT_STATS, board: [], callRpc: () => Promise.resolve({}) }))
})
