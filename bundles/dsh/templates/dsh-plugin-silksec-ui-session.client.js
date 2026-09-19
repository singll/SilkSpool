/**
 * @silksec/ui-session — client half (browser bundle)，16-dashboard P5 会话内绑定。
 *
 * 把「安全产出」与「登记候选漏洞 / 沉淀事实」深度绑到 DSH 官方会话信息架构上，
 * 全部 additive（只碰 list 槽，绝不碰 chain 槽 conversation.chat.turnTail）：
 *   1. `conversation.view`（list/session）：注册 ViewTab
 *      { id:'silksec-security', label:'安全产出' }，会话头出现平级视图页签；
 *      视图内按生产者 session_id 过滤本会话产出的漏洞/事实/任务/Run，行内跳链
 *      （ctx.sessions.open）保留，反向回路可开看板/审批。
 *   2. `conversation.session.header.utilities`（list/session，右对齐）：图标钮
 *      「安全产出」，计数 = 本会话 findings + facts（按运行时 props.sessionId 过滤）；
 *      点击经官方会话视图切换 API `selectView('silksec-security')` 切到该视图。
 *   3. `conversation.chat.assistant-actions`（list/session，owner { messageId }）：
 *      每条定稿 assistant 消息追加「登记候选漏洞」「沉淀事实」两个动作；点击弹
 *      primitives Modal 小表单（预填消息摘要），RiskConfirmation 确认写操作。
 *
 * 官方契约以 DSH 0.1.5-rc.2 类型声明逐字核对：
 *   - conversation `contract/slots.d.ts`：'conversation.view' kind=list scope=session
 *     owner=ConvViewOwnerProps；'conversation.session.header.utilities' kind=list
 *     scope=session；header inject face 暴露 `selectView(view)`（ConversationSessionHeaderInjected）。
 *   - conversation `contract/views.d.ts`：ViewTab{id,label} 由 registration options
 *     投影（label 落回 id）；trajectory 官方先例 register({ name,id,order,locale,label,inject })。
 *   - chat `contract/slots.d.ts`：'conversation.chat.assistant-actions' kind=list
 *     scope=session owner=AssistantActionOwnerProps{ messageId }（每 messageId 一条有序动作行）。
 *   - `slots.inject(key, cb)` 按槽声明生命周期注册；注册经 ctx.effect 收口。
 *   - primitives Modal / RiskConfirmation / IconChecklistOutline 能力探测消费（非版本判断）。
 *
 * 写操作（/silksec-domain，RpcProjector 注入 actor=dashboard + operator，审计可区分）：
 *   - 登记候选漏洞：`vuln.register_candidate`（语义动词，actor 白名单含 dashboard——
 *     操作员从会话登记只产候选、天然缺口播待验证；确权走 vuln_confirm）。
 *   - 沉淀事实：`fact.upsert`（actor 白名单含 dashboard，原生写动词）。
 *
 * 降级链（§六.3）：任一会话槽缺席 → 不注册该面（会话面无全局影响），不抛；
 *   不改变主面板 11 视图行为。隔离：SilksecErrorBoundary 逐面包；本文件零颜色字面量。
 */
