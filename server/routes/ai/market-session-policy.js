import crypto from 'node:crypto'

export const MARKET_SESSION_POLICY_SCHEMA_VERSION = 'market-session-policy-v1'
export const MARKET_SESSION_POLICY_ENGINE_VERSION = 'market-session-policy-engine-v1'
export const MARKET_SESSION_POLICY_MODE_ENV = 'AI_MARKET_SESSION_POLICY_MODE'
export const MARKET_SESSION_POLICIES_ENV = 'AI_MARKET_SESSION_POLICIES_JSON'

const MODES = new Set(['off', 'audit', 'enforce'])
const PLATFORMS = new Set(['mt4', 'mt5'])
const OFFSET_MINUTES_MIN = -14 * 60
const OFFSET_MINUTES_MAX = 14 * 60
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const TIME_RE = /^(\d{2}):(\d{2})(?::(\d{2}))?$/

export class MarketSessionPolicyValidationError extends Error {
  constructor(code, path, message = code) {
    super(message)
    this.name = 'MarketSessionPolicyValidationError'
    this.code = code
    this.path = path
  }
}

function fail(code, path, message = code) {
  throw new MarketSessionPolicyValidationError(code, path, message)
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]))
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const child of Object.values(value)) deepFreeze(child)
  return value
}

export function canonicalPolicyJson(value) {
  return JSON.stringify(canonicalize(value))
}

export function hashMarketSessionPolicy(value) {
  const input = value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'policy_hash')) : value
  return crypto.createHash('sha256').update(canonicalPolicyJson(input), 'utf8').digest('hex')
}

function normalizeMode(value) {
  const mode = String(value ?? 'off').trim().toLowerCase() || 'off'
  if (!MODES.has(mode)) fail('market_session_policy_mode_invalid', MARKET_SESSION_POLICY_MODE_ENV,
    `Unsupported market session policy mode: ${mode}`)
  return mode
}

function normalizeString(value, path, { upper = false, lower = false, max = 255 } = {}) {
  const result = String(value ?? '').trim()
  if (!result || result.length > max || result === '*' || result.includes('*')) {
    fail('market_session_policy_string_invalid', path)
  }
  if (upper) return result.toUpperCase()
  if (lower) return result.toLowerCase()
  return result
}

function normalizePositiveInteger(value, path) {
  const number = Number(value)
  if (!Number.isInteger(number) || number <= 0) fail('market_session_policy_version_invalid', path)
  return number
}

function normalizeMinutes(value, path) {
  const match = String(value ?? '').trim().match(TIME_RE)
  if (!match) fail('market_session_policy_time_invalid', path)
  const hours = Number(match[1])
  const minutes = Number(match[2])
  const seconds = Number(match[3] || 0)
  if (hours > 23 || minutes > 59 || seconds > 59) fail('market_session_policy_time_invalid', path)
  // Session rules are bar-open rules.  Reject seconds so a policy cannot
  // accidentally cover only part of a minute-bar interval.
  if (seconds !== 0) fail('market_session_policy_time_granularity_invalid', path)
  return hours * 60 + minutes
}

function normalizeWeekdays(value, path, { required = true } = {}) {
  if (value == null && !required) return null
  if (!Array.isArray(value) || !value.length) {
    if (!required) return null
    fail('market_session_policy_weekdays_invalid', path)
  }
  const days = [...new Set(value.map(item => Number(item) === 0 ? 7 : Number(item)))]
  if (days.some(day => !Number.isInteger(day) || day < 1 || day > 7)) {
    fail('market_session_policy_weekdays_invalid', path)
  }
  return days.sort((left, right) => left - right)
}

function normalizeReason(value, fallback, path) {
  const reason = String(value || fallback).trim().toLowerCase()
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(reason)) fail('market_session_policy_reason_invalid', path)
  return reason
}

function normalizeClosureRule(raw, path, kind, { weekdaysRequired = false } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('market_session_policy_closure_invalid', path)
  const from = normalizeMinutes(raw.from, `${path}.from`)
  const to = normalizeMinutes(raw.to, `${path}.to`)
  if (from === to) fail('market_session_policy_closure_range_invalid', path)
  const weekdays = normalizeWeekdays(raw.weekdays ?? raw.days, `${path}.weekdays`, { required:weekdaysRequired })
  const id = raw.id == null ? null : normalizeString(raw.id, `${path}.id`, { lower:true, max:128 })
  return {
    ...(id ? { id } : {}),
    kind,
    reason:normalizeReason(raw.reason, kind, `${path}.reason`),
    from_minutes:from,
    to_minutes:to,
    ...(weekdays ? { weekdays } : {}),
  }
}

function normalizeDate(value, path) {
  const date = String(value ?? '').trim()
  if (!ISO_DATE_RE.test(date)) fail('market_session_policy_date_invalid', path)
  const parsed = new Date(`${date}T00:00:00.000Z`)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    fail('market_session_policy_date_invalid', path)
  }
  return date
}

