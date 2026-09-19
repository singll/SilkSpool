/**
 * @silksec/ui-core — client half (browser bundle)，16-dashboard P0 地基。
 *
 * 看板 UI 原生面的**共享内核**：把旧单体 client 里散落的 token / hooks / 共享组件
 * 提取为跨 bundle require 的稳定面，并新增原子化隔离所需的三件基础设施：
 *
 *   1. 设计令牌引用表（T / F / SEV_COLOR …）——视图零颜色字面量纪律的唯一合法来源。
 *   2. SilksecErrorBoundary（class 组件）——渲染崩溃只炸单面，经 secUiBus 上报
 *      `bus.audit_tail` 口径记录（actor=dashboard + surface 字段）并写
 *      window.__silksecSurfaceHealth（冒烟门禁读取）。
 *   3. secUiBus 客户端微事件服务 + 视图注册表（secDashboardViews 等价物）+ hooks
 *      （useRpc / usePagedQuery，轮询实例可按面独立）。
 *
 * 消费方式（跨 bundle require，官方 inject 语义；theme 插件 require primitives 同路）：
 *   var uiCore = require('@silksec/ui-core')
 *   uiCore.viewRegistry.register({ id, label, order, component })
 *
 * P0 纪律：本包只提供内核，不接管渲染；看板视图由 7 个
 * `@silksec/sec-dashboard-view-<domain>` 独立包登记进注册表（ui-panel 主面板装配）。
 *
 * 视觉遵循丝之歌主题规范（bundles/dsh/doc/silksong-theme-design.md）；本文件除
 * SEV_COLOR 的 `--silksec-sev-*` fallback 外，零颜色字面量。
 */
