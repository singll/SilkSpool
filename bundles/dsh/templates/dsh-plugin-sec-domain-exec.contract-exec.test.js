// ==============================================================================
// @silksec/sec-domain-exec 契约测试（10-exec.md：happy path / 守卫链 / parser proposal /
// explicit_only 幂等 / 查询 / spawn_worker）
// 运行：node --test test/contract-exec.test.js（插件组装目录内，type:module）
// 全部用例使用临时目录/临时库/临时 manifest，绝不触碰 /opt/silkspool/dsh/data。
// ==============================================================================

import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createBus } from '../../sec-domain-bus/index.js'
import { buildKnowDomain } from '../../sec-domain-know/index.js'
import { buildAssetDomain } from '../../sec-domain-asset/index.js'
import { buildEndpointDomain } from '../../sec-domain-endpoint/index.js'
import { buildVulnDomain } from '../../sec-domain-vuln/index.js'

process.env.SEC_NODE_BIN = '/bin/echo'
process.env.SEC_DSH_BIN = '/bin/echo'
process.env.SEC_NO_SANDBOX = '1'
const { buildExecDomain } = await import('../index.js')

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'sec-domain-exec-')) }

function writeManifest(dataDir, name, body) {
  fs.mkdirSync(path.join(dataDir, 'tools.d'), { recursive: true })
  fs.writeFileSync(path.join(dataDir, 'tools.d', `${name}.yaml`), body)
}

function makeEnv(opts = {}) {
  const dir = tmpDir()
  const dataDir = path.join(dir, 'data')
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(path.join(dataDir, 'scope.yml'), 'programs:\n  - name: "test-src"\n    scope:\n      - "*.example.com"\n')
  if (opts.aliases) fs.writeFileSync(path.join(dir, 'bus.aliases.yaml'), opts.aliases)
  writeManifest(dataDir, 'echo-test', 'name: echo-test\nbinary: /bin/echo\nstage: recon\nrisk: passive\ntimeout: 30\nargs_template: "{{msg|hello}}"\n')
  writeManifest(dataDir, 'subfinder', 'name: subfinder\nbinary: /bin/echo\nstage: recon\nrisk: active\ntimeout: 30\ntarget_param: target\nargs_template: "-d {{target}}"\n')
  writeManifest(dataDir, 'targetless-active', 'name: targetless-active\nbinary: /bin/echo\nstage: vuln\nrisk: active\ntimeout: 30\nargs_template: "-x"\n')
  writeManifest(dataDir, 'httpx', 'name: httpx\nbinary: /bin/cat\nstage: recon\nrisk: passive\ntimeout: 30\nrequires: [domains]\nproduces: [live_hosts]\nargs_template: "{{fixture}}"\nparser: jsonl_httpx\n')
  const bus = createBus({
    dataDir,
    dbFile: path.join(dir, 'asset-graph.db'),
    aliasesFile: path.join(dir, 'bus.aliases.yaml'),
    auditFile: path.join(dir, 'audit.jsonl'),
    eventsDir: path.join(dir, 'events'),
    sidecars: false,
    startDispatcherTimer: false,
    dispatcherStartDelayMs: 0,
  })
  const domain = buildExecDomain({ dataDir, dispatch: (d, v, a, c) => bus.dispatch(d, v, a, c), query: (d, n, a, c) => bus.query(d, n, a, c) })
  const reg = bus.registry.register(domain)
  assert.equal(reg.ok, true, `exec 域应注册成功：${reg.error?.message || ''}`)
  return { dir, dataDir, bus }
}

function readAudit(dir) {
  const f = path.join(dir, 'audit.jsonl')
  if (!fs.existsSync(f)) return []
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
}
function readEvents(dir) {
  const f = path.join(dir, 'events', 'exec.jsonl')
  if (!fs.existsSync(f)) return []
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
}

