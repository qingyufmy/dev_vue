import test from 'node:test'
import assert from 'node:assert/strict'
import { loadRiskStructureMigration } from '../scripts/lib/inplace-risk-structure.mjs'
import { verifyRiskPriorHistory } from '../scripts/lib/risk-prior-history.mjs'

const { prior } = await loadRiskStructureMigration(new URL('../', import.meta.url))
const at = '2026-09-09T00:00:00.000Z'
const history = () => prior.steps.map(step => ({ id: step.id, checksum: step.checksum, status: 'completed', startedAt: at, completedAt: at }))
test('validates the observer seed before passing the exact 165 context steps onward', async () => {
  const calls = [], connection = { async query(sql) { calls.push(sql); return [[{ id: 1, revision: '5' }]] } }
  const result = await verifyRiskPriorHistory(connection, prior, history())
  assert.equal(result.contextHistory.length, 165)
  assert.equal(result.observerRevision, '5')
  assert.ok(calls.every(sql => sql.startsWith('SELECT ')))
})
test('does not hide unknown steps, missing seed records or checksum drift', async () => {
  const connection = { async query() { throw Error('should not query yet') } }
  const extra = history(); extra.push({ ...extra[0], id: 'unknown' })
  await assert.rejects(verifyRiskPriorHistory(connection, prior, extra), /unknown_history/)
  await assert.rejects(verifyRiskPriorHistory(connection, prior, history().slice(0, -1)), /history_incomplete/)
  const changed = history(); changed.at(-1).checksum = 'changed'
  await assert.rejects(verifyRiskPriorHistory(connection, prior, changed), /checksum_mismatch/)
})
test('refuses a recorded seed with a missing or invalid live registry value', async () => {
  for (const rows of [[], [{ id: 1, revision: '-1' }], [{ id: 1, revision: '9007199254740991' }]]) {
    await assert.rejects(verifyRiskPriorHistory({ async query() { return [rows] } }, prior, history()), /observer_registry_invalid/)
  }
})
