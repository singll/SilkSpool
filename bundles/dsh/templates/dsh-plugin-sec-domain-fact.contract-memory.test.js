import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createBus } from '../../sec-domain-bus/index.js'
import { buildFactDomain } from '../index.js'
import { buildKnowDomain } from '../../sec-domain-know/index.js'

test('27 L16: generated memory guidance follows registered model permissions and live blackboard data', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-memory-guidance-'))
  const oldDataDir = process.env.SEC_DATA_DIR
  process.env.SEC_DATA_DIR = dir
  let bus
  try {
    const { apply } = await import('../../sec-memcore/index.js?guidance')
    bus = createBus({ dataDir: dir, dbFile: path.join(dir, 'graph.db'),
      auditFile: path.join(dir, 'audit.jsonl'), eventsDir: path.join(dir, 'events'),
      sidecars: false, startDispatcherTimer: false })
    for (const build of [buildFactDomain, buildKnowDomain]) {
      const domain = build({ dataDir: dir,
        dispatch: (...args) => bus.dispatch(...args), query: (...args) => bus.query(...args) })
      assert.equal(bus.registry.register(domain).ok, true)
    }
    const entry = await bus.dispatch('fact', 'bb_publish', {
      key: '[env-issue] local fixture', value: 'fixture-egress-unavailable', ttl_days: 1,
    }, { actor: 'model' })
    assert.equal(entry.ok, true)
    const rows = await bus.query('fact', 'bb_read', { reader: 'task' }, { actor: 'system' })
    assert.equal(rows.ok, true)
    assert.ok(rows.data.some(row => row.value === 'fixture-egress-unavailable'))
    assert.equal((await bus.dispatch('fact', 'bb_publish', {
      key: '[env-issue] expired fixture', value: 'fixture-expired', ttl_days: 1,
    }, { actor: 'model' })).ok, true)
    bus._internal.db().prepare('UPDATE blackboard SET expires_at=? WHERE key=?')
      .run(Date.now() - 1000, '[env-issue] expired fixture')
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'User maintained instructions.\n')
    let api
    apply({ provide(_name, value) { api = value },
      inject(_names, callback) { callback({ secDomainBus: bus }) } }, { sweeper: false })
    const refresh = async () => {
      await api.refreshAgentsMd()
      // The legacy service returned before its asynchronous file write.
      await new Promise(resolve => setImmediate(resolve))
      return fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8')
    }
    const text = await refresh()
    assert.match(text, /fixture-egress-unavailable/)
    assert.doesNotMatch(text, /fixture-expired/)
    assert.match(text, /know_revision_propose/)
    assert.match(text, /fact_record_validation/)
    assert.doesNotMatch(text, /exp_store|pb_save|exp_validate|自动晋升/)
    assert.match(text, /User maintained instructions/)
    assert.equal(await refresh(), text, 'unchanged input must not rewrite the managed block')

    // Governance changes are reflected from the registered manifest, not a second allowlist.
    const command = bus.registry.get('know').manifest.commands.know_revision_propose
    const actors = command.actor
    command.actor = ['dashboard']
    assert.doesNotMatch(await refresh(), /know_revision_propose/)
    command.actor = actors
    const archived = await bus.dispatch('fact', 'transition', {
      object: 'bb', bb_key: '[env-issue] local fixture', to: 'archived', reason: 'fixture resolved',
    }, { actor: 'system' })
    assert.equal(archived.ok, true, archived.error?.message)
    assert.doesNotMatch(await refresh(), /fixture-egress-unavailable/)
  } finally {
    bus?._internal.close()
    if (oldDataDir === undefined) delete process.env.SEC_DATA_DIR
    else process.env.SEC_DATA_DIR = oldDataDir
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
