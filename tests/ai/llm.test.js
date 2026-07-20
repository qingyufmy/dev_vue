import { describe, it, expect, vi, beforeEach } from 'vitest'
import { requestJsonObject, maybeAiSignal, normalizeAiSignal, buildStrategyOutputFormat, formatPendingValidUntilUtc, validateAiSignalResponse } from '../../server/routes/ai/llm.js'

describe('buildStrategyOutputFormat', () => {
  it('removes all pending-order fields from a market-only strategy', () => {
    const result = buildStrategyOutputFormat(null, ['market'])
    const schema = JSON.parse(result.outputFormat)
    expect(result.hasPending).toBe(false)
    expect(schema.signal_type).toContain('buy | sell | hold')
    expect(schema.signal_type).not.toContain('buy_limit')
    expect(schema).not.toHaveProperty('limit_price')
    expect(schema).not.toHaveProperty('stop_limit_price')
    expect(schema).not.toHaveProperty('pending_valid_minutes')
    expect(schema).not.toHaveProperty('cancel_pending')
  })

  it('keeps pending fields but removes stop-limit price when stop-limit is unsupported', () => {
    const schema = JSON.parse(buildStrategyOutputFormat(null, ['limit']).outputFormat)
    expect(schema.signal_type).toContain('buy_limit')
    expect(schema.signal_type).not.toContain('buy_stop')
    expect(schema).toHaveProperty('limit_price')
    expect(schema).not.toHaveProperty('stop_limit_price')
  })

  it('requires the model to report usage only for retrieved experience ids', () => {
    const schema = JSON.parse(buildStrategyOutputFormat(null, ['market'], { selectedItemIds:[7, 9] }).outputFormat)
    expect(schema.experience_usage.considered_ids).toEqual([7, 9])
    expect(schema.experience_usage.used_ids).toContain('7、9')
  })
})

