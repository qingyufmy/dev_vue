import type { FastifyPluginAsync } from 'fastify'
import type { TerminalMarketService } from '../../application/terminal-market-service.js'
import type { TradeRequestAuthenticator } from '../../application/request-authentication.js'
import { createTradingHttpContract } from './trading-http-contract.js'
export const terminalMarketRoutes: FastifyPluginAsync<{ service: TerminalMarketService; auth: TradeRequestAuthenticator }> = async (app, { service, auth }) => {
 const contract = createTradingHttpContract()
 const response = (id: string, data: unknown) => ({ data, meta: { request_id: id, generated_at: new Date().toISOString() } })
 app.get<{ Querystring: { account_id: string; cursor?: string } }>('/market/symbols', async (request, reply) => {
  reply.header('Cache-Control', 'no-store')
  try { const { userId } = await auth.authenticate(request); contract.request('listTerminalMarketSymbols', request)
   return contract.response('listTerminalMarketSymbols', response(request.id, await service.symbols(userId, request.query.account_id, request.query.cursor ?? null)))
  } catch (error) { return contract.problem('listTerminalMarketSymbols', error, request, reply) }
 })
 app.get<{ Querystring: { account_id: string; symbol: string; timeframe: string; before: string; page_size?: string } }>('/market/terminal-window', async (request, reply) => {
  reply.header('Cache-Control', 'no-store')
  try { const { userId } = await auth.authenticate(request); contract.request('getTerminalMarketWindow', request)
   const result = await service.candles(userId, request.query.account_id, request.query.symbol, request.query.timeframe, Number(request.query.before), Number(request.query.page_size ?? 200))
   const items = result.items.map(c => ({ account_id: c.accountId, symbol: c.symbol, timeframe: c.timeframe, open_time: c.openTime, open: c.open, high: c.high, low: c.low, close: c.close, tick_volume: c.tickVolume, closed: c.closed, revision: String(c.revision) }))
   return contract.response('getTerminalMarketWindow', response(request.id, { items, before: String(result.before), structure: result.structure }))
  } catch (error) { return contract.problem('getTerminalMarketWindow', error, request, reply) }
 })
}
