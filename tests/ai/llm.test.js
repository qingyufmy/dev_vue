import { describe, it, expect, vi, beforeEach } from 'vitest'
import { requestJsonObject, maybeAiSignal, normalizeAiSignal } from '../../server/routes/ai/llm.js'

// Mock fetch
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

describe('requestJsonObject', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('成功解析 JSON 响应', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ choices: [{ message: { content: '{"key": "value"}' } }] })
    })

    const result = await requestJsonObject({
      url: 'https://api.test.com',
      apiKey: 'test-key',
      model: 'test-model',
      temperature: 0.7,
      maxTokens: 2000,
      messages: [{ role: 'user', content: 'test' }]
    })

    expect(result).toEqual({ key: 'value' })
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('JSON 解析失败时尝试修复', async () => {
    // 第一次返回无效 JSON
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ choices: [{ message: { content: 'invalid json' } }] })
      })
      // 修复请求返回有效 JSON
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ choices: [{ message: { content: '{"fixed": true}' } }] })
      })

    const result = await requestJsonObject({
      url: 'https://api.test.com',
      apiKey: 'test-key',
      model: 'test-model',
      temperature: 0.7,
      maxTokens: 2000,
      messages: [{ role: 'user', content: 'test' }]
    })

    expect(result).toEqual({ fixed: true })
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it('HTTP 错误抛出异常', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500 })

    await expect(requestJsonObject({
      url: 'https://api.test.com',
      apiKey: 'test-key',
      model: 'test-model',
      temperature: 0.7,
      maxTokens: 2000,
      messages: []
    })).rejects.toThrow('LLM HTTP 500')
  })

  it('非 ASCII API key 抛出异常', async () => {
    await expect(requestJsonObject({
      url: 'https://api.test.com',
      apiKey: 'test-key-中文',
      model: 'test-model',
      temperature: 0.7,
      maxTokens: 2000,
      messages: []
    })).rejects.toThrow('non-ASCII characters')
  })
})

describe('OpenAI-compatible provider URL', () => {
  it('appends chat/completions without duplicating the configured version path', async () => {
    vi.clearAllMocks()
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ choices: [{ message: { content: JSON.stringify({
        signal_type: 'hold', confidence: 0.7, recommended_volume: 0,
        analysis: 'test', reasoning: 'test', cancel_pending: [],
      }) } }] }),
    })

    await maybeAiSignal(null, {
      api_key_encrypted: 'key', api_provider: 'qwen', model_name: 'qwen-plus',
      api_base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1/',
    }, { symbol: 'XAUUSD', timeframe: 'M5', strategy_score: {} })

    expect(mockFetch.mock.calls[0][0]).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions')
    const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(requestBody).not.toHaveProperty('thinking')
    expect(requestBody).not.toHaveProperty('reasoning_effort')
    expect(requestBody).toHaveProperty('max_tokens')
  })
})

describe('normalizeAiSignal', () => {
  const baseMarket = {
    latest_price: 2000,
    atr_14: 10,
    volatility_pct: 0.3,
    strategy_score: { data_confidence: 0.7, trend_strength: 0.5 }
  }

  const baseConfig = {
    risk_level: 'medium',
    max_position_size: 0.05,
    selected_take_profit: 1
  }

  it('buy 信号正常处理', () => {
    const parsed = { signal_type: 'buy', confidence: 0.7, recommended_volume: 0.03 }
    const result = normalizeAiSignal(parsed, baseConfig, baseMarket)
    expect(result.signal_type).toBe('buy')
    expect(result.confidence).toBeGreaterThan(0)
    expect(result.recommended_volume).toBeGreaterThan(0)
    expect(result.stop_loss_price).toBeTruthy()
    expect(result.take_profit_1_price).toBeTruthy()
  })

  it('hold 信号 volume 设为 0', () => {
    const parsed = { signal_type: 'hold', confidence: 0.6, recommended_volume: 0.03 }
    const result = normalizeAiSignal(parsed, baseConfig, baseMarket)
    expect(result.signal_type).toBe('hold')
    expect(result.recommended_volume).toBe(0)
  })

  it('置信度低于阈值降级为 hold', () => {
    const parsed = { signal_type: 'buy', confidence: 0.2, recommended_volume: 0.03 }
    const result = normalizeAiSignal(parsed, baseConfig, baseMarket)
    expect(result.signal_type).toBe('hold')
  })

  it('high 风险级别降低置信度阈值', () => {
    const highRiskConfig = { ...baseConfig, risk_level: 'high' }
    const parsed = { signal_type: 'buy', confidence: 0.3, recommended_volume: 0.03 }
    const result = normalizeAiSignal(parsed, highRiskConfig, baseMarket)
    expect(result.signal_type).toBe('buy')
  })

  it('volume 不超过 max_position_size', () => {
    const parsed = { signal_type: 'buy', confidence: 0.8, recommended_volume: 0.1 }
    const result = normalizeAiSignal(parsed, baseConfig, baseMarket)
    expect(result.recommended_volume).toBeLessThanOrEqual(0.05 * 1.0) // medium risk multiplier
  })

  it('未知 signal_type 降级为 hold', () => {
    const parsed = { signal_type: 'unknown', confidence: 0.8, recommended_volume: 0.03 }
    const result = normalizeAiSignal(parsed, baseConfig, baseMarket)
    expect(result.signal_type).toBe('hold')
  })
})

