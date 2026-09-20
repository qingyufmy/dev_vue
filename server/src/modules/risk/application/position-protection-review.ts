import { evaluatePositionProtection, type PositionProtectionRiskContext, type PositionProtectionRiskRequest, type PositionProtectionRiskReview } from '../domain/position-protection-risk.js'
import { RiskError } from '../domain/risk.js'

export interface PositionProtectionContextReader {
  /** Current authorized facts, read on the caller's transaction and kept locked through child-intent persistence. */
  read(request: PositionProtectionRiskRequest): Promise<PositionProtectionRiskContext | null>
}
export interface PositionProtectionReviewer {
  review(request: PositionProtectionRiskRequest): Promise<PositionProtectionRiskReview>
}
export interface PositionProtectionReviewClock { now(): Promise<Date> }
export function createPositionProtectionReviewer(contexts: PositionProtectionContextReader, clock: PositionProtectionReviewClock): PositionProtectionReviewer {
  return { async review(source) {
    const request = structuredClone(source)
    const context = await contexts.read(structuredClone(request))
    if (!context) throw new RiskError('position_protection_context_unavailable',409)
    const frozen = structuredClone(context)
    return evaluatePositionProtection(request,frozen,await clock.now())
  } }
}
