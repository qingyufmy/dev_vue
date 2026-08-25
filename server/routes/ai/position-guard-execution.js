import crypto from 'node:crypto'
import { beijingAfter, beijingNow, parseBeijing, queryAll, queryOne, queryRun, withTransaction } from '../../db.js'
import { getBridgeGeneration, isBridgeAlive } from '../../bridge-ws.js'
import { mt5Bridge } from './market-data.js'
import { broadcastPositionManagementTask, claimPositionManagementLease } from './position-management.js'
import { evaluatePositionGuard } from './position-guard-engine.js'
import { validatePositionGuardQuoteSnapshot } from './position-guard-quote-cache.js'
import { stripBrokerSuffix } from './utils.js'

const SYSTEM_MAGIC = 234000
const LEASE_SECONDS = 90
const RECONCILE_TIMEOUT_MS = 60_000
const ACTIVE_STATES = new Set([
  'EVIDENCE_CONFIRMED', 'GUARD_INTENT_CREATED', 'GUARD_SENT', 'GUARD_RECONCILING', 'GUARD_UNCERTAIN',
])
export const POSITION_GUARD_EXECUTION_STATES = [...ACTIVE_STATES]

const text = value => String(value ?? '').trim()
const upper = value => text(value).toUpperCase()
const number = value => Number.isFinite(Number(value)) ? Number(value) : null
const sameVolume = (left, right, tolerance = 1e-8) => Math.abs(Number(left || 0) - Number(right || 0)) <= tolerance
const canonicalSymbol = value => stripBrokerSuffix(text(value)).toUpperCase()
const parseJson = (value, fallback = {}) => { try { return value ? JSON.parse(value) : fallback } catch { return fallback } }
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')

function executionError(code, retryable = false) {
  const error = new Error(code)
  error.code = code
  error.retryable = retryable
  return error
}

export function normalizePositionGuardPartialVolume(currentVolume, closePercent, instrument = {}) {
  const current = number(currentVolume)
  const percent = number(closePercent)
  const minimum = number(instrument.volume_min)
  const step = number(instrument.volume_step)
  if (!current || current <= 0 || !percent || percent <= 0 || percent >= 100
    || !minimum || minimum <= 0 || !step || step <= 0) {
    return { ok:false, code:'position_guard_partial_volume_invalid' }
  }
  const digits = Math.max(0, Math.min(8, Math.ceil(-Math.log10(step) - 1e-9)))
  let closeVolume = Math.floor((current * percent / 100) / step + 1e-9) * step
  const maximumClosable = Math.floor((current - minimum) / step + 1e-9) * step
  closeVolume = Math.min(closeVolume, maximumClosable)
  closeVolume = Number(closeVolume.toFixed(digits))
  const remainingVolume = Number((current - closeVolume).toFixed(digits))
  if (closeVolume < minimum - 1e-8 || remainingVolume < minimum - 1e-8) {
    return { ok:false, code:'position_guard_partial_volume_below_minimum' }
  }
  return { ok:true, close_volume:closeVolume, remaining_volume:remainingVolume, volume_step:step }
}

function taskAction(task) {
  const action = text(task?.candidate_action).toLowerCase()
  return ['full_exit', 'partial_exit', 'move_protection'].includes(action) ? action : null
}

