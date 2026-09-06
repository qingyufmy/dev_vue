import { describe, expect, it } from 'vitest'
import { compileStrategy } from '../src/modules/strategies/application/strategy-service.js'
import { assertTraderDecisionResult, type TraderDecisionResult, type TraderInputSnapshot } from '../src/modules/inference/domain/inference.js'

const revisions = { analysisRevision: 1, subscriptionRevision: 1, accountRevision: 1, positionsRevision: 1, pendingOrdersRevision: 1, quoteRevision: 1, contractRevision: 1, riskRevision: 1 }
const snapshot = { ...revisions, entryMethods: ['limit'] } as TraderInputSnapshot
const result = (kind: string, parameters: object) => ({ action: kind, side: 'buy', confidence: 80, summary: 'test', reasoning: 'test',
  actions: [{ actionId: '1', kind, parameters, expectedState: revisions }] }) as TraderDecisionResult

describe('strategy entry methods', () => {
  it.each([[], ['market', 'market'], ['future'], null])('rejects invalid trader configuration %j', entry_methods => {
    expect(compileStrategy('trader', '交易', { entry_methods }).valid).toBe(false)
  })
  it('accepts explicit methods without adding them to analysis configuration', () => {
    expect(compileStrategy('trader', '交易', { entry_methods: ['limit'] }).valid).toBe(true)
    expect(compileStrategy('analysis', '分析', { entry_methods: ['limit'] }).valid).toBe(false)
  })
  it.each(['buy_limit', 'sell_limit'])('accepts permitted pending action %s', type => {
    expect(() => assertTraderDecisionResult(result('pending_order', { symbol: 'XAUUSD', type, volume: '0.1', price: '1' }), snapshot)).not.toThrow()
  })
  it.each(['buy_stop', 'sell_stop', 'buy_stop_limit', 'sell_stop_limit'])('rejects unselected pending method %s', type => {
    expect(() => assertTraderDecisionResult(result('pending_order', { symbol: 'XAUUSD', type, volume: '0.1', price: '1' }), snapshot)).toThrow('trader_entry_method_forbidden')
  })
  it('rejects market entry while preserving management actions', () => {
    expect(() => assertTraderDecisionResult(result('market_order', { symbol: 'XAUUSD', side: 'buy', volume: '0.1' }), snapshot)).toThrow('trader_entry_method_forbidden')
    for (const kind of ['close_position', 'cancel_order', 'modify_position', 'modify_order']) {
      expect(() => assertTraderDecisionResult(result(kind, { ticket: '1' }), snapshot)).not.toThrow()
    }
  })
})
