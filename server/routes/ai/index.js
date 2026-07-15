// ai/index.js — 入口，re-export + Router

import { Router } from 'express'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { queryAll, queryRun, withTransaction, beijingNow } from '../../db.js'
import { authMiddleware } from '../../middleware/auth.js'
import { attachSignalTiming, configPublic, timeframeIntervalMs, STRATEGY_TIMEFRAME_COUNTS, parseTimeframeTags, stripTimeframeTags } from './utils.js'
import { mt5Bridge, calculateMarketData } from './market-data.js'
import { maybeAiSignal, requestJsonObject } from './llm.js'
import { getActiveConfig, getAnalyzeApiKey, getAutoConfig, getGlobalAutoConfig, saveGlobalAutoConfig, upsertAutoConfig, insertAudit, getAutoPromptTypes, getAutoPromptTypeById, saveAutoPromptType, disableAutoPromptType, getUserAutoConfig, saveUserAutoConfig, getUnifiedAutoInferenceConfig, getAutoSubscribers, getDeliveryExecuteRiskConfig } from './config.js'
import { handleAnalyze, buildStrategyContextFromTags } from './strategy.js'
import { initAutoSchedulers, startAutoScheduler, stopAutoScheduler, isAutoSchedulerRunning, reconcileAutoSchedulers, closeSchedulerState, startSmartCloseScheduler, stopSmartCloseScheduler, runSmartCloseCycle } from './scheduler.js'
import { getBridgeDiagnostics } from '../../bridge-ws.js'
import { listReviewCases, getReviewCase, editReviewCase, confirmReviewCase, retryReviewCase,
  ensureReviewCaseForOutcome, getReviewAdminHealth } from './review-workflow.js'
import { createMemoryFromApprovedReview, listMemoryItems, revokeMemoryItem, activateDuplicateMemory,
  getMemorySettings, setMemorySettings, rollbackMemorySummary } from './memory-system.js'
import { createModelProfile, getUserModelProfiles, updateModelProfile, deleteModelProfile,
  setDefaultModelProfile, getPlatformUsagePolicy, updatePlatformUsagePolicy,
  resolveOwnedModelProfileForRuntime, resolveAiTaskModel } from './model-profiles.js'
import { listStrategies, listTradingAccounts, listSubscriptions, adminReviewTradingAccount } from './strategy-ownership.js'
import { resolveEffectiveRiskPolicy, submitRiskPolicyChanges, RISK_RULES, DEFAULT_RISK_POLICY } from './risk-policy.js'
import { requestRiskRecovery, reviewRiskRecovery, setUserKillSwitch, setGlobalKillSwitch } from './risk-state.js'

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

const modelProviderDefaults = {
  deepseek: 'https://api.deepseek.com', gpt: 'https://api.openai.com/v1', kimi: 'https://api.moonshot.cn/v1',
  qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1', zhipu: 'https://open.bigmodel.cn/api/paas/v4',
  doubao: 'https://ark.cn-beijing.volces.com/api/v3', volcengine_agent_plan: 'https://ark.cn-beijing.volces.com/api/plan/v3',
}

router.get('/ai/model-profiles', authMiddleware, async (req, res) => {
  try {
    const ownerId = req.user.role === 'admin' && req.query.scope === 'platform' ? 0 : req.user.id
    const profiles = await getUserModelProfiles(ownerId)
    res.json({ ok: true, profiles, credential_fields_redacted: true })
  } catch (error) { reviewError(res, error) }
})

router.post('/ai/model-profiles', authMiddleware, async (req, res) => {
  try { res.json({ ok: true, profile: await createModelProfile(req.user.id, req.body || {}, req.user.role) }) }
  catch (error) { reviewError(res, error) }
})

router.put('/ai/model-profiles/:id', authMiddleware, async (req, res) => {
  try { res.json({ ok: true, profile: await updateModelProfile(Number(req.params.id), req.body?.scope === 'platform' && req.user.role === 'admin' ? 0 : req.user.id, req.body || {}) }) }
  catch (error) { reviewError(res, error) }
})

