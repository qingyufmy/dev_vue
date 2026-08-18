// ai/scheduler.js — 统一自动推理调度与交付

import { queryOne, queryAll, queryRun, beijingNow, withTransaction } from '../../db.js'
import { getOwnBridgeMarketState, getPlatformMarketClockState, recordBridgeMarketState, isBridgeAlive, isTradeEnabled, sendToBrowsers, getAllBridges, broadcastAdminEvent } from '../../bridge-ws.js'
import { mt5Bridge, platformRates, calculateMarketData } from './market-data.js'
import { maybeAiSignal } from './llm.js'
import { insertAudit, signalOrderPayload, getExecuteRiskConfig, getAutoPromptTypeById, getAutoPromptTypes, getUnifiedAutoInferenceConfig, getAutoSubscribers, getDeliveryExecuteRiskConfig, getDeliverySubscriptionRuntime, parsePromptSymbols, resolveEffectiveSymbols, executeOrderCore, isAiPendingOrderRequest, assertAiPendingOrderEnabled, assertAiPendingCancelEnabled } from './config.js'
import { attachAtrAnchor, buildStrategyContextFromTags, loadPrivatePortfolioContext, resolveChanHistoryCount } from './strategy.js'
import { attachSignalTiming, signalTtlSeconds, stripBrokerSuffix } from './utils.js'
import { getRedis, isRedisAvailable } from '../../redis.js'
import { currentWeeklyFlattenEnd, isWeeklyFlattenWindow } from '../../jobs/weekly-risk-window.js'
import crypto from 'crypto'
import { buildSharedMarketSnapshot, persistInferenceSnapshotTx } from './inference-snapshots.js'
import { createStrategyMemoryInjectionLog, getStrategyMemoryLibraryForRuntime,
  updateStrategyMemoryInjectionLog } from './strategy-memory-library.js'
import { attachOutcomeDelivery, recordPendingOutcomeFill, startOutcomeMonitor } from './signal-outcomes.js'
import { isSubscriptionScheduleActive } from './subscription-schedule.js'
import { attachSignalPresentation, normalizeDecisionFields, SIGNAL_SCHEMA_VERSION } from './signal-presentation.js'
import { buildDecisionDiagnostics } from './decision-diagnostics.js'
import { getObserverSourceForStrategy } from './observer-channels.js'
import { loadPlatformDirectionInterlockTasks, loadPlatformReferencePortfolio } from './reference-portfolio.js'
import { createTradeThesisTx, hasActivePositionManagementGroups,
  loadActivePositionManagementContext, persistPositionManagementEvaluations } from './position-management.js'
import { prepareStrategyDataRuntime, buildStrategyRuntimeSnapshot } from './strategy-policy.js'
import { registerAutoSchedulerState } from './runtime-state-registry.js'
import {
  beginBridgeDeliveryExecution,
  isBridgeDeliveryMaintenancePaused,
  isPlatformMarketMaintenancePaused,
  isPrivateInferenceMaintenancePaused,
} from '../../bridge-v3/update-maintenance-registry.js'
import { trustedTerminalClock, validateExecutionClockContext } from './terminal-clock.js'
import * as modelTaskTrackerModule from './model-task-tracker.js'
import { modelTaskDeadlines } from './model-task-budget.js'
import { buildSafeExecutionOutcome, buildSafeExecutionEvent } from '../../audit-localization.js'
import { readAutoInferenceDeploymentDrain } from './auto-inference-deployment-drain.js'
import { executionValidationRejection, readExecutionValidation } from './signal-execution-validation.js'
import { accountSymbolInventoryLockKey, acquireAccountSymbolInventoryLock,
  releaseAccountSymbolInventoryLock } from '../../services/account-symbol-inventory-lock.js'
import { DuplicateLivePendingError, findDuplicateLivePending } from './live-pending-dedup.js'
import { applyStrategyDirectionInterlock, resolveStrategyDirectionInterlock } from './strategy-direction-interlock.js'

// === Unified Scheduler State ===
// Key: "promptTypeId:symbol"
export const autoSchedulerState = {}
registerAutoSchedulerState(autoSchedulerState)

// A scheduler key can be reached by more than one timer callback (for example
// when a callback is delayed while the event loop is busy).  Keep the
// in-process guard separate from the Redis lease: Redis remains the
// cross-instance execution fence, while this Promise only prevents duplicate
// work within this process.
const AUTO_SCHEDULER_STOP_TIMEOUT_MS = 10_000
let autoSchedulersStopping = false
let autoSchedulersStopPromise = null

function boundedWait(promise, timeoutMs, label = 'background task') {
  if (!promise || typeof promise.then !== 'function') return Promise.resolve({ settled:true })
  const timeout = Math.max(0, Number(timeoutMs) || 0)
  if (timeout === 0) return Promise.resolve({ settled:false, timedOut:true, label })
  return Promise.race([
    Promise.resolve(promise).then(() => ({ settled:true }), error => ({ settled:true, error })),
    new Promise(resolve => setTimeout(() => resolve({ settled:false, timedOut:true, label }), timeout)),
  ])
}

function recordSchedulerOverlap(key, state) {
  state.skippedOverlapCount = Number(state.skippedOverlapCount || 0) + 1
  state.lastSkippedOverlapAtUtc = new Date().toISOString()
  console.warn(`[UnifiedScheduler] ${key}: skipped-overlap (count=${state.skippedOverlapCount})`)
  // Do not wait for observability writes on the skipped callback.  The current
  // cycle owns the scheduler lease and the write is best effort, just like the
  // existing runtime-state publication path.
  void updateSchedulerRedisState(key, state)
}

const MARKET_WAIT_REASONS = new Set([
  'market_closed',
  'market_restricted',
  'market_stale_tick',
  'market_unknown_no_tick',
  'market_unknown',
])

const AUTO_MODEL_TASK_TERMINAL_STATES = new Set([
  'cancelled', 'failed_terminal', 'succeeded', 'completed_stale', 'completed_rejected',
])

function sha256(value) {
  return crypto.createHash('sha256').update(String(value == null ? '' : value)).digest('hex')
}

function autoModelTaskDomainId(promptTypeId, symbol) {
  return `${Number(promptTypeId)}:${normalizeSymbolForScheduler(symbol)}`
}

function parseFrozenModelTaskContext(task) {
  if (!task?.frozen_context_json) return {}
  if (typeof task.frozen_context_json === 'object') return task.frozen_context_json
  try { return JSON.parse(task.frozen_context_json) || {} } catch { return {} }
}

/**
 * Durable scheduler gate. Redis protects the live worker, while this check
 * protects against duplicate provider work after a process/Redis restart.
 * Non-terminal and status-unknown tasks are never retried by this scheduler.
 */
export async function checkAutoModelTaskGate(promptTypeId, symbol, intervalMinutes = 5, nowMs = Date.now()) {
  const domainId = autoModelTaskDomainId(promptTypeId, symbol)
  const task = await queryOne(`SELECT task_id, status, task_deadline_at_utc_msc, completed_at_utc_msc, result_valid_until_utc_msc,
      frozen_context_json, created_at_utc_msc, updated_at_utc_msc,
      EXISTS (SELECT 1 FROM ai_model_task_attempts a WHERE a.task_id = ai_model_tasks.task_id) AS provider_request_started
    FROM ai_model_tasks
    WHERE task_kind = 'auto_inference' AND domain_type = 'strategy_symbol' AND domain_id = ?
    ORDER BY CASE WHEN status IN ('cancelled','failed_terminal','succeeded','completed_stale','completed_rejected')
      THEN 1 ELSE 0 END, created_at_utc_msc DESC, updated_at_utc_msc DESC LIMIT 1`, [domainId])
  if (!task) return { allowed:true, domainId, task:null }

  const status = String(task.status || '').toLowerCase()
  if (!AUTO_MODEL_TASK_TERMINAL_STATES.has(status)) {
    const taskDeadlineAtUtcMs = Number(task.task_deadline_at_utc_msc)
    if (status === 'status_unknown' && Number.isFinite(taskDeadlineAtUtcMs) && taskDeadlineAtUtcMs > nowMs) {
      return {
        allowed:false,
        reason:'model_task_status_unknown',
        task,
        domainId,
        nextAllowedAt:taskDeadlineAtUtcMs,
        nextRunInSeconds:Math.max(1, Math.ceil((taskDeadlineAtUtcMs - nowMs) / 1000)),
      }
    }
    if (status === 'status_unknown') {
      return {
        allowed:false,
        reason:'model_task_status_unknown',
        task,
        domainId,
        nextRunInSeconds:Math.ceil(retryDelayMs('model_task_status_unknown') / 1000),
      }
    }
    return {
      allowed:false,
      reason:'model_task_active',
      task,
      domainId,
    }
  }

  const completedAt = Number(task.completed_at_utc_msc)
  if (!Number.isFinite(completedAt) || completedAt <= 0) {
    return { allowed:false, reason:'model_task_completion_unknown', task, domainId }
  }
  const frozen = parseFrozenModelTaskContext(task)
  const providerStarted = Number(task.provider_request_started) === 1
    || (task.provider_request_started == null && frozen.provider_request_started !== false)
  const configuredMinutes = Math.max(1, Number(frozen.interval_minutes) || Number(intervalMinutes) || 5)
  const cooldownMs = providerStarted ? configuredMinutes * 60_000 : 0
  const nextAllowedAt = completedAt + cooldownMs
  if (nextAllowedAt > nowMs) {
    return {
      allowed:false,
      reason:'model_task_cooldown',
      task,
      domainId,
      nextAllowedAt,
      nextRunInSeconds:Math.max(1, Math.ceil((nextAllowedAt - nowMs) / 1000)),
    }
  }
  return { allowed:true, domainId, task }
}

function buildAutoModelTaskInput({ promptTypeId, symbol, cycleId, cycleStartedAtMs, strategy,
  config, market, marketMeta, primaryTimeframe, intervalMinutes, resultValidUntilUtcMsc,
  taskDeadlineAtUtcMsc = null, renderedEvidence = null, strategyDataRuntime = null }) {
  const marketJson = JSON.stringify(market || {})
  const evidencePrompt = renderedEvidence
    ? `${renderedEvidence.systemPrompt || ''}\n${renderedEvidence.userPrompt || ''}`
    : `${config?.system_prompt || ''}\n${config?._strategyMemoryLibraryContext || ''}`
  const outputContractHash = sha256(`${SIGNAL_SCHEMA_VERSION}:${JSON.stringify(config?._allowed_entry_methods || [])}`)
  const snapshotHash = sha256(marketJson)
  const inputHash = sha256(JSON.stringify({
    symbol, timeframe:primaryTimeframe, market,
    strategy_id:Number(strategy?.id || promptTypeId), strategy_version:Number(strategy?.version || 1),
  }))
  const promptHash = sha256(evidencePrompt)
  const taskDeadlineAtUtcMs = Number(taskDeadlineAtUtcMsc)
    || modelTaskDeadlines('auto_inference', { nowUtcMs:cycleStartedAtMs }).taskDeadlineUtcMs
  const trustedClock = marketMeta && trustedTerminalClock(marketMeta) ? marketMeta : null
  const frozenContext = {
    cycle_id:cycleId,
    domain_id:autoModelTaskDomainId(promptTypeId, symbol),
    strategy_id:Number(strategy?.id || promptTypeId),
    strategy_version:Number(strategy?.version || 1),
    strategy_scope:String(strategy?.scope || 'platform'),
    symbol:normalizeSymbolForScheduler(symbol),
    timeframe:primaryTimeframe,
    interval_minutes:Math.max(1, Number(intervalMinutes) || 5),
    provider:String(config?.api_provider || ''),
    model:String(config?.model_name || ''),
    model_profile_id:Number(config?._model_profile_id || 0) || null,
    protocol:String(config?.protocol || config?._protocol || 'chat_completions'),
    credential_source:String(config?._credential_source || ''),
    snapshot_hash:snapshotHash,
    input_hash:inputHash,
    prompt_hash:promptHash,
    output_contract_hash:outputContractHash,
    result_valid_until_utc_msc:Number(resultValidUntilUtcMsc) || null,
    task_deadline_at_utc_msc:taskDeadlineAtUtcMs,
    provider_request_started:false,
    terminal_timezone_offset_minutes:trustedClock?.timezone_offset_minutes ?? null,
    terminal_clock_status:trustedClock?.clock_status || null,
    terminal_clock_source:trustedClock?.clock_source || trustedClock?.source || null,
    market_source:marketMeta?.source || null,
    strategy_data_runtime_version:strategyDataRuntime?.data_runtime_version || null,
    strategy_policy_hash:strategyDataRuntime?.policy_hash || null,
    indicator_evidence_hashes:strategyDataRuntime?.audit_identity?.indicator_evidence_hashes || {},
  }
  return {
    taskKind:'auto_inference',
    queueClass:'execution_critical',
    ownerUserId:strategy?.scope === 'private' ? Number(config?._userId || 0) : 0,
    strategyId:Number(strategy?.id || promptTypeId),
    domainType:'strategy_symbol',
    domainId:autoModelTaskDomainId(promptTypeId, symbol),
    idempotencyKey:cycleId,
    snapshotHash,
    inputHash,
    promptHash,
    outputContractHash,
    provider:config?.api_provider || null,
    model:config?.model_name || null,
    modelProfileId:Number(config?._model_profile_id || 0) || null,
    protocol:String(config?.protocol || config?._protocol || 'chat_completions'),
    credentialSource:config?._credential_source || null,
    frozenContext,
    scheduledAtUtcMs:cycleStartedAtMs,
    taskDeadlineAtUtcMs,
    // The model-task runtime consumes the camelCase `...UtcMs` contract and
    // maps it to the durable `result_valid_until_utc_msc` column. Keep the
    // database naming in frozen_context, but do not pass the legacy `Msc`
    // property to createModelTaskTracker (and ultimately createModelTask).
    resultValidUntilUtcMs:Number(resultValidUntilUtcMsc) || null,
    maxAttempts:1,
  }
}

export async function enforcePlatformStrategyDirectionInterlock({ signal, market, strategyId,
  inferenceUserId, symbol, referenceSource, getCurrentSource = getObserverSourceForStrategy,
  loadReferencePortfolio = loadPlatformReferencePortfolio,
  loadBlockingTasks = loadPlatformDirectionInterlockTasks } = {}) {
  const modelTradeDirection = String(signal?.signal_type || '').trim().toLowerCase()
  if (!/^(buy|sell)(?:_|$)/.test(modelTradeDirection) || !referenceSource) {
    return { signal, resolution:null }
  }
  if (Number(referenceSource.bridge_user_id) !== Number(inferenceUserId)) {
    const resolution = {
      ...resolveStrategyDirectionInterlock({ signal,
        frozenPortfolio:market?.strategy_reference_portfolio, freshPortfolio:null,
        blockingTasks:[], refreshAvailable:false }),
      refresh_error:'reference_source_bridge_mismatch',
    }
    return { signal:applyStrategyDirectionInterlock(signal, resolution, market), resolution }
  }
  let resolution
  try {
    const currentSource = await getCurrentSource(strategyId)
    const sourceStable = currentSource
      && Number(currentSource.source_id) === Number(referenceSource.source_id)
      && Number(currentSource.bridge_user_id) === Number(referenceSource.bridge_user_id)
      && Number(currentSource.trading_account_id || 0) === Number(referenceSource.trading_account_id || 0)
    if (!sourceStable) throw new Error('reference_source_changed_during_inference')
    const [freshPortfolio, blockingTasks] = await Promise.all([
      loadReferencePortfolio({ strategyId, sourceUserId:inferenceUserId, symbol }),
      loadBlockingTasks({ strategyId, sourceUserId:inferenceUserId, symbol }),
    ])
    resolution = resolveStrategyDirectionInterlock({
      signal,
      frozenPortfolio:market?.strategy_reference_portfolio,
      freshPortfolio,
      blockingTasks,
      refreshAvailable:true,
    })
  } catch (error) {
    resolution = {
      ...resolveStrategyDirectionInterlock({
        signal,
        frozenPortfolio:market?.strategy_reference_portfolio,
        freshPortfolio:null,
        blockingTasks:[],
        refreshAvailable:false,
      }),
      refresh_error:String(error?.message || 'reference_refresh_failed').slice(0, 160),
    }
  }
  return {
    signal:resolution.allowed === false
      ? applyStrategyDirectionInterlock(signal, resolution, market) : signal,
    resolution,
  }
}

function getAutoModelTaskTrackerFactory() {
  const factory = modelTaskTrackerModule.createModelTaskTracker
  if (typeof factory !== 'function') {
    const error = new Error('model_task_tracker_unavailable')
    error.code = 'model_task_tracker_unavailable'
    throw error
  }
  return factory
}

async function assertModelTaskOwned(tracker, phase) {
  if (!tracker || tracker.active === false) return false
  if (typeof tracker.assertOwned !== 'function') return false
  try {
    const owned = await tracker.assertOwned(phase)
    return owned !== false
  } catch (error) {
    console.error(`[ModelTask] assertOwned failed at ${phase}:`, error.message)
    return false
  }
}

async function assertAutoInferenceApplyGate({ tracker, lockGuard, promptTypeId, strategy,
  cycleId, key, taskDeadlineAtUtcMsc, marketMeta, phase, config = null, frozenModel = null }) {
  if (lockGuard && !(await lockGuard.assertOwned(phase))) {
    return { allowed:false, type:'rejected', reason:'lock_lost' }
  }
  if (!(await assertModelTaskOwned(tracker, phase))) {
    return { allowed:false, type:'rejected', reason:'model_task_fence_lost' }
  }
  const currentState = autoSchedulerState[key]
  if (!currentState?.running || currentState.cycleId !== cycleId) {
    return { allowed:false, type:'stale', reason:'auto_cycle_changed' }
  }
  const taskDeadline = Number(taskDeadlineAtUtcMsc)
  if (!Number.isFinite(taskDeadline) || Date.now() > taskDeadline) {
    return { allowed:false, type:'stale', reason:'model_task_deadline_exceeded' }
  }
  if (!trustedTerminalClock(marketMeta || {})) {
    return { allowed:false, type:'stale', reason:'terminal_clock_untrusted' }
  }
  const currentStrategy = await getAutoPromptTypeById(promptTypeId)
  if (!currentStrategy || !currentStrategy.is_active
    || Number(currentStrategy.id) !== Number(strategy?.id || promptTypeId)
    || Number(currentStrategy.version || 1) !== Number(strategy?.version || 1)
    || String(currentStrategy.scope || 'platform') !== String(strategy?.scope || 'platform')) {
    return { allowed:false, type:'stale', reason:'strategy_version_changed' }
  }
  if (config && frozenModel && (
    String(config.api_provider || '') !== String(frozenModel.provider || '')
    || String(config.model_name || '') !== String(frozenModel.model || '')
    || Number(config._model_profile_id || 0) !== Number(frozenModel.modelProfileId || 0)
    || String(config.protocol || config._protocol || 'chat_completions') !== String(frozenModel.protocol || 'chat_completions')
    || String(config._credential_source || '') !== String(frozenModel.credentialSource || '')
  )) {
    return { allowed:false, type:'stale', reason:'model_configuration_changed' }
  }
  return { allowed:true }
}

async function assertAutoInferenceBusinessGate({ tracker, lockGuard, resultValidUntilUtcMsc, phase,
  requireFreshResult = true }) {
  if (lockGuard && !(await lockGuard.assertOwned(phase))) return false
  if (!(await assertModelTaskOwned(tracker, phase))) return false
  if (!requireFreshResult) return true
  const validUntil = Number(resultValidUntilUtcMsc)
  return Number.isFinite(validUntil) && Date.now() <= validUntil
}

async function assertAutoInferenceOrderSendTx({ tracker, run, resultValidUntilUtcMsc }) {
  if (!tracker || typeof tracker.assertOwnedTx !== 'function') {
    const error = new Error('model_task_transaction_fence_missing')
    error.code = 'model_task_transaction_fence_missing'
    throw error
  }
  const current = await tracker.assertOwnedTx(run)
  const durableValidUntil = Number(current?.result_valid_until_utc_msc)
  const cycleValidUntil = Number(resultValidUntilUtcMsc)
  if (!Number.isFinite(durableValidUntil) || durableValidUntil <= 0
    || !Number.isFinite(cycleValidUntil) || cycleValidUntil <= 0
    || Date.now() > Math.min(durableValidUntil, cycleValidUntil)) {
    const error = new Error('model_task_result_expired')
    error.code = 'model_task_result_expired'
    throw error
  }
  return current
}

function recoveryFenceError(reason) {
  const error = new Error(reason)
  error.code = reason
  error.reason = reason
  return error
}

function recoveryFenceRow(result) {
  const rows = Array.isArray(result?.[0]) ? result[0]
    : Array.isArray(result) ? result : []
  return rows[0] || null
}

function validateSignalDeliveryRecoveryRow(row, expectedTaskId) {
  if (!row || String(row.execution_status || '').toLowerCase() !== 'executing'
    || row.order_intent_id != null
    || String(row.inference_task_id || '') !== expectedTaskId
    || String(row.task_id || '') !== expectedTaskId
    || String(row.model_task_status || '').toLowerCase() !== 'succeeded') {
    throw recoveryFenceError('delivery_recovery_untrusted')
  }
  const createdAtUtcMsc = Number(row.created_at_utc_msc)
  const ttlSeconds = Number(row.ttl_seconds)
  const resultValidUntilUtcMsc = Number(row.result_valid_until_utc_msc)
  if (!Number.isFinite(createdAtUtcMsc) || createdAtUtcMsc <= 0
    || !Number.isFinite(ttlSeconds) || ttlSeconds <= 0
    || !Number.isFinite(resultValidUntilUtcMsc) || resultValidUntilUtcMsc <= 0) {
    throw recoveryFenceError('delivery_recovery_untrusted')
  }
  const deadline = Math.min(resultValidUntilUtcMsc, createdAtUtcMsc + ttlSeconds * 1000)
  if (!Number.isFinite(deadline) || Date.now() > deadline) {
    throw recoveryFenceError('delivery_recovery_expired')
  }
  return row
}

async function assertSignalDeliveryRecoveryLive({ recoveryContext, userId, signalId }) {
  const expectedTaskId = String(recoveryContext?.taskId || '').trim()
  if (!expectedTaskId) throw recoveryFenceError('delivery_recovery_untrusted')
  const row = await queryOne(`
    SELECT d.execution_status, d.order_intent_id,
      s.inference_task_id, s.created_at_utc_msc, s.ttl_seconds,
      t.task_id, t.status AS model_task_status, t.result_valid_until_utc_msc
    FROM auto_signal_deliveries d
    JOIN ai_signals s ON s.id = d.signal_id
    JOIN ai_model_tasks t ON t.task_id = s.inference_task_id
    WHERE d.signal_id = ? AND d.user_id = ? LIMIT 1
  `, [signalId, userId])
  return validateSignalDeliveryRecoveryRow(row, expectedTaskId)
}

async function releaseUnsentDeliveryClaim(signalId, userId) {
  return queryRun(
    `UPDATE auto_signal_deliveries
     SET execution_status = 'not_attempted', execution_claimed_at = NULL, execution_result = NULL
     WHERE signal_id = ? AND user_id = ? AND execution_status = 'executing'
       AND order_intent_id IS NULL`,
    [signalId, userId])
}

/**
 * Durable fence for a recovered delivery. The model task is already terminal,
 * so it cannot be represented by the live model-task tracker. Re-check the
 * delivery, signal and task together inside the order-intent transaction just
 * before markBridgeSending changes the intent to bridge_sending.
 */
async function assertSignalDeliveryRecoveryTx({ run, recoveryContext, userId, signalId }) {
  const expectedTaskId = String(recoveryContext?.taskId || '').trim()
  if (!expectedTaskId) throw recoveryFenceError('delivery_recovery_untrusted')
  const result = await run(`
    SELECT d.execution_status, d.order_intent_id,
      s.inference_task_id, s.created_at_utc_msc, s.ttl_seconds,
      t.task_id, t.status AS model_task_status, t.result_valid_until_utc_msc
    FROM auto_signal_deliveries d
    JOIN ai_signals s ON s.id = d.signal_id
    JOIN ai_model_tasks t ON t.task_id = s.inference_task_id
    WHERE d.signal_id = ? AND d.user_id = ?
    FOR UPDATE
  `, [signalId, userId])
  const row = recoveryFenceRow(result)
  return validateSignalDeliveryRecoveryRow(row, expectedTaskId)
}

function bridgeWeeklyWindow(userId, tradingAccountId = null, now = new Date()) {
  const clock = getPlatformMarketClockState(userId, tradingAccountId)
  return isWeeklyFlattenWindow(now, clock.timezone_offset_minutes)
}

// Automatic subscriber orders must use the clock captured by their own risk
// snapshot. This helper is deliberately independent from bridgeWeeklyWindow,
// whose legacy lookup may resolve an observer/shared clock.
export function autoDeliveryWeeklyWindow(executionClockContext, now = new Date()) {
  if (!executionClockContext) return { blocked:true, reason:'execution_clock_context_missing' }
  const evaluationNow = now instanceof Date ? now.getTime() : Number(now)
  const clockCheck = validateExecutionClockContext(executionClockContext, {
    userId:executionClockContext.user_id,
    tradingAccountId:executionClockContext.trading_account_id,
    brokerServer:executionClockContext.broker_server,
    login:executionClockContext.login,
    requireTerminal:false,
  }, evaluationNow)
  if (!clockCheck.valid) return { blocked:true, reason:clockCheck.reason }
  const blocked = isWeeklyFlattenWindow(now, clockCheck.context.timezone_offset_minutes)
  return { blocked, reason:blocked ? 'weekly_flatten_window' : null, context:clockCheck.context }
}

function isMarketWaitReason(reason) {
  return MARKET_WAIT_REASONS.has(String(reason || ''))
}

function summarizeRuntimeMarketStates(states = []) {
  const normalized = states.filter(state => state && typeof state === 'object')
  if (normalized.length === 0) {
    return { alive:true, isOpen:false, tradeMode:-1, reason:'market_unknown', symbols:[] }
  }

  const openState = normalized.find(state => state.isOpen)
  const priority = ['market_closed', 'market_restricted', 'market_stale_tick', 'market_unknown_no_tick', 'market_unknown']
  const selected = openState || priority
    .map(reason => normalized.find(state => state.reason === reason))
    .find(Boolean) || normalized[0]

  return {
    ...selected,
    isOpen:Boolean(openState),
    reason:openState ? 'market_open' : (selected.reason || 'market_unknown'),
    symbols:normalized.map(state => ({
      symbol:state.symbol || '',
      isOpen:Boolean(state.isOpen),
      reason:state.reason || 'market_unknown',
      tradeMode:Number.isFinite(Number(state.tradeMode)) ? Number(state.tradeMode) : -1,
    })),
  }
}

