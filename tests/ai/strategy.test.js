import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { attachAtrAnchor, buildStrategyContextFromTags, chanNeedsMoreHistory, loadPrivatePortfolioContext, resolveChanHistoryCount, shouldPersistChanAnchor, __strategyTest } from '../../server/routes/ai/strategy.js'

const mockMt5Bridge = vi.fn()
vi.mock('../../server/routes/ai/market-data.js', () => ({
  mt5Bridge: (...args) => mockMt5Bridge(...args),
  platformRates: (userId, params) => mockMt5Bridge(userId, 'rates', params),
  computeAtr14: vi.fn(() => 12),
  calculateMarketData: vi.fn((symbol, timeframe, rates, _account, _positions, options = {}) => ({
    symbol, timeframe,
    latest_price: 2000, price_change: 10, price_change_pct: 0.5,
    sma_20: 1995, sma_50: 1990, ema_12: 1998, ema_26: 1992,
    atr_14: 10, volatility_pct: 0.3,
    macd: { line: 5, signal: 3, histogram: 2, trend: 'bullish' },
    rsi_14: 55, bollinger: { upper: 2010, lower: 1990, width: 20, position: 0.5 },
    support_resistance: { pivot: 2000, r1: 2005, s1: 1995 },
    kline_patterns: { last_candle: { is_doji: false } },
    volume: { current: 100, average: 80, ratio: 1.25 },
    strategy_score: { trend_strength: 0.6, momentum_alignment: 1, data_confidence: 0.7 },
    kline_count: rates.length, positions: { total_positions: 0, details: [] },
    account: { balance: 10000, equity: 10500 },
    ...(options.computeChan ? { chan: {
      source_history_count: rates.length,
      segment_count: rates[0]?.chan_segment_count ?? (rates.length >= Number(options.chanMaximumHistoryCount || 0) ? 1 : 0),
      center_count: rates[0]?.chan_center_count ?? (rates.length >= Number(options.chanMaximumHistoryCount || 0) ? 1 : 0),
      latest_center: rates[0]?.chan_center_count > 0 ? {
        entry_segment_stable_id: rates[0]?.chan_entry_segment_stable_id ?? null,
        entry_segment_id: rates[0]?.chan_entry_segment_id ?? null,
      } : null,
      raw_structure_marker: rates[0]?.chan_marker ?? null,
      structure_anchor: {
        requested_time_utc_msc: rates[0]?.chan_requested_anchor_time_utc_msc ?? null,
        matched: rates[0]?.chan_anchor_matched === true,
        recommended_time_utc_msc: rates[0]?.chan_recommended_anchor_time_utc_msc ?? null,
      },
    } } : {}),
  })),
}))

