// 使用候选的真实 Cordis/Connection 和 Web 配置；不读业务数据、不使用生产凭据。
// DSH_UPGRADE_BASE_DIR=/path/to/candidate node --test dsh-upgrade-rpc.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readdirSync, realpathSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const base = process.env.DSH_UPGRADE_BASE_DIR
if (!base) throw new Error('必须指定 DSH_UPGRADE_BASE_DIR')
const store = path.join(base, 'app/node_modules/.pnpm')
function packageFile(name) {
  const prefix = name.replace('/', '+') + '@'
  const files = [...new Set(readdirSync(store).filter(s => s.startsWith(prefix)).map(s =>
    realpathSync(path.join(store, s, 'node_modules', name, 'lib/index.js'))))]
  assert.equal(files.length, 1, '候选包含多份不同核心包：' + name)
  return pathToFileURL(files[0])
}
const { Context } = await import(packageFile('@deepseek-ai/cordis'))
const connection = await import(packageFile('@deepseek-ai/dsh-client-connection'))
const configured = JSON.parse(execFileSync('python3', ['-c', `
import json,sys,yaml
rows=yaml.load(open(sys.argv[1]),Loader=yaml.BaseLoader)
value=[]
for row in rows:
 if row.get('id')=='connection' and 'inject' in row: value=row['inject']
print(json.dumps(value))
`, path.join(base, 'data/profiles/web/cordis.patch.yml')], { encoding: 'utf8' }))

async function fixture(extraInject) {
  const ctx = new Context()
  const routes = new Map()
  // 服务放在独立 fiber，不能在 root provide：后者绕过实际故障的注入边界。
  const serverPlugin = { apply(child) {
    child.provide('webServer', { register(route) {
      assert.ok(!routes.has(route.path), '重复路由：' + route.path)
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    } })
  } }
  let server = ctx.plugin(serverPlugin)
  await server.await()
  ctx.provide('webRuntime', {})
  ctx.provide('credentials', { modifyRecord: async (_key, change) => change(undefined) })
  const host = ctx.plugin({ ...connection, inject: [...new Set([...connection.inject, ...extraInject])] },
    { trustedHosts: [], cookieMaxAgeDays: 30, maxRequestBodyBytes: 104857600 })
  await host.await()
  const failures = []
  let registrations = 0
  const consumer = ctx.plugin({ inject: ['connection', 'webServer'], apply(child) {
    try {
      const dispose = child.connection.rpc.handle('/fixture', async () => ({ ok: true, value: 'ok' }))
      registrations++
      return dispose
    } catch (error) { failures.push(error.message) }
  } })
  await consumer.await()
  return { routes, failures, registrations: () => registrations,
    async reloadServer() {
      await server.dispose()
      assert.equal(routes.size, 0)
      server = ctx.plugin(serverPlugin)
      await server.await()
      await host.await()
      await consumer.await()
    },
    async disposeConsumer() { await consumer.dispose() },
    async close() { await consumer.dispose(); await host.dispose(); await server.dispose() },
  }
}

test('独立提供者重现 rc.2 未注入 webServer 的原始故障', async () => {
  const f = await fixture([])
  try {
    assert.deepEqual(f.failures, ['cannot get property "webServer" without inject'])
    assert.equal(f.routes.has('/fixture'), false)
  } finally { await f.close() }
})

test('候选配置使自定义 RPC 可用，并随调用方卸载', async () => {
  const f = await fixture(configured)
  try {
    assert.deepEqual(f.failures, [])
    assert.equal(f.routes.has('/fixture'), true)
    await f.disposeConsumer()
    assert.equal(f.routes.has('/fixture'), false)
    assert.equal(f.routes.has('/api'), true)
  } finally { await f.close() }
})

test('webServer 重建后 RPC 恰好重新注册一次', async () => {
  const f = await fixture(configured)
  try {
    await f.reloadServer()
    assert.deepEqual(f.failures, [])
    assert.equal(f.registrations(), 2)
    assert.deepEqual([...f.routes.keys()].sort(), ['/api', '/fixture'])
  } finally { await f.close() }
})
