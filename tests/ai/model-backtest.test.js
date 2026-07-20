import {
  normalizeBacktestInstrument,
  normalizeBacktestOptions,
  simulateSignalReplay,
  simulateVirtualAccount,
} from '../../server/routes/ai/model-backtest.js'

const instrument = {
  name:'XAUUSD',
  digits:2,
  point:0.01,
  tick_size:0.01,
  tick_value:1,
  contract_size:100,
  volume_min:0.01,
  volume_max:100,
  volume_step:0.01,
  currency_profit:'USD',
}

const candle = (minute, values = {}) => ({
  time_utc_msc:Date.UTC(2026, 6, 20, 0, minute),
  open:100,
  high:101,
  low:99,
  close:100,
  spread:0,
  ...values,
})

const sample = (overrides = {}) => ({
  decision_time:'2026-07-20T00:00:00.000Z',
  signal_type:'buy',
  order_intent:{
    signal_type:'buy',
    entry_method:'market',
    recommended_volume:0.1,
    stop_loss_price:95,
    take_profit_1_price:105,
    recommended_take_profit_tier:1,
    ...overrides,
  },
})

describe('model comparison account replay', () => {
  it('clamps simulation options and rejects incomplete symbol metadata', () => {
    expect(normalizeBacktestOptions({ starting_balance:1, max_holding_hours:9999 }))
      .toMatchObject({ starting_balance:100, max_holding_hours:720 })
    expect(normalizeBacktestInstrument({ point:0.01 })).toMatchObject({
      valid:false,
      missing:expect.arrayContaining(['tick_size', 'tick_value', 'volume_min']),
    })
  })

  it('replays a market order through take profit and updates account balance', () => {
    const result = simulateSignalReplay(
      [sample()],
      [candle(0), candle(1, { high:106, close:105 })],
      instrument,
      { starting_balance:10_000 },
    )
    expect(result).toMatchObject({
      status:'success',
      simulation_mode:'isolated_signal_replay',
      starting_balance:10_000,
      ending_balance:10_050,
      net_profit:50,
      closed_trade_count:1,
      win_count:1,
      max_drawdown:0,
    })
    expect(result.trades[0]).toMatchObject({
      status:'closed',
      exit_reason:'take_profit',
      entry_price:100,
      exit_price:105,
      net_profit:50,
    })
  })

  it('uses a conservative stop-first result when one OHLC bar touches stop and target', () => {
    const result = simulateSignalReplay(
      [sample()],
      [candle(0, { high:106, low:94 })],
      instrument,
      { starting_balance:10_000 },
    )
    expect(result.trades[0]).toMatchObject({
      exit_reason:'same_bar_stop_first',
      same_bar_ambiguous:true,
      net_profit:-50,
    })
    expect(result).toMatchObject({
      ending_balance:9_950,
      ambiguous_bar_count:1,
      max_drawdown:50,
      max_drawdown_pct:0.5,
    })
  })

  it('expires an untouched pending order without changing funds', () => {
    const result = simulateSignalReplay(
      [sample({
        signal_type:'buy_limit',
        entry_method:'limit',
        limit_price:90,
        pending_valid_minutes:1,
      })],
      [candle(0), candle(1), candle(2)],
      instrument,
      { starting_balance:10_000 },
    )
    expect(result).toMatchObject({
      ending_balance:10_000,
      closed_trade_count:0,
      expired_order_count:1,
    })
    expect(result.trades[0]).toMatchObject({ status:'expired', reason:'pending_not_triggered' })
  })

  it('applies configured slippage and round-turn commission', () => {
    const result = simulateSignalReplay(
      [sample()],
      [candle(0), candle(1, { high:106 })],
      instrument,
      { starting_balance:10_000, slippage_points:10, commission_per_lot:7 },
    )
    expect(result.trades[0].entry_price).toBe(100.1)
    expect(result.trades[0].gross_profit).toBe(49)
    expect(result.trades[0].commission).toBe(0.7)
    expect(result.trades[0].net_profit).toBe(48.3)
    expect(result.ending_balance).toBe(10_048.3)
  })

  it('keeps multiple signals in one event-driven account with concurrent positions', () => {
    const result = simulateVirtualAccount(
      [
        sample(),
        { ...sample(), decision_time:'2026-07-20T00:01:00.000Z' },
      ],
      [candle(0), candle(1), candle(2, { high:106, close:105 })],
      instrument,
      { starting_balance:10_000, leverage:100, max_concurrent_positions:5 },
    )
    expect(result).toMatchObject({
      status:'success',
      simulation_mode:'event_driven_virtual_account',
      realism_level:'m1_ohlc_margin_account',
      maximum_concurrent_positions:2,
      closed_trade_count:2,
      win_count:2,
      ending_balance:10_100,
    })
    expect(result.equity_curve.some(point => point.open_positions === 2)).toBe(true)
  })

  it('rejects an order when the shared account has insufficient free margin', () => {
    const result = simulateVirtualAccount(
      [sample({ recommended_volume:1 })],
      [candle(0), candle(1)],
      instrument,
      { starting_balance:100, leverage:1 },
    )
    expect(result).toMatchObject({
      status:'success',
      ending_balance:100,
      closed_trade_count:0,
      rejected_order_count:1,
      margin_rejected_count:1,
    })
    expect(result.trades[0]).toMatchObject({
      status:'rejected',
      reason:'insufficient_free_margin',
      required_margin:10_000,
    })
  })

  it('liquidates the worst position when margin level reaches the MT5 stop-out line', () => {
    const result = simulateVirtualAccount(
      [sample({
        recommended_volume:1,
        stop_loss_price:50,
        take_profit_1_price:150,
      })],
      [candle(0), candle(1, { open:100, high:100, low:94, close:94 })],
      instrument,
      { starting_balance:1_000, leverage:10, stop_out_level_pct:50 },
    )
    expect(result).toMatchObject({
      status:'success',
      stop_out_count:1,
      lowest_margin_level_pct:40,
      ending_balance:400,
      max_drawdown:600,
      max_drawdown_pct:60,
    })
    expect(result.trades[0]).toMatchObject({
      status:'closed',
      exit_reason:'margin_stop_out',
      exit_price:94,
      net_profit:-600,
    })
  })

  it('enforces the configured concurrent-position ceiling', () => {
    const result = simulateVirtualAccount(
      [
        sample({ take_profit_1_price:150 }),
        { ...sample({ take_profit_1_price:150 }), decision_time:'2026-07-20T00:01:00.000Z' },
      ],
      [candle(0), candle(1), candle(2)],
      instrument,
      { starting_balance:10_000, leverage:100, max_concurrent_positions:1 },
    )
    expect(result).toMatchObject({
      maximum_concurrent_positions:1,
      position_limit_rejected_count:1,
      rejected_order_count:1,
    })
    expect(result.trades.some(record => record.reason === 'max_concurrent_positions_reached')).toBe(true)
  })

  it('uses the worse opening price when a stop entry gaps beyond its trigger', () => {
    const result = simulateVirtualAccount(
      [sample({
        signal_type:'buy_stop',
        entry_method:'stop',
        limit_price:101,
        stop_loss_price:95,
        take_profit_1_price:110,
      })],
      [
        candle(0, { open:103, high:104, low:102, close:103 }),
        candle(1, { open:109, high:111, low:108, close:110 }),
      ],
      instrument,
      { starting_balance:10_000, leverage:100, slippage_points:10 },
    )
    expect(result.trades[0]).toMatchObject({
      status:'closed',
      entry_price:103.1,
      exit_reason:'take_profit',
      exit_price:110,
      net_profit:69,
    })
  })

  it('uses the worse opening price when price gaps through a stop loss', () => {
    const result = simulateVirtualAccount(
      [sample()],
      [
        candle(0),
        candle(1, { open:90, high:91, low:89, close:90 }),
      ],
      instrument,
      { starting_balance:10_000, leverage:100 },
    )
    expect(result.trades[0]).toMatchObject({
      status:'closed',
      exit_reason:'stop_loss',
      exit_price:90,
      net_profit:-100,
    })
  })

  it('defers an intrabar stop-limit activation because OHLC cannot prove event order', () => {
    const result = simulateVirtualAccount(
      [sample({
        signal_type:'buy_stop_limit',
        entry_method:'stop_limit',
        limit_price:101,
        stop_limit_price:100,
        stop_loss_price:95,
        take_profit_1_price:110,
      })],
      [
        candle(0, { open:100, high:102, low:99, close:100 }),
        candle(1, { open:100, high:100.5, low:99.5, close:100 }),
      ],
      instrument,
      { starting_balance:10_000, leverage:100 },
    )
    expect(result.stop_limit_same_bar_deferred_count).toBe(1)
    expect(result.trades[0]).toMatchObject({
      status:'closed',
      entry_time_utc_msc:Date.UTC(2026, 6, 20, 0, 1),
      entry_price:100,
      exit_reason:'data_end',
    })
  })

  it('applies stop-out at the adverse intrabar extreme even when the candle closes recovered', () => {
    const result = simulateVirtualAccount(
      [sample({
        recommended_volume:1,
        stop_loss_price:50,
        take_profit_1_price:150,
      })],
      [
        candle(0),
        candle(1, { open:100, high:101, low:94, close:100 }),
      ],
      instrument,
      { starting_balance:1_000, leverage:10, stop_out_level_pct:50 },
    )
    expect(result).toMatchObject({
      stop_out_count:1,
      lowest_margin_level_pct:40,
      ending_balance:400,
      intrabar_margin_mode:'conservative_directional_extremes',
    })
    expect(result.trades[0]).toMatchObject({
      exit_reason:'margin_stop_out',
      exit_price:94,
      net_profit:-600,
    })
  })
})
