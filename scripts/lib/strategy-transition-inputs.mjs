import assert from 'node:assert/strict'
import { legacyStrategyFields, legacySubscriptionFields } from './v4-strategy-source-review.mjs'
import { hash } from './v4-backfill-contract.mjs'

export async function readStrategyTransitionInputs(connection, { lock = false } = {}) {
  const suffix = lock ? ' FOR SHARE' : ''
  const query = async sql => (await connection.query(sql + suffix))[0].map(row => ({ ...row }))
  const source = async (table, fields) => {
    const [columns] = await connection.execute('SELECT COLUMN_NAME name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY ORDINAL_POSITION', [table])
    assert.deepEqual(columns.map(row => row.name), fields)
    const rows = await query(`SELECT ${fields.map(field => `CAST(\`${field}\` AS CHAR) \`${field}\``).join(',')} FROM ${table} ORDER BY id LIMIT 1001`)
    assert.ok(rows.length <= 1000)
    return rows
  }
  const strategies = await source('auto_prompt_types', legacyStrategyFields)
  const subscriptions = await source('strategy_subscriptions_legacy_v3', legacySubscriptionFields)
  const users = await query('SELECT CAST(id AS CHAR) id FROM users ORDER BY id')
  const accounts = await query('SELECT CAST(id AS CHAR) id FROM trading_accounts ORDER BY id')
  const legacyAccounts = await query('SELECT CAST(id AS CHAR) id,CAST(user_id AS CHAR) userId FROM trading_accounts_legacy_v3 ORDER BY id')
  const ownerships = await query("SELECT CAST(user_id AS CHAR) userId,CAST(trading_account_id AS CHAR) accountId FROM trading_account_ownerships WHERE role='owner' AND revoked_at_utc IS NULL ORDER BY trading_account_id,user_id")
  const intervals = await query("SELECT id,CAST(user_id AS CHAR) userId,CAST(trading_account_id AS CHAR) accountId,CAST(started_at_utc AS CHAR) started_at_utc,CAST(ended_at_utc AS CHAR) ended_at_utc FROM trading_account_ownership_intervals WHERE role='owner' ORDER BY trading_account_id,user_id,id")
  const maps = await query("SELECT source_pk_json,target_json FROM data_migration_id_maps WHERE logical_source_id='dev_vue' AND entity_kind='trading_account' AND source_table='trading_accounts' ORDER BY source_pk_sha256")
  const decode = value => typeof value === 'string' ? JSON.parse(value) : value
  const accountMap = maps.map(row => {
    const source = decode(row.source_pk_json), target = decode(row.target_json)
    assert.ok(source.length === 1 && source[0].type === 'integer' && target.table === 'trading_accounts' && target.pk.length === 1 && target.pk[0].type === 'integer')
    assert.ok(accounts.some(row => row.id === target.pk[0].value))
    return [source[0].value, target.pk[0].value]
  }).sort(([a], [b]) => a.localeCompare(b))
  assert.equal(new Set(accountMap.map(([id]) => id)).size, accountMap.length)
  for (const row of subscriptions) assert.ok(legacyAccounts.some(account => account.id === row.trading_account_id && account.userId === row.user_id))
  const history = await query('SELECT id,checksum_sha256 checksum,status FROM database_upgrade_steps_v4 ORDER BY id')
  return { strategies, subscriptions, users, accounts, legacyAccounts, ownerships, intervals, accountMap, historyHash: hash(history) }
}
