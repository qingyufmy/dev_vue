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
  buildPositionManagementAsOf,
  buildPositionManagementOutputFormat,
  buildSignalManagementActions,
  canTransitionPositionManagement,
  claimPositionManagementLease,
  createTradeThesisTx,
  getPositionManagementSettings,
  isActivePositionManagementOutcome,
  loadActivePositionManagementContext,
  loadSignalManagementActions,
  positionProtectionStatus,
  persistPositionManagementEvaluations,
  resolveAutomaticExitConfirmation,
  resolvePositionManagementTaskMode,
  savePositionManagementSettings,
  targetMatchesPositionManagementTask,
  validatePositionManagementResponse,
} from '../../server/routes/ai/position-management.js'
import { queryAll, queryOne, queryRun } from '../../server/db.js'

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
    management_group_id:'pending_group_01',
    allowed_evidence_refs:['bar:M15:1784736900000', 'snapshot:snapshot'],
  }],
  position_groups:[{
    management_group_id:'position_group_01', thesis_id:'thesis_01',
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
      management_group_id:'pending_group_01', action:'cancel', reason:'原挂单结构已经失效',
      cancel_reason_code:'model_judgment',
      evidence_refs:['bar:M15:1784736900000'],
    }],
    position_evaluations:[{
      management_group_id:'position_group_01', thesis_id:'thesis_01', action:'exit',
      exit_reason_code:'current_thesis_invalidated', reversal_candidate:true,
      reason:'原交易论点已经连续失效', evidence_refs:['bar:M15:1784736900000'],
    }],
    analysis:'当前行情已经转为空头结构。',
    reasoning:'新仓、挂单与持仓分别完成独立判断。',
    ...overrides,
  }
}

