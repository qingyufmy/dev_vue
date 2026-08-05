import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { requestJsonObject, maybeAiSignal, normalizeAiSignal, buildModelComparisonSignal, buildStrategyOutputFormat, formatPendingValidUntilUtc, validateAiSignalResponse, localizeInferenceNarrative, configuredModelMaxTokens, compactInferenceMarketPayload, extractTokenUsage, modelResponseCompletion, INFERENCE_KLINE_FIELDS } from '../../server/routes/ai/llm.js'
import { compactRates } from '../../server/routes/ai/utils.js'

describe('model output budgets', () => {
  it('uses the configured model profile value for automated and manual inference', () => {
    expect(configuredModelMaxTokens({ _usage:'auto_platform', max_tokens:30000 })).toBe(30000)
    expect(configuredModelMaxTokens({ _usage:'auto_private', max_tokens:150000 })).toBe(150000)
    expect(configuredModelMaxTokens({ _usage:'manual', max_tokens:30000 })).toBe(30000)
    expect(configuredModelMaxTokens({ _usage:'auto_platform' })).toBe(2000)
  })
})

describe('model usage phase accounting contract', () => {
  const source = readFileSync(new URL('../../server/routes/ai/llm.js', import.meta.url), 'utf8')

  it('records the actual request or repair phase for every tracked provider call', () => {
    expect(source).toContain('requestPhase:phase')
    expect(source).toContain("phase:'repair'")
  })

  it('limits adaptive history to primary requests while retaining legacy NULL rows', () => {
    expect(source).toContain("(request_phase = 'request' OR request_phase IS NULL)")
  })
})

describe('compact inference market payload', () => {
  it('keeps every K-line value and count while removing repeated field names', () => {
    const bars = [
      { time:'2026-07-24 10:00:00', time_utc_msc:null, time_server_msc:null, captured_at_utc_msc:null, open:1, high:2, low:0.5, close:1.5, tick_volume:10, spread:null },
      { time:'2026-07-24 11:00:00', time_utc_msc:null, time_server_msc:null, captured_at_utc_msc:null, open:1.5, high:2.5, low:1, close:2, tick_volume:12, spread:null },
    ]
    const original = { strategy_context:{ timeframes:{ H1:{ summary:{}, klines:bars } } } }
    const compacted = compactInferenceMarketPayload(original)
    const frame = compacted.strategy_context.timeframes.H1
    expect(frame.klines).toHaveLength(bars.length)
    expect(compacted.strategy_context.input_encoding.kline_fields).toEqual(INFERENCE_KLINE_FIELDS)
    const expanded = frame.klines.map(values => Object.fromEntries(
      INFERENCE_KLINE_FIELDS.map((field, index) => [field, values[index]])))
    expect(expanded).toEqual(bars)
    expect(original.strategy_context.timeframes.H1.klines).toEqual(bars)
  })

  it('losslessly compacts the current compactRates output including clock and spread fields', () => {
    const bars = compactRates([{
      time:'2026-07-24 10:00:00',
      time_utc_msc:1784868000000,
      time_server_msc:1784878800000,
      captured_at_utc_msc:1784868000500,
      open:'1.234567', high:'1.240001', low:'1.220001', close:'1.230001', tick_volume:'100', spread:'3',
    }])
    const payload = { strategy_context:{ timeframes:{ M15:{ summary:{}, klines:bars } } } }
    const compacted = compactInferenceMarketPayload(payload)
    const frame = compacted.strategy_context.timeframes.M15
    expect(frame.klines[0]).toHaveLength(INFERENCE_KLINE_FIELDS.length)
    const expanded = frame.klines.map(values => Object.fromEntries(
      INFERENCE_KLINE_FIELDS.map((field, index) => [field, values[index]])))
    expect(expanded).toEqual(bars)
    expect(compacted.strategy_context.input_encoding.kline_fields).toEqual(INFERENCE_KLINE_FIELDS)
  })

  it('replaces only exact repeated Chan objects with resolvable references', () => {
    const center = {
      status:'active', lower:3900, upper:4000,
      start_time:'2026-07-20 00:00:00', end_time:'2026-07-24 00:00:00',
      evidence:Array.from({ length:6 }, (_, index) => ({ index, confirmed:true })),
    }
    const payload = { strategy_context:{ timeframes:{ H1:{ klines:[], summary:{ chan:{
      current_center:center,
      latest_center:structuredClone(center),
      active_center:{ ...center, status:'broken_up' },
    } } } } } }
    const compacted = compactInferenceMarketPayload(payload)
    const chan = compacted.strategy_context.timeframes.H1.summary.chan
    expect(chan.current_center).toEqual(center)
    expect(chan.latest_center).toEqual({ $ref:'#/strategy_context/timeframes/H1/summary/chan/current_center' })
    expect(chan.active_center.status).toBe('broken_up')
    expect(compacted.strategy_context.input_encoding.object_refs).toContain('JSON Pointer')
  })

  it('does not compact custom K-line objects with unknown fields', () => {
    const bar = { time:'t', open:1, high:2, low:0, close:1, tick_volume:2, spread:3, broker_note:'custom' }
    const payload = { strategy_context:{ timeframes:{ M5:{ summary:{}, klines:[bar] } } } }
    expect(compactInferenceMarketPayload(payload).strategy_context.timeframes.M5.klines).toEqual([bar])
  })
})

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

  it('leaves same-direction pending quantity to the model instead of imposing a one-order rule', () => {
    const schema = JSON.parse(buildStrategyOutputFormat(null, ['limit']).outputFormat)
    const rendered = JSON.stringify(schema)
    expect(rendered).not.toContain('最多1笔')
    expect(schema.pending_action).toContain('可以同时存在多笔挂单')
    expect(schema.pending_action).toContain('系统不按数量限制')
    expect(schema.pending_action).toContain('none 表示本轮不管理现有挂单')
    expect(schema.pending_action).toContain('keep 表示保留现有挂单且本轮不新增')
  })

  it('requires the model to report usage only for retrieved experience ids', () => {
    const schema = JSON.parse(buildStrategyOutputFormat(null, ['market'], { selectedItemIds:[7, 9] }).outputFormat)
    expect(schema.experience_usage.considered_ids).toEqual([7, 9])
    expect(schema.experience_usage.used_ids).toContain('7、9')
  })

  it('supports short, long and compressed memory references without id collisions', () => {
    const schema = JSON.parse(buildStrategyOutputFormat(null, ['market'], {
      selectedItemIds:[7], selectedRefs:['short:7', 'long:7', 'summary:3'],
    }).outputFormat)
    expect(schema.experience_usage.considered_refs).toEqual(['short:7', 'long:7', 'summary:3'])
  })
})