describe('buildStrategyContextFromTags', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    __strategyTest.clearChanHistoryHints()
    mockMt5Bridge.mockResolvedValue({ rates: Array(100).fill({ time: '2026-01-01', open: '2000', high: '2010', low: '1990', close: '2005', tick_volume: '100' }) })
  })

  it('解析标签并构建策略上下文', async () => {
    const prompt = '分析 {{MTF:M5:100}} {{MTF:H1:80}}'
    const result = await buildStrategyContextFromTags(
      1, 'XAUUSD', { balance: 10000 }, [], prompt, 'M5', [], 'manual'
    )
    expect(result.strategy_sequence).toContain('M5')
    expect(result.required_timeframes).toContain('M5')
    expect(result.timeframes).toHaveProperty('M5')
    expect(result.timeframes).toHaveProperty('H1')
  })

  it('无标签时使用 fallback', async () => {
    const result = await buildStrategyContextFromTags(
      1, 'XAUUSD', { balance: 10000 }, [], '', 'M5', [], 'manual'
    )
    expect(result.timeframes).toHaveProperty('M5')
  })

  it('使用已有数据时跳过 Bridge 调用', async () => {
    const rates = Array(100).fill({ time: '2026-01-01', open: '2000', high: '2010', low: '1990', close: '2005', tick_volume: '100' })
    const prompt = '分析 {{MTF:M5:100}}'
    await buildStrategyContextFromTags(
      1, 'XAUUSD', { balance: 10000 }, [], prompt, 'M5', rates, 'manual'
    )
    expect(mockMt5Bridge).not.toHaveBeenCalled()
  })

  it('已有2000根缠论回退数据时不会重复请求2000根', async () => {
    const rates = Array.from({ length: 1800 }, (_, i) => ({ time: `t${i}`, open: '2000', high: '2010', low: '1990', close: '2005', tick_volume: '100' }))
    await buildStrategyContextFromTags(
      1, 'XAUUSD', { balance: 10000 }, [], '分析 {{MTF:H1:80}} {{USE_CHAN}}', 'H1', rates, 'manual'
    )
    expect(mockMt5Bridge).not.toHaveBeenCalled()
  })

  it('时间框架数据通过 Bridge 获取', async () => {
    const prompt = '分析 {{MTF:H1:80}}'
    await buildStrategyContextFromTags(
      1, 'XAUUSD', { balance: 10000 }, [], prompt, 'M5', [], 'manual'
    )
    expect(mockMt5Bridge).toHaveBeenCalledWith(1, 'rates', expect.objectContaining({ timeframe: 'H1' }))
  })

  it('缠论使用固定周期目标历史但模型K线保持标签数量', async () => {
    const rates = Array.from({ length: 1800 }, (_, i) => ({ time: `t${i}`, open: '2000', high: '2010', low: '1990', close: '2005', tick_volume: '100' }))
    mockMt5Bridge.mockResolvedValueOnce({ rates })
    const result = await buildStrategyContextFromTags(
      1, 'XAUUSD', { balance: 10000 }, [], '分析 {{MTF:H1:80}} {{USE_CHAN}}', 'M5', [], 'manual'
    )
    expect(mockMt5Bridge).toHaveBeenCalledWith(1, 'rates', expect.objectContaining({ timeframe: 'H1', count: 1800 }))
    expect(result.timeframes.H1.klines).toHaveLength(80)
    expect(result.timeframes.H1.klines[0].time).toBe('t1720')
    expect(result.visualization_klines.H1).toHaveLength(1800)
    expect(result.visualization_klines.H1[0].time).toBe('t0')
    expect(JSON.stringify(result)).not.toContain('visualization_klines')
  })

  it('直接传递各周期原始缠论结构且不生成跨周期汇总字段', async () => {
    const rates = Array.from({ length:1800 }, (_, i) => ({
      time:`raw-${i}`, open:'2000', high:'2010', low:'1990', close:'2005', tick_volume:'100',
      chan_marker:'M5-raw-structure',
    }))
    const result = await buildStrategyContextFromTags(
      1, 'XAUUSD', { balance:10000 }, [], '分析 {{MTF:M5:100}} {{USE_CHAN}}', 'M5', rates, 'manual'
    )
    expect(result.timeframes.M5.summary.chan).toMatchObject({ raw_structure_marker:'M5-raw-structure' })
    expect(result.timeframes.M5.summary).not.toHaveProperty('chan_timeframe_alignment')
    expect(result).not.toHaveProperty('chan_timeframe_alignment')
  })

  it('固定目标历史不足时不旁路重试或扩容', async () => {
    const rates300 = Array.from({ length: 300 }, (_, i) => ({ time: `a${i}`, open: '2000', high: '2010', low: '1990', close: '2005', tick_volume: '100' }))
    mockMt5Bridge.mockResolvedValueOnce({ rates: rates300 })
    const result = await buildStrategyContextFromTags(
      1, 'XAUUSD', { balance: 10000 }, [], '分析 {{MTF:H1:80}} {{USE_CHAN}}', 'M5', [], 'manual'
    )
    expect(mockMt5Bridge).toHaveBeenNthCalledWith(1, 1, 'rates', expect.objectContaining({ timeframe: 'H1', count: 1800 }))
    expect(mockMt5Bridge).toHaveBeenCalledTimes(1)
    expect(result.timeframes.H1.klines).toHaveLength(80)
    expect(result.timeframes.H1.klines[0].time).toBe('a220')
    expect(result.visualization_klines.H1).toHaveLength(300)
  })

  it('已有线段但没有中枢时不因结构状态扩容', async () => {
    const rates300 = Array.from({ length: 300 }, (_, i) => ({
      time: `a${i}`, open: '2000', high: '2010', low: '1990', close: '2005', tick_volume: '100',
      chan_segment_count: 2, chan_center_count: 0,
    }))
    mockMt5Bridge.mockResolvedValueOnce({ rates: rates300 })
    const result = await buildStrategyContextFromTags(
      1, 'XAUUSD', { balance: 10000 }, [], '分析 {{MTF:H1:80}} {{USE_CHAN}}', 'M5', [], 'manual'
    )
    expect(mockMt5Bridge).toHaveBeenNthCalledWith(1, 1, 'rates', expect.objectContaining({ timeframe: 'H1', count: 1800 }))
    expect(mockMt5Bridge).toHaveBeenCalledTimes(1)
    expect(result.timeframes.H1.klines).toHaveLength(80)
    expect(result.timeframes.H1.klines[0].time).toBe('a220')
  })

  it('已有中枢但入口锚点缺失时仍只请求一次固定目标', async () => {
    const rates300 = Array.from({ length: 300 }, (_, i) => ({
      time: `a${i}`, open: '2000', high: '2010', low: '1990', close: '2005', tick_volume: '100',
      chan_segment_count: 3, chan_center_count: 1,
    }))
    mockMt5Bridge.mockResolvedValueOnce({ rates: rates300 })
    await buildStrategyContextFromTags(
      1, 'XAUUSD', { balance: 10000 }, [], '分析 {{MTF:H1:80}} {{USE_CHAN}}', 'M5', [], 'manual'
    )
    expect(mockMt5Bridge).toHaveBeenNthCalledWith(1, 1, 'rates', expect.objectContaining({ timeframe: 'H1', count: 1800 }))
    expect(mockMt5Bridge).toHaveBeenCalledTimes(1)
  })

  it('固定目标不会被周期内状态粘性扩容', async () => {
    const rates300 = Array.from({ length: 300 }, (_, i) => ({ time: `a${i}`, open: '2000', high: '2010', low: '1990', close: '2005', tick_volume: '100' }))
    const rates2000 = Array.from({ length: 2000 }, (_, i) => ({ time: `b${i}`, open: '2000', high: '2010', low: '1990', close: '2005', tick_volume: '100' }))
    mockMt5Bridge.mockResolvedValueOnce({ rates: rates300 }).mockResolvedValue({ rates: rates2000 })
    const args = [1, 'XAUUSD', { balance: 10000 }, [], '分析 {{MTF:H1:80}} {{USE_CHAN}}', 'M5', [], 'manual']
    await buildStrategyContextFromTags(...args)
    expect(resolveChanHistoryCount(1, 'XAUUSD', 'H1', 80, true)).toBe(1800)
    mockMt5Bridge.mockClear()
    await buildStrategyContextFromTags(...args)
    expect(mockMt5Bridge).toHaveBeenCalledTimes(1)
    expect(mockMt5Bridge).toHaveBeenCalledWith(1, 'rates', expect.objectContaining({ timeframe: 'H1', count: 1800 }))
  })
  it('reports missing timeframes as a partial strategy context', async () => {
    const fallbackRates = Array.from({ length: 100 }, (_, i) => ({
      time: `m${i}`, open: '2000', high: '2010', low: '1990', close: '2005', tick_volume: '100',
    }))
    mockMt5Bridge.mockResolvedValue({ status: 'error', rates: [] })
    const result = await buildStrategyContextFromTags(
      1, 'XAUUSD', { balance: 10000 }, [], 'analyze {{MTF:M5:100}} {{MTF:H1:80}}', 'M5', fallbackRates, 'manual'
    )
    expect(result).toMatchObject({
      context_status: 'partial',
      required_timeframes: ['M5', 'H1'],
      used_timeframes: ['M5'],
      missing_timeframes: ['H1'],
    })
    expect(result.timeframes).toHaveProperty('M5')
    expect(result.timeframes).not.toHaveProperty('H1')
  })
})
describe('历史快照 Chan runtime detection', () => {
  it('recognizes the new per-timeframe raw Chan shape', () => {
    const samples = [{ market_snapshot: { strategy_context: {
      timeframes: { H1: { summary: { chan: { status:'ok' } } } },
    } } }]
    expect(__strategyTest.resolveSnapshotChanEnabled(samples)).toBe(true)
  })

  it('recognizes new raw Chan when nullable legacy markers are also present', () => {
    expect(__strategyTest.resolveSnapshotChanEnabled([{ market_snapshot: { strategy_context: {
      chan_timeframe_alignment:null, chan_structures:null,
      timeframes:{ H1:{ summary:{ chan:{} } } },
    } } }])).toBe(true)
  })

  it.each([
    { chan_timeframe_alignment:{ agreement:'mixed' } },
    { chan_structures:{ H1:{ status:'ok' } } },
  ])('recognizes legacy Chan snapshot marker %j', legacyContext => {
    expect(__strategyTest.resolveSnapshotChanEnabled([{ market_snapshot: { strategy_context: legacyContext } }])).toBe(true)
  })

  it('does not enable Chan for a snapshot without any Chan evidence', () => {
    expect(__strategyTest.resolveSnapshotChanEnabled([{ market_snapshot: {
      strategy_context: {
        chan_timeframe_alignment:null, chan_structures:null,
        timeframes: { H1: { summary: { rsi_14:55 } } },
      },
    } }])).toBe(false)
  })
})

