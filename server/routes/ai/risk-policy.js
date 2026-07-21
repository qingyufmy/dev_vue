// Versioned risk policy resolution and deterministic L1/L4/L5 core gate.

import { queryAll, queryOne, queryRun, withTransaction, beijingNow } from '../../db.js'
import { stripBrokerSuffix } from './utils.js'
import { riskRuleIsEnforced } from './rollout-governance.js'

const rule = (code, type, unit, safety, value, min, max, locked, label, options = {}) => ({
  code, type, unit, unit_label: options.unit_label || unit, safety_direction: safety,
  default_value: value, allowed_min: min, allowed_max: max, locked, label,
  user_editable: options.user_editable ?? !locked,
  configurable: options.configurable ?? true,
  category: options.category || 'account',
  description: options.description || '',
})

export const RISK_RULES = Object.freeze({
  allowed_symbols: rule('R1.1', 'set', 'symbol', 'subset', ['*'], null, null, false, '允许交易品种', { user_editable:false, category:'platform', description:'平台允许自动执行的品种范围' }),
  require_stop_loss: rule('R1.2', 'boolean', 'bool', 'locked_true', true, true, true, true, '强制止损', { unit_label:'开/关', category:'system', description:'所有自动执行订单必须包含有效止损' }),
  sl_atr_max: rule('R1.4', 'number', 'ATR', 'lower', 4, 0.5, 10, false, '最大止损距离', { unit_label:'ATR 倍', description:'拦截明显超出行情波动范围的止损' }),
  min_rr: rule('R1.5', 'number', 'ratio', 'higher', 1.1, 0.5, 10, false, '最低盈亏比', { unit_label:'倍', description:'实际入场、止损和止盈之间的最低收益风险比' }),
  pending_price_deviation_pct: rule('R1.7A', 'number', 'percent', 'lower', 1, 0.01, 10, false, '挂单价格偏离百分比', { unit_label:'%', description:'挂单触发价相对当前报价的最大距离' }),
  pending_price_deviation_atr: rule('R1.7B', 'number', 'ATR', 'lower', 2, 0.1, 10, false, '挂单价格偏离 ATR', { unit_label:'ATR 倍', description:'与百分比上限取更严格的结果' }),
  pending_valid_minutes: rule('R1.8', 'number', 'minute', 'lower', 180, 5, 1440, false, '挂单默认有效期', { unit_label:'分钟', description:'模型未指定时使用；策略可设置更短期限' }),
  max_position_size: rule('R1.9D', 'number', 'lot', 'lower', 0.05, 0.001, 100, false, '单笔最大手数', { unit_label:'手', description:'任何单笔订单都不能突破的平台手数上限' }),
  max_risk_per_trade_pct: rule('R1.10', 'number', 'percent', 'lower', 1, 0.01, 20, false, '单笔最大风险比例', { unit_label:'%', description:'按真实止损亏损金额占账户净值计算' }),
  signal_ttl_seconds: rule('R4.3', 'number', 'second', 'lower', 300, 5, 86400, false, '信号有效期', { unit_label:'秒', user_editable:false, category:'platform', description:'防止执行已经过时的 AI 信号' }),
  max_quote_age_seconds: rule('R4.4', 'number', 'second', 'lower', 15, 1, 300, false, '报价最大年龄', { unit_label:'秒', user_editable:false, category:'system', description:'使用桥接标准化后的 UTC 报价时间检查' }),
  max_spread_points: rule('R4.5', 'number', 'point', 'lower', 120, 1, 100000, false, '最大点差', { unit_label:'点', description:'超过该点差时不新增风险' }),
  market_signal_drift_atr: rule('R4.6', 'number', 'ATR', 'lower', 0.5, 0.01, 5, false, '市价信号价格漂移', { unit_label:'ATR 倍', description:'当前成交价偏离推理参考价的最大幅度' }),
  broker_slippage_points: rule('PX.3', 'number', 'point', 'lower', 30, 0, 10000, false, '下单允许价格偏差', { unit_label:'MT5 点', description:'传给 MT5 order_send.deviation 的整数点数；不是百分比，也不是实际成交滑点' }),
  weekend_close_minutes: rule('R4.2', 'number', 'minute', 'higher', 60, 0, 2880, false, '周末收盘提前保护', { unit_label:'分钟', description:'在 MT5 周末收盘前提前停止新增风险' }),
  max_directional_exposure_lots: rule('R2.1', 'number', 'lot', 'lower', 0.1, 0.001, 1000, false, '同向最大敞口', { unit_label:'手', description:'同品种同方向持仓、挂单和执行预占的合计上限' }),
  min_open_interval_seconds: rule('R2.2', 'number', 'second', 'higher', 30, 0, 86400, false, '最小开仓间隔', { unit_label:'秒', description:'限制账户连续新增仓位的最短间隔' }),
  max_daily_open_count: rule('R2.3', 'number', 'count', 'lower', 20, 1, 10000, false, '每日开仓次数', { unit_label:'次/日', description:'按 MT5 交易日统计成功开仓次数' }),
  dedup_window_seconds: rule('R2.4A', 'number', 'second', 'higher', 180, 0, 86400, false, '重复订单时间窗', { unit_label:'秒', user_editable:false, category:'system', description:'系统内部的第二层重复下单保护' }),
  dedup_price_atr: rule('R2.4B', 'number', 'ATR', 'higher', 0.05, 0, 5, false, '重复订单价格距离', { unit_label:'ATR 倍', user_editable:false, category:'system', description:'系统内部重复订单价格相似度' }),
  daily_loss_limit_pct: rule('R3.1', 'number', 'percent', 'lower', 3, 0.1, 100, false, '每日最大亏损', { unit_label:'%', description:'已实现净亏损加当前浮亏占日初净值的比例' }),
  consecutive_loss_limit: rule('R3.2A', 'number', 'count', 'lower', 3, 1, 100, false, '连续亏损次数', { unit_label:'笔', description:'按完整平仓持仓统计，不按成交明细重复计数' }),
  loss_cooldown_minutes: rule('R3.2B', 'number', 'minute', 'higher', 60, 1, 10080, false, '连续亏损冷却', { unit_label:'分钟', description:'达到连续亏损次数后暂停新增风险' }),
  max_drawdown_pct: rule('R3.3', 'number', 'percent', 'lower', 8, 0.1, 100, false, '最大回撤', { unit_label:'%', description:'经资金流校正后的净值高水位回撤' }),
  min_margin_level_pct: rule('R3.4A', 'number', 'percent', 'higher', 300, 0, 100000, false, '最低预计保证金水平', { unit_label:'%', description:'使用 MT5 预计保证金计算下单后的保证金水平' }),
})

