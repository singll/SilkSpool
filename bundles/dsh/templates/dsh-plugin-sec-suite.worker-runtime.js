// Web 调度器与 exec 共用的 headless 进程生命周期；不拥有业务表。
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { listSessionHeaders, matchWorkerSession } from './host-compat.js'

const RUN_ID = /^w[a-z0-9]+$/
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

// toolHistory is replay metadata, not another provider payload. Keep the union
// of declarations as a conservative bound for both current-only and in-history
// routes, including removed/deferred definitions, but count identical copies once.
function estimateWorkerInput(options) {
  const declarations = new Map()
  const add = tool => {
    const { deferLoading: _deferred, ...definition } = tool
    const canonical = value => Array.isArray(value) ? value.map(canonical)
      : value && typeof value === 'object'
        ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
    declarations.set(JSON.stringify(canonical(definition)), definition)
  }
  for (const tool of options.tools || []) add(tool)
  for (const tool of options.toolHistory?.tools || []) add(tool)
  for (const update of options.toolHistory?.updates || []) for (const tool of update.additions || []) add(tool)
  const tools = [...declarations.values()]
  const bytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8')
  const payload = { system: options.system, messages: options.messages || [], tools }
  return { estimated_input_tokens: Math.ceil(bytes(payload) / 2) + 2048,
    system_bytes: bytes(options.system ?? ''), message_bytes: bytes(payload.messages),
    tool_bytes: bytes(tools), tool_count: tools.length,
    history_bytes: bytes(options.toolHistory || {}) }
}

// Request admission is deliberately an estimate, not a provider billing guarantee.
// Charge all model calls in this process (including compaction/title/probes).
export function createWorkerBudget(limit, persist = () => {}) {
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error('E_WORKER_BUDGET_REQUIRED')
  const state = { limit, charged: 0, reserved: 0, requests: 0, unknown: 0, denied: 0, recent_requests: [] }
  const fail = code => { state.denied++; persist({ ...state, code }); throw new Error(code) }
  return {
    state,
    async *stream(options, next) {
      // Binary/file projections and unlimited outputs cannot be priced by this estimator.
      if ((options.messages || []).some(m => (m.content || []).some(b => ['image', 'file'].includes(b.type)))) fail('E_WORKER_BUDGET_MODALITY')
      if (!Number.isSafeInteger(options.maxTokens) || options.maxTokens <= 0) fail('E_WORKER_BUDGET_OUTPUT_CAP')
      const estimate = estimateWorkerInput(options)
      const reserved = estimate.estimated_input_tokens + options.maxTokens
      const diagnostic = { sequence: state.requests + state.denied + 1, ...estimate,
        max_output_tokens: options.maxTokens, charged_before: state.charged,
        reserved_before: state.reserved, status: 'reserved' }
      state.recent_requests.push(diagnostic)
      if (state.recent_requests.length > 32) state.recent_requests.shift()
      if (state.charged + state.reserved + reserved > limit) {
        diagnostic.status = 'denied'
        fail('E_WORKER_BUDGET_EXHAUSTED')
      }
      state.reserved += reserved
      state.requests++
      persist({ ...state })
      let usage = null
      try {
        for await (const chunk of next()) {
          if (chunk?.type === 'usage') usage = chunk.usage
          yield chunk
        }
      } finally {
        const fields = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']
        if (usage && fields.every(k => usage[k] == null || Number.isSafeInteger(usage[k]) && usage[k] >= 0)
            && Number.isSafeInteger(usage.inputTokens) && Number.isSafeInteger(usage.outputTokens)
            && Number.isSafeInteger(fields.reduce((n, k) => n + (usage[k] || 0), 0))) {
          state.reserved -= reserved
          state.charged += fields.reduce((n, k) => n + (usage[k] || 0), 0)
          Object.assign(diagnostic, { status: 'settled',
            actual_input_tokens: usage.inputTokens + (usage.cacheReadTokens || 0) + (usage.cacheWriteTokens || 0),
            actual_output_tokens: usage.outputTokens })
        } else {
          state.unknown++ // keep the reservation; an interrupted call is not free.
          diagnostic.status = 'unknown'
        }
        persist({ ...state })
      }
    },
  }
}

