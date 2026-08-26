// Refresh risk state without creating an order intent. Only accounts with an
// explicitly recoverable R3 state (or incomplete risk data) are selected by
// the background path. A policy save may opt into one targeted active-account
// run.

import { queryAll, queryOne, parseBeijing } from '../../db.js'
import { getBridgeDataRoute, sendBridgeCommand, isBridgeAlive } from '../../bridge-ws.js'
import { stripBrokerSuffix } from './utils.js'
import { resolveEffectiveRiskPolicy } from './risk-policy.js'
import { AUTO_RECOVERABLE_RISK_REASONS, forceResetRiskAccountState, refreshRiskAccountState } from './risk-state.js'

const midpoint = quote => {
  const bid = Number(quote?.bid), ask = Number(quote?.ask)
  return Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0 ? (bid + ask) / 2 : null
}

const riskRefreshFlights = new Map()
const RISK_REASON_PLACEHOLDERS = AUTO_RECOVERABLE_RISK_REASONS.map(() => '?').join(', ')

function routeParams(route) {
  return { terminal_instance_id:route.terminal_instance_id, account_ref:route.account_ref,
    connection_epoch:route.connection_epoch }
}

function sameIdentity(left, right) {
  return String(left?.broker_server || left?.server || '').trim().toUpperCase()
    === String(right?.broker_server || right?.server || '').trim().toUpperCase()
    && String(left?.login || left?.login_account || '').trim() === String(right?.login || right?.login_account || '').trim()
}

function routeForAccount(userId, row) {
  const route = getBridgeDataRoute(userId, Number(row.trading_account_id), { strictAccount:true })
  if (!route) return { error:isBridgeAlive(userId) ? 'bridge_terminal_ambiguous' : 'bridge_terminal_not_connected' }
  if (!sameIdentity(route.account_ref, { broker_server:row.broker_server, login:row.login_account })) {
    return { error:'bridge_terminal_account_mismatch' }
  }
  return { route }
}

function routeStillCurrent(userId, accountId, route) {
  const current = getBridgeDataRoute(userId, accountId, { strictAccount:true })
  if (!current || current.terminal_instance_id !== route.terminal_instance_id) return false
  const expectedGeneration = Number(route.connection_generation || 0)
  const currentGeneration = Number(current.connection_generation || 0)
  if (expectedGeneration > 0 && currentGeneration > 0 && expectedGeneration !== currentGeneration) return false
  const expectedEpoch = Number(route.connection_epoch || 0)
  const currentEpoch = Number(current.connection_epoch || 0)
  if (expectedEpoch > 0 && currentEpoch > 0 && expectedEpoch !== currentEpoch) return false
  return sameIdentity(current.account_ref, route.account_ref)
}

const riskFlightKey = (userId, accountId) => `${Number(userId)}:${Number(accountId)}`

