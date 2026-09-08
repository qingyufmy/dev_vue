import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { hash } from './v4-backfill-contract.mjs'
import { sha256 } from './v4-migration-plan.mjs'
import { accountSourceFields } from './v4-account-conversion.mjs'
import { planAccountIdMappings } from './v4-account-id-mapping.mjs'
import { reviewAccountOwnership } from './v4-account-ownership-consistency.mjs'
import { createAccountBackfill } from './v4-account-backfill-writer.mjs'
import { createOwnershipBackfill } from './v4-ownership-backfill-writer.mjs'
import { readAccountBackfillV2Identity } from './mysql-account-backfill-v2.mjs'
import { readAccountRootSnapshot } from './mysql-account-root-snapshot.mjs'
import { mysqlColumnStore } from './mysql-inplace-column-store.mjs'

// Caller owns a UTC, consistent, read-only transaction. No writer is invoked here.
export async function prepareCurrentAccountWave(connection, root) {
  const targetIdentity = await readAccountBackfillV2Identity(connection)
  assert.equal(targetIdentity.database, 'dev_vue')
  assert.equal(targetIdentity.serverUuid, 'ac423207-6ef3-11f1-b302-000c29fda104')
  const history = await mysqlColumnStore(connection, true).history()
  const snapshot = await readAccountRootSnapshot(connection)
  const build = ['trading_accounts_v4_build', 'user_trading_account_settings_v4_build',
    'trading_account_ownership_intervals_v4_build', 'trading_account_ownerships_v4_build']
  for (const name of build) assert.equal(snapshot.tables.find(table => table.name === name)?.rows, 0)
  const [[existing]] = await connection.query("SELECT COUNT(*) n FROM data_migration_id_maps WHERE logical_source_id='dev_vue' AND source_table IN ('trading_accounts','mt5_account_ownership_history')")
  assert.equal(Number(existing.n), 0)
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
  // Include all existing table and ledger digests; publish no source row payload.
  const tables = snapshot.tables.map(({ name, rows, rowsSha256, ddl }) => ({ name, rows, rowsSha256, ddlSha256: sha256(ddl) }))
  for (const table of snapshot.tables) {
    assert.match(table.name, /^[a-z][a-z0-9_]*$/)
    const [[current]] = await connection.query(`SHOW CREATE TABLE \`${table.name}\``)
    assert.equal(current['Create Table'], table.ddl)
  }
  const [names] = await connection.query('SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME')
  assert.deepEqual(names.map(row => row.name), tables.map(row => row.name))
  assert.deepEqual(await mysqlColumnStore(connection, true).history(), history)
  const prior = JSON.parse(await readFile(new URL('docs/architecture/context-changes-plan-20260908.json', root)))
  for (const tool of prior.tools) assert.equal(sha256(await readFile(new URL(tool.path, root))), tool.sha256)
  const paths = [...new Set([...prior.tools.map(tool => tool.path), 'scripts/lib/current-account-wave-preparation.mjs',
    'scripts/prepare-current-account-wave-local.mjs'])].sort()
  const tools = await Promise.all(paths.map(async path => ({ path, sha256: sha256(await readFile(new URL(path, root))) })))
  const summarize = prepared => ({ stream: prepared.stream, sourceRows: prepared.sourceRows, transformHash: prepared.transformHash,
    batches: prepared.batches.map(batch => ({ batchId: batch.batchId, sequence: batch.sequence, rows: batch.rows.length })) })
  const frozen = { kind: 'current-account-wave-preparation/v1', targetIdentity, historySha256: hash(history), tables, tools,
    inputSha256: hash({ rows, users, terminals, bindings, intervals }), mappingHash: mapping.mappingHash,
    ownershipEvidenceHash: ownership.evidenceHash, timeOffsetMinutes: 0,
    account: { ...summarize(account), sourceHash: account.sourceHash, entityCount: account.entityCount },
    ownership: { ...summarize(interval), grantCount: interval.grantCount },
    admission: { executable: false, blockers: ['current_backup_restore_required', 'writer_quiescence_required', 'apply_time_revalidation_required'] } }
  return { frozen, manifestHash: hash(frozen) }
}
