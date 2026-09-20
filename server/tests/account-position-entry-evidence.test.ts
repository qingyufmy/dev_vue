import { expect, it, vi } from 'vitest'
import { contentHash } from '../src/modules/inference/domain/inference.js'
import { freezeAccountPositionEntries, readAccountPositionEntries, unavailableAccountPositionEntries,
  type AccountPositionEntryScope } from '../src/modules/inference/application/account-position-entry-evidence.js'
import type { TradeDecisionEntryAnalysis } from '../src/modules/inference/application/trade-decision-entry-analysis-reader.js'
import type { ReferencePendingCreationReader } from '../src/modules/inference/application/reference-pending-creation.js'

function fixture() {
  const scope: AccountPositionEntryScope = { userId: 7, accountId: '11', positionsRevision: 3, asOf: '2026-09-13T00:00:00.000Z', positions: [{
    accountId: '11', ticket: '101', positionIdentifier: '100', revision: 3, symbol: 'XAUUSD', side: 'buy', volume: '0.2',
    openPrice: '2400', currentPrice: '2500', stopLoss: null, takeProfit: null, floatingProfit: '20',
    openedAt: '2026-09-12T00:00:00.000Z', source: 'unknown', signalId: null,
  }] }
  const route = { userId: 7, accountId: '11', platform: 'mt5' as const, brokerServer: 'test', login: '9',
    terminalProfileId: 'profile', terminalInstanceId: 'terminal', connectionId: 'connection', connectionEpoch: 1 }
  const collection = { accountId: '11', revision: 3, observedAt: scope.asOf, positions: structuredClone(scope.positions).map(position => ({ ...position, positionIdentifier: position.positionIdentifier ?? null })) }
  const result: TradeDecisionEntryAnalysis['result'] = { marketBias: 'bullish', opportunity: 'long_setup', confidence: 80,
    summary: 'creation', marketRegime: 'trend', supportingEvidence: [], counterEvidence: [], dataGaps: [],
    keyLevels: { accelerationByTimeframe: { H1: true } }, invalidation: { level: '2300' }, analysisBody: 'private prose',
    analyzedAt: '2026-09-11T00:01:00.000Z', validUntil: '2026-09-11T00:10:00.000Z' }
  const history = { read: vi.fn(async () => ({ status: 'source_matched' as const,
    taskId: 'task', receiptId: 'receipt', completionHash: 'a'.repeat(64), deals: [],
    lifecycle: { status: 'matches_snapshot' as const, positionIdentifier: '100', side: 'buy' as const, volume: '0.2',
      contributingOrderTickets: ['201', '202'], dealTickets: ['301', '302'] } })) }
  const origins: ReferencePendingCreationReader = { read: vi.fn(async (input: Parameters<ReferencePendingCreationReader['read']>[0]) => input.tickets.map(ticket => ({ ticket,
    status: 'strategy' as const, userId: 7, accountId: '11', strategyId: '21',
    decisionOrigin: { decisionId: `decision-${ticket}`, riskDecisionId: `risk-${ticket}`, strategyVersionId: '31' } }))) }
  const analyses = { read: vi.fn(async (input: Parameters<import('../src/modules/inference/application/trade-decision-entry-analysis-reader.js').TradeDecisionEntryAnalysisReader['read']>[0]): Promise<TradeDecisionEntryAnalysis | null> => ({ ...input,
    analysisId: 'private-analysis', analysisStrategyId: '41', analysisStrategyVersionId: '51', result: structuredClone(result), analysisHash: contentHash(result),
    inputSnapshotId: 'private-input', inputSnapshotHash: 'a'.repeat(64), inputCapturedAt: '2026-09-11T00:00:00.000Z',
    traderInputSnapshotId: 'private-trader', traderInputSnapshotHash: 'b'.repeat(64),
  })) }
  return { scope, route, collection, history, origins, analyses, result }
}

