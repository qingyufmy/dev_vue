import crypto from 'node:crypto'
import { beijingNow, parseBeijing, queryAll, queryOne, queryRun, withTransaction } from '../../db.js'
import { getBridgeGeneration, isBridgeAlive } from '../../bridge-ws.js'
import { mt5Bridge } from './market-data.js'
import { stripBrokerSuffix } from './utils.js'
import {
  broadcastPositionManagementTask,
  claimPositionManagementLease,
  createPositionManagementCommand,
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

async function lockExitPreconditions(task, lease, preflight) {
  const locked = await withTransaction(async run => {
    const [taskRows] = await run('SELECT * FROM ai_position_management_tasks WHERE id = ? FOR UPDATE', [task.id])
    const current = taskRows?.[0]
    if (!current || current.status !== 'EVIDENCE_CONFIRMED') throw new Error('position_management_lock_state_changed')
    if (Number(current.state_version) !== Number(task.state_version)
      || Number(current.fencing_token) !== Number(lease.fencing_token)
      || current.lease_token !== lease.lease_token) {
      throw new Error('position_management_lock_fence_changed')
    }
    const [ownershipRows] = await run(`SELECT id FROM mt5_account_ownership_history
      WHERE id = ? AND user_id = ? AND trading_account_id = ? AND ended_at IS NULL FOR UPDATE`,
    [current.ownership_history_id, current.user_id, current.trading_account_id])
    if (!ownershipRows?.[0]) throw new Error('position_management_ownership_changed')
    const [outcomeRows] = await run(`SELECT id, status, attribution_status, external_intervention
      FROM signal_outcomes WHERE id = ? FOR UPDATE`, [current.outcome_id])
    const outcome = outcomeRows?.[0]
    if (!outcome || outcome.status !== 'open' || outcome.attribution_status !== 'attributed'
      || Number(outcome.external_intervention || 0) !== 0) {
      throw new Error('position_management_outcome_changed')
    }
    await assertNettingOutcomeExclusive(run, current, preflight.expectedState)
    const now = beijingNow()
    const [updated] = await run(`UPDATE ai_position_management_tasks
      SET precondition_hash = ?, status = 'PRECONDITIONS_LOCKED', state_version = state_version + 1,
        updated_at = ? WHERE id = ? AND status = 'EVIDENCE_CONFIRMED' AND state_version = ?
        AND fencing_token = ? AND lease_token = ? AND lease_expires_at > NOW()`, [
      preflight.preconditionHash, now, current.id, current.state_version,
      lease.fencing_token, lease.lease_token,
    ])
    if (Number(updated?.affectedRows || 0) !== 1) throw new Error('position_management_precondition_lock_conflict')
    await run(`UPDATE signal_outcomes SET status = 'closing', updated_at = ?
      WHERE id = ? AND status = 'open'`, [now, current.outcome_id])
    await run(`INSERT INTO ai_position_management_events
      (task_id, from_status, to_status, event_type, summary, details_json, actor_type, created_at)
      VALUES (?, 'EVIDENCE_CONFIRMED', 'PRECONDITIONS_LOCKED', 'preconditions_locked', ?, ?, 'worker', ?)`, [
      current.id, '账户归属、Bridge 代际、持仓身份、全量归属与保护状态已锁定',
      JSON.stringify({ precondition_hash:preflight.preconditionHash, expected_state:preflight.expectedState }), now,
    ])
    return {
      ...current,
      status:'PRECONDITIONS_LOCKED',
      state_version:Number(current.state_version) + 1,
      precondition_hash:preflight.preconditionHash,
      precondition_json:JSON.stringify(preflight.expectedState),
      updated_at:now,
    }
  })
  broadcastPositionManagementTask(locked, 'preconditions_locked')
  return locked
}

async function lockPendingPreconditions(task, lease, preflight) {
  const locked = await withTransaction(async run => {
    const [taskRows] = await run('SELECT * FROM ai_position_management_tasks WHERE id = ? FOR UPDATE', [task.id])
    const current = taskRows?.[0]
    if (!current || current.status !== 'EVIDENCE_CONFIRMED') throw new Error('position_management_lock_state_changed')
    if (Number(current.state_version) !== Number(task.state_version)
      || Number(current.fencing_token) !== Number(lease.fencing_token)
      || current.lease_token !== lease.lease_token) {
      throw new Error('position_management_lock_fence_changed')
    }
    const [ownershipRows] = await run(`SELECT id FROM mt5_account_ownership_history
      WHERE id = ? AND user_id = ? AND trading_account_id = ? AND ended_at IS NULL FOR UPDATE`,
    [current.ownership_history_id, current.user_id, current.trading_account_id])
    if (!ownershipRows?.[0]) throw new Error('position_management_ownership_changed')
    const [outcomeRows] = await run(`SELECT id, status, attribution_status, external_intervention,
        pending_ticket, position_id, entry_deal_ticket
      FROM signal_outcomes WHERE id = ? FOR UPDATE`, [current.outcome_id])
    const outcome = outcomeRows?.[0]
    if (!outcome || outcome.status !== 'open'
      || (ref(outcome.position_id) && !isLegacyPendingPositionAlias(outcome))
      || ref(outcome.pending_ticket) !== ref(preflight.expectedState.ticket)
      || Number(outcome.external_intervention || 0) !== 0) {
      throw new Error('position_management_pending_outcome_changed')
    }
    const now = beijingNow()
    const [updated] = await run(`UPDATE ai_position_management_tasks
      SET precondition_hash = ?, status = 'PRECONDITIONS_LOCKED', state_version = state_version + 1,
        updated_at = ? WHERE id = ? AND status = 'EVIDENCE_CONFIRMED' AND state_version = ?
        AND fencing_token = ? AND lease_token = ? AND lease_expires_at > NOW()`, [
      preflight.preconditionHash, now, current.id, current.state_version,
      lease.fencing_token, lease.lease_token,
    ])
    if (Number(updated?.affectedRows || 0) !== 1) throw new Error('position_management_precondition_lock_conflict')
    await run(`INSERT INTO ai_position_management_events
      (task_id, from_status, to_status, event_type, summary, details_json, actor_type, created_at)
      VALUES (?, 'EVIDENCE_CONFIRMED', 'PRECONDITIONS_LOCKED', 'pending_preconditions_locked', ?, ?, 'worker', ?)`, [
      current.id, '账户归属、Bridge 代际和策略挂单身份已锁定',
      JSON.stringify({ precondition_hash:preflight.preconditionHash, expected_state:preflight.expectedState }), now,
    ])
    return {
      ...current, status:'PRECONDITIONS_LOCKED', state_version:Number(current.state_version) + 1,
      precondition_hash:preflight.preconditionHash,
      precondition_json:JSON.stringify(preflight.expectedState), updated_at:now,
    }
  })
  broadcastPositionManagementTask(locked, 'pending_preconditions_locked')
  return locked
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
  task = await lockPendingPreconditions(task, lease, preflight)
  task = await transition(task, lease, 'PENDING_CANCEL_INTENT', 'pending_cancel_intent_created',
    '已创建稳定业务操作号对应的挂单取消意图', { precondition_hash:preflight.preconditionHash })
  const command = await createPositionManagementCommand({
    taskId:task.id,
    commandType:'cancel_system_pending',
    commandSequence:1,
    expectedState:preflight.expectedState,
    request:{ ticket:preflight.expectedState.ticket },
  })
  return executePreparedPendingCancel({ ...context, task, command }, lease, bridge)
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
  task = await lockExitPreconditions(task, lease, preflight)
  task = await transition(task, lease, 'CLOSE_INTENT_CREATED', 'close_intent_created',
    '已创建稳定业务操作号对应的平仓意图', { precondition_hash:preflight.preconditionHash })
  const command = await createPositionManagementCommand({
    taskId:task.id,
    commandType:'close_system_position',
    commandSequence:1,
    expectedState:preflight.expectedState,
    request:{ ticket:preflight.expectedState.ticket },
  })
  return executePreparedClose({ ...context, task, command }, lease, bridge)
}

async function processTask(taskId, bridge) {
  const lease = await claimPositionManagementLease(taskId, LEASE_SECONDS)
  if (!lease) return false
  try {
    const context = await loadTaskContext(taskId)
    if (!context) return false
    if (context.task.task_type === 'pending_cancel') {
      if (context.task.status === 'EVIDENCE_CONFIRMED') await preparePendingCancelTask(context, lease, bridge)
      else if (context.task.status === 'PENDING_CANCEL_INTENT' && context.command?.send_status === 'prepared') {
        await executePreparedPendingCancel(context, lease, bridge)
      } else if (PENDING_RECOVERY_STATES.includes(context.task.status)) {
        await reconcilePendingCancelTask(context, lease, bridge)
      }
    } else {
      if (context.task.status === 'EVIDENCE_CONFIRMED') await prepareExitTask(context, lease, bridge)
      else if (context.task.status === 'CLOSE_INTENT_CREATED' && context.command?.send_status === 'prepared') {
        await executePreparedClose(context, lease, bridge)
      } else if (CLOSE_RECOVERY_STATES.includes(context.task.status)) {
        await reconcileCloseTask(context, lease, bridge)
      }
    }
    return true
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
    const states = [...new Set(['EVIDENCE_CONFIRMED', ...CLOSE_RECOVERY_STATES, ...PENDING_RECOVERY_STATES])]
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
