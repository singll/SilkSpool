/**
 * @silksec/sec-dashboard-view-endpoint — client half (browser bundle)，16-dashboard P6 逐域视图拆分。
 *
 * 接口域浏览视图（16-dashboard §1.7「接口」视图 + 16-dashboard §1.3「主面板视图」）。
 * 接口是资产的子维度，平铺千行无浏览价值：主表按主机聚合（endpointHosts），展开主机
 * 看明细（endpoints）；本视图侧重跨主机的路径检索。从旧单体
 * dsh-plugin-sec-dashboard.client.js 拆出，**自持 query/handler**、纯组件、无挂载感知：
 * 经 @silksec/ui-core 的 viewRegistry 注册，ui-panel 主面板按 order 装配。
 *
 * 契约（与旧 PanelView 的 endpoints 分支逐项等价）：
 *   - 读：endpointHosts（分页/路径全局搜索 + program_id 筛选）、endpoints（展开主机明细，
 *     {host, limit:100}）；
 *   - 跳链：onPickHost → navigate.select('assets', { q: host })（去资产视图搜索该主机）。
 *   - requires:['connection'] 缺席 → 不注册（tab 静默隐藏，不抛、不占 order）。
 *
 * 视觉遵循丝之歌主题规范：全部经 ui-core 令牌（--dsw-alias-* / --silksec-sev-*），
 * 本文件零颜色字面量。崩溃由 ui-panel 的 SilksecErrorBoundary 单面隔离。
 */
