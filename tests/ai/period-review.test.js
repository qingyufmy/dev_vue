import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { dailyReviewStatistics, groupDailyReviewOutcomes, groupMonthlyReviewCases, monthlyReviewStatistics, outcomeCloseUtcMs,
  compactPeriodTradeEvidence, dailyEvidenceSemanticHash, isTerminalTradeEvidenceReason, periodReviewEligibility, reviewPeriodBounds, reviewPeriodKey,
  monthlyReviewSourceHash, samePeriodOutcomeSet, shouldRefreshDailyReviewCase, validateDailyReviewContent, validateMonthlyReviewContent } from '../../server/routes/ai/period-review.js'
import { assessReviewCandleCoverage, isReviewGridAligned, monthlyPeriodMarketDigest, requiredReviewCandleCount } from '../../server/routes/ai/period-market-evidence.js'

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

  it('reuses terminal incomplete evidence only while the outcome set is unchanged', () => {
    expect(isTerminalTradeEvidenceReason('inference_snapshot_incomplete')).toBe(true)
    expect(isTerminalTradeEvidenceReason('inference_snapshot_incomplete,historical_prompt_missing')).toBe(true)
    expect(isTerminalTradeEvidenceReason('execution_deals_missing')).toBe(false)
    expect(isTerminalTradeEvidenceReason('inference_snapshot_incomplete,execution_deals_missing')).toBe(false)
    expect(samePeriodOutcomeSet([{ id: 8 }, { id: 3 }, { id: 8 }], [{ outcome_id: 3 }, { outcome_id: 8 }])).toBe(true)
    expect(samePeriodOutcomeSet([{ id: 3 }, { id: 8 }, { id: 9 }], [{ outcome_id: 3 }, { outcome_id: 8 }])).toBe(false)
    expect(shouldRefreshDailyReviewCase({ evidence_status:'incomplete', evidence_reason:'historical_prompt_missing',
      updated_at:'2026-07-01 00:00:00' }, { outcomes:[{ id:3 }] }, [{ outcome_id:3 }], Date.parse('2026-07-19T00:00:00Z')))
      .toEqual({ refresh:false, reason:'terminal_evidence_incomplete' })
  })

  it('rechecks incomplete evidence and detects late outcomes without polling settled reviews forever', () => {
    const group = { outcomes:[{ id:3 }, { id:8 }], endUtcMs:Date.parse('2026-07-17T21:00:00Z') }
    const sources = [{ outcome_id:3 }, { outcome_id:8 }]
    const recent = { evidence_status:'incomplete', current_version_id:null, updated_at:'2026-07-18 05:00:00' }
    expect(shouldRefreshDailyReviewCase(recent, group, sources, Date.parse('2026-07-17T21:30:00Z'))).toMatchObject({ refresh:false })
    expect(shouldRefreshDailyReviewCase(recent, group, sources, Date.parse('2026-07-17T22:00:00Z'))).toMatchObject({ refresh:true, reason:'incomplete_recheck_due' })
    expect(shouldRefreshDailyReviewCase(recent, { ...group, outcomes:[...group.outcomes, { id:9 }] }, sources,
      Date.parse('2026-07-17T21:31:00Z'))).toMatchObject({ refresh:true, reason:'outcome_set_changed' })

    const settled = { evidence_status:'complete', current_version_id:11, updated_at:'2026-07-18 05:00:00' }
    expect(shouldRefreshDailyReviewCase(settled, group, sources, Date.parse('2026-07-19T22:00:00Z'))).toMatchObject({ refresh:false, reason:'finalized_unchanged' })
  })

  it('ignores evidence generation timestamps when deciding whether a review changed', () => {
    const left = { statistics:{ trade_count:2 }, sources:[{ outcome_id:1, evidence_hash:'a' }],
      period_market:{ generated_at:'2026-07-18T00:00:00Z', hash:'old', symbols:{ XAUUSD:{ M15:{ candle_count:10 } } } } }
    const right = { ...left, period_market:{ ...left.period_market, generated_at:'2026-07-18T01:00:00Z', hash:'new' } }
    expect(dailyEvidenceSemanticHash(left)).toBe(dailyEvidenceSemanticHash(right))
    right.statistics = { trade_count:3 }
    expect(dailyEvidenceSemanticHash(left)).not.toBe(dailyEvidenceSemanticHash(right))
  })
})

