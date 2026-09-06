import { describe, expect, it } from 'vitest'
import { legacyStrategyFields, legacySubscriptionFields, reviewStrategySources } from '../scripts/lib/v4-strategy-source-review.mjs'
const blank = fields => Object.fromEntries(fields.map(field => [field, null]))
function input() {
  return { userIds: new Set(['7']), accountIds: new Set(['42']),
    strategies: [{ ...blank(legacyStrategyFields), id: '1', title: 'strategy', description: '', system_prompt: ' original prompt ',
      symbols_json: '["XAUUSD","EURUSD"]', scope: 'platform', owner_user_id: '0', created_by: '7', version: '44',
      is_active: '1', use_chan_analysis: '0', use_ema34_filter: '0', include_portfolio_context: '0', visibility_status: 'active' }],
    subscriptions: [{ ...blank(legacySubscriptionFields), id: '2', user_id: '7', trading_account_id: '42', strategy_id: '1', execution_enabled: '0', is_deleted: '0', schedule_enabled: '0' }],
  }
}
describe('legacy strategy source review', () => {
  it('preserves NULL inheritance and distinguishes explicit empty and explicit selection', () => {
    const data = input()
    const inherited = reviewStrategySources(data)
    expect(inherited.issues).toEqual([])
    expect(inherited.perSubscription[0]).toMatchObject({ symbolCount: 2, symbolSource: 'strategy_inherited' })
    data.subscriptions[0].symbols_json = '[]'
    expect(reviewStrategySources(data).perSubscription[0]).toMatchObject({ symbolCount: 0, symbolSource: 'subscription_explicit' })
    data.subscriptions[0].symbols_json = '["EURUSD"]'
    expect(reviewStrategySources(data).perSubscription[0].symbolCount).toBe(1)
  })
  it('does not turn malformed JSON into inherited symbols', () => {
    const data = input(); data.subscriptions[0].symbols_json = '{broken'
    const review = reviewStrategySources(data)
    expect(review.issues).toContainEqual(expect.objectContaining({ code: 'invalid_json_shape', field: 'symbols_json' }))
    expect(review.perSubscription[0].symbolCount).toBeNull()
  })
  it('keeps the current version number and hashes the exact prompt without publishing or inventing history', () => {
    const data = input(), review = reviewStrategySources(data)
    expect(review.perStrategy[0]).toMatchObject({ currentVersion: '44', targetKind: null, historicalVersionsReconstructed: false })
    data.strategies[0].system_prompt = 'original prompt'
    expect(reviewStrategySources(data).perStrategy[0].promptHash).not.toBe(review.perStrategy[0].promptHash)
    expect(review.executable).toBe(false)
    expect(JSON.stringify(review)).not.toContain('original prompt')
  })
  it('reports orphan references and target description overflow without truncating source', () => {
    const data = input(); data.strategies[0].description = '文'.repeat(2001); data.subscriptions[0].strategy_id = '99'
    const review = reviewStrategySources(data)
    expect(review.issues.map(issue => issue.code)).toEqual(expect.arrayContaining(['description_target_incompatible', 'strategy_missing']))
    expect(data.strategies[0].description).toHaveLength(2001)
  })
  it('rejects a missing source field and duplicate source IDs', () => {
    const data = input(); delete data.strategies[0].description
    expect(() => reviewStrategySources(data)).toThrow('source_shape')
    const duplicate = input(); duplicate.strategies.push({ ...duplicate.strategies[0] })
    expect(() => reviewStrategySources(duplicate)).toThrow('source_identity')
  })
})