function normalizeHolidayClosures(value) {
  if (value == null) return []
  if (!Array.isArray(value)) fail('market_session_policy_holidays_invalid', '$.holiday_closures')
  const rules = []
  value.forEach((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      fail('market_session_policy_holiday_invalid', `$.holiday_closures[${index}]`)
    }
    const dates = raw.dates == null ? [raw.date] : raw.dates
    if (!Array.isArray(dates) || !dates.length) {
      fail('market_session_policy_holiday_date_required', `$.holiday_closures[${index}]`)
    }
    dates.forEach((date, dateIndex) => {
      const base = `$.holiday_closures[${index}]${raw.dates == null ? '' : `.dates[${dateIndex}]`}`
      const closure = normalizeClosureRule(raw, base, 'holiday_closure')
      rules.push({ ...closure, date:normalizeDate(date, `${base}.date`) })
    })
  })
  return rules.sort((left, right) => `${left.date}|${left.from_minutes}`.localeCompare(`${right.date}|${right.from_minutes}`))
}

function normalizeDstTransitions(value) {
  if (value == null) return []
  if (!Array.isArray(value)) fail('market_session_policy_dst_invalid', '$.dst_transitions')
  return value.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('market_session_policy_dst_invalid', `$.dst_transitions[${index}]`)
    const rawAt = raw.at_utc_msc ?? raw.at_utc ?? raw.utc ?? raw.at
    const at = Number(rawAt)
    let atUtcMsc = Number.isFinite(at) && at > 0 ? Math.trunc(at) : Date.parse(String(rawAt || ''))
    if (!Number.isFinite(atUtcMsc) || atUtcMsc <= 0) fail('market_session_policy_dst_at_invalid', `$.dst_transitions[${index}].at_utc`)
    if (atUtcMsc < 1e12) atUtcMsc *= 1000
    const from = Number(raw.from_offset_minutes ?? raw.offset_from_minutes ?? raw.from_offset)
    const to = Number(raw.to_offset_minutes ?? raw.offset_to_minutes ?? raw.to_offset)
    if (![from, to].every(Number.isInteger) || from < OFFSET_MINUTES_MIN || from > OFFSET_MINUTES_MAX
      || to < OFFSET_MINUTES_MIN || to > OFFSET_MINUTES_MAX || from === to) {
      fail('market_session_policy_dst_offset_invalid', `$.dst_transitions[${index}]`)
    }
    return { at_utc_msc:atUtcMsc, from_offset_minutes:from, to_offset_minutes:to,
      reason:normalizeReason(raw.reason, 'dst_transition', `$.dst_transitions[${index}].reason`) }
  }).sort((left, right) => left.at_utc_msc - right.at_utc_msc)
}

function normalizeSymbols(raw, path) {
  const values = raw.symbols == null ? [raw.standard_symbol ?? raw.standardSymbol ?? raw.symbol] : raw.symbols
  if (!Array.isArray(values) || !values.length) fail('market_session_policy_symbols_required', path)
  const symbols = [...new Set(values.map((value, index) => normalizeString(value, `${path}[${index}]`, { upper:true, max:64 })))]
  if (symbols.some(symbol => /[?\[\]{}()|\\^$]/.test(symbol))) fail('market_session_policy_symbol_pattern_invalid', path)
  return symbols.sort()
}

function policyMatchKey(policy, symbol) {
  return `${policy.platform}\u0000${policy.broker_server}\u0000${symbol}`
}

function normalizePolicy(raw, index) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('market_session_policy_object_required', `$[${index}]`)
  const policyId = normalizeString(raw.policy_id ?? raw.id, `$[${index}].policy_id`, { lower:true, max:128 })
  const version = normalizePositiveInteger(raw.version, `$[${index}].version`)
  const platform = normalizeString(raw.platform, `$[${index}].platform`, { lower:true, max:16 })
  if (!PLATFORMS.has(platform)) fail('market_session_policy_platform_invalid', `$[${index}].platform`)
  const brokerServer = normalizeString(raw.broker_server ?? raw.brokerServer, `$[${index}].broker_server`, { max:150 })
  const symbols = normalizeSymbols(raw, `$[${index}].symbols`)
  const clockBasis = String(raw.clock_basis ?? raw.clockBasis ?? 'broker_time').trim().toLowerCase()
  if (clockBasis !== 'broker_time') fail('market_session_policy_clock_basis_invalid', `$[${index}].clock_basis`)
  const dailyClosures = (raw.daily_closures ?? raw.dailyClosures ?? []).map((rule, ruleIndex) =>
    normalizeClosureRule(rule, `$[${index}].daily_closures[${ruleIndex}]`, 'daily_maintenance', { weekdaysRequired:true }))
  const weeklyClosures = (raw.weekly_closures ?? raw.weeklyClosures ?? []).map((rule, ruleIndex) =>
    normalizeClosureRule(rule, `$[${index}].weekly_closures[${ruleIndex}]`, 'weekly_closure', { weekdaysRequired:true }))
  const holidays = normalizeHolidayClosures(raw.holiday_closures ?? raw.holidayClosures)
  const dstTransitions = normalizeDstTransitions(raw.dst_transitions ?? raw.dstTransitions)
  const policy = {
    schema_version:MARKET_SESSION_POLICY_SCHEMA_VERSION,
    policy_id:policyId,
    version,
    platform,
    broker_server:brokerServer,
    symbols,
    clock_basis:clockBasis,
    daily_closures:dailyClosures,
    weekly_closures:weeklyClosures,
    holiday_closures:holidays,
    dst_transitions:dstTransitions,
  }
  return { ...policy, policy_hash:hashMarketSessionPolicy(policy) }
}