// === Permission gate: can user execute auto trades (cancel/submit) ===
async function isUserEligibleForAutoExecution(userId) {
  if (!isBridgeAlive(userId)) return false
  if (!isTradeEnabled(userId)) return false
  const scheduler = await queryOne('SELECT enabled, enable_auto_trade FROM auto_scheduler WHERE user_id = ?', [userId])
  if (!scheduler || !scheduler.enabled || !scheduler.enable_auto_trade) return false
  const user = await queryOne(`SELECT role,
    (role = 'admin' OR (plan = 'pro' AND (plan_expires_at IS NULL OR plan_expires_at >= NOW()))) AS has_pro_access
    FROM users WHERE id = ?`, [userId])
  if (!user?.has_pro_access) return false
  const ubSettings = await queryOne('SELECT trade_send_enabled FROM user_bridge_settings WHERE user_id = ?', [userId])
  if (!ubSettings || !ubSettings.trade_send_enabled) return false
  return true
}

function calculateRecoverySeconds(deadlineMs, nowMs = Date.now()) {
  if (!Number.isFinite(deadlineMs)) return 0
  return Math.max(0, Math.ceil((deadlineMs - nowMs) / 1000))
}

function selectOwnedStrategyPendingOrders(pendingOrders, strategyDeliveries, symbol, direction,
  managementGroupIds = null, originSignalIdsByGroup = null) {
  const expectedSymbol = stripBrokerSuffix(symbol)
  const expectedDirection = String(direction || '').toLowerCase()
  const filterDirection = direction !== undefined && direction !== null
  if (filterDirection && !['buy', 'sell'].includes(expectedDirection)) return []
  const selectedGroups = managementGroupIds instanceof Set
    ? managementGroupIds : managementGroupIds ? new Set(managementGroupIds) : null
  const originByGroup = originSignalIdsByGroup instanceof Map ? originSignalIdsByGroup : null
  const strategyTickets = new Set((Array.isArray(strategyDeliveries) ? strategyDeliveries : [])
    .filter(item => {
      const groupId = String(item?.management_group_id || '').trim()
      if (selectedGroups && !selectedGroups.has(groupId)) return false
      if (!originByGroup) return true
      const expectedOrigin = Number(originByGroup.get(groupId) || 0)
      return expectedOrigin > 0 && Number(item?.signal_id || 0) === expectedOrigin
    })
    .map(item => String(item?.pending_ticket || '').trim())
    .filter(Boolean))
  return (Array.isArray(pendingOrders) ? pendingOrders : []).filter(item => {
    const ticket = String(item?.ticket ?? item?.mt5_ticket ?? '').trim()
    if (!ticket || !strategyTickets.has(ticket)) return false
    if (Number(item?.magic || 0) !== 234000) return false
    if (stripBrokerSuffix(String(item?.symbol || '')) !== expectedSymbol) return false
    if (!filterDirection) return true
    const pendingSide = String(item?.side || item?.pending_type || item?.order_type || '').toLowerCase()
    return pendingSide.startsWith(expectedDirection)
  })
}

