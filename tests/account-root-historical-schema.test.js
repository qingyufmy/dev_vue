import { expect, it, vi } from 'vitest'
import { historicalAccountDefinition, promotedAccountMetadataConnection, promotedAccountHistoricalStore } from '../scripts/lib/account-root-historical-schema.mjs'
import { accountRootRenames } from '../scripts/lib/account-root-promotion.mjs'
import { coordinateInplaceSchema } from '../scripts/lib/inplace-schema-coordinator.mjs'
import { tableDefinitionHash } from '../scripts/lib/inplace-foundation-upgrade.mjs'

it('restores old and new FK targets simultaneously without changing other identifier or literal positions', () => {
  const ddl = "CREATE TABLE `strategy_subscriptions` (\n  `trading_accounts` varchar(50) DEFAULT 'trading_accounts_legacy_v3',\n  CONSTRAINT `trading_accounts` FOREIGN KEY (`old_id`) REFERENCES `trading_accounts_legacy_v3` (`id`),\n  CONSTRAINT `new_fk` FOREIGN KEY (`new_id`) REFERENCES `trading_accounts` (`id`)\n) ENGINE=InnoDB COMMENT='REFERENCES `trading_accounts`'"
  expect(historicalAccountDefinition('strategy_subscriptions', ddl)).toBe(ddl
    .replace('REFERENCES `trading_accounts_legacy_v3`', 'REFERENCES `trading_accounts`')
    .replace('(`new_id`) REFERENCES `trading_accounts`', '(`new_id`) REFERENCES `trading_accounts_v4_build`'))
})
it('reads the old root from legacy and the former build root from the new root', async () => {
  const connection = { query: vi.fn(async sql => {
    const name = /`([^`]+)`/.exec(sql)[1]
    return [[{ Table: name, 'Create Table': `CREATE TABLE \`${name}\` (\n  \`id\` bigint NOT NULL\n) ENGINE=InnoDB` }], []]
  }) }
  const reader = promotedAccountMetadataConnection(connection)
  for (const [logical, actual] of accountRootRenames) {
    const [[row]] = await reader.query(`SHOW CREATE TABLE \`${logical}\``)
    expect(connection.query).toHaveBeenLastCalledWith(`SHOW CREATE TABLE \`${actual}\``)
    expect(row['Create Table']).toContain(`CREATE TABLE \`${logical}\``)
  }
})
it('maps only the table parameter of allowed metadata reads', async () => {
  const connection = { execute: vi.fn(async () => [[]]) }
  const reader = promotedAccountMetadataConnection(connection)
  const sql = 'SELECT COLUMN_TYPE type,IS_NULLABLE nullable,COLUMN_DEFAULT defaultValue,COLLATION_NAME collation,EXTRA extra FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?'
  await reader.execute(sql, ['trading_accounts', 'trading_accounts'])
  expect(connection.execute).toHaveBeenCalledWith(sql, ['trading_accounts_legacy_v3', 'trading_accounts'])
})
it('refuses writes, arbitrary reads, stacked SQL and query objects before touching the connection', async () => {
  const connection = { query: vi.fn(), execute: vi.fn() }, reader = promotedAccountMetadataConnection(connection)
  for (const sql of ['RENAME TABLE a TO b', 'SELECT * FROM trading_accounts', 'SHOW CREATE TABLE users; DROP TABLE users', { sql: 'SELECT DATABASE() db' }]) {
    await expect(reader.query(sql)).rejects.toThrow('query_not_allowed')
    await expect(reader.execute(sql, [])).rejects.toThrow('query_not_allowed')
  }
  expect(connection.query).not.toHaveBeenCalled(); expect(connection.execute).not.toHaveBeenCalled()
})
it('rejects a SHOW CREATE response for an unexpected physical table', () => {
  expect(() => historicalAccountDefinition('trading_accounts', 'CREATE TABLE `trading_accounts` (`id` int)')).toThrow('definition_table')
})

const logical = 'trading_accounts_v4_build'
const original = `CREATE TABLE \`${logical}\` (\n  \`id\` bigint NOT NULL\n) ENGINE=InnoDB`
const step = { id: 'prior_account', table: logical, checksum: 'fixed', sql: 'CREATE TABLE ignored' }
const plan = { steps: [step], transitions: [{ step, key: logical, before: null, after: tableDefinitionHash(original) }],
  store: connection => ({ tableHash: async name => tableDefinitionHash((await connection.query(`SHOW CREATE TABLE \`${name}\``))[0][0]['Create Table']) }) }
const history = [{ id: step.id, checksum: step.checksum, status: 'completed', startedAt: '2026-09-08T00:00:00Z', completedAt: '2026-09-08T00:00:01Z' }]
function fakeConnection({ staleBuild = false, drift = false } = {}) {
  return { query: vi.fn(async sql => sql.startsWith('SELECT TABLE_NAME')
    ? [[...accountRootRenames.map(([, name]) => ({ name, kind: 'BASE TABLE' })), ...(staleBuild ? [{ name: logical, kind: 'BASE TABLE' }] : [])]]
    : [[{ 'Create Table': original.replace(`\`${logical}\``, '`trading_accounts`').replace('bigint', drift ? 'int' : 'bigint') }]]) }
}
it('reuses historical checksums and definitions through the old coordinator, without enabling writes', async () => {
  const store = await promotedAccountHistoricalStore(fakeConnection(), plan, history)
  expect((await coordinateInplaceSchema(store, plan)).structureComplete).toBe(true)
  for (const method of ['begin', 'execute', 'complete']) expect(() => store[method](step)).toThrow('query_not_allowed')
})
it('keeps a changed column visible to the old schema verifier', async () => {
  const store = await promotedAccountHistoricalStore(fakeConnection({ drift: true }), plan, history)
  await expect(coordinateInplaceSchema(store, plan)).rejects.toThrow('schema_conflict')
})
it('rejects mixed table layouts and unknown, incomplete or altered prior journal rows', async () => {
  await expect(promotedAccountHistoricalStore(fakeConnection({ staleBuild: true }), plan, history)).rejects.toThrow('layout_conflict')
  for (const rows of [[], [...history, { ...history[0], id: 'unregistered' }], [{ ...history[0], checksum: 'changed' }]]) {
    const connection = fakeConnection()
    await expect(promotedAccountHistoricalStore(connection, plan, rows)).rejects.toThrow()
    expect(connection.query).not.toHaveBeenCalled()
  }
})
