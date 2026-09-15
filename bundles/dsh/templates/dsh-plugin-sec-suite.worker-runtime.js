// Web 调度器与 exec 共用的 headless 进程生命周期；不拥有业务表。
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { listSessionHeaders, matchWorkerSession } from './host-compat.js'

const RUN_ID = /^w[a-z0-9]+$/
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

// 由宿主下发的随机 nonce 把报告绑定到一次启动；模型无权改写控制文件。
// Session ID 还须由父进程用官方 persistence 的 header 独立核实。
export function installWorkerSessionReporter(ctx, dataDir) {
  const runId = process.env.SEC_WORKER_RUN_ID
  const nonce = process.env.SEC_WORKER_LAUNCH_NONCE
  if (!runId && !nonce) return
  if (!RUN_ID.test(runId || '') || !/^[a-f0-9]{48}$/.test(nonce || '')) {
    throw new Error('E_WORKER_LAUNCH: 无效的 worker 启动身份')
  }
  const filename = path.join(dataDir, 'results', runId, 'worker-session.json')
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
      try { if (child.pid && onSpawn) await onSpawn({ pid: child.pid, startedAt }) }
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
  return { ...result, ...(spawnError ? { error: spawnError } : {}), pid: child?.pid || null,
    timed_out: timedOut, cancelled, startedAt, finishedAt, session_id: session.id, session_diagnostic: session.code || null }
}
