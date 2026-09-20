import { describe, expect, it, vi } from 'vitest'
import type { PoolConnection } from 'mysql2/promise'
import { MysqlStrategyObserverInventoryReader } from '../src/modules/trading/infrastructure/mysql-strategy-observer-inventory-reader.js'
import type { ObserverAuthorization } from '../src/modules/trading/application/observer-ports.js'
import type { TradingAccountSummary } from '../src/modules/trading/domain/trading.js'

const now = new Date('2026-09-10T00:00:10.000Z')
const scope = { userId: 7, sourceAccountId: '9', analysisStrategyId: '20', asOf: now.toISOString() }
function fixture() {
  const authorization: ObserverAuthorization = { userId: 7, accountId: '9', operatorUserId: 8, sourceId: '1', sourceRevision: '1',
    channelId: '2', channelRevision: '1', accessRevision: '0', userTokenVersion: 1, ownershipRevision: '3', displayName: 'source', expiresAtUtc: '2026-09-10T00:00:40.000Z' }
  const account: TradingAccountSummary = { id: '9', platform: 'mt5', server: 'broker', login: '0007', currency: 'USD', terminalProfileId: 'profile',
    terminalInstanceId: 'terminal', bridgeState: 'offline', tradePermission: false, lastSeenAt: null }
  const route = { userId: 8, accountId: '9', platform: 'mt5' as const, brokerServer: 'broker', login: '0007', terminalProfileId: 'profile',
    terminalInstanceId: 'terminal', connectionId: 'connection', connectionEpoch: 4 }
  const sources = [{ resource_kind: 'positions', revision: '5', observed_at: '2026-09-10T00:00:09.000000Z' },
    { resource_kind: 'pending_orders', revision: '6', observed_at: '2026-09-10T00:00:08.000000Z' }]
  const positions: Array<Record<string, unknown>> = [], pending: Array<Record<string, unknown>> = []
  const execute = vi.fn(async (sql: string) => [sql.includes('FROM trading_projection_revisions') ? sources : sql.includes('FROM open_position_snapshots') ? positions : pending, []])
  const access = { read: vi.fn(async () => ({ analysisStrategyId: '20', authorization })) }
  const accounts = { findOwnedAccount: vi.fn(async () => account) }
  const routes = { current: vi.fn(async () => route) }
  const reader = new MysqlStrategyObserverInventoryReader({ execute } as unknown as Pick<PoolConnection, 'execute'>, access, accounts, routes, () => now)
  return { reader, sources, positions, pending, authorization, account, route, routes, access, accounts, execute }
}

describe('current strategy observer inventory', () => {
  it('proves empty collections separately and reads as the operator rather than the viewer', async () => {
    const f = fixture(), value = await f.reader.read(scope)
    expect(value).toMatchObject({ observedAt: '2026-09-10T00:00:08.000Z', positions: { revision: 5, observedAt: '2026-09-10T00:00:09.000Z', items: [] }, pendingOrders: { revision: 6, items: [] } })
    expect(f.accounts.findOwnedAccount).toHaveBeenCalledWith(8, '9')
    expect(f.access.read).toHaveBeenCalledWith(scope)
    expect(f.routes.current).toHaveBeenCalledTimes(2)
    expect(f.execute.mock.calls[1]?.[0]).not.toContain('revision=?')
  })
  it.each(['positions', 'pending_orders'])('rejects missing %s provenance', async kind => {
    const f = fixture(); f.sources.splice(f.sources.findIndex(row => row.resource_kind === kind), 1)
    expect(await f.reader.read(scope)).toBeNull()
  })
  it.each(['2026-09-09T23:59:00.000000Z', '2026-09-10T00:00:11.000000Z', 'invalid'])('rejects stale, future or malformed observation %s', async observed_at => {
    const f = fixture(); f.sources[0]!.observed_at = observed_at
    expect(await f.reader.read(scope)).toBeNull()
  })
  it('rejects paused binding, foreign route and replaced connection', async () => {
    const paused = fixture(); paused.account.bridgeState = 'paused'; expect(await paused.reader.read(scope)).toBeNull()
    const wrong = fixture(); wrong.route.login = '7'; expect(await wrong.reader.read(scope)).toBeNull()
    const changed = fixture(); changed.routes.current.mockResolvedValueOnce(changed.route).mockResolvedValueOnce({ ...changed.route, connectionEpoch: 5 })
    expect(await changed.reader.read(scope)).toBeNull()
  })
  it('rejects expiration and wrong observer scope', async () => {
    const expired = fixture(); expired.authorization.expiresAtUtc = now.toISOString(); expect(await expired.reader.read(scope)).toBeNull()
    const wrong = fixture(); wrong.authorization.userId = 8; expect(await wrong.reader.read(scope)).toBeNull()
  })
  it.each([
    { ticket: '10', revision: 4, payload_json: { accountId: '9', ticket: '10', revision: 4, symbol: 'XAUUSD' } },
    { ticket: '10', revision: 5, payload_json: { accountId: '8', ticket: '10', revision: 5, symbol: 'XAUUSD' } },
    { ticket: '10', revision: 5, payload_json: { accountId: '9', ticket: '11', revision: 5, symbol: 'XAUUSD' } },
    { ticket: '10', revision: 5, payload_json: '{broken' },
  ])('rejects mixed or malformed collection rows %j', async row => {
    const f = fixture(); f.positions.push(row); expect(await f.reader.read(scope)).toBeNull()
  })
  it('does not truncate oversized collections', async () => {
    const f = fixture(); f.positions.push(...Array.from({ length: 1001 }, () => ({})))
    expect(await f.reader.read(scope)).toBeNull()
  })
  it.each(['XAUUSD', 'XAUUSD.s'])('copies collection evidence and preserves terminal symbol %s', async symbol => {
    const f = fixture(), payload = { accountId: '9', ticket: '10', revision: 5, symbol }
    f.positions.push({ ticket: '10', revision: 5, payload_json: payload })
    const value = await f.reader.read(scope); payload.ticket = '11'
    expect(value?.positions.items[0]?.ticket).toBe('10')
    expect(value?.positions.items[0]?.symbol).toBe(symbol)
  })
})
