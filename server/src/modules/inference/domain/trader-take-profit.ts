import { selectSubscriptionTakeProfit } from '../../strategies/index.js'
import { InferenceError, type TraderDecisionResult, type TraderInputSnapshot } from './inference.js'

export function applyTraderTakeProfit(snapshot: TraderInputSnapshot, result: TraderDecisionResult): TraderDecisionResult {
  const preferences = snapshot.executionPreferences
  if (preferences === undefined) return result
  if (preferences.contractVersion !== 1 || typeof preferences.revision !== 'string' || !/^[1-9]\d*$/.test(preferences.revision)) {
    throw new InferenceError('subscription_execution_preferences_invalid', 422)
  }
  return { ...result, actions: result.actions.map(action => {
    // Subscription entry preferences do not change explicit protection changes,
    // cancellation or closing of existing positions/orders.
    if (action.kind !== 'market_order' && action.kind !== 'pending_order') return action
    let selection
    try {
      selection = selectSubscriptionTakeProfit(preferences.takeProfitMode, action.parameters.recommended_take_profit_tier, action.parameters.take_profit_prices)
    } catch (error) {
      throw new InferenceError(error instanceof Error ? error.message : 'subscription_take_profit_invalid', 422)
    }
    return { ...action, parameters: { ...action.parameters, take_profit: selection.price,
      take_profit_selection: { ...selection, preferenceRevision: preferences.revision,
        modelPrice: action.parameters.take_profit ?? null } } }
  }) }
}
