import { ReadStrategyReferencePortfolio, type StrategyReferenceEvidence } from '../src/modules/inference/application/read-strategy-reference-portfolio.js'
import { expect, it } from 'vitest'
import { contentHash } from '../src/modules/inference/domain/inference.js'
import type { TradeDecisionEntryAnalysis } from '../src/modules/inference/application/trade-decision-entry-analysis-reader.js'
import { projectReferenceEntryEvidence, freezeReferenceEntryEvidence } from '../src/modules/inference/application/reference-entry-evidence.js'
import { freezeStrategyReferencePortfolio } from '../src/modules/inference/application/strategy-reference-portfolio.js'

function entryFixture() {
  const result = { marketBias: 'bullish' as const, opportunity: 'long_setup' as const, confidence: 80, summary: 'entry', marketRegime: 'trend',
    supportingEvidence: [], counterEvidence: [], dataGaps: [], keyLevels: { accelerationByTimeframe: { H1: { direction: 'buy', active: true }, H4: { direction: 'buy', active: true } } },
    invalidation: { rule: 'all-original-timeframes' }, analysisBody: 'long full prose', analyzedAt: '2020-01-01T00:01:00.000Z', validUntil: '2020-01-01T00:10:00.000Z' }
  const analysis: TradeDecisionEntryAnalysis = { decisionId: 'decision-private', riskDecisionId: 'risk-private', userId: 70, accountId: '9', strategyId: '21', strategyVersionId: '31', symbol: 'XAUUSD',
    analysisId: 'analysis-private', analysisStrategyId: '20', analysisStrategyVersionId: '41', analysisHash: contentHash(result), result,
    inputSnapshotId: 'input-private', inputSnapshotHash: 'a'.repeat(64), inputCapturedAt: '2020-01-01T00:00:00.000Z',
    traderInputSnapshotId: 'trader-private', traderInputSnapshotHash: 'b'.repeat(64) }
  return { referenceId: 'position:opaque', userId: 70, accountId: '9', strategyId: '21', symbol: 'XAUUSD', asOf: '2026-09-10T00:00:00.000Z',
    creationDecisions: [{ orderTicket: 'order-private', decisionId: analysis.decisionId, riskDecisionId: analysis.riskDecisionId, strategyVersionId: '31' }],
    evidence: { ticket: 'ticket-private', status: 'read' as const, entries: [{ orderTicket: 'order-private', analysis }] } }
}
it('preserves all original timeframe conditions without sending private lineage or full prose to the model', () => {
  const input = entryFixture(), value = projectReferenceEntryEvidence(input), frozen = freezeReferenceEntryEvidence(value)
  expect(frozen).toMatchObject({ state: 'ready', purpose: 'creation_analysis_only', entries: [{ keyLevels: input.evidence.entries[0]!.analysis.result.keyLevels }] })
  for (const text of ['order-private', 'ticket-private', 'decision-private', 'risk-private', 'input-private', 'analysis-private', 'trader-private', 'long full prose']) expect(JSON.stringify(frozen)).not.toContain(text)
  input.evidence.entries[0]!.analysis.result.keyLevels = { changed: true }
  expect(JSON.stringify(frozen)).toContain('"active":true')
})
it('never fills missing historical evidence from a current analysis', () => {
  const input = entryFixture()
  expect(projectReferenceEntryEvidence({ ...input, evidence: undefined })).toMatchObject({ state: 'unavailable', reason: 'not_collected' })
  expect(projectReferenceEntryEvidence({ ...input, creationDecisions: null })).toMatchObject({ state: 'unavailable', reason: 'creation_decision_missing' })
})
it.each(['account', 'version', 'order', 'hash', 'future'])('rejects inconsistent entry lineage: %s', kind => {
  const input = entryFixture(), item = input.evidence.entries[0]!
  if (kind === 'account') item.analysis.accountId = '99'
  if (kind === 'version') item.analysis.strategyVersionId = '32'
  if (kind === 'order') item.orderTicket = 'other'
  if (kind === 'hash') item.analysis.result.summary = 'tampered'
  if (kind === 'future') input.asOf = '2019-01-01T00:00:00.000Z'
  expect(() => projectReferenceEntryEvidence(input)).toThrow('reference_entry_evidence_invalid')
})
it('marks oversized condition evidence unavailable without returning a truncated contribution', () => {
  const input = entryFixture(), analysis = input.evidence.entries[0]!.analysis
  analysis.result.keyLevels = { text: 'x'.repeat(33 * 1024) }; analysis.analysisHash = contentHash(analysis.result)
  expect(projectReferenceEntryEvidence(input)).toEqual({ schemaVersion: 1, state: 'unavailable', reason: 'capacity_exceeded' })
})
it('rejects rehashed extra private fields at the final model boundary', () => {
  const value = projectReferenceEntryEvidence(entryFixture())
  if (value.state !== 'ready') throw Error('fixture')
  value.entries[0]!.ticket = 'private'; value.evidenceHash = contentHash(value.entries)
  expect(() => freezeReferenceEntryEvidence(value)).toThrow('reference_entry_evidence_invalid')
})
it('retains distinct contributing orders and rejects missing/duplicate ones', () => {
  const input = entryFixture(), first = input.evidence.entries[0]!
  const second = { ...structuredClone(first), orderTicket: 'second-order' }
  second.analysis.decisionId = 'second-decision'; second.analysis.strategyVersionId = '32'
  input.creationDecisions.push({ orderTicket: second.orderTicket, decisionId: second.analysis.decisionId, riskDecisionId: second.analysis.riskDecisionId, strategyVersionId: '32' })
  input.evidence.entries.push(second)
  const value = projectReferenceEntryEvidence(input)
  expect(value.state === 'ready' ? value.entries.length : 0).toBe(2)
  input.evidence.entries[1]!.orderTicket = first.orderTicket
  expect(() => projectReferenceEntryEvidence(input)).toThrow('reference_entry_evidence_invalid')
})
it('bounds the aggregate historical evidence in the final model snapshot', async () => {
  const input = entryFixture(), analysis = input.evidence.entries[0]!.analysis
  analysis.result.keyLevels = { text: 'x'.repeat(29 * 1024) }; analysis.analysisHash = contentHash(analysis.result)
  const entryEvidence = projectReferenceEntryEvidence(input)
  const scope = { analysisId: '11111111-1111-4111-8111-111111111111', userId: 7, targetAccountId: '8', analysisStrategyId: '20', traderStrategyId: '21', symbol: 'XAUUSD', asOf: input.asOf }
  await expect(freezeStrategyReferencePortfolio(scope, { read: async () => ({ state: 'ready', scope, sourceAccountId: '9', observedAt: scope.asOf,
    positionsRevision: 1, pendingOrdersRevision: 1, pendingOrders: [], positions: Array.from({ length: 10 }, (_, index) => ({
      referenceId: `position:ref${index}`, side: 'buy', volume: '1', entryPrice: '2500', stopLoss: null, takeProfit: null, entryEvidence })) }) }))
    .rejects.toThrow('strategy_reference_entry_capacity_exceeded')
})

