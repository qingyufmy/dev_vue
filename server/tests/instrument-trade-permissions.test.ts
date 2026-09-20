import { expect, it } from 'vitest'
import { instrumentTradePermissions } from '../src/modules/trading/domain/instrument-trade-permissions.js'

it.each([
  [0, false, []], [1, true, ['buy']], [2, true, ['sell']], [3, true, []], [4, true, ['buy', 'sell']],
] as const)('preserves terminal trading mode %s', (mode, enabled, sides) => {
  for (const trade_mode of [mode, String(mode)]) expect(instrumentTradePermissions({ trade_mode }))
    .toEqual({ tradeEnabled: enabled, allowedOpenSides: sides })
})
it('never lets a normalized true flag override restricted terminal evidence', () => {
  expect(instrumentTradePermissions({ tradeEnabled: true, trade_mode: 3 }).allowedOpenSides).toEqual([])
  expect(instrumentTradePermissions({ tradeEnabled: false, trade_mode: 4 }).tradeEnabled).toBe(false)
  expect(instrumentTradePermissions({ tradeEnabled: true }).allowedOpenSides).toEqual(['buy', 'sell'])
})
it.each([-1, 5, 1.5, NaN, 'unknown', null])('rejects unknown mode %s', trade_mode => {
  expect(instrumentTradePermissions({ tradeEnabled: true, trade_mode })).toEqual({ tradeEnabled: false, allowedOpenSides: [] })
})