function positionManagementDecision(signal) {
  const value = signal?._position_management || signal?.position_management
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

function synchronousPendingCancelGroupIds(signal) {
  const signalType = String(signal?.signal_type || '').trim().toLowerCase()
  if (signalType === 'hold' || !/^(buy|sell)(?:_|$)/.test(signalType)) return new Set()
  const management = positionManagementDecision(signal)
  return new Set((Array.isArray(management?.pending_evaluations) ? management.pending_evaluations : [])
    .filter(item => String(item?.action || '').toLowerCase() === 'cancel')
    .map(item => String(item?.management_group_id || '').trim())
    .filter(Boolean))
}

function synchronousPendingCancelOriginSignalIds(signal, context) {
  const groups = synchronousPendingCancelGroupIds(signal)
  if (!(groups instanceof Set) || !groups.size) return new Map()
  const byGroup = new Map((context?.pending_groups || []).map(group => [
    String(group?.management_group_id || ''), Number(group?.original_signal_id || 0),
  ]))
  const frozenEvaluations = (positionManagementDecision(signal)?.pending_evaluations || [])
    .filter(item => item && typeof item === 'object')
  const signalByGroup = new Map(frozenEvaluations.map(item => [
    String(item?.management_group_id || ''), Number(item?.origin_signal_id || 0),
  ]))
  const result = new Map()
  for (const groupId of groups) {
    // Recovery can re-enter executeDelivery without the non-persisted model
    // context. The normalized model response carries the same frozen origin;
    // use it only as a fallback, never a user/ticket-derived guess.
    const originSignalId = Number(byGroup.get(groupId) || signalByGroup.get(groupId) || 0)
    if (originSignalId > 0) result.set(groupId, originSignalId)
  }
  return result
}

function selectFrozenSynchronousPendingDeliveries(strategyDeliveries, originSignalIdsByGroup) {
  if (!(originSignalIdsByGroup instanceof Map) || !originSignalIdsByGroup.size) return []
  const byDelivery = new Map()
  for (const item of Array.isArray(strategyDeliveries) ? strategyDeliveries : []) {
    const deliveryId = Number(item?.delivery_id || 0)
    if (!Number.isSafeInteger(deliveryId) || deliveryId <= 0) continue
    if (!byDelivery.has(deliveryId)) byDelivery.set(deliveryId, [])
    byDelivery.get(deliveryId).push(item)
  }
  const selected = []
  for (const rows of byDelivery.values()) {
    // A delivery with more than one joined outcome is ambiguous.  Do not
    // choose the first historical row or ticket by query order.
    if (rows.length !== 1) continue
    const item = rows[0]
    const deliveryId = Number(item?.delivery_id || 0)
    const orderIntentId = Number(item?.order_intent_id || 0)
    const outcomeId = Number(item?.outcome_id || 0)
    const groupId = String(item?.origin_management_group_id || item?.management_group_id || '').trim()
    const expectedOrigin = Number(originSignalIdsByGroup.get(groupId) || 0)
    if (!Number.isSafeInteger(deliveryId) || deliveryId <= 0
      || !Number.isSafeInteger(orderIntentId) || orderIntentId <= 0
      || !Number.isSafeInteger(outcomeId) || outcomeId <= 0
      || expectedOrigin <= 0
      || Number(item?.signal_id || 0) !== expectedOrigin
      || Number(item?.delivery_signal_id || item?.signal_id || 0) !== expectedOrigin
      || String(item?.origin_management_group_id || '') !== groupId
      || String(item?.outcome_management_group_id || '') !== groupId
      || String(item?.outcome_thesis_id || '') !== String(item?.origin_thesis_id || '')
      || !['succeeded', 'success'].includes(String(item?.order_intent_status || '').toLowerCase())
      || Number(item?.intent_user_id) !== Number(item?.delivery_user_id)
      || Number(item?.outcome_user_id) !== Number(item?.delivery_user_id)
      || Number(item?.outcome_trading_account_id) !== Number(item?.intent_trading_account_id)
      || Number(item?.outcome_order_intent_id) !== orderIntentId
      || Number(item?.outcome_delivery_id) !== deliveryId
      || String(item?.pending_state || '').toLowerCase() !== 'pending'
      || !String(item?.pending_ticket || '').trim()
      || String(item?.outcome_pending_ticket || '').trim() !== String(item.pending_ticket).trim()
      || !['open', 'closing'].includes(String(item?.outcome_status || '').toLowerCase())) continue
    selected.push(item)
  }
  return selected
}

/**
 * Resolve the model's pending-order action without imposing a quantity rule.
 *
 * `none` deliberately proceeds even when the current strategy already owns
 * pending orders: the model saw those orders in its portfolio input and is
 * the authority on whether a new signal should add another one. `keep` is the
 * explicit no-new-order decision, while cancellation actions require matched
 * targets selected by the caller (including the model's direction for
 * cancel).
 */
function resolvePendingActionGate({ pendingAction, pendingOrders = [] } = {}) {
  const action = String(pendingAction || 'none').trim().toLowerCase()
  const targets = Array.isArray(pendingOrders) ? pendingOrders : []
  if (action === 'keep') {
    return {
      action: 'skip',
      reason: targets.length ? 'existing_pending_kept' : 'reference_pending_not_matched',
      count: targets.length,
      targets,
    }
  }
  if (action === 'cancel') {
    if (!targets.length) {
      return { action: 'skip', reason: 'reference_pending_not_matched', count: 0, targets: [] }
    }
    return { action: 'manage', reason: null, count: targets.length, targets }
  }
  return { action: 'proceed', reason: null, count: targets.length, targets: [] }
}

function resolvePendingCancellationPlan({
  signalType, pendingAction, pendingTargets = [], synchronousPendingCancelGroupIds = null,
} = {}) {
  const normalizedSignalType = String(signalType || '').trim().toLowerCase()
  const isTradeSignal = /^(buy|sell)(?:_|$)/.test(normalizedSignalType)
  const groupIds = synchronousPendingCancelGroupIds instanceof Set
    ? synchronousPendingCancelGroupIds
    : new Set(Array.isArray(synchronousPendingCancelGroupIds) ? synchronousPendingCancelGroupIds : [])
  const targets = Array.isArray(pendingTargets) ? pendingTargets : []
  const action = String(pendingAction || 'none').trim().toLowerCase()
  if (isTradeSignal && groupIds.size > 0) {
    return {
      mode:'pre_order_cancel', continue_to_new_order:true, requires_targets:true,
      reason:null, count:targets.length, targets,
    }
  }
  if (action === 'cancel') {
    if (!targets.length) return {
      mode:'skip', continue_to_new_order:isTradeSignal, requires_targets:false,
      reason:'reference_pending_not_matched', count:0, targets:[],
    }
    return {
      mode:'pre_order_cancel', continue_to_new_order:isTradeSignal, requires_targets:false,
      reason:null, count:targets.length, targets,
    }
  }
  return {
    mode:'none', continue_to_new_order:true, requires_targets:false,
    reason:null, count:0, targets:[],
  }
}

// These gates protect the whole new-order operation and must not be bypassed
// just because the independent pending-cancellation operation failed. A
// cancellation switch being disabled is deliberately not in this set: the
// model may still have a valid new-order signal when cancellation is off.
const PENDING_CANCELLATION_BLOCKING_REASONS = new Set([
  'auto_execution_permission_changed',
  'delivery_recovery_expired',
  'delivery_recovery_untrusted',
  'model_task_business_gate_failed',
  'lock_lost_before_pending_cancel',
  'weekly_flatten_window',
])

function resolvePendingCancellationOutcome({ cancellationPlan, reason } = {}) {
  const normalizedReason = String(reason || '').trim()
  const blockedBySafetyGate = PENDING_CANCELLATION_BLOCKING_REASONS.has(normalizedReason)
  const continueToNewOrder = Boolean(cancellationPlan?.continue_to_new_order)
  return {
    continue_to_new_order:continueToNewOrder && !blockedBySafetyGate,
    blocked_by_safety_gate:blockedBySafetyGate,
    reason:normalizedReason || null,
  }
}

function pendingManagementExpectedState(item) {
  const ticket = String(item?.ticket ?? item?.mt5_ticket ?? '').trim()
  const rawDirection = String(item?.side || item?.pending_type || item?.order_type || '').toLowerCase()
  const rawVolume = item?.volume ?? item?.volume_current ?? item?.volume_initial ?? 0
  return {
    ticket,
    symbol: String(item?.symbol || ''),
    magic: Number(item?.magic || 0),
    volume: Number(rawVolume || 0),
    direction: rawDirection.startsWith('buy') ? 'buy' : (rawDirection.startsWith('sell') ? 'sell' : ''),
  }
}

function isFilledHistoryOrder(order) {
  if (!order || typeof order !== 'object') return false
  const state = String(order.state ?? order.status ?? order.order_state ?? '').toLowerCase()
  if (/(cancel|reject|expire|delete)/.test(state)) return false
  if (/(fill|filled|closed|close|executed|complete)/.test(state)) return true
  if (order.deal != null || order.deal_ticket != null || order.position_id != null) return true
  const volume = Number(order.volume ?? order.volume_initial ?? 0)
  return volume > 0 && (order.close_time != null || order.profit != null)
}

function normalizeSymbolForScheduler(sym) {
  return stripBrokerSuffix(sym)
}

function buildSchedulerKey(promptTypeId, symbol) {
  return `${promptTypeId}:${normalizeSymbolForScheduler(symbol)}`
}

function schedulerRuntimeNextRunAt(state, cooldownTtl, nowMs = Date.now()) {
  const deadlines = []
  const stateDeadline = Date.parse(String(state?.nextRunAtUtc || ''))
  if (Number.isFinite(stateDeadline) && stateDeadline > nowMs) deadlines.push(stateDeadline)

  // Keep compatibility with runtime states written before nextRunAtUtc was
  // persisted, while preferring the absolute deadline whenever it exists.
  if (!Number.isFinite(stateDeadline)) {
    const legacySeconds = Number(state?.nextRunInSeconds)
    if (Number.isFinite(legacySeconds) && legacySeconds > 0) {
      deadlines.push(nowMs + legacySeconds * 1000)
    }
  }

  const ttlSeconds = Number(cooldownTtl)
  if (Number.isFinite(ttlSeconds) && ttlSeconds > 0) {
    deadlines.push(nowMs + ttlSeconds * 1000)
  }
  return deadlines.length > 0 ? Math.max(...deadlines) : null
}

// === Redis Subscription Keys ===
const REDIS_SCHEDULER_KEYS = 'auto:scheduler:keys'
const REDIS_SUBS_PREFIX = 'auto:scheduler:'
const REDIS_SUBS_SUFFIX = ':subs'
const REDIS_USER_PREFIX = 'auto:user:'
const REDIS_USER_SUFFIX = ':auto'
let subscriptionIndexHealth = { ok:false, error:'not_initialized', updatedAt:null }
const schedulerAdminEventSnapshots = new Map()

function schedulerNextRun(state, seconds, atMs = Date.now()) {
  const normalizedSeconds = Math.max(0, Number(seconds) || 0)
  state.nextRunInSeconds = normalizedSeconds
  state.nextRunAtUtc = normalizedSeconds > 0
    ? new Date(Number(atMs) + normalizedSeconds * 1000).toISOString()
    : ''
  return normalizedSeconds
}

function schedulerNextRunAt(state, deadlineMs, nowMs = Date.now()) {
  const deadline = Number(deadlineMs)
  const now = Number(nowMs)
  if (!Number.isFinite(deadline) || !Number.isFinite(now)) return schedulerNextRun(state, 0, now)
  const remainingMs = deadline - now
  const remainingSeconds = remainingMs > 0 ? Math.max(1, Math.ceil(remainingMs / 1000)) : 0
  state.nextRunInSeconds = remainingSeconds
  state.nextRunAtUtc = remainingSeconds > 0 ? new Date(deadline).toISOString() : ''
  return remainingSeconds
}

function schedulerStateEventData(key, state, updatedAtUtc) {
  const separator = String(key || '').indexOf(':')
  const promptTypeId = Number(state?.promptTypeId || (separator >= 0 ? String(key).slice(0, separator) : 0))
  const symbol = String(state?.symbol || (separator >= 0 ? String(key).slice(separator + 1) : ''))
  return {
    key:String(key || ''),
    strategy_id:promptTypeId,
    prompt_type_id:promptTypeId,
    symbol,
    running:Boolean(state?.running),
    in_flight:Boolean(state?.inFlight),
    wait_reason:String(state?.waitReason || ''),
    last_error:String(state?.lastError || ''),
    stage:String(state?.stage || 'idle'),
    stage_label:String(state?.stageLabel || ''),
    progress_percent:Number(state?.progressPercent || 0),
    progress_seq:Number(state?.progressSeq || 0),
    skipped_overlap_count:Number(state?.skippedOverlapCount || 0),
    subscriber_count:Number(state?.subscriberCount || state?.subscribers?.size || 0),
    next_run_in_seconds:Number(state?.nextRunInSeconds || 0),
    next_run_at_utc:String(state?.nextRunAtUtc || ''),
    updated_at:String(updatedAtUtc || state?.stateUpdatedAtUtc || new Date().toISOString()),
  }
}

function schedulerStateEventSignature(data) {
  return JSON.stringify({
    key:data.key, running:data.running, in_flight:data.in_flight,
    wait_reason:data.wait_reason, last_error:data.last_error,
    stage:data.stage, stage_label:data.stage_label,
    subscriber_count:data.subscriber_count,
    skipped_overlap_count:data.skipped_overlap_count,
    next_run_at_utc:data.next_run_at_utc,
  })
}

function publishSchedulerStateEvent(key, state, updatedAtUtc) {
  if (typeof broadcastAdminEvent !== 'function') return
  const eventData = schedulerStateEventData(key, state, updatedAtUtc)
  const schedulerKey = String(key || '')
  const signature = schedulerStateEventSignature(eventData)
  if (signature === schedulerAdminEventSnapshots.get(schedulerKey)) return
  broadcastAdminEvent('ai', 'scheduler_state', eventData, {
    scopes:['ai-operations'],
    refresh:false,
  })
  schedulerAdminEventSnapshots.set(schedulerKey, signature)
}

// === Redis Subscription Helpers ===
export async function syncUserRedisSubscription(userId, promptTypeId, symbols, enabled) {
  const redis = getRedis()
  if (!redis) throw new Error('redis_unavailable')

  try {
    const userKey = `${REDIS_USER_PREFIX}${userId}${REDIS_USER_SUFFIX}`

    // Remove old subscriptions for this user
    const oldKeys = await redis.smembers(REDIS_SCHEDULER_KEYS)
    for (const k of oldKeys) {
      await redis.srem(`${REDIS_SUBS_PREFIX}${k}${REDIS_SUBS_SUFFIX}`, userId)
    }

    if (!enabled || !promptTypeId || !symbols || symbols.length === 0) {
      await redis.del(userKey)
      // Clean up empty subs sets
      for (const k of oldKeys) {
        const count = await redis.scard(`${REDIS_SUBS_PREFIX}${k}${REDIS_SUBS_SUFFIX}`)
        if (count === 0) {
          await redis.del(`${REDIS_SUBS_PREFIX}${k}${REDIS_SUBS_SUFFIX}`)
          await redis.del(`${REDIS_SUBS_PREFIX}${k}:state`)
          await redis.srem(REDIS_SCHEDULER_KEYS, k)
        }
      }
      return
    }

    // Write user config
    await redis.hset(userKey, {
      prompt_type_id: String(promptTypeId),
      selected_symbols: JSON.stringify(symbols),
      enabled: '1'
    })

    // Add new subscriptions
    for (const sym of symbols) {
      const k = buildSchedulerKey(promptTypeId, sym)
      await redis.sadd(`${REDIS_SUBS_PREFIX}${k}${REDIS_SUBS_SUFFIX}`, userId)
      await redis.sadd(REDIS_SCHEDULER_KEYS, k)
    }

    // Clean up empty subs sets
    for (const k of oldKeys) {
      const count = await redis.scard(`${REDIS_SUBS_PREFIX}${k}${REDIS_SUBS_SUFFIX}`)
      if (count === 0) {
        await redis.del(`${REDIS_SUBS_PREFIX}${k}${REDIS_SUBS_SUFFIX}`)
        await redis.del(`${REDIS_SUBS_PREFIX}${k}:state`)
        await redis.srem(REDIS_SCHEDULER_KEYS, k)
      }
    }
  } catch (e) {
    console.error('[Redis] syncUserRedisSubscription error:', e.message)
    throw e
  }
}

export async function rebuildRedisSubscriptions() {
  const redis = getRedis()
  if (!redis) {
    subscriptionIndexHealth = { ok:false, error:'redis_unavailable', updatedAt:new Date().toISOString() }
    return subscriptionIndexHealth
  }

  try {
    // Clear all existing subscription data
    const oldKeys = await redis.smembers(REDIS_SCHEDULER_KEYS)
    for (const k of oldKeys) {
      await redis.del(`${REDIS_SUBS_PREFIX}${k}${REDIS_SUBS_SUFFIX}`)
      await redis.del(`${REDIS_SUBS_PREFIX}${k}:state`)
    }
    await redis.del(REDIS_SCHEDULER_KEYS)

    // Query all enabled users from DB
    const rows = await queryAll(`
      SELECT s.user_id, s.prompt_type_id, s.selected_symbols_json, apt.symbols_json as strategy_symbols_json
      FROM auto_scheduler s
      JOIN auto_prompt_types apt ON apt.id = s.prompt_type_id
      JOIN users u ON u.id = s.user_id
      WHERE s.enabled = 1 AND s.prompt_type_id IS NOT NULL
        AND (apt.scope = 'platform' OR (apt.scope = 'private' AND apt.owner_user_id = s.user_id))
        AND NOT EXISTS (
          SELECT 1 FROM ai_observer_sources observer_source
          LEFT JOIN auto_scheduler observer_scheduler
            ON observer_scheduler.user_id = observer_source.bridge_user_id
           AND observer_scheduler.prompt_type_id = observer_source.strategy_id
          WHERE observer_source.strategy_id = apt.id
            AND observer_source.status = 'active'
            AND COALESCE(observer_scheduler.enabled, 0) = 0
        )
         AND (u.role = 'admin' OR (u.plan = 'pro' AND (u.plan_expires_at IS NULL OR u.plan_expires_at >= NOW())))
    `)

    const onlineUserIds = new Set()
    for (const row of rows) {
      const userSymbols = resolveEffectiveSymbols(row.selected_symbols_json, row.strategy_symbols_json)
      if (userSymbols.length === 0) continue

      // Redis is the durable subscription index, not the online-bridge list.
      // Keep every valid configuration indexed while the Bridge is offline so
      // startup/reconnect can resume without waiting for a full config write.
      const bridgeOnline = isBridgeAlive(row.user_id)
      if (bridgeOnline) onlineUserIds.add(String(row.user_id))

      const userKey = `${REDIS_USER_PREFIX}${row.user_id}${REDIS_USER_SUFFIX}`
      await redis.hset(userKey, {
        prompt_type_id: String(row.prompt_type_id),
        selected_symbols: JSON.stringify(userSymbols),
        enabled: '1'
      })

      for (const sym of userSymbols) {
        const k = buildSchedulerKey(row.prompt_type_id, sym)
        await redis.sadd(`${REDIS_SUBS_PREFIX}${k}${REDIS_SUBS_SUFFIX}`, row.user_id)
        await redis.sadd(REDIS_SCHEDULER_KEYS, k)
      }
    }

    const keysCount = await redis.scard(REDIS_SCHEDULER_KEYS)
    subscriptionIndexHealth = {
      ok:true, error:null, schedulerKeys:Number(keysCount), onlineUsers:onlineUserIds.size,
      configuredUsers:rows.length, updatedAt:new Date().toISOString(),
    }
    console.log(`[Redis] Rebuilt subscription index: ${keysCount} scheduler keys, ${onlineUserIds.size} online users (of ${rows.length} configured)`)
    return subscriptionIndexHealth
  } catch (e) {
    console.error('[Redis] rebuildRedisSubscriptions error:', e.message)
    subscriptionIndexHealth = { ok:false, error:String(e?.message || 'subscription_index_rebuild_failed'), updatedAt:new Date().toISOString() }
    return subscriptionIndexHealth
  }
}

export function getSubscriptionIndexHealth() {
  return { ...subscriptionIndexHealth }
}

async function syncSchedulerRedisIndex(redis, key, state) {
  const schedulerKey = String(key || '').trim()
  if (!schedulerKey) return
  const subsKey = `${REDIS_SUBS_PREFIX}${schedulerKey}${REDIS_SUBS_SUFFIX}`
  const stateKey = `${REDIS_SUBS_PREFIX}${schedulerKey}:state`

  // A stopped scheduler must disappear from all runtime indexes.  Keep this
  // cleanup in the same helper used by state publication so a late stopped
  // write can never re-add a key after reconcile removed it.
  if (!state?.running) {
    await redis.del(subsKey)
    await redis.del(stateKey)
    await redis.srem(REDIS_SCHEDULER_KEYS, schedulerKey)
    return
  }

  // State publication is also the repair path for Redis writes lost during a
  // restart.  Re-add the scheduler key and make the subscriber set converge
  // to the in-memory configured set whenever that set is available.
  await redis.sadd(REDIS_SCHEDULER_KEYS, schedulerKey)
  if (!Object.prototype.hasOwnProperty.call(state, 'subscribers')) return

  const configuredSubscribers = state.subscribers instanceof Set
    ? [...state.subscribers]
    : (Array.isArray(state.subscribers) ? state.subscribers : [])
  const normalizedSubscribers = configuredSubscribers
    .map(value => String(value ?? '').trim())
    .filter(Boolean)
  const configuredSet = new Set(normalizedSubscribers)
  const existingSubscribersRaw = await redis.smembers(subsKey)
  const existingSubscribers = Array.isArray(existingSubscribersRaw) ? existingSubscribersRaw : []
  const staleSubscribers = existingSubscribers.filter(value => !configuredSet.has(String(value)))
  if (staleSubscribers.length > 0) await redis.srem(subsKey, ...staleSubscribers)
  if (normalizedSubscribers.length > 0) await redis.sadd(subsKey, ...normalizedSubscribers)
  else await redis.del(subsKey)
}

export async function updateSchedulerRedisState(key, state) {
  const redis = getRedis()
  if (!redis) return

  try {
    await syncSchedulerRedisIndex(redis, key, state)
    const stateUpdatedAtUtc = new Date().toISOString()
    state.stateUpdatedAtUtc = stateUpdatedAtUtc
    if (!state?.running) {
      publishSchedulerStateEvent(key, state, stateUpdatedAtUtc)
      return
    }
    if (Number(state.nextRunInSeconds) > 0 && !state.nextRunAtUtc) {
      schedulerNextRun(state, state.nextRunInSeconds)
    }
    const fields = {
      running: state.running ? '1' : '0',
      in_flight: state.inFlight ? '1' : '0',
      interval_minutes: String(state.intervalMinutes || 5),
      subscriber_count: String(state.subscriberCount || 0),
      last_error: state.lastError || '',
      wait_reason: state.waitReason || '',
      next_run_in_seconds: String(state.nextRunInSeconds || 0),
      next_run_at_utc: state.nextRunAtUtc || '',
      state_updated_at_utc: stateUpdatedAtUtc,
      last_run_at: state.lastRunAt || '',
      stage: state.stage || 'idle',
      stage_label: state.stageLabel || '',
      progress_percent: String(state.progressPercent || 0),
      progress_seq: String(state.progressSeq || 0),
      skipped_overlap_count: String(state.skippedOverlapCount || 0),
      cycle_id: state.cycleId || '',
      cycle_started_at: state.cycleStartedAt || '',
      stage_updated_at: state.stageUpdatedAt || ''
    }
    if (state.marketState) {
      fields.market_reason = state.marketState.reason || ''
      fields.market_detail_reason = state.marketState.detailReason || ''
      fields.market_state_source = state.marketState.source || ''
      fields.market_symbol = state.marketState.symbol || ''
      fields.market_trade_mode = String(state.marketState.tradeMode ?? -1)
      fields.market_tick_age_ms = String(state.marketState.tickAgeMs ?? '')
      fields.market_tick_age_seconds = String(state.marketState.tickAgeSeconds ?? '')
      fields.market_mt5_time = state.marketState.mt5TimeStr || ''
    }
    await redis.hset(`${REDIS_SUBS_PREFIX}${key}:state`, fields)
    publishSchedulerStateEvent(key, state, stateUpdatedAtUtc)
  } catch (e) { console.error('[updateSchedulerRedisState]', key, e.message) }
}

// === Compatibility: isAutoSchedulerRunning(userId) ===
export function isAutoSchedulerRunning(userId) {
  for (const key in autoSchedulerState) {
    const st = autoSchedulerState[key]
    if (st?.subscribers?.has(userId) && st.running) return true
  }
  return false
}

// === Remove user from runtime subscriptions (bridge disconnect) ===
export async function removeUserRuntimeAutoSubscription(userId) {
  const redis = getRedis()
  try {
    // Remove from Redis
    if (redis) {
      const keys = await redis.smembers(REDIS_SCHEDULER_KEYS)
      for (const k of keys) {
        await redis.srem(`${REDIS_SUBS_PREFIX}${k}${REDIS_SUBS_SUFFIX}`, userId)
        // Clean up empty sets
        const count = await redis.scard(`${REDIS_SUBS_PREFIX}${k}${REDIS_SUBS_SUFFIX}`)
        if (count === 0) {
          await redis.del(`${REDIS_SUBS_PREFIX}${k}${REDIS_SUBS_SUFFIX}`)
          await redis.del(`${REDIS_SUBS_PREFIX}${k}:state`)
          await redis.srem(REDIS_SCHEDULER_KEYS, k)
        }
      }
      await redis.del(`${REDIS_USER_PREFIX}${userId}${REDIS_USER_SUFFIX}`)
    }

    // In-memory subscribers represent configured signal-history recipients,
    // not only users whose Bridge is online. Disconnecting pauses execution
    // but must not remove future shared signals from that user's history.
  } catch (e) {
    console.error('[removeUserRuntimeAutoSubscription] Error:', e.message)
  }
}

// === User Auto Runtime Status ===
export async function getUserAutoRuntimeStatus(userId) {
  const activeSubscription = await queryOne(`SELECT strategy_id, symbols_json
    FROM strategy_subscriptions
    WHERE user_id = ? AND is_deleted = 0 AND execution_enabled = 1
    ORDER BY updated_at DESC, id DESC LIMIT 1`, [userId])
  if (!activeSubscription) {
    return { enabled: false, running: false, paused_reason: 'disabled', prompt_type_id: null, prompt_type_name: '', selected_symbols: [], active_scheduler_keys: [], subscriber_count: 0, in_flight: false, active_cycles: [], stage: 'idle', last_error: '', next_run_in_seconds: 0, next_run_at_utc: '', state_updated_at_utc: '', last_run_at: '', last_signal_id: null, admin_bridge_online: false, market_state: { isOpen: false, reason: 'unknown' }, redis_available: false }
  }
  const scheduler = await queryOne('SELECT * FROM auto_scheduler WHERE user_id = ?', [userId])
  if (!scheduler || !scheduler.enabled) {
    return { enabled: true, running: false, paused_reason: 'no_runtime_scheduler', prompt_type_id: Number(activeSubscription.strategy_id) || null, prompt_type_name: '', selected_symbols: [], active_scheduler_keys: [], subscriber_count: 0, in_flight: false, active_cycles: [], stage: 'paused', last_error: '', next_run_in_seconds: 0, next_run_at_utc: '', state_updated_at_utc: '', last_run_at: '', last_signal_id: null, admin_bridge_online: false, market_state: { isOpen: false, reason: 'unknown' }, redis_available: false }
  }

  let selectedSymbols = []
  let promptTypeName = ''
  let promptType = null
  if (scheduler.prompt_type_id) {
    const pt = await getAutoPromptTypeById(scheduler.prompt_type_id)
    if (pt) {
      promptType = pt
      promptTypeName = pt.title || ''
      selectedSymbols = resolveEffectiveSymbols(scheduler.selected_symbols_json, pt.symbols_json || '[]')
    }
  }

  const redis = getRedis()
  const redisAvailable = !!redis && isRedisAvailable()
  const marketBridge = promptType ? await resolveStrategyMarketBridge(promptType) : { userId:null, source:null }
  const marketBridgeUserId = marketBridge.userId
  const adminBridgeOnline = promptType?.scope === 'private' ? false : !!marketBridgeUserId && isBridgeAlive(marketBridgeUserId)
  const marketBridgeOnline = !!marketBridgeUserId && isBridgeAlive(marketBridgeUserId)
  const marketState = marketBridgeOnline
    ? summarizeRuntimeMarketStates(selectedSymbols.map(symbol => ({
      symbol,
      ...getOwnBridgeMarketState(marketBridgeUserId, symbol),
    })))
    : { alive: false, isOpen: false, tradeMode: -1, reason: 'bridge_offline', lastTickMs: null, tickAgeMs: null, mt5TimeStr: null, symbols:[] }

  // Find user's active scheduler keys
  const activeKeys = []
  const statusNowMs = Date.now()
  let earliestNextRunAtMs = null
  let anyInFlight = false
  let overallLastError = ''
  let overallWaitReason = ''
  let overallMarketWaitReason = ''
  let overallLastRunAt = ''
  let overallLastSignalId = null
  let latestStateUpdatedAtUtc = ''
  let totalSubscribers = 0
  const activeCycles = []

  for (const sym of selectedSymbols) {
    const key = buildSchedulerKey(scheduler.prompt_type_id, sym)
    const st = autoSchedulerState[key]
    if (!st || !st.subscribers || !st.subscribers.has(userId)) {
      continue
    }
    activeKeys.push(key)
    totalSubscribers += st.subscribers.size
    if (st.inFlight) anyInFlight = true
    if (st.lastError) overallLastError = st.lastError
    if (st.waitReason && !overallWaitReason) overallWaitReason = st.waitReason
    if (isMarketWaitReason(st.waitReason) && !overallMarketWaitReason) overallMarketWaitReason = st.waitReason
    if (st.lastRunAt && (!overallLastRunAt || st.lastRunAt > overallLastRunAt)) overallLastRunAt = st.lastRunAt
    if (st.lastSignalId) overallLastSignalId = st.lastSignalId
    if (st.stateUpdatedAtUtc && st.stateUpdatedAtUtc > latestStateUpdatedAtUtc) latestStateUpdatedAtUtc = st.stateUpdatedAtUtc
    if (st.inFlight) {
      activeCycles.push({
        cycle_id: st.cycleId || `${key}:running`,
        prompt_type_id: st.promptTypeId,
        symbol: st.symbol,
        stage: st.stage || 'running',
        stage_label: st.stageLabel || '正在准备推理',
        progress_percent: Number(st.progressPercent || 3),
        progress_seq: Number(st.progressSeq || 0),
        started_at: st.cycleStartedAt || '',
        stage_updated_at: st.stageUpdatedAt || st.cycleStartedAt || '',
      })
    }

    // The published runtime deadline remains useful even when Redis is
    // unavailable. Redis can add a second constraint, but must not become
    // the only source of the next-run timestamp.
    let keyNextRunAtMs = schedulerRuntimeNextRunAt(st, null, statusNowMs)
    if (redis) {
      try {
        const ttl = await redis.ttl(`${REDIS_COOLDOWN_PREFIX}${key}`)
        keyNextRunAtMs = schedulerRuntimeNextRunAt(st, ttl, statusNowMs)
        // A key may be constrained by both its published runtime deadline and
        // the Redis cooldown lease. It is safe to run only after both have
        // elapsed, so take the later deadline for this key. Across symbols,
        // the scheduler may run the first key whose constraints are ready.
      } catch (e) { console.warn('[Scheduler] Redis TTL check failed:', e.message) }
    }

    if (Number.isFinite(keyNextRunAtMs)
      && (earliestNextRunAtMs === null || keyNextRunAtMs < earliestNextRunAtMs)) {
      earliestNextRunAtMs = keyNextRunAtMs
    }
  }

  // Determine paused reason — only real errors/blockers, not normal cooldown
  let pausedReason = ''
  if (bridgeWeeklyWindow(userId)) pausedReason = 'weekly_flatten_window'
  else if (!scheduler.prompt_type_id) pausedReason = 'no_strategy'
  else if (selectedSymbols.length === 0) pausedReason = 'no_symbols'
  else {
    const activeSubscription = await queryOne(`SELECT subscriptions.*,
        sources.timezone_offset_minutes AS runtime_timezone_offset_minutes,
        sources.clock_status AS runtime_clock_status
      FROM strategy_subscriptions subscriptions
      JOIN trading_accounts accounts ON accounts.id = subscriptions.trading_account_id
        AND accounts.user_id = subscriptions.user_id AND accounts.is_deleted = 0
      LEFT JOIN market_data_sources sources ON sources.bridge_user_id = subscriptions.user_id
        AND UPPER(COALESCE(sources.broker_server, '')) = UPPER(accounts.broker_server)
        AND CAST(COALESCE(sources.account_login, 0) AS CHAR) = CAST(accounts.login_account AS CHAR)
      WHERE subscriptions.user_id = ? AND subscriptions.strategy_id = ?
        AND subscriptions.execution_enabled = 1 AND subscriptions.is_deleted = 0
      ORDER BY subscriptions.updated_at DESC, subscriptions.id DESC LIMIT 1`, [userId, scheduler.prompt_type_id])
    if (activeSubscription && !isSubscriptionScheduleActive(activeSubscription)
      && activeSubscription.outside_window_behavior !== 'signals_only') pausedReason = 'outside_schedule'
  }
  if (!pausedReason) {
    if (activeKeys.length === 0) {
      const userBridgeAlive = isBridgeAlive(userId)
      pausedReason = userBridgeAlive ? 'no_runtime_scheduler' : 'user_bridge_offline'
    } else if (!marketBridgeOnline) {
      pausedReason = promptType?.scope === 'private' ? 'owner_bridge_offline' : 'admin_bridge_offline'
    } else if (!marketState.isOpen && overallMarketWaitReason) {
      // The scheduler probes the exact subscribed symbol before each cycle.
      // Only its current per-symbol wait state may pause the status badge;
      // a generic or stale bridge snapshot must not override a running market.
      pausedReason = overallMarketWaitReason
    } else if (!redisAvailable) {
      pausedReason = 'redis_unavailable'
    } else if (overallLastError && !anyInFlight) {
      pausedReason = overallLastError
    }
  }

  const running = activeKeys.length > 0 && !pausedReason
  const nextRunSeconds = earliestNextRunAtMs === null
    ? 0
    : Math.max(0, Math.ceil((earliestNextRunAtMs - statusNowMs) / 1000))
  const nextRunAtUtc = nextRunSeconds > 0 ? new Date(earliestNextRunAtMs).toISOString() : ''

  return {
    enabled: true,
    running,
    prompt_type_id: scheduler.prompt_type_id,
    prompt_type_name: promptTypeName,
    selected_symbols: selectedSymbols,
    active_scheduler_keys: activeKeys,
    subscriber_count: totalSubscribers,
    in_flight: anyInFlight,
    active_cycles: activeCycles,
    stage: anyInFlight ? 'running' : (pausedReason ? 'paused' : 'idle'),
    last_error: overallLastError,
    wait_reason: overallWaitReason,
    paused_reason: pausedReason,
    next_run_in_seconds: nextRunSeconds,
    next_run_at_utc: nextRunAtUtc,
    state_updated_at_utc: latestStateUpdatedAtUtc,
    last_run_at: overallLastRunAt,
    last_signal_id: overallLastSignalId,
    admin_bridge_online: adminBridgeOnline,
    market_bridge_online: marketBridgeOnline,
    strategy_scope: promptType?.scope || 'platform',
    market_state: marketState,
    redis_available: redisAvailable,
    subscription_index_health:getSubscriptionIndexHealth(),
  }
}

// === Redis Lock Helpers ===
const REDIS_LOCK_PREFIX = 'auto:scheduler:lock:'
const REDIS_COOLDOWN_PREFIX = 'auto:scheduler:cooldown:'
// A healthy inference renews this lease. If the process terminates, a new
// server should not be blocked by an abandoned ten-minute lock.
const LOCK_TTL_MS = 120000
const LOCK_RENEW_INTERVAL_MS = 30000

// Lua script for atomic finalize: verify token → set cooldown → delete lock
const FINALIZE_LUA = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  if ARGV[3] == "1" then
    redis.call("set", KEYS[2], "1", "EX", ARGV[2])
  end
  return redis.call("del", KEYS[1])
else
  return 0
end
`

async function acquireLock(key) {
  const redis = getRedis()
  if (!redis) { console.warn(`[acquireLock] ${key}: Redis unavailable`); return null }
  const token = crypto.randomUUID()
  try {
    const ok = await redis.set(`${REDIS_LOCK_PREFIX}${key}`, token, 'NX', 'PX', LOCK_TTL_MS)
    if (!ok) console.warn(`[acquireLock] ${key}: lock already held`)
    return ok ? token : null
  } catch (e) { console.error('[acquireLock]', key, e.message); return null }
}

const deliveryInventoryLockKey = accountSymbolInventoryLockKey

async function acquireDeliveryInventoryLock(userId, symbol) {
  // Keep the scheduler's historical key and lease semantics while sharing
  // the exact account+symbol fence with admin strategy deliveries.
  return acquireAccountSymbolInventoryLock(userId, symbol)
}

async function schedulerLockWaitSeconds(key) {
  const redis = getRedis()
  if (!redis) return 5
  try {
    const ttlMs = Number(await redis.pttl(`${REDIS_LOCK_PREFIX}${key}`))
    return ttlMs > 0 ? Math.max(1, Math.ceil(ttlMs / 1000)) : 5
  } catch {
    return 5
  }
}

// Atomic finalize: verify token → set cooldown → delete lock in one Lua eval
async function finalizeLock(key, token, cooldownSeconds) {
  const redis = getRedis()
  if (!redis || !token) return false
  try {
    const result = await redis.eval(FINALIZE_LUA, 2, `${REDIS_LOCK_PREFIX}${key}`, `${REDIS_COOLDOWN_PREFIX}${key}`, token, String(cooldownSeconds || 0), cooldownSeconds ? '1' : '0')
    return result > 0
  } catch (e) { console.error('[finalizeLock]', key, e.message); return false }
}

async function renewLock(key, token) {
  const redis = getRedis()
  if (!redis || !token) return false
  try {
    const result = await redis.eval(
      `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("pexpire", KEYS[1], ARGV[2]) else return 0 end`,
      1, `${REDIS_LOCK_PREFIX}${key}`, token, LOCK_TTL_MS)
    return result === 1
  } catch (e) { console.error('[renewLock]', key, e.message); return false }
}

function createLockGuard(key, token) {
  const guard = { key, token, lost: false, renewTimer: null }
  guard.isOwned = async () => {
    if (guard.lost) return false
    const redis = getRedis()
    if (!redis) return false
    try {
      return await redis.get(`${REDIS_LOCK_PREFIX}${key}`) === token
    } catch (e) {
      console.error('[lockGuard] isOwned check failed:', e.message)
      return false
    }
  }
  guard.assertOwned = async (phase) => {
    if (guard.lost || !(await guard.isOwned())) {
      guard.lost = true
      console.error(`[LockGuard] ${key}: lock lost at phase ${phase}`)
      return false
    }
    return true
  }
  return guard
}

async function setCooldown(key, intervalSeconds) {
  const redis = getRedis()
  if (!redis) return false
  try {
    await redis.set(`${REDIS_COOLDOWN_PREFIX}${key}`, '1', 'EX', intervalSeconds)
    return true
  } catch (e) { console.error('[setCooldown]', key, e.message); return false }
}

function retryDelayMs(reason, consecutiveFailures = 1) {
  switch (reason) {
    case 'admin_bridge_offline':
    case 'redis_unavailable':
    case 'weekly_flatten_window':
    case 'lock_busy':
    case 'bridge_update_maintenance':
    case 'deployment_draining':
    case 'deployment_drain_check_failed':
      return 5000
    case 'market_closed':
    case 'market_restricted':
      return 15000
    case 'market_stale_tick':
    case 'market_unknown_no_tick':
    case 'market_unknown':
      return 15000
    case 'rates_failed':
    case 'rates_empty':
    case 'account_failed':
    case 'positions_failed':
    case 'pending_list_failed':
    case 'private_portfolio_context_unavailable':
    case 'exception':
      return 20000
    case 'ai_failed':
      return Math.min(300_000, 60_000 * (2 ** Math.max(0, Number(consecutiveFailures || 1) - 1)))
    case 'no_api_key':
    case 'strategy_disabled':
    case 'symbol_not_supported':
      return 45000
    default:
      return 15000
  }
}

// === Admin Bridge ===
async function getActiveAdminBridgeUserId() {
  const bridges = getAllBridges()
  const adminBridges = bridges.filter(b => b.connected && b.alive)
    .sort((a, b) => a.userId - b.userId)
  if (adminBridges.length === 0) return null
  // Check if any is actually admin role
  for (const b of adminBridges) {
    const user = await queryOne('SELECT role FROM users WHERE id = ?', [b.userId])
    if (user?.role === 'admin') return b.userId
  }
  return null
}

// === Broadcast progress to all subscribers ===
async function broadcastAutoProgress(promptTypeId, symbol, progress) {
  const key = buildSchedulerKey(promptTypeId, symbol)
  const st = autoSchedulerState[key]
  if (!st?.subscribers) return
  const nextStage = progress.stage || st.stage || 'running'
  if (nextStage !== st.stage || !st.stageUpdatedAt) st.stageUpdatedAt = new Date().toISOString()
  st.stage = nextStage
  st.stageLabel = progress.label || st.stageLabel || ''
  st.progressPercent = Math.max(Number(st.progressPercent || 0), Math.min(100, Number(progress.progress_percent || 0)))
  st.progressSeq = Number(st.progressSeq || 0) + 1
  await updateSchedulerRedisState(key, st)
  const payload = {
    type: 'auto_progress',
    prompt_type_id: promptTypeId,
    symbol,
    cycle_id: st.cycleId,
    seq: st.progressSeq,
    started_at: st.cycleStartedAt,
    stage_updated_at: st.stageUpdatedAt,
    stage: st.stage,
    label: st.stageLabel,
    progress_percent: st.progressPercent,
    next_run_at_utc: st.nextRunAtUtc || '',
    updated_at: st.stateUpdatedAtUtc || '',
  }
  for (const uid of st.subscribers) {
    try { sendToBrowsers(uid, payload) } catch (e) { console.warn('[Scheduler] Failed to send progress to browser:', e.message) }
  }
  broadcastAdminEvent('ai', 'auto_progress', {
    prompt_type_id:Number(promptTypeId),
    symbol:String(symbol || ''),
    cycle_id:st.cycleId || null,
    stage:st.stage,
    stage_label:st.stageLabel || '',
    progress_percent:st.progressPercent,
    subscribers_count:st.subscribers.size,
    running:Boolean(st.running),
    in_flight:true,
    next_run_in_seconds:Number(st.nextRunInSeconds || 0),
    next_run_at_utc:st.nextRunAtUtc || '',
    updated_at:st.stateUpdatedAtUtc || '',
  }, {
    scopes:['ai-operations'],
    refresh:false,
    throttleKey:`admin-ai-progress:${promptTypeId}:${symbol}`,
    minIntervalMs:1000,
  })
}

async function resolveStrategyMarketBridge(promptType) {
  if (promptType?.scope === 'private') {
    return { userId:Number(promptType.owner_user_id), source:null, configured:true }
  }
  const source = promptType?.id ? await getObserverSourceForStrategy(promptType.id) : null
  if (source) return { userId:Number(source.bridge_user_id), source, configured:true }
  return { userId:await getActiveAdminBridgeUserId(), source:null, configured:false }
}

function schedulerUpdateMaintenanceReason(promptType, marketUserId) {
  const paused = promptType?.scope === 'private'
    ? isPrivateInferenceMaintenancePaused(marketUserId)
    : isPlatformMarketMaintenancePaused(marketUserId, promptType?.id)
  return paused ? 'bridge_update_maintenance' : ''
}

const SCHEDULER_WAIT_LOG_HEARTBEAT_MS = 30 * 60_000

function shouldLogSchedulerWait(state, reason, nowMs = Date.now()) {
  const changed = state._lastLoggedWaitReason !== reason
  const heartbeatDue = !Number.isFinite(state._lastWaitLogAtMs) || nowMs - state._lastWaitLogAtMs >= SCHEDULER_WAIT_LOG_HEARTBEAT_MS
  if (!changed && !heartbeatDue) return false
  state._lastLoggedWaitReason = reason
  state._lastWaitLogAtMs = nowMs
  return true
}

function schedulerWaitLabel(reason) {
  const labels = {
    bridge_update_maintenance: '量见智桥正在安全更新，等待连接恢复',
    redis_unavailable: 'Redis 不可用，等待恢复',
    owner_bridge_offline: '策略所属账户桥接离线，等待重连',
    admin_bridge_offline: '管理员行情桥接离线，等待重连',
    market_closed: '市场休市，等待开市',
    market_restricted: '品种交易权限受限，等待恢复',
    market_stale_tick: '行情报价停滞，等待恢复',
    market_unknown_no_tick: '尚未收到行情报价，等待同步',
    market_unknown: '市场状态未知，等待确认',
    private_portfolio_context_unavailable: '持仓或挂单数据不完整，等待桥接恢复',
    lock_busy: '上一轮分析仍在结束，等待释放调度权',
    model_task_active: '上一轮模型任务仍在运行，等待完成',
    model_task_status_unknown: '模型服务商状态暂不可确认，暂停重复请求',
    model_task_cooldown: '本轮模型任务已完成，等待完整配置周期',
    model_task_completion_unknown: '模型任务完成时间未知，等待恢复确认',
    model_task_gate_failed: '模型任务运行时不可用，等待恢复',
    deployment_draining: '系统正在安全排空，等待任务完成',
    deployment_drain_check_failed: '部署排空状态暂不可确认，暂停启动新分析',
  }
  return labels[reason] || `等待条件恢复（${reason}）`
}

function nextCompletionIntervalDeadlineMs(intervalMinutes, completedAtMs = Date.now()) {
  const normalizedMinutes = Math.max(1, Number(intervalMinutes) || 5)
  const intervalMs = Math.ceil(normalizedMinutes * 60_000)
  return completedAtMs + intervalMs
}

function completionIntervalCooldownSeconds(intervalMinutes, completedAtMs = Date.now()) {
  return calculateRecoverySeconds(
    nextCompletionIntervalDeadlineMs(intervalMinutes, completedAtMs),
    completedAtMs,
  )
}

function failedCycleCooldownSeconds(intervalMinutes, reason, consecutiveFailures = 1, providerRequestStarted = false) {
  const retrySeconds = Math.ceil(retryDelayMs(reason, consecutiveFailures) / 1000)
  return providerRequestStarted
    ? Math.max(completionIntervalCooldownSeconds(intervalMinutes), retrySeconds)
    : retrySeconds
}

function broadcastAutoProgressDone(promptTypeId, symbol, status, reason, cycleSnapshot) {
  for (const key in autoSchedulerState) {
    const st = autoSchedulerState[key]
    if (st.promptTypeId === promptTypeId && st.symbol === symbol && st.subscribers) {
      for (const uid of st.subscribers) {
        try {
          sendToBrowsers(uid, {
            type: 'auto_progress_done',
            status,
            reason,
            prompt_type_id: promptTypeId,
            symbol,
            cycle_id: cycleSnapshot?.cycleId || '',
            seq: Number(cycleSnapshot?.progressSeq || 0) + 1,
            progress_percent: status === 'success' ? 100 : Number(cycleSnapshot?.progressPercent || 0),
            next_run_in_seconds:Number(cycleSnapshot?.nextRunInSeconds || st.nextRunInSeconds || 0),
            next_run_at_utc:cycleSnapshot?.nextRunAtUtc || st.nextRunAtUtc || '',
            updated_at:st.stateUpdatedAtUtc || '',
          })
        } catch (e) { console.warn('[Scheduler] Failed to send progress_done to browser:', e.message) }
      }
      broadcastAdminEvent('ai', 'auto_progress_done', {
        prompt_type_id:Number(promptTypeId),
        symbol:String(symbol || ''),
        cycle_id:cycleSnapshot?.cycleId || null,
        status:String(status || ''),
        reason:String(reason || ''),
        progress_percent:status === 'success' ? 100 : Number(cycleSnapshot?.progressPercent || 0),
        next_run_in_seconds:Number(cycleSnapshot?.nextRunInSeconds || st.nextRunInSeconds || 0),
        next_run_at_utc:cycleSnapshot?.nextRunAtUtc || st.nextRunAtUtc || '',
        updated_at:st.stateUpdatedAtUtc || '',
        running:Boolean(st.running),
        in_flight:false,
      }, { scopes:['ai-operations'], refresh:true })
      break
    }
  }
}

async function discardSharedSignalForWeeklyWindow(signalId) {
  await withTransaction(async run => {
    await run('DELETE FROM inference_snapshots WHERE signal_id = ?', [signalId])
    await run('DELETE FROM auto_signal_deliveries WHERE signal_id = ?', [signalId])
    await run('DELETE FROM ai_signals WHERE id = ?', [signalId])
  })
}

// === Reconcile: start/stop schedulers based on DB state ===
export function selectSchedulerFallbackStrategy(strategies, userId) {
  const ownerId = Number(userId)
  return (Array.isArray(strategies) ? strategies : []).find(strategy =>
    strategy?.scope === 'platform'
      || (strategy?.scope === 'private' && Number(strategy.owner_user_id) === ownerId)
  ) || null
}

export async function reconcileAutoSchedulers({ suppressErrors = false } = {}) {
  if (autoSchedulersStopping) return { ok:false, error:'scheduler_stopping' }
  try {
    // Repair legacy enabled rows without crossing private-strategy ownership.
    const unassigned = await queryAll(`
      SELECT s.user_id FROM auto_scheduler s
      JOIN users u ON u.id = s.user_id
      WHERE s.enabled = 1 AND s.prompt_type_id IS NULL
        AND (u.role = 'admin' OR (u.plan = 'pro' AND (u.plan_expires_at IS NULL OR u.plan_expires_at >= NOW())))
    `)
    if (unassigned.length > 0) {
      const allPt = await getAutoPromptTypes()
      if (allPt.length > 0) {
        for (const row of unassigned) {
          const firstPt = selectSchedulerFallbackStrategy(allPt, row.user_id)
          if (!firstPt) continue
          await queryRun('UPDATE auto_scheduler SET prompt_type_id = ? WHERE user_id = ? AND prompt_type_id IS NULL',
            [firstPt.id, row.user_id])
          console.log(`[Reconciler] Auto-assigned strategy ${firstPt.id} to user ${row.user_id}`)
        }
      }
    }

    const rows = await queryAll(`
      SELECT
        s.prompt_type_id,
        s.selected_symbols_json,
        apt.symbols_json,
        apt.interval_minutes
      FROM auto_scheduler s
      JOIN auto_prompt_types apt ON apt.id = s.prompt_type_id
      JOIN users u ON u.id = s.user_id
      WHERE s.enabled = 1
        AND EXISTS (
          SELECT 1 FROM strategy_subscriptions subscription
          WHERE subscription.user_id = s.user_id
            AND subscription.strategy_id = s.prompt_type_id
            AND subscription.execution_enabled = 1
            AND subscription.is_deleted = 0
        )
        AND apt.is_active = 1
        AND apt.deleted_at IS NULL
        AND (apt.scope = 'platform' OR (apt.scope = 'private' AND apt.owner_user_id = s.user_id))
        AND NOT EXISTS (
          SELECT 1 FROM ai_observer_sources observer_source
          LEFT JOIN auto_scheduler observer_scheduler
            ON observer_scheduler.user_id = observer_source.bridge_user_id
           AND observer_scheduler.prompt_type_id = observer_source.strategy_id
          WHERE observer_source.strategy_id = apt.id
            AND observer_source.status = 'active'
            AND COALESCE(observer_scheduler.enabled, 0) = 0
        )
        AND (u.role = 'admin' OR (u.plan = 'pro' AND (u.plan_expires_at IS NULL OR u.plan_expires_at >= NOW())))
    `)

    const neededKeys = new Set()
    const neededKeyMeta = {}

    for (const row of rows) {
      const effectiveSymbols = resolveEffectiveSymbols(row.selected_symbols_json, row.symbols_json)
      for (const sym of effectiveSymbols) {
        const k = buildSchedulerKey(row.prompt_type_id, sym)
        neededKeys.add(k)
        neededKeyMeta[k] = { promptTypeId: row.prompt_type_id, symbol: sym, intervalMinutes: row.interval_minutes || 5 }
      }
    }

    // Stop schedulers no longer needed
    for (const key of Object.keys(autoSchedulerState)) {
      if (!neededKeys.has(key)) {
        await stopUnifiedScheduler(autoSchedulerState[key].promptTypeId, autoSchedulerState[key].symbol)
      }
    }

    // Start or update schedulers
    for (const k of neededKeys) {
      const meta = neededKeyMeta[k]
      if (autoSchedulerState[k]?.running) {
        autoSchedulerState[k].intervalMinutes = meta.intervalMinutes
        autoSchedulerState[k].subscriberCount = autoSchedulerState[k].subscribers?.size || 0
        await updateSchedulerRedisState(k, autoSchedulerState[k])
      } else {
        await startUnifiedScheduler(meta.promptTypeId, meta.symbol, meta.intervalMinutes)
      }
    }
    return { ok:true }
  } catch (e) {
    console.error('[reconcileAutoSchedulers] Error:', e.message)
    if (!suppressErrors) throw e
    return { ok:false, error:String(e?.message || 'scheduler_reconcile_failed') }
  }
}

// === Unified Scheduler Start/Stop ===
async function startUnifiedScheduler(promptTypeId, symbol, intervalMinutes = 5) {
  if (autoSchedulersStopping) return
  const key = buildSchedulerKey(promptTypeId, symbol)
  if (autoSchedulerState[key]?.running) {
    // Reconcile is also a Redis repair pass.  A process/Redis restart may
    // leave the in-memory worker alive while its key or subscribers set is
    // missing, so publish the current state before returning.
    await updateSchedulerRedisState(key, autoSchedulerState[key])
    return
  }

  const subscribers = await getAutoSubscribers(promptTypeId, symbol)
  if (subscribers.length === 0) return

  const subSet = new Set(subscribers.map(s => s.user_id))
  const tickIntervalMs = 5000 // tick every 5s for Redis lock check

  autoSchedulerState[key] = {
    key,
    promptTypeId,
    symbol,
    intervalMinutes,
    running: true,
    timer: null,
    inFlight: false,
    lastRunAt: null,
    lastError: null,
    waitReason: '',
    nextRunInSeconds: 0,
    nextRunAtUtc: '',
    stateUpdatedAtUtc: '',
    subscriberCount: subSet.size,
    subscribers: subSet,
    stage: 'idle',
    stageLabel: '',
    progressPercent: 0,
    progressSeq: 0,
    cycleId: '',
    cycleStartedAt: '',
    stageUpdatedAt: '',
    _waitCount: 0,
    _lastLoggedWaitReason: '',
    _lastWaitLogAtMs: 0,
    _consecutiveModelFailures: 0,
    skippedOverlapCount: 0,
    lastSkippedOverlapAtUtc: '',
  }

  console.log(`[UnifiedScheduler] Started ${key} (subscribers=${subSet.size}, interval=${intervalMinutes}min)`)
  await updateSchedulerRedisState(key, autoSchedulerState[key])

  const scheduleTick = delayMs => {
    const current = autoSchedulerState[key]
    if (!current?.running) return
    if (current.timer) clearTimeout(current.timer)
    const timer = setTimeout(tick, Math.max(0, Number(delayMs) || 0))
    current.timer = timer
  }

  const runTick = async () => {
    const st = autoSchedulerState[key]
    if (!st?.running) return

    const redis = getRedis()
    if (!redis || !isRedisAvailable()) {
      st._waitCount = (st._waitCount || 0) + 1
      if (shouldLogSchedulerWait(st, 'redis_unavailable')) console.log(`[UnifiedScheduler] ${key}: ${schedulerWaitLabel('redis_unavailable')}`)
      st.lastError = null
      st.waitReason = 'redis_unavailable'
      const delay = retryDelayMs('redis_unavailable')
      schedulerNextRun(st, Math.round(delay / 1000))
      await updateSchedulerRedisState(key, st)
      scheduleTick(delay)
      return
    }

    try {
      const ttl = await redis.ttl(`${REDIS_COOLDOWN_PREFIX}${key}`)
      if (ttl > 0) {
        schedulerNextRun(st, ttl)
        st.waitReason = 'cooldown'
        await updateSchedulerRedisState(key, st)
        scheduleTick(Math.min(ttl * 1000, 30000))
        return
      }
    } catch (e) {
      console.warn('[Scheduler] Redis TTL check failed, failing closed:', e.message)
      st.waitReason = 'redis_error'
      st.lastError = 'cooldown_check_failed'
      schedulerNextRun(st, 15)
      await updateSchedulerRedisState(key, st)
      scheduleTick(15000)
      return
    }

    // A deployment drain blocks only the start of a new cycle. Existing
    // in-flight work is allowed to finish, while the short recheck keeps the
    // runtime state and admin countdown aligned with the lease expiry.
    let deploymentDrain
    try {
      deploymentDrain = await readAutoInferenceDeploymentDrain({ redis })
    } catch (error) {
      deploymentDrain = { available:false, active:false, error:error?.message || 'drain_read_failed' }
    }
    if (!deploymentDrain.available) {
      st.lastError = 'deployment_drain_check_failed'
      st.waitReason = 'deployment_drain_check_failed'
      schedulerNextRun(st, Math.ceil(retryDelayMs('deployment_drain_check_failed') / 1000))
      await updateSchedulerRedisState(key, st)
      scheduleTick(retryDelayMs('deployment_drain_check_failed'))
      return
    }
    if (deploymentDrain.active) {
      st.lastError = ''
      st.waitReason = 'deployment_draining'
      const ttlSeconds = Number(deploymentDrain.ttlSeconds)
      const publishedDrainDeadlineMs = Number(deploymentDrain.expiresAtUtcMsc)
      const drainDeadlineMs = Number.isFinite(publishedDrainDeadlineMs) && publishedDrainDeadlineMs > Date.now()
        ? publishedDrainDeadlineMs
        : Number.isFinite(ttlSeconds) && ttlSeconds > 0 ? Date.now() + ttlSeconds * 1000 : null
      if (drainDeadlineMs) schedulerNextRunAt(st, drainDeadlineMs)
      else schedulerNextRun(st, Math.ceil(retryDelayMs('deployment_draining') / 1000))
      await updateSchedulerRedisState(key, st)
      const drainDelayMs = drainDeadlineMs
        ? Math.max(1000, Math.min(drainDeadlineMs - Date.now(), 30_000))
        : retryDelayMs('deployment_draining')
      scheduleTick(drainDelayMs)
      return
    }

    schedulerNextRun(st, 0)

    // Refresh subscribers
    try {
      const freshSubs = await getAutoSubscribers(promptTypeId, symbol)
      st.subscribers = new Set(freshSubs.map(s => s.user_id))
      st.subscriberCount = st.subscribers.size
      if (st.subscribers.size === 0) {
        console.log(`[UnifiedScheduler] No subscribers for ${key}, stopping`)
        await stopUnifiedScheduler(promptTypeId, symbol)
        return
      }
    } catch (e) { console.error(`[UnifiedScheduler] ${key} subscriber refresh failed:`, e.message) }

    // Resolve the strategy before choosing its market-data bridge. Platform
    // strategies use the platform market bridge; private strategies are
    // strictly owner-only and use the owner's own bridge/model.
    const ptRow = await getAutoPromptTypeById(promptTypeId)
    if (!ptRow || !ptRow.is_active) {
      st.lastError = 'strategy_disabled'
      st.waitReason = ''
      const delay = retryDelayMs('strategy_disabled')
      schedulerNextRun(st, Math.round(delay / 1000))
      await updateSchedulerRedisState(key, st)
      scheduleTick(delay)
      return
    }
    const marketBridge = await resolveStrategyMarketBridge(ptRow)
    const marketUserId = marketBridge.userId
    const marketClock = getPlatformMarketClockState(
      marketUserId, marketBridge.source?.trading_account_id)
    if (isWeeklyFlattenWindow(new Date(), marketClock.timezone_offset_minutes)) {
      const end = currentWeeklyFlattenEnd(new Date(), marketClock.timezone_offset_minutes)
      const delay = Math.max(1000, Number(end?.getTime() || Date.now() + 60_000) - Date.now())
      st.lastError = null
      st.waitReason = 'weekly_flatten_window'
      schedulerNextRun(st, Math.round(delay / 1000))
      await updateSchedulerRedisState(key, st)
      scheduleTick(delay)
      return
    }
    const updateMaintenanceReason = schedulerUpdateMaintenanceReason(ptRow, marketUserId)
    if (updateMaintenanceReason) {
      st.lastError = null
      st.waitReason = updateMaintenanceReason
      const delay = retryDelayMs(st.waitReason)
      schedulerNextRun(st, Math.round(delay / 1000))
      await updateSchedulerRedisState(key, st)
      scheduleTick(delay)
      return
    }
    if (!marketUserId || !isBridgeAlive(marketUserId)) {
      st._waitCount = (st._waitCount || 0) + 1
      st.lastError = null
      st.waitReason = ptRow.scope === 'private' ? 'owner_bridge_offline' : 'admin_bridge_offline'
      if (shouldLogSchedulerWait(st, st.waitReason)) console.log(`[UnifiedScheduler] ${key}: ${schedulerWaitLabel(st.waitReason)}`)
      const delay = retryDelayMs(st.waitReason)
      schedulerNextRun(st, Math.round(delay / 1000))
      await updateSchedulerRedisState(key, st)
      scheduleTick(delay)
      return
    }

    const marketProbe = await mt5Bridge(marketUserId, 'market_state', { symbol }, { timeoutMs: 5000, noFallback: true })
    if (marketProbe?.status === 'success') recordBridgeMarketState(marketUserId, marketProbe, Date.now(), {
      tradingAccountId:marketBridge.source?.trading_account_id,
    })
    const marketState = getOwnBridgeMarketState(marketUserId, symbol)
    st.marketState = marketState
    if (!marketState.isOpen) {
      st._waitCount = (st._waitCount || 0) + 1
      if (shouldLogSchedulerWait(st, marketState.reason)) console.log(`[UnifiedScheduler] ${key}: ${schedulerWaitLabel(marketState.reason)}`)
      st.lastError = null
      st.waitReason = marketState.reason
      const delay = retryDelayMs(marketState.reason)
      schedulerNextRun(st, Math.round(delay / 1000))
      await updateSchedulerRedisState(key, st)
      scheduleTick(delay)
      return
    }

    st._waitCount = 0
    st._lastLoggedWaitReason = ''
    st._lastWaitLogAtMs = 0
    st.lastError = null
    st.waitReason = ''

    // Redis is the live lease; the durable model-task envelope is the
    // restart/duplicate fence.  Never submit a second request while an older
    // auto-inference task for this strategy/symbol is active or status-unknown.
    let modelTaskGate
    try {
      modelTaskGate = await checkAutoModelTaskGate(promptTypeId, symbol, st.intervalMinutes)
    } catch (error) {
      st.lastError = 'model_task_gate_failed'
      st.waitReason = 'model_task_gate_failed'
      schedulerNextRun(st, Math.round(retryDelayMs('exception') / 1000))
      await updateSchedulerRedisState(key, st)
      scheduleTick(retryDelayMs('exception'))
      return
    }
    if (!modelTaskGate.allowed) {
      st.lastError = modelTaskGate.reason === 'model_task_status_unknown' ? 'model_task_status_unknown' : null
      st.waitReason = modelTaskGate.reason
      const modelTaskDeadlineMs = Number(modelTaskGate.nextAllowedAt)
      const hasModelTaskDeadline = Number.isFinite(modelTaskDeadlineMs) && modelTaskDeadlineMs > 0
      if (hasModelTaskDeadline) schedulerNextRunAt(st, modelTaskDeadlineMs)
      else schedulerNextRun(st, Number(modelTaskGate.nextRunInSeconds
        || Math.ceil(retryDelayMs(modelTaskGate.reason) / 1000)))
      await updateSchedulerRedisState(key, st)
      const modelTaskDelayMs = hasModelTaskDeadline
        ? Math.max(1000, modelTaskDeadlineMs - Date.now())
        : Math.max(1000, st.nextRunInSeconds * 1000)
      scheduleTick(modelTaskDelayMs)
      return
    }

    // Resolve the exact runtime model. Private model failures never switch to
    // another model after a request starts; missing configuration pauses here.
    let resolvedConfig
    try {
      resolvedConfig = await getUnifiedAutoInferenceConfig(promptTypeId, ptRow.scope === 'private' ? marketUserId : null)
    } catch (error) {
      st.lastError = error.message || 'no_api_key'
      st.waitReason = ''
      const delay = retryDelayMs(st.lastError)
      schedulerNextRun(st, Math.round(delay / 1000))
      await updateSchedulerRedisState(key, st)
      scheduleTick(delay)
      return
    }

    // Shutdown can be requested while the preflight awaits DB/Bridge/model
    // configuration.  Fence the cycle again immediately before taking the
    // distributed lock so no new provider work is admitted after stop.
    if (!st.running || autoSchedulersStopping) return
    if (st.inFlight) {
      scheduleTick(tickIntervalMs)
      return
    }
    const lockToken = await acquireLock(key)
    if (!st.running || autoSchedulersStopping) {
      if (lockToken) await finalizeLock(key, lockToken, 0).catch(() => {})
      return
    }
    if (!lockToken) {
      // Another scheduler (or the previous process lease after a restart) is
      // still finishing this key. Treat contention as a wait state rather
      // than a platform error, and publish it immediately to the dashboard.
      st.lastError = ''
      st.waitReason = 'lock_busy'
      schedulerNextRun(st, await schedulerLockWaitSeconds(key))
      st.stage = 'idle'
      st.stageLabel = ''
      await updateSchedulerRedisState(key, st)
      scheduleTick(Math.min(tickIntervalMs, st.nextRunInSeconds * 1000))
      return
    }
    const maintenanceBeganWhileLocking = schedulerUpdateMaintenanceReason(ptRow, marketUserId)
    if (maintenanceBeganWhileLocking) {
      await finalizeLock(key, lockToken, 0)
      st.lastError = null
      st.waitReason = maintenanceBeganWhileLocking
      const delay = retryDelayMs(st.waitReason)
      schedulerNextRun(st, Math.round(delay / 1000))
      await updateSchedulerRedisState(key, st)
      scheduleTick(delay)
      return
    }
    st.inFlight = true
    st._lockToken = lockToken
    st.stage = 'starting'
    st.stageLabel = '正在启动推理'
    st.progressPercent = 2
    st.progressSeq = 0
    st.cycleStartedAt = new Date().toISOString()
    st.stageUpdatedAt = st.cycleStartedAt
    schedulerNextRun(st, 0)
    st.cycleId = `${key}:${Date.now()}`
    st.lastError = ''
    st.waitReason = ''

    // Lock guard: structured lock context passed to cycle (Fix 1: closure, not arrow+this)
    const lockGuard = createLockGuard(key, lockToken)
    lockGuard.renewTimer = setInterval(async () => {
      if (lockGuard.lost || lockGuard.token !== lockToken) { clearInterval(lockGuard.renewTimer); return }
      const renewed = await renewLock(key, lockToken)
      if (!renewed) {
        lockGuard.lost = true
        console.error(`[LockGuard] ${key}: lock renewal failed — lock lost`)
        clearInterval(lockGuard.renewTimer)
      }
    }, LOCK_RENEW_INTERVAL_MS)
    st._lockGuard = lockGuard

    let cycleStatus = 'error'
    let cycleReason = 'exception'
    let cycleSnapshot = null
    let providerRequestStarted = false
    const previousOnProviderRequest = resolvedConfig._onProviderRequest
    resolvedConfig._onProviderRequest = async event => {
      providerRequestStarted = true
      if (typeof previousOnProviderRequest === 'function') await previousOnProviderRequest(event)
    }
    try {
      if (lockGuard.lost) { cycleReason = 'lock_lost'; throw new Error('lock lost during renewal') }
      const cycleResult = await runUnifiedAutoCycle(promptTypeId, symbol, lockGuard, {
        strategy: ptRow,
        inferenceUserId: marketUserId,
        config: resolvedConfig,
        cycleId: st.cycleId,
        cycleStartedAtMs: Date.parse(st.cycleStartedAt) || Date.now(),
        intervalMinutes: st.intervalMinutes,
      })
      if (cycleResult?.status === 'success') {
        st._consecutiveModelFailures = 0
        st.lastError = ''
        st.lastRunAt = cycleResult.createdAt
        st.lastSignalId = cycleResult.signalId
        st.subscriberCount = cycleResult.subscriberCount
        cycleStatus = 'success'
      } else if (cycleResult?.status === 'blocked') {
        st._consecutiveModelFailures = cycleResult.reason === 'ai_failed'
          ? Number(st._consecutiveModelFailures || 0) + 1 : 0
        st.lastError = cycleResult.reason
        cycleStatus = 'blocked'
        cycleReason = cycleResult.reason
      } else {
        cycleReason = cycleResult?.reason || 'unknown'
      }
    } catch (e) {
      console.error(`[UnifiedScheduler] ${key} cycle error:`, e.message)
      st._consecutiveModelFailures = Number(st._consecutiveModelFailures || 0) + 1
      st.lastError = 'exception'
      cycleReason = 'exception'
    } finally {
      // Stop lock renewal timer
      if (lockGuard.renewTimer) clearInterval(lockGuard.renewTimer)
      if (previousOnProviderRequest) resolvedConfig._onProviderRequest = previousOnProviderRequest
      else delete resolvedConfig._onProviderRequest
      // A successful cycle receives the full configured interval after all
      // inference, persistence and delivery work has completed. Model runtime
      // must not consume any part of the interval before the next cycle.
      const finalizedAtMs = Date.now()
      const cooldownSecs = cycleStatus === 'success'
        ? completionIntervalCooldownSeconds(st.intervalMinutes, finalizedAtMs)
        : failedCycleCooldownSeconds(st.intervalMinutes, cycleReason, st._consecutiveModelFailures, providerRequestStarted)
      const recoveryDeadlineMs = finalizedAtMs + cooldownSecs * 1000
      schedulerNextRun(st, cooldownSecs, finalizedAtMs)
      const finalized = await finalizeLock(key, lockToken, cooldownSecs)
      if (!finalized) {
        st.waitReason = 'finalize_failed'
        st.lastError = 'finalize_failed'
        st._recoveryDeadlineMs = recoveryDeadlineMs
      }
      st._lockToken = null
      st._lockGuard = null
      cycleSnapshot = {
        cycleId: st.cycleId,
        progressSeq: st.progressSeq,
        progressPercent: st.progressPercent,
        nextRunInSeconds: cooldownSecs,
        nextRunAtUtc: st.nextRunAtUtc,
      }
      st.inFlight = false
      st.stage = 'idle'
      st.stageLabel = ''
      st.progressPercent = 0
      st.cycleId = ''
      st.cycleStartedAt = ''
      st.stageUpdatedAt = ''
      await updateSchedulerRedisState(key, st)
    }

    // Broadcast progress done
    broadcastAutoProgressDone(promptTypeId, symbol, cycleStatus, cycleReason, cycleSnapshot)

    // Schedule next tick (Fix 1+3: finalize failure → recovery, not blind retry)
    if (autoSchedulerState[key]?.running) {
      if (st.waitReason === 'finalize_failed') {
        const recoveryState = st
        const isCurrent = () => autoSchedulerState[key] === recoveryState && recoveryState.running
        const scheduleRecovery = (fn, delayMs) => {
          if (isCurrent()) recoveryState._recoveryTimer = setTimeout(fn, delayMs)
        }
        const resumeNormalTick = async () => {
          if (!isCurrent()) return
          recoveryState._recoveryTimer = null
          recoveryState._recoveryDeadlineMs = null
          recoveryState.waitReason = ''
          recoveryState.lastError = ''
          schedulerNextRun(recoveryState, 0)
          await updateSchedulerRedisState(key, recoveryState)
          if (isCurrent()) scheduleTick(0)
        }
        // Recovery polls Redis state only. It resumes normal tick after the
        // original post-completion cooldown deadline instead of extending it.
        const _recoveryFn = async () => {
          if (!isCurrent()) return
          const redis = getRedis()
          if (!redis || !isRedisAvailable()) {
            scheduleRecovery(_recoveryFn, 15000)
            return
          }
          try {
            const lockVal = await redis.get(`${REDIS_LOCK_PREFIX}${key}`)
            if (!isCurrent()) return
            if (lockVal && lockVal !== lockToken) {
              const ttl = await redis.ttl(`${REDIS_LOCK_PREFIX}${key}`)
              if (!isCurrent()) return
              schedulerNextRun(recoveryState, ttl > 0 ? ttl : 15)
              await updateSchedulerRedisState(key, recoveryState)
              scheduleRecovery(_recoveryFn, 15000)
              return
            }
            const cooldownTtl = await redis.ttl(`${REDIS_COOLDOWN_PREFIX}${key}`)
            if (!isCurrent()) return
            if (cooldownTtl > 0) {
              recoveryState.waitReason = 'cooldown_recovered'
              schedulerNextRun(recoveryState, cooldownTtl)
              await updateSchedulerRedisState(key, recoveryState)
              scheduleRecovery(_recoveryFn, Math.min(cooldownTtl * 1000, 30000))
              return
            }

            const remainingSeconds = calculateRecoverySeconds(recoveryState._recoveryDeadlineMs)
            if (remainingSeconds > 0) {
              const wrote = await redis.set(`${REDIS_COOLDOWN_PREFIX}${key}`, '1', 'EX', remainingSeconds, 'NX')
              if (!isCurrent()) return
              if (!wrote) {
                const racedTtl = await redis.ttl(`${REDIS_COOLDOWN_PREFIX}${key}`)
                if (!isCurrent()) return
                if (racedTtl <= 0) throw new Error('cooldown recovery write was not confirmed')
              }
              recoveryState.waitReason = 'cooldown_recovered'
              schedulerNextRun(recoveryState, remainingSeconds)
              await updateSchedulerRedisState(key, recoveryState)
              scheduleRecovery(_recoveryFn, Math.min(remainingSeconds * 1000, 30000))
              return
            }

            // The original cooldown has elapsed. Remove only our stale lock,
            // then return to the normal lock-acquiring tick.
            if (lockVal === lockToken) {
              const released = await finalizeLock(key, lockToken, 0)
              if (!isCurrent()) return
              if (!released) {
                scheduleRecovery(_recoveryFn, 15000)
                return
              }
            }
            await resumeNormalTick()
          } catch (e) {
            console.error(`[UnifiedScheduler] ${key} recovery check error:`, e.message)
            scheduleRecovery(_recoveryFn, 15000)
          }
        }
        scheduleRecovery(_recoveryFn, 10000)
      } else {
        const delay = cycleStatus === 'success' ? tickIntervalMs
          : retryDelayMs(cycleReason, st._consecutiveModelFailures)
        scheduleTick(delay)
      }
    }
  }

  const tick = () => {
    const state = autoSchedulerState[key]
    if (!state?.running) return Promise.resolve({ skipped:'stopped' })
    if (state._tickPromise) {
      recordSchedulerOverlap(key, state)
      return state._tickPromise
    }
    const promise = Promise.resolve().then(runTick)
    state._tickPromise = promise
    promise.finally(() => {
      if (state._tickPromise === promise) state._tickPromise = null
    }).catch(() => {})
    return promise
  }

  scheduleTick(tickIntervalMs)
}

async function stopUnifiedScheduler(promptTypeId, symbol) {
  const key = buildSchedulerKey(promptTypeId, symbol)
  const state = autoSchedulerState[key]
  if (state?.timer) clearTimeout(state.timer)
  if (state?._lockGuard?.renewTimer) clearInterval(state._lockGuard.renewTimer)
  if (state?._recoveryTimer) clearTimeout(state._recoveryTimer)
  if (state) {
    state.running = false
    state.stopRequested = true
    // A stop can happen while the current tick is awaiting DB/Bridge work.
    // Keep its state object until the Promise settles so late continuations
    // cannot accidentally start a new timer against an undefined entry.
    const pending = state._tickPromise
    const cleanup = () => {
      if (autoSchedulerState[key] === state && !state._tickPromise) delete autoSchedulerState[key]
    }
    if (pending) pending.then(cleanup, cleanup)
    else cleanup()
  }
  console.log(`[UnifiedScheduler] Stopped ${key}`)
  await updateSchedulerRedisState(key, { running: false, intervalMinutes: 0, subscriberCount: 0, lastError: '', lastRunAt: '' })
}

// === Unified Auto Cycle: shared signal generation ===
async function runUnifiedAutoCycle(promptTypeId, symbol, lockGuard, preflight = {}) {
  const key = buildSchedulerKey(promptTypeId, symbol)
  const ts = () => new Date().toISOString()
  const l = (msg) => console.log(`[UnifiedCycle ${key}] ${ts()} ${symbol}: ${msg}`)
  const cycleId = String(preflight.cycleId || `${key}:${Date.now()}`)
  const cycleStartedAtMs = Number(preflight.cycleStartedAtMs) || Date.now()
  const intervalMinutes = Math.max(1, Number(preflight.intervalMinutes) || 5)
  let modelTaskTracker = null
  let modelTaskSettled = false
  let cycleError = null
  let previousOnProviderRequest = null
  let previousOnProviderUsage = null
  let previousOnProviderActivity = null
  let previousOnProviderQuiet = null
  let previousOnInferencePrepared = null
  let previousAbortSignal = null
  // The observer source is resolved while building the platform market
  // snapshot and reused after model inference for the direction interlock.
  // Keep it in the unified-cycle scope; task-fence assertions must not own
  // or shadow this value.
  let platformReferenceSource = null
  const finishModelTaskAfterSignalGate = async (type, reason) => {
    if (modelTaskSettled || !modelTaskTracker) return
    try {
      if (type === 'stale') await modelTaskTracker.completedStale(reason)
      else await modelTaskTracker.completedRejected(reason)
      modelTaskSettled = true
    } catch (error) {
      console.error(`[ModelTask] terminal gate transition failed (${reason}):`, error.message)
    }
  }

  l('>>> cycle start')
  await broadcastAutoProgress(promptTypeId, symbol, { stage: 'config', label: '检查策略与模型', progress_percent: 6 })

  // 1. Read prompt type
  const pt = Number(preflight.strategy?.id) === Number(promptTypeId)
    ? preflight.strategy
    : await getAutoPromptTypeById(promptTypeId)
  if (!pt || !pt.is_active) { l('BLOCKED: prompt type not found or disabled'); return { status: 'blocked', reason: 'strategy_disabled' } }
  const supportedSymbols = parsePromptSymbols(pt.symbols_json)
  if (!supportedSymbols.includes(symbol.toUpperCase())) { l(`BLOCKED: symbol ${symbol} not in strategy symbols`); return { status: 'blocked', reason: 'symbol_not_supported' } }

  const isPrivate = pt.scope === 'private'
  const preflightUserId = Number(preflight.inferenceUserId)
  const fallbackBridge = preflightUserId > 0 ? null : await resolveStrategyMarketBridge(pt)
  const inferenceUserId = preflightUserId > 0
    ? preflightUserId
    : Number(fallbackBridge?.userId || 0)
  const signalSource = isPrivate ? 'auto_private' : 'auto_shared'
  if (!inferenceUserId || !isBridgeAlive(inferenceUserId)) {
    return { status: 'blocked', reason: isPrivate ? 'owner_bridge_offline' : 'admin_bridge_offline' }
  }
  const inferenceWeeklyWindow = () => bridgeWeeklyWindow(
    inferenceUserId, fallbackBridge?.source?.trading_account_id)
  if (inferenceWeeklyWindow()) return { status:'blocked', reason:'weekly_flatten_window' }
  // 2. Resolve platform-primary or private owner model without runtime fallback.
  let config = preflight.config || null
  if (!config) {
    try {
      config = await getUnifiedAutoInferenceConfig(promptTypeId, isPrivate ? inferenceUserId : null)
    } catch (error) {
      l(`BLOCKED: model resolution failed (${error.message})`)
      return { status: 'blocked', reason: error.message || 'no_model_configured' }
    }
  }
  if (!config || !config.api_key_encrypted) {
    l(`BLOCKED: no API key (hasKey=${!!config?.api_key_encrypted})`)
    return { status: 'blocked', reason: 'no_api_key' }
  }

  // Usage belongs to the private owner. Platform inference remains user 0 and
  // only uses the admin connection as a market-data transport.
  config._userId = isPrivate ? inferenceUserId : 0

  try {
    const includePortfolioContext = isPrivate && Boolean(config._include_portfolio_context)
    await broadcastAutoProgress(promptTypeId, symbol, { stage: 'bridge', label: includePortfolioContext ? '获取持仓、挂单与行情数据' : '获取平台行情数据', progress_percent: 16 })
    const t0 = Date.now()
    let account = null
    let positions = []
    let pendingOrders = []
    if (includePortfolioContext) {
      try {
        const portfolio = await loadPrivatePortfolioContext(inferenceUserId)
        positions = portfolio.positions
        pendingOrders = portfolio.pendingOrders
      } catch (error) {
        l(`BLOCKED: private portfolio context unavailable (${error.message})`)
        return { status: 'blocked', reason: 'private_portfolio_context_unavailable' }
      }
    }
    l(`bridge done (${Date.now()-t0}ms, positions=${positions.length}, pending=${pendingOrders.length})`)

    const prompt = config.system_prompt || ''
    const tags = Array.isArray(config._market_data_plan?.timeframes) && config._market_data_plan.timeframes.length
      ? config._market_data_plan.timeframes.map(item => ({ tf: item.timeframe, count: item.kline_count }))
      : [{ tf: 'M30', count: 100 }]
    const primaryTf = tags.length > 0 ? tags[0].tf : 'M5'
    const usedTimeframes = tags.length > 0 ? tags.map(t => t.tf) : ['M5']
    const primaryCount = tags.length > 0 ? tags[0].count : 100
    const useChanAnalysis = Boolean(config._use_chan_analysis)
    const primaryHistoryCount = resolveChanHistoryCount(inferenceUserId, symbol, primaryTf, primaryCount, useChanAnalysis)
    const t1 = Date.now()
    const ratesResp = await platformRates(inferenceUserId, { symbol, timeframe: primaryTf, count: primaryHistoryCount })
    if (!ratesResp || ratesResp.status === 'error') { l(`BLOCKED: rates failed`); return { status: 'blocked', reason: 'rates_failed' } }
    const rates = ratesResp.rates || []
    if (!Array.isArray(rates) || rates.length === 0) { l(`BLOCKED: rates empty`); return { status: 'blocked', reason: 'rates_empty' } }
    l(`rates done (${Date.now()-t1}ms, bars=${rates.length}, tf=${primaryTf})`)

    await broadcastAutoProgress(promptTypeId, symbol, { stage: 'market', label: '计算指标与市场结构', progress_percent: 31 })
    const t2 = Date.now()
    let market = calculateMarketData(symbol, primaryTf, rates.slice(-primaryCount), account, positions, { pending_orders: pendingOrders })
    const declaredPolicy = config._strategy_policy?.policyMode === 'off' ? null : config._strategy_policy?.compiledPolicy
    market.strategy_context = await buildStrategyContextFromTags(inferenceUserId, symbol, account, positions, prompt, primaryTf, rates, 'auto', config._market_data_plan, useChanAnalysis, ratesResp.market_meta, declaredPolicy)
    const strategyDataRuntime = prepareStrategyDataRuntime(config._strategy_policy, market.strategy_context, {
      rawPolicy:config._strategy_policy?.strategyPolicy,
    })
    if (strategyDataRuntime?.indicators) market.strategy_context.indicators = strategyDataRuntime.indicators
    if (useChanAnalysis) market.chan = market.strategy_context?.timeframes?.[primaryTf]?.summary?.chan
    market.primary_timeframe = primaryTf
    await attachAtrAnchor(inferenceUserId, symbol, market, primaryTf)
    market.requested_timeframes = market.strategy_context.required_timeframes || usedTimeframes
    market.used_timeframes = market.strategy_context.used_timeframes || Object.keys(market.strategy_context?.timeframes || {})
    market.missing_timeframes = market.strategy_context.missing_timeframes || market.requested_timeframes.filter(tf => !market.used_timeframes.includes(tf))
    if (!isPrivate) {
      platformReferenceSource = await getObserverSourceForStrategy(promptTypeId)
      if (platformReferenceSource && Number(platformReferenceSource.bridge_user_id) === Number(inferenceUserId)) {
        try {
          market.strategy_reference_portfolio = await loadPlatformReferencePortfolio({
            strategyId:promptTypeId, sourceUserId:inferenceUserId, symbol,
          })
        } catch (error) {
          l(`reference portfolio unavailable (${error.message})`)
          market.strategy_reference_portfolio = {
            role:'platform_strategy_reference_portfolio', strategy_id:Number(promptTypeId),
            symbol:stripBrokerSuffix(symbol).toUpperCase(), status:'unavailable',
            positions:[], pending_orders:[], position_count:0, pending_count:0,
          }
        }
      }
    }
    if (!includePortfolioContext) {
      market = buildSharedMarketSnapshot(market, {
        standardSymbol: symbol,
        volumeMin: config._ai_volume_min,
        volumeMax: config._ai_volume_max,
        volumeStep: config._ai_volume_step,
        marketSource: ratesResp.market_meta?.source || 'platform_admin_bridge',
      })
    }
    let positionManagementContext = null
    try {
      positionManagementContext = await loadActivePositionManagementContext({
        strategyId:promptTypeId,
        strategyVersion:Number(pt.version || 1),
        strategyScope:pt.scope || 'platform',
        ownerUserId:isPrivate ? inferenceUserId : 0,
        symbol,
        market,
        decisionTimeframe:primaryTf,
      })
      if (hasActivePositionManagementGroups(positionManagementContext)
        && positionManagementContext.as_of.closed_bar_time_utc_ms) {
        config._positionManagementContext = positionManagementContext
      }
    } catch (error) {
      l(`position management context unavailable; new signal inference continues (${error.message})`)
    }
    l(`market calc done (${Date.now()-t2}ms, price=${market.latest_price})`)

    let memory = { contentText:'', versionNo:0, contentHash:null, library:null, logId:null }
    try {
      const resolvedMemory = await getStrategyMemoryLibraryForRuntime({ strategyId:promptTypeId,
        userId:inferenceUserId, role:'user' })
      const library = resolvedMemory.library
      memory = { contentText:library.content_text || '', versionNo:Number(library.version_no || 0),
        contentHash:library.content_hash || null, library, logId:null }
    } catch (error) {
      l(`strategy memory library unavailable; inference cancelled (${error.message})`)
      throw Object.assign(new Error('strategy_memory_library_unavailable'), { cause:error })
    }
    config._strategyMemoryLibraryContext = memory.contentText
    config._strategyMemoryLibraryVersion = memory.versionNo
    config._strategyMemoryLibraryHash = memory.contentHash
    config._memoryMode = 'strategy_library'
    config._experienceSelection = { source:'strategy_library', selectedItemIds:[], selectedRefs:[], selectionDetails:[] }

    // Enforce mode: create one durable envelope before the first provider
    // callback.  The task freezes the cycle inputs and is also the fencing
    // token used by the signal application transaction.
    const taskDeadlineAtUtcMsc = modelTaskDeadlines('auto_inference', {
      nowUtcMs:cycleStartedAtMs,
    }).taskDeadlineUtcMs
    const resultValidUntilUtcMsc = Math.min(
      cycleStartedAtMs + Math.max(1, Number(signalTtlSeconds(primaryTf)) || 120) * 1000,
      taskDeadlineAtUtcMsc,
    )
    const modelTaskInput = buildAutoModelTaskInput({
      promptTypeId, symbol, cycleId, cycleStartedAtMs, strategy:pt, config,
      market, marketMeta:ratesResp.market_meta, primaryTimeframe:primaryTf,
      intervalMinutes, resultValidUntilUtcMsc, taskDeadlineAtUtcMsc,
      strategyDataRuntime,
    })
    const createTracker = getAutoModelTaskTrackerFactory()
    modelTaskTracker = await createTracker(modelTaskInput, {
      workerId:`auto:${process.pid}:${cycleId}`,
    })
    if (!modelTaskTracker?.active || !modelTaskTracker.taskId) {
      const error = new Error('model_task_tracker_inactive')
      error.code = 'model_task_tracker_inactive'
      throw error
    }
    try {
      const injection = await createStrategyMemoryInjectionLog({ strategyId:promptTypeId,
        actor:{ userId:inferenceUserId, role:'user' }, library:memory.library,
        injectionKind:'auto_inference', modelTaskId:modelTaskTracker.taskId })
      memory.logId = injection.id
    } catch (error) {
      l(`strategy memory attribution unavailable; inference cancelled (${error.message})`)
      throw Object.assign(new Error('strategy_memory_injection_attribution_failed'), { cause:error })
    }
    config._modelTaskId = modelTaskTracker.taskId
    config._taskDeadlineAtUtcMs = taskDeadlineAtUtcMsc
    config._resultValidUntilUtcMs = resultValidUntilUtcMsc
    config._followupValidUntilUtcMs = taskDeadlineAtUtcMsc
    previousOnProviderRequest = config._onProviderRequest
    previousOnProviderUsage = config._onProviderUsage
    previousOnProviderActivity = config._onProviderActivity
    previousOnProviderQuiet = config._onProviderQuiet
    previousOnInferencePrepared = config._onInferencePrepared
    previousAbortSignal = config._abortSignal || null
    if (modelTaskTracker.signal) {
      config._abortSignal = previousAbortSignal
        ? AbortSignal.any([previousAbortSignal, modelTaskTracker.signal])
        : modelTaskTracker.signal
    }
    let providerRequestCount = 0
    config._onProviderRequest = async event => {
      providerRequestCount += 1
      const previousProviderState = modelTaskTracker.providerRequestState
      const controlledRepair = providerRequestCount === 2 && previousProviderState?.responseReceived === true
      if (providerRequestCount > 1 && !controlledRepair) {
        const error = new Error('auto_inference_duplicate_provider_request')
        error.code = 'auto_inference_duplicate_provider_request'
        await modelTaskTracker.failed(error, true)
        throw error
      }
      if (typeof previousOnProviderRequest === 'function') await previousOnProviderRequest(event)
      await modelTaskTracker.onProviderRequest({ ...event, cycleId })
    }
    config._onProviderUsage = async event => {
      if (typeof previousOnProviderUsage === 'function') await previousOnProviderUsage(event)
      await modelTaskTracker.onProviderUsage({ ...event, cycleId })
    }
    config._onProviderActivity = async event => {
      if (typeof previousOnProviderActivity === 'function') await previousOnProviderActivity(event)
      await modelTaskTracker.onProviderActivity({ ...event, cycleId })
    }
    config._onProviderQuiet = async event => {
      if (typeof previousOnProviderQuiet === 'function') await previousOnProviderQuiet(event)
      await modelTaskTracker.onProviderQuiet({ ...event, cycleId })
    }

    await broadcastAutoProgress(promptTypeId, symbol, { stage: 'ai', label: 'AI 模型深度推理', progress_percent: 46 })
    const t3 = Date.now()
    l(`calling AI (model=${config.model_name}, thinking=${config.thinking_enabled !== false}, effort=${config.reasoning_effort || 'max'})...`)
    let renderedEvidence = null
    config._onInferencePrepared = async evidence => {
      renderedEvidence = evidence
      await previousOnInferencePrepared?.(evidence)
      await modelTaskTracker.persistBudget(evidence?.modelTaskBudget)
    }
    let signal = await maybeAiSignal(null, config, market)
    if (previousOnInferencePrepared) config._onInferencePrepared = previousOnInferencePrepared
    else delete config._onInferencePrepared
    market.inference_source = signal._inference_source || 'unknown'
    const aiSource = signal._inference_source
    const modelSignalType = signal.signal_type
    delete signal._inference_source
    const executionWindowExpired = Date.now() > resultValidUntilUtcMsc
    signal.execution_valid_until_utc_msc = resultValidUntilUtcMsc
    l(`AI done (${Date.now()-t3}ms, type=${signal.signal_type}, confidence=${signal.confidence}, source=${aiSource})`)
    if (aiSource === 'ai_error_hold') {
      l(`BLOCKED: AI inference failed (${signal.reasoning || 'unknown error'})`)
      await modelTaskTracker.failed({ code:'ai_failed', message:signal.reasoning || 'ai_failed' }, true)
      modelTaskSettled = true
      await insertAudit(null, isPrivate ? inferenceUserId : 0, 'ai_auto_scan', symbol,
        { trigger: 'timer', prompt_type_id: promptTypeId, symbol, timeframe: primaryTf },
        { status: 'error', reason: 'ai_failed', message: signal.reasoning || '' }, 'error')
      return { status: 'blocked', reason: 'ai_failed' }
    }

    if (!isPrivate) {
      const interlockResult = await enforcePlatformStrategyDirectionInterlock({
        signal, market, strategyId:promptTypeId, inferenceUserId, symbol,
        referenceSource:platformReferenceSource,
      })
      signal = interlockResult.signal
      if (interlockResult.resolution?.refresh_error) {
        l(`strategy direction interlock refresh failed (${interlockResult.resolution.refresh_error})`)
      }
      if (interlockResult.resolution?.allowed === false) {
        l(`strategy direction interlock blocked new entry (${interlockResult.resolution.reason_code})`)
      }
    }

    signal.decision_diagnostics = buildDecisionDiagnostics({ signal, market, modelSignalType })

    await modelTaskTracker.resultReady({
      resultHash:sha256(JSON.stringify(signal)),
      resultRef:`auto_inference:${cycleId}`,
    })

    // An inference started before the terminal risk window must not persist,
    // broadcast or execute after that terminal window begins.
    // after the weekly flatten window begins.
    if (inferenceWeeklyWindow()) {
      l('BLOCKED: weekly flatten window began during inference')
      await modelTaskTracker.completedStale('weekly_flatten_window')
      modelTaskSettled = true
      return { status: 'blocked', reason: 'weekly_flatten_window' }
    }

    // Freeze the subscriber set before atomically writing the shared signal
    // and all per-user deliveries.
    const executionValidation = readExecutionValidation(signal)
    const st = autoSchedulerState[key]
    // Persist and publish every successful model conclusion to the frozen
    // subscriber set.  Execution eligibility is an independent fail-closed
    // gate; it must not make an otherwise visible signal disappear from the
    // subscriber's history.
    const allSubscribers = st?.subscribers || new Set()
    if (executionValidation.validation.eligible !== true) {
      l(`execution validation blocked shared delivery (${executionValidation.validation.status})`)
    }
    const onlineSubscribers = new Set()
    for (const uid of allSubscribers) {
      if (isBridgeAlive(uid)) onlineSubscribers.add(uid)
    }

    // 4. Write shared signal and deliveries in one transaction.
    const applyGate = await assertAutoInferenceApplyGate({
      tracker:modelTaskTracker, lockGuard, promptTypeId, strategy:pt,
      cycleId, key, taskDeadlineAtUtcMsc, marketMeta:ratesResp.market_meta,
      phase:'signal_write', config, frozenModel:modelTaskInput,
    })
    if (!applyGate.allowed) {
      l(`BLOCKED: model task apply gate (${applyGate.reason})`)
      if (applyGate.type === 'stale') await modelTaskTracker.completedStale(applyGate.reason)
      else await modelTaskTracker.completedRejected(applyGate.reason)
      modelTaskSettled = true
      return { status:'blocked', reason:applyGate.reason }
    }
    await modelTaskTracker.applying()
    const createdAt = beijingNow()
    const createdAtUtcMsc = Date.now()
    const marketClock = trustedTerminalClock(ratesResp.market_meta || {}) ? ratesResp.market_meta : null
    const terminalOffsetMinutes = marketClock ? Math.trunc(Number(marketClock.timezone_offset_minutes)) : null
    const terminalClockStatus = marketClock ? String(marketClock.clock_status || '').trim().toLowerCase() : null
    const terminalClockSource = marketClock ? String(marketClock.clock_source || marketClock.source || 'market_snapshot') : null
    const marketJson = JSON.stringify(market)
    const decision = normalizeDecisionFields(signal)
    const decisionJson = JSON.stringify(decision)
    const tokenCount = Math.round(((signal.analysis || '').length + (signal.reasoning || '').length + marketJson.length) / 4)
    await broadcastAutoProgress(promptTypeId, symbol, { stage: 'persist', label: '校验并保存推理结果', progress_percent: 84 })
    const persisted = await withTransaction(async run => {
      if (typeof modelTaskTracker.assertOwnedTx === 'function') {
        await modelTaskTracker.assertOwnedTx(run)
        const taskResult = await run(`SELECT task_deadline_at_utc_msc
          FROM ai_model_tasks WHERE task_id = ? FOR UPDATE`, [modelTaskTracker.taskId])
        const taskRows = Array.isArray(taskResult?.[0]) ? taskResult[0]
          : (Array.isArray(taskResult) ? taskResult : [])
        if (!taskRows?.[0] || Number(taskRows[0].task_deadline_at_utc_msc) < Date.now()) {
          throw new Error('model_task_deadline_exceeded')
        }
      } else {
        const rows = await run(`SELECT task_id, status, lease_token, fencing_token,
            task_deadline_at_utc_msc FROM ai_model_tasks WHERE task_id = ? FOR UPDATE`, [modelTaskTracker.taskId])
        const taskRow = Array.isArray(rows?.[0]) ? rows[0][0] : rows?.[0]
        if (!taskRow || taskRow.status !== 'applying' || Number(taskRow.task_deadline_at_utc_msc) < Date.now()) {
          throw new Error('model_task_fence_lost')
        }
      }
      const [signalResult] = await run(`
        INSERT INTO ai_signals(user_id, config_id, prompt_type_id, session_id, source, symbol, timeframe, signal_type, confidence,
          recommended_volume, position_size_tier, position_size_factor, position_size_reason,
          analysis, reasoning, stop_loss_price, take_profit_1_price,
          take_profit_2_price, take_profit_3_price, recommended_take_profit_tier, market_data_json, token_count, ai_model, ttl_seconds, is_executed, created_at,
          created_at_utc_msc, terminal_timezone_offset_minutes, terminal_clock_status, terminal_clock_source,
          entry_method, limit_price, stop_limit_price, pending_valid_until, schema_version, decision_json, inference_task_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        isPrivate ? inferenceUserId : 0, 0, promptTypeId, signalSource, signalSource, symbol, primaryTf,
        signal.signal_type, signal.confidence, signal.recommended_volume,
        signal.position_size_tier || null, signal.position_size_factor ?? null, signal.position_size_reason || null,
        signal.analysis, signal.reasoning, signal.stop_loss_price,
        signal.take_profit_1_price, signal.take_profit_2_price, signal.take_profit_3_price, signal.recommended_take_profit_tier || null,
        marketJson, tokenCount, config.model_name || 'deepseek-chat', signalTtlSeconds(primaryTf), createdAt,
        createdAtUtcMsc, terminalOffsetMinutes, terminalClockStatus, terminalClockSource,
        signal.entry_method || 'market', signal.limit_price || null, signal.stop_limit_price || null, signal.pending_valid_until || null,
        SIGNAL_SCHEMA_VERSION, decisionJson, modelTaskTracker.taskId
      ])
      const insertedSignalId = signalResult.insertId
      if (!renderedEvidence) throw new Error('inference_evidence_missing')
      const snapshotId = await persistInferenceSnapshotTx(run, {
        signalId: insertedSignalId,
        strategyId: promptTypeId,
        strategyVersion: Number(pt.version || 1),
        strategyScope: pt.scope || 'platform',
        ownerUserId: isPrivate ? inferenceUserId : 0,
        standardSymbol: stripBrokerSuffix(symbol).toUpperCase(),
        marketSource: ratesResp.market_meta?.source || 'platform_admin_bridge',
        systemPrompt: renderedEvidence.systemPrompt,
        userPrompt: renderedEvidence.userPrompt,
        outputSchemaVersion: renderedEvidence.outputSchemaVersion,
        marketSnapshot: market,
        modelProfileId: config._model_profile_id,
        provider: config.api_provider,
        modelName: config.model_name,
        credentialSource: config._credential_source,
        memoryMode:'strategy_library',
        strategyRuntime:buildStrategyRuntimeSnapshot({ strategy:pt, policy:config._strategy_policy || {
          marketDataPlan:config._market_data_plan, entryMethods:config._allowed_entry_methods,
          useChanAnalysis:config._use_chan_analysis, policyMode:'off', compiledPolicy:null,
        }, strategyDataRuntime, source:'automatic' }),
        createdAt,
      })
      await createTradeThesisTx(run, {
        signalId:insertedSignalId,
        strategyId:promptTypeId,
        strategyVersion:Number(pt.version || 1),
        strategyScope:pt.scope || 'platform',
        ownerUserId:isPrivate ? inferenceUserId : 0,
        signal:{ ...signal, symbol },
        market,
        decisionTimeframe:primaryTf,
        modelProfileId:config._model_profile_id,
        modelName:config.model_name,
      })
      const deliveryValues = []
      const deliveryParams = []
      for (const delivery of buildSignalDeliveryRows({
        signalId:insertedSignalId,
        userIds:allSubscribers,
        onlineUserIds:onlineSubscribers,
        promptTypeId,
        symbol,
        createdAt,
        signalType:signal.signal_type,
        pendingAction:signal.pending_action,
        executionValidation:readExecutionValidation(signal),
        executionExpired:executionWindowExpired,
      })) {
        deliveryValues.push('(?, ?, ?, ?, ?, ?, ?, ?, ?)')
        deliveryParams.push(delivery.signalId, delivery.userId, delivery.promptTypeId, delivery.symbol,
          delivery.deliveryStatus, delivery.executionStatus, delivery.executionResult, 0, delivery.createdAt)
      }
      if (deliveryValues.length > 0) {
        await run(
          `INSERT INTO auto_signal_deliveries (signal_id, user_id, prompt_type_id, symbol, delivery_status, execution_status, execution_result, is_executed, created_at)
           VALUES ${deliveryValues.join(',')}`,
          deliveryParams
        )
      }
      return { signalId:insertedSignalId, snapshotId }
    })
    const signalId = persisted.signalId
    const snapshotId = persisted.snapshotId
    signal.id = signalId
    if (!executionWindowExpired && signal._position_management && positionManagementContext) {
      try {
        await persistPositionManagementEvaluations({
          signalId,
          context:positionManagementContext,
          management:signal._position_management,
          inferenceSource:'automatic_scheduler',
          synchronousPendingCancelGroupIds:synchronousPendingCancelGroupIds(signal),
        })
      } catch (error) {
        l(`position management task persistence failed (${error.message})`)
        await insertAudit(null, isPrivate ? inferenceUserId : 0, 'position_management_persist_failed', symbol,
          { signal_id:signalId, prompt_type_id:promptTypeId },
          { status:'error', message:error.message }, 'error')
      }
    }
    if (memory.logId) try {
      await updateStrategyMemoryInjectionLog(memory.logId, { signalId, inferenceSnapshotId:snapshotId,
        modelTaskId:modelTaskTracker?.taskId || null })
    } catch (error) { l(`strategy memory attribution failed (${error.message})`) }
    signal.symbol = symbol
    signal.timeframe = primaryTf
    signal.created_at = createdAt
    signal.created_at_utc_msc = createdAtUtcMsc
    signal.terminal_timezone_offset_minutes = terminalOffsetMinutes
    signal.terminal_clock_status = terminalClockStatus
    signal.terminal_clock_source = terminalClockSource
    signal.market_data = market
    signal.is_executed = false
    signal.config_id = 0
    signal.session_id = signalSource
    signal.source = signalSource
    signal = attachSignalPresentation({ ...signal, ...decision, decision_json: decisionJson })
    signal.prompt_type_id = promptTypeId
    signal.ai_model = config.model_name || 'deepseek-chat'
    attachSignalTiming(signal)
    l(`shared signal #${signalId} saved`)

    if (inferenceWeeklyWindow()) {
      l('BLOCKED: weekly flatten window began before signal delivery')
      await discardSharedSignalForWeeklyWindow(signalId)
      await finishModelTaskAfterSignalGate('stale', 'weekly_flatten_window')
      return { status: 'blocked', reason: 'weekly_flatten_window' }
    }
    if (!(await assertAutoInferenceBusinessGate({
      tracker:modelTaskTracker, lockGuard, resultValidUntilUtcMsc, phase:'delivery_publish',
      requireFreshResult:false,
    }))) {
      l('BLOCKED: model task/lock gate before signal publish')
      await finishModelTaskAfterSignalGate('rejected', 'model_task_business_gate_failed')
      return { status:'error', reason:'model_task_business_gate_failed' }
    }

    await broadcastAutoProgress(promptTypeId, symbol, { stage: 'publish', label: '发布信号与执行建议', progress_percent: 94 })
    // 7. Notify online subscribers
    for (const uid of onlineSubscribers) {
      if (inferenceWeeklyWindow()) {
        l('BLOCKED: weekly flatten window began during signal delivery')
        await finishModelTaskAfterSignalGate('stale', 'weekly_flatten_window')
        return { status: 'blocked', reason: 'weekly_flatten_window' }
      }
      if (!(await assertAutoInferenceBusinessGate({
        tracker:modelTaskTracker, lockGuard, resultValidUntilUtcMsc, phase:'delivery_user',
        requireFreshResult:false,
      }))) {
        l('BLOCKED: model task/lock gate before subscriber delivery')
        await finishModelTaskAfterSignalGate('rejected', 'model_task_business_gate_failed')
        return { status:'error', reason:'model_task_business_gate_failed' }
      }
      sendToBrowsers(uid, {
        type: 'new_signal',
        signal_id: signalId,
        signal_type: signal.signal_type,
        symbol,
        timeframe: primaryTf,
        confidence: signal.confidence,
        created_at: createdAt,
        source: 'auto_shared',
        prompt_type_id: promptTypeId,
      })
    }
    broadcastAdminEvent('ai', 'new_signal', {
      signal_id:Number(signalId),
      prompt_type_id:Number(promptTypeId),
      symbol:String(symbol || ''),
      timeframe:primaryTf || null,
      confidence:signal.confidence ?? null,
      subscribers_count:allSubscribers.size,
      online_subscribers_count:onlineSubscribers.size,
    }, { scopes:['overview', 'ai-operations', 'risk-audit'], refresh:true })
    await broadcastAutoProgress(promptTypeId, symbol, { stage: 'delivery', label: '同步信号与执行状态', progress_percent: 96 })

    // 7.5 Re-check global safety boundaries before per-user delivery.
    if (inferenceWeeklyWindow()) {
      l('BLOCKED: weekly flatten window began before delivery')
      await finishModelTaskAfterSignalGate('stale', 'weekly_flatten_window')
      return { status: 'blocked', reason: 'weekly_flatten_window' }
    }
    if (!(await assertAutoInferenceBusinessGate({
      tracker:modelTaskTracker, lockGuard, resultValidUntilUtcMsc, phase:'delivery',
      requireFreshResult:false,
    }))) {
      l('BLOCKED: model task/lock gate before delivery')
      await finishModelTaskAfterSignalGate('rejected', 'model_task_business_gate_failed')
      return { status:'error', reason:'model_task_business_gate_failed' }
    }

    // 8. Auto-trade for eligible subscribers (limited concurrency) (lock check)
    if (!executionWindowExpired && !(await assertAutoInferenceBusinessGate({
      tracker:modelTaskTracker, lockGuard, resultValidUntilUtcMsc, phase:'auto_trade',
    }))) {
      l('BLOCKED: model task/lock gate before auto-trade')
      await finishModelTaskAfterSignalGate('rejected', 'model_task_business_gate_failed')
      return { status:'error', reason:'model_task_business_gate_failed' }
    }
    if (executionValidation.validation.eligible === true
      && !executionWindowExpired && (signal.signal_type !== 'hold' || signal.pending_action === 'cancel')
      && aiSource === 'ai' && !signal.is_stale) {
      // Single JOIN query instead of N+1 per subscriber
      const onlineUserIds = [...onlineSubscribers]
      let eligibleSubs = []
      if (onlineUserIds.length > 0) {
        const placeholders = onlineUserIds.map(() => '?').join(',')
        const eligibleRows = await queryAll(`
          SELECT s.user_id, s.enable_auto_trade, s.prompt_type_id
          FROM auto_scheduler s
          JOIN users u ON u.id = s.user_id
          LEFT JOIN user_bridge_settings ubs ON ubs.user_id = s.user_id
          WHERE s.user_id IN (${placeholders})
            AND s.enabled = 1 AND s.enable_auto_trade = 1
            AND (u.role = 'admin' OR (u.plan = 'pro' AND (u.plan_expires_at IS NULL OR u.plan_expires_at >= NOW())))
            AND COALESCE(ubs.trade_send_enabled, 0) = 1
        `, onlineUserIds)
        const eligibleSet = new Set(eligibleRows.map(r => r.user_id))
        eligibleSubs = onlineUserIds.filter(uid => eligibleSet.has(uid) && isBridgeAlive(uid))
      }

      // Run with concurrency limit of 5
      const CONCURRENCY = 5
      for (let i = 0; i < eligibleSubs.length; i += CONCURRENCY) {
        const batch = eligibleSubs.slice(i, i + CONCURRENCY)
        await Promise.allSettled(batch.map(uid =>
          executeDelivery(uid, signalId, signal, config, market, promptTypeId, symbol, createdAt,
            lockGuard, modelTaskTracker, resultValidUntilUtcMsc, null, positionManagementContext)
        ))
      }
    }

    // Normal hold signals remain in signal history but do not create audit noise.
    if (signal.signal_type !== 'hold') {
      await insertAudit(null, isPrivate ? inferenceUserId : 0, 'ai_auto_scan', symbol, {
        trigger: 'timer', prompt_type_id: promptTypeId, symbol, timeframe: primaryTf, signal_id: signalId
      }, {
        status: 'success', signal_id: signalId, signal_type: signal.signal_type, confidence: signal.confidence,
        subscriber_count:allSubscribers.size, online_subscriber_count:onlineSubscribers.size, inference_source: aiSource,
      }, 'success')
    }
    await modelTaskTracker.succeeded({
      resultRef:`ai_signals:${signalId}`,
      resultHash:sha256(JSON.stringify({ signalId, cycleId })),
    })
    modelTaskSettled = true
    await broadcastAutoProgress(promptTypeId, symbol, { stage: 'complete', label: '推理结果已生成', progress_percent: 100 })
    l(`<<< cycle complete (signal=#${signalId}, subscribers=${allSubscribers.size}, online=${onlineSubscribers.size})`)
    return { status:'success', signalId, subscriberCount:allSubscribers.size,
      onlineSubscriberCount:onlineSubscribers.size, createdAt, executionExpired:executionWindowExpired }
  } catch (err) {
    cycleError = err
    l(`<<< EXCEPTION: ${err.message}`)
    console.error(`[UnifiedCycle] ${key} error:`, err.message)
    await insertAudit(null, isPrivate ? inferenceUserId : 0, 'ai_auto_scan', symbol, { prompt_type_id: promptTypeId, symbol }, { status: 'error', message: err.message }, 'error')
    return { status: 'error', reason: 'exception', message: err.message }
  } finally {
    if (modelTaskTracker && !modelTaskSettled) {
      try {
        const staleFailure = ['model_task_result_expired', 'model_task_fence_lost', 'terminal_clock_untrusted',
          'strategy_version_changed', 'auto_cycle_changed'].includes(String(cycleError?.code || cycleError?.message || ''))
        if (staleFailure) await modelTaskTracker.completedStale(String(cycleError?.code || cycleError?.message))
        else await modelTaskTracker.failed({ code:String(cycleError?.code || 'auto_inference_cycle_failed'), message:String(cycleError?.message || 'auto inference cycle failed') }, true)
        modelTaskSettled = true
      } catch (error) {
        console.error(`[ModelTask] failed transition for ${modelTaskTracker.taskId}:`, error.message)
      }
    }
    if (config) {
      if (previousOnProviderRequest) config._onProviderRequest = previousOnProviderRequest
      else delete config._onProviderRequest
      if (previousOnProviderUsage) config._onProviderUsage = previousOnProviderUsage
      else delete config._onProviderUsage
      if (previousOnProviderActivity) config._onProviderActivity = previousOnProviderActivity
      else delete config._onProviderActivity
      if (previousOnProviderQuiet) config._onProviderQuiet = previousOnProviderQuiet
      else delete config._onProviderQuiet
      if (previousOnInferencePrepared) config._onInferencePrepared = previousOnInferencePrepared
      else delete config._onInferencePrepared
      if (previousAbortSignal) config._abortSignal = previousAbortSignal
      else delete config._abortSignal
    }
    if (modelTaskTracker) await modelTaskTracker.stop().catch(error => {
      console.error(`[ModelTask] tracker stop failed for ${modelTaskTracker.taskId}:`, error.message)
    })
  }
}

