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
//   audit                主文件 audit()：审计 JSONL 落盘（taskChain 建任务）
//   assetDb              asset-db.js 模块命名空间（仅 taskChain 宿主 helper 使用；业务读写一律走领域总线）
//   exp                  experience.js 模块命名空间（memcore 记忆治理壳端点）
//   listManifests        主文件 deps.listManifests()：工具 manifest 枚举（planChain BFS）
//   loadManifest         主文件 deps.loadManifest()：单工具 manifest 加载（planChain/taskChain）
//   resolveProgramId     主文件 deps.resolveProgramId()：program_id 显式/会话工作区解析（taskChain）
//   sessionIdOf          主文件 deps.sessionIdOf()：会话 ID 提取（taskChain 审计/建任务）
//   pairWorkspaces       主文件 deps.pairWorkspaces()：工作区幂等配对（workspaces 端点）
//   workspacesList       主文件 deps.workspacesList()：工作区清单（workspaces 端点）
//   sessionsList         主文件 deps.sessionsList()：会话清单（sessions 端点）
//   getWorkspaceRegistry () => 主文件 workspaceRegistryRef（fiber 注入，可能为 null，须惰性读取）
//   getSecDomainBus      () => 主文件 secDomainBusRef（v5 领域总线；看板业务读写唯一入口）
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
// 业务读写唯一入口 = v5 领域总线（busQuery/busDispatch，fail-closed）；assetDb 仅剩 taskChain
// 宿主 helper（19-ui-unify §4.4 后 stats 亦全走壳聚合查询，assetDb.stats 直查已删除）。
// ==============================================================================

const FINDING_TAG_STATUS = ['confirmed', 'false_positive', 'ignored', 'new', 'submitted', 'accepted', 'dup']

// ==============================================================================
// v5 原子化：看板读写一律走领域总线，fail-closed（16-dashboard §5.3 前置硬闸）。
// 原 63 处 `v4 兜底`（总线缺席/域动词未知/查询异常即直调 assetDb）已拆除——绕过域
// 审计/幂等/事件是最大原子化缺口。总线缺席或域/动词未注册即显式报错，不再静默降级。
// 例外：壳聚合端点（stats/workspaces/sessions/memcore）——stats 经各域查询聚合
// （19-ui-unify §4.4，不再直查 assetDb）；workspaces/sessions/memcore 为平台/壳自有面。
// ==============================================================================
function busOrThrow() {
  const bus = deps.getSecDomainBus ? deps.getSecDomainBus() : null
  if (!bus) throw new Error('该看板端点需要 v5 领域总线（legacy 直写兜底已拆除）；请确认 silksecagent 服务运行且领域总线已注册')
  return bus
}
function busError(r) {
  const msg = String(r?.error?.message || '未知错误') + (r?.error?.hint ? `（${r.error.hint}）` : '')
  const err = new Error(msg)
  err.code = r?.error?.code
  return err
}
async function busQuery(domain, verb, args, ctx) {
  const r = await busOrThrow().query(domain, verb, args, ctx || { actor: 'dashboard' })
  if (!r.ok) throw busError(r)
  return r
}
async function busDispatch(domain, verb, args, ctx) {
  const r = await busOrThrow().dispatch(domain, verb, args, ctx || { actor: 'dashboard' })
  if (!r.ok) throw busError(r)
  return r
}

