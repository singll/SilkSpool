// ==============================================================================
// @silksec/ui-task 单测（16-dashboard P3 任务套件）
// 运行：node --test dsh-plugin-silksec-ui-task.client.test.mjs
//
// 目标（对齐 P3 验收）：
//   ① 注册/卸载幂等：sidebarRightTabs 类型 + keyed sidebar.right.pane.tab /
//      .title tab 体；apply 两次不重复、disposer 生效；tab 标题计数。
//   ② 会话头 utilities 注册；槽缺席静默不注册（会话面无全局影响）。
//   ③ 降级分支：sidebarRightTabs 缺席 → 主面板临时 tab（角标「降级」），不抛。
//   ④ 写操作等价：run_now/cancel/block/resume/schedule/create 分别走
//      taskRunNow/taskCancel/taskSetStatus×2/taskScheduleUpdate/taskCreate，
//      参数与主面板一致。
//   ⑤ 四区块渲染：定时任务卡片 / 一次性队列（表格 + 卡片双模式）/
//      工作区快块 / 执行历史（默认折叠）。
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
const BUNDLE = path.join(HERE, 'dsh-plugin-silksec-ui-task.client.js')
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

// ── 假 primitives（可选增强；P3 消费 Pill/StateDot/DisclosureRow/Tooltip + 图标） ─
function makePrimitives() {
  return {
    Modal: function Modal(props) { return createElement('modal-stub', props, props.children) },
    Tooltip: function Tooltip(props) { return createElement('tooltip-stub', props, props.children) },
    Pill: function Pill(props) { return createElement('pill-stub', props, props.children) },
    StateDot: function StateDot(props) { return createElement('statedot-stub', props) },
    DisclosureRow: function DisclosureRow(props) { return createElement('disclosure-stub', props, props.children) },
    IconAlarmClockOutline: function IconAlarmClockOutline(props) { return createElement('icon-alarm-stub', props) },
    IconQueueOutline: function IconQueueOutline(props) { return createElement('icon-queue-stub', props) },
    IconClockOutline: function IconClockOutline(props) { return createElement('icon-clock-stub', props) },
  }
}

