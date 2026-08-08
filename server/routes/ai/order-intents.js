// ai/order-intents.js — unified new-order intent, idempotency and reconciliation gateway

import { createHash, randomUUID } from 'crypto'
import { queryAll, queryOne, withTransaction, beijingNow } from '../../db.js'
import { mt5Bridge } from './market-data.js'
import { StatefulRiskReject, recordSuccessfulOpenTx } from './risk-state.js'
import { createSignalOutcomeTx } from './signal-outcomes.js'
import { broadcastAdminEvent, sendToBrowsers } from '../../bridge-ws.js'
import { buildSafeExecutionOutcome, buildSafeExecutionEvent } from '../../audit-localization.js'

const TERMINAL_STATUSES = new Set(['succeeded', 'rejected', 'failed'])
const DETERMINISTIC_BROKER_RETCODES = new Set([10013, 10014, 10015, 10016, 10017, 10018, 10019, 10022, 10030, 10035, 10038])
const LEASE_SECONDS = 30
const RESERVATION_SECONDS = 10 * 60
const RECONCILE_INTERVAL_MS = 30_000
const DEFINITIVE_ABSENCE_GRACE_MS = 5 * 60_000
// A command reference without a broker ticket is only safe to search within
// a bounded recent window. Older intents stay uncertain for manual review;
// they must not be finalized from an incomplete history response.
const MAX_RECONCILIATION_LOOKBACK_SECONDS = 30 * 24 * 60 * 60

let reconcileTimer = null
let reconcileInFlight = null
let reconcileStopping = false
let skippedOverlapCount = 0

function toPositiveId(value) {
  const id = Number(value)
  return Number.isInteger(id) && id > 0 ? id : null
}

function safeParse(value, fallback = {}) {
  if (!value) return fallback
  try { return JSON.parse(value) } catch { return fallback }
}

function isRiskRejection(error) {
  if (!error) return false
  if (error.classification === 'risk_rejection') return true
  if (error instanceof StatefulRiskReject) return true
  if (Array.isArray(error.details?.rules)) return true
  const reason = String(error.reason || error.reject_code || '').trim()
  return /^(?:R\d|PX\.)[A-Z0-9._-]+$/i.test(reason)
}

function brokerResultValue(result, key) {
  return result?.[key] ?? result?.mt5_result?.[key] ?? result?.raw_result?.[key]
    ?? result?.result?.[key] ?? result?.evidence?.[key]
}

function brokerRetcode(result) {
  return brokerResultValue(result, 'retcode') ?? brokerResultValue(result, 'broker_retcode') ?? null
}

function brokerReason(result) {
  return brokerResultValue(result, 'message') || brokerResultValue(result, 'error') || ''
}

export function executionTicket(result, action = 'open') {
  if (isPendingAction(action)) {
    return result?.order ?? result?.pending_ticket ?? result?.ticket ?? result?.order_id ?? null
  }
  return result?.position_id ?? result?.position ?? result?.trade_ticket
    ?? result?.ticket ?? result?.order ?? result?.order_id ?? null
}

function isPendingAction(action) {
  return action === 'pending'
}

function isDeterministicBrokerReject(result) {
  if (result?.status === 'rejected') return true
  const retcode = Number(brokerRetcode(result))
  if (Number.isInteger(retcode) && DETERMINISTIC_BROKER_RETCODES.has(retcode)) return true
  const message = String(brokerReason(result)).trim().toLowerCase()
  return ['invalid price', 'invalid stops', 'invalid volume', 'invalid expiration', 'invalid order', 'market closed', 'trade disabled', 'not enough money']
    .some(pattern => message.includes(pattern))
}

function leaseIsActive(row) {
  if (!row?.lease_expires_at) return false
  return new Date(row.lease_expires_at).getTime() > Date.now()
}

async function txAll(run, sql, params = []) {
  const [rows] = await run(sql, params)
  return rows
}

async function txOne(run, sql, params = []) {
  const rows = await txAll(run, sql, params)
  return rows[0] || null
}

async function lockAccountScope(run, userId, tradingAccountId) {
  if (tradingAccountId) {
    const account = await txOne(
      run,
      'SELECT id, user_id FROM trading_accounts WHERE id = ? AND user_id = ? AND is_deleted = 0 FOR UPDATE',
      [tradingAccountId, userId]
    )
    if (!account) throw new Error('trading_account_not_found')
    return
  }
  const user = await txOne(run, 'SELECT id FROM users WHERE id = ? FOR UPDATE', [userId])
  if (!user) throw new Error('user_not_found')
}

export function buildOrderIdempotencyKey({ userId, tradingAccountId, signalId, clientRequestId }) {
  const actor = toPositiveId(userId)
  if (!actor) throw new Error('invalid_user_id')
  const account = toPositiveId(tradingAccountId) || `legacy-user-${actor}`
  let identity
  if (signalId != null) {
    identity = `signal:${String(signalId)}`
  } else {
    const requestId = String(clientRequestId || '').trim()
    if (!requestId) throw new Error('client_request_id_required')
    identity = `client:${requestId}`
  }
  const raw = `user:${actor}|account:${account}|${identity}`
  return `oi:${createHash('sha256').update(raw).digest('hex')}`
}