export function validatePositionGuardExecutionPreconditions({
  task, outcome, ownership, control, setting, inventory, currentGeneration, competingOutcomes = [],
} = {}) {
  const action = taskAction(task)
  if (!task || !outcome || !action || task.task_type !== 'position_guard'
    || text(task.decision_source).toLowerCase() !== 'pivot_guard') {
    return { ok:false, code:'position_guard_execution_scope_mismatch' }
  }
  if (Number(control?.enabled ?? 0) !== 1 || Number(setting?.enabled ?? 0) !== 1) {
    return { ok:false, code:'position_guard_execution_disabled' }
  }
  if (!Number(task.bridge_generation) || Number(task.bridge_generation) !== Number(currentGeneration)) {
    return { ok:false, code:'position_guard_bridge_generation_mismatch' }
  }
  if (!ownership || Number(ownership.id) !== Number(task.ownership_history_id)
    || Number(ownership.user_id) !== Number(task.user_id)
    || Number(ownership.trading_account_id) !== Number(task.trading_account_id)
    || ownership.ended_at
    || upper(ownership.broker_server_key) !== upper(task.broker_server_key)
    || text(ownership.login_account) !== text(task.login_account)) {
    return { ok:false, code:'position_guard_ownership_changed' }
  }
  if (text(outcome.status).toLowerCase() !== 'open'
    || text(outcome.attribution_status).toLowerCase() !== 'attributed'
    || Number(outcome.external_intervention || 0) !== 0
    || text(outcome.position_id) === '') {
    return { ok:false, code:'position_guard_attribution_incomplete' }
  }
  if (!inventory || inventory.status !== 'success' || !inventory.account || !Array.isArray(inventory.positions)) {
    return { ok:false, code:'position_guard_inventory_unavailable', retryable:true }
  }
  if (upper(inventory.account.server) !== upper(task.broker_server_key)
    || text(inventory.account.login) !== text(task.login_account)) {
    return { ok:false, code:'position_guard_account_identity_mismatch' }
  }
  const target = inventory.positions.find(item => text(item.ticket) === text(outcome.position_id))
  if (!target) return { ok:false, code:'position_guard_position_absent', targetAbsent:true }
  if (canonicalSymbol(target.symbol) !== canonicalSymbol(task.original_symbol || task.standard_symbol)
    || text(target.type).toLowerCase() !== text(outcome.entry_direction).toLowerCase()
    || Number(target.magic || 0) !== SYSTEM_MAGIC
    || Number(outcome.system_magic || 0) !== SYSTEM_MAGIC) {
    return { ok:false, code:'position_guard_position_identity_changed' }
  }
  const evidence = parseJson(task.deterministic_evidence_json, {})
  const expectedPosition = evidence.position || {}
  if (text(expectedPosition.ticket) && text(expectedPosition.ticket) !== text(target.ticket)) {
    return { ok:false, code:'position_guard_position_identity_changed' }
  }
  if (number(expectedPosition.volume) && !sameVolume(expectedPosition.volume, target.volume)) {
    return { ok:false, code:'position_guard_position_volume_changed' }
  }
  const sameSymbolPositions = inventory.positions.filter(item => canonicalSymbol(item.symbol) === canonicalSymbol(target.symbol))
  const marginMode = typeof inventory.account.is_hedging === 'boolean'
    ? (inventory.account.is_hedging ? 'hedging' : 'netting')
    : Number.isInteger(Number(inventory.account.margin_mode)) && Number(inventory.account.margin_mode) >= 0
      ? (Number(inventory.account.margin_mode) === 2 ? 'hedging' : 'netting')
      : null
  if (!marginMode) return { ok:false, code:'position_guard_margin_mode_unavailable', retryable:true }
  if (marginMode === 'netting' && sameSymbolPositions.length !== 1) {
    return { ok:false, code:'position_guard_netting_position_not_exclusive' }
  }
  if (marginMode === 'netting') {
    const competitors = competingOutcomes.filter(candidate =>
      Number(candidate.id) !== Number(outcome.id)
      && canonicalSymbol(candidate.original_symbol || candidate.symbol) === canonicalSymbol(target.symbol))
    if (competitors.length) {
      return {
        ok:false,
        code:'position_guard_netting_competing_outcome_detected',
        competing_outcome_ids:competitors.map(candidate => Number(candidate.id)),
      }
    }
  }
  const expectedState = {
    broker_server_key:upper(task.broker_server_key),
    login_account:text(task.login_account),
    margin_mode:marginMode,
    ticket:text(target.ticket),
    symbol:text(target.symbol),
    direction:text(target.type).toLowerCase(),
    magic:SYSTEM_MAGIC,
    volume:Number(target.volume),
    stop_loss:Number(target.sl || 0),
    take_profit:Number(target.tp || 0),
  }
  return {
    ok:true, action, target, evidence, expectedState,
    preconditionHash:digest({
      task_id:Number(task.id), state_version:Number(task.state_version),
      bridge_generation:Number(task.bridge_generation), ownership_history_id:Number(task.ownership_history_id),
      action, expected_state:expectedState,
    }),
  }
}

export function classifyPositionGuardReconciliation({ action, expectedState, request, inventory } = {}) {
  if (!inventory || inventory.status !== 'success' || !inventory.account || !Array.isArray(inventory.positions)) {
    return { status:'unavailable', code:'position_guard_inventory_unavailable' }
  }
  if (upper(inventory.account.server) !== upper(expectedState?.broker_server_key)
    || text(inventory.account.login) !== text(expectedState?.login_account)) {
    return { status:'manual_review', code:'position_guard_account_identity_mismatch' }
  }
  const target = inventory.positions.find(item => text(item.ticket) === text(expectedState?.ticket))
  if (action === 'full_exit') {
    if (!target) return { status:'confirmed', code:'position_guard_position_absent' }
  } else if (!target) {
    return { status:'manual_review', code:'position_guard_position_unexpectedly_absent' }
  }
  if (target && (canonicalSymbol(target.symbol) !== canonicalSymbol(expectedState?.symbol)
    || text(target.type).toLowerCase() !== text(expectedState?.direction).toLowerCase()
    || Number(target.magic || 0) !== Number(expectedState?.magic || SYSTEM_MAGIC))) {
    return { status:'manual_review', code:'position_guard_position_identity_changed' }
  }
  if (action === 'partial_exit') {
    const expectedRemaining = Number(expectedState.volume) - Number(request?.volume)
    const remaining = Number(target.volume)
    if (sameVolume(remaining, expectedRemaining)) {
      return { status:'confirmed', code:'position_guard_partial_close_confirmed', remaining_volume:remaining, target }
    }
    if (remaining < expectedRemaining - 1e-8) {
      return { status:'manual_review', code:'position_guard_partial_close_overfilled', remaining_volume:remaining, target }
    }
    return { status:'pending', code:'position_guard_partial_close_not_visible', remaining_volume:remaining, target }
  }
  if (action === 'move_protection') {
    const actual = Number(target.sl || 0)
    const desired = Number(request?.stop_loss)
    if (Number.isFinite(actual) && Number.isFinite(desired) && sameVolume(actual, desired, 1e-7)) {
      return { status:'confirmed', code:'position_guard_protection_confirmed', stop_loss:actual, target }
    }
    const direction = text(expectedState.direction).toLowerCase()
    const moreProtective = direction === 'buy' ? actual > desired : direction === 'sell' ? actual < desired : false
    if (actual > 0 && moreProtective) {
      return { status:'manual_review', code:'position_guard_protection_changed_externally', stop_loss:actual, target }
    }
    return { status:'pending', code:'position_guard_protection_not_visible', stop_loss:actual, target }
  }
  return { status:'pending', code:'position_guard_full_close_not_visible', target }
}

