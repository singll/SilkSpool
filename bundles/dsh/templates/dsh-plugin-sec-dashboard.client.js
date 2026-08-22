/**
 * @silksec/sec-dashboard — client half (browser bundle).
 *
 * SilkSecAgent「看板」——**全局**入口，不挂任何会话：
 *   - 入口：`sidebar.footer.action`（scope:root，侧边栏底部，任何会话/无会话时都可见）
 *   - 形态：primitives `Modal`（headless 模式，~1120px），内部四视图 tab：
 *     漏洞（findings，打标）/ 资产（assets）/ 事实（facts+遗留 blackboard，纠正·废弃）/
 *     任务（programs+tasks，只读）
 *
 * 数据走 Host↔Client RPC 通道 `/silksec-dashboard`（`ctx.get('connection').rpc`），
 * 与 sec-suite 宿主侧 `connection.rpc.handle('/silksec-dashboard', …)` 一一对应。
 * 查询端点返回 { rows, total }（服务端分页 + 筛选）；写操作（打标 / 事实纠正）
 * 直接复用宿主 assetDb 函数 + audit.jsonl，本插件零持久化。
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
      else path = el(React.Fragment, null, el('path', { d: 'M2.5 8s2.2-3.8 5.5-3.8S13.5 8 13.5 8 11.3 11.8 8 11.8 2.5 8 2.5 8z' }), el('path', { d: 'M4 13l8-10' }))
      return el('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' }, path)
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

    // 分页查询 hook：搜索防抖 300ms、改条件页码归 1、过期响应丢弃、30s 轮询当前页
    function usePagedQuery(endpoint) {
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
      }, [endpoint, dq, JSON.stringify(filters), page, size, tick])

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
        { label: '项目', value: fmtBytes(s.programs), tab: 'tasks' },
        { label: '任务', value: fmtBytes(s.tasks), tab: 'tasks' },
        { label: '事实', value: fmtBytes(s.blackboard_keys), tab: 'facts' },
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

    function programOptions(programs) {
      return (programs || []).map(function (p) { return { v: p.id, l: p.id } })
    }

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
              el('col', { style: { width: '26%' } }),
              el('col', { style: { width: 120 } })),
            el('thead', null, el('tr', { style: theadRow },
              el('th', { style: th }, '#'),
              el('th', { style: th }, '级别'),
              el('th', { style: th }, '状态'),
              el('th', { style: th }, '标题'),
              el('th', { style: th }, '目标'),
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

    function TasksView(props) {
      var query = props.query
      var programs = props.programs || []
      var progs = programs.map(function (p) {
        var intrusive = p.max_risk === 'intrusive'
        return el('div', { key: p.id, style: card },
          el('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
            el('span', { style: { color: T.label, ...F.sStrong } }, p.id),
            p.platform ? el('span', { style: pill }, p.platform) : null,
            // 规范 §7：风险上限仅 intrusive 时用丝线金提示
            p.max_risk ? el('span', { style: intrusive ? { ...pill, color: T.warn, borderColor: 'color-mix(in srgb, var(--dsw-alias-state-warn-primary) 40%, transparent)' } : pill }, '上限 ' + p.max_risk) : null,
            el('span', { style: { marginLeft: 'auto', color: T.label3, ...F.xxxs } }, p.status || 'active')))
      })
      return el('div', null,
        el('div', { style: pageT }, '项目'),
        el('div', { style: pageSub }, 'scope.yml 授权项目（Program），任务/资产/漏洞的归属主体。'),
        progs.length
          ? el('div', { style: { margin: '12px 0 20px', display: 'flex', flexDirection: 'column', gap: 8 } }, progs)
          : el(EmptyState, { text: '暂无项目' }),
        el('div', { style: { ...pageT, marginTop: 8 } }, '任务'),
        el('div', { style: pageSub }, '编排器派发的任务队列（只读，起任务走对话）。'),
        el(ViewBody, { query: query, emptyText: '暂无任务' }, function (rows) {
          return el('div', { style: { overflowX: 'auto', minWidth: 0, marginTop: 12 } },
            el('table', { style: tableStyle },
              el('colgroup', null,
                el('col', { style: { width: 52 } }),
                el('col', { style: { width: 110 } }),
                el('col', { style: { width: 96 } }),
                el('col', null),
                el('col', { style: { width: 84 } }),
                el('col', { style: { width: 64 } })),
              el('thead', null, el('tr', { style: theadRow },
                el('th', { style: th }, '#'),
                el('th', { style: th }, '项目'),
                el('th', { style: th }, '阶段'),
                el('th', { style: th }, '目标'),
                el('th', { style: th }, '状态'),
                el('th', { style: th }, '优先级'))),
              el('tbody', null, rows.map(function (t) {
                return el('tr', { key: String(t.id), className: 'silksec-row' },
                  el('td', { style: tdMono }, String(t.id)),
                  el('td', { style: td }, t.program_id),
                  el('td', { style: td }, t.phase || '—'),
                  el('td', { style: td }, t.objective),
                  el('td', { style: td }, taskPill(t.status)),
                  el('td', { style: tdMono }, String(t.priority ?? 5)))
              }))))
        }))
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
      var programsState = useRpc(function () { return { endpoint: 'programs' } }, [])
      var boardState = useRpc(function () {
        return activeTab === 'facts' ? { endpoint: 'blackboard' } : null
      }, [activeTab])

      // 四个视图各自的分页查询（状态按 tab 记忆，Modal 关闭即销毁重置）
      var findingsQ = usePagedQuery('findings')
      var assetsQ = usePagedQuery('assets')
      var factsQ = usePagedQuery('facts')
      var tasksQ = usePagedQuery('tasks')

      function withBusy(fn) {
        return function () {
          if (isBusy) return
          setBusy(true)
          Promise.resolve().then(fn).catch(function (e) {
            console.error('[sec-dashboard] 写操作失败:', e)
          }).finally(function () { setBusy(false); findingsQ.reload(); factsQ.reload() })
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
        return el('button', {
          key: t.id, type: 'button', className: 'silksec-tab',
          'data-on': activeTab === t.id ? 'true' : undefined,
          onClick: function () { setTab(t.id) },
        }, t.label)
      }

      var progOpts = programOptions(programsState.data)
      var content = null
      if (activeTab === 'findings') {
        content = el(React.Fragment, null,
          el(Toolbar, {
            query: findingsQ, placeholder: '搜索标题 / 主机 / URL…',
            filters: [
              { key: 'severity', label: '级别', options: Object.keys(SEV_LABEL).map(function (k) { return { v: k, l: SEV_LABEL[k] } }) },
              { key: 'status', label: '状态', options: Object.keys(STATUS_LABEL).map(function (k) { return { v: k, l: STATUS_LABEL[k] } }) },
              { key: 'program_id', label: '项目', options: progOpts },
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
              { key: 'program_id', label: '项目', options: progOpts },
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
              { key: 'program_id', label: '项目', options: progOpts },
            ],
          }),
          el(FactsView, { query: factsQ, board: boardState.data, onDeprecate: onDeprecate, onCorrect: onCorrect, busy: isBusy }))
      } else {
        content = el(React.Fragment, null,
          el(Toolbar, {
            query: tasksQ, placeholder: '搜索任务目标…',
            filters: [
              { key: 'status', label: '状态', options: Object.keys(TASK_STATUS_LABEL).map(function (k) { return { v: k, l: TASK_STATUS_LABEL[k] } }) },
              { key: 'phase', label: '阶段', options: ['recon', 'vuln', 'biz-logic', 'code-audit', 'intranet', 'review'].map(function (c) { return { v: c, l: c } }) },
              { key: 'program_id', label: '项目', options: progOpts },
            ],
          }),
          el(TasksView, { query: tasksQ, programs: programsState.data }))
      }

      return el('div', { style: root },
        el('div', { style: header },
          el('div', null,
            el('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
              el('span', { style: { color: T.brand, display: 'inline-flex' } }, spoolIcon(16)),
              el('div', { style: pageT }, '安全看板')),
            el('div', { style: pageSub }, '全局 · 资产 / 漏洞 / 事实 / 任务 · 打标与事实纠正写入 audit.jsonl'),
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
        statsState.error ? el('div', { style: errorLine }, '统计加载失败: ' + statsState.error) : el(StatsHeader, { stats: statsState.data, onNavigate: setTab }),
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
