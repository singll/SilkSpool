import { test } from 'node:test'
import assert from 'node:assert/strict'
import { projectKnowledgeStatus } from './dsh-plugin-sec-memcore.js'

test('health preserves observed zero, missing metrics and source failure independently', () => {
  const fact = { ok: true, data: { total: 0, by_status: [] } }
  const know = { ok: true, data: { exp: { total: 3, cooling: 1, zero_use_30d: 2 }, kb: { total: 4 } } }
  const result = projectKnowledgeStatus(fact, null, know)
  assert.equal(result.knowledgeHealth.facts.total, 0)
  assert.equal(result.knowledgeHealth.facts.cooling, 0)
  assert.equal(result.knowledgeHealth.facts.revalidate_overdue, null)
  assert.equal(result.knowledgeHealth.kb_docs.zero_use_ratio, null)
  assert.equal(result.knowledgeHealth.exp_cards.total, 3)
  assert.equal(result.knowledgeHealth.fgs.persisted_facts, null)
  const failed = projectKnowledgeStatus({ ok: false }, null, { ok: false })
  assert.equal(failed.knowledgeHealth.facts.total, null)
  assert.equal(failed.knowledgeHealth.exp_cards.total, null)
  assert.equal(result.knowledgeHealth.exp_cards.total, 3)
  assert.equal(projectKnowledgeStatus(null, {ok:true,data:{fgs_persisted:0}}, null).knowledgeHealth.fgs.persisted_facts, 0)
})

test('document health forwards measured counts and valid ratios without coercing unknown', () => {
  const result = projectKnowledgeStatus(null, null, {ok:true,data:{kb:{total:5,zero_use:3,zero_use_ratio:0.6,cooling:1,expiring_30d:1}}})
  assert.deepEqual(result.knowledgeHealth.kb_docs, {total:5,zero_use:3,zero_use_ratio:0.6,cooling:1,expiring_30d:1})
  for (const value of [null, '0', NaN, Infinity, -1, 2]) {
    assert.equal(projectKnowledgeStatus(null,null,{ok:true,data:{kb:{zero_use_ratio:value}}}).knowledgeHealth.kb_docs.zero_use_ratio,null)
  }
})


test('candidate count is forwarded only when observed', () => {
  const value = projectKnowledgeStatus(null,null,{ok:true,data:{exp:{candidate:2,active:1}}})
  assert.equal(value.tables.exp_cards.candidate,2)
  assert.equal(value.knowledgeHealth.exp_cards.candidate,2)
  assert.equal(projectKnowledgeStatus(null,null,null).tables.exp_cards.candidate,null)
})
