// ==============================================================================
// P11 定时任务调度循环（sec-suite host 面，仅 web profile 启动）
// 60s tick → SQLite 事务原子认领到期任务 → runWorker(cwd=工作区路径) → 收尾续期。
// 重启恢复：任务状态在 SQLite，过期的 interval 按 latest-only 补触发最近一次。
// ==============================================================================

import * as fs from 'node:fs'
import * as path from 'node:path'
import { listSessionHeaders, matchWorkerSession, createPersonaReader, buildScheduledPrompt } from './host-compat.js'

// 依赖注入（由 index.js 调用 startScheduler 时传入，避免循环依赖）：
//   dataDir                数据目录（主文件 DATA_DIR，用于推导锁文件与 preset 目录）
//   audit                  主文件 audit()：审计 JSONL 落盘
//   assetDb                asset-db.js 模块命名空间（任务认领/收尾/回收）
//   exp                    experience.js 模块命名空间（kbVaultSync vault 回流）
//   runWorker              主文件 runWorker()：worker 执行核心
//   pidAlive               主文件 pidAlive()：进程存活探测
//   getWorkspaceRegistry   () => 主文件 workspaceRegistryRef（fiber 注入，可能为 null，须惰性读取）
//   getSessionPersistence  () => 主文件 sessionPersistenceRef（同上）
let deps = null

const SCHEDULER_TICK_MS = 60000
let lastVaultSyncDay = ''
// 定时任务 worker 执行上限：原 1800s 与任务体量不匹配导致每晚超时被杀，放宽到 runWorker 上限 3600s
const SCHEDULER_TASK_TIMEOUT_SEC = 3600

function workspacePathOfProgram(programId) {
  const p = deps.assetDb.listPrograms().find((x) => x.id === programId)
  return (p && p.workspace_path) || null
}

// 工作区会话归组 reconcile：headless worker / CLI 产生的会话按 header cwd 匹配工作区路径，
// attachSession 幂等（已归组则无写）。registry 对后期 cwd-only 会话不自动归组（上游语义），这里补齐。
async function reconcileWorkspaceSessions() {
  const workspaceRegistryRef = deps.getWorkspaceRegistry()
  const sessionPersistenceRef = deps.getSessionPersistence()
  if (!workspaceRegistryRef || !sessionPersistenceRef) return
  let headers
  try {
    const result = await listSessionHeaders(sessionPersistenceRef)
    headers = result.headers
    if (result.diagnostics.length) process.stderr.write(`[sec-suite] Session 列表存在无效记录: ${JSON.stringify(result.diagnostics)}\n`)
  } catch (e) { process.stderr.write(`[sec-suite] Session 列表读取失败: ${e.message}\n`); return }
  let workspaces
  try { workspaces = workspaceRegistryRef.list() } catch { return }
  const byPath = {}
  for (const w of workspaces) byPath[w.path] = w
  for (const h of headers) {
    const w = h && h.cwd ? byPath[String(h.cwd)] : null
    if (!w) continue
    try { await w.attachSession(h.id) } catch { /* 单个失败不影响其余 */ }
  }
}

