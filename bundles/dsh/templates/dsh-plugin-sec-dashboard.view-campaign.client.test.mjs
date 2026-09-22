// ==============================================================================
// @silksec/sec-dashboard-view-campaign 单测（22 号方案 §十二 专项视图）
// 运行：node --test dsh-plugin-sec-dashboard.view-campaign.client.test.mjs
//
// 目标：
//   (a) 注册恰好一条 campaign：order 60 / domain task / requires ['connection']，
//       并打卡 window.__silksecSurfaceHealth['sec-dashboard-view-campaign']=ok；
//   (b) 卸载幂等：ctx.effect 的 disposer 生效且重复调用不抛、无残留；
//   (c) connection 缺席：静默不注册（不抛、不打卡、不占 order）；
//   (d) 列表渲染：专项行八列 + 状态着色；点击行展开详情；
//   (e) 详情渲染：goal_spec/预算/验收账本/里程碑；tick 走 campaignTickNow 端点；
//   (f) primitives 缺席：加载/apply/渲染不抛。
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
const BUNDLE = path.join(HERE, 'dsh-plugin-sec-dashboard.view-campaign.client.js')
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

function makeUiCore(opts = {}) {
  const rpcState = opts.rpcState || {}
  const health = {}
  let entries = {}
  let listeners = []
  function notify() { listeners.slice().forEach((fn) => fn(registry.list())) }
  const registry = {
    register(d) {
      entries[d.id] = { id: d.id, label: d.label || d.id, order: d.order === undefined ? 100 : d.order, component: d.component, domain: d.domain, source: d.source, requires: d.requires || [] }
      notify()
      return () => { const cur = entries[d.id]; if (!cur || cur.component !== d.component) return false; delete entries[d.id]; notify(); return true }
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
    T: { label: 'label', label2: 'label2', label3: 'label3', border: 'border', border2: 'border2', border3: 'border3', base: 'base', layer1: 'layer1', layer2: 'layer2', layer3: 'layer3', hover: 'hover', brand: 'brand', business: 'business', success: 'success', warn: 'warn', error: 'error', skeleton: 'skeleton' },
    F: { xxxs: {}, xxs: {}, xxsStrong: {}, xs: {}, s: {}, sStrong: {}, baseStrong: {} },
    MONO: 'mono',
    styles: { pill: {}, th: {}, td: {}, tdMono: {}, tdClosed: {}, tableStyle: {}, theadRow: {}, toolbar: {}, errorLine: {}, pageSub: {}, card: {}, pageT: {}, root: {}, header: {}, stateLine: {}, tabBar: {}, body: {} },
    fmtTime: (x) => (x == null ? '—' : 'T' + String(x)),
    SkeletonRows: function SkeletonRows() {},
    EmptyState: function EmptyState() {},
    SilksecErrorBoundary: function SilksecErrorBoundary(props) { return props.children },
    setSessionOpener() {},
    openSession() {},
    markSurfaceHealth(surface, status, detail) { health[surface] = { status, detail, ts: Date.now() } },
    useRpc,
    viewRegistry: registry,
    __health: health,
    __registry: registry,
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

function makeConnection() {
  const calls = []
  return {
    __calls: calls,
    rpc: { call(route, endpoint, payload) { calls.push({ endpoint, payload }); return Promise.resolve({ ok: true, value: { rows: [], total: 0 } }) } },
  }
}

function loadBundle(uiCore, primitives) {
  let registration = null
  const sandbox = {
    window: { __ModuleLoader__: { load: (r) => { registration = r } } },
    document: { querySelector: () => null, createElement: () => ({ dataset: {}, style: {}, appendChild() {}, set textContent(_) {} }), head: { appendChild() {} }, body: { appendChild() {}, removeChild() {} } },
    console, Promise, setTimeout, clearTimeout, setInterval, clearInterval,
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(CODE, sandbox, { filename: BUNDLE })
  assert.ok(registration, 'bundle 必须经 window.__ModuleLoader__.load 注册')
  assert.equal(registration.id, '@silksec/sec-dashboard-view-campaign')
  const mod = registration.factory((spec) => {
    if (spec === 'react') return React
    if (spec === '@silksec/ui-core') return uiCore
    if (spec === '@deepseek-ai/dsh-client-ui-primitives') { if (primitives == null) throw new Error('no primitives'); return primitives }
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

const CAMPAIGN_ROWS = [
  { id: 1, name: 'src-深挖', mode: 'single', status: 'active', autonomy: 2, program_ids: ['test-src'], budget_tokens: 1000000, spent_tokens: 200000, heartbeat_at: 1700000000000, decision_totals: { accepted: 3, rejected: 1, rework: 0, escalated: 0 } },
  { id: 2, name: 'review-me', mode: 'cross', status: 'reviewing', autonomy: 1, program_ids: ['a', 'b'], budget_tokens: null, spent_tokens: 0, heartbeat_at: null, decision_totals: { accepted: 0, rejected: 0 } },
]
const DETAIL = {
  id: 1, name: 'src-深挖', mode: 'single', status: 'active', autonomy: 2, program_ids: ['test-src'],
  goal_spec: { objective: 'IDOR 覆盖推进', stop_conditions: ['confirmed ≥ 3', '预算耗尽'], targets: { confirmed_min: 3 } },
  budget_tokens: 1000000, spent_tokens: 200000, budget_window_days: 7, window_usage: { spent_tokens: 200000 },
  heartbeat_at: 1700000000000, last_tick_at: 1700000001000,
  decisions: [{ id: 9, task_id: 42, verdict: 'accepted', evidence: 'run:r1', decided_by: 'reviewer', created_at: 1700000002000 }],
  active_tasks: [{ id: 43, objective: '[假设 H2] idor @ a.test-src.com', status: 'queued', campaign_role: 'derived', program_id: 'test-src' }],
  checkpoints: [{ id: 1, kind: 'milestone', summary: '启动', created_at: 1700000003000 }],
}
const CAMP_STATE = { campaigns: { data: { rows: CAMPAIGN_ROWS, total: 2 } }, campaignGet: { data: DETAIL } }

test('注册：恰好一条 campaign（order 60/domain task/requires connection），health ok', () => {
  const uiCore = makeUiCore()
  const { mod } = loadBundle(uiCore, null)
  mod.apply(makeCtx({ connection: makeConnection() }))
  const list = uiCore.__registry.list()
  assert.equal(list.length, 1)
  assert.equal(list[0].id, 'campaign')
  assert.equal(list[0].label, '专项')
  assert.equal(list[0].order, 60)
  assert.equal(list[0].domain, 'task')
  assert.equal(JSON.stringify(list[0].requires), JSON.stringify(['connection']))
  assert.equal(list[0].source, 'dashboard-view-campaign')
  assert.equal(uiCore.__health['sec-dashboard-view-campaign'].status, 'ok')
})

test('卸载：ctx.effect disposer 生效且重复调用幂等无残留', () => {
  const uiCore = makeUiCore()
  const { mod } = loadBundle(uiCore, null)
  const ctx = makeCtx({ connection: makeConnection() })
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
  const { mod } = loadBundle(uiCore, null)
  const ctx = makeCtx({})
  assert.doesNotThrow(() => mod.apply(ctx))
  assert.equal(uiCore.__registry.size(), 0)
  assert.equal(uiCore.__health['sec-dashboard-view-campaign'], undefined)
})

test('列表渲染：八列 + 状态着色 + 立即 tick 按钮', () => {
  const uiCore = makeUiCore({ rpcState: CAMP_STATE })
  const { mod } = loadBundle(uiCore, null)
  const tree = mod.CampaignView({ rpc: () => Promise.resolve({}) })
  const thTexts = collect(tree, (n) => n.type === 'th').map(textOf)
  assert.deepEqual(thTexts, ['专项', '状态', '自主级别', '绑定 program', '验收(accepted/rejected)', '预算', '心跳', '操作'])
  const tds = collect(tree, (n) => n.type === 'td')
  const all = tds.map(textOf)
  assert.ok(all.some((t) => t.indexOf('#1 src-深挖') >= 0))
  assert.ok(all.includes('L2 有界自动'))
  assert.ok(all.includes('3/1'), '验收计数')
  const active = tds.find((n) => textOf(n) === 'active')
  assert.equal(active.props.style.color, uiCore.T.success)
  assert.ok(collect(tree, (n) => n.type === 'button').some((b) => textOf(b) === '立即 tick'))
})

test('降级：campaigns 查询不可达 → 只读降级提示，不抛', () => {
  const uiCore = makeUiCore({ rpcState: { campaigns: { error: 'bus down' } } })
  const { mod } = loadBundle(uiCore, null)
  let tree = null
  assert.doesNotThrow(() => { tree = mod.CampaignView({ rpc: () => Promise.resolve({}) }) })
  assert.ok(collect(tree, (n) => n.type === 'div').some((d) => textOf(d).indexOf('降级提示') >= 0))
})

test('详情渲染：goal_spec/预算/验收账本/里程碑 + 活跃子任务', () => {
  const uiCore = makeUiCore({ rpcState: CAMP_STATE })
  const { mod } = loadBundle(uiCore, null)
  const tree = mod.CampaignDetail({ id: 1, rpcCall: () => Promise.resolve({}) })
  const text = collect(tree, () => true).map(textOf).join('|')
  assert.ok(text.indexOf('IDOR 覆盖推进') >= 0)
  assert.ok(text.indexOf('confirmed ≥ 3') >= 0)
  assert.ok(text.indexOf('200000/1000000') >= 0)
  assert.ok(text.indexOf('run:r1') >= 0)
  assert.ok(text.indexOf('derived') >= 0)
  assert.ok(text.indexOf('milestone') >= 0)
})

test('tick：campaignTickNow 经 RPC 端点发出', async () => {
  const uiCore = makeUiCore({ rpcState: CAMP_STATE })
  const { mod } = loadBundle(uiCore, null)
  const calls = []
  const rpc = (endpoint, payload) => { calls.push({ endpoint, payload }); return Promise.resolve({}) }
  const view = mod.CampaignView({ rpc })
  const buttons = collect(view, (n) => n.type === 'button')
  const tickBtn = buttons.find((b) => textOf(b) === '立即 tick')
  assert.ok(tickBtn, '需要立即 tick 按钮')
  await tickBtn.props.onClick({ stopPropagation() {} })
  assert.equal(calls[0].endpoint, 'campaignTickNow')
  assert.equal(calls[0].payload.id, 1)
})

test('primitives 缺席：加载/apply/渲染均不抛', () => {
  const uiCore = makeUiCore({ rpcState: CAMP_STATE })
  const loaded = loadBundle(uiCore, null)
  assert.doesNotThrow(() => loaded.mod.apply(makeCtx({ connection: makeConnection() })))
  assert.doesNotThrow(() => loaded.mod.CampaignRoot({ rpc: () => Promise.resolve({}) }))
  assert.doesNotThrow(() => loaded.mod.CampaignView({ rpc: () => Promise.resolve({}) }))
})
