import { positionDto } from './position-dto.js'
import type { ContextWritePort } from '../../application/context-write-port.js'
import type { ContextWriteReceipt } from '../../domain/context-write.js'
import { parseContextRevision } from './trading-context-input.js'
import { createTradingHttpContract } from './trading-http-contract.js'
import type { FastifyPluginAsync } from 'fastify'
import type { ConnectionCapacityService, TradingService } from '../../application/trading-service.js'
import { TradingAccessError } from '../../domain/trading.js'
import type { AccountSnapshot, MarketCandle, MarketQuote, ObserverChannelSummary, OpenPosition, PendingOrder, TerminalProfileSummary, TradingAccountSummary, TradingContext } from '../../domain/trading.js'
import type { TradingAccountAccess } from '../../application/trading-ports.js'

import type { TradeRequestAuthenticator } from '../../application/request-authentication.js'

export interface TradingRoutesOptions {
  service: TradingService
  contextCommands: ContextWritePort
  capacity: ConnectionCapacityService
  auth: TradeRequestAuthenticator
}

function response(requestId: string, data: unknown) {
  return { data, meta: { request_id: requestId, generated_at: new Date().toISOString() } }
}

const contextDto = (value: TradingContext) => ({ user_id: String(value.userId), mode: value.mode, account_id: value.accountId, observer_channel_id: value.observerChannelId, read_only: value.readOnly, revision: String(value.revision) })
const receiptDto = (value: ContextWriteReceipt) => ({ request_id: value.requestId, action: value.action, target_id: value.targetId, prior_revision: String(value.priorRevision), result: contextDto(value.result), recorded_at: value.recordedAt, replayed: value.replayed })
const accountDto = (value: TradingAccountSummary) => ({ id: value.id, platform: value.platform, login: value.login, server: value.server, currency: value.currency, terminal_profile_id: value.terminalProfileId, terminal_instance_id: value.terminalInstanceId, bridge_state: value.bridgeState, trade_permission: value.tradePermission, last_seen_at: value.lastSeenAt })
const snapshotDto = (value: AccountSnapshot) => ({ ...accountDto(value), balance: value.balance, equity: value.equity, margin: value.margin, free_margin: value.freeMargin, floating_profit: value.floatingProfit, leverage: value.leverage, timezone_offset_minutes: value.timezoneOffsetMinutes, clock_status: value.clockStatus, observed_at: value.observedAt, revision: String(value.revision) })
const quoteDto = (value: MarketQuote) => ({ account_id: value.accountId, symbol: value.symbol, bid: value.bid, ask: value.ask, last: value.last, spread: value.spread, trade_mode: value.tradeMode, observed_at: value.observedAt, revision: String(value.revision) })
const candleDto = (value: MarketCandle) => ({ account_id: value.accountId, symbol: value.symbol, timeframe: value.timeframe, open_time: value.openTime, open: value.open, high: value.high, low: value.low, close: value.close, tick_volume: value.tickVolume, closed: value.closed, revision: String(value.revision) })
const orderDto = (value: PendingOrder) => ({ ticket: value.ticket, account_id: value.accountId, symbol: value.symbol, type: value.type, volume: value.volume, price: value.price, stop_loss: value.stopLoss, take_profit: value.takeProfit, created_at: value.createdAt, expires_at: value.expiresAt, source: value.source, signal_id: value.signalId, revision: String(value.revision) })
const profileDto = (value: TerminalProfileSummary) => ({ id: value.id, display_name: value.displayName, platform: value.platform, installation_id: value.installationId, account_id: value.accountId, connection_state: value.connectionState, last_seen_at: value.lastSeenAt })
const observerDto = (value: ObserverChannelSummary) => ({ id: value.id, display_name: value.displayName, source_account_id: value.sourceAccountId, active: value.active })

