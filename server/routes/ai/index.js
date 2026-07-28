// ai/index.js — 入口，re-export + Router

import { Router } from 'express'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { queryAll, queryOne, queryRun, withTransaction, beijingNow, logAudit } from '../../db.js'
import { authMiddleware } from '../../middleware/auth.js'
import { mt5Bridge, calculateMarketData } from './market-data.js'
import { maybeAiSignal, requestJsonObject } from './llm.js'
import { MODEL_PROVIDER_DEFAULTS, modelProviderProtocol } from './model-providers.js'
import { handleAnalyze, handleAnalyzeCompare, startHistoryCompareJob, getHistoryCompareJob,
  cancelHistoryCompareJob, listHistoryCompareJobs, deleteHistoryCompareJob,
  buildStrategyContextFromTags } from './strategy.js'
import { initAutoSchedulers, startAutoScheduler, stopAutoScheduler, isAutoSchedulerRunning, reconcileAutoSchedulers, getUserAutoRuntimeStatus, removeUserRuntimeAutoSubscription } from './scheduler.js'
import { applyBridgeRuntimeState, getBridgeDiagnostics, isBridgeAlive } from '../../bridge-ws.js'
import { buildAiAccessContext, observerAccessError, observerHttpRequestAllowed } from './observer-access.js'
import { createObserverChannel, createObserverSource, deleteObserverChannel, deleteObserverSource,
  listObserverChannelAssignments, listObserverChannels, listObserverChannelsForUser, listObserverSources,
  replaceObserverChannelAssignments, resolveObserverSourceForUser,
  updateObserverChannel, updateObserverSource } from './observer-channels.js'
import { createObserverSourceAccount } from './observer-source-accounts.js'
import { canManagePlatformAiContent, isObserverSourceAccount } from './platform-content-access.js'
import { listReviewCases, getReviewCase, ensureReviewCaseForOutcome, getReviewAdminHealth } from './review-workflow.js'
import { listMemoryItems, listMemorySummaries, revokeMemoryItem, activateDuplicateMemory,
  getMemorySettings, setMemorySettings, rollbackMemorySummary, confirmLongTermMemory,
  revokeLongTermMemory, createMemoryFromApprovedPeriodReview } from './memory-system.js'
import { getPlatformExperiencePolicies, createPlatformExperienceCandidateFromApprovedPeriodReview, listPlatformExperience,
  deleteRevokedPlatformExperienceItem, getPlatformExperienceEvaluation, updatePlatformExperienceItem,
  updatePlatformExperiencePolicy } from './platform-experience.js'
import { createModelProfile, getUserModelProfiles, updateModelProfile, getModelProfileDeletionImpact, deleteModelProfile,
  setDefaultModelProfile, getPlatformUsagePolicy, updatePlatformUsagePolicy,
  resolveOwnedModelProfileForRuntime, resolveAiTaskModel } from './model-profiles.js'
import { listStrategies, getStrategyById, createStrategy, updateStrategy, getStrategyDeletionPreview, deleteStrategy,
  listTradingAccounts, createTradingAccount, updateTradingAccount, deleteTradingAccount,
  listSubscriptions, createSubscription, updateSubscription, deleteSubscription } from './strategy-ownership.js'
import { resolveEffectiveRiskPolicy, submitRiskPolicyChanges, normalizePlatformRiskConfig, RISK_RULES, DEFAULT_RISK_POLICY } from './risk-policy.js'
import { setUserKillSwitch, setGlobalKillSwitch } from './risk-state.js'
import { refreshIncompleteRiskAccounts } from './risk-snapshot-refresh.js'
import { getAccountPerformanceSummary } from './account-performance.js'
import { getEffectiveFeatureFlags, updateAiFeatureFlags, updateRiskRuleRollout, getAiRolloutHealth } from './rollout-governance.js'
import { rotateModelProfileCredentials, finalizeLegacyCredentialCleanup } from './model-profiles.js'
import { getInferencePreference, saveInferencePreference } from './inference-preferences.js'
import { prepareEligibleDailyReviews, prepareEligibleMonthlyReviews,
  runDailyReviewWorkerOnce, runMonthlyReviewWorkerOnce, listPeriodReviewCases, getPeriodReviewCase,
  editPeriodReviewCase, confirmPeriodReviewCase, retryPeriodReviewCase, getPeriodReviewSummary,
  markPeriodReviewRead, getPeriodReviewJobStatus, requestPeriodReviewCycle,
  retryPeriodReviewDerivation } from './period-review.js'
