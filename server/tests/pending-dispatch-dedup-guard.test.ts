import { expect, it, vi } from 'vitest'
import { checkPendingDispatchDedup, type PendingDispatchOccupancy } from '../src/modules/execution/application/pending-dispatch-dedup-guard.js'
import type { PendingDedupSnapshot } from '../src/modules/execution/application/pending-dedup-guard.js'
import type { PendingDedupRequest } from '../src/modules/execution/domain/pending-order-dedup.js'

const route = { terminalInstanceId: 't1', brokerServer: 'Broker', login: '123', connectionEpoch: '9', ownershipRevision: '2' }
const request: PendingDedupRequest = { scope: { userId: 7, accountId: '42', strategyId: '21' }, instrumentId: 'XAUUSD.a',
  type: 'buy_limit', price: '2500', atrAnchor: '2', atrMultiplier: '0.05', tickSize: '0.01', point: '0.01' }
const now = new Date('2026-09-09T02:00:00.000Z')
const snapshot: PendingDedupSnapshot = { accountId: '42', userId: 7, route, complete: true,
  observedAt: '2026-09-09T01:59:59.000Z', revision: '3', orders: [] }
const input = { request, route, expectedRevision: '3', maxAgeSeconds: 15, commandId: 'current' }
const item: PendingDispatchOccupancy = { commandId: 'prior', status: 'dispatched', order: { ticket: 'command:prior',
  instrumentId: 'XAUUSD.a', type: 'buy_limit', price: '2500.1', verifiedOrigin: request.scope } }
const occupied = (items: PendingDispatchOccupancy[]) => ({ userId: 7, accountId: '42', route, complete: true, items })
const snapshots = { read: async () => structuredClone(snapshot) }
it.each(['dispatched', 'accepted', 'uncertain', 'reconciling', 'succeeded'] as const)('blocks %s even with an empty terminal projection', async status => {
  await expect(checkPendingDispatchDedup(snapshots, { read: async () => occupied([{ ...item, status }]) }, input, now))
    .rejects.toMatchObject({ code: 'execution_duplicate_pending_dispatch' })
})
it('excludes the current command and queued competitors', async () => {
  await expect(checkPendingDispatchDedup(snapshots, { read: async () => occupied([
    { ...item, commandId: 'current' }, { ...item, status: 'queued' },
  ]) }, input, now)).resolves.toHaveProperty('revision', '3')
})
it('preserves exact strategy and broker symbol isolation', async () => {
  await expect(checkPendingDispatchDedup(snapshots, { read: async () => occupied([
    { ...item, order: { ...item.order, verifiedOrigin: { ...request.scope, strategyId: '22' } } },
    { ...item, commandId: 'different-symbol', order: { ...item.order, instrumentId: 'XAUUSD.A' } },
  ]) }, input, now)).resolves.toHaveProperty('revision', '3')
})
it.each([null, { ...occupied([]), complete: false }, { ...occupied([]), route: { ...route, connectionEpoch: '10' } }])(
  'rejects incomplete or wrong-route occupancy even when empty', async value => {
    await expect(checkPendingDispatchDedup(snapshots, { read: async () => value }, input, now)).rejects.toBeDefined()
  })
it('rejects unknown ownership rather than silently losing a dispatched order', async () => {
  await expect(checkPendingDispatchDedup(snapshots, { read: async () => occupied([{ ...item, order: { ...item.order, verifiedOrigin: null } }]) }, input, now))
    .rejects.toMatchObject({ code: 'execution_dedup_occupancy_invalid' })
})
it('does not read occupancy after terminal projection validation fails', async () => {
  const read = vi.fn(async () => occupied([]))
  await expect(checkPendingDispatchDedup({ read: async () => null }, { read }, input, now)).rejects.toBeDefined()
  expect(read).not.toHaveBeenCalled()
})
it('rejects cross-account evidence inside a correctly scoped collection', async () => {
  await expect(checkPendingDispatchDedup(snapshots, { read: async () => occupied([{ ...item,
    order: { ...item.order, verifiedOrigin: { ...request.scope, accountId: '43' } } }]) }, input, now))
    .rejects.toMatchObject({ code: 'execution_dedup_occupancy_invalid' })
})
