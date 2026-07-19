import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'

const db = vi.hoisted(() => ({
  queryAll: vi.fn(), queryOne: vi.fn(), queryRun: vi.fn(), withTransaction: vi.fn(),
  beijingNow: vi.fn(() => '2026-07-15 12:00:00'),
}))
vi.mock('../../server/db.js', () => db)
vi.mock('../../server/routes/ai/model-profiles.js', () => ({ resolveAiTaskModel: vi.fn() }))
vi.mock('../../server/routes/ai/llm.js', () => ({ requestJsonObject: vi.fn() }))

import { assessReviewEvidence, assessReviewStrategyEligibility, validateReviewContent } from '../../server/routes/ai/review-workflow.js'

const completeRow = (overrides = {}) => ({
  status: 'closed', review_eligible_at: '2026-07-15 12:00:00', attribution_status: 'attributed',
  signal_id: 1, signal_type: 'buy', snapshot_id: 2, snapshot_evidence_status: 'complete',
  system_prompt: 'historical system prompt', user_prompt: 'historical user prompt', ...overrides,
})
const deals = [{ deal_ticket: 'D1' }]
const content = (overrides = {}) => ({
  summary: 'The outcome and decision are assessed separately.', decision_quality: 'mixed',
  outcome_summary: 'The trade lost after costs.', trade_process_issues: [{ code: 'late_entry', severity: 'medium', description: 'Entry was late.', evidence_refs: ['execution_deals'] }],
  strengths: ['Risk was bounded.'], lessons: ['Wait for confirmation.'],
  evidence_refs: ['original_signal', 'execution_deals'], confidence: 0.7, ...overrides,
})

describe('trade review evidence completeness', () => {
  it('accepts only exact, closed evidence with the original historical prompt', () => {
    expect(assessReviewEvidence(completeRow(), deals)).toEqual({ complete: true, reasons: [] })
  })

  it('marks omitted historical prompts as incomplete and never substitutes current prompts', () => {
    const result = assessReviewEvidence(completeRow({ system_prompt: '[evidence omitted; sha256=abc]' }), deals)
    expect(result.complete).toBe(false)
    expect(result.reasons).toContain('historical_prompt_missing')
  })

  it('blocks ambiguous attribution and missing deals', () => {
    const result = assessReviewEvidence(completeRow({ attribution_status: 'attribution_ambiguous' }), [])
    expect(result.reasons).toEqual(expect.arrayContaining(['outcome_attribution_not_exact', 'execution_deals_missing']))
  })
})

describe('trade review strategy boundary', () => {
  it('does not generate a personal review for an ordinary user running a platform strategy', () => {
    expect(assessReviewStrategyEligibility({ snapshot_strategy_scope: 'platform', review_user_role: 'user' }))
      .toEqual({ eligible: false, reason: 'platform_strategy_user_review_disabled' })
  })

  it('keeps administrator platform reviews and ordinary-user private reviews eligible', () => {
    expect(assessReviewStrategyEligibility({ snapshot_strategy_scope: 'platform', review_user_role: 'admin' }).eligible).toBe(true)
    expect(assessReviewStrategyEligibility({ snapshot_strategy_scope: 'private', review_user_role: 'user' }).eligible).toBe(true)
  })

  it('fails closed when the immutable strategy scope is unavailable', () => {
    expect(assessReviewStrategyEligibility({ review_user_role: 'user' }))
      .toEqual({ eligible: false, reason: 'review_strategy_scope_missing' })
  })
})

describe('strict review content schema', () => {
  const refs = { original_signal: {}, execution_deals: {} }

  it('keeps decision quality independent of whether the result was profitable', () => {
    expect(validateReviewContent(content(), refs).decision_quality).toBe('mixed')
    expect(validateReviewContent(content({ outcome_summary: 'The trade made a profit.', decision_quality: 'poor' }), refs).decision_quality).toBe('poor')
  })

  it('rejects unknown evidence references and unknown fields', () => {
    expect(() => validateReviewContent(content({ evidence_refs: ['made_up'] }), refs)).toThrow('invalid_evidence_ref')
    expect(() => validateReviewContent({ ...content(), hidden: true }, refs)).toThrow('unknown_review_field')
  })
})

describe('review durability and privacy guards', () => {
  const migration = readFileSync(new URL('../../server/migrations.js', import.meta.url), 'utf8')
  const service = readFileSync(new URL('../../server/routes/ai/review-workflow.js', import.meta.url), 'utf8')
  const routes = readFileSync(new URL('../../server/routes/ai/index.js', import.meta.url), 'utf8')

  it('deduplicates jobs and serializes immutable version allocation', () => {
    expect(migration).toContain('UNIQUE KEY uk_trade_review_job_key (idempotency_key)')
    expect(migration).toContain('UNIQUE KEY uk_trade_review_version (case_id, version_no)')
    expect(service).toContain('SELECT rc.* FROM trade_review_cases rc WHERE rc.id = ? AND rc.user_id = ?')
    expect(service).toContain('SELECT COALESCE(MAX(version_no), 0) AS max_version FROM trade_review_versions WHERE case_id = ? FOR UPDATE')
  })

  it('uses owner-scoped reads and exposes only redacted admin health', () => {
    expect(service).toContain('rc.id = ? AND rc.user_id = ?')
    expect(service).toContain("content_redacted: true")
    expect(routes).toContain("req.user.role !== 'admin'")
  })

  it('filters platform-strategy reviews for ordinary users at scan, queue and read boundaries', () => {
    expect(service).toContain("snap.strategy_scope = 'platform' AND u.role <> 'admin'")
    expect(service).toContain("eligibility_snap.strategy_scope = 'platform' AND eligibility_user.role = 'admin'")
    expect(service).toContain('platform_strategy_user_review_disabled')
  })

  it('allows period reviews to prepare immutable trade evidence without queueing a legacy model job', () => {
    expect(service).toContain('ensureReviewCaseForOutcome(outcomeId, { queueGeneration = false } = {})')
    expect(service).toContain('if (queueGeneration && generationEnabled')
  })

  it('binds approval to the exact current version and retries model failures without touching trading', () => {
    expect(service).toContain('Number(reviewCase.current_version_id) !== Number(versionId)')
    expect(service).toContain("approved_version_id = ?")
    expect(service).toContain("exhausted ? 'failed' : 'queued'")
    expect(service).not.toContain('prepareAndExecuteOrderIntent')
  })

  it('separates immutable inference evidence from post-trade path and Chan evidence', () => {
    expect(service).toContain('schema_version: 2')
    expect(service).toContain('post_trade_klines')
    expect(service).toContain('post_trade_structure')
    expect(service).toContain('path_metrics')
    expect(service).toContain('snapshot_strategy_version')
    expect(migration).toContain('path_evidence_status')
  })

  it('resolves review models from the immutable strategy snapshot', () => {
    expect(service).toContain('evidence?.inference_time?.snapshot?.strategy_id')
    expect(service).toContain('strategyId, usage: \'review\'')
    expect(service).toContain('strategyId },')
  })
})
