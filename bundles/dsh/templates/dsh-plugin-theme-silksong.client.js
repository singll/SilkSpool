/**
 * @silksec/theme-silksong — client half (browser bundle).
 *
 * 丝之歌主题（设计规范：bundles/dsh/doc/silksong-theme-design.md）。
 * 经 DSH 原生 theme registry 注册全局深色主题「silksong」：
 *   - ctx.theme.register({ id, colorScheme:'dark', tokens }) —— presenter 把 tokens
 *     以 inline CSS 变量写到 <body>，覆盖一切吃 --dsw-alias-* 的原生组件（整站一致）。
 *   - severity 五色不在 registry 白名单内：监听 theme/change，silksong 激活时注入
 *     --silksec-sev-* <style>，切走时移除（看板消费方带 fallback，零耦合）。
 *   - 宿主 user-settings 只收内置三态（light/dark/system），自定义主题选择由本插件
 *     经 localStorage（silksec.theme.choice）持久化：首装默认启用；用户在内置
 *     「外观」行切走后尊重其选择；设置→通用提供「丝之歌主题」开关行可切回。
 */
window.__ModuleLoader__.load({
  id: '@silksec/theme-silksong',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    var React = require('react')
    var el = React.createElement

    var THEME_ID = 'silksong'
    var LS_KEY = 'silksec.theme.choice' // 'silksong' | 'host'（用户切走内置）

    // ── 调色板：叙事四色（规范 §2.1，令牌层权威值，不引用 --dsw-static-*） ──────
    var TOKENS = {
      // 背景层（Pharloom 之夜）
      '--dsw-alias-bg-base': '#0D1113',
      '--dsw-alias-bg-layer-1': '#141A1D',
      '--dsw-alias-bg-layer-2': '#1B2328',
      '--dsw-alias-bg-layer-3': '#243037',
      '--dsw-alias-bg-overlay': '#1B2328',
      '--dsw-alias-bg-module-platform': '#243037',
      '--dsw-alias-bg-multi-select': '#243037',
      '--dsw-alias-bg-skeleton': 'rgba(230,224,212,0.06)',
      '--dsw-alias-bg-mask-1': 'rgba(6,9,10,0.6)',
      '--dsw-alias-bg-mask-2': 'rgba(6,9,10,0.2)',
      '--dsw-alias-bg-mask-3': 'rgba(6,9,10,0.6)',
      '--dsw-alias-bg-mask-drop': 'rgba(20,26,29,0.7)',
      // 文字层（骨白系）
      '--dsw-alias-label-primary': '#E6E0D4',
      '--dsw-alias-label-secondary': '#A89F90',
      '--dsw-alias-label-tertiary': '#6E6A60',
      '--dsw-alias-label-caption': '#6E6A60',
      '--dsw-alias-label-dimmed': '#8A8578',
      '--dsw-alias-label-primary-bluish': '#E6E0D4',
      '--dsw-alias-label-primary-dimmed': '#A89F90',
      '--dsw-alias-label-primary-foreground': '#0D1113',
      '--dsw-alias-label-primary-inverted': '#1B2328',
      // 边框（暖灰青，三级）
      '--dsw-alias-border-l1': '#2A3136',
      '--dsw-alias-border-l2': '#333C42',
      '--dsw-alias-border-l2-darkmode-thin': '#2A3136',
      '--dsw-alias-border-l3': '#41505A',
      '--dsw-alias-border-l4': '#4E5C66',
      '--dsw-alias-border-inverted': 'rgba(230,224,212,0.06)',
      '--dsw-alias-border-inverted2': 'rgba(230,224,212,0.08)',
      // Hornet 绯红（唯一行动色）
      '--dsw-alias-brand-primary': '#C8403F',
      '--dsw-alias-brand-text': '#E6E0D4',
      '--dsw-alias-brand-primary-invert': '#E6E0D4',
      '--dsw-alias-brand-primary-new-colorprimary-new-color': '#C8403F',
      '--dsw-alias-button-primary-fill': '#C8403F',
      '--dsw-alias-button-primary-hover': '#D65453',
      '--dsw-alias-button-primary-dimmed': '#243037',
      '--dsw-alias-button-info-fill': '#4E8C84',
      '--dsw-alias-button-info-hover': '#5FA39A',
      '--dsw-alias-button-contrast-fill': '#E6E0D4',
      '--dsw-alias-button-elevated-fill': '#1B2328',
      '--dsw-alias-button-floating-fill': '#1B2328',
      '--dsw-alias-button-floating-hover': '#243037',
      '--dsw-alias-button-ghost-active-border': '#41505A',
      '--dsw-alias-button-ghost-active-fill': '#1B2328',
      '--dsw-alias-button-ghost-active-hover': '#243037',
      '--dsw-alias-button-tool-bar-fill': 'rgba(65,80,90,0.5)',
      '--dsw-alias-button-tool-bar-hover': 'rgba(65,80,90,0.6)',
      '--dsw-alias-button-tool-bar-fill-invisible': 'rgba(20,26,29,0.4)',
      // 状态（丝线金=警告 / 苔绿=成功 / 青碧=信息 / 绯红变体=错误）
      '--dsw-alias-state-warn-primary': '#D4A24C',
      '--dsw-alias-state-warn-label': '#D4A24C',
      '--dsw-alias-state-warn-secondary': '#E0B567',
      '--dsw-alias-state-warn-tertiary': '#2A2416',
      '--dsw-alias-state-success-primary': '#7A9B6A',
      '--dsw-alias-state-success-secondary': '#8FB07D',
      '--dsw-alias-state-success-tertiary': '#1B2418',
      '--dsw-alias-state-business-primary': '#4E8C84',
      '--dsw-alias-state-business-tertiary': '#16211F',
      '--dsw-alias-state-error-primary': '#D24848',
      '--dsw-alias-state-error-secondary': '#E05555',
      '--dsw-alias-interactive-bg-hover-danger': 'rgba(210,72,72,0.12)',
      // 交互
      '--dsw-alias-interactive-bg-hover': 'rgba(230,224,212,0.06)',
      '--dsw-alias-interactive-bg-active': 'rgba(230,224,212,0.10)',
      '--dsw-alias-interactive-bg-hover-accent': 'rgba(200,64,63,0.14)',
      '--dsw-alias-interactive-bg-hover-solid': '#1B2328',
      // markdown 系列（全部映射到 layer 三档，不引入新色）
      '--dsw-alias-markdown-code-block': '#11171A',
      '--dsw-alias-markdown-code-block-banner': '#141A1D',
      '--dsw-alias-markdown-inline-code': '#1B2328',
      '--dsw-alias-markdown-citation': '#243037',
      '--dsw-alias-markdown-code-segment-selected': '#243037',
      '--dsw-alias-markdown-code-segment-unselected': '#11171A',
      '--dsw-alias-markdown-placeholder': '#1B2328',
      '--dsw-alias-markdown-tag': '#1B2328',
      // 滚动条 / toast / tooltip
      '--dsw-alias-scrollbar-bg-l1': '#333C42',
      '--dsw-alias-scrollbar-bg-l2': '#333C42',
      '--dsw-alias-scrollbar-hover-l1': '#41505A',
      '--dsw-alias-scrollbar-hover-l2': '#41505A',
      '--dsw-alias-toast-bg': '#243037',
      '--dsw-alias-tooltip-bg': '#243037',
      // specific（侧边栏 / 菜单 / 输入 / 气泡）
      '--dsw-specific-sidebar-fill': '#11171A',
      '--dsw-specific-sidebar-nav-item-hover': '#1B2328',
      '--dsw-specific-sidebar-nav-item-active': '#243037',
      '--dsw-specific-sidebar-nav-item-active-accent': '#C8403F',
      '--dsw-specific-menu': '#243037',
      '--dsw-specific-input-major': '#1B2328',
      '--dsw-specific-login-input': '#141A1D',
      '--dsw-specific-selector': '#1B2328',
      '--dsw-specific-tip': '#1B2328',
      '--dsw-specific-bubble': '#1B2328',
      '--dsw-specific-bubble-highlight': '#243037',
    }

    // ── severity 五色（registry 白名单外，silksong 激活时经 <style> 插拔） ──────
    var SEV_CSS = ':root{--silksec-sev-critical:#E05555;--silksec-sev-high:#D4743A;--silksec-sev-medium:#D4A24C;--silksec-sev-low:#4E8C84;--silksec-sev-info:#8A8578}'
    var SEV_KEY = 'silksec-sev'

    function setSevStyle(on) {
      var existing = document.querySelector('style[data-plugin-css=' + JSON.stringify(SEV_KEY) + ']')
      if (on && !existing) {
        var tag = document.createElement('style')
        tag.dataset.plugin = '@silksec/theme-silksong'
        tag.dataset.pluginCss = SEV_KEY
        tag.textContent = SEV_CSS
        document.head.appendChild(tag)
      } else if (!on && existing) {
        existing.remove()
      }
    }

    function lsGet() { try { return window.localStorage.getItem(LS_KEY) } catch (e) { return null } }
    function lsSet(v) { try { window.localStorage.setItem(LS_KEY, v) } catch (e) { /* 隐私模式降级：仅本次会话生效 */ } }

    // ── 设置行（settings.general.item）：丝之歌主题开关 ────────────────────────
    function SilksongRow(props) {
      var api = props.silksong
      var state = React.useState(api.getEnabled())
      var enabled = state[0]
      var setEnabled = state[1]
      React.useEffect(function () {
        return api.subscribe(function (v) { setEnabled(v) })
      }, [])
      var btn = {
        padding: '3px 12px', borderRadius: 999, cursor: 'pointer', fontSize: 12, lineHeight: '18px',
        border: '1px solid ' + (enabled ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l2)'),
        background: enabled ? 'var(--dsw-alias-brand-primary)' : 'transparent',
        color: enabled ? 'var(--dsw-alias-brand-text)' : 'var(--dsw-alias-label-secondary)',
        transition: 'background-color 150ms ease-out,color 150ms ease-out,border-color 150ms ease-out',
      }
      return el('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '4px 0' } },
        el('span', { style: { color: 'var(--dsw-alias-label-primary)', fontSize: 14 } }, '丝之歌主题'),
        el('button', { type: 'button', style: btn, 'aria-pressed': enabled, onClick: function () { api.toggle() } },
          enabled ? '已开启' : '已关闭'))
    }

    exports.name = '@silksec/theme-silksong'
    exports.inject = ['slots', 'theme']
    exports.apply = function (ctx) {
      var theme = ctx.get('theme')
      if (!theme || typeof theme.register !== 'function') return
      var slots = ctx.get('slots')

      // 1. 注册主题（presenter 应用 tokens 到 <body> inline 变量）
      theme.register({ id: THEME_ID, colorScheme: 'dark', tokens: TOKENS })

      // 2. severity 样式跟随主题激活态插拔
      function isSilksong(snapshot) { return snapshot.active.id === THEME_ID }
      ctx.on('theme/change', function (snapshot) { setSevStyle(isSilksong(snapshot)) })
      setSevStyle(isSilksong(theme.getTheme()))

      // 3. 选择持久化与首装默认启用
      var choice = lsGet()
      if (choice === null || choice === THEME_ID) {
        theme.setTheme(THEME_ID)
        if (choice === null) lsSet(THEME_ID)
      }
      // 用户经内置「外观」行切走（light/dark/system）→ 记录 'host'，不再自动切回
      ctx.on('theme/change', function (snapshot) {
        var p = snapshot.preference
        if ((p === 'light' || p === 'dark' || p === 'system') && lsGet() === THEME_ID) lsSet('host')
      })

      // 4. 设置→通用：丝之歌主题开关行（切回路径；defineStore 不在 seed 模块内，
      //    经 inject 传普通回调 + React state 订阅）
      if (slots && typeof slots.inject === 'function' && typeof slots.register === 'function') {
        var listeners = []
        function notify() {
          var v = isSilksong(theme.getTheme())
          listeners.forEach(function (fn) { fn(v) })
        }
        ctx.on('theme/change', notify)
        var rowApi = {
          getEnabled: function () { return isSilksong(theme.getTheme()) },
          subscribe: function (fn) { listeners.push(fn); return function () { listeners = listeners.filter(function (f) { return f !== fn }) } },
          toggle: function () {
            if (isSilksong(theme.getTheme())) { theme.setTheme('dark'); lsSet('host') }
            else { theme.setTheme(THEME_ID); lsSet(THEME_ID) }
          },
        }
        slots.inject('settings.general.item', function () {
          return slots.register({
            name: 'settings.general.item',
            id: 'silksong-theme',
            order: 11,
            inject: function () { return { silksong: rowApi } },
          }, SilksongRow)
        })
      }
    }

    return module.exports
  },
})
