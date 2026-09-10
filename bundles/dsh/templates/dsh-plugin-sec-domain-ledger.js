// ==============================================================================
// @silksec/sec-domain-ledger — SilkSecAgent ledger 域插件（v5 Phase 2：纪律台账 / 卡使用 / 雷达队列 / 交接包）
//
// 契约：doc/secagent/v5/11-ledger.md（域设计，权威）+ 01-bus.md（总线）+ 00-conventions.md（宪法）
//
// 对外（cordis）：name='sec-domain-ledger'，apply() 把 manifest+handlers+backend 交给
// 总线 registry.register()（不 provide 任何业务方法——防绕过核心承诺）。
//
// 语义要点：
//  - 六态台账 / 卡使用 / 雷达 / 交接包 全部「写入即机器校验」（v4 从事后脚本提前到写入时的核心迁移）；
//  - radar_drain 破坏性读（读后清空）→ 天然幂等（idempotent:'none'，每次都是新读，不落幂等表）；
//  - coverage-latest.md 是查询缓存（stale-while-revalidate），物化不进审计；
//  - discipline_stats 跨域指标（IdeaCard/调度漂移）经 QueryGateway 委托，不可达降级 unavailable；
//  - 订阅 exec.run.completed（对账）/ approval.approved（scope-approved 雷达入队），弱联动 best-effort。
//
// 零依赖：node:fs / node:path / node:crypto
// ==============================================================================

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

export const name = 'sec-domain-ledger'
export const version = '1.0.0'

const DEFAULT_DATA_DIR = process.env.SEC_DATA_DIR || '/opt/silkspool/dsh/data'

const log = (msg) => { try { process.stderr.write(`[sec-domain-ledger] ${msg}\n`) } catch { /* noop */ } }

const backendUrl = new URL('../sec-backend-ledger-file/index.js', import.meta.url)
const { createLedgerFileBackend } = await import(backendUrl.href)

const RESULT_ENUM = ['TESTED_CLEAN', 'CONFIRMED', 'FALSE_POSITIVE', 'NOT_APPLICABLE', 'BLOCKED', 'STALE']
const OUTCOME_ENUM = ['applied', 'deviated', 'blocked', 'na']
const RADAR_TYPE_ENUM = ['ct-new-subdomain', 'js-bundle-change', 'scope-approved', 'version-intel']
const BANNED_REASON = new Set(['other', 'misc', ''])
const RADAR_SOURCE = {
  'ct-new-subdomain': 'ct-watch',
  'js-bundle-change': 'js-watch',
  'scope-approved': 'approval',
  'version-intel': 'version-intel',
}
const RADAR_PAYLOAD_KEYS = {
  'ct-new-subdomain': ['domain'],
  'js-bundle-change': ['host', 'bundle'],
  'scope-approved': ['domain', 'source'],
  'version-intel': ['component', 'from', 'to'],
}

function makeRunId(prefix = 'rp') {
  return `${prefix}${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`
}
function sha256(str) {
  return crypto.createHash('sha256').update(String(str)).digest('hex')
}
function canonicalize(obj) {
  const norm = (v) => {
    if (v === null || typeof v !== 'object') return v
    if (Array.isArray(v)) return v.map(norm)
    const out = {}
    for (const k of Object.keys(v).sort()) out[k] = norm(v[k])
    return out
  }
  return JSON.stringify(norm(obj))
}

// ---------------------------------------------------------------------------
// manifest（11-ledger §1.2/§1.4/§1.5 的机器形态）
// ---------------------------------------------------------------------------

const schema = (properties, required, extra = {}) => ({ type: 'object', properties, required, additionalProperties: false, ...extra })
const str = (opts = {}) => ({ type: 'string', ...opts })
const en = (values, extra = {}) => ({ type: 'string', enum: values, ...extra })
const int = (opts = {}) => ({ type: 'integer', ...opts })
const strOrNum = () => ({ type: ['string', 'number'] })

