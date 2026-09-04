import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import { BullMqOutboxTaskPublisher } from '../src/outbox/index.js'
import type { RuntimeTaskQueues } from '../src/queue/task-queues.js'
import {
  assertReviewContent, ReviewError, ReviewService,
  type CreateManualReviewInput, type ReviewCaseDetail, type ReviewContent, type ReviewRepository,
} from '../src/modules/reviews/index.js'

const now = '2026-09-04T08:00:00.000Z'
const content: ReviewContent = {
  schemaVersion: 'review.v4.1', conclusion: 'mixed', headline: '执行纪律稳定，但入场需要收紧', summary: '只依据冻结证据给出结论。',
  metrics: { netProfit: '12.50', tradeCount: 2, winRatePercent: '50', profitFactor: '1.20' },
  tradeEpisodes: [],
  roles: {
    analyst: { assessment: 'effective', summary: '方向判断有效', evidenceRefs: ['analysis:1'] },
    trader: { assessment: 'mixed', summary: '入场偏晚', evidenceRefs: ['decision:1'] },
    risk: { assessment: 'effective', summary: '硬风控按规则工作', evidenceRefs: ['risk:1'] },
    execution: { assessment: 'effective', summary: '终端结果已对账', evidenceRefs: ['execution:1'] },
  },
  counterexamples: [{ kind: 'missed_opportunity', title: '候选机会', summary: '仅作为反事实候选', evidenceRefs: ['analysis:1'], status: 'candidate' }],
  memoryCandidates: [{ strategyId: 'strategy-1', memoryKey: 'entry.confirmation', updateKind: 'short_term', title: '等待确认', content: '在证据重复前保持影子建议。', evidenceRefs: ['decision:1'] }],
  evidenceRefs: ['analysis:1', 'decision:1', 'risk:1', 'execution:1'], fullAnalysisText: '完整分析正文放在详情末尾。',
}

function detail(): ReviewCaseDetail {
  return {
    summary: {
      id: 'case-1', kind: 'manual', userId: 7, tradingAccountId: 'account-1', accountLabel: 'MT5 · 10001 · Demo',
      standardSymbol: 'XAUUSD', subscriptionId: null, subscriptionRevision: null, analysisStrategyId: 'strategy-1', analysisStrategyName: '分析策略', traderStrategyId: null,
      traderStrategyName: null, terminalPeriodStart: now, terminalPeriodEnd: '2026-09-04T09:00:00.000Z',
      terminalTimezoneOffsetMinutes: 180, status: 'queued', evidenceStatus: 'complete', evidenceRevision: 1,
      evidenceHash: 'a'.repeat(64),
      currentVersionId: null, confirmedVersionId: null, updatedAt: now, revision: 1,
    },
    currentVersion: null, sources: [], currentJob: null, returnReason: null,
  }
}

function repository() {
  const createManualCase = vi.fn(async (_input: CreateManualReviewInput) => detail())
  const value: ReviewRepository = {
    listCases: async () => [], getCase: async () => detail(), listManualCandidates: async () => [], createManualCase,
    requestGeneration: async () => detail(), createUserVersion: async () => detail(), confirmVersion: async () => detail(),
    returnCase: async () => detail(), listMemories: async () => [], getMemory: async () => null,
    listMemoryUpdates: async () => [], decideMemoryUpdate: async () => { throw new Error('not_used') },
  }
  return { value, createManualCase }
}