describe('experience usage normalization', () => {
  it('converts internal Chan enums into direct Chinese explanations', () => {
    expect(localizeInferenceNarrative('agreement=insufficient；H1 为 unreliable_segments，reliability=low'))
      .toBe('多周期方向证据不足；H1 为 线段结构尚不可靠，结构可靠性较低')
    const result = normalizeAiSignal({
      signal_type:'hold', entry_method:'observe', confidence:0.6, recommended_volume:0,
      analysis:'H1缠论趋势为“unreliable_segments”，方向不明确。',
      reasoning:'agreement=insufficient，4H reliability=low。',
    }, { _allowed_entry_methods:['market'] }, { strategy_score:{ trend_strength:0.2 }, volatility_pct:0.1 })
    expect(result.analysis).toContain('H1 尚未形成可靠的确认线段')
    expect(result.reasoning).toBe('多周期方向证据不足，4H 结构可靠性较低。')
    expect(`${result.analysis}${result.reasoning}`).not.toMatch(/agreement|insufficient|unreliable_segments|reliability=/i)
    expect(localizeInferenceNarrative('H4 status=unreliable_segments，window_stable=false，alignment_with_higher=conflict'))
      .toBe('H4 线段结构尚不可靠，结构窗口不稳定，与高周期方向冲突')
    expect(localizeInferenceNarrative('H1 status=segment_history_unresolved，segment_cross_window_unstable'))
      .toBe('H1 历史窗口尚未收敛，暂不确认线段，不同历史窗口的线段边界尚未收敛')
    expect(localizeInferenceNarrative('center_entry_unconfirmed；divergence_evidence_unavailable'))
      .toBe('中枢已确认，但进入段缺少跨窗口共识，仅背驰暂不可判；背驰所需的有效力度证据不足')
    expect(localizeInferenceNarrative('center_cross_window_unstable；forming_evidence_unavailable'))
      .toBe('不同历史窗口对中枢形成核心尚未达成共识；候选背驰所需的有效证据不足')
    expect(localizeInferenceNarrative('structure_anchor_bootstrap_pending'))
      .toBe('结构锚点正在用连续三根已收盘K线确认，暂不使用依赖进入段的背驰与买卖点')
  })

  it('drops hallucinated experience ids from model output', () => {
    const result = normalizeAiSignal({ signal_type:'hold', entry_method:'observe', confidence:0.6, recommended_volume:0,
      experience_usage:{ used_ids:[7, 999], rejected_ids:[8, 998], influence:'经验支持继续等待' } },
    { _allowed_entry_methods:['market'], _experienceSelection:{ source:'platform', selectedItemIds:[7, 8] } },
    { strategy_score:{ trend_strength:0.2 }, volatility_pct:0.1 })
    expect(result.experience_usage).toMatchObject({ source:'platform', considered_ids:[7, 8], used_ids:[7], rejected_ids:[8] })
  })

  it('attributes a uniquely mentioned long-term memory even when the model omits used_refs', () => {
    const result = normalizeAiSignal({ signal_type:'hold', entry_method:'observe', confidence:0.6, recommended_volume:0,
      experience_usage:{ influence:'本次采用长期记忆 #12，继续等待结构确认' } },
    { _allowed_entry_methods:['market'], _experienceSelection:{ source:'personal', selectedItemIds:[], selectedRefs:['long:12', 'summary:4'] } },
    { strategy_score:{ trend_strength:0.2 }, volatility_pct:0.1 })
    expect(result.experience_usage.used_refs).toEqual(['long:12'])
  })
})