export const DEFAULT_RISK_POLICY = Object.freeze(Object.fromEntries(Object.entries(RISK_RULES).map(([key, meta]) => [key, Array.isArray(meta.default_value) ? [...meta.default_value] : meta.default_value])))

const parseJson = (value, fallback = {}) => {
  if (value == null) return fallback
  if (typeof value === 'object') return value
  try { return JSON.parse(value) } catch { return fallback }
}
const finite = value => Number.isFinite(Number(value)) ? Number(value) : null

function normalizeValue(key, value) {
  const meta = RISK_RULES[key]
  if (!meta) return undefined
  if (meta.type === 'boolean') return Boolean(value)
  if (meta.type === 'set') return Array.isArray(value) ? [...new Set(value.map(item => String(item).toUpperCase().trim()).filter(Boolean))] : undefined
  const number = finite(value)
  return number == null ? undefined : Math.min(meta.allowed_max, Math.max(meta.allowed_min, number))
}

function mergeKnown(base, override) {
  const result = { ...base }
  for (const [key, value] of Object.entries(override || {})) {
    const normalized = normalizeValue(key, value)
    if (normalized !== undefined) result[key] = normalized
  }
  result.require_stop_loss = true
  return result
}

function buildPlatformControls(rawConfig = {}) {
  const configured = rawConfig.controls || rawConfig._controls || {}
  const platformValues = mergeKnown(DEFAULT_RISK_POLICY, rawConfig.values || rawConfig.defaults || rawConfig)
  return Object.fromEntries(Object.entries(RISK_RULES).map(([key, meta]) => {
    const input = configured[key] || {}
    const allowedMin = meta.type === 'number' && finite(input.allowed_min) != null
      ? Math.max(meta.allowed_min, finite(input.allowed_min)) : meta.allowed_min
    const allowedMax = meta.type === 'number' && finite(input.allowed_max) != null
      ? Math.min(meta.allowed_max, finite(input.allowed_max)) : meta.allowed_max
    const lockedValue = input.locked_value === null || input.locked_value === undefined
      ? null : normalizeValue(key, input.locked_value)
    let effectiveMin = allowedMin, effectiveMax = allowedMax
    if (meta.type === 'number' && meta.safety_direction === 'lower') effectiveMax = Math.min(effectiveMax, Number(platformValues[key]))
    if (meta.type === 'number' && meta.safety_direction === 'higher') effectiveMin = Math.max(effectiveMin, Number(platformValues[key]))
    return [key, {
      default_value: input.default_value === undefined ? meta.default_value : normalizeValue(key, input.default_value),
      allowed_min: effectiveMin, allowed_max: effectiveMax, locked_value: lockedValue,
      user_editable: meta.locked || !meta.configurable || !meta.user_editable ? false : input.user_editable !== false,
    }]
  }))
}