async function performRiskRefresh(userId, row, { trigger = 'background', route, forceReset = false, resetReason = '', flightEntry = null } = {}) {
  const routeResult = route ? { route } : routeForAccount(userId, row)
  if (routeResult.error) return { account_id:Number(row.trading_account_id), refreshed:false, error:routeResult.error }
  const selectedRoute = routeResult.route
  const accountId = Number(row.trading_account_id)
  if (flightEntry) flightEntry.route = selectedRoute

  const task = (async () => {
    const params = routeParams(selectedRoute)
    const symbolRow = await queryOne(`SELECT symbol FROM order_intents
      WHERE user_id = ? AND trading_account_id = ? AND symbol IS NOT NULL AND symbol <> ''
      ORDER BY id DESC LIMIT 1`, [userId, accountId])
    const symbol = String(symbolRow?.symbol || 'XAUUSD').trim().toUpperCase()
    const result = await sendBridgeCommand(userId, 'risk_snapshot', {
      ...params, symbol,
      last_deal_time_msc:Number(row.last_deal_time_msc || 0),
      last_deal_ticket:Number(row.last_deal_ticket || 0),
      baseline_from_utc_msc:Number(row.last_deal_time_msc || 0) ? 0
        : (parseBeijing(row.last_risk_snapshot_at || row.first_verified_at)?.getTime() || Date.now()),
    }, 10_000, { noFallback:true })
    if (!result || result.status !== 'success') {
      return { account_id:accountId, refreshed:false,
        error:String(result?.error || result?.message || 'risk_snapshot_failed') }
    }
    if (!sameIdentity(result.account, selectedRoute.account_ref)) {
      return { account_id:accountId, refreshed:false, error:'risk_snapshot_account_mismatch' }
    }
    if (!routeStillCurrent(userId, accountId, selectedRoute)) {
      return { account_id:accountId, refreshed:false, error:'bridge_route_changed' }
    }

    const instruments = {}
    for (const item of Object.values(result.instruments || {})) {
      if (item?.name) instruments[stripBrokerSuffix(item.name)] = item
    }
    const accountCurrency = String(result.account?.currency || '').toUpperCase()
    const fxRates = {}
    const quoteCurrencies = new Set([...(result.positions || []), ...(result.pending || [])]
      .map(item => instruments[stripBrokerSuffix(item.symbol)]?.currency_profit || stripBrokerSuffix(item.symbol).slice(3, 6))
      .map(value => String(value || '').toUpperCase()).filter(Boolean))
    for (const currency of quoteCurrencies) {
      if (!currency || !accountCurrency || currency === accountCurrency) continue
      for (const pair of [`${currency}${accountCurrency}`, `${accountCurrency}${currency}`]) {
        const quote = await sendBridgeCommand(userId, 'quote', { ...params, symbol:pair }, 5_000, { noFallback:true })
        const rate = midpoint(quote)
        if (rate) { fxRates[pair] = rate; break }
      }
    }

    // Quotes may take long enough for the terminal to reconnect. Do not let a
    // late result from the old connection update the newly routed account.
    const resolved = forceReset ? null
      : await resolveEffectiveRiskPolicy({ userId, tradingAccountId:accountId })
    if (!routeStillCurrent(userId, accountId, selectedRoute)) {
      return { account_id:accountId, refreshed:false, error:'bridge_route_changed' }
    }
    const snapshot = {
      account:result.account || {}, positions:result.positions || [], pending:result.pending || [],
      instruments, fxRates, snapshot_complete:result.complete === true,
      data_incomplete_reasons:result.incomplete_reasons || [],
      risk_snapshot_version:Number(result.snapshot_version || 0),
      timezone_offset_minutes:result.timezone_offset_minutes == null
        || result.timezone_offset_minutes === '' ? null : Number(result.timezone_offset_minutes),
      clock_status:result.clock_status || '', businessDate:result.business_date,
      increment:result.increment || {}, risk_refresh_trigger:trigger,
    }
    const state = forceReset
      ? await forceResetRiskAccountState(userId, accountId, snapshot, resetReason)
      : await refreshRiskAccountState(userId, accountId, snapshot, resolved.policy)
    return { account_id:accountId, refreshed:true, complete:result.complete === true,
      recovered:Boolean(state.transition?.recovered || state.manual_reset), manual_reset:Boolean(state.manual_reset), state }
  })()
  return task
}

function trackRiskRefreshFlight(key, entry, task) {
  entry.promise = Promise.resolve(task).finally(() => {
    if (riskRefreshFlights.get(key) === entry) riskRefreshFlights.delete(key)
  })
  riskRefreshFlights.set(key, entry)
  return entry.promise
}

function refreshOne(userId, row, options = {}) {
  const accountId = Number(row.trading_account_id)
  const key = riskFlightKey(userId, accountId)
  const forceReset = options.forceReset === true
  const existing = riskRefreshFlights.get(key)
  if (existing) {
    // A normal refresh can always merge into the current account flight. A
    // manual reset is different: it must not be mistaken for that snapshot.
    if (!forceReset || existing.kind === 'manual') return existing.promise
    const entry = { kind:'manual', force_reset:true, account_id:accountId, route:null, promise:null }
    riskRefreshFlights.set(key, entry)
    const task = existing.promise.catch(() => null).then(async () => {
      // The ordinary flight may have used an old cursor or terminal. Read the
      // candidate again and let performRiskRefresh obtain a fresh strict route.
      const latestRows = await selectRecoverableRiskRows(userId, { accountId, includeActive:true })
      const latestRow = latestRows.find(item => Number(item.trading_account_id) === accountId) || row
      return performRiskRefresh(userId, latestRow, { ...options, route:undefined, flightEntry:entry })
    })
    return trackRiskRefreshFlight(key, entry, task)
  }
  const entry = { kind:forceReset ? 'manual' : 'normal', force_reset:forceReset,
    account_id:accountId, route:null, promise:null }
  riskRefreshFlights.set(key, entry)
  return trackRiskRefreshFlight(key, entry, performRiskRefresh(userId, row, { ...options, flightEntry:entry }))
}

