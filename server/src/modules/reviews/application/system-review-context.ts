/** Consumer-owned frozen documents; bootstrap obtains these through inference and risk adapters. */
export interface SystemReviewContext {
  decisionId: string
  riskDecisionId: string
  inference: Record<string, unknown>
  risk: Record<string, unknown>
}
