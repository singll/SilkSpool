/**
 * @silksec/ui-task — client half (browser bundle)，16-dashboard P3 任务套件。
 *
 * 把任务域从主面板旧 tab 迁到 DSH 原生信息架构：
 *   1. 任务右侧栏 page tab：`ctx.sidebarRightTabs.register({ id, kind, priority,
 *      title, guide })`（阶段一：类型进注册表）+ tab 体/标题注册进 keyed
 *      `sidebar.right.pane.tab` / `sidebar.right.pane.tab.title`（key = 类型 id，
 *      阶段二）。栏内四区块自上而下：定时任务卡片（IconAlarmClockOutline +
 *      next_run_at 相对时间 fmtRel）→ 一次性队列（状态 StateDot）→ 工作区快块
 *      （窄栏降级为顶部 program 筛选 Pill 组）→ 执行历史（默认折叠 DisclosureRow）。
 *   2. 会话头「本会话任务」计数：`conversation.session.header.utilities`（list，右对齐，
 *      session scope；owner props 含 sessionId），图标钮 + 本会话活跃任务数；点击
 *      `ctx.sidebarRight.openTab('silksec-task')`（缺 sidebarRight → secUiBus/主面板/Modal）。
 *
 * 官方契约以 DSH 0.1.5-rc.2 类型声明逐字核对：
 *   - `SidebarRightTabRegistry.register(definition)`（P2 实测名称；字段
 *     id/kind/priority/title(address)/guide[{order,title,description?,icon?}]）；
 *     阶段二 key = definition.id，openTab 按 kind 寻址。
 *   - `conversation.session.header.utilities` kind=list scope=session；
 *     owner props 无专属值，运行时 props 携带 sessionId / useSessions（官方
 *     open-in-app 同槽先例）。
 *   - `slots.inject(key, cb)` 按槽声明生命周期注册；注册经 ctx.effect 收口。
 *   - primitives Pill/StateDot/DisclosureRow/Tooltip 与 IconAlarmClockOutline/
 *     IconQueueOutline 均在 rc.2 前端 primitives 模块导出（能力探测，非版本判断）。
 *
 * 降级链（§六.3）：
 *   sidebarRightTabs 缺席 → 同一任务视图注册进 ui-core 注册表（主面板「任务 ·降级」）
 *     主面板/layout 也缺席 → primitives Modal（再缺席自绘覆盖层）
 *   conversation.session.header.utilities 缺席 → 不注册（会话面无全局影响）
 *
 * 写操作与主面板等价：run_now/cancel/block/resume/schedule/create 统一走
 * `/silksec-dashboard` 的 taskRunNow/taskCancel/taskSetStatus/taskScheduleUpdate/
 * taskCreate（task.run_now/cancel/block/resume/schedule/create 域命令，
 * actor=dashboard + operator 由 RpcProjector 注入，audit 留痕一致）。
 *
 * 隔离：ErrorBoundary 逐面包；本包 apply 崩溃只销毁自身 fiber。本文件零颜色字面量，
 * 全部经 ui-core 令牌表 / --dsw-alias-*。
 */
