import { describe, expect, it } from 'vitest'
import { convertSubscriptionSymbols as convert } from '../scripts/lib/v4-subscription-symbol-conversion.mjs'

describe('subscription symbol conversion', () => {
  it('inherits only for NULL and preserves explicit empty', () => {
    expect(convert(null, '["XAUUSD","EURUSD"]')).toMatchObject({ selectionMode: 'inherit_strategy', status: 'converted', symbols: ['EURUSD', 'XAUUSD'] })
    expect(convert('[]', '["XAUUSD"]')).toMatchObject({ selectionMode: 'explicit', symbols: [] })
  })
  it('normalizes, deduplicates and intersects explicit choices with allowed instruments', () => {
    expect(convert('[" eurusd ","EURUSD","GBPUSD"]', '["EURUSD","XAUUSD"]')).toMatchObject({ symbols: ['EURUSD'] })
  })
  it('keeps unknown proprietary suffix handling and equity identity distinct', () => {
    expect(convert(null, '["XAUUSD.pro","EURUSD.vendor","BRK.B"]').symbols).toEqual(['BRK.B', 'EURUSD', 'XAUUSD'])
  })
  it('blocks when old scheduler rejects an instrument that dispatch would accept', () => {
    const result = convert('["XAUUSD.s"]', '["XAUUSD"]')
    expect(result).toMatchObject({ status: 'blocked', symbols: null, schedulerSymbols: [], dispatchSymbols: ['XAUUSD'] })
    expect(result.problems[0].code).toBe('legacy_symbol_paths_disagree')
  })
  it.each(['broken', 'null', '{}', '[123]', '[""]'])('does not reinterpret damaged or non-string choices %s', raw => {
    expect(convert(raw, '["XAUUSD"]')).toMatchObject({ status: 'blocked', symbols: null })
  })
  it('retains the exact source hash even when normalization gives the same result', () => {
    const first = convert('["eurusd"]', '["EURUSD"]'), second = convert('["EURUSD"]', '["EURUSD"]')
    expect(first.symbols).toEqual(second.symbols)
    expect(first.sourceHash).not.toBe(second.sourceHash)
  })
})
