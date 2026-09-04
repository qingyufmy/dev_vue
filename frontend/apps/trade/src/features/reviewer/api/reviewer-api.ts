import { createApiClient } from '@aurum/api-client'
import type { ManualReviewCaseCreateBody, ReviewContent, ReviewKind } from '@aurum/contracts'

const client = createApiClient()

/** V4 review transport. Response parsing stays in @aurum/contracts; this feature only maps it for presentation. */
export const reviewerApi = {
  listReviewCases: (filter: { kind?: ReviewKind; accountId?: string; pageSize?: number } = {}) => client.listReviewCases(filter),
  getReviewCase: (caseId: string) => client.getReviewCase(caseId),
  listManualReviewCandidates: (accountId?: string, pageSize = 50) => client.listManualReviewCandidates(accountId, pageSize),
  listAnalysisStrategies: () => client.listStrategies('analysis'),
  createManualReviewCase: (csrfToken: string, body: ManualReviewCaseCreateBody, idempotencyKey: string) => client.createManualReviewCase(csrfToken, body, idempotencyKey),
  createReviewVersion: (csrfToken: string, caseId: string, content: ReviewContent, expectedRevision: number) => client.createReviewVersion(csrfToken, caseId, content, expectedRevision),
  confirmReviewVersion: (csrfToken: string, caseId: string, versionId: string, expectedRevision: number) => client.confirmReviewVersion(csrfToken, caseId, versionId, expectedRevision),
  returnReviewCase: (csrfToken: string, caseId: string, reason: string, expectedRevision: number) => client.returnReviewCase(csrfToken, caseId, reason, expectedRevision),
  listStrategyMemories: () => client.listStrategyMemories(),
  getStrategyMemory: (memoryId: string) => client.getStrategyMemory(memoryId),
  listMemoryUpdates: (memoryId: string) => client.listMemoryUpdates(memoryId),
  decideMemoryUpdate: (csrfToken: string, updateId: string, decision: 'accept' | 'reject' | 'revoke', expectedRevision: number) => client.decideMemoryUpdate(csrfToken, updateId, decision, expectedRevision),
}
