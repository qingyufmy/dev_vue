import { publicCacheKey } from '../src/modules/market/application/public-market-snapshot.js'
import { readFileSync } from 'node:fs'
import Ajv from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { expect, it, vi } from 'vitest'
import { PublicMarketRelay } from '../src/modules/market/application/public-market-relay.js'
import { BrowserRealtimeSession } from '../src/modules/trading/transport/realtime/browser-realtime-session.js'
import { BrowserRealtimeHub } from '../src/modules/trading/transport/realtime/browser-realtime-hub.js'
import { parseBrowserRealtimeEvent } from '../src/modules/trading/infrastructure/redis-browser-realtime-subscriber.js'
import { publicMarketRealtimeEventSchema, publicMarketHistoryEventSchema } from '../../frontend/packages/contracts/src/index.ts'
const quote = { bid: '2500.00', ask: '2500.20', last: null, spread: '0.20', observed_at: '2026-09-14T00:00:00Z', revision: '2' }
it('delivers a small history invalidation only to the matching public period', async () => {
  const event = { eventId: 'history-ready', type: 'market.public.history.updated', occurredAt: '2026-09-14T00:00:00Z',
    userId: null, accountId: null, terminalInstanceId: null, resource: 'public_market', resourceId: 'XAUUSD:M5', revision: 2,
    data: { symbol: 'XAUUSD', timeframe: 'M5' } }
  const parsed = parseBrowserRealtimeEvent(JSON.stringify(event))!
  expect(parsed).not.toBeNull()
  expect(parseBrowserRealtimeEvent(JSON.stringify({ ...event, data: { ...event.data, accountId: 'secret' } }))).toBeNull()
  const hub = new BrowserRealtimeHub({} as never), sent: unknown[] = []
  const session = new BrowserRealtimeSession(99, hub, { send: value => sent.push(value), close: vi.fn() })
  await session.receive({ v: 4, type: 'subscription.subscribe', request_id: 'history', targets: [{ kind: 'market', trading_account_id: null,
    observer_channel_id: null, symbol: 'XAUUSD', timeframe: 'M5', resource_id: 'public_candle', after_revision: null }] })
  hub.publish(parsed)
  expect(publicMarketHistoryEventSchema.safeParse(sent.at(-1)).success).toBe(true)
  const ajv = new Ajv({ strict: false }); addFormats(ajv)
  const validate = ajv.compile(JSON.parse(readFileSync(new URL('../../contracts/realtime-v4.schema.json', import.meta.url), 'utf8')))
  expect(validate(sent.at(-1)), JSON.stringify(validate.errors)).toBe(true)
  session.close()
})
function fixture() {
  const source = { accountId: '20', ownerUserId: 1, connectionId: 'secret-route', connectionEpoch: 1 }
  const sources = { read: vi.fn().mockResolvedValue({ source, generation: 1, resolvedSymbol: 'XAUUSD.s' }), compareAndSet: vi.fn() }
  const snapshot = { symbol: 'XAUUSD', timeframe: 'M5' as const, source_key: publicCacheKey('XAUUSD', '20', 'XAUUSD.s'), source_generation: '1', status: 'cached' as const, quote, candles: [] }
  const snapshots = { read: vi.fn().mockResolvedValue(snapshot) }, publish = vi.fn().mockResolvedValue(undefined), failed = vi.fn()
  const relay = new PublicMarketRelay({ list: async () => ['XAUUSD'] }, sources, snapshots, publish, failed)
  const event = { eventId: 'raw-event', resource: 'market.quote', resourceId: 'XAUUSD.s', accountId: '20', userId: 1, revision: 2 }
  return { relay, sources, snapshots, snapshot, publish, failed, event }
}
it('reads authoritative public cache and never forwards account payloads', async () => {
  const f = fixture(); f.relay.accept({ ...f.event, data: { balance: 'secret' } } as typeof f.event); await f.relay.flush()
  const event = f.publish.mock.calls[0]![0]
  expect(event.data.quote.bid).toBe('2500.00')
  expect(event.accountId).toBeNull(); expect(event.userId).toBeNull()
  expect(JSON.stringify(event)).not.toMatch(/secret|XAUUSD.s|ownerUserId/)
  expect(parseBrowserRealtimeEvent(JSON.stringify(event))).not.toBeNull()
})
it('ignores private account updates even when they trade the same symbol', async () => {
  const f = fixture(); f.relay.accept({ ...f.event, accountId: '99', userId: 99 }); await f.relay.flush()
  expect(f.snapshots.read).not.toHaveBeenCalled(); expect(f.publish).not.toHaveBeenCalled()
})
it('drops a publication captured across a source-generation change', async () => {
  const f = fixture(); f.snapshots.read.mockResolvedValue({ ...f.snapshot, source_generation: '2' })
  f.relay.accept(f.event); await f.relay.flush(); expect(f.publish).not.toHaveBeenCalled()
})
it('does not relay superseded cache revisions', async () => {
  const f = fixture(); f.relay.accept({ ...f.event, revision: 1 }); await f.relay.flush(); expect(f.publish).not.toHaveBeenCalled()
})
it('broadcasts the public contract to authenticated users without source account identifiers', async () => {
  const f = fixture(); f.relay.accept(f.event); await f.relay.flush()
  const event = parseBrowserRealtimeEvent(JSON.stringify(f.publish.mock.calls[0]![0]))!
  const hub = new BrowserRealtimeHub({} as never), sent: unknown[] = []
  const session = new BrowserRealtimeSession(99, hub, { send: value => sent.push(value), close: vi.fn() })
  await session.receive({ v: 4, type: 'subscription.subscribe', request_id: 'public', targets: [{ kind: 'market', trading_account_id: null,
    observer_channel_id: null, symbol: 'XAUUSD', timeframe: null, resource_id: 'public_quote', after_revision: null }] })
  hub.publish(event)
  const publication = sent.at(-1)
  expect(publicMarketRealtimeEventSchema.safeParse(publication).success).toBe(true)
  const ajv = new Ajv({ strict: false }); addFormats(ajv)
  const validate = ajv.compile(JSON.parse(readFileSync(new URL('../../contracts/realtime-v4.schema.json', import.meta.url), 'utf8')))
  expect(validate(publication), JSON.stringify(validate.errors)).toBe(true)
  expect(validate({ ...(publication as object), scope: { user_id: '99', trading_account_id: '20', terminal_instance_id: null, observer_channel_id: null } })).toBe(false)
  session.close()
})
it('rejects public targets that smuggle an account scope', async () => {
  const close = vi.fn(), sent: unknown[] = []
  const session = new BrowserRealtimeSession(99, new BrowserRealtimeHub({} as never), { send: value => sent.push(value), close })
  await session.receive({ v: 4, type: 'subscription.subscribe', request_id: 'public', targets: [{ kind: 'market', trading_account_id: '20',
    observer_channel_id: null, symbol: 'XAUUSD', timeframe: null, resource_id: 'public_quote', after_revision: null }] })
  expect(sent.at(-1)).toMatchObject({ type: 'protocol.error' })
  session.close()
})
