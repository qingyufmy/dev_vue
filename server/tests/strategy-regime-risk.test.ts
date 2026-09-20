import { expect, it } from 'vitest'
import { compileStrategy, parseStrategyRiskBudget, resolveStrategyRiskBudget } from '../src/modules/strategies/index.js'

const budget = { version: 2, max_risk_per_trade_percent: '1', default_risk_per_trade_percent: '0.5',
  market_regime_limits: { continuation: '1', reversal: '0.5' } }

it('keeps absent and v1 budgets compatible and selects exact declared regimes for v2', () => {
  expect(resolveStrategyRiskBudget(undefined)).toEqual({})
  expect(resolveStrategyRiskBudget({ version: 1, max_risk_per_trade_percent: '1' }, 'reversal')).toEqual({ ceiling: '1' })
  expect(parseStrategyRiskBudget(budget)).toBe('1')
  expect(compileStrategy('trader', 'declared budget', { risk_budget: budget }).valid).toBe(true)
  expect(resolveStrategyRiskBudget(budget, 'continuation')).toEqual({ ceiling: '1', selection: { marketRegime: 'continuation', source: 'declared_regime' } })
  for (const regime of ['reversal', 'unknown', 'Continuation', ' continuation', 'constructor', undefined]) {
    expect(resolveStrategyRiskBudget(budget, regime).ceiling).toBe('0.5')
  }
  expect(resolveStrategyRiskBudget(budget).selection).toEqual({ marketRegime: null, source: 'default' })
})

it('rejects malformed, unbounded and relaxing declarations with exact decimal comparisons', () => {
  for (const patch of [
    { version: 3 }, { extra: true }, { default_risk_per_trade_percent: '1.000000000000000001' },
    { market_regime_limits: { reversal: '1.000000000000000001' } }, { market_regime_limits: {} },
    { market_regime_limits: [] }, { market_regime_limits: { bad: 0.5 } },
    { market_regime_limits: { constructor: '0.5' } }, { market_regime_limits: { 'bad key': '0.5' } },
    { market_regime_limits: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`r${i}`, '0.5'])) },
  ]) {
    expect(() => resolveStrategyRiskBudget({ ...budget, ...patch })).toThrow('strategy_risk_budget_invalid')
    expect(compileStrategy('trader', 'declared budget', { risk_budget: { ...budget, ...patch } }).valid).toBe(false)
  }
  expect(resolveStrategyRiskBudget({ ...budget, max_risk_per_trade_percent: '1.000000000000000001',
    market_regime_limits: { fine: '1.000000000000000001' } }, 'fine').ceiling).toBe('1.000000000000000001')
})
