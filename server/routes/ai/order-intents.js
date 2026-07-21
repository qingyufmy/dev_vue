// ai/order-intents.js — unified new-order intent, idempotency and reconciliation gateway

import { createHash, randomUUID } from 'crypto'
import { queryAll, queryOne, withTransaction, beijingNow } from '../../db.js'
import { mt5Bridge } from './market-data.js'
import { StatefulRiskReject, recordSuccessfulOpenTx } from './risk-state.js'
import { createSignalOutcomeTx } from './signal-outcomes.js'

const TERMINAL_STATUSES = new Set(['succeeded', 'rejected', 'failed'])
const DETERMINISTIC_BROKER_RETCODES = new Set([10013, 10014, 10015, 10016, 10017, 10018, 10019, 10022, 10030, 10035, 10038])
const LEASE_SECONDS = 30
const RESERVATION_SECONDS = 10 * 60
const RECONCILE_INTERVAL_MS = 30_000

let reconcileTimer = null

function toPositiveId(value) {
  const id = Number(value)
  return Number.isInteger(id) && id > 0 ? id : null
}

function safeParse(value, fallback = {}) {
  if (!value) return fallback
  try { return JSON.parse(value) } catch { return fallback }
}

function ticketFromResult(result) {
  return result?.order ?? result?.ticket ?? result?.order_id ?? result?.trade_ticket ?? result?.pending_ticket ?? null
}

function isPendingAction(action) {
  return action === 'pending'
}

function isDeterministicBrokerReject(result) {
  if (result?.status === 'rejected') return true
  const retcode = Number(result?.retcode)
  if (Number.isInteger(retcode) && DETERMINISTIC_BROKER_RETCODES.has(retcode)) return true
  const message = String(result?.message || result?.error || '').trim().toLowerCase()
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

async function markBridgeSending(intentId, leaseToken, userId, tradingAccountId, bridgeAction, bridgeParams) {
  return withTransaction(async run => {
    await lockAccountScope(run, userId, tradingAccountId)
    const intent = await txOne(run, 'SELECT * FROM order_intents WHERE id = ? FOR UPDATE', [intentId])
    if (!intent || intent.status !== 'prepared' || intent.lease_token !== leaseToken) throw new Error('order_intent_lease_lost')
    const bridgeRef = `AI-${Number(intentId).toString(36).toUpperCase()}`.slice(0, 24)
    const payload = { ...bridgeParams, comment: String(bridgeParams.comment || bridgeRef).slice(0, 31) }
    await run(
      `UPDATE order_intents SET status = 'bridge_sending', bridge_command_ref = ?, bridge_payload_json = ?,
         lease_expires_at = DATE_ADD(NOW(), INTERVAL ? SECOND), updated_at = ? WHERE id = ?`,
      [bridgeRef, JSON.stringify({ action: bridgeAction, params: payload }), LEASE_SECONDS, beijingNow(), intentId]
    )
    return { bridgeRef, payload }
  })
}

async function finalizeBridgeResult(intentId, leaseToken, bridgeAction, bridgeResult) {
  const ticket = ticketFromResult(bridgeResult)
  const succeeded = bridgeResult?.status === 'success' && ticket != null
  const explicitReject = isDeterministicBrokerReject(bridgeResult)
  const status = succeeded ? 'succeeded' : explicitReject ? 'rejected' : 'uncertain'
  const result = succeeded
    ? bridgeResult
    : explicitReject
      ? { ...bridgeResult, status: 'rejected' }
      : { ...bridgeResult, status: 'uncertain', message: bridgeResult?.message || bridgeResult?.error || '订单结果待确认，禁止自动重发' }
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
        JSON.stringify(result), succeeded ? null : (bridgeResult?.error || bridgeResult?.message || status),
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
    if (!intent) return { status: 'uncertain', message: error.message, order_intent_id: intentId }
    if (intent.status !== 'bridge_sending') return replayResult(intent)
    const result = { status: 'uncertain', message: error.message || 'post_send_finalization_failed' }
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
  enrichRequest,
  loadRiskContext,
  resolveTradingAccount,
  statefulValidate,
  bridge = mt5Bridge,
}) {
  const actorId = toPositiveId(userId)
  if (!actorId) return { status: 'rejected', message: 'invalid_user_id' }
  let accountId = toPositiveId(tradingAccountId)
  let account = null
  if (typeof resolveTradingAccount === 'function') {
    try {
      account = await bridge(actorId, 'account', {}, options)
      if (!account || account.status === 'error') throw new Error(account?.message || account?.error || 'account_snapshot_failed')
      const resolved = await resolveTradingAccount({ actorId, account, requestedAccountId: accountId })
      accountId = toPositiveId(resolved?.accountId)
      if (!accountId) throw new Error('trading_account_resolution_failed')
    } catch (error) {
      return { status: 'rejected', message: error.message || 'trading_account_resolution_failed' }
    }
  }
  const effectiveClientId = clientRequestId || request.client_request_id || request.request_id || null
  let idempotencyKey
  try {
    idempotencyKey = buildOrderIdempotencyKey({ userId: actorId, tradingAccountId: accountId, signalId, clientRequestId: effectiveClientId })
  } catch (error) {
    return { status: 'rejected', message: error.message }
  }
  let claim
  try {
    claim = await claimIntent({
      userId: actorId, tradingAccountId: accountId, idempotencyKey, sourceType,
      sourceId: sourceId || signalId, clientRequestId: effectiveClientId, action, request,
    })
  } catch (error) {
    return { status: 'error', message: error.message }
  }
  if (claim.replay) return claim.replay
  const { intentId, leaseToken } = claim
  const preparedRequest = { ...request }
  let quote = null
  let bridgeStarted = false
  try {
    account = account || await bridge(actorId, 'account', {}, options)
    if (!account || account.status === 'error') throw new Error(account?.message || account?.error || 'account_snapshot_failed')
    if (preparedRequest.symbol) {
      quote = await bridge(actorId, 'quote', { symbol: preparedRequest.symbol }, options)
      if (!quote || quote.status === 'error') throw new Error(quote?.message || quote?.error || 'quote_snapshot_failed')
    }
    if (typeof enrichRequest === 'function') {
      await enrichRequest({ request: preparedRequest, account, quote })
    }
    const riskContext = typeof loadRiskContext === 'function'
      ? await loadRiskContext({ bridge, actorId, tradingAccountId: accountId, request: preparedRequest, account, quote, bridgeOptions: options, intentId })
      : { quote, instrument: options.instrument || null }
    const risk = await validateRequest(config, account, preparedRequest, { ...riskContext, intentId, tradingAccountId: accountId })
    if (risk?.approved_order) Object.assign(preparedRequest, risk.approved_order)
    await reserveRisk(intentId, leaseToken, actorId, accountId, preparedRequest, risk, statefulValidate, riskContext)
    const { bridgeAction, bridgeParams } = buildBridgeCall(preparedRequest)
    if (!['open', 'pending'].includes(bridgeAction)) throw new Error('invalid_new_order_bridge_action')
    const sending = await markBridgeSending(intentId, leaseToken, actorId, accountId, bridgeAction, bridgeParams)
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
        return { status: 'uncertain', message: error.message || 'post_send_finalization_failed', order_intent_id: intentId }
      }
    }
    const reason = error?.reason || error?.message || 'order_prepare_failed'
    const awaitingConfirmation = reason === 'confirmation_required'
    const result = {
      status: awaitingConfirmation ? 'needs_confirmation' : 'rejected',
      message: reason,
      details: error?.details || {},
      order_intent_id: intentId,
    }
    await finishBeforeSend(intentId, leaseToken, awaitingConfirmation ? 'awaiting_confirmation' : 'rejected', result, reason)
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
  return Math.max(6 * 60 * 60, Math.min(10 * 365 * 24 * 60 * 60, Math.ceil((nowMs - createdMs) / 1000) + 60 * 60))
}