describe('daily review model boundary', () => {
  it('requires full trade coverage and explicit Chan diagnosis sources', () => {
    const value = validateDailyReviewContent({
      period_summary: '当日决策整体稳定', decision_quality: 'good',
      trade_assessments: [{ outcome_id: 1, decision_quality: 'good', summary: '证据一致', issue_codes: [] }],
      repeated_issues: [], strengths: ['遵守止损'], daily_lessons: ['等待确认'], risk_observations: [],
      chan_diagnoses: [{ outcome_id: 1, status: 'normal', issue_source: 'none', impact_on_decision: 'none', explanation: '结构一致', confidence: 0.9 }], confidence: 0.9,
      harmless_model_note: 'this key is normalized away',
    }, [1])
    expect(value.chan_diagnoses[0].issue_source).toBe('none')
    expect(value).not.toHaveProperty('harmless_model_note')
    expect(() => validateDailyReviewContent({ ...value, trade_assessments: [] }, [1])).toThrow('daily_review_trade_coverage_incomplete')
    expect(() => validateDailyReviewContent({ ...value, chan_diagnoses: [] }, [1])).toThrow('daily_review_chan_coverage_incomplete')
    expect(() => validateDailyReviewContent({ ...value, chan_diagnoses: [{ ...value.chan_diagnoses[0], issue_source: 'future_guess' }] }, [1])).toThrow('invalid_daily_chan_diagnosis')
  })

  it('normalizes common summary aliases and a harmless review wrapper', () => {
    const value = validateDailyReviewContent({ daily_review: {
      summary: '当日两笔交易均按计划退出', decision_quality: 'mixed',
      trade_assessments: [{ outcome_id: 1, decision_quality: 'mixed', summary: '执行正常', issue_codes: [] }],
      repeated_issues: [], strengths: [], daily_lessons: [], risk_observations: [],
      chan_diagnoses: [{ outcome_id: 1, status: 'normal', issue_source: 'none', impact_on_decision: 'none', explanation: '未发现结构问题', confidence: 0.8 }],
      period_chan_assessment: { status: 'normal', issue_source: 'none', explanation: '结构正常', affected_outcome_ids: [], confidence: 0.8 },
      confidence: 0.8,
    } }, [1])
    expect(value.period_summary).toBe('当日两笔交易均按计划退出')
    expect(value).not.toHaveProperty('summary')
  })
})

describe('monthly review aggregation', () => {
  const daily = (id, day, netProfit, status = 'approved') => ({ id, period_type: 'daily', period_key: day,
    user_id: 7, strategy_id: 3, strategy_version: 2, strategy_scope: 'private', trading_account_id: id,
    current_version_id: id + 100, status, evidence_json: JSON.stringify({ statistics: { trade_count: 2, wins: netProfit > 0 ? 2 : 0,
      losses: netProfit < 0 ? 2 : 0, breakeven: 0, net_profit: netProfit, gross_profit: Math.max(0, netProfit),
      gross_loss: Math.abs(Math.min(0, netProfit)), external_intervention_count: id === 2 ? 1 : 0 } }) })

  it('waits for the MT5 monthly grace period and combines accounts without losing daily sources', () => {
    const rows = [daily(1, '2026-02-03', 20), daily(2, '2026-02-12', -10, 'draft')]
    expect(groupMonthlyReviewCases(rows, { offsetMinutes: 180, asOfUtcMs: Date.parse('2026-02-28T22:59:59Z') })).toHaveLength(0)
    const groups = groupMonthlyReviewCases(rows, { offsetMinutes: 180, asOfUtcMs: Date.parse('2026-02-28T23:00:00Z') })
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ periodKey: '2026-02', tradingAccountId: 0, strategyVersion: 2 })
    expect(groups[0].dailyCases.map(item => item.id)).toEqual([1, 2])
  })

  it('computes monthly metrics from deterministic daily statistics', () => {
    expect(monthlyReviewStatistics([daily(1, '2026-02-03', 20), daily(2, '2026-02-12', -10)])).toEqual({
      trading_days: 2, trade_count: 4, wins: 2, losses: 2, breakeven: 0, win_rate: 0.5,
      net_profit: 10, gross_profit: 20, gross_loss: 10, profit_factor: 2, profitable_days: 1,
      losing_days: 1, external_intervention_count: 1,
    })
  })

  it('invalidates a monthly source snapshot when a daily review version or status changes', () => {
    const source = { id:11, status:'draft', evidence_hash:'e1', current_content_hash:'v1' }
    expect(monthlyReviewSourceHash([source])).toBe(monthlyReviewSourceHash([{ period_case_id:11,
      review_status:'draft', evidence_hash:'e1', content_hash:'v1' }]))
    expect(monthlyReviewSourceHash([source])).not.toBe(monthlyReviewSourceHash([{ ...source, status:'approved' }]))
    expect(monthlyReviewSourceHash([source])).not.toBe(monthlyReviewSourceHash([{ ...source, current_content_hash:'v2' }]))
  })
})

