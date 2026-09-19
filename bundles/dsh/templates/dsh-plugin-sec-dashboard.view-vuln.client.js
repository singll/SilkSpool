/**
 * @silksec/sec-dashboard-view-vuln — client half (browser bundle)，16-dashboard P6 逐域视图拆分。
 *
 * 漏洞域浏览视图（16-dashboard §1.7「漏洞」视图 + 16-dashboard §1.3「主面板视图」）。
 * 从旧单体 dsh-plugin-sec-dashboard.client.js 拆出，**自持 query/handler**、纯组件、
 * 无挂载感知：经 @silksec/ui-core 的 viewRegistry 注册，ui-panel 主面板按 order 装配。
 *
 * 契约（与旧 PanelView 的 findings 分支逐项等价）：
 *   - 读：findings（分页/筛选/排序，vuln.list 投影）、evalStats（假阳性率）；
 *   - 写：findingUpdate（status=confirmed/false_positive/submitted/accepted/ignored，
 *     RpcProjector 按语义分派 vuln.confirm/reject/submit + 兼容层）、reportBuild；
 *   - 行内跳链：uiCore.SessionLink → sessions.open（opener 经 ui-core 注入）；
 *   - 跨视图跳链：navigate（KPI/命中跳转）。
 *   - requires:['connection'] 缺席 → 不注册（tab 静默隐藏，不抛、不占 order）。
 *
 * 视觉遵循丝之歌主题规范：全部经 ui-core 令牌（--dsw-alias-* / --silksec-sev-*），
 * 本文件零颜色字面量。崩溃由 ui-panel 的 SilksecErrorBoundary 单面隔离。
 */
