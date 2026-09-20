import type { ReviewWriteCommand } from './review-write-command.js'
import type {
  ManualReviewCandidate, ReviewCaseDetail, ReviewCaseSummary, ReviewContent, ReviewKind,
  StrategyMemoryDetail, StrategyMemorySummary, StrategyMemoryUpdate,
} from '../domain/review.js'

export interface CreateManualReviewInput {
  command: ReviewWriteCommand
  userId: number
  candidateIds: string[]
  selectionTokens: string[]
  strategyId: string
  userThesis: string | null
  idempotencyKey: string
  now: string
}

export interface ReviewRepository {
  listCases(userId: number, filter: { kind?: ReviewKind; tradingAccountId?: string; limit: number }): Promise<ReviewCaseSummary[]>
  getCase(userId: number, caseId: string): Promise<ReviewCaseDetail | null>
  listManualCandidates(userId: number, tradingAccountId: string | undefined, limit: number): Promise<ManualReviewCandidate[]>
  createManualCase(input: CreateManualReviewInput): Promise<ReviewCaseDetail>
  requestGeneration(input: { userId: number; caseId: string; expectedRevision: number; mode: 'retry' | 'refresh_evidence'; now: string; command: ReviewWriteCommand }): Promise<ReviewCaseDetail>
  createUserVersion(input: { userId: number; caseId: string; expectedRevision: number; content: ReviewContent; now: string; command: ReviewWriteCommand }): Promise<ReviewCaseDetail>
  confirmVersion(input: { userId: number; caseId: string; versionId: string; expectedRevision: number; now: string; command: ReviewWriteCommand }): Promise<ReviewCaseDetail>
  returnCase(input: { userId: number; caseId: string; expectedRevision: number; reason: string; now: string; command: ReviewWriteCommand }): Promise<ReviewCaseDetail>
  listMemories(userId: number): Promise<StrategyMemorySummary[]>
  getMemory(userId: number, memoryId: string): Promise<StrategyMemoryDetail | null>
  listMemoryUpdates(userId: number, memoryId: string): Promise<StrategyMemoryUpdate[]>
  decideMemoryUpdate(input: { userId: number; updateId: string; expectedRevision: number; decision: 'accept' | 'reject' | 'revoke'; now: string; command: ReviewWriteCommand }): Promise<StrategyMemoryUpdate>
}

export interface ReviewJobClaim {
  jobId: string
  caseId: string
  userId: number
  tradingAccountId: string
  kind: ReviewKind
  generation: number
  evidenceRevision: number
  evidenceHash: string
  evidence: Record<string, unknown>
  allowedEvidenceRefs: string[]
  strategyId: string
  allowedStrategyIds: string[]
  analysisPrompt: string | null
  traderPrompt: string | null
  fencingToken: number
  workerId: string
  nextAttemptNumber: number
}

export interface ReviewWorkerRepository {
  claimJob(jobId: string, workerId: string, claimedAt: string, leaseExpiresAt: string): Promise<ReviewJobClaim | null>
  startModelAttempt(input: { claim: ReviewJobClaim; attemptId: string; attemptNumber: number; profileId: string; provider: string; model: string; now: string }): Promise<void>
  failJob(input: { claim: ReviewJobClaim; errorCode: string; now: string }): Promise<void>
  failModelAttempt(input: { claim: ReviewJobClaim; attemptId: string; status: 'failed' | 'timed_out' | 'contract_invalid'; errorCode: string; final: boolean; now: string }): Promise<void>
  completeJob(input: { claim: ReviewJobClaim; attemptId: string; content: ReviewContent; responseHash: string; usage: Record<string, unknown> | null; now: string }): Promise<{ versionId: string }>
}