describe('maybeAiSignal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('无配置返回 hold', async () => {
    const market = { symbol: 'XAUUSD', timeframe: 'M5' }
    const result = await maybeAiSignal(null, null, market)
    expect(result.signal_type).toBe('hold')
    expect(result._inference_source).toBe('ai_error_hold')
  })

  it('无 API key 返回 hold', async () => {
    const config = { api_key_encrypted: null }
    const market = { symbol: 'XAUUSD', timeframe: 'M5' }
    const result = await maybeAiSignal(null, config, market)
    expect(result.signal_type).toBe('hold')
  })

  it('不支持的 provider 返回 hold', async () => {
    const config = { api_key_encrypted: 'key', api_provider: 'unsupported' }
    const market = { symbol: 'XAUUSD', timeframe: 'M5' }
    const result = await maybeAiSignal(null, config, market)
    expect(result.signal_type).toBe('hold')
    expect(result.reasoning).toContain('unsupported_ai_provider')
  })

  it('成功调用 DeepSeek API', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        choices: [{
          message: {
            content: JSON.stringify({
              signal_type: 'buy',
              confidence: 0.7,
              recommended_volume: 0.03,
              stop_loss_price: 1990,
              take_profit_1_price: 2010,
              take_profit_2_price: 2020,
              take_profit_3_price: 2030,
              analysis: 'test analysis',
              reasoning: 'test reasoning'
            })
          }
        }]
      })
    })

    const config = {
      api_key_encrypted: 'test-key',
      api_provider: 'deepseek',
      model_name: 'deepseek-chat',
      temperature: 0.7,
      max_tokens: 2000
    }
    const market = {
      symbol: 'XAUUSD', timeframe: 'M5', timestamp: '2026-01-01',
      latest_price: 2000, price_change: 10, price_change_pct: 0.5,
      account: { balance: 10000 }, positions: [], kline_count: 100
    }

    const result = await maybeAiSignal(null, config, market)
    expect(result.signal_type).toBe('buy')
    expect(result._inference_source).toBe('ai')
  })

  it('有{{USE_CHAN}}时system prompt不包含原始标签', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ choices: [{ message: { content: '{"signal_type":"hold","confidence":0.5,"recommended_volume":0,"analysis":"t","reasoning":"t"}' } }] })
    })
    const config = {
      api_key_encrypted: 'test-key', api_provider: 'deepseek', model_name: 'deepseek-chat',
      temperature: 0.7, max_tokens: 2000, system_prompt: '分析市场 {{USE_CHAN}}'
    }
    const market = { symbol: 'XAUUSD', timeframe: 'M5', timestamp: '2026-01-01', latest_price: 2000, price_change: 10, price_change_pct: 0.5, account: { balance: 10000 }, positions: [], kline_count: 100,
      strategy_context: { timeframes: { M5: { summary: { chan: { status: 'ok' } } } } }
    }
    await maybeAiSignal(null, config, market)
    const body = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(body.messages[0].content).not.toContain('{{USE_CHAN}}')
  })

  it('有{{USE_CHAN}}时payload保留chan', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ choices: [{ message: { content: '{"signal_type":"hold","confidence":0.5,"recommended_volume":0,"analysis":"t","reasoning":"t"}' } }] })
    })
    const config = {
      api_key_encrypted: 'test-key', api_provider: 'deepseek', model_name: 'deepseek-chat',
      temperature: 0.7, max_tokens: 2000, system_prompt: '分析市场 {{USE_CHAN}}'
    }
    const market = { symbol: 'XAUUSD', timeframe: 'M5', timestamp: '2026-01-01', latest_price: 2000, price_change: 10, price_change_pct: 0.5, account: { balance: 10000 }, positions: [], kline_count: 100,
      strategy_context: { timeframes: { M5: { summary: { chan: { status: 'ok' } } } } }
    }
    await maybeAiSignal(null, config, market)
    const body = JSON.parse(mockFetch.mock.calls[0][1].body)
    const userPayload = JSON.parse(body.messages[1].content.replace('市场数据 JSON：\n', ''))
    expect(userPayload.strategy_context.timeframes.M5.summary.chan).toBeDefined()
  })

  it('无{{USE_CHAN}}时payload剥离chan', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ choices: [{ message: { content: '{"signal_type":"hold","confidence":0.5,"recommended_volume":0,"analysis":"t","reasoning":"t"}' } }] })
    })
    const config = {
      api_key_encrypted: 'test-key', api_provider: 'deepseek', model_name: 'deepseek-chat',
      temperature: 0.7, max_tokens: 2000, system_prompt: '分析市场'
    }
    const market = { symbol: 'XAUUSD', timeframe: 'M5', timestamp: '2026-01-01', latest_price: 2000, price_change: 10, price_change_pct: 0.5, account: { balance: 10000 }, positions: [], kline_count: 100,
      strategy_context: { timeframes: { M5: { summary: { chan: { status: 'ok' } } } } }
    }
    await maybeAiSignal(null, config, market)
    const body = JSON.parse(mockFetch.mock.calls[0][1].body)
    const userPayload = JSON.parse(body.messages[1].content.replace('市场数据 JSON：\n', ''))
    expect(userPayload.strategy_context.timeframes.M5.summary.chan).toBeUndefined()
  })
})

