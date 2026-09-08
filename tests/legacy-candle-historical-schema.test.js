import { expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { historicalCandleDefinition, promotedCandleMetadataConnection } from '../scripts/lib/legacy-candle-historical-schema.mjs'
import { promotedAccountMetadataConnection } from '../scripts/lib/account-root-historical-schema.mjs'
import { legacyCandlePromotionSnapshot } from '../scripts/lib/legacy-candle-promotion.mjs'
import { hash } from '../scripts/lib/v4-backfill-contract.mjs'

it('normalizes actual reference mapping FKs back to both original targets', async () => {
  const reference = JSON.parse(await readFile(new URL('../docs/architecture/legacy-candle-build-reference-20260908.json', import.meta.url)))
  const before = reference.definitions.find(row => row.table === 'legacy_candle_mappings_v4').ddl
  const after = reference.promotedDefinitions.find(row => row.table === 'legacy_candle_mappings_v4').ddl
  expect(historicalCandleDefinition('legacy_candle_mappings_v4', after)).toBe(before)
})

it('does not rewrite column names, constraint names, comments or string literals', () => {
  const ddl = "CREATE TABLE `links` (\n  `market_candles` varchar(64) DEFAULT 'market_candles_legacy_v3',\n  CONSTRAINT `market_candles` FOREIGN KEY (`id`) REFERENCES `market_candles_legacy_v3` (`id`)\n) ENGINE=InnoDB COMMENT='REFERENCES `market_candles`'"
  expect(historicalCandleDefinition('links', ddl)).toBe(ddl.replace('(`id`) REFERENCES `market_candles_legacy_v3`', '(`id`) REFERENCES `market_candles`'))
})

it('composes beneath the existing account adapter without remapping account metadata twice', async () => {
  const connection = { query: vi.fn(async sql => {
    const name = /`([^`]+)`/.exec(sql)[1]
    return [[{ Table: name, 'Create Table': `CREATE TABLE \`${name}\` (\n  \`id\` bigint NOT NULL\n) ENGINE=InnoDB` }]]
  }) }
  const reader = promotedAccountMetadataConnection(promotedCandleMetadataConnection(connection))
  for (const [logical, actual] of [['market_candles', 'market_candles_legacy_v3'], ['market_candles_build_v4', 'market_candles'], ['trading_accounts', 'trading_accounts_legacy_v3']]) {
    const [[row]] = await reader.query('SHOW CREATE TABLE `' + logical + '`')
    expect(connection.query).toHaveBeenLastCalledWith('SHOW CREATE TABLE `' + actual + '`')
    expect(row['Create Table']).toContain('CREATE TABLE `' + logical + '`')
  }
})

it('maps only allowed metadata table parameters and refuses every mutation', async () => {
  const connection = { query: vi.fn(), execute: vi.fn(async () => [[]]) }, reader = promotedCandleMetadataConnection(connection)
  const sql = 'SELECT COLUMN_TYPE type,IS_NULLABLE nullable,COLUMN_DEFAULT defaultValue,COLLATION_NAME collation,EXTRA extra FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?'
  await reader.execute(sql, ['market_candles', 'market_candles'])
  expect(connection.execute).toHaveBeenCalledWith(sql, ['market_candles_legacy_v3', 'market_candles'])
  for (const text of ['SELECT * FROM market_candles', 'RENAME TABLE a TO b', 'SHOW CREATE TABLE market_candles; DROP TABLE users', { sql }]) {
    await expect(reader.query(text)).rejects.toThrow('query_not_allowed')
    await expect(reader.execute(text, [])).rejects.toThrow('query_not_allowed')
  }
  expect(connection.query).not.toHaveBeenCalled()
})

it('rejects stale builds, views and incomplete promoted layouts in table inventory', async () => {
  for (const rows of [[], [{ name: 'market_candles', kind: 'VIEW' }, { name: 'market_candles_legacy_v3', kind: 'BASE TABLE' }],
    ['market_candles', 'market_candles_legacy_v3', 'market_candles_build_v4'].map(name => ({ name, kind: 'BASE TABLE' }))]) {
    const reader = promotedCandleMetadataConnection({ query: async () => [rows] })
    await expect(reader.query('SELECT TABLE_NAME name,TABLE_TYPE kind FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()')).rejects.toThrow('layout')
  }
})

it('preserves exact historical row evidence through forward and inverse snapshots', () => {
  const tables = ['database_upgrade_steps_v4', 'market_candles', 'market_candles_build_v4'].map(name => ({ name,
    ddl: `CREATE TABLE \`${name}\` (\n  \`id\` bigint NOT NULL\n) ENGINE=InnoDB`, rows: 3, rowsSha256: hash(name) }))
  const renamed = tables.map(row => { const name = row.name === 'market_candles' ? 'market_candles_legacy_v3' : row.name === 'market_candles_build_v4' ? 'market_candles' : row.name
    return { ...row, name, ddl: row.ddl.replace('`' + row.name + '`', '`' + name + '`') } })
  expect(legacyCandlePromotionSnapshot(renamed)).toEqual(legacyCandlePromotionSnapshot(tables, { promote: true }))
  expect(legacyCandlePromotionSnapshot(renamed, { historical: true })).toEqual(legacyCandlePromotionSnapshot(tables))
  expect(() => legacyCandlePromotionSnapshot(tables, { historical: true })).toThrow('layout')
  expect(() => historicalCandleDefinition('market_candles', tables[1].ddl)).toThrow('definition_table')
})
