// ai/index.js — 入口，re-export + Router

import { Router } from 'express'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { queryAll, queryOne, queryRun, withTransaction, beijingNow, logAudit } from '../../db.js'
import { authMiddleware } from '../../middleware/auth.js'
import { mt5Bridge, calculateMarketData } from './market-data.js'
import { maybeAiSignal, requestJsonObject } from './llm.js'
import { probeModelStreamCapability } from './model-transport-probe.js'
import { MODEL_PROVIDER_DEFAULTS, modelProviderProtocol } from './model-providers.js'
import { handleAnalyze, handleAnalyzeCompare, startHistoryCompareJob, getHistoryCompareJob,
  cancelHistoryCompareJob, listHistoryCompareJobs, deleteHistoryCompareJob,
  buildStrategyContextFromTags, startHistoryCompareRecoveryWorker } from './strategy.js'
import { initAutoSchedulers, startAutoScheduler, stopAutoScheduler, isAutoSchedulerRunning, reconcileAutoSchedulers, getUserAutoRuntimeStatus, removeUserRuntimeAutoSubscription } from './scheduler.js'
import { applyBridgeRuntimeState, getBridgeDiagnostics, getBridgePerformanceSummary, isBridgeAlive,
  getBridgeDataRoute, getBridgeGeneration, queueRiskSnapshotRecovery, sendToBrowsers } from '../../bridge-ws.js'
import { createAiAccessMiddleware } from './observer-access.js'
import { createObserverChannel, createObserverSource, deleteObserverChannel, deleteObserverSource,
  listObserverChannelAssignments, listObserverChannels, listObserverChannelsForUser, listObserverSources,
  replaceObserverChannelAssignments, resolveObserverSourceForUser,
  updateObserverChannel, updateObserverSource } from './observer-channels.js'
import { createObserverSourceAccount } from './observer-source-accounts.js'
import { synchronizeObserverSourceRuntime } from './observer-source-runtime.js'
import { canManagePlatformAiContent, isObserverSourceAccount } from './platform-content-access.js'
import { listReviewCases, getReviewCase, ensureReviewCaseForOutcome, getReviewAdminHealth } from './review-workflow.js'
import { dismissStrategyMemoryConflict, getOrCreateStrategyMemoryLibrary,
  getStrategyMemoryLibraryPreview,
  listStrategyMemoryConflicts, listStrategyMemoryLibraries, listStrategyMemoryLibraryRevisions,
  getStrategyMemoryCompressionJobStatus, getLatestStrategyMemoryCompressionJobStatus,
  queueStrategyMemoryCompressionJob, reopenStrategyMemoryConflict, resolveStrategyMemoryConflict,
  restoreStrategyMemoryLibraryRevision, saveStrategyMemoryLibrary } from './strategy-memory-library.js'
import { createModelProfile, getUserModelProfiles, updateModelProfile, getModelProfileDeletionImpact, deleteModelProfile,
  setDefaultModelProfile, getPlatformUsagePolicy, updatePlatformUsagePolicy,
  resolveOwnedModelProfileForRuntime, resolveAiTaskModel, saveModelProfileWithValidation,
  getModelPurposeBindings, setModelPurposeBinding, persistModelProfileVerification } from './model-profiles.js'
import { listStrategies, getStrategyById, createStrategy, updateStrategy, getStrategyDeletionPreview, deleteStrategy,
  listTradingAccounts, createTradingAccount, updateTradingAccount, deleteTradingAccount,
  listSubscriptions, createSubscription, updateSubscription, deleteSubscription } from './strategy-ownership.js'
import { buildStrategyDataCapabilitiesCatalog } from './strategy-policy.js'
import { resolveEffectiveRiskPolicy, submitRiskPolicyChanges, normalizePlatformRiskConfig, RISK_RULES, DEFAULT_RISK_POLICY } from './risk-policy.js'
import { setUserKillSwitch, setGlobalKillSwitch } from './risk-state.js'
import { refreshRecoverableRiskAccounts } from './risk-snapshot-refresh.js'
import { getEffectiveFeatureFlags, updateAiFeatureFlags, updateRiskRuleRollout, getAiRolloutHealth } from './rollout-governance.js'
import { rotateModelProfileCredentials, finalizeLegacyCredentialCleanup } from './model-profiles.js'
import { resolveBridgeInstallerRelease } from '../../bridge-installer-release.js'
import { stripBrokerSuffix } from './utils.js'

function riskRefreshFailure(error) {
  return { attempted:0, refreshed:0, recovered:0, still_halted:0,
    recoverable_remaining:0, results:[], pending_reason:'risk_refresh_failed',
    error:String(error?.message || error || 'risk_refresh_failed') }
}

function armRiskRecoveryIfNeeded(userId, result) {
  if (result?.bridge_connected !== false && Number(result?.recoverable_remaining || 0) > 0) {
    queueRiskSnapshotRecovery(userId)
  }
  return result
}
import { getInferencePreference, saveInferencePreference } from './inference-preferences.js'
import { prepareEligibleDailyReviews, prepareEligibleMonthlyReviews,
  runDailyReviewWorkerOnce, runMonthlyReviewWorkerOnce, listPeriodReviewCases, getPeriodReviewCase,
  editPeriodReviewCase, confirmPeriodReviewCase, retryPeriodReviewCase, getPeriodReviewSummary,
  markPeriodReviewRead, getPeriodReviewJobStatus, requestPeriodReviewCycle,
  retryPeriodReviewDerivation, regeneratePeriodReviewCase, periodReviewFrontendMetadata,
  periodReviewFrontendContractMismatch } from './period-review.js'
import { listModelSnapshotSamples } from './model-snapshot-samples.js'
import { translateAdminProfileError, updateAdminUserProfile } from './admin-user-profile.js'
import { getPositionManagementSettings, getPositionManagementTask, listPositionManagementTasks,
  savePositionManagementSettings, getPositionManagementAdminSettings,
  saveGlobalPositionManagementControl } from './position-management.js'
import { getPositionManagementWorkerStatus } from './position-management-worker.js'
import {
  getPositionGuardGlobalControl,
  getPositionGuardProfile,
  getUserPositionGuardSetting,
  listPositionGuardProfiles,
  savePositionGuardGlobalControl,
  savePositionGuardProfile,
  saveUserPositionGuardSetting,
} from './position-guard.js'
import {
  exactPositionGuardTarget,
  getPositionGuardMonitorStatus,
  requestPositionGuardMonitorRun,
} from '../../workers/position-guard-monitor-worker.js'
import { createManualAnalysisJob, getManualAnalysisJob, cancelManualAnalysisJob,
  startManualAnalysisJobs } from './manual-analysis-jobs.js'
import { startStrategyMemoryCompressionWorker, stopStrategyMemoryCompressionWorker,
  runStrategyMemoryCompressionOnce, recoverAbandonedStrategyMemoryCompressionModelTasks,
  requestStrategyMemoryCompressionCycle } from './strategy-memory-compression.js'
import { getLatestStrategyMemoryConsistencyJob, getStrategyMemoryConsistencyJob,
  queueStrategyMemoryConsistencyCheck, requestStrategyMemoryConsistencyCycle,
  runStrategyMemoryConsistencyOnce, startStrategyMemoryConsistencyWorker,
  stopStrategyMemoryConsistencyWorker } from './strategy-memory-consistency.js'
import { listEligibleManualTradeReviews, listManualTradeReviewStrategies, createManualTradeReview,
  listManualTradeReviews, getManualTradeReview, getManualTradeReviewJobStatus, editManualTradeReview,
  confirmManualTradeReview, retryManualTradeReview,
  startManualTradeReviewWorker, stopManualTradeReviewWorker } from './manual-trade-review.js'
import { createManualTradeReviewAggregate, listEligibleManualTradeReviewSources,
  listManualTradeReviewAggregates, getManualTradeReviewAggregate, getManualTradeReviewAggregateJobStatus,
  retryManualTradeReviewAggregate, requestManualTradeReviewAggregateCycle,
  startManualTradeReviewAggregateWorker, stopManualTradeReviewAggregateWorker } from './manual-trade-review-aggregate.js'

const router = Router()

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const BRIDGE_VERSION = readFileSync(join(__dirname, '../../../VERSION'), 'utf-8').trim()
const BRIDGE_RELEASE = resolveBridgeInstallerRelease()

// Connection validation uses the pending profile's physical maximum output.
// It deliberately has no separate thinking budget or hidden probe cap: the
// provider receives the same thinking setting and output contract that will be
// stored after a successful validation.
export const CONNECTION_TEST_DEFAULT_MAX_TOKENS = 393_216

export function normalizeModelThinkingEnabled(value) {
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized === '1' || normalized === 'true') return true
    if (normalized === '0' || normalized === 'false' || normalized === '') return false
  }
  return value === true || value === 1
}

export function resolveModelConnectionTestMaxTokens(model = {}) {
  const configured = Number(model.max_output_tokens)
  return Number.isSafeInteger(configured) && configured > 0
    ? configured : CONNECTION_TEST_DEFAULT_MAX_TOKENS
}

export function resolveModelConnectionTestConfig(model = {}) {
  const provider = model.provider || model.api_provider
  const thinkingEnabled = normalizeModelThinkingEnabled(model.thinking_enabled)
  return {
    provider,
    protocol: modelProviderProtocol(provider),
    maxTokens: resolveModelConnectionTestMaxTokens(model),
    thinkingEnabled,
    reasoningEffort: provider === 'kimi_code' && model.model_name === 'k3' ? 'max' : model.reasoning_effort,
    allowFollowupRequests: false,
  }
}

router.get('/bridge/version', (req, res, next) => {
  // This router is mounted at both /api and /aurum-api for AI compatibility.
  // Keep exactly one retired-client update surface.
  if (req.baseUrl !== '/api') return next()
  res.json({
    version: BRIDGE_RELEASE.version || BRIDGE_VERSION,
    build_date: BRIDGE_RELEASE.buildDate,
    full_url: BRIDGE_RELEASE.fullUrl,
    file_size: BRIDGE_RELEASE.fileSize,
    sha256: BRIDGE_RELEASE.sha256,
    v3: BRIDGE_RELEASE.v3 === true,
  })
})

router.get('/bridge/ws-health', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' })
  res.json({
    ok: true,
    serverTime: new Date().toISOString(),
    bridges: getBridgeDiagnostics(),
  })
})

// AI Lab access is server-authoritative. The frontend consumes the same
// context for presentation, while this middleware prevents direct API bypass.
router.use('/ai', authMiddleware, createAiAccessMiddleware({ isBridgeAlive }))

router.get('/ai/access-context', async (req, res) => {
  try {
    const observerSource = req.aiAccess?.mode === 'observer'
      ? await resolveObserverSourceForUser(req.user.id, req.user.effectivePlan, req.query.channel_id)
      : null
    const observerSourceUserId = observerSource && isBridgeAlive(Number(observerSource.bridge_user_id))
      ? Number(observerSource.bridge_user_id) : null
    res.json({
      ok:true,
      access:{ ...req.aiAccess, observer_source_available:Boolean(observerSourceUserId),
        observer_channel:observerSource ? {
          id:Number(observerSource.id), name:observerSource.name,
          slug:observerSource.slug, source_id:Number(observerSource.source_id),
          strategy_id:Number(observerSource.strategy_id),
        } : null },
    })
  } catch (error) { reviewError(res, error) }
})

router.get('/ai/observer-channels', async (req, res) => {
  try {
    const channels = await listObserverChannelsForUser(req.user.id, req.user.effectivePlan)
    res.json({ ok:true, channels:channels.map(channel => ({
      id:Number(channel.id), name:channel.name, slug:channel.slug,
      description:channel.description, is_default:Boolean(channel.is_default),
      online:isBridgeAlive(Number(channel.bridge_user_id)),
    })) })
  } catch (error) { reviewError(res, error) }
})