function replayResult(row) {
  const saved = safeParse(row.result_json, {})
  if (row.status === 'awaiting_confirmation') {
    return { ...saved, status: 'needs_confirmation', order_intent_id: row.id, idempotent_replay: true }
  }
  if (row.status === 'uncertain' || row.status === 'bridge_sending') {
    return {
      ...saved,
      status: 'uncertain',
      message: saved.message || '订单结果待确认，禁止自动重发',
      order_intent_id: row.id,
      idempotent_replay: true,
    }
  }
  if (row.status === 'preparing' || row.status === 'prepared') {
    return { status: 'in_progress', message: '订单正在处理中', order_intent_id: row.id, idempotent_replay: true }
  }
  return { ...saved, order_intent_id: row.id, idempotent_replay: true }
}

async function claimIntent({ userId, tradingAccountId, idempotencyKey, sourceType, sourceId, clientRequestId, action, request }) {
  const leaseToken = randomUUID()
  return withTransaction(async run => {
    await lockAccountScope(run, userId, tradingAccountId)
    const existing = await txOne(run, 'SELECT * FROM order_intents WHERE idempotency_key = ? FOR UPDATE', [idempotencyKey])
    if (existing) {
      if (TERMINAL_STATUSES.has(existing.status) || existing.status === 'uncertain' || existing.status === 'bridge_sending') {
        return { replay: replayResult(existing) }
      }
      if (existing.status === 'awaiting_confirmation' && request.confirm !== true) {
        return { replay: replayResult(existing) }
      }
      if ((existing.status === 'preparing' || existing.status === 'prepared') && leaseIsActive(existing)) {
        return { replay: replayResult(existing) }
      }
      await run(
        `UPDATE order_intents SET status = 'preparing', lease_token = ?,
           lease_expires_at = DATE_ADD(NOW(), INTERVAL ? SECOND), request_json = ?,
           result_json = NULL, error_code = NULL, updated_at = ? WHERE id = ?`,
        [leaseToken, LEASE_SECONDS, JSON.stringify(request), beijingNow(), existing.id]
      )
      return { intentId: Number(existing.id), leaseToken }
    }
    const [insert] = await run(
      `INSERT INTO order_intents
        (idempotency_key, user_id, trading_account_id, source_type, source_id, client_request_id,
         action, symbol, request_json, status, lease_token, lease_expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'preparing', ?, DATE_ADD(NOW(), INTERVAL ? SECOND), ?, ?)`,
      [
        idempotencyKey, userId, tradingAccountId, sourceType, sourceId || null, clientRequestId || null,
        action, request.symbol || null, JSON.stringify(request), leaseToken, LEASE_SECONDS, beijingNow(), beijingNow(),
      ]
    )
    return { intentId: Number(insert.insertId), leaseToken }
  })
}

async function finishBeforeSend(intentId, leaseToken, status, result, errorCode = null) {
  await withTransaction(async run => {
    const intent = await txOne(run, 'SELECT * FROM order_intents WHERE id = ? FOR UPDATE', [intentId])
    if (!intent || intent.lease_token !== leaseToken || intent.status === 'bridge_sending') return
    await run(
      `UPDATE order_intents SET status = ?, result_json = ?, error_code = ?, lease_token = NULL,
         lease_expires_at = NULL, updated_at = ?, completed_at = CASE WHEN ? = 'awaiting_confirmation' THEN NULL ELSE ? END
       WHERE id = ?`,
      [status, JSON.stringify(result), errorCode, beijingNow(), status, beijingNow(), intentId]
    )
    await run(
      "UPDATE risk_reservations SET status = 'released', updated_at = ? WHERE order_intent_id = ? AND status = 'active'",
      [beijingNow(), intentId]
    )
  })
}

