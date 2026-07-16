import { describe, it, expect, vi, beforeEach } from 'vitest'
import { RiskReject, validateTradeRequest, signalOrderPayload, buildBridgeOrderCall } from '../../server/routes/ai/config.js'

describe('RiskReject', () => {
  it('创建风险拒绝错误', () => {
    const err = new RiskReject('missing_symbol', { symbol: '' })
    expect(err.reason).toBe('missing_symbol')
    expect(err.details).toEqual({ symbol: '' })
    expect(err instanceof Error).toBe(true)
  })
})

describe('validateTradeRequest', () => {
  const baseConfig = { max_position_size: 0.05 }
  const baseAccount = { equity: 10000 }

  it('有效的 buy 请求通过', () => {
    const request = {
      symbol: 'XAUUSD',
      order_type: 'buy',
      volume: 0.03,
      confirm: true,
      source: 'manual'
    }
    const result = validateTradeRequest(baseConfig, baseAccount, request)
    expect(result.symbol).toBe('XAUUSD')
    expect(result.order_type).toBe('buy')
    expect(result.volume).toBe(0.03)
  })

  it('缺少 symbol 拒绝', () => {
    const request = { order_type: 'buy', volume: 0.03, confirm: true }
    expect(() => validateTradeRequest(baseConfig, baseAccount, request))
      .toThrow(RiskReject)
  })

  it('hold 信号不能执行', () => {
    const request = {
      symbol: 'XAUUSD',
      order_type: 'buy',
      volume: 0.03,
      confirm: true,
      source: 'ai',
      signal_type: 'hold'
    }
    expect(() => validateTradeRequest(baseConfig, baseAccount, request))
      .toThrow('hold_signal_cannot_execute')
  })

  it('volume 超过限制拒绝', () => {
    const request = {
      symbol: 'XAUUSD',
      order_type: 'buy',
      volume: 0.1,
      confirm: true
    }
    expect(() => validateTradeRequest(baseConfig, baseAccount, request))
      .toThrow('volume_exceeds_config_limit')
  })

  it('未确认拒绝', () => {
    const request = {
      symbol: 'XAUUSD',
      order_type: 'buy',
      volume: 0.03,
      confirm: false
    }
    expect(() => validateTradeRequest(baseConfig, baseAccount, request))
      .toThrow('confirmation_required')
  })

  it('equity 为 0 拒绝', () => {
    const request = {
      symbol: 'XAUUSD',
      order_type: 'buy',
      volume: 0.03,
      confirm: true
    }
    expect(() => validateTradeRequest(baseConfig, { equity: 0 }, request))
      .toThrow('invalid_account_equity')
  })

  it('滑点超过限制拒绝', () => {
    const request = {
      symbol: 'XAUUSD',
      order_type: 'buy',
      volume: 0.03,
      confirm: true,
      source: 'ai',
      reference_price: 2000,
      quote_price: 2010 // 0.5% 滑点
    }
    expect(() => validateTradeRequest(baseConfig, baseAccount, request))
      .toThrow('signal_price_slippage_exceeded')
  })
})

describe('signalOrderPayload', () => {
  it('生成正确的订单载荷', () => {
    const signal = {
      symbol: 'XAUUSD',
      signal_type: 'buy',
      recommended_volume: 0.03,
      stop_loss_price: 1990,
      take_profit_1_price: 2010,
      id: 123
    }
    const config = { selected_take_profit: 1 }
    const market = { latest_price: 2000 }

    const result = signalOrderPayload(signal, config, market, true)
    expect(result.symbol).toBe('XAUUSD')
    expect(result.order_type).toBe('buy')
    expect(result.volume).toBe(0.03)
    expect(result.sl).toBe(1990)
    expect(result.tp).toBe(2010)
    expect(result.confirm).toBe(true)
    expect(result.source).toBe('ai')
    expect(result.signal_id).toBe(123)
  })

  it('使用正确的止盈档位', () => {
    const signal = {
      symbol: 'XAUUSD',
      signal_type: 'sell',
      recommended_volume: 0.02,
      stop_loss_price: 2010,
      take_profit_1_price: 1990,
      take_profit_2_price: 1980,
      take_profit_3_price: 1970,
      id: 456
    }
    const config = { selected_take_profit: 2 }
    const market = { latest_price: 2000 }

    const result = signalOrderPayload(signal, config, market, false)
    expect(result.tp).toBe(1980) // take_profit_2_price
    expect(result.tp_tier_requested).toBe(2)
    expect(result.tp_tier_used).toBe(2)
    expect(result.take_profit_candidates).toEqual([
      { tier:1, price:1990 }, { tier:2, price:1980 }, { tier:3, price:1970 },
    ])
  })

  it('默认TP2缺失时回退到更近的TP1', () => {
    const signal = { symbol: 'XAUUSD', signal_type: 'buy', recommended_volume: 0.02, stop_loss_price: 1990, take_profit_1_price: 2010 }
    const result = signalOrderPayload(signal, {}, { latest_price: 2000 }, true)
    expect(result).toMatchObject({ tp: 2010, tp_tier_requested: 2, tp_tier_used: 1 })
  })

  it('TP3缺失时按3到2到1回退', () => {
    const signal = { symbol: 'XAUUSD', signal_type: 'buy', recommended_volume: 0.02, stop_loss_price: 1990, take_profit_1_price: 2010, take_profit_2_price: 2020 }
    const result = signalOrderPayload(signal, { selected_take_profit: 3 }, { latest_price: 2000 }, true)
    expect(result).toMatchObject({ tp: 2020, tp_tier_requested: 3, tp_tier_used: 2 })
  })

  it('选择TP1时缺失不会改用更远目标', () => {
    const signal = { symbol: 'XAUUSD', signal_type: 'buy', recommended_volume: 0.02, stop_loss_price: 1990, take_profit_2_price: 2020 }
    const result = signalOrderPayload(signal, { selected_take_profit: 1 }, { latest_price: 2000 }, true)
    expect(result).toMatchObject({ tp: null, tp_tier_requested: 1, tp_tier_used: null })
  })
})