describe('monthly review model boundary', () => {
  it('requires every daily source and multi-day support for memory candidates', () => {
    const input = { period_summary: '月度决策总体稳定', decision_quality: 'mixed',
      daily_assessments: [
        { period_case_id: 11, decision_quality: 'good', summary: '证据一致', issue_codes: [] },
        { period_case_id: 12, decision_quality: 'poor', summary: '确认过早', issue_codes: ['confirmation_early'] },
      ], recurring_patterns: ['确认偏早'], strengths: ['遵守止损'], risk_observations: [], chan_issue_summary: ['背驰确认滞后'],
      next_month_actions: ['等待结构确认'], memory_candidates: [{ lesson: '等待两个交易日重复验证的结构确认', anti_pattern: '单点抢跑',
        supporting_period_case_ids: [11, 12], confidence: 0.8 }], confidence: 0.8 }
    expect(validateMonthlyReviewContent(input, [11, 12]).memory_candidates[0].supporting_period_case_ids).toEqual([11, 12])
    expect(() => validateMonthlyReviewContent({ ...input, daily_assessments: input.daily_assessments.slice(0, 1) }, [11, 12])).toThrow('monthly_review_daily_coverage_incomplete')
    expect(() => validateMonthlyReviewContent({ ...input, memory_candidates: [{ ...input.memory_candidates[0], supporting_period_case_ids: [11] }] }, [11, 12])).toThrow('invalid_monthly_memory_candidate')
    expect(() => validateMonthlyReviewContent(input, [11, 12], [11])).toThrow('invalid_monthly_memory_candidate')
  })
})

describe('period review runtime integration', () => {
  const routes = readFileSync(new URL('../../server/routes/ai/index.js', import.meta.url), 'utf8')
  const server = readFileSync(new URL('../../server/index.js', import.meta.url), 'utf8')
  const platform = readFileSync(new URL('../../server/routes/ai/platform-experience.js', import.meta.url), 'utf8')
  const migration = readFileSync(new URL('../../server/migrations.js', import.meta.url), 'utf8')

  it('exposes owner-scoped daily and monthly review APIs', () => {
    expect(routes).toContain("router.get('/ai/period-reviews'")
    expect(routes).toContain("router.get('/ai/period-reviews/:id'")
    expect(routes).toContain("router.post('/ai/period-reviews/:id/edit'")
    expect(routes).toContain("router.post('/ai/period-reviews/:id/confirm'")
    expect(routes).toContain("router.post('/ai/period-reviews/:id/retry'")
    expect(routes).toContain("router.get('/ai/period-reviews/summary'")
    expect(readFileSync(new URL('../../server/routes/ai/period-review.js', import.meta.url), 'utf8')).toContain('daily_total:0, monthly_total:0')
    expect(routes).toContain("router.get('/ai/period-reviews/:id/job-status'")
    expect(routes).toContain("router.post('/ai/period-reviews/:id/read'")
    expect(routes).toContain("router.post('/ai/period-reviews/:id/derivation/retry'")
  })

  it('starts only the period worker and preserves separate platform experience lineage', () => {
    const periodReview = readFileSync(new URL('../../server/routes/ai/period-review.js', import.meta.url), 'utf8')
    expect(server).toContain('startPeriodReviewWorker()')
    expect(server).not.toContain('startReviewWorker()')
    expect(server).not.toContain('startMemoryCompressionWorker()')
    expect(platform).toContain('createPlatformExperienceCandidateFromApprovedPeriodReview')
    expect(migration).toContain('092_platform_period_experience_lineage')
    expect(migration).toContain('uk_platform_experience_period_version')
    expect(migration).toContain('093_period_review_single_job_slot')
    expect(migration).toContain('uk_period_review_case_job_slot')
    expect(migration).toContain('094_period_review_retry_backoff')
    expect(migration).toContain('095_period_review_failed_state_repair')
    expect(migration).toContain('096_period_review_observability')
    expect(migration).toContain('period_review_job_events')
    expect(migration).toContain('period_review_user_states')
    expect(migration).toContain('101_period_review_derivation_jobs')
    expect(migration).toContain('period_review_derivation_jobs')
    expect(migration).toContain('108_review_compacted_snapshot_evidence')
    expect(migration).toContain('109_review_compacted_snapshot_followup')
    expect(migration).toContain('102_disable_legacy_trade_review_generation')
    expect(routes).toContain("error:'legacy_trade_review_disabled'")
    expect(periodReview).toContain('recoverExpiredPeriodReviewJobs')
    expect(periodReview).toContain("isAiFeatureEnabled('review_generation_enabled'")
    expect(periodReview).toContain("status = 'stale'")
    expect(periodReview).toContain("status = 'revalidation'")
    expect(periodReview).toContain('source_memory_ids_json')
    expect(periodReview).toContain("status = 'revoked'")
    expect(periodReview).toContain('runPeriodReviewDerivationOnce')
    expect(periodReview).toContain('monthlyReviewSourceHash')
    expect(routes).toContain("router.post('/ai/period-reviews/:id/confirm'")
  })
})

