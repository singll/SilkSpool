// ==============================================================================
// @silksec/sec-dashboard-view-know 单测（16-dashboard P6 知识/学习域视图拆分）
// 运行：node --test dsh-plugin-sec-dashboard.view-know.client.test.mjs
//
// 目标（对齐 P6 验收）：
//   ① 注册/卸载：一个 bundle/apply 注册恰两条 viewRegistry 条目
//      knowledge(order70)/learning(order75)，requires:['connection']，health ok；
//      disposer 回收两条，幂等。
//   ② 能力降级：connection 缺席 → 两条均不注册、不抛（tab 静默隐藏）。
//   ③ 知识域：经验卡行渲染 + kbRead / rulesRead / expFeedback 端点经自持 rpc 发出。
//   ④ 学习域：五问卡片渲染 + learningTrace 端点。
//   ⑤ primitives/Modal 缺席（DocModal 返回 null）不抛。
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
const BUNDLE = path.join(HERE, 'dsh-plugin-sec-dashboard.view-know.client.js')
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

// ── 假 ui-core（提供全部被消费符号；DocModal 可按 modalAbsent 模拟 primitives 缺席） ─
function makeUiCore(opts = {}) {
  const rpcState = opts.rpcState || {}
  const health = {}
  let entries = {}
  let listeners = []
  function notify() { const l = listeners.slice(); l.forEach((fn) => fn(registry.list())) }
  const registry = {
    register(d) {
      entries[d.id] = { id: d.id, label: d.label || d.id, order: d.order === undefined ? 100 : d.order, component: d.component, domain: d.domain, source: d.source, requires: d.requires || [] }
      notify()
      return () => { delete entries[d.id]; notify() }
    },
    list() { return Object.keys(entries).map((k) => entries[k]).sort((a, b) => (a.order || 0) - (b.order || 0)) },
    subscribe(fn) { listeners.push(fn); return () => { listeners = listeners.filter((f) => f !== fn) } },
    size() { return Object.keys(entries).length },
    get(id) { return entries[id] || null },
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
    styles: { pill: {}, card: {}, cardL: {}, errorLine: {}, tableStyle: {}, theadRow: {}, th: {}, td: {}, tdMono: {}, pageT: {}, pageSub: {}, toolbar: {}, root: {}, header: {} },
    fmtTime: (x) => (x == null ? '—' : String(x)),
    markSurfaceHealth(surface, status, detail) { health[surface] = { status, detail } },
    setSessionOpener(fn) { /* noop */ },
    useRpc,
    SkeletonRows: function SkeletonRows(props) { return createElement('skeleton-stub', props) },
    EmptyState: function EmptyState(props) { return createElement('empty-stub', props) },
    DocModal: function DocModal(props) { return opts.modalAbsent ? null : createElement('docmodal-stub', props) },
    opIcon: () => null,
    SilksecErrorBoundary: function SilksecErrorBoundary(props) { return props.children },
    viewRegistry: registry,
    __health: health,
    __registry: registry,
  }
}

// ── 假 ctx（inject 仅在依赖服务齐备时回调；effect 收集 disposer） ─────────────
function makeCtx(services) {
  const effects = []
  return {
    __effects: effects,
    get: (n) => services[n] || null,
    effect(fn) { const d = fn(); if (typeof d === 'function') effects.push(d); return d },
    inject(deps, cb) { if (deps.every((d) => services[d])) return cb(Object.assign({}, services)); return () => {} },
  }
}
function makeConnection(rpcCalls) {
  return { rpc: { call(route, endpoint, payload) { rpcCalls.push({ route, endpoint, payload }); return Promise.resolve({ ok: true, value: {} }) } } }
}

