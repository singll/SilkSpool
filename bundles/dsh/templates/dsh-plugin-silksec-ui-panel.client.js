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
    // 19-ui-unify 补丁：去掉安全中心前的丝轴图标，与会话/工作区条目同层级（纯文字行）。
    function PanelIcon() {
      return null
    }

    // ── 打开审批/任务中心（右侧栏 page tab 优先；缺席则 secUiBus + 主面板降级视图） ──
    function openRightTab(kind, busEvent, degradedId) {
      var sr = getService('sidebarRight')
      if (sr && typeof sr.openTab === 'function') {
        try { sr.openTab(kind); return 'tab' } catch (e) { /* 无在屏会话 seat → 降级 */ }
      }
      try { uiCore.secUiBus.emit(busEvent, {}) } catch (e) {}
      if (degradedId && uiCore.viewRegistry && typeof uiCore.viewRegistry.has === 'function' && uiCore.viewRegistry.has(degradedId)) {
        return 'degraded:' + degradedId
      }
      return 'none'
    }

    // ── 主面板（main keyed 槽 occupant；通用渲染器，不感知任何域） ─────────────
    // 19-ui-unify §2.4/2.5/3.2：自有 chrome（40px 页头 + 图标钮）+ 频次分层 tab
    // （一线 4 视图 + 「更多」二级导航）；KPI 改「今日待办 + 风险暴露」五卡 + 库存副条。
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
      var mms = React.useState(null)
      var lastMoreId = mms[0]; var setLastMoreId = mms[1]

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

      var primaryEntries = entries.filter(function (e) { return e.group !== 'more' })
      var moreEntries = entries.filter(function (e) { return e.group === 'more' })
      var activeInMore = !!(activeEntry && activeEntry.group === 'more')
      var effMoreId = activeInMore ? effActiveId : (lastMoreId || (moreEntries[0] ? moreEntries[0].id : null))

      var navigate = {
        select: function (id, p) {
          if (p !== undefined) setPending({ id: id, payload: p }); else setPending(null)
          var merged = null
          for (var j = 0; j < entries.length; j++) { if (entries[j].id === id) { merged = entries[j]; break } }
          if (merged && merged.group === 'more') setLastMoreId(id)
          setActiveId(id)
        },
        consume: function (id) { setPending(function (cur) { return (cur && cur.id === id) ? null : cur }) },
        selectPanel: function (id) { return navigateToPanel(getLayout(), id) },
      }

      // 右侧栏/降级跳链：待审批 / 任务
      function openApproval() {
        var where = openRightTab('silksec-approval', 'open:approval', 'approval-degraded')
        if (where.indexOf('degraded:') === 0) navigate.select(where.slice(9))
      }
      function openTask() {
        var where = openRightTab('silksec-task', 'open:task', 'task-degraded')
        if (where.indexOf('degraded:') === 0) navigate.select(where.slice(9))
      }

      var s = statsState.data || {}
      var wsItems = (wsState.data && wsState.data.items) || []
      var wsCount = (wsState.data && wsState.data.available) ? wsItems.length : null
      var approvalPending = (s.approval && s.approval.pending) || 0
      var v = s.vuln || {}
      var t = s.tasks || {}
      var disc = s.discipline || null
      var inv = s.inventory || {}
      function num(x) { return (x === undefined || x === null) ? '—' : uiCore.fmtNum(x) }
      var kpis = [
        {
          key: 'approval', label: '待审批', value: num(s.approval ? s.approval.pending : null),
          sub: (s.approval && s.approval.pending > 0 && s.approval.oldest_days > 0) ? '最老等待 ' + s.approval.oldest_days + ' 天' : '无待办',
          onClick: openApproval, title: '打开审批中心（右侧栏；无会话时降级主面板）',
        },
        {
          key: 'vuln-new', label: '待处理漏洞', value: num(s.vuln ? v.new : null),
          sub: (v.critical || v.high) ? '严重/高危 ' + ((v.critical || 0) + (v.high || 0)) : '均为中低危',
          subColor: ((v.critical || 0) + (v.high || 0)) > 0 ? uiCore.T.warn : null,
          onClick: function () { navigate.select('findings', { filters: { status: 'new' } }) }, title: '漏洞视图（预置 status=new）',
        },
        {
          key: 'candidate', label: '待验证候选', value: num(s.vuln ? v.candidate : null),
          sub: '评测回流判定', onClick: function () { navigate.select('findings', { filters: { noise: '1' } }) }, title: '漏洞视图（仅待验证候选 noise=1）',
        },
        {
          key: 'submit', label: '待提交 SRC', value: num(s.vuln ? v.unsubmitted : null),
          sub: (v.unsubmitted || 0) > 0 ? '确认后未提交' : '无积压',
          subColor: (v.unsubmitted || 0) > 0 ? uiCore.T.warn : null,
          onClick: function () { navigate.select('findings', { filters: { status: 'confirmed' } }) }, title: '漏洞视图（预置 status=confirmed；提交闭环见 vuln_submission_queue）',
        },
        {
          key: 'tasks', label: '运行中/阻塞任务', value: num(s.tasks ? ((t.running || 0) + (t.blocked || 0)) : null),
          sub: (t.blocked || 0) > 0 ? '阻塞 ' + t.blocked + (t.failed ? ' · 失败 ' + t.failed : '') : (t.failed ? '失败 ' + t.failed : '无阻塞'),
          subColor: (t.blocked || 0) > 0 ? uiCore.T.warn : null,
          onClick: openTask, title: '打开任务中心（右侧栏；无会话时降级主面板）',
        },
        {
          key: 'discipline', label: '纪律告警', value: disc ? uiCore.fmtNum((disc.alerts || []).length) : '—',
          sub: disc && (disc.alerts || []).length ? String(disc.alerts[0]).slice(0, 40) : (disc ? '纪律在线 ✓' : '数据不可用'),
          subColor: disc && (disc.alerts || []).length ? uiCore.T.warn : (disc ? uiCore.T.success : null),
          onClick: function () { navigate.select('audit') }, title: '审计视图（台账纪律）',
        },
      ]

      var tabs = primaryEntries.map(function (entry) {
        var label = entry.label
        if (entry.id === 'approvals' && approvalPending) label += ' · ' + approvalPending
        return el('button', {
          key: entry.id, type: 'button', className: 'silksec-tab', role: 'tab',
          'aria-selected': effActiveId === entry.id ? 'true' : 'false',
          'data-on': effActiveId === entry.id ? 'true' : undefined,
          onClick: function () { setPending(null); setActiveId(entry.id) },
        }, label)
      })
      if (moreEntries.length) {
        var moreCur = activeInMore ? activeEntry : null
        tabs.push(el('button', {
          key: '__more', type: 'button', className: 'silksec-tab',
          'data-on': activeInMore ? 'true' : undefined,
          title: '低频浏览/管理面：知识 / 学习 / 报告 / 审计',
          onClick: function () { var id = effMoreId; if (id) navigate.select(id) },
        }, '更多' + (moreCur ? ' · ' + moreCur.label : '')))
      }

      var secondaryTabs = activeInMore
        ? el('div', { style: { ...uiCore.styles.tabBar, marginTop: 4, marginBottom: 0 }, role: 'tablist' }, moreEntries.map(function (entry) {
            return el('button', {
              key: 'more-' + entry.id, type: 'button', className: 'silksec-tab', role: 'tab',
              style: { height: 26, ...uiCore.F.xxs },
              'aria-selected': effActiveId === entry.id ? 'true' : 'false',
              'data-on': effActiveId === entry.id ? 'true' : undefined,
              onClick: function () { setPending(null); navigate.select(entry.id) },
            }, entry.label)
          }))
        : null

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

      var invItems = [
        { label: '漏洞', value: inv.findings, tab: 'findings' },
        { label: '资产', value: inv.assets, tab: 'assets' },
        { label: '接口', value: inv.endpoints, tab: 'endpoints' },
        { label: '事实', value: inv.facts, tab: 'facts' },
        { label: '工作区', value: wsCount, tab: 'tasks' },
      ]

      return el('div', { style: { ...uiCore.styles.root, height: '100%' } },
        el('div', { style: { ...uiCore.styles.header, minHeight: 40, marginBottom: 10, paddingBottom: 8, borderBottom: '1px solid ' + uiCore.T.border } },
          el('div', { style: { minWidth: 0 } },
            el('div', { style: uiCore.styles.pageT }, '安全中心'),
            el('div', { style: uiCore.styles.pageSub, title: '写操作全部写入 audit.jsonl；行内跳链回来源会话（详情一律在会话里看）' }, '全局安全态势 · 漏洞 / 资产 / 接口 / 事实 / 知识 / 报告 / 审计')),
          el('span', { style: { display: 'inline-flex', gap: 6 } },
            el('button', { type: 'button', className: 'silksec-icon-btn', title: '返回当前会话', 'aria-label': '返回当前会话', onClick: function () { navigate.selectPanel(null) } }, uiCore.opIcon('back')),
            el('button', { type: 'button', className: 'silksec-icon-btn', title: '重新加载主面板数据', 'aria-label': '刷新', onClick: function () { setRefreshTick(function (x) { return x + 1 }) } }, uiCore.opIcon('refresh')))),
        statsState.error ? el('div', { style: uiCore.styles.errorLine }, '统计加载失败: ' + statsState.error) : el('div', null,
          el('div', {
            style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 150px), 1fr))', gap: 8 },
          }, kpis.map(function (kpi) {
            return el('button', {
              key: kpi.key, type: 'button', className: 'silksec-kpi', title: kpi.title,
              onClick: kpi.onClick,
            },
              el('div', { style: uiCore.styles.cardL }, kpi.label),
              el('div', { style: uiCore.styles.cardV }, kpi.value),
              el('div', { style: { color: kpi.subColor || uiCore.T.label3, ...uiCore.F.xxxs, maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: kpi.sub }, kpi.sub))
          })),
          el('div', { style: { display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap', marginTop: 8, color: uiCore.T.label3, ...uiCore.F.xxxs } },
            el('span', { style: { color: uiCore.T.label3 } }, '库存'),
            invItems.map(function (it) {
              return el('button', {
                key: 'inv-' + it.label, type: 'button', className: 'silksec-chip',
                style: { height: 20, padding: '0 6px', border: 'none', background: 'transparent', color: uiCore.T.label3 },
                title: '打开' + it.label,
                onClick: function () { navigate.select(it.tab) },
              }, it.label + ' ' + num(it.value))
            }))),
        (s.degraded && s.degraded.length)
          ? el('div', { style: { ...uiCore.styles.errorLine, color: uiCore.T.warn }, title: '对应 KPI 显示「—」，其余指标照常' }, '⚠ 部分数据源降级：' + s.degraded.join(' / ') + '（重试刷新或查看服务日志）')
          : null,
        (memState.data && memState.data.loaded === false)
          ? el('div', { style: { ...uiCore.styles.errorLine, color: uiCore.T.warn } }, '⚠ memcore 记忆治理插件未加载：写入不校验、读取全量可见（fail-open）。检查 profile 是否含 @silksec/sec-memcore。')
          : null,
        (opsState.data && opsState.data.healthy === false)
          ? el('div', { style: { ...uiCore.styles.errorLine, color: uiCore.T.warn } }, '⚠ 纪律健康度告警（' + (opsState.data.alerts || []).length + '）：' + (opsState.data.alerts || []).slice(0, 3).join('；') + '（详见 ops 端点）')
          : null,
        el('div', { style: uiCore.styles.tabBar, role: 'tablist' }, tabs),
        secondaryTabs,
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
          return slots.register({ name: 'sidebar.panellist', id: 'silksec-dashboard', order: 30, label: '安全中心' }, PanelIcon)
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
