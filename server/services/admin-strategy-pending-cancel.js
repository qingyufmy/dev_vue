import crypto from 'node:crypto'
import { beijingNow, queryAll, queryOne, withTransaction } from '../db.js'
import { isBridgeAlive, isTradeEnabled } from '../bridge-ws.js'
import { mt5Bridge } from '../routes/ai/market-data.js'
import { stripBrokerSuffix } from '../routes/ai/utils.js'
import { ADMIN_STRATEGY_TRADE_MAGIC } from './admin-strategy-trades.js'

export const ADMIN_PENDING_CANCEL_SOURCE = 'admin_strategy_pending_cancel'
function text(value) { return String(value ?? '').trim() }
function json(value, fallback = {}) {
  if (value && typeof value === 'object') return value
  try { return value ? JSON.parse(value) : fallback } catch { return fallback }
}
function canonicalSymbol(value) { return stripBrokerSuffix(text(value)).toUpperCase() }
function ref(value) { return text(value) || null }
function number(value, fallback = 0) {
  const result = Number(value)
  return Number.isFinite(result) ? result : fallback
}
function fail(code, details = {}) {
  const error = new Error(code)
  error.code = code
  error.reason = code
  error.details = details
  return error
}
function normalizeId(value, name) {
  const id = Number(value)
  if (!Number.isSafeInteger(id) || id <= 0) throw fail(`${name}_invalid`)
  return id
}
function normalizeKey(body = {}, headers = {}) {
  const value = text(body.idempotency_key || body.client_request_id || headers['idempotency-key']) || crypto.randomUUID()
  if (value.length > 191) throw fail('idempotency_key_invalid')
  return value
}
function sameVolume(left, right) { return Math.abs(number(left) - number(right)) <= 1e-8 }

function expectedPendingType(direction, entryMethod) {
  const side = text(direction).toLowerCase()
  if (entryMethod === 'limit') return side === 'buy' ? 'buy_limit' : 'sell_limit'
  if (entryMethod === 'stop') return side === 'buy' ? 'buy_stop' : 'sell_stop'
  if (entryMethod === 'stop_limit') return side === 'buy' ? 'buy_stop_limit' : 'sell_stop_limit'
  return null
}

function pendingSide(order) {
  const kind = text(order?.pending_type || order?.order_type || order?.type).toLowerCase()
  return text(order?.side || order?.direction).toLowerCase()
    || (kind.startsWith('buy') ? 'buy' : kind.startsWith('sell') ? 'sell' : '')
}

function pendingKind(order) {
  const value = text(order?.pending_type || order?.order_type)
  if (value) return value.toLowerCase()
  const numeric = Number(order?.type)
  return ({ 2:'buy_limit', 3:'sell_limit', 4:'buy_stop', 5:'sell_stop', 6:'buy_stop_limit', 7:'sell_stop_limit' })[numeric] || value
}

function inventoryPending(inventory) {
  return Array.isArray(inventory?.pending_orders) ? inventory.pending_orders
    : Array.isArray(inventory?.pending) ? inventory.pending : []
}

function inventoryPositions(inventory) {
  return Array.isArray(inventory?.positions) ? inventory.positions : []
}

function targetTicket(row) {
  return ref(row.outcome_pending_ticket) || ref(row.intent_pending_ticket) || ref(row.trade_ticket)
}

function targetSnapshot(row) {
  const snapshot = json(row.target_snapshot_json, {})
  return {
    broker_server_key: text(row.broker_server_key || snapshot.broker?.server || snapshot.account?.broker_server),
    login_account: text(row.login_account || snapshot.broker?.login || snapshot.account?.login_account),
    bridge_generation: row.bridge_generation == null ? snapshot.bridge_generation ?? null : Number(row.bridge_generation),
    ownership: json(row.ownership_snapshot_json, snapshot.ownership || {}),
    account: json(row.account_snapshot_json, snapshot.account || {}),
    user: { id:Number(row.user_id || 0), account:text(row.user_account), nickname:text(row.user_nickname) },
  }
}

