import crypto from 'node:crypto'
import { timeframeIntervalMs } from './utils.js'

export const INDICATOR_ALGORITHM_VERSION = 'indicator-registry-v3'

function sha256(value) {
  return crypto.createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex')
}

function barTime(bar) {
  const numeric = Number(bar?.time_utc_msc ?? bar?.time_msc ?? bar?.time_server_msc)
  if (Number.isFinite(numeric) && numeric > 0) return numeric < 1e12 ? numeric * 1000 : numeric
  const parsed = Date.parse(String(bar?.time || ''))
  return Number.isFinite(parsed) ? parsed : null
}

function normalizeBars(bars, field) {
  const rows = (Array.isArray(bars) ? bars : []).map((bar, index) => ({
    index,
    raw:bar,
    time:barTime(bar),
    value:Number(bar?.[field]),
  }))
  if (rows.some(row => !Number.isFinite(row.value))) return { ok:false, reason:'indicator_non_finite_value', rows:[] }
  const timed = rows.filter(row => Number.isFinite(row.time))
  if (timed.length !== rows.length) return { ok:false, reason:'indicator_bar_time_missing', rows:[] }
  if (rows.some((row, index) => index > 0 && row.time <= rows[index - 1].time)) {
    return { ok:false, reason:'indicator_bar_time_not_strictly_increasing', rows:[] }
  }
  return { ok:true, rows }
}

function baseEvidence(definition, source, ready, reason, value = null, bar = null, barsUsed = 0, analysis = null) {
  const evidence = {
    id:definition.id,
    kind:definition.kind,
    ready,
    value:Number.isFinite(Number(value)) ? Number(value) : null,
    bar:bar ? {
      time:bar.raw?.time || null,
      time_utc_msc:bar.time,
      open:Number(bar.raw?.open),
      high:Number(bar.raw?.high),
      low:Number(bar.raw?.low),
      close:Number(bar.raw?.close),
    } : null,
    source:{
      timeframe:definition.source.timeframe,
      field:definition.source.field,
      bar_scope:definition.source.bar_scope,
      market_source:source.marketSource || null,
    },
    reason,
    bars_used:barsUsed,
    analysis,
    algorithm_version:INDICATOR_ALGORITHM_VERSION,
  }
  evidence.evidence_hash = sha256(JSON.stringify(evidence))
  return evidence
}

function emaSeries(values, period) {
  const series = Array(values.length).fill(null)
  if (values.length < period) return series
  const seed = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period
  const multiplier = 2 / (period + 1)
  series[period - 1] = seed
  for (let index = period; index < values.length; index += 1) {
    series[index] = ((values[index] - series[index - 1]) * multiplier) + series[index - 1]
  }
  return series
}

function smaSeries(values, period) {
  const series = Array(values.length).fill(null)
  if (values.length < period) return series
  let rolling = values.slice(0, period).reduce((sum, value) => sum + value, 0)
  series[period - 1] = rolling / period
  for (let index = period; index < values.length; index += 1) {
    rolling += values[index] - values[index - period]
    series[index] = rolling / period
  }
  return series
}

function relation(left, right) {
  if (left > right) return 'above'
  if (left < right) return 'below'
  return 'at_average'
}

function movingAverageAnalysis(rows, series, definition) {
  const latestIndex = rows.length - 1
  const value = series[latestIndex]
  const previousValue = latestIndex > 0 ? series[latestIndex - 1] : null
  const fieldValue = rows[latestIndex]?.value
  const distance = Number.isFinite(value) ? fieldValue - value : null
  const slope = Number.isFinite(previousValue) ? value - previousValue : null
  const evidenceWindow = Math.max(2, Number(definition.params?.evidence_window || 5))
  const observations = rows.map((row, index) => ({
    fieldValue:row.value,
    average:series[index],
  })).filter(item => Number.isFinite(item.average)).slice(-evidenceWindow)
  const relations = observations.map(item => relation(item.fieldValue, item.average))
  let latestCross = 'none'
  let crossBarsAgo = null
  for (let index = relations.length - 1; index > 0; index -= 1) {
    const previous = relations[index - 1]
    const current = relations[index]
    if (current === 'above' && previous !== 'above') {
      latestCross = 'crossed_above'
      crossBarsAgo = relations.length - 1 - index
      break
    }
    if (current === 'below' && previous !== 'below') {
      latestCross = 'crossed_below'
      crossBarsAgo = relations.length - 1 - index
      break
    }
  }
  const warmupTarget = Math.max(Number(definition.params?.minimum_bars || 0), Number(definition.params?.warmup_target_bars || 0))
  const warmupComplete = rows.length >= warmupTarget
  return {
    warmup_complete:warmupComplete,
    evidence_quality:warmupComplete ? 'reliable' : 'limited',
    field_value:fieldValue,
    previous_value:Number.isFinite(previousValue) ? previousValue : null,
    relation:relation(fieldValue, value),
    distance,
    distance_pct:Number.isFinite(distance) && value !== 0 ? (distance / Math.abs(value)) * 100 : null,
    slope,
    slope_pct:Number.isFinite(slope) && previousValue !== 0 ? (slope / Math.abs(previousValue)) * 100 : null,
    slope_direction:Number.isFinite(slope) ? (slope > 0 ? 'rising' : slope < 0 ? 'falling' : 'flat') : 'unavailable',
    observation_window:observations.length,
    bars_above:relations.filter(item => item === 'above').length,
    bars_below:relations.filter(item => item === 'below').length,
    bars_at_average:relations.filter(item => item === 'at_average').length,
    latest_cross:latestCross,
    cross_bars_ago:crossBarsAgo,
  }
}