export const LEDGER_MANIFEST = {
  domain: 'ledger',
  version: 1,
  service: 'secDomain.ledger',
  description: '纪律台账（六态覆盖/卡使用/雷达队列/交接包）——执行了什么、覆盖到哪、纪律是否在线的唯一真相源，写入即校验',
  owns: {
    tables: [],
    files: [
      'data/pipeline/{program}/attempts-{program}.tsv',
      'data/pipeline/{program}/card_usage-{date}.jsonl',
      'data/pipeline/{program}/radar-queue.jsonl',
      'data/pipeline/{program}/handoff-{date}.md',
      'data/pipeline/{program}/coverage-latest.md',
      'data/events/ledger.jsonl',
    ],
  },
  commands: {
    ledger_log_attempt: {
      actor: ['model', 'script', 'human'],
      schema: schema({
        program: str({ minLength: 1 }),
        asset: str({ minLength: 1 }),
        card_id: str({ minLength: 1 }),
        card_ver: strOrNum(),
        tool: str({ minLength: 1 }),
        result: en(RESULT_ENUM),
        reason: str(),
        evidence_path: str(),
        run_id: str(),
      }, ['program', 'asset', 'card_id', 'tool', 'result']),
      idempotent: 'auto',
      idempotent_fields: ['program', 'asset', 'card_id', 'card_ver', 'tool', 'result', 'reason', 'evidence_path', 'run_id'],
      events: ['ledger.attempt.logged'],
      event_limit: 1,
      invariants: ['attemptReasonRequired', 'attemptEvidenceRequired'],
      timeout_ms: 60000,
      agent_note: '六态覆盖台账追加（写入即机器校验，违规则拒绝）。每个探测动作完成后必须立即调用一次，禁止攒批。result 枚举 TESTED_CLEAN/CONFIRMED/FALSE_POSITIVE/NOT_APPLICABLE/BLOCKED/STALE；N/A 与 BLOCKED 必填 reason（禁 other/misc）；TESTED_CLEAN 与 CONFIRMED 必填 evidence_path 且须真实存在——无证据不结论。',
      deprecated: false,
    },
    ledger_log_card_usage: {
      actor: ['model', 'script'],
      schema: schema({
        program: str({ minLength: 1 }),
        card_id: str({ minLength: 1 }),
        card_version: strOrNum(),
        asset: str({ minLength: 1 }),
        outcome: en(OUTCOME_ENUM),
        deviation: str(),
        suggest: str(),
        result: str(),
        run_id: str(),
      }, ['program', 'card_id', 'card_version', 'asset', 'outcome']),
      idempotent: 'auto',
      idempotent_fields: ['program', 'card_id', 'card_version', 'asset', 'outcome', 'deviation', 'suggest', 'result', 'run_id'],
      events: ['ledger.card_usage.logged'],
      event_limit: 1,
      invariants: ['cardDeviationRequired'],
      timeout_ms: 60000,
      agent_note: '卡片使用记录（card_usage-YYYY-MM-DD.jsonl）。outcome=applied 照卡执行 / deviated 实战有偏差 / blocked / na；deviated 必填 deviation（≥10 字，卡片升版原料），有建议填 suggest——不回执的卡会被判零使用沉没。',
      deprecated: false,
    },
    ledger_radar_push: {
      actor: ['script', 'approval', 'model', 'system'],
      schema: schema({
        program: str({ minLength: 1 }),
        type: en(RADAR_TYPE_ENUM),
        payload: { type: 'object' },
      }, ['program', 'type', 'payload']),
      idempotent: 'auto',
      idempotent_fields: ['program', 'type', 'payload'],
      events: ['ledger.radar.pushed'],
      event_limit: 1,
      invariants: ['radarPayloadValid'],
      timeout_ms: 60000,
      agent_note: '雷达事件入队（CT 新子域/JS 发版/版本情报/新授权域名）。一般由 ct-watch/js-watch/审批链自动写入；模型侧仅在发现应入队事件时使用。type 专属 payload 键：ct-new-subdomain→domain、js-bundle-change→host,bundle、scope-approved→domain,source、version-intel→component,from,to。',
      deprecated: false,
    },
    ledger_radar_drain: {
      actor: ['model', 'script'],
      schema: schema({ program: str({ minLength: 1 }) }, ['program']),
      idempotent: 'none',
      events: ['ledger.radar.drained'],
      event_limit: 1,
      invariants: [],
      timeout_ms: 60000,
      agent_note: '读取变化雷达队列并清空（drain 语义：读后即清，防重复处置）。recon 开局调用；变化优先于存量，新子域黄金窗口优先处置。只看不清用 ledger_radar_status。',
      deprecated: false,
    },
    ledger_handoff_write: {
      actor: ['model', 'script', 'human'],
      schema: schema({
        program: str({ minLength: 1 }),
        snapshot: str({ minLength: 1 }),
        actions: str({ minLength: 1 }),
        tomorrow_queue: str({ minLength: 1 }),
        blockers: str({ minLength: 1 }),
        data_refs: str({ minLength: 1 }),
      }, ['program', 'snapshot', 'actions', 'tomorrow_queue', 'blockers', 'data_refs']),
      idempotent: 'auto',
      idempotent_fields: ['program', 'snapshot', 'actions', 'tomorrow_queue', 'blockers', 'data_refs'],
      events: ['ledger.handoff.written'],
      event_limit: 1,
      invariants: [],
      timeout_ms: 60000,
      agent_note: '写当日交接包（五段：快照/动作/明日队列/阻塞/数据指针，全量覆盖写）。收尾强制产物；FGS 决策链摘要先调 fgs_export 并入动作段。blockers 无内容须传「无」。',
      deprecated: false,
    },
  },
  queries: {
    ledger_attempts_list: {
      actor: ['model', 'dashboard', 'human'],
      params: schema({
        program: str({ minLength: 1 }),
        asset: str({ default: '' }),
        card_id: str({ default: '' }),
        result: str({ default: '' }),
        run_id: str({ default: '' }),
        since: str({ default: '' }),
        until: str({ default: '' }),
        limit: int({ minimum: 1, maximum: 500 }),
        offset: int({ minimum: 0 }),
        sort: en(['ts'], { default: 'ts' }),
        dir: en(['asc', 'desc'], { default: 'desc' }),
      }, ['program']),
      agent_note: '台账行查询（program/asset/card/result/时间窗过滤 + 分页）。ts 为北京 ISO 字符串，字典序可比较。',
    },
    ledger_coverage_report: {
      actor: ['model', 'dashboard', 'human'],
      params: schema({ program: str({ minLength: 1 }), materialize: { type: 'boolean', default: true } }, ['program']),
      agent_note: 'attempts 聚合覆盖矩阵（卡片×最新态计数 + BLOCKED 解锁收益表）。报告数字唯一来源，禁手填——选格子消化以本查询为准。',
    },
    ledger_radar_status: {
      actor: ['model', 'dashboard', 'script', 'human'],
      params: schema({ program: str({ minLength: 1 }) }, ['program']),
      agent_note: '雷达队列状态（深度/类型分布/最老事件），纯读不清空。',
    },
    ledger_discipline_stats: {
      actor: ['model', 'dashboard', 'human'],
      params: schema({ program: str({ default: '' }) }, []),
      agent_note: '纪律五指标 + 告警清单（台账日增量/卡使用 7d/交接包 7d/IdeaCard/调度漂移）。纪律是否在线的一眼视图。',
    },
    ledger_pipeline_validate: {
      actor: ['model', 'dashboard', 'script', 'human'],
      params: schema({ files: { type: 'array', items: { type: 'string' } } }, ['files']),
      agent_note: '标准产物格式机器校验（收尾复核；写入时校验已在 ledger_log_* 生效）。',
    },
    ledger_task_proof: {
      actor: ['scheduler', 'system', 'dashboard', 'human'],
      params: schema({ program: str({ minLength: 1 }), since_ts: int() }, ['program', 'since_ts']),
      agent_note: '（内部接口，task 域 task_finish 用；不向模型注册）三产物存在性证明。',
    },
    ledger_usage_query: {
      actor: ['model', 'dashboard', 'system', 'reactor', 'human'],
      params: schema({
        card_id: str({ default: '' }),
        program: str({ default: '' }),
        since_days: int({ minimum: 1, maximum: 365, default: 30 }),
        aggregate: en(['counts', 'deviations'], { default: 'counts' }),
      }, []),
      agent_note: '卡片使用统计（know 域消费接口：零使用卡判据/registry 健康度/升版原料 deviation 聚合；counts/deviations 两模式）。',
    },
  },
  events: {
    'ledger.attempt.logged': { payload: { type: 'object' }, redact: [] },
    'ledger.card_usage.logged': { payload: { type: 'object' }, redact: [] },
    'ledger.radar.pushed': { payload: { type: 'object' }, redact: [] },
    'ledger.radar.drained': { payload: { type: 'object' }, redact: [] },
    'ledger.handoff.written': { payload: { type: 'object' }, redact: [] },
  },
  subscribes: {
    'exec.run.completed': { handler: 'onRunCompleted', mode: 'async', as: 'reactor' },
    'approval.approved': { handler: 'onScopeApproved', mode: 'async', as: 'reactor' },
  },
  backend: 'repository-v1',
}

