import type { Redis } from 'ioredis'
import { assertMarketSourceScope, type MarketSourceScope } from '../domain/market-source.js'
import { HISTORY_PERIODS, type HistoryDemand, type HistoryProgress } from '../application/market-history-backfill.js'
const KEY = 'aurum:v4:market:history-used:1'
/** Reconstructible cache demand, not account or trade authority. */
export class RedisMarketHistoryDemand {
  constructor(private readonly redis: Redis) {}
  async use(scope: MarketSourceScope) {
    assertMarketSourceScope(scope)
    await this.redis.sadd(KEY, JSON.stringify(scope))
  }
  async list(): Promise<HistoryDemand[]> {
    const entries = await this.redis.smembers(KEY)
    if (entries.length > 3200) throw new Error('market_history_demand_limit')
    return entries.flatMap(raw => {
      const scope = JSON.parse(raw) as MarketSourceScope
      assertMarketSourceScope(scope)
      return HISTORY_PERIODS.map(timeframe => ({ ...scope, timeframe }))
    })
  }
  async progress(demand: HistoryDemand): Promise<HistoryProgress | null> {
    const raw = await this.redis.get(this.key(demand))
    return raw ? JSON.parse(raw) as HistoryProgress : null
  }
  async save(demand: HistoryDemand, progress: HistoryProgress) {
    await this.redis.set(this.key(demand), JSON.stringify(progress), 'EX', 30 * 86400)
  }
  private key(demand: HistoryDemand) { return `aurum:v4:market:history-progress:1:${demand.pool.kind === 'public' ? 'public' : demand.pool.userId}:${demand.symbol}:${demand.timeframe}` }
}