describe('position management v1.3 current-state contract', () => {
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
      expect.objectContaining({ action:'exit', exit_reason_code:'current_thesis_invalidated' }),
    ])
  })

  it('does not use the original condition id as a runtime exit gate', () => {
    const value = response({
      position_evaluations:[{
        management_group_id:'position_group_01', thesis_id:'thesis_01', action:'exit',
        exit_reason_code:'trend_reversal', matched_condition_id:'invented_condition', reversal_candidate:false,
        reason:'尝试改写条件', evidence_refs:['bar:M15:1784736900000'],
      }],
    })
    const result = validatePositionManagementResponse(value, context, plan => ({ ...plan, confidence:0.8 }))
    expect(result.signal_type).toBe('sell')
    expect(result._position_management.position_evaluations).toEqual([
      expect.objectContaining({ action:'exit', exit_reason_code:'trend_reversal' }),
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
        ...response().pending_evaluations[0], action:'keep', cancel_reason_code:null,
        reason:'原挂单继续保留', evidence_refs:['condition:not-allowed'],
      }],
      position_evaluations:[{
        ...response().position_evaluations[0], action:'hold', exit_reason_code:null,
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
        ...response().pending_evaluations[0], action:'keep', cancel_reason_code:null,
      }],
      position_evaluations:[{
        ...response().position_evaluations[0], action:'hold', exit_reason_code:null,
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
        ...response().pending_evaluations[0], action:'keep', cancel_reason_code:null,
        evidence_refs:['condition:not-allowed'],
      }],
      position_evaluations:[{
        ...response().position_evaluations[0], action:'hold', exit_reason_code:null,
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

  it('requires server-confirmed expiry for an expired cancellation reason', () => {
    const value = response({ pending_evaluations:[{
      ...response().pending_evaluations[0], cancel_reason_code:'expired',
    }] })
    const notExpiredContext = { ...context, pending_groups:[{
      ...context.pending_groups[0], pending_order_facts:[{ is_expired:false, valid_until_utc_msc:1784748720000 }],
    }] }
    const result = validatePositionManagementResponse(value, notExpiredContext,
      plan => ({ ...plan, confidence:0.8 }))
    expect(result._position_management.pending_evaluations[0]).toMatchObject({
      action:'keep', validation_source:'server_fail_closed', cancel_reason_code:null,
    })
    expect(result._position_management.validation.errors).toContainEqual(
      expect.objectContaining({ code:'pending_expired_evidence_required' }),
    )
    const expiredContext = { ...notExpiredContext, pending_groups:[{
      ...notExpiredContext.pending_groups[0], pending_order_facts:[{ is_expired:true }],
    }] }
    expect(validatePositionManagementResponse(value, expiredContext,
      plan => ({ ...plan, confidence:0.8 }))._position_management.pending_evaluations[0])
      .toMatchObject({ action:'cancel', cancel_reason_code:'expired' })
  })

  it('allows a current thesis cancellation without a frozen-condition trigger', () => {
    const value = response({ pending_evaluations:[{
      ...response().pending_evaluations[0], cancel_reason_code:'thesis_invalidated',
      evidence_refs:['bar:M15:1784736900000'],
    }] })
    const pendingGroup = {
      ...context.pending_groups[0],
      allowed_evidence_refs:['bar:M15:1784736900000'],
    }
    const valid = validatePositionManagementResponse(value,
      { ...context, pending_groups:[pendingGroup] }, plan => ({ ...plan, confidence:0.8 }))
    expect(valid._position_management.validation.errors).toEqual([])
    expect(valid._position_management.pending_evaluations[0])
      .toMatchObject({ action:'cancel', cancel_reason_code:'thesis_invalidated' })
  })

  it.each(['expired', 'thesis_invalidated', 'risk_reduction', 'model_judgment'])
    ('allows %s based on current evidence without frozen-condition evaluation', cancelReasonCode => {
      const value = response({ pending_evaluations:[{
        ...response().pending_evaluations[0], cancel_reason_code:cancelReasonCode,
        reason:'风险依据', evidence_refs:['bar:M15:1784736900000'],
      }] })
      const pendingGroup = {
        ...context.pending_groups[0], allowed_evidence_refs:['bar:M15:1784736900000'],
        pending_order_facts:[{ is_expired:true }],
      }
      const result = validatePositionManagementResponse(value,
        { ...context, pending_groups:[pendingGroup] }, plan => ({ ...plan, confidence:0.8 }))
      expect(result._position_management.pending_evaluations[0]).toMatchObject({
        action:'cancel', cancel_reason_code:cancelReasonCode,
      })
    })

  it.each(['thesis_invalidated', 'risk_reduction', 'model_judgment'])
    ('does not let %s disguise an expiry claim', cancelReasonCode => {
      const value = response({ pending_evaluations:[{
        ...response().pending_evaluations[0], cancel_reason_code:cancelReasonCode,
        reason:'该挂单已过期，应该撤销', evidence_refs:['bar:M15:1784736900000'],
      }] })
      const result = validatePositionManagementResponse(value, context,
        plan => ({ ...plan, confidence:0.8 }))
      expect(result._position_management.validation.errors).toContainEqual(
        expect.objectContaining({ code:'pending_expiry_reason_code_mismatch' }),
      )
      expect(result._position_management.pending_evaluations[0]).toMatchObject({
        action:'keep', validation_source:'server_fail_closed', cancel_reason_code:null,
      })
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
    expect(schema).not.toContain('matched_condition_id')
    expect(schema).not.toContain('cancel_replace')
    expect(schema).not.toContain('"reverse"')
  })
})

describe('consecutive automatic-inference exit confirmation', () => {
  it('requires two distinct v1.3 inferences and current snapshots', () => {
    expect(AUTO_EXIT_CONFIRMATIONS_REQUIRED).toBe(2)
    expect(resolveAutomaticExitConfirmation({ action:'exit', decision_signal_id:101,
      market_snapshot_hash:'sha256:snapshot-a', contract_version:POSITION_MANAGEMENT_CONTRACT_VERSION }, null))
      .toMatchObject({ validation_status:'valid', confirmation_count:1 })
    expect(resolveAutomaticExitConfirmation({ action:'exit', decision_signal_id:102,
      market_snapshot_hash:'sha256:snapshot-b', contract_version:POSITION_MANAGEMENT_CONTRACT_VERSION }, {
      action:'exit', validation_status:'valid', decision_signal_id:101,
      market_snapshot_hash:'sha256:snapshot-a', contract_version:POSITION_MANAGEMENT_CONTRACT_VERSION,
    })).toMatchObject({ validation_status:'valid', confirmation_count:2 })
  })

  it('does not increment when the task or snapshot is reused', () => {
    const current = { action:'exit', decision_signal_id:102, task_id:7,
      market_snapshot_hash:'sha256:snapshot-a', contract_version:POSITION_MANAGEMENT_CONTRACT_VERSION }
    const previous = { action:'exit', validation_status:'valid', decision_signal_id:101, task_id:7,
      market_snapshot_hash:'sha256:snapshot-a', contract_version:POSITION_MANAGEMENT_CONTRACT_VERSION }
    expect(resolveAutomaticExitConfirmation(current, previous)).toMatchObject({
      validation_status:'valid', confirmation_count:1,
    })
  })

  it('does not combine a legacy or unknown previous contract with v1.3', () => {
    expect(resolveAutomaticExitConfirmation({ action:'exit', decision_signal_id:102,
      market_snapshot_hash:'sha256:snapshot-b', contract_version:POSITION_MANAGEMENT_CONTRACT_VERSION }, {
      action:'exit', validation_status:'valid', decision_signal_id:101,
      market_snapshot_hash:'sha256:snapshot-a', contract_version:'position-management-v1.2',
    })).toMatchObject({ validation_status:'valid', confirmation_count:1, reset_reason:'contract_not_compatible' })
    expect(resolveAutomaticExitConfirmation({ action:'exit', decision_signal_id:103,
      market_snapshot_hash:'sha256:snapshot-c', contract_version:POSITION_MANAGEMENT_CONTRACT_VERSION }, {
      action:'exit', validation_status:'valid', decision_signal_id:102,
      market_snapshot_hash:'sha256:snapshot-b',
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

  it('promotes the same task after a second consecutive valid exit', async () => {
    queryOne.mockResolvedValueOnce({ maximum_mode:'auto_exit', ai_pending_cancel_enabled:1 })
      .mockResolvedValueOnce({ id:11, decision_signal_id:101, action:'exit', validation_status:'valid',
        market_snapshot_hash:'snapshot-a', closed_bar_time_utc_ms:1784736900000,
        model_evaluation_json:JSON.stringify({ contract_version:POSITION_MANAGEMENT_CONTRACT_VERSION }) })
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
      _targets:new Map([['position_group_01', [target]]]) }
    const result = await persistPositionManagementEvaluations({ signalId:102, context:localContext,
      inferenceSource:'automatic_scheduler', management:{
      position_evaluations:[response().position_evaluations[0]], pending_evaluations:[],
    } })
    expect(result).toEqual([expect.objectContaining({ status:'EVIDENCE_CONFIRMED', confirmation_count:2 })])
    expect(queryRun.mock.calls.some(call => String(call[0]).includes("status = 'EVIDENCE_CONFIRMED'"))).toBe(true)
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

  it('uses the terminal reference portfolio to remove stale positions and recover legacy pending aliases', async () => {
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
  })

  it('injects terminal expiry facts but keeps original conditions out of active context', async () => {
    queryAll.mockResolvedValueOnce([{
      outcome_id:9305, pending_ticket:'O-9305', position_id:null, effective_pending_state:'pending',
      management_group_id:'group_9305', thesis_id:'thesis_9305', strategy_id:3, strategy_version:1,
      standard_symbol:'XAUUSD', direction:'buy', origin_signal_id:9305, decision_timeframe:'M15',
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
          pending_orders:[{ reference_id:'outcome:9305', valid_until_utc_msc:1784748720000,
            valid_until_utc:'2026-07-22T06:12:00.000Z', valid_until_terminal:'2026-07-22 09:12:00',
            terminal_timezone_offset_minutes:180, is_expired:false, remaining_seconds:11640 }],
        },
        strategy_context:{ timeframes:{ M15:{ summary:{ last_closed_bar:{
          time_utc_msc:1784746680000, close:3990,
        } } } } },
      },
    })
    expect(value.pending_groups[0]).toMatchObject({
      management_group_id:'group_9305',
      pending_order_facts:[expect.objectContaining({ is_expired:false, valid_until_terminal:'2026-07-22 09:12:00' })],
    })
    expect(value.pending_groups[0]).not.toHaveProperty('frozen_conditions')
    expect(value.pending_groups[0].allowed_evidence_refs).toEqual(expect.arrayContaining([
      'bar:M15:1784746680000',
      expect.stringMatching(/^snapshot:/),
      'pending:9305:terminal',
    ]))
    expect(value.pending_groups[0].allowed_evidence_refs).not.toContain('condition:hard_9305')
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
    expect(queryAll).not.toHaveBeenCalled()

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
})
