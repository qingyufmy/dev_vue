// ai/model-profiles.js — 统一模型管理 + 解析器 + 使用日志

import { queryOne, queryAll, queryRun, beijingNow } from '../../db.js'
import { encryptCredential, decryptCredential, isEncryptionAvailable, isEncryptedEnvelope, getActiveKeyVersion } from '../../ai-credential.js'

export const MODEL_PROFILE_SCOPE = { USER: 'user', PLATFORM: 'platform' }
export const USAGES = ['manual', 'auto_private', 'auto_platform', 'review', 'memory_compression']

// ─── Model Profiles CRUD ───

export async function createModelProfile(userId, payload) {
  const now = beijingNow()
  const keyVersion = getActiveKeyVersion()
  let keyEnc = null
  if (payload.api_key) {
    if (!isEncryptionAvailable()) throw new Error('encryption_master_key_missing')
    keyEnc = encryptCredential(payload.api_key)
  }
  const result = await queryRun(
    `INSERT INTO ai_model_profiles
      (owner_user_id, scope, provider, model_name, api_base_url, api_key_encrypted, key_version,
       temperature, max_tokens, thinking_enabled, reasoning_effort, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
    [
      userId,
      payload.scope || MODEL_PROFILE_SCOPE.USER,
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

export async function updateModelProfile(id, userId, payload) {
  const now = beijingNow()
  const existing = await queryOne('SELECT * FROM ai_model_profiles WHERE id = ? AND deleted_at IS NULL', [id])
  if (!existing) throw new Error('model_profile_not_found')
  if (existing.owner_user_id !== userId) throw new Error('model_profile_access_denied')

  let keyEnc = existing.api_key_encrypted
  if (payload.api_key) {
    if (!isEncryptionAvailable()) throw new Error('encryption_master_key_missing')
    keyEnc = encryptCredential(payload.api_key)
  }
  await queryRun(
    `UPDATE ai_model_profiles SET
      provider = COALESCE(?, provider), model_name = COALESCE(?, model_name),
      api_base_url = COALESCE(?, api_base_url), api_key_encrypted = COALESCE(?, api_key_encrypted),
      key_version = COALESCE(?, key_version),
      temperature = COALESCE(?, temperature), max_tokens = COALESCE(?, max_tokens),
      thinking_enabled = COALESCE(?, thinking_enabled), reasoning_effort = COALESCE(?, reasoning_effort),
      updated_at = ?
     WHERE id = ? AND deleted_at IS NULL`,
    [
      payload.provider ?? null, payload.model_name ?? null,
      payload.api_base_url !== undefined ? payload.api_base_url : null,
      keyEnc !== undefined ? keyEnc : null,
      getActiveKeyVersion(),
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

export async function setDefaultModelProfile(userId, profileId) {
  const now = beijingNow()
  const profile = await queryOne(
    'SELECT * FROM ai_model_profiles WHERE id = ? AND owner_user_id = ? AND deleted_at IS NULL',
    [profileId, userId]
  )
  if (!profile) throw new Error('model_profile_not_found')
  await queryRun('UPDATE ai_model_profiles SET is_default = 0 WHERE owner_user_id = ? AND deleted_at IS NULL', [userId])
  await queryRun('UPDATE ai_model_profiles SET is_default = 1, updated_at = ? WHERE id = ?', [now, profileId])
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
  const now = beijingNow()
  const profile = await queryOne(
    'SELECT * FROM ai_model_profiles WHERE id = ? AND owner_user_id = ? AND deleted_at IS NULL AND status = "active"',
    [profileId, userId]
  )
  if (!profile) throw new Error('model_profile_not_found_or_inactive')
  await queryRun(
    `INSERT INTO user_model_defaults (user_id, model_profile_id, created_at, updated_at)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE model_profile_id = VALUES(model_profile_id), updated_at = VALUES(updated_at)`,
    [userId, profileId, now, now]
  )
}

// ─── Platform Usage Policy ───

export async function getPlatformUsagePolicy() {
  let row = await queryOne('SELECT * FROM platform_model_usage_policy WHERE id = 1')
  if (!row) {
    // Default policy
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

// ─── Usage Logging ───

export async function logModelUsage(userId, profileId, credentialSource, usage, strategyId, tokenCount, status, errorCode) {
  try {
    await queryRun(
      `INSERT INTO ai_model_usage_logs
        (user_id, model_profile_id, credential_source, usage, strategy_id, token_count, request_status, error_code, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [userId, profileId || null, credentialSource, usage, strategyId || null, tokenCount || 0, status || 'success', errorCode || null, beijingNow()]
    )
  } catch (e) {
    console.error('[ModelProfiles] Failed to log usage:', e.message)
  }
}

