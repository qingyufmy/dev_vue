import { describe, it, expect, vi, beforeEach } from 'vitest'
import { randomBytes } from 'crypto'

const mockQueryOne = vi.fn()
const mockQueryAll = vi.fn()
const mockQueryRun = vi.fn()

vi.mock('../../server/db.js', () => ({
  queryOne: (...args) => mockQueryOne(...args),
  queryAll: (...args) => mockQueryAll(...args),
  queryRun: (...args) => mockQueryRun(...args),
  withTransaction: (...args) => Promise.resolve(),
  beijingNow: () => '2026-07-15 12:00:00',
  parseBeijing: (s) => s ? new Date(s) : null,
}))

const TEST_KEY = randomBytes(32).toString('base64')
process.env.AI_CREDENTIAL_KEYS_JSON = JSON.stringify({ '1': TEST_KEY })
process.env.AI_CREDENTIAL_ACTIVE_KEY_VERSION = '1'

import { resolveAiTaskModel, createModelProfile, setDefaultModelProfile } from '../../server/routes/ai/model-profiles.js'
import { encryptCredential, resetKeyringForTests } from '../../server/ai-credential.js'

beforeEach(() => {
  vi.clearAllMocks()
  resetKeyringForTests()
  process.env.AI_CREDENTIAL_KEYS_JSON = JSON.stringify({ '1': TEST_KEY })
  process.env.AI_CREDENTIAL_ACTIVE_KEY_VERSION = '1'
})

