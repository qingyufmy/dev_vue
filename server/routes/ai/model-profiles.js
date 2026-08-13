// ai/model-profiles.js — 统一模型管理 + 解析器 + 使用日志

import crypto from 'node:crypto'
import { queryOne, queryAll, queryRun, withTransaction, beijingNow } from '../../db.js'
import { encryptCredential, decryptCredential, isEncryptionAvailable, isEncryptedEnvelope, getActiveKeyVersion } from '../../ai-credential.js'
import { recordCredentialMigration } from './rollout-governance.js'
import { isPlatformShareableProvider, modelProviderProtocol, normalizeModelProviderProfile } from './model-providers.js'
import { MODEL_PROVIDER_CAPABILITY_KEYS, MODEL_TOKEN_LIMIT_DEFAULTS,
  getModelProviderCapabilities, normalizeProviderCapabilities } from './model-provider-capabilities.js'
import { getEffectivePlan } from '../../membership.js'

export const MODEL_PROFILE_SCOPE = { USER: 'user', PLATFORM: 'platform' }
export const USAGES = ['manual', 'model_compare', 'auto_private', 'auto_platform', 'review', 'memory_compression', 'memory_consistency']
const MODEL_REQUEST_TIMEOUT_MIN_MS = 30000
const MODEL_REQUEST_TIMEOUT_MAX_MS = 600000
const MODEL_TOKEN_LIMIT_MAX = 2147483647

export { MODEL_TOKEN_LIMIT_DEFAULTS }

function normalizeRequestTimeout(value, fallback = null) {
  if (value === undefined) return fallback
  if (value === null || value === '') return null
  const timeout = Number(value)
  if (!Number.isInteger(timeout) || timeout < MODEL_REQUEST_TIMEOUT_MIN_MS || timeout > MODEL_REQUEST_TIMEOUT_MAX_MS) {
    throw new Error('model_request_timeout_out_of_range')
  }
  return timeout
}

function normalizeTokenLimit(value, field, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  const tokens = Number(value)
  if (!Number.isSafeInteger(tokens) || tokens <= 0 || tokens > MODEL_TOKEN_LIMIT_MAX) {
    const errorCode = field === 'context_window_tokens'
      ? 'model_context_window_invalid'
      : field === 'max_input_tokens' ? 'model_max_input_tokens_invalid' : 'model_max_output_tokens_invalid'
    throw new Error(errorCode)
  }
  return tokens
}

/** Normalize the three user-facing physical model limits. */
export function normalizeModelTokenLimits(payload = {}, existing = {}) {
  const limits = {
    context_window_tokens:normalizeTokenLimit(payload.context_window_tokens, 'context_window_tokens',
      existing.context_window_tokens ?? MODEL_TOKEN_LIMIT_DEFAULTS.context_window_tokens),
    max_input_tokens:normalizeTokenLimit(payload.max_input_tokens, 'max_input_tokens',
      existing.max_input_tokens ?? MODEL_TOKEN_LIMIT_DEFAULTS.max_input_tokens),
    max_output_tokens:normalizeTokenLimit(payload.max_output_tokens, 'max_output_tokens',
      existing.max_output_tokens ?? MODEL_TOKEN_LIMIT_DEFAULTS.max_output_tokens),
    context_limit_semantics:'shared_context',
  }
  if (limits.max_input_tokens > limits.context_window_tokens
      || limits.max_output_tokens > limits.context_window_tokens) {
    throw new Error('model_token_limits_invalid')
  }
  return limits
}

function parseAllowedPlans(value) {
  if (Array.isArray(value)) return value.map(String)
  if (value && typeof value === 'object') return Object.values(value).map(String)
  try {
    const parsed = JSON.parse(value || '["pro"]')
    return Array.isArray(parsed) ? parsed.map(String) : ['pro']
  } catch (error) {
    console.error('[ModelProfiles] Invalid allowed_plans policy:', error.message)
    return ['pro']
  }
}

export async function assertModelProfileSchemaReady() {
  const requiredTables = [
    'ai_model_profiles',
    'user_model_defaults',
    'platform_model_usage_policy',
    'ai_model_usage_logs',
  ]
  for (const table of requiredTables) {
    await queryOne(`SELECT 1 AS ok FROM ${table} LIMIT 1`)
  }
}

function modelIdentity(providerConfig, provider) {
  return {
    provider:String(providerConfig.provider || provider || ''),
    model_name:String(providerConfig.model_name || ''),
    api_base_url:String(providerConfig.api_base_url || ''),
  }
}

function modelIdentityChanged(existingCapability, identity, existingProfile = {}) {
  if (!existingCapability || !existingCapability.provider) return false
  return ['provider', 'model_name', 'api_base_url'].some(key =>
    String(existingCapability[key] || '') !== String(identity[key] || ''))
    || (existingCapability.protocol && existingCapability.protocol !== identity.protocol)
    || String(existingProfile.provider || '') !== String(identity.provider || '')
    || String(existingProfile.model_name || '') !== String(identity.model_name || '')
    || String(existingProfile.api_base_url || '') !== String(identity.api_base_url || '')
}

function modelTokenLimitsError(capabilities = {}) {
  const status = String(capabilities.token_limits_status || '')
  const source = String(capabilities.token_limits_source || '')
  const context = Number(capabilities.context_window_tokens)
  const input = Number(capabilities.max_input_tokens)
  const output = Number(capabilities.max_output_tokens)
  if (status === 'confirmed'
      && Number.isSafeInteger(context) && context > 0
      && Number.isSafeInteger(input) && input > 0 && input <= context
      && Number.isSafeInteger(output) && output > 0 && output <= context) return null
  const error = new Error('model_token_limits_unconfirmed')
  error.code = 'model_token_limits_unconfirmed'
  error.token_limits_status = status || 'default_unconfirmed'
  error.token_limits_source = source || 'generic_default'
  return error
}

function getProfileTokenCapabilities(profile = {}) {
  if (Object.hasOwn(profile, 'token_limits_status') || Object.hasOwn(profile, 'token_limits_source')) {
    const hasStoredIdentity = ['capability_provider', 'capability_model_name',
      'capability_api_base_url', 'capability_protocol'].some(key => Object.hasOwn(profile, key))
    return normalizeProviderCapabilities({
      ...profile,
      ...(hasStoredIdentity ? {
        provider:profile.capability_provider,
        model_name:profile.capability_model_name,
        api_base_url:profile.capability_api_base_url,
        protocol:profile.capability_protocol,
      } : {
        // Rows assembled by older callers do not carry the capability identity;
        // use the profile identity only for that compatibility shape. SQL joins
        // below use capability_* aliases so a real stale identity is rejected.
        protocol:modelProviderProtocol(profile.provider),
      }),
    })
  }
  return null
}

function modelCapabilityIdentityMatches(profile = {}, capabilities = {}) {
  const expected = {
    provider:String(profile.provider || ''),
    model_name:String(profile.model_name || ''),
    api_base_url:String(profile.api_base_url || ''),
    protocol:modelProviderProtocol(profile.provider),
  }
  const actual = {
    provider:String(capabilities.provider || ''),
    model_name:String(capabilities.model_name || ''),
    api_base_url:String(capabilities.api_base_url || ''),
    protocol:String(capabilities.protocol || ''),
  }
  return Object.values(actual).every(Boolean)
    && Object.keys(expected).every(key => expected[key] === actual[key])
}

