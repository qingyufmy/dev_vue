import assert from 'node:assert/strict'
import { readFile, open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { parse } from 'dotenv'
import mysql from 'mysql2/promise'
import { hash } from './lib/v4-backfill-contract.mjs'
import { legacyStrategyFields, legacySubscriptionFields, reviewStrategySources } from './lib/v4-strategy-source-review.mjs'
import { convertStrategyMetadata } from './lib/v4-strategy-metadata-conversion.mjs'
import { convertSubscriptionSymbols } from './lib/v4-subscription-symbol-conversion.mjs'
import { convertSubscriptionSchedule } from './lib/v4-subscription-schedule-conversion.mjs'
import { convertStrategyRoleConfig } from './lib/v4-strategy-role-config-conversion.mjs'
import { convertSubscriptionExecutionPreferences } from './lib/v4-subscription-preferences-conversion.mjs'
import { reviewSubscriptionConfig } from './lib/v4-subscription-config-review.mjs'
import { loadStrategyBackfillSchema, inspectStrategyBackfillSchema } from './lib/strategy-backfill-schema-preflight.mjs'

// Read the promoted account namespace; never reinterpret a legacy account ID as a V4 ID.
const [destination] = process.argv.slice(2)
assert.ok(process.argv.length === 3 && isAbsolute(destination ?? ''))
const env = parse(await readFile(new URL('../server/.env', import.meta.url)))
assert.equal(env.MYSQL_HOST, '192.168.1.254')
assert.equal(env.MYSQL_DATABASE, 'dev_vue')
const output = await open(destination, 'wx', 0o600)
const report = { kind: 'strategy-upgrade-source-inventory/v1', inspected: false, businessWritesPerformed: false }
let connection
try {
  connection = await mysql.createConnection({ host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT || 3306),
    user: env.MYSQL_USER, password: env.MYSQL_PASSWORD, database: env.MYSQL_DATABASE,
    dateStrings: true, timezone: 'Z', supportBigNumbers: true, bigNumberStrings: true })
  await connection.query("SET SESSION time_zone='+00:00'")
  await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
  await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
  const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid uuid,@@version version')
  assert.equal(identity.db, 'dev_vue')
  assert.equal(identity.uuid, 'ac423207-6ef3-11f1-b302-000c29fda104')
  report.identity = identity
  const readSource = async (table, fields) => {
    const [columns] = await connection.execute('SELECT COLUMN_NAME name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY ORDINAL_POSITION', [table])
    assert.deepEqual(columns.map(row => row.name), fields)
    const [rows] = await connection.query(`SELECT ${fields.map(field => `CAST(\`${field}\` AS CHAR) \`${field}\``).join(',')} FROM \`${table}\` ORDER BY id LIMIT 1001`)
    assert.ok(rows.length <= 1000, 'source_inventory_limit')
    return rows.map(row => ({ ...row }))
  }
  const strategies = await readSource('auto_prompt_types', legacyStrategyFields)
  const subscriptions = await readSource('strategy_subscriptions', legacySubscriptionFields)
  const [riskRows] = await connection.query('SELECT CAST(id AS CHAR) id,CAST(user_id AS CHAR) user_id,status,CAST(deleted_at AS CHAR) deleted_at FROM risk_profiles ORDER BY id LIMIT 1001')
  assert.ok(riskRows.length <= 1000, 'risk_profile_inventory_limit')
  const riskProfiles = riskRows.map(row => ({ ...row }))
  const [users] = await connection.query('SELECT CAST(id AS CHAR) id FROM users ORDER BY id')
  const [legacyAccounts] = await connection.query('SELECT CAST(id AS CHAR) id,CAST(user_id AS CHAR) userId FROM trading_accounts_legacy_v3 ORDER BY id')
  const [accounts] = await connection.query('SELECT CAST(id AS CHAR) id FROM trading_accounts ORDER BY id')
  const [ownerships] = await connection.query("SELECT CAST(user_id AS CHAR) userId,CAST(trading_account_id AS CHAR) accountId FROM trading_account_ownerships WHERE role='owner' AND revoked_at_utc IS NULL ORDER BY trading_account_id,user_id")
  const [intervals] = await connection.query("SELECT id,CAST(user_id AS CHAR) userId,CAST(trading_account_id AS CHAR) accountId,started_at_utc,ended_at_utc FROM trading_account_ownership_intervals WHERE role='owner' ORDER BY trading_account_id,user_id,id")
  const [maps] = await connection.execute('SELECT source_pk_json,target_json FROM data_migration_id_maps WHERE logical_source_id=? AND entity_kind=? AND source_table=? ORDER BY source_pk_sha256', ['dev_vue', 'trading_account', 'trading_accounts'])
  const decode = value => typeof value === 'string' ? JSON.parse(value) : value
  const accountMap = new Map()
  for (const row of maps) {
    const source = decode(row.source_pk_json), target = decode(row.target_json)
    assert.ok(Array.isArray(source) && source.length === 1 && source[0].type === 'integer')
    assert.ok(target.table === 'trading_accounts' && target.pk.length === 1 && target.pk[0].type === 'integer')
    assert.ok(!accountMap.has(source[0].value))
    assert.ok(accounts.some(account => account.id === target.pk[0].value))
    accountMap.set(source[0].value, target.pk[0].value)
  }
  const userIds = new Set(users.map(row => row.id))
  report.sourceReview = reviewStrategySources({ strategies, subscriptions, userIds, accountIds: new Set(legacyAccounts.map(row => row.id)) })
  report.timeBasis = { interpretation: 'UTC', evidence: 'user-confirmed-legacy-utc-20260908' }
  report.strategyCandidates = strategies.map(row => {
    const metadata = convertStrategyMetadata(row, userIds)
    const { retainedSource, ...roleConfig } = convertStrategyRoleConfig(row)
    // A policy can contain user-authored prompt rules. Preserve its bytes in
    // the conversion input, but put only field hashes in the inventory log.
    roleConfig.retainedSourceHashes = Object.fromEntries(Object.entries(retainedSource).map(([field, value]) => [field, hash(value)]))
    // Keep prompt/title/description out of this review artifact; exact bytes are covered by sourceHash.
    return { sourceId: row.id, sourceHash: hash(row), metadataStatus: metadata.status,
      problems: metadata.problems, sourceVersion: row.version, inferenceMode: row.inference_mode,
      lifecycle: metadata.candidate?.status ?? null, promptHash: metadata.candidate?.promptHash ?? null,
      roleResolved: false, roleConfig }
  })
  report.subscriptionCandidates = subscriptions.map(row => {
    const strategy = strategies.find(item => item.id === row.strategy_id)
    const sourceAccount = legacyAccounts.find(item => item.id === row.trading_account_id)
    const targetAccountId = accountMap.get(row.trading_account_id) ?? null
    const problems = []
    if (!sourceAccount || sourceAccount.userId !== row.user_id) problems.push('legacy_account_owner_mismatch')
    if (!targetAccountId) problems.push('persisted_account_mapping_missing')
    const currentOwner = targetAccountId !== null && ownerships.some(item => item.userId === row.user_id && item.accountId === targetAccountId)
    const historicalOwnership = intervals.filter(item => item.userId === row.user_id && item.accountId === targetAccountId && item.ended_at_utc !== null)
    if (!currentOwner && historicalOwnership.length === 0) problems.push('historical_ownership_evidence_missing')
    const symbols = convertSubscriptionSymbols(row.symbols_json, strategy?.symbols_json)
    const schedule = convertSubscriptionSchedule(row)
    return { sourceId: row.id, sourceHash: hash(row), strategySourceId: row.strategy_id,
      legacyAccountId: row.trading_account_id, targetAccountId, currentOwner,
      ownershipDisposition: currentOwner ? 'current_owner' : historicalOwnership.length ? 'historical_only' : 'unresolved',
      historicalOwnershipEvidenceHash: hash(historicalOwnership.map(item => ({ ...item }))), problems,
      symbols, schedule, executionPreferences: convertSubscriptionExecutionPreferences(row),
      configReview: reviewSubscriptionConfig(row, strategy, { riskProfiles, strategies }), legacyExecutionEnabled: row.execution_enabled === '1',
      legacyDeleted: row.is_deleted === '1', runtimePermissionGranted: false }
  })
  const [history] = await connection.query('SELECT id,checksum_sha256 checksum,status FROM database_upgrade_steps_v4 ORDER BY id')
  report.historyCount = history.length
  report.schemaPreflight = await inspectStrategyBackfillSchema(connection, await loadStrategyBackfillSchema(new URL('../', import.meta.url)), 'dev_vue')
  report.historyHash = hash(history.map(row => ({ ...row })))
  report.accountMappingHash = hash([...accountMap].sort(([a], [b]) => a.localeCompare(b)))
  report.riskProfileInputsHash = hash(riskProfiles)
  report.inputHash = hash({ strategies, subscriptions, riskProfiles, users: users.map(row => ({ ...row })),
    legacyAccounts: legacyAccounts.map(row => ({ ...row })), accounts: accounts.map(row => ({ ...row })),
    ownerships: ownerships.map(row => ({ ...row })), intervals: intervals.map(row => ({ ...row })), accountMappingHash: report.accountMappingHash })
  report.counts = { strategies: strategies.length, subscriptions: subscriptions.length,
    legacyAccounts: legacyAccounts.length, accounts: accounts.length, persistedAccountMappings: accountMap.size,
    historicalSubscriptions: report.subscriptionCandidates.filter(row => row.ownershipDisposition === 'historical_only').length,
    unresolvedSubscriptions: report.subscriptionCandidates.filter(row => row.problems.length > 0).length }
  await connection.rollback()
  report.inspected = true
} catch (error) {
  report.errorCode = error?.code ?? error?.name ?? 'source_inventory_failed'
  process.exitCode = 1
} finally {
  if (connection) await connection.end()
  report.observedAt = new Date().toISOString()
  await output.writeFile(JSON.stringify(report, null, 2) + '\n')
  await output.close()
  console.log(JSON.stringify({ inspected: report.inspected, counts: report.counts,
    historyCount: report.historyCount, errorCode: report.errorCode, businessWritesPerformed: false }))
}
