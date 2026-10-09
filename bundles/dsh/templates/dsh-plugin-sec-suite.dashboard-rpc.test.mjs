// ==============================================================================
// 看板 RPC 原子化契约测试（16-dashboard §5.3 前置硬闸）
// 运行：node --test dsh-plugin-sec-suite.dashboard-rpc.test.mjs
// 目标：看板业务端点一律经 v5 领域总线 fail-closed，legacy assetDb 直写兜底已拆除。
//   - 总线缺席 → 业务端点显式报错（不再静默降级）
//   - 总线报错 → 抛出域错误码与 hint（不再直调 assetDb）
//   - 总线可用 → 只走总线，任何端点都不触碰 assetDb
//   - 纯壳聚合端点（stats/workspaces/sessions/memcore）不受总线门禁影响
// ==============================================================================

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initDashboardRpc, handleDashboardRpc } from './dsh-plugin-sec-suite.dashboard-rpc.js'

// 业务端点 × 合法入参（含写端点最小必填字段）
const BUSINESS_CALLS = [
  ['ops', {}],
  ['programBindWorkspace', { program_id: 'demo' }],
  ['scopeList', {}],
  ['scopeSaveProgram', { name: 'demo', scope: ['example.com'] }],
  ['scopeDeleteProgram', { name: 'demo' }],
  ['approvalList', {}],
  ['approvalDecide', { id: 1, decision: 'approved' }],
  ['taskRunNow', { id: 1 }],
  ['taskCancel', { id: 1 }],
  ['reportBuild', {}],
  ['evalStats', {}],
  ['audit', {}],
  ['assets', {}],
  ['assetOverview', {}],
  ['assetDetail', { host: 'example.com' }],
  ['assetFamily', { root: 'example.com' }],
  ['endpointHosts', {}],
  ['factStats', {}],
  ['endpoints', {}],
  ['findings', {}],
  ['findingGet', { id: 1 }],
  ['blackboard', {}],
  ['facts', {}],
  ['factGraph', { program_id: 'demo', fact_key: 'k' }],
  ['programs', {}],
  ['tasks', {}],
  ['scheduledTasks', {}],
  ['taskRuns', {}],
  ['taskScheduleUpdate', { id: 1, schedule: { kind: 'interval', every_seconds: 3600 } }],
  ['taskSetStatus', { id: 1, status: 'blocked' }],
  ['taskCreate', { program_id: 'demo', objective: 'x' }],
  ['campaignProgress', { id: 1 }],
  ['campaignPendingDrafts', { id: 1 }],
  ['campaignDispatch', { id: 1, drafts: [{ kind: 'crawl', host: 'example.com' }] }],
  ['findingUpdate', { id: 1, status: 'confirmed' }],
  ['factCorrect', { program_id: 'demo', fact_key: 'k' }],
  ['factDeprecate', { program_id: 'demo', fact_key: 'k' }],
  ['expCards', {}],
  ['expFeedback', { id: 1, verdict: 'helpful' }],
  ['expPromote', { id: 1 }],
  ['expDeprecate', { id: 1 }],
  ['expUpdate', { id: 1 }],
  ['expExportable', { id: 1, exportable: true }],
  ['playbooks', {}],
  ['kbList', {}],
  ['kbRead', { id: 1 }],
  ['factOverview', {}],
  ['rulesList', {}],
  ['rulesRead', { file: 'a.md' }],
  ['knowledgeCoverage', {}],
  ['reports', {}],
  ['reportRead', { file: 'a.md' }],
]

const SHELL_CALLS = [
  ['stats', {}],
  ['workspaces', {}],
  ['sessions', {}],
  ['memcore', {}],
]

// 任何被调用的 assetDb 方法都视为 legacy 兜底泄漏 → 记录并抛错
function depsWith(bus) {
  const leaked = []
  const assetDb = new Proxy({}, {
    get: (_t, prop) => (..._args) => {
      leaked.push(String(prop))
      throw new Error(`legacy assetDb.${String(prop)} 不应被看板端点调用`)
    },
  })
  const deps = {
    dataDir: '/tmp/silksec-dashboard-rpc-test-nonexistent',
    audit: () => {},
    assetDb,
    exp: { memStatus: () => ({ loaded: false }) },
    listManifests: () => [],
    loadManifest: () => null,
    resolveProgramId: () => 'demo',
    sessionIdOf: () => null,
    pairWorkspaces: () => {},
    workspacesList: () => [],
    sessionsList: () => [],
    getWorkspaceRegistry: () => null,
    getSecDomainBus: () => bus,
  }
  initDashboardRpc(deps)
  return { leaked }
}

function okBus() {
  const calls = []
  const result = () => ({ ok: true, rows: [], data: {}, total: 0 })
  return {
    calls,
    query: async (domain, verb, args, ctx) => { calls.push({ kind: 'query', domain, verb, args, ctx }); return result() },
    dispatch: async (domain, verb, args, ctx) => { calls.push({ kind: 'dispatch', domain, verb, args, ctx }); return result() },
  }
}

