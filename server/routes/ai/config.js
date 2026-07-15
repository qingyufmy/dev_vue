// ai/config.js — 配置管理 + 风控 + 审计

import { queryOne, queryAll, queryRun, withTransaction, beijingNow } from '../../db.js'
import { round2, round3, stripBrokerSuffix } from './utils.js'
import { DEFAULT_API_BASE_URL } from '../../config.js'
import { mt5Bridge, computeAtr14 } from './market-data.js'
import { prepareAuditRecord, shouldSkipHoldAudit } from '../../audit-localization.js'
import { isEncryptionAvailable } from '../../ai-credential.js'
import { resolveAiTaskModel } from './model-profiles.js'
import { prepareAndExecuteOrderIntent } from './order-intents.js'
import { evaluateCoreRisk, persistRiskDecision, resolveEffectiveRiskPolicy } from './risk-policy.js'
import { evaluateStatefulRiskTx, syncTradingAccountIdentity } from './risk-state.js'

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

export async function getActiveConfig(db, userId, sessionId = 'default', provider = null, opts = {}) {
  let row
  if (provider) {
    row = await queryOne('SELECT * FROM ai_configs WHERE user_id = ? AND session_id = ? AND api_provider = ?', [userId, sessionId, provider])
  } else {
    row = await queryOne('SELECT * FROM ai_configs WHERE user_id = ? AND session_id = ? AND is_active = 1 ORDER BY updated_at DESC LIMIT 1', [userId, sessionId])
  }

  if (opts.skipFallbacks) return row

  const userHasOwnConfig = row && row.api_key_encrypted
  if (!userHasOwnConfig) {
    const adminConfig = await queryOne("SELECT * FROM ai_configs WHERE model_sharing_enabled = 1 AND is_active = 1 AND user_id IN (SELECT id FROM users WHERE role = 'admin') LIMIT 1")
    if (adminConfig) {
      if (!row) row = {}
      row.api_provider = row.api_provider || adminConfig.api_provider
      row.model_name = row.model_name || adminConfig.model_name
      row.api_base_url = row.api_base_url || adminConfig.api_base_url
      row.temperature = row.temperature ?? adminConfig.temperature
      row.max_tokens = row.max_tokens ?? adminConfig.max_tokens
      row.model_sharing_enabled = adminConfig.model_sharing_enabled
      if (!row.api_key_encrypted && adminConfig.api_key_encrypted) row.api_key_encrypted = adminConfig.api_key_encrypted
      row._model_shared = true
    }
  }

  if (!row || !row.api_key_encrypted) {
    const cfg = {}
    try {
      const rows = await queryAll("SELECT `key`, `value` FROM system_config WHERE category = 'ai_provider' AND `value` != ''")
      for (const r of rows) cfg[r.key] = r.value
    } catch (e) { console.error('[AI] Failed to load system_config:', e.message) }
    const sysKey = cfg.deepseek_api_key || cfg.openai_api_key
    if (sysKey) {
      if (!row) row = {}
      row.api_key_encrypted = sysKey
      row.api_provider = row.api_provider || (cfg.deepseek_api_key ? 'deepseek' : 'openai')
      row.api_base_url = row.api_base_url || (cfg.deepseek_base_url || cfg.openai_base_url || null)
      row.model_name = row.model_name || (cfg.deepseek_model || cfg.openai_model || 'deepseek-chat')
    }
  }

  if (!row || !row.api_key_encrypted) {
    const globalCfg = await queryOne('SELECT * FROM global_auto_config WHERE id = 1')
    if (globalCfg && globalCfg.api_key_encrypted) {
      if (!row) row = {}
      row.api_key_encrypted = globalCfg.api_key_encrypted
      row.api_provider = row.api_provider || globalCfg.api_provider || 'deepseek'
      row.api_base_url = row.api_base_url || globalCfg.api_base_url || null
      row.model_name = row.model_name || globalCfg.model_name || 'deepseek-chat'
      row.temperature = row.temperature ?? globalCfg.temperature
      row.max_tokens = row.max_tokens ?? globalCfg.max_tokens
    }
  }

  return row
}

