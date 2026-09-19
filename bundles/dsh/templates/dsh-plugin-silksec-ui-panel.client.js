/**
 * @silksec/ui-panel — client half (browser bundle)，16-dashboard P1 主面板。
 *
 * 看板本体的**原生承载面**：把看板从「侧边栏 footer 按钮 → Modal」迁移到 DSH
 * 官方预留的一级页面通道（§四.1）：
 *   - `main` keyed 槽（root，保留键 conversation）：整屏主面板 DashboardPanel
 *   - `sidebar.panellist`（list）：与会话平级的侧边栏导航行「看板」（PanelIcon）
 *   - 打开/返回：ctx.layout.selectPanel('silksec-dashboard') / selectPanel(null)
 *   - 快速连点竞态：ctx.layout.beginNavigation() 返回 AbortSignal，旧信号 aborted 即不提交
 *
 * DashboardPanel 是**通用渲染器**：消费 @silksec/ui-core 的 viewRegistry（list() 按
 * order 排序），只渲染 active 条目的 component，并传统一 prop bag：
 *   { rpc, workspaces, stats, approvals, memcore, ops, navigate, pending, reloadShared }
 * 视图组件由 7 个独立 @silksec/sec-dashboard-view-<domain> 包登记为自足 wrapper
 * （内部自持 query/handler），是无挂载感知的纯组件——同一组件可挂主面板。
 *
 * 降级链（能力探测，非版本判断；§六.3）：
 *   main + panellist + selectPanel（首选）
 *     ├ panellist 缺席 → 侧边栏行内 selectPanel 兜底
 *     └ layout/main 缺席 → 不渲染主面板（旧单体 Modal 兜底已于 2026-09-19 删除）
 *
 * 隔离：每个视图包 SilksecErrorBoundary（崩溃只炸单面）；本包 apply 崩溃只销毁自身 fiber。
 * 视觉遵循丝之歌主题规范：chrome 由宿主渲染自动吃令牌，页头/KPI 用 ui-core styles/T。
 * 本文件零颜色字面量。
 */
