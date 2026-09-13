#!/usr/bin/env node
// 在自动创建的私有副本上调用上游 Session 迁移器。绝不启动 DSH app/业务插件。
// node dsh-session-rehearsal.mjs --app-dir CANDIDATE/app --work-dir STAGE --source DATA/sessions [--source BASE/sessions]
import * as fs from 'node:fs/promises'
import { createReadStream, constants } from 'node:fs'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import assert from 'node:assert/strict'
import { listSessionHeaders } from './dsh-plugin-sec-suite.host-compat.js'

process.umask(0o077)
const args = { sources: [] }
for (let i = 2; i < process.argv.length; i++) {
  const flag = process.argv[i], value = process.argv[++i]
  if (!value) throw new Error(`缺少参数值: ${flag}`)
  if (flag === '--source') args.sources.push(value)
  else if (flag === '--app-dir') args.app = value
  else if (flag === '--work-dir') args.work = value
  else throw new Error(`未知参数: ${flag}`)
}
if (!args.app || !args.work || !args.sources.length) throw new Error('必须指定 --app-dir、--work-dir 与至少一个 --source')

async function hashFile(filename) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filename)) hash.update(chunk)
  return hash.digest('hex')
}
const hashValue = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

async function logFiles(root, directory = root) {
  const files = []
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name)
    if (entry.isSymbolicLink()) throw new Error(`Session 副本不接受软链: ${path.relative(root, filename)}`)
    if (entry.isDirectory()) files.push(...await logFiles(root, filename))
    else if (entry.isFile() && /\.jsonl(?:\.zstd)?$/.test(entry.name)) {
      if (!/^session(?:\.v[1-9][0-9]*)?\.jsonl(?:\.zstd)?$/.test(entry.name)) {
        throw new Error(`非规范 Session 日志名: ${entry.name}`)
      }
      files.push(filename)
    }
  }
  return files.sort()
}

async function physicalHeader(filename) {
  let child, exited
  const stream = filename.endsWith('.zstd') ? (() => {
    child = spawn('zstd', ['-dc', '--', filename], { stdio: ['ignore', 'pipe', 'ignore'] })
    exited = new Promise((resolve) => { child.once('error', resolve); child.once('close', resolve) })
    return child.stdout
  })() : createReadStream(filename)
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of lines) return JSON.parse(line)
    throw new Error('Session 缺少物理 header')
  } finally {
    lines.close()
    stream.destroy()
    if (child) { child.kill(); await exited }
  }
}

const app = await fs.realpath(args.app)
const dshPackage = await fs.realpath(path.join(app, 'node_modules/@deepseek-ai/dsh/package.json'))
const dsh = JSON.parse(await fs.readFile(dshPackage, 'utf8'))
assert.equal(dsh.version, '0.1.5-rc.2', '本演练锁定 DSH 0.1.5-rc.2')
const requireDsh = createRequire(dshPackage)
const { Context } = await import(pathToFileURL(requireDsh.resolve('@deepseek-ai/cordis')))
const { default: JsonlPersistence } = await import(pathToFileURL(requireDsh.resolve('@deepseek-ai/dsh-session-persistence-jsonl')))
const { sessionFormatCatalog } = await import(pathToFileURL(requireDsh.resolve('@deepseek-ai/dsh-session-format-catalog')))
const sources = await Promise.all(args.sources.map((source) => fs.realpath(source)))
assert.equal(new Set(sources).size, sources.length, 'Session 来源重复')
// 要求显式创建工作目录，先校验位置再产生任何副本，避免错误参数写入生产来源。
const work = await fs.realpath(args.work)
for (const source of sources) {
  assert.ok(work !== source && !work.startsWith(source + path.sep), '输出目录不能位于生产 Session 来源内')
}
const runDir = await fs.mkdtemp(path.join(work, 'session-rehearsal-'))
const report = { started_at: new Date().toISOString(), dsh_version: dsh.version, run_dir: runDir,
  scope: 'Session 副本格式演练；不是业务全量一致性快照或完整 U2 验收',
  sources: [], sessions: [], physical_versions: {}, original_files_unchanged: false, failures: 0 }
const originals = []

