import type { PublicMarketState, StrategySubscription } from '@aurum/contracts'

const FRESH_MS = 45_000

export function automationMarketLabel(subscriptions: readonly StrategySubscription[], states: readonly PublicMarketState[], now: number) {
  const active = subscriptions.filter(item => item.status === 'active' && item.analysisEnabled)
  if (!active.length) return ''
  const stateBySymbol = new Map(states.map(item => [item.symbol.toUpperCase(), item]))
  const resolved = active.map(item => {
    const market = stateBySymbol.get(item.standardSymbol.toUpperCase())
    const checkedAt = market?.checked_at ? Date.parse(market.checked_at) : Number.NaN
    return market && Number.isFinite(checkedAt) && checkedAt <= now + 5_000 && now - checkedAt <= FRESH_MS ? market.state : 'unknown'
  })
  const open = resolved.filter(state => state === 'open').length
  if (open === resolved.length) return ''
  if (open > 0) return '部分运行'
  if (resolved.every(state => state === 'closed')) return '休市暂停'
  return '行情待确认'
}
