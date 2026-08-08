import crypto from 'node:crypto'
import { beijingNow, parseBeijing, queryAll, queryOne, queryRun, withTransaction } from '../../db.js'
import { getBridgeGeneration, isBridgeAlive } from '../../bridge-ws.js'
import { mt5Bridge } from './market-data.js'
import { stripBrokerSuffix } from './utils.js'
import {
  broadcastPositionManagementTask,
  claimPositionManagementLease,
  transitionPositionManagementTask,
} from './position-management.js'

const SYSTEM_MAGIC = 234000
const WORKER_INTERVAL_MS = 15_000
const LEASE_SECONDS = 90
const CLOSE_RECOVERY_STATES = [
  'CLOSE_INTENT_CREATED', 'CLOSE_SENT', 'CLOSE_RECONCILING', 'CLOSE_PARTIAL', 'CLOSE_UNCERTAIN',
]
const PENDING_RECOVERY_STATES = [
  'PENDING_CANCEL_INTENT', 'PENDING_CANCEL_SENT', 'PENDING_RECONCILING', 'PENDING_UNCERTAIN',
]
const PREPARATION_RECOVERY_STATES = [
  'PRECONDITIONS_LOCKED', 'CLOSE_INTENT_CREATED', 'PENDING_CANCEL_INTENT',
]
const MODE_RANK = new Map([['display', 0], ['auto_exit', 1], ['auto_reverse', 2]])

let workerTimer = null
let workerRunning = false
const runtimeStatus = {
  installed:true,
  scope:'exit_and_pending_cancel',
  running:false,
  last_started_at:null,
  last_finished_at:null,
  last_error:null,
  processed:0,
}

const num = value => Number.isFinite(Number(value)) ? Number(value) : null
const ref = value => value == null || String(value).trim() === '' ? null : String(value).trim()
const upper = value => String(value || '').trim().toUpperCase()
const json = (value, fallback = {}) => { try { return value ? JSON.parse(value) : fallback } catch { return fallback } }
const canonicalSymbol = value => stripBrokerSuffix(String(value || '')).toUpperCase()
const sameVolume = (left, right) => Math.abs(Number(left || 0) - Number(right || 0)) <= 1e-8
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
const isLegacyPendingPositionAlias = outcome => Boolean(ref(outcome?.pending_ticket))
  && ref(outcome?.position_id) === ref(outcome?.pending_ticket)
  && !ref(outcome?.entry_deal_ticket)

export function resolveLiveMarginMode(account = {}) {
  if (typeof account.is_hedging === 'boolean') return account.is_hedging ? 'hedging' : 'netting'
  const numeric = account.margin_mode == null || account.margin_mode === '' ? Number.NaN : Number(account.margin_mode)
  if (Number.isInteger(numeric) && numeric >= 0) return numeric === 2 ? 'hedging' : 'netting'
  return null
}

function effectiveMode(requested, maximum) {
  const requestedMode = String(requested || '').toLowerCase() === 'shadow'
    ? 'display' : String(requested || 'display').toLowerCase()
  const maximumMode = String(maximum || '').toLowerCase() === 'shadow'
    ? 'display' : String(maximum || 'display').toLowerCase()
  const userRank = MODE_RANK.get(requestedMode) ?? 0
  const maximumRank = MODE_RANK.get(maximumMode) ?? 0
  return userRank <= maximumRank ? requestedMode
    : [...MODE_RANK.entries()].find(([, rank]) => rank === maximumRank)?.[0] || 'display'
}

function effectiveRuntimeMode(setting, control, fallbackMode = 'display') {
  return effectiveMode(setting?.execution_mode || fallbackMode, control?.maximum_mode || 'display')
}

export function resolvePositionManagementRuntimeMode(task, setting, control) {
  return effectiveRuntimeMode(setting, control, task?.execution_mode || 'display')
}

function targetProtectionStatus(target) {
  const direction = String(target?.type || '').toLowerCase()
  const current = num(target?.price_current)
  const stopLoss = num(target?.sl)
  if (!current || current <= 0) return 'quote_unavailable'
  if (!stopLoss || stopLoss <= 0) return 'missing_stop_loss'
  if ((direction === 'buy' && stopLoss >= current) || (direction === 'sell' && stopLoss <= current)) {
    return 'invalid_stop_loss_direction'
  }
  return 'protected'
}

export function validateExitOnlyPreconditions({
  task, outcome, ownership, control, setting, inventory, currentGeneration,
  competingOutcomes = [],
} = {}) {
  if (!task || !outcome) return { ok:false, code:'management_context_incomplete' }
  const mode = resolvePositionManagementRuntimeMode(task, setting, control)
  if (!['auto_exit', 'auto_reverse'].includes(mode)) return { ok:false, code:'formal_exit_not_enabled' }
  if (task.task_type !== 'position_exit' || task.candidate_action !== 'exit') {
    return { ok:false, code:'exit_only_worker_scope_mismatch' }
  }
  if (!task.bridge_generation || Number(task.bridge_generation) !== Number(currentGeneration)) {
    return { ok:false, code:'bridge_generation_mismatch' }
  }
  if (!ownership || Number(ownership.id) !== Number(task.ownership_history_id)
    || Number(ownership.user_id) !== Number(task.user_id)
    || Number(ownership.trading_account_id) !== Number(task.trading_account_id)
    || ownership.ended_at) {
    return { ok:false, code:'account_ownership_generation_mismatch' }
  }
  if (upper(ownership.broker_server_key) !== upper(task.broker_server_key)
    || ref(ownership.login_account) !== ref(task.login_account)) {
    return { ok:false, code:'account_identity_mismatch' }
  }
  if (inventory?.status !== 'success' || !inventory.account) {
    return { ok:false, code:'bridge_inventory_unavailable', retryable:true }
  }
  const inventoryMarginMode = resolveLiveMarginMode(inventory.account)
  if (!inventoryMarginMode) return { ok:false, code:'account_margin_mode_unavailable', retryable:true }
  if (upper(inventory.account.server) !== upper(task.broker_server_key)
    || ref(inventory.account.login) !== ref(task.login_account)) {
    return { ok:false, code:'bridge_account_identity_mismatch' }
  }
  if (String(outcome.status || '').toLowerCase() !== 'open'
    || String(outcome.attribution_status || '').toLowerCase() !== 'attributed'
    || Number(outcome.external_intervention || 0) !== 0) {
    return { ok:false, code:'position_attribution_incomplete' }
  }
  const expectedVolume = num(outcome.expected_volume)
  const entryVolume = num(outcome.entry_volume)
  const closedVolume = num(outcome.closed_volume) || 0
  if (!expectedVolume || expectedVolume <= 0 || !entryVolume || !sameVolume(expectedVolume, entryVolume)
    || closedVolume > 1e-8) {
    return { ok:false, code:'full_position_volume_required' }
  }
  const ticket = ref(outcome.position_id)
  if (!ticket) return { ok:false, code:'position_ticket_missing' }
  const target = (inventory.positions || []).find(position => ref(position.ticket) === ticket)
  if (!target) return { ok:false, code:'position_already_absent', targetAbsent:true }
  if (canonicalSymbol(target.symbol) !== canonicalSymbol(task.original_symbol || task.standard_symbol)) {
    return { ok:false, code:'position_symbol_mismatch' }
  }
  if (inventoryMarginMode === 'netting') {
    const sameSymbolPositions = (inventory.positions || []).filter(position =>
      canonicalSymbol(position.symbol) === canonicalSymbol(target.symbol))
    if (sameSymbolPositions.length !== 1) return { ok:false, code:'netting_position_not_exclusive' }
    const competitors = (competingOutcomes || []).filter(candidate =>
      Number(candidate.id) !== Number(outcome.id)
      && canonicalSymbol(candidate.original_symbol || candidate.symbol) === canonicalSymbol(target.symbol))
    if (competitors.length) {
      return { ok:false, code:'netting_competing_outcome_detected', competing_outcome_ids:competitors.map(item => Number(item.id)) }
    }
  }
  if (String(target.type || '').toLowerCase() !== String(outcome.entry_direction || '').toLowerCase()) {
    return { ok:false, code:'position_direction_mismatch' }
  }
  if (Number(target.magic || 0) !== SYSTEM_MAGIC || Number(outcome.system_magic || 0) !== SYSTEM_MAGIC) {
    return { ok:false, code:'position_magic_mismatch' }
  }
  if (!sameVolume(target.volume, expectedVolume)) return { ok:false, code:'position_volume_mismatch' }
  const protectionStatus = targetProtectionStatus(target)
  if (protectionStatus !== 'protected') return { ok:false, code:`position_${protectionStatus}` }

  const expectedState = {
    broker_server_key:upper(task.broker_server_key),
    login_account:ref(task.login_account),
    margin_mode:inventoryMarginMode,
    ticket,
    symbol:ref(target.symbol),
    direction:String(outcome.entry_direction || '').toLowerCase(),
    magic:SYSTEM_MAGIC,
    volume:expectedVolume,
  }
  return {
    ok:true,
    mode,
    target,
    expectedState,
    preconditionHash:digest({
      task_id:Number(task.id),
      ownership_history_id:Number(task.ownership_history_id),
      bridge_generation:Number(task.bridge_generation),
      state_version:Number(task.state_version),
      expected_state:expectedState,
      protection_status:protectionStatus,
    }),
  }
}

