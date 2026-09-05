// ==============================================================================
// SilkSecAgent 流水线插件（sec-pipeline）——覆盖台账/卡片使用/格式校验/覆盖聚合/
// 机械复核/参数面消费 注册为 DSH 原生工具（替代 scripts/pipeline/ 裸脚本调用）。
//
// 设计：doc/secagent/dsh-0.1.2-upgrade-arch-plan.md §4.2/§五
// 内嵌 sec-common 共享函数（makeRunId / tsvAppend / scopeReader / evidence 路径），
// 后续 sec-suite 拆分复用同一份实现（单文件部署，与 proxy-pool 插件同构）。
//
// 工具清单：
//   attempts_log      六态台账追加（写入即校验：result 枚举/N-A·BLOCKED 必填理由/CLEAN·CONFIRMED 必填证据）
//   card_usage_log    卡片使用记录（deviation 反哺卡片升版）
//   radar_read        变化雷达队列读取（ct/js 事件，默认 drain）
//   pipeline_validate 标准产物格式机器校验（收尾强制）
//   coverage_report   attempts.tsv → 覆盖矩阵视图（脚本生成，禁手填）
//   verify_replay     CONFIRMED 机械复核（重放 request.txt + hash 比对 + verify-log）
//   surface_queue     endpoints.tsv/文本 → 参数 URL 队列（dalfox/sqlmap 喂料）
//   surface_scan      敏感信息正则回扫（VC-027，命中打码）
//
// 配置（环境变量）：SEC_DATA_DIR（默认 /opt/silkspool/dsh/data）
//                  SEC_EGRESS_PROXY（verify_replay 默认出口，默认 http://127.0.0.1:8899）
// ==============================================================================

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import * as http from 'node:http'
import * as https from 'node:https'

export const name = 'sec-pipeline'
export const inject = ['tools']

const DATA_DIR = process.env.SEC_DATA_DIR || '/opt/silkspool/dsh/data'
const DEFAULT_PROXY = process.env.SEC_EGRESS_PROXY || 'http://127.0.0.1:8899'

// -------------------- sec-common：共享函数 --------------------

function makeRunId(prefix = 'rp') {
  return `${prefix}${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`
}

function nowIso() {
  // 东八区 ISO（台账统一时区）
  return new Date(Date.now() + 8 * 3600_000).toISOString().replace('Z', '+08:00').slice(0, 19)
}

function pipelineDir(program) {
  const d = path.join(DATA_DIR, 'pipeline', program)
  fs.mkdirSync(d, { recursive: true })
  return d
}

const TSV_HEADERS = {
  attempts: ['ts', 'asset', 'card_id', 'card_ver', 'tool', 'result', 'reason', 'evidence_path', 'run_id'],
  assets: ['domain', 'status', 'first_seen', 'last_seen', 'source', 'probe_date'],
  endpoints: ['url', 'method', 'params', 'auth_required', 'source', 'collected_at'],
}

function tsvAppend(file, header, row) {
  if (!fs.existsSync(file)) fs.writeFileSync(file, header.join('\t') + '\n')
  fs.appendFileSync(file, row.join('\t') + '\n')
}

function readTsv(file) {
  if (!fs.existsSync(file)) return { header: [], rows: [] }
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim())
  if (!lines.length) return { header: [], rows: [] }
  return { header: lines[0].split('\t'), rows: lines.slice(1).map((l) => l.split('\t')) }
}

function tool(options) {
  return {
    name: options.name,
    description: options.description,
    parameters: options.parameters,
    output: { schema: { type: 'object' }, render: options.render },
    async execute(args) { return options.execute(args || {}) },
  }
}

// render 回调（双参签名：宿主以 (args, value) 调用，序列化的是 value 而非 args）。
// execute 必须返回纯对象（与 output.schema type:'object' 对齐），禁止 return renderJSON(x)。
function renderJSON(_args, value) {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
}

const RESULT_ENUM = ['TESTED_CLEAN', 'CONFIRMED', 'FALSE_POSITIVE', 'NOT_APPLICABLE', 'BLOCKED', 'STALE']
const BANNED_REASON = new Set(['other', 'misc', ''])

// -------------------- 工具实现 --------------------

