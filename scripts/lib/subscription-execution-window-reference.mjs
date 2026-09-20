import assert from 'node:assert/strict'
import { createSubscriptionExecutionWindowReader, createAnalysisSubscriberReader, createAnalysisWindowReader } from '../../server/dist-v4/modules/strategies/composition.js'
import { createAccountInventorySummaryReader } from '../../server/dist-v4/modules/trading/composition.js'
import { createAccountRiskSummaryReader } from '../../server/dist-v4/modules/risk/composition.js'

export async function verifySubscriptionExecutionWindow(connection) {
  const [[identity]] = await connection.query('SELECT DATABASE() db')
  assert.match(identity.db, /^dev_vue_subscription_ref_[a-f0-9]{32}$/)
  // Ownership is a bounded fixture, not a full ownership-schema acceptance test.
  await connection.query(`CREATE TEMPORARY TABLE trading_account_ownerships (
    trading_account_id BIGINT UNSIGNED, user_id INT, role VARCHAR(16), revoked_at_utc DATETIME(3)) ENGINE=InnoDB`)
  try {
    await connection.beginTransaction()
    await connection.query(`INSERT INTO trading_account_ownerships VALUES (5,7,'owner',NULL)`)
    const risks = createAccountRiskSummaryReader(connection)
    assert.equal(await risks.read(7, '5'), null)
    assert.equal(await risks.readRevision(7, '5'), null)
    await connection.query(`INSERT INTO account_risk_summaries VALUES (5,'{"risk":"fixture"}',3)`)
    assert.deepEqual(await risks.read(7, '5'), { revision: 3, data: { risk: 'fixture' } })
    assert.equal(await risks.readRevision(7, '5'), 3)
    for (const [user, account] of [[8, '5'], [7, '9']]) {
      assert.equal(await risks.read(user, account), null)
      assert.equal(await risks.readRevision(user, account), null)
    }
    await connection.query('UPDATE account_risk_summaries SET revision=4 WHERE trading_account_id=5')
    assert.equal(await risks.readRevision(7, '5'), 4)
    await connection.query(`UPDATE strategy_subscriptions SET status='active',analysis_enabled=1,trader_enabled=1,
      trader_strategy_id=2,trader_strategy_version_id=22 WHERE id=90001`)
    const reader = createSubscriptionExecutionWindowReader(connection)
    const scope = { subscriptionId: '90001', userId: 7, accountId: '5', subscriptionRevision: 1,
      traderStrategyId: '2', traderStrategyVersionId: '22' }
    const value = await reader.read(scope)
    assert.equal(value.userId, 7); assert.equal(value.accountId, '5')
    assert.equal(value.timezone, 'terminal_server'); assert.equal(value.window.enabled, false)
    const subscribers = createAnalysisSubscriberReader(connection)
    const subscriberScope = { userId: 7, analysisStrategyVersionId: '11', symbol: 'XAUUSD' }
    const evaluationScope = { ...scope, analysisStrategyVersionId: '11', symbol: 'XAUUSD' }
    const analysisWindows = createAnalysisWindowReader(connection)
    const analysisWindowScope = { userId: 7, accountId: '5', strategyId: '1', strategyVersionId: '11', symbol: 'XAUUSD' }
    assert.equal((await analysisWindows.list(analysisWindowScope)).length, 1)
    for (const patch of [{ userId: 8 }, { accountId: '9' }, { strategyId: '2' }, { strategyVersionId: '22' }, { symbol: 'EURUSD' }]) {
      assert.deepEqual(await analysisWindows.list({ ...analysisWindowScope, ...patch }), [])
    }
    assert.equal((await subscribers.readForEvaluation(evaluationScope)).id, '90001')
    assert.deepEqual(await subscribers.readContextVersion(evaluationScope), { revision: 1, status: 'active' })
    for (const patch of [{ userId: 8 }, { accountId: '9' }, { subscriptionId: '90002' }, { subscriptionRevision: 2 },
      { traderStrategyId: '1' }, { traderStrategyVersionId: '11' }, { analysisStrategyVersionId: '22' }, { symbol: 'EURUSD' }]) {
      assert.equal(await subscribers.readForEvaluation({ ...evaluationScope, ...patch }), null)
      if (!('subscriptionRevision' in patch)) assert.equal(await subscribers.readContextVersion({ ...evaluationScope, ...patch }), null)
    }
    await connection.query('SAVEPOINT context_version_change')
    await connection.query("UPDATE strategy_subscriptions SET revision=2,status='paused' WHERE id=90001")
    assert.deepEqual(await subscribers.readContextVersion(evaluationScope), { revision: 2, status: 'paused' })
    await connection.query('ROLLBACK TO SAVEPOINT context_version_change')
    assert.deepEqual((await subscribers.list(subscriberScope)).map(row => [row.id, row.accountId, row.traderStrategyId]), [['90001', '5', '2']])
    for (const patch of [{ userId: 8 }, { analysisStrategyVersionId: '22' }, { symbol: 'EURUSD' }]) {
      assert.deepEqual(await subscribers.list({ ...subscriberScope, ...patch }), [])
    }
    const inventory = createAccountInventorySummaryReader(connection), inventoryScope = { userId: 7, accountId: '5', symbol: 'XAUUSD' }
    await inventory.lockAccount('5')
    assert.deepEqual(await inventory.readRevisions(inventoryScope), { accountRevision: null, quoteRevision: null, contractRevision: null,
      positionsRevision: null, pendingOrdersRevision: null })
    await connection.query('INSERT INTO account_runtime_snapshots VALUES (5,10),(9,99)')
    await connection.query("INSERT INTO market_quotes VALUES (5,'XAUUSD',20),(5,'EURUSD',21),(9,'XAUUSD',99)")
    await connection.query("INSERT INTO market_instrument_snapshots VALUES (5,'XAUUSD',30),(9,'XAUUSD',99)")
    assert.deepEqual(await inventory.readRevisions(inventoryScope), { accountRevision: 10, quoteRevision: 20, contractRevision: 30,
      positionsRevision: null, pendingOrdersRevision: null })
    assert.deepEqual(await inventory.read(inventoryScope), { positionsRevision: 0, pendingOrdersRevision: 0, hasPositions: false, hasPendingOrders: false })
    await connection.query("INSERT INTO trading_projection_revisions VALUES (5,'positions','open',3),(5,'pending_orders','open',4)")
    assert.deepEqual(await inventory.readRevisions(inventoryScope), { accountRevision: 10, quoteRevision: 20, contractRevision: 30,
      positionsRevision: 3, pendingOrdersRevision: 4 })
    assert.deepEqual(await inventory.readRevisions({ ...inventoryScope, symbol: 'EURUSD' }), { accountRevision: 10, quoteRevision: 21,
      contractRevision: null, positionsRevision: 3, pendingOrdersRevision: 4 })
    assert.equal(await inventory.readRevisions({ ...inventoryScope, userId: 8 }), null)
    assert.equal(await inventory.readRevisions({ ...inventoryScope, accountId: '9' }), null)
    await connection.query(`INSERT INTO open_position_snapshots VALUES (5,'{"symbol":"XAUUSD"}'),(9,'{"symbol":"EURUSD"}')`)
    await connection.query(`INSERT INTO pending_order_snapshots VALUES (5,'{"symbol":"EURUSD"}')`)
    assert.deepEqual(await inventory.read(inventoryScope), { positionsRevision: 3, pendingOrdersRevision: 4, hasPositions: true, hasPendingOrders: false })
    assert.deepEqual(await inventory.read({ ...inventoryScope, symbol: 'EURUSD' }), { positionsRevision: 3, pendingOrdersRevision: 4, hasPositions: false, hasPendingOrders: true })
    assert.equal(await inventory.read({ ...inventoryScope, userId: 8 }), null)
    assert.equal(await inventory.read({ ...inventoryScope, accountId: '9' }), null)
    await connection.query('SAVEPOINT analysis_disabled')
    await connection.query('UPDATE strategy_subscriptions SET analysis_enabled=0 WHERE id=90001')
    assert.deepEqual(await analysisWindows.list(analysisWindowScope), [])
    assert.deepEqual(await subscribers.list(subscriberScope), [])
    assert.equal((await subscribers.readForEvaluation(evaluationScope)).id, '90001')
    await connection.query('ROLLBACK TO SAVEPOINT analysis_disabled')
    for (const patch of [{ userId: 8 }, { accountId: '9' }, { subscriptionId: '90002' },
      { subscriptionRevision: 2 }, { traderStrategyId: '1' }, { traderStrategyVersionId: '11' }]) {
      assert.equal(await reader.read({ ...scope, ...patch }), null)
    }
    for (const sql of [
      "UPDATE strategy_subscriptions SET status='paused' WHERE id=90001",
      'UPDATE strategy_subscriptions SET trader_enabled=0 WHERE id=90001',
      'UPDATE trading_account_ownerships SET revoked_at_utc=UTC_TIMESTAMP(3)',
      "UPDATE trading_account_ownerships SET role='viewer'",
      'DELETE FROM subscription_schedules WHERE subscription_id=90001',
    ]) {
      await connection.query('SAVEPOINT window_negative')
      await connection.query(sql)
      assert.equal(await reader.read(scope), null)
      assert.deepEqual(await subscribers.list(subscriberScope), [])
      if (!sql.includes('trader_enabled=0')) assert.deepEqual(await analysisWindows.list(analysisWindowScope), [])
      else assert.equal((await analysisWindows.list(analysisWindowScope)).length, 1)
      if (!sql.includes('subscription_schedules')) assert.equal(await subscribers.readForEvaluation(evaluationScope), null)
      if (sql.includes('trading_account_ownerships')) assert.equal(await inventory.read(inventoryScope), null)
      if (sql.includes('trading_account_ownerships')) assert.equal(await inventory.readRevisions(inventoryScope), null)
      if (sql.includes('trading_account_ownerships')) {
        assert.equal(await risks.read(7, '5'), null)
        assert.equal(await risks.readRevision(7, '5'), null)
      }
      await connection.query('ROLLBACK TO SAVEPOINT window_negative')
    }
    return { passed: true, ownershipSchema: 'temporary_fixture', inventorySchema: 'isolated_reference_fixture', checks: [
      'actual-reader-returns-promoted-subscription-window',
      'user-account-subscription-revision-and-strategy-scope-denied',
      'paused-disabled-revoked-nonowner-and-missing-schedule-denied',
      'analysis-subscriber-scope-and-enabled-flags',
      'inventory-owner-account-exact-symbol-and-projection-revisions',
      'manual-evaluation-binds-analysis-version-symbol-and-active-owner-without-requiring-auto-analysis',
      'risk-summary-and-revision-scope-owner-revocation-and-revision-change',
      'context-subscription-version-status-and-trading-account-symbol-revisions-with-explicit-null-projections',
      'analysis-window-scope-owner-and-analysis-enable-independent-of-trader-enable',
    ] }
  } finally {
    await connection.rollback()
    await connection.query('DROP TEMPORARY TABLE trading_account_ownerships')
  }
}
