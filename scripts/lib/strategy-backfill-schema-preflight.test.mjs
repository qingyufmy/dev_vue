import test from 'node:test'
import assert from 'node:assert/strict'
import { hash } from './v4-backfill-contract.mjs'
import { inspectStrategyBackfillSchema } from './strategy-backfill-schema-preflight.mjs'

const plan = { tables: {}, steps: [], hash: hash({ tables: {}, steps: [] }) }
test('restored baseline names still require an exact database and server identity', async () => {
  for (const database of ['dev_vue_m1_source_20260910_01', 'dev_vue_strategy_restore_' + 'a'.repeat(32)]) {
    let reads = 0
    const connection = { async query() { reads++; return [[{ db: 'dev_vue', uuid: 'ac423207-6ef3-11f1-b302-000c29fda104' }]] } }
    await assert.rejects(inspectStrategyBackfillSchema(connection, plan, database), { code: 'strategy_schema_database_identity' })
    assert.equal(reads, 1)
    await assert.rejects(inspectStrategyBackfillSchema({ async query() { return [[{ db: database, uuid: 'other-server' }]] } }, plan, database),
      { code: 'strategy_schema_database_identity' })
  }
})
test('arbitrary and malformed database names are rejected before any query', async () => {
  for (const database of ['dev_xin', 'dev_vue_m1_source_20260910_01_other', 'dev_vue_m1_source_20260910_1', 'mysql', 'dev_vue;DROP DATABASE dev_vue']) {
    await assert.rejects(inspectStrategyBackfillSchema({ async query() { assert.fail('unexpected query') } }, plan, database),
      { code: 'strategy_schema_database_scope' })
  }
})
