// ai/config.js — 配置管理 + 风控 + 审计

import { queryOne, queryAll, queryRun, withTransaction, beijingNow, parseBeijing } from '../../db.js'
import { round2, round3, stripBrokerSuffix } from './utils.js'
import { DEFAULT_API_BASE_URL } from '../../config.js'
import { mt5Bridge, computeAtr14 } from './market-data.js'
import { prepareAuditRecord, shouldSkipHoldAudit } from '../../audit-localization.js'
import { isEncryptionAvailable } from '../../ai-credential.js'
import { resolveAiTaskModel, upsertDefaultModelProfileFromLegacyInput } from './model-profiles.js'
import { prepareAndExecuteOrderIntent } from './order-intents.js'
import { evaluateCoreRisk, persistRiskDecision, resolveEffectiveRiskPolicy } from './risk-policy.js'
import { evaluateStatefulRiskTx, syncTradingAccountIdentity } from './risk-state.js'
import { getRiskRuleRolloutModes } from './rollout-governance.js'
import { getInferencePreference } from './inference-preferences.js'
import { parseStrategyPolicy } from './strategy-policy.js'
import { subscriptionAllowsExecution, subscriptionAllowsInference } from './subscription-schedule.js'

export const DEFAULT_MAX_POSITION_SIZE = 0.05
export const DEFAULT_SELECTED_TAKE_PROFIT = 2
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
  }
}

