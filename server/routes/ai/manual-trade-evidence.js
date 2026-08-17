import crypto from 'node:crypto'
import { queryAll, queryOne } from '../../db.js'
import { mt5Bridge } from './market-data.js'
import { getBridgeRuntimeDiagnostics, getHistoryTerminalClock } from '../../bridge-ws.js'
import { trustedTerminalClock } from './terminal-clock.js'
import { buildReviewMarketPath } from './review-market-path.js'
import { resolveFrozenChanRequirement } from './inference-snapshots.js'

export const MANUAL_TRADE_PAGE_DEFAULT = 20
export const MANUAL_TRADE_PAGE_MAX = 100
export const MANUAL_TRADE_SELECTION_MAX = 1
export const MANUAL_TRADE_LOOKBACK_MSC = 7 * 24 * 60 * 60 * 1000
const MANUAL_TRADE_PREPARE_POLL_ATTEMPTS = 8
const MANUAL_TRADE_PREPARE_POLL_INTERVAL_MS = 250
const MT4_VISIBLE_HISTORY_INCOMPLETE = 'manual_trade_review_mt4_visible_history_incomplete'
const MT4_VISIBLE_HISTORY_UNKNOWN = 'manual_trade_review_mt4_visible_history_unknown'
const MT4_HISTORY_SCOPE_NOTE = 'MT4 手动复盘只覆盖终端当前可见历史；请在 MT4“账户历史”中选择“全部历史”后刷新。系统不会宣称券商全量历史。'
// A selector request may inspect a small number of raw Bridge pages when a
// page contains only automated, incomplete, or otherwise filtered records.
// Keep this bounded: the endpoint is still an on-demand cursor read, not an
// unbounded history export.
export const MANUAL_TRADE_SOURCE_SCAN_MAX_PAGES = 5

const EXPERT_REASON_CODES = new Set(['expert', 'ea', 'robot', 'algorithm', 'automated', '3'])
const EXIT_ENTRIES = new Set(['out', 'out_by', 'inout', 'close', 'closed', '1', '2', '3'])
const ENTRY_ENTRIES = new Set(['in', 'open', 'opened', '0'])
const MANUAL_TRADE_REFERENCE_PATTERN = /^(?!0+$)\d{1,32}$/

function json(value, fallback = null) {
  if (value == null || value === '') return fallback
  if (typeof value === 'object') return value
  try { return JSON.parse(value) } catch { return fallback }
}