function errBus() {
  const calls = []
  const failure = () => ({ ok: false, error: { code: 'E_STATE', message: '状态不允许', hint: '先确认状态' } })
  return {
    calls,
    query: async (domain, verb, args, ctx) => { calls.push({ kind: 'query', domain, verb, args, ctx }); return failure() },
    dispatch: async (domain, verb, args, ctx) => { calls.push({ kind: 'dispatch', domain, verb, args, ctx }); return failure() },
  }
}

test('kbList 汇集超过 500 项，保留 external 类型与统计，空的中间页显式失败', async () => {
  const calls = []
  depsWith({ query: async (domain, verb, args) => {
    calls.push({ domain, verb, args })
    return { ok: true, total: 501, rows: Array.from({ length: args.offset ? 1 : 500 }, (_, i) => ({ id: args.offset + i })),
      counts: { external: 501, curated: 0 } }
  } })
  const result = await handleDashboardRpc('kbList', { q: 'x', kind: 'external' })
  assert.equal(result.rows.length, 501)
  assert.equal(result.rows[500].id, 500)
  assert.equal(result.counts.external, 501)
  assert.deepEqual(calls.map(c => c.args.offset), [0, 500])
  assert.ok(calls.every(c => c.domain === 'know' && c.verb === 'kb_list' && c.args.kind === 'external' && c.args.q === 'x' && !('status' in c.args)))
  depsWith({ query: async () => ({ ok: true, rows: [], total: 501 }) })
  await assert.rejects(() => handleDashboardRpc('kbList', {}), /分页不完整/)
})

test('findingUpdate retains terminal review snapshot and explicit correction in both directions', async () => {
  const bus = okBus()
  depsWith(bus)
  const reassessment = { previous_status: 'false_positive', previous_verdict_id: 42, reason: 'independent original evidence review' }
  for (const status of ['confirmed', 'false_positive']) {
    await handleDashboardRpc('findingUpdate', { id: 1, status, evidence: 'run_original', operator: 'reviewer',
      review: { basis: 'original evidence' }, reassessment, corrects_verdict_id: 42, note: 'review reason' })
    const call = bus.calls.at(-1)
    assert.equal(call.verb, status === 'confirmed' ? 'confirm' : 'reject')
    assert.deepEqual(call.args.reassessment, reassessment)
    assert.equal(call.args.corrects_verdict_id, 42)
    assert.equal(call.ctx.operator, 'reviewer')
  }
})

test('总线缺席：全部业务端点 fail-closed 显式报错，不触碰 assetDb', async () => {
  const { leaked } = depsWith(null)
  for (const [endpoint, payload] of BUSINESS_CALLS) {
    await assert.rejects(
      () => handleDashboardRpc(endpoint, payload),
      (err) => {
        assert.match(String(err.message), /领域总线/, `${endpoint} 应报总线缺席`)
        return true
      },
      `${endpoint} 应在总线缺席时拒绝`,
    )
  }
  assert.deepEqual(leaked, [], `业务端点不得回退 assetDb（泄漏: ${leaked.join(',')}）`)
})

test('总线报错：抛出域错误码与 hint，不静默降级 assetDb', async () => {
  const bus = errBus()
  const { leaked } = depsWith(bus)
  const sample = [
    ['findings', {}],
    ['tasks', {}],
    ['assets', {}],
    ['ops', {}],
    ['evalStats', {}],
    ['factStats', {}],
    ['programs', {}],
    ['kbList', {}],
    ['reports', {}],
    ['audit', {}],
    ['findingUpdate', { id: 1, status: 'confirmed' }],
    ['taskRunNow', { id: 1 }],
    ['approvalDecide', { id: 1, decision: 'approved' }],
    ['scopeSaveProgram', { name: 'demo', scope: ['example.com'] }],
  ]
  for (const [endpoint, payload] of sample) {
    await assert.rejects(
      () => handleDashboardRpc(endpoint, payload),
      (err) => {
        assert.equal(err.code, 'E_STATE', `${endpoint} 应透传域错误码`)
        assert.match(String(err.message), /先确认状态/, `${endpoint} 应保留 hint`)
        return true
      },
      `${endpoint} 应在域错误时抛出`,
    )
  }
  assert.ok(bus.calls.length > 0, '应经总线发起调用')
  assert.deepEqual(leaked, [], `域错误不得降级 assetDb（泄漏: ${leaked.join(',')}）`)
})

