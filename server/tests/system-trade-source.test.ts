import { expect, it } from 'vitest'
import { resolveSystemTradeSource, type SystemDealProof } from '../src/modules/trade-history/application/system-trade-source.js'
import type { TerminalDealFact } from '../src/modules/trade-history/domain/terminal-history-projection.js'

function fixture() {
  const entry: TerminalDealFact = { kind: 'deal', ticket: '101', orderTicket: '201', positionId: '301',
    symbol: 'XAUUSD', dealKind: 'trade', entryKind: 'in', side: 'buy', volume: '1', price: '2500',
    grossProfit: '0', commission: '0', swap: '0', fee: '0', magic: null, terminalReason: null,
    terminalComment: null, occurredAtUtcMsc: 1000, evidenceHash: 'a'.repeat(64), evidenceJson: '{}',
    accountCurrency: 'USD', currencyEvidence: 'explicit_record' }
  const exit: TerminalDealFact = { ...entry, ticket: '102', orderTicket: '202', entryKind: 'out', side: 'sell', occurredAtUtcMsc: 2000 }
  const opening: SystemDealProof = { dealTicket: '101', orderTicket: '201', commandId: 'open-command', intentId: 'open-intent',
    action: 'order.place', resultHash: 'b'.repeat(64), decisionId: 'open-decision', riskDecisionId: 'open-risk', strategyId: '9', strategyVersionId: '10' }
  const closing: SystemDealProof = { ...opening, dealTicket: '102', orderTicket: '202', commandId: 'close-command',
    intentId: 'close-intent', action: 'position.close', decisionId: 'close-decision', riskDecisionId: 'close-risk' }
  return { facts: [entry, exit], proofs: [opening, closing] }
}

it('requires independent opening and closing receipts and freezes them in fact order', () => {
  const { facts, proofs } = fixture()
  const result = resolveSystemTradeSource(facts, [...proofs].reverse())
  expect(result).toEqual({ status: 'proven', strategyId: '9', strategyVersionId: '10', proofs })
  proofs[0]!.intentId = 'changed'
  if (result.status === 'proven') expect(result.proofs[0]!.intentId).toBe('open-intent')
})

it('does not use the opening receipt to infer manual, SL/TP or missing closing origin', () => {
  const { facts, proofs } = fixture()
  expect(resolveSystemTradeSource(facts, proofs.slice(0, 1))).toMatchObject({ status: 'unresolved', reason: 'system_trade_receipts_incomplete' })
  for (const replacement of [{ ...proofs[1]!, dealTicket: '103' }, { ...proofs[1]!, orderTicket: '203' },
    { ...proofs[1]!, action: 'order.place' as const }]) {
    expect(resolveSystemTradeSource(facts, [proofs[0]!, replacement])).toMatchObject({ status: 'unresolved', reason: 'system_trade_receipt_mismatch' })
  }
})

it('rejects mixed strategy identity or frozen version', () => {
  for (const change of [{ strategyId: '11' }, { strategyVersionId: '11' }]) {
    const { facts, proofs } = fixture()
    Object.assign(proofs[1]!, change)
    expect(resolveSystemTradeSource(facts, proofs)).toMatchObject({ status: 'unresolved', reason: 'system_trade_strategy_mixed' })
  }
})

it('rejects duplicate or extra proof and duplicate facts', () => {
  const { facts, proofs } = fixture()
  for (const supplied of [[proofs[0]!, proofs[0]!], [...proofs, { ...proofs[1]!, dealTicket: '103' }]]) {
    expect(resolveSystemTradeSource(facts, supplied)).toMatchObject({ status: 'unresolved', reason: 'system_trade_receipts_incomplete' })
  }
  expect(resolveSystemTradeSource([facts[0]!, facts[0]!], proofs)).toMatchObject({ status: 'unresolved', reason: 'system_trade_facts_invalid' })
})

it('leaves fees, reversals, mixed positions and open-only history unresolved', () => {
  for (const change of [{ dealKind: 'fee' as const }, { entryKind: 'inout' as const }, { positionId: '302' }]) {
    const { facts, proofs } = fixture()
    Object.assign(facts[1]!, change)
    expect(resolveSystemTradeSource(facts, proofs)).toMatchObject({ status: 'unresolved', reason: 'system_trade_lifecycle_source_incomplete' })
  }
  const { facts, proofs } = fixture()
  expect(resolveSystemTradeSource(facts.slice(0, 1), proofs.slice(0, 1))).toMatchObject({ status: 'unresolved', reason: 'system_trade_not_closed' })
  expect(resolveSystemTradeSource([], [])).toMatchObject({ status: 'unresolved' })
})