export function validatePendingCancelPreconditions({
  task, outcome, ownership, control, inventory, currentGeneration,
} = {}) {
  if (!task || !outcome) return { ok:false, code:'management_context_incomplete' }
  if (Number(control?.ai_pending_cancel_enabled ?? 0) !== 1) {
    return { ok:false, code:'ai_pending_cancel_disabled' }
  }
  if (task.task_type !== 'pending_cancel' || task.candidate_action !== 'cancel') {
    return { ok:false, code:'pending_cancel_worker_scope_mismatch' }
  }
  if (!task.bridge_generation || Number(task.bridge_generation) !== Number(currentGeneration)) {
    return { ok:false, code:'bridge_generation_mismatch' }
  }
  if (!ownership || Number(ownership.id) !== Number(task.ownership_history_id)
    || Number(ownership.user_id) !== Number(task.user_id)
    || Number(ownership.trading_account_id) !== Number(task.trading_account_id)
    || ownership.ended_at) {
    return { ok:false, code:'account_ownership_generation_mismatch' }
  }
  if (upper(ownership.broker_server_key) !== upper(task.broker_server_key)
    || ref(ownership.login_account) !== ref(task.login_account)) {
    return { ok:false, code:'account_identity_mismatch' }
  }
  if (inventory?.status !== 'success' || !inventory.account || !Array.isArray(inventory.pending_orders)) {
    return { ok:false, code:'bridge_inventory_unavailable', retryable:true }
  }
  const inventoryMarginMode = resolveLiveMarginMode(inventory.account)
  if (!inventoryMarginMode) return { ok:false, code:'account_margin_mode_unavailable', retryable:true }
  if (upper(inventory.account.server) !== upper(task.broker_server_key)
    || ref(inventory.account.login) !== ref(task.login_account)) {
    return { ok:false, code:'bridge_account_identity_mismatch' }
  }
  if (String(outcome.status || '').toLowerCase() !== 'open'
    || !['pending', 'attributed'].includes(String(outcome.attribution_status || '').toLowerCase())
    || Number(outcome.external_intervention || 0) !== 0
    || (ref(outcome.position_id) && !isLegacyPendingPositionAlias(outcome))) {
    return { ok:false, code:'pending_attribution_incomplete' }
  }
  const ticket = ref(outcome.pending_ticket)
  const target = inventory.pending_orders.find(order => ref(order.ticket) === ticket)
  if (!target) return { ok:false, code:'pending_order_absent', targetAbsent:true }
  const direction = String(target.side || '').toLowerCase()
  if (canonicalSymbol(target.symbol) !== canonicalSymbol(task.original_symbol || task.standard_symbol)) {
    return { ok:false, code:'pending_symbol_mismatch' }
  }
  if (direction !== String(outcome.entry_direction || '').toLowerCase()) {
    return { ok:false, code:'pending_direction_mismatch' }
  }
  if (Number(target.magic || 0) !== SYSTEM_MAGIC || Number(outcome.system_magic || 0) !== SYSTEM_MAGIC) {
    return { ok:false, code:'pending_magic_mismatch' }
  }
  const expectedVolume = num(outcome.expected_volume)
  if (!expectedVolume || expectedVolume <= 0 || !sameVolume(target.volume, expectedVolume)) {
    return { ok:false, code:'pending_volume_mismatch' }
  }
  const expectedState = {
    broker_server_key:upper(task.broker_server_key),
    login_account:ref(task.login_account),
    margin_mode:inventoryMarginMode,
    ticket,
    symbol:ref(target.symbol),
    direction,
    magic:SYSTEM_MAGIC,
    volume:expectedVolume,
  }
  return {
    ok:true,
    mode:'pending_cancel',
    target,
    expectedState,
    preconditionHash:digest({
      task_id:Number(task.id), ownership_history_id:Number(task.ownership_history_id),
      bridge_generation:Number(task.bridge_generation), state_version:Number(task.state_version),
      expected_state:expectedState,
    }),
  }
}

export function classifyPendingCancelReconciliation(task, state) {
  if (state?.status !== 'success' || !state.account) {
    return { status:'unavailable', code:'pending_final_state_unavailable' }
  }
  if (upper(state.account.server) !== upper(task.broker_server_key)
    || ref(state.account.login) !== ref(task.login_account)) {
    return { status:'manual_review', code:'bridge_account_identity_mismatch' }
  }
  const expected = (() => {
    try { return JSON.parse(task.precondition_json || task.expected_state_json || '{}') } catch { return {} }
  })()
  const target = state.order || {}
  if (target.ticket && (ref(target.ticket) !== ref(expected.ticket)
    || ref(target.symbol) !== ref(expected.symbol)
    || Number(target.magic || 0) !== Number(expected.magic || SYSTEM_MAGIC)
    || (target.side && String(target.side).toLowerCase() !== String(expected.direction || '').toLowerCase()))) {
    return { status:'manual_review', code:'pending_identity_changed', target }
  }
  if (state.current_state === 'pending') return { status:'active', code:'pending_still_active', target }
  if (['cancelled', 'expired', 'rejected'].includes(state.final_state)) {
    return { status:'confirmed', code:`pending_${state.final_state}`, final_state:state.final_state, target }
  }
  if (['filled', 'partially_filled'].includes(state.final_state)) {
    return { status:'filled', code:'pending_filled_during_cancel', final_state:state.final_state,
      position_id:ref(state.position_id || target.position_id), target }
  }
  return { status:'unavailable', code:'pending_final_state_unknown', target }
}

export function classifyCloseReconciliation(task, inventory) {
  if (inventory?.status !== 'success' || !Array.isArray(inventory.positions)) {
    return { status:'unavailable', code:'bridge_inventory_unavailable' }
  }
  if (upper(inventory.account?.server) !== upper(task.broker_server_key)
    || ref(inventory.account?.login) !== ref(task.login_account)) {
    return { status:'manual_review', code:'bridge_account_identity_mismatch' }
  }
  const expected = (() => {
    try { return JSON.parse(task.precondition_json || task.expected_state_json || '{}') } catch { return {} }
  })()
  const ticket = ref(expected.ticket || task.position_id)
  const target = inventory.positions.find(position => ref(position.ticket) === ticket)
  if (!target) return { status:'confirmed', code:'position_absent' }
  if (ref(target.symbol) !== ref(expected.symbol)
    || String(target.type || '').toLowerCase() !== String(expected.direction || '').toLowerCase()
    || Number(target.magic || 0) !== Number(expected.magic || SYSTEM_MAGIC)) {
    return { status:'manual_review', code:'position_identity_changed', target }
  }
  const remaining = Number(target.volume || 0)
  const expectedVolume = Number(expected.volume || 0)
  if (remaining + 1e-8 < expectedVolume) {
    return { status:'partial', code:'position_partially_closed', remaining_volume:remaining, target }
  }
  return { status:'manual_review', code:'position_still_open', remaining_volume:remaining, target }
}

async function releaseLease(taskId, leaseToken) {
  if (!leaseToken) return
  await queryRun(`UPDATE ai_position_management_tasks
    SET lease_token = NULL, lease_expires_at = NULL, updated_at = ?
    WHERE id = ? AND lease_token = ?`, [beijingNow(), taskId, leaseToken])
}

