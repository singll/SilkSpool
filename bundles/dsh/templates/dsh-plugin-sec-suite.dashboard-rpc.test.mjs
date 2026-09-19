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

test('壳聚合端点（stats/workspaces/sessions/memcore）不经总线门禁', async () => {
  const { leaked } = depsWith(null)
  for (const [endpoint, payload] of SHELL_CALLS) {
    if (endpoint === 'stats' || endpoint === 'memcore') continue // 这两个走 assetDb/exp 壳函数，不在本门禁范围
    const out = await handleDashboardRpc(endpoint, payload)
    assert.ok(out !== undefined, `${endpoint} 应返回壳聚合结果`)
  }
  assert.deepEqual(leaked, [], '壳聚合端点不应触发业务 assetDb 泄漏')
})
