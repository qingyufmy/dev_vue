import { describe, it, expect, vi, beforeEach } from 'vitest'
import { RiskReject, validateTradeRequest, signalOrderPayload, buildBridgeOrderCall } from '../../server/routes/ai/config.js'
import { configPublic } from '../../server/routes/ai/utils.js'

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
  const basePositions = []

  it('有效的 buy 请求通过', () => {
    const request = {
      symbol: 'XAUUSD',
      order_type: 'buy',
      volume: 0.03,
      confirm: true,
      source: 'manual'
    }
    const result = validateTradeRequest(baseConfig, baseAccount, basePositions, request)
    expect(result.symbol).toBe('XAUUSD')
    expect(result.order_type).toBe('buy')
    expect(result.volume).toBe(0.03)
  })

  it('缺少 symbol 拒绝', () => {
    const request = { order_type: 'buy', volume: 0.03, confirm: true }
    expect(() => validateTradeRequest(baseConfig, baseAccount, basePositions, request))
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
    expect(() => validateTradeRequest(baseConfig, baseAccount, basePositions, request))
      .toThrow('hold_signal_cannot_execute')
  })

  it('volume 超过限制拒绝', () => {
    const request = {
      symbol: 'XAUUSD',
      order_type: 'buy',
      volume: 0.1,
      confirm: true
    }
    expect(() => validateTradeRequest(baseConfig, baseAccount, basePositions, request))
      .toThrow('volume_exceeds_config_limit')
  })

  it('未确认拒绝', () => {
    const request = {
      symbol: 'XAUUSD',
      order_type: 'buy',
      volume: 0.03,
      confirm: false
    }
    expect(() => validateTradeRequest(baseConfig, baseAccount, basePositions, request))
      .toThrow('confirmation_required')
  })

  it('equity 为 0 拒绝', () => {
    const request = {
      symbol: 'XAUUSD',
      order_type: 'buy',
      volume: 0.03,
      confirm: true
    }
    expect(() => validateTradeRequest(baseConfig, { equity: 0 }, basePositions, request))
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
    expect(() => validateTradeRequest(baseConfig, baseAccount, basePositions, request))
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
  })
})

describe('configPublic', () => {
  it('隐藏敏感字段', () => {
    const row = {
      id: 1,
      api_key_encrypted: 'sk-secret-key',
      model_name: 'deepseek-chat',
      temperature: 0.7
    }
    const result = configPublic(row)
    expect(result.has_api_key).toBe(true)
    expect(result.masked_api_key).toBe('****')
    expect(result.api_key_encrypted).toBeUndefined()
    expect(result.model_name).toBe('deepseek-chat')
  })

  it('无 API key', () => {
    const row = { id: 1, api_key_encrypted: null }
    const result = configPublic(row)
    expect(result.has_api_key).toBe(false)
    expect(result.masked_api_key).toBe(null)
  })

  it('null 返回 null', () => {
    expect(configPublic(null)).toBe(null)
  })

  it('不修改原始对象', () => {
    const row = { id: 1, api_key_encrypted: 'key' }
    const original = { ...row }
    configPublic(row)
    expect(row).toEqual(original)
  })
})

describe('buildBridgeOrderCall', () => {
  it('market 请求 → bridgeAction open', () => {
    const result = buildBridgeOrderCall({ symbol: 'XAUUSD', order_type: 'buy', volume: 0.01 })
    expect(result.bridgeAction).toBe('open')
    expect(result.bridgeParams).toBe(result.bridgeParams)
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
  const basePositions = []

  it('市价单触发滑点校验', () => {
    const request = {
      symbol: 'XAUUSD', order_type: 'buy', volume: 0.01,
      source: 'ai', entry_method: 'market',
      reference_price: 4000, quote_price: 4010,
      confirm: true,
    }
    expect(() => validateTradeRequest(baseConfig, baseAccount, basePositions, request))
      .toThrow(RiskReject)
  })

  it('挂单跳过滑点校验', () => {
    const request = {
      symbol: 'XAUUSD', order_type: 'buy', volume: 0.01,
      source: 'ai', entry_method: 'limit', limit_price: 3980,
      reference_price: 4000, quote_price: 4010,
      confirm: true,
    }
    expect(() => validateTradeRequest(baseConfig, baseAccount, basePositions, request))
      .not.toThrow()
  })
})
