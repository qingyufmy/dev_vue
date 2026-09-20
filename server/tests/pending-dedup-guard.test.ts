import { expect, it, vi } from 'vitest'
import { checkPendingDedup, type PendingDedupSnapshot } from '../src/modules/execution/application/pending-dedup-guard.js'
import type { PendingDedupRequest } from '../src/modules/execution/domain/pending-order-dedup.js'

const route = { terminalInstanceId: 'terminal-1', brokerServer: 'Broker-Demo', login: '123', connectionEpoch: '9', ownershipRevision: '2' }
const request: PendingDedupRequest = { scope: { userId: 7, accountId: '42', strategyId: 's1' }, instrumentId: 'gold',
  type: 'buy_limit', price: '2500', atrAnchor: null, atrMultiplier: '0.05', tickSize: '0.01', point: '0.01' }
const input = { request, route, expectedRevision: '3', maxAgeSeconds: 15 }
const now = new Date('2026-09-09T02:00:00.000Z')
const snapshot: PendingDedupSnapshot = { accountId: '42', userId: 7, route, complete: true,
  observedAt: '2026-09-09T01:59:59.000Z', revision: '3', orders: [] }

it('accepts an explicitly complete fresh empty snapshot', async () => {
  await expect(checkPendingDedup({ read: async () => snapshot }, input, now)).resolves.toEqual({ revision: '3', observedAt: snapshot.observedAt })
})
it.each([null, { ...snapshot, complete: false }, { ...snapshot, revision: '4' }, { ...snapshot, accountId: 'other' },
  { ...snapshot, route: { ...route, connectionEpoch: '10' } }, { ...snapshot, route: { ...route, ownershipRevision: '3' } },
  { ...snapshot, observedAt: '2026-09-09T01:59:44.000Z' }, { ...snapshot, observedAt: '2026-09-09T02:00:01.000Z' }])('rejects unavailable or mismatched snapshot even when empty', async value => {
  await expect(checkPendingDedup({ read: async () => value }, input, now)).rejects.toBeDefined()
})
it('rejects a verified duplicate instead of treating complete as permission to proceed', async () => {
  await expect(checkPendingDedup({ read: async () => ({ ...snapshot, orders: [{ ticket: '1', instrumentId: 'gold',
    type: 'buy_limit', price: '2500', verifiedOrigin: request.scope }] }) }, input, now)).rejects.toMatchObject({ code: 'execution_duplicate_live_pending' })
})
it('freezes request scope before waiting on storage', async () => {
  const mutable = structuredClone(input)
  const read = vi.fn(async () => { mutable.request.scope.accountId = 'other'; return snapshot })
  await expect(checkPendingDedup({ read }, mutable, now)).resolves.toHaveProperty('revision', '3')
  expect(read).toHaveBeenCalledWith({ ...request.scope, route })
})