// === Delivery execution for a single subscriber ===
async function executeDelivery(userId, signalId, signal, unifiedConfig, market, promptTypeId, symbol, createdAt,
  lockGuard, modelTaskTracker = null, resultValidUntilUtcMsc = null, recoveryContext = null,
  positionManagementContext = null) {
  const endDeliveryExecution = beginBridgeDeliveryExecution(userId)
  const l = (msg) => console.log(`[Delivery U${userId}] signal=${signalId} ${symbol}: ${msg}`)
  let inventoryLock = null
  let deliveryClaimed = false
  const setTerminalStatus = (status, reason, details = {}, outcome = null) => queryRun(
    `UPDATE auto_signal_deliveries SET execution_status = ?, execution_result = ?
     WHERE signal_id = ? AND user_id = ? AND execution_status = ?`,
    [status, JSON.stringify(outcome || { status, reason, details }), signalId, userId,
      deliveryClaimed ? 'executing' : 'not_attempted'])
  const finishBeforeRisk = async (status, reason, details = {}) => {
    const safe = buildSafeExecutionOutcome({ status, reason, details, stage:'portfolio_alignment', field:'execution' })
    await setTerminalStatus(safe.status, safe.reason, safe.details, safe)
    const action = safe.classification === 'risk_rejection' ? 'ai_auto_execute_rejected'
      : safe.status === 'success' ? 'ai_auto_execute' : 'ai_auto_execute_skipped'
    const severity = safe.classification === 'risk_rejection' ? 'warning' : safe.status === 'success' ? 'success' : 'info'
    try {
      await insertAudit(null, userId, action, symbol,
        { signal_id:signalId, delivery_signal_id:signalId, prompt_type_id:promptTypeId, stage:'portfolio_alignment', reason:safe.reason, details:safe.details },
        safe, severity)
    } catch (error) {
      l(`pre-risk audit failed: ${error.message}`)
    }
    sendToBrowsers(userId, buildSafeExecutionEvent(safe, { type:'signal_execution_updated', signal_id:signalId }))
  }
  try {
    const executionValidation = readExecutionValidation(signal)
    if (executionValidation.validation.eligible !== true) {
      const rejection = executionValidationRejection(executionValidation)
      await setTerminalStatus('skipped', rejection.reason, rejection.details, {
        ...rejection, status:'skipped', reason:rejection.reason,
      })
      await insertAudit(null, userId, 'ai_auto_execute_skipped', symbol,
        { signal_id:signalId, delivery_signal_id:signalId, prompt_type_id:promptTypeId,
          reason:rejection.reason, execution_validation:executionValidation.validation },
        { ...rejection, status:'skipped' }, 'info')
      sendToBrowsers(userId, { type:'signal_execution_updated', signal_id:signalId, status:'skipped' })
      return
    }
    if (isBridgeDeliveryMaintenancePaused(userId)) {
      await setTerminalStatus('skipped', 'bridge_update_maintenance')
      return
    }
    // Lock check before claiming (Fix 2)
    if (lockGuard && !(await lockGuard.assertOwned('delivery_claim'))) {
      l('skipped: lock lost before claim')
      return
    }
    if (modelTaskTracker && !(await assertAutoInferenceBusinessGate({
      tracker:modelTaskTracker, lockGuard:null, resultValidUntilUtcMsc, phase:'delivery_claim',
    }))) {
      l('skipped: model task fence/expiry before claim')
      return
    }
    const subscriptionRuntime = await getDeliverySubscriptionRuntime(userId, promptTypeId, symbol)
    if (!subscriptionRuntime) {
      await setTerminalStatus('skipped', 'subscription_inactive')
      return
    }
    if (!subscriptionRuntime.in_schedule) {
      await setTerminalStatus('skipped', 'outside_schedule', { subscription_id: subscriptionRuntime.id })
      return
    }
    // Do not claim a delivery while its target Bridge is offline. A fresh
    // signal remains eligible for the periodic recovery pass.
    if (!isBridgeAlive(userId)) {
      l('waiting: bridge not alive before claim')
      return
    }
    // Atomic delivery claiming: only one executor can proceed (Fix 3)
    const claimed = await queryRun(
      `UPDATE auto_signal_deliveries SET execution_status = 'executing', execution_claimed_at = NOW()
       WHERE signal_id = ? AND user_id = ? AND execution_status = 'not_attempted'`,
      [signalId, userId])
    if (!claimed || claimed.changes !== 1) {
      l('skipped: already claimed or terminal state')
      return
    }
    deliveryClaimed = true

    // Close the claim race: if the Bridge disconnected after the atomic claim,
    // release only an untouched claim. Once an order intent exists, recovery
    // must reconcile it instead of replaying the signal.
    if (!isBridgeAlive(userId)) {
      const released = await releaseUnsentDeliveryClaim(signalId, userId)
      if (released?.changes === 1) l('waiting: bridge disconnected after claim; untouched claim released')
      else l('stopped: bridge disconnected after claim but claim was no longer untouched')
      return
    }

    const riskConfig = await getDeliveryExecuteRiskConfig(userId)
    if (riskConfig) riskConfig.take_profit_mode = subscriptionRuntime.take_profit_mode || 'ai_recommended'
    if (!riskConfig?.enable_auto_trade) {
      l('skipped: enable_auto_trade=false')
      await setTerminalStatus('skipped', 'auto_trade_disabled')
      await insertAudit(null, userId, 'ai_auto_execute_skipped', symbol,
        { signal_id: signalId, delivery_signal_id: signalId, prompt_type_id: promptTypeId, reason: 'auto_trade_disabled' },
        { status: 'skipped' }, 'info')
      return
    }

    // Use user's own bridge for execution
    if (!isBridgeAlive(userId)) {
      l('skipped: bridge not alive')
      await setTerminalStatus('skipped', 'bridge_offline')
      await insertAudit(null, userId, 'ai_auto_execute_skipped', symbol,
        { signal_id: signalId, delivery_signal_id: signalId, prompt_type_id: promptTypeId, reason: 'bridge_offline' },
        { status: 'skipped' }, 'info')
      return
    }

    // Defense-in-depth: check trade_send_enabled
    const ubSettings = await queryOne('SELECT trade_send_enabled FROM user_bridge_settings WHERE user_id = ?', [userId])
    if (!ubSettings || !ubSettings.trade_send_enabled) {
      l('skipped: trade_send_enabled=0 (or no row)')
      await setTerminalStatus('skipped', 'trade_send_disabled')
      await insertAudit(null, userId, 'ai_auto_execute_skipped', symbol,
        { signal_id: signalId, delivery_signal_id: signalId, prompt_type_id: promptTypeId, reason: 'trade_send_disabled' },
        { status: 'skipped' }, 'info')
      return
    }
    // Strategy inference locks are independent, but all strategies for this
    // user share one terminal inventory. Serialize the final snapshot and
    // order send per account+symbol to prevent concurrent strategies from
    // racing on the same terminal inventory.
    if (/^(buy|sell)/.test(String(signal.signal_type || '').toLowerCase())) {
      inventoryLock = await acquireDeliveryInventoryLock(userId, symbol)
      if (!inventoryLock.token) {
        await finishBeforeRisk('skipped', 'execution_inventory_lock_busy')
        return
      }
    }

    // The DB/risk checks above can take long enough for the Bridge to drop
    // after the claim. Re-check before the first terminal snapshot command and
    // release only the still-untouched claim.
    if (!isBridgeAlive(userId)) {
      const released = await releaseUnsentDeliveryClaim(signalId, userId)
      if (released?.changes === 1) l('waiting: bridge disconnected before portfolio snapshot; untouched claim released')
      else l('stopped: bridge disconnected before portfolio snapshot but claim was no longer untouched')
      return
    }

    const [positionsResponse, pendingResponse] = await Promise.all([
      mt5Bridge(userId, 'positions', { symbol }, { noFallback:true }),
      mt5Bridge(userId, 'pending_list', { symbol }, { noFallback:true }),
    ])
    let positions = Array.isArray(positionsResponse?.positions) ? positionsResponse.positions : null
    let pendingOrders = pendingResponse?.orders ?? pendingResponse?.pending_list
    if (!positions || !Array.isArray(pendingOrders)) {
      await finishBeforeRisk('rejected', 'portfolio_state_unavailable')
      return
    }
    // Resolve ownership against the terminal's complete live pending set, not
    // an arbitrary slice of recent delivery history. This keeps old-but-live
    // pending orders inside both management and duplicate-order safeguards.
    const livePendingTickets = [...new Set(pendingOrders
      .map(item => String(item?.ticket ?? item?.mt5_ticket ?? item?.order_ticket ?? '').trim())
      .filter(Boolean))]
    const strategyDeliveries = livePendingTickets.length ? await queryAll(`SELECT d.id AS delivery_id, d.signal_id, d.user_id AS delivery_user_id,
          d.prompt_type_id, d.order_intent_id, d.pending_ticket, d.trade_ticket, d.pending_state,
          d.execution_status,
          COALESCE(outcomes.management_group_id, origin_signals.management_group_id) AS management_group_id,
          origin_signals.management_group_id AS origin_management_group_id,
          origin_signals.thesis_id AS origin_thesis_id,
          oi.status AS order_intent_status, oi.user_id AS intent_user_id,
          oi.trading_account_id AS intent_trading_account_id,
          outcomes.id AS outcome_id, outcomes.delivery_id AS outcome_delivery_id,
          outcomes.order_intent_id AS outcome_order_intent_id,
          outcomes.user_id AS outcome_user_id,
          outcomes.trading_account_id AS outcome_trading_account_id,
          outcomes.pending_ticket AS outcome_pending_ticket,
          outcomes.entry_order_ticket AS outcome_trade_ticket,
          outcomes.strategy_id AS outcome_strategy_id,
          outcomes.status AS outcome_status,
          outcomes.management_group_id AS outcome_management_group_id,
          outcomes.thesis_id AS outcome_thesis_id
        FROM auto_signal_deliveries d
        LEFT JOIN signal_outcomes outcomes
          ON outcomes.delivery_id = d.id
          OR (d.order_intent_id IS NOT NULL AND outcomes.order_intent_id = d.order_intent_id)
        LEFT JOIN order_intents oi ON oi.id = d.order_intent_id
        LEFT JOIN ai_signals origin_signals ON origin_signals.id = d.signal_id
        WHERE d.user_id = ? AND d.prompt_type_id = ?
          AND (d.pending_ticket IN (${livePendingTickets.map(() => '?').join(',')})
            OR d.trade_ticket IN (${livePendingTickets.map(() => '?').join(',')})
            OR outcomes.pending_ticket IN (${livePendingTickets.map(() => '?').join(',')})
            OR outcomes.entry_order_ticket IN (${livePendingTickets.map(() => '?').join(',')}))
        ORDER BY d.id DESC`, [userId, promptTypeId,
          ...livePendingTickets, ...livePendingTickets, ...livePendingTickets, ...livePendingTickets]) : []
    const signalType = String(signal.signal_type || '').toLowerCase()
    const isTradeSignal = signalType.startsWith('buy') || signalType.startsWith('sell')
    const signalIsBuy = signalType.startsWith('buy')
    const pendingAction = String(signal.pending_action || 'none').toLowerCase()
    const pendingActionReason = String(signal.pending_action_reason || '').trim()
    const managementDirection = String(signal.management_direction || (isTradeSignal ? (signalIsBuy ? 'buy' : 'sell') : 'none')).toLowerCase()
    const referenceUserIds = new Set((positionManagementContext?._executionLineage?.source_user_ids || [])
      .map(Number).filter(id => id > 0))
    const syncPendingCancelGroupIds = referenceUserIds.has(Number(userId))
      ? new Set() : synchronousPendingCancelGroupIds(signal)
    const syncPendingCancelOriginSignalIds = synchronousPendingCancelOriginSignalIds(signal, positionManagementContext)
    const frozenSyncDeliveries = syncPendingCancelGroupIds.size > 0 && isTradeSignal
      ? selectFrozenSynchronousPendingDeliveries(strategyDeliveries, syncPendingCancelOriginSignalIds)
      : strategyDeliveries
    // `keep` intentionally has no management direction in the model contract:
    // it evaluates every current-strategy pending order for this symbol. Only
    // cancel uses the model-provided direction to select targets.
    const pendingTargets = syncPendingCancelGroupIds.size > 0 && isTradeSignal
      ? selectOwnedStrategyPendingOrders(pendingOrders, frozenSyncDeliveries, symbol, undefined,
        syncPendingCancelGroupIds, syncPendingCancelOriginSignalIds)
      : pendingAction === 'keep'
        ? selectOwnedStrategyPendingOrders(pendingOrders, strategyDeliveries, symbol)
        : selectOwnedStrategyPendingOrders(pendingOrders, strategyDeliveries, symbol, managementDirection)
    const strategyPendingTickets = new Set(pendingTargets
      .map(item => String(item?.ticket ?? item?.mt5_ticket ?? '').trim()).filter(Boolean))
    const pendingDecision = syncPendingCancelGroupIds.size > 0 && isTradeSignal
      ? { action:'manage', reason:null, count:pendingTargets.length, targets:pendingTargets }
      : resolvePendingActionGate({ pendingAction, pendingOrders:pendingTargets })
    const cancellationPlan = resolvePendingCancellationPlan({
      signalType, pendingAction, pendingTargets:pendingDecision.targets,
      synchronousPendingCancelGroupIds:syncPendingCancelGroupIds,
    })

    const auditPendingCancellationFailure = async (reason, details = {}, continueToNewOrder = null) => {
      const normalizedReason = String(reason || 'pending_cancel_failed')
      const shouldContinue = continueToNewOrder == null
        ? Boolean(cancellationPlan.continue_to_new_order)
        : Boolean(continueToNewOrder)
      await insertAudit(null, userId, 'ai_cancel_pending_failed', symbol,
        { signal_id:signalId, prompt_type_id:promptTypeId, ticket:details.ticket || null,
          reason:pendingActionReason, cancellation_reason:normalizedReason,
          continue_to_new_order:shouldContinue, ...details },
        { status:'error', reason:normalizedReason,
          message:details.bridge_message || normalizedReason,
          continue_to_new_order:shouldContinue }, 'warning').catch(() => {})
    }

    // `keep` remains an explicit no-new-order decision. A trade cancellation
    // with no matching target is different: cancellation is best-effort and
    // the independent new-order branch must still get its own fresh snapshot.
    if (pendingDecision.action === 'skip') {
      const cancellationTargetMissing = pendingAction === 'cancel'
        && pendingDecision.reason === 'reference_pending_not_matched'
      if (cancellationTargetMissing) {
        await auditPendingCancellationFailure('pending_cancel_target_unmatched', {
          count:0, target_unmatched:true,
        })
      }
      const canContinueAfterSkip = isTradeSignal
        && pendingAction === 'cancel'
        && cancellationPlan.continue_to_new_order
        && pendingDecision.reason === 'reference_pending_not_matched'
      if (!canContinueAfterSkip) {
        await finishBeforeRisk('skipped', pendingDecision.reason, { count:pendingDecision.count })
        return
      }
    }

    if (pendingDecision.action === 'manage') {
      const cancellable = cancellationPlan.targets
      let cancellationError = null
      const cancelledTickets = []
      if (cancellationPlan.requires_targets && !cancellable.length) {
        cancellationError = new Error('pending_cancel_target_unmatched')
        cancellationError.reason = 'pending_cancel_target_unmatched'
        cancellationError.details = {
          count:0, management_group_ids:[...syncPendingCancelGroupIds],
        }
      } else {
        try {
          await assertAiPendingCancelEnabled()
          if (subscriberWeeklyWindow()) {
            const error = new Error('weekly_flatten_window')
            error.reason = 'weekly_flatten_window'
            throw error
          }
          if (lockGuard && !(await lockGuard.assertOwned('pending_cancel'))) {
            const error = new Error('lock_lost_before_pending_cancel')
            error.reason = 'lock_lost_before_pending_cancel'
            throw error
          }
          if (modelTaskTracker && !(await assertAutoInferenceBusinessGate({
            tracker:modelTaskTracker, lockGuard:null, resultValidUntilUtcMsc, phase:'pending_cancel',
          }))) {
            const error = new Error('model_task_business_gate_failed')
            error.reason = 'model_task_business_gate_failed'
            throw error
          }
          if (!(await isUserEligibleForAutoExecution(userId))) {
            const error = new Error('auto_execution_permission_changed')
            error.reason = 'auto_execution_permission_changed'
            throw error
          }
          const currentResp = await mt5Bridge(userId, 'pending_list', { symbol }, { noFallback:true })
          const currentOrders = currentResp?.orders ?? currentResp?.pending_list
          if (!currentResp || currentResp.status === 'error' || !Array.isArray(currentOrders)) {
            const error = new Error('pending_cancel_list_unavailable')
            error.reason = 'pending_cancel_list_unavailable'
            throw error
          }
          const currentByTicket = new Map(currentOrders.map(item =>
            [String(item.ticket ?? item.mt5_ticket ?? '').trim(), item]))
          for (const item of cancellable) {
            const ticket = String(item.ticket ?? item.mt5_ticket ?? '').trim()
            const current = currentByTicket.get(ticket)
            if (!ticket || !current) {
              const error = new Error('pending_cancel_target_unmatched')
              error.reason = 'pending_cancel_target_unmatched'
              error.details = { ticket:ticket || null }
              throw error
            }
            if (Number(current.magic || 0) !== 234000
              || !strategyPendingTickets.has(ticket)
              || stripBrokerSuffix(String(current.symbol || '')) !== stripBrokerSuffix(symbol)) {
              const error = new Error('pending_cancel_ownership_changed')
              error.reason = 'pending_cancel_ownership_changed'
              error.details = { ticket }
              throw error
            }
            if (recoveryContext) await assertSignalDeliveryRecoveryLive({ recoveryContext, userId, signalId })
            if (lockGuard && !(await lockGuard.assertOwned(`pending_cancel:${ticket}`))) {
              const error = new Error('lock_lost_before_pending_cancel')
              error.reason = 'lock_lost_before_pending_cancel'
              error.details = { ticket }
              throw error
            }
            if (modelTaskTracker && !(await assertAutoInferenceBusinessGate({
              tracker:modelTaskTracker, lockGuard:null, resultValidUntilUtcMsc,
              phase:`pending_cancel:${ticket}`,
            }))) {
              const error = new Error('model_task_business_gate_failed')
              error.reason = 'model_task_business_gate_failed'
              error.details = { ticket }
              throw error
            }
            await assertAiPendingCancelEnabled()
            const cancelled = await mt5Bridge(userId, 'cancel_pending', {
              ticket,
              expected_state: pendingManagementExpectedState(current),
            }, { noFallback:true })
            if (cancelled?.status !== 'success') {
              const error = new Error('pending_cancel_failed')
              error.reason = 'pending_cancel_failed'
              error.details = { ticket, bridge_message:cancelled?.message || null }
              throw error
            }
            cancelledTickets.push(ticket)
            await queryRun(
              "UPDATE auto_signal_deliveries SET pending_state = 'cancelled' WHERE pending_ticket = ? AND user_id = ?",
              [ticket, userId]).catch(() => {})
            await insertAudit(null, userId, 'ai_cancel_pending', symbol,
              { signal_id:signalId, prompt_type_id:promptTypeId, ticket, pending_type:current.side || current.pending_type || current.order_type || null, reason:pendingActionReason },
              { status:'cancelled', ticket }, 'success').catch(() => {})
          }
          const confirmResp = await mt5Bridge(userId, 'pending_list', { symbol }, { noFallback:true })
          const confirmOrders = confirmResp?.orders ?? confirmResp?.pending_list
          if (!confirmResp || confirmResp.status === 'error' || !Array.isArray(confirmOrders)) {
            const error = new Error('pending_cancel_confirm_unavailable')
            error.reason = 'pending_cancel_confirm_unavailable'
            throw error
          }
          const remaining = new Set(confirmOrders
            .map(item => String(item?.ticket ?? item?.mt5_ticket ?? '').trim())
            .filter(Boolean))
          const stillPending = cancelledTickets.filter(ticket => remaining.has(ticket))
          if (stillPending.length) {
            const error = new Error('pending_cancel_unconfirmed')
            error.reason = 'pending_cancel_unconfirmed'
            error.details = { tickets:stillPending }
            throw error
          }
        } catch (error) {
          cancellationError = error
        }
      }

      if (cancellationError) {
        const reason = cancellationError.reason || cancellationError.message || 'pending_cancel_failed'
        const outcome = resolvePendingCancellationOutcome({ cancellationPlan, reason })
        await auditPendingCancellationFailure(reason, {
          ...(cancellationError.details || {}), count:cancellable.length,
          cancelled_tickets:cancelledTickets,
        }, outcome.continue_to_new_order)
        if (!outcome.continue_to_new_order) {
          const skippedReasons = new Set([
            'ai_pending_cancel_disabled', 'auto_execution_permission_changed', 'delivery_recovery_expired',
            'delivery_recovery_untrusted', 'model_task_business_gate_failed',
            'lock_lost_before_pending_cancel', 'weekly_flatten_window',
          ])
          await finishBeforeRisk(skippedReasons.has(reason) ? 'skipped' : 'rejected', reason, {
            ...(cancellationError.details || {}), count:cancellable.length,
          })
          return
        }
      }
      if (!cancellationPlan.continue_to_new_order) {
        await finishBeforeRisk('success', 'pending_cancelled', {
          count:cancellable.length, pending_action_reason:pendingActionReason,
        })
        return
      }
    }

    // Cancellation and new-order decisions are independent. Once a trade
    // signal enters the new-order branch, discard the pre-cancel snapshot and
    // obtain both terminal views again, even if cancellation failed or had no
    // matching target. Any refresh failure is fail-closed.
    const cancellationRequested = pendingAction === 'cancel' || syncPendingCancelGroupIds.size > 0
    if (isTradeSignal && cancellationRequested && cancellationPlan.continue_to_new_order) {
      // Permission/Bridge eligibility may change while cancellation is in
      // flight. Re-check it for the independent new-order branch instead of
      // treating the cancellation-phase check as authorization for both.
      if (!(await isUserEligibleForAutoExecution(userId))) {
        await finishBeforeRisk('skipped', 'auto_execution_permission_changed')
        return
      }
      let refreshedPositionsResponse
      let refreshedPendingResponse
      try {
        [refreshedPositionsResponse, refreshedPendingResponse] = await Promise.all([
          mt5Bridge(userId, 'positions', { symbol }, { noFallback:true }),
          mt5Bridge(userId, 'pending_list', { symbol }, { noFallback:true }),
        ])
      } catch (error) {
        await finishBeforeRisk('rejected', 'portfolio_state_refresh_unavailable', {
          bridge_message:error?.message || null,
        })
        return
      }
      const refreshedPositions = Array.isArray(refreshedPositionsResponse?.positions)
        ? refreshedPositionsResponse.positions : null
      const refreshedPendingOrders = refreshedPendingResponse?.orders ?? refreshedPendingResponse?.pending_list
      if (!refreshedPositions || !Array.isArray(refreshedPendingOrders)
        || refreshedPositionsResponse?.status === 'error'
        || refreshedPendingResponse?.status === 'error') {
        await finishBeforeRisk('rejected', 'portfolio_state_refresh_unavailable')
        return
      }
      positions = refreshedPositions
      pendingOrders = refreshedPendingOrders
    }

    const symbolPositions = positions.filter(item => stripBrokerSuffix(String(item.symbol || '')) === stripBrokerSuffix(symbol))
    const sameDirectionPositions = symbolPositions.filter(item => String(item.type || '').toLowerCase().startsWith(signalIsBuy ? 'buy' : 'sell'))
    const oppositePositions = symbolPositions.filter(item => !sameDirectionPositions.includes(item))
    const positionAction = String(signal.position_action || (sameDirectionPositions.length ? 'hold_no_add' : 'open')).toLowerCase()

    // Position exposure gates belong to the independent new-order axis. A
    // successful pending cancellation above must remain effective even when
    // the new plan is later rejected for an existing/opposite position.
    if (isTradeSignal && oppositePositions.length) {
      await finishBeforeRisk('skipped', 'opposite_position_exists', { count:oppositePositions.length })
      return
    }
    if (isTradeSignal && sameDirectionPositions.length && positionAction !== 'allow_add') {
      await finishBeforeRisk('skipped', 'existing_position_no_add', { count:sameDirectionPositions.length })
      return
    }
    if (isTradeSignal && !sameDirectionPositions.length && ['allow_add', 'hold_no_add'].includes(positionAction)) {
      await finishBeforeRisk('skipped', 'reference_position_not_matched')
      return
    }

    const executionSignal = positionAction === 'allow_add'
      ? { ...signal, position_size_tier:'probe', position_size_factor:0.25 }
      : signal
    const order = signalOrderPayload(executionSignal, riskConfig, market, true)
    const isPendingOrder = isAiPendingOrderRequest(order, 'auto_delivery')
    if (isPendingOrder) {
      try {
        await assertAiPendingOrderEnabled()
      } catch {
        l('skipped: platform AI pending-order switch is off')
        await setTerminalStatus('skipped', 'ai_pending_order_disabled')
        await insertAudit(null, userId, 'ai_auto_execute_skipped', symbol,
          { signal_id:signalId, delivery_signal_id:signalId, prompt_type_id:promptTypeId, reason:'ai_pending_order_disabled' },
          { status:'skipped', message:'ai_pending_order_disabled' }, 'info')
        return
      }
    }
    // TP/SL validation: strict fail-closed (Fix 5)
    const isBuyOrder = order.order_type === 'buy'
    // Get user's own quote — fail-closed if unavailable
    let entryRef = order.limit_price || 0
    if (!entryRef && order.order_type) {
      try {
        const quoteResp = await mt5Bridge(userId, 'quote', { symbol }, { noFallback: true })
        if (quoteResp && quoteResp.status !== 'error') {
          const ask = parseFloat(quoteResp.ask)
          const bid = parseFloat(quoteResp.bid)
          if (Number.isFinite(ask) && ask > 0 && Number.isFinite(bid) && bid > 0) {
            entryRef = isBuyOrder ? ask : bid
          }
        }
      } catch (e) { l(`quote fetch failed: ${e.message}`) }
    }
    // Strict: entryRef must be valid
    if (!entryRef || !Number.isFinite(entryRef) || entryRef <= 0) {
      l('rejected: user_quote_unavailable — no valid entry reference')
      await setTerminalStatus('rejected', 'user_quote_unavailable', { limit_price:order.limit_price || null })
      await insertAudit(null, userId, 'ai_auto_execute_rejected', symbol,
        { signal_id: signalId, delivery_signal_id: signalId, prompt_type_id: promptTypeId, reason: 'user_quote_unavailable' },
        { status: 'rejected', message: 'user_quote_unavailable' }, 'warning')
      return
    }
    // SL must exist and be valid
    const slVal = order.sl != null ? parseFloat(order.sl) : null
    if (slVal == null || !Number.isFinite(slVal) || slVal <= 0) {
      l(`rejected: stop_loss_missing sl=${order.sl}`)
      await setTerminalStatus('rejected', 'stop_loss_missing', { stop_loss:order.sl ?? null })
      await insertAudit(null, userId, 'ai_auto_execute_rejected', symbol,
        { signal_id: signalId, delivery_signal_id: signalId, prompt_type_id: promptTypeId, reason: 'stop_loss_missing', sl: order.sl },
        { status: 'rejected', message: 'stop_loss_missing' }, 'warning')
      return
    }
    // SL direction
    const slOk = isBuyOrder ? slVal < entryRef : slVal > entryRef
    if (!slOk) {
      l(`rejected: invalid_stop_loss_direction sl=${slVal} for ${order.order_type} at ${entryRef}`)
      await setTerminalStatus('rejected', 'invalid_stop_loss_direction', { stop_loss:slVal, entry_price:entryRef, order_type:order.order_type })
      await insertAudit(null, userId, 'ai_auto_execute_rejected', symbol,
        { signal_id: signalId, delivery_signal_id: signalId, prompt_type_id: promptTypeId, reason: 'invalid_stop_loss_direction', sl: slVal, entry: entryRef },
        { status: 'rejected', message: 'invalid_stop_loss_direction' }, 'warning')
      return
    }
    // Selected TP must exist and be valid
    const tpVal = order.tp != null ? parseFloat(order.tp) : null
    if (tpVal == null || !Number.isFinite(tpVal) || tpVal <= 0) {
      l(`rejected: take_profit_target_missing tp=${order.tp} mode=${order.tp_selection_mode} tier=${order.tp_tier_requested}`)
      await setTerminalStatus('rejected', 'take_profit_target_missing', { take_profit:order.tp ?? null, take_profit_mode:order.tp_selection_mode, take_profit_tier:order.tp_tier_requested })
      await insertAudit(null, userId, 'ai_auto_execute_rejected', symbol,
        { signal_id: signalId, delivery_signal_id: signalId, prompt_type_id: promptTypeId, reason: 'take_profit_target_missing', tp: order.tp, mode: order.tp_selection_mode, tier: order.tp_tier_requested },
        { status: 'rejected', message: 'take_profit_target_missing' }, 'warning')
      return
    }
    // TP direction
    const tpOk = isBuyOrder ? tpVal > entryRef : tpVal < entryRef
    if (!tpOk) {
      l(`rejected: invalid_take_profit_direction tp=${tpVal} for ${order.order_type} at ${entryRef}`)
      await setTerminalStatus('rejected', 'invalid_take_profit_direction', { take_profit:tpVal, entry_price:entryRef, order_type:order.order_type })
      await insertAudit(null, userId, 'ai_auto_execute_rejected', symbol,
        { signal_id: signalId, delivery_signal_id: signalId, prompt_type_id: promptTypeId, reason: 'invalid_take_profit_direction', tp: tpVal, entry: entryRef },
        { status: 'rejected', message: 'invalid_take_profit_direction' }, 'warning')
      return
    }

    // The final weekly lock is evaluated only after loadRiskContext has
    // captured the subscriber's account-bound terminal clock. The older
    // bridgeWeeklyWindow lookup here could use an observer/shared clock.
    if (lockGuard && !(await lockGuard.assertOwned('order_send'))) {
      l('skipped: lock lost before order send')
      await setTerminalStatus('skipped', 'lock_lost_before_send').catch(() => {})
      await insertAudit(null, userId, 'ai_auto_execute_skipped', symbol,
        { signal_id: signalId, delivery_signal_id: signalId, prompt_type_id: promptTypeId, reason: 'lock_lost_before_send' },
        { status: 'skipped', reason: 'lock_lost_before_send' }, 'warning')
      return
    }
    if (modelTaskTracker && !(await assertAutoInferenceBusinessGate({
      tracker:modelTaskTracker, lockGuard:null, resultValidUntilUtcMsc, phase:'order_send',
    }))) {
      l('skipped: model task fence/expiry before order send')
      await setTerminalStatus('skipped', 'model_task_business_gate_failed').catch(() => {})
      return
    }
    const beforeBridgeSend = async ({ executionClockContext = null, instrument = null } = {}) => {
      const weeklyGate = autoDeliveryWeeklyWindow(executionClockContext, new Date())
      if (weeklyGate.blocked) throw new Error(weeklyGate.reason)
      if (lockGuard && !(await lockGuard.assertOwned('bridge_send'))) throw new Error('lock_lost_before_send')
      if (modelTaskTracker && !(await assertAutoInferenceBusinessGate({
        tracker:modelTaskTracker, lockGuard:null, resultValidUntilUtcMsc, phase:'bridge_send',
      }))) throw new Error('model_task_business_gate_failed')
      if (isPendingOrder) {
        const latestPendingResponse = await mt5Bridge(userId, 'pending_list', { symbol }, { noFallback:true })
        const latestPendingOrders = latestPendingResponse?.orders ?? latestPendingResponse?.pending_list
        if (!latestPendingResponse || latestPendingResponse.status === 'error' || !Array.isArray(latestPendingOrders)) {
          throw new Error('pending_list_unavailable_before_order')
        }
        const duplicate = findDuplicateLivePending({
          pendingOrders:latestPendingOrders,
          request:order,
          strategyDeliveries,
          userId,
          tradingAccountId:executionClockContext?.trading_account_id,
          strategyId:promptTypeId,
          instrument,
          dedupPriceAtr:riskConfig?.dedup_price_atr,
        })
        if (duplicate) throw new DuplicateLivePendingError(duplicate)
      }
    }
    const beforeBridgeSendTx = modelTaskTracker
      ? ({ run }) => assertAutoInferenceOrderSendTx({
        tracker:modelTaskTracker, run, resultValidUntilUtcMsc,
      })
      : recoveryContext
        ? ({ run }) => assertSignalDeliveryRecoveryTx({
          run, recoveryContext, userId, signalId,
        })
        : null
    const execResult = await executeOrder(userId, riskConfig, order, 'ai_auto_execute', {
      noFallback: true,
      sourceType: 'auto_delivery',
      signalId,
      deliveryId: `${signalId}:${userId}`,
      beforeBridgeSend,
      beforeBridgeSendTx,
    })

    const riskDecisionId = executionRiskDecisionId(execResult)
    await queryRun(
      `UPDATE auto_signal_deliveries SET order_intent_id = ?, risk_decision_id = ?, approved_order_json = ?
       WHERE signal_id = ? AND user_id = ?`,
      [execResult.order_intent_id || null, riskDecisionId,
        execResult.risk?.approved_order ? JSON.stringify(execResult.risk.approved_order) : null, signalId, userId]
    )
    const deliveryRow = await queryOne('SELECT id FROM auto_signal_deliveries WHERE signal_id = ? AND user_id = ? LIMIT 1', [signalId, userId])
    await attachOutcomeDelivery(execResult.order_intent_id, deliveryRow?.id)

    if (execResult.status === 'success') {
      const ticket = execResult.order || execResult.ticket || null
      const isPending = order.entry_method && order.entry_method !== 'market' && order.entry_method !== 'observe'
      const executionResult = JSON.stringify({ ...execResult, tp_tier_requested: order.tp_tier_requested, tp_tier_used: order.tp_tier_used, normalization_info: order.normalization_info })
      if (isPending) {
        await queryRun(
          `UPDATE auto_signal_deliveries SET execution_status = 'success',
           pending_ticket = ?, pending_state = 'pending', pending_valid_until = ?,
           execution_result = ? WHERE signal_id = ? AND user_id = ?`,
          [String(ticket), signal.pending_valid_until || null, executionResult, signalId, userId])
        // Fix 6: shared signals — do NOT write user ticket to ai_signals root
        l(`auto-executed pending: ticket=${ticket}, volume=${order.volume}`)
      } else {
        await queryRun(
          `UPDATE auto_signal_deliveries SET execution_status = 'success', is_executed = 1, executed_at = NOW(),
           trade_ticket = ?, execution_result = ? WHERE signal_id = ? AND user_id = ?`,
          [ticket, executionResult, signalId, userId])
        l(`auto-executed: ticket=${ticket}, volume=${order.volume}`)
      }
      await insertAudit(null, userId, 'ai_auto_execute', symbol,
        { signal_id: signalId, delivery_signal_id: signalId, prompt_type_id: promptTypeId, ticket, volume: order.volume, is_pending: isPending, tp_tier_requested: order.tp_tier_requested, tp_tier_used: order.tp_tier_used, normalization_info: order.normalization_info },
        { status: 'success', ticket, volume: order.volume, tp_tier_used: order.tp_tier_used }, 'success')
      sendToBrowsers(userId, {
        type: 'signal_execution_updated', signal_id: signalId, status: 'success',
        pending_ticket: isPending ? String(ticket) : null, trade_ticket: isPending ? null : ticket,
      })
      broadcastAdminEvent('ai', 'signal_execution_updated', {
        user_id:Number(userId), signal_id:Number(signalId), status:'success',
      }, { scopes:['ai-operations', 'risk-audit'], refresh:true })
    } else {
      const recoveryFenceFailure = recoveryContext
        && ['delivery_recovery_expired', 'delivery_recovery_untrusted'].includes(String(execResult?.reason || execResult?.reason_code || execResult?.message || ''))
      const safe = recoveryFenceFailure
        ? buildSafeExecutionOutcome({ status:'skipped', reason:execResult.reason || execResult.message, details:execResult.details || {}, stage:'execution', field:'execution' })
        : buildSafeExecutionOutcome({ status:execResult.status, classification:execResult.classification,
          reason:execResult.reason || execResult.reject_code || execResult.message, details:execResult.details || {},
          stage:execResult.stage || '', field:execResult.field || '', retcode:execResult.retcode })
      const status = safe.status
      const executionResult = JSON.stringify(safe)
      await queryRun(
        `UPDATE auto_signal_deliveries SET execution_status = ?, execution_result = ? WHERE signal_id = ? AND user_id = ?`,
        [status, executionResult, signalId, userId])
      l(`auto-execute ${status}: ${safe.message || safe.reason}`)
      await insertAudit(null, userId, safe.classification === 'risk_rejection' ? 'ai_auto_execute_rejected'
        : status === 'success' ? 'ai_auto_execute' : 'ai_auto_execute_skipped', symbol,
        { signal_id:signalId, delivery_signal_id:signalId, prompt_type_id:promptTypeId,
          stage:safe.stage || 'execution', reason:safe.reason, details:safe.details },
        safe, safe.classification === 'risk_rejection' ? 'warning' : status === 'success' ? 'success' : 'info')
      sendToBrowsers(userId, buildSafeExecutionEvent(safe, { type:'signal_execution_updated', signal_id:signalId }))
      broadcastAdminEvent('ai', 'signal_execution_updated', buildSafeExecutionEvent(safe, {
        user_id:Number(userId), signal_id:Number(signalId),
      }), { scopes:['ai-operations', 'risk-audit'], refresh:true })
    }
  } catch (err) {
    l(`exception: ${err.message}`)
    let durable = null
    try {
      durable = await queryOne(`SELECT oi.status, oi.trade_ticket, oi.pending_ticket
        FROM auto_signal_deliveries delivery
        JOIN order_intents oi ON oi.id = delivery.order_intent_id
        WHERE delivery.signal_id = ? AND delivery.user_id = ? LIMIT 1`, [signalId, userId])
    } catch {}
    const recovery = durableDeliveryRecovery(durable)
    if (recovery) {
      const recoveryOutcome = buildSafeExecutionOutcome({
        status:recovery.status === 'success' ? 'success' : 'uncertain',
        classification:recovery.status === 'success' ? 'execution_success' : 'execution_uncertain',
        reason:recovery.status === 'success' ? 'success' : 'post_execution_persistence_failed',
        details:{ ticket:recovery.ticket }, stage:'execution', field:'execution',
      })
      const recoveredResult = JSON.stringify({
        ...recoveryOutcome, reconciled_from_order_intent:true,
        ticket:recovery.ticket, kind:recovery.kind,
      })
      if (recovery.status === 'success' && recovery.kind === 'pending') {
        await queryRun(`UPDATE auto_signal_deliveries SET execution_status = 'success', pending_ticket = ?,
          pending_state = 'pending', execution_result = ? WHERE signal_id = ? AND user_id = ?`,
        [recovery.ticket, recoveredResult, signalId, userId]).catch(() => {})
      } else if (recovery.status === 'success') {
        await queryRun(`UPDATE auto_signal_deliveries SET execution_status = 'success', is_executed = 1,
          executed_at = COALESCE(executed_at, NOW()), trade_ticket = ?, execution_result = ?
          WHERE signal_id = ? AND user_id = ?`,
        [recovery.ticket, recoveredResult, signalId, userId]).catch(() => {})
      } else {
        await queryRun(`UPDATE auto_signal_deliveries SET execution_status = 'uncertain', execution_result = ?
          WHERE signal_id = ? AND user_id = ?`, [recoveredResult, signalId, userId]).catch(() => {})
      }
      await insertAudit(null, userId, 'ai_auto_execute_state_preserved', symbol,
        { signal_id:signalId, delivery_signal_id:signalId, prompt_type_id:promptTypeId,
          stage:'execution', reason:recoveryOutcome.reason, details:recoveryOutcome.details },
        { ...recoveryOutcome, order_intent_status:durable.status, ticket:recovery.ticket },
        recovery.status === 'success' ? 'warning' : 'info').catch(() => {})
      sendToBrowsers(userId, buildSafeExecutionEvent(recoveryOutcome, {
        type:'signal_execution_updated', signal_id:signalId,
        pending_ticket:recovery.kind === 'pending' ? recovery.ticket : null,
        trade_ticket:recovery.kind === 'trade' ? recovery.ticket : null,
      }))
      broadcastAdminEvent('ai', 'signal_execution_updated', buildSafeExecutionEvent(recoveryOutcome, {
        user_id:Number(userId), signal_id:Number(signalId),
      }), { scopes:['ai-operations', 'risk-audit'], refresh:true })
      return
    }
    const exceptionOutcome = buildSafeExecutionOutcome({
      status:'failed', classification:'preparation_failure', reason:'system_execution_exception',
      details:{}, stage:'execution', field:'execution',
    })
    await queryRun(
      `UPDATE auto_signal_deliveries SET execution_status = 'failed', execution_result = ? WHERE signal_id = ? AND user_id = ?`,
      [JSON.stringify(exceptionOutcome), signalId, userId]).catch(() => {})
    await insertAudit(null, userId, 'ai_auto_execute', symbol,
      { signal_id:signalId, delivery_signal_id:signalId, prompt_type_id:promptTypeId,
        stage:'execution', reason:exceptionOutcome.reason, details:exceptionOutcome.details },
      exceptionOutcome, 'error')
    sendToBrowsers(userId, buildSafeExecutionEvent(exceptionOutcome, {
      type:'signal_execution_updated', signal_id:signalId,
    }))
    broadcastAdminEvent('ai', 'signal_execution_updated', buildSafeExecutionEvent(exceptionOutcome, {
      user_id:Number(userId), signal_id:Number(signalId),
    }), { scopes:['ai-operations', 'risk-audit'], refresh:true })
  } finally {
    if (inventoryLock?.token) {
      await releaseAccountSymbolInventoryLock(inventoryLock.key, inventoryLock.token).catch(() => {})
    }
    endDeliveryExecution()
  }
}

