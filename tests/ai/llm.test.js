import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
const providerCapabilitiesMock = vi.hoisted(() => ({
  resolveModelProviderCapabilities:vi.fn(async () => ({
    supports_stream:false, supports_request_id:false,
    token_limits_status:'confirmed', token_limits_source:'manual_confirmed',
    context_window_tokens:1_048_576, max_input_tokens:1_048_576,
    max_output_tokens:393_216, context_limit_semantics:'shared_context',
  })),
}))
vi.mock('../../server/routes/ai/model-provider-capabilities.js', () => providerCapabilitiesMock)
import { requestJsonObject, resolveConfirmedRequestMaxTokens, maybeAiSignal, normalizeAiSignal, buildModelComparisonSignal, buildStrategyOutputFormat, formatPendingValidUntilUtc, validateAiSignalResponse, localizeInferenceNarrative, compactInferenceMarketPayload, extractTokenUsage, modelResponseCompletion, INFERENCE_KLINE_FIELDS, projectPositionManagementContextForModel } from '../../server/routes/ai/llm.js'
import { compactRates, DEFAULT_PROMPT } from '../../server/routes/ai/utils.js'
import { POSITION_MANAGEMENT_CONTRACT_VERSION } from '../../server/routes/ai/position-management.js'

describe('model output budgets', () => {
  it('does not expose a profile max_tokens runtime helper', () => {
    const source = readFileSync(new URL('../../server/routes/ai/llm.js', import.meta.url), 'utf8')
    expect(source).not.toContain('configuredModelMaxTokens')
    expect(source).not.toContain('AUTO_INFERENCE_MAX_PROMPT_CHARS')
    expect(source).not.toContain('auto_inference_prompt_budget_exceeded')
  })

  it('recomputes shared-context room for both initial and repair messages', () => {
    const budget = { tokenLimitsStatus:'confirmed', maxInputTokens:1000,
      contextWindowTokens:100, providerOutputCap:80, contextLimitSemantics:'shared_context' }
    const initial = [{ role:'user', content:'a'.repeat(32) }]
    const repair = [...initial, { role:'user', content:'b'.repeat(160) }]
    expect(resolveConfirmedRequestMaxTokens(initial, 80, budget)).toBe(80)
    expect(resolveConfirmedRequestMaxTokens(repair, 80, budget)).toBeLessThan(80)
  })
})

