import { describe, expect, it } from 'vitest'
import { buildEligibleManualTrades, buildManualTradeMarketEvidence, collectManualTradeEvidenceRefs, isTrustedManualTradeClock, normalizedTradeHash } from '../../server/routes/ai/manual-trade-evidence.js'

const account = {
  terminal_instance_id:'terminal-1', broker_server:'Broker-Demo', login_account:'1001',
  platform:'mt5', timezone_offset_minutes:180,
}

function payload(overrides = {}) {
  return {
    history_sync:{ complete:true, requested_range_complete:true, coverage_complete:true,
      evidence_truncated:false, clock_status:'verified', timezone_offset_minutes:180 },
    deals:[
      { deal_ticket:'d1', order_ticket:'o1', position_id:'p1', symbol:'EURUSD', type:'buy', entry:'in', magic:0,
        reason:'client', volume:1, price:1.1, time_utc_msc:1_000, commission:-0.1 },
      { deal_ticket:'d2', order_ticket:'o2', position_id:'p1', symbol:'EURUSD', type:'sell', entry:'out', magic:0,
        reason:'client', volume:1, price:1.2, time_utc_msc:2_000, profit:10, commission:-0.1 },
    ],
    history_orders:[
      { order_ticket:'o1', position_id:'p1', symbol:'EURUSD', magic:0, reason:'client', volume_initial:1,
        price_open:1.1, stop_loss:1.05, take_profit:1.2 },
      { order_ticket:'o2', position_id:'p1', symbol:'EURUSD', magic:0, reason:'client', volume_initial:1 },
    ],
    ...overrides,
  }
}