test('真实 exec run_id 可用于漏洞证据，裸 ID 与解析器 run_id: 前缀均验证落盘', async () => {
  const { dataDir, bus } = makeEnv()
  assert.equal(bus.registry.register(buildVulnDomain({ dataDir })).ok, true)
  const run = await bus.dispatch('exec', 'run_cli', { tool: 'echo-test', params: { msg: 'local evidence fixture' } }, { actor: 'model' })
  assert.equal(run.ok, true)
  for (const [i, evidence] of [run.data.run_id, `run_id:${run.data.run_id} template:fixture`].entries()) {
    const signal = await bus.dispatch('vuln', 'register_signal', {
      title: `本地证据编号兼容测试用例 ${i}`, severity: 'low', host: 'a.example.com',
      evidence, reproduction_steps: '仅验证本地 echo 执行产物的引用格式', impact: '本地契约测试，无外部目标',
    }, { actor: 'model' })
    assert.equal(signal.ok, true, signal.error?.message)
    const confirm = await bus.dispatch('vuln', 'confirm', { finding_id: signal.data.id, evidence }, { actor: 'model' })
    assert.equal(confirm.ok, true, confirm.error?.message)
  }
  const missing = await bus.dispatch('vuln', 'confirm', { finding_id: 99999, evidence: 'run_id:rmissing000000' }, { actor: 'model' })
  assert.equal(missing.error.code, 'E_EVIDENCE_REQUIRED')
})

test('失败 CLI 保留 stderr；manifest_list 返回可直接核对的必填参数与默认值', async () => {
  const { dataDir, bus } = makeEnv()
  const missingFile = path.join(dataDir, 'fixture-does-not-exist')
  const r = await bus.dispatch('exec', 'run_cli', { tool: 'httpx', params: { fixture: missingFile } }, { actor: 'model' })
  assert.equal(r.ok, true)
  assert.equal(r.data.exit_code, 1)
  assert.match(r.data.stderr_tail, /fixture-does-not-exist/)
  assert.match(fs.readFileSync(path.join(dataDir, 'results', r.data.run_id, 'stderr.log'), 'utf8'), /fixture-does-not-exist/)
  const required = await bus.query('exec', 'manifest_list', { name: 'httpx' }, { actor: 'model' })
  assert.equal(required.total, 1)
  assert.deepEqual(required.rows[0].params, [{ name: 'fixture', required: true, default: null }])
  const defaults = await bus.query('exec', 'manifest_list', { name: 'echo-test' }, { actor: 'model' })
  assert.deepEqual(defaults.rows[0].params, [{ name: 'msg', required: false, default: 'hello' }])
  assert.equal(defaults.rows[0].timeout_sec, 30)
  writeManifest(dataDir, 'implicit-params', 'name: implicit-params\nbinary: /bin/echo\nargs_template: "{{outdir}} {{run_id}} {{target}} {{target}} {{count|5}}"\n')
  const implicit = await bus.query('exec', 'manifest_list', { name: 'implicit-params' }, { actor: 'model' })
  assert.deepEqual(implicit.rows[0].params, [{ name: 'target', required: true, default: null }, { name: 'count', required: false, default: '5' }])
})

test('目标参数清洗：重复协议前缀被剥到单层，授权与渲染用同一份', async () => {
  const { dataDir, bus } = makeEnv()
  writeManifest(dataDir, 'echo-target', 'name: echo-target\nbinary: /bin/echo\nstage: vuln\nrisk: active\ntimeout: 30\ntarget_param: target\nargs_template: "-u {{target}}"\n')
  const r = await bus.dispatch('exec', 'run_cli', { tool: 'echo-target', params: { target: 'https://https://https://a.example.com, http://https://b.example.com' } }, { actor: 'model' })
  assert.equal(r.ok, true, r.error?.message)
  const cmd = fs.readFileSync(path.join(dataDir, 'results', r.data.run_id, 'cmd.txt'), 'utf8')
  assert.match(cmd, /-u https:\/\/a\.example\.com,https:\/\/b\.example\.com/)
  assert.doesNotMatch(cmd, /https:\/\/https:/)
})

