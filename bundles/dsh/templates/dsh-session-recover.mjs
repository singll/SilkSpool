#!/usr/bin/env node
// 受限修复预演：保全原件及两条分支，官方迁移只写自动创建的私有输出目录。
import * as fs from 'node:fs/promises'
import { constants, createReadStream } from 'node:fs'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { loadRecoveryRuntimes, recoverInterruptedOverlap } from './dsh-session-recovery.mjs'

process.umask(0o077)
const args = { ids: [] }
for (let i = 2; i < process.argv.length; i++) {
  const flag = process.argv[i], value = process.argv[++i]
  if (!value) throw new Error(`缺少参数值: ${flag}`)
  if (flag === '--session-id') args.ids.push(value)
  else if (flag === '--source') args.source = value
  else if (flag === '--work-dir') args.work = value
  else if (flag === '--app-dir') args.target = value
  else if (flag === '--legacy-app-dir') args.legacy = value
  else throw new Error(`未知参数: ${flag}`)
}
if (!args.source || !args.work || !args.target || !args.legacy || !args.ids.length
  || new Set(args.ids).size !== args.ids.length || args.ids.some((id) => !/^session-[a-zA-Z0-9-]+$/.test(id))) {
  throw new Error('必须指定 --source、--work-dir、--app-dir、--legacy-app-dir 及唯一的 --session-id')
}
const [source, work] = await Promise.all([fs.realpath(args.source), fs.realpath(args.work)])
if (work === source || work.startsWith(source + path.sep)) throw new Error('输出目录不能位于 Session 来源内')
const targetVersion = JSON.parse(await fs.readFile(path.join(await fs.realpath(args.target), 'node_modules/@deepseek-ai/dsh/package.json'), 'utf8')).version
// 发布代次只由目标 catalog 决定：0.1.5→V3；0.1.7 的 V4 恢复入口已 fail-closed。
const targetFormatVersion = targetVersion === '0.1.5-rc.2' ? 3 : 4
const { legacy, catalog, targetImport } = await loadRecoveryRuntimes(args.legacy, args.target, targetVersion)
if (catalog.currentVersion !== targetFormatVersion) {
  throw new Error(`目标 catalog 代次 v${catalog.currentVersion} 与 DSH ${targetVersion} 预期 v${targetFormatVersion} 不符，拒绝继续`)
}
const { Context } = await targetImport('@deepseek-ai/cordis')
const { default: Backend } = await targetImport('@deepseek-ai/dsh-session-persistence-jsonl')
const runDir = await fs.mkdtemp(path.join(work, 'session-recovery-'))
const digest = (value) => createHash('sha256').update(value).digest('hex')
const eventDigest = (value) => digest(JSON.stringify(value))
const report = { started_at: new Date().toISOString(), legacy_version: '0.1.2-rc.1', target_version: targetVersion,
  source, run_dir: runDir, scope: 'Session 分支副本恢复；不是生产修复或完整 U2 验收', sessions: [], ok: false }

async function hashFile(filename) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filename)) hash.update(chunk)
  return hash.digest('hex')
}

async function selectFiles(directory = source, selected = new Map()) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name)
    if (entry.isSymbolicLink()) throw new Error('Session 来源中有软链，拒绝自动恢复')
    if (entry.isDirectory()) {
      if (args.ids.includes(entry.name)) {
        const names = (await fs.readdir(filename)).filter((name) => /^session(?:\.v\d+)?\.jsonl(?:\.zstd)?$/.test(name))
        if (names.length !== 1 || !/^session\.jsonl(?:\.zstd)?$/.test(names[0])) throw new Error('指定会话存在多代或非 Session V0 日志')
        if (selected.has(entry.name)) throw new Error('指定会话存在多个源路径')
        const input = path.join(filename, names[0])
        if (!(await fs.lstat(input)).isFile()) throw new Error('Session 日志必须是普通文件')
        selected.set(entry.name, input)
      } else await selectFiles(filename, selected)
    }
  }
  return selected
}

async function publishAndRead(root, id, compression, expected) {
  const ctx = new Context()
  try {
    await ctx.plugin(Backend, { root, compression })
    const writer = await ctx.sessionPersistence.open(id, 'write')
    try {
      if (eventDigest((await writer.read()).events) !== eventDigest(expected.events)
        || eventDigest(writer.header) !== eventDigest(expected.header)) throw new Error('官方写句柄与 strict 目录结果不一致')
      await writer.flush()
    } finally { await writer.close() }
  } finally { await ctx.fiber.dispose() }
  const fresh = new Context()
  try {
    await fresh.plugin(Backend, { root, compression })
    const reader = await fresh.sessionPersistence.open(id, 'read')
    try {
      const events = (await reader.read()).events
      if (reader.header.version !== targetFormatVersion || eventDigest(events) !== eventDigest(expected.events)
        || eventDigest(reader.header) !== eventDigest(expected.header)) throw new Error('独立 backend 读回不一致')
      return { events: events.length, event_sha256: eventDigest(events), fresh_backend_read: true }
    } finally { await reader.close() }
  } finally { await fresh.fiber.dispose() }
}

