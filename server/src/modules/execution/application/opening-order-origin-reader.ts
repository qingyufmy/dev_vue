import type { PendingOrderOrigin, PendingOrderOriginScope } from './pending-order-origin-reader.js'

export type OpeningOrderOriginScope = PendingOrderOriginScope
export type OpeningOrderOrigin = PendingOrderOrigin
/** Exact order creation evidence for market and pending orders. Caller owns authorization and consistent snapshot.
 * Missing evidence is unresolved. Does not prove the current position's lifecycle or strategy ownership. */
export interface OpeningOrderOriginReader {
  read(scope: OpeningOrderOriginScope): Promise<OpeningOrderOrigin[]>
}
