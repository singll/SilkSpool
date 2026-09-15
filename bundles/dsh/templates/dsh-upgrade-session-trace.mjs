// 只在隔离副本中用正式只读句柄核验 fixture 的模型归因，不输出生产会话内容。
import fs from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'

const out = '/tmp/dsh-rehearsal'
await fs.access(path.join(out, 'isolation.json'))
const base = process.env.SEC_BASE_DIR
const require = createRequire(await fs.realpath(path.join(base, 'app/node_modules/@deepseek-ai/dsh/package.json')))
const { Context } = await import(require.resolve('@deepseek-ai/cordis'))
const { default: Backend } = await import(require.resolve('@deepseek-ai/dsh-session-persistence-jsonl'))
const ctx = new Context()
try {
  await ctx.plugin(Backend, { root: path.join(base, 'data/sessions'), compression: 'zstd' })
  const handle = await ctx.sessionPersistence.open(process.argv[2], 'read')
  let saved
  try { saved = { header: handle.header, ...await handle.read() } } finally { await handle.close() }
  const messages = saved.events.filter(row => row.type === 'assistant/message')
  const { default: Projections } = await import(require.resolve('@deepseek-ai/dsh-session-projection'))
  const { billTurnsProjection } = await import(pathToFileURL(path.join(base, 'data/profiles/web/node_modules/dsh-bill/lib/projection.js')).href)
  const fresh = async () => {
    const instance = new Context()
    await instance.plugin(Projections)
    instance.sessionProjections.register(billTurnsProjection)
    return instance
  }
  const first = await fresh(), second = await fresh()
  try {
    const events = saved.events, header = saved.header, inherited = header.seedLength ?? 0
    const split = Math.max(1, Math.floor(events.length / 2))
    const prefix = first.sessionProjections.restore({}, events.slice(0, split), 0, header, inherited)
    // 模拟实际缓存写盘、进程退出和新注册表用尾部恢复，不能共享内存引用。
    const persisted = JSON.parse(JSON.stringify(prefix.checkpoint))
    const floor = second.sessionProjections.restoreFloor(persisted)
    const restored = second.sessionProjections.restore(persisted, events.slice(floor), floor, header, inherited)
    const complete = first.sessionProjections.restore({}, events, 0, header, inherited)
    assert.deepEqual(restored.snapshot, complete.snapshot)
    assert.ok(complete.snapshot.values.billTurns.calls > 0, 'billTurns must be visible to the client')
    const old = structuredClone(persisted)
    old.billTurns.ver = 1
    assert.equal(second.sessionProjections.restoreFloor(old), 0)
    assert.deepEqual(second.sessionProjections.restore(old, events, 0, header, inherited).snapshot, complete.snapshot)
    const corrupt = structuredClone(persisted)
    corrupt.billTurns.val.totals.inputTokens = -1
    assert.throws(() => second.sessionProjections.restore(corrupt, events.slice(floor), floor, header, inherited), /invalid persisted/)
  } finally { await first.fiber.dispose(); await second.fiber.dispose() }
  const report = {
    session_id: saved.header.id,
    events: saved.events.length,
    assistant_routes: messages.map(row => ({ provider: row.data?.message?.source?.provider, model: row.data?.message?.source?.model })),
    fixture_complete: messages.some(row => JSON.stringify(row.data).includes('U2_FIXTURE_OK')),
    last_assistant_message_id: messages.at(-1)?.data?.message?.id,
    feedback_events: saved.events.filter(row => row.type.startsWith('feedback/')).map(row => ({
      type: row.type, session_id: row.data.sessionId,
      message_id: row.data.item?.messageId ?? row.data.messageId,
      rating: row.data.item?.rating,
    })),
    billing_cache: { restored_in_fresh_registry: true, old_version_refolded: true, corrupt_state_rejected: true },
  }
  await fs.writeFile(path.join(out, 'session-trace.json'), JSON.stringify(report, null, 2) + '\n')
} finally { await ctx.fiber.dispose() }
