/**
 * @silksec/sec-dashboard-view-report — client half (browser bundle)，16-dashboard P6 逐域视图拆分。
 *
 * 报告域浏览视图（16-dashboard §1.7「报告」视图 + 16-dashboard §1.3「主面板视图」）。
 * 从旧单体 dsh-plugin-sec-dashboard.client.js 的 ReportsView 拆出，**自持 query/筛选态**、
 * 纯组件、无挂载感知：经 @silksec/ui-core 的 viewRegistry 注册，ui-panel 主面板按 order 装配。
 *
 * 契约（与旧 PanelView 的 reports 分支逐项等价）：
 *   - 读：reports（服务端按 program/q 过滤，按项目分组）、reportRead（Modal 查看器阅读）；
 *   - 筛选：本地「筛选」/「重置」按钮经 reportFilter 状态触发服务端重查询；
 *   - 行内跳链：点击整行或👁图标 → reportRead + uiCore.DocModal 只读预览（可复制/下载）；
 *   - requires:['connection'] 缺席 → 不注册（tab 静默隐藏，不抛、不占 order）。
 *
 * 视觉遵循丝之歌主题规范：全部经 ui-core 令牌（--dsw-alias-*），本文件零颜色字面量。
 * 崩溃由 ui-panel 的 SilksecErrorBoundary 单面隔离。
 */
