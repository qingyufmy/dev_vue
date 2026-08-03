import { createHash } from 'node:crypto'
import { beijingNow, parseBeijing, queryOne, withTransaction } from '../../db.js'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const DAY_MS = 86_400_000
const number = value => Number.isFinite(Number(value)) ? Number(value) : 0
const txOne = async (run, sql, params = []) => ((await run(sql, params))[0] || [])[0] || null
const isoDate = value => new Date(value).toISOString().slice(0, 10)
const addDays = (value, days) => isoDate(Date.parse(`${value}T00:00:00Z`) + days * DAY_MS)
const minDate = (left, right) => left <= right ? left : right
const todayDate = () => new Date().toISOString().slice(0, 10)
const UNTRUSTED_CLOCK_STATUSES = new Set(['unknown', 'unavailable', 'unverified', 'calibrating', 'fallback'])

function terminalClock(account) {
  if (account?.timezone_offset_minutes == null || account.timezone_offset_minutes === '') {
    throw new Error('terminal_clock_unverified')
  }
  const offsetMinutes = Number(account?.timezone_offset_minutes)
  const status = String(account?.clock_status || '').trim().toLowerCase()
  if (!Number.isInteger(offsetMinutes) || offsetMinutes < -720 || offsetMinutes > 840
    || !status || UNTRUSTED_CLOCK_STATUSES.has(status)) throw new Error('terminal_clock_unverified')
  return { offsetMinutes, status }
}

function terminalDate(utcMs, offsetMinutes) {
  return new Date(Number(utcMs) + Number(offsetMinutes) * 60000).toISOString().slice(0, 10)
}

export function normalizePerformanceDay(input = {}) {
  const businessDate = String(input.business_date || '')
  if (!DATE_RE.test(businessDate)) throw new Error('invalid_performance_business_date')
  const result = {
    business_date: businessDate,
    trade_profit:number(input.trade_profit), commission:number(input.commission),
    swap:number(input.swap), fee:number(input.fee), pnl_adjustment:number(input.pnl_adjustment),
    realized_net:number(input.realized_net), deposit:Math.max(0, number(input.deposit)),
    withdrawal:Math.max(0, number(input.withdrawal)), credit_change:number(input.credit_change),
    other_capital_change:number(input.other_capital_change),
    exit_deal_count:Math.max(0, Math.trunc(number(input.exit_deal_count))),
    closed_position_count:Math.max(0, Math.trunc(number(input.closed_position_count))),
    winning_exit_count:Math.max(0, Math.trunc(number(input.winning_exit_count))),
    losing_exit_count:Math.max(0, Math.trunc(number(input.losing_exit_count))),
    closed_volume:Math.max(0, number(input.closed_volume)),
    first_deal_time_msc:Math.max(0, Math.trunc(number(input.first_deal_time_msc))),
    last_deal_time_msc:Math.max(0, Math.trunc(number(input.last_deal_time_msc))),
    last_deal_ticket:Math.max(0, Math.trunc(number(input.last_deal_ticket))),
    data_complete:input.data_complete !== false,
    data_issue:[...new Set((input.data_issues || []).map(String).filter(Boolean))].join(',').slice(0, 255) || null,
  }
  const expectedNet = result.trade_profit + result.commission + result.swap + result.fee + result.pnl_adjustment
  if (Math.abs(expectedNet - result.realized_net) > 0.000001) throw new Error('performance_realized_net_mismatch')
  result.source_hash = /^[a-f0-9]{64}$/i.test(String(input.source_hash || ''))
    ? String(input.source_hash).toLowerCase()
    : createHash('sha256').update(JSON.stringify(result)).digest('hex')
  return result
}

export function nextPerformanceWindow({ firstConnectedAt, syncedThroughDate, today = todayDate(), maxDays = 31 } = {}) {
  const first = firstConnectedAt instanceof Date
    ? firstConnectedAt.toISOString().slice(0, 10)
    : String(firstConnectedAt || '').slice(0, 10)
  if (!DATE_RE.test(first) || !DATE_RE.test(today)) return null
  const start = DATE_RE.test(String(syncedThroughDate || '')) ? addDays(syncedThroughDate, 1) : first
  if (start > today) return null
  return { date_from:start, date_to:minDate(addDays(start, Math.max(1, maxDays) - 1), today) }
}