async function checkWriteOwnership() {
  const root = path.join(runDir, 'lock-fixture')
  const id = 'session-upgrade-lock-fixture'
  const ctx = new Context()
  let child, exited
  try {
    await ctx.plugin(JsonlPersistence, { root, compression: 'zstd' })
    const created = await ctx.sessionPersistence.create({ version: 3, id, createdAt: Date.now(), isSeeded: false, delegationDepth: 0 })
    try { await created.flush() } finally { await created.close() }
    const code = `
      const { createRequire } = await import('node:module');
      const { pathToFileURL } = await import('node:url');
      const req = createRequire(process.argv[1]);
      const { Context } = await import(pathToFileURL(req.resolve('@deepseek-ai/cordis')));
      const { default: Backend } = await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-session-persistence-jsonl')));
      const ctx = new Context();
      await ctx.plugin(Backend, {root: process.argv[2], compression: 'zstd'});
      const handle = await ctx.sessionPersistence.open(process.argv[3], 'write');
      process.send({ready: true});
      setInterval(() => {}, 1000);
    `
    child = spawn(process.execPath, ['--input-type=module', '-e', code, dshPackage, root, id], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    })
    exited = new Promise((resolve) => { child.once('exit', resolve); child.once('error', resolve) })
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Session 写锁 fixture 启动超时')), 15000)
      child.once('message', (message) => { clearTimeout(timer); message.ready ? resolve() : reject(new Error('锁 fixture 未就绪')) })
      child.once('error', (error) => { clearTimeout(timer); reject(error) })
      child.once('exit', () => { clearTimeout(timer); reject(new Error('锁 fixture 提前退出')) })
    })
    await assert.rejects(ctx.sessionPersistence.open(id, 'write'), { name: 'SessionAlreadyOwnedError' })
    const reader = await ctx.sessionPersistence.open(id, 'read')
    try {
      assert.deepEqual((await reader.read()).events, [])
      await assert.rejects(reader.flush(), { name: 'SessionReadOnlyError' })
    } finally { await reader.close() }
    child.kill('SIGKILL') // 只终止本脚本启动的空 fixture 子进程，验证内核释放写锁。
    await exited
    const writer = await ctx.sessionPersistence.open(id, 'write')
    try { await writer.flush() } finally { await writer.close() }
    return { double_writer_refused: true, reader_while_writer: true, reader_cannot_write: true, released_after_crash: true }
  } finally {
    if (child) { child.kill('SIGKILL'); await exited }
    await ctx.fiber.dispose()
  }
}

