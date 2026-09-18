// ==============================================================================
// @silksec/sec-dashboard-view-report 单测（19-ui-surface P6 报告域视图拆分）
// 运行：node --test dsh-plugin-sec-dashboard.view-report.client.test.mjs
//
// 目标（对齐 P6 验收）：
//   ① 注册幂等：viewRegistry 恰一条 reports（order 80 / domain report），
//      surface health 打卡 ok；apply 两次不重复；disposer 可重入。
//   ② connection 缺席：不注册、不打卡、不抛（tab 静默隐藏）。
//   ③ 报告域渲染：rows 按项目分组渲染；点击行/👁 → reportRead({file}) 打开
//      ui-core.DocModal 阅读器；「筛选」改变 reportFilter → 服务端重查 reports
//      （payload 带 program/q）。
//   ④ 降级：ui-core.DocModal 缺席 / ui-core require 失败 → 不抛。
//
// 客户端 bundle 是 `window.__ModuleLoader__.load` CJS factory 形态，无法 ESM import，
// 故用 node:vm + 迷你有状态 React（支持 useState/useEffect 重渲染）+ 假 ui-core 物化
// factory，直接验证真实产物。
// ==============================================================================

import { test } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BUNDLE = path.join(HERE, 'dsh-plugin-sec-dashboard.view-report.client.js')
const CODE = fs.readFileSync(BUNDLE, 'utf8')