test('渲染后兜底：模板协议前缀叠加模型传入的完整 URL 不产生双 scheme', async () => {
  const { dataDir, bus } = makeEnv()
  writeManifest(dataDir, 'echo-ffuf', 'name: echo-ffuf\nbinary: /bin/echo\nstage: recon\nrisk: active\ntimeout: 30\ntarget_param: target\nargs_template: "-u {{target_url|https://}}{{target}}/FUZZ -w {{wordlist|/tmp/wl.txt}}"\n')
  const full = await bus.dispatch('exec', 'run_cli', { tool: 'echo-ffuf', params: { target: 'https://a.example.com' } }, { actor: 'model' })
  assert.equal(full.ok, true, full.error?.message)
  const cmd1 = fs.readFileSync(path.join(dataDir, 'results', full.data.run_id, 'cmd.txt'), 'utf8')
  assert.match(cmd1, /-u https:\/\/a\.example\.com\/FUZZ/)
  assert.doesNotMatch(cmd1, /https?:\/\/https?:\/\//)
  const bare = await bus.dispatch('exec', 'run_cli', { tool: 'echo-ffuf', params: { target: 'b.example.com' } }, { actor: 'model' })
  assert.equal(bare.ok, true, bare.error?.message)
  const cmd2 = fs.readFileSync(path.join(dataDir, 'results', bare.data.run_id, 'cmd.txt'), 'utf8')
  assert.match(cmd2, /-u https:\/\/b\.example\.com\/FUZZ -w \/tmp\/wl\.txt/)
})

test('CLI 退出不伪造 tool:name 打法链反馈，也不产生后台 E_SCHEMA', async () => {
  const { dir, dataDir, bus } = makeEnv()
  assert.equal(bus.registry.register(buildKnowDomain({ dataDir })).ok, true)
  const result = await bus.dispatch('exec', 'run_cli', { tool: 'echo-test', params: { msg: 'ok' } }, { actor: 'model' })
  assert.equal(result.ok, true)
  assert.deepEqual(readAudit(dir).filter(a => a.domain === 'know' && a.cmd === 'pb_outcome'), [])
})

test('大批 parser 产物落盘后事件仍低于 8KiB，不把执行成功变成总线错误', async () => {
  const { dir, dataDir, bus } = makeEnv()
  const options = { dataDir, dispatch: (d, v, a, c) => bus.dispatch(d, v, a, c) }
  const asset = buildAssetDomain(options), endpoint = buildEndpointDomain(options)
  assert.equal(bus.registry.register(asset).ok, true)
  assert.equal(bus.registry.register(endpoint).ok, true)
  const file = path.join(dir, 'batch.jsonl')
  fs.writeFileSync(file, Array.from({ length: 100 }, (_, i) => JSON.stringify({ host: `h${i}.example.com`, url: `https://h${i}.example.com/api/${'a'.repeat(80)}`, status_code: 200 })).join('\n'))
  const r = await bus.dispatch('exec', 'run_cli', { tool: 'httpx', params: { fixture: file } }, { actor: 'model' })
  assert.equal(r.ok, true, r.error?.message)
  const proposal = JSON.parse(fs.readFileSync(path.join(dataDir, 'results', r.data.run_id, 'proposal.json')))
  assert.equal(proposal.endpoints.length, 100)
  await bus._internal.dispatcherTick()
  assert.ok(readEvents(dir).filter(e => e.name === 'exec.run.completed').length >= 2)
  for (const e of readEvents(dir)) assert.ok(Buffer.byteLength(JSON.stringify(e.payload)) < 8192)
  for (const e of readEvents(dir).filter(e => e.name === 'exec.run.completed')) {
    await asset.handlers.subscribers.onRunProposal(e)
    await endpoint.handlers.subscribers.onRunProposal(e)
  }
  assert.equal(bus._internal.db().prepare('SELECT COUNT(*) n FROM assets').get().n, 100)
  assert.equal(bus._internal.db().prepare('SELECT COUNT(*) n FROM endpoints').get().n, 100)
  const event = readEvents(dir).find(e => e.payload?.parse_proposal?.kind === 'endpoints')
  fs.writeFileSync(path.join(dataDir, 'results', r.data.run_id, 'proposal.json'), '{}')
  await assert.rejects(endpoint.handlers.subscribers.onRunProposal(event), { code: 'E_EXEC_PROPOSAL_INTEGRITY' })
})

test('worker 工具投影超时覆盖可申请的 7200 秒，父会话收尾时不再派工', async () => {
  const { bus } = makeEnv()
  const tools = []
  bus._internal.registerTools({ tools: { register: def => tools.push(def) } })
  const tool = tools.find(t => t.name === 'exec_spawn_worker')
  assert.ok(tool.timeoutMs > 7200 * 1000)
  const before = process.env.SEC_WORKER_DEADLINE_MS
  process.env.SEC_WORKER_DEADLINE_MS = String(Date.now()+30000)
  try {
    const result = await tool.execute({ task: '本地预算 fixture' }, {})
    assert.equal(result.error.code, 'E_EXEC_WORKER_BUDGET')
    assert.equal(result.error.retryable, false)
  } finally {
    if (before === undefined) delete process.env.SEC_WORKER_DEADLINE_MS; else process.env.SEC_WORKER_DEADLINE_MS = before
  }
})

// ---------------------------------------------------------------------------
// 1. happy path
// ---------------------------------------------------------------------------

test('happy path: run_cli echo 执行 + 落盘 + 摘要 + run.started/completed', async () => {
  const { dir, dataDir, bus } = makeEnv()
  const r = await bus.dispatch('exec', 'run_cli', { tool: 'echo-test', params: { msg: 'world' } }, { actor: 'model', session_id: 'sess_1' })
  assert.equal(r.ok, true)
  assert.equal(r.data.exit_code, 0)
  assert.ok(r.data.run_id.startsWith('r'))
  assert.ok(readEvents(dir).find((e) => e.name === 'exec.run.started' && e.payload.tool === 'echo-test'))
  assert.ok(fs.existsSync(path.join(dataDir, 'results', r.data.run_id, 'meta.json')))
  assert.ok(fs.existsSync(path.join(dataDir, 'results', r.data.run_id, 'cmd.txt')))
  assert.ok(readAudit(dir).find((a) => a.kind === 'command' && a.cmd === 'run_cli' && a.result === 'ok'))
})

// ---------------------------------------------------------------------------
// 2. 守卫链（fail-closed）
// ---------------------------------------------------------------------------

test('schema: 缺 tool/params 被拒', async () => {
  const { bus } = makeEnv()
  const r = await bus.dispatch('exec', 'run_cli', {}, { actor: 'model' })
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'E_SCHEMA')
})

