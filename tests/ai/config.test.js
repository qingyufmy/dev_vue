import { describe, it, expect, vi, beforeEach } from 'vitest'
import { RiskReject, signalOrderPayload, buildBridgeOrderCall, enrichOrderRequest, isAiPendingOrderRequest, projectPendingRiskSnapshot } from '../../server/routes/ai/config.js'

describe('RiskReject', () => {
  it('创建风险拒绝错误', () => {
    const err = new RiskReject('missing_symbol', { symbol: '' })
    expect(err.reason).toBe('missing_symbol')
    expect(err.details).toEqual({ symbol: '' })
    expect(err instanceof Error).toBe(true)
  })
})

describe('AI pending-order platform control', () => {
  it('applies only to AI pending orders and never to manual or market orders', () => {
    expect(isAiPendingOrderRequest({ entry_method:'limit' }, 'auto_delivery')).toBe(true)
    expect(isAiPendingOrderRequest({ entry_method:'stop' }, 'manual_ai')).toBe(true)
    expect(isAiPendingOrderRequest({ entry_method:'market' }, 'auto_delivery')).toBe(false)
    expect(isAiPendingOrderRequest({ entry_method:'limit' }, 'manual')).toBe(false)
  })
})

describe('order request enrichment', () => {
  it('preserves MT5 timezone while enriching quote and point-based protection', () => {
    const request = {
      symbol:'XAUUSD', order_type:'buy', stop_loss_points:100, take_profit_points:200,
    }
    enrichOrderRequest({ request, quote:{ ask:4000, bid:3999.8, point:0.01, timezone_offset_minutes:120 } })
    expect(request).toMatchObject({
      mt5_timezone_offset_minutes:120,
      quote_price:4000,
      sl:3999,
      tp:4002,
    })
  })

  it('ignores an invalid broker timezone without losing quote enrichment', () => {
    const request = { symbol:'EURUSD', order_type:'sell' }
    enrichOrderRequest({ request, quote:{ ask:1.1002, bid:1.1, timezone_offset_minutes:9999 } })
    expect(request.quote_price).toBe(1.1)
    expect(request).not.toHaveProperty('mt5_timezone_offset_minutes')
  })
})

describe('replacement risk projection', () => {
  const pending = [{ ticket:11, volume:0.01 }, { mt5_ticket:'12', volume:0.02 }]

  it('removes only explicitly owned replacement tickets for automatic delivery preflight', () => {
    expect(projectPendingRiskSnapshot(pending, ['11'], 'auto_delivery')).toEqual([pending[1]])
  })

  it('never lets manual requests subtract existing pending risk', () => {
    expect(projectPendingRiskSnapshot(pending, ['11'], 'manual')).toEqual(pending)
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
      recommended_take_profit_tier: 2,
      id: 456
    }
    const config = { take_profit_mode: 'ai_recommended' }
    const market = { latest_price: 2000 }

    const result = signalOrderPayload(signal, config, market, false)
    expect(result.tp).toBe(1980) // take_profit_2_price
    expect(result.tp_tier_requested).toBe(2)
    expect(result.tp_tier_used).toBe(2)
    expect(result.take_profit_candidates).toEqual([
      { tier:1, price:1990 }, { tier:2, price:1980 }, { tier:3, price:1970 },
    ])
  })

  it('旧信号未记录推荐档位时兼容使用TP1', () => {
    const signal = { symbol: 'XAUUSD', signal_type: 'buy', recommended_volume: 0.02, stop_loss_price: 1990, take_profit_1_price: 2010 }
    const result = signalOrderPayload(signal, {}, { latest_price: 2000 }, true)
    expect(result).toMatchObject({ tp: 2010, tp_tier_requested: 1, tp_tier_used: 1, tp_selection_source: 'legacy_tp1_fallback' })
  })

  it('固定趋势目标缺失时失败关闭而不是静默降档', () => {
    const signal = { symbol: 'XAUUSD', signal_type: 'buy', recommended_volume: 0.02, stop_loss_price: 1990, take_profit_1_price: 2010, take_profit_2_price: 2020 }
    const result = signalOrderPayload(signal, { take_profit_mode: 'trend' }, { latest_price: 2000 }, true)
    expect(result).toMatchObject({ tp: null, tp_tier_requested: 3, tp_tier_used: null, tp_selection_source: 'subscription_preference' })
  })

  it('选择TP1时缺失不会改用更远目标', () => {
    const signal = { symbol: 'XAUUSD', signal_type: 'buy', recommended_volume: 0.02, stop_loss_price: 1990, take_profit_2_price: 2020 }
    const result = signalOrderPayload(signal, { take_profit_mode: 'conservative' }, { latest_price: 2000 }, true)
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

  it('uses the calibrated MT5 timezone offset for pending expiration', () => {
    const result = buildBridgeOrderCall({
      symbol: 'XAUUSD', entry_method: 'limit', order_type: 'buy',
      limit_price: 3980, volume: 0.01,
      pending_valid_until: '2026-07-04 12:00:00',
      mt5_timezone_offset_minutes: 120,
    })
    const expectedExpiration = Math.floor(new Date('2026-07-04T12:00:00Z').getTime() / 1000) + 7200
    expect(result.bridgeParams.expiration).toBe(expectedExpiration)
  })

  it('does not send timezone metadata in a market order payload', () => {
    const result = buildBridgeOrderCall({
      symbol: 'XAUUSD', order_type: 'buy', volume: 0.01,
      mt5_timezone_offset_minutes: 120,
    })
    expect(result.bridgeParams).not.toHaveProperty('mt5_timezone_offset_minutes')
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
