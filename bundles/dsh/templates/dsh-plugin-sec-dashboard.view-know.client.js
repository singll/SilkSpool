/**
 * @silksec/sec-dashboard-view-know — client half (browser bundle)，16-dashboard P6 逐域视图拆分。
 *
 * 「know（+学习）」域浏览视图（16-dashboard 知识/学习视图 + 16-dashboard §1.3「主面板视图」）。
 * 从旧单体 dsh-plugin-sec-dashboard.client.js 拆出，**自持 query/handler**、纯组件、
 * 无挂载感知：经 @silksec/ui-core 的 viewRegistry 注册，ui-panel 主面板按 order 装配。
 *
 * 契约（与旧 PanelView 的 knowledge/learning 分支逐项等价）：
 *   - 知识：memcore 记忆治理（卡片评分/晋升/编辑/弃置/导出）+ 经验卡 + 打法链 +
 *     知识体检 + 覆盖缺口 + 全景图 + 文献区（kbList/kbRead）+ 静态先验（rulesList/rulesRead）；
 *   - 学习：五问（学到了什么/依据/改善/在哪生效/如何恢复）+ 逐域视图 + 证据对照（learningTrace）
 *     + 受控撤回（learningRevokeRelease）；
 *   - 写：expFeedback/expPromote/expDeprecate/expUpdate/expExportable/learningRevokeRelease；
 *   - requires:['connection'] 缺席 → 不注册（tab 静默隐藏，不抛、不占 order）。
 *
 * 视觉遵循丝之歌主题规范：全部经 ui-core 令牌（--dsw-alias-* 等），本文件零颜色字面量。
 * 崩溃由 ui-panel 的 SilksecErrorBoundary 单面隔离；本包域根亦各包一层双保险。
 */
