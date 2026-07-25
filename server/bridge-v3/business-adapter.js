import { createHash, randomUUID } from 'node:crypto'

import { queryAll, queryOne } from '../db.js'

const SYSTEM_MAGIC = 234000
const READ_ACTIONS = new Set([
  'account', 'positions', 'pending_list', 'system_trade_inventory', 'market_state',
])
const TRADE_ACTIONS = new Set([
  'open', 'pending', 'close', 'cancel_pending', 'close_system_position', 'cancel_system_pending',
  'modify_system_position_protection',
])
const SUPPORTED_ACTIONS = new Set([
  ...READ_ACTIONS, ...TRADE_ACTIONS, 'quote', 'rates', 'symbol_snapshot', 'risk_snapshot',
  'performance_daily', 'order_lookup',
  'toggle_trade', 'set_quote_symbol',
])
const RATE_TIMEFRAMES = new Set(['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1'])
const DEFAULT_FRESHNESS_MS = 30_000

function adapterError(code) {
  return Object.assign(new Error(code), { code })
}

function parsePayload(value) {
  if (value && typeof value === 'object') return value
  try {
    const parsed = JSON.parse(String(value || ''))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function cleanObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined))
}

function routeMatchesParams(route, params) {
  if (params.terminal_instance_id && params.terminal_instance_id !== route.terminal_instance_id) return false
  const requested = params.account_ref || {}
  const broker = params.broker_server ?? requested.broker_server
  const login = params.login ?? params.account_login ?? requested.login
  if (broker && String(broker).trim().toLowerCase()
    !== String(route.account_ref.broker_server).trim().toLowerCase()) return false
  if (login && String(login).trim() !== String(route.account_ref.login).trim()) return false
  return true
}

function routeSelectionParams(params) {
  const expected = params.expected_state && typeof params.expected_state === 'object'
    ? params.expected_state : {}
  return {
    ...params,
    broker_server:params.broker_server ?? expected.broker_server_key,
    login:params.login ?? params.account_login ?? expected.login_account,
  }
}

function routeParams(route) {
  return {
    terminal_instance_id:route.terminal_instance_id,
    account_ref:route.account_ref,
    connection_epoch:route.connection_epoch,
  }
}

function normalizePosition(item, platform) {
  const ticket = String(item.ticket ?? item.position_id ?? '')
  const type = typeof item.type === 'string'
    ? item.type
    : Number(item.type) === 0 ? 'buy' : 'sell'
  const identifier = String(item.identifier ?? item.position_id ?? ticket)
  return {
    ...item,
    ticket,
    position_id:identifier,
    identifier,
    type,
    volume:Number(item.volume ?? 0),
    open_price:Number(item.open_price ?? item.price_open ?? 0),
    price_open:Number(item.price_open ?? item.open_price ?? 0),
    price_current:Number(item.price_current ?? 0),
    sl:Number(item.sl ?? item.stop_loss ?? 0),
    tp:Number(item.tp ?? item.take_profit ?? 0),
    source:platform,
  }
}

function pendingKind(type) {
  if (typeof type === 'string') return type
  return ({ 2:'buy_limit', 3:'sell_limit', 4:'buy_stop', 5:'sell_stop',
    6:'buy_stop_limit', 7:'sell_stop_limit' })[Number(type)] || String(type ?? 'unknown')
}

function normalizeOrder(item, platform) {
  const kind = item.pending_type || pendingKind(item.type)
  const side = item.side || (String(kind).startsWith('buy') ? 'buy' : 'sell')
  return {
    ...item,
    ticket:String(item.ticket ?? item.order_id ?? ''),
    side,
    pending_type:kind,
    price:Number(item.price ?? item.price_open ?? 0),
    volume:Number(item.volume ?? item.volume_current ?? item.volume_initial ?? 0),
    sl:Number(item.sl ?? item.stop_loss ?? 0),
    tp:Number(item.tp ?? item.take_profit ?? 0),
    mt5_ticket:String(item.ticket ?? item.order_id ?? ''),
    state:'pending',
    source:platform,
  }
}

