// ==============================================================================
// @silksec/sec-domain-report — SilkSecAgent report 域插件（v5 Phase 2.7：报告与提交稿的生成/索引/检索）
//
// 契约：doc/secagent/v5/12-report.md（域设计，权威）+ 01-bus.md（总线）+ 00-conventions.md（宪法）
//
// 对外（cordis）：name='sec-domain-report'，apply() 把 manifest+handlers+backend 交给
// 总线 registry.register()（不 provide 任何业务方法——防绕过核心承诺）。
//
// 语义要点：
//  - owns data/reports/ 全树（含 submissions/）+ reports 索引表（vuln 域不 own 任何报告文件）；
//  - 报告产物不可变（built 即终态，无 update/删除动词）；frontmatter 是权威元数据、索引是可重建加速层；
//  - 报告只列信号面（noise=0），噪声仅计数；候选先 vuln_confirm 再进报告；
//  - 提交草稿仅针对 status ∈ {confirmed, submitted} 的信号面 finding（INV-R6）；
//  - 跨域读（vuln_list/vuln_get/vuln_stats/vuln_dedup_check/scope_program_list）经 QueryGateway；
//  - 发布 report.built / report.draft.generated（当前零订阅者）。
//
// R3 冲突裁决（2026-09-10）：12-report §1.3.1 的 report_build 过滤参数原名 `status`，与总线
// R3 lint「命令 schema 顶层禁 status/to/state（状态机私有）」冲突（查询谓词才豁免）。裁决更名
// `status_filter`——语义不变（信号面 status 过滤），仅参数名规避状态机私有命名。见 PROGRESS.md 节点备注。
// ==============================================================================

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

export const name = 'sec-domain-report'
export const version = '1.0.0'

const DEFAULT_DATA_DIR = process.env.SEC_DATA_DIR || '/opt/silkspool/dsh/data'

const log = (msg) => { try { process.stderr.write(`[sec-domain-report] ${msg}\n`) } catch { /* noop */ } }

const backendSqliteUrl = new URL('../sec-backend-report-sqlite/index.js', import.meta.url)
const backendFileUrl = new URL('../sec-backend-report-file/index.js', import.meta.url)
const { createReportSqliteBackend } = await import(backendSqliteUrl.href)
const { createReportFileBackend } = await import(backendFileUrl.href)

const SEVERITY = ['critical', 'high', 'medium', 'low', 'info']
const STATUS_ENUM = ['', 'confirmed', 'false_positive', 'submitted', 'accepted', 'dup', 'ignored']
const SEV_ORDER = ['critical', 'high', 'medium', 'low', 'info']
const REPORT_ROW_LIMIT = 10000

function sha1(str) { return crypto.createHash('sha1').update(String(str)).digest('hex') }

// ---------------------------------------------------------------------------
// 时间口径（北京时间）
// ---------------------------------------------------------------------------

function beijingDate(ts = Date.now()) { return new Date(ts + 8 * 3600_000).toISOString().slice(0, 10) }
function beijingCompactDate(ts = Date.now()) { return beijingDate(ts).replace(/-/g, '') }
function beijingStamp(ts = Date.now()) {
  const d = new Date(ts + 8 * 3600_000)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}`
}

// ---------------------------------------------------------------------------
// frontmatter（权威元数据源；序列化 / 解析）
// ---------------------------------------------------------------------------

function buildFrontmatter(fm) {
  return [
    '---',
    `report_id: ${fm.report_id}`,
    `kind: ${fm.kind}`,
    `program: ${fm.program}`,
    `title: ${fm.title}`,
    `generated_at: ${fm.generated_at}`,
    `date: ${fm.date}`,
    `filters: ${JSON.stringify(fm.filters || {})}`,
    `counts: ${JSON.stringify(fm.counts || {})}`,
    `actor: ${fm.actor}`,
    `session_id: ${fm.session_id || ''}`,
    '---',
  ].join('\n')
}

function parseFrontmatter(content) {
  if (!content || !content.startsWith('---')) return null
  const end = content.indexOf('\n---', 3)
  if (end < 0) return null
  const block = content.slice(3, end)
  const out = {}
  for (const raw of block.split('\n')) {
    const idx = raw.indexOf(':')
    if (idx < 0) continue
    const k = raw.slice(0, idx).trim()
    let v = raw.slice(idx + 1).trim()
    if (k === 'filters' || k === 'counts') { try { v = JSON.parse(v) } catch { v = null } }
    out[k] = v
  }
  return out
}

// ---------------------------------------------------------------------------
// 报告渲染（v4 buildReport 逻辑照抄：分节 / 表格 / meta）
// ---------------------------------------------------------------------------

function tableOf(rows) {
  return [
    `| # | 级别 | 状态 | 类型 | 标题 | 目标 | 证据 |`,
    `|---|---|---|---|---|---|---|`,
    ...rows.map((r) => `| ${r.id} | ${r.severity || 'info'} | ${r.status} | ${r.vuln_type || '—'} | ${String(r.title || '').replace(/\|/g, '\\|')} | ${r.url || r.host || ''} | ${String(r.evidence || '').split('\n')[0].slice(0, 80).replace(/\|/g, '\\|')} |`),
  ]
}

