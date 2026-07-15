// ai/index.js — 入口，re-export + Router

import { Router } from 'express'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { queryAll } from '../../db.js'
import { authMiddleware } from '../../middleware/auth.js'
import { attachSignalTiming, configPublic, timeframeIntervalMs, STRATEGY_TIMEFRAME_COUNTS, parseTimeframeTags, stripTimeframeTags } from './utils.js'
import { mt5Bridge, calculateMarketData } from './market-data.js'
import { maybeAiSignal } from './llm.js'
import { getActiveConfig, getAnalyzeApiKey, getAutoConfig, getGlobalAutoConfig, saveGlobalAutoConfig, upsertAutoConfig, insertAudit, getAutoPromptTypes, getAutoPromptTypeById, saveAutoPromptType, disableAutoPromptType, getUserAutoConfig, saveUserAutoConfig, getUnifiedAutoInferenceConfig, getAutoSubscribers, getDeliveryExecuteRiskConfig } from './config.js'
import { handleAnalyze, buildStrategyContextFromTags } from './strategy.js'
import { initAutoSchedulers, startAutoScheduler, stopAutoScheduler, isAutoSchedulerRunning, reconcileAutoSchedulers, closeSchedulerState, startSmartCloseScheduler, stopSmartCloseScheduler, runSmartCloseCycle } from './scheduler.js'
import { getBridgeDiagnostics } from '../../bridge-ws.js'
import { listReviewCases, getReviewCase, editReviewCase, confirmReviewCase, retryReviewCase,
  ensureReviewCaseForOutcome, getReviewAdminHealth } from './review-workflow.js'

const router = Router()

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const BRIDGE_VERSION = readFileSync(join(__dirname, '../../../VERSION'), 'utf-8').trim()

router.get('/bridge/version', (req, res) => {
  res.json({
    version: BRIDGE_VERSION,
    build_date: new Date().toISOString().slice(0, 10),
    changelog: `${BRIDGE_VERSION}: 安装包+配置目录+接口统一`,
    updater_url: `https://qiniu.acadfx.com/AURUM_Bridge/AURUM_Bridge_Setup_${BRIDGE_VERSION}.exe`,
    full_url: `https://qiniu.acadfx.com/AURUM_Bridge/AURUM_Bridge_Setup_${BRIDGE_VERSION}.exe`,
    file_size: 0,
    md5: ''
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

function reviewError(res, error) {
  const code = String(error?.message || 'review_request_failed')
  const status = code.includes('not_found') ? 404 : code.includes('conflict') ? 409 : code.includes('access_denied') ? 403 : 400
  return res.status(status).json({ ok: false, error: code })
}

router.get('/ai/reviews', authMiddleware, async (req, res) => {
  try { res.json({ ok: true, cases: await listReviewCases(req.user.id, req.query) }) }
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
    res.json({ ok: true, review: await ensureReviewCaseForOutcome(Number(req.params.outcomeId)) })
  } catch (error) { reviewError(res, error) }
})

router.post('/ai/reviews/:id/edit', authMiddleware, async (req, res) => {
  try { res.json({ ok: true, ...(await editReviewCase({ caseId: Number(req.params.id), userId: req.user.id, content: req.body?.content, expectedVersionId: req.body?.expected_version_id, changeNote: req.body?.change_note })) }) }
  catch (error) { reviewError(res, error) }
})

router.post('/ai/reviews/:id/confirm', authMiddleware, async (req, res) => {
  try { res.json({ ok: true, ...(await confirmReviewCase({ caseId: Number(req.params.id), userId: req.user.id, versionId: req.body?.version_id, action: req.body?.action, tradeProcessIssueStatus: req.body?.trade_process_issue_status })) }) }
  catch (error) { reviewError(res, error) }
})

router.post('/ai/reviews/:id/retry', authMiddleware, async (req, res) => {
  try { res.json({ ok: true, ...(await retryReviewCase(Number(req.params.id), req.user.id)) }) }
  catch (error) { reviewError(res, error) }
})

router.get('/ai/admin/reviews/health', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false, error: 'admin_only' })
  try { res.json({ ok: true, health: await getReviewAdminHealth() }) }
  catch (error) { reviewError(res, error) }
})

