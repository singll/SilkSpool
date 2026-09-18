/**
 * @silksec/ui-approval — client half (browser bundle)，19-ui-surface P2 审批套件。
 *
 * 把统一审批中心从「主面板里的一个 tab」拆到 DSH 原生信息架构里它该在的位置：
 *   1. 通知胶囊（`shell.overlay`，list/root，additive）：右下角常驻「待审批 · N」
 *      （丝线金 warn；纪律告警叠绯红描边，禁填充）。点击弹快捷处理浮卡（自绘
 *      popover，bg-layer-3），pending 逐条批准/驳回 + 判据悬停，底部「打开审批中心 →」。
 *      零会话下照常工作（root scope），浮卡自足完成审批。
 *   2. 审批右侧栏 page tab：`ctx.sidebarRightTabs.register({ id, kind, priority,
 *      title, guide })`（阶段一：类型进注册表）+ tab 体/标题注册进 keyed
 *      `sidebar.right.pane.tab` / `sidebar.right.pane.tab.title`（key = 类型 id，
 *      阶段二）。完整列表/筛选/留痕与会话并排；栏宽/浮窗/全屏由 dockkit 原生提供。
 *
 * 官方契约以 DSH 0.1.5-rc.2 类型声明逐字核对：
 *   - `SidebarRightTabRegistry.register(definition)`（**不是** registerType；
 *     19-ui-surface §二.3 的 `registerType` 名称有误，此处以实测为准）；
 *     定义字段 id/kind/priority/title(address)/guide[{order,title}]；
 *     阶段二 key = definition.id，openTab 按 kind 寻址。
 *   - `slots.inject(key, cb)` 按「槽声明生命周期」注册（声明先于/晚于回调皆正确）；
 *     `slots.register` 经调用方 ctx.effect 收口，卸载自动 disposer。
 *   - `shell.overlay` 点击穿透，条目须自行 `pointerEvents:'auto'`。
 *
 * 降级链（能力探测，非版本判断；§六.3）：
 *   右侧栏 page tab + overlay 胶囊
 *     ├ sidebarRightTabs 缺席 → 同一审批视图注册进 ui-core 注册表（主面板「审批 ·降级」）
 *     ├ 主面板/layout 缺席 → primitives Modal（再缺席则自绘 fixed 覆盖层）
 *     └ shell.overlay 缺席 → secUiBus 广播 approval:pending（footer.action 由
 *        sec-dashboard legacy 单条持有，不重复注册；主面板 approvals tab 自带计数兜底）
 *
 * 数据全部走 `/silksec-dashboard` RPC（approvalList / approvalDecide）→ 总线
 * approval.list / approval.decide，actor=dashboard + operator 由 RpcProjector 注入，
 * 与主面板批准路径同一条写命令（audit 留痕等价）。
 *
 * 隔离：ErrorBoundary 逐面包；本包 apply 崩溃只销毁自身 fiber。本文件零颜色字面量，
 * 全部经 ui-core 令牌表 / --dsw-alias-*。
 */