window.__ModuleLoader__.load({
  id: '@silksec/sec-dashboard-view-know',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    var React = require('react')
    var uiCore = null
    try { uiCore = require('@silksec/ui-core') } catch (e) { uiCore = null }
    var el = React.createElement

    // ── ui-core 令牌/共享件引用（不重定义；模块求值期以守卫规避 ui-core 缺席） ──
    var T = uiCore ? uiCore.T : {}
    var F = uiCore ? uiCore.F : {}
    var MONO = uiCore ? uiCore.MONO : ''
    var styles = (uiCore && uiCore.styles) || {}
    var pill = styles.pill
    var card = styles.card
    var cardL = styles.cardL
    var errorLine = styles.errorLine
    var tableStyle = styles.tableStyle
    var theadRow = styles.theadRow
    var th = styles.th
    var td = styles.td
    var tdMono = styles.tdMono
    var pageT = styles.pageT
    var SkeletonRows = uiCore ? uiCore.SkeletonRows : null
    var EmptyState = uiCore ? uiCore.EmptyState : null
    var DocModal = uiCore ? uiCore.DocModal : null
    var fmtTime = uiCore ? uiCore.fmtTime : function (x) { return x == null ? '—' : String(x) }
    var opIcon = uiCore ? uiCore.opIcon : function () { return null }

    // 本文件自查：零颜色字面量（令牌唯一合法来源 ui-core.T/styles）
    var inputStyle = { width: '100%', boxSizing: 'border-box' }

    // 自持 RPC（apply 时从 connection 捕获；ui-panel prop bag 的 rpc 作兜底）
    var serviceRef = { rpc: null }
    function ownRpc(endpoint, payload) {
      if (!serviceRef.rpc) return Promise.reject(new Error('连接通道不可用'))
      return serviceRef.rpc(endpoint, payload || {})
    }

    // ── 知识 tab（memcore 记忆治理的操作界面：卡片评分/晋升/编辑/弃置 + playbooks） ──
    function memStatusPill(status) {
      var c = status === 'active' ? T.success : status === 'candidate' ? T.warn : T.label3
      return el('span', { style: { ...pill, color: c } }, status || 'active')
    }
    function KnowledgeView(props) {
      var callRpc = props.callRpc || ownRpc
      var cards = (props.cardsState.data && props.cardsState.data.rows) || []
      var pbs = (props.pbsState.data && props.pbsState.data.rows) || []
      var mem = props.memState.data
      var kbRows = (props.kbState.data && props.kbState.data.rows) || []
      var kbCounts = (props.kbState.data && props.kbState.data.counts) || {}
      var factOv = props.factOvState.data || null
      var kbQfs = React.useState('')
      var kbQ = kbQfs[0]; var setKbQ = kbQfs[1]
      var kbKindfs = React.useState('')
      var kbKind = kbKindfs[0]; var setKbKind = kbKindfs[1]
      var kbReading = React.useState(null)
      var kbCur = kbReading[0]; var setKbCur = kbReading[1]
      function openKb(id, title) {
        setKbCur({ id: id, title: title, loading: true, content: null })
        callRpc('kbRead', { id: id }).then(function (res) {
          setKbCur({ id: id, title: res.title, loading: false, content: res.content, curated: res.curated, tainted: res.tainted, file: res.file })
        }).catch(function (e) { setKbCur({ id: id, title: title, loading: false, content: null, error: e && e.message ? e.message : String(e) }) })
      }
      function reloadKb() {
        props.kbState.reload && props.kbState.reload()
      }
      function act(fn) { if (props.busy) return; fn().then(function () { props.cardsState.reload() }).catch(function (e) { alert('操作失败: ' + (e && e.message ? e.message : e)) }) }
      function onFeedback(id, verdict) { act(function () { return callRpc('expFeedback', { id: id, verdict: verdict }) }) }
      function onPromote(id) {
        var reason = window.prompt('晋升理由（复盘评审通道：三闸门已过？）', '人工评审通过：可复用/有证据/已查重')
        if (!reason) return
        act(function () { return callRpc('expPromote', { id: id, reason: reason }) })
      }
      function onEdit(id, old) {
        var takeaway = window.prompt('修改 takeaway（一句话可操作结论）', old)
        if (takeaway === null || takeaway === old) return
        var just = window.prompt('修改理由（≥10字，memcore 强制）', '')
        if (!just || just.trim().length < 10) { alert('justification 不足 10 字，已取消'); return }
        act(function () { return callRpc('expUpdate', { id: id, takeaway: takeaway, justification: just }) })
      }
      function onDeprecate(id) {
        var reason = window.prompt('弃置理由（移入归档，可恢复）', '结论失效或无复用价值')
        if (!reason) return
        act(function () { return callRpc('expDeprecate', { id: id, reason: reason }) })
      }
      function onExportable(id, on) {
        act(function () { return callRpc('expExportable', { id: id, exportable: on }) })
      }
      var memChips = null
      if (mem && mem.loaded && mem.tables) {
        memChips = el('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', margin: '8px 0' } },
          Object.keys(mem.tables).map(function (t) {
            var parts = Object.keys(mem.tables[t]).map(function (s) { return s + ':' + mem.tables[t][s] }).join(' ')
            return el('span', { key: t, style: pill, title: 'memcore 治理状态分布' }, t + ' ' + parts)
          }))
      }
      // v4.5 知识体检：各存储点使用分布/零使用占比/到期预警（死库存与塌方风险一眼可见）
      var kh = mem && mem.knowledgeHealth ? mem.knowledgeHealth : null
      var healthCard = null
      if (kh) {
        var khRows = []
        if (kh.kb_docs) khRows.push(el('div', { key: 'kb', style: { ...F.xxs, color: T.label2, marginTop: 3 } },
          '知识库 kb_docs：' + kh.kb_docs.total + ' 篇（零使用 ' + kh.kb_docs.zero_use + ' = ' + Math.round(kh.kb_docs.zero_use_ratio * 100) + '%，cooling ' + kh.kb_docs.cooling + '，30天内到期 ' + kh.kb_docs.expiring_30d + '）'))
        if (kh.exp_cards) khRows.push(el('div', { key: 'ec', style: { ...F.xxs, color: T.label2, marginTop: 3 } },
          '经验卡 exp_cards：' + kh.exp_cards.total + ' 张（零使用 ' + kh.exp_cards.zero_use + '，candidate ' + kh.exp_cards.candidate + '，cooling ' + kh.exp_cards.cooling + '）'))
        if (kh.facts) khRows.push(el('div', { key: 'fa', style: { ...F.xxs, color: T.label2, marginTop: 3 } },
          '事实 facts：' + kh.facts.total + ' 条（cooling ' + kh.facts.cooling + '，复验逾期 ' + kh.facts.revalidate_overdue + '）'))
        if (kh.playbooks) khRows.push(el('div', { key: 'pb', style: { ...F.xxs, color: T.label2, marginTop: 3 } },
          '打法链 playbooks：' + kh.playbooks.total + ' 条（cooling ' + kh.playbooks.cooling + '）'))
        if (kh.fgs) khRows.push(el('div', { key: 'fg', style: { ...F.xxs, color: T.label2, marginTop: 3 } },
          'FGS 图：' + kh.fgs.nodes + ' 节点（已沉淀 facts ' + kh.fgs.persisted_facts + ' 条，任务 done 自动跨任务转正）'))
        var warnBits = []
        if (kh.kb_docs && kh.kb_docs.zero_use_ratio >= 0.8) warnBits.push('kb 零使用率 ≥80%——消费端未接通')
        if (kh.kb_docs && kh.kb_docs.expiring_30d > 50) warnBits.push(kh.kb_docs.expiring_30d + ' 篇 kb 30天内集中到期——塌方风险')
        if (kh.facts && kh.facts.revalidate_overdue > 100) warnBits.push('facts 复验逾期 ' + kh.facts.revalidate_overdue + ' 条')
        healthCard = el('div', { style: { ...card, marginTop: 10, padding: '8px 12px' }, title: 'memcore knowledgeHealth：调度任务 done 的 FGS 事实沉淀 + kb_search 消费激活后此表应逐步转好' },
          el('div', { style: { ...F.s, marginBottom: 4 } }, '📊 知识体检（v4.5）' + (warnBits.length ? ' ⚠ ' + warnBits.join('；') : '')),
          khRows)
      }
      // ── 覆盖缺口卡（攻面 × rules/VC 卡交叉表，借鉴 Claude-Red MINDMAP：空行即缺口）──
      // 数据来自 knowledgeCoverage RPC（服务端缓存 data/knowledge-coverage.json，缺失时现场 python3 生成）；
      // 结构/空态完全复用知识体检卡模式；缺口 = 无规则先验且无 VC 卡的攻面。
      var cov = props.covState ? props.covState.data : null
      var covData = null
      var covStaleNote = null
      if (cov && cov.ok !== false) covData = cov
      else if (cov && cov.stale) { covData = cov.stale; covStaleNote = '现场生成失败，展示旧数据：' + (cov.error || '') }
      var covOpenFs = React.useState(false)
      var covOpen = covOpenFs[0]; var setCovOpen = covOpenFs[1]
      var covBusyFs = React.useState(false)
      var covBusy = covBusyFs[0]; var setCovBusy = covBusyFs[1]
      function refreshCoverage() {
        if (covBusy) return
        setCovBusy(true)
        callRpc('knowledgeCoverage', { refresh: true }).then(function () {
          return props.covState.reload()
        }).catch(function (e) {
          alert('覆盖数据刷新失败: ' + (e && e.message ? e.message : e))
        }).then(function () { setCovBusy(false) })
      }
      var coverageCard = null
      if (!covData) {
        // 数据缺失：loading 骨架 / 引导文案（不报错）
        var covErr = (props.covState && props.covState.error) || (cov && cov.error) || ''
        coverageCard = el('div', { style: { ...card, marginTop: 10, padding: '8px 12px' }, title: '攻面分类表（secagent 手法族 15 + 常见 Web 攻面 21）对照 rules/ 与 vulncards/VC-*.yaml 的交叉表；生成走 scripts/pipeline/knowledge-coverage.py' },
          el('div', { style: { ...F.s, marginBottom: 4 } }, '🧭 覆盖缺口（攻面 × 先验交叉表）'),
          props.covState && props.covState.loading
            ? el(SkeletonRows, { rows: 2 })
            : el('div', { style: { ...F.xxs, color: T.label2 } },
                '暂无覆盖数据' + (covErr ? '（' + covErr + '）' : '') + '——在主机运行 knowledge-coverage.py 生成（scripts/pipeline/knowledge-coverage.py --out data/knowledge-coverage.json），或点击右侧「刷新」由看板现场生成。'))
      } else {
        var covTax = covData.taxonomy || []
        var covGaps = covTax.filter(function (t) { return !(t.covered_by_rules || []).length && !(t.covered_by_cards || []).length })
        var covNoCard = covTax.filter(function (t) { return (t.covered_by_rules || []).length && !(t.covered_by_cards || []).length })
        var covCovered = covTax.filter(function (t) { return (t.covered_by_rules || []).length })
        var covS = covData.summary || {}
        var covWarn = covStaleNote
        coverageCard = el('div', { style: { ...card, marginTop: 10, padding: '8px 12px' }, title: '攻面分类表（secagent 手法族 15 + 常见 Web 攻面 21）对照 rules/ 与 vulncards/VC-*.yaml 的交叉表；空行 = 无任何先验覆盖' },
          el('div', { style: { ...F.s, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
            el('span', null, '🧭 覆盖缺口（' + covCovered.length + '/' + covTax.length + ' 攻面有规则覆盖' + (covS.coverage_pct !== undefined ? ' · ' + covS.coverage_pct + '%' : '') + '）'),
            el('button', { type: 'button', className: 'silksec-btn', style: { height: 22, fontSize: 12 }, disabled: covBusy, title: '现场调 python3 跑 knowledge-coverage.py 重新生成（结果缓存 7 天）', onClick: refreshCoverage }, covBusy ? '生成中…' : '刷新'),
            el('span', { style: { ...F.xxs, color: T.label3 } }, '生成于 ' + String(covData.generated_at || '').slice(0, 16).replace('T', ' ') + (covData.cached ? ' · 缓存' : ''))),
          covWarn ? el('div', { style: { ...F.xxs, color: T.warn, marginTop: 2 } }, '⚠ ' + covWarn) : null,
          covData.vulncards_note ? el('div', { style: { ...F.xxs, color: T.warn, marginTop: 2 } }, '⚠ ' + covData.vulncards_note) : null,
          covGaps.length === 0
            ? el('div', { style: { ...F.xxs, color: T.label2, marginTop: 3 } }, '✅ 无攻面缺口（每个攻面至少有规则先验或 VC 卡覆盖）')
            : el('div', { style: { marginTop: 4 } },
                el('div', { style: { ...F.xxs, color: T.warn } }, '缺口攻面（无规则无卡片，' + covGaps.length + '）：'),
                el('div', { style: { display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 3 } },
                  covGaps.map(function (t) { return el('span', { key: t.id, style: { ...pill, color: T.warn } }, t.name) }))),
          covNoCard.length
            ? el('div', { style: { marginTop: 5 } },
                el('button', { type: 'button', className: 'silksec-btn', style: { height: 22, fontSize: 12, padding: '0 8px' }, onClick: function () { setCovOpen(!covOpen) }, title: '有规则先验但没有 VC 卡规程——按模块规程手工出枪，可考虑 IC 提案固化' },
                  (covOpen ? '▾ ' : '▸ ') + '有规则无 VC 卡（' + covNoCard.length + '）'),
                covOpen
                  ? el('div', { style: { display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 3 } },
                      covNoCard.map(function (t) { return el('span', { key: t.id, style: { ...pill, color: T.label2 } }, t.name) }))
                  : null)
            : null)
      }
      // v4.6 知识全景图：六类型分区导航（每类知识一个位置一个工具，类型间正交不合并）
      var typeSections = [
        { icon: '🧠', name: '经验类', where: 'exp_cards 表', tool: 'exp_search', n: cards.length, extra: (pbs.length ? '+ 打法链 ' + pbs.length : '') },
        { icon: '🌍', name: '事实类', where: 'facts 表', tool: 'fact_search', n: factOv ? factOv.total : '—', extra: (factOv && factOv.byCategory) ? (Object.keys(factOv.byCategory).length + ' 分类') : '' },
        { icon: '📚', name: '文献类', where: 'kb_docs + knowledge/ + rules/', tool: 'kb_search', n: kbCounts.curated !== undefined ? (kbCounts.curated + kbCounts.external) : '—', extra: (kbCounts.curated || 0) + ' curated + ' + (kbCounts.external || 0) + ' external' },
        { icon: '📋', name: '规程类', where: 'vulncards/*.yaml + rules/src', tool: '按指纹读卡', n: '18 VC', extra: '人工版本受控' },
        { icon: '🧭', name: '任务内类', where: 'fgs_nodes（任务生命周期）', tool: 'fgs_next', n: (kh && kh.fgs ? kh.fgs.nodes : '—'), extra: kh && kh.fgs ? ('沉淀 ' + kh.fgs.persisted_facts + ' facts') : '' },
        { icon: '⚠️', name: '环境类', where: 'blackboard（纯环境层）', tool: 'blackboard_get', n: factOv && factOv.blackboard ? factOv.blackboard.active : '—', extra: factOv && factOv.blackboard ? ('env-issue ' + factOv.blackboard.envIssues) : '' },
      ]
      var panorama = el('div', { style: { ...card, marginTop: 10, padding: '10px 12px' }, title: 'v4.6 按类型归一：每类知识一个位置一个工具；任务开局三步检索顺序 fact_search → exp_search → kb_search' },
        el('div', { style: { ...F.s, marginBottom: 6 } }, '🗺️ 知识全景（v4.6 六类型 · 一类一位一工具）'),
        el('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: 6 } },
          typeSections.map(function (t) {
            return el('div', { key: t.name, style: { padding: '6px 8px', background: T.layer2, borderRadius: 6, cursor: 'default' } },
              el('div', { style: { ...F.xs } }, t.icon + ' ' + t.name + '　', el('span', { style: { fontFamily: MONO, fontSize: 12, color: T.business } }, String(t.n)), t.extra ? el('span', { style: { ...F.xxs, color: T.label3 } }, '　' + t.extra) : null),
              el('div', { style: { ...F.xxs, color: T.label2 } }, t.where),
              el('div', { style: { ...F.xxs, color: T.label3 } }, '工具: ' + t.tool))
          })))
      return el('div', null,
        memChips,
        healthCard,
        coverageCard,
        panorama,
        el('div', { style: { ...cardL, margin: '10px 0 6px' }, title: 'v4.6 合并①：打法链已并入本表（kind 标记）。评分 = adopted×3 + 👍×2 + uses×0.5 − 👎×5 − 时效衰减' }, '🧠 经验类（exp_cards）· 经验卡 + 打法链同表 · candidate / active / cooling'),
        props.cardsState.loading ? el(SkeletonRows, { rows: 5 }) : cards.length === 0
          ? el(EmptyState, { text: '暂无经验卡' })
          : el('table', { style: tableStyle },
              el('colgroup', null,
                el('col', { style: { width: 40 } }), el('col', { style: { width: '22%' } }), el('col', null),
                el('col', { style: { width: 56 } }), el('col', { style: { width: 64 } }), el('col', { style: { width: 78 } }), el('col', { style: { width: 186 } })),
              el('thead', null, el('tr', { style: theadRow },
                el('th', { style: th }, '#'), el('th', { style: th }, '场景'), el('th', { style: th }, '结论（takeaway）'),
                el('th', { style: th }, '评分'), el('th', { style: th }, '使用'), el('th', { style: th }, '状态'), el('th', { style: th }, '操作'))),
              el('tbody', null, cards.map(function (c) {
                return el('tr', { key: c.id, className: 'silksec-row' },
                  el('td', { style: tdMono }, String(c.id)),
                  el('td', { style: td, title: c.scenario }, c.kind === 'playbook' ? el('span', null, el('span', { style: { ...pill, color: T.business } }, '链'), ' ', c.scenario) : c.scenario),
                  el('td', { style: td, title: c.takeaway }, c.takeaway),
                  el('td', { style: tdMono, title: '评分 = adopted×3 + 👍×2 + uses×0.5 − 👎×5 − 时效衰减' }, String(c.score !== undefined ? c.score : '—')),
                  el('td', { style: { ...tdMono, title: 'uses / adopted / 👍 / 👎' } }, c.uses !== undefined ? c.uses + '/' + c.adopted + '/' + c.pos_fb + '/' + c.neg_fb : '—'),
                  el('td', { style: td }, memStatusPill(c.status)),
                  el('td', { style: { ...td, whiteSpace: 'nowrap' } },
                    el('div', { style: { display: 'inline-flex', gap: 4 } },
                      el('button', { type: 'button', className: 'silksec-icon-btn', disabled: props.busy, title: '有用（正反馈，评分 +2）', 'aria-label': '有用', onClick: function () { onFeedback(c.id, 'useful') } }, '👍'),
                      el('button', { type: 'button', className: 'silksec-icon-btn', disabled: props.busy, title: '错误 / 过时（负反馈，评分 −5）', 'aria-label': '错误或过时', onClick: function () { onFeedback(c.id, 'wrong') } }, '👎'),
                      c.status !== 'active' ? el('button', { type: 'button', className: 'silksec-icon-btn silksec-icon-btn-confirm', disabled: props.busy, title: '晋升为 active（需评审理由，三闸门）', 'aria-label': '晋升', onClick: function () { onPromote(c.id) } }, opIcon('up')) : null,
                      c.exportable !== undefined ? el('button', { type: 'button', className: 'silksec-icon-btn' + (c.exportable ? ' silksec-icon-btn-confirm' : ''), disabled: props.busy, title: c.exportable ? '已标记导出（点击取消）：每日 sweeper 推送到 Bellkeeper vault/安全经验，scope 脱敏硬门' : '标记可导出（推送到 Bellkeeper vault/安全经验）', 'aria-label': '导出开关', onClick: function () { onExportable(c.id, c.exportable ? 0 : 1) } }, opIcon('download')) : null,
                      el('button', { type: 'button', className: 'silksec-icon-btn', disabled: props.busy, title: '修改 takeaway（需 ≥10 字理由）', 'aria-label': '编辑', onClick: function () { onEdit(c.id, c.takeaway) } }, opIcon('edit')),
                      el('button', { type: 'button', className: 'silksec-icon-btn silksec-icon-btn-danger', disabled: props.busy, title: '弃置（移入归档，可恢复）', 'aria-label': '弃置', onClick: function () { onDeprecate(c.id) } }, opIcon('trash')))))
              }))),
        el('div', { style: { ...cardL, margin: '18px 0 6px' }, title: 'v4.6 合并①：playbooks 已并入 exp_cards（kind=playbook）。此视图读同表数据，统计打点 pb_outcome 改写为卡分数反馈' }, '🧭 打法链（exp_cards kind=playbook · v4.6 已并入经验表）· 只读'),
        props.pbsState.loading ? el(SkeletonRows, { rows: 3 }) : pbs.length === 0
          ? el(EmptyState, { text: '暂无 playbook' })
          : el('table', { style: tableStyle },
              el('colgroup', null, el('col', null), el('col', { style: { width: 70 } }), el('col', { style: { width: 80 } }), el('col', { style: { width: 78 } }), el('col', { style: { width: 110 } })),
              el('thead', null, el('tr', { style: theadRow },
                el('th', { style: th }, '名称'), el('th', { style: th }, '运行'), el('th', { style: th }, '成功率'), el('th', { style: th }, '状态'), el('th', { style: th }, '最近运行'))),
              el('tbody', null, pbs.map(function (pb) {
                return el('tr', { key: pb.name, className: 'silksec-row' },
                  el('td', { style: td, title: pb.name }, pb.name),
                  el('td', { style: tdMono }, String(pb.runs)),
                  el('td', { style: tdMono }, String(pb.success_rate)),
                  el('td', { style: td }, memStatusPill(pb.status)),
                  el('td', { style: tdMono }, isFinite(Number(pb.last_run_at)) ? new Date(Number(pb.last_run_at)).toISOString().slice(0, 10) : '—'))
              }))),
        KbSection({ rows: kbRows, counts: kbCounts, q: kbQ, setQ: setKbQ, kind: kbKind, setKind: setKbKind, loading: props.kbState.loading, onOpen: openKb, onReload: reloadKb, busy: props.busy }),
        el(RulesSection, props),
        kbCur ? el(DocModal, {
          open: true, onClose: function () { setKbCur(null) }, errorPrefix: '读取',
          title: (kbCur.title || '文献').slice(0, 60),
          sub: (kbCur.curated ? 'curated · 人工蒸馏高置信 · ' : 'external · 外部文献低置信 · ') + (kbCur.tainted ? '⚠ tainted 疑似注入 ' : '') + (kbCur.file || ''),
          state: kbCur,
        }) : null)
    }

    // ── v4.6 文献区（kb_docs：curated 人工蒸馏 + external 外部文献统一浏览）──
    // 合并③后 kb_docs 是文献类唯一索引面：curated 行 file 指向 rules/（版本受控），external 行指向 knowledge/。
    // 只读浏览 + kbRead 打开正文；写入仍走 kb_import / seed-skills.sh。
    function KbSection(props) {
      var all = props.rows || []
      var counts = props.counts || {}
      // 客户端过滤（kbList 全量 ≤200 行）：q 标题/路径子串 + kind curated/external
      var q = (props.q || '').toLowerCase()
      var rows = all.filter(function (r) {
        if (props.kind === 'curated' && !r.curated) return false
        if (props.kind === 'external' && r.curated) return false
        if (q && (r.title || '').toLowerCase().indexOf(q) < 0 && (r.file || '').toLowerCase().indexOf(q) < 0) return false
        return true
      })
      function kindBtn(v, label, n) {
        return el('button', {
          key: v, type: 'button', className: 'silksec-tab', style: { height: 24, fontSize: 12 },
          'data-on': props.kind === v ? 'true' : undefined,
          onClick: function () { props.setKind(v) },
        }, label + (n !== undefined ? ' ' + n : ''))
      }
      return el('div', null,
        el('div', { style: { ...cardL, margin: '18px 0 6px' }, title: 'v4.6 合并③：rules 56 篇与外部文献统一进 kb_search 检索面（curated 排序在前）。文件物理位置不动；写入走 kb_import / seed-skills.sh' },
          '📚 文献类（kb_docs · curated 人工蒸馏 ' + (counts.curated || 0) + ' + external 外部文献 ' + (counts.external || 0) + ' · 零使用 ' + (counts.zero_use || 0) + '）'),
        el('div', { style: { display: 'flex', gap: 8, alignItems: 'center', margin: '6px 0' } },
          el('input', {
            className: 'silksec-input', style: { ...inputStyle, width: 240 }, placeholder: '搜索标题/路径…',
            value: props.q, onChange: function (e) { props.setQ(e.target.value) },
          }),
          kindBtn('', '全部'),
          kindBtn('curated', 'curated', counts.curated),
          kindBtn('external', 'external', counts.external),
          counts.tainted ? el('span', { style: { ...pill, color: T.warn } }, 'tainted ' + counts.tainted) : null),
        props.loading ? el(SkeletonRows, { rows: 4 }) : rows.length === 0
          ? el(EmptyState, { text: '无匹配文献' })
          : el('table', { style: tableStyle },
              el('colgroup', null, el('col', { style: { width: '40%' } }), el('col', { style: { width: 70 } }), el('col', { style: { width: 56 } }), el('col', { style: { width: 60 } }), el('col', { style: { width: 90 } })),
              el('thead', null, el('tr', { style: theadRow },
                el('th', { style: th }, '标题'), el('th', { style: th }, '类型'), el('th', { style: th }, '使用'), el('th', { style: th }, '状态'), el('th', { style: th }, '查看'))),
              el('tbody', null, rows.map(function (r) {
                return el('tr', {
                  key: r.id, className: 'silksec-row', style: { cursor: 'pointer' },
                  onClick: function () { props.onOpen(r.id, r.title) },
                },
                  el('td', { style: td, title: r.title + ' · ' + r.file },
                    r.curated ? el('span', { style: { ...pill, color: T.business, marginRight: 6 } }, 'curated') : null,
                    r.tainted ? el('span', { style: { ...pill, color: T.warn, marginRight: 6 } }, 'tainted') : null,
                    (r.title || '').slice(0, 60),
                    el('span', { style: { color: T.label3, marginLeft: 8, ...F.xxs, fontFamily: MONO } }, (r.file || '').replace(/^.*\/(data\/)?(knowledge|rules)\//, ''))),
                  el('td', { style: tdMono }, r.curated ? '人工蒸馏' : '外部'),
                  el('td', { style: tdMono }, String(r.uses !== undefined && r.uses !== null ? r.uses : '—')),
                  el('td', { style: td }, memStatusPill(r.curated ? 'active' : (r.status || 'active'))),
                  el('td', { style: td }, el('button', { type: 'button', className: 'silksec-icon-btn', title: '查看文献正文', 'aria-label': '查看', onClick: function (e) { e.stopPropagation(); props.onOpen(r.id, r.title) } }, opIcon('eye'))))
              }))))
    }

    // ── 静态先验 rules/（v4.4：人工蒸馏先验层的看板观测入口——此前只进 agent 提示词，无任何 UI）──
    // 按 dir 分组（src 定级闸 / srcskill 方法论 / techniques 手法模块 / web 组件先验），只读；
    // 写入口是 seed-skills.sh 版本受控通道，看板不提供编辑。
    function RulesSection(props) {
      var callRpc = props.callRpc || ownRpc
      var rows = (props.rulesState.data && props.rulesState.data.rows) || []
      var reading = React.useState(null)
      var cur = reading[0]; var setCur = reading[1]
      var qfs = React.useState('')
      var qf = qfs[0]; var setQf = qfs[1]
      function open(file) {
        setCur({ file: file, loading: true, content: null })
        callRpc('rulesRead', { file: file }).then(function (res) {
          setCur({ file: file, loading: false, content: res.content })
        }).catch(function (e) {
          setCur({ file: file, loading: false, content: null, error: e && e.message ? e.message : String(e) })
        })
      }
      var filtered = qf ? rows.filter(function (r) { return r.file.toLowerCase().indexOf(qf.toLowerCase()) >= 0 || (r.title || '').toLowerCase().indexOf(qf.toLowerCase()) >= 0 }) : rows
      var groups = {}
      filtered.forEach(function (r) {
        var g = r.dir || '.'
        ;(groups[g] = groups[g] || []).push(r)
      })
      var groupKeys = Object.keys(groups).sort()
      var groupLabel = { '.': '根', 'src': 'src · 定级与准入闸', 'srcskill': 'srcskill · 实战方法论（dig-scope / vuln-report-format）', 'techniques': 'techniques · 手法模块（srcskill 知识库 46 篇 + 短表索引）', 'web': 'web · 组件先验', 'php': 'php · 框架先验' }
      return el('div', null,
        el('div', { style: { ...cardL, margin: '18px 0 6px' }, title: '人工蒸馏静态先验：agent 开局/提请时按需读取（technique-index 认现场特征→techniques 模块看细节）；vault 同步在 SilkSecAgent/静态先验/' }, '📚 静态先验 rules/（只读 · ' + rows.length + ' 篇 · 点击行查看）'),
        el('div', { style: { display: 'flex', gap: 8, alignItems: 'center', margin: '6px 0' } },
          el('input', {
            className: 'silksec-input', style: { ...inputStyle, width: 240 }, placeholder: '搜索文件/标题…',
            value: qf, onChange: function (e) { setQf(e.target.value) },
          })),
        props.rulesState.loading ? el(SkeletonRows, { rows: 4 }) : filtered.length === 0
          ? el(EmptyState, { text: '无匹配先验文件' })
          : el('div', null, groupKeys.map(function (g) {
              return el('div', { key: g, style: { marginTop: 10 } },
                el('div', { style: { ...pageT, display: 'flex', alignItems: 'center', gap: 6 } },
                  el('span', { style: { fontFamily: MONO, fontSize: 12, color: T.business } }, groupLabel[g] || g),
                  el('span', { style: { ...pill, color: T.label3 } }, groups[g].length + ' 篇')),
                el('table', { style: tableStyle },
                  el('colgroup', null, el('col', null), el('col', { style: { width: 90 } }), el('col', { style: { width: 60 } })),
                  el('thead', null, el('tr', { style: theadRow },
                    el('th', { style: th }, '文件 / 标题'), el('th', { style: th }, '大小'), el('th', { style: th }, '查看'))),
                  el('tbody', null, groups[g].map(function (r) {
                    return el('tr', {
                      key: r.file, className: 'silksec-row',
                      style: { cursor: 'pointer' }, title: '点击查看（Modal 打开，只读）',
                      onClick: function () { open(r.file) },
                    },
                      el('td', { style: tdMono, title: (r.title || '') + ' · ' + r.file }, (r.title || '').slice(0, 70) || '📄 ' + r.file,
                        el('span', { style: { color: T.label3, marginLeft: 8 } }, r.file)),
                      el('td', { style: tdMono }, (r.size / 1024).toFixed(1) + ' KB'),
                      el('td', { style: td }, el('button', { type: 'button', className: 'silksec-icon-btn', title: '查看先验（Modal 打开）', 'aria-label': '查看', onClick: function (e) { e.stopPropagation(); open(r.file) } }, opIcon('eye'))))
                  }))))
            })),
        cur ? el(DocModal, {
          open: true, onClose: function () { setCur(null) }, errorPrefix: '读取',
          title: String(cur.file || '').split('/').pop(),
          sub: '只读先验 · rules/' + cur.file + ' · 修改走 seed-skills.sh 版本受控通道',
          state: cur,
        }) : null)
    }

    // ── 学习面板（L6，学习专项 §10 看板五问口径）────────────────────────────
    // 普通业务语言五问：学到了什么 / 依据是什么 / 比旧版改善多少 / 在哪生效 / 如何恢复旧版。
    // 技术字段（episode/outbox/run_id 等）收进展开详情，不要求用户理解。
    // 写操作只有「撤回」（C27 know_release_revoke 受控动词，面板不直写台账）。
    var EPISODE_OUTCOME_LABEL = {
      verified_positive: '已证实有效', verified_negative: '已排除误报', inconclusive: '未定论',
      infra_error: '执行出错', hypothesis_rejected: '假设被否', model_proposed: '模型自评',
    }
    var RELEASE_STATUS_LABEL = { active: '生效中', superseded: '已被取代', revoked: '已撤回' }
    var RELEASE_STATUS_COLOR = { active: T.success, superseded: T.label3, revoked: T.error }
    var REVISION_STATUS_LABEL = { candidate: '候选', evaluating: '评测中', eligible: '评测通过', rejected: '评测未过', published: '已发布', reverted: '已回退' }
    var CONFIDENCE_LABEL = function (c) { return c === 'high' ? '样本充分' : c === 'medium' ? '样本中等' : '小样本·结论保守' }

    function LearningView(props) {
      var callRpc = props.callRpc || ownRpc
      var state = props.state
      var busy = props.busy
      var ts = React.useState(0)
      var tick = ts[0]; var reload = function () { ts[1](function (t) { return t + 1 }); props.state.reload && props.state.reload() }
      var sel = React.useState(null)
      var traceSel = sel[0]; var setTraceSel = sel[1]
      var tr = React.useState({ loading: false, data: null, error: null })
      var trace = tr[0]; var setTrace = tr[1]

      function openTrace(selKey) {
        setTraceSel(selKey)
        setTrace({ loading: true, data: null, error: null })
        callRpc('learningTrace', selKey).then(function (data) {
          setTrace({ loading: false, data: data, error: null })
        }).catch(function (e) {
          setTrace({ loading: false, data: null, error: e && e.message ? e.message : String(e) })
        })
      }
      function onRevoke(rel) {
        var reason = window.prompt('撤回理由（≥10 字，留痕可审计）。撤回后系统自动恢复该范围上一版本：', '')
        if (!reason || reason.trim().length < 10) { if (reason !== null) alert('理由不足 10 字，已取消'); return }
        if (busy) return
        callRpc('learningRevokeRelease', { release_id: rel.release_id, reason: reason })
          .then(function () { alert('已撤回，该范围上一版本已恢复生效'); reload(); if (traceSel) openTrace(traceSel) })
          .catch(function (e) { alert('撤回失败: ' + (e && e.message ? e.message : e)) })
      }

      if (state.error) return el('div', { style: errorLine }, '学习面板加载失败: ' + state.error)
      if (!state.data) return el(SkeletonRows, null)
      var d = state.data

      function qCard(title, body, extra) {
        return el('div', { key: title, style: { ...card, marginTop: 10 } },
          el('div', { style: { color: T.label, ...F.sStrong } }, title),
          el('div', { style: { ...cardL, marginTop: 6, lineHeight: '18px' } }, body),
          extra || null)
      }

      // ── 证据对照（trace 展开区）─────────────────────────────────────────
      var tracePane = null
      if (traceSel) {
        var chain = trace.data && trace.data.chain
        var links = trace.data && trace.data.links
        tracePane = el('div', { style: { ...card, marginTop: 10, borderColor: 'color-mix(in srgb, ' + T.brand + ' 40%, transparent)' } },
          el('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
            el('span', { style: { color: T.label, ...F.sStrong } }, '证据对照'),
            el('span', { style: { ...pill, fontFamily: MONO } }, (traceSel.episode_id || (traceSel.artifact_kind + '/' + traceSel.artifact_id))),
            el('button', { type: 'button', className: 'silksec-btn', style: { marginLeft: 'auto', height: 24 }, onClick: function () { setTraceSel(null); setTrace({ loading: false, data: null, error: null }) } }, '收起')),
          trace.loading ? el(SkeletonRows, null)
            : trace.error ? el('div', { style: errorLine }, trace.error)
            : !chain ? null
            : el('div', null,
                // 链节①：学习记录（episode→证据清单）
                el('div', { style: { ...cardL, marginTop: 8, ...F.xxsStrong, color: T.label2 } }, '① 学习记录（每次执行学到的东西 + 证据引用）'),
                (chain.episodes || []).length === 0 ? el('div', { style: cardL }, '（无）') :
                el('div', null, (chain.episodes || []).slice(0, 10).map(function (e) {
                  return el('div', { key: e.episode_id, style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginTop: 4 } },
                    el('span', { style: { ...pill, color: e.outcome === 'verified_positive' ? T.success : e.outcome === 'verified_negative' || e.outcome === 'infra_error' ? T.warn : T.label2 }, title: '六类结果之一（episode 口径）' }, EPISODE_OUTCOME_LABEL[e.outcome] || e.outcome),
                    el('span', { style: { ...pill, fontFamily: MONO }, title: 'episode_id' }, e.episode_id.slice(0, 18)),
                    e.program_id ? el('span', { style: pill }, e.program_id) : null,
                    (e.evidence_refs || []).length ? el('span', { style: { ...pill, color: T.business }, title: (e.evidence_refs || []).join('\n') }, '证据 ' + (e.evidence_refs || []).length) : null,
                    e.fgs_snapshot_hash ? el('span', { style: { ...pill, fontFamily: MONO }, title: '执行快照哈希（不可变留痕）' }, '快照 ' + String(e.fgs_snapshot_hash).slice(0, 8)) : null,
                    e.cost && (e.cost.requests || e.cost.tokens) ? el('span', { style: pill, title: '成本：模型请求/Token/耗时' }, '成本 ' + (e.cost.tokens || 0) + ' tok') : null,
                    el('span', { style: { marginLeft: 'auto', color: T.label3, ...F.xxxs } }, fmtTime(e.created_at)))
                })),
                // 链节②：候选版本（→评测报告）
                el('div', { style: { ...cardL, marginTop: 10, ...F.xxsStrong, color: T.label2 } }, '② 候选版本（每次学习沉淀成什么改动 + 评测结论）'),
                (chain.revisions || []).length === 0 ? el('div', { style: cardL }, '（无）') :
                el('div', null, (chain.revisions || []).map(function (r) {
                  return el('div', { key: r.revision_id, style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginTop: 4 } },
                    el('span', { style: { ...pill, fontFamily: MONO }, title: 'revision_id · 内容哈希 ' + (r.content_digest || '').slice(0, 16) }, r.revision_id),
                    el('span', { style: { ...pill, color: r.status === 'published' ? T.success : r.status === 'eligible' ? T.business : r.status === 'rejected' || r.status === 'reverted' ? T.error : T.label2 } }, REVISION_STATUS_LABEL[r.status] || r.status),
                    r.eval_report_ref ? el('span', { style: { ...pill, color: T.business }, title: '独立评测报告引用（eval 域）' }, '评测 ✓') : null,
                    r.change_note ? el('span', { style: { color: T.label3, ...F.xxxs }, title: r.change_note }, String(r.change_note).slice(0, 60)) : null,
                    el('span', { style: { marginLeft: 'auto', color: T.label3, ...F.xxxs } }, fmtTime(r.created_at)))
                })),
                // 链节③：发布账本（→批准→生效范围；撤回入口）
                el('div', { style: { ...cardL, marginTop: 10, ...F.xxsStrong, color: T.label2 } }, '③ 发布账本（在哪生效 / 如何恢复旧版）'),
                (chain.releases || []).length === 0 ? el('div', { style: cardL }, '（尚未发布——候选还不在任何范围生效）') :
                el('div', null, (chain.releases || []).map(function (rel) {
                  return el('div', { key: rel.release_id, style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginTop: 4 } },
                    el('span', { style: { ...pill, color: RELEASE_STATUS_COLOR[rel.status] || T.label2 } }, RELEASE_STATUS_LABEL[rel.status] || rel.status),
                    el('span', { style: pill, title: '生效范围' }, rel.scope_type === 'global' ? '全局' : (rel.scope_type === 'family' ? '漏洞族 ' + rel.scope_id : '项目 ' + rel.scope_id)),
                    el('span', { style: { ...pill, fontFamily: MONO }, title: '发布版本' }, rel.revision_id),
                    rel.auth_ref ? el('span', { style: { ...pill, color: T.business }, title: '批准凭据（审批单引用）' }, '批准 ✓') : null,
                    rel.status === 'active'
                      ? el('button', { type: 'button', className: 'silksec-btn silksec-icon-btn-danger', disabled: !!busy, style: { height: 24 }, title: '撤回此发布（受控动词 C27）：系统恢复该范围上一版本生效', onClick: function () { onRevoke(rel) } }, '撤回')
                      : null,
                    rel.status === 'revoked' && rel.reason ? el('span', { style: { color: T.label3, ...F.xxxs }, title: rel.reason }, '撤回原因: ' + String(rel.reason).slice(0, 60)) : null,
                    el('span', { style: { marginLeft: 'auto', color: T.label3, ...F.xxxs } }, fmtTime(rel.created_at)))
                })),
                // 链节④：采用与反馈（→实际结果）
                el('div', { style: { ...cardL, marginTop: 10, ...F.xxsStrong, color: T.label2 } }, '④ 实际结果（被用过几次 / 效果如何 / 人工反馈）'),
                el('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 } },
                  el('span', { style: pill, title: '检索命中后实际展示/注入次数（不等于有效）' }, '曝光 ' + ((chain.exposures && chain.exposures.total) || 0)),
                  el('span', { style: pill, title: 'worker 实际采纳次数（references 声明）' }, '采用 ' + ((chain.adoptions && chain.adoptions.total) || 0)),
                  (chain.feedback || []).length ? el('span', { style: pill, title: '人工反馈（有用/错误）' }, '反馈 ' + chain.feedback.length) : null,
                  chain.score ? el('span', { style: { ...pill, color: T.business }, title: '计分投影（可重放重建；样本量与不确定性见逐域视图）' }, '计分 ' + chain.score.score + ' · 样本 ' + chain.score.sample_size) : null),
                (links && (links.eval_report_refs || []).length) ? el('div', { style: { ...cardL, marginTop: 6, fontFamily: MONO, wordBreak: 'break-all' } }, '评测报告: ' + links.eval_report_refs.join('，')) : null,
                (links && (links.approval_refs || []).length) ? el('div', { style: { ...cardL, marginTop: 2, fontFamily: MONO, wordBreak: 'break-all' } }, '批准凭据: ' + links.approval_refs.join('，')) : null))
      }

      // ── 逐域视图（三层：漏洞类型族 / 技术栈面 / 身份前置）─────────────────
      function domainTable(title, rows) {
        if (!rows || !rows.length) return null
        return el('div', { style: { marginTop: 8 } },
          el('div', { style: { ...F.xxsStrong, color: T.label2 } }, title),
          el('div', null, rows.slice(0, 12).map(function (g) {
            return el('div', { key: g.key, style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginTop: 4 } },
              el('span', { style: { color: T.label, ...F.xs, minWidth: 90 } }, g.key),
              el('span', { style: pill, title: '该分组下的知识卡数' }, '卡 ' + g.artifacts),
              el('span', { style: pill }, '曝光 ' + g.exposures),
              el('span', { style: pill }, '采用 ' + g.adoptions),
              el('span', { style: { ...pill, color: T.success }, title: '已证实有效的学习记录数' }, '有效 ' + g.verified_positives),
              el('span', { style: { ...pill, color: T.warn }, title: '排除误报/无效方向' }, '排除 ' + g.valid_cleans),
              el('span', { style: { ...pill, color: g.confidence.indexOf('low') === 0 ? T.warn : T.label2 }, title: '样本量 ' + g.sample_size + '（小样本结论保守，沿用 L5 平滑口径）' }, '样本 ' + g.sample_size + ' · ' + CONFIDENCE_LABEL(g.confidence)),
              el('span', { style: pill, title: '成本：模型请求 ' + g.cost.requests + ' · Token ' + g.cost.tokens + ' · 耗时 ' + Math.round((g.cost.ms || 0) / 60000) + ' 分钟' }, '成本 ' + (g.cost.tokens || 0) + ' tok'),
              el('span', { style: { ...pill, color: T.business }, title: '平滑计分（0-1，sample/(sample+2) 保守口径）' }, '分 ' + g.score))
          })))
      }

      return el('div', null,
        // 五问
        qCard('① 学到了什么', d.learned.summary,
          el('div', { style: { marginTop: 6 } }, (d.learned.episodes_recent || []).slice(0, 8).map(function (e) {
            return el('div', { key: e.episode_id, style: { display: 'flex', gap: 6, alignItems: 'center', marginTop: 4, flexWrap: 'wrap' } },
              el('span', { style: { ...pill, color: e.outcome === 'verified_positive' ? T.success : T.label2 } }, EPISODE_OUTCOME_LABEL[e.outcome] || e.outcome),
              el('span', { style: { color: T.label2, ...F.xxs } }, (e.card_id || '-') + (e.program_id ? ' · ' + e.program_id : '')),
              el('button', { type: 'button', className: 'silksec-btn', style: { height: 22, marginLeft: 'auto' }, onClick: function () { openTrace({ episode_id: e.episode_id }) } }, '证据对照'),
              el('span', { style: { color: T.label3, ...F.xxxs } }, fmtTime(e.created_at)))
          }))),
        qCard('② 依据是什么', d.evidence.summary + '。' + (d.evidence.note || '')),
        qCard('③ 比旧版改善多少', d.improvement.summary,
          (d.improvement.scores || []).length
            ? el('div', { style: { marginTop: 6 } }, d.improvement.scores.slice(0, 8).map(function (s) {
                return el('div', { key: s.artifact_kind + '/' + s.artifact_id, style: { display: 'flex', gap: 6, alignItems: 'center', marginTop: 4, flexWrap: 'wrap' } },
                  el('span', { style: { ...pill, fontFamily: MONO }, title: s.artifact_kind }, s.artifact_id),
                  el('span', { style: { ...pill, color: T.business } }, '分 ' + s.score),
                  el('span', { style: pill }, '样本 ' + s.sample_size),
                  el('span', { style: { ...pill, color: T.success } }, '有效 ' + (s.verified_positives || 0)),
                  el('button', { type: 'button', className: 'silksec-btn', style: { height: 22, marginLeft: 'auto' }, onClick: function () { openTrace({ artifact_kind: s.artifact_kind, artifact_id: s.artifact_id }) } }, '证据对照'))
              }))
            : null),
        qCard('④ 在哪生效', d.effective_where.summary,
          (d.effective_where.releases || []).filter(function (r) { return r.status === 'active' }).length
            ? el('div', { style: { marginTop: 6 } }, d.effective_where.releases.filter(function (r) { return r.status === 'active' }).slice(0, 10).map(function (rel) {
                return el('div', { key: rel.release_id, style: { display: 'flex', gap: 6, alignItems: 'center', marginTop: 4, flexWrap: 'wrap' } },
                  el('span', { style: { ...pill, fontFamily: MONO } }, rel.artifact_id),
                  el('span', { style: { ...pill, color: T.success } }, rel.scope_type === 'global' ? '全局生效' : (rel.scope_type === 'family' ? '漏洞族 ' + rel.scope_id : '项目 ' + rel.scope_id)),
                  el('span', { style: { ...pill, fontFamily: MONO }, title: '生效版本' }, rel.revision_id),
                  el('button', { type: 'button', className: 'silksec-btn', style: { height: 22, marginLeft: 'auto' }, onClick: function () { openTrace({ artifact_kind: rel.artifact_kind, artifact_id: rel.artifact_id }) } }, '证据对照'))
              }))
            : null),
        qCard('⑤ 如何恢复旧版', d.rollback.summary + '（' + d.rollback.hint + '）'),
        tracePane,
        // 逐域视图
        d.domains ? el('div', { style: { ...card, marginTop: 10 } },
          el('div', { style: { color: T.label, ...F.sStrong } }, '逐域视图（效果与成本分层，不是使用次数榜）'),
          el('div', { style: { ...cardL, marginTop: 4 } }, d.domains.note || ''),
          domainTable('按漏洞类型族', d.domains.by_family),
          domainTable('按技术栈面', d.domains.by_surface),
          domainTable('按身份前置', d.domains.by_prerequisite)) : null,
        // 缺口与反馈桥
        (d.gaps && d.gaps.length) ? el('div', { style: { ...card, marginTop: 10 } },
          el('div', { style: { color: T.label, ...F.sStrong } }, '知识缺口（检索落空/低覆盖登记）'),
          el('div', { style: { marginTop: 6 } }, d.gaps.slice(0, 8).map(function (g, i) {
            return el('div', { key: i, style: { ...cardL, marginTop: 4 } }, (g.gap_type || '缺口') + '：' + (g.q || g.note || JSON.stringify(g)).slice(0, 120))
          }))) : null,
        d.feedback ? el('div', { style: { ...cardL, marginTop: 10 } }, '反馈桥：' + (d.feedback.note || '') + '（累计 ' + (d.feedback.total || 0) + ' 条）') : null)
    }

    // ── 域根：包 ui-core SilksecErrorBoundary（崩溃只炸该域 tab），并自持 query ──
    function KnowledgeRoot(props) {
      var api = props || {}
      var rpcCall = (typeof api.rpc === 'function') ? api.rpc : ownRpc
      var useRpcCore = uiCore.useRpc
      var cardsState = useRpcCore(function () { return { endpoint: 'expCards' } }, [], rpcCall)
      var pbsState = useRpcCore(function () { return { endpoint: 'playbooks' } }, [], rpcCall)
      var rulesState = useRpcCore(function () { return { endpoint: 'rulesList' } }, [], rpcCall)
      var kbState = useRpcCore(function () { return { endpoint: 'kbList' } }, [], rpcCall)
      var factOvState = useRpcCore(function () { return { endpoint: 'factOverview' } }, [], rpcCall)
      var covState = useRpcCore(function () { return { endpoint: 'knowledgeCoverage' } }, [], rpcCall)
      var memState = useRpcCore(function () { return { endpoint: 'memcore' } }, [], rpcCall)
      return el(uiCore.SilksecErrorBoundary, { surface: 'dashboard-view-know', title: '知识' },
        el(KnowledgeView, {
          cardsState: cardsState, pbsState: pbsState, rulesState: rulesState, kbState: kbState,
          factOvState: factOvState, covState: covState, memState: memState,
          busy: api.busy, callRpc: rpcCall,
        }))
    }
    function LearningRoot(props) {
      var api = props || {}
      var rpcCall = (typeof api.rpc === 'function') ? api.rpc : ownRpc
      var state = uiCore.useRpc(function () { return { endpoint: 'learningOverview' } }, [], rpcCall)
      return el(uiCore.SilksecErrorBoundary, { surface: 'dashboard-view-know-learning', title: '学习' },
        el(LearningView, { state: state, busy: api.busy, callRpc: rpcCall }))
    }

    exports.name = 'silksec-sec-dashboard-view-know'
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
        // 19-ui-unify §3.2：知识/学习属低频浏览面，收敛进主面板「更多」二级导航
        var d1 = uiCore.viewRegistry.register({
          id: 'knowledge', label: '知识', order: 70, group: 'more', domain: 'know',
          component: KnowledgeRoot, requires: ['connection'], source: 'dashboard-view-know',
        })
        var d2 = uiCore.viewRegistry.register({
          id: 'learning', label: '学习', order: 75, group: 'more', domain: 'know',
          component: LearningRoot, requires: ['connection'], source: 'dashboard-view-know',
        })
        if (typeof uiCore.markSurfaceHealth === 'function') uiCore.markSurfaceHealth('sec-dashboard-view-know', 'ok')
        return function () {
          if (typeof d1 === 'function') d1()
          if (typeof d2 === 'function') d2()
        }
      }
      // 时序纪律：connection 到达后才注册（capacity 探测）；ctx.effect 收口 disposer。
      if (typeof ctx.inject === 'function') ctx.inject(['connection'], function () { if (typeof ctx.effect === 'function') ctx.effect(install); else install() })
      else if (typeof ctx.effect === 'function') ctx.effect(install)
      else install()
    }

    exports.KnowledgeRoot = KnowledgeRoot
    exports.LearningRoot = LearningRoot
    exports.KnowledgeView = KnowledgeView
    exports.LearningView = LearningView
    exports.KbSection = KbSection
    exports.RulesSection = RulesSection
    return module.exports
  },
})