function commandTypeForAction(action) {
  return action === 'move_protection' ? 'modify_system_position_protection' : 'close_system_position'
}

function operationId(task) {
  const raw = `PG-${Number(task.position_guard_state_id)}-${text(task.trigger_code)}-${Number(task.id)}`
  return raw.slice(0, 96)
}

async function releaseLease(taskId, leaseToken) {
  if (!leaseToken) return
  await queryRun(`UPDATE ai_position_management_tasks
    SET lease_token = NULL, lease_expires_at = NULL, updated_at = ?
    WHERE id = ? AND lease_token = ?`, [beijingNow(), taskId, leaseToken])
}

async function loadContext(taskId) {
  const task = await queryOne('SELECT * FROM ai_position_management_tasks WHERE id = ?', [taskId])
  if (!task) return null
  const commandType = commandTypeForAction(taskAction(task))
  const [outcome, competingOutcomes, ownership, control, setting, state, command] = await Promise.all([
    queryOne('SELECT * FROM signal_outcomes WHERE id = ?', [task.outcome_id]),
    queryAll(`SELECT id, original_symbol, symbol, position_id, status, attribution_status
      FROM signal_outcomes
      WHERE trading_account_id = ? AND id <> ? AND status IN ('open','closing')
        AND position_id IS NOT NULL`, [task.trading_account_id, task.outcome_id]),
    queryOne(`SELECT * FROM mt5_account_ownership_history
      WHERE id = ? AND user_id = ? AND trading_account_id = ? AND ended_at IS NULL LIMIT 1`,
    [task.ownership_history_id, task.user_id, task.trading_account_id]),
    queryOne('SELECT * FROM global_position_guard_control WHERE id = 1'),
    queryOne(`SELECT * FROM user_position_guard_settings
      WHERE user_id = ? AND trading_account_id = ?`, [task.user_id, task.trading_account_id]),
    queryOne('SELECT * FROM position_guard_position_states WHERE id = ?', [task.position_guard_state_id]),
    queryOne(`SELECT * FROM ai_position_management_commands
      WHERE task_id = ? AND command_type = ? ORDER BY command_sequence DESC, id DESC LIMIT 1`,
    [task.id, commandType]),
  ])
  return { task, outcome, competingOutcomes, ownership, control:control || {}, setting:setting || {}, state, command }
}

async function retireGuardTask(context, lease, {
  status = 'FAILED', eventType, summary, details = {}, retryDelayMs = 60_000, completeState = false,
} = {}) {
  const { task } = context
  const now = beijingNow()
  const retryAfter = retryDelayMs > 0 ? beijingAfter(retryDelayMs) : null
  const updated = await withTransaction(async run => {
    const [stateUpdate] = await run(`UPDATE position_guard_position_states
      SET pending_task_id = NULL, retry_after = ?, last_error_code = ?,
        completed_at = CASE WHEN ? THEN ? ELSE completed_at END,
        state_version = state_version + 1, updated_at = ?
      WHERE id = ? AND pending_task_id = ?`, [
      retryAfter, details?.code || eventType || null, completeState ? 1 : 0, now, now,
      task.position_guard_state_id, task.id,
    ])
    if (Number(stateUpdate?.affectedRows ?? 0) !== 1) {
      throw executionError('position_guard_state_retire_conflict')
    }
    const [taskUpdate] = await run(`UPDATE ai_position_management_tasks
      SET status = ?, state_version = state_version + 1, completed_at = ?, updated_at = ?
      WHERE id = ? AND status = ? AND state_version = ? AND fencing_token = ?
        AND lease_token = ? AND lease_expires_at > NOW()`, [
      status, now, now, task.id, task.status, task.state_version,
      lease.fencing_token, lease.lease_token,
    ])
    if (Number(taskUpdate?.affectedRows ?? 0) !== 1) {
      throw executionError('position_guard_task_retire_conflict')
    }
    await run(`INSERT INTO ai_position_management_events
      (task_id, from_status, to_status, event_type, summary, details_json, actor_type, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'worker', ?)`, [
      task.id, task.status, status, eventType, summary, JSON.stringify(details || {}), now,
    ])
    return {
      ...task, status, state_version:Number(task.state_version) + 1,
      completed_at:now, updated_at:now,
    }
  })
  broadcastPositionManagementTask(updated, eventType)
  return updated
}

