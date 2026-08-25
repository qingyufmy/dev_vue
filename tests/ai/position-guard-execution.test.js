import fs from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../server/db.js', () => ({
  beijingAfter:vi.fn(() => '2026-08-25 18:01:00'),
  beijingNow:vi.fn(() => '2026-08-25 18:00:00'), parseBeijing:vi.fn(),
  queryAll:vi.fn(), queryOne:vi.fn(), queryRun:vi.fn(), withTransaction:vi.fn(),
}))
vi.mock('../../server/bridge-ws.js', () => ({
  broadcastPositionManagementTask:vi.fn(), getBridgeGeneration:vi.fn(), isBridgeAlive:vi.fn(),
}))
vi.mock('../../server/routes/ai/market-data.js', () => ({ mt5Bridge:vi.fn() }))
vi.mock('../../server/routes/ai/position-management.js', () => ({ claimPositionManagementLease:vi.fn() }))

const {
  _positionGuardExecutionInternals,
  classifyPositionGuardReconciliation,
  normalizePositionGuardPartialVolume,
  validatePositionGuardExecutionPreconditions,
} = await import('../../server/routes/ai/position-guard-execution.js')

const base = () => ({
  task:{ id:9, task_type:'position_guard', decision_source:'pivot_guard', candidate_action:'partial_exit',
    user_id:7, trading_account_id:11, ownership_history_id:13, bridge_generation:5,
    broker_server_key:'BROKER-DEMO', login_account:'12345', original_symbol:'XAUUSD.s',
    state_version:1, deterministic_evidence_json:JSON.stringify({ position:{ ticket:'100', volume:0.2 } }) },
  outcome:{ id:17, status:'open', attribution_status:'attributed', external_intervention:0,
    position_id:'100', entry_direction:'buy', system_magic:234000 },
  ownership:{ id:13, user_id:7, trading_account_id:11, broker_server_key:'BROKER-DEMO',
    login_account:'12345', ended_at:null },
  control:{ enabled:1 }, setting:{ enabled:1 }, currentGeneration:5,
  inventory:{ status:'success', account:{ server:'Broker-Demo', login:'12345', margin_mode:2, is_hedging:true },
    positions:[{ ticket:'100', symbol:'XAUUSD.s', type:'buy', magic:234000, volume:0.2, sl:2990, tp:3050 }] },
})

