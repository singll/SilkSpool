// ==============================================================================
// @silksec/ui-settings-scope 单测（19-ui-surface P4 授权迁设置页）
// 运行：node --test dsh-plugin-silksec-ui-settings-scope.client.test.mjs
//
// 目标（对齐 P4 验收）：
//   ① 注册/卸载幂等：settings.section（list/root）注册「授权范围」整节；
//      apply 两次不重复、disposer 生效；降级视图安装/撤销。
//   ② scope 读写端点参数正确：scopeList / scopeSaveProgram / scopeDeleteProgram /
//      programBindWorkspace（同主面板端点同参数）；RPC 路由按端点分派
//      （dashboard 端点 → /silksec-dashboard；scope.cred_query → /silksec-domain）。
//   ③ settings.section 缺席 → 同一视图注册 ui-core 注册表（主面板「授权 ·降级」），不抛。
//   ④ primitives 缺席兜底：整节/降级视图/Modal 均不抛。
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
const BUNDLE = path.join(HERE, 'dsh-plugin-silksec-ui-settings-scope.client.js')
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

// ── 假 primitives（可选增强） ─────────────────────────────────────────────────
function makePrimitives() {
  return {
    Modal: function Modal(props) { return createElement('modal-stub', props, props.children) },
    Tooltip: function Tooltip(props) { return createElement('tooltip-stub', props, props.children) },
  }
}