import { listModelSnapshotSamples } from './model-snapshot-samples.js'
import { translateAdminProfileError, updateAdminUserProfile } from './admin-user-profile.js'
import { getPositionManagementSettings, getPositionManagementTask, listPositionManagementTasks,
  savePositionManagementSettings, getPositionManagementAdminSettings,
  saveGlobalPositionManagementControl } from './position-management.js'
import { getPositionManagementWorkerStatus } from './position-management-worker.js'

const router = Router()

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const BRIDGE_VERSION = readFileSync(join(__dirname, '../../../VERSION'), 'utf-8').trim()
const BRIDGE_RELEASE = Object.freeze({
  buildDate: '2026-07-25',
  fullUrl: 'https://qiniu.acadfx.com/AURUM_Bridge/AURUM_Bridge_Setup_v2.4.9.exe',
  fileSize: 46700815,
  sha256: '289FB6F52A77F2D2A31ACBE11EB9229364B67B5BE570D72439941A4EF3CF5580'
})

router.get('/bridge/version', (req, res) => {
  res.json({
    version: BRIDGE_VERSION,
    build_date: BRIDGE_RELEASE.buildDate,
    changelog: `${BRIDGE_VERSION}: 桥接服务器同时支持 HTTP/HTTPS 与 WS/WSS`,
    bridge_ticket_required: process.env.ALLOW_LEGACY_BRIDGE_QUERY_TOKEN !== '1',
    legacy_bridge_query_token_enabled: process.env.ALLOW_LEGACY_BRIDGE_QUERY_TOKEN === '1',
    auto_update_enabled: false,
    auto_update_disabled_reason: 'signed_update_manifest_required',
    updater_url: '',
    full_url: BRIDGE_RELEASE.fullUrl,
    file_size: BRIDGE_RELEASE.fileSize,
    sha256: BRIDGE_RELEASE.sha256
  })
})

router.get('/bridge/ws-health', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' })
  let recentStatus = []
  try {
    recentStatus = await queryAll(
      'SELECT user_id AS userId, connected, connected_at AS connectedAt, disconnected_at AS disconnectedAt, last_close_code AS lastCloseCode, last_close_reason AS lastCloseReason, last_error AS lastError, client_version AS clientVersion, mt5_collect_timeout_count AS mt5CollectTimeoutCount, updated_at AS updatedAt FROM bridge_connection_status ORDER BY updated_at DESC LIMIT 50'
    )
  } catch (e) {
    console.error('[BridgeWS] ws-health recentStatus query failed:', e.message)
  }
  res.json({
    ok: true,
    serverTime: new Date().toISOString(),
    bridges: getBridgeDiagnostics(),
    recentStatus,
  })
})

// AI Lab access is server-authoritative. The frontend consumes the same
// context for presentation, while this middleware prevents direct API bypass.
router.use('/ai', authMiddleware, (req, res, next) => {
  const access = buildAiAccessContext(req.user, { ownBridgeConnected:isBridgeAlive(req.user.id) })
  req.aiAccess = access
  const aiPath = String(req.originalUrl || req.url || '').split('?')[0].replace(/^\/api/, '')
  if (observerHttpRequestAllowed(access, req.method, aiPath)) return next()
  return res.status(403).json({
    ok:false,
    error:observerAccessError(access, { page:req.method === 'GET' }),
    code:req.method === 'GET' ? 'observer_page_forbidden' : 'observer_read_only',
    access,
  })
})

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
  const status = code.includes('not_found') ? 404 : code.includes('conflict') ? 409 : (code.includes('access_denied') || code.includes('admin_required') || code.includes('admin_only') || code.includes('requires_admin') || code.includes('pro_access_required')) ? 403 : 400
  return res.status(status).json({ ok: false, error: code })
}