describe('position guard execution helpers', () => {
  it('normalizes partial volume down to the broker step and leaves the minimum remainder', () => {
    expect(normalizePositionGuardPartialVolume(0.23, 50, { volume_min:0.01, volume_step:0.01 }))
      .toEqual({ ok:true, close_volume:0.11, remaining_volume:0.12, volume_step:0.01 })
    expect(normalizePositionGuardPartialVolume(0.01, 50, { volume_min:0.01, volume_step:0.01 }))
      .toMatchObject({ ok:false, code:'position_guard_partial_volume_below_minimum' })
  })

  it('requires exact ownership, generation, attribution and live position identity', () => {
    expect(validatePositionGuardExecutionPreconditions(base())).toMatchObject({
      ok:true, action:'partial_exit', expectedState:{ ticket:'100', volume:0.2, direction:'buy', magic:234000 },
    })
    const changed = base()
    changed.inventory.positions[0].volume = 0.1
    expect(validatePositionGuardExecutionPreconditions(changed))
      .toMatchObject({ ok:false, code:'position_guard_position_volume_changed' })
    const disabled = base()
    disabled.setting.enabled = 0
    expect(validatePositionGuardExecutionPreconditions(disabled))
      .toMatchObject({ ok:false, code:'position_guard_execution_disabled' })
  })

  it('keeps an explicit MT4 hedging account hedging and blocks ambiguous netting attribution', () => {
    const mt4 = base()
    mt4.inventory.account = { server:'Broker-Demo', login:'12345', margin_mode:-1, is_hedging:true }
    expect(validatePositionGuardExecutionPreconditions(mt4))
      .toMatchObject({ ok:true, expectedState:{ margin_mode:'hedging' } })

    const netting = base()
    netting.inventory.account = { server:'Broker-Demo', login:'12345', margin_mode:0, is_hedging:false }
    netting.competingOutcomes = [{ id:18, original_symbol:'XAUUSD.s', status:'open', position_id:'100' }]
    expect(validatePositionGuardExecutionPreconditions(netting)).toMatchObject({
      ok:false,
      code:'position_guard_netting_competing_outcome_detected',
      competing_outcome_ids:[18],
    })
  })

  it('confirms only the exact partial-close remainder', () => {
    const value = base()
    const expectedState = validatePositionGuardExecutionPreconditions(value).expectedState
    const request = { volume:0.1 }
    value.inventory.positions[0].volume = 0.1
    expect(classifyPositionGuardReconciliation({ action:'partial_exit', expectedState, request,
      inventory:value.inventory })).toMatchObject({ status:'confirmed', remaining_volume:0.1 })
    value.inventory.positions[0].volume = 0.05
    expect(classifyPositionGuardReconciliation({ action:'partial_exit', expectedState, request,
      inventory:value.inventory })).toMatchObject({ status:'manual_review', code:'position_guard_partial_close_overfilled' })
  })

  it('confirms full exit only when the exact ticket is absent', () => {
    const value = base()
    const expectedState = validatePositionGuardExecutionPreconditions(value).expectedState
    value.inventory.positions = []
    expect(classifyPositionGuardReconciliation({ action:'full_exit', expectedState, request:{},
      inventory:value.inventory })).toMatchObject({ status:'confirmed', code:'position_guard_position_absent' })
  })

  it('requires exact protection and isolates an externally stricter stop', () => {
    const value = base()
    value.task.candidate_action = 'move_protection'
    const expectedState = validatePositionGuardExecutionPreconditions(value).expectedState
    value.inventory.positions[0].sl = 3001
    expect(classifyPositionGuardReconciliation({ action:'move_protection', expectedState,
      request:{ stop_loss:3001 }, inventory:value.inventory })).toMatchObject({ status:'confirmed' })
    value.inventory.positions[0].sl = 3002
    expect(classifyPositionGuardReconciliation({ action:'move_protection', expectedState,
      request:{ stop_loss:3001 }, inventory:value.inventory }))
      .toMatchObject({ status:'manual_review', code:'position_guard_protection_changed_externally' })
  })

  it('bypasses the shared cache and revalidates the trigger against a fresh live quote', async () => {
    const now = Date.now()
    const params = {
      pivot_method:'fibonacci',
      break_stop:{ enabled:false, distance_price:9, open_near_price:10 },
      pivot_cross_stop:{ enabled:true, distance_price:8, min_duration_seconds:3 },
      retrace_stop:{ enabled:false, distance_price:5 },
      pivot_take_profit:{ enabled:false, tolerance_price:3, close_percent:50, move_break_even:true },
      first_target_take_profit:{ enabled:false, tolerance_price:3, close_percent:50,
        move_break_even:true, break_even_offset_price:2 },
    }
    const evidence = {
      route:{ terminal_instance_id:'terminal-1', connection_epoch:2,
        account_ref:{ broker_server:'Broker-Demo', login:'12345' } },
      d1:{ high:110, low:90, close:100, previous_open_at:1, current_open_at:2 },
      params,
      contract:{ digits:2, point:0.01, trade_tick_size:0.01, volume_min:0.01,
        volume_step:0.01, trade_stops_level:0, trade_freeze_level:0 },
    }
    const context = {
      task:{ user_id:7, trading_account_id:11, bridge_generation:5,
        trigger_code:'pivot_cross_stop' },
      state:{ pivot_cross_since_utc_ms:now - 4_000 },
    }
    const preflight = {
      action:'full_exit', evidence,
      target:{ ticket:'100', symbol:'XAUUSD.s', type:'buy', magic:234000,
        volume:0.2, price_open:110, sl:105, tp:120 },
    }
    const liveQuote = bid => ({ status:'success', bid, ask:bid + 0.1,
      observed_at_utc_msc:now, timezone_offset_minutes:180, clock_status:'verified',
      symbol_trade_mode:4, market_state:'open' })
    const bridge = vi.fn().mockResolvedValue(liveQuote(91))
    await expect(_positionGuardExecutionInternals.revalidateLiveTrigger(context, preflight, bridge))
      .resolves.toMatchObject({ ok:true, evaluation:{ action:{ type:'full_exit', trigger_code:'pivot_cross_stop' } } })
    expect(bridge).toHaveBeenCalledWith(7, 'quote', expect.objectContaining({
      symbol:'XAUUSD.s', terminal_instance_id:'terminal-1',
    }), expect.objectContaining({ noFallback:true, timeoutMs:3000, expectedGeneration:5 }))

    bridge.mockResolvedValue(liveQuote(100))
    await expect(_positionGuardExecutionInternals.revalidateLiveTrigger(context, preflight, bridge))
      .resolves.toMatchObject({ ok:false, code:'position_guard_trigger_no_longer_active' })
  })

  it('rechecks switches, ownership, state fencing and the live trigger before a prepared command can resume', () => {
    const source = fs.readFileSync(new URL('../../server/routes/ai/position-guard-execution.js', import.meta.url), 'utf8')
    const markStart = source.indexOf('async function markSending')
    const markEnd = source.indexOf('async function saveResult', markStart)
    const markSending = source.slice(markStart, markEnd)
    expect(markSending).toContain('global_position_guard_control')
    expect(markSending).toContain('user_position_guard_settings')
    expect(markSending).toContain('mt5_account_ownership_history')
    expect(markSending).toContain('pending_task_id')

    const resumeStart = source.indexOf("if (context.task.status === 'GUARD_INTENT_CREATED')")
    const resume = source.slice(resumeStart)
    expect(resume).toContain('validatePositionGuardExecutionPreconditions')
    expect(resume).toContain('revalidateLiveTrigger')
    expect(resume.indexOf('revalidateLiveTrigger')).toBeLessThan(resume.indexOf('executePrepared(context'))
  })
})