async function expireInactiveAutomaticExitCandidates(limit = 50) {
  const rows = await queryAll(`SELECT tasks.*
    FROM ai_position_management_tasks tasks
    LEFT JOIN signal_outcomes outcomes ON outcomes.id = tasks.outcome_id
    WHERE tasks.task_type = 'position_exit' AND tasks.status = 'CANDIDATE'
      AND (outcomes.id IS NULL OR outcomes.status NOT IN ('open','closing') OR outcomes.position_id IS NULL)
    ORDER BY tasks.updated_at ASC, tasks.id ASC LIMIT ?`, [Math.max(1, Math.min(Number(limit) || 50, 100))])
  let expired = 0
  for (const task of rows) {
    const now = beijingNow()
    const previousEvidence = json(task.evidence_validation_json, {})
    const evidence = {
      ...previousEvidence, status:'expired', source:'position_no_longer_active', confirmation_count:0,
      required_confirmations:Number(task.required_confirmations || 2),
    }
    const result = await queryRun(`UPDATE ai_position_management_tasks
      SET status = 'EXPIRED', evidence_validation_json = ?, confirmation_count = 0,
        state_version = state_version + 1, completed_at = ?, updated_at = ?
      WHERE id = ? AND status = 'CANDIDATE'`, [JSON.stringify(evidence), now, now, task.id])
    if (Number(result?.changes ?? result?.affectedRows ?? 0) !== 1) continue
    await queryRun(`INSERT INTO ai_position_management_events
      (task_id, from_status, to_status, event_type, summary, details_json, actor_type, created_at)
      VALUES (?, 'CANDIDATE', 'EXPIRED', 'position_no_longer_active',
        '目标持仓已不存在，连续平仓确认已结束', ?, 'system', ?)`, [task.id, JSON.stringify(evidence), now])
    broadcastPositionManagementTask({ ...task, status:'EXPIRED', confirmation_count:0,
      state_version:Number(task.state_version || 1) + 1, evidence_validation_json:JSON.stringify(evidence), updated_at:now },
    'position_no_longer_active')
    expired += 1
  }
  return expired
}

async function loadTaskContext(taskId) {
  const task = await queryOne('SELECT * FROM ai_position_management_tasks WHERE id = ?', [taskId])
  if (!task) return null
  const commandType = task.task_type === 'pending_cancel' ? 'cancel_system_pending' : 'close_system_position'
  const [outcome, competingOutcomes, ownership, control, setting, activeTask, command] = await Promise.all([
    queryOne('SELECT * FROM signal_outcomes WHERE id = ?', [task.outcome_id]),
    queryAll(`SELECT id, original_symbol, symbol, position_id, status, attribution_status
      FROM signal_outcomes
      WHERE trading_account_id = ? AND id <> ? AND status IN ('open','closing')
        AND position_id IS NOT NULL`, [task.trading_account_id, task.outcome_id]),
    queryOne(`SELECT * FROM mt5_account_ownership_history
      WHERE id = ? AND user_id = ? AND trading_account_id = ? AND ended_at IS NULL LIMIT 1`,
    [task.ownership_history_id, task.user_id, task.trading_account_id]),
    queryOne('SELECT * FROM global_position_management_control WHERE id = 1'),
    queryOne('SELECT * FROM user_position_management_settings WHERE user_id = ?', [task.user_id]),
    queryOne(`SELECT id, status FROM ai_position_management_tasks
      WHERE outcome_id = ? AND id <> ? AND task_type = ?
        AND execution_mode IN ('auto_exit','auto_reverse')
        AND status NOT IN ('HELD','EXPIRED','REJECTED','FAILED','COMPLETED','EXIT_ONLY_COMPLETED','MANUAL_REVIEW')
      ORDER BY id ASC LIMIT 1`, [task.outcome_id, task.id, task.task_type]),
    queryOne(`SELECT * FROM ai_position_management_commands
      WHERE task_id = ? AND command_type = ?
      ORDER BY command_sequence DESC, id DESC LIMIT 1`, [task.id, commandType]),
  ])
  return { task, outcome, competingOutcomes, ownership, control:control || {}, setting:setting || {}, activeTask, command }
}

async function transition(task, lease, toStatus, eventType, summary, details = {}) {
  return transitionPositionManagementTask({
    taskId:task.id,
    expectedStateVersion:task.state_version,
    expectedFencingToken:lease.fencing_token,
    toStatus,
    eventType,
    summary,
    details,
    actorType:'worker',
  })
}

async function assertNettingOutcomeExclusive(run, task, expectedState) {
  if (expectedState?.margin_mode !== 'netting') return
  const [rows] = await run(`SELECT id, original_symbol, symbol
    FROM signal_outcomes
    WHERE trading_account_id = ? AND id <> ? AND status IN ('open','closing')
      AND position_id IS NOT NULL FOR UPDATE`, [task.trading_account_id, task.outcome_id])
  const competitors = (rows || []).filter(row =>
    canonicalSymbol(row.original_symbol || row.symbol) === canonicalSymbol(expectedState.symbol))
  if (competitors.length) throw new Error('position_management_netting_competitor_changed')
}

function preparationError(code) {
  const error = new Error(code)
  error.code = code
  return error
}

function parseStoredJson(value) {
  try {
    return { ok:true, value:value == null || value === '' ? {} : JSON.parse(value) }
  } catch {
    return { ok:false, value:null }
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalJson(value[key])]))
  }
  return value
}

function sameJsonPayload(left, right) {
  return JSON.stringify(canonicalJson(left)) === JSON.stringify(canonicalJson(right))
}

function assertAccountOwnership(current, ownership) {
  if (!ownership || Number(ownership.id) !== Number(current.ownership_history_id)
    || Number(ownership.user_id) !== Number(current.user_id)
    || Number(ownership.trading_account_id) !== Number(current.trading_account_id)
    || ownership.ended_at
    || upper(ownership.broker_server_key) !== upper(current.broker_server_key)
    || ref(ownership.login_account) !== ref(current.login_account)) {
    throw preparationError('position_management_ownership_changed')
  }
}

function assertFinalExitOutcome(current, outcome, expectedState) {
  const expectedVolume = num(expectedState.volume)
  if (!outcome || outcome.status !== 'open' || outcome.attribution_status !== 'attributed'
    || Number(outcome.external_intervention || 0) !== 0
    || ref(outcome.position_id) !== ref(expectedState.ticket)
    || !expectedVolume || expectedVolume <= 0
    || !sameVolume(outcome.expected_volume, expectedVolume)
    || !sameVolume(outcome.entry_volume, expectedVolume)
    || Number(outcome.closed_volume || 0) > 1e-8
    || String(outcome.entry_direction || '').toLowerCase() !== String(expectedState.direction || '').toLowerCase()
    || Number(outcome.system_magic || 0) !== Number(expectedState.magic || 0)) {
    throw preparationError('position_management_outcome_changed')
  }
  if (canonicalSymbol(outcome.original_symbol || outcome.symbol) !== canonicalSymbol(current.original_symbol || current.standard_symbol)
    || canonicalSymbol(expectedState.symbol) !== canonicalSymbol(current.original_symbol || current.standard_symbol)) {
    throw preparationError('position_management_position_identity_changed')
  }
}

function assertFinalPendingOutcome(current, outcome, expectedState) {
  if (!outcome || outcome.status !== 'open'
    || !['pending', 'attributed'].includes(String(outcome.attribution_status || '').toLowerCase())
    || Number(outcome.external_intervention || 0) !== 0
    || ref(outcome.pending_ticket) !== ref(expectedState.ticket)
    || (ref(outcome.position_id) && !isLegacyPendingPositionAlias(outcome))
    || canonicalSymbol(outcome.original_symbol || outcome.symbol) !== canonicalSymbol(current.original_symbol || current.standard_symbol)
    || canonicalSymbol(expectedState.symbol) !== canonicalSymbol(current.original_symbol || current.standard_symbol)) {
    throw preparationError('position_management_pending_outcome_changed')
  }
  const expectedVolume = num(expectedState.volume)
  if (!expectedVolume || expectedVolume <= 0 || !sameVolume(outcome.expected_volume, expectedVolume)) {
    throw preparationError('position_management_pending_outcome_changed')
  }
}

