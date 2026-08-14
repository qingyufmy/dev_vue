import crypto from 'node:crypto'
import { beijingAfter, beijingNow, queryAll, queryOne, queryRun, withTransaction } from '../db.js'
import { executeOrderCore } from '../routes/ai/config.js'
import { mt5Bridge } from '../routes/ai/market-data.js'
import { isSubscriptionScheduleActive } from '../routes/ai/subscription-schedule.js'
import { getBridgeGeneration, isBridgeAlive, isTradeEnabled } from '../bridge-ws.js'
import { stripBrokerSuffix } from '../routes/ai/utils.js'
import {
  ADMIN_STRATEGY_TRADE_MAGIC,
  ADMIN_STRATEGY_TRADE_SOURCE,
  assertAdminStrategyTargetSendFence,
  claimAdminStrategyTradeDispatch,
  resolveEffectiveSymbolsForDispatch,
} from '../services/admin-strategy-trades.js'
import { acquireAccountSymbolInventoryLock, releaseAccountSymbolInventoryLock } from '../services/account-symbol-inventory-lock.js'

let workerTimer = null
let workerRunning = false

function parseJson(value, fallback = {}) {
  if (value && typeof value === 'object') return value
  try { return value ? JSON.parse(value) : fallback } catch { return fallback }
}

function ticketFrom(value = {}) {
  return String(value.trade_ticket ?? value.position_id ?? value.position ?? value.ticket ?? value.entry_order_ticket ?? value.order_ticket ?? value.order ?? '').trim() || null
}

function directionMatches(value, direction) {
  const text = String(value ?? '').toLowerCase()
  if (text.includes(String(direction).toLowerCase())) return true
  const numeric = Number(value)
  return Number.isFinite(numeric) && ((String(direction).toLowerCase() === 'buy' && numeric === 0)
    || (String(direction).toLowerCase() === 'sell' && numeric === 1))
}

function setError(error, fallback = 'admin_strategy_trade_failed') {
  return String(error?.reason || error?.code || error?.message || fallback).slice(0, 128)
}

async function loadDispatch(dispatchId) {
  return queryOne('SELECT * FROM admin_strategy_trade_dispatches WHERE id = ?', [dispatchId])
}

async function claimTarget(targetId, dispatchId, expectedStatuses = ['pending']) {
  const token = crypto.randomUUID(); const now = beijingNow()
  const leaseUntil = beijingAfter(120_000)
  return withTransaction(async run => {
    const [rows] = await run('SELECT * FROM admin_strategy_trade_targets WHERE id = ? AND dispatch_id = ? FOR UPDATE', [targetId, dispatchId])
    const target = rows?.[0]
    if (!target || !expectedStatuses.includes(target.status)) return null
    const result = await run(`UPDATE admin_strategy_trade_targets SET status = 'validating', attempt_count = attempt_count + 1,
      lease_token = ?, lease_expires_at = ?, validating_at = ?, updated_at = ? WHERE id = ? AND status = ?`, [token, leaseUntil, now, now, targetId, target.status])
    if (!result?.[0]?.affectedRows) return null
    return { ...target, status: 'validating', lease_token: token, lease_expires_at: leaseUntil, attempt_count: Number(target.attempt_count || 0) + 1 }
  })
}

async function markTarget(targetId, dispatchId, status, fields = {}) {
  const now = beijingNow()
  const allowed = new Set(['succeeded', 'rejected', 'skipped', 'failed', 'failed_manual_review', 'uncertain', 'reconciling'])
  if (!allowed.has(status)) throw new Error(`invalid_target_status:${status}`)
  const updates = ['status = ?', 'updated_at = ?']; const params = [status, now]
  for (const [column, value] of Object.entries(fields)) {
    if (!['order_intent_id', 'trade_ticket', 'execution_result_json', 'error_code', 'completed_at', 'lease_token', 'lease_expires_at'].includes(column)) continue
    updates.push(`${column} = ?`); params.push(value)
  }
  if (['succeeded', 'rejected', 'skipped', 'failed', 'failed_manual_review'].includes(status)) {
    updates.push('completed_at = COALESCE(completed_at, ?)'); params.push(now)
    updates.push('lease_token = NULL', 'lease_expires_at = NULL')
  }
  params.push(dispatchId, targetId)
  await queryRun(`UPDATE admin_strategy_trade_targets SET ${updates.join(', ')} WHERE dispatch_id = ? AND id = ?`, params)
}