router.delete('/ai/model-profiles/:id', authMiddleware, async (req, res) => {
  try { await deleteModelProfile(Number(req.params.id), req.query.scope === 'platform' && req.user.role === 'admin' ? 0 : req.user.id); res.json({ ok: true }) }
  catch (error) { reviewError(res, error) }
})

router.post('/ai/model-profiles/:id/default', authMiddleware, async (req, res) => {
  try { await setDefaultModelProfile(req.user.role === 'admin' && req.body?.scope === 'platform' ? 0 : req.user.id, Number(req.params.id)); res.json({ ok: true }) }
  catch (error) { reviewError(res, error) }
})

router.post('/ai/model-profiles/:id/test', authMiddleware, async (req, res) => {
  try {
    const ownerId = req.user.role === 'admin' && req.body?.scope === 'platform' ? 0 : req.user.id
    const resolved = await resolveOwnedModelProfileForRuntime(Number(req.params.id), ownerId)
    if (!resolved.model) throw new Error(resolved.error || 'model_unavailable')
    const provider = resolved.model.provider || resolved.model.api_provider
    const protocol = provider === 'volcengine_agent_plan' ? 'responses' : 'chat_completions'
    const base = String(resolved.model.api_base_url || modelProviderDefaults[provider] || '').replace(/\/+$/, '')
    if (!base) throw new Error('unsupported_model_provider')
    const started = Date.now()
    const result = await requestJsonObject({ url: `${base}/${protocol === 'responses' ? 'responses' : 'chat/completions'}`,
      apiKey: resolved.model.api_key_encrypted, model: resolved.model.model_name, temperature: 0,
      maxTokens: 40, protocol, messages: [{ role: 'system', content: 'Return JSON only.' }, { role: 'user', content: '{"ok":true}' }],
      usageContext: { userId: req.user.id, profileId: resolved.model_profile_id, credentialSource: resolved.credential_source, usage: 'manual', strategyId: null } })
    res.json({ ok: true, latency_ms: Date.now() - started, provider, model_name: resolved.model.model_name, response_valid: result?.ok === true })
  } catch (error) { reviewError(res, error) }
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
    const [strategies, subscriptions] = await Promise.all([
      listStrategies(req.user.id, req.user.role, { scope: req.query.scope || undefined, includeInactive: req.query.include_inactive === '1' }),
      listSubscriptions(req.user.id, req.user.role),
    ])
    res.json({ ok: true, strategies, subscriptions })
  }
  catch (error) { reviewError(res, error) }
})

router.get('/ai/risk-center', authMiddleware, async (req, res) => {
  try {
    const accounts = await listTradingAccounts(req.user.id)
    const subscriptions = await listSubscriptions(req.user.id, req.user.role)
    const rows = []
    for (const account of accounts) {
      const pending = await queryAll(`SELECT rpci.field_code, rpci.new_value_json, rpci.effective_at
        FROM risk_policy_change_items rpci JOIN risk_policy_sets rps ON rps.id = rpci.policy_set_id
        WHERE rps.scope = 'account' AND rps.owner_user_id = ? AND rps.trading_account_id = ? AND rpci.status = 'pending'
        ORDER BY rpci.effective_at`, [req.user.id, account.id])
      const riskState = await queryAll('SELECT halt_status, halt_reason, cooldown_until, user_kill_switch, data_complete FROM risk_account_state WHERE trading_account_id = ? LIMIT 1', [account.id])
      rows.push({ account, risk_state: riskState[0] || null, effective: await resolveEffectiveRiskPolicy({ userId: req.user.id, tradingAccountId: account.id }), pending_changes: pending, subscriptions: subscriptions.filter(item => Number(item.trading_account_id) === Number(account.id)) })
    }
    res.json({ ok: true, accounts: rows, rule_metadata: RISK_RULES })
  } catch (error) { reviewError(res, error) }
})

