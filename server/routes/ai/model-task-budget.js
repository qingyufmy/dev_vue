const TASK_POLICIES = Object.freeze({
  auto_inference:{ attemptMs:10 * 60_000, taskMs:10 * 60_000 },
  manual_analysis:{ attemptMs:15 * 60_000, taskMs:30 * 60_000 },
  daily_review:{ attemptMs:20 * 60_000, taskMs:60 * 60_000 },
  monthly_review_chunk:{ attemptMs:20 * 60_000, taskMs:6 * 60 * 60_000 },
  monthly_review_merge:{ attemptMs:20 * 60_000, taskMs:6 * 60 * 60_000 },
  model_compare:{ attemptMs:15 * 60_000, taskMs:24 * 60 * 60_000 },
  memory_compression:{ attemptMs:15 * 60_000, taskMs:60 * 60_000 },
  strategy_memory_consistency:{ attemptMs:15 * 60_000, taskMs:60 * 60_000 },
})

export function modelTaskPolicy(taskKind) {
  return TASK_POLICIES[taskKind] || TASK_POLICIES.manual_analysis
}

export function estimateModelInputTokens(messages, calibratedCharsPerToken = 3.2) {
  const chars = typeof messages === 'string' ? messages.length : JSON.stringify(messages || []).length
  const divisor = Math.max(1.5, Math.min(6, Number(calibratedCharsPerToken) || 3.2))
  return Math.max(1, Math.ceil(chars / divisor))
}

function positiveInteger(value) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

/**
 * Resolve the provider's manually maintained physical token contract.
 *
 * `verification_status` describes protocol capabilities and is deliberately
 * not consulted here.  Token limits become authoritative only after the
 * separate token-limits confirmation state is `confirmed`; until then formal
 * model work is rejected rather than silently falling back to an AURUM cap.
 */
export function resolveEffectiveModelTokenLimits(profile = {}, capabilities = {}, requestInput = {}) {
  const tokenLimitsStatus = String(capabilities.token_limits_status || 'default_unconfirmed').trim().toLowerCase()
  const tokenLimitsSource = String(capabilities.token_limits_source || capabilities.capability_source || 'legacy_unverified').trim()
  const tokenLimitsUpdatedAtUtcMs = positiveInteger(capabilities.token_limits_updated_at_utc_msc
    ?? capabilities.tokenLimitsUpdatedAtUtcMs)
  const contextWindowTokens = positiveInteger(capabilities.context_window_tokens ?? requestInput.contextWindowTokens)
  const maxInputTokens = positiveInteger(capabilities.max_input_tokens
    ?? capabilities.provider_max_input_tokens ?? requestInput.maxInputTokens)
  const maxOutputTokens = positiveInteger(capabilities.max_output_tokens
    ?? requestInput.providerOutputCap)
  const contextLimitSemantics = String(capabilities.context_limit_semantics
    || requestInput.contextLimitSemantics || 'shared_context').trim().toLowerCase() === 'separate'
    ? 'separate' : 'shared_context'
  // The profile is intentionally not read: ai_model_profiles.max_tokens is no
  // longer a runtime contract. Physical provider limits are the only formal
  // request boundary once the capability record is confirmed.
  void profile
  return {
    tokenLimitsStatus,
    tokenLimitsSource,
    tokenLimitsUpdatedAtUtcMs,
    contextWindowTokens,
    maxInputTokens,
    maxOutputTokens,
    contextLimitSemantics,
    confirmed:tokenLimitsStatus === 'confirmed',
  }
}

