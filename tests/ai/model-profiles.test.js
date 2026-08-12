import { beforeEach, describe, expect, it, vi } from 'vitest'
import { randomBytes } from 'crypto'

const mockQueryOne = vi.fn()
const mockQueryAll = vi.fn()
const mockQueryRun = vi.fn()
const mockWithTransaction = vi.fn()
const mockTx = vi.fn()

vi.mock('../../server/db.js', () => ({
  queryOne: (...args) => mockQueryOne(...args),
  queryAll: (...args) => mockQueryAll(...args),
  queryRun: (...args) => mockQueryRun(...args),
  withTransaction: (...args) => mockWithTransaction(...args),
  beijingNow: () => '2026-07-15 12:00:00',
  parseBeijing: value => value ? new Date(value) : null,
}))

const TEST_KEY = randomBytes(32).toString('base64')

import {
  beginModelUsage,
  assertModelProfileSchemaReady,
  checkPlatformQuota,
  createModelProfile,
  deleteModelProfile,
  finishModelUsage,
  getModelProfileDeletionImpact,
  migrateLegacyConfigs,
  normalizeModelTokenLimits,
  prepareModelProfileForSave,
  recoverStaleModelUsageReservations,
  resolveAiTaskModel,
  saveModelProfileWithValidation,
  setDefaultModelProfile,
  updateModelProfile,
} from '../../server/routes/ai/model-profiles.js'
import { encryptCredential, resetKeyringForTests } from '../../server/ai-credential.js'

const policy = (overrides = {}) => ({
  share_for_manual: 0,
  share_for_auto: 0,
  share_for_review: 0,
  share_for_memory_compression: 0,
  allowed_plans: JSON.stringify(['pro']),
  daily_requests_per_user: 100,
  daily_tokens_per_user: 500000,
  ...overrides,
})

const profile = (overrides = {}) => ({
  id: 10,
  owner_user_id: 1,
  scope: 'user',
  provider: 'qwen',
  model_name: 'qwen-plus',
  api_base_url: 'https://example.test/v1',
  api_key_encrypted: encryptCredential('user-key'),
  key_version: '1',
  temperature: 0.3,
  max_tokens: 2000,
  context_window_tokens: 1048576,
  max_input_tokens: 1048576,
  max_output_tokens: 393216,
  token_limits_source: 'manual_confirmed',
  token_limits_status: 'confirmed',
  thinking_enabled: 0,
  reasoning_effort: 'max',
  status: 'active',
  ...overrides,
})

beforeEach(() => {
  vi.clearAllMocks()
  resetKeyringForTests()
  process.env.AI_CREDENTIAL_KEYS_JSON = JSON.stringify({ '1': TEST_KEY })
  process.env.AI_CREDENTIAL_ACTIVE_KEY_VERSION = '1'
  mockWithTransaction.mockImplementation(fn => fn(mockTx))
})