async function reserveRisk(intentId, leaseToken, userId, tradingAccountId, request, risk, statefulValidate, riskContext) {
  const stateResult = await withTransaction(async run => {
    await lockAccountScope(run, userId, tradingAccountId)
    const intent = await txOne(run, 'SELECT id, status, lease_token FROM order_intents WHERE id = ? FOR UPDATE', [intentId])
    if (!intent || intent.status !== 'preparing' || intent.lease_token !== leaseToken) throw new Error('order_intent_lease_lost')
    const state = typeof statefulValidate === 'function'
      ? await statefulValidate({ run, userId, tradingAccountId, intentId, request, risk, riskContext })
      : null
    if (state?.reject_code) {
      const rules = [...(risk?.rule_results || []), { code: state.reject_code, outcome: 'reject', details: state.details || {} }]
      if (risk?.risk_decision_id) {
        await run(`UPDATE risk_decisions SET decision_status = 'reject', reject_code = ?, rule_results_json = ? WHERE id = ?`,
          [state.reject_code, JSON.stringify(rules), risk.risk_decision_id])
      }
      return state
    }
    if (state?.adjusted) {
      request.volume = state.approved_volume
      risk.approved_order = { ...(risk.approved_order || request), volume: state.approved_volume }
      risk.rule_results = [...(risk.rule_results || []), { code: 'R6.4_OBSERVATION_VOLUME_CAP', outcome: 'adjust', details: { volume: state.approved_volume } }]
      risk.risk_amount = Number(risk.risk_amount || 0) * state.approved_volume / Number(risk.original_order?.volume || request.volume)
      if (risk.risk_decision_id) {
        await run(`UPDATE risk_decisions SET decision_status = 'adjust', approved_order_json = ?, rule_results_json = ? WHERE id = ?`,
          [JSON.stringify(risk.approved_order), JSON.stringify(risk.rule_results), risk.risk_decision_id])
      }
    }
    if (state?.shadow_rules?.length) {
      risk.rule_results = [...(risk.rule_results || []), ...state.shadow_rules]
      if (risk?.risk_decision_id) {
        await run('UPDATE risk_decisions SET rule_results_json = ? WHERE id = ?',
          [JSON.stringify(risk.rule_results), risk.risk_decision_id])
      }
    }
    await run(
      `INSERT INTO risk_reservations
        (order_intent_id, user_id, trading_account_id, symbol, reserved_volume, reserved_risk_amount,
         reserved_daily_count, reserved_notional, status, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, 'active', DATE_ADD(NOW(), INTERVAL ? SECOND), ?, ?)
       ON DUPLICATE KEY UPDATE reserved_volume = VALUES(reserved_volume),
         reserved_risk_amount = VALUES(reserved_risk_amount), reserved_daily_count = 1,
         reserved_notional = VALUES(reserved_notional), status = 'active',
         expires_at = VALUES(expires_at), updated_at = VALUES(updated_at)`,
      [
        intentId, userId, tradingAccountId, request.symbol || null, Number(request.volume) || 0,
        risk?.risk_amount ?? null, state?.reserved_notional ?? null, RESERVATION_SECONDS, beijingNow(), beijingNow(),
      ]
    )
    await run(
      `UPDATE order_intents SET status = 'prepared', request_json = ?, risk_json = ?,
         original_order_json = ?, approved_order_json = ?, risk_decision_id = ?,
         lease_expires_at = DATE_ADD(NOW(), INTERVAL ? SECOND), updated_at = ? WHERE id = ?`,
      [
        JSON.stringify(request), JSON.stringify(risk || {}),
        JSON.stringify(risk?.original_order || request), JSON.stringify(risk?.approved_order || request),
        risk?.risk_decision_id || null, LEASE_SECONDS, beijingNow(), intentId,
      ]
    )
    return state
  })
  if (stateResult?.reject_code) {
    throw new StatefulRiskReject(stateResult.reject_code, {
      ...(stateResult.details || {}),
      rules: [...(risk?.rule_results || []), {
        code: stateResult.reject_code,
        outcome: 'reject',
        details: stateResult.details || {},
      }],
    })
  }
}

async function markBridgeSending(intentId, leaseToken, userId, tradingAccountId, bridgeAction, bridgeParams,
  beforeBridgeSendTx = null) {
  return withTransaction(async run => {
    await lockAccountScope(run, userId, tradingAccountId)
    const intent = await txOne(run, 'SELECT * FROM order_intents WHERE id = ? FOR UPDATE', [intentId])
    if (!intent || intent.status !== 'prepared' || intent.lease_token !== leaseToken) throw new Error('order_intent_lease_lost')
    if (typeof beforeBridgeSendTx === 'function') {
      await beforeBridgeSendTx({ run, intent, intentId, userId, tradingAccountId, bridgeAction })
    }
    const bridgeRef = `AI-${Number(intentId).toString(36).toUpperCase()}`.slice(0, 24)
    // The MT5 comment is the durable execution identity. Never allow a caller
    // supplied comment to replace it; the original request remains in request_json.
    const payload = { ...bridgeParams, comment: bridgeRef }
    await run(
      `UPDATE order_intents SET status = 'bridge_sending', bridge_command_ref = ?, bridge_payload_json = ?,
         lease_expires_at = DATE_ADD(NOW(), INTERVAL ? SECOND), updated_at = ? WHERE id = ?`,
      [bridgeRef, JSON.stringify({ action: bridgeAction, params: payload }), LEASE_SECONDS, beijingNow(), intentId]
    )
    return { bridgeRef, payload }
  })
}

