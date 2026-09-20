import { evaluatePartialCloseDispatch, type PartialCloseDispatchRiskRequest, type PartialCloseDispatchRiskContext } from '../domain/partial-close-dispatch-risk.js'
import { RiskError } from '../domain/risk.js'
import type { PositionProtectionReviewClock } from './position-protection-review.js'

export interface PartialCloseDispatchContextReader {
  read(request: PartialCloseDispatchRiskRequest): Promise<PartialCloseDispatchRiskContext | null>
}
export function createPartialCloseDispatchReviewer(contexts: PartialCloseDispatchContextReader, clock: PositionProtectionReviewClock) {
  return { async review(input: PartialCloseDispatchRiskRequest) {
    const request = structuredClone(input)
    const context = await contexts.read(structuredClone(request))
    if (!context) throw new RiskError('partial_close_dispatch_context_unavailable',409)
    const frozen = structuredClone(context)
    return evaluatePartialCloseDispatch(request,frozen,await clock.now())
  } }
}