describe('manual auto-execute guard', () => {
  const strategySource = readFileSync(new URL('../../server/routes/ai/strategy.js', import.meta.url), 'utf8')

  it('reuses the guard for the final Bridge write gate', () => {
    const executeBlock = strategySource.slice(strategySource.indexOf("const execResult = await executeOrder"))
    expect(executeBlock).toContain('beforeBridgeSend:assertAutoExecuteBeforeSend')
    expect(executeBlock).toContain('beforeWrite:assertAutoExecuteBeforeSend')
  })

  it('fails closed when no explicit guard is supplied', async () => {
    await expect(__strategyTest.resolveAutoExecuteGuard()).resolves.toEqual({
      status:'rejected', error_code:'manual_auto_execute_guard_required',
      message:'自动执行缺少请求授权',
    })
  })

  it('records a clear rejection when the guard returns false or throws', async () => {
    await expect(__strategyTest.resolveAutoExecuteGuard(() => false)).resolves.toMatchObject({
      status:'rejected', error_code:'manual_auto_execute_guard_rejected',
    })
    await expect(__strategyTest.resolveAutoExecuteGuard(() => {
      throw Object.assign(new Error('socket closed'), { code:'manual_auto_execute_request_disconnected' })
    })).resolves.toEqual({
      status:'rejected', error_code:'manual_auto_execute_request_disconnected',
      message:'发起自动执行请求的浏览器连接已断开',
    })
  })

  it('allows execution only for an explicit true guard result', async () => {
    await expect(__strategyTest.resolveAutoExecuteGuard(() => true)).resolves.toBeNull()
    await expect(__strategyTest.resolveAutoExecuteGuard(() => ({ allowed:true }))).resolves.toMatchObject({
      status:'rejected', error_code:'manual_auto_execute_guard_rejected',
    })
  })
})

