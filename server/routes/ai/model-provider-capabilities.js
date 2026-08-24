import { queryOne, queryRun } from '../../db.js'

export const MODEL_PROVIDER_CAPABILITY_KEYS = Object.freeze([
  'supports_stream', 'supports_request_id', 'supports_poll', 'supports_cancel',
  'supports_idempotency', 'supports_structured_output', 'supports_usage_split',
])

export const MODEL_TOKEN_LIMIT_DEFAULTS = Object.freeze({
  context_window_tokens: 1048576,
  max_input_tokens: 1048576,
  max_output_tokens: 393216,
  context_limit_semantics: 'shared_context',
})

const TOKEN_LIMIT_SOURCES = new Set(['manual_confirmed', 'generic_default', 'legacy_unverified'])
const TOKEN_LIMIT_STATUSES = new Set(['default_unconfirmed', 'confirmed', 'stale'])
const PROVIDER_IDENTITY_KEYS = Object.freeze(['provider', 'model_name', 'api_base_url', 'protocol'])

// These are the only provider endpoints that the service can attest to at
// runtime without an administrator having verified a model profile. The exact
// hostname, protocol and provider are all part of the match on purpose: a
// proxy, gateway or OpenAI-compatible provider must never inherit the official
// provider's streaming contract by accident.
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
    ...MODEL_TOKEN_LIMIT_DEFAULTS,
    token_limits_source:'generic_default',
    token_limits_status:'default_unconfirmed',
    verified_at_utc_msc:null,
    verification_status:'verified',
    capability_source:'builtin_verified',
    provider:matched.provider,
    protocol:matched.protocol,
  }
}

function positiveInteger(value, fallback = null) {
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? number : fallback
}

export function normalizeProviderCapabilities(row = {}) {
  const verificationStatus = String(row.verification_status || 'unverified')
  const isVerified = verificationStatus === 'verified'
  const normalized = Object.fromEntries(MODEL_PROVIDER_CAPABILITY_KEYS.map(key => [key, isVerified && Boolean(Number(row[key]))]))
  const tokenSource = TOKEN_LIMIT_SOURCES.has(String(row.token_limits_source || ''))
    ? String(row.token_limits_source) : 'generic_default'
  const tokenStatus = TOKEN_LIMIT_STATUSES.has(String(row.token_limits_status || ''))
    ? String(row.token_limits_status) : 'default_unconfirmed'
  return {
    ...normalized,
    // Token limits are administrator-entered physical model facts. They are
    // deliberately independent from provider transport verification: an
    // unverified stream contract must not erase a useful manual token limit.
    context_window_tokens:positiveInteger(row.context_window_tokens,
      row.context_window_tokens == null && tokenSource === 'generic_default'
        ? MODEL_TOKEN_LIMIT_DEFAULTS.context_window_tokens : null),
    max_input_tokens:positiveInteger(row.max_input_tokens,
      row.max_input_tokens == null && tokenSource === 'generic_default'
        ? MODEL_TOKEN_LIMIT_DEFAULTS.max_input_tokens : null),
    max_output_tokens:positiveInteger(row.max_output_tokens,
      row.max_output_tokens == null && tokenSource === 'generic_default'
        ? MODEL_TOKEN_LIMIT_DEFAULTS.max_output_tokens : null),
    context_limit_semantics:String(row.context_limit_semantics || MODEL_TOKEN_LIMIT_DEFAULTS.context_limit_semantics),
    token_limits_source:tokenSource,
    token_limits_status:tokenStatus,
    token_limits_note:row.token_limits_note == null ? null : String(row.token_limits_note),
    token_limits_updated_by:Number(row.token_limits_updated_by) > 0 ? Number(row.token_limits_updated_by) : null,
    token_limits_updated_at_utc_msc:Number(row.token_limits_updated_at_utc_msc) > 0
      ? Number(row.token_limits_updated_at_utc_msc) : null,
    verified_at_utc_msc:Number(row.verified_at_utc_msc) > 0 ? Number(row.verified_at_utc_msc) : null,
    verification_status:verificationStatus,
    ...Object.fromEntries(PROVIDER_IDENTITY_KEYS
      .filter(key => row[key] != null && row[key] !== '')
      .map(key => [key, String(row[key])])),
    ...(row.capability_source ? { capability_source:String(row.capability_source) } : {}),
  }
}

export function modelStreamingCapabilityStatus(capabilities = {}) {
  if (String(capabilities?.verification_status || 'unverified') !== 'verified') return 'unverified'
  return capabilities?.supports_stream === true ? 'supported' : 'unsupported'
}

export async function getModelProviderCapabilities(modelProfileId) {
  if (!Number(modelProfileId)) return normalizeProviderCapabilities()
  const row = await queryOne(`SELECT * FROM ai_model_provider_capabilities
    WHERE model_profile_id = ? LIMIT 1`, [Number(modelProfileId)])
  return normalizeProviderCapabilities(row || {})
}

/**
 * Resolve capabilities at the point a request is built. A verified database
 * row is authoritative, including an explicit supports_stream = 0. When a
 * profile has no verified row, only the two exact official HTTPS endpoints
 * above receive the small builtin transport attestation. Token limits remain
 * independent of this provider verification state.
 */
export async function resolveModelProviderCapabilities({
  modelProfileId = null, provider = null, protocol = null, url = null,
} = {}) {
  let profileCapabilities = normalizeProviderCapabilities()
  if (Number(modelProfileId)) profileCapabilities = await getModelProviderCapabilities(modelProfileId)
  if (profileCapabilities.verification_status === 'verified') {
    return { ...profileCapabilities, capability_source:profileCapabilities.capability_source || 'db_verified' }
  }
  const builtin = builtinCapabilityFor({ provider, protocol, url })
  if (!builtin) return profileCapabilities
  // A builtin endpoint may attest transport behavior, but must not replace a
  // manually entered token record associated with the same profile.
  return {
    ...builtin,
    context_window_tokens:profileCapabilities.context_window_tokens,
    max_input_tokens:profileCapabilities.max_input_tokens,
    max_output_tokens:profileCapabilities.max_output_tokens,
    context_limit_semantics:profileCapabilities.context_limit_semantics,
    token_limits_source:profileCapabilities.token_limits_source,
    token_limits_status:profileCapabilities.token_limits_status,
    token_limits_note:profileCapabilities.token_limits_note,
    token_limits_updated_by:profileCapabilities.token_limits_updated_by,
    token_limits_updated_at_utc_msc:profileCapabilities.token_limits_updated_at_utc_msc,
  }
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
      updated_at_utc_msc = VALUES(updated_at_utc_msc)`,
  [Number(modelProfileId), ...MODEL_PROVIDER_CAPABILITY_KEYS.map(key => normalized[key] ? 1 : 0),
    normalized.context_window_tokens, normalized.max_input_tokens, normalized.max_output_tokens,
    normalized.context_limit_semantics, normalized.token_limits_source, normalized.token_limits_status,
    normalized.token_limits_note, normalized.token_limits_updated_by || Number(actorUserId) || null,
    normalized.token_limits_updated_at_utc_msc || Date.now(), normalized.provider || null,
    normalized.model_name || null, normalized.api_base_url || null, normalized.protocol || null,
    normalized.verification_status, Number(actorUserId) || null, normalized.verified_at_utc_msc, Date.now()])
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