function renderReportMd(rows, opts) {
  const { hostLike, programId, sinceDays, status, severity, source, noiseFiltered } = opts
  const bySev = {}
  for (const r of rows) bySev[r.severity || 'info'] = (bySev[r.severity || 'info'] || 0) + 1
  const meta = [
    `- 生成时间: ${new Date().toISOString()}`,
    `- 范围: ${hostLike || '全部'}${sinceDays ? `（近 ${sinceDays} 天）` : ''}`,
    `- 项目: ${programId || '全部'}${source ? ` · 来源 ${source}` : ''}${status ? ` · 状态 ${status}` : ''}${severity ? ` · 级别 ${severity}` : ''}`,
    `- 合计: ${rows.length} 个发现（${Object.entries(bySev).map(([k, v]) => `${k}:${v}`).join(' / ') || '无'}）`,
    `- 噪声: ${noiseFiltered} 条 info 级模板指纹已闸门过滤（不计入合计）`,
  ]
  const sections = []
  const byProgram = {}
  for (const r of rows) { const k = r.program_id || '未归属项目'; (byProgram[k] = byProgram[k] || []).push(r) }
  const progKeys = Object.keys(byProgram)
  if (progKeys.length > 1 || (progKeys.length === 1 && progKeys[0] !== '未归属项目')) {
    for (const k of progKeys) sections.push({ title: `## ${k}（${byProgram[k].length}）`, rows: byProgram[k] })
  } else {
    const byS = {}
    for (const r of rows) { const k = r.severity || 'info'; (byS[k] = byS[k] || []).push(r) }
    for (const k of [...SEV_ORDER, ...Object.keys(byS).filter((x) => !SEV_ORDER.includes(x))]) {
      if (byS[k]) sections.push({ title: `## ${k.toUpperCase()}（${byS[k].length}）`, rows: byS[k] })
    }
    if (!sections.length) sections.push({ title: '## 无发现', rows: [] })
  }
  const md = [
    `# SilkSecAgent 漏洞报告`,
    ``,
    ...meta,
    ``,
    ...sections.flatMap((s) => [s.title, ``, ...tableOf(s.rows), ``]),
  ].join('\n')
  return { md, bySev, sections: sections.map((s) => ({ title: s.title, rows: s.rows.length })) }
}

// ---------------------------------------------------------------------------
// manifest（12-report §1.2/§1.3/§1.4/§1.5 的机器形态）
// ---------------------------------------------------------------------------

const schema = (properties, required, extra = {}) => ({ type: 'object', properties, required, additionalProperties: false, ...extra })
const str = (opts = {}) => ({ type: 'string', ...opts })
const en = (values, extra = {}) => ({ type: 'string', enum: values, ...extra })
const int = (opts = {}) => ({ type: 'integer', ...opts })
const bool = (opts = {}) => ({ type: 'boolean', ...opts })

