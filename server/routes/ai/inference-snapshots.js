import crypto from 'crypto'
import { gzipSync, gunzipSync } from 'node:zlib'
import { beijingNow, queryOne } from '../../db.js'
import { stripBrokerSuffix, CHAN_ALGORITHM_VERSION } from './utils.js'
import { getChanWindowPolicy, CHAN_WINDOW_POLICY_VERSION } from './chan-window-policy.js'

export const MAX_INFERENCE_SNAPSHOT_BYTES = 512 * 1024
export const CHAN_MODEL_PAYLOAD_VERSION = 'chan_model_payload_v2'
const SECRET_KEY = /(api[_-]?key|authorization|credential|password|secret|token)/i
const ACCOUNT_PRIVATE_KEY = new Set([
  'account', 'balance', 'equity', 'credit', 'margin', 'free_margin', 'margin_level',
  'positions', 'pending_orders', 'profit', 'total_profit', 'risk_level', 'personal_risk',
])

function isExplicitlyEnabled(value) {
  return value === true || value === 1 || value === '1'
    || String(value ?? '').trim().toLowerCase() === 'true'
}
const COMPRESSED_JSON_PREFIX = 'gzip-base64:'
const SNAPSHOT_COMPRESSION_MIN_BYTES = 4096
export const INFERENCE_EVIDENCE_TIMEFRAMES = Object.freeze([
  'M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1',
])
const INFERENCE_EVIDENCE_TIMEFRAME_SET = new Set(INFERENCE_EVIDENCE_TIMEFRAMES)
export const MAX_INFERENCE_EVIDENCE_BARS = 500

export function sha256(value) {
  return crypto.createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex')
}

function clean(value, seen = new WeakSet()) {
  if (Array.isArray(value)) return value.map(item => clean(item, seen))
  if (!value || typeof value !== 'object') return value
  if (seen.has(value)) return '[circular]'
  seen.add(value)
  const out = {}
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) continue
    out[key] = clean(item, seen)
  }
  seen.delete(value)
  return out
}

export function sanitizeInferenceEvidence(value) {
  return clean(value)
}

function stripAccountPrivateData(value) {
  if (Array.isArray(value)) return value.map(stripAccountPrivateData)
  if (!value || typeof value !== 'object') return value
  const out = {}
  for (const [key, item] of Object.entries(value)) {
    if (ACCOUNT_PRIVATE_KEY.has(key.toLowerCase())) continue
    out[key] = stripAccountPrivateData(item)
  }
  return out
}

