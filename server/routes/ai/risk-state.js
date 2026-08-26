// Stateful L2/L3/L6 risk governance. Database locks are the safety boundary.

import { queryRun, withTransaction, beijingNow, logAudit, parseBeijing } from '../../db.js'
import { stripBrokerSuffix } from './utils.js'
import { riskRuleIsEnforced } from './rollout-governance.js'

const toNumber = value => Number.isFinite(Number(value)) ? Number(value) : 0
const txOne = async (run, sql, params = []) => ((await run(sql, params))[0] || [])[0] || null
const nowDate = () => beijingNow().slice(0, 10)
const validTimezoneOffset = value => value !== null && value !== undefined && value !== ''
  && Number.isInteger(Number(value)) && Number(value) >= -720 && Number(value) <= 840
const validBusinessDate = value => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))
const verifiedClock = value => {
  const status = String(value || '').trim().toLowerCase()
  return status && !['unknown', 'unavailable', 'unverified', 'calibrating', 'fallback'].includes(status)
}
const absoluteFloatingPnl = (positions = []) => positions.reduce((sum, item) =>
  sum + toNumber(item.profit) + toNumber(item.swap), 0)

const IDENTITY_SYNC_MAX_ATTEMPTS = 3
const IDENTITY_SYNC_RETRY_BASE_DELAY_MS = 10
const IDENTITY_SYNC_RETRY_MAX_DELAY_MS = 100
const IDENTITY_SYNC_RETRY_JITTER_MS = 10
const identitySyncFlights = new Map()

// This is the persisted meaning of the risk counters, not the Bridge wire
// snapshot version. A zero/NULL row is legacy and is upgraded only after a
// complete snapshot with a verified MT5 clock.
export const RISK_CALCULATION_SEMANTIC_VERSION = 2

// These are the only risk reasons that the background snapshot worker may
// resolve.  Kill switches, protection incidents and account-ownership/permission
// fences are deliberately kept outside this list so a data refresh can never
// clear an operator or identity decision.
export const AUTO_RECOVERABLE_RISK_REASONS = Object.freeze([
  'R3_RISK_DATA_INCOMPLETE',
  'R3.1_DAILY_LOSS_LIMIT',
  'R3.2_CONSECUTIVE_LOSS_COOLDOWN',
  'R3.3_MAX_DRAWDOWN',
])

// MySQL deadlocks are safe to retry only for this idempotent identity transaction.
const isIdentityDeadlock = error => {
  const code = String(error?.code || '').trim().toUpperCase()
  const sqlState = String(error?.sqlState ?? error?.sqlstate ?? '').trim().toUpperCase()
  return code === 'ER_LOCK_DEADLOCK' || Number(error?.errno) === 1213 || sqlState === '40001'
}

const identityRetryDelay = attempt => {
  const exponentialDelay = IDENTITY_SYNC_RETRY_BASE_DELAY_MS * (2 ** Math.max(0, attempt - 1))
  const jitter = Math.floor(Math.random() * (IDENTITY_SYNC_RETRY_JITTER_MS + 1))
  return Math.min(IDENTITY_SYNC_RETRY_MAX_DELAY_MS, exponentialDelay + jitter)
}

const sleepForIdentityRetry = delayMs => new Promise(resolve => setTimeout(resolve, delayMs))

async function withIdentityDeadlockRetry(transaction) {
  for (let attempt = 1; attempt <= IDENTITY_SYNC_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await withTransaction(transaction)
    } catch (error) {
      if (attempt >= IDENTITY_SYNC_MAX_ATTEMPTS || !isIdentityDeadlock(error)) throw error
      await sleepForIdentityRetry(identityRetryDelay(attempt))
    }
  }
  throw new Error('identity_transaction_retry_exhausted')
}

function enqueueIdentitySync(identityKey, operation) {
  const previous = identitySyncFlights.get(identityKey) || Promise.resolve()
  const current = previous.catch(() => {}).then(operation)
  const tracked = current.finally(() => {
    if (identitySyncFlights.get(identityKey) === tracked) identitySyncFlights.delete(identityKey)
  })
  identitySyncFlights.set(identityKey, tracked)
  return tracked
}

export class StatefulRiskReject extends Error {
  constructor(reason, details = {}) {
    super(reason); this.reason = reason; this.details = details
  }
}

export function aggregateClosedPositions(orders = []) {
  const grouped = new Map()
  for (const order of orders) {
    const id = String(order.position_id ?? order.ticket ?? order.order ?? '')
    if (!id) continue
    const current = grouped.get(id) || { position_id: id, net: 0, close_time: '' }
    current.net += toNumber(order.profit) + toNumber(order.commission) + toNumber(order.swap) + toNumber(order.fee)
    if (String(order.close_time || order.time || '') > current.close_time) current.close_time = String(order.close_time || order.time || '')
    grouped.set(id, current)
  }
  return [...grouped.values()].sort((a, b) => b.close_time.localeCompare(a.close_time))
}

function cashFlow(statistics = {}) {
  return toNumber(statistics.deposit) - toNumber(statistics.withdrawal) + toNumber(statistics.credit)
}

function historyComplete(history) {
  if (!history || history.status !== 'success') return false
  const expected = toNumber(history.pagination?.total_count)
  return expected <= (history.orders || []).length
}

function cursorOf(value = {}, timeKey = 'time_msc', ticketKey = 'ticket') {
  return [Math.max(0, Number(value?.[timeKey]) || 0), Math.max(0, Number(value?.[ticketKey]) || 0)]
}

function compareCursor(left, right) {
  return left[0] === right[0] ? left[1] - right[1] : left[0] - right[0]
}

