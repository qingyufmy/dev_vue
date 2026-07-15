import { describe, it, expect, vi, beforeEach } from 'vitest'
import { randomBytes } from 'crypto'

// Mock DB before importing model-profiles
const mockQueryOne = vi.fn()
const mockQueryAll = vi.fn()
const mockQueryRun = vi.fn()
const mockWithTransaction = vi.fn()

vi.mock('../../server/db.js', () => ({
  queryOne: (...args) => mockQueryOne(...args),
  queryAll: (...args) => mockQueryAll(...args),
  queryRun: (...args) => mockQueryRun(...args),
  withTransaction: (...args) => mockWithTransaction(...args),
  beijingNow: () => '2026-07-15 12:00:00',
  parseBeijing: (s) => s ? new Date(s) : null,
}))

// Mock ai-credential
const TEST_KEY = randomBytes(32).toString('base64')
process.env.AI_CREDENTIAL_KEYS_JSON = JSON.stringify({ '1': TEST_KEY })
process.env.AI_CREDENTIAL_ACTIVE_KEY_VERSION = '1'

import { resolveAiTaskModel, migrateLegacyConfigs } from '../../server/routes/ai/model-profiles.js'
import { encryptCredential, resetKeyringForTests } from '../../server/ai-credential.js'

beforeEach(() => {
  vi.clearAllMocks()
  resetKeyringForTests()
  process.env.AI_CREDENTIAL_KEYS_JSON = JSON.stringify({ '1': TEST_KEY })
  process.env.AI_CREDENTIAL_ACTIVE_KEY_VERSION = '1'
})

