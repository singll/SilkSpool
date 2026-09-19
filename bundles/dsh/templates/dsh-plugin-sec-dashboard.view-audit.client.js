/**
 * @silksec/sec-dashboard-view-audit — client half (browser bundle)，16-dashboard P6 逐域视图拆分。
 *
 * 审计域浏览视图（16-dashboard §1.7「审计」视图 + 16-dashboard §1.3「主面板视图」）。
 * 从旧单体 dsh-plugin-sec-dashboard.client.js 拆出（legacy AuditView ~1866-1909），
 * **自持 query**、纯组件、无挂载感知：经 @silksec/ui-core 的 viewRegistry 注册，
 * ui-panel 主面板按 order 装配。
 *
 * 契约（与旧 PanelView 的 audit 分支逐项等价，只读）：
 *   - 读：audit（bus.audit_tail 投影，尾部 ≤300 条，新→旧；fail-closed 由后端保证）；
 *   - 行内：时间 / 工具·动作 / 决策 / 详情四列，详情默认 200 字截断 + 点击展开全文；
 *   - 写：无（审计视图只读，合规单一真相源）；
 *   - requires:['connection'] 缺席 → 不注册（tab 静默隐藏，不抛、不占 order）。
 *
 * 视觉遵循丝之歌主题规范：全部经 ui-core 令牌（T / styles / F），本文件零颜色字面量。
 * 崩溃由域根 AuditRoot 包 ui-core SilksecErrorBoundary 单面隔离（surface=dashboard-view-audit）。
 */
window.__ModuleLoader__.load({
  id: '@silksec/sec-dashboard-view-audit',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    var React = require('react')
    var uiCore = null
    try { uiCore = require('@silksec/ui-core') } catch (e) { uiCore = null }
    var el = React.createElement

    // 自持 RPC（apply 时从 connection 捕获，解包宿主 {ok,value}；ui-panel prop bag 的 rpc 作兜底）
    var serviceRef = { rpc: null }
    function ownRpc(endpoint, payload) {
      if (!serviceRef.rpc) return Promise.reject(new Error('连接通道不可用'))
      return serviceRef.rpc(endpoint, payload || {})
    }

    // audit 对照：本视图消费总线 `audit` 端点（bus.audit_tail 投影：ts/tool/decision/detail，
    // detail 内嵌 domain/actor/operator/session_id 等）。行内 actor/decision 语义逐字保留
    // （detail.actor 原样呈现、decision 原样呈现），供 P6 新旧视图并排观察期逐条比对。
    function AuditView(props) {
      var api = props || {}
      var rpcCall = (typeof api.rpc === 'function') ? api.rpc : ownRpc
      var state = uiCore.useRpc(function () { return { endpoint: 'audit' } }, [], rpcCall)
      // 详情列点击展开全文（默认 200 字截断 + 悬停提示，展开后完整显示）
      var ex = React.useState({})
      var expanded = ex[0]; var setExpanded = ex[1]
      if (state.error) return el('div', { style: uiCore.styles.errorLine }, '审计加载失败: ' + state.error)
      if (!state.data) return el(uiCore.SkeletonRows, null)
      var rows = (state.data && state.data.rows) || []
      if (!rows.length) return el(uiCore.EmptyState, { text: '暂无审计记录' })
      function decColor(dec) {
        var s = String(dec || '')
        if (/reject|deny|拒绝|blocked|denied/i.test(s)) return uiCore.T.error
        if (/execut|allow|ok|已/i.test(s)) return uiCore.T.success
        return uiCore.T.label2
      }
      return el('div', null,
        el('div', { style: uiCore.styles.pageSub }, '📜 写操作与 scope 决策的全量审计（尾部 ≤300 条，新→旧）。合规单一真相源，看板只读；详情点击展开。'),
        el('div', { style: { overflowX: 'auto', minWidth: 0, marginTop: 10 } },
          el('table', { style: uiCore.styles.tableStyle },
            el('colgroup', null,
              el('col', { style: { width: 140 } }),
              el('col', { style: { width: 210 } }),
              el('col', { style: { width: 84 } }),
              el('col', null)),
            el('thead', null, el('tr', { style: uiCore.styles.theadRow },
              el('th', { style: uiCore.styles.th }, '时间'),
              el('th', { style: uiCore.styles.th }, '工具 / 动作'),
              el('th', { style: uiCore.styles.th }, '决策'),
              el('th', { style: uiCore.styles.th }, '详情'))),
            el('tbody', null, rows.map(function (r, i) {
              var detail = r.detail ? (typeof r.detail === 'object' ? JSON.stringify(r.detail) : String(r.detail)) : ''
              var isOpen = !!expanded[i]
              return el('tr', { key: i, className: 'silksec-row' },
                el('td', { style: uiCore.styles.tdMono }, uiCore.fmtTime(r.ts)),
                el('td', { style: uiCore.styles.tdMono, title: r.tool || '' }, r.tool || '—'),
                el('td', { style: { ...uiCore.styles.td, color: decColor(r.decision) } }, r.decision || '—'),
                el('td', {
                  style: {
                    ...uiCore.styles.tdMono, color: uiCore.T.label2,
                    cursor: detail.length > 200 ? 'pointer' : 'default',
                    // 展开时允许换行完整显示（默认单行省略，保持行高整齐）
                    ...(isOpen ? { whiteSpace: 'normal', wordBreak: 'break-all', overflow: 'visible', textOverflow: 'clip' } : {}),
                  },
                  title: detail.length > 200 ? (isOpen ? '点击收起' : '点击展开全文') : detail,
                  onClick: function () { if (detail.length > 200) setExpanded({ ...expanded, [i]: !isOpen }) },
                },
                  isOpen ? el('span', null, detail + ' ') : detail.slice(0, 200) + (detail.length > 200 ? '… ⤵' : '')))
            })))))
    }

    // 域根：包 ui-core SilksecErrorBoundary（崩溃只炸该域 tab，经 bus.audit_tail 口径带 surface）；
    // ui-panel 亦会包一层，双保险且使本组件在任意承载面（含降级）都自足隔离。
    function AuditRoot(props) {
      return el(uiCore.SilksecErrorBoundary, { surface: 'dashboard-view-audit', title: '审计' },
        el(AuditView, props))
    }

    exports.name = 'silksec-sec-dashboard-view-audit'
    exports.inject = ['slots']
    exports.apply = function (ctx) {
      if (!uiCore || !uiCore.viewRegistry || typeof uiCore.viewRegistry.register !== 'function') return
      // 会话跳链 opener（可选；缺席不影响审计只读呈现）
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
        // 19-ui-unify §3.2：审计属低频浏览面，收敛进主面板「更多」二级导航
        var disposer = uiCore.viewRegistry.register({
          id: 'audit', label: '审计', order: 110, group: 'more', domain: 'bus',
          component: AuditRoot, requires: ['connection'], source: 'dashboard-view-audit',
        })
        if (typeof uiCore.markSurfaceHealth === 'function') uiCore.markSurfaceHealth('sec-dashboard-view-audit', 'ok')
        return disposer
      }
      // 时序纪律：connection 到达后才注册（capacity 探测）；ctx.effect 收口 disposer。
      if (typeof ctx.inject === 'function') ctx.inject(['connection'], function () { if (typeof ctx.effect === 'function') ctx.effect(install); else install() })
      else if (typeof ctx.effect === 'function') ctx.effect(install)
      else install()
    }

    exports.AuditRoot = AuditRoot
    exports.AuditView = AuditView
    return module.exports
  },
})