test('总线可用：全部业务端点只走总线，任何端点都不触碰 assetDb', async () => {
  const bus = okBus()
  const { leaked } = depsWith(bus)
  for (const [endpoint, payload] of BUSINESS_CALLS) {
    // 不关心成功/业务性失败（如 scopeDeleteProgram 查无项目），只断言不落 legacy
    try { await handleDashboardRpc(endpoint, payload) } catch { /* 业务性失败可接受 */ }
  }
  assert.ok(bus.calls.length >= BUSINESS_CALLS.length, `业务端点应至少各发一次总线调用（实际 ${bus.calls.length}）`)
  assert.deepEqual(leaked, [], `总线可用时不得出现 assetDb 调用（泄漏: ${leaked.join(',')}）`)
})

test('壳聚合端点（stats/workspaces/sessions/memcore）不经总线门禁，stats 不再直查 assetDb', async () => {
  const { leaked } = depsWith(null)
  for (const [endpoint, payload] of SHELL_CALLS) {
    const out = await handleDashboardRpc(endpoint, payload)
    assert.ok(out !== undefined, `${endpoint} 应返回壳聚合结果`)
  }
  assert.deepEqual(leaked, [], '壳聚合端点不应触发业务 assetDb 泄漏')
})

test('27 E13: findingUpdate preserves independent review and evidence for technical verdicts', async () => {
  const bus = okBus()
  depsWith(bus)
  for (const status of ['confirmed', 'false_positive']) {
    const review = status === 'confirmed'
      ? { basis: 'independent positive review', reproduction_steps: 'repeat controlled requests', impact: 'unauthorized object read' }
      : { basis: 'independent negative review', expected_behavior: 'only owner reads', observed_behavior: 'other identity denied',
        controls: 'valid identities and successful owner control' }
    await handleDashboardRpc('findingUpdate', { id: 7, status, evidence: 'run_review', review,
      ...(status === 'false_positive' ? { corrects_verdict_id: 3 } : {}),
      operator: 'reviewer', note: 'Independent review of the original observation' })
    const call = bus.calls.at(-1)
    assert.equal(call.verb, status === 'confirmed' ? 'confirm' : 'reject')
    assert.equal(call.args.evidence, 'run_review')
    assert.deepEqual(call.args.review, review)
    assert.equal(call.ctx.operator, 'reviewer')
    if (status === 'false_positive') assert.equal(call.args.corrects_verdict_id, 3)
  }
})

test('27 candidate confirmation forwards reproduction and impact without creating an independent review', async () => {
  const bus = okBus()
  depsWith(bus)
  await handleDashboardRpc('findingUpdate', { id: 7, status: 'confirmed', evidence: 'capsule:0123456789abcdef',
    reproduction_steps: 'repeat the controlled owner-only experiment', impact: 'another identity reads a private object' })
  const call = bus.calls.at(-1)
  assert.equal(call.verb, 'confirm')
  assert.equal(call.args.reproduction_steps, 'repeat the controlled owner-only experiment')
  assert.equal(call.args.impact, 'another identity reads a private object')
  assert.equal(call.args.review, undefined)
})

test('stats：经各域查询聚合，单域失败 → null + degraded，不整体失败', async () => {
  // 总线缺席：全部来源失败 → 五指标 null + degraded 覆盖，并返回对象（不抛）
  const { leaked } = depsWith(null)
  const out = await handleDashboardRpc('stats', {})
  assert.equal(out.approval, null)
  assert.equal(out.vuln, null)
  assert.equal(out.tasks, null)
  assert.equal(out.discipline, null)
  assert.equal(out.inventory, null)
  assert.equal(out.scope, null)
  assert.equal(out.findings_noise, null, 'WP10：vuln 来源失败时噪声候选以 null(未知)呈现，不得显示 0')
  assert.deepEqual(out.degraded.sort(), ['approval', 'asset', 'ledger', 'scope', 'task', 'vuln'])
  assert.deepEqual(leaked, [], 'stats 不得直查 assetDb')

  // 总线可用：stats 只走域查询，五域各自发起（approval/vuln/task×3/ledger/asset/endpoint/fact）
  const bus = okBus()
  depsWith(bus)
  const ok = await handleDashboardRpc('stats', {})
  assert.ok(Array.isArray(ok.degraded))
  const domains = new Set(bus.calls.map((c) => c.domain))
  for (const d of ['approval', 'vuln', 'task', 'ledger', 'asset', 'endpoint', 'fact', 'scope']) {
    assert.ok(domains.has(d), `stats 应经 ${d} 域查询聚合`)
  }
})

test('27 WP11: stats requests inventory without expanding asset families', async () => {
  const bus = okBus()
  const query = bus.query
  bus.query = async (domain, verb, args, ctx) => {
    if (domain === 'asset') {
      assert.equal(verb, 'inventory', 'dashboard counters must not fetch the full family overview')
      return { ok: true, data: { total: 17, by_type: [{ type: 'web', n: 17 }] } }
    }
    return query(domain, verb, args, ctx)
  }
  depsWith(bus)
  const result = await handleDashboardRpc('stats', {})
  assert.equal(result.inventory?.assets, 17)
  assert.deepEqual(result.assets_by_type, [{ type: 'web', n: 17 }])
})
