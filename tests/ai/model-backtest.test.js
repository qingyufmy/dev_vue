import {
  normalizeBacktestInstrument,
  normalizeBacktestOptions,
  simulateSignalReplay,
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
})
