const TASK_POLICIES = Object.freeze({
  auto_inference:{ floor:2_000, cap:30_000, attemptMs:10 * 60_000, taskMs:10 * 60_000 },
  manual_analysis:{ floor:2_000, cap:30_000, attemptMs:15 * 60_000, taskMs:30 * 60_000 },
  daily_review:{ floor:3_000, cap:30_000, attemptMs:20 * 60_000, taskMs:60 * 60_000 },
  monthly_review_chunk:{ floor:3_000, cap:30_000, attemptMs:20 * 60_000, taskMs:6 * 60 * 60_000 },
  monthly_review_merge:{ floor:4_000, cap:30_000, attemptMs:20 * 60_000, taskMs:6 * 60 * 60_000 },
  model_compare:{ floor:2_000, cap:30_000, attemptMs:15 * 60_000, taskMs:24 * 60 * 60_000 },
  memory_compression:{ floor:1_600, cap:12_000, attemptMs:15 * 60_000, taskMs:60 * 60_000 },
})

export function modelTaskPolicy(taskKind) {
  return TASK_POLICIES[taskKind] || TASK_POLICIES.manual_analysis
}

export function estimateModelInputTokens(messages, calibratedCharsPerToken = 3.2) {
  const chars = typeof messages === 'string' ? messages.length : JSON.stringify(messages || []).length
  const divisor = Math.max(1.5, Math.min(6, Number(calibratedCharsPerToken) || 3.2))
  return Math.max(1, Math.ceil(chars / divisor))
}

export function selectModelTaskBudget({ taskKind, profileHardCap, providerOutputCap = null,
  contextWindowTokens = null, estimatedInputTokens = 0, schemaNeedTokens = 0,
  historicalOutputP95 = 0, truncatedOutputHighWatermark = 0, safetyReserveRatio = 0.15 } = {}) {
  const policy = modelTaskPolicy(taskKind)
  const profileCap = Math.max(1, Math.trunc(Number(profileHardCap) || policy.cap))
  const providerCap = Number(providerOutputCap) > 0 ? Math.trunc(Number(providerOutputCap)) : Number.POSITIVE_INFINITY
  const contextWindow = Number(contextWindowTokens) > 0 ? Math.trunc(Number(contextWindowTokens)) : null
  const safetyReserve = contextWindow ? Math.ceil(contextWindow * Math.max(0.1, Number(safetyReserveRatio) || 0.15)) : 0
  const contextRoom = contextWindow
    ? Math.max(0, contextWindow - Math.max(0, Math.trunc(Number(estimatedInputTokens) || 0)) - safetyReserve)
    : Number.POSITIVE_INFINITY
  const schemaNeed = Math.max(0, Math.ceil(Number(schemaNeedTokens) || 0))
  const historyNeed = Math.max(0, Math.ceil((Number(historicalOutputP95) || 0) * 1.35))
  const truncationNeed = Math.max(0, Math.ceil((Number(truncatedOutputHighWatermark) || 0) * 2))
  const taskNeed = Math.max(policy.floor, schemaNeed, historyNeed, truncationNeed)
  const hardLimit = Math.min(profileCap, providerCap, policy.cap, contextRoom)
  const selected = Math.max(0, Math.min(hardLimit, taskNeed))
  return {
    selectedMaxOutputTokens:selected,
    schemaNeedTokens:schemaNeed,
    estimatedInputTokens:Math.max(0, Math.trunc(Number(estimatedInputTokens) || 0)),
    contextRoomTokens:Number.isFinite(contextRoom) ? contextRoom : null,
    profileHardCap:profileCap,
    providerOutputCap:Number.isFinite(providerCap) ? providerCap : null,
    taskCap:policy.cap,
    sufficient:selected >= schemaNeed,
    reason:selected < schemaNeed ? 'output_budget_insufficient'
      : truncationNeed >= Math.max(policy.floor, schemaNeed, historyNeed) ? 'output_truncation_growth'
      : historyNeed >= Math.max(policy.floor, schemaNeed) ? 'historical_p95'
        : schemaNeed >= policy.floor ? 'output_contract' : 'task_floor',
  }
}

export function summarizeModelOutputHistory(rows = []) {
  const completed = rows
    .filter(row => Number(row?.output_tokens) > 0
      && row?.request_status === 'success'
      && row?.accounting_status === 'settled'
      && !['length', 'incomplete'].includes(String(row?.finish_reason || '').toLowerCase()))
    .map(row => Number(row.output_tokens))
    .sort((a, b) => a - b)
  const truncated = rows
    .filter(row => Number(row?.output_tokens) > 0
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