function calculateIncrementalMetrics({ account, positions = [], pending = [], instruments = {}, fxRates = {}, previousState = {}, businessDate = null, snapshot_complete = true, data_incomplete_reasons = [], increment = {}, timezone_offset_minutes = null, clock_status = '' }) {
  const stateCursor = [Math.max(0, Number(previousState.last_deal_time_msc) || 0), Math.max(0, Number(previousState.last_deal_ticket) || 0)]
  const requestedCursor = cursorOf(increment.requested_cursor)
  const throughCursor = cursorOf(increment.through_cursor)
  const reasons = [...new Set((data_incomplete_reasons || []).map(String).filter(Boolean))]
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(businessDate || ''))) reasons.push('terminal_business_date_missing')
  const clockStatus = String(clock_status || '').trim().toLowerCase()
  if (!validTimezoneOffset(timezone_offset_minutes) || !clockStatus
    || ['unknown', 'unavailable', 'unverified', 'calibrating', 'fallback'].includes(clockStatus)) {
    reasons.push('terminal_clock_unverified')
  }
  if (!snapshot_complete && reasons.length === 0) reasons.push('risk_snapshot_incomplete')
  if (stateCursor[0] > 0 && compareCursor(requestedCursor, stateCursor) > 0) reasons.push('deal_cursor_gap')
  const afterState = item => compareCursor(cursorOf(item, item.close_time_msc != null ? 'close_time_msc' : 'time_msc', item.close_deal_ticket != null ? 'close_deal_ticket' : 'ticket'), stateCursor) > 0
  const closed = (increment.closed_positions || []).filter(afterState)
    .sort((a, b) => compareCursor(cursorOf(a, 'close_time_msc', 'close_deal_ticket'), cursorOf(b, 'close_time_msc', 'close_deal_ticket')))
  const accountEvents = (increment.account_events || []).filter(afterState)
  const newDay = String(previousState.business_date || '') !== String(businessDate || '')
  const currentClosedNet = closed.filter(item => item.business_date === businessDate).reduce((sum, item) => sum + toNumber(item.net), 0)
  const currentPnlAdjustments = accountEvents.filter(item => item.category === 'pnl_adjustment' && item.business_date === businessDate).reduce((sum, item) => sum + toNumber(item.amount), 0)
  const currentCapitalDelta = accountEvents.filter(item => item.category === 'capital' && item.business_date === businessDate).reduce((sum, item) => sum + toNumber(item.amount), 0)
  const capitalDelta = accountEvents.filter(item => item.category === 'capital').reduce((sum, item) => sum + toNumber(item.amount), 0)
  const realized = (newDay ? 0 : toNumber(previousState.day_realized_net)) + currentClosedNet + currentPnlAdjustments
  const floating = positions.reduce((sum, item) => sum + toNumber(item.profit) + toNumber(item.swap), 0)
  const resetBusinessDate = String(previousState.manual_reset_business_date || '')
  const resetFloatingBaseline = Number(previousState.manual_reset_floating_baseline)
  const manualBaselineActive = !newDay && validBusinessDate(businessDate)
    && resetBusinessDate === String(businessDate) && Number.isFinite(resetFloatingBaseline)
  const effectiveFloating = manualBaselineActive ? floating - resetFloatingBaseline : floating
  const equity = toNumber(account?.equity)
  const dayStartEquity = newDay || !(toNumber(previousState.day_start_equity) > 0)
    ? equity - realized - floating - currentCapitalDelta : toNumber(previousState.day_start_equity)
  const dailyPnl = manualBaselineActive ? realized + effectiveFloating : realized + Math.min(0, floating)
  const dailyLossPct = dayStartEquity > 0 ? Math.max(0, -dailyPnl / dayStartEquity * 100) : null
  const cumulativeCashFlow = toNumber(previousState.cumulative_cash_flow) + capitalDelta
  const previousCalculationVersion = Math.max(0, Number(previousState.risk_calculation_version) || 0)
  const legacyRebaseCandidate = snapshot_complete && validBusinessDate(businessDate)
    && validTimezoneOffset(timezone_offset_minutes) && verifiedClock(clockStatus)
    && equity > 0 && reasons.length === 0 && dailyLossPct != null
  const oldHigh = toNumber(previousState.equity_high_water) || equity
  // Maximum drawdown is an MT5-day guard. A new terminal business date starts
  // from the first complete snapshot's current equity and never inherits the
  // previous day's peak.
  const correctedHigh = newDay
    ? equity
    : (legacyRebaseCandidate && previousCalculationVersion < RISK_CALCULATION_SEMANTIC_VERSION
        ? equity : oldHigh + capitalDelta)
  const highWater = Math.max(equity, correctedHigh)
  const drawdownPct = highWater > 0 ? Math.max(0, (highWater - equity) / highWater * 100) : null
  let consecutiveLosses = toNumber(previousState.consecutive_losses)
  const lossStreakEvents = []
  for (const position of closed) {
    const previousCount = consecutiveLosses
    consecutiveLosses = toNumber(position.net) < 0 ? consecutiveLosses + 1 : 0
    lossStreakEvents.push({ previous_count:previousCount, count:consecutiveLosses,
      close_time_msc:Number(position.close_time_msc || 0), close_time_utc_msc:Number(position.close_time_utc_msc || 0) })
  }
  const notional = exposureNotional([...positions, ...pending], instruments, account?.currency, fxRates)
  const dataComplete = snapshot_complete && reasons.length === 0 && equity > 0 && dailyLossPct != null && drawdownPct != null
  const trustedCompleteSnapshot = dataComplete && validBusinessDate(businessDate)
    && validTimezoneOffset(timezone_offset_minutes) && verifiedClock(clockStatus)
  const riskCalculationRebased = trustedCompleteSnapshot
    && previousCalculationVersion < RISK_CALCULATION_SEMANTIC_VERSION && !newDay
  const riskCalculationVersion = trustedCompleteSnapshot
    ? RISK_CALCULATION_SEMANTIC_VERSION : previousCalculationVersion
  const nextCursor = compareCursor(throughCursor, stateCursor) >= 0 ? throughCursor : stateCursor
  return {
    business_date: businessDate, equity, realized, floating, day_start_equity: dayStartEquity,
    day_floating_pnl:effectiveFloating, daily_loss_pct: dailyLossPct, cumulative_cash_flow: cumulativeCashFlow, equity_high_water: highWater,
    drawdown_pct: drawdownPct, consecutive_losses: consecutiveLosses, notional, data_complete: dataComplete,
    data_incomplete_reasons: reasons, last_deal_time_msc: nextCursor[0], last_deal_ticket: nextCursor[1],
    manual_reset_business_date:manualBaselineActive ? resetBusinessDate : null,
    manual_reset_floating_baseline:manualBaselineActive ? resetFloatingBaseline : null,
    risk_calculation_version:riskCalculationVersion, risk_calculation_rebased:riskCalculationRebased,
    loss_streak_events:lossStreakEvents,
    timezone_offset_minutes:validTimezoneOffset(timezone_offset_minutes) ? Number(timezone_offset_minutes) : null,
    clock_status:clockStatus || 'unknown',
  }
}

function beijingDateTimeFromUtcMs(utcMs) {
  return new Date(Number(utcMs) + 8 * 3600000).toISOString().replace('T', ' ').slice(0, 19)
}

export function consecutiveLossCooldownUntil(metrics, previousLosses, policy, nowMs = Date.now()) {
  const limit = Math.max(1, Number(policy?.consecutive_loss_limit || 0))
  if (Number(previousLosses || 0) >= limit || Number(metrics?.consecutive_losses || 0) < limit) return null
  const crossing = (metrics?.loss_streak_events || []).find(event => Number(event.previous_count || 0) < limit && Number(event.count || 0) >= limit)
  if (!crossing) return null
  let closeUtcMs = Number(crossing.close_time_utc_msc || 0)
  if (!(closeUtcMs > 0)) {
    const rawCloseMs = Number(crossing.close_time_msc || 0)
    if (rawCloseMs > 0 && validTimezoneOffset(metrics.timezone_offset_minutes)) {
      closeUtcMs = rawCloseMs - Number(metrics.timezone_offset_minutes) * 60000
    }
  }
  if (!(closeUtcMs > 0)) return null
  const deadlineUtcMs = closeUtcMs + Math.max(1, Number(policy?.loss_cooldown_minutes || 0)) * 60000
  return deadlineUtcMs > Number(nowMs) ? beijingDateTimeFromUtcMs(deadlineUtcMs) : null
}