describe('experience usage normalization', () => {
  it('drops hallucinated experience ids from model output', () => {
    const result = normalizeAiSignal({ signal_type:'hold', entry_method:'observe', confidence:0.6, recommended_volume:0,
      experience_usage:{ used_ids:[7, 999], rejected_ids:[8, 998], influence:'经验支持继续等待' } },
    { _allowed_entry_methods:['market'], _experienceSelection:{ source:'platform', selectedItemIds:[7, 8] } },
    { strategy_score:{ trend_strength:0.2 }, volatility_pct:0.1 })
    expect(result.experience_usage).toMatchObject({ source:'platform', considered_ids:[7, 8], used_ids:[7], rejected_ids:[8] })
  })
})

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
      url: 'https://api.example.test',
      apiKey: 'test-key',
      model: 'test-model',
      temperature: 0.7,
      maxTokens: 2000,
      messages: [{ role: 'user', content: 'test' }]
    })

    expect(result).toEqual({ key: 'value' })
    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(mockFetch.mock.calls[0][1].redirect).toBe('error')
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
      url: 'https://api.example.test',
      apiKey: 'test-key',
      model: 'test-model',
      temperature: 0.7,
      maxTokens: 2000,
      messages: [{ role: 'user', content: 'test' }]
    })

    expect(result).toEqual({ fixed: true })
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it('JSON 结构校验失败时要求模型修复并再次校验', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ choices: [{ message: { content: '{"summary":"缺少必填字段"}' } }] })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ choices: [{ message: { content: '{"period_summary":"字段已补齐"}' } }] })
      })

    const validateObject = vi.fn(value => {
      if (!value.period_summary) throw new Error('daily_review_summary_missing')
      return value
    })
    const result = await requestJsonObject({
      url: 'https://api.example.test', apiKey: 'test-key', model: 'test-model', temperature: 0.2,
      maxTokens: 2000, messages: [{ role: 'user', content: 'test' }], validateObject,
    })

    expect(result).toEqual({ period_summary: '字段已补齐' })
    expect(validateObject).toHaveBeenCalledTimes(2)
    expect(mockFetch).toHaveBeenCalledTimes(2)
    const repairBody = JSON.parse(mockFetch.mock.calls[1][1].body)
    expect(repairBody.messages.at(-1).content).toContain('daily_review_summary_missing')
  })

  it('HTTP 错误抛出异常', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500 })

    await expect(requestJsonObject({
      url: 'https://api.example.test',
      apiKey: 'test-key',
      model: 'test-model',
      temperature: 0.7,
      maxTokens: 2000,
      messages: []
    })).rejects.toThrow('LLM HTTP 500')
  })

  it('非 ASCII API key 抛出异常', async () => {
    await expect(requestJsonObject({
      url: 'https://api.example.test',
      apiKey: 'test-key-中文',
      model: 'test-model',
      temperature: 0.7,
      maxTokens: 2000,
      messages: []
    })).rejects.toThrow('non-ASCII characters')
  })

  it('解析 Responses API output 内容', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({
        output: [{ type: 'message', content: [{ type: 'output_text', text: '{"key":"responses"}' }] }],
      }),
    })

    const result = await requestJsonObject({
      url: 'https://ark.cn-beijing.volces.com/api/plan/v3/responses',
      apiKey: 'test-key',
      model: 'ark-code-latest',
      temperature: 0.3,
      maxTokens: 2000,
      messages: [
        { role: 'system', content: '只返回 JSON' },
        { role: 'user', content: 'test' },
      ],
      protocol: 'responses',
      thinkingEnabled: true,
      reasoningEffort: 'max',
    })

    expect(result).toEqual({ key: 'responses' })
    const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(requestBody.instructions).toBe('只返回 JSON')
    expect(requestBody.input).toEqual([{ role: 'user', content: 'test' }])
    expect(requestBody.max_output_tokens).toBe(2000)
    expect(requestBody.reasoning).toEqual({ effort: 'high' })
    expect(requestBody).not.toHaveProperty('messages')
    expect(requestBody).not.toHaveProperty('max_tokens')
  })

  it('Responses API JSON 修复仍使用 Responses 请求结构', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ output_text: 'invalid json' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ output_text: '{"fixed":true}' }),
      })

    const result = await requestJsonObject({
      url: 'https://ark.cn-beijing.volces.com/api/plan/v3/responses',
      apiKey: 'test-key', model: 'ark-code-latest', temperature: 0.3, maxTokens: 2000,
      messages: [{ role: 'user', content: 'test' }],
      protocol: 'responses', thinkingEnabled: false,
    })

    expect(result).toEqual({ fixed: true })
    expect(mockFetch).toHaveBeenCalledTimes(2)
    const repairBody = JSON.parse(mockFetch.mock.calls[1][1].body)
    expect(repairBody.input.map(item => item.role)).toEqual(['user', 'assistant', 'user'])
    expect(repairBody.temperature).toBe(0)
    expect(repairBody).not.toHaveProperty('messages')
  })

  it('uses the Kimi Code thinking contract and an honest client identity', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ choices: [{ message: { content: '{"ok":true}' } }] }),
    })
    await requestJsonObject({
      url: 'https://api.kimi.com/coding/v1/chat/completions',
      apiKey: 'kimi-key', provider: 'kimi_code', model: 'k3', temperature: 0.3,
      maxTokens: 32000, thinkingEnabled: true, reasoningEffort: 'low',
      messages: [{ role: 'user', content: 'test' }],
    })
    const options = mockFetch.mock.calls[0][1]
    const body = JSON.parse(options.body)
    expect(body.thinking).toEqual({ type: 'enabled', effort: 'max' })
    expect(body.max_tokens).toBe(32000)
    expect(body).not.toHaveProperty('temperature')
    expect(options.headers['User-Agent']).toBe('Aurum-AI-Trading-Lab/2.3.4')
  })

  it('maps Kimi Code subscription rate limits to a stable error code', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 429 })
    await expect(requestJsonObject({
      url: 'https://api.kimi.com/coding/v1/chat/completions',
      apiKey: 'kimi-key', provider: 'kimi_code', model: 'kimi-for-coding', maxTokens: 2000,
      thinkingEnabled: true, messages: [],
    })).rejects.toThrow('kimi_code_rate_limited')
  })

  it('enables K2.7 thinking without sending the unsupported effort field', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ choices: [{ message: { content: '{"ok":true}' } }] }),
    })
    await requestJsonObject({
      url: 'https://api.kimi.com/coding/v1/chat/completions',
      apiKey: 'kimi-key', provider: 'kimi_code', model: 'kimi-for-coding', maxTokens: 2000,
      thinkingEnabled: true, reasoningEffort: 'max', messages: [],
    })
    expect(JSON.parse(mockFetch.mock.calls[0][1].body).thinking).toEqual({ type: 'enabled' })
  })
})

