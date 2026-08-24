import { beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({ queryAll:vi.fn(), queryOne:vi.fn() }))
const bridge = vi.hoisted(() => ({ mt5Bridge:vi.fn() }))
const bridgeRuntime = vi.hoisted(() => ({ platform:'mt5' }))
vi.mock('../../server/db.js', () => db)
vi.mock('../../server/routes/ai/market-data.js', () => bridge)
vi.mock('../../server/config.js', () => ({ JWT_SECRET:'manual-review-test-secret' }))
vi.mock('../../server/bridge-ws.js', () => ({
  getBridgeRuntimeDiagnostics:() => ({ terminals:[{ terminal_instance_id:'terminal-1', broker_server:'Broker-Demo', login:'1001', platform:bridgeRuntime.platform }] }),
  getHistoryTerminalClock:() => ({ timezone_offset_minutes:180, clock_status:'verified' }),
  resolveHistoryRange:vi.fn(async () => ({ range_start_utc_msc:1, range_end_utc_msc:10_000 })),
}))
vi.mock('../../server/routes/ai/terminal-clock.js', () => ({ trustedTerminalClock:() => true }))
vi.mock('../../server/routes/ai/review-market-path.js', () => ({ buildReviewMarketPath:vi.fn() }))

import { buildEligibleManualTrades, listEligibleManualTrades, readManualTradeEvidence,
  MANUAL_TRADE_LOOKBACK_MSC } from '../../server/routes/ai/manual-trade-evidence.js'
import { createManualTradeSelectionContext } from '../../server/routes/ai/manual-trade-selection-context.js'

const accountRow = { id:5, user_id:7, broker_server:'Broker-Demo', login_account:'1001', observe_status:'active',
  current_user_id:7, current_trading_account_id:5, account_currency:'USD', platform:'mt5' }

const completeSync = { complete:true, requested_range_complete:true, coverage_complete:true,
  clock_status:'verified', timezone_offset_minutes:180 }

function emptyPage(cursor, { nextCursor = null, hasMore = false, sync = completeSync } = {}) {
  return { status:'success', orders:[], deals:[], history_orders:[], history_snapshot_id:'snapshot-1',
    next_cursor:nextCursor, has_more:hasMore, history_sync:{ ...sync }, cursor }
}

function validEvidencePage({ nextCursor = null, hasMore = false, symbol = 'EURUSD' } = {}) {
  return { status:'success', deals:[
    { deal_ticket:`d-${symbol}-1`, order_ticket:`o-${symbol}-1`, position_id:`p-${symbol}`, symbol,
      type:'buy', entry_type:0, magic:0, reason:'client', volume:1, price:1.1, time_utc_msc:1_000 },
    { deal_ticket:`d-${symbol}-2`, order_ticket:`o-${symbol}-2`, position_id:`p-${symbol}`, symbol,
      type:'sell', entry_type:1, magic:0, reason:'client', volume:1, price:1.2, profit:10, time_utc_msc:2_000 },
  ], history_orders:[
    { order_ticket:`o-${symbol}-1`, position_id:`p-${symbol}`, symbol, magic:0, reason:'client', volume_initial:1, price_open:1.1 },
    { order_ticket:`o-${symbol}-2`, position_id:`p-${symbol}`, symbol, magic:0, reason:'client', volume_initial:1, price_open:1.2 },
  ], history_snapshot_id:'snapshot-1', next_cursor:nextCursor, has_more:hasMore, history_sync:{ ...completeSync } }
}

function protectionDeals() {
  return [
    { deal_ticket:'d-protection-1', order_ticket:'2001', position_id:'1001', symbol:'EURUSD',
      type:'buy', entry_type:0, magic:0, reason:'client', volume:1, price:1.1, time_utc_msc:1_000 },
    { deal_ticket:'d-protection-2', order_ticket:'2002', position_id:'1001', symbol:'EURUSD',
      type:'sell', entry_type:1, magic:0, reason:'client', volume:1, price:1.2, profit:10, time_utc_msc:2_000 },
  ]
}

function compactProtectionPage({ stopLoss = 0, takeProfit = 0 } = {}) {
  return {
    status:'success', orders:[
      { order_ticket:'2001', position_id:'1001', symbol:'EURUSD', magic:0, reason:'client', volume_initial:1,
        price_open:1.1, stop_loss:stopLoss, take_profit:takeProfit },
      { order_ticket:'2002', position_id:'1001', symbol:'EURUSD', magic:0, reason:'client', volume_initial:1,
        price_open:1.2, stop_loss:stopLoss, take_profit:takeProfit },
    ], history_snapshot_id:'protection-snapshot', next_cursor:null, has_more:false,
    history_sync:{ ...completeSync },
  }
}

