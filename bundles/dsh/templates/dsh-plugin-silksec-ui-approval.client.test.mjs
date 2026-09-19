// ==============================================================================
// @silksec/ui-approval 单测（16-dashboard P2 审批套件）
// 运行：node --test dsh-plugin-silksec-ui-approval.client.test.mjs
//
// 目标（对齐 P2 验收）：
//   ① 注册/卸载幂等：shell.overlay 胶囊 + sidebarRightTabs 类型 + keyed
//      sidebar.right.pane.tab / .title tab 体；apply 两次不重复、disposer 生效。
//   ② 计数一致性：胶囊 N == approvalList.pending；tab title thunk 渲染期重读。
//   ③ 降级分支：sidebarRightTabs 缺席 → 主面板临时 tab（角标「降级」）；
//      shell.overlay 缺席 → secUiBus 徽章兜底；两者皆不抛。
//   ④ 审批路径等价：快捷批准/驳回走 approvalDecide RPC（同主面板端点与参数）。
//
// 客户端 bundle 是 `window.__ModuleLoader__.load` CJS factory 形态，无法 ESM import，
// 故用 node:vm + 假 React / 假 ui-core / 假 primitives / 假 slots 物化 factory，
// 直接验证真实产物。
// ==============================================================================

import { test } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BUNDLE = path.join(HERE, 'dsh-plugin-silksec-ui-approval.client.js')
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
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: (fn) => { if (typeof fn === 'function') fn() },
}

// ── 假 primitives（可选增强） ────────────────────────────────────────────────
function makePrimitives() {
  return {
    Modal: function Modal(props) { return createElement('modal-stub', props, props.children) },
    Tooltip: function Tooltip(props) { return createElement('tooltip-stub', props, props.children) },
    HoverCard: function HoverCard(props) { return createElement('hovercard-stub', props, props.anchor) },
    StateDot: function StateDot(props) { return createElement('statedot-stub', props) },
    RiskConfirmation: function RiskConfirmation(props) { return createElement('risk-stub', props) },
    IconWarningOutline: function IconWarningOutline(props) { return createElement('icon-warn-stub', props) },
    IconChecklistOutline: function IconChecklistOutline(props) { return createElement('icon-checklist-stub', props) },
  }
}

