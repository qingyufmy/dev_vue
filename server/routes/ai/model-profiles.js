// ai/model-profiles.js — 统一模型管理 + 解析器 + 使用日志

import crypto from 'node:crypto'
import { queryOne, queryAll, queryRun, withTransaction, beijingNow } from '../../db.js'
import { encryptCredential, decryptCredential, isEncryptionAvailable, isEncryptedEnvelope, getActiveKeyVersion } from '../../ai-credential.js'
import { recordCredentialMigration } from './rollout-governance.js'
import { isPlatformShareableProvider, normalizeModelProviderProfile } from './model-providers.js'
import { getEffectivePlan } from '../../membership.js'

export const MODEL_PROFILE_SCOPE = { USER: 'user', PLATFORM: 'platform' }
export const USAGES = ['manual', 'model_compare', 'auto_private', 'auto_platform', 'review', 'memory_compression']
const MODEL_REQUEST_TIMEOUT_MIN_MS = 30000
const MODEL_REQUEST_TIMEOUT_MAX_MS = 600000

function normalizeRequestTimeout(value, fallback = null) {
  if (value === undefined) return fallback
  if (value === null || value === '') return null
  const timeout = Number(value)
  if (!Number.isInteger(timeout) || timeout < MODEL_REQUEST_TIMEOUT_MIN_MS || timeout > MODEL_REQUEST_TIMEOUT_MAX_MS) {
    throw new Error('model_request_timeout_out_of_range')
  }
  return timeout
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

// ─── Model Profiles CRUD ───

export async function createModelProfile(userId, payload, callerRole) {
  const now = beijingNow()
  const scope = payload.scope || MODEL_PROFILE_SCOPE.USER
  // [P1-2] Platform scope requires admin role
  if (scope === MODEL_PROFILE_SCOPE.PLATFORM && callerRole !== 'admin') {
    throw new Error('platform_scope_requires_admin')
  }
  const ownerUserId = scope === MODEL_PROFILE_SCOPE.PLATFORM ? 0 : userId
  const providerConfig = normalizeModelProviderProfile(payload)
  const requestTimeoutMs = normalizeRequestTimeout(payload.request_timeout_ms)
  let keyEnc = null
  let keyVersion = null
  if (payload.api_key) {
    if (!isEncryptionAvailable()) throw new Error('encryption_master_key_missing')
    keyEnc = encryptCredential(payload.api_key)
    keyVersion = getActiveKeyVersion()
  }
  const result = await queryRun(
    `INSERT INTO ai_model_profiles
      (owner_user_id, scope, provider, model_name, api_base_url, api_key_encrypted, key_version,
       temperature, max_tokens, thinking_enabled, reasoning_effort, request_timeout_ms, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
    [
      ownerUserId,
      scope,
      providerConfig.provider,
      providerConfig.model_name,
      providerConfig.api_base_url,
      keyEnc,
      keyVersion,
      payload.temperature ?? 0.3,
      payload.max_tokens ?? 8000,
      providerConfig.thinking_enabled,
      providerConfig.reasoning_effort,
      requestTimeoutMs,
      now, now,
    ]
  )
  return await getModelProfileById(result.insertId)
}

export async function getModelProfileById(id) {
  const row = await queryOne('SELECT * FROM ai_model_profiles WHERE id = ? AND deleted_at IS NULL', [id])
  if (!row) return null
  return sanitizeProfile(row)
}

export async function getUserModelProfiles(userId) {
  const rows = await queryAll(
    'SELECT * FROM ai_model_profiles WHERE owner_user_id = ? AND deleted_at IS NULL ORDER BY is_default DESC, updated_at DESC',
    [userId]
  )
  return rows.map(sanitizeProfile)
}

export async function upsertDefaultModelProfileFromLegacyInput(userId, callerRole, payload = {}, scope = 'user') {
  if (!payload.api_key) return null
  if (scope === MODEL_PROFILE_SCOPE.PLATFORM && callerRole !== 'admin') throw new Error('platform_scope_requires_admin')
  const ownerId = scope === MODEL_PROFILE_SCOPE.PLATFORM ? 0 : userId
  const current = await queryOne(`SELECT id FROM ai_model_profiles WHERE owner_user_id = ? AND scope = ?
    AND status = 'active' AND deleted_at IS NULL ORDER BY is_default DESC, updated_at DESC LIMIT 1`, [ownerId, scope])
  let profile
  if (current) profile = await updateModelProfile(current.id, ownerId, payload)
  else profile = await createModelProfile(userId, { ...payload, scope }, callerRole)
  await setDefaultModelProfile(ownerId, profile.id)
  return profile
}

/** Runtime-only credential resolution for an owner testing a specific profile. */
export async function resolveOwnedModelProfileForRuntime(id, userId) {
  const row = await queryOne(`SELECT * FROM ai_model_profiles
    WHERE id = ? AND owner_user_id = ? AND status = 'active' AND deleted_at IS NULL`, [id, userId])
  if (!row) return { model: null, credential_source: 'none', error: 'model_profile_not_found_or_inactive', usage: 'manual' }
  return buildResult(row, row.scope === 'platform' ? 'platform_primary' : 'user', 'manual', 'connection_test')
}

export async function updateModelProfile(id, userId, payload) {
  const now = beijingNow()
  const existing = await queryOne('SELECT * FROM ai_model_profiles WHERE id = ? AND deleted_at IS NULL', [id])
  if (!existing) throw new Error('model_profile_not_found')
  if (existing.owner_user_id !== userId) throw new Error('model_profile_access_denied')
  const providerConfig = normalizeModelProviderProfile(payload, existing)
  const requestTimeoutMs = normalizeRequestTimeout(payload.request_timeout_ms, existing.request_timeout_ms)

  let keyEnc = existing.api_key_encrypted
  let keyVersion = existing.key_version
  // [P1-4] Only update key_version when api_key actually changes
  if (payload.api_key) {
    if (!isEncryptionAvailable()) throw new Error('encryption_master_key_missing')
    keyEnc = encryptCredential(payload.api_key)
    keyVersion = getActiveKeyVersion()
  }
  await queryRun(
    `UPDATE ai_model_profiles SET
      provider = COALESCE(?, provider), model_name = COALESCE(?, model_name),
      api_base_url = COALESCE(?, api_base_url), api_key_encrypted = COALESCE(?, api_key_encrypted),
      key_version = ?,
      temperature = COALESCE(?, temperature), max_tokens = COALESCE(?, max_tokens),
      thinking_enabled = COALESCE(?, thinking_enabled), reasoning_effort = COALESCE(?, reasoning_effort),
      request_timeout_ms = ?,
      updated_at = ?
     WHERE id = ? AND deleted_at IS NULL`,
    [
      providerConfig.provider, providerConfig.model_name,
      providerConfig.api_base_url,
      keyEnc !== undefined ? keyEnc : null,
      keyVersion,
      payload.temperature ?? null, payload.max_tokens ?? null,
      providerConfig.thinking_enabled,
      providerConfig.reasoning_effort,
      requestTimeoutMs,
      now, id,
    ]
  )
  return await getModelProfileById(id)
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
    'SELECT * FROM ai_model_profiles WHERE id = ? AND owner_user_id = ? AND deleted_at IS NULL AND status = "active"',
    [profileId, userId]
  )
  if (!profile) throw new Error('model_profile_not_found_or_inactive')
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
            mp.temperature, mp.max_tokens, mp.thinking_enabled, mp.reasoning_effort, mp.status
     FROM user_model_defaults ump
     JOIN ai_model_profiles mp ON mp.id = ump.model_profile_id
     WHERE ump.user_id = ? AND mp.deleted_at IS NULL AND mp.status = 'active'`,
    [userId]
  )
  return row || null
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
 * reserve their worst-case token budget under a per-user row lock so concurrent
 * requests cannot all pass the same quota check.
 */
export async function beginModelUsage({ userId, profileId, credentialSource, usage, strategyId = null, estimatedTokens = 0 }) {
  const safeEstimate = Math.max(0, Math.trunc(Number(estimatedTokens) || 0))
  if (credentialSource !== 'platform_shared') {
    const result = await queryRun(
      `INSERT INTO ai_model_usage_logs
        (user_id, model_profile_id, credential_source, \`usage\`, strategy_id, token_count, request_status, error_code, created_at)
       VALUES (?, ?, ?, ?, ?, 0, 'reserved', NULL, ?)`,
      [userId || 0, profileId || null, credentialSource || 'user', usage, strategyId, beijingNow()]
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
    const shareKey = `share_for_${usage === 'auto_private' ? 'auto' : usage}`
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
    const usedTokens = Number(rows[0]?.tokens || 0)
    if (usedRequests >= Number(policy.daily_requests_per_user)) throw new Error('daily_request_limit')
    if (usedTokens + safeEstimate > Number(policy.daily_tokens_per_user)) throw new Error('daily_token_limit')

    const [insert] = await run(
      `INSERT INTO ai_model_usage_logs
        (user_id, model_profile_id, credential_source, \`usage\`, strategy_id, token_count, request_status, error_code, created_at)
       VALUES (?, ?, 'platform_shared', ?, ?, ?, 'reserved', NULL, ?)`,
      [userId, profileId || null, usage, strategyId, safeEstimate, beijingNow()]
    )
    return { logId: insert.insertId, reservedTokens: safeEstimate }
  })
}

export async function finishModelUsage(logId, { tokenCount = 0, status = 'success', errorCode = null,
  requestBytes = 0, responseBytes = 0, durationMs = 0 } = {}) {
  if (!logId) return
  const safeTokens = Math.max(0, Math.trunc(Number(tokenCount) || 0))
  await queryRun(
    `UPDATE ai_model_usage_logs
     SET token_count = ?, request_status = ?, error_code = ?, request_bytes = ?, response_bytes = ?, duration_ms = ?
     WHERE id = ? AND request_status = 'reserved'`,
    [safeTokens, status, errorCode ? String(errorCode).slice(0, 128) : null,
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
    return { allowed: false, reason: 'daily_token_limit', used: row.tokens, limit: policy.daily_tokens_per_user }
  }
  return { allowed: true, requestsUsed: row.cnt, tokensUsed: row.tokens }
}

// ─── Unified Model Resolver ───

export async function resolveAiTaskModel({ userId, strategyId, usage }) {
  if (!USAGES.includes(usage)) throw new Error(`invalid_usage:${usage}`)

  if (usage === 'review' && strategyId) {
    const strategy = await queryOne(
      `SELECT id, scope, owner_user_id, model_profile_id
       FROM auto_prompt_types WHERE id = ?`,
      [strategyId]
    )
    if (!strategy || (strategy.scope === 'private' && Number(strategy.owner_user_id) !== Number(userId))) {
      return { model: null, credential_source: 'none', error: 'strategy_access_denied', usage, strategy_id: strategyId }
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
        return { ...buildResult(bound, 'platform_primary', usage, 'strategy_binding'), strategy_id: strategyId }
      }
    }
    return await resolvePlatformModel(usage)
  }

  if (usage === 'auto_private' || (usage === 'manual' && strategyId)) {
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
      return { ...buildResult(bound, 'user', usage, 'strategy_binding'), strategy_id: strategyId }
    }
  }

  // Step 1: User's own model (via user_model_defaults)
  const userDefault = await getUserModelDefault(userId)
  if (userDefault && userDefault.api_key_encrypted) {
    return { ...buildResult(userDefault, 'user', usage, 'user_default'), strategy_id: strategyId || null }
  }

  // Step 2: Admin platform shared model
  const policy = await getPlatformUsagePolicy()
  const shareKey = `share_for_${usage === 'auto_private' ? 'auto' : usage}`
  if (policy[shareKey]) {
    const platformModel = await getPlatformModelForSharing()
    if (platformModel && platformModel.api_key_encrypted && isPlatformShareableProvider(platformModel.provider)) {
      const user = await queryOne('SELECT plan, plan_expires_at FROM users WHERE id = ?', [userId])
      const allowedPlans = parseAllowedPlans(policy.allowed_plans)
      if (user && allowedPlans.includes(getEffectivePlan(user))) {
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
      max_tokens: profile.max_tokens,
      thinking_enabled: profile.thinking_enabled,
      reasoning_effort: profile.reasoning_effort,
      request_timeout_ms: profile.request_timeout_ms,
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

// ─── Legacy Migration Helpers ───

async function ensureMigratedDefault(scope, ownerUserId, profileId, now) {
  if (scope === MODEL_PROFILE_SCOPE.PLATFORM) {
    const current = await queryOne(
      "SELECT id FROM ai_model_profiles WHERE scope = 'platform' AND is_default = 1 AND status = 'active' AND deleted_at IS NULL LIMIT 1"
    )
    if (!current) await queryRun('UPDATE ai_model_profiles SET is_default = 1, updated_at = ? WHERE id = ?', [now, profileId])
    return
  }
  const inserted = await queryRun(
    `INSERT IGNORE INTO user_model_defaults (user_id, model_profile_id, created_at, updated_at)
     VALUES (?, ?, ?, ?)`,
    [ownerUserId, profileId, now, now]
  )
  if (inserted.changes > 0) {
    await queryRun('UPDATE ai_model_profiles SET is_default = 1, updated_at = ? WHERE id = ?', [now, profileId])
  }
}

async function migrateOneProfile({ ownerUserId, scope, provider, modelName, baseUrl, apiKey, temperature, maxTokens, now }) {
  const normalizedProvider = provider || 'deepseek'
  const normalizedModel = modelName || 'deepseek-chat'
  let profile = await queryOne(
    `SELECT id FROM ai_model_profiles
     WHERE owner_user_id = ? AND scope = ? AND provider = ? AND model_name = ? AND deleted_at IS NULL`,
    [ownerUserId, scope, normalizedProvider, normalizedModel]
  )
  let created = false
  if (!profile) {
    const encrypted = isEncryptedEnvelope(apiKey) ? apiKey : encryptCredential(apiKey)
    const result = await queryRun(
      `INSERT INTO ai_model_profiles
        (owner_user_id, scope, provider, model_name, api_base_url, api_key_encrypted, key_version,
         temperature, max_tokens, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      [ownerUserId, scope, normalizedProvider, normalizedModel, baseUrl || null, encrypted,
       JSON.parse(encrypted).v, temperature ?? 0.3, maxTokens ?? 2000, now, now]
    )
    profile = { id: result.insertId }
    created = true
  }
  await ensureMigratedDefault(scope, ownerUserId, profile.id, now)
  return { profileId: profile.id, created }
}

export async function migrateLegacyConfigs() {
  if (!isEncryptionAvailable()) throw new Error('encryption_master_key_missing')
  const results = []
  const now = beijingNow()

  const configs = await queryAll(
    `SELECT id, user_id, api_key_encrypted, api_provider, model_name, api_base_url, temperature, max_tokens
     FROM ai_configs WHERE api_key_encrypted IS NOT NULL AND api_key_encrypted != ''
     ORDER BY updated_at DESC`
  )
  for (const cfg of configs) {
    const migrated = await migrateOneProfile({
      ownerUserId: cfg.user_id, scope: MODEL_PROFILE_SCOPE.USER, provider: cfg.api_provider,
      modelName: cfg.model_name, baseUrl: cfg.api_base_url, apiKey: cfg.api_key_encrypted,
      temperature: cfg.temperature, maxTokens: cfg.max_tokens, now,
    })
    if (migrated.created) results.push({ source: 'ai_configs', id: cfg.id, user_id: cfg.user_id })
  }

  const gac = await queryOne(
    "SELECT id, api_key_encrypted, api_provider, model_name, api_base_url, temperature, max_tokens FROM global_auto_config WHERE id = 1 AND api_key_encrypted IS NOT NULL AND api_key_encrypted != ''"
  )
  if (gac) {
    const migrated = await migrateOneProfile({
      ownerUserId: 0, scope: MODEL_PROFILE_SCOPE.PLATFORM, provider: gac.api_provider,
      modelName: gac.model_name, baseUrl: gac.api_base_url, apiKey: gac.api_key_encrypted,
      temperature: gac.temperature, maxTokens: gac.max_tokens, now,
    })
    if (migrated.created) results.push({ source: 'global_auto_config', id: gac.id })
  }

  const allSysConfigs = await queryAll(
    "SELECT `key`, `value` FROM system_config WHERE category = 'ai_provider' AND `value` != ''"
  )
  const providerMap = {}
  for (const row of allSysConfigs) {
    const match = row.key.match(/^(.*)_(api_key|model|base_url)$/)
    if (!match) continue
    const [, provider, field] = match
    if (!providerMap[provider]) providerMap[provider] = {}
    providerMap[provider][field] = row.value
  }
  for (const [provider, cfg] of Object.entries(providerMap)) {
    if (!cfg.api_key) continue
    const migrated = await migrateOneProfile({
      ownerUserId: 0, scope: MODEL_PROFILE_SCOPE.PLATFORM, provider,
      modelName: cfg.model, baseUrl: cfg.base_url, apiKey: cfg.api_key,
      temperature: 0.3, maxTokens: 2000, now,
    })
    if (migrated.created) results.push({ source: 'system_config', provider })
  }

  const closeConfigs = await queryAll(
    `SELECT user_id, api_key_encrypted, api_provider, model_name, api_base_url, temperature, max_tokens
     FROM close_config WHERE api_key_encrypted IS NOT NULL AND api_key_encrypted != ''
     ORDER BY updated_at DESC`
  )
  for (const cfg of closeConfigs) {
    const migrated = await migrateOneProfile({
      ownerUserId: cfg.user_id, scope: MODEL_PROFILE_SCOPE.USER, provider: cfg.api_provider,
      modelName: cfg.model_name, baseUrl: cfg.api_base_url, apiKey: cfg.api_key_encrypted,
      temperature: cfg.temperature, maxTokens: cfg.max_tokens, now,
    })
    if (migrated.created) results.push({ source: 'close_config', user_id: cfg.user_id })
  }

  console.log(`[ModelProfiles] Legacy migration: ${results.length} profiles created`)
  return results
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
