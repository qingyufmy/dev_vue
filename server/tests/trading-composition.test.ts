import { EventEmitter } from 'node:events'
import type { Pool } from 'mysql2/promise'
import type { Redis } from 'ioredis'
import { expect, it, vi } from 'vitest'
import type { AuthService } from '../src/modules/auth/index.js'
import { BROWSER_REALTIME_EVENT_CHANNEL, OBSERVER_CONTROL_CHANNEL } from '../src/modules/trading/index.js'
import { createTradingApiModule, createBridgeTradingModule, createBrowserTradingModule } from '../src/modules/trading/composition.js'

const leases = { current: async () => null }
it('keeps trade and administrator authentication scopes distinct in the API composition', async () => {
  const resolveSession = vi.fn(async (_cookie: unknown, client: string) => ({ user: { id: 7, role: client === 'admin-web' ? 'admin' : 'user' }, session: { id: 'session' } }))
  const assertCsrf = vi.fn()
  const auth = { cookieName: (client: string) => client + '-session', resolveSession, assertCsrf } as unknown as AuthService
  const module = createTradingApiModule({} as Pool, {} as Redis, auth, leases)
  const headers = { cookie: 'trade-web-session=trade-secret; admin-web-session=admin-secret', 'x-csrf-token': 'csrf', origin: 'https://admin.example.test' }
  expect(await module.tradeAuth.authenticate({ headers })).toEqual({ userId: 7, role: 'user' })
  expect(resolveSession).toHaveBeenLastCalledWith('trade-secret', 'trade-web')
  expect(await module.observerAdminAuth.assertWrite({ headers })).toEqual({ userId: 7, role: 'admin' })
  expect(resolveSession).toHaveBeenLastCalledWith('admin-secret', 'admin-web')
  expect(assertCsrf).toHaveBeenCalledWith('admin-secret', { id: 'session' }, 'csrf', 'https://admin.example.test')
})

it('gives the Bridge its purchased-capacity port without exposing database assembly to the entrypoint', async () => {
  const execute = vi.fn(async () => [[{ quantity: '3' }], []])
  const module = createBridgeTradingModule({ execute } as unknown as Pool, {} as Redis, leases, () => {})
  expect(await module.capacity.getPurchasedCapacity(7)).toBe(3)
  expect(execute).toHaveBeenCalledWith(expect.stringContaining('FROM bridge_connection_capacity_grants'), [7])
})

it('connects event and observer control channels to one hub and detaches them on close', async () => {
  class EventCache extends EventEmitter {
    subscribe = vi.fn(async () => 2)
    unsubscribe = vi.fn(async () => 0)
  }
  const cache = new EventCache(), onEvent = vi.fn(), onInvalid = vi.fn()
  const { hub, events } = createBrowserTradingModule({} as Pool, leases, cache as unknown as Redis, onEvent, onInvalid)
  const publish = vi.spyOn(hub, 'publish')
  await events.start()
  expect(cache.subscribe).toHaveBeenCalledWith(BROWSER_REALTIME_EVENT_CHANNEL, OBSERVER_CONTROL_CHANNEL)
  const event = { eventId: 'event-1', type: 'market.quote.updated', occurredAt: '2026-09-08T00:00:00.000Z', userId: 7,
    accountId: '8', terminalInstanceId: 'terminal-1', resource: 'market.quote', resourceId: 'XAUUSD', revision: 1, data: { bid: '3500' } }
  cache.emit('message', BROWSER_REALTIME_EVENT_CHANNEL, JSON.stringify(event))
  expect(publish).toHaveBeenCalledWith(event); expect(onEvent).toHaveBeenCalledOnce()
  cache.emit('message', BROWSER_REALTIME_EVENT_CHANNEL, 'invalid-json')
  expect(onInvalid).toHaveBeenCalledWith('browser_realtime_event_invalid')
  await events.close()
  cache.emit('message', BROWSER_REALTIME_EVENT_CHANNEL, JSON.stringify(event))
  expect(publish).toHaveBeenCalledOnce(); expect(cache.listenerCount('message')).toBe(0)
})