it('actually carries historical conditions through the portfolio reader into the frozen model snapshot',async()=>{
  const input=entryFixture(),scope={analysisId:'11111111-1111-4111-8111-111111111111',userId:7,targetAccountId:'8',analysisStrategyId:'20',traderStrategyId:'21',symbol:'XAUUSD',asOf:input.asOf}
  const data={source:{analysisId:scope.analysisId,sourceAccountId:'9'},inventory:{analysisStrategyId:'20',observedAt:scope.asOf,
    route:{accountId:'9',userId:70,platform:'mt5'},authorization:{userId:7,accountId:'9',operatorUserId:70,expiresAtUtc:'2026-09-10T00:01:00.000Z'},
    positions:{revision:1,items:[{ticket:'ticket-private',positionIdentifier:'position-private',symbol:'XAUUSD',side:'buy',volume:'1',openPrice:'2500',stopLoss:null,takeProfit:null}]},pendingOrders:{revision:1,items:[]}},
    pendingOrigins:[],positionOrigins:{status:'read',items:[{ticket:'ticket-private',status:'creation_strategy_matched',strategyId:'21',orderTickets:['order-private'],creationDecisions:input.creationDecisions}]},
    positionEvidence:{status:'read',items:[{ticket:'ticket-private',history:{status:'source_matched',lifecycle:{positionIdentifier:'position-private',side:'buy',volume:'1',contributingOrderTickets:['order-private']}}}]},
    positionEntryAnalyses:[input.evidence]} as unknown as StrategyReferenceEvidence
  const value=await freezeStrategyReferencePortfolio(scope,new ReadStrategyReferencePortfolio({read:async()=>data},()=>new Date(scope.asOf)))
  expect(value).toMatchObject({positions:[{entryEvidence:{state:'ready',purpose:'creation_analysis_only',entries:[{keyLevels:input.evidence.entries[0]!.analysis.result.keyLevels}]}}]})
  for(const raw of ['ticket-private','order-private','decision-private','risk-private'])expect(JSON.stringify(value)).not.toContain(raw)
})
