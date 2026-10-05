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
