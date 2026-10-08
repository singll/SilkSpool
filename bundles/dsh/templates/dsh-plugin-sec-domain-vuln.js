// ==============================================================================
// @silksec/sec-domain-vuln — SilkSecAgent vuln 域插件（v5 Phase 1.2）
//
// 契约：doc/secagent/02-vuln.md（域设计，权威）+ 01-bus.md（总线）+ 00-conventions.md（宪法）
//
// 对外（cordis）：name='sec-domain-vuln'，apply() 把 manifest+handlers+backend 交给
// 总线 registry.register()（不 provide 任何业务方法——防绕过核心承诺）。
//
// 语义要点：
//  - 命令 C1-C11（register_signal/register_candidate/confirm/reject/submit/note/
//    claim/release/verify_replay/attach_fgs/authz_diff）+ 查询 Q1-Q6，全部拆自
//    v4 asset-db.js 混合动词（updateFinding 200 行按语义拆分）；
//  - 五要素闸门/噪声闸门从 addFinding 体内 if 升级为网关不变量（INV-4）；
//  - confirm 三联动（status+confidence+noise）单 UPDATE 原子（INV-3，v4 僵君缺陷根治）；
//  - 候选池 KPI 口径 noise=1 AND status='new'（宪法 §十一）；模型通道严格、机器通道宽容；
//  - 订阅 exec.run.completed（parser proposal 机器直灌分流，Phase 2 后事件源上线）；
//  - 状态机私有：动词名即入口，调用方永远不传 status/to。
//
// 零依赖：node:fs / node:path / node:crypto / node:http / node:https（sqlite 在总线）
// ==============================================================================

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import * as http from 'node:http'
import { fileURLToPath } from 'node:url'
import { readParseProposal } from '../sec-suite/parse-proposal.js'
import { enforceSeverityCap } from '../sec-rules-hypothesis/index.js'

export const name = 'sec-domain-vuln'
export const version = '1.0.0'

const DEFAULT_DATA_DIR = process.env.SEC_DATA_DIR || '/opt/silkspool/dsh/data'
const CLAIM_TTL_DEFAULT_SEC = 3600
// exec 产出 r/w + 时间戳 + 随机尾缀；兼容历史 run_* 及 nuclei 的 run_id: 前缀。
const EVIDENCE_TOKEN_RE = /^(?:(?:run_id:)?(?:run_[A-Za-z0-9_-]+|[rw][a-z0-9]{12,})(?=\s|$)|flow:[^\s]+|burp_item[: ][^\s]+|evidence\/\d+\/?|oob:[^\s]+|capsule:[a-f0-9]{16})/
const LOW_INFO_TITLE_RE = /^[a-z0-9_-]+: ?\w+$/
const SEV_RANK = { critical: 4, high: 3, medium: 2, low: 1, info: 0 }
const FINDING_STATUS = ['new', 'confirmed', 'false_positive', 'submitted', 'accepted', 'dup', 'ignored']
const TERMINAL = ['accepted', 'false_positive', 'dup', 'ignored']

// ---------------------------------------------------------------------------
// 43 号补丁：噪声类别学习与自动抑制（P0）
//   学习：按 source×category（nuclei=模板名；authz_diff=IDOR 前缀；其余=去 URL 标题）
//         聚合历史判定，类别拒绝率 ≥阈值且样本足够 → 新候选直接落 ignored（不进候选池）。
//   配额：每来源每日候选上限，超出同样落 ignored（reason=source_quota）。
//   安全：fail-open（后端不支持统计时正常登记）；白名单可覆盖；抑制行仍入库留审计。
// ---------------------------------------------------------------------------
// 动态读取（每次判定）——阈值/配额可运行期调整，单测可注入。
function noiseEnv() {
  const env = process.env || {}
  const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : d }
  const rate = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 && n <= 1 ? n : d }
  return {
    suppressRate: rate(env.SEC_VULN_NOISE_SUPPRESS_RATE, 0.8),
    suppressMin: num(env.SEC_VULN_NOISE_SUPPRESS_MIN, 20),
    dailyQuota: num(env.SEC_VULN_SOURCE_DAILY_QUOTA, 200),
    whitelist: String(env.SEC_VULN_NOISE_WHITELIST || '').split(',').map((x) => x.trim()).filter(Boolean),
  }
}

/** 类别归一：同源同模板/同类型归为一类，供拒绝率学习与抑制判定。 */
export function findingCategory(source, title) {
  const s = String(source || '')
  const t = String(title || '').replace(/\s+/g, ' ').trim()
  if (/^(parser:)?nuclei/i.test(s)) return t.slice(0, 80)
  if (s === 'authz_diff') return /越权|idor/i.test(t) ? 'authz_diff|IDOR' : 'authz_diff|' + t.slice(0, 40)
  const stripped = t.replace(/https?:\/\/\S+/gi, '').replace(/[0-9a-f]{8,}/gi, '<id>').trim()
  return (stripped || t).slice(0, 48)
}

function noiseWhitelisted(source, category) {
  const list = noiseEnv().whitelist
  return list.includes(String(source)) || list.includes(`${source}|${category}`)
}

function explorationSample(program, host, title, url) {
  return parseInt(fpObservation(program, host, title, url).slice(0, 8), 16) % 10 === 0
}

/** Suppression requires same Program, detector version and applicability; raw finding counts are not independent trials. */
export function noiseCategoryDecision(repo, source, category, { program_id, detector_version, applicability_key, now = Date.now() } = {}) {
  if (noiseWhitelisted(source, category)) return { suppress: false, reason: 'whitelisted', sample: 0, rejected: 0, rate: 0 }
  if (!program_id || !detector_version || !applicability_key) return { suppress: false, reason: 'suppression_context_missing', sample: 0, rejected: 0, rate: null }
  if (typeof repo.suppressionReceipts !== 'function') return { suppress: false, reason: 'backend_unsupported', sample: 0, rejected: 0, rate: null }
  let sample = 0; let rejected = 0
  const independent = new Map()
  for (const row of repo.suppressionReceipts({ source, program_id, detector_version, applicability_key, since: now - 30 * 86400000 })) {
    if (findingCategory(source, row.title) !== category) continue
    if (row.created_at > now) continue
    const evidence = JSON.parse(row.evidence_json)
    const key = row.basis === 'controlled_oracle' ? `decision:${evidence.capsule?.decision_id || ''}` : `evidence:${row.evidence_ref || ''}`
    if (key.endsWith(':')) continue
    if (!independent.has(key)) independent.set(key, row.verdict)
    else if (independent.get(key) !== row.verdict) independent.set(key, 'conflicting')
  }
  for (const verdict of independent.values()) {
    if (verdict === 'conflicting') continue
    sample++
    if (verdict === 'false_positive') rejected++
  }
  const rate = sample > 0 ? rejected / sample : null
  const cfg = noiseEnv()
  if (sample >= cfg.suppressMin && rate >= cfg.suppressRate) {
    return { suppress: true, reason: 'category_noise', sample, rejected, rate: Number(rate.toFixed(4)) }
  }
  return { suppress: false, sample, rejected, rate: rate == null ? null : Number(rate.toFixed(4)) }
}

/** 来源日配额（北京时区自然日）：返回 {exceeded, used, quota}。 */
export function noiseSourceQuota(repo, source) {
  const quota = noiseEnv().dailyQuota
  if (!(quota > 0)) return { exceeded: false, used: 0, quota: 0 }
  if (typeof repo.countSourceSince !== 'function') return { exceeded: false, used: 0, quota }
  const now = Date.now()
  const bjDayStart = Math.floor((now + 8 * 3600000) / 86400000) * 86400000 - 8 * 3600000
  const used = repo.countSourceSince(source, bjDayStart)
  return { exceeded: used >= quota, used, quota }
}

// Keep the old display count for compatibility; names and regexes are no longer policy evidence.
export const noiseControlConfig = () => ({ ...noiseEnv(), patterns: 0 })

const log = (msg) => { try { process.stderr.write(`[sec-domain-vuln] ${msg}\n`) } catch { /* noop */ } }

const sha1 = (s) => crypto.createHash('sha1').update(String(s)).digest('hex')
const iso16 = () => new Date().toISOString().slice(0, 16)

const sqliteBackendUrl = new URL('../sec-backend-vuln-sqlite/index.js', import.meta.url)
const { createVulnSqliteBackend } = await import(sqliteBackendUrl.href)
// http-remote 后端（Phase 4）懒加载且容错：未组装时不影响 sqlite-local（两后端随域插件一同部署）
let createVulnHttpBackend = null
try {
  const httpBackendUrl = new URL('../sec-backend-vuln-http/index.js', import.meta.url)
  ;({ createVulnHttpBackend } = await import(httpBackendUrl.href))
} catch (e) {
  log(`sec-backend-vuln-http 未组装（${e?.message}），http-remote 模式不可用；sqlite-local 照常`)
}

// ---------------------------------------------------------------------------
// manifest（02-vuln §1.2/§1.4/§1.5 的机器形态；R1-R7 lint 全部经 validateManifestShape/Lint）
// ---------------------------------------------------------------------------

const schema = (properties, required, extra = {}) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
  ...extra,
})

const str = (opts = {}) => ({ type: 'string', ...opts })
const en = (values, extra = {}) => ({ type: 'string', enum: values, ...extra })
const num = (opts = {}) => ({ type: 'number', ...opts })
const int = (opts = {}) => ({ type: 'integer', ...opts })
const bool = () => ({ type: 'boolean' })

const SEVERITY = ['critical', 'high', 'medium', 'low', 'info']
const VERDICT = ['false_positive', 'dup', 'ignored']
const VENDOR_STATUS = ['submitted', 'pending', 'accepted', 'rejected', 'duplicate', 'not_rewarded', '']