async function assertConfirmedModelProfile(profile) {
  const capabilities = getProfileTokenCapabilities(profile) || await getModelProviderCapabilities(profile?.id)
  const error = modelTokenLimitsError(capabilities)
    || (!modelCapabilityIdentityMatches(profile, capabilities) ? modelTokenLimitsError({ ...capabilities, token_limits_status:'stale' }) : null)
  if (error) throw error
  if (profile && capabilities) {
    for (const key of ['context_window_tokens', 'max_input_tokens', 'max_output_tokens',
      'context_limit_semantics', 'token_limits_source', 'token_limits_status',
      'token_limits_note', 'token_limits_updated_by', 'token_limits_updated_at_utc_msc']) {
      profile[key] = capabilities[key]
    }
  }
  return capabilities
}

function tokenCapabilityFields(capability, tokenLimits, actorUserId, identity,
  providerVerification = 'unverified', identityChanged = false) {
  return {
    ...(identityChanged ? {} : (capability || {})),
    ...identity,
    context_window_tokens:tokenLimits.context_window_tokens,
    max_input_tokens:tokenLimits.max_input_tokens,
    max_output_tokens:tokenLimits.max_output_tokens,
    context_limit_semantics:'shared_context',
    token_limits_source:'manual_confirmed',
    token_limits_status:'confirmed',
    token_limits_updated_by:Number(actorUserId) || null,
    token_limits_updated_at_utc_msc:Date.now(),
    verification_status:identityChanged ? 'unverified' : (capability?.verification_status || providerVerification),
    verified_at_utc_msc:identityChanged ? null : (capability?.verified_at_utc_msc || null),
  }
}

function capabilityValues(capability = {}) {
  return MODEL_PROVIDER_CAPABILITY_KEYS.map(key => capability[key] ? 1 : 0)
}

async function upsertModelProfileCapability(run, profileId, capability, actorUserId) {
  const values = capabilityValues(capability)
  const params = [Number(profileId), ...values,
    capability.context_window_tokens, capability.max_input_tokens, capability.max_output_tokens,
    capability.context_limit_semantics || 'shared_context', capability.token_limits_source || 'generic_default',
    capability.token_limits_status || 'default_unconfirmed', capability.token_limits_note || null,
    capability.token_limits_updated_by || Number(actorUserId) || null,
    capability.token_limits_updated_at_utc_msc || Date.now(), capability.provider || null,
    capability.model_name || null, capability.api_base_url || null, capability.protocol || null,
    capability.verification_status || 'unverified', Number(actorUserId) || null,
    capability.verified_at_utc_msc || null, Date.now()]
  const raw = await run(`INSERT INTO ai_model_provider_capabilities
    (model_profile_id, supports_stream, supports_request_id, supports_poll, supports_cancel,
     supports_idempotency, supports_structured_output, supports_usage_split,
     context_window_tokens, max_input_tokens, max_output_tokens, context_limit_semantics,
     token_limits_source, token_limits_status, token_limits_note, token_limits_updated_by,
     token_limits_updated_at_utc_msc, provider, model_name, api_base_url, protocol,
     verification_status, verified_by_user_id, verified_at_utc_msc, updated_at_utc_msc)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE supports_stream = VALUES(supports_stream),
      supports_request_id = VALUES(supports_request_id), supports_poll = VALUES(supports_poll),
      supports_cancel = VALUES(supports_cancel), supports_idempotency = VALUES(supports_idempotency),
      supports_structured_output = VALUES(supports_structured_output), supports_usage_split = VALUES(supports_usage_split),
      context_window_tokens = VALUES(context_window_tokens), max_input_tokens = VALUES(max_input_tokens),
      max_output_tokens = VALUES(max_output_tokens), context_limit_semantics = VALUES(context_limit_semantics),
      token_limits_source = VALUES(token_limits_source), token_limits_status = VALUES(token_limits_status),
      token_limits_note = VALUES(token_limits_note), token_limits_updated_by = VALUES(token_limits_updated_by),
      token_limits_updated_at_utc_msc = VALUES(token_limits_updated_at_utc_msc),
      provider = VALUES(provider), model_name = VALUES(model_name), api_base_url = VALUES(api_base_url),
      protocol = VALUES(protocol), verification_status = VALUES(verification_status),
      verified_by_user_id = VALUES(verified_by_user_id), verified_at_utc_msc = VALUES(verified_at_utc_msc),
      updated_at_utc_msc = VALUES(updated_at_utc_msc)`, params)
  return Array.isArray(raw) ? raw[0] : raw
}

/**
 * Resolve and locally validate the complete configuration that is about to be
 * saved. This function performs no writes and is intentionally separate from
 * the provider request so a failed validation cannot replace an active row.
 */
export async function prepareModelProfileForSave({ id = null, userId, payload = {}, callerRole } = {}) {
  const existing = id == null
    ? null
    : await queryOne('SELECT * FROM ai_model_profiles WHERE id = ? AND deleted_at IS NULL', [id])
  if (id != null && !existing) throw new Error('model_profile_not_found')
  if (existing && Number(existing.owner_user_id) !== Number(userId)) throw new Error('model_profile_access_denied')
  const suppliedExpectedUpdatedAt = payload.expected_profile_updated_at
    ?? payload.expected_updated_at ?? payload.updated_at
  if (existing && suppliedExpectedUpdatedAt !== undefined && suppliedExpectedUpdatedAt !== null
      && String(suppliedExpectedUpdatedAt) !== String(existing.updated_at)) {
    throw new Error('model_profile_conflict')
  }

  const requestedScope = payload.scope || existing?.scope || MODEL_PROFILE_SCOPE.USER
  if (requestedScope === MODEL_PROFILE_SCOPE.PLATFORM && callerRole !== 'admin') {
    throw new Error('platform_scope_requires_admin')
  }
  if (existing && requestedScope !== existing.scope) throw new Error('model_profile_scope_immutable')
  const scope = existing?.scope || requestedScope
  const ownerUserId = scope === MODEL_PROFILE_SCOPE.PLATFORM ? 0 : userId
  const providerConfig = normalizeModelProviderProfile(payload, existing || {})
  const requestTimeoutMs = normalizeRequestTimeout(payload.request_timeout_ms, existing?.request_timeout_ms)
  const oldCapability = existing ? await getModelProviderCapabilities(existing.id) : null
  const identity = { ...modelIdentity(providerConfig), protocol:modelProviderProtocol(providerConfig.provider) }
  const identityChanged = modelIdentityChanged(oldCapability, identity, existing || {})
  const tokenLimits = normalizeModelTokenLimits(payload,
    identityChanged ? MODEL_TOKEN_LIMIT_DEFAULTS : (oldCapability || MODEL_TOKEN_LIMIT_DEFAULTS))

  let encryptedKey = existing?.api_key_encrypted || null
  let keyVersion = existing?.key_version || null
  let apiKey = payload.api_key
  if (apiKey) {
    if (!isEncryptionAvailable()) throw new Error('encryption_master_key_missing')
    encryptedKey = encryptCredential(apiKey)
    keyVersion = getActiveKeyVersion()
  } else if (encryptedKey) {
    if (!isEncryptionAvailable() || !isEncryptedEnvelope(encryptedKey)) throw new Error('credential_not_encrypted')
    apiKey = decryptCredential(encryptedKey)
  }
  if (!apiKey) throw new Error('model_api_key_required')
  // max_tokens is retained only as an immutable legacy audit column. Never
  // accept it from a new payload and never use it as a physical capability.
  const legacyMaxTokens = existing?.max_tokens ?? 2000

  return {
    id:id == null ? null : Number(id), existing, scope, ownerUserId, providerConfig,
    requestTimeoutMs, tokenLimits, identity, identityChanged, oldCapability,
    encryptedKey, keyVersion, apiKey, legacyMaxTokens,
    temperature:payload.temperature ?? existing?.temperature ?? 0.3,
    expectedUpdatedAt:suppliedExpectedUpdatedAt ?? existing?.updated_at ?? null,
    runtimeModel:{
      id:existing?.id || null, provider:providerConfig.provider, api_provider:providerConfig.provider,
      model_name:providerConfig.model_name, api_base_url:providerConfig.api_base_url,
      api_key_encrypted:apiKey, key_version:keyVersion, temperature:payload.temperature ?? existing?.temperature ?? 0.3,
      max_output_tokens:tokenLimits.max_output_tokens,
      context_window_tokens:tokenLimits.context_window_tokens, max_input_tokens:tokenLimits.max_input_tokens,
      thinking_enabled:providerConfig.thinking_enabled, reasoning_effort:providerConfig.reasoning_effort,
      request_timeout_ms:requestTimeoutMs, owner_user_id:ownerUserId,
    },
  }
}

