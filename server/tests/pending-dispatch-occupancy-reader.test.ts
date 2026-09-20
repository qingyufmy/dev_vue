import { expect, it, vi } from 'vitest'
import type { PoolConnection } from 'mysql2/promise'
import type { PendingDedupSnapshot } from '../src/modules/execution/application/pending-dedup-guard.js'
import { sha256Canonical } from '../src/modules/execution/domain/execution.js'
import { createMysqlPendingDispatchOccupancyReader } from '../src/modules/execution/infrastructure/mysql-pending-dispatch-occupancy-reader.js'

const route = { terminalInstanceId: 't1', brokerServer: 'Broker', login: '123', connectionEpoch: '9', ownershipRevision: '2' }
const input = { userId: 7, accountId: '42', strategyId: '21', route, projectionRevision: '3' }
const origin = { userId: 7, accountId: '42', strategyId: '21' }
const action = { kind: 'pending_order', parameters: { symbol: 'XAUUSD.a', type: 'buy_limit', price: '2500' } }
const row = { command_id: 'c1', intent_id: 'i1', user_id: 7, account_id: '42', status: 'succeeded', source_type: 'risk_decision',
  source_id: 'r1', trade_decision_id: 'd1', risk_decision_id: 'r1', action_json: action, action_sha256: sha256Canonical(action), result_sha256: 'hash' }
const snapshot: PendingDedupSnapshot = { userId: 7, accountId: '42', route, revision: '3', complete: true,
  observedAt: '2026-09-09T00:00:00.000Z', orders: [{ ticket: '99', instrumentId: 'XAUUSD.a', type: 'buy_limit', price: '2600', verifiedOrigin: origin }] }
function fixture(current = snapshot, candidate = row) {
  const execute = vi.fn().mockResolvedValueOnce([[candidate], []]).mockResolvedValueOnce([[{ result_json: { order_ticket: '99' } }], []])
  const decisions = { read: async () => ({ ...origin, decisionId: 'd1', strategyVersionId: '31' }) }
  return { execute, reader: createMysqlPendingDispatchOccupancyReader({ execute } as unknown as PoolConnection, decisions, { read: async () => current }) }
}
it('hands an exactly covered success to the live snapshot, including a changed current price', async () => {
  expect((await fixture().reader.read(input))?.items).toEqual([])
})
it('does not interpret absence from a complete projection as release', async () => {
  const result = await fixture({ ...snapshot, orders: [] }).reader.read(input)
  expect(result?.items[0]?.order.price).toBe('2500')
})
it.each(['uncertain', 'reconciling', 'accepted', 'dispatched'])('retains %s even when a matching ticket is live', async status => {
  const { reader, execute } = fixture(snapshot, { ...row, status })
  expect((await reader.read(input))?.items).toHaveLength(1)
  expect(execute).toHaveBeenCalledTimes(1)
})
it('requires the exact projection revision used by the earlier guard', async () => {
  const { reader, execute } = fixture({ ...snapshot, revision: '4' })
  expect(await reader.read(input)).toBeNull()
  expect(execute).not.toHaveBeenCalled()
})
it('does not hand coverage to a different strategy', async () => {
  const result = await fixture({ ...snapshot, orders: [{ ...snapshot.orders[0]!, verifiedOrigin: { ...origin, strategyId: '22' } }] }).reader.read(input)
  expect(result?.items).toHaveLength(1)
})
it('retains success when its matching result evidence is missing', async () => {
  const { reader, execute } = fixture()
  execute.mockReset().mockResolvedValueOnce([[row], []]).mockResolvedValueOnce([[], []])
  expect((await reader.read(input))?.items).toHaveLength(1)
})
