import { expect, it, vi } from 'vitest'
import type { PoolConnection } from 'mysql2/promise'
import { createBridgeCommand } from '../src/modules/execution/index.js'
import { DEFAULT_RISK_POLICY, resolveRiskPolicy } from '../src/modules/risk/index.js'
import { sha256Canonical } from '../src/modules/execution/domain/execution.js'
import { createMysqlPendingCommandReviewer } from '../src/modules/execution/infrastructure/mysql-pending-command-reviewer.js'

const now = new Date('2026-09-11T00:00:00.000Z')
const route = { terminalInstanceId: 'terminal_12345678', brokerServer: 'Broker', login: '123', connectionEpoch: 3 }
const command = createBridgeCommand({ executionIntentId: '11111111-1111-4111-8111-111111111111', commandSequence: 1,
  userId: 7, accountId: '11', terminalProfileId: 'profile_12345678', route, action: 'order.place',
  params: { symbol: 'XAUUSD', direction: 'buy', order_type: 'buy_limit', price: '2500', volume: '0.01', magic: 7, deviation: 20 },
  expectedState: null, deadlineAt: '2026-09-11T00:00:30.000Z' }, now)
const action = { actionId: 'a1', kind: 'pending_order', parameters: { symbol: 'XAUUSD', type: 'buy_limit', price: '2500', atr: '999999' },
  expectedState: { pendingOrdersRevision: 4, contractRevision: 5 } }
const origin = { userId: 7, accountId: '11', strategyId: '21', strategyVersionId: '22', decisionId: 'd1' }
const policy = resolveRiskPolicy({ userId: 7, accountId: '11', platformPolicyVersionId: '1', accountPolicyVersionId: null,
  policySetRevision: 1, platform: { values: { ...DEFAULT_RISK_POLICY, pendingDedupAtrMultiplier: 0.2 }, globalKillSwitch: false, revision: 1 },
  account: null, updatedAt: now.toISOString() })

function fixture() {
  const source = { source_type: 'risk_decision', source_id: 'r1', trade_decision_id: 'd1', risk_decision_id: 'r1' }
  const candidates: Record<string, unknown>[] = []
  const execute = vi.fn(async (sql: string) => {
    if (sql.startsWith('SELECT source_type')) return [[source]]
    if (sql.startsWith('SELECT action_json')) return [[{ action_json: action, action_sha256: sha256Canonical(action) }]]
    if (sql.includes('FROM bridge_commands_v4 c')) return [candidates]
    throw Error('unexpected_sql')
  })
  const pending = { read: vi.fn(async () => ({ userId: 7, accountId: '11', ...route, connectionEpoch: '3', ownershipRevision: '2',
    revision: '4', observedAt: now.toISOString(), complete: true as const, items: [] })) }
  const instruments = { read: vi.fn(async () => ({ revision: 5, data: { tick_size: '0.01', point: '0.01',
    sourceEvidence: { userId: 7, terminalInstanceId: route.terminalInstanceId, terminalProfileId: command.terminalProfileId, connectionEpoch: '3', ownershipRevision: '2' } } })) }
  const analysis = { ...origin, analysisId: 'analysis', snapshotId: 'snapshot', snapshotHash: 'a'.repeat(64), symbol: 'XAUUSD',
    capturedAt: now.toISOString(), market: {}, atr: { status: 'available' as const, value: '10', timeframe: 'H1' as const,
      period: 14 as const, method: 'closed-tr-sma14/v1' as const, lastBarOpenTime: '2026-09-10T23:00:00.000Z' } }
  const analyses = { read: vi.fn(async () => analysis) }
  const reader = createMysqlPendingCommandReviewer({ execute } as unknown as PoolConnection,
    { pending, instruments, analyses, decisions: { read: async () => origin } })
  return { reader, pending, instruments, analyses, analysis, candidates, source, execute }
}

it('reads the exact decision analysis and policy multiplier instead of model-supplied ATR', async () => {
  const f = fixture()
  // 1.5 away is outside default 10*0.05 but within the configured 10*0.2.
  const prior = { ...action, parameters: { ...action.parameters, price: '2501.5' } }
  f.candidates.push({ command_id: 'prior', intent_id: 'prior-intent', user_id: 7, account_id: '11', status: 'uncertain',
    ...f.source, action_json: prior, action_sha256: sha256Canonical(prior), result_sha256: null })
  await expect(f.reader.review(command, policy, now)).rejects.toThrow('execution_duplicate_pending_dispatch')
  await expect(f.reader.review(command, { ...policy, values: { ...policy.values, pendingDedupAtrMultiplier: 0.05 } }, now)).resolves.toBeUndefined()
  expect(f.analyses.read).toHaveBeenCalledWith({ userId: 7, accountId: '11', decisionId: 'd1', riskDecisionId: 'r1' })
})

it('permits a complete empty snapshot and performs only reads', async () => {
  const f = fixture()
  await expect(f.reader.review(command, policy, now)).resolves.toBeUndefined()
  expect(f.pending.read).toHaveBeenCalledTimes(2)
  expect(f.execute.mock.calls.every(([sql]) => sql.startsWith('SELECT'))).toBe(true)
})

it('rejects mismatched analysis provenance before any snapshot comparison', async () => {
  const f = fixture(); f.analysis.strategyId = '999'
  await expect(f.reader.review(command, policy, now)).rejects.toThrow('execution_dedup_context_invalid')
  expect(f.pending.read).not.toHaveBeenCalled()
})

it('rejects changed contract revision or instrument route', async () => {
  for (const changed of ['revision', 'route']) {
    const f = fixture(), instrument = await f.instruments.read()
    if (changed === 'revision') instrument.revision = 6
    else instrument.data.sourceEvidence.connectionEpoch = '4'
    f.instruments.read.mockResolvedValue(instrument)
    await expect(f.reader.review(command, policy, now)).rejects.toThrow('execution_dedup_context_invalid')
  }
})

it('keeps manual account orders outside strategy matching', async () => {
  const f = fixture(); f.source.source_type = 'user_command'
  await expect(f.reader.review(command, policy, now)).resolves.toBeUndefined()
  expect(f.analyses.read).not.toHaveBeenCalled(); expect(f.pending.read).not.toHaveBeenCalled()
})