export const REPORT_MANIFEST = {
  domain: 'report',
  version: 1,
  service: 'secDomain.report',
  description: '报告导出与提交稿：按筛选生成漏洞报告 md + SRC 提交草稿（frontmatter 权威 + reports 索引加速），列表/全文检索。',
  owns: {
    tables: ['reports'],
    files: ['data/reports/', 'data/events/report.jsonl'],
  },
  commands: {
    report_build: {
      actor: ['model', 'dashboard', 'human'],
      schema: schema({
        host_like: str({ maxLength: 200 }),
        program_id: str(),
        since_days: int({ minimum: 0, maximum: 3650 }),
        status_filter: en(STATUS_ENUM),
        severity: str({ maxLength: 100 }),
        source: str({ maxLength: 64 }),
      }, []),
      idempotent: 'auto',
      idempotent_fields: ['host_like', 'program_id', 'since_days', 'status_filter', 'severity', 'source'],
      events: ['report.built'],
      event_limit: 1,
      invariants: ['programExists'],
      timeout_ms: 60000,
      agent_note: '按筛选生成漏洞报告（markdown）落盘 data/reports/ 并登记索引：按项目分节（无项目按严重级分组）+ 明细表。severity 逗号多选（如 high,critical）/source/status_filter/host_like/program_id/近 N 天筛选。报告只列信号（noise=0），噪声仅计数；候选先 vuln_confirm。提交 SRC 前必须人工逐条核实。',
      deprecated: false,
    },
    report_draft_submission: {
      actor: ['model', 'dashboard', 'human'],
      schema: schema({
        finding_id: int(),
        platform: str({ maxLength: 64 }),
        regenerate: bool(),
      }, ['finding_id']),
      idempotent: 'auto',
      idempotent_fields: ['finding_id', 'platform', 'regenerate'],
      events: ['report.draft.generated'],
      event_limit: 1,
      invariants: ['draftTargetValid'],
      timeout_ms: 60000,
      agent_note: 'SRC 提交半自动：按 finding 生成平台提交草稿（复现步骤/影响/证据/修复建议）+ 同目标同类型查重，落盘 data/reports/submissions/。仅信号面 finding 且 status=confirmed/submitted 可生成；查重结果提交前必看；提交成功后用 vuln_submit 回流。regenerate=true 刷新内容。',
      deprecated: false,
    },
  },
  queries: {
    report_list: {
      actor: ['model', 'dashboard', 'human'],
      params: schema({
        program: str(),
        q: str(),
        kind: en(['', 'report', 'submission_draft']),
        date_from: str(),
        date_to: str(),
        limit: int({ minimum: 1, maximum: 500 }),
        offset: int({ minimum: 0 }),
        sort: en(['generated_at', 'program', 'total']),
        dir: en(['asc', 'desc']),
      }, []),
      agent_note: '报告列表查询：按项目/关键字/日期/类型（report|submission_draft）筛选，返回元数据（program/日期/级别分布/总数），不读正文。',
    },
    report_read: {
      actor: ['model', 'dashboard', 'human'],
      params: schema({
        file: str({ minLength: 1 }),
      }, ['file']),
      agent_note: '读单份报告全文：file 为 report_list 返回的相对路径；>300KB 截断。',
    },
  },
  events: {
    'report.built': { payload: { type: 'object' }, redact: [] },
    'report.draft.generated': { payload: { type: 'object' }, redact: [] },
  },
  subscribes: {},
  backend: 'repository-v1',
}

// ---------------------------------------------------------------------------
// handlers
// ---------------------------------------------------------------------------

