import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'

vi.mock('../../server/db.js', () => ({
  queryAll:vi.fn(), queryOne:vi.fn(), queryRun:vi.fn(), withTransaction:vi.fn(),
  beijingNow:() => '2026-07-23 12:00:00', parseBeijing:value => new Date(value),
}))

vi.mock('../../server/bridge-ws.js', () => ({
  broadcastAdminEvent:vi.fn(), sendToBrowsers:vi.fn(), getBridgeGeneration:vi.fn(() => 7),
  isBridgeAlive:vi.fn(() => true),
}))

import {
  POSITION_MANAGEMENT_CONTRACT_VERSION,
  AUTO_EXIT_CONFIRMATIONS_REQUIRED,
  buildPositionGuardReview,
  redactPositionGuardEventForUser,
  buildPositionManagementAsOf,
  buildPositionManagementOutputFormat,
  buildSignalManagementActions,
  canTransitionPositionManagement,
  claimPositionManagementLease,
  createTradeThesisTx,
  getPositionManagementSettings,
  isActivePositionManagementOutcome,
  loadActivePositionManagementContext,
  normalizeBridgeGeneration,
  resolvePositionManagementExecutionTargets,
  loadSignalManagementActions,
  positionProtectionStatus,
  persistPositionManagementEvaluations,
  resolveAutomaticExitConfirmation,
  resolvePositionManagementTaskMode,
  savePositionManagementSettings,
  supersedePositionManagementCandidates,
  targetMatchesPositionManagementTask,
  redactPositionGuardCommandForUser,
  validatePositionManagementResponse,
  redactPositionGuardTaskForUser,
} from '../../server/routes/ai/position-management.js'
import { queryAll, queryOne, queryRun, withTransaction } from '../../server/db.js'
import { getBridgeGeneration } from '../../server/bridge-ws.js'

beforeEach(() => {
  vi.clearAllMocks()
})

const asOf = {
  decision_timeframe:'M15',
  closed_bar_time_utc_ms:1784736900000,
  market_snapshot_hash:'sha256:snapshot',
}

const context = {
  contract_version:POSITION_MANAGEMENT_CONTRACT_VERSION,
  as_of:asOf,
  pending_groups:[{
    management_group_id:'pending_group_01', thesis_id:'pending_thesis_01',
    decision_context_status:'available', reference_facts_status:'available',
    allowed_evidence_refs:['bar:M15:1784736900000', 'snapshot:snapshot'],
  }],
  position_groups:[{
    management_group_id:'position_group_01', thesis_id:'thesis_01',
    decision_context_status:'available', reference_facts_status:'available',
    allowed_evidence_refs:['bar:M15:1784736900000', 'snapshot:snapshot'],
  }],
}

function response(overrides = {}) {
  return {
    contract_version:POSITION_MANAGEMENT_CONTRACT_VERSION,
    as_of:asOf,
    market_regime:'bearish',
    trade_thesis:'reversal',
    market_plan:{ signal_type:'sell', entry_method:'market' },
    pending_evaluations:[{
      management_group_id:'pending_group_01', action:'cancel', market_alignment:'misaligned', reason:'当前行情已经跌破原挂单方向的关键结构',
      cancel_reason_code:'market_misaligned',
      evidence_refs:['bar:M15:1784736900000'],
    }],
    position_evaluations:[{
      management_group_id:'position_group_01', thesis_id:'thesis_01', action:'exit', market_alignment:'misaligned',
      exit_reason_code:'market_misaligned', reversal_candidate:true,
      reason:'当前行情已经与原持仓方向和入场逻辑不一致', evidence_refs:['bar:M15:1784736900000'],
    }],
    analysis:'当前行情已经转为空头结构。',
    reasoning:'新仓、挂单与持仓分别完成独立判断。',
    ...overrides,
  }
}

describe('position management strategy-authoritative contract', () => {
  it('normalizes invalid Bridge generations to null before SQL binding', () => {
    for (const value of [NaN, Infinity, -Infinity, null, undefined, 0, -1, '']) {
      expect(normalizeBridgeGeneration(value)).toBeNull()
    }
    expect(normalizeBridgeGeneration(7)).toBe(7)
    expect(normalizeBridgeGeneration('11')).toBe(11)
  })

  it('uses the explicit last closed bar instead of the forming candle', () => {
    const result = buildPositionManagementAsOf({
      timestamp:'2026-07-24 12:30:00',
      strategy_context:{ timeframes:{ M15:{
        summary:{
          market_data_quality:{ last_bar_closed:false },
          last_closed_bar:{ time_utc_msc:1784877300000, close:4040 },
        },
        klines:[
          { time:'2026-07-24 04:15:00', close:4040 },
          { time:'2026-07-24 04:30:00', close:4020 },
        ],
      } } },
    }, 'M15')
    expect(result.closed_bar_time_utc_ms).toBe(1784877300000)
  })

  it('falls back to the penultimate candle when the latest candle is forming', () => {
    const result = buildPositionManagementAsOf({
      strategy_context:{ timeframes:{ M15:{
        summary:{ market_data_quality:{ last_bar_closed:false } },
        klines:[
          { time_utc_msc:1784877300000, close:4040 },
          { time_utc_msc:1784878200000, close:4020 },
        ],
      } } },
    }, 'M15')
    expect(result.closed_bar_time_utc_ms).toBe(1784877300000)
  })

  it('includes only real positions and explicitly active pending orders', () => {
    expect(isActivePositionManagementOutcome({ position_id:'P1', pending_ticket:'O1', effective_pending_state:'filled' })).toBe(true)
    expect(isActivePositionManagementOutcome({ position_id:null, pending_ticket:'O2', effective_pending_state:'pending' })).toBe(true)
    expect(isActivePositionManagementOutcome({ position_id:'O4', pending_ticket:'O4', effective_pending_state:'pending' })).toBe(true)
    for (const state of ['cancelled', 'expired', 'superseded', 'filled', null]) {
      expect(isActivePositionManagementOutcome({ position_id:null, pending_ticket:'O3', effective_pending_state:state })).toBe(false)
    }
  })

  it('keeps a valid exit when the independent new-order plan is invalid', () => {
    const result = validatePositionManagementResponse(response(), context, () => {
      throw new Error('market_plan_invalid')
    })
    expect(result.signal_type).toBe('hold')
    expect(result._position_management.validation.market_plan).toBe('invalid')
    expect(result._position_management.position_evaluations).toEqual([
      expect.objectContaining({ action:'exit', market_alignment:'misaligned', exit_reason_code:'market_misaligned' }),
    ])
  })

  it('does not use the original condition id as a runtime exit gate', () => {
    const value = response({
      position_evaluations:[{
        management_group_id:'position_group_01', thesis_id:'thesis_01', action:'exit',
        market_alignment:'misaligned', exit_reason_code:'market_misaligned', matched_condition_id:'invented_condition', reversal_candidate:false,
        reason:'尝试改写条件', evidence_refs:['bar:M15:1784736900000'],
      }],
    })
    const result = validatePositionManagementResponse(value, context, plan => ({ ...plan, confidence:0.8 }))
    expect(result.signal_type).toBe('sell')
    expect(result._position_management.position_evaluations).toEqual([
      expect.objectContaining({ action:'exit', market_alignment:'misaligned', exit_reason_code:'market_misaligned' }),
    ])
    expect(result._position_management.position_evaluations[0]).not.toHaveProperty('matched_condition_id')
  })

  it('throws on the initial invalid management output so the common repair pass can run', () => {
    const value = response({ position_evaluations:[] })
    expect(() => validatePositionManagementResponse(
      value,
      context,
      plan => ({ ...plan, confidence:0.8 }),
      { allowFailClosed:false },
    )).toThrow('position_management_output_invalid:position:position_group_01:evaluation_missing')
  })

  it('fails closed without repair for keep/hold evidence and coverage defects', () => {
    const invalidEvidence = response({
      market_plan:{ signal_type:'hold', entry_method:'observe' },
      pending_evaluations:[{
        ...response().pending_evaluations[0], action:'keep', market_alignment:'aligned', cancel_reason_code:null,
        reason:'原挂单继续保留', evidence_refs:['condition:not-allowed'],
      }],
      position_evaluations:[{
        ...response().position_evaluations[0], action:'hold', market_alignment:'aligned', exit_reason_code:null,
        reason:'原持仓继续持有', evidence_refs:['condition:not-allowed'],
      }],
    })
    const options = { allowFailClosed:false, allowNonExecutionFailClosed:true }
    const invalidEvidenceResult = validatePositionManagementResponse(
      invalidEvidence, context, plan => ({ ...plan, confidence:0.8 }), options,
    )
    expect(invalidEvidenceResult._position_management.pending_evaluations[0]).toMatchObject({
      action:'keep', validation_source:'server_fail_closed',
    })
    expect(invalidEvidenceResult._position_management.position_evaluations[0]).toMatchObject({
      action:'hold', validation_source:'server_fail_closed',
    })
    expect(invalidEvidenceResult._position_management.validation.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ section:'pending', code:'evidence_refs_not_allowed' }),
      expect.objectContaining({ section:'position', code:'evidence_refs_not_allowed' }),
    ]))

    const missingResult = validatePositionManagementResponse(
      response({
        market_plan:{ signal_type:'hold', entry_method:'observe' },
        pending_evaluations:[], position_evaluations:[],
      }),
      context, plan => ({ ...plan, confidence:0.8 }), options,
    )
    expect(missingResult._position_management.pending_evaluations[0]).toMatchObject({
      action:'keep', validation_source:'server_fail_closed',
    })
    expect(missingResult._position_management.position_evaluations[0]).toMatchObject({
      action:'hold', validation_source:'server_fail_closed',
    })
    expect(missingResult._position_management.validation.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ section:'pending', code:'evaluation_missing' }),
      expect.objectContaining({ section:'position', code:'evaluation_missing' }),
    ]))
  })

  it('keeps repair strict for cancel/exit intent with management errors', () => {
    const value = response({
      pending_evaluations:[{
        ...response().pending_evaluations[0], action:'cancel', evidence_refs:['condition:not-allowed'],
      }],
      position_evaluations:[{
        ...response().position_evaluations[0], action:'exit', evidence_refs:['condition:not-allowed'],
      }],
    })
    expect(() => validatePositionManagementResponse(
      value,
      context,
      plan => ({ ...plan, confidence:0.8 }),
      { allowFailClosed:false, allowNonExecutionFailClosed:true },
    )).toThrow('position_management_output_invalid:pending:pending_group_01:evidence_refs_not_allowed')
  })

  it('keeps repair strict when the independent market plan is invalid', () => {
    const value = response({
      market_plan:{ signal_type:'hold', entry_method:'observe' },
      pending_evaluations:[{
        ...response().pending_evaluations[0], action:'keep', market_alignment:'aligned', cancel_reason_code:null,
      }],
      position_evaluations:[{
        ...response().position_evaluations[0], action:'hold', market_alignment:'aligned', exit_reason_code:null,
      }],
    })
    expect(() => validatePositionManagementResponse(
      value,
      context,
      () => { throw new Error('market_plan_invalid') },
      { allowFailClosed:false, allowNonExecutionFailClosed:true },
    )).toThrow('position_management_output_invalid:market:market_plan_invalid')
  })

  it('keeps repair strict for management defects alongside an executable market plan', () => {
    const value = response({
      pending_evaluations:[{
        ...response().pending_evaluations[0], action:'keep', market_alignment:'aligned', cancel_reason_code:null,
        evidence_refs:['condition:not-allowed'],
      }],
      position_evaluations:[{
        ...response().position_evaluations[0], action:'hold', market_alignment:'aligned', exit_reason_code:null,
        evidence_refs:['condition:not-allowed'],
      }],
    })
    expect(() => validatePositionManagementResponse(
      value,
      context,
      plan => ({ ...plan, confidence:0.8 }),
      { allowFailClosed:false, allowNonExecutionFailClosed:true },
    )).toThrow('position_management_output_invalid:pending:pending_group_01:evidence_refs_not_allowed')
  })

  it('accepts a complete management output during strict initial validation', () => {
    const result = validatePositionManagementResponse(
      response(),
      context,
      plan => ({ ...plan, confidence:0.8 }),
      { allowFailClosed:false },
    )
    expect(result._position_management.validation.errors).toEqual([])
    expect(result._position_management.position_evaluations[0].action).toBe('exit')
  })

  it.each([
    ['aligned', 'hold'], ['uncertain', 'hold'], ['misaligned', 'exit'],
  ])('enforces valid position market_alignment=%s as action=%s', (marketAlignment, action) => {
    const value = response({
      pending_evaluations:[{ ...response().pending_evaluations[0], action:'keep', market_alignment:'aligned', cancel_reason_code:null }],
      position_evaluations:[{
        ...response().position_evaluations[0], action, market_alignment:marketAlignment,
        exit_reason_code:action === 'exit' ? 'market_misaligned' : null,
        reason:action === 'exit' ? '当前行情与原入场逻辑明确不一致' : '当前行情仍支持原持仓方向',
      }],
    })
    const result = validatePositionManagementResponse(value, context,
      plan => ({ ...plan, confidence:0.8 }))
    expect(result._position_management.position_evaluations[0]).toMatchObject({ action, market_alignment:marketAlignment })
  })

  it.each([
    ['aligned', 'cancel'], ['uncertain', 'keep'], ['misaligned', 'cancel'],
  ])('enforces valid pending market_alignment=%s as action=%s', (marketAlignment, action) => {
    const value = response({ pending_evaluations:[{
      ...response().pending_evaluations[0], action, market_alignment:marketAlignment,
      cancel_reason_code:action === 'cancel' ? 'market_misaligned' : null,
    }] })
    const result = validatePositionManagementResponse(value, context,
      plan => ({ ...plan, confidence:0.8 }))
    expect(result._position_management.pending_evaluations[0]).toMatchObject({ action, market_alignment:marketAlignment })
    expect(result._position_management.validation.errors).toEqual([])
  })

  it.each([
    ['pending', 'misaligned', 'keep', 'pending_misaligned_action_invalid'],
    ['pending', 'uncertain', 'cancel', 'pending_uncertain_action_invalid'],
    ['position', 'misaligned', 'hold', 'position_misaligned_action_invalid'],
    ['position', 'uncertain', 'exit', 'position_uncertain_action_invalid'],
  ])('fails closed for %s alignment/action conflict: %s + %s',
    (section, marketAlignment, action, code) => {
      const value = response({
        market_plan:{ signal_type:'sell', entry_method:'market' },
        pending_evaluations:section === 'pending' ? [{
          ...response().pending_evaluations[0], action, market_alignment:marketAlignment,
          cancel_reason_code:action === 'cancel' ? 'market_misaligned' : null,
        }] : [],
        position_evaluations:section === 'position' ? [{
          ...response().position_evaluations[0], action, market_alignment:marketAlignment,
          exit_reason_code:action === 'exit' ? 'market_misaligned' : null,
        }] : [],
      })
      const result = validatePositionManagementResponse(value, context, plan => ({ ...plan, confidence:0.8 }))
      expect(result.signal_type).toBe('hold')
      expect(result.entry_method).toBe('observe')
      expect(result._position_management.validation.fail_closed).toBe(true)
      expect(result._position_management.validation.errors).toContainEqual(expect.objectContaining({ code }))
      const evaluation = section === 'pending'
        ? result._position_management.pending_evaluations[0]
        : result._position_management.position_evaluations[0]
      expect(evaluation.validation_source).toBe('server_fail_closed')
    })

  it('fails closed for signal 24414 shape even when both opposite positions are held', () => {
    const localContext = {
      ...context,
      position_groups:[
        { ...context.position_groups[0], management_group_id:'group-46', thesis_id:'thesis-46', direction:'buy' },
        { ...context.position_groups[0], management_group_id:'group-47', thesis_id:'thesis-47', direction:'buy' },
      ],
    }
    const value = response({
      market_plan:{ ...response().market_plan, signal_type:'sell', entry_method:'market' },
      pending_evaluations:[],
      position_evaluations:localContext.position_groups.map(group => ({
        management_group_id:group.management_group_id, thesis_id:group.thesis_id,
        action:'hold', market_alignment:'aligned', exit_reason_code:null,
        reversal_candidate:true, reason:'结构尚未满足退出确认', evidence_refs:[],
      })),
    })
    const result = validatePositionManagementResponse(value, localContext,
      plan => ({ ...plan, confidence:0.7 }))
    expect(result).toMatchObject({ signal_type:'hold', entry_method:'observe', position_action:'observe' })
    expect(result._position_management.position_evaluations).toHaveLength(2)
    expect(result._position_management.validation).toMatchObject({ fail_closed:true })
    expect(result._position_management.validation.errors).toContainEqual(expect.objectContaining({
      section:'market', code:'strategy_reversal_waiting_for_exit',
    }))
  })

  it.each(['expired', 'thesis_invalidated', 'risk_reduction', 'model_judgment'])
    ('accepts strategy-defined pending reason code %s', cancelReasonCode => {
      const result = validatePositionManagementResponse(response({ pending_evaluations:[{
        ...response().pending_evaluations[0], cancel_reason_code:cancelReasonCode,
      }] }), context, plan => ({ ...plan, confidence:0.8 }))
      expect(result._position_management.pending_evaluations[0]).toMatchObject({ action:'cancel', cancel_reason_code:cancelReasonCode })
      expect(result._position_management.validation.errors).toEqual([])
    })

  it.each(['current_thesis_invalidated', 'trend_reversal', 'risk_reduction', 'model_judgment'])
    ('accepts strategy-defined position reason code %s', exitReasonCode => {
      const result = validatePositionManagementResponse(response({ position_evaluations:[{
        ...response().position_evaluations[0], exit_reason_code:exitReasonCode,
      }] }), context, plan => ({ ...plan, confidence:0.8 }))
      expect(result._position_management.position_evaluations[0]).toMatchObject({ action:'exit', exit_reason_code:exitReasonCode })
      expect(result._position_management.validation.errors).toEqual([])
    })

  it('does not reject a strategy explanation based on service trading doctrine', () => {
    const result = validatePositionManagementResponse(response({
      position_evaluations:[{
        ...response().position_evaluations[0], market_alignment:'misaligned',
        exit_reason_code:'market_misaligned', reason:'跌破保本止损，盈利保护触发',
      }],
    }), context, plan => ({ ...plan, confidence:0.8 }))
    expect(result._position_management.position_evaluations[0]).toMatchObject({ action:'exit', market_alignment:'misaligned' })
    expect(result._position_management.validation.errors).toEqual([])
  })

  it('fails closed and preserves groups when decision context is unavailable', () => {
    const unavailable = { ...context, position_groups:[{
      ...context.position_groups[0], decision_context_status:'unavailable',
    }] }
    const result = validatePositionManagementResponse(response(), unavailable,
      plan => ({ ...plan, confidence:0.8 }))
    expect(result._position_management.position_evaluations[0]).toMatchObject({
      action:'hold', market_alignment:'uncertain', validation_source:'server_fail_closed',
    })
    expect(result._position_management.validation.errors).toContainEqual(
      expect.objectContaining({ code:'position_decision_context_unavailable' }),
    )
  })

  it('fails closed for a platform group whose observer fact is unavailable', () => {
    const orphanContext = {
      ...context,
      pending_groups:[{
        ...context.pending_groups[0],
        reference_facts_status:'missing',
      }],
      position_groups:[],
    }
    const result = validatePositionManagementResponse(response({
      pending_evaluations:[{
        ...response().pending_evaluations[0],
        action:'cancel', market_alignment:'misaligned', cancel_reason_code:'thesis_invalidated',
        evidence_refs:['bar:M15:1784736900000'],
      }],
      position_evaluations:[],
    }), orphanContext, plan => ({ ...plan, confidence:0.8 }))
    expect(result._position_management.pending_evaluations[0]).toMatchObject({
      action:'keep', validation_source:'server_fail_closed',
    })
    expect(result._position_management.validation.errors).toContainEqual(
      expect.objectContaining({ code:'pending_reference_facts_unavailable' }),
    )
  })

  it('fails closed for a private strategy when its own terminal fact is unavailable', () => {
    const privateContext = {
      ...context,
      pending_groups:[],
      position_groups:[{
        ...context.position_groups[0], strategy_scope:'private', reference_facts_status:'unavailable',
      }],
    }
    const result = validatePositionManagementResponse(response({ pending_evaluations:[] }), privateContext,
      plan => ({ ...plan, confidence:0.8 }))
    expect(result._position_management.position_evaluations[0]).toMatchObject({
      action:'hold', validation_source:'server_fail_closed',
    })
    expect(result._position_management.validation.errors).toContainEqual(
      expect.objectContaining({ code:'position_reference_facts_unavailable' }),
    )
  })

  it('fails closed when the frozen decision context itself is incomplete', () => {
    const incompleteContext = {
      ...context,
      pending_groups:[{
        ...context.pending_groups[0], decision_context_status:'unavailable',
      }],
      position_groups:[],
    }
    const result = validatePositionManagementResponse(response({ position_evaluations:[] }), incompleteContext,
      plan => ({ ...plan, confidence:0.8 }))
    expect(result._position_management.pending_evaluations[0]).toMatchObject({
      action:'keep', validation_source:'server_fail_closed',
    })
    expect(result._position_management.validation.errors).toContainEqual(
      expect.objectContaining({ code:'pending_decision_context_unavailable' }),
    )
  })

  it('rejects a model evaluation that replaces the frozen origin signal', () => {
    const result = validatePositionManagementResponse(response({
      pending_evaluations:[{ ...response().pending_evaluations[0], origin_signal_id:999 }],
      position_evaluations:[],
    }), context, plan => ({ ...plan, confidence:0.8 }))
    expect(result._position_management.pending_evaluations[0]).toMatchObject({
      action:'keep', validation_source:'server_fail_closed',
    })
    expect(result._position_management.validation.errors).toContainEqual(
      expect.objectContaining({ code:'pending_origin_signal_invalid' }),
    )
  })

  it('rejects a pending evaluation that replaces the frozen thesis', () => {
    const result = validatePositionManagementResponse(response({
      pending_evaluations:[{ ...response().pending_evaluations[0], thesis_id:'other-thesis' }],
      position_evaluations:[],
    }), context, plan => ({ ...plan, confidence:0.8 }))
    expect(result._position_management.pending_evaluations[0]).toMatchObject({
      action:'keep', thesis_id:context.pending_groups[0].thesis_id,
      validation_source:'server_fail_closed',
    })
    expect(result._position_management.validation.errors).toContainEqual(
      expect.objectContaining({ code:'pending_thesis_invalid' }),
    )
  })

  it('expires the whole response when snapshot identity changes', () => {
    expect(() => validatePositionManagementResponse(response({
      as_of:{ ...asOf, market_snapshot_hash:'sha256:other' },
    }), context, value => value)).toThrow('position_management_snapshot_mismatch')
  })

  it('does not expose direct replace or reverse actions in the model schema', () => {
    const schema = buildPositionManagementOutputFormat(JSON.stringify({
      signal_type:'buy | sell | hold', pending_action:'cancel', position_action:'open',
      analysis:'中文', reasoning:'中文',
    }), context)
    const parsed = JSON.parse(schema)
    expect(parsed.market_plan.pending_action).toBeUndefined()
    expect(parsed.market_plan.position_action).toBeUndefined()
    expect(schema).toContain('exit_reason_code')
    expect(schema).toContain('market_alignment')
    expect(schema).toContain('lowercase_snake_case')
    expect(schema).toContain('实际止损和实际止盈')
    expect(schema).toContain('不得编造、替换或写反价格大小关系')
    expect(schema).not.toContain('matched_condition_id')
    expect(schema).not.toContain('cancel_replace')
    expect(schema).not.toContain('"reverse"')
  })
})