function tradeParams(action, params) {
  if (action === 'open') {
    return cleanObject({
      symbol:params.symbol,
      side:params.side ?? params.type ?? params.order_type,
      order_kind:'market',
      volume:params.volume,
      stop_loss:params.stop_loss ?? params.sl,
      take_profit:params.take_profit ?? params.tp,
      deviation:params.deviation,
      magic:params.magic,
    })
  }
  if (action === 'pending') {
    const legacyType = String(params.type ?? params.order_type ?? '').trim().toLowerCase()
    const [side, ...kindParts] = legacyType.split('_')
    return cleanObject({
      symbol:params.symbol,
      side,
      order_kind:kindParts.join('_'),
      volume:params.volume,
      price:params.price,
      stop_loss:params.stop_loss ?? params.sl,
      take_profit:params.take_profit ?? params.tp,
      stop_limit_price:params.stop_limit_price ?? params.stoplimit_price,
      deviation:params.deviation,
      magic:params.magic,
      expiration:params.expiration,
      type_time:params.expiration ? 2 : undefined,
    })
  }
  if (action === 'close' || action === 'close_system_position') {
    const expected = params.expected_state || {}
    return cleanObject({
      ticket:params.ticket,
      volume:params.volume,
      deviation:params.deviation,
      magic:action === 'close_system_position' ? SYSTEM_MAGIC : undefined,
      symbol:action === 'close_system_position' ? expected.symbol : undefined,
      side:action === 'close_system_position' ? expected.direction : undefined,
      expected_state:params.expected_state,
    })
  }
  if (action === 'modify_system_position_protection') {
    const expected = params.expected_state || {}
    return cleanObject({
      ticket:params.ticket,
      symbol:expected.symbol,
      side:expected.direction,
      volume:expected.volume,
      magic:SYSTEM_MAGIC,
      stop_loss:params.stop_loss,
      take_profit:params.take_profit,
      expected_stop_loss:expected.stop_loss,
      expected_take_profit:expected.take_profit,
      expected_state:params.expected_state,
    })
  }
  const expected = params.expected_state || {}
  return cleanObject({
    ticket:params.ticket,
    volume:action === 'cancel_system_pending' ? expected.volume : undefined,
    magic:action === 'cancel_system_pending' ? SYSTEM_MAGIC : undefined,
    symbol:action === 'cancel_system_pending' ? expected.symbol : undefined,
    side:action === 'cancel_system_pending' ? expected.direction : undefined,
    expected_state:params.expected_state,
  })
}

function v3Action(action) {
  return ({ open:'place_order', pending:'place_order', close:'close_position',
    cancel_pending:'cancel_order', close_system_position:'close_position',
    cancel_system_pending:'cancel_order', modify_system_position_protection:'modify_position' })[action]
}

function commandId(userId, route, action, params) {
  const correlation = String(params.operation_id || params.comment || '').trim()
  if (!correlation) return `command_${randomUUID()}`
  const hash = createHash('sha256')
    .update(`${Number(userId)}\n${route.terminal_instance_id}\n${action}\n${correlation}`)
    .digest('hex')
  return `command_${hash}`
}

function legacyTradeResult(action, result, params = {}) {
  if (result?.status === 'queued') {
    return { status:'error', error:result.error || 'bridge_command_queued', message:result.error || 'bridge_command_queued' }
  }
  if (result?.status === 'uncertain') {
    return { status:'uncertain', error:result.error || 'bridge_command_uncertain',
      message:result.error || 'bridge_command_uncertain', command_id:result.command_id }
  }
  const evidence = result?.evidence || {}
  const raw = result?.raw_result || {}
  const orderTicket = evidence.order_tickets?.[0] ?? raw.order ?? null
  const positionTicket = evidence.position_tickets?.[0] ?? raw.position ?? orderTicket
  const dealTicket = evidence.deal_tickets?.[0] ?? raw.deal ?? null
  const ticket = action === 'open' ? positionTicket : orderTicket ?? positionTicket
  const retcode = evidence.broker_retcode ?? raw.broker_retcode ?? raw.retcode ?? null
  if (result?.status === 'succeeded') {
    const expected = params.expected_state || {}
    return cleanObject({
      status:'success', command_id:result.command_id, ticket,
      order:orderTicket, position_id:positionTicket, deal:dealTicket,
      price:raw.price, retcode,
      already_absent:raw.already_absent === true || result?.error_message === 'already_absent'
        ? true : undefined,
      stop_loss:action === 'modify_system_position_protection'
        ? Number(raw.stop_loss ?? params.stop_loss ?? expected.stop_loss ?? 0) : undefined,
      take_profit:action === 'modify_system_position_protection'
        ? Number(raw.take_profit ?? params.take_profit ?? expected.take_profit ?? 0) : undefined,
      already_applied:raw.already_applied === true || result?.error_message === 'already_applied'
        ? true : undefined,
    })
  }
  return cleanObject({
    status:result?.status === 'rejected' ? 'rejected' : 'error',
    command_id:result?.command_id,
    error:result?.error_code || result?.error || 'bridge_command_failed',
    message:result?.error_message || result?.error_code || result?.error || 'bridge_command_failed',
    retcode,
  })
}

