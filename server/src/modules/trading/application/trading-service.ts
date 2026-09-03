import { ConnectionCapacityExceededError, type ConnectionCapacityRepository, type ConnectionLeaseStore, type TradingReadRepository } from './trading-ports.js'
import { assertOpaqueId, assertSymbol, TradingAccessError, type Timeframe, type TradingContext } from '../domain/trading.js'

const TIMEFRAMES = new Set<Timeframe>(['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1'])

export class TradingService {
  constructor(private readonly repository: TradingReadRepository) {}

  async context(userId: number) {
    const stored = await this.repository.getContext(userId)
    if (stored) return stored
    return { userId, mode: 'blocked', accountId: null, observerChannelId: null, readOnly: true, revision: 0 } satisfies TradingContext
  }

  async selectAccount(userId: number, accountId: string, expectedRevision: number | null) {
    const account = await this.ownedAccount(userId, accountId)
    return this.repository.saveContext({
      userId, mode: 'full', accountId: account.id, observerChannelId: null, readOnly: !account.tradePermission,
    }, expectedRevision)
  }

  async enterObserver(userId: number, observerChannelId: string, expectedRevision: number | null) {
    const channelId = assertOpaqueId(observerChannelId)
    const allowed = (await this.repository.listObserverChannels(userId)).some((channel) => channel.id === channelId && channel.active)
    if (!allowed) throw new TradingAccessError('trading_account_forbidden', 403)
    return this.repository.saveContext({
      userId, mode: 'observer', accountId: null, observerChannelId: channelId, readOnly: true,
    }, expectedRevision)
  }

  async leaveObserver(userId: number, expectedRevision: number | null) {
    const accounts = await this.repository.listAccounts(userId)
    const account = accounts[0] ?? null
    return this.repository.saveContext({
      userId, mode: account ? 'full' : 'blocked', accountId: account?.id ?? null, observerChannelId: null,
      readOnly: account ? !account.tradePermission : true,
    }, expectedRevision)
  }

  listAccounts(userId: number) { return this.repository.listAccounts(userId) }
  listTerminalProfiles(userId: number) { return this.repository.listTerminalProfiles(userId) }
  listObserverChannels(userId: number) { return this.repository.listObserverChannels(userId) }

  async workspace(userId: number, accountId: string, observerChannelId?: string) {
    const account = await this.readableAccount(userId, accountId, observerChannelId)
    const [snapshot, symbols, positions, pendingOrders] = await Promise.all([
      this.repository.getAccountSnapshot(account.id), this.repository.listSymbols(account.id),
      this.repository.listPositions(account.id), this.repository.listPendingOrders(account.id),
    ])
    return { account, snapshot: observerChannelId && snapshot ? { ...snapshot, tradePermission: false } : snapshot, symbols, positions, pendingOrders }
  }

  async quote(userId: number, accountId: string, symbol: string, observerChannelId?: string) {
    const account = await this.readableAccount(userId, accountId, observerChannelId)
    return this.repository.getQuote(account.id, assertSymbol(symbol))
  }

  async candles(userId: number, accountId: string, symbol: string, timeframe: string, limit = 200, observerChannelId?: string) {
    const account = await this.readableAccount(userId, accountId, observerChannelId)
    if (!TIMEFRAMES.has(timeframe as Timeframe)) throw new TradingAccessError('trading_context_invalid', 400)
    if (!Number.isFinite(limit)) throw new TradingAccessError('trading_context_invalid', 400)
    return this.repository.listCandles(account.id, assertSymbol(symbol), timeframe as Timeframe, Math.max(1, Math.min(500, limit)))
  }

  async ownedAccount(userId: number, accountId: string) {
    const account = await this.repository.findOwnedAccount(userId, assertOpaqueId(accountId, 'account_id'))
    if (!account) throw new TradingAccessError('trading_account_forbidden', 403)
    return account
  }

  async readableAccount(userId: number, accountId: string, observerChannelId?: string) {
    const normalizedAccountId = assertOpaqueId(accountId, 'account_id')
    if (!observerChannelId) return this.ownedAccount(userId, normalizedAccountId)
    const channelId = assertOpaqueId(observerChannelId, 'observer_channel_id')
    const allowed = (await this.repository.listObserverChannels(userId)).some((channel) => channel.id === channelId && channel.active && channel.sourceAccountId === normalizedAccountId)
    if (!allowed) throw new TradingAccessError('trading_account_forbidden', 403)
    const account = await this.repository.findAccount(normalizedAccountId)
    if (!account) throw new TradingAccessError('trading_account_forbidden', 403)
    return { ...account, tradePermission: false }
  }
}

export class ConnectionCapacityService {
  constructor(private readonly capacities: ConnectionCapacityRepository, private readonly leases: ConnectionLeaseStore) {}

  async summary(userId: number) {
    const [purchased, active] = await Promise.all([this.capacities.getPurchasedCapacity(userId), this.leases.count(userId)])
    const total = 1 + Math.max(0, purchased)
    return { included: 1, purchased: Math.max(0, purchased), total, active, available: Math.max(0, total - active) }
  }

  async connect(input: Omit<Parameters<ConnectionLeaseStore['claim']>[0], 'capacity' | 'ttlSeconds'>) {
    const capacity = 1 + Math.max(0, await this.capacities.getPurchasedCapacity(input.userId))
    try {
      return await this.leases.claim({ ...input, capacity, ttlSeconds: 45 })
    } catch (error) {
      if (!(error instanceof ConnectionCapacityExceededError)) throw error
      throw new TradingAccessError('bridge_capacity_exceeded', 409)
    }
  }

  renew(userId: number, accountId: string, epoch: string) { return this.leases.renew(userId, accountId, epoch, 45) }
  release(userId: number, accountId: string, epoch: string) { return this.leases.release(userId, accountId, epoch) }
}
