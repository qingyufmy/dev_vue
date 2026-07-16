// Stateful L2/L3/L6 risk governance. Database locks are the safety boundary.

import { queryRun, withTransaction, beijingNow, logAudit, parseBeijing } from '../../db.js'
import { stripBrokerSuffix } from './utils.js'
import { riskRuleIsEnforced } from './rollout-governance.js'

const toNumber = value => Number.isFinite(Number(value)) ? Number(value) : 0
const parseJson = (value, fallback = {}) => {
  if (value == null) return fallback
  if (typeof value === 'object') return value
  try { return JSON.parse(value) } catch { return fallback }
}
const txOne = async (run, sql, params = []) => ((await run(sql, params))[0] || [])[0] || null
const txAll = async (run, sql, params = []) => (await run(sql, params))[0] || []
const nowDate = () => beijingNow().slice(0, 10)

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

function calculateIncrementalMetrics({ account, positions = [], pending = [], instruments = {}, fxRates = {}, previousState = {}, businessDate = nowDate(), snapshot_complete = true, data_incomplete_reasons = [], increment = {} }) {
  const stateCursor = [Math.max(0, Number(previousState.last_deal_time_msc) || 0), Math.max(0, Number(previousState.last_deal_ticket) || 0)]
  const requestedCursor = cursorOf(increment.requested_cursor)
  const throughCursor = cursorOf(increment.through_cursor)
  const reasons = [...new Set((data_incomplete_reasons || []).map(String).filter(Boolean))]
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
  const equity = toNumber(account?.equity)
  const dayStartEquity = newDay || !(toNumber(previousState.day_start_equity) > 0)
    ? equity - realized - floating - currentCapitalDelta : toNumber(previousState.day_start_equity)
  const dailyPnl = realized + Math.min(0, floating)
  const dailyLossPct = dayStartEquity > 0 ? Math.max(0, -dailyPnl / dayStartEquity * 100) : null
  const cumulativeCashFlow = toNumber(previousState.cumulative_cash_flow) + capitalDelta
  const oldHigh = toNumber(previousState.equity_high_water) || equity
  const correctedHigh = oldHigh + capitalDelta
  const highWater = Math.max(equity, correctedHigh)
  const drawdownPct = highWater > 0 ? Math.max(0, (highWater - equity) / highWater * 100) : null
  let consecutiveLosses = toNumber(previousState.consecutive_losses)
  for (const position of closed) consecutiveLosses = toNumber(position.net) < 0 ? consecutiveLosses + 1 : 0
  const notional = exposureNotional([...positions, ...pending], instruments, account?.currency, fxRates)
  const dataComplete = snapshot_complete && reasons.length === 0 && equity > 0 && notional != null && dailyLossPct != null && drawdownPct != null
  const nextCursor = compareCursor(throughCursor, stateCursor) >= 0 ? throughCursor : stateCursor
  return {
    business_date: businessDate, equity, realized, floating, day_start_equity: dayStartEquity,
    daily_loss_pct: dailyLossPct, cumulative_cash_flow: cumulativeCashFlow, equity_high_water: highWater,
    drawdown_pct: drawdownPct, consecutive_losses: consecutiveLosses, notional, data_complete: dataComplete,
    data_incomplete_reasons: reasons, last_deal_time_msc: nextCursor[0], last_deal_ticket: nextCursor[1],
  }
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
  const { account, positions = [], pending = [], historyToday, historyAll, instruments = {}, fxRates = {}, previousState = {}, businessDate = nowDate(), snapshot_complete = true } = input
  const todayOrders = historyToday?.orders || []
  const realized = todayOrders.reduce((sum, item) => sum + toNumber(item.profit) + toNumber(item.commission) + toNumber(item.swap) + toNumber(item.fee), 0)
  const floating = positions.reduce((sum, item) => sum + toNumber(item.profit) + toNumber(item.swap), 0)
  const equity = toNumber(account?.equity)
  const todayCash = cashFlow(historyToday?.statistics)
  const allCash = cashFlow(historyAll?.statistics)
  const newDay = previousState.business_date !== businessDate
  const dayStartEquity = newDay || !(toNumber(previousState.day_start_equity) > 0)
    ? equity - realized - floating - todayCash : toNumber(previousState.day_start_equity)
  const dailyPnl = realized + Math.min(0, floating)
  const dailyLossPct = dayStartEquity > 0 ? Math.max(0, -dailyPnl / dayStartEquity * 100) : null

  const oldCash = previousState.cumulative_cash_flow == null ? allCash : toNumber(previousState.cumulative_cash_flow)
  const oldHigh = toNumber(previousState.equity_high_water) || equity
  const cashDelta = allCash - oldCash
  const correctedHigh = oldHigh + cashDelta
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
  const dataComplete = snapshot_complete && equity > 0 && historyComplete(historyToday) && historyComplete(historyAll) && notional != null && dailyLossPct != null && drawdownPct != null
  return {
    business_date: businessDate, equity, realized, floating, day_start_equity: dayStartEquity,
    daily_loss_pct: dailyLossPct, cumulative_cash_flow: allCash, equity_high_water: highWater,
    drawdown_pct: drawdownPct, consecutive_losses: consecutiveLosses, notional, data_complete: dataComplete,
    data_incomplete_reasons: dataComplete ? [] : ['legacy_history_incomplete'],
    last_deal_time_msc: toNumber(previousState.last_deal_time_msc), last_deal_ticket: toNumber(previousState.last_deal_ticket),
  }
}

