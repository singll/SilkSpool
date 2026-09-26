// Session V0 中断补写冲突的受限恢复；只生成分支副本，不改生产原件。
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

export async function loadRecoveryRuntimes(legacyApp, targetApp, targetVersion = process.env.DSH_TARGET_VERSION ?? '0.1.5-rc.2') {
  async function runtime(app, version) {
    const packagePath = await fs.realpath(path.join(app, 'node_modules/@deepseek-ai/dsh/package.json'))
    const pkg = JSON.parse(await fs.readFile(packagePath, 'utf8'))
    if (pkg.version !== version) throw new Error(`要求 DSH ${version}，实际 ${pkg.version}`)
    const require = createRequire(packagePath)
    return (name) => import(pathToFileURL(require.resolve(name)))
  }
  const legacyImport = await runtime(legacyApp, '0.1.2-rc.1')
  const targetImport = await runtime(targetApp, targetVersion)
  const legacy = await legacyImport('@deepseek-ai/dsh-session')
  const { sessionFormatCatalog: catalog } = await targetImport('@deepseek-ai/dsh-session-format-catalog')
  return { legacy, catalog, targetImport }
}

// Session V0 冲突恢复只在 V3 目标（0.1.5）可用：上游 v3→v4 边要求显式子代证据，
// 独立恢复副本无法证明完整子代集合，静默用空集合会丢父会话 catalog facts。
// 0.1.7 目标下必须先用 0.1.5 工具链修复并发布 Session V3，再由目标链执行 V3→V4 迁移。
export function assertV0RecoveryTarget(catalog) {
  if (catalog?.currentVersion !== 3) {
    throw new Error(`Session V0 冲突恢复仅支持 V3 目标（0.1.5）；当前目标 catalog 为 v${catalog?.currentVersion}。`
      + '请先在 0.1.5 工具链执行恢复并发布 Session V3，再由升级链把 V3 迁移到 V4；本工具拒绝在 V4 目标下静默重建。')
  }
}

export function strictRestore(catalog, records) {
  assertV0RecoveryTarget(catalog)
  const restore = catalog.createRestore(structuredClone(records[0]), { recovery: 'strict', validation: 'current' })
  for (const row of records.slice(1)) restore.decodeRow(structuredClone(row))
  return restore.finish()
}

export function recoverInterruptedOverlap(records, legacy, catalog) {
  assertV0RecoveryTarget(catalog)
  const header = records[0]
  if (header?.type !== 'session' || header.version !== 0) throw new Error('恢复仅接受 Session V0')
  if (Object.hasOwn(header, 'parentSession') || Object.hasOwn(header, 'seedLength')) {
    throw new Error('继承会话需要单独证明父子切点，本工具拒绝自动处理')
  }
  const rows = records.slice(1).map((row, index) => {
    // 使用真实旧版 codec 展开 packed run；物理行号不能当作逻辑 seq。
    const events = legacy.decodeStorageRecord(structuredClone(row))
    if (!events.length || !Number.isSafeInteger(events[0].seq) || events[0].seq < 0
      || events.some((event, offset) => event.seq !== events[0].seq + offset)) {
      throw new Error('旧版解码后序号非法')
    }
    return { index: index + 1, events, firstSeq: events[0].seq, count: events.length }
  })
  let expected = 0
  const gaps = []
  for (const row of rows) {
    if (row.firstSeq !== expected) gaps.push({ row, expected })
    expected = row.firstSeq + row.count
  }
  if (gaps.length !== 1 || gaps[0].row.firstSeq >= gaps[0].expected) {
    throw new Error('只接受一处已知中断补写造成的序号回退；不修复其他序号问题')
  }
  const resume = gaps[0].row
  const start = rows.find((row) => row.index < resume.index && row.firstSeq === resume.firstSeq)
  if (!start || start.count !== 1) throw new Error('序号回退不能落在压缩分块内部')
  const marker = records[resume.index - 1]
  if (marker.type !== 'session/end-seed' || !isDeepStrictEqual(marker.data, {})
    || !isDeepStrictEqual(Object.keys(marker).sort(), ['data', 'seq', 'time', 'type'])
    || marker.seq !== gaps[0].expected - 1) throw new Error('缺少精确的 session/end-seed marker')
  const prefix = rows.filter((row) => row.index < start.index).flatMap((row) => row.events)
  const closers = legacy.interruptedTurnClosers(prefix)
  const actualClosers = rows.filter((row) => row.index >= start.index && row.index < resume.index - 1)
    .flatMap((row) => row.events)
  if (!closers.length || !isDeepStrictEqual(actualClosers, closers)) {
    throw new Error('冲突段不等于旧版 interruptedTurnClosers 的精确补写，拒绝选择分支')
  }
  const first = resume.events[0], repair = closers[0]
  if (repair.type !== 'tool/result' || repair.data.error?.code !== 'TOOL_OUTCOME_UNKNOWN'
    || first.type !== 'tool/result'
    || first.data?.message?.source?.callId !== repair.data.message.source.callId
    || first.data.turn !== repair.data.turn || first.data.step !== repair.data.step
    || !isDeepStrictEqual(first.sourceEventSeqs, repair.sourceEventSeqs)
    || first.data.message.id === repair.data.message.id) throw new Error('续写没有对应同一次已开始的工具调用')
  if (!Number.isSafeInteger(marker.time) || marker.time < prefix.at(-1).time || first.time < marker.time) {
    throw new Error('补写与实际续写的时间顺序不符')
  }
  const continued = [...records.slice(0, start.index), ...records.slice(resume.index)]
  const interrupted = records.slice(0, resume.index)
  const repairIds = closers.filter((event) => event.type === 'tool/result').map((event) => event.data.message.id)
  for (const row of continued) {
    const serialized = JSON.stringify(row)
    if (repairIds.some((id) => serialized.includes(id))) throw new Error('续写仍引用中断消息，须人工对账引用')
  }
  // 官方目录的 strict 模式同时验证全量事件、工具生命周期、轮次和引用；不允许尾部恢复截断。
  const continuedArtifact = strictRestore(catalog, continued)
  const interruptedArtifact = strictRestore(catalog, interrupted)
  return { continued, interrupted, continuedArtifact, interruptedArtifact,
    startRecord: start.index, resumeRecord: resume.index,
    audit: { kind: 'interrupted-closers-overlap', id: header.id,
      gap_row: resume.index - 1, expected_seq: gaps[0].expected, reused_seq: resume.firstSeq,
      synthetic_row_range: [start.index - 1, resume.index - 1], // 左闭右开，不含物理 header。
      source_rows: records.length - 1, continued_rows: continued.length - 1, interrupted_rows: interrupted.length - 1,
      repair_messages: repairIds, sequence_renumbered: false,
      primary: 'recorded-continuation', alternate: 'interrupted-view', strict_branches_validated: true,
    } }
}
