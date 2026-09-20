import type { MarketPool, MarketSourceState } from '../domain/market-source.js'
import type { MarketSourceSelector } from './market-source-selector.js'

export interface MarketStrategyAccess {
  /** Must recheck the actor and active strategy version. Never derived from client-supplied visibility. */
  read(userId: number, strategyId: string, versionId: string): Promise<{ scope: 'platform' | 'user'; ownerUserId: number | null } | null>
}
export interface SelectedMarketSource {
  pool: MarketPool
  standardSymbol: string
  state: MarketSourceState
}
export class StrategyMarketSourceAccess {
  constructor(private readonly strategies: MarketStrategyAccess, private readonly selector: MarketSourceSelector,
    private readonly demand?: { use(scope: import('../domain/market-source.js').MarketSourceScope): Promise<void> }) {}
  async select(input: { userId: number; strategyId: string; versionId: string; symbol: string }): Promise<SelectedMarketSource> {
    if (!Number.isSafeInteger(input.userId) || input.userId < 1) throw new Error('market_source_access_denied')
    const strategy = await this.strategies.read(input.userId, input.strategyId, input.versionId)
    if (!strategy || strategy.scope === 'user' && strategy.ownerUserId !== input.userId) throw new Error('market_source_access_denied')
    const pool: MarketPool = strategy.scope === 'platform' ? { kind: 'public' } : { kind: 'private', userId: input.userId }
    await this.demand?.use({ pool, symbol: input.symbol })
    const state = await this.selector.select({ pool, symbol: input.symbol })
    if (!state.source || state.failures) throw new Error('market_source_unavailable')
    return { pool, standardSymbol: input.symbol, state }
  }
  async assertCurrent(input: { userId: number; strategyId: string; versionId: string }, captured: SelectedMarketSource) {
    const strategy = await this.strategies.read(input.userId, input.strategyId, input.versionId)
    const allowed = captured.pool.kind === 'public' ? strategy?.scope === 'platform'
      : strategy?.scope === 'user' && strategy.ownerUserId === input.userId && captured.pool.userId === input.userId
    if (!allowed || !await this.selector.isCurrent({ pool: captured.pool, symbol: captured.standardSymbol }, captured.state)) throw new Error('market_source_changed')
  }
}
