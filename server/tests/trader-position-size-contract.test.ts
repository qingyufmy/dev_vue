import { describe, expect, it } from 'vitest'
import { assertTraderDecisionResult, type TraderDecisionResult, type TraderInputSnapshot } from '../src/modules/inference/domain/inference.js'

const revisions = { analysisRevision: 1, subscriptionRevision: 1, accountRevision: 1, positionsRevision: 1,
  pendingOrdersRevision: 1, quoteRevision: 1, contractRevision: 1, riskRevision: 1 }
const snapshot: TraderInputSnapshot = { ...revisions, kind: 'trader', taskMode: 'entry', strategy: { id: '1', versionId: '2', promptText: '', promptHash: '' },
  analysis: { id: 'a', contentHash: '', result: {} }, account: {}, positions: [], pendingOrders: [], quote: {}, contract: {}, risk: {}, capturedAt: '2026-09-09T00:00:00.000Z',
  entryMethods: ['market', 'limit', 'stop', 'stop_limit'] }
function result(parameters = { symbol: 'XAUUSD', side: 'buy', position_size_tier: 'standard', stop_loss: '2490' } as Record<string, string | null>): TraderDecisionResult {
  return { action: 'market_order', side: 'buy', confidence: 80, summary: '测试', reasoning: '测试',
    actions: [{ actionId: '1', kind: 'market_order', parameters, expectedState: { ...revisions } }] }
}
describe('trader position sizing contract', () => {
  it('accepts a tightening action ceiling for fixed volume and tier openings', () => {
    for (const parameters of [{ symbol: 'XAUUSD', side: 'buy', volume: '0.1', risk_ceiling_percent: '0.5' },
      { symbol: 'XAUUSD', side: 'buy', position_size_tier: 'light', stop_loss: '2490', risk_ceiling_percent: '0.5' }]) {
      expect(() => assertTraderDecisionResult(result(parameters), snapshot)).not.toThrow()
    }
    const pending = result({ symbol: 'XAUUSD', type: 'buy_limit', volume: '0.1', price: '2500', risk_ceiling_percent: '100' })
    pending.action = 'pending_order'; pending.actions[0]!.kind = 'pending_order'
    expect(() => assertTraderDecisionResult(pending, snapshot)).not.toThrow()
  })
  it('rejects invalid ceilings and ceilings on management actions', () => {
    for (const cap of [null, 0.5, '0', '-1', '01', '1e-2', '100.000000000000000001', '0.0000000000000000001']) {
      const value = result(); value.actions[0]!.parameters.risk_ceiling_percent = cap
      expect(() => assertTraderDecisionResult(value, snapshot)).toThrow('trader_action_risk_ceiling_invalid')
    }
    const close = result({ ticket: '123', risk_ceiling_percent: '0.5' })
    close.action = 'close_position'; close.actions[0]!.kind = 'close_position'
    expect(() => assertTraderDecisionResult(close, snapshot)).toThrow('trader_action_risk_ceiling_kind_invalid')
  })
  it('accepts an explicit partial-close intent without model-computed volume', () => {
    const value = result({ ticket: '123', close_percent: '80' }); value.action = 'close_position'; value.actions[0]!.kind = 'close_position'
    expect(() => assertTraderDecisionResult(value, snapshot)).not.toThrow()
    value.actions[0]!.parameters.close_percent = '99.999999999999999999'
    expect(() => assertTraderDecisionResult(value, snapshot)).not.toThrow()
  })
  it('rejects ambiguous, non-close and invalid percentage intents', () => {
    const value = result({ ticket: '123', close_percent: '80' }); value.action = 'close_position'; value.actions[0]!.kind = 'close_position'
    for (const volume of ['0.1', null]) {
      value.actions[0]!.parameters.volume = volume
      expect(() => assertTraderDecisionResult(value, snapshot)).toThrow('trader_partial_close_mode_conflict')
    }
    delete value.actions[0]!.parameters.volume
    for (const percent of ['0', '100', '-1', '1e1', '80.0000000000000000001', null, 80]) {
      value.actions[0]!.parameters.close_percent = percent
      expect(() => assertTraderDecisionResult(value, snapshot)).toThrow('trader_partial_close_percent_invalid')
    }
    const opening = result(); opening.actions[0]!.parameters.close_percent = '80'
    expect(() => assertTraderDecisionResult(opening, snapshot)).toThrow('trader_partial_close_mode_conflict')
  })
  it.each(['probe', 'light', 'standard'])('accepts %s without requiring model-computed volume', tier => {
    const value = result(); value.actions[0]!.parameters.position_size_tier = tier
    expect(() => assertTraderDecisionResult(value, snapshot)).not.toThrow()
  })
  it('retains the explicit volume path and applies tier sizing to pending orders', () => {
    expect(() => assertTraderDecisionResult(result({ symbol: 'XAUUSD', side: 'buy', volume: '0.1' }), snapshot)).not.toThrow()
    const value = result(); value.action = 'pending_order'; value.actions[0]!.kind = 'pending_order'
    value.actions[0]!.parameters.type = 'buy_limit'; value.actions[0]!.parameters.price = '2500'
    expect(() => assertTraderDecisionResult(value, snapshot)).not.toThrow()
  })
  it('rejects volume or a custom factor alongside a tier, including null fields', () => {
    for (const [key, val] of [['volume', '0.1'], ['volume', null], ['position_size_factor', '0.5']]) {
      const value = result(); value.actions[0]!.parameters[key!] = val!
      expect(() => assertTraderDecisionResult(value, snapshot)).toThrow('trader_position_size_mode_conflict')
    }
  })
  it('rejects invalid tiers and missing or invalid model stop losses', () => {
    for (const tier of ['observe', 'STANDARD', '', 'custom', ['probe']]) {
      const value = result(); value.actions[0]!.parameters.position_size_tier = tier
      expect(() => assertTraderDecisionResult(value, snapshot)).toThrow('trader_position_size_tier_invalid')
    }
    for (const stop of [null, '0', '-1', 'NaN', '1e3', '01', '1.0000000000000000001']) {
      const value = result(); value.actions[0]!.parameters.stop_loss = stop
      expect(() => assertTraderDecisionResult(value, snapshot)).toThrow('trader_position_size_stop_required')
    }
  })
  it('does not allow a tier to reinterpret management actions', () => {
    const value = result(); value.action = 'close_position'; value.actions[0]!.kind = 'close_position'
    value.actions[0]!.parameters.ticket = '123'
    expect(() => assertTraderDecisionResult(value, snapshot)).toThrow('trader_position_tier_action_invalid')
  })
})
