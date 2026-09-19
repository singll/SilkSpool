// ==============================================================================
// @silksec/ui-core 单测（16-dashboard P0 地基）
// 运行：node --test dsh-plugin-silksec-ui-core.client.test.mjs
// 目标：
//   1. SilksecErrorBoundary 渲染崩溃「只炸单面」：失败面渲染 EmptyState 兜底，
//      同树其他面照常渲染；错误按 bus.audit_tail 口径上报（actor=dashboard + surface）。
//   2. 视图注册表注册/卸载幂等：重复注册只留一条；disposer 幂等；陈旧 disposer
//      不误删重注册；订阅通知与排序正确。
//
// 客户端 bundle 是 `window.__ModuleLoader__.load` CJS factory 形态，无法 ESM import，
// 故用 node:vm + 假 React/假 DOM 物化 factory，直接验证真实产物。
// ==============================================================================

import { test } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BUNDLE = path.join(HERE, 'dsh-plugin-silksec-ui-core.client.js')
const CODE = fs.readFileSync(BUNDLE, 'utf8')

// ── 假 React：只实现 factory 物化所需的 createElement / Component / Fragment ──
class FakeComponent {
  constructor(props) { this.props = props || {}; this.state = {} }
  setState(s) { this.state = Object.assign({}, this.state, typeof s === 'function' ? s(this.state) : s) }
}
function createElement(type, props, ...children) {
  return { $$el: true, type, props: props || {}, children }
}
const React = {
  createElement,
  Component: FakeComponent,
  Fragment: 'Fragment',
  useRef: (v) => ({ current: v }),
  useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
  useEffect: () => {},
}
const primitives = { Modal: function Modal() {} }