/** Verify once, then commit the profile and its manually confirmed limits. */
export async function saveModelProfileWithValidation({ id = null, userId, payload = {}, callerRole, verify } = {}) {
  const prepared = await prepareModelProfileForSave({ id, userId, payload, callerRole })
  if (typeof verify !== 'function') throw new Error('model_profile_verification_required')
  await verify(prepared.runtimeModel, prepared)

  const now = beijingNow()
  const capability = tokenCapabilityFields(prepared.oldCapability, prepared.tokenLimits, userId,
    prepared.identity, prepared.oldCapability?.verification_status || 'unverified', prepared.identityChanged)
  let profileId = prepared.id
  await withTransaction(async run => {
    if (prepared.id == null) {
      const raw = await run(`INSERT INTO ai_model_profiles
        (owner_user_id, scope, provider, model_name, api_base_url, api_key_encrypted, key_version,
         temperature, max_tokens, thinking_enabled, reasoning_effort, request_timeout_ms, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`, [
        prepared.ownerUserId, prepared.scope, prepared.providerConfig.provider, prepared.providerConfig.model_name,
        prepared.providerConfig.api_base_url, prepared.encryptedKey, prepared.keyVersion, prepared.temperature,
        prepared.legacyMaxTokens, prepared.providerConfig.thinking_enabled, prepared.providerConfig.reasoning_effort,
        prepared.requestTimeoutMs, now, now])
      const result = Array.isArray(raw) ? raw[0] : raw
      profileId = Number(result?.insertId || 0)
      if (!profileId) throw new Error('model_profile_save_failed')
    } else {
      const raw = await run(`UPDATE ai_model_profiles SET
        provider = ?, model_name = ?, api_base_url = ?, api_key_encrypted = ?, key_version = ?,
        temperature = ?, max_tokens = ?, thinking_enabled = ?, reasoning_effort = ?, request_timeout_ms = ?,
        updated_at = ?
       WHERE id = ? AND deleted_at IS NULL AND updated_at = ?`, [
        prepared.providerConfig.provider, prepared.providerConfig.model_name, prepared.providerConfig.api_base_url,
        prepared.encryptedKey, prepared.keyVersion, prepared.temperature, prepared.legacyMaxTokens,
        prepared.providerConfig.thinking_enabled, prepared.providerConfig.reasoning_effort, prepared.requestTimeoutMs,
        now, prepared.id, prepared.expectedUpdatedAt])
      const result = Array.isArray(raw) ? raw[0] : raw
      if (!Number(result?.affectedRows ?? result?.changes ?? 0)) throw new Error('model_profile_conflict')
    }
    await upsertModelProfileCapability(run, profileId, capability, userId)
  })
  return await getModelProfileById(profileId)
}

// ─── Model Profiles CRUD ───

export async function createModelProfile(userId, payload, callerRole) {
  const scope = payload?.scope || MODEL_PROFILE_SCOPE.USER
  if (scope === MODEL_PROFILE_SCOPE.PLATFORM && callerRole !== 'admin') {
    throw new Error('platform_scope_requires_admin')
  }
  // This function is intentionally retained as a compatibility export for
  // older callers. It is not a write path: only saveModelProfileWithValidation
  // may create an active model after one provider verification request.
  throw new Error('model_profile_verification_required')
}

export async function getModelProfileById(id) {
  const row = await queryOne('SELECT * FROM ai_model_profiles WHERE id = ? AND deleted_at IS NULL', [id])
  if (!row) return null
  return await sanitizeProfileWithCapabilities(row)
}

export async function getUserModelProfiles(userId) {
  const rows = await queryAll(
    'SELECT * FROM ai_model_profiles WHERE owner_user_id = ? AND deleted_at IS NULL ORDER BY is_default DESC, updated_at DESC',
    [userId]
  )
  return await Promise.all(rows.map(row => sanitizeProfileWithCapabilities(row)))
}

export async function upsertDefaultModelProfileFromLegacyInput(userId, callerRole, payload = {}, scope = 'user') {
  if (!payload.api_key) return null
  if (scope === MODEL_PROFILE_SCOPE.PLATFORM && callerRole !== 'admin') throw new Error('platform_scope_requires_admin')
  throw new Error('model_profile_verification_required')
}

/** Runtime-only credential resolution for an owner testing a specific profile. */
export async function resolveOwnedModelProfileForRuntime(id, userId) {
  const row = await queryOne(`SELECT * FROM ai_model_profiles
    WHERE id = ? AND owner_user_id = ? AND status = 'active' AND deleted_at IS NULL`, [id, userId])
  if (!row) return { model: null, credential_source: 'none', error: 'model_profile_not_found_or_inactive', usage: 'manual' }
  return buildResult(row, row.scope === 'platform' ? 'platform_primary' : 'user', 'manual', 'connection_test')
}

export async function updateModelProfile(id, userId, payload) {
  const existing = await queryOne('SELECT * FROM ai_model_profiles WHERE id = ? AND deleted_at IS NULL', [id])
  if (!existing) throw new Error('model_profile_not_found')
  if (existing.owner_user_id !== userId) throw new Error('model_profile_access_denied')
  throw new Error('model_profile_verification_required')
}