function requireAiAdmin(req, res) {
  if (req.user?.role === 'admin') return true
  res.status(403).json({ ok:false, error:'admin_only' })
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

async function applyObserverBridgeRuntime(source) {
  try {
    const result = await applyBridgeRuntimeState(Number(source.bridge_user_id), {
      tradeEnabled:source.status === 'active' && Boolean(source.trade_send_enabled),
      autoReasoningEnabled:source.status === 'active' && Boolean(source.auto_inference_enabled),
    })
    return { ok:true, result }
  } catch (error) {
    console.error('[AI Runtime] observer bridge apply failed:', error)
    return { ok:false, degraded:true, error:'observer_bridge_runtime_sync_pending' }
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
    const [scheduler_sync, bridge_sync] = await Promise.all([
      reconcileAiRuntime(), applyObserverBridgeRuntime(source),
    ])
    const runtime_sync = { scheduler_sync, bridge_sync,
      degraded:!scheduler_sync.ok || !bridge_sync.ok }
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
    const [scheduler_sync, bridge_sync] = await Promise.all([
      reconcileAiRuntime(), applyObserverBridgeRuntime(source),
    ])
    const runtime_sync = { scheduler_sync, bridge_sync,
      degraded:!scheduler_sync.ok || !bridge_sync.ok }
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
    const [scheduler_sync, bridge_sync] = await Promise.all([
      reconcileAiRuntime(),
      applyObserverBridgeRuntime({ ...deleted, status:'disabled', trade_send_enabled:false, auto_inference_enabled:false }),
    ])
    const runtime_sync = { scheduler_sync, bridge_sync,
      degraded:!scheduler_sync.ok || !bridge_sync.ok }
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

router.post('/ai/model-profiles', authMiddleware, async (req, res) => {
  try {
    const profile = await createModelProfile(req.user.id, req.body || {}, req.user.role)
    await auditAiMutation(req, 'ai_model_profile_created', 'ai_model_profile', profile.id, {
      scope:profile.scope, provider:profile.provider, model_name:profile.model_name,
    })
    res.json({ ok:true, profile })
  }
  catch (error) { reviewError(res, error) }
})

router.put('/ai/model-profiles/:id', authMiddleware, async (req, res) => {
  try {
    const profile = await updateModelProfile(Number(req.params.id), req.body?.scope === 'platform' && req.user.role === 'admin' ? 0 : req.user.id, req.body || {})
    await auditAiMutation(req, 'ai_model_profile_updated', 'ai_model_profile', profile.id, {
      scope:profile.scope, provider:profile.provider, model_name:profile.model_name,
      credential_rotated:Boolean(req.body?.api_key),
    })
    res.json({ ok:true, profile })
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
    const provider = resolved.model.provider || resolved.model.api_provider
    const protocol = modelProviderProtocol(provider)
    const base = String(resolved.model.api_base_url || MODEL_PROVIDER_DEFAULTS[provider] || '').replace(/\/+$/, '')
    if (!base) throw new Error('unsupported_model_provider')
    const started = Date.now()
    const result = await requestJsonObject({ url: `${base}/${protocol === 'responses' ? 'responses' : 'chat/completions'}`,
      apiKey: resolved.model.api_key_encrypted, provider, model: resolved.model.model_name, temperature: 0,
      maxTokens: 40, protocol,
      timeout: resolved.model.request_timeout_ms || 120000,
      thinkingEnabled: Boolean(resolved.model.thinking_enabled),
      reasoningEffort: provider === 'kimi_code' && resolved.model.model_name === 'k3' ? 'max' : resolved.model.reasoning_effort,
      messages: [{ role: 'system', content: 'Return JSON only.' }, { role: 'user', content: '{"ok":true}' }],
      usageContext: { userId: req.user.id, profileId: resolved.model_profile_id, credentialSource: resolved.credential_source, usage: 'manual', strategyId: null } })
    res.json({ ok: true, latency_ms: Date.now() - started, provider, model_name: resolved.model.model_name, response_valid: result?.ok === true })
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
    const resolved = await resolveAiTaskModel({ userId: req.user.id, strategyId, usage })
    res.json({ ok: true, source: {
      available: Boolean(resolved.model), credential_source: resolved.credential_source,
      reason: resolved.reason || null, error: resolved.error || null,
      model_profile_id: resolved.model_profile_id || null,
      provider: resolved.model?.provider || null, model_name: resolved.model?.model_name || null,
      usage: resolved.usage, strategy_id: resolved.strategy_id || null,
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
    const runtime_sync = await reconcileAiRuntime()
    await auditAiMutation(req, 'ai_strategy_updated', 'ai_strategy', strategy.id, {
      scope:strategy.scope, visibility_status:strategy.visibility_status, version:strategy.version,
    })
    res.json({ ok:true, strategy, runtime_sync })
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
    const accounts = await listTradingAccounts(req.user.id)
    const subscriptions = await listSubscriptions(req.user.id, req.user.role)
    const rows = []
    for (const account of accounts) {
      const riskState = await queryAll(`SELECT halt_status, halt_reason, drawdown_pct, consecutive_losses,
        cooldown_until, user_kill_switch, data_complete, data_incomplete_reason, last_risk_snapshot_at
        FROM risk_account_state WHERE trading_account_id = ? LIMIT 1`, [account.id])
      rows.push({ account, risk_state: riskState[0] || null,
        performance:await getAccountPerformanceSummary(account.id, req.user.id),
        effective: await resolveEffectiveRiskPolicy({ userId: req.user.id, tradingAccountId: account.id }),
        subscriptions: subscriptions.filter(item => Number(item.trading_account_id) === Number(account.id)) })
    }
    res.json({ ok: true, accounts: rows, rule_metadata: RISK_RULES })
  } catch (error) { reviewError(res, error) }
})

router.post('/ai/risk-center/refresh', authMiddleware, async (req, res) => {
  try { res.json({ ok: true, ...(await refreshIncompleteRiskAccounts(req.user.id)) }) }
  catch (error) { reviewError(res, error) }
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
    res.json({ ok: true, result: await submitRiskPolicyChanges({ policySetId: sets[0].id, actorId: req.user.id, changes: req.body?.changes || {}, reason: req.body?.reason || '用户更新账户风控' }) })
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
    res.json({ ok:true, result })
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

router.get('/ai/period-reviews', authMiddleware, async (req, res) => {
  try { res.json({ ok: true, cases: await listPeriodReviewCases(req.user, req.query) }) }
  catch (error) { reviewError(res, error) }
})

router.get('/ai/period-reviews/summary', authMiddleware, async (req, res) => {
  try { res.json({ ok: true, summary: await getPeriodReviewSummary(req.user) }) }
  catch (error) { reviewError(res, error) }
})

router.get('/ai/period-reviews/:id', authMiddleware, async (req, res) => {
  try { res.json({ ok: true, review: await getPeriodReviewCase(Number(req.params.id), req.user) }) }
  catch (error) { reviewError(res, error) }
})

router.get('/ai/period-reviews/:id/job-status', authMiddleware, async (req, res) => {
  try { res.json({ ok: true, job: await getPeriodReviewJobStatus(Number(req.params.id), req.user) }) }
  catch (error) { reviewError(res, error) }
})

router.post('/ai/period-reviews/:id/edit', authMiddleware, async (req, res) => {
  try { res.json({ ok: true, ...(await editPeriodReviewCase({ periodCaseId: Number(req.params.id), actor: req.user,
    content: req.body?.content, expectedVersionId: req.body?.expected_version_id, changeNote: req.body?.change_note })) }) }
  catch (error) { reviewError(res, error) }
})

router.post('/ai/period-reviews/:id/read', authMiddleware, async (req, res) => {
  try { res.json({ ok: true, ...(await markPeriodReviewRead(Number(req.params.id), req.user, req.body?.version_id)) }) }
  catch (error) { reviewError(res, error) }
})

router.post('/ai/period-reviews/:id/confirm', authMiddleware, async (req, res) => {
  try {
    const periodCaseId = Number(req.params.id)
    const result = await confirmPeriodReviewCase({ periodCaseId, actor: req.user,
      versionId: req.body?.version_id, action: req.body?.action })
    if (req.body?.action === 'approve') requestPeriodReviewCycle()
    res.json({ ok: true, ...result })
  } catch (error) { reviewError(res, error) }
})

router.post('/ai/period-reviews/:id/retry', authMiddleware, async (req, res) => {
  try { res.json({ ok: true, ...(await retryPeriodReviewCase(Number(req.params.id), req.user)) }) }
  catch (error) { reviewError(res, error) }
})

router.post('/ai/period-reviews/:id/derivation/retry', authMiddleware, async (req, res) => {
  try { res.json({ ok:true, ...(await retryPeriodReviewDerivation(Number(req.params.id), req.user)) }) }
  catch (error) { reviewError(res, error) }
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
  if (canManagePlatformAiContent(req.user)) return res.status(403).json({ ok: false, error: 'admin_personal_memory_disabled' })
  try {
    const [items, summaries, settings] = await Promise.all([
      listMemoryItems(req.user.id, req.query), listMemorySummaries(req.user.id, req.query), getMemorySettings(req.user.id),
    ])
    res.json({ ok: true, items, summaries, settings })
  }
  catch (error) { reviewError(res, error) }
})

router.put('/ai/memory/settings', authMiddleware, async (req, res) => {
  if (canManagePlatformAiContent(req.user)) return res.status(403).json({ ok: false, error: 'admin_personal_memory_disabled' })
  try { res.json({ ok: true, settings: await setMemorySettings(req.user.id, req.body || {}) }) }
  catch (error) { reviewError(res, error) }
})

router.post('/ai/memory/:id/revoke', authMiddleware, async (req, res) => {
  if (canManagePlatformAiContent(req.user)) return res.status(403).json({ ok: false, error: 'admin_personal_memory_disabled' })
  try { res.json({ ok: true, ...(await revokeMemoryItem(Number(req.params.id), req.user.id)) }) }
  catch (error) { reviewError(res, error) }
})

router.post('/ai/memory/:id/activate', authMiddleware, async (req, res) => {
  if (canManagePlatformAiContent(req.user)) return res.status(403).json({ ok: false, error: 'admin_personal_memory_disabled' })
  try { res.json({ ok: true, item: await activateDuplicateMemory(Number(req.params.id), req.user.id) }) }
  catch (error) { reviewError(res, error) }
})

router.post('/ai/memory/long/:id/confirm', authMiddleware, async (req, res) => {
  if (canManagePlatformAiContent(req.user)) return res.status(403).json({ ok: false, error: 'admin_personal_memory_disabled' })
  try { res.json({ ok: true, item: await confirmLongTermMemory(Number(req.params.id), req.user.id) }) }
  catch (error) { reviewError(res, error) }
})

router.post('/ai/memory/long/:id/revoke', authMiddleware, async (req, res) => {
  if (canManagePlatformAiContent(req.user)) return res.status(403).json({ ok: false, error: 'admin_personal_memory_disabled' })
  try { res.json({ ok: true, ...(await revokeLongTermMemory(Number(req.params.id), req.user.id)) }) }
  catch (error) { reviewError(res, error) }
})

router.post('/ai/memory/summaries/:id/rollback', authMiddleware, async (req, res) => {
  if (canManagePlatformAiContent(req.user)) return res.status(403).json({ ok: false, error: 'admin_personal_memory_disabled' })
  try { res.json({ ok: true, ...(await rollbackMemorySummary(Number(req.params.id), req.user.id)) }) }
  catch (error) { reviewError(res, error) }
})

router.get('/ai/admin/platform-experience', authMiddleware, async (req, res) => {
  if (!canManagePlatformAiContent(req.user)) return res.status(403).json({ ok: false, error: 'admin_only' })
  try {
    const [items, policies, evaluation] = await Promise.all([
      listPlatformExperience(req.query), getPlatformExperiencePolicies(), getPlatformExperienceEvaluation(req.query),
    ])
    res.json({ ok: true, items, policies, evaluation })
  } catch (error) { reviewError(res, error) }
})

router.put('/ai/admin/platform-experience/policies/:strategyId', authMiddleware, async (req, res) => {
  if (!canManagePlatformAiContent(req.user)) return res.status(403).json({ ok: false, error: 'admin_only' })
  try { res.json({ ok: true, policy: await updatePlatformExperiencePolicy(Number(req.params.strategyId), req.user.id, req.body || {}) }) }
  catch (error) { reviewError(res, error) }
})

router.post('/ai/admin/platform-experience/:id/:action', authMiddleware, async (req, res) => {
  if (!canManagePlatformAiContent(req.user)) return res.status(403).json({ ok: false, error: 'admin_only' })
  const status = req.params.action === 'publish' ? 'active' : req.params.action === 'revoke' ? 'revoked' : null
  if (!status) return res.status(400).json({ ok: false, error: 'invalid_platform_experience_action' })
  try { res.json({ ok: true, item: await updatePlatformExperienceItem(Number(req.params.id), req.user.id, status) }) }
  catch (error) { reviewError(res, error) }
})

router.delete('/ai/admin/platform-experience/:id', authMiddleware, async (req, res) => {
  if (!canManagePlatformAiContent(req.user)) return res.status(403).json({ ok: false, error: 'admin_only' })
  try { res.json({ ok:true, ...(await deleteRevokedPlatformExperienceItem(Number(req.params.id))) }) }
  catch (error) { reviewError(res, error) }
})

export { initAutoSchedulers }

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
export { refreshIncompleteRiskAccounts } from './risk-snapshot-refresh.js'
export { normalizePerformanceDay, nextPerformanceWindow, recentPerformanceWindow,
  getAccountPerformanceSyncWindow, saveAccountPerformanceChunk,
  recordAccountPerformanceSyncFailure, getAccountPerformanceSummary } from './account-performance.js'
export { analyzeOutcomeAttribution, resolveOutcomeClosureTransition,
  reconcileSignalOutcomes, startOutcomeMonitor, stopOutcomeMonitor } from './signal-outcomes.js'
export { validateReviewContent, assessReviewEvidence, ensureReviewCaseForOutcome,
  enqueueEligibleReviewCases, runReviewWorkerOnce, startReviewWorker, stopReviewWorker,
  listReviewCases, getReviewCase, editReviewCase, confirmReviewCase, retryReviewCase,
  getReviewAdminHealth } from './review-workflow.js'
export { sanitizeMemoryText, memorySimilarity, rankMemoryCandidates,
  createMemoryFromApprovedReview, createMemoryFromApprovedPeriodReview,
  setMemorySettings, getMemorySettings, listMemoryItems, listMemorySummaries,
  confirmLongTermMemory, revokeLongTermMemory,
  revokeMemoryItem, activateDuplicateMemory, retrievePersonalMemory, attachMemoryInjectionSignal,
  maybeQueueCompression, runMemoryCompressionOnce, rollbackMemorySummary,
  startMemoryCompressionWorker, stopMemoryCompressionWorker } from './memory-system.js'
export { prepareEligibleDailyReviews, prepareEligibleMonthlyReviews,
  runDailyReviewWorkerOnce, runMonthlyReviewWorkerOnce, runPeriodReviewCycle,
  runPeriodReviewDerivationOnce, resumePeriodReviewDerivationJobs,
  startPeriodReviewWorker, stopPeriodReviewWorker, listPeriodReviewCases, getPeriodReviewCase,
  editPeriodReviewCase, confirmPeriodReviewCase, retryPeriodReviewCase, getPeriodReviewSummary,
  markPeriodReviewRead, getPeriodReviewJobStatus, requestPeriodReviewCycle,
  retryPeriodReviewDerivation } from './period-review.js'
export { sanitizePlatformExperienceText, createPlatformExperienceCandidateFromApprovedReview,
  createPlatformExperienceCandidateFromApprovedPeriodReview,
  listPlatformExperience, getPlatformExperiencePolicies, updatePlatformExperiencePolicy,
  updatePlatformExperienceItem, retrievePlatformExperience, attachPlatformExperienceSignal } from './platform-experience.js'

export { assertAiGovernanceSchemaReady, getEffectiveFeatureFlags, updateAiFeatureFlags,
  updateRiskRuleRollout, getAiRolloutHealth } from './rollout-governance.js'

export { STRATEGY_TIMEFRAME_COUNTS, parseTimeframeTags, stripTimeframeTags,
  attachSignalTiming, timeframeIntervalMs } from './utils.js'
export { attachSignalPresentation, buildExecutionAdvice, normalizeDecisionFields, restrictSignalExperienceUsage } from './signal-presentation.js'
export { getInferenceVisualizationSnapshot, inferenceVisualizationSnapshot } from './inference-snapshots.js'
export { POSITION_MANAGEMENT_CONTRACT_VERSION, buildPositionManagementAsOf,
  buildPositionManagementOutputFormat, validatePositionManagementResponse,
  createTradeThesisTx, loadActivePositionManagementContext, persistPositionManagementEvaluations,
  canTransitionPositionManagement, transitionPositionManagementTask,
  claimPositionManagementLease, createPositionManagementCommand,
  getPositionManagementSettings, savePositionManagementSettings,
  listPositionManagementTasks, getPositionManagementTask } from './position-management.js'

export default router