function preparationStatusMatchesTask(taskType, status) {
  if (status === 'PRECONDITIONS_LOCKED') return true
  return taskType === 'pending_cancel'
    ? status === 'PENDING_CANCEL_INTENT'
    : status === 'CLOSE_INTENT_CREATED'
}

function assertPreparationTaskLease(current, task, lease) {
  if (!current || current.status !== 'EVIDENCE_CONFIRMED') throw preparationError('position_management_lock_state_changed')
  if (Number(current.state_version) !== Number(task.state_version)
    || Number(current.fencing_token) !== Number(lease.fencing_token)
    || current.lease_token !== lease.lease_token
    || Number(current.bridge_generation) !== Number(task.bridge_generation)) {
    throw preparationError('position_management_lock_fence_changed')
  }
}

function commandPayloadMatches(command, operationId, commandType, expectedState, request) {
  if (!command || command.operation_id !== operationId
    || command.command_type !== commandType || Number(command.command_sequence) !== 1) return false
  const expected = parseStoredJson(command.expected_state_json)
  const storedRequest = parseStoredJson(command.request_json)
  return expected.ok && storedRequest.ok
    && sameJsonPayload(expected.value, expectedState)
    && sameJsonPayload(storedRequest.value, request)
}

function assertPreparedCommandConsistency(context) {
  const command = context?.command
  const task = context?.task
  const outcome = context?.outcome
  const isPending = task?.task_type === 'pending_cancel'
  const commandType = isPending ? 'cancel_system_pending' : 'close_system_position'
  const expectedOperationId = `PM-${task?.id}-${commandType}-1`
  if (!command || command.operation_id !== expectedOperationId
    || command.command_type !== commandType || Number(command.command_sequence) !== 1) {
    throw preparationError('position_management_command_payload_conflict')
  }
  if (command.send_status !== 'prepared' || command.bridge_command_id) {
    throw preparationError('position_management_command_already_sent')
  }
  const expected = parseStoredJson(command.expected_state_json)
  const request = parseStoredJson(command.request_json)
  const expectedTicket = isPending ? outcome?.pending_ticket : outcome?.position_id
  const expectedDirection = String(outcome?.entry_direction || '').toLowerCase()
  const expectedVolume = num(outcome?.expected_volume)
  if (!expected.ok || !request.ok || !expected.value || !request.value
    || ref(expected.value.ticket) !== ref(expectedTicket)
    || ref(request.value.ticket) !== ref(expectedTicket)
    || canonicalSymbol(expected.value.symbol) !== canonicalSymbol(task?.original_symbol || task?.standard_symbol)
    || String(expected.value.direction || '').toLowerCase() !== expectedDirection
    || Number(expected.value.magic || 0) !== SYSTEM_MAGIC
    || !expectedVolume || !sameVolume(expected.value.volume, expectedVolume)
    || upper(expected.value.broker_server_key) !== upper(task?.broker_server_key)
    || ref(expected.value.login_account) !== ref(task?.login_account)) {
    throw preparationError('position_management_command_payload_conflict')
  }
  return expected.value
}

/**
 * Finalize the precondition lock, intent and deterministic prepared command as
 * one database transaction.  PRECONDITIONS_LOCKED is used only as an
 * uncommitted audit transition; callers never observe it as a stable state.
 */
export async function preparePositionManagementExecution(task, lease, preflight) {
  const isPending = task.task_type === 'pending_cancel'
  const commandType = isPending ? 'cancel_system_pending' : 'close_system_position'
  const intentStatus = isPending ? 'PENDING_CANCEL_INTENT' : 'CLOSE_INTENT_CREATED'
  const intentEvent = isPending ? 'pending_cancel_intent_created' : 'close_intent_created'
  const operationId = `PM-${task.id}-${commandType}-1`
  const expectedState = preflight?.expectedState || {}
  const request = { ticket:expectedState.ticket }
  const prepared = await withTransaction(async run => {
    const [taskRows] = await run('SELECT * FROM ai_position_management_tasks WHERE id = ? FOR UPDATE', [task.id])
    const current = taskRows?.[0]
    assertPreparationTaskLease(current, task, lease)

    const [ownershipRows] = await run(`SELECT * FROM mt5_account_ownership_history
      WHERE id = ? AND user_id = ? AND trading_account_id = ? AND ended_at IS NULL FOR UPDATE`,
    [current.ownership_history_id, current.user_id, current.trading_account_id])
    assertAccountOwnership(current, ownershipRows?.[0])

    const [outcomeRows] = await run('SELECT * FROM signal_outcomes WHERE id = ? FOR UPDATE', [current.outcome_id])
    const outcome = outcomeRows?.[0]
    if (isPending) assertFinalPendingOutcome(current, outcome, expectedState)
    else assertFinalExitOutcome(current, outcome, expectedState)
    if (isPending) {
      const [controlRows] = await run(`SELECT ai_pending_cancel_enabled
        FROM global_position_management_control WHERE id = 1 FOR UPDATE`)
      if (Number(controlRows?.[0]?.ai_pending_cancel_enabled ?? 0) !== 1) {
        throw preparationError('ai_pending_cancel_disabled')
      }
    } else {
      const [controlRows] = await run(`SELECT maximum_mode
        FROM global_position_management_control WHERE id = 1 FOR UPDATE`)
      const [settingRows] = await run(`SELECT execution_mode
        FROM user_position_management_settings WHERE user_id = ? FOR UPDATE`, [current.user_id])
      const finalMode = effectiveRuntimeMode(settingRows?.[0] || {}, controlRows?.[0] || {}, current.execution_mode || 'display')
      if (!['auto_exit', 'auto_reverse'].includes(finalMode)) {
        throw preparationError('formal_exit_not_enabled')
      }
    }
    if (!isPending) await assertNettingOutcomeExclusive(run, current, expectedState)

    const [commandRows] = await run(`SELECT * FROM ai_position_management_commands
      WHERE task_id = ? AND command_type = ? AND command_sequence = ? FOR UPDATE`,
    [current.id, commandType, 1])
    let command = commandRows?.[0] || null
    if (!command) {
      const [operationRows] = await run(`SELECT * FROM ai_position_management_commands
        WHERE operation_id = ? FOR UPDATE`, [operationId])
      if (operationRows?.length) throw preparationError('position_management_command_payload_conflict')
    }
    if (command) {
      if (!commandPayloadMatches(command, operationId, commandType, expectedState, request)) {
        throw preparationError('position_management_command_payload_conflict')
      }
      if (command.send_status !== 'prepared' || command.bridge_command_id) {
        throw preparationError('position_management_command_already_sent')
      }
    }

    const now = beijingNow()
    const [locked] = await run(`UPDATE ai_position_management_tasks
      SET precondition_hash = ?, status = 'PRECONDITIONS_LOCKED', state_version = state_version + 1,
        updated_at = ? WHERE id = ? AND status = 'EVIDENCE_CONFIRMED' AND state_version = ?
        AND fencing_token = ? AND lease_token = ? AND lease_expires_at > NOW()`, [
      preflight.preconditionHash, now, current.id, current.state_version,
      lease.fencing_token, lease.lease_token,
    ])
    if (Number(locked?.affectedRows || 0) !== 1) throw preparationError('position_management_precondition_lock_conflict')
    if (!isPending) {
      const [outcomeUpdate] = await run(`UPDATE signal_outcomes SET status = 'closing', updated_at = ?
        WHERE id = ? AND status = 'open'`, [now, current.outcome_id])
      if (Number(outcomeUpdate?.affectedRows || 0) !== 1) throw preparationError('position_management_outcome_lock_conflict')
    }
    await run(`INSERT INTO ai_position_management_events
      (task_id, from_status, to_status, event_type, summary, details_json, actor_type, created_at)
      VALUES (?, 'EVIDENCE_CONFIRMED', 'PRECONDITIONS_LOCKED', ?, ?, ?, 'worker', ?)`, [
      current.id, isPending ? 'pending_preconditions_locked' : 'preconditions_locked',
      isPending ? '账户归属、Bridge 代际和策略挂单身份已锁定' : '账户归属、Bridge 代际、持仓身份、全量归属与保护状态已锁定',
      JSON.stringify({ precondition_hash:preflight.preconditionHash, expected_state:expectedState }), now,
    ])
    const lockedVersion = Number(current.state_version) + 1
    const [intent] = await run(`UPDATE ai_position_management_tasks
      SET status = ?, state_version = state_version + 1, updated_at = ?
      WHERE id = ? AND status = 'PRECONDITIONS_LOCKED' AND state_version = ?
        AND fencing_token = ? AND lease_token = ? AND lease_expires_at > NOW()`, [
      intentStatus, now, current.id, lockedVersion, lease.fencing_token, lease.lease_token,
    ])
    if (Number(intent?.affectedRows || 0) !== 1) throw preparationError('position_management_intent_conflict')
    await run(`INSERT INTO ai_position_management_events
      (task_id, from_status, to_status, event_type, summary, details_json, actor_type, created_at)
      VALUES (?, 'PRECONDITIONS_LOCKED', ?, ?, ?, ?, 'worker', ?)`, [
      current.id, intentStatus, intentEvent,
      isPending ? '已创建稳定业务操作号对应的挂单取消意图' : '已创建稳定业务操作号对应的平仓意图',
      JSON.stringify({ precondition_hash:preflight.preconditionHash, operation_id:operationId }), now,
    ])

    if (!command) {
      const [inserted] = await run(`INSERT INTO ai_position_management_commands
        (task_id, command_sequence, operation_id, command_type, expected_state_json, request_json,
         send_status, reconciliation_status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'prepared', 'pending', ?, ?)`, [
        current.id, 1, operationId, commandType, JSON.stringify(expectedState), JSON.stringify(request), now, now,
      ])
      if (!Number(inserted?.insertId) && Number(inserted?.affectedRows || 0) !== 1) {
        throw preparationError('position_management_command_prepare_failed')
      }
      command = {
        id:Number(inserted?.insertId) || null,
        task_id:Number(current.id), command_sequence:1, operation_id:operationId,
        command_type:commandType, expected_state_json:JSON.stringify(expectedState),
        request_json:JSON.stringify(request), send_status:'prepared', reconciliation_status:'pending',
        created_at:now, updated_at:now,
      }
    }
    return {
      task:{ ...current, status:intentStatus, state_version:Number(current.state_version) + 2,
        precondition_hash:preflight.preconditionHash, updated_at:now },
      command,
    }
  })
  broadcastPositionManagementTask(prepared.task, intentEvent)
  return prepared
}

