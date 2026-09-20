import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { loadHistoryProvenanceMigration, loadHistoryProvenanceUpgrade, historyProvenancePlanHash, coordinateHistoryProvenanceUpgrade } from './history-provenance-upgrade.mjs'

const root = new URL('../../', import.meta.url)
const reference = JSON.parse(await readFile(new URL('docs/architecture/history-provenance-reference-20260909.json', root)))
test('appends exactly one step and preserves all prior registered checksums', async () => {
  const migration = await loadHistoryProvenanceMigration(root)
  const plan = await loadHistoryProvenanceUpgrade(root, reference)
  assert.equal(plan.steps.length, 177)
  assert.deepEqual(plan.steps.slice(0, 176), plan.prior.steps)
  assert.equal(plan.steps.at(-1).checksum, migration.step.checksum)
  assert.equal(plan.step.checksum, migration.step.checksum)
  assert.match(plan.step.afterHash, /^[0-9a-f]{64}$/)
  assert.equal(plan.steps.at(-1).afterHash, undefined)
  assert.equal(historyProvenancePlanHash(plan), historyProvenancePlanHash(await loadHistoryProvenanceUpgrade(root, reference)))
})
for (const patch of [{ passed: false }, { referenceDatabaseRemoved: false }, { existingDatabaseWrites: 1 },
  { serverUuid: 'other' }, { migrationSha256: 'wrong' }, { checks: [] }, { canonicalDdl: 'CREATE TABLE `other` (' }]) {
  test(`rejects invalid reference ${JSON.stringify(patch)}`, async () => {
    await assert.rejects(loadHistoryProvenanceUpgrade(root, { ...reference, ...patch }), /history_provenance_reference_invalid/)
  })
}
test('refuses a wrong-table coordinator invocation before touching the store', async () => {
  const plan = await loadHistoryProvenanceUpgrade(root, reference)
  await assert.rejects(coordinateHistoryProvenanceUpgrade({}, { ...plan, step: { ...plan.step, table: 'users' } }), /history_provenance_upgrade_scope/)
})