try {
  for (const [index, source] of sources.entries()) {
    const destination = path.join(runDir, `source-${index}`)
    await fs.mkdir(destination)
    const files = await logFiles(source)
    assert.ok(files.length, 'Session 来源为空')
    const expected = new Map()
    for (const filename of files) {
      const relative = path.relative(source, filename), copied = path.join(destination, relative)
      const before = await hashFile(filename)
      await fs.mkdir(path.dirname(copied), { recursive: true })
      await fs.copyFile(filename, copied, constants.COPYFILE_FICLONE)
      assert.equal(await hashFile(copied), before, '复制时源日志发生变化，请重新选窗口')
      assert.equal(await hashFile(filename), before, '复制后源日志发生变化，请重新选窗口')
      originals.push({ filename, copied, sha256: before })
      const header = await physicalHeader(copied)
      sessionFormatCatalog.readHeader(header) // 版本来自官方物理 header 校验，不从后缀推断。
      const compression = filename.endsWith('.zstd') ? 'zstd' : 'none'
      const key = `${compression}:${header.id}`
      const prior = expected.get(key)
      if (!prior || prior.version < header.version) expected.set(key, { ...header, compression })
      report.physical_versions[`Session V${header.version}`] = (report.physical_versions[`Session V${header.version}`] || 0) + 1
    }
    report.sources.push({ source, destination, files: files.length, sessions: expected.size })
    for (const compression of ['zstd', 'none']) {
      const selected = [...expected.values()].filter((h) => h.compression === compression)
      if (!selected.length) continue
      const ctx = new Context()
      try {
        await ctx.plugin(JsonlPersistence, { root: destination, compression })
        const sp = ctx.sessionPersistence
        const listed = await listSessionHeaders(sp)
        assert.deepEqual(listed.diagnostics, [], '真实上游列表可被宿主适配器完整解析')
        assert.deepEqual(listed.headers.map((h) => h.id).sort(), selected.map((h) => h.id).sort(), '列表覆盖全部源 Session')
        for (const original of selected) {
          const result = { source: index, compression, id: original.id, source_version: original.version, ok: false }
          const started = performance.now()
          try {
            let header, events
            const reader = await sp.open(original.id, 'read')
            try {
              header = reader.header
              events = (await reader.read()).events
              assert.equal(header.version, 3)
              for (const key of ['id', 'createdAt', 'cwd', 'parentSession', 'agentPreset']) {
                if (Object.hasOwn(original, key)) assert.deepEqual(header[key], original[key], `保留 ${key}`)
              }
            } finally { await reader.close() }
            const digest = hashValue(events)
            const writer = await sp.open(original.id, 'write') // 仅在新建副本中发布 Session V3。
            try { await writer.flush() } finally { await writer.close() }
            const reopened = await sp.open(original.id, 'read')
            try {
              assert.deepEqual(reopened.header, header)
              assert.equal(hashValue((await reopened.read()).events), digest, '发布后的事件内容与官方还原结果一致')
            } finally { await reopened.close() }
            Object.assign(result, { ok: true, target_version: 3, events: events.length, event_sha256: digest,
              system_messages: events.filter((event) => event.type === 'system/message').length })
          } catch (error) {
            // 完整诊断仅保存在权限 0700 的演练目录；标准输出不包含会话正文。
            result.error = { name: error.name, code: error.code ?? null, message: error.message }
            report.failures++
          }
          result.duration_ms = Math.round(performance.now() - started)
          report.sessions.push(result)
          if (report.sessions.length % 25 === 0) console.log(JSON.stringify({ checked: report.sessions.length, failed: report.failures }))
          await fs.writeFile(path.join(runDir, 'report.json'), JSON.stringify(report, null, 2) + '\n')
        }
      } finally { await ctx.fiber.dispose() }
      // 新建 backend，排除同一实例的冷读 memo 命中，确认磁盘上的 Session V3 可读。
      const fresh = new Context()
      try {
        await fresh.plugin(JsonlPersistence, { root: destination, compression })
        for (const result of report.sessions.filter((s) => s.source === index && s.compression === compression && s.ok)) {
          try {
            const handle = await fresh.sessionPersistence.open(result.id, 'read')
            try {
              assert.equal(handle.header.version, 3)
              assert.equal(hashValue((await handle.read()).events), result.event_sha256)
              result.fresh_backend_read = true
            } finally { await handle.close() }
          } catch (error) {
            result.ok = false
            result.error = { name: error.name, code: error.code ?? null, message: error.message }
            report.failures++
          }
        }
      } finally { await fresh.fiber.dispose() }
    }
  }
  report.lock_checks = await checkWriteOwnership()
  for (const original of originals) {
    assert.equal(await hashFile(original.filename), original.sha256, '生产源日志在演练期间发生变化；需重新取样')
    assert.equal(await hashFile(original.copied), original.sha256, '副本旧代日志必须原样保留')
  }
  report.original_files_unchanged = true
  report.ok = report.failures === 0
} catch (error) {
  report.ok = false
  report.error = { name: error.name, code: error.code ?? null, message: error.message }
} finally {
  report.finished_at = new Date().toISOString()
  await fs.writeFile(path.join(runDir, 'source-sha256.json'), JSON.stringify(originals, null, 2) + '\n')
  await fs.writeFile(path.join(runDir, 'report.json'), JSON.stringify(report, null, 2) + '\n')
}
console.log(JSON.stringify({ ok: report.ok, sessions: report.sessions.length, failed: report.failures,
  physical_versions: report.physical_versions, original_files_unchanged: report.original_files_unchanged,
  lock_checks: report.lock_checks ?? null,
  report: path.join(runDir, 'report.json'), error: report.error?.name ?? null }))
if (!report.ok) process.exitCode = 1