async function transitionGuardTask(task, lease, toStatus, eventType, summary, details = {}) {
  const updated = await withTransaction(async run => {
    const now = beijingNow()
    const [result] = await run(`UPDATE ai_position_management_tasks
      SET status = ?, state_version = state_version + 1,
        completed_at = CASE WHEN ? THEN ? ELSE completed_at END, updated_at = ?
      WHERE id = ? AND status = ? AND state_version = ? AND fencing_token = ?
        AND lease_token = ? AND lease_expires_at > NOW()`, [
      toStatus, ['COMPLETED', 'FAILED', 'MANUAL_REVIEW'].includes(toStatus) ? 1 : 0,
      now, now, task.id, task.status, task.state_version, lease.fencing_token, lease.lease_token,
    ])
    if (Number(result?.affectedRows ?? result?.changes ?? 0) !== 1) throw executionError('position_guard_task_transition_conflict')
    await run(`INSERT INTO ai_position_management_events
      (task_id, from_status, to_status, event_type, summary, details_json, actor_type, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'worker', ?)`, [
      task.id, task.status, toStatus, eventType, summary, JSON.stringify(details || {}), now,
    ])
    return { ...task, status:toStatus, state_version:Number(task.state_version) + 1, updated_at:now }
  })
  broadcastPositionManagementTask(updated, eventType)
  return updated
}

function routeParams(evidence = {}) {
  const route = evidence.route || {}
  return {
    ...(text(route.terminal_instance_id) ? { terminal_instance_id:text(route.terminal_instance_id) } : {}),
    ...(route.account_ref ? { account_ref:route.account_ref } : {}),
  }
}

async function actionRequest(context, preflight, bridge) {
  const { action, evidence, expectedState } = preflight
  if (action === 'full_exit') return { ticket:expectedState.ticket, volume:expectedState.volume,
    comment:'PivotGuard完整平仓' }
  if (action === 'move_protection') {
    const stopLoss = number(evidence.action?.stop_loss ?? evidence.action?.new_sl
      ?? evidence.action?.price ?? evidence.stop_loss)
    if (!stopLoss || stopLoss <= 0) throw executionError('position_guard_protection_price_invalid')
    const direction = expectedState.direction
    const existing = number(expectedState.stop_loss) || 0
    if ((direction === 'buy' && existing > 0 && stopLoss <= existing)
      || (direction === 'sell' && existing > 0 && stopLoss >= existing)) {
      throw executionError('position_guard_protection_not_stricter')
    }
    return { ticket:expectedState.ticket, stop_loss:stopLoss, take_profit:null }
  }
  const percent = number(evidence.action?.close_percent ?? evidence.close_percent)
  const symbolSnapshot = await bridge(context.task.user_id, 'symbol_snapshot', {
    symbol:expectedState.symbol, ...routeParams(evidence),
  }, { noFallback:true, timeoutMs:5_000, expectedGeneration:Number(context.task.bridge_generation) })
  if (symbolSnapshot?.status !== 'success' || !symbolSnapshot.instrument) {
    throw executionError('position_guard_symbol_spec_unavailable', true)
  }
  const normalized = normalizePositionGuardPartialVolume(expectedState.volume, percent, symbolSnapshot.instrument)
  if (!normalized.ok) throw executionError(normalized.code)
  return { ticket:expectedState.ticket, volume:normalized.close_volume,
    expected_remaining_volume:normalized.remaining_volume, comment:'PivotGuard部分平仓' }
}

async function revalidateLiveTrigger(context, preflight, bridge) {
  const evidence = preflight.evidence || {}
  const route = evidence.route || {}
  const routeInput = {
    userId:context.task.user_id,
    tradingAccountId:context.task.trading_account_id,
    terminalInstanceId:route.terminal_instance_id,
    connectionEpoch:route.connection_epoch,
    accountRef:route.account_ref,
    symbol:preflight.target.symbol,
  }
  const quote = await bridge(context.task.user_id, 'quote', {
    symbol:preflight.target.symbol,
    ...routeParams(evidence),
  }, {
    noFallback:true,
    timeoutMs:3_000,
    expectedGeneration:Number(context.task.bridge_generation),
  })
  if (quote?.status !== 'success') {
    return { ok:false, code:'position_guard_live_quote_unavailable', retryable:true }
  }
  const validation = validatePositionGuardQuoteSnapshot({
    route:{
      user_id:Number(context.task.user_id),
      trading_account_id:Number(context.task.trading_account_id),
      terminal_instance_id:text(route.terminal_instance_id),
      connection_epoch:Number(route.connection_epoch),
      broker_server:upper(route.account_ref?.broker_server),
      login_account:text(route.account_ref?.login),
      broker_symbol:upper(preflight.target.symbol),
    },
    quote,
  }, routeInput)
  if (!validation.ok) return { ...validation, retryable:true }
  const direction = text(preflight.target.type).toLowerCase()
  const evaluation = evaluatePositionGuard({
    d1:evidence.d1,
    params:evidence.params,
    contract:evidence.contract,
    position:{
      ticket:text(preflight.target.ticket),
      symbol:text(preflight.target.symbol),
      direction,
      open_price:Number(preflight.target.price_open),
      current_price:direction === 'buy' ? validation.quote.bid : validation.quote.ask,
      volume:Number(preflight.target.volume),
      stop_loss:Number(preflight.target.sl || 0) || null,
      take_profit:Number(preflight.target.tp || 0) || null,
    },
    quote:validation.quote,
    stage_state:context.state,
    now_ms:Number(validation.quote.observed_at_utc_msc),
  })
  if (!evaluation.ok) {
    return { ok:false, code:`position_guard_live_revalidation_${evaluation.error?.code || 'failed'}` }
  }
  if (evaluation.action?.side_effect !== true
    || evaluation.action?.type !== preflight.action
    || text(evaluation.action?.trigger_code) !== text(context.task.trigger_code)) {
    return {
      ok:false,
      code:'position_guard_trigger_no_longer_active',
      live_action:evaluation.action || null,
    }
  }
  return { ok:true, quote:validation.quote, evaluation }
}

