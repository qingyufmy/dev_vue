import type { BridgeProjectionInput } from '../../trading/index.js'
import { BridgeGatewayError, type BridgeGatewayRoute } from '../domain/bridge-gateway.js'
import type { BridgeStreamEventEnvelope } from './bridge-stream-ingestor.js'

export function decodeMarketProjection(route: BridgeGatewayRoute, event: BridgeStreamEventEnvelope): BridgeProjectionInput {
  const p = event.payload
  if (!p.full_snapshot || p.deletes.length || p.upserts.length !== 1 || p.observed_at_utc_msc < Date.now() - 60_000 || p.observed_at_utc_msc > Date.now() + 15_000) invalid()
  const row = p.upserts[0]!
  const symbol = typeof row.symbol === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(row.symbol) ? row.symbol : invalid()
  const base = { accountId: route.accountId, symbol, revision: p.revision }
  if (p.stream === 'quotes') {
    exact(row, ['symbol', 'bid', 'ask', 'last', 'spread', 'time_utc_msc'])
    const bid = decimal(row.bid), ask = decimal(row.ask)
    if (Number(ask) < Number(bid)) invalid()
    const observedAt = utc(row.time_utc_msc)
    if (Date.parse(observedAt) > p.observed_at_utc_msc + 15_000) invalid()
    return { resource: 'market.quote', resourceId: symbol, revision: p.revision,
      data: { ...base, bid, ask, last: row.last === null ? null : decimal(row.last), spread: decimal(row.spread, true), tradeMode: 'unknown', observedAt } }
  }
  exact(row, ['symbol', 'timeframe', 'open_time_utc_msc', 'open', 'high', 'low', 'close', 'tick_volume', 'closed'])
  const timeframe = row.timeframe
  if (timeframe !== 'M1' && timeframe !== 'M5' && timeframe !== 'M15' && timeframe !== 'M30' && timeframe !== 'H1' && timeframe !== 'H4' && timeframe !== 'D1') invalid()
  const openTime = utc(row.open_time_utc_msc)
  const open = decimal(row.open), high = decimal(row.high), low = decimal(row.low), close = decimal(row.close)
  if (Number(low) > Math.min(Number(open), Number(close)) || Number(high) < Math.max(Number(open), Number(close)) || Date.parse(openTime) > p.observed_at_utc_msc || typeof row.closed !== 'boolean' || typeof row.tick_volume !== 'string' || !/^(0|[1-9][0-9]{0,18})$/.test(row.tick_volume)) invalid()
  return { resource: 'market.candle', resourceId: `${symbol}:${timeframe}`, revision: p.revision,
    data: { ...base, timeframe, openTime, open, high, low, close, tickVolume: row.tick_volume, closed: row.closed } }
}
function exact(row: Record<string, unknown>, keys: string[]) { if (Object.keys(row).length !== keys.length || keys.some(key => !(key in row))) invalid() }
function decimal(value: unknown, zero = false): string {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,15})(\.[0-9]{1,8})?$/.test(value) || (!zero && Number(value) <= 0)) invalid()
  return value
}
function utc(value: unknown): string { if (!Number.isSafeInteger(value) || Number(value) <= 0 || Number(value) > 8_640_000_000_000_000) invalid(); return new Date(Number(value)).toISOString() }
function invalid(): never { throw new BridgeGatewayError('bridge_market_stream_invalid', 400) }
