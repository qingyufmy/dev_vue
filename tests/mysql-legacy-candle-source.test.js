import { expect, it } from 'vitest'
import { hash } from '../scripts/lib/v4-backfill-contract.mjs'
import { planAccountIdMappings } from '../scripts/lib/v4-account-id-mapping.mjs'
import { readLegacyCandleConversion } from '../scripts/lib/mysql-legacy-candle-source.mjs'

function fixture() {
  const input = { accounts: [{ id: '1', userId: '1', server: 'Broker', login: '42' }],
    terminals: [{ id: 'terminal', userId: '1', server: 'Broker', login: '42', platform: 'mt5' }],
    bindings: [{ server: 'BROKER', login: '42', currentAccountId: '1', currentUserId: '1', currency: 'USD' }] }
  const evidence = Object.fromEntries(Object.entries(input).map(([name, rows]) => [name, rows.map(row => ({ ...row, sourceHash: hash(row) }))]))
  const accountMappingHash = planAccountIdMappings('dev_vue', evidence, ['1']).mappingHash
  const row = { source_id: '1', standard_symbol: 'XAUUSD', timeframe: 'M5', open_time_utc_msc: '1745600400123',
    open_price: '1.0000000000', high_price: '1.0000000000', low_price: '1.0000000000', close_price: '1.0000000000', tick_volume: '1' }
  const rows = [{ ...row, id: '2' }, { ...row, id: '10' }], queries = []
  const connection = { async query(sql) {
    queries.push(sql)
    if (sql.includes('transaction_isolation')) return [[{ isolationLevel: 'REPEATABLE-READ' }]]
    if (sql.includes('FROM trading_accounts_legacy_v3')) return [input.accounts]
    if (sql.includes('FROM trading_accounts ')) return [[{ targetAccountId: '1', platform: 'mt5', brokerServer: 'Broker', accountLogin: '42', currency: 'USD' }]]
    if (sql.includes('FROM bridge_v3_terminal_sessions')) return [input.terminals]
    if (sql.includes('FROM mt5_account_bindings')) return [input.bindings]
    if (sql.includes('FROM market_data_sources')) return [[{ id: '1', userId: '1', server: 'Broker', login: '42' }]]
    if (sql.includes('COUNT(*)')) return [[{ total: '2' }]]
    throw Error('unexpected_query')
  }, async execute(sql, [cursor]) {
    queries.push(sql)
    // Deliberately emulate MySQL resolving ORDER BY id to the character alias.
    const ordered = [...rows].sort(sql.includes('ORDER BY market_candles.id')
      ? (a, b) => Number(BigInt(a.id) - BigInt(b.id)) : (a, b) => a.id.localeCompare(b.id))
    return [ordered.filter(row => BigInt(row.id) > BigInt(cursor)).slice(0, 1)]
  } }
  return { connection, input, rows, queries, options: { accountMappingHash, writerHash: hash('writer') } }
}

it('uses a numeric source cursor and reads every row while locking the source identities', async () => {
  const f = fixture(), result = await readLegacyCandleConversion(f.connection, { ...f.options, lock: true })
  expect(result.conversion.mappings.map(row => row.legacyCandleId)).toEqual(['2', '10'])
  expect(result.conversion).toMatchObject({ inputRows: 2, outputRows: 1 })
  expect(f.queries.filter(sql => /FROM (trading_accounts|bridge_v3_terminal_sessions|mt5_account_bindings|market_data_sources|market_candles FORCE)/.test(sql)).every(sql => sql.endsWith(' FOR SHARE'))).toBe(true)
  expect(f.queries.some(sql => /INSERT|UPDATE|DELETE/.test(sql))).toBe(false)
})

it('rejects changed accounts and incomplete source pages', async () => {
  const f = fixture(); f.input.terminals[0].platform = 'mt4'
  await expect(readLegacyCandleConversion(f.connection, f.options)).rejects.toThrow('account_mapping_changed')
  const g = fixture(); g.rows.pop()
  await expect(readLegacyCandleConversion(g.connection, g.options)).rejects.toThrow('count_changed')
})

it('requires repeatable-read range locking and approved evidence', async () => {
  const f = fixture()
  f.connection.query = async () => [[{ isolationLevel: 'READ-COMMITTED' }]]
  await expect(readLegacyCandleConversion(f.connection, { ...f.options, lock: true })).rejects.toThrow('isolation')
  await expect(readLegacyCandleConversion(f.connection, { ...f.options, writerHash: '' })).rejects.toThrow('evidence')
})

it('refuses a V4 target whose identity no longer matches the reviewed legacy mapping', async () => {
  const f = fixture(), query = f.connection.query
  f.connection.query = async sql => sql.includes('FROM trading_accounts ')
    ? [[{ targetAccountId: '1', platform: 'mt4', brokerServer: 'Broker', accountLogin: '42', currency: 'USD' }]] : query(sql)
  await expect(readLegacyCandleConversion(f.connection, f.options)).rejects.toThrow('target_identity_changed')
})