function targetRequest(dispatch, target, snapshot) {
  const isLegacyTierDispatch = dispatch.requested_volume === null
    || dispatch.requested_volume === undefined || dispatch.requested_volume === ''
  const request = {
    symbol: dispatch.symbol, order_type: dispatch.direction, direction: dispatch.direction,
    entry_method: 'market', entry_price: dispatch.entry_price || null,
    // New dispatches carry an explicit, frozen hand size. executeOrderCore
    // still applies broker/risk validation and may only reduce that request.
    volume: isLegacyTierDispatch ? 0 : Number(dispatch.requested_volume),
    sl: dispatch.stop_loss, tp: dispatch.take_profit_1, stop_loss_price: dispatch.stop_loss,
    take_profit_1_price: dispatch.take_profit_1, take_profit_2_price: dispatch.take_profit_2,
    take_profit_3_price: dispatch.take_profit_3, take_profit_candidates: [dispatch.take_profit_1, dispatch.take_profit_2, dispatch.take_profit_3]
      .filter(value => Number(value) > 0).map((price, index) => ({ tier: index + 1, price: Number(price) })),
    confirm: true, signal_id: null,
    execution_validation: { status: 'eligible', eligible: true, reason_codes: [] }, magic: ADMIN_STRATEGY_TRADE_MAGIC,
    source: ADMIN_STRATEGY_TRADE_SOURCE, trading_account_id: Number(target.trading_account_id),
  }
  // Compatibility path only for rows created before migration 189. New rows
  // must never fall back to a position tier or its factor.
  if (isLegacyTierDispatch) {
    request.position_size_tier = dispatch.position_size_tier
    request.position_size_factor = snapshot.position_size_factor
    request.position_size_reason = `admin_strategy_dispatch:${dispatch.id}`
  }
  return request
}

