import { assertSymbol } from '../src/modules/trading/domain/trading.js'
import { readFileSync } from 'node:fs'
import Ajv2020 from 'ajv/dist/2020.js'
import { describe, expect, it, vi } from 'vitest'
import type { Redis } from 'ioredis'
import { RedisBridgeMarketDemandSubscriber } from '../src/modules/bridge/infrastructure/redis-bridge-market-demand-subscriber.js'
import { RedisMarketDemandPublisher } from '../src/modules/trading/infrastructure/redis-market-demand-publisher.js'
import { parseBridgeMarketDemand } from '../src/shared/bridge-market-demand.js'
import { BridgeTradeProjectionDecoder, type BridgeGatewayRoute, type BridgeStreamEventEnvelope } from '../src/modules/bridge/index.js'
const route: BridgeGatewayRoute = { platform: 'mt5', timezoneOffsetMinutes: 180, userId: 42, accountId: '7', terminalProfileId: 'profile_12345678', terminalInstanceId: 'terminal_12345678', brokerServer: 'Demo', login: '10001', connectionEpoch: 2, connectionId: 'connection_12345678', sessionId: 'session_12345678' }
const demand = () => ({ v: 1, id: 'subscription-123', userId: 42, expiresAt: Date.now() + 90_000, targets: [{ accountId: '7', symbol: 'XAUUSD.s', timeframe: 'M5' }] })
describe('market demand leases', () => {
  it('rejects unbounded or ambiguous scopes', () => {
    expect(parseBridgeMarketDemand(demand())).not.toBeNull()
    expect(parseBridgeMarketDemand({ ...demand(), targets: Array(17).fill(demand().targets[0]) })).toBeNull()
    expect(parseBridgeMarketDemand({ ...demand(), targets: [{ ...demand().targets[0], symbol: '*' }] })).toBeNull()
    expect(parseBridgeMarketDemand({ ...demand(), targets: [{ ...demand().targets[0], timeframe: 'W1' }] })).toBeNull()
  })
  it('renews one id, cancels it once, and never revives a closed lease', async () => {
    const publish = vi.fn(async () => 1)
    const lease = new RedisMarketDemandPublisher({ publish } as never).create(42, demand().targets)
    await lease.renew(); await lease.renew(); lease.close(); lease.close(); await lease.renew()
    const frames = publish.mock.calls.map(call => JSON.parse((call as unknown as string[])[1]!))
    expect(frames).toHaveLength(3); expect(frames[0].id).toBe(frames[1].id); expect(frames[2].expiresAt).toBe(0)
  })
  it('checks ownership, authorization and the route again before forwarding; reconnect uses the new epoch', async () => {
    const send = vi.fn(), current = vi.fn(async () => route), isAuthorized = vi.fn(async () => true)
    const gateway = new RedisBridgeMarketDemandSubscriber({} as Redis, { current } as never, { isAuthorized }, { get: () => ({ send, close() {} }) } as never)
    await gateway.apply(JSON.stringify(demand()))
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'stream.subscribe', route: expect.objectContaining({ connection_epoch: 2 }), payload: expect.objectContaining({ filter: expect.objectContaining({ symbol: 'XAUUSD.s', timeframe: 'M5' }) }) }))
    send.mockClear(); await gateway.apply(JSON.stringify({ ...demand(), userId: 43 })); expect(send).not.toHaveBeenCalled()
    isAuthorized.mockResolvedValueOnce(false); await gateway.apply(JSON.stringify(demand())); expect(send).not.toHaveBeenCalled()
    current.mockResolvedValueOnce(route).mockResolvedValueOnce({ ...route, connectionId: 'replaced' }); await gateway.apply(JSON.stringify(demand())); expect(send).not.toHaveBeenCalled()
    current.mockResolvedValue({ ...route, connectionId: 'new-route', connectionEpoch: 3 }); await gateway.apply(JSON.stringify(demand()))
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ route: expect.objectContaining({ connection_epoch: 3 }) }))
    await gateway.apply(JSON.stringify({ ...demand(), expiresAt: 0 })); expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'stream.unsubscribe' }))
  })
})
function event(stream: 'quotes' | 'current_candle', row: Record<string, unknown>): BridgeStreamEventEnvelope {
 return { v: 4, type: 'stream.event', message_id: 'message_12345678', sent_at_utc_msc: Date.now(), correlation_id: null, route: { terminal_instance_id: route.terminalInstanceId, account_ref: { broker_server: route.brokerServer, login: route.login }, connection_epoch: route.connectionEpoch }, payload: { stream, subscription_id: 'market-12345678', revision: Date.now(), base_revision: 0, full_snapshot: true, observed_at_utc_msc: Date.now(), source_time_msc: null, upserts: [row], deletes: [] } }
}
describe('normalized live market facts', () => {
 const decoder = new BridgeTradeProjectionDecoder()
 const quote = () => ({ symbol: 'XAUUSD.s', bid: '4300.12', ask: '4300.32', last: null, spread: '0.2', time_utc_msc: Date.now() - 2000 })
 it('uses route identity and preserves actual quote time', async () => {
  const row = quote(); const result = await decoder.decode(route, event('quotes', row))
  expect(result).toMatchObject({ resource: 'market.quote', data: { accountId: '7', symbol: 'XAUUSD.s', observedAt: new Date(row.time_utc_msc).toISOString(), tradeMode: 'unknown' } })
  await expect(decoder.decode(route, event('quotes', { ...row, account_id: '8' }))).rejects.toThrow()
  await expect(decoder.decode(route, event('quotes', { ...row, bid: '99999999999999999' }))).rejects.toThrow()
  const stale = event('quotes', row); stale.payload.observed_at_utc_msc -= 61_000; await expect(decoder.decode(route, stale)).rejects.toThrow()
 })
 it('accepts current candles without falsely closing them; rejects inconsistent OHLC', async () => {
  const row = { symbol: 'XAUUSD.s', timeframe: 'M5', open_time_utc_msc: Date.now() - 1000, open: '4300', high: '4301', low: '4299', close: '4300.5', tick_volume: '123', closed: false }
  expect(await decoder.decode(route, event('current_candle', row))).toMatchObject({ resource: 'market.candle', data: { closed: false, timeframe: 'M5' } })
  await expect(decoder.decode(route, event('current_candle', { ...row, high: '4200' }))).rejects.toThrow()
 })
})