function validateDefinition(definition) {
  if (!definition || typeof definition !== 'object') throw new Error('indicator_definition_required')
  const period = Number(definition.params?.period)
  if (!Number.isInteger(period) || period < 1) throw new Error('indicator_period_invalid')
  return true
}

function requiredHistory(definition) {
  validateDefinition(definition)
  return Math.max(
    Number(definition.params.period),
    Number(definition.params.minimum_bars || 0),
    Number(definition.params.warmup_target_bars || 0),
  )
}

function calculateMovingAverage(calculator, bars, definition, source = {}) {
  validateDefinition(definition)
  const field = definition.source.field
  const normalized = normalizeBars(bars, field)
  if (!normalized.ok) return baseEvidence(definition, source, false, normalized.reason)
  if (source.internalGapUnresolved === true) return baseEvidence(definition, source, false, 'indicator_internal_gap_unresolved')

  let rows = normalized.rows
  if (definition.source.bar_scope === 'closed_only') {
    if (source.lastBarClosed === false) rows = rows.slice(0, -1)
    else if (source.lastBarClosed !== true) return baseEvidence(definition, source, false, 'indicator_bar_close_state_unknown')
  }
  const latestRow = rows.at(-1)
  const referenceTimeUtcMs = Number(source.referenceTimeUtcMs ?? source.reference_time_utc_msc)
  const intervalMs = timeframeIntervalMs(definition.source.timeframe)
  const latestClosedBarTimeUtcMs = Number(latestRow?.time) + intervalMs
  const staleToleranceMs = Number.isFinite(Number(source.staleToleranceMs ?? source.stale_tolerance_ms))
    ? Math.max(0, Number(source.staleToleranceMs ?? source.stale_tolerance_ms))
    : Math.max(120_000, intervalMs * 2)
  if (Number.isFinite(referenceTimeUtcMs) && Number.isFinite(latestClosedBarTimeUtcMs)
    && referenceTimeUtcMs - latestClosedBarTimeUtcMs > staleToleranceMs) {
    return baseEvidence(definition, source, false, 'indicator_source_stale', null, latestRow, rows.length, {
      reference_time_utc_msc:referenceTimeUtcMs,
      latest_closed_bar_time_utc_msc:latestClosedBarTimeUtcMs,
      source_age_ms:referenceTimeUtcMs - latestClosedBarTimeUtcMs,
      stale_tolerance_ms:staleToleranceMs,
    })
  }
  const period = Number(definition.params.period)
  const minimumBars = Math.max(period, Number(definition.params.minimum_bars || period))
  if (rows.length < minimumBars) {
    return baseEvidence(definition, source, false, 'indicator_history_insufficient', null, rows.at(-1), rows.length)
  }
  const values = rows.map(row => row.value)
  const series = calculator(values, period)
  const value = series.at(-1)
  const analysis = movingAverageAnalysis(rows, series, definition)
  return baseEvidence(definition, source, true, 'ready', value, rows.at(-1), rows.length, analysis)
}

export const indicatorRegistry = Object.freeze({
  ema:Object.freeze({
    validate:validateDefinition,
    requiredHistory,
    calculate:(bars, definition, source) => calculateMovingAverage(emaSeries, bars, definition, source),
  }),
  sma:Object.freeze({
    validate:validateDefinition,
    requiredHistory,
    calculate:(bars, definition, source) => calculateMovingAverage(smaSeries, bars, definition, source),
  }),
})

export function indicatorRequiredHistory(definition) {
  const capability = indicatorRegistry[definition?.kind]
  if (!capability) throw new Error('indicator_kind_unsupported')
  return capability.requiredHistory(definition)
}

export function calculateIndicator(definition, bars, source = {}) {
  const capability = indicatorRegistry[definition?.kind]
  if (!capability) return baseEvidence(definition || {}, source, false, 'indicator_kind_unsupported')
  return capability.calculate(bars, definition, source)
}

export function calculatePolicyIndicators(compiledPolicy, frameSources = {}) {
  const result = {}
  for (const definition of compiledPolicy?.indicators || []) {
    if (!definition.enabled) continue
    const frame = frameSources[definition.source.timeframe] || {}
    result[definition.id] = calculateIndicator(definition, frame.bars || frame.klines || [], {
      lastBarClosed:frame.lastBarClosed,
      internalGapUnresolved:frame.internalGapUnresolved,
      marketSource:frame.marketSource,
      referenceTimeUtcMs:frame.referenceTimeUtcMs ?? frame.reference_time_utc_msc,
      staleToleranceMs:frame.staleToleranceMs ?? frame.stale_tolerance_ms,
    })
  }
  return result
}