export const _positionGuardExecutionInternals = Object.freeze({ revalidateLiveTrigger })

async function prepareGuardCommand(context, lease, preflight, request) {
  const { task } = context
  const commandType = commandTypeForAction(preflight.action)
  const operation = operationId(task)
  const prepared = await withTransaction(async run => {
    const [taskRows] = await run('SELECT * FROM ai_position_management_tasks WHERE id = ? FOR UPDATE', [task.id])
    const current = taskRows?.[0]
    if (!current || current.status !== 'EVIDENCE_CONFIRMED'
      || Number(current.state_version) !== Number(task.state_version)
      || Number(current.fencing_token) !== Number(lease.fencing_token)
      || current.lease_token !== lease.lease_token) throw executionError('position_guard_prepare_fence_changed')
    const [controlRows] = await run('SELECT enabled FROM global_position_guard_control WHERE id = 1 FOR UPDATE')
    const [settingRows] = await run(`SELECT enabled FROM user_position_guard_settings
      WHERE user_id = ? AND trading_account_id = ? FOR UPDATE`, [current.user_id, current.trading_account_id])
    if (Number(controlRows?.[0]?.enabled ?? 0) !== 1 || Number(settingRows?.[0]?.enabled ?? 0) !== 1) {
      throw executionError('position_guard_execution_disabled')
    }
    const [ownershipRows] = await run(`SELECT id FROM mt5_account_ownership_history
      WHERE id = ? AND user_id = ? AND trading_account_id = ? AND ended_at IS NULL FOR UPDATE`,
    [current.ownership_history_id, current.user_id, current.trading_account_id])
    if (!ownershipRows?.[0]) throw executionError('position_guard_ownership_changed')
    const [stateRows] = await run(`SELECT id, pending_task_id FROM position_guard_position_states
      WHERE id = ? FOR UPDATE`, [current.position_guard_state_id])
    if (!stateRows?.[0] || Number(stateRows[0].pending_task_id) !== Number(current.id)) {
      throw executionError('position_guard_state_fence_changed')
    }
    const [existingRows] = await run(`SELECT * FROM ai_position_management_commands
      WHERE task_id = ? AND command_type = ? AND command_sequence = 1 FOR UPDATE`, [current.id, commandType])
    if (existingRows?.length) throw executionError('position_guard_command_already_exists')
    const now = beijingNow()
    const [inserted] = await run(`INSERT INTO ai_position_management_commands
      (task_id, command_sequence, operation_id, command_type, expected_state_json, request_json,
       send_status, reconciliation_status, created_at, updated_at)
      VALUES (?, 1, ?, ?, ?, ?, 'prepared', 'pending', ?, ?)`, [
      current.id, operation, commandType, JSON.stringify(preflight.expectedState), JSON.stringify(request), now, now,
    ])
    await run(`UPDATE ai_position_management_tasks
      SET precondition_hash = ?, status = 'GUARD_INTENT_CREATED', state_version = state_version + 1, updated_at = ?
      WHERE id = ?`, [preflight.preconditionHash, now, current.id])
    await run(`INSERT INTO ai_position_management_events
      (task_id, from_status, to_status, event_type, summary, details_json, actor_type, created_at)
      VALUES (?, 'EVIDENCE_CONFIRMED', 'GUARD_INTENT_CREATED', 'position_guard_intent_created',
        'PivotGuard 已持久化确定性动作和稳定操作号', ?, 'worker', ?)`, [
      current.id, JSON.stringify({ action:preflight.action, operation_id:operation,
        precondition_hash:preflight.preconditionHash }), now,
    ])
    return {
      task:{ ...current, status:'GUARD_INTENT_CREATED', state_version:Number(current.state_version) + 1,
        precondition_hash:preflight.preconditionHash, updated_at:now },
      command:{ id:Number(inserted?.insertId), task_id:Number(current.id), operation_id:operation,
        command_type:commandType, expected_state_json:JSON.stringify(preflight.expectedState),
        request_json:JSON.stringify(request), send_status:'prepared', created_at:now, updated_at:now },
    }
  })
  broadcastPositionManagementTask(prepared.task, 'position_guard_intent_created')
  return prepared
}

