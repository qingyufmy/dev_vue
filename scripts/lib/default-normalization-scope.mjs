export const defaultNormalizationScope = Object.freeze({
  ai_model_profiles: ['owner_user_id', 'scope', 'provider', 'model_name', 'temperature', 'max_tokens', 'thinking_enabled', 'reasoning_effort', 'status'],
  platform_model_usage_policy: ['id', 'daily_requests_per_user', 'daily_tokens_per_user'],
  ai_model_usage_logs: ['credential_source', 'request_phase', 'request_status', 'accounting_status'],
})
