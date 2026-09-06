export type SubscriptionTakeProfitMode = 'ai_recommended' | 'conservative' | 'standard' | 'trend'

export interface SubscriptionExecutionPreferences {
  contractVersion: 1
  takeProfitMode: SubscriptionTakeProfitMode
  revision: string
}

export interface SubscriptionTakeProfitSelection {
  mode: SubscriptionTakeProfitMode
  source: 'ai_recommended' | 'legacy_tp1_fallback' | 'subscription_preference'
  recommendedTier: 1 | 2 | 3 | null
  requestedTier: 1 | 2 | 3
  usedTier: 1 | 2 | 3 | null
  price: string | null
}

// Prices are explicit decimal text. Never round through Number or substitute
// another tier when the selected tier has no price.
export function selectSubscriptionTakeProfit(mode: SubscriptionTakeProfitMode, recommendedTier: unknown, prices: unknown): SubscriptionTakeProfitSelection {
  if (!['ai_recommended', 'conservative', 'standard', 'trend'].includes(mode)) throw new Error('subscription_take_profit_mode_invalid')
  if (recommendedTier !== null && recommendedTier !== 1 && recommendedTier !== 2 && recommendedTier !== 3) throw new Error('subscription_take_profit_recommendation_invalid')
  if (!Array.isArray(prices) || prices.length !== 3) throw new Error('subscription_take_profit_prices_invalid')
  for (const price of prices) {
    if (price !== null && (typeof price !== 'string' || price.length > 128 || !/^\d+(?:\.\d+)?$/.test(price))) {
      throw new Error('subscription_take_profit_price_invalid')
    }
  }
  const requestedTier = mode === 'ai_recommended' ? recommendedTier ?? 1 : mode === 'conservative' ? 1 : mode === 'standard' ? 2 : 3
  const selected = prices[requestedTier - 1] as string | null
  const price = selected !== null && /[1-9]/.test(selected) ? selected : null
  return { mode, source: mode === 'ai_recommended' ? recommendedTier === null ? 'legacy_tp1_fallback' : 'ai_recommended' : 'subscription_preference',
    recommendedTier, requestedTier, usedTier: price === null ? null : requestedTier, price }
}