function numberOrNull(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function optionalProtectionPrice(...values) {
  for (const value of values) {
    const number = numberOrNull(value)
    if (number != null && number > 0) return number
  }
  return null
}

function safeInteger(value) {
  const number = Number(value)
  return Number.isSafeInteger(number) && number > 0 ? number : null
}

function text(value) { return String(value == null ? '' : value).trim() }

function manualTradeReference(value) {
  if (value == null) return null
  if (typeof value !== 'string') throw new Error('manual_trade_review_selection_reference_invalid')
  const normalized = text(value)
  if (!MANUAL_TRADE_REFERENCE_PATTERN.test(normalized)) {
    throw new Error('manual_trade_review_selection_reference_invalid')
  }
  return normalized
}

function stable(value) {
  if (value == null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(stable)
  return Object.keys(value).sort().reduce((result, key) => {
    result[key] = stable(value[key])
    return result
  }, {})
}

export function sha256(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(stable(value)), 'utf8').digest('hex')
}

// Snapshot timestamps describe when the bounded Bridge read happened; they
// must not make an otherwise identical trade source appear changed between
// the selector request and the create-time revalidation.
export function normalizedTradeHash(normalized) {
  const value = normalized && typeof normalized === 'object' ? { ...normalized } : normalized
  if (value && typeof value === 'object') delete value.snapshot_at_utc_msc
  return sha256(value)
}

function dealEntry(value) {
  const normalized = text(value).toLowerCase()
  if (ENTRY_ENTRIES.has(normalized)) return 'entry'
  if (EXIT_ENTRIES.has(normalized)) return 'exit'
  return null
}

function dealTicket(row) {
  return text(row?.deal_ticket ?? row?.deal ?? row?.ticket)
}

function orderTicket(row) {
  return text(row?.order_ticket ?? row?.order)
}

function positionId(row) {
  return text(row?.position_id ?? row?.position)
}

function isExpertReason(value) {
  const normalized = text(value).toLowerCase().replace(/\s+/g, '_')
  const tokens = normalized.split(/[^a-z0-9]+/).filter(Boolean)
  return normalized && (EXPERT_REASON_CODES.has(normalized)
    || tokens.some(token => ['expert', 'ea', 'robot', 'algorithm', 'automated'].includes(token))
    || normalized.includes('expert') || normalized.includes('robot') || normalized.includes('autom'))
}

function sourceIdentity({ terminalInstanceId, brokerServer, loginAccount, position, entryOrder }) {
  const key = position
    ? `${terminalInstanceId}|${brokerServer}|${loginAccount}|position:${position}`
    : `${terminalInstanceId}|${brokerServer}|${loginAccount}|entry_order:${entryOrder}`
  return { key, hash:sha256(key), position_id:position || null, entry_order_ticket:entryOrder || null }
}

function normalizeDirection(value) {
  const normalized = text(value).toLowerCase()
  if (normalized === 'buy' || normalized === 'long' || normalized === '0') return 'buy'
  if (normalized === 'sell' || normalized === 'short' || normalized === '1') return 'sell'
  return null
}

function normalizeDeal(row, source = 'deal') {
  const entry = dealEntry(row?.entry ?? row?.entry_type)
  const rawJson = row?.raw_json == null ? null : row.raw_json
  return {
    source,
    deal_ticket:dealTicket(row) || null,
    order_ticket:orderTicket(row) || null,
    position_id:positionId(row) || null,
    symbol:text(row?.symbol) || null,
    direction:normalizeDirection(row?.direction ?? row?.type),
    entry,
    magic:Object.prototype.hasOwnProperty.call(row || {}, 'magic') ? numberOrNull(row.magic) : null,
    reason:row?.reason == null ? null : row.reason,
    comment:text(row?.comment) || null,
    volume:numberOrNull(row?.volume),
    price:numberOrNull(row?.price ?? row?.entry_price ?? row?.exit_price),
    profit:numberOrNull(row?.profit),
    commission:numberOrNull(row?.commission),
    swap:numberOrNull(row?.swap),
    fee:numberOrNull(row?.fee),
    time_utc_msc:numberOrNull(row?.time_utc_msc ?? row?.time_msc),
    time_server_msc:numberOrNull(row?.time_server_msc),
    entry_type:entry === 'entry' ? 0 : entry === 'exit' ? 1 : null,
    raw_json:rawJson,
  }
}

function normalizeOrder(row) {
  return {
    order_ticket:orderTicket(row) || text(row?.ticket) || null,
    position_id:positionId(row) || null,
    symbol:text(row?.symbol) || null,
    magic:Object.prototype.hasOwnProperty.call(row || {}, 'magic') ? numberOrNull(row.magic) : null,
    reason:row?.reason == null ? null : row.reason,
    comment:text(row?.comment) || null,
    volume_initial:numberOrNull(row?.volume_initial),
    volume_current:numberOrNull(row?.volume_current),
    price_open:numberOrNull(row?.price_open),
    stop_loss:optionalProtectionPrice(row?.stop_loss, row?.sl),
    take_profit:optionalProtectionPrice(row?.take_profit, row?.tp),
    time_utc_msc:numberOrNull(row?.time_utc_msc),
    time_server_msc:numberOrNull(row?.time_server_msc),
  }
}

function historySyncComplete(sync = {}) {
  if (!sync || typeof sync !== 'object') return false
  if (sync.evidence_truncated === true) return false
  const platform = String(sync.platform || '').trim().toLowerCase()
  // MT4 cannot prove broker-wide history completeness. It may only be used
  // when the terminal explicitly proves that its currently visible account
  // history is complete. This deliberately does not require or rewrite
  // history_source_complete: that field remains false for terminal-scoped data.
  if (platform === 'mt4') {
    return sync.terminal_visible_history_complete === true
  }
  // MT5 has an exact-range proof contract. Do not infer readiness from global
  // complete/coverage flags or from a legacy response that omits the proof.
  return sync.requested_range_complete === true
}

export function isTrustedManualTradeClock(sync = {}) {
  sync = sync || {}
  return trustedTerminalClock({
    clock_status:sync.clock_status || sync.terminal_clock_status || sync.source_clock_status,
    timezone_offset_minutes:sync.timezone_offset_minutes ?? sync.terminal_timezone_offset_minutes,
  })
}

function historicalTradeClock(payload = {}) {
  const offsets = []
  for (const key of ['deals', 'history_orders', 'orders', 'trades']) {
    for (const row of Array.isArray(payload?.[key]) ? payload[key] : []) {
      const utc = numberOrNull(row?.time_utc_msc ?? row?.time_msc)
      const server = numberOrNull(row?.time_server_msc)
      if (!Number.isFinite(utc) || !Number.isFinite(server) || utc <= 0 || server <= 0) continue
      const rawOffset = (server - utc) / 60_000
      const rounded = Math.round(rawOffset)
      if (Math.abs(rawOffset - rounded) > (1_000 / 60_000) || rounded < -720 || rounded > 840) return null
      offsets.push(rounded)
    }
  }
  if (!offsets.length || offsets.some(value => value !== offsets[0])) return null
  return { timezone_offset_minutes:offsets[0], clock_status:'history_record_verified' }
}

function matchingPositionId(row) { return positionId(row) || null }

function currentPositionIds(positions = []) {
  const ids = new Set()
  for (const item of Array.isArray(positions) ? positions : []) {
    const id = matchingPositionId(item) || text(item?.ticket)
    const volume = numberOrNull(item?.volume ?? item?.volume_current)
    if (id && volume != null && volume > 0) ids.add(id)
  }
  return ids
}

function buildGroupKey(row, account) {
  const position = positionId(row)
  const entryOrder = orderTicket(row) || text(row?.ticket)
  if (!position && !entryOrder) return null
  return sourceIdentity({ terminalInstanceId:account.terminal_instance_id,
    brokerServer:account.broker_server, loginAccount:account.login_account,
    position, entryOrder }).key
}

function referencesForGroup(group) {
  return [...new Set([
    ...group.deals.flatMap(item => [item.deal_ticket, item.order_ticket, item.position_id]),
    ...group.orders.flatMap(item => [item.order_ticket, item.position_id]),
    group.trade?.ticket, group.trade?.trade_ticket, group.trade?.deal_ticket, group.trade?.deal,
    group.trade?.order, group.trade?.order_ticket, group.trade?.pending_ticket, group.trade?.position_id,
  ].map(text).filter(Boolean))]
}

function classifySystemLink(value) {
  if (!value) return false
  if (value instanceof Set) return value.size > 0
  if (Array.isArray(value)) return value.length > 0
  return Boolean(value)
}

const TRADE_REFERENCE_FIELDS = ['position_id', 'position', 'ticket', 'order_ticket', 'order', 'order_id',
  'deal_ticket', 'deal', 'deal_id', 'trade_ticket', 'pending_ticket']

export function collectManualTradeEvidenceRefs(payload = {}) {
  const references = new Set()
  for (const key of ['trades', 'deals', 'history_orders', 'orders']) {
    for (const row of Array.isArray(payload?.[key]) ? payload[key] : []) {
      for (const field of TRADE_REFERENCE_FIELDS) {
        const value = text(row?.[field])
        if (value && value !== '0') references.add(value)
      }
    }
  }
  return [...references]
}

/**
 * Convert one bounded Bridge response into complete manual positions. This is
 * deliberately pure so the conservative admission rules can be tested
 * without a live terminal or database.
 */
export function buildEligibleManualTrades(payload = {}, {
  account = {}, systemReferences = new Set(), positions = [], requireComplete = true,
} = {}) {
  const sync = {
    ...(payload.history_sync || payload.historySync || {}),
    // Some Bridge generations put the completeness proof on the envelope,
    // while others nest it under history_sync. Merge both forms before
    // admission so an envelope-level false cannot be hidden by a stale nested
    // value (and an explicit nested false always wins).
    complete:payload.complete ?? payload.history_sync?.complete ?? payload.historySync?.complete,
    requested_range_complete:payload.requested_range_complete
      ?? payload.history_sync?.requested_range_complete ?? payload.historySync?.requested_range_complete,
    coverage_complete:payload.coverage_complete
      ?? payload.history_sync?.coverage_complete ?? payload.historySync?.coverage_complete,
    evidence_truncated:payload.evidence_truncated
      ?? payload.history_sync?.evidence_truncated ?? payload.historySync?.evidence_truncated,
    backfill_pending:payload.backfill_pending
      ?? payload.history_sync?.backfill_pending ?? payload.historySync?.backfill_pending,
    history_source_complete:payload.history_source_complete
      ?? payload.history_sync?.history_source_complete ?? payload.historySync?.history_source_complete,
    terminal_visible_history_complete:payload.terminal_visible_history_complete
      ?? payload.history_sync?.terminal_visible_history_complete ?? payload.historySync?.terminal_visible_history_complete,
    platform:payload.platform || payload.history_sync?.platform || payload.historySync?.platform,
    clock_status:payload.clock_status || payload.terminal_clock_status || payload.source_clock_status
      || payload.history_sync?.clock_status || payload.history_sync?.terminal_clock_status
      || payload.history_sync?.source_clock_status || payload.historySync?.clock_status,
    timezone_offset_minutes:payload.timezone_offset_minutes
      ?? payload.history_sync?.timezone_offset_minutes ?? payload.historySync?.timezone_offset_minutes,
  }
  if (requireComplete && !historySyncComplete({ ...sync, platform:sync.platform || account.platform })) {
    const platform = accountPlatform(account, sync)
    const reason = platform === 'mt4'
      ? (sync.terminal_visible_history_complete === false ? MT4_VISIBLE_HISTORY_INCOMPLETE : MT4_VISIBLE_HISTORY_UNKNOWN)
      : 'history_incomplete'
    return { trades:[], excluded:[{ reason }], evidence_status:'unavailable', evidence_reason:reason }
  }
  const rawDeals = Array.isArray(payload.deals) ? payload.deals : []
  const rawOrders = Array.isArray(payload.history_orders) ? payload.history_orders : (Array.isArray(payload.orders) ? payload.orders : [])
  const rawTrades = Array.isArray(payload.trades) ? payload.trades : (Array.isArray(payload.orders) ? payload.orders : [])
  const sourceRowsPresent = rawDeals.length || rawOrders.length || rawTrades.length
  const liveClock = { timezone_offset_minutes:sync.timezone_offset_minutes ?? account.timezone_offset_minutes,
    clock_status:sync.clock_status || account.clock_status }
  const effectiveClock = isTrustedManualTradeClock(liveClock) ? liveClock : historicalTradeClock(payload)
  // An empty, range-complete source page has no historical timestamp to
  // interpret, so it can safely represent an empty result. Any actual trade
  // evidence still needs either a trusted live clock or its own persisted
  // UTC/server timestamp pair.
  if (sourceRowsPresent && !isTrustedManualTradeClock(effectiveClock)) {
    return { trades:[], excluded:[{ reason:'clock_untrusted' }], evidence_status:'unavailable', evidence_reason:'clock_untrusted' }
  }
  const orders = rawOrders.map(normalizeOrder)
  const orderByTicket = new Map(orders.filter(item => item.order_ticket).map(item => [item.order_ticket, item]))
  const groups = new Map()
  const add = (row, kind) => {
    const key = buildGroupKey(row, account)
    if (!key) return
    const group = groups.get(key) || { key, deals:[], orders:[], trades:[] }
    if (kind === 'deal') group.deals.push(normalizeDeal(row))
    if (kind === 'order') group.orders.push(normalizeOrder(row))
    if (kind === 'trade') group.trades.push(row)
    groups.set(key, group)
  }
  for (const row of rawDeals) add(row, 'deal')
  for (const row of rawOrders) add(row, 'order')
  for (const row of rawTrades) add(row, 'trade')

  const activePositionIds = currentPositionIds(positions)
  const trades = []
  const excluded = []
  for (const group of groups.values()) {
    const deals = group.deals
    const trade = group.trades[0] || {}
    const identity = sourceIdentity({ terminalInstanceId:account.terminal_instance_id,
      brokerServer:account.broker_server, loginAccount:account.login_account,
      position:positionId(trade) || positionId(deals[0]),
      entryOrder:orderTicket(trade) || orderTicket(deals[0]) || text(trade.ticket) })
    const refs = referencesForGroup(group)
    const reasons = []
    if (!deals.length) reasons.push('deals_missing')
    if (!identity.position_id && !identity.entry_order_ticket) reasons.push('stable_identity_missing')
    if (identity.position_id && activePositionIds.has(identity.position_id)) reasons.push('position_open')
    const entries = deals.filter(item => item.entry === 'entry')
    const exits = deals.filter(item => item.entry === 'exit')
    const entryOrderTicket = entries.map(item => item.order_ticket).find(Boolean)
      || group.orders.map(item => item.order_ticket).find(Boolean)
      || identity.entry_order_ticket
    const linkedRefs = entryOrderTicket
      && classifySystemLink(systemReferences?.get?.(entryOrderTicket) || systemReferences?.[entryOrderTicket])
      ? [entryOrderTicket] : []
    const linked = linkedRefs.length > 0
    if (!entryOrderTicket) reasons.push('entry_order_ticket_missing')
    if (linked) reasons.push('system_association')
    const entryVolume = entries.reduce((sum, item) => sum + (item.volume || 0), 0)
    const exitVolume = exits.reduce((sum, item) => sum + (item.volume || 0), 0)
    if (!entries.length || !exits.length || entryVolume <= 0 || exitVolume <= 0) reasons.push('deal_chain_incomplete')
    if (entryVolume > 0 && Math.abs(entryVolume - exitVolume) > Math.max(1e-8, entryVolume * 1e-6)) reasons.push('partial_close')
    const symbols = [...new Set(deals.map(item => item.symbol).concat(trade.symbol).map(text).filter(Boolean))]
    if (symbols.length !== 1) reasons.push('symbol_inconsistent')
    const direction = normalizeDirection(trade.direction || trade.type || entries[0]?.direction)
    if (!direction) reasons.push('direction_missing')
    const times = deals.map(item => item.time_utc_msc).filter(Number.isFinite)
    if (!times.length || times.some(value => value <= 0)) reasons.push('time_untrusted')
    const orderRefs = deals.map(item => item.order_ticket).filter(Boolean).map(ticket => orderByTicket.get(ticket)).filter(Boolean)
    const protections = orderRefs.concat(group.orders)
    // A complete source needs the linked historical order rows as well as the
    // deal chain. Magic and broker reason remain audit metadata only: the
    // business definition is whether the entry order is bound to a platform
    // signal, not how the terminal classified the order source.
    if (!group.orders.length) reasons.push('order_evidence_incomplete')
    if (deals.some(item => !Number.isFinite(item.price) || item.price <= 0)) reasons.push('deal_price_missing')
    const netProfit = deals.reduce((sum, item) => sum + (item.profit || 0) + (item.commission || 0) + (item.swap || 0) + (item.fee || 0), 0)
    if (!(netProfit > 0)) reasons.push('not_profitable')
    const normalized = {
      schema_version:1,
      identity:{ position_id:identity.position_id, entry_order_ticket:entryOrderTicket || identity.entry_order_ticket,
        identity_hash:identity.hash },
      symbol:symbols[0] || null, direction, entry_volume:entryVolume, closed_volume:exitVolume,
      trade_count:1, deal_count:deals.length, order_count:group.orders.length,
      entry_time_utc_msc:entries.map(item => item.time_utc_msc).filter(Number.isFinite).length
        ? Math.min(...entries.map(item => item.time_utc_msc).filter(Number.isFinite)) : null,
      close_time_utc_msc:times.length ? Math.max(...times) : null,
      entry_price:entries.length ? entries.reduce((sum, item) => sum + (item.price || 0) * (item.volume || 0), 0) / Math.max(entryVolume, 1e-12) : numberOrNull(trade.entry_price),
      close_price:exits.length ? exits.reduce((sum, item) => sum + (item.price || 0) * (item.volume || 0), 0) / Math.max(exitVolume, 1e-12) : numberOrNull(trade.exit_price),
      stop_loss:protections.map(item => item.stop_loss).find(value => value != null && value > 0)
        ?? optionalProtectionPrice(trade.stop_loss, trade.sl),
      take_profit:protections.map(item => item.take_profit).find(value => value != null && value > 0)
        ?? optionalProtectionPrice(trade.take_profit, trade.tp),
      net_profit:netProfit,
      fees:{ commission:deals.reduce((sum, item) => sum + (item.commission || 0), 0), swap:deals.reduce((sum, item) => sum + (item.swap || 0), 0), fee:deals.reduce((sum, item) => sum + (item.fee || 0), 0) },
      deals:deals.map(item => ({ ...item })),
      orders:group.orders.map(item => ({ ...item })),
      source_refs:refs,
      terminal_instance_id:account.terminal_instance_id,
      broker_server:account.broker_server,
      login_account:account.login_account,
      timezone_offset_minutes:Number(effectiveClock?.timezone_offset_minutes),
      clock_status:text(effectiveClock?.clock_status),
      snapshot_at_utc_msc:Date.now(),
    }
    const manualClassification = {
      source:'unbound_platform_signal', evidence_status:'complete',
      magic_values:[...new Set(deals.concat(group.orders).map(item => item.magic).filter(value => value != null))],
      reasons:[...new Set(deals.concat(group.orders).map(item => item.reason).filter(value => value != null).map(String))],
      expert_reason:Boolean(deals.some(item => isExpertReason(item.reason)) || group.orders.some(item => isExpertReason(item.reason))),
      system_association:{ linked, matched_refs:linkedRefs,
        matched_rows:linkedRefs.map(ref => systemReferences?.get?.(ref) || systemReferences?.[ref] || null).filter(Boolean) },
    }
    normalized.manual_classification = manualClassification
    const tradeSourceHash = normalizedTradeHash(normalized)
    if (reasons.length) excluded.push({ identity_hash:identity.hash, reason:[...new Set(reasons)].join(',') })
    else trades.push({
      trade_id:identity.hash, source_identity_hash:identity.hash, trade_source_hash:tradeSourceHash,
      symbol:normalized.symbol, direction:normalized.direction, position_id:identity.position_id,
      entry_order_ticket:normalized.identity.entry_order_ticket, entry_time_utc_msc:normalized.entry_time_utc_msc,
      close_time_utc_msc:normalized.close_time_utc_msc, entry_price:normalized.entry_price,
      close_price:normalized.close_price, stop_loss:normalized.stop_loss, take_profit:normalized.take_profit,
      volume:normalized.closed_volume, deal_count:normalized.deal_count, net_profit:normalized.net_profit,
      evidence_status:'complete', manual_classification:manualClassification, normalized,
    })
  }
  return { trades, excluded, evidence_status:'complete', evidence_reason:null,
    history_sync:sync, timezone_offset_minutes:effectiveClock?.timezone_offset_minutes ?? null,
    clock_status:text(effectiveClock?.clock_status) }
}

async function findSystemReferences({ userId, tradingAccountId, refs }) {
  const references = [...new Set((refs || []).map(text).filter(Boolean))]
  if (!references.length) return new Map()
  const placeholders = references.map(() => '?').join(',')
  const map = new Map()
  const queryRows = async (sql, params) => {
    const rows = await queryAll(sql, params)
    for (const row of rows) {
      for (const key of ['trade_ticket', 'pending_ticket', 'entry_order_ticket', 'entry_deal_ticket', 'position_id', 'deal_ticket', 'order_ticket']) {
        const value = text(row?.[key])
        if (value) map.set(value, row)
      }
    }
  }
  await queryRows(`SELECT id, trade_ticket, pending_ticket, bridge_command_ref, source_type
    FROM order_intents WHERE user_id = ? AND trading_account_id = ?
      AND (trade_ticket IN (${placeholders}) OR pending_ticket IN (${placeholders})) LIMIT 200`, [userId, tradingAccountId, ...references, ...references])
  await queryRows(`SELECT id, entry_order_ticket, entry_deal_ticket, pending_ticket, position_id
    FROM signal_outcomes WHERE user_id = ? AND trading_account_id = ?
      AND (entry_order_ticket IN (${placeholders}) OR entry_deal_ticket IN (${placeholders})
        OR pending_ticket IN (${placeholders}) OR position_id IN (${placeholders})) LIMIT 200`, [userId, tradingAccountId, ...references, ...references, ...references, ...references])
  // Legacy signal/delivery rows do not carry trading_account_id. Only admit
  // them as binding evidence through an outcome already scoped to the current
  // account; ticket numbers may collide across a user's terminals.
  await queryRows(`SELECT deliveries.id, deliveries.trade_ticket, deliveries.pending_ticket
    FROM auto_signal_deliveries deliveries
    JOIN signal_outcomes outcomes ON outcomes.signal_id = deliveries.signal_id
      AND outcomes.user_id = deliveries.user_id AND outcomes.trading_account_id = ?
    WHERE deliveries.user_id = ?
      AND (deliveries.trade_ticket IN (${placeholders}) OR deliveries.pending_ticket IN (${placeholders})) LIMIT 200`,
  [tradingAccountId, userId, ...references, ...references])
  await queryRows(`SELECT signals.id, signals.trade_ticket, signals.pending_ticket
    FROM ai_signals signals
    JOIN signal_outcomes outcomes ON outcomes.signal_id = signals.id
      AND outcomes.user_id = signals.user_id AND outcomes.trading_account_id = ?
    WHERE signals.user_id = ?
      AND (signals.trade_ticket IN (${placeholders}) OR signals.pending_ticket IN (${placeholders})) LIMIT 200`,
  [tradingAccountId, userId, ...references, ...references])
  await queryRows(`SELECT deal_ticket, order_ticket, position_id FROM signal_outcome_deals
    WHERE user_id = ? AND trading_account_id = ?
      AND (deal_ticket IN (${placeholders}) OR order_ticket IN (${placeholders}) OR position_id IN (${placeholders})) LIMIT 200`, [userId, tradingAccountId, ...references, ...references, ...references])
  return map
}

export async function getCurrentManualReviewAccount(userId, tradingAccountId = null) {
  const params = [Number(userId)]
  let accountClause = ''
  if (Number(tradingAccountId) > 0) { accountClause = ' AND ta.id = ?'; params.push(Number(tradingAccountId)) }
  const row = await queryOne(`SELECT ta.id, ta.user_id, ta.broker_server, ta.login_account, ta.observe_status,
      bindings.current_user_id, bindings.current_trading_account_id, ownership.id AS ownership_history_id,
      ownership.started_at AS ownership_started_at, bindings.account_currency
    FROM trading_accounts ta
    JOIN mt5_account_bindings bindings
      ON bindings.current_trading_account_id = ta.id
      AND bindings.current_user_id = ta.user_id
      AND UPPER(bindings.broker_server_key) = UPPER(ta.broker_server)
      AND bindings.login_account = ta.login_account
    LEFT JOIN mt5_account_ownership_history ownership
      ON ownership.trading_account_id = ta.id AND ownership.user_id = ta.user_id
      AND ownership.ended_at IS NULL
    WHERE ta.user_id = ? AND bindings.current_user_id = ? AND ta.is_deleted = 0
      AND ta.observe_status = 'active'${accountClause}
    ORDER BY ta.updated_at DESC, ta.id DESC LIMIT 1`, [Number(userId), ...params])
  if (!row) throw new Error('manual_trade_review_account_unavailable')
  const diagnostics = getBridgeRuntimeDiagnostics(Number(userId))
  const terminals = (diagnostics.terminals || []).filter(item =>
    String(item.broker_server || '').trim().toLowerCase() === String(row.broker_server || '').trim().toLowerCase()
      && String(item.login || '').trim() === String(row.login_account || '').trim())
  if (terminals.length !== 1) throw new Error(terminals.length ? 'manual_trade_review_bridge_route_ambiguous' : 'manual_trade_review_bridge_unavailable')
  const route = { terminal_instance_id:terminals[0].terminal_instance_id,
    account_ref:{ broker_server:String(row.broker_server), login:String(row.login_account) } }
  const terminalClock = getHistoryTerminalClock(Number(userId), route)
  return { ...row, id:Number(row.id), user_id:Number(row.user_id), terminal_instance_id:terminals[0].terminal_instance_id,
    platform:terminals[0].platform || null, broker_server:String(row.broker_server), login_account:String(row.login_account),
    timezone_offset_minutes:terminalClock?.timezone_offset_minutes ?? null,
    clock_status:terminalClock?.clock_status || 'unavailable', route }
}

function resolveRecentProfitableRange(params = {}, nowUtcMsc = Date.now()) {
  const now = Number(nowUtcMsc)
  const suppliedStart = Number(params.range_start_utc_msc)
  const suppliedEnd = Number(params.range_end_utc_msc)
  if (params.history_snapshot_id || params.cursor) {
    if (!Number.isFinite(suppliedStart) || !Number.isFinite(suppliedEnd)
      || suppliedStart <= 0 || suppliedEnd <= suppliedStart
      || suppliedEnd - suppliedStart > MANUAL_TRADE_LOOKBACK_MSC
      || suppliedEnd > now + 5 * 60_000) {
      throw new Error('manual_trade_review_history_range_invalid')
    }
    return { range_start_utc_msc:suppliedStart, range_end_utc_msc:suppliedEnd }
  }
  return { range_start_utc_msc:now - MANUAL_TRADE_LOOKBACK_MSC, range_end_utc_msc:now }
}

async function bridgeHistory(account, params = {}, { evidence = false, range:providedRange = null } = {}) {
  const range = providedRange || resolveRecentProfitableRange(params)
  const action = evidence ? 'history_evidence' : 'history_page'
  const request = {
    ...account.route, range_start_utc_msc:range.range_start_utc_msc, range_end_utc_msc:range.range_end_utc_msc,
    page_size:Math.min(MANUAL_TRADE_PAGE_MAX, Math.max(1, Number(params.page_size) || MANUAL_TRADE_PAGE_DEFAULT)),
    direction:params.direction,
  }
  if (action === 'history_page') Object.assign(request, { history_snapshot_id:params.history_snapshot_id, cursor:params.cursor })
  if (evidence) {
    request.evidence_position_ids = params.evidence_position_ids
    request.evidence_order_tickets = params.evidence_order_tickets
  }
  return mt5Bridge(account.user_id, action, request, { timeoutMs:30_000, noFallback:true, tradingAccountId:account.id })
}

function bridgeActionUnsupported(result = {}) {
  const code = text(result?.error || result?.code || result?.message).toLowerCase()
  return code.includes('unsupported') || code.includes('unknown_action') || code.includes('unexpected_action')
}

function accountPlatform(account = {}, sync = {}) {
  return text(account?.platform || sync?.platform).toLowerCase()
}

function manualTradeHistoryScope(account = {}, sync = {}) {
  if (accountPlatform(account, sync) !== 'mt4') return { history_scope_note:null, history_source_limited:false }
  return { history_scope_note:MT4_HISTORY_SCOPE_NOTE, history_source_limited:true }
}

async function prepareManualTradeRange(account, range) {
  const platform = accountPlatform(account)
  for (let attempt = 0; attempt < MANUAL_TRADE_PREPARE_POLL_ATTEMPTS; attempt += 1) {
    let result
    try {
      result = await mt5Bridge(account.user_id, 'history_prepare_status_v1', {
        ...account.route,
        range_start_utc_msc:range.range_start_utc_msc,
        range_end_utc_msc:range.range_end_utc_msc,
      }, { timeoutMs:5_000, noFallback:true, tradingAccountId:account.id })
    } catch (error) {
      return { supported:true, ready:false,
        reason:platform === 'mt4' ? MT4_VISIBLE_HISTORY_UNKNOWN : text(error?.message) || 'history_prepare_status_failed',
        ...manualTradeHistoryScope(account) }
    }
    if (bridgeActionUnsupported(result)) {
      if (platform === 'mt4') {
        // MT4 cannot provide an exact-range prepare proof. Its bounded
        // history_page response is authoritative for the weaker, explicitly
        // terminal-visible scope and must carry
        // terminal_visible_history_complete=true before admission.
        return { supported:false, ready:null, reason:null, ...manualTradeHistoryScope(account) }
      }
      return { supported:true, ready:false, reason:'history_cursor_range_incomplete' }
    }
    if (!result || result.status === 'error' || result.error) {
      return { supported:true, ready:false,
        reason:platform === 'mt4' ? MT4_VISIBLE_HISTORY_UNKNOWN : text(result?.error) || 'history_prepare_status_failed',
        ...manualTradeHistoryScope(account) }
    }
    const nestedSync = historySyncFromPayload(result)
    const sync = {
      ...nestedSync,
      platform:nestedSync.platform || result.platform || platform || null,
      terminal_visible_history_complete:nestedSync.terminal_visible_history_complete
        ?? result.terminal_visible_history_complete,
      requested_range_complete:nestedSync.requested_range_complete
        ?? result.requested_range_complete,
    }
    const scope = manualTradeHistoryScope(account, sync)
    if (platform === 'mt4') {
      if (sync.terminal_visible_history_complete === true) {
        return { supported:true, ready:true, reason:null, history_sync:sync, ...scope }
      }
      if (sync.terminal_visible_history_complete === false) {
        return { supported:true, ready:false, reason:MT4_VISIBLE_HISTORY_INCOMPLETE,
          history_sync:sync, ...scope }
      }
      return { supported:true, ready:false, reason:MT4_VISIBLE_HISTORY_UNKNOWN,
        history_sync:sync, ...scope }
    }
    if (sync.requested_range_complete === true) {
      return { supported:true, ready:true, reason:null, history_sync:sync, ...scope }
    }
    // MT5 must explicitly prove the requested range. A missing proof is not
    // compatible with a successful read; keep the failure visible to callers.
    if (typeof sync.requested_range_complete !== 'boolean') {
      return { supported:true, ready:false, reason:'history_cursor_range_incomplete', history_sync:sync, ...scope }
    }
    if (attempt + 1 < MANUAL_TRADE_PREPARE_POLL_ATTEMPTS) {
      await new Promise(resolve => setTimeout(resolve, MANUAL_TRADE_PREPARE_POLL_INTERVAL_MS))
    }
  }
  return { supported:true, ready:false, reason:'history_cursor_range_incomplete', ...manualTradeHistoryScope(account) }
}

function manualTradePageSize(params = {}) {
  return Math.min(MANUAL_TRADE_PAGE_MAX, Math.max(1, Number(params.page_size) || MANUAL_TRADE_PAGE_DEFAULT))
}

function manualTradeUnavailable({ pageSize, historySnapshotId = null, reason = 'manual_trade_review_evidence_unavailable', error = 'manual_trade_review_evidence_unavailable', scannedSourcePages = 0, skippedEmptySourcePages = 0, history_scope_note = null, history_source_limited = false } = {}) {
  const pagination = {
    page_size:pageSize,
    total:0,
    history_snapshot_id:historySnapshotId,
    next_cursor:null,
    has_more:false,
    scanned_source_pages:scannedSourcePages,
    skipped_empty_source_pages:skippedEmptySourcePages,
  }
  return {
    trades:[], pagination,
    history_snapshot_id:historySnapshotId, next_cursor:null, has_more:false,
    scanned_source_pages:scannedSourcePages,
    skipped_empty_source_pages:skippedEmptySourcePages,
    unavailable:true, evidence_status:'unavailable', error, evidence_reason:reason,
    ...(history_scope_note ? { history_scope_note } : {}),
    history_source_limited:Boolean(history_source_limited),
  }
}

function historySyncFromPayload(payload = {}) {
  return payload?.history_sync || payload?.historySync || {}
}

function mergeHistoryEvidencePage(page = {}, enriched = {}) {
  const pageSync = historySyncFromPayload(page)
  const enrichedSync = historySyncFromPayload(enriched)
  const mergedSync = { ...pageSync, ...enrichedSync }
  const completenessFlags = ['complete', 'requested_range_complete', 'coverage_complete',
    'evidence_truncated', 'backfill_pending', 'history_source_complete', 'terminal_visible_history_complete']
  for (const key of completenessFlags) {
    if (pageSync[key] === false || enrichedSync[key] === false) mergedSync[key] = false
  }
  const merged = {
    ...page, ...enriched,
    // Keep completeness/clock proof from the source page when the evidence
    // endpoint omits it. An explicit false from either response still wins.
    history_sync:mergedSync,
    historySync:{ ...(page?.historySync || {}), ...(enriched?.historySync || {}) },
    // Cursor continuation metadata belongs to the source page. The evidence
    // endpoint is reference-only and must not invent or extend pagination.
    history_snapshot_id:page.history_snapshot_id || null,
    next_cursor:page.next_cursor || null,
    has_more:page.has_more === true,
    orders:Array.isArray(page.orders) && page.orders.length ? page.orders : enriched.orders || page.orders,
  }
  for (const key of completenessFlags) {
    if (page[key] === false || enriched[key] === false) merged[key] = false
  }
  return merged
}

function historyPageHasRows(page = {}) {
  return ['deals', 'history_orders', 'orders', 'trades'].some(key => Array.isArray(page?.[key]) && page[key].length > 0)
}

/**
 * Compact cursor pages only contain summary rows. Resolve their opaque refs
 * through the bounded evidence endpoint while preserving the original
 * snapshot/cursor metadata. If a source page has rows but its evidence cannot
 * be proven, the caller must fail closed instead of scanning around the gap.
 */
async function enrichManualTradeHistoryPage(account, params, page, range) {
  if (!page || page.status === 'error' || page.error) {
    return { result:page, unavailable:true, reason:page?.error || 'manual_trade_review_evidence_unavailable' }
  }
  const hasDeals = Array.isArray(page.deals) && page.deals.length > 0
  const hasHistoryOrders = Array.isArray(page.history_orders) && page.history_orders.length > 0
  if (hasDeals && hasHistoryOrders) return { result:page, unavailable:false }

  const pageRows = Array.isArray(page.orders) && page.orders.length
    ? page.orders : (Array.isArray(page.history_orders) && page.history_orders.length
      ? page.history_orders : (Array.isArray(page.deals) ? page.deals : []))
  // An actually empty source page can be skipped safely. A non-empty compact
  // page without stable refs cannot be proven and therefore cannot be scanned.
  if (!pageRows.length) {
    if (historyPageHasRows(page)) return { result:page, unavailable:true, reason:'history_evidence_unavailable' }
    return { result:page, unavailable:false }
  }
  const evidencePositionIds = [...new Set(pageRows.map(row => positionId(row)).filter(Boolean))].slice(0, 100)
  const evidenceOrderTickets = [...new Set(pageRows.map(row => orderTicket(row) || text(row?.ticket)).filter(Boolean))]
    .slice(0, Math.max(0, 100 - evidencePositionIds.length))
  if (!evidencePositionIds.length && !evidenceOrderTickets.length) {
    return { result:page, unavailable:true, reason:'history_evidence_unavailable' }
  }
  let enriched
  try {
    enriched = await bridgeHistory(account, { ...params,
      evidence_position_ids:evidencePositionIds, evidence_order_tickets:evidenceOrderTickets,
    }, { evidence:true, range })
  } catch {
    return { result:page, unavailable:true, reason:'history_evidence_unavailable' }
  }
  if (!enriched || enriched.status === 'error' || enriched.error) {
    return { result:page, unavailable:true, reason:enriched?.error || 'history_evidence_unavailable' }
  }
  return { result:mergeHistoryEvidencePage(page, enriched), unavailable:false }
}

function strategyMarketTimeframes(strategySnapshot = {}) {
  const plan = strategySnapshot?.market_data_plan
  const items = Array.isArray(plan?.timeframes) ? plan.timeframes : []
  const valid = new Set(['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1'])
  return [...new Set(items.map(item => String(item?.timeframe || item?.tf || '').trim().toUpperCase())
    .filter(value => valid.has(value)))].slice(0, 4)
}

function reviewPathDeals(trade = {}) {
  const normalized = trade.normalized || trade
  return (Array.isArray(normalized.deals) ? normalized.deals : []).map(deal => {
    const raw = deal?.raw_json && typeof deal.raw_json === 'object' ? deal.raw_json : {}
    const time = Number(deal?.time_utc_msc ?? raw.time_utc_msc ?? raw.time_msc)
    return {
      ...deal,
      entry_type:deal?.entry_type ?? (deal?.entry === 'entry' ? 0 : deal?.entry === 'exit' ? 1 : null),
      volume:Number(deal?.volume || 0), price:Number(deal?.price || 0),
      raw_json:JSON.stringify({ ...raw, time_utc_msc:Number.isFinite(time) && time > 0 ? time : undefined }),
    }
  })
}

/**
 * Build frozen market evidence for each selected source. The path builder is
 * intentionally bounded to the frozen strategy's first four timeframes and
 * the selected source count (the API caps that count at ten).
 */
export async function buildManualTradeMarketEvidence({ actor, account, trades = [], strategySnapshot = {}, buildPath = buildReviewMarketPath } = {}) {
  if (!Array.isArray(trades) || trades.length > MANUAL_TRADE_SELECTION_MAX) {
    return { schema_version:1, status:'unavailable', reason:'selection_limit_exceeded', timeframes:[], trades:{}, hash:null }
  }
  const timeframes = strategyMarketTimeframes(strategySnapshot)
  const useChanAnalysis = strategySnapshot?.use_chan_analysis === true
    || strategySnapshot?.use_chan_analysis === 1 || strategySnapshot?.use_chan_analysis === '1'
  const chanRequirement = resolveFrozenChanRequirement({ strategy_runtime:{
    use_chan_analysis:useChanAnalysis,
    strategy_version:strategySnapshot?.version,
    market_data_plan:strategySnapshot?.market_data_plan,
    chan_timeframes:timeframes,
  } })
  const marketData = { schema_version:1, status:'complete', reason:null, timeframes,
    chan_requirement:chanRequirement, trades:{} }
  if (!timeframes.length) return { ...marketData, status:'partial', reason:'market_data_plan_missing' }
  if (chanRequirement.status === 'enabled' && (chanRequirement.unsupported_timeframes || []).length) {
    return { ...marketData, status:'partial', reason:'chan_timeframe_unsupported', hash:sha256(marketData) }
  }
  const failures = []
  const snapshot = {
    ...strategySnapshot,
    klines:Object.fromEntries(timeframes.map(timeframe => [timeframe, []])),
  }
  for (const trade of trades.slice(0, MANUAL_TRADE_SELECTION_MAX)) {
    const identity = String(trade.source_identity_hash || trade.trade_id || trade.normalized?.identity?.identity_hash || '')
    if (!identity || !trade.symbol) {
      failures.push(`${identity || 'unknown'}:market_source_identity_missing`)
      continue
    }
    try {
      const entryTimeUtcMsc = Number(trade.entry_time_utc_msc || trade.normalized?.entry_time_utc_msc)
      const common = {
        userId:Number(actor?.id), tradingAccountId:Number(account?.id), symbol:trade.symbol,
        snapshot, deals:reviewPathDeals(trade), timezoneOffsetMinutes:Number(account?.timezone_offset_minutes),
        chanRequirement,
      }
      const preEntry = await buildPath({ ...common,
        signal:{ timeframe:String(strategySnapshot?.market_data_plan?.primary_timeframe || timeframes[0]), signal_type:'hold' },
        asOfUtcMsc:Number.isFinite(entryTimeUtcMsc) ? entryTimeUtcMsc : null, includeHoldingMetrics:false,
      })
      const outcomePath = await buildPath({ ...common,
        signal:{ timeframe:String(strategySnapshot?.market_data_plan?.primary_timeframe || timeframes[0]),
          signal_type:trade.direction, stop_loss_price:trade.stop_loss, take_profit_1_price:trade.take_profit },
      })
      const path = { status:preEntry?.status === 'complete' && outcomePath?.status === 'complete' ? 'complete' : 'partial',
        pre_entry:preEntry, outcome_path:outcomePath }
      if (chanRequirement.status === 'enabled') {
        const chanFrames = [...new Set(chanRequirement.timeframes || [])]
        const chanComplete = chanFrames.length > 0 && chanFrames.every(timeframe => {
          const before = preEntry?.timeframes?.[timeframe]?.chan
          const after = outcomePath?.timeframes?.[timeframe]?.chan
          return [before, after].every(value => ['complete', 'ok'].includes(String(value?.status || '').toLowerCase()))
        })
        if (!chanComplete) {
          path.status = 'partial'
          path.reason = 'chan_evidence_incomplete'
        }
      }
      marketData.trades[identity] = path
      if (path.status !== 'complete') failures.push(`${identity}:${path.reason || preEntry?.reason || outcomePath?.reason || 'market_path_incomplete'}`)
    } catch (error) {
      const reason = String(error?.message || error || 'market_path_unavailable').slice(0, 96)
      marketData.trades[identity] = { status:'unavailable', reason }
      failures.push(`${identity}:${reason}`)
    }
  }
  if (failures.length || Object.keys(marketData.trades).length !== trades.length) {
    marketData.status = 'partial'
    marketData.reason = failures.join(',') || 'market_path_incomplete'
  }
  marketData.hash = sha256(marketData)
  return marketData
}

export async function listEligibleManualTrades(actor, params = {}, options = {}) {
  const account = options.account || await getCurrentManualReviewAccount(actor.id, params.trading_account_id)
  const safeSize = manualTradePageSize(params)
  // Keep one resolved range for every raw page in this request. The account
  // route and positions read are likewise reused; only the opaque cursor
  // advances as the bounded scan proceeds.
  let range = null
  try { range = options.history ? null : resolveRecentProfitableRange(params, options.nowUtcMsc) }
  catch (error) {
    return manualTradeUnavailable({ pageSize:safeSize, reason:error?.message || 'manual_trade_review_history_range_invalid',
      error:'manual_trade_review_history_range_invalid' })
  }
  let historyScope = manualTradeHistoryScope(account)
  if (!options.history && !params.history_snapshot_id && !params.cursor) {
    const prepared = await prepareManualTradeRange(account, range)
    historyScope = { ...historyScope,
      history_scope_note:prepared.history_scope_note || historyScope.history_scope_note,
      history_source_limited:prepared.history_source_limited ?? historyScope.history_source_limited }
    if (prepared.supported && !prepared.ready) {
      return manualTradeUnavailable({ pageSize:safeSize,
        reason:prepared.reason || 'history_cursor_range_incomplete', error:'manual_trade_review_evidence_unavailable',
        ...historyScope })
    }
  }
  let result = options.history || await bridgeHistory(account, params, { range })
  let historySnapshotId = result?.history_snapshot_id || params.history_snapshot_id || null
  let scannedSourcePages = 0
  let skippedEmptySourcePages = 0
  let positions = null
  const seenCursors = new Set()
  if (params.cursor) seenCursors.add(String(params.cursor))

  const filterSymbol = text(params.symbol).toLowerCase()
  const filterDirection = text(params.direction).toLowerCase()

  while (true) {
    scannedSourcePages += 1
    const enrichedPage = await enrichManualTradeHistoryPage(account, params, result, range)
    if (enrichedPage.unavailable) {
      return manualTradeUnavailable({ pageSize:safeSize, historySnapshotId,
        reason:enrichedPage.reason || 'history_evidence_unavailable',
        error:'manual_trade_review_evidence_unavailable', scannedSourcePages, skippedEmptySourcePages,
        ...historyScope })
    }
    result = enrichedPage.result || {}
    historyScope = { ...historyScope, ...manualTradeHistoryScope(account, historySyncFromPayload(result)) }
    const pageSnapshotId = result.history_snapshot_id || historySnapshotId || null
    if (historySnapshotId && pageSnapshotId && String(pageSnapshotId) !== String(historySnapshotId)) {
      return manualTradeUnavailable({ pageSize:safeSize, historySnapshotId,
        reason:'history_snapshot_changed', error:'manual_trade_review_history_snapshot_changed',
        scannedSourcePages, skippedEmptySourcePages, ...historyScope })
    }
    historySnapshotId = pageSnapshotId
    if (!result || result.status === 'error' || result.error) {
      return manualTradeUnavailable({ pageSize:safeSize, historySnapshotId,
        reason:result?.error || 'manual_trade_review_evidence_unavailable',
        error:'manual_trade_review_evidence_unavailable', scannedSourcePages, skippedEmptySourcePages, ...historyScope })
    }

    const refs = collectManualTradeEvidenceRefs(result)
    let systemReferences
    try {
      systemReferences = await findSystemReferences({ userId:actor.id, tradingAccountId:account.id, refs })
    } catch {
      return manualTradeUnavailable({ pageSize:safeSize, historySnapshotId,
        reason:'system_association_lookup_unavailable', error:'manual_trade_review_evidence_unavailable',
        scannedSourcePages, skippedEmptySourcePages, ...historyScope })
    }
    // Check global history/clock completeness before making the account
    // positions request. An unavailable source must stop here and must not
    // trigger any further page reads.
    const evidenceGate = buildEligibleManualTrades(result, { account, systemReferences, positions:[] })
    if (evidenceGate.evidence_status !== 'complete') {
      return manualTradeUnavailable({ pageSize:safeSize, historySnapshotId,
        reason:evidenceGate.evidence_reason || 'manual_trade_review_evidence_unavailable',
        error:'manual_trade_review_evidence_unavailable', scannedSourcePages, skippedEmptySourcePages, ...historyScope })
    }
    if (!positions) {
      const positionsResult = await mt5Bridge(actor.id, 'positions', { ...account.route }, { timeoutMs:15_000, noFallback:true, tradingAccountId:account.id })
      if (positionsResult?.status !== 'success') {
        return manualTradeUnavailable({ pageSize:safeSize, historySnapshotId,
          reason:'positions_unavailable', error:'manual_trade_review_evidence_unavailable',
          scannedSourcePages, skippedEmptySourcePages, ...historyScope })
      }
      positions = positionsResult.positions || []
    }
    const built = buildEligibleManualTrades(result, { account, systemReferences, positions })
    // History completeness, terminal clock trust, and evidence availability
    // are global gates. Never scan beyond a page that cannot prove them.
    if (built.evidence_status !== 'complete') {
      return manualTradeUnavailable({ pageSize:safeSize, historySnapshotId,
        reason:built.evidence_reason || 'manual_trade_review_evidence_unavailable',
        error:'manual_trade_review_evidence_unavailable', scannedSourcePages, skippedEmptySourcePages, ...historyScope })
    }
    const filtered = built.trades.filter(item => (!filterSymbol || text(item.symbol).toLowerCase() === filterSymbol)
      && (!filterDirection || item.direction === filterDirection)
      && (!range || (Number(item.close_time_utc_msc) >= range.range_start_utc_msc
        && Number(item.close_time_utc_msc) <= range.range_end_utc_msc)))
    const nextCursor = result.next_cursor || null
    const hasMore = result.has_more === true
    // A cursor page without an opaque continuation token cannot be safely
    // resumed, even when this page happened to contain an eligible trade.
    if (hasMore && (!historySnapshotId || !nextCursor)) {
      return manualTradeUnavailable({ pageSize:safeSize, historySnapshotId,
        reason:'history_cursor_unavailable', error:'manual_trade_review_history_cursor_unavailable',
        scannedSourcePages, skippedEmptySourcePages, ...historyScope })
    }
    // If the caller already supplied this cursor, accepting it again would
    // expose a continuation that loops back to the same source page.
    if (hasMore && seenCursors.has(String(nextCursor))) {
      return manualTradeUnavailable({ pageSize:safeSize, historySnapshotId,
        reason:'history_cursor_repeated', error:'manual_trade_review_history_cursor_repeated',
        scannedSourcePages, skippedEmptySourcePages, ...historyScope })
    }
    if (filtered.length) {
      // Keep the original cursor field names explicit for older callers:
      // history_snapshot_id:result.history_snapshot_id, next_cursor:result.next_cursor, has_more:hasMore.
      const visibleNext = hasMore && nextCursor ? nextCursor : null
      return { trades:filtered.slice(0, safeSize).map(item => ({ ...item, normalized:undefined })),
        pagination:{ page_size:safeSize, total:result.pagination?.total_count ?? filtered.length,
          history_snapshot_id:historySnapshotId, next_cursor:visibleNext, has_more:Boolean(visibleNext),
          range_start_utc_msc:range?.range_start_utc_msc || null, range_end_utc_msc:range?.range_end_utc_msc || null,
          scanned_source_pages:scannedSourcePages, skipped_empty_source_pages:skippedEmptySourcePages },
        history_snapshot_id:historySnapshotId, next_cursor:visibleNext, has_more:Boolean(visibleNext),
        range_start_utc_msc:range?.range_start_utc_msc || null, range_end_utc_msc:range?.range_end_utc_msc || null,
        scanned_source_pages:scannedSourcePages, skipped_empty_source_pages:skippedEmptySourcePages,
        unavailable:false, evidence_status:built.evidence_status, evidence_reason:null, excluded:built.excluded,
        ...historyScope }
    }

    skippedEmptySourcePages += 1
    // A cursor page without an opaque continuation token cannot be safely
    // resumed. Do not turn a truncated source into an apparently complete
    // empty list, and do not attempt a scan without a stable snapshot.
    if (!hasMore) {
      return { trades:[], pagination:{ page_size:safeSize, total:result.pagination?.total_count ?? 0,
          history_snapshot_id:historySnapshotId, next_cursor:null, has_more:false,
          range_start_utc_msc:range?.range_start_utc_msc || null, range_end_utc_msc:range?.range_end_utc_msc || null,
          scanned_source_pages:scannedSourcePages, skipped_empty_source_pages:skippedEmptySourcePages },
        history_snapshot_id:historySnapshotId, next_cursor:null, has_more:false,
        range_start_utc_msc:range?.range_start_utc_msc || null, range_end_utc_msc:range?.range_end_utc_msc || null,
        scanned_source_pages:scannedSourcePages, skipped_empty_source_pages:skippedEmptySourcePages,
        unavailable:false, evidence_status:built.evidence_status, evidence_reason:null, excluded:built.excluded,
        ...historyScope }
    }
    // Stop after a bounded number of raw pages. Returning the final cursor
    // lets the user explicitly continue searching without showing a dead
    // "next page" beside an empty result.
    if (scannedSourcePages >= MANUAL_TRADE_SOURCE_SCAN_MAX_PAGES) {
      return { trades:[], pagination:{ page_size:safeSize, total:0,
          history_snapshot_id:historySnapshotId, next_cursor:nextCursor, has_more:true,
          range_start_utc_msc:range?.range_start_utc_msc || null, range_end_utc_msc:range?.range_end_utc_msc || null,
          scanned_source_pages:scannedSourcePages, skipped_empty_source_pages:skippedEmptySourcePages },
        history_snapshot_id:historySnapshotId, next_cursor:nextCursor, has_more:true,
        range_start_utc_msc:range?.range_start_utc_msc || null, range_end_utc_msc:range?.range_end_utc_msc || null,
        scanned_source_pages:scannedSourcePages, skipped_empty_source_pages:skippedEmptySourcePages,
        unavailable:false, evidence_status:built.evidence_status, evidence_reason:null, excluded:built.excluded,
        ...historyScope }
    }
    const cursor = String(nextCursor)
    if (seenCursors.has(cursor)) {
      return manualTradeUnavailable({ pageSize:safeSize, historySnapshotId,
        reason:'history_cursor_repeated', error:'manual_trade_review_history_cursor_repeated',
        scannedSourcePages, skippedEmptySourcePages, ...historyScope })
    }
    seenCursors.add(cursor)
    try {
      result = await bridgeHistory(account, { ...params, history_snapshot_id:historySnapshotId, cursor }, { range })
    } catch {
      return manualTradeUnavailable({ pageSize:safeSize, historySnapshotId,
        reason:'history_page_unavailable', error:'manual_trade_review_evidence_unavailable',
        scannedSourcePages, skippedEmptySourcePages, ...historyScope })
    }
  }
}

export async function readManualTradeEvidence(actor, account, selected = [], options = {}) {
  if (!Array.isArray(selected) || !selected.length || selected.length > MANUAL_TRADE_SELECTION_MAX) {
    throw new Error('manual_trade_review_selection_invalid')
  }
  const selectedIdentities = selected.map(item => String(item?.source_identity_hash || item?.trade_id || '').trim())
  const selectedHashes = selected.map(item => String(item?.trade_source_hash || '').trim())
  if (selectedIdentities.some(value => !value) || new Set(selectedIdentities).size !== selectedIdentities.length
    || selectedHashes.some(value => !value) || new Set(selectedHashes).size !== selectedHashes.length) {
    throw new Error('manual_trade_review_selection_duplicate')
  }
  const references = selected.map(item => ({
    position_id:manualTradeReference(item?.position_id),
    entry_order_ticket:manualTradeReference(item?.entry_order_ticket),
  }))
  const positions = references.map(item => item.position_id).filter(Boolean)
  const orders = references.filter(item => !item.position_id).map(item => item.entry_order_ticket).filter(Boolean)
  if (!positions.length && !orders.length) {
    throw new Error('manual_trade_review_selection_reference_invalid')
  }
  const recentRange = resolveRecentProfitableRange({}, options.nowUtcMsc)
  if (!options.history && selected.some(item => Number(item.close_time_utc_msc) < recentRange.range_start_utc_msc
    || Number(item.close_time_utc_msc) > recentRange.range_end_utc_msc)) {
    throw new Error('manual_trade_review_source_changed')
  }
  if (!options.history) {
    const prepared = await prepareManualTradeRange(account, recentRange)
    if (prepared.supported && !prepared.ready) {
      throw new Error(prepared.reason || 'manual_trade_review_evidence_unavailable')
    }
  }
  const result = options.history || await bridgeHistory(account, {
    evidence_position_ids:positions, evidence_order_tickets:orders,
  }, { evidence:true, range:recentRange })
  if (!result || result.status === 'error' || result.error) {
    throw new Error(text(result?.error) || 'manual_trade_review_evidence_unavailable')
  }
  const refs = collectManualTradeEvidenceRefs(result)
  let systemReferences
  try { systemReferences = await findSystemReferences({ userId:actor.id, tradingAccountId:account.id, refs }) }
  catch { throw new Error('manual_trade_review_evidence_unavailable') }
  const positionsResult = await mt5Bridge(actor.id, 'positions', { ...account.route }, { timeoutMs:15_000, noFallback:true, tradingAccountId:account.id })
  if (positionsResult?.status !== 'success') throw new Error(text(positionsResult?.error) || 'manual_trade_review_evidence_unavailable')
  const built = buildEligibleManualTrades(result, { account, systemReferences, positions:positionsResult.positions || [] })
  if (built.evidence_status !== 'complete') throw new Error(built.evidence_reason || 'manual_trade_review_evidence_unavailable')
  const wanted = new Map(selected.map(item => [item.source_identity_hash || item.trade_id, item.trade_source_hash]))
  const matched = built.trades.filter(trade => wanted.has(trade.source_identity_hash))
  if (matched.length !== wanted.size) throw new Error('manual_trade_review_source_changed')
  for (const trade of matched) {
    const expected = wanted.get(trade.source_identity_hash)
    if (expected !== trade.trade_source_hash) throw new Error('manual_trade_review_source_changed')
  }
  const frozenTrades = matched.map(item => ({
    ...item.normalized, source_identity_hash:item.source_identity_hash, trade_source_hash:item.trade_source_hash,
  }))
  const marketData = await buildManualTradeMarketEvidence({ actor, account, trades:frozenTrades,
    strategySnapshot:options.strategySnapshot || {}, buildPath:options.buildPath || buildReviewMarketPath })
  const evidenceStatus = marketData.status === 'complete' ? 'complete' : 'partial'
  const historyScope = manualTradeHistoryScope(account, historySyncFromPayload(result))
  return { account:{ id:account.id, terminal_instance_id:account.terminal_instance_id,
    broker_server:account.broker_server, login_account:account.login_account },
    history_sync:result.history_sync || null, trades:frozenTrades,
    trade_source_hashes:matched.map(item => ({ source_identity_hash:item.source_identity_hash, trade_source_hash:item.trade_source_hash })),
    market_data:marketData, generated_at_utc_msc:Date.now(), timezone_offset_minutes:built.timezone_offset_minutes,
    clock_status:built.clock_status, evidence_status:evidenceStatus,
    evidence_reason:evidenceStatus === 'complete' ? null : 'market_evidence_incomplete', ...historyScope }
}

export { historySyncComplete, findSystemReferences, normalizeDeal, normalizeOrder }