window.__ModuleLoader__.load({
  id: '@silksec/ui-session',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    var React = require('react')
    var el = React.createElement
    // 跨 bundle require 看板 UI 内核（package.json dsh.client.inject 声明随 setup 脚本）。
    var uiCore = null
    try { uiCore = require('@silksec/ui-core') } catch (e) { uiCore = null }
    // primitives 为可选增强：缺席时全部走 ui-core 令牌样式 + title 兜底（能力探测）。
    var primitives = null
    try { primitives = require('@deepseek-ai/dsh-client-ui-primitives') } catch (e) { primitives = null }
    function prim(name) { try { return (primitives && primitives[name]) || null } catch (e) { return null } }

    var T = (uiCore && uiCore.T) || {}
    var F = (uiCore && uiCore.F) || {}
    var styles = (uiCore && uiCore.styles) || {}
    var MONO = (uiCore && uiCore.MONO) || 'monospace'
    var fmtTs = (uiCore && uiCore.fmtTs) || function (x) { return x == null ? '—' : String(x) }
    var fmtRel = (uiCore && uiCore.fmtRel) || function () { return '' }
    var SEV_LABEL = (uiCore && uiCore.SEV_LABEL) || {}
    var SEV_COLOR = (uiCore && uiCore.SEV_COLOR) || {}
    var STATUS_LABEL = (uiCore && uiCore.STATUS_LABEL) || {}
    var CONF_LABEL = (uiCore && uiCore.CONF_LABEL) || {}
    var TASK_STATUS_LABEL = (uiCore && uiCore.TASK_STATUS_LABEL) || {}
    var markSurfaceHealth = (uiCore && uiCore.markSurfaceHealth) || function () {}

    // ── 常量：注册标识 / 官方槽 / 路由 / 降级 id ────────────────────────────────
    var VIEW_ID = 'silksec-security'            // conversation.view 条目 id（= ViewTab.id）
    var HEADER_ID = 'silksec-security-header'   // conversation.session.header.utilities 条目 id
    var ACTIONS_ID = 'silksec-message-actions'  // conversation.chat.assistant-actions 条目 id
    var DASHBOARD_PANEL_ID = 'silksec-dashboard'
    var DASHBOARD_ROUTE = '/silksec-dashboard'
    var DOMAIN_ROUTE = '/silksec-domain'
    var POLL_MS = 30000
    var SUMMARY_MAX = 240
    var SESSION_SLOTS = [
      'conversation.view',
      'conversation.session.header.utilities',
      'conversation.chat.assistant-actions',
    ]

    // apply 时捕获的客户端 root context（渲染期按需读 connection/layout/sessions）
    var serviceRef = { ctx: null }
    function getService(name) {
      var ctx = serviceRef.ctx
      if (!ctx || typeof ctx.get !== 'function') return null
      try { return ctx.get(name) } catch (e) { return null }
    }
    // 统一 RPC caller：端点含 '.' → RpcProjector /silksec-domain（vuln.*/fact.*）；
    // 否则走 /silksec-dashboard（与主面板读端点同通道）。
    function getRpc() {
      var connection = getService('connection')
      if (!connection || !connection.rpc || typeof connection.rpc.call !== 'function') return null
      return function (endpoint, payload) {
        return connection.rpc.call(routeFor(endpoint), endpoint, payload || {}).then(function (result) {
          if (result && result.ok) return result.value
          var error = result && result.error
          throw new Error(error && error.message ? error.message : 'rpc failed')
        })
      }
    }
    function routeFor(endpoint) {
      return String(endpoint).indexOf('.') >= 0 ? DOMAIN_ROUTE : DASHBOARD_ROUTE
    }

    // ── 样式（零颜色字面量；布局/容器查询用本地 CSS，颜色全部走 --dsw-alias-*） ──
    var CSS_KEY = 'silksec-ui-session'
    function ensureStyles() {
      try {
        if (typeof document === 'undefined' || !document.head) return
        if (document.querySelector('style[data-plugin-css=' + JSON.stringify(CSS_KEY) + ']')) return
        var tag = document.createElement('style')
        tag.dataset.plugin = '@silksec/ui-session'
        tag.dataset.pluginCss = CSS_KEY
        tag.textContent = [
          '.silksec-session-view{display:flex;flex-direction:column;min-height:0;height:100%;box-sizing:border-box;padding:14px 18px 20px;overflow-y:auto}',
          '.silksec-session-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:7px 0;border-top:1px solid var(--dsw-alias-border-l3)}',
          '.silksec-session-actions{display:inline-flex;gap:6px;align-items:center;margin-left:4px}',
          '.silksec-session-mono{font-family:var(--ds-font-family-code,ui-monospace,Consolas,monospace);word-break:break-all}',
        ].join('\n')
        document.head.appendChild(tag)
      } catch (e) { /* 样式注入失败不阻断功能 */ }
    }

    // ── 图标（官方 IconChecklistOutline 优先，缺席回退 ui-core 内联 opIcon） ──────
    function checklistIcon(size) {
      var I = prim('IconChecklistOutline')
      return I ? el(I, { size: size || 13 }) : (uiCore && uiCore.opIcon ? uiCore.opIcon('list') : null)
    }
    function icon(kind) { return uiCore && uiCore.opIcon ? uiCore.opIcon(kind) : null }
    function tip(label, node) {
      var TT = prim('Tooltip')
      if (TT && label) return el(TT, { label: String(label), side: 'left', delayMs: 400 }, node)
      return node
    }

    // ── 共享安全产出快照（header 计数 / 安全视图共用；轮询按面独立） ─────────────
    function createSessionStore() {
      var state = { findings: [], facts: [], tasks: [], runs: [], loaded: false, updatedAt: 0 }
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
    var sessionStore = createSessionStore()

    function useStore(store) {
      var s = React.useState(function () { return store.get() })
      var snap = s[0]; var setSnap = s[1]
      React.useEffect(function () {
        return store.subscribe(function (v) { setSnap(v) })
      }, [])
      return snap
    }

    // 会话归属判定：生产者会话 id。finding/task/task_run 落 session_id 列；
    // fact 表无 session_id 列（跨会话自然键），本面「沉淀事实」写入时把会话 id 编进
    // source=`dashboard:session:<id>`，故按 source 解析归属（既有 fact 无归属则不显示）。
    function sessionFromSource(source) {
      var m = /session:([A-Za-z0-9._:-]+)/.exec(String(source || ''))
      return m ? m[1] : ''
    }
    function filterBySession(rows, sessionId) {
      if (!sessionId) return []
      var sid = String(sessionId)
      return (rows || []).filter(function (r) { return String((r && r.session_id) || '') === sid })
    }
    function filterFactsBySession(rows, sessionId) {
      if (!sessionId) return []
      var sid = String(sessionId)
      return (rows || []).filter(function (f) {
        if (String((f && f.session_id) || '') === sid) return true
        return sessionFromSource(f && f.source) === sid
      })
    }
    function sessionCounts(storeState, sessionId) {
      var s = storeState || sessionStore.get()
      var findings = filterBySession(s.findings, sessionId)
      var facts = filterFactsBySession(s.facts, sessionId)
      return { findings: findings.length, facts: facts.length, total: findings.length + facts.length }
    }

    // 全局安全产出轮询（header 计数 + 安全视图共用；能力探测 rpc 缺席即静默）
    function fetchSecurity() {
      var rpc = getRpc()
      if (typeof rpc !== 'function') return Promise.resolve(null)
      return Promise.all([
        rpc('findings', { limit: 200, include_noise: true }).catch(function () { return null }),
        rpc('facts', { limit: 200 }).catch(function () { return null }),
        rpc('scheduledTasks', {}).catch(function () { return null }),
        rpc('tasks', { bucket: 'active', limit: 200 }).catch(function () { return null }),
        rpc('taskRuns', { limit: 200 }).catch(function () { return null }),
      ]).then(function (res) {
        var findings = (res[0] && res[0].rows) || []
        var facts = (res[1] && res[1].rows) || []
        var tasks = ((res[2] && res[2].rows) || []).concat((res[3] && res[3].rows) || [])
        var runs = (res[4] && res[4].rows) || []
        sessionStore.set({ findings: findings, facts: facts, tasks: tasks, runs: runs, loaded: true, updatedAt: Date.now() })
        return sessionStore.get()
      }).catch(function () { return null })
    }
    function startSecurityPoll() {
      var timer = null
      fetchSecurity()
      try {
        timer = setInterval(fetchSecurity, POLL_MS)
        // Node 测试环境返回 Timeout，unref 防挂起（能力探测，非必需）
        if (timer && typeof timer.unref === 'function') timer.unref()
      } catch (e) { timer = null }
      return function () { if (timer) { try { clearInterval(timer) } catch (e) {} } }
    }

    // ── 写操作：与主面板同域命令，经正确路由（vuln.*/fact.* → /silksec-domain） ──
    var SECURITY_ACTIONS = {
      // 登记候选漏洞：语义动词 vuln.register_candidate（actor 含 dashboard）
      registerCandidate: function (spec) {
        spec = spec || {}
        return {
          endpoint: 'vuln.register_candidate',
          payload: {
            title: String(spec.title || '').trim(),
            severity: String(spec.severity || 'info'),
            host: String(spec.host || '').trim(),
            url: String(spec.url || '').trim(),
            evidence: String(spec.evidence || '').slice(0, 1000),
            source: String(spec.source || 'dashboard'),
            program_id: spec.program_id ? String(spec.program_id) : '',
          },
        }
      },
      // 沉淀事实：fact.upsert（actor 白名单含 dashboard）；source 编入会话归属
      depositFact: function (spec) {
        spec = spec || {}
        var sid = spec.session_id ? String(spec.session_id) : ''
        var payload = {
          program_id: String(spec.program_id || '').trim(),
          fact_key: String(spec.fact_key || '').trim(),
          category: String(spec.category || '').trim(),
          summary: String(spec.summary || '').slice(0, 300),
          body: String(spec.body || '').slice(0, 4000),
          confidence: 'tentative',
          source: sid ? 'dashboard:session:' + sid : 'dashboard',
        }
        if (spec.related_finding_id) payload.related_finding_id = Number(spec.related_finding_id)
        return { endpoint: 'fact.upsert', payload: payload }
      },
    }
    // 单条操作 → RPC：args 按 op 位置参数传入（spec 对象）。
    function securityAction(rpc, op, args) {
      var build = SECURITY_ACTIONS[op]
      if (typeof build !== 'function') return Promise.reject(new Error('未知安全动作: ' + op))
      if (typeof rpc !== 'function') return Promise.reject(new Error('连接通道不可用'))
      var req = build.apply(null, args || [])
      return rpc(req.endpoint, req.payload)
    }

    // ── 通用小件（token 样式；primitives 缺席自动兜底） ─────────────────────────
    var card = { padding: '10px 12px', borderRadius: 8, border: '1px solid ' + T.border, background: T.base, minWidth: 0, boxSizing: 'border-box', marginTop: 10 }
    var pill = (styles.pill || {})
    var sectionHead = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 16 }
    var sectionTitle = { color: T.label, ...((F && F.sStrong) || {}) }
    var sectionSub = { color: T.label3, marginTop: 2, ...((F && F.xxs) || {}) }
    var iconBtn = { className: 'silksec-icon-btn', type: 'button' }
    var formRow = { display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 10 }
    var formLabel = { color: T.label2, ...((F && F.xxsStrong) || {}) }
    var inputStyle = { width: '100%', boxSizing: 'border-box' }

    function pillNode(text, opts) {
      opts = opts || {}
      return el('span', { style: { ...pill, ...(opts.color ? { color: opts.color } : {}), ...(opts.style || {}) }, title: opts.title || undefined }, text)
    }
    function sectionHeadNode(props) {
      return el('div', { style: props.first ? { ...sectionHead, marginTop: 0 } : sectionHead },
        el('span', { style: { color: T.label3, display: 'inline-flex' } }, props.icon || null),
        el('span', { style: sectionTitle }, props.title),
        props.count !== undefined ? el('span', { style: { ...pill, color: T.label3 }, title: '本会话产出条数' }, String(props.count)) : null,
        props.subtitle ? el('div', { style: sectionSub }, props.subtitle) : null)
    }
    function sessionLink(id) {
      if (!id) return null
      return tip('打开来源会话', el('button', {
        type: 'button', className: 'silksec-icon-btn', 'aria-label': '打开会话',
        onClick: function () {
          var sessions = getService('sessions')
          if (sessions && typeof sessions.open === 'function') { try { sessions.open(id) } catch (e) {} }
        },
      }, icon('jump')))
    }

    // ── 会话视图页签「安全产出」：按 session_id 过滤本会话产出 ───────────────────
    function severityPill(sev) {
      var color = SEV_COLOR[sev] || T.label3
      return el('span', { style: { ...pill, color: color }, title: '严重级别' }, SEV_LABEL[sev] || sev || '—')
    }
    function statusPill(status) {
      return el('span', { style: { ...pill, color: T.label3 }, title: '状态' }, STATUS_LABEL[status] || status || '—')
    }

    function FindingRow(props) {
      var f = props.finding
      return el('div', { className: 'silksec-session-row' },
        severityPill(f.severity),
        el('span', { style: { color: T.label, ...((F && F.xs) || {}), flex: '1 1 220px', wordBreak: 'break-word' }, title: f.title }, String(f.title || '')),
        statusPill(f.status),
        f.host ? el('span', { className: 'silksec-session-mono', style: { color: T.label3, ...((F && F.xxxs) || {}) }, title: f.url || f.host }, String(f.host)) : null,
        (f.noise === 1 || f.noise === true) ? pillNode('候选', { color: T.warn, title: '待验证候选（noise=1）' }) : null,
        el('span', { style: { marginLeft: 'auto', color: T.label3, ...((F && F.xxxs) || {}), whiteSpace: 'nowrap' } }, fmtTs(f.created_at)),
        sessionLink(f.session_id))
    }
    function FactRow(props) {
      var f = props.fact
      return el('div', { className: 'silksec-session-row' },
        el('span', { className: 'silksec-session-mono', style: { color: T.label, ...((F && F.xxsStrong) || {}) }, title: f.fact_key }, String(f.fact_key || '')),
        el('span', { style: { color: T.label2, ...((F && F.xxs) || {}), flex: '1 1 220px', wordBreak: 'break-word' }, title: f.summary }, String(f.summary || '')),
        f.confidence ? pillNode(CONF_LABEL[f.confidence] || f.confidence, { title: '置信度' }) : null,
        f.mem_class ? pillNode(f.mem_class, { title: '记忆生命周期' }) : null,
        el('span', { style: { marginLeft: 'auto', color: T.label3, ...((F && F.xxxs) || {}), whiteSpace: 'nowrap' } }, fmtTs(f.updated_at)),
        sessionLink(f.session_id || sessionFromSource(f.source)))
    }
    function TaskRow(props) {
      var t = props.task
      return el('div', { className: 'silksec-session-row' },
        el('span', { className: 'silksec-session-mono', style: { color: T.label3, ...((F && F.xxxs) || {}) } }, '#' + t.id),
        el('span', { style: { color: T.label, ...((F && F.xs) || {}), flex: '1 1 220px', wordBreak: 'break-word' }, title: t.objective }, String(t.objective || '')),
        el('span', { style: { ...pill, color: t.status === 'failed' || t.status === 'cancelled' ? T.error : t.status === 'done' ? T.success : T.label3 }, title: '任务状态' }, TASK_STATUS_LABEL[t.status] || t.status || '—'),
        t.program_id ? el('span', { style: { color: T.label3, ...((F && F.xxxs) || {}) }, title: '工作区' }, String(t.program_id)) : null,
        el('span', { style: { marginLeft: 'auto', color: T.label3, ...((F && F.xxxs) || {}), whiteSpace: 'nowrap' } }, t.next_run_at ? fmtRel(t.next_run_at) : ''),
        sessionLink(t.session_id))
    }
    function RunRow(props) {
      var r = props.run
      return el('div', { className: 'silksec-session-row' },
        el('span', { style: { ...pill, color: r.ok ? T.success : T.error }, title: '执行结果' }, r.ok ? '✓ 成功' : '✗ 失败'),
        el('span', { className: 'silksec-session-mono', style: { color: T.label3, ...((F && F.xxxs) || {}), whiteSpace: 'nowrap' } }, '#' + r.task_id),
        el('span', { style: { color: T.label2, ...((F && F.xxs) || {}), flex: '1 1 200px', wordBreak: 'break-word' } }, String(r.note || '')),
        el('span', { style: { marginLeft: 'auto', color: T.label3, ...((F && F.xxxs) || {}), whiteSpace: 'nowrap' } }, fmtTs(r.finished_at || r.started_at)),
        sessionLink(r.session_id))
    }

    function SecurityView(props) {
      ensureStyles()
      var snap = useStore(sessionStore)
      var sid = (props && props.sessionId) || ''
      var findings = filterBySession(snap.findings, sid)
      var facts = filterFactsBySession(snap.facts, sid)
      var tasks = filterBySession(snap.tasks, sid)
      var runs = filterBySession(snap.runs, sid)
      var counts = sessionCounts(snap, sid)
      function openDashboard() {
        var layout = getService('layout')
        if (layout && typeof layout.selectPanel === 'function') { try { layout.selectPanel(DASHBOARD_PANEL_ID); return } catch (e) {} }
        try { uiCore.secUiBus.emit('open:dashboard', {}) } catch (e) {}
      }
      function openApproval() {
        try { uiCore.secUiBus.emit('open:approval', {}) } catch (e) {}
        var sr = getService('sidebarRight')
        if (sr && typeof sr.openTab === 'function') { try { sr.openTab('silksec-approval'); return } catch (e) {} }
        openDashboard()
      }
      return el('div', { className: 'silksec-session-view', 'data-silksec-surface': 'security-view' },
        el('div', { style: { ...styles.header, marginBottom: 8 } },
          el('span', { style: { ...(styles.pageT || {}), display: 'inline-flex', alignItems: 'center', gap: 6 } }, checklistIcon(15), '安全产出'),
          pillNode('漏洞 ' + counts.findings, { title: '本会话登记的漏洞' }),
          pillNode('事实 ' + counts.facts, { title: '本会话沉淀的事实' }),
          el('span', { style: { marginLeft: 'auto', display: 'inline-flex', gap: 6, alignItems: 'center' } },
            tip('刷新本会话安全产出', el('button', { ...iconBtn, 'aria-label': '刷新', onClick: function () { fetchSecurity() } }, icon('history'))),
            tip('打开看板主面板（反向回路）', el('button', { ...iconBtn, 'aria-label': '打开看板', onClick: openDashboard }, icon('jump'))),
            tip('打开审批中心', el('button', { ...iconBtn, 'aria-label': '审批中心', onClick: openApproval }, icon('confirm'))))),
        el('div', { style: sectionSub },
          '按生产者会话 id 过滤：本会话产出的漏洞/事实/任务/执行（详细内容一律在会话里看，行内可跳链）。'),
        sid ? null : el('div', { style: { ...(styles.errorLine || {}), color: T.warn } }, '未取得会话 id：无法过滤本会话产出。'),

        sectionHeadNode({ title: '漏洞', count: findings.length, icon: checklistIcon(13), first: true, subtitle: '本会话 registry/候选登记（含候选池 noise=1）。' }),
        findings.length ? el('div', null, findings.map(function (f) { return el(FindingRow, { key: String(f.id), finding: f }) }))
          : el('div', { style: { color: T.label3, padding: '8px 0', ...((F && F.xs) || {}) } }, '本会话暂无漏洞产出'),

        sectionHeadNode({ title: '事实', count: facts.length, icon: checklistIcon(13), subtitle: '本会话沉淀的跨会话事实（fact.upsert）。' }),
        facts.length ? el('div', null, facts.map(function (f) { return el(FactRow, { key: String(f.program_id) + '/' + String(f.fact_key), fact: f }) }))
          : el('div', { style: { color: T.label3, padding: '8px 0', ...((F && F.xs) || {}) } }, '本会话暂无事实沉淀'),

        sectionHeadNode({ title: '任务', count: tasks.length, icon: checklistIcon(13), subtitle: '本会话派发/执行的 Task（定时 + 一次性）。' }),
        tasks.length ? el('div', null, tasks.map(function (t) { return el(TaskRow, { key: String(t.id), task: t }) }))
          : el('div', { style: { color: T.label3, padding: '8px 0', ...((F && F.xs) || {}) } }, '本会话暂无任务'),

        sectionHeadNode({ title: '执行', count: runs.length, icon: checklistIcon(13), subtitle: '本会话的 Run 执行历史（run 落 session_id 可回溯）。' }),
        runs.length ? el('div', null, runs.map(function (r) { return el(RunRow, { key: String(r.id), run: r }) }))
          : el('div', { style: { color: T.label3, padding: '8px 0', ...((F && F.xs) || {}) } }, '本会话暂无执行记录'))
    }

    // ── 会话头「安全产出」计数钮（右对齐 list） ─────────────────────────────────
    function openSecurityView(props) {
      if (props && typeof props.selectView === 'function') {
        try { props.selectView(VIEW_ID); return 'view' } catch (e) { /* 切换 API 异常 → 降级 */ }
      }
      try { uiCore.secUiBus.emit('open:security-view', {}) } catch (e) {}
      return 'none'
    }
    function HeaderSecurityCount(props) {
      ensureStyles()
      var snap = useStore(sessionStore)
      var sid = props && props.sessionId
      var counts = sessionCounts(snap, sid)
      var scope = sid ? '本会话' : '全局'
      var label = scope + '安全产出 ' + counts.total + ' 项（漏洞 ' + counts.findings + ' / 事实 ' + counts.facts + '）'
      return el('button', {
        type: 'button', className: 'silksec-icon-btn',
        title: label + '；点击切到「安全产出」视图',
        'aria-label': label,
        style: { width: 'auto', height: 26, padding: '0 8px', display: 'inline-flex', alignItems: 'center', gap: 4 },
        'data-silksec-surface': 'security-header',
        onClick: function () { openSecurityView(props) },
      }, checklistIcon(13), counts.total ? el('span', { style: { ...((F && F.xxxs) || {}) } }, String(counts.total)) : null)
    }

    // ── 消息动作：登记候选漏洞 / 沉淀事实（assistant-actions per messageId） ──────
    // 预填消息摘要：从动作钮的 DOM 祖先读取消息文本（best-effort，失败空串）。
    function readMessageSummary(node) {
      try {
        var host = node && node.closest ? node.closest('[data-message-id],[data-message],[data-seq]') : null
        if (!host) {
          host = node; var d = 0
          while (host && host.parentElement && d < 5) { host = host.parentElement; d++ }
        }
        var full = (host && (host.innerText || host.textContent)) || ''
        // 扣掉本面动作行自身文案（含 Tooltip 文本），避免把「登记候选漏洞/沉淀事实」当消息摘要
        var own = (node && node.closest) ? node.closest('[data-silksec-surface="message-actions"]') : null
        var ownText = (own && (own.innerText || own.textContent)) || ''
        var txt = ownText ? String(full).split(ownText).join(' ') : String(full)
        return txt.replace(/\s+/g, ' ').replace(/^(登记候选漏洞|沉淀事实)\s*/, '').trim().slice(0, SUMMARY_MAX)
      } catch (e) { return '' }
    }
    function normalizePrograms(data) {
      var rows = data && (data.rows || data.items || (Array.isArray(data) ? data : null))
      if (!Array.isArray(rows)) return []
      return rows.map(function (p) {
        return { v: String(p.id || p.name || p.program_id || ''), l: String(p.name || p.title || p.id || p.program_id || '') }
      }).filter(function (o) { return o.v })
    }

    function ModalShell(props) {
      var M = prim('Modal')
      var body = el('div', { style: { maxHeight: '70vh', overflowY: 'auto', padding: '4px 2px' } }, props.children)
      if (M) return el(M, { open: true, onClose: props.onClose, title: props.title, headless: true, className: 'silksec-dash-dialog' }, body)
      return el('div', { style: { position: 'fixed', inset: 0, zIndex: 90, background: T.base, display: 'flex', flexDirection: 'column', padding: 16, pointerEvents: 'auto' } },
        el('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
          el('div', { style: { ...((styles.pageT) || {}) } }, props.title),
          el('button', { type: 'button', className: 'silksec-btn', style: { marginLeft: 'auto' }, title: '关闭', onClick: props.onClose }, '关闭')),
        body)
    }

    function SecurityActionModal(props) {
      ensureStyles()
      var kind = props.kind
      var rpc = props.rpc
      var useRpcCore = uiCore && uiCore.useRpc
      var progState = (typeof useRpcCore === 'function')
        ? useRpcCore(function () { return { endpoint: 'programs' } }, [], rpc || undefined)
        : { data: null }
      var programs = normalizePrograms(progState && progState.data)
      var pidS = React.useState('')
      var pid = pidS[0]; var setPid = pidS[1]
      var titleS = React.useState(kind === 'fact' ? '' : (props.summary || ''))
      var title = titleS[0]; var setTitle = titleS[1]
      var hostS = React.useState('')
      var host = hostS[0]; var setHost = hostS[1]
      var urlS = React.useState('')
      var url = urlS[0]; var setUrl = urlS[1]
      var keyS = React.useState('note/')
      var factKey = keyS[0]; var setFactKey = keyS[1]
      var sumS = React.useState(props.summary || '')
      var summary = sumS[0]; var setSummary = sumS[1]
      var bodyS = React.useState(props.summary ? String(props.summary).slice(0, 2000) : '')
      var body = bodyS[0]; var setBody = bodyS[1]
      var busyS = React.useState(false)
      var busy = busyS[0]; var setBusy = busyS[1]
      var confirmS = React.useState(false)
      var confirming = confirmS[0]; var setConfirming = confirmS[1]
      var ackS = React.useState(false)
      var acknowledged = ackS[0]; var setAcknowledged = ackS[1]

      // programs 到达后自动选中首项（仅一次，用户已改则不覆盖）
      React.useEffect(function () {
        if (!pid && programs.length) setPid(programs[0].v)
      }, [programs.length])

      var effectivePid = pid || (programs[0] ? programs[0].v : '')
      function valid() {
        if (!effectivePid) return '请选择授权项目（工作区）'
        if (kind === 'finding') {
          if (!String(title).trim()) return '标题必填（≥10 字符更佳）'
          if (!String(host).trim()) return '目标主机/域名必填'
        } else {
          if (!String(factKey).trim()) return '事实键必填（category/slug）'
          if (!String(summary).trim()) return '事实摘要必填'
        }
        return ''
      }
      function buildSpec() {
        if (kind === 'finding') {
          return {
            title: String(title).trim(), host: String(host).trim(), url: String(url).trim(),
            evidence: (props.summary ? '来源会话 ' + (props.sessionId || '—') + ' 消息 ' + (props.messageId || '—') + '：' + props.summary : '').slice(0, 1000),
            source: 'dashboard', program_id: effectivePid,
          }
        }
        return {
          program_id: effectivePid, fact_key: String(factKey).trim(),
          category: String(factKey).split('/')[0] || '', summary: String(summary).trim(), body: String(body).trim(),
          confidence: 'tentative', session_id: props.sessionId || '',
        }
      }
      function doWrite() {
        if (busy) return
        setConfirming(false); setBusy(true)
        securityAction(rpc, kind === 'finding' ? 'registerCandidate' : 'depositFact', [buildSpec()]).then(function () {
          fetchSecurity()
          props.onClose()
        }).catch(function (e) {
          try { if (window.alert) window.alert('写入失败: ' + (e && e.message ? e.message : e)) } catch (e2) {}
        }).then(function () { setBusy(false) })
      }
      function submit() {
        var err = valid()
        if (err) { try { if (window.alert) window.alert(err) } catch (e) {} return }
        var RC = prim('RiskConfirmation')
        if (RC) { setAcknowledged(false); setConfirming(true); return }
        var yes = false
        try { yes = window.confirm('确认写入？' + (kind === 'finding' ? '登记候选漏洞（入候选池待验证）' : '沉淀事实（跨会话共享）')) } catch (e) { return }
        if (yes) doWrite()
      }

      if (confirming) {
        var RC2 = prim('RiskConfirmation')
        if (RC2) {
          return el(RC2, {
            open: true,
            title: kind === 'finding' ? '确认登记候选漏洞' : '确认沉淀事实',
            description: kind === 'finding'
              ? '将写入候选池（noise=1，待人工/模型复核升级），actor=dashboard，审计留痕。'
              : '将写入跨会话事实图谱（tentative），source 记录本会话归属，actor=dashboard，审计留痕。',
            acknowledgeLabel: '我已核对内容与来源（消息 ' + (props.messageId || '—') + '）',
            cancelLabel: '取消', closeLabel: '关闭',
            confirmLabel: '确认写入',
            acknowledged: acknowledged, onAcknowledgedChange: setAcknowledged,
            disabled: !!busy || !acknowledged,
            onCancel: function () { setConfirming(false) },
            onConfirm: doWrite,
          })
        }
      }

      var finding = kind === 'finding'
      var children = [
        el('div', { style: { color: T.label3, ...((F && F.xxs) || {}), marginBottom: 8 } },
          finding ? '登记到漏洞候选池（severity=info，待验证；可在看板「漏洞」视图复核）' : '写入跨会话事实图谱（tentative；note 类归 ephemeral）'),
        el('div', { style: formRow },
          el('span', { style: formLabel }, '授权项目（工作区）'),
          programs.length
            ? el('select', { className: 'silksec-input', style: inputStyle, 'data-silksec-field': 'program', value: effectivePid, onChange: function (e) { setPid(e.target.value) } },
                programs.map(function (o) { return el('option', { key: o.v, value: o.v }, o.l) }))
            : el('input', { className: 'silksec-input', style: inputStyle, 'data-silksec-field': 'program', value: pid, placeholder: 'program_id（加载工作区失败，手动填写）', onChange: function (e) { setPid(e.target.value) } })),
      ]
      if (finding) {
        children.push(
          el('div', { style: formRow }, el('span', { style: formLabel }, '漏洞标题'), el('input', { className: 'silksec-input', style: inputStyle, 'data-silksec-field': 'title', value: title, onChange: function (e) { setTitle(e.target.value) } })),
          el('div', { style: formRow }, el('span', { style: formLabel }, '目标主机/域名（必填）'), el('input', { className: 'silksec-input', style: inputStyle, 'data-silksec-field': 'host', value: host, onChange: function (e) { setHost(e.target.value) } })),
          el('div', { style: formRow }, el('span', { style: formLabel }, 'URL / 路径（可选）'), el('input', { className: 'silksec-input', style: inputStyle, 'data-silksec-field': 'url', value: url, onChange: function (e) { setUrl(e.target.value) } })))
      } else {
        children.push(
          el('div', { style: formRow }, el('span', { style: formLabel }, '事实键 category/slug（如 auth/cred-admin）'), el('input', { className: 'silksec-input', style: { ...inputStyle, fontFamily: MONO }, 'data-silksec-field': 'fact_key', value: factKey, onChange: function (e) { setFactKey(e.target.value) } })),
          el('div', { style: formRow }, el('span', { style: formLabel }, '摘要（一行索引，注入 prompt）'), el('input', { className: 'silksec-input', style: inputStyle, 'data-silksec-field': 'summary', value: summary, onChange: function (e) { setSummary(e.target.value) } })),
          el('div', { style: formRow }, el('span', { style: formLabel }, '正文（按需 fact_get 拉取，可选）'), el('textarea', { className: 'silksec-input', style: { ...inputStyle, height: 72, padding: '8px 10px', resize: 'vertical' }, 'data-silksec-field': 'body', value: body, onChange: function (e) { setBody(e.target.value) } })))
      }
      if (props.summary) {
        children.push(el('div', { style: { ...card, borderColor: T.border3, marginTop: 4 } },
          el('div', { style: { ...formLabel, marginBottom: 4 } }, '消息摘要（预填）'),
          el('div', { style: { color: T.label2, ...((F && F.xxs) || {}), wordBreak: 'break-word' } }, String(props.summary).slice(0, 400))))
      }
      children.push(el('div', { style: { display: 'flex', gap: 8, marginTop: 10 } },
        el('button', { type: 'button', className: 'silksec-btn silksec-btn-confirm', disabled: !!busy, onClick: submit }, finding ? '登记候选漏洞' : '沉淀事实'),
        el('button', { type: 'button', className: 'silksec-btn', onClick: props.onClose }, '取消')))
      return el(ModalShell, { title: finding ? '登记候选漏洞' : '沉淀事实', onClose: props.onClose }, children)
    }

    function MessageSecurityActions(props) {
      ensureStyles()
      var messageId = (props && props.messageId) || ''
      var sessionId = (props && props.sessionId) || ''
      var modalS = React.useState(null)
      var modal = modalS[0]; var setModal = modalS[1]
      function open(kind, ev) {
        setModal({ kind: kind, summary: readMessageSummary(ev && ev.currentTarget) })
      }
      function actionButton(kind, label, hint) {
        return tip(label + '：' + hint, el('button', {
          type: 'button', className: 'silksec-icon-btn', 'data-silksec-action': kind,
          'aria-label': label, style: { width: 'auto', height: 24, padding: '0 8px', ...((F && F.xxs) || {}) },
          onClick: function (ev) { open(kind, ev) },
        }, label))
      }
      return el('span', { className: 'silksec-session-actions', 'data-silksec-surface': 'message-actions', 'data-message-id': messageId },
        actionButton('finding', '登记候选漏洞', '把本条消息登记为漏洞候选（入候选池待验证）'),
        actionButton('fact', '沉淀事实', '把本条消息沉淀为跨会话事实'),
        modal ? el(SecurityActionModal, {
          kind: modal.kind, sessionId: sessionId, messageId: messageId, summary: modal.summary,
          rpc: getRpc(), onClose: function () { setModal(null) },
        }) : null)
    }

    // ── 注册定义（list 槽；id/order/label；conversation.view 由 options 投影 ViewTab） ──
    function buildViewDefinition() {
      return {
        name: 'conversation.view', id: VIEW_ID, order: 60,
        label: function () { return '安全产出' },
        // 官方 per-session inject 面：把 sessionId 作为注入 prop 交给视图（过滤本会话产出）
        inject: function (sessionId) { return { sessionId: sessionId } },
      }
    }
    function buildHeaderDefinition() {
      return {
        name: 'conversation.session.header.utilities', id: HEADER_ID, order: 45,
        inject: function (sessionId) { return { sessionId: sessionId } },
      }
    }
    function buildActionsDefinition() {
      return {
        name: 'conversation.chat.assistant-actions', id: ACTIONS_ID, order: 30,
        inject: function (sessionId) { return { sessionId: sessionId } },
      }
    }

    // 能力探测（非版本判断）
    function slotDeclared(slots, name) {
      try { return !!(slots && typeof slots.spec === 'function' && slots.spec(name)) } catch (e) { return false }
    }
    function anySessionSlotDeclared(slots) {
      for (var i = 0; i < SESSION_SLOTS.length; i++) if (slotDeclared(slots, SESSION_SLOTS[i])) return true
      return false
    }

    exports.name = 'silksec-ui-session'
    exports.inject = ['slots']
    exports.apply = function (ctx) {
      serviceRef.ctx = ctx
      ensureStyles()
      if (!uiCore) return
      var stopPoll = null

      // 一切注册 ctx.inject([...], cb) + ctx.effect() 包裹（时序纪律；槽缺席静默降级）
      ctx.inject(['slots'], function (scope) {
        ctx.effect(function () {
          var slots = scope.slots
          var disposers = []
          if (!stopPoll) stopPoll = startSecurityPoll()
          // 会话槽全缺席：不注册任何会话绑定（会话面无全局影响），不改变主面板 11 视图
          var declared = anySessionSlotDeclared(slots)

          // 1. conversation.view（list/session）→ ViewTab「安全产出」+ 会话内整页视图
          if (slots && typeof slots.inject === 'function') {
            disposers.push(slots.inject('conversation.view', function () {
              markSurfaceHealth('ui-session', 'ok', 'conversation.view 安全产出视图注册')
              return slots.register(buildViewDefinition(), SecurityView)
            }))
            // 2. conversation.session.header.utilities（list/session）→ 本会话安全产出计数钮
            disposers.push(slots.inject('conversation.session.header.utilities', function () {
              markSurfaceHealth('ui-session', 'ok', '会话头安全产出计数注册')
              return slots.register(buildHeaderDefinition(), HeaderSecurityCount)
            }))
            // 3. conversation.chat.assistant-actions（list/session）→ 登记候选/沉淀事实
            disposers.push(slots.inject('conversation.chat.assistant-actions', function () {
              markSurfaceHealth('ui-session', 'ok', 'assistant-actions 登记/沉淀注册')
              return slots.register(buildActionsDefinition(), MessageSecurityActions)
            }))
          }
          if (!declared) markSurfaceHealth('ui-session', 'degraded', '会话槽缺席：不注册（会话面无全局影响）')
          return function () {
            if (stopPoll) { stopPoll(); stopPoll = null }
            disposers.forEach(function (d) { try { if (typeof d === 'function') d() } catch (e) {} })
          }
        })
      })
    }

    // 稳定导出面（供单测 / 降级探测）
    exports.VIEW_ID = VIEW_ID
    exports.HEADER_ID = HEADER_ID
    exports.ACTIONS_ID = ACTIONS_ID
    exports.SESSION_SLOTS = SESSION_SLOTS
    exports.routeFor = routeFor
    exports.getRpc = getRpc
    exports.SECURITY_ACTIONS = SECURITY_ACTIONS
    exports.securityAction = securityAction
    exports.createSessionStore = createSessionStore
    exports.sessionStore = sessionStore
    exports.startSecurityPoll = startSecurityPoll
    exports.fetchSecurity = fetchSecurity
    exports.sessionFromSource = sessionFromSource
    exports.filterBySession = filterBySession
    exports.filterFactsBySession = filterFactsBySession
    exports.sessionCounts = sessionCounts
    exports.normalizePrograms = normalizePrograms
    exports.readMessageSummary = readMessageSummary
    exports.buildViewDefinition = buildViewDefinition
    exports.buildHeaderDefinition = buildHeaderDefinition
    exports.buildActionsDefinition = buildActionsDefinition
    exports.openSecurityView = openSecurityView
    exports.SecurityView = SecurityView
    exports.HeaderSecurityCount = HeaderSecurityCount
    exports.MessageSecurityActions = MessageSecurityActions
    exports.SecurityActionModal = SecurityActionModal
    exports.ModalShell = ModalShell
    exports.FindingRow = FindingRow
    exports.FactRow = FactRow
    exports.TaskRow = TaskRow
    exports.RunRow = RunRow
    exports.slotDeclared = slotDeclared

    return module.exports
  },
})