window.__ModuleLoader__.load({
  id: '@silksec/sec-dashboard-view-vuln',
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

    // ── 漏洞洞察条（U2/F8）：级别分布 + 待处理 + 待验证候选 + 评测回流误报率 ──
    function FindingsInsight(props) {
      var bySev = props.bySeverity || []
      var byStatus = props.byStatus || []
      var evalData = props.evalData
      var noiseN = props.noiseCount || 0
      var map = {}; bySev.forEach(function (s) { map[s.severity] = s.n })
      var pending = 0; byStatus.forEach(function (s) { if (s.status === 'new') pending = s.n })
      var order = ['critical', 'high', 'medium', 'low', 'info']
      var chips = order.filter(function (k) { return map[k] }).map(function (k) {
        var c = uiCore.SEV_COLOR[k]
        return el('span', { key: k, style: { ...uiCore.styles.pill, color: c, borderColor: 'color-mix(in srgb, ' + c + ' 40%, transparent)' } }, uiCore.SEV_LABEL[k] + ' ' + map[k])
      })
      if (!chips.length && !pending && !noiseN) return null
      var fpTitle = ''
      if (evalData && evalData.by_type) {
        fpTitle = Object.keys(evalData.by_type).map(function (t) {
          var s = evalData.by_type[t]; return t + '：确认 ' + s.confirmed + ' / 误报 ' + s.false_positive + '（误报率 ' + Math.round((s.fp_rate || 0) * 100) + '%）'
        }).join('\n')
      }
      return el('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', margin: '2px 0 8px' } },
        chips,
        pending ? el('span', { style: { ...uiCore.styles.pill, color: uiCore.T.brand, borderColor: 'color-mix(in srgb, var(--dsw-alias-brand-primary) 40%, transparent)' }, title: '状态为「新发现」的未处理漏洞' }, '待处理 ' + pending) : null,
        noiseN ? el('button', {
          type: 'button', className: 'silksec-chip',
          'data-on': (props.query && props.query.filters && props.query.filters.noise === '1') ? 'true' : undefined,
          style: { color: uiCore.T.warn, borderColor: 'color-mix(in srgb, var(--dsw-alias-state-warn-primary) 40%, transparent)' },
          title: '机器直灌 / 缺复现步骤与影响的待验证候选（默认不进漏洞信号面），点击筛出复核',
          onClick: function () { props.query && props.query.setFilter('noise', '1') },
        }, '待验证候选 ' + noiseN) : null,
        (evalData && evalData.total)
          ? el('span', { style: { marginLeft: 'auto', color: uiCore.T.label3, ...uiCore.F.xxxs, cursor: fpTitle ? 'help' : 'default' }, title: fpTitle }, '评测回流 ' + evalData.total + ' 条判定')
          : null)
    }

    // 漏洞详情面板（F1）：按需 findingGet 拉全字段 + 生命周期操作
    function FindingDetail(props) {
      var r = props.row
      var callRpc = props.callRpc
      var st = React.useState({ loading: true, data: null, error: null })
      var d = st[0]; var setD = st[1]
      React.useEffect(function () {
        var alive = true
        callRpc('findingGet', { id: r.id })
          .then(function (res) { if (alive) setD({ loading: false, data: res, error: null }) })
          .catch(function (e) { if (alive) setD({ loading: false, data: null, error: e && e.message ? e.message : String(e) }) })
        return function () { alive = false }
      }, [r.id])
      var inner
      if (d.loading) inner = el(uiCore.SkeletonRows, { rows: 3 })
      else if (d.error || !d.data) inner = el('div', { style: { ...uiCore.styles.errorLine, padding: 0 } }, '详情加载失败: ' + (d.error || '无数据'))
      else {
        var f = d.data
        var field = function (label, val, mono) {
          if (!val) return null
          return el('div', { style: { marginBottom: 8 } },
            el('div', { style: { color: uiCore.T.label3, ...uiCore.F.xxxs, marginBottom: 2 } }, label),
            el('div', { style: { color: uiCore.T.label2, ...uiCore.F.xxs, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: mono ? uiCore.MONO : undefined } }, String(val)))
        }
        inner = el(React.Fragment, null,
          el('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 } },
            f.vuln_type ? el('span', { style: uiCore.styles.pill }, f.vuln_type) : null,
            f.cwe ? el('span', { style: uiCore.styles.pill }, 'CWE-' + f.cwe) : null,
            f.bounty ? el('span', { style: { ...uiCore.styles.pill, color: uiCore.T.success } }, '赏金 ' + f.bounty) : null,
            f.vendor_status ? el('span', { style: uiCore.styles.pill }, '厂商 ' + f.vendor_status) : null,
            el('span', { style: { marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6 } },
              el('span', { style: { color: uiCore.T.label3, ...uiCore.F.xxxs } }, '来源会话'), el(uiCore.SessionLink, { id: f.session_id }))),
          field('目标', f.url || f.host, true),
          field('证据', f.evidence, true),
          field('复现步骤', f.reproduction_steps, true),
          field('前提条件', f.preconditions),
          field('影响', f.impact),
          field('修复建议', f.recommendation),
          props.actions && props.actions.length
            ? el('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 6, borderTop: '1px solid ' + uiCore.T.border2, paddingTop: 10 } }, props.actions)
            : null)
      }
      return el('div', { style: { padding: '12px 14px', background: uiCore.T.layer1, borderLeft: '2px solid ' + uiCore.T.brand } }, inner)
    }

    function FindingsView(props) {
      var query = props.query
      var busy = props.busy
      var callRpc = props.callRpc
      var exp = React.useState(null)
      var expandedId = exp[0]; var setExpanded = exp[1]
      function tagIconBtn(label, status, id, kind, cls) {
        return el('button', {
          type: 'button', key: status, className: 'silksec-icon-btn' + (cls ? ' ' + cls : ''),
          disabled: !!busy, title: label, 'aria-label': label,
          onClick: function (e) { e.stopPropagation(); props.onTag(id, status) },
        }, uiCore.opIcon(kind))
      }
      function lcBtn(label, fn, cls) {
        return el('button', { key: label, type: 'button', className: 'silksec-btn' + (cls ? ' ' + cls : ''), disabled: !!busy, onClick: fn }, label)
      }
      function lifecycleActions(r) {
        var a = []
        if (['new', 'confirmed'].indexOf(r.status) >= 0) {
          a.push(lcBtn('确认为真实漏洞', function () { props.onTag(r.id, 'confirmed') }, 'silksec-btn-confirm'))
          a.push(lcBtn('误报', function () { props.onTag(r.id, 'false_positive') }, 'silksec-btn-danger'))
        }
        if (r.status === 'confirmed') a.push(lcBtn('标记已提交 SRC', function () { props.onTag(r.id, 'submitted') }))
        if (r.status === 'submitted') {
          a.push(lcBtn('已接收 + 记录赏金', function () { props.onAccept(r.id) }, 'silksec-btn-confirm'))
          a.push(lcBtn('厂商判重复', function () { props.onTag(r.id, 'dup') }))
        }
        if (['new', 'confirmed', 'submitted'].indexOf(r.status) >= 0) a.push(lcBtn('忽略', function () { props.onTag(r.id, 'ignored') }))
        return a
      }
      return el(uiCore.ViewBody, { query: query, emptyText: '暂无漏洞数据' }, function (rows) {
        return el('div', { style: { overflowX: 'auto', minWidth: 0 } },
          el('table', { style: uiCore.styles.tableStyle },
            el('colgroup', null,
              el('col', { style: { width: 52 } }),
              el('col', { style: { width: 76 } }),
              el('col', { style: { width: 92 } }),
              el('col', { style: { width: 124 } }),
              el('col', null),
              el('col', { style: { width: '22%' } }),
              el('col', { style: { width: 56 } }),
              el('col', { style: { width: 110 } })),
            el('thead', null, el('tr', { style: uiCore.styles.theadRow },
              uiCore.sortableTh('#', 'id', query),
              uiCore.sortableTh('级别', 'severity', query),
              uiCore.sortableTh('状态', 'status', query),
              uiCore.sortableTh('发现时间', 'created_at', query),
              el('th', { style: uiCore.styles.th }, '标题'),
              el('th', { style: uiCore.styles.th }, '目标'),
              el('th', { style: uiCore.styles.th }, '会话'),
              el('th', { style: uiCore.styles.th }, '打标'))),
            el('tbody', null, rows.map(function (r) {
              var taggable = ['new', 'confirmed'].indexOf(r.status) >= 0
              var closed = uiCore.STATUS_CLOSED.indexOf(r.status) >= 0
              var isOpen = expandedId === r.id
              var rowStyle = {
                opacity: closed ? 0.45 : 1,
                boxShadow: r.status === 'new' ? 'inset 2px 0 0 ' + uiCore.T.brand : (isOpen ? 'inset 2px 0 0 ' + uiCore.T.border3 : undefined),
              }
              var cell = closed ? uiCore.styles.tdClosed : uiCore.styles.td
              var cellMono = closed ? uiCore.styles.tdClosed : uiCore.styles.tdMono
              return el(React.Fragment, { key: String(r.id) },
                el('tr', { className: 'silksec-row', style: { ...rowStyle, cursor: 'pointer' }, title: closed ? '已定案（重复/误报/忽略）· 点击展开详情' : '点击展开详情', onClick: function () { setExpanded(isOpen ? null : r.id) } },
                  el('td', { style: cellMono }, String(r.id)),
                  el('td', { style: cell }, closed ? el('span', { style: { ...uiCore.styles.pill, padding: '1px 6px', fontSize: 11 } }, uiCore.SEV_LABEL[r.severity] || r.severity) : uiCore.sevPill(r.severity)),
                  el('td', { style: cell }, closed ? el('span', { style: { ...uiCore.styles.pill, padding: '1px 6px', fontSize: 11 } }, uiCore.STATUS_LABEL[r.status] || r.status) : uiCore.statusPill(r.status)),
                  el('td', { style: { ...cell, color: uiCore.T.label2 } }, uiCore.fmtTs(r.created_at)),
                  el('td', { style: cell },
                    el('span', { style: { color: uiCore.T.label3, marginRight: 6, ...uiCore.F.xxxs } }, isOpen ? '▾' : '▸'),
                    r.title,
                    r.bounty ? el('span', { style: { ...uiCore.styles.pill, color: uiCore.T.success, marginLeft: 6 } }, '赏金 ' + r.bounty) : null),
                  el('td', { style: cellMono }, r.url || r.host || '—'),
                  el('td', { style: cell, onClick: function (e) { e.stopPropagation() } }, closed ? '—' : el(uiCore.SessionLink, { id: r.session_id })),
                  el('td', { style: { ...cell, whiteSpace: 'nowrap' }, onClick: function (e) { e.stopPropagation() } },
                    taggable
                      ? el('span', { style: { display: 'inline-flex', gap: 6 } },
                          tagIconBtn('确认（确认为真实漏洞）', 'confirmed', r.id, 'confirm', 'silksec-icon-btn-confirm'),
                          tagIconBtn('误报（标记为误报）', 'false_positive', r.id, 'false_positive'),
                          tagIconBtn('忽略（不再跟进）', 'ignored', r.id, 'ignored'))
                      : el('button', {
                          type: 'button', className: 'silksec-icon-btn',
                          title: isOpen ? '收起详情' : '展开详情（证据 / 复现步骤 / 影响 / 修复建议）', 'aria-label': '展开详情',
                          onClick: function () { setExpanded(isOpen ? null : r.id) },
                        }, uiCore.opIcon('chev')))),
                isOpen
                  ? el('tr', null, el('td', { colSpan: 8, style: { padding: 0 } }, el(FindingDetail, { row: r, callRpc: callRpc, actions: lifecycleActions(r) })))
                  : null)
            }))))
      })
    }

    // 生成报告（reportBuild）模态：DocModal 薄封装
    function ReportModal(props) {
      return el(uiCore.DocModal, {
        open: props.open, onClose: props.onClose, title: '漏洞报告', errorPrefix: '生成',
        sub: '提交 SRC 前必须人工逐条复核。报告已落盘服务端 data/reports/。',
        state: props.state,
      })
    }

    function VulnView(props) {
      var api = props || {}
      var rpcCall = (typeof api.rpc === 'function') ? api.rpc : ownRpc
      var nav = api.navigate || { select: function () {}, consume: function () {} }
      var statsData = api.stats || {}
      var busyState = React.useState(false)
      var isBusy = busyState[0]; var setBusy = busyState[1]
      var useRpcCore = uiCore.useRpc
      var usePagedCore = uiCore.usePagedQuery

      var findingsQ = usePagedCore('findings', true, null, rpcCall)
      var evalState = useRpcCore(function () { return { endpoint: 'evalStats' } }, [], rpcCall)

      // KPI 跳链预置筛选（status=new / noise=1）：面板切到本视图时一次性应用（19-ui-unify §4.2）
      React.useEffect(function () {
        var p = api.pending
        if (!p) return
        if (p.q !== undefined) findingsQ.setQ(p.q)
        if (p.filters) { for (var k in p.filters) if (p.filters[k] !== undefined) findingsQ.setFilter(k, p.filters[k]) }
        if (typeof nav.consume === 'function') nav.consume('findings')
      }, [])

      var rpt = React.useState({ open: false })
      var reportState = rpt[0]; var setReportState = rpt[1]

      function withBusy(fn) {
        return function () {
          if (isBusy) return
          setBusy(true)
          Promise.resolve().then(fn).catch(function (e) {
            console.error('[sec-dashboard-view-vuln] 写操作失败:', e)
            try { window.alert('操作失败: ' + (e && e.message ? e.message : e)) } catch (e2) {}
          }).finally(function () {
            setBusy(false)
            findingsQ.reload(); evalState.reload()
            if (typeof api.reloadShared === 'function') api.reloadShared()
          })
        }
      }
      function onTag(fid, status) { withBusy(function () { return rpcCall('findingUpdate', { id: fid, status: status }) })() }
      function onAccept(fid) {
        var b = null
        try { b = window.prompt('厂商已接收。记录赏金金额（数字，可留空）:', '') } catch (e) { return }
        if (b === null) return
        var payload = { id: fid, status: 'accepted' }
        var n = Number(b)
        if (String(b).trim() !== '' && !isNaN(n)) payload.bounty = n
        withBusy(function () { return rpcCall('findingUpdate', payload) })()
      }
      function onBuildReport() {
        var payload = {}
        if (findingsQ.filters.program_id) payload.program_id = findingsQ.filters.program_id
        if (findingsQ.filters.status) payload.status = findingsQ.filters.status
        if (findingsQ.filters.severity) payload.severity = findingsQ.filters.severity
        var sevs = []
        try { sevs = window.prompt('仅包含的级别（逗号分隔，留空=全部）：critical,high,medium,low', '') || '' } catch (e) { sevs = '' }
        if (sevs.trim()) payload.severity = sevs.trim()
        if (findingsQ.filters.noise === '1') {
          try { window.alert('当前处于「仅待验证候选」视图——报告只列信号（noise=0）。将忽略候选筛选生成正式报告。') } catch (e) {}
        }
        setReportState({ open: true, loading: true })
        rpcCall('reportBuild', payload).then(function (res) {
          setReportState({ open: true, loading: false, content: res.content, file: res.file, total: res.total, by_severity: res.by_severity })
        }).catch(function (e) {
          setReportState({ open: true, loading: false, error: e && e.message ? e.message : String(e) })
        })
      }

      var wsItems = (api.workspaces && api.workspaces.items) || []
      var progOpts = wsItems.filter(function (w) { return w.program }).map(function (w) { return { v: w.program.id, l: w.title + '（' + w.program.id + '）' } })

      return el(React.Fragment, null,
        el(uiCore.Toolbar, {
          query: findingsQ, placeholder: '搜索标题 / 主机 / URL…',
          filters: [
            { key: 'severity', label: '级别', options: Object.keys(uiCore.SEV_LABEL).map(function (k) { return { v: k, l: uiCore.SEV_LABEL[k] } }) },
            { key: 'status', label: '状态', options: Object.keys(uiCore.STATUS_LABEL).map(function (k) { return { v: k, l: uiCore.STATUS_LABEL[k] } }) },
            { key: 'noise', label: '验证', options: [{ v: '1', l: '仅待验证候选' }] },
            { key: 'program_id', label: '工作区', options: progOpts },
          ],
          extra: el('button', { type: 'button', className: 'silksec-btn', disabled: isBusy, title: '按当前筛选（项目/状态）生成 markdown 报告', onClick: onBuildReport }, '生成报告'),
        }),
        el(FindingsInsight, { bySeverity: statsData.findings_by_severity, byStatus: statsData.findings_by_status, evalData: evalState.data, noiseCount: statsData.findings_noise, query: findingsQ }),
        el(FindingsView, { query: findingsQ, onTag: onTag, onAccept: onAccept, busy: isBusy, callRpc: rpcCall }),
        el(ReportModal, { open: reportState.open, state: reportState, onClose: function () { setReportState({ open: false }) } }))
    }

    // 域根：包 ui-core SilksecErrorBoundary（崩溃只炸该域 tab，经 bus.audit_tail 口径带 surface）；
    // ui-panel 亦会包一层，双保险且使本组件在任意承载面（含降级）都自足隔离。
    function DomainRoot(props) {
      return el(uiCore.SilksecErrorBoundary, { surface: 'dashboard-view-vuln', title: '漏洞' },
        el(VulnView, props))
    }

    exports.name = 'silksec-sec-dashboard-view-vuln'
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
          id: 'findings', label: '漏洞', order: 20, domain: 'vuln',
          component: DomainRoot, requires: ['connection'], source: 'dashboard-view-vuln',
        })
        if (typeof uiCore.markSurfaceHealth === 'function') uiCore.markSurfaceHealth('sec-dashboard-view-vuln', 'ok')
        return disposer
      }
      // 时序纪律：connection 到达后才注册（capacity 探测）；ctx.effect 收口 disposer。
      if (typeof ctx.inject === 'function') ctx.inject(['connection'], function () { if (typeof ctx.effect === 'function') ctx.effect(install); else install() })
      else if (typeof ctx.effect === 'function') ctx.effect(install)
      else install()
    }

    exports.DomainRoot = DomainRoot
    exports.VulnView = VulnView
    exports.FindingsView = FindingsView
    return module.exports
  },
})