window.__ModuleLoader__.load({
  id: '@silksec/ui-panel',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    var React = require('react')
    // 16-dashboard P0：跨 bundle require 看板 UI 内核（dsh.client.inject 声明随 setup 脚本）。
    var uiCore = null
    try { uiCore = require('@silksec/ui-core') } catch (e) { uiCore = null }
    var el = React.createElement

    // apply 时捕获的客户端 root context（用于在渲染期按需读 connection/layout，避免时序陷阱）
    var serviceRef = { ctx: null }

    function getService(name) {
      var ctx = serviceRef.ctx
      if (!ctx || typeof ctx.get !== 'function') return null
      try { return ctx.get(name) } catch (e) { return null }
    }
    function getLayout() {
      var layout = getService('layout')
      return (layout && typeof layout.selectPanel === 'function') ? layout : null
    }
    // /silksec-dashboard RPC caller（与 sec-dashboard 视图内写操作同通道）
    function getRpc() {
      var connection = getService('connection')
      if (!connection || !connection.rpc || typeof connection.rpc.call !== 'function') return null
      return function (endpoint, payload) {
        return connection.rpc.call('/silksec-dashboard', endpoint, payload || {}).then(function (result) {
          if (result && result.ok) return result.value
          var error = result && result.error
          throw new Error(error && error.message ? error.message : 'rpc failed')
        })
      }
    }

    // ── 打开/返回主面板：beginNavigation() 防快速连点竞态（官方服务自带） ──────
    // 每次导航作废上一次 pending 信号；被 aborted 的旧信号不得再提交 UI 状态。
    function navigateToPanel(layout, panelId) {
      if (!layout || typeof layout.selectPanel !== 'function') return false
      var signal = null
      try { signal = (typeof layout.beginNavigation === 'function') ? layout.beginNavigation() : null } catch (e) { signal = null }
      function commit() {
        if (signal && signal.aborted) return false
        try { layout.selectPanel(panelId); return true } catch (e) { return false }
      }
      if (signal && typeof Promise !== 'undefined') Promise.resolve().then(commit)
      else commit()
      return true
    }

    // ── 侧边栏一级导航行图标（owner props {size, active}） ─────────────────────
    function PanelIcon(props) {
      var p = props || {}
      return el('span', {
        style: {
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          color: p.active ? uiCore.T.brand : uiCore.T.label2,
        },
      }, uiCore.spoolIcon(p.size || 16))
    }

    // ── 主面板（main keyed 槽 occupant；通用渲染器，不感知任何域） ─────────────
    function DashboardPanel() {
      var registry = uiCore.viewRegistry
      var useRpcCore = uiCore.useRpc

      var es = React.useState(function () { return registry.list() })
      var entries = es[0]; var setEntries = es[1]
      var as = React.useState(null)
      var activeId = as[0]; var setActiveId = as[1]
      var ps = React.useState(null)
      var pending = ps[0]; var setPending = ps[1]
      var fts = React.useState(0)
      var refreshTick = fts[0]; var setRefreshTick = fts[1]

      // 动态注册：sec-dashboard 视图可能晚于本面板挂载（cordis client 加载顺序不保证）
      React.useEffect(function () {
        return registry.subscribe(function (list) { setEntries(list) })
      }, [])

      var rpc = getRpc()
      var statsState = useRpcCore(function () { return { endpoint: 'stats' } }, [refreshTick], rpc || undefined)
      var wsState = useRpcCore(function () { return { endpoint: 'workspaces' } }, [refreshTick], rpc || undefined)
      var approvalsState = useRpcCore(function () { return { endpoint: 'approvalList', payload: { limit: 100 } } }, [refreshTick], rpc || undefined)
      var opsState = useRpcCore(function () { return { endpoint: 'ops' } }, [refreshTick], rpc || undefined)
      var memState = useRpcCore(function () { return { endpoint: 'memcore' } }, [refreshTick], rpc || undefined)

      var activeEntry = null
      for (var i = 0; i < entries.length; i++) { if (entries[i].id === activeId) { activeEntry = entries[i]; break } }
      if (!activeEntry && entries.length) activeEntry = entries[0]
      var effActiveId = activeEntry ? activeEntry.id : null
      var activePending = (pending && pending.id === effActiveId) ? pending.payload : null

      var navigate = {
        select: function (id, p) {
          if (p !== undefined) setPending({ id: id, payload: p }); else setPending(null)
          setActiveId(id)
        },
        consume: function (id) { setPending(function (cur) { return (cur && cur.id === id) ? null : cur }) },
        selectPanel: function (id) { return navigateToPanel(getLayout(), id) },
      }

      var s = statsState.data || {}
      var wsItems = (wsState.data && wsState.data.items) || []
      var wsCount = (wsState.data && wsState.data.available) ? wsItems.length : null
      var approvalPending = (approvalsState.data && approvalsState.data.pending) || 0
      var kpis = [
        { label: '漏洞', value: uiCore.fmtBytes(s.findings), tab: 'findings' },
        { label: '资产', value: uiCore.fmtBytes(s.assets), tab: 'assets' },
        { label: '接口', value: uiCore.fmtBytes(s.endpoints), tab: 'endpoints' },
        { label: '工作区', value: wsCount === null ? '—' : uiCore.fmtBytes(wsCount), tab: 'tasks' },
        { label: '任务', value: uiCore.fmtBytes(s.tasks), tab: 'tasks' },
        { label: '事实', value: uiCore.fmtBytes(s.facts !== undefined ? s.facts : s.blackboard_keys), tab: 'facts' },
      ]

      var tabs = entries.map(function (entry) {
        var label = entry.label
        if (entry.id === 'approvals' && approvalPending) label += ' · ' + approvalPending
        return el('button', {
          key: entry.id, type: 'button', className: 'silksec-tab',
          'data-on': effActiveId === entry.id ? 'true' : undefined,
          onClick: function () { setPending(null); setActiveId(entry.id) },
        }, label)
      })

      var activeNode = activeEntry
        ? el(uiCore.SilksecErrorBoundary, { surface: 'dashboard-panel:' + activeEntry.id, title: activeEntry.label },
            el(activeEntry.component, {
              key: activeEntry.id,
              rpc: rpc,
              workspaces: wsState.data,
              stats: statsState.data,
              approvals: approvalsState.data,
              memcore: memState.data,
              ops: opsState.data,
              navigate: navigate,
              pending: activePending,
              reloadShared: function () { approvalsState.reload() },
            }))
        : el(uiCore.EmptyState, { text: '视图注册表为空（域视图包未加载？）' })

      return el('div', { style: { ...uiCore.styles.root, height: '100%' } },
        el('div', { style: uiCore.styles.header },
          el('div', null,
            el('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
              el('span', { style: { color: uiCore.T.brand, display: 'inline-flex' } }, uiCore.spoolIcon(16)),
              el('div', { style: uiCore.styles.pageT }, '安全看板')),
            el('div', { style: uiCore.styles.pageSub, title: '写操作全部写入 audit.jsonl；行内跳链回来源会话（详情一律在会话里看）' }, '全局安全态势 · 漏洞 / 资产 / 任务 / 知识 / 授权 / 审计'),
            el('div', { style: uiCore.styles.silkDivider })),
          el('span', { style: { display: 'inline-flex', gap: 8 } },
            el('button', { type: 'button', className: 'silksec-btn', title: '返回当前会话', onClick: function () { navigate.selectPanel(null) } }, '返回会话'),
            el('button', { type: 'button', className: 'silksec-btn', title: '重新加载主面板数据', onClick: function () { setRefreshTick(function (t) { return t + 1 }) } }, '刷新'))),
        statsState.error ? el('div', { style: uiCore.styles.errorLine }, '统计加载失败: ' + statsState.error) : el('div', {
          style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 140px), 1fr))', gap: 8, marginBottom: 12 },
        }, kpis.map(function (kpi) {
          return el('button', {
            key: kpi.label, type: 'button', className: 'silksec-kpi', title: '查看' + kpi.label,
            onClick: function () { setPending(null); setActiveId(kpi.tab) },
          }, el('div', { style: uiCore.styles.cardL }, kpi.label), el('div', { style: uiCore.styles.cardV }, kpi.value))
        })),
        (memState.data && memState.data.loaded === false)
          ? el('div', { style: { ...uiCore.styles.errorLine, color: uiCore.T.warn } }, '⚠ memcore 记忆治理插件未加载：写入不校验、读取全量可见（fail-open）。检查 profile 是否含 @silksec/sec-memcore。')
          : null,
        (opsState.data && opsState.data.healthy === false)
          ? el('div', { style: { ...uiCore.styles.errorLine, color: uiCore.T.warn } }, '⚠ 纪律健康度告警（' + (opsState.data.alerts || []).length + '）：' + (opsState.data.alerts || []).slice(0, 3).join('；') + '（详见 ops 端点）')
          : null,
        el('div', { style: uiCore.styles.tabBar }, tabs),
        el('div', { style: uiCore.styles.body }, activeNode))
    }

    // ── cordis 客户端插件：把主面板 + 导航行注册进官方承载面 ────────────────────
    exports.name = 'silksec-ui-panel'
    exports.inject = ['slots']
    exports.apply = function (ctx) {
      serviceRef.ctx = ctx
      var slots = ctx.get('slots')
      if (!slots || typeof slots.register !== 'function' || typeof slots.inject !== 'function') return
      // ui-core 缺席 → 不注册主面板（能力探测；旧 Modal 兜底已删）
      if (!uiCore || !uiCore.viewRegistry || typeof uiCore.viewRegistry.list !== 'function') return

      function install() {
        var disposers = []
        // 时序纪律：一切注册走 slots.inject(key, cb)（声明生命周期）+ ctx.effect（自动 disposer）
        // keyed 槽用 options.key（list 槽才用 options.id）；key 必须与 panellist 的 id 一致
        disposers.push(slots.inject('main', function () {
          return slots.register({ name: 'main', key: 'silksec-dashboard', order: 30 }, DashboardPanel)
        }))
        // panellist 缺席不抛：silent degradation
        disposers.push(slots.inject('sidebar.panellist', function () {
          return slots.register({ name: 'sidebar.panellist', id: 'silksec-dashboard', order: 30, label: '看板' }, PanelIcon)
        }))
        return function () {
          disposers.forEach(function (d) { try { if (typeof d === 'function') d() } catch (e) {} })
        }
      }
      if (typeof ctx.effect === 'function') ctx.effect(install)
      else install()

      try { uiCore.markSurfaceHealth('ui-panel', 'ok') } catch (e) {}
    }

    // 稳定导出面（供单测 / 降级探测）
    exports.DashboardPanel = DashboardPanel
    exports.PanelIcon = PanelIcon
    exports.navigateToPanel = navigateToPanel

    return module.exports
  },
})