export function recentPerformanceWindow({ firstConnectedAt, today = todayDate(), overlapDays = 7 } = {}) {
  const first = String(firstConnectedAt instanceof Date ? firstConnectedAt.toISOString() : firstConnectedAt || '').slice(0, 10)
  if (!DATE_RE.test(first) || !DATE_RE.test(today)) return null
  return { date_from:first > addDays(today, -(Math.max(1, overlapDays) - 1)) ? first : addDays(today, -(Math.max(1, overlapDays) - 1)), date_to:today }
}

async function accountSyncContext(run, userId, accountId, lock = false) {
  const suffix = lock ? ' FOR UPDATE' : ''
  const account = await txOne(run, `SELECT ta.id, ta.user_id, ta.broker_server, ta.login_account,
      ta.first_verified_at, bindings.first_connected_at, bindings.last_connected_at, bindings.account_currency,
      ownership.id AS ownership_history_id, ownership.started_at AS ownership_started_at,
      state.synced_through_date, state.sync_status,
      (SELECT mds.timezone_offset_minutes FROM market_data_sources mds
        WHERE mds.bridge_user_id = ta.user_id
          AND UPPER(COALESCE(mds.broker_server, '')) = UPPER(ta.broker_server)
          AND CAST(COALESCE(mds.account_login, 0) AS CHAR) = CAST(ta.login_account AS CHAR)
        ORDER BY mds.last_calibrated_at DESC, mds.id DESC LIMIT 1) AS timezone_offset_minutes,
      (SELECT mds.clock_status FROM market_data_sources mds
        WHERE mds.bridge_user_id = ta.user_id
          AND UPPER(COALESCE(mds.broker_server, '')) = UPPER(ta.broker_server)
          AND CAST(COALESCE(mds.account_login, 0) AS CHAR) = CAST(ta.login_account AS CHAR)
        ORDER BY mds.last_calibrated_at DESC, mds.id DESC LIMIT 1) AS clock_status
    FROM trading_accounts ta
    JOIN mt5_account_bindings bindings ON bindings.current_trading_account_id = ta.id
      AND bindings.current_user_id = ta.user_id
    JOIN mt5_account_ownership_history ownership ON ownership.trading_account_id = ta.id
      AND ownership.user_id = ta.user_id AND ownership.ended_at IS NULL
    LEFT JOIN mt5_account_performance_sync_state state ON state.ownership_history_id = ownership.id
    WHERE ta.id = ? AND ta.user_id = ? AND ta.is_deleted = 0${suffix}`, [accountId, userId])
  if (!account) throw new Error('performance_account_not_current_owner')
  return account
}

export async function getAccountPerformanceSyncWindow(userId, accountId, { recent = false } = {}) {
  return withTransaction(async run => {
    const account = await accountSyncContext(run, userId, accountId, true)
    const clock = terminalClock(account)
    const firstConnectedAt = account.ownership_started_at || account.first_verified_at
    const firstConnectedUtcMs = firstConnectedAt instanceof Date
      ? firstConnectedAt.getTime() : parseBeijing(firstConnectedAt)?.getTime()
    const firstConnectedDate = Number.isFinite(firstConnectedUtcMs)
      ? terminalDate(firstConnectedUtcMs, clock.offsetMinutes) : String(firstConnectedAt || '').slice(0, 10)
    const today = terminalDate(Date.now(), clock.offsetMinutes)
    const window = recent
      ? recentPerformanceWindow({ firstConnectedAt:firstConnectedDate, today })
      : nextPerformanceWindow({ firstConnectedAt:firstConnectedDate,
        syncedThroughDate:account.synced_through_date, today })
    if (!window) return null
    const now = beijingNow()
    await run(`INSERT INTO mt5_account_performance_sync_state
      (ownership_history_id, trading_account_id, sync_from_date, synced_through_date, sync_status, last_attempt_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'syncing', ?, ?, ?)
      ON DUPLICATE KEY UPDATE sync_status = 'syncing', last_error = NULL,
        last_attempt_at = VALUES(last_attempt_at), updated_at = VALUES(updated_at)`,
    [account.ownership_history_id, accountId, String(firstConnectedAt).slice(0, 10), account.synced_through_date || null, now, now, now])
    return { ...window, account:{ id:Number(account.id), server:account.broker_server,
      login:String(account.login_account), currency:account.account_currency || null },
      first_connected_at:firstConnectedAt, timezone_offset_minutes:clock.offsetMinutes,
      clock_status:clock.status }
  })
}