describe('validateAiSignalResponse', () => {
  const hold = {
    signal_type: 'hold', entry_method: 'observe', confidence: 0.62,
    recommended_volume: 0, analysis: '暂无优势', reasoning: '等待结构确认',
  }

  it('accepts a complete HOLD contract', () => {
    expect(validateAiSignalResponse(hold, ['market'])).toBe(hold)
  })

  it('rejects missing fields and mismatched entry methods before normalization', () => {
    expect(() => validateAiSignalResponse({ ...hold, entry_method: undefined }, ['market']))
      .toThrow('ai_response_entry_method_mismatch')
    expect(() => validateAiSignalResponse({ ...hold, signal_type: 'sell_stop_limit', entry_method: 'limit', recommended_volume: 0.01 }, ['stop_limit']))
      .toThrow('ai_response_entry_method_mismatch')
  })

  it('rejects methods excluded by the selected strategy', () => {
    expect(() => validateAiSignalResponse({
      ...hold, signal_type: 'buy_limit', entry_method: 'limit', recommended_volume: 0.01,
    }, ['market'])).toThrow('ai_response_invalid_signal_type')
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
      api_key_encrypted: 'key', api_provider: 'openai_compatible', model_name: 'gpt-4o',
      api_base_url: 'https://api.openai.com/v1/',
    }, { symbol: 'XAUUSD', timeframe: 'M5', strategy_score: {} })

    expect(mockFetch.mock.calls[0][0]).toBe('https://api.openai.com/v1/chat/completions')
    const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(requestBody).not.toHaveProperty('thinking')
    expect(requestBody).not.toHaveProperty('reasoning_effort')
    expect(requestBody).toHaveProperty('max_tokens')
  })

  it('uses the Agent Plan Responses API endpoint and payload', async () => {
    vi.clearAllMocks()
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ output_text: JSON.stringify({
        signal_type: 'hold', confidence: 0.7, recommended_volume: 0,
        analysis: 'test', reasoning: 'test', cancel_pending: [],
      }) }),
    })

    await maybeAiSignal(null, {
      api_key_encrypted: 'plan-key',
      api_provider: 'volcengine_agent_plan',
      model_name: 'ark-code-latest',
      api_base_url: 'https://ark.cn-beijing.volces.com/api/plan/v3/',
      thinking_enabled: true,
      reasoning_effort: 'high',
    }, { symbol: 'XAUUSD', timeframe: 'M5', strategy_score: {} })

    expect(mockFetch.mock.calls[0][0]).toBe('https://ark.cn-beijing.volces.com/api/plan/v3/responses')
    const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(requestBody.model).toBe('ark-code-latest')
    expect(requestBody.reasoning).toEqual({ effort: 'high' })
    expect(requestBody).toHaveProperty('instructions')
    expect(requestBody).toHaveProperty('input')
    expect(requestBody).not.toHaveProperty('messages')
  })

  it('routes DeepSeek through its default endpoint', async () => {
    vi.clearAllMocks()
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ choices: [{ message: { content: JSON.stringify({
        signal_type: 'hold', confidence: 0.7, recommended_volume: 0,
        analysis: 'test', reasoning: 'test', cancel_pending: [],
      }) } }] }),
    })
    await maybeAiSignal(null, {
      api_key_encrypted: 'key', api_provider: 'deepseek', model_name: 'deepseek-chat',
      thinking_enabled: false,
    }, { symbol: 'XAUUSD', timeframe: 'M5', strategy_score: {} })
    expect(mockFetch.mock.calls[0][0]).toBe('https://api.deepseek.com/chat/completions')
  })

  it('routes Kimi Code through its subscription endpoint with Thinking enabled', async () => {
    vi.clearAllMocks()
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ choices: [{ message: { content: JSON.stringify({
        signal_type: 'hold', confidence: 0.7, recommended_volume: 0,
        analysis: 'test', reasoning: 'test', cancel_pending: [],
      }) } }] }),
    })
    await maybeAiSignal(null, {
      api_key_encrypted: 'key', api_provider: 'kimi_code', model_name: 'kimi-for-coding',
      thinking_enabled: false,
    }, { symbol: 'XAUUSD', timeframe: 'M5', strategy_score: {} })
    expect(mockFetch.mock.calls[0][0]).toBe('https://api.kimi.com/coding/v1/chat/completions')
    expect(JSON.parse(mockFetch.mock.calls[0][1].body).thinking.type).toBe('enabled')
  })
})