async function loadDispatch(dispatchId, actorUserId) {
  const dispatch = await queryOne(`SELECT d.*, apt.title AS strategy_title,
      s.source AS signal_source, s.created_at AS signal_created_at
    FROM admin_strategy_trade_dispatches d
    LEFT JOIN auto_prompt_types apt ON apt.id = d.strategy_id
    LEFT JOIN ai_signals s ON s.id = d.signal_id
    WHERE d.id = ? AND d.actor_user_id = ? LIMIT 1`, [dispatchId, actorUserId])
  if (!dispatch) throw fail('dispatch_not_found')
  if (text(dispatch.entry_method || 'market').toLowerCase() === 'market') throw fail('pending_cancel_not_applicable')
  return dispatch
}

async function loadDispatchTargets(dispatchId) {
  return queryAll(`SELECT t.*, d.entry_method, d.limit_price, d.stop_limit_price, d.pending_valid_minutes,
      d.signal_id AS dispatch_signal_id, d.symbol AS dispatch_symbol, d.direction AS dispatch_direction,
      oi.id AS intent_id, oi.status AS intent_status, oi.pending_ticket AS intent_pending_ticket,
      so.id AS outcome_id, so.status AS outcome_status, so.attribution_status AS outcome_attribution_status,
      so.pending_ticket AS outcome_pending_ticket, so.position_id AS outcome_position_id,
      so.entry_direction AS outcome_direction, so.expected_volume AS outcome_expected_volume,
      so.system_magic AS outcome_magic, so.original_symbol AS outcome_original_symbol, so.symbol AS outcome_symbol,
      u.phone, u.email, u.uid, u.nickname AS user_nickname
    FROM admin_strategy_trade_targets t
    JOIN admin_strategy_trade_dispatches d ON d.id = t.dispatch_id
    LEFT JOIN order_intents oi ON oi.id = t.order_intent_id
    LEFT JOIN signal_outcomes so ON so.order_intent_id = oi.id
    LEFT JOIN users u ON u.id = t.user_id
    WHERE t.dispatch_id = ?
    ORDER BY CASE WHEN t.target_role = 'subscriber' THEN 0 ELSE 1 END, t.id ASC`, [dispatchId])
}

function accountIdentityMatches(inventory, snapshot) {
  return inventory?.status === 'success' && inventory?.account
    && text(inventory.account.server).toUpperCase() === text(snapshot.broker_server_key).toUpperCase()
    && text(inventory.account.login) === text(snapshot.login_account)
}

function classifyStaticTarget(row, dispatch) {
  const snapshot = targetSnapshot(row)
  const ticket = targetTicket(row)
  const signalId = Number(row.dispatch_signal_id || dispatch.signal_id || 0)
  if (!ticket) return { status:'skipped', eligible:false, reason:'ticket_unavailable' }
  if (Number(row.signal_id || signalId) !== signalId || Number(row.outcome_id || 0) <= 0) {
    return { status:'skipped', eligible:false, reason:'outcome_not_attributed' }
  }
  if (text(row.intent_status) !== 'succeeded' || text(row.outcome_status) !== 'open'
    || !['pending', 'attributed'].includes(text(row.outcome_attribution_status).toLowerCase())
    || (ref(row.outcome_position_id) && ref(row.outcome_position_id) !== ref(row.outcome_pending_ticket))) {
    if (ref(row.outcome_position_id) && ref(row.outcome_position_id) !== ref(row.outcome_pending_ticket)) {
      return { status:'skipped', eligible:false, reason:'filled' }
    }
    return { status:'skipped', eligible:false, reason:'outcome_not_pending' }
  }
  if (Number(row.outcome_magic || 0) !== ADMIN_STRATEGY_TRADE_MAGIC) {
    return { status:'skipped', eligible:false, reason:'pending_magic_mismatch' }
  }
  if (canonicalSymbol(row.outcome_original_symbol || row.outcome_symbol || dispatch.symbol)
    !== canonicalSymbol(dispatch.symbol)) {
    return { status:'skipped', eligible:false, reason:'pending_symbol_mismatch' }
  }
  const expectedDirection = text(row.outcome_direction || dispatch.direction).toLowerCase()
  if (!['buy', 'sell'].includes(expectedDirection)) return { status:'skipped', eligible:false, reason:'pending_direction_mismatch' }
  return {
    status:'pending', eligible:true, reason:null, ticket, snapshot,
    expected_state: {
      broker_server_key:snapshot.broker_server_key, login_account:snapshot.login_account,
      ticket, symbol:text(row.outcome_symbol || row.outcome_original_symbol || dispatch.symbol),
      direction:expectedDirection, pending_type:expectedPendingType(expectedDirection, text(dispatch.entry_method).toLowerCase()),
      volume:number(row.outcome_expected_volume || row.requested_volume), magic:ADMIN_STRATEGY_TRADE_MAGIC,
    },
  }
}

