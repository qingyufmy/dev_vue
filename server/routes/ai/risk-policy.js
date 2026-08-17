// Versioned risk policy resolution and deterministic L1/L4/L5 core gate.

import { queryAll, queryOne, queryRun, withTransaction, beijingNow } from '../../db.js'
import { stripBrokerSuffix } from './utils.js'
import { riskRuleIsEnforced } from './rollout-governance.js'
import { normalizePositionSizeTier, positionSizeFactor } from './position-sizing.js'

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
  pending_valid_minutes: rule('R1.8', 'number', 'minute', 'lower', 180, 5, 1440, false, '挂单默认有效期', { unit_label:'分钟', description:'模型未指定时使用；策略可设置更短期限' }),
  max_position_size: rule('R1.9D', 'number', 'lot', 'lower', 0.05, 0.001, 5, false, '单笔最大手数', { unit_label:'手', description:'任何单笔订单都不能突破的平台手数上限' }),
  max_risk_per_trade_pct: rule('R1.10', 'number', 'percent', 'lower', 1, 0.01, 100, false, '单笔最大风险比例', { unit_label:'%', description:'按真实止损亏损金额占账户净值计算' }),
  signal_ttl_seconds: rule('R4.3', 'number', 'second', 'lower', 300, 5, 86400, false, '信号有效期', { unit_label:'秒', user_editable:false, category:'platform', description:'防止执行已经过时的 AI 信号' }),
  max_quote_age_seconds: rule('R4.4', 'number', 'second', 'lower', 15, 1, 300, false, '报价最大年龄', { unit_label:'秒', user_editable:false, category:'system', description:'使用桥接标准化后的 UTC 报价时间检查' }),
  max_spread_points: rule('R4.5', 'number', 'point', 'lower', 120, 1, 100000, false, '最大点差', { unit_label:'点', description:'超过该点差时不新增风险' }),
  max_execution_price_deviation_pct: rule('R4.6', 'number', 'percent', 'lower', 0.1, 0.001, 5, false, '最大执行价格偏差', { unit_label:'%', description:'以推理参考价为基准限制最终执行价格；系统会将剩余偏差预算换算为 MT5 点数' }),
  weekend_close_minutes: rule('R4.2', 'number', 'minute', 'higher', 60, 0, 2880, false, '周末收盘提前保护', { unit_label:'分钟', description:'在 MT5 周末收盘前提前停止新增风险' }),
  min_open_interval_seconds: rule('R2.2', 'number', 'second', 'higher', 30, 0, 86400, false, '最小开仓间隔', { unit_label:'秒', description:'限制账户连续新增仓位的最短间隔' }),
  max_daily_open_count: rule('R2.3', 'number', 'count', 'lower', 20, 1, 10000, false, '每日开仓次数', { unit_label:'次/日', description:'按 MT5 交易日统计成功开仓次数' }),
  dedup_window_seconds: rule('R2.4A', 'number', 'second', 'higher', 180, 0, 86400, false, '重复订单时间窗', { unit_label:'秒', user_editable:false, category:'system', description:'系统内部的第二层重复下单保护' }),
  dedup_price_atr: rule('R2.4B', 'number', 'ATR', 'higher', 0.05, 0, 5, false, '重复订单价格距离', { unit_label:'ATR 倍', user_editable:false, category:'system', description:'系统内部重复订单价格相似度' }),
  daily_loss_limit_pct: rule('R3.1', 'number', 'percent', 'lower', 3, 0.1, 100, false, '每日最大亏损', { unit_label:'%', description:'已实现净亏损加当前浮亏占日初净值的比例' }),
  consecutive_loss_limit: rule('R3.2A', 'number', 'count', 'lower', 3, 1, 100, false, '连续亏损次数', { unit_label:'笔', description:'按完整平仓持仓统计，不按成交明细重复计数' }),
  loss_cooldown_minutes: rule('R3.2B', 'number', 'minute', 'higher', 60, 1, 10080, false, '连续亏损冷却', { unit_label:'分钟', description:'达到连续亏损次数后暂停新增风险' }),
  max_drawdown_pct: rule('R3.3', 'number', 'percent', 'lower', 8, 0.1, 100, false, '最大回撤', { unit_label:'%', description:'经资金流校正后的净值高水位回撤' }),
})