function toolAttemptsLog() {
  return {
    description: '六态覆盖台账追加（写入即机器校验，违规则拒绝）。每个探测动作完成后必须立即调用一次，禁止攒批。',
    parameters: {
      type: 'object',
      properties: {
        program: { type: 'string', description: 'meituan-src / bytedance / dsh-ops…' },
        asset: { type: 'string' },
        card_id: { type: 'string', description: '漏洞卡 ID，如 VC-001；非卡片动作用 MC-xx/PC-xx 或 -' },
        card_ver: { type: ['string', 'number'] },
        tool: { type: 'string' },
        result: { type: 'string', enum: RESULT_ENUM },
        reason: { type: 'string', description: 'NOT_APPLICABLE/BLOCKED 必填（na_reason/blocker），禁止 other/misc' },
        evidence_path: { type: 'string', description: 'TESTED_CLEAN/CONFIRMED 必填（无证据不结论）' },
        run_id: { type: 'string' },
      },
      required: ['program', 'asset', 'card_id', 'tool', 'result'],
      additionalProperties: false,
    },
    execute: async (a) => {
      if (['NOT_APPLICABLE', 'BLOCKED'].includes(a.result) && BANNED_REASON.has((a.reason || '').toLowerCase()))
        return { ok: false, error: `${a.result} 必须填 reason（禁止 other/misc/空）` }
      if (['TESTED_CLEAN', 'CONFIRMED'].includes(a.result) && !a.evidence_path)
        return { ok: false, error: `${a.result} 必须填 evidence_path（无证据不结论）` }
      const file = path.join(pipelineDir(a.program), `attempts-${a.program}.tsv`)
      const runId = a.run_id || makeRunId()
      tsvAppend(file, TSV_HEADERS.attempts, [
        nowIso(), a.asset, a.card_id, String(a.card_ver ?? ''), a.tool,
        a.result, a.reason || '', a.evidence_path || '', runId,
      ])
      return { ok: true, file, run_id: runId }
    },
  }
}

function toolCardUsageLog() {
  return {
    description: '卡片使用记录（card_usage-YYYY-MM-DD.jsonl）。实战与卡片有偏差时 deviation/suggest 必填——那是卡片升版的原料。',
    parameters: {
      type: 'object',
      properties: {
        program: { type: 'string' },
        card_id: { type: 'string' },
        card_version: { type: ['string', 'number'] },
        asset: { type: 'string' },
        result: { type: 'string' },
        deviation: { type: 'string', description: '实战与卡片规程的偏差（无则省略）' },
        suggest: { type: 'string', description: '卡片修改建议（无则省略）' },
        run_id: { type: 'string' },
      },
      required: ['program', 'card_id', 'card_version', 'asset', 'result'],
      additionalProperties: false,
    },
    execute: async (a) => {
      const date = nowIso().slice(0, 10)
      const file = path.join(pipelineDir(a.program), `card_usage-${date}.jsonl`)
      const rec = { card_id: a.card_id, card_version: a.card_version, asset: a.asset, result: a.result, ts: nowIso() }
      if (a.deviation) rec.deviation = a.deviation
      if (a.suggest) rec.suggest = a.suggest
      rec.run_id = a.run_id || makeRunId('cu')
      fs.appendFileSync(file, JSON.stringify(rec) + '\n')
      return { ok: true, file }
    },
  }
}

function toolRadarRead() {
  return {
    description: '读取变化雷达队列（CT 新子域/JS 发版/版本情报事件）。recon 开局调用；drain=true（默认）读后清空队列。',
    parameters: {
      type: 'object',
      properties: {
        program: { type: 'string' },
        drain: { type: 'boolean', description: '默认 true：读后清空' },
      },
      required: ['program'],
      additionalProperties: false,
    },
    execute: async (a) => {
      const file = path.join(pipelineDir(a.program), 'radar-queue.jsonl')
      if (!fs.existsSync(file)) return { ok: true, events: [], note: '队列空' }
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim())
      const events = lines.map((l) => { try { return JSON.parse(l) } catch { return { raw: l } } })
      if (a.drain !== false) fs.writeFileSync(file, '')
      return { ok: true, count: events.length, events, drained: a.drain !== false }
    },
  }
}

const SCHEMA_MATCH = [
  { prefix: 'attempts-', header: TSV_HEADERS.attempts, resultEnum: RESULT_ENUM },
  { prefix: 'assets-', header: TSV_HEADERS.assets },
  { prefix: 'endpoints-', header: TSV_HEADERS.endpoints },
  { prefix: 'egress-health', header: ['egress', 'target_domain', 'ts', 'signature', 'verdict'] },
]
const TS_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/