async function classifyLiveTarget(row, dispatch, bridge = mt5Bridge) {
  const base = classifyStaticTarget(row, dispatch)
  const snapshot = base.snapshot || targetSnapshot(row)
  const result = {
    ...base, target_role:text(row.target_role), target_id:Number(row.id), dispatch_target_id:Number(row.id),
    user_id:Number(row.user_id), trading_account_id:Number(row.trading_account_id),
    user_account:text(row.phone || row.email || row.uid) || null, user_nickname:text(row.user_nickname) || null,
    ticket:base.ticket || null, symbol:text(row.dispatch_symbol || dispatch.symbol), direction:text(row.dispatch_direction || dispatch.direction),
    volume:number(row.outcome_expected_volume || row.requested_volume),
    operation_identity:{ signal_id:Number(dispatch.signal_id), dispatch_id:Number(dispatch.id), target_id:Number(row.id) },
  }
  if (!base.eligible) return result
  if (!isBridgeAlive(Number(row.user_id))) return { ...result, eligible:false, status:'failed', reason:'bridge_offline' }
  if (!isTradeEnabled(Number(row.user_id))) return { ...result, eligible:false, status:'failed', reason:'trade_send_disabled' }
  const inventory = await bridge(Number(row.user_id), 'system_trade_inventory', {}, { noFallback:true, timeoutMs:10_000 }).catch(() => null)
  if (!inventory || inventory.status !== 'success') return { ...result, eligible:false, status:'failed', reason:'inventory_unavailable' }
  if (!accountIdentityMatches(inventory, snapshot)) return { ...result, eligible:false, status:'skipped', reason:'account_identity_mismatch' }
  const orders = inventoryPending(inventory)
  const pending = orders.find(order => ref(order.ticket || order.order_id) === ref(base.ticket))
  if (!pending) {
    const position = inventoryPositions(inventory).find(item => ref(item.ticket || item.position_id) === ref(base.ticket))
    if (position) return { ...result, eligible:false, status:'skipped', reason:'filled', live_state:'position' }
    return { ...result, eligible:false, status:'skipped', reason:'already_absent', live_state:'absent' }
  }
  const expectedKind = base.expected_state.pending_type
  const liveKind = pendingKind(pending)
  if (canonicalSymbol(pending.symbol) !== canonicalSymbol(dispatch.symbol)
    || pendingSide(pending) !== text(base.expected_state.direction).toLowerCase()
    || (expectedKind && liveKind && liveKind !== expectedKind)
    || Number(pending.magic || 0) !== ADMIN_STRATEGY_TRADE_MAGIC
    || !sameVolume(pending.volume, base.expected_state.volume)) {
    return { ...result, eligible:false, status:'skipped', reason:'pending_identity_mismatch', live_state:'pending' }
  }
  return { ...result, eligible:true, status:'pending', live_state:'pending',
    expected_state:{ ...base.expected_state, symbol:text(pending.symbol), pending_type:liveKind || expectedKind, volume:number(pending.volume) },
  }
}