describe('resolveAiTaskModel', () => {
  describe('manual usage', () => {
    it('returns user default model with decrypted key', async () => {
      const enc = encryptCredential('user-key')
      mockQueryOne
        .mockResolvedValueOnce({ // getUserModelDefault JOIN (first query for manual)
          id: 10, owner_user_id: 1, provider: 'deepseek', model_name: 'deepseek-chat',
          api_key_encrypted: enc, key_version: '1',
          temperature: 0.3, max_tokens: 2000, thinking_enabled: 1, reasoning_effort: 'max',
          status: 'active',
        })

      const result = await resolveAiTaskModel({ userId: 1, strategyId: null, usage: 'manual' })
      expect(result.credential_source).toBe('user')
      expect(result.model.provider).toBe('deepseek')
      expect(result.model.api_key_encrypted).toBe('user-key')
    })

    it('falls back to platform shared with quota check', async () => {
      mockQueryOne
        .mockResolvedValueOnce(null) // getUserModelDefault
        .mockResolvedValueOnce({ // policy
          share_for_manual: 1, share_for_auto: 0, share_for_review: 0, share_for_memory_compression: 0,
          allowed_plans: JSON.stringify(['pro']), daily_requests_per_user: 100, daily_tokens_per_user: 500000,
        })
        .mockResolvedValueOnce({ // platform model
          id: 99, owner_user_id: 0, provider: 'deepseek', model_name: 'deepseek-chat',
          api_key_encrypted: encryptCredential('admin-key'), key_version: '1',
          temperature: 0.3, max_tokens: 2000, thinking_enabled: 1, reasoning_effort: 'max',
        })
        .mockResolvedValueOnce({ plan: 'pro' }) // user plan
        .mockResolvedValueOnce({ cnt: 5, tokens: 10000 }) // checkPlatformQuota: count query
        .mockResolvedValueOnce({ // checkPlatformQuota: getPlatformUsagePolicy
          share_for_manual: 1, share_for_auto: 0, share_for_review: 0, share_for_memory_compression: 0,
          allowed_plans: JSON.stringify(['pro']), daily_requests_per_user: 100, daily_tokens_per_user: 500000,
        })

      const result = await resolveAiTaskModel({ userId: 2, strategyId: null, usage: 'manual' })
      expect(result.credential_source).toBe('platform_shared')
      expect(result.model.api_key_encrypted).toBe('admin-key')
    })

    it('denies platform shared when quota exceeded', async () => {
      mockQueryOne
        .mockResolvedValueOnce(null) // getUserModelDefault
        .mockResolvedValueOnce({ // policy
          share_for_manual: 1, share_for_auto: 0, share_for_review: 0, share_for_memory_compression: 0,
          allowed_plans: JSON.stringify(['pro']), daily_requests_per_user: 10, daily_tokens_per_user: 500000,
        })
        .mockResolvedValueOnce({ // platform model
          id: 99, owner_user_id: 0, provider: 'deepseek', model_name: 'deepseek-chat',
          api_key_encrypted: encryptCredential('admin-key'), key_version: '1',
          temperature: 0.3, max_tokens: 2000, thinking_enabled: 1, reasoning_effort: 'max',
        })
        .mockResolvedValueOnce({ plan: 'pro' }) // user plan
        .mockResolvedValueOnce({ cnt: 15, tokens: 10000 }) // checkPlatformQuota: count query
        .mockResolvedValueOnce({ // checkPlatformQuota: getPlatformUsagePolicy
          share_for_manual: 1, share_for_auto: 0, share_for_review: 0, share_for_memory_compression: 0,
          allowed_plans: JSON.stringify(['pro']), daily_requests_per_user: 10, daily_tokens_per_user: 500000,
        })

      const result = await resolveAiTaskModel({ userId: 2, strategyId: null, usage: 'manual' })
      expect(result.credential_source).toBe('none')
      expect(result.error).toBe('daily_request_limit')
    })
  })

  describe('auto_private usage', () => {
    it('uses strategy-bound model with ownership check', async () => {
      mockQueryOne
        .mockResolvedValueOnce({ // apt ownership check
          owner_user_id: 1, model_profile_id: 5,
        })
        .mockResolvedValueOnce({ // bound profile
          id: 5, owner_user_id: 1, provider: 'deepseek', model_name: 'deepseek-chat',
          api_key_encrypted: encryptCredential('user-key'), key_version: '1',
          temperature: 0.3, max_tokens: 2000, thinking_enabled: 1, reasoning_effort: 'max',
        })

      const result = await resolveAiTaskModel({ userId: 1, strategyId: 10, usage: 'auto_private' })
      expect(result.credential_source).toBe('user')
      expect(result.reason).toBe('strategy_bound')
    })

    it('does not silently fall back when strategy bound model is invalid', async () => {
      mockQueryOne
        .mockResolvedValueOnce({ model_profile_id: 999 }) // apt has binding
        .mockResolvedValueOnce(null) // profile not found

      const result = await resolveAiTaskModel({ userId: 1, strategyId: 10, usage: 'auto_private' })
      expect(result.credential_source).toBe('none')
      expect(result.error).toBe('strategy_bound_model_invalid')
    })

    it('does not fall back when strategy bound model has no key', async () => {
      mockQueryOne
        .mockResolvedValueOnce({ owner_user_id: 1, model_profile_id: 5 })
        .mockResolvedValueOnce({
          id: 5, owner_user_id: 1, provider: 'deepseek', model_name: 'deepseek-chat',
          api_key_encrypted: null, key_version: '1',
        })

      const result = await resolveAiTaskModel({ userId: 1, strategyId: 10, usage: 'auto_private' })
      expect(result.credential_source).toBe('none')
      expect(result.error).toBe('strategy_bound_model_no_key')
    })
  })

  describe('auto_platform usage', () => {
    it('returns platform model', async () => {
      mockQueryOne.mockResolvedValueOnce({
        id: 99, owner_user_id: 0, scope: 'platform', provider: 'deepseek', model_name: 'deepseek-chat',
        api_key_encrypted: encryptCredential('admin-key'), key_version: '1',
        temperature: 0.3, max_tokens: 2000, thinking_enabled: 1, reasoning_effort: 'max',
      })

      const result = await resolveAiTaskModel({ userId: 1, strategyId: null, usage: 'auto_platform' })
      expect(result.credential_source).toBe('platform_primary')
    })
  })

  describe('authorization', () => {
    it('createModelProfile rejects platform scope from non-admin', async () => {
      await expect(createModelProfile(1, { scope: 'platform', api_key: 'test' }, 'pro'))
        .rejects.toThrow('platform_scope_requires_admin')
    })

    it('createModelProfile allows platform scope from admin', async () => {
      mockQueryRun.mockResolvedValueOnce({ insertId: 1 })
      mockQueryOne.mockResolvedValueOnce(null) // getModelProfileById
      // createModelProfile(userId, payload, callerRole)
      const result = await createModelProfile(0, { scope: 'platform', api_key: 'test' }, 'admin')
      expect(mockQueryRun).toHaveBeenCalled()
    })
  })

  describe('default model unification', () => {
    it('setDefaultModelProfile writes both is_default and user_model_defaults', async () => {
      mockQueryOne.mockResolvedValueOnce({ // profile exists
        id: 5, owner_user_id: 1, status: 'active',
      })
      mockQueryRun.mockResolvedValue({ affectedRows: 1 })

      await setDefaultModelProfile(1, 5)
      // Should have 3 queryRun calls: clear is_default, set is_default, upsert user_model_defaults
      expect(mockQueryRun).toHaveBeenCalledTimes(3)
      const calls = mockQueryRun.mock.calls.map(c => c[0])
      expect(calls.some(c => c.includes('user_model_defaults'))).toBe(true)
    })
  })

  describe('invalid usage', () => {
    it('throws on invalid usage type', async () => {
      await expect(resolveAiTaskModel({ userId: 1, strategyId: null, usage: 'invalid' }))
        .rejects.toThrow('invalid_usage:invalid')
    })
  })
})