function loadBundle(uiCore) {
  let registration = null
  const sandbox = {
    window: {
      __ModuleLoader__: { load: (r) => { registration = r } },
      prompt: () => sandbox.__promptResult,
      alert: (m) => { sandbox.__alerts.push(m) },
    },
    alert: (m) => { sandbox.__alerts.push(m) },
    document: { querySelector: () => null, createElement: () => ({ dataset: {}, style: {}, appendChild() {}, set textContent(_) {} }), head: { appendChild() {} }, body: { appendChild() {}, removeChild() {} } },
    console,
    Promise, setTimeout, clearTimeout, setInterval, clearInterval,
    __promptResult: '',
    __alerts: [],
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(CODE, sandbox, { filename: BUNDLE })
  assert.ok(registration, 'bundle 必须经 window.__ModuleLoader__.load 注册')
  assert.equal(registration.id, '@silksec/sec-dashboard-view-know')
  const mod = registration.factory((spec) => {
    if (spec === 'react') return React
    if (spec === '@silksec/ui-core') return uiCore
    throw new Error('unexpected require: ' + spec)
  })
  return { mod, sandbox }
}

// ── 元素树工具：函数组件就地物化，模拟 React 渲染 ─────────────────────────────
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
function findNodes(root, pred) {
  const out = []
  collect(root, (n) => { if (pred(n)) out.push(n) }, out)
  return out
}

// ── ① 注册/卸载 + health ─────────────────────────────────────────────────────
test('注册：一个 bundle 恰注册 knowledge(order70)/learning(order75) 两条 + health ok', () => {
  const uiCore = makeUiCore()
  const { mod } = loadBundle(uiCore)
  const calls = []
  const ctx = makeCtx({ connection: makeConnection(calls) })
  mod.apply(ctx)

  const list = uiCore.__registry.list()
  assert.equal(list.length, 2, '必须恰注册两条视图条目')
  assert.deepEqual(list.map((e) => e.id), ['knowledge', 'learning'])
  const k = uiCore.__registry.get('knowledge')
  const l = uiCore.__registry.get('learning')
  assert.equal(k.label, '知识'); assert.equal(k.order, 70); assert.equal(k.domain, 'know')
  assert.equal(k.source, 'dashboard-view-know')
  assert.equal(JSON.stringify(k.requires), JSON.stringify(['connection']))
  assert.equal(typeof k.component, 'function')
  assert.equal(l.label, '学习'); assert.equal(l.order, 75); assert.equal(l.domain, 'know')
  assert.equal(l.source, 'dashboard-view-know')
  assert.equal(JSON.stringify(l.requires), JSON.stringify(['connection']))
  assert.equal(typeof l.component, 'function')
  assert.equal(uiCore.__health['sec-dashboard-view-know'].status, 'ok')
})

test('卸载：disposer 回收两条注册，幂等不抛', () => {
  const uiCore = makeUiCore()
  const { mod } = loadBundle(uiCore)
  const ctx = makeCtx({ connection: makeConnection([]) })
  mod.apply(ctx)
  assert.equal(uiCore.__registry.size(), 2)
  assert.equal(ctx.__effects.length, 1)
  ctx.__effects.forEach((d) => d())
  assert.equal(uiCore.__registry.size(), 0, 'disposer 后两条视图均回收')
  assert.doesNotThrow(() => ctx.__effects.forEach((d) => d()), 'disposer 幂等')
  assert.equal(uiCore.__registry.size(), 0)
})

// ── ② 能力降级：connection 缺席 ──────────────────────────────────────────────
test('connection 缺席：两条均不注册、不抛（tab 静默隐藏）', () => {
  const uiCore = makeUiCore()
  const { mod } = loadBundle(uiCore)
  const ctx = makeCtx({})
  assert.doesNotThrow(() => mod.apply(ctx))
  assert.equal(uiCore.__registry.size(), 0)
  assert.equal(ctx.__effects.length, 0)
  assert.equal(uiCore.__health['sec-dashboard-view-know'], undefined)
})

// ── ③ 知识域：渲染 + kbRead/rulesRead/expFeedback ────────────────────────────
const CARD = { id: 7, scenario: 'auth/默认口令', takeaway: '默认口令先测 admin/admin', score: 12, uses: 3, adopted: 2, pos_fb: 1, neg_fb: 0, status: 'candidate', exportable: 1, kind: 'exp' }
const KB = { id: 'kb-1', title: 'JSON Web Token 滥用', file: '/data/knowledge/jwt.md', curated: true, uses: 2, status: 'active' }
const RULE = { file: 'src/gate.md', title: '定级闸', size: 2048, dir: 'src' }

test('知识域：经验卡/文献/先验行渲染，点击分别发出 kbRead / rulesRead / expFeedback', () => {
  const uiCore = makeUiCore()
  const { mod } = loadBundle(uiCore)
  const calls = []
  const rpc = (endpoint, payload) => { calls.push({ endpoint, payload }); return Promise.resolve({ ok: true, value: { content: 'x', title: 't' } }) }
  const tree = mod.KnowledgeView({
    cardsState: { data: { rows: [CARD] }, loading: false, error: null, reload() {} },
    pbsState: { data: { rows: [] }, loading: false, error: null, reload() {} },
    rulesState: { data: { rows: [RULE] }, loading: false, error: null, reload() {} },
    kbState: { data: { rows: [KB], counts: { curated: 1, external: 0 } }, loading: false, error: null, reload() {} },
    factOvState: { data: { total: 5, byCategory: { auth: 2, target: 3 }, blackboard: { active: 1, envIssues: 0 } }, loading: false, error: null, reload() {} },
    covState: { data: null, loading: false, error: null, reload() {} },
    memState: { data: { loaded: true, tables: {} }, loading: false, error: null, reload() {} },
    busy: false,
    callRpc: rpc,
  })
  const text = deepText(tree)
  assert.match(text, /默认口令先测/, '经验卡 takeaway 必须渲染')
  assert.match(text, /auth\/默认口令/, '经验卡场景必须渲染')
  assert.match(text, /JSON Web Token 滥用/, '文献行必须渲染')
  assert.match(text, /定级闸/, '静态先验行必须渲染')

  // 点击文献行 → kbRead
  const kbRow = findNodes(tree, (n) => n.type === 'tr' && typeof n.props.onClick === 'function' && textOf(n).includes('JSON Web Token'))
  assert.ok(kbRow.length >= 1, '必须有可点击文献行')
  kbRow[0].props.onClick()
  assert.ok(calls.some((c) => c.endpoint === 'kbRead' && c.payload.id === 'kb-1'), 'kbRead({id}) 必须发出')

  // 点击先验行 → rulesRead
  const ruleRow = findNodes(tree, (n) => n.type === 'tr' && typeof n.props.onClick === 'function' && textOf(n).includes('定级闸'))
  assert.ok(ruleRow.length >= 1, '必须有可点击先验行')
  ruleRow[0].props.onClick()
  assert.ok(calls.some((c) => c.endpoint === 'rulesRead' && c.payload.file === 'src/gate.md'), 'rulesRead({file}) 必须发出')

  // 点击「有用」图标钮 → expFeedback
  const fbBtn = findNodes(tree, (n) => n.type === 'button' && n.props['aria-label'] === '有用')
  assert.equal(fbBtn.length, 1, '必须有「有用」反馈钮')
  fbBtn[0].props.onClick()
  assert.ok(calls.some((c) => c.endpoint === 'expFeedback' && c.payload.id === 7 && c.payload.verdict === 'useful'), 'expFeedback({id,verdict}) 必须发出')
})

// ── ④ 学习域：五问卡片 + learningTrace ───────────────────────────────────────
const LEARNING = {
  learned: { summary: '默认口令与 JWT 滥用两方向被证实有效', episodes_recent: [{ episode_id: 'ep-abcdefghijklmnop', card_id: 7, program_id: 'meituan', outcome: 'verified_positive', created_at: 1700000000000 }] },
  evidence: { summary: '三条独立证据引用', note: '含快照哈希' },
  improvement: { summary: '较旧版提升 12%', scores: [{ artifact_kind: 'exp_card', artifact_id: '7', score: 0.62, sample_size: 8, verified_positives: 3 }] },
  effective_where: { summary: '在 2 个项目生效', releases: [] },
  rollback: { summary: '撤回受控', hint: '面板撤回按钮' },
  gaps: [],
  feedback: null,
}

test('学习域：五问卡片渲染，证据对照按钮发出 learningTrace', () => {
  const uiCore = makeUiCore()
  const { mod } = loadBundle(uiCore)
  const calls = []
  const rpc = (endpoint, payload) => { calls.push({ endpoint, payload }); return Promise.resolve({ ok: true, value: { chain: null, links: null } }) }
  const tree = mod.LearningView({ state: { data: LEARNING, loading: false, error: null, reload() {} }, busy: false, callRpc: rpc })
  const text = deepText(tree)
  assert.match(text, /① 学到了什么/)
  assert.match(text, /② 依据是什么/)
  assert.match(text, /③ 比旧版改善多少/)
  assert.match(text, /④ 在哪生效/)
  assert.match(text, /⑤ 如何恢复旧版/)
  assert.match(text, /默认口令与 JWT 滥用两方向被证实有效/)

  const traceBtn = findNodes(tree, (n) => n.type === 'button' && textOf(n) === '证据对照')
  assert.ok(traceBtn.length >= 1, '必须有证据对照按钮')
  traceBtn[0].props.onClick()
  assert.ok(calls.some((c) => c.endpoint === 'learningTrace'), 'learningTrace 必须发出')
})

// ── ⑥ 24 号方案 §3.2/§3.3：治理漏斗 + 学习流水线 ────────────────────────────
test('24 纯函数：knowledgeFunnel 聚合 memcore tables 状态分布', () => {
  const uiCore = makeUiCore()
  const { mod } = loadBundle(uiCore)
  const mem = { loaded: true, tables: { exp_cards: { candidate: 2, active: 5, cooling: 1 }, kb_docs: { active: 3, deprecated: 4 } } }
  assert.equal(JSON.stringify(mod.knowledgeFunnel(mem)), JSON.stringify({ candidate: 2, active: 8, cooling: 1, deprecated: 4 }))
  assert.equal(mod.knowledgeFunnel(null), null)
  assert.equal(mod.knowledgeFunnel({ loaded: false }), null)
})

test('24 纯函数：learningPipeline 取 episodes/scores/releases 计数', () => {
  const uiCore = makeUiCore()
  const { mod } = loadBundle(uiCore)
  const d = {
    learned: { episodes_recent: [{}, {}] },
    improvement: { scores: [{}] },
    effective_where: { releases: [{ status: 'active' }, { status: 'revoked' }] },
  }
  assert.equal(JSON.stringify(mod.learningPipeline(d)), JSON.stringify({ episodes: 2, artifacts: 1, releases: 2, active: 1, revoked: 1 }))
  assert.equal(mod.learningPipeline(null), null)
})

test('24 知识域：治理漏斗条渲染（候选/生效/冷却/归档）', () => {
  const uiCore = makeUiCore()
  const { mod } = loadBundle(uiCore)
  const tree = mod.KnowledgeView({
    cardsState: { data: { rows: [] }, loading: false, error: null, reload() {} },
    pbsState: { data: { rows: [] }, loading: false, error: null, reload() {} },
    rulesState: { data: { rows: [] }, loading: false, error: null, reload() {} },
    kbState: { data: { rows: [], counts: {} }, loading: false, error: null, reload() {} },
    factOvState: { data: null, loading: false, error: null, reload() {} },
    covState: { data: null, loading: false, error: null, reload() {} },
    memState: { data: { loaded: true, tables: { exp_cards: { candidate: 2, active: 5 } } }, loading: false, error: null, reload() {} },
    busy: false, callRpc: () => Promise.resolve({}),
  })
  const text = deepText(tree)
  assert.match(text, /治理流水线/, '知识 tab 顶部必须有治理漏斗条')
  assert.match(text, /候选 2/, '候选计数')
  assert.match(text, /生效 5/, '生效计数')
  assert.match(text, /冷却 —/, '缺键显示 —')
})

test('24 学习域：学习流水线条渲染（观测/记分/发布/撤回）', () => {
  const uiCore = makeUiCore()
  const { mod } = loadBundle(uiCore)
  const d = {
    learned: { summary: 'x', episodes_recent: [{ episode_id: 'e1', outcome: 'verified_positive' }] },
    evidence: { summary: 'y', note: '' },
    improvement: { summary: 'z', scores: [{ artifact_kind: 'exp_card', artifact_id: '1', score: 1, sample_size: 2, verified_positives: 1 }] },
    effective_where: { summary: 'w', releases: [{ status: 'active', release_id: 'r1', artifact_id: '1', scope_type: 'global' }, { status: 'revoked', release_id: 'r2' }] },
    rollback: { summary: 'r', hint: 'h' }, gaps: [], feedback: null,
  }
  const tree = mod.LearningView({ state: { data: d, loading: false, error: null, reload() {} }, busy: false, callRpc: () => Promise.resolve({}) })
  const text = deepText(tree)
  assert.match(text, /学习流水线/, '学习 tab 顶部必须有学习流水线条')
  assert.match(text, /观测 1/, '观测计数')
  assert.match(text, /记分 1/, '记分计数')
  assert.match(text, /发布 2（生效 1）/, '发布计数')
  assert.match(text, /撤回 1/, '撤回计数')
})

// ── ⑤ primitives/Modal 缺席 ──────────────────────────────────────────────────
test('primitives/Modal 缺席：apply 与两个域根渲染均不抛', () => {
  const uiCore = makeUiCore({ modalAbsent: true })
  const { mod } = loadBundle(uiCore)
  const ctx = makeCtx({ connection: makeConnection([]) })
  assert.doesNotThrow(() => mod.apply(ctx))
  assert.equal(uiCore.__registry.size(), 2)
  assert.doesNotThrow(() => mod.KnowledgeRoot({ rpc: () => Promise.resolve({}) }))
  assert.doesNotThrow(() => mod.LearningRoot({ rpc: () => Promise.resolve({}) }))
})
