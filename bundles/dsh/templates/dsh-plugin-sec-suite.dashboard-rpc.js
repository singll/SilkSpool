// ==============================================================================
// 看板 RPC + 能力凑链模块（第二批拆分自 index.js，行为完全不变）
//   planChain          能力原语凑链（BFS 前提-产出图搜索，manifest requires/produces）
//   taskChain          一条 objective 自动展开任务依赖链（复用 planChain BFS + 反向剪枝）
//   handleDashboardRpc 看板 Remote（Host↔Client RPC 通道 /silksec-dashboard）端点分发
// ==============================================================================

import * as fs from 'node:fs'
import * as path from 'node:path'

// 依赖注入（由 index.js 模块加载时调用 initDashboardRpc 传入，避免循环依赖）：
//   dataDir              数据目录（主文件 deps.dataDir，reports 目录推导）
//   audit                主文件 audit()：审计 JSONL 落盘
//   tailAudit            主文件 deps.tailAudit()：审计日志尾部读取（audit 端点）
//   assetDb              asset-db.js 模块命名空间（看板全部读写查询）
//   exp                  experience.js 模块命名空间（memcore/expCards/expFeedback 等记忆治理）
//   listManifests        主文件 deps.listManifests()：工具 manifest 枚举（planChain BFS）
//   loadManifest         主文件 deps.loadManifest()：单工具 manifest 加载（planChain/taskChain）
//   resolveProgramId     主文件 deps.resolveProgramId()：program_id 显式/会话工作区解析（taskChain）
//   sessionIdOf          主文件 deps.sessionIdOf()：会话 ID 提取（taskChain 审计/建任务）
//   pairWorkspaces       主文件 deps.pairWorkspaces()：工作区幂等配对（workspaces/scopeList 端点）
//   workspacesList       主文件 deps.workspacesList()：工作区清单（workspaces 端点）
//   sessionsList         主文件 deps.sessionsList()：会话清单（sessions 端点）
//   scopeList            主文件 deps.scopeList()：授权清单（scopeList 端点）
//   scopeSaveProgram     主文件 deps.scopeSaveProgram()：授权保存（scopeSaveProgram 端点）
//   scopeDeleteProgram   主文件 deps.scopeDeleteProgram()：授权删除（scopeDeleteProgram 端点）
//   getWorkspaceRegistry () => 主文件 workspaceRegistryRef（fiber 注入，可能为 null，须惰性读取）
let deps = null

export function initDashboardRpc(injected) {
  deps = injected
}

// ==============================================================================
// plan_chain：能力原语凑链（BFS 前提-产出图搜索，manifest requires/produces）
// ==============================================================================

export function planChain(args) {
  const have = Array.isArray(args.have) ? args.have.map(String) : []
  const want = String(args.want || '').trim()
  if (!want) return { ok: false, error: 'want 不能为空（如 findings / live_hosts / subdomains）' }

  const manifests = {}
  for (const name of deps.listManifests()) {
    const m = deps.loadManifest(name)
    if (m && Array.isArray(m.requires) && Array.isArray(m.produces)) manifests[name] = m
  }

  const available = new Set(have)
  const chain = []
  const used = new Set()
  let progress = true
  while (!available.has(want) && progress) {
    progress = false
    for (const [name, m] of Object.entries(manifests)) {
      if (used.has(name)) continue
      if (m.requires.every((r) => available.has(r))) {
        for (const p of m.produces) available.add(p)
        chain.push(name)
        used.add(name)
        progress = true
        break
      }
    }
  }
  if (!available.has(want)) {
    return { ok: false, have: [...have], available: [...available], error: `无法凑链到 ${want}（缺前置能力）` }
  }
  return { ok: true, have, want, chain, available: [...available] }
}

