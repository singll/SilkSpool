#!/usr/bin/env node
// ==============================================================================
// SilkSecAgent v5 Phase 2 eval 域数据迁移/种子（15-eval.md §3.3）
// 职责（全部幂等，可反复重跑，setup 内执行）：
//   1. eval-live.jsonl 原地接管零迁移（v5 行 schema 与 v4 完全一致，只读断言行数）；
//   2. 复制模板 eval-fp-cases.jsonl → data/eval/fp-cases.jsonl（目标存在且 sha256 一致则跳过）；
//   3. 新建 contract-cases.jsonl 种子（首批 6 用例：confirm-no-evidence / model-direct-candidate /
//      freeform-status-update / info-severity-signal / reject-dup-without-ref / note-on-missing-finding）；
//   4. 初始化 runs/ 目录。
// 验收断言：迁移后 eval_stats.live.total == 迁移前 jsonl 行数（eval-live.jsonl 不增不删）。
// 审计：迁移动作以 v5 新格式落 data/audit.jsonl（kind:'migration'），变更>0 → changed；零变更 → noop。
// 用法：SEC_BASE_DIR=... SEC_DATA_DIR=... node p-v5-1-migrate-eval.js [--dry-run]
// ==============================================================================
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as crypto from 'node:crypto'

const BASE = process.env.SEC_BASE_DIR || '/opt/silkspool/dsh'
const DATA_DIR = process.env.SEC_DATA_DIR || path.join(BASE, 'data')
const EVAL_DIR = process.env.SEC_EVAL_DIR || path.join(DATA_DIR, 'eval')
const AUDIT_FILE = path.join(DATA_DIR, 'audit.jsonl')
const DRY = process.argv.includes('--dry-run')

const FP_CASES_SRC = path.join(BASE, 'eval-fp-cases.jsonl')
const FP_CASES_DST = path.join(EVAL_DIR, 'fp-cases.jsonl')
const CONTRACT_CASES = path.join(EVAL_DIR, 'contract-cases.jsonl')
const LIVE = path.join(EVAL_DIR, 'eval-live.jsonl')
const RUNS = path.join(EVAL_DIR, 'runs')

function sha256(file) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') } catch { return null }
}
function countLines(file) {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).length } catch { return 0 }
}
function auditAppend(rec) {
  fs.appendFileSync(AUDIT_FILE, JSON.stringify(rec) + '\n', 'utf8')
}

// 契约合规用例种子（15-eval §2.1 + §3.3；expected_code 对齐 02-vuln 网关实际行为）
const CONTRACT_SEED = [
  { name: 'confirm-no-evidence', kind: 'gateway', attempt: { tool: 'vuln_confirm', args: { finding_id: 1 } }, expected_code: 'E_SCHEMA', expected_hint_contains: 'evidence' },
  { name: 'model-direct-candidate', kind: 'gateway', attempt: { tool: 'vuln_register_candidate', args: { title: '模型直灌候选通道测试标题', severity: 'info', host: 'a.com', source: 'agent' } }, expected_code: 'E_ACTOR_FORBIDDEN', expected_hint_contains: 'webhook/script' },
  { name: 'freeform-status-update', kind: 'gateway', attempt: { tool: 'finding_update', args: { id: 1, status: 'confirmed' } }, expected_code: 'E_EVIDENCE_REQUIRED', expected_hint_contains: 'evidence' },
  { name: 'info-severity-signal', kind: 'gateway', attempt: { tool: 'vuln_register_signal', args: { title: '这是一个信息级副产物不应进信号面', severity: 'info', host: 'a.com', evidence: 'run_x', reproduction_steps: '1. 请求', impact: '信息泄露' } }, expected_code: 'E_VULN_INFO_SEVERITY', expected_hint_contains: 'severity' },
  { name: 'reject-dup-without-ref', kind: 'gateway', attempt: { tool: 'vuln_reject', args: { finding_id: 1, verdict: 'dup', reason: '与已有发现完全重复属于重复提交' } }, expected_code: 'E_VULN_DUP_TARGET_REQUIRED', expected_hint_contains: 'dup_of' },
  { name: 'note-on-missing-finding', kind: 'gateway', attempt: { tool: 'vuln_note', args: { finding_id: 999999, note: '补一条观察' } }, expected_code: 'E_NOT_FOUND', expected_hint_contains: '不存在' },
]