export const VULN_MANIFEST = {
  domain: 'vuln',
  version: 1,
  service: 'secDomain.vuln',
  description: '漏洞信号 / 候选队列 / 证据链 / 提交与运营回流（v5 试点域，候选池状态机根治域）',
  owns: {
    tables: ['findings', 'vuln_technical_verdicts'],
    files: ['data/evidence/', 'data/evidence/hardened-drafts/', 'data/events/vuln.jsonl'],
  },
  commands: {
    vuln_register_signal: {
      actor: ['model', 'human'],
      schema: schema({
        title: str({ minLength: 1 }),
        severity: en(SEVERITY),
        host: str(),
        url: str({ default: '' }),
        evidence: str(),
        program_id: str(),
        reproduction_steps: str(),
        impact: str(),
        source: str({ default: 'agent' }),
        vuln_type: str(),
        cwe: str(),
        endpoint_ref: str(),
        preconditions: str(),
        recommendation: str(),
        confidence: en(['tentative'], { default: 'tentative' }),
        fgs_node_id: int(),
        discovery_step: str(),
        external_id: str({ maxLength: 128, description: '上游系统稳定 id（跨源去重优先键）' }),
        task_id: int({ description: '（可选）产生该发现的 task id——归因→连败拉黑/学习闭环' }),
      }, ['title', 'severity', 'host', 'evidence', 'reproduction_steps', 'impact']),
      idempotent: 'natural',
      idempotent_natural: ['program_id', 'host', 'title', 'url'],
      events: ['vuln.signal.registered', 'vuln.candidate.promoted'],
      event_limit: 2,
      invariants: ['signalComplete'],
      timeout_ms: 60000,
      agent_note: '登记一个完整验证过的漏洞发现（唯一能新建信号面行的动词）。五要素强制：规范标题（≥10 字符，禁止工具原始输出当标题）、复现步骤、具体化影响、证据引用（run_id/flow_id/burp_item/evidence 路径/oob）、host。severity 禁 info。同 program+host+title+url 指纹自动去重；命中待验证候选会就地补全升级（upgraded:true）。纪律：登记前完成对抗性自检（≥2 反证假设逐一排除）+ 高危双出口复现。',
      deprecated: false,
    },
    vuln_register_candidate: {
      actor: ['webhook', 'script', 'dashboard'],
      schema: schema({
        title: str({ minLength: 1 }),
        severity: en(SEVERITY),
        host: str(),
        url: str({ default: '' }),
        evidence: str({ default: '' }),
        source: str(),
        program_id: str(),
        vuln_type: str({ minLength: 1, maxLength: 80, description: '待验证的漏洞类型；仅路由元数据，不表示技术确认' }),
        detector_version: str({ minLength: 1, maxLength: 128 }),
        applicability_key: str({ minLength: 1, maxLength: 256 }),
        external_id: str({ maxLength: 128, description: '上游系统稳定 id（跨源去重优先键）' }),
        task_id: int({ description: '（可选）产生该候选的 task id——归因→学习闭环' }),
      }, ['title', 'severity', 'host', 'source']),
      idempotent: 'auto',
      idempotent_fields: ['program_id', 'title', 'host', 'url', 'source', 'external_id', 'evidence', 'vuln_type', 'detector_version', 'applicability_key'],
      events: ['vuln.candidate.registered', 'vuln.candidate.suppressed', 'vuln.candidate.reopened'],
      event_limit: 1,
      invariants: [],
      timeout_ms: 60000,
      agent_note: '候选登记入口（webhook/parser/authz_diff 机器直灌 + dashboard 操作员从会话「登记候选漏洞」，模型禁入）：缺复现/影响的登记天然落候选池待验证；操作员侧只产候选，确权走 vuln_confirm。',
      deprecated: false,
    },
    vuln_confirm: {
      actor: ['model', 'dashboard'],
      schema: schema({
        finding_id: int(),
        evidence: str({ default: '' }),
        note: str({ default: '' }),
        reproduction_steps: str({ minLength: 10 }),
        impact: str({ minLength: 10 }),
        corrects_verdict_id: int({ minimum: 1 }),
        reassessment: schema({
          previous_status: en(FINDING_STATUS),
          previous_verdict_id: { type: ['integer', 'null'], minimum: 1 },
          reason: str({ minLength: 20 }),
        }, ['previous_status', 'previous_verdict_id', 'reason']),
        review: schema({ basis: str({ minLength: 20 }), reproduction_steps: str({ minLength: 10 }), impact: str({ minLength: 10 }) }, ['basis', 'reproduction_steps', 'impact']),
      }, ['finding_id']),
      idempotent: 'none',
      events: ['vuln.signal.confirmed', 'vuln.candidate.promoted'],
      event_limit: 2,
      // 证据闸门先于 finding 存在性：缺证据 → 确定性 E_EVIDENCE_REQUIRED（引导性 hint，
      // 不因 finding 不存在而变 E_NOT_FOUND），使 eval 契约用例 EC-02「无证据确认」可确定性断言。
      invariants: ['evidenceExists', 'findingExists', 'oracleCapsuleGate', 'reassessmentGate', 'correctionGate'],
      timeout_ms: 60000,
      agent_note: '确认须可信capsule或dashboard operator及独立review。终态/重复审校须reassessment引用当前status及最新回执ID（无则null），过期拒绝；平台submitted/accepted状态保留。corrects_verdict_id仅用于明确更正原错误反证，不表示目标后来变化。',
      deprecated: false,
    },
    vuln_reject: {
      actor: ['model', 'dashboard'],
      schema: schema({
        finding_id: int(),
        verdict: en(VERDICT),
        reason: str({ minLength: 10 }),
        dup_of: { type: ['integer', 'null'] },
        note: str({ default: '' }),
        evidence: str({ default: '' }),
        corrects_verdict_id: int({ minimum: 1 }),
        reassessment: schema({
          previous_status: en(FINDING_STATUS),
          previous_verdict_id: { type: ['integer', 'null'], minimum: 1 },
          reason: str({ minLength: 20 }),
        }, ['previous_status', 'previous_verdict_id', 'reason']),
        review: schema({
          basis: str({ minLength: 20 }), expected_behavior: str({ minLength: 10 }),
          observed_behavior: str({ minLength: 10 }), controls: str({ minLength: 20 }),
        }, ['basis', 'expected_behavior', 'observed_behavior', 'controls']),
      }, ['finding_id', 'verdict', 'reason']),
      idempotent: 'none',
      events: ['vuln.signal.rejected'],
      event_limit: 1,
      invariants: ['findingExists', 'dupTargetValid', 'rejectionEvidenceGate', 'reassessmentGate', 'correctionGate'],
      timeout_ms: 60000,
      agent_note: 'false_positive须可信rejected capsule或dashboard operator/evidence/review独立反证。缺证/身份阻塞/基础设施失败使用note，不否定。终态审校须reassessment引用当前status及最新回执ID，保留平台/队列处理状态，另记技术回执；corrects_verdict_id仅明确证伪旧阳性。dup须dup_of；ignored仅处理状态。',
      deprecated: false,
    },
    vuln_oracle_capsule: {
      actor: ['model', 'script', 'dashboard'],
      schema: schema({ decision_id: str({ pattern: '^r[a-z0-9]+$' }) }, ['decision_id']),
      idempotent: 'none',
      events: ['vuln.oracle.capsuled'],
      event_limit: 1,
      invariants: [],
      timeout_ms: 60000,
      agent_note: '仅封装 exec_verify_authz_read 返回的 decision_id；不接受调用方 verdict/target。判定和原始执行证据重新核验后写入 capsule v2。',
      deprecated: false,
    },
    // 21 号方案 §4-4 打法固化三层通道（第一层：capsule 重放 → 脚本草稿）
    vuln_capsule_replay: {
      actor: ['script', 'dashboard', 'human', 'reactor'],
      schema: schema({
        capsule_id: str({ pattern: '^[a-f0-9]{16}$' }),
        harden: { type: 'boolean' },
      }, ['capsule_id']),
      idempotent: 'none',
      events: ['vuln.capsule.replayed'],
      event_limit: 1,
      invariants: [],
      timeout_ms: 300000,
      agent_note: '旧的关键词复现通道已关闭。缺新鲜双身份凭据时返回 blocked；按宿主契约重新执行 exec_verify_authz_read，不执行 capsule 内调用方命令，也不生成固化草稿。',
      deprecated: false,
    },
    vuln_submit: {
      actor: ['model', 'dashboard'],
      schema: schema({
        finding_id: int(),
        platform: str({ default: '' }),
        bounty: { type: ['number', 'null'] },
        vendor_status: en(VENDOR_STATUS, { default: '' }),
        submission_url: str({ default: '' }),
        remote_id: str({ default: '' }),
        note: str({ default: '' }),
      }, ['finding_id']),
      idempotent: 'auto',
      idempotent_fields: ['finding_id', 'bounty', 'vendor_status', 'platform', 'remote_id'],
      events: ['vuln.signal.submitted'],
      event_limit: 1,
      invariants: ['findingExists', 'submittable'],
      timeout_ms: 60000,
      agent_note: '确认后的运营流转：confirmed → submitted（平台提交后）；vendor 反馈（accepted/bounty/vendor_status）在 submitted 态再次调用回流运营列。提交前先 report_draft_submission（report 域）出草稿人工审校。remote_id 填平台工单号。',
      deprecated: false,
    },
    vuln_expire_candidates: {
      actor: ['system', 'dashboard'],
      schema: schema({
        ttl_days: int({ minimum: 1, maximum: 365, default: 14 }),
        limit: int({ minimum: 1, maximum: 5000, default: 500 }),
      }, []),
      idempotent: 'none',
      events: ['vuln.candidate.expired', 'vuln.candidate.reopened'],
      event_limit: 2,
      invariants: [],
      timeout_ms: 60000,
      agent_note: '候选队列维护：先恢复已到期的自动延后项；未更新超ttl_days且无活跃认领/技术回执的候选延后一天。只改处理队列，不创建技术结论；人工及旧无原因ignored不自动重开。',
      deprecated: false,
    },
    // 43 号补丁（P0）：噪声类别学习数据面（只读）
    vuln_noise_stats: {
      actor: ['system', 'dashboard', 'human', 'model'],
      schema: schema({
        source: str({ default: '' }),
        min_total: int({ minimum: 1, maximum: 100000, default: 5 }),
        limit: int({ minimum: 1, maximum: 200, default: 50 }),
      }, []),
      idempotent: 'none',
      events: [],
      event_limit: 0,
      invariants: [],
      timeout_ms: 60000,
      agent_note: '噪声类别学习数据面（只读）：按 source×category 聚合处理状态及正式回执技术计数。误报率分母=technical_confirmed+technical_false_positive；旧弱标签、损坏回执、忽略/重复/待验证不作为反证。返回抑制阈值、白名单与来源日配额。',
      deprecated: false,
    },
    // 43 号补丁（P0/B3）：存量候选确定性批量处置（零 LLM）
    vuln_candidates_sweep: {
      actor: ['system', 'dashboard'],
      schema: schema({
        limit: int({ minimum: 1, maximum: 5000, default: 1000 }),
        dry_run: bool(),
        min_total: int({ minimum: 1, maximum: 100000, default: 20 }),
        source: str({ default: '' }),
      }, []),
      idempotent: 'none',
      events: ['vuln.candidate.suppressed'],
      event_limit: 1,
      invariants: [],
      timeout_ms: 60000,
      agent_note: '存量候选确定性处置（零 LLM）：对 noise=1 且 status=new 的候选按 ①类别拒绝率≥阈值（category_noise）或 ②检测型模板规则（detection_template）批量置 ignored 出池；dry_run=true 仅统计。抑制不等于删除：行保留、证据留审计，白名单可豁免。新的同类候选在登记口即被自动抑制，本命令用于清历史积压。',
      deprecated: false,
    },
    vuln_note: {
      actor: ['model', 'dashboard'],
      schema: schema({
        finding_id: int(),
        note: str({ minLength: 1 }),
        evidence_ref: str({ default: '' }),
      }, ['finding_id', 'note']),
      idempotent: 'auto',
      idempotent_fields: ['finding_id', 'note'],
      events: [],
      event_limit: 0,
      invariants: ['findingExists'],
      timeout_ms: 60000,
      agent_note: '向 finding 追加证据链条目（不改状态，任意状态可用）。用于补充观察、勘误说明、复验记录。带时间戳前缀追加。',
      deprecated: false,
    },
    vuln_evidence_put: {
      actor: ['model'],
      schema: schema({
        finding_id: int(),
        request_text: str({ minLength: 1 }),
        note: str({ default: '' }),
      }, ['finding_id', 'request_text']),
      idempotent: 'auto',
      idempotent_fields: ['finding_id', 'request_text'],
      events: [],
      event_limit: 0,
      invariants: ['findingExists'],
      timeout_ms: 60000,
      agent_note: '把机械复核所需的原始 HTTP 请求写入证据包 evidence/{finding_id}/request.txt（受管写入，原生 write 无法写域数据目录）。request_text 须为完整 HTTP 报文（首行 METHOD target + Host 头）。写后用 vuln_verify_replay 复核。覆盖式写入，重复同内容幂等。',
      deprecated: false,
    },
    vuln_claim: {
      actor: ['model', 'dashboard'],
      schema: schema({
        finding_id: int(),
      }, ['finding_id']),
      idempotent: 'auto',
      idempotent_fields: ['finding_id'],
      idempotent_ctx_fields: ['session_id', 'operator'],
      events: ['vuln.candidate.claimed'],
      event_limit: 1,
      invariants: ['findingExists', 'candidateTarget'],
      timeout_ms: 60000,
      agent_note: '认领一条待验证候选（防多 worker 重复验证）。软锁 TTL 3600s，超时自动可抢占。认领后尽快验证并 vuln_confirm / vuln_reject，不再处理时 vuln_release。',
      deprecated: false,
    },
    vuln_release: {
      actor: ['model', 'dashboard'],
      schema: schema({
        finding_id: int(),
      }, ['finding_id']),
      idempotent: 'auto',
      idempotent_fields: ['finding_id'],
      idempotent_ctx_fields: ['session_id', 'operator'],
      events: [],
      event_limit: 0,
      invariants: ['findingExists'],
      timeout_ms: 60000,
      agent_note: '释放自己认领的候选（改做其他事时必须释放，别让锁白占到超时）。',
      deprecated: false,
    },
    vuln_verify_replay: {
      actor: ['model', 'script'],
      schema: schema({
        finding_id: int(),
        proxy: str({ default: '' }),
        expect_hash: str({ default: '' }),
      }, ['finding_id']),
      idempotent: 'none',
      events: [],
      event_limit: 0,
      invariants: ['findingExists'],
      timeout_ms: 120000,
      agent_note: '经 exec 受控入口重放 evidence/{id}/request.txt，要求 finding 的 Program/host 绑定。返回新 run_id 与响应 hash 对比；PASS 只表示响应一致，不表示漏洞成立。出口仅 default/direct；确认另走可信判定。',
      deprecated: false,
    },
    vuln_attach_fgs: {
      actor: ['model', 'reactor'],
      schema: schema({
        finding_id: int(),
        fgs_node_id: int({ minimum: 1 }),
      }, ['finding_id', 'fgs_node_id']),
      idempotent: 'auto',
      idempotent_fields: ['finding_id', 'fgs_node_id'],
      events: [],
      event_limit: 0,
      invariants: ['findingExists', 'fgsAttachable'],
      timeout_ms: 60000,
      agent_note: '把 FGS finding 节点关联到 finding 行（任务内显式建图时用；调度会话内自动关联由 fgs 域事件完成，通常无需手动）。',
      deprecated: false,
    },
    vuln_authz_diff: {
      actor: ['model'],
      schema: schema({
        program_id: str({ minLength: 1 }),
        url: str({ minLength: 1 }),
        method: str({ default: 'GET' }),
        headers_low: { oneOf: [str(), { type: 'object' }] },
        headers_high: { oneOf: [str(), { type: 'object' }] },
        body: str(),
      }, ['program_id', 'url', 'headers_low', 'headers_high']),
      idempotent: 'none',
      events: [],
      event_limit: 0,
      invariants: [],
      timeout_ms: 120000,
      agent_note: '双权 HTTP 观察：必须提供 program_id，经 exec 统一守卫与固定出口执行，返回执行证据 run_id 和 inconclusive。相似响应不自动登记候选；可信 IDOR 验证使用 exec_verify_authz_read。',
      deprecated: false,
    },
    // C12（L1 学习专项，2026-09-16）：从可信 exec 证据清单挂载证据到 finding（设计 §3.3.3）
    vuln_evidence_attach: {
      actor: ['model', 'dashboard', 'reactor'],
      schema: schema({
        finding_id: int(),
        evidence_ref: str({ minLength: 3 }),
        note: str(),
      }, ['finding_id', 'evidence_ref']),
      idempotent: 'auto',
      idempotent_fields: ['finding_id', 'evidence_ref'],
      events: ['vuln.evidence.attached'],
      event_limit: 1,
      invariants: ['findingExists', 'publishedEvidence'],
      timeout_ms: 120000,
      agent_note: '把已发布的 exec 证据包挂载到 finding：evidence_ref 填已 exec_evidence_publish 发布的 run_id。网关核验证据清单（SHA-256 逐文件）与 Program 归属一致后，复制进 evidence/<finding_id>/<run_id>/ 并记入证据链。只接受已发布证据；worker staging 原文不受信。',
      deprecated: false,
    },
  },
  queries: {
    vuln_technical_receipts: {
      actor: ['reactor', 'script', 'dashboard'],
      params: schema({ ids: { type: 'array', items: int({ minimum: 1 }), minItems: 1, maxItems: 500 } }, ['ids']),
      agent_note: '批量核验历史正式技术回执，损坏或旧弱回执返回trusted=false，不产生技术标签。',
    },
    vuln_technical_verdict: {
      actor: ['reactor', 'script', 'dashboard'],
      params: schema({ id: int() }, ['id']),
      agent_note: '读取正式技术回执的关联与来源摘要，核验保存证据摘要；不重新请求目标。',
    },
    vuln_list: {
      actor: ['model', 'dashboard', 'human', 'script', 'reactor'],
      params: schema({
        visibility: en(['signal', 'candidate', 'all'], { default: 'signal' }),
        host: str({ default: '' }),
        severity: en([...SEVERITY, ''], { default: '' }),
        status: en([...FINDING_STATUS, ''], { default: '' }),
        program_id: str({ default: '' }),
        q: str({ default: '' }),
        limit: int({ minimum: 1, maximum: 500 }),
        offset: int({ minimum: 0 }),
        sort: en(['created_at', 'id', 'status', 'severity', ''], { default: 'created_at' }),
        dir: en(['asc', 'desc', ''], { default: 'desc' }),
      }, []),
      predicates: ['visibility', 'severity', 'status'],
      agent_note: '检索漏洞发现。visibility=signal（默认，仅信号面）/ candidate（待验证候选队列）/ all。按 host/severity/status/program_id/q 过滤，分页+排序。',
    },
    vuln_get: {
      actor: ['model', 'dashboard', 'human', 'reactor', 'system'],
      params: schema({ id: int() }, ['id']),
      predicates: [],
      agent_note: '取单条 finding 全量详情（含 evidence 证据链全文）。',
    },
    vuln_candidates: {
      // 43 号补丁：专项规划器（reactor）需要读候选池生成 verify 草稿
      actor: ['model', 'dashboard', 'human', 'reactor', 'system'],
      params: schema({
        claim_state: en(['available', 'unclaimed', 'claimed', 'stale', 'all'], { default: 'available' }),
        severity_min: en([...SEVERITY, ''], { default: '' }),
        program_id: str({ default: '' }),
        host: str({ default: '' }),
        limit: int({ minimum: 1, maximum: 500 }),
        offset: int({ minimum: 0 }),
        sort: en(['severity', 'created_at', 'claimed_at', ''], { default: 'severity' }),
        dir: en(['asc', 'desc', ''], { default: 'desc' }),
      }, []),
      predicates: ['claim_state', 'severity_min'],
      agent_note: '待验证候选工作队列。claim_state=available（默认，未认领+认领超时）可筛 unclaimed/claimed/stale/all，带池摘要。',
    },
    vuln_stats: {
      actor: ['model', 'dashboard', 'human'],
      params: schema({}, []),
      predicates: [],
      agent_note: '漏洞计数总览：信号面（by severity/status）与候选面（pending/claimed）分开计数。候选口径=待消化（noise=1 且 status=new）。',
    },
    // 技术回执与首次来源投影；capsule 文本仅为引用存在标志。
    vuln_evidence_flags: {
      actor: ['script', 'dashboard', 'system'],
      params: schema({
        program_id: str({ default: '' }),
        limit: int({ minimum: 1, maximum: 5000 }),
        offset: int({ minimum: 0 }),
      }, []),
      predicates: [],
      agent_note: '（eval 投影数据源）逐 finding 首次来源/入池时间与最新正式技术回执，完整分页。不回传证据全文；has_capsule 只表示文本引用，不能作为 verified。',
    },
    vuln_by_asset: {
      actor: ['model', 'dashboard', 'human'],
      params: schema({
        host: str(),
        include_candidates: bool(),
      }, ['host']),
      predicates: [],
      agent_note: '单资产漏洞视图（按 severity 分组计数，可选含候选）。',
    },
    vuln_dedup_check: {
      actor: ['model', 'dashboard', 'human'],
      params: schema({
        host: str({ default: '' }),
        vuln_type: str({ default: '' }),
        exclude_id: int(),
        limit: int({ minimum: 1, maximum: 50, default: 10 }),
      }, []),
      predicates: [],
      agent_note: '同目标/同类型历史查重（host 或 vuln_type 至少其一）。提交前必查，防平台判重。',
    },
    vuln_submission_queue: {
      actor: ['model', 'dashboard', 'human'],
      params: schema({
        limit: int({ minimum: 1, maximum: 200, default: 50 }),
        overdue_days: int({ minimum: 1, maximum: 365, default: 7 }),
      }, []),
      predicates: [],
      agent_note: '产出闭环：confirmed 未提交 SRC 队列（severity 降序/年龄升序），带 age_days/overdue。逐条 report_draft_submission→审校→提交→vuln_submit 回写。',
    },
  },
  events: {
    'vuln.candidate.registered': { payload: { type: 'object' }, redact: [] },
    'vuln.candidate.promoted': { payload: { type: 'object' }, redact: [] },
    'vuln.candidate.expired': { payload: { type: 'object' }, redact: [] },
    'vuln.candidate.reopened': { payload: { type: 'object' }, redact: [] },
    'vuln.candidate.suppressed': { payload: { type: 'object' }, redact: [] },
    'vuln.candidate.claimed': { payload: { type: 'object' }, redact: [] },
    'vuln.signal.registered': { payload: { type: 'object' }, redact: [] },
    'vuln.signal.confirmed': { payload: { type: 'object' }, redact: [] },
    'vuln.signal.rejected': { payload: { type: 'object' }, redact: [] },
    'vuln.oracle.capsuled': { payload: { type: 'object' }, redact: [] },
    'vuln.signal.submitted': { payload: { type: 'object' }, redact: [] },
    'vuln.evidence.attached': { payload: { type: 'object' }, redact: [] },
    'vuln.capsule.replayed': { payload: { type: 'object' }, redact: [] },
  },
  subscribes: {
    'exec.run.completed': { handler: 'onParserProposal', mode: 'async', as: 'reactor' },
  },
  backend: 'repository-v1',
}

