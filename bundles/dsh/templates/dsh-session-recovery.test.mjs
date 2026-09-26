// 必须使用真实新旧安装树；没有环境变量时显式 skip，不能计为升级通过。
// DSH_RECOVERY_LEGACY_APP=... DSH_RECOVERY_TARGET_APP=... node --test dsh-session-recovery.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { loadRecoveryRuntimes, recoverInterruptedOverlap, strictRestore } from './dsh-session-recovery.mjs'

const targetVersion = process.env.DSH_TARGET_VERSION ?? '0.1.5-rc.2'
const configured = process.env.DSH_RECOVERY_LEGACY_APP && process.env.DSH_RECOVERY_TARGET_APP
const runtimes = configured
  ? await loadRecoveryRuntimes(process.env.DSH_RECOVERY_LEGACY_APP, process.env.DSH_RECOVERY_TARGET_APP, targetVersion)
  : null
const integration = { skip: !configured && `需要真实 DSH 0.1.2-rc.1 / ${targetVersion} 安装树` }

test('目标版本可参数化且必须与安装树一致（0.1.7 fixture）', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-recovery-version-'))
  try {
    const writeApp = async (app, version) => {
      const dsh = path.join(app, 'node_modules/@deepseek-ai/dsh')
      await fs.mkdir(dsh, { recursive: true })
      await fs.writeFile(path.join(dsh, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version }))
    }
    const writeModule = async (app, name) => {
      const dir = path.join(app, 'node_modules', name)
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name, main: 'index.mjs' }))
      await fs.writeFile(path.join(dir, 'index.mjs'), 'export const sessionFormatCatalog = { fixture: true }\nexport default {}\n')
    }
    const legacy = path.join(root, 'legacy'), target = path.join(root, 'target')
    await writeApp(legacy, '0.1.2-rc.1')
    await writeApp(target, '0.1.7-rc.2')
    await writeModule(legacy, '@deepseek-ai/dsh-session')
    await writeModule(target, '@deepseek-ai/dsh-session-format-catalog')
    const loaded = await loadRecoveryRuntimes(legacy, target, '0.1.7-rc.2')
    assert.ok(loaded.legacy && loaded.catalog && loaded.targetImport)
    await assert.rejects(loadRecoveryRuntimes(legacy, target, '0.1.5-rc.2'), /要求 DSH 0.1.5-rc.2，实际 0.1.7-rc.2/)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