export async function getModelProfileDeletionImpact(id, userId) {
  const existing = await queryOne('SELECT * FROM ai_model_profiles WHERE id = ? AND deleted_at IS NULL', [id])
  if (!existing) throw new Error('model_profile_not_found')
  if (Number(existing.owner_user_id) !== Number(userId)) throw new Error('model_profile_access_denied')
  const strategies = await queryAll(
    `SELECT apt.id, apt.title, apt.scope, apt.visibility_status, apt.is_active,
            COUNT(ss.id) AS subscription_count,
            COALESCE(SUM(CASE WHEN ss.execution_enabled = 1 THEN 1 ELSE 0 END), 0) AS active_subscription_count
       FROM auto_prompt_types apt
       LEFT JOIN strategy_subscriptions ss ON ss.strategy_id = apt.id AND ss.is_deleted = 0
      WHERE apt.model_profile_id = ? AND apt.deleted_at IS NULL
      GROUP BY apt.id, apt.title, apt.scope, apt.visibility_status, apt.is_active
      ORDER BY apt.is_active DESC, apt.id DESC`,
    [id]
  )
  const defaultRow = await queryOne(
    'SELECT user_id FROM user_model_defaults WHERE user_id = ? AND model_profile_id = ?',
    [userId, id]
  )
  const isDefault = Boolean(Number(existing.is_default) || defaultRow)
  return {
    id: Number(existing.id),
    model_name: String(existing.model_name || ''),
    scope: existing.scope,
    is_default: isDefault,
    strategies: strategies.map(row => ({
      ...row,
      id: Number(row.id),
      is_active: Boolean(Number(row.is_active)),
      subscription_count: Number(row.subscription_count || 0),
      active_subscription_count: Number(row.active_subscription_count || 0),
    })),
    can_delete: !isDefault && strategies.length === 0,
  }
}

export async function deleteModelProfile(id, userId, confirmation = {}) {
  const now = beijingNow()
  await withTransaction(async run => {
    const [profileRows] = await run(
      'SELECT * FROM ai_model_profiles WHERE id = ? AND deleted_at IS NULL FOR UPDATE',
      [id]
    )
    const existing = profileRows?.[0]
    if (!existing) throw new Error('model_profile_not_found')
    if (Number(existing.owner_user_id) !== Number(userId)) throw new Error('model_profile_access_denied')
    const [defaultRows] = await run(
      'SELECT user_id FROM user_model_defaults WHERE user_id = ? AND model_profile_id = ? FOR UPDATE',
      [userId, id]
    )
    if (Number(existing.is_default) || defaultRows?.length) throw new Error('model_profile_default_in_use')
    const [strategyRows] = await run(
      'SELECT id FROM auto_prompt_types WHERE model_profile_id = ? AND deleted_at IS NULL FOR UPDATE',
      [id]
    )
    if (strategyRows?.length) throw new Error('model_profile_in_use')
    if (String(confirmation.confirm_name || '') !== String(existing.model_name || '') ||
        Number(confirmation.confirm_id) !== Number(existing.id)) {
      throw new Error('model_profile_delete_confirmation_mismatch')
    }
    await run('UPDATE ai_model_profiles SET deleted_at = ?, status = "deleted", is_default = 0 WHERE id = ?', [now, id])
  })
}

// [P1-3] setDefaultModelProfile writes BOTH is_default flag AND user_model_defaults table
export async function setDefaultModelProfile(userId, profileId) {
  const now = beijingNow()
  const profile = await queryOne(
    `SELECT mp.*, c.context_window_tokens, c.max_input_tokens, c.max_output_tokens,
            c.context_limit_semantics, c.token_limits_source, c.token_limits_status,
            c.token_limits_updated_by, c.token_limits_updated_at_utc_msc,
            c.verification_status AS provider_verification_status,
            c.provider AS capability_provider, c.model_name AS capability_model_name,
            c.api_base_url AS capability_api_base_url, c.protocol AS capability_protocol
       FROM ai_model_profiles mp
       LEFT JOIN ai_model_provider_capabilities c ON c.model_profile_id = mp.id
      WHERE mp.id = ? AND mp.owner_user_id = ? AND mp.deleted_at IS NULL AND mp.status = 'active'`,
    [profileId, userId]
  )
  if (!profile) throw new Error('model_profile_not_found_or_inactive')
  await assertConfirmedModelProfile({ ...profile,
    verification_status:profile.provider_verification_status || profile.verification_status })
  await withTransaction(async run => {
    await run('UPDATE ai_model_profiles SET is_default = 0 WHERE owner_user_id = ? AND deleted_at IS NULL', [userId])
    await run('UPDATE ai_model_profiles SET is_default = 1, updated_at = ? WHERE id = ?', [now, profileId])
    await run(
      `INSERT INTO user_model_defaults (user_id, model_profile_id, created_at, updated_at)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE model_profile_id = VALUES(model_profile_id), updated_at = VALUES(updated_at)`,
      [userId, profileId, now, now]
    )
  })
}

// ─── User Model Defaults ───

export async function getUserModelDefault(userId) {
  const row = await queryOne(
    `SELECT ump.*, mp.provider, mp.model_name, mp.api_base_url, mp.api_key_encrypted, mp.key_version,
            mp.temperature, mp.max_tokens, mp.thinking_enabled, mp.reasoning_effort, mp.status,
            c.context_window_tokens, c.max_input_tokens, c.max_output_tokens,
            c.context_limit_semantics, c.token_limits_source, c.token_limits_status,
            c.token_limits_updated_by, c.token_limits_updated_at_utc_msc,
            c.verification_status AS provider_verification_status,
            c.provider AS capability_provider, c.model_name AS capability_model_name,
            c.api_base_url AS capability_api_base_url, c.protocol AS capability_protocol
     FROM user_model_defaults ump
     JOIN ai_model_profiles mp ON mp.id = ump.model_profile_id
     LEFT JOIN ai_model_provider_capabilities c ON c.model_profile_id = mp.id
     WHERE ump.user_id = ? AND mp.deleted_at IS NULL AND mp.status = 'active'`,
    [userId]
  )
  if (!row) return null
  return { ...row, verification_status:row.provider_verification_status || row.verification_status }
}

export async function setUserModelDefault(userId, profileId) {
  return await setDefaultModelProfile(userId, profileId)
}

// ─── Platform Usage Policy ───

export async function getPlatformUsagePolicy() {
  let row = await queryOne('SELECT * FROM platform_model_usage_policy WHERE id = 1')
  if (!row) {
    row = {
      share_for_manual: 0, share_for_auto: 0, share_for_review: 0, share_for_memory_compression: 0,
      allowed_plans: JSON.stringify(['pro']),
      daily_requests_per_user: 100, daily_tokens_per_user: 500000,
    }
  }
  return row
}