function validateFile(file) {
  const base = path.basename(file)
  const errors = []
  if (base.startsWith('card_usage-')) {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim())
    lines.forEach((l, i) => {
      try {
        const rec = JSON.parse(l)
        for (const k of ['card_id', 'card_version', 'asset', 'result'])
          if (!(k in rec)) errors.push(`${file}:${i + 1}: 缺必填字段 ${k}`)
      } catch (e) { errors.push(`${file}:${i + 1}: JSON 解析失败`) }
    })
    return errors
  }
  const schema = SCHEMA_MATCH.find((s) => base.startsWith(s.prefix))
  if (!schema) return [`${file}: 无匹配 schema（文件名需以 attempts-/assets-/endpoints-/egress-health-/card_usage- 开头）`]
  const { header, rows } = readTsv(file)
  if (!header.length) return [`${file}: 空文件`]
  const core = schema.header
  if (core.some((c, i) => header[i] !== c)) {
    errors.push(`${file}: 核心列不符 期望前缀 ${core.join(',')} 实际 ${header.slice(0, core.length).join(',')}`)
    return errors
  }
  rows.forEach((row, i) => {
    const ln = i + 2
    if (row.length < core.length) { errors.push(`${file}:${ln}: 列数不足`); return }
    const rec = Object.fromEntries(core.map((k, j) => [k, row[j]]))
    if (rec.ts && !TS_RE.test(rec.ts)) errors.push(`${file}:${ln}: ts 格式异常`)
    if (schema.resultEnum) {
      if (!schema.resultEnum.includes(rec.result)) errors.push(`${file}:${ln}: result 非法 '${rec.result}'`)
      else if (['NOT_APPLICABLE', 'BLOCKED'].includes(rec.result) && BANNED_REASON.has((rec.reason || '').toLowerCase()))
        errors.push(`${file}:${ln}: ${rec.result} 缺 reason`)
      else if (['TESTED_CLEAN', 'CONFIRMED'].includes(rec.result) && !rec.evidence_path)
        errors.push(`${file}:${ln}: ${rec.result} 缺 evidence_path`)
    }
  })
  return errors
}

function toolPipelineValidate() {
  return {
    description: '标准产物格式机器校验（防幻觉标准5：收尾强制，任一失败=任务不许收尾）。',
    parameters: {
      type: 'object',
      properties: { files: { type: 'array', items: { type: 'string' }, description: '产物文件绝对路径列表' } },
      required: ['files'],
      additionalProperties: false,
    },
    execute: async (a) => {
      const all = []
      for (const f of a.files) {
        if (!fs.existsSync(f)) { all.push(`${f}: 不存在`); continue }
        all.push(...validateFile(f))
      }
      return { ok: all.length === 0, errors: all, checked: a.files.length }
    },
  }
}

function toolCoverageReport() {
  return {
    description: 'attempts 台账聚合为覆盖矩阵视图（卡片×最新状态计数 + BLOCKED 解锁收益）。报告数字唯一来源，禁手填。',
    parameters: {
      type: 'object',
      properties: {
        program: { type: 'string' },
        out: { type: 'string', description: '输出 md 路径（缺省 data/pipeline/{program}/coverage-latest.md）' },
      },
      required: ['program'],
      additionalProperties: false,
    },
    execute: async (a) => {
      const file = path.join(pipelineDir(a.program), `attempts-${a.program}.tsv`)
      const { rows } = readTsv(file)
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
      const lines = [
        `# 覆盖矩阵视图 — ${a.program}`, '',
        `- 生成时间: ${nowIso()}（sec-pipeline 工具生成，禁止手填修改）`,
        `- 台账: ${file}（${rows.length} 行）`, `- 覆盖组合数: ${latest.size}`, '',
        '| 卡片 | 版本 | CLEAN | CONFIRMED | FP | N/A | BLOCKED | STALE |', '|---|---|---|---|---|---|---|---|',
      ]
      for (const c of Object.keys(cardState).sort()) {
        const st = cardState[c]
        lines.push(`| ${c} | ${cardVer[c]} | ${st.TESTED_CLEAN || 0} | ${st.CONFIRMED || 0} | ${st.FALSE_POSITIVE || 0} | ${st.NOT_APPLICABLE || 0} | ${st.BLOCKED || 0} | ${st.STALE || 0} |`)
      }
      lines.push('', '## BLOCKED 解锁收益', '', '| blocker | 解锁单元格数 |', '|---|---|')
      const bg = Object.entries(blockerGain).sort((x, y) => y[1] - x[1])
      if (bg.length) bg.forEach(([b, n]) => lines.push(`| ${b} | ${n} |`))
      else lines.push('| （无） | 0 |')
      const out = a.out || path.join(pipelineDir(a.program), 'coverage-latest.md')
      fs.writeFileSync(out, lines.join('\n') + '\n')
      return { ok: true, out, combos: latest.size, cards: Object.keys(cardState).length, blocked: blockerGain }
    },
  }
}