function rejectedManagementResult(code, ticket) {
  return { status:'rejected', error:code, message:code, ticket:String(ticket || '') }
}

function requiredExpectedStateError(expected) {
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)) {
    return 'management_expected_state_required'
  }
  if (!String(expected.ticket || '').trim()) return 'management_expected_ticket_required'
  if (!String(expected.symbol || '').trim()) return 'management_expected_symbol_required'
  const direction = String(expected.direction || '').trim().toLowerCase()
  if (!['buy', 'sell'].includes(direction)) return 'management_expected_direction_invalid'
  if (expected.magic == null) return 'management_expected_magic_required'
  const volume = Number(expected.volume)
  if (!Number.isFinite(volume) || volume <= 0 || !Number.isInteger(Number(expected.magic))) {
    return 'management_expected_state_invalid'
  }
  return null
}

function targetDirection(target, kind) {
  if (kind === 'position') return String(target.type || '').trim().toLowerCase()
  return String(target.side || target.pending_type || target.type || '').trim().toLowerCase()
    .replace(/_.*/, '')
}

function managementPreconditionError(expected, target, kind, route) {
  const requiredError = requiredExpectedStateError(expected)
  if (requiredError) return requiredError
  if (expected.broker_server_key
    && String(expected.broker_server_key).trim().toUpperCase()
      !== String(route.account_ref.broker_server).trim().toUpperCase()) {
    return 'management_account_server_mismatch'
  }
  if (expected.login_account
    && String(expected.login_account).trim() !== String(route.account_ref.login).trim()) {
    return 'management_account_login_mismatch'
  }
  if (String(expected.ticket).trim() !== String(target.ticket).trim()) return 'management_ticket_mismatch'
  if (String(expected.symbol).trim() !== String(target.symbol).trim()) return 'management_symbol_mismatch'
  if (Number(expected.magic) !== Number(target.magic)) return 'management_magic_mismatch'
  if (Math.abs(Number(expected.volume) - Number(target.volume)) > 1e-8) return 'management_volume_mismatch'
  if (String(expected.direction).trim().toLowerCase() !== targetDirection(target, kind)) {
    return 'management_direction_mismatch'
  }
  return null
}

function protectionPreconditionError(expected, target) {
  for (const [field, code] of [
    ['stop_loss', 'position_expected_stop_loss_invalid'],
    ['take_profit', 'position_expected_take_profit_invalid'],
  ]) {
    if (expected[field] == null) continue
    const value = Number(expected[field])
    if (!Number.isFinite(value) || value < 0) return code
    if (Math.abs(Number(target[field === 'stop_loss' ? 'sl' : 'tp'] || 0) - value) > 1e-8) {
      return field === 'stop_loss' ? 'position_stop_loss_changed' : 'position_take_profit_changed'
    }
  }
  return null
}