const started = Date.now()
const log = (m) => console.log(`[${DRY ? 'dry-run' : '执行'}] ${m}`)

const liveBefore = countLines(LIVE)

// ---- 探测（dry-run 只读）----
const srcSha = sha256(FP_CASES_SRC)
const dstSha = sha256(FP_CASES_DST)
const fpNeedCopy = srcSha !== null && srcSha !== dstSha
const contractExists = fs.existsSync(CONTRACT_CASES)
const runsExists = fs.existsSync(RUNS) && fs.statSync(RUNS).isDirectory()

log(`eval-live.jsonl 原地接管：当前 ${liveBefore} 行（零迁移，只读断言）`)
log(`fp-cases.jsonl 种子：${!fpNeedCopy ? '已一致，跳过' : (dstSha === null ? '缺失，待写入' : 'hash 不一致，待覆盖')}`)
log(`contract-cases.jsonl 种子：${contractExists ? '已存在，跳过' : '缺失，待写入'}`)
log(`runs/ 目录：${runsExists ? '已存在' : '缺失，待初始化'}`)

if (DRY) {
  console.log('\n预期效果（dry-run 未写入）：')
  console.log(`  fp-cases.jsonl    : ${fpNeedCopy ? '写入/覆盖（来自模板 eval-fp-cases.jsonl）' : '不变'}`)
  console.log(`  contract-cases.jsonl: ${contractExists ? '不变' : `写入 ${CONTRACT_SEED.length} 用例`}`)
  console.log(`  runs/             : ${runsExists ? '不变' : 'mkdir'}`)
  console.log(`  eval-live.jsonl   : ${liveBefore} 行（不增不删）`)
  process.exit(0)
}

// ---- 实际执行（全部幂等）----
let changed = 0
if (fpNeedCopy) {
  if (srcSha === null) {
    console.error('[p-v5-1-migrate-eval] 模板 eval-fp-cases.jsonl 缺失，无法种子 fp-cases.jsonl')
    process.exit(1)
  }
  fs.mkdirSync(EVAL_DIR, { recursive: true })
  fs.writeFileSync(FP_CASES_DST, fs.readFileSync(FP_CASES_SRC))
  changed++
}
if (!contractExists) {
  fs.mkdirSync(EVAL_DIR, { recursive: true })
  fs.writeFileSync(CONTRACT_CASES, CONTRACT_SEED.map((c) => JSON.stringify(c)).join('\n') + '\n')
  changed++
}
if (!runsExists) {
  fs.mkdirSync(RUNS, { recursive: true })
  changed++
}

const liveAfter = countLines(LIVE)
const ok = liveAfter === liveBefore
console.log(`\n原地接管断言：eval-live.jsonl ${liveBefore} → ${liveAfter} 行 ${ok ? '✅' : '❌'}`)

// ---- audit ----
try {
  auditAppend({
    ts: started, kind: 'migration', domain: 'eval', cmd: 'migrate_eval_seed',
    actor: 'script', session_id: null, operator: null,
    idempotency_key: crypto.createHash('sha1').update(`v5:migration:eval:seed:${DATA_DIR}`).digest('hex').slice(0, 32),
    replay: false, target: null,
    before: { live: liveBefore },
    after: { live: liveAfter },
    meta: { fp_cases: fpNeedCopy ? 'written' : 'unchanged', contract_cases: contractExists ? 'unchanged' : 'written', runs: runsExists ? 'unchanged' : 'created', changed },
    result: changed > 0 ? 'changed' : (ok ? 'noop' : 'failed'),
    error_code: ok ? null : 'E_MIGRATION_ASSERT',
    duration_ms: Date.now() - started, backend: 'file',
  })
} catch (e) {
  console.error(`[p-v5-1-migrate-eval] audit 写入失败: ${e?.message}`)
  process.exit(1)
}

console.log(ok ? '✅ eval 域迁移/种子完成' : '❌ 原地接管断言失败，请检查')
process.exit(ok ? 0 : 1)