window.__ModuleLoader__.load({
  id: '@silksec/ui-core',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    var React = require('react')
    var primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    var Modal = (primitives && typeof primitives.Modal === 'function') ? primitives.Modal : null
    var el = React.createElement

    // ── 设计令牌（看板各面唯一令牌源；源自丝之歌主题规范） ──────────
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
      layer3: 'var(--dsw-alias-bg-layer-3)',
      hover: 'var(--dsw-alias-interactive-bg-hover)',
      brand: 'var(--dsw-alias-brand-primary)',
      business: 'var(--dsw-alias-state-business-primary, #5B8DD9)',
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
    var STATUS_CLOSED = ['false_positive', 'dup', 'ignored']
    var CONF_LABEL = { confirmed: '确认', tentative: '待定', deprecated: '废弃' }
    var TASK_STATUS_LABEL = {
      queued: '排队', running: '运行中', blocked: '阻塞', done: '完成', failed: '失败', cancelled: '取消',
    }
    var MEM_CLASS_LABEL = { durable: '长期', ephemeral: '时效', timeline: '时间线' }

    // ── 格式化（自旧单体原样提取） ────────────────────────────────────────────
    function fmtTime(ts) {
      if (!ts) return '—'
      var d = new Date(ts)
      return isNaN(d.getTime()) ? String(ts) : d.toISOString().slice(0, 16).replace('T', ' ')
    }
    function fmtBytes(n) { return n === undefined || n === null ? '—' : String(n) }
    function fmtEvery(sec) {
      if (!sec) return '—'
      if (sec % 86400 === 0) { var d = sec / 86400; return d === 1 ? '每天' : '每 ' + d + ' 天' }
      if (sec % 3600 === 0) { var h = sec / 3600; return h === 1 ? '每小时' : '每 ' + h + ' 小时' }
      if (sec % 60 === 0) return '每 ' + Math.round(sec / 60) + ' 分钟'
      return '每 ' + sec + ' 秒'
    }
    function fmtRel(ts) {
      if (!ts) return ''
      var diff = ts - Date.now()
      var abs = Math.abs(diff)
      var n, unit
      if (abs >= 86400000) { n = Math.round(abs / 86400000); unit = ' 天' }
      else if (abs >= 3600000) { n = Math.round(abs / 3600000); unit = ' 小时' }
      else { n = Math.max(1, Math.round(abs / 60000)); unit = ' 分钟' }
      return diff >= 0 ? n + unit + '后' : n + unit + '前'
    }
    function fmtDur(ms) {
      if (ms === undefined || ms === null) return '—'
      var s = Math.round(ms / 1000)
      if (s < 60) return s + 's'
      var m = Math.floor(s / 60)
      if (m < 60) return m + 'm' + (s % 60 ? (s % 60) + 's' : '')
      return Math.floor(m / 60) + 'h' + (m % 60 ? (m % 60) + 'm' : '')
    }
    function fmtTs(v) {
      if (v === undefined || v === null || v === '') return '—'
      var d = typeof v === 'number' ? new Date(v) : new Date(String(v))
      if (isNaN(d.getTime())) return String(v).slice(0, 16).replace('T', ' ')
      var p = function (n) { return (n < 10 ? '0' : '') + n }
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
    }
    // 千分位（库存副条等大数可读性；非数值原样返回）
    function fmtNum(n) {
      if (n === undefined || n === null) return '—'
      if (typeof n !== 'number' || !isFinite(n)) return String(n)
      return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    }

    // ── 通用内联样式对象（自旧单体原样提取；全部经 T，零颜色字面量） ──────────
    var root = { display: 'flex', flexDirection: 'column', flex: '1 1 auto', minHeight: 0, boxSizing: 'border-box', padding: '18px 22px 0' }
    var header = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', minWidth: 0, marginBottom: 12 }
    var pageT = { color: T.label, ...F.baseStrong }
    var pageSub = { color: T.label3, marginTop: 2, ...F.xxs }
    var silkDivider = { height: 1, margin: '8px 0 0', background: 'linear-gradient(90deg, transparent, ' + T.border3 + ' 20%, ' + T.border3 + ' 80%, transparent)' }
    var tabBar = { display: 'flex', gap: 4, borderBottom: '1px solid ' + T.border, flexWrap: 'wrap', marginBottom: 4 }
    var body = { flex: '1 1 auto', overflowY: 'auto', minHeight: 0, padding: '12px 2px 20px' }
    var card = { padding: '12px 14px', borderRadius: 8, border: '1px solid ' + T.border, background: T.base, minWidth: 0, boxSizing: 'border-box' }
    var cardL = { color: T.label2, ...F.xxs }
    var cardV = { color: T.label, marginTop: 4, fontSize: 20, fontWeight: 600, lineHeight: '24px' }
    var stateLine = { color: T.label3, padding: '24px 0', ...F.s }
    var errorLine = { ...stateLine, color: T.error, padding: '8px 0' }
    var pill = { display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px', borderRadius: 999, fontSize: 12, lineHeight: '16px', border: '1px solid ' + T.border2, color: T.label2, background: 'transparent', flexShrink: 0, whiteSpace: 'nowrap' }
    var th = { textAlign: 'left', color: T.label2, padding: '8px 12px', ...F.xxsStrong, whiteSpace: 'nowrap' }
    // 表格统一单行省略：无论内容多少，行高恒定、列宽由 colgroup 固定，杜绝长 ID/长文本
    // 撑高行或顶破列（19-ui-unify 补丁）。完整内容一律走 cell 的 title 悬停。
    var td = { padding: '8px 12px', color: T.label, ...F.xs, verticalAlign: 'middle', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }
    var tdClosed = { ...td, color: T.label2 }
    var tdMono = { ...td, fontFamily: MONO, fontSize: 13 }
    var tableStyle = { width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }
    var theadRow = { borderBottom: '1px solid ' + T.border3 }
    var toolbar = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', margin: '10px 0 8px' }
    var pagerBar = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 10, color: T.label3, ...F.xxs }
    var styles = {
      root: root, header: header, pageT: pageT, pageSub: pageSub, silkDivider: silkDivider,
      tabBar: tabBar, body: body, card: card, cardL: cardL, cardV: cardV, stateLine: stateLine,
      errorLine: errorLine, pill: pill, th: th, td: td, tdClosed: tdClosed, tdMono: tdMono,
      tableStyle: tableStyle, theadRow: theadRow, toolbar: toolbar, pagerBar: pagerBar,
    }

    // ── 共享控件基样式表（19-ui-unify §2.1/2.2） ─────────────────────────────
    // **唯一合法定义源**：所有 `.silksec-*` 共享控件类（btn/icon-btn/input/tab/kpi/
    // row/chip/dash-dialog）的 CSS 规则只在此处定义。承载面/视图包的本地
    // ensureStyles() 只允许布局类（flex/grid/container-query/高度），禁止定义颜色、
    // 边框、圆角、按钮、输入、tab 样式。apply 时一次性注入，幂等守卫
    // data-plugin-css="silksec-ui-core-base"。零颜色字面量（全部 var(--dsw-*)）。
    var BASE_CSS_KEY = 'silksec-ui-core-base'
    function ensureBaseStyles() {
      try {
        if (typeof document === 'undefined' || !document.head) return
        if (document.querySelector('style[data-plugin-css=' + JSON.stringify(BASE_CSS_KEY) + ']')) return
        var tag = document.createElement('style')
        tag.dataset.plugin = '@silksec/ui-core'
        tag.dataset.pluginCss = BASE_CSS_KEY
        tag.textContent = [
          '.silksec-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:28px;padding:0 12px;border-radius:6px;font:var(--dsw-font-xs-13);background:var(--dsw-alias-button-elevated-fill);color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l2);cursor:pointer;box-sizing:border-box;white-space:nowrap;transition:background-color 150ms ease-out,color 150ms ease-out,border-color 150ms ease-out}',
          '.silksec-btn:hover:not(:disabled){background:var(--dsw-alias-button-floating-hover);color:var(--dsw-alias-label-primary)}',
          '.silksec-btn:disabled{opacity:.45;cursor:not-allowed}',
          '.silksec-btn-confirm{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-button-contrast-fill);border-color:transparent}',
          '.silksec-btn-confirm:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover);color:var(--dsw-alias-button-contrast-fill)}',
          '.silksec-icon-btn{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);border:1px solid transparent;cursor:pointer;box-sizing:border-box;transition:background-color 150ms ease-out,color 150ms ease-out,border-color 150ms ease-out}',
          '.silksec-icon-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
          '.silksec-icon-btn:disabled{opacity:.45;cursor:not-allowed}',
          '.silksec-icon-btn-confirm{color:var(--dsw-alias-brand-primary)}',
          '.silksec-icon-btn-confirm:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-accent);color:var(--dsw-alias-brand-primary)}',
          '.silksec-icon-btn-danger{color:var(--dsw-alias-state-error-primary)}',
          '.silksec-icon-btn-danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary)}',
          '.silksec-input{height:28px;padding:0 10px;border-radius:6px;font:var(--dsw-font-xs-13);background:var(--dsw-specific-input-major);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);box-sizing:border-box;transition:border-color 150ms ease-out}',
          '.silksec-input:focus{border-color:var(--dsw-alias-brand-primary);outline:none}',
          '.silksec-input::placeholder{color:var(--dsw-alias-label-tertiary)}',
          '.silksec-tab{display:inline-flex;align-items:center;height:32px;padding:0 10px;font:var(--dsw-font-xs-13);color:var(--dsw-alias-label-secondary);background:transparent;border:0;border-radius:0;cursor:pointer;transition:color 200ms var(--ds-ease-in-out),box-shadow 200ms var(--ds-ease-in-out)}',
          '.silksec-tab:hover{color:var(--dsw-alias-label-primary)}',
          '.silksec-tab[data-on="true"]{color:var(--dsw-alias-label-primary);box-shadow:inset 0 -2px 0 var(--dsw-alias-brand-primary)}',
          '.silksec-kpi{display:flex;flex-direction:column;align-items:flex-start;text-align:left;gap:2px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:10px 14px;cursor:pointer;font-family:inherit;box-sizing:border-box;transition:background-color 150ms ease-out,border-color 150ms ease-out}',
          '.silksec-kpi:hover{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l3)}',
          '.silksec-row{transition:background-color 150ms ease-out}',
          '.silksec-row:hover{background:var(--dsw-alias-interactive-bg-hover)}',
          '.silksec-chip{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:999px;font-size:12px;line-height:16px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:transparent;cursor:pointer;white-space:nowrap;font-family:inherit;box-sizing:border-box;transition:background-color 150ms ease-out,color 150ms ease-out,border-color 150ms ease-out}',
          '.silksec-chip:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
          '.silksec-chip[data-on="true"]{background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary)}',
          '.silksec-dash-dialog{background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l2);border-radius:12px}',
        ].join('\n')
        document.head.appendChild(tag)
      } catch (e) { /* 样式注入失败不阻断功能 */ }
    }

    // ── 图标（内联 SVG，stroke 1.5，currentColor） ────────────────────────────
    function spoolIcon(size) {
      return el('svg', { width: size || 16, height: size || 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', style: { flexShrink: 0 } },
        el('path', { d: 'M4 2.5h7' }),
        el('path', { d: 'M4 13.5h7' }),
        el('path', { d: 'M5.5 2.5v11M9.5 2.5v11' }),
        el('path', { d: 'M5.5 5.5h4M5.5 8h4M5.5 10.5h4' }),
        el('path', { d: 'M9.5 10.5c3 0.5 3 2.5 4.5 3' }))
    }
    function opIcon(kind, size) {
      var inner
      if (kind === 'confirm') inner = el('path', { d: 'M3.5 8.5l3 3 6-6.5' })
      else if (kind === 'false_positive' || kind === 'close') inner = el(React.Fragment, null, el('path', { d: 'M4.5 4.5l7 7M11.5 4.5l-7 7' }))
      else if (kind === 'jump') inner = el(React.Fragment, null, el('path', { d: 'M6 3.5h7v7' }), el('path', { d: 'M13 3.5L5.5 11' }), el('path', { d: 'M11 8v5H3.5V5.5H8' }))
      else if (kind === 'play') inner = el('path', { d: 'M5 3.5l8 4.5-8 4.5z' })
      else if (kind === 'stop') inner = el('rect', { x: 4.5, y: 4.5, width: 7, height: 7, rx: 1 })
      else if (kind === 'history') inner = el(React.Fragment, null, el('circle', { cx: 8, cy: 8, r: 5.5 }), el('path', { d: 'M8 5.5V8l2 1.5' }))
      else if (kind === 'edit') inner = el(React.Fragment, null, el('path', { d: 'M3.5 12.5l.8-3 6.7-6.7 2.2 2.2-6.7 6.7z' }), el('path', { d: 'M9.7 4.3l2 2' }))
      else if (kind === 'eye') inner = el(React.Fragment, null, el('path', { d: 'M2.5 8s2.2-3.8 5.5-3.8S13.5 8 13.5 8 11.3 11.8 8 11.8 2.5 8 2.5 8z' }), el('circle', { cx: 8, cy: 8, r: 1.5 }))
      else if (kind === 'download') inner = el(React.Fragment, null, el('path', { d: 'M8 3v6.5M5 7l3 3 3-3' }), el('path', { d: 'M3.5 12.5h9' }))
      else if (kind === 'copy') inner = el(React.Fragment, null, el('rect', { x: 5.5, y: 5.5, width: 7, height: 7, rx: 1 }), el('path', { d: 'M10.5 3.5h-7v7' }))
      else if (kind === 'list') inner = el(React.Fragment, null, el('path', { d: 'M5.5 4.5h7M5.5 8h7M5.5 11.5h7' }), el('path', { d: 'M3 4.5h.01M3 8h.01M3 11.5h.01' }))
      else if (kind === 'plus') inner = el('path', { d: 'M8 3.5v9M3.5 8h9' })
      else if (kind === 'trash') inner = el(React.Fragment, null, el('path', { d: 'M3 4.5h10M6.3 4.5V3h3.4v1.5' }), el('path', { d: 'M4.7 4.5l.6 8h5.4l.6-8M8 7v3.5' }))
      else if (kind === 'up') inner = el(React.Fragment, null, el('path', { d: 'M8 12.5V4' }), el('path', { d: 'M4.5 7.5L8 4l3.5 3.5' }))
      else if (kind === 'chev') inner = el('path', { d: 'M4 6l4 4 4-4' })
      else if (kind === 'back') inner = el(React.Fragment, null, el('path', { d: 'M12.5 8H3.5' }), el('path', { d: 'M7 4.5L3.5 8l3.5 3.5' }))
      else if (kind === 'refresh') inner = el(React.Fragment, null, el('path', { d: 'M13 8a5 5 0 1 1-1.6-3.6' }), el('path', { d: 'M13.5 2.5V5.5H10.5' }))
      else inner = el(React.Fragment, null, el('path', { d: 'M2.5 8s2.2-3.8 5.5-3.8S13.5 8 13.5 8 11.3 11.8 8 11.8 2.5 8 2.5 8z' }), el('path', { d: 'M4 13l8-10' }))
      var px = size || 14
      return el('svg', { width: px, height: px, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' }, inner)
    }

    // ── 共享展示件（P6 域视图跨 bundle 复用；全部经 T/F 令牌，零颜色字面量） ────
    // 会话跳链：opener 由持有 sessions 服务的包经 setSessionOpener 注入；缺席渲染「—」。
    var sessionOpener = null
    function setSessionOpener(fn) { sessionOpener = (typeof fn === 'function') ? fn : null }
    function openSession(id) {
      if (!sessionOpener || !id) return
      try { sessionOpener(id) } catch (e) { try { console.error('[silksec/ui-core] openSession 失败:', e) } catch (e2) {} }
    }
    function SessionLink(props) {
      if (!props || !props.id) return el('span', { style: { color: T.label3, ...F.xxxs } }, '—')
      return el('button', {
        type: 'button', className: 'silksec-icon-btn',
        title: '打开来源会话（' + String(props.id).slice(0, 18) + '…）', 'aria-label': '打开来源会话',
        onClick: function () { openSession(props.id) },
      }, opIcon('jump'))
    }
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
    function programCell(pid) {
      if (!pid || pid === '_legacy') {
        return el('span', { style: { color: T.label3, ...F.xxs }, title: '未关联到授权项目（合法未归属或历史数据）' }, '未关联')
      }
      return el('span', { style: F.xs }, pid)
    }
    // 可点即筛的洞察 chip（选中态升一档背景；再点清除）——资产/事实等视图共用。
    // 19-ui-unify §2.2：样式唯一来源 = ui-core 基样式表 `.silksec-chip`；此处只传
    // 语义色（token）与选中态，不再散写 pill+cursor。
    function insightChip(key, value, label, count, color, query, title) {
      var on = query.filters[key] === value
      return el('button', {
        key: key + '|' + value, type: 'button', className: 'silksec-chip',
        'data-on': on ? 'true' : undefined,
        style: color ? { color: color } : undefined,
        title: (title || label) + '：' + count + '（点击' + (on ? '清除' : '筛选') + '）',
        onClick: function () { query.setFilter(key, on ? '' : value) },
      }, label + ' ' + count)
    }
    function sortableTh(label, col, query) {
      if (!col) return el('th', { style: th }, label)
      var active = query.sort === col
      var caret = active ? (query.dir === 'asc' ? ' ↑' : ' ↓') : ''
      return el('th', {
        style: { ...th, cursor: 'pointer', color: active ? T.label : T.label2, userSelect: 'none' },
        title: '点击排序', onClick: function () { query.toggleSort(col) },
      }, label + caret)
    }
    // 搜索词高亮：命中片段丝线金加粗（零依赖 split，React 元素树直构）
    function hlText(text, term, keyBase) {
      var s = String(text == null ? '' : text)
      var t = String(term || '').toLowerCase()
      if (!t) return s
      var lower = s.toLowerCase()
      var out = []
      var i = 0; var k = 0
      while (i <= s.length) {
        var idx = lower.indexOf(t, i)
        if (idx < 0) { out.push(el('span', { key: keyBase + '-e' + (k++) }, s.slice(i))); break }
        if (idx > i) out.push(el('span', { key: keyBase + '-t' + (k++) }, s.slice(i, idx)))
        out.push(el('span', { key: keyBase + '-m' + (k++), style: { color: T.warn, fontWeight: 600 } }, s.slice(idx, idx + t.length)))
        i = idx + t.length
      }
      return out
    }

    // ── 微事件总线 secUiBus（跨面信号；发布/订阅互不知晓，缺席即无操作） ────────
    function createSecUiBus() {
      var handlers = Object.create(null)
      function on(name, fn) {
        if (typeof name !== 'string' || typeof fn !== 'function') throw new Error('secUiBus.on: name/fn 必填')
        var list = handlers[name] || (handlers[name] = [])
        list.push(fn)
        return function () { return off(name, fn) }
      }
      function off(name, fn) {
        var list = handlers[name]
        if (!list) return false
        var i = list.indexOf(fn)
        if (i < 0) return false
        list.splice(i, 1)
        if (!list.length) delete handlers[name]
        return true
      }
      function emit(name, payload) {
        var list = handlers[name]
        if (!list || !list.length) return 0
        list.slice().forEach(function (fn) {
          try { fn(payload) } catch (e) { try { console.error('[silksec/ui-core] secUiBus handler 异常 (' + name + '):', e) } catch (e2) {} }
        })
        return list.length
      }
      function clear(name) { if (name === undefined) handlers = Object.create(null); else delete handlers[name] }
      function count(name) { return name === undefined ? Object.keys(handlers).length : (handlers[name] || []).length }
      return { on: on, off: off, emit: emit, clear: clear, count: count }
    }
    var secUiBus = createSecUiBus()

    // ── surface 错误上报（bus.audit_tail 口径 + surface 字段） ────────────────
    // 记录形状对齐 bus.audit_tail 行：actor=dashboard / tool / decision / error_code，
    // 额外携带 surface 以便审计按「面」过滤。P0 不改数据层，落盘通道由宿主后续接线，
    // 本包只负责：结构化记录 + console + secUiBus 广播 + window.__silksecSurfaceHealth 打卡。
    var surfaceErrorReporter = null
    function setSurfaceErrorReporter(fn) { surfaceErrorReporter = typeof fn === 'function' ? fn : null }
    function markSurfaceHealth(surface, status, detail) {
      try {
        var w = (typeof window !== 'undefined') ? window : null
        if (!w) return null
        var h = w.__silksecSurfaceHealth || (w.__silksecSurfaceHealth = {})
        h[surface || 'unknown'] = { status: status || 'ok', ts: Date.now(), detail: detail || null }
        return h[surface || 'unknown']
      } catch (e) { return null }
    }
    function buildSurfaceErrorRecord(surface, error, info) {
      return {
        ts: Date.now(),
        kind: 'ui.surface_error',
        actor: 'dashboard',
        surface: surface || 'unknown',
        tool: 'ui-core.error-boundary',
        decision: 'failed',
        error_code: 'E_UI_SURFACE',
        message: error && error.message ? String(error.message) : String(error),
        stack: error && error.stack ? String(error.stack).slice(0, 2000) : null,
        component_stack: info && info.componentStack ? String(info.componentStack).slice(0, 2000) : null,
      }
    }
    function reportSurfaceError(surface, error, info) {
      var record = buildSurfaceErrorRecord(surface, error, info)
      markSurfaceHealth(surface, 'degraded', record.message)
      secUiBus.emit('error:surface', record)
      try { console.error('[silksec/ui-core] surface 崩溃:', record) } catch (e) {}
      if (surfaceErrorReporter) { try { surfaceErrorReporter(record) } catch (e) {} }
      return record
    }

    // ── 共享组件（自旧单体原样提取） ─────────────────────────────────────────
    function EmptyState(props) {
      return el('div', { style: { ...stateLine, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, padding: '36px 0' } },
        el('span', { style: { color: T.label3 } }, spoolIcon(24)),
        el('span', null, props.filtered ? '无匹配结果' : (props.text || '暂无数据')))
    }
    function SkeletonRows(props) {
      var rows = []
      for (var i = 0; i < (props.rows || 5); i++) {
        rows.push(el('div', { key: i, style: { height: 14, borderRadius: 4, background: T.skeleton, margin: '10px 8px', width: (88 - i * 7) + '%' } }))
      }
      return el('div', { style: { padding: '8px 0' } }, rows)
    }
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
        }),
        props.extra ? el('span', { style: { marginLeft: 'auto', display: 'inline-flex', gap: 8 } }, props.extra) : null)
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
    function ViewBody(props) {
      var query = props.query
      if (query.error) return el('div', { style: errorLine }, '加载失败: ' + query.error)
      if (query.rows === null) return el(SkeletonRows, null)
      if (!query.rows.length) return el(EmptyState, { filtered: query.filtered, text: props.emptyText })
      return el(React.Fragment, null, props.children(query.rows), el(Pager, { query: query }))
    }
    // 极简 markdown（报告/文档查看器用；自旧单体原样提取）
    function mdInline(text, keyBase) {
      return String(text).split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map(function (p, i) {
        if (/^\*\*[^*]+\*\*$/.test(p)) return el('strong', { key: keyBase + '-b' + i, style: { color: T.label, fontWeight: 600 } }, p.slice(2, -2))
        if (/^`[^`]+`$/.test(p)) return el('code', { key: keyBase + '-c' + i, style: { fontFamily: MONO, fontSize: 12, background: T.layer2, borderRadius: 4, padding: '1px 5px' } }, p.slice(1, -1))
        return el('span', { key: keyBase + '-t' + i }, p)
      })
    }
    function mdBlocks(src) {
      var lines = String(src || '').split('\n')
      var out = []
      var para = []
      var i = 0
      function flushPara() {
        if (!para.length) return
        out.push(el('div', { key: 'p' + out.length, style: { color: T.label2, ...F.xs, lineHeight: '22px', marginBottom: 8, wordBreak: 'break-word' } }, mdInline(para.join(' '), 'p' + out.length)))
        para = []
      }
      while (i < lines.length) {
        var line = lines[i]
        var m = line.match(/^(#{1,4})\s+(.*)$/)
        if (m) {
          flushPara()
          var sizes = [F.baseStrong, F.sStrong, F.sStrong, F.xxsStrong]
          out.push(el('div', { key: 'h' + out.length, style: { ...sizes[m[1].length - 1], color: T.label, margin: '12px 0 6px' } }, mdInline(m[2], 'h' + out.length)))
          i++; continue
        }
        if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) { flushPara(); out.push(el('div', { key: 'hr' + out.length, style: silkDivider })); i++; continue }
        if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
          flushPara()
          var cells = function (l) { return l.trim().replace(/^\||\|$/g, '').split('|').map(function (c) { return c.trim() }) }
          var head = cells(line)
          i += 2
          var bodyRows = []
          while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { bodyRows.push(cells(lines[i])); i++ }
          out.push(el('div', { key: 'tbl' + out.length, style: { overflowX: 'auto', minWidth: 0, marginBottom: 10 } },
            el('table', { style: tableStyle },
              el('thead', null, el('tr', { style: theadRow }, head.map(function (h, ci) { return el('th', { key: ci, style: th }, mdInline(h, 'th' + ci)) }))),
              el('tbody', null, bodyRows.map(function (row, ri) {
                return el('tr', { key: ri, className: 'silksec-row' }, row.map(function (c, ci) { return el('td', { key: ci, style: { ...td, ...F.xxs } }, mdInline(c, 'td' + ri + '-' + ci)) }))
              })))))
          continue
        }
        if (/^\s*[-*]\s+/.test(line)) {
          flushPara()
          var items = []
          while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*[-*]\s+/, '')); i++ }
          out.push(el('ul', { key: 'ul' + out.length, style: { margin: '0 0 10px 18px', padding: 0, color: T.label2, ...F.xs, lineHeight: '22px' } },
            items.map(function (it, ii) { return el('li', { key: ii, style: { marginBottom: 2 } }, mdInline(it, 'li' + ii)) })))
          continue
        }
        if (line.trim() === '') { flushPara(); i++; continue }
        para.push(line)
        i++
      }
      flushPara()
      return out
    }
    function DocModal(props) {
      if (!Modal) return null
      var s = props.state || {}
      function download() {
        try {
          var blob = new Blob([s.content || ''], { type: 'text/markdown' })
          var url = URL.createObjectURL(blob)
          var a = document.createElement('a')
          a.href = url
          a.download = s.file ? String(s.file).split('/').pop() : 'silksec-report.md'
          document.body.appendChild(a); a.click(); document.body.removeChild(a)
          setTimeout(function () { URL.revokeObjectURL(url) }, 1000)
        } catch (e) { try { window.alert('下载失败: ' + (e && e.message ? e.message : e)) } catch (e2) {} }
      }
      function copy() { try { navigator.clipboard.writeText(s.content || '') } catch (e) {} }
      return el(Modal, { open: !!props.open, onClose: props.onClose, title: props.title || '报告', headless: true, className: 'silksec-dash-dialog' },
        el('div', { style: { ...root, padding: '18px 22px 16px' } },
          el('div', { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
            el('span', { style: { color: T.brand, display: 'inline-flex' } }, spoolIcon(16)),
            el('div', { style: pageT, title: s.file || '' }, props.title || '报告'),
            (s.total !== undefined && !s.loading && !s.error) ? el('span', { style: pill }, '合计 ' + s.total) : null,
            s.truncated ? el('span', { style: { ...pill, color: T.warn }, title: '超过 300KB 截断显示，完整内容请下载' }, '已截断') : null,
            el('span', { style: { marginLeft: 'auto', display: 'inline-flex', gap: 6 } },
              el('button', { type: 'button', className: 'silksec-icon-btn', disabled: !s.content, title: '复制 markdown 到剪贴板', 'aria-label': '复制', onClick: copy }, opIcon('copy')),
              el('button', { type: 'button', className: 'silksec-icon-btn', disabled: !s.content, title: '下载 .md 文件', 'aria-label': '下载', onClick: download }, opIcon('download')),
              el('button', { type: 'button', className: 'silksec-icon-btn', title: '关闭', 'aria-label': '关闭', onClick: props.onClose }, opIcon('close')))),
          props.sub ? el('div', { style: pageSub }, props.sub) : null,
          el('div', { style: silkDivider }),
          el('div', { style: { flex: '1 1 auto', overflowY: 'auto', marginTop: 12, minHeight: 0 } },
            s.loading
              ? el(SkeletonRows, { rows: 8 })
              : s.error
                ? el('div', { style: errorLine }, (props.errorPrefix || '加载') + '失败: ' + s.error)
                : el('div', { style: { padding: '4px 6px 12px', background: T.layer1, borderRadius: 8, border: '1px solid ' + T.border } },
                    (s.content || '').trim() ? mdBlocks(s.content) : el('span', { style: { color: T.label3, ...F.xs } }, '（空）')))))
    }

    // ── 渲染隔离：SilksecErrorBoundary（React 错误边界只能 class） ─────────────
    // 崩溃 → 只渲染该面的 EmptyState 兜底 + 上报（surface 字段），不冒泡宿主树。
    function createErrorBoundary(Fallback) {
      var ES = Fallback || EmptyState
      return class SilksecErrorBoundary extends React.Component {
        constructor(props) {
          super(props)
          this.state = { failed: false, error: null }
        }
        static getDerivedStateFromError(error) {
          return { failed: true, error: error }
        }
        componentDidCatch(error, info) {
          reportSurfaceError(this.props && this.props.surface, error, info)
        }
        render() {
          if (this.state.failed) {
            var msg = this.state.error && this.state.error.message ? this.state.error.message : '未知错误'
            return el('div', { style: { padding: '12px 14px' } },
              el(ES, { text: (this.props && this.props.title ? this.props.title + '：' : '') + '此面渲染失败（' + msg + '），其他面不受影响' }))
          }
          return this.props ? this.props.children : null
        }
      }
    }
    var SilksecErrorBoundary = createErrorBoundary(EmptyState)

    // ── 视图注册表（secDashboardViews 等价物） ───────────────────────────────
    // 16-dashboard §1.1 协议 + 16-dashboard §3.1 拆分（ui-core 持注册表）。
    // 注册/卸载幂等；动态订阅供晚注册视图触发重渲染。
    // requires 能力降级（§六.3）：条目的 required 服务经 probe 判定，缺席者不进
    // list()/get()（tab 静默隐藏，不抛、不占 order）；probe 由 ui-core apply 绑定 ctx.get。
    var serviceProbe = function () { return true }
    function setServiceProbe(fn) { serviceProbe = (typeof fn === 'function') ? fn : function () { return true } }
    function entryAvailable(entry) {
      var req = entry && entry.requires
      if (!req || !req.length) return true
      for (var i = 0; i < req.length; i++) {
        var ok = false
        try { ok = !!serviceProbe(req[i]) } catch (e) { ok = false }
        if (!ok) return false
      }
      return true
    }
    function createViewRegistry() {
      var entries = Object.create(null)
      var listeners = []
      function snapshot() {
        return Object.keys(entries).map(function (k) { return entries[k] })
          .filter(entryAvailable)
          .sort(function (a, b) { return (a.order || 0) - (b.order || 0) })
      }
      function notify() {
        var list = snapshot()
        listeners.slice().forEach(function (fn) {
          try { fn(list) } catch (e) { try { console.error('[silksec/ui-core] viewRegistry listener 异常:', e) } catch (e2) {} }
        })
      }
      function register(desc) {
        if (!desc || !desc.id) throw new Error('secDashboardViews.register: id 必填')
        if (typeof desc.component !== 'function') throw new Error('secDashboardViews.register: component 必填（' + desc.id + '）')
        entries[desc.id] = {
          id: desc.id,
          label: desc.label || desc.id,
          order: desc.order === undefined ? 100 : desc.order,
          badge: desc.badge || null,
          component: desc.component,
          requires: desc.requires || [],
          domain: desc.domain || null,
          source: desc.source || null,
          // 19-ui-unify §3.2：频次分层（缺省 primary，兼容旧视图包）。'more' 组由
          // 主面板收敛进「更多」二级导航；旧包无此字段全部落 primary，行为不变。
          group: desc.group === 'more' ? 'more' : 'primary',
        }
        notify()
        return function () { return unregister(desc.id, desc) }
      }
      function unregister(id, desc) {
        var cur = entries[id]
        if (!cur) return false
        // 陈旧 disposer 不得误删后来者的注册（HMR/重注册安全）
        if (desc && typeof desc.component === 'function' && cur.component !== desc.component) return false
        delete entries[id]
        notify()
        return true
      }
      function get(id) { var e = entries[id]; return (e && entryAvailable(e)) ? e : null }
      function has(id) { return !!get(id) }
      function subscribe(fn) {
        listeners.push(fn)
        return function () { listeners = listeners.filter(function (f) { return f !== fn }) }
      }
      return {
        register: register, unregister: unregister, list: snapshot, get: get, has: has,
        subscribe: subscribe, refresh: notify,
        size: function () { return snapshot().length },
      }
    }
    var viewRegistry = createViewRegistry()

    // ── 数据 hooks（自旧单体提取；rpc 调用可注入，轮询实例按面独立） ──────────
    var POLL_MS = 30000
    var rpcCaller = null
    function setRpcCaller(fn) { rpcCaller = typeof fn === 'function' ? fn : null }
    function defaultCallRpc(endpoint, payload) {
      if (typeof rpcCaller !== 'function') return Promise.reject(new Error('连接通道不可用'))
      return rpcCaller(endpoint, payload || {})
    }
    function makeCaller(call) { return typeof call === 'function' ? call : defaultCallRpc }

    function useRpc(action, deps, call) {
      var caller = makeCaller(call)
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
          caller(a.endpoint, a.payload).then(function (json) {
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

    function usePagedQuery(endpoint, active, initialFilters, call) {
      var caller = makeCaller(call)
      var qs = React.useState('')
      var q = qs[0]; var setQ = qs[1]
      var dqs = React.useState('')
      var dq = dqs[0]; var setDq = dqs[1]
      var fs = React.useState(initialFilters || {})
      var filters = fs[0]; var setFilters = fs[1]
      var ps = React.useState(0)
      var page = ps[0]; var setPage = ps[1]
      var ss = React.useState(20)
      var size = ss[0]; var setSize = ss[1]
      var sos = React.useState({ sort: '', dir: '' })
      var sortState = sos[0]; var setSortState = sos[1]
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
          if (sortState.sort) { payload.sort = sortState.sort; payload.dir = sortState.dir }
          return caller(endpoint, payload).then(function (res) {
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
      }, [endpoint, active, dq, JSON.stringify(filters), page, size, tick, JSON.stringify(sortState)])

      function setFilter(key, value) {
        setFilters(function (prev) {
          var next = { ...prev }
          if (value) next[key] = value; else delete next[key]
          return next
        })
        setPage(0)
      }
      function toggleSort(col) {
        if (!col) return
        setSortState(function (prev) {
          if (prev.sort !== col) return { sort: col, dir: 'desc' }
          if (prev.dir === 'desc') return { sort: col, dir: 'asc' }
          return { sort: '', dir: '' }
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
        sort: sortState.sort, dir: sortState.dir, toggleSort: toggleSort,
        rows: result.rows, total: result.total, loading: result.loading, error: result.error,
        filtered: !!(dq || Object.keys(filters).length),
        reset: reset, reload: reload, refresh: refresh,
      }
    }

    // ── cordis 客户端插件（提供跨面服务） ────────────────────────────────────
    exports.name = 'silksec-ui-core'
    exports.inject = ['slots']
    exports.apply = function (ctx) {
      // 共享控件基样式表：apply 时一次性注入（幂等）。这是全部 `.silksec-*` 共享控件类
      // 的唯一合法 CSS 定义源（19-ui-unify §2.1）；各承载面只允许布局类。
      ensureBaseStyles()
      // provide 失败（旧宿主/服务名冲突）不抛出：require 侧仍可经 module.exports 取到同一实例。
      try { ctx.provide('secDashboardViews', viewRegistry) } catch (e) {}
      try { ctx.provide('secUiBus', secUiBus) } catch (e) {}
      // requires 能力探测绑定 cordis ctx（能力探测而非版本判断；§六.3）：
      // 域视图 requires:['connection'] 等服务缺席 → list() 过滤该 tab（静默隐藏）。
      setServiceProbe(function (name) {
        try { return !!ctx.get(name) } catch (e) { return false }
      })
      // 冒烟门禁打卡（16-dashboard §2.6）：无头渲染读 window.__silksecSurfaceHealth
      markSurfaceHealth('ui-core', 'ok')
    }

    // ── 跨 bundle require 的稳定导出面 ───────────────────────────────────────
    exports.T = T; exports.F = F; exports.MONO = MONO; exports.EASE = EASE
    exports.SEV_COLOR = SEV_COLOR; exports.SEV_LABEL = SEV_LABEL
    exports.STATUS_LABEL = STATUS_LABEL; exports.STATUS_CLOSED = STATUS_CLOSED
    exports.CONF_LABEL = CONF_LABEL; exports.TASK_STATUS_LABEL = TASK_STATUS_LABEL
    exports.MEM_CLASS_LABEL = MEM_CLASS_LABEL
    exports.styles = styles
    exports.fmtTime = fmtTime; exports.fmtBytes = fmtBytes; exports.fmtEvery = fmtEvery
    exports.fmtRel = fmtRel; exports.fmtDur = fmtDur; exports.fmtTs = fmtTs
    exports.fmtNum = fmtNum
    exports.spoolIcon = spoolIcon; exports.opIcon = opIcon; exports.mdBlocks = mdBlocks
    exports.ensureBaseStyles = ensureBaseStyles; exports.BASE_CSS_KEY = BASE_CSS_KEY
    exports.EmptyState = EmptyState; exports.SkeletonRows = SkeletonRows
    exports.Toolbar = Toolbar; exports.Pager = Pager; exports.ViewBody = ViewBody
    exports.DocModal = DocModal
    // P6 共享展示件（域视图跨 bundle 复用）
    exports.SessionLink = SessionLink
    exports.setSessionOpener = setSessionOpener
    exports.openSession = openSession
    exports.sevPill = sevPill; exports.statusPill = statusPill
    exports.confPill = confPill; exports.taskPill = taskPill
    exports.programCell = programCell; exports.insightChip = insightChip
    exports.sortableTh = sortableTh; exports.hlText = hlText
    exports.setServiceProbe = setServiceProbe
    exports.SilksecErrorBoundary = SilksecErrorBoundary
    exports.createErrorBoundary = createErrorBoundary
    exports.reportSurfaceError = reportSurfaceError
    exports.buildSurfaceErrorRecord = buildSurfaceErrorRecord
    exports.setSurfaceErrorReporter = setSurfaceErrorReporter
    exports.markSurfaceHealth = markSurfaceHealth
    exports.createSecUiBus = createSecUiBus
    exports.secUiBus = secUiBus
    exports.createViewRegistry = createViewRegistry
    exports.viewRegistry = viewRegistry
    exports.setRpcCaller = setRpcCaller
    exports.useRpc = useRpc
    exports.usePagedQuery = usePagedQuery
    exports.POLL_MS = POLL_MS

    return module.exports
  },
})
