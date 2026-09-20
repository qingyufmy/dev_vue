import test from 'node:test'
import assert from 'node:assert/strict'
import { assertRiskReceiptConnection, readRiskReceiptTable } from '../scripts/lib/mysql-risk-policy-receipt-store.mjs'
const identity = { database: 'dev_vue', serverUuid: 'ac423207-6ef3-11f1-b302-000c29fda104' }
function connection(overrides = {}) {
  const row = { db: identity.database, uuid: identity.serverUuid, timezone: '+00:00', id: 9, principal: 'root@localhost', ...overrides }
  return { query: async sql => [[sql.includes('DATABASE() db') ? row : { n: overrides.clients ?? 0 }]],
    execute: async () => [[{ owner: overrides.owner ?? 9 }]] }
}
test('requires exact target, UTC, root visibility, same lock and exclusive connection', async () => {
  await assertRiskReceiptConnection(connection(), identity)
  for (const change of [{ db: 'dev_xin' }, { uuid: 'wrong' }, { timezone: 'SYSTEM' }, { principal: 'dev_vue@%' }, { owner: 10 }, { clients: 1 }]) {
    await assert.rejects(assertRiskReceiptConnection(connection(change), identity), /risk_receipt_store_/)
  }
  await assert.rejects(assertRiskReceiptConnection(connection(), { ...identity, database: 'production' }), /target/)
})
test('rejects a view or trigger instead of treating it as the expected receipt table', async () => {
  assert.equal(await readRiskReceiptTable({ execute: async () => [[]] }), null)
  await assert.rejects(readRiskReceiptTable({ execute: async () => [[{ kind: 'VIEW', engine: null }]] }), /table_kind/)
  let calls = 0
  await assert.rejects(readRiskReceiptTable({ execute: async () => ++calls === 1 ? [[{ kind: 'BASE TABLE', engine: 'InnoDB' }]] : [[{ TRIGGER_NAME: 'unexpected' }]],
    query: async () => [[{ 'Create Table': 'CREATE TABLE `risk_policy_write_receipts` (\n `id` int\n)' }]] }), /triggers/)
})