router.post('/ai/risk-center/:accountId/kill-switch', authMiddleware, async (req, res) => {
  try {
    await setUserKillSwitch(req.user.id, Number(req.params.accountId), Boolean(req.body?.enabled), req.body?.reason)
    res.json({ ok: true })
  } catch (error) { reviewError(res, error) }
})

router.post('/ai/risk-center/:accountId/recovery', authMiddleware, async (req, res) => {
  try { res.json({ ok: true, request_id: await requestRiskRecovery(req.user.id, Number(req.params.accountId), req.body?.reason) }) }
  catch (error) { reviewError(res, error) }
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
    res.json({ ok: true, result: await submitRiskPolicyChanges({ policySetId: sets[0].id, actorId: req.user.id, changes: req.body?.changes || {}, reason: req.body?.reason || '用户更新账户风控', cooldownHours: 2 }) })
  } catch (error) { reviewError(res, error) }
})

router.get('/ai/executions', authMiddleware, async (req, res) => {
  try {
    const rows = await queryAll(`SELECT oi.id, oi.source_type, oi.source_id, oi.action, oi.symbol, oi.status,
      oi.original_order_json, oi.approved_order_json, oi.result_json, oi.error_code, oi.created_at, oi.completed_at,
      rd.policy_version_ids_json, rd.rule_results_json, rd.decision_status, rd.reject_code
      FROM order_intents oi LEFT JOIN risk_decisions rd ON rd.order_intent_id = oi.id
      WHERE oi.user_id = ? ORDER BY oi.id DESC LIMIT 100`, [req.user.id])
    res.json({ ok: true, executions: rows })
  } catch (error) { reviewError(res, error) }
})

router.get('/ai/admin/risk-center', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false, error: 'admin_only' })
  try {
    const accounts = await queryAll(`SELECT ta.*, u.nickname AS user_nickname, u.email AS user_email,
      ras.halt_status, ras.halt_reason, ras.drawdown_pct, ras.consecutive_losses, ras.cooldown_until,
      ras.user_kill_switch, ras.data_complete FROM trading_accounts ta
      JOIN users u ON u.id = ta.user_id LEFT JOIN risk_account_state ras ON ras.trading_account_id = ta.id
      WHERE ta.is_deleted = 0 ORDER BY ta.updated_at DESC LIMIT 500`)
    const recoveries = await queryAll(`SELECT rr.*, ta.login_account, ta.nickname AS account_nickname, u.nickname AS user_nickname, u.email AS user_email
      FROM risk_recovery_requests rr JOIN trading_accounts ta ON ta.id = rr.trading_account_id JOIN users u ON u.id = rr.user_id
      WHERE rr.status = 'pending' ORDER BY rr.created_at`)
    const global = await queryAll('SELECT global_kill_switch, reason, changed_by, updated_at FROM global_risk_control WHERE id = 1 LIMIT 1')
    let set = await queryAll("SELECT * FROM risk_policy_sets WHERE scope = 'platform' AND status = 'active' ORDER BY id LIMIT 1")
    let platform = null
    if (set[0]) platform = await queryAll('SELECT * FROM risk_policy_versions WHERE policy_set_id = ? ORDER BY version_no DESC LIMIT 1', [set[0].id])
    res.json({ ok: true, accounts, recoveries, global_control: global[0] || null, platform_policy_set: set[0] || null, platform_policy_version: platform?.[0] || null, defaults: DEFAULT_RISK_POLICY, rule_metadata: RISK_RULES })
  } catch (error) { reviewError(res, error) }
})

router.post('/ai/admin/risk-center/kill-switch', authMiddleware, async (req, res) => {
  try { await setGlobalKillSwitch(req.user.id, req.user.role, Boolean(req.body?.enabled), req.body?.reason); res.json({ ok: true }) }
  catch (error) { reviewError(res, error) }
})