// === Compatibility wrappers ===
export async function startAutoScheduler(userId) {
  await reconcileAutoSchedulers()
}

// Trigger reconcile after user state change (bridge disconnect/reconnect, config save)
// Actual subscriber removal is handled by removeUserRuntimeAutoSubscription
export async function stopAutoScheduler(userId) {
  await reconcileAutoSchedulers()
}

export async function initAutoSchedulers() {
  console.log('[initAutoSchedulers] Starting unified scheduler reconciliation')
  await rebuildRedisSubscriptions()
  await reconcileAutoSchedulers()
  startAutoSchedulerReconciler()
  startPendingReconciler()
  startOutcomeMonitor()
}

let _reconcileInterval = null
let _reconcileInFlight = null
let _reconcileStopping = false
let _reconcileSkippedOverlap = 0

function runAutoSchedulerReconcile() {
  if (_reconcileStopping || autoSchedulersStopping) return Promise.resolve({ ok:false, error:'scheduler_stopping' })
  if (_reconcileInFlight) {
    _reconcileSkippedOverlap += 1
    console.warn(`[Reconciler] Auto scheduler skipped-overlap (count=${_reconcileSkippedOverlap})`)
    return _reconcileInFlight
  }
  const promise = reconcileAutoSchedulers({ suppressErrors:true })
  _reconcileInFlight = promise
  promise.finally(() => {
    if (_reconcileInFlight === promise) _reconcileInFlight = null
  }).catch(() => {})
  return promise
}