function fixture(twoCalls = false, packed = false) {
  const header = { type: 'session', version: 0, id: 'session-recovery-fixture', createdAt: 1, cwd: '/fixture', delegationDepth: 0 }
  const call = (id) => ({ type: 'tool-call', id, name: 'fixture_read', arguments: '{}' })
  const prefix = [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    { type: 'step/start', seq: 1, time: 2, data: { turn: 1, step: 1 } },
    { type: 'user/message', seq: 2, time: 3, surfaceOp: 'append', data: { id: 'u1', role: 'user', content: [{ type: 'text', text: 'fixture' }], source: { kind: 'user' } } },
    { type: 'assistant/message', seq: 3, time: 4, surfaceOp: 'append', data: { turn: 1, step: 1, message: {
      id: 'a1', role: 'assistant', source: { kind: 'model', provider: 'mock', model: 'mock' },
      content: twoCalls ? [call('c1'), call('c2')] : [call('c1')],
    } } },
    { type: 'tool/call', seq: 4, time: 5, data: { turn: 1, step: 1, callId: 'c1', name: 'fixture_read', arguments: '{}' } },
  ]
  if (packed) {
    const chunks = [{ type: 'text-chunks', seq0: 3, time0: 3, data: { turn: 1, step: 1, index: 0, dt: [0, 0], texts: ['fi', 'xt', 'ure'] } }]
    let next = 6
    for (const [index, id] of (twoCalls ? ['c1', 'c2'] : ['c1']).entries()) {
      chunks.push({ type: 'assistant/chunk', seq: next++, time: 3, data: { turn: 1, step: 1,
        chunk: { type: 'tool-call-delta', index: index + 1, id, name: 'fixture_read', argumentsDelta: '{}' } } })
    }
    chunks.push({ type: 'assistant/chunk', seq: next++, time: 3, data: { turn: 1, step: 1,
      chunk: { type: 'finish', reason: { kind: 'tool-calls' } } } })
    prefix[3].seq = next
    prefix[3].sourceEventSeqs = [[3, next - 1]]
    prefix[3].data.message.content.unshift({ type: 'text', text: 'fixture' })
    prefix[4].seq = next + 1
    prefix.splice(3, 0, ...chunks)
  }
  const expanded = prefix.flatMap((row) => runtimes.legacy.decodeStorageRecord(row))
  const closers = runtimes.legacy.interruptedTurnClosers(expanded).map((event) => structuredClone(event))
  const marker = { type: 'session/end-seed', seq: expanded.length + closers.length, time: 10, data: {} }
  let seq = expanded.length
  const result = (id) => ({ type: 'tool/result', seq: seq++, time: 20, surfaceOp: 'append', sourceEventSeqs: [id === 'c1' ? prefix.at(-1).seq : expanded.length + 1], data: {
    turn: 1, step: 1, message: { id: `actual-${id}`, role: 'user', source: { kind: 'tool', callId: id },
      content: [{ type: 'tool-result', toolCallId: id, isError: false, content: [{ type: 'text', text: `recorded-${id}` }] }] },
  } })
  const suffix = [result('c1')]
  if (twoCalls) {
    suffix.push({ type: 'tool/call', seq: seq++, time: 20, data: { turn: 1, step: 1, callId: 'c2', name: 'fixture_read', arguments: '{}' } })
    suffix.push(result('c2'))
  }
  suffix.push({ type: 'step/end', seq: seq++, time: 21, data: { turn: 1, step: 1 } })
  suffix.push({ type: 'turn/end', seq: seq++, time: 22, data: { turn: 1, reason: { kind: 'completed' } } })
  return { header, prefix, closers, marker, suffix, records: [header, ...prefix, ...closers, marker, ...suffix] }
}

test('真实官方迁移拒绝原冲突；恢复后保全实际执行与中断两条分支', integration, () => {
  for (const twoCalls of [false, true]) {
    const f = fixture(twoCalls)
    const before = JSON.stringify(f.records)
    assert.throws(() => strictRestore(runtimes.catalog, f.records), /seq gap/)
    // 正确 seam：同一官方目录完整校验关系、调用配对和引用，不能只检查整数连续。
    const expected = strictRestore(runtimes.catalog, [f.header, ...f.prefix, ...f.suffix])
    const recovered = recoverInterruptedOverlap(f.records, runtimes.legacy, runtimes.catalog)
    const continued = strictRestore(runtimes.catalog, recovered.continued)
    const interrupted = strictRestore(runtimes.catalog, recovered.interrupted)
    assert.deepEqual(continued, expected)
    assert.ok(continued.events.some((event) => JSON.stringify(event).includes('actual-c1')))
    assert.ok(interrupted.events.some((event) => JSON.stringify(event).includes('TOOL_OUTCOME_UNKNOWN')))
    assert.deepEqual(recovered.continued, [f.header, ...f.prefix, ...f.suffix])
    assert.deepEqual(recovered.interrupted, [f.header, ...f.prefix, ...f.closers, f.marker])
    assert.equal(JSON.stringify(f.records), before, '输入对象保持原样')
  }
})

test('拒绝把不同实际结果或被修改过的中断结果当作可删除补写', integration, () => {
  const f = fixture()
  f.records[f.prefix.length + 1].data.message.content[0].content[0].text = 'different recorded result'
  assert.throws(() => recoverInterruptedOverlap(f.records, runtimes.legacy, runtimes.catalog), /补写/)
})

test('拒绝错误调用引用及额外序号冲突', integration, () => {
  const f = fixture()
  f.suffix[0].data.message.source.callId = 'unrelated-call'
  assert.throws(() => recoverInterruptedOverlap(f.records, runtimes.legacy, runtimes.catalog), /调用|call|lifecycle/)
  const g = fixture()
  g.suffix.at(-1).seq--
  assert.throws(() => recoverInterruptedOverlap(g.records, runtimes.legacy, runtimes.catalog), /序号/)
})