async function markSending(task, lease, command, commandId, bridgeGeneration) {
  const sent = await withTransaction(async run => {
    const [rows] = await run('SELECT * FROM ai_position_management_tasks WHERE id = ? FOR UPDATE', [task.id])
    const current = rows?.[0]
    if (!current || current.status !== 'GUARD_INTENT_CREATED'
      || Number(current.state_version) !== Number(task.state_version)
      || Number(current.fencing_token) !== Number(lease.fencing_token)
      || current.lease_token !== lease.lease_token
      || Number(current.bridge_generation) !== Number(bridgeGeneration)) {
      throw executionError('position_guard_write_guard_conflict')
    }
    const [controlRows] = await run('SELECT enabled FROM global_position_guard_control WHERE id = 1 FOR UPDATE')
    const [settingRows] = await run(`SELECT enabled FROM user_position_guard_settings
      WHERE user_id = ? AND trading_account_id = ? FOR UPDATE`, [current.user_id, current.trading_account_id])
    const [ownershipRows] = await run(`SELECT id FROM mt5_account_ownership_history
      WHERE id = ? AND user_id = ? AND trading_account_id = ? AND ended_at IS NULL FOR UPDATE`,
    [current.ownership_history_id, current.user_id, current.trading_account_id])
    const [stateRows] = await run(`SELECT id, pending_task_id FROM position_guard_position_states
      WHERE id = ? FOR UPDATE`, [current.position_guard_state_id])
    if (Number(controlRows?.[0]?.enabled ?? 0) !== 1
      || Number(settingRows?.[0]?.enabled ?? 0) !== 1) {
      throw executionError('position_guard_execution_disabled')
    }
    if (!ownershipRows?.[0]) throw executionError('position_guard_ownership_changed')
    if (!stateRows?.[0] || Number(stateRows[0].pending_task_id) !== Number(current.id)) {
      throw executionError('position_guard_state_fence_changed')
    }
    const now = beijingNow()
    const [commandUpdate] = await run(`UPDATE ai_position_management_commands
      SET send_status = 'sending', bridge_command_id = ?, updated_at = ?
      WHERE id = ? AND operation_id = ? AND send_status = 'prepared'`,
    [commandId, now, command.id, command.operation_id])
    if (Number(commandUpdate?.affectedRows ?? 0) !== 1) throw executionError('position_guard_command_send_conflict')
    await run(`UPDATE ai_position_management_tasks SET status = 'GUARD_SENT',
      state_version = state_version + 1, updated_at = ? WHERE id = ?`, [now, current.id])
    await run(`INSERT INTO ai_position_management_events
      (task_id, from_status, to_status, event_type, summary, details_json, actor_type, created_at)
      VALUES (?, 'GUARD_INTENT_CREATED', 'GUARD_SENT', 'position_guard_send_started',
        'PivotGuard 动作已通过最终 fencing 校验并写入 Bridge', ?, 'worker', ?)`, [
      current.id, JSON.stringify({ operation_id:command.operation_id,
        bridge_command_id:commandId, bridge_generation:Number(bridgeGeneration) }), now,
    ])
    return { ...current, status:'GUARD_SENT', state_version:Number(current.state_version) + 1, updated_at:now }
  })
  broadcastPositionManagementTask(sent, 'position_guard_send_started')
  return sent
}

async function saveResult(command, result) {
  const sendStatus = result?.status === 'success' || result?.status === 'partial' ? 'acknowledged'
    : result?.status === 'rejected' ? 'rejected' : 'uncertain'
  await queryRun(`UPDATE ai_position_management_commands
    SET send_status = ?, bridge_result_json = ?, updated_at = ? WHERE id = ? AND operation_id = ?`,
  [sendStatus, JSON.stringify(result || {}), beijingNow(), command.id, command.operation_id])
}