export function startAutoSchedulerReconciler() {
  if (_reconcileInterval) return
  _reconcileStopping = false
  _reconcileInterval = setInterval(runAutoSchedulerReconcile, 60_000)
  _reconcileInterval.unref?.()
  console.log('[Reconciler] Started periodic reconciliation (every 60s)')
}

export function stopAutoSchedulerReconciler() {
  _reconcileStopping = true
  if (_reconcileInterval) clearInterval(_reconcileInterval)
  _reconcileInterval = null
  return _reconcileInFlight
}

export async function stopAutoSchedulers({ timeoutMs = AUTO_SCHEDULER_STOP_TIMEOUT_MS } = {}) {
  if (autoSchedulersStopPromise) return autoSchedulersStopPromise
  autoSchedulersStopping = true
  const waiters = []
  const reconcilerPromise = stopAutoSchedulerReconciler()
  if (reconcilerPromise) waiters.push({ promise:reconcilerPromise, label:'auto scheduler reconciler' })
  const states = Object.values(autoSchedulerState)
  for (const state of states) {
    state.running = false
    state.stopRequested = true
    if (state.timer) clearTimeout(state.timer)
    if (state._recoveryTimer) clearTimeout(state._recoveryTimer)
    if (state._lockGuard?.renewTimer) clearInterval(state._lockGuard.renewTimer)
    if (state._tickPromise) waiters.push({ promise:state._tickPromise, label:`scheduler ${state.key}` })
  }

  autoSchedulersStopPromise = (async () => {
    const timeout = Math.max(0, Number(timeoutMs) || AUTO_SCHEDULER_STOP_TIMEOUT_MS)
    for (const waiter of waiters) {
      const result = await boundedWait(waiter.promise, timeout, waiter.label)
      if (result.timedOut) {
        console.error(`[Shutdown] ${waiter.label} did not settle within ${timeout}ms`)
      } else if (result.error) {
        console.error(`[Shutdown] ${waiter.label} failed while stopping:`, result.error.message)
      }
    }
    for (const state of states) {
      if (autoSchedulerState[state.key] !== state || state._tickPromise) continue
      delete autoSchedulerState[state.key]
    }
    return { stopped:states.length, timedOut:states.filter(state => state._tickPromise).map(state => state.key) }
  })()
  return autoSchedulersStopPromise
}

