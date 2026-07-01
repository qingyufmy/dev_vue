// ai/config.js — 配置管理 + 风控 + 审计

import { queryOne, queryAll, queryRun, beijingNow } from '../../db.js'
import { round2, round3, configPublic } from './utils.js'

export class RiskReject extends Error {
  constructor(reason, details = {}) {
    super(reason)
    this.reason = reason
    this.details = details
  }
}

export async function insertAudit(db, userId, action, symbol, request, result, status) {
  await queryRun(`
    INSERT INTO trade_audit_logs(user_id, action, symbol, request_json, result_json, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [userId, action, symbol || null, JSON.stringify(request), JSON.stringify(result), status, beijingNow()])
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
  const userConfig = await queryOne(
    'SELECT * FROM ai_configs WHERE user_id = ? AND session_id = ? AND is_active = 1 ORDER BY updated_at DESC LIMIT 1',
    [userId, sessionId]
  )
  const adminConfig = await queryOne(
    "SELECT * FROM ai_configs WHERE model_sharing_enabled = 1 AND is_active = 1 AND user_id IN (SELECT id FROM users WHERE role = 'admin') LIMIT 1"
  )

  if (adminConfig && adminConfig.api_key_encrypted) {
    if (userConfig) {
      return {
        ...userConfig,
        api_key_encrypted: adminConfig.api_key_encrypted,
        api_provider: adminConfig.api_provider || 'deepseek',
        model_name: adminConfig.model_name || 'deepseek-chat',
        api_base_url: adminConfig.api_base_url || null,
        temperature: adminConfig.temperature ?? 0.7,
        max_tokens: adminConfig.max_tokens ?? 2000,
        _model_shared: true,
      }
    }
    return {
      api_key_encrypted: adminConfig.api_key_encrypted,
      api_provider: adminConfig.api_provider || 'deepseek',
      model_name: adminConfig.model_name || 'deepseek-chat',
      api_base_url: adminConfig.api_base_url || null,
      temperature: adminConfig.temperature ?? 0.7,
      max_tokens: adminConfig.max_tokens ?? 2000,
      system_prompt: 'You are a disciplined trading analyst. Return strict JSON with signal_type, confidence, recommended_volume, analysis, reasoning, stop_loss_price, take_profit_1_price, take_profit_2_price, take_profit_3_price.',
      enable_auto_trade: false,
      max_position_size: 0.05,
      selected_take_profit: 1,
      risk_level: 'medium',
      _model_shared: true,
    }
  }

  if (!userConfig) return null
  return userConfig
}

export async function getAutoConfig(db, userId) {
  return await queryOne('SELECT * FROM auto_scheduler WHERE user_id = ?', [userId])
}

export async function getGlobalAutoConfig() {
  return await queryOne('SELECT * FROM global_auto_config WHERE id = 1')
}

export async function saveGlobalAutoConfig(cfg) {
  const now = beijingNow()
  await queryRun(`
    UPDATE global_auto_config SET
      symbols = ?, interval_minutes = ?,
      api_provider = ?, model_name = ?, api_key_encrypted = ?, api_base_url = ?,
      temperature = ?, max_tokens = ?, system_prompt = ?,
      risk_level = ?, max_position_size = ?, selected_take_profit = ?,
      enable_auto_trade = ?,
      updated_at = ?
    WHERE id = 1
  `, [
    cfg.symbols || 'XAUUSD', cfg.interval_minutes || 5,
    cfg.api_provider || null, cfg.model_name || null, cfg.api_key_encrypted || null, cfg.api_base_url || null,
    cfg.temperature ?? null, cfg.max_tokens ?? null, cfg.system_prompt || null,
    cfg.risk_level || null, cfg.max_position_size ?? null, cfg.selected_take_profit ?? null,
    cfg.enable_auto_trade ? 1 : 0, now
  ])
}

export async function getAutoInferenceConfig(userId) {
  if (userId) {
    const userConfig = await queryOne(
      "SELECT * FROM ai_configs WHERE user_id = ? AND session_id = 'default' AND is_active = 1 AND auto_config_override = 1 ORDER BY updated_at DESC LIMIT 1",
      [userId]
    )
    if (userConfig && userConfig.api_key_encrypted) {
      return {
        api_provider: userConfig.api_provider || 'deepseek',
        model_name: userConfig.model_name || 'deepseek-chat',
        api_key_encrypted: userConfig.api_key_encrypted,
        api_base_url: userConfig.api_base_url || 'https://api.deepseek.com',
        temperature: userConfig.temperature ?? 0.7,
        max_tokens: userConfig.max_tokens ?? 2000,
        risk_level: userConfig.risk_level || 'medium',
        max_position_size: userConfig.max_position_size ?? 0.05,
        selected_take_profit: userConfig.selected_take_profit ?? 1,
        system_prompt: userConfig.system_prompt || '',
        enable_auto_trade: !!userConfig.enable_auto_trade,
        auto_symbols: userConfig.auto_symbols || null,
        auto_interval_minutes: userConfig.auto_interval_minutes ?? null,
        _source: 'user_override'
      }
    }
  }

  const globalCfg = await getGlobalAutoConfig()
  if (!globalCfg) return null
  return {
    api_provider: globalCfg.api_provider || 'deepseek',
    model_name: globalCfg.model_name || 'deepseek-chat',
    api_key_encrypted: globalCfg.api_key_encrypted,
    api_base_url: globalCfg.api_base_url || 'https://api.deepseek.com',
    temperature: globalCfg.temperature ?? 0.3,
    max_tokens: globalCfg.max_tokens ?? 2000,
    risk_level: globalCfg.risk_level || 'medium',
    max_position_size: globalCfg.max_position_size ?? 0.05,
    selected_take_profit: globalCfg.selected_take_profit ?? 2,
    system_prompt: globalCfg.system_prompt || '',
    enable_auto_trade: !!globalCfg.enable_auto_trade,
    _source: 'auto'
  }
}

export async function getExecuteRiskConfig(userId, signal) {
  const isAuto = (signal.config_id === 0 && signal.source !== 'auto_shared')
  if (isAuto || signal.source === 'auto_shared') {
    const userScheduler = await queryOne('SELECT risk_level, max_position_size, selected_take_profit, enable_auto_trade FROM auto_scheduler WHERE user_id = ?', [userId])
    if (userScheduler) {
      return {
        enable_auto_trade: !!userScheduler.enable_auto_trade,
        selected_take_profit: userScheduler.selected_take_profit ?? 1,
        max_position_size: userScheduler.max_position_size ?? 0.05,
      }
    }
    const globalCfg = await getGlobalAutoConfig()
    if (!globalCfg) return null
    return {
      enable_auto_trade: !!globalCfg.enable_auto_trade,
      selected_take_profit: globalCfg.selected_take_profit ?? 2,
      max_position_size: globalCfg.max_position_size ?? 0.05,
    }
  }

  const sessionId = signal.session_id || 'default'
  const manualCfg = await queryOne(
    'SELECT * FROM ai_configs WHERE user_id = ? AND session_id = ? AND is_active = 1 ORDER BY updated_at DESC LIMIT 1',
    [userId, sessionId]
  )
  if (!manualCfg) return null
  return {
    enable_auto_trade: !!manualCfg.enable_auto_trade,
    selected_take_profit: manualCfg.selected_take_profit ?? 1,
    max_position_size: manualCfg.max_position_size ?? 0.05,
  }
}

export async function upsertAutoConfig(db, userId, symbols, enabled, promptTypeId = null) {
  const now = beijingNow()
  await queryRun(`
    INSERT INTO auto_scheduler (user_id, symbols, enabled, prompt_type_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      symbols = VALUES(symbols), enabled = VALUES(enabled),
      prompt_type_id = COALESCE(VALUES(prompt_type_id), prompt_type_id),
      updated_at = VALUES(updated_at)
  `, [userId, JSON.stringify(symbols), enabled ? 1 : 0, promptTypeId, now, now])
  await queryRun(
    'INSERT INTO user_bridge_settings (user_id, auto_reasoning_enabled, updated_at) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE auto_reasoning_enabled = ?, updated_at = ?',
    [userId, enabled ? 1 : 0, now, enabled ? 1 : 0, now]
  ).catch(e => console.error('[AutoConfig] Failed to sync user_bridge_settings:', e.message))
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
  const scheduler = await queryOne('SELECT * FROM auto_scheduler WHERE user_id = ?', [userId])
  const running = isAutoSchedulerKeyRunningForUser(userId)
  let pausedReason = ''
  if (scheduler?.enabled && !running) {
    if (!scheduler.prompt_type_id) pausedReason = 'no_strategy'
    else {
      const pt = await getAutoPromptTypeById(scheduler.prompt_type_id)
      if (!pt || !pt.is_active) pausedReason = 'prompt_disabled'
    }
  }
  return { scheduler, running, pausedReason }
}

function isAutoSchedulerKeyRunningForUser(userId) {
  // This will be called from scheduler.js via a callback pattern; for now check via import
  try {
    const { autoSchedulerState } = require ? {} : {}
  } catch {}
  return false
}

export async function saveUserAutoConfig(userId, payload) {
  const now = beijingNow()
  const { prompt_type_id, risk_level, max_position_size, selected_take_profit, enable_auto_trade } = payload

  if (prompt_type_id !== undefined) {
    const pt = await getAutoPromptTypeById(prompt_type_id)
    if (!pt || !pt.is_active) throw new Error('策略不存在或已禁用')
  }

  const tp = Number(selected_take_profit)
  if (tp && ![1, 2, 3].includes(tp)) throw new Error('止盈档位只能是 1、2 或 3')

  const mps = parseFloat(max_position_size)
  if (mps !== undefined && (isNaN(mps) || mps <= 0)) throw new Error('最大手数必须大于 0')

  await queryRun(
    `INSERT INTO auto_scheduler (user_id, enabled, prompt_type_id, risk_level, max_position_size, selected_take_profit, enable_auto_trade, created_at, updated_at)
     VALUES (?, 0, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       prompt_type_id = COALESCE(VALUES(prompt_type_id), prompt_type_id),
       risk_level = COALESCE(VALUES(risk_level), risk_level),
       max_position_size = COALESCE(VALUES(max_position_size), max_position_size),
       selected_take_profit = COALESCE(VALUES(selected_take_profit), selected_take_profit),
       enable_auto_trade = COALESCE(VALUES(enable_auto_trade), enable_auto_trade),
       updated_at = VALUES(updated_at)`,
    [userId, prompt_type_id || null, risk_level || 'medium', mps || 0.05, tp || 2,
     enable_auto_trade ? 1 : 0, now, now]
  )
}

// === Unified Auto Inference Config (for signal generation) ===

export async function getUnifiedAutoInferenceConfig(promptTypeId) {
  const globalCfg = await getGlobalAutoConfig()
  if (!globalCfg) return null
  const pt = await getAutoPromptTypeById(promptTypeId)
  if (!pt) return null
  return {
    api_provider: globalCfg.api_provider || 'deepseek',
    model_name: globalCfg.model_name || 'deepseek-chat',
    api_key_encrypted: globalCfg.api_key_encrypted,
    api_base_url: globalCfg.api_base_url || 'https://api.deepseek.com',
    temperature: globalCfg.temperature ?? 0.3,
    max_tokens: globalCfg.max_tokens ?? 2000,
    system_prompt: pt.system_prompt || '',
    risk_level: globalCfg.risk_level || 'medium',
    max_position_size: globalCfg.max_position_size ?? 0.05,
    selected_take_profit: globalCfg.selected_take_profit ?? 2,
    enable_auto_trade: !!globalCfg.enable_auto_trade,
    _source: 'unified',
    prompt_type_id: promptTypeId,
  }
}

// === Auto Subscribers ===

export async function getAutoSubscribers(promptTypeId, symbol) {
  return await queryAll(
    `SELECT s.user_id, s.risk_level, s.max_position_size, s.selected_take_profit, s.enable_auto_trade,
            u.plan, u.role
     FROM auto_scheduler s
     JOIN users u ON u.id = s.user_id
     WHERE s.prompt_type_id = ? AND s.enabled = 1 AND u.plan = 'pro'`,
    [promptTypeId]
  )
}

// === Delivery Execute Risk Config ===

export async function getDeliveryExecuteRiskConfig(userId) {
  const scheduler = await queryOne('SELECT risk_level, max_position_size, selected_take_profit, enable_auto_trade FROM auto_scheduler WHERE user_id = ?', [userId])
  if (scheduler) {
    return {
      enable_auto_trade: !!scheduler.enable_auto_trade,
      selected_take_profit: scheduler.selected_take_profit ?? 1,
      max_position_size: scheduler.max_position_size ?? 0.05,
    }
  }
  const globalCfg = await getGlobalAutoConfig()
  if (!globalCfg) return null
  return {
    enable_auto_trade: !!globalCfg.enable_auto_trade,
    selected_take_profit: globalCfg.selected_take_profit ?? 2,
    max_position_size: globalCfg.max_position_size ?? 0.05,
  }
}

export function validateTradeRequest(config, account, positions, request) {
  const symbol = String(request.symbol || '').toUpperCase()
  const orderType = String(request.order_type || '').toLowerCase()
  const volume = parseFloat(request.volume || 0)
  const maxPosition = parseFloat((config || {}).max_position_size || 0.05)

  if (!symbol) throw new RiskReject('missing_symbol')
  if (request.source === 'ai' && String(request.signal_type || '').toLowerCase() === 'hold') {
    throw new RiskReject('hold_signal_cannot_execute')
  }
  if (!['buy', 'sell'].includes(orderType)) throw new RiskReject('invalid_order_type', { order_type: orderType })
  if (volume <= 0) throw new RiskReject('invalid_volume', { volume })
  if (volume > maxPosition) throw new RiskReject('volume_exceeds_config_limit', { volume, max_position_size: maxPosition })

  const referencePrice = request.reference_price
  const quotePrice = request.quote_price
  if (request.source === 'ai' && referencePrice && quotePrice) {
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

  return { symbol, order_type: orderType, volume, max_position_size: maxPosition, account_equity: equity }
}

export function signalOrderPayload(signal, config, market, confirm) {
  const tpKey = `take_profit_${(config || {}).selected_take_profit || 1}_price`
  return {
    symbol: signal.symbol,
    order_type: signal.signal_type,
    volume: parseFloat(signal.recommended_volume),
    sl: signal.stop_loss_price,
    tp: signal[tpKey],
    confirm: confirm,
    source: 'ai',
    signal_type: signal.signal_type,
    signal_id: signal.id,
    reference_price: market.latest_price,
  }
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
      cfg.api_provider || 'deepseek', cfg.api_base_url || 'https://api.deepseek.com', keyEnc,
      cfg.temperature ?? 0.3, cfg.max_tokens || 4000,
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