describe('normalizeAiSignal', () => {
  const baseMarket = {
    latest_price: 2000,
    atr_anchor: 10,
    atr_anchor_tf: 'H1',
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
    const parsed = { signal_type: 'buy', confidence: 0.7, recommended_volume: 0.03, bullish_score: 7, bearish_score: 3 }
    const result = normalizeAiSignal(parsed, baseConfig, baseMarket)
    expect(result.signal_type).toBe('buy')
    expect(result.confidence).toBeGreaterThan(0)
    expect(result.recommended_volume).toBeGreaterThan(0)
    expect(result.stop_loss_price).toBeTruthy()
    expect(result.take_profit_1_price).toBeTruthy()
    expect(result.bullish_score).toBe(70)
    expect(result.bearish_score).toBe(30)
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
              entry_method: 'market',
              confidence: 0.7,
              recommended_volume: 0.03,
              stop_loss_price: 1990,
              take_profit_1_price: 2010,
              take_profit_2_price: 2020,
              take_profit_3_price: 2030,
              recommended_take_profit_tier: 2,
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
      account: { balance: 10000 }, positions: [], kline_count: 100,
      atr_anchor: 10, atr_anchor_tf: 'H1'
    }

    const result = await maybeAiSignal(null, config, market)
    expect(result.signal_type).toBe('buy')
    expect(result._inference_source).toBe('ai')
    const body = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(body.messages[0].content).toContain('禁止比较任何时间字符串来判断挂单是否过期')
    expect(body.messages[0].content).toContain('禁止仅以时间、有效期或过期为理由输出 cancel_pending')
  })

  it('共享推理只渲染市场白名单并回传可复现提示词证据', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ choices: [{ message: { content: JSON.stringify({
        signal_type: 'hold', entry_method: 'observe', confidence: 0.6, recommended_volume: 0,
        stop_loss_price: null, take_profit_1_price: null, analysis: '等待', reasoning: '无明确优势',
      }) } }] }),
    })
    let evidence
    const config = {
      api_key_encrypted: 'must-not-leak', api_provider: 'deepseek', model_name: 'deepseek-chat',
      _market_only: true, _onInferencePrepared: value => { evidence = value },
    }
    const market = {
      standard_symbol: 'XAUUSD', symbol: 'XAUUSD', timeframe: 'M5', latest_price: 2000,
      atr_14: 10, ai_volume_range: { min: 0.01, max: 0.05 }, strategy_context: { timeframes: {} },
    }
    await maybeAiSignal(null, config, market)
    expect(evidence.systemPrompt).toContain('共享市场推理边界')
    expect(evidence.userPrompt).toContain('"ai_volume_range"')
    expect(evidence.userPrompt).not.toContain('account')
    expect(evidence.userPrompt).not.toContain('positions')
    expect(JSON.stringify(evidence)).not.toContain('must-not-leak')
    expect(evidence.outputSchemaVersion).toMatch(/^[a-f0-9]{64}$/)
  })

  it('结构化开关启用缠论时system prompt不需要控制标签', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ choices: [{ message: { content: '{"signal_type":"hold","confidence":0.5,"recommended_volume":0,"analysis":"t","reasoning":"t"}' } }] })
    })
    const config = {
      api_key_encrypted: 'test-key', api_provider: 'deepseek', model_name: 'deepseek-chat',
      temperature: 0.7, max_tokens: 2000, system_prompt: '分析市场', _use_chan_analysis: true
    }
    const market = { symbol: 'XAUUSD', timeframe: 'M5', timestamp: '2026-01-01', latest_price: 2000, price_change: 10, price_change_pct: 0.5, account: { balance: 10000 }, positions: [], kline_count: 100, atr_anchor: 15, atr_anchor_tf: 'H1',
      strategy_context: { timeframes: { M5: { summary: { chan: { status: 'ok' } } } } }
    }
    await maybeAiSignal(null, config, market)
    const body = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(body.messages[0].content).not.toContain('{{USE_CHAN}}')
    expect(body.messages[0].content).toContain('缠论背驰使用规则')
    expect(body.messages[0].content).toContain('forming_divergence')
    expect(body.messages[0].content).toContain('entry_candidates')
    expect(body.messages[0].content).toContain('chan_timeframe_alignment')
  })

  it('结构化开关启用时payload保留chan', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ choices: [{ message: { content: '{"signal_type":"hold","confidence":0.5,"recommended_volume":0,"analysis":"t","reasoning":"t"}' } }] })
    })
    const config = {
      api_key_encrypted: 'test-key', api_provider: 'deepseek', model_name: 'deepseek-chat',
      temperature: 0.7, max_tokens: 2000, system_prompt: '分析市场', _use_chan_analysis: true
    }
    const market = { symbol: 'XAUUSD', timeframe: 'M5', timestamp: '2026-01-01', latest_price: 2000, price_change: 10, price_change_pct: 0.5, account: { balance: 10000 }, positions: [], kline_count: 100, atr_anchor: 15, atr_anchor_tf: 'H1',
      strategy_context: { visualization_klines: { M5: [{ time: 'internal-only' }] }, timeframes: { M5: { summary: { chan: { status: 'ok' } } } } }
    }
    await maybeAiSignal(null, config, market)
    const body = JSON.parse(mockFetch.mock.calls[0][1].body)
    const userPayload = JSON.parse(body.messages[1].content.replace('市场数据 JSON：\n', ''))
    expect(userPayload.strategy_context.timeframes.M5.summary.chan).toBeDefined()
    expect(userPayload.strategy_context).not.toHaveProperty('visualization_klines')
    expect(userPayload).toMatchObject({ atr_anchor: 15, atr_anchor_tf: 'H1' })
  })

  it('手动覆盖提示词决定模型指令并保留缠论数据', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ choices: [{ message: { content: '{"signal_type":"hold","confidence":0.5,"recommended_volume":0,"analysis":"t","reasoning":"t"}' } }] })
    })
    const config = {
      api_key_encrypted: 'test-key', api_provider: 'deepseek', model_name: 'deepseek-chat',
      temperature: 0.7, max_tokens: 2000, system_prompt: '数据库中的旧提示词', _use_chan_analysis: true
    }
    const market = { symbol: 'XAUUSD', timeframe: 'M5', timestamp: '2026-01-01', latest_price: 2000, price_change: 10, price_change_pct: 0.5, account: { balance: 10000 }, positions: [], kline_count: 100,
      strategy_context: { timeframes: { M5: { summary: { chan: { status: 'ok' } } } } }
    }

    await maybeAiSignal(null, config, market, '本次手动覆盖提示词')

    const body = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(body.messages[0].content).toContain('本次手动覆盖提示词')
    expect(body.messages[0].content).not.toContain('数据库中的旧提示词')
    const userPayload = JSON.parse(body.messages[1].content.replace('市场数据 JSON：\n', ''))
    expect(userPayload.strategy_context.timeframes.M5.summary.chan).toBeDefined()
  })

  it('结构化开关关闭时即使遗留标签存在也剥离chan', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ choices: [{ message: { content: '{"signal_type":"hold","confidence":0.5,"recommended_volume":0,"analysis":"t","reasoning":"t"}' } }] })
    })
    const config = {
      api_key_encrypted: 'test-key', api_provider: 'deepseek', model_name: 'deepseek-chat',
      temperature: 0.7, max_tokens: 2000, system_prompt: '分析市场 {{USE_CHAN}}', _use_chan_analysis: false
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
  const market = { latest_price: 4000, atr_anchor: 10, atr_anchor_tf: 'H1', atr_14: 10, strategy_score: {} }
  const config = { risk_level: 'medium', max_position_size: 0.05 }

  it('buy_limit: SL below limitPrice, TP above limitPrice', () => {
    const result = normalizeAiSignal({
      signal_type: 'buy_limit', confidence: 0.8, limit_price: 3980
    }, config, market)
    expect(result.stop_loss_price).toBeLessThan(3980)
    expect(result.take_profit_1_price).toBeGreaterThan(3980)
    expect(result.stop_loss_price).toBe(3965)
    expect(result.take_profit_1_price).toBe(4002.5)
  })

  it('sell_stop: SL above limitPrice, TP below limitPrice', () => {
    const result = normalizeAiSignal({
      signal_type: 'sell_stop', confidence: 0.8, limit_price: 3990
    }, config, market)
    expect(result.stop_loss_price).toBeGreaterThan(3990)
    expect(result.take_profit_1_price).toBeLessThan(3990)
    expect(result.stop_loss_price).toBe(4005)
    expect(result.take_profit_1_price).toBe(3967.5)
  })

  it('buy (market): SL/TP anchored to latest_price', () => {
    const result = normalizeAiSignal({
      signal_type: 'buy', confidence: 0.8
    }, config, market)
    expect(result.stop_loss_price).toBe(3985)
    expect(result.take_profit_1_price).toBe(4022.5)
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
      signal_type: 'buy_limit', confidence: 0.8, recommended_volume: 0.03, limit_price: 3980,
      stop_loss_price: 3975, take_profit_1_price: 4000
    }, config, market)
    // Anchor ATR=10, K_MIN=1.0: distance 5 is widened to 10 and volume halves.
    expect(result.stop_loss_price).toBe(3970)
    expect(result.recommended_volume).toBe(0.01)
    expect(result.normalization_info.type).toBe('sl_widened')
  })

  it('使用小时级锚点派生止损和三档止盈', () => {
    const result = normalizeAiSignal({ signal_type: 'buy', confidence: 0.8, recommended_volume: 0.03 }, config, { ...market, atr_anchor: 15, atr_anchor_tf: 'H1' })
    expect(result.stop_loss_price).toBe(3977.5)
    expect(result.take_profit_1_price).toBe(4033.75)
    expect(result.take_profit_2_price).toBe(4056.25)
    expect(result.take_profit_3_price).toBe(4090)
  })

  it('止损超过3倍锚点时降级为观望', () => {
    const result = normalizeAiSignal({ signal_type: 'buy', confidence: 0.8, recommended_volume: 0.03, stop_loss_price: 3940, take_profit_1_price: 4020 }, config, { ...market, atr_anchor: 15 })
    expect(result).toMatchObject({ signal_type: 'hold', entry_method: 'observe', recommended_volume: 0, normalization_info: { type: 'sl_too_far_hold' } })
  })

  it('放宽后所需手数低于0.01时降级为观望', () => {
    const result = normalizeAiSignal({ signal_type: 'buy', confidence: 0.8, recommended_volume: 0.03, stop_loss_price: 3996, take_profit_1_price: 4020 }, config, { ...market, atr_anchor: 15 })
    expect(result).toMatchObject({ signal_type: 'hold', recommended_volume: 0, normalization_info: { type: 'sl_widen_min_lot_hold' } })
  })

  it('小时级ATR不可用时失败关闭', () => {
    const result = normalizeAiSignal({
      signal_type: 'buy', confidence: 0.8, recommended_volume: 0.03,
      stop_loss_price: 3990, take_profit_1_price: 4020,
    }, config, { ...market, atr_anchor: 0 })
    expect(result).toMatchObject({
      signal_type: 'hold', recommended_volume: 0,
      normalization_info: { type: 'atr_anchor_unavailable_hold' },
    })
  })

  it('高风险等级不会突破用户最大手数', () => {
    const result = normalizeAiSignal({
      signal_type: 'buy', confidence: 0.8, recommended_volume: 0.08,
      stop_loss_price: 3990, take_profit_1_price: 4020,
    }, { risk_level: 'high', max_position_size: 0.05 }, market)
    expect(result.recommended_volume).toBe(0.05)
  })

  it('低风险等级仍以用户配置作为单笔最大手数', () => {
    const result = normalizeAiSignal({
      signal_type: 'buy', confidence: 0.8, recommended_volume: 0.05,
      stop_loss_price: 3980, take_profit_1_price: 4030,
    }, { risk_level: 'low', max_position_size: 0.05 }, market)
    expect(result.recommended_volume).toBe(0.05)
  })
})

