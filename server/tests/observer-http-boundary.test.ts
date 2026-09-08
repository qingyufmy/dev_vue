import { contextCommandPort } from './helpers/context-command-port.js'
import Fastify from 'fastify'
import { tradingRoutes } from '../src/modules/trading/transport/http/trading-routes.js'
import { describe, expect, it, vi } from 'vitest'
import {
  TradingService, ObserverPublicationService, ConnectionCapacityService,
  type ObserverAccessReader, type ObserverAuthorization, type TradingReadRepository,
  type AccountSnapshot, type OpenPosition, type ConnectionLeaseStore,
} from '../src/modules/trading/index.js'

function fixture() {
  const grant: ObserverAuthorization = {
    userId: 9, channelId: '12', sourceId: '13', sourceRevision: '2', channelRevision: '3',
    accessRevision: '0', userTokenVersion: 1, accountId: '7', ownershipRevision: '1', operatorUserId: 42,
    displayName: '黄金观摩', expiresAtUtc: new Date(Date.now() + 30_000).toISOString(),
  }
  const authorize = vi.fn(async () => grant as ObserverAuthorization | null)
  const access: ObserverAccessReader = { authorize, list: async () => [{ id: '12', displayName: '黄金观摩', sourceAccountId: '7', active: true }] }
  const account = {
    id: '7', platform: 'mt5' as const, login: 'private-login', server: 'private-server', currency: 'USD',
    terminalProfileId: 'private-profile', terminalInstanceId: 'private-instance', bridgeState: 'online' as const,
    tradePermission: true, lastSeenAt: '2026-09-05T08:00:00.000Z',
  }
  const snapshot: AccountSnapshot = { ...account, balance: '1000', equity: '1020', margin: '10', freeMargin: '1010',
    floatingProfit: '20', leverage: 100, timezoneOffsetMinutes: 180, clockStatus: 'calibrated',
    observedAt: '2026-09-05T08:00:00.000Z', revision: 4 }
  const position: OpenPosition = { ticket: '123', accountId: '7', symbol: 'XAUUSD', side: 'buy', volume: '0.01',
    openPrice: '3500', currentPrice: '3510', stopLoss: null, takeProfit: null, floatingProfit: '10',
    openedAt: '2026-09-05T07:00:00.000Z', source: 'signal', signalId: 'private-signal', revision: 4 }
  const getSnapshot = vi.fn(async () => snapshot)
  const positions = vi.fn(async () => ({ revision: 4, items: [position] }))
  const repository = {
    findOwnedAccount: vi.fn(async () => account), findAccount: vi.fn(async () => account),
    getAccountSnapshot: getSnapshot, listPositions: positions, listPendingOrders: async () => ({ revision: 4, items: [] }),
    listSymbols: async () => ['XAUUSD'], listObserverChannels: access.list,
    getQuote: vi.fn(async () => null), listCandles: vi.fn(async () => []),
  } as unknown as TradingReadRepository
  return { grant, authorize, access, repository, getSnapshot, positions }
}

async function appFor(service: TradingService, contextCommands = contextCommandPort().port) {
  const app = Fastify()
  await app.register(tradingRoutes, { prefix: '/api/v4', service, contextCommands,
    capacity: new ConnectionCapacityService({ getPurchasedCapacity: async () => 0 }, {} as ConnectionLeaseStore),
    auth: { authenticate: async () => ({ userId: 9 }), assertWrite: async () => ({ userId: 9 }) },
  })
  return app
}