window.__ModuleLoader__.load({
  id: '@silksec/ui-task',
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
    var fmtEvery = (uiCore && uiCore.fmtEvery) || function () { return '—' }
    var fmtRel = (uiCore && uiCore.fmtRel) || function () { return '' }
    var fmtDur = (uiCore && uiCore.fmtDur) || function () { return '—' }
    var fmtTs = (uiCore && uiCore.fmtTs) || function (x) { return x == null ? '—' : String(x) }
    var markSurfaceHealth = (uiCore && uiCore.markSurfaceHealth) || function () {}

    // ── 常量：注册标识 / 官方 kind / 降级 id ─────────────────────────────────
    var TAB_ID = 'silksec-task-view'       // 右侧栏实现身份（= keyed 槽 key）
    var TAB_KIND = 'silksec-task'          // 页面类型判别式（= openTab 参数）
    var HEADER_ID = 'silksec-task-header'  // 会话头 utilities 条目 id
    var TASK_MODAL_HOST_ID = 'silksec-task-modal-host'  // shell.overlay 常驻 Modal 宿主 id
    var DEGRADED_VIEW_ID = 'task-degraded'
    var DASHBOARD_PANEL_ID = 'silksec-dashboard'
    var POLL_MS = 30000
    var PHASES = ['recon', 'vuln', 'biz-logic', 'code-audit', 'intranet', 'review']
    var TASK_STATUS_LABEL = (uiCore && uiCore.TASK_STATUS_LABEL) || {
      queued: '排队', running: '运行中', blocked: '阻塞', done: '完成', failed: '失败', cancelled: '取消',
    }

    // apply 时捕获的客户端 root context（渲染期按需读 connection/layout/sidebarRight）
    var serviceRef = { ctx: null }
    function getService(name) {
      var ctx = serviceRef.ctx
      if (!ctx || typeof ctx.get !== 'function') return null
      try { return ctx.get(name) } catch (e) { return null }
    }
    // /silksec-dashboard RPC caller（与 sec-dashboard 主面板写操作同通道同端点）
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

    // ── 栏宽自适应样式（container query；零颜色字面量，全部经 --dsw-alias-*） ───
    var CSS_KEY = 'silksec-ui-task'
    function ensureStyles() {
      try {
        if (typeof document === 'undefined' || !document.head) return
        if (document.querySelector('style[data-plugin-css=' + JSON.stringify(CSS_KEY) + ']')) return
        var tag = document.createElement('style')
        tag.dataset.plugin = '@silksec/ui-task'
        tag.dataset.pluginCss = CSS_KEY
        tag.textContent = [
          '.silksec-task-center{container-type:inline-size;container-name:silksec-task;display:flex;flex-direction:column;min-height:0;height:100%;box-sizing:border-box}',
          '.silksec-task-body{flex:1 1 auto;overflow-y:auto;min-height:0;padding:2px 2px 16px}',
          '.silksec-task-queue-cards{display:none}',
          '.silksec-task-actions{display:inline-flex;gap:6px;flex-wrap:wrap}',
          '@container silksec-task (max-width:480px){.silksec-task-queue-table{display:none}.silksec-task-queue-cards{display:block}.silksec-task-workspaces{display:none}}',
        ].join('\n')
        document.head.appendChild(tag)
      } catch (e) { /* 样式注入失败不阻断功能 */ }
    }

    // ── 共享任务快照（tab 标题 / 会话头计数 / 降级视图共用） ────────────────────
    function createTaskStore() {
      var state = { scheduled: [], active: [], runs: [], activeCount: 0, runTotal: 0, loaded: false, updatedAt: 0 }
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
    var taskStore = createTaskStore()

    function useStore(store) {
      var s = React.useState(function () { return store.get() })
      var snap = s[0]; var setSnap = s[1]
      React.useEffect(function () {
        return store.subscribe(function (v) { setSnap(v) })
      }, [])
      return snap
    }

    // 全局活跃任务计数轮询（tab 标题 + 会话头计数共用；能力探测 rpc 缺席即静默）
    function startTaskPoll() {
      var timer = null
      function tick() {
        var rpc = getRpc()
        if (typeof rpc !== 'function') return
        Promise.all([
          rpc('scheduledTasks', {}).catch(function () { return null }),
          rpc('tasks', { bucket: 'active', limit: 200 }).catch(function () { return null }),
        ]).then(function (res) {
          var scheduled = (res[0] && res[0].rows) || []
          var active = (res[1] && res[1].rows) || []
          taskStore.set({
            scheduled: scheduled, active: active,
            activeCount: scheduled.length + active.length, loaded: true, updatedAt: Date.now(),
          })
        }).catch(function () {})
      }
      tick()
      try {
        timer = setInterval(tick, POLL_MS)
        // 浏览器返回 number；Node 测试环境返回 Timeout，unref 防挂起（能力探测，非必需）
        if (timer && typeof timer.unref === 'function') timer.unref()
      } catch (e) { timer = null }
      return function () { if (timer) { try { clearInterval(timer) } catch (e) {} } }
    }

    // ── 写操作：与主面板同端点同参数（RPC 端点 → 域命令） ─────────────────────
    var TASK_ACTIONS = {
      run_now: function (id) { return { endpoint: 'taskRunNow', payload: { id: Number(id) } } },
      cancel: function (id) { return { endpoint: 'taskCancel', payload: { id: Number(id) } } },
      block: function (id) { return { endpoint: 'taskSetStatus', payload: { id: Number(id), status: 'blocked' } } },
      resume: function (id) { return { endpoint: 'taskSetStatus', payload: { id: Number(id), status: 'queued' } } },
      schedule: function (id, everySeconds) {
        return { endpoint: 'taskScheduleUpdate', payload: { id: Number(id), schedule: { kind: 'interval', every_seconds: Math.round(Number(everySeconds)) } } }
      },
      create: function (spec) { return { endpoint: 'taskCreate', payload: spec || {} } },
    }
    // 单条操作 → RPC：args 按 op 位置参数传入（对齐主面板 onRunNow/onCancel/... 端点）。
    function taskAction(rpc, op, args) {
      var build = TASK_ACTIONS[op]
      if (typeof build !== 'function') return Promise.reject(new Error('未知任务操作: ' + op))
      if (typeof rpc !== 'function') return Promise.reject(new Error('连接通道不可用'))
      var req = build.apply(null, args || [])
      return rpc(req.endpoint, req.payload)
    }

    // ── 语义徽章 / 图标（primitives 可选，缺席走 ui-core 样式） ────────────────
    function pillNode(props) {
      var P = prim('Pill')
      var label = props.children
      if (P) return el(P, { active: !!props.active, onClick: props.onClick, title: props.title, style: props.style }, label)
      // 可点 pill = chip 语义（19-ui-unify §2.3）：样式唯一来源为 ui-core 基样式表
      if (props.onClick) {
        return el('button', {
          type: 'button', className: 'silksec-chip', 'data-on': props.active ? 'true' : undefined,
          title: props.title, style: props.style, onClick: props.onClick,
        }, label)
      }
      return el('span', { title: props.title, style: { ...(styles.pill || {}), ...(props.active ? { color: T.brand } : {}), ...(props.style || {}) } }, label)
    }
    function stateDot(status) {
      var SD = prim('StateDot')
      var state = status === 'running' ? 'ongoing'
        : (status === 'done') ? 'done'
          : (status === 'failed' || status === 'cancelled') ? 'error'
            : 'warning'
      if (SD) return el(SD, { state: state, size: 9 })
      var color = state === 'done' ? T.success : state === 'error' ? T.error : state === 'ongoing' ? T.business : T.warn
      return el('span', { style: { display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0 } })
    }
    function statusPill(status) {
      return el('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4, ...(styles.pill || {}), color: status === 'failed' || status === 'cancelled' ? T.error : status === 'done' ? T.success : status === 'running' ? T.business : T.label2 }, title: '任务状态 ' + status },
        stateDot(status), TASK_STATUS_LABEL[status] || status || 'queued')
    }
    function alarmIcon(size) {
      var I = prim('IconAlarmClockOutline')
      return I ? el(I, { size: size || 14 }) : (uiCore && uiCore.opIcon ? uiCore.opIcon('history') : null)
    }
    function queueIcon(size) {
      var I = prim('IconQueueOutline')
      return I ? el(I, { size: size || 14 }) : (uiCore && uiCore.opIcon ? uiCore.opIcon('list') : null)
    }
    function historyIcon(size) {
      var I = prim('IconClockOutline')
      return I ? el(I, { size: size || 14 }) : (uiCore && uiCore.opIcon ? uiCore.opIcon('history') : null)
    }
    // 图标按钮：title 悬停纪律（primitives Tooltip 可选增强）
    function tip(label, node) {
      var TT = prim('Tooltip')
      if (TT && label) return el(TT, { label: String(label), side: 'left', delayMs: 400 }, node)
      return node
    }
    function sessionLink(id) {
      if (!id) return null
      return tip('打开来源会话', el('button', {
        type: 'button', className: 'silksec-icon-btn', 'aria-label': '打开会话',
        onClick: function () {
          var sessions = getService('sessions')
          if (sessions && typeof sessions.open === 'function') { try { sessions.open(id) } catch (e) {} }
        },
      }, uiCore && uiCore.opIcon ? uiCore.opIcon('jump') : null))
    }

    // 打开任务中心：右侧栏 page tab 优先；无在屏会话 seat → 'none'，由调用方弹 Modal。
    // （19-ui-unify 补丁：不再回退主面板 selectPanel——主面板无任务 tab，旧 'panel' 静默无效。）
    function openTaskCenter() {
      var sr = getService('sidebarRight')
      if (sr && typeof sr.openTab === 'function') {
        try { sr.openTab(TAB_KIND); return 'tab' } catch (e) { /* 无在屏会话 seat → 降级 */ }
      }
      return 'none'
    }

    // 常驻任务中心 Modal 宿主（shell.overlay list/root）：外部经 secUiBus 'open:task'
    // 请求（如安全中心 KPI「运行中/阻塞任务」）时，有会话 → 右侧栏 tab；无 → 弹 Modal。
    function TaskModalHost() {
      var ms = React.useState(false)
      var open = ms[0]; var setOpen = ms[1]
      React.useEffect(function () {
        if (!uiCore.secUiBus || typeof uiCore.secUiBus.on !== 'function') return
        return uiCore.secUiBus.on('open:task', function () {
          var where = openTaskCenter()
          if (where === 'none') setOpen(true)
        })
      }, [])
      if (!open) return null
      return renderModal(true, getRpc(), function () { setOpen(false) })
    }

    // ── 四区块：定时任务卡片 / 一次性队列 / 工作区快块 / 执行历史 ──────────────
    var card = { padding: '10px 12px', borderRadius: 8, border: '1px solid ' + T.border, background: T.base, minWidth: 0, boxSizing: 'border-box', marginTop: 8 }
    var pill = (styles.pill || {})
    var iconBtn = { className: 'silksec-icon-btn', type: 'button' }
    var sectionHead = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 16 }
    var sectionTitle = { color: T.label, ...((F && F.sStrong) || {}) }
    var sectionSub = { color: T.label3, marginTop: 2, ...((F && F.xxs) || {}) }
    var metaLine = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 6, color: T.label3, ...((F && F.xxxs) || {}) }

    function sectionHeadNode(props) {
      return el('div', { style: sectionHead },
        el('span', { style: { color: T.label3, display: 'inline-flex' } }, props.icon || null),
        el('span', { style: sectionTitle }, props.title),
        props.count !== undefined ? el('span', { style: { ...pill, color: T.label3 } }, String(props.count)) : null,
        props.extra ? el('span', { style: { marginLeft: 'auto', display: 'inline-flex', gap: 6, alignItems: 'center' } }, props.extra) : null,
        props.subtitle ? el('div', { style: sectionSub }, props.subtitle) : null)
    }

    function ScheduledCard(props) {
      var t = props.task
      var paused = t.status === 'blocked'
      var lastOk = t.last_ok === null || t.last_ok === undefined ? null : (Number(t.last_ok) === 1)
      return el('div', { style: card },
        el('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
          el('span', { style: { color: T.label3, ...((F && F.xxxs) || {}), fontFamily: uiCore && uiCore.MONO } }, '#' + t.id),
          el('span', { style: { color: T.label, ...((F && F.sStrong) || {}), wordBreak: 'break-word', flex: '1 1 160px' }, title: t.objective }, t.objective),
          statusPill(t.status),
          t.phase ? pillNode({ title: '任务阶段' }, t.phase) : null,
          pillNode({ title: '下次运行: ' + fmtTime(t.next_run_at), style: { color: T.brand } },
            (t.schedule_kind === 'interval' ? fmtEvery(t.every_seconds) : '一次性') + (t.next_run_at ? ' · ' + fmtRel(t.next_run_at) : ''))),
        el('div', { style: metaLine },
          el('span', { title: '所属授权项目（工作区）' }, '🏢 ' + (t.program_id || '—')),
          t.last_run_at
            ? el('span', { style: { color: lastOk === false ? T.error : undefined }, title: (t.last_note || '') + '\n时间: ' + fmtTime(t.last_run_at) },
                (lastOk === false ? '✗ 上次失败 ' : '✓ 上次成功 ') + fmtRel(t.last_run_at))
            : el('span', null, '◌ 尚未运行'),
          el('span', { title: '累计运行 / 失败次数' }, 'Σ ' + (t.run_count || 0) + (t.fail_count ? '（失败 ' + t.fail_count + '）' : '')),
          el('span', { className: 'silksec-task-actions', style: { marginLeft: 'auto' } },
            sessionLink(t.session_id),
            tip('立即执行一次（不动调度节律）', el('button', { ...iconBtn, disabled: !!props.busy || paused || t.status !== 'queued', 'aria-label': '立即执行', onClick: function () { props.onRunNow(t.id) } }, uiCore.opIcon('play'))),
            tip(paused ? '恢复调度' : '暂停调度（保留周期，恢复后继续）', el('button', { ...iconBtn, disabled: !!props.busy, 'aria-label': paused ? '恢复' : '暂停', onClick: function () { paused ? props.onResume(t.id) : props.onBlock(t.id) } }, uiCore.opIcon(paused ? 'play' : 'stop'))),
            tip('改周期（分钟，如 1440=每天、60=每小时）', el('button', { ...iconBtn, disabled: !!props.busy, 'aria-label': '改周期', onClick: function () { props.onEditEvery(t) } }, uiCore.opIcon('edit'))),
            tip('查看该任务的执行历史（跳转并按任务过滤）', el('button', { ...iconBtn, 'aria-label': '执行历史', onClick: function () { props.onJumpHistory(t.id) } }, uiCore.opIcon('history'))),
            tip('取消任务（置为已取消，终态）', el('button', { ...iconBtn, className: 'silksec-icon-btn silksec-icon-btn-danger', disabled: !!props.busy, 'aria-label': '取消任务', onClick: function () { props.onCancel(t.id) } }, uiCore.opIcon('stop'))))),
        t.last_note && lastOk === false
          ? el('div', { style: { marginTop: 6, color: T.error, ...((F && F.xxs) || {}), wordBreak: 'break-word' }, title: t.last_note }, '最近失败：' + String(t.last_note).slice(0, 200))
          : null)
    }

    function QueueActions(props) {
      var t = props.task
      return el('span', { className: 'silksec-task-actions' },
        sessionLink(t.session_id),
        t.status === 'queued'
          ? tip('立即执行一次', el('button', { ...iconBtn, disabled: !!props.busy, 'aria-label': '立即执行', onClick: function () { props.onRunNow(t.id) } }, uiCore.opIcon('play')))
          : null,
        ['queued', 'running', 'blocked'].indexOf(t.status) >= 0
          ? tip('取消任务（置为已取消，终态）', el('button', { ...iconBtn, className: 'silksec-icon-btn silksec-icon-btn-danger', disabled: !!props.busy, 'aria-label': '取消任务', onClick: function () { props.onCancel(t.id) } }, uiCore.opIcon('stop')))
          : null,
        tip('查看该任务的执行历史', el('button', { ...iconBtn, 'aria-label': '执行历史', onClick: function () { props.onJumpHistory(t.id) } }, uiCore.opIcon('history'))))
    }

    // 窄栏卡片行（<480px 由 container query 与表格互换）
    function QueueCards(props) {
      var rows = props.rows || []
      return el('div', { className: 'silksec-task-queue-cards' }, rows.map(function (t) {
        return el('div', { key: String(t.id), style: card },
          el('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
            el('span', { style: { color: T.label3, ...((F && F.xxxs) || {}), fontFamily: uiCore && uiCore.MONO } }, '#' + t.id),
            el('span', { style: { color: T.label, ...((F && F.sStrong) || {}), wordBreak: 'break-word', flex: '1 1 140px' }, title: t.objective }, t.objective),
            statusPill(t.status)),
          el('div', { style: metaLine },
            t.program_id ? el('span', null, t.program_id) : null,
            t.phase ? el('span', null, t.phase) : null,
            el(QueueActions, { task: t, busy: props.busy, onRunNow: props.onRunNow, onCancel: props.onCancel, onJumpHistory: props.onJumpHistory })))
      }))
    }

    function QueueTable(props) {
      var rows = props.rows || []
      var th = styles.th || {}; var td = styles.td || {}
      return el('div', { className: 'silksec-task-queue-table', style: { overflowX: 'auto', minWidth: 0, marginTop: 10 } },
        el('table', { style: styles.tableStyle || { width: '100%', borderCollapse: 'collapse' } },
          el('colgroup', null,
            el('col', { style: { width: 52 } }),
            el('col', { style: { width: 90 } }),
            el('col', null),
            el('col', { style: { width: 70 } }),
            el('col', { style: { width: 108 } })),
          el('thead', null, el('tr', { style: styles.theadRow || {} },
            el('th', { style: th }, '#'),
            el('th', { style: th }, '工作区'),
            el('th', { style: th }, '目标'),
            el('th', { style: th }, '状态'),
            el('th', { style: th }, '操作'))),
          el('tbody', null, rows.map(function (t) {
            return el('tr', { key: String(t.id), className: 'silksec-row' },
              el('td', { style: styles.tdMono || td }, String(t.id)),
              el('td', { style: td }, t.program_id || '—'),
              el('td', { style: td, title: t.objective }, String(t.objective || '').slice(0, 80)),
              el('td', { style: td }, statusPill(t.status)),
              el('td', { style: { ...td, whiteSpace: 'nowrap' } }, el(QueueActions, { task: t, busy: props.busy, onRunNow: props.onRunNow, onCancel: props.onCancel, onJumpHistory: props.onJumpHistory })))
          }))))
    }

    function TaskRunLine(props) {
      var r = props.r
      var showTask = props.showTask !== false
      return el('div', { style: { padding: '6px 0', borderTop: '1px solid ' + T.border3 } },
        el('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
          el('span', { style: { color: T.label3, ...((F && F.xxxs) || {}), fontFamily: uiCore && uiCore.MONO, whiteSpace: 'nowrap' } }, fmtTs(r.finished_at || r.started_at)),
          showTask ? el('span', { style: { color: T.label2, ...((F && F.xxs) || {}), wordBreak: 'break-word', flex: '1 1 160px' } }, '#' + r.task_id + ' ' + String(r.objective || '')) : null,
          el('span', { style: { ...pill, color: r.ok ? T.success : T.error } }, r.ok ? '✓ 成功' : '✗ 失败'),
          el('span', { style: { color: T.label3, ...((F && F.xxxs) || {}), whiteSpace: 'nowrap' }, title: '耗时' }, '⏱ ' + fmtDur(r.duration_ms)),
          r.session_id ? sessionLink(r.session_id) : null,
          r.note ? el('span', { style: { color: T.label3, ...((F && F.xxs) || {}), wordBreak: 'break-word', flex: '2 1 160px' } }, String(r.note)) : null))
    }

    function HistoryBlock(props) {
      var rows = props.rows || []
      var D = prim('DisclosureRow')
      var body = el('div', null,
        props.runTaskId ? el('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 } },
          el('span', { style: { ...pill, color: T.brand } }, '任务 #' + props.runTaskId),
          el('button', { type: 'button', className: 'silksec-btn', title: '清除任务过滤，回到全量历史', onClick: props.onClearFilter }, '✕ 清除过滤')) : null,
        rows.length
          ? rows.map(function (r) { return el(TaskRunLine, { key: String(r.id), r: r, showTask: !props.runTaskId }) })
          : el('div', { style: { color: T.label3, padding: '10px 0', ...((F && F.xs) || {}) } }, props.runTaskId ? '该任务暂无执行历史' : '暂无执行历史'))
      if (D) {
        return el(D, {
          title: '执行历史' + (props.total !== undefined ? ' · ' + props.total + ' 条' : ''),
          open: !!props.open, expandable: true, onToggle: props.onToggle,
          expandOnRowClick: true, icon: historyIcon(14),
        }, body)
      }
      return el('div', null,
        el('div', { style: { ...sectionHead, cursor: 'pointer' }, onClick: props.onToggle, title: props.open ? '点击收起' : '点击展开' },
          el('span', { style: { color: T.label3 } }, props.open ? '▾' : '▸'),
          historyIcon(14), el('span', { style: sectionTitle }, '执行历史'),
          props.total !== undefined ? el('span', { style: { ...pill, color: T.label3 } }, String(props.total)) : null),
        props.open ? body : null)
    }

    function WorkspaceQuick(props) {
      var items = props.items || []
      var openState = React.useState(false)
      var open = openState[0]; var setOpen = openState[1]
      if (!items.length) return null
      return el('div', { className: 'silksec-task-workspaces', style: { marginTop: 16 } },
        el('div', { style: { ...sectionHead, cursor: 'pointer', marginTop: 0 }, onClick: function () { setOpen(!open) } },
          el('span', { style: { color: T.label3 } }, open ? '▾' : '▸'),
          el('span', { style: sectionTitle }, '工作区'),
          el('span', { style: { ...pill, color: T.label3 } }, String(items.length)),
          el('div', { style: sectionSub }, 'DSH 工作区（Program 1:1），窄栏自动收为顶部 program 筛选。')),
        open
          ? el('div', { style: { marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 } }, items.map(function (w) {
            return el('div', { key: w.id, style: card },
              el('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
                el('span', { style: { color: T.label, ...((F && F.sStrong) || {}) } }, w.title),
                w.program
                  ? el('span', { style: { ...pill, color: T.success }, title: '绑定的 scope.yml 授权项目' }, '授权 ' + w.program.id)
                  : el('span', { style: { ...pill, color: T.warn }, title: '未绑定 scope.yml 授权项目（fail-closed）' }, '未绑定授权'),
                el('span', { style: { marginLeft: 'auto', color: T.label3, ...((F && F.xxxs) || {}) } }, '任务 ' + (w.tasks || 0) + ' · 资产 ' + (w.assets || 0) + ' · 漏洞 ' + (w.findings || 0))))
          }))
          : null)
    }

    function CreateForm(props) {
      var programs = props.programs || []
      var pid = React.useState(programs.length ? programs[0].v : '')
      var obj = React.useState('')
      var phase = React.useState('recon')
      var hours = React.useState(24)
      if (!programs.length) return el('div', { style: { ...card, color: T.label3, ...((F && F.xxs) || {}) } }, '暂无已授权工作区，先到「授权」区域登记并绑定。')
      function submit() {
        var h = Number(hours[0])
        if (!obj[0].trim() || !pid[0] || !(h >= 1)) return
        var spec = { program_id: pid[0], objective: obj[0].trim(), phase: phase[0], schedule: { kind: 'interval', every_seconds: Math.round(h * 3600) } }
        props.onCreate(spec)
        obj[1]('')
      }
      var inputCls = 'silksec-input'
      var inputStyle = { width: '100%', boxSizing: 'border-box' }
      var row = { display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 8, flex: '1 1 140px' }
      var label = { color: T.label2, ...((F && F.xxsStrong) || {}) }
      return el('div', { style: { ...card, borderColor: T.border3 } },
        el('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap' } },
          el('div', { style: row }, el('span', { style: label }, '工作区'), el('select', { className: inputCls, style: inputStyle, value: pid[0], onChange: function (e) { pid[1](e.target.value) } }, programs.map(function (o) { return el('option', { key: o.v, value: o.v }, o.l) }))),
          el('div', { style: row }, el('span', { style: label }, '阶段'), el('select', { className: inputCls, style: inputStyle, value: phase[0], onChange: function (e) { phase[1](e.target.value) } }, PHASES.map(function (c) { return el('option', { key: c, value: c }, c) }))),
          el('div', { style: row }, el('span', { style: label }, '周期（小时）'), el('input', { className: inputCls, style: inputStyle, type: 'number', min: 1, value: hours[0], onChange: function (e) { hours[1](e.target.value) } }))),
        el('div', { style: row }, el('span', { style: label }, '任务目标（同工作区同目标幂等去重）'), el('textarea', { className: inputCls, style: { ...inputStyle, height: 56, padding: '8px 10px', resize: 'vertical' }, value: obj[0], onChange: function (e) { obj[1](e.target.value) } })),
        el('div', { style: { display: 'flex', gap: 8 } },
          el('button', { type: 'button', className: 'silksec-btn silksec-btn-confirm', disabled: !!props.busy, onClick: submit }, '创建周期任务'),
          el('button', { type: 'button', className: 'silksec-btn', onClick: props.onClose }, '收起')))
    }

    // ── 任务中心（右侧栏 tab 体 / 主面板降级视图 / Modal 三处共用） ────────────
    function TaskCenter(props) {
      ensureStyles()
      var rpc = (props && props.rpc) || getRpc()
      var useRpcCore = uiCore && uiCore.useRpc
      var pf = React.useState('')
      var progFilter = pf[0]; var setProgFilter = pf[1]
      var bs = React.useState(false)
      var busy = bs[0]; var setBusy = bs[1]
      var hs = React.useState(false)
      var histOpen = hs[0]; var setHistOpen = hs[1]
      var rf = React.useState('')
      var runTaskId = rf[0]; var setRunTaskId = rf[1]
      var cs = React.useState(false)
      var creating = cs[0]; var setCreating = cs[1]
      var histRef = React.useRef ? React.useRef(null) : { current: null }

      if (typeof useRpcCore !== 'function') {
        return el('div', { style: { color: T.label3, ...((F && F.xs) || {}) } }, 'ui-core hooks 不可用，任务中心降级为空。')
      }

      var schedState = useRpcCore(function () { return { endpoint: 'scheduledTasks' } }, [], rpc || undefined)
      var tasksState = useRpcCore(function () {
        return { endpoint: 'tasks', payload: { bucket: 'active', limit: 200, program_id: progFilter } }
      }, [progFilter], rpc || undefined)
      var runsState = useRpcCore(function () {
        var payload = { limit: 20 }
        if (runTaskId) payload.task_id = Number(runTaskId)
        return { endpoint: 'taskRuns', payload: payload }
      }, [runTaskId], rpc || undefined)
      var wsState = useRpcCore(function () { return { endpoint: 'workspaces' } }, [], rpc || undefined)
      // 全量授权项目：筛选选项的数据源（不随 progFilter 变化，19-ui-unify 补丁）
      var progsState = useRpcCore(function () { return { endpoint: 'programs' } }, [], rpc || undefined)

      var scheduled = (schedState.data && schedState.data.rows) || []
      var queue = (tasksState.data && tasksState.data.rows) || []
      if (progFilter) scheduled = scheduled.filter(function (t) { return String(t.program_id) === String(progFilter) })
      var runs = (runsState.data && runsState.data.rows) || []
      var runTotal = (runsState.data && runsState.data.total) || runs.length
      var wsItems = (wsState.data && wsState.data.items) || []

      // 顶部 program 筛选胶囊（窄栏工作区快块的降级形态）。
      // 选项 = 工作区 ∪ 全量 programs，**与当前筛选无关**——点击筛选后选项不塌缩。
      var progMap = {}
      wsItems.forEach(function (w) { if (w.program && w.program.id) progMap[w.program.id] = w.title })
      ;((progsState.data) || []).forEach(function (p) {
        var id = p && (p.id || p.program_id || p.name)
        if (id && !progMap[id]) progMap[id] = String(id)
      })
      var progOpts = Object.keys(progMap)
      function filterChip(pid, label) {
        var active = pid ? progFilter === pid : !progFilter
        return el('button', {
          type: 'button', className: 'silksec-chip', 'data-on': active ? 'true' : undefined,
          title: pid ? '筛选工作区 ' + pid : '显示全部工作区',
          onClick: function () { setProgFilter(pid ? (progFilter === pid ? '' : pid) : '') },
        }, label)
      }
      var filterRow = progOpts.length
        ? el('div', { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginTop: 10 } },
            el('span', { style: { color: T.label3, ...((F && F.xxxs) || {}) } }, '工作区'),
            filterChip('', '全部'),
            progOpts.map(function (pid) {
              return el('span', { key: pid }, filterChip(pid, progMap[pid]))
            }))
        : null

      function reloadAll() {
        if (schedState.reload) schedState.reload()
        if (tasksState.reload) tasksState.reload()
        if (runsState.reload) runsState.reload()
      }
      function withBusy(op, args) {
        if (busy) return
        setBusy(true)
        taskAction(rpc, op, args).then(function () {
          reloadAll()
        }).catch(function (e) {
          try { if (window.alert) window.alert('操作失败: ' + (e && e.message ? e.message : e)) } catch (e2) {}
        }).then(function () { setBusy(false) })
      }
      function onCancel(tid) {
        var yes = false
        try { yes = window.confirm('确认取消任务 #' + tid + '？将置为终态「已取消」。') } catch (e) { return }
        if (yes) withBusy('cancel', [tid])
      }
      function onEditEvery(t) {
        var curMin = Math.round((t.every_seconds || 86400) / 60)
        var v = null
        try { v = window.prompt('修改周期（分钟，如 1440=每天、60=每小时）:', String(curMin)) } catch (e) { return }
        if (v === null) return
        var min = Number(v)
        if (!isNaN(min) && min >= 5) withBusy('schedule', [t.id, min * 60])
      }
      function jumpHistory(taskId) {
        setRunTaskId(String(taskId))
        setHistOpen(true)
        if (histRef.current && histRef.current.scrollIntoView) {
          setTimeout(function () { try { histRef.current.scrollIntoView({ block: 'start' }) } catch (e) {} }, 30)
        }
      }
      function onCreate(spec) {
        withBusy('create', [spec])
        setCreating(false)
      }

      var busyProps = { busy: busy, onRunNow: function (id) { withBusy('run_now', [id]) }, onCancel: onCancel, onBlock: function (id) { withBusy('block', [id]) }, onResume: function (id) { withBusy('resume', [id]) }, onEditEvery: onEditEvery, onJumpHistory: jumpHistory }

      return el('div', { className: 'silksec-task-center' },
        el('div', { className: 'silksec-task-body' },
          el('div', { style: { ...sectionHead, marginTop: 0 } },
            el('span', { style: sectionTitle }, '任务'),
            el('span', { style: { ...pill, color: T.label3 }, title: '活跃任务 = 定时任务 + 一次性队列' }, String(scheduled.length + queue.length)),
            props && props.compact ? null : el('div', { style: sectionSub }, '任务中心：与主面板任务 tab 同端点同写命令（actor=dashboard）。'),
            el('span', { style: { marginLeft: 'auto' } },
              tip(creating ? '收起新建表单' : '新建固定周期任务', el('button', { type: 'button', className: 'silksec-btn', disabled: !!busy, onClick: function () { setCreating(!creating) } }, creating ? '收起' : '新建')))),
          filterRow,
          creating ? el(CreateForm, { programs: wsItems.filter(function (w) { return w.program }).map(function (w) { return { v: w.program.id, l: w.title + '（' + w.program.id + '）' } }), busy: busy, onCreate: onCreate, onClose: function () { setCreating(false) } }) : null,

          // 区块一：定时任务卡片
          sectionHeadNode({ title: '定时任务', count: scheduled.length, icon: alarmIcon(14), subtitle: '固定周期实体：跑完自动续期不增殖；每行「🕘」跳到执行历史。' }),
          schedState.error ? el('div', { style: { ...(styles.errorLine || {}), color: T.error } }, '定时任务加载失败: ' + schedState.error) : null,
          scheduled.length
            ? el('div', null, scheduled.map(function (t) { return el(ScheduledCard, { key: String(t.id), task: t, ...busyProps }) }))
            : el('div', { style: { color: T.label3, padding: '10px 0', ...((F && F.xs) || {}) } }, '暂无定时任务'),

          // 区块二：一次性队列（<480px 表格换卡片行）
          sectionHeadNode({ title: '一次性队列', count: queue.length, icon: queueIcon(14), subtitle: '编排器派发的一次性任务（链步骤、N-day 候选等）；状态点 + 行内操作。' }),
          tasksState.error ? el('div', { style: { ...(styles.errorLine || {}), color: T.error } }, '任务队列加载失败: ' + tasksState.error) : null,
          queue.length
            ? el(React.Fragment, null,
                el(QueueTable, { rows: queue, ...busyProps }),
                el(QueueCards, { rows: queue, ...busyProps }))
            : el('div', { style: { color: T.label3, padding: '10px 0', ...((F && F.xs) || {}) } }, '暂无一次性任务'),

          // 区块三：工作区快块（窄栏降级为顶部 program 筛选 Pill 组）
          el(WorkspaceQuick, { items: wsItems }),

          // 区块四：执行历史（默认折叠 DisclosureRow）
          el('div', { ref: histRef, style: { marginTop: 16 } },
            HistoryBlock({ open: histOpen, onToggle: function () { setHistOpen(!histOpen) }, rows: runs, total: runTotal, runTaskId: runTaskId, onClearFilter: function () { setRunTaskId('') } }))))
    }

    // 右侧栏 tab 体（keyed `sidebar.right.pane.tab`，key = TAB_ID）
    function TaskTabBody() {
      return el(uiCore.SilksecErrorBoundary, { surface: 'ui-task:tab', title: '任务' },
        el('div', { style: { height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0, padding: '10px 12px' } },
          el(TaskCenter, { surface: 'task-tab' })))
    }
    // 右侧栏 tab 标题（keyed `sidebar.right.pane.tab.title`；thunk/组件每次渲染重读计数）
    function TaskTabTitle() {
      var snap = useStore(taskStore)
      return el('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } },
        alarmIcon(13), el('span', null, taskLabel(snap.activeCount)))
    }
    function taskLabel(n) { return n ? '任务 · ' + n : '任务' }

    // 会话头「本会话任务」计数（conversation.session.header.utilities，list/session）
    // 数据：task.scheduled + task.list(active) 按 session_id 过滤（owner props 含 sessionId）。
    function HeaderTaskCount(props) {
      ensureStyles()
      var snap = useStore(taskStore)
      var sid = props && props.sessionId
      var ms = React.useState(false)
      var modalOpen = ms[0]; var setModalOpen = ms[1]
      if (!snap.loaded) return null
      var rows = (snap.scheduled || []).concat(snap.active || [])
      var mine = sid ? rows.filter(function (r) { return String(r.session_id) === String(sid) }) : []
      var n = sid ? mine.length : (snap.activeCount || 0)
      var running = mine.filter(function (r) { return r.status === 'running' }).length
      var label = sid ? ('本会话任务 ' + n + ' 个' + (running ? '（运行中 ' + running + '）' : '')) : ('全局活跃任务 ' + n + ' 个')
      var btn = el('button', {
        type: 'button', className: 'silksec-icon-btn',
        title: label + '；点击打开任务中心（右侧栏）', 'aria-label': label,
        style: { width: 'auto', height: 26, padding: '0 8px', display: 'inline-flex', alignItems: 'center', gap: 4 },
        onClick: function () { var where = openTaskCenter(); if (where === 'none') setModalOpen(true) },
      }, alarmIcon(13), n ? el('span', { style: { ...((F && F.xxxs) || {}) } }, String(n)) : null)
      if (!modalOpen) return btn
      return el(React.Fragment, null, btn, renderModal(true, getRpc(), function () { setModalOpen(false) }))
    }

    // 主面板降级视图（ui-core 注册表 id = task-degraded，角标「降级」）
    function TaskDegradedView(props) {
      return el(uiCore.SilksecErrorBoundary, { surface: 'ui-task:degraded', title: '任务（降级）' },
        el('div', { style: { padding: '8px 0' } },
          el('div', { style: { ...((styles.pageSub) || {}), color: T.warn, marginBottom: 6 } }, '右侧栏不可用：任务中心降级挂主面板临时 tab（角标「降级」）。'),
          el(TaskCenter, { surface: 'task-degraded', rpc: props && props.rpc })))
    }

    // Modal 降级（主面板/layout 也缺席）；primitives.Modal 缺席时自绘 fixed 覆盖层
    function renderModal(open, rpc, onClose) {
      if (!open) return null
      var body = el('div', { style: { height: '70vh', display: 'flex', flexDirection: 'column', padding: 12 } },
        el(TaskCenter, { surface: 'task-modal', rpc: rpc, compact: true }))
      var M = prim('Modal')
      if (M) return el(M, { open: true, onClose: onClose, title: '任务中心', headless: true, className: 'silksec-dash-dialog' }, body)
      return el('div', { style: { position: 'fixed', inset: 0, zIndex: 80, background: T.base, display: 'flex', flexDirection: 'column', padding: 16, pointerEvents: 'auto' } },
        el('div', { style: { display: 'flex', alignItems: 'center' } },
          el('div', { style: { ...((styles.pageT) || {}) } }, '任务中心'),
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
        title: function () { return taskLabel(taskStore.get().activeCount) },
        guide: [{
          order: 70,
          title: function () { return '任务中心' },
          description: function () { return '定时任务 · 一次性队列 · 执行历史'; },
          icon: prim('IconAlarmClockOutline') || undefined,
        }],
      }
    }

    // ── 能力探测（非版本判断） ────────────────────────────────────────────────
    function slotDeclared(slots, name) {
      try { return !!(slots && typeof slots.spec === 'function' && slots.spec(name)) } catch (e) { return false }
    }

    var degradedDisposer = null
    function installDegraded(slots) {
      if (degradedDisposer) return
      if (!uiCore || !uiCore.viewRegistry || typeof uiCore.viewRegistry.register !== 'function') return
      degradedDisposer = uiCore.viewRegistry.register({
        id: DEGRADED_VIEW_ID, label: '任务 ·降级', order: 96, domain: 'task',
        component: TaskDegradedView, source: 'silksec-ui-task',
      })
      markSurfaceHealth('ui-task', 'degraded', 'sidebarRightTabs 缺席：任务视图降级挂主面板')
    }
    function removeDegraded() {
      if (degradedDisposer) { try { degradedDisposer() } catch (e) {} degradedDisposer = null }
    }

    exports.name = 'silksec-ui-task'
    exports.inject = ['slots']
    exports.apply = function (ctx) {
      serviceRef.ctx = ctx
      ensureStyles()
      if (!uiCore || !uiCore.secUiBus) return
      var stopPoll = null

      // (A) 任务计数 + 会话头 utilities：只需 slots；sidebarRightTabs 缺席 → 主面板降级
      ctx.inject(['slots'], function (scope) {
        ctx.effect(function () {
          var slots = scope.slots
          var disposers = []
          if (!stopPoll) stopPoll = startTaskPoll()
          // 会话头「本会话任务」计数：槽缺席 slots.inject 静默 no-op（会话面无全局影响）
          if (slots && typeof slots.inject === 'function') {
            disposers.push(slots.inject('conversation.session.header.utilities', function () {
              return slots.register({ name: 'conversation.session.header.utilities', id: HEADER_ID, order: 40 }, HeaderTaskCount)
            }))
            // 常驻 Modal 宿主：外部 open:task 请求（安全中心 KPI）无会话 seat 时的兜底
            disposers.push(slots.inject('shell.overlay', function () {
              return slots.register({ name: 'shell.overlay', id: TASK_MODAL_HOST_ID, order: 62 }, TaskModalHost)
            }))
          }
          if (!getService('sidebarRightTabs')) installDegraded(slots)
          return function () {
            if (stopPoll) { stopPoll(); stopPoll = null }
            disposers.forEach(function (d) { try { if (typeof d === 'function') d() } catch (e) {} })
            removeDegraded()
          }
        })
      })

      // (B) 任务右侧栏 page tab：阶段一类型注册 + 阶段二 keyed tab 体/标题
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
              return slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID }, TaskTabBody)
            }))
            disposers.push(slots.inject('sidebar.right.pane.tab.title', function () {
              return slots.register({ name: 'sidebar.right.pane.tab.title', key: TAB_ID }, TaskTabTitle)
            }))
          }
          markSurfaceHealth('ui-task', 'ok', 'sidebar tab + session header count')
          return function () { disposers.forEach(function (d) { try { if (typeof d === 'function') d() } catch (e) {} }) }
        })
      })
    }

    // 稳定导出面（供单测 / 降级探测）
    exports.TAB_ID = TAB_ID
    exports.TAB_KIND = TAB_KIND
    exports.HEADER_ID = HEADER_ID
    exports.DEGRADED_VIEW_ID = DEGRADED_VIEW_ID
    exports.createTaskStore = createTaskStore
    exports.taskStore = taskStore
    exports.taskAction = taskAction
    exports.TASK_ACTIONS = TASK_ACTIONS
    exports.startTaskPoll = startTaskPoll
    exports.TaskCenter = TaskCenter
    exports.TaskTabBody = TaskTabBody
    exports.TaskTabTitle = TaskTabTitle
    exports.HeaderTaskCount = HeaderTaskCount
    exports.TaskDegradedView = TaskDegradedView
    exports.ScheduledCard = ScheduledCard
    exports.QueueTable = QueueTable
    exports.QueueCards = QueueCards
    exports.WorkspaceQuick = WorkspaceQuick
    exports.HistoryBlock = HistoryBlock
    exports.TaskRunLine = TaskRunLine
    exports.buildTabDefinition = buildTabDefinition
    exports.openTaskCenter = openTaskCenter
    exports.taskLabel = taskLabel
    exports.slotDeclared = slotDeclared

    return module.exports
  },
})