async function finalizeBridgeResult(intentId, leaseToken, bridgeAction, bridgeResult) {
  const ticket = executionTicket(bridgeResult, bridgeAction)
  const succeeded = bridgeResult?.status === 'success' && ticket != null
  const explicitReject = isDeterministicBrokerReject(bridgeResult)
  const status = succeeded ? 'succeeded' : explicitReject ? 'rejected' : 'uncertain'
  const retcode = brokerRetcode(bridgeResult)
  const brokerMessage = brokerReason(bridgeResult)
  const safeBroker = explicitReject
    ? buildSafeExecutionOutcome({
      status:'rejected', classification:'broker_rejection',
      reason:brokerMessage || 'broker_rejected',
      details:{ retcode }, retcode,
      stage:'bridge_send', field:'execution',
    })
    : null
  const safeUncertain = !succeeded && !explicitReject
    ? buildSafeExecutionOutcome({
      status:'uncertain', classification:'execution_uncertain', reason:'bridge_result_uncertain',
      details:{}, stage:'bridge_send', field:'execution',
    }) : null
  const result = succeeded
    ? bridgeResult
    : explicitReject
      ? { ...safeBroker, status:'rejected' }
      : { ...safeUncertain, status:'uncertain' }
  await withTransaction(async run => {
    // Outcome creation needs the owning user, source and approved request too.
    // Selecting only lifecycle fields made a successful MT5 order fail during
    // post-send persistence with `signal_outcomes.user_id cannot be null`.
    const intent = await txOne(run, 'SELECT * FROM order_intents WHERE id = ? FOR UPDATE', [intentId])
    if (!intent || intent.status !== 'bridge_sending' || intent.lease_token !== leaseToken) return
    await run(
      `UPDATE order_intents SET status = ?, trade_ticket = ?, pending_ticket = ?, result_json = ?,
         error_code = ?, lease_token = NULL, lease_expires_at = NULL, updated_at = ?, completed_at = ? WHERE id = ?`,
      [
        status, succeeded && !isPendingAction(bridgeAction) ? String(ticket) : null,
        succeeded && isPendingAction(bridgeAction) ? String(ticket) : null,
        JSON.stringify(result), succeeded ? null : (brokerMessage || status),
        beijingNow(), succeeded || explicitReject ? beijingNow() : null, intentId,
      ]
    )
    if (succeeded) {
      await run("UPDATE risk_reservations SET status = 'committed', updated_at = ? WHERE order_intent_id = ? AND status = 'active'", [beijingNow(), intentId])
      if (intent.trading_account_id) await recordSuccessfulOpenTx(run, intent.trading_account_id)
      await createSignalOutcomeTx(run, intent, bridgeResult, bridgeAction)
    } else if (explicitReject) {
      await run("UPDATE risk_reservations SET status = 'released', updated_at = ? WHERE order_intent_id = ? AND status = 'active'", [beijingNow(), intentId])
    }
  })
  return { ...result, order_intent_id: intentId, bridge_command_ref: undefined }
}

async function recoverPostSendFailure(intentId, leaseToken, error) {
  return withTransaction(async run => {
    const intent = await txOne(run, 'SELECT * FROM order_intents WHERE id = ? FOR UPDATE', [intentId])
    const safe = buildSafeExecutionOutcome({
      status:'uncertain', classification:'execution_uncertain', reason:'post_send_finalization_failed',
      details:{}, stage:'execution', field:'execution',
    })
    if (!intent) return { ...safe, status:'uncertain', order_intent_id: intentId }
    if (intent.status !== 'bridge_sending') return replayResult(intent)
    const result = { ...safe, status:'uncertain' }
    await run(
      `UPDATE order_intents SET status = 'uncertain', result_json = ?, error_code = ?,
         lease_token = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ? AND lease_token = ?`,
      [JSON.stringify(result), 'post_send_finalization_failed', beijingNow(), intentId, leaseToken]
    )
    // Reservation deliberately stays active until reconciliation.
    return { ...result, order_intent_id: intentId }
  })
}

/**
 * Execute every new market/pending order through one durable intent.
 * Account/quote/Bridge network calls always occur outside DB transactions.
 */