function applyAccountConfig(base, rawConfig, controls) {
  const values = rawConfig?.values || rawConfig || {}
  const result = { ...base }
  for (const [key, meta] of Object.entries(RISK_RULES)) {
    const control = controls[key]
    if (control.locked_value !== null && control.locked_value !== undefined) {
      result[key] = control.locked_value
      continue
    }
    if (!control.user_editable || values[key] === undefined) continue
    let value = normalizeValue(key, values[key])
    if (value === undefined) continue
    if (meta.type === 'number') value = Math.min(control.allowed_max, Math.max(control.allowed_min, value))
    if (meta.type === 'set' && !result[key].includes('*')) value = value.filter(item => result[key].includes(item))
    result[key] = stricter(key, result[key], value)
  }
  result.require_stop_loss = true
  return result
}

function stricter(key, base, candidate) {
  const direction = RISK_RULES[key]?.safety_direction
  if (candidate === undefined) return base
  if (direction === 'lower') return Math.min(Number(base), Number(candidate))
  if (direction === 'higher') return Math.max(Number(base), Number(candidate))
  if (direction === 'subset') return base.includes('*') ? candidate : candidate.filter(item => base.includes(item))
  return base
}

export function isRelaxation(key, oldValue, newValue) {
  const meta = RISK_RULES[key]
  if (!meta) throw new Error(`unknown_risk_field:${key}`)
  if (meta.locked || meta.safety_direction.startsWith('locked')) return false
  if (meta.safety_direction === 'lower') return Number(newValue) > Number(oldValue)
  if (meta.safety_direction === 'higher') return Number(newValue) < Number(oldValue)
  if (meta.safety_direction === 'subset') {
    if ((oldValue || []).includes('*')) return false
    if ((newValue || []).includes('*')) return true
    const oldSet = new Set(oldValue || [])
    return (newValue || []).some(value => !oldSet.has(value))
  }
  return false
}

export function normalizePlatformRiskConfig({ currentValues = {}, currentControls = {}, valueChanges = {}, controlChanges = {} } = {}) {
  const values = mergeKnown(DEFAULT_RISK_POLICY, currentValues)
  for (const [key, raw] of Object.entries(valueChanges || {})) {
    const meta = RISK_RULES[key]
    if (!meta) throw new Error(`unknown_risk_field:${key}`)
    if (!meta.configurable) throw new Error(`risk_field_not_configurable:${key}`)
    const value = normalizeValue(key, raw)
    if (value === undefined || (meta.type === 'number' && Number(value) !== Number(raw))) throw new Error(`invalid_risk_value:${key}`)
    values[key] = value
  }
  const controls = { ...(currentControls || {}) }
  for (const [key, input] of Object.entries(controlChanges || {})) {
    const meta = RISK_RULES[key]
    if (!meta) throw new Error(`unknown_risk_field:${key}`)
    if (meta.type !== 'number' || !meta.configurable || !meta.user_editable) throw new Error(`risk_field_not_user_configurable:${key}`)
    let min = Number(input.allowed_min ?? meta.allowed_min)
    let max = Number(input.allowed_max ?? meta.allowed_max)
    if (!Number.isFinite(min) || !Number.isFinite(max) || min < meta.allowed_min || max > meta.allowed_max || min > max) throw new Error(`invalid_global_risk_range:${key}`)
    if (meta.safety_direction === 'lower') max = Math.min(max, Number(values[key]))
    if (meta.safety_direction === 'higher') min = Math.max(min, Number(values[key]))
    let locked = input.locked_value
    if (locked !== null && locked !== undefined && locked !== '') {
      locked = Number(locked)
      if (!Number.isFinite(locked) || locked < min || locked > max) throw new Error(`invalid_global_risk_lock:${key}`)
    } else locked = null
    controls[key] = { allowed_min:min, allowed_max:max, locked_value:locked, user_editable:input.user_editable !== false }
  }
  if (Number(values.max_position_size) <= 0 || Number(values.max_risk_per_trade_pct) <= 0) throw new Error('invalid_global_risk_core_limits')
  return { values, controls }
}