describe('resolveAiTaskModel', () => {
  it('returns a decrypted user default and preserves provider aliases', async () => {
    mockQueryOne.mockResolvedValueOnce(profile())
    const result = await resolveAiTaskModel({ userId: 1, strategyId: null, usage: 'manual' })
    expect(result.credential_source).toBe('user')
    expect(result.model.api_key_encrypted).toBe('user-key')
    expect(result.model.provider).toBe('qwen')
    expect(result.model.api_provider).toBe('qwen')
  })

  it('rejects a plaintext credential stored in a profile', async () => {
    mockQueryOne.mockResolvedValueOnce(profile({ api_key_encrypted: 'plain-key' }))
    const result = await resolveAiTaskModel({ userId: 1, strategyId: null, usage: 'manual' })
    expect(result.model).toBeNull()
    expect(result.error).toBe('credential_not_encrypted')
  })

  it('falls back to a platform model only when sharing and plan allow it', async () => {
    mockQueryOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(policy({ share_for_manual: 1 }))
      .mockResolvedValueOnce(profile({ id: 99, owner_user_id: 0, scope: 'platform', api_key_encrypted: encryptCredential('admin-key') }))
      .mockResolvedValueOnce({ plan: 'pro' })
    const result = await resolveAiTaskModel({ userId: 2, strategyId: null, usage: 'manual' })
    expect(result.credential_source).toBe('platform_shared')
    expect(result.model.api_key_encrypted).toBe('admin-key')
  })

  it('accepts JSON policy columns already decoded by the database driver', async () => {
    mockQueryOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(policy({ share_for_manual: 1, allowed_plans: ['pro'] }))
      .mockResolvedValueOnce(profile({ id: 99, owner_user_id: 0, scope: 'platform', api_key_encrypted: encryptCredential('admin-key') }))
      .mockResolvedValueOnce({ plan: 'pro' })
    const result = await resolveAiTaskModel({ userId: 2, strategyId: null, usage: 'manual' })
    expect(result.credential_source).toBe('platform_shared')
  })

  it('does not share when the usage switch is disabled', async () => {
    mockQueryOne.mockResolvedValueOnce(null).mockResolvedValueOnce(policy())
    const result = await resolveAiTaskModel({ userId: 2, strategyId: null, usage: 'manual' })
    expect(result.error).toBe('no_model_configured')
  })

  it('does not share a platform model with an expired Pro member', async () => {
    mockQueryOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(policy({ share_for_manual: 1 }))
      .mockResolvedValueOnce(profile({ id: 99, owner_user_id: 0, scope: 'platform' }))
      .mockResolvedValueOnce({ plan: 'pro', plan_expires_at: '2020-01-01 00:00:00' })
    const result = await resolveAiTaskModel({ userId: 2, strategyId: null, usage: 'manual' })
    expect(result.error).toBe('no_model_configured')
  })

  it('shares a Kimi Code platform subscription when the usage switch and plan allow it', async () => {
    mockQueryOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(policy({ share_for_manual: 1 }))
      .mockResolvedValueOnce(profile({ owner_user_id: 0, scope: 'platform', provider: 'kimi_code' }))
      .mockResolvedValueOnce({ plan: 'pro' })
    const result = await resolveAiTaskModel({ userId: 2, strategyId: null, usage: 'manual' })
    expect(result).toMatchObject({ credential_source: 'platform_shared', model: { provider: 'kimi_code' } })
    expect(mockQueryOne).toHaveBeenCalledTimes(4)
  })

  it('does not share with a disallowed plan', async () => {
    mockQueryOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(policy({ share_for_review: 1 }))
      .mockResolvedValueOnce(profile({ owner_user_id: 0, scope: 'platform' }))
      .mockResolvedValueOnce({ plan: 'free' })
    const result = await resolveAiTaskModel({ userId: 2, strategyId: null, usage: 'review' })
    expect(result.error).toBe('no_model_configured')
  })

  it('auto_private validates strategy ownership then uses the requesting user default', async () => {
    mockQueryOne
      .mockResolvedValueOnce({ id: 123, scope: 'private', owner_user_id: 1, model_profile_id: null, visibility_status: 'active', is_active: 1 })
      .mockResolvedValueOnce(profile())
    const result = await resolveAiTaskModel({ userId: 1, strategyId: 123, usage: 'auto_private' })
    expect(result.credential_source).toBe('user')
    expect(mockQueryOne.mock.calls[0][0]).toContain('owner_user_id')
    expect(mockQueryOne.mock.calls[1][0]).toContain('user_model_defaults')
    expect(result.strategy_id).toBe(123)
  })

  it('uses an explicit same-owner private strategy model', async () => {
    mockQueryOne
      .mockResolvedValueOnce({ id: 123, scope: 'private', owner_user_id: 1, model_profile_id: 77, visibility_status: 'active', is_active: 1 })
      .mockResolvedValueOnce(profile({ id: 77 }))
    const result = await resolveAiTaskModel({ userId: 1, strategyId: 123, usage: 'auto_private' })
    expect(result.reason).toBe('strategy_binding')
    expect(result.model_profile_id).toBe(77)
  })

  it('does not fall back when an explicit private strategy model is unavailable', async () => {
    mockQueryOne
      .mockResolvedValueOnce({ id: 123, scope: 'private', owner_user_id: 1, model_profile_id: 77, visibility_status: 'active', is_active: 1 })
      .mockResolvedValueOnce(null)
    const result = await resolveAiTaskModel({ userId: 1, strategyId: 123, usage: 'auto_private' })
    expect(result.error).toBe('bound_model_unavailable')
    expect(mockQueryOne).toHaveBeenCalledTimes(2)
  })

  it('rejects cross-user and inactive private strategy execution', async () => {
    mockQueryOne.mockResolvedValueOnce({ id: 123, scope: 'private', owner_user_id: 9, model_profile_id: null, visibility_status: 'active', is_active: 1 })
    const denied = await resolveAiTaskModel({ userId: 1, strategyId: 123, usage: 'auto_private' })
    expect(denied.error).toBe('private_strategy_access_denied')

    mockQueryOne.mockResolvedValueOnce({ id: 123, scope: 'private', owner_user_id: 1, model_profile_id: null, visibility_status: 'draft', is_active: 1 })
    const inactive = await resolveAiTaskModel({ userId: 1, strategyId: 123, usage: 'auto_private' })
    expect(inactive.error).toBe('private_strategy_not_active')
  })

  it('uses the independent memory compression switch', async () => {
    mockQueryOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(policy({ share_for_memory_compression: 1 }))
      .mockResolvedValueOnce(profile({ owner_user_id: 0, scope: 'platform' }))
      .mockResolvedValueOnce({ plan: 'pro' })
    const result = await resolveAiTaskModel({ userId: 2, strategyId: null, usage: 'memory_compression' })
    expect(result.credential_source).toBe('platform_shared')
  })

  it('uses the model bound to a private strategy for review', async () => {
    mockQueryOne
      .mockResolvedValueOnce({ id: 123, scope: 'private', owner_user_id: 1, model_profile_id: 77, visibility_status:'active', is_active:1 })
      .mockResolvedValueOnce(profile({ id: 77 }))
    const result = await resolveAiTaskModel({ userId: 1, strategyId: 123, usage: 'review' })
    expect(result).toMatchObject({ credential_source:'user', reason:'strategy_binding', strategy_id:123, model_profile_id:77 })
  })

  it('uses the platform strategy model for administrator review', async () => {
    mockQueryOne
      .mockResolvedValueOnce({ id: 12, scope: 'platform', owner_user_id: 0, model_profile_id: null, visibility_status:'active', is_active:1 })
      .mockResolvedValueOnce(profile({ id: 88, owner_user_id: 0, scope: 'platform' }))
    const result = await resolveAiTaskModel({ userId: 1, strategyId: 12, usage: 'review' })
    expect(result).toMatchObject({ credential_source:'platform_primary', usage:'review', strategy_id:12, model_profile_id:88 })
  })

  it('uses the model bound to a private strategy for unified memory compression', async () => {
    mockQueryOne
      .mockResolvedValueOnce({ id:123, scope:'private', owner_user_id:1, model_profile_id:77, visibility_status:'active', is_active:1 })
      .mockResolvedValueOnce(profile({ id:77 }))
    const result = await resolveAiTaskModel({ userId:1, strategyId:123, usage:'memory_compression' })
    expect(result).toMatchObject({ credential_source:'user', reason:'strategy_binding', strategy_id:123, model_profile_id:77 })
  })

  it('returns the primary platform model for auto_platform', async () => {
    mockQueryOne.mockResolvedValueOnce(profile({ owner_user_id: 0, scope: 'platform' }))
    const result = await resolveAiTaskModel({ userId: 1, strategyId: null, usage: 'auto_platform' })
    expect(result.credential_source).toBe('platform_primary')
  })

  it('uses an explicit active platform model bound to a platform strategy', async () => {
    mockQueryOne
      .mockResolvedValueOnce({ id: 12, scope: 'platform', model_profile_id: 88, visibility_status: 'active', is_active: 1 })
      .mockResolvedValueOnce(profile({ id: 88, owner_user_id: 0, scope: 'platform' }))
    const result = await resolveAiTaskModel({ userId: 1, strategyId: 12, usage: 'auto_platform' })
    expect(result.reason).toBe('strategy_binding')
    expect(result.model_profile_id).toBe(88)
    expect(result.strategy_id).toBe(12)
  })

  it('does not hide an unavailable bound platform model behind the default', async () => {
    mockQueryOne
      .mockResolvedValueOnce({ id: 12, scope: 'platform', model_profile_id: 88, visibility_status: 'active', is_active: 1 })
      .mockResolvedValueOnce(null)
    const result = await resolveAiTaskModel({ userId: 1, strategyId: 12, usage: 'auto_platform' })
    expect(result.error).toBe('bound_model_unavailable')
    expect(mockQueryOne).toHaveBeenCalledTimes(2)
  })

  it('uses the confirmed platform default for manual platform strategies without a binding', async () => {
    mockQueryOne
      .mockResolvedValueOnce({ id: 1, scope: 'platform', owner_user_id: 0, model_profile_id: null,
        visibility_status: 'active', is_active: 1 })
      .mockResolvedValueOnce(profile({ id: 12, owner_user_id: 0, scope: 'platform', model_name: 'K3' }))
    const result = await resolveAiTaskModel({ userId: 1, strategyId: 1, usage: 'manual' })
    expect(result).toMatchObject({ credential_source:'platform_primary', strategy_id:1,
      model_profile_id:12, reason:'platform_primary', model:{ model_name:'K3' } })
    expect(mockQueryOne).toHaveBeenCalledTimes(2)
  })

  it('uses an explicit confirmed platform model bound to a manual platform strategy', async () => {
    mockQueryOne
      .mockResolvedValueOnce({ id: 1, scope: 'platform', owner_user_id: 0, model_profile_id: 88,
        visibility_status: 'active', is_active: 1 })
      .mockResolvedValueOnce(profile({ id: 88, owner_user_id: 0, scope: 'platform', model_name: 'K3-bound' }))
    const result = await resolveAiTaskModel({ userId: 1, strategyId: 1, usage: 'manual' })
    expect(result).toMatchObject({ credential_source:'platform_primary', reason:'strategy_binding',
      strategy_id:1, model_profile_id:88, model:{ model_name:'K3-bound' } })
  })

  it('does not fall back when a manual platform strategy binding is unavailable', async () => {
    mockQueryOne
      .mockResolvedValueOnce({ id: 1, scope: 'platform', owner_user_id: 0, model_profile_id: 88,
        visibility_status: 'active', is_active: 1 })
      .mockResolvedValueOnce(null)
    const result = await resolveAiTaskModel({ userId: 1, strategyId: 1, usage: 'manual' })
    expect(result).toMatchObject({ error:'bound_model_unavailable', strategy_id:1, model_profile_id:88 })
    expect(mockQueryOne).toHaveBeenCalledTimes(2)
  })

  it('rejects an inactive manual platform strategy before resolving any model', async () => {
    mockQueryOne.mockResolvedValueOnce({ id: 1, scope: 'platform', owner_user_id: 0, model_profile_id: null,
      visibility_status: 'draft', is_active: 0 })
    const result = await resolveAiTaskModel({ userId: 1, strategyId: 1, usage: 'manual' })
    expect(result).toMatchObject({ error:'platform_strategy_not_active', strategy_id:1 })
    expect(mockQueryOne).toHaveBeenCalledTimes(1)
  })

  it('rejects unknown usages', async () => {
    await expect(resolveAiTaskModel({ userId: 1, usage: 'invalid' })).rejects.toThrow('invalid_usage:invalid')
  })

  it('accepts model comparison as a distinct usage category', async () => {
    mockQueryOne.mockResolvedValueOnce(null).mockResolvedValueOnce(policy())
    const result = await resolveAiTaskModel({ userId: 1, usage: 'model_compare' })
    expect(result).toMatchObject({ usage:'model_compare', error:'no_model_configured' })
  })
})