export async function reconcileUncertainOrderIntents({ bridge = mt5Bridge, limit = 50 } = {}) {
  const intents = await queryAll(
    `SELECT * FROM order_intents WHERE status = 'uncertain' ORDER BY updated_at ASC LIMIT ?`,
    [Math.max(1, Math.min(Number(limit) || 50, 200))]
  )
  let resolved = 0
  for (const intent of intents) {
    let found = null
    let foundKind = null
    try {
      const lookup = await bridge(intent.user_id, 'order_lookup', {
        symbol: intent.symbol,
        bridge_command_ref: intent.bridge_command_ref,
        trade_ticket: intent.trade_ticket,
        pending_ticket: intent.pending_ticket,
        lookback_seconds: reconciliationLookbackSeconds(intent),
      }, { noFallback: true })
      if (lookup?.status !== 'success' || !lookup?.found) continue
      found = lookup
      foundKind = lookup.kind === 'pending' ? 'pending' : 'trade'
    } catch {
      continue
    }
    if (!found) continue
    const ticket = ticketFromResult(found)
    await withTransaction(async run => {
      const current = await txOne(run, 'SELECT id, status FROM order_intents WHERE id = ? FOR UPDATE', [intent.id])
      if (!current || current.status !== 'uncertain') return
      await run(
        `UPDATE order_intents SET status = 'succeeded', trade_ticket = ?, pending_ticket = ?, result_json = ?,
           error_code = NULL, updated_at = ?, completed_at = ? WHERE id = ?`,
        [
          foundKind === 'trade' && ticket != null ? String(ticket) : null,
          foundKind === 'pending' && ticket != null ? String(ticket) : null,
          JSON.stringify({ status: 'success', reconciled: true, ticket, kind: foundKind }),
          beijingNow(),
          beijingNow(),
          intent.id,
        ]
      )
      await run("UPDATE risk_reservations SET status = 'committed', updated_at = ? WHERE order_intent_id = ? AND status = 'active'", [beijingNow(), intent.id])
      resolved += 1
    })
  }
  return resolved
}

export function startOrderIntentReconciler() {
  if (reconcileTimer) return
  const run = async () => {
    try {
      await recoverExpiredOrderIntentLeases()
      await reconcileUncertainOrderIntents()
    } catch (error) {
      console.error('[OrderIntent] Reconciler failed:', error.message)
    }
  }
  reconcileTimer = setInterval(run, RECONCILE_INTERVAL_MS)
  reconcileTimer.unref?.()
  run()
}

export function stopOrderIntentReconciler() {
  if (!reconcileTimer) return
  clearInterval(reconcileTimer)
  reconcileTimer = null
}