describe('normalizeAiSignal - SL/TP fallback', () => {
  const market = { latest_price: 4000, atr_14: 10, strategy_score: {} }
  const config = { risk_level: 'medium', max_position_size: 0.05 }

  it('buy_limit: SL below limitPrice, TP above limitPrice', () => {
    const result = normalizeAiSignal({
      signal_type: 'buy_limit', confidence: 0.8, limit_price: 3980
    }, config, market)
    expect(result.stop_loss_price).toBeLessThan(3980)
    expect(result.take_profit_1_price).toBeGreaterThan(3980)
    expect(result.stop_loss_price).toBe(3965)
    expect(result.take_profit_1_price).toBe(3995)
  })

  it('sell_stop: SL above limitPrice, TP below limitPrice', () => {
    const result = normalizeAiSignal({
      signal_type: 'sell_stop', confidence: 0.8, limit_price: 3990
    }, config, market)
    expect(result.stop_loss_price).toBeGreaterThan(3990)
    expect(result.take_profit_1_price).toBeLessThan(3990)
    expect(result.stop_loss_price).toBe(4005)
    expect(result.take_profit_1_price).toBe(3975)
  })

  it('buy (market): SL/TP anchored to latest_price', () => {
    const result = normalizeAiSignal({
      signal_type: 'buy', confidence: 0.8
    }, config, market)
    expect(result.stop_loss_price).toBe(3985)
    expect(result.take_profit_1_price).toBe(4015)
  })

  it('model-provided SL/TP not overwritten when distance sufficient', () => {
    const result = normalizeAiSignal({
      signal_type: 'buy_limit', confidence: 0.8, limit_price: 3980,
      stop_loss_price: 3955, take_profit_1_price: 4020
    }, config, market)
    expect(result.stop_loss_price).toBe(3955)
    expect(result.take_profit_1_price).toBe(4020)
  })
  it('model-provided SL too tight overridden by ATR minimum', () => {
    const result = normalizeAiSignal({
      signal_type: 'buy_limit', confidence: 0.8, limit_price: 3980,
      stop_loss_price: 3970, take_profit_1_price: 4000
    }, config, market)
    // ATR=10, slAtrMult=1.5 → min distance=15, AI SL distance=10 < 15 → overridden to 3980-15=3965
    expect(result.stop_loss_price).toBe(3965)
  })
})