async function checkTargetRuntime(dispatch, target, sourceRequired) {
  if (!isBridgeAlive(target.user_id)) throw Object.assign(new Error('bridge_offline'), { code: 'bridge_offline', preSend: true })
  if (!isTradeEnabled(target.user_id)) throw Object.assign(new Error('trade_send_disabled'), { code: 'trade_send_disabled', preSend: true })
  const snapshot = parseJson(target.target_snapshot_json)
  const frozenGeneration = snapshot.bridge_generation == null ? null : Number(snapshot.bridge_generation)
  const currentGeneration = Number(getBridgeGeneration(target.user_id) || 0)
  if (frozenGeneration != null && frozenGeneration !== currentGeneration) throw Object.assign(new Error('bridge_generation_changed'), { code: 'bridge_generation_changed', preSend: true })
  if (sourceRequired) {
    const row = await queryOne(`SELECT ss.*, apt.symbols_json AS strategy_symbols_json, u.role AS user_role, u.plan, u.plan_expires_at,
        ta.broker_server, ta.login_account, ta.observe_status, ta.is_deleted AS account_is_deleted,
        own.user_id AS ownership_user_id, own.trading_account_id AS ownership_trading_account_id,
        rp.status AS risk_profile_status, ras.halt_status, ras.user_kill_switch,
        ubs.trade_send_enabled,
        sched.enabled AS scheduler_enabled, sched.enable_auto_trade AS scheduler_enable_auto_trade,
        mds.timezone_offset_minutes AS runtime_timezone_offset_minutes, mds.clock_status AS runtime_clock_status
      FROM strategy_subscriptions ss JOIN auto_prompt_types apt ON apt.id = ss.strategy_id AND apt.deleted_at IS NULL
      JOIN users u ON u.id = ss.user_id
      JOIN trading_accounts ta ON ta.id = ss.trading_account_id
      LEFT JOIN mt5_account_ownership_history own ON own.trading_account_id = ta.id AND own.ended_at IS NULL
      LEFT JOIN risk_profiles rp ON rp.id = ss.risk_profile_id AND rp.deleted_at IS NULL
      LEFT JOIN risk_account_state ras ON ras.trading_account_id = ss.trading_account_id
      LEFT JOIN auto_scheduler sched ON sched.user_id = ss.user_id
      LEFT JOIN user_bridge_settings ubs ON ubs.user_id = ss.user_id
      LEFT JOIN market_data_sources mds ON mds.bridge_user_id = ss.user_id
        AND UPPER(COALESCE(mds.broker_server, '')) = UPPER(ta.broker_server)
        AND CAST(COALESCE(mds.account_login, 0) AS CHAR) = CAST(ta.login_account AS CHAR)
      WHERE ss.id = ? AND ss.user_id = ? AND ss.trading_account_id = ? LIMIT 1`, [target.subscription_id, target.user_id, target.trading_account_id])
    const expiry = row?.plan_expires_at ? new Date(row.plan_expires_at).getTime() : 0
    const effectiveSymbols = resolveEffectiveSymbolsForDispatch(row?.symbols_json, row?.strategy_symbols_json)
    const symbolAllowed = effectiveSymbols.includes(stripBrokerSuffix(dispatch.symbol))
    const reason = !row || Number(row.is_deleted) === 1 || Number(row.account_is_deleted) === 1 ? 'subscription_deleted'
      : Number(row.execution_enabled) !== 1 ? 'execution_disabled'
        : !symbolAllowed ? 'symbol_not_subscribed'
          : row.observe_status !== 'active' ? 'account_not_active'
              : Number(row.ownership_user_id) !== Number(row.user_id) || Number(row.ownership_trading_account_id) !== Number(row.trading_account_id)
                || String(row.broker_server || '').toUpperCase() !== String(snapshot.broker?.server || '').toUpperCase()
                || String(row.login_account || '') !== String(snapshot.broker?.login || '') ? 'ownership_changed'
              : Number(row.scheduler_enabled) !== 1 || Number(row.scheduler_enable_auto_trade) !== 1 ? 'scheduler_disabled'
                : Number(row.trade_send_enabled ?? 1) !== 1 ? 'trade_send_disabled'
                : String(row.user_role || '').toLowerCase() !== 'admin' && !['pro', 'plus', 'premium', 'enterprise'].includes(String(row.plan || '').toLowerCase()) ? 'membership_not_eligible'
                  : expiry && expiry < Date.now() ? 'membership_expired'
                    : String(row.risk_profile_status || '').toLowerCase() && String(row.risk_profile_status || '').toLowerCase() !== 'active' ? 'risk_profile_inactive'
                      : Number(row.user_kill_switch) === 1 || String(row.halt_status || '').toLowerCase() === 'halted' ? 'risk_halted'
                      : !isSubscriptionScheduleActive(row) ? 'outside_schedule' : null
    if (reason) throw Object.assign(new Error(reason), { code: reason, preSend: true })
  }
  await assertAdminStrategyTargetSendFence({ dispatchId: dispatch.id, targetId: target.id, targetRole: target.target_role, sourceRequired, leaseToken: target.lease_token })
  return snapshot
}

