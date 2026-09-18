/**
 * @silksec/sec-dashboard-view-fact — client half (browser bundle)，19-ui-surface P6 逐域视图拆分。
 *
 * 事实域浏览视图（16-dashboard §1.7「事实」视图 + 19-ui-surface §三「主面板视图」）。
 * 从旧单体 dsh-plugin-sec-dashboard.client.js 拆出，**自持 query/handler**、纯组件、
 * 无挂载感知：经 @silksec/ui-core 的 viewRegistry 注册，ui-panel 主面板按 order 装配。
 *
 * 契约（与旧 PanelView 的 facts 分支逐项等价）：
 *   - 读：facts（分页/筛选/排序）、blackboard（遗留只读黑板）、factStats（facet 洞察）；
 *   - 写：factDeprecate（降置信为 deprecated）、factCorrect（纠正摘要）；
 *   - 行内跳链：关联子图展开走 factGraph，关联事实点击回填搜索；
 *   - 搜索词高亮复用 uiCore.hlText（不再本地重定义）。
 *   - requires:['connection'] 缺席 → 不注册（tab 静默隐藏，不抛、不占 order）。
 *
 * 视觉遵循丝之歌主题规范：全部经 ui-core 令牌（T/F/styles），本文件零颜色字面量。
 * 崩溃由 ui-panel 的 SilksecErrorBoundary 单面隔离（域根亦自包一层双保险）。
 */
