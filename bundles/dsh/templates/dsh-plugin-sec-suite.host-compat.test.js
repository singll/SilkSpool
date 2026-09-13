// node --test bundles/dsh/templates/dsh-plugin-sec-suite.host-compat.test.js
// 只使用临时目录，不加载生产插件、不打开业务库。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeSessionList, listSessionHeaders, matchWorkerSession, createPersonaReader, buildScheduledPrompt } from './dsh-plugin-sec-suite.host-compat.js'

const header = { id: 'session-a', cwd: '/fixture/a', createdAt: 1000 }
const window = { cwd: '/fixture/a', startedAt: 1000, finishedAt: 2000 }

test('同一消费者接受旧平铺 header 和新版 snapshot.header，保留 Session ID', () => {
  assert.deepEqual(normalizeSessionList([header]), normalizeSessionList([{ header, revision: 'r', eventCount: 3 }]))
  const normalized = normalizeSessionList([{ header }])
  normalized.headers[0].cwd = '/changed'
  assert.equal(header.cwd, '/fixture/a')
})

test('未知列表/无效 header/重复 ID 显式诊断，不能生成 undefined 跳链', () => {
  assert.throws(() => normalizeSessionList({ items: [header] }), /E_SESSION_LIST_SHAPE/)
  const result = normalizeSessionList([null, { header: {} }, { ...header, createdAt: '1000' }, header, { header }])
  assert.deepEqual(result.headers, [])
  assert.equal(result.diagnostics.length, 4)
  assert.equal(result.diagnostics.at(-1).code, 'E_SESSION_HEADER_DUPLICATE')
})

test('元数据列表不抢写锁，list 失败不能伪装成空列表', async () => {
  let lists = 0
  const result = await listSessionHeaders({ list: async () => { lists++; return [{ header }] }, open: () => assert.fail('不得打开 Session') })
  assert.equal(lists, 1)
  assert.deepEqual(result.headers, [header])
  await assert.rejects(listSessionHeaders({ list: async () => { throw new Error('read failed') } }), /read failed/)
  await assert.rejects(listSessionHeaders(null), /UNAVAILABLE/)
})

test('worker 时间窗排除缺时间戳、旧会话、未来会话和其他工作区', () => {
  const rows = [header, { id: 'no-time', cwd: header.cwd, updatedAt: 1500 },
    { ...header, id: 'old', createdAt: 999 }, { ...header, id: 'future', createdAt: 2001 },
    { ...header, id: 'other', cwd: '/fixture/b' }]
  assert.deepEqual(matchWorkerSession(rows, window), { id: header.id, source: 'time-window', code: 'W_WORKER_SESSION_FALLBACK' })
  assert.equal(matchWorkerSession(rows.slice(1), window).id, null)
  assert.equal(matchWorkerSession(rows, { ...window, finishedAt: 999 }).code, 'E_WORKER_SESSION_WINDOW')
})

test('同工作区并发 Session 拒绝猜最新；可信上报仍需校验工作区与时间窗', () => {
  const rows = [header, { ...header, id: 'session-b', createdAt: 1500 }]
  assert.equal(matchWorkerSession(rows, window).code, 'E_WORKER_SESSION_AMBIGUOUS')
  assert.deepEqual(matchWorkerSession(rows, { ...window, reportedId: 'session-b' }), { id: 'session-b', source: 'worker' })
  assert.equal(matchWorkerSession(rows, { ...window, reportedId: 'parent-session' }).code, 'E_WORKER_SESSION_REPORTED_ID')
})

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'silksec-persona-test-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const filename = path.join(dir, '.agent-presets/recon/agent.cordis.yml')
  fs.mkdirSync(path.dirname(filename), { recursive: true })
  const reader = createPersonaReader({ helper: fileURLToPath(new URL('./dsh-plugin-sec-suite.persona.py', import.meta.url)) })
  const write = (config) => fs.writeFileSync(filename, `- id: persona\n  name: '@deepseek-ai/dsh-persona'\n  config:\n${config}\n- id: platform\n  disabled: !!js process.exit(99)\n`)
  return { dir, filename, reader, write }
}

test('结构化读取 prefix/suffix，保留多行且不执行 !!js，工作区不串用', (t) => {
  const f = fixture(t)
  f.write('    prefix: |\n      授权侦察 {{model}}\n      使用 exec_run_cli\n    suffix: "工作区 {{cwd}}"\n    complete: false\n    includeRuntimeContext: true')
  assert.match(f.reader(f.dir, 'recon', '/fixture/a'), /授权侦察 当前模型\n使用 exec_run_cli/)
  assert.match(f.reader(f.dir, 'recon', '/fixture/b'), /工作区 \/fixture\/b/)
  assert.doesNotMatch(f.reader(f.dir, 'recon', '/fixture/b'), /fixture\/a/)
})

test('兼容旧 text；文件替换使缓存失效，删除/损坏不能沿用旧角色', (t) => {
  const f = fixture(t)
  f.write('    text: >-\n      旧角色 {{cwd}}')
  assert.equal(f.reader(f.dir, 'recon', '/a'), '旧角色 /a')
  const next = f.filename + '.next'
  fs.writeFileSync(next, "- name: '@deepseek-ai/dsh-persona'\n  config: {prefix: 新角色, suffix: '{{cwd}}'}\n")
  fs.renameSync(next, f.filename)
  assert.equal(f.reader(f.dir, 'recon', '/b'), '新角色\n\n/b')
  f.write('    prefix: ""')
  assert.throws(() => f.reader(f.dir, 'recon', '/b'), /E_PERSONA_READ/)
  fs.unlinkSync(f.filename)
  assert.throws(() => f.reader(f.dir, 'recon', '/b'), /ENOENT/)
})

test('受管角色拒绝丢失运行指导、歧义字段和未解析变量；通用 phase 不强造角色', (t) => {
  const f = fixture(t)
  for (const config of ['    prefix: a\n    complete: true', '    prefix: a\n    includeRuntimeContext: false',
    '    prefix: a\n    text: b', '    text: a\n    suffix: b']) {
    f.write(config)
    assert.throws(() => f.reader(f.dir, 'recon', '/a'), /E_PERSONA_READ/)
  }
  f.write('    prefix: "角色 {{unknown}}"')
  assert.throws(() => f.reader(f.dir, 'recon', '/a'), /E_PERSONA_VARIABLE/)
  f.write('    prefix: "角色 {{cwd}}"')
  assert.throws(() => f.reader(f.dir, 'recon', null), /E_PERSONA_VARIABLE/)
  assert.equal(f.reader(f.dir, 'maintenance', null), '')
})

test('调度最终 prompt 包含角色/任务/知识检索，候选登记与确认分开', () => {
  const prompt = buildScheduledPrompt({ id: 42, program_id: 'fixture', phase: 'recon', objective: '仅检查本地 fixture' }, '角色职责')
  assert.match(prompt, /角色职责/)
  assert.match(prompt, /仅检查本地 fixture/)
  assert.match(prompt, /vuln_register_signal.*候选.*vuln_confirm/)
  assert.doesNotMatch(prompt, /finding_add/)
  assert.match(prompt, /fact_search.*exp_search.*kb_search/)
})