const bridgeSchema = JSON.parse(readFileSync(new URL('../../contracts/bridge-v4.schema.json', import.meta.url), 'utf8'))
const validateEvent = new Ajv2020({ strict: false }).compile({ $ref: '#/$defs/StreamEvent', $defs: bridgeSchema.$defs })
it('validates market producer frames against the machine contract', () => {
 const value = event('quotes', { symbol: 'XAUUSD.s', bid: '4300', ask: '4301', last: null, spread: '1', time_utc_msc: Date.now() })
 expect(validateEvent(value), JSON.stringify(validateEvent.errors)).toBe(true)
 value.payload.upserts[0]!.account_id = '8'
 expect(validateEvent(value)).toBe(false)
})
const demandSchema = JSON.parse(readFileSync(new URL('../../contracts/bridge-market-demand-v1.schema.json', import.meta.url), 'utf8'))
const validateDemand = new Ajv2020({ strict: false }).compile(demandSchema)
it('keeps internal demand producer and consumer contracts aligned', () => {
 for (const value of [demand(), { ...demand(), expiresAt: 0 }, { ...demand(), expiresAt: -1 }, { ...demand(), userId: 0 }, { ...demand(), targets: [{ ...demand().targets[0], symbol: '*' }] }]) {
  expect(validateDemand(value)).toBe(parseBridgeMarketDemand(value) !== null)
 }
})

it('preserves broker symbol suffix case in HTTP market lookup', () => { expect(assertSymbol(' XAUUSD.s ')).toBe('XAUUSD.s'); expect(assertSymbol('EURUSDm')).toBe('EURUSDm'); expect(() => assertSymbol('*')).toThrow() })