describe('consecutive automatic-inference exit confirmation', () => {
  it('atomically supersedes only unissued candidates for a valid hold/keep decision', async () => {
    const candidates = [
      { id:21, status:'CANDIDATE', state_version:1, fencing_token:2, evidence_validation_json:'{}' },
      { id:22, status:'EVIDENCE_CONFIRMED', state_version:3, fencing_token:4, evidence_validation_json:'{}' },
    ]
    const runner = vi.fn(async (sql, params = []) => {
      if (String(sql).includes('SELECT * FROM ai_position_management_tasks')) return [candidates, []]
      if (String(sql).includes('UPDATE ai_position_management_tasks')) return [{ affectedRows:1 }, []]
      if (String(sql).includes('INSERT INTO ai_position_management_events')) return [{ affectedRows:1 }, []]
      throw new Error(`unexpected transaction SQL: ${sql}`)
    })
    withTransaction.mockImplementationOnce(async callback => callback(runner))
    const result = await supersedePositionManagementCandidates({
      signalId:301,
      context:{ as_of:{ closed_bar_time_utc_ms:1784736900000, market_snapshot_hash:'sha256:new-snapshot' } },
      target:{ user_id:7, trading_account_id:3, outcome_id:9, strategy_id:2, strategy_version:4,
        management_group_id:'position_group_01', thesis_id:'thesis_01' },
      section:'position', action:'hold',
      evaluation:{ market_alignment:'aligned', reason:'当前行情仍支持原持仓方向' },
    })
    expect(result).toEqual([
      expect.objectContaining({ id:21, status:'HELD', state_version:2, fencing_token:3 }),
      expect.objectContaining({ id:22, status:'HELD', state_version:4, fencing_token:5 }),
    ])
    expect(runner.mock.calls[0][0]).toContain('FOR UPDATE')
    expect(runner.mock.calls[0][0]).toContain('status IN (?,?)')
    expect(runner.mock.calls[0][1].slice(-2)).toEqual(['CANDIDATE', 'EVIDENCE_CONFIRMED'])
    expect(runner.mock.calls.filter(call => String(call[0]).includes('UPDATE ai_position_management_tasks')))
      .toHaveLength(2)
    expect(runner.mock.calls.filter(call => String(call[0]).includes('INSERT INTO ai_position_management_events')))
      .toHaveLength(2)
    expect(result.every(task => JSON.parse(task.evidence_validation_json).status === 'reset')).toBe(true)
  })

  it('persists an invalid hold evaluation and interrupts a prior exit candidate', async () => {
    queryOne.mockImplementation(async sql => {
      if (String(sql).includes('global_position_management_control')) {
        return { maximum_mode:'auto_exit', ai_pending_cancel_enabled:1 }
      }
      if (String(sql).includes('ai_position_management_evaluations')) {
        return { id:40, decision_signal_id:200, action:'exit', validation_status:'valid',
          market_snapshot_hash:'snapshot-old', closed_bar_time_utc_ms:1784736000000,
          model_evaluation_json:JSON.stringify({ contract_version:POSITION_MANAGEMENT_CONTRACT_VERSION }) }
      }
      return null
    })
    queryAll.mockResolvedValueOnce([])
    queryRun.mockResolvedValueOnce({ insertId:41, changes:1 }).mockResolvedValueOnce({ changes:1 })
    const task = { id:51, status:'CANDIDATE', state_version:1, fencing_token:1,
      evidence_validation_json:'{}', task_type:'position_exit' }
    const runner = vi.fn(async sql => {
      if (String(sql).includes('SELECT * FROM ai_position_management_tasks')) return [[task], []]
      if (String(sql).includes('UPDATE ai_position_management_tasks')) return [{ affectedRows:1 }, []]
      if (String(sql).includes('INSERT INTO ai_position_management_events')) return [{ affectedRows:1 }, []]
      throw new Error(`unexpected transaction SQL: ${sql}`)
    })
    withTransaction.mockImplementationOnce(async callback => callback(runner))
    const target = { user_id:7, trading_account_id:3, outcome_id:9, position_id:'P-9',
      original_symbol:'XAUUSD', standard_symbol:'XAUUSD', management_group_id:'position_group_01',
      thesis_id:'thesis_01', ownership_history_id:5, strategy_id:2, strategy_version:4,
      origin_signal_id:100 }
    const localContext = { ...context,
      as_of:{ ...context.as_of, market_snapshot_hash:'sha256:snapshot-invalid' },
      _targets:new Map([['position_group_01', [target]]]) }
    const invalidHold = {
      ...response().position_evaluations[0], action:'hold', market_alignment:'uncertain',
      exit_reason_code:null, validation_source:'server_fail_closed',
    }
    const result = await persistPositionManagementEvaluations({
      signalId:201, context:localContext, inferenceSource:'automatic_scheduler',
      management:{ position_evaluations:[invalidHold], pending_evaluations:[] },
    })
    expect(result).toEqual([expect.objectContaining({ id:51, status:'HELD', confirmation_count:0 })])
    const evidence = JSON.parse(result[0].evidence_validation_json)
    expect(evidence).toMatchObject({ status:'reset', source:'invalid_inference_output',
      reset_evaluation_id:41, reset_decision_signal_id:201 })
    expect(queryRun.mock.calls.some(call => String(call[0]).includes('ai_position_management_evaluations'))).toBe(true)
  })

  it('requires two distinct current-contract inferences and snapshots', () => {
    expect(AUTO_EXIT_CONFIRMATIONS_REQUIRED).toBe(2)
    expect(POSITION_MANAGEMENT_CONTRACT_VERSION).toBe('position-management-v1.10')
    expect(resolveAutomaticExitConfirmation({ action:'exit', market_alignment:'misaligned', decision_signal_id:101,
      market_snapshot_hash:'sha256:snapshot-a', contract_version:POSITION_MANAGEMENT_CONTRACT_VERSION }, null))
      .toMatchObject({ validation_status:'valid', confirmation_count:1 })
    expect(resolveAutomaticExitConfirmation({ action:'exit', market_alignment:'misaligned', decision_signal_id:102,
      market_snapshot_hash:'sha256:snapshot-b', previous_closed_bar_time_utc_ms:1784736900000,
      contract_version:POSITION_MANAGEMENT_CONTRACT_VERSION }, {
      action:'exit', market_alignment:'misaligned', validation_status:'valid', decision_signal_id:101,
      market_snapshot_hash:'sha256:snapshot-a', contract_version:POSITION_MANAGEMENT_CONTRACT_VERSION,
      closed_bar_time_utc_ms:1784736900000,
    })).toMatchObject({ validation_status:'valid', confirmation_count:2 })
  })

  it('accepts two distinct scheduler snapshots inside the same primary closed bar', () => {
    const h1Close = Date.parse('2026-08-31T13:00:00.000Z')
    expect(resolveAutomaticExitConfirmation({
      action:'exit', market_alignment:'misaligned', decision_signal_id:302, task_id:82,
      market_snapshot_hash:'sha256:same-h1-fresh-b', closed_bar_time_utc_ms:h1Close,
      previous_closed_bar_time_utc_ms:Date.parse('2026-08-31T12:00:00.000Z'),
      contract_version:POSITION_MANAGEMENT_CONTRACT_VERSION,
    }, {
      action:'exit', market_alignment:'misaligned', validation_status:'valid',
      decision_signal_id:301, task_id:81, market_snapshot_hash:'sha256:same-h1-fresh-a',
      closed_bar_time_utc_ms:h1Close, contract_version:POSITION_MANAGEMENT_CONTRACT_VERSION,
    })).toMatchObject({ validation_status:'valid', confirmation_count:2, reset_reason:null })
  })

  it('does not treat a duplicate snapshot inside the same primary closed bar as confirmation', () => {
    const h1Close = Date.parse('2026-08-31T13:00:00.000Z')
    expect(resolveAutomaticExitConfirmation({
      action:'exit', market_alignment:'misaligned', decision_signal_id:402, task_id:92,
      market_snapshot_hash:'sha256:duplicate', closed_bar_time_utc_ms:h1Close,
      previous_closed_bar_time_utc_ms:Date.parse('2026-08-31T12:00:00.000Z'),
      contract_version:POSITION_MANAGEMENT_CONTRACT_VERSION,
    }, {
      action:'exit', market_alignment:'misaligned', validation_status:'valid',
      decision_signal_id:401, task_id:91, market_snapshot_hash:'sha256:duplicate',
      closed_bar_time_utc_ms:h1Close, contract_version:POSITION_MANAGEMENT_CONTRACT_VERSION,
    })).toMatchObject({ validation_status:'valid', confirmation_count:1,
      reset_reason:'automatic_confirmation_identity_not_distinct' })
  })

  it('does not combine exit confirmations across a closed-bar gap', () => {
    expect(resolveAutomaticExitConfirmation({ action:'exit', market_alignment:'misaligned', decision_signal_id:102,
      market_snapshot_hash:'sha256:snapshot-b', previous_closed_bar_time_utc_ms:1784736900000,
      contract_version:POSITION_MANAGEMENT_CONTRACT_VERSION }, {
      action:'exit', market_alignment:'misaligned', validation_status:'valid', decision_signal_id:101,
      market_snapshot_hash:'sha256:snapshot-a', closed_bar_time_utc_ms:1784736000000,
      contract_version:POSITION_MANAGEMENT_CONTRACT_VERSION,
    })).toMatchObject({ validation_status:'valid', confirmation_count:1,
      reset_reason:'automatic_confirmation_bar_gap' })
  })

  it('accepts the actual previous market bar across a weekend without fixed-duration arithmetic', () => {
    const fridayClose = Date.parse('2026-08-14T20:00:00.000Z')
    expect(resolveAutomaticExitConfirmation({
      action:'exit', market_alignment:'misaligned', decision_signal_id:202,
      market_snapshot_hash:'sha256:monday', previous_closed_bar_time_utc_ms:fridayClose,
      contract_version:POSITION_MANAGEMENT_CONTRACT_VERSION,
    }, {
      action:'exit', market_alignment:'misaligned', validation_status:'valid', decision_signal_id:201,
      market_snapshot_hash:'sha256:friday', closed_bar_time_utc_ms:fridayClose,
      contract_version:POSITION_MANAGEMENT_CONTRACT_VERSION,
    })).toMatchObject({ validation_status:'valid', confirmation_count:2, reset_reason:null })
  })

  it('does not increment when the task or snapshot is reused', () => {
    const current = { action:'exit', market_alignment:'misaligned', decision_signal_id:102, task_id:7,
      market_snapshot_hash:'sha256:snapshot-a', contract_version:POSITION_MANAGEMENT_CONTRACT_VERSION }
    const previous = { action:'exit', market_alignment:'misaligned', validation_status:'valid', decision_signal_id:101, task_id:7,
      market_snapshot_hash:'sha256:snapshot-a', contract_version:POSITION_MANAGEMENT_CONTRACT_VERSION }
    expect(resolveAutomaticExitConfirmation(current, previous)).toMatchObject({
      validation_status:'valid', confirmation_count:1,
    })
  })

  it('does not combine a legacy or unknown previous contract with the current contract', () => {
    expect(resolveAutomaticExitConfirmation({ action:'exit', market_alignment:'misaligned', decision_signal_id:102,
      market_snapshot_hash:'sha256:snapshot-b', contract_version:POSITION_MANAGEMENT_CONTRACT_VERSION }, {
      action:'exit', market_alignment:'misaligned', validation_status:'valid', decision_signal_id:101,
      market_snapshot_hash:'sha256:snapshot-a', contract_version:'position-management-v1.6',
    })).toMatchObject({ validation_status:'valid', confirmation_count:1, reset_reason:'contract_not_compatible' })
    expect(resolveAutomaticExitConfirmation({ action:'exit', market_alignment:'misaligned', decision_signal_id:103,
      market_snapshot_hash:'sha256:snapshot-c', contract_version:POSITION_MANAGEMENT_CONTRACT_VERSION }, {
      action:'exit', validation_status:'valid', decision_signal_id:102,
      market_snapshot_hash:'sha256:snapshot-b',
    })).toMatchObject({ validation_status:'valid', confirmation_count:1, reset_reason:'contract_not_compatible' })
  })

  it('does not pair a prior-contract candidate with a current-contract confirmation', () => {
    expect(resolveAutomaticExitConfirmation({ action:'exit', market_alignment:'misaligned', decision_signal_id:104,
      market_snapshot_hash:'sha256:snapshot-d', contract_version:POSITION_MANAGEMENT_CONTRACT_VERSION }, {
      action:'exit', market_alignment:'misaligned', validation_status:'valid', decision_signal_id:103,
      market_snapshot_hash:'sha256:snapshot-c', contract_version:'position-management-v1.3',
    })).toMatchObject({ validation_status:'valid', confirmation_count:1, reset_reason:'contract_not_compatible' })
  })

  it('resets confirmation on hold or invalid model output', () => {
    const previous = { action:'exit', validation_status:'valid' }
    expect(resolveAutomaticExitConfirmation({ action:'hold' }, previous))
      .toMatchObject({ confirmation_count:0, reset_reason:'automatic_inference_hold' })
    expect(resolveAutomaticExitConfirmation({ action:'hold', validation_source:'server_fail_closed' }, previous))
      .toMatchObject({ validation_status:'invalid', confirmation_count:0, reset_reason:'invalid_inference_output' })
  })

  it('records the first exit as 1/2 without creating an executable task', async () => {
    queryOne.mockResolvedValueOnce({ maximum_mode:'auto_exit', ai_pending_cancel_enabled:1 })
    queryAll.mockResolvedValueOnce([])
    queryRun.mockResolvedValueOnce({ insertId:11, changes:1 })
      .mockResolvedValueOnce({ changes:1 })
      .mockResolvedValueOnce({ insertId:21, changes:1 })
      .mockResolvedValueOnce({ changes:1 })
    const target = {
      user_id:7, trading_account_id:3, outcome_id:9, position_id:'P-9', original_symbol:'XAUUSD.s',
      standard_symbol:'XAUUSD', management_group_id:'position_group_01', thesis_id:'thesis_01',
      ownership_history_id:5, broker_server_key:'Broker-Demo', login_account:'10001',
      strategy_id:2, strategy_version:4, origin_signal_id:100,
    }
    const localContext = { ...context,
      as_of:{ ...context.as_of, market_snapshot_hash:'sha256:snapshot-a' },
      _targets:new Map([['position_group_01', [target]]]) }
    const result = await persistPositionManagementEvaluations({ signalId:101, context:localContext,
      inferenceSource:'automatic_scheduler', management:{
      position_evaluations:[response().position_evaluations[0]], pending_evaluations:[],
    } })
    expect(result).toEqual([expect.objectContaining({ status:'CANDIDATE', confirmation_count:1, required_confirmations:2 })])
    expect(queryRun.mock.calls.some(call => String(call[0]).includes('ai_position_management_evaluations'))).toBe(true)
    expect(queryRun.mock.calls.some(call => String(call[0]).includes("'EVIDENCE_CONFIRMED'"))).toBe(false)
  })

  it('anchors a platform exit confirmation to the observer source even when that user is display-only', async () => {
    queryOne.mockResolvedValueOnce({ maximum_mode:'auto_exit', ai_pending_cancel_enabled:1 })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
    queryAll.mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ user_id:7, execution_mode:'display' }])
    queryRun.mockResolvedValueOnce({ insertId:111, changes:1 })
      .mockResolvedValueOnce({ changes:1 })
      .mockResolvedValueOnce({ insertId:121, changes:1 })
      .mockResolvedValueOnce({ changes:1 })
    const source = {
      user_id:7, trading_account_id:3, outcome_id:109, position_id:'SOURCE-109',
      original_symbol:'XAUUSD.s', standard_symbol:'XAUUSD', direction:'buy', system_magic:234000,
      management_group_id:'position_group_01', thesis_id:'thesis_01', ownership_history_id:5,
      broker_server_key:'Broker-Demo', login_account:'10001', strategy_id:2,
      strategy_version:4, strategy_scope:'platform', origin_signal_id:100,
    }
    const localContext = { ...context,
      position_groups:[{ ...context.position_groups[0], original_signal_id:100,
        strategy_id:2, strategy_version:4, strategy_scope:'platform', standard_symbol:'XAUUSD' }],
      _executionLineage:{ strategy_scope:'platform', source_user_ids:[7], source_outcome_ids:[109] },
      _targets:new Map([['position_group_01', [source]]]),
    }
    const result = await persistPositionManagementEvaluations({ signalId:201, context:localContext,
      inferenceSource:'automatic_scheduler', management:{
        position_evaluations:[response().position_evaluations[0]], pending_evaluations:[],
      } })
    expect(result).toEqual([expect.objectContaining({ outcome_id:109, status:'CANDIDATE',
      confirmation_count:1, required_confirmations:2 })])
    expect(queryRun.mock.calls.some(call => String(call[0]).includes('ai_position_management_evaluations'))).toBe(true)
  })

  it('records a platform display-only recommendation without faking a confirmation increment', async () => {
    queryOne.mockResolvedValueOnce({ maximum_mode:'display', ai_pending_cancel_enabled:1 })
    queryAll.mockResolvedValueOnce([]).mockResolvedValueOnce([])
    queryRun.mockResolvedValueOnce({ insertId:211, changes:1 })
      .mockResolvedValueOnce({ changes:1 })
    const source = {
      user_id:7, trading_account_id:3, outcome_id:209, position_id:'SOURCE-209',
      original_symbol:'XAUUSD.s', standard_symbol:'XAUUSD', direction:'buy', system_magic:234000,
      management_group_id:'position_group_01', thesis_id:'thesis_01', ownership_history_id:5,
      broker_server_key:'Broker-Demo', login_account:'10001', strategy_id:2,
      strategy_version:4, strategy_scope:'platform', origin_signal_id:100,
    }
    const localContext = { ...context,
      position_groups:[{ ...context.position_groups[0], original_signal_id:100,
        strategy_id:2, strategy_version:4, strategy_scope:'platform', standard_symbol:'XAUUSD' }],
      _executionLineage:{ strategy_scope:'platform', source_user_ids:[7], source_outcome_ids:[209] },
      _targets:new Map([['position_group_01', [source]]]),
    }
    expect(await persistPositionManagementEvaluations({ signalId:202, context:localContext,
      inferenceSource:'automatic_scheduler', management:{
        position_evaluations:[response().position_evaluations[0]], pending_evaluations:[],
      } })).toEqual([])
    expect(queryRun.mock.calls.find(call => String(call[0]).startsWith('UPDATE ai_position_management_evaluations'))?.[1])
      .toEqual([0, 211])
    expect(queryRun.mock.calls.some(call => String(call[0]).includes('INSERT IGNORE INTO ai_position_management_tasks'))).toBe(false)
  })

  it('keeps automatic exit confirmation and task lookup isolated by outcome', async () => {
    const previousObserverExit = {
      id:401, decision_signal_id:900, action:'exit', validation_status:'valid',
      market_snapshot_hash:'snapshot-a', closed_bar_time_utc_ms:1784736000000,
      model_evaluation_json:JSON.stringify({ contract_version:POSITION_MANAGEMENT_CONTRACT_VERSION }),
    }
    const observerCandidate = {
      id:501, state_version:1, status:'CANDIDATE', outcome_id:1001,
      management_group_id:'position_group_01', model_evaluation_json:JSON.stringify({
        contract_version:POSITION_MANAGEMENT_CONTRACT_VERSION,
      }),
    }
    queryOne.mockImplementation(async (sql, params = []) => {
      if (String(sql).includes('global_position_management_control')) {
        return { maximum_mode:'auto_exit', ai_pending_cancel_enabled:1 }
      }
      if (String(sql).includes('ai_position_management_evaluations')) {
        return Number(params[0]) === 1001 ? previousObserverExit : null
      }
      if (String(sql).includes('ai_position_management_tasks')) {
        return Number(params[0]) === 1001 ? observerCandidate : null
      }
      return null
    })
    queryAll.mockResolvedValueOnce([])
    let nextInsertId = 1000
    queryRun.mockImplementation(async sql => String(sql).includes('INSERT IGNORE')
      ? { insertId:nextInsertId++, changes:1 } : { changes:1 })
    const target = (outcomeId, userId) => ({
      user_id:userId, trading_account_id:userId, outcome_id:outcomeId, position_id:`P-${outcomeId}`,
      pending_ticket:null, original_symbol:'XAUUSD.s', standard_symbol:'XAUUSD',
      management_group_id:'position_group_01', thesis_id:'thesis_01', ownership_history_id:userId,
      broker_server_key:'Broker-Demo', login_account:`1000${userId}`, strategy_id:2,
      strategy_version:4, origin_signal_id:100,
    })
    const localContext = { ...context,
      as_of:{ ...context.as_of, market_snapshot_hash:'sha256:snapshot-b' },
      _diagnostics:{ previous_closed_bar_time_utc_ms:1784736000000 },
      _targets:new Map([['position_group_01', [target(1001, 7), target(1002, 28)] ]]) }
    const result = await persistPositionManagementEvaluations({ signalId:110, context:localContext,
      inferenceSource:'automatic_scheduler', management:{
        position_evaluations:[response().position_evaluations[0]], pending_evaluations:[],
      } })

    expect(result).toEqual(expect.arrayContaining([
      expect.objectContaining({ outcome_id:1001, status:'EVIDENCE_CONFIRMED', confirmation_count:2 }),
      expect.objectContaining({ outcome_id:1002, status:'CANDIDATE', confirmation_count:1 }),
    ]))
    const previousLookups = queryOne.mock.calls.filter(call => String(call[0]).includes('ai_position_management_evaluations'))
    expect(previousLookups.map(call => Number(call[1][0]))).toEqual([1001, 1002])
    const taskInserts = queryRun.mock.calls.filter(call => String(call[0]).includes('INSERT IGNORE INTO ai_position_management_tasks'))
    // The observer's existing candidate is updated; only the subscriber gets
    // a new candidate, proving the two outcomes did not share confirmation state.
    expect(taskInserts).toHaveLength(1)
  })

  it('promotes the same task after a second consecutive valid exit', async () => {
    queryOne.mockResolvedValueOnce({ maximum_mode:'auto_exit', ai_pending_cancel_enabled:1 })
      .mockResolvedValueOnce({ id:11, decision_signal_id:101, action:'exit', validation_status:'valid',
        market_snapshot_hash:'snapshot-a', closed_bar_time_utc_ms:1784736000000,
        model_evaluation_json:JSON.stringify({ contract_version:POSITION_MANAGEMENT_CONTRACT_VERSION, market_alignment:'misaligned' }) })
      .mockResolvedValueOnce({ id:21, state_version:1, status:'CANDIDATE', user_id:7,
        execution_mode:'auto_exit', task_type:'position_exit', management_group_id:'position_group_01', thesis_id:'thesis_01',
        model_evaluation_json:JSON.stringify({ contract_version:POSITION_MANAGEMENT_CONTRACT_VERSION }) })
    queryAll.mockResolvedValueOnce([])
    queryRun.mockResolvedValueOnce({ insertId:12, changes:1 })
      .mockResolvedValueOnce({ changes:1 })
      .mockResolvedValueOnce({ changes:1 })
      .mockResolvedValueOnce({ changes:1 })
    const target = {
      user_id:7, trading_account_id:3, outcome_id:9, position_id:'P-9', original_symbol:'XAUUSD.s',
      standard_symbol:'XAUUSD', management_group_id:'position_group_01', thesis_id:'thesis_01',
      ownership_history_id:5, broker_server_key:'Broker-Demo', login_account:'10001',
      strategy_id:2, strategy_version:4, origin_signal_id:100,
    }
    const localContext = { ...context,
      as_of:{ ...context.as_of, market_snapshot_hash:'sha256:snapshot-b' },
      _diagnostics:{ previous_closed_bar_time_utc_ms:1784736000000 },
      _targets:new Map([['position_group_01', [target]]]) }
    const result = await persistPositionManagementEvaluations({ signalId:102, context:localContext,
      inferenceSource:'automatic_scheduler', management:{
      position_evaluations:[response().position_evaluations[0]], pending_evaluations:[],
    } })
    expect(result).toEqual([expect.objectContaining({ status:'EVIDENCE_CONFIRMED', confirmation_count:2 })])
    expect(queryRun.mock.calls.some(call => String(call[0]).includes("status = 'EVIDENCE_CONFIRMED'"))).toBe(true)
  })

  it('retires and rebuilds a candidate after a closed-bar gap', async () => {
    queryOne.mockResolvedValueOnce({ maximum_mode:'auto_exit', ai_pending_cancel_enabled:1 })
      .mockResolvedValueOnce({ id:11, decision_signal_id:101, action:'exit', validation_status:'valid',
        market_snapshot_hash:'snapshot-a', closed_bar_time_utc_ms:1784736000000,
        model_evaluation_json:JSON.stringify({ contract_version:POSITION_MANAGEMENT_CONTRACT_VERSION }) })
      .mockResolvedValueOnce({ id:21, state_version:1, status:'CANDIDATE', user_id:7,
        execution_mode:'auto_exit', task_type:'position_exit', management_group_id:'position_group_01', thesis_id:'thesis_01',
        model_evaluation_json:JSON.stringify({ contract_version:POSITION_MANAGEMENT_CONTRACT_VERSION }) })
      .mockResolvedValueOnce(null)
    queryAll.mockResolvedValueOnce([])
    queryRun.mockResolvedValueOnce({ insertId:31, changes:1 })
      .mockResolvedValueOnce({ changes:1 })
      .mockResolvedValueOnce({ changes:1 })
      .mockResolvedValueOnce({ changes:1 })
      .mockResolvedValueOnce({ insertId:41, changes:1 })
      .mockResolvedValueOnce({ changes:1 })
    const target = {
      user_id:7, trading_account_id:3, outcome_id:9, position_id:'P-9', original_symbol:'XAUUSD.s',
      standard_symbol:'XAUUSD', management_group_id:'position_group_01', thesis_id:'thesis_01',
      ownership_history_id:5, broker_server_key:'Broker-Demo', login_account:'10001',
      strategy_id:2, strategy_version:4, origin_signal_id:100,
    }
    const localContext = { ...context,
      as_of:{ ...context.as_of, market_snapshot_hash:'sha256:snapshot-b' },
      _diagnostics:{ previous_closed_bar_time_utc_ms:1784736900000 },
      _targets:new Map([['position_group_01', [target]]]) }
    const result = await persistPositionManagementEvaluations({ signalId:102, context:localContext,
      inferenceSource:'automatic_scheduler', management:{
        position_evaluations:[response().position_evaluations[0]], pending_evaluations:[],
      } })
    expect(result).toEqual([
      expect.objectContaining({ id:21, status:'HELD', confirmation_count:0 }),
      expect.objectContaining({ id:41, status:'CANDIDATE', confirmation_count:1 }),
    ])
    expect(queryRun.mock.calls.some(call => String(call[0]).includes("VALUES (?, 'CANDIDATE', 'HELD', ?")
      && call[1]?.[1] === 'automatic_confirmation_bar_gap')).toBe(true)
    expect(queryRun.mock.calls.some(call => JSON.stringify(call[1] || []).includes('automatic_confirmation_bar_gap'))).toBe(true)
  })

  it('does not create another close task after the confirmed task has entered execution', async () => {
    queryOne.mockResolvedValueOnce({ maximum_mode:'auto_exit', ai_pending_cancel_enabled:1 })
      .mockResolvedValueOnce({ id:12, decision_signal_id:102, action:'exit', validation_status:'valid' })
      .mockResolvedValueOnce({ id:21, state_version:3, status:'PRECONDITIONS_LOCKED', user_id:7,
        execution_mode:'auto_exit', task_type:'position_exit', management_group_id:'position_group_01', thesis_id:'thesis_01',
        model_evaluation_json:JSON.stringify({ contract_version:POSITION_MANAGEMENT_CONTRACT_VERSION }) })
    queryAll.mockResolvedValueOnce([])
    queryRun.mockResolvedValueOnce({ insertId:13, changes:1 })
      .mockResolvedValueOnce({ changes:1 })
    const target = {
      user_id:7, trading_account_id:3, outcome_id:9, position_id:'P-9', original_symbol:'XAUUSD.s',
      standard_symbol:'XAUUSD', management_group_id:'position_group_01', thesis_id:'thesis_01',
      ownership_history_id:5, broker_server_key:'Broker-Demo', login_account:'10001',
      strategy_id:2, strategy_version:4, origin_signal_id:100,
    }
    const localContext = { ...context, _targets:new Map([['position_group_01', [target]]]) }
    const result = await persistPositionManagementEvaluations({ signalId:103, context:localContext,
      inferenceSource:'automatic_scheduler', management:{
      position_evaluations:[response().position_evaluations[0]], pending_evaluations:[],
    } })
    expect(result).toEqual([])
    expect(queryRun.mock.calls.filter(call => String(call[0]).includes('INSERT IGNORE INTO ai_position_management_tasks'))).toHaveLength(0)
  })

  it('records manual analysis for audit without using it as automatic-close evidence', async () => {
    queryOne.mockResolvedValueOnce({ maximum_mode:'auto_exit', ai_pending_cancel_enabled:1 })
    queryAll.mockResolvedValueOnce([])
    queryRun.mockResolvedValueOnce({ insertId:14, changes:1 })
      .mockResolvedValueOnce({ changes:1 })
    const target = {
      user_id:7, trading_account_id:3, outcome_id:9, position_id:'P-9', original_symbol:'XAUUSD.s',
      standard_symbol:'XAUUSD', management_group_id:'position_group_01', thesis_id:'thesis_01',
      ownership_history_id:5, strategy_id:2,
    }
    const localContext = { ...context, _targets:new Map([['position_group_01', [target]]]) }
    const result = await persistPositionManagementEvaluations({ signalId:104, context:localContext,
      inferenceSource:'manual_analysis', management:{
        position_evaluations:[response().position_evaluations[0]], pending_evaluations:[],
      } })
    expect(result).toEqual([])
    expect(queryRun.mock.calls[0][1]).toContain('manual_analysis')
    expect(queryRun.mock.calls.filter(call => String(call[0]).includes('INSERT IGNORE INTO ai_position_management_tasks'))).toHaveLength(0)
  })
})

