/**
 * @silksec/sec-dashboard-view-campaign — client half (browser bundle)，22 号方案 §十二 专项视图。
 *
 * 「专项（Campaign）」统筹视图（22-campaign-task §12：安全中心平铺新增「专项」tab）。
 * 从零新增，**自持 query/handler**、纯组件、无挂载感知：经 @silksec/ui-core 的 viewRegistry
 * 注册，ui-panel 主面板按 order 装配。
 *
 * 契约：
 *   - 读：campaigns（专项卡片行：状态/自主级别/进度聚合/预算/heartbeat）、
 *     campaignGet（goal_spec/policy/program_ids/decisions/active_tasks/checkpoints/window_usage）、
 *     campaignDecisions（验收账本）；
 *   - 写：campaignTickNow（立即跑一次 tick 段：巡检→验收→规划→下发，不超 INV-C6 界）；
 *   - requires:['connection'] 缺席 → 不注册（tab 静默隐藏，不抛、不占 order）；
 *   - 降级：campaigns 查询不可达 → 只读提示（沿用 B11 面板降级规范），任务 tab 不受影响。
 *
 * 视觉遵循丝之歌主题规范：全部经 ui-core 令牌（T / styles / F / pill），本文件零颜色字面量。
 * 崩溃由域根 CampaignRoot 包 ui-core SilksecErrorBoundary 单面隔离（surface=dashboard-view-campaign）。
 */
