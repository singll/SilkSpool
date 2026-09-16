// 调度器与 task 域共用的周期策略。只操作任务仓库传入的连接，不打开第二个库。
export const MAX_SCHEDULED_ATTEMPTS = 3
export const MAX_WORKER_TIMEOUT_SEC = 7200

export function cycleStart(task, at) {
  const step = Number(task.every_seconds) * 1000
  const anchor = Number(task.run_at) || Number(task.next_run_at) || at
  return step > 0 ? anchor + Math.floor((at - anchor) / step) * step : at
}

export function scheduledProgress(db, task, at = Date.now()) {
  const since = cycleStart(task, at)
  const runs = db.prepare('SELECT run_id,ok,finished_at FROM task_runs WHERE task_id=? ORDER BY id DESC LIMIT 200')
    .all(task.id)
  const last = runs[0]
  return { attempts: runs.filter(r => r.finished_at >= since).length,
    resume: !!last && !last.ok, resume_run_id: last && !last.ok ? last.run_id || null : null }
}

export function nextScheduledRun(task, finished, ok, previousAttempts = 0, timedOut = false) {
  const step = Number(task.every_seconds) * 1000
  const anchor = Number(task.run_at) || Number(task.started_at) || Number(task.next_run_at) || finished
  const next = anchor > finished ? anchor : anchor + (Math.floor((finished - anchor) / step) + 1) * step
  // 每个标称周期最多三次；超时一分钟后续跑，其他失败指数退避 5/10 分钟。
  // 下一标称周期仍按原锚点运行，手动触发和续跑都不能改变日历节律。
  if (ok || previousAttempts + 1 >= MAX_SCHEDULED_ATTEMPTS) return next
  const delay = timedOut ? 60000 : 300000 * 2 ** Math.min(previousAttempts, 1)
  return Math.min(next, finished + delay)
}

export function selectDueTasks(db, now, limit = 4) {
  // 周期前置回 queued 是正常收尾；须校验它在当前周期的成功执行证据，不能只看 status=done。
  // 用 SQL 在 LIMIT 之前过滤依赖，避免等待中的高优先级任务饿死其他可运行任务。
  return db.prepare(`SELECT t.id FROM tasks t
    LEFT JOIN tasks p ON p.id=t.parent_id
    WHERE t.schedule_kind IS NOT NULL AND t.status='queued' AND t.next_run_at<=:now
      AND (t.parent_id IS NULL OR (
        (COALESCE(p.schedule_kind,'')!='interval' AND p.status='done'
          AND COALESCE(p.finished_at,0)+COALESCE(t.after_delay_seconds,0)*1000<=:now)
        OR (p.schedule_kind='interval' AND p.status='queued' AND p.every_seconds>0
          AND p.run_at>0 AND EXISTS (
            SELECT 1 FROM task_runs r WHERE r.task_id=p.id AND r.run_id=p.last_run_id AND r.ok=1
              AND r.finished_at>=p.run_at+CAST((:now-p.run_at)/(p.every_seconds*1000) AS INTEGER)*(p.every_seconds*1000)
              AND r.finished_at+COALESCE(t.after_delay_seconds,0)*1000<=:now
          ))
      ))
    ORDER BY t.priority ASC,t.next_run_at ASC,t.id ASC LIMIT :limit`)
    .all({ now, limit: Math.min(Math.max(Number(limit) || 4, 1), 4) })
}

export function validateDependency(getTask, task, parentId, delaySeconds = 0) {
  if (parentId == null) return null
  if (!Number.isSafeInteger(parentId) || parentId <= 0) return '前置任务 ID 必须为正整数'
  if (!Number.isSafeInteger(delaySeconds) || delaySeconds < 0 || delaySeconds > 86400) return '前置完成后的延迟须为 0–86400 秒'
  const seen = new Set(task.id ? [Number(task.id)] : [])
  let id = parentId
  while (id != null) {
    if (seen.has(id)) return '任务依赖不能形成循环'
    seen.add(id)
    const parent = getTask(id)
    if (!parent) return `前置任务 #${id} 不存在`
    if (parent.program_id !== task.program_id) return '前置任务必须属于同一授权项目'
    if (id === parentId && parent.schedule_kind === 'interval' && task.schedule_kind === 'interval'
        && parent.every_seconds !== task.every_seconds) return '周期依赖的前后任务须使用相同周期'
    id = parent.parent_id
  }
  return null
}

export function taskWorkerAlive(db, task, alive) {
  const runId = task.active_run_id || task.last_run_id
  if (!runId) return false
  const worker = db.prepare('SELECT pid,status FROM workers WHERE run_id=?').get(runId)
  return !!(worker && worker.status === 'running' && alive(worker.pid))
}

export function withinTaskBudget(task, now, maxAgeMs) {
  return maxAgeMs > 0 && now - task.started_at < Math.max(maxAgeMs,
    Math.min(MAX_WORKER_TIMEOUT_SEC, Number(task.budget_timeout_sec) || 3600) * 1000 + 900000)
}