export function createBridgeV3BusinessAdapter({
  gateway,
  queryOneFn = queryOne,
  queryAllFn = queryAll,
  now = () => Date.now(),
  freshnessMs = DEFAULT_FRESHNESS_MS,
} = {}) {
  if (!gateway) throw new TypeError('bridge_v3_gateway_required')

  function connectedTerminals(userId) {
    return gateway.listConnectedTerminals(Number(userId))
  }

  function selectRoute(userId, params = {}) {
    const routes = connectedTerminals(userId).filter(route => routeMatchesParams(route, params))
    if (!routes.length) throw adapterError('bridge_terminal_not_connected')
    if (routes.length > 1) throw adapterError('bridge_terminal_ambiguous')
    return routes[0]
  }

  async function assertFreshStream(route, stream) {
    const revision = await queryOneFn(`SELECT revision, observed_at_utc_msc
      FROM bridge_v3_stream_revisions
      WHERE terminal_instance_id = ? AND connection_epoch = ? AND stream = ? LIMIT 1`,
    [route.terminal_instance_id, route.connection_epoch, stream])
    if (!revision) throw adapterError('bridge_snapshot_unavailable')
    if (now() - Number(revision.observed_at_utc_msc || 0) > freshnessMs) {
      throw adapterError('bridge_snapshot_stale')
    }
    return revision
  }

  async function readAccount(route) {
    await assertFreshStream(route, 'account')
    const row = await queryOneFn(`SELECT payload_json FROM bridge_v3_account_latest
      WHERE terminal_instance_id = ? AND connection_epoch = ? LIMIT 1`,
    [route.terminal_instance_id, route.connection_epoch])
    const account = parsePayload(row?.payload_json)
    if (!account) throw adapterError('bridge_account_snapshot_invalid')
    return { status:'success', ...account, terminal_connected:true, source:route.platform }
  }

  async function readCollection(route, action, params) {
    const stream = action === 'positions' ? 'positions' : 'orders'
    await assertFreshStream(route, stream)
    const table = stream === 'positions' ? 'bridge_v3_positions_latest' : 'bridge_v3_orders_latest'
    const rows = await queryAllFn(`SELECT payload_json FROM ${table}
      WHERE terminal_instance_id = ? AND connection_epoch = ? ORDER BY ticket ASC`,
    [route.terminal_instance_id, route.connection_epoch])
    const items = rows.map(row => parsePayload(row.payload_json))
    if (items.some(item => !item)) throw adapterError(`bridge_${stream}_snapshot_invalid`)
    const symbol = String(params.symbol || '').trim()
    const filtered = symbol ? items.filter(item => item.symbol === symbol) : items
    if (stream === 'positions') {
      const positions = filtered.map(item => normalizePosition(item, route.platform))
      return { status:'success', positions, count:positions.length, source:route.platform }
    }
    return { status:'success', orders:filtered.map(item => normalizeOrder(item, route.platform)), source:route.platform }
  }

  async function readSystemInventory(route) {
    const [accountResult, positionsResult, pendingResult] = await Promise.all([
      readAccount(route),
      readCollection(route, 'positions', {}),
      readCollection(route, 'pending_list', {}),
    ])
    const marginMode = route.platform === 'mt5' ? Number(accountResult.margin_mode ?? -1) : -1
    return {
      status:'success',
      account:{
        login:String(accountResult.login ?? route.account_ref.login),
        server:String(accountResult.server ?? route.account_ref.broker_server),
        margin_mode:marginMode,
        is_hedging:route.platform === 'mt4' || marginMode === 2,
      },
      magic:SYSTEM_MAGIC,
      positions:positionsResult.positions.filter(item => Number(item.magic || 0) === SYSTEM_MAGIC),
      pending_orders:pendingResult.orders.filter(item => Number(item.magic || 0) === SYSTEM_MAGIC),
      source:route.platform,
    }
  }

  async function prepareSystemManagement(route, action, params) {
    const expected = params.expected_state
    const requiredError = requiredExpectedStateError(expected)
    if (requiredError) return { result:rejectedManagementResult(requiredError, params.ticket) }
    const kind = action === 'cancel_system_pending' ? 'pending' : 'position'
    const collection = await readCollection(route, kind === 'position' ? 'positions' : 'pending_list', {})
    const items = kind === 'position' ? collection.positions : collection.orders
    const target = items.find(item => String(item.ticket) === String(params.ticket))
    if (!target) {
      if (action === 'modify_system_position_protection') {
        return { result:rejectedManagementResult('system_position_not_found', params.ticket) }
      }
      return { result:{ status:'success', ticket:String(params.ticket), already_absent:true } }
    }
    const preconditionError = managementPreconditionError(expected, target, kind, route)
    if (preconditionError) {
      return { result:rejectedManagementResult(preconditionError, target.ticket) }
    }
    if (Number(target.magic || 0) !== SYSTEM_MAGIC) {
      return { result:rejectedManagementResult(
        kind === 'position' ? 'position_magic_mismatch' : 'pending_magic_mismatch', target.ticket) }
    }
    if (action === 'modify_system_position_protection') {
      const protectionError = protectionPreconditionError(expected, target)
      if (protectionError) return { result:rejectedManagementResult(protectionError, target.ticket) }
      if (params.stop_loss == null && params.take_profit == null) {
        return { result:rejectedManagementResult('protection_price_required', target.ticket) }
      }
      for (const value of [params.stop_loss, params.take_profit]) {
        if (value != null && (!Number.isFinite(Number(value)) || Number(value) <= 0)) {
          return { result:rejectedManagementResult('protection_price_invalid', target.ticket) }
        }
      }
    }
    return { params:{ ...params, ticket:target.ticket, volume:kind === 'position' ? target.volume : undefined } }
  }

  async function requestQuote(userId, route, params, timeoutMs) {
    const symbol = String(params.symbol || '').trim()
    if (!symbol || symbol.length > 64) throw adapterError('symbol_invalid')
    const request = {
      v:3,
      type:'quote_request',
      message_id:`message_${randomUUID()}`,
      sent_at_utc_msc:now(),
      request_id:`quote_${randomUUID()}`,
      ...routeParams(route),
      symbol,
    }
    const result = await gateway.requestQuote(userId, request, { timeoutMs:Math.min(timeoutMs, 30_000) })
    if (result.status !== 'succeeded') {
      return { status:'error', error:result.error_code, message:result.error_code }
    }
    return {
      status:'success', symbol:result.symbol, bid:result.bid, ask:result.ask,
      spread:result.ask - result.bid, last:result.last ?? null,
      observed_at_utc_msc:result.observed_at_utc_msc,
      time:new Date(result.observed_at_utc_msc).toISOString(), source:route.platform,
      symbol_trade_mode:result.symbol_trade_mode ?? null,
      terminal_connected:result.terminal_connected ?? true,
    }
  }

  async function requestRates(userId, route, params, timeoutMs) {
    const symbol = String(params.symbol || '').trim()
    const timeframe = String(params.timeframe || 'M30').trim().toUpperCase()
    const count = Number(params.count ?? 100)
    const startUtcMsc = Number(params.start_utc_msc || 0)
    const endUtcMsc = Number(params.end_utc_msc || 0)
    if (!symbol || symbol.length > 64) throw adapterError('symbol_invalid')
    if (!RATE_TIMEFRAMES.has(timeframe)) throw adapterError('rates_timeframe_invalid')
    if (!Number.isSafeInteger(count) || count < 2 || count > 5_000) throw adapterError('rates_count_invalid')
    if ((!Number.isSafeInteger(startUtcMsc) || startUtcMsc < 0)
      || (!Number.isSafeInteger(endUtcMsc) || endUtcMsc < 0)
      || ((startUtcMsc > 0 || endUtcMsc > 0) && !(startUtcMsc > 0 && endUtcMsc > startUtcMsc))) {
      throw adapterError('rates_range_invalid')
    }
    const request = {
      v:3, type:'data_request', message_id:`message_${randomUUID()}`, sent_at_utc_msc:now(),
      request_id:`data_${randomUUID()}`, ...routeParams(route), action:'rates',
      params:cleanObject({ symbol, timeframe, count,
        start_utc_msc:startUtcMsc || undefined, end_utc_msc:endUtcMsc || undefined }),
    }
    const result = await gateway.requestData(userId, request, { timeoutMs:Math.min(timeoutMs, 30_000) })
    if (result.status !== 'succeeded') {
      return { status:'error', error:result.error_code, message:result.error_code }
    }
    return { ...result.payload, status:'success', source:result.payload.source || route.platform }
  }

  async function requestSymbolSnapshot(userId, route, params, timeoutMs) {
    const symbol = String(params.symbol || '').trim()
    if (!symbol || symbol.length > 64) throw adapterError('symbol_invalid')
    const request = {
      v:3, type:'data_request', message_id:`message_${randomUUID()}`, sent_at_utc_msc:now(),
      request_id:`data_${randomUUID()}`, ...routeParams(route), action:'symbol_snapshot',
      params:{ symbol },
    }
    const result = await gateway.requestData(userId, request, { timeoutMs:Math.min(timeoutMs, 30_000) })
    if (result.status !== 'succeeded') {
      return { status:'error', error:result.error_code, message:result.error_code }
    }
    return { ...result.payload, status:'success', source:result.payload.source || route.platform }
  }

  async function requestRiskSnapshot(userId, route, params, timeoutMs) {
    const symbol = String(params.symbol || '').trim()
    const lastDealTimeMsc = Number(params.last_deal_time_msc || 0)
    const lastDealTicket = Number(params.last_deal_ticket || 0)
    const baselineFromUtcMsc = Number(params.baseline_from_utc_msc || 0)
    if (!symbol || symbol.length > 64) throw adapterError('symbol_invalid')
    if (![lastDealTimeMsc, lastDealTicket, baselineFromUtcMsc]
      .every(value => Number.isSafeInteger(value) && value >= 0)) {
      throw adapterError('risk_snapshot_cursor_invalid')
    }
    let proposedOrder
    if (params.proposed_order != null) {
      if (!params.proposed_order || typeof params.proposed_order !== 'object'
        || Array.isArray(params.proposed_order)) throw adapterError('risk_snapshot_proposed_order_invalid')
      const proposedSymbol = String(params.proposed_order.symbol || '').trim()
      const orderType = String(params.proposed_order.order_type || '').trim().toLowerCase()
      const volume = Number(params.proposed_order.volume)
      const entryPrice = Number(params.proposed_order.entry_price)
      const stopLoss = Number(params.proposed_order.sl)
      if (!proposedSymbol || proposedSymbol.length > 64
        || !['buy', 'sell', 'buy_limit', 'sell_limit', 'buy_stop', 'sell_stop',
          'buy_stop_limit', 'sell_stop_limit'].includes(orderType)
        || !Number.isFinite(volume) || volume <= 0
        || !Number.isFinite(entryPrice) || entryPrice <= 0
        || !Number.isFinite(stopLoss) || stopLoss <= 0) {
        throw adapterError('risk_snapshot_proposed_order_invalid')
      }
      proposedOrder = { symbol:proposedSymbol, order_type:orderType, volume,
        entry_price:entryPrice, sl:stopLoss }
    }
    const request = {
      v:3, type:'data_request', message_id:`message_${randomUUID()}`, sent_at_utc_msc:now(),
      request_id:`data_${randomUUID()}`, ...routeParams(route), action:'risk_snapshot',
      params:cleanObject({ symbol, last_deal_time_msc:lastDealTimeMsc,
        last_deal_ticket:lastDealTicket, baseline_from_utc_msc:baselineFromUtcMsc,
        proposed_order:proposedOrder }),
    }
    const result = await gateway.requestData(userId, request, { timeoutMs:Math.min(timeoutMs, 30_000) })
    if (result.status !== 'succeeded') {
      return { status:'error', error:result.error_code, message:result.error_code }
    }
    return { ...result.payload, status:'success', source:result.payload.source || route.platform }
  }

  async function requestPerformanceDaily(userId, route, params, timeoutMs) {
    const dateFrom = String(params.date_from || '').slice(0, 10)
    const dateTo = String(params.date_to || '').slice(0, 10)
    const start = Date.parse(`${dateFrom}T00:00:00.000Z`)
    const end = Date.parse(`${dateTo}T00:00:00.000Z`)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateFrom) || !/^\d{4}-\d{2}-\d{2}$/.test(dateTo)
      || !Number.isFinite(start) || !Number.isFinite(end)) {
      throw adapterError('performance_date_range_required')
    }
    if (end < start) throw adapterError('performance_date_range_invalid')
    if (end - start > 30 * 24 * 60 * 60 * 1000) {
      throw adapterError('performance_date_range_too_large')
    }
    const request = {
      v:3, type:'data_request', message_id:`message_${randomUUID()}`, sent_at_utc_msc:now(),
      request_id:`data_${randomUUID()}`, ...routeParams(route), action:'performance_daily',
      params:{ date_from:dateFrom, date_to:dateTo },
    }
    const result = await gateway.requestData(userId, request, { timeoutMs:Math.min(timeoutMs, 30_000) })
    if (result.status !== 'succeeded') {
      return { status:'error', error:result.error_code, message:result.error_code }
    }
    return { ...result.payload, status:'success', source:result.payload.source || route.platform }
  }

  async function requestMarketState(userId, route, params, timeoutMs) {
    const checkedAt = now()
    const quote = await requestQuote(userId, route, params, timeoutMs)
    const observedAt = Number(quote.observed_at_utc_msc || 0)
    const tickAgeMs = observedAt > 0 ? Math.max(0, checkedAt - observedAt) : null
    const terminalConnected = quote.terminal_connected !== false
    const tradeMode = quote.symbol_trade_mode != null && Number.isInteger(Number(quote.symbol_trade_mode))
      ? Number(quote.symbol_trade_mode) : null
    let state = 'unknown'
    let reason = quote.status === 'success' ? 'trade_mode_unavailable' : quote.error || 'quote_unavailable'
    if (!terminalConnected) reason = 'terminal_disconnected'
    else if (quote.status === 'success' && tickAgeMs > 120_000) {
      state = 'stale'
      reason = 'tick_stale'
    } else if (quote.status === 'success' && tradeMode === 0) {
      state = 'closed'
      reason = 'symbol_trade_disabled'
    } else if (quote.status === 'success' && [1, 2, 3].includes(tradeMode)) {
      state = 'restricted'
      reason = 'symbol_trade_restricted'
    } else if (quote.status === 'success' && (tradeMode === 4 || route.platform === 'mt4')) {
      state = 'open'
      reason = 'quote_fresh'
    }
    return {
      status:'success',
      market_state_version:1,
      market_state:state,
      market_reason:reason,
      market_checked_at_utc_msc:checkedAt,
      symbol:String(quote.symbol || params.symbol || ''),
      symbol_trade_mode:tradeMode,
      terminal_connected:terminalConnected,
      tick_progressing:state === 'open',
      tick_unchanged_seconds:null,
      tick_age_seconds:tickAgeMs == null ? null : tickAgeMs / 1000,
      source:route.platform,
    }
  }

  async function assertTradeEnabled(userId) {
    const row = await queryOneFn(`SELECT u.role, s.trade_send_enabled
      FROM users u LEFT JOIN user_bridge_settings s ON s.user_id = u.id
      WHERE u.id = ? LIMIT 1`, [Number(userId)])
    const enabled = String(row?.role || '').toLowerCase() === 'admin'
      ? row?.trade_send_enabled == null || Number(row.trade_send_enabled) === 1
      : Number(row?.trade_send_enabled) === 1
    if (!enabled) throw adapterError('bridge_trade_disabled')
  }

  async function executeTrade(userId, route, action, params, timeoutMs, options = {}) {
    if (route.initial_sync_ready !== true) throw adapterError('bridge_terminal_initializing')
    if (options.expectedGeneration != null
      && Number(route.connection_generation) !== Number(options.expectedGeneration)) {
      throw adapterError('Bridge generation changed before command write')
    }
    await assertTradeEnabled(userId)
    const issuedAt = now()
    const command = {
      v:3,
      type:'command',
      message_id:`message_${randomUUID()}`,
      sent_at_utc_msc:issuedAt,
      command_id:commandId(userId, route, action, params),
      ...routeParams(route),
      issued_at_utc_msc:issuedAt,
      deadline_utc_msc:issuedAt + Math.max(1_000, Math.min(timeoutMs, 30_000)),
      action:v3Action(action),
      params:tradeParams(action, params),
    }
    if (typeof options.beforeWrite === 'function') {
      let allowed
      try {
        allowed = await options.beforeWrite({
          commandId:command.command_id,
          bridgeGeneration:Number(route.connection_generation),
          userId:Number(userId),
          action,
        })
      } catch (error) {
        throw adapterError(`Bridge command write blocked: ${error.message}`)
      }
      if (allowed === false) throw adapterError('Bridge command write blocked')
    }
    const currentRoute = selectRoute(userId, {
      terminal_instance_id:route.terminal_instance_id,
      account_ref:route.account_ref,
    })
    if (Number(currentRoute.connection_generation) !== Number(route.connection_generation)
      || Number(currentRoute.connection_epoch) !== Number(route.connection_epoch)) {
      throw adapterError('Bridge generation changed before command write')
    }
    return legacyTradeResult(action, await gateway.sendCommand(userId, command, { timeoutMs }), params)
  }

  async function executeOrderLookup(userId, route, params, timeoutMs) {
    const symbol = String(params.symbol || '').trim()
    const expectedKind = String(params.expected_kind || '').trim().toLowerCase()
    const bridgeCommandRef = String(params.bridge_command_ref || params.comment || '').trim()
    const tradeTicket = String(params.trade_ticket || '').trim()
    const pendingTicket = String(params.pending_ticket || '').trim()
    const ticket = String(params.ticket || '').trim()
    const lookbackSeconds = Number(params.lookback_seconds || 172_800)
    if (symbol.length > 64) throw adapterError('symbol_invalid')
    if (!['trade', 'pending'].includes(expectedKind)) throw adapterError('expected_kind_required')
    if (!bridgeCommandRef && !tradeTicket && !pendingTicket && !ticket) {
      throw adapterError('bridge_reference_required')
    }
    if (bridgeCommandRef.length > 64
      || !Number.isSafeInteger(lookbackSeconds)
      || lookbackSeconds < 3_600 || lookbackSeconds > 315_360_000) {
      throw adapterError('order_lookup_params_invalid')
    }
    for (const value of [tradeTicket, pendingTicket, ticket]) {
      if (value && !/^\d{1,32}$/.test(value)) throw adapterError('order_lookup_ticket_invalid')
    }
    const issuedAt = now()
    const lookupTimeoutMs = Math.max(1_000, Math.min(timeoutMs, 30_000))
    const command = {
      v:3, type:'command', message_id:`message_${randomUUID()}`, sent_at_utc_msc:issuedAt,
      command_id:`command_${randomUUID()}`, ...routeParams(route),
      issued_at_utc_msc:issuedAt,
      deadline_utc_msc:issuedAt + lookupTimeoutMs,
      action:'query_execution',
      params:cleanObject({ symbol:symbol || undefined, expected_kind:expectedKind,
        bridge_command_ref:bridgeCommandRef || undefined,
        trade_ticket:tradeTicket || undefined, pending_ticket:pendingTicket || undefined,
        ticket:ticket || undefined, lookback_seconds:lookbackSeconds }),
    }
    const result = await gateway.sendCommand(userId, command, { timeoutMs:lookupTimeoutMs })
    if (result?.status !== 'succeeded') {
      const code = result?.error_code || result?.error || 'bridge_execution_lookup_failed'
      return { status:result?.status === 'uncertain' ? 'uncertain' : 'error', error:code, message:code }
    }
    const raw = result.raw_result
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { status:'error', error:'bridge_execution_lookup_invalid', message:'bridge_execution_lookup_invalid' }
    }
    return { ...raw, status:'success' }
  }

  async function execute(userId, action, params = {}, options = {}) {
    const timeoutMs = options.timeoutMs ?? 5_000
    if (!SUPPORTED_ACTIONS.has(action)) throw adapterError('bridge_v3_action_unsupported')
    try {
      if (action === 'toggle_trade') {
        if (typeof params.enable !== 'boolean') throw adapterError('trade_toggle_boolean_required')
        if (!connectedTerminals(userId).length) throw adapterError('bridge_terminal_not_connected')
        gateway.setTradeEnabled(userId, params.enable)
        return { status:'success', live_trading_enabled:params.enable }
      }
      if (action === 'set_quote_symbol') {
        const symbol = String(params.symbol || '').trim()
        if (!symbol || symbol.length > 64) throw adapterError('symbol_invalid')
        if (!connectedTerminals(userId).length) throw adapterError('bridge_terminal_not_connected')
        return { status:'success', symbol }
      }
      const route = selectRoute(userId, routeSelectionParams(params))
      if (action === 'account') return await readAccount(route)
      if (action === 'system_trade_inventory') return await readSystemInventory(route)
      if (action === 'market_state') return await requestMarketState(userId, route, params, timeoutMs)
      if (READ_ACTIONS.has(action)) return await readCollection(route, action, params)
      if (action === 'quote') return await requestQuote(userId, route, params, timeoutMs)
      if (action === 'rates') return await requestRates(userId, route, params, timeoutMs)
      if (action === 'symbol_snapshot') {
        return await requestSymbolSnapshot(userId, route, params, timeoutMs)
      }
      if (action === 'risk_snapshot') return await requestRiskSnapshot(userId, route, params, timeoutMs)
      if (action === 'performance_daily') {
        return await requestPerformanceDaily(userId, route, params, timeoutMs)
      }
      if (action === 'order_lookup') return await executeOrderLookup(userId, route, params, timeoutMs)
      if (action === 'close_system_position' || action === 'cancel_system_pending'
        || action === 'modify_system_position_protection') {
        const prepared = await prepareSystemManagement(route, action, params)
        if (prepared.result) return prepared.result
        params = prepared.params
      }
      return await executeTrade(userId, route, action, params, timeoutMs, options)
    } catch (error) {
      const code = error?.code || error?.message || 'bridge_v3_request_failed'
      return { status:'error', error:code, message:code }
    }
  }

  return {
    supports:action => SUPPORTED_ACTIONS.has(action),
    hasConnectedTerminal:userId => connectedTerminals(userId).length > 0,
    isTradeEnabled:userId => gateway.isTradeEnabled(Number(userId)),
    disconnectUser:(userId, reason) => gateway.disconnectUser?.(Number(userId), reason) || 0,
    connectedTerminals,
    connectedUsers:() => gateway.listConnectedUsers?.() || [],
    getGeneration:userId => {
      const generations = new Set(connectedTerminals(userId).map(route => Number(route.connection_generation)))
      return generations.size === 1 ? generations.values().next().value : null
    },
    execute,
    selectRoute,
  }
}
