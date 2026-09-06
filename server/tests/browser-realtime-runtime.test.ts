import Fastify from 'fastify'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { EventEmitter } from 'node:events'
import type { Redis } from 'ioredis'
import { WebSocket } from 'ws'
import { afterEach, describe, expect, it } from 'vitest'
import { RealtimeTicketAuthenticator, type AuthRepository, type RealtimeTicketStore } from '../src/modules/auth/index.js'
import {
  BrowserRealtimeHub, RedisBrowserRealtimeSubscriber, parseBrowserRealtimeEvent,
  type BrowserRealtimeEvent, type TradingReadRepository, type TradingRealtimeEvent,
} from '../src/modules/trading/index.js'
import { BrowserRealtimeWebSocketServer } from '../src/transport/browser-realtime-websocket-server.js'
import { exactTradeHostHook, exactAdminHostHook, registerApiV4Routes, type ApiV4RouteServices } from '../src/transport/api-v4-route-registrar.js'

const closers: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close() })

describe('V4 browser realtime runtime', () => {
  it('atomically consumes a ticket and rechecks its active trade session', async () => {
    let consumed = false
    const tickets = { async consumeTicket() { if (consumed) return null; consumed = true; return { userId: 7, sessionId: 9, clientId: 'trade-web' as const } } } as Pick<RealtimeTicketStore, 'consumeTicket'>
    const repository = {
      async findActiveSessionById() { return { id: 9, userId: 7, clientId: 'trade-web' as const, parentSessionId: null, authTimeUtc: new Date(), mfaLevel: 'none' as const, sessionVersion: 3, idleExpiresAtUtc: null, absoluteExpiresAtUtc: new Date(Date.now() + 60_000), revokedAtUtc: null } },
      async findUserById() { return { id: 7, displayName: 'trader', avatarUrl: null, role: 'user', passwordHash: '', sessionVersion: 3, active: true } },
    } as Pick<AuthRepository, 'findActiveSessionById' | 'findUserById'>
    const auth = new RealtimeTicketAuthenticator(repository, tickets)
    expect(await auth.consume('rt_ticket')).toMatchObject({ userId: 7, sessionId: 9 })
    expect(await auth.consume('rt_ticket')).toBeNull()
  })

  it('validates committed Redis events before publishing them to the local hub', async () => {
    const redis = new FakeRedis()
    const published: BrowserRealtimeEvent[] = []
    const invalid: string[] = []
    const subscriber = new RedisBrowserRealtimeSubscriber(redis as unknown as Redis, { publish(event) { published.push(event) }, invalidateObserverAuthorization() {} }, undefined, code => invalid.push(code))
    await subscriber.start()
    const event = realtimeEvent()
    redis.emit('message', 'aurum:v4:browser-realtime:events', JSON.stringify(event))
    redis.emit('message', 'aurum:v4:browser-realtime:events', JSON.stringify({ ...event, resource: 'positions' }))
    expect(published).toEqual([event])
    expect(invalid).toEqual(['browser_realtime_event_invalid'])
    expect(parseBrowserRealtimeEvent('{broken')).toBeNull()
    await subscriber.close()
    expect(redis.unsubscribed).toBe(true)
  })

  it('delivers user-scoped distribution operations without inventing an account scope', async () => {
    const messages: unknown[] = []
    const hub = new BrowserRealtimeHub(repository())
    const unsubscribe = await hub.subscribeTargets({
      userId: 42,
      requestId: 'distribution-operations',
      targets: [{
        accountId: null,
        observerChannelId: null,
        resources: ['operation'],
        afterRevision: { operation: null },
        publicTarget: { kind: 'operations', trading_account_id: null, observer_channel_id: null, resource_id: 'all' },
      }],
      sink: { send(message) { messages.push(message) }, close() { throw new Error('unexpected_close') } },
    })
    hub.publish({
      eventId: 'distribution-operation-1', type: 'operation.changed', occurredAt: '2026-09-04T08:00:00.000Z',
      userId: 42, accountId: null, terminalInstanceId: null, resource: 'operation', resourceId: 'operation-parent-1',
      revision: 2, data: { status: 'running' },
    })
    hub.publish({
      eventId: 'distribution-operation-other-user', type: 'operation.changed', occurredAt: '2026-09-04T08:00:01.000Z',
      userId: 43, accountId: null, terminalInstanceId: null, resource: 'operation', resourceId: 'operation-parent-2',
      revision: 1, data: { status: 'running' },
    })

    expect(messages).toContainEqual(expect.objectContaining({
      type: 'operation.changed',
      scope: expect.objectContaining({ user_id: '42', trading_account_id: null, observer_channel_id: null }),
      resource: { kind: 'operation', id: 'operation-parent-1' },
    }))
    expect(messages).not.toContainEqual(expect.objectContaining({ resource: { kind: 'operation', id: 'operation-parent-2' } }))
    unsubscribe?.()
  })

  it('accepts only the exact same-origin subprotocol and sends welcome plus revision-ready', async () => {
    const http = createServer()
    await listen(http)
    const address = http.address() as AddressInfo
    const origin = `http://127.0.0.1:${address.port}`
    let used = false
    const gateway = new BrowserRealtimeWebSocketServer(http, {
      async consume() { if (used) return null; used = true; return { userId: 42, sessionId: 3, clientId: 'trade-web' } },
    }, new BrowserRealtimeHub(repository()), origin, false)
    gateway.start()
    closers.push(async () => { await gateway.close(); await closeServer(http) })
    const socket = new WebSocket(`${origin.replace('http:', 'ws:')}/realtime/v4`, 'aurum.realtime.v4', {
      origin,
      headers: { Cookie: `aurum_dev_realtime_ticket=rt_${'a'.repeat(43)}` },
    })
    const messages: unknown[] = []
    socket.on('message', raw => messages.push(JSON.parse(raw.toString())))
    await opened(socket)
    socket.send(JSON.stringify({ v: 4, type: 'subscription.subscribe', request_id: 'sub-1', targets: [
      { kind: 'account', trading_account_id: '7', observer_channel_id: null, symbol: null, timeframe: null, resource_id: 'positions', after_revision: '0' },
    ] }))
    await eventually(() => messages.some(message => (message as { type?: string }).type === 'subscription.ready'))
    expect(messages[0]).toMatchObject({ type: 'system.welcome', session: { user_id: '42', client_id: 'trade-web' } })
    expect(messages).toContainEqual(expect.objectContaining({ type: 'subscription.ready', request_id: 'sub-1' }))
    socket.close()
    await closed(socket)
  })

  it('rejects query credentials and cross-origin browser upgrades before ticket consumption', async () => {
    const http = createServer()
    await listen(http)
    const address = http.address() as AddressInfo
    const origin = `http://127.0.0.1:${address.port}`
    let consumes = 0
    const gateway = new BrowserRealtimeWebSocketServer(http, { async consume() { consumes += 1; return null } }, new BrowserRealtimeHub(repository()), origin, false)
    gateway.start()
    closers.push(async () => { await gateway.close(); await closeServer(http) })
    const base = origin.replace('http:', 'ws:')
    expect(await rejectedStatus(new WebSocket(`${base}/realtime/v4?ticket=secret`, 'aurum.realtime.v4', { origin }))).toBe(400)
    expect(await rejectedStatus(new WebSocket(`${base}/realtime/v4`, 'aurum.realtime.v4', { origin: 'https://evil.example', headers: { Cookie: `aurum_dev_realtime_ticket=rt_${'a'.repeat(43)}` } }))).toBe(403)
    expect(consumes).toBe(0)
  })

  it('returns 421 when trade business routes are addressed through another application host', async () => {
    const app = Fastify()
    app.addHook('onRequest', exactTradeHostHook('https://trade.example.test'))
    app.get('/api/v4/resource', async () => ({ ok: true }))
    expect((await app.inject({ method: 'GET', url: '/api/v4/resource', headers: { host: 'trade.example.test' } })).statusCode).toBe(200)
    const wrong = await app.inject({ method: 'GET', url: '/api/v4/resource', headers: { host: 'www.example.test' } })
    expect(wrong.statusCode).toBe(421)
    expect(wrong.json()).toMatchObject({ code: 'trade_host_required' })
    await app.close()
  })

  it('mounts SSO, Bridge credentials and every implemented trade V4 HTTP module in one API role', async () => {
    const app = Fastify()
    await registerApiV4Routes(app, {} as ApiV4RouteServices, { tradeOrigin: 'https://trade.example.test', adminOrigin: 'https://admin.example.test', secureCookies: false })
    await app.ready()
    for (const route of [
      ['GET', '/oauth/authorize'], ['POST', '/api/v4/realtime/tickets'],
      ['POST', '/api/v4/bridge/legacy-credential-exchanges'], ['POST', '/api/v4/bridge/session-tokens'],
      ['POST', '/api/v4/bridge/credential-revocations'],
      ['GET', '/api/v4/trading-context'], ['GET', '/api/v4/market/candles'],
      ['POST', '/api/v4/analysis-jobs'], ['GET', '/api/v4/risk-accounts/:accountId/policy'],
      ['GET', '/api/v4/operations/:operationId'], ['GET', '/api/v4/trading-accounts/:accountId/execution-context'],
      ['GET', '/api/v4/execution-distributions/preview'], ['GET', '/api/v4/execution-distributions/:distribution_id'],
      ['GET', '/api/v4/admin/observer/sources'], ['POST', '/api/v4/admin/observer/sources'],
      ['PUT', '/api/v4/admin/observer/default-channel'], ['PUT', '/api/v4/admin/observer/channels/:channel_id/accesses/:user_id'],
    ] as const) expect(app.hasRoute({ method: route[0], url: route[1] })).toBe(true)
    await app.close()
  })

  it('isolates observer management to the exact admin host, including port', async () => {
    const app = Fastify()
    app.addHook('onRequest', exactAdminHostHook('https://admin.example.test:8443'))
    app.get('/api/v4/admin/observer/channels', async () => ({ ok: true }))
    for (const host of ['trade.example.test:8443', 'admin.example.test', 'admin.example.test.evil:8443']) {
      const result = await app.inject({ url: '/api/v4/admin/observer/channels', headers: { host } })
      expect(result.statusCode).toBe(421)
      expect(result.json().code).toBe('admin_host_required')
    }
    expect((await app.inject({ url: '/api/v4/admin/observer/channels', headers: { host: 'admin.example.test:8443' } })).statusCode).toBe(200)
    await app.close()
  })
})

