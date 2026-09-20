import type { Redis } from 'ioredis'
import { MARKET_READ_CHANNEL, MARKET_READ_REPLY, MARKET_MINUTES, parseMarketRead } from '../../../shared/bridge-market-read.js'
import type { BridgeGatewayLeaseStore } from '../application/bridge-gateway-ports.js'
import type { BridgeGatewayQueryTransport } from '../application/bridge-gateway-query-transport.js'
export class RedisBridgeMarketReadSubscriber {
 private active = 0
 private stopped = false
 constructor(private readonly listener: Redis, private readonly writer: Redis, private readonly leases: BridgeGatewayLeaseStore, private readonly queries: Pick<BridgeGatewayQueryTransport, 'queryMarket' | 'queryInstrument'>) {}
 async start() { this.listener.on('message', this.receive); await this.listener.subscribe(MARKET_READ_CHANNEL) }
 async close() { this.stopped = true; this.listener.off('message', this.receive); await this.listener.unsubscribe(MARKET_READ_CHANNEL) }
 private readonly receive = (channel: string, raw: string) => {
  if (this.stopped || channel !== MARKET_READ_CHANNEL || raw.length > 8192 || this.active >= 32) return
  this.active++; void this.apply(raw).catch(() => {}).finally(() => { this.active-- })
 }
 async apply(raw: string) {
  let input; try { input = parseMarketRead(JSON.parse(raw)) } catch { return }
  if (!input || input.deadline <= Date.now() || input.deadline > Date.now() + 21_000) return
  const key = MARKET_READ_REPLY + input.id
  let response: unknown
  try {
   const route = await this.leases.current(input.accountId)
   if (!route || route.userId !== input.userId) throw Error('route_unavailable')
   const params = input.kind === 'symbols' ? { limit: input.limit, cursor: input.cursor } : { symbol: input.symbol, timeframe: input.timeframe,
    range_start_utc_msc: Number(input.before) - MARKET_MINUTES[input.timeframe!]! * 60_000 * (input.limit - 1), range_end_utc_msc: input.before, limit: input.limit, cursor: null }
   const result = input.kind === 'instrument'
    ? await this.queries.queryInstrument({ route, symbol: input.symbol!, timeoutMs: Math.max(1000, input.deadline - Date.now()) })
    : await this.queries.queryMarket({ route, resource: input.kind === 'symbols' ? 'market.symbols' : 'market.candles', params, timeoutMs: Math.max(1000, input.deadline - Date.now()) })
   if ((await this.leases.current(input.accountId))?.connectionId !== route.connectionId || Date.now() > input.deadline) throw Error('route_changed')
   response = { id: input.id, page: { items: result.payload.items, nextCursor: result.payload.next_cursor, observedAt: result.payload.observed_at_utc_msc } }
  } catch (error) {
   const code = (error as { code?: string }).code
   console.warn('[bridge-market-read]', input.kind, typeof code === 'string' && /^[a-z0-9_]{3,100}$/.test(code) ? code : 'market_read_failed')
   const errorCode = code === 'bridge_query_inflight' ? 'terminal_market_busy'
    : ['symbol_not_found', 'symbol_unavailable', 'symbol_ambiguous'].includes(code ?? '') ? 'terminal_market_symbol_unsupported' : 'terminal_market_unavailable'
   response = { id: input.id, error: errorCode }
  }
  await this.writer.multi().lpush(key, JSON.stringify(response)).expire(key, 30).exec()
 }
}