async function finishConfirmed(context, lease, result) {
  const now = beijingNow()
  const task = context.task
  const evidence = parseJson(task.deterministic_evidence_json, {})
  const nextState = evidence.next_stage_state || {}
  const action = taskAction(task)
  const trigger = text(task.trigger_code)
  const updated = await withTransaction(async run => {
    await run(`UPDATE ai_position_management_commands
      SET reconciliation_status = 'confirmed', reconciled_at = ?, updated_at = ? WHERE id = ?`,
    [now, now, context.command.id])
    const stageUpdates = []
    const params = []
    if (trigger === 'pivot_take_profit' || nextState.pivot_tp_done === true) stageUpdates.push('pivot_tp_done = 1')
    if (trigger === 'first_target_take_profit' || nextState.first_target_done === true) stageUpdates.push('first_target_done = 1')
    stageUpdates.push('pivot_cross_since_utc_ms = ?')
    params.push(nextState.pivot_cross_since_utc_ms ?? null)
    if (action === 'move_protection') {
      stageUpdates.push('break_even_done = 1', 'break_even_pending = 0',
        'pending_break_even_price = NULL', 'pending_break_even_trigger = NULL')
    } else if (action === 'partial_exit' && evidence.action?.next_protection?.stop_loss) {
      stageUpdates.push('break_even_pending = 1', 'pending_break_even_price = ?', 'pending_break_even_trigger = ?')
      params.push(Number(evidence.action.next_protection.stop_loss), trigger)
    }
    if (action === 'full_exit') {
      stageUpdates.push('completed_at = ?')
      params.push(now)
    }
    stageUpdates.push('pending_task_id = NULL', 'retry_after = NULL', 'last_error_code = NULL',
      'state_version = state_version + 1', 'last_completed_at = ?', 'updated_at = ?')
    params.push(now, now, task.position_guard_state_id, task.id)
    const [stateUpdate] = await run(`UPDATE position_guard_position_states SET ${stageUpdates.join(', ')}
      WHERE id = ? AND pending_task_id = ?`, params)
    if (Number(stateUpdate?.affectedRows ?? 0) !== 1) throw executionError('position_guard_state_completion_conflict')
    const [taskUpdate] = await run(`UPDATE ai_position_management_tasks
      SET status = 'COMPLETED', state_version = state_version + 1, completed_at = ?, updated_at = ?
      WHERE id = ? AND status = ? AND state_version = ? AND fencing_token = ?
        AND lease_token = ? AND lease_expires_at > NOW()`, [
      now, now, task.id, task.status, task.state_version, lease.fencing_token, lease.lease_token,
    ])
    if (Number(taskUpdate?.affectedRows ?? 0) !== 1) throw executionError('position_guard_task_completion_conflict')
    await run(`INSERT INTO ai_position_management_events
      (task_id, from_status, to_status, event_type, summary, details_json, actor_type, created_at)
      VALUES (?, ?, 'COMPLETED', 'position_guard_action_confirmed',
        'MT5 已确认 PivotGuard 动作结果', ?, 'worker', ?)`, [
      task.id, task.status, JSON.stringify(result), now,
    ])
    return { ...task, status:'COMPLETED', state_version:Number(task.state_version) + 1,
      completed_at:now, updated_at:now }
  })
  broadcastPositionManagementTask(updated, 'position_guard_action_confirmed')
  return updated
}

async function reconcile(context, lease, bridge) {
  let task = context.task
  if (['GUARD_SENT', 'GUARD_UNCERTAIN'].includes(task.status)) {
    task = await transitionGuardTask(task, lease, 'GUARD_RECONCILING',
      'position_guard_reconciliation_started', '正在使用 MT5 当前持仓复核 PivotGuard 动作结果',
      { operation_id:context.command.operation_id })
    context = { ...context, task }
  }
  if (task.status !== 'GUARD_RECONCILING') return task
  const expectedState = parseJson(context.command.expected_state_json, {})
  const request = parseJson(context.command.request_json, {})
  const evidence = parseJson(task.deterministic_evidence_json, {})
  const inventory = await bridge(task.user_id, 'system_trade_inventory', routeParams(evidence), {
    noFallback:true, timeoutMs:10_000, expectedGeneration:Number(task.bridge_generation),
  })
  const result = classifyPositionGuardReconciliation({
    action:taskAction(task), expectedState, request, inventory,
  })
  if (result.status === 'confirmed') return finishConfirmed({ ...context, task }, lease, result)
  if (result.status === 'manual_review') {
    await queryRun(`UPDATE ai_position_management_commands SET reconciliation_status = 'manual_review',
      reconciled_at = ?, updated_at = ? WHERE id = ?`, [beijingNow(), beijingNow(), context.command.id])
    return transitionGuardTask(task, lease, 'MANUAL_REVIEW', 'position_guard_manual_review_required',
      'PivotGuard 动作结果与预期不一致，已停止自动处理', result)
  }
  const createdAt = parseBeijing(context.command.created_at)
  const tooOld = createdAt && Date.now() - createdAt.getTime() >= RECONCILE_TIMEOUT_MS
  if (tooOld) {
    return transitionGuardTask(task, lease, 'MANUAL_REVIEW', 'position_guard_reconciliation_timeout',
      'PivotGuard 动作结果长时间无法确认，禁止自动重发', result)
  }
  await queryRun(`UPDATE ai_position_management_commands SET reconciliation_status = 'pending',
    updated_at = ? WHERE id = ?`, [beijingNow(), context.command.id])
  return transitionGuardTask(task, lease, 'GUARD_UNCERTAIN', 'position_guard_reconciliation_pending',
    'MT5 尚未显示最终结果，后续只复核、不重发', result)
}

async function executePrepared(context, lease, bridge) {
  let { task, command } = context
  const expectedState = parseJson(command.expected_state_json, {})
  const request = parseJson(command.request_json, {})
  const action = taskAction(task)
  const evidence = parseJson(task.deterministic_evidence_json, {})
  const bridgeAction = commandTypeForAction(action)
  const params = {
    ...routeParams(evidence),
    ...request,
    ticket:expectedState.ticket,
    operation_id:command.operation_id,
    expected_state:expectedState,
  }
  const result = await bridge(task.user_id, bridgeAction, params, {
    noFallback:true, timeoutMs:15_000, expectedGeneration:Number(task.bridge_generation),
    beforeWrite:async ({ commandId, bridgeGeneration }) => {
      task = await markSending(task, lease, command, commandId, bridgeGeneration)
      return true
    },
  })
  await saveResult(command, result)
  const latest = await loadContext(task.id)
  if (!latest) return null
  if (latest.task.status === 'GUARD_INTENT_CREATED') {
    return retireGuardTask(latest, lease, {
      status:'FAILED', eventType:'position_guard_send_blocked',
      summary:'PivotGuard 命令在写入 Bridge 前被安全校验阻止',
      details:result, retryDelayMs:60_000,
    })
  }
  return reconcile(latest, lease, bridge)
}

