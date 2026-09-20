import { positivePercent } from '../../../shared/positive-percent.js'

interface StrategyRiskBudget {
  maximum: string
  fallback?: string
  regimes?: Record<string, string>
}
const units = (value: string) => {
  const [whole, fraction = ''] = value.split('.')
  return BigInt(whole!) * 10n ** 18n + BigInt(fraction.padEnd(18, '0'))
}

function parseBudget(raw: unknown): StrategyRiskBudget | undefined {
  if (raw === undefined) return undefined
  const fail = (): never => { throw new Error('strategy_risk_budget_invalid') }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail()
  const budget = raw as Record<string, unknown>, value = budget.max_risk_per_trade_percent
  try {
    const maximum = positivePercent(value)
    if (budget.version === 1 && Object.keys(budget).sort().join(',') === 'max_risk_per_trade_percent,version') return { maximum }
    if (budget.version !== 2 || Object.keys(budget).sort().join(',') !== 'default_risk_per_trade_percent,market_regime_limits,max_risk_per_trade_percent,version') return fail()
    const fallback = positivePercent(budget.default_risk_per_trade_percent), rawLimits = budget.market_regime_limits
    if (!rawLimits || typeof rawLimits !== 'object' || Array.isArray(rawLimits)) return fail()
    const entries = Object.entries(rawLimits)
    if (!entries.length || entries.length > 32 || units(fallback) > units(maximum)) return fail()
    const regimes: Record<string, string> = {}
    for (const [key, limit] of entries) {
      if (!/^[a-z][a-z0-9_]{0,63}$/.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key)) return fail()
      const percent = positivePercent(limit)
      if (units(percent) > units(maximum)) return fail()
      regimes[key] = percent
    }
    return { maximum, fallback, regimes }
  } catch { return fail() }
}

/** Kept compatible for fixed-budget consumers and compile-time validation. */
export function parseStrategyRiskBudget(raw: unknown): string | undefined {
  return parseBudget(raw)?.maximum
}

/** Only the verified original analysis may select a declared branch. */
export function resolveStrategyRiskBudget(raw: unknown, marketRegime?: string): {
  ceiling?: string; selection?: { marketRegime: string | null; source: 'declared_regime' | 'default' }
} {
  const budget = parseBudget(raw)
  if (!budget) return {}
  if (!budget.regimes) return { ceiling: budget.maximum }
  const matched = typeof marketRegime === 'string' && Object.hasOwn(budget.regimes, marketRegime)
  return { ceiling: matched ? budget.regimes[marketRegime!]! : budget.fallback!,
    selection: { marketRegime: marketRegime ?? null, source: matched ? 'declared_regime' : 'default' } }
}