// ── 迷你有状态 React：hooks 按「渲染路径」持久化，setState 触发同步重渲染 ─────
function makeEnv(opts = {}) {
  const rpcCalls = []
  const health = {}
  const hookState = new Map()
  let currentPath = ''
  let currentIndex = 0
  let currentRoot = null
  let renderedTree = null
  let rendering = false
  let sessionOpener = null

  function nextKey() { return currentPath + '#' + (currentIndex++) }
  function withScope(path, fn) {
    const p = currentPath; const i = currentIndex
    currentPath = path; currentIndex = 0
    try { return fn() } finally { currentPath = p; currentIndex = i }
  }
  function depsEqual(a, b) {
    if (!a || !b) return false
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
    return true
  }
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
    useState: (init) => {
      const key = nextKey()
      let slot = hookState.get(key)
      if (!slot) { slot = { value: typeof init === 'function' ? init() : init }; hookState.set(key, slot) }
      const setter = (next) => {
        const nv = typeof next === 'function' ? next(slot.value) : next
        if (nv === slot.value) return
        slot.value = nv
        schedule()
      }
      return [slot.value, setter]
    },
    useEffect: (fn, deps) => {
      const key = nextKey()
      const prev = hookState.get(key)
      if (prev && depsEqual(prev.deps, deps)) return
      if (prev && typeof prev.cleanup === 'function') { try { prev.cleanup() } catch (e) {} }
      const slot = { deps: deps ? deps.slice() : null, cleanup: undefined }
      hookState.set(key, slot)
      const cleanup = fn()
      if (typeof cleanup === 'function') slot.cleanup = cleanup
    },
  }

  // 物化函数组件（用渲染路径做 hook 键），host 元素保留 children 树供断言
  function materialize(node, nodePath) {
    if (node == null) return node
    if (Array.isArray(node)) return node.map((n, i) => materialize(n, nodePath + '/' + i))
    if (typeof node !== 'object' || !node.$$el) return node
    if (typeof node.type === 'function') {
      const childPath = nodePath + '<' + (node.type.name || 'anon') + '>'
      let out = null
      try { out = withScope(childPath, () => node.type(node.props)) } catch (e) { out = null }
      return materialize(out, childPath)
    }
    const kids = (node.children || []).map((c, i) => materialize(c, nodePath + '/' + i))
    return { $$el: true, type: node.type, props: node.props, children: kids }
  }
  function render() {
    if (rendering) return
    rendering = true
    try { renderedTree = materialize(currentRoot, '') } finally { rendering = false }
  }
  function schedule() { if (!rendering) render() }

  // 假 ui-core：viewRegistry + useRpc + DocModal + 全量被消费符号
  const entries = {}
  const registry = {
    register(d) {
      entries[d.id] = {
        id: d.id, label: d.label || d.id, order: d.order === undefined ? 100 : d.order,
        component: d.component, domain: d.domain, source: d.source, requires: d.requires || [],
      }
      return () => { delete entries[d.id] }
    },
    list() { return Object.keys(entries).map((k) => entries[k]).sort((a, b) => (a.order || 0) - (b.order || 0)) },
    get(id) { return entries[id] || null },
    has(id) { return !!entries[id] },
    size() { return Object.keys(entries).length },
  }
  function useRpc(action, deps, call) {
    const caller = (typeof call === 'function') ? call : function () { return Promise.reject(new Error('连接通道不可用')) }
    const state = React.useState({ loading: true, data: null, error: null })
    const setState = state[1]
    React.useEffect(() => {
      let a = null
      try { a = action() } catch (e) { a = null }
      if (!a) return
      let alive = true
      Promise.resolve().then(() => caller(a.endpoint, a.payload)).then(
        (json) => { if (alive) setState({ loading: false, data: json, error: null }) },
        (e) => { if (alive) setState({ loading: false, data: null, error: e && e.message ? e.message : String(e) }) },
      )
      return () => { alive = false }
    }, deps || [])
    return { loading: state[0].loading, data: state[0].data, error: state[0].error, reload() {} }
  }
  const uiCore = {
    T: { brand: 'brand', label: 'label', label2: 'label2', label3: 'label3', business: 'business', warn: 'warn', error: 'error', success: 'success', border: 'border', border2: 'border2', border3: 'border3', base: 'base', layer1: 'layer1' },
    F: { xxxs: {}, xxs: {}, xxsStrong: {}, xs: {}, s: {}, sStrong: {}, baseStrong: {} },
    MONO: 'mono',
    styles: { pill: {}, th: {}, td: {}, tdMono: {}, tableStyle: {}, theadRow: {}, cardL: {}, pageT: {}, errorLine: {} },
    opIcon: () => null,
    EmptyState: function EmptyState(props) { return createElement('empty-stub', props) },
    SkeletonRows: function SkeletonRows(props) { return createElement('skeleton-stub', props) },
    SilksecErrorBoundary: function SilksecErrorBoundary(props) { return props.children },
    viewRegistry: registry,
    useRpc,
    markSurfaceHealth(surface, status, detail) { health[surface] = { status, detail } },
    setSessionOpener(fn) { sessionOpener = fn },
  }
  if (opts.docModal !== false) uiCore.DocModal = function DocModal(props) { return createElement('docmodal-stub', props) }

  return {
    React, uiCore, registry, health, rpcCalls,
    render(element) { currentRoot = element; render(); return renderedTree },
    get tree() { return renderedTree },
    async flush() { await Promise.resolve(); await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)) },
    getSessionOpener() { return sessionOpener },
  }
}