function selectionContextToken(snapshot = 'snapshot-1') {
  return createManualTradeSelectionContext({ userId:7, tradingAccountId:5, platform:'mt5',
    rangeStartUtcMsc:0, rangeEndUtcMsc:10_000, historySnapshotId:snapshot,
    nowUtcMsc:10_000, ttlMsc:900_000 })
}

function reviewCandles() {
  return [
    { time_utc_msc:1, close_time_utc_msc:100 },
    { time_utc_msc:101, close_time_utc_msc:500 },
    { time_utc_msc:501, close_time_utc_msc:1_000 },
    ...Array.from({ length:22 }, (_, index) => ({
      time_utc_msc:1_001 + index * 900_000,
      close_time_utc_msc:2_000 + index * 900_000,
    })),
  ]
}

describe('manual trade review history cursor contract', () => {
  it('uses a bounded rolling 30-day eligible-trade window', () => {
    expect(MANUAL_TRADE_LOOKBACK_MSC).toBe(30 * 24 * 60 * 60 * 1000)
  })

  beforeEach(() => {
    vi.clearAllMocks()
    bridgeRuntime.platform = 'mt5'
    db.queryOne.mockResolvedValue(accountRow)
    db.queryAll.mockResolvedValue([])
    bridge.mt5Bridge.mockImplementation(async (_userId, action) => {
      if (action === 'history_prepare_status_v1') return { status:'success', history_sync:{ requested_range_complete:true } }
      if (action === 'history_page') return {
        status:'success', orders:[{ order_ticket:'o1', position_id:'p1', symbol:'EURUSD', magic:0, reason:'client' }],
        history_snapshot_id:'snapshot-1', next_cursor:'cursor-2', has_more:true,
        history_sync:{ complete:true, requested_range_complete:true, coverage_complete:true, clock_status:'verified', timezone_offset_minutes:180 },
      }
      if (action === 'history_evidence') return {
        status:'success', deals:[
          { deal_ticket:'d1', order_ticket:'o1', position_id:'p1', symbol:'EURUSD', type:'buy', entry_type:0, magic:0, reason:'client', volume:1, price:1.1, time_utc_msc:1_000 },
          { deal_ticket:'d2', order_ticket:'o2', position_id:'p1', symbol:'EURUSD', type:'sell', entry_type:1, magic:0, reason:'client', volume:1, price:1.2, profit:10, time_utc_msc:2_000 },
        ],
        history_orders:[
          { order_ticket:'o1', position_id:'p1', symbol:'EURUSD', magic:0, reason:'client', volume_initial:1, price_open:1.1 },
          { order_ticket:'o2', position_id:'p1', symbol:'EURUSD', magic:0, reason:'client', volume_initial:1, price_open:1.2 },
        ], history_snapshot_id:'evidence-snapshot', next_cursor:'evidence-cursor', has_more:false,
        history_sync:{ complete:true, requested_range_complete:true, coverage_complete:true, clock_status:'verified', timezone_offset_minutes:180 },
      }
      if (action === 'positions') return { status:'success', positions:[] }
      return { status:'error', error:'unexpected_action' }
    })
  })

  it('enriches a compact cursor page by refs without page-number slicing or legacy history', async () => {
    const result = await listEligibleManualTrades({ id:7 }, { page_size:20 }, { nowUtcMsc:10_000 })
    expect(result.unavailable).toBe(false)
    expect(result.trades).toHaveLength(1)
    expect(result.pagination).toMatchObject({ history_snapshot_id:'snapshot-1', next_cursor:'cursor-2', has_more:true })
    const actions = bridge.mt5Bridge.mock.calls.map(([, action]) => action)
    expect(actions).toEqual(['history_prepare_status_v1', 'history_page', 'history_evidence', 'positions'])
    expect(bridge.mt5Bridge.mock.calls[2][2]).toMatchObject({ evidence_position_ids:['p1'], evidence_order_tickets:['o1'] })
  })

  it('sends the exact rolling 30-day range to Bridge', async () => {
    const nowUtcMsc = MANUAL_TRADE_LOOKBACK_MSC + 10_000
    await listEligibleManualTrades({ id:7 }, { page_size:20 }, { nowUtcMsc })
    expect(bridge.mt5Bridge.mock.calls[0][1]).toBe('history_prepare_status_v1')
    expect(bridge.mt5Bridge.mock.calls[0][2]).toMatchObject({
      range_start_utc_msc:10_000,
      range_end_utc_msc:nowUtcMsc,
    })
  })

  it('refreshes the current 30-day SQLite snapshot without invoking legacy full history', async () => {
    const result = await listEligibleManualTrades({ id:7 }, { page_size:20, force_refresh:'1' }, { nowUtcMsc:10_000 })
    expect(result.unavailable).toBe(false)
    expect(bridge.mt5Bridge.mock.calls.map(([, action]) => action)).toEqual([
      'history_prepare_status_v1', 'history_page', 'history_evidence', 'positions',
    ])
    expect(bridge.mt5Bridge.mock.calls.some(([, action]) => action === 'history')).toBe(false)
  })

  it('prepares the frozen recent range before reading its SQLite snapshot', async () => {
    let prepareCalls = 0
    bridge.mt5Bridge.mockImplementation(async (_userId, action) => {
      if (action === 'history_prepare_status_v1') {
        prepareCalls += 1
        return { status:'success', history_sync:{ requested_range_complete:prepareCalls > 1 } }
      }
      if (action === 'history_page') return validEvidencePage()
      if (action === 'positions') return { status:'success', positions:[] }
      return { status:'error', error:'unexpected_action' }
    })

    const result = await listEligibleManualTrades({ id:7 }, { page_size:20 }, { nowUtcMsc:10_000 })
    expect(result.unavailable).toBe(false)
    expect(result.trades).toHaveLength(1)
    expect(bridge.mt5Bridge.mock.calls.map(([, action]) => action)).toEqual([
      'history_prepare_status_v1', 'history_prepare_status_v1', 'history_page', 'positions',
    ])
  })

  it('keeps MT5 fail-closed when prepare status omits the exact range proof', async () => {
    bridge.mt5Bridge.mockImplementation(async (_userId, action) => {
      if (action === 'history_prepare_status_v1') return { status:'success', history_sync:{ complete:true, coverage_complete:true } }
      return { status:'error', error:'unexpected_action' }
    })

    const result = await listEligibleManualTrades({ id:7 }, { page_size:20 }, { nowUtcMsc:10_000 })
    expect(result).toMatchObject({ unavailable:true, evidence_reason:'history_cursor_range_incomplete' })
    expect(bridge.mt5Bridge.mock.calls.map(([, action]) => action)).toEqual(['history_prepare_status_v1'])
  })

  it('falls back to an exact-range MT5 cursor page when prepare status is unsupported', async () => {
    bridge.mt5Bridge.mockImplementation(async (_userId, action) => {
      if (action === 'history_prepare_status_v1') {
        return { status:'error', error:'history_prepare_status_unsupported' }
      }
      if (action === 'history_page') return validEvidencePage()
      if (action === 'positions') return { status:'success', positions:[] }
      return { status:'error', error:'unexpected_action' }
    })

    const result = await listEligibleManualTrades({ id:7 }, { page_size:20 }, { nowUtcMsc:10_000 })
    expect(result).toMatchObject({ unavailable:false, evidence_status:'complete' })
    expect(result.trades).toHaveLength(1)
    expect(bridge.mt5Bridge.mock.calls.map(([, action]) => action)).toEqual([
      'history_prepare_status_v1', 'history_page', 'positions',
    ])
  })

  it('keeps MT5 fail-closed after prepare fallback when the cursor page lacks exact-range proof', async () => {
    bridge.mt5Bridge.mockImplementation(async (_userId, action) => {
      if (action === 'history_prepare_status_v1') {
        return { status:'error', error:'history_prepare_status_unsupported' }
      }
      if (action === 'history_page') {
        return { ...validEvidencePage(), history_sync:{ complete:true, coverage_complete:true,
          clock_status:'verified', timezone_offset_minutes:180 } }
      }
      return { status:'error', error:'unexpected_action' }
    })

    const result = await listEligibleManualTrades({ id:7 }, { page_size:20 }, { nowUtcMsc:10_000 })
    expect(result).toMatchObject({ unavailable:true, evidence_reason:'history_incomplete' })
    expect(bridge.mt5Bridge.mock.calls.map(([, action]) => action)).toEqual([
      'history_prepare_status_v1', 'history_page',
    ])
  })

  it('scans an empty source page and returns the first eligible trade from the same snapshot', async () => {
    let sourcePage = 0
    bridge.mt5Bridge.mockImplementation(async (_userId, action, request) => {
      if (action === 'history_prepare_status_v1') return { status:'success', history_sync:{ requested_range_complete:true } }
      if (action === 'history_page') {
        sourcePage += 1
        if (sourcePage === 1) return emptyPage(null, { nextCursor:'cursor-2', hasMore:true })
        return validEvidencePage({ nextCursor:'cursor-3', hasMore:true })
      }
      if (action === 'positions') return { status:'success', positions:[] }
      return { status:'error', error:'unexpected_action' }
    })

    const result = await listEligibleManualTrades({ id:7 }, { page_size:20 }, { nowUtcMsc:10_000 })
    expect(result.trades).toHaveLength(1)
    expect(result).toMatchObject({ scanned_source_pages:2, skipped_empty_source_pages:1,
      next_cursor:'cursor-3', has_more:true, unavailable:false })
    expect(result.pagination).toMatchObject({ scanned_source_pages:2, skipped_empty_source_pages:1,
      next_cursor:'cursor-3', has_more:true })
    expect(bridge.mt5Bridge.mock.calls.filter(([, action]) => action === 'positions')).toHaveLength(1)
    expect(bridge.mt5Bridge.mock.calls.filter(([, action]) => action === 'history_page')[1][2]).toMatchObject({
      history_snapshot_id:'snapshot-1', cursor:'cursor-2' })
  })

  it('keeps scanning consecutive empty pages until the cursor reaches the end', async () => {
    let sourcePage = 0
    bridge.mt5Bridge.mockImplementation(async (_userId, action) => {
      if (action === 'history_prepare_status_v1') return { status:'success', history_sync:{ requested_range_complete:true } }
      if (action === 'history_page') {
        sourcePage += 1
        return sourcePage < 3
          ? emptyPage(null, { nextCursor:`cursor-${sourcePage + 1}`, hasMore:true })
          : emptyPage(null, { nextCursor:null, hasMore:false })
      }
      if (action === 'positions') return { status:'success', positions:[] }
      return { status:'error', error:'unexpected_action' }
    })

    const result = await listEligibleManualTrades({ id:7 }, { page_size:20 }, { nowUtcMsc:10_000 })
    expect(result).toMatchObject({ scanned_source_pages:3, skipped_empty_source_pages:3,
      next_cursor:null, has_more:false, unavailable:false })
    expect(result.pagination).toMatchObject({ scanned_source_pages:3, skipped_empty_source_pages:3,
      next_cursor:null, has_more:false })
  })

  it('pauses after the bounded raw-page scan and leaves a continuation cursor', async () => {
    let sourcePage = 0
    bridge.mt5Bridge.mockImplementation(async (_userId, action) => {
      if (action === 'history_prepare_status_v1') return { status:'success', history_sync:{ requested_range_complete:true } }
      if (action === 'history_page') {
        sourcePage += 1
        return emptyPage(null, { nextCursor:`cursor-${sourcePage + 1}`, hasMore:true })
      }
      if (action === 'positions') return { status:'success', positions:[] }
      return { status:'error', error:'unexpected_action' }
    })

    const result = await listEligibleManualTrades({ id:7 }, { page_size:20 }, { nowUtcMsc:10_000 })
    expect(result).toMatchObject({ scanned_source_pages:5, skipped_empty_source_pages:5,
      next_cursor:'cursor-6', has_more:true, unavailable:false })
    expect(bridge.mt5Bridge.mock.calls.filter(([, action]) => action === 'history_page')).toHaveLength(5)
  })

  it('fails closed when Bridge repeats a continuation cursor', async () => {
    let sourcePage = 0
    bridge.mt5Bridge.mockImplementation(async (_userId, action) => {
      if (action === 'history_prepare_status_v1') return { status:'success', history_sync:{ requested_range_complete:true } }
      if (action === 'history_page') {
        sourcePage += 1
        return emptyPage(null, { nextCursor:'cursor-2', hasMore:true })
      }
      if (action === 'positions') return { status:'success', positions:[] }
      return { status:'error', error:'unexpected_action' }
    })

    const result = await listEligibleManualTrades({ id:7 }, { page_size:20 }, { nowUtcMsc:10_000 })
    expect(result).toMatchObject({ unavailable:true, error:'manual_trade_review_history_cursor_repeated',
      next_cursor:null, has_more:false, scanned_source_pages:2 })
    expect(bridge.mt5Bridge.mock.calls.filter(([, action]) => action === 'history_page')).toHaveLength(2)
  })

  it('does not scan when the source history is globally incomplete, including MT4 without source completeness proof', async () => {
    bridgeRuntime.platform = 'mt4'
    let sourcePage = 0
    bridge.mt5Bridge.mockImplementation(async (_userId, action) => {
      if (action === 'history_prepare_status_v1') return { status:'error', message:'history_prepare_status_unsupported' }
      if (action === 'history_page') {
        sourcePage += 1
        return emptyPage(null, { nextCursor:'cursor-2', hasMore:true,
          sync:{ ...completeSync, platform:'mt4', history_source_complete:false } })
      }
      if (action === 'positions') return { status:'success', positions:[] }
      return { status:'error', error:'unexpected_action' }
    })

    const result = await listEligibleManualTrades({ id:7 }, { page_size:20 }, { nowUtcMsc:10_000 })
    expect(result).toMatchObject({ unavailable:true, error:'manual_trade_review_evidence_unavailable',
      evidence_reason:'manual_trade_review_mt4_visible_history_unknown', next_cursor:null, has_more:false, scanned_source_pages:1 })
    expect(bridge.mt5Bridge.mock.calls.filter(([, action]) => action === 'history_page')).toHaveLength(1)
  })

  it('does not let evidence enrichment overwrite an MT4 source-completeness failure', async () => {
    bridgeRuntime.platform = 'mt4'
    bridge.mt5Bridge.mockImplementation(async (_userId, action) => {
      if (action === 'history_page') return {
        status:'success', orders:[{ order_ticket:'o1', position_id:'p1', symbol:'EURUSD', magic:0, reason:'client' }],
        history_snapshot_id:'snapshot-1', next_cursor:'cursor-2', has_more:true,
        history_sync:{ ...completeSync, platform:'mt4', history_source_complete:false },
      }
      if (action === 'history_evidence') return {
        ...validEvidencePage({ nextCursor:'cursor-3', hasMore:true }),
        history_sync:{ ...completeSync, platform:'mt4', history_source_complete:true },
      }
      if (action === 'positions') return { status:'success', positions:[] }
      return { status:'error', error:'unexpected_action' }
    })

    const result = await listEligibleManualTrades({ id:7 }, { page_size:20 }, { nowUtcMsc:10_000 })
    expect(result).toMatchObject({ unavailable:true, error:'manual_trade_review_evidence_unavailable',
      evidence_reason:'manual_trade_review_mt4_visible_history_unknown', next_cursor:null, has_more:false })
    expect(bridge.mt5Bridge.mock.calls.map(([, action]) => action)).toEqual([
      'history_prepare_status_v1', 'history_page', 'history_evidence',
    ])
  })

  it('admits MT4 terminal-visible history while preserving that it is not broker-wide history', async () => {
    bridgeRuntime.platform = 'mt4'
    bridge.mt5Bridge.mockImplementation(async (_userId, action) => {
      if (action === 'history_prepare_status_v1') return { status:'error', message:'history_prepare_status_unsupported' }
      if (action === 'history_page') return {
        ...validEvidencePage(),
        history_sync:{ ...completeSync, platform:'mt4', requested_range_complete:false,
          terminal_visible_history_complete:true, history_source_complete:false },
      }
      if (action === 'positions') return { status:'success', positions:[] }
      return { status:'error', error:'unexpected_action' }
    })

    const result = await listEligibleManualTrades({ id:7 }, { page_size:20 }, { nowUtcMsc:10_000 })
    expect(result).toMatchObject({ unavailable:false, evidence_status:'complete',
      history_source_limited:true })
    expect(result.history_scope_note).toContain('MT4')
    expect(result.history_scope_note).toContain('全部历史')
    expect(result.trades).toHaveLength(1)
    expect(bridge.mt5Bridge.mock.calls.map(([, action]) => action)).toEqual([
      'history_prepare_status_v1', 'history_page', 'positions',
    ])
  })

  it('applies user filters while scanning source pages and still fetches positions once', async () => {
    let sourcePage = 0
    bridge.mt5Bridge.mockImplementation(async (_userId, action) => {
      if (action === 'history_prepare_status_v1') return { status:'success', history_sync:{ requested_range_complete:true } }
      if (action === 'history_page') {
        sourcePage += 1
        return sourcePage === 1
          ? validEvidencePage({ nextCursor:'cursor-2', hasMore:true, symbol:'EURUSD' })
          : validEvidencePage({ nextCursor:null, hasMore:false, symbol:'GBPUSD' })
      }
      if (action === 'positions') return { status:'success', positions:[] }
      return { status:'error', error:'unexpected_action' }
    })

    const result = await listEligibleManualTrades({ id:7 }, { page_size:20, symbol:'GBPUSD' }, { nowUtcMsc:10_000 })
    expect(result.trades).toHaveLength(1)
    expect(result.trades[0].symbol).toBe('GBPUSD')
    expect(result).toMatchObject({ scanned_source_pages:2, skipped_empty_source_pages:1, has_more:false })
    expect(bridge.mt5Bridge.mock.calls.filter(([, action]) => action === 'positions')).toHaveLength(1)
  })

  it('keeps the source hash stable when compact protection zeros become missing evidence values', async () => {
    const compact = compactProtectionPage()
    const evidenceWithoutOrders = {
      status:'success', deals:protectionDeals(), history_snapshot_id:'protection-snapshot',
      history_sync:{ ...completeSync },
    }
    const evidenceWithMissingProtections = {
      ...evidenceWithoutOrders,
      history_orders:[
        { order_ticket:'2001', position_id:'1001', symbol:'EURUSD', magic:0, reason:'client', volume_initial:1, price_open:1.1 },
        { order_ticket:'2002', position_id:'1001', symbol:'EURUSD', magic:0, reason:'client', volume_initial:1,
          price_open:1.2, stop_loss:null, take_profit:'' },
      ],
    }
    let evidenceCalls = 0
    bridge.mt5Bridge.mockImplementation(async (_userId, action) => {
      if (action === 'history_prepare_status_v1') return { status:'success', history_sync:{ requested_range_complete:true } }
      if (action === 'history_page') return compact
      if (action === 'history_evidence') return evidenceCalls++ === 0 ? evidenceWithoutOrders : evidenceWithMissingProtections
      if (action === 'positions') return { status:'success', positions:[] }
      return { status:'error', error:'unexpected_action' }
    })

    const listed = await listEligibleManualTrades({ id:7 }, { page_size:20 }, { nowUtcMsc:10_000 })
    expect(listed).toMatchObject({ unavailable:false, trades:[{ position_id:'1001', entry_order_ticket:'2001' }] })
    const selected = listed.trades[0]
    const readAccount = { ...accountRow, terminal_instance_id:'terminal-1', platform:'mt5',
      route:{ terminal_instance_id:'terminal-1', account_ref:{ broker_server:'Broker-Demo', login:'1001' } } }
    const reread = await readManualTradeEvidence({ id:7 }, readAccount, [{
      trade_id:selected.trade_id, source_identity_hash:selected.source_identity_hash,
      trade_source_hash:selected.trade_source_hash, position_id:selected.position_id,
      entry_order_ticket:selected.entry_order_ticket,
    }], {
      strategySnapshot:{ market_data_plan:{ timeframes:[{ timeframe:'M15' }] } },
      // The context was issued at 10_000; advancing the caller clock must not
      // silently recompute a new seven-day range.
      buildPath:async () => ({ status:'complete' }), nowUtcMsc:20_000,
      selection_context_token:listed.selection_context_token,
    })
    expect(reread.trades[0].trade_source_hash).toBe(selected.trade_source_hash)
    expect(reread.trades[0]).toMatchObject({ stop_loss:null, take_profit:null })
    const evidenceCall = bridge.mt5Bridge.mock.calls.filter(([, action]) => action === 'history_evidence').at(-1)
    expect(evidenceCall?.[2]).toMatchObject({ history_snapshot_id:'protection-snapshot', range_start_utc_msc:0, range_end_utc_msc:10_000 })
  })

  it('preserves positive stop-loss and take-profit values during normalization', () => {
    const page = compactProtectionPage({ stopLoss:1.05, takeProfit:1.2 })
    const result = buildEligibleManualTrades({
      ...page, deals:protectionDeals(), history_orders:page.orders,
    }, { account:accountRow, positions:[], systemReferences:new Map() })
    expect(result.trades[0]).toMatchObject({ stop_loss:1.05, take_profit:1.2 })
  })

  it('re-reads a selected position through history evidence without accepting empty references', async () => {
    const history = validEvidencePage()
    history.deals = history.deals.map((row, index) => ({ ...row, order_ticket:`${2001 + index}`, position_id:'1001' }))
    history.history_orders = history.history_orders.map((row, index) => ({ ...row, order_ticket:`${2001 + index}`, position_id:'1001' }))
    bridge.mt5Bridge.mockImplementation(async (_userId, action) => {
      if (action === 'history_prepare_status_v1') return { status:'success', history_sync:{ requested_range_complete:true } }
      if (action === 'history_evidence') return history
      if (action === 'positions') return { status:'success', positions:[] }
      return { status:'error', error:'unexpected_action' }
    })
    const eligible = buildEligibleManualTrades(history, { account:accountRow, positions:[], systemReferences:new Map() }).trades[0]
    const result = await readManualTradeEvidence({ id:7 }, accountRow, [{
      trade_id:eligible.trade_id, source_identity_hash:eligible.source_identity_hash,
      trade_source_hash:eligible.trade_source_hash, position_id:eligible.position_id,
      entry_order_ticket:eligible.entry_order_ticket,
    }], {
      strategySnapshot:{ market_data_plan:{ timeframes:[{ timeframe:'M15' }] } },
      buildPath:async () => ({ status:'complete', timeframes:{ M15:{ status:'complete', candles:reviewCandles() } } }),
      nowUtcMsc:10_000,
      selection_context_token:selectionContextToken(history.history_snapshot_id),
    })
    const evidenceCall = bridge.mt5Bridge.mock.calls.find(([, action]) => action === 'history_evidence')
    expect(result).toMatchObject({ evidence_status:'complete', trades:[{ source_identity_hash:eligible.source_identity_hash }] })
    expect(evidenceCall?.[2]).toMatchObject({ evidence_position_ids:[eligible.position_id], evidence_order_tickets:[] })
  })

  it('re-reads an order-only selection through entry order evidence', async () => {
    const history = validEvidencePage()
    history.deals = history.deals.map(row => ({ ...row, order_ticket:'2001', position_id:null }))
    history.history_orders = history.history_orders.map(row => ({ ...row, order_ticket:'2001', position_id:null }))
    bridge.mt5Bridge.mockImplementation(async (_userId, action) => {
      if (action === 'history_prepare_status_v1') return { status:'success', history_sync:{ requested_range_complete:true } }
      if (action === 'history_evidence') return history
      if (action === 'positions') return { status:'success', positions:[] }
      return { status:'error', error:'unexpected_action' }
    })
    const eligible = buildEligibleManualTrades(history, { account:accountRow, positions:[], systemReferences:new Map() }).trades[0]
    await readManualTradeEvidence({ id:7 }, accountRow, [{
      trade_id:eligible.trade_id, source_identity_hash:eligible.source_identity_hash,
      trade_source_hash:eligible.trade_source_hash, position_id:null,
      entry_order_ticket:eligible.entry_order_ticket,
    }], {
      strategySnapshot:{ market_data_plan:{ timeframes:[{ timeframe:'M15' }] } },
      buildPath:async () => ({ status:'complete' }), nowUtcMsc:10_000,
      selection_context_token:selectionContextToken(history.history_snapshot_id),
    })
    const evidenceCall = bridge.mt5Bridge.mock.calls.find(([, action]) => action === 'history_evidence')
    expect(evidenceCall?.[2]).toMatchObject({ evidence_position_ids:[], evidence_order_tickets:[eligible.entry_order_ticket] })
  })

  it('fails closed when the Bridge evidence snapshot changes after selection', async () => {
    const history = validEvidencePage()
    history.history_snapshot_id = 'snapshot-after-refresh'
    bridge.mt5Bridge.mockImplementation(async (_userId, action) => {
      if (action === 'history_prepare_status_v1') return { status:'success', history_sync:{ requested_range_complete:true } }
      if (action === 'history_evidence') return history
      if (action === 'positions') return { status:'success', positions:[] }
      return { status:'error', error:'unexpected_action' }
    })
    const eligible = buildEligibleManualTrades(history, { account:accountRow, positions:[], systemReferences:new Map() }).trades[0]
    await expect(readManualTradeEvidence({ id:7 }, accountRow, [{
      trade_id:eligible.trade_id, source_identity_hash:eligible.source_identity_hash,
      trade_source_hash:eligible.trade_source_hash, position_id:'1001', entry_order_ticket:'2001',
    }], {
      strategySnapshot:{ market_data_plan:{ timeframes:[{ timeframe:'M15' }] } }, nowUtcMsc:10_000,
      selection_context_token:selectionContextToken('snapshot-selected'),
    })).rejects.toThrow('manual_trade_review_history_snapshot_changed')
  })

  it('accepts the native history evidence response when it omits a snapshot id', async () => {
    const history = validEvidencePage()
    delete history.history_snapshot_id
    bridge.mt5Bridge.mockImplementation(async (_userId, action) => {
      if (action === 'history_prepare_status_v1') return { status:'success', history_sync:{ requested_range_complete:true } }
      if (action === 'history_evidence') return history
      if (action === 'positions') return { status:'success', positions:[] }
      return { status:'error', error:'unexpected_action' }
    })
    const eligible = buildEligibleManualTrades(history, { account:accountRow, positions:[], systemReferences:new Map() }).trades[0]
    const result = await readManualTradeEvidence({ id:7 }, accountRow, [{
      trade_id:eligible.trade_id, source_identity_hash:eligible.source_identity_hash,
      trade_source_hash:eligible.trade_source_hash, position_id:'1001', entry_order_ticket:'2001',
    }], {
      strategySnapshot:{ market_data_plan:{ timeframes:[{ timeframe:'M15' }] } },
      buildPath:async () => ({ status:'complete', timeframes:{ M15:{ status:'complete', candles:reviewCandles() } } }), nowUtcMsc:10_000,
      selection_context_token:selectionContextToken('snapshot-selected'),
    })
    expect(result).toMatchObject({ evidence_status:'complete', trades:[{ source_identity_hash:eligible.source_identity_hash }] })
  })

  it('rejects a native response without a snapshot id when a selected source hash changes', async () => {
    const selectedHistory = validEvidencePage()
    const changedHistory = validEvidencePage()
    delete changedHistory.history_snapshot_id
    changedHistory.deals = changedHistory.deals.map((deal, index) => index === 1 ? { ...deal, profit:11 } : deal)
    bridge.mt5Bridge.mockImplementation(async (_userId, action) => {
      if (action === 'history_prepare_status_v1') return { status:'success', history_sync:{ requested_range_complete:true } }
      if (action === 'history_evidence') return changedHistory
      if (action === 'positions') return { status:'success', positions:[] }
      return { status:'error', error:'unexpected_action' }
    })
    const eligible = buildEligibleManualTrades(selectedHistory, { account:accountRow, positions:[], systemReferences:new Map() }).trades[0]
    await expect(readManualTradeEvidence({ id:7 }, accountRow, [{
      trade_id:eligible.trade_id, source_identity_hash:eligible.source_identity_hash,
      trade_source_hash:eligible.trade_source_hash, position_id:'1001', entry_order_ticket:'2001',
    }], {
      strategySnapshot:{ market_data_plan:{ timeframes:[{ timeframe:'M15' }] } }, nowUtcMsc:10_000,
      selection_context_token:selectionContextToken('snapshot-selected'),
    })).rejects.toThrow('manual_trade_review_source_changed')
  })

  it('rejects a native response without a snapshot id when a selected trade is missing', async () => {
    const selectedHistory = validEvidencePage()
    const missingHistory = validEvidencePage()
    delete missingHistory.history_snapshot_id
    missingHistory.deals = missingHistory.deals.slice(0, 1)
    bridge.mt5Bridge.mockImplementation(async (_userId, action) => {
      if (action === 'history_prepare_status_v1') return { status:'success', history_sync:{ requested_range_complete:true } }
      if (action === 'history_evidence') return missingHistory
      if (action === 'positions') return { status:'success', positions:[] }
      return { status:'error', error:'unexpected_action' }
    })
    const eligible = buildEligibleManualTrades(selectedHistory, { account:accountRow, positions:[], systemReferences:new Map() }).trades[0]
    await expect(readManualTradeEvidence({ id:7 }, accountRow, [{
      trade_id:eligible.trade_id, source_identity_hash:eligible.source_identity_hash,
      trade_source_hash:eligible.trade_source_hash, position_id:'1001', entry_order_ticket:'2001',
    }], {
      strategySnapshot:{ market_data_plan:{ timeframes:[{ timeframe:'M15' }] } }, nowUtcMsc:10_000,
      selection_context_token:selectionContextToken('snapshot-selected'),
    })).rejects.toThrow('manual_trade_review_source_changed')
  })

  it('rejects empty evidence references before any Bridge call', async () => {
    const hash = 'a'.repeat(64)
    bridge.mt5Bridge.mockClear()
    await expect(readManualTradeEvidence({ id:7 }, accountRow, [{
      trade_id:hash, source_identity_hash:hash, trade_source_hash:'b'.repeat(64),
    }])).rejects.toThrow('manual_trade_review_selection_reference_invalid')
    expect(bridge.mt5Bridge).not.toHaveBeenCalled()
  })
})