// 由宿主下发的随机 nonce 把报告绑定到一次启动；模型无权改写控制文件。
// Session ID 还须由父进程用官方 persistence 的 header 独立核实。
export function installWorkerSessionReporter(ctx, dataDir) {
  const runId = process.env.SEC_WORKER_RUN_ID
  const nonce = process.env.SEC_WORKER_LAUNCH_NONCE
  if (!runId && !nonce) return
  if (!RUN_ID.test(runId || '') || !/^[a-f0-9]{48}$/.test(nonce || '')) {
    throw new Error('E_WORKER_LAUNCH: 无效的 worker 启动身份')
  }
  const installed = Symbol.for('silksec.worker-runtime.installed')
  if (globalThis[installed] === runId) return
  globalThis[installed] = runId
  const filename = path.join(dataDir, 'results', runId, 'worker-session.json')
  if (process.env.SEC_WORKER_BUDGET_TOKENS) {
    const runDir = path.dirname(filename)
    const budget = createWorkerBudget(Number(process.env.SEC_WORKER_BUDGET_TOKENS), state => {
      const tmp = path.join(runDir, `worker-budget.json.tmp-${process.pid}`)
      fs.writeFileSync(tmp, JSON.stringify({ ...state, run_id: runId, nonce, estimator: 'utf8-tool-union-plus-system-v2' }), { mode: 0o600 })
      fs.renameSync(tmp, path.join(runDir, 'worker-budget.json'))
    })
    ctx.on('agent/request', async (_payload, next) => {
      const config = await next()
      return { ...config, maxTokens: Math.min(config.maxTokens || 2048, 2048, budget.state.limit) }
    }, { global: true, prepend: true })
    ctx.on('llm/stream', (options, next) => (async function* () {
      const deadline = Date.now() + 15000
      while (true) {
        let ack
        try { ack = JSON.parse(fs.readFileSync(path.join(runDir, 'worker-ack.json'), 'utf8')) } catch {}
        if (ack?.nonce === nonce && ack?.pid === process.pid && ack?.run_id === runId) break
        if (Date.now() >= deadline) throw new Error('E_WORKER_START_ACK_TIMEOUT')
        await delay(25)
      }
      yield* budget.stream(options, next)
    })(), { global: true, prepend: true })
  }
  let reported = false
  ctx.on('agent/created', ({ agent }) => {
    if (reported || agent?.session?.header?.cwd !== process.cwd()) return
    const header = agent.session.header
    const content = JSON.stringify({ run_id: runId, nonce, pid: process.pid,
      cwd: process.cwd(), session_id: header.id, created_at: header.createdAt }) + '\n'
    try { fs.writeFileSync(filename, content, { flag: 'wx', mode: 0o600 }) }
    catch (error) { if (error.code !== 'EEXIST' || fs.readFileSync(filename, 'utf8') !== content) throw error }
    reported = true
  })
}

export async function verifyWorkerSession({ runDir, runId, nonce, pid, cwd, startedAt, finishedAt, persistence }) {
  try {
    const report = JSON.parse(fs.readFileSync(path.join(runDir, 'worker-session.json'), 'utf8'))
    if (report.run_id !== runId || report.nonce !== nonce || report.pid !== pid || report.cwd !== cwd
        || !/^session-[a-z0-9-]+$/.test(report.session_id || '') || !Number.isSafeInteger(report.created_at)
        || report.created_at < startedAt || report.created_at > finishedAt) {
      return { id: null, code: 'E_WORKER_SESSION_REPORT' }
    }
    const { headers, diagnostics } = await listSessionHeaders(persistence)
    if (diagnostics.length) return { id: null, code: 'E_WORKER_SESSION_LIST' }
    const result = matchWorkerSession(headers, { cwd, startedAt, finishedAt, reportedId: report.session_id })
    if (headers.find(h => h.id === result.id)?.createdAt !== report.created_at) return { id: null, code: 'E_WORKER_SESSION_HEADER' }
    return result
  } catch (error) {
    return { id: null, code: error.code === 'ENOENT' ? 'E_WORKER_SESSION_REPORT_MISSING' : 'E_WORKER_SESSION_VERIFY' }
  }
}

