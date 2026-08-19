import { describe, expect, it, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'

const db = vi.hoisted(() => ({
  beijingNow:vi.fn(() => '2026-08-19 12:00:00'),
  queryRun:vi.fn(),
  withTransaction:vi.fn(),
}))

vi.mock('../../server/db.js', () => db)

import { dailyEvidenceRetryAt, dailyEvidenceRetryDelayMs, isRecoverableDailyEvidenceJob,
  isRecoverableDailyEvidenceReason, shouldRefreshDailyReviewCase } from '../../server/routes/ai/period-review.js'
import { resetPeriodReviewEvidenceWakeState, wakePeriodReviewEvidenceWaiters } from '../../server/routes/ai/period-review-evidence-wake.js'

describe('daily review market-evidence retry policy', () => {
  it('uses bounded five, fifteen and sixty minute delays without consuming model attempts', () => {
    expect(dailyEvidenceRetryDelayMs(0)).toBe(5 * 60 * 1000)
    expect(dailyEvidenceRetryDelayMs(1)).toBe(15 * 60 * 1000)
    expect(dailyEvidenceRetryDelayMs(2)).toBe(60 * 60 * 1000)
    expect(dailyEvidenceRetryDelayMs(20)).toBe(60 * 60 * 1000)
    expect(dailyEvidenceRetryAt(0, Date.parse('2026-08-19T04:00:00Z'))).toBe('2026-08-19 12:05:00')
  })

  it('recognizes temporary market gaps but never retries terminal trade evidence', () => {
    expect(isRecoverableDailyEvidenceReason('period_market_incomplete')).toBe(true)
    expect(isRecoverableDailyEvidenceReason('XAUUSD:M5:Bridge not connected,period_market_incomplete')).toBe(true)
    expect(isRecoverableDailyEvidenceReason('period_market_source_unauthorized')).toBe(false)
    expect(isRecoverableDailyEvidenceReason('period_market_source_identity_changed')).toBe(false)
    expect(isRecoverableDailyEvidenceReason('inference_snapshot_incomplete,period_market_incomplete')).toBe(false)
    expect(isRecoverableDailyEvidenceJob({ status:'skipped', last_error_code:null }, {
      evidence_status:'incomplete', evidence_reason:'period_market_incomplete', current_version_id:null,
    })).toBe(true)
    expect(isRecoverableDailyEvidenceJob({ status:'skipped', last_error_code:'review_generation_disabled' }, {
      evidence_status:'incomplete', evidence_reason:'period_market_incomplete', current_version_id:null,
    })).toBe(false)
  })

  it('uses the persisted next attempt instead of the old fixed hourly interval', () => {
    const reviewCase = { evidence_status:'incomplete', evidence_reason:'period_market_incomplete', current_version_id:null,
      updated_at:'2026-08-19 11:59:00' }
    const job = { status:'queued', last_error_code:'period_market_incomplete', next_attempt_at:'2026-08-19 12:05:00' }
    expect(shouldRefreshDailyReviewCase(reviewCase, { outcomes:[{ id:1 }] }, [{ outcome_id:1 }],
      Date.parse('2026-08-19T04:04:59Z'), job)).toMatchObject({ refresh:false, reason:'evidence_retry_wait' })
    expect(shouldRefreshDailyReviewCase(reviewCase, { outcomes:[{ id:1 }] }, [{ outcome_id:1 }],
      Date.parse('2026-08-19T04:05:00Z'), job)).toMatchObject({ refresh:true, reason:'evidence_retry_due' })
  })
})

describe('period review evidence wake', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetPeriodReviewEvidenceWakeState()
  })

  it('only advances queued evidence jobs and debounces repeated candle events', async () => {
    const requestCycle = vi.fn()
    const run = vi.fn()
      .mockResolvedValueOnce([[{ id:11 }, { id:12 }], []])
      .mockResolvedValueOnce([{ affectedRows:2 }, []])
    db.withTransaction.mockImplementationOnce(callback => callback(run))
    const first = await wakePeriodReviewEvidenceWaiters({ sourceId:7, standardSymbol:'XAUUSD', timeframe:'M5',
      requestCycle, nowUtcMs:100_000 })
    const second = await wakePeriodReviewEvidenceWaiters({ sourceId:8, standardSymbol:'XAUUSD', timeframe:'H1',
      requestCycle, nowUtcMs:110_000 })
    expect(first).toMatchObject({ woken:2, standardSymbol:'XAUUSD', timeframe:'M5' })
    expect(second).toMatchObject({ woken:0, skipped:'debounced' })
    expect(db.withTransaction).toHaveBeenCalledTimes(1)
    expect(run.mock.calls[0][0]).toContain("jobs.status = 'queued'")
    expect(run.mock.calls[0][0]).toContain("jobs.last_error_code = 'period_market_incomplete'")
    expect(run.mock.calls[0][0]).toContain('cases.evidence_status <>')
    expect(run.mock.calls[0][0]).toContain('JSON_EXTRACT')
    expect(run.mock.calls[0][0]).toContain('ORDER BY jobs.next_attempt_at ASC, jobs.id ASC LIMIT ? FOR UPDATE')
    expect(run.mock.calls[1][0]).toContain('UPDATE period_review_jobs jobs')
    expect(run.mock.calls[1][0]).not.toContain('ORDER BY')
    expect(run.mock.calls[1][0]).not.toContain('LIMIT')
    expect(run.mock.calls[0][1]).toContain('XAUUSD')
    expect(run.mock.calls[0][1]).toContain('M5')
    expect(requestCycle).toHaveBeenCalledTimes(1)
  })

  it('exposes persisted evidence retry diagnostics in list, detail and job status queries', () => {
    const source = readFileSync(new URL('../../server/routes/ai/period-review.js', import.meta.url), 'utf8')
    expect(source.match(/jobs\.evidence_retry_count/g)?.length).toBeGreaterThanOrEqual(3)
    expect(source.match(/jobs\.evidence_last_checked_at/g)?.length).toBeGreaterThanOrEqual(3)
  })
})