describe('model profile authorization and defaults', () => {
  it('normalizes the three physical token fields with conservative defaults', () => {
    expect(normalizeModelTokenLimits()).toMatchObject({
      context_window_tokens:1048576, max_input_tokens:1048576, max_output_tokens:393216,
      context_limit_semantics:'shared_context',
    })
    expect(() => normalizeModelTokenLimits({ context_window_tokens:0 })).toThrow('model_context_window_invalid')
    expect(() => normalizeModelTokenLimits({ max_input_tokens:2147483648 })).toThrow('model_max_input_tokens_invalid')
    expect(() => normalizeModelTokenLimits({ max_output_tokens:2097152 })).toThrow('model_token_limits_invalid')
    expect(() => normalizeModelTokenLimits({ context_window_tokens:100, max_input_tokens:101 }))
      .toThrow('model_token_limits_invalid')
  })

  it('rejects a stale expected profile timestamp before provider verification', async () => {
    const existing = profile({ updated_at:'2026-07-15 12:00:00' })
    mockQueryOne.mockResolvedValueOnce(existing)
    await expect(prepareModelProfileForSave({ id:existing.id, userId:1, callerRole:'pro',
      payload:{ expected_profile_updated_at:'2026-07-15 11:59:59' } })).rejects.toThrow('model_profile_conflict')
    expect(mockQueryRun).not.toHaveBeenCalled()
  })

  it('does not write a new profile when the one-shot provider validation fails', async () => {
    const verify = vi.fn().mockRejectedValue(new Error('model_connection_request_rejected'))
    await expect(saveModelProfileWithValidation({ userId:1, callerRole:'pro', verify,
      payload:{ provider:'deepseek', model_name:'deepseek-chat', api_key:'pending-key',
        context_window_tokens:1048576, max_input_tokens:1048576, max_output_tokens:393216 } }))
      .rejects.toThrow('model_connection_request_rejected')
    expect(verify).toHaveBeenCalledOnce()
    expect(verify.mock.calls[0][0]).toMatchObject({ max_output_tokens:393216 })
    expect(mockWithTransaction).not.toHaveBeenCalled()
    expect(mockQueryRun).not.toHaveBeenCalled()
    expect(mockTx).not.toHaveBeenCalled()
  })

  it('rejects platform scope from a non-admin caller', async () => {
    await expect(createModelProfile(1, { scope: 'platform', api_key: 'test' }, 'pro'))
      .rejects.toThrow('platform_scope_requires_admin')
  })

  it('does not allow the legacy create entry point to write an active profile', async () => {
    await expect(createModelProfile(55, { scope: 'platform', api_key: 'test' }, 'admin'))
      .rejects.toThrow('model_profile_verification_required')
    expect(mockQueryRun).not.toHaveBeenCalled()
  })

  it('does not allow legacy provider create payloads to bypass validation', async () => {
    await expect(createModelProfile(1, {
      provider: 'deepseek', model_name: 'deepseek-chat', api_key: 'test', thinking_enabled: false,
    }, 'pro')).rejects.toThrow('model_profile_verification_required')
    expect(mockQueryRun).not.toHaveBeenCalled()
  })

  it('does not allow legacy provider update payloads to bypass validation', async () => {
    const existing = profile()
    mockQueryOne.mockResolvedValueOnce(existing)
    await expect(updateModelProfile(existing.id, existing.owner_user_id, {
      provider:'kimi_code', model_name:'kimi-for-coding', api_key:'test', thinking_enabled:false,
    })).rejects.toThrow('model_profile_verification_required')
    expect(mockQueryRun).not.toHaveBeenCalled()
  })

  it('does not allow legacy timeout payloads to write a profile', async () => {
    await expect(createModelProfile(1, {
      provider: 'deepseek', model_name: 'deepseek-chat', request_timeout_ms: 29999,
    }, 'pro')).rejects.toThrow('model_profile_verification_required')
    expect(mockQueryRun).not.toHaveBeenCalled()
  })

  it('never accepts max_tokens as a new profile setting', async () => {
    await expect(createModelProfile(1, {
      provider:'deepseek', model_name:'deepseek-chat', max_tokens:50000,
    }, 'pro')).rejects.toThrow('model_profile_verification_required')
    expect(mockQueryRun).not.toHaveBeenCalled()
  })

  it('rejects legacy output caps through the retired entry point', async () => {
    await expect(createModelProfile(1, {
      provider:'deepseek', model_name:'deepseek-chat', max_tokens:0,
    }, 'pro')).rejects.toThrow('model_profile_verification_required')
    expect(mockQueryRun).not.toHaveBeenCalled()
  })

  it('does not update legacy profiles without save-and-verify', async () => {
    const existing = profile({ request_timeout_ms: 180000 })
    mockQueryOne.mockResolvedValueOnce(existing)
    await expect(updateModelProfile(existing.id, existing.owner_user_id, { model_name: 'qwen-plus-new' }))
      .rejects.toThrow('model_profile_verification_required')
    expect(mockQueryRun).not.toHaveBeenCalled()
  })

  it('updates both default representations in one transaction', async () => {
    mockQueryOne.mockResolvedValueOnce({ id: 5, owner_user_id: 1, status: 'active',
      provider:'qwen', model_name:'qwen-plus', api_base_url:'https://example.test/v1',
      context_window_tokens: 1048576, max_input_tokens: 1048576,
      max_output_tokens: 393216, token_limits_status: 'confirmed' })
    mockTx.mockResolvedValue([{ affectedRows: 1 }])
    await setDefaultModelProfile(1, 5)
    expect(mockWithTransaction).toHaveBeenCalledTimes(1)
    expect(mockTx).toHaveBeenCalledTimes(3)
    expect(mockTx.mock.calls.some(([sql]) => sql.includes('user_model_defaults'))).toBe(true)
  })

  it('reports default and strategy bindings before model deletion', async () => {
    mockQueryOne
      .mockResolvedValueOnce(profile({ is_default: 0 }))
      .mockResolvedValueOnce({ user_id: 1 })
    mockQueryAll.mockResolvedValueOnce([{ id: 7, title: '趋势策略', is_active: 1, subscription_count: 2, active_subscription_count: 1 }])
    const impact = await getModelProfileDeletionImpact(10, 1)
    expect(impact).toMatchObject({ id: 10, model_name: 'qwen-plus', is_default: true, can_delete: false })
    expect(impact.strategies[0]).toMatchObject({ id: 7, is_active: true, subscription_count: 2, active_subscription_count: 1 })
  })

  it('blocks deleting a default model even when the client preview is stale', async () => {
    mockTx
      .mockResolvedValueOnce([[profile({ is_default: 1 })]])
      .mockResolvedValueOnce([[{ user_id: 1 }]])
    await expect(deleteModelProfile(10, 1, { confirm_name: 'qwen-plus', confirm_id: 10 }))
      .rejects.toThrow('model_profile_default_in_use')
    expect(mockTx).toHaveBeenCalledTimes(2)
  })

  it('blocks deleting a model while any strategy still references it', async () => {
    mockTx
      .mockResolvedValueOnce([[profile({ is_default: 0 })]])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[{ id: 7 }]])
    await expect(deleteModelProfile(10, 1, { confirm_name: 'qwen-plus', confirm_id: 10 }))
      .rejects.toThrow('model_profile_in_use')
    expect(mockTx).toHaveBeenCalledTimes(3)
  })

  it('requires matching model name and id then soft-deletes an unused model', async () => {
    mockTx
      .mockResolvedValueOnce([[profile({ is_default: 0 })]])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[]])
    await expect(deleteModelProfile(10, 1, { confirm_name: 'wrong', confirm_id: 10 }))
      .rejects.toThrow('model_profile_delete_confirmation_mismatch')

    mockTx
      .mockResolvedValueOnce([[profile({ is_default: 0 })]])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
    await deleteModelProfile(10, 1, { confirm_name: 'qwen-plus', confirm_id: 10 })
    expect(mockTx.mock.calls.at(-1)[0]).toContain('status = "deleted"')
  })
})