test('G0: 未知工具 → E_EXEC_MANIFEST_MISSING', async () => {
  const { bus } = makeEnv()
  const r = await bus.dispatch('exec', 'run_cli', { tool: 'no-such-tool', params: {} }, { actor: 'model' })
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'E_EXEC_MANIFEST_MISSING')
})

test('G1: 无 target_param 且 risk≥active → E_EXEC_TARGETLESS_ACTIVE', async () => {
  const { bus } = makeEnv()
  const r = await bus.dispatch('exec', 'run_cli', { tool: 'targetless-active', params: {} }, { actor: 'model' })
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'E_EXEC_TARGETLESS_ACTIVE')
})

test('G4: 目标不在 scope → E_EXEC_SCOPE_DENIED', async () => {
  const { bus } = makeEnv()
  const r = await bus.dispatch('exec', 'run_cli', { tool: 'subfinder', params: { target: 'evil.com' } }, { actor: 'model' })
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'E_EXEC_SCOPE_DENIED')
})

test('G4: 目标在 scope 放行（*.example.com）', async () => {
  const { bus } = makeEnv()
  const r = await bus.dispatch('exec', 'run_cli', { tool: 'subfinder', params: { target: 'a.example.com' } }, { actor: 'model' })
  assert.equal(r.ok, true)
  assert.equal(r.data.exit_code, 0)
})

// ---------------------------------------------------------------------------
// 3. parser proposal（parser 直写归零）
// ---------------------------------------------------------------------------

