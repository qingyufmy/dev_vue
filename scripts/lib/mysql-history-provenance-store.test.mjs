import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assertHistoryProvenanceConnection, assertHistoryProvenanceParents, mysqlHistoryProvenanceStore } from './mysql-history-provenance-store.mjs'

const identity = { database: 'dev_vue', serverUuid: 'ac423207-6ef3-11f1-b302-000c29fda104' }
test('rejects the observed missing history parent before any mutation', async () => {
  await assert.rejects(assertHistoryProvenanceParents({ query: async () => [[
    { tableName: 'users', columnType: 'int', nullable: 'NO', engine: 'InnoDB', columnKey: 'PRI' },
    { tableName: 'trading_accounts', columnType: 'bigint unsigned', nullable: 'NO', engine: 'InnoDB', columnKey: 'PRI' },
  ]] }), /history_provenance_store_parents_unready/)
})
function connection({ db = 'dev_vue', timezone = '+00:00', principal = 'root@localhost', owner = 10, clients = 0 } = {}) {
  const calls = []
  return { calls, query: async sql => {
    calls.push(sql)
    return sql.includes('PROCESSLIST') ? [[{ n: clients }]] : [[{ db, uuid: identity.serverUuid, timezone, id: 10, principal }]]
  }, execute: async sql => { calls.push(sql); return [[{ owner }]] } }
}
test('requires the exact target, UTC, root identity, owned upgrade lock and no other clients', async () => {
  await assertHistoryProvenanceConnection(connection(), identity)
  for (const options of [{ db: 'other' }, { timezone: '+08:00' }, { principal: 'app@localhost' }, { owner: 11 }, { owner: null }, { clients: 1 }]) {
    await assert.rejects(assertHistoryProvenanceConnection(connection(options), identity), /history_provenance_store_/)
  }
})
test('rejects an arbitrary database before querying it', async () => {
  const db = connection()
  await assert.rejects(assertHistoryProvenanceConnection(db, { ...identity, database: 'production' }), /history_provenance_store_target/)
  assert.equal(db.calls.length, 0)
})
test('refuses a baseline without all 176 prior steps before accessing the migration journal', async () => {
  const db = connection()
  await assert.rejects(mysqlHistoryProvenanceStore(db, {}, new URL('../../', import.meta.url), {
    reference: {}, baseline: { identity, kind: 'history-provenance-baseline/v1', priorHistory: [], protectedSnapshot: [] },
    verifyPrior: async () => ({ status: 'completed' }),
  }), /history_provenance_store_baseline/)
  assert.ok(db.calls.every(sql => /^SELECT/.test(sql)))
})
