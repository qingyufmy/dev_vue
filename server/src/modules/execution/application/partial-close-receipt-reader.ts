import type { PartialCloseProtectionPlan, ProtectionTarget } from '../domain/partial-close-protection.js'
import type { CloseReceiptTickets } from '../domain/partial-close-receipt.js'

/** A command receipt is an anchor for history verification, not proof of the closed quantity. */
export interface PartialCloseCommandReceipt extends CloseReceiptTickets {
  readonly parentIntentId: string
  readonly parentCommandId: string
  readonly target: ProtectionTarget
  readonly issuedAt: number
  readonly completedAt: number
  readonly connectionEpoch: number
  readonly resultHash: string
}
export interface PartialCloseReceiptReader {
  /** Caller holds an authorized consistent snapshot. No current state or latest-command fallback. */
  read(plan: PartialCloseProtectionPlan): Promise<PartialCloseCommandReceipt | null>
}
