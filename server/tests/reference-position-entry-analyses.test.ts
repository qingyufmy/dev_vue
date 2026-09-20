import { expect, it, vi } from 'vitest'
import type { StrategyObserverInventory } from '../src/modules/trading/index.js'
import type { EntryAnalysisScope, TradeDecisionEntryAnalysis } from '../src/modules/inference/application/trade-decision-entry-analysis-reader.js'
import { readReferencePositionEntryAnalyses } from '../src/modules/inference/application/reference-position-entry-analyses.js'
import type { readReferencePositionCreation } from '../src/modules/inference/application/reference-position-creation.js'

const inventory = { authorization: { userId: 7, operatorUserId: 8 }, route: { accountId: '11' },
  positions: { items: [{ ticket: '91', symbol: 'XAUUSD' }] } } as StrategyObserverInventory
function fixture() {
  const origins: Awaited<ReturnType<typeof readReferencePositionCreation>> = { status: 'read', items: [{ ticket: '91', status: 'creation_strategy_matched',
    strategyId: '21', orderTickets: ['81', '82'], creationDecisions: [
      { orderTicket: '81', decisionId: 'd1', riskDecisionId: 'r1', strategyVersionId: '31' },
      { orderTicket: '82', decisionId: 'd2', riskDecisionId: 'r2', strategyVersionId: '32' }] }] }
  const read = vi.fn(async (scope: EntryAnalysisScope) => ({ ...scope, analysisId: `a-${scope.decisionId}` }) as TradeDecisionEntryAnalysis)
  return { origins, read }
}
it('binds each contribution to source operator/account and its own historical strategy version', async () => {
  const f = fixture(), result = await readReferencePositionEntryAnalyses(inventory, f.origins, { read: f.read })
  expect(result).toMatchObject([{ ticket: '91', status: 'read', entries: [
    { orderTicket: '81', analysis: { userId: 8, accountId: '11', strategyVersionId: '31', analysisId: 'a-d1' } },
    { orderTicket: '82', analysis: { userId: 8, accountId: '11', strategyVersionId: '32', analysisId: 'a-d2' } }] }])
})
it('keeps a position unresolved if any entry analysis is missing', async () => {
  const f = fixture(); f.read.mockResolvedValueOnce(null as unknown as TradeDecisionEntryAnalysis)
  expect(await readReferencePositionEntryAnalyses(inventory, f.origins, { read: f.read })).toEqual([
    { ticket: '91', status: 'unresolved', reason: 'entry_analysis_unavailable' }])
})
it('does not query without a complete creation-decision set', async () => {
  const f = fixture(); const item = f.origins.items[0]!
  if (item.status === 'creation_strategy_matched') item.creationDecisions = null
  expect(await readReferencePositionEntryAnalyses(inventory, f.origins, { read: f.read })).toEqual([
    { ticket: '91', status: 'unresolved', reason: 'creation_decision_missing' }])
  expect(f.read).not.toHaveBeenCalled()
})
it('rejects wrong-account evidence, duplicate contribution tickets and incomplete position sets', async () => {
  const f = fixture(); f.read.mockImplementation(async scope => ({ ...scope, accountId: '12' }) as TradeDecisionEntryAnalysis)
  await expect(readReferencePositionEntryAnalyses(inventory, f.origins, { read: f.read })).rejects.toThrow('reference_entry_analysis_invalid')
  await expect(readReferencePositionEntryAnalyses(inventory, { status: 'read', items: [] }, { read: f.read })).rejects.toThrow('reference_entry_analysis_invalid')
  const item = f.origins.items[0]!
  if (item.status === 'creation_strategy_matched') item.creationDecisions![1]!.orderTicket = '81'
  await expect(readReferencePositionEntryAnalyses(inventory, f.origins, { read: f.read })).rejects.toThrow('reference_entry_analysis_invalid')
})
