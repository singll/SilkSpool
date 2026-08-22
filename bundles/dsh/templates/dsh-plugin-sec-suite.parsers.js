// ==============================================================================
// SilkSecAgent parser 注册表（P7）：结构化工具输出 → 资产 / 接口 / 发现
// 由 sec-cli-adapter 在 run_cli 成功后按 manifest.parser 路由调用（替代纯 regex 抽取）。
//
// 解析器命名：<parser>_<tool>（精确）优先，其次 <parser>（通用），最后回退 ingestText。
// 返回 { assets, endpoints, findings } 计数（已写库）。三级漏斗第一层（确定性规则，
// 零 token）在此过滤明显误报，挡掉纯检测类模板。
// ==============================================================================

import * as db from './asset-db.js'

// ---------- 工具函数 ----------

function hostOfUrl(raw) {
  try {
    const u = new URL(String(raw))
    return u.host || ''
  } catch {
    return ''
  }
}

function pathOfUrl(raw) {
  try {
    const u = new URL(String(raw))
    return u.pathname + u.search
  } catch {
    return ''
  }
}

// nuclei severity 归一化（unknown → info，避免脏值）
function normSev(sev) {
  const s = String(sev || '').toLowerCase()
  return ['critical', 'high', 'medium', 'low', 'info'].includes(s) ? s : 'info'
}

// 三级漏斗第一层：确定性规则（零 token）。返回 true = 保留，false = 丢弃。
// 当前为 v0 保守版：仅挡纯检测/指纹/截图类模板，不挡真实误配置（如 missing-security-headers）。
const NUCLEI_SKIP_TEMPLATE = /(tech-detect|favicon|waf-detect|http-fingerprint|screenshot|tls-version|ssl-cipher|cdn-|whois-|http-options|http-trace|http-methods)/i

function passesRuleLayer(kind, record) {
  if (kind !== 'nuclei') return true
  const tpl = String(record.template_id || '')
  if (NUCLEI_SKIP_TEMPLATE.test(tpl)) return false
  return true
}

// ---------- 具体解析器 ----------

// httpx -json（NDJSON）：host/port/title/webserver/tech → assets(attrs) + endpoints
function parseJsonlHttpx(text, ctx) {
  const assets = []
  const endpoints = []
  const seen = new Set()
  for (const line of String(text).split('\n')) {
    const t = line.trim()
    if (!t || !t.startsWith('{')) continue
    let o
    try { o = JSON.parse(t) } catch { continue }
    const host = o.host || o.input || hostOfUrl(o.url || '')
    if (!host) continue
    const url = o.url || ''
    const attrs = {
      port: o.port !== undefined ? String(o.port) : '',
      title: o.title || '',
      webserver: o.webserver || '',
      status: o.status_code !== undefined ? o.status_code : '',
      tech: Array.isArray(o.tech) ? o.tech : [],
    }
    const key = `${host}`
    if (!seen.has(key)) { assets.push({ host, type: 'web', source: ctx.source, attrs }); seen.add(key) }
    if (url) endpoints.push({ host, method: 'GET', path: pathOfUrl(url), status: String(o.status_code || ''), source: ctx.source })
  }
  return { assets, endpoints, findings: [] }
}

// nuclei -jsonl：template-id/severity/matched-at → findings（经规则层）
function parseJsonlNuclei(text, ctx) {
  const findings = []
  for (const line of String(text).split('\n')) {
    const t = line.trim()
    if (!t || !t.startsWith('{')) continue
    let o
    try { o = JSON.parse(t) } catch { continue }
    const info = o.info || {}
    const matched = o['matched-at'] || ''
    const host = o.host || hostOfUrl(matched)
    if (!host) continue
    const rec = {
      title: info.name || o['template-id'] || 'nuclei finding',
      severity: normSev(info.severity),
      host,
      url: matched,
      template_id: o['template-id'] || '',
      evidence: `run_id:${ctx.runId} template:${o['template-id'] || ''}`,
    }
    if (!passesRuleLayer('nuclei', rec)) continue
    findings.push({ title: rec.title, severity: rec.severity, host: rec.host, url: rec.url, evidence: rec.evidence })
  }
  return { assets: [], endpoints: [], findings }
}

// subfinder/naabu/katana 等（lines）：逐行 host/URL → assets/endpoints（复用 ingestText 能力）
function parseLines(text, ctx) {
  const r = db.ingestText(ctx.source, text)
  return { assets: r.assets, endpoints: r.endpoints, findings: [] }
}

// ffuf -of csv：命中路径 → endpoints
function parseCsvFfuf(text, ctx) {
  const endpoints = []
  const lines = String(text).split('\n')
  let host = ''
  // ffuf csv 首行为表头（忽略），后续行含 url 列
  for (const line of lines) {
    const t = line.trim()
    if (!t) continue
    const m = t.match(/https?:\/\/[^\s,"]+/i)
    if (m) {
      const h = hostOfUrl(m[0])
      if (h) { host = h; endpoints.push({ host: h, method: 'GET', path: pathOfUrl(m[0]), status: '', source: ctx.source }) }
    }
  }
  return { assets: host ? [{ host, type: 'web', source: ctx.source }] : [], endpoints, findings: [] }
}

// ---------- 注册表与分发 ----------

const PARSERS = {
  jsonl_httpx: parseJsonlHttpx,
  jsonl_nuclei: parseJsonlNuclei,
  lines: parseLines,
  csv_ffuf: parseCsvFfuf,
}

export function applyParsedResult(manifest, toolName, runId, text, programId = null, sessionId = null) {
  const source = `${toolName}:${runId}`
  const ctx = { tool: toolName, runId, source, programId }
  const parserKey = String(manifest.parser || '')

  // 1) 精确匹配 <parser>_<tool>
  let fn = PARSERS[`${parserKey}_${toolName}`]
  // 2) 通用匹配 <parser>
  if (!fn) fn = PARSERS[parserKey]
  // 3) 回退：通用 regex 抽取
  if (!fn) {
    const r = db.ingestText(source, text)
    return r
  }

  let parsed
  try {
    parsed = fn(String(text), ctx) || {}
  } catch {
    parsed = { assets: [], endpoints: [], findings: [] }
  }

  let assets = 0
  let endpoints = 0
  let findings = 0
  for (const a of parsed.assets || []) if (a && a.host && db.upsertAsset({ ...a, program_id: programId })) assets++
  for (const e of parsed.endpoints || []) if (e && e.host && db.upsertEndpoint({ ...e, program_id: programId })) endpoints++
  for (const f of parsed.findings || []) {
    if (!f || !f.title || !f.host) continue
    const r = db.addFinding({ title: f.title, severity: f.severity || 'info', host: f.host, url: f.url || '', evidence: f.evidence || '', source, program_id: programId, session_id: sessionId })
    if (r && !r.dup) findings++
  }
  return { assets, endpoints, findings }
}