function loadBundle() {
  let registration = null
  const styles = []
  const sandbox = {
    window: { __ModuleLoader__: { load: (r) => { registration = r } } },
    document: {
      querySelector: () => null,
      createElement: () => { const tag = { dataset: {}, style: {}, textContent: '', appendChild() {} }; styles.push(tag); return tag },
      head: { appendChild() {} },
      body: { appendChild() {}, removeChild() {} },
    },
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(CODE, sandbox, { filename: BUNDLE })
  assert.ok(registration, 'bundle 必须经 window.__ModuleLoader__.load 注册')
  assert.equal(registration.id, '@silksec/ui-core')
  const mod = registration.factory((spec) => {
    if (spec === 'react') return React
    if (spec === '@deepseek-ai/dsh-client-ui-primitives') return primitives
    throw new Error('unexpected require: ' + spec)
  })
  return { mod, sandbox, styles }
}

// ── 1. ErrorBoundary 单面隔离 ────────────────────────────────────────────────
test('ErrorBoundary：单面崩溃只炸单面，并按 audit_tail 口径带 surface 上报', () => {
  const { mod, sandbox } = loadBundle()
  const reported = []
  const busEvents = []
  mod.setSurfaceErrorReporter((r) => reported.push(r))
  mod.secUiBus.on('error:surface', (r) => busEvents.push(r))

  const Boundary = mod.SilksecErrorBoundary
  const childA = createElement('span', null, 'A 内容')
  const a = new Boundary({ surface: 'vuln', title: '漏洞' })
  a.props.children = childA

  // 未崩溃时正常透传 children
  assert.equal(a.render(), childA)

  // 模拟子树抛错：React 错误边界调用 getDerivedStateFromError + componentDidCatch
  const boom = new Error('boom: 视图渲染失败')
  a.state = Boundary.getDerivedStateFromError(boom)
  assert.equal(a.state.failed, true)
  assert.equal(a.state.error, boom)
  a.componentDidCatch(boom, { componentStack: '\n  at VulnView' })

  // 失败面渲染兜底（EmptyState 树），不抛出
  const fallback = a.render()
  assert.ok(fallback && fallback.$$el, '崩溃面必须渲染兜底元素')
  assert.equal(fallback.type, 'div')

  // 同树其他面照常渲染（未被失败面传染）
  const childB = createElement('span', null, 'B 内容')
  const b = new Boundary({ surface: 'asset', title: '资产' })
  b.props.children = childB
  assert.equal(b.render(), childB, '另一面不得受失败面影响')

  // 上报口径：bus.audit_tail 记录形状 + surface 字段
  assert.equal(reported.length, 1)
  assert.equal(reported[0].kind, 'ui.surface_error')
  assert.equal(reported[0].actor, 'dashboard')
  assert.equal(reported[0].surface, 'vuln')
  assert.equal(reported[0].tool, 'ui-core.error-boundary')
  assert.equal(reported[0].error_code, 'E_UI_SURFACE')
  assert.match(reported[0].message, /boom/)
  assert.equal(busEvents.length, 1)
  assert.equal(busEvents[0].surface, 'vuln')

  // 冒烟门禁打卡表
  assert.equal(sandbox.window.__silksecSurfaceHealth.vuln.status, 'degraded')
})

test('ErrorBoundary：surface 缺省不崩，上报落到 unknown', () => {
  const { mod } = loadBundle()
  const reported = []
  mod.setSurfaceErrorReporter((r) => reported.push(r))
  const Boundary = mod.SilksecErrorBoundary
  const inst = new Boundary({ children: null })
  const err = new Error('x')
  inst.state = Boundary.getDerivedStateFromError(err)
  inst.componentDidCatch(err, null)
  assert.equal(reported[0].surface, 'unknown')
})

// ── 2. 视图注册表幂等 ────────────────────────────────────────────────────────
test('viewRegistry：注册/卸载幂等，重复注册单条，陈旧 disposer 不误删', () => {
  const { mod } = loadBundle()
  const r = mod.createViewRegistry()
  let notified = 0
  const unsub = r.subscribe(() => { notified++ })
  const c1 = () => {}
  const c2 = () => {}

  // 注册幂等：同 id 重复注册只保留一条（后者覆盖）
  r.register({ id: 'vuln', label: '漏洞', order: 20, component: c1 })
  r.register({ id: 'vuln', label: '漏洞', order: 20, component: c1 })
  assert.equal(r.size(), 1)

  // 排序：按 order 升序
  r.register({ id: 'asset', label: '资产', order: 30, component: c1 })
  r.register({ id: 'audit', label: '审计', order: 10, component: c1 })
  assert.equal(r.list().map((x) => x.id).join(','), 'audit,vuln,asset')

  // dispose 幂等：第二次调用返回 false
  const d = r.register({ id: 'task', label: '任务', order: 60, component: c1 })
  assert.equal(d(), true)
  assert.equal(d(), false)
  assert.equal(r.has('task'), false)

  // 卸载未知 id 返回 false
  assert.equal(r.unregister('nope'), false)

  // 陈旧 disposer：不得误删后来者的注册
  const dOld = r.register({ id: 'report', label: '报告', order: 80, component: c1 })
  r.register({ id: 'report', label: '报告', order: 80, component: c2 })
  assert.equal(dOld(), false, '陈旧 disposer 必须拒绝删除新注册')
  assert.equal(r.get('report').component, c2)

  // 校验：缺 id / component 抛错
  assert.throws(() => r.register({ component: c1 }), /id 必填/)
  assert.throws(() => r.register({ id: 'x' }), /component 必填/)

  // 订阅 dispoable 且通知次数 > 0
  unsub()
  const before = notified
  r.register({ id: 'know', label: '知识', order: 70, component: c1 })
  assert.equal(notified, before, '退订后不应再收到通知')
  assert.ok(before > 0)
})

test('viewRegistry：apply 提供 secDashboardViews/secUiBus 服务且与模块导出一致', () => {
  const { mod, sandbox } = loadBundle()
  const provided = {}
  mod.apply({ provide: (n, v) => { provided[n] = v } })
  assert.equal(provided.secDashboardViews, mod.viewRegistry)
  assert.equal(provided.secUiBus, mod.secUiBus)
  // 冒烟门禁打卡
  assert.equal(sandbox.window.__silksecSurfaceHealth['ui-core'].status, 'ok')
})

// ── 4. P6 共享契约：requires 能力探测 + 展示件 + session opener ────────────────
test('viewRegistry.requires：服务缺席的条目 list/get 过滤（tab 静默隐藏），probe 到位后可见', () => {
  const { mod } = loadBundle()
  const r = mod.createViewRegistry()
  const c = () => {}
  const d = r.register({ id: 'findings', label: '漏洞', order: 20, component: c, requires: ['connection'] })
  // 缺省 probe 视为可用（旧行为兼容）
  assert.equal(r.size(), 1)
  // probe 判定 connection 缺席 → 过滤且不占 order
  mod.setServiceProbe((n) => n !== 'connection')
  r.refresh()
  assert.equal(r.size(), 0)
  assert.equal(r.get('findings'), null)
  assert.equal(r.list().length, 0)
  // 服务到位 → 重新可见
  mod.setServiceProbe((n) => n === 'connection')
  r.refresh()
  assert.equal(r.size(), 1)
  assert.equal(r.list()[0].id, 'findings')
  // 无 requires 的条目不受 probe 影响
  r.register({ id: 'audit', label: '审计', order: 110, component: c })
  mod.setServiceProbe(() => false)
  r.refresh()
  assert.equal(r.list().map((x) => x.id).join(','), 'audit')
  d()
})

test('P6 共享展示件：sevPill/statusPill/programCell/insightChip/sortableTh/hlText 导出可用', () => {
  const { mod } = loadBundle()
  assert.equal(typeof mod.sevPill, 'function')
  assert.equal(typeof mod.statusPill, 'function')
  assert.equal(typeof mod.confPill, 'function')
  assert.equal(typeof mod.taskPill, 'function')
  assert.equal(typeof mod.programCell, 'function')
  assert.equal(typeof mod.insightChip, 'function')
  assert.equal(typeof mod.sortableTh, 'function')
  assert.equal(typeof mod.hlText, 'function')
  assert.equal(typeof mod.SessionLink, 'function')
  assert.equal(typeof mod.setSessionOpener, 'function')
  // programCell 未归属 → 「未关联」
  const unlinked = mod.programCell('_legacy')
  assert.equal(unlinked.type, 'span')
  // hlText 命中片段高亮为 warn 令牌
  const hl = mod.hlText('abcSQLdef', 'sql', 'k')
  assert.ok(Array.isArray(hl) && hl.some((n) => n && n.props && n.props.style && n.props.style.color === mod.T.warn))
})

test('SessionLink：setSessionOpener 注入后点击跳链；未注入渲染「—」', () => {
  const { mod } = loadBundle()
  const opened = []
  mod.setSessionOpener((id) => opened.push(id))
  const link = mod.SessionLink({ id: 'session-abc' })
  assert.equal(typeof link.props.onClick, 'function')
  link.props.onClick()
  assert.deepEqual(opened, ['session-abc'])
  const empty = mod.SessionLink({ id: null })
  assert.equal(empty.type, 'span')
  mod.setSessionOpener(null)
})

test('viewRegistry：group 缺省 primary，more 组透传', () => {
  const { mod } = loadBundle()
  const r = mod.createViewRegistry()
  const c = () => {}
  r.register({ id: 'findings', label: '漏洞', order: 20, component: c })
  r.register({ id: 'knowledge', label: '知识', order: 70, group: 'more', component: c })
  const byId = {}
  r.list().forEach((e) => { byId[e.id] = e })
  assert.equal(byId.findings.group, 'primary', '缺省 group = primary（旧视图包兼容）')
  assert.equal(byId.knowledge.group, 'more')
})

test('ensureBaseStyles：apply 注入唯一基样式表，覆盖 9 类共享控件，零颜色字面量', () => {
  const { mod, styles } = loadBundle()
  mod.apply({ provide: () => {} })
  const base = styles.find((s) => s.dataset && s.dataset.pluginCss === mod.BASE_CSS_KEY)
  assert.ok(base, 'apply 必须注入 data-plugin-css=silksec-ui-core-base 的基样式表')
  for (const cls of ['silksec-btn', 'silksec-btn-confirm', 'silksec-icon-btn', 'silksec-icon-btn-danger', 'silksec-input', 'silksec-tab', 'silksec-kpi', 'silksec-row', 'silksec-chip', 'silksec-dash-dialog']) {
    assert.ok(base.textContent.indexOf('.' + cls) >= 0, '基样式表须含 .' + cls)
  }
  assert.ok(base.textContent.indexOf('.silksec-tab[data-on="true"]') >= 0, 'tab 选中态绯红下划线规则须存在')
  assert.ok(base.textContent.indexOf('.silksec-kpi:hover') >= 0, 'KPI hover 升档规则须存在')
  // 零颜色字面量（只允许 var(--dsw-*) / var(--silksec-*) / var(--ds-*) 与 transparent）
  assert.ok(!/#[0-9a-fA-F]{3,8}\b|\brgba?\s*\(/.test(base.textContent), '基样式表不得含 hex/rgb 字面量')
})

test('fmtNum：千分位；opIcon back/refresh 新增', () => {
  const { mod } = loadBundle()
  assert.equal(mod.fmtNum(96814), '96,814')
  assert.equal(mod.fmtNum(0), '0')
  assert.equal(mod.fmtNum(null), '—')
  assert.equal(mod.fmtNum(357), '357')
  assert.ok(mod.opIcon('back') && mod.opIcon('refresh'), 'opIcon 支持 back/refresh')
})

test('createSecUiBus：订阅/退订/emitter 异常隔离', () => {
  const { mod } = loadBundle()
  const bus = mod.createSecUiBus()
  const got = []
  const off = bus.on('open:approval', (p) => got.push(p))
  assert.equal(bus.emit('open:approval', 1), 1)
  off()
  off() // 幂等
  assert.equal(bus.emit('open:approval', 2), 0)
  assert.deepEqual(got, [1])
  // handler 抛错不阻断其他（错误隔离）
  bus.on('x', () => { throw new Error('bad') })
  const seen = []
  bus.on('x', (p) => seen.push(p))
  assert.equal(bus.emit('x', 'ok'), 2)
  assert.deepEqual(seen, ['ok'])
})