// P2-2：一条 objective 自动展开任务依赖链。
// 复用 planChain BFS 求可达工具链 → 反向剪枝到达成 want 的最小链（去掉贪心带入的旁支）→
// 落成 parent 串联的 once 调度任务：head 立即到期，子任务由 taskClaimDue 的「前置=done」gate 逐级放行 → 链式自动推进。
export function taskChain(args, exec) {
  const programId = deps.resolveProgramId(args.program_id, exec)
  if (!programId) return { ok: false, error: 'program_id 缺失且当前会话未在已绑定工作区（传 program_id，见 program_list）' }
  const want = String(args.want || 'findings').trim()
  const have = (Array.isArray(args.have) && args.have.length) ? args.have.map(String) : ['domains']
  const priority = Number.isInteger(args.priority) ? args.priority : 3
  const objectiveCtx = String(args.objective || '').trim()

  // 1) 复用 planChain BFS：验证可达 + 得到有序（含冗余旁支）工具链
  const plan = planChain({ have, want })
  if (!plan.ok) return { ok: false, error: plan.error, have, want, hint: '调整 have/want 或检查 manifest 的 requires/produces' }

  // 2) 反向剪枝：从 want 回溯，只保留 produces 命中「所需能力」的工具，逐级把其 requires 并入所需集
  const needed = new Set([want])
  const keep = []
  for (let i = plan.chain.length - 1; i >= 0; i--) {
    const m = deps.loadManifest(plan.chain[i])
    if (!m) continue
    const produces = Array.isArray(m.produces) ? m.produces : []
    if (produces.some((p) => needed.has(p))) {
      keep.unshift(m)
      for (const r of (Array.isArray(m.requires) ? m.requires : [])) needed.add(r)
    }
  }
  if (!keep.length) return { ok: false, error: `剪枝后链为空（want=${want} 无产出工具）`, plan_chain: plan.chain }

  // 3) 幂等去重：同 program 下已有未终结的同 want 链则不重复展开
  const marker = `[链:${want}]`
  const dup = deps.assetDb.taskList({ programId, q: marker, limit: 100 })
    .find((t) => ['queued', 'running', 'blocked'].includes(t.status))
  if (dup) return { ok: true, program_id: programId, want, deduped: true, chain: keep.map((m) => m.name), hint: `已存在未完成的 ${want} 任务链（起始 #${dup.id}），未重复展开` }

  // 4) 建 parent 串联的 once 调度任务（at 取小幅未来以过 normalizeSchedule 校验；实际次序由 parent gate 决定）
  const stageToPhase = { recon: 'recon', vuln: 'vuln', audit: 'code-audit' }
  const base = Date.now()
  const N = keep.length
  const ids = []
  let parentId = Number.isInteger(args.parent_id) ? args.parent_id : null
  for (let i = 0; i < N; i++) {
    const m = keep[i]
    const produces = (Array.isArray(m.produces) ? m.produces : []).join('+') || m.name
    const objective = `${marker} [${i + 1}/${N}] ${m.name}（产出 ${produces}）`
      + `${objectiveCtx ? `｜目标：${objectiveCtx}` : ''}`
      + `${m.stage === 'vuln' ? '。N-day/漏洞验证——结果 tentative，附证据才 confirmed' : ''}`
    const r = deps.assetDb.taskCreate({
      program_id: programId,
      phase: stageToPhase[m.stage] || m.stage || '',
      objective,
      priority,
      parent_id: parentId,
      session_id: deps.sessionIdOf(exec),
      schedule: { kind: 'once', at: base + (i + 1) * 2000 },
    })
    if (!r.ok) return { ok: false, error: `第 ${i + 1} 步建任务失败: ${r.error}`, created: ids }
    ids.push(r.id)
    parentId = r.id
  }
  deps.audit({ ts: Date.now(), run_id: '-', tool: 'task_chain', decision: 'executed', detail: { program_id: programId, want, chain: keep.map((m) => m.name), task_ids: ids }, session_id: deps.sessionIdOf(exec) })
  return { ok: true, program_id: programId, want, have, chain: keep.map((m) => m.name), task_ids: ids, note: `已展开 ${N} 级依赖链（once 调度，parent 串联）：前置未完成不派单，parent 完成后调度器自动放行下一级。` }
}
// ==============================================================================
// 看板 Remote（Host↔Client RPC 通道 /silksec-dashboard，authority=loopback）
// 只读查询 + 受控写（打标 findingUpdate / 事实纠正 factCorrect·factDeprecate /
// P11：授权管理 scopeSaveProgram·scopeDeleteProgram / 工作区绑定 programBindWorkspace / 任务立即跑 taskRunNow）。
// 底层直接复用 assetDb 现有函数——「一份校验、一条 audit.jsonl、一个真相源」。
// ==============================================================================