test('parser: httpx jsonl → proposal.json + exec.run.completed(assets/endpoints)', async () => {
  const { dir, dataDir, bus } = makeEnv()
  const fixture = path.join(dir, 'httpx.jsonl')
  fs.writeFileSync(fixture, [
    '{"host":"a.example.com","url":"https://a.example.com/api/v1?x=1","status_code":200,"title":"T","webserver":"nginx","tech":["Nginx","Vue"]}',
    '{"host":"b.example.com","url":"https://b.example.com/","status_code":200,"tech":["CloudFlare"]}',
  ].join('\n') + '\n')
  const r = await bus.dispatch('exec', 'run_cli', { tool: 'httpx', params: { fixture } }, { actor: 'model' })
  assert.equal(r.ok, true)
  assert.equal(r.data.parse_counts.assets, 2)
  assert.equal(r.data.parse_counts.endpoints, 2)
  assert.equal(r.data.parse_counts.fingerprints, 3)
  assert.ok(fs.existsSync(path.join(dataDir, 'results', r.data.run_id, 'proposal.json')))
  const evs = readEvents(dir).filter((e) => e.name === 'exec.run.completed')
  assert.ok(evs.length >= 2)
  const assetEv = evs.find((e) => e.payload.parse_proposal && e.payload.parse_proposal.kind === 'assets')
  assert.equal(assetEv.payload.parse_proposal.assets.length, 2)
  assert.equal(assetEv.payload.parse_proposal.fingerprints.length, 3)
  const epEv = evs.find((e) => e.payload.parse_proposal && e.payload.parse_proposal.kind === 'endpoints')
  assert.equal(epEv.payload.parse_proposal.endpoints.length, 2)
})

// ---------------------------------------------------------------------------
// 4. explicit_only 幂等
// ---------------------------------------------------------------------------

test('explicit_only: 无 key 每次独立执行；同 key 同参 replay', async () => {
  const { bus } = makeEnv()
  const args = { tool: 'echo-test', params: { msg: 'x' } }
  const r1 = await bus.dispatch('exec', 'run_cli', args, { actor: 'model' })
  assert.equal(r1.replay, false)
  const r2 = await bus.dispatch('exec', 'run_cli', args, { actor: 'model' })
  assert.equal(r2.replay, false)
  assert.notEqual(r1.data.run_id, r2.data.run_id, '无 key 时每次独立执行（重扫是合法业务）')
  const withKey = { tool: 'echo-test', params: { msg: 'x' }, idempotency_key: 'k-1' }
  const k1 = await bus.dispatch('exec', 'run_cli', withKey, { actor: 'model' })
  assert.equal(k1.replay, false)
  const k2 = await bus.dispatch('exec', 'run_cli', withKey, { actor: 'model' })
  assert.equal(k2.replay, true)
})

// ---------------------------------------------------------------------------
// 5. 查询
// ---------------------------------------------------------------------------

test('query: grep_result / page_result / manifest_list / plan_chain', async () => {
  const { dir, dataDir, bus } = makeEnv()
  const fixture = path.join(dir, 'httpx.jsonl')
  fs.writeFileSync(fixture, '{"host":"a.example.com","url":"https://a.example.com/x"}\n')
  const r = await bus.dispatch('exec', 'run_cli', { tool: 'httpx', params: { fixture } }, { actor: 'model' })
  const runId = r.data.run_id
  const g = await bus.query('exec', 'grep_result', { run_id: runId, pattern: 'a.example.com' }, { actor: 'model' })
  assert.ok(g.data.matched >= 1)
  const p = await bus.query('exec', 'page_result', { run_id: runId }, { actor: 'model' })
  assert.ok(p.data.total_lines >= 1)
  assert.ok(p.data.lines.some((l) => l.includes('a.example.com')))
  const m = await bus.query('exec', 'manifest_list', {}, { actor: 'model' })
  assert.ok(m.total >= 4)
  const chain = await bus.query('exec', 'plan_chain', { have: ['domains'], want: 'live_hosts' }, { actor: 'model' })
  assert.equal(chain.ok, true)
  assert.ok(chain.data.chain.includes('httpx'))
  const unreachable = await bus.query('exec', 'plan_chain', { have: ['domains'], want: 'findings' }, { actor: 'model' })
  assert.equal(unreachable.ok, false)
  assert.equal(unreachable.error.code, 'E_EXEC_CHAIN_UNREACHABLE')
})

// ---------------------------------------------------------------------------
// 6. spawn_worker（伪 DSH 二进制，确定性收尾）
// ---------------------------------------------------------------------------

test('spawn_worker: 伪 worker 完成 + worker.spawned/finished 事件', async () => {
  const { dir, bus } = makeEnv()
  const r = await bus.dispatch('exec', 'spawn_worker', { task: '自包含任务', timeout: 5 }, { actor: 'model' })
  assert.equal(r.ok, true)
  assert.equal(r.data.exit_code, 0)
  assert.ok(r.data.run_id.startsWith('w'))
  assert.ok(readEvents(dir).find((e) => e.name === 'exec.worker.spawned'))
  assert.ok(readEvents(dir).find((e) => e.name === 'exec.worker.finished' && e.payload.status === 'done'))
})

