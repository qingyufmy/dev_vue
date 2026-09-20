import type { AccountClockReader } from '../../trading/index.js'
import type { Pool, PoolConnection } from 'mysql2/promise'
import type { TraderWindowGuard } from '../application/trader-window-guard.js'
import { InferenceError, type TraderRun } from '../domain/inference.js'
import { traderWindowAllows } from './mysql-trader-window.js'
import { subscriptionWindowFingerprint, type SubscriptionExecutionWindowReader } from '../../strategies/index.js'

export class MysqlTraderWindowGuard implements TraderWindowGuard {
  constructor(private readonly pool: Pool, private readonly accountClock: (connection: PoolConnection) => AccountClockReader,
    private readonly windows: (connection: PoolConnection) => SubscriptionExecutionWindowReader) {}

  async assertAllowed(run: TraderRun, now: Date) {
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      const fingerprint = await readTraderWindowFingerprint(this.accountClock(connection), this.windows(connection), run, now)
      await connection.commit()
      return fingerprint
    } catch (error) { await connection.rollback(); throw error }
    finally { connection.release() }
  }
}

export async function readTraderWindowFingerprint(clock: AccountClockReader, windows: SubscriptionExecutionWindowReader, run: TraderRun, now: Date): Promise<string> {
  const window = await windows.read({ subscriptionId: run.subscriptionId, userId: run.userId, accountId: run.tradingAccountId,
    subscriptionRevision: run.subscriptionRevision, traderStrategyId: run.strategyId, traderStrategyVersionId: run.strategyVersionId })
  if (!window) throw new InferenceError('subscription_revision_conflict', 409)
  if (!await traderWindowAllows(clock, { user_id: window.userId, trading_account_id: window.accountId,
    receive_timezone: window.timezone, receive_window_json: window.window }, now)) throw new InferenceError('trader_schedule_closed', 409)
  return subscriptionWindowFingerprint(window.window, window.timezone)
}