function exposureNotional(items, instruments, accountCurrency, fxRates = {}) {
  let total = 0
  for (const item of items || []) {
    const symbol = stripBrokerSuffix(item.symbol)
    const instrument = instruments[symbol]
    const volume = toNumber(item.volume ?? item.volume_current ?? item.volume_initial)
    const price = toNumber(item.price_current ?? item.price_open ?? item.open_price ?? item.price)
    const contract = toNumber(instrument?.contract_size)
    if (!(volume > 0 && price > 0 && contract > 0)) return null
    let value = volume * contract * price
    const quoteCurrency = String(instrument?.currency_profit || (symbol.length >= 6 ? symbol.slice(3, 6) : accountCurrency) || '').toUpperCase()
    if (quoteCurrency && accountCurrency && quoteCurrency !== accountCurrency) {
      const direct = toNumber(fxRates[`${quoteCurrency}${accountCurrency}`])
      const inverse = toNumber(fxRates[`${accountCurrency}${quoteCurrency}`])
      if (direct > 0) value *= direct
      else if (inverse > 0) value /= inverse
      else return null
    }
    total += value
  }
  return total
}

export function calculateAccountRiskMetrics(input = {}) {
  if (input.risk_snapshot_version >= 1) return calculateIncrementalMetrics(input)
  const { account, positions = [], pending = [], historyToday, historyAll, instruments = {}, fxRates = {}, previousState = {}, businessDate = nowDate(), snapshot_complete = true, timezone_offset_minutes = null, clock_status = '' } = input
  const todayOrders = historyToday?.orders || []
  const realized = todayOrders.reduce((sum, item) => sum + toNumber(item.profit) + toNumber(item.commission) + toNumber(item.swap) + toNumber(item.fee), 0)
  const floating = positions.reduce((sum, item) => sum + toNumber(item.profit) + toNumber(item.swap), 0)
  const equity = toNumber(account?.equity)
  const todayCash = cashFlow(historyToday?.statistics)
  const allCash = cashFlow(historyAll?.statistics)
  const newDay = previousState.business_date !== businessDate
  const dayStartEquity = newDay || !(toNumber(previousState.day_start_equity) > 0)
    ? equity - realized - floating - todayCash : toNumber(previousState.day_start_equity)
  const resetBusinessDate = String(previousState.manual_reset_business_date || '')
  const resetFloatingBaseline = Number(previousState.manual_reset_floating_baseline)
  const manualBaselineActive = !newDay && validBusinessDate(businessDate)
    && resetBusinessDate === String(businessDate) && Number.isFinite(resetFloatingBaseline)
  const effectiveFloating = manualBaselineActive ? floating - resetFloatingBaseline : floating
  const dailyPnl = manualBaselineActive ? realized + effectiveFloating : realized + Math.min(0, floating)
  const dailyLossPct = dayStartEquity > 0 ? Math.max(0, -dailyPnl / dayStartEquity * 100) : null

  const oldCash = previousState.cumulative_cash_flow == null ? allCash : toNumber(previousState.cumulative_cash_flow)
  const cashDelta = allCash - oldCash
  const previousCalculationVersion = Math.max(0, Number(previousState.risk_calculation_version) || 0)
  const legacyRebaseCandidate = snapshot_complete && validBusinessDate(businessDate)
    && validTimezoneOffset(timezone_offset_minutes) && verifiedClock(clock_status)
    && equity > 0 && historyComplete(historyToday) && historyComplete(historyAll)
    && dailyLossPct != null
  const oldHigh = toNumber(previousState.equity_high_water) || equity
  const correctedHigh = newDay
    ? equity
    : (legacyRebaseCandidate && previousCalculationVersion < RISK_CALCULATION_SEMANTIC_VERSION
        ? equity : oldHigh + cashDelta)
  const highWater = Math.max(equity, correctedHigh)
  const drawdownPct = highWater > 0 ? Math.max(0, (highWater - equity) / highWater * 100) : null
  const closed = aggregateClosedPositions(historyAll?.orders || [])
  let consecutiveLosses = 0
  for (const position of closed) {
    if (position.net < 0) consecutiveLosses += 1
    else break
  }
  const allItems = [...positions, ...pending]
  const notional = exposureNotional(allItems, instruments, account?.currency, fxRates)
  const dataComplete = snapshot_complete && equity > 0 && historyComplete(historyToday) && historyComplete(historyAll) && dailyLossPct != null && drawdownPct != null
  const trustedCompleteSnapshot = dataComplete && validBusinessDate(businessDate)
    && validTimezoneOffset(timezone_offset_minutes) && verifiedClock(clock_status)
  const riskCalculationRebased = trustedCompleteSnapshot
    && previousCalculationVersion < RISK_CALCULATION_SEMANTIC_VERSION && !newDay
  const riskCalculationVersion = trustedCompleteSnapshot
    ? RISK_CALCULATION_SEMANTIC_VERSION : previousCalculationVersion
  return {
    business_date: businessDate, equity, realized, floating, day_start_equity: dayStartEquity,
    day_floating_pnl:effectiveFloating, daily_loss_pct: dailyLossPct, cumulative_cash_flow: allCash, equity_high_water: highWater,
    drawdown_pct: drawdownPct, consecutive_losses: consecutiveLosses, notional, data_complete: dataComplete,
    data_incomplete_reasons: dataComplete ? [] : ['legacy_history_incomplete'],
    last_deal_time_msc: toNumber(previousState.last_deal_time_msc), last_deal_ticket: toNumber(previousState.last_deal_ticket),
    manual_reset_business_date:manualBaselineActive ? resetBusinessDate : null,
    manual_reset_floating_baseline:manualBaselineActive ? resetFloatingBaseline : null,
    risk_calculation_version:riskCalculationVersion, risk_calculation_rebased:riskCalculationRebased,
  }
}

function riskStateTransition(state, nextStatus, nextReason, now) {
  const previousStatus = String(state?.halt_status || 'active')
  const previousReason = state?.halt_reason == null ? null : String(state.halt_reason)
  const normalizedStatus = String(nextStatus || 'active')
  const normalizedReason = nextReason == null ? null : String(nextReason)
  const statusChanged = previousStatus !== normalizedStatus
  const reasonChanged = previousReason !== normalizedReason
  const changed = statusChanged || reasonChanged
  const previousActive = previousStatus === 'active'
  const nextActive = normalizedStatus === 'active'
  return {
    changed,
    recovered: changed && !previousActive && nextActive,
    halted: changed && previousActive && !nextActive,
    reasonChanged: changed && reasonChanged,
    previous_status: previousStatus,
    previous_reason: previousReason,
    next_status: normalizedStatus,
    next_reason: normalizedReason,
    halt_started_at: previousActive && !nextActive
      ? now : (state?.halt_started_at || null),
    halt_reason_changed_at: !nextActive && reasonChanged
      ? now : (state?.halt_reason_changed_at || null),
    last_recovered_at: !previousActive && nextActive
      ? now : (state?.last_recovered_at || null),
  }
}

