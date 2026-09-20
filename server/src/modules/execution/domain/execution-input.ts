/** Frozen facts consumed by execution, independent of AI and risk implementations. */
export type ExecutionJsonValue = null | boolean | number | string | ExecutionJsonValue[] | { [key: string]: ExecutionJsonValue }
export type ExecutionJsonObject = { [key: string]: ExecutionJsonValue }
export type ExecutionActionKind = 'market_order' | 'pending_order' | 'modify_position' | 'close_position' | 'modify_order' | 'cancel_order'

export interface ExecutionAction {
  actionId: string
  kind: ExecutionActionKind
  parameters: ExecutionJsonObject
  expectedState: ExecutionJsonObject
}

export interface ExecutionRiskRule {
  code: string
  outcome: 'passed' | 'rejected' | 'not_applicable'
  actionId: string | null
  details: ExecutionJsonObject
}

/** Preserve the complete evaluated receipt when persisting a user command. */
export interface ExecutionRiskEvaluation {
  status: 'approved' | 'rejected'
  rejectCode: string | null
  rules: ExecutionRiskRule[]
  approvedActions: ExecutionAction[]
  evaluatedAt: string
  policyHash: string
  manualReleaseId: string | null
  manualReleaseRevision: number | null
}