// ---------------------------------------------------------------------------
// 域名工具（指纹/主机归一/证据引用校验，全部对齐 02-vuln §1.3/§2.1）
// ---------------------------------------------------------------------------

function normalizeHost(h) {
  let s = String(h || '').trim().toLowerCase()
  const proto = s.indexOf('://')
  if (proto >= 0) s = s.slice(proto + 3)
  const at = s.lastIndexOf('@')
  if (at >= 0) s = s.slice(at + 1)
  const slash = s.indexOf('/')
  if (slash >= 0) s = s.slice(0, slash)
  if (s.startsWith('[')) {
    const close = s.indexOf(']')
    if (close >= 0) s = close + 1 < s.length ? s.slice(1, close) : s.slice(1, close)
  } else {
    s = s.replace(/:\d+$/, '')
  }
  return s.replace(/\.$/, '')
}

function hostOf(urlStr) {
  try {
    const u = new URL(String(urlStr))
    return normalizeHost(u.host)
  } catch { return normalizeHost(String(urlStr).split('/')[0]) }
}

function fpWeak(host, title) { return sha1(`${normalizeHost(host)}|${String(title).trim()}`) }
function fpStrong(host, title, url) { return sha1(`${normalizeHost(host)}|${String(title).trim()}|${url || ''}`) }

// 存储去重只消除同项目、同 URL 的重复观察，不在验证前猜测共同根因。
function fpObservation(programId, host, title, url) {
  return sha1(JSON.stringify(['observation-v2', String(programId || ''), normalizeHost(host), String(title).trim(), String(url || '')]))
}
function findObservation(repo, programId, host, title, url) {
  for (const fp of [fpObservation(programId, host, title, url), fpStrong(host, title, url), fpWeak(host, title)]) {
    const row = repo.getFindingByFingerprint(fp)
    if (row && String(row.program_id || '') === String(programId || '') && String(row.url || '') === String(url || '')) return row
  }
  return null
}
function appendObservationEvidence(repo, row, evidence) {
  const text = String(evidence || '').trim()
  if (text && String(row.evidence || '').trim() !== text) repo.appendEvidence(row.id, `${isoPrefix(Date.now())} observation: ${text}`)
}

function refPrefix(evidence) {
  const m = String(evidence || '').trim().match(EVIDENCE_TOKEN_RE)
  return m ? m[0].replace(/^run_id:/, '') : null
}

function isoPrefix(now) { return `[${new Date(now).toISOString().slice(0, 16)}]` }

// ---------------------------------------------------------------------------
// 21 号方案 §2-2：proof capsule（可重放的机器验证证据包）
// 文件：data/evidence/oracle-capsules/{capsule_id}.json（原子写；body+digest 自洽）
// ---------------------------------------------------------------------------

function capsuleDirOf(dataDir) { return path.join(dataDir, 'evidence', 'oracle-capsules') }

function writeCapsule(dataDir, body) {
  const dir = capsuleDirOf(dataDir)
  fs.mkdirSync(dir, { recursive: true })
  const payload = {
    capsule_version: 2,
    decision_id: body.decision_id,
    decision_digest: body.decision_digest,
    created_at: new Date().toISOString(),
    oracle: body.oracle,
    verdict: body.verdict,
    target: body.target,
    request_pair: body.request_pair || null,
    rule_input: body.rule_input || null,
    result: body.result || null,
    replay: body.replay || null,
    env: body.env || null,
    finding_id: body.finding_id ?? null,
  }
  const id = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 16)
  const file = path.join(dir, `${id}.json`)
  if (!fs.existsSync(file)) {
    const content = { ...payload, capsule_id: id, digest: crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex') }
    const tmp = `${file}.tmp.${process.pid}.${Date.now()}`
    fs.writeFileSync(tmp, JSON.stringify(content, null, 2) + '\n')
    fs.renameSync(tmp, file)
  }
  return { id, file: path.join('evidence', 'oracle-capsules', `${id}.json`) }
}