describe('position management model privacy projection', () => {
  it('removes execution-only account and broker fields before model serialization', () => {
    const projected = projectPositionManagementContextForModel({
      contract_version:POSITION_MANAGEMENT_CONTRACT_VERSION,
      as_of:{ decision_timeframe:'M15', closed_bar_time_utc_ms:1, market_snapshot_hash:'sha256:x',
        user_id:28, balance:1000 },
      pending_groups:[{
        management_group_id:'group-1', decision_context_status:'available', reference_facts_status:'missing',
        core_entry_reason:'历史入场叙事', original_stop_loss:1900, original_take_profits:[2100],
        user_id:28, trading_account_id:3, login_account:'secret', pending_ticket:'O-1',
        pending_order_facts:[{ source:'platform_reference_portfolio', trigger_price:2000, ticket:'O-1', volume:1,
          original_stop_loss:1900, original_take_profits:[2100], profit:3 }],
      }],
      position_groups:[],
      exposure_summary:{
        buy:{ position_count:2, position_volume:0.3, weighted_average_entry:2001,
          pending_count:1, pending_volume:0.1 },
        sell:{ position_count:0, position_volume:0, weighted_average_entry:null,
          pending_count:0, pending_volume:0 },
      },
    })
    const serialized = JSON.stringify(projected)
    expect(serialized).not.toContain('user_id')
    expect(serialized).not.toContain('trading_account_id')
    expect(serialized).not.toContain('login_account')
    expect(serialized).not.toContain('pending_ticket')
    expect(serialized).not.toContain('ticket')
    expect(serialized).toContain('"volume":1')
    expect(serialized).not.toContain('profit')
    expect(serialized).not.toContain('balance')
    expect(serialized).not.toContain('core_entry_reason')
    expect(serialized).not.toContain('original_stop_loss')
    expect(serialized).not.toContain('original_take_profits')
    expect(projected.exposure_summary.buy).toEqual({ position_count:2, position_volume:0.3,
      weighted_average_entry:2001, pending_count:1, pending_volume:0.1 })
    expect(serialized).toContain('reference_facts_status')
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

  it('uses the provider follow-up deadline independently from market execution freshness', () => {
    expect(source).toContain('Number(config._followupValidUntilUtcMs)')
    expect(source).toContain('Number(config._resultValidUntilUtcMs)')
  })

  it('does not keep the live legacy intent adapter', () => {
    expect(source).not.toContain('adaptLegacyPositionSizing')
    expect(source).not.toContain('legacyPendingReason')
  })

  it('keeps legacy narrative localization without injecting Chan diagnostics into new prompts', () => {
    expect(source).toContain('INFERENCE_NARRATIVE_REPLACEMENTS')
    expect(source).not.toContain('CHAN_DIVERGENCE_RULE')
    expect(source).toContain('CHAN_MODEL_RULE')
    expect(source).not.toContain('按当前具体策略的周期职责分析各周期原始结构')
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

  it('does not rewrite Chan structure objects into references', () => {
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
    expect(chan.latest_center).toEqual(center)
    expect(chan.active_center.status).toBe('broken_up')
    expect(compacted.strategy_context.input_encoding).toBeUndefined()
  })

  it('retains old Chan references as read-only input without creating new ones', () => {
    const payload = { strategy_context:{ timeframes:{ H1:{ klines:[], summary:{ chan:{
      current_center:{ $ref:'#/legacy/current_center' },
    } } } } } }
    expect(compactInferenceMarketPayload(payload).strategy_context.timeframes.H1.summary.chan)
      .toEqual({ current_center:{ $ref:'#/legacy/current_center' } })
  })

  it('does not compact custom K-line objects with unknown fields', () => {
    const bar = { time:'t', open:1, high:2, low:0, close:1, tick_volume:2, spread:3, broker_note:'custom' }
    const payload = { strategy_context:{ timeframes:{ M5:{ summary:{}, klines:[bar] } } } }
    expect(compactInferenceMarketPayload(payload).strategy_context.timeframes.M5.klines).toEqual([bar])
  })
})

describe('buildStrategyOutputFormat', () => {
  it('uses a single code-owned output contract without legacy volume or cancellation fields', () => {
    const schema = JSON.parse(buildStrategyOutputFormat(null, ['market', 'limit']).outputFormat)
    expect(DEFAULT_PROMPT).not.toContain('recommended_volume')
    expect(DEFAULT_PROMPT).not.toMatch(/signal_type.*confidence.*analysis.*reasoning/i)
    expect(schema).not.toHaveProperty('recommended_volume')
    expect(schema).not.toHaveProperty('cancel_pending')
    expect(schema.stop_loss_price).not.toMatch(/风险等级|low=|medium=|high=|自动修正|M15|H1/)
    expect(schema.limit_price).not.toMatch(/M15|H1/)
    expect(schema.stop_loss_price).toContain('当前策略正文')
    expect(schema.stop_loss_price).not.toMatch(/周期角色|关键结构|波动证据/)
    expect(schema.position_action).toContain('表达当前策略')
    expect(schema.position_action).toContain('无同向持仓且需要交易时，交易信号只能使用 position_action=open')
    expect(schema.position_action).toContain('已有同向持仓且允许加仓时，交易信号使用 position_action=allow_add')
    expect(schema.position_action).toContain('signal_type=hold、entry_method=observe、position_action=hold_no_add')
    expect(schema.position_action).toContain('无交易或纯观望时，必须同时输出 signal_type=hold、entry_method=observe、position_action=observe')
    expect(schema.position_action).toContain('禁止同时输出反向交易与 position_action=open')
    expect(schema.hard_gate_status).toContain('当前策略')
    expect(schema.hard_gate_failures[0]).toContain('signal_type')
    expect(schema.minimum_reward_to_risk).toContain('不得擅自增加全局默认值')
    expect(schema.recommended_reward_to_risk).toContain('recommended_take_profit_tier')
    expect(schema.recommended_reward_to_risk).toContain('hold 或当前策略不要求时返回 null')
    expect(schema.reward_to_risk_status).toBe('必须字段。仅允许 pass | fail | not_applicable。pass 表示存在完整可计算的交易计划且达到当前策略门槛；fail 表示存在完整可计算的交易候选，但仅因实际收益风险比低于当前策略门槛而输出 hold；not_applicable 表示 signal_type=hold 且 entry_method=observe，尚未形成唯一完整交易候选、尚未进入收益风险检查，或当前策略没有收益风险门槛。该字段是模型自检声明，不替代独立风控')
  })

  it('describes confidence as conclusion certainty rather than a win-rate estimate', () => {
    const schema = JSON.parse(buildStrategyOutputFormat(null, ['market']).outputFormat)
    expect(schema.confidence).toBe('0.00-1.00 的数字，表示模型对依据当前策略和输入事实所得本轮结论的把握度；signal_type=hold 时表示对当前不满足策略交易条件这一结论的把握度；不是胜率，不得写成百分比')
  })

  it('does not encode generic analysis doctrine in the output contract', () => {
    const rendered = buildStrategyOutputFormat(null, ['market', 'limit']).outputFormat
    expect(rendered).not.toContain('EMA34')
    expect(rendered).not.toMatch(/BUY\/SELL弱优势|HOLD时|0\.52-0\.62|0\.63-0\.74/)
    expect(rendered).not.toContain('R:R')
    expect(rendered).not.toContain('1.5')
    expect(rendered).not.toContain('缠论')
    expect(rendered).not.toContain('M15')
    expect(rendered).not.toContain('按以下顺序')
    expect(rendered).not.toContain('方向优势不清晰')
    expect(rendered).toContain('signal_type')
    expect(rendered).toContain('entry_method')
  })

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
    expect(schema.pending_action).not.toContain('可以同时存在多笔挂单')
    expect(schema.pending_action).not.toContain('系统不按数量限制')
    expect(schema.pending_action).toContain('none 表示本轮不管理现有挂单')
    expect(schema.pending_action).toContain('keep 表示保留模型选中的挂单')
  })

  it('overrides stale database field descriptions with the generic output contract', () => {
    const staleDescription = '旧版专用规则：缠论 M15 EMA34 ATR；旧版绝对价格与距离混用'
    const relatedFields = [
      'confidence', 'bullish_score', 'bearish_score', 'position_size_tier', 'position_size_reason',
      'position_action', 'pending_action', 'pending_action_reason', 'management_direction',
      'hard_gate_status', 'hard_gate_failures', 'minimum_reward_to_risk', 'recommended_reward_to_risk',
      'reward_to_risk_status', 'limit_price', 'stop_limit_price', 'pending_valid_minutes',
      'stop_loss_price', 'take_profit_1_price', 'take_profit_2_price', 'take_profit_3_price',
      'recommended_take_profit_tier', 'decision_summary', 'trigger_condition', 'invalidation_condition',
      'key_reasons', 'risk_factors', 'analysis', 'reasoning',
    ]
    const staleBaseFormat = JSON.stringify(Object.fromEntries(relatedFields.map(key => [key, staleDescription])))
    const schema = JSON.parse(buildStrategyOutputFormat(staleBaseFormat, ['market', 'limit', 'stop_limit']).outputFormat)
    const rendered = JSON.stringify(schema)

    expect(rendered).not.toMatch(/缠论|M15|EMA34|ATR/)
    expect(schema.pending_action).toContain('数组缺失、为空或没有可识别的目标挂单时，必须为 none')
    expect(schema.pending_action).toContain('keep 或 cancel 只能针对输入中可识别的现有挂单')
    expect(schema.pending_action).toContain('pending_action 为 none 或 keep 时，pending_action_reason 必须为空字符串且 management_direction 必须为 none')
    expect(schema.pending_action).toContain('pending_action 为 cancel 时，必须填写 management_direction=buy 或 sell 及简体中文 pending_action_reason')
    expect(schema.pending_action_reason).toContain('pending_action 为 cancel 时')
    expect(schema.pending_action_reason).toContain('pending_action 为 none 或 keep 时必须返回空字符串')
    expect(schema.management_direction).toContain('pending_action 为 cancel 时')
    expect(schema.management_direction).toContain('pending_action 为 none 或 keep 时必须填 none')

    for (const key of ['limit_price', 'stop_limit_price', 'stop_loss_price',
      'take_profit_1_price', 'take_profit_2_price', 'take_profit_3_price']) {
      expect(schema[key]).toContain('signal_type=hold 或 entry_method=observe 时必须为 null')
      expect(schema[key]).toContain('绝对价格点位')
    }
    expect(schema.entry_method).toContain('市价信号（entry_method=market）的挂单专用字段 limit_price、stop_limit_price、pending_valid_minutes 必须为 null')
    expect(schema.pending_valid_minutes).toContain('市价信号以及 signal_type=hold 或 entry_method=observe 时必须为 null')
    expect(schema.recommended_take_profit_tier).toContain('signal_type=hold 或 entry_method=observe 时必须为 null')
    expect(schema.limit_price).toContain('禁止把绝对价位写成“上涨/下跌 N 点（某绝对价位）”')
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

  it('requires structured usage fields to agree with adoption language', () => {
    const schema = JSON.parse(buildStrategyOutputFormat(null, ['market'], {
      selectedItemIds:[9], selectedRefs:['platform:9'],
    }).outputFormat)
    expect(schema.experience_usage.used_refs).toContain('used_ids')
    expect(schema.experience_usage.used_ids).toContain('used_refs')
    expect(schema.experience_usage.influence).toContain('必须同步')
    expect(schema.experience_usage.influence).toContain('不得声称采用')
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
    expect(localizeInferenceNarrative('confirmed_structure_stale'))
      .toBe('旧版结构快照中的历史字段（不代表当前引擎状态）')
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

  it('maps legacy ids to refs only when the available ref is unique', () => {
    const unique = normalizeAiSignal({ signal_type:'hold', entry_method:'observe', confidence:0.6, recommended_volume:0,
      experience_usage:{ used_ids:[8, 999], rejected_ids:[7, 8, 999], influence:'采用平台记忆' } },
    { _allowed_entry_methods:['market'], _experienceSelection:{ source:'platform', selectedItemIds:[7, 8], selectedRefs:['short:7', 'long:7', 'platform:8', 'bad:9'] } },
    { strategy_score:{ trend_strength:0.2 }, volatility_pct:0.1 })
    expect(unique.experience_usage).toMatchObject({
      considered_refs:['short:7', 'long:7', 'platform:8'],
      used_ids:[8], used_refs:['platform:8'], rejected_ids:[7], rejected_refs:[],
    })
  })

  it('keeps an explicit legal ref when its numeric id is ambiguous', () => {
    const result = normalizeAiSignal({ signal_type:'hold', entry_method:'observe', confidence:0.6, recommended_volume:0,
      experience_usage:{ used_ids:[7], used_refs:['long:7', 'unknown:7'] } },
    { _allowed_entry_methods:['market'], _experienceSelection:{ source:'personal', selectedItemIds:[7], selectedRefs:['short:7', 'long:7'] } },
    { strategy_score:{ trend_strength:0.2 }, volatility_pct:0.1 })
    expect(result.experience_usage.used_ids).toEqual([7])
    expect(result.experience_usage.used_refs).toEqual(['long:7'])
  })

  it.each([
    '参考了平台经验：当前结构不足，因此观望',
    '采用记忆9：当前结构不足，继续等待',
    '记忆#9指出当前应等待，适用该经验，故选择观望',
    '经验指出当前应等待，因此选择观望，符合该经验',
  ])('recovers strong adoption semantics from production influence: %s', influence => {
    const result = normalizeAiSignal({ signal_type:'hold', entry_method:'observe', confidence:0.6, recommended_volume:0,
      experience_usage:{ influence } },
    { _allowed_entry_methods:['market'], _experienceSelection:{ source:'platform', selectedItemIds:[9], selectedRefs:['platform:9'] } },
    { strategy_score:{ trend_strength:0.2 }, volatility_pct:0.1 })
    expect(result.experience_usage).toMatchObject({ used_ids:[9], used_refs:['platform:9'], rejected_ids:[], rejected_refs:[] })
  })

  it('corrects explicit rejected attribution when a strong unique adoption claim names the candidate', () => {
    const result = normalizeAiSignal({ signal_type:'hold', entry_method:'observe', confidence:0.6, recommended_volume:0,
      experience_usage:{ rejected_ids:[9], rejected_refs:['platform:9'], influence:'采用记忆9，因此选择观望' } },
    { _allowed_entry_methods:['market'], _experienceSelection:{ source:'platform', selectedItemIds:[9], selectedRefs:['platform:9'] } },
    { strategy_score:{ trend_strength:0.2 }, volatility_pct:0.1 })
    expect(result.experience_usage).toMatchObject({ used_ids:[9], used_refs:['platform:9'], rejected_ids:[], rejected_refs:[] })
  })

  it.each([
    '本次未采用该经验，仅供参考',
    '不采用记忆9，当前只保留观望',
    '没有采用平台经验',
    '该经验不适用当前行情',
    '当前不符合该经验的适用条件',
    '未符合该经验，继续观望',
    '没有按照该经验执行',
    '该经验适用性不足',
    '该经验适用范围有限',
    '该经验不完全适用',
  ])('does not infer adoption from negative influence: %s', influence => {
    const result = normalizeAiSignal({ signal_type:'hold', entry_method:'observe', confidence:0.6, recommended_volume:0,
      experience_usage:{ influence } },
    { _allowed_entry_methods:['market'], _experienceSelection:{ source:'platform', selectedItemIds:[9], selectedRefs:['platform:9'] } },
    { strategy_score:{ trend_strength:0.2 }, volatility_pct:0.1 })
    expect(result.experience_usage.used_ids).toEqual([])
    expect(result.experience_usage.used_refs).toEqual([])
  })

  it('does not guess an unnumbered adoption across multiple candidates', () => {
    const result = normalizeAiSignal({ signal_type:'hold', entry_method:'observe', confidence:0.6, recommended_volume:0,
      experience_usage:{ influence:'参考了平台经验，因此选择观望' } },
    { _allowed_entry_methods:['market'], _experienceSelection:{ source:'platform', selectedItemIds:[9, 10], selectedRefs:['platform:9', 'platform:10'] } },
    { strategy_score:{ trend_strength:0.2 }, volatility_pct:0.1 })
    expect(result.experience_usage.used_ids).toEqual([])
    expect(result.experience_usage.used_refs).toEqual([])
  })

  it('does not guess a same-number cross-scope adoption', () => {
    const result = normalizeAiSignal({ signal_type:'hold', entry_method:'observe', confidence:0.6, recommended_volume:0,
      experience_usage:{ influence:'采用记忆9，因此选择观望' } },
    { _allowed_entry_methods:['market'], _experienceSelection:{ source:'personal', selectedItemIds:[9], selectedRefs:['short:9', 'long:9'] } },
    { strategy_score:{ trend_strength:0.2 }, volatility_pct:0.1 })
    expect(result.experience_usage.used_ids).toEqual([])
    expect(result.experience_usage.used_refs).toEqual([])
  })

  it('backfills a unique numeric id from an explicit legal used ref', () => {
    const result = normalizeAiSignal({ signal_type:'hold', entry_method:'observe', confidence:0.6, recommended_volume:0,
      experience_usage:{ used_refs:['platform:9'] } },
    { _allowed_entry_methods:['market'], _experienceSelection:{ source:'platform', selectedItemIds:[9], selectedRefs:['platform:9'] } },
    { strategy_score:{ trend_strength:0.2 }, volatility_pct:0.1 })
    expect(result.experience_usage.used_refs).toEqual(['platform:9'])
    expect(result.experience_usage.used_ids).toEqual([9])
  })

  it('maps an explicit ref mentioned in influence only within the available whitelist', () => {
    const result = normalizeAiSignal({ signal_type:'hold', entry_method:'observe', confidence:0.6, recommended_volume:0,
      experience_usage:{ influence:'采用 platform:9，因此选择观望' } },
    { _allowed_entry_methods:['market'], _experienceSelection:{ source:'platform', selectedItemIds:[9], selectedRefs:['platform:9'] } },
    { strategy_score:{ trend_strength:0.2 }, volatility_pct:0.1 })
    expect(result.experience_usage.used_refs).toEqual(['platform:9'])
    expect(result.experience_usage.used_ids).toEqual([9])
  })
})

describe('model comparison signal isolation', () => {
  const config = { _allowed_entry_methods:['market', 'limit'], _ai_volume_min:0.01, _ai_volume_max:1, _ai_volume_step:0.01 }
  const market = { latest_price:2000 }

  it('does not treat retired live stop-adjustment metadata as replay-eligible', () => {
    const raw = {
      _inference_source:'ai', signal_type:'buy_limit', entry_method:'limit', confidence:0.8,
      recommended_volume:0.03, limit_price:1995, pending_valid_minutes:60,
      stop_loss_price:1985, take_profit_1_price:2010, recommended_take_profit_tier:1,
      invalidation_condition:'跌破止损结构后建议失效',
    }
    const normalized = {
      ...raw, signal_type:'hold', entry_method:'observe', confidence:0, recommended_volume:0,
      normalization_info:{ type:'atr_anchor_unavailable_hold', reason:'atr_anchor_unavailable_hold' },
    }
    expect(buildModelComparisonSignal(raw, normalized, config, market)).toMatchObject({
      signal_type:'buy_limit', entry_method:'limit', recommended_volume:0.03,
      pending_valid_until:null,
      comparison_validation:{
        status:'invalid', execution_eligible:false,
        errors:['atr_anchor_unavailable_hold'], warnings:[], live_risk_bypassed:true,
      },
    })
  })

  it('keeps the raw direction but blocks replay when order constraints are invalid', () => {
    const raw = {
      _inference_source:'ai', signal_type:'sell_limit', entry_method:'limit', confidence:0.75,
      recommended_volume:0.02, limit_price:1990,
      stop_loss_price:2010, take_profit_1_price:1970, recommended_take_profit_tier:1,
      invalidation_condition:'突破失效位后建议失效',
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

  it('rejects confirmed physical input overflow before making a provider request', async () => {
    await expect(requestJsonObject({
      url:'https://api.example.test', apiKey:'test-key', model:'test-model', maxTokens:80,
      messages:[{ role:'user', content:'test input' }],
      modelTaskBudget:{ tokenLimitsStatus:'confirmed', maxInputTokens:1,
        contextWindowTokens:1000, contextLimitSemantics:'shared_context' },
    })).rejects.toMatchObject({ code:'model_input_limit_exceeded', message:'model_input_limit_exceeded' })
    expect(mockFetch).not.toHaveBeenCalled()
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
      model:'deepseek-v4-pro', temperature:0.3, maxTokens:selectedMaxOutputTokens, thinkingEnabled,
      reasoningEffort:'high', messages:[{ role:'user', content:'test' }],
    })

    const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(requestBody.max_tokens).toBe(selectedMaxOutputTokens)
    expect(requestBody.response_format).toEqual({ type:'json_object' })
    if (thinkingEnabled) {
      expect(requestBody.thinking).toEqual({ type:'enabled' })
      expect(requestBody.reasoning_effort).toBe('high')
      expect(requestBody).not.toHaveProperty('temperature')
    } else {
      expect(requestBody.thinking).toEqual({ type:'disabled' })
      expect(requestBody.reasoning_effort).toBeUndefined()
      expect(requestBody.temperature).toBe(0.3)
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

  it('supports an opt-in compact repair patch and validates the merged candidate', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok:true,
        json:() => Promise.resolve({ choices:[{ message:{ content:'{"decision_quality":"insufficient_evidence","keep":"原文"}' } }] }) })
      .mockResolvedValueOnce({ ok:true,
        json:() => Promise.resolve({ choices:[{ message:{ content:'{"changes":[{"scope":"root","field":"decision_quality","value":"mixed"}]}' } }] }) })
    const validateObject = vi.fn((value, validation) => {
      if (validation.phase === 'initial') {
        const error = new Error('daily_v3_insufficient_state_without_server_limitation')
        error.validationContext = { targets:[{ scope:'root', field:'decision_quality' }], outcome_id:null, fields:['$root.decision_quality'] }
        throw error
      }
      return value
    })
    const validateRepairOutput = vi.fn(({ repairedObject, repairPatch }) => {
      expect(repairPatch).toEqual({ changes:[{ scope:'root', field:'decision_quality', value:'mixed' }] })
      expect(repairedObject).toEqual({ decision_quality:'mixed', keep:'原文' })
    })
    const result = await requestJsonObject({
      url:'https://api.example.test', apiKey:'test-key', model:'test-model', maxTokens:20_000,
      messages:[{ role:'user', content:'完整冻结证据，不应进入补丁正文' }], validateObject,
      repairContext:{ mode:'patch', outputFormat:'{"changes":[]}', requiredCoverage:{ outcome_ids:[1] },
        repairInput:({ initialObject }) => ({ repair_targets:[{
          scope:'root', field:'decision_quality', current_value:initialObject.decision_quality,
          allowed_values:['good', 'mixed', 'poor'],
        }] }),
        applyRepairPatch:({ initialObject, repairedObject }) => ({ ...initialObject,
          decision_quality:repairedObject.changes[0].value }),
        validateRepairOutput, repairMaxTokens:4096, repairReasoningEffort:'low',
        repairInstructions:'FULL_ONLY_MARKER', patchRepairInstructions:'PATCH_ONLY_MARKER' },
    })
    expect(result).toEqual({ decision_quality:'mixed', keep:'原文' })
    expect(validateObject).toHaveBeenCalledTimes(2)
    const repairBody = JSON.parse(mockFetch.mock.calls[1][1].body)
    expect(repairBody.max_tokens).toBe(4096)
    expect(repairBody.temperature).toBe(0)
    expect(JSON.stringify(repairBody.messages)).not.toContain('完整冻结证据')
    expect(repairBody.messages[0].content).toContain('PATCH_ONLY_MARKER')
    expect(repairBody.messages[0].content).not.toContain('FULL_ONLY_MARKER')
    const repairPayload = JSON.parse(repairBody.messages[1].content)
    expect(repairPayload.original_output).toBeUndefined()
    expect(repairPayload.repair_input.repair_targets[0]).toMatchObject({
      field:'decision_quality', current_value:'insufficient_evidence', allowed_values:['good', 'mixed', 'poor'],
    })
  })

  it('uses low reasoning effort for a canonical patch repair when the provider exposes it', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok:true,
        json:() => Promise.resolve({ choices:[{ message:{ content:'{"value":"bad"}' } }] }) })
      .mockResolvedValueOnce({ ok:true,
        json:() => Promise.resolve({ choices:[{ message:{ content:'{"changes":[{"scope":"root","field":"value","value":"fixed"}]}' } }] }) })
    const validateObject = vi.fn((value, validation) => {
      if (validation.phase === 'initial') {
        const error = new Error('patch_value_invalid')
        error.validationContext = { targets:[{ scope:'root', field:'value' }] }
        throw error
      }
      return value
    })
    const result = await requestJsonObject({
      url:'https://api.example.test', apiKey:'test-key', provider:'deepseek', model:'test-model',
      thinkingEnabled:true, reasoningEffort:'max', maxTokens:2000,
      messages:[{ role:'user', content:'test' }], validateObject,
      repairContext:{ mode:'patch', outputFormat:'{"changes":[]}', repairInput:{ repair_targets:[{
        scope:'root', field:'value', current_value:'bad', allowed_values:['fixed'],
      }] }, applyRepairPatch:({ initialObject, repairedObject }) => ({ ...initialObject,
        value:repairedObject.changes[0].value }), repairReasoningEffort:'low' },
    })
    expect(result).toEqual({ value:'fixed' })
    const repairBody = JSON.parse(mockFetch.mock.calls[1][1].body)
    expect(repairBody.reasoning_effort).toBe('low')
  })

  it('fails closed when patch repair has no parsed initial object or apply callback', async () => {
    mockFetch.mockResolvedValueOnce({ ok:true,
      json:() => Promise.resolve({ choices:[{ message:{ content:'{"value":"bad"}' } }] }) })
    const validateObject = vi.fn(() => {
      const error = new Error('patch_value_invalid')
      error.validationContext = { targets:[{ scope:'root', field:'value' }] }
      throw error
    })
    await expect(requestJsonObject({
      url:'https://api.example.test', apiKey:'test-key', model:'test-model', maxTokens:2000,
      messages:[{ role:'user', content:'test' }], validateObject,
      repairContext:{ mode:'patch', repairInput:{ repair_targets:[] } },
    })).rejects.toThrow('llm_patch_repair_requires_parsed_initial_object_and_apply_repair_patch')
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('falls back to full repair for a patch-configured JSON parse failure', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok:true,
        json:() => Promise.resolve({ choices:[{ message:{ content:'not-json' } }] }) })
      .mockResolvedValueOnce({ ok:true,
        json:() => Promise.resolve({ choices:[{ message:{ content:'{"value":"fixed"}' } }] }) })
    const result = await requestJsonObject({
      url:'https://api.example.test', apiKey:'test-key', model:'test-model', maxTokens:2000,
      messages:[{ role:'user', content:'完整初始请求' }],
      repairContext:{ mode:'patch', outputFormat:'{"value":"string"}', patchOutputFormat:'{"changes":[]}',
        repairInput:{ repair_targets:[{ scope:'root', field:'value', allowed_values:['fixed'] }] },
        repairInstructions:'FULL_ONLY_MARKER', patchRepairInstructions:'PATCH_ONLY_MARKER' },
    })
    expect(result).toEqual({ value:'fixed' })
    const repairBody = JSON.parse(mockFetch.mock.calls[1][1].body)
    const repairPayload = JSON.parse(repairBody.messages[1].content)
    expect(repairPayload.output_contract).toBe('{"value":"string"}')
    expect(repairPayload.original_output).toBe('not-json')
    expect(repairPayload).not.toHaveProperty('repair_input')
    expect(repairBody.messages[0].content).toContain('完整、合法的 JSON 对象')
    expect(repairBody.messages[0].content).not.toContain('语义补丁修复器')
  })

  it('falls back to full repair when a patch-configured validation error has no targets', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok:true,
        json:() => Promise.resolve({ choices:[{ message:{ content:'{"value":"bad","keep":"原始"}' } }] }) })
      .mockResolvedValueOnce({ ok:true,
        json:() => Promise.resolve({ choices:[{ message:{ content:'{"value":"fixed","keep":"原始"}' } }] }) })
    const validateObject = vi.fn((value, validation) => {
      if (validation.phase === 'initial') throw new Error('required_field_missing')
      return value
    })
    const result = await requestJsonObject({
      url:'https://api.example.test', apiKey:'test-key', model:'test-model', maxTokens:2000,
      messages:[{ role:'user', content:'完整初始请求' }], validateObject,
      repairContext:{ mode:'patch', outputFormat:'{"value":"string","keep":"string"}', patchOutputFormat:'{"changes":[]}',
        repairInput:{ repair_targets:[{ scope:'root', field:'value', allowed_values:['fixed'] }] },
        repairInstructions:'FULL_ONLY_MARKER', patchRepairInstructions:'PATCH_ONLY_MARKER' },
    })
    expect(result).toEqual({ value:'fixed', keep:'原始' })
    const repairBody = JSON.parse(mockFetch.mock.calls[1][1].body)
    const repairPayload = JSON.parse(repairBody.messages[1].content)
    expect(repairPayload.output_contract).toBe('{"value":"string","keep":"string"}')
    expect(repairPayload.original_output).toBe('{"value":"bad","keep":"原始"}')
    expect(repairPayload).not.toHaveProperty('repair_input')
    expect(repairBody.messages[0].content).toContain('FULL_ONLY_MARKER')
    expect(repairBody.messages[0].content).not.toContain('PATCH_ONLY_MARKER')
    expect(validateObject.mock.calls.map(([, validation]) => validation.phase)).toEqual(['initial', 'repair'])
  })

  it('lets an explicit empty caller target list force full repair', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok:true,
        json:() => Promise.resolve({ choices:[{ message:{ content:'{"value":"bad"}' } }] }) })
      .mockResolvedValueOnce({ ok:true,
        json:() => Promise.resolve({ choices:[{ message:{ content:'{"value":"fixed"}' } }] }) })
    const validateObject = vi.fn((value, validation) => {
      if (validation.phase === 'initial') {
        const error = new Error('outcome_refs_invalid')
        error.validationContext = { targets:[{ scope:'root', field:'value' }] }
        throw error
      }
      return value
    })
    const applyRepairPatch = vi.fn(() => { throw new Error('patch must not run') })
    const result = await requestJsonObject({
      url:'https://api.example.test', apiKey:'test-key', model:'test-model', maxTokens:2000,
      messages:[{ role:'user', content:'完整初始请求' }], validateObject,
      repairContext:{ mode:'patch', outputFormat:'{"value":"string"}', patchOutputFormat:'{"changes":[]}',
        validationContext:() => ({ targets:[] }), repairInput:() => ({ repair_targets:[{ field:'value' }] }),
        applyRepairPatch, repairInstructions:'FULL_ONLY_MARKER', patchRepairInstructions:'PATCH_ONLY_MARKER' },
    })
    expect(result).toEqual({ value:'fixed' })
    expect(applyRepairPatch).not.toHaveBeenCalled()
    const repairBody = JSON.parse(mockFetch.mock.calls[1][1].body)
    expect(JSON.parse(repairBody.messages[1].content).original_output).toBe('{"value":"bad"}')
    expect(repairBody.messages[0].content).toContain('FULL_ONLY_MARKER')
    expect(repairBody.messages[0].content).not.toContain('PATCH_ONLY_MARKER')
  })

  it('keeps the original validation error when follow-up repair is disabled', async () => {
    mockFetch.mockResolvedValueOnce({ ok:true,
      json:() => Promise.resolve({ choices:[{ message:{ content:'not-json' } }] }) })
    await expect(requestJsonObject({
      url:'https://api.example.test', apiKey:'test-key', model:'test-model', maxTokens:2000,
      messages:[{ role:'user', content:'test' }], allowFollowupRequests:false,
      repairContext:{ mode:'patch', outputFormat:'{"value":"string"}' },
    })).rejects.toThrow('ai_response_missing_json_object')
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('carries caller and presentation-safe validator context into one compact repair', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ choices: [{ message: { content: '{"decision_quality":"insufficient_evidence"}' } }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ choices: [{ message: { content: '{"decision_quality":"mixed"}' } }] }),
      })
    const validateObject = vi.fn((value, validation) => {
      if (validation.phase === 'initial') {
        const error = new Error('daily_v3_insufficient_state_without_server_limitation')
        error.code = error.message
        error.validationContext = { outcome_id:1, fields:['decision_quality'] }
        throw error
      }
      return value
    })
    const frozenReviewContext = {
      system_statistics:{ trade_count:1 },
      pre_trade_frozen:[{ outcome_id:1, signal:{ signal_type:'buy' } }],
      holding_path:[{ outcome_id:1, outcome:{ net_profit:-1 } }],
      period_market:{ status:'complete' },
    }
    const validateRepairOutput = vi.fn(({ initialObject, repairedObject, validationError }) => {
      expect(initialObject).toEqual({ decision_quality:'insufficient_evidence' })
      expect(repairedObject).toEqual({ decision_quality:'mixed' })
      expect(validationError.message).toBe('daily_v3_insufficient_state_without_server_limitation')
    })
    const result = await requestJsonObject({
      url:'https://api.example.test', apiKey:'test-key', model:'test-model', maxTokens:2000,
      messages:[{ role:'user', content:'initial review request' }], validateObject,
      repairContext:{ outputFormat:'{"decision_quality":"good|mixed|poor|insufficient_evidence"}',
        requiredCoverage:{ outcome_ids:[1] },
        validationContext:({ validationError, validationContext }) => {
          expect(validationError.message).toBe('daily_v3_insufficient_state_without_server_limitation')
          expect(validationContext).toEqual({ outcome_id:1, fields:['decision_quality'] })
          return { review_context:frozenReviewContext,
          evidence_limitations_by_outcome:{ '1':[] },
          insufficient_evidence_policy_by_outcome:{ '1':{ allowed:false, server_limitations:[] } } }
        },
        validateRepairOutput,
        repairInstructions:'只能依据同一冻结证据重新判断被报告字段。' },
    })
    expect(result).toEqual({ decision_quality:'mixed' })
    const repairBody = JSON.parse(mockFetch.mock.calls[1][1].body)
    const repairPayload = JSON.parse(repairBody.messages[1].content)
    expect(repairPayload.validation_error).toBe('daily_v3_insufficient_state_without_server_limitation')
    expect(repairPayload.validation_context.review_context).toEqual(frozenReviewContext)
    expect(repairPayload.validation_context.evidence_limitations_by_outcome).toEqual({ '1':[] })
    expect(repairPayload.validation_context.insufficient_evidence_policy_by_outcome['1'].allowed).toBe(false)
    expect(repairPayload.validation_context.outcome_id).toBe(1)
    expect(repairPayload.validation_context.fields).toEqual(['decision_quality'])
    expect(repairBody.messages[0].content).toContain('只能依据同一冻结证据')
    expect(validateRepairOutput).toHaveBeenCalledTimes(1)
  })

  it('keeps the original validation error message ahead of its optional code', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok:true,
        json:() => Promise.resolve({ choices:[{ message:{ content:'{"value":"bad"}' } }] }) })
      .mockResolvedValueOnce({ ok:true,
        json:() => Promise.resolve({ choices:[{ message:{ content:'{"value":"fixed"}' } }] }) })
    const validateObject = vi.fn((value, validation) => {
      if (validation.phase === 'initial') {
        const error = new Error('legacy_validation_message')
        error.code = 'new_stable_code'
        throw error
      }
      return value
    })
    await requestJsonObject({ url:'https://api.example.test', apiKey:'test-key', model:'test-model', maxTokens:2000,
      messages:[{ role:'user', content:'test' }], validateObject,
      repairContext:{ outputFormat:'{"value":"string"}', requiredCoverage:null } })
    const repairBody = JSON.parse(mockFetch.mock.calls[1][1].body)
    expect(JSON.parse(repairBody.messages[1].content).validation_error).toBe('legacy_validation_message')
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
    recommended_volume: 0, position_size_tier:'observe', position_size_reason:'当前不满足建仓条件',
    position_action:'observe', pending_action:'none', pending_action_reason:'', management_direction:'none',
    analysis: '暂无优势', reasoning: '等待结构确认',
  }

  it('accepts a complete HOLD contract', () => {
    expect(validateAiSignalResponse(hold, ['market'])).toBe(hold)
  })

  it('fails closed on missing live intent fields without mutating the model response', () => {
    const incomplete = { ...hold }
    delete incomplete.position_action
    delete incomplete.pending_action_reason
    expect(() => validateAiSignalResponse(incomplete, ['market']))
      .toThrow('ai_response_missing_required_fields:position_action,pending_action_reason')
    expect(incomplete).not.toHaveProperty('position_action')
    expect(incomplete).not.toHaveProperty('pending_action_reason')
  })

  it('rejects missing fields and mismatched entry methods before normalization', () => {
    expect(() => validateAiSignalResponse({ ...hold, entry_method: undefined }, ['market']))
      .toThrow('ai_response_entry_method_mismatch')
    expect(() => validateAiSignalResponse({ ...hold, signal_type: 'sell_stop_limit', entry_method: 'limit', recommended_volume: 0.01,
      invalidation_condition:'突破失效位后建议失效' }, ['stop_limit']))
      .toThrow('ai_response_entry_method_mismatch')
  })

  it('preserves methods excluded by the selected strategy for independent execution validation', () => {
    const value = {
      ...hold, signal_type: 'buy_limit', entry_method: 'limit', recommended_volume: 0.01,
      position_size_tier:'light', position_action:'open',
      invalidation_condition:'跌破失效位后建议失效',
    }
    expect(validateAiSignalResponse(value, ['market'])).toBe(value)
  })

  it('preserves pending cancellation narratives for independent execution validation', () => {
    const value = {
      ...hold, pending_action:'cancel', management_direction:'buy', pending_action_reason:'',
    }
    expect(validateAiSignalResponse(value, ['market'])).toBe(value)

    const legacy = {
      ...hold, pending_action:'cancel', management_direction:'buy',
      cancel_pending:[{ symbol:'XAUUSD', reason:'M15 跌破 4102 支撑，原买入依据已经失效' }],
    }
    expect(validateAiSignalResponse(legacy, ['market'])).toBe(legacy)
  })

  it('requires invalidation_condition for trades but leaves display narratives optional', () => {
    const trade = {
      ...hold, signal_type:'buy', entry_method:'market', position_size_tier:'light',
      position_size_reason:'结构确认后采用轻仓', position_action:'open',
      invalidation_condition:'跌破失效位后建议失效',
    }
    delete trade.analysis
    delete trade.reasoning
    expect(validateAiSignalResponse(trade, ['market'])).toBe(trade)
    const missing = { ...trade }
    delete missing.invalidation_condition
    expect(() => validateAiSignalResponse(missing, ['market']))
      .toThrow('ai_response_invalidation_condition_required')
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

  it('routes Kimi Code through its subscription endpoint with the confirmed physical output budget', async () => {
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
    expect(body.max_tokens).toBe(393216)
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
    max_position_size: 0.05
  }

  it('buy 信号正常处理', () => {
    const parsed = { signal_type: 'buy', confidence: 0.7, recommended_volume: 0.03,
      stop_loss_price:1990, take_profit_1_price:2010, bullish_score: 7, bearish_score: 3 }
    const result = normalizeAiSignal(parsed, baseConfig, baseMarket)
    expect(result.signal_type).toBe('buy')
    expect(result.confidence).toBeGreaterThan(0)
    expect(result.recommended_volume).toBe(0.03)
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

  it('低置信度不再按风险等级自动降级', () => {
    const parsed = { signal_type: 'buy', confidence: 0.2, recommended_volume: 0.03,
      stop_loss_price:1990, take_profit_1_price:2010 }
    const result = normalizeAiSignal(parsed, baseConfig, baseMarket)
    expect(result.signal_type).toBe('buy')
  })

  it('preserves model confidence instead of recalculating it from strategy score', () => {
    const result = normalizeAiSignal({ signal_type:'buy', confidence:0.2, recommended_volume:0.03,
      stop_loss_price:1990, take_profit_1_price:2010 }, baseConfig, {
      ...baseMarket, strategy_score:{ data_confidence:1, trend_strength:1 }, volatility_pct:0,
    })
    expect(result.confidence).toBe(0.2)
  })

  it('历史 mixed 缠论汇总字段不影响当前模型仓位档位', () => {
    const parsed = {
      signal_type:'buy', entry_method:'market', confidence:0.9, position_size_tier:'standard',
      position_size_reason:'趋势结构支持标准仓', position_action:'open', pending_action:'none',
      pending_action_reason:'', management_direction:'none', stop_loss_price:1990, take_profit_1_price:2010,
    }
    const result = normalizeAiSignal(parsed, baseConfig, {
      ...baseMarket,
      strategy_context:{
        context_status:'complete', missing_timeframes:[],
        chan_timeframe_alignment:{ agreement:'mixed', conflict:true },
      },
    })
    expect(result.position_size_tier).toBe('standard')
    expect(result.position_size_factor).toBe(1)
  })

  it('风险等级不再参与信号降级', () => {
    const highRiskConfig = { ...baseConfig, risk_level: 'high' }
    const parsed = { signal_type: 'buy', confidence: 0.3, recommended_volume: 0.03,
      stop_loss_price:1990, take_profit_1_price:2010 }
    const result = normalizeAiSignal(parsed, highRiskConfig, baseMarket)
    expect(result.signal_type).toBe('buy')
  })

  it('历史非严格结果保留显式 recommended_volume', () => {
    const parsed = { signal_type: 'buy', confidence: 0.8, recommended_volume: 0.1,
      stop_loss_price:1990, take_profit_1_price:2010 }
    const result = normalizeAiSignal(parsed, baseConfig, baseMarket)
    expect(result.recommended_volume).toBe(0.1)
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
        position_size_tier:'observe', position_size_reason:'等待', position_action:'observe',
        pending_action:'none', pending_action_reason:'', management_direction:'none',
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

  it('uses confirmed model token limits for an auto prompt larger than the retired character cap', async () => {
    mockFetch.mockResolvedValue({
      ok:true,
      json:() => Promise.resolve({ choices:[{ message:{ content:JSON.stringify({
        signal_type:'hold', entry_method:'observe', confidence:0.6, recommended_volume:0,
        position_size_tier:'observe', position_size_reason:'等待', position_action:'observe',
        pending_action:'none', pending_action_reason:'', management_direction:'none',
        analysis:'等待', reasoning:'模型能力允许本次输入',
      }) } }] }),
    })
    const result = await maybeAiSignal(null, {
      api_key_encrypted:'test-key', api_provider:'deepseek', model_name:'deepseek-chat',
      _usage:'auto_platform', _strategyMemoryLibraryContext:'记忆'.repeat(70_000),
    }, { symbol:'XAUUSD', timeframe:'H1', latest_price:2000,
      strategy_context:{ timeframes:{} } })

    expect(result._inference_source).toBe('ai')
    expect(mockFetch).toHaveBeenCalledTimes(1)
    const body = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(JSON.stringify(body.messages).length).toBeGreaterThan(120_000)
    expect(body.max_tokens).toBe(393_216)
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
              position_size_tier:'light',
              position_size_reason:'结构确认后采用轻仓',
              position_action:'open',
              pending_action:'none',
              pending_action_reason:'',
              management_direction:'none',
              stop_loss_price: 1990,
              take_profit_1_price: 2010,
              take_profit_2_price: 2020,
              take_profit_3_price: 2030,
              recommended_take_profit_tier: 2,
              invalidation_condition: '跌破止损结构后建议失效',
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
    expect(body.messages[0].content).toContain('禁止仅以时间、有效期或过期为理由输出 pending_action=cancel')
  })

  it('does not repair a keep/hold management evidence defect and returns server fail-closed defaults', async () => {
    const asOf = {
      decision_timeframe:'M15',
      closed_bar_time_utc_ms:1784736900000,
      market_snapshot_hash:'sha256:position-management-test',
    }
    const positionManagementContext = {
      contract_version:POSITION_MANAGEMENT_CONTRACT_VERSION,
      as_of:asOf,
      pending_groups:[{
        management_group_id:'pending_group_01',
        decision_context_status:'available', reference_facts_status:'available',
        allowed_evidence_refs:['bar:M15:1784736900000'],
      }],
      position_groups:[{
        management_group_id:'position_group_01', thesis_id:'thesis_01', decision_context_status:'available', reference_facts_status:'available',
        allowed_evidence_refs:['bar:M15:1784736900000'],
      }],
    }
    const response = {
      contract_version:POSITION_MANAGEMENT_CONTRACT_VERSION,
      as_of:asOf,
      market_regime:'range', trade_thesis:'mean_reversion',
      market_plan:{
        signal_type:'hold', entry_method:'observe', confidence:0.6,
        position_size_tier:'observe', position_size_reason:'等待结构确认',
        position_action:'observe', pending_action:'none', management_direction:'none',
        analysis:'当前没有新的交易机会', reasoning:'等待下一轮确认',
      },
      pending_evaluations:[{
        management_group_id:'pending_group_01', action:'keep', market_alignment:'aligned', cancel_reason_code:null,
        reason:'原挂单继续保留', evidence_refs:['condition:not-allowed'],
      }],
      position_evaluations:[{
        management_group_id:'position_group_01', thesis_id:'thesis_01', action:'hold', market_alignment:'aligned',
        matched_condition_id:null, reversal_candidate:false,
        reason:'原持仓继续持有', evidence_refs:['condition:not-allowed'],
      }],
      analysis:'当前没有新的交易机会', reasoning:'新仓、挂单与持仓分别完成独立判断',
    }
    mockFetch.mockResolvedValue({
      ok:true,
      json:() => Promise.resolve({ choices:[{ message:{ content:JSON.stringify(response) } }] }),
    })

    const result = await maybeAiSignal(null, {
      api_key_encrypted:'test-key', api_provider:'deepseek', model_name:'deepseek-chat',
      max_tokens:2000, _allowed_entry_methods:['market'],
      _positionManagementContext:positionManagementContext,
    }, {
      symbol:'XAUUSD', timeframe:'M15', latest_price:2000,
      strategy_context:{ timeframes:{} },
    })

    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(result._position_management.validation.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ section:'pending', code:'evidence_refs_not_allowed' }),
      expect.objectContaining({ section:'position', code:'evidence_refs_not_allowed' }),
    ]))
    expect(result._position_management.pending_evaluations[0]).toMatchObject({
      action:'keep', validation_source:'server_fail_closed',
    })
    expect(result._position_management.position_evaluations[0]).toMatchObject({
      action:'hold', validation_source:'server_fail_closed',
    })
  })

  it('repairs cancel/exit management errors instead of accepting unsafe defaults', async () => {
    const asOf = {
      decision_timeframe:'M15',
      closed_bar_time_utc_ms:1784736900000,
      market_snapshot_hash:'sha256:position-management-repair-test',
    }
    const positionManagementContext = {
      contract_version:POSITION_MANAGEMENT_CONTRACT_VERSION,
      as_of:asOf,
      pending_groups:[{
        management_group_id:'pending_group_01',
        decision_context_status:'available', reference_facts_status:'available',
        allowed_evidence_refs:['bar:M15:1784736900000'],
      }],
      position_groups:[{
        management_group_id:'position_group_01', thesis_id:'thesis_01', decision_context_status:'available', reference_facts_status:'available',
        allowed_evidence_refs:['bar:M15:1784736900000'],
      }],
    }
    const base = {
      contract_version:POSITION_MANAGEMENT_CONTRACT_VERSION,
      as_of:asOf,
      market_regime:'range', trade_thesis:'mean_reversion',
      market_plan:{
        signal_type:'hold', entry_method:'observe', confidence:0.6,
        position_size_tier:'observe', position_size_reason:'等待结构确认',
        position_action:'observe', pending_action:'none', management_direction:'none',
        analysis:'当前没有新的交易机会', reasoning:'等待下一轮确认',
      },
      analysis:'当前没有新的交易机会', reasoning:'新仓、挂单与持仓分别完成独立判断',
    }
    const invalid = {
      ...base,
      pending_evaluations:[{
        management_group_id:'pending_group_01', action:'cancel', market_alignment:'misaligned', cancel_reason_code:'model_judgment',
        reason:'挂单依据已经失效', evidence_refs:['condition:not-allowed'],
      }],
      position_evaluations:[{
        management_group_id:'position_group_01', thesis_id:'thesis_01', action:'exit', market_alignment:'misaligned',
        matched_condition_id:'missing-condition', reversal_candidate:false,
        reason:'持仓依据已经失效', evidence_refs:['condition:not-allowed'],
      }],
    }
    const repaired = {
      ...base,
      pending_evaluations:[{
        management_group_id:'pending_group_01', action:'keep', market_alignment:'aligned', cancel_reason_code:null,
        reason:'挂单依据仍然有效', evidence_refs:['bar:M15:1784736900000'],
      }],
      position_evaluations:[{
        management_group_id:'position_group_01', thesis_id:'thesis_01', action:'hold', market_alignment:'aligned',
        matched_condition_id:null, reversal_candidate:false,
        reason:'持仓依据仍然有效', evidence_refs:['bar:M15:1784736900000'],
      }],
    }
    mockFetch
      .mockResolvedValueOnce({
        ok:true,
        json:() => Promise.resolve({ choices:[{ message:{ content:JSON.stringify(invalid) } }] }),
      })
      .mockResolvedValueOnce({
        ok:true,
        json:() => Promise.resolve({ choices:[{ message:{ content:JSON.stringify(repaired) } }] }),
      })

    const result = await maybeAiSignal(null, {
      api_key_encrypted:'test-key', api_provider:'deepseek', model_name:'deepseek-chat',
      max_tokens:2000, _allowed_entry_methods:['market'],
      _positionManagementContext:positionManagementContext,
    }, {
      symbol:'XAUUSD', timeframe:'M15', latest_price:2000,
      strategy_context:{ timeframes:{} },
    })

    expect(mockFetch).toHaveBeenCalledTimes(2)
    expect(result._position_management.validation.errors).toEqual([])
    expect(result._position_management.pending_evaluations[0].action).toBe('keep')
    expect(result._position_management.position_evaluations[0].action).toBe('hold')
  })

  it('renders the generic position-management contract without service trading doctrine', async () => {
    const asOf = {
      decision_timeframe:'M15', closed_bar_time_utc_ms:1784736900000,
      market_snapshot_hash:'sha256:position-management-prompt-test',
    }
    const positionManagementContext = {
      contract_version:POSITION_MANAGEMENT_CONTRACT_VERSION, as_of:asOf,
      pending_groups:[{
        management_group_id:'pending_group_01', decision_context_status:'available', reference_facts_status:'available',
        core_entry_reason:'阻力位反转做空', entry_method:'limit', decision_timeframe:'M15', direction:'sell',
        pending_order_facts:[{ source:'private_market', direction:'sell', trigger_price:2050,
          actual_stop_loss:2070, actual_take_profit:1980, order_type:'sell_limit', created_at:'2026-08-07T08:00:00Z' }],
        allowed_evidence_refs:['bar:M15:1784736900000'],
      }],
      position_groups:[{
        management_group_id:'position_group_01', thesis_id:'thesis_01', decision_context_status:'available', reference_facts_status:'available',
        core_entry_reason:'回踩支撑后做多', entry_method:'market', decision_timeframe:'M15', direction:'buy',
        position_facts:[{ source:'private_market', direction:'buy', entry_price:2000, current_price:2010,
          actual_stop_loss:1985, actual_take_profit:2050, order_type:'position', opened_at:'2026-08-07T08:00:00Z' }],
        allowed_evidence_refs:['bar:M15:1784736900000'],
      }],
    }
    const value = {
      contract_version:POSITION_MANAGEMENT_CONTRACT_VERSION, as_of:asOf,
      market_regime:'range', trade_thesis:'mean_reversion',
      market_plan:{ signal_type:'hold', entry_method:'observe', confidence:0.6,
        position_size_tier:'observe', position_size_reason:'等待结构确认', position_action:'observe',
        pending_action:'none', pending_action_reason:'', management_direction:'none',
        analysis:'等待', reasoning:'等待' },
      pending_evaluations:[{ management_group_id:'pending_group_01', action:'keep', market_alignment:'aligned',
        cancel_reason_code:null, reason:'当前行情仍支持原挂单方向', evidence_refs:['bar:M15:1784736900000'] }],
      position_evaluations:[{ management_group_id:'position_group_01', thesis_id:'thesis_01', action:'hold',
        market_alignment:'aligned', exit_reason_code:null, reversal_candidate:false,
        reason:'当前行情仍支持原持仓方向', evidence_refs:['bar:M15:1784736900000'] }],
      analysis:'等待', reasoning:'等待',
    }
    mockFetch.mockResolvedValue({ ok:true,
      json:() => Promise.resolve({ choices:[{ message:{ content:JSON.stringify(value) } }] }) })
    await maybeAiSignal(null, {
      api_key_encrypted:'test-key', api_provider:'deepseek', model_name:'deepseek-chat',
      max_tokens:2000, _allowed_entry_methods:['market'], _market_only:true,
      _positionManagementContext:positionManagementContext,
    }, { symbol:'XAUUSD', timeframe:'M15', latest_price:2000, strategy_context:{ timeframes:{} },
      strategy_reference_portfolio:{
        role:'platform_strategy_reference_portfolio', positions:[],
        pending_orders:[{ reference_id:'outcome:7', direction:'sell', trigger_price:2050,
          valid_until_utc_msc:1784748720000, valid_until_utc:'2026-07-22T06:12:00.000Z',
          is_expired:true, remaining_seconds:0 }],
      },
    })
    const body = JSON.parse(mockFetch.mock.calls[0][1].body)
    const systemPrompt = body.messages[0].content
    expect(systemPrompt).toContain('持仓与挂单管理输出合同')
    expect(systemPrompt).toContain('观摩源当前 reference portfolio')
    expect(systemPrompt).toContain('只有合法 cancel/exit 结论才由服务端按冻结 origin_signal_id')
    expect(systemPrompt).not.toContain('不代表管理组消失')
    expect(systemPrompt).toContain('market_alignment')
    expect(systemPrompt).not.toContain('只有明确 market_alignment=misaligned')
    expect(systemPrompt).not.toContain('禁止因到期、有效期、盈利保护')
    expect(systemPrompt).not.toContain('risk_reduction')
    expect(systemPrompt).not.toContain('model_judgment')
    expect(systemPrompt).not.toContain('protection_status')
    expect(JSON.stringify(body.messages[1])).not.toContain('protection_status')
    expect(JSON.stringify(body.messages[1])).not.toMatch(/valid_until|is_expired|remaining_seconds/)
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

  it('历史重放即使用户提示词为空也完全旁路新 Chan 投影和紧凑编码', async () => {
    vi.clearAllMocks()
    mockFetch.mockResolvedValue({
      ok:true,
      json:() => Promise.resolve({ choices:[{ message:{ content:JSON.stringify({
        signal_type:'hold', entry_method:'observe', confidence:0.6, recommended_volume:0,
        analysis:'等待确认', reasoning:'冻结输入',
      }) } }] }),
    })
    let evidence
    const market = {
      symbol:'XAUUSD', timeframe:'M5', latest_price:2000,
      strategy_context:{ timeframes:{ M5:{ klines:[{ time:'legacy', open:1, high:2, low:0, close:1 }], summary:{ chan:{
        current_segment:{ id:1 }, status:'partial', trend_state:'up', evidence_capabilities:{ entry_structure_usable:false },
      } } } } },
    }
    await maybeAiSignal(null, {
      api_key_encrypted:'test-key', api_provider:'deepseek', model_name:'deepseek-chat',
      _comparison_replay_system_prompt:'stored system prompt',
      _comparison_replay_user_prompt:'', _use_chan_analysis:true,
      _onInferencePrepared:value => { evidence = value },
    }, market)

    expect(JSON.parse(mockFetch.mock.calls[0][1].body).messages).toEqual([
      { role:'system', content:'stored system prompt' },
      { role:'user', content:'' },
    ])
    expect(evidence.aiPayload.strategy_context.timeframes.M5.summary.chan).toMatchObject({
      current_segment:{ id:1 }, status:'partial', trend_state:'up',
    })
    expect(evidence.aiPayload.strategy_context.timeframes.M5.klines[0]).toEqual({
      time:'legacy', open:1, high:2, low:0, close:1,
    })
    expect(evidence.aiPayload.strategy_context).not.toHaveProperty('input_encoding')
  })

  it('拒绝新鲜 Chan 输入中的 JSON Pointer 且不调用 provider', async () => {
    vi.clearAllMocks()
    let evidence
    const result = await maybeAiSignal(null, {
      api_key_encrypted:'test-key', api_provider:'deepseek', model_name:'deepseek-chat',
      _use_chan_analysis:true, _onInferencePrepared:value => { evidence = value },
    }, {
      symbol:'XAUUSD', timeframe:'M5', latest_price:2000,
      strategy_context:{ timeframes:{ M5:{ summary:{ chan:{
        current_segment:{ nested:{ $ref:'#/legacy/current_segment' } },
      } } } } },
    })
    expect(result.reasoning).toContain('chan_model_payload_reference_forbidden')
    expect(result._inference_source).toBe('ai_error_hold')
    expect(evidence).toBeUndefined()
    expect(mockFetch).not.toHaveBeenCalled()
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
    expect(evidence.systemPrompt).toContain('共享市场事实边界')
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

  it('keeps service-generated strategy scores and ATR anchors out of generic model input', async () => {
    mockFetch.mockResolvedValue({
      ok:true,
      json:() => Promise.resolve({ choices:[{ message:{ content:JSON.stringify({
        signal_type:'hold', entry_method:'observe', confidence:0.6,
        position_size_tier:'observe', position_size_reason:'等待', position_action:'observe',
        pending_action:'none', pending_action_reason:'', management_direction:'none',
        analysis:'等待', reasoning:'等待',
      }) } }] }),
    })
    let evidence
    await maybeAiSignal(null, {
      api_key_encrypted:'test-key', api_provider:'deepseek', model_name:'deepseek-chat',
      _market_only:true, _onInferencePrepared:value => { evidence = value },
    }, {
      symbol:'XAUUSD', standard_symbol:'XAUUSD', timeframe:'M5', latest_price:2000,
      strategy_score:{ data_confidence:0.9, trend_strength:0.8 },
      atr_anchor:15, atr_anchor_tf:'H1',
      strategy_context:{ timeframes:{ M5:{ summary:{ strategy_score:{ trend_strength:0.8 }, chan:{ status:'ok' } }, klines:[] } } },
    })
    expect(evidence.systemPrompt).not.toContain('strategy_score')
    expect(evidence.systemPrompt).not.toContain('atr_anchor')
    expect(evidence.systemPrompt).not.toContain('atr_anchor_tf')
    expect(evidence.systemPrompt).not.toContain('EMA34')
    expect(evidence.systemPrompt).not.toContain('0.52-0.62')
    expect(evidence.systemPrompt).not.toContain('R:R')
    expect(evidence.systemPrompt).not.toContain('按以下顺序')
    expect(evidence.systemPrompt).not.toContain('方向优势不清晰')
    expect(evidence.userPrompt).not.toContain('strategy_score')
    expect(evidence.userPrompt).not.toContain('atr_anchor')
    expect(evidence.userPrompt).not.toContain('atr_anchor_tf')
  })

  it('passes only explicitly declared indicator facts as neutral model input', async () => {
    mockFetch.mockResolvedValue({
      ok:true,
      json:() => Promise.resolve({ choices:[{ message:{ content:JSON.stringify({
        signal_type:'hold', entry_method:'observe', confidence:0.6,
        position_size_tier:'observe', position_size_reason:'等待', position_action:'observe',
        pending_action:'none', pending_action_reason:'', management_direction:'none',
        analysis:'等待', reasoning:'等待',
      }) } }] }),
    })
    let evidence
    await maybeAiSignal(null, {
      api_key_encrypted:'test-key', api_provider:'deepseek', model_name:'deepseek-chat',
      _market_only:true, _onInferencePrepared:value => { evidence = value },
    }, {
      symbol:'XAUUSD', standard_symbol:'XAUUSD', timeframe:'M5', latest_price:2000,
      strategy_context:{ timeframes:{}, indicators:{
        entry_ema34:{ ready:true, kind:'ema', source:{ timeframe:'M5', bar_scope:'closed_only' },
          value:1998.25, evidence_hash:'a'.repeat(64) },
      } },
    })
    const payload = JSON.parse(evidence.userPrompt.replace('市场数据 JSON：\n', ''))
    expect(payload.strategy_context.indicators.entry_ema34).toMatchObject({
      ready:true, kind:'ema', value:1998.25, source:{ timeframe:'M5', bar_scope:'closed_only' },
    })
    expect(evidence.systemPrompt).toContain('系统提供的数据')
    expect(evidence.systemPrompt).toContain('strategy_context.indicators.entry_ema34 是系统按策略声明计算的 EMA34 数据')
    expect(evidence.systemPrompt).toContain('中性事实')
    expect(evidence.systemPrompt).not.toContain('价格在 EMA34 上方')
    expect(evidence.systemPrompt).not.toContain('strategy_policy_trace')
  })

  it('adds only a neutral EMA34 identity when the managed declaration is present', async () => {
    mockFetch.mockResolvedValue({ ok:true, json:() => Promise.resolve({ choices:[{ message:{ content:JSON.stringify({
      signal_type:'hold', entry_method:'observe', confidence:0.5, position_size_tier:'observe',
      position_size_reason:'等待', position_action:'observe', pending_action:'none', pending_action_reason:'',
      management_direction:'none', analysis:'等待', reasoning:'等待',
    }) } }] }) })
    let evidence
    await maybeAiSignal(null, { api_key_encrypted:'test-key', api_provider:'deepseek', model_name:'deepseek-chat',
      _market_only:true, _onInferencePrepared:value => { evidence = value } }, {
      symbol:'XAUUSD', standard_symbol:'XAUUSD', timeframe:'M5', latest_price:2000,
      strategy_context:{ timeframes:{}, indicators:{ ema34:{ ready:true, kind:'ema', value:1999,
        source:{ timeframe:'M5', bar_scope:'closed_only' }, evidence_hash:'b'.repeat(64) } } },
    })
    expect(evidence.systemPrompt).toContain('strategy_context.indicators.ema34 是系统按策略声明计算的 EMA34 数据')
    expect(evidence.systemPrompt).not.toMatch(/上方只做多|下方禁止|过滤通过|必须观望/)
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
    expect(evidence.systemPrompt).toContain('私有策略账户事实')
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

  it('keeps the complete strategy memory library out of the system prompt and sends it as untrusted user data', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ choices: [{ message: { content: JSON.stringify({
        signal_type: 'hold', entry_method: 'observe', confidence: 0.6, recommended_volume: 0,
        analysis: '等待', reasoning: '当前没有明确优势',
      }) } }] }),
    })
    const memoryMarker = 'MEMORY_INJECTION_MARKER_IGNORE_STRATEGY'
    const memoryContext = `# 策略记忆库\n- ${memoryMarker}`
    let evidence

    await maybeAiSignal(null, {
      api_key_encrypted: 'test-key', api_provider: 'deepseek', model_name: 'deepseek-chat',
      _strategyMemoryLibraryContext:memoryContext, _strategyMemoryLibraryVersion:4,
      _strategyMemoryLibraryHash:'f'.repeat(64), _onInferencePrepared: value => { evidence = value },
    }, {
      symbol: 'XAUUSD', timeframe: 'M5', latest_price: 2000,
      account: { balance: 10000 }, positions: [], pending_orders: [], strategy_context: { timeframes: {} },
    })

    const body = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(body.messages[0].content).toContain('策略记忆库数据边界')
    expect(body.messages[0].content).not.toContain(memoryMarker)
    expect(body.messages[1].content).toContain(memoryMarker)
    const userPayload = JSON.parse(body.messages[1].content.replace('市场数据 JSON：\n', ''))
    expect(userPayload.strategy_memory_library).toMatchObject({ version_no:4, content_hash:'f'.repeat(64) })
    expect(userPayload.strategy_memory_library.content_text).toContain(memoryMarker)
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
    expect(body.messages[0].content).toContain('strategy_context.timeframes 各周期 summary.chan 为系统计算的缠论结构，请仅按当前策略正文自行分析。')
    expect(body.messages[0].content).not.toContain('缠论数据字典')
    expect(body.messages[0].content).not.toContain('forming_divergence')
    expect(body.messages[0].content).not.toContain('entry_candidates')
    expect(body.messages[0].content).not.toContain('周期职责')
    expect(body.messages[0].content).not.toContain('证据权重')
    expect(body.messages[0].content).not.toContain('观望条件')
    expect(body.messages[0].content).not.toMatch(/\bagreement\s*=/i)
    expect(body.messages[0].content).not.toContain('alignment_with_higher')
    expect(body.messages[0].content).not.toContain('agreement=mixed')
    expect(body.messages[0].content).not.toContain('alignment_with_higher=conflict')
    expect(body.messages[0].content).not.toContain('bi_center_count')
    expect(body.messages[0].content).not.toContain('segment_history_unresolved')
    expect(body.messages[0].content).not.toContain('structure_topology_reliable')
    expect(body.messages[0].content).not.toContain('time_location_reliable')
    expect(body.messages[0].content).not.toContain('JSON Pointer')
    expect(body.messages[0].content).not.toContain('$ref')
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
      strategy_context: { visualization_klines: { M5: [{ time: 'internal-only' }] }, timeframes: { M5: { klines:[{ time:'2026-01-01 00:00:00', time_utc_msc:1, time_server_msc:2, captured_at_utc_msc:3, open:1, high:2, low:0.5, close:1.5, tick_volume:10, spread:1 }], summary: { chan: {
        current_segment:{ id:1, confirmed:true }, status:'ok', price_vs_center:'above',
        trend_state:{ state:'upward_breakout', direction:'up', phase:'breakout', confidence:'medium' },
        evidence_capabilities:{ entry_structure_usable:true },
      } } } } }
    }
    const originalChan = structuredClone(market.strategy_context.timeframes.M5.summary.chan)
    await maybeAiSignal(null, config, market)
    const body = JSON.parse(mockFetch.mock.calls[0][1].body)
    const userPayload = JSON.parse(body.messages[1].content.replace('市场数据 JSON：\n', ''))
    expect(userPayload.strategy_context.timeframes.M5.summary.chan).toBeDefined()
    expect(userPayload.strategy_context.timeframes.M5.summary.chan).toEqual({
      current_segment:{ id:1, confirmed:true },
      price_vs_center:'above',
      trend_state:{ state:'upward_breakout', direction:'up', phase:'breakout', confidence:'medium' },
      evidence_capabilities:{
        history_complete:false,
        continuity_complete:false,
        topology_input_complete:false,
        data_complete:false,
        local_structure_usable:false,
        segment_direction_usable:false,
        center_structure_usable:false,
        entry_structure_usable:true,
        divergence_usable:false,
      },
    })
    expect(userPayload.strategy_context.timeframes.M5.summary.chan).not.toHaveProperty('status')
    expect(userPayload.strategy_context.timeframes.M5.summary.chan.evidence_capabilities)
      .not.toHaveProperty('reason_codes')
    expect(userPayload.strategy_context).not.toHaveProperty('visualization_klines')
    expect(userPayload).not.toHaveProperty('atr_anchor')
    expect(userPayload).not.toHaveProperty('atr_anchor_tf')
    expect(body.messages[0].content).not.toContain('JSON Pointer')
    expect(body.messages[0].content).not.toContain('$ref')
    expect(market.strategy_context.timeframes.M5.summary.chan).toEqual(originalChan)
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
      strategy_context: { timeframes: { M5: { summary: { chan: { status: 'ok', current_segment:{ nested:{ $ref:'#/legacy/current_segment' } } } } } } }
    }
    await maybeAiSignal(null, config, market)
    const body = JSON.parse(mockFetch.mock.calls[0][1].body)
    const userPayload = JSON.parse(body.messages[1].content.replace('市场数据 JSON：\n', ''))
    expect(userPayload.strategy_context.timeframes.M5.summary.chan).toBeUndefined()
  })
})

