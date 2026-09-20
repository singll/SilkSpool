/**
 * @silksec/ui-settings-scope — client half (browser bundle)，16-dashboard P4 授权迁设置页。
 *
 * 把授权域（scope）从主面板旧 tab 迁到 DSH 原生设置页：
 *   `settings.section`（list，root）注册「授权范围」**整节**——program 列表
 *   （工作区徽章 / max_risk / 条目数）、scope.yml 条目管理（新增/编辑/移除）、
 *   排除清单管理、凭据引用状态。设置页骨架/滚动/键盘可达性/主题全部宿主原生。
 *
 * 官方契约以 DSH 0.1.5-rc.2 类型声明逐字核对
 * （@deepseek-ai/dsh-client-ui-settings/lib/types/client/contract/slots.d.ts）：
 *   - `settings.section` kind=list scope=root；注册项 options 携带导航身份
 *     `id`（section key）/`order`/`label`（registrant-localized 文案）；
 *   - owner props = `SettingsSectionOwnerProps = { close: () => void }`
 *     （section 数据经自己的 inject face/服务取，shell 只给 close）；
 *   - shell（ui-settings-general）在内容列渲染 active section：
 *     `renderSlot("settings.section", { close }, { only: activeId })`。
 *
 * 写操作与主面板「授权」tab 等价（同一 /silksec-dashboard 端点、actor=dashboard +
 * operator 由 RpcProjector/壳注入、audit 留痕一致）：
 *   - 列表      scopeList
 *   - 新增/编辑 scopeSaveProgram（内部按表单字段分派 scope.grant + scope.exclude）
 *   - 移除      scopeDeleteProgram（scope.revoke，fail-closed 立即生效）
 *   - 绑定工作区 programBindWorkspace（scope.program_bind_workspace）
 *   - 凭据引用  scope.cred_query（RpcProjector /silksec-domain 只读；只显示 ref，永不明文）
 *
 * 降级链（§六.3）：
 *   settings.section 缺席 → 同一视图注册 ui-core 注册表（主面板「授权 ·降级」临时 tab）
 *     主面板/layout 也缺席 → primitives Modal（再缺席自绘 fixed 覆盖层）
 *   主面板 id='scope' 旧 tab 行为零改动、保留观察（P4 不删）。
 *
 * 隔离：SilksecErrorBoundary 逐面包；本包 apply 崩溃只销毁自身 fiber。本文件零颜色
 * 字面量，全部经 ui-core 令牌表 / --dsw-alias-*；设置行样式复用宿主（与 theme 插件
 * settings.general.item 行同款：label-primary 文案 + 右侧控件）。
 */
