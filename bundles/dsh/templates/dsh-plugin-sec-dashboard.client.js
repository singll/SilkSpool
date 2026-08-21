/**
 * @silksec/sec-dashboard — client half (browser bundle).
 *
 * SilkSecAgent「看板」——**全局**入口，不挂任何会话：
 *   - 入口：`sidebar.footer.action`（scope:root，侧边栏底部，任何会话/无会话时都可见）
 *   - 形态：primitives `Modal`（headless 模式，~1120px），内部四视图 tab：
 *     漏洞（findings，打标）/ 资产（assets+endpoints）/ 事实（facts+遗留 blackboard，纠正·废弃）/
 *     任务（programs+tasks，只读）
 *
 * 数据走 Host↔Client RPC 通道 `/silksec-dashboard`（`ctx.get('connection').rpc`），
 * 与 sec-suite 宿主侧 `connection.rpc.handle('/silksec-dashboard', …)` 一一对应。
 * 写操作（打标 / 事实纠正）直接复用宿主 assetDb 函数 + audit.jsonl，本插件零持久化。
 * 视觉走宿主设计令牌（--dsw-alias-* / --dsw-font-*）+ primitives Modal。
 */
window.__ModuleLoader__.load({
  id: '@silksec/sec-dashboard',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    var React = require('react')
    var primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    var Modal = (primitives && typeof primitives.Modal === 'function') ? primitives.Modal : null
    var el = React.createElement

    // ── 设计令牌 ─────────────────────────────────────────────────────────────
    var T = {
      label: 'var(--dsw-alias-label-primary)',
      label2: 'var(--dsw-alias-label-secondary)',
      label3: 'var(--dsw-alias-label-tertiary)',
      border: 'var(--dsw-alias-border-l1)',
      border2: 'var(--dsw-alias-border-l2)',
      border3: 'var(--dsw-alias-border-l3)',
      base: 'var(--dsw-alias-bg-base)',
      hover: 'var(--dsw-alias-interactive-bg-hover)',
      brand: 'var(--dsw-alias-brand-primary)',
      success: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
    }
    var F = {
      xxxs: { font: 'var(--dsw-font-xxxs-11)' },
      xxs: { font: 'var(--dsw-font-xxs-12)' },
      xxsStrong: { font: 'var(--dsw-font-xxs-strong-12)' },
      xs: { font: 'var(--dsw-font-xs-13)' },
      s: { font: 'var(--dsw-font-s-14)' },
      sStrong: { font: 'var(--dsw-font-s-strong-14)' },
      baseStrong: { font: 'var(--dsw-font-base-strong-16)' },
    }
    var EASE = 'var(--ds-ease-in-out, cubic-bezier(.4, 0, .2, 1))'

    var SEV_COLOR = { critical: '#e2607a', high: '#e2803a', medium: '#d99a2b', low: '#4a90e2', info: '#8a8f98' }
    var SEV_LABEL = { critical: '严重', high: '高危', medium: '中危', low: '低危', info: '信息' }
    var STATUS_LABEL = {
      new: '新发现', confirmed: '已确认', false_positive: '误报', submitted: '已提交',
      accepted: '已接收', dup: '重复', ignored: '忽略',
    }
    var CONF_LABEL = { confirmed: '确认', tentative: '待定', deprecated: '废弃' }
    var TASK_STATUS_LABEL = {
      queued: '排队', running: '运行中', blocked: '阻塞', done: '完成', failed: '失败', cancelled: '取消',
    }

    function fmtTime(ts) {
      if (!ts) return '—'
      var d = new Date(ts)
      return isNaN(d.getTime()) ? String(ts) : d.toISOString().slice(0, 16).replace('T', ' ')
    }
    function fmtBytes(n) { return n === undefined || n === null ? '—' : String(n) }

    // ── 注入样式（Modal 宽度/高度覆盖 + 侧边栏入口按钮几何） ─────────────────
    var CSS_KEY = 'silksec-dashboard'
    if (!document.querySelector('style[data-plugin-css=' + JSON.stringify(CSS_KEY) + ']')) {
      var styleTag = document.createElement('style')
      styleTag.dataset.plugin = '@silksec/sec-dashboard'
      styleTag.dataset.pluginCss = CSS_KEY
      styleTag.textContent = [
        '.silksec-dash-dialog{width:min(1120px,calc(100vw - 48px));height:min(85vh,960px)}',
        '.silksec-dash-action{box-sizing:border-box;width:calc(100% + 8px);height:34px;margin:4px -4px;padding:6px 10px;border:0;border-radius:12px;background:0 0;cursor:pointer;display:flex;align-items:center;gap:6px;min-width:0;color:' + T.label2 + ';font:' + F.xs.font + ';transition:background-color ' + EASE + ',color ' + EASE + '}',
        '.silksec-dash-action:hover{background:' + T.hover + ';color:' + T.label + '}',
        '.silksec-dash-action[data-rail=true]{width:36px;height:36px;margin:4px 0;padding:0;border-radius:50%;justify-content:center}',
        '.silksec-dash-action:focus-visible{box-shadow:0 0 0 2px ' + T.border3 + ';outline:none}',
      ].join('\n')
      document.head.appendChild(styleTag)
    }

    // ── 通用样式对象（内联，复用避免每次渲染重建） ───────────────────────────
    var root = { display: 'flex', flexDirection: 'column', flex: '1 1 auto', minHeight: 0, boxSizing: 'border-box', padding: '18px 22px 0' }
    var header = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', minWidth: 0, marginBottom: 12 }
    var pageT = { color: T.label, ...F.baseStrong }
    var pageSub = { color: T.label3, marginTop: 2, ...F.xxs }
    var tabBar = { display: 'flex', gap: 4, borderBottom: '1px solid ' + T.border, flexWrap: 'wrap', marginBottom: 4 }
    var tabBase = { padding: '6px 14px', border: 'none', background: 'transparent', cursor: 'pointer', color: T.label3, ...F.s, borderBottom: '2px solid transparent', borderRadius: 0 }
    var body = { flex: '1 1 auto', overflowY: 'auto', minHeight: 0, padding: '12px 2px 20px' }
    var card = { padding: '12px 14px', borderRadius: 8, border: '1px solid ' + T.border, background: T.base, minWidth: 0, boxSizing: 'border-box' }
    var cardL = { color: T.label3, ...F.xxs }
    var cardV = { color: T.label, marginTop: 4, ...F.baseStrong }
    var stateLine = { color: T.label3, padding: '24px 0', ...F.s }
    var errorLine = { ...stateLine, color: T.error, padding: '8px 0' }
    var pill = { display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px', borderRadius: 999, fontSize: 11, lineHeight: '16px', border: '1px solid ' + T.border2, color: T.label2, background: 'transparent', flexShrink: 0, whiteSpace: 'nowrap' }
    var btn = { padding: '3px 10px', borderRadius: 6, border: '1px solid ' + T.border2, background: 'transparent', color: T.label, cursor: 'pointer', fontSize: 12, lineHeight: '18px' }
    var btnDanger = { ...btn, color: T.error, borderColor: 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 40%, transparent)' }
    var th = { textAlign: 'left', color: T.label3, padding: '6px 8px', ...F.xxsStrong, whiteSpace: 'nowrap' }
    var td = { padding: '6px 8px', color: T.label, ...F.xxs, verticalAlign: 'top', wordBreak: 'break-word' }
    var row = { borderBottom: '1px solid ' + T.border2 }

    function sevPill(sev) {
      var c = SEV_COLOR[sev] || SEV_COLOR.info
      return el('span', { style: { ...pill, color: c, borderColor: 'color-mix(in srgb, ' + c + ' 40%, transparent)' } }, SEV_LABEL[sev] || sev || 'info')
    }
    function statusPill(status) { return el('span', { style: pill }, STATUS_LABEL[status] || status || 'new') }
    function confPill(conf) {
      var c = conf === 'deprecated' ? T.label3 : conf === 'confirmed' ? T.success : T.warn
      return el('span', { style: { ...pill, color: c } }, CONF_LABEL[conf] || conf || 'tentative')
    }
    function taskPill(status) {
      return el('span', { style: pill }, TASK_STATUS_LABEL[status] || status || 'queued')
    }

    function tagBtn(label, status, onTag, disabled) {
      return el('button', { type: 'button', key: status, disabled: !!disabled, style: { ...btn, marginRight: 6, opacity: disabled ? 0.4 : 1 }, onClick: function () { onTag(status) } }, label)
    }

    function dashIcon() {
      return el('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, style: { flexShrink: 0 } },
        el('rect', { x: 2, y: 2, width: 5, height: 5, rx: 1 }),
        el('rect', { x: 9, y: 2, width: 5, height: 5, rx: 1 }),
        el('rect', { x: 2, y: 9, width: 5, height: 5, rx: 1 }),
        el('rect', { x: 9, y: 9, width: 5, height: 5, rx: 1 }))
    }

    // ── 数据读取 ─────────────────────────────────────────────────────────────
    var rpc = null
    function callRpc(endpoint, payload) {
      if (!rpc) return Promise.reject(new Error('连接通道不可用'))
      return rpc.call('/silksec-dashboard', endpoint, payload || {}).then(function (result) {
        if (result && result.ok) return result.value
        var error = result && result.error
        throw new Error(error && error.message ? error.message : 'rpc failed')
      })
    }
    var POLL_MS = 30000

    function useRpc(action, deps) {
      var state = React.useState({ loading: true, data: null, error: null })
      var data = state[0]
      var setData = state[1]
      React.useEffect(function () {
        var alive = true
        function load() {
          var a = action()
          if (!a) return
          callRpc(a.endpoint, a.payload).then(function (json) {
            if (alive) setData({ loading: false, data: json, error: null })
          }).catch(function (e) {
            if (alive) setData({ loading: false, data: null, error: e && e.message ? e.message : String(e) })
          })
        }
        load()
        var timer = setInterval(load, POLL_MS)
        return function () { alive = false; clearInterval(timer) }
      }, deps || [])
      return data
    }

    // ── 各视图 ───────────────────────────────────────────────────────────────
    function StatsHeader(props) {
      var s = props.stats || {}
      var kpis = [
        { label: '资产', value: fmtBytes(s.assets) },
        { label: '接口', value: fmtBytes(s.endpoints) },
        { label: '漏洞', value: fmtBytes(s.findings) },
        { label: '项目', value: fmtBytes(s.programs) },
        { label: '任务', value: fmtBytes(s.tasks) },
        { label: '事实', value: fmtBytes(s.blackboard_keys) },
      ]
      return el('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 140px), 1fr))', gap: 8, marginBottom: 12 } },
        kpis.map(function (kpi) {
          return el('div', { key: kpi.label, style: card },
            el('div', { style: cardL }, kpi.label),
            el('div', { style: cardV }, kpi.value))
        }))
    }

    function AssetsView(props) {
      var rows = props.data || []
      if (!rows.length) return el('div', { style: stateLine }, '暂无资产数据')
      return el('div', { style: { overflowX: 'auto', minWidth: 0 } },
        el('table', { style: { width: '100%', borderCollapse: 'collapse', minWidth: 560 } },
          el('thead', null, el('tr', null,
            el('th', { style: th }, '主机'),
            el('th', { style: th }, '类型'),
            el('th', { style: th }, '来源'),
            el('th', { style: th }, '项目'),
            el('th', { style: th }, '最近发现'))),
          el('tbody', null, rows.map(function (r) {
            return el('tr', { key: (r.host || '') + '|' + (r.type || ''), style: row },
              el('td', { style: td }, r.host),
              el('td', { style: td }, r.type),
              el('td', { style: td }, r.source || '—'),
              el('td', { style: td }, r.program_id || '—'),
              el('td', { style: td }, fmtTime(r.last_seen)))
          }))))
    }

    function FindingsView(props) {
      var rows = props.data || []
      var busy = props.busy
      if (!rows.length) return el('div', { style: stateLine }, '暂无漏洞数据')
      return el('div', { style: { overflowX: 'auto', minWidth: 0 } },
        el('table', { style: { width: '100%', borderCollapse: 'collapse', minWidth: 720 } },
          el('thead', null, el('tr', null,
            el('th', { style: th }, '#'),
            el('th', { style: th }, '级别'),
            el('th', { style: th }, '状态'),
            el('th', { style: th }, '标题'),
            el('th', { style: th }, '目标'),
            el('th', { style: th }, '打标'))),
          el('tbody', null, rows.map(function (r) {
            var taggable = ['new', 'confirmed'].indexOf(r.status) >= 0
            return el('tr', { key: String(r.id), style: row },
              el('td', { style: td }, String(r.id)),
              el('td', { style: td }, sevPill(r.severity)),
              el('td', { style: td }, statusPill(r.status)),
              el('td', { style: td }, r.title),
              el('td', { style: td }, r.url || r.host || '—'),
              el('td', { style: td },
                taggable
                  ? el('span', null,
                      tagBtn('确认', 'confirmed', function (s) { props.onTag(r.id, s) }, busy),
                      tagBtn('误报', 'false_positive', function (s) { props.onTag(r.id, s) }, busy),
                      tagBtn('忽略', 'ignored', function (s) { props.onTag(r.id, s) }, busy))
                  : el('span', { style: { color: T.label3, ...F.xxs } }, '已定案')))
          }))))
    }

    function FactsView(props) {
      var facts = props.facts || []
      var board = props.board || []
      var busy = props.busy
      return el('div', null,
        el('div', { style: pageT }, '事实图谱'),
        el('div', { style: pageSub }, '渗透过程沉淀的事实（fact），错误的 fact 会注入未来所有 prompt，请用「废弃」纠正。'),
        facts.length
          ? el('div', { style: { margin: '12px 0 20px', display: 'flex', flexDirection: 'column', gap: 8 } },
              facts.map(function (f) {
                var key = f.program_id + '/' + f.fact_key
                var deprecated = f.confidence === 'deprecated'
                return el('div', { key: key, style: { ...card, opacity: deprecated ? 0.55 : 1 } },
                  el('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
                    el('span', { style: { color: T.label, ...F.sStrong, wordBreak: 'break-all' } }, f.fact_key),
                    confPill(f.confidence),
                    el('span', { style: { marginLeft: 'auto', color: T.label3, ...F.xxxs } }, f.program_id),
                    el('button', { type: 'button', style: btn, disabled: !!busy || deprecated, onClick: function () { props.onCorrect(f.program_id, f.fact_key, f.summary) } }, '纠正'),
                    el('button', { type: 'button', style: btnDanger, disabled: !!busy || deprecated, onClick: function () { props.onDeprecate(f.program_id, f.fact_key) } }, '废弃')),
                  f.summary ? el('div', { style: { color: T.label2, marginTop: 6, ...F.xxs } }, f.summary) : null,
                  f.body ? el('div', { style: { color: T.label3, marginTop: 4, ...F.xxxs } }, f.body) : null)
              }))
          : el('div', { style: stateLine }, '暂无事实数据'),
        el('div', { style: { ...pageT, marginTop: 8 } }, '遗留黑板'),
        el('div', { style: pageSub }, '旧版扁平黑板（key/value，只读，待迁移进事实图谱）。'),
        board.length
          ? el('div', { style: { marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 } },
              board.map(function (b) {
                return el('div', { key: b.key, style: card },
                  el('div', { style: { color: T.label, ...F.xxsStrong, wordBreak: 'break-all' } }, b.key),
                  el('div', { style: { color: T.label2, marginTop: 4, ...F.xxs, wordBreak: 'break-word' } }, String(b.value || '').slice(0, 2000)))
              }))
          : el('div', { style: stateLine }, '暂无黑板数据'))
    }

    function TasksView(props) {
      var programs = props.programs || []
      var tasks = props.tasks || []
      var progs = programs.map(function (p) {
        return el('div', { key: p.id, style: card },
          el('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
            el('span', { style: { color: T.label, ...F.sStrong } }, p.id),
            p.platform ? el('span', { style: pill }, p.platform) : null,
            p.max_risk ? el('span', { style: pill }, '上限 ' + p.max_risk) : null,
            el('span', { style: { marginLeft: 'auto', color: T.label3, ...F.xxxs } }, p.status || 'active')))
      })
      return el('div', null,
        el('div', { style: pageT }, '项目'),
        el('div', { style: pageSub }, 'scope.yml 授权项目（Program），任务/资产/漏洞的归属主体。'),
        progs.length
          ? el('div', { style: { margin: '12px 0 20px', display: 'flex', flexDirection: 'column', gap: 8 } }, progs)
          : el('div', { style: stateLine }, '暂无项目'),
        el('div', { style: { ...pageT, marginTop: 8 } }, '任务'),
        el('div', { style: pageSub }, '编排器派发的任务队列（只读，起任务走对话）。'),
        tasks.length
          ? el('div', { style: { overflowX: 'auto', minWidth: 0, marginTop: 12 } },
              el('table', { style: { width: '100%', borderCollapse: 'collapse', minWidth: 640 } },
                el('thead', null, el('tr', null,
                  el('th', { style: th }, '#'),
                  el('th', { style: th }, '项目'),
                  el('th', { style: th }, '阶段'),
                  el('th', { style: th }, '目标'),
                  el('th', { style: th }, '状态'),
                  el('th', { style: th }, '优先级'))),
                el('tbody', null, tasks.map(function (t) {
                  return el('tr', { key: String(t.id), style: row },
                    el('td', { style: td }, String(t.id)),
                    el('td', { style: td }, t.program_id),
                    el('td', { style: td }, t.phase || '—'),
                    el('td', { style: td }, t.objective),
                    el('td', { style: td }, taskPill(t.status)),
                    el('td', { style: td }, String(t.priority ?? 5)))
                }))))
          : el('div', { style: stateLine }, '暂无任务'))
    }

    function DashboardShell() {
      var tab = React.useState('findings')
      var activeTab = tab[0]
      var setTab = tab[1]
      var busy = React.useState(false)
      var isBusy = busy[0]
      var setBusy = busy[1]
      var refresh = React.useState(0)
      var refreshTick = refresh[0]
      var doRefresh = function () { refresh([refreshTick + 1]) }

      var statsState = useRpc(function () { return { endpoint: 'stats' } }, [refreshTick])
      var findingsState = useRpc(function () {
        return activeTab === 'findings' ? { endpoint: 'findings', payload: { limit: 200 } } : null
      }, [activeTab, refreshTick])
      var assetsState = useRpc(function () {
        return activeTab === 'assets' ? { endpoint: 'assets', payload: { limit: 200 } } : null
      }, [activeTab, refreshTick])
      var factsState = useRpc(function () {
        return activeTab === 'facts' ? { endpoint: 'facts', payload: { limit: 200 } } : null
      }, [activeTab, refreshTick])
      var boardState = useRpc(function () {
        return activeTab === 'facts' ? { endpoint: 'blackboard' } : null
      }, [activeTab, refreshTick])
      var tasksState = useRpc(function () {
        return activeTab === 'tasks' ? { endpoint: 'tasks', payload: { limit: 200 } } : null
      }, [activeTab, refreshTick])
      var programsState = useRpc(function () {
        return activeTab === 'tasks' ? { endpoint: 'programs' } : null
      }, [activeTab, refreshTick])

      function withBusy(fn) {
        return function () {
          if (isBusy) return
          setBusy(true)
          Promise.resolve().then(fn).catch(function (e) {
            console.error('[sec-dashboard] 写操作失败:', e)
          }).finally(function () { setBusy(false); doRefresh() })
        }
      }
      function onTag(id, status) {
        withBusy(function () { return callRpc('findingUpdate', { id: id, status: status }) })()
      }
      function onDeprecate(programId, factKey) {
        withBusy(function () { return callRpc('factDeprecate', { program_id: programId, fact_key: factKey }) })()
      }
      function onCorrect(programId, factKey, currentSummary) {
        var next = null
        try { next = window.prompt('纠正事实摘要（留空保持原样）:', currentSummary || '') } catch (e) { next = null }
        if (next === null) return
        withBusy(function () {
          return callRpc('factCorrect', { program_id: programId, fact_key: factKey, summary: next })
        })()
      }

      var tabs = [
        { id: 'findings', label: '漏洞' },
        { id: 'assets', label: '资产' },
        { id: 'facts', label: '事实' },
        { id: 'tasks', label: '任务' },
      ]
      function tabButton(t) {
        var on = activeTab === t.id
        return el('button', {
          key: t.id, type: 'button',
          style: { ...tabBase, color: on ? T.label : T.label3, borderBottom: '2px solid ' + (on ? T.brand : 'transparent'), ...(on ? F.sStrong : {}) },
          onClick: function () { setTab(t.id) },
        }, t.label)
      }

      var content = null
      if (activeTab === 'findings') {
        content = findingsState.error ? el('div', { style: errorLine }, '加载失败: ' + findingsState.error)
          : findingsState.loading ? el('div', { style: stateLine }, '加载中…')
            : el(FindingsView, { data: findingsState.data, onTag: onTag, busy: isBusy })
      } else if (activeTab === 'assets') {
        content = assetsState.error ? el('div', { style: errorLine }, '加载失败: ' + assetsState.error)
          : assetsState.loading ? el('div', { style: stateLine }, '加载中…')
            : el(AssetsView, { data: assetsState.data })
      } else if (activeTab === 'facts') {
        content = (factsState.error || boardState.error) ? el('div', { style: errorLine }, '加载失败: ' + (factsState.error || boardState.error))
          : (factsState.loading || boardState.loading) ? el('div', { style: stateLine }, '加载中…')
            : el(FactsView, { facts: factsState.data, board: boardState.data, onDeprecate: onDeprecate, onCorrect: onCorrect, busy: isBusy })
      } else {
        content = (tasksState.error || programsState.error) ? el('div', { style: errorLine }, '加载失败: ' + (tasksState.error || programsState.error))
          : (tasksState.loading || programsState.loading) ? el('div', { style: stateLine }, '加载中…')
            : el(TasksView, { tasks: tasksState.data, programs: programsState.data })
      }

      return el('div', { style: root },
        el('div', { style: header },
          el('div', null,
            el('div', { style: pageT }, '安全看板'),
            el('div', { style: pageSub }, '全局 · 资产 / 漏洞 / 事实 / 任务 · 打标与事实纠正写入 audit.jsonl')),
          el('button', { type: 'button', style: btn, onClick: doRefresh }, '刷新')),
        statsState.error ? el('div', { style: errorLine }, '统计加载失败: ' + statsState.error) : el(StatsHeader, { stats: statsState.data }),
        el('div', { style: tabBar }, tabs.map(tabButton)),
        el('div', { style: body }, content))
    }

    // ── 侧边栏入口（root scope）：按钮 + 全局 Modal ──────────────────────────
    function SidebarAction(props) {
      var wide = props.wide !== false
      var openState = React.useState(false)
      var open = openState[0]
      var setOpen = openState[1]
      var close = function () { setOpen(false) }

      var button = el('button', {
        type: 'button',
        className: 'silksec-dash-action',
        'data-rail': wide ? undefined : 'true',
        title: '安全看板',
        onClick: function () { setOpen(true) },
      },
        dashIcon(),
        wide ? el('span', null, '看板') : null)

      if (!Modal) return button
      return el(React.Fragment, null,
        button,
        el(Modal, { open: open, onClose: close, title: '安全看板', headless: true, className: 'silksec-dash-dialog' },
          el(DashboardShell, null)))
    }

    exports.name = '@silksec/sec-dashboard'
    exports.inject = ['slots']
    exports.apply = function (ctx) {
      var slots = ctx.get('slots')
      if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') return

      var connection = ctx.get('connection')
      if (connection && connection.rpc && typeof connection.rpc.call === 'function') {
        rpc = connection.rpc
      }

      // 全局入口：侧边栏底部（root scope），任何会话/无会话时都可见
      slots.inject('sidebar.footer.action', function () {
        return slots.register({
          name: 'sidebar.footer.action',
          id: 'sec-dashboard',
          order: 20,
        }, SidebarAction)
      })
    }

    return module.exports
  },
})