it('freezes every netting contribution for the actual account without requiring an observer or current strategy match', async () => {
  const f = fixture()
  const result = await freezeAccountPositionEntries(f.scope, { read: scope => readAccountPositionEntries(scope, f.route, f.collection, f) })
  expect(result).toMatchObject({ accountId: '11', positionsRevision: 3, purpose: 'account_position_creation_analysis_only',
    items: [{ ticket: '101', entryEvidence: { state: 'ready', entries: [{ keyLevels: f.result.keyLevels }, { keyLevels: f.result.keyLevels }] } }] })
  expect(f.origins.read).toHaveBeenCalledWith(expect.objectContaining({ userId: 7, accountId: '11', tickets: ['201', '202'] }))
  for (const text of ['private prose', 'private-analysis', 'private-input', 'decision-201', 'risk-202']) expect(JSON.stringify(result)).not.toContain(text)
  f.result.keyLevels = { mutated: true }
  expect(JSON.stringify(result)).toContain('accelerationByTimeframe')
})

it.each(['owner', 'account', 'revision', 'volume', 'identifier', 'stale', 'missing'])('does not read history for an inconsistent %s', async kind => {
  const f = fixture()
  if (kind === 'owner') f.route.userId = 8
  if (kind === 'account') f.collection.accountId = '12'
  if (kind === 'revision') f.collection.revision = 4
  if (kind === 'volume') f.collection.positions[0]!.volume = '0.3'
  if (kind === 'identifier') f.collection.positions[0]!.positionIdentifier = '999'
  if (kind === 'stale') f.collection.observedAt = '2026-09-12T00:00:00.000Z'
  const result = await readAccountPositionEntries(f.scope, f.route, kind === 'missing' ? null : f.collection, f)
  expect(result.items[0]!.entryEvidence.state).toBe('unavailable')
  expect(f.history.read).not.toHaveBeenCalled()
})

it('does not return partial evidence when one contribution has no creation analysis', async () => {
  const f = fixture(); f.analyses.read.mockResolvedValueOnce(null)
  const result = await readAccountPositionEntries(f.scope, f.route, f.collection, f)
  expect(result.items[0]!.entryEvidence).toMatchObject({ state: 'unavailable', reason: 'entry_analysis_unavailable' })
})

it('keeps mixed or manual order origins unresolved', async () => {
  const f = fixture()
  f.origins.read = async () => [{ ticket: '201', status: 'unresolved' }, { ticket: '202', status: 'unresolved' }]
  const result = await readAccountPositionEntries(f.scope, f.route, f.collection, f)
  expect(result.items[0]!.entryEvidence.state).toBe('unavailable')
  expect(f.analyses.read).not.toHaveBeenCalled()
})

it('rejects cross-account evidence and snapshot substitution at the final boundary', async () => {
  const f = fixture(), original = f.analyses.read.getMockImplementation()!
  f.analyses.read.mockImplementation(async input => ({ ...(await original(input))!, accountId: '99' }))
  await expect(readAccountPositionEntries(f.scope, f.route, f.collection, f)).rejects.toThrow('reference_entry_analysis_invalid')
  await expect(freezeAccountPositionEntries(f.scope, { read: async scope => unavailableAccountPositionEntries({ ...scope, accountId: '99' }) }))
    .rejects.toThrow('account_position_entry_evidence_invalid')
  await expect(freezeAccountPositionEntries(f.scope, { read: async scope => ({ scopeHash: contentHash(scope), items: [] }) }))
    .rejects.toThrow('account_position_entry_evidence_invalid')
})

it('explicitly marks unavailable providers instead of inferring history from current analysis', async () => {
  expect(await freezeAccountPositionEntries(fixture().scope)).toMatchObject({ items: [{ ticket: '101', entryEvidence: { state: 'unavailable', reason: 'not_collected' } }] })
})


it('requires covered history before querying creation orders', async () => {
  const f = fixture()
  const value = await readAccountPositionEntries(f.scope, f.route, f.collection, {
    ...f, history: { read: async () => ({ status: 'unresolved', reason: 'coverage_unavailable' }) },
  })
  expect(value.items[0]!.entryEvidence.state).toBe('unavailable')
  expect(f.origins.read).not.toHaveBeenCalled()
  expect(f.analyses.read).not.toHaveBeenCalled()
})

it('does not merge orders created by different strategies into a single entry basis', async () => {
  const f = fixture(), read = f.origins.read
  f.origins.read = async scope => (await read(scope)).map((item, index) => item.status === 'strategy' && index === 1
    ? { ...item, strategyId: '22' } : item)
  expect((await readAccountPositionEntries(f.scope, f.route, f.collection, f)).items[0]!.entryEvidence.state).toBe('unavailable')
  expect(f.analyses.read).not.toHaveBeenCalled()
})
