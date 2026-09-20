import { StrategyAccessError } from '../domain/strategy.js'

export interface TraderControlInput {
  userId: number
  accountId: string
  enabled: boolean
  expected: { id: string; revision: number }[]
  idempotencyKey: string
}
export interface TraderControlSubscription {
  id: string; revision: number; status: string; analysisEnabled: boolean; traderStrategyId: string | null
}
export function validateTraderControl(input: TraderControlInput, current: TraderControlSubscription[]) {
  if (typeof input.enabled !== 'boolean' || !Array.isArray(input.expected) || input.expected.length > 200
    || new Set(input.expected.map(item => item.id)).size !== input.expected.length
    || input.expected.some(item => !Number.isSafeInteger(item.revision) || item.revision < 1)) {
    throw new StrategyAccessError('strategy_write_invalid', 400)
  }
  if (current.length !== input.expected.length || current.some(item => !input.expected.some(expected => expected.id === item.id && expected.revision === item.revision))) {
    throw new StrategyAccessError('strategy_subscription_revision_conflict', 412)
  }
  const eligible = current.filter(item => item.status === 'active' && item.analysisEnabled && item.traderStrategyId)
  if (input.enabled && !eligible.length) throw new StrategyAccessError('subscription_trader_required', 422)
  return new Set(input.enabled ? eligible.map(item => item.id) : [])
}