export const tradingRoutes: FastifyPluginAsync<TradingRoutesOptions> = async (fastify, options) => {
  const contract = createTradingHttpContract()
  fastify.get('/trading-context', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    try { const { userId } = await options.auth.authenticate(request); contract.request('getTradingContext', request); return contract.response('getTradingContext', response(request.id, contextDto(await options.service.context(userId)))) }
    catch (error) { return contract.problem('getTradingContext', error, request, reply) }
  })
  fastify.put<{ Body: { account_id?: string; observer_channel_id?: string; mode: 'full' | 'observer'; expected_revision?: string } }>('/trading-context', async (request, reply) => {
    try {
      const { userId } = await options.auth.assertWrite(request)
      contract.request('replaceTradingContext', request)
      const expected = parseContextRevision(request.body.expected_revision)
      const receipt = await options.contextCommands.execute({ userId, requestId: String(request.headers['idempotency-key']),
        action: request.body.mode === 'observer' ? 'enter_observer' : 'select_account',
        targetId: request.body.mode === 'observer' ? String(request.body.observer_channel_id) : String(request.body.account_id), expectedRevision: expected })
      return contract.contextWriteResponse('replaceTradingContext', () => response(request.id, contextDto(receipt.result)))
    } catch (error) { return contract.problem('replaceTradingContext', error, request, reply) }
  })
  fastify.delete<{ Querystring: { expected_revision?: string } }>('/trading-context/observer', async (request, reply) => {
    try {
      const { userId } = await options.auth.assertWrite(request)
      contract.request('leaveObserverMode', request)
      const expected = parseContextRevision(request.query.expected_revision)
      const receipt = await options.contextCommands.execute({ userId, requestId: String(request.headers['idempotency-key']), action: 'leave_observer', targetId: null, expectedRevision: expected })
      return contract.contextWriteResponse('leaveObserverMode', () => response(request.id, contextDto(receipt.result)))
    } catch (error) { return contract.problem('leaveObserverMode', error, request, reply) }
  })
  fastify.get<{ Params: { request_id: string } }>('/trading-context/commands/:request_id', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    try {
      const { userId } = await options.auth.authenticate(request)
      contract.request('getTradingContextReceipt', request)
      const receipt = await options.contextCommands.receipt(userId, request.params.request_id)
      if (receipt && (receipt.result.userId !== userId || receipt.requestId !== request.params.request_id)) throw new TradingAccessError('trading_context_receipt_unavailable', 503)
      return contract.response('getTradingContextReceipt', response(request.id, receipt ? receiptDto(receipt) : null))
    } catch (error) { return contract.problem('getTradingContextReceipt', error, request, reply) }
  })
  fastify.get<{ Querystring: { access?: TradingAccountAccess } }>('/trading-accounts', async (request, reply) => {
    try { const { userId } = await options.auth.authenticate(request); contract.request('listTradingAccounts', request); return contract.response('listTradingAccounts', response(request.id, { items: (await options.service.listAccounts(userId, request.query.access)).map(accountDto) })) }
    catch (error) { return contract.problem('listTradingAccounts', error, request, reply) }
  })
  fastify.get('/bridge/connection-capacity', async (request, reply) => {
    try { const { userId } = await options.auth.authenticate(request); contract.request('getBridgeConnectionCapacity', request); return contract.response('getBridgeConnectionCapacity', response(request.id, await options.capacity.summary(userId))) }
    catch (error) { return contract.problem('getBridgeConnectionCapacity', error, request, reply) }
  })
  fastify.get('/bridge/terminal-profiles', async (request, reply) => {
    try { const { userId } = await options.auth.authenticate(request); contract.request('listTerminalProfiles', request); return contract.response('listTerminalProfiles', response(request.id, { items: (await options.service.listTerminalProfiles(userId)).map(profileDto) })) }
    catch (error) { return contract.problem('listTerminalProfiles', error, request, reply) }
  })
  fastify.get('/observer-channels', async (request, reply) => {
    try { const { userId } = await options.auth.authenticate(request); contract.request('listObserverChannels', request); return contract.response('listObserverChannels', response(request.id, { items: (await options.service.listObserverChannels(userId)).map(observerDto) })) }
    catch (error) { return contract.problem('listObserverChannels', error, request, reply) }
  })
  fastify.get<{ Params: { account_id: string }; Querystring: { observer_channel_id?: string } }>('/trading-accounts/:account_id/snapshot', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    try {
      const { userId } = await options.auth.authenticate(request)
      contract.request('getTradingAccountSnapshot', request)
      const data = await options.service.workspace(userId, request.params.account_id, request.query.observer_channel_id)
      return contract.response('getTradingAccountSnapshot', response(request.id, { account: accountDto(data.account), snapshot: data.snapshot ? snapshotDto(data.snapshot) : null, symbols: data.symbols, positions: { revision: String(data.positions.revision), items: data.positions.items.map(positionDto) }, pending_orders: { revision: String(data.pendingOrders.revision), items: data.pendingOrders.items.map(orderDto) } }))
    }
    catch (error) { return contract.problem('getTradingAccountSnapshot', error, request, reply) }
  })
  fastify.get<{ Params: { symbol: string }; Querystring: { account_id: string; observer_channel_id?: string } }>('/market/quotes/:symbol', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    try { const { userId } = await options.auth.authenticate(request); contract.request('getMarketQuote', request); const data = await options.service.quote(userId, request.query.account_id, request.params.symbol, request.query.observer_channel_id); return contract.response('getMarketQuote', response(request.id, data ? quoteDto(data) : null)) }
    catch (error) { return contract.problem('getMarketQuote', error, request, reply) }
  })
  fastify.get<{ Querystring: { account_id: string; symbol: string; timeframe: string; page_size?: string; observer_channel_id?: string } }>('/market/candles', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    try {
      const { userId } = await options.auth.authenticate(request)
      contract.request('listMarketCandles', request)
      const items = await options.service.candles(userId, request.query.account_id, request.query.symbol, request.query.timeframe, Number(request.query.page_size ?? 200), request.query.observer_channel_id)
      return contract.response('listMarketCandles', response(request.id, { items: items.map(candleDto) }))
    } catch (error) { return contract.problem('listMarketCandles', error, request, reply) }
  })
}