function reviewError(res, error) {
  const raw = String(error?.message || '')
  const code = /^[a-z][a-z0-9_]*(?::[a-z0-9_.-]+)*$/.test(raw) ? raw : null
  if (!code) {
    const incidentId = `ai_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    console.error(`[AI API ${incidentId}]`, error)
    return res.status(500).json({ ok:false, error:'ai_internal_error', incident_id:incidentId })
  }
  const status = code.includes('not_found') ? 404 : code.includes('conflict') || code === 'period_review_frontend_contract_mismatch' ? 409 : (code.includes('access_denied') || code.includes('forbidden') || code.includes('admin_required') || code.includes('admin_only') || code.includes('requires_admin') || code.includes('pro_access_required') || code === 'manual_trade_review_forbidden') ? 403 : 400
  return res.status(status).json({ ok: false, error: code })
}

function setPeriodReviewReadHeaders(res) {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
  res.set('Pragma', 'no-cache')
  res.set('Expires', '0')
}

function periodReviewReadHeaders(_req, res, next) {
  setPeriodReviewReadHeaders(res)
  return next()
}

function sendPeriodReviewReadResponse(res, payload) {
  return res.json({ ok:true, ...(payload || {}), ...periodReviewFrontendMetadata() })
}

function periodReviewFrontendContractGuard(req, res, next) {
  if (periodReviewFrontendContractMismatch(req)) {
    return res.status(409).json({ ok:false, error:'period_review_frontend_contract_mismatch' })
  }
  return next()
}

export function modelConnectionValidationError(error) {
  const providerStatus = Number(error?.providerStatus || error?.httpStatus)
  if (providerStatus === 401 || providerStatus === 403) return 'model_connection_auth_failed'
  if (providerStatus === 429) return 'model_connection_rate_limited'
  if (providerStatus === 404) return 'model_connection_model_unavailable'
  if (providerStatus === 400) return 'model_connection_request_rejected'
  const raw = String(error?.code || error?.message || '')
  if (raw === 'output_truncated' || raw === 'ai_response_missing_json_object'
      || raw === 'ai_response_not_object' || raw === 'model_connection_probe_invalid_response'
      || raw.startsWith('ai_response_invalid_')) return 'model_connection_output_incomplete'
  if (raw.includes('API key') || raw.includes('api_key')) return 'model_connection_invalid_api_key'
  return 'model_connection_unavailable'
}

const MODEL_CONNECTION_PROBE_TIMEOUT_MS = 30_000

/** Execute one bounded connection request followed by one bounded stream probe. */
export async function verifyPendingModelProfile(model = {}) {
  const provider = model.provider || model.api_provider
  const protocol = modelProviderProtocol(provider)
  const base = String(model.api_base_url || MODEL_PROVIDER_DEFAULTS[provider] || '').replace(/\/+$/, '')
  if (!base) throw new Error('unsupported_model_provider')
  const testConfig = resolveModelConnectionTestConfig({ ...model, max_output_tokens:model.max_output_tokens })
  const connectionTimeoutMs = Math.min(
    Math.max(1, Number(model.request_timeout_ms) || MODEL_CONNECTION_PROBE_TIMEOUT_MS),
    MODEL_CONNECTION_PROBE_TIMEOUT_MS,
  )
  const connectionStarted = Date.now()
  try {
    const result = await requestJsonObject({
      url:`${base}/${protocol === 'responses' ? 'responses' : 'chat/completions'}`,
      apiKey:model.api_key_encrypted, provider, model:model.model_name, temperature:0,
      maxTokens:testConfig.maxTokens, protocol, timeout:connectionTimeoutMs,
      thinkingEnabled:testConfig.thinkingEnabled, reasoningEffort:testConfig.reasoningEffort,
      messages:[{ role:'system', content:'Return exactly {"ok":true} as a json object.' }, { role:'user', content:'{"ok":true}' }],
      // The first request is intentionally non-streaming. The following
      // server-controlled probe is the only source of transport capability.
      capabilities:{ supports_stream:false, supports_request_id:false, verification_status:'unverified' },
      allowFollowupRequests:false, usageContext:null,
    })
    if (!result || typeof result !== 'object' || Array.isArray(result) || result.ok !== true) {
      throw new Error('model_connection_probe_invalid_response')
    }
    const connectionLatencyMs = Date.now() - connectionStarted
    const streaming = await probeModelStreamCapability(model, { timeoutMs:connectionTimeoutMs })
    const streamingVerified = streaming.status === 'supported' || streaming.status === 'unsupported'
    return {
      ok:true,
      verification:{
        connection:{ status:'passed', latency_ms:connectionLatencyMs },
        streaming,
      },
      capabilities:{
        provider:String(provider), model_name:String(model.model_name || ''),
        api_base_url:String(base), protocol:String(protocol),
        streaming_status:streaming.status,
        verification_status:streamingVerified ? 'verified' : 'unverified',
        verified_at_utc_msc:streamingVerified ? Date.now() : null,
        capability_source:'save_probe',
      },
    }
  } catch (error) {
    const stableCode = modelConnectionValidationError(error)
    const stable = new Error(stableCode)
    stable.code = stableCode
    stable.providerStatus = error?.providerStatus
    stable.cause = error
    throw stable
  }
}

function requireAiAdmin(req, res) {
  if (req.user?.role === 'admin') return true
  res.status(403).json({ ok:false, error:'admin_only' })
  return false
}

function requireManualTradeReviewManager(req, res) {
  if (canManagePlatformAiContent(req.user)) return true
  res.status(403).json({ ok:false, error:'manual_trade_review_forbidden' })
  return false
}

function auditAiMutation(req, action, targetType, targetId, detail = {}) {
  return logAudit({
    userId:req.user?.id, action, targetType, targetId,
    detail:JSON.stringify(detail || {}), ip:req.ip, userAgent:req.get?.('user-agent'),
  })
}

async function reconcileAiRuntime(userId = null) {
  try {
    const scheduler = await reconcileAutoSchedulers()
    let bridge = null
    if (Number(userId) > 0) {
      const active = await queryOne(`SELECT id FROM strategy_subscriptions
        WHERE user_id = ? AND is_deleted = 0 AND execution_enabled = 1 LIMIT 1`, [Number(userId)])
      bridge = await applyBridgeRuntimeState(Number(userId), {
        autoReasoningEnabled:Boolean(active),
      })
    }
    return { ok:true, scheduler, bridge }
  }
  catch (error) {
    console.error('[AI Runtime] reconcile failed:', error)
    return { ok:false, degraded:true, error:'scheduler_runtime_sync_pending' }
  }
}

router.get('/ai/admin/observer-sources', async (req, res) => {
  if (!requireAiAdmin(req, res)) return
  try {
    const sources = await listObserverSources()
    res.json({ ok:true, sources:sources.map(source => ({ ...source,
      bridge_online:isBridgeAlive(Number(source.bridge_user_id)),
    })) })
  } catch (error) { reviewError(res, error) }
})

router.get('/ai/admin/observer-source-candidates', async (req, res) => {
  if (!requireAiAdmin(req, res)) return
  try {
    const users = await queryAll(`SELECT id, email, nickname, role, plan, plan_source
      FROM users WHERE deletion_status = 'active' AND deleted_at IS NULL
        AND (role = 'admin' OR (plan = 'pro' AND (plan_expires_at IS NULL OR plan_expires_at >= NOW())
          AND (plan_source = 'observer_source' OR EXISTS (
            SELECT 1 FROM ai_observer_sources sources WHERE sources.bridge_user_id = users.id
          ))))
      ORDER BY role = 'admin' DESC, id`)
    const userIds = users.map(user => Number(user.id))
    const accounts = userIds.length ? await queryAll(`SELECT id, user_id, login_account, broker_server
      FROM trading_accounts WHERE is_deleted = 0 AND user_id IN (${userIds.map(() => '?').join(',')})
      ORDER BY user_id, updated_at DESC, id DESC`, userIds) : []
    res.json({ ok:true, candidates:users.map(user => ({ ...user,
      bridge_online:isBridgeAlive(Number(user.id)),
      accounts:accounts.filter(account => Number(account.user_id) === Number(user.id)),
    })) })
  } catch (error) { reviewError(res, error) }
})

router.post('/ai/admin/observer-source-accounts', async (req, res) => {
  if (!requireAiAdmin(req, res)) return
  try { res.status(201).json({ ok:true, account:await createObserverSourceAccount(req.user.id, req.body || {}) }) }
  catch (error) { reviewError(res, error) }
})

router.post('/ai/admin/observer-sources', async (req, res) => {
  if (!requireAiAdmin(req, res)) return
  try {
    const source = await createObserverSource(req.user.id, req.body || {})
    const runtime_sync = await synchronizeObserverSourceRuntime(source)
    await auditAiMutation(req, 'observer_source_created', 'ai_observer_source', source.id, {
      bridge_user_id:source.bridge_user_id, trading_account_id:source.trading_account_id,
      strategy_id:source.strategy_id, status:source.status,
    })
    res.status(201).json({ ok:true, source, runtime_sync })
  }
  catch (error) { reviewError(res, error) }
})

router.put('/ai/admin/observer-sources/:id', async (req, res) => {
  if (!requireAiAdmin(req, res)) return
  try {
    const source = await updateObserverSource(req.params.id, req.body || {})
    const runtime_sync = await synchronizeObserverSourceRuntime(source)
    await auditAiMutation(req, 'observer_source_updated', 'ai_observer_source', source.id, {
      bridge_user_id:source.bridge_user_id, trading_account_id:source.trading_account_id,
      strategy_id:source.strategy_id, status:source.status,
    })
    res.json({ ok:true, source, runtime_sync })
  }
  catch (error) { reviewError(res, error) }
})

router.delete('/ai/admin/observer-sources/:id', async (req, res) => {
  if (!requireAiAdmin(req, res)) return
  try {
    const deleted = await deleteObserverSource(req.params.id)
    const runtime_sync = await synchronizeObserverSourceRuntime(deleted, { deleted:true })
    await auditAiMutation(req, 'observer_source_deleted', 'ai_observer_source', deleted.id)
    res.json({ ok:true, deleted, runtime_sync })
  }
  catch (error) { reviewError(res, error) }
})

router.get('/ai/admin/observer-channels', async (req, res) => {
  if (!requireAiAdmin(req, res)) return
  try { res.json({ ok:true, channels:await listObserverChannels() }) }
  catch (error) { reviewError(res, error) }
})

router.post('/ai/admin/observer-channels', async (req, res) => {
  if (!requireAiAdmin(req, res)) return
  try { res.status(201).json({ ok:true, channel:await createObserverChannel(req.body || {}) }) }
  catch (error) { reviewError(res, error) }
})

router.put('/ai/admin/observer-channels/:id', async (req, res) => {
  if (!requireAiAdmin(req, res)) return
  try { res.json({ ok:true, channel:await updateObserverChannel(req.params.id, req.body || {}) }) }
  catch (error) { reviewError(res, error) }
})

router.delete('/ai/admin/observer-channels/:id', async (req, res) => {
  if (!requireAiAdmin(req, res)) return
  try { res.json({ ok:true, deleted:await deleteObserverChannel(req.params.id) }) }
  catch (error) { reviewError(res, error) }
})

router.get('/ai/admin/observer-channels/:id/assignments', async (req, res) => {
  if (!requireAiAdmin(req, res)) return
  try { res.json({ ok:true, assignments:await listObserverChannelAssignments(req.params.id) }) }
  catch (error) { reviewError(res, error) }
})

router.put('/ai/admin/observer-channels/:id/assignments', async (req, res) => {
  if (!requireAiAdmin(req, res)) return
  try { res.json({ ok:true, assignments:await replaceObserverChannelAssignments(
    req.params.id, req.user.id, req.body?.user_ids,
  ) }) }
  catch (error) { reviewError(res, error) }
})

router.get('/ai/inference-preferences', authMiddleware, async (req, res) => {
  try { res.json({ ok: true, preference: await getInferencePreference(req.user.id, req.query.session_id || 'default') }) }
  catch (error) { reviewError(res, error) }
})

router.put('/ai/inference-preferences', authMiddleware, async (req, res) => {
  try { res.json({ ok: true, preference: await saveInferencePreference(req.user.id, req.body?.session_id || 'default', req.body || {}) }) }
  catch (error) { reviewError(res, error) }
})

router.get('/ai/model-profiles', authMiddleware, async (req, res) => {
  try {
    const ownerId = req.user.role === 'admin' && req.query.scope === 'platform' ? 0 : req.user.id
    const profiles = await getUserModelProfiles(ownerId)
    res.json({ ok: true, profiles, credential_fields_redacted: true })
  } catch (error) { reviewError(res, error) }
})

router.get('/ai/model-purpose-bindings', authMiddleware, async (req, res) => {
  try {
    const requestedScope = String(req.query.scope || 'user').toLowerCase()
    if (!['user', 'platform'].includes(requestedScope)) throw new Error('model_purpose_scope_invalid')
    if (requestedScope === 'platform' && req.user.role !== 'admin') throw new Error('admin_only')
    const ownerUserId = requestedScope === 'platform' ? 0 : Number(req.user.id)
    res.json({ ok:true, ...(await getModelPurposeBindings(ownerUserId)) })
  } catch (error) { reviewError(res, error) }
})

router.put('/ai/model-purpose-bindings/:purpose', authMiddleware, async (req, res) => {
  try {
    const requestedScope = String(req.body?.scope || 'user').toLowerCase()
    if (!['user', 'platform'].includes(requestedScope)) throw new Error('model_purpose_scope_invalid')
    if (requestedScope === 'platform' && req.user.role !== 'admin') throw new Error('admin_only')
    const ownerUserId = requestedScope === 'platform' ? 0 : Number(req.user.id)
    const purpose = await setModelPurposeBinding({ ownerUserId, purposeKey:req.params.purpose,
      modelProfileId:req.body?.model_profile_id, updatedBy:req.user.id })
    await auditAiMutation(req, 'ai_model_purpose_binding_changed', 'ai_model_purpose', req.params.purpose, {
      scope:requestedScope, owner_user_id:ownerUserId, model_profile_id:purpose.model_profile_id,
    })
    const listing = await getModelPurposeBindings(ownerUserId)
    const assignment = listing.purposes.find(item => item.purpose_key === String(req.params.purpose || '')) || purpose
    res.json({ ok:true, ...assignment, purposes:listing.purposes, bindings:listing.bindings })
  } catch (error) { reviewError(res, error) }
})

router.post('/ai/model-profiles', authMiddleware, async (req, res) => {
  try {
    const profile = await saveModelProfileWithValidation({ userId:req.user.id, payload:req.body || {},
      callerRole:req.user.role, verify:verifyPendingModelProfile })
    await auditAiMutation(req, 'ai_model_profile_created', 'ai_model_profile', profile.id, {
      scope:profile.scope, provider:profile.provider, model_name:profile.model_name,
    })
    res.json({ ok:true, profile, verification:profile?.verification || null })
  }
  catch (error) { reviewError(res, error) }
})

router.put('/ai/model-profiles/:id', authMiddleware, async (req, res) => {
  try {
    const profile = await saveModelProfileWithValidation({ id:Number(req.params.id),
      userId:req.body?.scope === 'platform' && req.user.role === 'admin' ? 0 : req.user.id,
      callerRole:req.user.role, payload:req.body || {}, verify:verifyPendingModelProfile })
    await auditAiMutation(req, 'ai_model_profile_updated', 'ai_model_profile', profile.id, {
      scope:profile.scope, provider:profile.provider, model_name:profile.model_name,
      credential_rotated:Boolean(req.body?.api_key),
    })
    res.json({ ok:true, profile, verification:profile?.verification || null })
  }
  catch (error) { reviewError(res, error) }
})

router.get('/ai/model-profiles/:id/delete-impact', authMiddleware, async (req, res) => {
  try {
    const ownerId = req.user.role === 'admin' && req.query.scope === 'platform' ? 0 : req.user.id
    res.json({ ok: true, impact: await getModelProfileDeletionImpact(Number(req.params.id), ownerId) })
  } catch (error) { reviewError(res, error) }
})

router.delete('/ai/model-profiles/:id', authMiddleware, async (req, res) => {
  try {
    await deleteModelProfile(Number(req.params.id), req.query.scope === 'platform' && req.user.role === 'admin' ? 0 : req.user.id, req.body || {})
    await auditAiMutation(req, 'ai_model_profile_deleted', 'ai_model_profile', Number(req.params.id))
    res.json({ ok:true })
  }
  catch (error) { reviewError(res, error) }
})

router.post('/ai/model-profiles/:id/default', authMiddleware, async (req, res) => {
  try {
    await setDefaultModelProfile(req.user.role === 'admin' && req.body?.scope === 'platform' ? 0 : req.user.id, Number(req.params.id))
    await auditAiMutation(req, 'ai_model_profile_default_changed', 'ai_model_profile', Number(req.params.id), {
      scope:req.body?.scope === 'platform' ? 'platform' : 'user',
    })
    res.json({ ok:true })
  }
  catch (error) { reviewError(res, error) }
})

router.post('/ai/model-profiles/:id/test', authMiddleware, async (req, res) => {
  try {
    const ownerId = req.user.role === 'admin' && req.body?.scope === 'platform' ? 0 : req.user.id
    const resolved = await resolveOwnedModelProfileForRuntime(Number(req.params.id), ownerId)
    if (!resolved.model) throw new Error(resolved.error || 'model_unavailable')
    const verification = await verifyPendingModelProfile(resolved.model)
    const profile = await persistModelProfileVerification({
      profileId:resolved.model_profile_id, userId:ownerId, actorUserId:req.user.id,
      expectedUpdatedAt:resolved.model.profile_updated_at, verification,
    })
    const stream = verification.verification?.streaming || {}
    await auditAiMutation(req, 'ai_model_profile_transport_verified', 'ai_model_profile', resolved.model_profile_id, {
      provider:resolved.model.provider, model_name:resolved.model.model_name,
      streaming_status:stream.status, first_delta_ms:stream.first_delta_ms,
      total_latency_ms:stream.total_latency_ms,
    })
    res.json({ ok:true,
      latency_ms:Number(stream.total_latency_ms || verification.verification?.connection?.latency_ms || 0),
      provider:resolved.model.provider, model_name:resolved.model.model_name,
      response_valid:true, verification:verification.verification || null, profile,
    })
  } catch (error) { reviewError(res, error) }
})


router.post('/ai/analyze-compare', authMiddleware, async (req, res) => {
  try {
    const access = await queryOne(`SELECT role, plan, plan_expires_at,
      (role = 'admin' OR (plan = 'pro' AND (plan_expires_at IS NULL OR plan_expires_at >= NOW()))) AS has_pro_access
      FROM users WHERE id = ?`, [req.user.id])
    if (!access || !Number(access.has_pro_access)) {
      return res.status(403).json({ ok: false, error: 'pro_access_required' })
    }
    res.json(await handleAnalyzeCompare(req.user.id, req.body || {}))
  }
  catch (error) { reviewError(res, error) }
})


router.post('/ai/model-compare/history', authMiddleware, async (req, res) => {
  try { res.status(202).json({ ok: true, job: await startHistoryCompareJob(req.user.id, req.body || {}) }) }
  catch (error) { reviewError(res, error) }
})

router.get('/ai/model-compare/snapshots', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok:false, error:'admin_only' })
  try { res.json({ ok:true, ...await listModelSnapshotSamples(req.user.id, req.query || {}) }) }
  catch (error) { reviewError(res, error) }
})

router.get('/ai/model-compare/history', authMiddleware, async (req, res) => {
  try { res.json({ ok: true, jobs: await listHistoryCompareJobs(req.user.id, req.query.limit) }) }
  catch (error) { reviewError(res, error) }
})

router.get('/ai/model-compare/history/:jobId', authMiddleware, async (req, res) => {
  try { res.json({ ok: true, job: await getHistoryCompareJob(req.user.id, req.params.jobId) }) }
  catch (error) { reviewError(res, error) }
})

router.delete('/ai/model-compare/history/:jobId', authMiddleware, async (req, res) => {
  try {
    const job = req.query.mode === 'delete'
      ? await deleteHistoryCompareJob(req.user.id, req.params.jobId)
      : await cancelHistoryCompareJob(req.user.id, req.params.jobId)
    res.json({ ok: true, job })
  }
  catch (error) { reviewError(res, error) }
})
router.get('/ai/platform-model-policy', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false, error: 'admin_only' })
  try { res.json({ ok: true, policy: await getPlatformUsagePolicy() }) }
  catch (error) { reviewError(res, error) }
})

router.put('/ai/platform-model-policy', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false, error: 'admin_only' })
  try { res.json({ ok: true, policy: await updatePlatformUsagePolicy(req.body || {}) }) }
  catch (error) { reviewError(res, error) }
})

router.get('/ai/feature-flags', authMiddleware, async (req, res) => {
  try { res.json({ ok: true, flags: await getEffectiveFeatureFlags(req.user.id) }) }
  catch (error) { reviewError(res, error) }
})

router.put('/ai/feature-flags', authMiddleware, async (req, res) => {
  try { res.json({ ok: true, flags: await updateAiFeatureFlags({ actorId:req.user.id, actorRole:req.user.role, targetUserId:req.user.id, flags:req.body || {} }) }) }
  catch (error) { reviewError(res, error) }
})

router.get('/ai/admin/rollout-health', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok:false, error:'admin_only' })
  try { res.json({ ok:true, health:await getAiRolloutHealth() }) }
  catch (error) { reviewError(res, error) }
})

router.put('/ai/admin/feature-flags', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok:false, error:'admin_only' })
  try { res.json({ ok:true, flags:await updateAiFeatureFlags({ actorId:req.user.id, actorRole:req.user.role, targetUserId:req.body?.user_id || null, flags:req.body?.flags || {} }) }) }
  catch (error) { reviewError(res, error) }
})

router.put('/ai/admin/risk-rule-rollouts/:ruleCode', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok:false, error:'admin_only' })
  try { res.json({ ok:true, rollout:await updateRiskRuleRollout({ actorId:req.user.id, actorRole:req.user.role, ruleCode:req.params.ruleCode, mode:req.body?.mode }) }) }
  catch (error) { reviewError(res, error) }
})

router.post('/ai/admin/credentials/rotate', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok:false, error:'admin_only' })
  try { res.json({ ok:true, result:await rotateModelProfileCredentials() }) }
  catch (error) { reviewError(res, error) }
})

router.post('/ai/admin/credentials/finalize-legacy-cleanup', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok:false, error:'admin_only' })
  if (req.body?.confirm !== 'CLEAR_VERIFIED_LEGACY_CREDENTIALS') return res.status(400).json({ ok:false, error:'explicit_confirmation_required' })
  try { res.json({ ok:true, result:await finalizeLegacyCredentialCleanup() }) }
  catch (error) { reviewError(res, error) }
})

router.get('/ai/model-source', authMiddleware, async (req, res) => {
  try {
    const usage = String(req.query.usage || 'manual')
    const strategyId = req.query.strategy_id ? Number(req.query.strategy_id) : null
    const requestedPurpose = req.query.model_purpose ? String(req.query.model_purpose) : null
    const purposeByUsage = {
      manual:'manual_analysis', auto_private:'auto_inference', auto_platform:'auto_inference',
      memory_compression:'memory_compression', memory_consistency:'memory_consistency',
    }
    const modelPurpose = requestedPurpose || purposeByUsage[usage] || undefined
    const resolved = await resolveAiTaskModel({ userId: req.user.id, strategyId, usage, modelPurpose })
    res.json({ ok: true, source: {
      available: Boolean(resolved.model), credential_source: resolved.credential_source,
      reason: resolved.reason || null, error: resolved.error || null,
      model_profile_id: resolved.model_profile_id || null,
      provider: resolved.model?.provider || null, model_name: resolved.model?.model_name || null,
      usage: resolved.usage, strategy_id: resolved.strategy_id || null,
      purpose: resolved.purpose || resolved.model_purpose || modelPurpose || null,
      model_purpose: resolved.model_purpose || resolved.purpose || modelPurpose || null,
      resolution_source: resolved.resolution_source || null,
      resolution_reason: resolved.resolution_reason || null,
    } })
  } catch (error) { reviewError(res, error) }
})

router.get('/ai/strategies', authMiddleware, async (req, res) => {
  try {
    const observerSource = isObserverSourceAccount(req.user)
    const strategyRole = canManagePlatformAiContent(req.user) ? 'admin' : req.user.role
    const [strategies, subscriptions, accounts] = await Promise.all([
      listStrategies(req.user.id, strategyRole, {
        scope: observerSource ? 'platform' : (req.query.scope || undefined),
        includeInactive: req.query.include_inactive === '1',
      }),
      listSubscriptions(req.user.id, req.user.role),
      listTradingAccounts(req.user.id),
    ])
    res.json({ ok: true, strategies, subscriptions, accounts })
  }
  catch (error) { reviewError(res, error) }
})

router.get('/ai/strategy-data-capabilities', authMiddleware, (req, res) => {
  res.json({ ok:true, capabilities:buildStrategyDataCapabilitiesCatalog() })
})

router.get('/ai/strategies/:id', authMiddleware, async (req, res) => {
  try {
    const strategyRole = canManagePlatformAiContent(req.user) ? 'admin' : req.user.role
    const strategy = await getStrategyById(Number(req.params.id), req.user.id, strategyRole)
    if (isObserverSourceAccount(req.user) && strategy?.scope !== 'platform') return res.status(404).json({ ok:false, error:'strategy_not_found' })
    if (!strategy) return res.status(404).json({ ok:false, error:'strategy_not_found' })
    res.json({ ok:true, strategy })
  } catch (error) { reviewError(res, error) }
})

router.post('/ai/strategies', authMiddleware, async (req, res) => {
  try {
    const strategyRole = canManagePlatformAiContent(req.user) ? 'admin' : req.user.role
    const payload = isObserverSourceAccount(req.user) ? { ...(req.body || {}), scope:'platform' } : (req.body || {})
    const strategy = await createStrategy(req.user.id, strategyRole, payload)
    await auditAiMutation(req, 'ai_strategy_created', 'ai_strategy', strategy.id, {
      scope:strategy.scope, visibility_status:strategy.visibility_status,
    })
    res.json({ ok:true, strategy })
  }
  catch (error) { reviewError(res, error) }
})

router.put('/ai/strategies/:id', authMiddleware, async (req, res) => {
  try {
    const strategyRole = canManagePlatformAiContent(req.user) ? 'admin' : req.user.role
    if (isObserverSourceAccount(req.user)) {
      const existing = await getStrategyById(Number(req.params.id), req.user.id, strategyRole)
      if (!existing || existing.scope !== 'platform') return res.status(404).json({ ok:false, error:'strategy_not_found' })
    }
    const strategy = await updateStrategy(Number(req.params.id), req.user.id, strategyRole, req.body || {})
    let consistencyJob = null
    try {
      consistencyJob = await queueStrategyMemoryConsistencyCheck({ strategyId:strategy.id,
        strategyVersion:strategy.version, triggerType:'strategy_save' })
      if (consistencyJob.created) requestStrategyMemoryConsistencyCycle()
    } catch (error) { console.error('[StrategyMemory] consistency queue after strategy save:', error.message) }
    const runtime_sync = await reconcileAiRuntime()
    await auditAiMutation(req, 'ai_strategy_updated', 'ai_strategy', strategy.id, {
      scope:strategy.scope, visibility_status:strategy.visibility_status, version:strategy.version,
    })
    res.json({ ok:true, strategy, runtime_sync, consistency_job_id:consistencyJob?.id || null })
  }
  catch (error) { reviewError(res, error) }
})

router.get('/ai/strategies/:id/delete-preview', authMiddleware, async (req, res) => {
  try {
    const strategyRole = canManagePlatformAiContent(req.user) ? 'admin' : req.user.role
    if (isObserverSourceAccount(req.user)) {
      const existing = await getStrategyById(Number(req.params.id), req.user.id, strategyRole)
      if (!existing || existing.scope !== 'platform') return res.status(404).json({ ok:false, error:'strategy_not_found' })
    }
    res.json({ ok:true, preview:await getStrategyDeletionPreview(Number(req.params.id), req.user.id, strategyRole) })
  }
  catch (error) { reviewError(res, error) }
})

router.delete('/ai/strategies/:id', authMiddleware, async (req, res) => {
  try {
    const strategyRole = canManagePlatformAiContent(req.user) ? 'admin' : req.user.role
    if (isObserverSourceAccount(req.user)) {
      const existing = await getStrategyById(Number(req.params.id), req.user.id, strategyRole)
      if (!existing || existing.scope !== 'platform') return res.status(404).json({ ok:false, error:'strategy_not_found' })
    }
    const deleted = await deleteStrategy(Number(req.params.id), req.user.id, strategyRole, req.body || {})
    const runtime_sync = await reconcileAiRuntime()
    res.json({ ok:true, deleted, runtime_sync })
  }
  catch (error) { reviewError(res, error) }
})

router.get('/ai/trading-accounts', authMiddleware, async (req, res) => {
  try { res.json({ ok:true, accounts:await listTradingAccounts(req.user.id) }) }
  catch (error) { reviewError(res, error) }
})

router.post('/ai/trading-accounts', authMiddleware, async (req, res) => {
  try {
    const account = await createTradingAccount(req.user.id, req.body || {})
    await auditAiMutation(req, 'trading_account_created', 'trading_account', account.id, {
      observe_status:account.observe_status,
    })
    res.json({ ok:true, account })
  }
  catch (error) { reviewError(res, error) }
})

router.put('/ai/trading-accounts/:id', authMiddleware, async (req, res) => {
  try {
    const account = await updateTradingAccount(Number(req.params.id), req.user.id, req.body || {})
    await auditAiMutation(req, 'trading_account_updated', 'trading_account', account.id, {
      nickname_changed:Object.prototype.hasOwnProperty.call(req.body || {}, 'nickname'),
    })
    res.json({ ok:true, account })
  }
  catch (error) { reviewError(res, error) }
})

router.delete('/ai/trading-accounts/:id', authMiddleware, async (req, res) => {
  try {
    await deleteTradingAccount(Number(req.params.id), req.user.id)
    const runtime_sync = await reconcileAiRuntime()
    await auditAiMutation(req, 'trading_account_deleted', 'trading_account', Number(req.params.id))
    res.json({ ok:true, runtime_sync })
  }
  catch (error) { reviewError(res, error) }
})

router.post('/ai/subscriptions', authMiddleware, async (req, res) => {
  try {
    const subscription = await createSubscription(req.user.id, req.user.role, req.body || {})
    const runtime_sync = await reconcileAiRuntime(req.user.id)
    await auditAiMutation(req, 'ai_strategy_subscription_created', 'strategy_subscription', subscription.id, {
      strategy_id:subscription.strategy_id, trading_account_id:subscription.trading_account_id,
      execution_enabled:Boolean(subscription.execution_enabled),
    })
    res.json({ ok:true, subscription, runtime_sync })
  }
  catch (error) { reviewError(res, error) }
})

router.put('/ai/subscriptions/:id', authMiddleware, async (req, res) => {
  try {
    const subscription = await updateSubscription(Number(req.params.id), req.user.id, req.user.role, req.body || {})
    const runtime_sync = await reconcileAiRuntime(req.user.id)
    await auditAiMutation(req, 'ai_strategy_subscription_updated', 'strategy_subscription', subscription.id, {
      strategy_id:subscription.strategy_id, trading_account_id:subscription.trading_account_id,
      execution_enabled:Boolean(subscription.execution_enabled),
    })
    res.json({ ok:true, subscription, runtime_sync })
  }
  catch (error) { reviewError(res, error) }
})

router.delete('/ai/subscriptions/:id', authMiddleware, async (req, res) => {
  try {
    await deleteSubscription(Number(req.params.id), req.user.id)
    const scheduler = await getUserAutoRuntimeStatus(req.user.id)
    if (!scheduler.enabled) await removeUserRuntimeAutoSubscription(req.user.id)
    const runtime_sync = await reconcileAiRuntime(req.user.id)
    await auditAiMutation(req, 'ai_strategy_subscription_deleted', 'strategy_subscription', Number(req.params.id))
    res.json({ ok:true, scheduler, runtime_sync })
  }
  catch (error) { reviewError(res, error) }
})

router.get('/ai/risk-center', authMiddleware, async (req, res) => {
  try {
    const accounts = (await listTradingAccounts(req.user.id))
      .filter(account => Number(account.is_active) === 1)
    const subscriptions = await listSubscriptions(req.user.id, req.user.role)
    const rows = await Promise.all(accounts.map(async account => {
      const [riskState, performance, effective] = await Promise.all([
        queryAll(`SELECT halt_status, halt_reason, business_date, day_start_equity, day_realized_net,
          day_floating_pnl, equity_high_water, manual_reset_business_date,
          CASE WHEN day_start_equity > 0
            THEN GREATEST(0, -(day_realized_net + CASE
              WHEN manual_reset_business_date = business_date THEN day_floating_pnl
              ELSE LEAST(0, day_floating_pnl)
            END) / day_start_equity * 100)
            ELSE NULL END AS daily_loss_pct,
          drawdown_pct, consecutive_losses,
          cooldown_until, user_kill_switch, data_complete, data_incomplete_reason, last_risk_snapshot_at,
          halt_started_at, halt_reason_changed_at, last_recovered_at,
          (SELECT mds.timezone_offset_minutes FROM market_data_sources mds
            WHERE mds.bridge_user_id = ras.user_id
              AND UPPER(COALESCE(mds.broker_server, '')) = UPPER(ta.broker_server)
              AND CAST(COALESCE(mds.account_login, 0) AS CHAR) = CAST(ta.login_account AS CHAR)
            ORDER BY mds.last_calibrated_at DESC, mds.id DESC LIMIT 1) AS timezone_offset_minutes,
          (SELECT mds.clock_status FROM market_data_sources mds
            WHERE mds.bridge_user_id = ras.user_id
              AND UPPER(COALESCE(mds.broker_server, '')) = UPPER(ta.broker_server)
              AND CAST(COALESCE(mds.account_login, 0) AS CHAR) = CAST(ta.login_account AS CHAR)
            ORDER BY mds.last_calibrated_at DESC, mds.id DESC LIMIT 1) AS clock_status
          FROM risk_account_state ras JOIN trading_accounts ta ON ta.id = ras.trading_account_id
          WHERE ras.trading_account_id = ? LIMIT 1`, [account.id]),
        getBridgePerformanceSummary(req.user.id, account.id),
        resolveEffectiveRiskPolicy({ userId: req.user.id, tradingAccountId: account.id }),
      ])
      return { account, risk_state: riskState[0] || null, performance, effective,
        subscriptions: subscriptions.filter(item => Number(item.trading_account_id) === Number(account.id)) }
    }))
    res.json({ ok: true, accounts: rows, rule_metadata: RISK_RULES })
  } catch (error) { reviewError(res, error) }
})

router.post('/ai/risk-center/refresh', authMiddleware, async (req, res) => {
  try {
    const accountId = Number(req.body?.account_id || 0) || null
    const refreshed = await refreshRecoverableRiskAccounts(req.user.id, {
      accountId, trigger:'risk_center_manual',
    })
    armRiskRecoveryIfNeeded(req.user.id, refreshed)
    res.json({ ok:true, ...refreshed })
  }
  catch (error) { reviewError(res, error) }
})

router.post('/ai/risk-center/:accountId/manual-reset', authMiddleware, async (req, res) => {
  try {
    const accountId = Number(req.params.accountId || 0)
    if (!Number.isSafeInteger(accountId) || accountId <= 0) {
      return res.status(400).json({ ok:false, error:'account_id_invalid' })
    }
    const reason = String(req.body?.reason || '').trim()
    if (!reason) return res.status(400).json({ ok:false, error:'manual_reset_reason_required' })
    const reset = await refreshRecoverableRiskAccounts(req.user.id, {
      accountId,
      forceReset:true,
      resetReason:reason,
      trigger:'risk_center_manual_reset',
    })
    res.json({ ok:true, ...reset })
  } catch (error) { reviewError(res, error) }
})

router.post('/ai/risk-center/:accountId/kill-switch', authMiddleware, async (req, res) => {
  try {
    await setUserKillSwitch(req.user.id, Number(req.params.accountId), Boolean(req.body?.enabled), req.body?.reason)
    res.json({ ok: true })
  } catch (error) { reviewError(res, error) }
})

router.put('/ai/risk-center/:accountId', authMiddleware, async (req, res) => {
  try {
    const accountId = Number(req.params.accountId)
    const account = await queryAll('SELECT id FROM trading_accounts WHERE id = ? AND user_id = ? AND is_deleted = 0 LIMIT 1', [accountId, req.user.id])
    if (!account[0]) return res.status(404).json({ ok: false, error: 'account_not_found' })
    let sets = await queryAll("SELECT * FROM risk_policy_sets WHERE scope = 'account' AND owner_user_id = ? AND trading_account_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1", [req.user.id, accountId])
    if (!sets[0]) {
      const now = new Date(Date.now() + 8 * 3600_000).toISOString().replace('T', ' ').slice(0, 19)
      const inserted = await queryRun(`INSERT INTO risk_policy_sets (scope, owner_user_id, trading_account_id, name, status, created_at, updated_at) VALUES ('account', ?, ?, ?, 'active', ?, ?)`, [req.user.id, accountId, `账户 ${accountId} 自定义风控`, now, now])
      sets = [{ id: inserted.insertId }]
    }
    const result = await submitRiskPolicyChanges({ policySetId: sets[0].id, actorId: req.user.id, changes: req.body?.changes || {}, reason: req.body?.reason || '用户更新账户风控' })
    let risk_refresh
    try {
      risk_refresh = await refreshRecoverableRiskAccounts(req.user.id, {
        accountId, includeActive:true, trigger:'policy_save',
      })
    } catch (error) { risk_refresh = riskRefreshFailure(error) }
    armRiskRecoveryIfNeeded(req.user.id, risk_refresh)
    res.json({ ok:true, result, risk_refresh })
  } catch (error) { reviewError(res, error) }
})

router.get('/ai/position-management/settings', async (req, res) => {
  try { res.json({ ok:true, ...(await getPositionManagementSettings(req.user.id)) }) }
  catch (error) { reviewError(res, error) }
})

router.put('/ai/position-management/settings', async (req, res) => {
  try { res.json({ ok:true, ...(await savePositionManagementSettings(req.user.id, req.body || {})) }) }
  catch (error) { reviewError(res, error) }
})

async function positionGuardUserStatus(userId, tradingAccountId) {
  const [setting, control, eligibleRows, profiles] = await Promise.all([
    getUserPositionGuardSetting({ userId, tradingAccountId }),
    getPositionGuardGlobalControl(),
    queryAll(`SELECT outcomes.*
      FROM signal_outcomes outcomes
      INNER JOIN mt5_account_ownership_history ownership
        ON ownership.id = outcomes.ownership_history_id
        AND ownership.user_id = outcomes.user_id
        AND ownership.trading_account_id = outcomes.trading_account_id
        AND ownership.ended_at IS NULL
      WHERE outcomes.user_id = ? AND outcomes.trading_account_id = ?
        AND outcomes.status = 'open' AND outcomes.attribution_status = 'attributed'
        AND outcomes.external_intervention = 0 AND outcomes.position_id IS NOT NULL
        AND outcomes.system_magic = 234000`, [userId, tradingAccountId]),
    listPositionGuardProfiles(),
  ])
  const activeSymbols = new Set(profiles
    .filter(profile => profile.status === 'active' && profile.current_version_id)
    .map(profile => profile.standard_symbol))
  const profiledRows = eligibleRows.filter(row => activeSymbols.has(
    stripBrokerSuffix(String(row.original_symbol || row.symbol || '')).toUpperCase()))
  const bridgeOnline = isBridgeAlive(Number(userId))
  let bridgeDataReady = bridgeOnline && profiledRows.length === 0
  let qualifiedCount = 0
  if (bridgeOnline && profiledRows.length > 0) {
    const route = getBridgeDataRoute(userId, tradingAccountId, { strictAccount:true })
    if (route) {
      const inventory = await mt5Bridge(userId, 'system_trade_inventory', {
        terminal_instance_id:route.terminal_instance_id,
        account_ref:route.account_ref,
      }, { noFallback:true, timeoutMs:5_000, expectedGeneration:getBridgeGeneration(userId) })
        .catch(() => null)
      if (inventory?.status === 'success') {
        bridgeDataReady = true
        qualifiedCount = profiledRows.filter(row => exactPositionGuardTarget(row, inventory)).length
      }
    }
  }
  let runtimeStatus = 'disabled'
  let reason = '当前账号默认关闭'
  if (setting.enabled && !control.enabled) {
    runtimeStatus = 'paused'
    reason = '平台自动盯盘总闸已关闭'
  } else if (setting.enabled && !bridgeOnline) {
    runtimeStatus = 'paused'
    reason = '交易终端离线，等待恢复'
  } else if (setting.enabled && !bridgeDataReady) {
    runtimeStatus = 'paused'
    reason = '当前交易账号终端路由或持仓数据暂不可用'
  } else if (setting.enabled) {
    runtimeStatus = 'running'
    reason = '正在按平台参数检查合格系统持仓'
  }
  return {
    ...setting,
    runtime_status:runtimeStatus,
    reason,
    platform_enabled:control.enabled,
    bridge_connected:bridgeOnline,
    qualified_position_count:qualifiedCount,
  }
}

router.get('/ai/position-guard/settings', async (req, res) => {
  try {
    const tradingAccountId = Number(req.query.trading_account_id)
    res.json({ ok:true, settings:await positionGuardUserStatus(req.user.id, tradingAccountId) })
  } catch (error) { reviewError(res, error) }
})

router.put('/ai/position-guard/settings', async (req, res) => {
  try {
    const tradingAccountId = Number(req.body?.trading_account_id)
    const setting = await saveUserPositionGuardSetting({
      userId:req.user.id,
      tradingAccountId,
      enabled:req.body?.enabled,
    })
    await auditAiMutation(req, 'position_guard_setting_updated', 'trading_account', tradingAccountId, {
      enabled:setting.enabled,
    })
    sendToBrowsers(Number(req.user.id), {
      type:'position_guard_settings_updated', trading_account_id:tradingAccountId, refresh:true,
    })
    requestPositionGuardMonitorRun()
    res.json({ ok:true, settings:await positionGuardUserStatus(req.user.id, tradingAccountId) })
  } catch (error) { reviewError(res, error) }
})

router.get('/ai/admin/position-guard/profiles', async (req, res) => {
  if (!requireAiAdmin(req, res)) return
  try {
    res.json({ ok:true, profiles:await listPositionGuardProfiles({
      includeConfig:true, adminUserId:req.user.id,
    }) })
  } catch (error) { reviewError(res, error) }
})

router.get('/ai/admin/position-guard/profiles/:standardSymbol', async (req, res) => {
  if (!requireAiAdmin(req, res)) return
  try {
    const profile = await getPositionGuardProfile({
      standardSymbol:req.params.standardSymbol,
      includeConfig:true,
      adminUserId:req.user.id,
    })
    if (!profile) throw new Error('position_guard_profile_not_found')
    res.json({ ok:true, profile })
  } catch (error) { reviewError(res, error) }
})

router.put('/ai/admin/position-guard/profiles/:standardSymbol', async (req, res) => {
  if (!requireAiAdmin(req, res)) return
  try {
    const profile = await savePositionGuardProfile({
      adminUserId:req.user.id,
      standardSymbol:req.params.standardSymbol,
      config:req.body?.config,
      status:req.body?.status,
      reason:req.body?.reason,
    })
    await auditAiMutation(req, 'position_guard_profile_version_created', 'position_guard_profile',
      profile.id, { standard_symbol:profile.standard_symbol, version_no:profile.version_no,
        config_hash:profile.config_hash, reason:req.body?.reason })
    requestPositionGuardMonitorRun()
    for (const row of await queryAll(`SELECT DISTINCT user_id FROM user_position_guard_settings WHERE enabled = 1`)) {
      sendToBrowsers(Number(row.user_id), { type:'position_guard_status_updated', refresh:true })
    }
    res.json({ ok:true, profile })
  } catch (error) { reviewError(res, error) }
})

router.get('/ai/admin/position-guard/control', async (req, res) => {
  if (!requireAiAdmin(req, res)) return
  try {
    res.json({ ok:true, control:await getPositionGuardGlobalControl(),
      worker:getPositionGuardMonitorStatus() })
  } catch (error) { reviewError(res, error) }
})

router.put('/ai/admin/position-guard/control', async (req, res) => {
  if (!requireAiAdmin(req, res)) return
  try {
    const control = await savePositionGuardGlobalControl({
      adminUserId:req.user.id,
      enabled:req.body?.enabled,
      reason:req.body?.reason,
    })
    await auditAiMutation(req, 'position_guard_control_updated', 'global_position_guard_control', 1, {
      enabled:control.enabled, reason:control.reason,
    })
    requestPositionGuardMonitorRun()
    for (const row of await queryAll(`SELECT DISTINCT user_id FROM user_position_guard_settings WHERE enabled = 1`)) {
      sendToBrowsers(Number(row.user_id), { type:'position_guard_status_updated', refresh:true })
    }
    res.json({ ok:true, control, worker:getPositionGuardMonitorStatus() })
  } catch (error) { reviewError(res, error) }
})

router.get('/ai/position-management', async (req, res) => {
  try {
    res.json({ ok:true, ...(await listPositionManagementTasks({
      userId:req.user.id,
      status:req.query.status || null,
      page:req.query.page,
      pageSize:req.query.page_size,
    })) })
  } catch (error) { reviewError(res, error) }
})

router.get('/ai/position-management/:taskId', async (req, res) => {
  try {
    const detail = await getPositionManagementTask(Number(req.params.taskId), { userId:req.user.id })
    if (!detail) return res.status(404).json({ ok:false, error:'position_management_task_not_found' })
    res.json({ ok:true, ...detail })
  } catch (error) { reviewError(res, error) }
})

router.get('/ai/admin/position-management', async (req, res) => {
  if (!requireAiAdmin(req, res)) return
  try {
    res.json({ ok:true, ...(await listPositionManagementTasks({
      admin:true,
      status:req.query.status || null,
      page:req.query.page,
      pageSize:req.query.page_size,
    })) })
  } catch (error) { reviewError(res, error) }
})

router.get('/ai/admin/position-management-settings', async (req, res) => {
  if (!requireAiAdmin(req, res)) return
  try {
    res.json({ ok:true, ...(await getPositionManagementAdminSettings()),
      worker:getPositionManagementWorkerStatus() })
  } catch (error) { reviewError(res, error) }
})

router.put('/ai/admin/position-management-control', async (req, res) => {
  if (!requireAiAdmin(req, res)) return
  try {
    const result = await saveGlobalPositionManagementControl(req.user.id, req.body || {})
    await logAudit({ userId:req.user.id, action:'position_management_control_updated',
      targetType:'global_position_management_control', targetId:'1', detail:req.body || {},
      ip:req.ip, userAgent:req.get('user-agent') })
    res.json({ ok:true, ...result, worker:getPositionManagementWorkerStatus() })
  } catch (error) { reviewError(res, error) }
})

router.get('/ai/admin/position-management/:taskId', async (req, res) => {
  if (!requireAiAdmin(req, res)) return
  try {
    const detail = await getPositionManagementTask(Number(req.params.taskId), { admin:true })
    if (!detail) return res.status(404).json({ ok:false, error:'position_management_task_not_found' })
    res.json({ ok:true, ...detail })
  } catch (error) { reviewError(res, error) }
})

router.get('/ai/executions', authMiddleware, async (req, res) => {
  try {
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1)
    const pageSize = Math.min(50, Math.max(1, Number.parseInt(req.query.page_size, 10) || 5))
    const totalRow = await queryOne('SELECT COUNT(*) AS total FROM order_intents WHERE user_id = ?', [req.user.id])
    const total = Number(totalRow?.total || 0)
    const pages = Math.max(1, Math.ceil(total / pageSize))
    const safePage = Math.min(page, pages)
    const offset = (safePage - 1) * pageSize
    const rows = await queryAll(`SELECT oi.id, oi.source_type, oi.source_id, oi.action, oi.symbol, oi.status,
      oi.original_order_json, oi.approved_order_json, oi.result_json, oi.error_code, oi.created_at, oi.completed_at,
      rd.policy_version_ids_json, rd.rule_results_json, rd.decision_status, rd.reject_code
      FROM order_intents oi LEFT JOIN risk_decisions rd ON rd.order_intent_id = oi.id
      WHERE oi.user_id = ? ORDER BY oi.id DESC LIMIT ? OFFSET ?`, [req.user.id, pageSize, offset])
    res.json({ ok: true, executions: rows, pagination: { page: safePage, page_size: pageSize, total, pages } })
  } catch (error) { reviewError(res, error) }
})

router.get('/ai/admin/risk-center', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false, error: 'admin_only' })
  try {
    const accounts = await queryAll(`SELECT ta.*, u.nickname AS user_nickname, u.email AS user_email,
      ras.halt_status, ras.halt_reason, ras.drawdown_pct, ras.consecutive_losses, ras.cooldown_until,
      ras.user_kill_switch, ras.data_complete, ras.data_incomplete_reason, ras.last_risk_snapshot_at,
      ownership.started_at AS platform_connected_at, totals.account_currency,
      totals.realized_net AS cumulative_realized_net, totals.net_funding AS cumulative_net_funding,
      totals.net_account_change AS cumulative_account_change, totals.closed_position_count AS cumulative_closed_positions,
      totals.data_complete AS performance_data_complete, perf_state.sync_status AS performance_sync_status,
      perf_state.synced_through_date AS performance_synced_through_date
      FROM trading_accounts ta
      JOIN users u ON u.id = ta.user_id
      LEFT JOIN risk_account_state ras ON ras.trading_account_id = ta.id
      LEFT JOIN mt5_account_ownership_history ownership ON ownership.trading_account_id = ta.id
        AND ownership.user_id = ta.user_id AND ownership.ended_at IS NULL
      LEFT JOIN (SELECT totals.trading_account_id, owner.user_id, MAX(totals.account_currency) AS account_currency,
          SUM(realized_net) AS realized_net, SUM(net_funding) AS net_funding,
          SUM(net_account_change) AS net_account_change, SUM(closed_position_count) AS closed_position_count,
          MIN(data_complete) AS data_complete
        FROM mt5_account_performance_totals totals
        JOIN mt5_account_ownership_history owner ON owner.id = totals.ownership_history_id
        GROUP BY totals.trading_account_id, owner.user_id) totals
        ON totals.trading_account_id = ta.id AND totals.user_id = ta.user_id
      LEFT JOIN mt5_account_performance_sync_state perf_state ON perf_state.ownership_history_id = ownership.id
      WHERE ta.is_deleted = 0 ORDER BY ta.updated_at DESC LIMIT 500`)
    const exceptions = await queryAll(`SELECT ta.*, u.nickname AS user_nickname, u.email AS user_email
      FROM trading_accounts ta JOIN users u ON u.id = ta.user_id
      WHERE ta.is_deleted = 0 AND (
        ta.anomaly_code IN ('duplicate_account_binding', 'account_trade_permission_required', 'account_transferred')
        OR ta.observe_status IN ('frozen', 'paused', 'transferred')
      ) ORDER BY ta.updated_at DESC LIMIT 500`)
    const global = await queryAll('SELECT global_kill_switch, reason, changed_by, updated_at FROM global_risk_control WHERE id = 1 LIMIT 1')
    let set = await queryAll("SELECT * FROM risk_policy_sets WHERE scope = 'platform' AND status = 'active' ORDER BY id LIMIT 1")
    let platform = null
    if (set[0]) platform = await queryAll('SELECT * FROM risk_policy_versions WHERE policy_set_id = ? ORDER BY version_no DESC LIMIT 1', [set[0].id])
    res.json({ ok: true, accounts, exceptions, global_control: global[0] || null, platform_policy_set: set[0] || null, platform_policy_version: platform?.[0] || null, defaults: DEFAULT_RISK_POLICY, rule_metadata: RISK_RULES })
  } catch (error) { reviewError(res, error) }
})

router.get('/ai/admin/users/:userId/operations-detail', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok:false, error:'admin_only' })
  try {
    const targetUserId = Number(req.params.userId)
    if (!Number.isInteger(targetUserId) || targetUserId <= 0) throw new Error('invalid_user_id')
    const user = await queryOne(`SELECT id, nickname, email, phone, plan, role, plan_source, plan_expires_at,
      (plan IN ('pro', 'plus') AND plan_expires_at IS NOT NULL AND plan_expires_at < NOW()) AS membership_expired,
      last_seen_at, bridge_heartbeat, created_at FROM users WHERE id = ?`, [targetUserId])
    if (!user) return res.status(404).json({ ok:false, error:'user_not_found' })
    const [settings, scheduler, accounts, subscriptions, strategies] = await Promise.all([
      queryOne('SELECT trade_send_enabled, auto_reasoning_enabled, updated_at FROM user_bridge_settings WHERE user_id = ?', [targetUserId]),
      getUserAutoRuntimeStatus(targetUserId),
      queryAll(`SELECT ta.*, ras.halt_status, ras.halt_reason, ras.drawdown_pct, ras.consecutive_losses,
          ras.cooldown_until, ras.user_kill_switch, ras.data_complete, ras.data_incomplete_reason,
          ownership.id AS ownership_history_id,
          COALESCE(ownership.started_at, history.first_owned_at) AS platform_connected_at,
          totals.account_currency, totals.period_start_date, totals.period_end_date, totals.realized_net,
          totals.deposit, totals.withdrawal, totals.net_funding, totals.net_account_change,
          totals.closed_position_count, totals.winning_exit_count, totals.losing_exit_count,
          totals.data_complete AS performance_data_complete, totals.last_synced_at,
          perf_state.sync_status AS performance_sync_status, perf_state.last_error AS performance_sync_error,
          perf_state.synced_through_date AS performance_synced_through_date
        FROM trading_accounts ta
        LEFT JOIN risk_account_state ras ON ras.trading_account_id = ta.id
        LEFT JOIN mt5_account_ownership_history ownership ON ownership.trading_account_id = ta.id
          AND ownership.user_id = ta.user_id AND ownership.ended_at IS NULL
        LEFT JOIN (SELECT totals.trading_account_id, owner.user_id,
            MAX(totals.account_currency) AS account_currency,
            MIN(period_start_date) AS period_start_date, MAX(period_end_date) AS period_end_date,
            SUM(realized_net) AS realized_net, SUM(deposit) AS deposit, SUM(withdrawal) AS withdrawal,
            SUM(net_funding) AS net_funding, SUM(net_account_change) AS net_account_change,
            SUM(closed_position_count) AS closed_position_count, SUM(winning_exit_count) AS winning_exit_count,
            SUM(losing_exit_count) AS losing_exit_count, MIN(data_complete) AS data_complete,
            MAX(last_synced_at) AS last_synced_at
          FROM mt5_account_performance_totals totals
          JOIN mt5_account_ownership_history owner ON owner.id = totals.ownership_history_id
          GROUP BY totals.trading_account_id, owner.user_id) totals
          ON totals.trading_account_id = ta.id AND totals.user_id = ta.user_id
        LEFT JOIN (SELECT trading_account_id, user_id, MIN(started_at) AS first_owned_at
          FROM mt5_account_ownership_history GROUP BY trading_account_id, user_id) history
          ON history.trading_account_id = ta.id AND history.user_id = ta.user_id
        LEFT JOIN mt5_account_performance_sync_state perf_state ON perf_state.ownership_history_id = ownership.id
        WHERE ta.user_id = ? AND ta.is_deleted = 0 ORDER BY ta.updated_at DESC`, [targetUserId]),
      listSubscriptions(req.user.id, req.user.role, { targetUserId }),
      queryAll(`SELECT apt.id, apt.title, apt.scope, apt.owner_user_id, apt.symbols_json,
          apt.visibility_status, apt.version
        FROM auto_prompt_types apt WHERE apt.deleted_at IS NULL AND apt.is_active = 1
          AND apt.visibility_status = 'active'
          AND (apt.scope = 'platform' OR (apt.scope = 'private' AND apt.owner_user_id = ?))
        ORDER BY apt.scope, apt.sort_order, apt.id`, [targetUserId]),
    ])
    const accountsWithPolicy = await Promise.all(accounts.map(async account => ({
      ...account,
      effective_risk:await resolveEffectiveRiskPolicy({ userId:targetUserId, tradingAccountId:Number(account.id) }),
    })))
    const bridge = isBridgeAlive(targetUserId)
    res.json({ ok:true, user, settings:settings || { trade_send_enabled:0, auto_reasoning_enabled:0 },
      bridge:{ connected:bridge, diagnostics:getBridgeDiagnostics().find(item => Number(item.userId) === targetUserId) || null }, scheduler,
      accounts:accountsWithPolicy, subscriptions, strategies, rule_metadata:RISK_RULES })
  } catch (error) { reviewError(res, error) }
})

router.patch('/ai/admin/users/:userId/profile', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok:false, error:'admin_only' })
  try {
    const profile = await updateAdminUserProfile({
      actorUserId:req.user.id,
      targetUserId:req.params.userId,
      input:req.body || {},
    })
    res.json({ ok:true, profile })
  } catch (error) {
    const status = String(error?.message || '') === 'user_not_found' ? 404 : 400
    res.status(status).json({ ok:false, error:translateAdminProfileError(error) })
  }
})

router.patch('/ai/admin/users/:userId/runtime', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok:false, error:'admin_only' })
  try {
    const targetUserId = Number(req.params.userId)
    const target = await queryOne('SELECT id, role FROM users WHERE id = ?', [targetUserId])
    if (!target) return res.status(404).json({ ok:false, error:'user_not_found' })
    const hasTrade = typeof req.body?.trade_send_enabled === 'boolean'
    const hasAuto = typeof req.body?.auto_reasoning_enabled === 'boolean'
    if (!hasTrade && !hasAuto) throw new Error('runtime_setting_required')
    if (hasAuto) {
      const enabled = req.body.auto_reasoning_enabled
      const rows = enabled
        ? [await queryOne(`SELECT id FROM strategy_subscriptions WHERE user_id = ? AND is_deleted = 0
            ORDER BY updated_at DESC, id DESC LIMIT 1`, [targetUserId])].filter(Boolean)
        : await queryAll(`SELECT id FROM strategy_subscriptions WHERE user_id = ? AND is_deleted = 0
            AND execution_enabled = 1`, [targetUserId])
      if (enabled && !rows.length) throw new Error('subscription_required_before_auto_reasoning')
      for (const row of rows) {
        await updateSubscription(Number(row.id), targetUserId, target.role || 'user', {
          execution_enabled:enabled, replace_active:true,
        })
      }
      await queryRun(`INSERT INTO user_bridge_settings (user_id, auto_reasoning_enabled, updated_at)
        VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE auto_reasoning_enabled = VALUES(auto_reasoning_enabled),
        updated_at = VALUES(updated_at)`, [targetUserId, enabled ? 1 : 0, beijingNow()])
      await reconcileAiRuntime()
    }
    if (hasTrade) {
      await queryRun(`INSERT INTO user_bridge_settings (user_id, trade_send_enabled, updated_at)
        VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE trade_send_enabled = VALUES(trade_send_enabled),
        updated_at = VALUES(updated_at)`, [targetUserId, req.body.trade_send_enabled ? 1 : 0, beijingNow()])
    }
    const runtime = await applyBridgeRuntimeState(targetUserId, {
      ...(hasTrade ? { tradeEnabled:req.body.trade_send_enabled } : {}),
      ...(hasAuto ? { autoReasoningEnabled:req.body.auto_reasoning_enabled } : {}),
    })
    await logAudit({ userId:req.user.id, action:'admin_user_runtime_updated', targetType:'user',
      targetId:targetUserId, detail:JSON.stringify({ ...req.body, runtime }) })
    res.json({ ok:true, runtime })
  } catch (error) { reviewError(res, error) }
})

router.put('/ai/admin/users/:userId/accounts/:accountId/risk', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok:false, error:'admin_only' })
  try {
    const targetUserId = Number(req.params.userId), accountId = Number(req.params.accountId)
    const account = await queryOne('SELECT id FROM trading_accounts WHERE id = ? AND user_id = ? AND is_deleted = 0', [accountId, targetUserId])
    if (!account) return res.status(404).json({ ok:false, error:'account_not_found' })
    let set = await queryOne("SELECT id FROM risk_policy_sets WHERE scope = 'account' AND owner_user_id = ? AND trading_account_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1", [targetUserId, accountId])
    if (!set) {
      const now = beijingNow()
      const inserted = await queryRun(`INSERT INTO risk_policy_sets
        (scope, owner_user_id, trading_account_id, name, status, created_at, updated_at)
        VALUES ('account', ?, ?, ?, 'active', ?, ?)`, [targetUserId, accountId, `账户 ${accountId} 自定义风控`, now, now])
      set = { id:inserted.insertId }
    }
    const result = await submitRiskPolicyChanges({ policySetId:set.id, actorId:req.user.id,
      changes:req.body?.changes || {}, reason:req.body?.reason || '管理员在统一管理后台更新用户风控' })
    let risk_refresh
    try {
      risk_refresh = await refreshRecoverableRiskAccounts(targetUserId, {
        accountId, includeActive:true, trigger:'admin_policy_save',
      })
    } catch (error) { risk_refresh = riskRefreshFailure(error) }
    armRiskRecoveryIfNeeded(targetUserId, risk_refresh)
    res.json({ ok:true, result, risk_refresh })
  } catch (error) { reviewError(res, error) }
})

router.put('/ai/admin/users/:userId/subscriptions/:subscriptionId', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok:false, error:'admin_only' })
  try {
    const targetUserId = Number(req.params.userId), subscriptionId = Number(req.params.subscriptionId)
    const target = await queryOne('SELECT id, role FROM users WHERE id = ?', [targetUserId])
    if (!target) return res.status(404).json({ ok:false, error:'user_not_found' })
    const subscription = await updateSubscription(subscriptionId, targetUserId, target.role || 'user', req.body || {})
    const runtime_sync = await reconcileAiRuntime(targetUserId)
    await logAudit({ userId:req.user.id, action:'admin_user_subscription_updated', targetType:'strategy_subscription',
      targetId:subscriptionId, detail:JSON.stringify({ target_user_id:targetUserId, changes:req.body || {} }) })
    res.json({ ok:true, subscription, runtime_sync })
  } catch (error) { reviewError(res, error) }
})

router.post('/ai/admin/risk-center/kill-switch', authMiddleware, async (req, res) => {
  try { await setGlobalKillSwitch(req.user.id, req.user.role, Boolean(req.body?.enabled), req.body?.reason); res.json({ ok: true }) }
  catch (error) { reviewError(res, error) }
})

router.put('/ai/admin/risk-center', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false, error: 'admin_only' })
  try {
    let set = await queryAll("SELECT * FROM risk_policy_sets WHERE scope = 'platform' AND status = 'active' ORDER BY id LIMIT 1")
    if (!set[0]) {
      const now = beijingNow()
      const inserted = await queryRun(`INSERT INTO risk_policy_sets (scope, owner_user_id, name, status, created_at, updated_at) VALUES ('platform', 0, '平台全局风控', 'active', ?, ?)`, [now, now])
      await queryRun(`INSERT INTO risk_policy_versions (policy_set_id, version_no, config_json, created_by, change_reason, effective_at, created_at) VALUES (?, 1, ?, ?, 'initial defaults', ?, ?)`, [inserted.insertId, JSON.stringify(DEFAULT_RISK_POLICY), req.user.id, now, now])
      set = [{ id: inserted.insertId }]
    }
    const result = await withTransaction(async run => {
      const [[current]] = await run('SELECT * FROM risk_policy_versions WHERE policy_set_id = ? ORDER BY version_no DESC LIMIT 1 FOR UPDATE', [set[0].id])
      let raw = {}
      try { raw = current?.config_json ? JSON.parse(current.config_json) : {} } catch {}
      const normalized = normalizePlatformRiskConfig({
        currentValues:raw.values || raw.defaults || raw,
        currentControls:raw.controls || {},
        valueChanges:req.body?.values || req.body?.changes || {},
        controlChanges:req.body?.controls || {},
      })
      const { values, controls } = normalized
      const now = beijingNow()
      const [insert] = await run(`INSERT INTO risk_policy_versions
        (policy_set_id, version_no, config_json, created_by, change_reason, effective_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`, [set[0].id, Number(current?.version_no || 0) + 1, JSON.stringify({ values, controls }), req.user.id, req.body?.reason || '管理员更新全局风控', now, now])
      await run('UPDATE risk_policy_sets SET active_version_id = ?, updated_at = ? WHERE id = ?', [insert.insertId, now, set[0].id])
      return { active_version_id: insert.insertId, version_no: Number(current?.version_no || 0) + 1 }
    })
    res.json({ ok: true, result })
  } catch (error) { reviewError(res, error) }
})

router.get('/ai/reviews', authMiddleware, async (req, res) => {
  try { res.json({ ok: true, cases: await listReviewCases(req.user.id, req.query) }) }
  catch (error) { reviewError(res, error) }
})

router.get('/ai/period-reviews', authMiddleware, periodReviewReadHeaders, async (req, res) => {
  try { sendPeriodReviewReadResponse(res, await listPeriodReviewCases(req.user, { ...req.query, includePageInfo:true })) }
  catch (error) { reviewError(res, error) }
})

// Manual analysis is a durable, non-executing task. The short inline window
// keeps fast responses compatible with the old synchronous client while slow
// requests continue after the browser disconnects and are polled by job id.
router.post('/ai/manual-analysis/jobs', authMiddleware, async (req, res) => {
  try {
    const job = await createManualAnalysisJob(req.user.id, req.body || {}, {
      userRole:req.user.role,
    })
    const inline = ['succeeded', 'failed', 'cancelled', 'status_unknown', 'completed_stale', 'expired'].includes(job?.status)
    res.status(inline ? 200 : 202).json({ ok:true, job })
  } catch (error) { reviewError(res, error) }
})

router.get('/ai/manual-analysis/jobs/:jobId', authMiddleware, async (req, res) => {
  try { res.json({ ok:true, job:await getManualAnalysisJob(req.user.id, req.params.jobId) }) }
  catch (error) { reviewError(res, error) }
})

router.delete('/ai/manual-analysis/jobs/:jobId', authMiddleware, async (req, res) => {
  try { res.json({ ok:true, job:await cancelManualAnalysisJob(req.user.id, req.params.jobId) }) }
  catch (error) { reviewError(res, error) }
})

router.get('/ai/period-reviews/summary', authMiddleware, periodReviewReadHeaders, async (req, res) => {
  try { sendPeriodReviewReadResponse(res, { summary:await getPeriodReviewSummary(req.user) }) }
  catch (error) { reviewError(res, error) }
})

router.get('/ai/period-reviews/:id', authMiddleware, periodReviewReadHeaders, async (req, res) => {
  try { sendPeriodReviewReadResponse(res, { review:await getPeriodReviewCase(Number(req.params.id), req.user) }) }
  catch (error) { reviewError(res, error) }
})

router.get('/ai/period-reviews/:id/job-status', authMiddleware, periodReviewReadHeaders, async (req, res) => {
  try { sendPeriodReviewReadResponse(res, { job:await getPeriodReviewJobStatus(Number(req.params.id), req.user) }) }
  catch (error) { reviewError(res, error) }
})

router.post('/ai/period-reviews/:id/edit', authMiddleware, periodReviewFrontendContractGuard, async (req, res) => {
  try { res.json({ ok: true, ...(await editPeriodReviewCase({ periodCaseId: Number(req.params.id), actor: req.user,
    content: req.body?.content, expectedVersionId: req.body?.expected_version_id, changeNote: req.body?.change_note })) }) }
  catch (error) { reviewError(res, error) }
})

router.post('/ai/period-reviews/:id/read', authMiddleware, async (req, res) => {
  try { res.json({ ok: true, ...(await markPeriodReviewRead(Number(req.params.id), req.user, req.body?.version_id)) }) }
  catch (error) { reviewError(res, error) }
})

router.post('/ai/period-reviews/:id/confirm', authMiddleware, periodReviewFrontendContractGuard, async (req, res) => {
  try {
    const periodCaseId = Number(req.params.id)
    const result = await confirmPeriodReviewCase({ periodCaseId, actor: req.user,
      versionId: req.body?.version_id, action: req.body?.action })
    if (req.body?.action === 'approve') requestPeriodReviewCycle()
    res.json({ ok: true, ...result })
  } catch (error) { reviewError(res, error) }
})

router.post('/ai/period-reviews/:id/retry', authMiddleware, periodReviewFrontendContractGuard, async (req, res) => {
  try { res.json({ ok: true, ...(await retryPeriodReviewCase(Number(req.params.id), req.user)) }) }
  catch (error) { reviewError(res, error) }
})

router.post('/ai/period-reviews/:id/regenerate', authMiddleware, periodReviewFrontendContractGuard, async (req, res) => {
  try {
    const requestIdempotencyKey = req.get('Idempotency-Key') || req.body?.idempotency_key || req.body?.request_id || null
    res.json({ ok: true, ...(await regeneratePeriodReviewCase(Number(req.params.id), req.user, { requestIdempotencyKey })) })
  } catch (error) { reviewError(res, error) }
})

router.post('/ai/period-reviews/:id/derivation/retry', authMiddleware, periodReviewFrontendContractGuard, async (req, res) => {
  try { res.json({ ok:true, ...(await retryPeriodReviewDerivation(Number(req.params.id), req.user)) }) }
  catch (error) { reviewError(res, error) }
})

// Manual strategy review is independently owner-scoped even for platform
// content managers. No route accepts an arbitrary actor/account override.
router.get('/ai/manual-trade-reviews/strategies', authMiddleware, async (req, res) => {
  if (!requireManualTradeReviewManager(req, res)) return
  try { res.json({ ok:true, strategies:await listManualTradeReviewStrategies(req.user) }) }
  catch (error) { reviewError(res, error) }
})

router.get('/ai/manual-trade-reviews/eligible-trades', authMiddleware, async (req, res) => {
  if (!requireManualTradeReviewManager(req, res)) return
  try { res.json({ ok:true, ...(await listEligibleManualTradeReviews(req.user, req.query || {})) }) }
  catch (error) { reviewError(res, error) }
})

router.post('/ai/manual-trade-reviews', authMiddleware, async (req, res) => {
  if (!requireManualTradeReviewManager(req, res)) return
  try {
    const result = await createManualTradeReview(req.user, req.body || {})
    await auditAiMutation(req, result.created ? 'manual_trade_review_created' : 'manual_trade_review_replayed',
      'manual_trade_review_case', result.case?.id || null, { strategy_id:Number(req.body?.strategy_id) || null })
    res.status(result.created ? 202 : 200).json({ ok:true, ...result })
  } catch (error) { reviewError(res, error) }
})

router.get('/ai/manual-trade-reviews', authMiddleware, async (req, res) => {
  if (!requireManualTradeReviewManager(req, res)) return
  try { res.json({ ok:true, ...(await listManualTradeReviews(req.user, req.query || {})) }) }
  catch (error) { reviewError(res, error) }
})

router.get('/ai/manual-trade-reviews/:id/job-status', authMiddleware, async (req, res) => {
  if (!requireManualTradeReviewManager(req, res)) return
  try { res.json({ ok:true, job:await getManualTradeReviewJobStatus(Number(req.params.id), req.user) }) }
  catch (error) { reviewError(res, error) }
})

router.get('/ai/manual-trade-reviews/:id', authMiddleware, async (req, res) => {
  if (!requireManualTradeReviewManager(req, res)) return
  try { res.json({ ok:true, review:await getManualTradeReview(Number(req.params.id), req.user) }) }
  catch (error) { reviewError(res, error) }
})

router.post('/ai/manual-trade-reviews/:id/edit', authMiddleware, async (req, res) => {
  if (!requireManualTradeReviewManager(req, res)) return
  try {
    const result = await editManualTradeReview({ caseId:Number(req.params.id), actor:req.user,
      content:req.body?.content, expectedVersionId:req.body?.expected_version_id, changeNote:req.body?.change_note })
    await auditAiMutation(req, 'manual_trade_review_edited', 'manual_trade_review_case', Number(req.params.id), { version_id:result.version?.id || null })
    res.json({ ok:true, ...result })
  }
  catch (error) { reviewError(res, error) }
})

router.post('/ai/manual-trade-reviews/:id/confirm', authMiddleware, async (req, res) => {
  if (!requireManualTradeReviewManager(req, res)) return
  try {
    const result = await confirmManualTradeReview({ caseId:Number(req.params.id), actor:req.user,
      versionId:req.body?.version_id, action:req.body?.action })
    await auditAiMutation(req, 'manual_trade_review_confirmed', 'manual_trade_review_case', Number(req.params.id), { action:req.body?.action || 'approve', version_id:result.version_id || null })
    res.json({ ok:true, ...result })
  }
  catch (error) { reviewError(res, error) }
})

router.post('/ai/manual-trade-reviews/:id/retry', authMiddleware, async (req, res) => {
  if (!requireManualTradeReviewManager(req, res)) return
  try {
    const result = await retryManualTradeReview(Number(req.params.id), req.user)
    await auditAiMutation(req, 'manual_trade_review_retried', 'manual_trade_review_case', Number(req.params.id))
    res.status(202).json({ ok:true, ...result })
  }
  catch (error) { reviewError(res, error) }
})

// Aggregate review is a separate workflow over immutable completed review
// versions. It never changes the single raw-trade selection limit.
router.get('/ai/manual-trade-review-aggregates/eligible-reviews', authMiddleware, async (req, res) => {
  if (!requireManualTradeReviewManager(req, res)) return
  try {
    const reviews = await listEligibleManualTradeReviewSources({ actor:req.user, userId:req.user.id,
      tradingAccountId:req.query?.trading_account_id, strategyId:req.query?.strategy_id,
      limit:req.query?.limit, offset:req.query?.offset })
    res.json({ ok:true, reviews })
  } catch (error) { reviewError(res, error) }
})

router.post('/ai/manual-trade-review-aggregates', authMiddleware, async (req, res) => {
  if (!requireManualTradeReviewManager(req, res)) return
  try {
    const result = await createManualTradeReviewAggregate({ actor:req.user, userId:req.user.id,
      tradingAccountId:req.body?.trading_account_id, strategyId:req.body?.strategy_id,
      clientRequestId:req.body?.client_request_id, sources:req.body?.sources })
    if (result.created) requestManualTradeReviewAggregateCycle()
    await auditAiMutation(req, result.created ? 'manual_trade_review_aggregate_created' : 'manual_trade_review_aggregate_replayed',
      'manual_trade_review_aggregate_case', result.aggregate_case?.id || null,
      { strategy_id:Number(req.body?.strategy_id) || null, source_count:Array.isArray(req.body?.sources) ? req.body.sources.length : 0 })
    res.status(result.created ? 202 : 200).json({ ok:true, ...result })
  } catch (error) { reviewError(res, error) }
})

router.get('/ai/manual-trade-review-aggregates', authMiddleware, async (req, res) => {
  if (!requireManualTradeReviewManager(req, res)) return
  try {
    const aggregates = await listManualTradeReviewAggregates({ actor:req.user, userId:req.user.id,
      tradingAccountId:req.query?.trading_account_id, strategyId:req.query?.strategy_id,
      limit:req.query?.limit, offset:req.query?.offset })
    res.json({ ok:true, aggregates })
  } catch (error) { reviewError(res, error) }
})

router.get('/ai/manual-trade-review-aggregates/:id/job-status', authMiddleware, async (req, res) => {
  if (!requireManualTradeReviewManager(req, res)) return
  try {
    const job = await getManualTradeReviewAggregateJobStatus({ actor:req.user, userId:req.user.id,
      aggregateId:Number(req.params.id), tradingAccountId:req.query?.trading_account_id })
    res.json({ ok:true, job })
  } catch (error) { reviewError(res, error) }
})

router.get('/ai/manual-trade-review-aggregates/:id', authMiddleware, async (req, res) => {
  if (!requireManualTradeReviewManager(req, res)) return
  try {
    const aggregate = await getManualTradeReviewAggregate({ actor:req.user, userId:req.user.id,
      aggregateId:Number(req.params.id), tradingAccountId:req.query?.trading_account_id })
    res.json({ ok:true, aggregate })
  } catch (error) { reviewError(res, error) }
})

router.post('/ai/manual-trade-review-aggregates/:id/retry', authMiddleware, async (req, res) => {
  if (!requireManualTradeReviewManager(req, res)) return
  try {
    const result = await retryManualTradeReviewAggregate({ actor:req.user, userId:req.user.id,
      aggregateId:Number(req.params.id), tradingAccountId:req.body?.trading_account_id })
    requestManualTradeReviewAggregateCycle()
    await auditAiMutation(req, 'manual_trade_review_aggregate_retried', 'manual_trade_review_aggregate_case',
      Number(req.params.id), { generation_no:result.generation_no })
    res.status(202).json({ ok:true, ...result })
  } catch (error) { reviewError(res, error) }
})

router.get('/ai/reviews/:id', authMiddleware, async (req, res) => {
  try { res.json({ ok: true, review: await getReviewCase(Number(req.params.id), req.user.id) }) }
  catch (error) { reviewError(res, error) }
})

router.post('/ai/reviews/outcomes/:outcomeId', authMiddleware, async (req, res) => {
  try {
    const outcome = await queryAll('SELECT user_id FROM signal_outcomes WHERE id = ? LIMIT 1', [Number(req.params.outcomeId)])
    if (!outcome[0] || Number(outcome[0].user_id) !== Number(req.user.id)) return res.status(404).json({ ok: false, error: 'outcome_not_found' })
    res.json({ ok: true, review: await ensureReviewCaseForOutcome(Number(req.params.outcomeId), { queueGeneration:false }) })
  } catch (error) { reviewError(res, error) }
})

router.post('/ai/reviews/:id/edit', authMiddleware, async (req, res) => {
  res.status(410).json({ ok:false, error:'legacy_trade_review_disabled', use_endpoint:'/api/ai/period-reviews' })
})

router.post('/ai/reviews/:id/confirm', authMiddleware, async (req, res) => {
  res.status(410).json({ ok:false, error:'legacy_trade_review_disabled', use_endpoint:'/api/ai/period-reviews' })
})

router.post('/ai/reviews/:id/retry', authMiddleware, async (req, res) => {
  res.status(410).json({ ok:false, error:'legacy_trade_review_disabled', use_endpoint:'/api/ai/period-reviews' })
})

router.get('/ai/admin/reviews/health', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false, error: 'admin_only' })
  try { res.json({ ok: true, health: await getReviewAdminHealth() }) }
  catch (error) { reviewError(res, error) }
})

router.get('/ai/memory', authMiddleware, async (req, res) => {
  res.status(410).json({ ok:false, error:'legacy_tiered_memory_retired', use_endpoint:'/api/ai/strategy-memories' })
})

router.put('/ai/memory/settings', authMiddleware, async (req, res) => {
  res.status(410).json({ ok:false, error:'legacy_tiered_memory_retired', use_endpoint:'/api/ai/strategy-memories' })
})

router.post('/ai/memory/:id/revoke', authMiddleware, async (req, res) => {
  res.status(410).json({ ok:false, error:'legacy_tiered_memory_retired', use_endpoint:'/api/ai/strategy-memories' })
})

router.post('/ai/memory/:id/activate', authMiddleware, async (req, res) => {
  res.status(410).json({ ok:false, error:'legacy_tiered_memory_retired', use_endpoint:'/api/ai/strategy-memories' })
})

router.post('/ai/memory/long/:id/confirm', authMiddleware, async (req, res) => {
  res.status(410).json({ ok:false, error:'legacy_tiered_memory_retired', use_endpoint:'/api/ai/strategy-memories' })
})

router.post('/ai/memory/long/:id/revoke', authMiddleware, async (req, res) => {
  res.status(410).json({ ok:false, error:'legacy_tiered_memory_retired', use_endpoint:'/api/ai/strategy-memories' })
})

router.post('/ai/memory/summaries/:id/rollback', authMiddleware, async (req, res) => {
  res.status(410).json({ ok:false, error:'legacy_tiered_memory_retired', use_endpoint:'/api/ai/strategy-memories' })
})

router.get('/ai/strategy-memories', authMiddleware, async (req, res) => {
  try { res.json({ ok:true, strategies:await listStrategyMemoryLibraries({ actor:req.user }) }) }
  catch (error) { reviewError(res, error) }
})

router.get('/ai/strategy-memories/:strategyId', authMiddleware, async (req, res) => {
  try {
    const strategyId = Number(req.params.strategyId)
    const [library, revisions, conflicts] = await Promise.all([
      getOrCreateStrategyMemoryLibrary({ strategyId, actor:req.user }),
      listStrategyMemoryLibraryRevisions({ strategyId, actor:req.user, limit:req.query.limit }),
      listStrategyMemoryConflicts({ strategyId, actor:req.user }),
    ])
    res.json({ ok:true, library, revisions, conflicts })
  } catch (error) { reviewError(res, error) }
})

router.get('/ai/strategy-memories/:strategyId/preview', authMiddleware, async (req, res) => {
  try {
    const strategyId = Number(req.params.strategyId)
    const preview = await getStrategyMemoryLibraryPreview({ strategyId, actor:req.user,
      version_no:req.query.version_no })
    const consistencyCheck = await getLatestStrategyMemoryConsistencyJob({ strategyId,
      strategyVersion:preview.library_identity.strategy_version,
      libraryVersionNo:preview.library_identity.version_no })
    res.json({ ok:true, ...preview, consistency_check:consistencyCheck || null })
  } catch (error) { reviewError(res, error) }
})

router.post('/ai/strategy-memories/:strategyId/consistency-checks', authMiddleware, async (req, res) => {
  try {
    const strategyId = Number(req.params.strategyId)
    await getOrCreateStrategyMemoryLibrary({ strategyId, actor:req.user })
    const job = await queueStrategyMemoryConsistencyCheck({ strategyId,
      libraryVersionNo:req.body?.expected_version_no, triggerType:req.body?.trigger_type || 'manual_check',
      forceNew:req.body?.force_new === true })
    if (job.created) requestStrategyMemoryConsistencyCycle()
    await auditAiMutation(req, 'strategy_memory_consistency_check_queued', 'ai_strategy', strategyId,
      { job_id:job.id, created:job.created, replayed:job.replayed })
    res.status(job.created ? 202 : 200).json({ ok:true, created:job.created, replayed:job.replayed, job })
  } catch (error) { reviewError(res, error) }
})

router.get('/ai/strategy-memories/:strategyId/consistency-checks/latest', authMiddleware, async (req, res) => {
  try {
    const strategyId = Number(req.params.strategyId)
    await getOrCreateStrategyMemoryLibrary({ strategyId, actor:req.user })
    res.json({ ok:true, job:await getLatestStrategyMemoryConsistencyJob({ strategyId }) })
  } catch (error) { reviewError(res, error) }
})

router.get('/ai/strategy-memories/:strategyId/consistency-checks/:jobId', authMiddleware, async (req, res) => {
  try {
    const strategyId = Number(req.params.strategyId)
    await getOrCreateStrategyMemoryLibrary({ strategyId, actor:req.user })
    const job = await getStrategyMemoryConsistencyJob({ strategyId, jobId:Number(req.params.jobId) })
    res.json({ ok:true, job })
  } catch (error) { reviewError(res, error) }
})

router.put('/ai/strategy-memories/:strategyId', authMiddleware, async (req, res) => {
  try {
    const strategyId = Number(req.params.strategyId)
    const library = await saveStrategyMemoryLibrary({ strategyId, actor:req.user, ...(req.body || {}) })
    let consistencyJob = null
    try {
      consistencyJob = await queueStrategyMemoryConsistencyCheck({ strategyId,
        libraryVersionNo:library.version_no, triggerType:'manual_save' })
      if (consistencyJob.created) requestStrategyMemoryConsistencyCycle()
    } catch (error) { console.error('[StrategyMemory] consistency queue after save:', error.message) }
    await auditAiMutation(req, 'strategy_memory_library_updated', 'ai_strategy', strategyId, { version_no:library.version_no })
    res.json({ ok:true, library, consistency_job_id:consistencyJob?.id || null })
  }
  catch (error) { reviewError(res, error) }
})

router.post('/ai/strategy-memories/:strategyId/compress', authMiddleware, async (req, res) => {
  try {
    const strategyId = Number(req.params.strategyId)
    const job = await queueStrategyMemoryCompressionJob({ strategyId, actor:req.user, trigger:'manual' })
    if (job.created || job.library_status_updated) requestStrategyMemoryCompressionCycle()
    const terminal = ['succeeded', 'succeeded_noop', 'failed'].includes(String(job.status || ''))
    await auditAiMutation(req, terminal ? 'strategy_memory_compression_replayed' : 'strategy_memory_compression_queued',
      'ai_strategy', strategyId, { job_id:job.id, status:job.status, created:job.created, replayed:job.replayed })
    res.status(terminal ? 200 : 202).json({ ok:true, job })
  }
  catch (error) { reviewError(res, error) }
})

router.get('/ai/strategy-memories/:strategyId/compression-jobs/:jobId', authMiddleware, async (req, res) => {
  try {
    const strategyId = Number(req.params.strategyId)
    const jobId = Number(req.params.jobId)
    const job = await getStrategyMemoryCompressionJobStatus({ strategyId, jobId, actor:req.user })
    res.json({ ok:true, job })
  }
  catch (error) { reviewError(res, error) }
})

router.get('/ai/strategy-memories/:strategyId/compression-jobs-latest', authMiddleware, async (req, res) => {
  try {
    const strategyId = Number(req.params.strategyId)
    const job = await getLatestStrategyMemoryCompressionJobStatus({ strategyId, actor:req.user })
    res.json({ ok:true, job })
  }
  catch (error) { reviewError(res, error) }
})

router.post('/ai/strategy-memories/:strategyId/revisions/:revisionId/restore', authMiddleware, async (req, res) => {
  try {
    const strategyId = Number(req.params.strategyId)
    const revisionId = Number(req.params.revisionId)
    const library = await restoreStrategyMemoryLibraryRevision({ strategyId, revisionId, actor:req.user, ...(req.body || {}) })
    let consistencyJob = null
    try {
      consistencyJob = await queueStrategyMemoryConsistencyCheck({ strategyId,
        libraryVersionNo:library.version_no, triggerType:'restore' })
      if (consistencyJob.created) requestStrategyMemoryConsistencyCycle()
    } catch (error) { console.error('[StrategyMemory] consistency queue after restore:', error.message) }
    await auditAiMutation(req, 'strategy_memory_library_restored', 'ai_strategy', strategyId, { revision_id:revisionId, version_no:library.version_no })
    res.json({ ok:true, library, consistency_job_id:consistencyJob?.id || null })
  }
  catch (error) { reviewError(res, error) }
})

router.post('/ai/strategy-memory-conflicts/:id/:action', authMiddleware, async (req, res) => {
  const actions = { resolve:resolveStrategyMemoryConflict, dismiss:dismissStrategyMemoryConflict, reopen:reopenStrategyMemoryConflict }
  const action = actions[req.params.action]
  if (!action) return res.status(400).json({ ok:false, error:'strategy_memory_conflict_action_invalid' })
  try {
    const conflictId = Number(req.params.id)
    const conflict = await action({ conflictId, actor:req.user, ...(req.body || {}) })
    await auditAiMutation(req, `strategy_memory_conflict_${req.params.action}`, 'strategy_memory_conflict', conflictId)
    res.json({ ok:true, conflict })
  }
  catch (error) { reviewError(res, error) }
})

router.get('/ai/admin/platform-experience', authMiddleware, async (req, res) => {
  res.status(410).json({ ok:false, error:'legacy_platform_experience_retired', use_endpoint:'/api/ai/strategy-memories' })
})

router.put('/ai/admin/platform-experience/policies/:strategyId', authMiddleware, async (req, res) => {
  res.status(410).json({ ok:false, error:'legacy_platform_experience_retired', use_endpoint:'/api/ai/strategy-memories' })
})

router.post('/ai/admin/platform-experience/:id/:action', authMiddleware, async (req, res) => {
  res.status(410).json({ ok:false, error:'legacy_platform_experience_retired', use_endpoint:'/api/ai/strategy-memories' })
})

router.delete('/ai/admin/platform-experience/:id', authMiddleware, async (req, res) => {
  res.status(410).json({ ok:false, error:'legacy_platform_experience_retired', use_endpoint:'/api/ai/strategy-memories' })
})

export { initAutoSchedulers, startManualAnalysisJobs, startHistoryCompareRecoveryWorker,
  startManualTradeReviewWorker, stopManualTradeReviewWorker,
  startManualTradeReviewAggregateWorker, stopManualTradeReviewAggregateWorker,
  startStrategyMemoryCompressionWorker, stopStrategyMemoryCompressionWorker,
  runStrategyMemoryCompressionOnce, recoverAbandonedStrategyMemoryCompressionModelTasks,
  startStrategyMemoryConsistencyWorker, stopStrategyMemoryConsistencyWorker,
  runStrategyMemoryConsistencyOnce }

export { mt5Bridge, platformRates } from './market-data.js'
export { getPlatformMarketStatus } from './platform-market-data.js'
export { isBridgeAlive, getAllBridges, getBridgeTradeMode } from '../../bridge-ws.js'

export { handleAnalyze } from './strategy.js'

export { maybeAiSignal } from './llm.js'

export { insertAudit, getAnalyzeApiKey,
  getAutoConfig, signalOrderPayload, executeOrderCore, executeManualOrderCore,
  getGlobalAutoConfig,
  getExecuteRiskConfig, getAutoPromptTypes, getAutoPromptTypeById,
  getUnifiedAutoInferenceConfig,
  getCloseConfig, saveCloseConfig, getCloseSignalTickets } from './config.js'

export { getInferencePreference, saveInferencePreference } from './inference-preferences.js'

export { resolveAiTaskModel, logModelUsage, beginModelUsage, finishModelUsage, checkPlatformQuota,
  assertModelProfileSchemaReady,
  createModelProfile, getModelProfileById, getUserModelProfiles,
  getModelPurposeBindings, setModelPurposeBinding,
  updateModelProfile, deleteModelProfile, setDefaultModelProfile,
  getUserModelDefault, setUserModelDefault,
  getPlatformUsagePolicy, updatePlatformUsagePolicy,
  migrateLegacyConfigs, upsertDefaultModelProfileFromLegacyInput,
  rotateModelProfileCredentials, finalizeLegacyCredentialCleanup } from './model-profiles.js'

export { buildOrderIdempotencyKey, prepareAndExecuteOrderIntent,
  recoverExpiredOrderIntentLeases, reconcileUncertainOrderIntents,
  startOrderIntentReconciler, stopOrderIntentReconciler } from './order-intents.js'

export { startAutoScheduler, stopAutoScheduler, isAutoSchedulerRunning,
  reconcileAutoSchedulers, syncUserRedisSubscription, removeUserRuntimeAutoSubscription,
  getUserAutoRuntimeStatus } from './scheduler.js'

export { listStrategies, getStrategyById, createStrategy, updateStrategy, getStrategyDeletionPreview, deleteStrategy,
  listTradingAccounts, getTradingAccountById, createTradingAccount, updateTradingAccount, deleteTradingAccount,
  listSubscriptions, createSubscription, updateSubscription, deleteSubscription,
  adminListUserStrategies, adminListUserSubscriptions, getSubscriptionWithContext } from './strategy-ownership.js'

export { RISK_RULES, DEFAULT_RISK_POLICY, resolveEffectiveRiskPolicy, submitRiskPolicyChanges,
  evaluateCoreRisk } from './risk-policy.js'
export { calculateAccountRiskMetrics, aggregateClosedPositions,
  setUserKillSwitch, setGlobalKillSwitch, syncTradingAccountIdentity } from './risk-state.js'
export { refreshRecoverableRiskAccounts } from './risk-snapshot-refresh.js'
export { refreshIncompleteRiskAccounts } from './risk-snapshot-refresh.js'
export { normalizePerformanceDay, nextPerformanceWindow, recentPerformanceWindow,
  getAccountPerformanceSyncWindow, saveAccountPerformanceChunk,
  recordAccountPerformanceSyncFailure, getAccountPerformanceSummary,
  LEGACY_ACCOUNT_PERFORMANCE_SOURCE,
  getLegacyAccountPerformanceSyncWindow, saveLegacyAccountPerformanceChunk,
  recordLegacyAccountPerformanceSyncFailure, getLegacyAccountPerformanceSummary } from './account-performance.js'
export { analyzeOutcomeAttribution, resolveOutcomeClosureTransition,
  reconcileSignalOutcomes, startOutcomeMonitor, stopOutcomeMonitor } from './signal-outcomes.js'
export { validateReviewContent, assessReviewEvidence, ensureReviewCaseForOutcome,
  enqueueEligibleReviewCases, runReviewWorkerOnce, startReviewWorker, stopReviewWorker,
  listReviewCases, getReviewCase, editReviewCase, confirmReviewCase, retryReviewCase,
  getReviewAdminHealth } from './review-workflow.js'
export { prepareEligibleDailyReviews, prepareEligibleMonthlyReviews,
  runDailyReviewWorkerOnce, runMonthlyReviewWorkerOnce, runPeriodReviewCycle,
  runPeriodReviewDerivationOnce, resumePeriodReviewDerivationJobs,
  startPeriodReviewWorker, stopPeriodReviewWorker, listPeriodReviewCases, getPeriodReviewCase,
  editPeriodReviewCase, confirmPeriodReviewCase, retryPeriodReviewCase, getPeriodReviewSummary,
  markPeriodReviewRead, getPeriodReviewJobStatus, requestPeriodReviewCycle,
  retryPeriodReviewDerivation, regeneratePeriodReviewCase } from './period-review.js'

export { assertAiGovernanceSchemaReady, getEffectiveFeatureFlags, updateAiFeatureFlags,
  updateRiskRuleRollout, getAiRolloutHealth } from './rollout-governance.js'

export { STRATEGY_TIMEFRAME_COUNTS, parseTimeframeTags, stripTimeframeTags,
  attachSignalTiming, timeframeIntervalMs } from './utils.js'
export { attachSignalPresentation, buildExecutionAdvice, normalizeDecisionFields, restrictSignalExperienceUsage } from './signal-presentation.js'
export { getInferenceVisualizationSnapshot, inferenceVisualizationSnapshot } from './inference-snapshots.js'
export { POSITION_MANAGEMENT_CONTRACT_VERSION, buildPositionManagementAsOf,
  buildPositionManagementOutputFormat, validatePositionManagementResponse,
  createTradeThesisTx, loadActivePositionManagementContext, persistPositionManagementEvaluations,
  buildSignalManagementActions, loadSignalManagementActions,
  canTransitionPositionManagement, transitionPositionManagementTask,
  claimPositionManagementLease, createPositionManagementCommand,
  getPositionManagementSettings, savePositionManagementSettings,
  listPositionManagementTasks, getPositionManagementTask } from './position-management.js'

export default router
