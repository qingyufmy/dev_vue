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
  canTransitionPositionManagement,
  claimPositionManagementLease,
  createTradeThesisTx,
  getPositionManagementSettings,
  isActivePositionManagementOutcome,
  loadActivePositionManagementContext,
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
    allowed_evidence_refs:['bar:M15:1784736900000', 'condition:pending_invalid_01'],
  }],
  position_groups:[{
    management_group_id:'position_group_01', thesis_id:'thesis_01',
    frozen_conditions:[{ condition_id:'invalidation_01', kind:'soft' }],
    allowed_evidence_refs:['bar:M15:1784736900000', 'condition:invalidation_01'],
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
      evidence_refs:['condition:pending_invalid_01'],
    }],
    position_evaluations:[{
      management_group_id:'position_group_01', thesis_id:'thesis_01', action:'exit',
      matched_condition_id:'invalidation_01', reversal_candidate:true,
      reason:'原交易论点已经连续失效', evidence_refs:['condition:invalidation_01'],
    }],
    analysis:'当前行情已经转为空头结构。',
    reasoning:'新仓、挂单与持仓分别完成独立判断。',
    ...overrides,
  }
}

describe('position management v1.1 contract', () => {
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
      expect.objectContaining({ action:'exit', matched_condition_id:'invalidation_01' }),
    ])
  })

  it('rejects invented condition ids without discarding another valid section', () => {
    const value = response({
      position_evaluations:[{
        management_group_id:'position_group_01', thesis_id:'thesis_01', action:'exit',
        matched_condition_id:'invented_condition', reversal_candidate:false,
        reason:'尝试改写条件', evidence_refs:['condition:invalidation_01'],
      }],
    })
    const result = validatePositionManagementResponse(value, context, plan => ({ ...plan, confidence:0.8 }))
    expect(result.signal_type).toBe('sell')
    expect(result._position_management.position_evaluations).toEqual([
      expect.objectContaining({ action:'hold', validation_source:'server_fail_closed' }),
    ])
    expect(result._position_management.validation.errors).toContainEqual(
      expect.objectContaining({ section:'position', code:'position_condition_invalid' }),
    )
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

  it('expires the whole response when snapshot identity changes', () => {
    expect(() => validatePositionManagementResponse(response({
      as_of:{ ...asOf, market_snapshot_hash:'sha256:other' },
    }), context, value => value)).toThrow('position_management_snapshot_mismatch')
  })

  it('does not expose direct replace or reverse actions in the model schema', () => {
    const schema = buildPositionManagementOutputFormat(JSON.stringify({
      signal_type:'buy | sell | hold', pending_action:'cancel_replace', position_action:'open',
      analysis:'中文', reasoning:'中文',
    }), context)
    const parsed = JSON.parse(schema)
    expect(parsed.market_plan.pending_action).toBeUndefined()
    expect(parsed.market_plan.position_action).toBeUndefined()
    expect(schema).not.toContain('cancel_replace')
    expect(schema).not.toContain('"reverse"')
  })
})

describe('consecutive automatic-inference exit confirmation', () => {
  it('requires two valid consecutive exit decisions and ignores condition changes', () => {
    expect(AUTO_EXIT_CONFIRMATIONS_REQUIRED).toBe(2)
    expect(resolveAutomaticExitConfirmation({ action:'exit', matched_condition_id:'condition-a' }, null))
      .toMatchObject({ validation_status:'valid', confirmation_count:1 })
    expect(resolveAutomaticExitConfirmation({ action:'exit', matched_condition_id:'condition-b' }, {
      action:'exit', validation_status:'valid', matched_condition_id:'condition-a',
    })).toMatchObject({ validation_status:'valid', confirmation_count:2 })
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
    const localContext = { ...context, _targets:new Map([['position_group_01', [target]]]) }
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
      .mockResolvedValueOnce({ id:11, decision_signal_id:101, action:'exit', validation_status:'valid' })
      .mockResolvedValueOnce({ id:21, state_version:1, status:'CANDIDATE', user_id:7,
        execution_mode:'auto_exit', task_type:'position_exit', management_group_id:'position_group_01', thesis_id:'thesis_01' })
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
    const localContext = { ...context, _targets:new Map([['position_group_01', [target]]]) }
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
        execution_mode:'auto_exit', task_type:'position_exit', management_group_id:'position_group_01', thesis_id:'thesis_01' })
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
      strategyId:3, strategyVersion:1, symbol:'XAUUSD', decisionTimeframe:'M15',
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
    expect(value._targets.get('group_pending')[0].position_id).toBeNull()
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
    const bridge = readFileSync(new URL('../../public/ai/aurum_bridge_gui.py', import.meta.url), 'utf8')
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
    expect(positionManagement).not.toContain('server_hard_condition')
    expect(bridge).toContain('operation_id')
    expect(bridge).toContain('_management_precondition_error')
    expect(bridge).toContain('idempotent_replay')
  })
})
