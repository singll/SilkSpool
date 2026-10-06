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
  for (const name of ['experience', 'asset-db', 'task-policy']) {
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
  const rules = path.join(root, 'data', 'rules', 'src')
  fs.mkdirSync(rules, { recursive: true })
  const file = path.join(rules, 'sample.md')
  fs.writeFileSync(file, 'curatedoriginaltoken')
  assert.equal(exp.kbIndexCuratedRules().added, 1)
  const changes = () => db.prepare('SELECT total_changes() AS n').get().n
  const before = changes()
  const repeated = exp.kbIndexCuratedRules()
  assert.equal(changes(), before, 'unchanged startup must not rewrite every FTS row and document')
  assert.equal(repeated.refreshed, 0)
  assert.equal(repeated.unchanged, 1)
  fs.writeFileSync(file, 'curatednewtoken')
  assert.equal(exp.kbIndexCuratedRules().refreshed, 1)
  assert.equal(db.prepare("SELECT count(*) AS n FROM kb_fts WHERE kb_fts MATCH 'curatedoriginaltoken'").get().n, 0)
  assert.equal(db.prepare("SELECT count(*) AS n FROM kb_fts WHERE kb_fts MATCH 'curatednewtoken'").get().n, 1)
  db.prepare('DELETE FROM kb_fts WHERE rowid=(SELECT id FROM kb_docs WHERE file=?)').run(file)
  assert.equal(exp.kbIndexCuratedRules().refreshed, 1, 'missing FTS is repaired despite unchanged file')
  fs.writeFileSync(file, 'curatedfailingtoken')
  db.exec("CREATE TRIGGER fail_curated_update BEFORE UPDATE OF title ON kb_docs BEGIN SELECT RAISE(ABORT,'injected'); END")
  assert.throws(() => exp.kbIndexCuratedRules(), /injected/)
  assert.equal(db.prepare("SELECT count(*) AS n FROM kb_fts WHERE kb_fts MATCH 'curatednewtoken'").get().n, 1, 'failed update preserves old index')
  assert.equal(db.prepare("SELECT count(*) AS n FROM kb_fts WHERE kb_fts MATCH 'curatedfailingtoken'").get().n, 0)
  db.exec('DROP TRIGGER fail_curated_update')
  const rootRules = path.dirname(rules)
  fs.renameSync(rootRules, rootRules + '-offline')
  assert.throws(() => exp.kbIndexCuratedRules(), /ENOENT/)
  assert.equal(db.prepare("SELECT count(*) AS n FROM kb_fts WHERE kb_fts MATCH 'curatednewtoken'").get().n, 1, 'unavailable source is not a deletion')
  fs.renameSync(rootRules + '-offline', rootRules)
  fs.unlinkSync(file)
  assert.equal(exp.kbIndexCuratedRules().removed, 1)
})
