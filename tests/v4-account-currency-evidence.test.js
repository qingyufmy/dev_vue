import { expect, it } from 'vitest'
import { reviewAccountCurrencyEvidence } from '../scripts/lib/v4-account-currency-evidence.mjs'
function fixture() {
  return { intervals: [{ id: '1', trading_account_id: '2' }, { id: '2', trading_account_id: '2' }],
    daily: [{ ownership_history_id: '1', trading_account_id: '2', business_date: '2020-01-01', account_currency: 'USD' }],
    totals: [{ ownership_history_id: '1', trading_account_id: '2', account_currency: 'USD' }],
    accountMap: new Map([['2', { targetAccountId: '3' }]]), entities: [{ targetAccountId: '3', currency: 'USD' }] }
}
it('deduplicates coverage across daily and total records without claiming immutable history', () => {
  const result = reviewAccountCurrencyEvidence(fixture())
  expect(result.counts).toMatchObject({ referencedIntervals: 1, unreferencedIntervals: 1, dailyRows: 1, totalRows: 1 })
  expect(result.recordedCurrencyConsistent).toBe(true)
  expect(result.historicalCurrencyProven).toBe(false); expect(result.historicalPlatformProven).toBe(false)
})
it('detects mismatched account references, missing currency and cross-currency conflicts', () => {
  const input = fixture(); input.daily[0].account_currency = 'EUR'; input.totals[0].trading_account_id = '99'
  expect(reviewAccountCurrencyEvidence(input).issues.map(issue => issue.code)).toEqual(expect.arrayContaining(['currency_differs_from_current_entity', 'currency_record_ownership_mismatch']))
  input.daily[0].account_currency = null
  expect(reviewAccountCurrencyEvidence(input).issues.map(issue => issue.code)).toContain('currency_missing_or_unrepresentable')
})
it('does not silently count duplicate facts and is stable under row order changes', () => {
  const input = fixture(), original = reviewAccountCurrencyEvidence(input)
  input.intervals.reverse(); expect(reviewAccountCurrencyEvidence(input).sourceHash).toBe(original.sourceHash)
  input.daily.push({ ...input.daily[0] })
  expect(reviewAccountCurrencyEvidence(input).issues.map(issue => issue.code)).toContain('duplicate_currency_record')
})