describe('single-inference pending cancellation', () => {
  it('supersedes a pending-cancel candidate when the latest valid decision keeps the order', async () => {
    queryOne.mockResolvedValueOnce({ maximum_mode:'auto_exit', ai_pending_cancel_enabled:1 })
    queryAll.mockResolvedValueOnce([])
    const task = { id:71, status:'EVIDENCE_CONFIRMED', state_version:2, fencing_token:3,
      evidence_validation_json:'{}', task_type:'pending_cancel' }
    const runner = vi.fn(async sql => {
      if (String(sql).includes('SELECT * FROM ai_position_management_tasks')) return [[task], []]
      if (String(sql).includes('UPDATE ai_position_management_tasks')) return [{ affectedRows:1 }, []]
      if (String(sql).includes('INSERT INTO ai_position_management_events')) return [{ affectedRows:1 }, []]
      throw new Error(`unexpected transaction SQL: ${sql}`)
    })
    withTransaction.mockImplementationOnce(async callback => callback(runner))
    const target = {
      user_id:7, trading_account_id:3, outcome_id:79, pending_ticket:'O-79', position_id:null,
      original_symbol:'XAUUSD', standard_symbol:'XAUUSD', management_group_id:'pending_group_01',
      thesis_id:'thesis_pending_01', ownership_history_id:5, strategy_id:2, strategy_version:4,
    }
    const localContext = { ...context, _targets:new Map([['pending_group_01', [target]]]) }
    const result = await persistPositionManagementEvaluations({ signalId:111, context:localContext,
      inferenceSource:'automatic_scheduler', management:{ position_evaluations:[], pending_evaluations:[{
        ...response().pending_evaluations[0], action:'keep', market_alignment:'uncertain', cancel_reason_code:null,
      }] } })
    expect(result).toEqual([expect.objectContaining({ id:71, status:'HELD', confirmation_count:0 })])
    expect(runner.mock.calls.some(call => String(call[0]).includes('FOR UPDATE'))).toBe(true)
    expect(queryRun).not.toHaveBeenCalled()
  })

  it('confirms a valid cancel decision immediately without querying a previous round', async () => {
    queryOne.mockResolvedValueOnce({ maximum_mode:'auto_exit', ai_pending_cancel_enabled:1 })
    queryAll.mockResolvedValueOnce([])
    queryRun.mockResolvedValueOnce({ insertId:31, changes:1 })
      .mockResolvedValueOnce({ changes:1 })
    const target = {
      user_id:7, trading_account_id:3, outcome_id:19, pending_ticket:'O-19', position_id:null,
      original_symbol:'XAUUSD.s', standard_symbol:'XAUUSD', management_group_id:'pending_group_01',
      thesis_id:'thesis_pending_01', ownership_history_id:5, broker_server_key:'Broker-Demo',
      login_account:'10001', strategy_id:2, strategy_version:4, origin_signal_id:100,
    }
    const localContext = { ...context, _targets:new Map([['pending_group_01', [target]]]) }
    const result = await persistPositionManagementEvaluations({ signalId:105, context:localContext,
      inferenceSource:'automatic_scheduler', management:{
        position_evaluations:[], pending_evaluations:[response().pending_evaluations[0]],
      } })
    expect(result).toEqual([expect.objectContaining({
      status:'EVIDENCE_CONFIRMED', confirmation_count:1, required_confirmations:1,
    })])
    expect(queryOne).toHaveBeenCalledTimes(1)
    expect(queryRun.mock.calls[0][0]).toContain("'EVIDENCE_CONFIRMED'")
    expect(queryRun.mock.calls.some(call => String(call[0]).includes("status = 'EVIDENCE_CONFIRMED'"))).toBe(false)
    expect(queryRun.mock.calls.some(call => String(call[0]).includes('single_inference_pending_cancel_confirmed'))).toBe(true)
  })

  it('does not enqueue an asynchronous task for a synchronous pending cancellation group', async () => {
    queryOne.mockResolvedValueOnce({ maximum_mode:'auto_exit', ai_pending_cancel_enabled:1 })
    const target = {
      user_id:7, trading_account_id:3, outcome_id:29, pending_ticket:'O-29', position_id:null,
      original_symbol:'XAUUSD.s', standard_symbol:'XAUUSD', management_group_id:'pending_group_01',
      thesis_id:'thesis_pending_01', ownership_history_id:5, strategy_id:2, strategy_version:4,
    }
    const localContext = { ...context, _targets:new Map([['pending_group_01', [target]]]) }
    const result = await persistPositionManagementEvaluations({ signalId:106, context:localContext,
      inferenceSource:'automatic_scheduler', synchronousPendingCancelGroupIds:new Set(['pending_group_01']),
      management:{ position_evaluations:[], pending_evaluations:[response().pending_evaluations[0]] } })
    expect(result).toEqual([])
    expect(queryRun).not.toHaveBeenCalled()
  })

  it('keeps hold plus cancel asynchronous when its group is not synchronous', async () => {
    queryOne.mockResolvedValueOnce({ maximum_mode:'auto_exit', ai_pending_cancel_enabled:1 })
    queryAll.mockResolvedValueOnce([])
    queryRun.mockResolvedValueOnce({ insertId:41, changes:1 })
      .mockResolvedValueOnce({ changes:1 })
    const target = {
      user_id:7, trading_account_id:3, outcome_id:39, pending_ticket:'O-39', position_id:null,
      original_symbol:'XAUUSD.s', standard_symbol:'XAUUSD', management_group_id:'pending_group_01',
      thesis_id:'thesis_pending_01', ownership_history_id:5, strategy_id:2, strategy_version:4,
    }
    const localContext = { ...context, _targets:new Map([['pending_group_01', [target]]]) }
    const result = await persistPositionManagementEvaluations({ signalId:107, context:localContext,
      inferenceSource:'automatic_scheduler', management:{
        position_evaluations:[], pending_evaluations:[response().pending_evaluations[0]],
      } })
    expect(result).toEqual([expect.objectContaining({ task_type:'pending_cancel', candidate_action:'cancel' })])
    expect(queryRun.mock.calls[0][0]).toContain('ai_position_management_tasks')
    expect(queryRun.mock.calls[0][1]).toContain('pending_cancel')
  })

  it('binds an invalid Bridge generation as NULL for a pending-cancel task', async () => {
    getBridgeGeneration.mockReturnValueOnce(NaN)
    queryOne.mockResolvedValueOnce({ maximum_mode:'auto_exit', ai_pending_cancel_enabled:1 })
    queryAll.mockResolvedValueOnce([])
    queryRun.mockResolvedValueOnce({ insertId:42, changes:1 })
      .mockResolvedValueOnce({ changes:1 })
    const target = {
      user_id:7, trading_account_id:3, outcome_id:49, pending_ticket:'O-49', position_id:null,
      original_symbol:'XAUUSD.s', standard_symbol:'XAUUSD', management_group_id:'pending_group_01',
      thesis_id:'thesis_pending_01', ownership_history_id:5, broker_server_key:'Broker-Demo',
      login_account:'10001', strategy_id:2, strategy_version:4, origin_signal_id:100,
    }
    const localContext = { ...context, _targets:new Map([['pending_group_01', [target]]]) }
    const result = await persistPositionManagementEvaluations({ signalId:110, context:localContext,
      inferenceSource:'automatic_scheduler', management:{
        position_evaluations:[], pending_evaluations:[response().pending_evaluations[0]],
      } })
    expect(result).toEqual([expect.objectContaining({ task_type:'pending_cancel', candidate_action:'cancel' })])
    const taskInsert = queryRun.mock.calls.find(call =>
      String(call[0]).includes('INSERT IGNORE INTO ai_position_management_tasks'))
    expect(taskInsert?.[1]?.[8]).toBeNull()
  })

  it('creates one pending-cancel task per active account target in a shared group', async () => {
    queryOne.mockResolvedValueOnce({ maximum_mode:'auto_exit', ai_pending_cancel_enabled:1 })
    queryAll.mockResolvedValueOnce([])
    queryRun.mockResolvedValueOnce({ insertId:51, changes:1 })
      .mockResolvedValueOnce({ changes:1 })
      .mockResolvedValueOnce({ insertId:52, changes:1 })
      .mockResolvedValueOnce({ changes:1 })
    const target = (outcomeId, userId) => ({
      user_id:userId, trading_account_id:userId, outcome_id:outcomeId, pending_ticket:`O-${outcomeId}`, position_id:null,
      original_symbol:'XAUUSD.s', standard_symbol:'XAUUSD', management_group_id:'pending_group_01',
      thesis_id:'thesis_pending_01', ownership_history_id:userId, broker_server_key:'Broker-Demo',
      login_account:`1000${userId}`, strategy_id:2, strategy_version:4, origin_signal_id:100,
    })
    const localContext = { ...context, _targets:new Map([['pending_group_01', [target(59, 7), target(60, 28)] ]]) }
    const result = await persistPositionManagementEvaluations({ signalId:108, context:localContext,
      inferenceSource:'automatic_scheduler', management:{
        position_evaluations:[], pending_evaluations:[response().pending_evaluations[0]],
      } })
    expect(result).toHaveLength(2)
    expect(result.map(item => item.outcome_id)).toEqual([59, 60])
    expect(queryRun.mock.calls.filter(call => String(call[0]).includes('INSERT IGNORE INTO ai_position_management_tasks')))
      .toHaveLength(2)
  })

  it('records a position evaluation independently for each account target in a shared group', async () => {
    queryOne.mockResolvedValueOnce({ maximum_mode:'auto_exit', ai_pending_cancel_enabled:1 })
    queryAll.mockResolvedValueOnce([])
    queryRun.mockResolvedValueOnce({ insertId:61, changes:1 })
      .mockResolvedValueOnce({ changes:1 })
      .mockResolvedValueOnce({ insertId:62, changes:1 })
      .mockResolvedValueOnce({ changes:1 })
    const target = (outcomeId, userId) => ({
      user_id:userId, trading_account_id:userId, outcome_id:outcomeId, position_id:`P-${outcomeId}`, pending_ticket:null,
      original_symbol:'XAUUSD.s', standard_symbol:'XAUUSD', management_group_id:'position_group_01',
      thesis_id:'thesis_01', ownership_history_id:userId, broker_server_key:'Broker-Demo',
      login_account:`1000${userId}`, strategy_id:2, strategy_version:4, origin_signal_id:100,
    })
    const localContext = { ...context, _targets:new Map([['position_group_01', [target(69, 7), target(70, 28)] ]]) }
    const result = await persistPositionManagementEvaluations({ signalId:109, context:localContext,
      inferenceSource:'manual_analysis', management:{
        position_evaluations:[response().position_evaluations[0]], pending_evaluations:[],
      } })
    expect(result).toEqual([])
    const evaluationCalls = queryRun.mock.calls.filter(call => String(call[0]).includes('INSERT IGNORE INTO ai_position_management_evaluations'))
    expect(evaluationCalls).toHaveLength(2)
    expect(evaluationCalls.map(call => call[1][3])).toEqual([69, 70])
  })
})

