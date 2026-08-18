import { queryAll } from '../../db.js'
import { mt5Bridge } from './market-data.js'
import { stripBrokerSuffix } from './utils.js'

const SYSTEM_TRADE_MAGIC = 234000
const DIRECTION_INTERLOCK_SAFE_TASK_STATES = new Set([
  'HELD', 'EXPIRED', 'REJECTED', 'COMPLETED', 'EXIT_ONLY_COMPLETED',
])

function sameSymbol(value, expected) {
  return stripBrokerSuffix(String(value || '')).toUpperCase() === stripBrokerSuffix(String(expected || '')).toUpperCase()
}

function ticketKey(value) {
  return value == null ? '' : String(value).trim()
}

function parseUtcMsc(value) {
  if (value instanceof Date) {
    const time = value.getTime()
    return Number.isFinite(time) ? time : null
  }
  if (typeof value === 'number' || (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim()))) {
    const numeric = Number(value)
    if (!Number.isFinite(numeric) || numeric <= 0) return null
    return numeric < 10_000_000_000 ? Math.trunc(numeric * 1000) : Math.trunc(numeric)
  }
  const text = String(value || '').trim()
  if (!text) return null
  // MySQL DATETIME columns in this application are stored as UTC despite
  // having no timezone suffix. Never let the host timezone reinterpret them.
  const normalized = /[zZ]|[+-]\d\d:?\d\d$/.test(text)
    ? text
    : `${text.replace(' ', 'T')}Z`
  const time = Date.parse(normalized)
  return Number.isFinite(time) ? time : null
}

function formatTerminalTime(utcMsc, offsetMinutes) {
  if (!Number.isFinite(utcMsc) || !Number.isFinite(offsetMinutes)) return null
  return new Date(utcMsc + offsetMinutes * 60_000).toISOString().slice(0, 19).replace('T', ' ')
}

function pendingTimeFacts(ownership, capturedAtUtcMsc) {
  const validUntilUtcMsc = parseUtcMsc(ownership?.pending_valid_until)
  const offsetValue = ownership?.terminal_timezone_offset_minutes
  const offset = offsetValue == null || offsetValue === '' ? null : Number(offsetValue)
  const validOffset = Number.isInteger(offset) && offset >= -14 * 60 && offset <= 14 * 60 ? offset : null
  const isExpired = validUntilUtcMsc == null ? null : capturedAtUtcMsc >= validUntilUtcMsc
  return {
    // Do not expose the Bridge's unlabeled terminal wall-clock string. It was
    // the source of mixed-timezone comparisons such as signal #9305.
    valid_until_utc_msc:validUntilUtcMsc,
    valid_until_utc:validUntilUtcMsc == null ? null : new Date(validUntilUtcMsc).toISOString(),
    valid_until_terminal:formatTerminalTime(validUntilUtcMsc, validOffset),
    terminal_timezone_offset_minutes:validOffset,
    is_expired:isExpired,
    remaining_seconds:validUntilUtcMsc == null ? null : Math.ceil((validUntilUtcMsc - capturedAtUtcMsc) / 1000),
    captured_at:new Date(capturedAtUtcMsc).toISOString(),
    captured_at_utc_msc:capturedAtUtcMsc,
  }
}

