import type { Pool, PoolConnection } from 'mysql2/promise'
import { executionPreferencesMatch, StrategyAccessError, type SubscriptionPreferencesReader } from '../../strategies/index.js'
import { InferenceError, type TraderRun } from '../domain/inference.js'

export async function assertTraderPreferencesCurrent(connection: PoolConnection, run: TraderRun, frozen: unknown,
  preferences: (connection: PoolConnection) => SubscriptionPreferencesReader) {
  let current
  try { current = await preferences(connection).read({ subscriptionId: run.subscriptionId, userId: run.userId, accountId: run.tradingAccountId }) }
  catch (error) {
    if (error instanceof StrategyAccessError) throw new InferenceError('trader_preferences_changed', 409)
    throw error
  }
  if (!executionPreferencesMatch(frozen, current)) throw new InferenceError('trader_preferences_changed', 409)
}

export class MysqlTraderPreferencesReader {
  constructor(private readonly pool: Pool, private readonly preferences: (connection: PoolConnection) => SubscriptionPreferencesReader) {}
  async read(run: TraderRun) {
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      const value = await this.preferences(connection).read({ subscriptionId: run.subscriptionId, userId: run.userId, accountId: run.tradingAccountId })
      if (!value) throw new InferenceError('trader_preferences_unavailable', 409)
      await connection.commit()
      return value
    } catch (error) { await connection.rollback(); throw error }
    finally { connection.release() }
  }
}