class FakeRedis extends EventEmitter {
  unsubscribed = false
  async subscribe() { return 1 }
  async unsubscribe() { this.unsubscribed = true; return 0 }
}

function realtimeEvent(): TradingRealtimeEvent {
  return { eventId: 'evt-1', type: 'market.quote.updated', occurredAt: '2026-09-04T08:00:00.000Z', userId: 42, accountId: '7', terminalInstanceId: 'term-1', resource: 'market.quote', resourceId: 'XAUUSD', revision: 8, data: { bid: '4500.1' } }
}

function repository(): TradingReadRepository {
  return {
    async getContext() { return null }, async saveContext() { throw new Error('unused') },
    async listAccounts() { return [] }, async listTerminalProfiles() { return [] }, async listObserverChannels() { return [] },
    async findAccount(accountId) { return accountId === '7' ? account() : null },
    async findOwnedAccount(userId, accountId) { return userId === 42 && accountId === '7' ? account() : null },
    async getAccountSnapshot() { return null }, async listSymbols() { return [] }, async getQuote() { return null },
    async listCandles() { return [] }, async listPositions() { return { revision: 0, items: [] } },
    async listPendingOrders() { return { revision: 0, items: [] } }, async latestRevision() { return 0 },
  }
}

function account() {
  return { id: '7', platform: 'mt5' as const, login: '596520', server: 'Demo', currency: 'USD', terminalProfileId: 'profile-1', terminalInstanceId: 'term-1', bridgeState: 'online' as const, tradePermission: true, lastSeenAt: '2026-09-04T08:00:00.000Z' }
}

function listen(server: ReturnType<typeof createServer>) {
  return new Promise<void>((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject))
}
function closeServer(server: ReturnType<typeof createServer>) {
  return new Promise<void>(resolve => server.close(() => resolve()))
}
function opened(socket: WebSocket) {
  return new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
}
function closed(socket: WebSocket) {
  return new Promise<void>(resolve => socket.readyState === WebSocket.CLOSED ? resolve() : socket.once('close', () => resolve()))
}
function rejectedStatus(socket: WebSocket) {
  return new Promise<number>((resolve, reject) => {
    socket.once('unexpected-response', (_request, response) => resolve(response.statusCode ?? 0))
    socket.once('open', () => reject(new Error('unexpected_open')))
    socket.once('error', () => undefined)
  })
}
async function eventually(assertion: () => boolean) {
  const deadline = Date.now() + 2_000
  while (!assertion()) {
    if (Date.now() >= deadline) throw new Error('event_timeout')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