describe('resolveAiTaskModel', () => {
  describe('manual usage', () => {
    it('returns user default model when available', async () => {
      mockQueryOne
        .mockResolvedValueOnce(null)  // user_model_defaults join
        .mockResolvedValueOnce({
          id: 10, owner_user_id: 1, provider: 'deepseek', model_name: 'deepseek-chat',
          api_key_encrypted: encryptCredential('user-key'), key_version: '1',
          temperature: 0.3, max_tokens: 2000, thinking_enabled: 1, reasoning_effort: 'max',
        })
        .mockResolvedValueOnce({ plan: 'pro' }) // user plan check

      // getUserModelDefault does a JOIN query
      mockQueryOne
        .mockReset()
        // getUserModelDefault query
        .mockResolvedValueOnce({
          id: 10, owner_user_id: 1, provider: 'deepseek', model_name: 'deepseek-chat',
          api_key_encrypted: encryptCredential('user-key'), key_version: '1',
          temperature: 0.3, max_tokens: 2000, thinking_enabled: 1, reasoning_effort: 'max',
          status: 'active',
        })

      const result = await resolveAiTaskModel({ userId: 1, strategyId: null, usage: 'manual' })
      expect(result.credential_source).toBe('user')
      expect(result.model.provider).toBe('deepseek')
      expect(result.model.api_key_encrypted).toBeTruthy()
    })

    it('falls back to platform shared when user has no model and admin allows', async () => {
      // getUserModelDefault returns null
      mockQueryOne
        .mockResolvedValueOnce(null)
        // getPlatformUsagePolicy
        .mockResolvedValueOnce({
          share_for_manual: 1, share_for_auto: 0, share_for_review: 0, share_for_memory_compression: 0,
          allowed_plans: JSON.stringify(['pro']), daily_requests_per_user: 100, daily_tokens_per_user: 500000,
        })
        // getPlatformModelForSharing
        .mockResolvedValueOnce({
          id: 99, owner_user_id: 0, provider: 'deepseek', model_name: 'deepseek-chat',
          api_key_encrypted: encryptCredential('admin-key'), key_version: '1',
          temperature: 0.3, max_tokens: 2000, thinking_enabled: 1, reasoning_effort: 'max',
        })
        // user plan
        .mockResolvedValueOnce({ plan: 'pro' })

      const result = await resolveAiTaskModel({ userId: 2, strategyId: null, usage: 'manual' })
      expect(result.credential_source).toBe('platform_shared')
      expect(result.reason).toBe('platform_fallback')
    })

    it('returns no model when user has no model and sharing disabled', async () => {
      mockQueryOne
        .mockResolvedValueOnce(null) // user default
        .mockResolvedValueOnce({
          share_for_manual: 0, share_for_auto: 0, share_for_review: 0, share_for_memory_compression: 0,
          allowed_plans: JSON.stringify(['pro']), daily_requests_per_user: 100, daily_tokens_per_user: 500000,
        })

      const result = await resolveAiTaskModel({ userId: 2, strategyId: null, usage: 'manual' })
      expect(result.credential_source).toBe('none')
      expect(result.error).toBe('no_model_configured')
    })
  })

  describe('auto_private usage', () => {
    it('uses strategy-bound model when available', async () => {
      // Strategy-bound model lookup
      mockQueryOne
        .mockResolvedValueOnce({
          id: 5, owner_user_id: 1, provider: 'deepseek', model_name: 'deepseek-chat',
          api_key_encrypted: encryptCredential('user-key'), key_version: '1',
          temperature: 0.3, max_tokens: 2000, thinking_enabled: 1, reasoning_effort: 'max',
        })

      const result = await resolveAiTaskModel({ userId: 1, strategyId: 10, usage: 'auto_private' })
      expect(result.credential_source).toBe('user')
      expect(result.reason).toBe('strategy_bound')
    })

    it('falls back to user default when strategy has no bound model', async () => {
      // Strategy has no model_profile_id
      mockQueryOne
        .mockResolvedValueOnce(null) // bound model join returns nothing
        .mockResolvedValueOnce({ model_profile_id: null }) // apt check
        .mockResolvedValueOnce({ // user default
          id: 10, owner_user_id: 1, provider: 'deepseek', model_name: 'deepseek-chat',
          api_key_encrypted: encryptCredential('user-key'), key_version: '1',
          temperature: 0.3, max_tokens: 2000, thinking_enabled: 1, reasoning_effort: 'max',
          status: 'active',
        })

      const result = await resolveAiTaskModel({ userId: 1, strategyId: 10, usage: 'auto_private' })
      expect(result.credential_source).toBe('user')
      expect(result.reason).toBe('user_default')
    })

    it('does not silently fall back when strategy bound model is invalid', async () => {
      // Strategy has a model_profile_id but the profile is gone
      mockQueryOne
        .mockResolvedValueOnce(null) // bound model join
        .mockResolvedValueOnce({ model_profile_id: 999 }) // apt has binding

      const result = await resolveAiTaskModel({ userId: 1, strategyId: 10, usage: 'auto_private' })
      expect(result.credential_source).toBe('none')
      expect(result.error).toBe('strategy_bound_model_invalid')
    })

    it('does not fall back when strategy bound model has no key', async () => {
      mockQueryOne
        .mockResolvedValueOnce({
          id: 5, owner_user_id: 1, provider: 'deepseek', model_name: 'deepseek-chat',
          api_key_encrypted: null, key_version: '1',
          temperature: 0.3, max_tokens: 2000, thinking_enabled: 1, reasoning_effort: 'max',
        })

      const result = await resolveAiTaskModel({ userId: 1, strategyId: 10, usage: 'auto_private' })
      expect(result.credential_source).toBe('none')
      expect(result.error).toBe('strategy_bound_model_no_key')
    })
  })

  describe('auto_platform usage', () => {
    it('returns platform model', async () => {
      mockQueryOne
        .mockResolvedValueOnce({
          id: 99, owner_user_id: 0, scope: 'platform', provider: 'deepseek', model_name: 'deepseek-chat',
          api_key_encrypted: encryptCredential('admin-key'), key_version: '1',
          temperature: 0.3, max_tokens: 2000, thinking_enabled: 1, reasoning_effort: 'max',
        })

      const result = await resolveAiTaskModel({ userId: 1, strategyId: null, usage: 'auto_platform' })
      expect(result.credential_source).toBe('platform_primary')
    })

    it('returns error when no platform model', async () => {
      mockQueryOne.mockResolvedValueOnce(null)
      const result = await resolveAiTaskModel({ userId: 1, strategyId: null, usage: 'auto_platform' })
      expect(result.credential_source).toBe('none')
      expect(result.error).toBe('no_platform_model')
    })
  })

  describe('review and memory_compression usage', () => {
    it('review falls back to platform when allowed', async () => {
      mockQueryOne
        .mockResolvedValueOnce(null) // user default
        .mockResolvedValueOnce({
          share_for_manual: 0, share_for_auto: 0, share_for_review: 1, share_for_memory_compression: 0,
          allowed_plans: JSON.stringify(['pro']), daily_requests_per_user: 100, daily_tokens_per_user: 500000,
        })
        .mockResolvedValueOnce({
          id: 99, owner_user_id: 0, provider: 'deepseek', model_name: 'deepseek-chat',
          api_key_encrypted: encryptCredential('admin-key'), key_version: '1',
          temperature: 0.3, max_tokens: 2000, thinking_enabled: 1, reasoning_effort: 'max',
        })
        .mockResolvedValueOnce({ plan: 'pro' })

      const result = await resolveAiTaskModel({ userId: 2, strategyId: null, usage: 'review' })
      expect(result.credential_source).toBe('platform_shared')
    })

    it('memory_compression falls back to platform when allowed', async () => {
      mockQueryOne
        .mockResolvedValueOnce(null) // user default
        .mockResolvedValueOnce({
          share_for_manual: 0, share_for_auto: 0, share_for_review: 0, share_for_memory_compression: 1,
          allowed_plans: JSON.stringify(['pro']), daily_requests_per_user: 100, daily_tokens_per_user: 500000,
        })
        .mockResolvedValueOnce({
          id: 99, owner_user_id: 0, provider: 'deepseek', model_name: 'deepseek-chat',
          api_key_encrypted: encryptCredential('admin-key'), key_version: '1',
          temperature: 0.3, max_tokens: 2000, thinking_enabled: 1, reasoning_effort: 'max',
        })
        .mockResolvedValueOnce({ plan: 'pro' })

      const result = await resolveAiTaskModel({ userId: 2, strategyId: null, usage: 'memory_compression' })
      expect(result.credential_source).toBe('platform_shared')
    })
  })

  describe('sharing switch enforcement', () => {
    it('does not share when auto sharing disabled', async () => {
      mockQueryOne
        .mockResolvedValueOnce(null) // user default
        .mockResolvedValueOnce({
          share_for_manual: 1, share_for_auto: 0, share_for_review: 0, share_for_memory_compression: 0,
          allowed_plans: JSON.stringify(['pro']), daily_requests_per_user: 100, daily_tokens_per_user: 500000,
        })

      const result = await resolveAiTaskModel({ userId: 2, strategyId: null, usage: 'auto_private' })
      expect(result.credential_source).toBe('none')
    })

    it('denies sharing when user plan not in allowed list', async () => {
      mockQueryOne
        .mockResolvedValueOnce(null) // user default
        .mockResolvedValueOnce({
          share_for_manual: 1, share_for_auto: 1, share_for_review: 1, share_for_memory_compression: 1,
          allowed_plans: JSON.stringify(['pro']), daily_requests_per_user: 100, daily_tokens_per_user: 500000,
        })
        .mockResolvedValueOnce({
          id: 99, owner_user_id: 0, provider: 'deepseek', model_name: 'deepseek-chat',
          api_key_encrypted: encryptCredential('admin-key'), key_version: '1',
          temperature: 0.3, max_tokens: 2000, thinking_enabled: 1, reasoning_effort: 'max',
        })
        .mockResolvedValueOnce({ plan: 'free' })

      const result = await resolveAiTaskModel({ userId: 2, strategyId: null, usage: 'manual' })
      expect(result.credential_source).toBe('none')
      expect(result.error).toBe('no_model_configured')
    })
  })

  describe('API safety', () => {
    it('never returns api_key in model object', async () => {
      mockQueryOne
        .mockResolvedValueOnce({
          id: 10, owner_user_id: 1, provider: 'deepseek', model_name: 'deepseek-chat',
          api_key_encrypted: encryptCredential('super-secret-key'), key_version: '1',
          temperature: 0.3, max_tokens: 2000, thinking_enabled: 1, reasoning_effort: 'max',
          status: 'active',
        })

      const result = await resolveAiTaskModel({ userId: 1, strategyId: null, usage: 'manual' })
      expect(result.model.api_key_encrypted).toBeTruthy()
      expect(result.model.api_key).toBeUndefined()
      // Verify the encrypted value can be decrypted but is not the raw key
      const { decryptCredential } = await import('../../server/ai-credential.js')
      const decrypted = decryptCredential(result.model.api_key_encrypted)
      expect(decrypted).toBe('super-secret-key')
    })

    it('returns credential_source and model_profile_id', async () => {
      mockQueryOne
        .mockResolvedValueOnce({
          id: 10, owner_user_id: 1, provider: 'deepseek', model_name: 'deepseek-chat',
          api_key_encrypted: encryptCredential('key'), key_version: '1',
          temperature: 0.3, max_tokens: 2000, thinking_enabled: 1, reasoning_effort: 'max',
          status: 'active',
        })

      const result = await resolveAiTaskModel({ userId: 1, strategyId: null, usage: 'manual' })
      expect(result).toHaveProperty('credential_source')
      expect(result).toHaveProperty('model_profile_id')
      expect(result).toHaveProperty('model_owner_user_id')
      expect(result).toHaveProperty('usage', 'manual')
    })
  })

  describe('invalid usage', () => {
    it('throws on invalid usage type', async () => {
      await expect(resolveAiTaskModel({ userId: 1, strategyId: null, usage: 'invalid' }))
        .rejects.toThrow('invalid_usage:invalid')
    })
  })
})
