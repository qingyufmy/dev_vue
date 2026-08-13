import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { attachSignalPresentation, buildExecutionAdvice, normalizeDecisionFields, restrictSignalExperienceUsage } from '../../server/routes/ai/signal-presentation.js'
import { attachExecutionValidation, attachExecutionValidationToDecision, executionValidationRejection, normalizeExecutionValidation, readExecutionValidation } from '../../server/routes/ai/signal-execution-validation.js'

const app = readFileSync(new URL('../../public/ai/app.js', import.meta.url), 'utf8')

describe('signal presentation', () => {
  it('normalizes the independent eligible contract', () => {
    expect(normalizeExecutionValidation({
      status:'eligible', eligible:true, reason_codes:['strategy_policy_passed', 'strategy_policy_passed'],
    })).toEqual({ status:'eligible', eligible:true, reason_codes:['strategy_policy_passed'] })
    expect(normalizeExecutionValidation({ status:'ineligible', eligible:false, reason_codes:['risk_blocked'] }))
      .toEqual({ status:'ineligible', eligible:false, reason_codes:['risk_blocked'] })
  })

  it('treats malformed explicit output as invalid instead of legacy eligible', () => {
    const state = readExecutionValidation({ execution_validation:{ status:'eligible', eligible:false } })
    expect(state).toMatchObject({ explicit:true, legacy:false, validation:{ status:'invalid_output', eligible:false } })
    expect(executionValidationRejection(state)).toMatchObject({
      status:'rejected', error_code:'execution_validation_ineligible',
      message:'执行资格校验未通过，本次不会发送交易指令',
      details:{ execution_validation:{ status:'invalid_output', eligible:false } },
    })
  })

  it('keeps legacy records on an explicit compatibility path', () => {
    const state = readExecutionValidation({ signal_type:'buy' })
    expect(state).toMatchObject({ explicit:false, legacy:true, validation:{ status:'eligible', eligible:true } })
    expect(readExecutionValidation({}, { legacyAllowed:false }).validation).toMatchObject({
      status:'invalid_output', eligible:false, reason_codes:['execution_validation_missing'],
    })
  })

  it('reads persisted decision_json and attaches only explicit values to decisions', () => {
    const signal = { signal_type:'sell', decision_json:JSON.stringify({
      execution_validation:{ status:'ineligible', eligible:false, reason_codes:['strategy_blocked'] },
    }) }
    expect(attachExecutionValidation(signal).execution_validation).toMatchObject({ status:'ineligible', eligible:false })
    expect(attachExecutionValidationToDecision({ decision_summary:'保留模型结论' }, signal)).toMatchObject({
      decision_summary:'保留模型结论',
      execution_validation:{ status:'ineligible', eligible:false, reason_codes:['strategy_blocked'] },
    })
  })

  it('shows platform usage only to admins and personal usage only to its owner', () => {
    const platform = { user_id:0, experience_usage:{ source:'platform', considered_ids:[3], used_ids:[3], influence:'采用平台经验' } }
    expect(restrictSignalExperienceUsage(platform, { requesterUserId:7, requesterRole:'user' }).experience_usage).toBeUndefined()
    expect(restrictSignalExperienceUsage(platform, { requesterUserId:1, requesterRole:'admin' }).experience_usage.used_ids).toEqual([3])

    const personal = { user_id:7, decision_json:JSON.stringify({ experience_usage:{ source:'personal', considered_ids:[9], used_ids:[9] } }) }
    expect(JSON.parse(restrictSignalExperienceUsage(personal, { requesterUserId:8, requesterRole:'user' }).decision_json)).not.toHaveProperty('experience_usage')
    expect(JSON.parse(restrictSignalExperienceUsage(personal, { requesterUserId:7, requesterRole:'user' }).decision_json).experience_usage.used_ids).toEqual([9])
    expect(JSON.parse(restrictSignalExperienceUsage(personal, { requesterUserId:1, requesterRole:'admin' }).decision_json)).not.toHaveProperty('experience_usage')
    expect(restrictSignalExperienceUsage({ user_id:7, experience_usage:{ considered_ids:[99] } }, { requesterUserId:7, requesterRole:'user' }).experience_usage).toBeUndefined()
  })
  it('does not present an unavailable confidence sentinel as a measured zero percent', () => {
    expect(app).toContain('if (rounded === 0) return { value: 0, label: "不可用" }')
  })
  it('renders localized server diagnostics without exposing internal reason details', () => {
    expect(app).toContain('function renderDecisionDiagnostics(diagnostics)')
    expect(app).toContain('行情连续性未确认')
    expect(app).toContain('策略入场条件未满足')
    expect(app).toContain('模型主动观望')
    expect(app).not.toContain('diagnostics.reason_details')
  })
  it('normalizes model fields and limits untrusted arrays', () => {
    const result = normalizeDecisionFields({ signal_type: 'buy', decision_summary: '  顺势做多  ', bullish_score: 63, bearish_score: 37, key_reasons: ['趋势向上', '', '回踩支撑', '量能改善', '结构完整', 'ignored'] })
    expect(result.schema_version).toBe(6)
    expect(result.decision_summary).toBe('顺势做多')
    expect(result.key_reasons).toHaveLength(4)
    expect(result).toMatchObject({ bullish_score: 63, bearish_score: 37 })
  })

  it('persists only bounded server-owned decision diagnostics', () => {
    const result = normalizeDecisionFields({ signal_type:'hold', decision_diagnostics:{
      decision_diagnostics_version:999,
      decision_origin:'constraint_engine',
      contributing_reasons:['market_data_unreliable', 'invented_reason'],
      affected_timeframes:['M5', 'BAD'],
      reason_details:[{ code:'market_data_unreliable', timeframes:['M5', 'BAD'],
        source_codes:['market_open_bars_missing', '<script>alert(1)</script>'] }],
    } })
    expect(result.decision_diagnostics).toEqual({
      decision_diagnostics_version:1,
      decision_origin:'constraint_engine',
      contributing_reasons:['market_data_unreliable'],
      affected_timeframes:['M5'],
      reason_details:[{ code:'market_data_unreliable', timeframes:['M5'],
        source_codes:['market_open_bars_missing', '<script>alert(1)</script>'] }],
    })
  })

  it('keeps legacy signals free of synthetic decision diagnostics', () => {
    expect(normalizeDecisionFields({ signal_type:'hold' })).not.toHaveProperty('decision_diagnostics')
  })

  it('derives stop-loss distance and ATR context from existing signal evidence', () => {
    const result = normalizeDecisionFields({
      signal_type:'buy_limit', entry_method:'limit', limit_price:4160.5, stop_loss_price:4154.8,
      market_data:{ latest_price:4162, atr_anchor:12.5 },
    })
    expect(result.stop_loss_diagnostics).toMatchObject({
      entry_price:4160.5, stop_loss_price:4154.8, atr_anchor:12.5, distance_atr:0.456,
    })
    expect(result.stop_loss_diagnostics.distance).toBeCloseTo(5.7, 8)
  })

  it('persists sanitized candidate entry evidence for a normalized no-add hold', () => {
    const result = normalizeDecisionFields({
      signal_type:'hold', entry_method:'observe', position_action:'hold_no_add',
      candidate_entry:{ signal_type:'buy_limit', entry_method:'limit', entry_price:'1995', stop_loss_price:1985, take_profit_1_price:2010 },
    })
    expect(result.candidate_entry).toEqual({
      signal_type:'buy_limit', direction:'buy', entry_method:'limit', entry_price:1995,
      stop_limit_price:null, stop_loss_price:1985, take_profit_1_price:2010,
      take_profit_2_price:null, take_profit_3_price:null,
    })
    expect(app).toContain('候选入场参考')
    expect(app).toContain('不会进入下单流程')
  })

  it('persists only model usage ids that were actually considered', () => {
    const result = normalizeDecisionFields({ experience_usage:{ source:'platform', considered_ids:[3, 4], used_ids:[4, 99], rejected_ids:[3, 99], influence:'等待确认' } })
    expect(result.experience_usage).toEqual({ source:'platform', considered_ids:[3, 4], used_ids:[4], rejected_ids:[3], influence:'等待确认' })
  })

  it('backfills only uniquely scoped refs for legacy history ids', () => {
    const result = normalizeDecisionFields({ experience_usage:{ source:'personal',
      considered_ids:[7, 8], used_ids:[7, 8, 99], rejected_ids:[7, 8],
      considered_refs:['short:7', 'long:7', 'short:8', 'invalid:9'],
      influence:'采用短期记忆' } })
    expect(result.experience_usage).toMatchObject({
      considered_refs:['short:7', 'long:7', 'short:8'],
      used_ids:[7, 8], used_refs:['short:8'], rejected_ids:[], rejected_refs:[],
    })
  })

  it('keeps explicit refs while filtering illegal historical refs', () => {
    const result = normalizeDecisionFields({ experience_usage:{ source:'platform',
      considered_ids:[7], used_ids:[7], used_refs:['long:7', 'item:99', 'bad:7'],
      considered_refs:['short:7', 'long:7'], rejected_refs:['short:7', 'nope:7'] } })
    expect(result.experience_usage.used_refs).toEqual(['long:7'])
    expect(result.experience_usage.rejected_refs).toEqual(['short:7'])
  })

  it.each([
    '参考了平台经验：当前结构不足，因此观望',
    '采用记忆9：当前结构不足，继续等待',
    '记忆#9指出当前应等待，适用该经验，故选择观望',
    '经验指出当前应等待，因此选择观望，符合该经验',
  ])('recovers historical adoption from explicit influence: %s', influence => {
    const result = normalizeDecisionFields({ experience_usage:{ source:'platform',
      considered_ids:[], used_ids:[], rejected_ids:[], considered_refs:['platform:9'], used_refs:[], rejected_refs:[], influence } })
    expect(result.experience_usage).toMatchObject({ used_ids:[9], used_refs:['platform:9'], rejected_ids:[], rejected_refs:[] })
  })

  it('corrects historical rejected usage when a strong unique claim says adopted', () => {
    const result = normalizeDecisionFields({ experience_usage:{ source:'platform',
      considered_ids:[9], used_ids:[], rejected_ids:[9], considered_refs:['platform:9'], used_refs:[],
      rejected_refs:['platform:9'], influence:'采用记忆9，因此选择观望' } })
    expect(result.experience_usage).toMatchObject({ used_ids:[9], used_refs:['platform:9'], rejected_ids:[], rejected_refs:[] })
  })

  it('keeps historical negative influence and ambiguous candidates fail-closed', () => {
    const negative = normalizeDecisionFields({ experience_usage:{ source:'platform', considered_ids:[9], used_ids:[],
      rejected_ids:[9], considered_refs:['platform:9'], used_refs:[], rejected_refs:['platform:9'], influence:'不符合该经验，未采用' } })
    expect(negative.experience_usage.used_ids).toEqual([])
    expect(negative.experience_usage.rejected_refs).toEqual(['platform:9'])
    const ambiguous = normalizeDecisionFields({ experience_usage:{ source:'personal', considered_ids:[], used_ids:[],
      rejected_ids:[], considered_refs:['short:9', 'long:9'], used_refs:[], rejected_refs:[], influence:'采用记忆9，因此观望' } })
    expect(ambiguous.experience_usage.used_ids).toEqual([])
    expect(ambiguous.experience_usage.used_refs).toEqual([])
    for (const influence of ['没有按照该经验执行', '该经验适用性不足', '该经验适用范围有限', '该经验不完全适用']) {
      const result = normalizeDecisionFields({ experience_usage:{ source:'platform', considered_ids:[9], used_ids:[],
        rejected_ids:[], considered_refs:['platform:9'], used_refs:[], rejected_refs:[], influence } })
      expect(result.experience_usage.used_ids).toEqual([])
      expect(result.experience_usage.used_refs).toEqual([])
    }
  })

  it('backfills historical id from a unique explicit used ref', () => {
    const result = normalizeDecisionFields({ experience_usage:{ source:'platform', considered_ids:[], used_ids:[],
      considered_refs:['platform:9'], used_refs:['platform:9'], rejected_refs:[] } })
    expect(result.experience_usage.used_ids).toEqual([9])
    expect(result.experience_usage.used_refs).toEqual(['platform:9'])
  })

  it('normalizes direction inclination without presenting it as confidence', () => {
    expect(normalizeDecisionFields({ bullish_score: 2, bearish_score: 1 })).toMatchObject({ bullish_score: 66.7, bearish_score: 33.3 })
    expect(normalizeDecisionFields({ bullish_score: 'bad', bearish_score: 50 })).toMatchObject({ bullish_score: null, bearish_score: null })
  })

  it('preserves current-state position and pending decision reason codes for presentation', () => {
    const result = normalizeDecisionFields({
      signal_type:'hold', entry_method:'observe',
      _position_management:{
        contract_version:'position-management-v1.3',
        pending_evaluations:[{ management_group_id:'pending-1', action:'cancel',
          cancel_reason_code:'model_judgment', reason:'当前价格已经远离挂单结构', evidence_refs:['snapshot:one'] }],
        position_evaluations:[{ management_group_id:'position-1', thesis_id:'thesis-1', action:'exit',
          exit_reason_code:'trend_reversal', reason:'当前趋势已经反转', evidence_refs:['snapshot:one'] }],
      },
    })
    expect(result.position_management).toMatchObject({
      contract_version:'position-management-v1.3',
      pending_evaluations:[expect.objectContaining({ cancel_reason_code:'model_judgment' })],
      position_evaluations:[expect.objectContaining({ exit_reason_code:'trend_reversal' })],
    })
  })

  it('never marks a hold signal executable', () => {
    expect(buildExecutionAdvice({ signal_type: 'hold' })).toMatchObject({ state: 'observe', executable: false })
  })

  it('keeps model conclusion separate while blocking an explicit ineligible signal', () => {
    const result = attachSignalPresentation({
      signal_type:'buy', entry_method:'market', position_action:'open',
      execution_validation:{ status:'ineligible', eligible:false, reason_codes:['strategy_policy_blocked'] },
    })
    expect(result.signal_type).toBe('buy')
    expect(result.execution_validation).toMatchObject({ status:'ineligible', eligible:false })
    expect(result.execution_advice).toMatchObject({ state:'unavailable', executable:false })
  })

  it('does not rewrite a current no-add model direction in presentation', () => {
    const result = attachSignalPresentation({
      signal_type:'buy_limit', entry_method:'limit', position_action:'hold_no_add', limit_price:4109,
      model_decision:{ signal_type:'buy_limit', entry_method:'limit', confidence:0.67,
        position_action:'hold_no_add', analysis:'模型仍判断偏多' },
      execution_validation:{ status:'ineligible', eligible:false, reason_codes:['position_action_hold_no_add'] },
    })
    expect(result).toMatchObject({
      signal_type:'buy_limit', entry_method:'limit', limit_price:4109,
      model_decision:{ signal_type:'buy_limit', analysis:'模型仍判断偏多' },
      execution_advice:{ state:'unavailable', executable:false },
    })
  })

  it('keeps legacy presentation free of a fabricated validation field', () => {
    const result = attachSignalPresentation({ signal_type:'buy', entry_method:'market', position_action:'open' })
    expect(result).not.toHaveProperty('execution_validation')
    expect(normalizeDecisionFields({ signal_type:'buy', entry_method:'market' })).not.toHaveProperty('execution_validation')
  })

  it('presents a legacy trade-shaped no-add signal as hold with candidate levels', () => {
    const result = attachSignalPresentation({
      id:6127, signal_type:'buy_limit', entry_method:'limit', limit_price:4109,
      stop_loss_price:4100, take_profit_1_price:4130,
      decision_json:JSON.stringify({ position_action:'hold_no_add', decision_summary:'建议挂单做多' }),
      execution_status:'skipped', execution_result:{ status:'skipped', reason:'existing_position_no_add', details:{ count:1 } },
    })
    expect(result).toMatchObject({
      signal_type:'hold', entry_method:'observe', limit_price:null, stop_loss_price:null,
      decision_summary:'当前已有同向持仓，策略建议继续持有，暂不加仓。',
      candidate_entry:{ signal_type:'buy_limit', entry_method:'limit', entry_price:4109, stop_loss_price:4100, take_profit_1_price:4130 },
      execution_advice:{ state:'observe', title:'继续持有，暂不加仓', executable:false },
    })
  })

  it('presents a successful pending delivery as submitted and never executable', () => {
    const advice = buildExecutionAdvice({
      signal_type: 'sell_limit',
      entry_method: 'limit',
      pending_ticket: '663220141',
      pending_state: 'pending',
      execution_result: { status: 'success' },
    })
    expect(advice).toMatchObject({ state: 'pending', executable: false })
  })

  it('presents a successful pending cancellation as cancelled instead of executed', () => {
    const advice = buildExecutionAdvice({
      signal_type: 'hold',
      execution_result: { status: 'success', reason: 'pending_cancelled' },
    })
    expect(advice).toMatchObject({ state: 'cancelled', title: '旧挂单已取消', executable: false })
  })

  it('presents the persisted market basis for a pending cancellation', () => {
    const advice = buildExecutionAdvice({
      signal_type:'hold',
      decision_json:JSON.stringify({ pending_action:'cancel', pending_action_reason:'M15 跌破 4102 支撑，原买入挂单的结构依据已经失效' }),
      execution_result:{ status:'success', reason:'pending_cancelled', details:{ count:1 } },
    })
    expect(advice).toMatchObject({
      state:'cancelled',
      description:'撤单依据：M15 跌破 4102 支撑，原买入挂单的结构依据已经失效',
      executable:false,
    })
  })

  it('uses persisted rejection as the primary execution state', () => {
    const advice = buildExecutionAdvice({ signal_type: 'buy', execution_result: JSON.stringify({ status: 'rejected', message: '超过风险上限' }) })
    expect(advice).toMatchObject({ state: 'rejected', title: '风控未放行', executable: false })
    expect(advice.description).toContain('风险上限')
  })

  it('does not label an MT5 broker rejection as a risk rejection', () => {
    const advice = buildExecutionAdvice({
      signal_type:'buy',
      execution_result:{ status:'rejected', classification:'broker_rejection', message:'MT5 挂单价格无效', retcode:10015 },
    })
    expect(advice).toMatchObject({ state:'rejected', title:'MT5 拒绝订单', description:'MT5 挂单价格无效' })
  })

  it('shows the concrete pre-risk portfolio alignment reason and count', () => {
    const advice = buildExecutionAdvice({
      signal_type:'buy_limit', execution_status:'skipped',
      execution_result:{ status:'skipped', reason:'opposite_position_exists', details:{ count:3 } },
    })
    expect(advice).toEqual({
      state:'skipped', title:'本次未执行',
      description:'当前账户已有反向持仓，本次不新增仓位：检测到 3 个反向持仓',
      executable:false,
    })
  })

  it('shows a Chinese risk reason instead of exposing an internal rule code', () => {
    const advice = buildExecutionAdvice({ signal_type: 'sell_stop', execution_result: JSON.stringify({ status: 'rejected', message: 'R1.7_PENDING_DEVIATION' }) })
    expect(advice).toMatchObject({ state: 'rejected', description: '挂单价格偏离当前报价过大' })
    expect(advice.description).not.toContain('R1.7')
  })

  it('shows the concrete rejected values instead of only a generic risk label', () => {
    const advice = buildExecutionAdvice({ signal_type:'buy', execution_result:{ status:'rejected', details:{ rules:[{
      code:'R1.9_AI_VOLUME_OUT_OF_RANGE', outcome:'reject', details:{ volume:0.3, minimum:0.01, maximum:0.05, step:0.01 },
    }] } } })
    expect(advice.description).toBe('订单执行上限不符合 MT5 品种手数规则：执行上限 0.3 手，允许范围 0.01～0.05 手，步进 0.01 手')
    expect(advice.description).not.toContain('R1.9')
  })

  it('does not expose a raw English broker error in user-facing advice', () => {
    const advice = buildExecutionAdvice({ signal_type:'sell_limit', execution_result:{ status:'failed', error:'Unknown broker transport failure' } })
    expect(advice.description).toBe('系统执行条件未满足，详细信息已记录')
  })

  it('restores a persisted rejection even when an old execution payload has no status field', () => {
    const advice = buildExecutionAdvice({
      signal_type:'sell', execution_status:'rejected',
      execution_result:{ reason:'invalid_stop_loss_direction', details:{ stop_loss:3990, entry_price:4000 } },
    })
    expect(advice).toMatchObject({ state:'rejected', executable:false })
    expect(advice.description).toBe('止损价格方向与订单方向不一致：止损 3990，入场参考价 4000')
  })

  it('hides unknown internal risk codes behind a safe Chinese fallback', () => {
    const advice = buildExecutionAdvice({ signal_type: 'buy', execution_result: { status: 'rejected', message: 'R9_UNKNOWN_PRIVATE_RULE' } })
    expect(advice.description).toBe('风控条件未满足')
  })

  it('keeps legacy rows without a decision payload non-executable', () => {
    const result = attachSignalPresentation({ id: 1, signal_type: 'sell', entry_method: 'market' })
    expect(result.decision.schema_version).toBe(6)
    expect(result.decision.position_action).toBe('')
    expect(result.execution_advice).toMatchObject({ state:'unavailable', executable:false })
  })

  it('presents a retained stale inference as expired rather than a generic skip', () => {
    expect(buildExecutionAdvice({
      signal_type:'buy', position_action:'open', is_stale:true,
      execution_status:'skipped',
      execution_result:{ status:'skipped', reason:'market_snapshot_expired' },
    })).toMatchObject({ state:'expired', title:'行情快照已过期', executable:false })
    expect(app).toContain('if (signal.is_stale === true) return true;')
    expect(app).toContain('execution_valid_until_utc_msc')
  })
})
