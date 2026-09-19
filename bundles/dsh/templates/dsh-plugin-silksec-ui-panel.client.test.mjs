// ==============================================================================
// @silksec/ui-panel 单测（16-dashboard P1 主面板）
// 运行：node --test dsh-plugin-silksec-ui-panel.client.test.mjs
// 目标：
//   ① 双形态回归——注册/卸载幂等；DashboardPanel 按 ui-core viewRegistry 的 order
//      渲染 11 视图（用 vm + 假 React，同 P0 手法）。
//   ② beginNavigation 连点竞态——连续两次导航，旧信号 abort 后不得提交；新导航生效；
//      有槽时绝不「静默不注册」。
//   ③ 降级分支——panellist/layout 缺席时优雅回落（不抛），main 仍可注册 / footer+Modal 承接。
//
// 客户端 bundle 是 `window.__ModuleLoader__.load` CJS factory 形态，无法 ESM import，
// 故用 node:vm + 假 React / 假 ui-core / 假 slots 物化 factory，直接验证真实产物。
// ==============================================================================

import { test } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BUNDLE = path.join(HERE, 'dsh-plugin-silksec-ui-panel.client.js')
const CODE = fs.readFileSync(BUNDLE, 'utf8')

// ── 假 React ────────────────────────────────────────────────────────────────
function createElement(type, props, ...children) {
  return { $$el: true, type, props: props || {}, children }
}
const React = {
  createElement,
  Fragment: 'Fragment',
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: (fn) => { if (typeof fn === 'function') fn() },
}

// ── 假 ui-core：viewRegistry + hooks + styles/T ──────────────────────────────
function makeUiCore() {
  let entries = {}
  let listeners = []
  function notify() { const l = listeners.slice(); l.forEach((fn) => fn(registry.list())) }
  const registry = {
    register(d) {
      entries[d.id] = { id: d.id, label: d.label || d.id, order: d.order === undefined ? 100 : d.order, component: d.component, domain: d.domain, source: d.source, group: d.group === 'more' ? 'more' : 'primary' }
      notify()
      return () => { delete entries[d.id]; notify() }
    },
    list() { return Object.keys(entries).map((k) => entries[k]).sort((a, b) => (a.order || 0) - (b.order || 0)) },
    subscribe(fn) { listeners.push(fn); return () => { listeners = listeners.filter((f) => f !== fn) } },
    size() { return Object.keys(entries).length },
  }
  const emptyPaged = {
    q: '', setQ() {}, filters: {}, setFilter() {}, page: 0, setPage() {}, size: 20, setSize() {},
    sort: '', dir: '', toggleSort() {}, rows: [], total: 0, loading: true, error: null,
    filtered: false, reset() {}, reload() {}, refresh() {},
  }
  return {
    viewRegistry: registry,
    T: { brand: 'brand', label2: 'label2', label3: 'label3', warn: 'warn', label: 'label', error: 'error', border: 'border', base: 'base', layer1: 'layer1', hover: 'hover', success: 'success', border2: 'border2', border3: 'border3', skeleton: 'skeleton' },
    F: { xxxs: {}, xxs: {}, xxsStrong: {}, xs: {}, s: {}, sStrong: {}, baseStrong: {} },
    styles: { root: {}, header: {}, pageT: {}, pageSub: {}, silkDivider: {}, errorLine: {}, tabBar: {}, body: {}, cardL: {}, cardV: {}, pill: {} },
    secUiBus: { emit() {}, on() { return () => {} } },
    spoolIcon: () => null,
    opIcon: () => null,
    fmtBytes: (n) => (n === undefined || n === null ? '—' : String(n)),
    fmtNum: (n) => (n === undefined || n === null ? '—' : String(n)),
    EmptyState: function EmptyState() {},
    SilksecErrorBoundary: function SilksecErrorBoundary() {},
    useRpc: () => ({ loading: true, data: null, error: null, reload() {} }),
    usePagedQuery: () => emptyPaged,
    markSurfaceHealth() {},
    __registry: registry,
  }
}