describe('Chan structure anchor persistence', () => {
  const persistableChan = () => ({
    status:'partial', timeframe:'M5', window_policy_version:'chan_window_v6', maximum_history_count:800,
    window_stable:true, segment_count:3,
    source_history_count:2000,
    history_sufficient:true,
    closed_history_sufficient:true,
    reliability:'medium',
    warnings:[],
    time_location_reliable:true,
    cache_internal_gap_unresolved:false,
    authoritative_terminal_chain_confirmed:true,
    temporal_closed_bar_support:3,
    temporal_closed_bar_validator_count:3,
    temporal_identity_stable:true,
    cross_window_entry_support_count:2,
    cross_window_entry_validator_count:3,
    latest_center:{ entry_segment_stable_id:'entry', entry_segment_id:1 },
    structure_anchor:{
      recommended_time_utc_msc:1784185200000,
      full_window_authoritative:true,
      bootstrap_state:'confirmed',
      bootstrap_identity:'core|entry',
      bootstrap_core_stable_id:'core',
      bootstrap_entry_segment_stable_id:'entry',
      bootstrap_entry_start_time_utc_msc:1784185200000,
      last_confirmed_segment_time_utc_msc:1784188800000,
      bootstrap_observation_time_utc_msc:1784189100000,
    },
  })

  it('does not expand history merely because an anchor is absent', () => {
    expect(chanNeedsMoreHistory({
      segment_count:3,
      center_count:1,
      latest_center:{ entry_segment_stable_id:null, entry_segment_id:null },
      structure_anchor:{ matched:false, recommended_time_utc_msc:null },
    })).toBe(false)
    expect(chanNeedsMoreHistory({
      segment_count:3,
      center_count:1,
      latest_center:{ entry_segment_stable_id:null, entry_segment_id:null },
      structure_anchor:{ matched:true, requested_time_utc_msc:1784185200000, recommended_time_utc_msc:null },
    })).toBe(false)
    expect(chanNeedsMoreHistory({ history_sufficient:false, closed_history_sufficient:true })).toBe(true)
  })

  it('never persists a provisional anchor from an unresolved historical window', () => {
    expect(shouldPersistChanAnchor(true, {
      status:'segment_history_unresolved', window_stable:false, segment_count:0,
      structure_anchor:{ recommended_time_utc_msc:1784185200000 },
    }, { source_id:9 })).toBe(false)
  })

  it('persists only a stable multi-segment anchor with a stable source identity', () => {
    expect(shouldPersistChanAnchor(true, persistableChan(), { source_id:9 })).toBe(true)
  })

  it('persists from the independently confirmed full-window entry even before the selected response remaps that center', () => {
    const chan = persistableChan()
    chan.latest_center = { entry_segment_stable_id:null, entry_segment_id:null }
    expect(shouldPersistChanAnchor(true, chan, { source_id:9 })).toBe(true)
  })

  it('persists an MT4 source-scoped structure key without claiming exact historical UTC', () => {
    const chan = persistableChan()
    chan.time_location_reliable = false
    chan.structure_time_key_reliable = true
    chan.structure_time_key_basis = 'mt4_current_offset_source_scoped'
    expect(shouldPersistChanAnchor(true, chan, { source_id:9 })).toBe(true)
  })

  it.each([
    ['unreliable time', chan => { chan.time_location_reliable = false }],
    ['unreliable structure key', chan => { chan.structure_time_key_reliable = false }],
    ['unresolved cache gap', chan => { chan.cache_internal_gap_unresolved = true }],
    ['non-authoritative full window', chan => { chan.structure_anchor.full_window_authoritative = false }],
    ['insufficient closed-bar support', chan => { chan.temporal_closed_bar_support = 2 }],
    ['insufficient closed-bar validators', chan => { chan.temporal_closed_bar_validator_count = 2 }],
    ['unstable temporal identity', chan => { chan.temporal_identity_stable = false }],
    ['minority entry identity', chan => { chan.cross_window_entry_support_count = 1 }],
    ['short source history', chan => { chan.source_history_count = 300 }],
    ['incomplete requested history', chan => { chan.history_sufficient = false }],
    ['terminal phase absent from full window', chan => { chan.authoritative_terminal_chain_confirmed = false }],
    ['missing bootstrap identity', chan => { chan.structure_anchor.bootstrap_identity = null }],
    ['missing last confirmed segment time', chan => { chan.structure_anchor.last_confirmed_segment_time_utc_msc = null }],
    ['missing bootstrap observation time', chan => { chan.structure_anchor.bootstrap_observation_time_utc_msc = null }],
    ['observation before confirmed segment', chan => { chan.structure_anchor.bootstrap_observation_time_utc_msc = 1784187000000 }],
  ])('does not persist when %s', (_label, mutate) => {
    const chan = persistableChan()
    mutate(chan)
    expect(shouldPersistChanAnchor(true, chan, { source_id:9 })).toBe(false)
  })

  it('does not let a legacy fixed-age warning block an otherwise valid anchor', () => {
    const chan = persistableChan()
    chan.warnings = ['confirmed_structure_stale']
    expect(shouldPersistChanAnchor(true, chan, { source_id:9 })).toBe(true)
  })
})