export async function recoverInterruptedPreparation(task, lease) {
  const recovered = await withTransaction(async run => {
    const [taskRows] = await run('SELECT * FROM ai_position_management_tasks WHERE id = ? FOR UPDATE', [task.id])
    const current = taskRows?.[0]
    if (!current || !PREPARATION_RECOVERY_STATES.includes(String(current.status))) {
      throw preparationError('position_management_recovery_state_changed')
    }
    if (!preparationStatusMatchesTask(current.task_type, String(current.status))) {
      throw preparationError('position_management_recovery_state_task_type_mismatch')
    }
    if (Number(current.fencing_token) !== Number(lease.fencing_token)
      || current.lease_token !== lease.lease_token) {
      throw preparationError('position_management_recovery_fence_changed')
    }
    const [commands] = await run(`SELECT id, command_type, operation_id, send_status, bridge_command_id
      FROM ai_position_management_commands WHERE task_id = ? FOR UPDATE`, [current.id])
    if (commands?.length) throw preparationError('position_management_recovery_command_exists')
    const [sendEvents] = await run(`SELECT id FROM ai_position_management_events
      WHERE task_id = ? AND event_type IN ('close_send_started', 'pending_cancel_send_started')
      FOR UPDATE`, [current.id])
    if (sendEvents?.length) throw preparationError('position_management_recovery_send_evidence')
    const [outcomeRows] = await run('SELECT * FROM signal_outcomes WHERE id = ? FOR UPDATE', [current.outcome_id])
    const outcome = outcomeRows?.[0]
    if (!outcome) throw preparationError('position_management_recovery_outcome_missing')
    const isPending = current.task_type === 'pending_cancel'
    if (isPending) {
      if (String(outcome.status || '').toLowerCase() !== 'open'
        || (ref(outcome.position_id) && !isLegacyPendingPositionAlias(outcome))) {
        throw preparationError('position_management_recovery_outcome_changed')
      }
    } else if (!['open', 'closing'].includes(String(outcome.status || '').toLowerCase())) {
      throw preparationError('position_management_recovery_outcome_changed')
    } else if (String(outcome.status || '').toLowerCase() === 'closing') {
      const [outcomeUpdate] = await run(`UPDATE signal_outcomes SET status = 'open', updated_at = ?
        WHERE id = ? AND status = 'closing'`, [beijingNow(), current.outcome_id])
      if (Number(outcomeUpdate?.affectedRows || 0) !== 1) {
        throw preparationError('position_management_recovery_outcome_conflict')
      }
    }
    const now = beijingNow()
    const [updated] = await run(`UPDATE ai_position_management_tasks
      SET status = 'EVIDENCE_CONFIRMED', precondition_hash = NULL,
        state_version = state_version + 1, updated_at = ?
      WHERE id = ? AND status = ? AND fencing_token = ? AND lease_token = ?
        AND lease_expires_at > NOW()`, [
      now, current.id, current.status, lease.fencing_token, lease.lease_token,
    ])
    if (Number(updated?.affectedRows || 0) !== 1) throw preparationError('position_management_recovery_conflict')
    await run(`INSERT INTO ai_position_management_events
      (task_id, from_status, to_status, event_type, summary, details_json, actor_type, created_at)
      VALUES (?, ?, 'EVIDENCE_CONFIRMED', 'preparation_recovered', ?, ?, 'worker', ?)`, [
      current.id, current.status, '未发现已持久化命令或发送证据，已恢复并等待完整实时前置校验',
      JSON.stringify({ previous_status:current.status, command_absent:true, send_evidence_absent:true }), now,
    ])
    return { ...current, status:'EVIDENCE_CONFIRMED', precondition_hash:null,
      state_version:Number(current.state_version) + 1, updated_at:now }
  })
  broadcastPositionManagementTask(recovered, 'preparation_recovered')
  return recovered
}

async function markCloseCommandSending(task, lease, command, commandId, bridgeGeneration) {
  const sent = await withTransaction(async run => {
    const [rows] = await run('SELECT * FROM ai_position_management_tasks WHERE id = ? FOR UPDATE', [task.id])
    const current = rows?.[0]
    if (!current || current.status !== 'CLOSE_INTENT_CREATED'
      || Number(current.state_version) !== Number(task.state_version)
      || Number(current.fencing_token) !== Number(lease.fencing_token)
      || current.lease_token !== lease.lease_token
      || Number(current.bridge_generation) !== Number(bridgeGeneration)) {
      throw new Error('position_management_write_guard_conflict')
    }
    await assertNettingOutcomeExclusive(run, current, json(command.expected_state_json, {}))
    const now = beijingNow()
    const [commandUpdate] = await run(`UPDATE ai_position_management_commands
      SET send_status = 'sending', bridge_command_id = ?, updated_at = ?
      WHERE id = ? AND operation_id = ? AND send_status = 'prepared'`,
    [commandId, now, command.id, command.operation_id])
    if (Number(commandUpdate?.affectedRows || 0) !== 1) throw new Error('position_management_command_send_conflict')
    const [taskUpdate] = await run(`UPDATE ai_position_management_tasks
      SET status = 'CLOSE_SENT', state_version = state_version + 1, updated_at = ?
      WHERE id = ? AND status = 'CLOSE_INTENT_CREATED' AND state_version = ?
        AND fencing_token = ? AND lease_token = ? AND lease_expires_at > NOW()`, [
      now, current.id, current.state_version, lease.fencing_token, lease.lease_token,
    ])
    if (Number(taskUpdate?.affectedRows || 0) !== 1) throw new Error('position_management_command_task_conflict')
    await run(`INSERT INTO ai_position_management_events
      (task_id, from_status, to_status, event_type, summary, details_json, actor_type, created_at)
      VALUES (?, 'CLOSE_INTENT_CREATED', 'CLOSE_SENT', 'close_send_started', ?, ?, 'worker', ?)`, [
      current.id, '安全平仓命令已通过最终 fencing 校验并写入 Bridge',
      JSON.stringify({ operation_id:command.operation_id, bridge_command_id:commandId,
        bridge_generation:Number(bridgeGeneration) }), now,
    ])
    return { ...current, status:'CLOSE_SENT', state_version:Number(current.state_version) + 1, updated_at:now }
  })
  broadcastPositionManagementTask(sent, 'close_send_started')
  return sent
}

