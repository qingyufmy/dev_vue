// ai/model-profiles.js — 统一模型管理 + 解析器 + 使用日志

import { queryOne, queryAll, queryRun, withTransaction, beijingNow } from '../../db.js'
import { encryptCredential, decryptCredential, isEncryptionAvailable, isEncryptedEnvelope, getActiveKeyVersion } from '../../ai-credential.js'

export const MODEL_PROFILE_SCOPE = { USER: 'user', PLATFORM: 'platform' }
export const USAGES = ['manual', 'auto_private', 'auto_platform', 'review', 'memory_compression']

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
       temperature, max_tokens, thinking_enabled, reasoning_effort, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
    [
      ownerUserId,
      scope,
      payload.provider || 'deepseek',
      payload.model_name || 'deepseek-chat',
      payload.api_base_url || null,
      keyEnc,
      keyVersion,
      payload.temperature ?? 0.3,
      payload.max_tokens ?? 2000,
      payload.thinking_enabled !== undefined ? (payload.thinking_enabled ? 1 : 0) : 1,
      payload.reasoning_effort || 'max',
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
      updated_at = ?
     WHERE id = ? AND deleted_at IS NULL`,
    [
      payload.provider ?? null, payload.model_name ?? null,
      payload.api_base_url !== undefined ? payload.api_base_url : null,
      keyEnc !== undefined ? keyEnc : null,
      keyVersion,
      payload.temperature ?? null, payload.max_tokens ?? null,
      payload.thinking_enabled !== undefined ? (payload.thinking_enabled ? 1 : 0) : null,
      payload.reasoning_effort ?? null,
      now, id,
    ]
  )
  return await getModelProfileById(id)
}

export async function deleteModelProfile(id, userId) {
  const now = beijingNow()
  const existing = await queryOne('SELECT * FROM ai_model_profiles WHERE id = ? AND deleted_at IS NULL', [id])
  if (!existing) throw new Error('model_profile_not_found')
  if (existing.owner_user_id !== userId) throw new Error('model_profile_access_denied')
  await queryRun('UPDATE ai_model_profiles SET deleted_at = ?, status = "deleted" WHERE id = ?', [now, id])
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
    const [lockedUsers] = await run('SELECT id, plan FROM users WHERE id = ? FOR UPDATE', [userId])
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
    const allowedPlans = JSON.parse(policy.allowed_plans || '["pro"]')
    if (!allowedPlans.includes(lockedUsers[0].plan)) throw new Error('platform_plan_not_allowed')
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

export async function finishModelUsage(logId, { tokenCount = 0, status = 'success', errorCode = null } = {}) {
  if (!logId) return
  const safeTokens = Math.max(0, Math.trunc(Number(tokenCount) || 0))
  await queryRun(
    `UPDATE ai_model_usage_logs
     SET token_count = ?, request_status = ?, error_code = ?
     WHERE id = ? AND request_status = 'reserved'`,
    [safeTokens, status, errorCode ? String(errorCode).slice(0, 128) : null, logId]
  )
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

  if (usage === 'auto_platform') {
    return await resolvePlatformModel()
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
    if (!strategy || strategy.scope !== 'private' || Number(strategy.owner_user_id) !== Number(userId)) {
      return { model: null, credential_source: 'none', error: 'private_strategy_access_denied', usage, strategy_id: strategyId }
    }
    if (strategy.visibility_status !== 'active' || !Number(strategy.is_active)) {
      return { model: null, credential_source: 'none', error: 'private_strategy_not_active', usage, strategy_id: strategyId }
    }
    if (strategy.model_profile_id) {
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
    if (platformModel && platformModel.api_key_encrypted) {
      const user = await queryOne('SELECT plan FROM users WHERE id = ?', [userId])
      const allowedPlans = JSON.parse(policy.allowed_plans || '["pro"]')
      if (user && allowedPlans.includes(user.plan)) {
        return { ...buildResult(platformModel, 'platform_shared', usage, 'platform_fallback'), strategy_id: strategyId || null }
      }
    }
  }

  return { model: null, credential_source: 'none', error: 'no_model_configured', usage, strategy_id: strategyId || null }
}

async function resolvePlatformModel() {
  const row = await queryOne('SELECT * FROM ai_model_profiles WHERE scope = "platform" AND deleted_at IS NULL AND status = "active" ORDER BY is_default DESC LIMIT 1')
  if (!row || !row.api_key_encrypted) {
    return { model: null, credential_source: 'none', error: 'no_platform_model', usage: 'auto_platform' }
  }
  return buildResult(row, 'platform_primary', 'auto_platform', 'platform_primary')
}

async function getPlatformModelForSharing() {
  return await queryOne('SELECT * FROM ai_model_profiles WHERE scope = "platform" AND deleted_at IS NULL AND status = "active" ORDER BY is_default DESC LIMIT 1')
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
      owner_user_id: profile.owner_user_id,
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
