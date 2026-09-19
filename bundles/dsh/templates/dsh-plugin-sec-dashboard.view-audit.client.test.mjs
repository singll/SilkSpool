// ==============================================================================
// @silksec/sec-dashboard-view-audit 单测（16-dashboard P6 审计域拆分）
// 运行：node --test dsh-plugin-sec-dashboard.view-audit.client.test.mjs
//
// 目标（对齐 P6 验收）：
//   (a) 注册恰好一条 audit：order 110 / domain bus / requires ['connection']，
//       并打卡 window.__silksecSurfaceHealth['sec-dashboard-view-audit']=ok；
//   (b) 卸载幂等：ctx.effect 的 disposer 生效且重复调用不抛、无残留；
//   (c) connection 缺席：静默不注册（不抛、不打卡、不占 order）；
//   (d) 关键行渲染：时间 / 工具 / 决策 / 详情四列；决策按语义着色；
//       超长详情 200 字截断 + 点击展开可交互；
//   (e) primitives 缺席：加载/apply/渲染不抛（本视图不依赖 primitives）。
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
const BUNDLE = path.join(HERE, 'dsh-plugin-sec-dashboard.view-audit.client.js')
const CODE = fs.readFileSync(BUNDLE, 'utf8')

// ── 假 React（children 同时并入 props.children） ─────────────────────────────
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