async function markPendingCancelSending(task, lease, command, commandId, bridgeGeneration) {
  const sent = await withTransaction(async run => {
    const [controlRows] = await run(`SELECT ai_pending_cancel_enabled
      FROM global_position_management_control WHERE id = 1 FOR UPDATE`)
    if (Number(controlRows?.[0]?.ai_pending_cancel_enabled ?? 0) !== 1) {
      throw new Error('ai_pending_cancel_disabled')
    }
    const [rows] = await run('SELECT * FROM ai_position_management_tasks WHERE id = ? FOR UPDATE', [task.id])
    const current = rows?.[0]
    if (!current || current.status !== 'PENDING_CANCEL_INTENT'
      || Number(current.state_version) !== Number(task.state_version)
      || Number(current.fencing_token) !== Number(lease.fencing_token)
      || current.lease_token !== lease.lease_token
      || Number(current.bridge_generation) !== Number(bridgeGeneration)) {
      throw new Error('position_management_pending_write_guard_conflict')
    }
    const now = beijingNow()
    const [commandUpdate] = await run(`UPDATE ai_position_management_commands
      SET send_status = 'sending', bridge_command_id = ?, updated_at = ?
      WHERE id = ? AND operation_id = ? AND send_status = 'prepared'`,
    [commandId, now, command.id, command.operation_id])
    if (Number(commandUpdate?.affectedRows || 0) !== 1) throw new Error('position_management_pending_command_send_conflict')
    const [taskUpdate] = await run(`UPDATE ai_position_management_tasks
      SET status = 'PENDING_CANCEL_SENT', state_version = state_version + 1, updated_at = ?
      WHERE id = ? AND status = 'PENDING_CANCEL_INTENT' AND state_version = ?
        AND fencing_token = ? AND lease_token = ? AND lease_expires_at > NOW()`, [
      now, current.id, current.state_version, lease.fencing_token, lease.lease_token,
    ])
    if (Number(taskUpdate?.affectedRows || 0) !== 1) throw new Error('position_management_pending_task_conflict')
    await run(`INSERT INTO ai_position_management_events
      (task_id, from_status, to_status, event_type, summary, details_json, actor_type, created_at)
      VALUES (?, 'PENDING_CANCEL_INTENT', 'PENDING_CANCEL_SENT', 'pending_cancel_send_started', ?, ?, 'worker', ?)`, [
      current.id, '挂单取消命令已通过最终 fencing 校验并写入 Bridge',
      JSON.stringify({ operation_id:command.operation_id, bridge_command_id:commandId,
        bridge_generation:Number(bridgeGeneration) }), now,
    ])
    return { ...current, status:'PENDING_CANCEL_SENT', state_version:Number(current.state_version) + 1, updated_at:now }
  })
  broadcastPositionManagementTask(sent, 'pending_cancel_send_started')
  return sent
}

async function saveCommandResult(command, result) {
  const status = result?.status === 'success' || result?.status === 'partial' ? 'acknowledged'
    : result?.status === 'rejected' ? 'rejected' : 'uncertain'
  await queryRun(`UPDATE ai_position_management_commands
    SET send_status = ?, bridge_result_json = ?, updated_at = ?
    WHERE id = ? AND operation_id = ?`, [status, JSON.stringify(result || {}), beijingNow(), command.id, command.operation_id])
}

async function currentCommandExpectedState(command) {
  try { return JSON.parse(command?.expected_state_json || '{}') } catch { return {} }
}

async function persistPendingTerminalState(context, result) {
  const now = beijingNow()
  await withTransaction(async run => {
    if (result.status === 'confirmed') {
      const terminalState = ['cancelled', 'expired', 'rejected'].includes(result.final_state)
        ? result.final_state : 'cancelled'
      await run(`UPDATE signal_outcomes SET status = ?, attribution_status = 'not_filled',
        last_scan_at = ?, updated_at = ? WHERE id = ? AND position_id IS NULL`,
      [terminalState, now, now, context.outcome.id])
      if (context.outcome.delivery_id) await run(`UPDATE auto_signal_deliveries
        SET pending_state = ? WHERE id = ? AND pending_state = 'pending'`,
      [terminalState, context.outcome.delivery_id])
      if (context.outcome.signal_id) await run(`UPDATE ai_signals SET pending_state = ?
        WHERE id = ? AND pending_state = 'pending'`, [terminalState, context.outcome.signal_id])
      await run(`UPDATE ai_trade_theses theses SET theses.status = 'closed', theses.updated_at = ?
        WHERE theses.thesis_id = ? AND NOT EXISTS (
          SELECT 1 FROM signal_outcomes outcomes
          WHERE outcomes.thesis_id = theses.thesis_id AND outcomes.status IN ('open','closing'))`,
      [now, context.task.thesis_id])
      return
    }
    if (result.status === 'filled') {
      await run(`UPDATE signal_outcomes SET position_id = COALESCE(?, position_id),
        status = 'open', attribution_status = 'pending', last_scan_at = ?, updated_at = ? WHERE id = ?`,
      [result.position_id || null, now, now, context.outcome.id])
      if (context.outcome.delivery_id) await run(`UPDATE auto_signal_deliveries
        SET pending_state = 'filled', is_executed = 1, trade_ticket = COALESCE(?, trade_ticket),
          executed_at = COALESCE(executed_at, ?) WHERE id = ?`,
      [result.position_id || null, now, context.outcome.delivery_id])
      if (context.outcome.signal_id) await run(`UPDATE ai_signals
        SET pending_state = 'filled', is_executed = 1, trade_ticket = COALESCE(?, trade_ticket),
          executed_at = COALESCE(executed_at, ?) WHERE id = ?`,
      [result.position_id || null, now, context.outcome.signal_id])
    }
  })
}

async function reconcilePendingCancelTask(context, lease, bridge = mt5Bridge) {
  let task = context.task
  const command = context.command
  if (!command) {
    if (task.status === 'PENDING_CANCEL_INTENT') {
      return transition(task, lease, 'FAILED', 'pending_cancel_command_missing',
        '挂单取消意图缺少持久化命令，已安全终止')
    }
    return null
  }
  if (task.status === 'PENDING_CANCEL_SENT' || task.status === 'PENDING_UNCERTAIN') {
    task = await transition(task, lease, 'PENDING_RECONCILING', 'pending_reconciliation_started',
      '正在查询 MT5 挂单历史终态，本任务只复核、不重发', { operation_id:command.operation_id })
  }
  if (task.status !== 'PENDING_RECONCILING') return task

  const expectedState = await currentCommandExpectedState(command)
  const state = await bridge(task.user_id, 'pending_order_state', {
    ticket:expectedState.ticket, expected_state:expectedState,
  }, { noFallback:true, timeoutMs:10_000, expectedGeneration:Number(task.bridge_generation) })
  const result = classifyPendingCancelReconciliation({
    ...task, expected_state_json:command.expected_state_json,
  }, state)
  if (result.status === 'confirmed') {
    await persistPendingTerminalState(context, result)
    await queryRun(`UPDATE ai_position_management_commands
      SET reconciliation_status = 'confirmed', reconciled_at = ?, updated_at = ? WHERE id = ?`,
    [beijingNow(), beijingNow(), command.id])
    task = await transition(task, lease, 'PENDING_CANCEL_CONFIRMED', 'pending_cancel_confirmed',
      'MT5 已确认目标挂单终止且没有形成持仓', result)
    return transition(task, lease, 'COMPLETED', 'pending_cancel_completed',
      '策略挂单取消流程已完成', { operation_id:command.operation_id, final_state:result.final_state })
  }
  if (result.status === 'filled') {
    await persistPendingTerminalState(context, result)
    await queryRun(`UPDATE ai_position_management_commands
      SET reconciliation_status = 'filled_during_cancel', reconciled_at = ?, updated_at = ? WHERE id = ?`,
    [beijingNow(), beijingNow(), command.id])
    task = await transition(task, lease, 'PENDING_FILLED_DURING_CANCEL', 'pending_filled_during_cancel',
      '挂单在取消窗口内已经成交，已停止自动处理并转人工复核', result)
    return transition(task, lease, 'MANUAL_REVIEW', 'manual_review_required',
      '需要核对新持仓保护状态；系统不会自动平仓、重发或反向开仓', result)
  }

  await queryRun(`UPDATE ai_position_management_commands
    SET reconciliation_status = ?, updated_at = ? WHERE id = ?`,
  [result.status === 'active' ? 'still_active' : 'pending', beijingNow(), command.id])
  task = await transition(task, lease, 'PENDING_UNCERTAIN', 'pending_reconciliation_uncertain',
    result.status === 'active' ? '目标挂单仍在 MT5 中，系统不会重复发送取消命令' : 'MT5 挂单终态暂不可用，稍后只做状态复核', result)
  const createdAt = parseBeijing(command.created_at)
  const tooOld = createdAt && Date.now() - createdAt.getTime() >= 60_000
  if (result.status === 'manual_review' || command.send_status === 'rejected' || tooOld) {
    return transition(task, lease, 'MANUAL_REVIEW', 'manual_review_required',
      '挂单取消结果长时间未确认或身份发生变化，需要人工复核；系统不会自动重发', result)
  }
  return task
}