function httpReplay({ method, pathq, host, headers, body, proxy, timeoutMs = 15000 }) {
  return new Promise((resolve, reject) => {
    const hdrs = { ...headers }
    delete hdrs['content-length']; delete hdrs['connection']; delete hdrs['Content-Length']
    hdrs['Accept-Encoding'] = 'identity'
    let req
    const opts = { method, headers: hdrs, timeout: timeoutMs }
    if (proxy) {
      // http 代理转发绝对 URI（mubeng 网关支持 http 转发；https 目标走 CONNECT 较复杂，
      // 这里用 http:// 降级路径：若目标仅 https 可用，请先不带 proxy 直连验证或扩展 CONNECT）
      const u = new URL(proxy)
      req = http.request({ host: u.hostname, port: u.port, path: `https://${host}${pathq}`, ...opts }, resolve)
    } else {
      req = https.request({ host, port: 443, path: pathq, ...opts }, resolve)
    }
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

function toolVerifyReplay() {
  return {
    description: 'CONFIRMED 机械复核（防幻觉标准9：LLM 不给自己当法官）。重放 evidence/{id}/request.txt，响应体 sha256 比对并追加 verify-log.md。',
    parameters: {
      type: 'object',
      properties: {
        evidence_dir: { type: 'string' },
        proxy: { type: 'string', description: `默认 ${DEFAULT_PROXY}；传 "direct" 直连` },
        expect_hash: { type: 'string', description: '期望响应体 sha256（可选，不一致则 FAIL）' },
      },
      required: ['evidence_dir'],
      additionalProperties: false,
    },
    execute: async (a) => {
      const reqFile = path.join(a.evidence_dir, 'request.txt')
      if (!fs.existsSync(reqFile)) return { ok: false, error: `${reqFile} 不存在` }
      const raw = fs.readFileSync(reqFile, 'utf8')
      const [head, ...rest] = raw.split(/\r?\n\r?\n/)
      const lines = head.split(/\r?\n/)
      const m = lines[0].match(/^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+(\S+)/)
      if (!m) return { ok: false, error: 'request.txt 首行无法解析' }
      const headers = {}
      for (const line of lines.slice(1)) {
        const i = line.indexOf(':')
        if (i > 0) headers[line.slice(0, i).trim()] = line.slice(i + 1).trim()
      }
      const host = headers['Host'] || headers['host']
      if (!host) return { ok: false, error: 'request.txt 缺 Host 头' }
      const proxy = a.proxy === 'direct' ? null : (a.proxy || DEFAULT_PROXY)
      try {
        const resp = await httpReplay({ method: m[1], pathq: m[2], host, headers, body: rest.join('\n\n'), proxy })
        const chunks = []
        await new Promise((res, rej) => { resp.on('data', (c) => chunks.push(c)); resp.on('end', res); resp.on('error', rej) })
        const hash = crypto.createHash('sha256').update(Buffer.concat(chunks)).digest('hex')
        let verdict = 'REPLAYED'
        if (a.expect_hash) verdict = hash === a.expect_hash ? 'PASS' : 'FAIL(hash 不一致)'
        fs.appendFileSync(path.join(a.evidence_dir, 'verify-log.md'),
          `| ${nowIso()} | ${proxy || 'direct'} | ${resp.statusCode} | sha256:${hash.slice(0, 16)}… | ${verdict} |\n`)
        return { ok: !verdict.startsWith('FAIL'), status: resp.statusCode, sha256: hash, verdict }
      } catch (e) {
        return { ok: false, error: `重放失败: ${e.message}` }
      }
    },
  }
}

const SENSITIVE = {
  phone: /(?<!\d)1[3-9]\d{9}(?!\d)/,
  idcard: /(?<!\d)\d{17}[\dXx](?!\d)/,
  bankcard: /(?<!\d)\d{16,19}(?!\d)/,
  aksk: /(?<![A-Za-z0-9])(AK[A-Z0-9]{15,}|LTAI[A-Za-z0-9]{12,}|SK[.A-Za-z0-9_-]{20,})(?![A-Za-z0-9])/,
  token: /(api[_-]?key|secret|token)["'\s:=]+[A-Za-z0-9_\-]{16,}/i,
  jwt: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/,
  private_ip: /(?<![\d.])(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})(?![\d.])/,
}

function toolSurfaceScan() {
  return {
    description: '敏感信息正则回扫（VC-027 脱敏检查）：手机号/身份证/银行卡/AK-SK/token/JWT/内网IP，命中打码+sha256 指纹。',
    parameters: {
      type: 'object',
      properties: { file: { type: 'string', description: '待扫描文件绝对路径（JS/响应 dump/endpoints 等）' } },
      required: ['file'],
      additionalProperties: false,
    },
    execute: async (a) => {
      if (!fs.existsSync(a.file)) return { ok: false, error: '文件不存在' }
      const hits = []
      const lines = fs.readFileSync(a.file, 'utf8').split('\n')
      lines.forEach((line, i) => {
        for (const [name, pat] of Object.entries(SENSITIVE)) {
          const m = line.match(pat)
          if (m) {
            const s = m[0]
            const masked = s.length > 6 ? s.slice(0, 4) + '***' + s.slice(-2) : '***'
            hits.push({ line: i + 1, type: name, masked, sha256: crypto.createHash('sha256').update(s).digest('hex').slice(0, 12) })
            break
          }
        }
      })
      return { ok: true, file: a.file, hits: hits.length, detail: hits.slice(0, 50), truncated: hits.length > 50 }
    },
  }
}

function toolSurfaceQueue() {
  return {
    description: '参数面消费：从 endpoints.tsv（或任意文本）提取带参数 URL，全局去重后入 param-queue.txt（dalfox/sqlmap 喂料队列）。',
    parameters: {
      type: 'object',
      properties: {
        program: { type: 'string' },
        source: { type: 'string', description: 'endpoints.tsv 或文本文件路径' },
      },
      required: ['program', 'source'],
      additionalProperties: false,
    },
    execute: async (a) => {
      if (!fs.existsSync(a.source)) return { ok: false, error: 'source 不存在' }
      const dir = pipelineDir(a.program)
      const seenFile = path.join(dir, 'param-seen.txt')
      const queueFile = path.join(dir, 'param-queue.txt')
      const seen = new Set(fs.existsSync(seenFile) ? fs.readFileSync(seenFile, 'utf8').split('\n').filter(Boolean) : [])
      const urls = new Set()
      const content = fs.readFileSync(a.source, 'utf8')
      if (a.source.endsWith('.tsv')) {
        for (const line of content.split('\n').slice(1)) {
          const cols = line.split('\t')
          if (cols[0] && cols[0].startsWith('http') && cols[2]) urls.add(cols[0])
        }
      } else {
        for (const m of content.matchAll(/https?:\/\/[^\s"'<>)]+/g)) {
          try { if (new URL(m[0]).search) urls.add(m[0]) } catch { /* skip */ }
        }
      }
      const fresh = [...urls].filter((u) => !seen.has(u)).sort()
      if (fresh.length) {
        fs.appendFileSync(queueFile, fresh.join('\n') + '\n')
        fs.appendFileSync(seenFile, fresh.join('\n') + '\n')
      }
      return { ok: true, new_urls: fresh.length, pool: seen.size + fresh.length, queue: queueFile,
        hint: `dalfox file ${queueFile} / sqlmap -m ${queueFile} --batch --level 1 --risk 1` }
    },
  }
}

// -------------------- 注册 --------------------

export function apply(ctx) {
  const defs = [
    ['attempts_log', toolAttemptsLog()],
    ['card_usage_log', toolCardUsageLog()],
    ['radar_read', toolRadarRead()],
    ['pipeline_validate', toolPipelineValidate()],
    ['coverage_report', toolCoverageReport()],
    ['verify_replay', toolVerifyReplay()],
    ['surface_scan', toolSurfaceScan()],
    ['surface_queue', toolSurfaceQueue()],
  ]
  for (const [n, def] of defs) {
    ctx.tools.register(tool({
      name: n,
      description: def.description,
      parameters: def.parameters,
      render: renderJSON,
      execute: def.execute,
    }))
  }
}
