#!/usr/bin/env node
// ==============================================================================
// SilkSecAgent v5 Phase 1 试点验收（18-migration.md §三 试点验收 = Phase 2 放行条件）
// 场景：三路写同一候选 → 最终一条信号行；候选池计数三处一致
//   （vuln_candidates.total / vuln_stats.candidate.pending / 看板徽章=RPC vuln.stats）；
//   audit 三条记录 actor 可区分（webhook/script/model）；幂等重放 replay:true 同果。
// 三路：
//   路 1 webhook：register_candidate（模拟 xray webhook 重放，actor=webhook）→ 建候选
//   路 2 parser：exec.run.completed proposal 订阅 → register_candidate（actor=script,
//      同 host+title 弱指纹 → dup 宽容，不新建行）
//   路 3 model：vuln_confirm（附真实 evidence 引用）→ 候选提升为信号
// 数据隔离：默认在临时目录装配全新临时库（绝不触碰线上信号面）；
//   也可 SEC_DATA_DIR=<候选区库目录> 指向测试用真实库候选区。
// 用法：node p-v5-2-pilot-accept.js
//   环境：SEC_BASE_DIR（插件装配根，默认脚本所在目录；本地装配 /tmp/opencode/1.3-assemble）
//         SEC_DATA_DIR（可选：临时目录覆盖为指定候选区）
// ==============================================================================
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const BASE_DIR = process.env.SEC_BASE_DIR || __dirname
const DATA_DIR = process.env.SEC_DATA_DIR || null

