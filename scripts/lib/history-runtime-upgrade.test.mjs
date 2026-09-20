import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { loadHistoryRuntimeUpgrade, historyRuntimePlanHash } from './history-runtime-upgrade.mjs'
import { loadHistoryProvenanceUpgrade, coordinateHistoryProvenanceUpgrade } from './history-provenance-upgrade.mjs'

const root = new URL('../../', import.meta.url)
const reference = JSON.parse(await readFile(new URL('docs/architecture/history-runtime-reference-20260909.json', root)))
test('preserves 176 steps and orders 11 dependencies before provenance with ALTER hash chains', async () => {
  const plan = await loadHistoryRuntimeUpgrade(root, reference)
  assert.deepEqual(plan.steps.slice(0, 176), plan.prior.steps)
  assert.equal(plan.steps.length, 188); assert.equal(plan.added.at(-1).table, 'terminal_history_order_provenance_v4')
  assert.equal(Object.keys(plan.finalTableHashes).length, 8)
  const latest = new Map()
  for (const step of plan.added) {
    assert.equal(step.beforeHash, latest.get(step.table) ?? null)
    latest.set(step.table, step.afterHash)
  }
  assert.equal(historyRuntimePlanHash(plan), historyRuntimePlanHash(await loadHistoryRuntimeUpgrade(root, reference)))
})
test('rejects reordered or altered reference steps', async () => {
  const changed = structuredClone(reference); changed.steps.reverse()
  await assert.rejects(loadHistoryRuntimeUpgrade(root, changed), /history_runtime_step_reference_invalid/)
  changed.steps.reverse(); changed.steps[0].sqlSha256 = 'wrong'
  await assert.rejects(loadHistoryRuntimeUpgrade(root, changed), /history_runtime_step_reference_invalid/)
})
test('plan fingerprint binds execution and prior-step views as well as the full registry', async () => {
  const plan = await loadHistoryRuntimeUpgrade(root, reference), original = historyRuntimePlanHash(plan)
  const changed = { ...plan, added: structuredClone(plan.added) }
  changed.added[0].sql = 'unexpected SQL'
  assert.notEqual(historyRuntimePlanHash(changed), original)
  const priorChanged = { ...plan, prior: { steps: plan.prior.steps.slice(1) } }
  assert.notEqual(historyRuntimePlanHash(priorChanged), original)
})
test('rejects a conflicting final-table definition', async () => {
  const changed = structuredClone(reference); changed.tables.account_trade_records_v4 += ' drift'
  await assert.rejects(loadHistoryRuntimeUpgrade(root, changed), /history_runtime_final_reference_invalid/)
})
test('makes the superseded single-table coordinator non-executable', async () => {
  const oldReference = JSON.parse(await readFile(new URL('docs/architecture/history-provenance-reference-20260909.json', root)))
  const plan = await loadHistoryProvenanceUpgrade(root, oldReference)
  await assert.rejects(coordinateHistoryProvenanceUpgrade({}, plan, { apply: true }), /superseded_by_history_runtime/)
})