async function reconcileCloseTask(context, lease, bridge = mt5Bridge) {
  let task = context.task
  const command = context.command
  if (!command) {
    if (task.status === 'CLOSE_INTENT_CREATED') {
      return transition(task, lease, 'FAILED', 'close_command_missing', '平仓意图缺少持久化命令，已安全终止')
    }
    return null
  }
  if (task.status === 'CLOSE_SENT' || task.status === 'CLOSE_PARTIAL' || task.status === 'CLOSE_UNCERTAIN') {
    task = await transition(task, lease, 'CLOSE_RECONCILING', 'close_reconciliation_started',
      '正在使用 MT5 当前持仓状态复核平仓结果', { operation_id:command.operation_id })
  }
  if (task.status !== 'CLOSE_RECONCILING') return task

  const inventory = await bridge(task.user_id, 'system_trade_inventory', {}, { noFallback:true, timeoutMs:10_000 })
  const expectedState = await currentCommandExpectedState(command)
  const result = classifyCloseReconciliation({ ...task, expected_state_json:command.expected_state_json,
    position_id:expectedState.ticket }, inventory)
  if (result.status === 'unavailable') {
    await queryRun(`UPDATE ai_position_management_commands SET reconciliation_status = 'pending', updated_at = ?
      WHERE id = ?`, [beijingNow(), command.id])
    return transition(task, lease, 'CLOSE_UNCERTAIN', 'close_reconciliation_unavailable',
      'MT5 当前持仓状态暂不可用，本任务只复核、不重发', result)
  }
  if (result.status === 'confirmed') {
    await queryRun(`UPDATE ai_position_management_commands
      SET reconciliation_status = 'confirmed', reconciled_at = ?, updated_at = ? WHERE id = ?`,
    [beijingNow(), beijingNow(), command.id])
    task = await transition(task, lease, 'CLOSE_CONFIRMED', 'close_confirmed',
      'MT5 已确认目标持仓不存在，平仓完成', result)
    task = await transition(task, lease, 'EXIT_ONLY_COMPLETED', 'exit_only_completed',
      '自动平仓流程完成；本阶段不会自动反向开仓', { operation_id:command.operation_id })
    return task
  }

  const intermediate = result.status === 'partial' ? 'CLOSE_PARTIAL' : 'CLOSE_UNCERTAIN'
  await queryRun(`UPDATE ai_position_management_commands
    SET reconciliation_status = ?, reconciled_at = ?, updated_at = ? WHERE id = ?`,
  [result.status === 'partial' ? 'partial' : 'manual_review', beijingNow(), beijingNow(), command.id])
  task = await transition(task, lease, intermediate,
    result.status === 'partial' ? 'close_partial' : 'close_not_confirmed',
    result.status === 'partial' ? 'MT5 显示目标持仓仅部分平仓，禁止自动重发' : 'MT5 未确认目标持仓平仓，禁止自动重发', result)
  return transition(task, lease, 'MANUAL_REVIEW', 'manual_review_required',
    '平仓结果需要人工复核；系统不会自动重发或反向开仓', result)
}

async function executePreparedClose(context, lease, bridge = mt5Bridge) {
  let { task, command } = context
  if (!command) {
    return transition(task, lease, 'FAILED', 'close_command_missing',
      '平仓意图缺少持久化命令，已拒绝向 MT5 发送任何命令')
  }
  const expectedState = await currentCommandExpectedState(command)
  const params = {
    ticket:expectedState.ticket,
    operation_id:command.operation_id,
    expected_state:expectedState,
    comment:'AI持仓管理平仓',
  }
  const result = await bridge(task.user_id, 'close_system_position', params, {
    noFallback:true,
    timeoutMs:15_000,
    expectedGeneration:Number(task.bridge_generation),
    beforeWrite:async ({ commandId, bridgeGeneration }) => {
      task = await markCloseCommandSending(task, lease, command, commandId, bridgeGeneration)
      return true
    },
  })
  await saveCommandResult(command, result)
  const latest = await loadTaskContext(task.id)
  if (!latest) return null
  if (latest.task.status === 'CLOSE_INTENT_CREATED') {
    return transition(latest.task, lease, 'FAILED', 'close_send_blocked',
      '平仓命令在写入 Bridge 前被安全校验阻止', result)
  }
  return reconcileCloseTask(latest, lease, bridge)
}

async function executePreparedPendingCancel(context, lease, bridge = mt5Bridge) {
  let { task, command } = context
  if (!command) {
    return transition(task, lease, 'FAILED', 'pending_cancel_command_missing',
      '挂单取消意图缺少持久化命令，已拒绝向 MT5 发送任何命令')
  }
  const expectedState = await currentCommandExpectedState(command)
  const result = await bridge(task.user_id, 'cancel_system_pending', {
    ticket:expectedState.ticket,
    operation_id:command.operation_id,
    expected_state:expectedState,
  }, {
    noFallback:true,
    timeoutMs:15_000,
    expectedGeneration:Number(task.bridge_generation),
    beforeWrite:async ({ commandId, bridgeGeneration }) => {
      task = await markPendingCancelSending(task, lease, command, commandId, bridgeGeneration)
      return true
    },
  })
  await saveCommandResult(command, result)
  const latest = await loadTaskContext(task.id)
  if (!latest) return null
  if (latest.task.status === 'PENDING_CANCEL_INTENT') {
    return transition(latest.task, lease, 'FAILED', 'pending_cancel_send_blocked',
      '挂单取消命令在写入 Bridge 前被安全校验阻止', result)
  }
  return reconcilePendingCancelTask(latest, lease, bridge)
}

async function preparePendingCancelTask(context, lease, bridge = mt5Bridge) {
  let { task } = context
  const expiry = parseBeijing(task.candidate_expires_at)
  if (expiry && expiry.getTime() <= Date.now()) {
    return transition(task, lease, 'EXPIRED', 'candidate_expired', '挂单取消候选已过期，不再执行')
  }
  if (context.activeTask) {
    return transition(task, lease, 'REJECTED', 'duplicate_active_task',
      '同一策略挂单已有进行中的取消任务，本候选已拒绝', context.activeTask)
  }
  if (Number(context.control?.ai_pending_cancel_enabled ?? 0) !== 1) {
    return transition(task, lease, 'HELD', 'ai_pending_cancel_disabled',
      '平台已关闭 AI 自动取消挂单，本候选保持不执行')
  }
  if (!isBridgeAlive(Number(task.user_id))) return null
  const currentGeneration = getBridgeGeneration(Number(task.user_id))
  const inventory = await bridge(task.user_id, 'system_trade_inventory', {}, {
    noFallback:true, timeoutMs:10_000,
  })
  const preflight = validatePendingCancelPreconditions({ ...context, inventory, currentGeneration })
  if (!preflight.ok) {
    if (preflight.retryable) return null
    return transition(task, lease, preflight.targetAbsent ? 'REJECTED' : 'REJECTED',
      'pending_cancel_precondition_rejected', '自动取消前置条件未通过，未向 MT5 发送任何命令', preflight)
  }
  const prepared = await preparePositionManagementExecution(task, lease, preflight)
  return executePreparedPendingCancel({ ...context, task:prepared.task, command:prepared.command }, lease, bridge)
}

