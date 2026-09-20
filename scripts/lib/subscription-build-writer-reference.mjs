import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { splitSqlStatements } from './v4-migration-plan.mjs'
import { createSubscriptionBuildWriter } from './mysql-subscription-build-writer.mjs'

export function subscriptionBuildFixture(analysisId, versionId, overrides = {}) {
  const now = '2026-09-09 00:00:00.123'
  return { subscription: { id: '90001', user_id: '7', trading_account_id: '5', standard_symbol: 'XAUUSD',
    analysis_strategy_id: String(analysisId), analysis_strategy_version_id: String(versionId),
    trader_strategy_id: null, trader_strategy_version_id: null, analysis_enabled: 0, trader_enabled: 0, trade_send_enabled: 0,
    status: 'paused', revision: '1', legacy_source_table: 'strategy_subscriptions', legacy_id: '21:XAUUSD',
    created_at_utc: now, updated_at_utc: now, ...overrides },
  schedule: { subscription_id: overrides.id ?? '90001', cadence_seconds: 300, receive_timezone: 'terminal_server',
    receive_window_json: { version: 1, timezone: 'terminal_server', enabled: false, weekdays: [1, 2, 3, 4, 5],
      windows: [{ start: '00:00', end: '23:59' }], outsideBehavior: 'pause_all' }, next_due_at_utc: null, revision: '1', updated_at_utc: now },
  preferences: { subscription_id: overrides.id ?? '90001', contract_version: 1, take_profit_mode: 'standard', revision: '1',
    created_at_utc: now, updated_at_utc: now } }
}

export async function verifySubscriptionBuildWriterReference(connection, analysisId, versionId) {
  const [[scope]] = await connection.query('SELECT DATABASE() db')
  assert.match(scope.db, /^dev_vue_strategy_ref_[0-9a-f]{32}$/)
  const ddl = await readFile(new URL('../../server/db/migrations/inplace/007_subscription_build_tables.sql', import.meta.url), 'utf8')
  // Original 007 account namespace fixture; it does not claim the promoted dev_vue account schema.
  await connection.query('CREATE TABLE trading_accounts_v4_build (id BIGINT UNSIGNED PRIMARY KEY) ENGINE=InnoDB')
  await connection.query('INSERT INTO trading_accounts_v4_build VALUES (5)')
  for (const sql of splitSqlStatements(ddl)) await connection.query(sql)
  const projection = subscriptionBuildFixture(analysisId, versionId)
  const writer = createSubscriptionBuildWriter([projection]), checks = []
  const counts = async () => {
    const result = []
    for (const table of ['strategy_subscriptions_v4_build', 'subscription_schedules_v4_build', 'subscription_execution_preferences_v4_build']) {
      const [[row]] = await connection.query(`SELECT COUNT(*) n FROM ${table}`); result.push(Number(row.n))
    }
    return result
  }
  await connection.beginTransaction()
  const failing = { async execute(sql, args) {
    if (sql.startsWith('INSERT INTO subscription_execution_preferences_v4_build')) throw Error('injected_preferences_failure')
    return connection.execute(sql, args)
  } }
  await assert.rejects(writer.write(failing, projection), /injected_preferences_failure/)
  await connection.rollback()
  assert.deepEqual(await counts(), [0, 0, 0]); checks.push('three-target-rollback-on-child-failure')
  await connection.beginTransaction()
  await assert.rejects(writer.write(connection, projection, { verifyOnly: true }), { code: 'subscription_build_writer_not_committed' })
  await connection.rollback(); checks.push('verify-only-missing-rejected')
  await connection.beginTransaction()
  assert.equal((await writer.write(connection, projection)).inserted, 3)
  // Successful commit followed by a lost caller acknowledgement is recovered by exact readback.
  await connection.commit()
  await connection.beginTransaction()
  assert.equal((await writer.write(connection, projection, { verifyOnly: true })).inserted, 0)
  assert.equal((await writer.write(connection, projection)).inserted, 0)
  await connection.commit()
  assert.deepEqual(await counts(), [1, 1, 1]); checks.push('committed-projection-replay-no-duplicates')
  await connection.beginTransaction()
  await connection.execute('UPDATE subscription_execution_preferences_v4_build SET take_profit_mode=? WHERE subscription_id=?', ['trend', '90001'])
  await assert.rejects(writer.write(connection, projection), { code: 'subscription_build_writer_target_conflict' })
  const [[changed]] = await connection.query('SELECT take_profit_mode mode FROM subscription_execution_preferences_v4_build WHERE subscription_id=90001')
  assert.equal(changed.mode, 'trend')
  await connection.rollback(); checks.push('conflicting-child-preserved')
  await connection.beginTransaction()
  await connection.query('DELETE FROM subscription_execution_preferences_v4_build WHERE subscription_id=90001')
  await assert.rejects(writer.write(connection, projection), { code: 'subscription_build_writer_partial_projection' })
  assert.deepEqual(await counts(), [1, 1, 0])
  await connection.rollback(); checks.push('partial-projection-not-silently-repaired')
  for (const overrides of [{ id: '90002', legacy_id: '22:XAUUSD' }, { id: '90002', standard_symbol: 'EURUSD' }]) {
    const collision = subscriptionBuildFixture(analysisId, versionId, overrides)
    await connection.beginTransaction()
    await assert.rejects(createSubscriptionBuildWriter([collision]).write(connection, collision), { code: 'subscription_build_writer_target_conflict' })
    await connection.rollback()
  }
  checks.push('natural-and-legacy-key-collisions-preserved')
  const badVersion = subscriptionBuildFixture(analysisId, '18446744073709551615', { id: '90003', standard_symbol: 'EURUSD', legacy_id: '23:EURUSD' })
  await connection.beginTransaction()
  await assert.rejects(createSubscriptionBuildWriter([badVersion]).write(connection, badVersion), { code: 'ER_NO_REFERENCED_ROW_2' })
  await connection.rollback()
  assert.deepEqual(await counts(), [1, 1, 1]); checks.push('real-composite-version-foreign-key')
  return { passed: true, checks, migrationSha256: createHash('sha256').update(ddl).digest('hex'),
    fixture: 'Original 007 build tables with a scaffold trading_accounts_v4_build parent; caller drops entire reference database.',
    historicalBackfillProven: false, runtimeEnabled: false }
}