const FINDING_TAG_STATUS = ['confirmed', 'false_positive', 'ignored', 'new', 'submitted', 'accepted', 'dup']
export async function handleDashboardRpc(endpoint, payload) {
  const p = (payload && typeof payload === 'object') ? payload : {}
  switch (endpoint) {
    case 'stats':
      return deps.assetDb.stats()
    // ---- P11：工作区 / 会话 / 授权管理 ----
    case 'workspaces':
      deps.pairWorkspaces() // 顺手做幂等配对（registry 后到场景）
      return deps.workspacesList()
    case 'programBindWorkspace': {
      const programId = String(p.program_id || '')
      if (!programId) throw new Error('programBindWorkspace 需要 program_id')
      const workspaceId = p.workspace_id ? String(p.workspace_id) : null
      let wsPath = null
      if (workspaceId && deps.getWorkspaceRegistry()) {
        const ws = deps.getWorkspaceRegistry().get(workspaceId)
        if (!ws) throw new Error(`工作区不存在: ${workspaceId}`)
        wsPath = ws.path
      }
      if (!deps.assetDb.bindProgramWorkspace(programId, workspaceId, wsPath)) throw new Error(`program 不存在: ${programId}`)
      deps.audit({ ts: Date.now(), run_id: '-', tool: 'dashboard.programBindWorkspace', decision: 'executed', detail: { program_id: programId, workspace_id: workspaceId } })
      return { ok: true, program_id: programId, workspace_id: workspaceId }
    }
    case 'scopeList':
      deps.pairWorkspaces()
      return deps.scopeList()
    case 'scopeSaveProgram':
      return deps.scopeSaveProgram(p, !!p.is_new)
    case 'scopeDeleteProgram':
      return deps.scopeDeleteProgram(p.name)
    case 'taskRunNow': {
      const id = Number(p.id)
      if (!id) throw new Error('taskRunNow 需要 id')
      deps.audit({ ts: Date.now(), run_id: '-', tool: 'dashboard.taskRunNow', decision: 'executed', detail: { id } })
      return deps.assetDb.taskRunNow(id)
    }
    case 'taskCancel': {
      const id = Number(p.id)
      if (!id) throw new Error('taskCancel 需要 id')
      const r = deps.assetDb.taskUpdate({ id, status: 'cancelled', note: String(p.note || '看板手动取消') })
      deps.audit({ ts: Date.now(), run_id: '-', tool: 'dashboard.taskCancel', decision: 'executed', detail: { id } })
      return r
    }
    case 'reportBuild': {
      const r = deps.assetDb.buildReport({
        hostLike: String(p.host_like || ''), programId: String(p.program_id || ''),
        status: String(p.status || ''), sinceDays: Number(p.since_days) || 0,
      })
      let content = ''
      try { content = fs.readFileSync(r.file, 'utf8') } catch { /* 读回失败仅少 content，不阻断 */ }
      deps.audit({ ts: Date.now(), run_id: '-', tool: 'dashboard.reportBuild', decision: 'executed', detail: { file: r.file, total: r.total } })
      return { ...r, content }
    }
    case 'evalStats':
      return deps.assetDb.evalStats()
    case 'audit':
      return { rows: deps.tailAudit(Math.min(Number(p.limit) || 120, 300)) }
    case 'assets': {
      const filters = { hostLike: String(p.q || ''), type: String(p.type || ''), programId: String(p.program_id || '') }
      const limit = Math.min(Number(p.limit) || 20, 200)
      const offset = Math.max(0, Number(p.offset) || 0)
      return { rows: deps.assetDb.queryAssets({ ...filters, limit, offset, sort: String(p.sort || ''), dir: String(p.dir || '') }), total: deps.assetDb.countAssets(filters) }
    }
    case 'endpoints': {
      const filters = { host: String(p.host || ''), pathLike: String(p.q || ''), programId: String(p.program_id || '') }
      const limit = Math.min(Number(p.limit) || 20, 200)
      const offset = Math.max(0, Number(p.offset) || 0)
      return { rows: deps.assetDb.queryEndpoints({ ...filters, limit, offset, sort: String(p.sort || ''), dir: String(p.dir || '') }), total: deps.assetDb.countEndpoints(filters) }
    }
    case 'findings': {
      const filters = {
        severity: String(p.severity || ''), status: String(p.status || ''),
        programId: String(p.program_id || ''), q: String(p.q || ''),
      }
      const limit = Math.min(Number(p.limit) || 20, 200)
      const offset = Math.max(0, Number(p.offset) || 0)
      return { rows: deps.assetDb.queryFindings({ ...filters, limit, offset, sort: String(p.sort || ''), dir: String(p.dir || '') }), total: deps.assetDb.countFindings(filters) }
    }
    case 'findingGet': {
      const id = Number(p.id)
      if (!id) throw new Error('findingGet 需要 id')
      return deps.assetDb.findingGet(id)
    }
    case 'blackboard':
      return deps.assetDb.bbGet()
    case 'facts': {
      const filters = {
        program_id: String(p.program_id || ''), category: String(p.category || ''),
        q: String(p.q || ''), confidence: String(p.confidence || ''),
      }
      const limit = Math.min(Number(p.limit) || 20, 200)
      const offset = Math.max(0, Number(p.offset) || 0)
      return { rows: deps.assetDb.factSearch({ ...filters, limit, offset }), total: deps.assetDb.countFacts(filters) }
    }
    case 'factGraph': {
      const programId = String(p.program_id || '')
      const factKey = String(p.fact_key || '')
      if (!programId || !factKey) throw new Error('factGraph 需要 program_id 与 fact_key')
      return deps.assetDb.factGraph(programId, factKey)
    }
    case 'programs':
      return deps.assetDb.listPrograms()
    case 'tasks': {
      const filters = {
        programId: String(p.program_id || ''), status: String(p.status || ''),
        phase: String(p.phase || ''), q: String(p.q || ''), bucket: String(p.bucket || ''),
        scheduled: String(p.scheduled || ''),
      }
      // P12：定时任务由卡片区独立展示；活跃桶默认排除定时行，避免重复显示
      if (!filters.scheduled && filters.bucket === 'active') filters.scheduled = 'exclude'
      const limit = Math.min(Number(p.limit) || 20, 200)
      const offset = Math.max(0, Number(p.offset) || 0)
      return { rows: deps.assetDb.taskList({ ...filters, limit, offset }), total: deps.assetDb.countTasks(filters) }
    }
    // ---- P12：固定定时任务卡片区 + 执行历史 ----
    case 'scheduledTasks':
      return { rows: deps.assetDb.taskScheduledList() }
    case 'taskRuns': {
      const taskId = Number(p.task_id) || 0
      const programId = String(p.program_id || '')
      const limit = Math.min(Number(p.limit) || 20, 200)
      const offset = Math.max(0, Number(p.offset) || 0)
      return { rows: deps.assetDb.taskRunsList({ taskId, programId, limit, offset }), total: deps.assetDb.countTaskRuns({ taskId, programId }) }
    }
    case 'taskScheduleUpdate': {
      const id = Number(p.id)
      if (!id) throw new Error('taskScheduleUpdate 需要 id')
      const schedule = p.schedule && typeof p.schedule === 'object' ? p.schedule : null
      const r = deps.assetDb.taskSchedule({ id, schedule })
      deps.audit({ ts: Date.now(), run_id: '-', tool: 'dashboard.taskScheduleUpdate', decision: 'executed', detail: { id, schedule } })
      return r
    }
    case 'taskSetStatus': {
      // 暂停/恢复定时任务：blocked=暂停（调度器只认 queued），queued=恢复。其余状态走 taskCancel。
      const id = Number(p.id)
      const status = String(p.status || '')
      if (!id || !['blocked', 'queued'].includes(status)) throw new Error('taskSetStatus 需要 id 且 status 仅支持 blocked/queued')
      const r = deps.assetDb.taskUpdate({ id, status, note: status === 'blocked' ? '看板手动暂停' : '看板手动恢复' })
      deps.audit({ ts: Date.now(), run_id: '-', tool: 'dashboard.taskSetStatus', decision: 'executed', detail: { id, status } })
      return r
    }
    case 'taskCreate': {
      // 看板建任务（主要面向固定周期任务；interval 幂等去重，重复目标返回已有）
      const programId = String(p.program_id || '').trim()
      const objective = String(p.objective || '').trim()
      if (!programId || !objective) throw new Error('taskCreate 需要 program_id 与 objective')
      const schedule = p.schedule && typeof p.schedule === 'object' ? p.schedule : null
      const r = deps.assetDb.taskCreate({
        program_id: programId, objective, phase: String(p.phase || ''),
        priority: Number(p.priority) || 5, schedule,
      })
      if (r.ok) deps.audit({ ts: Date.now(), run_id: '-', tool: 'dashboard.taskCreate', decision: 'executed', detail: { id: r.id, program_id: programId, schedule, deduped: !!r.deduped } })
      return r
    }
    case 'sessions':
      return deps.sessionsList(String(p.workspace_id || ''))
    case 'findingUpdate': {
      const id = Number(p.id)
      const status = String(p.status || '')
      if (!id || !FINDING_TAG_STATUS.includes(status)) {
        throw new Error(`findingUpdate 需要合法 id 与 status（${FINDING_TAG_STATUS.join('/')}）`)
      }
      const r = deps.assetDb.updateFinding({ id, status, note: String(p.note || ''), bounty: p.bounty, vendor_status: String(p.vendor_status || '') })
      deps.audit({ ts: Date.now(), run_id: '-', tool: 'dashboard.findingUpdate', decision: 'executed', detail: { id, status, bounty: p.bounty ?? null } })
      return r
    }
    case 'factCorrect': {
      const programId = String(p.program_id || '')
      const factKey = String(p.fact_key || '')
      if (!programId || !factKey) throw new Error('factCorrect 需要 program_id 与 fact_key')
      const cur = deps.assetDb.factGet(programId, factKey)
      if (!cur) return { ok: false, error: `fact 不存在: ${programId}/${factKey}` }
      // 只覆盖显式提供的字段，其余保留原值；confidence 固定升为 confirmed
      const r = deps.assetDb.factUpsert({
        program_id: programId, fact_key: factKey,
        category: p.category !== undefined && p.category !== null ? String(p.category) : cur.category,
        summary: p.summary !== undefined && p.summary !== null ? String(p.summary) : cur.summary,
        body: p.body !== undefined && p.body !== null ? String(p.body) : cur.body,
        confidence: 'confirmed',
        pinned: cur.pinned, related_finding_id: cur.related_finding_id, source: cur.source,
      })
      deps.audit({ ts: Date.now(), run_id: '-', tool: 'dashboard.factCorrect', decision: 'executed', detail: { program_id: programId, fact_key: factKey } })
      return r
    }
    case 'factDeprecate': {
      const programId = String(p.program_id || '')
      const factKey = String(p.fact_key || '')
      if (!programId || !factKey) throw new Error('factDeprecate 需要 program_id 与 fact_key')
      const cur = deps.assetDb.factGet(programId, factKey)
      if (!cur) return { ok: false, error: `fact 不存在: ${programId}/${factKey}` }
      const r = deps.assetDb.factUpsert({
        program_id: programId, fact_key: factKey,
        category: cur.category, summary: cur.summary, body: cur.body,
        confidence: 'deprecated', pinned: cur.pinned,
        related_finding_id: cur.related_finding_id, source: cur.source,
      })
      deps.audit({ ts: Date.now(), run_id: '-', tool: 'dashboard.factDeprecate', decision: 'executed', detail: { program_id: programId, fact_key: factKey } })
      return r
    }
    // ---- 记忆治理（memcore）：知识 tab ----
    case 'memcore':
      return deps.exp.memStatus()
    case 'expCards': {
      const memCols = deps.exp.memStatus().loaded
        ? ', status, score, uses, adopted, pos_fb, neg_fb, justification, mem_class, exportable' : ''
      const rows = deps.assetDb.getDb().prepare(
        `SELECT id, scenario, takeaway, source, confidence, last_validated_at, created_at${memCols} FROM exp_cards ORDER BY ${memCols ? 'score DESC, ' : ''}last_validated_at DESC LIMIT 200`).all()
      return { rows: rows.map((r) => ({ ...r })) }
    }
    case 'expFeedback': {
      const r = deps.exp.expFeedback({ id: Number(p.id), verdict: String(p.verdict || ''), actor: 'dashboard' })
      deps.audit({ ts: Date.now(), run_id: '-', tool: 'dashboard.expFeedback', decision: 'executed', detail: { id: Number(p.id), verdict: String(p.verdict || '') } })
      return r
    }
    case 'expPromote': {
      const r = deps.exp.expPromote({ id: Number(p.id), reason: String(p.reason || '看板人工晋升'), actor: 'dashboard' })
      deps.audit({ ts: Date.now(), run_id: '-', tool: 'dashboard.expPromote', decision: 'executed', detail: { id: Number(p.id) } })
      return r
    }
    case 'expDeprecate': {
      const r = deps.exp.expDeprecate({ id: Number(p.id), reason: String(p.reason || '看板弃置'), actor: 'dashboard' })
      deps.audit({ ts: Date.now(), run_id: '-', tool: 'dashboard.expDeprecate', decision: 'executed', detail: { id: Number(p.id), reason: String(p.reason || '') } })
      return r
    }
    case 'expUpdate': {
      const r = deps.exp.expUpdate({ id: Number(p.id), takeaway: p.takeaway, justification: String(p.justification || '') })
      deps.audit({ ts: Date.now(), run_id: '-', tool: 'dashboard.expUpdate', decision: 'executed', detail: { id: Number(p.id) } })
      return r
    }
    case 'expExportable': {
      const id = Number(p.id)
      const on = p.exportable ? 1 : 0
      if (!id) throw new Error('expExportable 需要 id')
      deps.assetDb.getDb().prepare('UPDATE exp_cards SET exportable = ? WHERE id = ?').run(on, id)
      deps.audit({ ts: Date.now(), run_id: '-', tool: 'dashboard.expExportable', decision: 'executed', detail: { id, exportable: on } })
      return { ok: true, id, exportable: on }
    }
    case 'playbooks': {
      const rows = deps.assetDb.getDb().prepare('SELECT * FROM playbooks ORDER BY runs DESC LIMIT 100').all()
      return { rows: rows.map((r) => ({ ...r, success_rate: r.runs ? Math.round((r.successes / r.runs) * 100) / 100 : 0 })) }
    }
    // ---- 报告查看（只读）----
    case 'reports': {
      const base = path.join(deps.dataDir, 'reports')
      const out = []
      const walk = (dir, rel) => {
        let entries
        try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
        for (const e of entries) {
          const rp = rel ? `${rel}/${e.name}` : e.name
          if (e.isDirectory()) walk(path.join(dir, e.name), rp)
          else if (e.name.endsWith('.md')) {
            const st = fs.statSync(path.join(dir, e.name))
            out.push({ file: rp, mtime: st.mtimeMs, size: st.size })
          }
        }
      }
      walk(base, '')
      out.sort((a, b) => b.mtime - a.mtime)
      return { rows: out.slice(0, 200) }
    }
    case 'reportRead': {
      const base = path.join(deps.dataDir, 'reports')
      const rel = String(p.file || '').replace(/^\/+/, '')
      const full = path.resolve(base, rel)
      if (!full.startsWith(base + path.sep)) throw new Error('非法路径')
      if (!fs.existsSync(full)) throw new Error(`报告不存在: ${rel}`)
      const content = fs.readFileSync(full, 'utf8')
      return { file: rel, content: content.slice(0, 300000), truncated: content.length > 300000 }
    }
    default:
      throw new Error(`未知看板端点: ${endpoint}`)
  }
}