// worker.log 尾部噪声（headless 进程 stderr 杂讯）不进入任务摘要
const WORKER_NOISE_RE = /ExperimentalWarning|trace-warnings|EADDRINUSE|xray webhook 启动失败|onnxruntime|pthread_setaffinity|\[memcore|secMemoryLifecycle|sweeper 未启动/

// P15：按 cwd + 时间窗反查 headless worker 自己的会话 id（跳链地基）。
// worker 会话 header.cwd 与 createdAt 必须匹配；并发歧义/缺少时间戳时不造跳链。
async function findWorkerSessionId(cwd, startedAt) {
  try {
    const sp = deps.getSessionPersistence()
    if (!sp || !cwd) return null
    const { headers, diagnostics } = await listSessionHeaders(sp)
    if (diagnostics.length) {
      process.stderr.write(`[sec-suite] worker Session 列表不完整，拒绝反查: ${JSON.stringify(diagnostics)}\n`)
      return null
    }
    const result = matchWorkerSession(headers, { cwd, startedAt, finishedAt: Date.now() })
    if (result.code) process.stderr.write(`[sec-suite] worker Session 关联: ${JSON.stringify(result)}\n`)
    return result.id
  } catch (e) { process.stderr.write(`[sec-suite] worker Session 反查失败: ${e.message}\n`); return null }
}

// 定时任务角色注入：按 phase 读对应 preset 的 persona（单一事实源=preset 文件，与 webui 自定义 agent 同步演化）。
// headless CLI 无 --agent 选项，调度 worker 原只有通用 coding-agent 人格——此处补齐项目层等价实现。
const readPersona = createPersonaReader()
function personaOfPhase(phase, cwd) {
  return readPersona(deps.dataDir, phase, cwd)
}

// v4.5 FGS 跨任务沉淀：任务 done → fgs_nodes 中 type=fact、status=done 且 content 含证据的节点
// 转正为 durable facts（fact_key = fgs/{task_id}/{node_id}，冲突即刷新 last_validated_at，天然幂等）。
// FGS 图生命周期与任务绑定（下个任务 fgsClearTask 清旧图），沉淀是它唯一的跨任务出口——
// 没有这层，每晚 vuln 任务产出的结论性事实随图一起蒸发（cairn-y §5.8 断链）。
function persistFgsFacts(task) {
  const nodes = deps.assetDb.fgsListNodes({ task_id: task.id, type: 'fact', status: 'done', limit: 100 })
  if (!nodes || !nodes.length) return
  let n = 0
  for (const node of nodes) {
    const c = typeof node.content === 'string' ? safeJsonParse(node.content) : (node.content || {})
    const summary = String(c?.summary || '').trim()
    if (!summary) continue
    // 只沉淀结论性事实：content 须携带证据（detail/evidence/run_id），防把空泛 step 感想灌进 facts
    const detail = String(c?.detail || c?.evidence || '').trim()
    if (!detail) continue
    try {
      const r = deps.assetDb.factUpsert({
        program_id: task.program_id,
        fact_key: `fgs/${task.id}/${node.id}`,
        category: 'fgs',
        summary: summary.slice(0, 200),
        body: detail.slice(0, 2000),
        confidence: 'confirmed',
        source: 'fgs-persist',
        intent: {
          mem_class: 'durable', revalidate_days: 30,
          justification: `FGS 任务 #${task.id} 结论性事实沉淀（决策链留痕于 fgs_nodes，证据见 body）`,
        },
      })
      if (r.ok) n++
    } catch { /* 单节点失败不影响其余 */ }
  }
  if (n) process.stderr.write(`[sec-suite] 任务 #${task.id} FGS 沉淀 ${n} 条事实进 facts\n`)
}

function safeJsonParse(s) { try { return JSON.parse(s) } catch { return null } }

async function schedulerTick() {
  let due
  try { due = deps.assetDb.taskClaimDue(Date.now()) } catch (e) {
    process.stderr.write(`[sec-suite] 调度认领失败: ${e?.message ?? String(e)}\n`)
    return
  }
  // 到期任务相互独立：并行启动（修复串行 await 导致第 N 个任务晚 (N-1)×上限 才开跑的问题）。
  // 每个 callback 全段 try/catch + stderr 落日志：任何单任务异常可见可查，不再静默吞掉。
  await Promise.allSettled(due.map(async (task) => {
    const startedAt = Date.now()
    try {
      const cwd = workspacePathOfProgram(task.program_id)
      const role = personaOfPhase(task.phase, cwd)
      // P17：任务启动前初始化 FGS 图（外化记忆），清除旧图并写入顶层 Goal
      try {
        deps.assetDb.fgsClearTask(task.id)
        deps.assetDb.fgsAddNode({
          task_id: task.id,
          type: 'goal',
          status: 'open',
          content: { summary: task.objective?.slice(0, 200) || '定时任务目标', detail: task.objective }
        })
      } catch (e) {
        process.stderr.write(`[sec-suite] 任务 #${task.id} FGS 初始化失败: ${e?.message ?? String(e)}\n`)
      }
      const prompt = buildScheduledPrompt(task, role)
      deps.audit({ ts: Date.now(), run_id: '-', tool: 'scheduler', decision: 'executed', detail: { task_id: task.id, program_id: task.program_id, provider: task.provider, model: task.model } })
      // v4.5 任务预算：task-budget-extend 批准写入 budget_timeout_sec → 本周期起 runWorker 用
      // max(默认上限, 该值)（7200s 封顶，防 2 小时外的失控 worker 占死调度槽）
      const taskBudget = Math.min(Number(task.budget_timeout_sec) || 0, 7200)
      const timeoutSec = Math.max(SCHEDULER_TASK_TIMEOUT_SEC, taskBudget)
      const r = await deps.runWorker({ task: prompt, cwd, timeoutSec, enforceLimit: true, provider: task.provider, model: task.model, reasoningEffort: task.reasoning_effort, phase: task.phase || '' })
      if (r.busy) {
        try { deps.assetDb.taskUpdate({ id: task.id, status: 'queued', note: 'worker 并发已满，延后到下一 tick' }) } catch { /* ignore */ }
        return
      }
      let note = ''
      let timedOut = false
      if (!r.ok && r.exit_code === null && r.duration_ms >= SCHEDULER_TASK_TIMEOUT_SEC * 1000 - 15000) {
        note = `worker 超时被杀（${SCHEDULER_TASK_TIMEOUT_SEC} 秒上限）`  // 显式写原因，不再展示日志尾部噪声
        timedOut = true
      } else {
        note = (r.tail || '').split('\n').filter((l) => l.trim() && !WORKER_NOISE_RE.test(l)).slice(-3).join(' ').slice(0, 300)
      }
      // v4.5 异步审批：超时自动提请 task-budget-extend（拒绝语义不变——本周期已杀；批准写
      // tasks.budget_timeout_sec，下个周期 runWorker 取 max(默认, 该值)）。幂等去重靠 approvalAdd
      // 的同 (kind, subject) pending 查重。worker 尾部有实质产出迹象（非空 tail）才提，纯空跑不配延预算。
      if (timedOut) {
        try {
          const tailEvidence = (r.tail || '').split('\n').filter((l) => l.trim() && !WORKER_NOISE_RE.test(l)).slice(-5).join(' ').slice(0, 400)
          const add = deps.assetDb.approvalAdd({
            kind: 'task-budget-extend', subject: `task:${task.id}`, program_name: task.program_id,
            payload: { task_id: task.id, program: task.program_id, timed_out_at_sec: SCHEDULER_TASK_TIMEOUT_SEC, budget_timeout_sec: 7200, run_id: r.run_id || null, tail: tailEvidence || '(无尾部输出)' },
            evidence: `任务 #${task.id}（${task.program_id}/${task.phase || '-'}）worker 跑满 ${SCHEDULER_TASK_TIMEOUT_SEC}s 上限被杀${tailEvidence ? '，尾部显示工作仍在推进（接近产出）' : '，尾部无输出（空跑嫌疑，谨慎批准）'}。批准后下周期预算上限 7200s`,
            requested_by: 'scheduler:auto',
          })
          if (add.ok) process.stderr.write(`[sec-suite] 任务 #${task.id} 超时，已自动提请 task-budget-extend 审批 #${add.request_id}\n`)
        } catch (e) { process.stderr.write(`[sec-suite] 任务 #${task.id} 超时审批提请失败: ${e?.message}\n`) }
      }
      // P15 修复跳链断链：headless worker 的会话按 cwd 反查（header.cwd=工作区 → workspaceRegistry 归组），
      // 回填 meta.json 与 task_runs.session_id——调度 run 此前 session_id 恒为 null。
      const workerSessionId = await findWorkerSessionId(cwd, startedAt)
      if (workerSessionId && r.run_id) {
        try {
          const metaPath = path.join(deps.dataDir, 'results', r.run_id, 'meta.json')
          const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'))
          meta.session_id = workerSessionId
          fs.writeFileSync(metaPath, JSON.stringify(meta, null, 1) + '\n')
        } catch { /* meta 回填失败不影响主流程 */ }
      }
      deps.assetDb.taskFinishScheduledRun({ id: task.id, ok: !!r.ok, run_id: r.run_id || '', note, session_id: workerSessionId ?? null })
      // v4.5 FGS 跨任务沉淀（cairn-y §5.8 遗留落地）：任务 done 时把该任务 FGS 图中已完成的 fact
      // 节点同步为 durable facts——FGS 图本是"一次性记忆"（任务结束节点沉睡，下个任务不复用），
      // 此钩子把带证据的结论性事实转正进 facts 表供后续任务检索。best-effort：失败不阻断收尾。
      if (r.ok) {
        try { persistFgsFacts(task) } catch (e) {
          process.stderr.write(`[sec-suite] 任务 #${task.id} FGS 沉淀失败: ${e?.message ?? String(e)}\n`)
        }
      }
    } catch (e) {
      process.stderr.write(`[sec-suite] 调度任务 #${task.id} 执行异常: ${e?.stack || e?.message || String(e)}\n`)
      try { deps.assetDb.taskFinishScheduledRun({ id: task.id, ok: false, run_id: '', note: `调度执行异常: ${e?.message ?? String(e)}`.slice(0, 300) }) } catch { /* ignore */ }
    }
  }))
  // vault 回流（Bellkeeper 融合方向②）：每日 05 时后首个 tick 拉取安全域卡 → kb_docs（防循环/去重在 kbVaultSync 内）
  const today = new Date().toISOString().slice(0, 10)
  if (lastVaultSyncDay !== today && new Date().getHours() >= 5) {
    lastVaultSyncDay = today
    deps.exp.kbVaultSync().then((r) => {
      process.stderr.write(`[sec-suite] vault 回流: ${JSON.stringify(r)}\n`)
    }).catch((e) => process.stderr.write(`[sec-suite] vault 回流异常: ${e?.message}\n`))
  }
  // 顺带做工作区会话归组（轻量、幂等）——已移至 tick 层每 10 周期执行，此处不再重复
}

// 跨进程单例（P0-1）：插件被宿主面与每个 agent/worker 子进程分别加载，globalThis 不跨进程，
// 模块级/globalThis 单例都挡不住多进程各起调度循环（实测 10+ PID 各跑 tick + database is locked）。
// 用文件锁 data/scheduler.lock（持有者 PID + 心跳时间戳）保证全机只有一个进程真正认领任务。
const SCHEDULER_LOCK_STALE_MS = 180000 // 3 分钟无心跳（容 3 个 tick 未刷新）视为死锁，可抢占
// 原主文件模块级常量 SCHEDULER_LOCK = path.join(DATA_DIR, 'scheduler.lock')，改为按注入 dataDir 惰性求值（值不变）
const schedulerLockPath = () => path.join(deps.dataDir, 'scheduler.lock')

// 抢锁：无锁文件 / 持有者已死 / 心跳超期 → 写入自己 PID。返回是否持有。
function acquireSchedulerLock() {
  try {
    const cur = JSON.parse(fs.readFileSync(schedulerLockPath(), 'utf8'))
    if (cur && cur.pid && cur.pid !== process.pid && deps.pidAlive(cur.pid) && (Date.now() - (cur.ts || 0) < SCHEDULER_LOCK_STALE_MS)) {
      return false // 活锁被他人持有
    }
  } catch { /* 无锁文件或损坏 → 可抢 */ }
  try { fs.writeFileSync(schedulerLockPath(), JSON.stringify({ pid: process.pid, ts: Date.now() })); return true } catch { return false }
}
function holdsSchedulerLock() {
  try { return JSON.parse(fs.readFileSync(schedulerLockPath(), 'utf8')).pid === process.pid } catch { return false }
}

export function startScheduler(injected) {
  deps = injected
  if (globalThis.__silksecScheduler) return
  if (!acquireSchedulerLock()) return // 已有活的调度进程持锁，本进程不启动（收敛多进程内讧）
  // 启动即回收：新进程启动意味着旧进程已终止，其派发的所有 running scheduled 任务均为孤儿 → 无条件回收（maxAge=0）
  try { deps.assetDb.taskReapStale(0) } catch { /* 启动僵尸回收，失败不阻断 */ }
  // worker 注册表启动对账：把重启杀死的在飞 worker 从 running 重分类为 done/failed/killed（供重试幂等恢复）
  try { deps.assetDb.workerReapStale() } catch { /* 失败不阻断 */ }
  process.once('exit', () => { try { if (holdsSchedulerLock()) fs.unlinkSync(schedulerLockPath()) } catch { /* ignore */ } })
  let tick = 0
  globalThis.__silksecScheduler = setInterval(() => {
    // 心跳续锁 + 持有校验：丢锁则尝试重夺，仍被他人活持则本 tick 跳过（不认领）
    if (!holdsSchedulerLock() && !acquireSchedulerLock()) return
    try { fs.writeFileSync(schedulerLockPath(), JSON.stringify({ pid: process.pid, ts: Date.now() })) } catch { /* ignore */ }
    // 周期回收：宽限期 = 超时上限 + 15min（旧默认 1h 与超时同量级，跑满预算的正常任务会被误杀）；
    // 传 pidAlive 让回收跳过「last_run worker 还活着」的在飞任务（防双重派单）。
    if ((++tick % 10) === 0) { try { deps.assetDb.taskReapStale((SCHEDULER_TASK_TIMEOUT_SEC + 900) * 1000, deps.pidAlive) } catch { /* ignore */ } }
    // 孤儿 worker 周期对账（P12-1）：父 worker 被杀会留下 registry 永远 running 的孙 worker
    // （孙进程 detached 自成进程组，外层 SIGKILL 够不着），按 pid 死活定期重分类
    if ((tick % 10) === 0) { try { deps.assetDb.workerReapStale() } catch { /* ignore */ } }
    schedulerTick().catch(() => {})
    // 会话归组 reconcile 是全量 list+attach，每 tick 跑浪费 I/O：降到每 10 tick（≈10min），够收敛即可
    if ((tick % 10) === 0) reconcileWorkspaceSessions().catch(() => {})
  }, SCHEDULER_TICK_MS)
  globalThis.__silksecScheduler.unref?.()
  process.stderr.write(`[sec-suite] 定时任务调度循环已启动（60s tick, pid=${process.pid}）\n`)
}