describe('buildBridgeOrderCall', () => {
  it('market 请求 → bridgeAction open', () => {
    const result = buildBridgeOrderCall({ symbol: 'XAUUSD', order_type: 'buy', volume: 0.01 })
    expect(result.bridgeAction).toBe('open')
    expect(result.bridgeParams).toEqual({ symbol: 'XAUUSD', order_type: 'buy', volume: 0.01 })
  })

  it('market request strips audit-only normalization metadata', () => {
    const result = buildBridgeOrderCall({
      symbol: 'XAUUSD', order_type: 'buy', volume: 0.01,
      tp_tier_requested: 2, tp_tier_used: 1,
      take_profit_candidates: [{ tier:1, price:2010 }],
      normalization_info: { sl_clamped: true },
    })
    expect(result.bridgeParams).toEqual({ symbol: 'XAUUSD', order_type: 'buy', volume: 0.01 })
  })

  it('limit 请求 → bridgeAction pending, order_type buy_limit', () => {
    const result = buildBridgeOrderCall({
      symbol: 'XAUUSD', entry_method: 'limit', order_type: 'buy',
      limit_price: 3980, volume: 0.01, sl: 3970, tp: 4000,
      pending_valid_until: '2026-07-04 12:00:00',
    })
    expect(result.bridgeAction).toBe('pending')
    expect(result.bridgeParams.order_type).toBe('buy_limit')
    expect(result.bridgeParams.price).toBe(3980)
    const expectedExpiration = Math.floor(new Date('2026-07-04T12:00:00Z').getTime() / 1000) + 10800
    expect(result.bridgeParams.expiration).toBe(expectedExpiration)
  })

  it('sell stop 请求 → bridgeAction pending, order_type sell_stop', () => {
    const result = buildBridgeOrderCall({
      symbol: 'XAUUSD', entry_method: 'stop', order_type: 'sell',
      limit_price: 4050, volume: 0.01,
    })
    expect(result.bridgeAction).toBe('pending')
    expect(result.bridgeParams.order_type).toBe('sell_stop')
    expect(result.bridgeParams.expiration).toBeGreaterThan(Math.floor(Date.now() / 1000) + 10800)
  })

  it('stop limit 请求保留触发价与触发后限价', () => {
    const result = buildBridgeOrderCall({
      symbol: 'XAUUSD', entry_method: 'stop_limit', order_type: 'sell',
      limit_price: 3990, stop_limit_price: 3995, volume: 0.01,
    })
    expect(result.bridgeParams).toMatchObject({ order_type: 'sell_stop_limit', price: 3990, stoplimit_price: 3995 })
  })

  it('无 pending_valid_until 时 fallback 240 分钟', () => {
    const before = Math.floor(Date.now() / 1000) + 10800 + 240 * 60
    const result = buildBridgeOrderCall({
      symbol: 'XAUUSD', entry_method: 'limit', order_type: 'buy',
      limit_price: 3980, volume: 0.01,
    })
    const after = before + 5
    expect(result.bridgeParams.expiration).toBeGreaterThanOrEqual(before)
    expect(result.bridgeParams.expiration).toBeLessThanOrEqual(after)
  })
})

describe('validateTradeRequest - slippage skip for pending', () => {
  const baseConfig = { max_position_size: 0.05 }
  const baseAccount = { equity: 10000 }

  it('市价单触发滑点校验', () => {
    const request = {
      symbol: 'XAUUSD', order_type: 'buy', volume: 0.01,
      source: 'ai', entry_method: 'market',
      reference_price: 4000, quote_price: 4010,
      confirm: true,
    }
    expect(() => validateTradeRequest(baseConfig, baseAccount, request))
      .toThrow(RiskReject)
  })

  it('挂单跳过滑点校验', () => {
    const request = {
      symbol: 'XAUUSD', order_type: 'buy', volume: 0.01,
      source: 'ai', entry_method: 'limit', limit_price: 3980,
      reference_price: 4000, quote_price: 4010,
      confirm: true,
    }
    expect(() => validateTradeRequest(baseConfig, baseAccount, request))
      .not.toThrow()
  })

  it('拒绝方向错误或第二价格缺失的 sell stop limit', () => {
    const base = {
      symbol: 'XAUUSD', order_type: 'sell', volume: 0.01, source: 'ai',
      entry_method: 'stop_limit', limit_price: 4010, stop_limit_price: 4015,
      reference_price: 4000, confirm: true,
    }
    expect(() => validateTradeRequest(baseConfig, baseAccount, base)).toThrow('sell_stop_limit_trigger_too_high')
    expect(() => validateTradeRequest(baseConfig, baseAccount, { ...base, limit_price:3990, stop_limit_price:null })).toThrow('stop_limit_price_required')
  })
})