function stableHash(value) { return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex') }

function summarizeTargets(targets) {
  const counts = {}
  for (const target of targets) counts[target.reason || target.status] = (counts[target.reason || target.status] || 0) + 1
  return {
    target_count:targets.length,
    eligible_target_count:targets.filter(target => target.eligible).length,
    succeeded:0, failed:0, skipped:targets.filter(target => !target.eligible).length, uncertain:0,
    by_reason:counts,
  }
}

export async function buildAdminStrategyPendingCancelPreview(actorUserId, dispatchId, { bridge = mt5Bridge } = {}) {
  const actorId = normalizeId(actorUserId, 'actor_user_id')
  const id = normalizeId(dispatchId, 'dispatch_id')
  const dispatch = await loadDispatch(id, actorId)
  // Keep the safety order in application code as well as SQL.  This makes
  // the subscription-first guarantee survive a mocked/alternate DB adapter
  // and prevents a future query rewrite from changing cancellation order.
  const rows = (await loadDispatchTargets(id)).sort((left, right) => {
    const leftRole = text(left.target_role) === 'subscriber' ? 0 : 1
    const rightRole = text(right.target_role) === 'subscriber' ? 0 : 1
    return leftRole - rightRole || Number(left.id || 0) - Number(right.id || 0)
  })
  const targets = []
  for (const row of rows) {
    const classified = await classifyLiveTarget(row, dispatch, bridge)
    targets.push({
      id:Number(row.id), dispatch_target_id:Number(row.id), target_role:text(row.target_role),
      user_id:Number(row.user_id), trading_account_id:Number(row.trading_account_id),
      user_account:text(row.phone || row.email || row.uid) || null, user_nickname:text(row.user_nickname) || null,
      ticket:classified.ticket || null, symbol:classified.symbol, direction:classified.direction,
      volume:classified.volume, eligible:Boolean(classified.eligible), status:classified.status,
      reason:classified.reason || null, exclusion_reason:classified.reason || null,
      live_state:classified.live_state || null, expected_state:classified.expected_state || null,
      bridge_generation:targetSnapshot(row).bridge_generation,
      broker_server_key:targetSnapshot(row).broker_server_key, login_account:targetSnapshot(row).login_account,
      outcome_id:row.outcome_id == null ? null : Number(row.outcome_id), signal_id:Number(row.signal_id || dispatch.signal_id),
      ownership_history_id:row.ownership_history_id == null ? null : Number(row.ownership_history_id),
    })
  }
  const summary = summarizeTargets(targets)
  const previewHash = stableHash({ dispatch_id:id, signal_id:Number(dispatch.signal_id), entry_method:dispatch.entry_method,
    targets:targets.map(target => ({ dispatch_target_id:target.dispatch_target_id, target_role:target.target_role,
      user_id:target.user_id, trading_account_id:target.trading_account_id, ticket:target.ticket,
      eligible:target.eligible, status:target.status, reason:target.reason, expected_state:target.expected_state })) })
  return {
    dispatch_id:id, source_signal_id:Number(dispatch.signal_id), entry_method:text(dispatch.entry_method),
    symbol:text(dispatch.symbol), direction:text(dispatch.direction), preview_hash:previewHash,
    targets, exclusions:targets.filter(target => !target.eligible), summary,
  }
}

function serializeJobTarget(row) {
  const target = {
    id:Number(row.id), dispatch_target_id:Number(row.dispatch_target_id), target_role:text(row.target_role),
    user_id:Number(row.user_id), trading_account_id:Number(row.trading_account_id),
    user_account:text(row.user_account) || null, user_nickname:text(row.user_nickname) || null,
    ticket:text(row.ticket) || null, symbol:text(row.symbol), direction:text(row.direction),
    volume:number(row.volume), magic:number(row.magic, ADMIN_STRATEGY_TRADE_MAGIC),
    eligible:Boolean(Number(row.eligible)), status:text(row.status), exclusion_reason:row.exclusion_reason || null,
    error_code:row.error_code || null, error_message:row.error_message || null,
    operation_id:text(row.operation_id), attempt_count:Number(row.attempt_count || 0),
    bridge_generation:row.bridge_generation == null ? null : Number(row.bridge_generation),
    last_result:json(row.last_result_json, null), expected_state:json(row.expected_state_json, null),
    created_at:row.created_at || null, updated_at:row.updated_at || null, completed_at:row.completed_at || null,
  }
  return target
}

export async function getAdminStrategyPendingCancelJob(jobId, actorUserId = null) {
  const id = normalizeId(jobId, 'job_id')
  const job = await queryOne('SELECT * FROM admin_strategy_pending_cancel_jobs WHERE id = ? LIMIT 1', [id])
  if (!job || (actorUserId != null && Number(job.actor_user_id) !== normalizeId(actorUserId, 'actor_user_id'))) return null
  const rows = await queryAll(`SELECT t.*, COALESCE(NULLIF(TRIM(u.phone), ''), NULLIF(TRIM(u.email), ''), NULLIF(TRIM(u.uid), '')) AS user_account,
      NULLIF(TRIM(u.nickname), '') AS user_nickname
    FROM admin_strategy_pending_cancel_targets t LEFT JOIN users u ON u.id = t.user_id
    WHERE t.job_id = ? ORDER BY CASE WHEN t.target_role = 'subscriber' THEN 0 ELSE 1 END, t.id ASC`, [id])
  const total = Number(job.target_count || rows.length)
  const completed = Number(job.succeeded_target_count || 0) + Number(job.failed_target_count || 0) + Number(job.skipped_target_count || 0)
  return {
    id, job_id:id, dispatch_id:Number(job.dispatch_id), source_signal_id:Number(job.source_signal_id),
    actor_user_id:Number(job.actor_user_id), idempotency_key:text(job.idempotency_key), reason:text(job.reason),
    preview_hash:text(job.preview_hash), status:text(job.status), target_count:total,
    eligible_target_count:Number(job.eligible_target_count || 0), succeeded:Number(job.succeeded_target_count || 0),
    failed:Number(job.failed_target_count || 0), skipped:Number(job.skipped_target_count || 0),
    uncertain:Number(job.uncertain_target_count || 0), succeeded_target_count:Number(job.succeeded_target_count || 0),
    failed_target_count:Number(job.failed_target_count || 0), skipped_target_count:Number(job.skipped_target_count || 0),
    uncertain_target_count:Number(job.uncertain_target_count || 0), progress_percent:total ? Math.round(completed / total * 100) : 0,
    created_at:job.created_at || null, started_at:job.started_at || null, completed_at:job.completed_at || null,
    targets:rows.map(serializeJobTarget), summary:{ target_count:total, succeeded:Number(job.succeeded_target_count || 0),
      failed:Number(job.failed_target_count || 0), skipped:Number(job.skipped_target_count || 0), uncertain:Number(job.uncertain_target_count || 0) },
  }
}

async function insertJob(actorUserId, input, preview) {
  const now = beijingNow()
  return withTransaction(async run => {
    const [existingRows] = await run('SELECT id, actor_user_id, dispatch_id FROM admin_strategy_pending_cancel_jobs WHERE idempotency_key = ? LIMIT 1', [input.idempotency_key])
    if (existingRows?.[0]) {
      if (Number(existingRows[0].actor_user_id) !== Number(actorUserId)
        || Number(existingRows[0].dispatch_id) !== Number(preview.dispatch_id)) throw fail('idempotency_key_conflict')
      return Number(existingRows[0].id)
    }
    const [jobResult] = await run(`INSERT INTO admin_strategy_pending_cancel_jobs
      (idempotency_key, actor_user_id, dispatch_id, source_signal_id, reason, preview_hash, status,
       target_count, eligible_target_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)`, [input.idempotency_key, actorUserId,
      preview.dispatch_id, preview.source_signal_id, input.reason, preview.preview_hash,
      preview.targets.length, preview.summary.eligible_target_count, now, now])
    const jobId = Number(jobResult.insertId)
    let order = 0
    for (const target of preview.targets) {
      const status = target.eligible ? 'pending' : 'skipped'
      const reason = target.eligible ? null : (target.reason || 'excluded')
      const [targetResult] = await run(`INSERT INTO admin_strategy_pending_cancel_targets
        (job_id, dispatch_target_id, target_order, target_role, user_id, trading_account_id,
         ownership_history_id, outcome_id, signal_id, broker_server_key, login_account,
         ticket, symbol, direction, volume, magic, eligible, expected_state_json,
         target_snapshot_json, bridge_generation, operation_id, status, exclusion_reason,
         error_code, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        jobId, target.dispatch_target_id, order++, target.target_role, target.user_id, target.trading_account_id,
        target.ownership_history_id, target.outcome_id, target.signal_id, target.broker_server_key, target.login_account,
        target.ticket || '', target.symbol, target.direction, target.volume, ADMIN_STRATEGY_TRADE_MAGIC,
        target.eligible ? 1 : 0, JSON.stringify(target.expected_state || {}), JSON.stringify(target), target.bridge_generation,
        `pending:${jobId}:${target.dispatch_target_id}`, status, reason, reason, now, now,
      ])
      const targetId = Number(targetResult.insertId)
      await run('UPDATE admin_strategy_pending_cancel_targets SET operation_id = ? WHERE id = ?', [`admin-strategy-pending-cancel:${jobId}:${targetId}`, targetId])
    }
    return jobId
  })
}

export async function createAdminStrategyPendingCancelJob(actorUserId, dispatchId, body = {}, headers = {}) {
  const actorId = normalizeId(actorUserId, 'actor_user_id')
  const normalizedDispatchId = normalizeId(dispatchId, 'dispatch_id')
  if (body.confirm !== true) throw fail('confirmation_required')
  const input = { idempotency_key:normalizeKey(body, headers), reason:text(body.reason) }
  if (input.reason.length < 2 || input.reason.length > 500) throw fail('cancel_reason_required')
  // A lost HTTP response must be safely replayable even if the first job has
  // already changed live terminal state. Resolve an existing request before
  // rebuilding the time-sensitive preview, while fencing actor and dispatch.
  const existing = await queryOne(`SELECT id, actor_user_id, dispatch_id
    FROM admin_strategy_pending_cancel_jobs WHERE idempotency_key = ? LIMIT 1`, [input.idempotency_key])
  if (existing) {
    if (Number(existing.actor_user_id) !== actorId || Number(existing.dispatch_id) !== normalizedDispatchId) {
      throw fail('idempotency_key_conflict')
    }
    return getAdminStrategyPendingCancelJob(existing.id, actorId)
  }
  const preview = await buildAdminStrategyPendingCancelPreview(actorId, normalizedDispatchId)
  if (text(body.preview_hash) !== text(preview.preview_hash)) throw fail('preview_hash_mismatch', { preview_hash:preview.preview_hash })
  const jobId = await insertJob(actorId, input, preview)
  return getAdminStrategyPendingCancelJob(jobId, actorId)
}

export async function retryFailedAdminStrategyPendingCancelJob(actorUserId, jobId, body = {}) {
  const actorId = normalizeId(actorUserId, 'actor_user_id')
  const job = await getAdminStrategyPendingCancelJob(jobId, actorId)
  if (!job) throw fail('pending_cancel_job_not_found')
  if (['queued', 'running', 'reconciling'].includes(job.status)) throw fail('pending_cancel_job_active')
  if (job.uncertain > 0) throw fail('uncertain_requires_reconciliation')
  const preview = await buildAdminStrategyPendingCancelPreview(actorId, job.dispatch_id)
  if (text(body.preview_hash) !== text(preview.preview_hash)) throw fail('preview_hash_mismatch', { preview_hash:preview.preview_hash })
  const failed = await queryAll(`SELECT id, dispatch_target_id FROM admin_strategy_pending_cancel_targets
    WHERE job_id = ? AND status = 'failed' ORDER BY target_order, id`, [job.id])
  if (!failed.length) throw fail('no_failed_targets')
  const byDispatchTarget = new Map(preview.targets.map(target => [Number(target.dispatch_target_id), target]))
  const now = beijingNow()
  await withTransaction(async run => {
    for (const row of failed) {
      const target = byDispatchTarget.get(Number(row.dispatch_target_id))
      if (!target || !target.eligible) {
        await run(`UPDATE admin_strategy_pending_cancel_targets SET status = 'skipped', eligible = 0,
          exclusion_reason = ?, error_code = ?, completed_at = ?, updated_at = ? WHERE id = ?`,
        [target?.reason || 'already_absent', target?.reason || 'already_absent', now, now, row.id])
        continue
      }
      await run(`UPDATE admin_strategy_pending_cancel_targets SET status = 'pending', eligible = 1,
        ticket = ?, symbol = ?, direction = ?, volume = ?, expected_state_json = ?, target_snapshot_json = ?,
        error_code = NULL, error_message = NULL, last_result_json = NULL, completed_at = NULL,
        lease_token = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?`, [
        target.ticket, target.symbol, target.direction, target.volume, JSON.stringify(target.expected_state || {}), JSON.stringify(target), now, row.id,
      ])
    }
    await run(`UPDATE admin_strategy_pending_cancel_jobs SET status = 'queued', preview_hash = ?, completed_at = NULL,
      lease_token = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?`, [preview.preview_hash, now, job.id])
  })
  return getAdminStrategyPendingCancelJob(job.id, actorId)
}

export const __adminStrategyPendingCancelTest = {
  expectedPendingType, pendingSide, pendingKind, targetTicket, classifyStaticTarget,
  accountIdentityMatches, summarizeTargets, serializeJobTarget,
}
