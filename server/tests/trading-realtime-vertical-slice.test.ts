import { readFile } from 'node:fs/promises'
import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import {
  BridgeStreamProjector, BrowserRealtimeHub, BrowserRealtimeSession, ConnectionCapacityService, ObserverPublicationService, TradingAccessError, TradingService,
  tradingRoutes,
  type AccountSnapshot, type BrowserRealtimeSink, type ConnectionLeaseStore, type MarketCandle, type MarketQuote,
  type OpenPosition, type PendingOrder, type RealtimeResource, type TradingAccountSummary,
  ConnectionCapacityExceededError, type TradingProjectionRepository, type TradingReadRepository, type TradingRealtimeEvent,
  type TrustedBridgeProjectionRepository, type ObserverAccessReader, type ObserverAuthorization,
} from '../src/modules/trading/index.js'

const account: TradingAccountSummary = {
  id: '7', platform: 'mt5', login: '596520', server: 'DooTechnology-Demo', currency: 'USD',
  terminalProfileId: 'profile-1', terminalInstanceId: 'terminal-1', bridgeState: 'online', tradePermission: true,
  lastSeenAt: '2026-09-03T08:00:00.000Z',
}

function repository(): TradingReadRepository & TradingProjectionRepository & TrustedBridgeProjectionRepository {
  let context = { userId: 42, mode: 'full' as const, accountId: '7', observerChannelId: null, readOnly: false, revision: 1 }
  const revisions = new Map<string, number>()
  return {
    async getContext(userId) { return userId === 42 ? context : null },
    async saveContext(next, expected) {
      if (expected !== null && expected !== context.revision) throw new TradingAccessError('revision_conflict', 409)
      context = { ...next, revision: context.revision + 1 } as typeof context
      return context
    },
    async listAccounts(userId) { return userId === 42 ? [account] : [] },
    async listTerminalProfiles() { return [{ id: 'profile-1', displayName: '主终端', platform: 'mt5', installationId: 'install-1', accountId: '7', connectionState: 'online', lastSeenAt: '2026-09-03T08:00:00.000Z' }] },
    async listObserverChannels(userId) { return userId === 42 || userId === 99 ? [{ id: 'observer-1', displayName: '黄金观摩', sourceAccountId: '7', active: true }] : [] },
    async findAccount(accountId) { return accountId === account.id ? account : null },
    async findOwnedAccount(userId, accountId) { return userId === 42 && accountId === account.id ? account : null },
    async getAccountSnapshot(accountId) { return accountId === '7' ? snapshot() : null },
    async listSymbols() { return ['XAUUSD', 'EURUSD'] },
    async getQuote(accountId, symbol) { return accountId === '7' ? quote(symbol) : null },
    async listCandles(accountId, symbol, timeframe, limit) { return accountId === '7' ? [candle(symbol, timeframe)].slice(0, limit) : [] },
    async listPositions() { return { revision: 3, items: [] } },
    async listPendingOrders() { return { revision: 4, items: [] } },
    async latestRevision(accountId, resource, resourceId) { return revisions.get(`${accountId}:${resource}:${resourceId}`) ?? 0 },
    async applyProjection(input) {
      const key = `${input.accountId}:${input.resource}:${input.resourceId}`; const previous = revisions.get(key) ?? 0
      if (input.revision <= previous) return false
      revisions.set(key, input.revision); return true
    },
    async applyTrustedProjection(input) {
      return { applied: await this.applyProjection(input.projection), absorbedReservationIds: [] }
    },
  }
}

function snapshot(): AccountSnapshot {
  return { ...account, balance: '10000.00', equity: '10020.00', margin: '100.00', freeMargin: '9920.00', floatingProfit: '20.00', leverage: 500, timezoneOffsetMinutes: 180, clockStatus: 'calibrated', observedAt: '2026-09-03T08:00:00.000Z', revision: 2 }
}
function quote(symbol = 'XAUUSD'): MarketQuote { return { accountId: '7', symbol, bid: '3540.10', ask: '3540.30', last: null, spread: '0.20', tradeMode: 'full', observedAt: '2026-09-03T08:00:00.000Z', revision: 8 } }
function candle(symbol = 'XAUUSD', timeframe: MarketCandle['timeframe'] = 'M5'): MarketCandle { return { accountId: '7', symbol, timeframe, openTime: '2026-09-03T07:55:00.000Z', open: '3539.00', high: '3541.00', low: '3538.50', close: '3540.20', tickVolume: '238', closed: false, revision: 9 } }