// ── 假 ui-core ───────────────────────────────────────────────────────────────
function makeUiCore(opts = {}) {
  const rpcState = opts.rpcState || {}
  const health = {}
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
  return {
    T: { brand: 'brand', label: 'label', label2: 'label2', label3: 'label3', warn: 'warn', error: 'error', success: 'success', business: 'business', border: 'border', border2: 'border2', border3: 'border3', base: 'base', layer1: 'layer1', layer2: 'layer2', layer3: 'layer3', hover: 'hover', skeleton: 'skeleton' },
    F: { xxxs: {}, xxs: {}, xxsStrong: {}, xs: {}, s: {}, sStrong: {}, baseStrong: {} },
    MONO: 'mono',
    styles: { pill: {}, th: {}, td: {}, tdMono: {}, tableStyle: {}, theadRow: {}, toolbar: {}, errorLine: {}, card: {}, pageT: {}, pageSub: {}, root: {}, header: {} },
    fmtTs: (x) => (x == null ? '—' : String(x)),
    markSurfaceHealth(surface, status, detail) { health[surface] = { status, detail } },
    useRpc,
    SilksecErrorBoundary: function SilksecErrorBoundary(props) { return props.children },
    EmptyState: function EmptyState() {},
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
  assert.equal(registration.id, '@silksec/ui-settings-scope')
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

const PROGRAMS = [
  { name: 'meituan', platform: '美团 SRC', scope: ['*.meituan.com', 'meituan.com'], exclude: ['pay.meituan.com'], max_risk: 'active', workspace: '美团 SRC', db: { status: 'active', workspace_id: 'ws1', workspace_path: '/srv/meituan' } },
  { name: 'bytedance', platform: '字节 SRC', scope: ['*.bytedance.com'], exclude: [], max_risk: 'intrusive', workspace: null, db: null },
]
const CREDS = [
  { id: 41, program_id: 'meituan', host: 'api.meituan.com', cred_type: 'cookie', ref: 'MEITUAN_COOKIE', role: 'user', created_at: 1700000000000 },
]
const WORKSPACES = { available: true, items: [{ id: 'ws1', title: '美团 SRC', program: { id: 'meituan' } }] }
const FULL_RPC_STATE = {
  scopeList: { data: { programs: PROGRAMS, archived: [{ id: 'old-prog' }], defaults: { allow_risk: ['passive', 'active'], egress_proxy: 'http://proxy:8080' } } },
  'scope.cred_query': { data: { rows: CREDS, total: 1 } },
  workspaces: { data: WORKSPACES },
}

// ── ① 注册/卸载幂等 + 整节挂 settings.section ─────────────────────────────────
test('注册：settings.section 注册「授权范围」整节（id/order/label），不静默', () => {
  const uiCore = makeUiCore()
  const { mod } = loadBundle(uiCore, makePrimitives())
  const { slots, registered } = makeSlots(['settings.section'], ['settings.section'])
  const ctx = makeCtx({ slots })

  mod.apply(ctx)
  assert.ok(registered['settings.section:silksec-scope'], '整节必须挂 settings.section（list/root）')
  const cfg = registered['settings.section:silksec-scope'].cfg
  assert.equal(cfg.id, 'silksec-scope')
  assert.equal(cfg.order, 200)
  const def = mod.buildSectionDefinition()
  assert.equal(def.id, mod.SECTION_ID)
  assert.equal(def.order, mod.SECTION_ORDER)
  assert.equal(typeof def.label, 'function')
  assert.equal(def.label(), '授权范围')
  assert.equal(uiCore.__health['ui-settings-scope'].status, 'ok')

  // 幂等：第二次 apply 不抛、注册数不增、降级视图不残留
  mod.apply(ctx)
  assert.equal(Object.keys(registered).length, 1)
  assert.equal(uiCore.__registry.size(), 0, 'section 可用时不得注册降级视图')
})

test('卸载：ctx.effect 返回的 disposer 生效（整节回滚）', () => {
  const uiCore = makeUiCore()
  const { mod } = loadBundle(uiCore, makePrimitives())
  const { slots, registered } = makeSlots(['settings.section'], ['settings.section'])
  const ctx = makeCtx({ slots })
  mod.apply(ctx)
  assert.equal(Object.keys(registered).length, 1)
  ctx.__effects.forEach((d) => d())
  assert.equal(Object.keys(registered).length, 0, 'disposer 后无残留注册')
})

// ── ② scope 读写端点参数 + 路由分派 ──────────────────────────────────────────
test('写操作：list/save/remove/bind 走主面板同端点同参数', async () => {
  const uiCore = makeUiCore()
  const { mod } = loadBundle(uiCore, makePrimitives())
  const calls = []
  const rpc = (endpoint, payload) => { calls.push({ endpoint, payload }); return Promise.resolve({ ok: true }) }
  await mod.scopeAction(rpc, 'list', [])
  await mod.scopeAction(rpc, 'save', [{ name: 'meituan', platform: '美团', scope: ['*.meituan.com'], exclude: ['pay.meituan.com'], max_risk: 'active' }, false])
  await mod.scopeAction(rpc, 'remove', ['meituan'])
  await mod.scopeAction(rpc, 'bind', ['meituan', 'ws1'])
  assert.equal(calls[0].endpoint, 'scopeList')
  assert.equal(calls[1].endpoint, 'scopeSaveProgram')
  assert.equal(JSON.stringify(calls[1].payload), JSON.stringify({ name: 'meituan', platform: '美团', scope: ['*.meituan.com'], exclude: ['pay.meituan.com'], max_risk: 'active', is_new: false }))
  assert.equal(calls[2].endpoint, 'scopeDeleteProgram')
  assert.equal(JSON.stringify(calls[2].payload), JSON.stringify({ name: 'meituan' }))
  assert.equal(calls[3].endpoint, 'programBindWorkspace')
  assert.equal(JSON.stringify(calls[3].payload), JSON.stringify({ program_id: 'meituan', workspace_id: 'ws1' }))
})

test('写操作：未知 op / rpc 缺席 → reject 不抛同步异常', async () => {
  const uiCore = makeUiCore()
  const { mod } = loadBundle(uiCore, makePrimitives())
  await assert.rejects(() => mod.scopeAction(() => Promise.resolve({}), 'bogus', []))
  await assert.rejects(() => mod.scopeAction(null, 'remove', ['x']))
})

test('RPC 路由分派：dashboard 端点 → /silksec-dashboard；cred_query → /silksec-domain', async () => {
  const uiCore = makeUiCore()
  const { mod } = loadBundle(uiCore, makePrimitives())
  const calls = []
  const ctx = makeCtx({ connection: makeConnection(calls) })
  mod.apply(ctx)
  const rpc = mod.getRpc()
  await rpc('scopeList', {})
  await rpc('scope.cred_query', { limit: 200 })
  assert.equal(calls[0].route, '/silksec-dashboard')
  assert.equal(calls[0].endpoint, 'scopeList')
  assert.equal(calls[1].route, '/silksec-domain')
  assert.equal(calls[1].endpoint, 'scope.cred_query')
  assert.equal(calls[1].payload.limit, 200)
})

test('能力探测：slotDeclared 只在槽声明时真', () => {
  const uiCore = makeUiCore()
  const { mod } = loadBundle(uiCore, makePrimitives())
  const yes = makeSlots([], ['settings.section']).slots
  const no = makeSlots([], []).slots
  assert.equal(mod.slotDeclared(yes, 'settings.section'), true)
  assert.equal(mod.slotDeclared(no, 'settings.section'), false)
})

// ── ③ 降级：settings.section 缺席 → ui-core 注册表 ───────────────────────────
test('降级：settings.section 缺席 → 同一视图注册 ui-core 注册表（角标「降级」），不抛', () => {
  const uiCore = makeUiCore()
  const { mod } = loadBundle(uiCore, makePrimitives())
  const { slots } = makeSlots([], [])
  assert.doesNotThrow(() => mod.apply(makeCtx({ slots })))
  const degraded = uiCore.__registry.list().filter((e) => e.id === 'scope-degraded')
  assert.equal(degraded.length, 1, '降级视图必须注册进 ui-core 注册表（供主面板渲染）')
  assert.match(degraded[0].label, /降级/)
  assert.equal(degraded[0].domain, 'scope')
  assert.equal(uiCore.__health['ui-settings-scope'].status, 'degraded')
  // 幂等：重复 apply 不重复注册
  mod.apply(makeCtx({ slots }))
  assert.equal(uiCore.__registry.list().filter((e) => e.id === 'scope-degraded').length, 1)
  // 卸载撤销降级
  const ctx = makeCtx({ slots })
  mod.apply(ctx)
  ctx.__effects.forEach((d) => d())
  assert.equal(uiCore.__registry.list().filter((e) => e.id === 'scope-degraded').length, 0, 'disposer 后降级视图撤销')
})

test('降级视图渲染：不抛，含 program/排除/凭据', () => {
  const uiCore = makeUiCore({ rpcState: FULL_RPC_STATE })
  const { mod } = loadBundle(uiCore, makePrimitives())
  const tree = mod.ScopeDegradedView({ rpc: () => Promise.resolve({}) })
  const text = deepText(tree)
  assert.match(text, /降级/)
  assert.match(text, /meituan/)
  assert.match(text, /凭据引用/)
  assert.match(text, /MEITUAN_COOKIE/)
})

// ── ④ 渲染：program 卡 / 排除 / 凭据 + primitives 缺席兜底 ───────────────────
test('整节渲染：program 卡（工作区徽章/max_risk/条目数）+ 排除 + 凭据引用', () => {
  const uiCore = makeUiCore({ rpcState: FULL_RPC_STATE })
  const { mod } = loadBundle(uiCore, makePrimitives())
  const tree = mod.ScopeSection({ rpc: () => Promise.resolve({}) })
  const text = deepText(tree)
  assert.match(text, /授权范围/, '节标题')
  assert.match(text, /meituan/, 'program 名')
  assert.match(text, /上限 active/, 'max_risk')
  assert.match(text, /条目 2/, '授权条目数')
  assert.match(text, /工作区 美团 SRC/, '工作区徽章（已绑定）')
  assert.match(text, /未绑工作区/, '未绑定徽章')
  assert.match(text, /pay\.meituan\.com/, '排除清单条目')
  assert.match(text, /MEITUAN_COOKIE/, '凭据引用（只显示 ref）')
  assert.doesNotMatch(text, /admin:.*password/i, '不得出现明文凭据')
  // 行内操作图标钮（编辑/移除/刷新）
  assert.ok(collect(tree, (n) => n.type === 'button' && n.props.className === 'silksec-icon-btn').length >= 2)
})

test('ScopeForm：编辑态预填 + 保存/取消按钮（提交契约由 scopeAction 用例覆盖）', () => {
  const uiCore = makeUiCore()
  const { mod } = loadBundle(uiCore, makePrimitives())
  const form = mod.ScopeForm({ initial: { name: 'meituan', platform: 'MT', scope: ['a.com'], exclude: ['b.com'], max_risk: 'active' }, onSave: () => {}, onCancel: () => {} })
  const text = deepText(form)
  assert.match(text, /编辑授权项目：meituan/)
  const textareas = collect(form, (n) => n.type === 'textarea')
  assert.ok(textareas.some((n) => String(n.props.value).indexOf('a.com') >= 0), '授权范围预填')
  assert.ok(textareas.some((n) => String(n.props.value).indexOf('b.com') >= 0), '排除清单预填')
  assert.ok(collect(form, (n) => n.type === 'button' && /保存/.test(deepText(n))).length === 1, '保存按钮存在')
  assert.ok(collect(form, (n) => n.type === 'button' && /取消/.test(deepText(n))).length === 1, '取消按钮存在')
})

test('primitives 缺席：整节 / 降级视图 / Modal 均不抛（Tooltip/Modal 走兜底）', () => {
  const uiCore = makeUiCore({ rpcState: FULL_RPC_STATE })
  const { mod } = loadBundle(uiCore, null)
  const { slots } = makeSlots(['settings.section'], ['settings.section'])
  assert.doesNotThrow(() => mod.apply(makeCtx({ slots })))
  assert.doesNotThrow(() => mod.ScopeSection({ rpc: () => Promise.resolve({}) }))
  assert.doesNotThrow(() => mod.ScopeDegradedView({ rpc: () => Promise.resolve({}) }))
  assert.doesNotThrow(() => mod.renderScopeModal(true, () => Promise.resolve({}), () => {}))
  assert.doesNotThrow(() => mod.ProgramCard({ program: PROGRAMS[0], workspaces: WORKSPACES.items, busy: false, onEdit() {}, onRemove() {}, onBind() {} }))
})

test('programBound/programCount/excludeCount 辅助函数', () => {
  const uiCore = makeUiCore()
  const { mod } = loadBundle(uiCore, makePrimitives())
  assert.equal(mod.programBound(PROGRAMS[0]), '美团 SRC')
  assert.equal(mod.programBound(PROGRAMS[1]), '')
  assert.equal(mod.programCount(PROGRAMS[0]), 2)
  assert.equal(mod.excludeCount(PROGRAMS[0]), 1)
})