// ── 假 ui-core ──────────────────────────────────────────────────────────────
function makeUiCore(opts = {}) {
  const rpcState = opts.rpcState || {}
  const health = {}
  const busHandlers = {}
  const busEmits = []
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
    if (ep && rpcState[ep]) return Object.assign({}, base, rpcState[ep])
    return base
  }
  const secUiBus = {
    on(name, fn) { (busHandlers[name] = busHandlers[name] || []).push(fn); return () => {} },
    off() {}, clear() {},
    emit(name, payload) { const l = busHandlers[name] || []; l.slice().forEach((fn) => fn(payload)); busEmits.push({ name, payload }); return l.length },
    count() { return Object.keys(busHandlers).length },
  }
  return {
    T: { brand: 'brand', label: 'label', label2: 'label2', label3: 'label3', warn: 'warn', error: 'error', success: 'success', business: 'business', border: 'border', border2: 'border2', border3: 'border3', base: 'base', layer1: 'layer1', layer2: 'layer2', layer3: 'layer3', hover: 'hover', skeleton: 'skeleton' },
    F: { xxxs: {}, xxs: {}, xxsStrong: {}, xs: {}, s: {}, sStrong: {}, baseStrong: {} },
    MONO: 'mono',
    styles: { pill: {}, th: {}, td: {}, tdMono: {}, tableStyle: {}, theadRow: {}, toolbar: {}, errorLine: {}, card: {}, pageT: {}, pageSub: {}, root: {}, header: {} },
    fmtTime: (x) => (x == null ? '—' : String(x)),
    fmtEvery: (s) => (s ? '每 ' + Math.round(s / 60) + ' 分钟' : '—'),
    fmtRel: (x) => (x ? 'in ' + x : ''),
    fmtDur: (x) => (x == null ? '—' : String(x)),
    fmtTs: (x) => (x == null ? '—' : String(x)),
    markSurfaceHealth(surface, status, detail) { health[surface] = { status, detail } },
    secUiBus,
    useRpc,
    SilksecErrorBoundary: function SilksecErrorBoundary(props) { return props.children },
    EmptyState: function EmptyState() {},
    opIcon: () => null,
    spoolIcon: () => null,
    TASK_STATUS_LABEL: { queued: '排队', running: '运行中', blocked: '阻塞', done: '完成', failed: '失败', cancelled: '取消' },
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

function makeSidebarRightTabs() {
  const defs = {}
  return { register(def) { defs[def.id] = def; return () => { delete defs[def.id] } }, __defs: defs }
}
function makeConnection(rpcCalls) {
  return { rpc: { call(route, endpoint, payload) { rpcCalls.push({ route, endpoint, payload }); return Promise.resolve({ ok: true, value: { rows: [], total: 0 } }) } } }
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
  const appended = []
  const sandbox = {
    window: {
      __ModuleLoader__: { load: (r) => { registration = r } },
      prompt: () => sandbox.__promptResult,
      confirm: () => sandbox.__confirmResult,
      alert: (msg) => { sandbox.__alerts.push(msg) },
    },
    document: {
      querySelector: () => null,
      createElement: () => ({ dataset: {}, style: {}, appendChild() {}, set textContent(_) {} }),
      head: { appendChild: (t) => appended.push(t) },
      body: { appendChild() {}, removeChild() {} },
    },
    console,
    Promise, setTimeout, clearTimeout, setInterval, clearInterval,
    __promptResult: '',
    __confirmResult: true,
    __alerts: [],
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(CODE, sandbox, { filename: BUNDLE })
  assert.ok(registration, 'bundle 必须经 window.__ModuleLoader__.load 注册')
  assert.equal(registration.id, '@silksec/ui-task')
  const mod = registration.factory((spec) => {
    if (spec === 'react') return React
    if (spec === '@silksec/ui-core') return uiCore
    if (spec === '@deepseek-ai/dsh-client-ui-primitives') {
      if (primitives === null) throw new Error('no primitives')
      return primitives
    }
    throw new Error('unexpected require: ' + spec)
  })
  return { mod, sandbox, appended }
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
function textOf(node) {
  if (node == null) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (node.$$el) return (node.children || []).map(textOf).join('')
  return ''
}
// 深入渲染版 textOf：就地物化函数组件（比 textOf 多走一层组件渲染）
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

const SCHEDULED = [
  { id: 16, program_id: 'meituan', phase: 'recon', objective: '每日资产侦察', schedule_kind: 'interval', every_seconds: 86400, next_run_at: Date.now() + 3600000, status: 'queued', run_count: 5, fail_count: 1, last_ok: 1, last_run_at: Date.now() - 3600000, session_id: 'sess-1' },
]
const QUEUE = [
  { id: 101, program_id: 'meituan', phase: 'vuln', objective: '验证 /api 未授权', status: 'running', session_id: 'sess-1' },
  { id: 102, program_id: 'bytedance', phase: 'recon', objective: '资产收集种子', status: 'queued', session_id: 'sess-2' },
]
const RUNS = [
  { id: 900, task_id: 16, ok: 1, note: '完成', started_at: 1700000000000, finished_at: 1700000060000, duration_ms: 60000, session_id: 'sess-1', objective: '每日资产侦察' },
]
const WORKSPACES = { available: true, items: [{ id: 'ws1', title: '美团 SRC', program: { id: 'meituan' }, tasks: 3, assets: 10, findings: 2 }] }
const CAMPAIGNS = [
  { id: 7, name: '美团SRC 持续挖掘', mode: 'single', status: 'active', autonomy: 1, program_ids: ['meituan'], budget_tokens: 2000000, spent_tokens: 350000, heartbeat_at: Date.now() - 3600000, decision_totals: { accepted: 3, rejected: 1, rework: 2, escalated: 0 }, objective: '覆盖+七类主粮', supply: { state: 'slow', factor: 0.4 } },
]

const FULL_RPC_STATE = {
  scheduledTasks: { data: { rows: SCHEDULED } },
  tasks: { data: { rows: QUEUE, total: QUEUE.length } },
  taskRuns: { data: { rows: RUNS, total: 1 } },
  workspaces: { data: WORKSPACES },
  campaigns: { data: { rows: CAMPAIGNS, total: 1 } },
  // 筛选选项的稳定来源（19-ui-unify 补丁）：即使某 program 当前无任务也保留筛选项
  programs: { data: [
    { id: 'meituan' }, { id: 'bytedance' }, { id: 'autohome' }, { id: 'didi' }, { id: 'pdd' },
  ] },
}

// ── ① 注册/卸载幂等 + tab 体/标题 + 标题计数 ─────────────────────────────────
test('注册：类型进 sidebarRightTabs、tab 体/标题进 keyed 槽（不静默）', () => {
  const uiCore = makeUiCore()
  const { mod } = loadBundle(uiCore, makePrimitives())
  const { slots, registered } = makeSlots(
    ['conversation.session.header.utilities', 'sidebar.right.pane.tab', 'sidebar.right.pane.tab.title'],
    ['conversation.session.header.utilities'])
  const tabs = makeSidebarRightTabs()
  const ctx = makeCtx({ slots, sidebarRightTabs: tabs })

  mod.apply(ctx)
  assert.ok(registered['sidebar.right.pane.tab:silksec-task-view'], 'tab 体必须挂 keyed sidebar.right.pane.tab（key=类型 id）')
  assert.ok(registered['sidebar.right.pane.tab.title:silksec-task-view'], 'tab 标题必须挂 keyed sidebar.right.pane.tab.title')
  assert.ok(registered['conversation.session.header.utilities:silksec-task-header'], '会话头计数必须挂 utilities list 槽')
  const def = tabs.__defs['silksec-task-view']
  assert.ok(def, '类型必须注册进 sidebarRightTabs')
  assert.equal(def.kind, 'silksec-task')
  assert.equal(def.priority, 'extension')
  assert.equal(typeof def.title, 'function')
  assert.ok(Array.isArray(def.guide) && def.guide.length === 1)
  assert.equal(uiCore.__health['ui-task'].status, 'ok')

  // 幂等：第二次 apply 不抛、注册数不增
  mod.apply(ctx)
  assert.equal(Object.keys(registered).length, 3)
  assert.equal(Object.keys(tabs.__defs).length, 1)
})

test('卸载：ctx.effect 返回的 disposer 全部生效（类型/tab 体/tab 标题/会话头回滚）', () => {
  const uiCore = makeUiCore()
  const { mod } = loadBundle(uiCore, makePrimitives())
  const { slots, registered } = makeSlots(
    ['conversation.session.header.utilities', 'sidebar.right.pane.tab', 'sidebar.right.pane.tab.title'],
    ['conversation.session.header.utilities'])
  const tabs = makeSidebarRightTabs()
  const ctx = makeCtx({ slots, sidebarRightTabs: tabs })
  mod.apply(ctx)
  assert.equal(Object.keys(registered).length, 3)
  ctx.__effects.forEach((d) => d())
  assert.equal(Object.keys(registered).length, 0, 'disposer 后无残留注册')
  assert.equal(Object.keys(tabs.__defs).length, 0, 'disposer 后类型注销')
})

test('标题计数：tab title thunk/组件每次渲染重读共享活跃计数', () => {
  const uiCore = makeUiCore()
  const { mod } = loadBundle(uiCore, makePrimitives())
  const tabs = makeSidebarRightTabs()
  const mod_tabs = tabs
  const { slots } = makeSlots(['sidebar.right.pane.tab', 'sidebar.right.pane.tab.title'], [])
  mod.apply(makeCtx({ slots, sidebarRightTabs: mod_tabs }))

  mod.taskStore.set({ activeCount: 3 })
  assert.equal(mod_tabs.__defs['silksec-task-view'].title(), '任务 · 3')
  assert.equal(textOf(mod.TaskTabTitle()), '任务 · 3')
  assert.equal(mod.taskLabel(0), '任务')
})

// ── ② 会话头 utilities：注册 + 本会话过滤 + 缺席降级 ──────────────────────────
test('会话头计数：按 sessionId 过滤 scheduled+active，图标钮 title 携带本会话数', () => {
  const uiCore = makeUiCore()
  const { mod } = loadBundle(uiCore, makePrimitives())
  mod.taskStore.set({ scheduled: SCHEDULED, active: QUEUE, activeCount: 3, loaded: true })
  const tree = mod.HeaderTaskCount({ sessionId: 'sess-1' })
  const btn = collect(tree, (n) => n.type === 'button' && n.props.className === 'silksec-icon-btn')[0]
  assert.ok(btn, '会话头必须渲染图标钮')
  assert.match(btn.props.title, /本会话任务 2 个/, 'sess-1 有 1 定时 + 1 队列 = 2')
  assert.match(btn.props.title, /运行中 1/)
})

test('会话头缺席：conversation 槽未声明 → 不注册、不抛（会话面无全局影响）', () => {
  const uiCore = makeUiCore()
  const { mod } = loadBundle(uiCore, makePrimitives())
  const { slots, registered } = makeSlots(['sidebar.right.pane.tab', 'sidebar.right.pane.tab.title'], [])
  assert.doesNotThrow(() => mod.apply(makeCtx({ slots, sidebarRightTabs: makeSidebarRightTabs() })))
  assert.ok(!Object.keys(registered).some((k) => k.indexOf('conversation.session.header.utilities') === 0), '缺席槽不得注册')
  assert.equal(uiCore.__health['ui-task'].status, 'ok', '其余面照常')
})

// ── ③ 降级分支 ───────────────────────────────────────────────────────────────
test('降级：sidebarRightTabs 缺席 → 主面板临时 tab（角标「降级」），不抛', () => {
  const uiCore = makeUiCore()
  const { mod } = loadBundle(uiCore, makePrimitives())
  const { slots } = makeSlots(['conversation.session.header.utilities'], ['conversation.session.header.utilities'])
  assert.doesNotThrow(() => mod.apply(makeCtx({ slots })))
  const degraded = uiCore.__registry.list().filter((e) => e.id === 'task-degraded')
  assert.equal(degraded.length, 1, '降级视图必须注册进 ui-core 注册表（供主面板渲染）')
  assert.match(degraded[0].label, /降级/)
  assert.equal(uiCore.__health['ui-task'].status, 'degraded')
})

test('降级：openTaskCenter 无右栏/无会话 seat → none（交 Modal 宿主），不抛', () => {
  const uiCore = makeUiCore()
  const { mod } = loadBundle(uiCore, makePrimitives())
  const { slots } = makeSlots([], [])
  mod.apply(makeCtx({ slots }))
  assert.equal(mod.openTaskCenter(), 'none', '无 sidebarRight 时返回 none（交由 Modal 宿主）')
  // 19-ui-unify 补丁：不再回退主面板 selectPanel（主面板无任务 tab，旧 'panel' 静默无效）
  const ctx2 = makeCtx({ slots: makeSlots([], []).slots, sidebarRightTabs: makeSidebarRightTabs(), sidebarRight: { openTab() { throw new Error('no mounted seat') } }, layout: makeLayout([]) })
  mod.apply(ctx2)
  assert.equal(mod.openTaskCenter(), 'none', '无会话 seat → none')
})

// ── ④ 写操作等价 ─────────────────────────────────────────────────────────────
test('写操作：run_now/cancel/block/resume/schedule/create 走主面板同端点同参数', async () => {
  const uiCore = makeUiCore()
  const { mod } = loadBundle(uiCore, makePrimitives())
  const calls = []
  const rpc = (endpoint, payload) => { calls.push({ endpoint, payload }); return Promise.resolve({ ok: true }) }
  await mod.taskAction(rpc, 'run_now', [9])
  await mod.taskAction(rpc, 'cancel', [9])
  await mod.taskAction(rpc, 'block', [9])
  await mod.taskAction(rpc, 'resume', [9])
  await mod.taskAction(rpc, 'schedule', [9, 3600])
  await mod.taskAction(rpc, 'create', [{ program_id: 'meituan', objective: 'x' }])
  assert.equal(calls[0].endpoint, 'taskRunNow'); assert.equal(calls[0].payload.id, 9)
  assert.equal(calls[1].endpoint, 'taskCancel'); assert.equal(calls[1].payload.id, 9)
  assert.equal(calls[2].endpoint, 'taskSetStatus'); assert.equal(JSON.stringify(calls[2].payload), JSON.stringify({ id: 9, status: 'blocked' }))
  assert.equal(calls[3].endpoint, 'taskSetStatus'); assert.equal(JSON.stringify(calls[3].payload), JSON.stringify({ id: 9, status: 'queued' }))
  assert.equal(calls[4].endpoint, 'taskScheduleUpdate'); assert.equal(JSON.stringify(calls[4].payload), JSON.stringify({ id: 9, schedule: { kind: 'interval', every_seconds: 3600 } }))
  assert.equal(calls[5].endpoint, 'taskCreate'); assert.equal(calls[5].payload.program_id, 'meituan')
})

test('写操作：未知 op / rpc 缺席 → reject 不抛同步异常', async () => {
  const uiCore = makeUiCore()
  const { mod } = loadBundle(uiCore, makePrimitives())
  await assert.rejects(() => mod.taskAction(() => Promise.resolve({}), 'bogus', []))
  await assert.rejects(() => mod.taskAction(null, 'run_now', [1]))
})

// ── ⑤ 四区块渲染 + 响应式双模式 ──────────────────────────────────────────────
test('四区块：定时卡片/队列表格+卡片双模式/工作区/执行历史 DisclosureRow', () => {
  const uiCore = makeUiCore({ rpcState: FULL_RPC_STATE })
  const { mod } = loadBundle(uiCore, makePrimitives())
  const tree = mod.TaskCenter({ rpc: () => Promise.resolve({}) })
  const text = deepText(tree)
  assert.match(text, /定时任务/, '区块一：定时任务')
  assert.match(text, /每日资产侦察/, '定时卡片渲染目标')
  assert.match(text, /一次性队列/, '区块二：一次性队列')
  assert.match(text, /验证 \/api 未授权/, '队列行渲染目标')
  assert.match(text, /工作区/, '区块三：工作区快块')
  assert.match(text, /执行历史/, '区块四：执行历史')
  // 双模式（表格在宽栏、卡片在窄栏，由 container query 切换）
  assert.ok(collect(tree, (n) => n.props && n.props.className === 'silksec-task-queue-table').length === 1, '必须有队列表格（宽栏）')
  assert.ok(collect(tree, (n) => n.props && n.props.className === 'silksec-task-queue-cards').length === 1, '必须有队列卡片（窄栏 <480px）')
  // program 筛选胶囊（.silksec-chip，19-ui-unify 补丁）：选项来自 workspaces ∪ programs，稳定不塌缩
  const chips = collect(tree, (n) => n.type === 'button' && n.props.className === 'silksec-chip')
  assert.ok(chips.length >= 6, '必须有「全部」+ 5 个 program 筛选胶囊（实际 ' + chips.length + '）')
  assert.ok(chips.some((c) => c.children[0] === '全部'), '含「全部」胶囊')
  // 写操作图标按钮（run_now/cancel/history）
  assert.ok(collect(tree, (n) => n.type === 'button' && n.props.className === 'silksec-icon-btn').length >= 2)
})

test('primitives 缺席：四区块仍可渲染（Pill/StateDot/DisclosureRow 走 ui-core 兜底）', () => {
  const uiCore = makeUiCore({ rpcState: FULL_RPC_STATE })
  const { mod } = loadBundle(uiCore, null)
  const { slots } = makeSlots(
    ['conversation.session.header.utilities', 'sidebar.right.pane.tab', 'sidebar.right.pane.tab.title'],
    ['conversation.session.header.utilities'])
  assert.doesNotThrow(() => mod.apply(makeCtx({ slots, sidebarRightTabs: makeSidebarRightTabs(), connection: makeConnection([]) })))
  assert.doesNotThrow(() => mod.TaskCenter({ rpc: () => Promise.resolve({}) }))
  assert.doesNotThrow(() => mod.TaskTabBody())
  assert.doesNotThrow(() => mod.TaskTabTitle())
  assert.doesNotThrow(() => mod.TaskDegradedView({ rpc: () => Promise.resolve({}) }))
})

// ── ⑥ 22 号方案 方案 A：专项区块（合并入任务视图） ──────────────────────────
test('专项区块：卡片渲染（状态/自主级别/验收计数/预算/心跳 + tick 按钮 + 点击过滤）', () => {
  const uiCore = makeUiCore({ rpcState: FULL_RPC_STATE })
  const { mod } = loadBundle(uiCore, makePrimitives())
  const tree = mod.TaskCenter({ rpc: () => Promise.resolve({}) })
  const text = deepText(tree)
  assert.match(text, /专项/, '任务视图必须含「专项」区块')
  assert.match(text, /美团SRC 持续挖掘/, '专项卡片渲染名称')
  assert.match(text, /L1/, '自主级别徽章')
  assert.match(text, /验收 3\/1\/2\/0/, '验收计数 accepted/rejected/rework/escalated')
  assert.match(text, /预算 350000\/2000000/, '预算条 spent/budget')
  assert.match(text, /供给 降速/, '23 号方案供给徽章（llm_throttled → 降速）')
  // 立即 tick 按钮（aria-label）
  const tickBtn = collect(tree, (n) => n.type === 'button' && n.props['aria-label'] === '立即 tick')[0]
  assert.ok(tickBtn, '专项卡片必须有「立即 tick」按钮')
  // 点击卡片触发专项过滤（回调把 campaign_id 传给 TaskCenter 状态；假 useState 不调 setter，仅验证回调存在且带正确 id）
  const card = collect(tree, (n) => n.props && n.props.className === 'silksec-row' && typeof n.props.onClick === 'function' && String(textOf(n)).includes('美团SRC 持续挖掘'))[0]
  assert.ok(card, '专项卡片必须可点击（过滤其派生任务）')
})

test('专项区块：队列行带专项归属 chip；campaigns 查询不可达 → 区块静默隐藏（降级链）', () => {
  const uiCore = makeUiCore({ rpcState: {
    ...FULL_RPC_STATE,
    tasks: { data: { rows: [{ ...QUEUE[0], campaign_id: 7, campaign_role: 'derived' }], total: 1 } },
  } })
  const { mod } = loadBundle(uiCore, makePrimitives())
  const tree = mod.TaskCenter({ rpc: () => Promise.resolve({}) })
  const chips = collect(tree, (n) => String(textOf(n)).startsWith('专项 美团SRC'))
  assert.ok(chips.length >= 1, '队列行必须带专项归属 chip（表格+卡片双模式至少一处）')
  // 降级：campaigns 无数据 → 区块不出现，其余区块不受影响
  const uiCore2 = makeUiCore({ rpcState: { ...FULL_RPC_STATE, campaigns: undefined } })
  const mod2 = loadBundle(uiCore2, makePrimitives()).mod
  const tree2 = mod2.TaskCenter({ rpc: () => Promise.resolve({}) })
  const text2 = deepText(tree2)
  assert.ok(!/验收 \d+\/\d+\/\d+\/\d+/.test(text2), 'campaigns 不可达时专项区块静默隐藏')
  assert.match(text2, /定时任务/, '其余区块不受影响')
})

test('专项 tick 写操作：走 campaignTickNow 端点（与主面板专项 tab 同端点）', async () => {
  const rpcCalls = []
  const uiCore = makeUiCore({ rpcState: FULL_RPC_STATE })
  const { mod } = loadBundle(uiCore, makePrimitives())
  const rpc = (endpoint, payload) => { rpcCalls.push({ endpoint, payload }); return Promise.resolve({}) }
  const tree = mod.TaskCenter({ rpc })
  const tickBtn = collect(tree, (n) => n.type === 'button' && n.props['aria-label'] === '立即 tick')[0]
  assert.ok(tickBtn, '立即 tick 按钮存在')
  tickBtn.props.onClick({ stopPropagation() {} })
  await new Promise((r) => setTimeout(r, 0))
  assert.ok(rpcCalls.some((c) => c.endpoint === 'campaignTickNow' && c.payload.id === 7), '必须调用 campaignTickNow（id=7）')
})