// ---------------------------------------------------------------------------
// 6b. L6（学习专项 §10 调度器切换）：spawn_worker cwd/task_id——调度器派单契约
// ---------------------------------------------------------------------------

test('L6: spawn_worker cwd 仅 scheduler 可用 + 目录校验 + spawned 事件带 task_id/cwd', async () => {
  const { dir, bus } = makeEnv()
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-exec-cwd-'))
  // model 传 cwd → 拒（防任意目录逃逸）
  const denied = await bus.dispatch('exec', 'spawn_worker', { task: '逃逸尝试', cwd: '/etc' }, { actor: 'model' })
  assert.equal(denied.ok, false)
  assert.equal(denied.error.code, 'E_EXEC_CWD_FORBIDDEN')
  // scheduler 传不存在目录 → 拒
  const bad = await bus.dispatch('exec', 'spawn_worker', { task: '坏目录', cwd: '/no/such/dir-l6' }, { actor: 'scheduler' })
  assert.equal(bad.ok, false)
  assert.equal(bad.error.code, 'E_EXEC_CWD_INVALID')
  // scheduler 传合法目录 + task_id → 放行，spawned 事件带 task_id 与 cwd（任务域强联动记账依据）
  const ok = await bus.dispatch('exec', 'spawn_worker', { task: '调度派单', timeout: 5, cwd: ws, task_id: 4242 }, { actor: 'scheduler' })
  assert.equal(ok.ok, true, ok.error?.message)
  const spawned = readEvents(dir).find((e) => e.name === 'exec.worker.spawned')
  assert.equal(spawned.payload.task_id, 4242)
  assert.equal(spawned.payload.cwd, fs.realpathSync(ws), '工作区路径 realpath 后透传')
})

// ---------------------------------------------------------------------------
// 7. 别名
// ---------------------------------------------------------------------------

test('alias: run_cli → exec_run_cli（static 直通 + deprecated_use）', async () => {
  const { dir, bus } = makeEnv({ aliases: 'aliases:\n  run_cli: exec_run_cli\n' })
  const r = await bus.dispatch('', 'run_cli', { tool: 'echo-test', params: { msg: 'hi' } }, { actor: 'model' })
  assert.equal(r.ok, true)
  assert.equal(r.domain, 'exec')
  assert.equal(r.cmd, 'run_cli')
  assert.ok(readAudit(dir).find((a) => a.kind === 'deprecated_use' && a.alias === 'run_cli'))
})

// ---------------------------------------------------------------------------
// 8. L1（学习专项 §3.3）：exec_evidence_publish——staging → 宿主校验 → 发布 + manifest/SHA-256
// ---------------------------------------------------------------------------

async function runWithStaging(bus, dataDir, files = { 'poc.txt': 'proof-of-concept 证据内容', 'sub/resp.bin': 'binary-ish' }) {
  const run = await bus.dispatch('exec', 'run_cli', { tool: 'echo-test', params: { msg: 'evidence source' } }, { actor: 'model' })
  assert.equal(run.ok, true)
  const runId = run.data.run_id
  const staging = path.join(dataDir, 'results', runId, 'staging')
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(staging, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content)
  }
  return runId
}

test('L1: evidence_publish happy path——manifest+SHA-256+staging 清空+事件', async () => {
  const { dir, dataDir, bus } = makeEnv()
  const runId = await runWithStaging(bus, dataDir)
  const pub = await bus.dispatch('exec', 'evidence_publish', { run_id: runId }, { actor: 'system' })
  assert.equal(pub.ok, true, pub.error?.message)
  assert.equal(pub.data.files, 2)
  assert.match(pub.data.digest, /^[0-9a-f]{64}$/)
  const manifest = JSON.parse(fs.readFileSync(path.join(dataDir, 'results', runId, 'evidence-manifest.json'), 'utf8'))
  assert.equal(manifest.run_id, runId)
  assert.equal(manifest.files.length, 2)
  const crypto = await import('node:crypto')
  for (const f of manifest.files) {
    const dest = path.join(dataDir, 'results', runId, f.path)
    assert.ok(fs.existsSync(dest), `已发布文件存在: ${f.path}`)
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(dest)).digest('hex'), f.sha256)
  }
  assert.ok(!fs.existsSync(path.join(dataDir, 'results', runId, 'staging')), '发布后 staging 清空')
  assert.ok(readEvents(dir).find((e) => e.name === 'exec.evidence.published' && e.payload.run_id === runId))
})