export async function refreshRiskAccountState(userId, accountId, snapshot, policy) {
  return withTransaction(async run => {
    const state = await txOne(run, 'SELECT * FROM risk_account_state WHERE trading_account_id = ? AND user_id = ? FOR UPDATE', [accountId, userId])
    if (!state) throw new Error('risk_account_state_not_found')
    const metrics = calculateAccountRiskMetrics({ ...snapshot, previousState: state })
    let haltReason = null
    if (!metrics.data_complete) haltReason = 'R3_RISK_DATA_INCOMPLETE'
    else if (metrics.daily_loss_pct >= policy.daily_loss_limit_pct) haltReason = 'R3.1_DAILY_LOSS_LIMIT'
    else if (metrics.drawdown_pct >= policy.max_drawdown_pct) haltReason = 'R3.3_MAX_DRAWDOWN'

    const previousLosses = toNumber(state.consecutive_losses)
    let cooldownUntil = state.cooldown_until && parseBeijing(state.cooldown_until)?.getTime() > Date.now() ? state.cooldown_until : null
    if (!cooldownUntil && metrics.consecutive_losses >= policy.consecutive_loss_limit && previousLosses < policy.consecutive_loss_limit) {
      cooldownUntil = new Date(Date.now() + policy.loss_cooldown_minutes * 60_000).toISOString().replace('T', ' ').slice(0, 19)
    }
    if (!haltReason && cooldownUntil) haltReason = 'R3.2_CONSECUTIVE_LOSS_COOLDOWN'
    const now = beijingNow()
    await run(`UPDATE risk_account_state SET business_date = ?, day_start_equity = ?, day_realized_net = ?, day_floating_pnl = ?,
      cumulative_cash_flow = ?, equity_high_water = ?, drawdown_pct = ?, consecutive_losses = ?, cooldown_until = ?,
      halt_status = ?, halt_reason = ?, data_complete = ?, data_incomplete_reason = ?, last_deal_time_msc = ?,
      last_deal_ticket = ?, last_risk_snapshot_at = ?, updated_at = ? WHERE trading_account_id = ? AND user_id = ?`,
    [metrics.business_date, metrics.day_start_equity, metrics.realized, metrics.floating, metrics.cumulative_cash_flow,
      metrics.equity_high_water, metrics.drawdown_pct, metrics.consecutive_losses, cooldownUntil,
      haltReason ? 'halted' : 'active', haltReason, metrics.data_complete ? 1 : 0,
      (metrics.data_incomplete_reasons || []).join(',').slice(0, 255) || null,
      metrics.last_deal_time_msc || 0, metrics.last_deal_ticket || 0, now, now, accountId, userId])
    return { ...metrics, halt_status: haltReason ? 'halted' : 'active', halt_reason: haltReason, cooldown_until: cooldownUntil }
  })
}