// ── 假 ui-core（提供 view-audit 使用的全部符号） ────────────────────────────
function makeUiCore(opts = {}) {
  const rpcState = opts.rpcState || {}
  const health = {}
  let entries = {}
  let listeners = []
  function notify() { listeners.slice().forEach((fn) => fn(registry.list())) }
  const registry = {
    register(d) {
      entries[d.id] = {
        id: d.id, label: d.label || d.id,
        order: d.order === undefined ? 100 : d.order,
        component: d.component, domain: d.domain, source: d.source,
        requires: d.requires || [],
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
      pill: {}, th: {}, td: {}, tdMono: {}, tdClosed: {}, tableStyle: {}, theadRow: {}, toolbar: {},
      errorLine: {}, pageSub: {}, card: {}, pageT: {}, root: {}, header: {}, stateLine: {}, tabBar: {}, body: {},
    },
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
  return {
    rpc: {
      call(route, endpoint, payload) {
        return Promise.resolve({ ok: true, value: { rows: [], total: 0 } })
      },
    },
  }
}

function loadBundle(uiCore, primitives) {
  let registration = null
  const sandbox = {
    window: { __ModuleLoader__: { load: (r) => { registration = r } } },
    document: {
      querySelector: () => null,
      createElement: () => ({ dataset: {}, style: {}, appendChild() {}, set textContent(_) {} }),
      head: { appendChild() {} },
      body: { appendChild() {}, removeChild() {} },
    },
    console,
    Promise, setTimeout, clearTimeout, setInterval, clearInterval,
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(CODE, sandbox, { filename: BUNDLE })
  assert.ok(registration, 'bundle 必须经 window.__ModuleLoader__.load 注册')
  assert.equal(registration.id, '@silksec/sec-dashboard-view-audit')
  const mod = registration.factory((spec) => {
    if (spec === 'react') return React
    if (spec === '@silksec/ui-core') return uiCore
    if (spec === '@deepseek-ai/dsh-client-ui-primitives') {
      if (primitives == null) throw new Error('no primitives')
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
function textOf(node) {
  if (node == null) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (node.$$el) return (node.children || []).map(textOf).join('')
  return ''
}

const LONG_DETAIL = 'D'.repeat(260)
const AUDIT_ROWS = [
  { ts: 1700000000000, tool: 'scope_save', decision: 'executed', detail: { domain: 'scope', actor: 'dashboard', target: 'x.com' } },
  { ts: 1700000001000, tool: 'scope_check', decision: 'rejected', detail: '目标不在授权范围' },
  { ts: 1700000002000, tool: 'vuln_submit', decision: 'executed', detail: LONG_DETAIL },
]
const AUDIT_STATE = { audit: { data: { rows: AUDIT_ROWS } } }

// ── (a) 注册一条 audit + health ──────────────────────────────────────────────
test('注册：恰好一条 audit（order 110/domain bus/requires connection），health ok', () => {
  const uiCore = makeUiCore()
  const { mod } = loadBundle(uiCore, null)
  const ctx = makeCtx({ connection: makeConnection() })
  mod.apply(ctx)

  const list = uiCore.__registry.list()
  assert.equal(list.length, 1, 'audit 视图恰好登记一条')
  assert.equal(list[0].id, 'audit')
  assert.equal(list[0].label, '审计')
  assert.equal(list[0].order, 110)
  assert.equal(list[0].domain, 'bus')
  // requires 数组来自 vm realm，跨 realm 原型不同，按值比较
  assert.equal(JSON.stringify(list[0].requires), JSON.stringify(['connection']))
  assert.equal(list[0].source, 'dashboard-view-audit')
  assert.equal(typeof list[0].component, 'function')
  assert.equal(uiCore.__health['sec-dashboard-view-audit'].status, 'ok')
})

// ── (b) 卸载幂等 ─────────────────────────────────────────────────────────────
test('卸载：ctx.effect disposer 生效且重复调用幂等无残留', () => {
  const uiCore = makeUiCore()
  const { mod } = loadBundle(uiCore, null)
  const ctx = makeCtx({ connection: makeConnection() })
  mod.apply(ctx)
  assert.equal(uiCore.__registry.size(), 1)

  assert.equal(ctx.__effects.length, 1, 'install 的 disposer 必须经 ctx.effect 收口')
  ctx.__effects[0]()
  assert.equal(uiCore.__registry.size(), 0, 'disposer 后无残留')
  assert.doesNotThrow(() => ctx.__effects[0](), '重复卸载不抛')
  assert.equal(uiCore.__registry.size(), 0)
})

// ── (c) connection 缺席静默 ──────────────────────────────────────────────────
test('connection 缺席：静默不注册、不打卡、不抛', () => {
  const uiCore = makeUiCore()
  const { mod } = loadBundle(uiCore, null)
  const ctx = makeCtx({})
  assert.doesNotThrow(() => mod.apply(ctx))
  assert.equal(uiCore.__registry.size(), 0, '无 connection 不得注册（静默隐藏）')
  assert.equal(uiCore.__health['sec-dashboard-view-audit'], undefined, '不得打卡 ok')
})

// ── (d) 关键行渲染：四列 + 决策着色 + 详情截断可交互 ─────────────────────────
test('渲染：时间/工具/决策/详情四列，决策语义着色，超长详情截断可点击展开', () => {
  const uiCore = makeUiCore({ rpcState: AUDIT_STATE })
  const { mod } = loadBundle(uiCore, null)
  const tree = mod.AuditView({ rpc: () => Promise.resolve({}) })

  const thTexts = collect(tree, (n) => n.type === 'th').map(textOf)
  assert.deepEqual(thTexts, ['时间', '工具 / 动作', '决策', '详情'], '四列头逐字保留')

  const tds = collect(tree, (n) => n.type === 'td')
  assert.equal(tds.length, AUDIT_ROWS.length * 4, '每行四列')

  const all = tds.map(textOf)
  assert.ok(all.includes('scope_save'), '工具列保留')
  assert.ok(all.includes('scope_check'))
  assert.ok(all.some((t) => t.indexOf('actor') >= 0 && t.indexOf('dashboard') >= 0), 'detail.actor 逐字保留')
  assert.ok(all.includes('目标不在授权范围'), '字符串 detail 原样呈现')

  const executed = tds.find((n) => textOf(n) === 'executed')
  const rejected = tds.find((n) => textOf(n) === 'rejected')
  assert.equal(executed.props.style.color, uiCore.T.success, 'executed → success 令牌')
  assert.equal(rejected.props.style.color, uiCore.T.error, 'rejected → error 令牌')
  assert.match(textOf(tds[0]), /^T1700000000000$/, '时间列经 fmtTime')

  const longTd = tds.find((n) => textOf(n).indexOf('… ⤵') >= 0)
  assert.ok(longTd, '超长详情必须截断标记')
  assert.equal(longTd.props.title, '点击展开全文')
  assert.equal(typeof longTd.props.onClick, 'function', '详情可点击展开')
})

// ── (e) primitives 缺席不抛 ──────────────────────────────────────────────────
test('primitives 缺席：加载/apply/渲染均不抛（本视图不依赖 primitives）', () => {
  const uiCore = makeUiCore({ rpcState: AUDIT_STATE })
  const loaded = loadBundle(uiCore, null)
  assert.doesNotThrow(() => loaded.mod.apply(makeCtx({ connection: makeConnection() })))
  assert.doesNotThrow(() => loaded.mod.AuditRoot({ rpc: () => Promise.resolve({}) }))
  assert.doesNotThrow(() => loaded.mod.AuditView({ rpc: () => Promise.resolve({}) }))
})
