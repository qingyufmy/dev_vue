// ai/config.js — 配置管理 + 风控 + 审计

import { queryOne, queryAll, queryRun, withTransaction, beijingNow, parseBeijing } from '../../db.js'
import { stripBrokerSuffix } from './utils.js'
import { DEFAULT_API_BASE_URL } from '../../config.js'
import { mt5Bridge, computeAtr14 } from './market-data.js'
import { buildSafeExecutionOutcome, prepareAuditRecord, shouldSkipHoldAudit } from '../../audit-localization.js'
import { isEncryptionAvailable } from '../../ai-credential.js'
import { resolveAiTaskModel } from './model-profiles.js'
import { prepareAndExecuteOrderIntent } from './order-intents.js'
import { DEFAULT_AI_VOLUME_STEP, evaluateCoreRisk, persistRiskDecision, resolveEffectiveRiskPolicy, resolvePlatformAiVolumeRange } from './risk-policy.js'
import { normalizePositionSizeTier, positionSizeFactor } from './position-sizing.js'
import { evaluateStatefulRiskTx, syncTradingAccountIdentity } from './risk-state.js'
import { getRiskRuleRolloutModes } from './rollout-governance.js'
import { getInferencePreference } from './inference-preferences.js'
import { parseStrategyPolicy } from './strategy-policy.js'
import { subscriptionAllowsExecution, subscriptionAllowsInference } from './subscription-schedule.js'
import { DEFAULT_MAX_POSITION_SIZE } from './defaults.js'
import { applyDefaultObserverClockBootstrap, trustedTerminalClock } from './terminal-clock.js'
import { getDefaultObserverSourceClock } from './observer-channels.js'
import { auditTradingAccountId, buildAuditClockSnapshot } from './audit-clock.js'
import { executionValidationRejection, readExecutionValidation } from './signal-execution-validation.js'

export { DEFAULT_MAX_POSITION_SIZE } from './defaults.js'
export const DEFAULT_TAKE_PROFIT_MODE = 'ai_recommended'
export const DEFAULT_TEMPERATURE = 0.3
export const DEFAULT_MAX_TOKENS = 2000

// Parse strategy symbols from JSON string: parse, trim, uppercase, deduplicate
export function parsePromptSymbols(symbolsJson) {
  let arr = []
  try { arr = JSON.parse(symbolsJson || '[]') } catch (e) { console.warn('[Config] Failed to parse symbols JSON:', e.message) }
  return [...new Set(arr.map(s => String(s).toUpperCase().trim()).filter(Boolean))]
}

// Resolve user's effective symbols: selected ∩ strategy (Fix 3)
// NULL = old user, fallback to strategy all; [] = explicitly empty; damaged JSON = empty
export function resolveEffectiveSymbols(selectedSymbolsJson, strategySymbolsJson) {
  let strategySymbols = []
  try { strategySymbols = JSON.parse(strategySymbolsJson || '[]') } catch (e) { console.warn('[Config] Failed to parse strategy symbols:', e.message) }
  strategySymbols = [...new Set(strategySymbols.map(s => String(s).toUpperCase().trim()).filter(Boolean))]
  if (selectedSymbolsJson == null) return strategySymbols // NULL = fallback all
  let userSymbols
  try { userSymbols = JSON.parse(selectedSymbolsJson) } catch (e) {
    console.warn('[Config] Damaged selected_symbols_json, failing closed to empty')
    return []
  }
  if (!Array.isArray(userSymbols)) return []
  userSymbols = [...new Set(userSymbols.map(s => String(s).toUpperCase().trim()).filter(Boolean))]
  if (userSymbols.length === 0) return [] // explicit empty = no symbols
  return userSymbols.filter(s => strategySymbols.includes(s))
}

export class RiskReject extends Error {
  constructor(reason, details = {}) {
    super(reason)
    this.reason = reason
    this.details = details
    this.classification = 'risk_rejection'
  }
}

export function buildBridgeOrderCall(request) {
  const entryMethod = request.entry_method || 'market'
  if (entryMethod === 'market' || entryMethod === 'observe') {
    const {
      tp_tier_requested: _tpTierRequested,
      tp_tier_used: _tpTierUsed,
      tp_tier_recommended: _tpTierRecommended,
      tp_selection_mode: _tpSelectionMode,
      tp_selection_source: _tpSelectionSource,
      take_profit_candidates: _takeProfitCandidates,
      normalization_info: _normalizationInfo,
      execution_validation: _executionValidation,
      mt5_timezone_offset_minutes: _mt5TimezoneOffsetMinutes,
      mt5_clock_status: _mt5ClockStatus,
      ...bridgeParams
    } = request
    return { bridgeAction: 'open', bridgeParams }
  }
  const orderType = request.order_type || 'buy'
  const pendingTypeMap = {
    'limit':      orderType === 'buy' ? 'buy_limit'      : 'sell_limit',
    'stop':       orderType === 'buy' ? 'buy_stop'       : 'sell_stop',
    'stop_limit': orderType === 'buy' ? 'buy_stop_limit' : 'sell_stop_limit',
  }
  const pendingType = pendingTypeMap[entryMethod] || entryMethod
  const rawOffsetMinutes = Number(request.mt5_timezone_offset_minutes)
  const clockStatus = String(request.mt5_clock_status || '').trim().toLowerCase()
  if (!Number.isInteger(rawOffsetMinutes) || rawOffsetMinutes < -720 || rawOffsetMinutes > 840
    || !clockStatus
    || ['unknown', 'unavailable', 'unverified', 'calibrating', 'fallback'].includes(clockStatus)) {
    throw new Error('mt5_clock_unverified')
  }
  const timezoneOffsetMinutes = rawOffsetMinutes
  let expiration = 0
  if (request.pending_valid_until) {
    const expDate = new Date(request.pending_valid_until.replace(' ', 'T') + 'Z')
    if (!isNaN(expDate.getTime())) expiration = Math.floor(expDate.getTime() / 1000) + timezoneOffsetMinutes * 60
  }
  if (!expiration) {
    const validMinutes = Number(request.pending_valid_minutes) || 240
    expiration = Math.floor(Date.now() / 1000) + timezoneOffsetMinutes * 60 + validMinutes * 60
  }
  return {
    bridgeAction: 'pending',
    bridgeParams: {
      symbol: request.symbol,
      order_type: pendingType,
      price: request.limit_price,
      stoplimit_price: entryMethod === 'stop_limit' ? (request.stop_limit_price || request.limit_price) : undefined,
      volume: request.volume,
      sl: request.sl,
      tp: request.tp,
      deviation: request.deviation,
      magic: request.magic,
      expiration,
    },
  }
}

