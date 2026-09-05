// ==============================================================================
// SilkSecAgent 假阳性消融评测（FP ablation）
// 度量 sec-verification 验证纪律对防误报的实际增益（借鉴 Claude-BugHunter eval：
// 用 oracle 评 skill 增益 + 专门验证防误报纪律是否触发的假阳性 eval）。
// 同一批"伪漏洞形状"判定场景，在 system prompt 含/不含验证纪律两个条件下
// 让 LLM 判定"能否确认此发现"，对比误判率——直接回答 T-14 类问题：
// 知识（验证纪律）消费是否真的改变了判定行为。
//
// 用法: SEC_EVAL_LLM_KEY=<key> node eval-fp.js [case ...]   # case 为用例名，可选过滤
// 报告: <SEC_DATA_DIR>/eval/fp-report.json
// ==============================================================================

import * as fs from 'node:fs'
import * as path from 'node:path'

const BASE = process.env.SEC_BASE_DIR || '/opt/silkspool/dsh'
const DATA_DIR = process.env.SEC_DATA_DIR || path.join(BASE, 'data')
const CASES_FILE = process.env.EVAL_FP_CASES || path.join(BASE, 'eval-fp-cases.jsonl')
const SKILL_FILE = path.join(BASE, 'data/skills/sec-verification/SKILL.md')

// 默认 LLM 网关地址推断依据：
// - Bellkeeper 监听 0.0.0.0:8080（bellkeeper.yaml server.port），keeper 容器端口映射 8090:8080
// - DSH 生产路由 settings.yaml 指向 http://192.168.7.230:8090/api/llm/v1（192.168.7.230 即 keeper）
// 故默认与 DSH 同款（评测跑在 DSH 主机上）；在 keeper 本机跑可
//   SEC_EVAL_LLM_URL=http://localhost:8080/api/llm/v1
const LLM_BASE = (process.env.SEC_EVAL_LLM_URL || 'http://192.168.7.230:8090/api/llm/v1').replace(/\/+$/, '')
const LLM_URL = `${LLM_BASE}/chat/completions`
// 网关鉴权为 Authorization: Bearer（Bellkeeper LLMTokenAuth），key 取 SEC_EVAL_LLM_KEY 或 BELLKEEPER_API_KEY
const LLM_KEY = process.env.SEC_EVAL_LLM_KEY || process.env.BELLKEEPER_API_KEY
const MODEL = process.env.SEC_EVAL_MODEL || 'pool-secagent'

if (!LLM_KEY) {
  console.error('[eval-fp] 缺少 LLM API Key：请设置 SEC_EVAL_LLM_KEY 或 BELLKEEPER_API_KEY')
  process.exit(1)
}

let skillText
try {
  skillText = fs.readFileSync(SKILL_FILE, 'utf8')
} catch (e) {
  console.error(`[eval-fp] 无法读取验证纪律全文（skill=on 条件无法构造）: ${SKILL_FILE}\n${e.message}`)
  process.exit(1)
}

const only = process.argv.slice(2)
const cases = fs.readFileSync(CASES_FILE, 'utf8').split('\n')
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l))
  .filter((c) => only.length === 0 || only.includes(c.name))

if (cases.length === 0) {
  console.error('[eval-fp] 无可用用例')
  process.exit(1)
}

// ------------------------------------------------------------------------------
// 双条件的 system prompt（输出格式要求两条件一致，保证公平）
// ------------------------------------------------------------------------------
const OUTPUT_RULE = '回复第一行必须且只能是 `判定: ACCEPT` 或 `判定: REJECT`（ACCEPT=发现可确认成立；REJECT=不能确认/应打回待人工），随后用中文简述理由。'
const SYSTEM_OFF = `你是安全研究员。请判断以下漏洞发现能否被确认。\n\n${OUTPUT_RULE}`
const SYSTEM_ON = `你是安全研究员。请判断以下漏洞发现能否被确认。\n\n${OUTPUT_RULE}\n\n# 必须遵守的验证纪律\n\n${skillText}`