export async function syncTradingAccountIdentity(userId, snapshot, requestedAccountId = null) {
  const server = String(snapshot?.server || '').trim(), login = String(snapshot?.login || '').trim()
  if (!server || !login) throw new Error('trading_account_identity_incomplete')
  return withTransaction(async run => {
    const now = beijingNow()
    const rows = (await run('SELECT * FROM trading_accounts WHERE user_id = ? FOR UPDATE', [userId]))[0]
    const serverKey = server.toUpperCase()
    let matched = rows.find(row => String(row.broker_server).toUpperCase() === serverKey && String(row.login_account) === login)
    const activeDifferent = rows.filter(row => !row.is_deleted && (String(row.broker_server).toUpperCase() !== serverKey || String(row.login_account) !== login))
    const conflicts = (await run(`SELECT id, user_id FROM trading_accounts
      WHERE user_id <> ? AND UPPER(broker_server) = ? AND login_account = ? AND is_deleted = 0 FOR UPDATE`,
    [userId, serverKey, login]))[0]
    const adminRejected = matched?.review_status === 'rejected' || matched?.anomaly_code === 'admin_rejected'
    const adminPaused = !adminRejected && matched?.observe_status === 'paused'
    const anomalyCode = adminRejected ? 'admin_rejected' : conflicts.length ? 'duplicate_account_binding'
      : adminPaused ? (matched.anomaly_code || 'account_paused') : null
    const reviewStatus = adminRejected ? 'rejected' : conflicts.length ? 'pending' : 'approved'
    const observeStatus = adminRejected || conflicts.length ? 'frozen' : adminPaused ? 'paused' : 'observing'
    if (!matched) {
      const [insert] = await run(`INSERT INTO trading_accounts
        (user_id, broker_server, login_account, nickname, margin_mode, review_status, observe_status,
         observed_until, first_verified_at, identity_verified_at, anomaly_code, is_deleted, created_at, updated_at)
        VALUES (?, ?, ?, '', 'netting', ?, ?, DATE_ADD(NOW(), INTERVAL 72 HOUR), ?, ?, ?, 0, ?, ?)`,
      [userId, server, login, reviewStatus, observeStatus, now, now, anomalyCode, now, now])
      matched = { id: insert.insertId, user_id: userId, broker_server: server, login_account: login, review_status: reviewStatus, observe_status: observeStatus }
    } else if (matched.is_deleted) {
      await run(`UPDATE trading_accounts SET is_deleted = 0, review_status = ?, observe_status = ?,
        observed_until = DATE_ADD(NOW(), INTERVAL 72 HOUR), first_verified_at = COALESCE(first_verified_at, ?),
        identity_verified_at = ?, anomaly_code = ?, updated_at = ? WHERE id = ?`,
      [reviewStatus, observeStatus, now, now, anomalyCode, now, matched.id])
      matched = { ...matched, is_deleted: 0, review_status: reviewStatus, observe_status: observeStatus }
    } else {
      await run(`UPDATE trading_accounts SET review_status = ?,
        observe_status = CASE WHEN ? = 'frozen' THEN 'frozen' WHEN ? = 'paused' THEN 'paused'
          WHEN observed_until > NOW() THEN 'observing' ELSE 'active' END,
        first_verified_at = COALESCE(first_verified_at, ?), identity_verified_at = ?, anomaly_code = ?, updated_at = ? WHERE id = ?`,
      [reviewStatus, observeStatus, observeStatus, now, now, anomalyCode, now, matched.id])
      matched = { ...matched, review_status: reviewStatus, observe_status: observeStatus }
    }
    if (activeDifferent.length) {
      const ids = activeDifferent.map(row => Number(row.id))
      await run(`UPDATE trading_accounts SET observe_status = 'switched', updated_at = ? WHERE id IN (${ids.map(() => '?').join(',')})`, [now, ...ids])
      await run(`UPDATE strategy_subscriptions SET execution_enabled = 0, updated_at = ? WHERE trading_account_id IN (${ids.map(() => '?').join(',')})`, [now, ...ids])
      await run(`UPDATE trading_accounts SET review_status = ?, observe_status = ?,
        observed_until = DATE_ADD(NOW(), INTERVAL 72 HOUR), anomaly_code = ?, updated_at = ? WHERE id = ?`,
      [reviewStatus, observeStatus, anomalyCode, now, matched.id])
      matched = { ...matched, review_status: reviewStatus, observe_status: observeStatus }
    }
    await run(`INSERT INTO risk_account_state (trading_account_id, user_id, halt_status, data_complete, created_at, updated_at)
      VALUES (?, ?, 'active', 0, ?, ?) ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), updated_at = VALUES(updated_at)`,
    [matched.id, userId, now, now])
    return {
      accountId: Number(matched.id),
      switched: activeDifferent.length > 0 || Boolean(requestedAccountId && Number(requestedAccountId) !== Number(matched.id)),
      verified: !anomalyCode,
      anomalyCode,
    }
  })
}

