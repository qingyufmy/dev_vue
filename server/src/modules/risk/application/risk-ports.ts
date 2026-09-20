import type { AccountRiskPolicyPatch, AccountRiskSummary, EffectiveRiskPolicy, RiskEvaluationInput, RiskEvaluationResult } from '../domain/risk.js'
import type { ManualRiskRelease } from '../domain/manual-risk-release.js'

export interface ReplaceAccountRiskPolicyInput {
  idempotencyKey: string
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

export interface CreateManualRiskReleaseInput {
  release: ManualRiskRelease
  expectedSummaryRevision: number
  expectedPolicyHash: string
  idempotencyKey: string
  requestHash: string
}

export interface CompleteRiskReviewInput {
  strategyBudgetContext?: RiskEvaluationInput['strategyBudgetContext']
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
  manualReleaseId: string | null
  createdAt: string
  revision: number
}

export interface RiskDecisionDetail extends RiskDecisionSummary {
  evaluation: RiskEvaluationResult
}

export interface RiskRepository {
  getPolicyReceipt(userId: number, accountId: string, idempotencyKey: string): Promise<import('../domain/risk-policy-receipt.js').RiskPolicyReceipt | null>
  getEffectivePolicy(userId: number, accountId: string): Promise<EffectiveRiskPolicy | null>
  replaceAccountPolicy(input: ReplaceAccountRiskPolicyInput): Promise<EffectiveRiskPolicy>
  getAccountSummary(userId: number, accountId: string): Promise<AccountRiskSummary | null>
  saveAccountSummary(input: SaveRiskSummaryInput): Promise<AccountRiskSummary>
  createManualRelease(input: CreateManualRiskReleaseInput): Promise<ManualRiskRelease>
  getManualReleaseByIdempotency(userId: number, accountId: string, idempotencyKey: string): Promise<{ release: ManualRiskRelease; requestHash: string } | null>
  getManualRelease(userId: number, accountId: string): Promise<ManualRiskRelease | null>
  loadReviewCandidate(decisionId: string): Promise<RiskEvaluationInput | null>
  completeReview(input: CompleteRiskReviewInput): Promise<RiskDecisionSummary>
  getDecision(userId: number, decisionId: string): Promise<RiskDecisionDetail | null>
  listDecisions(userId: number, accountId: string, limit: number): Promise<RiskDecisionSummary[]>
}

export interface RiskDispatchPolicyReader {
  getEffectivePolicy(userId: number, accountId: string): Promise<EffectiveRiskPolicy>
}
