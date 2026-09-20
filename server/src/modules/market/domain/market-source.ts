export type MarketPool = { kind: 'public' } | { kind: 'private'; userId: number }
export interface MarketSourceScope { pool: MarketPool; symbol: string }
export interface BridgeMarketState { state: 'open' | 'closed' | 'restricted' | 'stale' | 'unknown'; reason: string; checked_at_utc_msc: number }
export function parseBridgeMarketState(value: unknown): BridgeMarketState | null {
  if (!value || typeof value !== 'object') return null
  const state = value as BridgeMarketState
  if (!['open', 'closed', 'restricted', 'stale', 'unknown'].includes(state.state)
    || typeof state.reason !== 'string' || !/^[a-z_]{3,64}$/.test(state.reason)
    || !Number.isSafeInteger(state.checked_at_utc_msc) || state.checked_at_utc_msc < 1) return null
  return { state: state.state, reason: state.reason, checked_at_utc_msc: state.checked_at_utc_msc }
}
export interface MarketSourceCandidate {
  accountId: string
  ownerUserId: number
  connectionId: string
  connectionEpoch: number
}
export interface MarketSourceState {
  revision: number
  generation: number
  source: MarketSourceCandidate | null
  resolvedSymbol: string | null
  failures: number
  firstFailureAt: number | null
  lastCheckedAt: number
  marketState?: BridgeMarketState | null
}
export function marketPoolKey(pool: MarketPool): string {
  if (pool.kind === 'public' && Object.keys(pool).length === 1) return 'public'
  if (pool.kind === 'private' && Object.keys(pool).length === 2 && Number.isSafeInteger(pool.userId) && pool.userId > 0) return `private:${pool.userId}`
  throw new Error('market_pool_invalid')
}
export function assertMarketSourceScope(scope: MarketSourceScope) {
  marketPoolKey(scope.pool)
  if (!/^[A-Z0-9][A-Z0-9._-]{0,63}$/.test(scope.symbol)) throw new Error('market_base_symbol_invalid')
}
export function sameMarketSource(a: MarketSourceCandidate | null, b: MarketSourceCandidate | null) {
  return a === null || b === null ? a === b : a.accountId === b.accountId && a.ownerUserId === b.ownerUserId
    && a.connectionId === b.connectionId && a.connectionEpoch === b.connectionEpoch
}
