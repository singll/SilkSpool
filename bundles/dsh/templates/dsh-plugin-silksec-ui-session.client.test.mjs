// ==============================================================================
// @silksec/ui-session 单测（16-dashboard P5 会话内绑定）
// 运行：node --test dsh-plugin-silksec-ui-session.client.test.mjs
//
// 目标（对齐 P5 验收）：
//   ① 注册/卸载幂等：conversation.view（ViewTab{id,label}）+ header utilities +
//      assistant-actions 三处 additive 注册；apply 两次不重复、disposer 生效。
//   ② 会话头钮按 sessionId 过滤计数（本会话 findings + facts）。
//   ③ assistant-actions 每 messageId 渲染两个动作（登记候选漏洞 / 沉淀事实）。
//   ④ 槽缺席 → 不注册、不抛（不改变主面板；health=degraded）。
//   ⑤ 写操作端点/参数正确（vuln.register_candidate / fact.upsert）且经 /silksec-domain 路由。
//   ⑥ primitives 缺席兜底：视图/头钮/动作/Modal 均不抛。
//   ⑦ 按 session_id 过滤正确性：两会话数据交叉，各视图只出本会话产出。
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
const BUNDLE = path.join(HERE, 'dsh-plugin-silksec-ui-session.client.js')
const CODE = fs.readFileSync(BUNDLE, 'utf8')

// ── 假 React ─────────────────────────────────────────────────────────────────
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

// ── 假 primitives（可选增强；null = 缺席） ────────────────────────────────────
function makePrimitives() {
  return {
    Modal: function Modal(props) { return createElement('modal-stub', props, props.children) },
    RiskConfirmation: function RiskConfirmation(props) { return createElement('risk-stub', props, props.children) },
    Tooltip: function Tooltip(props) { return createElement('tooltip-stub', props, props.children) },
    IconChecklistOutline: function IconChecklistOutline(props) { return createElement('checklist-icon', props) },
  }
}

// ── 假 ui-core ───────────────────────────────────────────────────────────────
function makeUiCore(opts = {}) {
  const rpcState = opts.rpcState || {}
  const health = {}
  const entries = {}
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
  return {
    T: { brand: 'brand', label: 'label', label2: 'label2', label3: 'label3', warn: 'warn', error: 'error', success: 'success', business: 'business', border: 'border', border2: 'border2', border3: 'border3', base: 'base', layer1: 'layer1', layer2: 'layer2', layer3: 'layer3', hover: 'hover', skeleton: 'skeleton' },
    F: { xxxs: {}, xxs: {}, xxsStrong: {}, xs: {}, s: {}, sStrong: {}, baseStrong: {} },
    MONO: 'mono',
    styles: { pill: {}, th: {}, td: {}, tdMono: {}, tableStyle: {}, theadRow: {}, toolbar: {}, errorLine: {}, card: {}, pageT: {}, pageSub: {}, root: {}, header: {} },
    fmtTs: (x) => (x == null ? '—' : String(x)),
    fmtRel: (x) => (x ? 'rel' : ''),
    SEV_LABEL: { critical: '严重', high: '高危', medium: '中危', low: '低危', info: '信息' },
    SEV_COLOR: { critical: 'c', high: 'h', medium: 'm', low: 'l', info: 'i' },
    STATUS_LABEL: { new: '新发现', confirmed: '已确认', false_positive: '误报', submitted: '已提交', accepted: '已接收', dup: '重复', ignored: '忽略' },
    CONF_LABEL: { confirmed: '确认', tentative: '待定', deprecated: '废弃' },
    TASK_STATUS_LABEL: { queued: '排队', running: '运行中', blocked: '阻塞', done: '完成', failed: '失败', cancelled: '取消' },
    markSurfaceHealth(surface, status, detail) { health[surface] = { status, detail } },
    useRpc,
    secUiBus: { emit() {}, on() { return () => {} }, off() {} },
    SilksecErrorBoundary: function SilksecErrorBoundary(props) { return props.children },
    opIcon: () => null,
    spoolIcon: () => null,
    viewRegistry: registry,
    __health: health,
    __registry: registry,
  }
}