test('拒绝父子继承会话及有外部引用的中断消息', integration, () => {
  const f = fixture()
  f.header.parentSession = 'parent'
  assert.throws(() => recoverInterruptedOverlap(f.records, runtimes.legacy, runtimes.catalog), /继承/)
  const g = fixture()
  g.suffix[0].data.message.content[0].content[0].text = g.closers[0].data.message.id
  assert.throws(() => recoverInterruptedOverlap(g.records, runtimes.legacy, runtimes.catalog), /引用/)
})

test('无冲突日志不走恢复，缺失 marker 或真实结果时拒绝', integration, () => {
  const f = fixture()
  assert.throws(() => recoverInterruptedOverlap([f.header, ...f.prefix, ...f.suffix], runtimes.legacy, runtimes.catalog), /序号/)
  const g = fixture()
  g.marker.type = 'session/title'
  assert.throws(() => recoverInterruptedOverlap(g.records, runtimes.legacy, runtimes.catalog), /marker/)
})

test('压缩分块、工具引用和原始序号保持不变', integration, () => {
  const f = fixture(true, true)
  const r = recoverInterruptedOverlap(f.records, runtimes.legacy, runtimes.catalog)
  assert.deepEqual(r.continued, [f.header, ...f.prefix, ...f.suffix])
  assert.ok(r.continued.some((row) => row.type === 'text-chunks'))
  assert.deepEqual(r.continuedArtifact, strictRestore(runtimes.catalog, [f.header, ...f.prefix, ...f.suffix]))
  assert.equal(r.audit.sequence_renumbered, false)
})

test('CLI 保存压缩原件和逐行分支，官方发布后独立读回，拒绝源目录内输出', integration, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-recovery-test-'))
  try {
    const source = path.join(root, 'source'), work = path.join(root, 'work')
    const f = fixture(true, true)
    const input = path.join(source, '--fixture--', f.header.id, 'session.jsonl.zstd')
    await fs.mkdir(path.dirname(input), { recursive: true })
    await fs.mkdir(work)
    const lines = f.records.map((row) => JSON.stringify(row) + '\n')
    const original = Buffer.concat([lines[0], lines.slice(1).join('')].map((input) => execFileSync('zstd', ['-q', '-c'], { input })))
    await fs.writeFile(input, original)
    const script = fileURLToPath(new URL('./dsh-session-recover.mjs', import.meta.url))
    const args = [script, '--source', source, '--app-dir', process.env.DSH_RECOVERY_TARGET_APP,
      '--legacy-app-dir', process.env.DSH_RECOVERY_LEGACY_APP, '--session-id', f.header.id, '--work-dir']
    const refused = spawnSync(process.execPath, [...args, source], { encoding: 'utf8' })
    assert.notEqual(refused.status, 0)
    assert.match(refused.stderr, /输出目录不能位于/)
    const executed = spawnSync(process.execPath, [...args, work], { encoding: 'utf8' })
    const report = JSON.parse(await fs.readFile(JSON.parse(executed.stdout).report, 'utf8'))
    assert.equal(executed.status, 0, JSON.stringify(report.sessions[0]?.error ?? report.error ?? executed.stderr))
    assert.equal(report.ok, true)
    assert.deepEqual(await fs.readFile(input), original)
    assert.deepEqual(await fs.readFile(report.sessions[0].archive), original)
    for (const name of ['continued', 'interrupted']) {
      const branch = report.sessions[0].branches[name]
      assert.equal(branch.fresh_backend_read, true)
      assert.ok((await fs.stat(branch.published)).size > 0)
      const stored = execFileSync('zstd', ['-dc', '--', branch.file], { encoding: 'utf8' })
      const expected = name === 'continued' ? [f.header, ...f.prefix, ...f.suffix] : [f.header, ...f.prefix, ...f.closers, f.marker]
      assert.equal(stored, expected.map((row) => JSON.stringify(row) + '\n').join(''))
    }
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})
