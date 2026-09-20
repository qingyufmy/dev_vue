import { describe, expect, it } from 'vitest'
import { calculatePartialCloseVolume, resolvePartialCloseActions } from '../src/modules/risk/domain/partial-close-actions.js'

const size = (currentVolume = '0.10', closePercent = '80', volumeMin = '0.01', volumeMax = '100', volumeStep = '0.01') =>
  calculatePartialCloseVolume({ currentVolume, closePercent, volumeMin, volumeMax, volumeStep })
const input = () => ({ result: { actions: [{ actionId: 'close-1', kind: 'close_position' as const,
  parameters: { ticket: '1', close_percent: '80' }, expectedState: { contractRevision: 2, positionsRevision: 3 } }] },
  positions: [{ ticket: '1', symbol: 'XAUUSD', volume: '0.10' }],
  instrument: { symbol: 'XAUUSD', volumeMin: '0.01', volumeMax: '100', volumeStep: '0.01', revision: 2 },
  currentRevisions: { contract: 2, positions: 3 } })

describe('deterministic partial close sizing', () => {
  it('calculates 80 percent and preserves decimal precision', () => {
    expect(size()).toEqual({ volume: '0.08', remainingVolume: '0.02' })
    expect(size('0.000000000000000010', '80', '0.000000000000000001', '100', '0.000000000000000001'))
      .toEqual({ volume: '0.000000000000000008', remainingVolume: '0.000000000000000002' })
  })
  it('rounds down on the step lattice and retains a minimum remainder', () => {
    expect(size('0.07')).toEqual({ volume: '0.05', remainingVolume: '0.02' })
    expect(size('0.03', '99.999999999999999999')).toEqual({ volume: '0.02', remainingVolume: '0.01' })
    expect(size('1.25', '80', '0.25', '100', '0.25')).toEqual({ volume: '1', remainingVolume: '0.25' })
  })
  it('rejects impossible partial quantities instead of rounding up or closing all', () => {
    expect(() => size('0.01')).toThrow('partial_close_below_minimum')
    expect(() => size('0.02', '1')).toThrow('partial_close_below_minimum')
    expect(() => size('1', '80', '0.01', '0.1')).toThrow('partial_close_maximum_exceeded')
    expect(() => size('0.015')).toThrow('partial_close_limits_invalid')
  })
  it('rejects percentages and decimals outside the explicit partial contract', () => {
    for (const percent of ['0', '-1', '100', '101', '1e1', 'NaN', '01', '80.0000000000000000001']) expect(() => size('0.1', percent)).toThrow()
  })
  it('outputs only an explicit volume while retaining the original intent and audit evidence', () => {
    const value = input(), original = structuredClone(value), resolved = resolvePartialCloseActions(value)
    expect(resolved.actions[0]!.parameters).toEqual({ ticket: '1', volume: '0.08' })
    expect(resolved.rules[0]!.details).toMatchObject({ close_percent: '80', resolved_volume: '0.08', remaining_volume: '0.02', positions_revision: 3, contract_revision: 2 })
    expect(value).toEqual(original)
  })
  it('requires unique ticket, correct instrument and current revisions', () => {
    const wrongSymbol = input(); wrongSymbol.positions[0]!.symbol = 'EURUSD'
    expect(() => resolvePartialCloseActions(wrongSymbol)).toThrow('partial_close_target_invalid')
    const duplicate = input(); duplicate.positions.push({ ...duplicate.positions[0]! })
    expect(() => resolvePartialCloseActions(duplicate)).toThrow('partial_close_target_invalid')
    const repeated = input(); repeated.result.actions.push({ ...repeated.result.actions[0]!, actionId: 'close-2' })
    expect(() => resolvePartialCloseActions(repeated)).toThrow('partial_close_target_conflict')
    const stale = input(); stale.instrument.revision = 4
    expect(() => resolvePartialCloseActions(stale)).toThrow('partial_close_revision_stale')
  })
})

it.each(['XAUUSD.s', 'XAUUSD.c', 'xauusdAnySuffix'])('matches standard instrument to actual position %s without changing its ticket', symbol => {
  const value = input()
  value.positions[0]!.symbol = symbol
  expect(resolvePartialCloseActions(value).actions[0]!.parameters).toEqual({ ticket: '1', volume: '0.08' })
  expect(value.positions[0]!.symbol).toBe(symbol)
})