export async function prepareAndExecuteOrderIntent({
  userId,
  tradingAccountId = null,
  signalId = null,
  clientRequestId = null,
  sourceType = 'manual',
  sourceId = null,
  action = 'open',
  request = {},
  config = {},
  options = {},
  validateRequest,
  buildBridgeCall,
  beforeBridgeSend,
  beforeBridgeSendTx,
  afterRiskPrepared,
  enrichRequest,
  loadRiskContext,
  resolveTradingAccount,
  statefulValidate,
  bridge = mt5Bridge,
}) {
  const actorId = toPositiveId(userId)
  if (!actorId) return buildSafeExecutionOutcome({
    status:'failed', classification:'preparation_failure', reason:'invalid_user_id',
    stage:'validation', field:'account',
  })
  let accountId = toPositiveId(tradingAccountId)
  let account = null
  let preparationStage = 'account_snapshot'
  let preparationField = 'account'
  if (typeof resolveTradingAccount === 'function') {
    try {
      preparationStage = 'account_snapshot'
      preparationField = 'account'
      account = await bridge(actorId, 'account', {}, options)
      if (!account || account.status === 'error') throw new Error(account?.message || account?.error || 'account_snapshot_failed')
      preparationStage = 'risk_context'
      preparationField = 'account'
      const resolved = await resolveTradingAccount({ actorId, account, requestedAccountId: accountId })
      accountId = toPositiveId(resolved?.accountId)
      if (!accountId) throw new Error('trading_account_resolution_failed')
    } catch (error) {
      const reason = error?.reason || error?.message || 'trading_account_resolution_failed'
      return {
        ...buildSafeExecutionOutcome({ status:'failed', classification:'preparation_failure', reason,
          details:error?.details || {}, stage:error?.stage || preparationStage, field:error?.field || preparationField }),
        order_intent_id:null,
      }
    }
  }
  const effectiveClientId = clientRequestId || request.client_request_id || request.request_id || null
  let idempotencyKey
  try {
    idempotencyKey = buildOrderIdempotencyKey({ userId: actorId, tradingAccountId: accountId, signalId, clientRequestId: effectiveClientId })
  } catch (error) {
    return buildSafeExecutionOutcome({
      status:'failed', classification:'preparation_failure', reason:error.message,
      stage:'validation', field:'execution',
    })
  }
  let claim
  try {
    claim = await claimIntent({
      userId: actorId, tradingAccountId: accountId, idempotencyKey, sourceType,
      sourceId: sourceId || signalId, clientRequestId: effectiveClientId, action, request,
    })
  } catch (error) {
    return buildSafeExecutionOutcome({
      status:'failed', classification:'preparation_failure', reason:error.message,
      stage:'risk_reservation', field:'execution',
    })
  }
  if (claim.replay) return claim.replay
  const { intentId, leaseToken } = claim
  const preparedRequest = { ...request }
  let quote = null
  let bridgeStarted = false
  try {
    preparationStage = 'account_snapshot'
    preparationField = 'account'
    account = account || await bridge(actorId, 'account', {}, options)
    if (!account || account.status === 'error') throw new Error(account?.message || account?.error || 'account_snapshot_failed')
    if (preparedRequest.symbol) {
      preparationStage = 'quote_snapshot'
      preparationField = 'quote'
      quote = await bridge(actorId, 'quote', { symbol: preparedRequest.symbol }, options)
      if (!quote || quote.status === 'error') throw new Error(quote?.message || quote?.error || 'quote_snapshot_failed')
    }
    if (typeof enrichRequest === 'function') {
      preparationStage = 'validation'
      preparationField = 'request'
      await enrichRequest({ request: preparedRequest, account, quote })
    }
    preparationStage = 'risk_context'
    preparationField = 'risk_snapshot'
    const riskContext = typeof loadRiskContext === 'function'
      ? await loadRiskContext({ bridge, actorId, tradingAccountId: accountId, request: preparedRequest, account, quote, bridgeOptions: options, intentId })
      : { quote, instrument: options.instrument || null }
    preparationStage = 'validation'
    preparationField = 'risk_policy'
    const risk = await validateRequest(config, account, preparedRequest, { ...riskContext, intentId, tradingAccountId: accountId })
    if (risk?.approved_order) Object.assign(preparedRequest, risk.approved_order)
    preparationStage = 'risk_reservation'
    preparationField = 'volume'
    await reserveRisk(intentId, leaseToken, actorId, accountId, preparedRequest, risk, statefulValidate, riskContext)
    preparationStage = 'bridge_payload'
    preparationField = 'bridge_payload'
    const { bridgeAction, bridgeParams } = buildBridgeCall(preparedRequest)
    if (!['open', 'pending'].includes(bridgeAction)) throw new Error('invalid_new_order_bridge_action')
    if (typeof beforeBridgeSend === 'function') {
      preparationStage = 'before_bridge_send'
      preparationField = 'execution'
      await beforeBridgeSend({ actorId, sourceType, bridgeAction, request:preparedRequest, intentId })
    }
    if (typeof afterRiskPrepared === 'function') {
      preparationStage = 'before_bridge_send'
      preparationField = 'execution'
      await afterRiskPrepared({
        actorId,
        sourceType,
        bridgeAction,
        bridgeParams,
        request:preparedRequest,
        intentId,
        risk,
      })
    }
    preparationStage = 'bridge_send'
    preparationField = 'execution'
    const sending = await markBridgeSending(intentId, leaseToken, actorId, accountId, bridgeAction, bridgeParams,
      beforeBridgeSendTx)
    bridgeStarted = true
    let bridgeResult
    try {
      bridgeResult = await bridge(actorId, bridgeAction, sending.payload, options)
    } catch (error) {
      bridgeResult = { status: 'error', error: error.message }
    }
    const finalized = await finalizeBridgeResult(intentId, leaseToken, bridgeAction, bridgeResult)
    if (quote) finalized.quote = quote
    finalized.risk = risk
    return finalized
  } catch (error) {
    if (bridgeStarted) {
      try {
        return await recoverPostSendFailure(intentId, leaseToken, error)
      } catch {
        return {
        ...buildSafeExecutionOutcome({ status:'uncertain', classification:'execution_uncertain', reason:'post_send_finalization_failed',
            details:{}, stage:'execution', field:'execution' }), order_intent_id:intentId,
        }
      }
    }
    const reason = error?.reason || error?.message || 'order_prepare_failed'
    const awaitingConfirmation = reason === 'confirmation_required'
    const result = awaitingConfirmation
      ? {
        status:'needs_confirmation', classification:'needs_confirmation', reason,
        reason_code:reason, message:'需要人工确认', details:{}, order_intent_id:intentId,
      }
      : {
        ...buildSafeExecutionOutcome({
          status:isRiskRejection(error) ? 'rejected' : 'failed',
          classification:isRiskRejection(error) ? 'risk_rejection' : 'preparation_failure',
          reason, details:error?.details || {}, stage:error?.stage || preparationStage,
          field:error?.field || preparationField, retcode:error?.retcode,
        }), order_intent_id:intentId,
      }
    await finishBeforeSend(intentId, leaseToken, awaitingConfirmation ? 'awaiting_confirmation' : result.status, result, reason)
    return result
  }
}