function freezeContinuityEvidence(...sources) {
  const roots = sources.filter(value => value && typeof value === 'object')
  const nested = roots.map(value => value.continuity).find(value => value && typeof value === 'object') || {}
  const policy = [...roots.map(value => value.policy), nested.policy]
    .find(value => value && typeof value === 'object') || {}
  const pick = (...values) => values.find(value => value !== undefined && value !== null && value !== '') ?? null
  const list = (...values) => {
    const value = values.find(item => Array.isArray(item))
    return value ? value.slice(0, 32) : []
  }
  const result = pick(nested.result, nested.results,
    ...roots.flatMap(value => [value.continuity_result, value.continuity_results, value.coverage_result]))
  const fields = {
    continuity_engine_version:pick(nested.continuity_engine_version, nested.engine_version,
      ...roots.flatMap(value => [value.continuity_engine_version, value.engine_version])),
    continuity_policy_id:pick(nested.continuity_policy_id, nested.policy_id,
      policy.policy_id, ...roots.flatMap(value => [value.continuity_policy_id, value.policy_id])),
    continuity_policy_version:pick(nested.continuity_policy_version, nested.policy_version,
      policy.policy_version, policy.version, ...roots.flatMap(value => [value.continuity_policy_version, value.policy_version])),
    continuity_policy_hash:pick(nested.continuity_policy_hash, nested.policy_hash,
      policy.policy_hash, ...roots.flatMap(value => [value.continuity_policy_hash, value.policy_hash])),
    continuity_policy_match:pick(nested.continuity_policy_match, nested.policy_match,
      ...roots.flatMap(value => [value.continuity_policy_match, value.policy_match])),
    continuity_calendar_version:pick(nested.continuity_calendar_version, nested.calendar_version,
      ...roots.flatMap(value => [value.continuity_calendar_version, value.calendar_version])),
    continuity_status:pick(nested.continuity_status, nested.status,
      ...roots.flatMap(value => [value.continuity_status, value.status])),
    continuity_reason:pick(nested.continuity_reason, nested.reason,
      ...roots.flatMap(value => [value.continuity_reason, value.reason])),
    continuity_reasons:list(nested.continuity_reasons, nested.reasons,
      ...roots.flatMap(value => [value.continuity_reasons, value.reasons])),
    expected_closures:list(nested.expected_closures, ...roots.map(value => value.expected_closures)),
    suspicious_gaps:list(nested.suspicious_gaps, nested.uncovered_ranges,
      ...roots.flatMap(value => [value.suspicious_gaps, value.uncovered_ranges])),
    continuity_results:list(nested.continuity_results,
      ...roots.map(value => value.continuity_results)),
    closure_components:list(nested.closure_components, nested.components,
      ...roots.flatMap(value => [value.closure_components, value.components])),
    uncovered_ranges:list(nested.uncovered_ranges, nested.uncovered,
      ...roots.flatMap(value => [value.uncovered_ranges, value.uncovered])),
    audit_expected_closures:list(nested.audit_expected_closures,
      ...roots.map(value => value.audit_expected_closures)),
    audit_suspicious_gaps:list(nested.audit_suspicious_gaps,
      ...roots.map(value => value.audit_suspicious_gaps)),
    continuity_policy_mode:pick(nested.continuity_policy_mode, nested.mode,
      ...roots.flatMap(value => [value.continuity_policy_mode, value.mode])),
    source_identity:{
      source_id:Number(pick(nested.source_id, ...roots.map(value => value.source_id))) || null,
      source_key:pick(nested.source_key, ...roots.map(value => value.source_key)),
      platform:pick(nested.platform, ...roots.map(value => value.platform)),
      broker_server:pick(nested.broker_server, ...roots.map(value => value.broker_server)),
      account_login:pick(nested.account_login, ...roots.map(value => value.account_login)),
    },
    unknown_session_gap_count:Number(pick(nested.unknown_session_gap_count,
      ...roots.map(value => value.unknown_session_gap_count)) || 0),
    cache_internal_gap_unresolved:Boolean(pick(nested.cache_internal_gap_unresolved,
      ...roots.map(value => value.cache_internal_gap_unresolved)) === true),
  }
  return {
    ...fields,
    // Keep the original calendar field for existing snapshot readers while
    // storing the richer policy identity under the canonical names above.
    calendar_version:fields.continuity_calendar_version,
    engine_version:fields.continuity_engine_version,
    policy_id:fields.continuity_policy_id,
    policy_version:fields.continuity_policy_version,
    policy_hash:fields.continuity_policy_hash,
    policy_match:fields.continuity_policy_match,
    ...(result && typeof result === 'object' ? { result } : {}),
  }
}

function freezeChanPolicyEvidence(marketSnapshot) {
  if (!marketSnapshot || typeof marketSnapshot !== 'object') return marketSnapshot
  const context = marketSnapshot.strategy_context
  const frames = context?.timeframes
  if (!frames || typeof frames !== 'object') return marketSnapshot
  for (const [rawTimeframe, frame] of Object.entries(frames)) {
    const chan = frame?.summary?.chan
    const marketQuality = frame?.summary?.market_data_quality
    if ((!chan || typeof chan !== 'object') && (!marketQuality || typeof marketQuality !== 'object')) continue
    const timeframe = String(rawTimeframe || '').toUpperCase()
    const continuity = freezeContinuityEvidence(chan, marketQuality)
    if (marketQuality && typeof marketQuality === 'object') marketQuality.continuity = continuity
    if (!chan || typeof chan !== 'object') continue
    const policy = (String(chan.window_policy_version || '') === CHAN_WINDOW_POLICY_VERSION
      || String(chan.algorithm_version || '') === CHAN_ALGORITHM_VERSION)
      ? getChanWindowPolicy(timeframe) : null
    if (policy) {
      chan.window_policy_version = policy.windowPolicyVersion
      chan.maximum_history_count = Number(chan.maximum_history_count) || policy.target
      chan.validation_window_counts = Array.isArray(chan.validation_window_counts)
        ? [...chan.validation_window_counts] : [...policy.validators]
    }
    chan.evidence_capabilities = chan.evidence_capabilities && typeof chan.evidence_capabilities === 'object'
      ? { ...chan.evidence_capabilities }
      : {
          data_complete:chan.history_sufficient === true && chan.cache_internal_gap_unresolved !== true,
          segment_direction_usable:false,
          center_structure_usable:false,
          entry_structure_usable:false,
          divergence_usable:false,
          reason_codes:['legacy_capabilities_unavailable'],
        }
    chan.continuity = {
      ...continuity,
      continuity_calendar_version:continuity.continuity_calendar_version || chan.continuity_calendar_version || null,
      expected_closures:continuity.expected_closures.length ? continuity.expected_closures
        : (Array.isArray(chan.expected_closures) ? chan.expected_closures.slice(0, 32) : []),
      cache_internal_gap_unresolved:continuity.cache_internal_gap_unresolved || chan.cache_internal_gap_unresolved === true,
    }
  }
  return marketSnapshot
}