router.post('/ai/admin/recoveries/:id/review', authMiddleware, async (req, res) => {
  try { await reviewRiskRecovery(req.user.id, req.user.role, Number(req.params.id), Boolean(req.body?.approve), req.body?.reason); res.json({ ok: true }) }
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
      const values = { ...DEFAULT_RISK_POLICY, ...(raw.values || raw.defaults || raw), ...(req.body?.values || req.body?.changes || {}) }
      const controls = { ...(raw.controls || {}) }
      for (const [key, input] of Object.entries(req.body?.controls || {})) {
        const meta = RISK_RULES[key]
        if (!meta || meta.type !== 'number') continue
        const min = Math.max(Number(meta.allowed_min), Number(input.allowed_min ?? meta.allowed_min))
        const max = Math.min(Number(meta.allowed_max), Number(input.allowed_max ?? meta.allowed_max))
        if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) throw new Error(`invalid_global_risk_range:${key}`)
        let locked = input.locked_value
        if (locked !== null && locked !== undefined && locked !== '') locked = Math.min(max, Math.max(min, Number(locked)))
        else locked = null
        controls[key] = { allowed_min: min, allowed_max: max, locked_value: locked, user_editable: input.user_editable !== false }
      }
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

router.post('/ai/admin/accounts/:id/review', authMiddleware, async (req, res) => {
  try { res.json({ ok: true, account: await adminReviewTradingAccount(Number(req.params.id), req.user.id, req.user.role, req.body || {}) }) }
  catch (error) { reviewError(res, error) }
})

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
  try {
    const caseId = Number(req.params.id)
    const result = await confirmReviewCase({ caseId, userId: req.user.id, versionId: req.body?.version_id, action: req.body?.action, tradeProcessIssueStatus: req.body?.trade_process_issue_status })
    let memory = null
    if (req.body?.action === 'approve') memory = await createMemoryFromApprovedReview(caseId, req.user.id)
    res.json({ ok: true, ...result, memory })
  }
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

router.get('/ai/memory', authMiddleware, async (req, res) => {
  try { res.json({ ok: true, items: await listMemoryItems(req.user.id, req.query), settings: await getMemorySettings(req.user.id) }) }
  catch (error) { reviewError(res, error) }
})

router.put('/ai/memory/settings', authMiddleware, async (req, res) => {
  try { res.json({ ok: true, settings: await setMemorySettings(req.user.id, req.body || {}) }) }
  catch (error) { reviewError(res, error) }
})

router.post('/ai/memory/:id/revoke', authMiddleware, async (req, res) => {
  try { res.json({ ok: true, ...(await revokeMemoryItem(Number(req.params.id), req.user.id)) }) }
  catch (error) { reviewError(res, error) }
})

router.post('/ai/memory/:id/activate', authMiddleware, async (req, res) => {
  try { res.json({ ok: true, item: await activateDuplicateMemory(Number(req.params.id), req.user.id) }) }
  catch (error) { reviewError(res, error) }
})

router.post('/ai/memory/summaries/:id/rollback', authMiddleware, async (req, res) => {
  try { res.json({ ok: true, ...(await rollbackMemorySummary(Number(req.params.id), req.user.id)) }) }
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
export { sanitizeMemoryText, memorySimilarity, rankMemoryCandidates,
  createMemoryFromApprovedReview, setMemorySettings, getMemorySettings, listMemoryItems,
  revokeMemoryItem, activateDuplicateMemory, retrievePersonalMemory, attachMemoryInjectionSignal,
  maybeQueueCompression, runMemoryCompressionOnce, rollbackMemorySummary,
  startMemoryCompressionWorker, stopMemoryCompressionWorker } from './memory-system.js'

export { STRATEGY_TIMEFRAME_COUNTS, parseTimeframeTags, stripTimeframeTags,
  attachSignalTiming, configPublic, timeframeIntervalMs } from './utils.js'

export default router