// ---------------------------------------------------------------------------
// handlers（命令/查询/不变量/订阅）
// ---------------------------------------------------------------------------

function makeHandlers(opts) {
  const dispatchRef = opts.dispatch
  const queryRef = opts.query
  const dataDir = opts.dataDir || DEFAULT_DATA_DIR
  const statsCache = new Map()

  function throwErr(code, message, hint, retryable = false) {
    throw Object.assign(new Error(message), { code, hint, retryable })
  }

  function evidenceExists(evidencePath) {
    if (!evidencePath) return false
    const abs = path.isAbsolute(evidencePath) ? evidencePath : path.join(dataDir, evidencePath)
    try { return fs.existsSync(abs) } catch { return false }
  }

  const invariants = {
    attemptReasonRequired: async (args) => {
      if (['NOT_APPLICABLE', 'BLOCKED'].includes(args.result)) {
        const reason = String(args.reason || '').trim()
        if (!reason || reason.length < 4 || BANNED_REASON.has(reason.toLowerCase())) {
          return { code: 'E_LEDGER_REASON_INVALID', message: `${args.result} 必须填 reason（禁止 other/misc/空）`, hint: 'NOT_APPLICABLE 须填 na_reason（为什么卡不适用）；BLOCKED 须填 blocker（缺什么前置）——"other/misc"不构成理由', retryable: false }
        }
      }
      return null
    },
    attemptEvidenceRequired: async (args) => {
      if (['TESTED_CLEAN', 'CONFIRMED'].includes(args.result)) {
        if (!args.evidence_path) {
          return { code: 'E_EVIDENCE_REQUIRED', message: `${args.result} 必须填 evidence_path`, hint: '无证据不结论。CLEAN 与 CONFIRMED 同级举证：evidence_path 指向本次探测的原始输出（如 results/<run_id>/ 或 evidence/ 目录）', retryable: false }
        }
        if (!evidenceExists(args.evidence_path)) {
          return { code: 'E_LEDGER_EVIDENCE_MISSING', message: `evidence_path 不存在: ${args.evidence_path}`, hint: '证据文件须真实存在（绝对路径或相对 data/ 解析）；无证据不结论', retryable: false }
        }
      }
      return null
    },
    cardDeviationRequired: async (args) => {
      if (args.outcome === 'deviated' && String(args.deviation || '').length < 10) {
        return { code: 'E_LEDGER_DEVIATION_REQUIRED', message: 'outcome=deviated 必填 deviation（≥10 字）', hint: '实战与卡片规程有偏差时必须记录 ≥10 字偏差——那是卡片升版的原料', retryable: false }
      }
      return null
    },
    radarPayloadValid: async (args) => {
      const keys = RADAR_PAYLOAD_KEYS[args.type] || []
      const payload = args.payload || {}
      for (const k of keys) {
        if (!(k in payload) || String(payload[k] ?? '').length === 0) {
          return { code: 'E_SCHEMA', message: `radar type=${args.type} 缺 payload 必填键 ${k}`, hint: `type=${args.type} 需要 payload 键: ${keys.join(', ')}`, retryable: false }
        }
      }
      return null
    },
  }

  const commands = {
    ledger_log_attempt: async (args, repo) => {
      const runId = args.run_id || makeRunId()
      const r = repo.appendAttempt(args.program, [
        repo.nowIso(), args.asset, args.card_id, String(args.card_ver ?? ''), args.tool,
        args.result, args.reason || '', args.evidence_path || '', runId,
      ])
      const payload = { program: args.program, asset: args.asset, card_id: args.card_id, result: args.result, run_id: runId }
      if (args.reason) payload.reason = args.reason
      return {
        data: { file: r.file, row_ts: r.row_ts, run_id: runId },
        events: [{ name: 'ledger.attempt.logged', payload }],
        after: { result: args.result, card_id: args.card_id },
      }
    },

    ledger_log_card_usage: async (args, repo) => {
      const runId = args.run_id || makeRunId('cu')
      const rec = { card_id: args.card_id, card_version: args.card_version, asset: args.asset, outcome: args.outcome, result: args.result || '', ts: repo.nowIso(), run_id: runId }
      if (args.deviation) rec.deviation = args.deviation
      if (args.suggest) rec.suggest = args.suggest
      const r = repo.appendCardUsage(args.program, rec)
      const payload = { program: args.program, card_id: args.card_id, card_version: args.card_version, outcome: args.outcome }
      if (args.deviation) payload.deviation = args.deviation
      return {
        data: { file: r.file, card_id: args.card_id, outcome: args.outcome },
        events: [{ name: 'ledger.card_usage.logged', payload }],
        after: { card_id: args.card_id, outcome: args.outcome },
      }
    },

    ledger_radar_push: async (args, repo) => {
      const source = args.type === 'scope-approved' ? (args.payload.source || 'approval') : RADAR_SOURCE[args.type]
      const record = { ts: repo.nowIso(), type: args.type, ...args.payload, source }
      const r = repo.appendRadar(args.program, record)
      const digest = sha256(canonicalize({ program: args.program, type: args.type, payload: args.payload })).slice(0, 16)
      return {
        data: { program: args.program, type: args.type, file: r.file },
        events: [{ name: 'ledger.radar.pushed', payload: { program: args.program, type: args.type, digest } }],
        after: { type: args.type },
      }
    },

    ledger_radar_drain: async (args, repo) => {
      const events = repo.drainRadar(args.program)
      return {
        data: { program: args.program, count: events.length, events, drained: true },
        events: [{ name: 'ledger.radar.drained', payload: { program: args.program, count: events.length } }],
        after: { count: events.length },
      }
    },

    ledger_handoff_write: async (args, repo) => {
      const date = repo.beijingDate()
      const content = [
        `# 交接包 — ${args.program} — ${date}`,
        '',
        '## 1. 快照（snapshot）', args.snapshot, '',
        '## 2. 动作（actions，含 FGS 摘要与关键 run_id）', args.actions, '',
        '## 3. 明日队列（tomorrow_queue）', args.tomorrow_queue, '',
        '## 4. 阻塞（blockers）', args.blockers, '',
        '## 5. 数据指针（data_refs）', args.data_refs, '',
      ].join('\n') + '\n'
      const r = repo.writeHandoff(args.program, date, content)
      return {
        data: { program: args.program, date, file: r.file, prev_saved: r.prevSaved },
        events: [{ name: 'ledger.handoff.written', payload: { program: args.program, date, file: r.file } }],
        after: { date, file: r.file },
      }
    },
  }

  function buildCoverageMd(program, repo, result, totalRows) {
    const lines = [
      `# 覆盖矩阵视图 — ${program}`, '',
      `- 生成时间: ${repo.nowIso()}（ledger 域工具生成，禁止手填修改）`,
      `- 台账: data/pipeline/${program}/attempts-${program}.tsv（${totalRows} 行）`,
      `- 覆盖组合数: ${result.combos}`, '',
      '| 卡片 | 版本 | CLEAN | CONFIRMED | FP | N/A | BLOCKED | STALE |', '|---|---|---|---|---|---|---|---|',
    ]
    for (const m of result.matrix) lines.push(`| ${m.card} | ${m.ver} | ${m.clean} | ${m.confirmed} | ${m.fp} | ${m.na} | ${m.blocked} | ${m.stale} |`)
    lines.push('', '## BLOCKED 解锁收益', '', '| blocker | 解锁单元格数 |', '|---|---|')
    if (result.blocker_gain.length) for (const b of result.blocker_gain) lines.push(`| ${b.blocker} | ${b.cells} |`)
    else lines.push('| （无） | 0 |')
    return lines.join('\n') + '\n'
  }

  const queries = {
    ledger_attempts_list: async (args, repo) => {
      const { header, rows } = repo.readAttempts(args.program)
      let out = rows.map((r) => Object.fromEntries(header.map((k, i) => [k, r[i] ?? ''])))
      if (args.asset) out = out.filter((r) => r.asset === args.asset)
      if (args.card_id) out = out.filter((r) => r.card_id === args.card_id)
      if (args.result) out = out.filter((r) => r.result === args.result)
      if (args.run_id) out = out.filter((r) => r.run_id === args.run_id)
      if (args.since) out = out.filter((r) => r.ts >= args.since)
      if (args.until) out = out.filter((r) => r.ts <= args.until)
      const dir = args.dir === 'asc' ? 1 : -1
      out.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0) * dir)
      return { rows: out, total: out.length }
    },

    ledger_coverage_report: async (args, repo) => {
      const { rows } = repo.readAttempts(args.program)
      const latest = new Map()
      for (const r of rows) {
        if (r.length < 6) continue
        const key = `${r[1]}|${r[2]}`
        if (!latest.has(key) || r[0] >= latest.get(key)[0]) latest.set(key, [r[0], r[5], r[6] || '', r[3]])
      }
      const cardState = {}, cardVer = {}, blockerGain = {}
      for (const [key, [, result, reason, ver]] of latest) {
        const card = key.split('|')[1]
        cardState[card] = cardState[card] || {}
        cardState[card][result] = (cardState[card][result] || 0) + 1
        cardVer[card] = ver
        if (result === 'BLOCKED' && reason) blockerGain[reason] = (blockerGain[reason] || 0) + 1
      }
      const matrix = Object.keys(cardState).sort().map((c) => {
        const st = cardState[c]
        return { card: c, ver: cardVer[c], clean: st.TESTED_CLEAN || 0, confirmed: st.CONFIRMED || 0, fp: st.FALSE_POSITIVE || 0, na: st.NOT_APPLICABLE || 0, blocked: st.BLOCKED || 0, stale: st.STALE || 0 }
      })
      const blocker_gain = Object.entries(blockerGain).sort((x, y) => y[1] - x[1]).map(([blocker, cells]) => ({ blocker, cells }))
      const result = { combos: latest.size, cards: Object.keys(cardState).length, matrix, blocker_gain }
      if (args.materialize !== false) {
        const md = buildCoverageMd(args.program, repo, result, rows.length)
        const out = path.join(repo.pipelineRoot(args.program), 'coverage-latest.md')
        repo.writeFileAtomic(out, md)
        result.materialized = out
      }
      return result
    },

    ledger_radar_status: async (args, repo) => {
      const records = repo.readRadar(args.program)
      const by_type = {}
      let oldest_ts = null
      for (const r of records) {
        const t = (r && r.type) ? r.type : 'unknown'
        by_type[t] = (by_type[t] || 0) + 1
        if (r && r.ts && (oldest_ts === null || r.ts < oldest_ts)) oldest_ts = r.ts
      }
      return { count: records.length, by_type, oldest_ts, empty: records.length === 0 }
    },

    ledger_discipline_stats: async (args, repo) => {
      const cacheKey = args.program || '__all__'
      const cached = statsCache.get(cacheKey)
      if (cached && (Date.now() - cached.at) < 60000) return cached.value
      const value = await computeDisciplineStats(args, repo)
      statsCache.set(cacheKey, { at: Date.now(), value })
      return value
    },

    ledger_pipeline_validate: async (args, repo) => {
      const all = []
      for (const f of args.files) {
        if (!fs.existsSync(f)) { all.push(`${f}: 不存在`); continue }
        all.push(...repo.validateFile(f))
      }
      return { ok: all.length === 0, errors: all, checked: args.files.length }
    },

    ledger_task_proof: async (args, repo) => {
      const attempts_delta_24h = repo.statAttemptsDelta(args.program, args.since_ts)
      const card_usage_24h = repo.statCardUsageSince(args.program, args.since_ts)
      const handoff_today = repo.hasHandoff(args.program, repo.beijingDate())
      return {
        attempts_delta_24h, card_usage_24h, handoff_today,
        evidence: {
          attempts_file: path.join(repo.pipelineRoot(args.program), `attempts-${args.program}.tsv`),
          handoff_file: path.join(repo.pipelineRoot(args.program), `handoff-${repo.beijingDate()}.md`),
        },
      }
    },

    ledger_usage_query: async (args, repo) => {
      const sinceDays = Number(args.since_days ?? 30)
      const cutoffDate = repo.beijingDate(Date.now() - (sinceDays - 1) * 86400000)
      const programs = args.program ? [args.program] : repo.listPrograms()
      if (args.aggregate === 'deviations') {
        const rows = []
        for (const p of programs) {
          for (const f of repo.listCardUsageFiles(p)) {
            const d = f.match(/^card_usage-(\d{4}-\d{2}-\d{2})\.jsonl$/)[1]
            if (d < cutoffDate) continue
            for (const rec of repo.readJsonl(path.join(repo.pipelineRoot(p), f))) {
              if (rec && typeof rec === 'object' && !('raw' in rec) && rec.deviation) {
                if (args.card_id && rec.card_id !== args.card_id) continue
                rows.push({ ts: rec.ts || '', card_id: rec.card_id || '', deviation: rec.deviation, suggest: rec.suggest || '', run_id: rec.run_id || '' })
              }
            }
          }
        }
        rows.sort((a, b) => String(b.ts).localeCompare(String(a.ts)))
        return { rows, total: rows.length }
      }
      const agg = {}
      for (const p of programs) {
        for (const f of repo.listCardUsageFiles(p)) {
          const d = f.match(/^card_usage-(\d{4}-\d{2}-\d{2})\.jsonl$/)[1]
          if (d < cutoffDate) continue
          for (const rec of repo.readJsonl(path.join(repo.pipelineRoot(p), f))) {
            if (!rec || typeof rec !== 'object' || ('raw' in rec)) continue
            const cid = rec.card_id || '?'
            if (args.card_id && cid !== args.card_id) continue
            const a = agg[cid] || (agg[cid] = { card_id: cid, uses: 0, last_used_at: '', deviated: 0 })
            a.uses++
            if (!a.last_used_at || String(rec.ts || '') > String(a.last_used_at)) a.last_used_at = rec.ts || ''
            if (rec.outcome === 'deviated' || (rec.outcome === undefined && rec.deviation)) a.deviated++
          }
        }
      }
      const rows = Object.values(agg).sort((a, b) => b.uses - a.uses)
      return { rows, total: rows.length }
    },
  }

  async function computeDisciplineStats(args, repo) {
    const programs = args.program ? [args.program] : repo.listPrograms()
    const now = Date.now()
    const ledgerToday = {}
    let cardUsage7d = 0
    let handoff7d = 0
    for (const p of programs) {
      const { rows } = repo.readAttempts(p)
      ledgerToday[p] = { total: rows.length, today: repo.statAttemptsDelta(p, now - 86400000) }
      cardUsage7d += repo.countCardUsageDays(p, 7)
      handoff7d += repo.countHandoffDays(p, 7)
    }
    // 跨域：IdeaCard 数（know 域查询委托；know 尚未暴露 ideas 计数时降级）
    let ideaCards = 'unavailable'
    if (queryRef) {
      try {
        const r = await queryRef('know', 'health', {}, { actor: 'system' })
        if (r && r.ok && r.data && typeof r.data === 'object' && r.data.vulncards && typeof r.data.vulncards.total === 'number') ideaCards = r.data.vulncards.total
      } catch { ideaCards = 'unavailable' }
    }
    // 跨域：调度漂移 + task_runs 新鲜度（task 域查询委托；task 域 2.4 未上线时降级）
    let scheduledDrift = 'unavailable'
    let taskRunsLastAgeHours = 'unavailable'
    if (queryRef) {
      try {
        const r = await queryRef('task', 'drift', {}, { actor: 'system' })
        if (r && r.ok) { scheduledDrift = r.data?.scheduled_drift ?? r.rows ?? 'unavailable'; taskRunsLastAgeHours = r.data?.task_runs_last_age_hours ?? 'unavailable' }
      } catch { scheduledDrift = 'unavailable'; taskRunsLastAgeHours = 'unavailable' }
    }
    // 数据源新鲜度（radar oldest_ts 作为雷达队列健康度；ct-watch/js-watch 日志错误率留待后续接入）
    const radarByProgram = {}
    for (const p of programs) radarByProgram[p] = { count: repo.readRadar(p).length, oldest_ts: (repo.readRadar(p).map((x) => x && x.ts).filter(Boolean).sort()[0] || null) }
    const alerts = []
    for (const [p, v] of Object.entries(ledgerToday)) {
      if (v.total === 0) alerts.push(`台账空转: ${p} attempts 0 行`)
    }
    if (cardUsage7d === 0) alerts.push('卡片使用记录 7 天 0 条（ledger_log_card_usage 未被使用）')
    if (handoff7d === 0) alerts.push('交接包 7 天 0 份（handoff-{date}.md 未生成）')
    // 台账漂移对账（exec_runs 对账，弱联动；exec 域上线前 exec_runs 恒 0 不告警）
    let execRuns24h = 0
    for (const p of programs) execRuns24h += repo.statExecRunsSince(p, now - 86400000)
    let attempts24h = 0
    for (const p of programs) attempts24h += repo.statAttemptsDelta(p, now - 86400000)
    if (execRuns24h >= 5 && attempts24h === 0) alerts.push(`台账漂移: 近 24h 执行 ${execRuns24h} 次工具但台账 0 行`)
    return {
      generated_at: new Date().toISOString(),
      ledger_today: ledgerToday,
      card_usage_7d: cardUsage7d,
      handoff_7d: handoff7d,
      idea_cards: ideaCards,
      scheduled_drift: scheduledDrift,
      task_runs_last_age_hours: taskRunsLastAgeHours,
      exec_runs_24h: execRuns24h,
      radar: radarByProgram,
      data_source: { ct_watch: 'unavailable', js_watch: 'unavailable' },
      alerts,
      healthy: alerts.length === 0,
    }
  }

  const subscribers = {
    onRunCompleted: async (envelope) => {
      const p = envelope?.payload || {}
      const program = p.program_id || p.program || ''
      if (!program) return { ok: true, data: { skipped: true } }
      // 弱联动对账：append exec-runs 计数（不代写台账——台账是 agent 的纪律动作本身）
      try {
        const dir = path.join(dataDir, 'pipeline', program)
        fs.mkdirSync(dir, { recursive: true })
        const date = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
        const rec = { ts: new Date(Date.now() + 8 * 3600_000).toISOString().replace('Z', '+08:00').slice(0, 19), program, run_id: p.run_id || '', tool: p.tool || '' }
        fs.appendFileSync(path.join(dir, `exec-runs-${date}.jsonl`), JSON.stringify(rec) + '\n')
        return { ok: true, data: { skipped: false } }
      } catch (e) {
        log(`exec-runs 计数写入失败: ${e?.message}`)
        return { ok: true, data: { skipped: false, error: String(e?.message) } }
      }
    },
    onScopeApproved: async (envelope) => {
      if (!dispatchRef) return { ok: true, data: { skipped: true } }
      const p = envelope?.payload || {}
      if (p.kind !== 'scope-domain' && p.kind !== 'scope-wildcard') return { ok: true, data: { skipped: true } }
      const host = p.subject || p.domain || ''
      if (!host) return { ok: true, data: { skipped: true } }
      try {
        const r = await dispatchRef('ledger', 'radar_push', {
          program: p.program_id || '__legacy__', type: 'scope-approved', payload: { domain: host, source: 'approval' },
        }, { actor: 'approval' })
        return { ok: !!r.ok, data: { skipped: false } }
      } catch (e) {
        log(`scope-approved 雷达入队失败（best-effort）: ${e?.message}`)
        return { ok: true, data: { skipped: false, error: String(e?.message) } }
      }
    },
  }

  return { ...commands, queries, invariants, subscribers }
}

