import type { Pool, RowDataPacket } from 'mysql2/promise'
import { validateTraderControl, type TraderControlInput } from '../application/trader-control.js'
import { StrategyAccessError } from '../domain/strategy.js'
import { executeStrategyWrite, type StrategyWriteResult } from './mysql-strategy-write-receipts.js'

export async function setAccountTrader(pool: Pool, input: TraderControlInput) {
  const outcome = await executeStrategyWrite(pool, { actorUserId: input.userId, action: 'set_account_trader',
    targetId: input.accountId, expectedRevision: null, idempotencyKey: input.idempotencyKey,
    payload: { enabled: input.enabled, expected: input.expected } }, async connection => {
    const [rows] = await connection.execute<(RowDataPacket & { id: string; revision: number; status: string; analysis_enabled: number; trader_strategy_id: string | null })[]>(
      `SELECT CAST(id AS CHAR) id,revision,status,analysis_enabled,CAST(trader_strategy_id AS CHAR) trader_strategy_id
       FROM strategy_subscriptions WHERE user_id=? AND trading_account_id=? AND status<>'ended' ORDER BY id FOR UPDATE`, [input.userId, input.accountId])
    const enabledIds = validateTraderControl(input, rows.map(row => ({ id: row.id, revision: Number(row.revision), status: row.status,
      analysisEnabled: Boolean(row.analysis_enabled), traderStrategyId: row.trader_strategy_id })))
    // Check every configured strategy before any mutation. A conflict rolls back the whole account.
    for (const row of rows.filter(row => enabledIds.has(row.id))) {
      const [available] = await connection.execute<RowDataPacket[]>(`SELECT id FROM strategies WHERE id=? AND kind='trader'
        AND status='active' AND deleted_at_utc IS NULL AND active_version_id IS NOT NULL
        AND (scope='platform' OR owner_user_id=?) FOR SHARE`, [row.trader_strategy_id, input.userId])
      if (available.length !== 1) throw new StrategyAccessError('strategy_subscription_strategy_unavailable', 409)
    }
    for (const row of rows) await connection.execute(`UPDATE strategy_subscriptions SET trader_enabled=?,trade_send_enabled=?,
      revision=revision+1,updated_at_utc=UTC_TIMESTAMP(3) WHERE id=? AND user_id=?`, [enabledIds.has(row.id) ? 1 : 0, enabledIds.has(row.id) ? 1 : 0, row.id, input.userId])
    return { resourceId: input.accountId, revision: Math.max(0, ...rows.map(row => Number(row.revision))) + 1, value: { enabled: input.enabled } }
  }, (value): value is StrategyWriteResult<{ enabled: boolean }> => {
    const result = value as StrategyWriteResult<{ enabled: boolean }> | null
    return !!result && result.resourceId === input.accountId && result.value?.enabled === input.enabled && Number.isSafeInteger(result.revision)
  }, async connection => {
    const [owned] = await connection.execute<RowDataPacket[]>(`SELECT a.id FROM trading_accounts a INNER JOIN trading_account_ownerships o
      ON o.trading_account_id=a.id AND o.user_id=? AND o.role='owner' AND o.revoked_at_utc IS NULL
      WHERE a.id=? AND a.deleted_at_utc IS NULL FOR UPDATE`, [input.userId, input.accountId])
    if (owned.length !== 1) throw new StrategyAccessError('strategy_account_forbidden', 403)
  })
  return outcome.value
}