async function auditRiskStateTransitionTx(run, userId, accountId, transition, metrics, trigger) {
  if (!transition?.changed) return
  const action = transition.recovered
    ? 'risk_account_recovered'
    : transition.halted
      ? 'risk_account_halted'
      : 'risk_account_halt_reason_changed'
  const detail = JSON.stringify({
    previous_status:transition.previous_status,
    previous_reason:transition.previous_reason,
    status:transition.next_status,
    reason:transition.next_reason,
    daily_loss_pct:metrics?.daily_loss_pct ?? null,
    drawdown_pct:metrics?.drawdown_pct ?? null,
    consecutive_losses:metrics?.consecutive_losses ?? null,
    business_date:metrics?.business_date ?? null,
    snapshot_at:metrics?.last_risk_snapshot_at ?? null,
    trigger:String(trigger || 'risk_snapshot'),
  }).slice(0, 5000)
  // Keep the audit write in the same transaction as the state transition.  If
  // the audit table is unavailable the transaction rolls back and the account
  // remains fail-closed instead of reporting an unaudited recovery.
  await run(`INSERT INTO audit_logs
    (user_id, user_email, user_nickname, action, target_type, target_id, detail, ip, user_agent)
    VALUES (?, '', '', ?, 'trading_account', ?, ?, '', '')`,
  [userId, action, accountId, detail])
}

export async function refreshRiskAccountState(userId, accountId, snapshot, policy) {
  return withTransaction(async run => {
    const account = await txOne(run, `SELECT id, user_id, review_status, observe_status, is_deleted
      FROM trading_accounts WHERE id = ? AND user_id = ? FOR UPDATE`, [accountId, userId])
    if (!account || account.is_deleted) throw new Error('trading_account_not_found')
    const state = await txOne(run, 'SELECT * FROM risk_account_state WHERE trading_account_id = ? AND user_id = ? FOR UPDATE', [accountId, userId])
    if (!state) throw new Error('risk_account_state_not_found')
    const nonRecoverable = state.user_kill_switch
      || state.halt_status === 'protection_incident'
      || String(state.halt_reason || '').startsWith('R6_')
      || !['approved', ''].includes(String(account.review_status || 'approved'))
      || String(account.observe_status || '') !== 'active'
    if (nonRecoverable) {
      return { ...state, preserved:true, transition:null,
        halt_status:String(state.halt_status || 'active'),
        halt_reason:state.halt_reason || null }
    }
    const metrics = calculateAccountRiskMetrics({ ...snapshot, previousState: state })
    let haltReason = null
    if (!metrics.data_complete) haltReason = 'R3_RISK_DATA_INCOMPLETE'
    else if (metrics.daily_loss_pct >= policy.daily_loss_limit_pct) haltReason = 'R3.1_DAILY_LOSS_LIMIT'
    else if (metrics.drawdown_pct >= policy.max_drawdown_pct) haltReason = 'R3.3_MAX_DRAWDOWN'

    const previousLosses = toNumber(state.consecutive_losses)
    let cooldownUntil = state.cooldown_until && parseBeijing(state.cooldown_until)?.getTime() > Date.now() ? state.cooldown_until : null
    if (!cooldownUntil) cooldownUntil = consecutiveLossCooldownUntil(metrics, previousLosses, policy)
    if (!haltReason && cooldownUntil) haltReason = 'R3.2_CONSECUTIVE_LOSS_COOLDOWN'
    const now = beijingNow()
    const nextStatus = haltReason ? 'halted' : 'active'
    const transition = riskStateTransition(state, nextStatus, haltReason, now)
    await run(`UPDATE risk_account_state SET business_date = ?, day_start_equity = ?, day_realized_net = ?, day_floating_pnl = ?,
      cumulative_cash_flow = ?, equity_high_water = ?, drawdown_pct = ?, consecutive_losses = ?, cooldown_until = ?,
      halt_status = ?, halt_reason = ?, data_complete = ?, data_incomplete_reason = ?, last_deal_time_msc = ?,
      last_deal_ticket = ?, last_risk_snapshot_at = ?, manual_reset_business_date = ?,
      manual_reset_floating_baseline = ?, risk_calculation_version = ?, halt_started_at = ?,
      halt_reason_changed_at = ?, last_recovered_at = ?, updated_at = ?
      WHERE trading_account_id = ? AND user_id = ?`,
    [metrics.business_date, metrics.day_start_equity, metrics.realized, metrics.day_floating_pnl ?? metrics.floating, metrics.cumulative_cash_flow,
      metrics.equity_high_water, metrics.drawdown_pct, metrics.consecutive_losses, cooldownUntil,
      haltReason ? 'halted' : 'active', haltReason, metrics.data_complete ? 1 : 0,
      (metrics.data_incomplete_reasons || []).join(',').slice(0, 255) || null,
      metrics.last_deal_time_msc || 0, metrics.last_deal_ticket || 0, now,
      metrics.manual_reset_business_date, metrics.manual_reset_floating_baseline,
      metrics.risk_calculation_version || 0, transition.halt_started_at,
      transition.halt_reason_changed_at, transition.last_recovered_at,
      now, accountId, userId])
    await auditRiskStateTransitionTx(run, userId, accountId, transition,
      { ...metrics, last_risk_snapshot_at:now }, snapshot?.risk_refresh_trigger)
    return { ...metrics, halt_status: nextStatus, halt_reason: haltReason, cooldown_until: cooldownUntil,
      halt_started_at:transition.halt_started_at, halt_reason_changed_at:transition.halt_reason_changed_at,
      last_recovered_at:transition.last_recovered_at, transition }
  })
}