describe('loadPrivatePortfolioContext', () => {
  beforeEach(() => vi.clearAllMocks())

  it('loads the owner positions and pending orders from the same bridge', async () => {
    mockMt5Bridge.mockImplementation((_userId, action) => action === 'positions'
      ? Promise.resolve({ status:'success', positions:[{ ticket:11, symbol:'XAUUSD' }] })
      : Promise.resolve({ status:'success', orders:[{ ticket:22, symbol:'EURUSD' }] }))
    await expect(loadPrivatePortfolioContext(7)).resolves.toEqual({
      positions:[{ ticket:11, symbol:'XAUUSD' }],
      pendingOrders:[{ ticket:22, symbol:'EURUSD' }],
    })
    expect(mockMt5Bridge).toHaveBeenCalledWith(7, 'positions', {}, { noFallback:true })
    expect(mockMt5Bridge).toHaveBeenCalledWith(7, 'pending_list', {}, { noFallback:true })
  })

  it('fails closed when either private portfolio response is incomplete', async () => {
    mockMt5Bridge.mockImplementation((_userId, action) => action === 'positions'
      ? Promise.resolve({ status:'success', positions:[] })
      : Promise.resolve({ status:'error', message:'offline' }))
    await expect(loadPrivatePortfolioContext(7)).rejects.toThrow('private_portfolio_context_unavailable')
  })
})

