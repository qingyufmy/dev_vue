import { canonical, exactKeys, requireBackfill as check } from './v4-backfill-contract.mjs'
import { inplaceAccountTable } from './mysql-inplace-account-backfill.mjs'

const schemas = {
  trading_account_ownership_intervals: { keys: ['id'], integers: ['user_id', 'trading_account_id'],
    dates: ['started_at_utc', 'ended_at_utc', 'created_at_utc', 'updated_at_utc'],
    columns: ['id', 'user_id', 'trading_account_id', 'role', 'started_at_utc', 'ended_at_utc', 'end_reason', 'origin_kind', 'origin_ref', 'created_at_utc', 'updated_at_utc'] },
  trading_account_ownerships: { keys: ['user_id', 'trading_account_id', 'role'], integers: ['user_id', 'trading_account_id', 'revision'],
    dates: ['granted_at_utc', 'revoked_at_utc'], columns: ['user_id', 'trading_account_id', 'role', 'granted_at_utc', 'revoked_at_utc', 'interval_id', 'revision'] },
  trading_accounts: { keys: ['id'], integers: ['id', 'ownership_revision'], dates: ['created_at_utc', 'updated_at_utc', 'deleted_at_utc'],
    columns: ['id', 'platform', 'broker_server', 'account_login', 'currency', 'margin_mode', 'created_at_utc', 'updated_at_utc', 'deleted_at_utc', 'ownership_revision'] },
  user_trading_account_settings: { keys: ['user_id', 'trading_account_id'], integers: ['user_id', 'trading_account_id', 'hidden', 'legacy_is_deleted', 'connection_paused', 'revision'],
    dates: ['observed_until_utc', 'identity_verified_at_utc', 'first_verified_at_utc', 'updated_at_utc'],
    columns: ['user_id', 'trading_account_id', 'nickname', 'review_status', 'observe_status', 'anomaly_code', 'hidden', 'legacy_is_deleted', 'connection_paused',
      'observed_until_utc', 'identity_verified_at_utc', 'first_verified_at_utc', 'revision', 'updated_at_utc'] },
}

export async function writeExact(connection, logicalTable, target) {
  const schema = schemas[logicalTable], table = inplaceAccountTable(logicalTable)
  check(schema, 'account_writer_table_invalid'); exactKeys(target, schema.columns)
  const columns = schema.columns.map(name => schema.integers.includes(name) ? `CAST(\`${name}\` AS CHAR) AS \`${name}\``
    : schema.dates.includes(name) ? `DATE_FORMAT(\`${name}\`,'%Y-%m-%d %H:%i:%s.%f') AS \`${name}\`` : `\`${name}\``).join(',')
  const sql = `SELECT ${columns} FROM \`${table}\` WHERE ${schema.keys.map(name => `\`${name}\`=?`).join(' AND ')} FOR UPDATE`
  const values = schema.keys.map(name => target[name])
  const read = async () => {
    const [rows] = await connection.execute(sql, values)
    check(rows.length <= 1, 'account_writer_target_duplicate')
    if (!rows.length) return null
    const row = { ...rows[0] }
    for (const name of schema.dates) if (row[name] !== null) {
      check(typeof row[name] === 'string' && /\.\d{3}000$/.test(row[name]), 'account_writer_time_precision_invalid')
      row[name] = row[name].slice(0, -3)
    }
    return row
  }
  const existing = await read()
  if (existing !== null) {
    check(canonical(existing) === canonical(target), 'account_writer_target_conflict')
    return
  }
  await connection.execute(`INSERT INTO \`${table}\` (${schema.columns.map(name => `\`${name}\``).join(',')}) VALUES (${schema.columns.map(() => '?').join(',')})`,
    schema.columns.map(name => target[name]))
  check(canonical(await read()) === canonical(target), 'account_writer_readback_mismatch')
}

export const accountWriterSchemas = { trading_accounts: schemas.trading_accounts, user_trading_account_settings: schemas.user_trading_account_settings }
