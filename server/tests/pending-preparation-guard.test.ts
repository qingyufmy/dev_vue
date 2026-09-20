import { expect, it } from 'vitest'
import { checkPendingPreparation, type PendingPreparationCandidate } from '../src/modules/execution/application/pending-preparation-guard.js'
const now = new Date('2026-09-11T00:00:00.000Z')
const scope = { userId: 1, accountId: '1', strategyId: '2' }
const route = { terminalInstanceId: 'terminal', brokerServer: 'server', login: '123', connectionEpoch: '1', ownershipRevision: '1' }
const candidate = (intentId: string, price: string): PendingPreparationCandidate => ({ intentId,
  request: { scope, instrumentId: 'XAUUSD', type: 'buy_limit', price, atrAnchor: '10', atrMultiplier: '0.5', tickSize: '0.01', point: '0.01' },
  route, expectedRevision: '1', maxAgeSeconds: 30 })
const dependencies = () => ({ snapshots: { read: async () => ({ ...scope, route, complete: true, observedAt: now.toISOString(), revision: '1', orders: [] }) },
  dispatched: { read: async () => ({ ...scope, route, complete: true, items: [] }) },
  prepared: { read: async () => ({ ...scope, complete: true, items: [] }) } })
it('rejects same-bundle proximity using frozen ATR and permits separate price levels', async () => {
  await expect(checkPendingPreparation(dependencies(), [candidate('a','100'), candidate('b','105')], now)).rejects.toThrow('execution_duplicate_prepared_pending')
  await expect(checkPendingPreparation(dependencies(), [candidate('a','100'), candidate('b','105.01')], now)).resolves.toBeUndefined()
})
it('includes prepared intents even when they have no command or terminal ticket', async () => {
  const deps = dependencies()
  const prepared = { read: async () => ({ ...scope, complete: true, items: [{ intentId: 'old-intent', order: {
    ticket: 'old-intent', instrumentId: 'XAUUSD', type: 'buy_limit' as const, price: '102', verifiedOrigin: scope,
  } }] }) }
  await expect(checkPendingPreparation({ ...deps, prepared }, [candidate('new','100')], now)).rejects.toThrow('execution_duplicate_prepared_pending')
  await expect(checkPendingPreparation({ ...deps, prepared: { read: async () => null } }, [candidate('new','100')], now)).rejects.toThrow('execution_dedup_prepared_incomplete')
})
it('rejects mixed owner scope, duplicate intent identities and stale source evidence', async () => {
  const other = candidate('b','110'); other.request.scope = { ...scope, accountId: '9' }
  await expect(checkPendingPreparation(dependencies(), [candidate('a','100'), other], now)).rejects.toThrow('execution_dedup_context_invalid')
  await expect(checkPendingPreparation(dependencies(), [candidate('a','100'), candidate('a','110')], now)).rejects.toThrow('execution_dedup_context_invalid')
  await expect(checkPendingPreparation(dependencies(), [candidate('a','100')], new Date(now.getTime()+31000))).rejects.toThrow('execution_dedup_snapshot_stale')
})