function makeHandlers(opts) {
  const dispatchRef = opts.dispatch
  const queryRef = opts.query
  const dataDir = opts.dataDir || DEFAULT_DATA_DIR

  function throwErr(code, message, hint, retryable = false) {
    throw Object.assign(new Error(message), { code, hint, retryable })
  }

  // 分页拉取信号面 findings（经 QueryGateway 调 vuln_list，page 500 循环至 total）
  async function fetchSignalFindings({ programId, status }, ctxActor) {
    const rows = []
    const pageSize = 500
    let offset = 0
    while (true) {
      const res = await queryRef('vuln', 'list', {
        visibility: 'signal', program_id: programId || '', status: status || '', limit: pageSize, offset,
      }, { actor: ctxActor })
      if (!res || !res.ok) throwErr('E_BACKEND_UNAVAILABLE', 'vuln_list 跨域查询失败', '检查 vuln 域注册与 sqlite 可达', true)
      const batch = res.rows || []
      rows.push(...batch)
      const total = Number(res.total) || 0
      if (batch.length < pageSize || rows.length >= total) break
      offset += pageSize
    }
    return rows
  }

  async function fetchNoiseCount(ctxActor) {
    try {
      const st = await queryRef('vuln', 'stats', {}, { actor: ctxActor })
      if (st && st.ok && st.data) {
        return (Number(st.data.candidate?.pending) || 0) + (Number(st.data.terminal_in_pool) || 0)
      }
    } catch { /* 噪声计数失败不阻断报告 */ }
    return 0
  }

  // 文件名去重（同分钟同名不同内容 → -2/-3 序号；同内容 → 复用）
  function pickFile(repo, baseName, content) {
    const stat = repo.statReportFile(baseName)
    if (!stat || !stat.exists) return { file: baseName, suffix: '' }
    if (stat.sha === sha1(content)) return { file: baseName, suffix: '' }
    const m = baseName.match(/^(.*)\.md$/)
    const base = m[1]
    for (let i = 2; ; i++) {
      const candidate = `${base}-${i}.md`
      const s2 = repo.statReportFile(candidate)
      if (!s2 || !s2.exists) return { file: candidate, suffix: `-${i}` }
      if (s2.sha === sha1(content)) return { file: candidate, suffix: `-${i}` }
    }
  }

  const invariants = {
    programExists: async (args, repo, ctx) => {
      const pid = String(args.program_id || '')
      if (!pid) return null
      try {
        const r = await queryRef('scope', 'program_list', { status: '' }, { actor: ctx.actor || 'system' })
        if (r && r.ok && Array.isArray(r.rows)) {
          const found = r.rows.some((row) => String(row.id) === pid)
          if (!found) return { code: 'E_NOT_FOUND', message: `program 不存在: ${pid}`, hint: '先查 scope_program_list', retryable: false }
        }
      } catch { /* scope 域不可达 → 软校验降级放行 */ }
      return null
    },
    draftTargetValid: async (args, repo, ctx) => {
      let f = null
      try {
        const r = await queryRef('vuln', 'get', { id: args.finding_id }, { actor: ctx.actor || 'system' })
        if (r && r.ok && r.data) f = r.data
      } catch { /* 落到 E_NOT_FOUND */ }
      if (!f) return { code: 'E_NOT_FOUND', message: `finding #${args.finding_id} 不存在`, hint: '先 vuln_list 核对 id', retryable: false }
      if (f.noise === 1) return { code: 'E_REPORT_NOT_SIGNAL', message: `finding #${args.finding_id} 是候选（noise=1）`, hint: '候选不生成提交草稿——先补全证据并 vuln_confirm，或 vuln_reject 出池', retryable: false }
      if (!['confirmed', 'submitted'].includes(f.status)) return { code: 'E_INVARIANT', message: `finding #${args.finding_id} 状态 ${f.status} 不可生成草稿`, hint: '提交草稿只针对已确认发现。先完成验证规程并 vuln_confirm 附证据', retryable: false }
      return null
    },
  }

  const commands = {
    report_build: async (args, repo, ctx) => {
      const ctxActor = ctx.actor || 'system'
      const hostLike = String(args.host_like || '')
      const programId = String(args.program_id || '')
      const status = String(args.status_filter || '')
      const severity = String(args.severity || '')
      const source = String(args.source || '')
      const sinceDays = Number(args.since_days) || 0

      const findings = await fetchSignalFindings({ programId, status }, ctxActor)
      const sevSet = severity ? new Set(severity.split(',').map((s) => s.trim()).filter(Boolean)) : null
      const sinceCutoff = sinceDays > 0 ? Date.now() - sinceDays * 86400000 : null
      const filtered = findings.filter((r) => {
        if (hostLike && !(String(r.host || '').toLowerCase().includes(hostLike.toLowerCase()) || String(r.url || '').toLowerCase().includes(hostLike.toLowerCase()))) return false
        if (sevSet && sevSet.size && !sevSet.has(r.severity || 'info')) return false
        if (source && r.source !== source) return false
        if (sinceCutoff && (Number(r.created_at) || 0) < sinceCutoff) return false
        return true
      })
      if (filtered.length > REPORT_ROW_LIMIT) {
        throwErr('E_REPORT_SOURCE_OVERFLOW', `匹配行数 ${filtered.length} 超上限 ${REPORT_ROW_LIMIT}`, '发现数超上限，请按 program_id 或 severity 拆分构建', false)
      }
      const noiseFiltered = await fetchNoiseCount(ctxActor)

      const { md, bySev, sections } = renderReportMd(filtered, { hostLike, programId, sinceDays, status, severity, source, noiseFiltered })

      const nameTag = programId
        ? String(programId).replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'all'
        : 'all'
      const stamp = beijingStamp()
      const baseName = `report-${nameTag}-${stamp}.md`
      const { file: fileName, suffix } = pickFile(repo, baseName, md)
      const reportId = `rpt_report_${stamp}${suffix}`
      const generatedAt = Date.now()
      const date = beijingDate(generatedAt)
      const actor = ctx.actor || 'model'

      const filters = { host_like: hostLike, program_id: programId, since_days: sinceDays, status: status, severity, source }
      const counts = { total: filtered.length, by_severity: bySev, noise_filtered: noiseFiltered }
      const fm = buildFrontmatter({
        report_id: reportId, kind: 'report', program: programId || '', title: 'SilkSecAgent 漏洞报告',
        generated_at: generatedAt, date, filters, counts, actor, session_id: ctx.session_id || '',
      })
      const content = `${fm}\n${md}`

      const w = repo.writeReportFileAtomic(fileName, content)
      if (!w || !w.ok) throwErr(w?.error || 'E_BACKEND_UNAVAILABLE', `报告落盘失败: ${fileName}`, '检查 SEC_DATA_DIR 与磁盘', true)
      repo.insertReportRow({
        report_id: reportId, kind: 'report', file: fileName, program: programId || '', title: 'SilkSecAgent 漏洞报告',
        generated_at: generatedAt, date, filters: JSON.stringify(filters), total: filtered.length,
        by_severity: JSON.stringify(bySev), noise_filtered: noiseFiltered, actor, session_id: ctx.session_id || '',
        content_sha: sha1(content),
      })

      return {
        data: {
          report_id: reportId, file: fileName, kind: 'report', total: filtered.length,
          by_severity: bySev, noise_filtered: noiseFiltered, sections, filters,
          hint: '报告已落盘，提交 SRC 前必须人工逐条核实',
        },
        events: [{
          name: 'report.built',
          payload: { report_id: reportId, file: fileName, program: programId || '', total: filtered.length, by_severity: bySev, filters, actor },
        }],
        before: null,
        after: { report_id: reportId, file: fileName, total: filtered.length },
        target: { program_id: programId || null },
      }
    },

    report_draft_submission: async (args, repo, ctx) => {
      const ctxActor = ctx.actor || 'system'
      const findingId = Number(args.finding_id)
      const platform = String(args.platform || '')
      const regenerate = !!args.regenerate
      const generatedAt = Date.now()
      const date = beijingDate(generatedAt)
      const dateCompact = beijingCompactDate(generatedAt)

      const fr = await queryRef('vuln', 'get', { id: findingId }, { actor: ctxActor })
      if (!fr || !fr.ok || !fr.data) throwErr('E_NOT_FOUND', `finding #${findingId} 不存在`, '先 vuln_list 核对 id', false)
      const f = fr.data

      const dupRes = await queryRef('vuln', 'dedup_check', {
        host: f.host || '', vuln_type: f.vuln_type || '', exclude_id: findingId, limit: 10,
      }, { actor: ctxActor })
      const dupCandidates = (dupRes && dupRes.ok && Array.isArray(dupRes.rows)) ? dupRes.rows.map((x) => ({
        id: x.id, title: x.title || '', severity: x.severity || '', status: x.status || '', host: x.host || '',
      })) : []

      const fileName = `submissions/draft-finding-${findingId}-${date}.md`
      const reportId = `rpt_submission_draft_finding_${findingId}_${dateCompact}`

      // 同日幂等命中：无 regenerate 且已有草稿 → 返回现有（不重写）
      if (!regenerate) {
        const existing = repo.getReportRowByFile(fileName)
        if (existing && repo.statReportFile(fileName)?.exists) {
          return {
            data: {
              report_id: existing.report_id, file: fileName, kind: 'submission_draft', finding_id: findingId,
              dup_candidates: dupCandidates, hint: '人工审校后提交；提交成功用 vuln_submit 回流状态',
            },
            events: [], replay: true,
            target: { finding_id: findingId },
          }
        }
      }

      const sevName = { critical: '严重', high: '高危', medium: '中危', low: '低危', info: '信息' }[f.severity] || f.severity
      const md = [
        `# 漏洞提交草稿（finding #${f.id}，人工审校后提交）`,
        '',
        `- 平台: ${platform || '（按目标 SRC 平台填写）'}`,
        `- 漏洞类型: ${f.vuln_type || '（回填 vuln_type）'}${f.cwe ? ` / ${f.cwe}` : ''}`,
        `- 等级自评: ${sevName}`,
        `- 目标: ${f.url || f.host || ''}`,
        '',
        '## 漏洞描述',
        f.title,
        f.impact ? `\n**影响**: ${f.impact}` : '',
        '',
        '## 复现步骤',
        f.reproduction_steps || '（补全：1. … 2. … 3. …，每步附请求/响应关键片段）',
        f.preconditions ? `\n**前置条件**: ${f.preconditions}` : '',
        '',
        '## 证据',
        '```',
        String(f.evidence || '').slice(0, 2000),
        '```',
        f.endpoint_ref ? `\n关联接口: ${f.endpoint_ref}` : '',
        '',
        '## 修复建议',
        f.recommendation || '（补全修复建议）',
        '',
        '## 提交前查重结果',
        dupCandidates.length ? dupCandidates.map((x) => `- #${x.id} [${x.severity}] ${x.title}（${x.host}，status=${x.status}）`).join('\n') : '- 无同目标/同类型历史记录',
        '',
        '---',
        `数据指针：finding #${f.id} · session ${f.session_id || '—'} · source ${f.source || '—'} · ${new Date().toISOString()}`,
      ].join('\n')

      const fm = buildFrontmatter({
        report_id: reportId, kind: 'submission_draft', program: f.program_id || '', title: `漏洞提交草稿 finding #${f.id}`,
        generated_at: generatedAt, date,
        filters: { finding_id: findingId, platform, regenerate },
        counts: { total: 1, by_severity: { [f.severity || 'info']: 1 }, noise_filtered: 0 },
        actor: ctx.actor || 'model', session_id: ctx.session_id || '',
      })
      const content = `${fm}\n${md}`

      const w = repo.writeReportFileAtomic(fileName, content)
      if (!w || !w.ok) throwErr(w?.error || 'E_BACKEND_UNAVAILABLE', `草稿落盘失败: ${fileName}`, '检查 SEC_DATA_DIR 与磁盘', true)
      repo.insertReportRow({
        report_id: reportId, kind: 'submission_draft', file: fileName, program: f.program_id || '', title: `漏洞提交草稿 finding #${f.id}`,
        generated_at: generatedAt, date, filters: JSON.stringify({ finding_id: findingId, platform, regenerate }),
        total: 1, by_severity: JSON.stringify({ [f.severity || 'info']: 1 }), noise_filtered: 0,
        actor: ctx.actor || 'model', session_id: ctx.session_id || '', content_sha: sha1(content),
      })

      return {
        data: {
          report_id: reportId, file: fileName, kind: 'submission_draft', finding_id: findingId,
          dup_candidates: dupCandidates, hint: '人工审校后提交；提交成功用 vuln_submit 回流状态',
        },
        events: [{
          name: 'report.draft.generated',
          payload: { report_id: reportId, file: fileName, finding_id: findingId, dup_candidates_count: dupCandidates.length, actor: ctx.actor || 'model' },
        }],
        before: null,
        after: { report_id: reportId, file: fileName },
        target: { finding_id: findingId },
      }
    },
  }

  // 惰性 heal（12-report §2.5）：索引有行无文件 → 删行；文件在无索引 → 读 frontmatter 补行
  function healIndex(repo) {
    for (const row of repo.allReportRows()) {
      const stat = repo.statReportFile(row.file)
      if (!stat || !stat.exists) {
        repo.deleteReportRow(row.report_id)
        continue
      }
    }
    for (const rel of repo.listReportFiles()) {
      if (repo.getReportRowByFile(rel)) continue
      const content = repo.readReportFile(rel)
      const fm = content ? parseFrontmatter(content) : null
      if (!fm) continue
      repo.insertReportRow({
        report_id: String(fm.report_id || `rpt_backfill_${sha1(rel)}`),
        kind: fm.kind || 'report',
        file: rel,
        program: fm.program || '',
        title: fm.title || '',
        generated_at: Number(fm.generated_at) || 0,
        date: fm.date || '',
        filters: fm.filters ? JSON.stringify(fm.filters) : null,
        total: (fm.counts && Number(fm.counts.total)) || 0,
        by_severity: (fm.counts && fm.counts.by_severity) ? JSON.stringify(fm.counts.by_severity) : null,
        noise_filtered: (fm.counts && Number(fm.counts.noise_filtered)) || 0,
        actor: fm.actor || '',
        session_id: fm.session_id || '',
        content_sha: sha1(content),
      })
    }
  }

  const queries = {
    report_list: async (args, repo) => {
      healIndex(repo)
      const program = String(args.program || '')
      const programFilter = program === 'all' ? '' : program
      const kind = String(args.kind || '')
      const q = String(args.q || '')
      const dateFrom = String(args.date_from || '')
      const dateTo = String(args.date_to || '')
      const sort = args.sort || 'generated_at'
      const dir = args.dir || (sort === 'generated_at' ? 'desc' : 'asc')

      const { rows, total } = repo.listReportRows({
        program: programFilter, kind, q, date_from: dateFrom, date_to: dateTo, sort, dir,
      })
      const out = rows.map((r) => ({
        report_id: r.report_id, kind: r.kind, file: r.file, program: r.program || '', title: r.title || '',
        date: r.date, total: Number(r.total) || 0,
        by_severity: (() => { try { return JSON.parse(r.by_severity || '{}') } catch { return {} } })(),
        noise_filtered: Number(r.noise_filtered) || 0, actor: r.actor || '', generated_at: r.generated_at,
      }))
      return { rows: out, total }
    },
    report_read: async (args, repo) => {
      const rel = String(args.file || '').trim()
      const abs = repo.resolveSafe(rel)
      if (!abs) throwErr('E_SCHEMA', `非法路径: ${rel}`, 'file 必须为 report_list 返回的相对路径（data/reports/ 前缀内 + .md 后缀）', false)
      const content = repo.readReportFile(rel)
      if (content === null) throwErr('E_NOT_FOUND', `报告文件不存在: ${rel}`, '先 report_list 核对文件名', false)
      const MAX = 300000
      const truncated = content.length > MAX
      const body = truncated ? content.slice(0, MAX) : content
      return { file: rel, content: body, size: content.length, truncated }
    },
  }

  return { ...commands, queries, invariants, subscribers: {} }
}

