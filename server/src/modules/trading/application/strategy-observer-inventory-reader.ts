import type { OpenPosition, PendingOrder } from '../domain/trading.js'
import type { ObserverAuthorization } from './observer-ports.js'
import type { AccountLiveRoute } from './account-live-route-reader.js'

export interface StrategyObserverInventory {
  analysisStrategyId: string
  authorization: ObserverAuthorization
  route: AccountLiveRoute
  observedAt: string
  positions: { revision: number; observedAt: string; items: OpenPosition[] }
  pendingOrders: { revision: number; items: PendingOrder[] }
}

/** Caller holds one consistent database snapshot; missing evidence is never an empty portfolio. */
export interface StrategyObserverInventoryReader {
  read(scope: { userId: number; sourceAccountId: string; analysisStrategyId: string; asOf: string }): Promise<StrategyObserverInventory | null>
}
