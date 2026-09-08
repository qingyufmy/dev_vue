import { hash } from './v4-backfill-contract.mjs'
import { planAccountIdMappings } from './v4-account-id-mapping.mjs'
import { planLegacyCandleSources, planLegacyCandleConversion } from './legacy-candle-conversion.mjs'

const check = (value, code) => { if (!value) throw Error('legacy_candle_source_' + code) }

// Caller owns the transaction. Locking reads protect identity rows and the full
// primary-key source range until the build batch commits (REPEATABLE READ).
export async function readLegacyCandleConversion(connection, { accountMappingHash, writerHash, lock = false }) {
  check(/^[a-f0-9]{64}$/.test(accountMappingHash) && /^[a-f0-9]{64}$/.test(writerHash), 'evidence')
  const suffix = lock ? ' FOR SHARE' : ''
  if (lock) {
    const [[session]] = await connection.query('SELECT @@session.transaction_isolation isolationLevel')
    check(session.isolationLevel === 'REPEATABLE-READ', 'isolation')
  }
  const [accounts] = await connection.query('SELECT CAST(id AS CHAR) id,CAST(user_id AS CHAR) userId,broker_server server,login_account login FROM trading_accounts_legacy_v3 ORDER BY trading_accounts_legacy_v3.id LIMIT 10001' + suffix)
  const [terminals] = await connection.query('SELECT terminal_instance_id id,CAST(user_id AS CHAR) userId,platform,broker_server server,login_account login FROM bridge_v3_terminal_sessions ORDER BY terminal_instance_id LIMIT 10001' + suffix)
  const [bindings] = await connection.query('SELECT broker_server_key server,login_account login,CAST(current_user_id AS CHAR) currentUserId,CAST(current_trading_account_id AS CHAR) currentAccountId,account_currency currency FROM mt5_account_bindings ORDER BY broker_server_key,login_account LIMIT 10001' + suffix)
  check([accounts, terminals, bindings].every(rows => rows.length <= 10000), 'identity_budget')
  const input = Object.fromEntries(Object.entries({ accounts, terminals, bindings }).map(([key, rows]) => [key, rows.map(row => ({ ...row, sourceHash: hash({ ...row }) }))]))
  const accountPlan = planAccountIdMappings('dev_vue', input, accounts.map(row => row.id))
  check(accountPlan.mappingHash === accountMappingHash, 'account_mapping_changed')
  const [targets] = await connection.query('SELECT CAST(id AS CHAR) targetAccountId,platform,broker_server brokerServer,account_login accountLogin,currency FROM trading_accounts ORDER BY trading_accounts.id LIMIT 10001' + suffix)
  check(targets.length <= 10000, 'target_budget')
  for (const expected of accountPlan.entities) {
    const current = targets.filter(row => row.targetAccountId === expected.targetAccountId)
    check(current.length === 1 && current[0].platform === expected.platform && current[0].brokerServer.toUpperCase() === expected.brokerServerKey
      && current[0].accountLogin === expected.accountLogin && current[0].currency === expected.currency, 'target_identity_changed')
  }
  const [sources] = await connection.query('SELECT CAST(id AS CHAR) id,CAST(bridge_user_id AS CHAR) userId,broker_server server,CAST(account_login AS CHAR) login FROM market_data_sources ORDER BY market_data_sources.id LIMIT 10001' + suffix)
  const sourcePlan = planLegacyCandleSources(sources, accountPlan)
  const [[count]] = await connection.query('SELECT CAST(COUNT(*) AS CHAR) total FROM market_candles')
  check(BigInt(count.total) <= 100000n, 'row_budget')
  const rows = []; let cursor = '0'
  for (;;) {
    const [page] = await connection.execute('SELECT CAST(id AS CHAR) id,CAST(source_id AS CHAR) source_id,broker_symbol,standard_symbol,timeframe,CAST(open_time_utc_msc AS CHAR) open_time_utc_msc,broker_time,open_price,high_price,low_price,close_price,CAST(tick_volume AS CHAR) tick_volume,CAST(spread AS CHAR) spread,updated_at FROM market_candles FORCE INDEX (PRIMARY) WHERE market_candles.id > ? ORDER BY market_candles.id LIMIT 500' + suffix, [cursor])
    if (!page.length) break
    check(rows.length + page.length <= 100000, 'page_budget')
    for (const row of page) { check(BigInt(row.id) > BigInt(cursor), 'cursor_order'); rows.push(row); cursor = row.id }
  }
  check(String(rows.length) === count.total, 'count_changed')
  return { sourcePlan, conversion: planLegacyCandleConversion(rows, sourcePlan,
    { closedPolicy: 'legacy-closed-writer/v1', symbolPolicy: 'stored-standard-symbol/v1', writerHash, revision: '1' }) }
}