window.__ModuleLoader__.load({
  id: '@silksec/sec-dashboard-view-endpoint',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    var React = require('react')
    var uiCore = null
    try { uiCore = require('@silksec/ui-core') } catch (e) { uiCore = null }
    var el = React.createElement

    // 自持 RPC（apply 时从 connection 捕获；ui-panel prop bag 的 rpc 作兜底）
    var serviceRef = { rpc: null }
    function ownRpc(endpoint, payload) {
      if (!serviceRef.rpc) return Promise.reject(new Error('连接通道不可用'))
      return serviceRef.rpc(endpoint, payload || {})
    }

    // 单主机接口明细：展开主机时按需拉取（接口是资产子维度，不做全局平铺）
    function EndpointListPanel(props) {
      var callRpc = (typeof props.callRpc === 'function') ? props.callRpc : ownRpc
      var st = React.useState({ loading: true, rows: null, error: null })
      var d = st[0]; var setD = st[1]
      React.useEffect(function () {
        var alive = true
        callRpc('endpoints', { host: props.host, limit: 100 })
          .then(function (res) { if (alive) setD({ loading: false, rows: (res && res.rows) || [], error: null }) })
          .catch(function (e) { if (alive) setD({ loading: false, rows: null, error: e && e.message ? e.message : String(e) }) })
        return function () { alive = false }
      }, [props.host])
      var METHOD_COLOR = { GET: uiCore.T.label2, POST: uiCore.T.brand, PUT: uiCore.T.warn, DELETE: uiCore.T.error, PATCH: uiCore.T.warn }
      if (d.loading) return el('div', { style: { padding: '10px 14px', background: uiCore.T.layer1 } }, el(uiCore.SkeletonRows, { rows: 3 }))
      if (d.error) return el('div', { style: { ...uiCore.styles.errorLine, padding: '10px 14px' } }, '接口加载失败: ' + d.error)
      return el('div', { style: { padding: '10px 14px', background: uiCore.T.layer1, borderLeft: '2px solid ' + uiCore.T.border3 } },
        el('div', { style: { display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 320, overflowY: 'auto', minWidth: 0 } },
          (d.rows || []).map(function (e, i) {
            return el('div', { key: i, style: { display: 'flex', gap: 8, alignItems: 'baseline', fontFamily: uiCore.MONO, fontSize: 12, color: uiCore.T.label2 } },
              el('span', { style: { color: METHOD_COLOR[e.method] || uiCore.T.label2, width: 52, flexShrink: 0 } }, e.method || '—'),
              el('span', { style: { wordBreak: 'break-all', color: uiCore.T.label } }, e.path || '/'),
              e.status ? el('span', { style: { color: uiCore.T.label3, flexShrink: 0 } }, e.status) : null,
              el('span', { style: { color: uiCore.T.label3, flexShrink: 0, marginLeft: 'auto' } }, uiCore.fmtTime(e.last_seen)))
          })))
    }

    // 主机聚合主表：展开行内嵌单主机接口明细；行首图标跳资产视图（钻取指纹/接口/漏洞/同族）
    function EndpointsView(props) {
      var query = props.query
      var exp = React.useState(null)
      var expandedHost = exp[0]; var setExpandedHost = exp[1]
      return el(uiCore.ViewBody, { query: query, emptyText: '暂无接口数据' }, function (rows) {
        return el('div', { style: { overflowX: 'auto', minWidth: 0 } },
          el('table', { style: uiCore.styles.tableStyle },
            el('colgroup', null,
              el('col', null),
              el('col', { style: { width: 66 } }),
              el('col', { style: { width: 180 } }),
              el('col', { style: { width: 110 } }),
              el('col', { style: { width: 100 } }),
              el('col', { style: { width: 40 } })),
            el('thead', null, el('tr', { style: uiCore.styles.theadRow },
              el('th', { style: uiCore.styles.th }, '主机'),
              el('th', { style: uiCore.styles.th }, '接口数'),
              el('th', { style: uiCore.styles.th }, '方法'),
              el('th', { style: uiCore.styles.th }, '项目'),
              el('th', { style: uiCore.styles.th }, '最近发现'),
              el('th', { style: uiCore.styles.th }, ''))),
            el('tbody', null, rows.map(function (r) {
              var isOpen = expandedHost === r.host
              return el(React.Fragment, { key: r.host },
                el('tr', {
                  className: 'silksec-row', role: 'button', tabIndex: 0, 'aria-expanded': isOpen ? 'true' : 'false',
                  style: { cursor: 'pointer', boxShadow: isOpen ? 'inset 2px 0 0 ' + uiCore.T.border3 : undefined },
                  title: '点击展开该主机的接口明细',
                  onClick: function () { setExpandedHost(isOpen ? null : r.host) },
                  onKeyDown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpandedHost(isOpen ? null : r.host) } },
                },
                  el('td', { style: uiCore.styles.tdMono, title: r.host },
                    el('span', { style: { color: uiCore.T.label3, marginRight: 6, ...uiCore.F.xxxs } }, isOpen ? '▾' : '▸'),
                    r.host),
                  el('td', { style: uiCore.styles.tdMono }, String(r.n)),
                  el('td', { style: uiCore.styles.td, title: r.methods || '' }, (r.methods || '').split(',').filter(Boolean).map(function (m) {
                    return el('span', { key: m, style: { ...uiCore.styles.pill, fontFamily: uiCore.MONO, fontSize: 11 } }, m)
                  })),
                  el('td', { style: uiCore.styles.td }, uiCore.programCell(r.program_id)),
                  el('td', { style: uiCore.styles.tdMono }, uiCore.fmtTime(r.last_seen)),
                  el('td', { style: uiCore.styles.td, onClick: function (e) { e.stopPropagation() } },
                    el('button', {
                      type: 'button', className: 'silksec-icon-btn',
                      title: '在资产视图中搜索该主机（钻取指纹 / 接口 / 漏洞 / 同族）', 'aria-label': '去资产视图',
                      onClick: function () { props.onPickHost(r.host) },
                    }, uiCore.opIcon('eye')))),
                isOpen
                  ? el('tr', null, el('td', { colSpan: 6, style: { padding: 0 } }, el(EndpointListPanel, { host: r.host, callRpc: props.callRpc })))
                  : null)
            }))))
      })
    }

    // 域视图主体：自持 endpointHosts 分页查询 + program_id 筛选；onPickHost 跨视图跳链
    function EndpointDomainView(props) {
      var api = props || {}
      var rpcCall = (typeof api.rpc === 'function') ? api.rpc : ownRpc
      var nav = api.navigate || { select: function () {}, consume: function () {} }
      var endpointsQ = uiCore.usePagedQuery('endpointHosts', true, null, rpcCall)

      var wsItems = (api.workspaces && api.workspaces.items) || []
      var progOpts = wsItems.filter(function (w) { return w.program }).map(function (w) { return { v: w.program.id, l: w.title + '（' + w.program.id + '）' } })
      function onPickHost(host) { nav.select('assets', { q: host }) }

      return el(React.Fragment, null,
        el(uiCore.Toolbar, {
          query: endpointsQ, placeholder: '搜索路径（全局，命中后按主机聚合）…',
          filters: [
            { key: 'program_id', label: '工作区', options: progOpts },
          ],
        }),
        el(EndpointsView, { query: endpointsQ, onPickHost: onPickHost, callRpc: rpcCall }))
    }

    // 域根：包 ui-core SilksecErrorBoundary（崩溃只炸该域 tab，经 bus.audit_tail 口径带 surface）；
    // ui-panel 亦会包一层，双保险且使本组件在任意承载面（含降级）都自足隔离。
    function EndpointRoot(props) {
      return el(uiCore.SilksecErrorBoundary, { surface: 'dashboard-view-endpoint', title: '接口' },
        el(EndpointDomainView, props))
    }

    exports.name = 'silksec-sec-dashboard-view-endpoint'
    exports.inject = ['slots']
    exports.apply = function (ctx) {
      if (!uiCore || !uiCore.viewRegistry || typeof uiCore.viewRegistry.register !== 'function') return
      // 会话跳链 opener（可选；缺席 SessionLink 渲染「—」）
      try {
        var sessions = ctx.get('sessions')
        if (sessions && typeof sessions.open === 'function') uiCore.setSessionOpener(function (id) { try { sessions.open(id) } catch (e) {} })
      } catch (e) {}
      function install() {
        var connection = ctx.get('connection')
        if (connection && connection.rpc && typeof connection.rpc.call === 'function') {
          serviceRef.rpc = function (endpoint, payload) {
            return connection.rpc.call('/silksec-dashboard', endpoint, payload || {}).then(function (result) {
              if (result && result.ok) return result.value
              var error = result && result.error
              throw new Error(error && error.message ? error.message : 'rpc failed')
            })
          }
        }
        var disposer = uiCore.viewRegistry.register({
          id: 'endpoints', label: '接口', order: 40, domain: 'endpoint',
          component: EndpointRoot, requires: ['connection'], source: 'dashboard-view-endpoint',
        })
        if (typeof uiCore.markSurfaceHealth === 'function') uiCore.markSurfaceHealth('sec-dashboard-view-endpoint', 'ok')
        return disposer
      }
      // 时序纪律：connection 到达后才注册（capacity 探测）；ctx.effect 收口 disposer。
      if (typeof ctx.inject === 'function') ctx.inject(['connection'], function () { if (typeof ctx.effect === 'function') ctx.effect(install); else install() })
      else if (typeof ctx.effect === 'function') ctx.effect(install)
      else install()
    }

    exports.EndpointRoot = EndpointRoot
    exports.EndpointDomainView = EndpointDomainView
    exports.EndpointsView = EndpointsView
    exports.EndpointListPanel = EndpointListPanel
    return module.exports
  },
})