export async function resolveEffectiveRiskPolicy({ userId, tradingAccountId = null, riskProfileId = null, legacyConfig = {}, now = beijingNow() } = {}) {
  const platform = await queryOne("SELECT * FROM risk_policy_sets WHERE scope = 'platform' AND status = 'active' ORDER BY id ASC LIMIT 1")
  const account = tradingAccountId
    ? await queryOne("SELECT * FROM risk_policy_sets WHERE scope = 'account' AND owner_user_id = ? AND trading_account_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1", [userId, tradingAccountId])
    : await queryOne("SELECT * FROM risk_policy_sets WHERE scope = 'account' AND owner_user_id = ? AND trading_account_id IS NULL AND status = 'active' ORDER BY id DESC LIMIT 1", [userId])
  let policy = { ...DEFAULT_RISK_POLICY }
  const policyVersionIds = []
  let platformRaw = {}, controls = buildPlatformControls(), platformPolicy = { ...policy }, accountValues = {}
  if (platform) {
    const version = await queryOne('SELECT * FROM risk_policy_versions WHERE policy_set_id = ? AND effective_at <= ? ORDER BY version_no DESC LIMIT 1', [platform.id, now])
    if (version) {
      platformRaw = parseJson(version.config_json)
      policy = mergeKnown(policy, platformRaw.values || platformRaw.defaults || platformRaw)
      controls = buildPlatformControls(platformRaw)
      policyVersionIds.push(version.id)
    }
  }
  platformPolicy = { ...policy }
  if (account) {
    const version = await queryOne('SELECT * FROM risk_policy_versions WHERE policy_set_id = ? AND effective_at <= ? ORDER BY version_no DESC LIMIT 1', [account.id, now])
    if (version) {
      accountValues = parseJson(version.config_json)
      policy = applyAccountConfig(policy, accountValues, controls)
      policyVersionIds.push(version.id)
    }
  }
  for (const [key, control] of Object.entries(controls)) {
    if (control.locked_value !== null && control.locked_value !== undefined) policy[key] = control.locked_value
  }
  policy.max_position_size = Math.min(policy.max_position_size, finite(legacyConfig.max_position_size) || policy.max_position_size)
  if (riskProfileId) {
    const profile = await queryOne("SELECT * FROM risk_profiles WHERE id = ? AND user_id = ? AND status = 'active' AND deleted_at IS NULL", [riskProfileId, userId])
    if (!profile) throw new Error('risk_profile_not_found')
    const profileConfig = mergeKnown({}, parseJson(profile.config_json))
    for (const [key, value] of Object.entries(profileConfig)) policy[key] = stricter(key, policy[key], value)
  }
  return { policy, policyVersionIds, platformPolicy, accountValues: accountValues.values || accountValues, controls }
}

