import { expect, it } from 'vitest'
import { positionProfitTotal } from './account-money'
it('sums mixed position profits exactly and preserves unknown versus empty', () => {
  expect(positionProfitTotal(['21.31', '-2.10', '0.09'], true)).toBe('19.30')
  expect(positionProfitTotal([], false)).toBeNull()
  expect(positionProfitTotal([], true)).toBe('0.00')
  expect(positionProfitTotal(['invalid'], true)).toBeNull()
})