export const DEFAULT_RISK_POLICY = Object.freeze(Object.fromEntries(Object.entries(RISK_RULES).map(([key, meta]) => [key, Array.isArray(meta.default_value) ? [...meta.default_value] : meta.default_value])))
export const DEFAULT_AI_VOLUME_STEP = 0.01

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

export function buildPlatformControls(rawConfig = {}) {
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
    if (!Object.hasOwn(configured, key) && meta.type === 'number' && meta.safety_direction === 'lower') {
      effectiveMax = Math.min(effectiveMax, Number(platformValues[key]))
    }
    if (!Object.hasOwn(configured, key) && meta.type === 'number' && meta.safety_direction === 'higher') {
      effectiveMin = Math.max(effectiveMin, Number(platformValues[key]))
    }
    return [key, {
      default_value: input.default_value === undefined ? meta.default_value : normalizeValue(key, input.default_value),
      allowed_min: effectiveMin, allowed_max: effectiveMax, locked_value: lockedValue,
      user_editable: meta.locked || !meta.configurable || !meta.user_editable ? false : input.user_editable !== false,
    }]
  }))
}

function applyPlatformControlBoundaries(base, controls) {
  const result = { ...base }
  for (const [key, meta] of Object.entries(RISK_RULES)) {
    const control = controls?.[key]
    if (!control) continue
    if (control.locked_value !== null && control.locked_value !== undefined) {
      result[key] = control.locked_value
      continue
    }
    if (meta.type !== 'number') continue
    const min = finite(control.allowed_min)
    const max = finite(control.allowed_max)
    if (min != null) result[key] = Math.max(min, Number(result[key]))
    if (max != null) result[key] = Math.min(max, Number(result[key]))
  }
  result.require_stop_loss = true
  return result
}

function applyAccountConfig(base, rawConfig, controls) {
  const values = rawConfig?.values || rawConfig || {}
  const result = applyPlatformControlBoundaries(base, controls)
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
    result[key] = value
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
    let locked = input.locked_value
    if (locked !== null && locked !== undefined && locked !== '') {
      locked = Number(locked)
      if (!Number.isFinite(locked) || locked < min || locked > max) throw new Error(`invalid_global_risk_lock:${key}`)
    } else locked = null
    controls[key] = { allowed_min:min, allowed_max:max, locked_value:locked, user_editable:input.user_editable !== false }
  }
  for (const [key, control] of Object.entries(controls)) {
    const meta = RISK_RULES[key]
    if (meta?.type !== 'number') continue
    values[key] = Math.min(control.allowed_max, Math.max(control.allowed_min, Number(values[key])))
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
  policy = applyPlatformControlBoundaries(policy, controls)
  platformPolicy = { ...policy }
  if (account) {
    const version = await queryOne('SELECT * FROM risk_policy_versions WHERE policy_set_id = ? AND effective_at <= ? ORDER BY version_no DESC LIMIT 1', [account.id, now])
    if (version) {
      accountValues = parseJson(version.config_json)
      policy = applyAccountConfig(policy, accountValues, controls)
      policyVersionIds.push(version.id)
    }
  }
  policy = applyPlatformControlBoundaries(policy, controls)
  if (riskProfileId) {
    const profile = await queryOne("SELECT * FROM risk_profiles WHERE id = ? AND user_id = ? AND status = 'active' AND deleted_at IS NULL", [riskProfileId, userId])
    if (!profile) throw new Error('risk_profile_not_found')
    const profileConfig = mergeKnown({}, parseJson(profile.config_json))
    for (const [key, value] of Object.entries(profileConfig)) policy[key] = stricter(key, policy[key], value)
  }
  return { policy, policyVersionIds, platformPolicy, accountValues: accountValues.values || accountValues, controls }
}