export async function forceResetRiskAccountState(userId, accountId, snapshot, reason = '') {
  return withTransaction(async run => {
    const account = await txOne(run, `SELECT id, user_id, review_status, observe_status, is_deleted
      FROM trading_accounts WHERE id = ? AND user_id = ? FOR UPDATE`, [accountId, userId])
    if (!account || account.is_deleted) throw new Error('trading_account_not_found')
    const state = await txOne(run, 'SELECT * FROM risk_account_state WHERE trading_account_id = ? AND user_id = ? FOR UPDATE', [accountId, userId])
    if (!state) throw new Error('risk_account_state_not_found')
    if (state.user_kill_switch || state.halt_status === 'protection_incident'
      || String(state.halt_reason || '').startsWith('R6_')
      || !['approved', ''].includes(String(account.review_status || 'approved'))
      || String(account.observe_status || '') !== 'active') {
      throw new Error('risk_manual_reset_not_allowed')
    }

    const businessDate = String(snapshot?.businessDate || '')
    const timezoneOffsetMinutes = snapshot?.timezone_offset_minutes
    const clockStatus = String(snapshot?.clock_status || '').trim().toLowerCase()
    const equity = toNumber(snapshot?.account?.equity)
    const floatingBaseline = absoluteFloatingPnl(snapshot?.positions || [])
    const incompleteReasons = (snapshot?.data_incomplete_reasons || []).map(String).filter(Boolean)
    if (snapshot?.snapshot_complete !== true || Number(snapshot?.risk_snapshot_version || 0) < 1
      || incompleteReasons.length > 0 || !validBusinessDate(businessDate)
      || !validTimezoneOffset(timezoneOffsetMinutes) || !clockStatus
      || !verifiedClock(clockStatus)
      || !(equity > 0)) {
      throw new Error('risk_manual_reset_snapshot_unverified')
    }

    const previousCursor = [Math.max(0, Number(state.last_deal_time_msc) || 0), Math.max(0, Number(state.last_deal_ticket) || 0)]
    const snapshotCursor = cursorOf(snapshot?.increment?.through_cursor)
    const nextCursor = compareCursor(snapshotCursor, previousCursor) >= 0 ? snapshotCursor : previousCursor
    const now = beijingNow()
    await run(`UPDATE risk_account_state SET business_date = ?, manual_reset_business_date = ?,
      manual_reset_floating_baseline = ?, day_start_equity = ?, day_realized_net = 0,
      day_floating_pnl = 0, equity_high_water = ?, drawdown_pct = 0, consecutive_losses = 0,
      cooldown_until = NULL, halt_status = 'active', halt_reason = NULL, data_complete = 1,
      risk_calculation_version = ?,
      data_incomplete_reason = NULL, last_deal_time_msc = ?, last_deal_ticket = ?,
      last_risk_snapshot_at = ?, last_recovered_at = ?, updated_at = ?
      WHERE trading_account_id = ? AND user_id = ?`,
    [businessDate, businessDate, floatingBaseline, equity, equity,
      RISK_CALCULATION_SEMANTIC_VERSION, nextCursor[0], nextCursor[1], now, now, now, accountId, userId])
    const detail = JSON.stringify({
      previous_status:String(state.halt_status || 'active'),
      previous_reason:state.halt_reason || null,
      business_date:businessDate,
      equity,
      timezone_offset_minutes:Number(timezoneOffsetMinutes),
      clock_status:clockStatus,
      reason:String(reason || '').trim().slice(0, 500),
      floating_baseline:floatingBaseline,
      reset_fields:['day_realized_net', 'day_floating_pnl', 'equity_high_water', 'drawdown_pct', 'consecutive_losses', 'cooldown_until', 'manual_reset_floating_baseline'],
    }).slice(0, 5000)
    await run(`INSERT INTO audit_logs
      (user_id, user_email, user_nickname, action, target_type, target_id, detail, ip, user_agent)
      VALUES (?, '', '', 'risk_account_manual_reset', 'trading_account', ?, ?, '', '')`,
    [userId, accountId, detail])
    return {
      business_date:businessDate,
      day_start_equity:equity,
      day_realized_net:0,
      day_floating_pnl:0,
      manual_reset_business_date:businessDate,
      manual_reset_floating_baseline:floatingBaseline,
      equity_high_water:equity,
      drawdown_pct:0,
      consecutive_losses:0,
      cooldown_until:null,
      halt_status:'active',
      halt_reason:null,
      data_complete:true,
      last_risk_snapshot_at:now,
      last_recovered_at:now,
      risk_calculation_version:RISK_CALCULATION_SEMANTIC_VERSION,
      manual_reset:true,
      previous_status:String(state.halt_status || 'active'),
      previous_reason:state.halt_reason || null,
    }
  })
}