describe('durable state and protection boundaries', () => {
  it('claims a worker lease using the database wrapper changes field', async () => {
    queryRun.mockResolvedValueOnce({ changes:1 })
    queryOne.mockResolvedValueOnce({ id:7, lease_token:'lease', fencing_token:3, state_version:2 })
    await expect(claimPositionManagementLease(7, 45)).resolves.toMatchObject({ id:7, fencing_token:3 })
    expect(queryOne).toHaveBeenCalledWith(expect.stringContaining('fencing_token'), [7])
  })

  it('stores auto-exit consent without a daily limit or account cooldown gate', async () => {
    queryRun.mockResolvedValueOnce({ changes:1 })
    queryOne.mockResolvedValueOnce({ execution_mode:'auto_exit' })
      .mockResolvedValueOnce({ maximum_mode:'auto_exit', ai_pending_order_enabled:1, ai_pending_cancel_enabled:1 })
    await expect(savePositionManagementSettings(7, { execution_mode:'auto_exit' })).resolves.toMatchObject({
      user:expect.objectContaining({ execution_mode:'auto_exit' }),
      effective_mode:'auto_exit',
    })
    expect(queryRun).toHaveBeenCalledWith(expect.stringContaining('user_position_management_settings'), [
      7, 'auto_exit', 0, 0, 60, '2026-07-23 12:00:00',
    ])
  })

  it('defaults users without a saved preference to automatic close', async () => {
    queryOne.mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ maximum_mode:'auto_exit', ai_pending_order_enabled:1, ai_pending_cancel_enabled:1 })
    await expect(getPositionManagementSettings(8)).resolves.toMatchObject({
      user:{ user_id:8, execution_mode:'auto_exit' },
      effective_mode:'auto_exit',
    })
  })

  it('keeps pending cancellation independent from platform and user close switches', () => {
    expect(resolvePositionManagementTaskMode('pending_cancel', 'display', {
      maximum_mode:'display', ai_pending_cancel_enabled:1,
    })).toBe('auto_exit')
    expect(resolvePositionManagementTaskMode('pending_cancel', 'auto_exit', {
      maximum_mode:'auto_exit', ai_pending_cancel_enabled:0,
    })).toBe('display')
    expect(resolvePositionManagementTaskMode('position_exit', 'display', {
      maximum_mode:'auto_exit', ai_pending_cancel_enabled:1,
    })).toBe('display')
  })

  it('never mixes pending-order and position targets between management tasks', () => {
    const pending = { position_id:null, pending_ticket:'O-1' }
    const position = { position_id:'P-1', pending_ticket:null }
    const filledPending = { position_id:'P-2', pending_ticket:'O-2' }
    const legacyPendingAlias = { position_id:'O-3', pending_ticket:'O-3', effective_pending_state:'pending' }
    expect(targetMatchesPositionManagementTask(pending, 'pending_cancel')).toBe(true)
    expect(targetMatchesPositionManagementTask(position, 'pending_cancel')).toBe(false)
    expect(targetMatchesPositionManagementTask(filledPending, 'pending_cancel')).toBe(false)
    expect(targetMatchesPositionManagementTask(position, 'position_exit')).toBe(true)
    expect(targetMatchesPositionManagementTask(filledPending, 'position_exit')).toBe(true)
    expect(targetMatchesPositionManagementTask(pending, 'position_exit')).toBe(false)
    expect(targetMatchesPositionManagementTask(legacyPendingAlias, 'pending_cancel')).toBe(true)
    expect(targetMatchesPositionManagementTask(legacyPendingAlias, 'position_exit')).toBe(false)
  })

  it('does not let stale subscriber outcomes create platform management groups', async () => {
    queryAll.mockResolvedValueOnce([
      {
        outcome_id:11, pending_ticket:'O-11', position_id:'O-11', effective_pending_state:'pending',
        management_group_id:'group_pending', thesis_id:'thesis_pending', strategy_id:3, strategy_version:1,
        standard_symbol:'XAUUSD', direction:'sell', origin_signal_id:101, decision_timeframe:'M15',
        output_contract_version:'position-management-v1.2',
        invalidation_conditions_json:'[]', evidence_refs_json:'[]',
      },
      {
        outcome_id:12, pending_ticket:null, position_id:'P-12', effective_pending_state:null,
        management_group_id:'group_stale', thesis_id:'thesis_stale', strategy_id:3, strategy_version:1,
        standard_symbol:'XAUUSD', direction:'buy', origin_signal_id:102, decision_timeframe:'M15',
        invalidation_conditions_json:'[]', evidence_refs_json:'[]',
      },
    ])
    const value = await loadActivePositionManagementContext({
      strategyId:3, strategyVersion:99, symbol:'XAUUSD', decisionTimeframe:'M15',
      market:{
        strategy_reference_portfolio:{
          role:'platform_strategy_reference_portfolio', positions:[],
          pending_orders:[{ reference_id:'outcome:11' }],
        },
        strategy_context:{ timeframes:{ M15:{ summary:{ last_closed_bar:{ time_utc_msc:1784877300000 } } } } },
      },
    })

    expect(value.pending_groups).toEqual([expect.objectContaining({ management_group_id:'group_pending' })])
    expect(value.position_groups).toEqual([])
    expect(value.pending_groups[0]).not.toHaveProperty('frozen_conditions')
    expect(value._targets.get('group_pending')[0].position_id).toBeNull()
    expect(value._targets.get('group_pending')[0].strategy_version).toBe(1)
    expect(value._targets.has('group_stale')).toBe(false)
  })

  it('keeps an available observer 0/0 portfolio empty even when a subscriber outcome is stale-open', async () => {
    queryAll.mockResolvedValueOnce([{
      outcome_id:724919486, user_id:28, trading_account_id:3,
      pending_ticket:null, position_id:'724919486', effective_pending_state:null,
      management_group_id:'subscriber-stale-group', thesis_id:'subscriber-stale-thesis',
      strategy_id:3, strategy_version:1, strategy_scope:'platform',
      standard_symbol:'XAUUSD', direction:'buy', origin_signal_id:13170,
      decision_timeframe:'M15', entry_method:'market', core_entry_reason:'历史订阅论点',
      invalidation_conditions_json:'[]', evidence_refs_json:'[]',
    }])

    const value = await loadActivePositionManagementContext({
      strategyId:3, symbol:'XAUUSD', decisionTimeframe:'M15',
      market:{
        strategy_reference_portfolio:{
          role:'platform_strategy_reference_portfolio', strategy_id:3, symbol:'XAUUSD',
          positions:[], pending_orders:[], position_count:0, pending_count:0,
        },
        strategy_context:{ timeframes:{ M15:{ summary:{ last_closed_bar:{ time_utc_msc:1784877300000 } } } } },
      },
    })

    expect(value.pending_groups).toEqual([])
    expect(value.position_groups).toEqual([])
    expect(value._targets.size).toBe(0)
    expect(JSON.stringify(value)).not.toContain('subscriber-stale-group')
  })

  it('rotates an over-capacity set without dropping the whole management context', async () => {
    const rows = Array.from({ length:21 }, (_, index) => ({
      outcome_id:2000 + index, pending_ticket:`O-${2000 + index}`, position_id:null,
      effective_pending_state:'pending', management_group_id:`capacity-group-${String(index).padStart(2, '0')}`,
      thesis_id:`capacity-thesis-${index}`, strategy_id:3, strategy_version:1,
      standard_symbol:'XAUUSD', direction:'buy', origin_signal_id:2000 + index,
      decision_timeframe:'M15', entry_method:'limit', core_entry_reason:'容量测试挂单',
      original_stop_loss:4000, invalidation_conditions_json:'[]', evidence_refs_json:'[]',
    }))
    queryAll.mockResolvedValue(rows)
    const market = {
      strategy_reference_portfolio:{ role:'platform_strategy_reference_portfolio', positions:[],
        pending_orders:rows.map(row => ({ reference_id:`outcome:${row.outcome_id}`, direction:'buy',
          order_type:'buy_limit', trigger_price:4100 })) },
      strategy_context:{ timeframes:{ M15:{ summary:{ last_closed_bar:{ time_utc_msc:1784877300000 },
        market_data_quality:{ last_bar_closed:true } },
        klines:[{ time_utc_msc:1784876400000 }, { time_utc_msc:1784877300000 }] } } },
    }
    const first = await loadActivePositionManagementContext({
      strategyId:3, symbol:'XAUUSD', decisionTimeframe:'M15', market,
    })
    const second = await loadActivePositionManagementContext({
      strategyId:3, symbol:'XAUUSD', decisionTimeframe:'M15', market,
    })
    expect(first._diagnostics).toMatchObject({
      selection_mode:'rotating', batch_count:3, total_group_count:21,
    })
    expect(first._diagnostics.selected_section_count).toBeLessThanOrEqual(20)
    expect(first._diagnostics.deferred_group_count).toBeGreaterThan(0)
    expect(first._diagnostics.context_chars).toBeLessThanOrEqual(32_000)
    expect(first._targets.size).toBeGreaterThan(0)
    expect([...second._targets.keys()]).toEqual([...first._targets.keys()])
    expect(JSON.stringify(first)).not.toContain('_diagnostics')

    const rotatedContexts = [first]
    for (const offset of [900_000, 1_800_000]) {
      const current = 1784877300000 + offset
      market.strategy_context.timeframes.M15.summary.last_closed_bar.time_utc_msc = current
      market.strategy_context.timeframes.M15.klines = [
        { time_utc_msc:current - 900_000 }, { time_utc_msc:current },
      ]
      rotatedContexts.push(await loadActivePositionManagementContext({
        strategyId:3, symbol:'XAUUSD', decisionTimeframe:'M15', market,
      }))
    }
    const selectionCounts = new Map(rows.map(row => [row.management_group_id, 0]))
    for (const selected of rotatedContexts) {
      for (const groupId of selected._targets.keys()) {
        selectionCounts.set(groupId, selectionCounts.get(groupId) + 1)
      }
    }
    expect([...selectionCounts.values()].every(count => count >= 2)).toBe(true)
  })

  it('keeps mixed pending and position sections atomic during capacity rotation', async () => {
    const rows = Array.from({ length:11 }, (_, index) => {
      const groupId = `atomic-capacity-group-${String(index).padStart(2, '0')}`
      return [
        { outcome_id:2100 + index * 2, pending_ticket:null, position_id:`P-${2100 + index * 2}`,
          effective_pending_state:null, management_group_id:groupId, thesis_id:`atomic-thesis-${index}`,
          strategy_id:3, strategy_version:1, standard_symbol:'XAUUSD', direction:'buy',
          origin_signal_id:2100 + index * 2, decision_timeframe:'M15', entry_method:'market',
          core_entry_reason:'混合容量测试', original_stop_loss:4000,
          invalidation_conditions_json:'[]', evidence_refs_json:'[]' },
        { outcome_id:2101 + index * 2, pending_ticket:`O-${2101 + index * 2}`, position_id:null,
          effective_pending_state:'pending', management_group_id:groupId, thesis_id:`atomic-thesis-${index}`,
          strategy_id:3, strategy_version:1, standard_symbol:'XAUUSD', direction:'buy',
          origin_signal_id:2100 + index * 2, decision_timeframe:'M15', entry_method:'market',
          core_entry_reason:'混合容量测试', original_stop_loss:4000,
          invalidation_conditions_json:'[]', evidence_refs_json:'[]' },
      ]
    }).flat()
    queryAll.mockResolvedValueOnce(rows)
    const value = await loadActivePositionManagementContext({
      strategyId:3, symbol:'XAUUSD', decisionTimeframe:'M15',
      market:{ strategy_reference_portfolio:{ role:'platform_strategy_reference_portfolio',
          positions:rows.filter(row => row.position_id).map(row => ({ reference_id:`outcome:${row.outcome_id}`,
            direction:'buy', order_type:'position', entry_price:4100, current_price:4101 })),
          pending_orders:rows.filter(row => row.pending_ticket).map(row => ({ reference_id:`outcome:${row.outcome_id}`,
            direction:'buy', order_type:'buy_limit', trigger_price:4100 })) },
        strategy_context:{ timeframes:{ M15:{ summary:{ last_closed_bar:{ time_utc_msc:1784877300000 } },
          klines:[{ time_utc_msc:1784876400000 }, { time_utc_msc:1784877300000 }] } } } },
    })
    const pendingIds = new Set(value.pending_groups.map(group => group.management_group_id))
    const positionIds = new Set(value.position_groups.map(group => group.management_group_id))
    expect([...pendingIds]).toEqual([...positionIds])
    expect(value._diagnostics.selected_section_count).toBeLessThanOrEqual(20)
    expect(value._diagnostics.context_chars).toBeLessThanOrEqual(32_000)
  })

  it('isolates a single over-budget group without deferring normal groups', async () => {
    const oversizedTakeProfits = JSON.stringify(Array.from({ length:20_000 }, () => 1))
    queryAll.mockResolvedValueOnce([
      { outcome_id:2201, pending_ticket:'O-2201', position_id:null, effective_pending_state:'pending',
        management_group_id:'oversized-group', thesis_id:'oversized-thesis', strategy_id:3, strategy_version:1,
        standard_symbol:'XAUUSD', direction:'buy', origin_signal_id:2201, decision_timeframe:'M15',
        entry_method:'limit', core_entry_reason:'异常大组', original_stop_loss:4000,
        original_take_profits_json:oversizedTakeProfits, invalidation_conditions_json:'[]', evidence_refs_json:'[]' },
      ...Array.from({ length:2 }, (_, index) => ({
        outcome_id:2210 + index, pending_ticket:`O-${2210 + index}`, position_id:null,
        effective_pending_state:'pending', management_group_id:`normal-group-${index}`,
        thesis_id:`normal-thesis-${index}`, strategy_id:3, strategy_version:1,
        standard_symbol:'XAUUSD', direction:'buy', origin_signal_id:2210 + index,
        decision_timeframe:'M15', entry_method:'limit', core_entry_reason:'正常组', original_stop_loss:4000,
        invalidation_conditions_json:'[]', evidence_refs_json:'[]',
      })),
    ])
    const value = await loadActivePositionManagementContext({
      strategyId:3, symbol:'XAUUSD', decisionTimeframe:'M15',
      market:{ strategy_reference_portfolio:{ role:'platform_strategy_reference_portfolio', positions:[],
          pending_orders:[
            { reference_id:'outcome:2201', direction:'buy', order_type:'buy_limit', trigger_price:4100 },
            { reference_id:'outcome:2210', direction:'buy', order_type:'buy_limit', trigger_price:4100 },
            { reference_id:'outcome:2211', direction:'buy', order_type:'buy_limit', trigger_price:4100 },
          ] },
        strategy_context:{ timeframes:{ M15:{ summary:{ last_closed_bar:{ time_utc_msc:1784877300000 } },
          klines:[{ time_utc_msc:1784876400000 }, { time_utc_msc:1784877300000 }] } } } },
    })
    expect(value._diagnostics.oversized_group_count).toBe(0)
    expect(value._targets.has('oversized-group')).toBe(true)
    expect(value._targets.has('normal-group-0')).toBe(true)
    expect(value._targets.has('normal-group-1')).toBe(true)
  })

  it('keeps only the observer outcome in the platform model target projection', async () => {
    queryAll.mockResolvedValueOnce([
      { outcome_id:801, pending_ticket:'O-801', position_id:null, effective_pending_state:'pending',
        user_id:1, trading_account_id:1, login_account:'observer',
        management_group_id:'shared-group-801', thesis_id:'thesis-801', strategy_id:3, strategy_version:1,
        standard_symbol:'XAUUSD', direction:'buy', origin_signal_id:801, decision_timeframe:'M15',
        entry_method:'limit', core_entry_reason:'回踩支撑做多', original_stop_loss:4000,
        invalidation_conditions_json:'[]', evidence_refs_json:'[]' },
      { outcome_id:802, pending_ticket:'O-802', position_id:null, effective_pending_state:'pending',
        user_id:28, trading_account_id:3, login_account:'subscriber',
        management_group_id:'shared-group-801', thesis_id:'thesis-801', strategy_id:3, strategy_version:1,
        standard_symbol:'XAUUSD', direction:'buy', origin_signal_id:801, decision_timeframe:'M15',
        entry_method:'limit', core_entry_reason:'回踩支撑做多', original_stop_loss:4000,
        invalidation_conditions_json:'[]', evidence_refs_json:'[]' },
    ])
    const value = await loadActivePositionManagementContext({
      strategyId:3, symbol:'XAUUSD', decisionTimeframe:'M15',
      market:{
        strategy_reference_portfolio:{ role:'platform_strategy_reference_portfolio',
          positions:[], pending_orders:[{ reference_id:'outcome:801', direction:'buy', order_type:'buy_limit', trigger_price:4100 }] },
        strategy_context:{ timeframes:{ M15:{ summary:{ last_closed_bar:{ time_utc_msc:1784877300000 } } } } },
      },
    })

    expect(value.pending_groups).toHaveLength(1)
    expect(value._targets.get('shared-group-801').map(target => target.outcome_id)).toEqual([801])
    const serialized = JSON.stringify(value)
    expect(serialized).not.toContain('observer')
    expect(serialized).not.toContain('subscriber')
    expect(serialized).not.toContain('trading_account_id')
    expect(serialized).not.toContain('login_account')
  })

  it('projects mixed pending and position facts and evidence refs into separate sections', async () => {
    queryAll.mockResolvedValueOnce([
      { outcome_id:901, pending_ticket:null, position_id:'P-901', effective_pending_state:null,
        management_group_id:'mixed-group-901', thesis_id:'thesis-901', strategy_id:3, strategy_version:1,
        standard_symbol:'XAUUSD', direction:'buy', origin_signal_id:901, decision_timeframe:'M15',
        entry_method:'market', core_entry_reason:'回踩支撑做多', original_stop_loss:4000,
        invalidation_conditions_json:'[]', evidence_refs_json:'[]' },
      { outcome_id:902, pending_ticket:'O-902', position_id:null, effective_pending_state:'pending',
        management_group_id:'mixed-group-901', thesis_id:'thesis-901', strategy_id:3, strategy_version:1,
        standard_symbol:'XAUUSD', direction:'buy', origin_signal_id:901, decision_timeframe:'M15',
        entry_method:'market', core_entry_reason:'回踩支撑做多', original_stop_loss:4000,
        invalidation_conditions_json:'[]', evidence_refs_json:'[]' },
      { outcome_id:903, pending_ticket:null, position_id:'P-903', effective_pending_state:null,
        management_group_id:'mixed-group-901', thesis_id:'thesis-901', strategy_id:3, strategy_version:1,
        standard_symbol:'XAUUSD', direction:'buy', origin_signal_id:901, decision_timeframe:'M15',
        entry_method:'market', core_entry_reason:'回踩支撑做多', original_stop_loss:4000,
        invalidation_conditions_json:'[]', evidence_refs_json:'[]' },
    ])
    const value = await loadActivePositionManagementContext({
      strategyId:3, symbol:'XAUUSD', decisionTimeframe:'M15',
      market:{
        strategy_reference_portfolio:{ role:'platform_strategy_reference_portfolio',
          positions:[
            { reference_id:'outcome:901', direction:'buy', order_type:'position', entry_price:2000, current_price:2010 },
            { reference_id:'outcome:903', direction:'buy', order_type:'position', entry_price:0, current_price:0 },
          ],
          pending_orders:[{ reference_id:'outcome:902', direction:'buy', order_type:'buy_limit', trigger_price:1990 }],
        },
        strategy_context:{ timeframes:{ M15:{ summary:{ last_closed_bar:{ time_utc_msc:1784877300000 } } } } },
      },
    })

    const positionGroup = value.position_groups[0]
    const pendingGroup = value.pending_groups[0]
    expect(positionGroup.position_facts).toHaveLength(2)
    expect(positionGroup.pending_order_facts).toEqual([])
    expect(positionGroup.reference_facts_status).toBe('available')
    expect(positionGroup.allowed_evidence_refs).toContain('terminal:901:position')
    expect(positionGroup.allowed_evidence_refs).not.toContain('terminal:902:pending')
    expect(pendingGroup.position_facts).toEqual([])
    expect(pendingGroup.pending_order_facts).toHaveLength(1)
    expect(pendingGroup.reference_facts_status).toBe('available')
    expect(pendingGroup.allowed_evidence_refs).toContain('terminal:902:pending')
    expect(pendingGroup.allowed_evidence_refs).not.toContain('terminal:901:position')
  })

  it('injects complete terminal facts and keeps expiration outside the model contract', async () => {
    queryAll.mockResolvedValueOnce([{
      outcome_id:9305, pending_ticket:'O-9305', position_id:null, effective_pending_state:'pending',
      management_group_id:'group_9305', thesis_id:'thesis_9305', strategy_id:3, strategy_version:1,
      standard_symbol:'XAUUSD', direction:'buy', origin_signal_id:9305, decision_timeframe:'M15',
      entry_method:'limit', core_entry_reason:'回踩支撑做多', original_stop_loss:4000,
      invalidation_conditions_json:JSON.stringify([{
        condition_id:'hard_9305', kind:'hard', timeframe:'M15', operator:'closed_bar_lte', threshold:4000,
      }]), evidence_refs_json:'[]',
    }])
    const value = await loadActivePositionManagementContext({
      strategyId:3, strategyVersion:1, symbol:'XAUUSD', decisionTimeframe:'M15',
      market:{
        strategy_reference_portfolio:{
          role:'platform_strategy_reference_portfolio', positions:[],
          captured_at:'2026-07-22T02:58:00.000Z', captured_at_utc_msc:1784746680000,
          pending_orders:[{ reference_id:'outcome:9305', direction:'buy', side:'buy',
            order_type:'buy_limit', trigger_price:4100, actual_stop_loss:4000,
            actual_take_profit:4200, original_stop_loss:4000, original_take_profits:[4200],
            valid_until_utc_msc:1784748720000, is_expired:false }],
        },
        strategy_context:{ timeframes:{ M15:{ summary:{ last_closed_bar:{
          time_utc_msc:1784746680000, close:3990,
        } } } } },
      },
    })
    expect(value.pending_groups[0]).toMatchObject({
      management_group_id:'group_9305',
      decision_context_status:'available', reference_facts_status:'available',
      pending_order_facts:[expect.objectContaining({ direction:'buy', trigger_price:4100,
        actual_stop_loss:4000, actual_take_profit:4200 })],
    })
    expect(value.pending_groups[0].pending_order_facts[0]).not.toHaveProperty('is_expired')
    expect(value.pending_groups[0].pending_order_facts[0]).not.toHaveProperty('valid_until_utc_msc')
    expect(value.pending_groups[0]).not.toHaveProperty('frozen_conditions')
    expect(value.pending_groups[0].allowed_evidence_refs).toEqual(expect.arrayContaining([
      'bar:M15:1784746680000',
      expect.stringMatching(/^snapshot:/),
      'terminal:9305:pending',
    ]))
    expect(value.pending_groups[0].allowed_evidence_refs).not.toContain('condition:hard_9305')
  })

  it('maps complete platform position and pending terminal facts without account data', async () => {
    queryAll.mockResolvedValueOnce([
      { outcome_id:501, position_id:'POS-501', pending_ticket:null, effective_pending_state:null,
        management_group_id:'group-pos-501', thesis_id:'thesis-pos-501', strategy_id:3, strategy_version:4,
        standard_symbol:'XAUUSD', direction:'buy', origin_signal_id:401, decision_timeframe:'M15',
        entry_method:'market', core_entry_reason:'回踩支撑后顺势做多', original_stop_loss:1980,
        original_take_profits_json:'[2040,2080]', created_at:'2026-08-07 08:00:00' },
      { outcome_id:502, position_id:null, pending_ticket:'ORD-502', effective_pending_state:'pending',
        management_group_id:'group-pend-502', thesis_id:'thesis-pend-502', strategy_id:3, strategy_version:4,
        standard_symbol:'XAUUSD', direction:'sell', origin_signal_id:402, decision_timeframe:'M15',
        entry_method:'limit', core_entry_reason:'反弹至阻力位做空', original_stop_loss:2060,
        original_take_profits_json:'[1980]', created_at:'2026-08-07 08:05:00' },
    ])
    const value = await loadActivePositionManagementContext({
      strategyId:3, strategyVersion:4, symbol:'XAUUSD', decisionTimeframe:'M15',
      market:{
        strategy_reference_portfolio:{
          role:'platform_strategy_reference_portfolio',
          positions:[{ reference_id:'outcome:501', direction:'buy', order_type:'position',
            entry_price:2000, current_price:2010, actual_stop_loss:1985,
            actual_take_profit:2050, opened_at:'2026-08-07T08:00:00Z' }],
          pending_orders:[{ reference_id:'outcome:502', direction:'sell', order_type:'sell_limit',
            trigger_price:2050, actual_stop_loss:2070, actual_take_profit:1980,
            created_at:'2026-08-07T08:05:00Z' }],
        },
        strategy_context:{ timeframes:{ M15:{ summary:{ last_closed_bar:{ time_utc_msc:1786070400000 } } } } },
      },
    })
    expect(value.position_groups[0]).toMatchObject({
      decision_context_status:'available', reference_facts_status:'available', direction:'buy',
      position_facts:[expect.objectContaining({ source:'platform_reference_portfolio', direction:'buy',
        order_type:'position', entry_price:2000, current_price:2010,
        actual_stop_loss:1985, actual_take_profit:2050, volume:null })],
    })
    expect(value.pending_groups[0]).toMatchObject({
      decision_context_status:'available', reference_facts_status:'available', direction:'sell',
      pending_order_facts:[expect.objectContaining({ source:'platform_reference_portfolio', direction:'sell',
        order_type:'sell_limit', trigger_price:2050, actual_stop_loss:2070, volume:null })],
    })
    const contextKeys = JSON.stringify({ position:value.position_groups, pending:value.pending_groups })
      .match(/"([^"]+)":/g)?.map(key => key.slice(1, -2)) || []
    expect(contextKeys).not.toEqual(expect.arrayContaining([
      'protection_status', 'ticket', 'profit', 'balance', 'equity',
    ]))
  })

  it('matches private terminal positions and pending orders by exact identity', async () => {
    queryAll.mockResolvedValueOnce([
      { outcome_id:601, position_id:'POS-601', pending_ticket:null, effective_pending_state:null,
        management_group_id:'private-pos-601', thesis_id:'private-thesis-601', strategy_id:9, strategy_version:2,
        standard_symbol:'EURUSD', direction:'buy', origin_signal_id:501, decision_timeframe:'M5',
        entry_method:'market', core_entry_reason:'突破后顺势跟进', original_stop_loss:1.08,
        original_take_profits_json:'[1.1]', created_at:'2026-08-07 08:00:00' },
      { outcome_id:602, position_id:null, pending_ticket:'ORD-602', effective_pending_state:'pending',
        management_group_id:'private-pend-602', thesis_id:'private-thesis-602', strategy_id:9, strategy_version:2,
        standard_symbol:'EURUSD', direction:'sell', origin_signal_id:502, decision_timeframe:'M5',
        entry_method:'limit', core_entry_reason:'阻力位反转做空', original_stop_loss:1.11,
        original_take_profits_json:'[1.07]', created_at:'2026-08-07 08:01:00' },
    ])
    const value = await loadActivePositionManagementContext({
      strategyId:9, strategyVersion:2, strategyScope:'private', ownerUserId:7,
      symbol:'EURUSD', decisionTimeframe:'M5',
      market:{
        positions:[{ position_id:'POS-601', identifier:'ID-601', ticket:'T-601', type:'buy',
          open_price:1.09, price_current:1.095, sl:1.08, tp:1.1, time:'2026-08-07T08:00:00Z' }],
        pending_orders:[{ ticket:'ORD-602', pending_type:'sell_limit', side:'sell', price:1.105,
          sl:1.11, tp:1.07, time_setup:'2026-08-07T08:01:00Z' }],
        strategy_context:{ timeframes:{ M5:{ summary:{ last_closed_bar:{ time_utc_msc:1786070400000 } } } } },
      },
    })
    expect(value.position_groups[0].decision_context_status).toBe('available')
    expect(value.position_groups[0].position_facts[0]).toMatchObject({
      source:'private_market', direction:'buy', entry_price:1.09, current_price:1.095,
    })
    expect(value.pending_groups[0].decision_context_status).toBe('available')
    expect(value.pending_groups[0].pending_order_facts[0]).toMatchObject({
      source:'private_market', direction:'sell', trigger_price:1.105, order_type:'sell_limit',
    })
  })

  it('does not create a platform group when the reference portfolio has no live fact', async () => {
    queryAll.mockResolvedValueOnce([{
      outcome_id:701, position_id:'POS-701', pending_ticket:null, effective_pending_state:null,
      management_group_id:'unmapped-701', thesis_id:'thesis-701', strategy_id:4, strategy_version:1,
      standard_symbol:'XAUUSD', direction:'buy', origin_signal_id:701, decision_timeframe:'M15',
      entry_method:'market', core_entry_reason:'原入场理由', original_stop_loss:1900,
      original_take_profits_json:'[2100]', created_at:'2026-08-07 08:00:00',
    }])
    const value = await loadActivePositionManagementContext({
      strategyId:4, symbol:'XAUUSD', decisionTimeframe:'M15',
      market:{ strategy_reference_portfolio:{ role:'platform_strategy_reference_portfolio', status:'unavailable', positions:[], pending_orders:[] },
        strategy_context:{ timeframes:{ M15:{ summary:{ last_closed_bar:{ time_utc_msc:1786070400000 } } } } } },
    })
    expect(value.position_groups).toEqual([])
  })

  it('resolves only unique subscriber delivery lineage after a valid cancel', async () => {
    const group = {
      ...context.pending_groups[0], strategy_id:3, strategy_version:1, strategy_scope:'platform',
      standard_symbol:'XAUUSD',
      thesis_id:'thesis-source', original_signal_id:801, management_group_id:'group-source',
    }
    const row = (overrides = {}) => ({
      delivery_id:10, delivery_signal_id:801, delivery_user_id:28, delivery_strategy_id:3,
      delivery_symbol:'XAUUSD.s',
      delivery_order_intent_id:901, intent_id:901, intent_user_id:28, intent_trading_account_id:3,
      intent_status:'succeeded', delivery_pending_ticket:'O-802',
      outcome_id:802, outcome_delivery_id:10, outcome_order_intent_id:901, user_id:28,
      trading_account_id:3, ownership_history_id:44, broker_server_key:'BROKER-DEMO', login_account:'7788',
      original_symbol:'XAUUSD.s', symbol:'XAUUSD.s', pending_ticket:'O-802', position_id:null,
      entry_direction:'buy', system_magic:234000, attribution_status:'pending', outcome_status:'open',
      effective_pending_state:'pending', origin_management_group_id:'group-source',
      origin_thesis_id:'thesis-source', origin_strategy_id:3, origin_signal_id:801,
      strategy_version:1, strategy_scope:'platform', management_group_id:'group-source', thesis_id:'thesis-source',
      ...overrides,
    })
    const duplicate = row({ delivery_id:11, outcome_id:803, outcome_delivery_id:11, delivery_order_intent_id:902,
      intent_id:902, outcome_order_intent_id:902, delivery_user_id:29, intent_user_id:29, user_id:29,
      trading_account_id:4, intent_trading_account_id:4, pending_ticket:'O-803' })
    queryAll.mockResolvedValueOnce([row(), duplicate, { ...duplicate, outcome_id:804 }])
    const targets = await resolvePositionManagementExecutionTargets({
      context:{ pending_groups:[group], position_groups:[],
        _targets:new Map([['group-source', [{ outcome_id:801, user_id:1 }]]]),
        _executionLineage:{ strategy_scope:'platform', source_user_ids:[1] } },
      groupId:'group-source', section:'pending', action:'cancel',
    })
    expect(targets).toEqual([expect.objectContaining({ outcome_id:802, user_id:28,
      pending_ticket:'O-802', strategy_id:3 })])
    expect(queryAll.mock.calls.at(-1)?.[0]).toContain('outcomes.strategy_id AS strategy_id')
    expect(queryAll.mock.calls.at(-1)?.[0]).toContain(
      'ON outcomes.delivery_id = d.id AND outcomes.order_intent_id = d.order_intent_id',
    )
    expect(queryAll.mock.calls.at(-1)?.[0]).not.toContain('outcomes.delivery_id IS NULL')
  })

  it('skips an invalid platform source target without blocking a valid subscriber cancellation', async () => {
    const group = {
      ...context.pending_groups[0], strategy_id:3, strategy_version:1, strategy_scope:'platform',
      standard_symbol:'XAUUSD', thesis_id:'thesis-source', original_signal_id:801,
      management_group_id:'group-source',
    }
    const invalidSource = {
      user_id:1, trading_account_id:1, outcome_id:801, pending_ticket:'O-801', position_id:null,
      original_symbol:'XAUUSD', standard_symbol:'XAUUSD', system_magic:234000,
      effective_pending_state:'pending', management_group_id:'group-source', thesis_id:'thesis-source',
      strategy_id:NaN, strategy_version:1, origin_signal_id:801,
    }
    const subscriber = {
      delivery_id:10, delivery_signal_id:801, delivery_user_id:28, delivery_strategy_id:3,
      delivery_symbol:'XAUUSD.s', delivery_order_intent_id:901,
      delivery_pending_ticket:'O-802', delivery_pending_state:'pending',
      intent_id:901, intent_user_id:28, intent_trading_account_id:3, intent_status:'succeeded',
      outcome_id:802, outcome_delivery_id:10, outcome_order_intent_id:901, user_id:28,
      trading_account_id:3, ownership_history_id:44, broker_server_key:'BROKER-DEMO', login_account:'7788',
      original_symbol:'XAUUSD.s', symbol:'XAUUSD.s', pending_ticket:'O-802', position_id:null,
      entry_direction:'buy', system_magic:234000, attribution_status:'pending', outcome_status:'open',
      effective_pending_state:'pending', origin_management_group_id:'group-source',
      origin_thesis_id:'thesis-source', origin_strategy_id:3, origin_signal_id:801,
      strategy_version:1, strategy_scope:'platform', management_group_id:'group-source', thesis_id:'thesis-source',
    }
    queryOne.mockResolvedValueOnce({ maximum_mode:'auto_exit', ai_pending_cancel_enabled:1 })
    queryAll.mockResolvedValueOnce([subscriber]).mockResolvedValueOnce([])
    queryRun.mockResolvedValueOnce({ insertId:303, changes:1 })
      .mockResolvedValueOnce({ changes:1 })

    const result = await persistPositionManagementEvaluations({ signalId:812,
      context:{ ...context, pending_groups:[group], _targets:new Map([['group-source', [invalidSource]]]),
        _executionLineage:{ strategy_scope:'platform', source_user_ids:[1], source_outcome_ids:[801] } },
      inferenceSource:'automatic_scheduler', management:{ position_evaluations:[], pending_evaluations:[{
        ...response().pending_evaluations[0], management_group_id:'group-source',
      }] } })

    expect(result).toEqual([expect.objectContaining({ outcome_id:802 })])
    const taskInserts = queryRun.mock.calls.filter(call =>
      String(call[0]).includes('INSERT IGNORE INTO ai_position_management_tasks'))
    expect(taskInserts).toHaveLength(1)
    expect(taskInserts[0][1][3]).toBe(28)
    expect(taskInserts[0][1][11]).toBe(3)
    expect(taskInserts[0][1].some(value => typeof value === 'number' && Number.isNaN(value))).toBe(false)
  })

  it('keeps private mixed-lifecycle targets separated by management task type', async () => {
    const group = { management_group_id:'private-mixed', original_signal_id:901 }
    const pending = { outcome_id:1, pending_ticket:'P-1', position_id:null, effective_pending_state:'pending' }
    const position = { outcome_id:2, pending_ticket:null, position_id:'POS-2', effective_pending_state:null }
    const privateContext = {
      pending_groups:[group], position_groups:[group],
      _executionLineage:{ strategy_scope:'private' },
      _targets:new Map([['private-mixed', [pending, position]]]),
    }

    await expect(resolvePositionManagementExecutionTargets({
      context:privateContext, groupId:'private-mixed', section:'pending', action:'cancel',
    })).resolves.toEqual([pending])
    await expect(resolvePositionManagementExecutionTargets({
      context:privateContext, groupId:'private-mixed', section:'position', action:'exit',
    })).resolves.toEqual([position])
  })

  it('does not accept the retired auto-reverse mode through the settings API', async () => {
    await expect(savePositionManagementSettings(7, {
      execution_mode:'auto_reverse', auto_exit_daily_limit:1, cooldown_minutes:60,
    })).rejects.toThrow('position_management_mode_invalid')
  })

  it('does not accept the retired shadow mode through the settings API', async () => {
    await expect(savePositionManagementSettings(7, { execution_mode:'shadow' }))
      .rejects.toThrow('position_management_mode_invalid')
  })

  it('allows recovery transitions but never leaves a terminal state', () => {
    expect(canTransitionPositionManagement('EVIDENCE_CONFIRMED', 'HELD')).toBe(true)
    expect(canTransitionPositionManagement('CLOSE_UNCERTAIN', 'CLOSE_RECONCILING')).toBe(true)
    expect(canTransitionPositionManagement('PENDING_FILLED_DURING_CANCEL', 'MANUAL_REVIEW')).toBe(true)
    expect(canTransitionPositionManagement('EVIDENCE_CONFIRMED', 'PRECONDITIONS_LOCKED')).toBe(false)
    expect(canTransitionPositionManagement('PRECONDITIONS_LOCKED', 'CLOSE_INTENT_CREATED')).toBe(false)
    expect(canTransitionPositionManagement('HELD', 'PRECONDITIONS_LOCKED')).toBe(false)
    expect(canTransitionPositionManagement('COMPLETED', 'REENTRY_SENT')).toBe(false)
  })

  it('distinguishes missing, invalid and valid real stop loss protection', () => {
    expect(positionProtectionStatus({ type:'buy', price_current:100, sl:0, magic:234000 }).status).toBe('missing_stop_loss')
    expect(positionProtectionStatus({ type:'buy', price_current:100, sl:101, magic:234000 }).status).toBe('invalid_stop_loss_direction')
    expect(positionProtectionStatus({ type:'sell', price_current:100, sl:105, tp:90, magic:234000 })).toMatchObject({
      status:'protected', actualStopLoss:105, actualTakeProfit:90, systemOwned:true,
    })
  })

  it('freezes immutable thesis and condition ids when an executable signal is saved', async () => {
    const run = vi.fn(async sql => sql.startsWith('INSERT') ? [{ insertId:1, affectedRows:1 }, []] : [{ affectedRows:1 }, []])
    const thesis = await createTradeThesisTx(run, {
      signalId:9, strategyId:3, strategyVersion:2, strategyScope:'private', ownerUserId:5,
      signal:{ signal_type:'buy', entry_method:'market', symbol:'XAUUSD.s', stop_loss_price:2300,
        invalidation_condition:'M15 连续收盘跌破关键支撑', reasoning:'趋势延续入场' },
      market:{ symbol:'XAUUSD.s', timestamp:'2026-07-23T12:00:00Z' },
      decisionTimeframe:'M15', modelName:'deepseek-chat',
    })
    expect(thesis.thesisId).toMatch(/^thesis_[a-f0-9]{32}$/)
    expect(thesis.managementGroupId).toMatch(/^group_[a-f0-9]{32}$/)
    expect(thesis.conditions).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind:'hard', type:'protective_stop', immutable:true }),
      expect.objectContaining({ kind:'soft', type:'model_evidence', immutable:true }),
    ]))
    expect(run.mock.calls.some(call => String(call[0]).startsWith('UPDATE ai_signals'))).toBe(true)
  })

  it('declares the required durable tables and Bridge-side operation safeguards', () => {
    const migrations = readFileSync(new URL('../../server/migrations.js', import.meta.url), 'utf8')
    const positionManagement = readFileSync(new URL('../../server/routes/ai/position-management.js', import.meta.url), 'utf8')
    const bridgeAdapter = readFileSync(new URL('../../server/bridge-v3/business-adapter.js', import.meta.url), 'utf8')
    const bridgeLedger = readFileSync(new URL('../../bridge/native/crates/bridge-store/src/lib.rs', import.meta.url), 'utf8')
    for (const table of ['ai_trade_theses', 'ai_position_management_tasks', 'ai_position_management_evaluations',
      'ai_position_management_commands', 'ai_position_management_events']) {
      expect(migrations).toContain(`CREATE TABLE IF NOT EXISTS ${table}`)
    }
    expect(migrations).toContain('UNIQUE KEY uk_position_management_operation (operation_id)')
    expect(migrations).toContain("129_remove_position_management_shadow_mode")
    expect(migrations).toContain("130_default_automatic_close_enabled")
    expect(migrations).toContain("131_independent_ai_pending_order_controls")
    expect(migrations).toContain("147_position_management_inference_confirmations")
    expect(migrations).toContain("148_single_inference_pending_cancel")
    expect(migrations).toContain("155_repair_pending_position_identity")
    expect(migrations).toContain("156_normalize_zero_deal_pending_identity")
    expect(migrations).toContain('confirmation_count TINYINT NOT NULL DEFAULT 0')
    expect(migrations).toContain("inference_source VARCHAR(32) NOT NULL DEFAULT 'automatic_scheduler'")
    expect(positionManagement).toContain("inferenceSource = 'manual_analysis'")
    expect(positionManagement).toContain("inferenceSource !== 'automatic_scheduler'")
    expect(migrations).toContain('ai_pending_order_enabled')
    expect(migrations).toContain('ai_pending_cancel_enabled')
    expect(migrations).toContain("MODIFY execution_mode VARCHAR(20) NOT NULL DEFAULT 'auto_exit'")
    expect(positionManagement).toContain("if (mode === 'display') continue")
    expect(positionManagement).not.toContain('fallback.pending_ticket')
    expect(positionManagement).not.toContain('fallback.trade_ticket')
    expect(positionManagement).not.toContain('server_hard_condition')
    expect(bridgeAdapter).toContain('params.operation_id')
    expect(bridgeAdapter).toContain('managementPreconditionError')
    expect(bridgeLedger).toContain('ON CONFLICT(command_id) DO NOTHING')
  })

  it('keeps each inference effect stable while exposing the task current status', () => {
    const management = {
      position_evaluations:[{
        management_group_id:'position_group_01', thesis_id:'thesis_01', action:'exit', reason:'失效',
      }],
    }
    const first = buildSignalManagementActions({ signalId:101, management,
      evaluations:[{ id:11, decision_signal_id:101, outcome_id:4, management_group_id:'position_group_01',
        thesis_id:'thesis_01', action:'exit', validation_status:'valid', consecutive_exit_count:1 }],
      tasks:[{ id:55, task_type:'position_exit', status:'CLOSE_CONFIRMED', outcome_id:4,
        management_group_id:'position_group_01', target_position_id:'POS-1',
        evidence_validation_json:JSON.stringify({ status:'confirmed', evaluation_ids:[11,12] }) }],
    })
    expect(first[0]).toMatchObject({ inference_effect:'first_confirmation', confirmation_count:1,
      required_confirmations:2, task_id:55, task_status:'CLOSE_CONFIRMED', target_ticket:'POS-1' })

    const second = buildSignalManagementActions({ signalId:102, management,
      evaluations:[{ id:12, decision_signal_id:102, outcome_id:4, management_group_id:'position_group_01',
        thesis_id:'thesis_01', action:'exit', validation_status:'valid', consecutive_exit_count:2 }],
      tasks:[{ id:55, task_type:'position_exit', status:'CLOSE_CONFIRMED', outcome_id:4,
        management_group_id:'position_group_01', target_position_id:'POS-1',
        evidence_validation_json:JSON.stringify({ status:'confirmed', evaluation_ids:[11,12] }) }],
    })
    expect(second[0]).toMatchObject({ inference_effect:'confirmation_completed', confirmation_count:2,
      task_status:'CLOSE_CONFIRMED' })
  })

  it('renders a hold or invalid result only when it actually resets a candidate', () => {
    const management = { position_evaluations:[{
      management_group_id:'position_group_01', thesis_id:'thesis_01', action:'hold', reason:'继续持有',
    }] }
    const reset = buildSignalManagementActions({ signalId:103, management,
      evaluations:[{ id:13, decision_signal_id:103, outcome_id:4, management_group_id:'position_group_01',
        thesis_id:'thesis_01', action:'hold', validation_status:'valid', consecutive_exit_count:0 }],
      tasks:[{ id:56, task_type:'position_exit', status:'HELD', outcome_id:4,
        management_group_id:'position_group_01', target_position_id:'POS-1',
        evidence_validation_json:JSON.stringify({ status:'reset', reset_evaluation_id:13, reset_decision_signal_id:103 }) }],
    })
    expect(reset[0]).toMatchObject({ action:'hold', inference_effect:'confirmation_reset', confirmation_count:0,
      task_status:'HELD' })

    const ordinaryHold = buildSignalManagementActions({ signalId:104, management,
      evaluations:[{ id:14, decision_signal_id:104, outcome_id:4, management_group_id:'position_group_01',
        thesis_id:'thesis_01', action:'hold', validation_status:'valid', consecutive_exit_count:0 }], tasks:[] })
    expect(ordinaryHold).toEqual([])

    const invalidReset = buildSignalManagementActions({ signalId:105, management,
      evaluations:[{ id:15, decision_signal_id:105, outcome_id:4, management_group_id:'position_group_01',
        thesis_id:'thesis_01', action:'hold', validation_status:'invalid', consecutive_exit_count:0 }],
      tasks:[{ id:57, task_type:'position_exit', status:'HELD', outcome_id:4,
        management_group_id:'position_group_01', target_position_id:'POS-1',
        evidence_validation_json:JSON.stringify({ status:'reset', reset_evaluation_id:15, reset_decision_signal_id:105 }) }],
    })
    expect(invalidReset[0]).toMatchObject({ inference_effect:'invalid_reset', confirmation_count:0,
      task_id:57, task_status:'HELD' })
  })

  it('does not attach another inference task and keeps every directly affected target', () => {
    const positionManagementDecision = { position_evaluations:[{
      management_group_id:'position_group_01', thesis_id:'thesis_01', action:'exit', reason:'失效',
    }] }
    const unrelated = buildSignalManagementActions({ signalId:106, management:positionManagementDecision,
      evaluations:[{ id:16, decision_signal_id:106, outcome_id:4, management_group_id:'position_group_01',
        thesis_id:'thesis_01', action:'exit', validation_status:'valid', consecutive_exit_count:0 }],
      tasks:[{ id:58, task_type:'position_exit', status:'COMPLETED', outcome_id:4,
        management_group_id:'position_group_01', decision_signal_id:99, target_position_id:'POS-OLD',
        evidence_validation_json:JSON.stringify({ evaluation_ids:[9], decision_signal_ids:[99] }) }],
    })
    expect(unrelated[0]).toMatchObject({ inference_effect:'display_only', task_id:null,
      task_status:null, target_ticket:null })

    const pendingManagementDecision = { pending_evaluations:[{
      management_group_id:'pending_group_01', action:'cancel', reason:'挂单条件失效',
    }] }
    const multiple = buildSignalManagementActions({ signalId:107, management:pendingManagementDecision,
      tasks:[
        { id:59, task_type:'pending_cancel', status:'EVIDENCE_CONFIRMED', outcome_id:5,
          management_group_id:'pending_group_01', decision_signal_id:107, target_pending_ticket:'P-1' },
        { id:60, task_type:'pending_cancel', status:'EVIDENCE_CONFIRMED', outcome_id:6,
          management_group_id:'pending_group_01', decision_signal_id:107, target_pending_ticket:'P-2' },
      ],
    })
    expect(multiple).toHaveLength(2)
    expect(multiple.map(item => item.target_ticket)).toEqual(['P-1', 'P-2'])
  })

  it('keeps pending cancellation display-only when no task exists and scopes enrichment by user', async () => {
    expect(await loadSignalManagementActions(7, 105, { management:null })).toEqual([])
    expect(queryAll).toHaveBeenCalled()
    expect(queryAll.mock.calls[1][0]).toContain("'position_guard'")

    const management = { pending_evaluations:[{
      management_group_id:'pending_group_01', action:'cancel', reason:'挂单条件失效',
    }] }
    const displayOnly = buildSignalManagementActions({ signalId:105, management, fallback:{ pending_ticket:'P-1', trade_ticket:'T-1' } })
    expect(displayOnly[0]).toMatchObject({ action_type:'pending_cancel', inference_effect:'display_only',
      confirmation_count:1, required_confirmations:1, target_ticket:null, task_id:null })

    queryAll.mockResolvedValueOnce([]).mockResolvedValueOnce([])
    await loadSignalManagementActions(7, 105, { management })
    expect(queryAll.mock.calls[0][0]).toContain('WHERE user_id = ? AND decision_signal_id = ?')
    expect(queryAll.mock.calls[0][1]).toEqual([7, 105])
    expect(queryAll.mock.calls[1][0]).toContain('tasks.user_id = ?')
    expect(queryAll.mock.calls[1][1][0]).toBe(7)
  })

  it('maps tickets from the exact outcomes already validated for this decision inference', async () => {
    const management = { position_evaluations:[{
      management_group_id:'platform-position-group', thesis_id:'platform-thesis',
      action:'exit', reason:'观摩源方向失效',
    }] }
    queryAll
      .mockResolvedValueOnce([{
        id:21, user_id:28, decision_signal_id:123, outcome_id:900,
        management_group_id:'platform-position-group', thesis_id:'platform-thesis',
        action:'exit', validation_status:'valid', consecutive_exit_count:1,
      }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        outcome_id:900, user_id:28, trading_account_id:9, position_id:'POS-900',
        pending_ticket:null, delivery_id:77,
        login_account:'SUB-900', outcome_status:'open', attribution_status:'matched',
        system_magic:234000,
        user_nickname:'订阅用户', user_email:'subscriber@example.com',
      }])

    const actions = await loadSignalManagementActions(7, 123, { management, admin:true })
    expect(actions).toHaveLength(1)
    expect(actions[0]).toMatchObject({
      target_role:'subscriber', target_ticket:'POS-900', target_outcome_id:900,
      mapping_status:'mapped', account_label:'SUB-900',
    })

    const mappingSql = queryAll.mock.calls[2][0]
    expect(mappingSql).toContain('WHERE outcomes.id IN (?)')
    expect(queryAll.mock.calls[2][1]).toEqual([900])
    expect(mappingSql).not.toContain('outcomes.signal_id = ?')
  })

  it('projects deterministic PivotGuard evidence and the minimum-volume full-exit fallback', () => {
    const task = {
      id:315, decision_source:'pivot_guard', candidate_action:'full_exit', trigger_code:'pivot_take_profit',
      standard_symbol:'XAUUSD', original_symbol:'XAUUSD', target_position_id:'100315',
      broker_server_key:'private-route', login_account:'private-login',
      deterministic_evidence_json:JSON.stringify({
        profile:{ version_id:11, version_no:1 },
        position:{ ticket:'100315', symbol:'XAUUSD', direction:'buy', volume:0.01, price_open:4645.34, sl:4629, tp:4660 },
        quote:{ bid:4652.52, ask:4652.62 },
        params:{ pivot_method:'fibonacci', pivot_take_profit:{ tolerance_price:3, close_percent:50 } },
        d1:{ high:4696.65, low:4605.37, close:4658.71 },
        action:{ type:'full_exit', trigger_code:'pivot_take_profit', target_level:4653.58,
          close_percent:100, close_volume:0.01, close_price:4652.52, fallback_code:'partial_volume_below_minimum' },
      }),
    }
    const review = buildPositionGuardReview(task, { commands:[{
      id:1, task_id:315, command_type:'close_system_position', send_status:'acknowledged',
      reconciliation_status:'confirmed', bridge_result_json:JSON.stringify({ status:'success', retcode:10009, price:4652.62 }),
      created_at:'2026-08-25 09:50:38', updated_at:'2026-08-25 09:50:41', reconciled_at:'2026-08-25 09:50:53',
    }] })
    expect(review).toMatchObject({
      rule:{ code:'pivot_take_profit', label:'P点止盈' },
      action:{ code:'full_exit', label:'完整平仓' },
      position:{ symbol:'XAUUSD', direction:'buy', volume:0.01, open_price:4645.34, stop_loss:4629, take_profit:4660 },
      profile:{ version_no:1, pivot_method:'fibonacci' },
      trigger:{ target_price:4653.58, tolerance_price:3, trigger_line:4650.58, live_price:4652.52, bid:4652.52, ask:4652.62, comparison_operator:'>=', comparison_hit:true },
      plan:{ configured_percent:50, planned_volume:0.005, actual_percent:100, actual_volume:0.01, fallback_code:'partial_volume_below_minimum' },
      d1:{ high:4696.65, low:4605.37, close:4658.71 },
      mt5:{ send_status:'acknowledged', reconciliation_status:'confirmed', retcode:10009, fill_price:4652.62 },
    })
    expect(review.conclusion).toContain('已改为完整平仓')
  })

  it('does not expose route, login, or raw deterministic evidence to ordinary users', () => {
    const task = {
      id:1, decision_source:'pivot_guard', candidate_action:'full_exit', trigger_code:'break_stop',
      broker_server_key:'private-route', login_account:'private-login', ownership_history_id:8,
      bridge_generation:9, model_evaluation_json:'{"route":{"login":"private-login"}}',
      deterministic_evidence_json:'{"route":{"login":"private-login"}}',
      position_guard_state_id:3, standard_symbol:'XAUUSD', original_symbol:'XAUUSD', target_position_id:'42',
    }
    const safe = redactPositionGuardTaskForUser(task, false)
    expect(safe).not.toHaveProperty('deterministic_evidence_json')
    expect(safe).not.toHaveProperty('broker_server_key')
    expect(safe).not.toHaveProperty('login_account')
    expect(safe).not.toHaveProperty('ownership_history_id')
    expect(safe).not.toHaveProperty('bridge_generation')
    expect(safe).not.toHaveProperty('model_evaluation_json')
    expect(safe.position_guard_review).toBeTypeOf('object')
  })

  it('returns only a Chinese command summary for ordinary PivotGuard users', () => {
    const safe = redactPositionGuardCommandForUser({
      id:9, task_id:315, command_sequence:1, operation_id:'private-operation',
      command_type:'close_system_position', send_status:'acknowledged',
      expected_state_json:'{"broker_server_key":"private-route","login_account":"private-login"}',
      request_json:'{"ticket":"100315","volume":0.01}',
      bridge_command_id:'private-bridge-command',
      bridge_result_json:'{"status":"success","retcode":10009,"price":4652.62}',
      reconciliation_status:'confirmed', reconciled_at:'2026-08-25 09:50:53',
    })
    expect(safe).toMatchObject({ command_label:'平仓指令', send_label:'已收到平台确认',
      reconciliation_label:'持仓结果已确认', retcode:10009, fill_price:4652.62 })
    expect(safe).not.toHaveProperty('operation_id')
    expect(safe).not.toHaveProperty('expected_state_json')
    expect(safe).not.toHaveProperty('request_json')
    expect(safe).not.toHaveProperty('bridge_command_id')
    expect(safe).not.toHaveProperty('bridge_result_json')
  })

  it('removes raw event details from the ordinary-user PivotGuard timeline', () => {
    const safe = redactPositionGuardEventForUser({
      id:12, task_id:315, from_status:'GUARD_SENT', to_status:'COMPLETED',
      event_type:'position_guard_action_confirmed', summary:'MT5 已确认 PivotGuard 动作结果',
      details_json:'{"target":{"login":"private-login"},"operation_id":"private-operation"}',
      actor_type:'worker', created_at:'2026-08-25 09:50:53',
    })
    expect(safe).toMatchObject({ id:12, task_id:315, to_status:'COMPLETED',
      event_type:'position_guard_action_confirmed', actor_type:'worker' })
    expect(safe).not.toHaveProperty('details_json')
  })

  it('links a deterministic PivotGuard task back to the originating signal management view', () => {
    const actions = buildSignalManagementActions({
      signalId:55,
      management:null,
      tasks:[{
        id:315, task_type:'position_guard', candidate_action:'full_exit', trigger_code:'pivot_take_profit',
        status:'COMPLETED', origin_signal_id:55, decision_signal_id:55,
        management_group_id:'guard-group', outcome_id:901, target_position_id:'100315',
        position_guard_review:{ action_code:'full_exit', conclusion:'P点止盈已触发，系统完整平仓。' },
      }],
    })
    expect(actions).toHaveLength(1)
    expect(actions[0]).toMatchObject({
      action_type:'position_guard', task_type:'position_guard', action:'full_exit',
      task_id:315, target_ticket:'100315', position_guard_trigger_code:'pivot_take_profit',
      reason:'P点止盈已触发，系统完整平仓。', inference_effect:'deterministic_action',
    })
  })
})
