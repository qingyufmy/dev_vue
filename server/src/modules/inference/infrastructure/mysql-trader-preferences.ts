import type { Pool, PoolConnection } from 'mysql2/promise'
import { executionPreferencesMatch, readSubscriptionExecutionPreferences, StrategyAccessError } from '../../strategies/index.js'
import { InferenceError, type TraderRun } from '../domain/inference.js'

export async function assertTraderPreferencesCurrent(connection: PoolConnection, run: TraderRun, frozen: unknown) {
  let current
  try { current = await readSubscriptionExecutionPreferences(connection, { subscriptionId: run.subscriptionId, userId: run.userId, accountId: run.tradingAccountId }) }
  catch (error) {
    if (error instanceof StrategyAccessError) throw new InferenceError('trader_preferences_changed', 409)
    throw error
  }
  if (!executionPreferencesMatch(frozen, current)) throw new InferenceError('trader_preferences_changed', 409)
}

export class MysqlTraderPreferencesReader {
  constructor(private readonly pool: Pool) {}
  async read(run: TraderRun) {
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      const value = await readSubscriptionExecutionPreferences(connection, { subscriptionId: run.subscriptionId, userId: run.userId, accountId: run.tradingAccountId })
      if (!value) throw new InferenceError('trader_preferences_unavailable', 409)
      await connection.commit()
      return value
    } catch (error) { await connection.rollback(); throw error }
    finally { connection.release() }
  }
}