async function resolveAuditAccountClock(userId, requestedAccountId = null) {
  const numericUserId = Number(userId)
  if (!Number.isInteger(numericUserId) || numericUserId <= 0) return { tradingAccountId:null, clock:null }
  let tradingAccountId = Number(requestedAccountId)
  if (!Number.isInteger(tradingAccountId) || tradingAccountId <= 0) {
    const accounts = (await queryAll(`SELECT id FROM trading_accounts
      WHERE user_id = ? AND is_deleted = 0 ORDER BY updated_at DESC, id DESC LIMIT 2`, [numericUserId])) || []
    if (accounts.length !== 1) return { tradingAccountId:null, clock:null }
    tradingAccountId = Number(accounts[0].id)
  }
  const accountClock = await queryOne(`SELECT accounts.id AS trading_account_id,
      accounts.broker_server, accounts.login_account,
      sources.timezone_offset_minutes, sources.clock_status,
      UNIX_TIMESTAMP(sources.last_calibrated_at) * 1000 AS last_calibrated_at_utc_msc
    FROM trading_accounts accounts
    LEFT JOIN market_data_sources sources ON sources.bridge_user_id = accounts.user_id
      AND UPPER(COALESCE(sources.broker_server, '')) = UPPER(accounts.broker_server)
      AND CAST(COALESCE(sources.account_login, 0) AS CHAR) = CAST(accounts.login_account AS CHAR)
    WHERE accounts.id = ? AND accounts.user_id = ? AND accounts.is_deleted = 0
    ORDER BY sources.last_calibrated_at DESC, sources.id DESC LIMIT 1`, [tradingAccountId, numericUserId])
  if (!accountClock) return { tradingAccountId:null, clock:null }
  let clock = accountClock
  if (!trustedTerminalClock(clock)) {
    const observerClock = await getDefaultObserverSourceClock().catch(() => null)
    clock = applyDefaultObserverClockBootstrap(accountClock, observerClock)
  }
  return { tradingAccountId, clock:trustedTerminalClock(clock) ? clock : null }
}

export async function resolveAuditClockSnapshot(userId, request = {}, result = {}, createdAtUtcMsc = Date.now()) {
  const payloadAccountId = auditTradingAccountId(request, result)
  const account = await resolveAuditAccountClock(userId, payloadAccountId)
  return buildAuditClockSnapshot({
    request, result, accountClock:account.clock,
    tradingAccountId:payloadAccountId || account.tradingAccountId,
    createdAtUtcMsc,
  })
}