export function selectModelTaskBudget({ taskKind, providerOutputCap = null,
  contextWindowTokens = null, maxInputTokens = null, contextLimitSemantics = null,
  tokenLimitsStatus = 'default_unconfirmed', tokenLimitsSource = 'legacy_unverified',
  maxOutputTokens = null, profile = null, capabilities = null, estimatedInputTokens = 0, schemaNeedTokens = 0,
  historicalOutputP95 = 0, truncatedOutputHighWatermark = 0 } = {}) {
  void taskKind
  void schemaNeedTokens
  const fallbackCapabilities = {
    token_limits_status:tokenLimitsStatus,
    token_limits_source:tokenLimitsSource,
    context_window_tokens:contextWindowTokens,
    max_input_tokens:maxInputTokens,
    max_output_tokens:maxOutputTokens ?? providerOutputCap,
    context_limit_semantics:contextLimitSemantics,
  }
  const resolvedLimits = resolveEffectiveModelTokenLimits(profile || {}, {
    ...fallbackCapabilities, ...(capabilities || {}),
  }, { providerOutputCap, contextWindowTokens, maxInputTokens, contextLimitSemantics })
  const estimated = Math.max(0, Math.trunc(Number(estimatedInputTokens) || 0))
  const schemaNeed = Math.max(0, Math.ceil(Number(schemaNeedTokens) || 0))
  const historical = Math.max(0, Math.ceil(Number(historicalOutputP95) || 0))
  const truncated = Math.max(0, Math.ceil(Number(truncatedOutputHighWatermark) || 0))
  const base = {
    selectedMaxOutputTokens:0,
    schemaNeedTokens:schemaNeed,
    estimatedInputTokens:estimated,
    contextRoomTokens:null,
    contextWindowTokens:resolvedLimits.contextWindowTokens,
    providerOutputCap:resolvedLimits.maxOutputTokens,
    providerMaxInputTokens:resolvedLimits.maxInputTokens,
    maxInputTokens:resolvedLimits.maxInputTokens,
    contextLimitSemantics:resolvedLimits.contextLimitSemantics,
    tokenLimitsStatus:resolvedLimits.tokenLimitsStatus,
    tokenLimitsSource:resolvedLimits.tokenLimitsSource,
    tokenLimitsUpdatedAtUtcMs:resolvedLimits.tokenLimitsUpdatedAtUtcMs,
    inputLimitExceeded:false,
    sufficient:false,
    historicalOutputP95:historical,
    truncatedOutputHighWatermark:truncated,
  }
  if (!resolvedLimits.confirmed) {
    return { ...base,
      reason:resolvedLimits.tokenLimitsStatus === 'stale'
        ? 'model_token_limits_stale' : 'model_token_limits_unconfirmed' }
  }
  const inputLimitExceeded = !resolvedLimits.maxInputTokens || estimated > resolvedLimits.maxInputTokens
  const contextRoom = resolvedLimits.contextLimitSemantics === 'shared_context'
    ? (resolvedLimits.contextWindowTokens ? resolvedLimits.contextWindowTokens - estimated : 0)
    : Number.POSITIVE_INFINITY
  const outputBudget = Math.min(
    resolvedLimits.maxOutputTokens || 0,
    Number.isFinite(contextRoom) ? Math.max(0, contextRoom) : Number.POSITIVE_INFINITY,
  )
  const selected = inputLimitExceeded ? 0 : Math.max(0, Math.trunc(outputBudget))
  const reason = inputLimitExceeded ? 'model_input_limit_exceeded'
    : selected <= 0 ? 'output_budget_insufficient'
      : resolvedLimits.contextLimitSemantics === 'shared_context'
        && Number.isFinite(contextRoom) && contextRoom < (resolvedLimits.maxOutputTokens || 0)
        ? 'shared_context_room' : 'physical_output_cap'
  return {
    ...base,
    selectedMaxOutputTokens:selected,
    contextRoomTokens:Number.isFinite(contextRoom) ? contextRoom : null,
    inputLimitExceeded,
    sufficient:!inputLimitExceeded && selected > 0,
    reason,
  }
}

export function summarizeModelOutputHistory(rows = []) {
  const completed = rows
    .filter(row => Number(row?.output_tokens) > 0
      && (row?.request_phase == null || row.request_phase === 'request')
      && row?.request_status === 'success'
      && row?.accounting_status === 'settled'
      && !['length', 'incomplete'].includes(String(row?.finish_reason || '').toLowerCase()))
    .map(row => Number(row.output_tokens))
    .sort((a, b) => a - b)
  const truncated = rows
    .filter(row => Number(row?.output_tokens) > 0
      && (row?.request_phase == null || row.request_phase === 'request')
      && (row?.error_code === 'output_truncated'
        || ['length', 'incomplete'].includes(String(row?.finish_reason || '').toLowerCase())))
    .map(row => Number(row.output_tokens))
  const p95Index = completed.length ? Math.max(0, Math.ceil(completed.length * 0.95) - 1) : -1
  return {
    historicalOutputP95:p95Index >= 0 ? completed[p95Index] : 0,
    truncatedOutputHighWatermark:truncated.length ? Math.max(...truncated) : 0,
    completedSamples:completed.length,
    truncatedSamples:truncated.length,
  }
}

export function modelTaskDeadlines(taskKind, { nowUtcMs = Date.now(), manualAttemptMs = null,
  businessDeadlineUtcMs = null } = {}) {
  const policy = modelTaskPolicy(taskKind)
  const attemptMs = Number(manualAttemptMs) > 0
    ? Math.min(policy.attemptMs, Number(manualAttemptMs))
    : policy.attemptMs
  const taskDeadlineUtcMs = Math.min(
    nowUtcMs + policy.taskMs,
    Number(businessDeadlineUtcMs) > nowUtcMs ? Number(businessDeadlineUtcMs) : Number.POSITIVE_INFINITY,
  )
  return { attemptSafetyDeadlineUtcMs:nowUtcMs + attemptMs, taskDeadlineUtcMs }
}
