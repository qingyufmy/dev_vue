import { describe, expect, it } from 'vitest'
import { applyTraderTakeProfit } from '../src/modules/inference/domain/trader-take-profit.js'
import type { TraderDecisionResult, TraderInputSnapshot } from '../src/modules/inference/domain/inference.js'

const snapshot = { executionPreferences: { contractVersion: 1, revision: '8', takeProfitMode: 'standard' } } as TraderInputSnapshot
const result = { action: 'market_order', side: 'buy', confidence: 90, summary: 'entry', reasoning: 'test', actions: [
  { actionId: 'a', kind: 'market_order', expectedState: {}, parameters: { take_profit: '999', take_profit_prices: ['1.00', '2.00', '3.00'], recommended_take_profit_tier: 3 } },
] } satisfies TraderDecisionResult

describe('trader take profit application', () => {
  it('selects from frozen preferences, retains model evidence and does not mutate input', () => {
    const selected = applyTraderTakeProfit(snapshot, result)
    expect(selected.actions[0]!.parameters.take_profit).toBe('2.00')
    expect(selected.actions[0]!.parameters.take_profit_selection).toMatchObject({ modelPrice: '999', preferenceRevision: '8', requestedTier: 2, usedTier: 2 })
    expect(result.actions[0]!.parameters.take_profit).toBe('999')
  })
  it('does not backfill missing historical preferences from a default', () => {
    expect(applyTraderTakeProfit({} as TraderInputSnapshot, result)).toBe(result)
  })
  it.each(['modify_position', 'modify_order', 'close_position', 'cancel_order'] as const)('leaves %s protection and management untouched', kind => {
    const management = { ...result, action: kind, actions: [{ ...result.actions[0]!, kind, parameters: { ticket: '1', take_profit: '7.00' } }] }
    expect(applyTraderTakeProfit(snapshot, management).actions[0]).toBe(management.actions[0])
  })
  it('requires price evidence on new entries and rejects unsupported frozen contracts', () => {
    expect(() => applyTraderTakeProfit(snapshot, { ...result, actions: [{ ...result.actions[0]!, parameters: {} }] })).toThrow('subscription_take_profit_recommendation_invalid')
    expect(() => applyTraderTakeProfit({ ...snapshot, executionPreferences: { ...snapshot.executionPreferences!, revision: '0' } }, result)).toThrow('subscription_execution_preferences_invalid')
  })
  it('applies the same selection to pending entries and preserves missing price as null', () => {
    const pending = { ...result, action: 'pending_order' as const, actions: [{ ...result.actions[0]!, kind: 'pending_order' as const,
      parameters: { ...result.actions[0]!.parameters, take_profit_prices: ['1', null, '3'] } }] }
    expect(applyTraderTakeProfit(snapshot, pending).actions[0]!.parameters.take_profit).toBeNull()
  })
})