export async function syncTradingAccountIdentity(userId, snapshot, requestedAccountId = null) {
  const server = String(snapshot?.server || '').trim(), login = String(snapshot?.login || '').trim()
  if (!server || !login) throw new Error('trading_account_identity_incomplete')
  const hasTradingAuthority = snapshot?.trade_allowed === true || Number(snapshot?.trade_allowed) === 1
  const platform = String(snapshot?.source || snapshot?.platform || '').trim().toLowerCase()
  const rawMarginMode = snapshot?.margin_mode
  const numericMarginMode = rawMarginMode == null || rawMarginMode === '' ? Number.NaN : Number(rawMarginMode)
  const snapshotMarginMode = typeof snapshot?.is_hedging === 'boolean'
    ? (snapshot.is_hedging ? 'hedging' : 'netting')
    : platform === 'mt4'
      ? 'hedging'
      : Number.isInteger(numericMarginMode) && numericMarginMode >= 0
        ? (numericMarginMode === 2 ? 'hedging' : 'netting')
        : null
  const serverKey = server.toUpperCase()
  const identityKey = `${serverKey}\n${login}`
  const result = await enqueueIdentitySync(identityKey, async () => {
    const transactionResult = await withIdentityDeadlockRetry(async run => {
    const now = beijingNow()
    const rows = (await run('SELECT * FROM trading_accounts WHERE user_id = ? FOR UPDATE', [userId]))[0]
    let matched = rows.find(row => String(row.broker_server).toUpperCase() === serverKey && String(row.login_account) === login)
    const activeDifferent = rows.filter(row => !row.is_deleted && (String(row.broker_server).toUpperCase() !== serverKey || String(row.login_account) !== login))
    const identityRows = (await run(`SELECT * FROM trading_accounts
      WHERE UPPER(broker_server) = ? AND login_account = ? AND is_deleted = 0 FOR UPDATE`, [serverKey, login]))[0]
    const binding = ((await run(`SELECT * FROM mt5_account_bindings
      WHERE broker_server_key = ? AND login_account = ? FOR UPDATE`, [serverKey, login]))[0] || [])[0] || null
    const canKeepExistingOwnership = Number(binding?.current_user_id || 0) === Number(userId)
    const canClaimOwnership = canKeepExistingOwnership || hasTradingAuthority
    const anomalyCode = canClaimOwnership ? null : 'account_trade_permission_required'
    const reviewStatus = 'approved'
    const observeStatus = canClaimOwnership ? 'active' : 'frozen'
    if (!matched) {
      const [insert] = await run(`INSERT INTO trading_accounts
        (user_id, broker_server, login_account, nickname, margin_mode, review_status, observe_status,
         observed_until, first_verified_at, identity_verified_at, anomaly_code, is_deleted, created_at, updated_at)
        VALUES (?, ?, ?, '', ?, ?, ?, NULL, ?, ?, ?, 0, ?, ?)`,
      [userId, server, login, snapshotMarginMode || 'netting', reviewStatus, observeStatus, now, now, anomalyCode, now, now])
      matched = { id: insert.insertId, user_id: userId, broker_server: server, login_account: login,
        margin_mode:snapshotMarginMode || 'netting', review_status:reviewStatus, observe_status:observeStatus }
    } else if (matched.is_deleted) {
      await run(`UPDATE trading_accounts SET is_deleted = 0, review_status = ?, observe_status = ?,
        observed_until = NULL, first_verified_at = COALESCE(first_verified_at, ?),
        identity_verified_at = ?, anomaly_code = ?, margin_mode = COALESCE(?, margin_mode), updated_at = ? WHERE id = ?`,
      [reviewStatus, observeStatus, now, now, anomalyCode, snapshotMarginMode, now, matched.id])
      matched = { ...matched, is_deleted:0, margin_mode:snapshotMarginMode || matched.margin_mode,
        review_status:reviewStatus, observe_status:observeStatus }
    } else {
      await run(`UPDATE trading_accounts SET review_status = ?,
        observe_status = CASE WHEN ? = 'frozen' THEN 'frozen' WHEN ? = 'paused' THEN 'paused' ELSE 'active' END,
        observed_until = NULL, first_verified_at = COALESCE(first_verified_at, ?), identity_verified_at = ?,
        anomaly_code = ?, margin_mode = COALESCE(?, margin_mode), updated_at = ? WHERE id = ?`,
      [reviewStatus, observeStatus, observeStatus, now, now, anomalyCode, snapshotMarginMode, now, matched.id])
      matched = { ...matched, margin_mode:snapshotMarginMode || matched.margin_mode,
        review_status:reviewStatus, observe_status:observeStatus }
    }
    if (!canClaimOwnership) {
      await run(`INSERT INTO risk_account_state
        (trading_account_id, user_id, halt_status, halt_reason, data_complete,
         halt_started_at, halt_reason_changed_at, created_at, updated_at)
        VALUES (?, ?, 'halted', 'R6_ACCOUNT_TRADE_PERMISSION_REQUIRED', 0, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), halt_status = 'halted',
          halt_started_at = COALESCE(halt_started_at, VALUES(halt_started_at)),
          halt_reason_changed_at = CASE WHEN COALESCE(halt_reason, '') <> VALUES(halt_reason)
            THEN VALUES(halt_reason_changed_at) ELSE halt_reason_changed_at END,
          halt_reason = 'R6_ACCOUNT_TRADE_PERMISSION_REQUIRED', data_complete = 0,
          updated_at = VALUES(updated_at)`,
      [matched.id, userId, now, now, now, now])
      return {
        accountId: Number(matched.id), switched: false, verified: false, anomalyCode,
        ownershipTransferred: false, previousOwnerUserIds: [],
      }
    }

    // The binding is the authoritative current owner. Historical account rows can
    // remain "switched" after their user selects another terminal; treating those
    // rows as a fresh transfer on every reconnect would repeatedly disable that
    // user's bridge controls after a server restart.
    const boundOwnerUserId = Number(binding?.current_user_id || 0)
    const previousOwnerUserIds = boundOwnerUserId > 0
      ? (boundOwnerUserId === Number(userId) ? [] : [boundOwnerUserId])
      : identityRows
        .filter(row => Number(row.user_id) !== Number(userId)
          && !['transferred', 'switched'].includes(String(row.observe_status || '')))
        .map(row => Number(row.user_id)).filter(Boolean)
    const uniquePreviousOwnerUserIds = [...new Set(previousOwnerUserIds)]
    const previousOwnerUserIdSet = new Set(uniquePreviousOwnerUserIds)
    const previousAccountIds = identityRows
      .filter(row => previousOwnerUserIdSet.has(Number(row.user_id))
        && row.observe_status !== 'transferred')
      .map(row => Number(row.id)).filter(Boolean)
    if (previousAccountIds.length) {
      const placeholders = previousAccountIds.map(() => '?').join(',')
      await run(`UPDATE trading_accounts SET observe_status = 'transferred', anomaly_code = 'account_transferred', updated_at = ?
        WHERE id IN (${placeholders})`, [now, ...previousAccountIds])
      await run(`UPDATE strategy_subscriptions SET execution_enabled = 0, updated_at = ?
        WHERE trading_account_id IN (${placeholders}) AND is_deleted = 0`, [now, ...previousAccountIds])
      await run(`UPDATE risk_account_state SET halt_started_at = COALESCE(halt_started_at, ?),
        halt_reason_changed_at = CASE WHEN COALESCE(halt_reason, '') <> 'R6_ACCOUNT_TRANSFERRED'
          THEN ? ELSE halt_reason_changed_at END,
        halt_status = 'halted', halt_reason = 'R6_ACCOUNT_TRANSFERRED', data_complete = 0, updated_at = ?
        WHERE trading_account_id IN (${placeholders})`, [now, now, now, ...previousAccountIds])
    }
    if (uniquePreviousOwnerUserIds.length) {
      const placeholders = uniquePreviousOwnerUserIds.map(() => '?').join(',')
      await run(`UPDATE auto_scheduler SET enabled = 0, updated_at = ? WHERE user_id IN (${placeholders})`, [now, ...uniquePreviousOwnerUserIds])
      await run(`INSERT INTO user_bridge_settings (user_id, trade_send_enabled, auto_reasoning_enabled, updated_at)
        SELECT id, 0, 0, ? FROM users WHERE id IN (${placeholders})
        ON DUPLICATE KEY UPDATE trade_send_enabled = 0, auto_reasoning_enabled = 0, updated_at = VALUES(updated_at)`,
      [now, ...uniquePreviousOwnerUserIds])
    }
    if (activeDifferent.length) {
      const ids = activeDifferent.map(row => Number(row.id))
      await run(`UPDATE trading_accounts SET observe_status = 'switched', updated_at = ? WHERE id IN (${ids.map(() => '?').join(',')})`, [now, ...ids])
      await run(`UPDATE strategy_subscriptions SET trading_account_id = ?, updated_at = ?
        WHERE user_id = ? AND trading_account_id IN (${ids.map(() => '?').join(',')}) AND is_deleted = 0`,
      [matched.id, now, userId, ...ids])
      await run(`UPDATE trading_accounts SET review_status = ?, observe_status = ?,
        observed_until = NULL, anomaly_code = ?, updated_at = ? WHERE id = ?`,
      [reviewStatus, observeStatus, anomalyCode, now, matched.id])
      matched = { ...matched, review_status: reviewStatus, observe_status: observeStatus }
    }
    await run(`UPDATE mt5_account_ownership_history SET ended_at = ?, end_reason = 'account_transferred', updated_at = ?
      WHERE broker_server_key = ? AND login_account = ? AND ended_at IS NULL
        AND (user_id <> ? OR trading_account_id <> ?)`,
    [now, now, serverKey, login, userId, matched.id])
    const activeOwnership = await txOne(run, `SELECT id FROM mt5_account_ownership_history
      WHERE broker_server_key = ? AND login_account = ? AND user_id = ? AND trading_account_id = ?
        AND ended_at IS NULL FOR UPDATE`, [serverKey, login, userId, matched.id])
    if (!activeOwnership) {
      await run(`INSERT INTO mt5_account_ownership_history
        (broker_server_key, login_account, user_id, trading_account_id, started_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`, [serverKey, login, userId, matched.id, now, now, now])
    }
    await run(`INSERT INTO mt5_account_bindings
      (broker_server_key, login_account, current_user_id, current_trading_account_id, last_verified_at,
       first_connected_at, last_connected_at, account_currency, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE current_user_id = VALUES(current_user_id),
        current_trading_account_id = VALUES(current_trading_account_id), last_verified_at = VALUES(last_verified_at),
        first_connected_at = COALESCE(first_connected_at, VALUES(first_connected_at)),
        last_connected_at = VALUES(last_connected_at), account_currency = COALESCE(VALUES(account_currency), account_currency),
        updated_at = VALUES(updated_at)`,
    [serverKey, login, userId, matched.id, now, now, now, String(snapshot?.currency || '').trim().toUpperCase().slice(0, 16) || null, now, now])
    await run(`INSERT INTO risk_account_state (trading_account_id, user_id, halt_status, data_complete, created_at, updated_at)
      VALUES (?, ?, 'active', 0, ?, ?) ON DUPLICATE KEY UPDATE user_id = VALUES(user_id),
        data_complete = CASE WHEN halt_reason IN ('R6_ACCOUNT_TRADE_PERMISSION_REQUIRED', 'R6_ACCOUNT_TRANSFERRED') THEN 0 ELSE data_complete END,
        data_incomplete_reason = CASE WHEN halt_reason IN ('R6_ACCOUNT_TRADE_PERMISSION_REQUIRED', 'R6_ACCOUNT_TRANSFERRED') THEN NULL ELSE data_incomplete_reason END,
        halt_status = CASE WHEN halt_reason IN ('R6_ACCOUNT_TRADE_PERMISSION_REQUIRED', 'R6_ACCOUNT_TRANSFERRED') THEN 'active' ELSE halt_status END,
        last_recovered_at = CASE WHEN halt_reason IN ('R6_ACCOUNT_TRADE_PERMISSION_REQUIRED', 'R6_ACCOUNT_TRANSFERRED')
          THEN VALUES(updated_at) ELSE last_recovered_at END,
        halt_reason = CASE WHEN halt_reason IN ('R6_ACCOUNT_TRADE_PERMISSION_REQUIRED', 'R6_ACCOUNT_TRANSFERRED') THEN NULL ELSE halt_reason END,
        updated_at = VALUES(updated_at)`,
    [matched.id, userId, now, now])
    return {
      accountId: Number(matched.id),
      switched: activeDifferent.length > 0 || Boolean(requestedAccountId && Number(requestedAccountId) !== Number(matched.id)),
      verified: true,
      anomalyCode: null,
      ownershipTransferred: uniquePreviousOwnerUserIds.length > 0,
      previousOwnerUserIds: uniquePreviousOwnerUserIds,
    }
    })
    if (transactionResult.ownershipTransferred) {
    const detail = JSON.stringify({
      broker_server:server, login_account:login, new_user_id:Number(userId),
      previous_user_ids:transactionResult.previousOwnerUserIds, trading_account_id:transactionResult.accountId,
      authority:'mt5_trade_allowed',
    })
    await logAudit({ userId, action:'mt5_account_ownership_acquired', targetType:'trading_account', targetId:transactionResult.accountId, detail })
    for (const previousUserId of transactionResult.previousOwnerUserIds) {
      await logAudit({ userId:previousUserId, action:'mt5_account_ownership_transferred', targetType:'trading_account', targetId:transactionResult.accountId, detail })
    }
    }
    return transactionResult
  })
  return result
}

