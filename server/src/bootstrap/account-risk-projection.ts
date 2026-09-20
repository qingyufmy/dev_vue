import type { Pool, RowDataPacket } from 'mysql2/promise'
import { createMysqlRiskHistoryReader, accountHistoryMetrics, riskAmount, riskAmountText } from '../modules/trade-history/composition.js'
import { createMysqlRiskAccountReader } from '../modules/trading/composition.js'
import { createMysqlAccountRiskProjector, createTransactionRiskPolicyReader } from '../modules/risk/composition.js'

export function createAccountRiskProjection(pool: Pool) {
  const projector = createMysqlAccountRiskProjector(pool, async (connection, scope) => {
    const history = await createMysqlRiskHistoryReader(connection).read(scope)
    if (!history) return null
    const account = await createMysqlRiskAccountReader(connection).read(history.route)
    if (!account || account.now - history.through > 120000 || history.through > account.now) return null
    const observedAt = new Date(account.now).toISOString(), offset = account.timezoneOffsetMinutes!
    const businessDate = new Date(account.now + offset * 60000).toISOString().slice(0, 10)
    const dayStart = Date.parse(`${businessDate}T00:00:00.000Z`) - offset * 60000
    const policy = await createTransactionRiskPolicyReader(connection).getEffectivePolicy(scope.userId, scope.accountId)
    const metrics = accountHistoryMetrics({ facts: history.facts, balance: account.balance, dayStart, observed: account.now,
      positions: account.positions, lossLimit: policy.values.consecutiveLossLimit, cooldownMinutes: policy.values.lossCooldownMinutes })
    const [baselines] = await connection.execute<RowDataPacket[]>('SELECT revision FROM account_daily_risk_baselines WHERE trading_account_id=? AND ownership_interval_id=? AND business_date=? FOR UPDATE',
      [scope.accountId, account.ownershipIntervalId, businessDate])
    const [summaries] = await connection.execute<RowDataPacket[]>('SELECT revision FROM account_risk_states WHERE trading_account_id=? FOR UPDATE', [scope.accountId])
    const expectedSummaryRevision = summaries.length ? Number(summaries[0]!.revision) : null
    return { expectedBaselineRevision: baselines.length ? Number(baselines[0]!.revision) : null, expectedSummaryRevision,
      facts: { accountId: scope.accountId, ownershipIntervalId: account.ownershipIntervalId, businessDate, observedAt, historyComplete: true,
        equity: account.equity, floatingPnl: account.floatingPnl, realizedNet: metrics.realizedNet, netCapitalFlow: metrics.netCapitalFlow },
      summary: { accountId: scope.accountId, userId: scope.userId, businessDate, observedAt, equity: account.equity, freeMargin: account.freeMargin,
        margin: account.margin, openPositions: account.positions.length, pendingOrders: account.pendingOrders.length,
        totalVolume: riskAmountText([...account.positions, ...account.pendingOrders].reduce((sum, item) => sum + riskAmount(item.volume), 0n)),
        dailyOpenCount: metrics.dailyOpenCount, consecutiveLosses: metrics.consecutiveLosses, lastSuccessfulOpenAt: metrics.lastSuccessfulOpenAt,
        cooldownUntil: metrics.cooldownUntil, terminalTimezoneOffsetMinutes: offset, clockStatus: 'calibrated', dataComplete: true,
        revision: (expectedSummaryRevision ?? 0) + 1 } }
  })
  return { async tick() {
    const [scopes] = await pool.execute<RowDataPacket[]>(`SELECT CAST(a.id AS CHAR) account_id,o.user_id FROM trading_accounts a
      JOIN trading_account_ownerships o ON o.trading_account_id=a.id AND o.revision=a.ownership_revision AND o.role='owner' AND o.revoked_at_utc IS NULL
      WHERE a.deleted_at_utc IS NULL AND EXISTS (SELECT 1 FROM bridge_connection_sessions s WHERE s.trading_account_id=a.id
        AND s.disconnected_at_utc IS NULL AND s.last_seen_at_utc>=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 30 SECOND)) ORDER BY a.id LIMIT 100`)
    const results = []
    for (const scope of scopes) {
      try { const summary = await projector.project({ userId: Number(scope.user_id), accountId: String(scope.account_id) }); results.push({ accountId: String(scope.account_id), status: 'projected', revision: summary.revision }) }
      catch (error) { results.push({ accountId: String(scope.account_id), status: 'unavailable', reason: error instanceof Error && /^[a-z0-9_]+$/.test(error.message) ? error.message : 'risk_projection_failed' }) }
    }
    return results
  } }
}