describe('normalizeAiSignal - L5 strict schema', () => {
  const market = { latest_price: 2000, atr_anchor: 10, strategy_score: {}, volatility_pct: 0 }
  const config = { risk_level: 'medium', max_position_size: 0.05 }

  it('keeps a valid AI hold with nullable trade prices and calibrated confidence', () => {
    const result = normalizeAiSignal({
      _inference_source: 'ai', signal_type: 'hold', entry_method: 'observe', confidence: 0.65,
      recommended_volume: 0, stop_loss_price: null, take_profit_1_price: null,
    }, config, market)
    expect(result.signal_type).toBe('hold')
    expect(result.entry_method).toBe('observe')
    expect(result.confidence).toBeGreaterThan(0)
    expect(result.normalization_info?.type).not.toBe('l5_schema_hold')
  })

  it('invalid explicit entry_method degrades to hold instead of market', () => {
    const result = normalizeAiSignal({
      _inference_source: 'ai', signal_type: 'buy', entry_method: 'instant', confidence: 0.8,
      recommended_volume: 0.02, stop_loss_price: 1990, take_profit_1_price: 2020,
    }, config, market)
    expect(result).toMatchObject({ signal_type: 'hold', entry_method: 'observe', recommended_volume: 0, normalization_info: { type: 'l5_schema_hold' } })
  })

  it('degrades a model response that uses an entry method disabled by the strategy', () => {
    const result = normalizeAiSignal({
      _inference_source: 'ai', signal_type: 'buy_limit', entry_method: 'limit', confidence: 0.8,
      recommended_volume: 0.02, limit_price: 1995, stop_loss_price: 1985, take_profit_1_price: 2015,
    }, { ...config, _allowed_entry_methods: ['market'] }, market)
    expect(result).toMatchObject({
      signal_type: 'hold', entry_method: 'observe', recommended_volume: 0,
      normalization_info: { type: 'l5_schema_hold', reason: 'entry_method_not_allowed_by_strategy' },
    })
  })

  it('out-of-platform AI volume degrades to hold without clamping', () => {
    const result = normalizeAiSignal({
      _inference_source: 'ai', signal_type: 'buy', entry_method: 'market', confidence: 0.8,
      recommended_volume: 0.06, stop_loss_price: 1990, take_profit_1_price: 2020,
    }, config, market)
    expect(result).toMatchObject({ signal_type: 'hold', recommended_volume: 0, normalization_info: { reason: 'ai_volume_out_of_platform_range' } })
  })

  it('uses the configured platform volume range instead of a hard-coded maximum', () => {
    const result = normalizeAiSignal({
      _inference_source: 'ai', signal_type: 'buy', entry_method: 'market', confidence: 0.8,
      recommended_volume: 0.08, stop_loss_price: 1990, take_profit_1_price: 2020,
      recommended_take_profit_tier: 1,
    }, { ...config, max_position_size: 0.1, _ai_volume_min: 0.02, _ai_volume_max: 0.1, _ai_volume_step: 0.02 }, market)
    expect(result).toMatchObject({ signal_type: 'buy', recommended_volume: 0.08 })
  })

  it('rejects a volume that is not aligned to the configured platform step', () => {
    const result = normalizeAiSignal({
      _inference_source: 'ai', signal_type: 'buy', entry_method: 'market', confidence: 0.8,
      recommended_volume: 0.07, stop_loss_price: 1990, take_profit_1_price: 2020,
      recommended_take_profit_tier: 1,
    }, { ...config, max_position_size: 0.1, _ai_volume_min: 0.02, _ai_volume_max: 0.1, _ai_volume_step: 0.02 }, market)
    expect(result).toMatchObject({ signal_type: 'hold', normalization_info: { reason: 'ai_volume_out_of_platform_range' } })
  })

  it('requires an explicit AI take-profit recommendation for executable signals', () => {
    const result = normalizeAiSignal({
      _inference_source: 'ai', signal_type: 'buy', entry_method: 'market', confidence: 0.8,
      recommended_volume: 0.02, stop_loss_price: 1990, take_profit_1_price: 2020,
    }, config, market)
    expect(result).toMatchObject({
      signal_type: 'hold', recommended_volume: 0,
      normalization_info: { type: 'l5_schema_hold', reason: 'invalid_recommended_take_profit_tier' },
    })
  })

  it('degrades a sell stop-limit whose trigger is above the current market price', () => {
    const result = normalizeAiSignal({
      _inference_source: 'ai', signal_type: 'sell_stop_limit', entry_method: 'stop_limit', confidence: 0.8,
      recommended_volume: 0.02, limit_price: 2005, stop_limit_price: 2010,
      stop_loss_price: 2020, take_profit_1_price: 1980, recommended_take_profit_tier: 1,
    }, { ...config, _allowed_entry_methods: ['stop_limit'] }, market)
    expect(result).toMatchObject({
      signal_type: 'hold', entry_method: 'observe', recommended_volume: 0,
      decision_summary: '挂单价格结构不符合当前行情规则，本次暂不执行。',
      normalization_info: {
        reason: 'pending_price_direction_invalid', trigger_price: 2005, reference_price: 2000,
      },
    })
  })

  it('degrades a sell stop-limit whose post-trigger limit is below its trigger', () => {
    const result = normalizeAiSignal({
      _inference_source: 'ai', signal_type: 'sell_stop_limit', entry_method: 'stop_limit', confidence: 0.8,
      recommended_volume: 0.02, limit_price: 1995, stop_limit_price: 1990,
      stop_loss_price: 2020, take_profit_1_price: 1980, recommended_take_profit_tier: 1,
    }, { ...config, _allowed_entry_methods: ['stop_limit'] }, market)
    expect(result).toMatchObject({
      signal_type: 'hold', entry_method: 'observe', recommended_volume: 0,
      normalization_info: { reason: 'stop_limit_price_relation_invalid' },
    })
  })

  it('keeps a valid sell stop-limit and stores its validity as UTC', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-17T04:00:00Z'))
    try {
      const result = normalizeAiSignal({
        _inference_source: 'ai', signal_type: 'sell_stop_limit', entry_method: 'stop_limit', confidence: 0.8,
        recommended_volume: 0.02, limit_price: 1995, stop_limit_price: 1998, pending_valid_minutes: 240,
        stop_loss_price: 2020, take_profit_1_price: 1980, recommended_take_profit_tier: 1,
      }, { ...config, _allowed_entry_methods: ['stop_limit'] }, market)
      expect(result.signal_type).toBe('sell_stop_limit')
      expect(result.pending_valid_until).toBe('2026-07-17 08:00:00')
      expect(formatPendingValidUntilUtc(240)).toBe('2026-07-17 08:00:00')
    } finally {
      vi.useRealTimers()
    }
  })
})