export async function evaluateStatefulRiskTx(run, { userId, accountId, intentId, request, policy, snapshot, ruleModes = {} }) {
  const shadowRules = []
  const blocked = (rejectCode, details = {}) => ({ reject_code: rejectCode, details })
  const rolloutBlock = (rejectCode, details = {}) => {
    if (riskRuleIsEnforced(rejectCode, ruleModes)) return blocked(rejectCode, details)
    shadowRules.push({ code: rejectCode, outcome: 'shadow_reject', details })
    return null
  }
  const accountRow = await txOne(run, 'SELECT * FROM trading_accounts WHERE id = ? AND user_id = ? AND is_deleted = 0 FOR UPDATE', [accountId, userId])
  if (!accountRow) return blocked('R6_ACCOUNT_NOT_FOUND')
  const global = await txOne(run, 'SELECT * FROM global_risk_control WHERE id = 1 FOR UPDATE')
  if (global?.global_kill_switch) return blocked('R6_GLOBAL_KILL_SWITCH', { reason: global.reason })
  let state = await txOne(run, 'SELECT * FROM risk_account_state WHERE trading_account_id = ? FOR UPDATE', [accountId])
  if (!state) {
    await run(`INSERT INTO risk_account_state (trading_account_id, user_id, halt_status, data_complete, created_at, updated_at)
      VALUES (?, ?, 'active', 0, ?, ?)`, [accountId, userId, beijingNow(), beijingNow()])
    state = { trading_account_id: accountId, user_id: userId, halt_status: 'active', data_complete: 0 }
  }
  if (['paused', 'switched', 'frozen', 'transferred'].includes(accountRow.observe_status)) return blocked('R6_ACCOUNT_PAUSED')
  if (state.user_kill_switch) return blocked('R6_USER_KILL_SWITCH')
  if (state.halt_status === 'protection_incident') {
    return blocked('R3_ACCOUNT_HALTED', { reason:state.halt_reason || 'position_protection_incident' })
  }
  if (state.cooldown_until && parseBeijing(state.cooldown_until)?.getTime() > Date.now()) {
    const rejected = rolloutBlock('R3.2_LOSS_COOLDOWN', { until: state.cooldown_until }); if (rejected) return rejected
  }

  const metrics = calculateAccountRiskMetrics({ ...snapshot, previousState: state })
  let proposedHalt = null
  if (!metrics.data_complete) proposedHalt = 'R3_RISK_DATA_INCOMPLETE'
  else if (metrics.daily_loss_pct >= policy.daily_loss_limit_pct) proposedHalt = 'R3.1_DAILY_LOSS_LIMIT'
  else if (metrics.drawdown_pct >= policy.max_drawdown_pct) proposedHalt = 'R3.3_MAX_DRAWDOWN'
  let haltReason = proposedHalt
  if (proposedHalt && !riskRuleIsEnforced(proposedHalt, ruleModes)) {
    shadowRules.push({ code: proposedHalt, outcome: 'shadow_reject', details: metrics })
    haltReason = null
  }
  // A recovered account is evaluated from current facts on every attempt.
  // Consecutive-loss cooldown is armed only when the threshold is crossed;
  // otherwise an expired cooldown would recreate itself forever.
  const previousLosses = toNumber(state.consecutive_losses)
  let cooldownUntil = consecutiveLossCooldownUntil(metrics, previousLosses, policy)
  if (cooldownUntil && !riskRuleIsEnforced('R3.2_CONSECUTIVE_LOSS_COOLDOWN', ruleModes)) {
    shadowRules.push({ code: 'R3.2_CONSECUTIVE_LOSS_COOLDOWN', outcome: 'shadow_reject', details: { until: cooldownUntil } })
    cooldownUntil = null
  }
  const now = beijingNow()
  const nextStatus = haltReason ? 'halted' : 'active'
  const transition = riskStateTransition(state, nextStatus, haltReason, now)
  await run(`UPDATE risk_account_state SET business_date = ?, day_start_equity = ?, day_realized_net = ?, day_floating_pnl = ?,
    cumulative_cash_flow = ?, equity_high_water = ?, drawdown_pct = ?, consecutive_losses = ?, cooldown_until = ?,
    halt_status = ?, halt_reason = ?, data_complete = ?, data_incomplete_reason = ?, last_deal_time_msc = ?,
    last_deal_ticket = ?, last_risk_snapshot_at = ?, manual_reset_business_date = ?,
    manual_reset_floating_baseline = ?, risk_calculation_version = ?, halt_started_at = ?,
    halt_reason_changed_at = ?, last_recovered_at = ?, updated_at = ? WHERE trading_account_id = ?`,
  [metrics.business_date, metrics.day_start_equity, metrics.realized, metrics.day_floating_pnl ?? metrics.floating, metrics.cumulative_cash_flow,
    metrics.equity_high_water, metrics.drawdown_pct, metrics.consecutive_losses, cooldownUntil,
    haltReason ? 'halted' : 'active', haltReason, metrics.data_complete ? 1 : 0,
    (metrics.data_incomplete_reasons || []).join(',').slice(0, 255) || null,
    metrics.last_deal_time_msc || 0, metrics.last_deal_ticket || 0, now,
    metrics.manual_reset_business_date, metrics.manual_reset_floating_baseline,
    metrics.risk_calculation_version || 0, transition.halt_started_at,
    transition.halt_reason_changed_at, transition.last_recovered_at,
    now, accountId])
  await auditRiskStateTransitionTx(run, userId, accountId, transition,
    { ...metrics, last_risk_snapshot_at:now }, 'order_risk')
  if (haltReason) return blocked(haltReason, metrics)
  if (cooldownUntil) return blocked('R3.2_CONSECUTIVE_LOSS_COOLDOWN', { until: cooldownUntil })

  const reserved = await txOne(run, `SELECT COALESCE(SUM(rr.reserved_volume), 0) AS volume,
    COALESCE(SUM(rr.reserved_daily_count), 0) AS daily_count,
    COALESCE(SUM(rr.reserved_notional), 0) AS notional
    FROM risk_reservations rr
    INNER JOIN order_intents oi ON oi.id = rr.order_intent_id
    WHERE rr.trading_account_id = ? AND rr.status = 'active' AND rr.order_intent_id <> ?
      AND (rr.expires_at > NOW() OR oi.status IN ('bridge_sending','uncertain'))`, [accountId, intentId])
  const successCount = await txOne(run, `SELECT COUNT(*) AS count FROM order_intents WHERE trading_account_id = ? AND status = 'succeeded'
    AND completed_at >= CONCAT(CURDATE(), ' 00:00:00')`, [accountId])
  const currentDailyCount = toNumber(successCount?.count) + toNumber(reserved?.daily_count)
  if (currentDailyCount + 1 > policy.max_daily_open_count) {
    const rejected = rolloutBlock('R2.3_DAILY_OPEN_COUNT', { count: currentDailyCount, limit: policy.max_daily_open_count }); if (rejected) return rejected
  }
  const latest = await txOne(run, `SELECT completed_at FROM order_intents WHERE trading_account_id = ? AND status = 'succeeded'
    ORDER BY completed_at DESC LIMIT 1`, [accountId])
  if (latest?.completed_at && Date.now() - parseBeijing(latest.completed_at).getTime() < policy.min_open_interval_seconds * 1000) {
    const elapsedSeconds = Math.max(0, Math.floor((Date.now() - parseBeijing(latest.completed_at).getTime()) / 1000))
    const rejected = rolloutBlock('R2.2_MIN_OPEN_INTERVAL', {
      elapsed_seconds: elapsedSeconds,
      remaining_seconds: Math.max(0, policy.min_open_interval_seconds - elapsedSeconds),
      minimum_seconds: policy.min_open_interval_seconds,
    }); if (rejected) return rejected
  }
  const approvedVolume = toNumber(request.volume)
  if (approvedVolume < toNumber(snapshot.instrument?.volume_min)) return blocked('R1.9_BELOW_MINIMUM_AFTER_RISK', {
    volume: approvedVolume,
    minimum: toNumber(snapshot.instrument?.volume_min),
  })
  return { approved_volume: approvedVolume, adjusted:false, reserved_notional:0, metrics, shadow_rules: shadowRules }
}