describe('model usage accounting', () => {
  it('creates a reserved log for a user-owned model', async () => {
    mockQueryRun.mockResolvedValueOnce({ insertId: 21 })
    const result = await beginModelUsage({
      userId: 2, profileId: 10, credentialSource: 'user', usage: 'manual', estimatedTokens: 3000,
    })
    expect(result).toEqual({ logId: 21, reservedTokens: 0 })
    expect(mockQueryRun.mock.calls[0][0]).toContain("'reserved'")
  })

  it('records request and repair phases while defaulting unknown phases to request', async () => {
    mockQueryRun
      .mockResolvedValueOnce({ insertId: 21 })
      .mockResolvedValueOnce({ insertId: 22 })
    await beginModelUsage({
      userId: 2, profileId: 10, credentialSource: 'user', usage: 'manual', requestPhase:'repair',
    })
    await beginModelUsage({
      userId: 2, profileId: 10, credentialSource: 'user', usage: 'manual', requestPhase:'unexpected',
    })
    expect(mockQueryRun.mock.calls[0][0]).toContain('request_phase')
    expect(mockQueryRun.mock.calls[0][1]).toContain('repair')
    expect(mockQueryRun.mock.calls[1][1]).toContain('request')
  })

  it('admits platform usage under a user row lock without reserving output tokens', async () => {
    mockTx
      .mockResolvedValueOnce([[{ id: 2, plan: 'pro' }]])
      .mockResolvedValueOnce([[policy({ share_for_manual: 1 })]])
      .mockResolvedValueOnce([[{ cnt: 3, tokens: 1000 }]])
      .mockResolvedValueOnce([{ insertId: 44 }])
    const result = await beginModelUsage({
      userId: 2, profileId: 99, credentialSource: 'platform_shared', usage: 'manual', estimatedTokens: 2500,
    })
    expect(result).toEqual({ logId: 44, reservedTokens: 0 })
    expect(mockTx.mock.calls[0][0]).toContain('FOR UPDATE')
    const insertSql = mockTx.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO ai_model_usage_logs'))?.[0]
    expect(insertSql).toContain('VALUES (?, ?, \'platform_shared\', ?, ?, ?, 0, \'reserved\', NULL, ?)')
  })

  it('keeps repair requests in the shared quota aggregate', async () => {
    mockTx
      .mockResolvedValueOnce([[{ id: 2, plan: 'pro' }]])
      .mockResolvedValueOnce([[policy({ share_for_manual: 1 })]])
      .mockResolvedValueOnce([[{ cnt: 3, tokens: 1000 }]])
      .mockResolvedValueOnce([{ insertId: 45 }])
    await beginModelUsage({
      userId: 2, profileId: 99, credentialSource: 'platform_shared', usage: 'manual',
      requestPhase:'repair', estimatedTokens:2500,
    })
    const quotaSql = mockTx.mock.calls.find(([sql]) => String(sql).includes('COUNT(*)'))?.[0]
    expect(quotaSql).toContain('SUM(token_count)')
    expect(quotaSql).not.toContain('request_phase')
  })

  it('rejects a platform request when the request quota is exhausted', async () => {
    mockTx
      .mockResolvedValueOnce([[{ id: 2, plan: 'pro' }]])
      .mockResolvedValueOnce([[policy({ share_for_manual: 1, daily_requests_per_user: 3 })]])
      .mockResolvedValueOnce([[{ cnt: 3, tokens: 1000 }]])
    await expect(beginModelUsage({
      userId: 2, profileId: 99, credentialSource: 'platform_shared', usage: 'manual', estimatedTokens: 100,
    })).rejects.toThrow('daily_request_limit')
  })

  it('rechecks membership expiry while reserving shared platform quota', async () => {
    mockTx
      .mockResolvedValueOnce([[{ id: 2, role: 'user', plan: 'pro', plan_expires_at: '2020-01-01 00:00:00' }]])
      .mockResolvedValueOnce([[policy({ share_for_manual: 1 })]])
    await expect(beginModelUsage({
      userId: 2, profileId: 99, credentialSource: 'platform_shared', usage: 'manual', estimatedTokens: 100,
    })).rejects.toThrow('platform_plan_not_allowed')
  })

  it('rechecks the sharing switch inside the quota transaction', async () => {
    mockTx
      .mockResolvedValueOnce([[{ id: 2, plan: 'pro' }]])
      .mockResolvedValueOnce([[policy({ share_for_manual: 0 })]])
    await expect(beginModelUsage({
      userId: 2, profileId: 99, credentialSource: 'platform_shared', usage: 'manual', estimatedTokens: 100,
    })).rejects.toThrow('platform_sharing_disabled')
  })

  it('does not reject a platform request when actual token usage exceeds the reporting threshold', async () => {
    mockTx
      .mockResolvedValueOnce([[{ id: 2, plan: 'pro' }]])
      .mockResolvedValueOnce([[policy({ share_for_manual: 1, daily_tokens_per_user: 2000 })]])
      .mockResolvedValueOnce([[{ cnt: 1, tokens: 1500 }]])
      .mockResolvedValueOnce([{ insertId: 46 }])
    await expect(beginModelUsage({
      userId: 2, profileId: 99, credentialSource: 'platform_shared', usage: 'manual', estimatedTokens: 600,
    })).resolves.toEqual({ logId: 46, reservedTokens: 0 })
  })

  it('keeps checkPlatformQuota allowed when token reporting threshold is exceeded', async () => {
    mockQueryOne
      .mockResolvedValueOnce({ cnt: 4, tokens: 2500 })
      .mockResolvedValueOnce(policy({ daily_requests_per_user: 100, daily_tokens_per_user: 2000 }))
    await expect(checkPlatformQuota(2, 'manual')).resolves.toMatchObject({
      allowed: true,
      warning: 'daily_token_limit',
      tokenQuotaExceeded: true,
      used: 2500,
      limit: 2000,
    })
  })

  it('requires a concrete user for platform-shared quota', async () => {
    await expect(beginModelUsage({
      userId: 0, profileId: 99, credentialSource: 'platform_shared', usage: 'manual', estimatedTokens: 100,
    })).rejects.toThrow('platform_shared_user_required')
  })

  it('finalizes a reservation with actual tokens and status', async () => {
    mockQueryRun.mockResolvedValueOnce({ changes: 1 })
    await finishModelUsage(44, { tokenCount: 321, inputTokens:200, outputTokens:80,
      reasoningTokens:35, cachedTokens:25, status: 'error', errorCode: 'provider_timeout',
      providerRequestId:'req-44', finishReason:'length', incompleteDetails:{ reason:'max_output_tokens' },
      requestBytes:1200, responseBytes:300, durationMs:4500 })
    expect(mockQueryRun).toHaveBeenCalledWith(expect.stringContaining("request_status = 'reserved'"),
      [321, 200, 80, 35, 25, 'error', 'provider_timeout', 'req-44', 'length',
        '{"reason":"max_output_tokens"}', 'settled', 1200, 300, 4500, 44])
  })

  it('recovers abandoned reservations without rewriting their token accounting', async () => {
    mockQueryRun.mockResolvedValueOnce({ affectedRows: 3 })
    await expect(recoverStaleModelUsageReservations(30)).resolves.toBe(3)
    expect(mockQueryRun).toHaveBeenCalledWith(
      expect.stringContaining("error_code = COALESCE(error_code, 'model_request_abandoned')"),
      [-30],
    )
    expect(mockQueryRun.mock.calls[0][0]).not.toContain('token_count =')
  })

  it('clamps an unsafe reservation recovery window', async () => {
    mockQueryRun.mockResolvedValueOnce({ changes: 1 })
    await expect(recoverStaleModelUsageReservations(1)).resolves.toBe(1)
    expect(mockQueryRun.mock.calls[0][1]).toEqual([-5])
  })
})