// ---------------------------------------------------------------------------
// 组装
// ---------------------------------------------------------------------------

export function buildReportDomain(opts = {}) {
  const dataDir = opts.dataDir || DEFAULT_DATA_DIR
  const sqlite = createReportSqliteBackend(opts.backendOptions || {})
  const file = createReportFileBackend({ dataDir })
  const backend = {
    capabilities: {},
    factory(db) {
      return { ...sqlite.factory(db), ...file.factory() }
    },
  }
  return {
    manifest: REPORT_MANIFEST,
    handlers: makeHandlers({ ...opts, dataDir }),
    backend,
  }
}

export function apply(ctx, config = {}) {
  const dataDir = process.env.SEC_DATA_DIR || process.env.DSH_HOME || DEFAULT_DATA_DIR
  try {
    ctx.inject(['secDomainBus'], (child) => {
      const bus = child.secDomainBus
      const domain = buildReportDomain({
        dataDir,
        dispatch: (d, v, a, c) => bus.dispatch(d, v, a, c),
        query: (d, n, a, c) => bus.query(d, n, a, c),
      })
      const res = bus.registry.register(domain)
      if (res.ok) log(`report 域注册成功（registered=${res.registered}）`)
      else log(`report 域注册被拒：${res.error?.code} ${res.error?.message}`)
      return () => {}
    })
  } catch (e) {
    log(`secDomainBus 注入失败：${e?.message}——report 域未注册（总线必须先行挂载）`)
  }
  return null
}