try {
  const selected = await selectFiles()
  if (selected.size !== args.ids.length) throw new Error('指定会话未全部找到')
  for (const id of args.ids) {
    const input = selected.get(id), relative = path.relative(source, input)
    const result = { id, source_file: input, relative, ok: false }
    report.sessions.push(result)
    try {
      const sourceHash = await hashFile(input)
      const archive = path.join(runDir, 'originals', relative)
      await fs.mkdir(path.dirname(archive), { recursive: true })
      await fs.copyFile(input, archive, constants.COPYFILE_FICLONE)
      if (await hashFile(archive) !== sourceHash || await hashFile(input) !== sourceHash) throw new Error('源文件在复制期间发生变化')
      result.source_sha256 = sourceHash
      result.archive = archive
      const compressed = input.endsWith('.zstd')
      const bytes = compressed
        ? execFileSync('zstd', ['-dc', '--', archive], { maxBuffer: 256 * 1024 * 1024 })
        : await fs.readFile(archive)
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      if (!text.endsWith('\n') || text.split('\n').slice(0, -1).some((line) => !line.trim())) throw new Error('输入有不完整行或空行')
      const lines = text.match(/[^\n]*\n/g), records = lines.map((line) => JSON.parse(line))
      if (records[0].id !== id) throw new Error('日志 header 与指定 ID 不一致')
      const recovered = recoverInterruptedOverlap(records, legacy, catalog)
      Object.assign(result, recovered.audit)
      // 保留每条原始 JSON 行的字节、属性顺序及 packed run；不重编号、不重写事件。
      const branches = {
        continued: { lines: [...lines.slice(0, recovered.startRecord), ...lines.slice(recovered.resumeRecord)], artifact: recovered.continuedArtifact },
        interrupted: { lines: lines.slice(0, recovered.resumeRecord), artifact: recovered.interruptedArtifact },
      }
      result.branches = {}
      for (const [name, branch] of Object.entries(branches)) {
        const root = path.join(runDir, name), filename = path.join(root, relative)
        const branchBytes = Buffer.from(branch.lines.join(''), 'utf8')
        await fs.mkdir(path.dirname(filename), { recursive: true })
        // 上游 Zstandard 容器要求第一帧恰好是一行 header；之后的帧才放事件。
        const compress = (input) => execFileSync('zstd', ['-q', '-c'], { input, maxBuffer: 256 * 1024 * 1024 })
        const stored = compressed ? Buffer.concat([compress(branch.lines[0]), compress(branch.lines.slice(1).join(''))]) : branchBytes
        await fs.writeFile(filename, stored, { flag: 'wx' })
        result.branches[name] = { file: filename, raw_sha256: digest(branchBytes), stored_sha256: digest(stored),
          ...await publishAndRead(root, id, compressed ? 'zstd' : 'none', branch.artifact) }
        if (await hashFile(filename) !== digest(stored)) throw new Error('官方发布改变了分支内的旧代日志')
        const published = path.join(path.dirname(filename), compressed ? `session.v${targetFormatVersion}.jsonl.zstd` : `session.v${targetFormatVersion}.jsonl`)
        result.branches[name].published = published
        result.branches[name].published_sha256 = await hashFile(published)
      }
      // 两分支的行集合覆盖整个原件；中断分支保留所有从主执行分支分离的行。
      if (branches.interrupted.lines.slice(recovered.startRecord).join('') !== lines.slice(recovered.startRecord, recovered.resumeRecord).join('')) {
        throw new Error('冲突行保全校验失败')
      }
      if (await hashFile(input) !== sourceHash || await hashFile(archive) !== sourceHash) throw new Error('原件哈希变化')
      result.original_unchanged = true
      result.raw_rows_preserved = true
      result.ok = true
    } catch (error) {
      result.error = { name: error.name, message: error.message }
    }
    await fs.writeFile(path.join(runDir, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  }
  for (const result of report.sessions.filter((row) => row.ok)) {
    if (await hashFile(result.source_file) !== result.source_sha256 || await hashFile(result.archive) !== result.source_sha256) {
      result.ok = false
      result.original_unchanged = false
      result.error = { name: 'SourceChangedError', message: '原件在整轮恢复期间变化，须重新取样' }
    }
  }
  report.ok = report.sessions.length === args.ids.length && report.sessions.every((row) => row.ok)
} catch (error) {
  report.error = { name: error.name, message: error.message }
} finally {
  report.finished_at = new Date().toISOString()
  await fs.writeFile(path.join(runDir, 'report.json'), JSON.stringify(report, null, 2) + '\n')
}
console.log(JSON.stringify({ ok: report.ok, sessions: report.sessions.length, passed: report.sessions.filter((row) => row.ok).length,
  report: path.join(runDir, 'report.json'), report_sha256: await hashFile(path.join(runDir, 'report.json')) }))
if (!report.ok) process.exitCode = 1
