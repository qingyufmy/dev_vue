import { expect, it } from 'vitest'
import { compileStrategy } from '../src/modules/strategies/application/strategy-service.js'
import { assertStrategySymbol } from '../src/modules/strategies/domain/strategy-runtime-settings.js'
import { strategyEditFields } from '../src/modules/strategies/domain/strategy-edit-fields.js'

it.each(['analysis', 'trader'] as const)('retains %s symbols and model selection in compiled runtime settings', kind => {
  const result = compileStrategy(kind, '根据系统提供的证据判断当前市场，缺少证据时保持观望。', { symbols: ['XAUUSD', 'EURUSD'], model_profile_id: '3' })
  expect(result.valid).toBe(true)
  expect(result.normalizedConfig).toMatchObject({ symbols: ['XAUUSD', 'EURUSD'], model_profile_id: '3' })
  expect(() => assertStrategySymbol(result.normalizedConfig, 'XAUUSD')).not.toThrow()
  expect(() => assertStrategySymbol(result.normalizedConfig, 'GBPUSD')).toThrow('strategy_symbol_unsupported')
})

it.each([{ symbols: ['XAUUSD.a'] }, { symbols: ['XAUUSD', 'XAUUSD'] }, { model_profile_id: 'bad' }, { model_profile_id: 3 }])('rejects invalid configuration %j', config => {
  expect(compileStrategy('analysis', '分析行情趋势并保持证据可验证。', config).valid).toBe(false)
})

it('keeps legacy unrestricted strategies working and validates status at the application boundary', () => {
  expect(() => assertStrategySymbol({}, 'XAUUSD')).not.toThrow()
  expect(() => assertStrategySymbol({ symbols: [] }, 'EURUSD')).not.toThrow()
  const input = { userId: 1, strategyId: '1', expectedRevision: 1, idempotencyKey: 'edit-test-123456789', promptText: '分析', config: {} }
  expect(strategyEditFields(input)).toEqual({})
  expect(strategyEditFields({ ...input, name: '黄金策略', description: '说明', status: 'draft' })).toEqual({ name: '黄金策略', description: '说明', status: 'draft' })
  expect(() => strategyEditFields({ ...input, name: ' ' })).toThrow()
})