// === Pending Order Reconciler ===
const PENDING_RECONCILE_INTERVAL_SEC = 30
let _pendingReconcileInterval = null
let _pendingReconcileInFlight = null
let _pendingReconcileStopping = false
let _pendingSkippedOverlap = 0
const SIGNAL_DELIVERY_RECOVERY_BATCH_SIZE = 50
const SIGNAL_DELIVERY_RECOVERY_WAIT_TASK_STATES = new Set([
  'queued', 'leased', 'preparing', 'submitted', 'provider_running', 'provider_quiet',
  'status_unknown', 'reconciling', 'response_received', 'validating', 'repairing',
  'retry_wait', 'result_ready', 'applying',
])

export function stopPendingReconciler() {
  _pendingReconcileStopping = true
  if (_pendingReconcileInterval) { clearInterval(_pendingReconcileInterval); _pendingReconcileInterval = null }
  return _pendingReconcileInFlight
}

export function startPendingReconciler() {
  if (_pendingReconcileInterval) return
  _pendingReconcileStopping = false
  const run = () => {
    if (_pendingReconcileStopping) return Promise.resolve({ skipped:'stopped' })
    if (_pendingReconcileInFlight) {
      _pendingSkippedOverlap += 1
      console.warn(`[PendingReconciler] skipped-overlap (count=${_pendingSkippedOverlap})`)
      return _pendingReconcileInFlight
    }
    const promise = Promise.resolve().then(() => reconcilePendingOrders())
      .catch(e => { console.error('[PendingReconciler] Error:', e.message) })
    _pendingReconcileInFlight = promise
    promise.finally(() => {
      if (_pendingReconcileInFlight === promise) _pendingReconcileInFlight = null
    }).catch(() => {})
    return promise
  }
  _pendingReconcileInterval = setInterval(run, PENDING_RECONCILE_INTERVAL_SEC * 1000)
  _pendingReconcileInterval.unref?.()
  console.log(`[PendingReconciler] Started (every ${PENDING_RECONCILE_INTERVAL_SEC}s)`)
}

