import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'

const db = vi.hoisted(() => ({
  queryAll: vi.fn(), queryOne: vi.fn(), queryRun: vi.fn(), withTransaction: vi.fn(),
  beijingNow: vi.fn(() => '2026-07-15 12:00:00'),
}))
vi.mock('../../server/db.js', () => db)
vi.mock('../../server/routes/ai/model-profiles.js', () => ({ resolveAiTaskModel: vi.fn() }))
vi.mock('../../server/routes/ai/llm.js', () => ({ requestJsonObject: vi.fn() }))

import { assessReviewEvidence, validateReviewContent } from '../../server/routes/ai/review-workflow.js'

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
    expect(service).toContain('SELECT * FROM trade_review_cases WHERE id = ? AND user_id = ? FOR UPDATE')
    expect(service).toContain('SELECT COALESCE(MAX(version_no), 0) AS max_version FROM trade_review_versions WHERE case_id = ? FOR UPDATE')
  })

  it('uses owner-scoped reads and exposes only redacted admin health', () => {
    expect(service).toContain('WHERE id = ? AND user_id = ?')
    expect(service).toContain("content_redacted: true")
    expect(routes).toContain("req.user.role !== 'admin'")
  })

  it('binds approval to the exact current version and retries model failures without touching trading', () => {
    expect(service).toContain('Number(reviewCase.current_version_id) !== Number(versionId)')
    expect(service).toContain("approved_version_id = ?")
    expect(service).toContain("exhausted ? 'failed' : 'queued'")
    expect(service).not.toContain('prepareAndExecuteOrderIntent')
  })
})