function validatePayloadIdentity(context, payload) {
  const server = String(payload?.account?.server || '').trim().toUpperCase()
  const login = String(payload?.account?.login ?? '').trim()
  if (!server || !login || server !== String(context.broker_server).trim().toUpperCase()
    || login !== String(context.login_account).trim()) throw new Error('performance_account_identity_mismatch')
}

export async function saveAccountPerformanceChunk(userId, accountId, payload = {}, { advanceCursor = true } = {}) {
  if (payload.status !== 'success' || Number(payload.performance_version || 0) < 1) throw new Error('invalid_performance_payload')
  const dateFrom = String(payload.date_from || ''), dateTo = String(payload.date_to || '')
  if (!DATE_RE.test(dateFrom) || !DATE_RE.test(dateTo) || dateFrom > dateTo) throw new Error('invalid_performance_range')
  const rows = (payload.daily || []).map(normalizePerformanceDay)
  if (rows.some(row => row.business_date < dateFrom || row.business_date > dateTo)) throw new Error('performance_day_outside_range')
  return withTransaction(async run => {
    const context = await accountSyncContext(run, userId, accountId, true)
    validatePayloadIdentity(context, payload)
    const now = beijingNow()
    const currency = String(payload.account?.currency || context.account_currency || '').trim().toUpperCase().slice(0, 16) || null
    for (const row of rows) {
      await run(`INSERT INTO mt5_account_performance_daily
        (ownership_history_id, trading_account_id, business_date, account_currency, trade_profit, commission, swap, fee,
         pnl_adjustment, realized_net, deposit, withdrawal, credit_change, other_capital_change,
         exit_deal_count, closed_position_count, winning_exit_count, losing_exit_count, closed_volume,
         first_deal_time_msc, last_deal_time_msc, last_deal_ticket, source_hash, data_complete,
         data_issue, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE account_currency = VALUES(account_currency), trade_profit = VALUES(trade_profit),
          commission = VALUES(commission), swap = VALUES(swap), fee = VALUES(fee),
          pnl_adjustment = VALUES(pnl_adjustment), realized_net = VALUES(realized_net),
          deposit = VALUES(deposit), withdrawal = VALUES(withdrawal), credit_change = VALUES(credit_change),
          other_capital_change = VALUES(other_capital_change), exit_deal_count = VALUES(exit_deal_count),
          closed_position_count = VALUES(closed_position_count), winning_exit_count = VALUES(winning_exit_count),
          losing_exit_count = VALUES(losing_exit_count), closed_volume = VALUES(closed_volume),
          first_deal_time_msc = VALUES(first_deal_time_msc), last_deal_time_msc = VALUES(last_deal_time_msc),
          last_deal_ticket = VALUES(last_deal_ticket), source_hash = VALUES(source_hash),
          data_complete = VALUES(data_complete), data_issue = VALUES(data_issue), updated_at = VALUES(updated_at)`,
      [context.ownership_history_id, accountId, row.business_date, currency, row.trade_profit, row.commission, row.swap, row.fee,
        row.pnl_adjustment, row.realized_net, row.deposit, row.withdrawal, row.credit_change,
        row.other_capital_change, row.exit_deal_count, row.closed_position_count, row.winning_exit_count,
        row.losing_exit_count, row.closed_volume, row.first_deal_time_msc, row.last_deal_time_msc,
        row.last_deal_ticket, row.source_hash, row.data_complete ? 1 : 0, row.data_issue, now, now])
    }
    const totals = await txOne(run, `SELECT MIN(business_date) AS period_start_date,
        MAX(business_date) AS period_end_date, COALESCE(SUM(realized_net), 0) AS realized_net,
        COALESCE(SUM(deposit), 0) AS deposit, COALESCE(SUM(withdrawal), 0) AS withdrawal,
        COALESCE(SUM(credit_change), 0) AS credit_change,
        COALESCE(SUM(other_capital_change), 0) AS other_capital_change,
        COALESCE(SUM(exit_deal_count), 0) AS exit_deal_count,
        COALESCE(SUM(closed_position_count), 0) AS closed_position_count,
        COALESCE(SUM(winning_exit_count), 0) AS winning_exit_count,
        COALESCE(SUM(losing_exit_count), 0) AS losing_exit_count,
        COALESCE(SUM(closed_volume), 0) AS closed_volume,
        MIN(data_complete) AS data_complete
      FROM mt5_account_performance_daily WHERE ownership_history_id = ?`, [context.ownership_history_id])
    const netFunding = number(totals.deposit) - number(totals.withdrawal)
      + number(totals.credit_change) + number(totals.other_capital_change)
    const netAccountChange = number(totals.realized_net) + netFunding
    await run(`INSERT INTO mt5_account_performance_totals
      (ownership_history_id, trading_account_id, account_currency, period_start_date, period_end_date, realized_net,
       deposit, withdrawal, credit_change, other_capital_change, net_funding, net_account_change,
       exit_deal_count, closed_position_count, winning_exit_count, losing_exit_count, closed_volume,
       data_complete, last_synced_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE account_currency = VALUES(account_currency),
        period_start_date = VALUES(period_start_date), period_end_date = VALUES(period_end_date),
        realized_net = VALUES(realized_net), deposit = VALUES(deposit), withdrawal = VALUES(withdrawal),
        credit_change = VALUES(credit_change), other_capital_change = VALUES(other_capital_change),
        net_funding = VALUES(net_funding), net_account_change = VALUES(net_account_change),
        exit_deal_count = VALUES(exit_deal_count), closed_position_count = VALUES(closed_position_count),
        winning_exit_count = VALUES(winning_exit_count), losing_exit_count = VALUES(losing_exit_count),
        closed_volume = VALUES(closed_volume), data_complete = VALUES(data_complete),
        last_synced_at = VALUES(last_synced_at), updated_at = VALUES(updated_at)`,
    [context.ownership_history_id, accountId, currency, totals.period_start_date || dateFrom, totals.period_end_date || dateTo,
      number(totals.realized_net), number(totals.deposit), number(totals.withdrawal),
      number(totals.credit_change), number(totals.other_capital_change), netFunding, netAccountChange,
      number(totals.exit_deal_count), number(totals.closed_position_count), number(totals.winning_exit_count),
      number(totals.losing_exit_count), number(totals.closed_volume), Number(totals.data_complete ?? 1) ? 1 : 0, now, now])
    const complete = rows.every(row => row.data_complete)
    const syncedThroughDate = advanceCursor ? dateTo : (context.synced_through_date || null)
    await run(`INSERT INTO mt5_account_performance_sync_state
      (ownership_history_id, trading_account_id, sync_from_date, synced_through_date, timezone_offset_minutes, sync_status,
       last_error, last_attempt_at, last_success_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE synced_through_date = VALUES(synced_through_date),
        timezone_offset_minutes = VALUES(timezone_offset_minutes), sync_status = VALUES(sync_status),
        last_error = VALUES(last_error), last_attempt_at = VALUES(last_attempt_at),
        last_success_at = VALUES(last_success_at), updated_at = VALUES(updated_at)`,
    [context.ownership_history_id, accountId, String(context.ownership_started_at || context.first_verified_at).slice(0, 10), syncedThroughDate,
      payload.timezone_offset_minutes != null && payload.timezone_offset_minutes !== ''
        && Number.isFinite(Number(payload.timezone_offset_minutes))
        ? Math.trunc(Number(payload.timezone_offset_minutes)) : null,
      complete ? 'current' : 'incomplete', complete ? null : rows.map(row => row.data_issue).filter(Boolean).join(',').slice(0, 255),
      now, now, now, now])
    await run(`UPDATE mt5_account_bindings SET account_currency = COALESCE(?, account_currency),
      last_connected_at = ?, updated_at = ? WHERE current_trading_account_id = ? AND current_user_id = ?`,
    [currency, now, now, accountId, userId])
    return { account_id:Number(accountId), date_from:dateFrom, date_to:dateTo,
      row_count:rows.length, data_complete:complete, totals:{ ...totals, net_funding:netFunding, net_account_change:netAccountChange } }
  })
}

