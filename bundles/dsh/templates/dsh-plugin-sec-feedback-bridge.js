// ==============================================================================
// @silksec/sec-feedback-bridge — DSH 原生反馈桥（自学习专项 L5，设计 §9）
//
// 契约：doc/secagent/v5/07-know.md（know_feedback_ingest 唯一落账通道）
//       + upgrades/2026-09-12-self-learning-design.md §9（原生反馈桥纪律）
//
// 职责（web profile 挂载；headless 无 UI 反馈面，不挂载）：
//  - 实时：cordis 'session/event' 中 type=feedback/message-put|message-delete；
//  - 冷启动补扫：cordis 'feedback/committed'（message-feedback 冷变更 flush 后通知，
//    payload={meta, inheritedEventCount, events: 借用只读 canonical 前缀}）。
//
// 纪律（§9）：
//  - 冷通知 payload 是借用只读快照——回调先复制必要字段到本地队列，不在回调中等待同 Session
//    的另一项反馈/写操作，避免持锁互等；
//  - 已提交反馈不能由本桥撤销；落账失败只记录可恢复重试（队列退避），不伪称原反馈提交失败；
//  - 无法明确归因由 know 域进待整理队列——不给整场会话所有卡片加分；
//  - 反馈留在本地（不落盘任何反馈正文；OTel 内容导出按升级方案保持禁用）；
//  - DSH 侧 message-feedback 未挂载时本桥显式 unsupported（日志 + 状态文件），不伪造反馈流量。
//
// 幂等口径：feedback_id = `${sessionId}:${messageId}`，revision = 会话内 per-message 序号
// （编辑天然产生更高 revision，撤回产生 tombstone 行）；重复订阅/重启补扫经
// (feedback_id, revision) 主键幂等吸收。
// ==============================================================================

import * as fs from 'node:fs'
import * as path from 'node:path'

export const name = 'sec-feedback-bridge'
export const version = '1.0.0'

const log = (msg) => { try { process.stderr.write(`[sec-feedback-bridge] ${msg}\n`) } catch { /* noop */ } }
const FB_TYPES = new Set(['feedback/message-put', 'feedback/message-delete'])

// canonical 前缀（events[]）→ 本桥反馈条目（纯函数，便于单测）
// 只处理目标版本实际定义的事件形状（feedback/message-put / message-delete）；其余事件不解析。
export function reduceFeedbackEntries(events) {
  const out = []
  const rev = new Map() // messageId → 序号（编辑=更高序号）
  for (const ev of events || []) {
    if (!ev || !FB_TYPES.has(ev.type)) continue
    const d = ev.data || {}
    if (ev.type === 'feedback/message-put') {
      const item = d.item || {}
      if (!item.messageId) continue
      const n = (rev.get(item.messageId) || 0) + 1
      rev.set(item.messageId, n)
      out.push({
        messageId: String(item.messageId), revision: n, tombstone: false,
        rating: item.rating === 'positive' || item.rating === 'negative' ? item.rating : null,
        category: item.category ? String(item.category).slice(0, 64) : null,
        note: item.note ? String(item.note).slice(0, 2000) : null,
        updatedAt: item.updatedAt || null,
      })
    } else {
      if (!d.messageId) continue
      const n = (rev.get(d.messageId) || 0) + 1
      rev.set(d.messageId, n)
      out.push({ messageId: String(d.messageId), revision: n, tombstone: true, rating: null, category: null, note: null, updatedAt: null })
    }
  }
  return out
}

