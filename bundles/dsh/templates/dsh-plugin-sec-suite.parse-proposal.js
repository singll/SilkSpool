import * as fs from 'node:fs'
import * as path from 'node:path'
import { createHash } from 'node:crypto'

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')

// 大提案已经由 exec 落盘；事件仅传固定文件引用，保持总线 8KiB 上限。
export function compactProposalEvents(events, storedProposal) {
  for (const event of events) {
    const proposal = event.payload?.parse_proposal
    if (proposal && Buffer.byteLength(JSON.stringify(event.payload)) > 6000) {
      event.payload.parse_proposal = { kind: proposal.kind, proposal_ref: 'proposal.json', sha256: digest(storedProposal) }
    }
  }
}

export function readParseProposal(dataDir, payload) {
  const proposal = payload?.parse_proposal
  if (!proposal?.proposal_ref) return proposal
  if (proposal.proposal_ref !== 'proposal.json' || !/^r[a-z0-9]+$/.test(payload.run_id || '')) {
    throw Object.assign(new Error('无效的执行提案引用'), { code: 'E_EXEC_PROPOSAL_REF' })
  }
  const stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'results', payload.run_id, 'proposal.json'), 'utf8'))
  if (proposal.sha256 !== digest(stored)) throw Object.assign(new Error('执行提案内容与事件摘要不符'), { code: 'E_EXEC_PROPOSAL_INTEGRITY' })
  return { ...stored, kind: proposal.kind }
}
