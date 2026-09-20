import type { MarketSourceCandidate, MarketSourceScope, MarketSourceState } from '../domain/market-source.js'
export interface MarketSourceStore {
  read(scope: MarketSourceScope): Promise<MarketSourceState | null>
  compareAndSet(scope: MarketSourceScope, expectedRevision: number | null, next: MarketSourceState): Promise<boolean>
}
export type MarketSourceProbe = { status: 'ready'; resolvedSymbol: string; marketState?: import('../domain/market-source.js').BridgeMarketState }
  | { status: 'busy' | 'temporary_failure' | 'unsupported' | 'unavailable' }
export interface MarketSourceCandidates {
  /** Only currently authorized and connected accounts in this pool; bounded inventory. */
  list(scope: MarketSourceScope): Promise<MarketSourceCandidate[]>
  probe(scope: MarketSourceScope, source: MarketSourceCandidate): Promise<MarketSourceProbe>
}
