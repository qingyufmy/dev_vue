import test from 'node:test'
import assert from 'node:assert/strict'
import { loadInstrumentCollectionMigration, inspectInstrumentCollectionPrerequisites } from '../scripts/lib/inplace-instrument-collection-schema.mjs'

test('registers 176 steps without changing the preceding 175 identities', async () => {
  const plan = await loadInstrumentCollectionMigration(new URL('../', import.meta.url))
  assert.equal(plan.steps.length, 176)
  assert.deepEqual(plan.steps.slice(0, 175), plan.prior.steps)
  assert.equal(new Set(plan.steps.map(row => row.id)).size, 176)
  assert.equal(plan.step.id, 'inplace_045_01_instrument_collection_requests_v4')
})
const evidence = () => ({ tables: ['users', 'trading_accounts'].map(name => ({ name, engine: 'InnoDB' })),
  columns: [{ tableName: 'users', name: 'id', type: 'int', nullable: 'NO' }, { tableName: 'trading_accounts', name: 'id', type: 'bigint unsigned', nullable: 'NO' }],
  keys: ['users', 'trading_accounts'].map(tableName => ({ tableName, indexName: 'PRIMARY', columnName: 'id', nonUnique: 0 })) })
test('accepts compatible parent keys without interpreting absence as migration completion', () => {
  assert.deepEqual(inspectInstrumentCollectionPrerequisites(evidence()), { ready: true, problems: [], targetExists: false })
})
test('rejects incompatible signedness and composite parent keys', () => {
  const input = evidence(); input.columns[1].type = 'bigint'
  input.keys.push({ tableName: 'users', indexName: 'PRIMARY', columnName: 'tenant_id', nonUnique: 0 })
  assert.deepEqual(inspectInstrumentCollectionPrerequisites(input).problems, ['users_primary_key', 'trading_accounts_id_type'])
})