test('L1: evidence_publish actor 闸（model/dashboard 被拒，E_ACTOR_FORBIDDEN）', async () => {
  const { dataDir, bus } = makeEnv()
  const runId = await runWithStaging(bus, dataDir)
  for (const actor of ['model', 'dashboard']) {
    const r = await bus.dispatch('exec', 'evidence_publish', { run_id: runId }, { actor })
    assert.equal(r.ok, false)
    assert.equal(r.error.code, 'E_ACTOR_FORBIDDEN')
  }
})

test('L1: evidence_publish 拒绝越权/不受信文件——软链、硬链逃逸、不存在 run、空 staging', async () => {
  const { dataDir, bus } = makeEnv()
  // 不存在的 run
  const missing = await bus.dispatch('exec', 'evidence_publish', { run_id: 'rmissing000000' }, { actor: 'system' })
  assert.equal(missing.ok, false)
  assert.equal(missing.error.code, 'E_NOT_FOUND')
  // 软链逃逸
  const runId = await runWithStaging(bus, dataDir)
  const staging = path.join(dataDir, 'results', runId, 'staging')
  fs.symlinkSync(path.join(dataDir, 'scope.yml'), path.join(staging, 'escape.txt'))
  const symlinked = await bus.dispatch('exec', 'evidence_publish', { run_id: runId }, { actor: 'system' })
  assert.equal(symlinked.ok, false)
  assert.equal(symlinked.error.code, 'E_EXEC_EVIDENCE_UNSAFE')
  fs.unlinkSync(path.join(staging, 'escape.txt'))
  // 硬链逃逸嫌疑（nlink>1）
  fs.linkSync(path.join(staging, 'poc.txt'), path.join(staging, 'hardlinked.txt'))
  const hardlinked = await bus.dispatch('exec', 'evidence_publish', { run_id: runId }, { actor: 'system' })
  assert.equal(hardlinked.ok, false)
  assert.equal(hardlinked.error.code, 'E_EXEC_EVIDENCE_UNSAFE')
  fs.unlinkSync(path.join(staging, 'hardlinked.txt'))
  // 空 staging
  const run2 = await bus.dispatch('exec', 'run_cli', { tool: 'echo-test', params: { msg: 'x' } }, { actor: 'model' })
  const empty = await bus.dispatch('exec', 'evidence_publish', { run_id: run2.data.run_id }, { actor: 'system' })
  assert.equal(empty.ok, false)
  assert.equal(empty.error.code, 'E_EXEC_STAGING_EMPTY')
  // 清理障碍后正常发布
  const ok = await bus.dispatch('exec', 'evidence_publish', { run_id: runId }, { actor: 'system' })
  assert.equal(ok.ok, true, ok.error?.message)
})

test('L1: evidence_publish 写完校验——仍在增长的文件被拒（retryable），写停后可发布', async () => {
  const { dataDir, bus } = makeEnv()
  const runId = await runWithStaging(bus, dataDir, { 'growing.log': 'seed\n' })
  const target = path.join(dataDir, 'results', runId, 'staging', 'growing.log')
  const writer = setInterval(() => { try { fs.appendFileSync(target, `tick ${Date.now()}\n`) } catch { /* noop */ } }, 10)
  const busy = await bus.dispatch('exec', 'evidence_publish', { run_id: runId }, { actor: 'system' })
  clearInterval(writer)
  assert.equal(busy.ok, false)
  assert.equal(busy.error.code, 'E_EXEC_EVIDENCE_UNFINISHED')
  assert.equal(busy.error.retryable, true)
  const ok = await bus.dispatch('exec', 'evidence_publish', { run_id: runId }, { actor: 'system' })
  assert.equal(ok.ok, true, ok.error?.message)
})