export async function processPositionGuardExecutionTask(taskId, { bridge = mt5Bridge } = {}) {
  const lease = await claimPositionManagementLease(taskId, LEASE_SECONDS)
  if (!lease) return false
  try {
    let context = await loadContext(taskId)
    if (!context || !ACTIVE_STATES.has(context.task.status) || context.task.task_type !== 'position_guard') return false
    if (context.task.status === 'EVIDENCE_CONFIRMED') {
      if (!isBridgeAlive(Number(context.task.user_id))) return false
      const currentGeneration = getBridgeGeneration(Number(context.task.user_id))
      const taskEvidence = parseJson(context.task.deterministic_evidence_json, {})
      const inventory = await bridge(context.task.user_id, 'system_trade_inventory', routeParams(taskEvidence), {
        noFallback:true, timeoutMs:10_000,
      })
      const preflight = validatePositionGuardExecutionPreconditions({ ...context, inventory, currentGeneration })
      if (!preflight.ok) {
        if (preflight.retryable) return false
        await retireGuardTask(context, lease, {
          status:preflight.targetAbsent ? 'COMPLETED' : 'FAILED',
          eventType:'position_guard_precondition_rejected',
          summary:'PivotGuard 执行前置条件未通过，未向 MT5 发送命令',
          details:preflight,
          retryDelayMs:preflight.targetAbsent ? 0 : 60_000,
          completeState:Boolean(preflight.targetAbsent),
        })
        return true
      }
      const liveTrigger = await revalidateLiveTrigger(context, preflight, bridge)
      if (!liveTrigger.ok) {
        if (liveTrigger.retryable) return false
        await retireGuardTask(context, lease, {
          status:'FAILED',
          eventType:'position_guard_live_trigger_rejected',
          summary:'PivotGuard 触发条件在实时复核时已不成立，未向 MT5 发送命令',
          details:liveTrigger,
          retryDelayMs:5_000,
        })
        return true
      }
      let request
      try { request = await actionRequest(context, preflight, bridge) }
      catch (error) {
        if (error.retryable) return false
        await retireGuardTask(context, lease, {
          status:'FAILED',
          eventType:'position_guard_request_invalid',
          summary:'PivotGuard 动作参数无法安全规范化，未向 MT5 发送命令',
          details:{ code:error.code || error.message },
          retryDelayMs:60_000,
        })
        return true
      }
      const prepared = await prepareGuardCommand(context, lease, preflight, request)
      return Boolean(await executePrepared({ ...context, ...prepared }, lease, bridge))
    }
    if (context.task.status === 'GUARD_INTENT_CREATED') {
      if (!context.command || context.command.send_status !== 'prepared') {
        await transitionGuardTask(context.task, lease, 'MANUAL_REVIEW', 'position_guard_command_state_invalid',
          'PivotGuard 持久化命令状态异常，已停止自动处理')
        return true
      }
      if (!isBridgeAlive(Number(context.task.user_id))) return false
      const currentGeneration = getBridgeGeneration(Number(context.task.user_id))
      const taskEvidence = parseJson(context.task.deterministic_evidence_json, {})
      const inventory = await bridge(context.task.user_id, 'system_trade_inventory', routeParams(taskEvidence), {
        noFallback:true, timeoutMs:10_000, expectedGeneration:currentGeneration,
      })
      const preflight = validatePositionGuardExecutionPreconditions({ ...context, inventory, currentGeneration })
      if (!preflight.ok) {
        if (preflight.retryable) return false
        await retireGuardTask(context, lease, {
          status:preflight.targetAbsent ? 'COMPLETED' : 'FAILED',
          eventType:'position_guard_prepared_precondition_rejected',
          summary:'PivotGuard 恢复待发送命令时前置条件已变化，未向 MT5 发送命令',
          details:preflight,
          retryDelayMs:preflight.targetAbsent ? 0 : 60_000,
          completeState:Boolean(preflight.targetAbsent),
        })
        return true
      }
      const liveTrigger = await revalidateLiveTrigger(context, preflight, bridge)
      if (!liveTrigger.ok) {
        if (liveTrigger.retryable) return false
        await retireGuardTask(context, lease, {
          status:'FAILED',
          eventType:'position_guard_prepared_live_trigger_rejected',
          summary:'PivotGuard 恢复待发送命令时触发条件已失效，未向 MT5 发送命令',
          details:liveTrigger,
          retryDelayMs:5_000,
        })
        return true
      }
      return Boolean(await executePrepared(context, lease, bridge))
    }
    return Boolean(await reconcile(context, lease, bridge))
  } finally {
    await releaseLease(taskId, lease.lease_token).catch(() => {})
  }
}
