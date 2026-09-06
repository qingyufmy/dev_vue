import { describe, expect, it } from 'vitest'
import { convertReferralAccounts, reconcileReferralAccounts } from '../scripts/lib/v4-referral-conversion.mjs'

const stamp = '2026-09-07T12:00:00.123Z'
const source = (id, credit = '0.00000000', code = null) => ({ id, referral_code: code,
  referred_by: '', referral_credit: credit, created_at: '2020-01-01 12:00:00', updated_at: null })
const targets = rows => convertReferralAccounts(rows, stamp).entries.map(e => e.target)

describe('referral preservation and independent reconciliation', () => {
  it('preserves duplicate codes, NULL, empty strings, negatives and source clocks', () => {
    const rows = [source('3', '-0.00000001', 'ABC'), source('1'), source('2', '999999999999.99999999', 'ABC'), source('4', '0', '')]
    const result = convertReferralAccounts(rows, stamp)
    expect(result.entries.map(e => e.target.referral_code)).toEqual([null, 'ABC', 'ABC', ''])
    expect(result.entries[2].target.referral_credit).toBe('-0.00000001')
    expect(result.entries[0].source).toEqual(rows[1])
    expect(result.totalCreditUnits).toBe('99999999999999999998')
    expect(result.entries[0].target.updated_at_utc).toBe('2026-09-07 12:00:00.123')
    expect(reconcileReferralAccounts(rows, targets(rows).reverse(), stamp).rowsMatch).toBe(true)
  })
  it('does not confuse equal aggregate money with per-user reconciliation', () => {
    const rows = [source('1', '1'), source('2', '2')], actual = targets(rows)
    ;[actual[0].referral_credit, actual[1].referral_credit] = [actual[1].referral_credit, actual[0].referral_credit]
    const result = reconcileReferralAccounts(rows, actual, stamp)
    expect(result.totalMatches).toBe(true)
    expect(result.rowsMatch).toBe(false)
    expect(result.differences).toHaveLength(2)
  })
  it('rejects missing, extra, changed codes and changed migration metadata', () => {
    const rows = [source('1'), source('2', '0', 'A')], actual = targets(rows)
    actual[0].referral_code = ''
    actual[0].revision = '2'
    actual[0].updated_at_utc = '2026-09-07 12:00:00.124'
    actual[1].user_id = '3'
    expect(reconcileReferralAccounts(rows, actual, stamp).differences).toHaveLength(5)
  })
  it.each([null, 1.25, '1000000000000', '0.000000001', '1e2'])('rejects invalid or lossy money %s', credit => {
    expect(() => convertReferralAccounts([source('1', credit)], stamp)).toThrow()
  })
  it('rejects duplicate identities, extra fields and malformed Unicode', () => {
    expect(() => convertReferralAccounts([source('1'), source('1')], stamp)).toThrow()
    expect(() => convertReferralAccounts([{ ...source('1'), ignored: true }], stamp)).toThrow()
    expect(() => convertReferralAccounts([source('1', '0', '\ud800')], stamp)).toThrow()
    expect(() => reconcileReferralAccounts([source('1')], [...targets([source('1')]), ...targets([source('1')])], stamp)).toThrow()
  })
  it.each(['2026-09-07 12:00:00', '2026-02-30T12:00:00.000Z', '2026-09-07T12:00:00.000+03:00'])('requires a valid explicitly UTC frozen registration time %s', time => {
    expect(() => convertReferralAccounts([source('1')], time)).toThrow()
  })
  it('is deterministic across source ordering without mutating caller values', () => {
    const rows = [source('2'), source('1')], original = structuredClone(rows)
    expect(convertReferralAccounts(rows, stamp)).toEqual(convertReferralAccounts([...rows].reverse(), stamp))
    expect(rows).toEqual(original)
  })
})
