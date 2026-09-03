import type { AccountRiskPolicyPatch, AccountRiskSummary, EffectiveRiskPolicy, RiskEvaluationInput, RiskEvaluationResult } from '../domain/risk.js'

export interface ReplaceAccountRiskPolicyInput {
  userId: number
  accountId: string
  expectedRevision: number
  patch: AccountRiskPolicyPatch
  actorUserId: number
  reason: string
  changedAt: string
}

export interface SaveRiskSummaryInput {
  summary: AccountRiskSummary
  expectedRevision: number | null
}

export interface CompleteRiskReviewInput {
  riskDecisionId: string
  decisionId: string
  decisionRevision: number
  accountRiskRevision: number
  policySetRevision: number
  expectedRevisions: RiskEvaluationInput['currentRevisions']
  evaluation: RiskEvaluationResult
}

export interface RiskDecisionSummary {
  id: string
  tradeDecisionId: string
  userId: number
  accountId: string
  status: 'approved' | 'rejected'
  rejectCode: string | null
  platformPolicyVersionId: string
  accountPolicyVersionId: string | null
  accountRiskRevision: number
  createdAt: string
  revision: number
}

export interface RiskDecisionDetail extends RiskDecisionSummary {
  evaluation: RiskEvaluationResult
}

export interface RiskRepository {
  getEffectivePolicy(userId: number, accountId: string): Promise<EffectiveRiskPolicy | null>
  replaceAccountPolicy(input: ReplaceAccountRiskPolicyInput): Promise<EffectiveRiskPolicy>
  getAccountSummary(userId: number, accountId: string): Promise<AccountRiskSummary | null>
  saveAccountSummary(input: SaveRiskSummaryInput): Promise<AccountRiskSummary>
  loadReviewCandidate(decisionId: string): Promise<RiskEvaluationInput | null>
  completeReview(input: CompleteRiskReviewInput): Promise<RiskDecisionSummary>
  getDecision(userId: number, decisionId: string): Promise<RiskDecisionDetail | null>
  listDecisions(userId: number, accountId: string, limit: number): Promise<RiskDecisionSummary[]>
}