export async function submitRiskPolicyChanges({ policySetId, actorId, changes, reason = '' } = {}) {
  if (!policySetId || !actorId || !changes || typeof changes !== 'object') throw new Error('invalid_risk_policy_change')
  return withTransaction(async run => {
    const [[set]] = await run("SELECT * FROM risk_policy_sets WHERE id = ? AND status = 'active' FOR UPDATE", [policySetId])
    if (!set) throw new Error('risk_policy_set_not_found')
    const [[current]] = await run('SELECT * FROM risk_policy_versions WHERE policy_set_id = ? AND effective_at <= NOW() ORDER BY version_no DESC LIMIT 1', [policySetId])
    const currentRaw = parseJson(current?.config_json)
    const currentConfig = currentRaw.values || currentRaw.defaults || currentRaw
    let platformPolicy = { ...DEFAULT_RISK_POLICY }, platformControls = buildPlatformControls()
    if (set.scope === 'account') {
      const [[platformSet]] = await run("SELECT * FROM risk_policy_sets WHERE scope = 'platform' AND status = 'active' ORDER BY id ASC LIMIT 1")
      if (platformSet) {
        const [[platformVersion]] = await run('SELECT * FROM risk_policy_versions WHERE policy_set_id = ? AND effective_at <= NOW() ORDER BY version_no DESC LIMIT 1', [platformSet.id])
        const platformRaw = parseJson(platformVersion?.config_json)
        platformPolicy = mergeKnown(platformPolicy, platformRaw.values || platformRaw.defaults || platformRaw)
        platformControls = buildPlatformControls(platformRaw)
      }
    }
    const applied = {}, removals = new Set(), auditItems = []
    for (const [key, raw] of Object.entries(changes)) {
      const meta = RISK_RULES[key]
      if (!meta) throw new Error(`unknown_risk_field:${key}`)
      if (meta.locked || !meta.configurable || !meta.user_editable) throw new Error(`risk_field_locked:${key}`)
      if (set.scope === 'account' && (raw === null || raw === '')) {
        removals.add(key)
        auditItems.push([key, null, 'inherit'])
        continue
      }
      const value = normalizeValue(key, raw)
      if (value === undefined || (meta.type === 'number' && Number(value) !== Number(raw))) throw new Error(`invalid_risk_value:${key}`)
      if (set.scope === 'account') {
        const control = platformControls[key]
        if (!control?.user_editable || (meta.type === 'number' && (value < control.allowed_min || value > control.allowed_max))
          || stricter(key, platformPolicy[key], value) !== value) throw new Error(`risk_relaxation_not_allowed:${key}`)
      }
      applied[key] = value
      const prior = currentConfig[key] ?? platformPolicy[key] ?? DEFAULT_RISK_POLICY[key]
      auditItems.push([key, value, isRelaxation(key, prior, value) ? 'relax' : 'tighten'])
    }
    const changedFields = [...new Set([...Object.keys(applied), ...removals])]
    let versionId = current?.id || null
    if (changedFields.length) {
      const now = beijingNow()
      const next = { ...currentConfig, ...applied }
      for (const key of removals) delete next[key]
      const [insert] = await run('INSERT INTO risk_policy_versions (policy_set_id, version_no, config_json, created_by, change_reason, effective_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [policySetId, Number(current?.version_no || 0) + 1, JSON.stringify(next), actorId, reason, now, now])
      versionId = insert.insertId
      await run('UPDATE risk_policy_sets SET active_version_id = ?, updated_at = ? WHERE id = ?', [versionId, now, policySetId])
      for (const [key, value, changeClass] of auditItems) {
        await run(`INSERT INTO risk_policy_change_items
          (policy_set_id, field_code, old_value_json, new_value_json, change_class, status, requested_by, reason, effective_at, created_at)
          VALUES (?, ?, ?, ?, ?, 'applied', ?, ?, ?, ?)`,
        [policySetId, key, JSON.stringify(currentConfig[key] ?? null), JSON.stringify(value ?? null), changeClass, actorId, reason, now, now])
      }
    }
    const appliedFields = changedFields
    return { active_version_id: versionId, applied_fields: appliedFields, immediate_fields: appliedFields, pending_fields: [] }
  })
}

const floorStep = (value, step) => Number((Math.floor((value + 1e-12) / step) * step).toFixed(8))
const aligned = (value, step, origin = 0) => Math.abs((value - origin) / step - Math.round((value - origin) / step)) < 1e-7
const pass = (rules, code, details = {}) => rules.push({ code, outcome: 'pass', details })
const rejection = (rules, code, details = {}) => ({ decision_status: 'reject', reject_code: code, rule_results: [...rules, { code, outcome: 'reject', details }] })
const quoteEpoch = value => {
  if (typeof value === 'number') return value > 1e12 ? value : value * 1000
  const text = String(value || '')
  const parsed = Date.parse(text.replace(' ', 'T') + (/[zZ]|[+-]\d\d:\d\d$/.test(text) ? '' : '+08:00'))
  return Number.isFinite(parsed) ? parsed : null
}
const DEFAULT_MT5_TIMEZONE_OFFSET_MINUTES = 180

function mt5TimezoneOffsetMinutes(value) {
  if (value === null || value === undefined || value === '') return DEFAULT_MT5_TIMEZONE_OFFSET_MINUTES
  const offset = Number(value)
  return Number.isFinite(offset) && offset >= -720 && offset <= 840
    ? Math.trunc(offset) : DEFAULT_MT5_TIMEZONE_OFFSET_MINUTES
}

export function weekendProtectionState(nowMs, minutes, timezoneOffsetMinutes = DEFAULT_MT5_TIMEZONE_OFFSET_MINUTES) {
  const offsetMinutes = mt5TimezoneOffsetMinutes(timezoneOffsetMinutes)
  const date = new Date(nowMs + offsetMinutes * 60_000)
  const day = date.getUTCDay()
  const minute = day * 1440 + date.getUTCHours() * 60 + date.getUTCMinutes()
  const protectedNow = day === 0 || day === 6 || minute >= 6 * 1440 - minutes
  return {
    protected:protectedNow,
    timezone_offset_minutes:offsetMinutes,
    mt5_weekday:day,
    mt5_time:`${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}`,
    close_advance_minutes:Number(minutes),
  }
}

export function evaluateCoreRisk({ request, account, quote, instrument, brokerCalculation = null, policy = DEFAULT_RISK_POLICY, ruleModes = {}, nowMs = Date.now() }) {
  const original = structuredClone(request || {}), approved = structuredClone(request || {}), rules = []
  const fail = (code, details) => ({ ...rejection(rules, code, details), original_order: original })
  const rolloutReject = (code, details = {}) => {
    if (riskRuleIsEnforced(code, ruleModes)) return fail(code, details)
    rules.push({ code, outcome: 'shadow_reject', details })
    return null
  }
  const symbol = String(approved.symbol || '').toUpperCase(), side = String(approved.order_type || '').toLowerCase()
  const method = String(approved.entry_method || 'market').toLowerCase(), ai = approved.source === 'ai'
  if (!symbol) return fail('R5_SCHEMA_SYMBOL')
  if (!['buy', 'sell'].includes(side)) return fail('R5_SCHEMA_ORDER_TYPE')
  if (!['market', 'limit', 'stop', 'stop_limit'].includes(method)) return fail('R5_SCHEMA_ENTRY_METHOD', { entry_method: method })
  if (ai) {
    const expected = method === 'market' ? side : `${side}_${method}`
    if (String(approved.signal_type || '').toLowerCase() !== expected || !Number.isFinite(Number(approved.volume)) || !(finite(approved.reference_price) > 0)) return fail('R5_SCHEMA_AI_REQUIRED')
    if (method !== 'market' && !(finite(approved.limit_price) > 0)) return fail('R5_SCHEMA_PENDING_PRICE')
    if (method === 'stop_limit' && !(finite(approved.stop_limit_price) > 0)) return fail('R5_SCHEMA_STOP_LIMIT_PRICE')
  }
  pass(rules, 'R5_SCHEMA')
  const standard = stripBrokerSuffix(symbol)
  if (!policy.allowed_symbols.includes('*') && !policy.allowed_symbols.includes(symbol) && !policy.allowed_symbols.includes(standard)) {
    const rejected = rolloutReject('R1.1_SYMBOL_NOT_ALLOWED', { symbol }); if (rejected) return rejected
  }
  const needed = ['tick_value', 'tick_size', 'contract_size', 'volume_min', 'volume_max', 'volume_step', 'digits', 'point', 'trade_mode']
  const missing = needed.filter(key => !Number.isFinite(Number(instrument?.[key])))
  if (missing.length) return fail('R1_INSTRUMENT_DATA_INCOMPLETE', { missing })
  if (Number(instrument.trade_mode) === 0) return fail('R1_SYMBOL_TRADE_DISABLED')
  const bid = finite(quote?.bid), ask = finite(quote?.ask), entry = method === 'market' ? (side === 'buy' ? ask : bid) : finite(approved.limit_price)
  if (!(entry > 0)) return fail('R4_QUOTE_INVALID')
  const sl = finite(approved.sl), tp = finite(approved.tp)
  if (policy.require_stop_loss && !(sl > 0)) return fail('R1.2_STOP_LOSS_REQUIRED')
  if (!(tp > 0)) return fail('R1.5_TAKE_PROFIT_REQUIRED')
  if ((side === 'buy' && !(sl < entry && tp > entry)) || (side === 'sell' && !(sl > entry && tp < entry))) return fail('R1.6_SL_TP_DIRECTION', { entry, sl, tp })
  const atr = finite(approved.atr_anchor)
  if (!(atr > 0)) return fail('R1_ATR_REQUIRED')
  let volume = finite(approved.volume)
  if (!(volume > 0)) return fail('R1.9_VOLUME_INVALID')
  const brokerMinVolume = Number(instrument.volume_min), brokerMaxVolume = Number(instrument.volume_max), brokerVolumeStep = Number(instrument.volume_step)
  if (volume < brokerMinVolume || volume > brokerMaxVolume || !aligned(volume, brokerVolumeStep, brokerMinVolume)) {
    return fail('R1.9_AI_VOLUME_OUT_OF_RANGE', { volume, minimum:brokerMinVolume, maximum:brokerMaxVolume, step:brokerVolumeStep, source:'mt5_symbol' })
  }
  let adjusted = false
  // The gate must not move an AI stop loss because that changes the trading
  // thesis. Broker minimum stop distance remains an execution-layer check.
  const finalDistance = Math.abs(entry - Number(approved.sl))
  if (finalDistance > atr * policy.sl_atr_max + Number(instrument.tick_size)) {
    const rejected = rolloutReject('R1.4_STOP_LOSS_TOO_FAR'); if (rejected) return rejected
  }
  let effectiveTp = tp
  let rr = Math.abs(effectiveTp - entry) / finalDistance
  if (rr + 1e-9 < policy.min_rr) {
    // The model may provide TP1/TP2/TP3 while the user-selected tier is too
    // close after the final entry/SL calculation. Prefer the nearest existing
    // AI target that satisfies minimum R:R; never invent a target price.
    const candidates = (Array.isArray(approved.take_profit_candidates) ? approved.take_profit_candidates : [])
      .map(item => ({ tier: Number(item?.tier), price: finite(item?.price) }))
      .filter(item => [1, 2, 3].includes(item.tier) && item.price > 0
        && (side === 'buy' ? item.price > entry : item.price < entry))
      .map(item => ({ ...item, rr: Math.abs(item.price - entry) / finalDistance }))
      .filter(item => item.rr + 1e-9 >= policy.min_rr)
      .sort((a, b) => Math.abs(a.price - entry) - Math.abs(b.price - entry))
    if (candidates[0]) {
      const chosen = candidates[0]
      approved.tp = chosen.price
      approved.tp_tier_used = chosen.tier
      approved.tp_selection_source = 'risk_adjusted'
      effectiveTp = chosen.price
      rr = chosen.rr
      adjusted = true
      rules.push({ code: 'R1.5_TP_TIER_UPGRADED', outcome: 'adjust', details: {
        from_tp: tp, to_tp: chosen.price, from_tier: original.tp_tier_used ?? null,
        to_tier: chosen.tier, rr, minimum: policy.min_rr,
      } })
    } else {
      const rejected = rolloutReject('R1.5_RR_TOO_LOW', { rr, minimum: policy.min_rr }); if (rejected) return rejected
    }
  }
  volume = floorStep(Math.min(volume, policy.max_position_size, Number(instrument.volume_max)), Number(instrument.volume_step))
  const brokerVolume = finite(brokerCalculation?.volume)
  const brokerLoss = finite(brokerCalculation?.loss_to_sl)
  const brokerPriceTolerance = Math.max(Number(instrument.tick_size), Number(instrument.point)) + 1e-9
  const brokerCalculationMatches = brokerVolume > 0 && brokerLoss > 0
    && String(brokerCalculation?.symbol || '').toUpperCase() === symbol
    && String(brokerCalculation?.order_type || '').toLowerCase() === side
    && Math.abs(finite(brokerCalculation?.entry_price) - entry) <= brokerPriceTolerance
    && Math.abs(finite(brokerCalculation?.sl) - Number(approved.sl)) <= brokerPriceTolerance
  // MT5 order_calc_profit understands the broker's contract/currency rules.
  // Only reuse it when it describes the final approved entry and SL; if the
  // gate widened SL, the snapshot's calculation is stale and we fall back to
  // symbol tick metadata instead of understating risk.
  const calculationSource = brokerCalculationMatches ? 'mt5_order_calc_profit' : 'symbol_tick_metadata'
  const riskPerLot = brokerCalculationMatches
    ? brokerLoss / brokerVolume
    : finalDistance / Number(instrument.tick_size) * Number(instrument.tick_value)
  const equity = finite(account?.equity)
  if (!(equity > 0) || !(riskPerLot > 0)) return fail('R1.10_RISK_DATA_INVALID')
  const riskCap = equity * policy.max_risk_per_trade_pct / 100
  volume = floorStep(Math.min(volume, riskCap / riskPerLot), Number(instrument.volume_step))
  const minimumLot = Number(instrument.volume_min)
  if (volume + 1e-9 < minimumLot) return fail('R1.9_BELOW_MINIMUM_AFTER_RISK', { volume, minimum: minimumLot })
  if (volume > Number(original.volume) + 1e-9) return fail('R1.9_VOLUME_INCREASE_FORBIDDEN')
  if (volume !== Number(approved.volume)) adjusted = true
  approved.volume = volume
  pass(rules, 'R1.10_REAL_RISK', { risk_amount: Number((riskPerLot * volume).toFixed(8)), risk_cap: riskCap, calculation_source: calculationSource })
  if (method !== 'market') {
    const current = side === 'buy' ? ask : bid, deviation = Math.abs(entry - current)
    const maximum = Math.min(current * policy.pending_price_deviation_pct / 100, atr * policy.pending_price_deviation_atr)
    if (deviation > maximum + Number(instrument.tick_size)) {
      const rejected = rolloutReject('R1.7_PENDING_DEVIATION', { deviation, maximum }); if (rejected) return rejected
    }
    if ((method === 'limit' && ((side === 'buy' && entry >= current) || (side === 'sell' && entry <= current))) || (['stop', 'stop_limit'].includes(method) && ((side === 'buy' && entry <= current) || (side === 'sell' && entry >= current)))) return fail('R1.7_PENDING_DIRECTION', { entry_method: method, trigger_price: entry, current_price: current })
    if (method === 'stop_limit') {
      const stopLimit = finite(approved.stop_limit_price)
      if (!(stopLimit > 0) || (side === 'buy' ? stopLimit > entry : stopLimit < entry)) return fail('R1.7_STOP_LIMIT_RELATION', { side, trigger_price: entry, stop_limit_price: stopLimit })
    }
    if (!approved.pending_valid_until && !approved.pending_valid_minutes) {
      approved.pending_valid_minutes = policy.pending_valid_minutes; adjusted = true
      rules.push({ code: 'R1.8_PENDING_TTL_DEFAULT', outcome: 'default', details: { minutes: policy.pending_valid_minutes } })
    }
  } else if (ai && Math.abs(entry - Number(approved.reference_price)) > atr * policy.market_signal_drift_atr) {
    const rejected = rolloutReject('R4.6_MARKET_SIGNAL_DRIFT'); if (rejected) return rejected
  }
  const quoteTime = quoteEpoch(quote?.time_utc_msc ?? quote?.time_msc ?? quote?.time)
  const quoteAgeMs = quoteTime == null ? null : nowMs - quoteTime
  if (quoteTime == null || quoteAgeMs > policy.max_quote_age_seconds * 1000 || quoteAgeMs < -5000) {
    const rejected = rolloutReject('R4.4_QUOTE_STALE', {
      quote_time: quoteTime == null ? null : new Date(quoteTime).toISOString(),
      quote_age_seconds: quoteAgeMs == null ? null : Number((quoteAgeMs / 1000).toFixed(3)),
      maximum_seconds: policy.max_quote_age_seconds,
    }); if (rejected) return rejected
  }
  const spreadPoints = Math.abs(ask - bid) / Number(instrument.point)
  if (!Number.isFinite(spreadPoints) || spreadPoints > policy.max_spread_points) {
    const rejected = rolloutReject('R4.5_SPREAD_TOO_WIDE', { spread_points: spreadPoints }); if (rejected) return rejected
  }
  if (ai) {
    const signalTime = quoteEpoch(approved.signal_created_at)
    if (signalTime == null || nowMs - signalTime > policy.signal_ttl_seconds * 1000) {
      const rejected = rolloutReject('R4.3_SIGNAL_EXPIRED'); if (rejected) return rejected
    }
  }
  const weekendProtection = weekendProtectionState(nowMs, policy.weekend_close_minutes, quote?.timezone_offset_minutes)
  if (weekendProtection.protected) {
    const rejected = rolloutReject('R4.2_WEEKEND_PROTECTION', weekendProtection); if (rejected) return rejected
  }
  approved.deviation = Math.floor(policy.broker_slippage_points)
  pass(rules, 'PX.3_BROKER_SLIPPAGE', { points: approved.deviation })
  return { decision_status: adjusted ? 'adjust' : 'pass', reject_code: null, original_order: original, approved_order: approved, rule_results: rules, risk_amount: Number((riskPerLot * volume).toFixed(8)) }
}

export async function persistRiskDecision(intentId, decision, policyVersionIds = []) {
  const result = await queryRun(`INSERT INTO risk_decisions
    (order_intent_id, policy_version_ids_json, original_order_json, approved_order_json, rule_results_json, decision_status, reject_code, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)`,
  [intentId, JSON.stringify(policyVersionIds), JSON.stringify(decision.original_order || {}), decision.approved_order ? JSON.stringify(decision.approved_order) : null, JSON.stringify(decision.rule_results || []), decision.decision_status, decision.reject_code || null, beijingNow()])
  await queryRun('UPDATE order_intents SET risk_decision_id = ?, updated_at = ? WHERE id = ?', [result.insertId, beijingNow(), intentId])
  return result.insertId
}