describe('normalizeAiSignal - model-provided SL contract', () => {
  const market = { latest_price: 4000, atr_anchor: 10, atr_anchor_tf: 'H1', atr_14: 10, strategy_score: {} }
  const config = { max_position_size: 0.05 }

  it('fails closed without synthesizing a missing stop loss', () => {
    const result = normalizeAiSignal({
      signal_type: 'buy_limit', confidence: 0.8, limit_price: 3980,
    }, config, market)
    expect(result).toMatchObject({ signal_type:'hold', recommended_volume:0,
      normalization_info:{ type:'l5_schema_hold', reason:'missing_valid_sl_or_tp' } })
    expect(result.stop_loss_price).toBeUndefined()
  })

  it('preserves a valid model stop loss and does not widen or narrow it', () => {
    const result = normalizeAiSignal({
      signal_type: 'buy_limit', confidence: 0.8, recommended_volume: 0.03, limit_price: 3980,
      stop_loss_price: 3975, take_profit_1_price: 4000,
    }, config, market)
    expect(result).toMatchObject({ signal_type:'buy_limit', recommended_volume:0.03,
      position_size_tier:'light', stop_loss_price:3975, take_profit_1_price:4000 })
    expect(result.normalization_info?.type).not.toBe('sl_widened')
  })

  it('keeps a model-provided distant stop loss for downstream policy checks', () => {
    const result = normalizeAiSignal({ signal_type:'buy', confidence:0.8, recommended_volume:0.03,
      stop_loss_price:3940, take_profit_1_price:4020 }, config, { ...market, atr_anchor:15 })
    expect(result).toMatchObject({ signal_type:'buy', recommended_volume:0.03,
      position_size_tier:'light', stop_loss_price:3940 })
  })

  it('does not require ATR when the model supplies a valid stop loss', () => {
    const result = normalizeAiSignal({ signal_type:'buy', confidence:0.8, recommended_volume:0.03,
      stop_loss_price:3990, take_profit_1_price:4020 }, config, { ...market, atr_anchor:0 })
    expect(result).toMatchObject({ signal_type:'buy', recommended_volume:0.03,
      stop_loss_price:3990, take_profit_1_price:4020 })
    expect(result.normalization_info?.type).not.toBe('atr_anchor_unavailable_hold')
  })

  it('keeps historical volume explicit while strict AI output uses zero', () => {
    const historical = normalizeAiSignal({ signal_type:'buy', confidence:0.8, recommended_volume:0.08,
      stop_loss_price:3990, take_profit_1_price:4020 }, config, market)
    expect(historical.recommended_volume).toBe(0.08)
    const current = normalizeAiSignal({ _inference_source:'ai', signal_type:'buy', entry_method:'market',
      confidence:0.8, recommended_volume:0.08, position_size_tier:'light',
      position_size_reason:'结构确认后采用轻仓', position_action:'open', pending_action:'none',
      pending_action_reason:'', management_direction:'none', invalidation_condition:'跌破失效位后建议失效',
      stop_loss_price:3990, take_profit_1_price:4020, recommended_take_profit_tier:1,
    }, config, market)
    expect(current).toMatchObject({ signal_type:'buy', recommended_volume:0 })
  })
})

