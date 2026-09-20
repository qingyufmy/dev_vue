import test from 'node:test'
import assert from 'node:assert/strict'
import { loadReviewHistoryUpgrade } from './review-history-upgrade.mjs'
import { coordinateInplaceSchema } from './inplace-schema-coordinator.mjs'

test('history admission preserves every executed checksum and rejects schema drift before writes', async () => {
  const plan = await loadReviewHistoryUpgrade(new URL('../../', import.meta.url))
  assert.deepEqual(plan.steps.slice(0, 254), plan.prior.steps)
  assert.deepEqual(plan.added.map(step => step.id), ['inplace_069_review_history', 'inplace_070_review_history'])
  let mutations = 0
  const store = { history: async () => plan.prior.steps.map(step => ({ id: step.id, checksum: step.checksum, status: 'completed', startedAt: '2026-09-11T00:00:00.000Z', completedAt: '2026-09-11T00:00:00.000Z' })),
    tableHash: async () => 'unexpected', column: async () => null,
    begin: async () => { mutations++ }, execute: async () => { mutations++ }, complete: async () => { mutations++ } }
  await assert.rejects(() => coordinateInplaceSchema(store, plan, { apply: true }), /inplace_coordinator_schema_conflict/)
  assert.equal(mutations, 0)
})