const CONDITIONS = [
  { id: 'off', label: 'skill=off', system: SYSTEM_OFF },
  { id: 'on', label: 'skill=on', system: SYSTEM_ON },
]

// ------------------------------------------------------------------------------
// LLM 调用（非流式；网络失败/超时/5xx 重试 1 次）
// ------------------------------------------------------------------------------
async function chatOnce(system, user, timeoutMs) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(LLM_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LLM_KEY}` },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        stream: false,
        max_tokens: 1500,
        temperature: 0.2,
      }),
      signal: ctrl.signal,
    })
    const body = await res.text()
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.slice(0, 300)}`)
    const data = JSON.parse(body)
    const content = data.choices?.[0]?.message?.content
    if (typeof content !== 'string' || !content.trim()) throw new Error(`空回复: ${body.slice(0, 300)}`)
    return content
  } finally {
    clearTimeout(timer)
  }
}

async function chatWithRetry(system, user) {
  try {
    return { ok: true, content: await chatOnce(system, user, 120000) }
  } catch (e) {
    process.stdout.write(` 重试(${String(e.message).slice(0, 80)}) ...`)
    try {
      return { ok: true, content: await chatOnce(system, user, 120000) }
    } catch (e2) {
      return { ok: false, error: e2.message }
    }
  }
}

// ------------------------------------------------------------------------------
// 判定解析：第一行 `判定: REJECT/ACCEPT`；失败再在前 200 字内找一次；否则 parse_error
// ------------------------------------------------------------------------------
function parseVerdict(text) {
  const m = text.match(/判定\s*[:：]\s*(ACCEPT|REJECT)/i)
  if (m) return m[1].toUpperCase()
  const m2 = text.slice(0, 200).match(/\b(ACCEPT|REJECT)\b/i)
  if (m2) return m2[1].toUpperCase()
  return 'parse_error'
}

const truncate = (s) => (s && s.length > 500 ? `${s.slice(0, 500)}…[截断，共 ${s.length} 字]` : s || '')

// ------------------------------------------------------------------------------
// 主循环：两条件 × 全部用例
// ------------------------------------------------------------------------------
const condResults = {}
for (const cond of CONDITIONS) {
  console.log(`\n[eval-fp] 条件 ${cond.label}（${cases.length} 用例）`)
  const rows = []
  for (const c of cases) {
    process.stdout.write(`[eval-fp]   ${c.name} 期待 ${c.expected} ... `)
    const started = Date.now()
    const user = `# 待判定发现\n\n${c.scenario}\n\n请给出判定。`
    const r = await chatWithRetry(cond.system, user)
    const row = { name: c.name, rule: c.rule, expected: c.expected, duration_ms: Date.now() - started }
    if (!r.ok) {
      row.verdict = 'error'
      row.error = String(r.error).slice(0, 500)
      row.reply = ''
      console.log(`调用失败 ✗: ${row.error}`)
    } else {
      row.verdict = parseVerdict(r.content)
      row.reply = truncate(r.content)
      const mark = row.verdict === c.expected ? '✓' : '✗'
      console.log(`${row.verdict} ${mark} (${Math.round(row.duration_ms / 1000)}s)`)
    }
    rows.push(row)
  }
  condResults[cond.id] = rows
}