// ── 假 slots（声明生命周期 + 注册表） ───────────────────────────────────────
function makeSlots(available) {
  const registered = {}
  const slots = {
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

function loadBundle(uiCore) {
  let registration = null
  const sandbox = {
    window: { __ModuleLoader__: { load: (r) => { registration = r } } },
    console,
    Promise, setTimeout, clearTimeout, setInterval, clearInterval,
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(CODE, sandbox, { filename: BUNDLE })
  assert.ok(registration, 'bundle 必须经 window.__ModuleLoader__.load 注册')
  assert.equal(registration.id, '@silksec/ui-panel')
  const mod = registration.factory((spec) => {
    if (spec === 'react') return React
    if (spec === '@silksec/ui-core') return uiCore
    throw new Error('unexpected require: ' + spec)
  })
  return { mod, sandbox }
}

function makeCtx(slots) {
  return { get: (n) => (n === 'slots' ? slots : null), effect: (fn) => fn() }
}

// 递归收集元素树中满足谓词的节点（children 可含数组/嵌套）
function collect(node, pred, out = []) {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) { node.forEach((n) => collect(n, pred, out)); return out }
  if (node.$$el) {
    if (pred(node)) out.push(node)
    ;(node.children || []).forEach((c) => collect(c, pred, out))
  }
  return out
}

// ── ① 注册/卸载幂等 + panel 按 registry 顺序渲染 ───────────────────────────
test('注册幂等：apply 两次同 id 只一条，disposer 幂等；main/panellist 均注册（不静默）', () => {
  const uiCore = makeUiCore()
  const { mod } = loadBundle(uiCore)
  const { slots, registered } = makeSlots(['main', 'sidebar.panellist'])
  const ctx = makeCtx(slots)

  mod.apply(ctx)
  assert.ok(registered['main:silksec-dashboard'], 'main 槽必须注册 silksec-dashboard（不静默不注册）')
  assert.equal(registered['main:silksec-dashboard'].cfg.key, 'silksec-dashboard', 'keyed 槽必须用 options.key')
  assert.equal(registered['main:silksec-dashboard'].cfg.order, 30)
  assert.ok(registered['sidebar.panellist:silksec-dashboard'], 'panellist 槽必须注册「安全中心」导航行')
  assert.equal(registered['sidebar.panellist:silksec-dashboard'].cfg.label, '安全中心')
  assert.equal(Object.keys(registered).length, 2, 'main + panellist 两条（同 id 两个槽）')

  // 幂等：第二次 apply 不抛、数量不增
  mod.apply(ctx)
  assert.equal(Object.keys(registered).length, 2)
})

test('DashboardPanel：按 viewRegistry order 渲染 tab，active = 第一条', () => {
  const uiCore = makeUiCore()
  const { mod } = loadBundle(uiCore)
  // 故意乱序注册：order 20/30/10
  const cFindings = function CFindings() {}
  const cAssets = function CAssets() {}
  const cAudit = function CAudit() {}
  uiCore.viewRegistry.register({ id: 'findings', label: '漏洞', order: 20, component: cFindings })
  uiCore.viewRegistry.register({ id: 'assets', label: '资产', order: 30, component: cAssets })
  uiCore.viewRegistry.register({ id: 'audit', label: '审计', order: 10, component: cAudit })

  const tree = mod.DashboardPanel()
  const tabs = collect(tree, (n) => n.type === 'button' && n.props.className === 'silksec-tab')
  assert.deepEqual(tabs.map((t) => t.children[0]), ['审计', '漏洞', '资产'], 'tab 必须按 registry order 升序')

  // active = 第一条（order 最小）的组件被渲染
  const active = collect(tree, (n) => n.type === cAudit)
  assert.equal(active.length, 1, 'active 必须是 registry 首条（审计）组件')
})

test('DashboardPanel：group=more 收敛进「更多」二级导航，一级 tab 只留 primary', () => {
  const uiCore = makeUiCore()
  const { mod } = loadBundle(uiCore)
  uiCore.viewRegistry.register({ id: 'findings', label: '漏洞', order: 20, component: function C1() {} })
  uiCore.viewRegistry.register({ id: 'assets', label: '资产', order: 30, component: function C2() {} })
  uiCore.viewRegistry.register({ id: 'knowledge', label: '知识', order: 70, group: 'more', component: function C3() {} })
  uiCore.viewRegistry.register({ id: 'audit', label: '审计', order: 110, group: 'more', component: function C4() {} })

  const tree = mod.DashboardPanel()
  const tabs = collect(tree, (n) => n.type === 'button' && n.props.className === 'silksec-tab')
  const labels = tabs.map((t) => (t.children && t.children[0]) || '')
  assert.ok(labels.includes('漏洞') && labels.includes('资产'), 'primary tab 保留')
  assert.ok(!labels.includes('知识') && !labels.includes('审计'), 'more 组不得占一级 tab')
  assert.ok(labels.some((l) => String(l).indexOf('更多') === 0), '出现「更多」入口')
  // 默认 active = findings（第一条），故二级导航不渲染；仅一级「更多」入口
  assert.equal(collect(tree, (n) => n.type === 'button' && n.props.className === 'silksec-tab' && String((n.children || [])[0] || '').indexOf('更多') >= 0).length, 1)
})

test('DashboardPanel：注册晚到经 viewRegistry.subscribe 触发重渲染（动态注册）', () => {
  const uiCore = makeUiCore()
  const { mod } = loadBundle(uiCore)
  let listened = null
  // 捕获 subscribe 回调
  const origSub = uiCore.viewRegistry.subscribe
  uiCore.viewRegistry.subscribe = (fn) => { listened = fn; return origSub(fn) }
  mod.DashboardPanel()
  assert.equal(typeof listened, 'function', 'panel 必须订阅注册表动态变化')
})

// ── ② beginNavigation 连点竞态 ──────────────────────────────────────────────
test('navigateToPanel：连点竞态——旧信号 abort 不提交，新导航生效', async () => {
  const uiCore = makeUiCore()
  const { mod } = loadBundle(uiCore)
  const calls = []
  let prev = null
  const layout = {
    beginNavigation() { if (prev) prev.aborted = true; prev = { aborted: false }; return prev },
    selectPanel(id) { calls.push(id) },
  }
  assert.equal(mod.navigateToPanel(layout, 'silksec-dashboard'), true)
  // 立刻第二次导航：作废第一次的 pending 信号
  assert.equal(mod.navigateToPanel(layout, null), true)
  await Promise.resolve(); await Promise.resolve()
  assert.deepEqual(calls, [null], '被 abort 的旧导航不得提交；新导航（null 返回会话）生效')
})

test('navigateToPanel：单次导航提交；layout 缺席返回 false 且不抛', async () => {
  const uiCore = makeUiCore()
  const { mod } = loadBundle(uiCore)
  const calls = []
  const layout = { beginNavigation() { return { aborted: false } }, selectPanel(id) { calls.push(id) } }
  mod.navigateToPanel(layout, 'silksec-dashboard')
  await Promise.resolve(); await Promise.resolve()
  assert.deepEqual(calls, ['silksec-dashboard'])
  assert.equal(mod.navigateToPanel(null, 'silksec-dashboard'), false)
})

// ── ③ 降级分支 ──────────────────────────────────────────────────────────────
test('降级：slots 缺席 → apply 不抛、不注册；panellist 缺席 → main 仍注册', () => {
  const uiCore = makeUiCore()
  const { mod } = loadBundle(uiCore)

  // slots 服务缺席（旧 DSH / 未装载）→ 静默不注册
  assert.doesNotThrow(() => mod.apply({ get: () => null, effect: (fn) => fn() }))

  // 只有 main、没有 panellist（旧 sidebar）→ main 注册成功、panellist 静默降级
  const { slots, registered } = makeSlots(['main'])
  assert.doesNotThrow(() => mod.apply(makeCtx(slots)))
  assert.equal(Object.keys(registered).length, 1)
  assert.ok(registered['main:silksec-dashboard'])
})

test('降级：layout 缺席时 DashboardPanel 仍可渲染，返回会话按钮点击不抛', async () => {
  const uiCore = makeUiCore()
  const { mod } = loadBundle(uiCore)
  uiCore.viewRegistry.register({ id: 'findings', label: '漏洞', order: 20, component: function C() {} })
  // serviceRef.ctx 未设置（模拟 layout 缺席）
  let tree = null
  assert.doesNotThrow(() => { tree = mod.DashboardPanel() })
  const back = collect(tree, (n) => n.type === 'button' && n.props.className === 'silksec-icon-btn' && n.props.title === '返回当前会话')
  assert.equal(back.length, 1, '「返回会话」图标按钮存在（19-ui-unify §2.4）')
  assert.equal(back[0].props['aria-label'], '返回当前会话')
  assert.doesNotThrow(() => back[0].props.onClick())
  const refresh = collect(tree, (n) => n.type === 'button' && n.props.className === 'silksec-icon-btn' && n.props.title === '重新加载主面板数据')
  assert.equal(refresh.length, 1, '「刷新」图标按钮存在')
  await Promise.resolve()
})
