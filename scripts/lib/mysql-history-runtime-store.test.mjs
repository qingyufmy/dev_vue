import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assertHistoryRuntimeParents, readHistoryRuntimeTable, mysqlHistoryRuntimeStore } from './mysql-history-runtime-store.mjs'
import { tableDefinitionHash } from './inplace-foundation-upgrade.mjs'

const parents = [
  { tableName: 'users', columnType: 'int', nullable: 'NO', engine: 'InnoDB', columnKey: 'PRI' },
  { tableName: 'trading_accounts', columnType: 'bigint unsigned', nullable: 'NO', engine: 'InnoDB', columnKey: 'PRI' },
  { tableName: 'trading_account_ownership_intervals', columnType: 'char(36)', nullable: 'NO', engine: 'InnoDB', columnKey: 'PRI', collationName: 'ascii_bin' },
]
test('requires all external parents with compatible key types and collation', async () => {
  await assertHistoryRuntimeParents({ query: async () => [parents] })
  for (const rows of [parents.slice(0, 2), [...parents.slice(0, 2), parents[0]],
    parents.map(row => ({ ...row, columnKey: '' })), parents.map(row => ({ ...row, collationName: 'utf8mb4_bin' }))]) {
    await assert.rejects(assertHistoryRuntimeParents({ query: async () => [rows] }), /parents_unready/)
  }
})
const table = 'account_trade_records_v4', ddl = `CREATE TABLE \`${table}\` (\n  \`id\` int NOT NULL\n) ENGINE=InnoDB`
function connection({ objects = [{ kind: 'BASE TABLE', engine: 'InnoDB' }], triggers = [], count = '0', definition = ddl } = {}) {
  const calls = []
  return { calls,
    async execute(sql, values) { calls.push({ sql, values }); return [sql.includes('TRIGGERS') ? triggers : objects] },
    async query(sql) { calls.push({ sql }); return [[sql.startsWith('SHOW') ? { 'Create Table': definition } : { n: count }]] },
  }
}
test('rejects any identifier outside the fixed eight-table scope before SQL', async () => {
  const db = connection()
  for (const name of ['users', 'account_trade_records_v4`', 'trade_history_migration_checkpoints_v4']) {
    await assert.rejects(readHistoryRuntimeTable(db, name), /table_scope/)
  }
  assert.equal(db.calls.length, 0)
})
test('reads real-definition hash and exact row count without any write', async () => {
  const db = connection()
  assert.deepEqual(await readHistoryRuntimeTable(db, table), { hash: tableDefinitionHash(ddl), rows: 0, ddl })
  assert.ok(db.calls.every(({ sql }) => /^(SELECT|SHOW)/.test(sql)))
  assert.equal(await readHistoryRuntimeTable(connection({ objects: [] }), table), null)
})
test('rejects views, non-InnoDB tables, triggers, conflicting names and invalid row counts', async () => {
  for (const options of [{ objects: [{ kind: 'VIEW', engine: null }] }, { objects: [{ kind: 'BASE TABLE', engine: 'MyISAM' }] },
    { triggers: [{ TRIGGER_NAME: 'side_effect' }] }, { definition: 'CREATE TABLE `other` (' },
    { count: '-1' }, { count: '9007199254740992' }, { count: '1.5' }]) {
    await assert.rejects(readHistoryRuntimeTable(connection(options), table), /history_runtime_store_/)
  }
})
test('rejects a missing or incomplete durable baseline without querying', async () => {
  const db = connection()
  for (const baseline of [null, {}, { kind: 'history-runtime-baseline/v1', priorHistory: [], protectedSnapshot: [] }]) {
    await assert.rejects(mysqlHistoryRuntimeStore(db, {}, new URL('../../', import.meta.url), { baseline }), /baseline/)
  }
  assert.equal(db.calls.length, 0)
})