describe('legacy credential migration', () => {
  it('does not recreate active profiles from legacy configuration rows', async () => {
    mockQueryAll.mockResolvedValueOnce([{
      id: 8, user_id: 2, api_key_encrypted: 'legacy-secret', api_provider: 'qwen',
      model_name: 'qwen-plus', api_base_url: 'https://example.test/v1', temperature: 0.2, max_tokens: 3000,
    }])

    await expect(migrateLegacyConfigs()).resolves.toEqual([])
    expect(mockQueryRun).not.toHaveBeenCalled()
    expect(mockQueryAll).not.toHaveBeenCalled()
  })

  it('does not touch the legacy tables during startup migration', async () => {
    mockQueryAll.mockRejectedValueOnce(new Error('legacy db down'))
    await expect(migrateLegacyConfigs()).resolves.toEqual([])
    expect(mockQueryAll).not.toHaveBeenCalled()
    expect(mockQueryRun).not.toHaveBeenCalled()
  })
})

describe('model schema readiness', () => {
  it('checks every required model-management table', async () => {
    mockQueryOne.mockResolvedValue(null)
    await assertModelProfileSchemaReady()
    expect(mockQueryOne).toHaveBeenCalledTimes(4)
  })

  it('propagates a missing-table error', async () => {
    mockQueryOne.mockRejectedValueOnce(new Error('table missing'))
    await expect(assertModelProfileSchemaReady()).rejects.toThrow('table missing')
  })
})