export function buildSharedMarketSnapshot(market, { standardSymbol, volumeMin, volumeMax, volumeStep = 0.01, marketSource = 'platform_market_bridge' } = {}) {
  const technicalFields = [
    'timestamp', 'latest_price', 'price_change', 'price_change_pct', 'sma_20', 'sma_50', 'ema_12', 'ema_26',
    'avg_volatility', 'recent_high_20', 'recent_low_20', 'range_position_20', 'sma_distance_pct',
    'momentum_3_pct', 'momentum_10_pct', 'momentum_20_pct', 'volatility_pct', 'macd', 'rsi_14',
    'bollinger', 'atr_14', 'atr_14_closed', 'support_resistance',
    'kline_patterns', 'volume', 'kline_count', 'strategy_context',
    'strategy_reference_portfolio',
    'primary_timeframe', 'requested_timeframes', 'used_timeframes', 'missing_timeframes',
  ]
  const result = {
    standard_symbol: stripBrokerSuffix(String(standardSymbol || market?.symbol || '')).toUpperCase(),
    symbol: stripBrokerSuffix(String(standardSymbol || market?.symbol || '')).toUpperCase(),
    timeframe: market?.timeframe,
    market_source: marketSource,
  }
  for (const key of technicalFields) {
    if (market?.[key] === undefined) continue
    result[key] = key === 'strategy_reference_portfolio'
      ? clean(market[key])
      : stripAccountPrivateData(clean(market[key]))
  }
  const visualizationKlines = market?.strategy_context?.visualization_klines
  if (visualizationKlines && result.strategy_context) {
    Object.defineProperty(result.strategy_context, 'visualization_klines', { value: visualizationKlines, enumerable: false })
  }
  return result
}

function extractKlines(market) {
  const visualization = market?.strategy_context?.visualization_klines
  if (visualization && typeof visualization === 'object') return visualization
  const frames = market?.strategy_context?.timeframes || {}
  const result = {}
  for (const [timeframe, value] of Object.entries(frames)) {
    if (Array.isArray(value?.klines)) result[timeframe] = value.klines
  }
  return result
}

function stripEmbeddedKlines(market) {
  const result = clean(market || {})
  const visit = value => {
    if (Array.isArray(value)) {
      value.forEach(visit)
      return
    }
    if (!value || typeof value !== 'object') return
    for (const key of Object.keys(value)) {
      if (key === 'klines' || key === 'visualization_klines') delete value[key]
      else visit(value[key])
    }
  }
  visit(result)
  return result
}

function snapshotStorageByteLength(stored) {
  return Buffer.byteLength(String(stored?.system_prompt || ''), 'utf8')
    + Buffer.byteLength(String(stored?.user_prompt || ''), 'utf8')
    + Buffer.byteLength(JSON.stringify(stored?.market_snapshot || {}), 'utf8')
    + Buffer.byteLength(encodeSnapshotJson(stored?.klines || {}), 'utf8')
    + Buffer.byteLength(JSON.stringify(stored?.strategy_runtime || {}), 'utf8')
}

export function encodeSnapshotJson(value, minimumBytes = SNAPSHOT_COMPRESSION_MIN_BYTES) {
  const json = JSON.stringify(value ?? {})
  if (Buffer.byteLength(json, 'utf8') < minimumBytes) return json
  const compressed = `${COMPRESSED_JSON_PREFIX}${gzipSync(json, { level: 6 }).toString('base64')}`
  return Buffer.byteLength(compressed, 'utf8') < Buffer.byteLength(json, 'utf8') ? compressed : json
}

export function parseSnapshotJson(value, fallback = {}) {
  if (value == null || value === '') return fallback
  if (typeof value === 'object') return value
  try {
    const text = String(value)
    const json = text.startsWith(COMPRESSED_JSON_PREFIX)
      ? gunzipSync(Buffer.from(text.slice(COMPRESSED_JSON_PREFIX.length), 'base64')).toString('utf8')
      : text
    return JSON.parse(json)
  } catch {
    return fallback
  }
}

const FROZEN_CHAN_TIMEFRAMES = new Set(['M5', 'M15', 'H1', 'H4'])

function parsedObject(value, fallback = null) {
  const parsed = parseSnapshotJson(value, fallback)
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback
}