let PASS = 0
let FAIL = 0
function check(name, cond, detail = '') {
  if (cond) { PASS++; console.log(`  ✅ ${name}`) }
  else { FAIL++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`) }
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sec-pilot-'))
}

async function makeEnv() {
  const { createBus } = await import(path.join(BASE_DIR, 'plugins', 'sec-domain-bus', 'index.js'))
  const { buildVulnDomain } = await import(path.join(BASE_DIR, 'plugins', 'sec-domain-vuln', 'index.js'))
  const dir = tmpDir()
  const dataDir = DATA_DIR || path.join(dir, 'data')
  fs.mkdirSync(dataDir, { recursive: true })
  fs.mkdirSync(path.join(dataDir, 'results', 'run_pilot_20260907_000000'), { recursive: true })
  fs.writeFileSync(path.join(dataDir, 'results', 'run_pilot_20260907_000000', 'meta.json'), '{}')
  const bus = createBus({
    dataDir,
    dbFile: path.join(DATA_DIR ? path.dirname(dataDir) : dir, 'asset-graph.db'),
    aliasesFile: path.join(dataDir, 'bus.aliases.yaml'),
    auditFile: path.join(dataDir, 'audit.jsonl'),
    eventsDir: path.join(dataDir, 'events'),
    sidecars: false,
    startDispatcherTimer: false,
  })
  const domain = buildVulnDomain({ dataDir, dispatch: (d, v, a, c) => bus.dispatch(d, v, a, c) })
  const reg = bus.registry.register(domain)
  if (!reg.ok) throw new Error(`vuln 域注册失败: ${reg.error?.message || ''}`)
  return { dir, dataDir, bus }
}

function readAudit(dataDir) {
  const f = path.join(dataDir, 'audit.jsonl')
  if (!fs.existsSync(f)) return []
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
}

const { dir, dataDir, bus } = await makeEnv()
console.log(`== 试点验收（临时库 ${dataDir}）==`)

// ---- 路 1：webhook 重放建候选 ----
const cand = await bus.dispatch('vuln', 'register_candidate', {
  title: 'pilot.example.com 被动审计候选：xray', severity: 'high', host: 'pilot.example.com',
  url: 'https://pilot.example.com/admin', source: 'xray-webhook',
}, { actor: 'webhook', session_id: 'sess_webhook' })
check('路1 webhook register_candidate → 候选建立', cand.ok && cand.data.noise === true && cand.data.status === 'new', JSON.stringify(cand.error || {}))
const candId = cand.data?.id
const poolAfterWebhook = await bus.query('vuln', 'candidates', { claim_state: 'all' }, { actor: 'dashboard' })
const statsAfterWebhook = await bus.query('vuln', 'stats', {}, { actor: 'dashboard' })
check('候选池计数三处一致（webhook 后：candidates=stats=1）',
  poolAfterWebhook.total === 1 && statsAfterWebhook.data.candidate.pending === 1 && poolAfterWebhook.total === statsAfterWebhook.data.candidate.pending,
  `candidates.total=${poolAfterWebhook.total} stats.pending=${statsAfterWebhook.data.candidate.pending}`)

// ---- 路 2：parser proposal 订阅（同 host+title → 弱指纹 dup 宽容） ----
const env = {
  id: 'evt_pilot_1', domain: 'exec', name: 'exec.run.completed', ts: Date.now(),
  actor: 'system', session_id: null,
  cause: { cmd: 'run_cli', idempotency_key: null },
  payload: { run_id: 'run_pilot_20260907_000000', tool: 'nuclei', parse_proposal: { findings: [{ title: 'pilot.example.com 被动审计候选：xray', severity: 'high', host: 'pilot.example.com', url: 'https://pilot.example.com/admin' }] } },
}
const busIdx = bus._internal
const sub = busIdx.subscribers.find((s) => s.pattern === 'exec.run.completed')
check('exec.run.completed 订阅在册', Boolean(sub))
const parserRes = await sub.handler(env)
check('路2 parser proposal → register_candidate（actor=script）', parserRes.ok && parserRes.data.registered === 1, JSON.stringify(parserRes.data))
const rowAfterParser = busIdx.db().prepare("SELECT COUNT(*) AS n FROM findings WHERE host='pilot.example.com'").get()
check('同候选不新建行（弱指纹 dup 宽容，仍 1 行）', rowAfterParser.n === 1, `rows=${rowAfterParser.n}`)

// ---- 路 3：model vuln_confirm（附真实 evidence） ----
const confirm = await bus.dispatch('vuln', 'confirm', { finding_id: candId, evidence: 'run_pilot_20260907_000000', note: '试点验收确认' }, { actor: 'model', session_id: 'sess_model' })
check('路3 model vuln_confirm → 信号', confirm.ok && confirm.data.signal === true && confirm.data.promoted_from_candidate === true, JSON.stringify(confirm.error || {}))

// ---- 幂等重放：同 key 同参 → replay:true 同果 ----
const replay = await bus.dispatch('vuln', 'confirm', { finding_id: candId, evidence: 'run_pilot_20260907_000000', note: '试点验收确认' }, { actor: 'model', session_id: 'sess_model' })
check('幂等重放 replay:true', replay.ok && replay.replay === true, `replay=${replay.replay}`)
check('重放同果（同 id/status）', replay.data.id === confirm.data.id && replay.data.status === confirm.data.status)

// ---- 最终口径：候选池三处一致 + 一条信号行 ----
const poolFinal = await bus.query('vuln', 'candidates', { claim_state: 'all' }, { actor: 'dashboard' })
const statsFinal = await bus.query('vuln', 'stats', {}, { actor: 'dashboard' })
const listFinal = await bus.query('vuln', 'list', { visibility: 'signal' }, { actor: 'dashboard' })
check('最终：候选池耗尽（candidates.total=0=stats.pending=看板徽章）',
  poolFinal.total === 0 && statsFinal.data.candidate.pending === 0,
  `candidates.total=${poolFinal.total} stats.pending=${statsFinal.data.candidate.pending}`)
check('最终：恰好一条信号行', statsFinal.data.signal.total === 1 && listFinal.total === 1 && listFinal.rows[0]?.id === candId,
  `signal.total=${statsFinal.data.signal.total} list.total=${listFinal.total}`)

// ---- audit 三条记录 actor 可区分（webhook/script/model） ----
const audit = readAudit(dataDir)
const cmdRows = audit.filter((a) => a.kind === 'command')
const actors = [...new Set(cmdRows.map((a) => a.actor))]
check('audit 含三路写记录（webhook/script/model）',
  cmdRows.some((a) => a.actor === 'webhook' && a.cmd === 'register_candidate')
  && cmdRows.some((a) => a.actor === 'script' && a.cmd === 'register_candidate')
  && cmdRows.some((a) => a.actor === 'model' && a.cmd === 'confirm'),
  `actors=[${actors.join(',')}]`)
const threeActors = cmdRows.filter((a) => ['webhook', 'script', 'model'].includes(a.actor))
check('audit actor 可区分（三种身份互异）',
  new Set(threeActors.map((a) => a.actor)).size === 3 && threeActors.every((a) => a.result === 'ok'),
  `actors=[${actors.join(',')}]`)

console.log(`\n== 结果：${PASS} 通过 / ${FAIL} 失败 ==`)
console.log(`临时目录：${dir}`)
process.exit(FAIL ? 1 : 0)