import { createHash, randomUUID } from 'node:crypto'

import { queryAll, queryOne } from '../db.js'

const READ_ACTIONS = new Set(['account', 'positions', 'pending_list'])
const TRADE_ACTIONS = new Set(['open', 'pending', 'close', 'cancel_pending'])
const SUPPORTED_ACTIONS = new Set([
  ...READ_ACTIONS, ...TRADE_ACTIONS, 'quote', 'toggle_trade', 'set_quote_symbol',
])
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
  if (action === 'close') {
    return cleanObject({ ticket:params.ticket, volume:params.volume, deviation:params.deviation })
  }
  return { ticket:params.ticket }
}

function v3Action(action) {
  return ({ open:'place_order', pending:'place_order', close:'close_position',
    cancel_pending:'cancel_order' })[action]
}

function commandId(userId, route, action, params) {
  const correlation = String(params.operation_id || params.comment || '').trim()
  if (!correlation) return `command_${randomUUID()}`
  const hash = createHash('sha256')
    .update(`${Number(userId)}\n${route.terminal_instance_id}\n${action}\n${correlation}`)
    .digest('hex')
  return `command_${hash}`
}

function legacyTradeResult(action, result) {
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
    return cleanObject({
      status:'success', command_id:result.command_id, ticket,
      order:orderTicket, position_id:positionTicket, deal:dealTicket,
      price:raw.price, retcode,
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
    return legacyTradeResult(action, await gateway.sendCommand(userId, command, { timeoutMs }))
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
      const route = selectRoute(userId, params)
      if (action === 'account') return await readAccount(route)
      if (READ_ACTIONS.has(action)) return await readCollection(route, action, params)
      if (action === 'quote') return await requestQuote(userId, route, params, timeoutMs)
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