export async function recoverExpiredOrderIntentLeases() {
  const rows = await queryAll(
    `SELECT id FROM order_intents
     WHERE status IN ('preparing','prepared','bridge_sending')
       AND lease_expires_at IS NOT NULL AND lease_expires_at < NOW()
     ORDER BY id ASC LIMIT 200`
  )
  let recovered = 0
  for (const row of rows) {
    await withTransaction(async run => {
      const intent = await txOne(run, 'SELECT * FROM order_intents WHERE id = ? FOR UPDATE', [row.id])
      if (!intent || !['preparing', 'prepared', 'bridge_sending'].includes(intent.status) || leaseIsActive(intent)) return
      if (intent.status === 'bridge_sending') {
        await run(
          `UPDATE order_intents SET status = 'uncertain', result_json = ?, error_code = 'bridge_lease_expired',
             lease_token = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?`,
          [JSON.stringify({ status: 'uncertain', message: 'bridge_lease_expired' }), beijingNow(), intent.id]
        )
      } else {
        await run(
          `UPDATE order_intents SET status = 'failed', result_json = ?, error_code = 'prepare_lease_expired',
             lease_token = NULL, lease_expires_at = NULL, updated_at = ?, completed_at = ? WHERE id = ?`,
          [JSON.stringify({ status: 'error', message: 'prepare_lease_expired' }), beijingNow(), beijingNow(), intent.id]
        )
        await run("UPDATE risk_reservations SET status = 'released', updated_at = ? WHERE order_intent_id = ? AND status = 'active'", [beijingNow(), intent.id])
      }
      recovered += 1
    })
  }
  return recovered
}

function reconciliationLookbackSeconds(intent, nowMs = Date.now()) {
  const raw = String(intent?.created_at || intent?.updated_at || '').trim()
  const normalized = raw && !/[zZ]|[+-]\d\d:?\d\d$/.test(raw)
    ? `${raw.replace(' ', 'T')}+08:00` : raw
  const createdMs = Date.parse(normalized)
  if (!Number.isFinite(createdMs)) return 48 * 60 * 60
  return Math.max(6 * 60 * 60, Math.min(MAX_RECONCILIATION_LOOKBACK_SECONDS,
    Math.ceil((nowMs - createdMs) / 1000) + 60 * 60))
}

function intentAgeMs(intent, nowMs = Date.now()) {
  const raw = String(intent?.created_at || intent?.updated_at || '').trim()
  const normalized = raw && !/[zZ]|[+-]\d\d:?\d\d$/.test(raw)
    ? `${raw.replace(' ', 'T')}+08:00` : raw
  const createdMs = Date.parse(normalized)
  return Number.isFinite(createdMs) ? Math.max(0, nowMs - createdMs) : 0
}

