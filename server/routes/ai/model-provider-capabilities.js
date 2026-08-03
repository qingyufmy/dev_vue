import { queryOne, queryRun } from '../../db.js'

export const MODEL_PROVIDER_CAPABILITY_KEYS = Object.freeze([
  'supports_stream', 'supports_request_id', 'supports_poll', 'supports_cancel',
  'supports_idempotency', 'supports_structured_output', 'supports_usage_split',
])

export function normalizeProviderCapabilities(row = {}) {
  const normalized = Object.fromEntries(MODEL_PROVIDER_CAPABILITY_KEYS.map(key => [key, Boolean(Number(row[key]))]))
  return {
    ...normalized,
    context_window_tokens:Number(row.context_window_tokens) > 0 ? Number(row.context_window_tokens) : null,
    max_output_tokens:Number(row.max_output_tokens) > 0 ? Number(row.max_output_tokens) : null,
    verified_at_utc_msc:Number(row.verified_at_utc_msc) > 0 ? Number(row.verified_at_utc_msc) : null,
    verification_status:String(row.verification_status || 'unverified'),
  }
}

export async function getModelProviderCapabilities(modelProfileId) {
  if (!Number(modelProfileId)) return normalizeProviderCapabilities()
  const row = await queryOne(`SELECT * FROM ai_model_provider_capabilities
    WHERE model_profile_id = ? LIMIT 1`, [Number(modelProfileId)])
  return normalizeProviderCapabilities(row || {})
}

export async function saveModelProviderCapabilities(modelProfileId, capabilities, actorUserId) {
  const normalized = normalizeProviderCapabilities({ ...capabilities,
    verification_status:capabilities?.verification_status || 'verified',
    verified_at_utc_msc:capabilities?.verified_at_utc_msc || Date.now() })
  await queryRun(`INSERT INTO ai_model_provider_capabilities
    (model_profile_id, supports_stream, supports_request_id, supports_poll, supports_cancel,
     supports_idempotency, supports_structured_output, supports_usage_split,
     context_window_tokens, max_output_tokens, verification_status, verified_by_user_id,
     verified_at_utc_msc, updated_at_utc_msc)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE supports_stream = VALUES(supports_stream),
      supports_request_id = VALUES(supports_request_id), supports_poll = VALUES(supports_poll),
      supports_cancel = VALUES(supports_cancel), supports_idempotency = VALUES(supports_idempotency),
      supports_structured_output = VALUES(supports_structured_output), supports_usage_split = VALUES(supports_usage_split),
      context_window_tokens = VALUES(context_window_tokens), max_output_tokens = VALUES(max_output_tokens),
      verification_status = VALUES(verification_status), verified_by_user_id = VALUES(verified_by_user_id),
      verified_at_utc_msc = VALUES(verified_at_utc_msc), updated_at_utc_msc = VALUES(updated_at_utc_msc)`,
  [Number(modelProfileId), ...MODEL_PROVIDER_CAPABILITY_KEYS.map(key => normalized[key] ? 1 : 0),
    normalized.context_window_tokens, normalized.max_output_tokens, normalized.verification_status,
    Number(actorUserId) || null, normalized.verified_at_utc_msc, Date.now()])
  return normalized
}

export function assertProviderCapability(capabilities, capability) {
  if (!MODEL_PROVIDER_CAPABILITY_KEYS.includes(capability)) throw new Error('unknown_model_provider_capability')
  if (!capabilities?.[capability]) {
    const error = new Error(`model_provider_capability_unsupported:${capability}`)
    error.code = 'model_provider_capability_unsupported'
    error.capability = capability
    throw error
  }
}
