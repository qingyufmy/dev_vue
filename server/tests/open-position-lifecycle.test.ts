import { expect, it } from 'vitest'
import { reconcileOpenPositionLifecycle, type OpenPositionLifecycleInput } from '../src/modules/trade-history/domain/open-position-lifecycle.js'
import type { TerminalDealFact } from '../src/modules/trade-history/domain/terminal-history-projection.js'

function deal(ticket: string, entryKind: TerminalDealFact['entryKind'], side: TerminalDealFact['side'], volume: string, patch: Partial<TerminalDealFact> = {}): TerminalDealFact {
  return { kind: 'deal', ticket, orderTicket: ticket, positionId: '9007199254740993', symbol: 'XAUUSD', dealKind: 'trade', entryKind, side, volume,
    price: '2500', grossProfit: '0', commission: '0', swap: '0', fee: '0', magic: null, terminalReason: null, terminalComment: null,
    occurredAtUtcMsc: 1000, evidenceHash: 'a'.repeat(64), evidenceJson: '{}', accountCurrency: null, currencyEvidence: 'unknown', ...patch }
}
const input = (deals: TerminalDealFact[], patch: Partial<OpenPositionLifecycleInput> = {}): OpenPositionLifecycleInput => ({
  positionIdentifier: '9007199254740993', symbol: 'XAUUSD', side: 'buy', volume: '0.3', observedAtUtcMsc: 2000, deals, ...patch,
})

it('reconciles multiple fills and partial closes with exact decimals and numeric same-time ordering', () => {
  const rows = [deal('100', 'out', 'sell', '0.1'), deal('9', 'in', 'buy', '0.2'), deal('10', 'in', 'buy', '0.2')]
  const before = structuredClone(rows)
  expect(reconcileOpenPositionLifecycle(input(rows))).toEqual({ status: 'matches_snapshot', positionIdentifier: '9007199254740993',
    side: 'buy', volume: '0.3', contributingOrderTickets: ['9', '10'], dealTickets: ['9', '10', '100'] })
  expect(rows).toEqual(before)
})

it('retains potentially contributing entry orders after a partial close without inventing lot allocation', () => {
  expect(reconcileOpenPositionLifecycle(input([deal('1', 'in', 'buy', '0.2'), deal('2', 'in', 'buy', '0.2'),
    deal('3', 'out', 'sell', '0.3')], { volume: '0.1' }))).toMatchObject({ status: 'matches_snapshot', contributingOrderTickets: ['1', '2'] })
})

it('reversal closes old contributors and attributes only the remaining new exposure to the reversal order', () => {
  expect(reconcileOpenPositionLifecycle(input([deal('1', 'in', 'buy', '0.2'), deal('2', 'inout', 'sell', '0.5')], { side: 'sell' })))
    .toMatchObject({ status: 'matches_snapshot', contributingOrderTickets: ['2'], side: 'sell', volume: '0.3' })
})

it('clears old contributors after flat and retains distinct fills as evidence for a shared order', () => {
  expect(reconcileOpenPositionLifecycle(input([deal('1', 'in', 'buy', '0.2'), deal('2', 'out_by', 'sell', '0.2'),
    deal('3', 'in', 'buy', '0.1', { orderTicket: '99' }), deal('4', 'in', 'buy', '0.2', { orderTicket: '99' })])))
    .toMatchObject({ status: 'matches_snapshot', contributingOrderTickets: ['99'], dealTickets: ['1', '2', '3', '4'] })
})

it('handles uint64 identifiers and the smallest stored volume without floating point conversion', () => {
  expect(reconcileOpenPositionLifecycle(input([deal('18446744073709551615', 'in', 'buy', '0.00000001')], { volume: '0.00000001' })))
    .toMatchObject({ status: 'matches_snapshot', contributingOrderTickets: ['18446744073709551615'] })
})

it.each([
  { rows: [deal('1', 'out', 'sell', '0.3')] },
  { rows: [deal('1', 'in', 'buy', '0.2'), deal('2', 'out', 'sell', '0.5')] },
  { rows: [deal('1', 'in', 'buy', '0.2'), deal('2', 'out', 'buy', '0.1')] },
  { rows: [deal('1', 'in', 'buy', '0.2'), deal('2', 'in', 'sell', '0.5')] },
  { rows: [deal('1', 'in', 'buy', '0.2'), deal('2', 'inout', 'sell', '0.1')] },
  { rows: [deal('1', 'in', 'buy', '0.2'), deal('2', 'inout', 'sell', '0.2')] },
])('rejects impossible or incomplete event sequences: %j', ({ rows }) => {
  expect(reconcileOpenPositionLifecycle(input(rows))).toEqual({ status: 'unresolved', reason: 'lifecycle_invalid' })
})

it.each([
  { patch: { positionId: '99' } }, { patch: { symbol: 'EURUSD' } }, { patch: { occurredAtUtcMsc: 2001 } },
  { patch: { volume: '0.000000001' } }, { patch: { volume: '-0.3' } }, { patch: { orderTicket: null } },
  { patch: { ticket: '18446744073709551616' } }, { patch: { dealKind: 'correction' as const } },
])('rejects foreign, unscoped or unsupported facts: %j', ({ patch }) => {
  expect(reconcileOpenPositionLifecycle(input([deal('1', 'in', 'buy', '0.3', patch)])))
    .toEqual({ status: 'unresolved', reason: 'facts_invalid' })
})

it('rejects duplicate deals, missing identifier and mismatched final exposure', () => {
  const row = deal('1', 'in', 'buy', '0.3')
  expect(reconcileOpenPositionLifecycle(input([row, row]))).toMatchObject({ reason: 'facts_invalid' })
  expect(reconcileOpenPositionLifecycle(input([row], { positionIdentifier: null }))).toMatchObject({ reason: 'identifier_missing' })
  expect(reconcileOpenPositionLifecycle(input([row], { side: 'sell' }))).toMatchObject({ reason: 'snapshot_mismatch' })
  expect(reconcileOpenPositionLifecycle(input([row], { volume: '0.4' }))).toMatchObject({ reason: 'snapshot_mismatch' })
})

it('ignores only explicit zero-volume fee facts and does not claim completeness', () => {
  const rows = [deal('1', 'in', 'buy', '0.3'), deal('2', 'none', 'none', '0', { dealKind: 'fee' })]
  const result = reconcileOpenPositionLifecycle(input(rows))
  expect(result).toMatchObject({ status: 'matches_snapshot', dealTickets: ['1', '2'] })
  expect(result).not.toHaveProperty('complete')
  rows[1]!.volume = '0.1'
  expect(reconcileOpenPositionLifecycle(input(rows))).toMatchObject({ reason: 'facts_invalid' })
})