export async function getAnalyzeApiKey(userId, sessionId) {
  if (!isEncryptionAvailable()) throw new Error('encryption_master_key_missing')
  const resolved = await resolveAiTaskModel({ userId, strategyId: null, usage: 'manual' })
  if (!resolved.model?.api_key_encrypted) throw new Error(resolved.error || 'no_model_configured')
  const userConfig = await queryOne(
    `SELECT system_prompt, enable_auto_trade, risk_level, max_position_size, selected_take_profit
     FROM ai_configs WHERE user_id = ? AND session_id = ? AND is_active = 1
     ORDER BY updated_at DESC LIMIT 1`,
    [userId, sessionId]
  )
  const adminPromptConfig = await queryOne(
    "SELECT system_prompt FROM ai_configs WHERE is_active = 1 AND user_id IN (SELECT id FROM users WHERE role = 'admin') ORDER BY updated_at DESC LIMIT 1"
  )
  const effectivePrompt = userConfig?.system_prompt || adminPromptConfig?.system_prompt || ''

  return {
    ...resolved.model,
    system_prompt: effectivePrompt,
    enable_auto_trade: !!userConfig?.enable_auto_trade,
    risk_level: userConfig?.risk_level || 'medium',
    max_position_size: userConfig?.max_position_size ?? DEFAULT_MAX_POSITION_SIZE,
    selected_take_profit: userConfig?.selected_take_profit ?? DEFAULT_SELECTED_TAKE_PROFIT,
    _userId: userId,
    _usage: 'manual',
    _strategyId: null,
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

export async function saveGlobalAutoConfig(cfg) {
  const now = beijingNow()
  const supportedProviders = new Set(['deepseek', 'gpt', 'kimi', 'qwen', 'zhipu', 'doubao', 'volcengine_agent_plan'])
  if (cfg.api_provider && !supportedProviders.has(cfg.api_provider)) {
    throw new Error(`unsupported_ai_provider:${cfg.api_provider}`)
  }
  await queryRun(`
    UPDATE global_auto_config SET
      interval_minutes = ?,
      api_provider = ?, model_name = ?, api_key_encrypted = ?, api_base_url = ?,
      temperature = ?, max_tokens = ?,
      risk_level = ?, max_position_size = ?, selected_take_profit = ?,
      enable_auto_trade = ?,
      thinking_enabled = ?, reasoning_effort = ?,
      updated_at = ?
    WHERE id = 1
  `, [
    cfg.interval_minutes || 5,
    cfg.api_provider || null, cfg.model_name || null, cfg.api_key_encrypted || null, cfg.api_base_url || null,
    cfg.temperature ?? null, cfg.max_tokens ?? null,
    cfg.risk_level || null, cfg.max_position_size ?? null, cfg.selected_take_profit ?? null,
    cfg.enable_auto_trade ? 1 : 0,
    cfg.thinking_enabled !== undefined ? (cfg.thinking_enabled ? 1 : 0) : 1,
    cfg.reasoning_effort || 'max',
    now
  ])
}

export async function getExecuteRiskConfig(userId, signal) {
  const isAuto = (signal.config_id === 0 && signal.source !== 'auto_shared')
  if (isAuto || signal.source === 'auto_shared') {
    return getDeliveryExecuteRiskConfig(userId)
  }

  const sessionId = signal.session_id || 'default'
  const manualCfg = await queryOne(
    'SELECT * FROM ai_configs WHERE user_id = ? AND session_id = ? AND is_active = 1 ORDER BY updated_at DESC LIMIT 1',
    [userId, sessionId]
  )
  if (!manualCfg) return null
  return {
    enable_auto_trade: !!manualCfg.enable_auto_trade,
    selected_take_profit: manualCfg.selected_take_profit ?? DEFAULT_SELECTED_TAKE_PROFIT,
    max_position_size: manualCfg.max_position_size ?? DEFAULT_MAX_POSITION_SIZE,
  }
}

export async function upsertAutoConfig(db, userId, symbols, enabled, promptTypeId = null) {
  const now = beijingNow()
  await withTransaction(async (run) => {
    await run(`
      INSERT INTO auto_scheduler (user_id, enabled, prompt_type_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        enabled = VALUES(enabled),
        prompt_type_id = COALESCE(VALUES(prompt_type_id), prompt_type_id),
        updated_at = VALUES(updated_at)
    `, [userId, enabled ? 1 : 0, promptTypeId, now, now])
    await run(
      'INSERT INTO user_bridge_settings (user_id, auto_reasoning_enabled, updated_at) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE auto_reasoning_enabled = ?, updated_at = ?',
      [userId, enabled ? 1 : 0, now, enabled ? 1 : 0, now]
    )
  })
}

// === Auto Prompt Types (admin-managed strategies) ===

export async function getAutoPromptTypes({ includeInactive = false } = {}) {
  const where = includeInactive ? 'deleted_at IS NULL' : 'is_active = 1 AND deleted_at IS NULL'
  return await queryAll(`SELECT * FROM auto_prompt_types WHERE ${where} ORDER BY sort_order ASC, id ASC`)
}

export async function getAutoPromptTypeById(promptTypeId) {
  return await queryOne('SELECT * FROM auto_prompt_types WHERE id = ? AND deleted_at IS NULL', [promptTypeId])
}

export async function saveAutoPromptType(adminUserId, payload) {
  const now = beijingNow()
  let symbols = Array.isArray(payload.symbols) ? payload.symbols : []
  symbols = symbols.map(s => String(s).toUpperCase().trim()).filter(Boolean)
  const uniqueSymbols = [...new Set(symbols)]
  if (uniqueSymbols.length === 0) throw new Error('策略品种不能为空')
  const intervalMinutes = Math.max(1, Number(payload.interval_minutes) || 5)

  if (payload.id) {
    await queryRun(
      `UPDATE auto_prompt_types SET title = ?, description = ?, system_prompt = ?, symbols_json = ?,
       interval_minutes = ?, is_active = ?, sort_order = ?, updated_at = ?
       WHERE id = ? AND deleted_at IS NULL`,
      [payload.title || '未命名策略', payload.description || '', payload.system_prompt || '',
       JSON.stringify(uniqueSymbols), intervalMinutes,
       payload.is_active !== undefined ? (payload.is_active ? 1 : 0) : 1,
       payload.sort_order || 0, now, payload.id]
    )
    return await getAutoPromptTypeById(payload.id)
  }

  const result = await queryRun(
    `INSERT INTO auto_prompt_types (title, description, system_prompt, symbols_json, interval_minutes, is_active, sort_order, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [payload.title || '未命名策略', payload.description || '', payload.system_prompt || '',
     JSON.stringify(uniqueSymbols), intervalMinutes,
     payload.is_active !== undefined ? (payload.is_active ? 1 : 0) : 1,
     payload.sort_order || 0, adminUserId, now, now]
  )
  return await getAutoPromptTypeById(result.insertId)
}

export async function disableAutoPromptType(adminUserId, promptTypeId) {
  const now = beijingNow()
  await queryRun(
    'UPDATE auto_prompt_types SET is_active = 0, updated_at = ? WHERE id = ? AND deleted_at IS NULL',
    [now, promptTypeId]
  )
}

// === User Auto Config (user-facing settings) ===

export async function getUserAutoConfig(userId) {
  let scheduler = await queryOne('SELECT * FROM auto_scheduler WHERE user_id = ?', [userId])
  if (!scheduler) {
    const firstPt = await queryOne('SELECT id FROM auto_prompt_types WHERE is_active = 1 AND deleted_at IS NULL ORDER BY sort_order ASC, id ASC LIMIT 1')
    scheduler = {
      user_id: userId,
      enabled: 0,
      prompt_type_id: firstPt?.id || null,
      risk_level: 'medium',
      max_position_size: DEFAULT_MAX_POSITION_SIZE,
      selected_take_profit: DEFAULT_SELECTED_TAKE_PROFIT,
      enable_auto_trade: 1,
    }
  } else if (!scheduler.prompt_type_id) {
    const firstPt = await queryOne('SELECT id FROM auto_prompt_types WHERE is_active = 1 AND deleted_at IS NULL ORDER BY sort_order ASC, id ASC LIMIT 1')
    if (firstPt) scheduler.prompt_type_id = firstPt.id
  }
  // Populate selected_symbols using resolveEffectiveSymbols (Fix 3)
  scheduler.selected_symbols = []
  if (scheduler.prompt_type_id) {
    const pt = await queryOne('SELECT symbols_json FROM auto_prompt_types WHERE id = ?', [scheduler.prompt_type_id])
    scheduler.selected_symbols = resolveEffectiveSymbols(scheduler.selected_symbols_json, pt?.symbols_json || '[]')
  }
  let pausedReason = ''
  if (scheduler.enabled) {
    if (!scheduler.prompt_type_id) pausedReason = 'no_strategy'
    else {
      const pt = await getAutoPromptTypeById(scheduler.prompt_type_id)
      if (!pt || !pt.is_active) pausedReason = 'prompt_disabled'
    }
  }
  return { scheduler, running: false, pausedReason }
}

export async function saveUserAutoConfig(userId, payload) {
  const now = beijingNow()

  const existing = await queryOne('SELECT * FROM auto_scheduler WHERE user_id = ?', [userId])

  if (payload.prompt_type_id !== undefined && payload.prompt_type_id !== null) {
    const pt = await getAutoPromptTypeById(payload.prompt_type_id)
    if (!pt || !pt.is_active) throw new Error('策略不存在或已禁用')
  }

  if (payload.selected_take_profit !== undefined) {
    const tp = Number(payload.selected_take_profit)
    if (![1, 2, 3].includes(tp)) throw new Error('止盈档位只能是 1、2 或 3')
  }

  if (payload.max_position_size !== undefined) {
    const mps = parseFloat(payload.max_position_size)
    if (isNaN(mps) || mps <= 0) throw new Error('最大手数必须大于 0')
  }

  // Validate selected_symbols if provided
  let selectedSymbols = null
  if (payload.selected_symbols !== undefined) {
    if (!Array.isArray(payload.selected_symbols)) {
      throw new Error('selected_symbols 必须是数组')
    }
    if (payload.selected_symbols.length === 0) {
      selectedSymbols = []
    } else {
      const normalized = [...new Set(payload.selected_symbols.map(s => String(s).toUpperCase().trim()).filter(Boolean))]
      if (normalized.length === 0) throw new Error('selected_symbols 不能为空')

      const promptTypeId = payload.prompt_type_id !== undefined ? (payload.prompt_type_id || null) : (existing?.prompt_type_id ?? null)
      if (promptTypeId) {
        const pt = await getAutoPromptTypeById(promptTypeId)
        if (pt) {
          const strategySymbols = parsePromptSymbols(pt.symbols_json || '[]')
          const invalid = normalized.filter(s => !strategySymbols.includes(s))
          if (invalid.length > 0) {
            throw new Error(`品种 ${invalid.join(', ')} 不在策略支持列表中`)
          }
        }
      }
      selectedSymbols = normalized
    }
  }

  const next = {
    prompt_type_id: payload.prompt_type_id !== undefined ? (payload.prompt_type_id || null) : (existing?.prompt_type_id ?? null),
    risk_level: payload.risk_level !== undefined ? payload.risk_level : (existing?.risk_level ?? 'medium'),
    max_position_size: payload.max_position_size !== undefined ? Number(payload.max_position_size) : (existing?.max_position_size ?? DEFAULT_MAX_POSITION_SIZE),
    selected_take_profit: payload.selected_take_profit !== undefined ? Number(payload.selected_take_profit) : (existing?.selected_take_profit ?? DEFAULT_SELECTED_TAKE_PROFIT),
    enable_auto_trade: payload.enable_auto_trade !== undefined ? (payload.enable_auto_trade ? 1 : 0) : (existing?.enable_auto_trade ?? 1),
    selected_symbols_json: selectedSymbols !== null ? JSON.stringify(selectedSymbols) : (existing?.selected_symbols_json ?? null),
  }
  // INSERT enabled=0 is correct: first save means user hasn't toggled auto yet.
  // ON DUPLICATE KEY UPDATE preserves existing enabled value.
  await queryRun(
    `INSERT INTO auto_scheduler (user_id, enabled, prompt_type_id, risk_level, max_position_size, selected_take_profit, enable_auto_trade, selected_symbols_json, created_at, updated_at)
     VALUES (?, 0, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       prompt_type_id = VALUES(prompt_type_id),
       risk_level = VALUES(risk_level),
       max_position_size = VALUES(max_position_size),
       selected_take_profit = VALUES(selected_take_profit),
       enable_auto_trade = VALUES(enable_auto_trade),
       selected_symbols_json = VALUES(selected_symbols_json),
       updated_at = VALUES(updated_at)`,
    [userId, next.prompt_type_id, next.risk_level, next.max_position_size, next.selected_take_profit,
     next.enable_auto_trade, next.selected_symbols_json, now, now]
  )
}

// === Unified Auto Inference Config (for signal generation) ===

export async function getUnifiedAutoInferenceConfig(promptTypeId) {
  if (!isEncryptionAvailable()) throw new Error('encryption_master_key_missing')
  const resolved = await resolveAiTaskModel({ userId: 0, strategyId: promptTypeId, usage: 'auto_platform' })
  if (!resolved.model?.api_key_encrypted) throw new Error(resolved.error || 'no_platform_model')
  const globalCfg = await getGlobalAutoConfig()
  const pt = await getAutoPromptTypeById(promptTypeId)
  if (!pt) return null
  return {
    ...resolved.model,
    system_prompt: pt.system_prompt || '',
    risk_level: globalCfg?.risk_level || 'medium',
    max_position_size: globalCfg?.max_position_size ?? DEFAULT_MAX_POSITION_SIZE,
    selected_take_profit: globalCfg?.selected_take_profit ?? DEFAULT_SELECTED_TAKE_PROFIT,
    enable_auto_trade: !!globalCfg?.enable_auto_trade,
    thinking_enabled: resolved.model.thinking_enabled !== 0,
    reasoning_effort: resolved.model.reasoning_effort || 'max',
    _userId: 0,
    _usage: 'auto_platform',
    _strategyId: promptTypeId,
    _source: 'unified',
    _model_profile_id: resolved.model_profile_id,
    _credential_source: resolved.credential_source,
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
            s.risk_level, s.max_position_size, s.selected_take_profit, s.enable_auto_trade,
            u.plan, u.role
     FROM auto_scheduler s
     JOIN auto_prompt_types apt ON apt.id = s.prompt_type_id
     JOIN users u ON u.id = s.user_id
     WHERE s.prompt_type_id = ? AND s.enabled = 1
       AND (u.role = 'admin' OR (u.plan = 'pro' AND (u.plan_expires_at IS NULL OR u.plan_expires_at >= NOW())))`,
    [promptTypeId]
  )
  const filtered = rows.filter(r => {
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
  let keyEnc = cfg.api_key_encrypted || null
  if (cfg.api_key && !keyEnc) { keyEnc = cfg.api_key }
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
  const signalId = request.signal_id ?? options.signalId ?? null
  const sourceType = options.sourceType || (options.deliveryId ? 'auto_delivery' : signalId ? 'signal' : 'manual')
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
      const decision = evaluateCoreRisk({ request: prepared, account, quote: context.quote, instrument: context.instrument, policy: resolved.policy })
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
    }),
    loadRiskContext: async ({ bridge, actorId, request: prepared, account, quote, bridgeOptions }) => {
      const symbolsResult = await bridge(actorId, 'symbols', {}, bridgeOptions)
      if (!symbolsResult || symbolsResult.status === 'error') throw new Error(symbolsResult?.message || 'symbol_metadata_failed')
      const wanted = stripBrokerSuffix(prepared.symbol)
      const instrument = (symbolsResult.symbols || []).find(item => String(item.name || '').toUpperCase() === String(prepared.symbol || '').toUpperCase())
        || (symbolsResult.symbols || []).find(item => stripBrokerSuffix(item.name) === wanted)
      if (!instrument) throw new Error('symbol_metadata_not_found')
      if (!(Number(prepared.atr_anchor) > 0)) {
        const ratesResult = await bridge(actorId, 'rates', { symbol: prepared.symbol, timeframe: 'H1', count: 30 }, bridgeOptions)
        const atr = computeAtr14(ratesResult?.rates || [])
        if (atr > 0) prepared.atr_anchor = atr
      }
      const today = beijingNow().slice(0, 10)
      const [positionsResult, pendingResult, historyToday, historyAll] = await Promise.all([
        bridge(actorId, 'positions', {}, bridgeOptions),
        bridge(actorId, 'pending_list', {}, bridgeOptions),
        bridge(actorId, 'history', { page: 1, page_size: 5000, date_from: today }, bridgeOptions),
        bridge(actorId, 'history', { page: 1, page_size: 5000 }, bridgeOptions),
      ])
      const instruments = Object.fromEntries((symbolsResult.symbols || []).map(item => [stripBrokerSuffix(item.name), item]))
      const fxRates = {}
      const accountCurrency = String(account?.currency || '').toUpperCase()
      const quoteCurrencies = new Set([...(positionsResult?.positions || []), ...(pendingResult?.orders || []), prepared]
        .map(item => stripBrokerSuffix(item.symbol)).filter(symbol => symbol.length >= 6).map(symbol => symbol.slice(3, 6)))
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
        positions: positionsResult?.status === 'success' ? (positionsResult.positions || []) : [],
        pending: pendingResult?.status === 'success' ? (pendingResult.orders || []) : [],
        snapshot_complete: positionsResult?.status === 'success' && pendingResult?.status === 'success',
        historyToday, historyAll,
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