describe('manual trade evidence admission', () => {
  it('admits a profitable fully closed trade whose entry order is not bound to a platform signal', () => {
    const result = buildEligibleManualTrades(payload(), { account, positions:[], systemReferences:new Map() })
    expect(result.evidence_status).toBe('complete')
    expect(result.trades).toHaveLength(1)
    expect(result.trades[0]).toMatchObject({ symbol:'EURUSD', direction:'buy', position_id:'p1', volume:1 })
    expect(result.trades[0].trade_source_hash).toBe(normalizedTradeHash(result.trades[0].normalized))
    expect(result.trades[0].manual_classification).toMatchObject({ source:'unbound_platform_signal', magic_values:[0], reasons:['client'], system_association:{ linked:false, matched_refs:[] } })
  })

  it('fails closed for incomplete history or an untrusted terminal clock', () => {
    expect(isTrustedManualTradeClock({ clock_status:'unknown', timezone_offset_minutes:180 })).toBe(false)
    expect(buildEligibleManualTrades(payload({ history_sync:{ complete:true, requested_range_complete:true,
      clock_status:'unknown', timezone_offset_minutes:180 } }), { account }))
      .toMatchObject({ trades:[], evidence_status:'unavailable', evidence_reason:'clock_untrusted' })
    expect(buildEligibleManualTrades(payload({ history_sync:{ complete:false, requested_range_complete:false,
      clock_status:'verified', timezone_offset_minutes:180 } }), { account }))
      .toMatchObject({ trades:[], evidence_status:'unavailable', evidence_reason:'history_incomplete' })
  })

  it('accepts a proven recent range while account-wide history is still backfilling', () => {
    const result = buildEligibleManualTrades(payload({ history_sync:{
      complete:false, requested_range_complete:true, coverage_complete:false,
      backfill_pending:true, evidence_truncated:false, clock_status:'verified', timezone_offset_minutes:180,
    } }), { account, positions:[], systemReferences:new Map() })
    expect(result.evidence_status).toBe('complete')
    expect(result.trades).toHaveLength(1)
  })

  it('admits MT4 only with explicit terminal-visible completion and preserves the limited source boundary', () => {
    const mt4Payload = payload({ history_sync:{
      platform:'mt4', requested_range_complete:false, terminal_visible_history_complete:true,
      history_source_complete:false, evidence_truncated:false,
      clock_status:'verified', timezone_offset_minutes:180,
    } })
    const accepted = buildEligibleManualTrades(mt4Payload,
      { account:{ ...account, platform:'mt4' }, positions:[], systemReferences:new Map() })
    expect(accepted).toMatchObject({ evidence_status:'complete', history_sync:{
      platform:'mt4', terminal_visible_history_complete:true, history_source_complete:false,
    } })
    expect(accepted.trades).toHaveLength(1)

    for (const terminalVisible of [false, undefined]) {
      const historySync = { ...mt4Payload.history_sync }
      if (terminalVisible === undefined) delete historySync.terminal_visible_history_complete
      else historySync.terminal_visible_history_complete = terminalVisible
      expect(buildEligibleManualTrades(payload({ history_sync:historySync }),
        { account:{ ...account, platform:'mt4' } })).toMatchObject({
          evidence_status:'unavailable',
          evidence_reason:terminalVisible === false
            ? 'manual_trade_review_mt4_visible_history_incomplete'
            : 'manual_trade_review_mt4_visible_history_unknown',
        })
    }
  })

  it('does not accept MT5 global flags without the exact requested-range proof', () => {
    expect(buildEligibleManualTrades(payload({ history_sync:{
      platform:'mt5', complete:true, coverage_complete:true, evidence_truncated:false,
      clock_status:'verified', timezone_offset_minutes:180,
    } }), { account })).toMatchObject({ evidence_status:'unavailable', evidence_reason:'history_incomplete' })
  })

  it('accepts an empty proven range without requiring an unrelated live clock', () => {
    const result = buildEligibleManualTrades({
      history_sync:{ requested_range_complete:true, evidence_truncated:false },
      deals:[], history_orders:[], trades:[],
    }, { account:{ ...account, timezone_offset_minutes:null }, positions:[], systemReferences:new Map() })
    expect(result).toMatchObject({ evidence_status:'complete', trades:[], excluded:[] })
  })

  it('uses consistent persisted UTC/server timestamps when the live clock field is absent', () => {
    const withHistoricalClock = payload({
      history_sync:{ requested_range_complete:true, evidence_truncated:false },
      deals:payload().deals.map(row => ({ ...row, time_server_msc:row.time_utc_msc + 180 * 60_000 })),
      history_orders:payload().history_orders.map((row, index) => ({ ...row,
        time_utc_msc:(index + 1) * 1_000, time_server_msc:(index + 1) * 1_000 + 180 * 60_000 })),
    })
    const result = buildEligibleManualTrades(withHistoricalClock,
      { account:{ ...account, timezone_offset_minutes:null }, positions:[], systemReferences:new Map() })
    expect(result.trades).toHaveLength(1)
    expect(result).toMatchObject({ timezone_offset_minutes:180, clock_status:'history_record_verified' })
  })

  it('excludes partial closes, open positions, losing trades, and signal-bound entry orders', () => {
    const partial = payload({ deals:[
      { deal_ticket:'d1', order_ticket:'o1', position_id:'p1', symbol:'EURUSD', type:'buy', entry:'in', magic:0, reason:'client', volume:1, price:1.1, time_utc_msc:1_000 },
      { deal_ticket:'d2', order_ticket:'o2', position_id:'p1', symbol:'EURUSD', type:'sell', entry:'out', magic:0, reason:'client', volume:.5, price:1.2, time_utc_msc:2_000 },
    ] })
    expect(buildEligibleManualTrades(partial, { account })).toMatchObject({ trades:[] })
    expect(buildEligibleManualTrades(payload(), { account, positions:[{ position_id:'p1', volume:1 }] }).excluded[0].reason).toContain('position_open')
    expect(buildEligibleManualTrades(payload({ deals:payload().deals.map(row => ({ ...row, profit:0, commission:0 })) }), { account }).excluded[0].reason).toContain('not_profitable')
    expect(buildEligibleManualTrades(payload(), { account, systemReferences:new Map([['o1', { id:9 }]]) }).excluded[0].reason).toContain('system_association')
  })

  it('keeps Magic and broker reason as audit metadata rather than source admission rules', () => {
    const noMagicOrder = payload({ history_orders:[{ order_ticket:'o1', position_id:'p1', symbol:'EURUSD', reason:'client', volume_initial:1 }] })
    expect(buildEligibleManualTrades(noMagicOrder, { account }).trades).toHaveLength(1)
    const expertMagicZero = payload({ deals:payload().deals.map(row => ({ ...row, reason:'Expert Advisor' })) })
    expect(buildEligibleManualTrades(expertMagicZero, { account }).trades).toHaveLength(1)
    expect(buildEligibleManualTrades(expertMagicZero, { account }).trades[0].manual_classification.expert_reason).toBe(true)
  })

  it('builds bounded frozen market paths from the strategy plan and canonical deal timestamps', async () => {
    const trade = buildEligibleManualTrades(payload(), { account }).trades[0]
    const calls = []
    const market = await buildManualTradeMarketEvidence({ actor:{ id:7 }, account, trades:[trade],
      strategySnapshot:{ market_data_plan:{ primary_timeframe:'M15', timeframes:[
        { timeframe:'M15' }, { timeframe:'H1' }, { timeframe:'H4' }, { timeframe:'D1' }, { timeframe:'M1' },
      ] } },
      buildPath:async input => { calls.push(input); return { status:'complete', timeframes:{ M15:{ status:'complete' } } } },
    })
    expect(market.status).toBe('complete')
    expect(Object.keys(market.trades)).toHaveLength(1)
    expect(calls).toHaveLength(2)
    expect(calls[0].snapshot.klines).toEqual({ M15:[], H1:[], H4:[], D1:[] })
    expect(calls[0].deals[0]).toMatchObject({ entry_type:0, volume:1, price:1.1 })
    expect(JSON.parse(calls[0].deals[0].raw_json)).toMatchObject({ time_utc_msc:1000 })
    expect(calls[0].chanRequirement).toMatchObject({ status:'disabled', timeframes:[] })
  })

  it('passes the frozen Chan requirement into both review stages and fails closed when it is incomplete', async () => {
    const trade = buildEligibleManualTrades(payload(), { account }).trades[0]
    const calls = []
    const market = await buildManualTradeMarketEvidence({ actor:{ id:7 }, account, trades:[trade],
      strategySnapshot:{ version:8, use_chan_analysis:true, market_data_plan:{ primary_timeframe:'M15',
        timeframes:[{ timeframe:'M15' }, { timeframe:'H1' }] } },
      buildPath:async input => {
        calls.push(input)
        return { status:'complete', timeframes:{
          M15:{ status:'complete', chan:{ status:'complete' } },
          H1:{ status:'complete', chan:{ status:calls.length === 1 ? 'complete' : 'partial' } },
        } }
      },
    })
    expect(calls).toHaveLength(2)
    expect(calls.every(call => call.chanRequirement.status === 'enabled')).toBe(true)
    expect(calls[0].chanRequirement.timeframes).toEqual(['M15', 'H1'])
    expect(market).toMatchObject({ status:'partial', reason:expect.stringContaining('chan_evidence_incomplete') })
  })

  it('fails closed instead of accepting more than one trade', async () => {
    const trades = Array.from({ length:2 }, (_, index) => ({ source_identity_hash:`source-${index}`, symbol:'EURUSD', direction:'buy' }))
    const market = await buildManualTradeMarketEvidence({ actor:{ id:7 }, account, trades,
      strategySnapshot:{ market_data_plan:{ timeframes:[{ timeframe:'M15' }] } }, buildPath:viablePath })
    expect(market).toMatchObject({ status:'unavailable', reason:'selection_limit_exceeded' })
  })

  it('collects system-association references from trades, deals, history orders, and page orders', () => {
    expect(collectManualTradeEvidenceRefs({
      trades:[{ position_id:'p-trade', ticket:'t-trade' }],
      deals:[{ deal_ticket:'d-deal', order_ticket:'o-deal' }],
      history_orders:[{ order:'o-history' }], orders:[{ pending_ticket:'p-order' }],
    })).toEqual(expect.arrayContaining(['p-trade', 't-trade', 'd-deal', 'o-deal', 'o-history', 'p-order']))
  })
})

async function viablePath() { return { status:'complete' } }
