/**
 * @silksec/sec-dashboard — client half (browser bundle).
 *
 * SilkSecAgent「看板」——**全局**入口，不挂任何会话：
 *   - 入口：`sidebar.footer.action`（scope:root，侧边栏底部，任何会话/无会话时都可见）
 *   - 形态：primitives `Modal`（headless 模式，~1120px），内部五视图 tab：
 *     漏洞（findings，打标+来源会话跳链）/ 资产（assets）/ 事实（facts+遗留 blackboard，纠正·废弃）/
 *     任务（workspaces+tasks，工作区区块+定时调度+会话跳链）/ 授权（scope.yml 管理）
 *
 * 数据走 Host↔Client RPC 通道 `/silksec-dashboard`（`ctx.get('connection').rpc`），
 * 与 sec-suite 宿主侧 `connection.rpc.handle('/silksec-dashboard', …)` 一一对应。
 * 查询端点返回 { rows, total }（服务端分页 + 筛选）；写操作（打标 / 事实纠正 / 授权管理）
 * 直接复用宿主 assetDb/scope 函数 + audit.jsonl，本插件零持久化。
 * 跳链：inject sessions 服务，ctx.sessions.open(sessionId) 跳回来源会话（详情一律在会话里看）。
 *
 * 视觉遵循丝之歌主题设计规范（bundles/dsh/doc/silksong-theme-design.md）：
 * 宿主设计令牌（--dsw-alias-* / --dsw-font-*）+ primitives Modal；
 * severity 五色走 --silksec-sev-*（theme-silksong 插件注入，带 fallback）。
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
      layer1: 'var(--dsw-alias-bg-layer-1)',
      layer2: 'var(--dsw-alias-bg-layer-2)',
      hover: 'var(--dsw-alias-interactive-bg-hover)',
      brand: 'var(--dsw-alias-brand-primary)',
      success: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
      skeleton: 'var(--dsw-alias-bg-skeleton)',
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
    var MONO = 'var(--ds-font-family-code, ui-monospace, SFMono-Regular, Consolas, monospace)'
    var EASE = 'var(--ds-ease-in-out, cubic-bezier(.4, 0, .2, 1))'

    // severity 五色：丝之歌主题经 --silksec-sev-* 注入，fallback 为规范初值
    var SEV_COLOR = {
      critical: 'var(--silksec-sev-critical, #E55F5F)',
      high: 'var(--silksec-sev-high, #DA8248)',
      medium: 'var(--silksec-sev-medium, #DDAE55)',
      low: 'var(--silksec-sev-low, #5FA39A)',
      info: 'var(--silksec-sev-info, #948E7E)',
    }
    var SEV_LABEL = { critical: '严重', high: '高危', medium: '中危', low: '低危', info: '信息' }
    var STATUS_LABEL = {
      new: '新发现', confirmed: '已确认', false_positive: '误报', submitted: '已提交',
      accepted: '已接收', dup: '重复', ignored: '忽略',
    }
    // 已定案（降权淡出，规范 §7）
    var STATUS_CLOSED = ['false_positive', 'dup', 'ignored']
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

    // ── 注入样式（Modal 几何 + 侧边栏入口 + 工具条/分页/打标 hover 规则） ──────
    var CSS_KEY = 'silksec-dashboard'
    if (!document.querySelector('style[data-plugin-css=' + JSON.stringify(CSS_KEY) + ']')) {
      var styleTag = document.createElement('style')
      styleTag.dataset.plugin = '@silksec/sec-dashboard'
      styleTag.dataset.pluginCss = CSS_KEY
      styleTag.textContent = [
        '.silksec-dash-dialog{width:min(1280px,calc(100vw - 32px));height:min(88vh,1020px)}',
        '.silksec-dash-action{box-sizing:border-box;width:calc(100% + 8px);height:34px;margin:4px -4px;padding:6px 10px;border:0;border-radius:12px;background:0 0;cursor:pointer;display:flex;align-items:center;gap:6px;min-width:0;color:' + T.label2 + ';font:' + F.xs.font + ';transition:background-color 150ms ease-out,color 150ms ease-out}',
        '.silksec-dash-action:hover{background:' + T.hover + ';color:' + T.label + '}',
        '.silksec-dash-action[data-rail=true]{width:36px;height:36px;margin:4px 0;padding:0;border-radius:50%;justify-content:center}',
        '.silksec-dash-action:focus-visible{box-shadow:0 0 0 2px ' + T.border3 + ';outline:none}',
        // KPI 统计卡：hover 抬升边界 + 可点击跳视图
        '.silksec-kpi{box-sizing:border-box;text-align:left;padding:12px 14px;border-radius:8px;border:1px solid ' + T.border + ';background:' + T.base + ';min-width:0;cursor:pointer;font:inherit;transition:background-color 150ms ease-out,border-color 150ms ease-out}',
        '.silksec-kpi:hover{background:' + T.layer1 + ';border-color:' + T.border3 + '}',
        // 表格：行 hover 分界 + 表头强分界（真机校准 v2）
        '.silksec-row{border-bottom:1px solid ' + T.border2 + ';transition:background-color 150ms ease-out,opacity 150ms ease-out}',
        '.silksec-row:hover{background:' + T.hover + '}',
        // 工具条输入/下拉
        '.silksec-input{box-sizing:border-box;height:28px;padding:0 10px;border-radius:6px;border:1px solid ' + T.border2 + ';background:' + T.layer2 + ';color:' + T.label + ';font:' + F.xs.font + ';outline:none;transition:border-color 150ms ease-out}',
        '.silksec-input:focus{border-color:' + T.border3 + '}',
        '.silksec-input::placeholder{color:' + T.label3 + '}',
        'select.silksec-input{appearance:none;padding-right:22px;background-image:linear-gradient(45deg,transparent 50%,' + T.label3 + ' 50%),linear-gradient(135deg,' + T.label3 + ' 50%,transparent 50%);background-position:calc(100% - 13px) 50%,calc(100% - 9px) 50%;background-size:4px 4px;background-repeat:no-repeat;cursor:pointer}',
        // 打标按钮：确认 hover 转绯红填充（主行动语义，规范 §7）
        '.silksec-btn{box-sizing:border-box;height:26px;padding:0 10px;border-radius:6px;border:1px solid ' + T.border2 + ';background:transparent;color:' + T.label + ';cursor:pointer;font-size:13px;line-height:20px;transition:background-color 150ms ease-out,color 150ms ease-out,border-color 150ms ease-out}',
        '.silksec-btn:hover:not(:disabled){background:' + T.hover + '}',
        '.silksec-btn:disabled{opacity:0.4;cursor:default}',
        '.silksec-btn-confirm:hover:not(:disabled){background:' + T.brand + ';border-color:' + T.brand + ';color:var(--dsw-alias-brand-text)}',
        '.silksec-btn-danger{color:' + T.error + ';border-color:color-mix(in srgb, var(--dsw-alias-state-error-primary) 40%, transparent)}',
        '.silksec-btn-danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger)}',
        // 图标按钮（打标/行内操作，省位；title 原生悬停提示）
        '.silksec-icon-btn{box-sizing:border-box;width:26px;height:26px;padding:0;border-radius:6px;border:1px solid ' + T.border2 + ';background:transparent;color:' + T.label2 + ';cursor:pointer;display:inline-flex;align-items:center;justify-content:center;transition:background-color 150ms ease-out,color 150ms ease-out,border-color 150ms ease-out}',
        '.silksec-icon-btn:hover:not(:disabled){background:' + T.hover + ';color:' + T.label + '}',
        '.silksec-icon-btn:disabled{opacity:0.4;cursor:default}',
        '.silksec-icon-btn-confirm:hover:not(:disabled){background:' + T.brand + ';border-color:' + T.brand + ';color:var(--dsw-alias-brand-text)}',
        '.silksec-icon-btn-danger{color:' + T.error + ';border-color:color-mix(in srgb, var(--dsw-alias-state-error-primary) 40%, transparent)}',
        '.silksec-icon-btn-danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger);color:' + T.error + '}',
        // tab 下划线滑动
        '.silksec-tab{border:none;background:transparent;cursor:pointer;padding:6px 14px;border-radius:0;border-bottom:2px solid transparent;color:' + T.label3 + ';font:' + F.s.font + ';transition:color 150ms ease-out,border-color 200ms ' + EASE + '}',
        '.silksec-tab[data-on=true]{color:' + T.label + ';border-bottom-color:' + T.brand + ';font:' + F.sStrong.font + '}',
      ].join('\n')
      document.head.appendChild(styleTag)
    }

    // ── 通用样式对象（内联，复用避免每次渲染重建） ───────────────────────────
    var root = { display: 'flex', flexDirection: 'column', flex: '1 1 auto', minHeight: 0, boxSizing: 'border-box', padding: '18px 22px 0' }
    var header = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', minWidth: 0, marginBottom: 12 }
    var pageT = { color: T.label, ...F.baseStrong }
    var pageSub = { color: T.label3, marginTop: 2, ...F.xxs }
    // 丝线分隔线（规范 §5.1：1px，两端渐隐）
    var silkDivider = { height: 1, margin: '8px 0 0', background: 'linear-gradient(90deg, transparent, ' + T.border3 + ' 20%, ' + T.border3 + ' 80%, transparent)' }
    var tabBar = { display: 'flex', gap: 4, borderBottom: '1px solid ' + T.border, flexWrap: 'wrap', marginBottom: 4 }
    var body = { flex: '1 1 auto', overflowY: 'auto', minHeight: 0, padding: '12px 2px 20px' }
    var card = { padding: '12px 14px', borderRadius: 8, border: '1px solid ' + T.border, background: T.base, minWidth: 0, boxSizing: 'border-box' }
    var cardL = { color: T.label2, ...F.xxs }
    var cardV = { color: T.label, marginTop: 4, fontSize: 20, fontWeight: 600, lineHeight: '24px' }
    var stateLine = { color: T.label3, padding: '24px 0', ...F.s }
    var errorLine = { ...stateLine, color: T.error, padding: '8px 0' }
    var pill = { display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px', borderRadius: 999, fontSize: 12, lineHeight: '16px', border: '1px solid ' + T.border2, color: T.label2, background: 'transparent', flexShrink: 0, whiteSpace: 'nowrap' }
    // 表格：表头用 label2 提升可读性；单元格 13px + 更宽内距（真机校准 v2）
    var th = { textAlign: 'left', color: T.label2, padding: '8px 12px', ...F.xxsStrong, whiteSpace: 'nowrap' }
    var td = { padding: '8px 12px', color: T.label, ...F.xs, verticalAlign: 'middle', wordBreak: 'break-word' }
    var tdMono = { ...td, fontFamily: MONO, fontSize: 13 }
    var tableStyle = { width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }
    var theadRow = { borderBottom: '1px solid ' + T.border3 }
    var toolbar = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', margin: '10px 0 8px' }
    var pagerBar = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 10, color: T.label3, ...F.xxs }

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
      var extra = status === 'blocked' ? { color: T.warn } : status === 'failed' ? { color: T.error } : null
      return el('span', { style: { ...pill, ...(extra || {}) } }, TASK_STATUS_LABEL[status] || status || 'queued')
    }

    // ── 图标（规范 §5：内联 SVG，stroke 1.5，currentColor） ───────────────────
    // 丝轴 + 引出一段丝线（SilkSpool/Silksong 双关，全站唯一品牌图形）
    function spoolIcon(size) {
      return el('svg', { width: size || 16, height: size || 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', style: { flexShrink: 0 } },
        el('path', { d: 'M4 2.5h7' }),
        el('path', { d: 'M4 13.5h7' }),
        el('path', { d: 'M5.5 2.5v11M9.5 2.5v11' }),
        el('path', { d: 'M5.5 5.5h4M5.5 8h4M5.5 10.5h4' }),
        el('path', { d: 'M9.5 10.5c3 0.5 3 2.5 4.5 3' }))
    }

    // 打标操作图标（stroke 1.5，currentColor；title 提供悬停提示）
    function opIcon(kind) {
      var path = null
      if (kind === 'confirm') path = el('path', { d: 'M3.5 8.5l3 3 6-6.5' })
      else if (kind === 'false_positive') path = el(React.Fragment, null, el('path', { d: 'M4.5 4.5l7 7M11.5 4.5l-7 7' }))
      else if (kind === 'jump') path = el(React.Fragment, null, el('path', { d: 'M6 3.5h7v7' }), el('path', { d: 'M13 3.5L5.5 11' }), el('path', { d: 'M11 8v5H3.5V5.5H8' }))
      else if (kind === 'play') path = el('path', { d: 'M5 3.5l8 4.5-8 4.5z' })
      else path = el(React.Fragment, null, el('path', { d: 'M2.5 8s2.2-3.8 5.5-3.8S13.5 8 13.5 8 11.3 11.8 8 11.8 2.5 8 2.5 8z' }), el('path', { d: 'M4 13l8-10' }))
      return el('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' }, path)
    }

    // 会话跳链（详情一律在会话里看；无 session 显示「—」不造假链）
    var sessionsSvc = null
    function openSession(id) {
      if (!sessionsSvc || !id) return
      try { sessionsSvc.open(id) } catch (e) { console.error('[sec-dashboard] openSession 失败:', e) }
    }
    function SessionLink(props) {
      if (!props.id) return el('span', { style: { color: T.label3, ...F.xxxs } }, '—')
      return el('button', {
        type: 'button', className: 'silksec-icon-btn',
        title: '打开来源会话（' + String(props.id).slice(0, 18) + '…）', 'aria-label': '打开来源会话',
        onClick: function () { openSession(props.id) },
      }, opIcon('jump'))
    }

    // 空状态（规范 §8.3 双文案 + §5.1 线稿图标）
    function EmptyState(props) {
      return el('div', { style: { ...stateLine, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, padding: '36px 0' } },
        el('span', { style: { color: T.label3 } }, spoolIcon(24)),
        el('span', null, props.filtered ? '无匹配结果' : (props.text || '暂无数据')))
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
      var ts = React.useState(0)
      var tick = ts[0]
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
      }, (deps || []).concat([tick]))
      return { loading: data.loading, data: data.data, error: data.error, reload: function () { ts[1](function (t) { return t + 1 }) } }
    }

    // 分页查询 hook：搜索防抖 300ms、改条件页码归 1、过期响应丢弃、30s 轮询（仅活跃视图）
    function usePagedQuery(endpoint, active) {
      var qs = React.useState('')
      var q = qs[0]; var setQ = qs[1]
      var dqs = React.useState('')
      var dq = dqs[0]; var setDq = dqs[1]
      var fs = React.useState({})
      var filters = fs[0]; var setFilters = fs[1]
      var ps = React.useState(0)
      var page = ps[0]; var setPage = ps[1]
      var ss = React.useState(20)
      var size = ss[0]; var setSize = ss[1]
      var ts = React.useState(0)
      var tick = ts[0]; var setTick = ts[1]
      var rs = React.useState({ loading: true, rows: null, total: 0, error: null })
      var result = rs[0]; var setResult = rs[1]
      var seq = React.useRef(0)
      var loadRef = React.useRef(null)

      React.useEffect(function () {
        var t = setTimeout(function () { setDq(q); setPage(0) }, 300)
        return function () { clearTimeout(t) }
      }, [q])

      React.useEffect(function () {
        if (!active) return
        var alive = true
        function load() {
          var my = ++seq.current
          var payload = { limit: size, offset: page * size }
          if (dq) payload.q = dq
          for (var k in filters) if (filters[k]) payload[k] = filters[k]
          return callRpc(endpoint, payload).then(function (res) {
            if (!alive || my !== seq.current) return
            setResult({ loading: false, rows: (res && res.rows) || [], total: (res && res.total) || 0, error: null })
          }).catch(function (e) {
            if (!alive || my !== seq.current) return
            setResult({ loading: false, rows: null, total: 0, error: e && e.message ? e.message : String(e) })
          })
        }
        loadRef.current = load
        load()
        var timer = setInterval(load, POLL_MS)
        return function () { alive = false; clearInterval(timer) }
      }, [endpoint, active, dq, JSON.stringify(filters), page, size, tick])

      function setFilter(key, value) {
        setFilters(function (prev) {
          var next = { ...prev }
          if (value) next[key] = value; else delete next[key]
          return next
        })
        setPage(0)
      }
      function reset() { setQ(''); setDq(''); setFilters({}); setPage(0) }
      function reload() { setTick(function (t) { return t + 1 }) }
      function refresh() { return loadRef.current ? loadRef.current() : Promise.resolve() }

      return {
        q: q, setQ: setQ, filters: filters, setFilter: setFilter,
        page: page, setPage: setPage, size: size,
        setSize: function (n) { setSize(n); setPage(0) },
        rows: result.rows, total: result.total, loading: result.loading, error: result.error,
        filtered: !!(dq || Object.keys(filters).length),
        reset: reset, reload: reload, refresh: refresh,
      }
    }

    // ── 工具条 / 分页器 / 骨架 ────────────────────────────────────────────────
    function Toolbar(props) {
      return el('div', { style: toolbar },
        el('input', {
          className: 'silksec-input', style: { width: 220 },
          placeholder: props.placeholder || '搜索…',
          value: props.query.q,
          onChange: function (e) { props.query.setQ(e.target.value) },
        }),
        (props.filters || []).map(function (f) {
          return el('select', {
            key: f.key, className: 'silksec-input',
            value: props.query.filters[f.key] || '',
            onChange: function (e) { props.query.setFilter(f.key, e.target.value) },
          },
            el('option', { value: '' }, f.label + '：全部'),
            f.options.map(function (o) { return el('option', { key: o.v, value: o.v }, o.l) }))
        }))
    }

    function Pager(props) {
      var query = props.query
      var pages = Math.max(1, Math.ceil(query.total / query.size))
      return el('div', { style: pagerBar },
        el('button', { type: 'button', className: 'silksec-btn', disabled: query.page <= 0, onClick: function () { query.setPage(query.page - 1) } }, '‹ 上一页'),
        el('span', null, '第 ' + (query.page + 1) + ' / ' + pages + ' 页 · 共 ' + query.total + ' 条'),
        el('button', { type: 'button', className: 'silksec-btn', disabled: query.page >= pages - 1, onClick: function () { query.setPage(query.page + 1) } }, '下一页 ›'),
        el('select', {
          className: 'silksec-input', style: { marginLeft: 'auto' }, value: String(query.size),
          onChange: function (e) { query.setSize(Number(e.target.value)) },
        },
          el('option', { value: '20' }, '20 条/页'),
          el('option', { value: '50' }, '50 条/页'),
          el('option', { value: '100' }, '100 条/页')))
    }

    function SkeletonRows(props) {
      var rows = []
      for (var i = 0; i < (props.rows || 5); i++) {
        rows.push(el('div', { key: i, style: { height: 14, borderRadius: 4, background: T.skeleton, margin: '10px 8px', width: (88 - i * 7) + '%' } }))
      }
      return el('div', { style: { padding: '8px 0' } }, rows)
    }

    // 视图主体三态：错误 / 首载骨架 / 内容（后续刷新保留旧数据避免闪烁）
    function ViewBody(props) {
      var query = props.query
      if (query.error) return el('div', { style: errorLine }, '加载失败: ' + query.error)
      if (query.rows === null) return el(SkeletonRows, null)
      if (!query.rows.length) return el(EmptyState, { filtered: query.filtered, text: props.emptyText })
      return el(React.Fragment, null, props.children(query.rows), el(Pager, { query: query }))
    }

    // ── 各视图 ───────────────────────────────────────────────────────────────
    // KPI 统计卡：hover 有反馈、点击跳转对应视图
    function StatsHeader(props) {
      var s = props.stats || {}
      var kpis = [
        { label: '漏洞', value: fmtBytes(s.findings), tab: 'findings' },
        { label: '资产', value: fmtBytes(s.assets), tab: 'assets' },
        { label: '接口', value: fmtBytes(s.endpoints), tab: 'assets' },
        { label: '工作区', value: props.workspaceCount === null ? '—' : fmtBytes(props.workspaceCount), tab: 'tasks' },
        { label: '任务', value: fmtBytes(s.tasks), tab: 'tasks' },
        { label: '事实', value: fmtBytes(s.facts !== undefined ? s.facts : s.blackboard_keys), tab: 'facts' },
      ]
      return el('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 140px), 1fr))', gap: 8, marginBottom: 12 } },
        kpis.map(function (kpi) {
          return el('button', {
            key: kpi.label, type: 'button', className: 'silksec-kpi',
            title: '查看' + kpi.label,
            onClick: function () { props.onNavigate(kpi.tab) },
          },
            el('div', { style: cardL }, kpi.label),
            el('div', { style: cardV }, kpi.value))
        }))
    }

    function unusedPlaceholder() { return null }

    function FindingsView(props) {
      var query = props.query
      var busy = props.busy
      function tagIconBtn(label, status, id, kind, cls) {
        return el('button', {
          type: 'button', key: status, className: 'silksec-icon-btn' + (cls ? ' ' + cls : ''),
          disabled: !!busy, title: label, 'aria-label': label,
          onClick: function () { props.onTag(id, status) },
        }, opIcon(kind))
      }
      return el(ViewBody, { query: query, emptyText: '暂无漏洞数据' }, function (rows) {
        return el('div', { style: { overflowX: 'auto', minWidth: 0 } },
          // tableLayout fixed + colgroup：列宽恒定，ID/打标不错位
          el('table', { style: tableStyle },
            el('colgroup', null,
              el('col', { style: { width: 52 } }),
              el('col', { style: { width: 76 } }),
              el('col', { style: { width: 84 } }),
              el('col', null),
              el('col', { style: { width: '24%' } }),
              el('col', { style: { width: 56 } }),
              el('col', { style: { width: 110 } })),
            el('thead', null, el('tr', { style: theadRow },
              el('th', { style: th }, '#'),
              el('th', { style: th }, '级别'),
              el('th', { style: th }, '状态'),
              el('th', { style: th }, '标题'),
              el('th', { style: th }, '目标'),
              el('th', { style: th }, '会话'),
              el('th', { style: th }, '打标'))),
            el('tbody', null, rows.map(function (r) {
              var taggable = ['new', 'confirmed'].indexOf(r.status) >= 0
              var closed = STATUS_CLOSED.indexOf(r.status) >= 0
              // 强调（规范 §7）：new = 行左 2px 绯红边条；已定案 = 整行淡出
              var rowStyle = {
                opacity: closed ? 0.5 : 1,
                boxShadow: r.status === 'new' ? 'inset 2px 0 0 ' + T.brand : undefined,
              }
              return el('tr', { key: String(r.id), className: 'silksec-row', style: rowStyle },
                el('td', { style: tdMono }, String(r.id)),
                el('td', { style: td }, sevPill(r.severity)),
                el('td', { style: td }, statusPill(r.status)),
                el('td', { style: td }, r.title),
                el('td', { style: tdMono }, r.url || r.host || '—'),
                el('td', { style: td }, el(SessionLink, { id: r.session_id })),
                el('td', { style: { ...td, whiteSpace: 'nowrap' } },
                  taggable
                    ? el('span', { style: { display: 'inline-flex', gap: 6 } },
                        tagIconBtn('确认（确认为真实漏洞）', 'confirmed', r.id, 'confirm', 'silksec-icon-btn-confirm'),
                        tagIconBtn('误报（标记为误报）', 'false_positive', r.id, 'false_positive'),
                        tagIconBtn('忽略（不再跟进）', 'ignored', r.id, 'ignored'))
                    : el('span', { style: { color: T.label3, ...F.xs } }, '已定案')))
            }))))
      })
    }

    function AssetsView(props) {
      var query = props.query
      return el(ViewBody, { query: query, emptyText: '暂无资产数据' }, function (rows) {
        return el('div', { style: { overflowX: 'auto', minWidth: 0 } },
          el('table', { style: tableStyle },
            el('colgroup', null,
              el('col', null),
              el('col', { style: { width: 90 } }),
              el('col', { style: { width: 110 } }),
              el('col', { style: { width: 130 } }),
              el('col', { style: { width: 140 } })),
            el('thead', null, el('tr', { style: theadRow },
              el('th', { style: th }, '主机'),
              el('th', { style: th }, '类型'),
              el('th', { style: th }, '来源'),
              el('th', { style: th }, '项目'),
              el('th', { style: th }, '最近发现'))),
            el('tbody', null, rows.map(function (r) {
              return el('tr', { key: (r.host || '') + '|' + (r.type || ''), className: 'silksec-row' },
                el('td', { style: tdMono }, r.host),
                el('td', { style: td }, r.type),
                el('td', { style: td }, r.source || '—'),
                el('td', { style: td }, r.program_id || '—'),
                el('td', { style: tdMono }, fmtTime(r.last_seen)))
            }))))
      })
    }

    function FactsView(props) {
      var query = props.query
      var board = props.board || []
      var busy = props.busy
      return el('div', null,
        el(ViewBody, { query: query, emptyText: '暂无事实数据' }, function (facts) {
          return el('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
            facts.map(function (f) {
              var key = f.program_id + '/' + f.fact_key
              var deprecated = f.confidence === 'deprecated'
              return el('div', { key: key, style: { ...card, opacity: deprecated ? 0.55 : 1 } },
                el('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
                  el('span', { style: { color: T.label, ...F.sStrong, wordBreak: 'break-all' } }, f.fact_key),
                  confPill(f.confidence),
                  el('span', { style: { marginLeft: 'auto', color: T.label3, ...F.xxxs } }, f.program_id),
                  el('button', { type: 'button', className: 'silksec-btn', disabled: !!busy || deprecated, onClick: function () { props.onCorrect(f.program_id, f.fact_key, f.summary) } }, '纠正'),
                  el('button', { type: 'button', className: 'silksec-btn silksec-btn-danger', disabled: !!busy || deprecated, onClick: function () { props.onDeprecate(f.program_id, f.fact_key) } }, '废弃')),
                f.summary ? el('div', { style: { color: T.label2, marginTop: 6, ...F.xxs } }, f.summary) : null)
            }))
        }),
        el('div', { style: { ...pageT, marginTop: 20 } }, '遗留黑板'),
        el('div', { style: pageSub }, '旧版扁平黑板（key/value，只读，待迁移进事实图谱）。'),
        board.length
          ? el('div', { style: { marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 } },
              board.map(function (b) {
                return el('div', { key: b.key, style: card },
                  el('div', { style: { color: T.label, ...F.xxsStrong, wordBreak: 'break-all', fontFamily: MONO, fontSize: 12 } }, b.key),
                  el('div', { style: { color: T.label2, marginTop: 4, ...F.xxs, wordBreak: 'break-word' } }, String(b.value || '').slice(0, 2000)))
              }))
          : el(EmptyState, { text: '暂无黑板数据' }))
    }

    // 调度徽章：周期/一次 + 下次运行时间
    function schedulePill(t) {
      if (!t.schedule_kind) return null
      var label = t.schedule_kind === 'interval'
        ? '周期 ' + Math.round((t.every_seconds || 0) / 60) + 'm'
        : '一次'
      return el('span', { style: { ...pill, color: T.brand, borderColor: 'color-mix(in srgb, var(--dsw-alias-brand-primary) 40%, transparent)' }, title: '下次运行: ' + fmtTime(t.next_run_at) },
        label + ' · ' + fmtTime(t.next_run_at))
    }

    // 工作区卡：标题/路径 + program 徽章 + 计数 + 会话列表（展开跳链）
    function WorkspaceCard(props) {
      var w = props.ws
      var expanded = React.useState(false)
      var open = expanded[0]; var setOpen = expanded[1]
      var ss = React.useState(null)
      var sessions = ss[0]; var setSessions = ss[1]
      function toggle() {
        var next = !open
        setOpen(next)
        if (next && !sessions) {
          callRpc('sessions', { workspace_id: w.id }).then(function (res) {
            setSessions((res && res.items) || [])
          }).catch(function () { setSessions([]) })
        }
      }
      return el('div', { style: card },
        el('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
          el('span', { style: { color: T.label, ...F.sStrong } }, w.title),
          el('span', { style: { color: T.label3, ...F.xxxs, fontFamily: MONO } }, w.path),
          w.program
            ? el('span', { style: { ...pill, color: T.success, borderColor: 'color-mix(in srgb, var(--dsw-alias-state-success-primary) 40%, transparent)' } }, '授权 ' + w.program.id)
            : el('span', { style: { ...pill, color: T.warn, borderColor: 'color-mix(in srgb, var(--dsw-alias-state-warn-primary) 40%, transparent)' }, title: '工作区未绑定 scope.yml 授权项目：scope-guard 对其目标 fail-closed 全拒绝。到「授权」视图登记并绑定。' }, '未绑定授权'),
          w.program && w.program.max_risk ? el('span', { style: pill }, '上限 ' + w.program.max_risk) : null,
          el('span', { style: { marginLeft: 'auto', color: T.label3, ...F.xxxs } },
            '资产 ' + w.assets + ' · 漏洞 ' + w.findings + ' · 任务 ' + w.tasks + ' · 会话 ' + w.session_count),
          el('button', { type: 'button', className: 'silksec-btn', onClick: toggle }, open ? '收起会话' : '会话')),
        open && sessions
          ? el('div', { style: { marginTop: 10, display: 'flex', flexDirection: 'column', gap: 4 } },
              sessions.length
                ? sessions.map(function (s) {
                    return el('div', { key: s.id, style: { display: 'flex', alignItems: 'center', gap: 8 } },
                      el('span', { style: { color: T.label2, ...F.xxs, fontFamily: MONO } }, String(s.id).replace(/^session-/, '').slice(0, 8) + '…'),
                      el('span', { style: { color: T.label3, ...F.xxxs } }, s.created_at ? String(s.created_at).slice(0, 16).replace('T', ' ') : ''),
                      el('button', { type: 'button', className: 'silksec-icon-btn', title: '打开会话', onClick: function () { openSession(s.id) } }, opIcon('jump')))
                  })
                : el('span', { style: { color: T.label3, ...F.xxs } }, '暂无会话'))
          : null)
    }

    function TasksView(props) {
      var query = props.query
      var workspaces = props.workspaces
      var items = (workspaces && workspaces.items) || []
      return el('div', null,
        el('div', { style: pageT }, '工作区'),
        el('div', { style: pageSub }, 'DSH 工作区（目录 + 会话组），项目的唯一用户可感概念；徽章显示绑定的 scope.yml 授权。新建工作区 ≠ 自动授权。'),
        workspaces && workspaces.available === false
          ? el('div', { style: errorLine }, '工作区服务不可用（workspaceRegistry 未组合）')
          : items.length
            ? el('div', { style: { margin: '12px 0 20px', display: 'flex', flexDirection: 'column', gap: 8 } },
                items.map(function (w) { return el(WorkspaceCard, { key: w.id, ws: w }) }))
            : el(EmptyState, { text: '暂无工作区' }),
        el('div', { style: { ...pageT, marginTop: 8 } }, '任务'),
        el('div', { style: pageSub }, '编排器派发的任务队列；带调度徽章的为定时任务（调度循环自动执行，会话归入对应工作区）。对话里说「定时跑 X」即建此类任务。'),
        el(ViewBody, { query: query, emptyText: '暂无任务' }, function (rows) {
          return el('div', { style: { overflowX: 'auto', minWidth: 0, marginTop: 12 } },
            el('table', { style: tableStyle },
              el('colgroup', null,
                el('col', { style: { width: 44 } }),
                el('col', { style: { width: 96 } }),
                el('col', { style: { width: 84 } }),
                el('col', null),
                el('col', { style: { width: 150 } }),
                el('col', { style: { width: 76 } }),
                el('col', { style: { width: 96 } })),
              el('thead', null, el('tr', { style: theadRow },
                el('th', { style: th }, '#'),
                el('th', { style: th }, '工作区'),
                el('th', { style: th }, '阶段'),
                el('th', { style: th }, '目标'),
                el('th', { style: th }, '调度'),
                el('th', { style: th }, '状态'),
                el('th', { style: th }, '操作'))),
              el('tbody', null, rows.map(function (t) {
                return el('tr', { key: String(t.id), className: 'silksec-row' },
                  el('td', { style: tdMono }, String(t.id)),
                  el('td', { style: td }, t.program_id),
                  el('td', { style: td }, t.phase || '—'),
                  el('td', { style: td }, t.objective),
                  el('td', { style: td }, schedulePill(t) || el('span', { style: { color: T.label3, ...F.xxxs } }, '—')),
                  el('td', { style: td }, taskPill(t.status)),
                  el('td', { style: { ...td, whiteSpace: 'nowrap' } },
                    el('span', { style: { display: 'inline-flex', gap: 6 } },
                      el(SessionLink, { id: t.session_id }),
                      t.schedule_kind && t.status === 'queued'
                        ? el('button', {
                            type: 'button', className: 'silksec-icon-btn', disabled: !!props.busy,
                            title: '立即执行一次（不动调度节律）', 'aria-label': '立即执行',
                            onClick: function () { props.onRunNow(t.id) },
                          }, opIcon('play'))
                        : null)))
              }))))
        }))
    }

    // ── 授权视图（scope.yml 管理：新增/编辑/移除 + 工作区绑定）─────────────────
    var inputStyle = { width: '100%', boxSizing: 'border-box' }
    var formRow = { display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 10 }
    var formLabel = { color: T.label2, ...F.xxsStrong }

    function ScopeForm(props) {
      var init = props.initial || {}
      var name = React.useState(init.name || '')
      var platform = React.useState(init.platform || '')
      var scope = React.useState((init.scope || []).join('\n'))
      var exclude = React.useState((init.exclude || []).join('\n'))
      var maxRisk = React.useState(init.max_risk || 'active')
      var workspace = React.useState(init.workspace || '')
      var wsOptions = ((props.workspaces && props.workspaces.items) || []).map(function (w) { return w.title })
      function submit() {
        props.onSave({
          name: name[0].trim(),
          platform: platform[0].trim(),
          scope: scope[0].split('\n').map(function (s) { return s.trim() }).filter(Boolean),
          exclude: exclude[0].split('\n').map(function (s) { return s.trim() }).filter(Boolean),
          max_risk: maxRisk[0],
          workspace: workspace[0],
        }, !init.name)
      }
      return el('div', { style: { ...card, borderColor: T.border3, marginTop: 12 } },
        el('div', { style: { ...F.sStrong, color: T.label, marginBottom: 10 } }, init.name ? '编辑授权项目：' + init.name : '新增授权项目'),
        el('div', { style: formRow },
          el('span', { style: formLabel }, '项目名（小写字母/数字/中划线，如 bytedance）'),
          el('input', { className: 'silksec-input', style: inputStyle, value: name[0], disabled: !!init.name, onChange: function (e) { name[1](e.target.value) } })),
        el('div', { style: formRow },
          el('span', { style: formLabel }, '平台（可选，如 字节跳动 SRC）'),
          el('input', { className: 'silksec-input', style: inputStyle, value: platform[0], onChange: function (e) { platform[1](e.target.value) } })),
        el('div', { style: formRow },
          el('span', { style: formLabel }, '授权范围（每行一条：*.example.com / 1.2.3.4 / 10.0.0.0/8）'),
          el('textarea', { className: 'silksec-input', style: { ...inputStyle, height: 88, padding: '8px 10px', fontFamily: MONO, fontSize: 12, resize: 'vertical' }, value: scope[0], onChange: function (e) { scope[1](e.target.value) } })),
        el('div', { style: formRow },
          el('span', { style: formLabel }, '排除清单（每行一条，可选）'),
          el('textarea', { className: 'silksec-input', style: { ...inputStyle, height: 44, padding: '8px 10px', fontFamily: MONO, fontSize: 12, resize: 'vertical' }, value: exclude[0], onChange: function (e) { exclude[1](e.target.value) } })),
        el('div', { style: { display: 'flex', gap: 12, flexWrap: 'wrap' } },
          el('div', { style: { ...formRow, flex: '1 1 160px' } },
            el('span', { style: formLabel }, '风险上限'),
            el('select', { className: 'silksec-input', style: inputStyle, value: maxRisk[0], onChange: function (e) { maxRisk[1](e.target.value) } },
              ['passive', 'active', 'intrusive'].map(function (r) { return el('option', { key: r, value: r }, r) }))),
          el('div', { style: { ...formRow, flex: '1 1 160px' } },
            el('span', { style: formLabel }, '绑定工作区（可选）'),
            el('select', { className: 'silksec-input', style: inputStyle, value: workspace[0], onChange: function (e) { workspace[1](e.target.value) } },
              el('option', { value: '' }, '不绑定'),
              wsOptions.map(function (t2) { return el('option', { key: t2, value: t2 }, t2) })))),
        el('div', { style: { display: 'flex', gap: 8, marginTop: 4 } },
          el('button', { type: 'button', className: 'silksec-btn silksec-btn-confirm', disabled: !!props.busy, onClick: submit }, '保存（原子写 scope.yml + 审计）'),
          el('button', { type: 'button', className: 'silksec-btn', onClick: props.onCancel }, '取消')))
    }

    function ScopeView(props) {
      var data = props.scopeData
      var editing = React.useState(null)
      var editingState = editing[0]; var setEditing = editing[1]
      if (!data) return el(SkeletonRows, null)
      var programs = data.programs || []
      var dft = data.defaults || {}
      return el('div', null,
        el('div', { style: pageSub },
          'scope.yml 授权白名单（fail-closed：不在此处的目标一律拒绝）。默认风险级: ' + ((dft.allow_risk || []).join('/') || 'passive/active') + '；出口代理: ' + (dft.egress_proxy || '—') + '。界面写入自动备份 scope.yml.bak 并记 audit.jsonl。'),
        programs.map(function (p) {
          return el('div', { key: p.name, style: { ...card, marginTop: 12 } },
            el('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
              el('span', { style: { color: T.label, ...F.sStrong, fontFamily: MONO } }, p.name),
              p.platform ? el('span', { style: pill }, p.platform) : null,
              el('span', { style: p.max_risk === 'intrusive' ? { ...pill, color: T.warn } : pill }, '上限 ' + p.max_risk),
              p.workspace
                ? el('span', { style: { ...pill, color: T.success } }, '工作区 ' + p.workspace)
                : el('span', { style: { ...pill, color: T.label3 }, title: '未绑定工作区：task_create 无法按会话自动带出归属' }, '未绑工作区'),
              el('span', { style: { marginLeft: 'auto' } }),
              el('button', { type: 'button', className: 'silksec-btn', disabled: !!props.busy, onClick: function () { setEditing({ name: p.name, platform: p.platform, scope: p.scope, exclude: p.exclude, max_risk: p.max_risk, workspace: p.workspace }) } }, '编辑'),
              el('button', {
                type: 'button', className: 'silksec-btn silksec-btn-danger', disabled: !!props.busy,
                title: '从 scope.yml 移除（fail-closed 立即生效；programs 表归档，资产/漏洞归属保留）',
                onClick: function () {
                  var yes = false
                  try { yes = window.confirm('确认移除 ' + p.name + ' 的授权？目标立即被 fail-closed 拒绝；历史数据保留并归档。') } catch (e) { return }
                  if (yes) props.onDelete(p.name)
                },
              }, '移除授权')),
            el('div', { style: { marginTop: 8, display: 'flex', gap: 4, flexWrap: 'wrap' } },
              (p.scope || []).map(function (s) { return el('span', { key: s, style: { ...pill, fontFamily: MONO, fontSize: 11 } }, s) })),
            (p.exclude && p.exclude.length)
              ? el('div', { style: { marginTop: 6, display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' } },
                  el('span', { style: { color: T.label3, ...F.xxxs } }, '排除:'),
                  p.exclude.map(function (s) { return el('span', { key: s, style: { ...pill, fontFamily: MONO, fontSize: 11, color: T.error } }, s) }))
              : null)
        }),
        (data.archived || []).length
          ? el('div', { style: { ...pageSub, marginTop: 12 } }, '已归档（授权已移除，数据归属保留）: ' + data.archived.map(function (p) { return p.id }).join(' / '))
          : null,
        editingState
          ? el(ScopeForm, {
              initial: editingState, workspaces: props.workspaces, busy: props.busy,
              onSave: function (spec, isNew) { props.onSave(spec, isNew); setEditing(null) },
              onCancel: function () { setEditing(null) },
            })
          : el('button', { type: 'button', className: 'silksec-btn', style: { marginTop: 14 }, onClick: function () { setEditing({}) } }, '+ 新增授权项目'))
    }

    // ── 看板外壳 ─────────────────────────────────────────────────────────────
    function DashboardShell() {
      var tab = React.useState('findings')
      var activeTab = tab[0]
      var setTab = tab[1]
      var busy = React.useState(false)
      var isBusy = busy[0]
      var setBusy = busy[1]
      var rfs = React.useState(false)
      var refreshing = rfs[0]
      var setRefreshing = rfs[1]

      var statsState = useRpc(function () { return { endpoint: 'stats' } }, [])
      var workspacesState = useRpc(function () { return { endpoint: 'workspaces' } }, [])
      var scopeState = useRpc(function () {
        return activeTab === 'scope' ? { endpoint: 'scopeList' } : null
      }, [activeTab])
      var boardState = useRpc(function () {
        return activeTab === 'facts' ? { endpoint: 'blackboard' } : null
      }, [activeTab])

      // 四个视图各自的分页查询（状态按 tab 记忆，Modal 关闭即销毁重置；仅活跃视图取数/轮询）
      var findingsQ = usePagedQuery('findings', activeTab === 'findings')
      var assetsQ = usePagedQuery('assets', activeTab === 'assets')
      var factsQ = usePagedQuery('facts', activeTab === 'facts')
      var tasksQ = usePagedQuery('tasks', activeTab === 'tasks')

      function withBusy(fn) {
        return function () {
          if (isBusy) return
          setBusy(true)
          Promise.resolve().then(fn).catch(function (e) {
            console.error('[sec-dashboard] 写操作失败:', e)
            try { window.alert('操作失败: ' + (e && e.message ? e.message : e)) } catch (e2) {}
          }).finally(function () { setBusy(false); findingsQ.reload(); factsQ.reload(); tasksQ.reload() })
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
      function onRunNow(id) {
        withBusy(function () { return callRpc('taskRunNow', { id: id }) })()
      }
      function onScopeSave(spec, isNew) {
        withBusy(function () {
          return callRpc('scopeSaveProgram', { ...spec, is_new: isNew }).then(function () { scopeState.reload() })
        })()
      }
      function onScopeDelete(name) {
        withBusy(function () {
          return callRpc('scopeDeleteProgram', { name: name }).then(function () { scopeState.reload() })
        })()
      }

      var tabs = [
        { id: 'findings', label: '漏洞' },
        { id: 'assets', label: '资产' },
        { id: 'facts', label: '事实' },
        { id: 'tasks', label: '任务' },
        { id: 'scope', label: '授权' },
      ]
      function tabButton(t) {
        return el('button', {
          key: t.id, type: 'button', className: 'silksec-tab',
          'data-on': activeTab === t.id ? 'true' : undefined,
          onClick: function () { setTab(t.id) },
        }, t.label)
      }

      var wsItems = (workspacesState.data && workspacesState.data.items) || []
      // 筛选器选项：值仍用 program_id（数据外键），标签显示工作区标题（用户可感概念）
      var progOpts = wsItems.filter(function (w) { return w.program }).map(function (w) { return { v: w.program.id, l: w.title + '（' + w.program.id + '）' } })
      var content = null
      if (activeTab === 'findings') {
        content = el(React.Fragment, null,
          el(Toolbar, {
            query: findingsQ, placeholder: '搜索标题 / 主机 / URL…',
            filters: [
              { key: 'severity', label: '级别', options: Object.keys(SEV_LABEL).map(function (k) { return { v: k, l: SEV_LABEL[k] } }) },
              { key: 'status', label: '状态', options: Object.keys(STATUS_LABEL).map(function (k) { return { v: k, l: STATUS_LABEL[k] } }) },
              { key: 'program_id', label: '工作区', options: progOpts },
            ],
          }),
          el(FindingsView, { query: findingsQ, onTag: onTag, busy: isBusy }))
      } else if (activeTab === 'assets') {
        var typeOpts = ((statsState.data && statsState.data.assets_by_type) || []).map(function (r) { return { v: r.type, l: r.type + ' (' + r.n + ')' } })
        content = el(React.Fragment, null,
          el(Toolbar, {
            query: assetsQ, placeholder: '搜索主机…',
            filters: [
              { key: 'type', label: '类型', options: typeOpts },
              { key: 'program_id', label: '工作区', options: progOpts },
            ],
          }),
          el(AssetsView, { query: assetsQ }))
      } else if (activeTab === 'facts') {
        content = el(React.Fragment, null,
          el(Toolbar, {
            query: factsQ, placeholder: '搜索事实 key / 摘要…',
            filters: [
              { key: 'category', label: '分类', options: ['auth', 'target', 'note', 'finding', 'chain', 'exploit', 'asset'].map(function (c) { return { v: c, l: c } }) },
              { key: 'confidence', label: '置信', options: Object.keys(CONF_LABEL).map(function (k) { return { v: k, l: CONF_LABEL[k] } }) },
              { key: 'program_id', label: '工作区', options: progOpts },
            ],
          }),
          el(FactsView, { query: factsQ, board: boardState.data, onDeprecate: onDeprecate, onCorrect: onCorrect, busy: isBusy }))
      } else if (activeTab === 'tasks') {
        content = el(React.Fragment, null,
          el(Toolbar, {
            query: tasksQ, placeholder: '搜索任务目标…',
            filters: [
              { key: 'status', label: '状态', options: Object.keys(TASK_STATUS_LABEL).map(function (k) { return { v: k, l: TASK_STATUS_LABEL[k] } }) },
              { key: 'phase', label: '阶段', options: ['recon', 'vuln', 'biz-logic', 'code-audit', 'intranet', 'review'].map(function (c) { return { v: c, l: c } }) },
              { key: 'program_id', label: '工作区', options: progOpts },
            ],
          }),
          el(TasksView, { query: tasksQ, workspaces: workspacesState.data, onRunNow: onRunNow, busy: isBusy }))
      } else if (activeTab === 'scope') {
        content = el(ScopeView, {
          scopeData: scopeState.data, workspaces: workspacesState.data,
          onSave: onScopeSave, onDelete: onScopeDelete, busy: isBusy,
        })
      }

      return el('div', { style: root },
        el('div', { style: header },
          el('div', null,
            el('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
              el('span', { style: { color: T.brand, display: 'inline-flex' } }, spoolIcon(16)),
              el('div', { style: pageT }, '安全看板')),
            el('div', { style: pageSub }, '全局 · 工作区 / 资产 / 漏洞 / 事实 / 任务 / 授权 · 写操作全部写入 audit.jsonl · 行内跳链回来源会话'),
            el('div', { style: silkDivider })),
          el('button', {
            type: 'button', className: 'silksec-btn', disabled: refreshing,
            title: '重新加载当前看板数据',
            onClick: function () {
              if (refreshing) return
              setRefreshing(true)
              Promise.all([findingsQ.refresh(), assetsQ.refresh(), factsQ.refresh(), tasksQ.refresh()])
                .catch(function () {}).then(function () { setRefreshing(false) })
            },
          }, refreshing ? '刷新中…' : '刷新')),
        statsState.error ? el('div', { style: errorLine }, '统计加载失败: ' + statsState.error) : el(StatsHeader, {
          stats: statsState.data,
          workspaceCount: workspacesState.data && workspacesState.data.available ? wsItems.length : null,
          onNavigate: setTab,
        }),
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
        spoolIcon(16),
        wide ? el('span', null, '看板') : null)

      if (!Modal) return button
      return el(React.Fragment, null,
        button,
        el(Modal, { open: open, onClose: close, title: '安全看板', headless: true, className: 'silksec-dash-dialog' },
          el(DashboardShell, null)))
    }

    exports.name = '@silksec/sec-dashboard'
    exports.inject = ['slots', 'sessions']
    exports.apply = function (ctx) {
      var slots = ctx.get('slots')
      if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') return

      var connection = ctx.get('connection')
      if (connection && connection.rpc && typeof connection.rpc.call === 'function') {
        rpc = connection.rpc
      }
      // 会话跳链服务（官方 workflow-run 面板同款机制）；不可用时跳链按钮静默降级
      var sessions = ctx.get('sessions')
      if (sessions && typeof sessions.open === 'function') sessionsSvc = sessions

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