describe('Stage 12R review and strategy memory core', () => {
  it('accepts only bounded, evidence-linked review content', () => {
    expect(() => assertReviewContent(content)).not.toThrow()
    expect(() => assertReviewContent({})).toThrowError(expect.objectContaining({ code: 'review_content_schema_invalid' }))
    expect(() => assertReviewContent({ ...content, roles: undefined })).toThrowError(expect.objectContaining({ code: 'review_roles_invalid' }))
    expect(() => assertReviewContent({ ...content, memoryCandidates: [{ ...content.memoryCandidates[0]!, evidenceRefs: ['future:evidence'] }] })).toThrowError(expect.objectContaining({ code: 'review_evidence_reference_invalid' }))
    expect(() => assertReviewContent({ ...content, memoryCandidates: [{ ...content.memoryCandidates[0]!, memoryKey: 'Bad key' }] })).toThrowError(expect.objectContaining({ code: 'review_memory_candidate_invalid' }))
  })

  it('hashes expiring manual-trade selection tokens before they reach persistence', async () => {
    const repo = repository()
    const service = new ReviewService(repo.value, () => new Date(now))
    const token = `candidate-1.4.${'a'.repeat(64)}`
    await service.createManualCase(7, { candidateIds: ['candidate-1'], selectionTokens: [token], strategyId: 'strategy-1', userThesis: '我当时预期回踩后上涨', idempotencyKey: 'manual-review-0001' })
    expect(repo.createManualCase).toHaveBeenCalledWith(expect.objectContaining({
      selectionTokens: [createHash('sha256').update(token).digest('hex')], userThesis: '我当时预期回踩后上涨', now,
    }))
    expect(() => service.createManualCase(7, { candidateIds: ['candidate-1', 'candidate-1'], selectionTokens: [token, token], strategyId: 'strategy-1', idempotencyKey: 'manual-review-0002' })).toThrowError(expect.objectContaining({ code: 'manual_review_candidates_invalid' }))
  })

  it('keeps retry and refreshed-evidence generation modes distinct', async () => {
    const repo = repository(); const request = vi.spyOn(repo.value, 'requestGeneration')
    const service = new ReviewService(repo.value, () => new Date(now))
    await service.requestGeneration(7, 'case-1', 3, 'retry')
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ mode: 'retry', expectedRevision: 3 }))
    expect(() => service.requestGeneration(7, 'case-1', 3, 'replace')).toThrowError(expect.objectContaining({ code: 'review_generation_mode_invalid' }))
  })

  it('keeps the migration append-only and separates review jobs from provider attempts', async () => {
    const sql = await readFile(new URL('../db/migrations/20260904_012_review_memory_core.sql', import.meta.url), 'utf8')
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS review_cases_v4')
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS review_model_attempts_v4')
    expect(sql).toContain('UNIQUE KEY uk_review_case_scope (user_id, kind, scope_key)')
    expect(sql).toContain('selection_token_sha256')
    expect(sql).toContain('analysis_strategy_version_id')
    expect(sql).toContain("status ENUM('collecting_evidence','awaiting_confirmation'")
    expect(sql).toContain('content_json JSON NULL')
    expect(sql).toContain('idx_strategy_memory_proposal_support')
    expect(sql).not.toMatch(/\b(?:DROP|DELETE|TRUNCATE)\b/i)
  })

  it('uses the canonical outbox columns and freezes the selected active strategy version', async () => {
    const source = await readFile(new URL('../src/modules/reviews/infrastructure/mysql-review-repository.ts', import.meta.url), 'utf8')
    expect(source).toContain('(event_id,aggregate_type,aggregate_id,event_type,payload_json,status,attempts')
    expect(source).not.toContain('(id,aggregate_type,aggregate_id,event_type,payload_json,status,attempt_count')
    expect(source).toContain("status='active' AND active_version_id IS NOT NULL")
    expect(source).toContain("strategy.kind === 'analysis' ? strategy.active_version_id : null")
    expect(source).toContain('row.selection_token_sha256 !== input.selectionTokens[index]')
    expect(source).toContain("SET eligibility_status='already_reviewed'")
    expect(source).toContain("scope_key=? LIMIT 1 FOR SHARE")
    expect(source).toContain('COUNT(DISTINCT u.source_review_case_id) support_count')
    expect(source).toContain("row.status !== 'awaiting_confirmation'")
    expect(source).toContain("AND c.status='confirmed'")
    expect(source).toContain("source_kind,source_metadata_json,created_by_user_id,created_at_utc) VALUES (?,?,?,?,?,?,'revoke'")
    expect(source).toContain("block.memory_update_id !== input.updateId")
    expect(source).toContain('rebasePendingUpdates(connection, row.library_id')
    expect(source).toContain("row.status === 'running' && row.lease_expires_at_utc")
    expect(source).toContain("error_code='review_attempt_lease_expired'")
  })

  it('allows an explicit revoke decision while rejecting unknown decisions', async () => {
    const repo = repository(); const decide = vi.spyOn(repo.value, 'decideMemoryUpdate').mockResolvedValue({
      id: 'update-1', libraryId: 'memory-1', sourceReviewCaseId: 'case-1', sourceReviewVersionId: 'version-1',
      updateKind: 'short_term', status: 'superseded', expectedLibraryRevision: 2,
      proposal: { memoryKey: 'entry.confirmation', title: '等待确认', content: '等待确认后入场。', evidenceRefs: ['analysis:1'] },
      diffPreviewText: '', conflicts: [], createdAt: now, revision: 3,
    })
    const service = new ReviewService(repo.value, () => new Date(now))
    await service.decideMemoryUpdate(7, 'update-1', 2, 'revoke')
    expect(decide).toHaveBeenCalledWith(expect.objectContaining({ decision: 'revoke', expectedRevision: 2 }))
    expect(() => service.decideMemoryUpdate(7, 'update-1', 2, 'restore')).toThrowError(expect.objectContaining({ code: 'strategy_memory_decision_invalid' }))
  })

  it('routes only the review job id to the isolated low-priority queue', async () => {
    const add = vi.fn(async () => ({}))
    const publisher = new BullMqOutboxTaskPublisher({ review: { add } } as unknown as RuntimeTaskQueues)
    await publisher.publish({ id: '1', eventId: 'event-12345678', eventType: 'review.job.requested', occurredAt: now, payload: { review_job_id: 'review-job-1', review_case_id: 'case-1', evidence: { must_not_reach_queue: true } }, attempts: 1 })
    expect(add).toHaveBeenCalledWith('review.run', { reviewJobId: 'review-job-1' }, { jobId: 'event-12345678', priority: 20 })
  })

  it('preserves explicit domain errors for malformed content', () => {
    try { assertReviewContent(null) } catch (error) { expect(error).toBeInstanceOf(ReviewError); expect(error).toMatchObject({ status: 422 }) }
  })
})
