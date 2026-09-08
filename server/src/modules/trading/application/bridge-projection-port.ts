import type { BridgeExactTradeState, TradingProjectionWrite, TrustedBridgeProjectionRoute } from './trading-ports.js'

type WithoutAccount<T> = T extends unknown ? Omit<T, 'accountId'> : never
type ProjectionPayload = WithoutAccount<TradingProjectionWrite>

export type BridgeProjectionInput =
  | Exclude<ProjectionPayload, { resource: 'positions' | 'pending_orders' }>
  | (Extract<ProjectionPayload, { resource: 'positions' | 'pending_orders' }> & { tradeStates: BridgeExactTradeState[]; observedAt: string })

/** Applies a route-fenced projection; false means an already applied revision. Failures must propagate. */
export interface BridgeProjectionPort {
  ingest(route: TrustedBridgeProjectionRoute, input: BridgeProjectionInput): Promise<boolean>
}