async function prepareExitTask(context, lease, bridge = mt5Bridge) {
  let { task } = context
  const expiry = parseBeijing(task.candidate_expires_at)
  if (expiry && expiry.getTime() <= Date.now()) {
    return transition(task, lease, 'EXPIRED', 'candidate_expired', '平仓候选已过期，不再执行')
  }
  if (context.activeTask) {
    return transition(task, lease, 'REJECTED', 'duplicate_active_task',
      '同一持仓已有进行中的自动平仓任务，本候选已拒绝', context.activeTask)
  }
  const mode = resolvePositionManagementRuntimeMode(task, context.setting, context.control)
  if (!['auto_exit', 'auto_reverse'].includes(mode)) {
    return transition(task, lease, 'HELD', 'formal_execution_disabled',
      '平台总闸或用户设置未允许正式自动平仓，本候选保持不执行')
  }
  if (!isBridgeAlive(Number(task.user_id))) return null
  const currentGeneration = getBridgeGeneration(Number(task.user_id))
  const inventory = await bridge(task.user_id, 'system_trade_inventory', {}, {
    noFallback:true, timeoutMs:10_000,
  })
  const preflight = validateExitOnlyPreconditions({ ...context, inventory, currentGeneration })
  if (!preflight.ok) {
    if (preflight.retryable) return null
    return transition(task, lease, preflight.targetAbsent ? 'EXPIRED' : 'REJECTED',
      'exit_precondition_rejected', '自动平仓前置条件未通过，未向 MT5 发送任何命令', preflight)
  }
  const prepared = await preparePositionManagementExecution(task, lease, preflight)
  return executePreparedClose({ ...context, task:prepared.task, command:prepared.command }, lease, bridge)
}

const PREPARATION_SAFETY_ERRORS = new Set([
  'position_management_command_payload_conflict',
  'position_management_command_already_sent',
  'position_management_recovery_command_exists',
  'position_management_recovery_send_evidence',
  'position_management_recovery_state_changed',
  'position_management_recovery_state_task_type_mismatch',
  'position_management_recovery_outcome_changed',
  'position_management_recovery_outcome_conflict',
  'position_management_recovery_outcome_missing',
  'position_management_recovery_conflict',
])

function isPreparationSafetyError(error) {
  return PREPARATION_SAFETY_ERRORS.has(String(error?.code || error?.message || ''))
}

async function failClosedPreparation(context, lease, error) {
  if (!context?.task || !canFailClosedFromPreparation(context.task.status)) return null
  return transition(context.task, lease, 'MANUAL_REVIEW', 'manual_review_required',
    '持仓管理准备阶段发现不可能或已发送状态，已停止自动处理并转人工复核', {
      code:String(error?.code || error?.message || 'position_management_preparation_unsafe'),
    })
}

function canFailClosedFromPreparation(status) {
  return ['EVIDENCE_CONFIRMED', ...PREPARATION_RECOVERY_STATES].includes(String(status || ''))
}

function isCrossTaskTypeIntent(task) {
  return (task?.task_type === 'pending_cancel' && task.status === 'CLOSE_INTENT_CREATED')
    || (task?.task_type !== 'pending_cancel' && task.status === 'PENDING_CANCEL_INTENT')
}

async function processTask(taskId, bridge) {
  const lease = await claimPositionManagementLease(taskId, LEASE_SECONDS)
  if (!lease) return false
  let context = null
  try {
    context = await loadTaskContext(taskId)
    if (!context) return false
    if (isCrossTaskTypeIntent(context.task)) {
      await failClosedPreparation(context, lease,
        preparationError('position_management_state_task_type_mismatch'))
      return true
    }
    if (context.task.task_type === 'pending_cancel') {
      if (context.task.status === 'EVIDENCE_CONFIRMED') await preparePendingCancelTask(context, lease, bridge)
      else if (context.task.status === 'PRECONDITIONS_LOCKED') {
        if (context.command) await failClosedPreparation(context, lease,
          preparationError('position_management_recovery_command_exists'))
        else await recoverInterruptedPreparation(context.task, lease)
      } else if (context.task.status === 'PENDING_CANCEL_INTENT') {
        if (context.command?.send_status === 'prepared') {
          assertPreparedCommandConsistency(context)
          await executePreparedPendingCancel(context, lease, bridge)
        }
        else if (context.command) await failClosedPreparation(context, lease,
          preparationError('position_management_command_already_sent'))
        else await recoverInterruptedPreparation(context.task, lease)
      } else if (PENDING_RECOVERY_STATES.includes(context.task.status)) {
        await reconcilePendingCancelTask(context, lease, bridge)
      }
    } else {
      if (context.task.status === 'EVIDENCE_CONFIRMED') await prepareExitTask(context, lease, bridge)
      else if (context.task.status === 'PRECONDITIONS_LOCKED') {
        if (context.command) await failClosedPreparation(context, lease,
          preparationError('position_management_recovery_command_exists'))
        else await recoverInterruptedPreparation(context.task, lease)
      } else if (context.task.status === 'CLOSE_INTENT_CREATED') {
        if (context.command?.send_status === 'prepared') {
          assertPreparedCommandConsistency(context)
          await executePreparedClose(context, lease, bridge)
        }
        else if (context.command) await failClosedPreparation(context, lease,
          preparationError('position_management_command_already_sent'))
        else await recoverInterruptedPreparation(context.task, lease)
      } else if (CLOSE_RECOVERY_STATES.includes(context.task.status)) {
        await reconcileCloseTask(context, lease, bridge)
      }
    }
    return true
  } catch (error) {
    if (isPreparationSafetyError(error)) await failClosedPreparation(context, lease, error).catch(() => {})
    throw error
  } finally {
    await releaseLease(taskId, lease.lease_token).catch(() => {})
  }
}

export async function runPositionManagementWorkerOnce({ bridge = mt5Bridge, limit = 10 } = {}) {
  if (workerRunning) return { skipped:true, reason:'worker_already_running' }
  workerRunning = true
  runtimeStatus.running = true
  runtimeStatus.last_started_at = beijingNow()
  runtimeStatus.last_error = null
  let processed = 0
  try {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 10, 50))
    processed += await expireInactiveAutomaticExitCandidates(safeLimit)
    const states = [...new Set(['EVIDENCE_CONFIRMED', ...PREPARATION_RECOVERY_STATES,
      ...CLOSE_RECOVERY_STATES, ...PENDING_RECOVERY_STATES])]
    const rows = await queryAll(`SELECT id FROM ai_position_management_tasks
      WHERE task_type IN ('position_exit','pending_cancel')
        AND status IN (${states.map(() => '?').join(',')})
        AND (lease_token IS NULL OR lease_expires_at < NOW())
        AND (status <> 'EVIDENCE_CONFIRMED' OR execution_mode IN ('auto_exit','auto_reverse'))
      ORDER BY updated_at ASC, id ASC LIMIT ?`, [...states, safeLimit])
    for (const row of rows) {
      try {
        if (await processTask(Number(row.id), bridge)) processed += 1
      } catch (error) {
        runtimeStatus.last_error = error.message
        const transition = error?.fromStatus && error?.toStatus
          ? ` from=${error.fromStatus} to=${error.toStatus}` : ''
        console.error(`[PositionManagementWorker] task=${row.id}:`, `${error.message}${transition}`)
      }
    }
    runtimeStatus.processed += processed
    return { skipped:false, processed }
  } finally {
    workerRunning = false
    runtimeStatus.running = false
    runtimeStatus.last_finished_at = beijingNow()
  }
}

export function startPositionManagementWorker(intervalMs = WORKER_INTERVAL_MS) {
  if (workerTimer) return
  const run = () => runPositionManagementWorkerOnce()
    .catch(error => {
      runtimeStatus.last_error = error.message
      console.error('[PositionManagementWorker]', error.message)
    })
  workerTimer = setInterval(run, Math.max(5_000, Number(intervalMs) || WORKER_INTERVAL_MS))
  workerTimer.unref?.()
  run()
  console.log('[PositionManagementWorker] Started in guarded exit and pending-cancel mode')
}

export function stopPositionManagementWorker() {
  if (workerTimer) clearInterval(workerTimer)
  workerTimer = null
}

export function getPositionManagementWorkerStatus() {
  return { ...runtimeStatus, timer_active:Boolean(workerTimer) }
}