class MemoryLeases implements ConnectionLeaseStore {
  entries = new Map<number, Map<string, string>>()
  async claim(input: Parameters<ConnectionLeaseStore['claim']>[0]) {
    const entries = this.entries.get(input.userId) ?? new Map<string, string>()
    const replacedEpoch = entries.get(input.accountId) ?? null
    if (!replacedEpoch && entries.size >= input.capacity) throw new ConnectionCapacityExceededError()
    entries.set(input.accountId, input.connectionEpoch); this.entries.set(input.userId, entries)
    return { active: entries.size, replacedEpoch }
  }
  async renew(userId: number, accountId: string, epoch: string) { return this.entries.get(userId)?.get(accountId) === epoch }
  async release(userId: number, accountId: string, epoch: string) { if (this.entries.get(userId)?.get(accountId) === epoch) this.entries.get(userId)?.delete(accountId) }
  async count(userId: number) { return this.entries.get(userId)?.size ?? 0 }
}

describe('Stage 11 trading vertical slice', () => {
  it('keeps every account-scoped read behind ownership and bounds candle requests', async () => {
    const service = new TradingService(repository())
    await expect(service.workspace(42, '7')).resolves.toMatchObject({ account: { login: '596520' }, symbols: ['XAUUSD', 'EURUSD'] })
    await expect(service.quote(99, '7', 'XAUUSD')).rejects.toMatchObject({ code: 'trading_account_forbidden', status: 403 })
    await expect(service.candles(42, '7', 'XAUUSD', 'M2', 200)).rejects.toMatchObject({ code: 'trading_context_invalid' })
  })

  it('serves normalized snake_case HTTP snapshots through the authenticated trade boundary', async () => {
    const store = repository(); const leases = new MemoryLeases()
    const app = Fastify({ logger: false })
    await app.register(tradingRoutes, { prefix: '/api/v4', service: new TradingService(store), capacity: new ConnectionCapacityService({ async getPurchasedCapacity() { return 0 } }, leases), auth: { async authenticate() { return { userId: 42 } }, async assertWrite() { return { userId: 42 } } } })
    const result = await app.inject({ method: 'GET', url: '/api/v4/trading-accounts/7/snapshot' })
    expect(result.statusCode).toBe(200)
    expect(result.json().data).toMatchObject({ account: { terminal_profile_id: 'profile-1', bridge_state: 'online' }, snapshot: { free_margin: '9920.00', clock_status: 'calibrated' }, pending_orders: { revision: '4' } })
    expect(JSON.stringify(result.json())).not.toContain('terminalProfileId')
    const observer = await app.inject({ method: 'PUT', url: '/api/v4/trading-context', payload: { mode: 'observer', observer_channel_id: 'observer-1', expected_revision: '1' } })
    expect(observer.json().data).toMatchObject({ mode: 'observer', observer_channel_id: 'observer-1', read_only: true, revision: '2' })
    const restored = await app.inject({ method: 'DELETE', url: '/api/v4/trading-context/observer?expected_revision=2' })
    expect(restored.json().data).toMatchObject({ mode: 'full', account_id: '7', observer_channel_id: null, revision: '3' })
    await app.close()
  })

  it('counts distinct online accounts, replaces the same account route, and rejects a second account without quota', async () => {
    const leases = new MemoryLeases()
    const service = new ConnectionCapacityService({ async getPurchasedCapacity() { return 0 } }, leases)
    await expect(service.connect({ userId: 42, accountId: '7', terminalProfileId: 'p1', terminalInstanceId: 't1', connectionEpoch: 'e1' })).resolves.toEqual({ active: 1, replacedEpoch: null })
    await expect(service.connect({ userId: 42, accountId: '7', terminalProfileId: 'p2', terminalInstanceId: 't2', connectionEpoch: 'e2' })).resolves.toEqual({ active: 1, replacedEpoch: 'e1' })
    await expect(service.connect({ userId: 42, accountId: '8', terminalProfileId: 'p3', terminalInstanceId: 't3', connectionEpoch: 'e3' })).rejects.toMatchObject({ code: 'bridge_capacity_exceeded', status: 409 })
    const unavailableStore: ConnectionLeaseStore = {
      async claim() { throw new Error('redis unavailable') },
      renew: leases.renew.bind(leases), release: leases.release.bind(leases), count: leases.count.bind(leases),
    }
    const unavailable = new ConnectionCapacityService({ async getPurchasedCapacity() { return 0 } }, unavailableStore)
    await expect(unavailable.connect({ userId: 42, accountId: '7', terminalProfileId: 'p1', terminalInstanceId: 't1', connectionEpoch: 'e1' })).rejects.toThrow('redis unavailable')
  })

  it('allows an authorized observer to read and subscribe to one source account without trade permission', async () => {
    const storage = repository()
    const authorization: ObserverAuthorization = {
      userId: 99, channelId: 'observer-1', sourceId: 'source-1', sourceRevision: '1', ownershipRevision: '1',
      channelRevision: '1', accessRevision: '1', userTokenVersion: 1, accountId: '7', operatorUserId: 42,
      displayName: '黄金观摩', expiresAtUtc: new Date(Date.now() + 30_000).toISOString(),
    }
    const observers: ObserverAccessReader = {
      list: async () => [{ id: 'observer-1', displayName: '黄金观摩', sourceAccountId: '7', active: true }],
      authorize: async (userId, channelId, accountId) => userId === authorization.userId
        && channelId === authorization.channelId && accountId === authorization.accountId ? authorization : null,
    }
    const service = new TradingService(storage, new ObserverPublicationService(observers, storage))
    await expect(service.workspace(99, '7', 'observer-1')).resolves.toMatchObject({ account: { id: '7', tradePermission: false }, snapshot: { tradePermission: false } })
    await expect(service.workspace(99, '7', 'observer-missing')).rejects.toMatchObject({ code: 'trading_account_forbidden' })
    const messages: unknown[] = []
    const hub = new BrowserRealtimeHub(storage, observers)
    const stop = await hub.subscribe({ userId: 99, accountId: '7', observerChannelId: 'observer-1', resources: ['market.quote:XAUUSD'], afterRevision: { 'market.quote:XAUUSD': null }, sink: { send(value) { messages.push(value) }, close() {} } })
    expect(stop).toBeTypeOf('function')
    expect(messages).toContainEqual(expect.objectContaining({ type: 'subscription.ready', subscriptions: expect.arrayContaining([expect.objectContaining({ target: expect.objectContaining({ observer_channel_id: 'observer-1' }) })]) }))
    hub.publish({ eventId: 'observer-event', type: 'market.quote.updated', occurredAt: '2026-09-03T08:00:00.000Z', userId: 42, accountId: '7', terminalInstanceId: 'terminal-1', resource: 'market.quote', resourceId: 'XAUUSD', revision: 1, data: {} })
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(messages).toContainEqual(expect.objectContaining({ type: 'observer.publication.changed', scope: expect.objectContaining({ user_id: '99', observer_channel_id: 'observer-1' }) }))
  })

  it('projects one MT4/MT5-neutral stream revision once and isolates browser subscriptions by user and account', async () => {
    const storage = repository(); const hub = new BrowserRealtimeHub(storage); const published: TradingRealtimeEvent[] = []
    const projector = new BridgeStreamProjector(storage, { publish(event) { published.push(event); hub.publish(event) } }, () => new Date('2026-09-03T08:00:01.000Z'))
    const messages: unknown[] = []; const sink: BrowserRealtimeSink = { send(value) { messages.push(value) }, close() {} }
    const stop = await hub.subscribe({ userId: 42, accountId: '7', resources: ['market.quote:XAUUSD'], afterRevision: { 'market.quote:XAUUSD': 0 }, sink })
    expect(stop).toBeTypeOf('function')
    const route = { userId: 42, accountId: '7', terminalProfileId: 'profile-1', terminalInstanceId: 'terminal-1', connectionEpoch: 1 }
    await expect(projector.ingest(route, { resource: 'market.quote', resourceId: 'XAUUSD', revision: 1, data: { ...quote(), revision: 1 } })).resolves.toBe(true)
    await expect(projector.ingest(route, { resource: 'market.quote', resourceId: 'XAUUSD', revision: 1, data: { ...quote(), revision: 1 } })).resolves.toBe(false)
    expect(published).toHaveLength(1)
    expect(messages).toContainEqual(expect.objectContaining({ type: 'market.quote.updated', sequence: 1, revision: '1' }))
  })

  it('rejects a projection whose payload or resource identity belongs to another account', async () => {
    const projector = new BridgeStreamProjector(repository(), { publish() {} })
    const route = { userId: 42, accountId: '7', terminalProfileId: 'profile-1', terminalInstanceId: 'terminal-1', connectionEpoch: 1 }
    await expect(projector.ingest(route, { resource: 'market.quote', resourceId: 'XAUUSD', revision: 1, data: { ...quote(), accountId: '8', revision: 1 } })).rejects.toMatchObject({ code: 'trading_context_invalid' })
    await expect(projector.ingest(route, { resource: 'market.candle', resourceId: 'XAUUSD', revision: 1, data: { ...candle(), revision: 1 } })).rejects.toMatchObject({ code: 'trading_context_invalid' })
  })

  it('requires a precise HTTP resync when a reconnect revision does not match the current projection', async () => {
    const storage = repository()
    await storage.applyProjection({ accountId: '7', resource: 'positions', resourceId: 'open', revision: 6, data: [] })
    const messages: unknown[] = []
    const result = await new BrowserRealtimeHub(storage).subscribe({ userId: 42, accountId: '7', resources: ['positions:open'], afterRevision: { 'positions:open': 4 }, sink: { send(value) { messages.push(value) }, close() {} } })
    expect(result).toBeNull()
    expect(messages).toContainEqual(expect.objectContaining({ type: 'subscription.resync_required', reason: 'revision_gap' }))
  })

  it('maps the public subscription contract to precise internal resources', async () => {
    const messages: unknown[] = []; const storage = repository(); const hub = new BrowserRealtimeHub(storage)
    const session = new BrowserRealtimeSession(42, hub, { send(value) { messages.push(value) }, close() {} })
    await session.receive({ v: 4, type: 'subscription.subscribe', request_id: 'req', targets: [
      { kind: 'market', trading_account_id: '7', observer_channel_id: null, symbol: 'XAUUSD', timeframe: null, resource_id: 'quote', after_revision: '0' },
      { kind: 'account', trading_account_id: '7', observer_channel_id: null, symbol: null, timeframe: null, resource_id: 'positions', after_revision: '0' },
    ] })
    expect(messages).toContainEqual(expect.objectContaining({ type: 'subscription.ready', request_id: 'req', subscriptions: expect.arrayContaining([
      expect.objectContaining({ target: expect.objectContaining({ resource_id: 'quote' }) }),
      expect.objectContaining({ target: expect.objectContaining({ resource_id: 'positions' }) }),
    ]) }))
    hub.publish({ eventId: 'e1', type: 'market.quote.updated', occurredAt: '2026-09-03T08:00:00.000Z', userId: 42, accountId: '7', terminalInstanceId: 't1', resource: 'market.quote', resourceId: 'XAUUSD', revision: 1, data: {} })
    expect(messages).toContainEqual(expect.objectContaining({ type: 'market.quote.updated' }))
  })

  it('supports one browser connection subscribing to multiple owned trading accounts', async () => {
    const messages: unknown[] = []; const storage = repository()
    const original = storage.findOwnedAccount.bind(storage)
    storage.findOwnedAccount = async (userId, accountId) => accountId === '8' && userId === 42 ? { ...account, id: '8' } : original(userId, accountId)
    const session = new BrowserRealtimeSession(42, new BrowserRealtimeHub(storage), { send(value) { messages.push(value) }, close() {} })
    await session.receive({ v: 4, type: 'subscription.subscribe', request_id: 'multi-account', targets: [
      { kind: 'account', trading_account_id: '7', observer_channel_id: null, symbol: null, timeframe: null, resource_id: 'positions', after_revision: '0' },
      { kind: 'account', trading_account_id: '8', observer_channel_id: null, symbol: null, timeframe: null, resource_id: 'positions', after_revision: '0' },
    ] })
    expect(messages).toContainEqual(expect.objectContaining({ type: 'subscription.ready', request_id: 'multi-account', subscriptions: expect.any(Array) }))
  })

  it('keeps analysis and review updates user-scoped while trader, risk and operation updates remain account-scoped', async () => {
    const messages: unknown[] = []; const hub = new BrowserRealtimeHub(repository())
    const session = new BrowserRealtimeSession(42, hub, { send(value) { messages.push(value) }, close() {} })
    await session.receive({ v: 4, type: 'subscription.subscribe', request_id: 'domains', targets: [
      { kind: 'signals', trading_account_id: null, observer_channel_id: null, symbol: null, timeframe: null, resource_id: 'all', after_revision: null },
      { kind: 'signals', trading_account_id: '7', observer_channel_id: null, symbol: null, timeframe: null, resource_id: 'trade_decisions', after_revision: null },
      { kind: 'risk', trading_account_id: '7', observer_channel_id: null, symbol: null, timeframe: null, resource_id: 'summary', after_revision: null },
      { kind: 'reviews', trading_account_id: null, observer_channel_id: null, symbol: null, timeframe: null, resource_id: 'all', after_revision: null },
      { kind: 'operations', trading_account_id: '7', observer_channel_id: null, symbol: null, timeframe: null, resource_id: 'all', after_revision: null },
    ] })
    hub.publish({ eventId: 'analysis-evt', type: 'market_analysis.created', occurredAt: '2026-09-04T08:00:00.000Z', userId: 42, accountId: null, terminalInstanceId: null, resource: 'market_analysis', resourceId: 'analysis-1', revision: 1, data: {} })
    hub.publish({ eventId: 'decision-evt', type: 'trade_decision.created', occurredAt: '2026-09-04T08:00:01.000Z', userId: 42, accountId: '7', terminalInstanceId: null, resource: 'trade_decision', resourceId: 'decision-1', revision: 1, data: {} })
    hub.publish({ eventId: 'review-evt', type: 'review.case.changed', occurredAt: '2026-09-04T08:00:01.000Z', userId: 42, accountId: null, terminalInstanceId: null, resource: 'review_case', resourceId: 'review-1', revision: 1, data: {} })
    hub.publish({ eventId: 'foreign-evt', type: 'market_analysis.created', occurredAt: '2026-09-04T08:00:02.000Z', userId: 99, accountId: null, terminalInstanceId: null, resource: 'market_analysis', resourceId: 'analysis-2', revision: 1, data: {} })
    expect(messages).toContainEqual(expect.objectContaining({ event_id: 'analysis-evt', scope: expect.objectContaining({ trading_account_id: null }) }))
    expect(messages).toContainEqual(expect.objectContaining({ event_id: 'decision-evt', scope: expect.objectContaining({ trading_account_id: '7' }) }))
    expect(messages).toContainEqual(expect.objectContaining({ event_id: 'review-evt', scope: expect.objectContaining({ trading_account_id: null }) }))
    expect(messages).not.toContainEqual(expect.objectContaining({ event_id: 'foreign-evt' }))
  })

  it('accepts the compact user-scoped signals target with omitted optional fields', async () => {
    const messages: unknown[] = []
    const session = new BrowserRealtimeSession(42, new BrowserRealtimeHub(repository()), {
      send(value) { messages.push(value) }, close() {},
    })
    await session.receive({
      v: 4, type: 'subscription.subscribe', request_id: 'compact-signals',
      targets: [{ kind: 'signals', resource_id: 'all', after_revision: null }],
    })
    expect(messages).toContainEqual(expect.objectContaining({
      type: 'subscription.ready', request_id: 'compact-signals', subscriptions: expect.any(Array),
    }))
  })

  it('rejects empty and oversized subscription batches before authorization work', async () => {
    for (const targets of [[], Array.from({ length: 33 }, () => ({
      kind: 'signals', resource_id: 'all', after_revision: null,
    }))]) {
      const messages: unknown[] = []
      const session = new BrowserRealtimeSession(42, new BrowserRealtimeHub(repository()), {
        send(value) { messages.push(value) }, close() {},
      })
      await session.receive({ v: 4, type: 'subscription.subscribe', request_id: 'bounded', targets })
      expect(messages).toContainEqual(expect.objectContaining({
        type: 'protocol.error', code: 'realtime_message_invalid',
      }))
    }
  })

  it('does not let a read-only observer subscribe to owner-only AI, risk or operation resources', async () => {
    const messages: unknown[] = []; const closes: Array<{ code: number; reason: string }> = []
    const session = new BrowserRealtimeSession(99, new BrowserRealtimeHub(repository()), {
      send(value) { messages.push(value) }, close(code, reason) { closes.push({ code, reason }) },
    })
    await session.receive({ v: 4, type: 'subscription.subscribe', request_id: 'observer-risk', targets: [
      { kind: 'risk', trading_account_id: '7', observer_channel_id: 'observer-1', symbol: null, timeframe: null, resource_id: 'summary', after_revision: null },
    ] })
    expect(messages).toContainEqual(expect.objectContaining({ type: 'protocol.error', code: 'realtime_target_invalid' }))
    expect(closes).toEqual([])
  })

  it('supports protocol ping and explicit unsubscribe without a business command channel', async () => {
    const messages: unknown[] = []; const storage = repository(); const hub = new BrowserRealtimeHub(storage)
    const session = new BrowserRealtimeSession(42, hub, { send(value) { messages.push(value) }, close() {} })
    await session.receive({ v: 4, type: 'subscription.subscribe', request_id: 'sub', targets: [
      { kind: 'account', trading_account_id: '7', observer_channel_id: null, symbol: null, timeframe: null, resource_id: 'positions', after_revision: '0' },
    ] })
    await session.receive({ v: 4, type: 'system.ping', request_id: 'ping' })
    await session.receive({ v: 4, type: 'subscription.unsubscribe', request_id: 'unsub' })
    hub.publish({ eventId: 'after', type: 'positions.changed', occurredAt: '2026-09-04T08:00:00.000Z', userId: 42, accountId: '7', terminalInstanceId: 't1', resource: 'positions', resourceId: 'open', revision: 1, data: { items: [] } })
    expect(messages).toContainEqual(expect.objectContaining({ type: 'system.pong', request_id: 'ping' }))
    expect(messages).toContainEqual({ v: 4, type: 'subscription.unsubscribed', request_id: 'unsub' })
    expect(messages).not.toContainEqual(expect.objectContaining({ event_id: 'after' }))
    await session.receive({ v: 4, type: 'command', request_id: 'write' })
    expect(messages).toContainEqual(expect.objectContaining({ type: 'protocol.error', code: 'realtime_message_invalid' }))
  })

  it('keeps migration explicit, normalized, indexed and separate from the legacy source database', async () => {
    const sql = await readFile(new URL('../db/migrations/20260903_003_trading_context_and_market_projection.sql', import.meta.url), 'utf8')
    expect(sql).toContain('TARGET: empty V4 side-by-side database only')
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS trading_account_ownerships')
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS bridge_connection_capacity_grants')
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS trading_projection_revisions')
    expect(sql).toContain('idx_market_candles_tail')
    expect(sql).not.toMatch(/DROP TABLE|TRUNCATE TABLE|DELETE FROM/i)
  })
})