export async function loadPlatformReferencePortfolio({ strategyId, sourceUserId, symbol } = {}) {
  const [positionsResponse, pendingResponse, ownershipRows] = await Promise.all([
    // The strategy symbol is canonical (for example XAUUSD) while the terminal
    // may expose any supported broker suffix (XAUUSD.s, XAUUSD.c, ...). Do not
    // let the Bridge exact-symbol prefilter discard those rows before the
    // suffix-aware sameSymbol() ownership filter below can inspect them.
    mt5Bridge(sourceUserId, 'positions', {}, { timeoutMs:5000, noFallback:true }),
    mt5Bridge(sourceUserId, 'pending_list', {}, { timeoutMs:5000, noFallback:true }),
    queryAll(`SELECT outcomes.id AS outcome_id, outcomes.signal_id, outcomes.pending_ticket,
        outcomes.entry_order_ticket, outcomes.position_id, outcomes.original_symbol,
        outcomes.actual_stop_loss, outcomes.actual_take_profit, outcomes.original_stop_loss,
        outcomes.original_take_profits_json, outcomes.thesis_id, outcomes.management_group_id,
        signals.signal_type, signals.entry_method, signals.created_at,
        signals.pending_valid_until, signals.terminal_timezone_offset_minutes
      FROM signal_outcomes outcomes
      JOIN ai_signals signals ON signals.id = outcomes.signal_id
      WHERE outcomes.user_id = ? AND signals.prompt_type_id = ?
        AND outcomes.status IN ('open','closing')
      ORDER BY outcomes.id`, [Number(sourceUserId), Number(strategyId)]),
  ])
  if (positionsResponse?.status !== 'success' || !Array.isArray(positionsResponse.positions)) {
    throw new Error('reference_positions_unavailable')
  }
  const pendingOrders = pendingResponse?.orders ?? pendingResponse?.pending_list
  if (pendingResponse?.status !== 'success' || !Array.isArray(pendingOrders)) {
    throw new Error('reference_pending_unavailable')
  }

  const byPositionRef = new Map()
  const byPendingTicket = new Map()
  for (const row of ownershipRows) {
    if (ticketKey(row.position_id)) byPositionRef.set(ticketKey(row.position_id), row)
    if (ticketKey(row.entry_order_ticket)) byPositionRef.set(ticketKey(row.entry_order_ticket), row)
    if (ticketKey(row.pending_ticket)) byPendingTicket.set(ticketKey(row.pending_ticket), row)
  }
  const capturedAtUtcMsc = Date.now()
  const positions = positionsResponse.positions
    .filter(item => Number(item.magic || 0) === SYSTEM_TRADE_MAGIC && sameSymbol(item.symbol, symbol))
    .map(item => ({ item, ownership:[item.position_id, item.identifier, item.ticket]
      .map(ticketKey).map(key => byPositionRef.get(key)).find(Boolean) }))
    .filter(item => item.ownership)
    .map(({ item, ownership }) => ({
      reference_id:`outcome:${Number(ownership.outcome_id)}`,
      origin_signal_id:Number(ownership.signal_id),
      thesis_id:ownership.thesis_id || null,
      management_group_id:ownership.management_group_id || null,
      order_type:'position',
      direction:String(item.type || '').toLowerCase().startsWith('buy') ? 'buy' : 'sell',
      side:String(item.type || '').toLowerCase(),
      entry_price:Number(item.open_price ?? item.price_open ?? 0),
      current_price:Number(item.price_current || 0),
      actual_stop_loss:Number(item.sl || 0) || null,
      actual_take_profit:Number(item.tp || 0) || null,
      original_stop_loss:Number(ownership.original_stop_loss || 0) || null,
      original_take_profits:jsonArray(ownership.original_take_profits_json),
      opened_at:item.time || item.time_open || ownership.created_at || null,
      created_at:item.time || item.time_open || ownership.created_at || null,
    }))
  const pending = pendingOrders
    .filter(item => Number(item.magic || 0) === SYSTEM_TRADE_MAGIC && sameSymbol(item.symbol, symbol))
    .map(item => ({ item, ownership:byPendingTicket.get(ticketKey(item.ticket ?? item.mt5_ticket)) }))
    .filter(item => item.ownership)
    .map(({ item, ownership }) => ({
      reference_id:`outcome:${Number(ownership.outcome_id)}`,
      origin_signal_id:Number(ownership.signal_id),
      thesis_id:ownership.thesis_id || null,
      management_group_id:ownership.management_group_id || null,
      direction:String(item.side || ownership.signal_type || '').toLowerCase().startsWith('buy') ? 'buy' : 'sell',
      side:String(item.side || ownership.signal_type || '').toLowerCase().startsWith('buy') ? 'buy' : 'sell',
      order_type:String(item.pending_type || ownership.signal_type || '').toLowerCase(),
      pending_type:String(item.pending_type || ownership.signal_type || '').toLowerCase(),
      trigger_price:Number(item.price || 0),
      actual_stop_loss:Number(item.sl || 0) || null,
      actual_take_profit:Number(item.tp || 0) || null,
      original_stop_loss:Number(ownership.original_stop_loss || 0) || null,
      original_take_profits:jsonArray(ownership.original_take_profits_json),
      created_at:item.time_setup || item.time_create || item.created_at || ownership.created_at || null,
      ...pendingTimeFacts(ownership, capturedAtUtcMsc),
    }))
  return {
    role:'platform_strategy_reference_portfolio',
    strategy_id:Number(strategyId),
    symbol:stripBrokerSuffix(String(symbol || '')).toUpperCase(),
    positions,
    pending_orders:pending,
    position_count:positions.length,
    pending_count:pending.length,
    captured_at:new Date(capturedAtUtcMsc).toISOString(),
    captured_at_utc_msc:capturedAtUtcMsc,
  }
}

/**
 * Return only durable platform-source task facts that can make a direction
 * change unsafe. Subscriber inventory is deliberately not queried here.
 */
export async function loadPlatformDirectionInterlockTasks({ strategyId, sourceUserId, symbol } = {}) {
  const rows = await queryAll(`SELECT tasks.id, tasks.task_type, tasks.status,
      tasks.candidate_action, tasks.outcome_id, tasks.decision_signal_id,
      tasks.origin_signal_id, tasks.original_symbol, tasks.standard_symbol,
      outcomes.entry_direction
    FROM ai_position_management_tasks tasks
    JOIN signal_outcomes outcomes ON outcomes.id = tasks.outcome_id
    WHERE tasks.strategy_id = ? AND tasks.user_id = ?
      AND outcomes.status IN ('open','closing')
    ORDER BY tasks.id`, [Number(strategyId), Number(sourceUserId)])
  return rows.filter(row => sameSymbol(row.standard_symbol || row.original_symbol, symbol)
      && !DIRECTION_INTERLOCK_SAFE_TASK_STATES.has(String(row.status || '').trim().toUpperCase()))
    .map(row => ({
      task_id:Number(row.id),
      task_type:String(row.task_type || ''),
      status:String(row.status || '').trim().toUpperCase(),
      candidate_action:String(row.candidate_action || ''),
      outcome_id:Number(row.outcome_id),
      decision_signal_id:Number(row.decision_signal_id) || null,
      origin_signal_id:Number(row.origin_signal_id) || null,
      direction:String(row.entry_direction || '').toLowerCase().startsWith('buy') ? 'buy'
        : String(row.entry_direction || '').toLowerCase().startsWith('sell') ? 'sell' : null,
    }))
}

function jsonArray(value) {
  try {
    const parsed = JSON.parse(value || '[]')
    return Array.isArray(parsed) ? parsed : []
  } catch { return [] }
}
