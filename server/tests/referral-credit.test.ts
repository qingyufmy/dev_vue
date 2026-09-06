import { expect, it } from 'vitest'
import { projectReferralBalance, quoteReferralCredit } from '../src/modules/commerce/domain/referral-credit.js'

it('quotes partial and complete credit payments with exact eight-digit precision', () => {
  expect(quoteReferralCredit('80', '100.00000001', true)).toEqual({ balance: '80.00000000', orderAmount: '100.00000001',
    appliedCredit: '80.00000000', payableAmount: '20.00000001', remainingBalance: '0.00000000' })
  expect(quoteReferralCredit('80', '29', true)).toMatchObject({ appliedCredit: '29.00000000', payableAmount: '0.00000000', remainingBalance: '51.00000000' })
})
it('preserves negative opening balances and honours opting out', () => {
  expect(quoteReferralCredit('-0.00000001', '29', true)).toMatchObject({ appliedCredit: '0.00000000', remainingBalance: '-0.00000001' })
  expect(quoteReferralCredit('80', '29', false)).toMatchObject({ appliedCredit: '0.00000000', payableAmount: '29.00000000', remainingBalance: '80.00000000' })
})
it('debits and restores exact amounts without accumulated floating point errors', () => {
  const debit = projectReferralBalance('999999999999.99999999', '0.00000001', 'debit')
  expect(debit.nextBalance).toBe('999999999999.99999998')
  expect(projectReferralBalance(debit.nextBalance, '0.00000001', 'credit').nextBalance).toBe('999999999999.99999999')
  expect(projectReferralBalance('-2', '1', 'credit').nextBalance).toBe('-1.00000000')
})
it('rejects overdrafts and addition overflow', () => {
  expect(() => projectReferralBalance('1', '1.00000001', 'debit')).toThrow('referral_credit_insufficient')
  expect(() => projectReferralBalance('-1', '0.00000001', 'debit')).toThrow('referral_credit_insufficient')
  expect(() => projectReferralBalance('999999999999.99999999', '0.00000001', 'credit')).toThrow('referral_credit_overflow')
})
it.each([null, undefined, 0, 0.1, '1e2', 'NaN', ' 1', '1.000000001', '1000000000000'])('rejects invalid or lossy monetary input %s', value => {
  expect(() => quoteReferralCredit(value, '1', true)).toThrow('referral_credit_')
})
it('rejects negative prices and zero or negative ledger deltas', () => {
  expect(() => quoteReferralCredit('80', '-1', true)).toThrow('referral_credit_quote_invalid')
  expect(() => projectReferralBalance('80', '0', 'credit')).toThrow('referral_credit_change_invalid')
  expect(() => projectReferralBalance('80', '-1', 'credit')).toThrow('referral_credit_change_invalid')
})
