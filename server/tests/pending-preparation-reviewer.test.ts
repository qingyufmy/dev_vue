import { expect, it, vi } from 'vitest'
import type { PoolConnection } from 'mysql2/promise'
import { createMysqlPendingPreparationReviewer } from '../src/modules/execution/infrastructure/mysql-pending-preparation-reviewer.js'
import { checkPendingPreparation } from '../src/modules/execution/application/pending-preparation-guard.js'
vi.mock('../src/modules/execution/application/pending-preparation-guard.js', () => ({ checkPendingPreparation: vi.fn(async () => {}) }))
it('assembles only the frozen analysis ATR and rejects route, symbol and action substitution', async () => {
  const origin = { userId: 1, accountId: '2', decisionId: 'decision', strategyId: '3' }
  const route = { ...origin, terminalInstanceId: 't', terminalProfileId: 'p', connectionEpoch: 4, brokerServer: 'broker', login: '123' }
  const action = { actionId: 'a', kind: 'pending_order', parameters: { symbol: 'XAUUSD', type: 'buy_limit', price: '100', atr: '999' }, expectedState: { contractRevision: 5, pendingOrdersRevision: 6 } }
  const source = { ...origin, riskDecisionId: 'risk', tradeDecisionId: 'decision', approvedActions: [action] }
  const bundle = { riskDecisionId: 'risk', intents: [{ id: 'intent', ...origin, actionId: 'a', actionKind: 'pending_order', action }] }
  const instrument = { revision: 5, data: { tick_size: '0.01', point: '0.01', sourceEvidence: { userId: 1, terminalInstanceId: 't', terminalProfileId: 'p', connectionEpoch: '4', ownershipRevision: '1' } } }
  const dependencies = { routes: { current: async () => route }, decisions: { read: async () => origin },
    analyses: { read: async () => ({ ...origin, symbol: 'XAUUSD', atr: { status: 'available', value: '10' } }) },
    instruments: { read: async () => instrument }, pending: { read: async () => null } }
  const reviewer = createMysqlPendingPreparationReviewer({} as PoolConnection, dependencies as unknown as Parameters<typeof createMysqlPendingPreparationReviewer>[1])
  const policy = { ...origin, values: { pendingDedupAtrMultiplier: 0.5, maxRiskSummaryAgeSeconds: 30 } }
  const args = [source, bundle, policy, new Date()] as unknown as Parameters<typeof reviewer.review>
  await reviewer.review(...args)
  expect(vi.mocked(checkPendingPreparation).mock.calls.at(-1)?.[1][0]?.request.atrAnchor).toBe('10')
  instrument.data.sourceEvidence.connectionEpoch = '8'
  await expect(reviewer.review(...args)).rejects.toThrow('execution_dedup_context_invalid')
  instrument.data.sourceEvidence.connectionEpoch = '4'
  action.parameters.symbol = 'EURUSD'
  await expect(reviewer.review(...args)).rejects.toThrow('execution_dedup_context_invalid')
  action.parameters.symbol = 'XAUUSD'
  bundle.intents[0]!.action = { ...action, parameters: { ...action.parameters, price: '101' } }
  await expect(reviewer.review(...args)).rejects.toThrow('execution_dedup_context_invalid')
})