window.__ModuleLoader__.load({
  id: '@silksec/sec-dashboard-view-fact',
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

    var T = uiCore ? uiCore.T : {}
    var CONF_COLOR = { confirmed: T.success, tentative: T.warn, deprecated: T.label3 }
    var MEM_CLASS_COLOR = { durable: T.success, ephemeral: T.warn, timeline: T.label3 }

    // ── 事实洞察条：置信分布 / 有关联 chip 可点即筛；分类 facet 计数（动态） ──
    // 生命周期维度（durable/ephemeral/timeline chip + 工作速记开关——note 是 agent 工作记忆，
    // 默认隐藏防流水账淹没知识事实；note 计数从 by_category 取）
    function FactsInsight(props) {
      var st = props.stats || {}
      var query = props.query
      var byConf = {}
      ;(st.by_confidence || []).forEach(function (r) { byConf[r.confidence] = r.n })
      var chips = ['confirmed', 'tentative', 'deprecated'].filter(function (k) { return byConf[k] })
        .map(function (k) { return uiCore.insightChip('confidence', k, uiCore.CONF_LABEL[k], byConf[k], CONF_COLOR[k], query, '置信度') })
      if (st.with_edges) chips.push(uiCore.insightChip('has_edges', '1', '有关联', st.with_edges, T.business, query, '有图谱边（同域名/同网段自动建边或手工 fact_link）'))
      ;(st.by_mem_class || []).forEach(function (r) {
        if (uiCore.MEM_CLASS_LABEL[r.mem_class]) chips.push(uiCore.insightChip('mem_class', r.mem_class, uiCore.MEM_CLASS_LABEL[r.mem_class], r.n, MEM_CLASS_COLOR[r.mem_class], query, '记忆生命周期分类（memcore）：' + r.mem_class))
      })
      var byCat = {}
      ;(st.by_category || []).forEach(function (r) { if (r.category) byCat[r.category] = r.n })
      if (byCat.note) {
        var noteOn = query.filters.include_notes === '1'
        chips.push(el('button', {
          type: 'button', className: 'silksec-btn',
          style: { ...uiCore.styles.pill, cursor: 'pointer', height: 22, color: noteOn ? T.business : T.label3, background: noteOn ? T.layer2 : 'transparent' },
          title: 'note 类=agent 工作速记（14 天滚动消亡的 ephemeral）。默认隐藏防流水账淹没长期知识；点击' + (noteOn ? '隐藏' : '显示'),
          onClick: function () { query.setFilter('include_notes', noteOn ? '' : '1') },
        }, '工作速记 ' + byCat.note))
      }
      var cats = (st.by_category || []).filter(function (r) { return r.category && r.category !== 'note' })
        .slice(0, 8)
        .map(function (r) { return uiCore.insightChip('category', r.category, r.category, r.n, undefined, query, '事实分类') })
      if (!chips.length && !cats.length) return null
      return el('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', margin: '2px 0 8px' } },
        chips,
        st.pinned ? el('span', { style: uiCore.styles.pill, title: '置顶事实（排序恒在最前）' }, '📌 ' + st.pinned) : null,
        cats.length ? el('span', { style: { color: T.border3 } }, '|') : null,
        cats,
        el('span', { style: { marginLeft: 'auto', color: T.label3, ...uiCore.F.xxxs }, title: 'fact_edges 关系边总数（同域名/同网段自动建边 + 手工 fact_link）' }, '图谱 ' + (st.edges || 0) + ' 边 · ' + (st.total || 0) + ' 条'))
    }

    // 事实卡（含关联子图展开，F2）：edge_count>0 才显示「关联」，点开按需 factGraph 拉出/入边，
    // 关联事实可点击回填搜索——扁平列表升级为可遍历图谱，但不引入力导图（不过度）。
    // v4.1：补分类徽章（可点筛选）+ 搜索词高亮（复用 uiCore.hlText）。
    function FactCard(props) {
      var f = props.f
      var busy = props.busy
      var hl = props.hl
      var callRpc = props.callRpc
      var deprecated = f.confidence === 'deprecated'
      var exp = React.useState(false)
      var open = exp[0]; var setOpen = exp[1]
      var gs = React.useState(null)
      var graph = gs[0]; var setGraph = gs[1]
      function toggle() {
        var next = !open; setOpen(next)
        if (next && !graph) {
          callRpc('factGraph', { program_id: f.program_id, fact_key: f.fact_key })
            .then(function (res) { setGraph(res || { out: [], in: [] }) })
            .catch(function () { setGraph({ out: [], in: [] }) })
        }
      }
      function edgeBtn(e, dir) {
        var key = dir === 'out' ? e.dst_key : e.src_key
        return el('button', {
          key: dir + '|' + key + '|' + e.edge_type, type: 'button', className: 'silksec-btn',
          style: { fontFamily: uiCore.MONO, fontSize: 11, height: 24 },
          title: (dir === 'out' ? '出边 ' : '入边 ') + e.edge_type + ' · 点击检索该事实',
          onClick: function () { props.onSearchKey(key) },
        }, (dir === 'out' ? '→ ' : '← ') + e.edge_type + ' · ' + key)
      }
      return el('div', { style: { ...uiCore.styles.card, opacity: deprecated ? 0.55 : 1 } },
        el('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
          el('span', { style: { color: T.label, ...uiCore.F.sStrong, wordBreak: 'break-all' } }, uiCore.hlText(f.fact_key, hl, 'fk')),
          f.category
            ? el('button', {
                type: 'button', className: 'silksec-btn',
                style: { ...uiCore.styles.pill, cursor: 'pointer', height: 20, color: T.label3 },
                title: '事实分类（点击筛选该分类）',
                onClick: function () { props.onFilterCategory(f.category) },
              }, f.category)
            : null,
          uiCore.confPill(f.confidence),
          el('span', { style: { marginLeft: 'auto', color: T.label3, ...uiCore.F.xxxs } }, f.program_id),
          f.edge_count ? el('button', { type: 'button', className: 'silksec-btn', onClick: toggle, title: '查看关联事实（图谱边）' }, open ? '收起' : '关联 ' + f.edge_count) : null,
          el('button', { type: 'button', className: 'silksec-icon-btn', disabled: !!busy || deprecated, title: '纠正事实摘要', 'aria-label': '纠正事实', onClick: function () { props.onCorrect(f.program_id, f.fact_key, f.summary) } }, uiCore.opIcon('edit')),
          el('button', { type: 'button', className: 'silksec-icon-btn silksec-icon-btn-danger', disabled: !!busy || deprecated, title: '废弃事实（降置信为 deprecated，可再纠正恢复）', 'aria-label': '废弃事实', onClick: function () { props.onDeprecate(f.program_id, f.fact_key) } }, uiCore.opIcon('trash'))),
        f.summary ? el('div', { style: { color: T.label2, marginTop: 6, ...uiCore.F.xxs } }, uiCore.hlText(f.summary, hl, 'fs')) : null,
        open
          ? el('div', { style: { marginTop: 10, borderTop: '1px solid ' + T.border2, paddingTop: 8 } },
              graph
                ? ((graph.out && graph.out.length) || (graph.in && graph.in.length)
                    ? el('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
                        (graph.out || []).map(function (e) { return edgeBtn(e, 'out') }),
                        (graph.in || []).map(function (e) { return edgeBtn(e, 'in') }))
                    : el('span', { style: { color: T.label3, ...uiCore.F.xxs } }, '无关联事实'))
                : el('span', { style: { color: T.label3, ...uiCore.F.xxs } }, '加载关联…'))
          : null)
    }

    function FactsView(props) {
      var query = props.query
      var board = props.board || []
      var busy = props.busy
      return el('div', null,
        el(FactsInsight, { stats: props.stats, query: query }),
        el(uiCore.ViewBody, { query: query, emptyText: '暂无事实数据' }, function (facts) {
          return el('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
            facts.map(function (f) {
              return el(FactCard, {
                key: f.program_id + '/' + f.fact_key, f: f, busy: busy, hl: query.q, callRpc: props.callRpc,
                onCorrect: props.onCorrect, onDeprecate: props.onDeprecate, onSearchKey: props.onSearchKey,
                onFilterCategory: function (c) { query.setFilter('category', c) },
              })
            }))
        }),
        el('div', { style: { ...uiCore.styles.pageT, marginTop: 20 } }, '遗留黑板'),
        el('div', { style: uiCore.styles.pageSub }, '旧版扁平黑板（key/value，只读，待迁移进事实图谱）。'),
        board.length
          ? el('div', { style: { marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 } },
              board.map(function (b) {
                return el('div', { key: b.key, style: uiCore.styles.card },
                  el('div', { style: { color: T.label, ...uiCore.F.xxsStrong, wordBreak: 'break-all', fontFamily: uiCore.MONO, fontSize: 12 } }, b.key),
                  el('div', { style: { color: T.label2, marginTop: 4, ...uiCore.F.xxs, wordBreak: 'break-word' } }, String(b.value || '').slice(0, 2000)))
              }))
          : el(uiCore.EmptyState, { text: '暂无黑板数据' }))
    }

    // 域自足视图：自持 query/handler（与旧 PanelView facts 分支逐项等价）
    function FactView(props) {
      var api = props || {}
      var rpcCall = (typeof api.rpc === 'function') ? api.rpc : ownRpc
      var statsData = api.stats || {}
      var busyState = React.useState(false)
      var isBusy = busyState[0]; var setBusy = busyState[1]

      var factsQ = uiCore.usePagedQuery('facts', true, null, rpcCall)
      var boardState = uiCore.useRpc(function () { return { endpoint: 'blackboard' } }, [], rpcCall)
      var factStatsState = uiCore.useRpc(function () { return { endpoint: 'factStats' } }, [], rpcCall)

      function withBusy(fn) {
        return function () {
          if (isBusy) return
          setBusy(true)
          Promise.resolve().then(fn).catch(function (e) {
            console.error('[sec-dashboard-view-fact] 写操作失败:', e)
            try { window.alert('操作失败: ' + (e && e.message ? e.message : e)) } catch (e2) {}
          }).finally(function () {
            setBusy(false)
            factsQ.reload(); boardState.reload(); factStatsState.reload()
            if (typeof api.reloadShared === 'function') api.reloadShared()
          })
        }
      }
      function onDeprecate(programId, factKey) { withBusy(function () { return rpcCall('factDeprecate', { program_id: programId, fact_key: factKey }) })() }
      function onCorrect(programId, factKey, currentSummary) {
        var next = null
        try { next = window.prompt('纠正事实摘要（留空保持原样）:', currentSummary || '') } catch (e) { next = null }
        if (next === null) return
        withBusy(function () { return rpcCall('factCorrect', { program_id: programId, fact_key: factKey, summary: next }) })()
      }

      var wsItems = (api.workspaces && api.workspaces.items) || []
      var progOpts = wsItems.filter(function (w) { return w.program }).map(function (w) { return { v: w.program.id, l: w.title + '（' + w.program.id + '）' } })

      var factCats = (((factStatsState.data || {}).by_category) || []).filter(function (r) { return r.category })
        .map(function (r) { return { v: r.category, l: r.category + ' (' + r.n + ')' } })

      return el(React.Fragment, null,
        el(uiCore.Toolbar, {
          query: factsQ, placeholder: '搜索事实 key / 摘要 / 正文…',
          filters: [
            { key: 'category', label: '分类', options: factCats.length ? factCats : ['note', 'target', 'asset', 'finding', 'recon', 'infra'].map(function (c) { return { v: c, l: c } }) },
            { key: 'mem_class', label: '生命周期', options: [{ v: 'durable', l: '长期（30天复验）' }, { v: 'ephemeral', l: '时效（14天滚动）' }, { v: 'timeline', l: '时间线' }] },
            { key: 'confidence', label: '置信', options: Object.keys(uiCore.CONF_LABEL).map(function (k) { return { v: k, l: uiCore.CONF_LABEL[k] } }) },
            { key: 'has_edges', label: '关联', options: [{ v: '1', l: '仅有关联' }] },
            { key: 'sort', label: '排序', options: [{ v: 'edge_count', l: '关联最多' }, { v: 'category', l: '按分类' }] },
            { key: 'program_id', label: '工作区', options: progOpts },
          ],
        }),
        el(FactsView, {
          query: factsQ, stats: factStatsState.data, board: boardState.data,
          onDeprecate: onDeprecate, onCorrect: onCorrect,
          onSearchKey: function (k) { factsQ.setQ(k) }, busy: isBusy, callRpc: rpcCall,
        }))
    }

    // 域根：包 ui-core SilksecErrorBoundary（崩溃只炸该域 tab，经 bus.audit_tail 口径带 surface）；
    // ui-panel 亦会包一层，双保险且使本组件在任意承载面（含降级）都自足隔离。
    function FactRoot(props) {
      return el(uiCore.SilksecErrorBoundary, { surface: 'dashboard-view-fact', title: '事实' },
        el(FactView, props))
    }

    exports.name = 'silksec-sec-dashboard-view-fact'
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
          id: 'facts', label: '事实', order: 50, domain: 'fact',
          component: FactRoot, requires: ['connection'], source: 'dashboard-view-fact',
        })
        if (typeof uiCore.markSurfaceHealth === 'function') uiCore.markSurfaceHealth('sec-dashboard-view-fact', 'ok')
        return disposer
      }
      // 时序纪律：connection 到达后才注册（capacity 探测）；ctx.effect 收口 disposer。
      if (typeof ctx.inject === 'function') ctx.inject(['connection'], function () { if (typeof ctx.effect === 'function') ctx.effect(install); else install() })
      else if (typeof ctx.effect === 'function') ctx.effect(install)
      else install()
    }

    exports.FactRoot = FactRoot
    exports.FactView = FactView
    exports.FactsView = FactsView
    exports.FactCard = FactCard
    exports.FactsInsight = FactsInsight
    exports.CONF_COLOR = CONF_COLOR
    exports.MEM_CLASS_COLOR = MEM_CLASS_COLOR
    return module.exports
  },
})