window.__ModuleLoader__.load({
  id: '@silksec/ui-approval',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    var React = require('react')
    var el = React.createElement
    // 跨 bundle require 看板 UI 内核（dsh.client.inject 声明随 setup 脚本）。
    var uiCore = null
    try { uiCore = require('@silksec/ui-core') } catch (e) { uiCore = null }
    // primitives 为可选增强：缺席时全部走 ui-core 令牌样式 + title 兜底（能力探测）。
    var primitives = null
    try { primitives = require('@deepseek-ai/dsh-client-ui-primitives') } catch (e) { primitives = null }
    function prim(name) { try { return (primitives && primitives[name]) || null } catch (e) { return null } }

    var T = (uiCore && uiCore.T) || {}
    var F = (uiCore && uiCore.F) || {}
    var styles = (uiCore && uiCore.styles) || {}
    var fmtTime = (uiCore && uiCore.fmtTime) || function (x) { return x == null ? '—' : String(x) }
    var fmtRel = (uiCore && uiCore.fmtRel) || function () { return '' }
    var markSurfaceHealth = (uiCore && uiCore.markSurfaceHealth) || function () {}

    // ── 常量：注册标识 / 官方 kind / 降级 id ─────────────────────────────────
    var TAB_ID = 'silksec-approval-view'   // 右侧栏实现身份（= keyed 槽 key）
    var TAB_KIND = 'silksec-approval'      // 页面类型判别式（= openTab 参数）
    var CAPSULE_ID = 'silksec-approval-capsule'
    var DEGRADED_VIEW_ID = 'approval-degraded'
    var DASHBOARD_PANEL_ID = 'silksec-dashboard'
    var POLL_MS = 30000

    var KIND_LABEL = {
      'scope-wildcard': '整域授权(通配)',
      'scope-domain': '授权域名',
      'exclude-exception': '排除例外',
      'tool-intrusive': '侵入工具放行',
      'task-budget-extend': '任务预算延长',
      'knowledge-publish': '知识版本发布',
      'knowledge-adopt': '外部经验蒸馏',
      'task-complete': '任务完成确认',
    }
    var STATUS_LABEL = { pending: '待审批', approved: '已批准', rejected: '已驳回' }
    var STATUS_DOT = { pending: 'warning', approved: 'done', rejected: 'error' }

    // apply 时捕获的客户端 root context（渲染期按需读 connection/layout/sidebarRight）
    var serviceRef = { ctx: null }
    function getService(name) {
      var ctx = serviceRef.ctx
      if (!ctx || typeof ctx.get !== 'function') return null
      try { return ctx.get(name) } catch (e) { return null }
    }
    // /silksec-dashboard RPC caller（与 sec-dashboard 视图写操作同通道同端点）
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

    // ── 共享审批快照（胶囊 / tab 标题 / 视图共用同一 pending 计数） ────────────
    function createApprovalStore() {
      var state = { pending: 0, alert: false, rows: [], loaded: false, updatedAt: 0 }
      var listeners = []
      function get() { return state }
      function set(patch) {
        var next = {}; var k
        for (k in state) next[k] = state[k]
        for (k in patch) next[k] = patch[k]
        var changed = false
        for (k in next) { if (next[k] !== state[k]) { changed = true; break } }
        state = next
        if (changed) { var l = listeners.slice(); l.forEach(function (fn) { try { fn(state) } catch (e) {} }) }
        return state
      }
      function subscribe(fn) {
        if (typeof fn !== 'function') return function () {}
        listeners.push(fn)
        return function () { listeners = listeners.filter(function (f) { return f !== fn }) }
      }
      return { get: get, set: set, subscribe: subscribe, listeners: function () { return listeners.slice() } }
    }
    var approvalStore = createApprovalStore()

    function useStore(store) {
      var s = React.useState(function () { return store.get() })
      var snap = s[0]; var setSnap = s[1]
      React.useEffect(function () {
        return store.subscribe(function (v) { setSnap(v) })
      }, [])
      return snap
    }

    // 轮询审批列表：胶囊/视图/标题共用；pending 计数写回共享快照并广播 bus 信号。
    function useApprovalData(rpc) {
      var useRpcCore = uiCore && uiCore.useRpc
      if (typeof useRpcCore !== 'function') return { loading: false, data: null, error: null, reload: function () {} }
      var state = useRpcCore(function () { return { endpoint: 'approvalList', payload: { limit: 200 } } }, [], rpc || undefined)
      React.useEffect(function () {
        if (!state.data) return
        var p = Number(state.data.pending) || 0
        approvalStore.set({ pending: p, rows: state.data.rows || [], loaded: true, updatedAt: Date.now() })
        try { uiCore.secUiBus.emit('approval:pending', { pending: p }) } catch (e) {}
      }, [state.data && state.data.pending])
      return state
    }

    // 纪律告警（ops.healthy=false）→ 胶囊绯红描边（禁填充）
    function useDisciplineAlert(rpc) {
      var useRpcCore = uiCore && uiCore.useRpc
      if (typeof useRpcCore !== 'function') return false
      var state = useRpcCore(function () { return { endpoint: 'ops' } }, [], rpc || undefined)
      React.useEffect(function () {
        var alert = !!(state.data && state.data.healthy === false)
        approvalStore.set({ alert: alert })
      }, [state.data && state.data.healthy])
      return !!(state.data && state.data.healthy === false)
    }

    // ── 语义徽章 / 图标（primitives 可选，缺席走 ui-core 样式） ────────────────
    function chipStyle(color, extra) {
      return {
        display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px',
        borderRadius: 999, fontSize: 12, lineHeight: '16px', whiteSpace: 'nowrap', flexShrink: 0,
        border: '1px solid ' + (T.border2 || 'transparent'), color: color || T.label2,
        background: 'transparent',
        ...(extra || {}),
      }
    }
    function kindChip(kind) {
      return el('span', { style: chipStyle(T.business), title: '审批类型 ' + kind }, KIND_LABEL[kind] || kind)
    }
    function statusChip(status) {
      return el('span', { style: chipStyle(status === 'pending' ? T.warn : status === 'approved' ? T.success : T.label3), title: '审批状态 ' + status }, STATUS_LABEL[status] || status)
    }
    function stateDot(status) {
      var SD = prim('StateDot')
      if (!SD) return null
      return el(SD, { state: STATUS_DOT[status] || 'warning' })
    }
    function warningIcon(size) {
      var I = prim('IconWarningOutline')
      return I ? el(I, { size: size || 14 }) : (uiCore.opIcon ? uiCore.opIcon('list') : null)
    }
    function checklistIcon(size) {
      var I = prim('IconChecklistOutline')
      return I ? el(I, { size: size || 14 }) : (uiCore.opIcon ? uiCore.opIcon('list') : null)
    }
    // 图标按钮：title 悬停纪律（primitives Tooltip 可选增强）
    function tip(label, node) {
      var TT = prim('Tooltip')
      if (TT && label) return el(TT, { label: String(label), side: 'left', delayMs: 400 }, node)
      return node
    }
    // 判据悬停卡（HoverCard 可选增强；缺席时退回 title）
    function hover(anchor, content) {
      var HC = prim('HoverCard')
      if (HC && content) return el(HC, { anchor: anchor, content: content })
      return anchor
    }

    function parsePayload(row) {
      try { return row && row.payload ? JSON.parse(row.payload) : null } catch (e) { return null }
    }
    function judgmentText(row) {
      var p = parsePayload(row)
      if (!p) return row && row.evidence ? String(row.evidence) : ''
      var parts = []
      if (p.equity_basis) parts.push('判据: ' + p.equity_basis)
      if (p.independent_src) parts.push('独立SRC: ' + p.independent_src)
      if (p.domain_level) parts.push('层级: ' + p.domain_level)
      if (p.tool) parts.push('工具: ' + p.tool)
      if (p.risk) parts.push('风险: ' + p.risk)
      if (p.task_id) parts.push('任务: #' + p.task_id)
      if (p.budget_timeout_sec) parts.push('预算: ' + p.budget_timeout_sec + 's')
      return parts.join(' · ') || (row && row.evidence ? String(row.evidence) : '')
    }
    function decodeBlob(v) {
      if (v === undefined || v === null) return ''
      if (typeof v === 'string') return v
      if (typeof v === 'object') { try { return JSON.stringify(v) } catch (e) { return String(v) } }
      return String(v)
    }

    // 打开审批中心：右侧栏 page tab 优先；缺席则 secUiBus + 主面板；再缺席由调用方弹 Modal
    function openApprovalCenter() {
      var sr = getService('sidebarRight')
      if (sr && typeof sr.openTab === 'function') {
        try { sr.openTab(TAB_KIND); return 'tab' } catch (e) { /* 无在屏会话 seat → 降级 */ }
      }
      try { uiCore.secUiBus.emit('open:approval', {}) } catch (e) {}
      var layout = getService('layout')
      if (layout && typeof layout.selectPanel === 'function') {
        try { layout.selectPanel(DASHBOARD_PANEL_ID); return 'panel' } catch (e) {}
      }
      return 'none'
    }

    // ── 快捷处理浮卡（自绘 popover，bg-layer-3） ─────────────────────────────
    function decideApproval(rpc, row, decision, opts) {
      var o = opts || {}
      var note = ''
      if (decision === 'reject' && o.askNote) {
        try { note = window.prompt('驳回备注（可选，agent 复盘可见）:', '') || '' } catch (e) { note = '' }
      }
      return rpc('approvalDecide', { id: Number(row.id), decision: decision, note: note })
        .then(function (res) {
          if (o.onDone) o.onDone(res)
          return res
        })
    }

    function QuickRow(props) {
      var row = props.row
      var j = judgmentText(row)
      var subject = el('span', { style: { color: T.label, ...(F.sStrong || {}), fontFamily: uiCore.MONO, wordBreak: 'break-all' }, title: j || row.evidence || '' }, row.subject)
      return el('div', { style: { padding: '8px 10px', border: '1px solid ' + (T.border3 || T.border), borderRadius: 8, background: T.layer2, marginTop: 8 } },
        el('div', { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
          stateDot(row.status),
          kindChip(row.kind),
          hover(subject, j ? el('div', { style: { maxWidth: 320, color: T.label2, ...(F.xxs || {}), lineHeight: '18px' } }, j) : null),
          row.program_name ? el('span', { style: chipStyle(T.label2), title: '建议归属项目' }, '→ ' + row.program_name) : null),
        j ? el('div', { style: { color: T.label3, marginTop: 4, ...(F.xxxs || {}), wordBreak: 'break-word' } }, j.slice(0, 160)) : null,
        (row.evidence && !j) ? el('div', { style: { color: T.label3, marginTop: 4, ...(F.xxxs || {}), wordBreak: 'break-word' } }, String(row.evidence).slice(0, 160)) : null,
        el('div', { style: { display: 'flex', alignItems: 'center', gap: 6, marginTop: 6 } },
          tip('批准并执行对应动作（写 approval.decide，audit actor=dashboard）',
            el('button', {
              type: 'button', className: 'silksec-btn silksec-btn-confirm', disabled: !!props.busy,
              onClick: function () { props.onDecide(row, 'approve') },
            }, '批准')),
          tip('驳回并留痕（可填备注）',
            el('button', {
              type: 'button', className: 'silksec-btn silksec-icon-btn-danger', disabled: !!props.busy,
              onClick: function () { props.onDecide(row, 'reject') },
            }, '驳回')),
          el('span', { style: { marginLeft: 'auto', color: T.label3, ...(F.xxxs || {}) } }, '#' + row.id + ' · ' + fmtTime(row.created_at))))
    }

    function QuickCard(props) {
      var rows = (props.rows || []).filter(function (r) { return r.status === 'pending' })
      var shown = rows.slice(0, props.limit || 6)
      return el('div', { style: {
        position: 'fixed', right: 16, bottom: 64, width: 'min(400px, 92vw)', maxHeight: '62vh',
        overflowY: 'auto', background: T.layer3, border: '1px solid ' + (T.border2 || T.border),
        borderRadius: 10, padding: 12, boxShadow: 'var(--dsw-elevation-soft)', pointerEvents: 'auto',
      } },
        el('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
          checklistIcon(15),
          el('div', { style: { color: T.label, ...(F.sStrong || {}) } }, '待审批（' + rows.length + '）'),
          el('button', { type: 'button', className: 'silksec-btn', style: { marginLeft: 'auto', height: 24 }, title: '关闭', onClick: props.onClose }, '收起')),
        props.error ? el('div', { style: { ...(styles.errorLine || {}), color: T.error } }, '审批加载失败: ' + props.error) : null,
        rows.length
          ? shown.map(function (r) { return el(QuickRow, { key: r.id, row: r, busy: props.busy, onDecide: props.onDecide }) })
          : el('div', { style: { color: T.label3, padding: '14px 0', ...(F.xs || {}) } }, '无待审批事项'),
        rows.length > shown.length
          ? el('div', { style: { color: T.label3, marginTop: 6, ...(F.xxxs || {}) } }, '还有 ' + (rows.length - shown.length) + ' 条，打开审批中心查看全部')
          : null,
        el('button', {
          type: 'button', className: 'silksec-btn', style: { width: '100%', marginTop: 10, justifyContent: 'center' },
          title: '在右侧栏打开完整审批中心（无会话时降级到主面板 / Modal）',
          onClick: props.onOpenCenter,
        }, '打开审批中心 →'))
    }

    // ── 通知胶囊（shell.overlay 条目；点击弹快捷浮卡） ─────────────────────────
    function ApprovalCapsule() {
      var rpc = getRpc()
      var state = useApprovalData(rpc)
      var alert = useDisciplineAlert(rpc)
      var snap = useStore(approvalStore)
      var os = React.useState(false)
      var open = os[0]; var setOpen = os[1]
      var bs = React.useState(false)
      var busy = bs[0]; var setBusy = bs[1]
      var ms = React.useState(false)
      var modalOpen = ms[0]; var setModalOpen = ms[1]

      var pending = snap.pending || 0
      var rows = (state.data && state.data.rows) || snap.rows || []

      function onDecide(row, decision) {
        if (busy || typeof rpc !== 'function') return
        setBusy(true)
        decideApproval(rpc, row, decision, { askNote: decision === 'reject' }).then(function () {
          if (state.reload) state.reload()
        }).catch(function (e) {
          try { window.alert('操作失败: ' + (e && e.message ? e.message : e)) } catch (e2) {}
        }).then(function () { setBusy(false) })
      }
      function onOpenCenter() {
        setOpen(false)
        var where = openApprovalCenter()
        if (where === 'none') setModalOpen(true)
      }

      var capsule = el('button', {
        type: 'button', className: 'silksec-approval-capsule',
        'data-alert': alert ? 'true' : undefined,
        title: (alert ? '纪律告警；' : '') + '统一审批中心：待审批 ' + pending + ' 条；点击快捷处理',
        style: {
          position: 'fixed', right: 16, bottom: 16, zIndex: 60, pointerEvents: 'auto',
          display: 'inline-flex', alignItems: 'center', gap: 6, height: 34, padding: '0 14px 0 11px',
          borderRadius: 999, cursor: 'pointer', font: 'inherit',
          background: T.layer3, color: pending > 0 ? T.warn : T.label2,
          border: '1px solid ' + (alert ? T.error : (T.border2 || T.border)),
        },
        onClick: function () { setOpen(!open) },
      },
        warningIcon(14),
        el('span', { style: { ...(F.xxsStrong || {}) } }, '待审批 · ' + pending))

      if (!open) return capsule
      return el(React.Fragment, null,
        capsule,
        el(QuickCard, { rows: rows, error: state.error, busy: busy, onDecide: onDecide, onOpenCenter: onOpenCenter, onClose: function () { setOpen(false) } }),
        renderModal(modalOpen, rpc, function () { setModalOpen(false) }))
    }

    // ── 完整审批中心（右侧栏 tab 体 / 主面板降级视图 / Modal 三处共用） ────────
    function ApprovalCenter(props) {
      var rpc = (props && props.rpc) || getRpc()
      var state = useApprovalData(rpc)
      var snap = useStore(approvalStore)
      var ks = React.useState('')
      var kind = ks[0]; var setKind = ks[1]
      var ss = React.useState('')
      var status = ss[0]; var setStatus = ss[1]
      var hs = React.useState(false)
      var showHist = hs[0]; var setShowHist = hs[1]
      var bs = React.useState(false)
      var busy = bs[0]; var setBusy = bs[1]

      var rows = (state.data && state.data.rows) || snap.rows || []
      if (kind) rows = rows.filter(function (r) { return r.kind === kind })
      if (status) rows = rows.filter(function (r) { return r.status === status })
      var pending = rows.filter(function (r) { return r.status === 'pending' })
      var history = rows.filter(function (r) { return r.status !== 'pending' })

      function onDecide(row, decision) {
        if (busy || typeof rpc !== 'function') return
        setBusy(true)
        decideApproval(rpc, row, decision, { askNote: decision === 'reject' }).then(function () {
          if (state.reload) state.reload()
        }).catch(function (e) {
          try { window.alert('操作失败: ' + (e && e.message ? e.message : e)) } catch (e2) {}
        }).then(function () { setBusy(false) })
      }

      var kindOpts = ['', 'scope-wildcard', 'scope-domain', 'exclude-exception', 'tool-intrusive', 'task-budget-extend', 'task-complete', 'knowledge-publish', 'knowledge-adopt']
      return el('div', { style: { display: 'flex', flexDirection: 'column', minHeight: 0, ...(props && props.compact ? {} : { height: '100%' }) } },
        el('div', { style: { ...(styles.toolbar || {}), padding: props && props.compact ? 0 : undefined } },
          el('select', { className: 'silksec-input', value: kind, onChange: function (e) { setKind(e.target.value) }, title: '按审批类型筛选' },
            kindOpts.map(function (k) { return el('option', { key: k || 'all', value: k }, k ? (KIND_LABEL[k] || k) : '类型：全部') })),
          el('select', { className: 'silksec-input', value: status, onChange: function (e) { setStatus(e.target.value) }, title: '按审批状态筛选' },
            el('option', { value: '' }, '状态：全部'),
            el('option', { value: 'pending' }, '待审批'),
            el('option', { value: 'approved' }, '已批准'),
            el('option', { value: 'rejected' }, '已驳回')),
          el('span', { style: { marginLeft: 'auto', color: T.label3, ...(F.xxxs || {}) } },
            '待审批 ' + ((state.data && state.data.pending) || snap.pending || 0) + ' · 共 ' + rows.length + ' 条')),
        state.error ? el('div', { style: { ...(styles.errorLine || {}), color: T.error } }, '审批加载失败: ' + state.error) : null,
        el('div', { style: { flex: '1 1 auto', overflowY: 'auto', minHeight: 0 } },
          (props && props.compact)
            ? (pending.length ? pending.slice(0, 6).map(function (r) { return el(QuickRow, { key: r.id, row: r, busy: busy, onDecide: onDecide }) }) : el('div', { style: { color: T.label3, padding: '12px 0', ...(F.xs || {}) } }, '无待审批事项'))
            : el(React.Fragment, null,
                pending.length
                  ? el('div', null,
                      el('div', { style: { ...(styles.pageT || {}), marginTop: 12 } }, '待审批（' + pending.length + '）'),
                      pending.map(function (r) { return el(ApprovalRowCard, { key: r.id, row: r, busy: busy, onDecide: onDecide }) }))
                  : el(EmptyRow, { text: '无待审批事项' }),
                history.length
                  ? el('div', null,
                      el('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 18 } },
                        el('button', { type: 'button', className: 'silksec-btn', title: '历史决策留痕（approved/rejected）', onClick: function () { setShowHist(!showHist) } }, (showHist ? '收起' : '展开') + '历史（' + history.length + '）'),
                        !showHist ? el('span', { style: { color: T.label3, ...(F.xxxs || {}) } }, '最近 ' + history.length + ' 条决策记录') : null),
                      showHist ? history.map(function (r) { return el(ApprovalRowCard, { key: r.id, row: r, busy: busy, onDecide: onDecide }) }) : null)
                  : null)))
    }

    function EmptyRow(props) {
      var ES = uiCore && uiCore.EmptyState
      if (ES) return el(ES, { text: props.text })
      return el('div', { style: { color: T.label3, padding: '24px 0', ...(F.s || {}) } }, props.text || '暂无数据')
    }

    function ApprovalRowCard(props) {
      var r = props.row
      var isPending = r.status === 'pending'
      var p = parsePayload(r)
      var j = judgmentText(r)
      return el('div', { style: { ...(styles.card || {}), marginTop: 10, opacity: isPending ? 1 : 0.75 } },
        el('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
          kindChip(r.kind),
          el('span', { style: { color: T.label, ...(F.sStrong || {}), fontFamily: uiCore.MONO, wordBreak: 'break-all' } }, r.subject),
          r.program_name ? el('span', { style: chipStyle(T.label2), title: '建议归属项目' }, '→ ' + r.program_name) : null,
          stateDot(r.status),
          statusChip(r.status),
          el('span', { style: { marginLeft: 'auto', color: T.label3, ...(F.xxxs || {}) } }, '#' + r.id + ' · ' + fmtTime(r.created_at) + (r.requested_by ? ' · ' + r.requested_by : '')),
          isPending
            ? el('span', { style: { display: 'inline-flex', gap: 6 } },
                tip('批准并执行对应动作（写 approval.decide，audit actor=dashboard）',
                  el('button', { type: 'button', className: 'silksec-btn silksec-btn-confirm', disabled: !!props.busy, style: { height: 26 }, onClick: function () { props.onDecide(r, 'approve') } }, '批准')),
                tip('驳回并留痕（可填备注）',
                  el('button', { type: 'button', className: 'silksec-btn silksec-icon-btn-danger', disabled: !!props.busy, style: { height: 26 }, onClick: function () { props.onDecide(r, 'reject') } }, '驳回')))
            : null),
        j ? el('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 } },
            el('span', { style: chipStyle(T.label2), title: '判据摘要' }, j.slice(0, 200))) : null,
        (p && p.params && Object.keys(p.params).length)
          ? el('div', { style: { color: T.label3, marginTop: 4, ...(F.xxxs || {}), fontFamily: uiCore.MONO, wordBreak: 'break-all' }, title: '调用参数（已脱敏截断）' }, '参数: ' + Object.keys(p.params).map(function (k) { return k + '=' + decodeBlob(p.params[k]) }).join('  '))
          : null,
        (p && p.tail) ? el('div', { style: { color: T.label3, marginTop: 4, ...(F.xxxs || {}) }, title: '超时时 worker 尾部输出' }, 'worker 尾部: ' + String(p.tail).slice(0, 160)) : null,
        el('div', { style: { color: T.label2, marginTop: 6, ...(F.xxs || {}), wordBreak: 'break-word' } }, r.evidence || '—'),
        (p && p.corroboration) ? el('div', { style: { color: T.label3, marginTop: 4, ...(F.xxxs || {}) } }, '旁证: ' + p.corroboration) : null,
        (r.note && !isPending) ? el('div', { style: { color: T.label3, marginTop: 4, ...(F.xxxs || {}) } }, '决策备注: ' + r.note) : null)
    }

    // 右侧栏 tab 体（keyed `sidebar.right.pane.tab`，key = TAB_ID）
    function ApprovalTabBody() {
      return el(uiCore.SilksecErrorBoundary, { surface: 'ui-approval:tab', title: '审批' },
        el('div', { style: { height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0, padding: '10px 12px' } },
          el('div', { style: { ...(styles.pageSub || {}), marginBottom: 4 } }, '统一审批中心：批准前目标仍被 scope-guard fail-closed 拒绝。'),
          el(ApprovalCenter, { surface: 'approval-tab' })))
    }
    // 右侧栏 tab 标题（keyed `sidebar.right.pane.tab.title`；thunk/组件每次渲染重读计数）
    function ApprovalTabTitle() {
      var snap = useStore(approvalStore)
      return el('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } },
        checklistIcon(13), el('span', null, pendingLabel(snap.pending)))
    }
    function pendingLabel(n) { return n ? '审批 · ' + n : '审批' }

    // 主面板降级视图（ui-core 注册表 id = approval-degraded，角标「降级」）
    function ApprovalDegradedView(props) {
      return el(uiCore.SilksecErrorBoundary, { surface: 'ui-approval:degraded', title: '审批（降级）' },
        el('div', null,
          el('div', { style: { ...(styles.pageSub || {}), color: T.warn, marginBottom: 6 } }, '右侧栏不可用：审批中心降级挂主面板临时 tab（角标「降级」）。'),
          el(ApprovalCenter, { surface: 'approval-degraded', rpc: props && props.rpc, compact: false })))
    }

    // Modal 降级（主面板/layout 也缺席）；primitives.Modal 缺席时自绘 fixed 覆盖层
    function renderModal(open, rpc, onClose) {
      if (!open) return null
      var body = el('div', { style: { height: '70vh', display: 'flex', flexDirection: 'column', padding: 12 } },
        el(ApprovalCenter, { surface: 'approval-modal', rpc: rpc }))
      var M = prim('Modal')
      if (M) return el(M, { open: true, onClose: onClose, title: '审批中心', headless: true, className: 'silksec-dash-dialog' }, body)
      return el('div', {
        style: { position: 'fixed', inset: 0, zIndex: 80, background: T.base, display: 'flex', flexDirection: 'column', padding: 16, pointerEvents: 'auto' },
      },
        el('div', { style: { display: 'flex', alignItems: 'center' } },
          el('div', { style: { ...(styles.pageT || {}) } }, '审批中心'),
          el('button', { type: 'button', className: 'silksec-btn', style: { marginLeft: 'auto' }, title: '关闭', onClick: onClose }, '关闭')),
        body)
    }

    // ── 右侧栏 tab 类型定义（阶段一：静态类型进注册表） ───────────────────────
    function buildTabDefinition() {
      return {
        id: TAB_ID,
        kind: TAB_KIND,
        priority: 'extension',
        // title(address) 在 open 时捕获进布局记录；动态计数靠 keyed title 体重读。
        title: function () { return pendingLabel(approvalStore.get().pending) },
        guide: [{
          order: 60,
          title: function () { return '审批中心' },
          description: function () { return '待审批事项 · 批准 / 驳回留痕'; },
          icon: prim('IconChecklistOutline') || undefined,
        }],
      }
    }

    // ── 能力探测（非版本判断） ────────────────────────────────────────────────
    function slotDeclared(slots, name) {
      try { return !!(slots && typeof slots.spec === 'function' && slots.spec(name)) } catch (e) { return false }
    }
    function emitBadge(pending) {
      try { uiCore.secUiBus.emit('approval:pending', { pending: pending }) } catch (e) {}
    }
    // shell.overlay 缺席 → footer 计数徽章降级：footer.action 由 sec-dashboard legacy
    // 单条持有（勿重复注册），改为 secUiBus 广播 + 主面板 approvals tab 自带计数兜底。
    function startBadgeFallback() {
      var timer = null
      var rpc = getRpc()
      function tick() {
        if (typeof rpc !== 'function') { emitBadge(approvalStore.get().pending); return }
        rpc('approvalList', { limit: 1 }).then(function (res) {
          var p = Number(res && res.pending) || 0
          approvalStore.set({ pending: p })
          emitBadge(p)
        }).catch(function () { emitBadge(approvalStore.get().pending) })
      }
      tick()
      try {
        timer = setInterval(tick, POLL_MS)
        // 浏览器返回 number；Node 测试环境返回 Timeout，unref 防挂起（能力探测，非必需）
        if (timer && typeof timer.unref === 'function') timer.unref()
      } catch (e) { timer = null }
      return function () { if (timer) { try { clearInterval(timer) } catch (e) {} } }
    }

    // ── cordis 客户端插件：注册官方承载面 ─────────────────────────────────────
    var degradedDisposer = null
    function installDegraded(slots) {
      if (degradedDisposer) return
      if (!uiCore || !uiCore.viewRegistry || typeof uiCore.viewRegistry.register !== 'function') return
      degradedDisposer = uiCore.viewRegistry.register({
        id: DEGRADED_VIEW_ID, label: '审批 ·降级', order: 95, domain: 'approval',
        component: ApprovalDegradedView, source: 'silksec-ui-approval',
      })
      markSurfaceHealth('ui-approval', 'degraded', 'sidebarRightTabs 缺席：审批视图降级挂主面板')
    }
    function removeDegraded() {
      if (degradedDisposer) { try { degradedDisposer() } catch (e) {} degradedDisposer = null }
    }

    exports.name = 'silksec-ui-approval'
    // 插件级只依赖 slots（胶囊在 root scope 独立存活）；sidebarRightTabs/sidebarRight
    // 为可选，按需 ctx.inject 驱动（时序陷阱纪律：一切注册 inject 驱动 + effect 包裹）。
    exports.inject = ['slots']
    exports.apply = function (ctx) {
      serviceRef.ctx = ctx
      if (!uiCore || !uiCore.secUiBus) return
      var stopFallback = null

      // (A) 通知胶囊（shell.overlay，list/root）：只需 slots；缺席 → secUiBus 徽章降级
      ctx.inject(['slots'], function (scope) {
        ctx.effect(function () {
          var slots = scope.slots
          var disposers = []
          if (typeof slots.inject === 'function') {
            disposers.push(slots.inject('shell.overlay', function () {
              if (stopFallback) { stopFallback(); stopFallback = null }
              return slots.register({ name: 'shell.overlay', id: CAPSULE_ID, order: 60 }, ApprovalCapsule)
            }))
          }
          // 探针：声明未落地 → 启动徽章降级（声明随后到达时上面的 inject 会停掉它）
          if (!slotDeclared(slots, 'shell.overlay') && !stopFallback) stopFallback = startBadgeFallback()
          // sidebarRightTabs 缺席 → 主面板临时 tab 降级
          if (!getService('sidebarRightTabs')) installDegraded(slots)
          return function () {
            if (stopFallback) { stopFallback(); stopFallback = null }
            disposers.forEach(function (d) { try { if (typeof d === 'function') d() } catch (e) {} })
            removeDegraded()
          }
        })
      })

      // (B) 审批右侧栏 page tab：阶段一类型注册 + 阶段二 keyed tab 体/标题
      ctx.inject(['slots', 'sidebarRightTabs'], function (scope) {
        ctx.effect(function () {
          removeDegraded()
          var slots = scope.slots
          var tabs = scope.sidebarRightTabs
          var disposers = []
          if (tabs && typeof tabs.register === 'function') {
            disposers.push(tabs.register(buildTabDefinition()))
          }
          if (slots && typeof slots.inject === 'function') {
            disposers.push(slots.inject('sidebar.right.pane.tab', function () {
              return slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID }, ApprovalTabBody)
            }))
            disposers.push(slots.inject('sidebar.right.pane.tab.title', function () {
              return slots.register({ name: 'sidebar.right.pane.tab.title', key: TAB_ID }, ApprovalTabTitle)
            }))
          }
          markSurfaceHealth('ui-approval', 'ok', 'capsule + sidebar tab')
          return function () { disposers.forEach(function (d) { try { if (typeof d === 'function') d() } catch (e) {} }) }
        })
      })
    }

    // 稳定导出面（供单测 / 降级探测）
    exports.TAB_ID = TAB_ID
    exports.TAB_KIND = TAB_KIND
    exports.DEGRADED_VIEW_ID = DEGRADED_VIEW_ID
    exports.createApprovalStore = createApprovalStore
    exports.approvalStore = approvalStore
    exports.ApprovalCapsule = ApprovalCapsule
    exports.ApprovalCenter = ApprovalCenter
    exports.ApprovalTabBody = ApprovalTabBody
    exports.ApprovalTabTitle = ApprovalTabTitle
    exports.ApprovalDegradedView = ApprovalDegradedView
    exports.QuickCard = QuickCard
    exports.QuickRow = QuickRow
    exports.ApprovalRowCard = ApprovalRowCard
    exports.EmptyRow = EmptyRow
    exports.buildTabDefinition = buildTabDefinition
    exports.openApprovalCenter = openApprovalCenter
    exports.pendingLabel = pendingLabel
    exports.slotDeclared = slotDeclared
    exports.judgmentText = judgmentText
    exports.decideApproval = decideApproval
    exports.startBadgeFallback = startBadgeFallback

    return module.exports
  },
})