async function verifySourceOutcome(dispatch, target, result, request) {
  if (result?.status !== 'success' || !result.order_intent_id) return { verified: false, uncertain: result?.status === 'uncertain' }
  const outcomeRows = await queryAll(`SELECT so.*, oi.trading_account_id, oi.symbol, oi.request_json, oi.status AS intent_status
    FROM signal_outcomes so JOIN order_intents oi ON oi.id = so.order_intent_id
    WHERE so.order_intent_id = ?`, [result.order_intent_id])
  if (outcomeRows.length !== 1) return { verified: false, uncertain: true, reason: 'signal_outcome_not_unique' }
  const outcome = outcomeRows[0]
  const resultTicket = ticketFrom(result) || ticketFrom(outcome)
  if (!resultTicket || outcome.intent_status !== 'succeeded' || String(outcome.signal_id) !== String(dispatch.signal_id)
    || Number(outcome.trading_account_id) !== Number(target.trading_account_id)
    || stripBrokerSuffix(String(outcome.symbol || '')) !== stripBrokerSuffix(dispatch.symbol)
    || Number(outcome.system_magic) !== ADMIN_STRATEGY_TRADE_MAGIC) {
    return { verified: false, uncertain: true, reason: 'source_outcome_identity_mismatch', ticket: resultTicket }
  }
  const inventory = await mt5Bridge(target.user_id, 'system_trade_inventory', {}, { noFallback: true, timeoutMs: 10_000 })
  if (inventory?.status !== 'success' || !inventory.account) return { verified: false, uncertain: true, reason: 'source_inventory_unavailable', ticket: resultTicket }
  const frozen = parseJson(target.target_snapshot_json)
  if (String(inventory.account.server || '').toUpperCase() !== String(frozen.broker?.server || '').toUpperCase()
    || String(inventory.account.login || '') !== String(frozen.broker?.login || '')) {
    return { verified: false, uncertain: true, reason: 'source_inventory_account_mismatch', ticket: resultTicket }
  }
  const list = Array.isArray(inventory.positions) ? inventory.positions : []
  const match = list.find(position => String(position.ticket ?? position.position_id ?? position.order ?? '') === String(resultTicket)
    && stripBrokerSuffix(String(position.symbol || '')) === stripBrokerSuffix(dispatch.symbol)
    && directionMatches(position.type ?? position.direction, dispatch.direction)
    && Number(position.magic) === ADMIN_STRATEGY_TRADE_MAGIC)
  if (!match) return { verified: false, uncertain: true, reason: 'source_inventory_not_confirmed', ticket: resultTicket }
  return { verified: true, ticket: resultTicket, outcome }
}

