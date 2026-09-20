import type { BridgeGatewayRoute } from '../../bridge/index.js'

export interface HistoryTraversalScope {
  route: BridgeGatewayRoute
  rangeStartUtcMsc: number
  rangeEndUtcMsc: number
}
export type HistoryTraversalResult =
  | { status: 'unresolved'; reason: 'traversal_gap' }
  | { status: 'traversed'; receiptIds: string[]; completeHistoryProven: false }
/** Caller owns authorization and the read snapshot. Traversal is not terminal/cache completeness. */
export interface HistoryTraversalReader {
  read(scope: HistoryTraversalScope): Promise<HistoryTraversalResult>
}