// ------------------------------------------------------------------------------
// 评分：accuracy / 误报率（该拒不拒）/ 漏报率（该收不收）
// ------------------------------------------------------------------------------
function score(rows) {
  const negatives = rows.filter((r) => r.expected === 'REJECT')
  const positives = rows.filter((r) => r.expected === 'ACCEPT')
  const fp = negatives.filter((r) => r.verdict === 'ACCEPT').length // 伪漏洞被确认 = 误报
  const fn = positives.filter((r) => r.verdict === 'REJECT').length // 真漏洞被拒 = 漏报
  const correct = rows.filter((r) => r.verdict === r.expected).length
  const errors = rows.filter((r) => r.verdict === 'error' || r.verdict === 'parse_error').length
  const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : 0)
  return {
    total: rows.length,
    correct,
    accuracy: pct(correct, rows.length),
    reject_cases: negatives.length,
    accept_cases: positives.length,
    false_positives: fp,
    fp_rate: pct(fp, negatives.length),
    false_negatives: fn,
    fn_rate: pct(fn, positives.length),
    errors,
  }
}

const scores = {}
for (const cond of CONDITIONS) scores[cond.id] = score(condResults[cond.id])
const gain = {
  accuracy_delta: Math.round((scores.on.accuracy - scores.off.accuracy) * 10) / 10,
  fp_rate_delta: Math.round((scores.on.fp_rate - scores.off.fp_rate) * 10) / 10,
  fn_rate_delta: Math.round((scores.on.fn_rate - scores.off.fn_rate) * 10) / 10,
}

// ------------------------------------------------------------------------------
// 报告：<DATA_DIR>/eval/fp-report.json + 控制台摘要
// ------------------------------------------------------------------------------
const report = {
  ts: new Date().toISOString(),
  eval: 'fp-ablation',
  purpose: 'sec-verification 验证纪律对防误报的增益（skill=off vs skill=on）',
  model: MODEL,
  llm_url: LLM_URL,
  cases_file: CASES_FILE,
  skill_file: SKILL_FILE,
  scores,
  gain,
  cases: condResults,
}
const outDir = path.join(DATA_DIR, 'eval')
fs.mkdirSync(outDir, { recursive: true })
const outFile = path.join(outDir, 'fp-report.json')
fs.writeFileSync(outFile, JSON.stringify(report, null, 1) + '\n')

console.log('\n[eval-fp] ================= 假阳性消融结果 =================')
console.log(`[eval-fp] 模型: ${MODEL}   用例: ${cases.length}（REJECT ${scores.off.reject_cases} / ACCEPT ${scores.off.accept_cases}）`)
console.log('[eval-fp] 指标                skill=off    skill=on    增益')
console.log(`[eval-fp] accuracy            ${String(scores.off.accuracy).padStart(5)}%     ${String(scores.on.accuracy).padStart(5)}%     ${gain.accuracy_delta >= 0 ? '+' : ''}${gain.accuracy_delta}pp`)
console.log(`[eval-fp] 误报率(该拒不拒)     ${String(scores.off.fp_rate).padStart(5)}%     ${String(scores.on.fp_rate).padStart(5)}%     ${gain.fp_rate_delta >= 0 ? '+' : ''}${gain.fp_rate_delta}pp`)
console.log(`[eval-fp] 漏报率(该收不收)     ${String(scores.off.fn_rate).padStart(5)}%     ${String(scores.on.fn_rate).padStart(5)}%     ${gain.fn_rate_delta >= 0 ? '+' : ''}${gain.fn_rate_delta}pp`)
console.log(`[eval-fp] 解析/调用异常        ${String(scores.off.errors).padStart(5)}      ${String(scores.on.errors).padStart(5)}`)
console.log('[eval-fp] ----------------------------------------------------')
for (const c of cases) {
  const off = condResults.off.find((r) => r.name === c.name)
  const on = condResults.on.find((r) => r.name === c.name)
  const sym = (v, e) => (v === e ? '✓' : v === 'error' || v === 'parse_error' ? '?' : '✗')
  console.log(`[eval-fp]   ${c.name.padEnd(24)} ${c.expected.padEnd(6)} off=${(off.verdict || '?').padEnd(11)}${sym(off.verdict, c.expected)}  on=${(on.verdict || '?').padEnd(11)}${sym(on.verdict, c.expected)}`)
}
console.log(`\n[eval-fp] 报告: ${outFile}`)
process.exit(0)