async function executeTarget(dispatch, target, sourceRequired = false) {
  const claimed = await claimTarget(target.id, dispatch.id, ['pending'])
  if (!claimed) return { status: 'skipped', reason: 'target_claim_lost' }
  target = { ...target, ...claimed, status: 'validating' }
  let lock = null
  try {
    const snapshot = await checkTargetRuntime(dispatch, target, sourceRequired)
    await queryRun("UPDATE admin_strategy_trade_targets SET status = 'executing', executing_at = ?, updated_at = ? WHERE dispatch_id = ? AND id = ? AND lease_token = ?", [beijingNow(), beijingNow(), dispatch.id, target.id, claimed.lease_token])
    lock = await acquireAccountSymbolInventoryLock(target.user_id, dispatch.symbol)
    if (!lock?.token) throw Object.assign(new Error('execution_inventory_lock_busy'), { code: 'execution_inventory_lock_busy', retryable: true })
    const request = targetRequest(dispatch, target, snapshot)
    const sourceId = `${dispatch.signal_id}:dispatch:${dispatch.id}:target:${target.id}`
    const result = await executeOrderCore(target.user_id, { enable_auto_trade: true, take_profit_mode: snapshot.take_profit_mode || 'standard', max_position_size: 1 }, request, sourceRequired ? 'admin_strategy_delivery' : 'admin_strategy_source', {
      tradingAccountId: target.trading_account_id, sourceType: sourceRequired ? 'admin_strategy_delivery' : 'admin_strategy_source', sourceId,
      riskProfileId: snapshot.risk?.profile_id || target.risk_profile_id,
      beforeBridgeSend: async () => {
        if (Date.now() >= Number(dispatch.valid_until_utc_msc)) throw Object.assign(new Error('dispatch_expired'), { preSend: true })
        if (!isBridgeAlive(target.user_id) || !isTradeEnabled(target.user_id)) throw Object.assign(new Error('bridge_runtime_fence_failed'), { preSend: true })
      },
      beforeBridgeSendTx: async () => assertAdminStrategyTargetSendFence({ dispatchId: dispatch.id, targetId: target.id, targetRole: target.target_role, sourceRequired, leaseToken: claimed.lease_token }),
    })
    const resultJson = JSON.stringify(result || {})
    if (result?.status === 'succeeded' || (result?.status === 'success' && result?.order_intent_id)) {
      const intent = await queryOne('SELECT id, status, trade_ticket, result_json FROM order_intents WHERE id = ?', [result.order_intent_id])
      if (intent?.status === 'uncertain') {
        await markTarget(target.id, dispatch.id, 'uncertain', { order_intent_id: intent.id, execution_result_json: resultJson, error_code: 'order_intent_uncertain' })
        return { status: 'uncertain' }
      }
      const ticket = intent?.trade_ticket || ticketFrom(result)
      if (!ticket) {
        await markTarget(target.id, dispatch.id, 'uncertain', { order_intent_id: result.order_intent_id, execution_result_json: resultJson, error_code: 'trade_ticket_missing' })
        return { status: 'uncertain' }
      }
      if (!sourceRequired) {
        const verified = await verifySourceOutcome(dispatch, target, result, request)
        if (!verified.verified) {
          await markTarget(target.id, dispatch.id, 'uncertain', { order_intent_id: result.order_intent_id, trade_ticket: ticket, execution_result_json: resultJson, error_code: verified.reason || 'source_not_confirmed' })
          return { status: 'uncertain' }
        }
      }
      await markTarget(target.id, dispatch.id, 'succeeded', { order_intent_id: result.order_intent_id, trade_ticket: ticket, execution_result_json: resultJson })
      return { status: 'succeeded', ticket }
    }
    if (result?.status === 'uncertain') {
      await markTarget(target.id, dispatch.id, 'uncertain', { order_intent_id: result.order_intent_id || null, execution_result_json: resultJson, error_code: 'bridge_result_uncertain' })
      return { status: 'uncertain' }
    }
    await markTarget(target.id, dispatch.id, 'rejected', { order_intent_id: result?.order_intent_id || null, execution_result_json: resultJson, error_code: setError(result, 'broker_rejected') })
    return { status: 'rejected' }
  } catch (error) {
    if (error?.preSend === true) {
      const expired = setError(error) === 'dispatch_expired'
      await markTarget(target.id, dispatch.id, 'skipped', { execution_result_json: JSON.stringify({ status: 'skipped', reason: setError(error) }), error_code: setError(error) })
      return { status: expired ? 'expired' : 'skipped', error: setError(error) }
    }
    const uncertain = error?.uncertain === true
    await markTarget(target.id, dispatch.id, uncertain ? 'uncertain' : (error?.retryable ? 'failed' : 'failed_manual_review'), { execution_result_json: JSON.stringify({ status: uncertain ? 'uncertain' : 'failed', reason: setError(error) }), error_code: setError(error) })
    return { status: uncertain ? 'uncertain' : 'failed', error: setError(error) }
  } finally {
    if (lock?.token) await releaseAccountSymbolInventoryLock(lock.key, lock.token).catch(() => {})
  }
}