function normalizeFrozenChanTimeframes(...values) {
  const result = []
  const add = value => {
    if (Array.isArray(value)) {
      for (const item of value) add(item)
      return
    }
    if (value && typeof value === 'object') {
      if (value.timeframe) add(value.timeframe)
      if (value.timeframes) add(value.timeframes)
      for (const [key, item] of Object.entries(value)) {
        if (item === true || item?.enabled === true || item?.chan === true) add(key)
      }
      return
    }
    const timeframe = String(value || '').trim().toUpperCase()
    if (FROZEN_CHAN_TIMEFRAMES.has(timeframe) && !result.includes(timeframe)) result.push(timeframe)
  }
  values.forEach(add)
  return result
}

function normalizeKnownTimeframes(...values) {
  const result = []
  const add = value => {
    if (Array.isArray(value)) { value.forEach(add); return }
    if (value && typeof value === 'object') {
      if (value.timeframe) add(value.timeframe)
      if (value.timeframes) add(value.timeframes)
      for (const [key, item] of Object.entries(value)) {
        if (item === true || item?.enabled === true || item?.chan === true) add(key)
      }
      return
    }
    const timeframe = String(value || '').trim().toUpperCase()
    if (INFERENCE_EVIDENCE_TIMEFRAME_SET.has(timeframe) && !result.includes(timeframe)) result.push(timeframe)
  }
  values.forEach(add)
  return result
}

function frozenRuntimeFrom(snapshot, evidence) {
  const candidates = [
    snapshot?.strategy_runtime,
    snapshot?.strategyRuntime,
    snapshot?.strategy_runtime_json,
    snapshot?.strategyRuntimeJson,
    evidence?.strategy_runtime,
    evidence?.strategyRuntime,
    evidence?.strategy_runtime_json,
    evidence?.strategyRuntimeJson,
    evidence?.inference_time?.snapshot?.strategy_runtime,
    evidence?.inference_time?.snapshot?.strategy_runtime_json,
  ]
  for (const candidate of candidates) {
    const runtime = parsedObject(candidate, null)
    if (runtime) return runtime
  }
  return null
}

function rawChanEvidence(snapshot, evidence, fallbackSource = 'inference_snapshot_raw_chan') {
  const roots = [
    snapshot?.market_snapshot,
    snapshot?.marketSnapshot,
    evidence?.market_snapshot,
    evidence?.marketSnapshot,
    evidence?.signal_market_data,
    evidence?.signal?.market_data,
    evidence?.post_trade?.post_trade_structure,
    evidence?.post_trade_structure,
    evidence?.inference_time?.snapshot?.market_snapshot,
    evidence?.inference_time?.snapshot?.marketSnapshot,
  ].map(value => parsedObject(value, null)).filter(Boolean)
  for (const root of roots) {
    const context = root.strategy_context || root.strategyContext || root
    if (context.chan && typeof context.chan === 'object') {
      const allTimeframes = normalizeKnownTimeframes(context.timeframe || root.timeframe)
      return { timeframes:normalizeFrozenChanTimeframes(allTimeframes), unsupportedTimeframes:allTimeframes.filter(item => !FROZEN_CHAN_TIMEFRAMES.has(item)), source:fallbackSource, frames:{} }
    }
    const frames = context?.timeframes || (context === root ? context : null)
    if (frames && typeof frames === 'object') {
      const timeframes = []
      for (const [rawTimeframe, frame] of Object.entries(frames)) {
        const chan = frame?.summary?.chan || frame?.summary?.chan_structure || frame?.chan
        if (chan && typeof chan === 'object') timeframes.push(String(rawTimeframe).toUpperCase())
      }
      if (timeframes.length) {
        const allTimeframes = normalizeKnownTimeframes(timeframes)
        return { timeframes:normalizeFrozenChanTimeframes(allTimeframes), unsupportedTimeframes:allTimeframes.filter(item => !FROZEN_CHAN_TIMEFRAMES.has(item)), source:'inference_snapshot_raw_chan', frames }
      }
    }
    if (context?.chan_timeframe_alignment || context?.chan_structures) {
      const allTimeframes = normalizeKnownTimeframes(
        context.chan_timeframe_alignment?.timeframes,
        context.chan_structures?.timeframes,
        Object.keys(context.chan_timeframe_alignment || {}),
        Object.keys(context.chan_structures || {}),
        Object.keys(context.timeframes || {}),
      )
      return { timeframes:normalizeFrozenChanTimeframes(allTimeframes), unsupportedTimeframes:allTimeframes.filter(item => !FROZEN_CHAN_TIMEFRAMES.has(item)), source:'legacy_snapshot_marker' }
    }
  }
  return null
}

