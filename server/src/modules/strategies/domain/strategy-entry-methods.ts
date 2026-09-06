export const strategyEntryMethods = ['market', 'limit', 'stop', 'stop_limit'] as const
export type StrategyEntryMethod = typeof strategyEntryMethods[number]

export function parseStrategyEntryMethods(value: unknown): StrategyEntryMethod[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4 || new Set(value).size !== value.length
    || value.some(item => !strategyEntryMethods.includes(item))) throw new Error('strategy_entry_methods_invalid')
  return [...value] as StrategyEntryMethod[]
}

export function entryMethodForAction(kind: string, type: unknown): StrategyEntryMethod | null {
  if (kind === 'market_order') return 'market'
  if (kind !== 'pending_order') return null
  if (type === 'buy_limit' || type === 'sell_limit') return 'limit'
  if (type === 'buy_stop' || type === 'sell_stop') return 'stop'
  if (type === 'buy_stop_limit' || type === 'sell_stop_limit') return 'stop_limit'
  throw new Error('trader_pending_type_invalid')
}