// Linux group probe ignores zombies: they cannot write or execute; their reaper owns removal.
export function workerGroupMembers(pgid) {
  if (!Number.isSafeInteger(pgid) || pgid <= 1) return []
  const members = []
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue
    try {
      const stat = fs.readFileSync(`/proc/${entry}/stat`, 'utf8')
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      if (Number(fields[2]) === pgid && fields[0] !== 'Z') members.push(Number(entry))
    } catch { /* 进程可能刚退出 */ }
  }
  return members
}

export async function executeWorkerProcess({ node, args, env, cwd, runDir, runId, timeoutMs,
  signal, onSpawn, persistence, graceMs = 1000 }) {
  if (!RUN_ID.test(runId) || !Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('E_WORKER_LAUNCH: 启动参数无效')
  const startedAt = Date.now()
  const nonce = crypto.randomBytes(24).toString('hex')
  let child, killer, escalation, spawnError
  let timedOut = false, cancelled = !!signal?.aborted
  const fd = fs.openSync(path.join(runDir, 'worker.log'), 'wx', 0o600)
  const killGroup = sig => {
    if (child?.pid > 1) { try { process.kill(-child.pid, sig) } catch (error) { if (error.code !== 'ESRCH') throw error } }
  }
  const stop = () => {
    killGroup('SIGTERM')
    if (!escalation) escalation = setTimeout(() => killGroup('SIGKILL'), graceMs)
  }
  const abort = () => { cancelled = true; stop() }
  let result = { code: null, signal: null }
  try {
    if (!cancelled) {
      // 直接写同一个文件描述符，避免 stdout/stderr 的两个 pipe 先后 end 丢日志。
      // stdin 明确关闭；普通子进程不会因等待输入阻止收尾。
      child = spawn(node, args, { cwd, detached: true, stdio: ['ignore', fd, fd],
        env: { ...env, SEC_WORKER_RUN_ID: runId, SEC_WORKER_LAUNCH_NONCE: nonce } })
      const closed = new Promise(resolve => {
        child.once('error', error => { spawnError = error.message })
        child.once('close', (code, childSignal) => resolve({ code, signal: childSignal }))
      })
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
      killer = setTimeout(() => { timedOut = true; stop() }, timeoutMs)
      try {
        if (child.pid && onSpawn) await onSpawn({ pid: child.pid, startedAt })
        if (child.pid) fs.writeFileSync(path.join(runDir, 'worker-ack.json'),
          JSON.stringify({ run_id: runId, nonce, pid: child.pid }), { flag: 'wx', mode: 0o600 })
      }
      catch (error) { spawnError = error.message; stop() }
      result = await closed
      // 正常主进程退出也不能留下继承了进程组的后台写者。
      if (workerGroupMembers(child.pid).length) {
        stop()
        const deadline = Date.now() + graceMs + 2000
        while (workerGroupMembers(child.pid).length && Date.now() < deadline) await delay(25)
        if (workerGroupMembers(child.pid).length) spawnError = 'E_WORKER_RESIDUAL_PROCESS'
      }
    }
  } finally {
    clearTimeout(killer)
    clearTimeout(escalation)
    signal?.removeEventListener('abort', abort)
    fs.fsyncSync(fd)
    fs.closeSync(fd)
  }
  const finishedAt = Date.now()
  const session = persistence && child?.pid
    ? await verifyWorkerSession({ runDir, runId, nonce, pid: child.pid, cwd, startedAt, finishedAt, persistence })
    : { id: null, code: 'E_WORKER_SESSION_PERSISTENCE' }
  let budget = null
  try {
    const report = JSON.parse(fs.readFileSync(path.join(runDir, 'worker-budget.json'), 'utf8'))
    if (report.run_id === runId && report.nonce === nonce && report.limit === Number(env.SEC_WORKER_BUDGET_TOKENS)
        && ['charged', 'reserved', 'requests', 'denied', 'unknown'].every(k => Number.isSafeInteger(report[k]) && report[k] >= 0)) {
      const { nonce: _nonce, ...counts } = report
      budget = counts
    }
  } catch {}
  return { ...result, ...(spawnError ? { error: spawnError } : {}), pid: child?.pid || null, budget,
    timed_out: timedOut, cancelled, startedAt, finishedAt, session_id: session.id, session_diagnostic: session.code || null }
}
