import { describe, expect, it } from 'vitest'
import { dailyReviewStatistics, groupDailyReviewOutcomes, outcomeCloseUtcMs,
  periodReviewEligibility, reviewPeriodBounds, reviewPeriodKey, validateDailyReviewContent } from '../../server/routes/ai/period-review.js'

describe('period review calendar', () => {
  it('uses the calibrated MT5 offset for daily boundaries', () => {
    const bounds = reviewPeriodBounds('daily', '2026-07-17', 180)
    expect(new Date(bounds.startUtcMs).toISOString()).toBe('2026-07-16T21:00:00.000Z')
    expect(new Date(bounds.endUtcMs).toISOString()).toBe('2026-07-17T21:00:00.000Z')
    expect(reviewPeriodKey(Date.parse('2026-07-17T20:59:59Z'), 'daily', 180)).toBe('2026-07-17')
    expect(reviewPeriodKey(Date.parse('2026-07-17T21:00:00Z'), 'daily', 180)).toBe('2026-07-18')
  })

  it('calculates exact monthly boundaries without assuming 30 days', () => {
    const bounds = reviewPeriodBounds('monthly', '2026-02', 180)
    expect(new Date(bounds.startUtcMs).toISOString()).toBe('2026-01-31T21:00:00.000Z')
    expect(new Date(bounds.endUtcMs).toISOString()).toBe('2026-02-28T21:00:00.000Z')
  })
})

describe('daily review grouping', () => {
  const base = { user_id: 7, user_role: 'user', trading_account_id: 11, strategy_id: 3, strategy_version: 2,
    strategy_scope: 'private', status: 'closed', net_profit: 10, external_intervention: 0 }

  it('prefers normalized UTC deal time and waits for the daily grace window', () => {
    const close = outcomeCloseUtcMs({ last_deal_raw_json: JSON.stringify({ time_utc_msc: Date.parse('2026-07-17T10:00:00Z') }) }, 180)
    expect(close).toBe(Date.parse('2026-07-17T10:00:00Z'))
    const waiting = groupDailyReviewOutcomes([{ ...base, id: 1, last_deal_raw_json: JSON.stringify({ time_utc_msc: close }) }], {
      offsetMinutes: 180, asOfUtcMs: Date.parse('2026-07-17T21:29:59Z'),
    })
    const ready = groupDailyReviewOutcomes([{ ...base, id: 1, last_deal_raw_json: JSON.stringify({ time_utc_msc: close }) }], {
      offsetMinutes: 180, asOfUtcMs: Date.parse('2026-07-17T21:30:00Z'),
    })
    expect(waiting).toHaveLength(0)
    expect(ready).toHaveLength(1)
    expect(ready[0]).toMatchObject({ periodKey: '2026-07-17', strategyVersion: 2, offsetMinutes: 180 })
  })

  it('keeps strategy versions and accounts isolated', () => {
    const time = JSON.stringify({ time_utc_msc: Date.parse('2026-07-17T10:00:00Z') })
    const rows = [
      { ...base, id: 1, last_deal_raw_json: time },
      { ...base, id: 2, trading_account_id: 12, last_deal_raw_json: time },
      { ...base, id: 3, strategy_version: 3, last_deal_raw_json: time },
    ]
    expect(groupDailyReviewOutcomes(rows, { offsetMinutes: 180, asOfUtcMs: Date.parse('2026-07-18T00:00:00Z') })).toHaveLength(3)
  })

  it('preserves platform and private review privacy boundaries', () => {
    expect(periodReviewEligibility({ strategy_scope: 'platform', user_role: 'user' }).eligible).toBe(false)
    expect(periodReviewEligibility({ strategy_scope: 'platform', user_role: 'admin' }).eligible).toBe(true)
    expect(periodReviewEligibility({ strategy_scope: 'private', user_role: 'user' }).eligible).toBe(true)
    expect(periodReviewEligibility({ strategy_scope: 'private', user_role: 'admin' }).eligible).toBe(false)
  })

  it('computes deterministic statistics outside the model', () => {
    expect(dailyReviewStatistics([
      { net_profit: 20, external_intervention: 0 },
      { net_profit: -10, external_intervention: 1 },
      { net_profit: 0, external_intervention: 0 },
    ])).toEqual({ trade_count: 3, wins: 1, losses: 1, breakeven: 1, win_rate: 1 / 3,
      net_profit: 10, gross_profit: 20, gross_loss: 10, profit_factor: 2, external_intervention_count: 1 })
  })
})

describe('daily review model boundary', () => {
  it('requires full trade coverage and explicit Chan diagnosis sources', () => {
    const value = validateDailyReviewContent({
      period_summary: '当日决策整体稳定', decision_quality: 'good',
      trade_assessments: [{ outcome_id: 1, decision_quality: 'good', summary: '证据一致', issue_codes: [] }],
      repeated_issues: [], strengths: ['遵守止损'], daily_lessons: ['等待确认'], risk_observations: [],
      chan_diagnoses: [{ outcome_id: 1, status: 'normal', issue_source: 'none', impact_on_decision: 'none', explanation: '结构一致', confidence: 0.9 }], confidence: 0.9,
    }, [1])
    expect(value.chan_diagnoses[0].issue_source).toBe('none')
    expect(() => validateDailyReviewContent({ ...value, trade_assessments: [] }, [1])).toThrow('daily_review_trade_coverage_incomplete')
    expect(() => validateDailyReviewContent({ ...value, chan_diagnoses: [] }, [1])).toThrow('daily_review_chan_coverage_incomplete')
    expect(() => validateDailyReviewContent({ ...value, chan_diagnoses: [{ ...value.chan_diagnoses[0], issue_source: 'future_guess' }] }, [1])).toThrow('invalid_daily_chan_diagnosis')
  })
})
