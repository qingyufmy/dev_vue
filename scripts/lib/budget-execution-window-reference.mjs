import assert from 'node:assert/strict'
import { assertRiskDecisionWindow } from '../../server/dist-v4/modules/execution/infrastructure/mysql-execution-window.js'
import { createStrategyExecutionConfigReader } from '../../server/dist-v4/modules/strategies/composition.js'
import { subscriptionWindowFingerprint } from '../../server/dist-v4/modules/strategies/index.js'
import { contentHash } from '../../server/dist-v4/modules/inference/index.js'
import { initializeSubscriptionExecutionPreferences, readSubscriptionExecutionPreferences } from '../../server/dist-v4/modules/strategies/infrastructure/mysql-subscription-execution-preferences.js'

export async function verifyBudgetExecutionWindow(db, originalSnapshot) {
  const [[identity]] = await db.query('SELECT DATABASE() db')
  assert.match(identity.db, /^dev_vue_budget_ref_[a-f0-9]{32}$/)
  const tables = ['trading_accounts', 'subscription_schedules', 'subscription_execution_preferences', 'risk_decisions_v4']
  for (const table of tables) {
    const [[definition]] = await db.query('SHOW CREATE TABLE dev_vue.' + table)
    const ddl = definition['Create Table']
      .split('\n').filter(line => !line.includes('FOREIGN KEY')).join('\n').replace(/,\n\)/g, '\n)')
    await db.query(ddl)
  }
  const now = '2026-09-11 00:00:00.000', window = { enabled: false }
  const snapshot = { ...originalSnapshot, subscriptionWindowHash: subscriptionWindowFingerprint(window, 'UTC'),
    executionPreferences: { contractVersion: 1, takeProfitMode: 'ai_recommended', revision: '1' } }
  const storeSnapshot = async value => {
    await db.execute('UPDATE inference_snapshots SET payload_sha256=?,payload_bytes=? WHERE id=?', [contentHash(value), Buffer.byteLength(JSON.stringify(value)), 'snapshot'])
    await db.execute('UPDATE inference_snapshot_payloads SET payload_json=? WHERE snapshot_id=?', [JSON.stringify(value), 'snapshot'])
  }
  const reader = createStrategyExecutionConfigReader(db)
  const check = () => assertRiskDecisionWindow({ read: async () => { throw Error('unexpected clock lookup') } }, db, 'risk', 7, '5', new Date(), reader)
  await db.beginTransaction()
  try {
    await db.execute('INSERT INTO trading_accounts (id,platform,broker_server,account_login,currency,created_at_utc,updated_at_utc) VALUES (5,?,?,?,?,?,?)', ['mt5', 'Synthetic Broker', '001', 'USD', now, now])
    await db.execute('INSERT INTO subscription_schedules (subscription_id,receive_timezone,receive_window_json,updated_at_utc) VALUES (8,?,?,?)', ['UTC', JSON.stringify(window), now])
    await initializeSubscriptionExecutionPreferences(db, '8')
    assert.deepEqual(await readSubscriptionExecutionPreferences(db, { subscriptionId: '8', userId: 7, accountId: '5' }),
      { contractVersion: 1, takeProfitMode: 'ai_recommended', revision: '1' })
    await assert.rejects(() => initializeSubscriptionExecutionPreferences(db, '8'), error => error.code === 'ER_DUP_ENTRY')
    await db.execute('INSERT INTO risk_decisions_v4 (id,trade_decision_id,user_id,trading_account_id,platform_policy_version_id,policy_set_revision,account_risk_revision,decision_status,policy_sha256,created_at_utc) VALUES (?,?,7,5,1,1,1,?,?,?)', ['risk', 'decision', 'approved', 'a'.repeat(64), now])
    await db.execute("UPDATE trade_decisions SET status='accepted',risk_decision_id='risk' WHERE id='decision'")
    await storeSnapshot(snapshot)
    await check()
    await db.query('SAVEPOINT budget_window_valid')
    await db.execute('UPDATE strategy_versions SET config_json=? WHERE id=21', [JSON.stringify({ risk_budget: { version: 1, max_risk_per_trade_percent: '2' } })])
    await assert.rejects(check, error => error.code === 'execution_strategy_config_changed')
    await db.query('ROLLBACK TO SAVEPOINT budget_window_valid')
    await check()
    const { strategyConfigHash: _hash, ...historical } = snapshot
    await storeSnapshot(historical)
    await assert.rejects(check, error => error.code === 'execution_strategy_config_unproven')
    await db.query('ROLLBACK TO SAVEPOINT budget_window_valid')
    await db.query('UPDATE strategies SET active_version_id=22 WHERE id=20')
    await assert.rejects(check, error => error.code === 'execution_subscription_changed')
    return { passed: true, tablesCopiedWithoutForeignKeys: tables, preferencesSource: 'subscription_execution_preferences',
      checks: ['canonical-preferences-initialize-read-and-duplicate-rejection', 'accepted-decision-current-config', 'same-version-config-change-rejected', 'missing-frozen-config-rejected', 'active-version-change-rejected'] }
  } finally { await db.rollback() }
}
