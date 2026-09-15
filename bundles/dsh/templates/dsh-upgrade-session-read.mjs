#!/usr/bin/env node
// 在隔离恢复副本中实际读完全部会话；兼容旧版只读 backend 与 Session V3 读句柄。
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { performance } from 'node:perf_hooks'

const base = process.env.SEC_BASE_DIR
if (!base) throw new Error('仅供隔离副本验收')
await fs.access('/tmp/dsh-rehearsal/isolation.json')
const require = createRequire(await fs.realpath(path.join(base, 'app/node_modules/@deepseek-ai/dsh/package.json')))
const version = JSON.parse(await fs.readFile(require.resolve('@deepseek-ai/dsh/package.json'), 'utf8')).version
const { Context } = await import(require.resolve('@deepseek-ai/cordis'))
const { default: Backend } = await import(require.resolve('@deepseek-ai/dsh-session-persistence-jsonl'))
const sources = [path.join(base, 'data/sessions'), path.join(base, 'sessions')]
const report = { version, sessions: [], failures: [], ok: false }
for (const root of sources) {
  const ctx = new Context()
  try {
    if (version === '0.1.2-rc.1') {
      const { SessionStore } = await import(require.resolve('@deepseek-ai/dsh-session'))
      await ctx.plugin(SessionStore)
    } else if (version !== '0.1.5-rc.2') throw new Error('未知 DSH 版本')
    await ctx.plugin(Backend, { root, compression: 'zstd' })
    for (const row of await ctx.sessionPersistence.list()) {
      const header = row.header ?? row
      try {
        const started = performance.now()
        let events
        if (version === '0.1.2-rc.1') {
          const stored = await ctx.sessionPersistence.loadStored(header.id)
          if (!stored) throw new Error('旧版 backend 读回为空')
          events = stored.events
        } else {
          const handle = await ctx.sessionPersistence.open(header.id, 'read')
          try { events = (await handle.read()).events } finally { await handle.close() }
        }
        if (!Array.isArray(events)) throw new Error('会话事件未读回')
        report.sessions.push({ id: header.id, root, events: events.length, load_ms: performance.now() - started,
          event_sha256: createHash('sha256').update(JSON.stringify(events)).digest('hex') })
      } catch (error) {
        report.failures.push({ id: header.id, name: error.name, message: error.message })
      }
    }
  } finally { await ctx.fiber.dispose() }
}
report.ok = report.failures.length === 0 && report.sessions.length > 0
const timings = report.sessions.map(row => row.load_ms).sort((a, b) => a - b)
report.latency = { samples: timings.length, p50_ms: timings[Math.max(0, Math.ceil(timings.length * 0.5) - 1)],
  p95_ms: timings[Math.max(0, Math.ceil(timings.length * 0.95) - 1)], max_ms: timings.at(-1),
  measurement: 'sequential read-only scan; operating-system cache not controlled' }
await fs.writeFile('/tmp/dsh-rehearsal/session-read-report.json', JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify({ ok: report.ok, version, sessions: report.sessions.length, failures: report.failures.length }))
if (!report.ok) process.exitCode = 1