/**
 * Resolve Chan capability from the evidence frozen with a signal.
 *
 * The current strategy is deliberately not consulted here: a later edit must
 * never change the evidence contract of an already-created signal.
 */
export function resolveFrozenChanRequirement(snapshot = {}, evidence = {}) {
  const sourceSnapshot = parsedObject(snapshot, {}) || {}
  const sourceEvidence = parsedObject(evidence, {}) || {}
  const runtime = frozenRuntimeFrom(sourceSnapshot, sourceEvidence)
  const strategyVersionRaw = runtime?.strategy_version
    ?? sourceSnapshot.strategy_version
    ?? sourceSnapshot.strategyVersion
    ?? sourceEvidence.strategy_version
  const strategyVersion = Number.isFinite(Number(strategyVersionRaw)) ? Number(strategyVersionRaw) : 1
  const runtimeHasChan = runtime && Object.prototype.hasOwnProperty.call(runtime, 'use_chan_analysis')
  const runtimeWindowVersion = runtime?.window_policy_version
    || runtime?.chan_window_policy_version
    || runtime?.chanWindowPolicyVersion
    || null
  const runtimeTimeframesAll = normalizeKnownTimeframes(
    runtime?.chan_timeframes,
    runtime?.chanTimeframes,
    runtime?.chan_timeframe,
    runtime?.market_data_plan?.timeframes,
  )
  const runtimeTimeframes = normalizeFrozenChanTimeframes(runtimeTimeframesAll)
  const runtimeUnsupportedTimeframes = runtimeTimeframesAll.filter(item => !FROZEN_CHAN_TIMEFRAMES.has(item))
  if (runtimeHasChan) {
    const enabled = runtime.use_chan_analysis === true || runtime.use_chan_analysis === 1 || runtime.use_chan_analysis === '1'
      || String(runtime.use_chan_analysis).trim().toLowerCase() === 'true'
    const disabled = runtime.use_chan_analysis === false || runtime.use_chan_analysis === 0 || runtime.use_chan_analysis === '0'
      || String(runtime.use_chan_analysis).trim().toLowerCase() === 'false'
    if (enabled || disabled) {
      return {
        status: enabled ? 'enabled' : 'disabled',
        source: enabled ? 'inference_snapshot_strategy_runtime' : 'explicit_frozen_disabled',
        timeframes: enabled ? runtimeTimeframes : [],
        unsupported_timeframes: enabled ? runtimeUnsupportedTimeframes : [],
        strategy_version: strategyVersion,
        window_policy_version: runtimeWindowVersion,
      }
    }
  }
  const embeddedRequirement = sourceEvidence?.chan_requirement
    || sourceEvidence?.post_trade?.path_evidence?.chan_requirement
    || sourceEvidence?.inference_time?.chan_requirement
  if (embeddedRequirement && ['enabled', 'disabled', 'unknown'].includes(String(embeddedRequirement.status))) {
    const embeddedStatus = String(embeddedRequirement.status)
    const embeddedTimeframesAll = normalizeKnownTimeframes(embeddedRequirement.timeframes, embeddedRequirement.unsupported_timeframes)
    return {
      status:embeddedStatus,
      source:embeddedRequirement.source || (embeddedStatus === 'disabled' ? 'explicit_frozen_disabled' : 'inference_snapshot_strategy_runtime'),
      timeframes:embeddedStatus === 'enabled' ? normalizeFrozenChanTimeframes(embeddedTimeframesAll) : [],
      unsupported_timeframes:embeddedStatus === 'enabled'
        ? embeddedTimeframesAll.filter(item => !FROZEN_CHAN_TIMEFRAMES.has(item)) : [],
      strategy_version:strategyVersion,
      window_policy_version:embeddedRequirement.window_policy_version || runtimeWindowVersion || null,
    }
  }
  const raw = rawChanEvidence(sourceSnapshot, sourceEvidence)
  if (raw) {
    const chanVersions = Object.values(raw.frames || {}).map(frame => frame?.summary?.chan || frame?.chan)
      .map(chan => chan?.window_policy_version || chan?.chan_window_policy_version).filter(Boolean)
    return {
      status:'enabled', source:raw.source, timeframes:raw.timeframes,
      unsupported_timeframes:raw.unsupportedTimeframes || [],
      strategy_version:strategyVersion,
      window_policy_version:runtimeWindowVersion || chanVersions[0] || null,
    }
  }
  const signalData = parsedObject(sourceEvidence?.market_data_json || sourceEvidence?.signal_market_data_json, null)
  const signalRaw = rawChanEvidence({}, { signal_market_data:signalData }, 'signal_market_data')
  if (signalRaw) {
    return {
      status:'enabled', source:'signal_market_data', timeframes:signalRaw.timeframes,
      unsupported_timeframes:signalRaw.unsupportedTimeframes || [],
      strategy_version:strategyVersion,
      window_policy_version:runtimeWindowVersion || null,
    }
  }
  return {
    status:'unknown', source:'unresolved', timeframes:[], strategy_version:strategyVersion,
    window_policy_version:runtimeWindowVersion,
  }
}