// ── 假 ui-core ──────────────────────────────────────────────────────────────
function makeUiCore(opts = {}) {
  const rpcState = opts.rpcState || {}
  const health = {}
  const busHandlers = {}
  let entries = {}
  let listeners = []
  function notify() { const l = listeners.slice(); l.forEach((fn) => fn(registry.list())) }
  const registry = {
    register(d) {
      entries[d.id] = { id: d.id, label: d.label || d.id, order: d.order === undefined ? 100 : d.order, component: d.component, domain: d.domain, source: d.source }
      notify()
      return () => { delete entries[d.id]; notify() }
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
    if (ep === 'approvalList') return Object.assign({}, base, rpcState.approvalList || {})
    if (ep === 'ops') return Object.assign({}, base, rpcState.ops || {})
    return base
  }
  const secUiBus = {
    on(name, fn) { (busHandlers[name] = busHandlers[name] || []).push(fn); return () => {} },
    off() {}, clear() {},
    emit(name, payload) { const l = busHandlers[name] || []; l.slice().forEach((fn) => fn(payload)); busEmits.push({ name, payload }); return l.length },
    count() { return Object.keys(busHandlers).length },
  }
  const busEmits = []
  return {
    T: { brand: 'brand', label: 'label', label2: 'label2', label3: 'label3', warn: 'warn', error: 'error', success: 'success', border: 'border', border2: 'border2', border3: 'border3', base: 'base', layer1: 'layer1', layer2: 'layer2', layer3: 'layer3', business: 'business', hover: 'hover', skeleton: 'skeleton' },
    F: { xxxs: {}, xxs: {}, xxsStrong: {}, xs: {}, s: {}, sStrong: {}, baseStrong: {} },
    MONO: 'mono',
    styles: { toolbar: {}, errorLine: {}, card: {}, pageT: {}, pageSub: {}, root: {}, header: {} },
    fmtTime: (x) => (x == null ? '—' : String(x)),
    fmtRel: () => '',
    markSurfaceHealth(surface, status, detail) { health[surface] = { status, detail } },
    secUiBus,
    useRpc,
    SilksecErrorBoundary: function SilksecErrorBoundary(props) { return props.children },
    EmptyState: function EmptyState() {},
    opIcon: () => null,
    spoolIcon: () => null,
    viewRegistry: registry,
    __health: health,
    __busEmits: busEmits,
    __registry: registry,
  }
}

// ── 假 slots ────────────────────────────────────────────────────────────────
function makeSlots(available, declared) {
  const registered = {}
  const slots = {
    spec(name) { return (declared || []).includes(name) ? { key: name } : undefined },
    inject(key, cb) {
      if (!available.includes(key)) return () => {}
      const d = cb()
      return () => { if (typeof d === 'function') d() }
    },
    register(cfg, comp) {
      const k = cfg.name + ':' + (cfg.key !== undefined ? cfg.key : cfg.id)
      registered[k] = { cfg, comp }
      return () => { delete registered[k] }
    },
  }
  return { slots, registered }
}

// ── 假 sidebarRightTabs / sidebarRight / connection / layout ────────────────
function makeSidebarRightTabs() {
  const defs = {}
  return { register(def) { defs[def.id] = def; return () => { delete defs[def.id] } }, __defs: defs }
}
function makeConnection(rpcCalls) {
  return { rpc: { call(route, endpoint, payload) { rpcCalls.push({ route, endpoint, payload }); return Promise.resolve({ ok: true, value: { rows: [], pending: 0 } }) } } }
}
function makeSidebarRight(openCalls) {
  return { openTab(kind) { openCalls.push(kind) } }
}
function makeLayout(selectCalls) {
  return { selectPanel(id) { selectCalls.push(id) } }
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
    console,
    Promise, setTimeout, clearTimeout, setInterval, clearInterval,
    __promptResult: '',
    __alerts: [],
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(CODE, sandbox, { filename: BUNDLE })
  assert.ok(registration, 'bundle 必须经 window.__ModuleLoader__.load 注册')
  assert.equal(registration.id, '@silksec/ui-approval')
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

// 递归收集元素树中满足谓词的节点（children 可含数组/嵌套；函数组件就地物化，模拟 React 渲染）
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

const PENDING_ROWS = [
  { id: 7, kind: 'scope-domain', subject: 'api.example.com', program_name: 'meituan', status: 'pending', evidence: '归属证据 30 字以上……', payload: JSON.stringify({ equity_basis: '控股', domain_level: 'subdomain' }), created_at: 1700000000000, requested_by: 'model' },
  { id: 8, kind: 'scope-wildcard', subject: 'example.com', program_name: 'meituan', status: 'pending', evidence: '主体核证级证据。', payload: JSON.stringify({ equity_basis: '全资', domain_level: 'apex' }), created_at: 1700000000000 },
  { id: 9, kind: 'scope-domain', subject: 'old.example.com', program_name: 'meituan', status: 'approved', evidence: '历史。', payload: null, created_at: 1690000000000, note: '已批' },
]

// ── ① 注册/卸载幂等 ──────────────────────────────────────────────────────────
test('注册：胶囊挂 shell.overlay、类型进 sidebarRightTabs、tab 体/标题进 keyed 槽（不静默）', () => {
  const uiCore = makeUiCore()
  const { mod } = loadBundle(uiCore, makePrimitives())
  const { slots, registered } = makeSlots(
    ['shell.overlay', 'sidebar.right.pane.tab', 'sidebar.right.pane.tab.title'],
    ['shell.overlay'])
  const tabs = makeSidebarRightTabs()
  const ctx = makeCtx({ slots, sidebarRightTabs: tabs })

  mod.apply(ctx)
  assert.ok(registered['shell.overlay:silksec-approval-capsule'], '胶囊必须挂 shell.overlay（list 槽用 id）')
  assert.ok(registered['sidebar.right.pane.tab:silksec-approval-view'], 'tab 体必须挂 keyed sidebar.right.pane.tab（key=类型 id）')
  assert.ok(registered['sidebar.right.pane.tab.title:silksec-approval-view'], 'tab 标题必须挂 keyed sidebar.right.pane.tab.title')
  assert.equal(Object.keys(registered).length, 3)
  const def = tabs.__defs['silksec-approval-view']
  assert.ok(def, '类型必须注册进 sidebarRightTabs')
  assert.equal(def.kind, 'silksec-approval')
  assert.equal(def.priority, 'extension')
  assert.equal(typeof def.title, 'function')
  assert.ok(Array.isArray(def.guide) && def.guide.length === 1)
  assert.equal(uiCore.__health['ui-approval'].status, 'ok')

  // 幂等：第二次 apply 不抛、注册数不增
  mod.apply(ctx)
  assert.equal(Object.keys(registered).length, 3)
  assert.equal(Object.keys(tabs.__defs).length, 1)
})

test('卸载：ctx.effect 返回的 disposer 全部生效（胶囊/类型/tab 体/tab 标题回滚）', () => {
  const uiCore = makeUiCore()
  const { mod } = loadBundle(uiCore, makePrimitives())
  const { slots, registered } = makeSlots(
    ['shell.overlay', 'sidebar.right.pane.tab', 'sidebar.right.pane.tab.title'],
    ['shell.overlay'])
  const tabs = makeSidebarRightTabs()
  const ctx = makeCtx({ slots, sidebarRightTabs: tabs })
  mod.apply(ctx)
  assert.equal(Object.keys(registered).length, 3)
  ctx.__effects.forEach((d) => d())
  assert.equal(Object.keys(registered).length, 0, 'disposer 后无残留注册')
  assert.equal(Object.keys(tabs.__defs).length, 0, 'disposer 后类型注销')
})

// ── ② 计数一致性 ─────────────────────────────────────────────────────────────
test('计数一致性：胶囊 N == approvalList.pending；tab title 重读共享计数', () => {
  const uiCore = makeUiCore({ rpcState: { approvalList: { data: { rows: PENDING_ROWS, pending: 2 } } } })
  const { mod } = loadBundle(uiCore, makePrimitives())
  const { slots } = makeSlots(['shell.overlay', 'sidebar.right.pane.tab', 'sidebar.right.pane.tab.title'], ['shell.overlay'])
  const tabs = makeSidebarRightTabs()
  mod.apply(makeCtx({ slots, sidebarRightTabs: tabs, connection: makeConnection([]) }))

  const tree = mod.ApprovalCapsule()
  const capsule = collect(tree, (n) => n.type === 'button' && n.props.className === 'silksec-approval-capsule')
  assert.equal(capsule.length, 1)
  assert.match(textOf(capsule[0]), /待审批 · 2/, '胶囊计数必须等于 approvalList.pending')
  // title thunk 渲染期重读同一计数（非 open 时快照）
  assert.equal(tabs.__defs['silksec-approval-view'].title(), '审批 · 2')
  // 动态标题组件同样读到同一计数
  assert.equal(textOf(mod.ApprovalTabTitle()), '审批 · 2')
  assert.equal(mod.pendingLabel(0), '审批')
})

// ── ③ 降级分支 ───────────────────────────────────────────────────────────────
test('降级：sidebarRightTabs 缺席 → 主面板临时 tab（角标「降级」），不抛', () => {
  const uiCore = makeUiCore()
  const { mod } = loadBundle(uiCore, makePrimitives())
  const { slots, registered } = makeSlots(['shell.overlay'], ['shell.overlay'])
  assert.doesNotThrow(() => mod.apply(makeCtx({ slots })))
  const degraded = uiCore.__registry.list().filter((e) => e.id === 'approval-degraded')
  assert.equal(degraded.length, 1, '降级视图必须注册进 ui-core 注册表（供主面板渲染）')
  assert.match(degraded[0].label, /降级/)
  assert.equal(uiCore.__health['ui-approval'].status, 'degraded')
  assert.ok(registered['shell.overlay:silksec-approval-capsule'], '胶囊仍须独立存活（root scope）')
})

test('降级：shell.overlay 缺席 → secUiBus 徽章兜底；openApprovalCenter 无右栏/主面板返回 none', async () => {
  const uiCore = makeUiCore()
  const { mod } = loadBundle(uiCore, makePrimitives())
  const { slots } = makeSlots([], []) // 无 shell.overlay 声明
  const rpcCalls = []
  const ctx = makeCtx({ slots, sidebarRightTabs: makeSidebarRightTabs(), connection: makeConnection(rpcCalls) })
  assert.doesNotThrow(() => mod.apply(ctx))
  // 徽章兜底：启动时即广播一次 approval:pending
  await new Promise((r) => setTimeout(r, 0))
  assert.ok(uiCore.__busEmits.some((e) => e.name === 'approval:pending'), 'shell.overlay 缺席必须经 secUiBus 广播计数')
  const rpcCalls2 = []
  const ctx2 = makeCtx({ slots: makeSlots([], []).slots, sidebarRightTabs: makeSidebarRightTabs(), connection: makeConnection(rpcCalls2) })
  mod.apply(ctx2)
  assert.equal(mod.openApprovalCenter(), 'none', '无 sidebarRight / layout 时打开审批中心返回 none（交由 Modal）')
  ctx.__effects.forEach((d) => d()); ctx2.__effects.forEach((d) => d())
})

test('降级：无会话 openTab 抛错 → openApprovalCenter 返回 none（交调用方 Modal），不抛', () => {
  const uiCore = makeUiCore()
  const { mod } = loadBundle(uiCore, makePrimitives())
  const selectCalls = []
  const { slots } = makeSlots(['shell.overlay'], ['shell.overlay'])
  const throwingSidebarRight = { openTab() { throw new Error('no mounted seat / session') } }
  mod.apply(makeCtx({
    slots,
    sidebarRightTabs: makeSidebarRightTabs(),
    sidebarRight: throwingSidebarRight,
    layout: makeLayout(selectCalls),
  }))
  // 19-ui-unify 补丁：不再回退主面板 selectPanel（主面板已无审批 tab，旧 'panel' 静默无效）
  assert.equal(mod.openApprovalCenter(), 'none', '无会话 seat → none，由调用方弹 Modal')
  assert.deepEqual(selectCalls, [], '不得回退主面板 selectPanel')
})

// ── ④ 审批路径等价（approvalDecide RPC；胶囊浮卡 / 审批中心共用 decideApproval） ─
test('快捷浮卡：pending 逐条批准/驳回，仅列 pending', () => {
  const uiCore = makeUiCore()
  const { mod } = loadBundle(uiCore, makePrimitives())
  const seen = []
  const card = mod.QuickCard({ rows: PENDING_ROWS, busy: false, onDecide: (row, d) => seen.push([row.id, d]), onOpenCenter: () => {}, onClose: () => {} })
  assert.match(textOf(card), /待审批（2）/, '快捷浮卡只统计 pending（approved 历史不入快捷卡）')
  const approve = collect(card, (n) => n.type === 'button' && n.children && n.children[0] === '批准')[0]
  const reject = collect(card, (n) => n.type === 'button' && n.children && n.children[0] === '驳回')[0]
  assert.ok(approve && reject, '快捷浮卡必须逐条提供批准/驳回')
  approve.props.onClick(); reject.props.onClick()
  assert.equal(JSON.stringify(seen), JSON.stringify([[7, 'approve'], [7, 'reject']]))
})

test('decideApproval：走 approvalDecide RPC（同主面板端点/参数；reject 可带备注）', async () => {
  const uiCore = makeUiCore()
  const { mod, sandbox } = loadBundle(uiCore, makePrimitives())
  const rpcCalls = []
  const rpc = (endpoint, payload) => { rpcCalls.push({ endpoint, payload }); return Promise.resolve({ ok: true, status: 'approved' }) }
  sandbox.__promptResult = '证据不足'
  await mod.decideApproval(rpc, PENDING_ROWS[0], 'approve', {})
  await mod.decideApproval(rpc, PENDING_ROWS[0], 'reject', { askNote: true })
  assert.equal(rpcCalls[0].endpoint, 'approvalDecide')
  assert.equal(JSON.stringify(rpcCalls[0].payload), JSON.stringify({ id: 7, decision: 'approve', note: '' }))
  assert.equal(JSON.stringify(rpcCalls[1].payload), JSON.stringify({ id: 7, decision: 'reject', note: '证据不足' }))
})

test('审批中心：批准/驳回按钮走 approvalDecide RPC（与胶囊路径同一写命令）', async () => {
  const uiCore = makeUiCore({ rpcState: { approvalList: { data: { rows: PENDING_ROWS, pending: 2 } } } })
  const { mod, sandbox } = loadBundle(uiCore, makePrimitives())
  sandbox.__promptResult = '证据不足'
  const rpcCalls = []
  const { slots } = makeSlots(['shell.overlay'], ['shell.overlay'])
  mod.apply(makeCtx({ slots, sidebarRightTabs: makeSidebarRightTabs(), connection: makeConnection(rpcCalls) }))
  const center = mod.ApprovalCenter()
  const reject = collect(center, (n) => n.type === 'button' && n.children && n.children[0] === '驳回')[0]
  assert.ok(reject, '审批中心必须渲染逐条驳回按钮')
  reject.props.onClick()
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
  const decide = rpcCalls.find((c) => c.endpoint === 'approvalDecide')
  assert.ok(decide)
  assert.equal(decide.route, '/silksec-dashboard')
  assert.equal(decide.payload.decision, 'reject')
  assert.equal(decide.payload.note, '证据不足')
})

// ── ⑤ 无 primitives 时可降级（不抛） ─────────────────────────────────────────
test('primitives 缺席：组件仍可渲染（工具/图标/dot 走 ui-core 兜底）', () => {
  const uiCore = makeUiCore({ rpcState: { approvalList: { data: { rows: PENDING_ROWS, pending: 2 } } } })
  const { mod } = loadBundle(uiCore, null)
  const { slots } = makeSlots(['shell.overlay', 'sidebar.right.pane.tab', 'sidebar.right.pane.tab.title'], ['shell.overlay'])
  assert.doesNotThrow(() => mod.apply(makeCtx({ slots, sidebarRightTabs: makeSidebarRightTabs(), connection: makeConnection([]) })))
  assert.doesNotThrow(() => mod.ApprovalCapsule())
  assert.doesNotThrow(() => mod.ApprovalCenter())
  assert.doesNotThrow(() => mod.ApprovalTabBody())
  assert.doesNotThrow(() => mod.ApprovalTabTitle())
  assert.doesNotThrow(() => mod.ApprovalDegradedView({ rpc: () => Promise.resolve({}) }))
})
