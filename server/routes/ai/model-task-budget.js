const TASK_POLICIES = Object.freeze({
  auto_inference:{ floor:2_000, defaultCap:30_000, attemptMs:10 * 60_000, taskMs:10 * 60_000 },
  manual_analysis:{ floor:2_000, defaultCap:30_000, attemptMs:15 * 60_000, taskMs:30 * 60_000 },
  daily_review:{ floor:3_000, defaultCap:30_000, attemptMs:20 * 60_000, taskMs:60 * 60_000 },
  monthly_review_chunk:{ floor:3_000, defaultCap:30_000, attemptMs:20 * 60_000, taskMs:6 * 60 * 60_000 },
  monthly_review_merge:{ floor:4_000, defaultCap:30_000, attemptMs:20 * 60_000, taskMs:6 * 60 * 60_000 },
  model_compare:{ floor:2_000, defaultCap:30_000, attemptMs:15 * 60_000, taskMs:24 * 60 * 60_000 },
  memory_compression:{ floor:1_600, defaultCap:12_000, attemptMs:15 * 60_000, taskMs:60 * 60_000 },
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
 * separate token-limits confirmation state is `confirmed`; until then the
 * runtime remains on the migration-only profile max_tokens fallback.
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
  const legacyProfileCap = positiveInteger(requestInput.profileHardCap ?? profile.max_tokens)
  return {
    tokenLimitsStatus,
    tokenLimitsSource,
    tokenLimitsUpdatedAtUtcMs,
    contextWindowTokens,
    maxInputTokens,
    maxOutputTokens,
    contextLimitSemantics,
    confirmed:tokenLimitsStatus === 'confirmed',
    legacyProfileCap,
  }
}

export function selectModelTaskBudget({ taskKind, profileHardCap, providerOutputCap = null,
  contextWindowTokens = null, maxInputTokens = null, contextLimitSemantics = null,
  tokenLimitsStatus = 'default_unconfirmed', tokenLimitsSource = 'legacy_unverified',
  maxOutputTokens = null, profile = null, capabilities = null, estimatedInputTokens = 0, schemaNeedTokens = 0,
  historicalOutputP95 = 0, truncatedOutputHighWatermark = 0, safetyReserveRatio = 0.15,
  legacyExactProfileCap = false } = {}) {
  const policy = modelTaskPolicy(taskKind)
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
  }, { profileHardCap, providerOutputCap, contextWindowTokens, maxInputTokens, contextLimitSemantics })
  const hasExplicitTokenStatus = Boolean(capabilities
    && Object.prototype.hasOwnProperty.call(capabilities, 'token_limits_status'))
  const estimated = Math.max(0, Math.trunc(Number(estimatedInputTokens) || 0))
  const schemaNeed = Math.max(0, Math.ceil(Number(schemaNeedTokens) || 0))
  const historyNeed = Math.max(0, Math.ceil((Number(historicalOutputP95) || 0) * 1.35))
  const truncationNeed = Math.max(0, Math.ceil((Number(truncatedOutputHighWatermark) || 0) * 2))
  const taskNeed = Math.max(policy.floor, schemaNeed, historyNeed, truncationNeed)

  if (resolvedLimits.confirmed) {
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
      selectedMaxOutputTokens:selected,
      schemaNeedTokens:schemaNeed,
      estimatedInputTokens:estimated,
      contextRoomTokens:Number.isFinite(contextRoom) ? Math.max(0, contextRoom) : null,
      contextWindowTokens:resolvedLimits.contextWindowTokens,
      profileHardCap:resolvedLimits.legacyProfileCap,
      providerOutputCap:resolvedLimits.maxOutputTokens,
      providerMaxInputTokens:resolvedLimits.maxInputTokens,
      maxInputTokens:resolvedLimits.maxInputTokens,
      contextLimitSemantics:resolvedLimits.contextLimitSemantics,
      tokenLimitsStatus:resolvedLimits.tokenLimitsStatus,
      tokenLimitsSource:resolvedLimits.tokenLimitsSource,
      tokenLimitsUpdatedAtUtcMs:resolvedLimits.tokenLimitsUpdatedAtUtcMs,
      legacyFallback:false,
      inputLimitExceeded,
      taskCap:null,
      sufficient:!inputLimitExceeded && selected > 0,
      reason,
      historicalOutputP95:Math.max(0, Math.ceil(Number(historicalOutputP95) || 0)),
      truncatedOutputHighWatermark:Math.max(0, Math.ceil(Number(truncatedOutputHighWatermark) || 0)),
    }
  }

  // Migration fallback: retain the existing profile/task behavior until a
  // model's manually entered physical limits have completed confirmation.
  const profileCap = Math.max(1, Math.trunc(Number(resolvedLimits.legacyProfileCap) || policy.defaultCap))
  // Once the new capability row explicitly says it is unconfirmed/stale, its
  // physical values are audit-only.  The migration fallback must continue to
  // use the profile's legacy max_tokens behavior.  Callers which predate the
  // token status field still retain the old provider/context constraints.
  const providerCap = !hasExplicitTokenStatus && Number(providerOutputCap) > 0
    ? Math.trunc(Number(providerOutputCap)) : Number.POSITIVE_INFINITY
  const contextWindow = !hasExplicitTokenStatus && Number(contextWindowTokens) > 0
    ? Math.trunc(Number(contextWindowTokens)) : null
  const safetyReserve = contextWindow ? Math.ceil(contextWindow * Math.max(0.1, Number(safetyReserveRatio) || 0.15)) : 0
  const contextRoom = contextWindow
    ? Math.max(0, contextWindow - estimated - safetyReserve)
    : Number.POSITIVE_INFINITY
  // The database profile remains the legacy operator-controlled output cap.
  const hardLimit = Math.min(profileCap, providerCap, contextRoom)
  const selected = Math.max(0, Math.min(hardLimit, legacyExactProfileCap ? profileCap : taskNeed))
  return {
    selectedMaxOutputTokens:selected,
    schemaNeedTokens:schemaNeed,
    estimatedInputTokens:estimated,
    contextRoomTokens:Number.isFinite(contextRoom) ? contextRoom : null,
    contextWindowTokens:contextWindow,
    profileHardCap:profileCap,
    providerOutputCap:Number.isFinite(providerCap) ? providerCap : null,
    providerMaxInputTokens:resolvedLimits.maxInputTokens,
    maxInputTokens:resolvedLimits.maxInputTokens,
    contextLimitSemantics:resolvedLimits.contextLimitSemantics,
    tokenLimitsStatus:resolvedLimits.tokenLimitsStatus,
    tokenLimitsSource:resolvedLimits.tokenLimitsSource,
    tokenLimitsUpdatedAtUtcMs:resolvedLimits.tokenLimitsUpdatedAtUtcMs,
    legacyFallback:true,
    inputLimitExceeded:false,
    taskCap:null,
    sufficient:legacyExactProfileCap ? selected > 0 : selected >= schemaNeed,
    reason:selected < schemaNeed ? 'output_budget_insufficient'
      : truncationNeed >= Math.max(policy.floor, schemaNeed, historyNeed) ? 'output_truncation_growth'
      : historyNeed >= Math.max(policy.floor, schemaNeed) ? 'historical_p95'
        : schemaNeed >= policy.floor ? 'output_contract' : 'task_floor',
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
