import type { MarketStrategyAccess } from './market-source-access.js'
import type { MarketSourceStore } from './market-source-ports.js'
import { parseBridgeMarketState, type MarketPool } from '../domain/market-source.js'

export interface AutomaticMarketSessionInput {
  userId: number
  strategyId: string
  strategyVersionId: string
  symbol: string
}

export interface AutomaticMarketSessionDecision {
  allowed: boolean
  reason: string
}

/** Automatic model work is allowed only against a fresh, authoritative open-session state. */
export class AutomaticMarketSessionGate {
  constructor(
    private readonly strategies: MarketStrategyAccess,
    private readonly sources: MarketSourceStore,
    private readonly maxAgeMs = 30_000,
    private readonly currentTime: () => number = Date.now,
  ) {}

  async check(input: AutomaticMarketSessionInput): Promise<AutomaticMarketSessionDecision> {
    const strategy = await this.strategies.read(input.userId, input.strategyId, input.strategyVersionId)
    if (!strategy || strategy.scope === 'user' && strategy.ownerUserId !== input.userId) throw new Error('market_source_access_denied')
    const pool: MarketPool = strategy.scope === 'platform' ? { kind: 'public' } : { kind: 'private', userId: input.userId }
    const source = await this.sources.read({ pool, symbol: input.symbol })
    const market = parseBridgeMarketState(source?.marketState)
    if (!source?.source || !market) return { allowed: false, reason: 'market_session_unverified' }
    if (Math.abs(this.currentTime() - market.checked_at_utc_msc) > this.maxAgeMs) {
      return { allowed: false, reason: 'market_session_stale' }
    }
    return market.state === 'open'
      ? { allowed: true, reason: market.reason }
      : { allowed: false, reason: `market_session_${market.state}` }
  }
}