function parsePolicies(rawValue) {
  if (rawValue == null || String(rawValue).trim() === '') return []
  let parsed
  try { parsed = JSON.parse(String(rawValue)) } catch (error) {
    fail('market_session_policy_json_invalid', MARKET_SESSION_POLICIES_ENV, error.message)
  }
  if (!Array.isArray(parsed)) fail('market_session_policy_array_required', MARKET_SESSION_POLICIES_ENV)
  const policies = parsed.map(normalizePolicy)
  const keys = new Set()
  for (const policy of policies) {
    for (const symbol of policy.symbols) {
      const key = policyMatchKey(policy, symbol)
      if (keys.has(key)) fail('market_session_policy_ambiguous', `${MARKET_SESSION_POLICIES_ENV}.${key}`)
      keys.add(key)
    }
  }
  return policies
}

let cachedConfig = null
let runtimeConfig = null

export function readMarketSessionPolicyConfig(env = process.env) {
  if (env === process.env && runtimeConfig) return runtimeConfig
  const mode = normalizeMode(env?.[MARKET_SESSION_POLICY_MODE_ENV])
  const rawPolicies = env?.[MARKET_SESSION_POLICIES_ENV] ?? ''
  const cacheKey = `${mode}\u0000${rawPolicies}`
  if (cachedConfig?.cache_key === cacheKey) {
    if (env === process.env) runtimeConfig = cachedConfig
    return cachedConfig
  }
  // `off` is the emergency rollback path and must remain startable even when
  // a staged policy value is malformed. audit/enforce validate fail-closed.
  const policies = mode === 'off' ? [] : parsePolicies(rawPolicies)
  cachedConfig = Object.freeze({
    cache_key:cacheKey,
    mode,
    policies:Object.freeze(policies.map(policy => deepFreeze(policy))),
  })
  if (env === process.env) runtimeConfig = cachedConfig
  return cachedConfig
}

export function getMarketSessionPolicyMode(env = process.env) {
  return readMarketSessionPolicyConfig(env).mode
}

export function getMarketSessionPolicies(env = process.env) {
  return readMarketSessionPolicyConfig(env).policies
}

export function resetMarketSessionPolicyConfigForTests() {
  cachedConfig = null
  runtimeConfig = null
}

function normalizeIdentityValue(value, { upper = false } = {}) {
  const text = String(value ?? '').trim()
  return upper ? text.toUpperCase() : text
}

export function resolveMarketSessionPolicy(identity = {}, options = {}) {
  const config = readMarketSessionPolicyConfig(options.env || process.env)
  const platform = normalizeIdentityValue(identity.platform ?? options.platform).toLowerCase()
  const brokerServer = normalizeIdentityValue(identity.broker_server ?? identity.brokerServer ?? options.broker_server ?? options.brokerServer)
  const symbol = normalizeIdentityValue(identity.standard_symbol ?? identity.standardSymbol ?? options.standard_symbol ?? options.standardSymbol, { upper:true })
  const base = {
    mode:config.mode,
    matched:false,
    policy_id:null,
    policy_version:null,
    policy_hash:null,
    policy:null,
    platform:platform || null,
    broker_server:brokerServer || null,
    standard_symbol:symbol || null,
  }
  if (config.mode === 'off') return base
  if (!platform || !brokerServer || !symbol) return { ...base, reason:'market_session_policy_identity_missing' }
  const matches = config.policies.filter(policy => policy.platform === platform
    && policy.broker_server === brokerServer && policy.symbols.includes(symbol))
  if (matches.length > 1) fail('market_session_policy_ambiguous', `${MARKET_SESSION_POLICIES_ENV}.${platform}|${brokerServer}|${symbol}`)
  const policy = matches[0]
  if (!policy) return { ...base, reason:'market_session_policy_unavailable' }
  return {
    ...base,
    matched:true,
    policy_id:policy.policy_id,
    policy_version:policy.version,
    policy_hash:policy.policy_hash,
    policy,
    reason:null,
  }
}

export const getMarketSessionPolicy = resolveMarketSessionPolicy
export const getMarketSessionPolicyConfig = readMarketSessionPolicyConfig
export const loadMarketSessionPolicies = getMarketSessionPolicies
export const marketSessionPolicyMode = getMarketSessionPolicyMode
