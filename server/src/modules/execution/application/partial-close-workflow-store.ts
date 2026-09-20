import type { PartialCloseProtectionPlan, ProtectionTarget } from '../domain/partial-close-protection.js'

/** Must read and lock the current authorized target on the registration caller's transaction. */
export interface PartialCloseRegistrationTargetReader {
  read(scope: { target: ProtectionTarget; revision: number; connectionEpoch: number }): Promise<{
    target: ProtectionTarget; revision: number; volume: string
  } | null>
}

export interface PartialCloseWorkflowRegistration {
  readonly plan: PartialCloseProtectionPlan
  readonly planHash: string
  readonly revision: number
  readonly status: 'awaiting_close' | 'risk_review_required' | 'protecting' | 'succeeded' | 'stopped' | 'expired'
}

/** Caller owns the transaction containing parent command, immutable plan and audit event. */
export interface PartialCloseWorkflowWriter {
  register(plan: PartialCloseProtectionPlan): Promise<{ registration: PartialCloseWorkflowRegistration; replayed: boolean }>
}
