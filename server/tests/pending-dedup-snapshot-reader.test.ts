import { expect, it, vi } from 'vitest'
import type { PoolConnection } from 'mysql2/promise'
import type { ExecutionPendingSnapshot } from '../src/modules/trading/index.js'
import { createMysqlPendingDedupSnapshotReader } from '../src/modules/execution/infrastructure/mysql-pending-dedup-snapshot-reader.js'
import { checkPendingDedup } from '../src/modules/execution/application/pending-dedup-guard.js'

const route = { terminalInstanceId: 'terminal-1', brokerServer: 'Broker-Demo', login: '123', connectionEpoch: '3', ownershipRevision: '2' }
const input = { userId: 7, accountId: '11', strategyId: '21', route }
const snapshot: ExecutionPendingSnapshot = { userId: 7, accountId: '11', ...route, revision: '4',
  observedAt: '2026-09-09T02:00:00.000Z', complete: true, items: [] }
function fixture(value: ExecutionPendingSnapshot | null) {
  const execute = vi.fn().mockResolvedValue([[], []])
  const pending = { read: vi.fn().mockResolvedValue(value) }
  const reader = createMysqlPendingDedupSnapshotReader({ execute } as unknown as PoolConnection, pending, { read: vi.fn() })
  return { execute, pending, reader }
}
it('preserves a complete empty snapshot without querying historical outcomes', async () => {
  const { execute, pending, reader } = fixture(snapshot)
  expect(await reader.read(input)).toEqual({ userId: 7, accountId: '11', route, observedAt: snapshot.observedAt,
    revision: '4', complete: true, orders: [] })
  expect(pending.read).toHaveBeenCalledWith({ userId: 7, accountId: '11', ...route })
  expect(execute).not.toHaveBeenCalled()
})
it('does not infer ownership from a projection signal label', async () => {
  const { reader } = fixture({ ...snapshot, items: [{ ticket: '91', accountId: '11', symbol: 'XAUUSD',
    type: 'buy_limit', volume: '0.01', price: '2500', stopLoss: null, takeProfit: null,
    createdAt: snapshot.observedAt, expiresAt: null, source: 'signal', signalId: '21', revision: 4 }] })
  expect((await reader.read(input))?.orders[0]?.verifiedOrigin).toBeNull()
})
it('retains changed snapshot provenance so the application guard rejects it', async () => {
  const { reader } = fixture({ ...snapshot, ownershipRevision: '3' })
  await expect(checkPendingDedup(reader, { route, expectedRevision: '4', maxAgeSeconds: 30,
    request: { scope: { userId: 7, accountId: '11', strategyId: '21' }, instrumentId: 'XAUUSD', type: 'buy_limit',
      price: '2500', atrAnchor: null, atrMultiplier: '0.05', tickSize: '0.01', point: '0.01' } },
  new Date(snapshot.observedAt))).rejects.toThrow('execution_dedup_snapshot_scope_changed')
})
