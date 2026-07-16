import { queryOne, queryRun, beijingNow } from '../../db.js'

const DEFAULT_PREFERENCE = Object.freeze({
  system_prompt: '',
  enable_auto_trade: false,
  enable_futures_trading: false,
  risk_level: 'medium',
  max_position_size: 0.05,
  selected_take_profit: 2,
})

function normalizeSessionId(value) {
  const sessionId = String(value || 'default').trim()
  if (!sessionId || sessionId.length > 100) throw new Error('invalid_session_id')
  return sessionId
}

function normalizeStoredPreference(row) {
  if (!row) return null
  return {
    system_prompt: row.system_prompt || '',
    enable_auto_trade: !!row.enable_auto_trade,
    enable_futures_trading: !!row.enable_futures_trading,
    risk_level: row.risk_level || DEFAULT_PREFERENCE.risk_level,
    max_position_size: Number(row.max_position_size ?? DEFAULT_PREFERENCE.max_position_size),
    selected_take_profit: Number(row.selected_take_profit ?? DEFAULT_PREFERENCE.selected_take_profit),
  }
}

export async function getAdminDefaultPrompt() {
  const row = await queryOne(`SELECT p.system_prompt
    FROM ai_inference_preferences p
    INNER JOIN users u ON u.id = p.user_id
    WHERE u.role = 'admin' AND p.session_id = 'default' AND p.system_prompt IS NOT NULL AND p.system_prompt != ''
    ORDER BY p.updated_at DESC LIMIT 1`)
  return row?.system_prompt || ''
}

export async function getInferencePreference(userId, sessionId = 'default') {
  const sid = normalizeSessionId(sessionId)
  const [row, user, defaultPrompt] = await Promise.all([
    queryOne('SELECT * FROM ai_inference_preferences WHERE user_id = ? AND session_id = ?', [userId, sid]),
    queryOne('SELECT role FROM users WHERE id = ?', [userId]),
    getAdminDefaultPrompt(),
  ])
  const own = normalizeStoredPreference(row)
  const inherited = user?.role !== 'admin' && !own?.system_prompt
  return {
    ...DEFAULT_PREFERENCE,
    ...(own || {}),
    system_prompt: inherited ? defaultPrompt : (own?.system_prompt || ''),
    _exists: !!row,
    _system_prompt_inherited: inherited,
    default_prompt: defaultPrompt,
  }
}

export async function saveInferencePreference(userId, sessionId = 'default', input = {}) {
  const sid = normalizeSessionId(sessionId)
  const riskLevel = String(input.risk_level || DEFAULT_PREFERENCE.risk_level)
  if (!['low', 'medium', 'high'].includes(riskLevel)) throw new Error('invalid_risk_level')
  const maxPositionSize = Number(input.max_position_size)
  if (!Number.isFinite(maxPositionSize) || maxPositionSize < 0.01 || maxPositionSize > 100) throw new Error('invalid_max_position_size')
  const selectedTakeProfit = Number(input.selected_take_profit)
  if (![1, 2, 3].includes(selectedTakeProfit)) throw new Error('invalid_take_profit_selection')
  const systemPrompt = input.system_prompt == null ? null : String(input.system_prompt).trim()
  if (systemPrompt && systemPrompt.length > 100000) throw new Error('system_prompt_too_long')
  const now = beijingNow()
  await queryRun(`INSERT INTO ai_inference_preferences
    (user_id, session_id, system_prompt, enable_auto_trade, enable_futures_trading,
     risk_level, max_position_size, selected_take_profit, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE system_prompt = VALUES(system_prompt),
      enable_auto_trade = VALUES(enable_auto_trade), enable_futures_trading = VALUES(enable_futures_trading),
      risk_level = VALUES(risk_level), max_position_size = VALUES(max_position_size),
      selected_take_profit = VALUES(selected_take_profit), updated_at = VALUES(updated_at)`,
  [userId, sid, systemPrompt, input.enable_auto_trade ? 1 : 0, input.enable_futures_trading ? 1 : 0,
    riskLevel, maxPositionSize, selectedTakeProfit, now, now])
  return getInferencePreference(userId, sid)
}
