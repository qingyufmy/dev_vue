import { describe, expect, it } from 'vitest'
import { reviewSubscriptionConfig } from '../scripts/lib/v4-subscription-config-review.mjs'

const source = overrides => ({ user_id: '7', memory_mode: 'platform_only', take_profit_mode: 'ai_recommended',
  risk_profile_id: null, conflicting_strategy_id: null, execution_enabled: '1', is_deleted: '0', active_execution_user_key: '7', ...overrides })
const review = (overrides = {}, scope = 'platform', refs = {}) => reviewSubscriptionConfig(source(overrides), { scope }, { riskProfiles: [], strategies: [], ...refs })

describe('legacy subscription configuration review', () => {
  it('recognizes modes without granting execution or claiming completed migration', () => {
    const result = review()
    expect(result.status).toBe('recognized')
    expect(result.executable).toBe(false)
    expect(result.semantics.aiMissingRecommendationTier).toBe(1)
    expect(result.blockers).toContain('risk_configuration_authority')
  })
  it.each([['conservative', 1], ['standard', 2], ['trend', 3]])('preserves %s tier', (mode, tier) => {
    expect(review({ take_profit_mode: mode }).semantics.requestedTier).toBe(tier)
  })
  it('records normalization and rejects unknown modes instead of silently choosing TP1', () => {
    expect(review({ take_profit_mode: ' STANDARD ' }).semantics.requestedTier).toBe(2)
    expect(review({ take_profit_mode: 'future_mode' }).status).toBe('blocked')
    expect(review({ memory_mode: 'personal' }).status).toBe('blocked')
  })
  it('distinguishes private save aliases from proven runtime mapping', () => {
    for (const mode of [null, 'shared', 'isolated']) {
      const result = review({ memory_mode: mode }, 'private')
      expect(result.semantics.memorySaveMode).toBe('personal')
      expect(result.blockers).toContain('memory_runtime_mapping')
    }
    expect(review({ memory_mode: 'shadow' }, 'private').semantics.memorySaveMode).toBe('shadow')
  })
  it('checks exact reference IDs and owners without rounding large identifiers', () => {
    const id = '9007199254740993'
    expect(review({ risk_profile_id: id }, 'platform', { riskProfiles: [{ id, user_id: '8', status: 'active', deleted_at: null }] }).problems)
      .toContainEqual({ field: 'risk_profile_id', code: 'reference_owner_mismatch' })
    expect(review({ risk_profile_id: '0' }).status).toBe('blocked')
    expect(review({ conflicting_strategy_id: id }).status).toBe('blocked')
  })
  it('validates derived legacy keys without mapping them to account-level execution slots', () => {
    expect(review({ is_deleted: '1', active_execution_user_key: null }).status).toBe('recognized')
    expect(review({ is_deleted: '1' }).status).toBe('blocked')
    expect(() => review({ risk_profile_id: 1 })).toThrow('subscription_config_source_shape')
  })
})
