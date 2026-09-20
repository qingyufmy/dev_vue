import { createHash } from 'node:crypto'

// Candidates retain values verbatim. They are not complete or activatable V4 policies.
const renamed = Object.freeze({
  allowed_symbols: 'allowedSymbols', require_stop_loss: 'requireStopLoss',
  pending_valid_minutes: 'pendingValidMinutes', max_risk_per_trade_pct: 'maxRiskPerTradePercent',
  max_position_size: 'maxOrderVolume',
  signal_ttl_seconds: 'maxDecisionAgeSeconds', max_quote_age_seconds: 'maxQuoteAgeSeconds',
  max_spread_points: 'maxSpreadPoints', max_execution_price_deviation_pct: 'maxPriceDeviationPercent',
  weekend_close_minutes: 'weekendCloseMinutes', min_open_interval_seconds: 'minOpenIntervalSeconds',
  max_daily_open_count: 'maxDailyOpenCount', daily_loss_limit_pct: 'maxDailyLossPercent',
  consecutive_loss_limit: 'consecutiveLossLimit', loss_cooldown_minutes: 'lossCooldownMinutes', max_drawdown_pct: 'maxDrawdownPercent',
})
const integerFields = new Set(['pending_valid_minutes', 'signal_ttl_seconds', 'max_quote_age_seconds',
  'weekend_close_minutes', 'min_open_interval_seconds', 'max_daily_open_count', 'consecutive_loss_limit', 'loss_cooldown_minutes'])
const missing = Object.freeze({ max_position_size: 'per_order_volume_not_total_volume',
  dedup_window_seconds: 'execution_dedup_window_unmapped', dedup_price_atr: 'execution_dedup_distance_unmapped' })
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
// Bounds from the legacy RISK_RULES contract; preserve raw controls separately.
const legacyBounds = Object.freeze({ pending_valid_minutes: [5, 1440], max_position_size: [0.001, 5],
  max_risk_per_trade_pct: [0.01, 100], max_spread_points: [1, 100000], max_execution_price_deviation_pct: [0.001, 5],
  weekend_close_minutes: [0, 2880], min_open_interval_seconds: [0, 86400], max_daily_open_count: [1, 10000],
  daily_loss_limit_pct: [0.1, 100], consecutive_loss_limit: [1, 100], loss_cooldown_minutes: [1, 10080], max_drawdown_pct: [0.1, 100] })

function normalizedControl(field, control) {
  const bounds = legacyBounds[field]
  if (!bounds || !object(control) || Object.keys(control).sort().join(',') !== 'allowed_max,allowed_min,locked_value,user_editable') return null
  if (![control.allowed_min, control.allowed_max].every(v => typeof v === 'number' && Number.isFinite(v))
    || typeof control.user_editable !== 'boolean' || control.locked_value !== null && (typeof control.locked_value !== 'number' || !Number.isFinite(control.locked_value))) return null
  const allowedMin = Math.max(bounds[0], control.allowed_min), allowedMax = Math.min(bounds[1], control.allowed_max)
  const lockedValue = control.locked_value === null ? null : Math.max(bounds[0], Math.min(bounds[1], control.locked_value))
  if (allowedMin > allowedMax || lockedValue !== null && (lockedValue < allowedMin || lockedValue > allowedMax)) return null
  if (integerFields.has(field) && ![allowedMin, allowedMax, lockedValue ?? allowedMin].every(Number.isSafeInteger)) return null
  return { allowedMin, allowedMax, lockedValue, userEditable: control.user_editable }
}

export function inspectLegacyRiskPolicy(raw) {
  if (typeof raw !== 'string') throw Error('risk_legacy_policy_raw_required')
  const sourceSha256 = createHash('sha256').update(raw).digest('hex')
  let source
  try { source = JSON.parse(raw) } catch { return { sourceSha256, valid: false, issues: [{ code: 'invalid_json' }], activationReady: false } }
  if (!object(source)) return { sourceSha256, valid: false, issues: [{ code: 'config_not_object' }], activationReady: false }
  const issues = [], candidates = {}, retained = {}, controls = {}, controlCandidates = {}
  const wrapped = Object.hasOwn(source, 'values') || Object.hasOwn(source, 'defaults')
  if (Object.hasOwn(source, 'values') && Object.hasOwn(source, 'defaults')) issues.push({ code: 'ambiguous_values_defaults' })
  const values = wrapped ? source.values ?? source.defaults : source
  if (!object(values)) return { sourceSha256, valid: false, issues: [{ code: 'values_not_object' }], activationReady: false }
  if (wrapped) for (const key of Object.keys(source)) {
    if (!['values', 'defaults', 'controls', '_controls'].includes(key)) issues.push({ field: key, code: 'unknown_envelope_field' })
  }
  if (Object.hasOwn(source, 'controls') && Object.hasOwn(source, '_controls')) issues.push({ code: 'ambiguous_controls' })
  for (const [field, value] of Object.entries(values)) {
    if (!wrapped && ['controls', '_controls'].includes(field)) continue
    const target = renamed[field]
    if (!target) {
      retained[field] = value
      issues.push({ field, code: missing[field] ?? 'unknown_legacy_rule' })
      continue
    }
    let valid
    if (field === 'allowed_symbols') valid = Array.isArray(value) && value.length > 0 && value.every(v => typeof v === 'string' && v.trim().length > 0)
    else if (field === 'require_stop_loss') valid = value === true
    else valid = typeof value === 'number' && Number.isFinite(value) && value >= 0 && (!integerFields.has(field) || Number.isSafeInteger(value))
    if (!valid) { retained[field] = value; issues.push({ field, code: 'invalid_rule_value' }); continue }
    candidates[target] = structuredClone(value)
  }
  const rawControls = source.controls ?? source._controls ?? {}
  if (!object(rawControls)) issues.push({ code: 'controls_not_object' })
  else for (const [field, control] of Object.entries(rawControls)) {
    controls[field] = structuredClone(control)
    const mapped = normalizedControl(field, control)
    if (mapped) controlCandidates[renamed[field]] = mapped
    else issues.push({ field, code: 'platform_control_semantics_unmapped' })
    if (!object(control)) issues.push({ field, code: 'invalid_control' })
    else for (const key of Object.keys(control)) {
      if (!['allowed_min', 'allowed_max', 'locked_value', 'user_editable'].includes(key)) issues.push({ field, code: 'unknown_control_field', controlField: key })
    }
  }
  return { sourceSha256, valid: !issues.some(issue => ['invalid_rule_value', 'invalid_control', 'invalid_json',
    'controls_not_object', 'ambiguous_values_defaults', 'ambiguous_controls'].includes(issue.code)),
  candidates, retained, controls, controlCandidates, issues, activationReady: false,
  scope: 'Field candidates only. Requires complete V4 policy validation, default semantics, account ownership and version lineage before activation.' }
}