export async function reconcileUncertainOrderIntents({ bridge = mt5Bridge, limit = 50 } = {}) {
  const intents = await queryAll(
    `SELECT * FROM order_intents WHERE status = 'uncertain' ORDER BY updated_at ASC LIMIT ?`,
    [Math.max(1, Math.min(Number(limit) || 50, 200))]
  )
  let resolved = 0
  for (const intent of intents) {
    const exactTicket = String(intent?.trade_ticket || intent?.pending_ticket || '').trim()
    if (!exactTicket && intentAgeMs(intent) > MAX_RECONCILIATION_LOOKBACK_SECONDS * 1000) {
      // The broker can no longer be searched authoritatively by comment alone.
      // Keep the risk reservation and intent in uncertain for manual review.
      continue
    }
    const bridgePayload = safeParse(intent.bridge_payload_json, {})
    const expectedKind = bridgePayload.action === 'pending' ? 'pending' : 'trade'
    let lookup = null
    let found = null
    let foundKind = null
    try {
      lookup = await bridge(intent.user_id, 'order_lookup', {
        symbol: intent.symbol,
        bridge_command_ref: intent.bridge_command_ref,
        trade_ticket: intent.trade_ticket,
        pending_ticket: intent.pending_ticket,
        expected_kind:expectedKind,
        lookback_seconds: reconciliationLookbackSeconds(intent),
      }, { noFallback: true })
      if (lookup?.status !== 'success') continue
      const definitiveReject = lookup.found === true && lookup.kind === 'rejected'
      if (!lookup.found || definitiveReject) {
        if (!definitiveReject && lookup.complete !== true) continue
        if (!definitiveReject && intentAgeMs(intent) < DEFINITIVE_ABSENCE_GRACE_MS) continue
        let absentDeliveries = []
        await withTransaction(async run => {
          const current = await txOne(run, 'SELECT * FROM order_intents WHERE id = ? FOR UPDATE', [intent.id])
          if (!current || current.status !== 'uncertain') return
          const reconciledOutcome = buildSafeExecutionOutcome({
            status:definitiveReject ? 'rejected' : 'failed',
            classification:definitiveReject ? 'broker_rejection' : 'preparation_failure',
            reason:definitiveReject ? 'broker_rejected_order_confirmed' : 'order_not_found_after_complete_reconciliation',
            details:{ lookback_seconds:Number(lookup.lookback_seconds) || null },
            stage:'execution', field:'execution',
            retcode:lookup.retcode ?? lookup.broker_retcode,
          })
          const reconciledResult = {
            ...reconciledOutcome, reconciled:true,
            definitive_not_found:!definitiveReject, definitive_reject:definitiveReject,
            lookback_seconds:Number(lookup.lookback_seconds) || null,
          }
          const terminalStatus = definitiveReject ? 'rejected' : 'failed'
          const errorCode = definitiveReject ? 'reconciled_broker_reject' : 'reconciled_not_found'
          await run(`UPDATE order_intents SET status = ?, result_json = ?,
            error_code = ?, updated_at = ?, completed_at = ? WHERE id = ?`,
          [terminalStatus, JSON.stringify(reconciledResult), errorCode, beijingNow(), beijingNow(), intent.id])
          await run("UPDATE risk_reservations SET status = 'released', updated_at = ? WHERE order_intent_id = ? AND status = 'active'",
            [beijingNow(), intent.id])
          absentDeliveries = await txAll(run,
            'SELECT id, signal_id FROM auto_signal_deliveries WHERE order_intent_id = ? FOR UPDATE', [intent.id])
          for (const delivery of absentDeliveries) {
            await run(`UPDATE auto_signal_deliveries SET execution_status = ?, execution_result = ? WHERE id = ?`,
              [terminalStatus, JSON.stringify(reconciledResult), delivery.id])
          }
          const auditAction = definitiveReject
            ? 'order_intent_reconciled_broker_reject'
            : 'order_intent_reconciled_not_found'
          await run(`INSERT INTO trade_audit_logs
            (user_id, action, symbol, request_json, result_json, status,
              trading_account_id, created_at_utc_msc, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
            current.user_id, auditAction, current.symbol || null,
            JSON.stringify({ order_intent_id:current.id, bridge_command_ref:current.bridge_command_ref,
              trading_account_id:current.trading_account_id || null }),
            JSON.stringify({ complete:true, lookback_seconds:reconciledResult.lookback_seconds,
              delivery_ids:absentDeliveries.map(item => item.id) }),
            terminalStatus,
            current.trading_account_id || null,
            Date.now(),
            beijingNow(),
          ])
          resolved += 1
        })
        const reconciledOutcome = buildSafeExecutionOutcome({
          status:definitiveReject ? 'rejected' : 'failed',
          classification:definitiveReject ? 'broker_rejection' : 'preparation_failure',
          reason:definitiveReject ? 'broker_rejected_order_confirmed' : 'order_not_found_after_complete_reconciliation',
          details:{ lookback_seconds:Number(lookup.lookback_seconds) || null },
          stage:'execution', field:'execution',
          retcode:lookup.retcode ?? lookup.broker_retcode,
        })
        for (const delivery of absentDeliveries) {
          sendToBrowsers(intent.user_id, buildSafeExecutionEvent(reconciledOutcome, {
            type:'signal_execution_updated', signal_id:Number(delivery.signal_id),
            reconciled:true, definitive_not_found:!definitiveReject, definitive_reject:definitiveReject,
          }))
        }
        if (absentDeliveries.length) {
          broadcastAdminEvent('ai', 'signal_execution_updated', buildSafeExecutionEvent(reconciledOutcome, {
            user_id:Number(intent.user_id), reconciled:true,
            definitive_not_found:!definitiveReject, definitive_reject:definitiveReject,
            signal_ids:absentDeliveries.map(item => Number(item.signal_id)),
          }), { scopes:['ai-operations', 'risk-audit'], refresh:true })
        }
        continue
      }
      found = lookup
      foundKind = lookup.kind === 'pending' ? 'pending' : 'trade'
    } catch {
      continue
    }
    if (!found) continue
    const ticket = executionTicket(found, foundKind === 'pending' ? 'pending' : 'open')
    if (ticket == null) continue
    let recoveredDeliveries = []
    await withTransaction(async run => {
      const current = await txOne(run, 'SELECT * FROM order_intents WHERE id = ? FOR UPDATE', [intent.id])
      if (!current || current.status !== 'uncertain') return
      const bridgeAction = foundKind === 'pending' ? 'pending' : 'open'
      const pendingState = foundKind === 'pending' && ['pending', 'partially_filled', 'filled', 'cancelled', 'expired']
        .includes(String(found.pending_state || '').toLowerCase())
        ? String(found.pending_state).toLowerCase() : 'pending'
      const pendingExecuted = ['partially_filled', 'filled'].includes(pendingState)
      const recoveredResult = {
        ...found,
        status:'success',
        reconciled:true,
        ticket,
        order:found.order ?? ticket,
        kind:foundKind,
      }
      await run(
        `UPDATE order_intents SET status = 'succeeded', trade_ticket = ?, pending_ticket = ?, result_json = ?,
           error_code = NULL, updated_at = ?, completed_at = ? WHERE id = ?`,
        [
          foundKind === 'trade' && ticket != null ? String(ticket) : null,
          foundKind === 'pending' && ticket != null ? String(ticket) : null,
          JSON.stringify(recoveredResult),
          beijingNow(),
          beijingNow(),
          intent.id,
        ]
      )
      await run("UPDATE risk_reservations SET status = 'committed', updated_at = ? WHERE order_intent_id = ? AND status = 'active'", [beijingNow(), intent.id])
      if (current.trading_account_id) await recordSuccessfulOpenTx(run, current.trading_account_id)
      await createSignalOutcomeTx(run, current, recoveredResult, bridgeAction)

      recoveredDeliveries = await txAll(run,
        'SELECT id, signal_id FROM auto_signal_deliveries WHERE order_intent_id = ? FOR UPDATE', [intent.id])
      for (const delivery of recoveredDeliveries) {
        if (foundKind === 'pending') {
          await run(`UPDATE auto_signal_deliveries SET execution_status = 'success', pending_ticket = ?,
            pending_state = ?, is_executed = ?,
            executed_at = CASE WHEN ? = 1 THEN COALESCE(executed_at, NOW()) ELSE executed_at END,
            pending_valid_until = COALESCE(pending_valid_until,
              (SELECT pending_valid_until FROM ai_signals WHERE id = signal_id)), execution_result = ?
            WHERE id = ?`, [String(ticket), pendingState, pendingExecuted ? 1 : 0,
            pendingExecuted ? 1 : 0, JSON.stringify(recoveredResult), delivery.id])
        } else {
          await run(`UPDATE auto_signal_deliveries SET execution_status = 'success', is_executed = 1,
            executed_at = COALESCE(executed_at, NOW()), trade_ticket = ?, execution_result = ? WHERE id = ?`,
          [String(ticket), JSON.stringify(recoveredResult), delivery.id])
        }
        await run('UPDATE signal_outcomes SET delivery_id = ?, updated_at = ? WHERE order_intent_id = ?',
          [delivery.id, beijingNow(), intent.id])
      }
      if (foundKind === 'pending' && ['cancelled', 'expired'].includes(pendingState)) {
        await run(`UPDATE signal_outcomes SET status = ?, attribution_status = 'not_filled',
          last_scan_at = ?, updated_at = ? WHERE order_intent_id = ?`,
        [pendingState, beijingNow(), beijingNow(), intent.id])
      }
      await run(`INSERT INTO trade_audit_logs
        (user_id, action, symbol, request_json, result_json, status,
          trading_account_id, created_at_utc_msc, created_at)
        VALUES (?, 'order_intent_reconciled', ?, ?, ?, 'success', ?, ?, ?)`, [
        current.user_id, current.symbol || null,
        JSON.stringify({ order_intent_id:current.id, bridge_command_ref:current.bridge_command_ref,
          trading_account_id:current.trading_account_id || null }),
        JSON.stringify({ ticket:String(ticket), kind:foundKind, delivery_ids:recoveredDeliveries.map(item => item.id) }),
        current.trading_account_id || null,
        Date.now(),
        beijingNow(),
      ])
      resolved += 1
    })
    if (recoveredDeliveries.length) {
      for (const delivery of recoveredDeliveries) {
        sendToBrowsers(intent.user_id, {
          type:'signal_execution_updated', signal_id:Number(delivery.signal_id), status:'success', reconciled:true,
          pending_ticket:foundKind === 'pending' ? String(ticket) : null,
          trade_ticket:foundKind === 'trade' ? String(ticket) : null,
        })
      }
      broadcastAdminEvent('ai', 'signal_execution_updated', {
        user_id:Number(intent.user_id), status:'success', reconciled:true,
        signal_ids:recoveredDeliveries.map(item => Number(item.signal_id)),
      }, { scopes:['ai-operations', 'risk-audit'], refresh:true })
    }
  }
  return resolved
}

export function startOrderIntentReconciler() {
  if (reconcileTimer) return
  reconcileStopping = false
  const run = () => {
    if (reconcileStopping) return Promise.resolve({ skipped:'stopped' })
    if (reconcileInFlight) {
      skippedOverlapCount += 1
      console.warn(`[OrderIntent] Reconciler skipped-overlap (count=${skippedOverlapCount})`)
      return reconcileInFlight
    }
    const promise = (async () => {
      try {
        await recoverExpiredOrderIntentLeases()
        await reconcileUncertainOrderIntents()
      } catch (error) {
        console.error('[OrderIntent] Reconciler failed:', error.message)
      }
    })()
    reconcileInFlight = promise
    promise.finally(() => {
      if (reconcileInFlight === promise) reconcileInFlight = null
    }).catch(() => {})
    return promise
  }
  reconcileTimer = setInterval(run, RECONCILE_INTERVAL_MS)
  reconcileTimer.unref?.()
  void run()
}

export function stopOrderIntentReconciler() {
  reconcileStopping = true
  if (reconcileTimer) clearInterval(reconcileTimer)
  reconcileTimer = null
  return reconcileInFlight
}

export const __orderIntentTest = {
  getReconcilerRuntime: () => ({
    timerActive:Boolean(reconcileTimer),
    inFlight:Boolean(reconcileInFlight),
    skippedOverlapCount,
    stopping:reconcileStopping,
  }),
}
