import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'

vi.mock('../../server/db.js', () => ({
  beijingNow:vi.fn(() => '2026-07-24 12:00:00'),
  parseBeijing:vi.fn(value => value ? new Date(String(value).replace(' ', 'T') + '+08:00') : null),
  queryAll:vi.fn(), queryOne:vi.fn(), queryRun:vi.fn(), withTransaction:vi.fn(),
}))

vi.mock('../../server/bridge-ws.js', () => ({
  getBridgeGeneration:vi.fn(() => 7),
  isBridgeAlive:vi.fn(() => true),
}))

vi.mock('../../server/routes/ai/market-data.js', () => ({ mt5Bridge:vi.fn() }))
vi.mock('../../server/routes/ai/position-management.js', () => ({
  broadcastPositionManagementTask:vi.fn(),
  claimPositionManagementLease:vi.fn(),
  createPositionManagementCommand:vi.fn(),
  transitionPositionManagementTask:vi.fn(),
}))

import {
  classifyCloseReconciliation,
  classifyPendingCancelReconciliation,
  resolveLiveMarginMode,
  resolvePositionManagementRuntimeMode,
  validateExitOnlyPreconditions,
  validatePendingCancelPreconditions,
} from '../../server/routes/ai/position-management-worker.js'

const workerSource = readFileSync(new URL('../../server/routes/ai/position-management-worker.js', import.meta.url), 'utf8')

function fixture(overrides = {}) {
  const task = {
    id:9, task_type:'position_exit', candidate_action:'exit', execution_mode:'auto_exit',
    user_id:5, trading_account_id:11, ownership_history_id:21,
    broker_server_key:'BROKER-DEMO', login_account:'7788', bridge_generation:7,
    original_symbol:'XAUUSD.s', state_version:2,
  }
  const outcome = {
    id:31, status:'open', attribution_status:'attributed', external_intervention:0,
    margin_mode:'hedging', position_id:'9001', expected_volume:0.2, entry_volume:0.2,
    closed_volume:0, entry_direction:'buy', system_magic:234000,
  }
  const ownership = {
    id:21, user_id:5, trading_account_id:11, broker_server_key:'BROKER-DEMO',
    login_account:'7788', ended_at:null,
  }
  const inventory = {
    status:'success', account:{ server:'Broker-Demo', login:7788, is_hedging:true },
    positions:[{ ticket:9001, symbol:'XAUUSD.s', type:'buy', volume:0.2,
      price_current:2400, sl:2350, tp:2500, magic:234000 }],
  }
  return {
    task, outcome, ownership, inventory, currentGeneration:7,
    control:{ maximum_mode:'auto_exit', ai_pending_cancel_enabled:1 },
    setting:{ execution_mode:'auto_exit' },
    ...overrides,
  }
}

