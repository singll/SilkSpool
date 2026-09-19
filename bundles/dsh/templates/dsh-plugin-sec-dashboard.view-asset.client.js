/**
 * @silksec/sec-dashboard-view-asset — client half (browser bundle)，16-dashboard P6 逐域视图拆分。
 *
 * 资产域浏览视图（16-dashboard §1.1「资产」视图 + 16-dashboard §1.3「主面板视图」）。
 * 从旧单体 dsh-plugin-sec-dashboard.client.js 拆出，**自持 query/handler**、纯组件、
 * 无挂载感知：经 @silksec/ui-core 的 viewRegistry 注册，ui-panel 主面板按 order 装配。
 *
 * 契约（与旧 PanelView 的 assets 分支逐项等价）：
 *   - 读：assets（分页/筛选/排序）、assetOverview（评级/收录/状态分布 + 域名族聚合）；
 *   - 按需读：assetDetail（单主机钻取）、assetFamily（域名族成员）；
 *   - 双模式：列表（行内钻取）与域名族（同注册域 / 同 /24 网段聚合）；
 *   - 跨视图跳链：navigate（同族主机 → 资产搜索；漏洞分级 → findings 视图按主机+级别过滤）；
 *   - requires:['connection'] 缺席 → 不注册（tab 静默隐藏，不抛、不占 order）。
 *
 * 视觉遵循丝之歌主题规范：全部经 ui-core 令牌（--dsw-alias-* / --silksec-sev-*），
 * 本文件零颜色字面量（severity 色仅经 uiCore.SEV_COLOR）。崩溃由 ui-panel 的
 * SilksecErrorBoundary 单面隔离。
 */
