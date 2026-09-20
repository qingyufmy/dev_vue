import test from 'node:test'
import assert from 'node:assert/strict'
import { assertInstrumentCollectionConnection, readInstrumentCollectionTable, mysqlInstrumentCollectionStore } from '../scripts/lib/mysql-instrument-collection-store.mjs'
const identity = { database: 'dev_vue', serverUuid: 'ac423207-6ef3-11f1-b302-000c29fda104' }
function connection(overrides = {}) {
  const row = { db: identity.database, uuid: identity.serverUuid, timezone: '+00:00', id: 9, principal: 'root@localhost', ...overrides }
  return { query: async sql => [[sql.includes('DATABASE() db') ? row : { n: overrides.clients ?? 0 }]],
    execute: async () => [[{ owner: overrides.owner ?? 9 }]] }
}
test('requires exact target, UTC, root visibility, same lock and exclusive connection', async () => {
  await assertInstrumentCollectionConnection(connection(), identity)
  for (const change of [{ db: 'dev_xin' }, { uuid: 'wrong' }, { timezone: 'SYSTEM' }, { principal: 'dev_vue@%' }, { owner: 10 }, { clients: 1 }]) {
    await assert.rejects(assertInstrumentCollectionConnection(connection(change), identity), /instrument_collection_store_/)
  }
  await assert.rejects(assertInstrumentCollectionConnection(connection(), { ...identity, database: 'production' }), /target/)
})
test('rejects a view or trigger instead of treating it as the expected instrument request table', async () => {
  assert.equal(await readInstrumentCollectionTable({ execute: async () => [[]] }), null)
  await assert.rejects(readInstrumentCollectionTable({ execute: async () => [[{ kind: 'VIEW', engine: null }]] }), /table_kind/)
  let calls = 0
  await assert.rejects(readInstrumentCollectionTable({ execute: async () => ++calls === 1 ? [[{ kind: 'BASE TABLE', engine: 'InnoDB' }]] : [[{ TRIGGER_NAME: 'unexpected' }]],
    query: async () => [[{ 'Create Table': 'CREATE TABLE `instrument_collection_requests_v4` (\n `id` int\n)' }]] }), /triggers/)
})

test('refuses an incomplete baseline before constructing a writable store', async () => {
  const c = connection()
  await assert.rejects(mysqlInstrumentCollectionStore(c, {}, new URL('../', import.meta.url), {
    reference: {}, baseline: { identity, kind: 'instrument-collection-baseline/v1', priorHistory: [], protectedSnapshot: [] },
    verifyPrior: async () => ({ status: 'completed' }),
  }), /baseline/)
})
