import { describe, expect, it } from 'vitest'
import { buildManualTradeMarketEvidence } from '../../server/routes/ai/manual-trade-evidence.js'
import { buildReviewMarketPath } from '../../server/routes/ai/review-market-path.js'

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
    expect(candidateCalls.every(call => call.pathMode === 'cutoff_snapshot')).toBe(true)
    expect(calls.slice(0, 2).every(call => !call.pathMode || call.pathMode === 'trade_path')).toBe(true)
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

  it('composes the real path builder with empty-deal cutoff snapshots', async () => {
    const step = 900_000
    const start = Date.UTC(2026, 7, 20, 0, 0, 0)
    const entry = start + step * 80 + 120_000
    const realRates = Array.from({ length:140 }, (_, index) => {
      const open = 1.1 + index / 100_000
      return { time_utc_msc:start + index * step, open, high:open + 0.001, low:open - 0.001, close:open + 0.0002, tick_volume:100 }
    })
    const realTrade = trade({ entry_time_utc_msc:entry, normalized:{ entry_time_utc_msc:entry, deals:[
      { entry_type:0, volume:1, price:1.1, time_utc_msc:entry },
      { entry_type:1, volume:1, price:1.11, time_utc_msc:start + step * 100 + 120_000 },
    ] } })
    const calls = []
    const result = await buildManualTradeMarketEvidence({ actor:{ id:7 }, account,
      trades:[realTrade], strategySnapshot, buildPath:async input => {
        calls.push(input)
        return buildReviewMarketPath({ ...input,
          loadWindow:async () => ({ rates:realRates, marketMeta:{ timezone_offset_minutes:180, clock_status:'verified',
            continuity_status:'reliable', internal_gap_count:0 } }),
        })
      } })
    expect(result.status).toBe('complete')
    expect(result.trades['trade-a'].counterfactual_points_status).toBe('complete')
    const snapshotCalls = calls.filter(call => call.pathMode === 'cutoff_snapshot')
    expect(snapshotCalls.length).toBe(4)
    expect(snapshotCalls.every(call => call.deals.length === 0 && call.includeHoldingMetrics === false
      && call.signal.signal_type === 'hold')).toBe(true)
    expect(result.trades['trade-a'].counterfactual_points.every(point => {
      const serialized = JSON.stringify(point.market_data)
      return !serialized.includes('net_profit') && !serialized.includes('stop_loss') && !serialized.includes('take_profit')
    })).toBe(true)
  })
})