// ─── Unified Model Resolver ───

export async function resolveAiTaskModel({ userId, strategyId, usage }) {
  if (!USAGES.includes(usage)) throw new Error(`invalid_usage:${usage}`)
  const now = beijingNow()

  // manual: user's explicit model → user default → platform shared (share_for_manual) → null
  // auto_private: strategy-bound → user default → platform shared (share_for_auto) → null
  // auto_platform: always platform model (not a fallback path — caller handles directly)
  // review: user default → platform shared (share_for_review) → null
  // memory_compression: user default → platform shared (share_for_memory_compression) → null

  if (usage === 'auto_platform') {
    return await resolvePlatformModel()
  }

  let boundProfile = null

  // For auto_private: check strategy-bound model
  if (usage === 'auto_private' && strategyId) {
    boundProfile = await queryOne(
      `SELECT mp.* FROM auto_prompt_types apt
       JOIN ai_model_profiles mp ON mp.id = apt.model_profile_id
       WHERE apt.id = ? AND apt.deleted_at IS NULL AND mp.deleted_at IS NULL AND mp.status = 'active'`,
      [strategyId]
    )
    if (boundProfile) {
      if (boundProfile.api_key_encrypted) {
        const source = boundProfile.owner_user_id === userId ? 'user' : 'platform_primary'
        return buildResult(boundProfile, source, usage, 'strategy_bound')
      }
      // Strategy bound but no key — error, don't fall through
      return { model: null, credential_source: 'none', error: 'strategy_bound_model_no_key', usage }
    }
    // Strategy has no bound model or bound model inactive → check if explicitly bound but broken
    const apt = await queryOne('SELECT model_profile_id FROM auto_prompt_types WHERE id = ? AND deleted_at IS NULL', [strategyId])
    if (apt && apt.model_profile_id) {
      // Explicitly bound but profile gone/inactive — don't silently fall back
      return { model: null, credential_source: 'none', error: 'strategy_bound_model_invalid', usage }
    }
  }

  // Step 1: User's own model (via user_model_defaults)
  const userDefault = await getUserModelDefault(userId)
  if (userDefault && userDefault.api_key_encrypted) {
    return buildResult(userDefault, 'user', usage, 'user_default')
  }

  // Step 2: Admin platform shared model
  const policy = await getPlatformUsagePolicy()
  const shareKey = `share_for_${usage === 'auto_private' ? 'auto' : usage}`
  if (policy[shareKey]) {
    const platformModel = await getPlatformModelForSharing()
    if (platformModel && platformModel.api_key_encrypted) {
      // Check plan entitlement
      const user = await queryOne('SELECT plan FROM users WHERE id = ?', [userId])
      const allowedPlans = JSON.parse(policy.allowed_plans || '["pro"]')
      if (user && allowedPlans.includes(user.plan)) {
        return buildResult(platformModel, 'platform_shared', usage, 'platform_fallback')
      }
    }
  }

  // No model available
  return { model: null, credential_source: 'none', error: 'no_model_configured', usage }
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

function buildResult(profile, source, usage, reason) {
  return {
    model: {
      id: profile.id,
      provider: profile.provider,
      model_name: profile.model_name,
      api_base_url: profile.api_base_url,
      api_key_encrypted: profile.api_key_encrypted,
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

export async function migrateLegacyConfigs() {
  const results = []
  const now = beijingNow()

  if (!isEncryptionAvailable()) {
    console.warn('[ModelProfiles] Encryption unavailable, skipping legacy migration')
    return results
  }

  // 1. Migrate ai_configs with API keys
  try {
    const configs = await queryAll(
      "SELECT id, user_id, api_key_encrypted, api_provider, model_name, api_base_url, temperature, max_tokens FROM ai_configs WHERE api_key_encrypted IS NOT NULL AND api_key_encrypted != ''"
    )
    for (const cfg of configs) {
      if (isEncryptedEnvelope(cfg.api_key_encrypted)) continue
      const profile = await queryOne(
        'SELECT id FROM ai_model_profiles WHERE owner_user_id = ? AND provider = ? AND model_name = ? AND deleted_at IS NULL',
        [cfg.user_id, cfg.api_provider, cfg.model_name]
      )
      if (profile) continue
      const encrypted = encryptCredential(cfg.api_key_encrypted)
      await queryRun(
        `INSERT INTO ai_model_profiles
          (owner_user_id, scope, provider, model_name, api_base_url, api_key_encrypted, key_version,
           temperature, max_tokens, status, created_at, updated_at)
         VALUES (?, 'user', ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
        [cfg.user_id, cfg.api_provider, cfg.model_name, cfg.api_base_url,
         encrypted, getActiveKeyVersion(), cfg.temperature ?? 0.3, cfg.max_tokens ?? 2000, now, now]
      )
      results.push({ source: 'ai_configs', id: cfg.id, user_id: cfg.user_id })
    }
  } catch (e) { console.error('[ModelProfiles] ai_configs migration error:', e.message) }

  // 2. Migrate global_auto_config
  try {
    const gac = await queryOne(
      "SELECT id, api_key_encrypted, api_provider, model_name, api_base_url, temperature, max_tokens FROM global_auto_config WHERE id = 1 AND api_key_encrypted IS NOT NULL AND api_key_encrypted != ''"
    )
    if (gac && !isEncryptedEnvelope(gac.api_key_encrypted)) {
      const exists = await queryOne(
        "SELECT id FROM ai_model_profiles WHERE scope = 'platform' AND deleted_at IS NULL LIMIT 1"
      )
      if (!exists) {
        const encrypted = encryptCredential(gac.api_key_encrypted)
        await queryRun(
          `INSERT INTO ai_model_profiles
            (owner_user_id, scope, provider, model_name, api_base_url, api_key_encrypted, key_version,
             temperature, max_tokens, status, created_at, updated_at)
           VALUES (0, 'platform', ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
          [gac.api_provider, gac.model_name, gac.api_base_url,
           encrypted, getActiveKeyVersion(), gac.temperature ?? 0.3, gac.max_tokens ?? 2000, now, now]
        )
        results.push({ source: 'global_auto_config', id: gac.id })
      }
    }
  } catch (e) { console.error('[ModelProfiles] global_auto_config migration error:', e.message) }

  // 3. Migrate system_config AI provider keys
  try {
    const sysConfigs = await queryAll(
      "SELECT `key`, `value` FROM system_config WHERE category = 'ai_provider' AND `key` LIKE '%_api_key' AND `value` != ''"
    )
    for (const row of sysConfigs) {
      if (isEncryptedEnvelope(row.value)) continue
      const provider = row.key.replace('_api_key', '')
      const modelKey = `${provider}_model`
      const baseUrlKey = `${provider}_base_url`
      const modelVal = sysConfigs.find(r => r.key === modelKey)?.value || 'deepseek-chat'
      const baseUrlVal = sysConfigs.find(r => r.key === baseUrlKey)?.value || null
      const exists = await queryOne(
        "SELECT id FROM ai_model_profiles WHERE scope = 'platform' AND provider = ? AND deleted_at IS NULL",
        [provider]
      )
      if (!exists) {
        const encrypted = encryptCredential(row.value)
        await queryRun(
          `INSERT INTO ai_model_profiles
            (owner_user_id, scope, provider, model_name, api_base_url, api_key_encrypted, key_version,
             temperature, max_tokens, status, created_at, updated_at)
           VALUES (0, 'platform', ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
          [provider, modelVal, baseUrlVal,
           encrypted, getActiveKeyVersion(), 0.3, 2000, now, now]
        )
        results.push({ source: 'system_config', key: row.key })
      }
    }
  } catch (e) { console.error('[ModelProfiles] system_config migration error:', e.message) }

  // 4. Migrate close_config
  try {
    const closeConfigs = await queryAll(
      "SELECT id, user_id, api_key_encrypted, api_provider, model_name, api_base_url, temperature, max_tokens FROM close_config WHERE api_key_encrypted IS NOT NULL AND api_key_encrypted != ''"
    )
    for (const cfg of closeConfigs) {
      if (isEncryptedEnvelope(cfg.api_key_encrypted)) continue
      const exists = await queryOne(
        'SELECT id FROM ai_model_profiles WHERE owner_user_id = ? AND provider = ? AND model_name = ? AND deleted_at IS NULL',
        [cfg.user_id, cfg.api_provider, cfg.model_name]
      )
      if (exists) continue
      const encrypted = encryptCredential(cfg.api_key_encrypted)
      await queryRun(
        `INSERT INTO ai_model_profiles
          (owner_user_id, scope, provider, model_name, api_base_url, api_key_encrypted, key_version,
           temperature, max_tokens, status, created_at, updated_at)
         VALUES (?, 'user', ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
        [cfg.user_id, cfg.api_provider, cfg.model_name, cfg.api_base_url,
         encrypted, getActiveKeyVersion(), cfg.temperature ?? 0.3, cfg.max_tokens ?? 2000, now, now]
      )
      results.push({ source: 'close_config', id: cfg.id, user_id: cfg.user_id })
    }
  } catch (e) { console.error('[ModelProfiles] close_config migration error:', e.message) }

  console.log(`[ModelProfiles] Legacy migration: ${results.length} profiles created`)
  return results
}