function parseRecoveryJson(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function signalDeliveryRecoveryDeadline(row, nowMs = Date.now()) {
  const createdAtUtcMsc = Number(row?.created_at_utc_msc)
  const ttlSeconds = Number(row?.ttl_seconds)
  const resultValidUntilUtcMsc = Number(row?.result_valid_until_utc_msc)
  if (!Number.isFinite(createdAtUtcMsc) || createdAtUtcMsc <= 0
    || !Number.isFinite(ttlSeconds) || ttlSeconds <= 0
    || !Number.isFinite(resultValidUntilUtcMsc) || resultValidUntilUtcMsc <= 0) {
    return { trusted:false, reason:'delivery_recovery_untrusted', deadlineUtcMsc:null }
  }
  const deadlineUtcMsc = Math.min(resultValidUntilUtcMsc, createdAtUtcMsc + ttlSeconds * 1000)
  if (!Number.isFinite(deadlineUtcMsc) || nowMs > deadlineUtcMsc) {
    return { trusted:true, reason:'delivery_recovery_expired', deadlineUtcMsc }
  }
  return { trusted:true, reason:null, deadlineUtcMsc }
}

function signalDeliveryRecoveryActionable(row, decision) {
  const executionValidation = readExecutionValidation({ ...row, ...decision })
  if (executionValidation.validation.eligible !== true) {
    return { actionable:false, reason:'execution_validation_ineligible', executionValidation }
  }
  const signalType = String(row?.signal_type || '').trim().toLowerCase()
  const pendingAction = String(row?.pending_action || decision?.pending_action || '').trim().toLowerCase()
  if (!signalType) return { actionable:false, reason:'delivery_recovery_untrusted' }
  if (signalType === 'hold') {
    return pendingAction === 'cancel'
      ? { actionable:true, signalType, pendingAction }
      : { actionable:false, reason:'hold_signal_no_execution' }
  }
  if (!/^(buy|sell)(?:_|$)/.test(signalType)) {
    return { actionable:false, reason:'delivery_recovery_untrusted' }
  }
  return { actionable:true, signalType, pendingAction }
}

async function closeUnattemptedDelivery(row, reason, details = {}) {
  const safe = buildSafeExecutionOutcome({ status:'skipped', reason, details, stage:'execution', field:'execution' })
  const executionResult = JSON.stringify({ ...safe, recovered_at_utc_msc:Date.now() })
  const updated = await queryRun(
    `UPDATE auto_signal_deliveries
     SET execution_status = 'skipped', execution_result = ?
     WHERE id = ? AND execution_status = 'not_attempted'`,
    [executionResult, row.id])
  if (updated?.changes === 1) {
    try {
      sendToBrowsers(row.user_id, buildSafeExecutionEvent(safe, {
        type:'signal_execution_updated', signal_id:row.signal_id,
      }))
    } catch {}
  }
  return updated?.changes === 1
}

/**
 * Recover only fresh, trusted actionable deliveries. This function deliberately
 * delegates all execution checks and the atomic claim to executeDelivery.
 */
export async function reconcileUnattemptedSignalDeliveries({
  limit = SIGNAL_DELIVERY_RECOVERY_BATCH_SIZE,
  executeDeliveryFn = executeDelivery,
  nowMs = Date.now(),
} = {}) {
  const batchSize = Math.max(1, Math.min(Number(limit) || SIGNAL_DELIVERY_RECOVERY_BATCH_SIZE, SIGNAL_DELIVERY_RECOVERY_BATCH_SIZE))
  let rows = []
  try {
    rows = await queryAll(`
      SELECT d.id, d.user_id, d.signal_id, d.prompt_type_id, d.symbol,
        d.execution_status, d.order_intent_id,
        s.signal_type, s.confidence, s.recommended_volume,
        s.position_size_tier, s.position_size_factor, s.position_size_reason,
        s.analysis, s.reasoning, s.stop_loss_price,
        s.take_profit_1_price, s.take_profit_2_price, s.take_profit_3_price,
        s.recommended_take_profit_tier, s.entry_method, s.limit_price,
        s.stop_limit_price, s.pending_valid_until,
        s.created_at, s.created_at_utc_msc, s.ttl_seconds,
        s.decision_json, s.market_data_json, s.inference_task_id,
        t.task_id, t.status AS model_task_status, t.result_valid_until_utc_msc
      FROM auto_signal_deliveries d
      LEFT JOIN ai_signals s ON s.id = d.signal_id
      LEFT JOIN ai_model_tasks t ON t.task_id = s.inference_task_id
      WHERE d.execution_status = 'not_attempted'
      ORDER BY s.created_at_utc_msc DESC, d.id DESC LIMIT ?
    `, [batchSize])
  } catch (error) {
    console.error('[PendingReconciler] signal delivery recovery query error:', error.message)
    return { selected:0, attempted:0, recovered:0, skipped:0 }
  }

  const summary = { selected:0, attempted:0, recovered:0, skipped:0 }
  const auditGroups = new Map()
  const recordClosed = (row, reason) => {
    summary.skipped += 1
    const key = [Number(row.user_id), String(row.symbol || '').toUpperCase(), String(reason || '')].join('|')
    const group = auditGroups.get(key) || {
      userId:Number(row.user_id), symbol:row.symbol || null, reason:String(reason || 'delivery_recovery_untrusted'),
      count:0, firstSignalId:null, lastSignalId:null, firstDeliveryId:null, lastDeliveryId:null,
    }
    group.count += 1
    const signalId = Number(row.signal_id)
    const deliveryId = Number(row.id)
    if (Number.isInteger(signalId) && signalId > 0) {
      group.firstSignalId = group.firstSignalId == null ? signalId : Math.min(group.firstSignalId, signalId)
      group.lastSignalId = group.lastSignalId == null ? signalId : Math.max(group.lastSignalId, signalId)
    }
    if (Number.isInteger(deliveryId) && deliveryId > 0) {
      group.firstDeliveryId = group.firstDeliveryId == null ? deliveryId : Math.min(group.firstDeliveryId, deliveryId)
      group.lastDeliveryId = group.lastDeliveryId == null ? deliveryId : Math.max(group.lastDeliveryId, deliveryId)
    }
    auditGroups.set(key, group)
  }
  for (const row of (Array.isArray(rows) ? rows : [])) {
    summary.selected += 1
    try {
      const decision = parseRecoveryJson(row.decision_json)
      const actionability = signalDeliveryRecoveryActionable(row, decision)
      const executionValidation = actionability.executionValidation || readExecutionValidation({ ...row, ...decision })
      if (!actionability.actionable) {
        const closed = await closeUnattemptedDelivery(row, actionability.reason,
          { pending_action:row.pending_action || decision?.pending_action || null })
        if (closed) recordClosed(row, actionability.reason)
        continue
      }
      const modelTaskStatus = String(row.model_task_status || '').toLowerCase()
      if (row.order_intent_id != null) {
        const closed = await closeUnattemptedDelivery(row, 'delivery_recovery_untrusted', {
          order_intent_id:row.order_intent_id,
        })
        if (closed) recordClosed(row, 'delivery_recovery_untrusted')
        continue
      }
      const deadline = signalDeliveryRecoveryDeadline(row, nowMs)
      // A task can still be moving through its normal state machine after the
      // signal row is committed. Keep it pending only while its result window
      // remains valid; status_unknown and other interrupted states must not
      // occupy the recovery queue forever after their deadline.
      if (SIGNAL_DELIVERY_RECOVERY_WAIT_TASK_STATES.has(modelTaskStatus)) {
        if (deadline.trusted && !deadline.reason) continue
        const closed = await closeUnattemptedDelivery(row, deadline.reason || 'delivery_recovery_untrusted', {
          deadline_utc_msc:deadline.deadlineUtcMsc,
          model_task_status:modelTaskStatus,
        })
        if (closed) recordClosed(row, deadline.reason || 'delivery_recovery_untrusted')
        continue
      }
      if (modelTaskStatus !== 'succeeded'
        || !row.inference_task_id
        || String(row.task_id || '') !== String(row.inference_task_id || '')) {
        const closed = await closeUnattemptedDelivery(row, 'delivery_recovery_untrusted', {
          model_task_status:row.model_task_status || null,
          inference_task_id:row.inference_task_id || null,
          task_id:row.task_id || null,
          order_intent_id:row.order_intent_id || null,
        })
        if (closed) recordClosed(row, 'delivery_recovery_untrusted')
        continue
      }
      if (!deadline.trusted || deadline.reason === 'delivery_recovery_expired') {
        const closed = await closeUnattemptedDelivery(row, deadline.reason || 'delivery_recovery_untrusted', {
          deadline_utc_msc:deadline.deadlineUtcMsc,
        })
        if (closed) recordClosed(row, deadline.reason || 'delivery_recovery_untrusted')
        continue
      }
      if (!decision || !parseRecoveryJson(row.market_data_json)) {
        const closed = await closeUnattemptedDelivery(row, 'delivery_recovery_untrusted', {
          missing_evidence:!decision ? 'decision_json' : 'market_data_json',
        })
        if (closed) recordClosed(row, 'delivery_recovery_untrusted')
        continue
      }
      // Bridge offline is intentionally a no-op: leave not_attempted for the
      // next round instead of converting a recoverable signal into skipped.
      if (!isBridgeAlive(row.user_id)) continue
      const market = parseRecoveryJson(row.market_data_json)
      const signal = {
        ...row,
        ...decision,
        id:Number(row.signal_id),
        signal_type:row.signal_type,
        confidence:row.confidence,
        recommended_volume:row.recommended_volume,
        position_size_tier:row.position_size_tier,
        position_size_factor:row.position_size_factor,
        position_size_reason:row.position_size_reason,
        analysis:row.analysis,
        reasoning:row.reasoning,
        stop_loss_price:row.stop_loss_price,
        take_profit_1_price:row.take_profit_1_price,
        take_profit_2_price:row.take_profit_2_price,
        take_profit_3_price:row.take_profit_3_price,
        recommended_take_profit_tier:row.recommended_take_profit_tier,
        entry_method:row.entry_method,
        limit_price:row.limit_price,
        stop_limit_price:row.stop_limit_price,
        pending_valid_until:row.pending_valid_until,
        pending_action:decision.pending_action || null,
        symbol:row.symbol,
        created_at:row.created_at,
        created_at_utc_msc:Number(row.created_at_utc_msc),
        ttl_seconds:Number(row.ttl_seconds),
        market_data:market,
        ...(executionValidation.explicit ? { execution_validation:executionValidation.validation } : {}),
      }
      summary.attempted += 1
      await executeDeliveryFn(
        Number(row.user_id), Number(row.signal_id), signal, null, market,
        Number(row.prompt_type_id), row.symbol, row.created_at, null, null,
        deadline.deadlineUtcMsc,
        { taskId:String(row.inference_task_id) },
      )
      summary.recovered += 1
    } catch (error) {
      // One malformed row or transient DB/Bridge error must not stop the
      // reconciler from processing the rest of the batch.
      console.error(`[PendingReconciler] delivery ${row?.id || '?'} recovery error:`, error.message)
    }
  }
  for (const group of auditGroups.values()) {
    try {
      await insertAudit(null, group.userId, 'ai_delivery_recovery_summary', group.symbol, {
        reason:group.reason,
        count:group.count,
        first_signal_id:group.firstSignalId,
        last_signal_id:group.lastSignalId,
        first_delivery_id:group.firstDeliveryId,
        last_delivery_id:group.lastDeliveryId,
      }, {
        status:'skipped',
        reason:group.reason,
        count:group.count,
      }, 'info')
    } catch (error) {
      console.warn(`[PendingReconciler] recovery audit summary failed user=${group.userId}:`, error.message)
    }
  }
  return summary
}

export async function reconcilePendingOrders() {
  // Fix 7+8: handle stale executing deliveries (stuck > 5 min → uncertain, conditional UPDATE)
  try {
    const staleRows = await queryAll(
      "SELECT id, user_id, signal_id, execution_claimed_at FROM auto_signal_deliveries WHERE execution_status = 'executing' AND execution_claimed_at IS NOT NULL AND execution_claimed_at < DATE_SUB(NOW(), INTERVAL 5 MINUTE)"
    )
    for (const row of staleRows) {
      const updateResult = await queryRun(
        `UPDATE auto_signal_deliveries SET execution_status = 'uncertain', execution_result = ?
         WHERE id = ? AND execution_status = 'executing' AND execution_claimed_at = ?`,
        [JSON.stringify({ reason: 'stale_executing_timeout', claimed_at: row.execution_claimed_at }), row.id, row.execution_claimed_at])
      if (updateResult && updateResult.changes === 1) {
        await insertAudit(null, row.user_id, 'delivery_stale_executing', null,
          { signal_id: row.signal_id, delivery_id: row.id, claimed_at: row.execution_claimed_at },
          { status: 'uncertain', reason: 'stale_executing_timeout' }, 'warning')
        console.warn(`[PendingReconciler] Delivery ${row.id} user=${row.user_id} stuck in executing > 5min → uncertain`)
      }
      // changes=0 means status was already updated by normal flow, silently skip
    }
  } catch (e) { console.error('[PendingReconciler] stale executing check error:', e.message) }

  const deliveryRows = await queryAll(
    "SELECT id, user_id, signal_id, order_intent_id, pending_ticket, pending_valid_until, 'delivery' as src FROM auto_signal_deliveries WHERE pending_state = 'pending'"
  )

  const signalRows = await queryAll(
    "SELECT id, user_id, id as signal_id, pending_ticket, pending_valid_until, 'signal' as src FROM ai_signals WHERE pending_state = 'pending'"
  )

  const allRows = [...deliveryRows, ...signalRows]
  try {
    await reconcileUnattemptedSignalDeliveries()
  } catch (error) {
    console.error('[PendingReconciler] signal delivery recovery error:', error.message)
  }
  if (!allRows.length) return

  const byUser = {}
  for (const row of allRows) {
    if (!byUser[row.user_id]) byUser[row.user_id] = []
    byUser[row.user_id].push(row)
  }

  for (const [userIdStr, rows] of Object.entries(byUser)) {
    const userId = Number(userIdStr)
    if (!isBridgeAlive(userId)) continue

    try {
      const [pendingResp, positionsResp] = await Promise.all([
        mt5Bridge(userId, 'pending_list', {}, { noFallback: true }),
        mt5Bridge(userId, 'positions', {}, { noFallback: true }),
      ])

      const pendingOrders = pendingResp?.orders ?? pendingResp?.pending_list
      const positionList = positionsResp?.positions
      if (!Array.isArray(pendingOrders) || !Array.isArray(positionList)) {
        console.error(`[PendingReconciler] User ${userId}: invalid bridge response, skip this round`)
        continue
      }

      const pendingByTicket = new Map(pendingOrders.map(item =>
        [String(item?.ticket ?? item?.mt5_ticket ?? ''), item]))
      const pendingSet = new Set(pendingByTicket.keys())
      const collectRefs = rows => new Set(rows.flatMap(item => [
        item?.ticket, item?.order, item?.order_ticket, item?.position_id, item?.identifier,
      ]).filter(value => value != null && String(value).trim() !== '').map(String))
      const itemHasRef = (item, ref) => [item?.ticket, item?.order, item?.order_ticket, item?.position_id, item?.identifier]
        .some(value => value != null && String(value) === ref)
      const positionSet = collectRefs(positionList)
      const lookupByTicket = new Map()
      const getOrderLookup = ticket => {
        if (!lookupByTicket.has(ticket)) {
          lookupByTicket.set(ticket, mt5Bridge(userId, 'order_lookup', {
            // The pending ticket is an exact broker identity; the bounded
            // lookback is only a compatibility guard for old adapters.
            expected_kind:'pending', pending_ticket:ticket, lookback_seconds:30 * 24 * 60 * 60,
          }, { noFallback:true }))
        }
        return lookupByTicket.get(ticket)
      }

      for (const row of rows) {
        const ticket = String(row.pending_ticket)
        const nowUtc = Date.now()
        let validUntilUtc = 0
        if (row.pending_valid_until) {
          const d = new Date(row.pending_valid_until.replace(' ', 'T') + 'Z')
          if (!isNaN(d.getTime())) validUntilUtc = d.getTime()
        }

        if (pendingSet.has(ticket)) {
          if (validUntilUtc <= 0 || nowUtc <= validUntilUtc) continue
          const cancelResult = await mt5Bridge(userId, 'cancel_pending', {
            ticket,
            expected_state: pendingManagementExpectedState(pendingByTicket.get(ticket)),
          }, { noFallback: true })
          if (cancelResult?.status !== 'success') {
            await insertAudit(null, userId, 'pending_expire_cancel_failed', null,
              { signal_id: row.signal_id, ticket, src: row.src }, cancelResult || { status: 'error' }, 'warning')
            continue
          }
          if (row.src === 'delivery') {
            await queryRun("UPDATE auto_signal_deliveries SET pending_state = 'expired' WHERE id = ? AND pending_state = 'pending'", [row.id])
          } else {
            await queryRun("UPDATE ai_signals SET pending_state = 'expired' WHERE id = ? AND pending_state = 'pending'", [row.signal_id])
          }
          await insertAudit(null, userId, 'pending_expired', null,
            { signal_id: row.signal_id, ticket, src: row.src }, { status: 'expired', cancel_result: cancelResult }, 'info')
          continue
        }

        const matchedPosition = positionList.find(item => itemHasRef(item, ticket))
        const lookup = matchedPosition ? null : await getOrderLookup(ticket)
        const lookupState = String(lookup?.pending_state || lookup?.final_state || '').toLowerCase()
        const lookupFilled = lookup?.status === 'success' && lookup?.found === true
          && (String(lookup?.kind || '').toLowerCase() === 'trade'
            || ['filled', 'partially_filled'].includes(lookupState))
        if (matchedPosition || lookupFilled) {
          const resolvedTradeTicket = String(matchedPosition?.ticket ?? matchedPosition?.position_id
            ?? lookup?.position_id ?? lookup?.ticket ?? ticket)
          if (row.src === 'delivery') {
            await queryRun(
              "UPDATE auto_signal_deliveries SET pending_state = 'filled', is_executed = 1, trade_ticket = ?, executed_at = NOW() WHERE id = ?",
              [resolvedTradeTicket, row.id])
            await recordPendingOutcomeFill({
              orderIntentId: row.order_intent_id,
              deliveryId: row.id,
              positionId: matchedPosition?.position_id ?? matchedPosition?.ticket ?? lookup?.position_id,
              orderTicket: ticket,
              dealTicket: lookup?.deal ?? lookup?.deal_ticket,
            })
            // Fix 6: do NOT sync user ticket to shared root ai_signals
          } else {
    await queryRun(
              "UPDATE ai_signals SET pending_state = 'filled', is_executed = 1, trade_ticket = ?, executed_at = NOW() WHERE id = ?",
              [resolvedTradeTicket, row.signal_id])
          }
          await insertAudit(null, userId, 'pending_filled', null,
            { signal_id: row.signal_id, ticket, src: row.src }, { status: 'filled', ticket: resolvedTradeTicket }, 'success')
          sendToBrowsers(userId, { type: 'pending_filled', ticket: resolvedTradeTicket, signal_id: row.signal_id })
          continue
        }

        // A pending ticket can disappear briefly while MT5 moves it into a
        // position/history record. Keep it pending until a targeted lookup
        // proves a terminal state; never infer expiry from a transient gap.
        if (validUntilUtc > 0 && nowUtc > validUntilUtc) {
          const lookupKind = String(lookup?.kind || '').toLowerCase()
          const lookupComplete = lookup?.status === 'success'
            && ((lookup?.found === false && lookup?.complete === true)
              || (lookup?.found === true
                && (lookupKind === 'rejected' || ['cancelled', 'expired', 'rejected'].includes(lookupState))))
          if (!lookupComplete) {
            console.warn(`[PendingReconciler] User ${userId}: order lookup incomplete for expired ticket=${ticket}, defer classification`)
            continue
          }
          if (row.src === 'delivery') {
            await queryRun("UPDATE auto_signal_deliveries SET pending_state = 'expired' WHERE id = ?", [row.id])
          } else {
            await queryRun("UPDATE ai_signals SET pending_state = 'expired' WHERE id = ?", [row.signal_id])
          }
          await insertAudit(null, userId, 'pending_expired', null,
            { signal_id: row.signal_id, ticket, src: row.src }, { status: 'expired' }, 'info')
        }
      }
    } catch (err) {
      console.error(`[PendingReconciler] User ${userId} error:`, err.message)
    }
  }
}

async function executeOrder(userId, config, request, action, options = {}) {
  if (!isTradeEnabled(userId)) {
    const result = { status: 'rejected', message: '交易发送已关闭，请先开启' }
    await insertAudit(null, userId, action, request.symbol, request, result, 'rejected')
    return result
  }
  return executeOrderCore(userId, config, request, action, options)
}

function executionRiskDecisionId(result) {
  return result?.risk?.risk_decision_id
    || result?.risk_decision_id
    || result?.details?.risk_decision_id
    || null
}

function durableDeliveryRecovery(intent) {
  const status = String(intent?.status || '').toLowerCase()
  if (status === 'succeeded') {
    const pendingTicket = String(intent?.pending_ticket || '').trim()
    if (pendingTicket) return { status:'success', kind:'pending', ticket:pendingTicket }
    const tradeTicket = String(intent?.trade_ticket || '').trim()
    if (tradeTicket) return { status:'success', kind:'trade', ticket:tradeTicket }
    return null
  }
  if (['bridge_sending', 'uncertain'].includes(status)) return { status:'uncertain', kind:null, ticket:null }
  return null
}

function buildSignalDeliveryRows({ signalId, userIds, onlineUserIds, promptTypeId, symbol, createdAt,
  signalType = null, pendingAction = null, executionValidation = null, executionExpired = false }) {
  const online = onlineUserIds instanceof Set ? onlineUserIds : new Set(onlineUserIds || [])
  const normalizedSignalType = String(signalType || '').trim().toLowerCase()
  const normalizedPendingAction = String(pendingAction || '').trim().toLowerCase()
  const holdWithoutCancel = normalizedSignalType === 'hold' && normalizedPendingAction !== 'cancel'
  const validationState = executionValidation?.validation
    ? executionValidation
    : readExecutionValidation(executionValidation || {})
  const validationRejected = validationState.validation.eligible !== true
  return [...new Set(userIds || [])].map(userId => {
    const isOnline = online.has(userId)
    if (validationRejected) {
      return {
        signalId,
        userId,
        promptTypeId,
        symbol,
        deliveryStatus:isOnline ? 'delivered' : 'stored_offline',
        // The signal remains visible, but an ineligible or malformed model
        // execution envelope is terminally skipped and can never enter the
        // recovery queue or auto-trade path.
        executionStatus:'skipped',
        executionResult:JSON.stringify({
          status:'skipped',
          reason:'execution_validation_ineligible',
          execution_validation:validationState.validation,
          history_available:true,
        }),
        createdAt,
      }
    }
    if (executionExpired) {
      return {
        signalId,
        userId,
        promptTypeId,
        symbol,
        deliveryStatus:isOnline ? 'delivered' : 'stored_offline',
        executionStatus:'skipped',
        executionResult:JSON.stringify({
          status:'skipped', reason:'market_snapshot_expired', history_available:true,
        }),
        createdAt,
      }
    }
    if (holdWithoutCancel) {
      return {
        signalId,
        userId,
        promptTypeId,
        symbol,
        deliveryStatus:isOnline ? 'delivered' : 'stored_offline',
        executionStatus:'skipped',
        executionResult:JSON.stringify({
          status:'skipped', reason:'hold_signal_no_execution', history_available:true,
        }),
        createdAt,
      }
    }
    return {
      signalId,
      userId,
      promptTypeId,
      symbol,
      deliveryStatus:isOnline ? 'delivered' : 'stored_offline',
      // Actionable signals stay recoverable even when the subscriber Bridge
      // was offline when the shared signal was written.
      executionStatus:'not_attempted',
      executionResult:null,
      createdAt,
    }
  })
}


// Test-only exports (not for production use)
export const __schedulerTest = {
  isUserEligibleForAutoExecution,
  calculateRecoverySeconds,
  selectOwnedStrategyPendingOrders,
  synchronousPendingCancelGroupIds,
  synchronousPendingCancelOriginSignalIds,
  selectFrozenSynchronousPendingDeliveries,
  resolvePendingActionGate,
  resolvePendingCancellationPlan,
  resolvePendingCancellationOutcome,
  buildSignalDeliveryRows,
  reconcileUnattemptedSignalDeliveries,
  signalDeliveryRecoveryDeadline,
  signalDeliveryRecoveryActionable,
  assertSignalDeliveryRecoveryTx,
  releaseUnsentDeliveryClaim,
  isFilledHistoryOrder,
  createLockGuard,
  discardSharedSignalForWeeklyWindow,
  executionRiskDecisionId,
  durableDeliveryRecovery,
  retryDelayMs,
  shouldLogSchedulerWait,
  schedulerWaitLabel,
  schedulerLockWaitSeconds,
  deliveryInventoryLockKey,
  acquireDeliveryInventoryLock,
  autoDeliveryWeeklyWindow,
  findDuplicateLivePending,
  nextCompletionIntervalDeadlineMs,
  completionIntervalCooldownSeconds,
  failedCycleCooldownSeconds,
  schedulerNextRunAt,
  schedulerRuntimeNextRunAt,
  autoModelTaskDomainId,
  checkAutoModelTaskGate,
  buildAutoModelTaskInput,
  enforcePlatformStrategyDirectionInterlock,
  assertAutoInferenceApplyGate,
  assertAutoInferenceBusinessGate,
  assertAutoInferenceOrderSendTx,
  schedulerUpdateMaintenanceReason,
  isMarketWaitReason,
  summarizeRuntimeMarketStates,
  getPeriodicRuntime: () => ({
    autoReconcilerInFlight:Boolean(_reconcileInFlight),
    autoReconcilerSkippedOverlap:_reconcileSkippedOverlap,
    pendingReconcilerInFlight:Boolean(_pendingReconcileInFlight),
    pendingReconcilerSkippedOverlap:_pendingSkippedOverlap,
    autoSchedulersStopping,
  }),
}