export function apply(ctx) {
  const dataDir = process.env.SEC_DATA_DIR || process.env.DSH_HOME || '/opt/silkspool/dsh/data'
  const statusFile = path.join(dataDir, 'sec-feedback-bridge.status.json')
  const writeStatus = (s) => {
    try { fs.writeFileSync(statusFile, JSON.stringify({ ...s, ts: Date.now() }) + '\n') } catch { /* noop */ }
  }

  // DSH 侧就绪检查：服务必须经 inject 声明后访问（loader 阶段裸取 ctx.* 会整树失败）。
  // messageFeedback 未挂载 → inject 抛错 → 显式 unsupported（不伪造反馈流量）；
  // 挂载后服务本身即为就绪证据（rc.2 message-feedback 无任何配置也提供完整 list/put/delete）。
  let messageFeedback = null
  let bus = null
  try {
    ctx.inject(['messageFeedback', 'secDomainBus'], (child) => {
      messageFeedback = child.messageFeedback
      bus = child.secDomainBus
      return () => {}
    })
  } catch (e) {
    const msg = String(e?.message || e)
    if (/messageFeedback/i.test(msg)) {
      log('messageFeedback 服务未挂载（当前 profile 无 dsh-message-feedback）——桥接显式 unsupported，不产生反馈流量')
      writeStatus({ status: 'unsupported', reason: `messageFeedback service not mounted: ${msg}` })
    } else {
      log(`服务注入失败：${msg}——桥接显式 unsupported`)
      writeStatus({ status: 'unsupported', reason: `inject failed: ${msg}` })
    }
    return null
  }

  // 本地处理队列（§9：回调只复制必要字段，不在回调中等待写操作；失败=可恢复重试）
  const queue = []
  let draining = false
  const stats = { seen: 0, ingested: 0, pending: 0, last_error: null }

  const enqueue = (sessionId, entry) => {
    queue.push({ sessionId, entry, attempts: 0, next_at: 0 })
    stats.seen++
    stats.pending = queue.length
    void drain()
  }

  async function drain() {
    if (draining) return
    draining = true
    try {
      while (queue.length) {
        const item = queue[0]
        if (item.next_at > Date.now()) break
        if (!bus) { item.next_at = Date.now() + 5000; queue.push(queue.shift()); break }
        try {
          const r = await bus.dispatch('know', 'feedback_ingest', {
            feedback_id: `${item.sessionId}:${item.entry.messageId}`,
            revision: item.entry.revision,
            session_id: item.sessionId,
            message_id: item.entry.messageId,
            rating: item.entry.rating || '',
            category: item.entry.category || '',
            note: item.entry.note || '',
            tombstone: item.entry.tombstone,
          }, { actor: 'system', session_id: item.sessionId })
          if (r && r.ok) {
            queue.shift()
            if (r.data && r.data.recorded) stats.ingested++
          } else {
            // 落账失败=可恢复重试（退避 5s→60s 封顶）；不伪称原反馈提交失败
            item.attempts++
            item.next_at = Date.now() + Math.min(5000 * 2 ** item.attempts, 60000)
            stats.last_error = r?.error?.message || 'dispatch failed'
            queue.push(queue.shift())
          }
        } catch (e) {
          item.attempts++
          item.next_at = Date.now() + Math.min(5000 * 2 ** item.attempts, 60000)
          stats.last_error = String(e?.message || e)
          queue.push(queue.shift())
        }
        stats.pending = queue.length
      }
      if (queue.length) setTimeout(() => void drain(), 5000).unref?.()
    } finally {
      draining = false
      writeStatus({ status: 'ok', ...stats })
    }
  }

  // 实时通道：session/event（feedback/message-put|delete）
  // 本地 per-session per-message 序号作为 revision（编辑=更高 revision 的单调口径）。
  const liveSeq = new Map() // sessionId → {messageId → n}
  ctx.on('session/event', (session, event) => {
    try {
      if (!event || !FB_TYPES.has(event.type)) return
      const sessionId = String(session?.header?.id || event?.data?.sessionId || '')
      if (!sessionId) return
      if (!liveSeq.has(sessionId)) liveSeq.set(sessionId, new Map())
      const m = liveSeq.get(sessionId)
      const entries = reduceFeedbackEntries([event])
      for (const e of entries) {
        const n = (m.get(e.messageId) || 0) + 1
        m.set(e.messageId, n)
        enqueue(sessionId, { ...e, revision: n })
      }
    } catch (e) { log(`session/event 处理异常：${e?.message}`) }
  })

  // 冷通道：feedback/committed——payload 为借用只读 canonical 快照，先复制再处理
  ctx.on('feedback/committed', (payload) => {
    try {
      if (!payload || !Array.isArray(payload.events)) return
      const sessionId = String(payload.meta?.id || '')
      if (!sessionId) return
      // 复制必要字段后立即返回主链——还原完整前缀（含编辑/撤回全史）
      const copy = payload.events.filter((e) => e && FB_TYPES.has(e.type)).map((e) => ({ type: e.type, data: e.data }))
      const entries = reduceFeedbackEntries(copy)
      for (const e of entries) enqueue(sessionId, e)
    } catch (e) { log(`feedback/committed 处理异常：${e?.message}`) }
  })

  log('反馈桥已挂载（session/event + feedback/committed → know_feedback_ingest）')
  writeStatus({ status: 'ok', ...stats })
  return null
}