async function finalizeDispatch(dispatchId) {
  const rows = await queryAll('SELECT target_role, status FROM admin_strategy_trade_targets WHERE dispatch_id = ?', [dispatchId])
  const source = rows.find(row => row.target_role === 'source')
  const subscribers = rows.filter(row => row.target_role === 'subscriber')
  const counts = status => rows.filter(row => row.status === status).length
  let status = 'delivering'
  if (source?.status === 'uncertain' || source?.status === 'reconciling') status = 'delivering'
  else if (source?.status !== 'succeeded') status = ['rejected', 'skipped', 'failed', 'failed_manual_review'].includes(source?.status) ? 'failed' : 'delivering'
  else if (subscribers.every(row => ['succeeded', 'rejected', 'skipped', 'failed', 'failed_manual_review'].includes(row.status))) {
    const successes = subscribers.filter(row => row.status === 'succeeded').length
    const failures = subscribers.filter(row => ['failed', 'failed_manual_review', 'rejected'].includes(row.status)).length
    status = successes && failures ? 'partial' : successes ? 'succeeded' : 'failed'
  }
  await queryRun(`UPDATE admin_strategy_trade_dispatches SET status = ?, succeeded_target_count = ?, rejected_target_count = ?, skipped_target_count = ?, failed_target_count = ?, uncertain_target_count = ?, completed_at = CASE WHEN ? IN ('succeeded','partial','failed') THEN COALESCE(completed_at, ?) ELSE completed_at END, updated_at = ? WHERE id = ?`, [status, counts('succeeded'), counts('rejected'), counts('skipped'), counts('failed') + counts('failed_manual_review'), counts('uncertain') + counts('reconciling'), status, beijingNow(), beijingNow(), dispatchId])
  return status
}

async function reconcileUncertainTarget(target) {
  const dispatch = await loadDispatch(target.dispatch_id)
  if (!dispatch) return { status: 'missing_dispatch' }
  const intent = target.order_intent_id
    ? await queryOne('SELECT id, status, trade_ticket, result_json, trading_account_id, symbol FROM order_intents WHERE id = ?', [target.order_intent_id]) : null
  if (!intent || intent.status === 'uncertain' || intent.status === 'bridge_sending' || intent.status === 'preparing' || intent.status === 'prepared') return { status: 'still_uncertain' }
  if (intent.status !== 'succeeded') {
    await markTarget(target.id, target.dispatch_id, 'failed_manual_review', { error_code: `reconcile_${intent.status || 'failed'}`, execution_result_json: intent.result_json || JSON.stringify({ status: intent.status }) })
    return { status: 'failed_manual_review' }
  }
  const outcomes = await queryAll('SELECT * FROM signal_outcomes WHERE order_intent_id = ?', [intent.id])
  if (outcomes.length !== 1 || String(outcomes[0].signal_id) !== String(dispatch.signal_id)
    || Number(outcomes[0].trading_account_id) !== Number(target.trading_account_id)
    || Number(outcomes[0].system_magic) !== ADMIN_STRATEGY_TRADE_MAGIC) return { status: 'still_uncertain' }
  const snapshot = parseJson(target.target_snapshot_json)
  const inventory = await mt5Bridge(target.user_id, 'system_trade_inventory', {}, { noFallback: true, timeoutMs: 10_000 }).catch(() => null)
  const ticket = intent.trade_ticket || ticketFrom(outcomes[0])
  if (inventory?.status !== 'success' || !inventory.account
    || String(inventory.account.server || '').toUpperCase() !== String(snapshot.broker?.server || '').toUpperCase()
    || String(inventory.account.login || '') !== String(snapshot.broker?.login || '')) return { status: 'still_uncertain' }
  const position = inventory?.status === 'success' && Array.isArray(inventory.positions)
    ? inventory.positions.find(item => String(item.ticket ?? item.position_id ?? item.order ?? '') === String(ticket)
      && stripBrokerSuffix(String(item.symbol || '')) === stripBrokerSuffix(dispatch.symbol)
      && directionMatches(item.type ?? item.direction, dispatch.direction)
      && Number(item.magic) === ADMIN_STRATEGY_TRADE_MAGIC) : null
  if (!position) return { status: 'still_uncertain' }
  await markTarget(target.id, target.dispatch_id, 'succeeded', { order_intent_id: intent.id, trade_ticket: ticket, execution_result_json: intent.result_json || JSON.stringify(position) })
  return { status: 'succeeded' }
}

export async function reconcileAdminStrategyTradeTargetsOnce({ limit = 20 } = {}) {
  const targets = await queryAll(`SELECT * FROM admin_strategy_trade_targets
    WHERE status IN ('uncertain','reconciling') ORDER BY updated_at ASC, id ASC LIMIT ?`, [Math.max(1, Math.min(50, Number(limit) || 20))])
  const results = []
  for (const target of targets) results.push(await reconcileUncertainTarget(target).catch(error => ({ status: 'still_uncertain', error: setError(error) })))
  return { processed: targets.length, results }
}

