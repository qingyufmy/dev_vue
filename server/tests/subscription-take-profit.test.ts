import { describe, expect, it } from 'vitest'
import { selectSubscriptionTakeProfit } from '../src/modules/strategies/domain/subscription-take-profit.js'

describe('subscription take profit selection', () => {
  it.each([['conservative', 1], ['standard', 2], ['trend', 3]] as const)('selects the configured %s tier regardless of AI recommendation', (mode, tier) => {
    const result = selectSubscriptionTakeProfit(mode, 1, ['11.00', '12.00', '13.00'])
    expect(result).toMatchObject({ source: 'subscription_preference', requestedTier: tier, usedTier: tier, price: `${10 + tier}.00` })
  })
  it('uses the AI recommendation and records its missing-recommendation fallback', () => {
    expect(selectSubscriptionTakeProfit('ai_recommended', 3, ['1', '2', '3'])).toMatchObject({ source: 'ai_recommended', price: '3' })
    expect(selectSubscriptionTakeProfit('ai_recommended', null, ['1', '2', '3'])).toMatchObject({ source: 'legacy_tp1_fallback', recommendedTier: null, requestedTier: 1, price: '1' })
  })
  it.each([null, '0', '000.000'])('does not switch tiers when the requested price is %s', value => {
    expect(selectSubscriptionTakeProfit('standard', 3, ['1', value, '3'])).toMatchObject({ requestedTier: 2, usedTier: null, price: null })
  })
  it('retains exact decimal precision and trailing zeros', () => {
    const price = '9007199254740993.00000000000000000100'
    expect(selectSubscriptionTakeProfit('trend', null, [null, null, price]).price).toBe(price)
  })
  it.each([1.1, '1e3', '-1', 'NaN', '', ' 1 ', true, {}])('rejects non-contract prices %j', price => {
    expect(() => selectSubscriptionTakeProfit('standard', 1, ['1', price, '3'])).toThrow('subscription_take_profit_price_invalid')
  })
  it('requires exactly three candidates and an explicit valid recommendation', () => {
    expect(() => selectSubscriptionTakeProfit('standard', null, ['1', '2'])).toThrow('subscription_take_profit_prices_invalid')
    expect(() => selectSubscriptionTakeProfit('standard', '2', ['1', '2', '3'])).toThrow('subscription_take_profit_recommendation_invalid')
  })
})