test('L1: evidence_publish 自然键幂等——重复发布回放首个结果，已发布内容冻结不覆盖', async () => {
  const { dataDir, bus } = makeEnv()
  const runId = await runWithStaging(bus, dataDir)
  const first = await bus.dispatch('exec', 'evidence_publish', { run_id: runId }, { actor: 'system' })
  assert.equal(first.ok, true)
  // 发布后篡改已发布文件，再重放：返回首个结果（发布内容冻结），不重新执行
  fs.appendFileSync(path.join(dataDir, 'results', runId, 'poc.txt'), 'tamper')
  const again = await bus.dispatch('exec', 'evidence_publish', { run_id: runId }, { actor: 'system' })
  assert.equal(again.ok, true)
  assert.equal(again.replay, true)
  assert.equal(again.data.digest, first.data.digest)
})

// ---- H2 回归：exclude 优先于 scope（跨项目顺序不得让先前项目的 scope 放行排除域名）----
test('H2: 多项目时任一 exclude 命中即拒——不被排前项目的 scope 放行', async () => {
  const { dataDir, bus } = makeEnv()
  fs.writeFileSync(path.join(dataDir, 'scope.yml'), [
    'programs:',
    '  - name: "a-program"',
    '    scope:',
    '      - "*.example.com"',
    '  - name: "b-program"',
    '    scope:',
    '      - "*.other.com"',
    '    exclude:',
    '      - "target.example.com"',
    '',
  ].join('\n'))
  const r = await bus.dispatch('exec', 'run_cli', { tool: 'subfinder', params: { target: 'target.example.com' } }, { actor: 'model' })
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'E_EXEC_SCOPE_DENIED')
})

// ---- H1 回归：风险闸逐目标判定（多目标跨项目时不得只按首目标放行）----
test('H1: 多目标跨项目——任一项目未放行 intrusive 工具即拒', async () => {
  const { dataDir, bus } = makeEnv()
  writeManifest(dataDir, 'intrusive-tool', 'name: intrusive-tool\nbinary: /bin/echo\nstage: vuln\nrisk: intrusive\ntimeout: 30\ntarget_param: target\nargs_template: "-t {{target}}"\n')
  fs.writeFileSync(path.join(dataDir, 'scope.yml'), [
    'programs:',
    '  - name: "a-program"',
    '    scope:',
    '      - "*.example.com"',
    '    rules:',
    '      allow_intrusive_tools:',
    '        - "intrusive-tool"',
    '  - name: "b-program"',
    '    scope:',
    '      - "*.other.com"',
    '',
  ].join('\n'))
  const r = await bus.dispatch('exec', 'run_cli', { tool: 'intrusive-tool', params: { target: 'a.example.com,b.other.com' } }, { actor: 'model' })
  assert.equal(r.ok, false)
  assert.ok(['E_EXEC_RISK_NEEDS_APPROVAL', 'E_EXEC_RISK_FORBIDDEN'].includes(r.error.code), `实际错误码 ${r.error.code}`)
})

// ---------------------------------------------------------------------------
// 21 号方案 §2-1：exec_oracle_judge（机器验证查询，判定归代码）
// ---------------------------------------------------------------------------

test('oracle_judge: 七判定器可路由 + verdict 输出；未知 oracle 拒绝', async () => {
  const { bus } = makeEnv()
  const v = await bus.query('exec', 'oracle_judge', { oracle: 'sqli_time', input: { baseline_ms: 100, sleep_ms: 5200, requested_delay_ms: 5000 } }, { actor: 'model' })
  assert.equal(v.ok, true)
  assert.equal(v.data.verdict, 'verified')
  assert.ok(v.data.rationale.includes('时间差分'))
  const r = await bus.query('exec', 'oracle_judge', { oracle: 'xss_echo', input: { marker: 'svx7a9c2', response_body: '<p>no</p>' } }, { actor: 'model' })
  assert.equal(r.data.verdict, 'rejected')
  const u = await bus.query('exec', 'oracle_judge', { oracle: 'unauthz_diff', input: { control: { status: 200, has_business_data: true } } }, { actor: 'script' })
  assert.equal(u.data.verdict, 'verified')
  const bad = await bus.query('exec', 'oracle_judge', { oracle: 'nope', input: {} }, { actor: 'model' })
  assert.equal(bad.ok, false)
  assert.equal(bad.error.code, 'E_SCHEMA')
})