export async function insertAudit(db, userId, action, symbol, request, result, status) {
  if (shouldSkipHoldAudit(request, result, status)) return false
  const record = prepareAuditRecord(action, request, result, status)
  const createdAtUtcMsc = Date.now()
  const clock = await resolveAuditClockSnapshot(userId, request, result, createdAtUtcMsc)
  await queryRun(`
    INSERT INTO trade_audit_logs(user_id, action, symbol, request_json, result_json, status,
      trading_account_id, created_at_utc_msc, terminal_timezone_offset_minutes,
      terminal_clock_status, terminal_clock_source, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [userId, record.action, symbol || null, JSON.stringify(record.request), JSON.stringify(record.result), record.status,
    clock.trading_account_id, clock.created_at_utc_msc, clock.terminal_timezone_offset_minutes,
    clock.terminal_clock_status, clock.terminal_clock_source, beijingNow()])
  return true
}

export async function getAnalyzeApiKey(userId, sessionId, strategyId = null) {
  if (!isEncryptionAvailable()) throw new Error('encryption_master_key_missing')
  const resolved = await resolveAiTaskModel({ userId, strategyId, usage: 'manual', modelPurpose:'manual_analysis' })
  if (!resolved.model?.api_key_encrypted) throw new Error(resolved.error || 'no_model_configured')
  const [userConfig, aiVolumeRange] = await Promise.all([
    getInferencePreference(userId, sessionId),
    resolvePlatformAiVolumeRange(),
  ])

  return {
    ...resolved.model,
    system_prompt: userConfig.system_prompt,
    enable_auto_trade: userConfig.enable_auto_trade,
    max_position_size: userConfig.max_position_size,
    _userId: userId,
    _usage: 'manual',
    _strategyId: strategyId,
    _model_shared: resolved.credential_source === 'platform_shared',
    _model_profile_id: resolved.model_profile_id,
    _credential_source: resolved.credential_source,
    _model_purpose: resolved.model_purpose || resolved.purpose || 'manual_analysis',
    _model_resolution_source: resolved.resolution_source || null,
    _model_resolution_reason: resolved.resolution_reason || resolved.reason || null,
    _ai_volume_min: aiVolumeRange.min,
    _ai_volume_max: aiVolumeRange.max,
    _ai_volume_step: aiVolumeRange.step,
  }
}

export function enrichOrderRequest({ request:prepared, quote } = {}) {
  if (!prepared || !quote) return
  const hasOffset = quote.timezone_offset_minutes !== null
    && quote.timezone_offset_minutes !== undefined && quote.timezone_offset_minutes !== ''
  const offset = Number(quote.timezone_offset_minutes)
  const clockStatus = String(quote.clock_status || '').trim().toLowerCase()
  if (hasOffset && Number.isInteger(offset) && offset >= -720 && offset <= 840 && clockStatus
    && !['unknown', 'unavailable', 'unverified', 'calibrating', 'fallback'].includes(clockStatus)) {
    prepared.mt5_timezone_offset_minutes = Math.trunc(offset)
    prepared.mt5_clock_status = clockStatus
  }
  if (!prepared.symbol) return
  prepared.quote_price = parseFloat(prepared.order_type === 'buy' ? quote.ask : quote.bid)
  const pointSize = quote.point || (prepared.quote_price > 1000 ? 0.01 : 0.0001)
  const explicitDigits = Number(quote.digits)
  const pointText = Number(pointSize).toString().toLowerCase()
  const [pointCoefficient, pointExponentText] = pointText.split('e')
  const pointFractionDigits = (pointCoefficient.split('.')[1] || '').length
  const pointExponent = pointExponentText == null ? 0 : Number(pointExponentText)
  const hasExplicitDigits = quote.digits !== null && quote.digits !== undefined && quote.digits !== ''
  const quoteDigits = hasExplicitDigits && Number.isInteger(explicitDigits) && explicitDigits >= 0 && explicitDigits <= 16
    ? explicitDigits
    : Math.min(16, Math.max(0, pointFractionDigits - pointExponent))
  const normalizePrice = value => {
    const factor = 10 ** quoteDigits
    return Math.round((Number(value) + Number.EPSILON) * factor) / factor
  }
  if (prepared.stop_loss_points && !prepared.sl) {
    prepared.sl = prepared.order_type === 'buy'
      ? normalizePrice(prepared.quote_price - prepared.stop_loss_points * pointSize)
      : normalizePrice(prepared.quote_price + prepared.stop_loss_points * pointSize)
  }
  if (prepared.take_profit_points && !prepared.tp) {
    prepared.tp = prepared.order_type === 'buy'
      ? normalizePrice(prepared.quote_price + prepared.take_profit_points * pointSize)
      : normalizePrice(prepared.quote_price - prepared.take_profit_points * pointSize)
  }
}

export function projectPendingRiskSnapshot(pending, replacePendingTickets, sourceType) {
  const rows = Array.isArray(pending) ? pending : []
  if (sourceType !== 'auto_delivery') return rows
  const replacementTickets = new Set((Array.isArray(replacePendingTickets) ? replacePendingTickets : [])
    .map(ticket => String(ticket || '').trim()).filter(Boolean))
  if (!replacementTickets.size) return rows
  return rows.filter(item =>
    !replacementTickets.has(String(item?.ticket ?? item?.mt5_ticket ?? '').trim()))
}

export async function getAutoConfig(db, userId) {
  const row = await queryOne('SELECT * FROM auto_scheduler WHERE user_id = ?', [userId])
  if (!row) {
    const firstPt = await queryOne('SELECT id FROM auto_prompt_types WHERE is_active = 1 AND deleted_at IS NULL ORDER BY sort_order ASC, id ASC LIMIT 1')
    return {
      user_id: userId,
      enabled: 0,
      prompt_type_id: firstPt?.id || null,
      max_position_size: DEFAULT_MAX_POSITION_SIZE,
      enable_auto_trade: 1,
      selected_symbols: [],
    }
  }
  delete row.risk_level
  delete row.selected_take_profit
  row.selected_symbols = []
  if (!row.prompt_type_id) {
    const firstPt = await queryOne('SELECT id FROM auto_prompt_types WHERE is_active = 1 AND deleted_at IS NULL ORDER BY sort_order ASC, id ASC LIMIT 1')
    if (firstPt) row.prompt_type_id = firstPt.id
  }
  // Populate selected_symbols using resolveEffectiveSymbols (Fix 3)
  if (row.prompt_type_id) {
    const pt = await queryOne('SELECT symbols_json FROM auto_prompt_types WHERE id = ?', [row.prompt_type_id])
    row.selected_symbols = resolveEffectiveSymbols(row.selected_symbols_json, pt?.symbols_json || '[]')
  }
  return row
}

export async function getGlobalAutoConfig() {
  return await queryOne('SELECT * FROM global_auto_config WHERE id = 1')
}

export async function getExecuteRiskConfig(userId, signal) {
  const isAuto = (signal.config_id === 0 && signal.source !== 'auto_shared')
  if (isAuto || signal.source === 'auto_shared') {
    const riskConfig = await getDeliveryExecuteRiskConfig(userId)
    if (!riskConfig) return null
    const subscription = signal.prompt_type_id
      ? await getDeliverySubscriptionRuntime(userId, signal.prompt_type_id, signal.symbol)
      : null
    return { ...riskConfig, take_profit_mode: subscription?.take_profit_mode || DEFAULT_TAKE_PROFIT_MODE }
  }

  const sessionId = signal.session_id || 'default'
  const manualCfg = await getInferencePreference(userId, sessionId)
  return {
    enable_auto_trade: manualCfg.enable_auto_trade,
    take_profit_mode: DEFAULT_TAKE_PROFIT_MODE,
    max_position_size: manualCfg.max_position_size ?? DEFAULT_MAX_POSITION_SIZE,
  }
}

export async function getAutoPromptTypes({ includeInactive = false } = {}) {
  const where = includeInactive ? 'deleted_at IS NULL' : 'is_active = 1 AND deleted_at IS NULL'
  return await queryAll(`SELECT * FROM auto_prompt_types WHERE ${where} ORDER BY sort_order ASC, id ASC`)
}

export async function getAutoPromptTypeById(promptTypeId) {
  return await queryOne('SELECT * FROM auto_prompt_types WHERE id = ? AND deleted_at IS NULL', [promptTypeId])
}

export async function getUnifiedAutoInferenceConfig(promptTypeId, requestedUserId = null) {
  if (!isEncryptionAvailable()) throw new Error('encryption_master_key_missing')
  const pt = await getAutoPromptTypeById(promptTypeId)
  if (!pt) return null
  const isPrivate = pt.scope === 'private'
  const ownerUserId = Number(pt.owner_user_id || 0)
  if (isPrivate && Number(requestedUserId) !== ownerUserId) throw new Error('private_strategy_access_denied')
  const usage = isPrivate ? 'auto_private' : 'auto_platform'
  const resolved = await resolveAiTaskModel({ userId: isPrivate ? ownerUserId : 0, strategyId: promptTypeId, usage,
    modelPurpose:'auto_inference' })
  if (!resolved.model?.api_key_encrypted) throw new Error(resolved.error || (isPrivate ? 'no_model_configured' : 'no_platform_model'))
  const [globalCfg, aiVolumeRange] = await Promise.all([
    getGlobalAutoConfig(),
    resolvePlatformAiVolumeRange(),
  ])
  const policy = parseStrategyPolicy(pt)
  return {
    ...resolved.model,
    system_prompt: pt.system_prompt || '',
    max_position_size: globalCfg?.max_position_size ?? DEFAULT_MAX_POSITION_SIZE,
    enable_auto_trade: !!globalCfg?.enable_auto_trade,
    thinking_enabled: resolved.model.thinking_enabled !== 0,
    reasoning_effort: resolved.model.reasoning_effort || 'max',
    _userId: isPrivate ? ownerUserId : 0,
    _usage: usage,
    _strategyId: promptTypeId,
    _source: 'unified',
    _model_profile_id: resolved.model_profile_id,
    _credential_source: resolved.credential_source,
    _model_purpose: resolved.model_purpose || resolved.purpose || 'auto_inference',
    _model_resolution_source: resolved.resolution_source || null,
    _model_resolution_reason: resolved.resolution_reason || resolved.reason || null,
    _market_only: !isPrivate,
    _include_portfolio_context: isPrivate && Boolean(Number(pt.include_portfolio_context)),
    _strategy_scope: pt.scope || 'platform',
    _strategy_owner_user_id: ownerUserId,
    _strategy_version: Number(pt.version || 1),
    _market_data_plan: policy.marketDataPlan,
    _allowed_entry_methods: policy.entryMethods,
    _use_chan_analysis: policy.useChanAnalysis,
    _strategy_policy:policy,
    _ai_volume_min: aiVolumeRange.min,
    _ai_volume_max: aiVolumeRange.max,
    _ai_volume_step: aiVolumeRange.step || DEFAULT_AI_VOLUME_STEP,
    prompt_type_id: promptTypeId,
  }
}

// === Auto Subscribers ===

export async function getAutoSubscribers(promptTypeId, symbol, bridgeAliveCheck = null) {
  const sym = String(symbol).toUpperCase().trim()
  const symBase = stripBrokerSuffix(sym)
  // Read user's selected_symbols_json (Fix 4): NULL means use strategy all symbols
  const rows = await queryAll(
    `SELECT s.user_id, s.selected_symbols_json, apt.symbols_json as strategy_symbols_json,
            apt.scope AS strategy_scope, apt.owner_user_id AS strategy_owner_user_id,
            s.max_position_size, s.enable_auto_trade,
            ss.id AS subscription_id, ss.trading_account_id, ss.schedule_enabled, ss.schedule_timezone,
            ss.schedule_weekdays_json, ss.schedule_windows_json, ss.outside_window_behavior,
            ta.broker_server AS runtime_broker_server,
            mds.timezone_offset_minutes AS runtime_timezone_offset_minutes,
            mds.clock_status AS runtime_clock_status,
            u.plan, u.role
     FROM auto_scheduler s
     JOIN auto_prompt_types apt ON apt.id = s.prompt_type_id
     JOIN strategy_subscriptions ss ON ss.user_id = s.user_id AND ss.strategy_id = s.prompt_type_id
       AND ss.execution_enabled = 1 AND ss.is_deleted = 0
     JOIN trading_accounts ta ON ta.id = ss.trading_account_id AND ta.user_id = ss.user_id
       AND ta.is_deleted = 0
     LEFT JOIN market_data_sources mds ON mds.bridge_user_id = ss.user_id
       AND UPPER(COALESCE(mds.broker_server, '')) = UPPER(ta.broker_server)
       AND CAST(COALESCE(mds.account_login, 0) AS CHAR) = CAST(ta.login_account AS CHAR)
     JOIN users u ON u.id = s.user_id
     WHERE s.prompt_type_id = ? AND s.enabled = 1
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
       AND (u.role = 'admin' OR (u.plan = 'pro' AND (u.plan_expires_at IS NULL OR u.plan_expires_at >= NOW())))`,
    [promptTypeId]
  )
  const needsObserverClock = rows.some(row => !trustedTerminalClock({
    timezone_offset_minutes:row.runtime_timezone_offset_minutes,
    clock_status:row.runtime_clock_status,
  }))
  const observerClock = needsObserverClock
    ? await getDefaultObserverSourceClock().catch(() => null) : null
  const clockRows = rows.map(row => {
    const clock = applyDefaultObserverClockBootstrap({
      broker_server:row.runtime_broker_server,
      timezone_offset_minutes:row.runtime_timezone_offset_minutes,
      clock_status:row.runtime_clock_status,
    }, observerClock)
    return { ...row, runtime_timezone_offset_minutes:clock.timezone_offset_minutes ?? null,
      runtime_clock_status:clock.clock_status || 'unknown' }
  })
  const filtered = clockRows.filter(r => {
    if (r.strategy_scope === 'private' && Number(r.strategy_owner_user_id) !== Number(r.user_id)) return false
    if (!subscriptionAllowsInference(r)) return false
    const effectiveSymbols = resolveEffectiveSymbols(r.selected_symbols_json, r.strategy_symbols_json)
    if (effectiveSymbols.length === 0) return false
    return effectiveSymbols.some(s => {
      const sNorm = String(s).toUpperCase().trim()
      return sNorm === sym || stripBrokerSuffix(sNorm) === symBase
    })
  })
  // Filter by bridge alive if check function provided
  if (typeof bridgeAliveCheck === 'function') {
    return filtered.filter(r => bridgeAliveCheck(r.user_id))
  }
  return filtered
}

export async function getDeliverySubscriptionRuntime(userId, promptTypeId, symbol) {
  const rows = await queryAll(
    `SELECT ss.*, apt.symbols_json AS strategy_symbols_json,
       ta.broker_server AS runtime_broker_server,
       mds.timezone_offset_minutes AS runtime_timezone_offset_minutes,
       mds.clock_status AS runtime_clock_status
     FROM strategy_subscriptions ss
     JOIN auto_prompt_types apt ON apt.id = ss.strategy_id AND apt.deleted_at IS NULL
     JOIN trading_accounts ta ON ta.id = ss.trading_account_id AND ta.user_id = ss.user_id
       AND ta.is_deleted = 0
     LEFT JOIN market_data_sources mds ON mds.bridge_user_id = ss.user_id
       AND UPPER(COALESCE(mds.broker_server, '')) = UPPER(ta.broker_server)
       AND CAST(COALESCE(mds.account_login, 0) AS CHAR) = CAST(ta.login_account AS CHAR)
     WHERE ss.user_id = ? AND ss.strategy_id = ?
       AND ss.execution_enabled = 1 AND ss.is_deleted = 0
     ORDER BY ss.updated_at DESC, ss.id DESC`,
    [userId, promptTypeId]
  )
  const needsObserverClock = rows.some(row => !trustedTerminalClock({
    timezone_offset_minutes:row.runtime_timezone_offset_minutes,
    clock_status:row.runtime_clock_status,
  }))
  const observerClock = needsObserverClock
    ? await getDefaultObserverSourceClock().catch(() => null) : null
  const clockRows = rows.map(row => {
    const clock = applyDefaultObserverClockBootstrap({
      broker_server:row.runtime_broker_server,
      timezone_offset_minutes:row.runtime_timezone_offset_minutes,
      clock_status:row.runtime_clock_status,
    }, observerClock)
    return { ...row, runtime_timezone_offset_minutes:clock.timezone_offset_minutes ?? null,
      runtime_clock_status:clock.clock_status || 'unknown' }
  })
  const wanted = stripBrokerSuffix(String(symbol || '').toUpperCase())
  const subscription = clockRows.find(row => resolveEffectiveSymbols(row.symbols_json, row.strategy_symbols_json)
    .some(item => stripBrokerSuffix(String(item).toUpperCase()) === wanted))
  if (!subscription) return null
  return { ...subscription, in_schedule: subscriptionAllowsExecution(subscription) }
}

// === Delivery Execute Risk Config ===

export async function getDeliveryExecuteRiskConfig(userId) {
  const scheduler = await queryOne('SELECT enable_auto_trade FROM auto_scheduler WHERE user_id = ?', [userId])
  if (scheduler) {
    return {
      enable_auto_trade: !!scheduler.enable_auto_trade,
    }
  }
  const globalCfg = await getGlobalAutoConfig()
  if (!globalCfg) return null
  return {
    enable_auto_trade: !!globalCfg.enable_auto_trade,
  }
}

const TAKE_PROFIT_MODE_TIERS = Object.freeze({ conservative: 1, standard: 2, trend: 3 })

export function normalizeTakeProfitMode(value) {
  const mode = String(value || DEFAULT_TAKE_PROFIT_MODE).trim().toLowerCase()
  return mode === DEFAULT_TAKE_PROFIT_MODE || Object.hasOwn(TAKE_PROFIT_MODE_TIERS, mode)
    ? mode
    : DEFAULT_TAKE_PROFIT_MODE
}

export function signalOrderPayload(signal, config, market, confirm) {
  const takeProfitMode = normalizeTakeProfitMode(config?.take_profit_mode)
  const createdAtUtcMsc = Number(signal.created_at_utc_msc)
  const signalCreatedAt = Number.isFinite(createdAtUtcMsc) && createdAtUtcMsc > 0
    ? Math.trunc(createdAtUtcMsc)
    : signal.created_at || null
  const recommendedTierValue = Number(signal.recommended_take_profit_tier)
  const recommendedTier = [1, 2, 3].includes(recommendedTierValue) ? recommendedTierValue : null
  const requestedTier = takeProfitMode === DEFAULT_TAKE_PROFIT_MODE
    ? (recommendedTier || 1)
    : TAKE_PROFIT_MODE_TIERS[takeProfitMode]
  const requestedPrice = Number(signal[`take_profit_${requestedTier}_price`])
  const usedTier = Number.isFinite(requestedPrice) && requestedPrice > 0 ? requestedTier : null
  const selectionSource = takeProfitMode === DEFAULT_TAKE_PROFIT_MODE
    ? (recommendedTier ? 'ai_recommended' : 'legacy_tp1_fallback')
    : 'subscription_preference'

  // Extract base order_type from signal_type (buy_limit → buy, sell_stop → sell)
  const st = String(signal.signal_type || '').toLowerCase()
  const baseOrderType = st.startsWith('buy') ? 'buy' : st.startsWith('sell') ? 'sell' : st
  const entryMethod = signal.entry_method || (st.includes('stop_limit') ? 'stop_limit' : st.includes('limit') ? 'limit' : st.includes('stop') ? 'stop' : 'market')
  const positionSizeTier = normalizePositionSizeTier(signal.position_size_tier, st)
  // Absolute model volume is a historical read-only fallback. Current signals
  // carry a risk tier and the versioned risk gate derives their real volume.
  const legacyVolume = positionSizeTier ? 0 : Number(signal.recommended_volume)

  const payload = {
    symbol: signal.symbol,
    order_type: baseOrderType,
    // A tier is intentionally represented by the internal zero sentinel. It
    // is not an absolute lot size and must stay that way until the versioned
    // risk gate applies account equity, the tier factor and broker steps.
    volume: legacyVolume,
    position_size_tier: positionSizeTier || null,
    position_size_factor: positionSizeTier ? positionSizeFactor(positionSizeTier) : 1,
    position_size_reason: signal.position_size_reason || '',
    sl: signal.stop_loss_price,
    tp: usedTier ? requestedPrice : null,
    tp_selection_mode: takeProfitMode,
    tp_selection_source: selectionSource,
    tp_tier_recommended: recommendedTier,
    tp_tier_requested: requestedTier,
    tp_tier_used: usedTier,
    take_profit_candidates: [1, 2, 3].map(tier => ({
      tier,
      price: Number(signal[`take_profit_${tier}_price`]),
    })).filter(item => Number.isFinite(item.price) && item.price > 0),
    confirm: confirm,
    source: 'ai',
    signal_type: signal.signal_type,
    signal_id: signal.id,
    normalization_info: signal.normalization_info || null,
    reference_price: market.latest_price,
    atr_anchor: market.atr_anchor,
    signal_created_at: signalCreatedAt,
    entry_method: entryMethod,
  }
  const executionValidation = readExecutionValidation(signal)
  if (executionValidation.explicit) payload.execution_validation = executionValidation.validation

  // Pending order fields
  if (entryMethod !== 'market' && entryMethod !== 'observe') {
    payload.limit_price = signal.limit_price
    payload.pending_valid_until = signal.pending_valid_until
    if (entryMethod === 'stop_limit' && signal.stop_limit_price) {
      payload.stop_limit_price = signal.stop_limit_price
    }
  }

  return payload
}

export async function getCloseConfig(userId) {
  return await queryOne('SELECT * FROM close_config WHERE user_id = ?', [userId])
}

export async function saveCloseConfig(userId, cfg) {
  // Smart-close is retired. Keep the read path and table for historical compatibility,
  // but never accept a legacy payload or write its obsolete output cap.
  throw new Error('smart_close_feature_retired')
}

export async function getCloseSignalTickets(userId) {
  const rows = await queryAll('SELECT cst.original_ticket, cst.close_signal_id, cst.close_price, s.take_profit_1_price FROM close_signal_tickets cst LEFT JOIN ai_signals s ON cst.close_signal_id = s.id WHERE cst.user_id = ?', [userId])
  const map = {}
  for (const r of rows) {
    map[String(r.original_ticket)] = { signalId: r.close_signal_id, price: r.close_price, takeProfit: r.take_profit_1_price }
  }
  return map
}

export function isAiPendingOrderRequest(request = {}, sourceType = 'manual') {
  if (sourceType === 'manual') return false
  const entryMethod = String(request.entry_method || '').toLowerCase()
  return entryMethod !== '' && !['market', 'observe'].includes(entryMethod)
}

export async function assertAiPendingOrderEnabled() {
  const control = await queryOne(`SELECT ai_pending_order_enabled
    FROM global_position_management_control WHERE id = 1`)
  if (Number(control?.ai_pending_order_enabled ?? 0) !== 1) {
    throw new RiskReject('ai_pending_order_disabled')
  }
}

export async function assertAiPendingCancelEnabled() {
  const control = await queryOne(`SELECT ai_pending_cancel_enabled
    FROM global_position_management_control WHERE id = 1`)
  if (Number(control?.ai_pending_cancel_enabled ?? 0) !== 1) {
    throw new RiskReject('ai_pending_cancel_disabled')
  }
}

export async function executeOrderCore(userId, config, request, action, options = {}) {
  options = { ...options, noFallback: true }
  const signalId = request.signal_id ?? options.signalId ?? null
  const sourceType = options.sourceType || (options.deliveryId ? 'auto_delivery' : signalId ? 'signal' : 'manual')
  if (sourceType !== 'manual' || signalId != null) {
    let validationStates = []
    try {
      if (request && Object.prototype.hasOwnProperty.call(request, 'execution_validation')) {
        validationStates.push(readExecutionValidation(request))
      }
      if (signalId != null) {
        const row = await queryOne('SELECT decision_json FROM ai_signals WHERE id = ?', [signalId])
        validationStates.push(readExecutionValidation(row || {}, { legacyAllowed:true }))
      }
      if (validationStates.length === 0) validationStates.push(readExecutionValidation({}, { legacyAllowed:true }))
    } catch (error) {
      validationStates = [readExecutionValidation({ execution_validation:null })]
      console.error(`[Execute] execution validation lookup failed for signal ${signalId || 'unknown'}:`, error.message)
    }
    const validationState = validationStates.find(state => state.validation.eligible !== true)
      || validationStates[0]
    if (validationStates.some(state => state.validation.eligible !== true)) {
      const result = executionValidationRejection(validationState)
      await insertAudit(null, userId, action, request?.symbol, request, result, 'rejected')
      return result
    }
  }
  if (isAiPendingOrderRequest(request, sourceType)) {
    try {
      await assertAiPendingOrderEnabled()
    } catch (error) {
      const result = buildSafeExecutionOutcome({
        status:'rejected', classification:'risk_rejection',
        reason:error?.reason || error?.message || 'ai_pending_order_disabled',
        details:error?.details || {}, stage:'before_bridge_send', field:'execution',
      })
      await insertAudit(null, userId, action, request.symbol, request, result, 'rejected')
      return result
    }
  }
  const ruleModes = await getRiskRuleRolloutModes()
  const result = await prepareAndExecuteOrderIntent({
    userId,
    tradingAccountId: options.tradingAccountId ?? request.trading_account_id ?? null,
    signalId,
    clientRequestId: options.clientRequestId ?? request.client_request_id ?? request.request_id ?? null,
    sourceType,
    sourceId: options.deliveryId ?? signalId,
    action,
    request,
    config,
    options,
    validateRequest: async (legacyConfig, account, prepared, context) => {
      if (prepared.confirm !== true) throw new RiskReject('confirmation_required')
      // loadRiskContext resolves this once before the Bridge snapshot. Reuse
      // that exact policy/version for deterministic validation and persistence;
      // a fallback is retained for alternate callers that provide no context.
      const resolved = context.resolved_risk_policy
        ? { policy: context.resolved_risk_policy, policyVersionIds: context.risk_policy_version_ids || [] }
        : await resolveEffectiveRiskPolicy({
          userId,
          tradingAccountId: context.tradingAccountId ?? options.tradingAccountId ?? prepared.trading_account_id ?? null,
          riskProfileId: options.riskProfileId ?? prepared.risk_profile_id ?? null,
          legacyConfig,
        })
      const decision = evaluateCoreRisk({ request: prepared, account, quote: context.quote, instrument: context.instrument,
        brokerCalculation: context.broker_calculation, policy: resolved.policy, ruleModes })
      const decisionId = await persistRiskDecision(context.intentId, decision, resolved.policyVersionIds)
      if (decision.decision_status === 'reject') throw new RiskReject(decision.reject_code, { risk_decision_id: decisionId, rules: decision.rule_results })
      return {
        approved_order: decision.approved_order,
        original_order: decision.original_order,
        rule_results: decision.rule_results,
        risk_amount: decision.risk_amount,
        risk_decision_id: decisionId,
        policy_version_ids: resolved.policyVersionIds,
        policy: resolved.policy,
      }
    },
    buildBridgeCall: buildBridgeOrderCall,
    beforeBridgeSend: async ({ bridgeAction, request:approved }) => {
      if (sourceType !== 'manual' && bridgeAction === 'pending') await assertAiPendingOrderEnabled()
      if (typeof options.beforeBridgeSend === 'function') {
        await options.beforeBridgeSend({ bridgeAction, request:approved })
      }
    },
    beforeBridgeSendTx: options.beforeBridgeSendTx,
    afterRiskPrepared: options.afterRiskPrepared,
    resolveTradingAccount: ({ actorId, account, requestedAccountId }) => syncTradingAccountIdentity(actorId, account, requestedAccountId),
    statefulValidate: ({ run, tradingAccountId, intentId, request: approved, risk, riskContext }) => evaluateStatefulRiskTx(run, {
      userId,
      accountId: tradingAccountId,
      intentId,
      request: approved,
      policy: risk.policy,
      snapshot: riskContext,
      ruleModes,
    }),
    loadRiskContext: async ({ bridge, actorId, tradingAccountId, request: prepared, account, quote, bridgeOptions }) => {
      let resolved
      try {
        resolved = await resolveEffectiveRiskPolicy({
          userId: actorId,
          tradingAccountId,
          riskProfileId: options.riskProfileId ?? prepared.risk_profile_id ?? null,
          legacyConfig: config,
        })
      } catch (error) {
        error.stage = error.stage || 'risk_policy'
        error.field = error.field || 'policy'
        throw error
      }
      const riskCalculationVolume = Number(resolved?.policy?.max_position_size)
      if (!Number.isFinite(riskCalculationVolume) || riskCalculationVolume <= 0) {
        throw Object.assign(new Error('risk_calculation_volume_invalid'), {
          reason:'risk_calculation_volume_invalid', stage:'risk_policy', field:'risk_calculation_volume',
          details:{ risk_calculation_volume: riskCalculationVolume },
        })
      }
      if (!(Number(prepared.atr_anchor) > 0)) {
        const ratesResult = await bridge(actorId, 'rates', { symbol: prepared.symbol, timeframe: 'H1', count: 30 }, bridgeOptions)
        const atr = computeAtr14(ratesResult?.rates || [])
        if (atr > 0) prepared.atr_anchor = atr
      }
      const stateCursor = await queryOne(`SELECT ras.last_deal_time_msc, ras.last_deal_ticket,
          COALESCE(ras.last_risk_snapshot_at, ras.updated_at, ta.first_verified_at) AS incremental_baseline_at
        FROM trading_accounts ta LEFT JOIN risk_account_state ras ON ras.trading_account_id = ta.id
        WHERE ta.id = ? AND ta.user_id = ? AND ta.is_deleted = 0 LIMIT 1`, [tradingAccountId, actorId])
      if (!stateCursor) throw Object.assign(new Error('trading_account_not_found'), {
        reason:'trading_account_not_found', stage:'risk_context', field:'account',
      })
      const entryPrice = Number(prepared.limit_price || prepared.quote_price || prepared.reference_price || 0)
      const snapshotOptions = { ...(bridgeOptions || {}), timeoutMs: Math.max(10_000, Number(bridgeOptions?.timeoutMs) || 0), noFallback: true }
      const riskSnapshot = await bridge(actorId, 'risk_snapshot', {
        symbol: prepared.symbol,
        last_deal_time_msc: Number(stateCursor.last_deal_time_msc || 0),
        last_deal_ticket: Number(stateCursor.last_deal_ticket || 0),
        baseline_from_utc_msc: Number(stateCursor.last_deal_time_msc || 0) ? 0 : (parseBeijing(stateCursor.incremental_baseline_at)?.getTime() || Date.now()),
        proposed_order: {
          symbol: prepared.symbol, order_type: prepared.order_type,
          // A tiered signal keeps prepared.volume at its zero sentinel. The
          // snapshot only needs a positive provisional volume so MT5 can
          // calculate loss-per-lot; evaluateCoreRisk derives final volume.
          volume: riskCalculationVolume,
          entry_price: entryPrice, sl: Number(prepared.sl || 0),
        },
      }, snapshotOptions)
      if (!riskSnapshot || riskSnapshot.status !== 'success') {
        const message = String(riskSnapshot?.message || riskSnapshot?.error || '')
        const reason = message.includes('Unknown action: risk_snapshot')
          ? 'bridge_upgrade_required_for_incremental_risk' : 'risk_snapshot_failed'
        throw Object.assign(new Error(reason), {
          reason, stage:'risk_snapshot', field:'proposed_order',
          details:{ risk_calculation_volume: riskCalculationVolume },
        })
      }
      const replacementPendingTickets = sourceType === 'auto_delivery'
        ? new Set((Array.isArray(options.replacePendingTickets) ? options.replacePendingTickets : [])
          .map(ticket => String(ticket || '').trim()).filter(Boolean))
        : new Set()
      const projectedPending = projectPendingRiskSnapshot(
        riskSnapshot.pending, [...replacementPendingTickets], sourceType)
      const instruments = {}
      for (const item of Object.values(riskSnapshot.instruments || {})) {
        if (!item?.name) continue
        instruments[stripBrokerSuffix(item.name)] = item
      }
      const wanted = stripBrokerSuffix(prepared.symbol)
      const instrument = instruments[wanted]
      if (!instrument) throw Object.assign(new Error('symbol_metadata_not_found'), {
        reason:'symbol_metadata_not_found', stage:'instrument', field:'instrument',
      })
      const fxRates = {}
      const accountCurrency = String(account?.currency || '').toUpperCase()
      const quoteCurrencies = new Set([...(riskSnapshot.positions || []), ...(riskSnapshot.pending || []), prepared]
        .map(item => instruments[stripBrokerSuffix(item.symbol)]?.currency_profit || stripBrokerSuffix(item.symbol).slice(3, 6))
        .map(currency => String(currency || '').toUpperCase()).filter(Boolean))
      for (const currency of quoteCurrencies) {
        if (!currency || !accountCurrency || currency === accountCurrency) continue
        for (const pair of [`${currency}${accountCurrency}`, `${accountCurrency}${currency}`]) {
          try {
            const rate = await bridge(actorId, 'quote', { symbol: pair }, bridgeOptions)
            const mid = (Number(rate?.bid) + Number(rate?.ask)) / 2
            if (Number.isFinite(mid) && mid > 0) { fxRates[pair] = mid; break }
          } catch { /* Missing conversion is handled fail-closed by stateful risk. */ }
        }
      }
      return {
        account, quote, instrument, instruments, fxRates,
        resolved_risk_policy: resolved.policy,
        risk_policy_version_ids: resolved.policyVersionIds,
        risk_calculation_volume: riskCalculationVolume,
        positions:riskSnapshot.positions || [], pending:projectedPending,
        replacement_pending_tickets:[...replacementPendingTickets],
        snapshot_complete: riskSnapshot.complete === true,
        data_incomplete_reasons: riskSnapshot.incomplete_reasons || [],
        risk_snapshot_version: Number(riskSnapshot.snapshot_version || 0),
        timezone_offset_minutes:riskSnapshot.timezone_offset_minutes == null
          || riskSnapshot.timezone_offset_minutes === '' ? null : Number(riskSnapshot.timezone_offset_minutes),
        clock_status:riskSnapshot.clock_status || '',
        businessDate: riskSnapshot.business_date,
        increment: riskSnapshot.increment || {},
        broker_calculation: riskSnapshot.broker_calculation || null,
      }
    },
    enrichRequest:enrichOrderRequest,
  })
  await insertAudit(null, userId, action, request.symbol, request, result, result.status)
  return result
}

export function validateManualOrderRequest(request = {}) {
  if (request.confirm !== true) throw new RiskReject('manual_confirmation_required')
  if (!String(request.symbol || '').trim()) throw new RiskReject('symbol_required')
  if (!['buy', 'sell'].includes(String(request.order_type || '').toLowerCase())) {
    throw new RiskReject('order_type_invalid')
  }
  const volume = Number(request.volume)
  if (!Number.isFinite(volume) || volume <= 0) throw new RiskReject('volume_invalid')
  const entryMethod = String(request.entry_method || 'market').toLowerCase()
  if (!['market', 'limit', 'stop', 'stop_limit'].includes(entryMethod)) {
    throw new RiskReject('entry_method_invalid')
  }
  if (entryMethod !== 'market' && !(Number(request.limit_price) > 0)) {
    throw new RiskReject('pending_price_invalid')
  }
  return true
}

// Manual trading is user-directed. Keep confirmation, durable idempotency,
// account ownership and broker-result reconciliation, but do not apply the AI
// strategy/risk policy that may resize or reject an explicitly entered order.
export async function executeManualOrderCore(userId, request, action = 'manual_open', options = {}) {
  const result = await prepareAndExecuteOrderIntent({
    userId,
    tradingAccountId: options.tradingAccountId ?? request.trading_account_id ?? null,
    clientRequestId: options.clientRequestId ?? request.client_request_id ?? request.request_id ?? null,
    sourceType: 'manual',
    action,
    request,
    options: { ...options, noFallback:true },
    validateRequest: async (_config, _account, prepared) => {
      validateManualOrderRequest(prepared)
      return {
        // A direct user order is deliberately not owned by the AI position
        // manager. Magic 0 keeps MT4/MT5 terminal semantics aligned and lets
        // users omit SL/TP without creating a system protection incident.
        approved_order:{ ...prepared, magic:0 },
        original_order:{ ...prepared },
        rule_results:[],
        risk_amount:null,
        policy_version_ids:[],
      }
    },
    buildBridgeCall:buildBridgeOrderCall,
    resolveTradingAccount: ({ actorId, account, requestedAccountId }) =>
      syncTradingAccountIdentity(actorId, account, requestedAccountId),
    enrichRequest:enrichOrderRequest,
  })
  await insertAudit(null, userId, action, request.symbol, request, result, result.status)
  return result
}
