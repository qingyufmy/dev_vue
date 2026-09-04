import { createHash } from 'node:crypto'
import { assertGenerationMode, assertReviewContent, ReviewError, type ReviewKind } from '../domain/review.js'
import type { ReviewRepository } from './review-ports.js'

const opaque = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,190}$/

export class ReviewService {
  constructor(private readonly repository: ReviewRepository, private readonly now: () => Date = () => new Date()) {}

  cases(userId: number, filter: { kind?: string; tradingAccountId?: string; limit?: number } = {}) {
    const kind = filter.kind === undefined ? undefined : reviewKind(filter.kind)
    const tradingAccountId = filter.tradingAccountId === undefined ? undefined : id(filter.tradingAccountId, 'trading_account_id')
    return this.repository.listCases(userId, { ...(kind ? { kind } : {}), ...(tradingAccountId ? { tradingAccountId } : {}), limit: clamp(filter.limit) })
  }

  async detail(userId: number, caseId: string) {
    const result = await this.repository.getCase(userId, id(caseId, 'review_case_id'))
    if (!result) throw new ReviewError('review_case_not_found', 404)
    return result
  }

  manualCandidates(userId: number, tradingAccountId?: string, limit?: number) {
    return this.repository.listManualCandidates(userId, tradingAccountId ? id(tradingAccountId, 'trading_account_id') : undefined, clamp(limit))
  }

  createManualCase(userId: number, input: { candidateIds: string[]; selectionTokens: string[]; strategyId: string; userThesis?: string | null; idempotencyKey: string }) {
    if (!Array.isArray(input.candidateIds) || input.candidateIds.length < 1 || input.candidateIds.length > 20 || new Set(input.candidateIds).size !== input.candidateIds.length) throw new ReviewError('manual_review_candidates_invalid', 422)
    if (!Array.isArray(input.selectionTokens) || input.selectionTokens.length !== input.candidateIds.length) throw new ReviewError('manual_review_selection_tokens_invalid', 422)
    const candidateIds = input.candidateIds.map(value => id(value, 'candidate_id'))
    const selectionTokens = input.selectionTokens.map(value => token(value))
    const thesis = input.userThesis?.trim() || null
    if (thesis && thesis.length > 2000) throw new ReviewError('manual_review_thesis_too_long', 422)
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(input.idempotencyKey)) throw new ReviewError('idempotency_key_invalid', 422)
    return this.repository.createManualCase({ userId, candidateIds, selectionTokens, strategyId: id(input.strategyId, 'strategy_id'), userThesis: thesis, idempotencyKey: input.idempotencyKey, now: this.now().toISOString() })
  }

  requestGeneration(userId: number, caseId: string, expectedRevision: number, mode: string) {
    assertRevision(expectedRevision); assertGenerationMode(mode)
    return this.repository.requestGeneration({ userId, caseId: id(caseId, 'review_case_id'), expectedRevision, mode, now: this.now().toISOString() })
  }

  createVersion(userId: number, caseId: string, expectedRevision: number, content: unknown) {
    assertRevision(expectedRevision); assertReviewContent(content)
    return this.repository.createUserVersion({ userId, caseId: id(caseId, 'review_case_id'), expectedRevision, content: structuredClone(content), now: this.now().toISOString() })
  }

  confirm(userId: number, caseId: string, versionId: string, expectedRevision: number) {
    assertRevision(expectedRevision)
    return this.repository.confirmVersion({ userId, caseId: id(caseId, 'review_case_id'), versionId: id(versionId, 'review_version_id'), expectedRevision, now: this.now().toISOString() })
  }

  returnForChanges(userId: number, caseId: string, expectedRevision: number, reason: string) {
    assertRevision(expectedRevision)
    const normalized = reason.trim()
    if (normalized.length < 3 || normalized.length > 1000) throw new ReviewError('review_return_reason_invalid', 422)
    return this.repository.returnCase({ userId, caseId: id(caseId, 'review_case_id'), expectedRevision, reason: normalized, now: this.now().toISOString() })
  }

  memories(userId: number) { return this.repository.listMemories(userId) }
  async memory(userId: number, memoryId: string) {
    const result = await this.repository.getMemory(userId, id(memoryId, 'memory_id'))
    if (!result) throw new ReviewError('strategy_memory_not_found', 404)
    return result
  }
  memoryUpdates(userId: number, memoryId: string) { return this.repository.listMemoryUpdates(userId, id(memoryId, 'memory_id')) }
  decideMemoryUpdate(userId: number, updateId: string, expectedRevision: number, decision: string) {
    assertRevision(expectedRevision)
    if (decision !== 'accept' && decision !== 'reject' && decision !== 'revoke') throw new ReviewError('strategy_memory_decision_invalid', 422)
    return this.repository.decideMemoryUpdate({ userId, updateId: id(updateId, 'memory_update_id'), expectedRevision, decision, now: this.now().toISOString() })
  }
}

function id(value: string, field: string) {
  const result = String(value ?? '').trim()
  if (!opaque.test(result)) throw new ReviewError(`${field}_invalid`, 422)
  return result
}
function token(value: string) {
  const result = String(value ?? '').trim()
  if (result.length < 24 || result.length > 512) throw new ReviewError('manual_review_selection_token_invalid', 422)
  return createHash('sha256').update(result).digest('hex')
}
function reviewKind(value: string): ReviewKind {
  if (value !== 'daily' && value !== 'monthly' && value !== 'manual') throw new ReviewError('review_kind_invalid', 422)
  return value
}
function clamp(value?: number) { return Math.min(Math.max(Number.isFinite(value) ? Math.trunc(value!) : 50, 1), 100) }
function assertRevision(value: number) { if (!Number.isSafeInteger(value) || value < 1) throw new ReviewError('review_revision_invalid', 422) }