// ---------------------------------------------------------------------------
// 组装（测试与 cordis 共用）
// ---------------------------------------------------------------------------

export function buildLedgerDomain(opts = {}) {
  const dataDir = opts.dataDir || DEFAULT_DATA_DIR
  const backend = createLedgerFileBackend({ dataDir })
  return {
    manifest: LEDGER_MANIFEST,
    handlers: makeHandlers({ ...opts, dataDir }),
    backend,
  }
}

export function apply(ctx, config = {}) {
  const dataDir = process.env.SEC_DATA_DIR || process.env.DSH_HOME || DEFAULT_DATA_DIR
  try {
    ctx.inject(['secDomainBus'], (child) => {
      const bus = child.secDomainBus
      const domain = buildLedgerDomain({
        dataDir,
        dispatch: (d, v, a, c) => bus.dispatch(d, v, a, c),
        query: (d, n, a, c) => bus.query(d, n, a, c),
      })
      const res = bus.registry.register(domain)
      if (res.ok) log(`ledger 域注册成功（registered=${res.registered}）`)
      else log(`ledger 域注册被拒：${res.error?.code} ${res.error?.message}`)
      return () => {}
    })
  } catch (e) {
    log(`secDomainBus 注入失败：${e?.message}——ledger 域未注册（总线必须先行挂载）`)
  }
  return null
}