export async function updatePlatformUsagePolicy(payload) {
  const now = beijingNow()
  await queryRun(
    `INSERT INTO platform_model_usage_policy
      (id, share_for_manual, share_for_auto, share_for_review, share_for_memory_compression,
       allowed_plans, daily_requests_per_user, daily_tokens_per_user, updated_at)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       share_for_manual = VALUES(share_for_manual), share_for_auto = VALUES(share_for_auto),
       share_for_review = VALUES(share_for_review), share_for_memory_compression = VALUES(share_for_memory_compression),
       allowed_plans = VALUES(allowed_plans), daily_requests_per_user = VALUES(daily_requests_per_user),
       daily_tokens_per_user = VALUES(daily_tokens_per_user), updated_at = VALUES(updated_at)`,
    [
      payload.share_for_manual ? 1 : 0,
      payload.share_for_auto ? 1 : 0,
      payload.share_for_review ? 1 : 0,
      payload.share_for_memory_compression ? 1 : 0,
      typeof payload.allowed_plans === 'string' ? payload.allowed_plans : JSON.stringify(payload.allowed_plans || ['pro']),
      payload.daily_requests_per_user ?? 100,
      payload.daily_tokens_per_user ?? 500000,
      now,
    ]
  )
  return await getPlatformUsagePolicy()
}

// ─── Usage Logging + Quota Check ───