window.__ModuleLoader__.load({
  id: '@silksec/sec-dashboard-view-report',
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

    // ── 报告阅读模态（ui-core DocModal 薄封装；只读预览 + 复制/下载） ──
    function ReportReadModal(props) {
      var s = props.state || {}
      return el(uiCore.DocModal, {
        open: props.open, onClose: props.onClose, errorPrefix: '读取',
        title: String(s.file || '').split('/').pop() || '报告',
        sub: '只读预览 · ' + (s.file || '') + ' · 编辑请走 NAS/Obsidian 通道',
        state: s,
      })
    }

    // ── 报告列表（提取自旧 ReportsView）：按项目分组 + 项目/关键字筛选 ──
    // 输入态本地持有，「筛选」/「重置」经 props.onReload 交父层更新 reportFilter（服务端过滤）。
    function ReportsView(props) {
      var rows = (props.state.data && props.state.data.rows) || []
      var programs = (props.state.data && props.state.data.programs) || []
      var pfs = React.useState('')
      var programFilter = pfs[0]; var setProgramFilter = pfs[1]
      var qfs = React.useState('')
      var qf = qfs[0]; var setQf = qfs[1]
      function applyFilter() { props.onReload({ program: programFilter, q: qf }) }
      function resetFilter() { setProgramFilter(''); setQf(''); props.onReload({ program: '', q: '' }) }
      // 分组（客户端）：program || 'all'；组内按 mtime 降序（服务端已排序）
      var groups = {}
      rows.forEach(function (r) {
        var g = r.program || 'all'
        ;(groups[g] = groups[g] || []).push(r)
      })
      var groupKeys = Object.keys(groups).sort(function (a, b) { return a === 'all' ? 1 : b === 'all' ? -1 : a.localeCompare(b) })
      function rowOf(r) {
        return el('tr', {
          key: r.file, className: 'silksec-row',
          style: { cursor: 'pointer' }, title: '点击查看报告（Modal 打开，可复制/下载）',
          onClick: function () { props.onOpen(r.file) },
        },
          el('td', { style: uiCore.styles.tdMono }, (r.title || '').slice(0, 60) || '📄 ' + r.file),
          el('td', { style: uiCore.styles.tdMono }, (r.date || '').replace(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})$/, '$1-$2-$3 $4:$5') || new Date(r.mtime).toISOString().slice(0, 16).replace('T', ' ')),
          el('td', { style: uiCore.styles.tdMono }, (r.size / 1024).toFixed(1) + ' KB'),
          el('td', { style: uiCore.styles.td, onClick: function (e) { e.stopPropagation() } },
            el('button', { type: 'button', className: 'silksec-icon-btn', title: '查看报告（Modal 打开）', 'aria-label': '查看报告', onClick: function () { props.onOpen(r.file) } }, uiCore.opIcon('eye'))))
      }
      return el('div', null,
        el('div', { style: { ...uiCore.styles.cardL, margin: '10px 0 6px' }, title: '编辑请走 NAS/Obsidian 通道' }, '📄 data/reports/ 下的 markdown 报告（只读，点击行查看；按项目分组）'),
        el('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', margin: '6px 0' } },
          el('select', {
            className: 'silksec-input', style: { width: 150 },
            value: programFilter, onChange: function (e) { setProgramFilter(e.target.value) },
            title: '按项目筛选（all=未标注项目/全局报告）',
          },
            el('option', { value: '' }, '全部项目'),
            programs.map(function (g) { return el('option', { key: g, value: g }, g) })),
          el('input', {
            className: 'silksec-input', style: { width: 220 }, placeholder: '搜索文件名/标题…',
            value: qf, onChange: function (e) { setQf(e.target.value) },
          }),
          el('button', { type: 'button', className: 'silksec-btn', onClick: applyFilter, title: '应用筛选（服务端过滤）' }, '筛选'),
          (programFilter || qf) ? el('button', { type: 'button', className: 'silksec-btn', onClick: resetFilter, title: '清除筛选' }, '重置') : null),
        props.state.loading ? el(uiCore.SkeletonRows, { rows: 5 }) : rows.length === 0
          ? el(uiCore.EmptyState, { text: '暂无报告（当前筛选下无匹配）' })
          : el('div', null, groupKeys.map(function (g) {
              return el('div', { key: g, style: { marginTop: 10 } },
                el('div', { style: { ...uiCore.styles.pageT, display: 'flex', alignItems: 'center', gap: 6 } },
                  el('span', { style: { fontFamily: uiCore.MONO, fontSize: 12, color: uiCore.T.business } }, g === 'all' ? '全局/未标注' : g),
                  el('span', { style: { ...uiCore.styles.pill, color: uiCore.T.label3 } }, groups[g].length + ' 份')),
                el('table', { style: uiCore.styles.tableStyle },
                  el('colgroup', null, el('col', null), el('col', { style: { width: 130 } }), el('col', { style: { width: 90 } }), el('col', { style: { width: 60 } })),
                  el('thead', null, el('tr', { style: uiCore.styles.theadRow },
                    el('th', { style: uiCore.styles.th }, '报告'), el('th', { style: uiCore.styles.th }, '日期'), el('th', { style: uiCore.styles.th }, '大小'), el('th', { style: uiCore.styles.th }, '查看'))),
                  el('tbody', null, groups[g].map(rowOf))))
            })))
    }

    // ── 报告域根视图：自持 reportFilter + reports query + reportRead Modal ──
    function ReportView(props) {
      var api = props || {}
      var rpcCall = (typeof api.rpc === 'function') ? api.rpc : ownRpc
      var rptFilter = React.useState({ program: '', q: '' })
      var reportFilter = rptFilter[0]; var setReportFilter = rptFilter[1]
      var reportsState = uiCore.useRpc(function () {
        return { endpoint: 'reports', payload: { program: reportFilter.program, q: reportFilter.q } }
      }, [reportFilter.program, reportFilter.q], rpcCall)
      var reading = React.useState(null)
      var cur = reading[0]; var setCur = reading[1]
      function open(file) {
        setCur({ file: file, loading: true, content: null })
        rpcCall('reportRead', { file: file }).then(function (res) {
          setCur({ file: file, loading: false, content: res.content, truncated: res.truncated })
        }).catch(function (e) {
          setCur({ file: file, loading: false, content: null, error: e && e.message ? e.message : String(e) })
        })
      }
      return el(React.Fragment, null,
        el(ReportsView, {
          state: reportsState,
          onReload: function (f) { setReportFilter({ program: (f && f.program) || '', q: (f && f.q) || '' }) },
          onOpen: open,
        }),
        el(ReportReadModal, { open: !!cur, state: cur, onClose: function () { setCur(null) } }))
    }

    // 域根：包 ui-core SilksecErrorBoundary（崩溃只炸该域 tab，经 bus.audit_tail 口径带 surface）；
    // ui-panel 亦会包一层，双保险且使本组件在任意承载面（含降级）都自足隔离。
    function ReportRoot(props) {
      return el(uiCore.SilksecErrorBoundary, { surface: 'dashboard-view-report', title: '报告' },
        el(ReportView, props))
    }

    exports.name = 'silksec-sec-dashboard-view-report'
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
          id: 'reports', label: '报告', order: 80, domain: 'report',
          component: ReportRoot, requires: ['connection'], source: 'dashboard-view-report',
        })
        if (typeof uiCore.markSurfaceHealth === 'function') uiCore.markSurfaceHealth('sec-dashboard-view-report', 'ok')
        return disposer
      }
      // 时序纪律：connection 到达后才注册（capacity 探测）；ctx.effect 收口 disposer。
      if (typeof ctx.inject === 'function') ctx.inject(['connection'], function () { if (typeof ctx.effect === 'function') ctx.effect(install); else install() })
      else if (typeof ctx.effect === 'function') ctx.effect(install)
      else install()
    }

    exports.ReportRoot = ReportRoot
    exports.ReportView = ReportView
    exports.ReportsView = ReportsView
    exports.ReportReadModal = ReportReadModal
    return module.exports
  },
})
