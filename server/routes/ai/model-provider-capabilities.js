import { queryOne, queryRun } from '../../db.js'

export const MODEL_PROVIDER_CAPABILITY_KEYS = Object.freeze([
  'supports_stream', 'supports_request_id', 'supports_poll', 'supports_cancel',
  'supports_idempotency', 'supports_structured_output', 'supports_usage_split',
])

// These are the only provider endpoints that the service can attest to at
// runtime without an administrator having verified a model profile.  The
// exact hostname, protocol and provider are all part of the match on purpose:
// a proxy, gateway or OpenAI-compatible provider must never inherit the
// official provider's streaming contract by accident.
const BUILTIN_VERIFIED_ENDPOINTS = Object.freeze([
  { provider:'deepseek', protocol:'chat_completions', hostname:'api.deepseek.com' },
  { provider:'volcengine_agent_plan', protocol:'responses', hostname:'ark.cn-beijing.volces.com' },
])

function builtinCapabilityFor({ provider, protocol, url } = {}) {
  let parsed
  try { parsed = new URL(String(url || '')) } catch { return null }
  if (parsed.protocol !== 'https:') return null
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '')
  const matched = BUILTIN_VERIFIED_ENDPOINTS.find(item => item.provider === provider
    && item.protocol === protocol && item.hostname === hostname)
  if (!matched) return null
  return {
    ...Object.fromEntries(MODEL_PROVIDER_CAPABILITY_KEYS.map(key => [key, false])),
    supports_stream:true,
    supports_request_id:true,
    context_window_tokens:null,
    max_output_tokens:null,
    verified_at_utc_msc:null,
    verification_status:'verified',
    capability_source:'builtin_verified',
    provider:matched.provider,
    protocol:matched.protocol,
  }
}

export function normalizeProviderCapabilities(row = {}) {
  const verificationStatus = String(row.verification_status || 'unverified')
  const isVerified = verificationStatus === 'verified'
  const normalized = Object.fromEntries(MODEL_PROVIDER_CAPABILITY_KEYS.map(key => [key, isVerified && Boolean(Number(row[key]))]))
  return {
    ...normalized,
    context_window_tokens:isVerified && Number(row.context_window_tokens) > 0 ? Number(row.context_window_tokens) : null,
    max_output_tokens:isVerified && Number(row.max_output_tokens) > 0 ? Number(row.max_output_tokens) : null,
    verified_at_utc_msc:Number(row.verified_at_utc_msc) > 0 ? Number(row.verified_at_utc_msc) : null,
    verification_status:verificationStatus,
    ...(row.capability_source ? { capability_source:String(row.capability_source) } : {}),
  }
}

export async function getModelProviderCapabilities(modelProfileId) {
  if (!Number(modelProfileId)) return normalizeProviderCapabilities()
  const row = await queryOne(`SELECT * FROM ai_model_provider_capabilities
    WHERE model_profile_id = ? LIMIT 1`, [Number(modelProfileId)])
  return normalizeProviderCapabilities(row || {})
}

/**
 * Resolve capabilities at the point a request is built.  A verified database
 * row is authoritative, including an explicit `supports_stream = 0`.  When a
 * profile has no verified row, only the two exact official HTTPS endpoints
 * above receive the small builtin attestation.  No token limits are inferred
 * for builtin capabilities.
 */
export async function resolveModelProviderCapabilities({
  modelProfileId = null, provider = null, protocol = null, url = null,
} = {}) {
  let profileCapabilities = normalizeProviderCapabilities()
  if (Number(modelProfileId)) profileCapabilities = await getModelProviderCapabilities(modelProfileId)
  if (profileCapabilities.verification_status === 'verified') {
    return { ...profileCapabilities, capability_source:profileCapabilities.capability_source || 'db_verified' }
  }
  return builtinCapabilityFor({ provider, protocol, url }) || profileCapabilities
}

// Small aliases make the runtime resolver discoverable to call sites that
// describe this as a provider capability lookup rather than a profile lookup.
export const resolveRuntimeModelProviderCapabilities = resolveModelProviderCapabilities
export const builtinModelProviderCapabilities = builtinCapabilityFor

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