export async function recordSuccessfulOpenTx(run, accountId) {
  await run('UPDATE risk_account_state SET last_success_open_at = ?, updated_at = ? WHERE trading_account_id = ?', [beijingNow(), beijingNow(), accountId])
}

export async function setUserKillSwitch(userId, accountId, enabled, reason) {
  if (!String(reason || '').trim()) throw new Error('kill_switch_reason_required')
  const result = await queryRun(`UPDATE risk_account_state ras JOIN trading_accounts ta ON ta.id = ras.trading_account_id
    SET ras.user_kill_switch = ?, ras.updated_at = ? WHERE ras.trading_account_id = ? AND ta.user_id = ? AND ta.is_deleted = 0`,
  [enabled ? 1 : 0, beijingNow(), accountId, userId])
  if (!result.changes) throw new Error('account_not_found')
  await logAudit({ userId, action: enabled ? 'user_kill_switch_enabled' : 'user_kill_switch_disabled', targetType: 'trading_account', targetId: accountId, detail: JSON.stringify({ reason }) })
}

export async function setGlobalKillSwitch(adminId, adminRole, enabled, reason) {
  if (adminRole !== 'admin') throw new Error('admin_required')
  if (!String(reason || '').trim()) throw new Error('kill_switch_reason_required')
  await queryRun('UPDATE global_risk_control SET global_kill_switch = ?, reason = ?, changed_by = ?, updated_at = ? WHERE id = 1', [enabled ? 1 : 0, reason, adminId, beijingNow()])
  await logAudit({ userId: adminId, action: enabled ? 'global_kill_switch_enabled' : 'global_kill_switch_disabled', targetType: 'global_risk_control', targetId: 1, detail: JSON.stringify({ reason }) })
}