function readCapsule(dataDir, id) {
  const file = path.join(capsuleDirOf(dataDir), `${String(id || '')}.json`)
  if (!/^[a-f0-9]{16}$/.test(String(id || ''))) return null
  try {
    const c = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (c.capsule_id !== id) return null
    const { digest, capsule_id, ...body } = c
    if (digest !== crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex') || digest.slice(0, 16) !== id) return null
    return c
  } catch { return null }
}

// evidence 引用真实存在性（INV-2，02-vuln §1.3 C3）——dataDir 下结果/证据/flows/oob 布局
function evidenceProbe(evidence, findingId, dataDir) {
  const probes = []
  const token = refPrefix(evidence)
  if (!token) return { ok: false, reason: 'no_ref' }
  if (token.startsWith('capsule:')) {
    probes.push(path.join(dataDir, 'evidence', 'oracle-capsules', `${token.slice('capsule:'.length)}.json`))
  } else if (/^(?:run_|[rw][a-z0-9]{12,}$)/.test(token)) {
    probes.push(path.join(dataDir, 'results', token, 'meta.json'))
    probes.push(path.join(dataDir, 'results', token, 'meta.yaml'))
  } else if (token.startsWith('flow:')) {
    const rel = token.slice('flow:'.length)
    probes.push(path.join(dataDir, rel.startsWith('/') ? rel.slice(1) : rel))
    probes.push(path.join(dataDir, 'flows', rel.replace(/^flows\//, '')))
  } else if (token.startsWith('evidence/')) {
    probes.push(path.join(dataDir, token))
    probes.push(path.join(dataDir, 'evidence', String(findingId)))
  } else if (token.startsWith('burp_item')) {
    probes.push(path.join(dataDir, 'evidence', String(findingId)))
  } else if (token.startsWith('oob:')) {
    probes.push(path.join(dataDir, 'oob', token.slice(4)))
  }
  const root = fs.realpathSync(dataDir) + path.sep
  return { ok: probes.some((p) => {
    try { return fs.realpathSync(p).startsWith(root) } catch { return false }
  }), probes, token }
}

// L1（C12）：读取并核验 exec 已发布证据清单——存在性、digest 自洽、逐文件 sha256 与实况一致。
// 读取用 O_NOFOLLOW 安全句柄；清单内路径逐条拒 .. 与绝对路径。
function readPublishedManifest(evidenceRef, dataDir) {
  const runId = String(evidenceRef || '').trim().replace(/^run_id:/, '')
  if (!/^[rw][a-z0-9]+$/.test(runId)) {
    return { ok: false, code: 'E_EVIDENCE_REQUIRED', message: `evidence_ref 须为已发布证据的 run_id: ${evidenceRef}`, hint: '先由宿主 exec_evidence_publish 发布 staging 证据，再挂载（run_id:<run> 或裸 run_id）' }
  }
  const dir = path.join(dataDir, 'results', runId)
  const manifestPath = path.join(dir, 'evidence-manifest.json')
  if (!fs.existsSync(manifestPath)) {
    return { ok: false, code: 'E_EVIDENCE_REQUIRED', message: `run ${runId} 无已发布证据清单`, hint: 'run 产物须先经 exec_evidence_publish（宿主 system 通道）发布；staging 原文不受信' }
  }
  let manifest = null
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) } catch { manifest = null }
  if (!manifest || manifest.run_id !== runId || !Array.isArray(manifest.files) || !manifest.files.length) {
    return { ok: false, code: 'E_EVIDENCE_REQUIRED', message: `证据清单损坏或为空: ${runId}`, hint: '重新发布证据（exec_evidence_publish）' }
  }
  const { digest, ...body } = manifest
  const recomputed = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex')
  if (digest !== recomputed) {
    return { ok: false, code: 'E_VULN_EVIDENCE_TAMPERED', message: `证据清单 digest 不符: ${runId}`, hint: '清单被篡改或损坏；从 staging 重新发布' }
  }
  for (const f of manifest.files) {
    if (!f || typeof f.path !== 'string' || f.path.includes('..') || path.isAbsolute(f.path)) {
      return { ok: false, code: 'E_VULN_EVIDENCE_TAMPERED', message: `清单路径非法: ${f && f.path}`, hint: '清单被篡改或损坏；从 staging 重新发布' }
    }
    const abs = path.join(dir, f.path)
    let buf = null
    try {
      const fd = fs.openSync(abs, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
      try { buf = fs.readFileSync(fd) } finally { fs.closeSync(fd) }
    } catch {
      return { ok: false, code: 'E_VULN_EVIDENCE_TAMPERED', message: `证据文件缺失或不可信: ${f.path}`, hint: '证据发布后不可改动；重新发布' }
    }
    const h = crypto.createHash('sha256').update(buf).digest('hex')
    if (h !== f.sha256) {
      return { ok: false, code: 'E_VULN_EVIDENCE_TAMPERED', message: `证据文件哈希不符: ${f.path}`, hint: '证据发布后不可改动；重新发布' }
    }
  }
  return { ok: true, runId, manifest }
}

// ---------------------------------------------------------------------------
// HTTP 重放（C9/C11 共用；direct / SEC_EGRESS_PROXY 默认出口，02-vuln §1.3 C9）
// ---------------------------------------------------------------------------

function parseRequestText(raw) {
  const [head, ...rest] = String(raw).split(/\r?\n\r?\n/)
  const lines = head.split(/\r?\n/)
  const m = lines[0].match(/^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|TRACE|CONNECT)\s+(\S+)/)
  if (!m) return { error: 'request.txt 首行无法解析（须为 METHOD target）' }
  const headers = {}
  for (const line of lines.slice(1)) {
    const i = line.indexOf(':')
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim()
  }
  return { method: m[1], target: m[2], headers, body: rest.join('\n\n') }
}

// ---------------------------------------------------------------------------
// handlers（每个命令一个实现；错误抛 {code, hint, retryable?} 由网关转信封）
// ---------------------------------------------------------------------------

function claimerOf(ctx) {
  if (ctx.actor === 'dashboard') return ctx.operator || 'operator'
  return ctx.session_id || ctx.actor || 'model'
}

function makeHandlers(opts) {
  const dataDir = opts.dataDir || DEFAULT_DATA_DIR
  const ttlSec = opts.claim_ttl_sec || CLAIM_TTL_DEFAULT_SEC
  const dispatchRef = opts.dispatch
  const queryRef = opts.query

  async function controlledHttp(args, ctx = {}) {
    const r = await dispatchRef?.('exec', 'http_request', args, { actor: 'script', session_id: ctx.session_id || null, signal: ctx.signal })
    if (!r?.ok) throwErr(r?.error?.code || 'E_BACKEND_UNAVAILABLE', r?.error?.message || '受控 HTTP 执行域不可用', r?.error?.hint, r?.error?.retryable)
    const q = await queryRef?.('exec', 'http_result', { run_id: r.data.run_id }, { actor: 'script' })
    if (!q?.ok) throwErr(q?.error?.code || 'E_BACKEND_UNAVAILABLE', q?.error?.message || 'HTTP 执行证据不可读', null)
    return q.data
  }

  function throwErr(code, message, hint, retryable = false) {
    throw Object.assign(new Error(message), { code, hint, retryable })
  }

  const invariants = {
    findingExists: async (args, repo) => {
      const row = repo.getFinding(args.finding_id)
      if (!row) return { code: 'E_NOT_FOUND', message: `finding #${args.finding_id} 不存在`, hint: '先 vuln_get / vuln_list 核实 id' }
      return null
    },
    signalComplete: async (args) => {
      const title = String(args.title || '').trim()
      const lowInfo = LOW_INFO_TITLE_RE.test(title)
      if (title.length < 10 || lowInfo || !String(args.reproduction_steps || '').trim() || !String(args.impact || '').trim()) {
        return { code: 'E_VULN_INCOMPLETE', message: '五要素缺失：标题 ≥10 字符（且非工具原始输出）、复现步骤、具体影响必填', hint: '信号登记要求五要素完整（规范标题≥10 字符、复现步骤、具体影响、证据引用、host）。机器产出或不完整观察请勿用本动词；完成对抗性自检与双出口复现后再登记', retryable: false }
      }
      if (args.severity === 'info') return { code: 'E_VULN_INFO_SEVERITY', message: 'severity=info 不进信号面', hint: 'info 级侦察副产物不进信号面。如确有安全价值，按 rules/src/severity-rating.md 重新定级（信息泄露默认低危）后以 low+具体影响登记', retryable: false }
      if (!refPrefix(args.evidence)) {
        return { code: 'E_EVIDENCE_REQUIRED', message: 'evidence 必须含证据引用', hint: '证据必须是 run_id/flow_id/burp_item/evidence 路径/oob 交互记录引用，无证据不结论（sec-verification 铁律）', retryable: false }
      }
      // 21 号方案 §0-6：severity × vuln_type 硬降级（信息泄露 ≤ low、未证明执行 ≤ medium）
      const cap = enforceSeverityCap(args.vuln_type, args.severity)
      if (cap) {
        return { code: 'E_VULN_SEVERITY_CAPPED', message: cap.message, hint: `按评级规则降为 ${cap.cap} 再登记，或在影响与证据中证明进一步利用（如真实数据泄露/会话接管）后走人工裁定`, retryable: false }
      }
      return null
    },
    evidenceExists: async (args) => {
      const probe = evidenceProbe(args.evidence, args.finding_id, dataDir)
      if (!probe.ok) {
        return { code: 'E_EVIDENCE_REQUIRED', message: `证据引用不存在：${probe.token || args.evidence}`, hint: '确认必须附真实存在的证据引用（run_id 的 results 目录 / evidence/{id}/ 证据包）。CONFIRMED 还须 verify_replay 机械复核通过', retryable: false }
      }
      return null
    },
    oracleCapsuleGate: async (args, repo, ctx) => {
      const row = repo.getFinding(args.finding_id)
      const rejecting = args.verdict === 'false_positive'
      if (args.review) {
        if (ctx.actor !== 'dashboard' || !String(ctx.operator || '').trim()) return { code: 'E_VULN_REVIEW_REQUIRED', message: '人工独立审校必须由有 operator 的 dashboard 通道提交', retryable: false }
        return null
      }
      const token = refPrefix(args.evidence)
      if (!token?.startsWith('capsule:')) return { code: 'E_VULN_REVIEW_REQUIRED', message: '旧证据仅证明观察存在，待独立审校；自动确认须引用可信判定 capsule', hint: '执行受控验证；或 dashboard 提交 operator 与 review（审校依据、复现步骤、影响）。历史 finding 不自动改判', retryable: false }
      const capsule = readCapsule(dataDir, token.slice(8))
      if (!capsule || capsule.capsule_version !== 2 || !capsule.decision_id) return { code: 'E_VULN_REVIEW_REQUIRED', message: '旧版/损坏 capsule 无可信执行判定，待重新验证', retryable: false }
      const r = await queryRef?.('exec', 'authz_decision', { decision_id: capsule.decision_id }, { actor: 'script' })
      if (!r?.ok || crypto.createHash('sha256').update(JSON.stringify(r.data)).digest('hex') !== capsule.decision_digest) return { code: 'E_VULN_EVIDENCE_TAMPERED', message: '判定或执行证据失效，不能确认', hint: r?.error?.message || 'exec 判定服务不可用', retryable: false }
      const d = r.data
      const expectedVerdict = rejecting ? 'rejected' : 'verified'
      if (d.verdict !== expectedVerdict || capsule.verdict !== d.verdict) return {
        code: rejecting ? 'E_VULN_ORACLE_NOT_REJECTED' : 'E_VULN_ORACLE_NOT_VERIFIED',
        message: `可信判定非 ${expectedVerdict}，不能作本次技术结论`, retryable: false,
      }
      if (d.finding_id !== row.id || capsule.finding_id !== row.id || d.program_id !== row.program_id || d.target.url !== row.url
        || normalizeHost(d.target.host) !== normalizeHost(row.host) || d.target.vuln_class !== row.vuln_type
        || JSON.stringify(capsule.target) !== JSON.stringify(d.target)
        || capsule.oracle !== d.oracle || JSON.stringify(capsule.rule_input) !== JSON.stringify({ request_id: d.request_id, identities: d.identities, objects: d.objects })
        || JSON.stringify(capsule.env) !== JSON.stringify({ profile_digest: d.profile_digest, proxy_digest: d.proxy_digest, oracle_version: d.oracle_version })
        || JSON.stringify(capsule.result) !== JSON.stringify({ rationale: d.rationale, run_ids: d.run_ids })) return { code: 'E_VULN_ORACLE_TARGET_MISMATCH', message: '判定与 finding 的项目、目标、类型或请求关联不一致', retryable: false }
      if (!rejecting && (!String(args.reproduction_steps || row.reproduction_steps || '').trim() || !String(args.impact || row.impact || '').trim())) return { code: 'E_VULN_INCOMPLETE', message: '确认需要可复现步骤和具体影响', retryable: false }
      return null
    },
    rejectionEvidenceGate: async (args, repo, ctx) => {
      if (args.verdict !== 'false_positive') return null
      return await invariants.evidenceExists(args, repo, ctx) || await invariants.oracleCapsuleGate(args, repo, ctx)
    },
    reassessmentGate: async (args, repo, ctx) => {
      if (!args.reassessment) return null
      if (!args.review || ctx.actor !== 'dashboard' || !String(ctx.operator || '').trim()
        || (args.verdict && args.verdict !== 'false_positive')) {
        return { code: 'E_VULN_REVIEW_REQUIRED', message: '重新审校须操作员提交独立技术审校材料', retryable: false }
      }
      const row = repo.getFinding(args.finding_id)
      const latest = repo.getLatestTechnicalVerdict(args.finding_id)
      if (row.status !== args.reassessment.previous_status
        || (latest?.id ?? null) !== args.reassessment.previous_verdict_id) {
        return { code: 'E_VULN_REVIEW_STALE', message: '处理状态或技术判定已变化，请重新读取并审校', retryable: false }
      }
      return null
    },
    correctionGate: async (args, repo, ctx) => {
      if (args.corrects_verdict_id) {
        if ((args.verdict && args.verdict !== 'false_positive') || !args.review || ctx.actor !== 'dashboard' || !String(ctx.operator || '').trim()) {
          return { code: 'E_VULN_REVIEW_REQUIRED', message: '更正旧技术判定须操作员独立反证审校', retryable: false }
        }
        const previous = repo.getTechnicalVerdict(args.corrects_verdict_id)
        const latest = repo.getLatestTechnicalVerdict(args.finding_id)
        const previousVerdict = args.verdict === 'false_positive' ? 'confirmed' : 'false_positive'
        if (!previous || previous.finding_id !== args.finding_id || previous.verdict !== previousVerdict
          || latest?.id !== previous.id || !['controlled_oracle', 'independent_review'].includes(previous.basis)
          || repo.technicalState?.(args.finding_id)?.verdict !== previousVerdict
          || previous.evidence_digest !== crypto.createHash('sha256').update(previous.evidence_json).digest('hex')) {
          return { code: 'E_VULN_CORRECTION_TARGET', message: '更正必须引用同Finding最新且完整的相反技术回执', retryable: false }
        }
      }
      return null
    },
    // L1（INV-10）：vuln_evidence_attach 的证据必须是 exec 已发布清单——清单存在、digest 自洽、
    // 逐文件 sha256 与 results/<run_id>/ 实况一致；且 Program 归属不跨项目（双方均有归属时须一致）。
    publishedEvidence: async (args, repo) => {
      const chk = readPublishedManifest(args.evidence_ref, dataDir)
      if (!chk.ok) return { code: chk.code, message: chk.message, hint: chk.hint, retryable: false }
      const finding = repo.getFinding(args.finding_id)
      const evProgram = chk.manifest.program_id || null
      if (finding && finding.program_id && evProgram && String(finding.program_id) !== String(evProgram)) {
        return { code: 'E_VULN_PROGRAM_MISMATCH', message: `finding #${args.finding_id} 属 ${finding.program_id}，证据 run 属 ${evProgram}，跨项目挂载拒绝`, hint: '证据与 finding 必须同 Program；确属同项目的归属漂移先修正 program_id', retryable: false }
      }
      return null
    },
    dupTargetValid: async (args, repo, ctx) => {
      if (args.verdict !== 'dup') return null
      if (!Number.isInteger(args.dup_of)) {
        // v5 语义动词严格口径（无别名兼容层）：dup 判定必须显式指回被重复行。
        return { code: 'E_VULN_DUP_TARGET_REQUIRED', message: 'verdict=dup 必须带 dup_of', hint: 'dup 判定必须指回被重复的 finding（dup_of）。可先用 vuln_dedup_check 检索同目标同类型历史', retryable: false }
      }
      const target = repo.getFinding(args.dup_of)
      if (!target) return { code: 'E_NOT_FOUND', message: `dup_of #${args.dup_of} 不存在`, hint: 'dup_of 必须指向已存在的 finding' }
      return null
    },
    candidateTarget: async (args, repo) => {
      const row = repo.getFinding(args.finding_id)
      if (row && !(row.noise === 1 && row.status === 'new')) {
        return { code: 'E_VULN_NOT_CANDIDATE', message: `finding #${args.finding_id} 非候选池行（noise=${row.noise} status=${row.status}）`, hint: '认领只作用于候选池行（noise=1 AND status=new）。信号面行的验证由任务编排保证，无需认领', retryable: false }
      }
      return null
    },
    submittable: async (args, repo) => {
      const row = repo.getFinding(args.finding_id)
      if (!row) return null
      if (!['confirmed', 'submitted'].includes(row.status)) {
        return { code: 'E_STATE', message: `finding #${args.finding_id} 状态 ${row.status} 不可提交`, hint: '提交前必须先 vuln_confirm；vendor 翻案（accepted→重复/驳回）用 dashboard 通道 vuln_submit 附 operator 审计', retryable: false }
      }
      return null
    },
    fgsAttachable: async (args, repo) => {
      const row = repo.getFinding(args.finding_id)
      if (!row) return null
      if (!['new', 'confirmed'].includes(row.status)) {
        return { code: 'E_STATE', message: `finding #${args.finding_id} 状态 ${row.status} 不可挂 FGS 节点`, hint: 'fgs_node_id 关联仅限 new/confirmed 行', retryable: false }
      }
      return null
    },
  }

  function claimGuard(row, ctx) {
    if (row.noise !== 1 || row.status !== 'new') return null
    if (ctx.actor === 'dashboard') return null
    if (row.claimed_by && row.claimed_by !== claimerOf(ctx) && row.claimed_at && Date.now() - row.claimed_at < ttlSec * 1000) {
      return { by: row.claimed_by, at: row.claimed_at }
    }
    return null
  }

  async function confirmClaimed(args, repo, ctx) {
    const row = repo.getFinding(args.finding_id)
    const guard = claimGuard(row, ctx)
    if (guard) {
      throwErr('E_VULN_CLAIMED', `候选 #${args.finding_id} 被会话 ${guard.by} 活跃认领（认领于 ${Math.round((Date.now() - guard.at) / 60000)} 分钟前，TTL ${ttlSec}s）`, '该候选正被其他会话验证，请挑 vuln_candidates 中下一条 available 候选', true)
    }
  }

  const commands = {
    // C1：登记完整信号（强指纹去重 / 弱指纹命中候选 promote 升级）
    vuln_register_signal: async (args, repo, ctx) => {
      const host = normalizeHost(args.host)
      const title = String(args.title).trim()
      const url = String(args.url || '')
      const strong = fpObservation(args.program_id, host, title, url)
      const now = Date.now()
      // 同项目/host/URL 内 external_id 优先：标题变化不重复导入，其他入口保留。
      const extId = String(args.external_id || '').trim()
      if (extId) {
        const byExt = repo.getFindingByExternalId?.(extId, args.program_id, host, url)
        if (byExt) {
          if (ctx.session_id && !byExt.session_id) repo.backfillSession(byExt.id, ctx.session_id)
          return {
            data: { id: byExt.id, dup: true, upgraded: false, noise: byExt.noise === 1, status: byExt.status, dedup_reason: 'external_id' },
            events: [],
            before: { status: byExt.status, noise: byExt.noise }, after: { status: byExt.status, noise: byExt.noise },
          }
        }
      }
      const existing = findObservation(repo, args.program_id, host, title, url)
      const dup = existing && !(existing.noise === 1 && existing.status === 'new') ? existing : null
      if (dup) {
        if (ctx.session_id) repo.backfillSession(dup.id, ctx.session_id)
        return {
          data: { id: dup.id, dup: true, upgraded: false, noise: dup.noise === 1, status: dup.status, dedup_reason: 'fingerprint' },
          events: [],
          before: { status: dup.status, noise: dup.noise }, after: { status: dup.status, noise: dup.noise },
        }
      }
      const signalTaskId = args.task_id != null ? Number(args.task_id) : (ctx.task_id != null ? Number(ctx.task_id) : null)
      const cand = existing
      if (cand && cand.noise === 1 && cand.status === 'new') {
        const merged = repo.mergeCandidate(cand.id, {
          title, host, url, severity: args.severity, evidence: [cand.evidence, args.evidence].filter(Boolean).join('\n'), source: args.source || 'agent',
          vuln_type: args.vuln_type || null, cwe: args.cwe || null, endpoint_ref: args.endpoint_ref || null,
          preconditions: args.preconditions || null, reproduction_steps: args.reproduction_steps || null,
          impact: args.impact || null, recommendation: args.recommendation || null,
          confidence: args.confidence || 'tentative', fgs_node_id: args.fgs_node_id || null,
          discovery_step: args.discovery_step || null, session_id: ctx.session_id || null,
          task_id: signalTaskId, updated_at: now,
        }, strong)
        if (merged.changed) {
          repo.markSyncPending?.(cand.id)
          repo.invalidateSourceStats?.(cand.source)
          repo.invalidateSourceStats?.(args.source || 'agent')
          return {
            data: { id: cand.id, dup: false, upgraded: true, noise: false, status: merged.after?.status || 'new' },
            events: [
              { name: 'vuln.signal.registered', payload: { finding_id: cand.id, fingerprint: strong, severity: args.severity, host, session_id: ctx.session_id || null, task_id: signalTaskId, fgs_node_id: args.fgs_node_id || null } },
              { name: 'vuln.candidate.promoted', payload: { finding_id: cand.id, from: { noise: 1, status: 'new' }, to: { noise: 0, status: 'new' }, cause_cmd: 'vuln_register_signal' } },
            ],
            before: { status: cand.status, noise: 1 }, after: { status: 'new', noise: 0 },
          }
        }
      }
      const row = repo.insertFinding({
        fingerprint: strong, title, severity: args.severity, host, url,
        evidence: args.evidence || '', source: args.source || 'agent',
        program_id: args.program_id || null, session_id: ctx.session_id || null, task_id: signalTaskId,
        vuln_type: args.vuln_type || null, cwe: args.cwe || null, endpoint_ref: args.endpoint_ref || null,
        preconditions: args.preconditions || null, reproduction_steps: args.reproduction_steps || null,
        impact: args.impact || null, recommendation: args.recommendation || null,
        noise: 0, status: 'new', confidence: args.confidence || 'tentative',
        fgs_node_id: args.fgs_node_id || null, discovery_step: args.discovery_step || null,
        created_at: now, updated_at: now, external_id: extId || null,
      })
      repo.markSyncPending?.(row.id)
      repo.invalidateSourceStats?.(args.source || 'agent')
      return {
        data: { id: row.id, dup: false, upgraded: false, noise: false, status: 'new' },
        events: [{ name: 'vuln.signal.registered', payload: { finding_id: row.id, fingerprint: strong, severity: args.severity, host, session_id: ctx.session_id || null, task_id: signalTaskId, fgs_node_id: args.fgs_node_id || null } }],
        before: null, after: { id: row.id, status: 'new', noise: 0 },
      }
    },

    // C2：机器直灌候选（同项目/host/title/URL 去重，保留其他入口）
    vuln_register_candidate: async (args, repo, ctx) => {
      const host = normalizeHost(args.host)
      const title = String(args.title).trim()
      const url = String(args.url || '')
      const fingerprint = fpObservation(args.program_id, host, title, url)
      const now = Date.now()
      const extId = String(args.external_id || '').trim()
      const reopen = row => {
        const reopened = repo.reopenChangedHold?.(row.id, args.detector_version, args.applicability_key, now) || false
        return { reopened, status: reopened ? 'new' : row.status,
          events: reopened ? [{ name: 'vuln.candidate.reopened', payload: { finding_id: row.id,
            program_id: row.program_id, reason: 'observation_conditions_changed' } }] : [] }
      }
      // 同项目/host/URL 内 external_id 优先（上游稳定 id）。
      if (extId) {
        const byExt = repo.getFindingByExternalId?.(extId, args.program_id, host, url)
        if (byExt) {
          const changed = reopen(byExt)
          appendObservationEvidence(repo, byExt, args.evidence)
          if (ctx.session_id && !byExt.session_id) repo.backfillSession(byExt.id, ctx.session_id)
          return { data: { id: byExt.id, dup: true, reopened: changed.reopened, noise: byExt.noise === 1, status: changed.status, dedup_reason: 'external_id' }, events: changed.events, before: { status: byExt.status, noise: byExt.noise }, after: { status: changed.status, noise: byExt.noise } }
        }
      }
      const dup = findObservation(repo, args.program_id, host, title, url)
      if (dup) {
        const changed = reopen(dup)
        if (ctx.session_id && !dup.session_id) repo.backfillSession(dup.id, ctx.session_id)
        appendObservationEvidence(repo, dup, args.evidence)
        return {
          data: { id: dup.id, dup: true, reopened: changed.reopened, noise: dup.noise === 1, status: changed.status, dedup_reason: 'same_program_host_title_url' },
          events: changed.events,
          before: { status: dup.status, noise: dup.noise }, after: { status: changed.status, noise: dup.noise },
        }
      }
      const source = String(args.source || 'webhook')
      const category = findingCategory(source, title)
      // 43 号补丁：类别拒绝率学习 + 来源日配额（fail-open、白名单可豁免、抑制行仍入库留审计）
      const decision = noiseCategoryDecision(repo, source, category, args)
      const exploration = decision.suppress && explorationSample(args.program_id, host, title, url)
      if (exploration) decision.suppress = false
      const quota = decision.suppress ? { exceeded: false, used: 0, quota: 0 } : noiseSourceQuota(repo, source)
      const suppressed = decision.suppress || quota.exceeded
      const suppressReason = decision.suppress ? 'category_noise' : (quota.exceeded ? 'source_quota' : null)
      const note = suppressed
        ? `${args.evidence || ''}\n[auto-suppressed ${iso16()} reason=${suppressReason} category=${category} rate=${decision.rate} sample=${decision.sample}${quota.exceeded ? ` used=${quota.used}/${quota.quota}` : ''}]`.trim()
        : (args.evidence || '')
      const taskId = args.task_id != null ? Number(args.task_id) : (ctx.task_id != null ? Number(ctx.task_id) : null)
      const row = repo.insertFinding({
        fingerprint, title, severity: args.severity || 'info', host, url,
        evidence: note, source,
        program_id: args.program_id || null, session_id: ctx.session_id || null,
        task_id: taskId,
        detector_version: args.detector_version || null, applicability_key: args.applicability_key || null,
        queue_hold_reason: suppressReason, queue_hold_until: suppressed ? now + 86400000 : null,
        vuln_type: args.vuln_type || null, cwe: null, endpoint_ref: null, preconditions: null,
        reproduction_steps: null, impact: null, recommendation: null,
        noise: 1, status: suppressed ? 'ignored' : 'new', confidence: 'tentative',
        fgs_node_id: null, discovery_step: null,
        created_at: now, updated_at: now, external_id: extId || null,
      })
      if (!suppressed) repo.invalidateSourceStats?.(source)
      return {
        data: { id: row.id, dup: false, noise: true, status: suppressed ? 'ignored' : 'new', suppressed, suppress_reason: suppressReason, category, exploration },
        events: suppressed ? [{
          name: 'vuln.candidate.suppressed',
          payload: { finding_id: row.id, source, category, reason: suppressReason, rate: decision.rate, sample: decision.sample,
            quota: quota.exceeded ? { used: quota.used, quota: quota.quota } : null, title_head: title.slice(0, 60) },
        }] : [{
          name: 'vuln.candidate.registered',
          payload: { finding_id: row.id, fingerprint, title_head: title.slice(0, 60), severity: args.severity || 'info', host, source, program_id: args.program_id || null, task_id: taskId, exploration },
        }],
        before: null, after: { id: row.id, status: suppressed ? 'ignored' : 'new', noise: 1 },
      }
    },

    // C3：候选/信号 → confirmed（三联动原子升级；note 同事务追加）
    vuln_confirm: async (args, repo, ctx) => {
      await confirmClaimed(args, repo, ctx)
      const reviewError = await invariants.reassessmentGate(args, repo, ctx) || await invariants.correctionGate(args, repo, ctx)
      if (reviewError) throwErr(reviewError.code, reviewError.message, null)
      const row = repo.getFinding(args.finding_id)
      if (args.review) repo.updateFields(args.finding_id, { reproduction_steps: args.review.reproduction_steps, impact: args.review.impact })
      else if (args.reproduction_steps !== undefined || args.impact !== undefined) {
        repo.updateFields(args.finding_id, {
          reproduction_steps: args.reproduction_steps ?? row.reproduction_steps,
          impact: args.impact ?? row.impact,
        })
      }
      const status = args.reassessment && ['submitted', 'accepted'].includes(row.status) ? row.status : 'confirmed'
      const changed = repo.transitionFinding(args.finding_id, args.reassessment ? row.status : 'new', { status, confidence: 'confirmed', noise: 0, claimed_by: null, claimed_at: null, updated_at: Date.now() })
      if (!changed.changed) throwErr('E_STATE', `finding #${args.finding_id} 状态非 new 或已终态`, 'finding 已处于终态/已确认，不可再次流转。补证据用 vuln_note；提交用 vuln_submit', false)
      repo.appendEvidence(args.finding_id, `${isoPrefix(Date.now())} confirmation evidence: ${args.evidence}${args.review ? `; reviewed by ${ctx.operator}: ${args.review.basis}` : ''}`)
      if (args.note) repo.appendEvidence(args.finding_id, `${isoPrefix(Date.now())} confirm: ${args.note}`)
      const technicalEvidence = JSON.stringify({ evidence: args.evidence, review: args.review || null,
        reassessment: args.reassessment || null, corrects_verdict_id: args.corrects_verdict_id || null,
        capsule: args.review ? null : readCapsule(dataDir, refPrefix(args.evidence).slice(8)) })
      const technicalVerdictId = repo.recordTechnicalVerdict({
        finding_id: row.id, verdict: 'confirmed', basis: args.review ? 'independent_review' : 'controlled_oracle',
        evidence_ref: refPrefix(args.evidence),
        evidence_digest: crypto.createHash('sha256').update(technicalEvidence).digest('hex'), evidence_json: technicalEvidence,
        operator: args.review ? ctx.operator : null, created_at: Date.now(),
      })
      repo.markSyncPending?.(args.finding_id)
      const fromCandidate = row.noise === 1
      // 43 号补丁：事件携带 task/session/来源——归因→策略胜负回写与类别学习（此前无归因，连败拉黑形同虚设）
      const events = [{ name: 'vuln.signal.confirmed', payload: { finding_id: args.finding_id, technical_verdict_id: technicalVerdictId, corrects_verdict_id: args.corrects_verdict_id || null, from: { status: row.status, noise: row.noise }, evidence_ref: refPrefix(args.evidence), verification_basis: args.review ? 'independent_review' : 'controlled_oracle', operator: args.review ? ctx.operator : null, confidence: 'confirmed', fgs_node_id: row.fgs_node_id || null, vuln_type: row.vuln_type || null, host: row.host || null, program_id: row.program_id || null, task_id: row.task_id ?? null, session_id: row.session_id ?? null, source: row.source ?? null, title: String(row.title || '').slice(0, 80) } }]
      if (fromCandidate && row.status === 'new') events.push({ name: 'vuln.candidate.promoted', payload: { finding_id: args.finding_id, from: { noise: 1, status: 'new' }, to: { noise: 0, status }, cause_cmd: 'vuln_confirm' } })
      return {
        data: { id: args.finding_id, status, technical_verdict_id: technicalVerdictId, signal: true, promoted_from_candidate: fromCandidate && row.status === 'new' },
        events,
        before: { status: row.status, noise: row.noise, confidence: row.confidence }, after: { status, noise: 0, confidence: 'confirmed' },
      }
    },

    // Capsule only wraps a persisted execution-owned decision; caller verdicts are rejected by schema.
    vuln_oracle_capsule: async (args, repo, ctx) => {
      const r = await queryRef?.('exec', 'authz_decision', { decision_id: args.decision_id }, { actor: 'script' })
      if (!r?.ok) throwErr(r?.error?.code || 'E_BACKEND_UNAVAILABLE', r?.error?.message || '可信判定服务不可用', '先执行 exec_verify_authz_read')
      const d = r.data
      const w = writeCapsule(dataDir, { ...d, decision_digest: crypto.createHash('sha256').update(JSON.stringify(d)).digest('hex'),
        rule_input: { request_id: d.request_id, identities: d.identities, objects: d.objects },
        result: { rationale: d.rationale, run_ids: d.run_ids }, env: { profile_digest: d.profile_digest, proxy_digest: d.proxy_digest, oracle_version: d.oracle_version } })
      return { data: { capsule_id: w.id, evidence_ref: `capsule:${w.id}`, file: w.file, verdict: d.verdict },
        events: [{ name: 'vuln.oracle.capsuled', payload: { capsule_id: w.id, decision_id: d.decision_id, verdict: d.verdict, finding_id: d.finding_id, program_id: d.program_id } }] }
    },
    vuln_capsule_replay: async (args) => {
      const capsule = readCapsule(dataDir, args.capsule_id)
      if (!capsule) throwErr('E_NOT_FOUND', 'capsule 不存在或损坏', null)
      // Credentials are deliberately absent from capsules. A fresh authenticated run is
      // required; matching strings in arbitrary tool output never proves reproduction.
      return { data: { capsule_id: args.capsule_id, verdict: 'blocked', reason: '需要新鲜双身份凭据，重新运行 exec_verify_authz_read；旧 capsule 不执行调用方 replay 命令', hardened_draft: null }, events: [] }
    },

    // C4：false_positive / dup / ignored（noise 不动——候选出池靠口径）
    vuln_reject: async (args, repo, ctx) => {
      await confirmClaimed(args, repo, ctx)
      const reviewError = await invariants.reassessmentGate(args, repo, ctx) || await invariants.correctionGate(args, repo, ctx)
      if (reviewError) throwErr(reviewError.code, reviewError.message, null)
      const row = repo.getFinding(args.finding_id)
      if (TERMINAL.includes(row.status) && !args.reassessment) {
        throwErr('E_STATE', `finding #${args.finding_id} 处于 ${row.status} 终态不可再流转`, '已终态不可再流转；如需翻案走人工通道（dashboard 侧 vuln_confirm 附 operator 审计）', false)
      }
      const status = args.reassessment && ['submitted', 'accepted', 'dup', 'ignored'].includes(row.status) ? row.status : args.verdict
      const set = { status, claimed_by: null, claimed_at: null, updated_at: Date.now(), queue_hold_reason: null, queue_hold_until: null }
      // 重复/忽略是处理结果，不能撤销已有技术确认；反证才改变技术置信标记。
      if (args.verdict === 'false_positive' || (args.verdict === 'dup' && row.confidence !== 'confirmed')) set.confidence = args.verdict
      const changed = repo.transitionFinding(args.finding_id, args.reassessment ? row.status : ['new', 'confirmed', 'submitted'], set)
      if (!changed.changed) throwErr('E_STATE', `finding #${args.finding_id} 状态 ${row.status} 不可 reject`, '已终态不可再流转', false)
      let technicalVerdictId = null
      if (args.verdict === 'false_positive') {
        const evidence = JSON.stringify({ reason: args.reason, note: args.note || null, evidence: args.evidence,
          corrects_verdict_id: args.corrects_verdict_id || null,
          reassessment: args.reassessment || null,
          review: args.review || null, capsule: args.review ? null : readCapsule(dataDir, refPrefix(args.evidence).slice(8)) })
        technicalVerdictId = repo.recordTechnicalVerdict({
          finding_id: row.id, verdict: 'false_positive', basis: args.review ? 'independent_review' : 'controlled_oracle',
          evidence_ref: refPrefix(args.evidence), evidence_digest: crypto.createHash('sha256').update(evidence).digest('hex'),
          evidence_json: evidence, operator: ctx.operator || null, created_at: Date.now(),
        })
      }
      repo.appendEvidence(args.finding_id, `${isoPrefix(Date.now())} reject(${args.verdict}): ${args.reason}${args.evidence ? `; evidence: ${args.evidence}` : ''}${args.review ? `; reviewed by ${ctx.operator}: ${args.review.basis}` : ''}`)
      if (args.note) repo.appendEvidence(args.finding_id, `${isoPrefix(Date.now())} reject(${args.verdict}): ${args.note}`)
      if (row.noise === 0) repo.markSyncPending?.(args.finding_id)
      return {
        data: { id: args.finding_id, status, technical_verdict_id: technicalVerdictId, noise: row.noise === 1, rejected: true },
        events: [{ name: 'vuln.signal.rejected', payload: { finding_id: args.finding_id, verdict: args.verdict,
          technical_verdict_id: technicalVerdictId, program_id: row.program_id || null,
          ...(technicalVerdictId ? { evidence_ref: refPrefix(args.evidence),
            verification_basis: args.review ? 'independent_review' : 'controlled_oracle',
            corrects_verdict_id: args.corrects_verdict_id || null } : {}),
          from: { status: row.status, noise: row.noise }, reason_head: String(args.reason || '').slice(0, 60), dup_of: args.dup_of || null, fgs_node_id: row.fgs_node_id || null, task_id: row.task_id ?? null, session_id: row.session_id ?? null, source: row.source ?? null, title: String(row.title || '').slice(0, 80) } }],
        before: { status: row.status, noise: row.noise, confidence: row.confidence }, after: { status, noise: row.noise, confidence: set.confidence ?? row.confidence },
      }
    },

    // C5：confirmed → submitted / 运营列回流 / accepted（vendor 判 accepted 自环升级）
    vuln_submit: async (args, repo) => {
      const row = repo.getFinding(args.finding_id)
      const now = Date.now()
      const sets = {}
      if (args.bounty !== null && args.bounty !== undefined && args.bounty !== '') sets.bounty = Number(args.bounty)
      if (args.vendor_status) sets.vendor_status = String(args.vendor_status)
      if (args.remote_id) sets.remote_id = String(args.remote_id)
      let to = row.status
      if (row.status === 'confirmed') {
        sets.status = 'submitted'
        sets.submitted_at = now
        to = 'submitted'
      } else if (row.status === 'submitted' && args.vendor_status === 'accepted') {
        sets.status = 'accepted'
        to = 'accepted'
      }
      sets.updated_at = now
      const changed = repo.updateFields(args.finding_id, sets)
      if (!changed.changed) throwErr('E_STATE', `finding #${args.finding_id} 更新失败`, '提交前必须先 vuln_confirm', false)
      repo.markSyncPending?.(args.finding_id)
      const metaNote = []
      if (args.platform) metaNote.push(`platform=${args.platform}`)
      if (args.submission_url) metaNote.push(`submission_url=${args.submission_url}`)
      if (args.note) metaNote.push(args.note)
      if (metaNote.length) repo.appendEvidence(args.finding_id, `${isoPrefix(now)} submit: ${metaNote.join(' ')}`)
      return {
        data: { id: args.finding_id, status: to, from: row.status, submitted_at: to === 'submitted' ? now : row.submitted_at || null },
        events: [{ name: 'vuln.signal.submitted', payload: { finding_id: args.finding_id, from: { status: row.status }, to: { status: to }, bounty: sets.bounty ?? null, vendor_status: args.vendor_status || '', platform: args.platform || '' } }],
        before: { status: row.status, noise: row.noise }, after: { status: to, noise: row.noise },
      }
    },

    // C13：候选池 TTL 治理（system/dashboard）——超期未消化候选置 ignored 出池
    vuln_expire_candidates: async (args, repo) => {
      if (typeof repo.expireCandidates !== 'function') throwErr('E_BACKEND_UNAVAILABLE', '当前后端不支持候选 TTL 治理（需 sqlite-local）', '切回 sqlite-local 后端', true)
      const ttlDays = Number(args.ttl_days) || 14
      const cutoff = Date.now() - ttlDays * 86400000
      const reopened = repo.reopenHeldCandidates?.(Date.now(), args.limit || 500) || []
      const { expired, ids } = repo.expireCandidates(cutoff, args.limit || 500)
      return {
        data: { expired, reopened: reopened.length, ttl_days: ttlDays, ids: ids.slice(0, 20) },
        events: [...(expired ? [{ name: 'vuln.candidate.expired', payload: { count: expired, ids: ids.slice(0, 50), ttl_days: ttlDays } }] : []),
          ...(reopened.length ? [{ name: 'vuln.candidate.reopened', payload: { count: reopened.length, ids: reopened.slice(0, 50), reason: 'queue_hold_elapsed' } }] : [])],
      }
    },

    // 43 号补丁（P0）：噪声类别学习数据面（只读）
    vuln_noise_stats: async (args, repo) => {
      const cfg = noiseControlConfig()
      const sourceFilter = String(args.source || '')
      const minTotal = Math.max(1, Number(args.min_total) || 5)
      const limit = Math.min(Number(args.limit) || 50, 200)
      const raw = typeof repo.sourceTitleAll === 'function' ? repo.sourceTitleAll({ minTotal: 1, limit: 5000, source: sourceFilter }) : []
      const agg = new Map()
      for (const row of raw) {
        const source = String(row.source || '')
        const category = findingCategory(source, row.title)
        const key = `${source}|${category}`
        const cur = agg.get(key) || { source, category, total: 0, new_count: 0, confirmed: 0, technical_confirmed: 0, technical_false_positive: 0, false_positive: 0, ignored: 0, dup: 0, submitted: 0, accepted: 0, noise_count: 0 }
        for (const field of ['total', 'new_count', 'confirmed', 'technical_confirmed', 'technical_false_positive', 'false_positive', 'ignored', 'dup', 'submitted', 'accepted', 'noise_count']) cur[field] += Number(row[field]) || 0
        agg.set(key, cur)
      }
      const categories = [...agg.values()].filter((c) => c.total >= minTotal).map((c) => {
        const rejected = c.technical_false_positive
        const sample = c.technical_confirmed + rejected
        const rate = sample > 0 ? rejected / sample : 0
        return { ...c, sample, rejected, technical_unknown: c.total - sample, reject_rate: Number(rate.toFixed(4)),
          suppressed: false, suppression_reason: 'unstratified_inventory_not_policy',
          whitelisted: noiseWhitelisted(c.source, c.category) }
      }).sort((a, b) => b.total - a.total || a.source.localeCompare(b.source)).slice(0, limit)
      return { data: { categories, policy: { suppress_rate: cfg.suppressRate, suppress_min: cfg.suppressMin, daily_quota: cfg.dailyQuota, whitelist: cfg.whitelist, patterns: cfg.patterns } } }
    },

    // 43 号补丁（P0/B3）：存量候选确定性批量处置（零 LLM；抑制不删除，行留审计）
    vuln_candidates_sweep: async (args, repo) => {
      const limit = Math.min(Number(args.limit) || 1000, 5000)
      const dryRun = args.dry_run === true
      const minTotal = Math.max(1, Number(args.min_total) || noiseEnv().suppressMin)
      const sourceFilter = String(args.source || '')
      const now = Date.now()
      const decisions = new Map()
      const hits = { category_noise: [], detection_template: [] }
      let scanned = 0
      let offset = 0
      while (scanned < limit) {
        const page = typeof repo.listCandidatePool === 'function'
          ? repo.listCandidatePool(sourceFilter ? { source: sourceFilter } : {}, { sort: 'created_at', dir: 'asc' }, Math.min(500, limit - scanned), offset)
          : { rows: [] }
        const rows = page.rows || []
        if (!rows.length) break
        for (const row of rows) {
          scanned++
          const source = String(row.source || '')
          const title = String(row.title || '')
          if (noiseWhitelisted(source, findingCategory(source, title)) || explorationSample(row.program_id, row.host, title, row.url)) continue
          const category = findingCategory(source, title)
          const key = JSON.stringify([source, category, row.program_id, row.detector_version, row.applicability_key])
          let decision = decisions.get(key)
          if (!decision) {
            decision = noiseCategoryDecision(repo, source, category, row)
            decisions.set(key, decision)
          }
          if (decision.suppress && decision.sample >= minTotal) hits.category_noise.push(row.id)
        }
        if (rows.length < 500) break
        offset += rows.length
      }
      const all = [...hits.category_noise, ...hits.detection_template]
      const applied = { ignored: 0, ids: [] }
      if (!dryRun && typeof repo.ignoreCandidateIds === 'function') {
        for (const [reason, ids] of Object.entries(hits)) {
          const result = repo.ignoreCandidateIds(ids, now, reason)
          applied.ignored += result.ignored
          applied.ids.push(...result.ids)
        }
      }
      if (!dryRun) repo.invalidateSourceStats?.(null)
      const categoryDetail = [...decisions.entries()].map(([key, d]) => ({ category: key, sample: d.sample, rejected: d.rejected, rate: d.rate, suppress: !!d.suppress }))
        .sort((a, b) => b.sample - a.sample).slice(0, 20)
      return {
        data: { dry_run: dryRun, scanned, matched: all.length, ignored: applied.ignored,
          by_reason: { category_noise: hits.category_noise.length, detection_template: hits.detection_template.length },
          sample_ids: all.slice(0, 20), categories: categoryDetail, policy_min_sample: minTotal },
        events: (!dryRun && all.length) ? [{ name: 'vuln.candidate.suppressed', payload: {
          count: applied.ignored, by_reason: { category_noise: hits.category_noise.length, detection_template: hits.detection_template.length },
          sample_ids: all.slice(0, 50), cause_cmd: 'vuln_candidates_sweep' } }] : [],
      }
    },

    // C6：证据链追加（任意状态，无事件）
    vuln_note: async (args, repo) => {
      const note = String(args.note || '').trim()
      if (!note) throwErr('E_SCHEMA', 'note 必须非空', '补充证据链内容后再调用', false)
      const ref = String(args.evidence_ref || '')
      if (ref && !refPrefix(ref)) throwErr('E_EVIDENCE_REQUIRED', `evidence_ref 格式非法: ${ref}`, '证据引用须为 run_id/flow_id/burp_item/evidence 路径/oob 之一', false)
      const text = ref ? `note: ${note} （ref: ${ref}）` : `note: ${note}`
      repo.appendEvidence(args.finding_id, `${isoPrefix(Date.now())} ${text}`)
      const row = repo.getFinding(args.finding_id)
      if (row.noise === 0) repo.markSyncPending?.(args.finding_id)
      return {
        data: { id: args.finding_id, status: row.status, noted: true },
        events: [],
        before: null, after: { status: row.status, noise: row.noise },
      }
    },

    // C6b：证据包受管写入（verify_replay 的前置：原生 write 无法写域数据目录，
    // 没有本动词 CONFIRMED 机械复核流程无法闭环——这是 09-12 起 vuln-deep 反复
    // E_EVIDENCE_REQUIRED + E_SCOPE_FILE_WRITE 的根因之一）。
    vuln_evidence_put: async (args, repo) => {
      const row = repo.getFinding(args.finding_id)
      if (!row) throwErr('E_NOT_FOUND', `finding #${args.finding_id} 不存在`, '先 vuln_get 核实 id', false)
      if (TERMINAL.includes(row.status)) throwErr('E_STATE', `finding #${args.finding_id} 已终态(${row.status})`, '终态 finding 不可改证据包；如需复验开新 finding', false)
      const raw = String(args.request_text || '')
      if (raw.length > 65536) throwErr('E_SCHEMA', 'request_text 超过 64KiB', '原始请求应只含必要报文', false)
      const parsed = parseRequestText(raw)
      if (parsed.error) throwErr('E_SCHEMA', parsed.error, 'request_text 须为完整 HTTP 报文（首行 METHOD target + Host 头）', false)
      if (!parsed.headers.host && !/^https?:\/\//i.test(parsed.target)) {
        throwErr('E_SCHEMA', 'request_text 缺 Host 头（target 为相对路径时必填）', '补 Host: <目标主机> 头', false)
      }
      const dir = path.join(dataDir, 'evidence', String(args.finding_id))
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'request.txt'), raw.endsWith('\n') ? raw : raw + '\n')
      if (args.note) repo.appendEvidence(args.finding_id, `${isoPrefix(Date.now())} evidence_put: ${String(args.note).slice(0, 200)}`)
      if (row.noise === 0) repo.markSyncPending?.(args.finding_id)
      return {
        data: { id: args.finding_id, evidence_dir: `evidence/${args.finding_id}/`, method: parsed.method, target: parsed.target.slice(0, 200), written: true },
        events: [],
        before: null, after: { status: row.status },
      }
    },

    // C7：认领候选（原子抢占 + TTL 软锁）
    vuln_claim: async (args, repo, ctx) => {
      const claimer = claimerOf(ctx)
      const now = Date.now()
      const res = repo.setClaim(args.finding_id, claimer, now, ttlSec)
      if (!res.ok) {
        const row = repo.getFinding(args.finding_id)
        if (!row || !(row.noise === 1 && row.status === 'new')) throwErr('E_VULN_NOT_CANDIDATE', `finding #${args.finding_id} 非候选池行`, '认领只作用于候选池行', false)
        if (row.claimed_by === claimer) {
          return { data: { id: args.finding_id, claimed_by: claimer, already: true }, events: [], before: { claimed_by: row.claimed_by }, after: { claimed_by: claimer } }
        }
        throwErr('E_VULN_CLAIMED', `候选 #${args.finding_id} 已被 ${row.claimed_by} 认领`, `候选 #${args.finding_id} 已被 ${row.claimed_by} 认领（TTL ${ttlSec}s）。用 vuln_candidates claim_state=available 取下一条`, true)
      }
      return {
        data: { id: args.finding_id, claimed_by: claimer, claimed_at: now, ttl_sec: ttlSec },
        events: [{ name: 'vuln.candidate.claimed', payload: { finding_id: args.finding_id, claimed_by: claimer, claimed_at: now, ttl_sec: ttlSec } }],
        before: { claimed_by: res.previous?.claimed_by ?? null }, after: { claimed_by: claimer },
      }
    },

    // C8：释放认领（宽松幂等；仅认领者本人可释放）
    vuln_release: async (args, repo, ctx) => {
      const claimer = claimerOf(ctx)
      const row = repo.getFinding(args.finding_id)
      if (!row || !row.claimed_by) {
        return { data: { id: args.finding_id, released: false, already: true }, events: [], before: { claimed_by: null }, after: { claimed_by: null } }
      }
      if (row.claimed_by !== claimer && ctx.actor !== 'dashboard') throwErr('E_VULN_CLAIMED', `候选 #${args.finding_id} 认领者是 ${row.claimed_by}，非当前调用方`, '仅认领者可释放（跨会话协作请等 TTL 超时自动可抢占）', true)
      const changed = repo.updateFields(args.finding_id, { claimed_by: null, claimed_at: null, updated_at: Date.now() })
      return {
        data: { id: args.finding_id, released: changed.changed, claimed_by: null },
        events: [],
        before: { claimed_by: row.claimed_by }, after: { claimed_by: null },
      }
    },

    // C9：CONFIRMED 机械复核（重放 request.txt + sha256 + verify-log 追加，不改行）
    vuln_verify_replay: async (args, repo, ctx) => {
      const row = repo.getFinding(args.finding_id)
      if (!row) throwErr('E_NOT_FOUND', `finding #${args.finding_id} 不存在`, '先 vuln_get 核实 id', false)
      const dir = path.join(dataDir, 'evidence', String(args.finding_id))
      const reqFile = path.join(dir, 'request.txt')
      const legacyFile = path.join(dir, 'manifest.json')
      if (!fs.existsSync(reqFile)) {
        let legacy = null
        try { legacy = JSON.parse(fs.readFileSync(legacyFile, 'utf8')) } catch { legacy = null }
        if (legacy && legacy.mode === 'legacy-inline') {
          throwErr('E_EVIDENCE_LEGACY_UNAVAILABLE', `finding #${args.finding_id} 为 legacy-inline 证据（无 request/response）`, '历史 finding 无机械复核能力。先取证产出新证据包（request.txt 落 evidence/{id}/）再复核', false)
        }
        throwErr('E_NOT_FOUND', `evidence/${args.finding_id}/request.txt 不存在`, '先在任务内产出证据包（request.txt 落 evidence/{id}/）再复核', false)
      }
      const parsed = parseRequestText(fs.readFileSync(reqFile, 'utf8'))
      if (parsed.error) throwErr('E_VULN_REPLAY_FAILED', parsed.error, '首行无法解析说明 request.txt 非标准 HTTP 报文，重新产出证据包', true)
      let url = parsed.target
      const hasScheme = /^https?:\/\//i.test(url)
      if (!hasScheme) {
        const hostHdr = parsed.headers['host'] || parsed.headers['Host']
        if (!hostHdr) throwErr('E_VULN_REPLAY_FAILED', 'request.txt 缺 Host 头', '重新产出证据包（须含 Host 头）', true)
        url = `https://${hostHdr}${url.startsWith('/') ? url : '/' + url}`
      }
      const proxy = args.proxy === 'direct' ? 'direct' : 'default'
      if (args.proxy && !['direct', 'default'].includes(args.proxy)) throwErr('E_SCHEMA', '重放出口仅允许 default/direct；固定代理由执行域配置', null)
      if (!row.program_id || normalizeHost(hostOf(url)) !== normalizeHost(row.host)) throwErr('E_EXEC_SCOPE_DENIED', '重放需要 finding 的 Program 与真实 host 绑定', null)
      try {
        const run = await controlledHttp({ program_id: row.program_id, method: parsed.method, url, headers: parsed.headers, body: parsed.body, proxy }, ctx)
        const resp = run.response
        if (resp.state !== 'observed') throwErr('E_VULN_REPLAY_FAILED', `HTTP 重放未完成: ${resp.state}`, null)
        const hash = crypto.createHash('sha256').update(resp.body, 'utf8').digest('hex')
        let verdict = 'REPLAYED'
        if (args.expect_hash) verdict = hash === args.expect_hash ? 'PASS' : 'FAIL(hash 不一致)'
        fs.mkdirSync(dir, { recursive: true })
        fs.appendFileSync(path.join(dir, 'verify-log.md'), `| ${isoPrefix(Date.now())} | ${proxy || 'direct'} | ${resp.status} | sha256:${hash.slice(0, 16)}… | ${verdict} |\n`)
        return {
          data: { id: args.finding_id, run_id: run.run_id, status: resp.status, sha256: hash, verdict, proxy },
          events: [],
          target: `evidence/${args.finding_id}/request.txt`,
          before: null, after: null,
        }
      } catch (e) {
        throwErr('E_VULN_REPLAY_FAILED', `重放失败: ${e?.message}`, '网络波动可重试；持续失败请检查出口代理与目标可达性', true)
      }
    },

    // C10：FGS 节点关联回写（reactor 供 fgs 域订阅回写，覆盖式）
    vuln_attach_fgs: async (args, repo) => {
      const changed = repo.updateFields(args.finding_id, { fgs_node_id: args.fgs_node_id, updated_at: Date.now() })
      if (!changed.changed) throwErr('E_NOT_FOUND', `finding #${args.finding_id} 不存在`, null, false)
      return {
        data: { id: args.finding_id, fgs_node_id: args.fgs_node_id },
        events: [],
        before: null, after: { fgs_node_id: args.fgs_node_id },
      }
    },

    // C12（L1）：从可信 exec 清单复制证据进 evidence/<finding_id>/<run_id>/（tmp+rename 原子），
    // 副本哈希二次核验；证据链追加挂载记录。数据副本归 vuln owns，与 exec 原件经哈希关联。
    vuln_evidence_attach: async (args, repo) => {
      const chk = readPublishedManifest(args.evidence_ref, dataDir)
      if (!chk.ok) throwErr(chk.code, chk.message, chk.hint, false)
      const { runId, manifest } = chk
      const srcRoot = path.join(dataDir, 'results', runId)
      const destRoot = path.join(dataDir, 'evidence', String(args.finding_id), runId)
      fs.mkdirSync(destRoot, { recursive: true })
      let bytes = 0
      for (const f of manifest.files) {
        const src = path.join(srcRoot, f.path)
        const fd = fs.openSync(src, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
        let buf
        try { buf = fs.readFileSync(fd) } finally { fs.closeSync(fd) }
        if (crypto.createHash('sha256').update(buf).digest('hex') !== f.sha256) {
          throwErr('E_VULN_EVIDENCE_TAMPERED', `证据文件哈希不符: ${f.path}`, '证据发布后不可改动；重新发布', false)
        }
        const dest = path.join(destRoot, f.path)
        fs.mkdirSync(path.dirname(dest), { recursive: true })
        const tmp = `${dest}.tmp-${crypto.randomBytes(4).toString('hex')}`
        fs.writeFileSync(tmp, buf)
        fs.renameSync(tmp, dest)
        bytes += buf.length
      }
      const note = `[${iso16()}] evidence attached: run_id:${runId}（${manifest.files.length} 个文件 / ${bytes}B / digest ${String(manifest.digest).slice(0, 16)}…）${args.note ? ' — ' + String(args.note).slice(0, 200) : ''}`
      repo.appendEvidence(args.finding_id, note)
      return {
        data: { finding_id: Number(args.finding_id), evidence_ref: runId, files: manifest.files.length, bytes, dir: `evidence/${args.finding_id}/${runId}`, digest: manifest.digest },
        events: [{ name: 'vuln.evidence.attached', payload: { finding_id: Number(args.finding_id), evidence_ref: runId, files: manifest.files.length, bytes, digest: manifest.digest } }],
        after: { finding_id: Number(args.finding_id), evidence_ref: runId },
      }
    },

    // C11：双权凭证重放对比（verdict 三档；suspected 域内以 actor=script 落 C2 候选）
    vuln_authz_diff: async (args, repo, ctx) => {
      const url = String(args.url || '')
      if (!url) throwErr('E_SCHEMA', 'url 不能为空', null, false)
      const method = String(args.method || 'GET').toUpperCase()
      const body = args.body ? String(args.body) : undefined
      const mk = (h) => {
        const base = { 'content-type': 'application/json', 'user-agent': 'SilkSecAgent-authz-diff' }
        if (!h) return base
        if (typeof h === 'string' && h.trim().startsWith('{')) {
          try { h = JSON.parse(h) } catch { throwErr('E_SCHEMA', 'headers JSON 无法解析', '传对象或有效 JSON 对象字符串，也可使用逐行 Header: Value', false) }
        }
        const pairs = typeof h === 'object' && h !== null && !Array.isArray(h)
          ? Object.entries(h) : String(h).split(/\r?\n/).filter(line => line.trim()).map(line => {
            const i = line.indexOf(':')
            if (i <= 0) throwErr('E_SCHEMA', 'headers 行缺少冒号', '使用 Header: Value 或 JSON 对象', false)
            return [line.slice(0, i).trim(), line.slice(i + 1).trim()]
          })
        for (const [name, value] of pairs) {
          try {
            if (typeof value !== 'string') throw new Error('header 值必须是字符串')
            http.validateHeaderName(name)
            http.validateHeaderValue(name, value)
          } catch { throwErr('E_SCHEMA', 'headers 名称或值无效', '名称必须是合法 HTTP token，值必须是无换行字符串', false) }
          base[name.toLowerCase()] = value
        }
        return base
      }
      const fire = async (headers) => {
        const run = await controlledHttp({ program_id: args.program_id, method, url, headers, body, timeout_ms: 30000 }, ctx)
        const res = run.response
        return { run_id: run.run_id, state: res.state, status: res.status, length: Buffer.byteLength(res.body, 'utf8'), ms: run.elapsed_ms, body: res.body.slice(0, 2000) }
      }
      let low; let high
      const headersLow = mk(args.headers_low), headersHigh = mk(args.headers_high)
      try { low = await fire(headersLow) } catch (e) { throwErr('E_VULN_REPLAY_FAILED', `低权请求失败: ${e?.message}`, '网络波动可重试', true) }
      try { high = await fire(headersHigh) } catch (e) { throwErr('E_VULN_REPLAY_FAILED', `高权请求失败: ${e?.message}`, '网络波动可重试', true) }
      const data = { verdict: 'inconclusive', observation_only: true,
        why: '双响应相似度不能证明身份、私有对象归属或权限违反；使用受控验证器补齐对照',
        low: { run_id: low.run_id, state: low.state, status: low.status, length: low.length, ms: low.ms },
        high: { run_id: high.run_id, state: high.state, status: high.status, length: high.length, ms: high.ms } }
      return { data, events: [], target: url, before: null, after: null }
    },
  }

  const queries = {
    vuln_technical_receipts: async (args, repo) => ({
      receipts: [...new Set(args.ids)].map(id => {
        const row = repo.getTechnicalVerdict(id)
        if (!row || !repo.technicalReceiptTrusted?.(row)) return { id, trusted: false, reason: row ? 'untrusted_receipt' : 'receipt_missing' }
        const evidence = JSON.parse(row.evidence_json)
        return { id, trusted: true, finding_id: row.finding_id, program_id: repo.getFinding(row.finding_id)?.program_id || null,
          verdict: row.verdict, basis: row.basis, evidence_digest: row.evidence_digest, created_at: row.created_at,
          evidence_ref: row.evidence_ref,
          corrects_verdict_id: evidence.corrects_verdict_id || null }
      }),
    }),
    vuln_get: async (args, repo) => {
      const row = repo.getFinding(args.id)
      if (!row) throwErr('E_NOT_FOUND', `finding #${args.id} 不存在`, '先 vuln_list 核实 id', false)
      return { ...row, technical_state: repo.technicalState?.(row.id) || { verdict: 'unknown', latest_verdict_id: null, reason: 'backend_unsupported' } }
    },
    vuln_technical_verdict: async (args, repo) => {
      const row = repo.getTechnicalVerdict(args.id)
      if (!row) throwErr('E_NOT_FOUND', '技术回执不存在', null)
      if (row.evidence_digest !== crypto.createHash('sha256').update(row.evidence_json).digest('hex')) throwErr('E_VULN_EVIDENCE_TAMPERED', '技术回执证据摘要不符', null)
      const evidence = JSON.parse(row.evidence_json)
      const finding = repo.getFinding(row.finding_id)
      return { id: row.id, finding_id: row.finding_id, program_id: finding?.program_id || null,
        verdict: row.verdict, basis: row.basis, created_at: row.created_at,
        evidence_digest: row.evidence_digest, decision_id: evidence.capsule?.decision_id || null,
        evidence_ref: row.evidence_ref, corrects_verdict_id: evidence.corrects_verdict_id || null }
    },
    vuln_list: async (args, repo) => {
      // 42 号补丁（25 号方案 B1）：limit/offset 落到 SQL（旧实现全量返回由总线切片），total 走独立 COUNT。
      const pred = { visibility: args.visibility || 'signal', host: args.host || '', severity: args.severity || '', status: args.status || '', program_id: args.program_id || '', q: args.q || '' }
      const lim = Number.isInteger(args.limit) ? args.limit : 50 // 42 号：保留总线旧默认上限 50，避免缺省全量返回
      const rows = repo.listFindingsWhere(pred, { sort: args.sort || 'created_at', dir: args.dir || 'desc' }, lim, args.offset)
      const total = repo.countFindingsWhere ? repo.countFindingsWhere(pred) : rows.length
      return { rows, total, meta: { paged: true } }
    },
    vuln_candidates: async (args, repo) => {
      const pred = { claim_state: args.claim_state || 'available', severity_min: args.severity_min || '', program_id: args.program_id || '', host: args.host || '' }
      const lim = Number.isInteger(args.limit) ? args.limit : 50
      const { rows, pool, total } = repo.listCandidatePool(pred, { sort: args.sort || 'severity', dir: args.dir || 'desc' }, lim, args.offset)
      return { rows, total: Number.isInteger(total) ? total : rows.length, meta: { pool, paged: true } }
    },
    vuln_stats: async (_args, repo) => {
      return repo.statsFindings()
    },
    // 21 号方案 §4-5：eval 三指标数据源——只回标志位不回证据全文
    vuln_evidence_flags: async (args, repo) => {
      const rows = repo.listFindingsWithEvidence({ program_id: args.program_id || '', limit: args.limit || 500, offset: args.offset || 0 })
      const flags = rows.map((r) => ({
        id: r.id, noise: r.noise, severity: r.severity || 'info', status: r.status,
        vuln_type: r.vuln_type || '', created_at: r.created_at, program_id: r.program_id || null,
        has_capsule: /(^|\s|,|;)capsule:[a-f0-9]{16}/.test(String(r.evidence || '')),
        discovery_origin: r.discovery_origin || 'unknown', candidate_entered_at: r.candidate_entered_at ?? null,
        technical_verdict_id: r.technical_verdict_id ?? null,
        technical_verdict: r.technical_verdict || 'unknown', verification_basis: r.verification_basis || null,
        verified_at: r.verified_at ?? null,
      }))
      return { rows: flags, total: repo.countFindingsWhere({ visibility: 'all', program_id: args.program_id || '' }), meta: { paged: true } }
    },
    vuln_by_asset: async (args, repo) => {
      const host = normalizeHost(args.host)
      const rows = repo.listFindingsWhere({ visibility: 'all', host }, { sort: 'severity', dir: 'desc' })
      const bySev = {}
      let candidatesTotal = 0
      for (const r of rows) {
        if (r.noise === 1 && r.status === 'new') { candidatesTotal++; if (!args.include_candidates) continue }
        const k = r.severity || 'info'
        bySev[k] = (bySev[k] || 0) + 1
      }
      return {
        host,
        total: Object.values(bySev).reduce((a, b) => a + b, 0),
        by_severity: Object.entries(bySev).map(([severity, n]) => ({ severity, n })),
        candidates_total: candidatesTotal,
      }
    },
    vuln_dedup_check: async (args, repo) => {
      const host = String(args.host || '').trim()
      const vulnType = String(args.vuln_type || '').trim()
      // 不变量：host / vuln_type 至少其一必填，禁止空条件全表扫描（返回全量信号）
      if (!host && !vulnType) throwErr('E_SCHEMA', 'vuln_dedup_check 需至少提供 host 或 vuln_type', '补 host（精确匹配）或 vuln_type（同类型去重）后再查', false)
      const { rows, total } = repo.listDedup({ host, vuln_type: vulnType, exclude_id: args.exclude_id || null }, args.limit || 10)
      return { rows, total, meta: { limit: args.limit || 10 } }
    },
    vuln_submission_queue: async (args, repo) => {
      if (typeof repo.listSubmissionQueue !== 'function') throwErr('E_BACKEND_UNAVAILABLE', '当前后端不支持提交队列（需 sqlite-local）', '切回 sqlite-local 后端或改用 vuln_list', true)
      const limit = args.limit || 50
      const overdueDays = Number(args.overdue_days) || 7
      const { rows, total } = repo.listSubmissionQueue(limit)
      const now = Date.now()
      const cutoff = now - overdueDays * 86400 * 1000
      const enriched = rows.map((r) => ({
        ...r,
        age_days: Math.floor((now - (r.created_at || now)) / 86400000),
        overdue: (r.created_at || 0) < cutoff,
      }))
      return { rows: enriched, total, meta: { limit, overdue_days: overdueDays, overdue: enriched.filter((r) => r.overdue).length } }
    },
  }

  const subscribers = {
    onParserProposal: async (envelope) => {
      const payload = envelope?.payload || {}
      const list = readParseProposal(dataDir, payload)?.findings
      if (!Array.isArray(list) || !dispatchRef) return { ok: true, data: { skipped: true } }
      const runId = String(payload.run_id || envelope?.cause?.run_id || '')
      const tool = String(payload.tool || 'nuclei')
      let registered = 0
      let retryableFailed = 0
      let dropped = 0
      const failures = []
      for (const f of list) {
        const title = String(f.title || `${f.host || ''} 被动审计候选：${tool}`)
        const programId = Object.hasOwn(f, 'program_id') ? f.program_id : payload.program_id
        const taskId = Object.hasOwn(f, 'task_id') ? f.task_id : payload.task_id
        try {
          const r = await dispatchRef('vuln', 'register_candidate', {
            title,
            severity: String(f.severity || 'info'),
            host: String(f.host || ''),
            url: String(f.url || ''),
            evidence: f.evidence || (runId ? `run_id:${runId}` : ''),
            source: `parser:${tool}`,
            ...(typeof f.vuln_type === 'string' && f.vuln_type.trim() ? { vuln_type: f.vuln_type.trim() } : {}),
            ...(programId ? { program_id: String(programId) } : {}),
            ...(Number.isInteger(taskId) && taskId > 0 ? { task_id: taskId } : {}),
            ...(f.external_id ? { external_id: String(f.external_id) } : {}),
          }, { actor: 'script', identity: `parser:${tool}:${runId}`, session_id: payload.session_id || envelope.session_id || null })
          if (r.ok) registered++
          else if (r.error && r.error.retryable) { retryableFailed++; failures.push({ title, code: r.error.code, retryable: true }) }
          else { dropped++; failures.push({ title, code: r.error && r.error.code, message: r.error && r.error.message, retryable: false }) }
        } catch (e) {
          // 未预期异常按可重试处理，避免静默丢失
          retryableFailed++
          failures.push({ title, code: 'E_EXCEPTION', message: e?.message, retryable: true })
        }
      }
      // 逐条判定重试性：确定性失败（schema/不变量/权限）逐条登记后丢弃，不再让整事件重试进 DLQ；
      // 仅当存在可重试失败时才返回 partial:true（进 pending 重试链）。
      if (dropped) log(`onParserProposal: ${dropped} 条候选确定性失败（不重试），${registered} 条登记成功`)
      if (retryableFailed) {
        return { ok: true, data: { registered, failed: dropped + retryableFailed, retryable_failed: retryableFailed, dropped, partial: true, failures: failures.slice(0, 20) } }
      }
      return { ok: true, data: { registered, dropped, failures: failures.slice(0, 20) } }
    },
  }

  return { ...commands, queries, invariants, subscribers }
}

// ---------------------------------------------------------------------------
// 组装（测试与 cordis 共用）：manifest + handlers + backend
// ---------------------------------------------------------------------------

export function buildVulnDomain(opts = {}) {
  const dataDir = opts.dataDir || DEFAULT_DATA_DIR
  const backendSel = opts.backend || process.env.SEC_DOMAIN_VULN_BACKEND || 'sqlite-local'
  const dbFile = opts.dbFile || path.join(dataDir, 'asset-graph.db')
  let backend
  if (backendSel === 'http-remote') {
    if (!createVulnHttpBackend) throw new Error('http-remote 后端未组装（缺 @silksec/sec-backend-vuln-http）；回退 sqlite-local 请设 SEC_DOMAIN_VULN_BACKEND=sqlite-local')
    backend = createVulnHttpBackend({ ...(opts.backendOptions || {}), dataDir, dbFile })
  } else {
    backend = createVulnSqliteBackend(opts.backendOptions || {})
  }
  return {
    manifest: VULN_MANIFEST,
    handlers: makeHandlers({ ...opts, dataDir }),
    backend,
  }
}

export const vulnFingerprint = { fpWeak, fpStrong, normalizeHost, hostOf }
export const vulnUtils = {
  sha1, iso16, isoPrefix, refPrefix, EVIDENCE_TOKEN_RE, SEV_RANK, FINDING_STATUS, TERMINAL,
  parseRequestText,
}

// ---------------------------------------------------------------------------
// cordis 插件入口：向总线 registry 注册（不 provide 任何业务方法）
// ---------------------------------------------------------------------------

export function apply(ctx, config = {}) {
  const dataDir = process.env.SEC_DATA_DIR || process.env.DSH_HOME || DEFAULT_DATA_DIR
  const backendSel = process.env.SEC_DOMAIN_VULN_BACKEND || 'sqlite-local'
  try {
    ctx.inject(['secDomainBus'], (child) => {
      const bus = child.secDomainBus
      const domain = buildVulnDomain({
        dataDir,
        backend: backendSel,
        backendOptions: config.backendOptions || {},
        dispatch: (d, v, a, c) => bus.dispatch(d, v, a, c),
        query: (d, n, a, c) => bus.query(d, n, a, c),
      })
      const res = bus.registry.register(domain)
      if (res.ok) {
        log(`vuln 域注册成功（registered=${res.registered}，backend=${domain.backend.name || 'sqlite-local'}）`)
      } else {
        log(`vuln 域注册被拒：${res.error?.code} ${res.error?.message}`)
      }
      // http-remote：启动同步器（混布 overlay 已就位，同步异步化不阻断业务）
      if (backendSel === 'http-remote' && typeof domain.backend.startSyncer === 'function') {
        try { domain.backend.startSyncer() } catch (e) { log(`同步器启动失败：${e?.message}`) }
      }
      // 候选池 TTL 治理（02-vuln §2.5）：每 6h 清一次超期未消化候选（幂等；actor=system 治理通道）
      let expiryTimer = null
      if (res.ok) {
        const ttlDays = Number(process.env.SEC_CANDIDATE_TTL_DAYS) || 14
        const runExpiry = () => bus.dispatch('vuln', 'expire_candidates', { ttl_days: ttlDays }, { actor: 'system' })
          .then((r) => { const n = r && r.ok && r.data && r.data.expired; if (n) log(`候选 TTL 治理：过期出池 ${n} 条（> ${ttlDays}d）`) })
          .catch((e) => log(`候选 TTL 治理异常：${e?.message}`))
        expiryTimer = setInterval(runExpiry, 6 * 3600 * 1000)
        if (expiryTimer.unref) expiryTimer.unref()
      }
      return () => {
        if (expiryTimer) clearInterval(expiryTimer)
        if (typeof domain.backend.stopSyncer === 'function') { try { domain.backend.stopSyncer() } catch { /* noop */ } }
      }
    })
  } catch (e) {
    log(`secDomainBus 注入失败：${e?.message}——vuln 域未注册（总线必须先行挂载）`)
  }
  return null
}