window.__ModuleLoader__.load({
  id: '@silksec/sec-dashboard-view-asset',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    var React = require('react')
    var uiCore = null
    try { uiCore = require('@silksec/ui-core') } catch (e) { uiCore = null }
    var el = React.createElement

    // 自持 RPC（apply 时从 connection 捕获；ui-panel prop bag 的 rpc 作兜底）
    var serviceRef = { rpc: null }
    function ownRpc(endpoint, payload) {
      if (!serviceRef.rpc) return Promise.reject(new Error('连接通道不可用'))
      return serviceRef.rpc(endpoint, payload || {})
    }

    // ── 资产视图（v4.1 多维改造）：洞察条 + 列表/域名族双模式 + 行内钻取 ──────
    // 资产记录多且扁平，看不出结构——多维入口：评级/收录/状态 chip 即点即筛，
    // 域名族（同注册域 / 同 /24 网段）呈现资产间的联系，单主机钻取聚合指纹/接口/漏洞/同族。
    var T = (uiCore && uiCore.T) ? uiCore.T : {}
    var ASSET_LV_COLOR = { S: T.error, A: T.warn, B: T.label, C: T.label2 }
    var ASSET_STATE_LABEL = { new: '新发现', changed: '有变更', stable: '稳定', dead: '已失活' }
    var ASSET_ACCEPT_LABEL = { full: '全量收录', 'intrusion-only': '仅入侵', none: '不收录' }

    function AssetInsight(props) {
      var ov = props.overview || {}
      var query = props.query
      var byLevel = ov.by_level || {}
      var byState = ov.by_state || {}
      var byAccept = ov.by_accept || {}
      var chips = ['S', 'A', 'B', 'C'].filter(function (k) { return byLevel[k] })
        .map(function (k) { return uiCore.insightChip('level', k, k, byLevel[k], ASSET_LV_COLOR[k], query, '可挖掘性评级 ' + k) })
      if (byLevel['']) chips.push(uiCore.insightChip('level', 'none', '未分级', byLevel[''], uiCore.T.warn, query, '未评级资产（P15：未分级不可主动扫描，先分级）'))
      Object.keys(ASSET_ACCEPT_LABEL).forEach(function (k) {
        if (byAccept[k]) chips.push(uiCore.insightChip('accept', k, ASSET_ACCEPT_LABEL[k], byAccept[k], k === 'none' ? uiCore.T.label3 : undefined, query, 'SRC 收录政策'))
      })
      Object.keys(ASSET_STATE_LABEL).forEach(function (k) {
        if (byState[k]) chips.push(uiCore.insightChip('state', k, ASSET_STATE_LABEL[k], byState[k], k === 'dead' ? uiCore.T.label3 : undefined, query, '资产状态'))
      })
      if (!chips.length) return null
      return el('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', margin: '2px 0 8px' } },
        chips,
        el('span', { style: { marginLeft: 'auto', color: uiCore.T.label3, ...uiCore.F.xxxs }, title: '域名族 = 同注册域 / 同 /24 网段的资产聚合（资产之间的联系），见「域名族」视图' }, '共 ' + (ov.total || 0) + ' 台 · ' + (ov.family_count || 0) + ' 族'))
    }

    // 单主机钻取面板（列表模式行内展开）：指纹技术栈 / 该主机接口 / 漏洞分级 / 同族主机
    function AssetDetailPanel(props) {
      var st = React.useState({ loading: true, data: null, error: null })
      var d = st[0]; var setD = st[1]
      React.useEffect(function () {
        var alive = true
        setD({ loading: true, data: null, error: null })
        props.callRpc('assetDetail', { host: props.host })
          .then(function (res) { if (alive) setD({ loading: false, data: res, error: null }) })
          .catch(function (e) { if (alive) setD({ loading: false, data: null, error: e && e.message ? e.message : String(e) }) })
        return function () { alive = false }
      }, [props.host])
      var METHOD_COLOR = { GET: uiCore.T.label2, POST: uiCore.T.brand, PUT: uiCore.T.warn, DELETE: uiCore.T.error, PATCH: uiCore.T.warn }
      var inner
      if (d.loading) inner = el(uiCore.SkeletonRows, { rows: 3 })
      else if (d.error || !d.data || d.data.ok === false) inner = el('div', { style: { ...uiCore.styles.errorLine, padding: 0 } }, '钻取加载失败: ' + (d.error || (d.data && d.data.error) || '无数据'))
      else {
        var det = d.data
        var sec = function (title, children) {
          return el('div', { style: { minWidth: 0, flex: '0 1 auto' } },
            el('div', { style: { color: uiCore.T.label3, ...uiCore.F.xxxs, marginBottom: 4 } }, title),
            children)
        }
        var findingTotal = (det.findings || []).reduce(function (s, f) { return s + f.n }, 0)
        inner = el('div', { style: { display: 'flex', gap: 20, flexWrap: 'wrap' } },
          sec('指纹技术栈（' + (det.fingerprints || []).length + '）',
            (det.fingerprints || []).length
              ? el('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', maxWidth: 300 } },
                  det.fingerprints.map(function (fp) {
                    return el('span', { key: fp.tech + (fp.version || ''), style: uiCore.styles.pill, title: '版本 ' + (fp.version || '—') + ' · 来源 ' + (fp.source || '—') + ' · ' + uiCore.fmtTime(fp.last_seen) }, fp.tech + (fp.version ? ' ' + fp.version : ''))
                  }))
              : el('span', { style: { color: uiCore.T.label3, ...uiCore.F.xxs } }, '—')),
          sec('接口（' + det.endpoint_total + '）',
            det.endpoint_total
              ? el('div', { style: { display: 'flex', flexDirection: 'column', gap: 2, maxWidth: 400 } },
                  (det.endpoints || []).slice(0, 6).map(function (e, i) {
                    return el('div', { key: i, style: { fontFamily: uiCore.MONO, fontSize: 12, color: uiCore.T.label2, wordBreak: 'break-all' } },
                      el('span', { style: { color: METHOD_COLOR[e.method] || uiCore.T.label2, marginRight: 6 } }, e.method),
                      e.path,
                      e.status ? el('span', { style: { color: uiCore.T.label3, marginLeft: 6 } }, e.status) : null)
                  }),
                  det.endpoint_total > 6 ? el('span', { style: { color: uiCore.T.label3, ...uiCore.F.xxxs } }, '… 其余 ' + (det.endpoint_total - 6) + ' 个见「接口」tab') : null)
              : el('span', { style: { color: uiCore.T.label3, ...uiCore.F.xxs } }, '—')),
          sec('漏洞（' + findingTotal + '）',
            (det.findings || []).length
              ? el('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
                  det.findings.map(function (f) {
                    var c = uiCore.SEV_COLOR[f.severity] || uiCore.T.label2
                    return el('button', {
                      key: f.severity, type: 'button', className: 'silksec-chip',
                      style: { color: c, borderColor: 'color-mix(in srgb, ' + c + ' 40%, transparent)' },
                      title: '跳转漏洞视图并按该主机' + (uiCore.SEV_LABEL[f.severity] || f.severity) + '过滤',
                      onClick: function () { props.onFindings(det.host, f.severity) },
                    }, (uiCore.SEV_LABEL[f.severity] || f.severity) + ' ' + f.n)
                  }))
              : el('span', { style: { color: uiCore.T.label3, ...uiCore.F.xxs } }, '—')),
          sec('同族主机（' + (det.siblings || []).length + '）',
            (det.siblings || []).length
              ? el('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', maxWidth: 340 } },
                  det.siblings.map(function (s) {
                    return el('button', {
                      key: s.host, type: 'button', className: 'silksec-chip',
                      style: { fontFamily: uiCore.MONO, fontSize: 11 },
                      title: '同属 ' + det.root + ' · 评级 ' + (s.level || '—') + (s.score !== null && s.score !== undefined ? ' · ' + s.score + ' 分' : '') + ' · 点击搜索该主机',
                      onClick: function () { props.onPickHost(s.host) },
                    }, s.host)
                  }))
              : el('span', { style: { color: uiCore.T.label3, ...uiCore.F.xxs } }, '（孤例，无同族资产）'))),
          el('div', { style: { ...uiCore.F.xxxs, color: uiCore.T.label3, width: '100%' }, title: '域名族根' }, '族根 ' + det.root)
      }
      return el('div', { style: { padding: '12px 14px', background: uiCore.T.layer1, borderLeft: '2px solid ' + uiCore.T.brand } }, inner)
    }

    // 域名族成员主机（按需拉取，族行展开时；总览不带成员清单，30s 轮询保持轻量）
    function FamilyHostsPanel(props) {
      var st = React.useState({ loading: true, data: null, error: null })
      var d = st[0]; var setD = st[1]
      React.useEffect(function () {
        var alive = true
        setD({ loading: true, data: null, error: null })
        props.callRpc('assetFamily', { root: props.root })
          .then(function (res) { if (alive) setD({ loading: false, data: res, error: null }) })
          .catch(function (e) { if (alive) setD({ loading: false, data: null, error: e && e.message ? e.message : String(e) }) })
        return function () { alive = false }
      }, [props.root])
      if (d.loading) return el('div', { style: { padding: '10px 14px', background: uiCore.T.layer1 } }, el(uiCore.SkeletonRows, { rows: 2 }))
      if (d.error || !d.data || d.data.ok === false) return el('div', { style: { ...uiCore.styles.errorLine, padding: '10px 14px' } }, '成员加载失败: ' + (d.error || '无数据'))
      var hosts = d.data.hosts || []
      return el('div', { style: { padding: '10px 14px', background: uiCore.T.layer1, borderLeft: '2px solid ' + uiCore.T.border3 } },
        el('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', maxHeight: 300, overflowY: 'auto' } },
          hosts.map(function (h) {
            return el('button', {
              key: h.host, type: 'button', className: 'silksec-chip',
              style: { fontFamily: uiCore.MONO, fontSize: 11, color: ASSET_LV_COLOR[h.level] || uiCore.T.label2 },
              title: '类型 ' + (h.type || '—') + ' · 评级 ' + (h.level || '—') + (h.score !== null && h.score !== undefined ? ' · ' + h.score + ' 分' : '') + (h.accept ? ' · 收录 ' + (ASSET_ACCEPT_LABEL[h.accept] || h.accept) : '') + ' · ' + uiCore.fmtTime(h.last_seen) + ' · 点击在列表视图搜索',
              onClick: function () { props.onPickHost(h.host) },
            }, h.host)
          }),
          props.hostCount > hosts.length
            ? el('span', { style: { ...uiCore.styles.pill, color: uiCore.T.label3 } }, '… 共 ' + props.hostCount + ' 台（按分排序展示前 ' + hosts.length + '）')
            : null))
    }

    function AssetsView(props) {
      var rpcCall = (typeof props.rpc === 'function') ? props.rpc : ownRpc
      var query = props.query
      var modeS = React.useState('list')
      var mode = modeS[0]; var setMode = modeS[1]
      var exp = React.useState(null)
      var expandedHost = exp[0]; var setExpandedHost = exp[1]
      var fexp = React.useState(null)
      var expandedFam = fexp[0]; var setExpandedFam = fexp[1]
      var toggle = el('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 4, margin: '2px 0 8px' } },
        [['list', '列表', '逐台资产列表（点击行钻取：指纹 / 接口 / 漏洞 / 同族主机）'], ['family', '域名族', '按注册域 / /24 网段聚合的资产族视图（资产之间的联系）']].map(function (m) {
          var on = mode === m[0]
          return el('button', {
            key: m[0], type: 'button', className: 'silksec-btn',
            style: { height: 22, ...uiCore.F.xxxs, color: on ? uiCore.T.label : uiCore.T.label2, background: on ? uiCore.T.layer2 : 'transparent', borderColor: on ? uiCore.T.border3 : uiCore.T.border2 },
            title: m[2], onClick: function () { setMode(m[0]) },
          }, m[1])
        }))

      // 域名族视图：聚合数据来自 assetOverview（客户端按搜索词过滤族根；成员按需拉取）
      if (mode === 'family') {
        var fams = ((props.overview && props.overview.families) || []).slice()
        var term = String(query.q || '').toLowerCase()
        if (term) fams = fams.filter(function (f) { return String(f.root).toLowerCase().indexOf(term) >= 0 })
        return el('div', null, toggle,
          el(AssetInsight, { overview: props.overview, query: query }),
          fams.length === 0
            ? el(uiCore.EmptyState, { text: props.overview ? '无匹配资产族' : '暂无资产族数据' })
            : el('div', { style: { overflowX: 'auto', minWidth: 0 } },
                el('table', { style: uiCore.styles.tableStyle },
                  el('colgroup', null,
                    el('col', null),
                    el('col', { style: { width: 56 } }),
                    el('col', { style: { width: 52 } }),
                    el('col', { style: { width: 52 } }),
                    el('col', { style: { width: 52 } }),
                    el('col', { style: { width: 52 } }),
                    el('col', { style: { width: 56 } }),
                    el('col', { style: { width: 96 } })),
                  el('thead', null, el('tr', { style: uiCore.styles.theadRow },
                    el('th', { style: uiCore.styles.th }, '域名族 / 网段'),
                    el('th', { style: uiCore.styles.th }, '类型'),
                    el('th', { style: uiCore.styles.th }, '主机'),
                    el('th', { style: uiCore.styles.th }, '接口'),
                    el('th', { style: uiCore.styles.th }, '漏洞'),
                    el('th', { style: uiCore.styles.th }, '评级'),
                    el('th', { style: uiCore.styles.th }, '最高分'),
                    el('th', { style: uiCore.styles.th }, '最近发现'))),
                  el('tbody', null, fams.map(function (f) {
                    var isOpen = expandedFam === f.root
                    return el(React.Fragment, { key: f.root },
                      el('tr', {
                        className: 'silksec-row', role: 'button', tabIndex: 0, 'aria-expanded': isOpen ? 'true' : 'false',
                        style: { cursor: 'pointer', boxShadow: isOpen ? 'inset 2px 0 0 ' + uiCore.T.border3 : undefined },
                        title: '点击展开成员主机（共 ' + f.host_count + ' 台）',
                        onClick: function () { setExpandedFam(isOpen ? null : f.root) },
                        onKeyDown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpandedFam(isOpen ? null : f.root) } },
                      },
                        el('td', { style: uiCore.styles.tdMono, title: f.root },
                          el('span', { style: { color: uiCore.T.label3, marginRight: 6, ...uiCore.F.xxxs } }, isOpen ? '▾' : '▸'),
                          f.root),
                        el('td', { style: uiCore.styles.td }, el('span', { style: uiCore.styles.pill, title: f.kind === 'subnet' ? '同 /24 网段' : '同注册域' }, f.kind === 'subnet' ? '网段' : '域名')),
                        el('td', { style: uiCore.styles.tdMono }, String(f.host_count)),
                        el('td', { style: uiCore.styles.tdMono }, String(f.endpoint_count)),
                        el('td', { style: { ...uiCore.styles.tdMono, color: f.finding_count ? uiCore.T.warn : uiCore.T.label3 } }, String(f.finding_count)),
                        el('td', { style: { ...uiCore.styles.td, color: ASSET_LV_COLOR[f.top_level] || uiCore.T.label3, fontWeight: f.top_level === 'S' || f.top_level === 'A' ? 600 : 400 } }, f.top_level || '—'),
                        el('td', { style: uiCore.styles.tdMono }, f.max_score !== null && f.max_score !== undefined ? String(f.max_score) : '—'),
                        el('td', { style: uiCore.styles.tdMono }, uiCore.fmtTime(f.last_seen))),
                      isOpen
                        ? el('tr', null, el('td', { colSpan: 8, style: { padding: 0 } },
                            el(FamilyHostsPanel, { root: f.root, hostCount: f.host_count, callRpc: rpcCall, onPickHost: function (h) { setMode('list'); props.onPickHost(h) } })))
                        : null)
                  })))))
      }

      // 列表视图：原表格 + 行内钻取
      return el('div', null, toggle,
        el(AssetInsight, { overview: props.overview, query: query }),
        el(uiCore.ViewBody, { query: query, emptyText: '暂无资产数据' }, function (rows) {
          return el('div', { style: { overflowX: 'auto', minWidth: 0 } },
            el('table', { style: uiCore.styles.tableStyle },
              el('colgroup', null,
                el('col', null),
                el('col', { style: { width: 70 } }),
                el('col', { style: { width: 60 } }),
                el('col', { style: { width: 60 } }),
                el('col', { style: { width: 90 } }),
                el('col', { style: { width: 100 } }),
                el('col', { style: { width: 130 } })),
              el('thead', null, el('tr', { style: uiCore.styles.theadRow },
                uiCore.sortableTh('主机', 'host', query),
                uiCore.sortableTh('评级', 'score', query),
                el('th', { style: uiCore.styles.th }, '层级'),
                uiCore.sortableTh('类型', 'type', query),
                el('th', { style: uiCore.styles.th }, '来源'),
                el('th', { style: uiCore.styles.th }, '项目'),
                uiCore.sortableTh('最近发现', 'last_seen', query))),
              el('tbody', null, rows.map(function (r) {
                var lvColor = ASSET_LV_COLOR[r.level] || uiCore.T.label3
                var isOpen = expandedHost === r.host
                return el(React.Fragment, { key: (r.host || '') + '|' + (r.type || '') },
                  el('tr', {
                    className: 'silksec-row',
                    style: { cursor: 'pointer', boxShadow: isOpen ? 'inset 2px 0 0 ' + uiCore.T.border3 : undefined },
                    title: '点击钻取：指纹 / 接口 / 漏洞 / 同族主机',
                    onClick: function () { setExpandedHost(isOpen ? null : r.host) },
                  },
                    el('td', { style: uiCore.styles.tdMono, title: r.host },
                      el('span', { style: { color: uiCore.T.label3, marginRight: 6, ...uiCore.F.xxxs } }, isOpen ? '▾' : '▸'),
                      r.host),
                    el('td', { style: uiCore.styles.tdMono }, r.score !== null && r.score !== undefined ? String(r.score) : '—'),
                    el('td', { style: { ...uiCore.styles.td, color: lvColor, fontWeight: r.level === 'S' || r.level === 'A' ? 600 : 400 } }, r.level || '—'),
                    el('td', { style: uiCore.styles.td }, r.type),
                    el('td', { style: uiCore.styles.td }, r.source || '—'),
                    el('td', { style: uiCore.styles.td }, uiCore.programCell(r.program_id)),
                    el('td', { style: uiCore.styles.tdMono }, uiCore.fmtTime(r.last_seen))),
                  isOpen
                    ? el('tr', null, el('td', { colSpan: 7, style: { padding: 0 } }, el(AssetDetailPanel, { host: r.host, callRpc: rpcCall, onPickHost: props.onPickHost, onFindings: props.onFindings })))
                    : null)
              }))))
        }))
    }

    // 域装配：自持 query（assets 分页 + assetOverview 总览）、Toolbar 五维筛选、
    // pending 跨视图待办一次性消费、跨视图跳链。prop bag 形状对齐旧 PanelView。
    function AssetDomainView(props) {
      var api = props || {}
      var rpcCall = (typeof api.rpc === 'function') ? api.rpc : ownRpc
      var nav = api.navigate || { select: function () {}, consume: function () {} }
      var statsData = api.stats || {}

      var assetsQ = uiCore.usePagedQuery('assets', true, null, rpcCall)
      var assetsOvState = uiCore.useRpc(function () { return { endpoint: 'assetOverview' } }, [], rpcCall)

      // 面板切到本视图时一次性应用跨视图跳转待办（q/filters）
      React.useEffect(function () {
        var p = api.pending
        if (!p) return
        if (p.q !== undefined) assetsQ.setQ(p.q)
        if (p.filters) { for (var k in p.filters) if (p.filters[k] !== undefined) assetsQ.setFilter(k, p.filters[k]) }
        if (typeof nav.consume === 'function') nav.consume('assets')
      }, [api.pending])

      function onPickHost(host) { assetsQ.setQ(host) }
      function onFindings(host, severity) { nav.select('findings', { q: host, filters: { severity: severity || '' } }) }

      var typeOpts = (statsData.assets_by_type || []).map(function (r) { return { v: r.type, l: r.type + ' (' + r.n + ')' } })
      var wsItems = (api.workspaces && api.workspaces.items) || []
      var progOpts = wsItems.filter(function (w) { return w.program }).map(function (w) { return { v: w.program.id, l: w.title + '（' + w.program.id + '）' } })

      return el(React.Fragment, null,
        el(uiCore.Toolbar, {
          query: assetsQ, placeholder: '搜索主机…',
          filters: [
            { key: 'level', label: '评级', options: [{ v: 'S', l: 'S' }, { v: 'A', l: 'A' }, { v: 'B', l: 'B' }, { v: 'C', l: 'C' }, { v: 'none', l: '未分级' }] },
            { key: 'accept', label: '收录', options: Object.keys(ASSET_ACCEPT_LABEL).map(function (k) { return { v: k, l: ASSET_ACCEPT_LABEL[k] } }) },
            { key: 'state', label: '状态', options: Object.keys(ASSET_STATE_LABEL).map(function (k) { return { v: k, l: ASSET_STATE_LABEL[k] } }) },
            { key: 'type', label: '类型', options: typeOpts },
            { key: 'program_id', label: '工作区', options: progOpts },
          ],
        }),
        el(AssetsView, { query: assetsQ, overview: assetsOvState.data, onPickHost: onPickHost, onFindings: onFindings, rpc: rpcCall }))
    }

    // 域根：包 ui-core SilksecErrorBoundary（崩溃只炸该域 tab，经 bus.audit_tail 口径带 surface）；
    // ui-panel 亦会包一层，双保险且使本组件在任意承载面（含降级）都自足隔离。
    function AssetRoot(props) {
      return el(uiCore.SilksecErrorBoundary, { surface: 'dashboard-view-asset', title: '资产' },
        el(AssetDomainView, props))
    }

    exports.name = 'silksec-sec-dashboard-view-asset'
    exports.inject = ['slots']
    exports.apply = function (ctx) {
      if (!uiCore || !uiCore.viewRegistry || typeof uiCore.viewRegistry.register !== 'function') return
      // 会话跳链 opener（可选；缺席 SessionLink 渲染「—」）
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
          id: 'assets', label: '资产', order: 30, domain: 'asset',
          component: AssetRoot, requires: ['connection'], source: 'dashboard-view-asset',
        })
        if (typeof uiCore.markSurfaceHealth === 'function') uiCore.markSurfaceHealth('sec-dashboard-view-asset', 'ok')
        return disposer
      }
      // 时序纪律：connection 到达后才注册（capacity 探测）；ctx.effect 收口 disposer。
      if (typeof ctx.inject === 'function') ctx.inject(['connection'], function () { if (typeof ctx.effect === 'function') ctx.effect(install); else install() })
      else if (typeof ctx.effect === 'function') ctx.effect(install)
      else install()
    }

    exports.AssetRoot = AssetRoot
    exports.AssetDomainView = AssetDomainView
    exports.AssetsView = AssetsView
    exports.AssetInsight = AssetInsight
    exports.AssetDetailPanel = AssetDetailPanel
    exports.FamilyHostsPanel = FamilyHostsPanel
    return module.exports
  },
})