describe('normalizeAiSignal - L5 strict schema', () => {
  const market = { latest_price: 2000, atr_anchor: 10, strategy_score: {}, volatility_pct: 0 }
  const config = { max_position_size: 0.05 }
  const strictHoldFields = {
    position_size_tier:'observe', position_size_reason:'等待结构确认', position_action:'observe',
    pending_action:'none', pending_action_reason:'', management_direction:'none',
  }
  const strictTradeFields = {
    position_size_tier:'light', position_size_reason:'结构确认后采用轻仓', position_action:'open',
    pending_action:'none', pending_action_reason:'', management_direction:'none',
    invalidation_condition:'跌破失效位后当前建议失效',
  }

  it('keeps a valid AI hold with nullable trade prices and calibrated confidence', () => {
    const result = normalizeAiSignal({
      _inference_source: 'ai', signal_type: 'hold', entry_method: 'observe', confidence: 0.65,
      ...strictHoldFields,
      recommended_volume: 0, stop_loss_price: null, take_profit_1_price: null,
    }, config, market)
    expect(result.signal_type).toBe('hold')
    expect(result.entry_method).toBe('observe')
    expect(result.confidence).toBeGreaterThan(0)
    expect(result.normalization_info?.type).not.toBe('l5_schema_hold')
    expect(result.execution_validation).toEqual({ status:'ineligible', eligible:false, reason_codes:['model_hold'] })
  })

  it('does not synthesize missing TP2 or TP3 for a current model result', () => {
    const result = normalizeAiSignal({
      _inference_source:'ai', signal_type:'buy', entry_method:'market', confidence:0.67,
      ...strictTradeFields, recommended_volume:0.02,
      stop_loss_price:1990, take_profit_1_price:2020, recommended_take_profit_tier:1,
      analysis:'模型原始分析', reasoning:'模型原始理由',
    }, config, market)
    expect(result).toMatchObject({
      signal_type:'buy', confidence:0.67, analysis:'模型原始分析', reasoning:'模型原始理由',
      take_profit_1_price:2020, take_profit_2_price:null, take_profit_3_price:null,
      execution_validation:{ status:'eligible', eligible:true, reason_codes:[] },
      model_decision:{ signal_type:'buy', confidence:0.67, analysis:'模型原始分析', reasoning:'模型原始理由' },
    })
  })

  it('keeps generic consistency declarations as audit data without enforcing a strategy ratio', () => {
    const result = normalizeAiSignal({
      _inference_source:'ai', signal_type:'buy', entry_method:'market', confidence:0.67,
      ...strictTradeFields, stop_loss_price:1990, take_profit_1_price:2005,
      recommended_take_profit_tier:1, hard_gate_status:'pass', hard_gate_failures:[],
      minimum_reward_to_risk:1.5, recommended_reward_to_risk:0.5, reward_to_risk_status:'pass',
    }, config, market)
    expect(result.execution_validation).toEqual({ status:'eligible', eligible:true, reason_codes:[] })
    expect(result.model_decision).toMatchObject({
      hard_gate_status:'pass', hard_gate_failures:[], minimum_reward_to_risk:1.5,
      recommended_reward_to_risk:0.5, reward_to_risk_status:'pass',
    })
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

  it('normalizes a trade-shaped no-add model conclusion to hold while preserving evidence', () => {
    const result = normalizeAiSignal({
      _inference_source:'ai', signal_type:'buy_limit', entry_method:'limit', confidence:0.8,
      position_size_tier:'probe', position_size_reason:'等待回踩', position_action:'hold_no_add',
      pending_action:'none', pending_action_reason:'', management_direction:'none', limit_price:1995,
      stop_loss_price:1985, take_profit_1_price:2010, recommended_take_profit_tier:1,
      invalidation_condition:'跌破失效位后当前建议失效',
      analysis:'偏多但不加仓', reasoning:'已有同向持仓',
    }, { ...config, _allowed_entry_methods:['limit'] }, market)
    expect(result).toMatchObject({
      signal_type:'hold', entry_method:'observe', recommended_volume:0,
      position_size_tier:'observe', position_action:'hold_no_add', limit_price:null,
      stop_loss_price:null, take_profit_1_price:null,
      candidate_entry:{ signal_type:'buy_limit', direction:'buy', entry_method:'limit', entry_price:1995,
        stop_loss_price:1985, take_profit_1_price:2010 },
      model_decision:{ signal_type:'buy_limit', entry_method:'limit', position_action:'hold_no_add' },
      execution_validation:{ status:'ineligible', eligible:false, reason_codes:['model_hold'] },
    })
    expect(result.position_size_reason).toBe('模型同时给出交易与不新增仓位结论，字段冲突，本次不执行。')
    expect(result.decision_summary).toBe('模型同时给出交易与不新增仓位结论，字段冲突，本次不执行。')
    expect(result.pending_valid_minutes).toBe(0)
    expect(result.pending_valid_until).toBeNull()
    expect(result.normalization_info).toMatchObject({
      type:'trade_hold_no_add_conflict', reason:'trade_hold_no_add_conflict',
      original_signal_type:'buy_limit', original_entry_method:'limit',
    })
  })

  it('preserves an independent pending cancellation when a trade-shaped no-add conclusion becomes hold', () => {
    const result = normalizeAiSignal({
      _inference_source:'ai', signal_type:'buy_limit', entry_method:'limit', confidence:0.8,
      position_size_tier:'probe', position_size_reason:'等待回踩', position_action:'hold_no_add',
      pending_action:'cancel', pending_action_reason:'原买入挂单的结构前提已经失效',
      management_direction:'buy', limit_price:1995,
      stop_loss_price:1985, take_profit_1_price:2010, recommended_take_profit_tier:1,
      invalidation_condition:'跌破失效位后当前建议失效',
    }, { ...config, _allowed_entry_methods:['limit'] }, market)
    expect(result).toMatchObject({
      signal_type:'hold', entry_method:'observe', position_action:'hold_no_add',
      pending_action:'cancel', pending_action_reason:'原买入挂单的结构前提已经失效',
      management_direction:'buy',
      execution_validation:{ status:'eligible', eligible:true, reason_codes:[] },
      model_decision:{ signal_type:'buy_limit', entry_method:'limit', position_action:'hold_no_add' },
    })
  })

  it('preserves an invalid explicit entry method without granting execution', () => {
    const result = normalizeAiSignal({
      _inference_source: 'ai', signal_type: 'buy', entry_method: 'instant', confidence: 0.8,
      ...strictTradeFields,
      recommended_volume: 0.02, stop_loss_price: 1990, take_profit_1_price: 2020,
    }, config, market)
    expect(result).toMatchObject({ signal_type:'buy', entry_method:'instant', recommended_volume:0,
      execution_validation:{ status:'ineligible', eligible:false,
        reason_codes:expect.arrayContaining(['entry_method_not_allowed_by_strategy']) } })
  })

  it('preserves a model response that uses a disabled entry method but blocks execution', () => {
    const result = normalizeAiSignal({
      _inference_source: 'ai', signal_type: 'buy_limit', entry_method: 'limit', confidence: 0.8,
      ...strictTradeFields,
      recommended_volume: 0.02, limit_price: 1995, stop_loss_price: 1985, take_profit_1_price: 2015,
    }, { ...config, _allowed_entry_methods: ['market'] }, market)
    expect(result).toMatchObject({ signal_type:'buy_limit', entry_method:'limit', recommended_volume:0,
      execution_validation:{ status:'ineligible', eligible:false,
        reason_codes:expect.arrayContaining(['entry_method_not_allowed_by_strategy']) } })
  })

  it('ignores a legacy absolute model volume in the current tier contract', () => {
    const result = normalizeAiSignal({
      _inference_source: 'ai', signal_type: 'buy', entry_method: 'market', confidence: 0.8,
      ...strictTradeFields,
      recommended_volume: 0.06, stop_loss_price: 1990, take_profit_1_price: 2020,
      recommended_take_profit_tier: 1,
    }, config, market)
    expect(result).toMatchObject({ signal_type: 'buy', recommended_volume:0, position_size_tier:'light', position_size_factor:0.5 })
  })

  it('does not copy a configured platform volume ceiling into the AI result', () => {
    const result = normalizeAiSignal({
      _inference_source: 'ai', signal_type: 'buy', entry_method: 'market', confidence: 0.8,
      ...strictTradeFields,
      recommended_volume: 0.08, stop_loss_price: 1990, take_profit_1_price: 2020,
      recommended_take_profit_tier: 1,
    }, { ...config, max_position_size: 0.1, _ai_volume_min: 0.02, _ai_volume_max: 0.1, _ai_volume_step: 0.02 }, market)
    expect(result).toMatchObject({ signal_type: 'buy', recommended_volume: 0, position_size_tier:'light', position_size_factor:0.5 })
  })

  it('does not let a legacy absolute volume control the new risk-tier contract', () => {
    const result = normalizeAiSignal({
      _inference_source: 'ai', signal_type: 'buy', entry_method: 'market', confidence: 0.8,
      ...strictTradeFields,
      recommended_volume: 0.07, stop_loss_price: 1990, take_profit_1_price: 2020,
      recommended_take_profit_tier: 1,
    }, { ...config, max_position_size: 0.1, _ai_volume_min: 0.02, _ai_volume_max: 0.1, _ai_volume_step: 0.02 }, market)
    expect(result).toMatchObject({ signal_type: 'buy', recommended_volume:0, position_size_tier:'light', position_size_factor:0.5 })
  })

  it('preserves a missing AI take-profit recommendation but blocks execution', () => {
    const result = normalizeAiSignal({
      _inference_source: 'ai', signal_type: 'buy', entry_method: 'market', confidence: 0.8,
      ...strictTradeFields,
      recommended_volume: 0.02, stop_loss_price: 1990, take_profit_1_price: 2020,
    }, config, market)
    expect(result).toMatchObject({ signal_type:'buy', recommended_volume:0,
      execution_validation:{ status:'ineligible', eligible:false,
        reason_codes:expect.arrayContaining(['invalid_recommended_take_profit_tier']) } })
  })

  it('preserves a sell stop-limit with invalid trigger direction but blocks execution', () => {
    const result = normalizeAiSignal({
      _inference_source: 'ai', signal_type: 'sell_stop_limit', entry_method: 'stop_limit', confidence: 0.8,
      ...strictTradeFields,
      recommended_volume: 0.02, limit_price: 2005, stop_limit_price: 2010,
      stop_loss_price: 2020, take_profit_1_price: 1980, recommended_take_profit_tier: 1,
    }, { ...config, _allowed_entry_methods: ['stop_limit'] }, market)
    expect(result).toMatchObject({ signal_type:'sell_stop_limit', entry_method:'stop_limit', recommended_volume:0,
      execution_validation:{ status:'ineligible', eligible:false,
        reason_codes:expect.arrayContaining(['pending_price_direction_invalid']) } })
  })

  it('preserves a sell stop-limit with invalid post-trigger relation but blocks execution', () => {
    const result = normalizeAiSignal({
      _inference_source: 'ai', signal_type: 'sell_stop_limit', entry_method: 'stop_limit', confidence: 0.8,
      ...strictTradeFields,
      recommended_volume: 0.02, limit_price: 1995, stop_limit_price: 1990,
      stop_loss_price: 2020, take_profit_1_price: 1980, recommended_take_profit_tier: 1,
    }, { ...config, _allowed_entry_methods: ['stop_limit'] }, market)
    expect(result).toMatchObject({ signal_type:'sell_stop_limit', entry_method:'stop_limit', recommended_volume:0,
      execution_validation:{ status:'ineligible', eligible:false,
        reason_codes:expect.arrayContaining(['stop_limit_price_relation_invalid']) } })
  })

  it('keeps a valid sell stop-limit and stores its validity as UTC', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-17T04:00:00Z'))
    try {
      const result = normalizeAiSignal({
        _inference_source: 'ai', signal_type: 'sell_stop_limit', entry_method: 'stop_limit', confidence: 0.8,
        ...strictTradeFields,
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
