import { describe, expect, it } from 'vitest'
import { validateTraderControl } from '../src/modules/strategies/application/trader-control.js'

const rows = [
  { id: '1', revision: 2, status: 'active', analysisEnabled: true, traderStrategyId: '3' },
  { id: '2', revision: 4, status: 'active', analysisEnabled: true, traderStrategyId: null },
  { id: '3', revision: 1, status: 'paused', analysisEnabled: false, traderStrategyId: '3' },
]
const input = { userId: 1, accountId: '1', enabled: true, idempotencyKey: 'account-trader-key', expected: rows.map(({ id, revision }) => ({ id, revision })) }
describe('account trader control', () => {
  it('enables only configured active analysis subscriptions', () => {
    expect([...validateTraderControl(input, rows)]).toEqual(['1'])
  })
  it('disables all subscriptions without needing an available strategy', () => {
    expect([...validateTraderControl({ ...input, enabled: false }, rows)]).toEqual([])
  })
  it('rejects a changed or newly added subscription before applying any toggle', () => {
    expect(() => validateTraderControl(input, rows.map(row => ({ ...row, revision: row.revision + 1 })))).toThrow('strategy_subscription_revision_conflict')
    expect(() => validateTraderControl(input, rows.slice(1))).toThrow('strategy_subscription_revision_conflict')
  })
  it('rejects ambiguous duplicate revisions and missing configuration', () => {
    expect(() => validateTraderControl({ ...input, expected: [input.expected[0]!, input.expected[0]!] }, rows)).toThrow('strategy_write_invalid')
    expect(() => validateTraderControl({ ...input, expected: [] }, [])).toThrow('subscription_trader_required')
  })
})
