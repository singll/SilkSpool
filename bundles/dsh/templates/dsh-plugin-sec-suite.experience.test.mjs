import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'

test('兼容经验入口：修改旧卡与自动登记打法链均保持全文索引一致', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'experience-index-test-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const plugin = path.join(root, 'plugin')
  fs.mkdirSync(plugin)
  fs.writeFileSync(path.join(plugin, 'package.json'), '{"type":"module"}')
  for (const name of ['experience', 'asset-db']) {
    fs.copyFileSync(path.join(import.meta.dirname, `dsh-plugin-sec-suite.${name}.js`), path.join(plugin, `${name}.js`))
  }
  const previous = process.env.SEC_DATA_DIR
  process.env.SEC_DATA_DIR = path.join(root, 'data')
  t.after(() => previous === undefined ? delete process.env.SEC_DATA_DIR : process.env.SEC_DATA_DIR = previous)
  const exp = await import(pathToFileURL(path.join(plugin, 'experience.js')))
  const { getDb } = await import(pathToFileURL(path.join(plugin, 'asset-db.js')))
  const db = getDb()
  t.after(() => db.close())
  // 使用真实 know 后端初始化 v5 的已有字段，不用简化 schema 代替运行状态。
  const { createKnowSqliteBackend } = await import(pathToFileURL(path.join(import.meta.dirname, 'dsh-plugin-sec-backend-know-sqlite.js')))
  const repo = createKnowSqliteBackend().factory(db)
  const inserted = repo.insertExpCard({ scenario: 'retained scenario', takeaway: 'legacyoldtoken', chain: '[]' })
  const updated = exp.expUpdate({ id: inserted.id, takeaway: 'legacynewtoken' })
  assert.equal(updated.ok, true)
  assert.deepEqual(db.prepare("SELECT rowid FROM exp_fts WHERE exp_fts MATCH 'legacyoldtoken'").all(), [])
  assert.deepEqual(db.prepare("SELECT rowid FROM exp_fts WHERE exp_fts MATCH 'legacynewtoken'").all().map(r => r.rowid), [inserted.id])
  assert.doesNotThrow(() => db.prepare("INSERT INTO exp_fts(exp_fts,rank) VALUES ('integrity-check',1)").run())
  const recorded = exp.pbOutcome({ name: 'legacyplaybooktoken', success: true })
  assert.equal(recorded.ok, true)
  assert.deepEqual(db.prepare("SELECT rowid FROM exp_fts WHERE exp_fts MATCH 'legacyplaybooktoken'").all().map(r => r.rowid), [recorded.id])
  assert.doesNotThrow(() => db.prepare("INSERT INTO exp_fts(exp_fts,rank) VALUES ('integrity-check',1)").run())
})