export async function recordAccountPerformanceSyncFailure(userId, accountId, error) {
  const message = String(error?.message || error || 'performance_sync_failed').slice(0, 255)
  return withTransaction(async run => {
    const context = await accountSyncContext(run, userId, accountId, true)
    const now = beijingNow()
    await run(`INSERT INTO mt5_account_performance_sync_state
      (ownership_history_id, trading_account_id, sync_from_date, sync_status, last_error, last_attempt_at, created_at, updated_at)
      VALUES (?, ?, ?, 'failed', ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE sync_status = 'failed', last_error = VALUES(last_error),
        last_attempt_at = VALUES(last_attempt_at), updated_at = VALUES(updated_at)`,
    [context.ownership_history_id, accountId, String(context.ownership_started_at || context.first_verified_at).slice(0, 10), message, now, now, now])
    return { account_id:Number(accountId), error:message }
  })
}

export async function getAccountPerformanceSummary(accountId, userId) {
  return queryOne(`SELECT COUNT(*) AS ownership_period_count,
      MIN(totals.period_start_date) AS period_start_date,
      MAX(totals.period_end_date) AS period_end_date, MAX(totals.account_currency) AS account_currency,
      COALESCE(SUM(totals.realized_net), 0) AS realized_net,
      COALESCE(SUM(totals.deposit), 0) AS deposit,
      COALESCE(SUM(totals.withdrawal), 0) AS withdrawal,
      COALESCE(SUM(totals.credit_change), 0) AS credit_change,
      COALESCE(SUM(totals.other_capital_change), 0) AS other_capital_change,
      COALESCE(SUM(totals.net_funding), 0) AS net_funding,
      COALESCE(SUM(totals.net_account_change), 0) AS net_account_change,
      COALESCE(SUM(totals.exit_deal_count), 0) AS exit_deal_count,
      COALESCE(SUM(totals.closed_position_count), 0) AS closed_position_count,
      COALESCE(SUM(totals.winning_exit_count), 0) AS winning_exit_count,
      COALESCE(SUM(totals.losing_exit_count), 0) AS losing_exit_count,
      COALESCE(SUM(totals.closed_volume), 0) AS closed_volume,
      MIN(totals.data_complete) AS data_complete, MAX(totals.last_synced_at) AS last_synced_at,
      (SELECT state.sync_status FROM mt5_account_performance_sync_state state
        JOIN mt5_account_ownership_history state_owner ON state_owner.id = state.ownership_history_id
        WHERE state.trading_account_id = ? AND state_owner.user_id = ? ORDER BY state.updated_at DESC LIMIT 1) AS sync_status,
      (SELECT state.last_error FROM mt5_account_performance_sync_state state
        JOIN mt5_account_ownership_history state_owner ON state_owner.id = state.ownership_history_id
        WHERE state.trading_account_id = ? AND state_owner.user_id = ? ORDER BY state.updated_at DESC LIMIT 1) AS last_error,
      (SELECT state.synced_through_date FROM mt5_account_performance_sync_state state
        JOIN mt5_account_ownership_history state_owner ON state_owner.id = state.ownership_history_id
        WHERE state.trading_account_id = ? AND state_owner.user_id = ? ORDER BY state.updated_at DESC LIMIT 1) AS synced_through_date
    FROM mt5_account_performance_totals totals
    JOIN mt5_account_ownership_history owner ON owner.id = totals.ownership_history_id
    WHERE totals.trading_account_id = ? AND owner.user_id = ?`,
  [accountId, userId, accountId, userId, accountId, userId, accountId, userId])
}