// Shared AI inference only receives the administrator-controlled recommendation
// range. Subscriber/account limits are resolved later by the deterministic gate.
export async function resolvePlatformAiVolumeRange() {
  const resolved = await resolveEffectiveRiskPolicy({ userId: 0 })
  const metadata = RISK_RULES.max_position_size
  const control = resolved.controls?.max_position_size || {}
  // The shared recommendation is broker-neutral. Keep the historical 0.01-lot
  // recommendation grid; subscriber-specific broker steps are applied later.
  const minimum = Math.max(DEFAULT_AI_VOLUME_STEP, Number(metadata.allowed_min), Number(control.allowed_min ?? metadata.allowed_min))
  const maximum = Math.min(Number(metadata.allowed_max), Number(control.allowed_max ?? metadata.allowed_max))
  return {
    min: Number(minimum.toFixed(8)),
    max: Number(Math.max(minimum, maximum).toFixed(8)),
    step: DEFAULT_AI_VOLUME_STEP,
  }
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
        platformPolicy = applyPlatformControlBoundaries(platformPolicy, platformControls)
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
        if (!control?.user_editable || (meta.type === 'number' && (value < control.allowed_min || value > control.allowed_max))) {
          throw new Error(`risk_relaxation_not_allowed:${key}`)
        }
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

// Volume values are decimal quantities supplied by the broker.  Do not use
// Math.round(value / step) here: a binary floating point value such as
// 0.065 / 0.01 can fall on the wrong side of the half-step boundary.  The
// broker lattice is `volume_min + n * volume_step`, so all arithmetic below
// is performed on decimal integer units instead.
const decimalParts = value => {
  const text = String(value).trim()
  const match = text.match(/^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/)
  if (!match) return null
  const sign = match[1] === '-' ? -1n : 1n
  const whole = match[2] || ''
  const fraction = match[3] ?? match[4] ?? ''
  const exponent = Number(match[5] || 0)
  if (!Number.isSafeInteger(exponent)) return null
  let scale = fraction.length - exponent
  let coefficient = BigInt(`${whole}${fraction}` || '0')
  if (scale < 0) {
    coefficient *= 10n ** BigInt(-scale)
    scale = 0
  }
  return { coefficient:sign * coefficient, scale }
}

const decimalGrid = (value, origin, step) => {
  const values = [decimalParts(value), decimalParts(origin), decimalParts(step)]
  if (values.some(item => !item)) return null
  const scale = Math.max(...values.map(item => item.scale))
  const units = values.map(item => item.coefficient * 10n ** BigInt(scale - item.scale))
  if (units[2] <= 0n) return null
  return { valueUnits:units[0], originUnits:units[1], stepUnits:units[2], scale }
}

const unitsToNumber = (units, scale) => Number(units) / 10 ** scale

export const roundStepHalfUp = (value, step, origin = 0) => {
  const grid = decimalGrid(value, origin, step)
  if (!grid) return Number.NaN
  const difference = grid.valueUnits - grid.originUnits
  if (difference <= 0n) return unitsToNumber(grid.originUnits, grid.scale)
  let index = difference / grid.stepUnits
  if (difference % grid.stepUnits * 2n >= grid.stepUnits) index += 1n
  return unitsToNumber(grid.originUnits + index * grid.stepUnits, grid.scale)
}

const floorVolumeOnLattice = (value, volumeMin, volumeStep) => {
  const grid = decimalGrid(value, volumeMin, volumeStep)
  if (!grid) return Number.NaN
  const difference = grid.valueUnits - grid.originUnits
  if (difference < 0n) return 0
  const index = difference / grid.stepUnits
  return unitsToNumber(grid.originUnits + index * grid.stepUnits, grid.scale)
}

const stepDownVolume = (value, volumeMin, volumeStep) => {
  const grid = decimalGrid(value, volumeMin, volumeStep)
  if (!grid) return Number.NaN
  const difference = grid.valueUnits - grid.originUnits
  const index = difference > 0n ? difference / grid.stepUnits : 0n
  return unitsToNumber(grid.originUnits + (index - 1n) * grid.stepUnits, grid.scale)
}

const aligned = (value, step, origin = 0) => {
  const grid = decimalGrid(value, origin, step)
  if (!grid) return false
  const difference = grid.valueUnits - grid.originUnits
  return difference >= 0n && difference % grid.stepUnits === 0n
}
const pass = (rules, code, details = {}) => rules.push({ code, outcome: 'pass', details })
const rejection = (rules, code, details = {}) => ({ decision_status: 'reject', reject_code: code, rule_results: [...rules, { code, outcome: 'reject', details }] })
const quoteEpoch = value => {
  if (typeof value === 'number') return value > 1e12 ? value : value * 1000
  const text = String(value || '')
  if (!/[zZ]|[+-]\d\d:?\d\d$/.test(text)) return null
  const parsed = Date.parse(text.replace(' ', 'T'))
  return Number.isFinite(parsed) ? parsed : null
}
function mt5TimezoneOffsetMinutes(value) {
  if (value === null || value === undefined || value === '') return null
  const offset = Number(value)
  return Number.isInteger(offset) && offset >= -720 && offset <= 840
    ? offset : null
}

export function weekendProtectionState(nowMs, minutes, timezoneOffsetMinutes = null, clockStatus = '') {
  const offsetMinutes = mt5TimezoneOffsetMinutes(timezoneOffsetMinutes)
  const normalizedStatus = String(clockStatus || '').trim().toLowerCase()
  if (offsetMinutes == null || !normalizedStatus
    || ['unknown', 'unavailable', 'unverified', 'calibrating', 'fallback'].includes(normalizedStatus)) {
    return {
      protected:true, clock_unverified:true, timezone_offset_minutes:null,
      mt5_weekday:null, mt5_time:null, close_advance_minutes:Number(minutes),
    }
  }
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
  const instrumentValidationStatus = String(instrument?.instrument_validation_status || '').trim().toLowerCase() || null
  if (['ambiguous', 'invalid', 'inconsistent'].includes(instrumentValidationStatus)) {
    const rawCandidates = {
      tick_size_raw_marketinfo: instrument?.tick_size_raw_marketinfo ?? null,
      tick_size_marketinfo_price_candidate: instrument?.tick_size_marketinfo_price_candidate ?? null,
      tick_size_symbolinfo_candidate: instrument?.tick_size_symbolinfo_candidate ?? null,
    }
    return fail('R1_INSTRUMENT_DATA_INCONSISTENT', {
      instrument_validation_status:instrumentValidationStatus,
      tick_size:finite(instrument?.tick_size),
      tick_value:finite(instrument?.tick_value),
      point:finite(instrument?.point),
      contract_size:finite(instrument?.contract_size),
      tick_size_source:String(instrument?.tick_size_source || '').trim() || null,
      instrument_validation_reasons:Array.isArray(instrument?.instrument_validation_reasons)
        ? instrument.instrument_validation_reasons : [],
      raw_candidates:rawCandidates,
      ...rawCandidates,
    })
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
  const brokerMinVolume = Number(instrument.volume_min), brokerMaxVolume = Number(instrument.volume_max), brokerVolumeStep = Number(instrument.volume_step)
  const hasTierSizing = ai && approved.position_size_tier !== null && approved.position_size_tier !== undefined && approved.position_size_tier !== ''
  const normalizedTier = hasTierSizing ? normalizePositionSizeTier(approved.position_size_tier, approved.signal_type) : null
  if (hasTierSizing && !normalizedTier) return fail('R5_SCHEMA_AI_POSITION_SIZE_TIER', { position_size_tier:approved.position_size_tier })
  let volume = hasTierSizing
    ? floorVolumeOnLattice(Math.min(Number(policy.max_position_size), brokerMaxVolume), brokerMinVolume, brokerVolumeStep)
    : finite(approved.volume)
  if (!(volume > 0)) return fail('R1.9_VOLUME_INVALID')
  if (volume < brokerMinVolume || volume > brokerMaxVolume || !aligned(volume, brokerVolumeStep, brokerMinVolume)) {
    return fail('R1.9_AI_VOLUME_OUT_OF_RANGE', { volume, minimum:brokerMinVolume, maximum:brokerMaxVolume, step:brokerVolumeStep, source:'mt5_symbol' })
  }
  approved.volume = volume
  let adjusted = false
  // The gate must not move an AI stop loss because that changes the trading
  // thesis. Broker minimum stop distance remains an execution-layer check.
  const finalDistance = Math.abs(entry - Number(approved.sl))
  volume = floorVolumeOnLattice(Math.min(volume, policy.max_position_size, Number(instrument.volume_max)), brokerMinVolume, brokerVolumeStep)
  const brokerVolume = finite(brokerCalculation?.volume)
  const brokerLoss = finite(brokerCalculation?.loss_to_sl)
  const brokerPriceTolerance = Math.max(Number(instrument.tick_size), Number(instrument.point)) + 1e-9
  const brokerCalculationMatches = brokerVolume > 0 && brokerLoss > 0
    && String(brokerCalculation?.symbol || '').toUpperCase() === symbol
    && String(brokerCalculation?.order_type || '').toLowerCase() === side
    && Math.abs(finite(brokerCalculation?.entry_price) - entry) <= brokerPriceTolerance
    && Math.abs(finite(brokerCalculation?.sl) - Number(approved.sl)) <= brokerPriceTolerance
  // MT5 order_calc_profit understands the broker's contract/currency rules.
  // Only reuse it when it describes the final approved entry and SL. If any
  // approved price differs from the provisional snapshot request, fall back
  // to symbol tick metadata instead of understating risk.
  const calculationSource = brokerCalculationMatches ? 'mt5_order_calc_profit' : 'symbol_tick_metadata'
  const riskPerLot = brokerCalculationMatches
    ? brokerLoss / brokerVolume
    : finalDistance / Number(instrument.tick_size) * Number(instrument.tick_value)
  const equity = finite(account?.equity)
  if (!(equity > 0) || !(riskPerLot > 0)) return fail('R1.10_RISK_DATA_INVALID')
  const requestedRiskFactor = approved.position_size_factor === null || approved.position_size_factor === undefined || approved.position_size_factor === ''
    ? null
    : finite(approved.position_size_factor)
  const resolvedPositionSizeFactor = normalizedTier
    ? positionSizeFactor(normalizedTier)
    : ai
      ? Math.max(0.25, Math.min(1, requestedRiskFactor == null ? 1 : requestedRiskFactor))
    : 1
  approved.position_size_tier = normalizedTier || approved.position_size_tier || null
  approved.position_size_factor = resolvedPositionSizeFactor
  const fullRiskCap = equity * policy.max_risk_per_trade_pct / 100
  const riskCap = fullRiskCap * resolvedPositionSizeFactor
  const riskBasedVolume = riskCap / riskPerLot
  const cappedVolumeBeforeRounding = Math.min(volume, riskBasedVolume)
  const roundedVolumeCandidate = roundStepHalfUp(cappedVolumeBeforeRounding, brokerVolumeStep, brokerMinVolume)
  const roundedRiskAmount = riskPerLot * roundedVolumeCandidate
  const requestedVolumeLimit = hasTierSizing ? null : Number(original.volume)
  const roundedVolumeExceedsRequest = requestedVolumeLimit != null
    && roundedVolumeCandidate > requestedVolumeLimit + 1e-9
  const roundingGuardApplied = roundedRiskAmount > riskCap + 1e-9 || roundedVolumeExceedsRequest
  volume = roundingGuardApplied
    ? stepDownVolume(roundedVolumeCandidate, brokerMinVolume, brokerVolumeStep)
    : roundedVolumeCandidate
  const approvedRiskAmount = riskPerLot * volume
  const roundingDetails = {
    theoretical_volume:Number(riskBasedVolume.toFixed(8)),
    capped_volume_before_rounding:Number(cappedVolumeBeforeRounding.toFixed(8)),
    // Keep the old audit key for readers written before the rounding change.
    capped_volume_before_step:Number(cappedVolumeBeforeRounding.toFixed(8)),
    rounded_volume_candidate:Number(roundedVolumeCandidate.toFixed(8)),
    approved_volume:Number(volume.toFixed(8)),
    rounding_mode:'half_up',
    rounding_step:brokerVolumeStep,
    rounding_guard_applied:roundingGuardApplied,
    rounded_risk_amount:Number(roundedRiskAmount.toFixed(8)),
    instrument_validation_status:instrumentValidationStatus,
    tick_size_source:String(instrument?.tick_size_source || '').trim() || null,
  }
  const minimumLot = Number(instrument.volume_min)
  if (volume + 1e-9 < minimumLot) return fail('R1.9_BELOW_MINIMUM_AFTER_RISK', {
    volume,
    ...roundingDetails,
    minimum:minimumLot,
    step:Number(instrument.volume_step),
    equity,
    max_risk_per_trade_pct:Number(policy.max_risk_per_trade_pct),
    full_risk_cap:Number(fullRiskCap.toFixed(8)),
    risk_cap:Number(riskCap.toFixed(8)),
    risk_per_lot:Number(riskPerLot.toFixed(8)),
    minimum_lot_risk:Number((riskPerLot * minimumLot).toFixed(8)),
    minimum_lot_risk_pct:Number((riskPerLot * minimumLot / equity * 100).toFixed(8)),
    position_size_factor:resolvedPositionSizeFactor,
    position_size_tier:approved.position_size_tier || null,
    calculation_source:calculationSource,
  })
  if (!hasTierSizing && volume > Number(original.volume) + 1e-9) return fail('R1.9_VOLUME_INCREASE_FORBIDDEN', roundingDetails)
  if (volume !== Number(approved.volume)) adjusted = true
  approved.volume = volume
  pass(rules, 'R1.10_REAL_RISK', {
    ...roundingDetails,
    risk_amount: Number(approvedRiskAmount.toFixed(8)), risk_cap: riskCap,
    full_risk_cap: fullRiskCap, position_size_factor:resolvedPositionSizeFactor,
    position_size_tier:approved.position_size_tier || null,
    position_limit_lots:Number(policy.max_position_size),
    calculation_source: calculationSource,
  })
  if (method !== 'market') {
    const current = side === 'buy' ? ask : bid
    const pendingRatio = entry / current
    if (!Number.isFinite(pendingRatio) || pendingRatio < 0.5 || pendingRatio > 1.5) {
      return fail('R1.7_PENDING_PRICE_ABNORMAL', { trigger_price:entry, current_price:current, sanity_range_pct:50 })
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
  const weekendProtection = weekendProtectionState(
    nowMs, policy.weekend_close_minutes,
    quote?.timezone_offset_minutes, quote?.clock_status)
  if (weekendProtection.protected) {
    const rejected = rolloutReject('R4.2_WEEKEND_PROTECTION', weekendProtection); if (rejected) return rejected
  }
  const deviationReference = method === 'market'
    ? (finite(approved.reference_price) > 0 ? finite(approved.reference_price) : entry)
    : entry
  const deviationBudget = deviationReference * Number(policy.max_execution_price_deviation_pct) / 100
  const deviationUsed = method === 'market' ? Math.abs(entry - deviationReference) : 0
  if (method === 'market' && deviationUsed > deviationBudget + 1e-9) {
    const rejected = rolloutReject('R4.6_EXECUTION_PRICE_DEVIATION', {
      reference_price:deviationReference, current_price:entry,
      allowed_min:deviationReference - deviationBudget, allowed_max:deviationReference + deviationBudget,
      deviation_price:deviationUsed, maximum_pct:Number(policy.max_execution_price_deviation_pct),
    }); if (rejected) return rejected
  }
  const remainingDeviation = Math.max(0, deviationBudget - deviationUsed)
  approved.deviation = Math.max(0, Math.floor((remainingDeviation + Number(instrument.point) * 1e-9) / Number(instrument.point)))
  pass(rules, 'PX.3_EXECUTION_PRICE_TOLERANCE', {
    reference_price:deviationReference, current_price:entry,
    allowed_min:deviationReference - deviationBudget, allowed_max:deviationReference + deviationBudget,
    maximum_pct:Number(policy.max_execution_price_deviation_pct), used_price:deviationUsed,
    remaining_price:remainingDeviation, mt5_points:approved.deviation,
  })
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