async function selectRecoverableRiskRows(userId, { accountId = null, includeActive = false } = {}) {
  const params = [Number(userId)]
  let accountFilter = ''
  if (Number(accountId) > 0) {
    accountFilter = ' AND ta.id = ?'
  }
  const targetedActive = includeActive && Number(accountId) > 0
  const candidateClause = targetedActive
    ? `(ras.data_complete = 0 OR ras.halt_reason IN (${RISK_REASON_PLACEHOLDERS}) OR ta.id = ?)`
    : `(ras.data_complete = 0 OR ras.halt_reason IN (${RISK_REASON_PLACEHOLDERS}))`
  params.push(...AUTO_RECOVERABLE_RISK_REASONS)
  if (targetedActive) params.push(Number(accountId))
  if (Number(accountId) > 0) params.push(Number(accountId))
  return queryAll(`SELECT ta.id AS trading_account_id, ta.broker_server, ta.login_account,
      ta.first_verified_at, ta.review_status, ta.observe_status,
      ras.halt_status, ras.halt_reason, ras.user_kill_switch, ras.data_complete,
      ras.last_deal_time_msc, ras.last_deal_ticket, ras.last_risk_snapshot_at
    FROM trading_accounts ta JOIN risk_account_state ras ON ras.trading_account_id = ta.id
    WHERE ta.user_id = ? AND ta.is_deleted = 0 AND ta.review_status = 'approved'
      AND ta.observe_status = 'active' AND ras.user_kill_switch = 0
      AND ras.halt_status <> 'protection_incident'
      AND (ras.halt_reason IS NULL OR ras.halt_reason NOT LIKE 'R6_%')
      AND ${candidateClause}${accountFilter}`, params)
}

export async function refreshRecoverableRiskAccounts(userId, options = {}) {
  const numericUserId = Number(userId)
  const accountId = Number(options.accountId || 0) || null
  const forceReset = options.forceReset === true && accountId != null
  const includeActive = (options.includeActive === true || forceReset) && accountId != null
  const trigger = String(options.trigger || 'background')
  const resetReason = String(options.resetReason || '').trim().slice(0, 500)
  if (!isBridgeAlive(numericUserId)) {
    return { attempted:0, refreshed:0, recovered:0, still_halted:0, recoverable_remaining:0,
      results:[], bridge_connected:false, pending_reason:'bridge_terminal_not_connected' }
  }
  const rows = await selectRecoverableRiskRows(numericUserId, { accountId, includeActive })
  const results = []
  for (const row of rows) {
    try { results.push(await refreshOne(numericUserId, row, { trigger, forceReset, resetReason })) }
    catch (error) {
      results.push({ account_id:Number(row.trading_account_id), refreshed:false,
        error:String(error?.message || error) })
    }
  }
  const recoverableRemaining = results.filter(item => !item.refreshed || item.state?.preserved
    || item.state?.halt_status !== 'active' || item.state?.data_complete === false
    || Number(item.state?.data_complete) === 0).length
  return { attempted:rows.length, refreshed:results.filter(item => item.refreshed).length,
    recovered:results.filter(item => item.recovered).length,
    still_halted:results.filter(item => item.state?.halt_status !== 'active').length,
    recoverable_remaining:recoverableRemaining, results, bridge_connected:true }
}

// Compatibility export for older callers. The implementation now covers
// complete R3 halts as well as incomplete snapshots.
export async function refreshIncompleteRiskAccounts(userId) {
  return refreshRecoverableRiskAccounts(userId, { trigger:'background' })
}