export function normalizeInferenceEvidenceTimeframe(value) {
  const timeframe = String(value || '').trim().toUpperCase()
  if (!INFERENCE_EVIDENCE_TIMEFRAME_SET.has(timeframe)) {
    const error = new Error('invalid_timeframe')
    error.code = 'invalid_timeframe'
    throw error
  }
  return timeframe
}

function normalizeSnapshotKlines(value) {
  const result = {}
  for (const [rawTimeframe, rows] of Object.entries(value || {})) {
    const timeframe = String(rawTimeframe || '').trim().toUpperCase()
    if (INFERENCE_EVIDENCE_TIMEFRAME_SET.has(timeframe)) result[timeframe] = rows
  }
  return result
}

function fitKlinesToSnapshotBudget(stored, maxBytes, minimumBars = 50) {
  const entries = Object.entries(stored.klines || {})
  const buildCandidate = ratio => {
    const klines = {}
    for (const [timeframe, rows] of entries) {
      if (!Array.isArray(rows)) {
        klines[timeframe] = rows
        continue
      }
      const retained = Math.min(rows.length, Math.max(minimumBars, Math.floor(rows.length * ratio)))
      klines[timeframe] = rows.slice(-retained)
    }
    return { ...stored, klines }
  }
  let best = buildCandidate(0)
  if (snapshotStorageByteLength(best) > maxBytes) return best
  let low = 0
  let high = 1
  for (let index = 0; index < 16; index += 1) {
    const middle = (low + high) / 2
    const candidate = buildCandidate(middle)
    if (snapshotStorageByteLength(candidate) <= maxBytes) {
      best = candidate
      low = middle
    } else {
      high = middle
    }
  }
  return best
}

export function prepareInferenceSnapshot(input, maxBytes = MAX_INFERENCE_SNAPSHOT_BYTES) {
  const chanModelPayloadVersion = input.strategyRuntime?.chan_model_payload_version
    || (isExplicitlyEnabled(input.strategyRuntime?.use_chan_analysis) ? CHAN_MODEL_PAYLOAD_VERSION : null)
  const strategyRuntime = input.strategyRuntime ? {
    ...input.strategyRuntime,
    ...(chanModelPayloadVersion
      ? { chan_model_payload_version:chanModelPayloadVersion }
      : {}),
    runtime_config_hash:input.strategyRuntime.runtime_config_hash || sha256(JSON.stringify({
      strategy_id:input.strategyRuntime.strategy_id || null,
      strategy_version:input.strategyRuntime.strategy_version || null,
      scope:input.strategyRuntime.scope || null,
      data_capabilities_version:input.strategyRuntime.data_capabilities_version || null,
      market_data_plan:input.strategyRuntime.market_data_plan || null,
      entry_methods:input.strategyRuntime.entry_methods || null,
      use_chan_analysis:input.strategyRuntime.use_chan_analysis,
      chan_timeframes:input.strategyRuntime.chan_timeframes || [],
      window_policy_version:input.strategyRuntime.window_policy_version || null,
      chan_model_payload_version:chanModelPayloadVersion,
      schema_version:input.strategyRuntime.schema_version || null,
      mode:input.strategyRuntime.mode || null,
      policy_hash:input.strategyRuntime.policy_hash || null,
      compiled_policy:input.strategyRuntime.compiled_policy || null,
    })),
    rendered_prompt_hashes:{
      system:sha256(input.systemPrompt || ''),
      user:sha256(input.userPrompt || ''),
      combined:sha256(`${input.systemPrompt || ''}\n${input.userPrompt || ''}`),
    },
  } : null
  const full = sanitizeInferenceEvidence({
    system_prompt: input.systemPrompt || '', user_prompt: input.userPrompt || '',
    market_snapshot: freezeChanPolicyEvidence(structuredClone(input.marketSnapshot || {})), klines: input.klines || extractKlines(input.marketSnapshot),
    strategy_runtime:strategyRuntime,
  })
  const contentHash = sha256(JSON.stringify(full))
  // K-lines have their own column. Keeping the same arrays inside the market
  // snapshot doubled every record and made size compaction discard old bars
  // required to position Chan structures accurately.
  let stored = { ...full, market_snapshot: stripEmbeddedKlines(full.market_snapshot) }
  const omitted = []
  if (snapshotStorageByteLength(stored) > maxBytes) {
    stored = fitKlinesToSnapshotBudget(stored, maxBytes)
    omitted.push('klines_before_retained_window')
  }
  if (snapshotStorageByteLength(stored) > maxBytes) {
    stored.user_prompt = `[evidence omitted; sha256=${sha256(full.user_prompt)}]`
    omitted.push('rendered_user_prompt_body')
  }
  if (snapshotStorageByteLength(stored) > maxBytes) {
    stored.market_snapshot = { evidence_ref: `sha256:${sha256(JSON.stringify(full.market_snapshot))}` }
    omitted.push('market_snapshot_body')
  }
  if (snapshotStorageByteLength(stored) > maxBytes) {
    stored.system_prompt = `[evidence omitted; sha256=${sha256(full.system_prompt)}]`
    omitted.push('rendered_system_prompt_body')
  }
  if (snapshotStorageByteLength(stored) > maxBytes) throw new Error('inference_snapshot_exceeds_hard_limit')
  // Any K-line prefix removal prevents exact Chan replay, even when the model
  // only saw a shorter rendered excerpt. Mark it incomplete instead of
  // presenting a chart-safe but structurally truncated snapshot as complete.
  return {
    ...input,
    systemPrompt: stored.system_prompt,
    userPrompt: stored.user_prompt,
    marketSnapshot: stored.market_snapshot,
    klines: stored.klines,
    strategyRuntime:stored.strategy_runtime,
    promptHash: sha256(`${full.system_prompt}\n${full.user_prompt}`),
    contentHash,
    evidenceStatus: omitted.length ? 'incomplete' : 'complete',
    omittedFields: omitted,
    byteSize: snapshotStorageByteLength(stored),
  }
}