describe('P4A observer HTTP boundary', () => {
  it('allows an explicit exit with no personal account even when the observer grant is gone', async () => {
    const f = fixture()
    f.repository.listAccounts = vi.fn(async () => [])
    const commands = contextCommandPort({ initial: { userId: 9, mode: 'observer', accountId: null, observerChannelId: '12', readOnly: true, revision: 4 } })
    const execute = vi.fn(commands.port.execute)
    const app = await appFor(new TradingService(f.repository), { ...commands.port, execute })
    const response = await app.inject({ method: 'DELETE', headers: { 'x-csrf-token': 'test-csrf-token-valid', 'idempotency-key': 'd97382ac-4b49-42db-b1f1-850ec403848a' }, url: '/api/v4/trading-context/observer?expected_revision=4' })
    expect(response.statusCode).toBe(200)
    expect(response.json().data).toMatchObject({ mode: 'blocked', account_id: null, observer_channel_id: null, read_only: true, revision: '5' })
    expect(f.authorize).not.toHaveBeenCalled()
    expect(execute).toHaveBeenCalledWith({ userId: 9, requestId: 'd97382ac-4b49-42db-b1f1-850ec403848a', action: 'leave_observer', targetId: null, expectedRevision: 4 })
    await app.close()
  })

  it('keeps an offline personal account available after leaving observation', async () => {
    const f = fixture()
    f.repository.listAccounts = vi.fn(async () => [{ id: '2', platform: 'mt4' as const, login: 'x', server: 'demo', currency: 'USD',
      terminalProfileId: null, terminalInstanceId: null, bridgeState: 'offline' as const, tradePermission: false, lastSeenAt: null }])
    const commands = contextCommandPort({ initial: { userId: 9, mode: 'observer', accountId: null, observerChannelId: '12', readOnly: true, revision: 1 },
      resolve: async () => ({ userId: 9, mode: 'full', accountId: '2', observerChannelId: null, readOnly: true }) })
    const app = await appFor(new TradingService(f.repository), commands.port)
    const response = await app.inject({ method: 'DELETE', headers: { 'x-csrf-token': 'test-csrf-token-valid', 'idempotency-key': 'd97382ac-4b49-42db-b1f1-850ec403848a' }, url: '/api/v4/trading-context/observer?expected_revision=1' })
    expect(response.statusCode).toBe(200)
    expect(response.json().data).toMatchObject({ mode: 'full', account_id: '2', observer_channel_id: null, read_only: true })
    expect(f.getSnapshot).not.toHaveBeenCalled()
    await app.close()
  })

  it('does not fall back to legacy channel/private repository reads if the publication service is absent', async () => {
    const f = fixture()
    const app = await appFor(new TradingService(f.repository))
    const response = await app.inject('/api/v4/trading-accounts/7/snapshot?observer_channel_id=12')
    expect(response.statusCode).toBe(403)
    expect(f.getSnapshot).not.toHaveBeenCalled()
    await app.close()
  })

  it('returns only sanitized observer DTOs after explicit user/channel authorization', async () => {
    const f = fixture()
    const app = await appFor(new TradingService(f.repository, new ObserverPublicationService(f.access, f.repository)))
    const response = await app.inject('/api/v4/trading-accounts/7/snapshot?observer_channel_id=12')
    expect(response.statusCode).toBe(200)
    expect(response.json().data).toMatchObject({ account: { terminal_profile_id: null, terminal_instance_id: null, trade_permission: false },
      snapshot: { balance: '1000', trade_permission: false }, positions: { items: [{ signal_id: null, source: 'unknown' }] } })
    expect(response.body).not.toMatch(/private-login|private-server|private-profile|private-instance|private-signal/)
    expect(f.authorize).toHaveBeenCalledWith(9, '12', '7')
    expect(f.getSnapshot).toHaveBeenCalledWith('7', 42)
    expect(f.positions).toHaveBeenCalledWith('7', 42)
    await app.close()
  })

  it('rejects removed authorization and a source change during the HTTP read', async () => {
    const f = fixture()
    const app = await appFor(new TradingService(f.repository, new ObserverPublicationService(f.access, f.repository)))
    f.authorize.mockResolvedValueOnce(null)
    expect((await app.inject('/api/v4/trading-accounts/7/snapshot?observer_channel_id=12')).statusCode).toBe(403)
    expect(f.getSnapshot).not.toHaveBeenCalled()
    f.authorize.mockResolvedValueOnce(f.grant).mockResolvedValueOnce({ ...f.grant, sourceRevision: '3' })
    expect((await app.inject('/api/v4/trading-accounts/7/snapshot?observer_channel_id=12')).statusCode).toBe(403)
    await app.close()
  })

  it.each([
    '/api/v4/market/quotes/XAUUSD?account_id=7&observer_channel_id=12',
    '/api/v4/market/candles?account_id=7&symbol=XAUUSD&timeframe=M5&observer_channel_id=12',
  ])('requires observer authorization for market reads: %s', async url => {
    const f = fixture()
    f.authorize.mockResolvedValue(null)
    const app = await appFor(new TradingService(f.repository, new ObserverPublicationService(f.access, f.repository)))
    expect((await app.inject(url)).statusCode).toBe(403)
    expect(f.repository.getQuote).not.toHaveBeenCalled()
    expect(f.repository.listCandles).not.toHaveBeenCalled()
    await app.close()
  })

  it('rejects a changed source account ownership revision before returning a private projection', async () => {
    const f = fixture()
    f.authorize.mockResolvedValueOnce(f.grant).mockResolvedValueOnce({ ...f.grant, ownershipRevision: '2' })
    const app = await appFor(new TradingService(f.repository, new ObserverPublicationService(f.access, f.repository)))
    expect((await app.inject('/api/v4/trading-accounts/7/snapshot?observer_channel_id=12')).statusCode).toBe(403)
    await app.close()
  })

  it('does not accept an authorization proof issued for another system user', async () => {
    const f = fixture()
    f.authorize.mockResolvedValue({ ...f.grant, userId: 10 })
    const app = await appFor(new TradingService(f.repository, new ObserverPublicationService(f.access, f.repository)))
    expect((await app.inject('/api/v4/trading-accounts/7/snapshot?observer_channel_id=12')).statusCode).toBe(403)
    expect(f.getSnapshot).not.toHaveBeenCalled()
    await app.close()
  })
})