export async function handleDashboardRpc(endpoint, payload) {
  const p = (payload && typeof payload === 'object') ? payload : {}
  switch (endpoint) {
    case 'stats': {
      // 19-ui-unify §4.4：壳聚合端点改为**只调各域查询**（assetDb.stats 直查已删）。
      // 聚合「今日待办 + 风险暴露」五指标 + 库存副条；任一来源失败 → 该指标 null +
      // degraded:[域]，卡片渲染「—」，不整体失败（16-dashboard §1.6 不变量）。
      // 兼容面：assets_by_type / findings_by_severity / findings_by_status /
      // findings_noise（资产/漏洞视图洞察条继续消费）。
      const out = { degraded: [] }
      const failed = (domain) => { if (out.degraded.indexOf(domain) < 0) out.degraded.push(domain) }
      // 待审批（approval.stats：pending 总数 + 最老等待天数）
      try {
        const r = await busQuery('approval', 'stats', {})
        const d = r.data || {}
        out.approval = { pending: Number(d.pending_total) || 0, oldest_days: Number(d.pending_oldest_days) || 0 }
      } catch (e) { out.approval = null; failed('approval') }
      // 漏洞（vuln.stats：信号 by_severity/by_status + 候选待消化 pending）
      try {
        const r = await busQuery('vuln', 'stats', {})
        const d = r.data || {}
        const sev = (d.signal && d.signal.by_severity) || {}
        const st = (d.signal && d.signal.by_status) || {}
        out.vuln = {
          new: Number(st.new) || 0,
          critical: Number(sev.critical) || 0,
          high: Number(sev.high) || 0,
          candidate: Number(d.candidate && d.candidate.pending) || 0,
          total: Number(d.signal && d.signal.total) || 0,
          unsubmitted: Number(d.signal && d.signal.confirmed_unsubmitted) || 0,
        }
        out.findings_by_severity = Object.keys(sev).map((k) => ({ severity: k, n: Number(sev[k]) || 0 }))
        out.findings_by_status = Object.keys(st).map((k) => ({ status: k, n: Number(st[k]) || 0 }))
        out.findings_noise = out.vuln.candidate
      } catch (e) {
        out.vuln = null; out.findings_by_severity = []; out.findings_by_status = []; out.findings_noise = 0
        failed('vuln')
      }
      // 任务（task.list 全局 status 过滤；task.stats 需 program_id，全局口径用 list total）
      try {
        const [run, blk, fail] = await Promise.all([
          busQuery('task', 'list', { status: 'running', limit: 1 }),
          busQuery('task', 'list', { status: 'blocked', limit: 1 }),
          busQuery('task', 'list', { status: 'failed', limit: 1 }),
        ])
        out.tasks = { running: Number(run.total) || 0, blocked: Number(blk.total) || 0, failed: Number(fail.total) || 0 }
      } catch (e) { out.tasks = null; failed('task') }
      // 纪律告警（ledger.discipline_stats）
      try {
        const r = await busQuery('ledger', 'discipline_stats', { program: '' })
        const d = r.data || {}
        out.discipline = { alerts: Array.isArray(d.alerts) ? d.alerts : [], healthy: !!d.healthy }
      } catch (e) { out.discipline = null; failed('ledger') }
      // 库存副条（asset.overview + endpoint.list + fact.stats；工作区由 UI 侧平台数据补）
      try {
        const [ov, ep, ft] = await Promise.all([
          busQuery('asset', 'overview', {}),
          busQuery('endpoint', 'list', { limit: 1 }),
          busQuery('fact', 'stats', {}),
        ])
        out.inventory = {
          assets: Number(ov.data && ov.data.total) || 0,
          endpoints: Number(ep.total) || 0,
          facts: Number(ft.data && ft.data.total) || 0,
          findings: out.vuln ? out.vuln.total : null,
        }
        out.assets_by_type = (ov.data && Array.isArray(ov.data.by_type)) ? ov.data.by_type : []
      } catch (e) { out.inventory = null; out.assets_by_type = []; failed('asset') }
      return out
    }
    // ---- P15：纪律健康度（五指标：台账/卡使用/交接包/IdeaCard/调度漂移）----
    case 'ops': {
      // v5：ledger.discipline_stats 接管（11-ledger §1.7），fail-closed
      const r = await busQuery('ledger', 'discipline_stats', { program: String(p.program || '') })
      return r.data
    }
    // ---- P11：工作区 / 会话 / 授权管理 ----
    case 'workspaces':
      deps.pairWorkspaces() // 顺手做幂等配对（registry 后到场景）
      return deps.workspacesList()
    case 'programBindWorkspace': {
      const programId = String(p.program_id || '')
      if (!programId) throw new Error('programBindWorkspace 需要 program_id')
      const workspaceId = p.workspace_id ? String(p.workspace_id) : null
      // v5：program.bind_workspace（scope 域 program_bind_workspace）接管（08-scope §1.7），fail-closed
      let workspace = null
      if (workspaceId) {
        const reg = deps.getWorkspaceRegistry ? deps.getWorkspaceRegistry() : null
        const ws = reg ? reg.get(workspaceId) : null
        workspace = ws ? (ws.path || ws.title) : workspaceId
      }
      const r = await busDispatch('scope', 'program_bind_workspace', { program_name: programId, workspace }, { actor: 'dashboard', operator: p.operator ? String(p.operator) : null })
      return { ok: true, program_id: programId, workspace_id: workspaceId, ...(r.data || {}) }
    }
    case 'scopeList': {
      // v5：scope.list（scope 域 scope_list 查询）接管（08-scope §1.7），fail-closed
      const r = await busQuery('scope', 'list', { include_archived: true })
      return r.data
    }
    case 'scopeSaveProgram': {
      // v5：scope.grant（+ scope.exclude + program.bind_workspace，按表单字段分派）接管
      // （16-dashboard §1.7 #6），fail-closed
      const name = String(p.name || '').trim()
      const entries = [...new Set((Array.isArray(p.scope) ? p.scope : []).map((s) => String(s).trim()).filter(Boolean))]
      if (!entries.length) throw new Error('scope 至少一条授权条目（域名/IP/CIDR）')
      const ctx = { actor: 'dashboard', operator: p.operator ? String(p.operator) : null }
      const grantArgs = { program_name: name, entries }
      if (p.platform) grantArgs.platform = String(p.platform).trim()
      if (p.max_risk) grantArgs.max_risk = String(p.max_risk)
      const g = await busDispatch('scope', 'grant', grantArgs, ctx)
      const excludeEntries = [...new Set((Array.isArray(p.exclude) ? p.exclude : []).map((s) => String(s).trim()).filter(Boolean))]
      if (excludeEntries.length) {
        await busDispatch('scope', 'exclude', { program_name: name, entries: excludeEntries }, ctx)
      }
      const ws = p.workspace ? String(p.workspace).trim() : ''
      if (ws) {
        await busDispatch('scope', 'program_bind_workspace', { program_name: name, workspace: ws }, ctx)
      }
      return { ok: true, name, ...(g.data || {}) }
    }
    case 'scopeDeleteProgram': {
      // v5：scope.revoke（清空全部条目 → 整项目出 yml + programs 归档）接管（08-scope §1.7），fail-closed
      const name = String(p.name || '').trim()
      const list = await busQuery('scope', 'list', { include_archived: false })
      const prog = (list.data && Array.isArray(list.data.programs)) ? list.data.programs.find((x) => x.name === name) : null
      if (!prog) { const err = new Error(`项目 ${name} 不在 scope.yml`); err.code = 'E_NOT_FOUND'; throw err }
      const entries = prog.scope || []
      if (!entries.length) { const err = new Error(`项目 ${name} 无授权条目`); err.code = 'E_NOT_FOUND'; throw err }
      const r = await busDispatch('scope', 'revoke', { program_name: name, entries }, { actor: 'dashboard', operator: p.operator ? String(p.operator) : null })
      return { ok: true, name, hint: '已从 scope.yml 移除（fail-closed 立即生效），programs 表归档保留归属', ...(r.data || {}) }
    }
    // ---- v4.3 统一审批中心 ----
    case 'approvalList': {
      // v5：approval.list（approval 域 approval_list 查询）接管（09-approval §1.7），fail-closed
      const r = await busQuery('approval', 'list', { kind: String(p.kind || ''), status: String(p.status || ''), limit: Math.min(Number(p.limit) || 100, 200) })
      let pending = 0
      try {
        const pc = await busQuery('approval', 'list', { status: 'pending', limit: 1 })
        pending = Number(pc.total) || 0
      } catch { pending = (r.rows || []).filter((x) => x.status === 'pending').length }
      return { rows: r.rows, pending }
    }
    case 'approvalDecide': {
      // v5：approval.decide（approval 域 approval_decide 命令）接管（09-approval §1.7），fail-closed
      const r = await busDispatch('approval', 'decide', { id: Number(p.id), decision: String(p.decision || ''), note: String(p.note || '') }, { actor: 'dashboard', operator: p.operator ? String(p.operator) : null })
      return { ok: true, ...(r.data || {}) }
    }
    case 'taskRunNow': {
      const id = Number(p.id)
      if (!id) throw new Error('taskRunNow 需要 id')
      // v5：task.run_now（task 域 task_run_now 命令）接管（05-task §1.7），fail-closed
      const r = await busDispatch('task', 'run_now', { task_id: id }, { actor: 'dashboard', operator: p.operator ? String(p.operator) : null })
      return { ok: true, id, ...(r.data || {}) }
    }
    case 'taskCancel': {
      const id = Number(p.id)
      if (!id) throw new Error('taskCancel 需要 id')
      // v5：task.cancel（task 域 task_cancel 命令）接管（05-task §1.7），fail-closed
      const r = await busDispatch('task', 'cancel', { task_id: id, note: String(p.note || '看板手动取消') }, { actor: 'dashboard', operator: p.operator ? String(p.operator) : null })
      return { ok: true, id, ...(r.data || {}) }
    }
    case 'reportBuild': {
      // v5：report.build（report 域 report_build 命令）接管（12-report §1.7），fail-closed
      const r = await busDispatch('report', 'build', {
        host_like: String(p.host_like || ''), program_id: String(p.program_id || ''),
        since_days: Number(p.since_days) || 0,
        status_filter: String(p.status || ''), // R3 裁决：report_build 过滤参数更名 status_filter（语义不变）
        severity: String(p.severity || ''), source: String(p.source || ''),
      }, { actor: 'dashboard', operator: p.operator ? String(p.operator) : null })
      let content = ''
      if (r.data && r.data.file) {
        try { content = fs.readFileSync(path.join(deps.dataDir, 'reports', r.data.file), 'utf8') } catch { /* 读回失败仅少 content，不阻断 */ }
      }
      return { ...r.data, content }
    }
    case 'evalStats': {
      // v5：eval.stats（eval 域 eval_stats 查询）接管（15-eval §1.7），fail-closed
      const r = await busQuery('eval', 'stats', {})
      return { total: r.data?.live?.total, by_type: r.data?.live?.by_type }
    }
    // ---- L6（学习专项 §10）：学习面板——普通业务语言五问 + 证据对照 + 逐域视图 ----
    // 看板五问：①学到了什么 ②依据是什么 ③比旧版改善多少 ④在哪生效 ⑤如何恢复旧版。
    // 全部只走域投影（Q22 know_learning_status / Q19-Q20 发布账本与版本链 / Q21 检索解释 /
    // Q17-Q18 候选版本 / episode 投影），技术字段收进 detail 供展开。总线缺席 fail-closed
    // （学习面板无 v4 直写兜底——学习台账只在 v5 域）。
    case 'learningOverview': {
      const bus = deps.getSecDomainBus ? deps.getSecDomainBus() : null
      if (!bus) throw new Error('学习台账需要 v5 领域总线（本端点无 v4 兜底）')
      const artifactKind = String(p.artifact_kind || '')
      const q = (d, n, a) => bus.query(d, n, a, { actor: 'dashboard' })
      const [status, episodes, revisions, releases, evals] = await Promise.all([
        q('know', 'learning_status', { artifact_kind: artifactKind }),
        q('know', 'episode_list', { limit: 30 }),
        q('know', 'revision_list', { artifact_kind: artifactKind, limit: 50 }),
        q('know', 'release_list', { artifact_kind: artifactKind, limit: 50 }),
        q('eval', 'stats', {}).catch(() => null),
      ])
      if (!status.ok) throw new Error(`学习状态查询失败: ${status.error?.code || ''} ${status.error?.message || ''}`)
      const sd = status.data || {}
      const revRows = revisions.ok ? (revisions.rows || revisions.data?.rows || []) : []
      const relRows = releases.ok ? (releases.rows || releases.data?.rows || []) : []
      const epRows = episodes.ok ? (episodes.rows || episodes.data?.rows || []) : []
      const byOutcome = {}
      for (const e of epRows) byOutcome[e.outcome] = (byOutcome[e.outcome] || 0) + 1
      const evalLive = evals && evals.ok && evals.data ? (evals.data.live || evals.data) : null
      // 五问聚合（普通业务语言；技术字段在 *_detail 里，用户不必理解 episode/outbox）
      return {
        learned: {
          summary: `学习记录 ${episodes.total ?? epRows.length} 条（近 30 条：成立 ${byOutcome.verified_positive || 0} / 排除误报 ${byOutcome.verified_negative || 0} / 未定论 ${byOutcome.inconclusive || 0}）；候选版本 ${revisions.total ?? revRows.length} 个，生效发布 ${sd.releases_active ?? relRows.filter((r) => r.status === 'active').length} 个`,
          candidates: revRows.slice(0, 20),
          episodes_recent: epRows.slice(0, 15),
        },
        evidence: {
          summary: '每条学习记录携带证据引用与执行快照哈希；点击"证据对照"可看完整链（记录→版本→评测→批准→发布→采用→反馈）',
          note: sd.note || '',
        },
        improvement: {
          summary: evalLive ? `对照评测累计 ${evalLive.total ?? 0} 次` : '尚无对照评测记录',
          eval: evalLive,
          scores: sd.scores || [],
        },
        effective_where: {
          summary: `${sd.releases_active ?? 0} 个发布正在生效（按适用范围分层）`,
          releases: relRows,
        },
        rollback: {
          summary: '生效中的发布可在"证据对照"里撤回，系统自动恢复该范围上一版本；撤回动作留痕可审计',
          hint: '撤回走受控动词 know_release_revoke（面板不直写台账）',
        },
        // 逐域视图：按漏洞类型族/技术栈/身份前置分层（样本量与不确定性可见，非 uses 榜单）
        domains: sd.domains || null,
        feedback: sd.feedback || null,
        gaps: sd.gaps || [],
      }
    }
    case 'learningTrace': {
      const bus = deps.getSecDomainBus ? deps.getSecDomainBus() : null
      if (!bus) throw new Error('证据对照需要 v5 领域总线（本端点无 v4 兜底）')
      const args = { limit: Math.min(Number(p.limit) || 50, 200) }
      if (p.episode_id) args.episode_id = String(p.episode_id)
      if (p.artifact_kind) args.artifact_kind = String(p.artifact_kind)
      if (p.artifact_id) args.artifact_id = String(p.artifact_id)
      const r = await bus.query('know', 'learning_trace', args, { actor: 'dashboard' })
      if (!r.ok) { const err = new Error(String(r.error?.message || '追溯链查询失败') + (r.error?.hint ? `（${r.error.hint}）` : '')); err.code = r.error?.code; throw err }
      return r.data
    }
    case 'learningRevokeRelease': {
      const releaseId = String(p.release_id || '')
      const reason = String(p.reason || '')
      if (!releaseId) throw new Error('learningRevokeRelease 需要 release_id')
      if (reason.trim().length < 10) throw new Error('撤回原因至少 10 字（可审计留痕）')
      // 面板写操作只走受控动词 C27（16-dashboard §纪律：禁止旁路直写学习台账）
      const bus = deps.getSecDomainBus ? deps.getSecDomainBus() : null
      if (!bus) throw new Error('撤回需要 v5 领域总线（本端点无 v4 兜底）')
      const r = await bus.dispatch('know', 'release_revoke', { release_id: releaseId, reason }, { actor: 'dashboard', operator: p.operator ? String(p.operator) : null })
      if (r.ok) return { ok: true, ...(r.data || {}) }
      const err = new Error(String(r.error?.message || '撤回失败') + (r.error?.hint ? `（${r.error.hint}）` : '')); err.code = r.error?.code; throw err
    }
    case 'audit': {
      // v5：bus.audit_tail（总线审计尾读）接管（16-dashboard §1.7 #14），fail-closed
      const r = await busQuery('bus', 'audit_tail', { n: Math.min(Number(p.limit) || 120, 300) })
      return {
        rows: (r.rows || []).map((x) => ({
          ts: x.ts,
          tool: x.cmd || '—',
          decision: x.result || '—',
          detail: { domain: x.domain, actor: x.actor, operator: x.operator, session_id: x.session_id, kind: x.kind, before: x.before, after: x.after, target: x.target, error_code: x.error_code, backend: x.backend, legacy: x.legacy, alias: x.alias },
        })),
      }
    }
    case 'assets': {
      const limit = Math.min(Number(p.limit) || 20, 200)
      const offset = Math.max(0, Number(p.offset) || 0)
      // v5：asset.list 接管（03-asset §1.7），fail-closed
      const r = await busQuery('asset', 'list', {
        host_like: String(p.q || ''), type: String(p.type || ''), program_id: String(p.program_id || ''),
        level: String(p.level || ''), accept: String(p.accept || ''), state: String(p.state || ''),
        limit, offset, sort: String(p.sort || ''), dir: String(p.dir || ''),
      })
      return { rows: r.rows, total: r.total }
    }
    // ---- 看板 v4.1：资产多维（域名族总览 + 单主机钻取）、接口按主机分组、事实 facet ----
    case 'assetOverview': {
      // v5：asset.overview 接管，fail-closed
      const r = await busQuery('asset', 'overview', {})
      return r.data
    }
    case 'assetDetail': {
      const host = String(p.host || '')
      if (!host) throw new Error('assetDetail 需要 host')
      const r = await busQuery('asset', 'get', { host })
      return { ok: true, ...(r.data || {}) }
    }
    case 'assetFamily': {
      const root = String(p.root || '')
      const r = await busQuery('asset', 'family', { root })
      return { ok: true, root, hosts: (r.data && r.data.hosts) || [] }
    }
    case 'endpointHosts': {
      const limit = Math.min(Number(p.limit) || 20, 200)
      const offset = Math.max(0, Number(p.offset) || 0)
      // v5：endpoint.hosts 接管（04-endpoint §1.7），fail-closed
      const r = await busQuery('endpoint', 'hosts', { path_like: String(p.q || ''), program_id: String(p.program_id || ''), limit, offset })
      return { rows: r.rows, total: r.total }
    }
    case 'factStats': {
      // v5：fact.stats 接管（06-fact §1.7），fail-closed
      const r = await busQuery('fact', 'stats', {})
      return r.data
    }
    case 'endpoints': {
      const limit = Math.min(Number(p.limit) || 20, 200)
      const offset = Math.max(0, Number(p.offset) || 0)
      // v5：endpoint.list 接管（04-endpoint §1.7），fail-closed
      const r = await busQuery('endpoint', 'list', {
        host: String(p.host || ''), path_like: String(p.q || ''), program_id: String(p.program_id || ''),
        limit, offset, sort: String(p.sort || ''), dir: String(p.dir || ''),
      })
      return { rows: r.rows, total: r.total }
    }
    case 'findings': {
      const filters = {
        severity: String(p.severity || ''), status: String(p.status || ''),
        programId: String(p.program_id || ''), q: String(p.q || ''),
        noise: String(p.noise || ''), // v4.2：'1' = 仅待验证候选（机器直灌/字段不完整）
      }
      const limit = Math.min(Number(p.limit) || 20, 200)
      const offset = Math.max(0, Number(p.offset) || 0)
      // v5：vuln.list 接管（02-vuln §1.7），fail-closed
      const r = await busQuery('vuln', 'list', {
        visibility: filters.noise === '1' ? 'candidate' : (p.include_noise ? 'all' : 'signal'),
        severity: filters.severity, status: filters.status, program_id: filters.programId, q: filters.q,
        limit, offset, sort: String(p.sort || ''), dir: String(p.dir || ''),
      })
      return { rows: r.rows, total: r.total }
    }
    case 'findingGet': {
      const id = Number(p.id)
      if (!id) throw new Error('findingGet 需要 id')
      const r = await busQuery('vuln', 'get', { id })
      return r.data
    }
    case 'blackboard': {
      // v5：fact.bb_read 接管，fail-closed
      const r = await busQuery('fact', 'bb_read', {})
      return { ok: true, result: r.data }
    }
    case 'facts': {
      const filters = {
        program_id: String(p.program_id || ''), category: String(p.category || ''),
        q: String(p.q || ''), confidence: String(p.confidence || ''),
        hasEdges: !!p.has_edges, sort: String(p.sort || ''),
        memClass: String(p.mem_class || ''), status: String(p.status || ''), // v4.3 生命周期维度
        excludeNotes: !!p.exclude_notes, // v4.3 流水账治理：看板默认排除 note 类工作速记
      }
      const limit = Math.min(Number(p.limit) || 20, 200)
      const offset = Math.max(0, Number(p.offset) || 0)
      // v5：fact.search 接管（06-fact §1.7），fail-closed
      const r = await busQuery('fact', 'search', {
        program_id: filters.program_id, category: filters.category, q: filters.q, confidence: filters.confidence,
        has_edges: filters.hasEdges, mem_class: filters.memClass, status: filters.status,
        exclude_notes: filters.excludeNotes, sort: filters.sort, limit, offset,
      })
      return { rows: r.rows, total: r.total }
    }
    case 'factGraph': {
      const programId = String(p.program_id || '')
      const factKey = String(p.fact_key || '')
      if (!programId || !factKey) throw new Error('factGraph 需要 program_id 与 fact_key')
      // v5：fact.graph 接管，fail-closed
      const r = await busQuery('fact', 'graph', { program_id: programId, fact_key: factKey })
      return { ok: true, ...(r.data || {}) }
    }
    case 'programs': {
      // v5：scope.program_list（scope 域 program_list 查询）接管（08-scope §1.7），fail-closed
      const r = await busQuery('scope', 'program_list', { limit: 500 })
      return r.rows
    }
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
      // v5：task.list（task 域 task_list 查询）接管（05-task §1.7），fail-closed
      const r = await busQuery('task', 'list', {
        program_id: filters.programId, status: filters.status, phase: filters.phase, q: filters.q,
        bucket: filters.bucket, scheduled: filters.scheduled, limit, offset,
      })
      return { rows: r.rows, total: r.total }
    }
    // ---- P12：固定定时任务卡片区 + 执行历史 ----
    case 'scheduledTasks': {
      // v5：task.scheduled（task 域 task_scheduled 查询）接管（05-task §1.7），fail-closed
      const r = await busQuery('task', 'scheduled', {})
      return { rows: r.rows }
    }
    case 'taskRuns': {
      const taskId = Number(p.task_id) || 0
      const programId = String(p.program_id || '')
      const limit = Math.min(Number(p.limit) || 20, 200)
      const offset = Math.max(0, Number(p.offset) || 0)
      // v5：task.runs（task 域 task_runs 查询）接管（05-task §1.7），fail-closed
      const r = await busQuery('task', 'runs', { task_id: taskId, program_id: programId, limit, offset })
      return { rows: r.rows, total: r.total }
    }
    case 'taskScheduleUpdate': {
      const id = Number(p.id)
      if (!id) throw new Error('taskScheduleUpdate 需要 id')
      const schedule = p.schedule && typeof p.schedule === 'object' ? p.schedule : null
      // v5：task.schedule（task 域 task_schedule 命令）接管（05-task §1.7），fail-closed
      const r = await busDispatch('task', 'schedule', { task_id: id, schedule }, { actor: 'dashboard', operator: p.operator ? String(p.operator) : null })
      return { ok: true, ...(r.data || {}) }
    }
    case 'taskSetStatus': {
      // 暂停/恢复定时任务：blocked=暂停（调度器只认 queued），queued=恢复。其余状态走 taskCancel。
      const id = Number(p.id)
      const status = String(p.status || '')
      if (!id || !['blocked', 'queued'].includes(status)) throw new Error('taskSetStatus 需要 id 且 status 仅支持 blocked/queued')
      // v5：拆分 task.block / task.resume（task 域命令）接管（16-dashboard §1.7 #32），fail-closed
      const verb = status === 'blocked' ? 'block' : 'resume'
      const args = status === 'blocked' ? { task_id: id, blocked_reason: '看板手动暂停' } : { task_id: id }
      const r = await busDispatch('task', verb, args, { actor: 'dashboard', operator: p.operator ? String(p.operator) : null })
      return { ok: true, id, ...(r.data || {}) }
    }
    case 'taskCreate': {
      // 看板建任务（主要面向固定周期任务；interval 幂等去重，重复目标返回已有）
      const programId = String(p.program_id || '').trim()
      const objective = String(p.objective || '').trim()
      if (!programId || !objective) throw new Error('taskCreate 需要 program_id 与 objective')
      const schedule = p.schedule && typeof p.schedule === 'object' ? p.schedule : null
      // v5：task.create（task 域 task_create 命令）接管（05-task §1.7），fail-closed
      const args = { program_id: programId, objective, phase: String(p.phase || ''), priority: Number(p.priority) || 5 }
      if (schedule) args.schedule = schedule
      if (p.provider) args.provider = String(p.provider)
      if (p.model) args.model = String(p.model)
      if (p.reasoning_effort) args.reasoning_effort = String(p.reasoning_effort)
      const r = await busDispatch('task', 'create', args, { actor: 'dashboard', operator: p.operator ? String(p.operator) : null })
      return { ok: true, id: r.data?.task_id, deduped: !!r.data?.deduped, ...(r.data || {}) }
    }
    case 'sessions':
      return deps.sessionsList(String(p.workspace_id || ''))
    case 'findingUpdate': {
      const id = Number(p.id)
      const status = String(p.status || '')
      if (!id || !FINDING_TAG_STATUS.includes(status)) {
        throw new Error(`findingUpdate 需要合法 id 与 status（${FINDING_TAG_STATUS.join('/')}）`)
      }
      // v5：按 status 直达语义动词（02-vuln §1.7）——不再经兼容别名层，fail-closed。
      // confirmed→confirm（缺真实证据确定性 E_EVIDENCE_REQUIRED）；fp/dup/ignored→reject
      // （reason≥10 由域 schema 把关）；submitted→submit；accepted→submit(vendor_status=accepted)；
      // new 是回退，语义动词层无此流转 → 拒绝。
      const ctxBase = { actor: 'dashboard', operator: p.operator ? String(p.operator) : null, session_id: null }
      const note = String(p.note || '')
      let r
      if (status === 'confirmed') {
        r = await busDispatch('vuln', 'confirm', { finding_id: id, evidence: String(p.evidence || ''), note }, ctxBase)
      } else if (status === 'false_positive' || status === 'ignored' || status === 'dup') {
        r = await busDispatch('vuln', 'reject', { finding_id: id, verdict: status, reason: note, dup_of: p.dup_of ?? null }, ctxBase)
      } else if (status === 'submitted') {
        r = await busDispatch('vuln', 'submit', { finding_id: id, note, vendor_status: String(p.vendor_status || ''), bounty: p.bounty ?? null }, ctxBase)
      } else if (status === 'accepted') {
        r = await busDispatch('vuln', 'submit', { finding_id: id, note, vendor_status: 'accepted', bounty: p.bounty ?? null }, ctxBase)
      } else {
        const err = new Error('findingUpdate status=new 是回退，不合法；仅补充证据请用 note 语义动词')
        err.code = 'E_STATE'
        throw err
      }
      return { ok: true, id: (r.data && Number.isInteger(Number(r.data.id))) ? Number(r.data.id) : id, ...(r.data || {}) }
    }
    case 'factCorrect': {
      const programId = String(p.program_id || '')
      const factKey = String(p.fact_key || '')
      if (!programId || !factKey) throw new Error('factCorrect 需要 program_id 与 fact_key')
      // v5：fact.correct 接管（06-fact §1.7），fail-closed
      const r = await busDispatch('fact', 'correct', {
        program_id: programId, fact_key: factKey,
        category: p.category !== undefined && p.category !== null ? String(p.category) : undefined,
        summary: p.summary !== undefined && p.summary !== null ? String(p.summary) : undefined,
        body: p.body !== undefined && p.body !== null ? String(p.body) : undefined,
        evidence: String(p.evidence || '人工复核确认'),
      }, { actor: 'dashboard', operator: p.operator ? String(p.operator) : null })
      return { ok: true, ...(r.data || {}) }
    }
    case 'factDeprecate': {
      const programId = String(p.program_id || '')
      const factKey = String(p.fact_key || '')
      if (!programId || !factKey) throw new Error('factDeprecate 需要 program_id 与 fact_key')
      // v5：fact.deprecate 接管，fail-closed
      const r = await busDispatch('fact', 'deprecate', {
        program_id: programId, fact_key: factKey, reason: String(p.reason || '看板弃置（证伪）'),
      }, { actor: 'dashboard', operator: p.operator ? String(p.operator) : null })
      return { ok: true, ...(r.data || {}) }
    }
    // ---- 记忆治理（memcore）：知识 tab ----
    case 'memcore':
      return deps.exp.memStatus()
    case 'expCards': {
      // v5：know.exp_list 接管（07-know §1.7），fail-closed
      const r = await busQuery('know', 'exp_list', { reader: 'review', limit: 200 })
      return { rows: r.rows }
    }
    case 'expFeedback': {
      const id = Number(p.id)
      const verdict = String(p.verdict || '')
      // L4（自学习 §6.2）：exp 写路径唯一入口 = 总线 know 域，fail-closed
      const r = await busDispatch('know', 'exp_feedback', { id, verdict, source: 'dashboard' }, { actor: 'dashboard', operator: p.operator ? String(p.operator) : null })
      return { ok: true, ...(r.data || {}) }
    }
    case 'expPromote': {
      const id = Number(p.id)
      const r = await busDispatch('know', 'exp_promote', { id, evidence: String(p.reason || '看板人工晋升') }, { actor: 'dashboard', operator: p.operator ? String(p.operator) : null })
      return { ok: true, ...(r.data || {}) }
    }
    case 'expDeprecate': {
      const id = Number(p.id)
      const reason = String(p.reason || '看板弃置')
      const r = await busDispatch('know', 'exp_deprecate', { id, reason }, { actor: 'dashboard', operator: p.operator ? String(p.operator) : null })
      return { ok: true, ...(r.data || {}) }
    }
    case 'expUpdate': {
      const id = Number(p.id)
      const justification = String(p.justification || '')
      const r = await busDispatch('know', 'exp_update', { id, takeaway: p.takeaway, justification }, { actor: 'dashboard', operator: p.operator ? String(p.operator) : null })
      return { ok: true, ...(r.data || {}) }
    }
    case 'expExportable': {
      const id = Number(p.id)
      const on = p.exportable ? 1 : 0
      if (!id) throw new Error('expExportable 需要 id')
      const reason = on ? '看板批准导出' : '看板撤销导出'
      const r = on
        ? await busDispatch('know', 'exp_approve_export', { id, reason }, { actor: 'dashboard', operator: p.operator ? String(p.operator) : null })
        : await busDispatch('know', 'exp_revoke_export', { id, reason }, { actor: 'dashboard', operator: p.operator ? String(p.operator) : null })
      return { ok: true, id, exportable: on, ...(r.data || {}) }
    }
    case 'playbooks': {
      // v5：know.exp_rank（pbRank 视图）接管，fail-closed
      const r = await busQuery('know', 'exp_rank', {})
      const playbooks = (r.data && Array.isArray(r.data.playbooks)) ? r.data.playbooks : []
      return { rows: playbooks.map((x) => ({ ...x, last_run_at: null })) }
    }
    // ---- v4.6 知识全景（knowledge tab 分区数据）：kbList 文献浏览 / factOverview 事实分类计数 ----
    // kbList：kb_docs 检索面全量分页（curated 与 external 混排，curated 排前）；kbRead 读单篇正文。
    case 'kbList': {
      // v5：know.kb_list 接管（07-know §1.7），fail-closed
      const r = await busQuery('know', 'kb_list', { q: String(p.q || ''), status: String(p.kind === 'curated' ? 'curated' : (p.kind === 'external' ? 'active' : '')), limit: 200 })
      return { rows: r.rows, counts: r.counts || { curated: 0, external: 0, tainted: 0, zero_use: 0 } }
    }
    case 'kbRead': {
      const id = Number(p.id || 0)
      // v5：know.kb_read 接管，fail-closed
      const r = await busQuery('know', 'kb_read', { doc_id: id })
      return r.data
    }
    // factOverview：知识 tab 事实区分类计数（active/cooling + mem_class 分布）——facts 全量列表在事实 tab
    case 'factOverview': {
      // v5：fact.overview 接管（06-fact §1.7），fail-closed
      const r = await busQuery('fact', 'overview', {})
      return r.data
    }
    // ---- 静态先验 rules/（知识 tab v4.4：人工蒸馏先验层此前无任何观测入口）----
    // 只读两件套：rulesList（目录树+元数据）/ rulesRead（单文件内容，防路径穿越）。写入口仍是 seed-skills.sh 版本受控通道。
    case 'rulesList': {
      // v5：know.rule_list 接管（07-know §1.7），fail-closed
      const r = await busQuery('know', 'rule_list', { q: String(p.q || ''), limit: 500 })
      return { rows: r.rows, dirs: r.dirs || [] }
    }
    case 'rulesRead': {
      // v5：know.rule_read 接管，fail-closed
      const rel0 = String(p.file || '').replace(/^\/+/, '')
      const r = await busQuery('know', 'rule_read', { path: rel0 })
      return r.data
    }
    // ---- 知识覆盖缺口（知识 tab：攻面 × rules/VC 卡交叉表，MINDMAP 式空行即缺口）----
    // 返回 { ok, generated_at, taxonomy[], summary{}, cached, regenerated }；
    // 失败时 { ok: false, error, stale: <旧 JSON 或 null> }。payload.refresh=true 强制重新生成。
    case 'knowledgeCoverage': {
      // v5：know.coverage 接管（缓存直读，refresh 由 know 域算法层承接），fail-closed
      const r = await busQuery('know', 'coverage', { refresh: !!p.refresh })
      return { ok: true, ...(r.data || {}), cached: true }
    }
    // ---- 报告查看（只读）----
    // v4.3：列表元数据化——文件名解析 program/date（report-{prog}-{YYYYMMDD-HHmm}.md，旧 report-{ts}.md 回退 mtime），
    // 首行 # 标题；支持 program/q 筛选，供看板按项目分组。
    case 'reports': {
      // v5：report.list（report 域 report_list 查询，索引直出）接管（12-report §1.7），fail-closed
      const r = await busQuery('report', 'list', { program: String(p.program || ''), q: String(p.q || ''), limit: 200 })
      const base = path.join(deps.dataDir, 'reports')
      const fmt = (ts) => {
        if (!ts) return ''
        const d = new Date(ts + 8 * 3600 * 1000)
        const p2 = (n) => String(n).padStart(2, '0')
        return `${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}-${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}`
      }
      const rows = (r.rows || []).map((x) => {
        let size = 0, mtime = Number(x.generated_at) || 0
        try { const st = fs.statSync(path.join(base, x.file)); size = st.size; mtime = st.mtimeMs } catch { /* 索引行无文件 → size 0 */ }
        return { file: x.file, program: x.program || '', date: fmt(Number(x.generated_at) || 0) || (x.date || ''), title: x.title || '', size, mtime }
      })
      const programs = [...new Set(rows.map((x) => x.program || 'all'))].sort()
      return { rows, programs }
    }
    case 'reportRead': {
      // v5：report.read（report 域 report_read 查询）接管（12-report §1.7），fail-closed
      const rel0 = String(p.file || '').replace(/^\/+/, '')
      const r = await busQuery('report', 'read', { file: rel0 })
      return { file: r.data?.file, content: r.data?.content, truncated: !!r.data?.truncated, size: r.data?.size }
    }
    default:
      throw new Error(`未知看板端点: ${endpoint}`)
  }
}
