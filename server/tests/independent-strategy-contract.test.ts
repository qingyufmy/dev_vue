import { describe, expect, it } from 'vitest'
import { compileStrategy } from '../src/modules/strategies/index.js'
import { traderTaskMode } from '../src/modules/inference/index.js'

const analysisConfig = {
  responsibility_mode: 'independent_roles_v2', symbols: ['XAUUSD'], interval_minutes: 60,
  market_data_plan: { version: 1, primary_timeframe: 'H1', timeframes: [
    { timeframe: 'H1', kline_count: 300 }, { timeframe: 'H4', kline_count: 300 },
  ] },
  chan_evidence: { version: 1, enabled: true }, price_action_evidence: { version: 1, enabled: false },
}
const traderConfig = {
  responsibility_mode: 'independent_roles_v2', symbols: ['XAUUSD'], entry_methods: ['market'],
  market_data_plan: { version: 1, primary_timeframe: 'M5', timeframes: [
    { timeframe: 'M5', kline_count: 300 }, { timeframe: 'M15', kline_count: 300 },
  ] },
  chan_evidence: { version: 1, enabled: false }, price_action_evidence: { version: 1, enabled: true },
}

describe('independent analyst and trader contracts', () => {
  it('compiles separate role data plans into v2 contracts', () => {
    expect(compileStrategy('analysis', '分析市场背景并明确证据、时效与失效条件。', analysisConfig)).toMatchObject({
      valid: true, inputContractVersion: 'market-background-input/v2', outputContractVersion: 'market-background/v2',
    })
    expect(compileStrategy('trader', '读取背景和当前价格行为，独立判断入场退出。', traderConfig)).toMatchObject({
      valid: true, inputContractVersion: 'independent-trader-input/v2', outputContractVersion: 'trade-decision/v2',
    })
  })

  it('rejects missing analyst Chan evidence and trader Chan leakage', () => {
    expect(compileStrategy('analysis', '分析市场背景。', { ...analysisConfig, chan_evidence: { version: 1, enabled: false } }).issues)
      .toEqual(expect.arrayContaining([expect.objectContaining({ code: 'background_chan_required' })]))
    expect(compileStrategy('trader', '判断交易。', { ...traderConfig, chan_evidence: { version: 1, enabled: true } }).issues)
      .toEqual(expect.arrayContaining([expect.objectContaining({ code: 'trader_chan_forbidden' })]))
  })

  it('does not use background opportunity as the independent entry permission', () => {
    expect(traderTaskMode('none', false, false, true, true)).toBe('entry')
    expect(traderTaskMode('none', true, false, true, true)).toBe('both')
    expect(traderTaskMode('long_setup', false, false, true, false)).toBeNull()
    expect(traderTaskMode('long_setup', true, false, true, false)).toBe('manage')
  })
})