describe('model comparison signal isolation', () => {
  const config = { _allowed_entry_methods:['market', 'limit'], _ai_volume_min:0.01, _ai_volume_max:1, _ai_volume_step:0.01 }
  const market = { latest_price:2000 }

  it('preserves a raw trade when live ATR policy would have downgraded it', () => {
    const raw = {
      _inference_source:'ai', signal_type:'buy_limit', entry_method:'limit', confidence:0.8,
      recommended_volume:0.03, limit_price:1995, pending_valid_minutes:60,
      stop_loss_price:1985, take_profit_1_price:2010, recommended_take_profit_tier:1,
    }
    const normalized = {
      ...raw, signal_type:'hold', entry_method:'observe', confidence:0, recommended_volume:0,
      normalization_info:{ type:'atr_anchor_unavailable_hold', reason:'atr_anchor_unavailable_hold' },
    }
    expect(buildModelComparisonSignal(raw, normalized, config, market)).toMatchObject({
      signal_type:'buy_limit', entry_method:'limit', recommended_volume:0.03,
      pending_valid_until:null,
      comparison_validation:{
        status:'valid', execution_eligible:true,
        warnings:['atr_anchor_unavailable_hold'], live_risk_bypassed:true,
      },
    })
  })

  it('keeps the raw direction but blocks replay when order constraints are invalid', () => {
    const raw = {
      _inference_source:'ai', signal_type:'sell_limit', entry_method:'limit', confidence:0.75,
      recommended_volume:0.02, limit_price:1990,
      stop_loss_price:2010, take_profit_1_price:1970, recommended_take_profit_tier:1,
    }
    const normalized = {
      ...raw, signal_type:'hold', entry_method:'observe', confidence:0, recommended_volume:0,
      normalization_info:{ type:'l5_schema_hold', reason:'pending_price_direction_invalid' },
    }
    const result = buildModelComparisonSignal(raw, normalized, config, market)
    expect(result.signal_type).toBe('sell_limit')
    expect(result.comparison_validation.status).toBe('invalid')
    expect(result.comparison_validation.execution_eligible).toBe(false)
    expect(result.comparison_validation.errors).toContain('pending_price_direction_invalid')
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
    const onProviderActivity = vi.fn()
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get:() => 'req-success' },
      json: () => Promise.resolve({ choices: [{ message: { content: '{"key": "value"}' } }] })
    })

    const result = await requestJsonObject({
      url: 'https://api.example.test',
      apiKey: 'test-key',
      model: 'test-model',
      temperature: 0.7,
      maxTokens: 2000,
      messages: [{ role: 'user', content: 'test' }],
      onProviderActivity,
    })

    expect(result).toEqual({ key: 'value' })
    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(mockFetch.mock.calls[0][1].redirect).toBe('error')
    expect(onProviderActivity).toHaveBeenCalledWith(expect.objectContaining({
      state:'response_headers', providerRequestId:'req-success', responseReceived:true,
    }))
  })

  it('records split token usage without learning output budget from total tokens', () => {
    expect(extractTokenUsage({ usage:{ prompt_tokens:1200, completion_tokens:300, total_tokens:1500,
      prompt_tokens_details:{ cached_tokens:500 }, completion_tokens_details:{ reasoning_tokens:180 } } }))
      .toEqual({ inputTokens:1200, outputTokens:300, reasoningTokens:180, cachedTokens:500, totalTokens:1500 })
  })

  it('fails closed on Chat Completions length truncation before JSON validation or repair', async () => {
    mockFetch.mockResolvedValue({ ok:true, status:200, headers:{ get:() => 'req-truncated' },
      json:() => Promise.resolve({ choices:[{ finish_reason:'length', message:{ content:'{"ok":true}' } }],
        usage:{ prompt_tokens:10, completion_tokens:20, total_tokens:30 } }) })
    await expect(requestJsonObject({
      url:'https://api.example.test', apiKey:'test-key', model:'test-model', maxTokens:20,
      messages:[{ role:'user', content:'test' }],
    })).rejects.toMatchObject({ message:'output_truncated', code:'output_truncated', finishReason:'length' })
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('recognizes Responses incomplete_details as truncation', () => {
    expect(modelResponseCompletion({ status:'incomplete', incomplete_details:{ reason:'max_output_tokens' } }, 'responses'))
      .toMatchObject({ truncated:true, finishReason:'incomplete' })
  })

  it('does not issue an empty retry or format repair when follow-up requests are disabled', async () => {
    mockFetch.mockResolvedValue({ ok:true, status:200,
      json:() => Promise.resolve({ choices:[{ finish_reason:'stop', message:{ content:'invalid json' } }] }) })
    await expect(requestJsonObject({
      url:'https://api.example.test', apiKey:'test-key', model:'test-model', maxTokens:2000,
      messages:[{ role:'user', content:'test' }], allowFollowupRequests:false,
    })).rejects.toThrow()
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('does not start a repair when the business result will expire before the safety window', async () => {
    mockFetch.mockResolvedValue({ ok:true, status:200,
      json:() => Promise.resolve({ choices:[{ finish_reason:'stop', message:{ content:'invalid json' } }] }) })
    await expect(requestJsonObject({
      url:'https://api.example.test', apiKey:'test-key', model:'test-model', maxTokens:2000,
      messages:[{ role:'user', content:'test' }], followupValidUntilMs:Date.now() + 10_000,
    })).rejects.toMatchObject({ code:'model_task_result_expired' })
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('does not expose raw provider response fragments when content is empty', async () => {
    mockFetch.mockResolvedValue({ ok:true, status:200,
      json:() => Promise.resolve({ secret:'do-not-leak', choices:[{ message:{ content:'' } }] }) })
    let failure
    try {
      await requestJsonObject({
        url:'https://api.example.test', apiKey:'test-key', model:'test-model', maxTokens:2000,
        messages:[{ role:'user', content:'test' }], allowFollowupRequests:false,
      })
    } catch (error) { failure = error }
    expect(failure).toMatchObject({ code:'ai_response_missing_json_object', httpStatus:200 })
    expect(String(failure?.message)).not.toContain('do-not-leak')
  })

  it('DeepSeek 请求默认启用 JSON Object 模式', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ choices: [{ message: { content: '{"ok":true}' } }] }),
    })

    await requestJsonObject({
      url:'https://api.deepseek.com/chat/completions', apiKey:'test-key',
      provider:'deepseek', model:'deepseek-v4-pro', maxTokens:2000,
      messages:[{ role:'system', content:'只返回 JSON' }, { role:'user', content:'test' }],
    })

    const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(requestBody.response_format).toEqual({ type:'json_object' })
  })

  it.each([
    [true, 12345],
    [false, 6789],
  ])('DeepSeek thinking=%s sends the selected Chat output budget', async (thinkingEnabled, selectedMaxOutputTokens) => {
    mockFetch.mockResolvedValue({
      ok:true,
      status:200,
      json:() => Promise.resolve({ choices:[{ message:{ content:'{"ok":true}' } }] }),
    })

    await requestJsonObject({
      url:'https://api.deepseek.com/chat/completions', apiKey:'test-key', provider:'deepseek',
      model:'deepseek-v4-pro', maxTokens:selectedMaxOutputTokens, thinkingEnabled,
      reasoningEffort:'high', messages:[{ role:'user', content:'test' }],
    })

    const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(requestBody.max_tokens).toBe(selectedMaxOutputTokens)
    expect(requestBody.response_format).toEqual({ type:'json_object' })
    if (thinkingEnabled) {
      expect(requestBody.thinking).toEqual({ type:'enabled' })
      expect(requestBody.reasoning_effort).toBe('high')
    } else {
      expect(requestBody.thinking).toBeUndefined()
      expect(requestBody.reasoning_effort).toBeUndefined()
    }
  })

  it('does not add a max_tokens field to an unknown thinking gateway', async () => {
    mockFetch.mockResolvedValue({
      ok:true,
      status:200,
      json:() => Promise.resolve({ choices:[{ message:{ content:'{"ok":true}' } }] }),
    })

    await requestJsonObject({
      url:'https://example.test/v1/chat/completions', apiKey:'test-key', provider:'openai_compatible',
      model:'custom-thinking-model', maxTokens:4321, thinkingEnabled:true,
      messages:[{ role:'user', content:'test' }],
    })

    const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(requestBody).not.toHaveProperty('max_tokens')
    expect(requestBody.reasoning_effort).toBe('max')
  })

  it('DeepSeek JSON Mode 空正文会重试且不会解析思考内容', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok:true, status:200,
        json:() => Promise.resolve({ choices:[{ message:{ content:'', reasoning_content:'这不是 JSON 正文' } }] }),
      })
      .mockResolvedValueOnce({
        ok:true, status:200,
        json:() => Promise.resolve({ choices:[{ message:{ content:'{"status":"ok"}' } }] }),
      })

    const result = await requestJsonObject({
      url:'https://api.deepseek.com/chat/completions', apiKey:'test-key',
      provider:'deepseek', model:'deepseek-v4-pro', maxTokens:2000,
      messages:[{ role:'system', content:'只返回 JSON' }, { role:'user', content:'test' }],
    })

    expect(result).toEqual({ status:'ok' })
    expect(mockFetch).toHaveBeenCalledTimes(2)
    expect(JSON.parse(mockFetch.mock.calls[1][1].body).response_format).toEqual({ type:'json_object' })
  })

  it('未知 OpenAI 兼容供应商不会被强塞 JSON Mode 参数', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ choices: [{ message: { content: '{"ok":true}' } }] }),
    })

    await requestJsonObject({
      url:'https://example.test/v1/chat/completions', apiKey:'test-key',
      provider:'openai_compatible', model:'custom-model', maxTokens:2000,
      messages:[{ role:'user', content:'test' }],
    })

    const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(requestBody).not.toHaveProperty('response_format')
    expect(requestBody).not.toHaveProperty('text')
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

    const onProviderRequest = vi.fn()
    const onProviderUsage = vi.fn()
    const result = await requestJsonObject({
      url: 'https://api.example.test',
      apiKey: 'test-key',
      model: 'test-model',
      temperature: 0.7,
      maxTokens: 2000,
      messages: [{ role: 'user', content: 'test' }],
      onProviderRequest,
      onProviderUsage,
    })

    expect(result).toEqual({ fixed: true })
    expect(mockFetch).toHaveBeenCalledTimes(2)
    expect(onProviderRequest.mock.calls.map(([event]) => event.phase)).toEqual(['request', 'repair'])
    expect(onProviderUsage).toHaveBeenCalledTimes(2)
    expect(onProviderUsage.mock.calls.every(([event]) =>
      event.status === 'success' && event.tokenCount > 0)).toBe(true)
    expect(onProviderUsage.mock.calls.every(([event]) =>
      event.requestBytes > 0 && event.responseBytes > 0 && event.durationMs >= 0)).toBe(true)
  })

  it('does not send an untracked provider request when the durable submitted callback fails', async () => {
    const onProviderRequest = vi.fn().mockRejectedValue(new Error('model_task_fence_lost'))
    await expect(requestJsonObject({
      url:'https://api.example.test', apiKey:'test-key', model:'test-model', maxTokens:2000,
      messages:[{ role:'user', content:'test' }], onProviderRequest,
    })).rejects.toThrow('model_task_fence_lost')
    expect(onProviderRequest).toHaveBeenCalledTimes(1)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('surfaces a durable completion callback failure without emitting it twice', async () => {
    mockFetch.mockResolvedValue({ ok:true, status:200,
      json:() => Promise.resolve({ choices:[{ message:{ content:'{"ok":true}' } }] }),
    })
    const onProviderUsage = vi.fn().mockRejectedValue(new Error('model_task_attempt_fence_lost'))
    await expect(requestJsonObject({
      url:'https://api.example.test', apiKey:'test-key', model:'test-model', maxTokens:2000,
      messages:[{ role:'user', content:'test' }], onProviderUsage,
    })).rejects.toThrow('model_task_attempt_fence_lost')
    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(onProviderUsage).toHaveBeenCalledTimes(1)
  })

  it('JSON 结构校验失败时要求模型修复并再次校验', async () => {
    const largeMarketPayload = `大量 K 线与账户行情，不应进入精简修复请求：${'K'.repeat(100_000)}`
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ choices: [{ message: { content: '{"summary":"缺少必填字段"}' } }] })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ choices: [{ message: { content: '{"period_summary":"字段已补齐"}' } }] })
      })

    const validateObject = vi.fn((value, validation) => {
      if (!value.period_summary) throw new Error('daily_review_summary_missing')
      return { ...value, validation_phase:validation.phase }
    })
    const result = await requestJsonObject({
      url: 'https://api.example.test', apiKey: 'test-key', model: 'test-model', temperature: 0.2,
      maxTokens: 2000,
      messages:[
        { role:'system', content:'完整策略和输出要求，不应进入精简修复请求' },
        { role:'user', content:largeMarketPayload },
      ],
      validateObject,
      repairContext:{
        outputFormat:'{"period_summary":"必填字符串"}',
        requiredCoverage:{ position_management_group_ids:['position_group_01'] },
      },
    })

    expect(result).toEqual({ period_summary:'字段已补齐', validation_phase:'repair' })
    expect(validateObject).toHaveBeenCalledTimes(2)
    expect(validateObject.mock.calls.map(([, validation]) => validation.phase)).toEqual(['initial', 'repair'])
    expect(mockFetch).toHaveBeenCalledTimes(2)
    const repairBody = JSON.parse(mockFetch.mock.calls[1][1].body)
    expect(repairBody.messages).toHaveLength(2)
    expect(JSON.stringify(repairBody.messages)).not.toContain('大量 K 线')
    expect(JSON.stringify(repairBody.messages)).not.toContain('完整策略')
    expect(mockFetch.mock.calls[1][1].body.length).toBeLessThan(mockFetch.mock.calls[0][1].body.length / 10)
    const repairPayload = JSON.parse(repairBody.messages[1].content)
    expect(repairPayload.validation_error).toBe('daily_review_summary_missing')
    expect(repairPayload.output_contract).toContain('period_summary')
    expect(repairPayload.required_coverage.position_management_group_ids).toEqual(['position_group_01'])
    expect(repairPayload.original_output).toBe('{"summary":"缺少必填字段"}')
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

  it('records a provider HTTP rejection for the durable tracker callback', async () => {
    mockFetch.mockResolvedValue({ ok:false, status:429, headers:{ get:() => 'req-429' } })
    const onProviderRequest = vi.fn()
    const onProviderUsage = vi.fn()
    await expect(requestJsonObject({
      url:'https://api.example.test', apiKey:'test-key', model:'test-model', maxTokens:2000,
      messages:[{ role:'user', content:'test' }], onProviderRequest, onProviderUsage,
    })).rejects.toMatchObject({ providerStatus:429, providerRequestId:'req-429', httpStatus:429 })
    expect(onProviderRequest).toHaveBeenCalledTimes(1)
    expect(onProviderUsage).toHaveBeenCalledWith(expect.objectContaining({
      status:'error', providerRequestId:'req-429', httpStatus:429, responseReceived:true,
    }))
  })

  it('records a post-submit network loss without inventing a request id or HTTP status', async () => {
    mockFetch.mockRejectedValue(new Error('socket closed'))
    const onProviderRequest = vi.fn()
    const onProviderUsage = vi.fn()
    await expect(requestJsonObject({
      url:'https://api.example.test', apiKey:'test-key', model:'test-model', maxTokens:2000,
      messages:[{ role:'user', content:'test' }], onProviderRequest, onProviderUsage,
    })).rejects.toThrow('socket closed')
    expect(onProviderUsage).toHaveBeenCalledWith(expect.objectContaining({
      status:'error', providerRequestId:null, httpStatus:null, responseReceived:false,
    }))
  })

  it('aborts an active provider request when the caller cancels it', async () => {
    const controller = new AbortController()
    let markFetchStarted
    const fetchStarted = new Promise(resolve => { markFetchStarted = resolve })
    mockFetch.mockImplementationOnce((_url, options) => new Promise((_resolve, reject) => {
      markFetchStarted()
      if (options.signal.aborted) {
        reject(options.signal.reason)
        return
      }
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
    }))

    const request = requestJsonObject({
      url: 'https://api.example.test',
      apiKey: 'test-key',
      model: 'test-model',
      maxTokens: 2000,
      messages: [{ role: 'user', content: 'test' }],
      signal: controller.signal,
    })
    await fetchStarted
    controller.abort(new Error('history_compare_cancelled'))

    await expect(request).rejects.toThrow('history_compare_cancelled')
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
      provider: 'volcengine_agent_plan',
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
    expect(requestBody.text).toEqual({ format:{ type:'json_object' } })
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
      apiKey: 'test-key', provider:'volcengine_agent_plan', model: 'ark-code-latest', temperature: 0.3, maxTokens: 2000,
      messages: [{ role: 'user', content: 'test' }],
      protocol: 'responses', thinkingEnabled: false,
    })

    expect(result).toEqual({ fixed: true })
    expect(mockFetch).toHaveBeenCalledTimes(2)
    const repairBody = JSON.parse(mockFetch.mock.calls[1][1].body)
    expect(repairBody.input.map(item => item.role)).toEqual(['user', 'assistant', 'user'])
    expect(repairBody.temperature).toBe(0)
    expect(repairBody.text).toEqual({ format:{ type:'json_object' } })
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

  it('explicitly disables Kimi Code thinking without sending temperature', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ choices: [{ message: { content: '{"ok":true}' } }] }),
    })
    await requestJsonObject({
      url: 'https://api.kimi.com/coding/v1/chat/completions',
      apiKey: 'kimi-key', provider: 'kimi_code', model: 'k3', temperature: 0.3,
      maxTokens: 30000, thinkingEnabled: false, reasoningEffort: 'max',
      messages: [{ role: 'user', content: 'test' }],
    })
    const body = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(body.thinking).toEqual({ type: 'disabled' })
    expect(body.max_tokens).toBe(30000)
    expect(body).not.toHaveProperty('temperature')
  })

  it('maps provider HTTP 429 to the model quota exhaustion contract', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 429 })
    await expect(requestJsonObject({
      url: 'https://api.kimi.com/coding/v1/chat/completions',
      apiKey: 'kimi-key', provider: 'kimi_code', model: 'kimi-for-coding', maxTokens: 2000,
      thinkingEnabled: true, messages: [],
    })).rejects.toMatchObject({
      message:'model_quota_exhausted',
      code:'model_quota_exhausted',
      providerCode:'kimi_code_rate_limited',
      providerStatus:429,
    })
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

  it('requires a concrete reason when the model cancels an existing pending order', () => {
    expect(() => validateAiSignalResponse({
      ...hold, pending_action:'cancel', management_direction:'buy', pending_action_reason:'',
    }, ['market'])).toThrow('ai_response_pending_action_reason_required')

    const legacy = {
      ...hold, pending_action:'cancel', management_direction:'buy',
      cancel_pending:[{ symbol:'XAUUSD', reason:'M15 跌破 4102 支撑，原买入依据已经失效' }],
    }
    expect(validateAiSignalResponse(legacy, ['market']).pending_action_reason)
      .toBe('M15 跌破 4102 支撑，原买入依据已经失效')
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

  it('routes Kimi Code through its subscription endpoint with an adaptive budget below the configured hard cap', async () => {
    vi.clearAllMocks()
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ choices: [{ message: { content: JSON.stringify({
        signal_type: 'hold', confidence: 0.7, recommended_volume: 0,
        analysis: 'test', reasoning: 'test', cancel_pending: [],
      }) } }] }),
    })
    await maybeAiSignal(null, {
      api_key_encrypted: 'key', api_provider: 'kimi_code', model_name: 'k3',
      thinking_enabled: false, max_tokens: 30000, _usage: 'auto_platform',
    }, { symbol: 'XAUUSD', timeframe: 'M5', strategy_score: {} })
    expect(mockFetch.mock.calls[0][0]).toBe('https://api.kimi.com/coding/v1/chat/completions')
    const body = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(body.thinking.type).toBe('disabled')
    expect(body.max_tokens).toBe(2000)
  })

  it('does not turn an externally cancelled inference into a HOLD signal', async () => {
    vi.clearAllMocks()
    const controller = new AbortController()
    mockFetch.mockImplementationOnce((_url, options) => {
      controller.abort(new Error('history_compare_cancelled'))
      return Promise.reject(options.signal.reason)
    })

    await expect(maybeAiSignal(null, {
      api_key_encrypted: 'key',
      api_provider: 'deepseek',
      model_name: 'deepseek-chat',
      thinking_enabled: false,
      _abortSignal: controller.signal,
    }, { symbol: 'XAUUSD', timeframe: 'M5', strategy_score: {} }))
      .rejects.toThrow('history_compare_cancelled')
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

  it('waits for inference preparation persistence before sending the provider request', async () => {
    mockFetch.mockResolvedValue({
      ok:true,
      json:() => Promise.resolve({ choices:[{ message:{ content:JSON.stringify({
        signal_type:'hold', entry_method:'observe', confidence:0.6, recommended_volume:0,
        analysis:'等待', reasoning:'预算记录完成',
      }) } }] }),
    })
    let release
    const persisted = new Promise(resolve => { release = resolve })
    const request = maybeAiSignal(null, {
      api_key_encrypted:'test-key', api_provider:'deepseek', model_name:'deepseek-chat',
      _onInferencePrepared:async evidence => {
        expect(evidence.modelTaskBudget.selectedMaxOutputTokens).toBeGreaterThan(0)
        await persisted
      },
    }, { symbol:'XAUUSD', timeframe:'M5', latest_price:2000, strategy_context:{ timeframes:{} } })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(mockFetch).not.toHaveBeenCalled()
    release()
    await request
    expect(mockFetch).toHaveBeenCalledTimes(1)
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

  it('模型对比快照重放使用原始提示词而不是重新渲染当前行情', async () => {
    mockFetch.mockResolvedValue({
      ok:true,
      json:() => Promise.resolve({ choices:[{ message:{ content:JSON.stringify({
        signal_type:'hold', entry_method:'observe', confidence:0.6, recommended_volume:0,
        analysis:'等待确认', reasoning:'原始证据不足',
      }) } }] }),
    })
    let evidence
    await maybeAiSignal(null, {
      api_key_encrypted:'test-key', api_provider:'deepseek', model_name:'deepseek-chat',
      _comparison_mode:true,
      _comparison_replay_system_prompt:'stored system prompt',
      _comparison_replay_user_prompt:'stored user prompt',
      _comparison_replay_output_schema_version:'stored-schema-v4',
      _onInferencePrepared:value => { evidence = value },
    }, { symbol:'XAUUSD', timeframe:'M5', latest_price:2000, strategy_context:{ timeframes:{} } })

    const body = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(body.messages).toEqual([
      { role:'system', content:'stored system prompt' },
      { role:'user', content:'stored user prompt' },
    ])
    expect(evidence).toMatchObject({
      systemPrompt:'stored system prompt',
      userPrompt:'stored user prompt',
      outputSchemaVersion:'stored-schema-v4',
    })
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
      _market_only: true, _memoryContext: 'MEMORY_LEAK_MARKER',
      _onInferencePrepared: value => { evidence = value },
    }
    const market = {
      standard_symbol: 'XAUUSD', symbol: 'XAUUSD', timeframe: 'M5', latest_price: 2000,
      atr_14: 10, ai_volume_range: { min: 0.01, max: 0.05 }, strategy_context: { timeframes: {} },
    }
    await maybeAiSignal(null, config, market)
    expect(evidence.systemPrompt).toContain('共享市场推理边界')
    expect(evidence.systemPrompt).not.toContain('\u6682\u4e0d\u5efa\u8bae\u81ea\u52a8\u5e73\u4ed3')
    expect(evidence.userPrompt).not.toContain('"ai_volume_range"')
    expect(evidence.userPrompt).not.toContain('account')
    expect(evidence.userPrompt).not.toContain('positions')
    expect(evidence.userPrompt).not.toContain('MEMORY_LEAK_MARKER')
    expect(JSON.stringify(evidence)).not.toContain('must-not-leak')
    expect(evidence.outputSchemaVersion).toMatch(/^[a-f0-9]{64}$/)
  })

  it('preserves every platform strategy reference position and pending order', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ choices: [{ message: { content: JSON.stringify({
        signal_type: 'hold', entry_method: 'observe', confidence: 0.6, recommended_volume: 0,
        stop_loss_price: null, take_profit_1_price: null, analysis: '等待', reasoning: '逐笔评估参考组合',
      }) } }] }),
    })
    let evidence
    await maybeAiSignal(null, {
      api_key_encrypted: 'test-key', api_provider: 'deepseek', model_name: 'deepseek-chat',
      _market_only: true, _onInferencePrepared: value => { evidence = value },
    }, {
      symbol: 'XAUUSD', standard_symbol: 'XAUUSD', timeframe: 'M5', latest_price: 2000,
      strategy_context: { timeframes: {} },
      strategy_reference_portfolio: {
        role: 'platform_strategy_reference_portfolio', strategy_id: 7,
        positions: [
          { reference_id: 'outcome:701', side: 'buy', entry_price: 1990 },
          { reference_id: 'outcome:702', side: 'buy', entry_price: 1980 },
        ],
        pending_orders: [
          { reference_id: 'outcome:801', side: 'buy', trigger_price: 1970 },
          { reference_id: 'outcome:802', side: 'buy', trigger_price: 1960 },
          { reference_id: 'outcome:803', side: 'sell', trigger_price: 2010 },
        ],
      },
    })
    const payload = JSON.parse(evidence.userPrompt.replace('市场数据 JSON：\n', ''))
    expect(payload.strategy_reference_portfolio.positions.map(item => item.reference_id))
      .toEqual(['outcome:701', 'outcome:702'])
    expect(payload.strategy_reference_portfolio.pending_orders.map(item => item.reference_id))
      .toEqual(['outcome:801', 'outcome:802', 'outcome:803'])
  })

  it('does not discourage automatic close in private portfolio boundaries', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ choices: [{ message: { content: JSON.stringify({
        signal_type: 'hold', entry_method: 'observe', confidence: 0.6, recommended_volume: 0,
        stop_loss_price: null, take_profit_1_price: null, analysis: '等待', reasoning: '没有明确优势',
      }) } }] }),
    })
    let evidence
    await maybeAiSignal(null, {
      api_key_encrypted: 'test-key', api_provider: 'deepseek', model_name: 'deepseek-chat',
      _include_portfolio_context: true, _onInferencePrepared: value => { evidence = value },
    }, {
      symbol: 'XAUUSD', timeframe: 'M5', latest_price: 2000,
      account: { balance: 10000 }, positions: [], pending_orders: [], strategy_context: { timeframes: {} },
    })
    expect(evidence.systemPrompt).toContain('私有策略账户上下文')
    expect(evidence.systemPrompt).not.toContain('\u6682\u4e0d\u5efa\u8bae\u81ea\u52a8\u5e73\u4ed3')
  })

  it('passes every live position and pending order to private portfolio inference', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ choices: [{ message: { content: JSON.stringify({
        signal_type: 'hold', entry_method: 'observe', confidence: 0.6, recommended_volume: 0,
        stop_loss_price: null, take_profit_1_price: null, analysis: '等待', reasoning: '逐笔评估',
      }) } }] }),
    })
    let evidence
    await maybeAiSignal(null, {
      api_key_encrypted: 'test-key', api_provider: 'deepseek', model_name: 'deepseek-chat',
      _include_portfolio_context: true, _onInferencePrepared: value => { evidence = value },
    }, {
      symbol: 'XAUUSD', timeframe: 'M5', latest_price: 2000,
      account: { balance: 10000 },
      positions: { total_positions: 2, details: [{ ticket: 701, type: 'buy' }, { ticket: 702, type: 'buy' }] },
      pending_orders: [
        { ticket: 801, pending_type: 'buy_limit', price: 1990 },
        { ticket: 802, pending_type: 'buy_limit', price: 1980 },
        { ticket: 803, pending_type: 'sell_limit', price: 2010 },
      ],
      strategy_context: { timeframes: {} },
    })
    const payload = JSON.parse(evidence.userPrompt.replace('市场数据 JSON：\n', ''))
    expect(payload.positions.details.map(item => item.ticket)).toEqual([701, 702])
    expect(payload.pending_orders.map(item => item.ticket)).toEqual([801, 802, 803])
  })

  it('keeps personal memory content out of the system prompt and sends it as untrusted user data', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ choices: [{ message: { content: JSON.stringify({
        signal_type: 'hold', entry_method: 'observe', confidence: 0.6, recommended_volume: 0,
        analysis: '等待', reasoning: '当前没有明确优势',
      }) } }] }),
    })
    const memoryMarker = 'MEMORY_INJECTION_MARKER_IGNORE_STRATEGY'
    const memoryContext = `\n\n<user_confirmed_experience>\n[{"lesson":"${memoryMarker}"}]\n</user_confirmed_experience>`
    let evidence

    await maybeAiSignal(null, {
      api_key_encrypted: 'test-key', api_provider: 'deepseek', model_name: 'deepseek-chat',
      _memoryContext: memoryContext, _onInferencePrepared: value => { evidence = value },
    }, {
      symbol: 'XAUUSD', timeframe: 'M5', latest_price: 2000,
      account: { balance: 10000 }, positions: [], pending_orders: [], strategy_context: { timeframes: {} },
    })

    const body = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(body.messages[0].content).toContain('个人记忆数据边界')
    expect(body.messages[0].content).not.toContain(memoryMarker)
    expect(body.messages[1].content).toContain(memoryMarker)
    const userPayload = JSON.parse(body.messages[1].content.replace('市场数据 JSON：\n', ''))
    expect(userPayload.user_confirmed_experience).toContain(memoryMarker)
    expect(evidence.systemPrompt).not.toContain(memoryMarker)
    expect(evidence.userPrompt).toContain(memoryMarker)
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
    expect(body.messages[0].content).toContain('连续三条已确认线段')
    expect(body.messages[0].content).toContain('候选线段、单笔重叠和未确认结构不得称为中枢')
    expect(body.messages[0].content).toContain('bi_center_count')
    expect(body.messages[0].content).toContain('segment_history_unresolved')
    expect(body.messages[0].content).toContain('必须区分“结构拓扑可靠”和“绝对时间定位精度”')
    expect(body.messages[0].content).toContain('structure_topology_reliable=true')
    expect(body.messages[0].content).toContain('不得仅因 time_location_reliable=false')
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
  it('preserves a model-provided tight SL for the versioned risk gate', () => {
    const result = normalizeAiSignal({
      signal_type: 'buy_limit', confidence: 0.8, recommended_volume: 0.03, limit_price: 3980,
      stop_loss_price: 3975, take_profit_1_price: 4000
    }, config, market)
    expect(result.stop_loss_price).toBe(3975)
    expect(result.recommended_volume).toBe(0.05)
    expect(result.position_size_tier).toBe('light')
    expect(result.normalization_info?.type).not.toBe('sl_widened')
  })

  it('使用小时级锚点派生止损和三档止盈', () => {
    const result = normalizeAiSignal({ signal_type: 'buy', confidence: 0.8, recommended_volume: 0.03 }, config, { ...market, atr_anchor: 15, atr_anchor_tf: 'H1' })
    expect(result.stop_loss_price).toBe(3977.5)
    expect(result.take_profit_1_price).toBe(4033.75)
    expect(result.take_profit_2_price).toBe(4056.25)
    expect(result.take_profit_3_price).toBe(4090)
  })

  it('模型给出的远止损保留给版本化风控判断', () => {
    const result = normalizeAiSignal({ signal_type: 'buy', confidence: 0.8, recommended_volume: 0.03, stop_loss_price: 3940, take_profit_1_price: 4020 }, config, { ...market, atr_anchor: 15 })
    expect(result).toMatchObject({ signal_type: 'buy', recommended_volume: 0.05, position_size_tier:'light', stop_loss_price:3940 })
  })

  it('不会因为模型止损较近而改写手数或降级观望', () => {
    const result = normalizeAiSignal({ signal_type: 'buy', confidence: 0.8, recommended_volume: 0.03, stop_loss_price: 3996, take_profit_1_price: 4020 }, config, { ...market, atr_anchor: 15 })
    expect(result).toMatchObject({ signal_type: 'buy', recommended_volume: 0.05, position_size_tier:'light', stop_loss_price:3996 })
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

  it('keeps the localized evidence for an AI pending-order cancellation', () => {
    const result = normalizeAiSignal({
      _inference_source:'ai', signal_type:'hold', entry_method:'observe', confidence:0.72,
      position_size_tier:'observe', position_size_reason:'不新增仓位', position_action:'observe',
      pending_action:'cancel', management_direction:'buy',
      pending_action_reason:'M15 已跌破 4102 支撑，原买入挂单的结构前提不再成立',
      analysis:'短周期结构转弱', reasoning:'原挂单依赖的支撑已经失守',
    }, config, market)
    expect(result).toMatchObject({
      signal_type:'hold', pending_action:'cancel', management_direction:'buy',
      pending_action_reason:'M15 已跌破 4102 支撑，原买入挂单的结构前提不再成立',
    })
  })

  it('turns a trade-shaped no-add decision into hold while preserving non-executable candidate levels', () => {
    const result = normalizeAiSignal({
      _inference_source:'ai', signal_type:'buy_limit', entry_method:'limit', confidence:0.8,
      position_size_tier:'probe', position_size_reason:'等待回踩', position_action:'hold_no_add',
      pending_action:'none', management_direction:'none', limit_price:1995,
      stop_loss_price:1985, take_profit_1_price:2010, recommended_take_profit_tier:1,
      analysis:'偏多但不加仓', reasoning:'已有同向持仓',
    }, { ...config, _allowed_entry_methods:['limit'] }, market)
    expect(result).toMatchObject({
      signal_type:'hold', entry_method:'observe', recommended_volume:0,
      position_size_tier:'observe', position_action:'hold_no_add', limit_price:null,
      stop_loss_price:null, take_profit_1_price:null,
      decision_summary:'当前已有同向持仓，策略建议继续持有，暂不加仓。',
      candidate_entry:{ signal_type:'buy_limit', entry_method:'limit', entry_price:1995, stop_loss_price:1985, take_profit_1_price:2010 },
      normalization_info:{ type:'existing_position_hold_no_add', original_signal_type:'buy_limit' },
    })
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

  it('ignores a legacy absolute model volume and uses the configured execution ceiling', () => {
    const result = normalizeAiSignal({
      _inference_source: 'ai', signal_type: 'buy', entry_method: 'market', confidence: 0.8,
      recommended_volume: 0.06, stop_loss_price: 1990, take_profit_1_price: 2020,
      recommended_take_profit_tier: 1,
    }, config, market)
    expect(result).toMatchObject({ signal_type: 'buy', recommended_volume:0.05, position_size_tier:'light', position_size_factor:0.5 })
  })

  it('uses the configured platform volume range instead of a hard-coded maximum', () => {
    const result = normalizeAiSignal({
      _inference_source: 'ai', signal_type: 'buy', entry_method: 'market', confidence: 0.8,
      recommended_volume: 0.08, stop_loss_price: 1990, take_profit_1_price: 2020,
      recommended_take_profit_tier: 1,
    }, { ...config, max_position_size: 0.1, _ai_volume_min: 0.02, _ai_volume_max: 0.1, _ai_volume_step: 0.02 }, market)
    expect(result).toMatchObject({ signal_type: 'buy', recommended_volume: 0.1, position_size_tier:'light', position_size_factor:0.5 })
  })

  it('does not let a legacy absolute volume control the new risk-tier contract', () => {
    const result = normalizeAiSignal({
      _inference_source: 'ai', signal_type: 'buy', entry_method: 'market', confidence: 0.8,
      recommended_volume: 0.07, stop_loss_price: 1990, take_profit_1_price: 2020,
      recommended_take_profit_tier: 1,
    }, { ...config, max_position_size: 0.1, _ai_volume_min: 0.02, _ai_volume_max: 0.1, _ai_volume_step: 0.02 }, market)
    expect(result).toMatchObject({ signal_type: 'buy', recommended_volume:0.1, position_size_tier:'light', position_size_factor:0.5 })
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