describe('period market evidence', () => {
  it('requests the complete day plus Chan lookback without exceeding the review ceiling', () => {
    const start = Date.parse('2026-07-16T21:00:00Z')
    const end = Date.parse('2026-07-17T21:00:00Z')
    expect(requiredReviewCandleCount(start, end, 'M1')).toBe(1642)
    expect(requiredReviewCandleCount(start, end, 'M5')).toBe(490)
    expect(requiredReviewCandleCount(start, end, 'H1')).toBe(226)
    expect(isReviewGridAligned(start + 4 * 3600000, start, 'H4')).toBe(true)
    expect(isReviewGridAligned(start + 3 * 3600000, start, 'H4')).toBe(false)
    const evidenceSource = readFileSync(new URL('../../server/routes/ai/period-market-evidence.js', import.meta.url), 'utf8')
    const bridgeSource = readFileSync(new URL('../../public/ai/aurum_bridge_gui.py', import.meta.url), 'utf8')
    expect(evidenceSource).toContain('start_utc_msc:startUtcMs - CHAN_LOOKBACK_BARS * interval')
    expect(bridgeSource).toContain('copy_rates_range')
  })

  it('detects a long weekday cache gap but tolerates normal maintenance and weekend closure', () => {
    const start = Date.parse('2026-07-13T00:00:00Z')
    const end = Date.parse('2026-07-14T00:00:00Z')
    const complete = Array.from({ length:24 }, (_, hour) => start + hour * 3600000).filter((_, hour) => hour !== 12)
    expect(assessReviewCandleCoverage(complete.map(time_utc_msc => ({ time_utc_msc })), start, end, 'H1').complete).toBe(true)
    const missing = [start, start + 3600000, start + 10 * 3600000, start + 23 * 3600000]
    const coverage = assessReviewCandleCoverage(missing.map(time_utc_msc => ({ time_utc_msc })), start, end, 'H1')
    expect(coverage).toMatchObject({ complete:false, endpoint_complete:true, internal_gap_count:2 })

    const friday = Date.parse('2026-07-17T20:00:00Z')
    const monday = Date.parse('2026-07-20T02:00:00Z')
    expect(assessReviewCandleCoverage([
      { time_utc_msc:friday }, { time_utc_msc:monday - 3600000 },
    ], friday, monday, 'H1')).toMatchObject({ complete:true, internal_gap_count:0 })

    const weekendStart = Date.parse('2026-07-17T23:47:00Z')
    const sundayOpen = Date.parse('2026-07-19T22:00:00Z')
    const mondayEnd = Date.parse('2026-07-20T15:47:00Z')
    expect(assessReviewCandleCoverage([
      { time_utc_msc:sundayOpen }, { time_utc_msc:Date.parse('2026-07-20T15:00:00Z') },
    ], weekendStart, mondayEnd, 'H1')).toMatchObject({ complete:true, endpoint_complete:true })
  })

  it('removes raw daily candles from the monthly digest but preserves structural conclusions', () => {
    const digest = monthlyPeriodMarketDigest([{ id:4, period_key:'2026-07-16', evidence_json:JSON.stringify({ period_market:{ status:'complete', symbols:{ XAUUSD:{ M15:{ status:'complete', candle_count:96, expected_candle_count:96, first_time_utc_msc:1, last_time_utc_msc:2, full_period_candles:[{ t:1 }], summary:{ chan:{ status:'ok', segment_count:3 } } } } } } }) }])
    expect(digest[0].symbols.XAUUSD.M15.summary.chan.segment_count).toBe(3)
    expect(digest[0].symbols.XAUUSD.M15).not.toHaveProperty('full_period_candles')
  })

  it('keeps replay references while removing repeated prompt and candle payloads from each trade', () => {
    const compact = compactPeriodTradeEvidence({ schema_version:2, inference_time:{ signal:{ id:9 }, snapshot:{ id:7,
      system_prompt:'large', user_prompt:'large', market_snapshot:{ large:true }, klines:{ M5:[1,2] }, prompt_hash:'hash', content_hash:'content' },
    risk_decision:{ status:'pass' } }, post_trade:{ outcome:{ id:3 }, post_trade_klines:{ M5:[1,2] }, post_trade_structure:{ M5:{ chan:{ status:'ok' } } } }, evidence_refs:{ inference_snapshot:{ id:7 } } })
    expect(compact.inference_time.snapshot_ref).toMatchObject({ id:7, prompt_hash:'hash', content_hash:'content' })
    expect(compact.inference_time).not.toHaveProperty('snapshot')
    expect(compact.post_trade).not.toHaveProperty('post_trade_klines')
    expect(compact.evidence_refs.inference_snapshot.id).toBe(7)
  })
})
