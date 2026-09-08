import type { AccountClockReader } from '../../trading/index.js'
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise'
import type { TraderWindowGuard } from '../application/trader-window-guard.js'
import { InferenceError, type TraderRun } from '../domain/inference.js'
import { traderWindowAllows } from './mysql-trader-window.js'
import { subscriptionWindowFingerprint } from '../../strategies/index.js'

interface WindowRow extends RowDataPacket {
  user_id: number; trading_account_id: string; receive_timezone: string; receive_window_json: unknown
}

export class MysqlTraderWindowGuard implements TraderWindowGuard {
  constructor(private readonly pool: Pool, private readonly accountClock: (connection: PoolConnection) => AccountClockReader) {}

  async assertAllowed(run: TraderRun, now: Date) {
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      const fingerprint = await readTraderWindowFingerprint(this.accountClock(connection), connection, run, now)
      await connection.commit()
      return fingerprint
    } catch (error) { await connection.rollback(); throw error }
    finally { connection.release() }
  }
}

export async function readTraderWindowFingerprint(clock: AccountClockReader, connection: PoolConnection, run: TraderRun, now: Date): Promise<string> {
  const [rows] = await connection.execute<WindowRow[]>(`SELECT s.user_id,CAST(s.trading_account_id AS CHAR) trading_account_id,sc.receive_timezone,sc.receive_window_json
        FROM strategy_subscriptions s INNER JOIN subscription_schedules sc ON sc.subscription_id=s.id
        INNER JOIN trading_account_ownerships own ON own.trading_account_id=s.trading_account_id AND own.user_id=s.user_id
          AND own.role='owner' AND own.revoked_at_utc IS NULL
        WHERE s.id=? AND s.user_id=? AND s.trading_account_id=? AND s.revision=? AND s.status='active'
          AND s.trader_enabled=1 AND s.trader_strategy_id=? AND s.trader_strategy_version_id=? FOR SHARE`,
  [run.subscriptionId, run.userId, run.tradingAccountId, run.subscriptionRevision, run.strategyId, run.strategyVersionId])
  if (rows.length !== 1) throw new InferenceError('subscription_revision_conflict', 409)
  if (!await traderWindowAllows(clock, rows[0]!, now)) throw new InferenceError('trader_schedule_closed', 409)
  return subscriptionWindowFingerprint(rows[0]!.receive_window_json, rows[0]!.receive_timezone)
}