// ── 树工具 ──────────────────────────────────────────────────────────────────
function collect(node, pred, out = []) {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) { node.forEach((n) => collect(n, pred, out)); return out }
  if (node.$$el) {
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

// ── 加载 bundle ─────────────────────────────────────────────────────────────
function loadBundle(env, opts = {}) {
  let registration = null
  const specs = []
  const sandbox = {
    window: { __ModuleLoader__: { load: (r) => { registration = r } } },
    console,
    Promise, setTimeout, clearTimeout, setInterval, clearInterval,
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(CODE, sandbox, { filename: BUNDLE })
  assert.ok(registration, 'bundle 必须经 window.__ModuleLoader__.load 注册')
  assert.equal(registration.id, '@silksec/sec-dashboard-view-report')
  const mod = registration.factory((spec) => {
    specs.push(spec)
    if (spec === 'react') return env.React
    if (spec === '@silksec/ui-core') {
      if (opts.failUiCore) throw new Error('ui-core unavailable')
      return env.uiCore
    }
    throw new Error('unexpected require: ' + spec)
  })
  return { mod, specs }
}

function makeCtx(services) {
  const effects = []
  return {
    __effects: effects,
    get: (n) => services[n] || null,
    effect(fn) { const d = fn(); if (typeof d === 'function') effects.push(d); return d },
    inject(deps, cb) { if (deps.every((d) => services[d])) return cb({}); return () => {} },
  }
}
function makeConnection(routes) {
  return { rpc: { call(route, endpoint, payload) { routes.push({ route, endpoint, payload }); return Promise.resolve({ ok: true, value: { rows: [] } }) } } }
}

const REPORTS = {
  rows: [
    { file: 'report-meituan-20260918-1010.md', title: '美团 SRC 报告', program: 'meituan', date: '20260918-1010', mtime: 1700000000000, size: 2048 },
    { file: 'report-global.md', title: '', program: '', date: '', mtime: 1700000000000, size: 1024 },
  ],
  programs: ['meituan'],
}

// ── ① 注册 / 卸载 / health ──────────────────────────────────────────────────
test('注册：恰一条 reports（order 80/domain report/source）+ health ok', () => {
  const env = makeEnv()
  const { mod, specs } = loadBundle(env)
  assert.deepEqual(specs, ['react', '@silksec/ui-core'], '只消费 react + ui-core（不 require primitives）')
  mod.apply(makeCtx({ connection: makeConnection([]) }))

  const list = env.registry.list()
  assert.equal(list.length, 1, '只注册一条 reports')
  assert.equal(list[0].id, 'reports')
  assert.equal(list[0].label, '报告')
  assert.equal(list[0].order, 80)
  assert.equal(list[0].domain, 'report')
  assert.equal(list[0].source, 'dashboard-view-report')
  assert.equal(JSON.stringify(list[0].requires), JSON.stringify(['connection']))
  assert.equal(env.health['sec-dashboard-view-report'].status, 'ok')
})

test('卸载：apply 两次不重复；disposer 生效且可重入', () => {
  const env = makeEnv()
  const { mod } = loadBundle(env)
  const ctx = makeCtx({ connection: makeConnection([]) })
  mod.apply(ctx)
  mod.apply(ctx)
  assert.equal(env.registry.size(), 1, 'apply 两次仍只一条')
  ctx.__effects.forEach((d) => d())
  assert.equal(env.registry.size(), 0, 'disposer 后无残留')
  ctx.__effects.forEach((d) => assert.doesNotThrow(() => d()), 'disposer 重入不抛')
})

test('connection 缺席：不注册、不打卡、不抛（tab 静默隐藏）', () => {
  const env = makeEnv()
  const { mod } = loadBundle(env)
  const ctx = makeCtx({})
  assert.doesNotThrow(() => mod.apply(ctx))
  assert.equal(env.registry.size(), 0)
  assert.equal(ctx.__effects.length, 0)
  assert.equal(env.health['sec-dashboard-view-report'], undefined)
})

// ── ② 报告域渲染 + reportRead + 服务端筛选重查 ──────────────────────────────
test('报告域：按项目分组渲染 rows，点击行经 reportRead({file}) 打开阅读器', async () => {
  const env = makeEnv()
  const { mod } = loadBundle(env)
  const rpc = (endpoint, payload) => {
    env.rpcCalls.push({ endpoint, payload })
    if (endpoint === 'reports') return Promise.resolve(REPORTS)
    if (endpoint === 'reportRead') return Promise.resolve({ content: '# 报告正文', truncated: false })
    return Promise.resolve({})
  }
  env.render(mod.ReportRoot({ rpc }))
  await env.flush()

  const rows = collect(env.tree, (n) => n.type === 'tr' && n.props.className === 'silksec-row')
  assert.equal(rows.length, 2, '两份报告各一行')
  const text = textOf(env.tree)
  assert.match(text, /美团 SRC 报告/)
  assert.match(text, /全局\/未标注/)
  assert.ok(collect(env.tree, (n) => n.type === 'docmodal-stub').length === 1, '阅读器 Modal 恒在（open 前关闭态）')

  rows[0].props.onClick()
  await env.flush()
  const read = env.rpcCalls.find((c) => c.endpoint === 'reportRead')
  assert.ok(read, '点击行必须触发 reportRead')
  assert.equal(JSON.stringify(read.payload), JSON.stringify({ file: 'report-meituan-20260918-1010.md' }))
  const modal = collect(env.tree, (n) => n.type === 'docmodal-stub')[0]
  assert.equal(modal.props.state.content, '# 报告正文', '阅读器载入正文')
})

test('筛选：本地筛选态变更 → reportFilter 驱动服务端重查 reports（program/q）', async () => {
  const env = makeEnv()
  const { mod } = loadBundle(env)
  const rpc = (endpoint, payload) => {
    env.rpcCalls.push({ endpoint, payload })
    if (endpoint === 'reports') return Promise.resolve(REPORTS)
    return Promise.resolve({})
  }
  env.render(mod.ReportRoot({ rpc }))
  await env.flush()

  const initial = env.rpcCalls.find((c) => c.endpoint === 'reports')
  assert.equal(JSON.stringify(initial.payload), JSON.stringify({ program: '', q: '' }), '首查为空筛选')

  // 改项目下拉 → 改关键字输入 → 点「筛选」
  const select = collect(env.tree, (n) => n.type === 'select' && n.props.className === 'silksec-input')[0]
  select.props.onChange({ target: { value: 'meituan' } })
  const input = collect(env.tree, (n) => n.type === 'input' && n.props.placeholder === '搜索文件名/标题…')[0]
  input.props.onChange({ target: { value: '月度' } })
  const apply = collect(env.tree, (n) => n.type === 'button' && textOf(n) === '筛选')[0]
  assert.ok(apply, '「筛选」按钮必须在')
  apply.props.onClick()
  await env.flush()

  const calls = env.rpcCalls.filter((c) => c.endpoint === 'reports')
  const requery = calls[calls.length - 1]
  assert.equal(JSON.stringify(requery.payload), JSON.stringify({ program: 'meituan', q: '月度' }), '筛选变更后按 program/q 重查')

  // 「重置」清空筛选并触发空 payload 重查
  const reset = collect(env.tree, (n) => n.type === 'button' && textOf(n) === '重置')[0]
  assert.ok(reset, '有筛选态时必须出现「重置」')
  reset.props.onClick()
  await env.flush()
  const afterReset = env.rpcCalls.filter((c) => c.endpoint === 'reports').pop()
  assert.equal(JSON.stringify(afterReset.payload), JSON.stringify({ program: '', q: '' }))
})

// ── ③ 降级 ──────────────────────────────────────────────────────────────────
test('降级：ui-core.DocModal 缺席仍可渲染，不抛', async () => {
  const env = makeEnv({ docModal: false })
  const { mod } = loadBundle(env)
  mod.apply(makeCtx({ connection: makeConnection([]) }))
  const rpc = (endpoint) => Promise.resolve(endpoint === 'reports' ? REPORTS : { content: 'x' })
  assert.doesNotThrow(() => env.render(mod.ReportRoot({ rpc })))
  await env.flush()
  assert.equal(collect(env.tree, (n) => n.type === 'tr' && n.props.className === 'silksec-row').length, 2)
})

test('降级：ui-core require 失败 → 加载不抛、apply 静默 no-op', () => {
  const env = makeEnv()
  const { mod } = loadBundle(env, { failUiCore: true })
  const ctx = makeCtx({ connection: makeConnection([]) })
  assert.doesNotThrow(() => mod.apply(ctx))
  assert.equal(env.registry.size(), 0)
})

// ── ④ 会话跳链 opener（可选注入） ───────────────────────────────────────────
test('sessions 在场：setSessionOpener 注入 open 包装；缺席不抛', () => {
  const env = makeEnv()
  const { mod } = loadBundle(env)
  const opened = []
  mod.apply(makeCtx({ connection: makeConnection([]), sessions: { open: (id) => opened.push(id) } }))
  const opener = env.getSessionOpener()
  assert.equal(typeof opener, 'function')
  opener('sess-1')
  assert.deepEqual(opened, ['sess-1'])
  assert.doesNotThrow(() => mod.apply(makeCtx({ connection: makeConnection([]) })))
})