describe('attachAtrAnchor', () => {
  beforeEach(() => vi.clearAllMocks())

  it('按H1、H4优先级复用已收盘ATR', async () => {
    const market = { atr_14: 3, strategy_context: { timeframes: { H4: { summary: { atr_14_closed: 20 } }, H1: { summary: { atr_14: 99, atr_14_closed: 15 } } } } }
    await attachAtrAnchor(1, 'XAUUSD', market, 'M5')
    expect(market).toMatchObject({ atr_anchor: 15, atr_anchor_tf: 'H1' })
    expect(mockMt5Bridge).not.toHaveBeenCalled()
  })

  it('上下文没有锚点周期时主动获取H1', async () => {
    mockMt5Bridge.mockResolvedValue({ rates: Array(50).fill({ high: 10, low: 5, close: 8 }) })
    const market = { atr_14: 3, strategy_context: { timeframes: { M5: { summary: { atr_14: 3 } } } } }
    await attachAtrAnchor(1, 'XAUUSD', market, 'M5')
    expect(mockMt5Bridge).toHaveBeenCalledWith(1, 'rates', { symbol: 'XAUUSD', timeframe: 'H1', count: 50 })
    expect(market).toMatchObject({ atr_anchor: 12, atr_anchor_tf: 'H1' })
  })

  it('不会退回短周期ATR', async () => {
    mockMt5Bridge.mockResolvedValue({ rates: [] })
    const market = { atr_14: 3, strategy_context: { timeframes: { M5: { summary: { atr_14_closed: 3 } }, M15: { summary: { atr_14_closed: 6 } } } } }
    await attachAtrAnchor(1, 'XAUUSD', market, 'M5')
    expect(market).toMatchObject({ atr_anchor: 0, atr_anchor_tf: null })
  })
})
