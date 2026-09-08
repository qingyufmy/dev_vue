import type { BridgeExactTradeState } from './trading-ports.js'

/** Bound to the projection transaction. Must not commit, roll back or acquire another connection. */
export interface ProjectionReservationAbsorber {
  absorb(input: {
    accountId: string
    entityKind: 'position' | 'pending_order'
    projectionRevision: number
    observedAt: string
    states: BridgeExactTradeState[]
    now: string
  }): Promise<string[]>
}