export async function processAdminStrategyTradeDispatch(dispatchId) {
  const dispatch = await loadDispatch(dispatchId)
  if (!dispatch || !['confirmed', 'delivering'].includes(dispatch.status)) return { status: 'ignored' }
  if (Number(dispatch.valid_until_utc_msc) <= Date.now()) {
    await queryRun("UPDATE admin_strategy_trade_dispatches SET status = 'expired', completed_at = ?, updated_at = ? WHERE id = ? AND status IN ('confirmed','delivering')", [beijingNow(), beijingNow(), dispatch.id])
    await queryRun("UPDATE admin_strategy_trade_targets SET status = 'skipped', error_code = 'dispatch_expired', completed_at = ?, updated_at = ? WHERE dispatch_id = ? AND status IN ('pending','validating')", [beijingNow(), beijingNow(), dispatch.id])
    return { status: 'expired' }
  }
  const lease = await claimAdminStrategyTradeDispatch(dispatch.id)
  if (!lease) return { status: 'claimed_by_other' }
  const source = await queryOne("SELECT * FROM admin_strategy_trade_targets WHERE dispatch_id = ? AND target_role = 'source' LIMIT 1", [dispatch.id])
  if (source?.status === 'pending') {
    const sourceResult = await executeTarget(dispatch, source, false)
    if (sourceResult.status !== 'succeeded') return { status: await finalizeDispatch(dispatch.id), source: sourceResult.status }
  }
  const sourceAfter = await queryOne("SELECT * FROM admin_strategy_trade_targets WHERE dispatch_id = ? AND target_role = 'source' LIMIT 1", [dispatch.id])
  if (sourceAfter?.status !== 'succeeded') return { status: await finalizeDispatch(dispatch.id), source: sourceAfter?.status }
  const targets = await queryAll("SELECT * FROM admin_strategy_trade_targets WHERE dispatch_id = ? AND target_role = 'subscriber' AND status = 'pending' ORDER BY id ASC", [dispatch.id])
  for (const target of targets) {
    await executeTarget(dispatch, target, true)
  }
  return { status: await finalizeDispatch(dispatch.id) }
}

export async function runAdminStrategyTradeWorkerOnce({ limit = 10 } = {}) {
  if (workerRunning) return { busy: true, processed: 0 }
  workerRunning = true
  try {
    await reconcileAdminStrategyTradeTargetsOnce().catch(error => console.error('[AdminStrategyTradeWorker] reconciliation:', error.message))
    const rows = await queryAll(`SELECT id FROM admin_strategy_trade_dispatches
      WHERE status IN ('confirmed','delivering') ORDER BY updated_at ASC, id ASC LIMIT ?`, [Math.max(1, Math.min(50, Number(limit) || 10))])
    const results = []
    for (const row of rows) results.push(await processAdminStrategyTradeDispatch(row.id).catch(error => ({ status: 'failed', error: setError(error) })))
    return { processed: rows.length, results }
  } finally { workerRunning = false }
}

export function startAdminStrategyTradeWorker(intervalMs = 60_000) {
  if (workerTimer) return workerTimer
  workerTimer = setInterval(() => runAdminStrategyTradeWorkerOnce().catch(error => console.error('[AdminStrategyTradeWorker]', error.message)), Math.max(10_000, Number(intervalMs) || 60_000))
  workerTimer.unref?.()
  runAdminStrategyTradeWorkerOnce().catch(error => console.error('[AdminStrategyTradeWorker]', error.message))
  return workerTimer
}

export function stopAdminStrategyTradeWorker() {
  if (workerTimer) clearInterval(workerTimer)
  workerTimer = null
}

export const __adminStrategyTradeWorkerTest = { ticketFrom, targetRequest, setError }