window.__ModuleLoader__.load({
  id: '@silksec/sec-dashboard-view-campaign',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    var React = require('react')
    var uiCore = null
    try { uiCore = require('@silksec/ui-core') } catch (e) { uiCore = null }
    var el = React.createElement

    var styles = (uiCore && uiCore.styles) || {}
    var pill = styles.pill
    function statusColor(s) {
      if (!uiCore) return undefined
      if (s === 'active') return uiCore.T.success
      if (s === 'reviewing') return uiCore.T.warn
      if (s === 'paused') return uiCore.T.label2
      if (s === 'archived') return uiCore.T.label3
      return uiCore.T.label2
    }
    function autonomyLabel(a) {
      return Number(a) >= 2 ? 'L2 有界自动' : (Number(a) >= 1 ? 'L1 建议' : 'L0 台账')
    }

    // 自持 RPC（apply 时从 connection 捕获，解包宿主 {ok,value}；ui-panel prop bag 的 rpc 作兜底）
    var serviceRef = { rpc: null }
    function ownRpc(endpoint, payload) {
      if (!serviceRef.rpc) return Promise.reject(new Error('连接通道不可用'))
      return serviceRef.rpc(endpoint, payload || {})
    }

    function DecisionTable(props) {
      var rows = props.rows || []
      if (!rows.length) return el(uiCore.EmptyState, { text: '暂无验收记录' })
      return el('table', { style: uiCore.styles.tableStyle },
        el('thead', null, el('tr', { style: uiCore.styles.theadRow },
          el('th', { style: uiCore.styles.th }, '时间'),
          el('th', { style: uiCore.styles.th }, '子任务'),
          el('th', { style: uiCore.styles.th }, '结论'),
          el('th', { style: uiCore.styles.th }, '证据'),
          el('th', { style: uiCore.styles.th }, '裁定'))),
        el('tbody', null, rows.map(function (d) {
          return el('tr', { key: d.id, className: 'silksec-row' },
            el('td', { style: uiCore.styles.tdMono }, uiCore.fmtTime(d.created_at)),
            el('td', { style: uiCore.styles.tdMono }, '#' + d.task_id),
            el('td', { style: { ...uiCore.styles.td, color: statusColor(d.verdict === 'accepted' ? 'active' : (d.verdict === 'escalated' ? 'reviewing' : 'paused')) } }, d.verdict),
            el('td', { style: uiCore.styles.tdMono, title: d.evidence }, d.evidence || '—'),
            el('td', { style: uiCore.styles.td }, d.decided_by || '—'))
        })))
    }

    function CampaignDetail(props) {
      var rpcCall = props.rpcCall
      var id = props.id
      var st = uiCore.useRpc(function () { return { endpoint: 'campaignGet', id: id } }, [id], rpcCall)
      if (st.error) return el('div', { style: uiCore.styles.errorLine }, '专项详情加载失败: ' + st.error)
      if (!st.data) return el(uiCore.SkeletonRows, null)
      var c = st.data
      var gs = c.goal_spec || {}
      var usage = c.window_usage || {}
      return el('div', { style: { marginTop: 12 } },
        el('div', { style: uiCore.styles.card },
          el('div', null, el('b', null, c.name), ' ', el('span', { style: { ...pill, color: statusColor(c.status) } }, c.status), ' ', el('span', { style: pill }, autonomyLabel(c.autonomy))),
          el('div', { style: { ...uiCore.styles.pageSub, marginTop: 4 } }, gs.objective || '（无目标摘要）'),
          el('div', { style: { ...uiCore.styles.pageSub, marginTop: 4 } },
            '绑定 program：', (c.program_ids || []).join('、') || '—',
            '　预算：', c.budget_tokens == null ? '不限' : (Number(usage.spent_tokens || 0) + '/' + c.budget_tokens + ' tokens/' + (c.budget_window_days || 7) + 'd')),
          el('div', { style: { ...uiCore.styles.pageSub, marginTop: 4 } },
            '停止条件：', (gs.stop_conditions || []).join('；') || '—'),
          el('div', { style: { ...uiCore.styles.pageSub, marginTop: 4 } },
            '心跳：', uiCore.fmtTime(c.heartbeat_at), '　最近 tick：', uiCore.fmtTime(c.last_tick_at))),
        el('div', { style: { ...uiCore.styles.pageSub, marginTop: 10 } }, '验收账本（近 ' + (c.decisions || []).length + ' 条）：'),
        el('div', { style: { overflowX: 'auto', minWidth: 0 } }, el(DecisionTable, { rows: c.decisions || [] })),
        el('div', { style: { ...uiCore.styles.pageSub, marginTop: 10 } }, '活跃子任务：' + ((c.active_tasks || []).length)),
        el('div', { style: { overflowX: 'auto', minWidth: 0 } },
          el('table', { style: uiCore.styles.tableStyle },
            el('thead', null, el('tr', { style: uiCore.styles.theadRow },
              el('th', { style: uiCore.styles.th }, '任务'), el('th', { style: uiCore.styles.th }, '角色'),
              el('th', { style: uiCore.styles.th }, '状态'), el('th', { style: uiCore.styles.th }, 'program'))),
            el('tbody', null, (c.active_tasks || []).map(function (t) {
              return el('tr', { key: t.id, className: 'silksec-row' },
                el('td', { style: uiCore.styles.td, title: t.objective }, '#' + t.id + ' ' + String(t.objective || '').slice(0, 60)),
                el('td', { style: uiCore.styles.tdMono }, t.campaign_role || '—'),
                el('td', { style: uiCore.styles.td }, t.status),
                el('td', { style: uiCore.styles.tdMono }, t.program_id || '—'))
            })))),
        el('div', { style: { ...uiCore.styles.pageSub, marginTop: 10 } }, '里程碑 / 升级（近 ' + (c.checkpoints || []).length + ' 条）：'),
        el('div', { style: { overflowX: 'auto', minWidth: 0 } },
          el('table', { style: uiCore.styles.tableStyle },
            el('thead', null, el('tr', { style: uiCore.styles.theadRow },
              el('th', { style: uiCore.styles.th }, '时间'), el('th', { style: uiCore.styles.th }, '类型'), el('th', { style: uiCore.styles.th }, '摘要'))),
            el('tbody', null, (c.checkpoints || []).map(function (cp) {
              return el('tr', { key: cp.id, className: 'silksec-row' },
                el('td', { style: uiCore.styles.tdMono }, uiCore.fmtTime(cp.created_at)),
                el('td', { style: uiCore.styles.td }, cp.kind),
                el('td', { style: uiCore.styles.td, title: cp.summary }, String(cp.summary || '').slice(0, 120)))
            }))))
      )
    }

    function CampaignView(props) {
      var api = props || {}
      var rpcCall = (typeof api.rpc === 'function') ? api.rpc : ownRpc
      var nonce = React.useState(0)
      var bump = nonce[1]
      var sel = React.useState(null)
      var selId = sel[0]; var setSelId = sel[1]
      var list = uiCore.useRpc(function () { return { endpoint: 'campaigns' } }, [nonce[0]], rpcCall)
      var actionState = React.useState(null)
      var actionMsg = actionState[0]; var setActionMsg = actionState[1]

      function tickNow(id) {
        setActionMsg('正在执行 tick…')
        return Promise.resolve(rpcCall('campaignTickNow', { id: id })).then(function () {
          setActionMsg('tick 完成')
          bump(function (n) { return n + 1 })
        }).catch(function (e) { setActionMsg('tick 失败: ' + (e && e.message ? e.message : String(e))) })
      }

      if (list.error) return el('div', null, el('div', { style: uiCore.styles.errorLine }, '专项加载失败（降级提示）：' + list.error))
      if (!list.data) return el(uiCore.SkeletonRows, null)
      var rows = (list.data && list.data.rows) || []
      if (!rows.length) return el(uiCore.EmptyState, { text: '暂无专项（由会话/看板登记专项后在此统筹）' })
      return el('div', null,
        el('div', { style: uiCore.styles.pageSub }, '🎯 专项（Campaign）：常驻统筹实体——绑定 program、持有目标规格与预算，以派生→下发→监督→验收闭环驱动子任务。点击行展开台账。'),
        actionMsg ? el('div', { style: uiCore.styles.stateLine }, actionMsg) : null,
        el('div', { style: { overflowX: 'auto', minWidth: 0, marginTop: 10 } },
          el('table', { style: uiCore.styles.tableStyle },
            el('thead', null, el('tr', { style: uiCore.styles.theadRow },
              el('th', { style: uiCore.styles.th }, '专项'),
              el('th', { style: uiCore.styles.th }, '状态'),
              el('th', { style: uiCore.styles.th }, '自主级别'),
              el('th', { style: uiCore.styles.th }, '绑定 program'),
              el('th', { style: uiCore.styles.th }, '验收(accepted/rejected)'),
              el('th', { style: uiCore.styles.th }, '预算'),
              el('th', { style: uiCore.styles.th }, '心跳'),
              el('th', { style: uiCore.styles.th }, '操作'))),
            el('tbody', null, rows.map(function (r) {
              var t = r.decision_totals || {}
              return el('tr', { key: r.id, className: 'silksec-row', style: { cursor: 'pointer' }, onClick: function () { setSelId(selId === r.id ? null : r.id) } },
                el('td', { style: uiCore.styles.td }, '#' + r.id + ' ' + (r.name || '')),
                el('td', { style: { ...uiCore.styles.td, color: statusColor(r.status) } }, r.status),
                el('td', { style: uiCore.styles.td }, autonomyLabel(r.autonomy)),
                el('td', { style: uiCore.styles.tdMono, title: (r.program_ids || []).join('、') }, (r.program_ids || []).join('、') || '—'),
                el('td', { style: uiCore.styles.tdMono }, (t.accepted || 0) + '/' + (t.rejected || 0)),
                el('td', { style: uiCore.styles.tdMono }, r.budget_tokens == null ? '不限' : (Number(r.spent_tokens || 0) + '/' + r.budget_tokens)),
                el('td', { style: uiCore.styles.tdMono }, uiCore.fmtTime(r.heartbeat_at)),
                el('td', { style: uiCore.styles.td },
                  el('button', {
                    type: 'button', className: 'silksec-btn', style: { height: 22 },
                    onClick: function (ev) { if (ev && ev.stopPropagation) ev.stopPropagation(); tickNow(r.id) },
                  }, '立即 tick')))
            })))),
        selId ? el(CampaignDetail, { id: selId, rpcCall: rpcCall }) : null
      )
    }

    // 域根：包 ui-core SilksecErrorBoundary（崩溃只炸该域 tab）
    function CampaignRoot(props) {
      return el(uiCore.SilksecErrorBoundary, { surface: 'dashboard-view-campaign', title: '专项' },
        el(CampaignView, props))
    }

    exports.name = 'silksec-sec-dashboard-view-campaign'
    exports.inject = ['slots']
    exports.apply = function (ctx) {
      if (!uiCore || !uiCore.viewRegistry || typeof uiCore.viewRegistry.register !== 'function') return
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
          id: 'campaign', label: '专项', order: 60, domain: 'task',
          component: CampaignRoot, requires: ['connection'], source: 'dashboard-view-campaign',
        })
        if (typeof uiCore.markSurfaceHealth === 'function') uiCore.markSurfaceHealth('sec-dashboard-view-campaign', 'ok')
        return disposer
      }
      if (typeof ctx.inject === 'function') ctx.inject(['connection'], function () { if (typeof ctx.effect === 'function') ctx.effect(install); else install() })
      else if (typeof ctx.effect === 'function') ctx.effect(install)
      else install()
    }

    exports.CampaignRoot = CampaignRoot
    exports.CampaignView = CampaignView
    exports.CampaignDetail = CampaignDetail
    exports.DecisionTable = DecisionTable
    return module.exports
  },
})