window.__ModuleLoader__.load({
  id: '@silksec/ui-settings-scope',
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
    var markSurfaceHealth = (uiCore && uiCore.markSurfaceHealth) || function () {}

    // ── 常量：注册标识 / 官方槽 / 降级 id ─────────────────────────────────────
    var SECTION_ID = 'silksec-scope'          // settings.section 的 id（导航 key）
    var SECTION_ORDER = 200
    var DEGRADED_VIEW_ID = 'scope-degraded'
    var DASHBOARD_PANEL_ID = 'silksec-dashboard'
    var DASHBOARD_ROUTE = '/silksec-dashboard'
    var DOMAIN_ROUTE = '/silksec-domain'
    var POLL_MS = 30000
    var RISK_LEVELS = ['passive', 'active', 'intrusive']

    // apply 时捕获的客户端 root context（渲染期按需读 connection/layout）
    var serviceRef = { ctx: null }
    function getService(name) {
      var ctx = serviceRef.ctx
      if (!ctx || typeof ctx.get !== 'function') return null
      try { return ctx.get(name) } catch (e) { return null }
    }
    // 统一 RPC caller：端点含 '.' → RpcProjector /silksec-domain（scope.cred_query）；
    // 否则走 /silksec-dashboard（与主面板同端点）。
    function getRpc() {
      var connection = getService('connection')
      if (!connection || !connection.rpc || typeof connection.rpc.call !== 'function') return null
      return function (endpoint, payload) {
        var route = String(endpoint).indexOf('.') >= 0 ? DOMAIN_ROUTE : DASHBOARD_ROUTE
        return connection.rpc.call(route, endpoint, payload || {}).then(function (result) {
          if (result && result.ok) return result.value
          var error = result && result.error
          throw new Error(error && error.message ? error.message : 'rpc failed')
        })
      }
    }

    // ── 样式（零颜色字面量；布局/容器查询用本地 CSS，颜色全部走 --dsw-alias-*） ──
    var CSS_KEY = 'silksec-ui-settings-scope'
    function ensureStyles() {
      try {
        if (typeof document === 'undefined' || !document.head) return
        if (document.querySelector('style[data-plugin-css=' + JSON.stringify(CSS_KEY) + ']')) return
        var tag = document.createElement('style')
        tag.dataset.plugin = '@silksec/ui-settings-scope'
        tag.dataset.pluginCss = CSS_KEY
        tag.textContent = [
          '.silksec-scope-section{display:flex;flex-direction:column;width:100%;box-sizing:border-box;gap:4px}',
          '.silksec-scope-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
          '.silksec-scope-mono{font-family:var(--ds-font-family-code,ui-monospace,Consolas,monospace);word-break:break-all}',
          '.silksec-scope-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,180px),1fr));gap:10px}',
        ].join('\n')
        document.head.appendChild(tag)
      } catch (e) { /* 样式注入失败不阻断功能 */ }
    }

    // ── 图标：仅用 ui-core 内联 opIcon（不新增官方图标依赖） ────────────────────
    function icon(kind, size) { return uiCore && uiCore.opIcon ? uiCore.opIcon(kind) : null }
    function tip(label, node) {
      var TT = prim('Tooltip')
      if (TT && label) return el(TT, { label: String(label), side: 'top', delayMs: 400 }, node)
      return node
    }

    // ── 写操作：端点/参数与主面板「授权」tab 完全一致 ──────────────────────────
    var SCOPE_ACTIONS = {
      list: function () { return { endpoint: 'scopeList', payload: {} } },
      save: function (spec, isNew) {
        return { endpoint: 'scopeSaveProgram', payload: Object.assign({}, spec || {}, { is_new: !!isNew }) }
      },
      remove: function (name) { return { endpoint: 'scopeDeleteProgram', payload: { name: String(name || '') } } },
      bind: function (programId, workspaceId) {
        return { endpoint: 'programBindWorkspace', payload: { program_id: String(programId || ''), workspace_id: workspaceId ? String(workspaceId) : null } }
      },
      creds: function (filter) { return { endpoint: 'scope.cred_query', payload: filter || {} } },
    }
    // 单条操作 → RPC：args 按 op 位置参数传入（对齐主面板 onScopeSave/onScopeDelete/... 端点）。
    function scopeAction(rpc, op, args) {
      var build = SCOPE_ACTIONS[op]
      if (typeof build !== 'function') return Promise.reject(new Error('未知授权操作: ' + op))
      if (typeof rpc !== 'function') return Promise.reject(new Error('连接通道不可用'))
      var req = build.apply(null, args || [])
      return rpc(req.endpoint, req.payload)
    }

    // ── 通用小件（token 样式；primitives 缺席自动兜底） ─────────────────────────
    var card = { padding: '12px 14px', borderRadius: 8, border: '1px solid ' + T.border, background: T.base, minWidth: 0, boxSizing: 'border-box', marginTop: 10 }
    var pill = (styles.pill || {})
    var iconBtn = { className: 'silksec-icon-btn', type: 'button' }
    var formRow = { display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 10 }
    var formLabel = { color: T.label2, ...((F && F.xxsStrong) || {}) }
    var inputStyle = { width: '100%', boxSizing: 'border-box' }
    var sectionHead = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }

    function pillNode(text, opts) {
      opts = opts || {}
      return el('span', { style: { ...pill, ...(opts.color ? { color: opts.color } : {}), ...(opts.style || {}), ...(opts.mono ? { fontFamily: MONO, fontSize: 11 } : {}) }, title: opts.title || undefined }, text)
    }
    function programCount(p) { return (p.scope || []).length }
    function excludeCount(p) { return (p.exclude || []).length }
    function programBound(p) {
      if (p.workspace) return p.workspace
      if (p.db && p.db.workspace_path) return p.db.workspace_path
      if (p.db && p.db.workspace_id) return p.db.workspace_id
      return ''
    }
    // B6：下拉选中值须与徽章同源——后端可能只回 workspace（路径/标题）而无 workspace_id，
    // 此时按 id/title/path 反查工作区，避免「徽章显示已绑定、下拉显示不绑定」的状态错配。
    function boundWorkspaceId(p, workspaces) {
      if (p.db && p.db.workspace_id) return p.db.workspace_id
      var bound = programBound(p)
      if (!bound) return ''
      var hit = (workspaces || []).filter(function (w) { return w.id === bound || w.title === bound || w.path === bound })
      return hit.length ? hit[0].id : ''
    }

    // ── 凭据引用状态（只显示 ref，不显示明文；无写路径） ────────────────────────
    function CredLine(props) {
      var c = props.cred
      return el('div', { style: { ...card, padding: '8px 12px', marginTop: 6 } },
        el('div', { className: 'silksec-scope-row' },
          el('span', { className: 'silksec-scope-mono', style: { color: T.label, ...((F && F.xxsStrong) || {}) }, title: c.ref }, c.ref || '—'),
          c.cred_type ? pillNode(c.cred_type, { title: '凭据类型' }) : null,
          c.role ? pillNode('role ' + c.role, { title: '角色（越权矩阵用）' }) : null,
          c.program_id ? pillNode('项目 ' + c.program_id, { title: '归属项目' }) : null,
          c.created_at ? el('span', { style: { marginLeft: 'auto', color: T.label3, ...((F && F.xxxs) || {}) } }, fmtTs(c.created_at)) : null),
        c.host ? el('div', { style: { marginTop: 4, color: T.label3, ...((F && F.xxxs) || {}) } }, '适用目标 ' + c.host) : null)
    }

    function CredentialsBlock(props) {
      var creds = props.creds
      var st = props.state || {}
      if (st.error) {
        return el('div', { style: { ...card, marginTop: 16, color: T.error, ...((F && F.xxs) || {}) } }, '凭据引用加载失败（只读，不影响授权管理）: ' + st.error)
      }
      var rows = creds || []
      return el('div', { style: { marginTop: 16 } },
        el('div', { style: sectionHead },
          el('span', { style: { color: T.label, ...((F && F.sStrong) || {}) } }, '凭据引用'),
          pillNode(String(rows.length), { title: '已登记引用数' }),
          el('span', { style: { marginLeft: 'auto', color: T.label3, ...((F && F.xxxs) || {}) }, title: '凭据明文本体只存 .env（600），此处仅显示引用' }, '只显示引用 · 永不明文')),
        rows.length
          ? el('div', null, rows.map(function (c) { return el(CredLine, { key: String(c.id), cred: c }) }))
          : el('div', { style: { color: T.label3, padding: '8px 0', ...((F && F.xs) || {}) } }, '暂无凭据引用（凭据可用范围须与授权范围一致）'))
    }

    // ── 授权项目卡片：范围条目 / 排除清单 / 工作区绑定 / 行内操作 ────────────────
    function ProgramCard(props) {
      var p = props.program
      var workspaces = props.workspaces || []
      var busy = props.busy
      var bound = programBound(p)
      return el('div', { style: { ...card, marginTop: 10 } },
        el('div', { className: 'silksec-scope-row' },
          el('span', { className: 'silksec-scope-mono', style: { color: T.label, ...((F && F.sStrong) || {}) }, title: p.name }, p.name),
          p.platform ? pillNode(p.platform, { title: '平台' }) : null,
          pillNode('上限 ' + (p.max_risk || 'active'), { color: p.max_risk === 'intrusive' ? T.warn : undefined, title: '项目风险上限（rules.max_risk）' }),
          bound
            ? pillNode('工作区 ' + bound, { color: T.success, title: '已绑定 DSH 工作区（Program 1:1）' })
            : pillNode('未绑工作区', { color: T.label3, title: '未绑定工作区：task_create 无法按会话自动带出归属' }),
          pillNode('条目 ' + programCount(p), { title: '授权条目数' }),
          excludeCount(p) ? pillNode('排除 ' + excludeCount(p), { color: T.error, title: '排除清单条目数' }) : null,
          // 授权时效：过期 fail-closed 红标；临期（≤30 天）黄标；无到期不显示
          p.expired
            ? pillNode('已过期', { color: T.error, title: '授权已于 ' + p.expires_at + ' 过期（fail-closed，不再授权）——复核后经 scope_rules_apply 续期' })
            : (p.days_left !== null && p.days_left !== undefined && p.days_left <= 30
              ? pillNode('剩 ' + p.days_left + ' 天', { color: T.warn, title: '授权将于 ' + p.expires_at + ' 到期' })
              : (p.expires_at ? pillNode('至 ' + p.expires_at, { color: T.label3, title: '授权到期日；复核时间 ' + (p.reviewed_at || '—') }) : null)),
          el('span', { style: { marginLeft: 'auto', display: 'inline-flex', gap: 6, alignItems: 'center' } },
            tip('编辑授权项目（范围 / 排除 / 风险上限）', el('button', { ...iconBtn, disabled: !!busy, 'aria-label': '编辑授权', onClick: function () { props.onEdit(p) } }, icon('edit'))),
            tip('移除授权（fail-closed 立即生效；programs 表归档，资产/漏洞归属保留）', el('button', { ...iconBtn, className: 'silksec-icon-btn silksec-icon-btn-danger', disabled: !!busy, 'aria-label': '移除授权', onClick: function () { props.onRemove(p.name) } }, icon('trash'))))),
        // 授权范围条目
        el('div', { style: { marginTop: 8, display: 'flex', gap: 4, flexWrap: 'wrap' } },
          (p.scope || []).map(function (s) { return el('span', { key: s, style: { ...pill, fontFamily: MONO, fontSize: 11 } }, s) })),
        // 排除清单
        excludeCount(p)
          ? el('div', { style: { marginTop: 6, display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' } },
              el('span', { style: { color: T.label3, ...((F && F.xxxs) || {}) }, title: '排除先于授权匹配（fail-closed）；移除排除须经 scope_grant 吸收或审批中心 exclude-exception' }, '排除:'),
              (p.exclude || []).map(function (s) { return el('span', { key: s, style: { ...pill, fontFamily: MONO, fontSize: 11, color: T.error } }, s) }))
          : null,
        // 工作区绑定（programBindWorkspace：与主面板同端点同 actor）
        el('div', { className: 'silksec-scope-row', style: { marginTop: 8 } },
          el('span', { style: { color: T.label3, ...((F && F.xxxs) || {}) }, title: 'DSH 工作区 ↔ Program 1:1 软绑定' }, '绑定工作区'),
          el('select', {
            className: 'silksec-input', style: { maxWidth: 280 }, disabled: !!busy,
            'data-silksec-bind': p.name,
            value: boundWorkspaceId(p, workspaces),
            title: '选择后经 programBindWorkspace 写入 scope.program_bind_workspace',
            onChange: function (e) { props.onBind(p.name, e.target.value) },
          },
            el('option', { value: '' }, '不绑定'),
            workspaces.map(function (w) { return el('option', { key: w.id, value: w.id }, w.title + '（' + w.id + '）') }))))
    }

    // ── 授权项目表单（新增/编辑；scopeSaveProgram，原子写 scope.yml + 审计） ────
    function ScopeForm(props) {
      var init = props.initial || {}
      var name = React.useState(init.name || '')
      var platform = React.useState(init.platform || '')
      var scope = React.useState((init.scope || []).join('\n'))
      var exclude = React.useState((init.exclude || []).join('\n'))
      var maxRisk = React.useState(init.max_risk || 'active')
      function submit() {
        props.onSave({
          name: String(name[0]).trim(),
          platform: String(platform[0]).trim(),
          scope: String(scope[0]).split('\n').map(function (s) { return s.trim() }).filter(Boolean),
          exclude: String(exclude[0]).split('\n').map(function (s) { return s.trim() }).filter(Boolean),
          max_risk: maxRisk[0],
        }, !init.name)
      }
      return el('div', { style: { ...card, borderColor: T.border3, marginTop: 12 } },
        el('div', { style: { color: T.label, ...((F && F.sStrong) || {}), marginBottom: 10 } }, init.name ? '编辑授权项目：' + init.name : '新增授权项目'),
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
          el('span', { style: formLabel }, '排除清单（每行一条，可选；排除例外请走审批中心）'),
          el('textarea', { className: 'silksec-input', style: { ...inputStyle, height: 44, padding: '8px 10px', fontFamily: MONO, fontSize: 12, resize: 'vertical' }, value: exclude[0], onChange: function (e) { exclude[1](e.target.value) } })),
        el('div', { style: { ...formRow, maxWidth: 220 } },
          el('span', { style: formLabel }, '风险上限'),
          el('select', { className: 'silksec-input', style: inputStyle, value: maxRisk[0], onChange: function (e) { maxRisk[1](e.target.value) } },
            RISK_LEVELS.map(function (r) { return el('option', { key: r, value: r }, r) }))),
        el('div', { style: { display: 'flex', gap: 8, marginTop: 4 } },
          el('button', { type: 'button', className: 'silksec-btn silksec-btn-confirm', disabled: !!props.busy, onClick: submit }, '保存（原子写 scope.yml + 审计）'),
          el('button', { type: 'button', className: 'silksec-btn', onClick: props.onCancel }, '取消')))
    }

    // ── 授权范围整节（settings.section 体 / 降级视图 / Modal 三处共用） ─────────
    function ScopeSection(props) {
      ensureStyles()
      var rpc = (props && props.rpc) || getRpc()
      var useRpcCore = uiCore && uiCore.useRpc
      var editing = React.useState(null)
      var editingState = editing[0]; var setEditing = editing[1]
      var bs = React.useState(false)
      var busy = bs[0]; var setBusy = bs[1]
      var compact = !!(props && props.compact)

      if (typeof useRpcCore !== 'function') {
        return el('div', { style: { color: T.label3, ...((F && F.xs) || {}) } }, 'ui-core hooks 不可用，授权范围节降级为空。')
      }

      var listState = useRpcCore(function () { return { endpoint: 'scopeList' } }, [], rpc || undefined)
      var credState = useRpcCore(function () { return { endpoint: 'scope.cred_query', payload: { limit: 200 } } }, [], rpc || undefined)
      var wsState = useRpcCore(function () { return { endpoint: 'workspaces' } }, [], rpc || undefined)

      var data = listState.data
      var programs = (data && data.programs) || []
      var archived = (data && data.archived) || []
      var dft = (data && data.defaults) || {}
      var creds = (credState.data && credState.data.rows) || []
      var workspaces = ((wsState.data && wsState.data.items) || []).map(function (w) {
        return { id: w.id, title: w.title }
      })

      function reloadAll() {
        if (listState.reload) listState.reload()
        if (credState.reload) credState.reload()
        if (wsState.reload) wsState.reload()
      }
      function withBusy(fn) {
        if (busy) return
        setBusy(true)
        Promise.resolve().then(fn).then(function () {
          reloadAll()
        }).catch(function (e) {
          try { if (window.alert) window.alert('操作失败: ' + (e && e.message ? e.message : e)) } catch (e2) {}
        }).then(function () { setBusy(false) })
      }
      function onSave(spec, isNew) {
        withBusy(function () { return scopeAction(rpc, 'save', [spec, isNew]) })
        setEditing(null)
      }
      function onRemove(name) {
        var yes = false
        try { yes = window.confirm('确认移除 ' + name + ' 的授权？目标立即被 fail-closed 拒绝；历史数据保留并归档。') } catch (e) { return }
        if (yes) withBusy(function () { return scopeAction(rpc, 'remove', [name]) })
      }
      function onBind(programId, workspaceId) {
        withBusy(function () { return scopeAction(rpc, 'bind', [programId, workspaceId]) })
      }

      if (listState.error) {
        return el('div', { style: { ...(styles.errorLine || {}), color: T.error } }, '授权范围加载失败: ' + listState.error)
      }
      if (!data) {
        return el('div', { style: { color: T.label3, padding: '16px 0', ...((F && F.xs) || {}) } }, '正在加载 scope.yml…')
      }

      return el('div', { className: 'silksec-scope-section', 'data-silksec-section': 'scope' },
        // 节头（设置行样式：label-primary 文案 + 右侧操作）
        el('div', { style: { ...sectionHead, marginBottom: 4 } },
          el('span', { style: { color: T.label, ...((F && F.baseStrong) || {}) } }, '授权范围'),
          pillNode(String(programs.length) + ' 个项目', { title: 'scope.yml 在档项目数' }),
          el('span', { style: { marginLeft: 'auto', display: 'inline-flex', gap: 6 } },
            tip('重新加载 scope.yml 与凭据引用', el('button', { ...iconBtn, 'aria-label': '刷新', onClick: reloadAll }, icon('history'))),
            el('button', { type: 'button', className: 'silksec-btn', disabled: !!busy, title: '登记新的 scope.yml 授权项目', onClick: function () { setEditing({}) } }, el('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } }, icon('plus'), '新增授权项目')))),
        el('div', { style: { color: T.label3, ...((F && F.xxs) || {}) } },
          'scope.yml 授权白名单（fail-closed：不在此处的目标一律拒绝）。默认风险级: ' + (((dft.allow_risk || []).join('/')) || 'passive/active') + '；出口代理: ' + (dft.egress_proxy || '—') + '。界面写入自动备份 scope.yml.bak 并记 audit.jsonl。'),

        // 新增/编辑表单
        editingState
          ? el(ScopeForm, {
              initial: editingState, busy: busy,
              onSave: function (spec, isNew) { onSave(spec, isNew) },
              onCancel: function () { setEditing(null) },
            })
          : null,

        // program 列表
        programs.length
          ? el('div', null, programs.map(function (p) {
              return el(ProgramCard, {
                key: p.name, program: p, workspaces: workspaces, busy: busy,
                onEdit: function (prog) { setEditing({ name: prog.name, platform: prog.platform, scope: prog.scope, exclude: prog.exclude, max_risk: prog.max_risk }) },
                onRemove: onRemove, onBind: onBind,
              })
            }))
          : el('div', { style: { color: T.label3, padding: '12px 0', ...((F && F.xs) || {}) } }, 'scope.yml 暂无授权项目（fail-closed 全拒绝）'),
        archived.length
          ? el('div', { style: { color: T.label3, marginTop: 12, ...((F && F.xxs) || {}) } }, '已归档（授权已移除，数据归属保留）: ' + archived.map(function (p) { return p.id || p.name }).join(' / '))
          : null,

        // 凭据引用状态（只读）
        el(CredentialsBlock, { creds: creds, state: credState }),

        // 排除例外通道提示（审批中心不变）
        el('div', { style: { marginTop: 12, color: T.label3, ...((F && F.xxxs) || {}) }, title: '整域授权 / 单子域授权 / 排除例外均经统一审批中心' }, '整域授权、单子域授权与排除例外（exclude-exception）请前往「审批中心」提请——批准副作用原子写回 scope.yml。'),
        compact ? null : el('div', { style: { height: 8 } }))
    }

    // 主面板降级视图（ui-core 注册表 id = scope-degraded，角标「降级」）
    function ScopeDegradedView(props) {
      ensureStyles()
      var ms = React.useState(false)
      var modalOpen = ms[0]; var setModalOpen = ms[1]
      var body = el('div', { style: { padding: '8px 0' } },
        el('div', { style: { ...((styles.pageSub) || {}), color: T.warn, marginBottom: 6 } }, '设置页不可用：授权范围降级挂主面板临时 tab（角标「降级」）。'),
        el('div', { style: { ...sectionHead, marginBottom: 8 } },
          el('button', { type: 'button', className: 'silksec-btn', title: '以弹窗形式打开授权范围（primitives Modal 降级）', onClick: function () { setModalOpen(true) } }, '弹窗打开')),
        el(ScopeSection, { surface: 'scope-degraded', rpc: props && props.rpc }))
      if (!modalOpen) return el(uiCore.SilksecErrorBoundary, { surface: 'ui-settings-scope:degraded', title: '授权范围（降级）' }, body)
      return el(uiCore.SilksecErrorBoundary, { surface: 'ui-settings-scope:degraded', title: '授权范围（降级）' },
        el(React.Fragment, null, body, renderScopeModal(true, props && props.rpc, function () { setModalOpen(false) })))
    }

    // Modal 降级（settings.section + 主面板/layout 均缺席）；primitives.Modal 缺席时自绘 fixed 覆盖层
    function renderScopeModal(open, rpc, onClose) {
      if (!open) return null
      var body = el('div', { style: { height: '70vh', display: 'flex', flexDirection: 'column', padding: 12 } },
        el(ScopeSection, { surface: 'scope-modal', rpc: rpc, compact: true }))
      var M = prim('Modal')
      if (M) return el(M, { open: true, onClose: onClose, title: '授权范围', headless: true, className: 'silksec-dash-dialog' }, body)
      return el('div', { style: { position: 'fixed', inset: 0, zIndex: 80, background: T.base, display: 'flex', flexDirection: 'column', padding: 16, pointerEvents: 'auto' } },
        el('div', { style: { display: 'flex', alignItems: 'center' } },
          el('div', { style: { ...((styles.pageT) || {}) } }, '授权范围'),
          el('button', { type: 'button', className: 'silksec-btn', style: { marginLeft: 'auto' }, title: '关闭', onClick: onClose }, '关闭')),
        body)
    }

    // ── settings.section 注册定义（阶段：整节挂 list/root 槽） ──────────────────
    function buildSectionDefinition() {
      return {
        name: 'settings.section',
        id: SECTION_ID,
        order: SECTION_ORDER,
        // 导航文案：registrant-localized（函数形态，与 General section 同款 resolveSlotLabel 路径）
        label: function () { return '授权范围' },
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
        id: DEGRADED_VIEW_ID, label: '授权 ·降级', order: 102, domain: 'scope',
        component: ScopeDegradedView, source: 'silksec-ui-settings-scope',
      })
      markSurfaceHealth('ui-settings-scope', 'degraded', 'settings.section 缺席：授权范围视图降级挂主面板')
    }
    function removeDegraded() {
      if (degradedDisposer) { try { degradedDisposer() } catch (e) {} degradedDisposer = null }
    }

    exports.name = 'silksec-ui-settings-scope'
    exports.inject = ['slots']
    exports.apply = function (ctx) {
      serviceRef.ctx = ctx
      ensureStyles()
      if (!uiCore) return

      // 一切注册 ctx.inject([...], cb) + ctx.effect() 包裹（时序纪律；settings.section 缺席静默降级）
      ctx.inject(['slots'], function (scope) {
        ctx.effect(function () {
          var slots = scope.slots
          var disposers = []
          // 能力探测：settings.section 未声明 → 先装降级视图（主面板「授权 ·降级」）
          if (!slotDeclared(slots, 'settings.section')) installDegraded(slots)
          if (slots && typeof slots.inject === 'function') {
            disposers.push(slots.inject('settings.section', function () {
              // 槽声明到达（可能晚于本包 apply）：撤降级，注册整节
              removeDegraded()
              markSurfaceHealth('ui-settings-scope', 'ok', 'settings.section 整节注册')
              return slots.register(buildSectionDefinition(), ScopeSection)
            }))
          }
          return function () {
            disposers.forEach(function (d) { try { if (typeof d === 'function') d() } catch (e) {} })
            removeDegraded()
          }
        })
      })
    }

    // 稳定导出面（供单测 / 降级探测）
    exports.SECTION_ID = SECTION_ID
    exports.SECTION_ORDER = SECTION_ORDER
    exports.DEGRADED_VIEW_ID = DEGRADED_VIEW_ID
    exports.SCOPE_ACTIONS = SCOPE_ACTIONS
    exports.scopeAction = scopeAction
    exports.buildSectionDefinition = buildSectionDefinition
    exports.slotDeclared = slotDeclared
    exports.getRpc = getRpc
    exports.ScopeSection = ScopeSection
    exports.ScopeForm = ScopeForm
    exports.ProgramCard = ProgramCard
    exports.CredLine = CredLine
    exports.CredentialsBlock = CredentialsBlock
    exports.ScopeDegradedView = ScopeDegradedView
    exports.renderScopeModal = renderScopeModal
    exports.programBound = programBound
    exports.boundWorkspaceId = boundWorkspaceId
    exports.programCount = programCount
    exports.excludeCount = excludeCount

    return module.exports
  },
})