function sameDirection(item, request) {
  const side = String(item.side || item.type || item.order_type || '').toLowerCase()
  return stripBrokerSuffix(item.symbol) === stripBrokerSuffix(request.symbol) && side.includes(request.order_type)
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
  if (accountRow.review_status !== 'approved') return blocked('R6_ACCOUNT_REVIEW_REQUIRED')
  if (['paused', 'switched', 'frozen'].includes(accountRow.observe_status)) return blocked('R6_ACCOUNT_PAUSED')
  if (state.user_kill_switch) return blocked('R6_USER_KILL_SWITCH')
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
  let cooldownUntil = metrics.consecutive_losses >= policy.consecutive_loss_limit && previousLosses < policy.consecutive_loss_limit
    ? new Date(Date.now() + policy.loss_cooldown_minutes * 60_000).toISOString().replace('T', ' ').slice(0, 19) : null
  if (cooldownUntil && !riskRuleIsEnforced('R3.2_CONSECUTIVE_LOSS_COOLDOWN', ruleModes)) {
    shadowRules.push({ code: 'R3.2_CONSECUTIVE_LOSS_COOLDOWN', outcome: 'shadow_reject', details: { until: cooldownUntil } })
    cooldownUntil = null
  }
  await run(`UPDATE risk_account_state SET business_date = ?, day_start_equity = ?, day_realized_net = ?, day_floating_pnl = ?,
    cumulative_cash_flow = ?, equity_high_water = ?, drawdown_pct = ?, consecutive_losses = ?, cooldown_until = ?,
    halt_status = ?, halt_reason = ?, data_complete = ?, data_incomplete_reason = ?, last_deal_time_msc = ?,
    last_deal_ticket = ?, last_risk_snapshot_at = ?, updated_at = ? WHERE trading_account_id = ?`,
  [metrics.business_date, metrics.day_start_equity, metrics.realized, metrics.floating, metrics.cumulative_cash_flow,
    metrics.equity_high_water, metrics.drawdown_pct, metrics.consecutive_losses, cooldownUntil,
    haltReason ? 'halted' : 'active', haltReason, metrics.data_complete ? 1 : 0,
    (metrics.data_incomplete_reasons || []).join(',').slice(0, 255) || null,
    metrics.last_deal_time_msc || 0, metrics.last_deal_ticket || 0, beijingNow(), beijingNow(), accountId])
  if (haltReason) return blocked(haltReason, metrics)
  if (cooldownUntil) return blocked('R3.2_CONSECUTIVE_LOSS_COOLDOWN', { until: cooldownUntil })

  const positions = snapshot.positions || [], pending = snapshot.pending || []
  const externalDirectional = [...positions, ...pending].filter(item => sameDirection(item, request)).reduce((sum, item) => sum + toNumber(item.volume ?? item.volume_current), 0)
  const reserved = await txOne(run, `SELECT COALESCE(SUM(reserved_volume), 0) AS volume, COALESCE(SUM(reserved_daily_count), 0) AS daily_count,
    COALESCE(SUM(reserved_notional), 0) AS notional FROM risk_reservations
    WHERE trading_account_id = ? AND status = 'active' AND order_intent_id <> ?`, [accountId, intentId])
  if (externalDirectional + toNumber(reserved?.volume) + toNumber(request.volume) > policy.max_directional_exposure_lots + 1e-9) {
    const rejected = rolloutBlock('R2.1_DIRECTIONAL_EXPOSURE'); if (rejected) return rejected
  }
  const successCount = await txOne(run, `SELECT COUNT(*) AS count FROM order_intents WHERE trading_account_id = ? AND status = 'succeeded'
    AND completed_at >= CONCAT(CURDATE(), ' 00:00:00')`, [accountId])
  if (toNumber(successCount?.count) + toNumber(reserved?.daily_count) + 1 > policy.max_daily_open_count) {
    const rejected = rolloutBlock('R2.3_DAILY_OPEN_COUNT'); if (rejected) return rejected
  }
  const latest = await txOne(run, `SELECT completed_at FROM order_intents WHERE trading_account_id = ? AND status = 'succeeded'
    ORDER BY completed_at DESC LIMIT 1`, [accountId])
  if (latest?.completed_at && Date.now() - parseBeijing(latest.completed_at).getTime() < policy.min_open_interval_seconds * 1000) {
    const rejected = rolloutBlock('R2.2_MIN_OPEN_INTERVAL'); if (rejected) return rejected
  }
  const duplicates = await txAll(run, `SELECT id, approved_order_json FROM order_intents WHERE trading_account_id = ? AND id <> ?
    AND symbol = ? AND status IN ('preparing','prepared','bridge_sending','uncertain','succeeded')
    AND created_at >= DATE_SUB(NOW(), INTERVAL ? SECOND) ORDER BY id DESC LIMIT 20`,
  [accountId, intentId, request.symbol, policy.dedup_window_seconds])
  for (const duplicate of duplicates) {
    const prior = parseJson(duplicate.approved_order_json)
    const currentPrice = toNumber(request.limit_price || request.reference_price || request.quote_price)
    const priorPrice = toNumber(prior.limit_price || prior.reference_price || prior.quote_price)
    if (prior.order_type === request.order_type && Math.abs(currentPrice - priorPrice) <= toNumber(request.atr_anchor) * policy.dedup_price_atr) {
      const rejected = rolloutBlock('R2.4_PRICE_TIME_DUPLICATE'); if (rejected) return rejected
    }
  }
  const marginLevel = toNumber(snapshot.account?.margin_level)
  if (toNumber(snapshot.account?.margin) > 0 && marginLevel < policy.min_margin_level_pct) {
    const rejected = rolloutBlock('R3.4_MARGIN_LEVEL'); if (rejected) return rejected
  }
  const orderNotional = exposureNotional([{
    symbol: request.symbol, volume: request.volume,
    price: request.limit_price || request.quote_price || request.reference_price,
  }], snapshot.instruments || {}, snapshot.account?.currency, snapshot.fxRates || {})
  if (orderNotional == null) return blocked('R3.4_NOTIONAL_DATA_INCOMPLETE')
  const projectedNotional = metrics.notional + toNumber(reserved?.notional) + orderNotional
  if (projectedNotional > metrics.equity * policy.max_notional_exposure_pct / 100) {
    const rejected = rolloutBlock('R3.4_NOTIONAL_EXPOSURE'); if (rejected) return rejected
  }

  const observedUntil = parseBeijing(accountRow.observed_until)?.getTime() || 0
  let approvedVolume = toNumber(request.volume), adjusted = false
  if (Date.now() < observedUntil && approvedVolume > policy.observation_max_lot) {
    approvedVolume = policy.observation_max_lot; adjusted = true
  }
  if (approvedVolume < Math.max(policy.ai_volume_min, toNumber(snapshot.instrument?.volume_min))) return blocked('R6.4_OBSERVATION_BELOW_MINIMUM')
  return { approved_volume: approvedVolume, adjusted, reserved_notional: orderNotional, metrics, shadow_rules: shadowRules }
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
