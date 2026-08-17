import { describe, expect, it } from 'vitest'
import { buildManualTradeMarketEvidence } from '../../server/routes/ai/manual-trade-evidence.js'

const account = { id:12, timezone_offset_minutes:180 }
const strategySnapshot = { market_data_plan:{ primary_timeframe:'M15', timeframes:[{ timeframe:'M15' }] } }

function candles() {
  return [
    { time_utc_msc:1000, close_time_utc_msc:2000 },
    { time_utc_msc:3000, close_time_utc_msc:4000 },
    { time_utc_msc:5000, close_time_utc_msc:6000 },
    { time_utc_msc:7000, close_time_utc_msc:8000 },
    { time_utc_msc:9000, close_time_utc_msc:10000 },
  ]
}

function trade(overrides = {}) {
  return {
    source_identity_hash:'trade-a', symbol:'EURUSD', direction:'buy',
    entry_time_utc_msc:6500, stop_loss:1.09, take_profit:1.2,
    normalized:{ entry_time_utc_msc:6500, deals:[
      { entry_type:0, volume:1, price:1.1, time_utc_msc:6500 },
      { entry_type:1, volume:1, price:1.2, time_utc_msc:9000 },
    ] },
    ...overrides,
  }
}

function path(candleRows = candles()) {
  return { status:'complete', hash:'c'.repeat(64), timeframes:{ M15:{ status:'complete', candles:candleRows } } }
}

describe('manual trade review counterfactual market evidence', () => {
  it('uses an independent cutoff and no real trade deals for each real sequence offset', async () => {
    const calls = []
    const result = await buildManualTradeMarketEvidence({ actor:{ id:7 }, account,
      trades:[trade()], strategySnapshot, buildPath:async input => {
        calls.push(input)
        return path()
      } })
    const source = result.trades['trade-a']
    expect(result.status).toBe('complete')
    expect(source.counterfactual_points_status).toBe('complete')
    expect(source.counterfactual_points.map(point => point.candidate_key)).toEqual([
      'anchor_minus_1', 'anchor', 'anchor_plus_1',
    ])
    expect(source.counterfactual_points.map(point => point.decision_time_utc_msc)).toEqual([4000, 6000, 8000])
    expect(source.counterfactual_points.every(point => point.closed_market_data?.status === 'complete')).toBe(true)

    const candidateCalls = calls.slice(3)
    expect(calls).toHaveLength(6) // pre-entry, outcome, window, then three independent points
    expect(candidateCalls.map(call => call.asOfUtcMsc)).toEqual([4000, 6000, 8000])
    expect(candidateCalls.every(call => call.includeHoldingMetrics === false)).toBe(true)
    expect(candidateCalls.every(call => call.signal.signal_type === 'hold')).toBe(true)
    expect(candidateCalls.every(call => call.signal.stop_loss_price == null && call.signal.take_profit_1_price == null)).toBe(true)
    expect(calls.slice(2).every(call => call.deals.length === 0)).toBe(true)
    expect(source.counterfactual_points[0].allowed_evidence_refs).toEqual(expect.arrayContaining([
      'market:trade-a:counterfactual:anchor_minus_1:M15',
    ]))
    expect(source.counterfactual_points[0].allowed_evidence_refs).not.toContain('market:trade-a:counterfactual:anchor:M15')
  })

  it('fails closed with a stable reason when the real sequence cannot supply all defaults', async () => {
    const short = candles().slice(0, 2)
    const result = await buildManualTradeMarketEvidence({ actor:{ id:7 }, account,
      trades:[trade()], strategySnapshot, buildPath:async () => path(short) })
    expect(result.status).toBe('partial')
    expect(result.reason).toContain('counterfactual_candidate_unavailable')
    expect(result.trades['trade-a']).toMatchObject({
      status:'partial', counterfactual_points_status:'unavailable',
      counterfactual_points_reason:'counterfactual_candidate_unavailable',
    })
  })
})