export function buildBridgeOrderCall(request) {
  const entryMethod = request.entry_method || 'market'
  if (entryMethod === 'market' || entryMethod === 'observe') {
    const {
      tp_tier_requested: _tpTierRequested,
      tp_tier_used: _tpTierUsed,
      take_profit_candidates: _takeProfitCandidates,
      normalization_info: _normalizationInfo,
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
  let expiration = 0
  if (request.pending_valid_until) {
    const expDate = new Date(request.pending_valid_until.replace(' ', 'T') + 'Z')
    if (!isNaN(expDate.getTime())) expiration = Math.floor(expDate.getTime() / 1000) + 10800
  }
  if (!expiration) {
    const validMinutes = Number(request.pending_valid_minutes) || 240
    expiration = Math.floor(Date.now() / 1000) + 10800 + validMinutes * 60
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
      expiration,
    },
  }
}

export async function insertAudit(db, userId, action, symbol, request, result, status) {
  if (shouldSkipHoldAudit(request, result, status)) return false
  const record = prepareAuditRecord(action, request, result, status)
  await queryRun(`
    INSERT INTO trade_audit_logs(user_id, action, symbol, request_json, result_json, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [userId, record.action, symbol || null, JSON.stringify(record.request), JSON.stringify(record.result), record.status, beijingNow()])
  return true
}

export async function getAnalyzeApiKey(userId, sessionId, strategyId = null) {
  if (!isEncryptionAvailable()) throw new Error('encryption_master_key_missing')
  const resolved = await resolveAiTaskModel({ userId, strategyId, usage: 'manual' })
  if (!resolved.model?.api_key_encrypted) throw new Error(resolved.error || 'no_model_configured')
  const userConfig = await getInferencePreference(userId, sessionId)

  return {
    ...resolved.model,
    system_prompt: userConfig.system_prompt,
    enable_auto_trade: userConfig.enable_auto_trade,
    risk_level: userConfig.risk_level,
    max_position_size: userConfig.max_position_size,
    selected_take_profit: userConfig.selected_take_profit,
    _userId: userId,
    _usage: 'manual',
    _strategyId: strategyId,
    _model_shared: resolved.credential_source === 'platform_shared',
    _model_profile_id: resolved.model_profile_id,
    _credential_source: resolved.credential_source,
  }
}

export async function getAutoConfig(db, userId) {
  const row = await queryOne('SELECT * FROM auto_scheduler WHERE user_id = ?', [userId])
  if (!row) {
    const firstPt = await queryOne('SELECT id FROM auto_prompt_types WHERE is_active = 1 AND deleted_at IS NULL ORDER BY sort_order ASC, id ASC LIMIT 1')
    return {
      user_id: userId,
      enabled: 0,
      prompt_type_id: firstPt?.id || null,
      risk_level: 'medium',
      max_position_size: DEFAULT_MAX_POSITION_SIZE,
      selected_take_profit: DEFAULT_SELECTED_TAKE_PROFIT,
      enable_auto_trade: 1,
      selected_symbols: [],
    }
  }
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
    return getDeliveryExecuteRiskConfig(userId)
  }

  const sessionId = signal.session_id || 'default'
  const manualCfg = await getInferencePreference(userId, sessionId)
  return {
    enable_auto_trade: manualCfg.enable_auto_trade,
    selected_take_profit: manualCfg.selected_take_profit ?? DEFAULT_SELECTED_TAKE_PROFIT,
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
  const resolved = await resolveAiTaskModel({ userId: isPrivate ? ownerUserId : 0, strategyId: promptTypeId, usage })
  if (!resolved.model?.api_key_encrypted) throw new Error(resolved.error || (isPrivate ? 'no_model_configured' : 'no_platform_model'))
  const globalCfg = await getGlobalAutoConfig()
  const policy = parseStrategyPolicy(pt)
  return {
    ...resolved.model,
    system_prompt: pt.system_prompt || '',
    risk_level: globalCfg?.risk_level || 'medium',
    max_position_size: globalCfg?.max_position_size ?? DEFAULT_MAX_POSITION_SIZE,
    selected_take_profit: globalCfg?.selected_take_profit ?? DEFAULT_SELECTED_TAKE_PROFIT,
    enable_auto_trade: !!globalCfg?.enable_auto_trade,
    thinking_enabled: resolved.model.thinking_enabled !== 0,
    reasoning_effort: resolved.model.reasoning_effort || 'max',
    _userId: isPrivate ? ownerUserId : 0,
    _usage: usage,
    _strategyId: promptTypeId,
    _source: 'unified',
    _model_profile_id: resolved.model_profile_id,
    _credential_source: resolved.credential_source,
    _market_only: !isPrivate,
    _strategy_scope: pt.scope || 'platform',
    _strategy_owner_user_id: ownerUserId,
    _strategy_version: Number(pt.version || 1),
    _market_data_plan: policy.marketDataPlan,
    _allowed_entry_methods: policy.entryMethods,
    _use_chan_analysis: policy.useChanAnalysis,
    _ai_volume_min: 0.01,
    _ai_volume_max: Number(globalCfg?.max_position_size ?? DEFAULT_MAX_POSITION_SIZE),
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
            s.risk_level, s.max_position_size, s.selected_take_profit, s.enable_auto_trade,
            ss.id AS subscription_id, ss.schedule_enabled, ss.schedule_timezone,
            ss.schedule_weekdays_json, ss.schedule_windows_json, ss.outside_window_behavior,
            u.plan, u.role
     FROM auto_scheduler s
     JOIN auto_prompt_types apt ON apt.id = s.prompt_type_id
     JOIN strategy_subscriptions ss ON ss.user_id = s.user_id AND ss.strategy_id = s.prompt_type_id
       AND ss.execution_enabled = 1 AND ss.is_deleted = 0
     JOIN users u ON u.id = s.user_id
     WHERE s.prompt_type_id = ? AND s.enabled = 1
       AND (apt.scope = 'platform' OR (apt.scope = 'private' AND apt.owner_user_id = s.user_id))
       AND (u.role = 'admin' OR (u.plan = 'pro' AND (u.plan_expires_at IS NULL OR u.plan_expires_at >= NOW())))`,
    [promptTypeId]
  )
  const filtered = rows.filter(r => {
    if (r.strategy_scope === 'private' && Number(r.strategy_owner_user_id) !== Number(r.user_id)) return false
    if (!subscriptionAllowsInference(r)) return false
    // Determine user's effective symbols: selected_symbols_json ∩ strategy symbols
    let userSymbols = []
    try {
      if (r.selected_symbols_json) {
        userSymbols = JSON.parse(r.selected_symbols_json)
      } else {
        // NULL = old user, fall back to strategy all symbols
        userSymbols = JSON.parse(r.strategy_symbols_json || '[]')
      }
    } catch (e) { console.warn('[Config] Failed to parse user symbols:', e.message) }
    // Intersection with strategy symbols
    let strategySymbols = []
    try { strategySymbols = JSON.parse(r.strategy_symbols_json || '[]') } catch (e) {}
    const effectiveSymbols = userSymbols.filter(s => strategySymbols.includes(s))
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
    `SELECT ss.*, apt.symbols_json AS strategy_symbols_json
     FROM strategy_subscriptions ss
     JOIN auto_prompt_types apt ON apt.id = ss.strategy_id AND apt.deleted_at IS NULL
     WHERE ss.user_id = ? AND ss.strategy_id = ?
       AND ss.execution_enabled = 1 AND ss.is_deleted = 0
     ORDER BY ss.updated_at DESC, ss.id DESC`,
    [userId, promptTypeId]
  )
  const wanted = stripBrokerSuffix(String(symbol || '').toUpperCase())
  const subscription = rows.find(row => resolveEffectiveSymbols(row.symbols_json, row.strategy_symbols_json)
    .some(item => stripBrokerSuffix(String(item).toUpperCase()) === wanted))
  if (!subscription) return null
  return { ...subscription, in_schedule: subscriptionAllowsExecution(subscription) }
}

// === Delivery Execute Risk Config ===

export async function getDeliveryExecuteRiskConfig(userId) {
  const scheduler = await queryOne('SELECT risk_level, max_position_size, selected_take_profit, enable_auto_trade FROM auto_scheduler WHERE user_id = ?', [userId])
  if (scheduler) {
    return {
      enable_auto_trade: !!scheduler.enable_auto_trade,
      selected_take_profit: scheduler.selected_take_profit ?? DEFAULT_SELECTED_TAKE_PROFIT,
      max_position_size: scheduler.max_position_size ?? DEFAULT_MAX_POSITION_SIZE,
    }
  }
  const globalCfg = await getGlobalAutoConfig()
  if (!globalCfg) return null
  return {
    enable_auto_trade: !!globalCfg.enable_auto_trade,
    selected_take_profit: globalCfg.selected_take_profit ?? DEFAULT_SELECTED_TAKE_PROFIT,
    max_position_size: globalCfg.max_position_size ?? DEFAULT_MAX_POSITION_SIZE,
  }
}

export function validateTradeRequest(config, account, request) {
  const symbol = String(request.symbol || '').toUpperCase()
  const orderType = String(request.order_type || '').toLowerCase()
  const volume = parseFloat(request.volume || 0)
  const maxPosition = parseFloat((config || {}).max_position_size || DEFAULT_MAX_POSITION_SIZE)

  if (!symbol) throw new RiskReject('missing_symbol')
  if (request.source === 'ai' && String(request.signal_type || '').toLowerCase() === 'hold') {
    throw new RiskReject('hold_signal_cannot_execute')
  }
  if (!['buy', 'sell'].includes(orderType)) throw new RiskReject('invalid_order_type', { order_type: orderType })
  if (volume <= 0) throw new RiskReject('invalid_volume', { volume })
  if (volume > maxPosition) throw new RiskReject('volume_exceeds_config_limit', { volume, max_position_size: maxPosition })

  const referencePrice = request.reference_price
  const quotePrice = request.quote_price
  if (request.source === 'ai' && referencePrice && quotePrice && (request.entry_method || 'market') === 'market') {
    const reference = parseFloat(referencePrice)
    const current = parseFloat(quotePrice)
    if (reference > 0) {
      const slippagePct = Math.abs(current - reference) / reference * 100
      if (slippagePct > 0.08) {
        throw new RiskReject('signal_price_slippage_exceeded', {
          reference_price: reference, quote_price: current,
          slippage_pct: round3(slippagePct), limit_pct: 0.08,
        })
      }
    }
  }

  if (request.confirm !== true) throw new RiskReject('confirmation_required')

  const equity = parseFloat(account.equity || 0)
  if (equity <= 0) throw new RiskReject('invalid_account_equity', { equity: account.equity })

  // Pending order price direction validation
  const entryMethod = request.entry_method || 'market'
  if (entryMethod !== 'market' && entryMethod !== 'observe' && request.source === 'ai') {
    const lp = parseFloat(request.limit_price || 0)
    const ref = parseFloat(request.reference_price || 0)
    if (lp > 0 && ref > 0) {
      if (entryMethod === 'limit' && orderType === 'buy' && lp >= ref) throw new RiskReject('buy_limit_price_too_high', { limit_price: lp, reference: ref })
      if (entryMethod === 'limit' && orderType === 'sell' && lp <= ref) throw new RiskReject('sell_limit_price_too_low', { limit_price: lp, reference: ref })
      if (entryMethod === 'stop' && orderType === 'buy' && lp <= ref) throw new RiskReject('buy_stop_price_too_low', { limit_price: lp, reference: ref })
      if (entryMethod === 'stop' && orderType === 'sell' && lp >= ref) throw new RiskReject('sell_stop_price_too_high', { limit_price: lp, reference: ref })
      if (entryMethod === 'stop_limit') {
        const stopLimit = parseFloat(request.stop_limit_price || 0)
        if (!(stopLimit > 0)) throw new RiskReject('stop_limit_price_required')
        if (orderType === 'buy' && lp <= ref) throw new RiskReject('buy_stop_limit_trigger_too_low', { trigger_price: lp, reference: ref })
        if (orderType === 'sell' && lp >= ref) throw new RiskReject('sell_stop_limit_trigger_too_high', { trigger_price: lp, reference: ref })
        if (orderType === 'buy' && stopLimit > lp) throw new RiskReject('buy_stop_limit_price_above_trigger', { trigger_price: lp, stop_limit_price: stopLimit })
        if (orderType === 'sell' && stopLimit < lp) throw new RiskReject('sell_stop_limit_price_below_trigger', { trigger_price: lp, stop_limit_price: stopLimit })
      }
    }
  }

  return { symbol, order_type: orderType, volume, max_position_size: maxPosition, account_equity: equity }
}

export function signalOrderPayload(signal, config, market, confirm) {
  const configuredTier = Number((config || {}).selected_take_profit || DEFAULT_SELECTED_TAKE_PROFIT)
  const requestedTier = [1, 2, 3].includes(configuredTier) ? configuredTier : DEFAULT_SELECTED_TAKE_PROFIT
  const fallbackTiers = requestedTier === 3 ? [3, 2, 1] : requestedTier === 2 ? [2, 1] : [1]
  const usedTier = fallbackTiers.find(tier => {
    const value = Number(signal[`take_profit_${tier}_price`])
    return Number.isFinite(value) && value > 0
  }) || null

  // Extract base order_type from signal_type (buy_limit → buy, sell_stop → sell)
  const st = String(signal.signal_type || '').toLowerCase()
  const baseOrderType = st.startsWith('buy') ? 'buy' : st.startsWith('sell') ? 'sell' : st
  const entryMethod = signal.entry_method || (st.includes('stop_limit') ? 'stop_limit' : st.includes('limit') ? 'limit' : st.includes('stop') ? 'stop' : 'market')

  const payload = {
    symbol: signal.symbol,
    order_type: baseOrderType,
    volume: parseFloat(signal.recommended_volume),
    sl: signal.stop_loss_price,
    tp: usedTier ? signal[`take_profit_${usedTier}_price`] : null,
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
    signal_created_at: signal.created_at || beijingNow(),
    entry_method: entryMethod,
  }

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
  const now = beijingNow()
  if (cfg.api_key) await upsertDefaultModelProfileFromLegacyInput(userId, 'user', cfg, 'user')
  const keyEnc = null
  await queryRun(`INSERT INTO close_config (user_id, enabled, check_interval_seconds, model_name, api_provider, api_base_url, api_key_encrypted, temperature, max_tokens, system_prompt,
    rule_soft_sl, rule_soft_tp, rule_timeout_minutes, rule_max_loss_pct, rule_reverse_signal, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
    enabled = VALUES(enabled), check_interval_seconds = VALUES(check_interval_seconds),
    model_name = VALUES(model_name), api_provider = VALUES(api_provider), api_base_url = VALUES(api_base_url),
    api_key_encrypted = VALUES(api_key_encrypted), temperature = VALUES(temperature), max_tokens = VALUES(max_tokens),
    system_prompt = VALUES(system_prompt),
    rule_soft_sl = VALUES(rule_soft_sl), rule_soft_tp = VALUES(rule_soft_tp),
    rule_timeout_minutes = VALUES(rule_timeout_minutes), rule_max_loss_pct = VALUES(rule_max_loss_pct),
    rule_reverse_signal = VALUES(rule_reverse_signal), updated_at = VALUES(updated_at)`,
    [userId, cfg.enabled ? 1 : 0, cfg.check_interval_seconds || 60, cfg.model_name || 'deepseek-chat',
      cfg.api_provider || 'deepseek', cfg.api_base_url || DEFAULT_API_BASE_URL, keyEnc,
      cfg.temperature ?? DEFAULT_TEMPERATURE, cfg.max_tokens ?? DEFAULT_MAX_TOKENS,
      cfg.system_prompt || null, cfg.rule_soft_sl ?? null, cfg.rule_soft_tp ?? null,
      cfg.rule_timeout_minutes ?? null, cfg.rule_max_loss_pct ?? null, cfg.rule_reverse_signal ? 1 : 0, now])
  return await getCloseConfig(userId)
}

export async function getCloseSignalTickets(userId) {
  const rows = await queryAll('SELECT cst.original_ticket, cst.close_signal_id, cst.close_price, s.take_profit_1_price FROM close_signal_tickets cst LEFT JOIN ai_signals s ON cst.close_signal_id = s.id WHERE cst.user_id = ?', [userId])
  const map = {}
  for (const r of rows) {
    map[String(r.original_ticket)] = { signalId: r.close_signal_id, price: r.close_price, takeProfit: r.take_profit_1_price }
  }
  return map
}

export async function executeOrderCore(userId, config, request, action, options = {}) {
  options = { ...options, noFallback: true }
  const signalId = request.signal_id ?? options.signalId ?? null
  const sourceType = options.sourceType || (options.deliveryId ? 'auto_delivery' : signalId ? 'signal' : 'manual')
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
      const resolved = await resolveEffectiveRiskPolicy({
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
        ...validateTradeRequest(legacyConfig, account, decision.approved_order),
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
      if (!(Number(prepared.atr_anchor) > 0)) {
        const ratesResult = await bridge(actorId, 'rates', { symbol: prepared.symbol, timeframe: 'H1', count: 30 }, bridgeOptions)
        const atr = computeAtr14(ratesResult?.rates || [])
        if (atr > 0) prepared.atr_anchor = atr
      }
      const stateCursor = await queryOne(`SELECT ras.last_deal_time_msc, ras.last_deal_ticket,
          COALESCE(ras.last_risk_snapshot_at, ras.updated_at, ta.first_verified_at) AS incremental_baseline_at
        FROM trading_accounts ta LEFT JOIN risk_account_state ras ON ras.trading_account_id = ta.id
        WHERE ta.id = ? AND ta.user_id = ? AND ta.is_deleted = 0 LIMIT 1`, [tradingAccountId, actorId])
      if (!stateCursor) throw new Error('trading_account_not_found')
      const entryPrice = Number(prepared.limit_price || prepared.quote_price || prepared.reference_price || 0)
      const snapshotOptions = { ...(bridgeOptions || {}), timeoutMs: Math.max(10_000, Number(bridgeOptions?.timeoutMs) || 0), noFallback: true }
      const riskSnapshot = await bridge(actorId, 'risk_snapshot', {
        symbol: prepared.symbol,
        last_deal_time_msc: Number(stateCursor.last_deal_time_msc || 0),
        last_deal_ticket: Number(stateCursor.last_deal_ticket || 0),
        baseline_from_utc_msc: Number(stateCursor.last_deal_time_msc || 0) ? 0 : (parseBeijing(stateCursor.incremental_baseline_at)?.getTime() || Date.now()),
        proposed_order: {
          symbol: prepared.symbol, order_type: prepared.order_type, volume: Number(prepared.volume || 0),
          entry_price: entryPrice, sl: Number(prepared.sl || 0),
        },
      }, snapshotOptions)
      if (!riskSnapshot || riskSnapshot.status !== 'success') {
        const message = String(riskSnapshot?.message || riskSnapshot?.error || '')
        if (message.includes('Unknown action: risk_snapshot')) throw new Error('bridge_upgrade_required_for_incremental_risk')
        throw new Error(message || 'risk_snapshot_failed')
      }
      const instruments = {}
      for (const item of Object.values(riskSnapshot.instruments || {})) {
        if (!item?.name) continue
        instruments[stripBrokerSuffix(item.name)] = item
      }
      const wanted = stripBrokerSuffix(prepared.symbol)
      const instrument = instruments[wanted]
      if (!instrument) throw new Error('symbol_metadata_not_found')
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
        positions: riskSnapshot.positions || [], pending: riskSnapshot.pending || [],
        snapshot_complete: riskSnapshot.complete === true,
        data_incomplete_reasons: riskSnapshot.incomplete_reasons || [],
        risk_snapshot_version: Number(riskSnapshot.snapshot_version || 0),
        businessDate: riskSnapshot.business_date,
        increment: riskSnapshot.increment || {},
        broker_calculation: riskSnapshot.broker_calculation || null,
      }
    },
    enrichRequest: ({ request: prepared, quote }) => {
      if (!quote || !prepared.symbol) return
      prepared.quote_price = parseFloat(prepared.order_type === 'buy' ? quote.ask : quote.bid)
      const pointSize = quote.point || (prepared.quote_price > 1000 ? 0.01 : 0.0001)
      if (prepared.stop_loss_points && !prepared.sl) {
        prepared.sl = prepared.order_type === 'buy'
          ? round2(prepared.quote_price - prepared.stop_loss_points * pointSize)
          : round2(prepared.quote_price + prepared.stop_loss_points * pointSize)
      }
      if (prepared.take_profit_points && !prepared.tp) {
        prepared.tp = prepared.order_type === 'buy'
          ? round2(prepared.quote_price + prepared.take_profit_points * pointSize)
          : round2(prepared.quote_price - prepared.take_profit_points * pointSize)
      }
    },
  })
  await insertAudit(null, userId, action, request.symbol, request, result, result.status)
  return result
}