export { initAutoSchedulers }

export { mt5Bridge } from './market-data.js'
export { isBridgeAlive, getAllBridges, getBridgeTradeMode } from '../../bridge-ws.js'

export { handleAnalyze } from './strategy.js'

export { maybeAiSignal } from './llm.js'

export { insertAudit, getActiveConfig, getAnalyzeApiKey,
  getAutoConfig, upsertAutoConfig, signalOrderPayload, executeOrderCore,
  getGlobalAutoConfig, saveGlobalAutoConfig,
  getExecuteRiskConfig, getAutoPromptTypes, getAutoPromptTypeById,
  saveAutoPromptType, disableAutoPromptType, getUserAutoConfig,
  saveUserAutoConfig, getUnifiedAutoInferenceConfig,
  getCloseConfig, saveCloseConfig, getCloseSignalTickets } from './config.js'

export { resolveAiTaskModel, logModelUsage, beginModelUsage, finishModelUsage, checkPlatformQuota,
  assertModelProfileSchemaReady,
  createModelProfile, getModelProfileById, getUserModelProfiles,
  updateModelProfile, deleteModelProfile, setDefaultModelProfile,
  getUserModelDefault, setUserModelDefault,
  getPlatformUsagePolicy, updatePlatformUsagePolicy,
  migrateLegacyConfigs } from './model-profiles.js'

export { buildOrderIdempotencyKey, prepareAndExecuteOrderIntent,
  recoverExpiredOrderIntentLeases, reconcileUncertainOrderIntents,
  startOrderIntentReconciler, stopOrderIntentReconciler } from './order-intents.js'

export { startAutoScheduler, stopAutoScheduler, isAutoSchedulerRunning,
  reconcileAutoSchedulers, closeSchedulerState, startSmartCloseScheduler, stopSmartCloseScheduler,
  runSmartCloseCycle, syncUserRedisSubscription, removeUserRuntimeAutoSubscription,
  getUserAutoRuntimeStatus } from './scheduler.js'

export { listStrategies, getStrategyById, createStrategy, updateStrategy, deleteStrategy,
  listTradingAccounts, getTradingAccountById, createTradingAccount, updateTradingAccount, deleteTradingAccount,
  adminReviewTradingAccount,
  listSubscriptions, createSubscription, updateSubscription, deleteSubscription,
  adminListUserStrategies, adminListUserSubscriptions, getSubscriptionWithContext } from './strategy-ownership.js'

export { RISK_RULES, DEFAULT_RISK_POLICY, resolveEffectiveRiskPolicy, submitRiskPolicyChanges,
  evaluateCoreRisk } from './risk-policy.js'
export { calculateAccountRiskMetrics, aggregateClosedPositions, requestRiskRecovery,
  reviewRiskRecovery, setUserKillSwitch, setGlobalKillSwitch } from './risk-state.js'
export { analyzeOutcomeAttribution, resolveOutcomeClosureTransition,
  reconcileSignalOutcomes, startOutcomeMonitor, stopOutcomeMonitor } from './signal-outcomes.js'
export { validateReviewContent, assessReviewEvidence, ensureReviewCaseForOutcome,
  enqueueEligibleReviewCases, runReviewWorkerOnce, startReviewWorker, stopReviewWorker,
  listReviewCases, getReviewCase, editReviewCase, confirmReviewCase, retryReviewCase,
  getReviewAdminHealth } from './review-workflow.js'

export { STRATEGY_TIMEFRAME_COUNTS, parseTimeframeTags, stripTimeframeTags,
  attachSignalTiming, configPublic, timeframeIntervalMs } from './utils.js'

export default router
