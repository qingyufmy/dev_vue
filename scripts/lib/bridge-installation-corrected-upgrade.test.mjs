import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadBridgeInstallationUpgrade } from './bridge-installation-upgrade.mjs'
import { composeCorrectedBridgeInstallationUpgrade, deriveBridgeInstallationCorrection, loadCorrectedBridgeInstallationUpgrade } from './bridge-installation-corrected-upgrade.mjs'
import { hash } from './v4-backfill-contract.mjs'

const base = await loadBridgeInstallationUpgrade(new URL('../../', import.meta.url))
const sql = Buffer.from('ALTER TABLE bridge_installation_request_limits\n  DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;\n')
// In-memory unit fixture only; never written as a reference proof.
function fixture() {
  const correction = deriveBridgeInstallationCorrection(base, sql)
  return { passed: true, referenceDatabaseRemoved: true, ddlAckLossRecovered: true, replayNoDDL: true,
    ...Object.fromEntries(['originalStepId', 'originalStepChecksum', 'correctionFileSha256', 'correctionSqlSha256',
      'actualBeforeTableHash', 'expectedAfterTableHash', 'sql'].map(key => [key, correction[key]])) }
}

test('consumes the actual isolated correction proof without rewriting the frozen base', async () => {
  const plan = await loadCorrectedBridgeInstallationUpgrade(new URL('../../', import.meta.url))
  assert.equal(plan.steps.length, 272)
  assert.deepEqual(plan.steps.slice(0, 271), base.steps)
  assert.equal(plan.correction.expectedAfterTableHash, base.finalTableHashes.bridge_installation_request_limits)
})

test('correction registry appends one independently hashed step without changing frozen transitions', () => {
  const plan = composeCorrectedBridgeInstallationUpgrade(base, sql, fixture())
  assert.equal(plan.steps.length, 272)
  assert.deepEqual(plan.steps.slice(0, 271), base.steps)
  for (const key of ['prior', 'added', 'transitions', 'definitions', 'finalTableHashes']) assert.equal(plan[key], base[key])
  assert.equal(plan.finalSchemaHash, base.finalSchemaHash)
  assert.equal(plan.correction, plan.steps[271])
  const { checksum, ...body } = plan.correction
  assert.equal(checksum, hash(body))
})

test('proof must match every source, original step and actual before/after binding', () => {
  for (const field of Object.keys(fixture())) {
    const proof = fixture()
    proof[field] = typeof proof[field] === 'boolean' ? false : 'changed'
    assert.throws(() => composeCorrectedBridgeInstallationUpgrade(base, sql, proof), undefined, field)
  }
  assert.throws(() => composeCorrectedBridgeInstallationUpgrade(base, Buffer.concat([sql, Buffer.from('-- changed source\n')]), fixture()))
})

test('rejects broader SQL, multiple statements, wrong defaults and column conversion', () => {
  for (const value of [
    'ALTER TABLE users DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;',
    'ALTER TABLE bridge_installation_request_limits CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;',
    'ALTER TABLE bridge_installation_request_limits DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;',
    `${sql.toString()}DROP TABLE users;`,
    'ALTER TABLE bridge_installation_request_limits DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci, ADD COLUMN x INT;',
  ]) assert.throws(() => deriveBridgeInstallationCorrection(base, Buffer.from(value)))
})

test('derives only a terminal table-default change and rejects incompatible canonical source', () => {
  const correction = deriveBridgeInstallationCorrection(base, sql)
  assert.notEqual(correction.actualBeforeTableHash, correction.expectedAfterTableHash)
  assert.equal(correction.expectedAfterTableHash, base.finalTableHashes.bridge_installation_request_limits)
  for (const mutate of [
    value => { value.definitions.bridge_installation_request_limits += '\n' },
    value => { value.definitions.bridge_installation_request_limits = value.definitions.bridge_installation_request_limits.replace(/unicode_ci$/, 'general_ci') },
    value => { value.finalTableHashes.bridge_installation_request_limits = '0'.repeat(64) },
    value => { value.added[0].id = 'wrong-original' },
    value => { value.steps = value.steps.slice(0, 267) },
  ]) {
    const changed = { ...base, definitions: { ...base.definitions }, finalTableHashes: { ...base.finalTableHashes },
      added: base.added.map(row => ({ ...row })), steps: base.steps.map(row => ({ ...row })) }
    mutate(changed)
    assert.throws(() => deriveBridgeInstallationCorrection(changed, sql))
  }
})