describe('position management exit-only worker', () => {
  it('uses the task execution mode when the user has no persisted setting', () => {
    const value = fixture()
    expect(resolvePositionManagementRuntimeMode(value.task, null, value.control)).toBe('auto_exit')
    expect(resolvePositionManagementRuntimeMode(value.task, {}, value.control)).toBe('auto_exit')
    expect(resolvePositionManagementRuntimeMode(value.task, { execution_mode:'display' }, value.control)).toBe('display')
  })

  it('does not block risk-reducing operations with daily quotas or account-wide cooldowns', () => {
    expect(workerSource).not.toContain('user_daily_count')
    expect(workerSource).not.toContain('account_daily_count')
    expect(workerSource).not.toContain('auto_exit_daily_limit_reached')
    expect(workerSource).not.toContain('auto_exit_cooldown_active')
  })

  it('locks only a fully attributable hedging position with exact MT5 identity and protection', () => {
    const result = validateExitOnlyPreconditions(fixture())
    expect(result).toMatchObject({
      ok:true,
      expectedState:{ ticket:'9001', symbol:'XAUUSD.s', direction:'buy', magic:234000, volume:0.2 },
    })
    expect(result.preconditionHash).toMatch(/^[a-f0-9]{64}$/)
  })

  it.each([
    ['bridge generation changes', value => { value.currentGeneration = 8 }, 'bridge_generation_mismatch'],
    ['attribution is ambiguous', value => { value.outcome.attribution_status = 'attribution_ambiguous' }, 'position_attribution_incomplete'],
    ['position volume was changed', value => { value.inventory.positions[0].volume = 0.1 }, 'position_volume_mismatch'],
    ['real stop loss is missing', value => { value.inventory.positions[0].sl = 0 }, 'position_missing_stop_loss'],
  ])('fails closed when %s', (_label, mutate, code) => {
    const value = fixture()
    mutate(value)
    expect(validateExitOnlyPreconditions(value)).toMatchObject({ ok:false, code })
  })

  it('uses the live terminal margin mode instead of stale outcome metadata', () => {
    const value = fixture()
    value.outcome.margin_mode = 'netting'
    expect(validateExitOnlyPreconditions(value)).toMatchObject({
      ok:true,
      expectedState:{ margin_mode:'hedging' },
    })
    delete value.inventory.account.is_hedging
    delete value.inventory.account.margin_mode
    expect(validateExitOnlyPreconditions(value)).toMatchObject({
      ok:false, code:'account_margin_mode_unavailable', retryable:true,
    })
  })

  it('normalizes explicit MT4 and MT5 live margin-mode fields', () => {
    expect(resolveLiveMarginMode({ is_hedging:true, margin_mode:-1 })).toBe('hedging')
    expect(resolveLiveMarginMode({ margin_mode:2 })).toBe('hedging')
    expect(resolveLiveMarginMode({ margin_mode:0 })).toBe('netting')
    expect(resolveLiveMarginMode({ margin_mode:null })).toBeNull()
    expect(resolveLiveMarginMode({})).toBeNull()
  })

  it('allows an exact exclusive netting position but rejects competing strategy ownership', () => {
    const value = fixture()
    value.outcome.margin_mode = 'netting'
    value.inventory.account.is_hedging = false
    value.inventory.positions[0].symbol = 'XAUUSD.s'
    value.task.original_symbol = 'XAUUSD'
    expect(validateExitOnlyPreconditions(value)).toMatchObject({
      ok:true,
      expectedState:{ ticket:'9001', symbol:'XAUUSD.s', direction:'buy', volume:0.2 },
    })
    value.competingOutcomes = [{ id:32, original_symbol:'XAUUSD', position_id:'9001' }]
    expect(validateExitOnlyPreconditions(value)).toMatchObject({
      ok:false, code:'netting_competing_outcome_detected', competing_outcome_ids:[32],
    })
  })

  it.each(['XAUUSD.s', 'XAUUSD.c', 'XAUUSD'])(
    'matches the canonical symbol while preserving the live MT5 symbol %s', liveSymbol => {
      const value = fixture()
      value.outcome.margin_mode = 'netting'
      value.inventory.account.is_hedging = false
      value.inventory.positions[0].symbol = liveSymbol
      value.task.original_symbol = 'XAUUSD'
      expect(validateExitOnlyPreconditions(value)).toMatchObject({
        ok:true,
        expectedState:{ symbol:liveSymbol },
      })
    })

  it('confirms absence, isolates partial close, and never asks for an automatic resend', () => {
    const expected = JSON.stringify({ ticket:'9001', symbol:'XAUUSD.s', direction:'buy', magic:234000, volume:0.2 })
    const task = { broker_server_key:'BROKER-DEMO', login_account:'7788', expected_state_json:expected }
    expect(classifyCloseReconciliation(task, {
      status:'success', account:{ server:'BROKER-DEMO', login:7788 }, positions:[],
    })).toMatchObject({ status:'confirmed' })
    expect(classifyCloseReconciliation(task, {
      status:'success', account:{ server:'BROKER-DEMO', login:7788 },
      positions:[{ ticket:9001, symbol:'XAUUSD.s', type:'buy', magic:234000, volume:0.1 }],
    })).toMatchObject({ status:'partial', remaining_volume:0.1 })
  })

  it('locks only an exact system pending order independently from close switches', () => {
    const value = fixture()
    value.task = { ...value.task, task_type:'pending_cancel', candidate_action:'cancel' }
    value.outcome = { ...value.outcome, attribution_status:'pending', position_id:null,
      pending_ticket:'8101', expected_volume:0.2, entry_volume:0, closed_volume:0,
      margin_mode:'netting' }
    value.inventory.account.is_hedging = false
    value.inventory.positions = []
    value.inventory.pending_orders = [{ ticket:8101, symbol:'XAUUSD.s', side:'buy',
      type:'buy_limit', volume:0.2, magic:234000 }]
    expect(validatePendingCancelPreconditions(value)).toMatchObject({
      ok:true,
      expectedState:{ margin_mode:'netting', ticket:'8101', symbol:'XAUUSD.s', direction:'buy', magic:234000, volume:0.2 },
    })
    value.outcome.margin_mode = 'hedging'
    expect(validatePendingCancelPreconditions(value)).toMatchObject({ ok:true, expectedState:{ margin_mode:'netting' } })
    value.setting.execution_mode = 'display'
    value.control.maximum_mode = 'display'
    expect(validatePendingCancelPreconditions(value)).toMatchObject({ ok:true })
    value.control.ai_pending_cancel_enabled = 0
    expect(validatePendingCancelPreconditions(value)).toMatchObject({ ok:false, code:'ai_pending_cancel_disabled' })
  })

  it('accepts a legacy pending ticket alias only when no entry deal exists', () => {
    const value = fixture()
    value.task = { ...value.task, task_type:'pending_cancel', candidate_action:'cancel' }
    value.outcome = { ...value.outcome, attribution_status:'pending', position_id:'8101',
      pending_ticket:'8101', entry_deal_ticket:null, expected_volume:0.2, entry_volume:0,
      closed_volume:0, margin_mode:'netting' }
    value.inventory.account.is_hedging = false
    value.inventory.positions = []
    value.inventory.pending_orders = [{ ticket:8101, symbol:'XAUUSD.s', side:'buy',
      type:'buy_limit', volume:0.2, magic:234000 }]

    expect(validatePendingCancelPreconditions(value)).toMatchObject({ ok:true })
    value.outcome.entry_deal_ticket = '9101'
    expect(validatePendingCancelPreconditions(value)).toMatchObject({ ok:false, code:'pending_attribution_incomplete' })
  })

  it('distinguishes cancelled, filled-during-cancel and still-active pending states', () => {
    const expected = JSON.stringify({ ticket:'8101', symbol:'XAUUSD.s', direction:'buy', magic:234000, volume:0.2 })
    const task = { broker_server_key:'BROKER-DEMO', login_account:'7788', expected_state_json:expected }
    const account = { server:'BROKER-DEMO', login:7788 }
    const order = { ticket:8101, symbol:'XAUUSD.s', side:'buy', magic:234000, position_id:9901 }
    expect(classifyPendingCancelReconciliation(task, {
      status:'success', account, current_state:'history', final_state:'cancelled', order,
    })).toMatchObject({ status:'confirmed', final_state:'cancelled' })
    expect(classifyPendingCancelReconciliation(task, {
      status:'success', account, current_state:'history', final_state:'filled', position_id:9901, order,
    })).toMatchObject({ status:'filled', position_id:'9901' })
    expect(classifyPendingCancelReconciliation(task, {
      status:'success', account, current_state:'pending', final_state:null, order,
    })).toMatchObject({ status:'active' })
  })

  it('places the durable fencing callback immediately before the WebSocket write', () => {
    const bridge = readFileSync(new URL('../../server/bridge-ws.js', import.meta.url), 'utf8')
    const worker = readFileSync(new URL('../../server/routes/ai/position-management-worker.js', import.meta.url), 'utf8')
    const guard = bridge.indexOf('await options.beforeWrite')
    const write = bridge.indexOf("bridge.ws.send(JSON.stringify({ type: 'command'", guard)
    expect(guard).toBeGreaterThan(0)
    expect(write).toBeGreaterThan(guard)
    expect(worker).toContain("lease_expires_at > NOW()")
    expect(worker).toContain("operation_id:command.operation_id")
    expect(worker).toContain("本任务只复核、不重发")
  })

  it('starts the guarded worker with the server and exposes exact pending-order history state', () => {
    const server = readFileSync(new URL('../../server/index.js', import.meta.url), 'utf8')
    const bridge = readFileSync(new URL('../../bridge/native/workers/mt5/worker.py', import.meta.url), 'utf8')
    const worker = readFileSync(new URL('../../server/routes/ai/position-management-worker.js', import.meta.url), 'utf8')
    expect(server).toContain('startPositionManagementWorker()')
    expect(bridge).toContain('if action == "pending_order_state":')
    expect(bridge).toContain('self.mt5.history_orders_get(ticket=ticket)')
    expect(worker).toContain("scope:'exit_and_pending_cancel'")
  })
})
