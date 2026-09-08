import { hash } from './v4-backfill-contract.mjs'
import { accountSourceFields } from './v4-account-conversion.mjs'
import { planAccountIdMappings } from './v4-account-id-mapping.mjs'
import { reviewAccountOwnership } from './v4-account-ownership-consistency.mjs'
import { createAccountBackfill } from './v4-account-backfill-writer.mjs'
import { createOwnershipBackfill } from './v4-ownership-backfill-writer.mjs'
import assert from 'node:assert/strict'

// Reconstruct the fixed wave after partial execution without requiring empty builds.
export async function readCurrentAccountWave(connection) {
  const columns = accountSourceFields.map(name => ['id', 'user_id', 'is_deleted'].includes(name)
    ? `CAST(\`${name}\` AS CHAR) \`${name}\`` : `\`${name}\``).join(',')
  const [rows] = await connection.query(`SELECT ${columns} FROM trading_accounts ORDER BY id`)
  const [users] = await connection.query('SELECT CAST(id AS CHAR) id FROM users ORDER BY id')
  const [terminals] = await connection.query('SELECT terminal_instance_id id,CAST(user_id AS CHAR) userId,platform,broker_server server,login_account login FROM bridge_v3_terminal_sessions ORDER BY terminal_instance_id')
  const [bindings] = await connection.query('SELECT broker_server_key server,login_account login,CAST(current_user_id AS CHAR) currentUserId,CAST(current_trading_account_id AS CHAR) currentAccountId,account_currency currency FROM mt5_account_bindings ORDER BY broker_server_key,login_account')
  const [intervals] = await connection.query('SELECT CAST(id AS CHAR) id,broker_server_key,login_account,CAST(user_id AS CHAR) user_id,CAST(trading_account_id AS CHAR) trading_account_id,started_at,ended_at,end_reason,created_at,updated_at FROM mt5_account_ownership_history ORDER BY id')
  const accounts = rows.map(row => ({ id: row.id, userId: row.user_id, server: row.broker_server, login: row.login_account }))
  const inputs = Object.fromEntries(Object.entries({ accounts, terminals, bindings }).map(([key, values]) =>
    [key, values.map(row => ({ ...row, sourceHash: hash({ ...row }) }))]))
  const mapping = planAccountIdMappings('dev_vue', inputs, accounts.map(row => row.id))
  const userIds = new Set(users.map(row => row.id))
  const ownership = reviewAccountOwnership({ accounts: rows, bindings, intervals, accountMap: mapping.ownershipMap, userIds })
  assert.equal(ownership.currentOwnershipConsistent, true)
  const timeBasis = sourceTable => ({ sourceTable, offsetMinutes: 0, evidenceId: 'user-confirmed-legacy-utc-20260908' })
  const account = createAccountBackfill(rows, mapping, { userIds, timeBasis: timeBasis('trading_accounts') }, { batchSize: 2, preserveSource: true })
  const interval = createOwnershipBackfill(intervals, { logicalSourceId: 'dev_vue', accountMap: mapping.ownershipMap, userIds,
    timeBasis: timeBasis('mt5_account_ownership_history') }, { batchSize: 64, expectedSourceIds: intervals.map(row => row.id), preserveSource: true })
  return { account, interval, inputSha256: hash({ rows, users, terminals, bindings, intervals }) }
}