export async function persistInferenceSnapshotTx(run, input) {
  const row = prepareInferenceSnapshot(input)
  const [result] = await run(`INSERT INTO inference_snapshots
    (signal_id, strategy_id, strategy_version, strategy_scope, owner_user_id, standard_symbol, market_source,
     system_prompt, user_prompt, prompt_hash, model_profile_id, provider, model_name, credential_source,
     output_schema_version, klines_json, market_snapshot_json, memory_mode, evidence_status,
     strategy_runtime_json, omitted_fields_json, content_hash, byte_size, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
    row.signalId || null, row.strategyId ?? null, row.strategyVersion || 1, row.strategyScope, row.ownerUserId || 0,
    row.standardSymbol, row.marketSource, row.systemPrompt, row.userPrompt, row.promptHash,
    row.modelProfileId || null, row.provider || null, row.modelName || null, row.credentialSource || 'none',
    row.outputSchemaVersion, encodeSnapshotJson(row.klines || {}), JSON.stringify(row.marketSnapshot || {}),
    row.memoryMode || 'off', row.evidenceStatus, JSON.stringify(row.strategyRuntime || null), JSON.stringify(row.omittedFields), row.contentHash, row.byteSize,
    row.createdAt || beijingNow(),
  ])
  return result.insertId
}

export function inferenceVisualizationSnapshot(row) {
  if (!row) return null
  const klines = parseSnapshotJson(row.klines_json, {})
  const marketSnapshot = clean(parseSnapshotJson(row.market_snapshot_json, {}))
  const frames = marketSnapshot?.strategy_context?.timeframes || {}
  for (const value of Object.values(frames)) {
    if (value && typeof value === 'object') delete value.klines
  }
  return {
    id: Number(row.id),
    strategy_id: row.strategy_id == null ? null : Number(row.strategy_id),
    standard_symbol: row.standard_symbol || null,
    market_source: row.market_source || null,
    evidence_status: row.evidence_status || 'incomplete',
    strategy_runtime:parseSnapshotJson(row.strategy_runtime_json, null),
    strategy_runtime_mode:parseSnapshotJson(row.strategy_runtime_json, null)?.mode || 'legacy_implicit',
    omitted_fields: parseSnapshotJson(row.omitted_fields_json, []),
    klines,
    market_snapshot: marketSnapshot,
    created_at: row.created_at || null,
  }
}

/**
 * Build the small, render-safe part of a frozen inference snapshot.
 *
 * Keep this separate from inferenceVisualizationSnapshot(): model/review
 * tooling still needs the legacy full object, while browser signal_detail
 * must never serialize all four K-line arrays.
 */
export function inferenceSnapshotSummary(row) {
  if (!row) return null
  const klines = normalizeSnapshotKlines(parseSnapshotJson(row.klines_json, {}))
  const marketSnapshot = stripEmbeddedKlines(clean(parseSnapshotJson(row.market_snapshot_json, {})))
  const frames = marketSnapshot?.strategy_context?.timeframes || {}
  for (const value of Object.values(frames)) {
    if (value && typeof value === 'object') delete value.klines
  }
  const availableTimeframes = []
  const timeframeCounts = {}
  for (const [rawTimeframe, rows] of Object.entries(klines || {})) {
    const timeframe = String(rawTimeframe || '').trim().toUpperCase()
    if (!INFERENCE_EVIDENCE_TIMEFRAME_SET.has(timeframe)) continue
    const count = Array.isArray(rows) ? rows.length : 0
    if (count <= 0) continue
    availableTimeframes.push(timeframe)
    timeframeCounts[timeframe] = count
  }
  availableTimeframes.sort((left, right) => INFERENCE_EVIDENCE_TIMEFRAMES.indexOf(left)
    - INFERENCE_EVIDENCE_TIMEFRAMES.indexOf(right))
  const strategyRuntime = parseSnapshotJson(row.strategy_runtime_json, null)
  return {
    id: Number(row.id),
    snapshot_id: Number(row.id),
    revision: row.content_hash || row.created_at || String(row.id),
    signal_id: row.signal_id == null ? null : Number(row.signal_id),
    strategy_id: row.strategy_id == null ? null : Number(row.strategy_id),
    standard_symbol: row.standard_symbol || null,
    market_source: row.market_source || null,
    evidence_status: row.evidence_status || 'incomplete',
    strategy_runtime: strategyRuntime,
    strategy_runtime_mode: strategyRuntime?.mode || 'legacy_implicit',
    omitted_fields: parseSnapshotJson(row.omitted_fields_json, []),
    available_timeframes: availableTimeframes,
    timeframe_counts: timeframeCounts,
    market_snapshot: marketSnapshot,
    content_hash: row.content_hash || null,
    byte_size: row.byte_size == null ? null : Number(row.byte_size),
    created_at: row.created_at || null,
  }
}

export function inferenceSnapshotEvidence(row, timeframe) {
  if (!row) return null
  const normalizedTimeframe = normalizeInferenceEvidenceTimeframe(timeframe)
  const klines = normalizeSnapshotKlines(parseSnapshotJson(row.klines_json, {}))
  const rows = Array.isArray(klines?.[normalizedTimeframe]) ? klines[normalizedTimeframe] : []
  const marketSnapshot = clean(parseSnapshotJson(row.market_snapshot_json, {}))
  const frame = marketSnapshot?.strategy_context?.timeframes?.[normalizedTimeframe]
  const summary = frame && typeof frame === 'object' ? stripEmbeddedKlines(frame) : null
  return {
    id: Number(row.id),
    snapshot_id: Number(row.id),
    signal_id: row.signal_id == null ? null : Number(row.signal_id),
    standard_symbol: row.standard_symbol || null,
    market_source: row.market_source || null,
    evidence_status: row.evidence_status || 'incomplete',
    timeframe: normalizedTimeframe,
    total_count: rows.length,
    count: Math.min(rows.length, MAX_INFERENCE_EVIDENCE_BARS),
    klines: rows.slice(-MAX_INFERENCE_EVIDENCE_BARS),
    timeframe_summary: summary,
    created_at: row.created_at || null,
  }
}

export async function getInferenceVisualizationSnapshot(signalId) {
  const id = Number(signalId)
  if (!id) return null
  const row = await queryOne(`SELECT id, signal_id, strategy_id, standard_symbol, market_source, evidence_status,
    omitted_fields_json, klines_json, market_snapshot_json, strategy_runtime_json, content_hash, byte_size, created_at
    FROM inference_snapshots WHERE signal_id = ? ORDER BY id DESC LIMIT 1`, [id])
  return inferenceSnapshotSummary(row)
}

export async function getInferenceSnapshotEvidence(signalId, timeframe) {
  const id = Number(signalId)
  if (!id) return null
  const normalizedTimeframe = normalizeInferenceEvidenceTimeframe(timeframe)
  const row = await queryOne(`SELECT id, signal_id, standard_symbol, market_source, evidence_status,
    klines_json, market_snapshot_json, created_at
    FROM inference_snapshots WHERE signal_id = ? ORDER BY id DESC LIMIT 1`, [id])
  return inferenceSnapshotEvidence(row, normalizedTimeframe)
}