// ── 假 slots ─────────────────────────────────────────────────────────────────
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

function makeConnection(rpcCalls) {
  return {
    rpc: {
      call(route, endpoint, payload) {
        rpcCalls.push({ route, endpoint, payload })
        return Promise.resolve({ ok: true, value: { ok: true, rows: [] } })
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
  assert.equal(registration.id, '@silksec/ui-session')
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

// 递归收集元素树中满足谓词的节点（函数组件就地物化）
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

// ── 样品数据：两个会话交叉（s1 / s2） ────────────────────────────────────────
const FINDINGS = [
  { id: 341, title: 'S1 未授权访问', severity: 'high', host: 'api.s1.com', status: 'new', noise: 0, session_id: 's1', created_at: 1700000000000 },
  { id: 342, title: 'S1 候选注入', severity: 'info', host: 'x.s1.com', status: 'new', noise: 1, session_id: 's1', created_at: 1700000060000 },
  { id: 350, title: 'S2 越权', severity: 'medium', host: 'api.s2.com', status: 'confirmed', noise: 0, session_id: 's2', created_at: 1700000100000 },
  { id: 351, title: '无归属历史行', severity: 'low', host: 'legacy.com', status: 'new', noise: 0, session_id: null, created_at: 1700000200000 },
]
const FACTS = [
  { program_id: 'meituan', fact_key: 'auth/s1-token', category: 'auth', summary: 'S1 令牌机制', confidence: 'tentative', mem_class: 'durable', source: 'dashboard:session:s1', updated_at: 1700000000000 },
  { program_id: 'meituan', fact_key: 'note/s2-note', category: 'note', summary: 'S2 工作速记', confidence: 'tentative', mem_class: 'ephemeral', source: 'dashboard:session:s2', updated_at: 1700000000000 },
  { program_id: 'meituan', fact_key: 'env/legacy', category: 'env', summary: '历史无归属', confidence: 'confirmed', mem_class: 'durable', source: 'fgs-persist', updated_at: 1700000000000 },
]
const TASKS = [
  { id: 16, program_id: 'meituan', objective: 'S1 定时侦察', status: 'queued', session_id: 's1', next_run_at: Date.now() + 3600000 },
  { id: 101, program_id: 'meituan', objective: 'S2 队列任务', status: 'running', session_id: 's2' },
]
const RUNS = [
  { id: 900, task_id: 16, ok: 1, note: 'S1 执行完成', session_id: 's1', finished_at: 1700000060000 },
  { id: 901, task_id: 101, ok: 0, note: 'S2 执行失败', session_id: 's2', finished_at: 1700000060000 },
]
const PROGRAMS = [{ name: 'meituan', platform: '美团 SRC' }]

const FULL_RPC_STATE = {
  findings: { data: { rows: FINDINGS, total: FINDINGS.length } },
  facts: { data: { rows: FACTS, total: FACTS.length } },
  tasks: { data: { rows: TASKS, total: TASKS.length } },
  scheduledTasks: { data: { rows: [] } },
  taskRuns: { data: { rows: RUNS, total: RUNS.length } },
  programs: { data: PROGRAMS },
}

function primeStore(mod) {
  mod.sessionStore.set({ findings: FINDINGS, facts: FACTS, tasks: TASKS, runs: RUNS, loaded: true, updatedAt: Date.now() })
}

// ── ① 注册/卸载幂等 + 三处 additive 绑定 ─────────────────────────────────────
test('注册：conversation.view ViewTab + header utilities + assistant-actions 三处 additive', () => {
  const uiCore = makeUiCore()
  const { mod } = loadBundle(uiCore, makePrimitives())
  const available = ['conversation.view', 'conversation.session.header.utilities', 'conversation.chat.assistant-actions']
  const { slots, registered } = makeSlots(available, available)
  const ctx = makeCtx({ slots })

  mod.apply(ctx)
  assert.ok(registered['conversation.view:silksec-security'], '必须挂 conversation.view（list/session）')
  assert.ok(registered['conversation.session.header.utilities:silksec-security-header'], '必须挂会话头 utilities')
  assert.ok(registered['conversation.chat.assistant-actions:silksec-message-actions'], '必须挂 assistant-actions（additive）')
  // ViewTab{id,label} 由 options 投影：id + label 函数
  const vdef = registered['conversation.view:silksec-security'].cfg
  assert.equal(vdef.id, mod.VIEW_ID)
  assert.equal(vdef.order, 60)
  assert.equal(typeof vdef.label, 'function')
  assert.equal(vdef.label(), '安全产出')
  // 绝不碰 chain 槽 conversation.chat.turnTail
  assert.ok(!Object.keys(registered).some((k) => k.indexOf('conversation.chat.turnTail') === 0), '禁止碰 turnTail chain 槽')
  assert.equal(uiCore.__health['ui-session'].status, 'ok')

  // 幂等：第二次 apply 不抛、注册数不增
  mod.apply(ctx)
  assert.equal(Object.keys(registered).length, 3)
})

test('卸载：ctx.effect 返回的 disposer 生效（三处回滚）', () => {
  const uiCore = makeUiCore()
  const { mod } = loadBundle(uiCore, makePrimitives())
  const available = ['conversation.view', 'conversation.session.header.utilities', 'conversation.chat.assistant-actions']
  const { slots, registered } = makeSlots(available, available)
  const ctx = makeCtx({ slots })
  mod.apply(ctx)
  assert.equal(Object.keys(registered).length, 3)
  ctx.__effects.forEach((d) => d())
  assert.equal(Object.keys(registered).length, 0, 'disposer 后无残留注册')
})

// ── ② 会话头钮按 sessionId 过滤计数 ──────────────────────────────────────────
test('会话头计数：按 sessionId 过滤本会话 findings + facts（s1）', () => {
  const uiCore = makeUiCore()
  const { mod } = loadBundle(uiCore, makePrimitives())
  primeStore(mod)
  const tree = mod.HeaderSecurityCount({ sessionId: 's1' })
  const btn = collect(tree, (n) => n.type === 'button' && n.props['data-silksec-surface'] === 'security-header')[0]
  assert.ok(btn, '会话头必须渲染安全产出钮')
  // s1: findings 2（含候选）+ facts 1（source 归属）= 3
  assert.match(btn.props.title, /本会话安全产出 3 项/)
  assert.match(btn.props.title, /漏洞 2/)
  assert.match(btn.props.title, /事实 1/)
  assert.equal(btn.props['data-silksec-surface'], 'security-header')

  const s2 = mod.HeaderSecurityCount({ sessionId: 's2' })
  const btn2 = collect(s2, (n) => n.type === 'button' && n.props['data-silksec-surface'] === 'security-header')[0]
  assert.match(btn2.props.title, /本会话安全产出 2 项/, 's2: findings 1 + facts 1 = 2')
})

test('会话头切换：selectView 可用时调用官方 API，缺席降级 secUiBus 打开 Modal', () => {
  const uiCore = makeUiCore()
  const bus = []
  uiCore.secUiBus = { emit: (n, p) => bus.push({ n, p }), on() { return () => {} }, off() {} }
  const { mod } = loadBundle(uiCore, makePrimitives())
  const calls = []
  assert.equal(mod.openSecurityView({ selectView: (v) => calls.push(v) }), 'view')
  assert.deepEqual(calls, [mod.VIEW_ID])
  // 官方 utilities 条目不继承 selectView（owner props 为空）→ 经 secUiBus 请求 Modal 宿主
  assert.equal(mod.openSecurityView({ sessionId: 's1' }), 'modal')
  assert.equal(JSON.stringify(bus), JSON.stringify([{ n: 'open:security-view', p: { sessionId: 's1' } }]))
  assert.doesNotThrow(() => mod.SecurityViewModalHost({}))
})

// ── ③ assistant-actions：每条 messageId 两个动作 ─────────────────────────────
test('消息动作：每 messageId 渲染「登记候选漏洞」「沉淀事实」两个动作', () => {
  const uiCore = makeUiCore()
  const { mod } = loadBundle(uiCore, makePrimitives())
  const tree = mod.MessageSecurityActions({ messageId: 'm-1', sessionId: 's1' })
  const wrapper = collect(tree, (n) => n.props['data-silksec-surface'] === 'message-actions')[0]
  assert.ok(wrapper, '必须渲染消息动作容器')
  assert.equal(wrapper.props['data-message-id'], 'm-1')
  const btns = collect(tree, (n) => n.type === 'button' && n.props['data-silksec-action'])
  assert.deepEqual(btns.map((b) => b.props['data-silksec-action']).sort(), ['fact', 'finding'])
  // 19-ui-unify 补丁：动作图标化（26×26 icon-btn + aria-label/title 说明），不再渲染文字标签
  for (const b of btns) {
    assert.equal(b.props.className, 'silksec-icon-btn', '动作必须是图标按钮')
    assert.ok(b.props['aria-label'], '图标按钮必须有 aria-label')
    assert.ok(!String(deepText(b)).match(/登记候选漏洞|沉淀事实/), '按钮内不得再出现文字标签')
  }
  // 不同 messageId 独立渲染（additive 语义：list 槽每 messageId 一条）
  const tree2 = mod.MessageSecurityActions({ messageId: 'm-2', sessionId: 's1' })
  const wrapper2 = collect(tree2, (n) => n.props['data-silksec-surface'] === 'message-actions')[0]
  assert.equal(wrapper2.props['data-message-id'], 'm-2')
})

test('消息动作注册定义：additive list、id/order 稳定，非 chain', () => {
  const uiCore = makeUiCore()
  const { mod } = loadBundle(uiCore, makePrimitives())
  const def = mod.buildActionsDefinition()
  assert.equal(def.name, 'conversation.chat.assistant-actions')
  assert.equal(def.id, 'silksec-message-actions')
  assert.equal(def.order, 30)
  assert.equal(def.kind, undefined, 'list 槽用 id/order，不带 chain 语义')
})

// ── ④ 槽缺席 → 不注册、不抛、不改主面板 ──────────────────────────────────────
test('槽缺席：三会话槽未声明 → 不注册、不抛、health=degraded、主面板零变化', () => {
  const uiCore = makeUiCore()
  const { mod } = loadBundle(uiCore, makePrimitives())
  const { slots, registered } = makeSlots([], [])
  assert.doesNotThrow(() => mod.apply(makeCtx({ slots })))
  assert.equal(Object.keys(registered).length, 0, '会话槽缺席不得注册任何会话绑定')
  assert.equal(uiCore.__registry.size(), 0, '不得向主面板注册降级视图（11 视图行为不变）')
  assert.equal(uiCore.__health['ui-session'].status, 'degraded')
})

test('槽部分缺席：仅 conversation.view 声明 → 只注册该面，其余不注册', () => {
  const uiCore = makeUiCore()
  const { mod } = loadBundle(uiCore, makePrimitives())
  const { slots, registered } = makeSlots(['conversation.view'], ['conversation.view'])
  assert.doesNotThrow(() => mod.apply(makeCtx({ slots })))
  assert.ok(registered['conversation.view:silksec-security'])
  assert.equal(Object.keys(registered).length, 1)
})

test('能力探测：slotDeclared 只在槽声明时真', () => {
  const uiCore = makeUiCore()
  const { mod } = loadBundle(uiCore, makePrimitives())
  const yes = makeSlots([], ['conversation.view']).slots
  const no = makeSlots([], []).slots
  assert.equal(mod.slotDeclared(yes, 'conversation.view'), true)
  assert.equal(mod.slotDeclared(no, 'conversation.view'), false)
})

// ── ⑤ 写操作端点/参数 + 路由 ─────────────────────────────────────────────────
test('写操作：登记候选漏洞 → vuln.register_candidate（操作员候选登记）', async () => {
  const uiCore = makeUiCore()
  const { mod } = loadBundle(uiCore, makePrimitives())
  const calls = []
  const rpc = (endpoint, payload) => { calls.push({ endpoint, payload }); return Promise.resolve({ ok: true }) }
  await mod.securityAction(rpc, 'registerCandidate', [{ title: ' 未授权 ', host: ' api.s1.com ', url: '/x', program_id: 'meituan', evidence: 'ev' }])
  assert.equal(calls[0].endpoint, 'vuln.register_candidate')
  assert.equal(calls[0].payload.severity, 'info')
  assert.equal(calls[0].payload.title, '未授权')
  assert.equal(calls[0].payload.host, 'api.s1.com')
  assert.equal(calls[0].payload.url, '/x')
  assert.equal(calls[0].payload.program_id, 'meituan')
  assert.equal(calls[0].payload.source, 'dashboard')
})

test('写操作：沉淀事实 → fact.upsert（source 记录会话归属）', async () => {
  const uiCore = makeUiCore()
  const { mod } = loadBundle(uiCore, makePrimitives())
  const calls = []
  const rpc = (endpoint, payload) => { calls.push({ endpoint, payload }); return Promise.resolve({ ok: true }) }
  await mod.securityAction(rpc, 'depositFact', [{ program_id: 'meituan', fact_key: 'note/abc', category: 'note', summary: 'sum', body: 'body', session_id: 's1' }])
  assert.equal(calls[0].endpoint, 'fact.upsert')
  assert.equal(calls[0].payload.program_id, 'meituan')
  assert.equal(calls[0].payload.fact_key, 'note/abc')
  assert.equal(calls[0].payload.confidence, 'tentative')
  assert.equal(calls[0].payload.source, 'dashboard:session:s1')
})

test('写操作：未知 op / rpc 缺席 → reject 不抛同步异常', async () => {
  const uiCore = makeUiCore()
  const { mod } = loadBundle(uiCore, makePrimitives())
  await assert.rejects(() => mod.securityAction(() => Promise.resolve({}), 'bogus', []))
  await assert.rejects(() => mod.securityAction(null, 'registerCandidate', [{}]))
})

test('RPC 路由：vuln.*/fact.* → /silksec-domain；读端点 → /silksec-dashboard', async () => {
  const uiCore = makeUiCore()
  const { mod } = loadBundle(uiCore, makePrimitives())
  const calls = []
  const ctx = makeCtx({ connection: makeConnection(calls) })
  mod.apply(ctx)
  const rpc = mod.getRpc ? mod.getRpc() : null
  assert.equal(typeof rpc, 'function', 'getRpc 必须导出')
  await rpc('vuln.register_candidate', {})
  await rpc('fact.upsert', {})
  await rpc('findings', { limit: 200 })
  assert.equal(calls[0].route, '/silksec-domain')
  assert.equal(calls[0].endpoint, 'vuln.register_candidate')
  assert.equal(calls[1].route, '/silksec-domain')
  assert.equal(calls[1].endpoint, 'fact.upsert')
  assert.equal(calls[2].route, '/silksec-dashboard')
  assert.equal(mod.routeFor('vuln.register_candidate'), '/silksec-domain')
  assert.equal(mod.routeFor('findings'), '/silksec-dashboard')
})

// ── ⑥ primitives 缺席兜底 ────────────────────────────────────────────────────
test('primitives 缺席：注册/视图/头钮/动作/Modal 均不抛（Tooltip/Modal/RiskConfirmation 走兜底）', () => {
  const uiCore = makeUiCore({ rpcState: FULL_RPC_STATE })
  const { mod } = loadBundle(uiCore, null)
  primeStore(mod)
  const available = ['conversation.view', 'conversation.session.header.utilities', 'conversation.chat.assistant-actions']
  const { slots } = makeSlots(available, available)
  assert.doesNotThrow(() => mod.apply(makeCtx({ slots })))
  assert.doesNotThrow(() => mod.SecurityView({ sessionId: 's1' }))
  assert.doesNotThrow(() => mod.HeaderSecurityCount({ sessionId: 's1' }))
  assert.doesNotThrow(() => mod.MessageSecurityActions({ messageId: 'm1', sessionId: 's1' }))
  assert.doesNotThrow(() => mod.SecurityActionModal({ kind: 'finding', sessionId: 's1', messageId: 'm1', summary: 'x', rpc: () => Promise.resolve({}), onClose() {} }))
  assert.doesNotThrow(() => mod.SecurityActionModal({ kind: 'fact', sessionId: 's1', messageId: 'm1', summary: 'x', rpc: () => Promise.resolve({}), onClose() {} }))
  assert.doesNotThrow(() => mod.ModalShell({ title: 't', onClose() {} }, 'body'))
})

// ── ⑦ 按 session_id 过滤正确性（两会话交叉） ─────────────────────────────────
test('安全视图：s1 只出 s1 产出（findings/facts/tasks/runs），不混入 s2 与无归属', () => {
  const uiCore = makeUiCore({ rpcState: FULL_RPC_STATE })
  const { mod } = loadBundle(uiCore, makePrimitives())
  primeStore(mod)
  const s1 = deepText(mod.SecurityView({ sessionId: 's1' }))
  assert.match(s1, /S1 未授权访问/)
  assert.match(s1, /S1 候选注入/)
  assert.match(s1, /auth\/s1-token/)
  assert.match(s1, /S1 定时侦察/)
  assert.match(s1, /S1 执行完成/)
  assert.doesNotMatch(s1, /S2 越权/, '不得混入 s2 finding')
  assert.doesNotMatch(s1, /note\/s2-note/, '不得混入 s2 fact')
  assert.doesNotMatch(s1, /S2 队列任务/, '不得混入 s2 task')
  assert.doesNotMatch(s1, /S2 执行失败/, '不得混入 s2 run')
  assert.doesNotMatch(s1, /无归属历史行/, '不得混入无 session_id 的历史行')

  const s2 = deepText(mod.SecurityView({ sessionId: 's2' }))
  assert.match(s2, /S2 越权/)
  assert.match(s2, /note\/s2-note/)
  assert.match(s2, /S2 队列任务/)
  assert.match(s2, /S2 执行失败/)
  assert.doesNotMatch(s2, /S1 未授权访问/)
  assert.doesNotMatch(s2, /auth\/s1-token/)
})

test('过滤辅助函数：sessionFromSource / filterBySession / filterFactsBySession / sessionCounts', () => {
  const uiCore = makeUiCore()
  const { mod } = loadBundle(uiCore, makePrimitives())
  assert.equal(mod.sessionFromSource('dashboard:session:s1'), 's1')
  assert.equal(mod.sessionFromSource('fgs-persist'), '')
  assert.equal(mod.filterBySession(FINDINGS, 's1').length, 2)
  assert.equal(mod.filterFactsBySession(FACTS, 's1').length, 1)
  assert.equal(mod.filterFactsBySession(FACTS, 's2').length, 1)
  const counts = mod.sessionCounts({ findings: FINDINGS, facts: FACTS }, 's1')
  assert.equal(counts.findings, 2)
  assert.equal(counts.facts, 1)
  assert.equal(counts.total, 3)
})

test('normalizePrograms：rows/数组两种形状归一 + 空值过滤', () => {
  const uiCore = makeUiCore()
  const { mod } = loadBundle(uiCore, makePrimitives())
  assert.equal(JSON.stringify(mod.normalizePrograms({ rows: [{ name: 'meituan' }] })), JSON.stringify([{ v: 'meituan', l: 'meituan' }]))
  assert.equal(JSON.stringify(mod.normalizePrograms([{ id: 'bytedance', title: '字节' }])), JSON.stringify([{ v: 'bytedance', l: '字节' }]))
  assert.equal(JSON.stringify(mod.normalizePrograms(null)), '[]')
})
