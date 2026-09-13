import { describe, expect, it } from 'vitest'
import { accountMoney } from './account-money'

describe('account decimal money display', () => {
  it.each([
    ['9007199254740993.125', '9,007,199,254,740,993.13 USD'],
    ['999999999999999999.995', '1,000,000,000,000,000,000.00 USD'],
    ['1.005', '1.01 USD'],
    ['-1.005', '-1.01 USD'],
    ['0.0049', '0.00 USD'],
    ['-0.0049', '0.00 USD'],
    ['0', '0.00 USD'],
  ])('rounds %s without losing decimal precision', (value, expected) => {
    expect(accountMoney(value, 'USD')).toBe(expected)
  })

  it.each([undefined, null, '', 'NaN', '1e10'])('keeps missing or invalid money unknown (%s)', value => {
    expect(accountMoney(value, 'USD')).toBe('--')
  })
})
