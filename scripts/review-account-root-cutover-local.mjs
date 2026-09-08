import { open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import mysql from 'mysql2/promise'
import { loadSettingsMigrationEnvironment, settingsMigrationConnectionOptions } from './lib/settings-migration-environment.mjs'
import { hash } from './lib/v4-backfill-contract.mjs'
import { accountSourceFields, convertAccountRows } from './lib/v4-account-conversion.mjs'
import { planAccountIdMappings } from './lib/v4-account-id-mapping.mjs'
import { reviewAccountOwnership } from './lib/v4-account-ownership-consistency.mjs'
import { loadSubscriptionForeignKeyCoordinator } from './lib/inplace-subscription-foreign-key-schema.mjs'
import { coordinateInplaceSchema } from './lib/inplace-schema-coordinator.mjs'
import { mysqlColumnStore, verifyInplaceJournal, withInplaceUpgradeLock } from './lib/mysql-inplace-column-store.mjs'

const root = new URL('../', import.meta.url)
const check = (condition, code) => { if (!condition) throw Error(`account_root_review_${code}`) }
const timeBasis = Object.freeze({ sourceTable: 'trading_accounts', offsetMinutes: 0, evidenceId: 'user-confirmed-legacy-utc-20260908' })
let connection, output
try {
  const [mode, destination] = process.argv.slice(2)
  check(mode === '--read-only' && process.argv.length === 4 && isAbsolute(destination), 'arguments')
  output = await open(destination, 'wx', 0o600)
  const env = await loadSettingsMigrationEnvironment(root)
  check(env.MYSQL_DATABASE === 'dev_vue' && env.MYSQL_USER === 'dev_vue', 'environment')
  connection = await mysql.createConnection({ ...settingsMigrationConnectionOptions(env), connectTimeout: 5000, multipleStatements: false })
  await connection.query("SET SESSION time_zone='+00:00'")
  const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid uuid')
  check(identity.db === 'dev_vue' && identity.uuid === 'ac423207-6ef3-11f1-b302-000c29fda104', 'identity')
  const report = await withInplaceUpgradeLock(connection, 'dev_vue', async () => {
    await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
    try {
      check(await verifyInplaceJournal(connection), 'journal')
      const history = await mysqlColumnStore(connection, true).history()
      check(history.length === 147 && history.every(row => row.status === 'completed'), 'journal_status')
      let schemaVerification
      try {
        const coordinator = await loadSubscriptionForeignKeyCoordinator(root)
        const schema = await coordinateInplaceSchema(coordinator.store(connection), coordinator)
        check(schema.structureComplete && schema.steps.length === 147, 'schema')
        schemaVerification = { verified: true }
      } catch (error) {
        // This report never migrates. Preserve the failed gate while collecting
        // independent source facts; upgrade executors retain their strict check.
        if (error.message !== 'inplace_learning_reference_tools') throw error
        schemaVerification = { verified: false, code: error.message }
      }
      const columns = accountSourceFields.map(name => ['id', 'user_id', 'is_deleted'].includes(name)
        ? `CAST(\`${name}\` AS CHAR) \`${name}\`` : `\`${name}\``).join(',')
      const [rows] = await connection.query(`SELECT ${columns} FROM trading_accounts ORDER BY id`)
      const [users] = await connection.query('SELECT CAST(id AS CHAR) id FROM users ORDER BY id')
      const [terminals] = await connection.query('SELECT terminal_instance_id id,CAST(user_id AS CHAR) userId,platform,broker_server server,login_account login FROM bridge_v3_terminal_sessions ORDER BY terminal_instance_id')
      const [bindings] = await connection.query('SELECT broker_server_key server,login_account login,CAST(current_user_id AS CHAR) currentUserId,CAST(current_trading_account_id AS CHAR) currentAccountId,account_currency currency FROM mt5_account_bindings ORDER BY broker_server_key,login_account')
      const [intervals] = await connection.query('SELECT CAST(id AS CHAR) id,broker_server_key,login_account,CAST(user_id AS CHAR) user_id,CAST(trading_account_id AS CHAR) trading_account_id,started_at,ended_at,end_reason,created_at,updated_at FROM mt5_account_ownership_history ORDER BY id')
      const accounts = rows.map(row => ({ id: row.id, userId: row.user_id, server: row.broker_server, login: row.login_account }))
      const input = Object.fromEntries(Object.entries({ accounts, terminals, bindings }).map(([key, values]) => [key, values.map(row => ({ ...row, sourceHash: hash({ ...row }) }))]))
      const plan = planAccountIdMappings('dev_vue', input, accounts.map(row => row.id))
      const userIds = new Set(users.map(row => row.id))
      const conversion = convertAccountRows(rows, plan, { userIds, timeBasis })
      const ownership = reviewAccountOwnership({ accounts: rows, bindings, intervals, accountMap: plan.ownershipMap, userIds })
      const [foreignKeys] = await connection.query(`SELECT TABLE_NAME table_name,COLUMN_NAME column_name,CONSTRAINT_NAME constraint_name,
        REFERENCED_TABLE_NAME parent_table,REFERENCED_COLUMN_NAME parent_column
        FROM information_schema.KEY_COLUMN_USAGE WHERE CONSTRAINT_SCHEMA=DATABASE()
        AND REFERENCED_TABLE_NAME='trading_accounts' ORDER BY TABLE_NAME,CONSTRAINT_NAME,ORDINAL_POSITION`)
      const buildCounts = {}
      for (const table of ['trading_accounts_v4_build', 'trading_account_ownership_intervals_v4_build', 'trading_account_ownerships_v4_build', 'user_trading_account_settings_v4_build']) {
        const [[row]] = await connection.query(`SELECT CAST(COUNT(*) AS CHAR) count FROM \`${table}\``)
        buildCounts[table] = row.count
      }
      return { kind: 'account-root-cutover-review/v1', observedAt: new Date().toISOString(), database: identity.db,
        journalCompletedSteps: history.length, schemaVerification, databaseWrites: 0, timeBasis,
        counts: { sourceAccounts: rows.length, targetEntities: conversion.entities.length, targetSettings: conversion.settings.length,
          mergedSourceIds: plan.mappings.filter(row => row.sourcePk[0].value !== row.target.pk[0].value).length },
        sourceHash: conversion.sourceHash, mappingHash: plan.mappingHash, transformHash: conversion.transformHash,
        ownership, foreignKeys, buildCounts, readyForCutover: false,
        remaining: ['persist_and_reconcile_mapping_and_source_receipts', 'preserve_legacy_root_and_child_references',
          'populate_and_reconcile_ownership_and_settings', 'rehearse_root_switch_and_failure_recovery', 'verify_account_runtime_on_formal_tables'] }
    } finally { await connection.rollback() }
  })
  await output.writeFile(JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ status: report.schemaVerification.verified ? 'reviewed' : 'needs_review', schemaVerification: report.schemaVerification, counts: report.counts, currentOwnershipConsistent: report.ownership.currentOwnershipConsistent,
    foreignKeys: report.foreignKeys.length, buildCounts: report.buildCounts, databaseWrites: 0, readyForCutover: false }))
} catch (error) {
  const code = /^(account_root_review|account_conversion|account_mapping|ownership_consistency|inplace|backfill)_[a-z0-9_]+$/.test(error.message) ? error.message : 'account_root_review_failed'
  if (output) await output.writeFile(JSON.stringify({ failed: true, code, readyForCutover: false }) + '\n').catch(() => {})
  console.error(JSON.stringify({ code }))
  process.exitCode = 1
} finally {
  if (output) await output.close().catch(() => {})
  if (connection) await connection.end().catch(() => {})
}