export async function logModelUsage(userId, profileId, credentialSource, usage, strategyId, tokenCount, status, errorCode) {
  try {
    await queryRun(
      `INSERT INTO ai_model_usage_logs
        (user_id, model_profile_id, credential_source, \`usage\`, strategy_id, token_count, request_status, error_code, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [userId, profileId || null, credentialSource, usage, strategyId || null, tokenCount || 0, status || 'success', errorCode || null, beijingNow()]
    )
  } catch (e) {
    console.error('[ModelProfiles] Failed to log usage:', e.message)
  }
}

/**
 * Create one usage row before an outbound model request. Platform-shared calls
 * still use a per-user row lock for request-count admission and policy checks,
 * but token_count stays zero until the provider reports actual usage.
 */
export async function beginModelUsage({ userId, profileId, credentialSource, usage, strategyId = null,
  estimatedTokens = 0, requestPhase = 'request' }) {
  const normalizedRequestPhase = requestPhase === 'repair' ? 'repair' : 'request'
  if (credentialSource !== 'platform_shared') {
    const result = await queryRun(
      `INSERT INTO ai_model_usage_logs
        (user_id, model_profile_id, credential_source, \`usage\`, strategy_id, request_phase, token_count, request_status, error_code, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, 'reserved', NULL, ?)`,
      [userId || 0, profileId || null, credentialSource || 'user', usage, strategyId, normalizedRequestPhase, beijingNow()]
    )
    return { logId: result.insertId, reservedTokens: 0 }
  }

  if (!Number.isInteger(Number(userId)) || Number(userId) <= 0) {
    throw new Error('platform_shared_user_required')
  }

  return await withTransaction(async run => {
    const [lockedUsers] = await run('SELECT id, role, plan, plan_expires_at FROM users WHERE id = ? FOR UPDATE', [userId])
    if (!lockedUsers.length) throw new Error('model_usage_user_not_found')

    const [policies] = await run('SELECT * FROM platform_model_usage_policy WHERE id = 1')
    const policy = policies[0] || {
      share_for_manual: 0,
      share_for_auto: 0,
      share_for_review: 0,
      share_for_memory_compression: 0,
      allowed_plans: JSON.stringify(['pro']),
      daily_requests_per_user: 100,
      daily_tokens_per_user: 500000,
    }
    const shareUsage = usage === 'memory_consistency' ? 'memory_compression' : usage
    const shareKey = `share_for_${shareUsage === 'auto_private' ? 'auto' : shareUsage}`
    if (!policy[shareKey]) throw new Error('platform_sharing_disabled')
    const allowedPlans = parseAllowedPlans(policy.allowed_plans)
    if (!allowedPlans.includes(getEffectivePlan(lockedUsers[0]))) throw new Error('platform_plan_not_allowed')
    const [rows] = await run(
      `SELECT COUNT(*) AS cnt, COALESCE(SUM(token_count), 0) AS tokens
       FROM ai_model_usage_logs
       WHERE user_id = ? AND credential_source = 'platform_shared' AND \`usage\` = ?
         AND created_at >= CURRENT_DATE()`,
      [userId, usage]
    )
    const usedRequests = Number(rows[0]?.cnt || 0)
    if (usedRequests >= Number(policy.daily_requests_per_user)) throw new Error('daily_request_limit')

    const [insert] = await run(
      `INSERT INTO ai_model_usage_logs
        (user_id, model_profile_id, credential_source, \`usage\`, strategy_id, request_phase, token_count, request_status, error_code, created_at)
       VALUES (?, ?, 'platform_shared', ?, ?, ?, 0, 'reserved', NULL, ?)`,
      [userId, profileId || null, usage, strategyId, normalizedRequestPhase, beijingNow()]
    )
    // Token quota is an accounting/reporting policy, not a pre-submit gate.
    // The reservation must stay at zero until the provider reports actual use.
    return { logId: insert.insertId, reservedTokens: 0 }
  })
}

export async function finishModelUsage(logId, { tokenCount = 0, inputTokens = 0, outputTokens = 0,
  reasoningTokens = 0, cachedTokens = 0, status = 'success', errorCode = null,
  providerRequestId = null, finishReason = null, incompleteDetails = null,
  accountingStatus = null,
  requestBytes = 0, responseBytes = 0, durationMs = 0 } = {}) {
  if (!logId) return
  const safeTokens = Math.max(0, Math.trunc(Number(tokenCount) || 0))
  const normalizedAccountingStatus = ['settled', 'estimated', 'usage_unknown'].includes(accountingStatus)
    ? accountingStatus
    : (safeTokens > 0 ? 'settled' : (status === 'success' ? 'estimated' : 'usage_unknown'))
  const preserveReservation = normalizedAccountingStatus === 'usage_unknown'
  await queryRun(
    `UPDATE ai_model_usage_logs
     SET token_count = ${preserveReservation ? 'token_count' : '?'}, input_tokens = ?, output_tokens = ?, reasoning_tokens = ?, cached_tokens = ?,
       request_status = ?, error_code = ?, provider_request_id = ?, finish_reason = ?, incomplete_details_json = ?,
       accounting_status = ?, request_bytes = ?, response_bytes = ?, duration_ms = ?
     WHERE id = ? AND request_status = 'reserved'`,
    [...(preserveReservation ? [] : [safeTokens]),
      Math.max(0, Math.trunc(Number(inputTokens) || 0)), Math.max(0, Math.trunc(Number(outputTokens) || 0)),
      Math.max(0, Math.trunc(Number(reasoningTokens) || 0)), Math.max(0, Math.trunc(Number(cachedTokens) || 0)),
      status, errorCode ? String(errorCode).slice(0, 128) : null,
      providerRequestId ? String(providerRequestId).slice(0, 191) : null,
      finishReason ? String(finishReason).slice(0, 64) : null,
      incompleteDetails ? JSON.stringify(incompleteDetails).slice(0, 4000) : null,
      normalizedAccountingStatus,
      Math.max(0, Math.trunc(Number(requestBytes) || 0)), Math.max(0, Math.trunc(Number(responseBytes) || 0)),
      Math.max(0, Math.trunc(Number(durationMs) || 0)), logId]
  )
}

export async function recoverStaleModelUsageReservations(maxAgeMinutes = 30) {
  const safeAge = Math.min(1440, Math.max(5, Math.trunc(Number(maxAgeMinutes) || 30)))
  const result = await queryRun(
    `UPDATE ai_model_usage_logs
     SET request_status = 'error', error_code = COALESCE(error_code, 'model_request_abandoned')
     WHERE request_status = 'reserved'
       AND created_at < TIMESTAMPADD(MINUTE, ?, NOW())`,
    [-safeAge]
  )
  return Number(result?.affectedRows ?? result?.changes ?? 0)
}

// [P1-1] Check platform shared model quota
export async function checkPlatformQuota(userId, usage) {
  const today = beijingNow().substring(0, 10)
  const row = await queryOne(
    `SELECT COUNT(*) as cnt, COALESCE(SUM(token_count), 0) as tokens
     FROM ai_model_usage_logs
     WHERE user_id = ? AND credential_source = 'platform_shared' AND \`usage\` = ?
       AND created_at >= ?`,
    [userId, usage, `${today} 00:00:00`]
  )
  const policy = await getPlatformUsagePolicy()
  if (row.cnt >= policy.daily_requests_per_user) {
    return { allowed: false, reason: 'daily_request_limit', used: row.cnt, limit: policy.daily_requests_per_user }
  }
  if (row.tokens >= policy.daily_tokens_per_user) {
    // Keep the historical token fields for admin/UI compatibility, but do not
    // turn an accounting threshold into a model-call admission failure. The
    // request-count limit above remains the only daily hard stop here.
    return {
      allowed: true,
      warning: 'daily_token_limit',
      tokenQuotaExceeded: true,
      used: row.tokens,
      limit: policy.daily_tokens_per_user,
      requestsUsed: row.cnt,
      tokensUsed: row.tokens,
    }
  }
  return { allowed: true, requestsUsed: row.cnt, tokensUsed: row.tokens }
}

// ─── Unified Model Resolver ───

export async function resolveAiTaskModel({ userId, strategyId, usage }) {
  if (!USAGES.includes(usage)) throw new Error(`invalid_usage:${usage}`)

  if ((usage === 'review' || usage === 'memory_compression' || usage === 'memory_consistency') && strategyId) {
    const strategy = await queryOne(
      `SELECT id, scope, owner_user_id, model_profile_id, visibility_status, is_active
       FROM auto_prompt_types WHERE id = ? AND deleted_at IS NULL`,
      [strategyId]
    )
    if (!strategy || (strategy.scope === 'private' && Number(strategy.owner_user_id) !== Number(userId))) {
      return { model: null, credential_source: 'none', error: 'strategy_access_denied', usage, strategy_id: strategyId }
    }
    if (strategy.visibility_status !== 'active' || !Number(strategy.is_active)) {
      return { model:null, credential_source:'none', error:strategy.scope === 'platform'
        ? 'platform_strategy_not_active' : 'private_strategy_not_active', usage, strategy_id:strategyId }
    }
    if (strategy.model_profile_id) {
      const platform = strategy.scope === 'platform'
      const bound = await queryOne(
        `SELECT * FROM ai_model_profiles
         WHERE id = ? AND scope = ? AND owner_user_id = ?
           AND status = 'active' AND deleted_at IS NULL`,
        [strategy.model_profile_id, platform ? 'platform' : 'user', platform ? 0 : userId]
      )
      if (!bound || !bound.api_key_encrypted) {
        return { model: null, credential_source: 'none', error: 'bound_model_unavailable', usage, strategy_id: strategyId, model_profile_id: strategy.model_profile_id }
      }
      try { await assertConfirmedModelProfile(bound) }
      catch (error) { return { model:null, credential_source:'none', error:error.message, usage, strategy_id:strategyId, model_profile_id:strategy.model_profile_id } }
      return { ...buildResult(bound, platform ? 'platform_primary' : 'user', usage, 'strategy_binding'), strategy_id: strategyId }
    }
    if (strategy.scope === 'platform') {
      return { ...(await resolvePlatformModel(usage)), strategy_id: strategyId }
    }
  }

  if (usage === 'auto_platform') {
    if (strategyId) {
      const strategy = await queryOne(
        `SELECT id, scope, model_profile_id, visibility_status, is_active
         FROM auto_prompt_types WHERE id = ? AND deleted_at IS NULL`,
        [strategyId]
      )
      if (!strategy || strategy.scope !== 'platform') {
        return { model: null, credential_source: 'none', error: 'strategy_access_denied', usage, strategy_id: strategyId }
      }
      if (strategy.visibility_status !== 'active' || !Number(strategy.is_active)) {
        return { model: null, credential_source: 'none', error: 'platform_strategy_not_active', usage, strategy_id: strategyId }
      }
      if (strategy.model_profile_id) {
        const bound = await queryOne(
          `SELECT * FROM ai_model_profiles
           WHERE id = ? AND scope = 'platform' AND owner_user_id = 0
             AND status = 'active' AND deleted_at IS NULL`,
          [strategy.model_profile_id]
        )
        if (!bound || !bound.api_key_encrypted) {
          return { model: null, credential_source: 'none', error: 'bound_model_unavailable', usage, strategy_id: strategyId, model_profile_id: strategy.model_profile_id }
        }
        try { await assertConfirmedModelProfile(bound) }
        catch (error) { return { model:null, credential_source:'none', error:error.message, usage, strategy_id:strategyId, model_profile_id:strategy.model_profile_id } }
        return { ...buildResult(bound, 'platform_primary', usage, 'strategy_binding'), strategy_id: strategyId }
      }
    }
    return await resolvePlatformModel(usage)
  }

  if (usage === 'manual' && strategyId) {
    const strategy = await queryOne(
      `SELECT id, scope, owner_user_id, model_profile_id, visibility_status, is_active
       FROM auto_prompt_types WHERE id = ? AND deleted_at IS NULL`,
      [strategyId]
    )
    if (!strategy
      || (strategy.scope !== 'platform' && strategy.scope !== 'private')
      || (strategy.scope === 'private' && Number(strategy.owner_user_id) !== Number(userId))) {
      return { model: null, credential_source: 'none', error: 'strategy_access_denied', usage, strategy_id: strategyId }
    }
    if (strategy.visibility_status !== 'active' || !Number(strategy.is_active)) {
      return {
        model: null,
        credential_source: 'none',
        error: strategy.scope === 'platform' ? 'platform_strategy_not_active' : 'private_strategy_not_active',
        usage,
        strategy_id: strategyId,
      }
    }
    if (strategy.model_profile_id) {
      const platform = strategy.scope === 'platform'
      const bound = await queryOne(
        `SELECT * FROM ai_model_profiles
         WHERE id = ? AND scope = ? AND owner_user_id = ?
           AND status = 'active' AND deleted_at IS NULL`,
        [strategy.model_profile_id, platform ? 'platform' : 'user', platform ? 0 : userId]
      )
      if (!bound || !bound.api_key_encrypted) {
        // An explicit binding is an operator decision. Never conceal its
        // deletion/disablement by silently spending another model.
        return {
          model: null,
          credential_source: 'none',
          error: 'bound_model_unavailable',
          usage,
          strategy_id: strategyId,
          model_profile_id: strategy.model_profile_id,
        }
      }
      try { await assertConfirmedModelProfile(bound) }
      catch (error) {
        return { model:null, credential_source:'none', error:error.message, usage,
          strategy_id:strategyId, model_profile_id:strategy.model_profile_id }
      }
      return { ...buildResult(bound, platform ? 'platform_primary' : 'user', usage, 'strategy_binding'), strategy_id: strategyId }
    }
    if (strategy.scope === 'platform') {
      // Platform strategies without an explicit binding use the confirmed
      // platform default. Do not continue into the requesting user's default.
      return { ...(await resolvePlatformModel(usage)), strategy_id: strategyId }
    }
  }

  if (usage === 'auto_private') {
    if (!strategyId) {
      return { model: null, credential_source: 'none', error: 'strategy_id_required', usage }
    }
    const strategy = await queryOne(
      `SELECT id, scope, owner_user_id, model_profile_id, visibility_status, is_active
       FROM auto_prompt_types WHERE id = ? AND deleted_at IS NULL`,
      [strategyId]
    )
    if (!strategy || (usage === 'auto_private' && strategy.scope !== 'private')
      || (strategy.scope === 'private' && Number(strategy.owner_user_id) !== Number(userId))) {
      return { model: null, credential_source: 'none', error: usage === 'auto_private' ? 'private_strategy_access_denied' : 'strategy_access_denied', usage, strategy_id: strategyId }
    }
    if (strategy.visibility_status !== 'active' || !Number(strategy.is_active)) {
      return { model: null, credential_source: 'none', error: 'private_strategy_not_active', usage, strategy_id: strategyId }
    }
    if (strategy.scope === 'private' && strategy.model_profile_id) {
      const bound = await queryOne(
        `SELECT * FROM ai_model_profiles
         WHERE id = ? AND scope = 'user' AND owner_user_id = ?
           AND status = 'active' AND deleted_at IS NULL`,
        [strategy.model_profile_id, userId]
      )
      if (!bound || !bound.api_key_encrypted) {
        // An explicit binding is an operator decision. Never conceal its
        // deletion/disablement by silently spending platform credentials.
        return {
          model: null,
          credential_source: 'none',
          error: 'bound_model_unavailable',
          usage,
          strategy_id: strategyId,
          model_profile_id: strategy.model_profile_id,
        }
      }
      try { await assertConfirmedModelProfile(bound) }
      catch (error) {
        return { model:null, credential_source:'none', error:error.message, usage,
          strategy_id:strategyId, model_profile_id:strategy.model_profile_id }
      }
      return { ...buildResult(bound, 'user', usage, 'strategy_binding'), strategy_id: strategyId }
    }
  }

  // Step 1: User's own model (via user_model_defaults)
  const userDefault = await getUserModelDefault(userId)
  if (userDefault && userDefault.api_key_encrypted) {
    try { await assertConfirmedModelProfile(userDefault) }
    catch (error) { return { model:null, credential_source:'none', error:error.message, usage, strategy_id:strategyId || null } }
    return { ...buildResult(userDefault, 'user', usage, 'user_default'), strategy_id: strategyId || null }
  }

  // Step 2: Admin platform shared model
  const policy = await getPlatformUsagePolicy()
  const shareUsage = usage === 'memory_consistency' ? 'memory_compression' : usage
  const shareKey = `share_for_${shareUsage === 'auto_private' ? 'auto' : shareUsage}`
  if (policy[shareKey]) {
    const platformModel = await getPlatformModelForSharing()
    if (platformModel && platformModel.api_key_encrypted && isPlatformShareableProvider(platformModel.provider)) {
      const user = await queryOne('SELECT plan, plan_expires_at FROM users WHERE id = ?', [userId])
      const allowedPlans = parseAllowedPlans(policy.allowed_plans)
      if (user && allowedPlans.includes(getEffectivePlan(user))) {
        try { await assertConfirmedModelProfile(platformModel) }
        catch (error) { return { model:null, credential_source:'none', error:error.message, usage, strategy_id:strategyId || null } }
        return { ...buildResult(platformModel, 'platform_shared', usage, 'platform_fallback'), strategy_id: strategyId || null }
      }
    }
  }

  return { model: null, credential_source: 'none', error: 'no_model_configured', usage, strategy_id: strategyId || null }
}

async function resolvePlatformModel(usage = 'auto_platform') {
  const row = await queryOne('SELECT * FROM ai_model_profiles WHERE scope = "platform" AND deleted_at IS NULL AND status = "active" ORDER BY is_default DESC LIMIT 1')
  if (!row || !row.api_key_encrypted) {
    return { model: null, credential_source: 'none', error: 'no_platform_model', usage }
  }
  try { await assertConfirmedModelProfile(row) }
  catch (error) { return { model:null, credential_source:'none', error:error.message, usage } }
  return buildResult(row, 'platform_primary', usage, 'platform_primary')
}

async function getPlatformModelForSharing() {
  return await queryOne('SELECT * FROM ai_model_profiles WHERE scope = "platform" AND deleted_at IS NULL AND status = "active" ORDER BY is_default DESC, updated_at DESC LIMIT 1')
}

// [P0-3] Decrypt credential before returning to callers
function buildResult(profile, source, usage, reason) {
  if (!isEncryptionAvailable()) {
    return { model: null, credential_source: source, error: 'encryption_master_key_missing', usage, reason }
  }
  if (!isEncryptedEnvelope(profile.api_key_encrypted)) {
    return { model: null, credential_source: source, error: 'credential_not_encrypted', usage, reason }
  }
  let decryptedKey
  try {
    decryptedKey = decryptCredential(profile.api_key_encrypted)
  } catch (e) {
    console.error(`[ModelProfiles] Failed to decrypt key for profile ${profile.id}:`, e.message)
    return { model: null, credential_source: source, error: 'credential_decryption_failed', usage, reason }
  }
  const tokenCapabilities = getProfileTokenCapabilities(profile)
    || normalizeProviderCapabilities(profile)
  return {
    model: {
      id: profile.id,
      provider: profile.provider,
      api_provider: profile.provider,
      model_name: profile.model_name,
      api_base_url: profile.api_base_url,
      api_key_encrypted: decryptedKey,
      key_version: profile.key_version,
      temperature: profile.temperature,
      thinking_enabled: profile.thinking_enabled,
      reasoning_effort: profile.reasoning_effort,
      request_timeout_ms: profile.request_timeout_ms,
      context_window_tokens:tokenCapabilities.context_window_tokens,
      max_input_tokens:tokenCapabilities.max_input_tokens,
      max_output_tokens:tokenCapabilities.max_output_tokens,
      context_limit_semantics:tokenCapabilities.context_limit_semantics,
      token_limits_source:tokenCapabilities.token_limits_source,
      token_limits_status:tokenCapabilities.token_limits_status,
      owner_user_id: profile.owner_user_id,
      profile_updated_at: profile.updated_at || null,
    },
    credential_source: source,
    usage,
    reason,
    model_profile_id: profile.id,
    model_owner_user_id: profile.owner_user_id,
  }
}

function sanitizeProfile(row) {
  const out = { ...row }
  out.has_api_key = !!out.api_key_encrypted
  out.share_eligible = isPlatformShareableProvider(out.provider)
  out.masked_api_key = out.has_api_key ? '****' : null
  delete out.api_key_encrypted
  return out
}

async function sanitizeProfileWithCapabilities(row) {
  const profile = sanitizeProfile(row)
  const capabilities = await getModelProviderCapabilities(row.id)
  const result = {
    ...profile,
    context_window_tokens:capabilities.context_window_tokens,
    max_input_tokens:capabilities.max_input_tokens,
    max_output_tokens:capabilities.max_output_tokens,
    context_limit_semantics:capabilities.context_limit_semantics,
    token_limits_source:capabilities.token_limits_source,
    token_limits_status:capabilities.token_limits_status,
    token_limits_note:capabilities.token_limits_note,
    token_limits_updated_by:capabilities.token_limits_updated_by,
    token_limits_updated_at_utc_msc:capabilities.token_limits_updated_at_utc_msc,
    verification_status:capabilities.verification_status,
    provider_verification_status:capabilities.verification_status,
    provider_capability_source:capabilities.capability_source || null,
  }
  // Keep the capability identity available to server-side binding checks while
  // avoiding a new public credential/configuration field in the JSON response.
  for (const [key, value] of Object.entries({
    capability_provider:capabilities.provider || null,
    capability_model_name:capabilities.model_name || null,
    capability_api_base_url:capabilities.api_base_url || null,
    capability_protocol:capabilities.protocol || null,
  })) {
    Object.defineProperty(result, key, { value, enumerable:false, configurable:true })
  }
  return result
}

// ─── Legacy Migration Helpers ───

export async function migrateLegacyConfigs() {
  // Legacy tables remain untouched. In particular, do not recreate an active
  // profile from an old encrypted key on every startup: that would make an
  // unverified model selectable without the explicit save-and-verify flow.
  // The legacy rows and keys are retained for an explicitly authorized,
  // audited migration tool; no provider call or database write occurs here.
  console.log('[ModelProfiles] Legacy profile migration is disabled; awaiting explicit save-and-verify')
  return []
}

function sameSecret(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8')
  const b = Buffer.from(String(right || ''), 'utf8')
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

async function findMatchingRuntimeProfile(run, ownerId, scope, provider, modelName, legacySecret) {
  const expectedSecret = isEncryptedEnvelope(legacySecret) ? decryptCredential(legacySecret) : legacySecret
  const [profiles] = await run(`SELECT id, api_key_encrypted FROM ai_model_profiles
    WHERE owner_user_id = ? AND scope = ? AND provider = ? AND model_name = ?
      AND status = 'active' AND deleted_at IS NULL`, [ownerId, scope, provider || 'deepseek', modelName || 'deepseek-chat'])
  for (const profile of profiles) {
    if (!isEncryptedEnvelope(profile.api_key_encrypted)) continue
    if (sameSecret(decryptCredential(profile.api_key_encrypted), expectedSecret)) return profile.id
  }
  throw new Error(`legacy_credential_not_verified:${scope}:${ownerId}:${provider || 'deepseek'}`)
}

export async function rotateModelProfileCredentials() {
  if (!isEncryptionAvailable()) throw new Error('encryption_master_key_missing')
  const activeVersion = getActiveKeyVersion()
  return recordCredentialMigration({}, async run => {
    const [profiles] = await run(`SELECT id, api_key_encrypted, key_version FROM ai_model_profiles
      WHERE api_key_encrypted IS NOT NULL AND status = 'active' AND deleted_at IS NULL FOR UPDATE`)
    let rotatedCount = 0
    for (const profile of profiles) {
      const plaintext = decryptCredential(profile.api_key_encrypted)
      if (profile.key_version === activeVersion && JSON.parse(profile.api_key_encrypted).v === activeVersion) continue
      const encrypted = encryptCredential(plaintext)
      await run('UPDATE ai_model_profiles SET api_key_encrypted = ?, key_version = ?, updated_at = ? WHERE id = ?', [encrypted, activeVersion, beijingNow(), profile.id])
      rotatedCount++
    }
    return { migratedCount: profiles.length, rotatedCount, legacyCleared: false }
  })
}

export async function finalizeLegacyCredentialCleanup() {
  if (!isEncryptionAvailable()) throw new Error('encryption_master_key_missing')
  return recordCredentialMigration({}, async run => {
    const [manual] = await run(`SELECT user_id, api_provider, model_name, api_key_encrypted FROM ai_configs
      WHERE api_key_encrypted IS NOT NULL AND api_key_encrypted <> '' FOR UPDATE`)
    const [globalRows] = await run(`SELECT api_provider, model_name, api_key_encrypted FROM global_auto_config
      WHERE id = 1 AND api_key_encrypted IS NOT NULL AND api_key_encrypted <> '' FOR UPDATE`)
    const [closeRows] = await run(`SELECT user_id, api_provider, model_name, api_key_encrypted FROM close_config
      WHERE api_key_encrypted IS NOT NULL AND api_key_encrypted <> '' FOR UPDATE`)
    const [systemRows] = await run("SELECT `key`, `value` FROM system_config WHERE category = 'ai_provider' AND `key` LIKE '%_api_key' AND `value` <> '' FOR UPDATE")
    for (const row of manual) await findMatchingRuntimeProfile(run, row.user_id, 'user', row.api_provider, row.model_name, row.api_key_encrypted)
    for (const row of closeRows) await findMatchingRuntimeProfile(run, row.user_id, 'user', row.api_provider, row.model_name, row.api_key_encrypted)
    for (const row of globalRows) await findMatchingRuntimeProfile(run, 0, 'platform', row.api_provider, row.model_name, row.api_key_encrypted)
    for (const row of systemRows) {
      const provider = row.key.replace(/_api_key$/, '')
      const [[modelRow]] = await run("SELECT `value` FROM system_config WHERE category = 'ai_provider' AND `key` = ? LIMIT 1", [`${provider}_model`])
      await findMatchingRuntimeProfile(run, 0, 'platform', provider, modelRow?.value, row.value)
    }
    await run('UPDATE ai_configs SET api_key_encrypted = NULL WHERE api_key_encrypted IS NOT NULL')
    await run('UPDATE global_auto_config SET api_key_encrypted = NULL WHERE id = 1')
    await run('UPDATE close_config SET api_key_encrypted = NULL WHERE api_key_encrypted IS NOT NULL')
    await run("UPDATE system_config SET `value` = '' WHERE category = 'ai_provider' AND `key` LIKE '%_api_key'")
    return { migratedCount: manual.length + globalRows.length + closeRows.length + systemRows.length, rotatedCount: 0, legacyCleared: true }
  })
}
